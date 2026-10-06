import {subscribeCoreClient} from '../core/client.mjs';
import {createArcaneEventSource} from '../event-manager.mjs';
import {encodeTensorMap, decodeTensorMap, encodeTensorFetches} from './onnx-tensors.mjs';

function unavailable(message) {
    const error = new Error(message);
    error.code = 'ARCANE_ONNX_CORE_UNAVAILABLE';
    return error;
}

/** Optional system ONNX access. Construction neither connects nor installs. */
export function createCoreONNXRuntime({client: suppliedClient} = {}) {
    const owner = {};
    const events = createArcaneEventSource(owner, {source: 'core-onnx', eventTypes: ['onnx.state']});
    const lifetime = new AbortController();
    const pending = new Set();
    let client = null;
    let connection = null;
    let stopInstallation;
    let state = {id: 'onnx', installed: false, available: false, state: 'unknown', models: []};
    let revision = 0;
    let closed = false;

    function current() {
        const busy = [...pending].some(
            function currentRequest(request) {
                return request.connection === connection && !request.signal.aborted;
            }
        );
        return {...state, busy, closed};
    }
    function publish() { events.dispatch('onnx.state', current()); }
    function accept(value) {
        state = value ?? {id: 'onnx', installed: false, available: false, state: 'unavailable', models: []};
        revision += 1;
        publish();
    }

    function bindClient({client: nextClient, error = null}) {
        if (closed || (connection && nextClient === client)) return;
        const previous = connection;
        client = nextClient;
        const currentConnection = {client, controller: new AbortController(), unsubscribe: null};
        connection = currentConnection;
        revision += 1;
        state = {id: 'onnx', installed: false, available: false, state: client ? 'unknown' : 'unavailable', models: [], error};
        previous?.unsubscribe?.();
        previous?.controller.abort();
        if (client) {
            currentConnection.unsubscribe = client.events.on(
                'localai.state',
                function localStateChanged(snapshot) {
                    if (!closed && connection === currentConnection) {
                        accept(snapshot?.runtimes?.find(function onnxRuntime(runtime) { return runtime.id === 'onnx'; }));
                    }
                }
            );
        }
        publish();
        if (!closed && connection === currentConnection && client && suppliedClient === undefined) {
            inspect().catch(
                function initialONNXStateUnavailable(error) {
                    if (!closed && connection === currentConnection && !currentConnection.controller.signal.aborted) {
                        globalThis.console?.error('Core ONNX initial state unavailable.', error);
                    }
                }
            );
        }
    }

    async function invoke(method, parameters, {signal, timeoutMs = 0} = {}) {
        if (closed) throw unavailable('The Core ONNX accessor is closed.');
        if (!client) throw unavailable('Local ONNX requires an available Core connection.');
        const currentConnection = connection;
        const operationSignal = AbortSignal.any(
            [lifetime.signal, currentConnection.controller.signal, ...(signal ? [signal] : [])]
        );
        const request = {connection: currentConnection, signal: operationSignal};
        operationSignal.throwIfAborted();
        pending.add(request);
        publish();
        try {
            operationSignal.throwIfAborted();
            const result = await currentConnection.client.invoke(method, parameters, {signal: operationSignal, timeoutMs});
            operationSignal.throwIfAborted();
            return result;
        } finally {
            pending.delete(request);
            if (!closed && connection === currentConnection) publish();
        }
    }

    async function inspect(options) {
        const before = revision;
        const currentConnection = connection;
        try {
            const result = await invoke('onnx.status', {}, options);
            currentConnection.controller.signal.throwIfAborted();
            if (!closed && revision === before) accept(result);
            return current();
        } catch (error) {
            if (!closed && !options?.signal?.aborted && revision === before) {
                accept({...state, available: false, state: 'unavailable', error});
            }
            throw error;
        }
    }

    async function load({id, model, sessionOptions, executionPreference, executionTarget, signal, timeoutMs} = {}) {
        const currentConnection = connection;
        const result = await invoke(
            'onnx.load',
            {id, model, sessionOptions, executionPreference, executionTarget},
            {signal, timeoutMs}
        );
        currentConnection.controller.signal.throwIfAborted();
        return result;
    }

    async function run({id, feeds, fetches, runOptions, signal, timeoutMs} = {}) {
        const currentConnection = connection;
        const result = await invoke('onnx.run', {
            id, feeds: encodeTensorMap(feeds),
            fetches: encodeTensorFetches(fetches), runOptions
        }, {signal, timeoutMs});
        currentConnection.controller.signal.throwIfAborted();
        return decodeTensorMap(result);
    }

    function unload({id, signal, timeoutMs} = {}) {
        return invoke('onnx.unload', {id}, {signal, timeoutMs});
    }

    function subscribe(listener) {
        const stop = events.on('onnx.state', function changed(event) { listener(event.detail); });
        try { listener(current()); } catch (error) { stop(); throw error; }
        return stop;
    }

    function close() {
        if (closed) return;
        closed = true;
        lifetime.abort();
        stopInstallation?.();
        connection?.unsubscribe?.();
        connection?.controller.abort();
        state = {...state, available: false, state: 'closed'};
        publish();
        events.dispose();
    }

    if (suppliedClient === undefined) {
        stopInstallation = subscribeCoreClient(bindClient, {signal: lifetime.signal});
    } else {
        bindClient({client: suppliedClient});
    }

    return {load, run, unload, inspect, current, subscribe, close};
}
