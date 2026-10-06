import {finished} from 'node:stream';
import Is from 'strong-type';
import {CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';
import {createCoreRuntimeConnection} from './runtime-connection.mjs';

const is = new Is(false);

/** Content-Length is used only for the existing native transport framing. */
export function encodeCoreFrame(frame) {
    const body = Buffer.from(JSON.stringify(frame), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export function createCoreFrameDecoder(onFrame) {
    let header = Buffer.alloc(0);
    let remaining = null;
    let parts = [];
    const utf8 = new TextDecoder('utf-8', {fatal: true});

    function push(chunk) {
        let input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        while (input.length || remaining === 0) {
            if (remaining === null) {
                header = Buffer.concat([header, input]);
                const marker = header.indexOf('\r\n\r\n');
                if (marker < 0) return;
                const match = header.subarray(0, marker).toString('ascii').match(
                    /(?:^|\r\n)Content-Length:\s*(\d+)(?:\r\n|$)/i
                );
                if (!match) throw new CoreError({code: 'IPC_LENGTH_MISSING', message: 'IPC content length is missing.'});
                remaining = Number(match[1]);
                if (!is.safeInteger(remaining) || remaining < 0) {
                    throw new CoreError({code: 'IPC_LENGTH_INVALID', message: 'IPC content length is invalid.'});
                }
                input = header.subarray(marker + 4);
                header = Buffer.alloc(0);
            }
            const consumed = Math.min(remaining, input.length);
            if (consumed) parts.push(input.subarray(0, consumed));
            input = input.subarray(consumed);
            remaining -= consumed;
            if (remaining > 0) return;
            const body = Buffer.concat(parts);
            parts = [];
            remaining = null;
            onFrame(JSON.parse(utf8.decode(body)));
        }
    }

    function finish() {
        if (header.length || remaining !== null) {
            throw new CoreError({code: 'IPC_FRAME_INCOMPLETE', message: 'IPC ended during a frame.'});
        }
    }

    return {push, finish};
}

function reportStdioError(error) {
    console.error('Arcane Core transport failed:', error);
}

/** Attach an existing runtime; EOF drains accepted service work, never exits. */
export function startCoreStdio({runtime, input = process.stdin, output = process.stdout, onError = reportStdioError}) {
    let closing = null;
    let writes = Promise.resolve();
    let outputFailed = false;
    let inputCompleted = false;
    let resolveInputCompletion;
    const inputCompletion = new Promise(function observeInputCompletion(resolve) {
        resolveInputCompletion = resolve;
    });
    const pending = new Set();
    const failures = [];
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise(
        function createClosedPromise(resolve, reject) {
            resolveClosed = resolve;
            rejectClosed = reject;
        }
    );
    // Every background error is reported to onError and retained by closed.
    closed.catch(function observeReportedTransportFailure() {});

    function report(error) {
        if (failures.includes(error)) return;
        failures.push(error);
        try { onError(error); } catch (reportError) { failures.push(reportError); }
    }

    function failOutput(error) {
        outputFailed = true;
        report(error);
        close();
    }

    function queueFrame(frame) {
        if (outputFailed) return;
        let encoded;
        try { encoded = encodeCoreFrame(frame); } catch (error) { failOutput(error); return; }
        writes = writes.then(
            function writeNextFrame() {
                if (outputFailed) return;
                return new Promise(
                    function writeFrame(resolve, reject) {
                        output.write(
                            encoded,
                            function frameWritten(error) {
                                if (error) reject(error);
                                else resolve();
                            }
                        );
                    }
                );
            }
        ).catch(failOutput);
    }

    const connection = createCoreRuntimeConnection(
        {
            runtime,
            send: queueFrame,
            mapFrame(frame) {
                if (frame.event !== 'core.state') return frame;
                return {...frame, data: {...frame.data, activeRequests: frame.data.activeRequests.map(
                    function requestState(request) {
                        const owned = connection.request(request.id);
                        return owned ? {...request, id: owned.id} : request;
                    }
                )}};
            }
        }
    );

    function receiveFrame(frame) {
        const task = connection.handle(frame);
        pending.add(task);
        task.then(
            function requestSettled() {
                pending.delete(task);
            },
            function requestFailed(error) {
                pending.delete(task);
                report(error);
                try { runtime.emit('core.error', serializeCoreError(error)); } catch (eventError) { report(eventError); }
            }
        );
    }

    const decoder = createCoreFrameDecoder(receiveFrame);

    function receiveInput(chunk) {
        try { decoder.push(chunk); } catch (error) { report(error); close(); }
    }

    function inputEnded() {
        try { decoder.finish(); } catch (error) { report(error); }
        close();
    }

    function inputFailed(error) {
        report(error);
        close();
    }

    function detachInput() {
        input.off('data', receiveInput);
        input.off('end', inputEnded);
        input.off('close', inputEnded);
        input.pause();
    }

    async function releaseTransportListeners() {
        await connection.close();
        output.off('error', failOutput);
        // destroy(error) marks a stream destroyed before its scheduled error
        // and close events. The native completion owner observes their delivery;
        // stream flags alone do not establish that pending errors were observed.
        if (input.destroyed && !inputCompleted) await inputCompletion;
        cleanupInputCompletion();
        input.off('error', inputFailed);
    }

    function close() {
        if (closing) return closed;
        detachInput();
        closing = Promise.resolve().then(
            async function drainTransport() {
                try { await runtime.close(); } catch (error) { report(error); }
                await Promise.allSettled([...pending]);
                await writes;
                await releaseTransportListeners();
                if (failures.length) rejectClosed(new AggregateError(failures, 'Core transport closed with errors.'));
                else resolveClosed(runtime.current());
            }
        );
        closing.catch(
            async function shutdownFailed(error) {
                report(error);
                await releaseTransportListeners();
                rejectClosed(new AggregateError(failures, 'Core transport shutdown failed.'));
            }
        );
        return closed;
    }

    const cleanupInputCompletion = finished(input, {readable: true, writable: false}, function inputLifecycleComplete() {
        inputCompleted = true;
        resolveInputCompletion();
    });
    input.on('data', receiveInput);
    input.on('end', inputEnded);
    input.on('close', inputEnded);
    input.on('error', inputFailed);
    output.on('error', failOutput);
    try { runtime.start(); } catch (error) { report(error); close(); }
    if (!closing) {
        if (input.errored) report(input.errored);
        if (input.readableEnded || input.destroyed) inputEnded();
        else input.resume();
    }
    return {runtime, closed, close};
}
