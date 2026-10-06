import Is from 'strong-type';
import {createArcaneEventSource} from '../event-manager.mjs';
import {CORE_PROTOCOL, CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';

const is = new Is(false);
const STATE_EVENT = 'core.runtime.state';
const FRAME_EVENT = 'core.runtime.frame';

function failure(code, message) {
    return new CoreError({code, message});
}

function requireFunction(value, name) {
    if (!is.function(value)) throw new TypeError(`${name} must be a function.`);
}

function aborted(controller) {
    if (controller.signal.aborted) throw controller.signal.reason;
}

/** App-neutral dispatch. Hosts own services, privileges and process lifetime. */
class CoreRuntime {
    #application;
    #version;
    #events;
    #state = 'created';
    #services = new Map();
    #methods = new Map();
    #requests = new Map();
    #responses = new Set();
    #publications = [];
    #publishing = false;
    #closing = null;

    constructor({application, version, services = []} = {}) {
        this.#application = application;
        this.#version = version;
        this.#events = createArcaneEventSource(
            this,
            {source: 'core-runtime', eventTypes: [STATE_EVENT, FRAME_EVENT]}
        );
        for (const service of services) this.registerService(service);
    }

    current() {
        return {
            state: this.#state,
            application: this.#application,
            version: this.#version,
            services: [...this.#services.values()].map(
                function serviceState(service) {
                    return {name: service.name, state: service.state, error: service.error};
                }
            ),
            activeRequests: [...this.#requests.values()].map(
                function requestState(request) {
                    return {id: request.id, method: request.method, lifetime: request.lifetime};
                }
            )
        };
    }

    subscribe(listener, {emitCurrent = true, signal} = {}) {
        requireFunction(listener, 'listener');
        function deliverState(occurrence) {
            listener(occurrence.detail);
        }
        const unsubscribe = this.#events.on(STATE_EVENT, deliverState, {signal});
        try {
            if (emitCurrent && !signal?.aborted) listener(this.current());
        } catch (error) {
            unsubscribe();
            throw error;
        }
        return unsubscribe;
    }

    onFrame(listener, {signal} = {}) {
        requireFunction(listener, 'listener');
        function deliverFrame(occurrence) {
            listener(occurrence.detail);
        }
        return this.#events.on(FRAME_EVENT, deliverFrame, {signal});
    }

    #publish(replay = false) {
        this.#publications.push({state: this.current(), replay});
        if (this.#publishing) return;
        this.#publishing = true;
        try {
            // A synchronous subscriber can change the lifecycle. Finish each
            // state publication before delivering its reentrant successor.
            while (this.#publications.length) {
                const {state, replay: replaying} = this.#publications.shift();
                // Finish one replay snapshot before publishing lifecycle changes
                // triggered reentrantly by its listeners.
                if (replaying && state.state === 'ready') {
                    this.emit('core.ready', {version: state.version, app: state.application});
                }
                this.#events.dispatch(STATE_EVENT, state);
                this.emit('core.state', state);
                if (replaying) {
                    for (const service of state.services) this.emit('core.service.state', service);
                }
            }
        } finally {
            this.#publishing = false;
        }
    }

    emit(event, data) {
        const frame = {protocol: CORE_PROTOCOL, type: 'event', event, data, time: new Date().toISOString()};
        this.#events.dispatch(FRAME_EVENT, frame);
        return frame;
    }

    registerService(definition) {
        if (this.#closing) throw failure('CORE_CLOSING', 'Core is closing.');
        const {name, methods = {}, start, drain, dispose} = definition;
        if (!is.string(name) || !name) throw new TypeError('Service name must be a nonempty string.');
        if (this.#services.has(name)) throw failure('CORE_SERVICE_EXISTS', `Service ${name} is already registered.`);
        for (const [hook, value] of Object.entries({start, drain, dispose})) {
            if (value !== undefined) requireFunction(value, `Service ${hook}`);
        }
        const registrations = [];
        for (const [method, value] of Object.entries(methods)) {
            if (this.#methods.has(method) || ['system.ping', 'app.current', 'version.current'].includes(method)) {
                throw failure('CORE_METHOD_EXISTS', `Method ${method} is already registered.`);
            }
            const handle = is.function(value) ? value : value.handle;
            const lifetime = is.function(value) ? 'request' : value.lifetime ?? 'request';
            requireFunction(handle, `Method ${method}`);
            if (lifetime !== 'request' && lifetime !== 'service') {
                throw new TypeError('Method lifetime must be request or service.');
            }
            registrations.push({method, handle, lifetime});
        }
        const service = {name, definition, state: 'registered', error: null, task: null};
        this.#services.set(name, service);
        for (const registration of registrations) this.#methods.set(registration.method, {...registration, service});
        if (this.#state === 'ready') this.#startService(service);
        const runtime = this;
        return {
            get ready() {
                return runtime.#startService(service);
            },
            current() {
                return {name: service.name, state: service.state, error: service.error};
            }
        };
    }

    async getService(name) {
        if (this.#closing) throw failure('CORE_CLOSING', 'Core is closing.');
        const service = this.#services.get(name);
        if (!service) throw failure('CORE_SERVICE_UNAVAILABLE', `Core service ${String(name)} is not registered.`);
        await this.#startService(service);
        return service.definition;
    }

    #serviceContext(service) {
        const runtime = this;
        return {
            application: this.#application,
            service: service.name,
            getService(name) {
                return runtime.getService(name);
            },
            emit(event, data) {
                return runtime.emit(event, data);
            }
        };
    }

    #serviceState(service, state, error) {
        service.state = state;
        service.error = state === 'failed' || (error !== undefined && error !== null)
            ? serializeCoreError(error)
            : null;
        this.emit('core.service.state', {name: service.name, state, error: service.error});
        this.#publish();
    }

    #startService(service) {
        if (service.task) return service.task;
        if (this.#closing) return Promise.reject(failure('CORE_CLOSING', 'Core is closing.'));
        const runtime = this;
        // Publish after task assignment so a synchronous state subscriber cannot
        // start the same service twice.
        service.task = Promise.resolve().then(
            async function initializeService() {
                runtime.#serviceState(service, 'starting');
                try {
                    await service.definition.start?.(runtime.#serviceContext(service));
                    runtime.#serviceState(service, 'ready');
                } catch (error) {
                    runtime.#serviceState(service, 'failed', error);
                    throw error;
                }
            }
        );
        service.task.catch(function observeServiceStartupFailure() {});
        return service.task;
    }

    start() {
        if (this.#closing) throw failure('CORE_CLOSING', 'Core is closing.');
        if (this.#state === 'ready') return this.current();
        this.#state = 'ready';
        for (const service of this.#services.values()) this.#startService(service);
        this.emit('core.ready', {version: this.#version, app: this.#application});
        this.#publish();
        return this.current();
    }

    async handle(frame) {
        if (frame?.protocol !== CORE_PROTOCOL) throw failure('INVALID_RPC_REQUEST', 'Unknown Core protocol.');
        if (frame.type === 'control') {
            if (frame.control === 'runtime.replay') {
                this.#publish(true);
                return;
            }
            if (frame.control === 'request.cancel') return this.#cancel(frame.requestId);
            if (frame.control === 'requests.cancelAll') {
                for (const request of this.#requests.values()) this.#cancel(request.id);
                return;
            }
            throw failure('INVALID_RPC_CONTROL', 'Unknown Core control.');
        }
        if (frame.type !== 'request' || !is.string(frame.id) || !frame.id || !is.string(frame.method)) {
            throw failure('INVALID_RPC_REQUEST', 'A Core request requires an id and method.');
        }
        const task = this.#answer(frame);
        this.#responses.add(task);
        try {
            return await task;
        } finally {
            this.#responses.delete(task);
        }
    }

    async #answer(frame) {
        let result;
        let error;
        let ok = true;
        try {
            if (this.#state !== 'ready') throw failure('CORE_NOT_READY', 'Core is not accepting requests.');
            if (this.#requests.has(frame.id)) throw failure('RPC_REQUEST_ID_ACTIVE', 'The request id is already active.');
            if (frame.method === 'system.ping') result = {ok: true};
            else if (frame.method === 'version.current') result = this.#version;
            else if (frame.method === 'app.current') result = this.#application;
            else result = await this.#request(frame);
        } catch (caught) {
            ok = false;
            error = caught;
        }
        const response = {
            protocol: CORE_PROTOCOL,
            type: 'response',
            id: frame.id,
            ...(ok ? {ok: true, result} : {ok: false, error: serializeCoreError(error)}),
            time: new Date().toISOString()
        };
        this.#events.dispatch(FRAME_EVENT, response);
        return response;
    }

    #request(frame) {
        const registration = this.#methods.get(frame.method);
        if (!registration) {
            const namespace = frame.method.split('.')[0];
            const prefix = `${namespace}.`;
            const namespacePresent = this.#services.has(namespace)
                || [...this.#methods.keys(), 'system.ping', 'app.current', 'version.current'].some(
                    function inNamespace(method) { return method.startsWith(prefix); }
                );
            throw new CoreError({
                code: 'METHOD_NOT_ALLOWED',
                message: `Core does not expose ${frame.method}.`,
                reason: namespacePresent ? 'core-method-unavailable' : 'core-namespace-unavailable',
                namespace,
                method: frame.method
            });
        }
        const {service, handle, lifetime} = registration;
        const controller = new AbortController();
        const request = {id: frame.id, method: frame.method, lifetime, controller, task: null};
        const runtime = this;
        this.#requests.set(frame.id, request);
        request.task = Promise.resolve().then(
            async function executeCoreRequest() {
                try {
                    await runtime.#startService(service);
                    aborted(controller);
                    const result = await handle.call(
                        service.definition,
                        frame.parameters,
                        {...runtime.#serviceContext(service), requestId: frame.id, signal: controller.signal}
                    );
                    aborted(controller);
                    return result;
                } finally {
                    if (runtime.#requests.get(frame.id) === request) runtime.#requests.delete(frame.id);
                    runtime.#publish();
                }
            }
        );
        this.#publish();
        return request.task;
    }

    #cancel(id) {
        const request = this.#requests.get(id);
        if (!request || request.lifetime === 'service' || request.controller.signal.aborted) return false;
        const error = failure('REQUEST_ABORTED', 'The Core request was cancelled.');
        error.name = 'AbortError';
        request.controller.abort(error);
        return true;
    }

    close() {
        if (this.#closing) return this.#closing;
        this.#state = 'draining';
        const runtime = this;
        // A synchronous state listener may call close again. Retain the owner
        // before announcing draining, and never let a renderer cancel saves.
        this.#closing = Promise.resolve().then(
            async function drainCoreRuntime() {
                const failures = [];
                for (const request of runtime.#requests.values()) runtime.#cancel(request.id);
                await Promise.allSettled([...runtime.#responses]);
                await Promise.all(
                    [...runtime.#services.values()].map(
                        async function closeCoreService(service) {
                            const serviceFailures = [];
                            if (service.task) {
                                try { await service.task; } catch (error) { serviceFailures.push(error); }
                            }
                            runtime.#serviceState(service, 'draining');
                            for (const hook of ['drain', 'dispose']) {
                                try {
                                    await service.definition[hook]?.(runtime.#serviceContext(service));
                                } catch (error) {
                                    serviceFailures.push(error);
                                    runtime.emit('core.error', serializeCoreError(error));
                                }
                            }
                            const error = serviceFailures.length
                                ? new AggregateError(serviceFailures, `Service ${service.name} shutdown failed.`)
                                : null;
                            failures.push(...serviceFailures);
                            runtime.#serviceState(service, 'closed', error);
                        }
                    )
                );
                runtime.#state = 'closed';
                runtime.#publish();
                runtime.#events.dispose();
                if (failures.length) throw new AggregateError(failures, 'Core service shutdown failed.');
                return runtime.current();
            }
        );
        this.#publish();
        return this.#closing;
    }
}

export function createCoreRuntime(options) {
    return new CoreRuntime(options);
}
