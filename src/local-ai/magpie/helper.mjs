import path from 'node:path';
import {PassThrough} from 'node:stream';
import Is from 'strong-type';
import {runProcess} from '../../process.mjs';

const is = new Is(false);

/** One retained native synthesizer; the host owns playback and audio devices. */
export function createMagpieHelper({runtime, paths, speaker, executionTarget, onEvent}) {
    const input = new PassThrough();
    const lifetime = new AbortController();
    const readiness = deferred();
    let sequence = 0;
    let pending = null;
    let metadata = null;
    let fragment = Buffer.alloc(0);
    let frame = null;
    let writes = Promise.resolve();
    let stopping = false;
    let exited = false;
    let terminalError = null;
    let closing = null;
    const env = {...process.env};
    const directory = runtime.libraryDirectory ?? path.dirname(runtime.helperExecutable);
    const variable = process.platform === 'win32'
        ? Object.keys(env).find(function pathVariable(name) { return name.toLowerCase() === 'path'; }) ?? 'PATH'
        : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[variable] = [directory, env[variable]].filter(Boolean).join(path.delimiter);
    // The native device owner supplies the selected CUDA UUID/visible device.
    // This adapter neither invents a device ordinal nor retries on another device.
    if (executionTarget.cudaVisibleDevices !== undefined) {
        env.CUDA_VISIBLE_DEVICES = executionTarget.cudaVisibleDevices;
    }
    const iterator = input[Symbol.asyncIterator]();
    const incoming = {
        [Symbol.asyncIterator]() { return this; },
        next() { return iterator.next(); },
        return() { input.end(); return iterator.return(); }
    };
    const completion = runProcess(
        runtime.helperExecutable,
        [paths.model, paths.codec, paths.tokenizerDirectory, String(speaker), executionTarget.backend],
        {
            env, signal: lifetime.signal, input: incoming, onEvent,
            outputEncoding: {stdout: null, stderr: 'utf8'},
            captureOutput: {stdout: false, stderr: true},
            emitOutputEvents: {stdout: false, stderr: true},
            onOutput: receive
        }
    ).then(function processExited(result) {
        if (fragment.length || frame) throw failure('MAGPIE_PROTOCOL_INCOMPLETE', 'The Magpie helper exited during an output frame.');
        if (!stopping || (pending && !pending.terminal)) throw failure('MAGPIE_HELPER_EXITED', 'The Magpie helper exited before its work completed.', result);
        return result;
    }).catch(function processFailed(error) {
        terminalError = error;
        throw error;
    }).finally(function processSettled() {
        exited = true;
        input.end();
        const error = terminalError ?? failure('MAGPIE_HELPER_CLOSED', 'The Magpie helper has closed.');
        readiness.reject(error);
        pending?.response.reject(error);
    });
    completion.catch(function observeProcessFailure() {});

    async function receive({stream, chunk}) {
        if (stream !== 'stdout') return;
        fragment = fragment.length ? Buffer.concat([fragment, chunk]) : chunk;
        for (;;) {
            if (!frame) {
                const boundary = fragment.indexOf(10);
                if (boundary < 0) return;
                const [kind, id, encodedLength] = fragment.subarray(0, boundary).toString('utf8').split('\t');
                const length = Number(encodedLength);
                if (!is.safeInteger(length) || length < 0) {
                    throw failure('MAGPIE_PROTOCOL_UNREADABLE', 'The Magpie helper returned unreadable transport framing.');
                }
                frame = {kind, id, length};
                fragment = fragment.subarray(boundary + 1);
            }
            if (fragment.length < frame.length) return;
            const payload = fragment.subarray(0, frame.length);
            fragment = fragment.subarray(frame.length);
            const record = frame;
            frame = null;
            if (record.kind === 'fatal') {
                throw failure('MAGPIE_NATIVE_FAILED', payload.toString('utf8'));
            }
            if (record.kind === 'ready') {
                const sampleRate = Number(payload.toString('utf8'));
                if (!is.integer(sampleRate) || sampleRate <= 0) {
                    throw failure('MAGPIE_PROTOCOL_UNREADABLE', 'The native synthesizer returned an unreadable sample rate.');
                }
                metadata = {sampleRate, channels: 1, format: 's16le'};
                readiness.resolve(metadata);
                continue;
            }
            const operation = pending;
            if (!operation || record.id !== operation.id) {
                throw failure('MAGPIE_PROTOCOL_UNKNOWN_REQUEST', `The Magpie helper returned ${record.kind} without its active request.`);
            }
            if (record.kind === 'audio' || record.kind === 'started') {
                if (operation.signal?.aborted || operation.callbackError) continue;
                try {
                    if (record.kind === 'audio') {
                        // Awaited delivery lets runProcess pause stdout and native PCM production.
                        await operation.onAudio({pcm: Buffer.from(payload), ...metadata});
                    } else {
                        await operation.onProgress?.({phase: 'synthesizing'});
                    }
                } catch (error) {
                    operation.callbackError = error;
                    try { await writeCommand([Buffer.from(`stop\t${operation.id}\n`)]); }
                    catch (stopError) {
                        throw new AggregateError([error, stopError], 'The Magpie consumer and native cancellation failed.');
                    }
                }
            } else if (record.kind === 'error') {
                operation.terminal = true;
                const nativeError = failure('MAGPIE_NATIVE_FAILED', payload.toString('utf8'));
                const previous = operation.callbackError ?? operation.signal?.reason;
                operation.response.reject(previous
                    ? new AggregateError([previous, nativeError], 'Magpie synthesis and its consumer failed.') : nativeError);
            } else if (record.kind === 'cancelled') {
                operation.terminal = true;
                operation.response.reject(operation.callbackError ?? operation.signal?.reason
                    ?? failure('MAGPIE_SYNTHESIS_CANCELLED', 'The native synthesizer cancelled this utterance.'));
            } else if (record.kind === 'done') {
                operation.terminal = true;
                if (operation.callbackError) operation.response.reject(operation.callbackError);
                else if (operation.signal?.aborted) operation.response.reject(operation.signal.reason);
                else operation.response.resolve(metadata);
            } else {
                throw failure('MAGPIE_PROTOCOL_UNREADABLE', `The Magpie helper returned an unknown record ${record.kind}.`);
            }
        }
    }

    function writeCommand(parts) {
        const writing = writes.then(async function writeFramedCommand() {
            if (exited || lifetime.signal.aborted) throw terminalError ?? lifetime.signal.reason
                ?? failure('MAGPIE_HELPER_CLOSED', 'The Magpie helper has closed.');
            for (const part of parts) {
                await new Promise(function writeInput(resolve, reject) {
                    input.write(part, function inputWritten(error) {
                        if (error) reject(error);
                        else resolve();
                    });
                });
            }
        });
        writes = writing.catch(function commandFailed(error) {
            // Incomplete framing cannot be reused. Retire only this owned process.
            terminalError = error;
            stopping = true;
            lifetime.abort(error);
        });
        return writing;
    }

    async function synthesize({text, languageCode, speaker: selectedSpeaker}, {signal, onAudio, onProgress} = {}) {
        signal?.throwIfAborted();
        await readiness.promise;
        signal?.throwIfAborted();
        if (stopping || exited || pending) {
            throw terminalError ?? failure('MAGPIE_HELPER_UNAVAILABLE', 'The Magpie helper is unavailable for another utterance.');
        }
        const operation = {
            id: String(++sequence), response: deferred(), signal, onAudio, onProgress, callbackError: null, terminal: false
        };
        pending = operation;
        function stopUtterance() {
            writeCommand([Buffer.from(`stop\t${operation.id}\n`)]).catch(function stopFailed(error) {
                terminalError = error;
            });
        }
        const language = Buffer.from(languageCode, 'utf8');
        const content = Buffer.from(text, 'utf8');
        try {
            // Install cancellation after enqueueing the complete text frame, so a
            // concurrent stop cannot precede its own native synthesis command.
            const writing = writeCommand([
                Buffer.from(`synthesize\t${operation.id}\t${selectedSpeaker}\t${language.length}\t${content.length}\n`),
                language, content
            ]);
            signal?.addEventListener('abort', stopUtterance, {once: true});
            if (signal?.aborted) stopUtterance();
            await writing;
            return await operation.response.promise;
        } catch (error) {
            if (lifetime.signal.aborted || exited) {
                try { await completion; }
                catch (processError) {
                    if (processError !== error) throw new AggregateError([error, processError], 'Magpie synthesis and process cleanup failed.');
                }
            }
            throw error;
        } finally {
            signal?.removeEventListener('abort', stopUtterance);
            if (pending === operation) pending = null;
        }
    }

    function close() {
        if (closing) return closing;
        stopping = true;
        closing = Promise.resolve().then(async function closeHelper() {
            if (!exited) {
                if (!metadata) {
                    // No C-ABI cancellation exists during model creation.
                    lifetime.abort(failure('MAGPIE_LOADING_CANCELLED', 'The Magpie model load was cancelled.'));
                } else {
                    await writeCommand([Buffer.from('close\t0\n')]);
                    input.end();
                }
            }
            try { await completion; }
            catch (error) {
                if (!expectedCancellation(error, lifetime.signal)) throw error;
            }
        });
        return closing;
    }

    return {
        ready: readiness.promise, completion, synthesize, close,
        get exited() { return exited; }
    };
}

function deferred() {
    const value = {};
    value.promise = new Promise(function awaitResponse(resolve, reject) {
        value.resolve = resolve;
        value.reject = reject;
    });
    value.promise.catch(function observePendingFailure() {});
    return value;
}

function failure(code, message, data) {
    const error = new Error(message);
    error.code = code;
    if (data !== undefined) error.data = data;
    return error;
}

function expectedCancellation(error, signal) {
    if (!signal.aborted) return false;
    if (error === signal.reason) return true;
    if (!['ARCANE_CANCELLED', 'ABORT_ERR'].includes(error?.code) && error?.name !== 'AbortError') return false;
    if (is.array(error.errors) && !error.errors.every(function cancelled(cause) { return expectedCancellation(cause, signal); })) return false;
    return error.cause !== undefined && expectedCancellation(error.cause, signal);
}
