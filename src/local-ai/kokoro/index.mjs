import {randomUUID} from 'node:crypto';
import Is from 'strong-type';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';
import {createKokoroHelper} from './helper.mjs';
import {
    KOKORO_MODEL, KOKORO_REVISION, KOKORO_SAMPLE_RATE, KOKORO_VOICES,
    loadKokoroFrontend, voiceLanguage, encodeKokoroWav
} from './frontend.mjs';

export {KOKORO_MODEL, KOKORO_REVISION, KOKORO_SAMPLE_RATE, KOKORO_VOICES};

const is = new Is(false);

/** Retain one Kokoro activation using the host's existing ONNX and model-resource owners. */
export function createNativeKokoroRuntime({
    onnx, modelAssets, runtime, prepare, modelId = 'kokoro', model = KOKORO_MODEL,
    revision = KOKORO_REVISION, dtype = 'fp32', paths, assetProjectionId, resourcePaths,
    sessionOptions, executionPreference = 'gpu', executionTarget, signal, onEvent
} = {}) {
    if (!onnx && !is.function(prepare)) throw new TypeError('Kokoro requires the existing native ONNX owner or its preparation callback.');
    if (model !== KOKORO_MODEL || revision !== KOKORO_REVISION || dtype !== 'fp32') {
        throw new TypeError('This native frontend implements the selected Kokoro-82M v1.0 FP32 model and revision.');
    }
    const events = createArcaneEventSource({}, {source: 'kokoro', eventTypes: ['kokoro.state']});
    const loads = new Set();
    let selection = copySelection({assetProjectionId, resourcePaths, executionTarget});
    let activation = null;
    let pending = null;
    let releaseTask = null;
    let closing = null;
    let disposed = false;
    let state = 'unloaded';
    let error = null;
    let progress = null;
    let execution = null;

    function current() {
        return {
            providerId: 'kokoro-onnx', modelId, model, revision, dtype, state,
            loaded: Boolean(activation?.ready && !activation.controller.signal.aborted),
            busy: Boolean(pending || activation?.active || activation?.restarting),
            requestId: activation?.active?.requestId ?? null,
            queuedRequests: activation?.queue.length ?? 0,
            execution, pendingActivation: pending ? copySelection(pending.selection) : null,
            progress, error: error ? serializeCoreError(error) : null,
            defaultVoice: 'af_heart', voices: [...KOKORO_VOICES]
        };
    }

    function publish() { events.dispatch('kokoro.state', current()); }

    function notify(listener, snapshot) {
        const result = listener(snapshot);
        if (result && is.function(result.then)) Promise.resolve(result).catch(reportObserverFailure);
    }

    function subscribe(listener, {replay = true, signal: subscriptionSignal} = {}) {
        if (disposed) {
            if (replay && !subscriptionSignal?.aborted) notify(listener, current());
            return function disposedSubscription() {};
        }
        const unsubscribe = events.on('kokoro.state', function changed(event) { notify(listener, event.detail); }, {signal: subscriptionSignal});
        try { if (replay && !subscriptionSignal?.aborted) notify(listener, current()); }
        catch (failure) { unsubscribe(); throw failure; }
        return unsubscribe;
    }

    function assertOpen(operationSignal) {
        signal?.throwIfAborted();
        operationSignal?.throwIfAborted();
        if (closing || disposed) throw failure('KOKORO_CLOSED', 'The Kokoro engine is closing.');
    }

    function stop(entry, reason, terminalState = 'unloaded') {
        if (entry.release) return entry.release;
        if (activation === entry) {
            activation = null;
            state = 'unloading';
            progress = null;
            error = terminalState === 'error' ? reason : null;
        }
        // Establish ownership before abort listeners and state subscribers can reenter unload/load.
        entry.release = Promise.resolve().then(async function releaseActivation() {
            await Promise.allSettled([entry.loading, entry.restarting, entry.active?.task].filter(Boolean));
            const failures = [];
            try { await retireNative(entry, reason); }
            catch (releaseFailure) { failures.push(releaseFailure); }
            const session = onnx?.current().sessions.find(function owned(record) { return record.id === entry.id; });
            if ((!session || session.exited) && (!entry.helper || entry.helper.exited)) {
                try { await entry.retained?.release(); }
                catch (releaseFailure) { failures.push(releaseFailure); }
            }
            const cleanupError = failures.length ? joinedFailure(failures, 'Releasing Kokoro resources failed.') : null;
            if (!activation) {
                state = cleanupError ? 'error' : terminalState;
                execution = null;
                if (cleanupError) error = terminalState === 'error'
                    ? joinedFailure([reason, cleanupError], 'Kokoro activation and cleanup failed.') : cleanupError;
                try { publish(); }
                catch (observerFailure) { failures.push(observerFailure); }
            }
            if (failures.length) throw joinedFailure(failures, 'Releasing Kokoro resources failed.');
            return current();
        });
        releaseTask = entry.release;
        entry.controller.abort(reason);
        retireNative(entry, reason).catch(reportCleanupFailure);
        entry.release.catch(reportCleanupFailure);
        publish();
        return entry.release;
    }

    function retireNative(entry, reason) {
        if (entry.nativeRelease) return entry.nativeRelease;
        entry.ready = false;
        entry.nativeRelease = Promise.resolve().then(async function releaseNativeGeneration() {
            entry.unsubscribe?.();
            entry.unsubscribe = null;
            const session = onnx?.current().sessions.find(function owned(record) { return record.id === entry.id; });
            const released = await Promise.allSettled([
                session ? onnx.unload({id: entry.id}) : Promise.resolve(),
                entry.helper?.close(reason)
            ]);
            const failures = released.filter(function rejected(result) { return result.status === 'rejected'; })
                .map(function reasonOf(result) { return result.reason; });
            if (failures.length) throw joinedFailure(failures, 'Releasing the Kokoro native generation failed.');
        });
        return entry.nativeRelease;
    }

    async function startNative(entry, continuation = false) {
        entry.controller.signal.throwIfAborted();
        const previousExecution = continuation ? entry.session?.execution : null;
        const providers = previousExecution?.configuredTarget?.executionProviders;
        let target = entry.selection.executionTarget;
        let options = sessionOptions;
        if (continuation) {
            entry.id = randomUUID();
            if (previousExecution?.resolvedDevice?.deviceId) {
                target = {deviceId: previousExecution.resolvedDevice.deviceId};
            } else if (providers) {
                // Preserve the accepted provider configuration without another automatic provider search.
                target = entry.selection.executionTarget ?? undefined;
            }
            if (providers) {
                options = {...sessionOptions, executionProviders: providers};
                const primary = providers[0];
                if ((is.string(primary) ? primary : primary?.name) === 'dml') {
                    options.enableMemPattern ??= false;
                    options.executionMode ??= 'sequential';
                }
            }
        }
        entry.nativeRelease = null;
        const helper = createKokoroHelper(runtime, {onEvent});
        entry.helper = helper;
        helper.completion.catch(function unexpectedHelperExit(cause) {
            if (entry.helper === helper && !entry.nativeRelease && !entry.controller.signal.aborted && activation === entry) {
                stop(entry, cause, 'error').catch(reportCleanupFailure);
            }
        });
        entry.unsubscribe = onnx.subscribe(function observeSession(snapshot) {
            const session = snapshot.sessions.find(function owned(record) { return record.id === entry.id; });
            if (entry.nativeRelease || entry.controller.signal.aborted || !session) return;
            if (session.exited || session.stopping || (!session.loaded && (entry.ready || session.state === 'error' || session.state === 'unloaded'))) {
                stop(entry, failure('KOKORO_SESSION_UNAVAILABLE', 'The selected Kokoro ONNX session stopped.', session.error), 'error').catch(reportCleanupFailure);
            }
        });
        const tasks = [
            onnx.load({id: entry.id, model: entry.files.model, sessionOptions: options, executionPreference,
                executionTarget: target, signal: entry.controller.signal}),
            helper.ready
        ];
        try {
            const [session] = await Promise.all(tasks);
            entry.controller.signal.throwIfAborted();
            return session;
        } catch (cause) {
            const results = await Promise.allSettled([...tasks, retireNative(entry, cause)]);
            const failures = [operationFailure(cause, entry.controller.signal), ...rejectedFailures(results, entry.controller.signal)];
            throw joinedFailure(failures, 'Loading Kokoro native resources and cleanup failed.');
        }
    }

    async function requireNativeReady(entry) {
        entry.controller.signal.throwIfAborted();
        if (entry.helper.exited) {
            // Preserve the helper's original completion failure, including captured process diagnostics.
            await entry.helper.completion;
            throw failure('KOKORO_HELPER_UNAVAILABLE', 'The selected Kokoro helper stopped before activation completed.');
        }
        const session = onnx.current().sessions.find(function owned(record) { return record.id === entry.id; });
        if (!session?.loaded || session.stopping || session.exited) {
            throw failure('KOKORO_SESSION_UNAVAILABLE', 'The selected Kokoro ONNX session stopped before activation completed.', session?.error);
        }
    }

    function resume(entry) {
        if (entry.restarting) return entry.restarting;
        entry.restarting = Promise.resolve().then(async function resumeNativeGeneration() {
            await entry.nativeRelease;
            entry.controller.signal.throwIfAborted();
            assertOpen();
            if (activation !== entry) throw cancellation('The Kokoro activation changed before its next request.');
            const session = await startNative(entry, true);
            await requireNativeReady(entry);
            entry.controller.signal.throwIfAborted();
            entry.session = session;
            execution = session.execution ?? null;
            entry.ready = true;
            state = 'ready';
            progress = null;
            publish();
            entry.controller.signal.throwIfAborted();
            assertOpen();
            return current();
        });
        entry.restarting.then(function resumed() {
            entry.restarting = null;
            advance(entry);
        }, function resumeFailed(cause) {
            entry.restarting = null;
            if (!entry.release) stop(entry, cause, 'error').catch(reportCleanupFailure);
        }).catch(reportCleanupFailure);
        state = 'loading';
        progress = {phase: 'loading-model'};
        publish();
        return entry.restarting;
    }

    function preparedPaths(request) {
        if (!request.retained) return paths;
        const mapping = request.selection.resourcePaths;
        if (!mapping) throw new TypeError('A Kokoro projection requires its complete resourcePaths mapping.');
        function member(role) {
            const record = request.retained.members.find(function selected(value) { return value.path === role; });
            if (!record) throw failure('KOKORO_RESOURCE_UNAVAILABLE', `The retained Kokoro projection has no member ${String(role)}.`);
            return record.nativePath;
        }
        const files = {model: member(mapping.model), tokenizer: member(mapping.tokenizer), tokenizerConfig: member(mapping.tokenizerConfig), voices: {}};
        for (const voice of KOKORO_VOICES) files.voices[voice] = member(mapping.voices?.[voice]);
        return files;
    }

    function begin(request) {
        const files = preparedPaths(request);
        const entry = {
            id: randomUUID(), controller: new AbortController(), selection: request.selection,
            retained: request.retained, files, ready: false, helper: null, frontend: null,
            loading: null, restarting: null, nativeRelease: null, active: null, queue: [], release: null, unsubscribe: null
        };
        request.retained = null;
        request.entry = entry;
        activation = entry;
        state = 'loading';
        error = null;
        execution = null;
        progress = {phase: 'loading-model'};
        entry.loading = Promise.resolve().then(async function activate() {
            entry.controller.signal.throwIfAborted();
            // Explicit host recovery replaces a closed ONNX owner. Reacquire it
            // only after the previous activation's native retirement has joined.
            const refreshONNX = !onnx || onnx.current().closed;
            if ((refreshONNX || !runtime) && prepare) {
                const prepared = await prepare({signal: entry.controller.signal});
                entry.controller.signal.throwIfAborted();
                if (refreshONNX) onnx = prepared.onnx;
                runtime ??= prepared.runtime;
            }
            if (!onnx) throw failure('KOKORO_RUNTIME_UNAVAILABLE', 'The host has not supplied its existing ONNX runtime.');
            if (!runtime?.helperExecutable || !runtime?.espeakDataDirectory) {
                throw failure('KOKORO_RUNTIME_UNAVAILABLE', 'Prepare the native Kokoro helper and matching eSpeak data before loading.');
            }
            const tasks = [
                loadKokoroFrontend(files, {signal: entry.controller.signal}),
                startNative(entry)
            ];
            let results;
            try { results = await Promise.all(tasks); }
            catch (cause) {
                entry.controller.abort(cause);
                const results = await Promise.allSettled([...tasks, retireNative(entry, cause)]);
                const failures = [operationFailure(cause, entry.controller.signal), ...rejectedFailures(results, entry.controller.signal)];
                throw joinedFailure(failures, 'Loading the Kokoro activation and cleanup failed.');
            }
            await requireNativeReady(entry);
            entry.controller.signal.throwIfAborted();
            entry.frontend = results[0];
            entry.session = results[1];
            if (activation !== entry) throw cancellation('The Kokoro activation changed while loading.');
            execution = results[1].execution ?? null;
            entry.ready = true;
            state = 'ready';
            progress = null;
            if (pending === request) pending = null;
            publish();
            entry.controller.signal.throwIfAborted();
            assertOpen();
            return current();
        });
        entry.loading.catch(function activationFailed(cause) {
            if (!entry.release) stop(entry, cause, cause?.name === 'AbortError' ? 'unloaded' : 'error').catch(reportCleanupFailure);
        });
        publish();
        return entry.loading;
    }

    function load(options = {}) {
        assertOpen(options.signal);
        if (options.modelId !== undefined && options.modelId !== modelId) {
            throw failure('KOKORO_MODEL_MISMATCH', 'This engine owns the selected Kokoro model.');
        }
        const next = copySelection({
            assetProjectionId: Object.hasOwn(options, 'assetProjectionId') ? options.assetProjectionId : selection.assetProjectionId,
            resourcePaths: Object.hasOwn(options, 'resourcePaths') ? options.resourcePaths : selection.resourcePaths,
            executionTarget: options.executionTarget === undefined ? selection.executionTarget : options.executionTarget
        });
        if (pending && sameSelection(pending.selection, next)) return waitFor(pending.task, options.signal);
        // A closed shared owner requires the ordinary retained-resource
        // replacement path, including after a cancelled native generation.
        if (activation && sameSelection(activation.selection, next) && !pending && !onnx?.current().closed) {
            if (activation.ready) return Promise.resolve(current());
            if (activation.nativeRelease) {
                const entry = activation;
                const resumed = entry.active ? entry.active.settled.promise.then(function awaitActiveRetirement() {
                    assertOpen(options.signal);
                    if (activation !== entry) throw cancellation('The Kokoro selection changed while its active request stopped.');
                    return entry.ready ? current() : resume(entry);
                }) : resume(entry);
                return waitFor(resumed, options.signal);
            }
            if (activation.restarting) return waitFor(activation.restarting, options.signal);
        }
        if (!next.assetProjectionId && !paths) {
            selection = next;
            return activation || pending ? unload() : Promise.resolve(current());
        }
        // Acquire the incoming retain before retiring an activation of the same projection.
        const retained = next.assetProjectionId ? modelAssets.retain(next.assetProjectionId) : null;
        const previous = pending;
        const predecessor = activation;
        const request = {selection: next, retained, controller: new AbortController(), task: null, entry: null};
        selection = next;
        pending = request;
        request.task = Promise.resolve().then(async function selectActivation() {
            const failures = [];
            let value;
            try {
                if (previous) await Promise.allSettled([previous.task]);
                if (predecessor?.release) await predecessor.release;
                else if (releaseTask) await releaseTask;
                request.controller.signal.throwIfAborted();
                assertOpen();
                value = await begin(request);
            } catch (cause) {
                failures.push(cause);
                if (request.entry) {
                    try { await stop(request.entry, cause, cause?.name === 'AbortError' ? 'unloaded' : 'error'); }
                    catch (cleanupFailure) { failures.push(cleanupFailure); }
                } else if (pending === request && !request.controller.signal.aborted) {
                    state = 'error';
                    error = cause;
                }
            } finally {
                try { await request.retained?.release(); }
                catch (cleanupFailure) { failures.push(cleanupFailure); }
                finally {
                    if (pending === request && failures.length && !activation) {
                        error = joinedFailure(failures, 'Selecting the Kokoro activation and cleanup failed.');
                        state = error?.name === 'AbortError' ? 'unloaded' : 'error';
                    }
                    if (pending === request) pending = null;
                    loads.delete(request.task);
                    try { if (!disposed) publish(); }
                    catch (observerFailure) { failures.push(observerFailure); }
                }
            }
            if (failures.length) throw joinedFailure(failures, 'Selecting the Kokoro activation and cleanup failed.');
            return value;
        });
        loads.add(request.task);
        request.task.catch(reportLoadFailure);
        previous?.controller.abort(cancellation('A newer Kokoro activation was selected.'));
        if (predecessor) stop(predecessor, cancellation('The Kokoro activation is being replaced.')).catch(reportCleanupFailure);
        publish();
        return waitFor(request.task, options.signal);
    }

    function synthesize(request, {signal: operationSignal, onProgress, requestId = null} = {}) {
        assertOpen(operationSignal);
        if (!is.string(request?.input)) throw new TypeError('Kokoro synthesis requires the complete input string.');
        if (request.model !== undefined && request.model !== modelId) throw failure('KOKORO_MODEL_MISMATCH', 'The request selected a different speech model.');
        const voice = request.voice ?? 'af_heart';
        const language = voiceLanguage(voice);
        const speed = request.speed ?? 1;
        if (!is.finite(speed) || speed <= 0 || !is.finite(Math.fround(speed)) || Math.fround(speed) <= 0) {
            throw new RangeError('Kokoro speed must be a positive finite float32 value.');
        }
        const format = request.responseFormat ?? 'wav';
        if (!['wav', 'opus', 'ogg'].includes(format)) throw failure('KOKORO_FORMAT_UNSUPPORTED', `Kokoro supports WAV and Ogg Opus; ${String(format)} is unavailable.`);
        const entry = activation;
        if (!entry?.ready || entry.controller.signal.aborted) throw failure('KOKORO_MODEL_NOT_READY', 'Load the selected Kokoro model before synthesis.');
        const response = deferred();
        const requestSignal = operationSignal ? AbortSignal.any([operationSignal, entry.controller.signal]) : entry.controller.signal;
        const operation = {request, requestId, voice, language, speed, format, signal: requestSignal,
            onProgress, response, settled: deferred(), task: null, cancel: null};
        operation.cancel = function cancelRequest() {
            if (entry.active === operation) {
                // Retire the cancelled caller's native work, preserving the activation and surviving FIFO.
                retireNative(entry, requestSignal.reason).catch(reportCleanupFailure);
                if (activation === entry) {
                    state = 'unloading';
                    progress = null;
                    publish();
                }
            } else {
                const position = entry.queue.indexOf(operation);
                if (position >= 0) entry.queue.splice(position, 1);
                requestSignal.removeEventListener('abort', operation.cancel);
                response.reject(requestSignal.reason);
                operation.settled.resolve();
                if (activation === entry) publish();
            }
        };
        entry.queue.push(operation);
        requestSignal.addEventListener('abort', operation.cancel, {once: true});
        if (requestSignal.aborted) operation.cancel();
        advance(entry);
        return response.promise;
    }

    function advance(entry) {
        if (entry.active || entry.controller.signal.aborted || activation !== entry) return;
        if (!entry.ready) {
            if (entry.queue.length && !entry.restarting) resume(entry);
            return;
        }
        const operation = entry.queue.shift();
        if (!operation) return;
        entry.active = operation;
        state = 'running';
        error = null;
        operation.task = Promise.resolve().then(async function generateSpeech() {
            const requestSignal = operation.signal;
            requestSignal.throwIfAborted();
            await operation.onProgress?.({phase: 'phonemizing'});
            requestSignal.throwIfAborted();
            const clauses = await entry.helper.phonemize(operation.request.input, operation.language, {signal: requestSignal});
            const chunks = [];
            let completed = 0;
            for (const segment of entry.frontend.segments(clauses, operation.voice)) {
                requestSignal.throwIfAborted();
                await operation.onProgress?.({phase: 'synthesizing', completed, unit: 'segments'});
                requestSignal.throwIfAborted();
                const outputs = await onnx.run({id: entry.id, signal: requestSignal, feeds: {
                    input_ids: {type: 'int64', data: segment.input, dims: [1, segment.input.length]},
                    style: {type: 'float32', data: segment.style, dims: [1, 256]},
                    speed: {type: 'float32', data: Float32Array.of(operation.speed), dims: [1]}
                }});
                requestSignal.throwIfAborted();
                const waveform = outputs[entry.session.outputNames[0]];
                if (waveform?.type !== 'float32' || !(waveform.data instanceof Float32Array)) {
                    throw failure('KOKORO_OUTPUT_UNSUPPORTED', 'The selected Kokoro graph did not return its float32 waveform.', outputs);
                }
                chunks.push(waveform.data);
                completed += 1;
            }
            await operation.onProgress?.({phase: 'encoding', completed, unit: 'segments'});
            requestSignal.throwIfAborted();
            const audio = operation.format === 'wav' ? encodeKokoroWav(chunks)
                : await entry.helper.encodeOpus(chunks, {signal: requestSignal});
            requestSignal.throwIfAborted();
            return {
                audioBase64: audio.toString('base64'),
                contentType: operation.format === 'wav' ? 'audio/wav' : 'audio/ogg; codecs=opus',
                sampleRate: KOKORO_SAMPLE_RATE, channels: 1, model: modelId, voice: operation.voice,
                speed: operation.speed
            };
        });
        operation.task.then(function generated(value) { return finish(null, value); }, function generationFailed(cause) { return finish(cause); })
            .catch(reportCleanupFailure);
        async function finish(cause, value) {
            if (operation.signal.aborted) {
                cause = operationFailure(cause, operation.signal);
                retireNative(entry, operation.signal.reason).catch(reportCleanupFailure);
            } else if (cause && !entry.release && entry.helper.exited) {
                stop(entry, cause, 'error').catch(reportCleanupFailure);
            }
            // Active cancellation resolves only after native ownership has actually drained.
            try {
                await (entry.release ?? entry.nativeRelease);
                if (operation.signal.aborted) {
                    cause = operationFailure(cause, operation.signal);
                    await (entry.release ?? retireNative(entry, operation.signal.reason));
                }
            } catch (cleanupFailure) {
                cause = cause ? joinedFailure([cause, cleanupFailure], 'Synthesis and cleanup failed.') : cleanupFailure;
            }
            complete(cause);
            function complete(cause) {
                operation.signal.removeEventListener('abort', operation.cancel);
                if (entry.active === operation) entry.active = null;
                if (cause) operation.response.reject(cause);
                else operation.response.resolve(value);
                operation.settled.resolve();
                if (activation === entry) {
                    state = entry.ready ? 'ready' : 'unloaded';
                    if (cause && !operation.signal.aborted) error = cause;
                    publish();
                }
                advance(entry);
            }
        }
        publish();
    }

    function unload() {
        const reason = cancellation('The Kokoro engine is unloading.');
        pending?.controller.abort(reason);
        const entry = activation;
        if (entry) stop(entry, reason).catch(reportCleanupFailure);
        const tasks = [...loads, releaseTask].filter(Boolean);
        return Promise.allSettled(tasks).then(function unloaded(results) {
            const failures = results.filter(function failed(result) {
                return result.status === 'rejected' && result.reason?.name !== 'AbortError';
            }).map(function cause(result) { return result.reason; });
            if (failures.length) throw new AggregateError(failures, 'Unloading Kokoro failed.');
            return current();
        });
    }

    function close() {
        if (closing) return closing;
        closing = Promise.resolve().then(async function closeEngine() {
            const failures = [];
            try { await unload(); }
            catch (cleanupFailure) { failures.push(cleanupFailure); }
            finally {
                signal?.removeEventListener('abort', lifetimeEnded);
                disposed = true;
                state = 'disposed';
                try { publish(); }
                catch (observerFailure) { failures.push(observerFailure); }
                finally {
                    try { events.dispose(); }
                    catch (disposeFailure) { failures.push(disposeFailure); }
                }
            }
            if (failures.length) throw joinedFailure(failures, 'Closing Kokoro failed.');
            return current();
        });
        return closing;
    }

    function lifetimeEnded() { close().catch(reportCleanupFailure); }
    signal?.addEventListener('abort', lifetimeEnded, {once: true});
    if (signal?.aborted) lifetimeEnded();
    return {current, subscribe, load, synthesize, unload, close};
}

function sameSelection(left, right) {
    return left.assetProjectionId === right.assetProjectionId && sameResources(left.resourcePaths, right.resourcePaths)
        && (left.executionTarget === right.executionTarget
            || (left.executionTarget != null && right.executionTarget != null
                && left.executionTarget.deviceId === right.executionTarget.deviceId));
}

function copySelection(selection) {
    return {
        assetProjectionId: selection.assetProjectionId,
        resourcePaths: selection.resourcePaths ? {...selection.resourcePaths, voices: {...selection.resourcePaths.voices}} : selection.resourcePaths,
        executionTarget: selection.executionTarget == null ? selection.executionTarget : {...selection.executionTarget}
    };
}

function sameResources(left, right) {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.model === right.model && left.tokenizer === right.tokenizer && left.tokenizerConfig === right.tokenizerConfig
        && KOKORO_VOICES.every(function sameVoice(voice) { return left.voices?.[voice] === right.voices?.[voice]; });
}

function waitFor(task, signal) {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise(function waitForActivation(resolve, reject) {
        function cancel() { signal.removeEventListener('abort', cancel); reject(signal.reason); }
        signal.addEventListener('abort', cancel, {once: true});
        task.then(function loaded(value) {
            signal.removeEventListener('abort', cancel);
            if (signal.aborted) reject(signal.reason); else resolve(value);
        }, function failed(cause) { signal.removeEventListener('abort', cancel); reject(cause); });
    });
}

function deferred() {
    const response = {};
    response.promise = new Promise(function pending(resolve, reject) { response.resolve = resolve; response.reject = reject; });
    response.promise.catch(function observeResponseFailure() {});
    return response;
}

function failure(code, message, data) {
    const error = new Error(message);
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
}

function cancellation(message) {
    const error = failure('ARCANE_AI_REQUEST_ABORTED', message);
    error.name = 'AbortError';
    return error;
}

function joinedFailure(failures, message) {
    const distinct = [...new Set(failures)];
    return distinct.length === 1 ? distinct[0] : new AggregateError(distinct, message, {cause: distinct[0]});
}

function expectedCancellationOf(error, reason) {
    if (error === reason) return true;
    if (error?.name !== 'AbortError' && error?.code !== 'ARCANE_CANCELLED' && error?.code !== 'ABORT_ERR') return false;
    if (is.array(error.errors) && !error.errors.every(function expected(cause) { return expectedCancellationOf(cause, reason); })) return false;
    return error.cause !== undefined && expectedCancellationOf(error.cause, reason);
}

function operationFailure(error, signal) {
    if (!signal.aborted) return error;
    if (error === null || expectedCancellationOf(error, signal.reason)) return signal.reason;
    return joinedFailure([signal.reason, error], 'Kokoro cancellation and operation failed.');
}

function rejectedFailures(results, signal) {
    return results.filter(function rejected(result) {
        return result.status === 'rejected' && !(signal.aborted && expectedCancellationOf(result.reason, signal.reason));
    }).map(function reasonOf(result) { return result.reason; });
}

function reportCleanupFailure(error) { console.error('Kokoro cleanup failed.', error); }
function reportObserverFailure(error) { console.error('Kokoro state observer failed.', error); }
function reportLoadFailure(error) { if (error?.name !== 'AbortError') console.error('Kokoro model load failed.', error); }

export default createNativeKokoroRuntime;
