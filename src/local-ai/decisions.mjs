import {randomUUID} from 'node:crypto';
import {createArcaneEventSource} from '../event-manager.mjs';
import {CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';
import {decodeDecisionOutputs} from '../../browser-runtime/ai/decision-runtime.mjs';
import {createDecisionTokenizer} from './decision-tokenizer.mjs';

const STATE_EVENT = 'ai.decisions.state';
const LAYA_FILES = ['onnx/model.onnx', 'onnx/model.onnx_data', 'tokenizer.json', 'tokenizer_config.json'];

function cancellation(message) {
    return new CoreError({name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message});
}

function reportCleanupFailure(error) { console.error('Native decision cleanup failed.', error); }

function sameExecutionTarget(left, right) {
    return left === right || (left != null && right != null && left.deviceId !== undefined && left.deviceId === right.deviceId);
}

/**
 * One explicitly activated Laya FP32 model using an existing native ONNX owner.
 * It does not create another inference runtime or load on construction.
 */
export function createNativeDecisionModel({
    onnx, modelAssets, workingDirectory, paths,
    model = 'onnx-community/laya-typed-decisions-ONNX', revision = 'main',
    dtype = 'fp32', sessionOptions, executionPreference = 'gpu', executionTarget, signal
} = {}) {
    if (dtype !== 'fp32') throw new TypeError('This native Laya graph selection requires dtype fp32.');
    const owner = {};
    const events = createArcaneEventSource(owner, {source: 'native-decisions', eventTypes: [STATE_EVENT]});
    let activation;
    let releaseTask;
    let disposal;
    let disposed = false;
    let state = 'unloaded';
    let progress = null;
    let lastError = null;
    let execution = null;
    let selectedTarget = executionTarget;
    let pendingActivation;

    function current() {
        const pending = pendingActivation && (state !== 'ready' || pendingActivation.entry !== activation) ? pendingActivation : null;
        return {
            family: 'laya', model, revision, dtype, state,
            loaded: state === 'ready', busy: state === 'loading' || Boolean(pending) || Boolean(activation?.jobs.size),
            activeRequests: activation?.jobs.size ?? 0, progress,
            error: lastError ? serializeCoreError(lastError) : null,
            execution,
            pendingActivation: pending ? {executionTarget: pending.executionTarget} : null
        };
    }

    function publish() { events.dispatch(STATE_EVENT, current()); }

    function subscribe(listener, {emitCurrent = true, signal: subscriptionSignal} = {}) {
        const unsubscribe = events.on(STATE_EVENT, function changed(event) { listener(event.detail); }, {signal: subscriptionSignal});
        try { if (emitCurrent && !subscriptionSignal?.aborted) listener(current()); }
        catch (error) { unsubscribe(); throw error; }
        return unsubscribe;
    }

    function assertOpen(operationSignal) {
        if (disposed) throw new CoreError({code: 'ARCANE_AI_DISPOSED', message: 'The native decision model is disposed.'});
        signal?.throwIfAborted();
        operationSignal?.throwIfAborted();
    }

    function updateProgress(entry, value) {
        if (activation !== entry || entry.controller.signal.aborted) return;
        progress = value;
        publish();
    }

    function stop(entry, reason, terminalState = 'unloaded') {
        if (entry.release) return entry.release;
        if (activation === entry) {
            activation = undefined;
            state = disposed ? 'disposing' : 'unloading';
            progress = null;
            lastError = terminalState === 'error' ? reason : null;
        }
        // Establish cleanup ownership before abort observers or state listeners
        // can request another unload or dispose.
        entry.release = Promise.resolve().then(async function releaseActivation() {
            const failures = [];
            await Promise.allSettled([entry.loading, ...entry.jobs]);
            entry.unsubscribe?.();
            const ownedSession = onnx.current().sessions.some(function owned(value) { return value.id === entry.id; });
            const engineRelease = entry.onnxLoadStarted && ownedSession
                ? onnx.unload({id: entry.id})
                : Promise.resolve();
            const releases = await Promise.allSettled([engineRelease, entry.tokenizer?.close(reason)]);
            for (const result of releases) if (result.status === 'rejected') failures.push(result.reason);
            // unload joins actual native worker exit, even when load/run already
            // rejected. Working files cannot be retired at promise rejection.
            const exited = onnx.current().sessions.find(function owned(value) { return value.id === entry.id; })?.exited;
            const engineStopped = releases[0].status === 'fulfilled' || exited === true;
            const tokenizerStopped = !entry.tokenizer || entry.tokenizer.exited;
            if (engineStopped && tokenizerStopped) {
                try { await entry.retained?.release(); } catch (error) { failures.push(error); }
                if (entry.prepared) {
                    try { await modelAssets.release(entry.id); } catch (error) { failures.push(error); }
                }
            }
            const cleanupError = failures.length ? new AggregateError(failures, 'Releasing native decision resources failed.') : null;
            if (!activation) {
                state = disposed ? 'disposed' : cleanupError ? 'error' : terminalState;
                progress = null;
                execution = null;
                if (cleanupError) lastError = cleanupError;
                publish();
            }
            if (cleanupError) throw cleanupError;
            return current();
        });
        releaseTask = entry.release;
        entry.controller.abort(reason);
        entry.tokenizer?.close(reason).catch(reportCleanupFailure);
        publish();
        entry.release.catch(reportCleanupFailure);
        return entry.release;
    }

    function observeCancellation(entry, operationSignal) {
        function abort() { stop(entry, operationSignal.reason).catch(reportCleanupFailure); }
        operationSignal?.addEventListener('abort', abort, {once: true});
        if (operationSignal?.aborted) abort();
        return function detachAbort() { operationSignal?.removeEventListener('abort', abort); };
    }

    async function prepareFiles(entry) {
        if (paths) return paths;
        if (!modelAssets) throw new CoreError({code: 'ARCANE_DECISION_ASSETS_UNAVAILABLE', message: 'Native decisions need prepared paths or the Core model-assets owner.'});
        const base = `https://huggingface.co/${model}/resolve/${encodeURIComponent(revision)}/`;
        const projection = await modelAssets.prepare({
            id: entry.id, workingDirectory,
            members: LAYA_FILES.map(function selectFile(path) { return {path, url: new URL(path, base).href}; }),
            signal: entry.controller.signal,
            onProgress(value) { updateProgress(entry, value); }
        });
        entry.prepared = true;
        entry.controller.signal.throwIfAborted();
        entry.retained = modelAssets.retain(entry.id);
        await modelAssets.release(entry.id);
        entry.prepared = false;
        const files = Object.fromEntries(projection.members.map(function memberFile(member) { return [member.path, member.nativePath]; }));
        return {model: files['onnx/model.onnx'], tokenizer: files['tokenizer.json'], tokenizerConfig: files['tokenizer_config.json']};
    }

    function beginActivation(target) {
        const entry = {id: randomUUID(), controller: new AbortController(), jobs: new Set(), prepared: false, onnxLoadStarted: false, executionTarget: target};
        activation = entry;
        state = 'loading';
        progress = {phase: 'preparing-model'};
        lastError = null;
        execution = null;
        entry.loading = Promise.resolve().then(async function activateNativeModel() {
            const files = await prepareFiles(entry);
            entry.controller.signal.throwIfAborted();
            updateProgress(entry, {phase: 'loading-model'});
            entry.tokenizer = createDecisionTokenizer({
                tokenizerPath: files.tokenizer, tokenizerConfigPath: files.tokenizerConfig,
                signal: entry.controller.signal,
                onError(error) {
                    if (activation === entry) stop(entry, error, 'error').catch(reportCleanupFailure);
                }
            });
            entry.onnxLoadStarted = true;
            const loaded = onnx.load({
                id: entry.id, model: files.model, sessionOptions, executionPreference, executionTarget: entry.executionTarget,
                signal: entry.controller.signal
            });
            const results = await Promise.allSettled([loaded, entry.tokenizer.ready]);
            const failures = results.filter(function failed(result) { return result.status === 'rejected'; })
                .map(function reason(result) { return result.reason; });
            if (failures.length) throw failures.length === 1 ? failures[0] : new AggregateError(failures, 'Loading the native decision model failed.');
            entry.controller.signal.throwIfAborted();
            if (activation !== entry) throw cancellation('The decision activation was replaced.');
            execution = results[0].value;
            state = 'ready';
            progress = {phase: 'ready'};
            entry.unsubscribe = onnx.subscribe(function nativeStateChanged(snapshot) {
                if (activation !== entry || entry.controller.signal.aborted) return;
                const selected = snapshot.sessions.find(function sameSession(value) { return value.id === entry.id; });
                // A failed run may leave ONNX loaded and its queued runs usable.
                // Stopping revokes readiness before physical residency ends.
                if (snapshot.closed || selected?.stopping || !selected?.loaded || ['unloading', 'unloaded'].includes(selected.state)) {
                    const error = selected?.error ? new CoreError(selected.error) : cancellation('The native ONNX session was retired.');
                    stop(entry, error, selected?.error ? 'error' : 'unloaded').catch(reportCleanupFailure);
                }
            });
            publish();
            return current();
        });
        entry.loading.catch(function activationFailed(error) {
            if (activation === entry) stop(entry, error, entry.controller.signal.aborted ? 'unloaded' : 'error').catch(reportCleanupFailure);
        });
        publish();
        return entry;
    }

    async function awaitActivation(entry, operationSignal) {
        const detach = observeCancellation(entry, operationSignal);
        try {
            await entry.loading;
            entry.controller.signal.throwIfAborted();
            if (activation !== entry) throw cancellation('The decision activation was replaced.');
            return current();
        } finally { detach(); }
    }

    function observeLoad(request, operationSignal) {
        function abort() { request.controller.abort(operationSignal.reason); }
        operationSignal?.addEventListener('abort', abort, {once: true});
        if (operationSignal?.aborted) abort();
        return request.task.then(function loadedActivation() {
            request.controller.signal.throwIfAborted();
            request.entry.controller.signal.throwIfAborted();
            if (activation !== request.entry) throw cancellation('The decision activation was replaced.');
            return current();
        }).finally(function detachLoadCaller() { operationSignal?.removeEventListener('abort', abort); });
    }

    async function load({signal: operationSignal, executionTarget: requestedTarget} = {}) {
        assertOpen(operationSignal);
        const target = requestedTarget === undefined ? selectedTarget : requestedTarget;
        if (pendingActivation && !pendingActivation.controller.signal.aborted && sameExecutionTarget(pendingActivation.executionTarget, target)) {
            return observeLoad(pendingActivation, operationSignal);
        }
        if (!pendingActivation && activation && sameExecutionTarget(activation.executionTarget, target)) {
            return awaitActivation(activation, operationSignal);
        }
        const previous = pendingActivation;
        const request = {executionTarget: target, controller: new AbortController()};
        let precedingRelease;
        // Retain the replacement before synchronous abort/state observers run.
        // Only this model's retiring activation must finish before its successor.
        request.task = Promise.resolve().then(async function loadSelectedTarget() {
            request.controller.signal.throwIfAborted();
            if (precedingRelease) await precedingRelease;
            assertOpen(request.controller.signal);
            if (pendingActivation !== request) throw cancellation('The decision activation request was replaced.');
            request.entry ??= activation ?? beginActivation(request.executionTarget);
            return awaitActivation(request.entry, request.controller.signal);
        });
        function settled(error) {
            request.detach?.();
            if (pendingActivation !== request) return;
            pendingActivation = undefined;
            if (!request.entry && !activation && !disposed && state === 'loading') {
                state = request.controller.signal.aborted ? 'unloaded' : 'error';
                progress = null;
                lastError = request.controller.signal.aborted ? null : error;
            }
            publish();
        }
        request.task.then(function loaded() { settled(); }, function loadFailed(error) { settled(error); }).catch(reportCleanupFailure);
        pendingActivation = request;
        selectedTarget = target;
        const reason = cancellation('The decision execution target was replaced.');
        previous?.controller.abort(reason);
        if (activation && !sameExecutionTarget(activation.executionTarget, target)) stop(activation, reason);
        precedingRelease = !activation ? releaseTask : undefined;
        if (!activation && !precedingRelease) {
            request.entry = beginActivation(target);
            request.detach = observeCancellation(request.entry, request.controller.signal);
        }
        publish();
        return observeLoad(request, operationSignal);
    }

    async function evaluate(rows, {signal: operationSignal, runOptions} = {}) {
        assertOpen(operationSignal);
        const entry = activation;
        if (!entry) throw new CoreError({code: 'ARCANE_DECISION_NOT_LOADED', message: 'Load the selected native decision model before evaluating.'});
        const detach = observeCancellation(entry, operationSignal);
        const task = Promise.resolve().then(async function evaluateCompleteRows() {
            await entry.loading;
            entry.controller.signal.throwIfAborted();
            if (rows.length === 0) return {decisions: [], outputs: {}};
            updateProgress(entry, {phase: 'tokenizing'});
            const feeds = await entry.tokenizer.encode(rows);
            entry.controller.signal.throwIfAborted();
            updateProgress(entry, {phase: 'evaluating'});
            const outputs = await onnx.run({id: entry.id, feeds, runOptions, signal: entry.controller.signal});
            entry.controller.signal.throwIfAborted();
            return decodeDecisionOutputs(rows, outputs);
        });
        entry.jobs.add(task);
        publish();
        let result;
        try { result = await task; }
        catch (error) {
            if (activation === entry && !entry.controller.signal.aborted) {
                lastError = error;
                publish();
            }
            throw error;
        } finally {
            detach();
            entry.jobs.delete(task);
            if (activation === entry) {
                progress = {phase: entry.jobs.size ? 'evaluating' : 'ready'};
                publish();
            }
        }
        entry.controller.signal.throwIfAborted();
        if (activation !== entry) throw cancellation('The decision result belongs to a retired activation.');
        return result;
    }

    function unload() {
        const reason = cancellation('The native decision model was unloaded.');
        const pending = pendingActivation;
        pending?.controller.abort(reason);
        const release = activation ? stop(activation, reason) : releaseTask ?? Promise.resolve(current());
        if (!pending) return release;
        return Promise.allSettled([release, pending.task]).then(function releasedActivation(results) {
            if (results[0].status === 'rejected') throw results[0].reason;
            return current();
        });
    }

    function dispose() {
        if (disposal) return disposal;
        disposed = true;
        signal?.removeEventListener('abort', lifetimeAborted);
        const pending = pendingActivation;
        const reason = cancellation('The native decision model was disposed.');
        let release;
        disposal = Promise.resolve().then(async function disposeNativeModel() {
            try {
                const results = await Promise.allSettled([release, pending?.task]);
                if (results[0].status === 'rejected') throw results[0].reason;
            }
            finally { state = 'disposed'; publish(); events.dispose(); }
            return current();
        });
        pending?.controller.abort(reason);
        release = activation ? stop(activation, reason) : releaseTask;
        if (!activation && !release) { state = 'disposed'; publish(); }
        return disposal;
    }

    function lifetimeAborted() { dispose().catch(reportCleanupFailure); }
    signal?.addEventListener('abort', lifetimeAborted, {once: true});
    if (signal?.aborted) lifetimeAborted();
    return {load, current, status: current, subscribe, evaluate, classify: evaluate, unload, dispose};
}
