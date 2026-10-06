import Is from '../dependencies/strong-type/index.js';
import {createArcaneEventSource} from '../event-manager.mjs';
import {createModelResourceHost} from './model-resource-bridge.mjs';

const is = new Is(false);
const STATE_EVENT = 'ai.decisions.state';
// The CDN bundle includes ONNX Runtime; the .web build leaves bare imports for bundlers.
const DEFAULT_RUNTIME_MODULE = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js';

function requiredText(value, name) {
    if (!is.string(value) || value.length === 0) {
        throw new TypeError(`${name} must be a nonempty string.`);
    }
    return value;
}

function cancellationReason(signal, message) {
    if (signal?.reason !== undefined) return signal.reason;
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = 'ARCANE_AI_REQUEST_ABORTED';
    return error;
}

function reviveWorkerError(value, seen = new Map()) {
    if (is.error(value) || value === null || !is.object(value)) return value;
    if (!is.string(value.name) || !is.string(value.message)) return value;
    if (seen.has(value)) return seen.get(value);
    const error = new Error(value.message);
    seen.set(value, error);
    for (const key of Object.keys(value)) {
        let item = value[key];
        if (key === 'cause') item = reviveWorkerError(item, seen);
        if (key === 'errors' && is.array(item)) {
            item = item.map(
                function reviveNestedError(nested) {
                    return reviveWorkerError(nested, seen);
                }
            );
        }
        Object.defineProperty(
            error,
            key,
            {value: item, enumerable: true, configurable: true, writable: true}
        );
    }
    return error;
}

function createDecisionOperation(op) {
    const operation = {op};
    operation.promise = new Promise(
        function createDecisionOperationPromise(resolve, reject) {
            operation.resolve = resolve;
            operation.reject = reject;
        }
    );
    return operation;
}

/**
 * One lazily activated model Worker. Cancelling any active operation terminates
 * that Worker and rejects all of its operations with the same cancellation
 * reason. A later load/evaluate may activate a fresh Worker after cancellation,
 * unloading, or failure; disposal is terminal.
 */
class BrowserDecisionModel {
    #configuration;
    #store;
    #events;
    #activation = null;
    #generation = 0;
    #nextId = 1;
    #state = 'unloaded';
    #progress = null;
    #error = null;
    #disposed = false;

    constructor({family, model, revision = 'main', device = 'webgpu',
        dtype = family === 'laya' ? 'fp16' : 'fp32', runtime = {}, store = null} = {}) {
        if (family !== 'laya' && family !== 'julia') {
            throw new TypeError('family must be "laya" or "julia".');
        }
        if (runtime === null || !is.object(runtime)) {
            throw new TypeError('runtime must be an object.');
        }
        if (store !== null && !is.function(store?.fetchResource)) {
            throw new TypeError('store must expose fetchResource().');
        }
        this.#store = store;
        const moduleUrl = runtime.moduleUrl === undefined
            ? DEFAULT_RUNTIME_MODULE
            : runtime.moduleUrl;
        this.#configuration = {
            family,
            model: requiredText(model, 'model'),
            revision: requiredText(revision, 'revision'),
            device: requiredText(device, 'device'),
            dtype: requiredText(dtype, 'dtype'),
            runtime: {...runtime, moduleUrl: requiredText(moduleUrl, 'runtime.moduleUrl')}
        };
        this.#events = createArcaneEventSource(
            this,
            {source: 'ai-browser-decisions', eventTypes: [STATE_EVENT]}
        );
    }

    status() {
        const {family, model, revision, device, dtype} = this.#configuration;
        const activeRequests = this.#activation?.evaluations.size ?? 0;
        return {
            family,
            model,
            revision,
            device,
            dtype,
            state: this.#state,
            loaded: this.#state === 'ready',
            busy: this.#state === 'loading' || activeRequests > 0,
            activeRequests,
            progress: this.#progress === null ? null : {...this.#progress},
            error: this.#error
        };
    }

    subscribe(listener, {emitCurrent = true, signal} = {}) {
        if (!is.function(listener)) throw new TypeError('listener must be a function.');
        if (!is.boolean(emitCurrent)) throw new TypeError('emitCurrent must be a boolean.');
        function forwardDecisionState(event) {
            listener(event.detail);
        }
        const unsubscribe = this.#events.on(
            STATE_EVENT,
            forwardDecisionState,
            {signal}
        );
        try {
            if (emitCurrent && !signal?.aborted) {
                const current = this.status();
                listener(current);
            }
        } catch (error) {
            unsubscribe();
            throw error;
        }
        return unsubscribe;
    }

    #publish() {
        const current = this.status();
        this.#events.dispatch(STATE_EVENT, current);
    }

    #assertOperational(signal) {
        if (this.#disposed) {
            const error = new Error('The browser decision model is disposed.');
            error.code = 'ARCANE_AI_DISPOSED';
            throw error;
        }
        if (signal !== undefined && signal !== null
            && (!is.boolean(signal.aborted)
                || !is.function(signal.addEventListener)
                || !is.function(signal.removeEventListener))) {
            throw new TypeError('signal must be an AbortSignal.');
        }
        if (signal?.aborted) {
            throw cancellationReason(signal, 'The browser decision operation was cancelled.');
        }
    }

    #isCurrent(activation) {
        return this.#activation === activation && this.#generation === activation.generation;
    }

    #observeSignal(activation, signal) {
        const model = this;
        function cancelDecisionActivation() {
            model.#stop(
                activation,
                cancellationReason(signal, 'The browser decision operation was cancelled.'),
                'unloaded'
            );
        }
        if (signal) {
            signal.addEventListener(
                'abort',
                cancelDecisionActivation,
                {once: true}
            );
            if (signal.aborted) cancelDecisionActivation();
        }
        function stopObservingDecisionSignal() {
            signal?.removeEventListener('abort', cancelDecisionActivation);
        }
        return stopObservingDecisionSignal;
    }

    #activate() {
        const activation = {
            generation: ++this.#generation,
            worker: null,
            listeners: null,
            load: createDecisionOperation('load'),
            pending: new Map(),
            evaluations: new Set(),
            resources: null,
            cleanup: null,
            reason: undefined
        };
        this.#activation = activation;
        this.#state = 'loading';
        this.#progress = {phase: 'loading-runtime'};
        this.#error = null;
        this.#publish();
        if (!this.#isCurrent(activation)) return activation;
        const model = this;
        try {
            const worker = new globalThis.Worker(
                new URL('./decision-worker.mjs', import.meta.url),
                {type: 'module', name: 'arcane-decisions'}
            );
            activation.worker = worker;
            if (this.#store) {
                const store = this.#store;
                activation.resources = createModelResourceHost(
                    {
                        fetchResource: function fetchDecisionResource(input, options) {
                            return store.fetchResource(input, options);
                        },
                        send: function sendDecisionResource(message) {
                            worker.postMessage(message);
                        },
                        onError: function stopFailedDecisionResource(error) {
                            model.#stop(activation, error, 'error');
                        }
                    }
                );
            }
            function handleDecisionWorkerMessage(event) {
                model.#receive(activation, event.data);
            }
            function handleDecisionWorkerError(event) {
                const error = event.error ?? new Error(
                    event.message,
                    {cause: event}
                );
                model.#stop(activation, error, 'error');
            }
            function handleDecisionWorkerMessageError(event) {
                const error = new Error(
                    'The browser could not deserialize the decision worker response.',
                    {cause: event}
                );
                model.#stop(activation, error, 'error');
            }
            activation.listeners = {
                message: handleDecisionWorkerMessage,
                error: handleDecisionWorkerError,
                messageerror: handleDecisionWorkerMessageError
            };
            for (const [type, listener] of Object.entries(activation.listeners)) {
                worker.addEventListener(type, listener);
            }
            const id = this.#nextId++;
            activation.pending.set(id, activation.load);
            worker.postMessage(
                {id, op: 'load', payload: this.#configuration, storedResources: this.#store !== null}
            );
        } catch (error) {
            this.#stop(activation, error, 'error');
        }
        return activation;
    }

    #receive(activation, message) {
        if (!this.#isCurrent(activation)) return;
        if (activation.resources?.receive(message)) return;
        const operation = message && activation.pending.get(message.id);
        if (!operation) {
            this.#stop(
                activation,
                new Error(
                    'The decision worker returned an unknown operation.',
                    {cause: message}
                ),
                'error'
            );
            return;
        }
        if (Object.hasOwn(message, 'progress')) {
            this.#progress = message.progress;
            this.#publish();
            return;
        }
        if (Object.hasOwn(message, 'error')) {
            const error = reviveWorkerError(message.error);
            // Transformers.js keeps a Worker-local inference promise chain.
            // A rejected run can poison that chain; a fresh Worker resets it.
            this.#stop(activation, error, 'error');
            return;
        }
        if (!Object.hasOwn(message, 'result')) {
            this.#stop(
                activation,
                new Error(
                    'The decision worker response has no result.',
                    {cause: message}
                ),
                'error'
            );
            return;
        }
        activation.pending.delete(message.id);
        if (operation.op === 'load') {
            this.#state = 'ready';
            this.#progress = {phase: 'ready'};
            this.#error = null;
            this.#publish();
            if (this.#isCurrent(activation)) {
                const current = this.status();
                operation.resolve(current);
            }
            return;
        }
        operation.resolve(message.result);
    }

    #stop(activation, reason, state) {
        if (!this.#isCurrent(activation)) return;
        activation.reason = reason;
        this.#activation = null;
        this.#generation += 1;
        this.#state = state;
        this.#progress = null;
        this.#error = reason;
        if (activation.resources) {
            const model = this;
            activation.cleanup = activation.resources.close(reason).catch(
                function preserveResourceCleanupFailure(error) {
                    activation.reason = new AggregateError([reason, error], 'Unable to settle decision model resources.');
                    throw activation.reason;
                }
            );
            activation.cleanup.catch(
                function reportResourceCleanupFailure(error) {
                    if (!model.#activation) {
                        model.#error = error;
                        if (!model.#disposed) model.#publish();
                    } else globalThis.console?.error('Decision model resource cleanup failed.', error);
                }
            );
        }
        if (activation.worker) {
            for (const [type, listener] of Object.entries(activation.listeners ?? {})) {
                activation.worker.removeEventListener(type, listener);
            }
            activation.worker.terminate();
        }
        activation.load.reject(reason);
        for (const operation of activation.pending.values()) operation.reject(reason);
        activation.pending.clear();
        this.#publish();
    }

    async load({signal} = {}) {
        this.#assertOperational(signal);
        const activation = this.#activation ?? this.#activate();
        const stopObserving = this.#observeSignal(activation, signal);
        try {
            await activation.load.promise;
            if (!this.#isCurrent(activation)) throw activation.reason;
            return this.status();
        } finally {
            stopObserving();
            if (activation.cleanup) await activation.cleanup;
        }
    }

    async evaluate(rows, {signal} = {}) {
        this.#assertOperational(signal);
        const activation = this.#activation ?? this.#activate();
        const evaluation = {};
        activation.evaluations.add(evaluation);
        const stopObserving = this.#observeSignal(activation, signal);
        if (this.#isCurrent(activation)) {
            this.#progress = {
                phase: this.#state === 'ready' ? 'evaluating' : 'waiting-for-model'
            };
            this.#error = null;
            this.#publish();
        }
        try {
            await activation.load.promise;
            if (!this.#isCurrent(activation)) throw activation.reason;
            const operation = createDecisionOperation('evaluate');
            const id = this.#nextId++;
            activation.pending.set(id, operation);
            try {
                activation.worker.postMessage(
                    {id, op: 'evaluate', payload: rows}
                );
            } catch (error) {
                activation.pending.delete(id);
                this.#error = error;
                operation.reject(error);
                this.#publish();
            }
            return await operation.promise;
        } finally {
            stopObserving();
            activation.evaluations.delete(evaluation);
            if (activation.cleanup) await activation.cleanup;
            if (this.#isCurrent(activation)) this.#publish();
        }
    }

    unload() {
        if (this.#disposed) return this.status();
        const reason = cancellationReason(undefined, 'The browser decision model was unloaded.');
        if (this.#activation) {
            this.#stop(this.#activation, reason, 'unloaded');
        } else {
            this.#state = 'unloaded';
            this.#progress = null;
            this.#error = null;
            this.#publish();
        }
        return this.status();
    }

    dispose() {
        if (this.#disposed) return this.status();
        this.#disposed = true;
        const reason = cancellationReason(undefined, 'The browser decision model was disposed.');
        if (this.#activation) {
            this.#stop(this.#activation, reason, 'disposed');
        } else {
            this.#state = 'disposed';
            this.#progress = null;
            this.#error = null;
            this.#publish();
        }
        this.#events.dispose();
        return this.status();
    }
}

/** Creates a client without starting a Worker, fetching a runtime, or loading a model. */
export function createBrowserDecisionModel(configuration) {
    return new BrowserDecisionModel(configuration);
}
