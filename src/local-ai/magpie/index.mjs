import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import Is from 'strong-type';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';
import {createMagpieHelper} from './helper.mjs';

const is = new Is(false);

/**
 * Retained Magpie/NanoCodec synthesis through the selected native C ABI.
 * Ordered onAudio/onProgress callbacks may abort their caller-owned signal.
 * Join stop or engine lifecycle completion outside those callbacks.
 */
export function createMagpieRuntime({
    runtime, prepare, paths, modelAssets, assetProjectionId, resourcePaths, modelId = 'magpie',
    voice = 'Aria', languageCode = 'en-US', executionTarget, signal, onEvent
} = {}) {
    const events = createArcaneEventSource(
        {}, {source: 'magpie', eventTypes: ['magpie.state']}
    );
    const requests = new Map();
    const retirements = new Set();
    const callbacks = new AsyncLocalStorage();
    let selection = {paths, assetProjectionId, resourcePaths, executionTarget};
    let activation = null;
    let state = 'unloaded';
    let error = null;
    let progress = null;
    let closing = null;
    let disposed = false;

    function current() {
        return {
            providerId: 'magpie-native', modelId, state,
            loaded: Boolean(activation?.ready && !activation.controller.signal.aborted),
            busy: Boolean(activation && (!activation.ready || activation.active)),
            requestId: activation?.active?.requestId ?? null,
            queuedRequests: activation?.queue.length ?? 0,
            defaultVoice: voice, languageCode,
            voices: activation?.voices ? Object.keys(activation.voices) : [],
            speech: {streaming: true, responseFormats: ['wav', 'pcm'], defaultResponseFormat: 'wav'},
            execution: activation ? {requested: {...activation.selection.executionTarget}, configuredBackend: activation.selection.executionTarget?.backend} : null,
            sampleRate: activation?.metadata?.sampleRate ?? null,
            progress, error: error ? serializeCoreError(error) : null
        };
    }

    function publish() {
        if (!disposed) events.dispatch('magpie.state', current());
    }

    function subscribe(listener, {replay = true, signal: subscriptionSignal} = {}) {
        if (!is.function(listener)) throw new TypeError('A Magpie state listener must be a function.');
        if (disposed) {
            if (replay && !subscriptionSignal?.aborted) notify(listener, current());
            return function disposedSubscription() {};
        }
        const unsubscribe = events.on(
            'magpie.state', function stateChanged(event) { notify(listener, event.detail); },
            {signal: subscriptionSignal}
        );
        try { if (replay && !subscriptionSignal?.aborted) notify(listener, current()); }
        catch (failure) { unsubscribe(); throw failure; }
        return unsubscribe;
    }

    function assertOpen(operationSignal) {
        signal?.throwIfAborted();
        operationSignal?.throwIfAborted();
        if (closing || disposed) throw failure('MAGPIE_CLOSED', 'The Magpie engine is closing.');
    }

    function load(options = {}) {
        assertOpen(options.signal);
        if (options.modelId !== undefined && options.modelId !== modelId) {
            throw failure('MAGPIE_MODEL_MISMATCH', 'This engine owns a different selected model.');
        }
        const next = {...selection};
        for (const field of ['paths', 'assetProjectionId', 'resourcePaths', 'executionTarget']) {
            if (Object.hasOwn(options, field)) next[field] = options[field];
        }
        if (activation && sameSelection(activation.selection, next) && !activation.retirement) {
            if (activation.ready) return Promise.resolve(current());
            return waitFor(activation.loaded, options.signal);
        }
        requireOutsideCallback('Replace the Magpie selection');
        if (!next.paths && !next.assetProjectionId) {
            selection = next;
            return unload();
        }
        if (!is.string(runtime?.helperExecutable) && !is.function(prepare)) {
            throw failure('MAGPIE_RUNTIME_UNAVAILABLE', 'Supply the prepared platform-matching Magpie helper executable.');
        }
        if (!['cpu', 'cuda'].includes(next.executionTarget?.backend)) {
            throw failure('MAGPIE_DEVICE_UNAVAILABLE', 'The native device owner must explicitly select the CPU or CUDA backend.');
        }
        if (next.assetProjectionId && !is.function(modelAssets?.retain)) {
            throw failure('MAGPIE_RESOURCES_UNAVAILABLE', 'A model projection requires the existing model-assets owner.');
        }
        const retained = next.assetProjectionId ? modelAssets.retain(next.assetProjectionId) : null;
        const predecessor = activation;
        const entry = {
            selection: next, controller: new AbortController(), retained, helper: null,
            ready: false, metadata: null, voices: null, queue: [], active: null,
            preparation: null, runtimePreparation: null, loaded: null, retirement: null
        };
        selection = next;
        activation = entry;
        state = 'loading';
        error = null;
        progress = {phase: 'loading-model'};
        const previous = predecessor ? retire(predecessor, cancellation('The Magpie selection changed.')) : Promise.resolve();
        entry.preparation = Promise.resolve().then(async function prepareActivation() {
            await previous;
            entry.controller.signal.throwIfAborted();
            entry.runtimePreparation = Promise.resolve().then(async function prepareNativeRuntime() {
                if (!is.string(runtime?.helperExecutable)) {
                    const preparedRuntime = await prepare({signal: entry.controller.signal});
                    entry.controller.signal.throwIfAborted();
                    runtime = preparedRuntime;
                }
                if (!is.string(runtime?.helperExecutable)) {
                    throw failure('MAGPIE_RUNTIME_UNAVAILABLE', 'Preparation did not supply a platform-matching Magpie helper executable.');
                }
                return runtime;
            });
            entry.runtimePreparation.catch(function observePreparationFailure() {});
            const files = selectedPaths(entry);
            const configuration = await readFile(
                path.join(files.tokenizerDirectory, 'model_config.yaml'), {encoding: 'utf8', signal: entry.controller.signal}
            );
            entry.controller.signal.throwIfAborted();
            // Read the selected model's own scalar reference, not GGUF labels or a copied voice table.
            const reference = /^speaker_map:\s*(?:"nemo:([^"\r\n]+)"|'nemo:([^'\r\n]+)'|nemo:([^\r\n]+))\s*$/mu.exec(configuration);
            if (!reference) throw failure('MAGPIE_VOICES_UNAVAILABLE', 'The selected tokenizer configuration has no supported speaker_map reference.');
            const mapPath = path.join(files.tokenizerDirectory, (reference[1] ?? reference[2] ?? reference[3]).trim());
            entry.voices = JSON.parse(await readFile(mapPath, {encoding: 'utf8', signal: entry.controller.signal}));
            const speaker = selectedVoice(entry.voices, voice);
            const preparedRuntime = await entry.runtimePreparation;
            entry.controller.signal.throwIfAborted();
            entry.helper = createMagpieHelper({runtime: preparedRuntime, paths: files, speaker, executionTarget: next.executionTarget, onEvent});
            entry.helper.completion.catch(function helperFailed(cause) {
                if (!entry.retirement) retire(entry, cause).catch(reportFailure);
            });
            entry.metadata = await entry.helper.ready;
            entry.controller.signal.throwIfAborted();
            entry.ready = true;
            if (activation === entry) {
                state = 'ready';
                progress = null;
                publish();
            }
            entry.controller.signal.throwIfAborted();
            return current();
        });
        entry.loaded = entry.preparation.catch(async function activationFailed(cause) {
            try { await retire(entry, cause); }
            catch (cleanupError) { throw combine(cause, cleanupError, 'Loading Magpie and releasing its resources failed.'); }
            throw cause;
        });
        entry.loaded.catch(reportLoadFailure);
        publish();
        return waitFor(entry.loaded, options.signal);
    }

    function selectedPaths(entry) {
        if (!entry.retained) return entry.selection.paths;
        const mapping = entry.selection.resourcePaths;
        function member(name) {
            const selected = entry.retained.members.find(function matches(record) { return record.path === name; });
            if (!selected) throw failure('MAGPIE_RESOURCES_UNAVAILABLE', `The selected projection has no member ${String(name)}.`);
            return selected.nativePath;
        }
        return {
            model: member(mapping?.model), codec: member(mapping?.codec),
            tokenizerDirectory: path.dirname(member(mapping?.tokenizerConfig))
        };
    }

    function retire(entry, reason) {
        if (entry.retirement) return entry.retirement;
        entry.ready = false;
        entry.retirement = Promise.resolve().then(async function retireActivation() {
            const failures = [];
            // Start close before joining preparation: model creation has no C-ABI abort.
            let helperClose = entry.helper?.close();
            helperClose?.catch(function observeCloseFailure() {});
            await Promise.allSettled([entry.preparation, entry.runtimePreparation]);
            helperClose ??= entry.helper?.close();
            if (helperClose) {
                try { await helperClose; }
                catch (failure) { failures.push(failure); }
            }
            if (entry.active) await entry.active.settled.promise;
            try { await entry.retained?.release(); }
            catch (failure) { failures.push(failure); }
            if (activation === entry) {
                activation = null;
                state = reason?.name === 'AbortError' ? 'unloaded' : 'error';
                error = reason?.name === 'AbortError' ? null : reason;
                if (failures.length) { state = 'error'; error = new AggregateError(failures, 'Magpie cleanup failed.'); }
                progress = null;
                publish();
            }
            if (failures.length) throw new AggregateError(failures, 'Magpie cleanup failed.');
        });
        retirements.add(entry.retirement);
        function retired() { retirements.delete(entry.retirement); }
        entry.retirement.then(retired, retired);
        entry.controller.abort(reason);
        if (activation === entry) { state = 'unloading'; progress = null; publish(); }
        return entry.retirement;
    }

    function synthesize(request, options = {}) {
        return enqueue(request, options, false);
    }

    function synthesizeStream(request, options = {}) {
        if (!is.function(options.onAudio)) throw new TypeError('Streaming Magpie synthesis requires an ordered onAudio consumer.');
        return enqueue(request, options, true);
    }

    function enqueue(request, options, streaming) {
        assertOpen(options.signal);
        if (!is.string(request?.input)) throw new TypeError('Magpie synthesis requires the complete input string.');
        representable(request.input, 'input');
        if (request.model !== undefined && request.model !== modelId) {
            throw failure('MAGPIE_MODEL_MISMATCH', 'The request selected another speech model.');
        }
        if (request.speed !== undefined && request.speed !== 1) {
            throw failure('MAGPIE_SPEED_UNAVAILABLE', 'The native Magpie API supplies its natural speaking rate only.');
        }
        const format = request.responseFormat ?? 'wav';
        if (!streaming && !['wav', 'pcm'].includes(format)) {
            throw failure('MAGPIE_FORMAT_UNAVAILABLE', `Magpie supports complete WAV or PCM output; ${String(format)} is unavailable.`);
        }
        const selectedLanguage = request.languageCode ?? request.language_code ?? languageCode;
        if (!is.string(selectedLanguage)) throw new TypeError('The selected language code must be a string.');
        representable(selectedLanguage, 'language code');
        const entry = activation;
        if (!entry?.ready || entry.controller.signal.aborted) {
            throw failure('MAGPIE_MODEL_NOT_READY', 'Load the selected Magpie model before synthesis.');
        }
        const selected = request.voice ?? voice;
        const speaker = selectedVoice(entry.voices, selected);
        const requestId = options.requestId ?? randomUUID();
        if (requests.has(requestId)) throw failure('MAGPIE_REQUEST_ACTIVE', 'That utterance request is already active or queued.');
        const controller = new AbortController();
        const operationSignal = AbortSignal.any([entry.controller.signal, controller.signal, ...(options.signal ? [options.signal] : [])]);
        const job = {
            request, requestId, voice: selected, speaker, languageCode: selectedLanguage, format, streaming,
            options, controller, signal: operationSignal, response: deferred(), settled: deferred(),
            cancel: null, failure: null
        };
        job.cancel = function cancelRequest() {
            if (entry.active !== job) {
                const position = entry.queue.indexOf(job);
                if (position >= 0) entry.queue.splice(position, 1);
                finish(entry, job, operationSignal.reason);
            }
        };
        requests.set(requestId, job);
        entry.queue.push(job);
        operationSignal.addEventListener('abort', job.cancel, {once: true});
        if (operationSignal.aborted) job.cancel();
        advance(entry);
        publish();
        return job.response.promise;
    }

    function advance(entry) {
        if (entry.active || !entry.ready || entry.controller.signal.aborted) return;
        const job = entry.queue.shift();
        if (!job) return;
        entry.active = job;
        state = 'running';
        error = null;
        progress = {phase: 'accepted'};
        job.task = Promise.resolve().then(async function generateSpeech() {
            job.signal.throwIfAborted();
            const chunks = [];
            const metadata = await entry.helper.synthesize(
                {text: job.request.input, languageCode: job.languageCode, speaker: job.speaker},
                {
                    signal: job.signal,
                    async onProgress(value) {
                        progress = value;
                        publish();
                        await deliver(job, job.options.onProgress, value);
                    },
                    async onAudio(value) {
                        job.signal.throwIfAborted();
                        if (job.streaming) await deliver(job, job.options.onAudio, {...value, requestId: job.requestId});
                        else chunks.push(value.pcm);
                    }
                }
            );
            job.signal.throwIfAborted();
            const result = {
                requestId: job.requestId, sampleRate: metadata.sampleRate, channels: 1,
                model: modelId, voice: job.voice, languageCode: job.languageCode, speed: 1
            };
            if (job.streaming) return {...result, format: 's16le', complete: true};
            const audio = job.format === 'wav' ? encodeWav(chunks, metadata.sampleRate) : Buffer.concat(chunks);
            return {...result, audioBase64: audio.toString('base64'),
                contentType: job.format === 'wav' ? 'audio/wav' : 'audio/pcm', format: job.format, sampleFormat: 's16le'};
        });
        job.task.then(
            function generated(result) { finish(entry, job, null, result); },
            function generationFailed(cause) { finish(entry, job, cause); }
        ).catch(reportFailure);
    }

    function finish(entry, job, cause, result) {
        if (!requests.has(job.requestId)) return;
        job.signal.removeEventListener('abort', job.cancel);
        requests.delete(job.requestId);
        job.failure = cause;
        if (entry.active === job) entry.active = null;
        if (cause) job.response.reject(cause);
        else job.response.resolve(result);
        job.settled.resolve();
        if (activation === entry && !entry.retirement) {
            state = entry.ready ? 'ready' : 'unloaded';
            if (cause && !job.signal.aborted) error = cause;
            progress = null;
            publish();
        }
        advance(entry);
    }

    async function stop({requestId} = {}) {
        const job = requests.get(requestId);
        if (!job) return {requestId, stopped: false};
        requireOutsideCallback('Stop this Magpie utterance', job);
        job.controller.abort(cancellation('The owning caller stopped this utterance.'));
        await job.settled.promise;
        if (job.failure && job.failure !== job.signal.reason) throw job.failure;
        return {requestId, stopped: true};
    }

    async function unload() {
        requireOutsideCallback('Unload Magpie');
        if (activation) retire(activation, cancellation('The Magpie engine is unloading.')).catch(reportFailure);
        const results = await Promise.allSettled([...retirements]);
        const failures = results.filter(function rejected(result) { return result.status === 'rejected'; })
            .map(function reason(result) { return result.reason; });
        if (failures.length) throw new AggregateError(failures, 'Unloading Magpie failed.');
        return current();
    }

    function close() {
        try { requireOutsideCallback('Close Magpie'); }
        catch (error) { return Promise.reject(error); }
        if (closing) return closing;
        closing = Promise.resolve().then(async function closeEngine() {
            try { await unload(); }
            finally {
                signal?.removeEventListener('abort', lifetimeEnded);
                state = 'disposed';
                publish();
                disposed = true;
                events.dispose();
            }
            return current();
        });
        return closing;
    }

    async function deliver(job, callback, value) {
        if (!callback) return;
        const context = {job, active: true};
        try { await callbacks.run(context, callback, value); }
        finally { context.active = false; }
    }

    function requireOutsideCallback(operation, job) {
        const context = callbacks.getStore();
        if (context?.active && (!job || context.job === job)) {
            throw failure('MAGPIE_CALLBACK_WAIT', `${operation} after the output callback returns; abort the caller-owned signal synchronously and join outside the callback.`);
        }
    }

    function lifetimeEnded() {
        // The lifetime listener owns this background join; the callback only aborts.
        callbacks.exit(function closeAfterLifetime() { close().catch(reportFailure); });
    }
    signal?.addEventListener('abort', lifetimeEnded, {once: true});
    if (signal?.aborted) lifetimeEnded();
    return {current, subscribe, load, unload, synthesize, synthesizeStream, stop, close};
}

function selectedVoice(voices, voice) {
    if (!is.string(voice)) throw new TypeError('A Magpie voice must name a voice in the selected model speaker map.');
    const name = Object.keys(voices).find(function sameVoice(candidate) { return candidate.toLowerCase() === voice.toLowerCase(); });
    const speaker = name === undefined ? undefined : voices[name];
    if (!is.integer(speaker) || speaker < 0 || speaker > 0x7fffffff) {
        throw failure('MAGPIE_VOICE_UNAVAILABLE', `The selected model has no voice ${voice}.`);
    }
    return speaker;
}

function representable(value, name) {
    if (value.includes('\0') || !value.isWellFormed()) {
        throw failure('MAGPIE_TEXT_UNREPRESENTABLE', `The public UTF-8 C string interface cannot consume this complete ${name}.`);
    }
}

function sameSelection(left, right) {
    return left.paths === right.paths && left.assetProjectionId === right.assetProjectionId
        && left.resourcePaths === right.resourcePaths && left.executionTarget === right.executionTarget;
}

function encodeWav(chunks, sampleRate) {
    const audio = Buffer.concat(chunks);
    // RIFF fields are external format framing, never synthesis admission or truncation.
    if (audio.length + 36 > 0xffffffff) {
        throw failure('MAGPIE_WAV_FORMAT_UNAVAILABLE', 'This complete audio exceeds RIFF WAV framing; select PCM or streaming output.');
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(audio.length + 36, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(audio.length, 40);
    return Buffer.concat([header, audio]);
}

function waitFor(task, signal) {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise(function waitForLoad(resolve, reject) {
        function cancel() { signal.removeEventListener('abort', cancel); reject(signal.reason); }
        signal.addEventListener('abort', cancel, {once: true});
        task.then(function loaded(result) {
            signal.removeEventListener('abort', cancel);
            if (signal.aborted) reject(signal.reason);
            else resolve(result);
        }, function failed(error) {
            signal.removeEventListener('abort', cancel);
            reject(error);
        });
    });
}

function deferred() {
    const result = {};
    result.promise = new Promise(function awaitResult(resolve, reject) { result.resolve = resolve; result.reject = reject; });
    result.promise.catch(function observeResultFailure() {});
    return result;
}

function failure(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function cancellation(message) {
    const error = failure('ARCANE_AI_REQUEST_ABORTED', message);
    error.name = 'AbortError';
    return error;
}

function combine(left, right, message) {
    return left === right ? left : new AggregateError([left, right], message, {cause: left});
}

function notify(listener, snapshot) {
    const result = listener(snapshot);
    if (result && is.function(result.then)) Promise.resolve(result).catch(reportFailure);
}

function reportFailure(error) { console.error('Magpie operation or cleanup failed.', error); }
function reportLoadFailure(error) { if (error?.name !== 'AbortError') reportFailure(error); }

export default createMagpieRuntime;
