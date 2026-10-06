import path from 'node:path';
import {PassThrough} from 'node:stream';
import {mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import Is from 'strong-type';
import {runProcess} from '../../process.mjs';
import {createArcaneEventSource} from '../../event-manager.mjs';

const is = new Is(false);

/** Retain one explicitly selected native model and transcribe complete recordings. */
export function createWhisperRuntime({runtime, prepare, modelId, temporaryDirectory, onEvent} = {}) {
    if (!runtime && !is.function(prepare)) {
        throw new TypeError('Whisper requires a prepared runtime or a prepare function.');
    }
    if (!is.string(temporaryDirectory)) {
        throw new TypeError('Whisper requires an application-owned temporaryDirectory.');
    }
    const events = createArcaneEventSource({}, {source: 'whisper', eventTypes: ['whisper.state']});
    let selected = modelId ?? runtime?.modelId ?? null;
    let state = 'unloaded';
    let error = null;
    let helper = null;
    let loading = null;
    let loadController = null;
    let active = null;
    let unloading = null;
    let closing = null;
    let disposed = false;
    let sequence = 0;

    function current() {
        return {
            providerId: 'whisper.cpp', modelId: selected, state,
            loaded: state === 'ready', busy: active !== null,
            requestedBackend: helper?.variant.backend ?? runtime?.backend ?? 'auto',
            observedBackend: helper?.metadata?.observedBackend ?? null,
            backendEvidence: helper?.metadata?.backendEvidence ?? null,
            error: error ? {code: error.code, message: error.message} : null
        };
    }

    function notify(listener, snapshot) {
        const result = listener(snapshot);
        if (result && is.function(result.then)) {
            Promise.resolve(result).catch(function listenerFailed(failure) {
                console.error('Whisper state listener failed.', failure);
            });
        }
    }

    function publish() { events.dispatch('whisper.state', current()); }

    function subscribe(listener, {replay = true, signal} = {}) {
        if (!is.function(listener)) throw new TypeError('A Whisper listener must be a function.');
        if (disposed) {
            if (replay && !signal?.aborted) notify(listener, current());
            return function disposedSubscription() {};
        }
        const unsubscribe = events.on('whisper.state', function stateChanged(event) {
            notify(listener, event.detail);
        }, {signal});
        try {
            if (replay && !signal?.aborted) notify(listener, current());
        } catch (failure) {
            unsubscribe();
            throw failure;
        }
        return unsubscribe;
    }

    function startHelper(variant, model) {
        const input = new PassThrough();
        const controller = new AbortController();
        const readiness = deferred();
        const session = {input, controller, variant, model, readiness, metadata: null,
            pending: null, stopping: false, exited: false, fragment: '', completion: null,
            observerFailure: null, failed: false};
        const library = variant.libraryDirectory ?? variant.root;
        const args = ['--model-base64', encode(model.path), '--runtime-base64', encode(library),
            '--backend', variant.backend === 'cpu' ? 'cpu' : 'gpu'];
        if (runtime.threads !== undefined) args.push('--threads', String(runtime.threads));

        async function receive({stream, chunk}) {
            if (stream !== 'stdout') return;
            session.fragment += chunk;
            let boundary = session.fragment.indexOf('\n');
            while (boundary !== -1) {
                const line = session.fragment.substring(0, boundary);
                session.fragment = session.fragment.substring(boundary + 1);
                if (line !== '') {
                    const record = JSON.parse(line);
                    const pending = session.pending;
                    if (record.type === 'ready') {
                        session.metadata = record;
                        readiness.resolve(record);
                    } else if (record.type === 'error' && !record.requestId) {
                        readiness.reject(whisperError('WHISPER_MODEL_FAILED', record.message));
                    } else if (pending && record.requestId === pending.id) {
                        if (record.type === 'complete') {
                            pending.response.resolve({text: record.text, language: record.language,
                                duration: record.duration, segments: record.segments});
                        } else if (record.type === 'cancelled') {
                            if (pending.signal.aborted) pending.response.reject(pending.signal.reason);
                            // Unexpected EOF can cancel native work while a failed
                            // observer is stopping the process. Preserve that actual
                            // failure through completion instead of inventing an abort.
                            else if (!session.observerFailure) {
                                pending.response.reject(whisperError('WHISPER_NATIVE_CANCELLED', 'Native transcription stopped without a caller cancellation.'));
                            }
                        } else if (record.type === 'error') {
                            pending.response.reject(whisperError(record.code ?? 'WHISPER_TRANSCRIPTION_FAILED', record.message));
                        } else if (!pending.signal.aborted && pending.onProgress) {
                            await pending.onProgress({...record, backend: variant.backend, attempt: pending.attempt});
                        }
                    }
                }
                boundary = session.fragment.indexOf('\n');
            }
        }

        session.completion = runProcess(variant.executable ?? runtime.helperExecutable, args, {
            env: runtimeEnvironment(library), signal: controller.signal,
            onEvent: onEvent ? async function nativeDiagnostic(event) {
                try { await onEvent(event); }
                catch (failure) { session.observerFailure = failure; throw failure; }
            } : undefined,
            input: {
                [Symbol.asyncIterator]: function helperInput() {
                    const iterator = input[Symbol.asyncIterator]();
                    return {
                        next: function nextInput() { return iterator.next(); },
                        return: function closeInput() { input.end(); return iterator.return(); }
                    };
                }
            },
            async onOutput(output) {
                try { await receive(output); }
                catch (failure) { session.observerFailure = failure; throw failure; }
            },
            captureOutput: {stdout: false, stderr: true},
            emitOutputEvents: {stdout: false, stderr: true}
        }).then(function helperExited(result) {
            if (session.fragment !== '') {
                throw whisperError('WHISPER_PROTOCOL_INCOMPLETE', 'Whisper exited during a response.', {fragment: session.fragment, result});
            }
            if (!session.stopping) {
                throw whisperError('WHISPER_HELPER_EXITED', 'The native Whisper process exited.', result);
            }
            return result;
        }).catch(function helperFailed(failure) {
            session.failed = true;
            readiness.reject(failure);
            session.pending?.response.reject(failure);
            if (helper === session && state === 'ready' && !session.stopping) {
                error = failure;
                state = 'error';
                publish();
            }
            throw failure;
        }).finally(function processDrained() {
            session.exited = true;
            input.end();
        });
        session.completion.catch(function observeHelperExit() {});
        return session;
    }

    async function stopHelper(session, {terminate = false} = {}) {
        if (!session) return;
        session.stopping = true;
        if (!session.exited) {
            if (terminate || !session.metadata) session.controller.abort();
            else {
                try { await writeCommand(session.input, 'shutdown\n'); }
                catch (failure) { session.controller.abort(failure); }
                session.input.end();
            }
        }
        try { await session.completion; }
        catch (failure) {
            if (!session.controller.signal.aborted) throw failure;
        }
    }

    function load({modelId: requested = selected, signal} = {}) {
        signal?.throwIfAborted();
        if (closing || disposed || unloading) return Promise.reject(whisperError('WHISPER_CLOSING', 'Whisper is closing.'));
        if (loading) {
            if (requested && selected && requested !== selected) {
                return Promise.reject(whisperError('WHISPER_MODEL_BUSY', 'The selected model is already loading.'));
            }
            return waitFor(loading, signal);
        }
        if (state === 'ready') {
            if (!requested || requested === selected) return Promise.resolve(current());
            return Promise.reject(whisperError('WHISPER_MODEL_LOADED', 'Unload the current model before selecting another model.'));
        }
        if (active) return Promise.reject(whisperError('WHISPER_BUSY', 'The selected model belongs to an active transcription.'));
        selected = requested;
        error = null;
        state = 'loading';
        loadController = new AbortController();
        const loadSignal = signal ? AbortSignal.any([signal, loadController.signal]) : loadController.signal;
        loading = Promise.resolve().then(async function loadSelectedModel() {
            loadSignal.throwIfAborted();
            if (!runtime) runtime = await prepare({signal: loadSignal, onEvent});
            loadSignal.throwIfAborted();
            selected ??= runtime.modelId ?? (runtime.models?.length === 1 ? runtime.models[0].id : null);
            if (!selected) {
                state = 'unloaded';
                publish();
                return current();
            }
            const model = runtime.models?.find(function selectedModel(record) { return record.id === selected; });
            if (!model) throw whisperError('WHISPER_MODEL_UNAVAILABLE', `The selected model ${selected} is not prepared.`);
            const variants = selectedVariants(runtime);
            const failures = [];
            for (const variant of variants) {
                loadSignal.throwIfAborted();
                const session = startHelper(variant, model);
                helper = session;
                function cancelLoading() { session.controller.abort(loadSignal.reason); }
                loadSignal.addEventListener('abort', cancelLoading, {once: true});
                try {
                    if (loadSignal.aborted) cancelLoading();
                    await session.readiness.promise;
                    loadSignal.throwIfAborted();
                    state = 'ready';
                    publish();
                    return current();
                } catch (failure) {
                    failures.push(failure);
                    try { await stopHelper(session, {terminate: true}); }
                    catch (exitFailure) { if (exitFailure !== failure) failures.push(exitFailure); }
                    helper = null;
                    loadSignal.throwIfAborted();
                    if (session.observerFailure || failure.code === 'WHISPER_PROTOCOL_INCOMPLETE') throw failure;
                    if (variant !== variants[variants.length - 1] && onEvent) {
                        await onEvent({type: 'whisper.backend.failed', message: failure.message,
                            data: {backend: variant.backend, error: failure}});
                    }
                } finally {
                    loadSignal.removeEventListener('abort', cancelLoading);
                }
            }
            throw new AggregateError(failures, 'The selected Whisper model could not load in the prepared runtimes.');
        }).catch(function modelLoadFailed(failure) {
            error = loadSignal.aborted ? null : failure;
            state = unloading || closing ? 'unloading' : loadSignal.aborted ? 'unloaded' : 'error';
            publish();
            throw failure;
        }).finally(function modelLoadSettled() { loading = null; loadController = null; });
        loading.catch(function observeModelLoad() {});
        publish();
        return loading;
    }

    function transcribe(request, {signal, onProgress} = {}) {
        signal?.throwIfAborted();
        if (closing || disposed || unloading) return Promise.reject(whisperError('WHISPER_CLOSING', 'Whisper is closing.'));
        if (active) return Promise.reject(whisperError('WHISPER_BUSY', 'The selected Whisper model is transcribing another recording.'));
        if (!is.string(request?.audioBase64)) throw new TypeError('Transcription requires the complete audioBase64 recording.');
        const controller = new AbortController();
        const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const operation = {controller, task: null};
        active = operation;
        operation.task = Promise.resolve().then(async function transcribeRecording() {
            operationSignal.throwIfAborted();
            await onProgress?.({phase: 'accepted'});
            if (loading) await waitFor(loading, operationSignal);
            operationSignal.throwIfAborted();
            if (state !== 'ready' || !helper) throw whisperError('WHISPER_MODEL_NOT_READY', 'Load the selected transcription model before transcribing.');
            if (request.model && request.model !== selected) {
                throw whisperError('WHISPER_MODEL_MISMATCH', `The loaded model is ${selected}; the request selected ${request.model}.`);
            }
            const initialSession = helper;
            await mkdir(temporaryDirectory, {recursive: true});
            const directory = await mkdtemp(path.join(temporaryDirectory, 'recording-'));
            try {
                const original = path.join(directory, 'recording');
                const pcm = path.join(directory, 'audio.f32le');
                await writeFile(original, Buffer.from(request.audioBase64, 'base64'), {signal: operationSignal});
                await onProgress?.({phase: 'decoding'});
                await runProcess(runtime.decoderExecutable, ['-nostdin', '-v', 'error', '-i', original,
                    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_f32le', '-f', 'f32le', pcm],
                {signal: operationSignal, onEvent});
                operationSignal.throwIfAborted();
                if (initialSession !== helper) throw whisperError('WHISPER_MODEL_CHANGED', 'The selected transcription model changed.');
                try {
                    return await infer(initialSession, pcm, request, operationSignal, onProgress, 1);
                } catch (failure) {
                    operationSignal.throwIfAborted();
                    const cpu = runtime.backend === 'auto' || !runtime.backend
                        ? runtime.variants.find(function cpuFallback(variant) { return variant.backend === 'cpu'; }) : null;
                    const nativeFailure = failure.code === 'WHISPER_INFERENCE_FAILED'
                        || (initialSession.failed && !initialSession.controller.signal.aborted && !initialSession.observerFailure
                            && failure.code !== 'WHISPER_PROTOCOL_INCOMPLETE');
                    if (!cpu || initialSession.variant.backend === 'cpu' || !nativeFailure) throw failure;
                    // A failed GPU context is fully drained before CPU owns the
                    // same complete decoded recording and exact selected model.
                    state = 'loading';
                    error = null;
                    publish();
                    try { await stopHelper(initialSession); }
                    catch (exitFailure) { if (exitFailure !== failure) failure = new AggregateError([failure, exitFailure], failure.message); }
                    operationSignal.throwIfAborted();
                    await onEvent?.({type: 'whisper.backend.failed', message: failure.message,
                        data: {backend: initialSession.variant.backend, error: failure}});
                    operationSignal.throwIfAborted();
                    const replacement = startHelper(cpu, initialSession.model);
                    helper = replacement;
                    publish();
                    function cancelFallbackLoad() { replacement.controller.abort(operationSignal.reason); }
                    operationSignal.addEventListener('abort', cancelFallbackLoad, {once: true});
                    try {
                        if (operationSignal.aborted) cancelFallbackLoad();
                        await replacement.readiness.promise;
                        operationSignal.throwIfAborted();
                        state = 'ready';
                        publish();
                    } catch (loadFailure) {
                        await Promise.allSettled([stopHelper(replacement, {terminate: true})]);
                        if (operationSignal.aborted) {
                            helper = null;
                            state = unloading || closing ? 'unloading' : 'unloaded';
                            operationSignal.throwIfAborted();
                        }
                        state = 'error';
                        error = loadFailure;
                        throw new AggregateError([failure, loadFailure], 'GPU inference and CPU model loading failed.');
                    } finally {
                        operationSignal.removeEventListener('abort', cancelFallbackLoad);
                    }
                    try { return await infer(replacement, pcm, request, operationSignal, onProgress, 2); }
                    catch (cpuFailure) {
                        operationSignal.throwIfAborted();
                        throw new AggregateError([failure, cpuFailure], 'GPU and CPU transcription failed.');
                    }
                }
            } finally {
                // Decoder completion and the helper's joined terminal record both
                // precede removal of this operation's complete recording files.
                await rm(directory, {recursive: true, force: true});
            }
        }).catch(function transcriptionFailed(failure) {
            if (state === 'loading' && (!helper || helper.stopping || helper.exited)) {
                helper = null;
                state = unloading || closing ? 'unloading' : operationSignal.aborted ? 'unloaded' : 'error';
                error = operationSignal.aborted ? null : failure;
            }
            operationSignal.throwIfAborted();
            throw failure;
        }).finally(function transcriptionSettled() {
            active = null;
            publish();
        });
        operation.task.catch(function observeTranscription() {});
        publish();
        return operation.task;
    }

    async function infer(session, pcm, request, signal, onProgress, attempt) {
        signal.throwIfAborted();
        if (session.failed) await session.completion;
        const id = String(++sequence);
        const response = deferred();
        session.pending = {id, response, signal, onProgress, attempt};
        function cancelInference() {
            writeCommand(session.input, `cancel\t${id}\n`).catch(function cancellationWriteFailed(failure) {
                session.controller.abort(failure);
            });
        }
        try {
            // Keep each request ahead of its matching cancel on this input pipe.
            await writeCommand(session.input,
                `transcribe\t${id}\t${encode(pcm)}\t${encode(request.language ?? 'auto')}\t${request.translate === true ? 1 : 0}\n`);
            signal.addEventListener('abort', cancelInference, {once: true});
            if (signal.aborted) cancelInference();
            const result = await response.promise;
            signal.throwIfAborted();
            return result;
        } catch (failure) {
            if (!response.settled) {
                session.controller.abort(failure);
                await Promise.allSettled([session.completion]);
            }
            throw failure;
        } finally {
            signal.removeEventListener('abort', cancelInference);
            session.pending = null;
        }
    }

    function unload() {
        if (unloading) return unloading;
        if (disposed) return Promise.resolve(current());
        state = 'unloading';
        unloading = Promise.resolve().then(async function unloadModel() {
            loadController?.abort();
            active?.controller.abort();
            await Promise.allSettled([loading, active?.task].filter(Boolean));
            const session = helper;
            try { await stopHelper(session); }
            finally { helper = null; }
            state = 'unloaded';
            error = null;
            return current();
        }).catch(function unloadFailed(failure) {
            state = 'error';
            error = failure;
            throw failure;
        }).finally(function unloadSettled() { unloading = null; publish(); });
        publish();
        return unloading;
    }

    function close() {
        if (closing) return closing;
        closing = Promise.resolve().then(async function closeWhisper() {
            try { await unload(); }
            finally {
                disposed = true;
                state = 'disposed';
                publish();
                events.dispose();
            }
            return current();
        });
        return closing;
    }

    return {current, subscribe, load, transcribe, unload, close};
}

function selectedVariants(runtime) {
    const variants = runtime.variants ?? [];
    if (runtime.backend && runtime.backend !== 'auto') {
        const selected = variants.filter(function selectedBackend(variant) { return variant.backend === runtime.backend; });
        if (selected.length) return selected;
    } else if (variants.length) {
        return [...variants.filter(function accelerated(variant) { return variant.backend !== 'cpu'; }),
            ...variants.filter(function cpu(variant) { return variant.backend === 'cpu'; })];
    }
    throw whisperError('WHISPER_RUNTIME_UNAVAILABLE', 'The selected Whisper runtime has no prepared backend.');
}

function runtimeEnvironment(directory) {
    const env = {...process.env};
    const key = process.platform === 'win32'
        ? Object.keys(env).find(function pathKey(name) { return name.toLowerCase() === 'path'; }) ?? 'PATH'
        : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[key] = [directory, env[key]].filter(Boolean).join(path.delimiter);
    return env;
}

function encode(value) { return Buffer.from(value, 'utf8').toString('base64'); }

function whisperError(code, message, data) {
    const error = new Error(message);
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
}

function deferred() {
    const response = {promise: null, resolve: null, reject: null, settled: false};
    response.promise = new Promise(function pending(resolve, reject) {
        response.resolve = function completed(value) { response.settled = true; resolve(value); };
        response.reject = function failed(error) { response.settled = true; reject(error); };
    });
    response.promise.catch(function observePending() {});
    return response;
}

function writeCommand(input, command) {
    return new Promise(function commandWritten(resolve, reject) {
        input.write(command, function written(error) { if (error) reject(error); else resolve(); });
    });
}

function waitFor(task, signal) {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise(function waitForOwnedTask(resolve, reject) {
        function cancelled() { signal.removeEventListener('abort', cancelled); reject(signal.reason); }
        signal.addEventListener('abort', cancelled, {once: true});
        task.then(function completed(value) {
            signal.removeEventListener('abort', cancelled);
            if (signal.aborted) reject(signal.reason);
            else resolve(value);
        }, function failed(error) { signal.removeEventListener('abort', cancelled); reject(error); });
    });
}

export default createWhisperRuntime;
