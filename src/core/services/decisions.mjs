import path from 'node:path';
import {createNativeDecisionModel} from '../../local-ai/decisions.mjs';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {CoreError} from '../../../browser-runtime/core/contracts.mjs';
import {encodeTensorMap} from '../../../browser-runtime/ai/onnx-tensors.mjs';

function sameExecutionTarget(left, right) {
    return left === right || (left != null && right != null && left.deviceId !== undefined && left.deviceId === right.deviceId);
}

function sameActivation(left, right) {
    if (!left || !right || !sameExecutionTarget(left.executionTarget, right.executionTarget) || left.assetProjectionId !== right.assetProjectionId) return false;
    if (left.family !== right.family || left.model !== right.model || left.revision !== right.revision || left.dtype !== right.dtype) return false;
    if (left.resourcePaths === right.resourcePaths) return true;
    if (!left.resourcePaths || !right.resourcePaths) return false;
    const entries = Object.entries(left.resourcePaths);
    return entries.length === Object.keys(right.resourcePaths).length
        && entries.every(function sameResource([role, member]) { return right.resourcePaths[role] === member; });
}

/** App-owned selection; shared typed-decision execution, without a renderer. */
export function createNativeDecisionService(configuration = {}, {appRoot = process.cwd()} = {}) {
    const events = createArcaneEventSource({}, {source: 'core-decisions', eventTypes: ['decisions.state']});
    const lifetime = new AbortController();
    const loads = new Set();
    const provisionalCleanupFailures = [];
    let context;
    let modelAssetOwner;
    let model;
    let loading;
    let loadController;
    let releasing;
    let closing;
    let unsubscribe;
    let selectedActivation = {
        family: configuration.family === undefined ? 'laya' : configuration.family,
        model: configuration.model === undefined ? 'onnx-community/laya-typed-decisions-ONNX' : configuration.model,
        revision: configuration.revision === undefined ? 'main' : configuration.revision,
        dtype: configuration.dtype === undefined ? 'fp32' : configuration.dtype,
        executionTarget: configuration.executionTarget,
        ...(configuration.assetProjectionId == null ? {} : {assetProjectionId: configuration.assetProjectionId, resourcePaths: configuration.resourcePaths && {...configuration.resourcePaths}})
    };
    let loadingActivation;
    let loadedActivation;

    function current() {
        const snapshot = model?.current() ?? {
            family: configuration.family ?? 'laya', model: configuration.model ?? 'onnx-community/laya-typed-decisions-ONNX',
            revision: configuration.revision ?? 'main', dtype: configuration.dtype ?? 'fp32',
            state: closing ? 'disposed' : 'unloaded', loaded: false, busy: Boolean(loading),
            activeRequests: 0, progress: null, error: null, execution: null
        };
        const pending = Boolean(loading) && (!snapshot.loaded || !sameActivation(loadedActivation, loadingActivation));
        return {
            ...snapshot, busy: snapshot.busy || pending,
            pendingActivation: pending ? {...loadingActivation} : snapshot.pendingActivation ?? null
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

    function load({
        family: requestedFamily, model: requestedModel, revision: requestedRevision, dtype: requestedDtype,
        signal, executionTarget: requestedTarget, assetProjectionId: requestedProjection, resourcePaths: requestedPaths
    } = {}) {
        operationSignal(signal).throwIfAborted();
        if (!context) throw new CoreError({code: 'CORE_NOT_READY', message: 'Register and start the decision service with Core before loading.'});
        const projection = requestedProjection === undefined ? selectedActivation.assetProjectionId : requestedProjection;
        const mapping = requestedPaths === undefined ? selectedActivation.resourcePaths : requestedPaths;
        const selection = {
            family: requestedFamily === undefined ? selectedActivation.family : requestedFamily,
            model: requestedModel === undefined ? selectedActivation.model : requestedModel,
            revision: requestedRevision === undefined ? selectedActivation.revision : requestedRevision,
            dtype: requestedDtype === undefined ? selectedActivation.dtype : requestedDtype,
            executionTarget: requestedTarget === undefined ? selectedActivation.executionTarget : requestedTarget,
            ...(projection == null ? {} : {assetProjectionId: projection, resourcePaths: mapping && typeof mapping === 'object' && !Array.isArray(mapping) ? {...mapping} : mapping})
        };
        if (loading && !loadController.signal.aborted && sameActivation(loadingActivation, selection)) return observeLoad(loading, loadController, signal);
        if (!loading && model?.current().loaded && sameActivation(loadedActivation, selection)) return Promise.resolve(current());
        const previousLoad = loading;
        const previousController = loadController;
        const controller = new AbortController();
        const selectedSignal = AbortSignal.any([lifetime.signal, controller.signal]);
        const precedingRelease = releasing;
        let retained;
        let retainError;
        const task = Promise.resolve().then(async function loadSelectedModel() {
            const replaced = new CoreError({name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message: 'The native decision activation request was replaced.'});
            try {
                if (retainError) throw retainError;
                selectedSignal.throwIfAborted();
                if (loading !== task) throw replaced;
                // Only explicit load waits for these owners. A provisional use
                // protects incoming files while the preceding model retires.
                const [localAI, modelAssets] = await Promise.all([
                    context.getService('local-ai'),
                    configuration.paths && selection.assetProjectionId === undefined ? undefined : context.getService('model-assets')
                ]);
                selectedSignal.throwIfAborted();
                if (loading !== task) throw replaced;
                if (modelAssets) modelAssetOwner = modelAssets;
                if (selection.assetProjectionId !== undefined && !retained) retained = modelAssets.retain(selection.assetProjectionId);
                selectedSignal.throwIfAborted();
                if (loading !== task) throw replaced;
                previousController?.abort(replaced);
                if (precedingRelease) await precedingRelease;
                if (previousLoad) await Promise.allSettled([previousLoad]);
                selectedSignal.throwIfAborted();
                if (loading !== task) throw replaced;
                if (model) await model.dispose();
                selectedSignal.throwIfAborted();
                if (loading !== task) throw replaced;
                unsubscribe?.();
                const paths = configuration.paths && Object.fromEntries(
                    Object.entries(configuration.paths).map(function nativePath([name, value]) { return [name, path.resolve(appRoot, value)]; })
                );
                model = createNativeDecisionModel({
                    ...configuration, paths, onnx: localAI.getONNXRuntime(), modelAssets,
                    family: selection.family, model: selection.model, revision: selection.revision, dtype: selection.dtype,
                    executionTarget: selection.executionTarget, assetProjectionId: selection.assetProjectionId,
                    resourcePaths: selection.resourcePaths, signal: lifetime.signal
                });
                unsubscribe = model.subscribe(function modelStateChanged() { publish(); });
                const result = await model.load({signal: selectedSignal});
                selectedSignal.throwIfAborted();
                loadedActivation = selection;
                return result;
            } finally {
                previousController?.abort(replaced);
                try { await retained?.release(); }
                catch (error) {
                    provisionalCleanupFailures.push(error);
                    throw error;
                }
            }
        });
        function settled() {
            loads.delete(task);
            if (loading !== task) return;
            loading = undefined;
            loadController = undefined;
            publish();
        }
        task.then(settled, settled).catch(function reportStateFailure(error) { console.error('Native decision state publication failed.', error); });
        loads.add(task);
        loading = task;
        loadController = controller;
        loadingActivation = selection;
        selectedActivation = selection;
        // A pending predecessor may hold the final native use while its workers
        // exit. Take our use before making that predecessor's cleanup runnable.
        if (selection.assetProjectionId !== undefined && modelAssetOwner) {
            try { retained = modelAssetOwner.retain(selection.assetProjectionId); }
            catch (error) { retainError = error; }
        }
        publish();
        return observeLoad(task, controller, signal);
    }

    function observeLoad(task, controller, signal) {
        function abort() { controller.abort(signal.reason); }
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
        return task.then(function loadedActivation(result) {
            controller.signal.throwIfAborted();
            const snapshot = current();
            if ((loading && loadController !== controller) || !snapshot.loaded || snapshot.execution !== result.execution) {
                throw new CoreError({name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message: 'The native decision activation was replaced.'});
            }
            return snapshot;
        }).finally(function detachLoadCaller() { signal?.removeEventListener('abort', abort); });
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
        const acceptedLoads = [...loads];
        releasing = Promise.resolve().then(async function releaseSelectedModel() {
            const results = await Promise.allSettled([task, ...acceptedLoads]);
            if (provisionalCleanupFailures.length) throw new AggregateError([
                ...(results[0].status === 'rejected' ? [results[0].reason] : []), ...provisionalCleanupFailures
            ], 'Releasing native decision resources failed.');
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
            await Promise.allSettled([...loads]);
            failures.push(...provisionalCleanupFailures);
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
            'decisions.load': function loadRequest(parameters, request) {
                return load({
                    family: parameters?.family, model: parameters?.model, revision: parameters?.revision, dtype: parameters?.dtype,
                    executionTarget: parameters?.executionTarget, assetProjectionId: parameters?.assetProjectionId,
                    resourcePaths: parameters?.resourcePaths, signal: request.signal
                });
            },
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
