import {PassThrough} from 'node:stream';
import path from 'node:path';
import {runProcess} from '../../process.mjs';

/** One owned process drives the public ASR C ABI on its single native thread. */
export function createNemotronHelper(
    {runtime, modelPath, diarizationModelPath, gpu, onEvent}
) {
    const input = new PassThrough();
    const controller = new AbortController();
    const readiness = deferred();
    const pending = new Map();
    const running = new Set();
    let fragment = '';
    let sequence = 0;
    let writeTail = Promise.resolve();
    let stopping = false;
    let stopped = null;
    let failure = null;
    let metadata = null;
    let closingStream = null;

    function rejectPending(error) {
        const results = [];
        for (const [request, operation] of pending) {
            if (operation.results.length) {
                results.push(
                    {request, results: operation.results}
                );
            }
        }
        const completeFailure = results.length || fragment !== ''
            ? nemotronError(
                error.code ?? 'NEMOTRON_HELPER_FAILED',
                error.message ?? 'The Nemotron helper failed.',
                {cause: error, pendingResults: results, nativeFragment: fragment}
            )
            : error;
        readiness.reject(completeFailure);
        for (const operation of pending.values()) operation.response.reject(completeFailure);
        pending.clear();
        running.clear();
        return completeFailure;
    }

    function receive({stream, chunk}) {
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
                } catch (cause) {
                    throw nemotronError(
                        'NEMOTRON_PROTOCOL_UNREADABLE',
                        'The Nemotron helper returned an unreadable record.',
                        {line, cause}
                    );
                }
                if (message.ready) {
                    metadata = message;
                    readiness.resolve(message);
                } else if (message.request === 0 && message.error) {
                    const error = nemotronError('NEMOTRON_MODEL_FAILED', message.error);
                    rejectPending(error);
                } else {
                    const operation = pending.get(message.request);
                    if (!operation) {
                        throw nemotronError('NEMOTRON_PROTOCOL_UNKNOWN_REQUEST', 'The Nemotron helper returned an unknown request.', message);
                    }
                    if (message.running) {
                        running.add(message.request);
                        closingStream?.interrupt();
                    } else if (message.update) {
                        operation.results.push(message.update);
                    } else {
                        running.delete(message.request);
                        pending.delete(message.request);
                        if (message.error) {
                            operation.response.reject(
                                nemotronError(
                                    'NEMOTRON_NATIVE_FAILED',
                                    message.error,
                                    {message, results: operation.results}
                                )
                            );
                        } else {
                            operation.response.resolve(operation.results);
                        }
                    }
                }
            }
            boundary = fragment.indexOf('\n');
        }
    }

    const completion = runProcess(
        runtime.helperExecutable,
        [modelPath, diarizationModelPath ?? '', String(gpu)],
        {
            env: runtimeEnvironment(runtime),
            signal: controller.signal,
            input: {
                [Symbol.asyncIterator]: function helperInput() {
                    const iterator = input[Symbol.asyncIterator]();
                    return {
                        next: function nextInput() { return iterator.next(); },
                        return: function closeInput() {
                            input.end();
                            return iterator.return();
                        }
                    };
                }
            },
            onOutput: receive,
            captureOutput: {stdout: false, stderr: true},
            emitOutputEvents: {stdout: false, stderr: true},
            onEvent
        }
    ).then(
        function helperExited(result) {
            if (fragment !== '') {
                throw nemotronError(
                    'NEMOTRON_PROTOCOL_INCOMPLETE',
                    'The Nemotron helper exited during a record.',
                    {fragment, result}
                );
            }
            if (!stopping || pending.size !== 0 || !metadata) {
                throw nemotronError('NEMOTRON_HELPER_EXITED', 'The Nemotron helper exited before its operation completed.', result);
            }
            return result;
        }
    ).catch(
        function helperFailed(error) {
            failure = rejectPending(error);
            throw failure;
        }
    ).finally(
        function helperDrained() {
            input.end();
        }
    );
    completion.catch(
        function observeHelperFailure() {}
    );

    function send(operation, parameters = '', payload) {
        const response = deferred();
        const id = ++sequence;
        if (failure || stopping) {
            response.reject(failure ?? nemotronError('NEMOTRON_HELPER_CLOSING', 'The Nemotron helper is closing.'));
            return {response: response.promise, written: Promise.resolve()};
        }
        pending.set(
            id,
            {response, operation, results: []}
        );
        const written = writeTail.then(
            async function writeCommand() {
                if (failure) throw failure;
                await writeInput(input, `${operation} ${id}${parameters ? ` ${parameters}` : ''}\n`);
                if (payload !== undefined) await writeInput(input, payload);
            }
        );
        writeTail = written.catch(
            function commandWriteFailed(error) {
                failure = rejectPending(error);
                input.end();
                controller.abort(failure);
            }
        );
        return {response: response.promise, written};
    }

    function command(operation, parameters, payload) {
        return send(operation, parameters, payload).response;
    }

    function stop(reason) {
        if (stopped) return stopped;
        stopping = true;
        // EOF is the ordinary native shutdown path. Only a call already inside
        // the noninterruptible ABI (including model creation) needs termination.
        const noninterruptible = !metadata || running.size !== 0;
        if (noninterruptible) {
            input.end();
            controller.abort(reason);
        }
        async function stopOwnedHelper() {
            if (!noninterruptible) {
                await writeTail;
                input.end();
            }
            return completion;
        }
        stopped = stopOwnedHelper().catch(
            function stoppedHelper(error) {
                if (controller.signal.aborted && error.code === 'ARCANE_CANCELLED') {
                    return {cancelled: true, resetRequired: true, diagnostics: error};
                }
                throw error;
            }
        );
        return stopped;
    }

    async function closeStream(reason) {
        if (failure) throw failure;
        // Attempt the public stream close first. A running decode cannot read
        // that command until it returns; terminate only this owned process then.
        const closing = send('close');
        let written = false;
        let interrupted = false;
        const cancellation = {
            interrupt: function interruptActiveDecode() {
                if (!written || running.size === 0 || interrupted) return;
                interrupted = true;
                stop(reason ?? nemotronError('NEMOTRON_CANCELLED', 'The active Nemotron decode was cancelled.')).catch(
                    function observeOwnedStop() {}
                );
            }
        };
        closingStream = cancellation;
        try {
            await closing.written;
            written = true;
            cancellation.interrupt();
            try {
                await closing.response;
            } catch (error) {
                if (!interrupted) throw error;
            }
            if (interrupted) return {resetRequired: true, diagnostics: await stopped};
            return {resetRequired: false};
        } finally {
            if (closingStream === cancellation) closingStream = null;
        }
    }

    return {
        ready: readiness.promise,
        completion,
        command,
        closeStream,
        stop,
        current: function helperState() { return {metadata, failure, running: running.size !== 0, stopping}; }
    };
}

export function encodeNemotronAudio(samples) {
    // This is only the native transport's little-endian float32 framing.
    const encoded = Buffer.allocUnsafe(samples.length * 4);
    const bits = new Uint32Array(samples.buffer, samples.byteOffset, samples.length);
    for (let index = 0; index < samples.length; index++) encoded.writeUInt32LE(bits[index], index * 4);
    return encoded;
}

function runtimeEnvironment(runtime) {
    const environment = {...process.env, ...runtime.env};
    const key = process.platform === 'win32'
        ? Object.keys(environment).find(
            function pathKey(name) { return name.toLowerCase() === 'path'; }
        ) ?? 'PATH'
        : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    const directories = [runtime.binaryDirectory, runtime.libraryDirectory].filter(Boolean);
    if (directories.length) environment[key] = [...directories, environment[key]].filter(Boolean).join(path.delimiter);
    return environment;
}

function writeInput(input, value) {
    return new Promise(
        function inputWrite(resolve, reject) {
            input.write(
                value,
                function inputWritten(error) {
                    if (error) reject(error);
                    else resolve();
                }
            );
        }
    );
}

export function deferred() {
    const result = {};
    result.promise = new Promise(
        function pending(resolve, reject) {
            result.resolve = resolve;
            result.reject = reject;
        }
    );
    result.promise.catch(
        function observePendingFailure() {}
    );
    return result;
}

export function nemotronError(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    return error;
}
