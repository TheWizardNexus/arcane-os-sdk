import {getInstalledCoreClient} from '../core/client.mjs';
import {createArcaneEventSource} from '../event-manager.mjs';
import {encodeTensorMap, decodeTensorMap, encodeTensorFetches} from './onnx-tensors.mjs';

function unavailable(message) {
    const error = new Error(message);
    error.code = 'ARCANE_ONNX_CORE_UNAVAILABLE';
    return error;
}

/** Optional system ONNX access. Construction neither connects nor installs. */
export function createCoreONNXRuntime({client = getInstalledCoreClient()} = {}) {
    const owner = {};
    const events = createArcaneEventSource(owner, {source: 'core-onnx', eventTypes: ['onnx.state']});
    const lifetime = new AbortController();
    const pending = new Set();
    let state = {id: 'onnx', installed: false, available: false, state: 'unknown', models: []};
    let revision = 0;
    let closed = false;

    function current() { return {...state, busy: pending.size > 0, closed}; }
    function publish() { events.dispatch('onnx.state', current()); }
    function accept(value) {
        state = value ?? {id: 'onnx', installed: false, available: false, state: 'unavailable', models: []};
        revision += 1;
        publish();
    }

    const unsubscribe = client?.events.on('localai.state', function localStateChanged(snapshot) {
        if (!closed) accept(snapshot?.runtimes?.find(function onnxRuntime(runtime) { return runtime.id === 'onnx'; }));
    }) ?? function noCoreSubscription() {};

    async function invoke(method, parameters, {signal, timeoutMs = 0} = {}) {
        if (closed) throw unavailable('The Core ONNX accessor is closed.');
        if (!client) throw unavailable('Local ONNX requires an available Core connection.');
        const request = {};
        const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
        operationSignal.throwIfAborted();
        pending.add(request);
        publish();
        try {
            return await client.invoke(method, parameters, {signal: operationSignal, timeoutMs});
        } finally {
            pending.delete(request);
            if (!closed) publish();
        }
    }

    async function inspect(options) {
        const before = revision;
        try {
            const result = await invoke('onnx.status', {}, options);
            if (!closed && revision === before) accept(result);
            return current();
        } catch (error) {
            if (!closed && !options?.signal?.aborted && revision === before) {
                accept({...state, available: false, state: 'unavailable', error});
            }
            throw error;
        }
    }

    async function load({id, model, sessionOptions, signal, timeoutMs} = {}) {
        return invoke('onnx.load', {id, model, sessionOptions}, {signal, timeoutMs});
    }

    async function run({id, feeds, fetches, runOptions, signal, timeoutMs} = {}) {
        const result = await invoke('onnx.run', {
            id, feeds: encodeTensorMap(feeds),
            fetches: encodeTensorFetches(fetches), runOptions
        }, {signal, timeoutMs});
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
        unsubscribe();
        state = {...state, available: false, state: 'closed'};
        publish();
        events.dispose();
    }

    return {load, run, unload, inspect, current, subscribe, close};
}
