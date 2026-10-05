import {PassThrough} from 'node:stream';
import {AsyncLocalStorage} from 'node:async_hooks';
import path from 'node:path';
import Is from 'strong-type';
import {runProcess} from '../process.mjs';
import {createArcaneEventSource} from '../event-manager.mjs';

const is = new Is(false);

/** One retained CPU model, with independently owned caller-fed audio streams. */
export function createDiarization({executable, modelPath, runtime, onEvent} = {}) {
    if (!is.string(executable) || !is.string(modelPath)) {
        throw new TypeError('Diarization requires its helper executable and selected GGUF model path.');
    }
    const input = new PassThrough();
    const streams = new Map();
    const opening = new Set();
    const callbackContext = new AsyncLocalStorage();
    const pending = new Map();
    const events = createArcaneEventSource(
        {},
        {source: 'diarization', eventTypes: ['diarization.state']}
    );
    let state = 'loading';
    let error = null;
    let metadata = null;
    let fragment = '';
    let requestId = 0;
    let streamId = 0;
    let writeTail = Promise.resolve();
    let closing = null;
    let closingRequested = false;
    let eventsDisposed = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise(function modelReadiness(resolve, reject) {
        resolveReady = resolve;
        rejectReady = reject;
    });
    // Startup starts independently. Failure stays observable through ready and
    // current state even before the first caller requests a stream.
    ready.catch(function observeReadinessFailure() {});

    function current() {
        return {state, model: 'nvidia/Nemotron-3-Diarization', modelPath, ...metadata, error};
    }

    function publish() {
        if (!eventsDisposed) events.dispatch('diarization.state', current());
    }

    function subscribe(listener, {emitCurrent = true, signal} = {}) {
        if (eventsDisposed) {
            if (emitCurrent && !signal?.aborted) listener(current());
            return function alreadyClosed() {};
        }
        function deliver(occurrence) { listener(occurrence.detail); }
        const unsubscribe = events.on('diarization.state', deliver, {signal});
        try {
            if (emitCurrent && !signal?.aborted) listener(current());
        } catch (failure) {
            unsubscribe();
            throw failure;
        }
        return unsubscribe;
    }

    function fail(failure) {
        error = error && error !== failure
            ? new AggregateError([error, failure], 'The diarization helper reported multiple failures.')
            : failure;
        state = 'error';
        rejectReady(error);
        for (const rejectStream of streams.values()) rejectStream(error);
        for (const operation of pending.values()) operation.reject(error);
        pending.clear();
        input.end();
        publish();
        return error;
    }

    async function receive({stream, chunk}) {
        if (stream !== 'stdout') return;
        fragment += chunk;
        let boundary = fragment.indexOf('\n');
        while (boundary !== -1) {
            const line = fragment.substring(0, boundary);
            fragment = fragment.substring(boundary + 1);
            if (line !== '') {
                let message;
                try {
                    message = JSON.parse(line);
                } catch (failure) {
                    const unreadable = diarizationError('DIARIZATION_PROTOCOL_UNREADABLE', 'The helper returned an unreadable response.', {line});
                    unreadable.cause = failure;
                    throw unreadable;
                }
                if (message.ready) {
                    metadata = {speakers: message.speakers, secondsPerFrame: message.secondsPerFrame};
                    if (!closingRequested) state = 'ready';
                    resolveReady(current());
                    publish();
                } else if (message.request === 0 && message.error) {
                    fail(diarizationError('DIARIZATION_MODEL_FAILED', message.error));
                } else {
                    const operation = pending.get(message.request);
                    if (!operation) throw diarizationError('DIARIZATION_PROTOCOL_UNKNOWN_REQUEST', `Unknown diarization response ${message.request}.`, message);
                    pending.delete(message.request);
                    if (message.error) {
                        operation.reject(diarizationError('DIARIZATION_NATIVE_FAILED', message.error));
                    } else {
                        operation.resolve(message.result ?? message);
                    }
                }
            }
            boundary = fragment.indexOf('\n');
        }
    }

    const processTask = runProcess(executable, [modelPath], {
        env: runtimeEnvironment(runtime),
        input: {
            [Symbol.asyncIterator]: function helperInput() {
                const iterator = input[Symbol.asyncIterator]();
                return {
                    next: function nextInput() { return iterator.next(); },
                    return: function closeInput() {
                        // Cooperate with a pending next() when the process exits
                        // unexpectedly; this producer belongs to this model.
                        input.end();
                        return iterator.return();
                    }
                };
            }
        },
        cancellationMode: 'close-input',
        onOutput: receive,
        captureOutput: {stdout: false, stderr: true},
        emitOutputEvents: {stdout: false, stderr: true},
        onEvent
    });
    const completion = processTask.then(
        function helperExited(result) {
            if (fragment !== '') {
                throw diarizationError('DIARIZATION_PROTOCOL_INCOMPLETE', 'The helper exited during a response.', fragment);
            }
            if (!closingRequested || pending.size) {
                throw diarizationError('DIARIZATION_HELPER_EXITED', 'The diarization helper exited before its work completed.', result);
            }
            state = 'closed';
            publish();
            return result;
        }
    ).catch(function helperFailed(failure) {
        throw fail(failure);
    }).finally(function disposeModelEvents() {
        eventsDisposed = true;
        events.dispose();
    });
    completion.catch(function observeHelperFailure() {});

    function request(operation, id, parameters = '', audio) {
        if (error) return Promise.reject(error);
        const idOfRequest = ++requestId;
        let resolveResponse;
        let rejectResponse;
        const response = new Promise(function nativeResponse(resolve, reject) {
            resolveResponse = resolve;
            rejectResponse = reject;
        });
        pending.set(idOfRequest, {resolve: resolveResponse, reject: rejectResponse});
        const writing = writeTail.then(async function writeCommand() {
            if (error) throw error;
            await writeInput(input, `${operation} ${idOfRequest} ${id}${parameters ? ` ${parameters}` : ''}\n`);
            if (audio) await writeInput(input, audio);
        });
        writeTail = writing.catch(function commandWriteFailed(failure) {
            pending.delete(idOfRequest);
            rejectResponse(failure);
            fail(failure);
        });
        return response;
    }

    function openStream(options) {
        const task = openOwnedStream(options);
        opening.add(task);
        function releaseOpening() { opening.delete(task); }
        task.then(releaseOpening, releaseOpening);
        return task;
    }

    async function openOwnedStream({sampleRate = 16000, onUpdate, onProbabilities, signal} = {}) {
        if (closingRequested) throw diarizationError('DIARIZATION_CLOSING', 'Diarization is closing.');
        signal?.throwIfAborted();
        if (!is.integer(sampleRate) || (sampleRate !== 0 && (sampleRate < 8000 || sampleRate > 96000))) {
            throw new TypeError('sampleRate must be 0 (model rate) or an integer from 8000 through 96000.');
        }
        if (onUpdate !== undefined && !is.function(onUpdate)) throw new TypeError('onUpdate must be a function.');
        if (onProbabilities !== undefined && !is.function(onProbabilities)) throw new TypeError('onProbabilities must be a function.');
        await ready;
        signal?.throwIfAborted();
        if (closingRequested) throw diarizationError('DIARIZATION_CLOSING', 'Diarization is closing.');
        const id = ++streamId;
        await request('open', id, `${sampleRate} ${onProbabilities ? 1 : 0}`);
        if (closingRequested || signal?.aborted) {
            await request('close', id);
            signal?.throwIfAborted();
            throw diarizationError('DIARIZATION_CLOSING', 'Diarization is closing.');
        }
        let tail = Promise.resolve();
        let stopping = null;
        let releasing = null;
        let ended = false;
        let cancelled = null;
        let latest = null;
        let completeStream;
        let failStream;
        const streamCompletion = new Promise(function streamLifetime(resolve, reject) {
            completeStream = resolve;
            failStream = reject;
        });
        streamCompletion.catch(function observeStreamFailure() {});

        function ownStop(task) {
            stopping = task;
            task.then(completeStream, failStream);
            return task;
        }

        function requireActive() {
            if (cancelled) throw cancelled;
            if (error) throw error;
            signal?.throwIfAborted();
        }

        function enqueue(operation) {
            const result = tail.then(operation);
            tail = result.then(function fulfilled() {}, function rejected() {});
            return result;
        }

        async function deliver(callback, value) {
            const delivery = {stream, active: true};
            try {
                return await callbackContext.run(delivery, callback, value);
            } finally {
                delivery.active = false;
            }
        }

        function insideCallback() {
            const delivery = callbackContext.getStore();
            return delivery?.active && delivery.stream === stream;
        }

        async function accept(result) {
            requireActive();
            if (result.ok) return latest;
            const {probabilities, ...snapshot} = result;
            if (probabilities) {
                await deliver(onProbabilities, {
                    ...probabilities, speakers: result.speakers, secondsPerFrame: result.secondsPerFrame
                });
                requireActive();
            }
            if (onUpdate) {
                await deliver(onUpdate, snapshot);
                requireActive();
            }
            latest = snapshot;
            return snapshot;
        }

        function release() {
            if (releasing) return releasing;
            releasing = (async function releaseStream() {
                signal?.removeEventListener('abort', abort);
                try {
                    await request('close', id);
                } finally {
                    streams.delete(stream);
                    ended = true;
                }
            })();
            return releasing;
        }

        function push(audio) {
            if (insideCallback()) {
                return Promise.reject(diarizationError('DIARIZATION_CALLBACK_WAIT', 'Push more audio after the output callback returns; cancel() is available inside callbacks.'));
            }
            if (!is.float32Array(audio)) return Promise.reject(new TypeError('Audio must be a mono Float32Array.'));
            if (stopping || ended) return Promise.reject(diarizationError('DIARIZATION_STREAM_CLOSED', 'The audio stream has ended.'));
            return enqueue(async function pushAudio() {
                requireActive();
                // Upstream advances on model chunks. Read results between 160 ms
                // pushes so probability history is delivered before compaction.
                const samplesPerPush = Math.round((sampleRate || 16000) * 0.16);
                for (let offset = 0; offset < audio.length; offset += samplesPerPush) {
                    requireActive();
                    const samples = audio.subarray(offset, offset + samplesPerPush);
                    const result = await request('push', id, String(samples.length), encodeAudio(samples));
                    await accept(result);
                }
                return latest;
            });
        }

        function finish() {
            if (insideCallback()) {
                return Promise.reject(diarizationError('DIARIZATION_CALLBACK_WAIT', 'Finish the stream after its output callback returns; cancel() is available inside callbacks.'));
            }
            if (stopping) return stopping;
            return ownStop(enqueue(async function finishAudio() {
                let failure;
                let result;
                try {
                    requireActive();
                    result = await accept(await request('finish', id));
                } catch (operationFailure) {
                    failure = operationFailure;
                }
                try { await release(); } catch (cleanupFailure) {
                    if (failure && failure !== cleanupFailure) throw new AggregateError([failure, cleanupFailure], 'Finishing diarization and closing its stream failed.');
                    throw cleanupFailure;
                }
                if (failure) throw failure;
                return result;
            }));
        }

        function cancel(reason) {
            if (ended) return Promise.resolve();
            cancelled ??= diarizationError('DIARIZATION_CANCELLED', 'Diarization was cancelled.', reason);
            // Close follows the already-written native call, not the caller's
            // callback/JS queue. A callback can therefore await cancel safely.
            const drained = release();
            if (!stopping) ownStop(drained);
            return drained;
        }

        function abort() {
            // The stream's completion retains a cleanup failure. Cancellation
            // of this caller never changes another stream or the shared model.
            cancel(signal.reason).catch(function observeCancellationFailure() {});
        }

        const stream = {push, finish, cancel, completion: streamCompletion, current: function streamResult() { return latest; }};
        streams.set(stream, failStream);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) {
            await cancel(signal.reason);
            signal.throwIfAborted();
        }
        return stream;
    }

    async function diarize({audio, ...options} = {}) {
        const stream = await openStream(options);
        try {
            await stream.push(audio);
            return await stream.finish();
        } catch (failure) {
            try { await stream.cancel(failure); } catch (cleanupFailure) {
                if (cleanupFailure !== failure) throw new AggregateError([failure, cleanupFailure], 'Diarization and stream cleanup failed.');
            }
            throw failure;
        }
    }

    function close() {
        if (callbackContext.getStore()?.active) {
            return Promise.reject(diarizationError('DIARIZATION_CALLBACK_WAIT', 'Close diarization after its output callback returns; stream.cancel() is available inside callbacks.'));
        }
        if (closing) return closing;
        closingRequested = true;
        state = 'closing';
        closing = (async function drainModel() {
            await Promise.allSettled([...opening]);
            const results = await Promise.allSettled([...streams.keys()].map(function finishStream(stream) {
                return stream.finish();
            }));
            await writeTail;
            input.end();
            try {
                await completion;
            } catch (failure) {
                results.push({status: 'rejected', reason: failure});
            }
            const failures = results.filter(function rejected(result) {
                return result.status === 'rejected';
            }).map(function reason(result) { return result.reason; });
            if (failures.length) throw new AggregateError(failures, 'Diarization failed while draining.');
        })();
        publish();
        return closing;
    }

    return {ready, completion, current, subscribe, openStream, diarize, close};
}

function writeInput(input, value) {
    return new Promise(function writeFrame(resolve, reject) {
        input.write(value, function inputWritten(error) {
            if (error) reject(error);
            else resolve();
        });
    });
}

function encodeAudio(samples) {
    const encoded = Buffer.allocUnsafe(samples.length * Float32Array.BYTES_PER_ELEMENT);
    const bits = new Uint32Array(samples.buffer, samples.byteOffset, samples.length);
    for (let index = 0; index < samples.length; index++) encoded.writeUInt32LE(bits[index], index * 4);
    return encoded;
}

function runtimeEnvironment(runtime) {
    if (!runtime) return undefined;
    const directories = [runtime.binaryDirectory, runtime.libraryDirectory].filter(Boolean);
    if (!directories.length) return undefined;
    const variable = process.platform === 'win32' ? 'PATH' : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    return {[variable]: [...directories, process.env[variable]].filter(Boolean).join(path.delimiter)};
}

function diarizationError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
}
