import path from 'node:path';
import {createNativeDecisionModel} from '../../local-ai/decisions.mjs';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {CoreError} from '../../../browser-runtime/core/contracts.mjs';
import {encodeTensorMap} from '../../../browser-runtime/ai/onnx-tensors.mjs';

/** App-owned selection; shared typed-decision execution, without a renderer. */
export function createNativeDecisionService(configuration = {}, {appRoot = process.cwd()} = {}) {
    const events = createArcaneEventSource({}, {source: 'core-decisions', eventTypes: ['decisions.state']});
    const lifetime = new AbortController();
    let context;
    let model;
    let loading;
    let loadController;
    let releasing;
    let closing;
    let unsubscribe;

    function current() {
        return model?.current() ?? {
            family: 'laya', model: configuration.model ?? 'onnx-community/laya-typed-decisions-ONNX',
            revision: configuration.revision ?? 'main', dtype: configuration.dtype ?? 'fp32',
            state: closing ? 'disposed' : 'unloaded', loaded: false, busy: Boolean(loading),
            activeRequests: 0, progress: null, error: null, execution: null
        };
    }

    function publish(value = current()) {
        events.dispatch('decisions.state', value);
        context?.emit('decisions.state', value);
    }

    function subscribe(listener, {emitCurrent = true, signal} = {}) {
        const stop = events.on('decisions.state', function changed(event) { listener(event.detail); }, {signal});
        try { if (emitCurrent && !signal?.aborted) listener(current()); }
        catch (error) { stop(); throw error; }
        return stop;
    }

    function operationSignal(signal) { return signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal; }

    function load({signal} = {}) {
        operationSignal(signal).throwIfAborted();
        if (!context) throw new CoreError({code: 'CORE_NOT_READY', message: 'Register and start the decision service with Core before loading.'});
        if (loading) return observeLoad(loading, loadController, signal);
        if (model?.current().loaded) return Promise.resolve(model.current());
        loadController = new AbortController();
        const controller = loadController;
        const selectedSignal = AbortSignal.any([lifetime.signal, controller.signal]);
        const precedingRelease = releasing;
        loading = Promise.resolve().then(async function loadSelectedModel() {
            selectedSignal.throwIfAborted();
            if (precedingRelease) await precedingRelease;
            selectedSignal.throwIfAborted();
            if (model) await model.dispose();
            unsubscribe?.();
            // Only the explicit load waits for its native dependencies. Merely
            // registering this service does not download a model or delay UI.
            const [localAI, modelAssets] = await Promise.all([
                context.getService('local-ai'),
                configuration.paths ? undefined : context.getService('model-assets')
            ]);
            selectedSignal.throwIfAborted();
            const paths = configuration.paths && Object.fromEntries(
                Object.entries(configuration.paths).map(function nativePath([name, value]) { return [name, path.resolve(appRoot, value)]; })
            );
            model = createNativeDecisionModel({
                ...configuration, paths, onnx: localAI.getONNXRuntime(), modelAssets,
                signal: lifetime.signal
            });
            unsubscribe = model.subscribe(publish);
            return model.load({signal: selectedSignal});
        });
        function settled() { loading = undefined; loadController = undefined; publish(); }
        loading.then(settled, settled);
        publish();
        return observeLoad(loading, controller, signal);
    }

    function observeLoad(task, controller, signal) {
        function abort() { controller.abort(signal.reason); }
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
        return task.finally(function detachLoadCaller() { signal?.removeEventListener('abort', abort); });
    }

    async function evaluate(rows, {signal, runOptions} = {}) {
        const selectedSignal = operationSignal(signal);
        selectedSignal.throwIfAborted();
        if (!model) throw new CoreError({code: 'ARCANE_DECISION_NOT_LOADED', message: 'Load the selected native decision model before evaluating.'});
        return model.evaluate(rows, {signal: selectedSignal, runOptions});
    }

    function unload() {
        if (releasing) return releasing;
        // An unload during model preparation must cancel that accepted load,
        // rather than wait for it to download and activate first.
        loadController?.abort(new CoreError({name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message: 'The native decision load was cancelled.'}));
        const task = model?.unload() ?? Promise.resolve();
        const acceptedLoad = loading;
        releasing = Promise.resolve().then(async function releaseSelectedModel() {
            const results = await Promise.allSettled([task, acceptedLoad]);
            if (results[0].status === 'rejected') throw results[0].reason;
            return current();
        });
        function released() { releasing = undefined; }
        releasing.then(released, released);
        return releasing;
    }

    function dispose() {
        if (closing) return closing;
        const reason = new CoreError({name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message: 'The native decision service is closing.'});
        closing = Promise.resolve().then(async function closeDecisionService() {
            const failures = [];
            try { await loading; } catch (error) { if (!lifetime.signal.aborted) failures.push(error); }
            try { await model?.dispose(); } catch (error) { failures.push(error); }
            unsubscribe?.();
            publish();
            events.dispose();
            if (failures.length) throw new AggregateError(failures, 'Closing the decision service failed.');
        });
        lifetime.abort(reason);
        return closing;
    }

    return {
        name: configuration.name ?? 'decisions', current, subscribe, load, evaluate, classify: evaluate, unload, dispose,
        start(serviceContext) { context = serviceContext; },
        methods: {
            'decisions.status': current,
            'decisions.load': function loadRequest(parameters, request) { return load({signal: request.signal}); },
            'decisions.evaluate': async function evaluateRequest({rows, runOptions}, request) {
                const result = await evaluate(rows, {runOptions, signal: request.signal});
                // Typed arrays retain their complete values through Core's
                // existing JSON tensor encoding, only at this transport edge.
                return {...result, outputs: encodeTensorMap(result.outputs)};
            },
            'decisions.unload': {lifetime: 'service', handle: unload}
        }
    };
}

export default createNativeDecisionService;
