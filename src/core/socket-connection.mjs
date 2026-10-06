import {createConnection} from 'node:net';
import {createCoreClient} from '../../browser-runtime/core/client.mjs';
import {CoreError} from '../../browser-runtime/core/contracts.mjs';
import {createCoreFrameDecoder, encodeCoreFrame} from './stdio.mjs';

function failure(code, message) { return new CoreError({code, message}); }
function reportSocketError(error) { console.error('Arcane Core connection failed:', error); }
function report(observer, error) {
    try {
        Promise.resolve(observer(error)).catch(function observerFailed(cause) { console.error(cause, error); });
    } catch (cause) { console.error(cause, error); }
}

// Terminal events settle writes even when a destroyed stream omits its callback.
export function writeCoreSocket(output, content) {
    return new Promise(function writeFrame(resolve, reject) {
        let settled = false;
        function finish(error) {
            if (settled) return;
            settled = true;
            output.off('error', finish);
            output.off('close', closed);
            output.off('finish', closed);
            if (error) reject(error);
            else resolve();
        }
        function closed() { finish(failure('CORE_CONNECTION_CLOSED', 'The Core output closed during a write.')); }
        output.once('error', finish);
        output.once('close', closed);
        output.once('finish', closed);
        if (output.destroyed || output.writableEnded) { closed(); return; }
        try { output.write(content, finish); } catch (error) { finish(error); }
    });
}

/** Connect once and pause incoming frames until their owner is attached. */
export function connectCoreSocket(endpoint, signal, onError = reportSocketError) {
    signal?.throwIfAborted();
    if (typeof endpoint !== 'string' || !endpoint) throw new TypeError('A shared Core endpoint must be a nonempty local pipe/socket path.');
    return new Promise(function connect(resolve, reject) {
        const socket = createConnection({path: endpoint});
        socket.pause();
        function cleanup() {
            signal?.removeEventListener('abort', abort);
            socket.off('connect', connected);
            socket.off('error', failed);
        }
        function failed(error) {
            cleanup();
            socket.on('error', function connectionFailed(error) { report(onError, error); });
            socket.destroy();
            reject(error);
        }
        function abort() { failed(signal.reason); }
        function connected() { cleanup(); resolve(socket); }
        socket.once('connect', connected);
        socket.once('error', failed);
        signal?.addEventListener('abort', abort, {once: true});
        if (signal?.aborted) abort();
    });
}

/** Own one connected socket; the caller decides which RPC methods to expose. */
export function createCoreSocketConnection({socket, endpoint, signal, onError = reportSocketError,
    replayRuntimeState = false, name = 'core', closedMessage = 'The Core connection closed.'}) {
    let client;
    let receive;
    let closing = false;
    let writes = Promise.resolve();
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise(function ownConnection(resolve, reject) { resolveClosed = resolve; rejectClosed = reject; });
    closed.catch(function observeConnectionFailure() {});
    function diagnostic(error) { report(onError, error); }
    function failed(error) { client?.failTransport(error); socket.destroy(); rejectClosed(error); }
    const decoder = createCoreFrameDecoder(function frame(value) { receive(value); });
    socket.on('data', function data(chunk) { try { decoder.push(chunk); } catch (error) { failed(error); } });
    socket.on('error', failed);
    socket.on('end', function ended() {
        try { decoder.finish(); } catch (error) { failed(error); }
    });
    socket.on('close', function disconnected() {
        signal?.removeEventListener('abort', abort);
        if (!closing) client?.failTransport(failure('CORE_CONNECTION_CLOSED', closedMessage));
        resolveClosed();
    });
    const transport = {
        name,
        subscribe(listener) {
            receive = listener;
            return function disconnect() {
                closing = true;
                writes.finally(function retireSocket() { socket.end(); }).catch(diagnostic);
            };
        },
        send(frame) {
            const content = encodeCoreFrame(frame);
            writes = writes.then(function sendFrame() { return writeCoreSocket(socket, content); });
            writes.catch(failed);
            return writes;
        }
    };
    client = createCoreClient({transport, replayRuntimeState, onError: diagnostic});
    function abort() { client.close(); }
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    socket.resume();
    return {client, endpoint, closed, close: function close() { client.close(); return closed; }};
}
