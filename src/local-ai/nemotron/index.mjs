import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {createNemotronHelper, deferred, encodeNemotronAudio, nemotronError} from './helper.mjs';

/** Retain one selected recognizer and diarizer across explicit utterance endpoints. */
export function createNemotronRuntime(
    {runtime, prepare, modelId = 'nemotron-3.5-asr-streaming-0.6b', modelPath,
        diarizationModelPath, gpu, onEvent} = {}
) {
    if (!runtime && typeof prepare !== 'function') {
        throw new TypeError('Nemotron requires a prepared runtime or a prepare function.');
    }
    const events = createArcaneEventSource(
        {},
        {source: 'nemotron', eventTypes: ['nemotron.state']}
    );
    const callbacks = new AsyncLocalStorage();
    const instance = randomUUID();
    let selected = modelId;
    let selectedModelPath = modelPath ?? runtime?.modelPath;
    let selectedDiarizationPath = diarizationModelPath ?? runtime?.diarizationModelPath;
    let selectedGpu = gpu ?? runtime?.gpu;
    let streamSequence = 0;
    let state = 'unloaded';
    let helper = null;
    let loading = null;
    let loadController = null;
    let active = null;
    let unloading = null;
    let closing = null;
    let disposed = false;
    let error = null;
    let reset = null;

    function current() {
        return {
            providerId: 'nemotron', modelId: selected, state,
            loaded: state === 'ready', busy: active !== null,
            modelPath: selectedModelPath ?? null,
            diarizationModelPath: selectedDiarizationPath ?? null,
            requestedGpu: selectedGpu ?? null,
            observedBackend: null,
            nativeVersion: helper?.current().metadata?.version ?? null,
            speakerScope: active?.speakerScope ?? null,
            resetRequired: reset !== null,
            reset,
            error
        };
    }

    function publish() {
        if (!disposed) events.dispatch('nemotron.state', current());
    }

    function notify(listener, snapshot) {
        const result = listener(snapshot);
        if (result && typeof result.then === 'function') {
            Promise.resolve(result).catch(
                function listenerFailed(failure) {
                    console.error('Nemotron state listener failed.', failure);
                }
            );
        }
    }

    function subscribe(listener, {replay = true, signal} = {}) {
        if (typeof listener !== 'function') throw new TypeError('A Nemotron state listener must be a function.');
        if (disposed) {
            if (replay && !signal?.aborted) notify(listener, current());
            return function closedSubscription() {};
        }
        const unsubscribe = events.on(
            'nemotron.state',
            function modelState(event) {
                notify(listener, event.detail);
            },
            {signal}
        );
        try {
            if (replay && !signal?.aborted) notify(listener, current());
        } catch (failure) {
            unsubscribe();
            throw failure;
        }
        return unsubscribe;
    }

    function load(options = {}) {
        const {signal} = options;
        signal?.throwIfAborted();
        if (closing || disposed || unloading) {
            return Promise.reject(nemotronError('NEMOTRON_CLOSING', 'Nemotron is closing.'));
        }
        const changed = (options.modelId !== undefined && options.modelId !== selected)
            || (options.modelPath !== undefined && options.modelPath !== selectedModelPath)
            || (options.diarizationModelPath !== undefined && options.diarizationModelPath !== selectedDiarizationPath)
            || (options.gpu !== undefined && options.gpu !== selectedGpu);
        if ((loading || helper || active) && changed) {
            return Promise.reject(nemotronError('NEMOTRON_MODEL_LOADED', 'Unload the current Nemotron selection before replacing it.'));
        }
        if (loading) return waitFor(loading, signal);
        if (state === 'ready') return Promise.resolve(current());
        if (helper || active) {
            return Promise.reject(nemotronError('NEMOTRON_MODEL_ACTIVE', 'Unload the previous Nemotron operation before loading again.'));
        }
        selected = options.modelId ?? selected;
        selectedModelPath = options.modelPath ?? selectedModelPath;
        selectedDiarizationPath = options.diarizationModelPath ?? selectedDiarizationPath;
        selectedGpu = options.gpu ?? selectedGpu;
        state = 'loading';
        error = null;
        loadController = new AbortController();
        const ownerSignal = loadController.signal;
        async function loadModel() {
            ownerSignal.throwIfAborted();
            if (!runtime) {
                runtime = await prepare(
                    {signal: ownerSignal, onEvent}
                );
            }
            ownerSignal.throwIfAborted();
            selectedModelPath ??= runtime.modelPath;
            selectedDiarizationPath ??= runtime.diarizationModelPath;
            selectedGpu ??= runtime.gpu;
            if (typeof runtime.helperExecutable !== 'string' || typeof selectedModelPath !== 'string') {
                throw nemotronError('NEMOTRON_MODEL_UNAVAILABLE', 'Select the prepared Nemotron helperExecutable and ASR modelPath.');
            }
            if (selectedDiarizationPath !== undefined && typeof selectedDiarizationPath !== 'string') {
                throw new TypeError('diarizationModelPath must be the selected local model path.');
            }
            if (!Number.isInteger(selectedGpu) || selectedGpu < -1) {
                throw new TypeError('Select the native GPU ordinal through gpu, or explicitly use -1 for CPU.');
            }
            const session = createNemotronHelper(
                {
                    runtime, modelPath: selectedModelPath, diarizationModelPath: selectedDiarizationPath,
                    gpu: selectedGpu, onEvent
                }
            );
            helper = session;
            function cancelLoad() {
                session.stop(ownerSignal.reason).catch(observeRetainedFailure);
            }
            ownerSignal.addEventListener(
                'abort', cancelLoad,
                {once: true}
            );
            session.completion.catch(
                function modelExited(failure) {
                    if (helper === session && !unloading && !closing && !session.current().stopping) {
                        error = failure;
                        state = 'error';
                        active?.failed(failure);
                        publish();
                    }
                }
            );
            try {
                if (ownerSignal.aborted) cancelLoad();
                await session.ready;
                ownerSignal.throwIfAborted();
                state = 'ready';
                reset = null;
                publish();
                return current();
            } catch (failure) {
                try {
                    await session.stop();
                } catch (cleanupFailure) {
                    if (cleanupFailure !== failure) {
                        throw new AggregateError([failure, cleanupFailure], 'Nemotron loading and cleanup failed.');
                    }
                } finally {
                    if (helper === session) helper = null;
                }
                throw failure;
            } finally {
                ownerSignal.removeEventListener('abort', cancelLoad);
            }
        }
        function loadFailed(failure) {
            const cancelledLoad = ownerSignal.aborted && (
                failure === ownerSignal.reason || failure?.code === 'ARCANE_CANCELLED' || failure?.name === 'AbortError'
            );
            error = cancelledLoad ? null : failure;
            state = unloading || closing ? 'unloading' : ownerSignal.aborted ? 'unloaded' : 'error';
            publish();
            throw failure;
        }
        function loadSettled() {
            loading = null;
            loadController = null;
        }
        loading = Promise.resolve().then(loadModel).catch(loadFailed).finally(loadSettled);
        loading.catch(observeRetainedFailure);
        publish();
        // A caller's wait never cancels shared model loading. Explicit unload
        // and close own that cancellation and its joined native cleanup.
        return waitFor(loading, signal);
    }

    function openStream({sampleRate = 16000, languageCode, model, onUpdate, signal} = {}) {
        signal?.throwIfAborted();
        if (model !== undefined && model !== selected) {
            return Promise.reject(
                nemotronError('NEMOTRON_MODEL_MISMATCH', `The selected Nemotron model is ${selected}.`)
            );
        }
        if (closing || disposed || unloading) return Promise.reject(nemotronError('NEMOTRON_CLOSING', 'Nemotron is closing.'));
        if (active) return Promise.reject(nemotronError('NEMOTRON_BUSY', 'This Nemotron engine already owns an audio stream.'));
        if (!Number.isInteger(sampleRate) || (sampleRate !== 0 && (sampleRate < 8000 || sampleRate > 96000))) {
            return Promise.reject(new TypeError('sampleRate must be 0 (model rate) or an integer from 8000 through 96000.'));
        }
        if (languageCode !== undefined && (typeof languageCode !== 'string' || languageCode.includes('\0'))) {
            return Promise.reject(new TypeError('languageCode must be a string representable by the native C ABI.'));
        }
        if (onUpdate !== undefined && typeof onUpdate !== 'function') return Promise.reject(new TypeError('onUpdate must be a function.'));
        const controller = new AbortController();
        const operationSignal = signal ? AbortSignal.any(
            [signal, controller.signal]
        ) : controller.signal;
        const lifetime = deferred();
        const record = {controller, speakerScope: `${instance}/${++streamSequence}`, opening: null, cancel: null, failed: null};
        active = record;
        let session = null;
        let nativeOpening = false;
        let nativeOpened = false;
        let tail = Promise.resolve();
        let finishing = null;
        let cancelling = null;
        let cancellationJoined = null;
        let cancelled = null;
        let terminalFailure = null;
        let ended = false;
        let latest = null;

        function requireActive() {
            if (cancelled) throw cancelled;
            operationSignal.throwIfAborted();
            if (ended) throw nemotronError('NEMOTRON_STREAM_CLOSED', 'The Nemotron stream has ended.');
            if (helper !== session || state !== 'ready') throw nemotronError('NEMOTRON_MODEL_NOT_READY', 'The selected Nemotron model is no longer ready.');
        }

        function release() {
            ended = true;
            nativeOpened = false;
            operationSignal.removeEventListener('abort', abort);
            if (active === record) active = null;
            publish();
        }

        function insideCallback() {
            const context = callbacks.getStore();
            return context?.active && context.record === record;
        }

        function requireOutsideCallback(operation) {
            if (insideCallback()) {
                throw nemotronError('NEMOTRON_CALLBACK_WAIT', `${operation} must wait until the output callback returns; abort the caller-owned signal synchronously and join outside the callback.`);
            }
        }

        async function accept(results) {
            const delivered = [];
            try {
                for (const result of results) {
                    requireActive();
                    const first = result.alternatives[0];
                    const snapshot = {...result, text: first?.text ?? '', words: first?.words ?? [], speakerScope: record.speakerScope};
                    if (onUpdate) {
                        const context = {record, active: true};
                        try {
                            await callbacks.run(context, onUpdate, snapshot);
                        } finally {
                            context.active = false;
                        }
                        requireActive();
                    }
                    latest = snapshot;
                    delivered.push(snapshot);
                }
            } catch (failure) {
                // Cancellation suppresses later commits, while complete native
                // output remains available to the operation's diagnostic owner.
                throw nemotronError(
                    failure?.code ?? 'NEMOTRON_OUTPUT_FAILED',
                    failure?.message ?? 'Nemotron output delivery failed.',
                    {cause: failure, nativeResults: results}
                );
            }
            return delivered;
        }

        function beginCancellation(reason) {
            if (cancellationJoined) return cancellationJoined;
            if (ended) return Promise.resolve({cancelled: false, resetRequired: false});
            cancelled = nemotronError('NEMOTRON_CANCELLED', 'The Nemotron stream was cancelled.', {reason});
            async function cancelStream() {
                let outcome = {resetRequired: false};
                if (session && (nativeOpening || nativeOpened)) outcome = await session.closeStream(cancelled);
                if (outcome.resetRequired && helper === session) {
                    helper = null;
                    reset = {speakerScope: record.speakerScope, reason: cancelled, diagnostics: outcome.diagnostics};
                    state = unloading || closing ? 'unloading' : 'unloaded';
                }
                return {cancelled: true, ...outcome, speakerScope: record.speakerScope};
            }
            cancelling = Promise.resolve().then(cancelStream);
            async function joinCancellation() {
                // Native shutdown and the accepted operation/callback must both
                // settle before releasing this stream's conversation ownership.
                const [native] = await Promise.allSettled(
                    [cancelling, tail, record.opening]
                );
                try {
                    if (native.status === 'rejected') {
                        throw terminalFailure && terminalFailure !== native.reason
                            ? new AggregateError(
                                [terminalFailure, native.reason],
                                'Nemotron operation and cleanup failed.'
                            )
                            : native.reason;
                    }
                    if (terminalFailure) throw terminalFailure;
                    lifetime.resolve(native.value);
                    return native.value;
                } catch (failure) {
                    lifetime.reject(failure);
                    throw failure;
                } finally {
                    release();
                }
            }
            cancellationJoined = Promise.resolve().then(joinCancellation);
            cancellationJoined.catch(observeRetainedFailure);
            return cancellationJoined;
        }

        function cancel(reason) {
            requireOutsideCallback('cancel');
            return beginCancellation(reason);
        }

        function abort() {
            beginCancellation(operationSignal.reason).catch(observeRetainedFailure);
        }

        record.cancel = cancel;
        record.failed = function streamFailed(failure) {
            terminalFailure = failure;
            beginCancellation(failure).catch(observeRetainedFailure);
        };

        function enqueue(operation) {
            async function operationFailed(failure) {
                if (!cancelled) terminalFailure = failure;
                try {
                    beginCancellation(failure);
                    await cancelling;
                } catch (cleanupFailure) {
                    if (cleanupFailure !== failure) throw new AggregateError([failure, cleanupFailure], 'Nemotron operation and stream cleanup failed.');
                }
                throw failure;
            }
            const result = tail.then(operation).catch(operationFailed);
            tail = result.then(observeRetainedFailure, observeRetainedFailure);
            return result;
        }

        function push(audio) {
            requireOutsideCallback('push');
            if (finishing || ended || cancelling) return Promise.reject(nemotronError('NEMOTRON_STREAM_CLOSED', 'The Nemotron stream is ending.'));
            const samples = decodeAudio(audio);
            async function pushAudio() {
                requireActive();
                const results = [];
                // Drive recognition between ordered 100 ms transport chunks.
                // This schedules native work; it never shortens caller audio.
                const count = Math.round((sampleRate || 16000) * 0.1);
                for (let offset = 0; offset < samples.length; offset += count) {
                    requireActive();
                    const chunk = samples.subarray(offset, offset + count);
                    const updates = await session.command('push', String(chunk.length), encodeNemotronAudio(chunk));
                    for (const result of await accept(updates)) results.push(result);
                }
                return results;
            }
            return enqueue(pushAudio);
        }

        function forceEndpoint() {
            requireOutsideCallback('forceEndpoint');
            if (finishing || ended || cancelling) return Promise.reject(nemotronError('NEMOTRON_STREAM_CLOSED', 'The Nemotron stream is ending.'));
            async function endpoint() {
                requireActive();
                // Native ASR segmentation preserves this exact stream and its
                // speaker scope. It makes no conversational-completion decision.
                return accept(await session.command('endpoint'));
            }
            return enqueue(endpoint);
        }

        function finish() {
            requireOutsideCallback('finish');
            if (finishing) return finishing;
            if (cancelling || ended) return Promise.reject(cancelled ?? nemotronError('NEMOTRON_STREAM_CLOSED', 'The Nemotron stream has ended.'));
            async function finishAudio() {
                requireActive();
                const result = await accept(await session.command('finish'));
                release();
                lifetime.resolve(result);
                return result;
            }
            finishing = enqueue(finishAudio);
            finishing.catch(observeRetainedFailure);
            return finishing;
        }

        const stream = {
            push, forceEndpoint, finish, cancel, completion: lifetime.promise,
            speakerScope: record.speakerScope, sampleRate,
            current: function streamResult() { return latest; }
        };
        async function openNativeStream() {
            if (loading) await waitFor(loading, operationSignal);
            operationSignal.throwIfAborted();
            if (ended || cancelled) throw cancelled ?? nemotronError('NEMOTRON_STREAM_CLOSED', 'The Nemotron stream was cancelled before opening.');
            if (state !== 'ready' || !helper) throw nemotronError('NEMOTRON_MODEL_NOT_READY', 'Explicitly load the selected Nemotron model before opening a stream.');
            session = helper;
            operationSignal.addEventListener(
                'abort', abort,
                {once: true}
            );
            const language = Buffer.from(languageCode ?? '', 'utf8');
            nativeOpening = true;
            if (operationSignal.aborted) abort();
            requireActive();
            await session.command('open', `${sampleRate} ${language.length}`, language);
            nativeOpened = true;
            nativeOpening = false;
            requireActive();
            publish();
            return stream;
        }
        async function openFailed(failure) {
            if (!cancelled) terminalFailure = failure;
            try {
                beginCancellation(failure);
                await cancelling;
            } catch (cleanupFailure) {
                if (cleanupFailure !== failure) throw new AggregateError([failure, cleanupFailure], 'Nemotron stream opening and cleanup failed.');
            }
            throw failure;
        }
        record.opening = Promise.resolve().then(openNativeStream).catch(openFailed);
        publish();
        return record.opening;
    }

    async function transcribe(request, {signal, onProgress, onUpdate} = {}) {
        signal?.throwIfAborted();
        if (request?.model !== undefined && request.model !== selected) {
            throw nemotronError('NEMOTRON_MODEL_MISMATCH', `The loaded Nemotron model is ${selected}.`);
        }
        const audio = decodeAudio(request?.audio ?? request);
        const finals = [];
        await onProgress?.(
            {phase: 'accepted'}
        );
        const stream = await openStream(
            {
                sampleRate: request?.sampleRate ?? 16000,
                languageCode: request?.languageCode ?? request?.language,
                signal,
                onUpdate: async function transcriptionUpdate(result) {
                    if (result.final) finals.push(result);
                    await onUpdate?.(result);
                    await onProgress?.(
                        {phase: 'recognizing', result}
                    );
                }
            }
        );
        try {
            await stream.push(audio);
            await stream.finish();
            // Whole-recording mode has no intermediate endpoints. Preserve any
            // native final boundaries as well as the complete visible text.
            return {
                text: finals.map(
                    function transcript(result) { return result.text; }
                ).join(''),
                words: finals.flatMap(
                    function words(result) { return result.words; }
                ),
                results: finals,
                speakerScope: stream.speakerScope
            };
        } catch (failure) {
            try {
                await stream.cancel(failure);
            } catch (cleanupFailure) {
                throw new AggregateError([failure, cleanupFailure], 'Nemotron transcription and cleanup failed.');
            }
            if (finals.length) {
                throw nemotronError(
                    failure?.code ?? 'NEMOTRON_TRANSCRIPTION_FAILED',
                    failure?.message ?? 'Nemotron transcription failed.',
                    {cause: failure, completedResults: finals}
                );
            }
            throw failure;
        }
    }

    function unload() {
        if (callbacks.getStore()?.active) {
            return Promise.reject(nemotronError('NEMOTRON_CALLBACK_WAIT', 'Unload Nemotron after the output callback returns; abort the caller-owned signal synchronously and join outside the callback.'));
        }
        if (unloading) return unloading;
        if (disposed) return Promise.resolve(current());
        state = 'unloading';
        const operation = active;
        const pendingLoad = loading;
        const pendingLoadSignal = loadController?.signal;
        loadController?.abort(nemotronError('NEMOTRON_UNLOADED', 'The Nemotron model was unloaded.'));
        operation?.controller.abort(nemotronError('NEMOTRON_UNLOADED', 'The Nemotron model was unloaded.'));
        async function unloadModel() {
            const failures = [];
            if (operation) {
                try { await operation.cancel(); } catch (failure) { failures.push(failure); }
                await Promise.allSettled(
                    [operation.opening]
                );
            }
            if (pendingLoad) {
                try {
                    await pendingLoad;
                } catch (failure) {
                    const cancelledLoad = pendingLoadSignal?.aborted && (
                        failure === pendingLoadSignal.reason || failure?.code === 'ARCANE_CANCELLED' || failure?.name === 'AbortError'
                    );
                    if (!cancelledLoad) failures.push(failure);
                }
            }
            const session = helper;
            try { if (session) await session.stop(); } catch (failure) { failures.push(failure); }
            if (helper === session) helper = null;
            if (failures.length) throw new AggregateError(failures, 'Nemotron cleanup failed.');
            error = null;
            state = 'unloaded';
            return current();
        }
        function unloadFailed(failure) {
            state = 'error';
            error = failure;
            throw failure;
        }
        function unloadSettled() {
            unloading = null;
            publish();
        }
        unloading = Promise.resolve().then(unloadModel).catch(unloadFailed).finally(unloadSettled);
        publish();
        return unloading;
    }

    function close() {
        if (callbacks.getStore()?.active) {
            return Promise.reject(nemotronError('NEMOTRON_CALLBACK_WAIT', 'Close Nemotron after the output callback returns; abort the caller-owned signal synchronously and join outside the callback.'));
        }
        if (closing) return closing;
        async function closeModel() {
            try {
                await unload();
            } finally {
                state = 'closed';
                publish();
                disposed = true;
                events.dispose();
            }
            return current();
        }
        closing = Promise.resolve().then(closeModel);
        return closing;
    }

    return {current, subscribe, load, unload, transcribe, openStream, close};
}

function decodeAudio(audio) {
    if (audio instanceof Float32Array) return audio;
    if (audio?.encoding !== 'f32le' || typeof audio.data !== 'string') {
        throw nemotronError('NEMOTRON_AUDIO_FORMAT_UNSUPPORTED', 'Nemotron accepts mono Float32Array or {encoding: "f32le", data: BASE64}; encoded recordings require caller-owned decoding.');
    }
    const encoded = Buffer.from(audio.data, 'base64');
    if (encoded.length % 4 !== 0) throw new TypeError('The f32le transport ends during a sample.');
    const samples = new Float32Array(encoded.length / 4);
    const bits = new Uint32Array(samples.buffer);
    for (let index = 0; index < samples.length; index++) bits[index] = encoded.readUInt32LE(index * 4);
    return samples;
}

function waitFor(task, signal) {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise(
        function waitForModel(resolve, reject) {
            function cancelled() {
                signal.removeEventListener('abort', cancelled);
                reject(signal.reason);
            }
            signal.addEventListener(
                'abort', cancelled,
                {once: true}
            );
            task.then(
                function ready(value) {
                    signal.removeEventListener('abort', cancelled);
                    if (signal.aborted) reject(signal.reason);
                    else resolve(value);
                },
                function failed(failure) {
                    signal.removeEventListener('abort', cancelled);
                    reject(failure);
                }
            );
        }
    );
}

// Public promises and lifecycle snapshots retain these failures for their
// owners, including before a consumer has attached its own observer.
function observeRetainedFailure() {}

export default createNemotronRuntime;
