import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import Is from 'strong-type';
import {CORE_PROTOCOL, CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';
import {createCoreRuntime} from './runtime.mjs';
import {createCoreFrameDecoder, encodeCoreFrame} from './stdio.mjs';
import {connectCoreSocket, createCoreSocketConnection, writeCoreSocket as write} from './socket-connection.mjs';
import {createCoreRuntimeConnection} from './runtime-connection.mjs';

const is = new Is(false);

function failure(code, message) { return new CoreError({code, message}); }
function reportError(error) { console.error('Shared Arcane Core failed:', error); }
function report(observer, error) {
    try {
        Promise.resolve(observer(error)).catch(function observerFailed(cause) { console.error(cause, error); });
    } catch (cause) { console.error(cause, error); }
}
function event(event, data) {
    return {protocol: CORE_PROTOCOL, type: 'event', event, data, time: new Date().toISOString()};
}
function response(id, result, error) {
    return {protocol: CORE_PROTOCOL, type: 'response', id,
        ...(error ? {ok: false, error: serializeCoreError(error)} : {ok: true, result}),
        time: new Date().toISOString()};
}

/** Add local IPC to an existing runtime without acquiring its lifetime. */
export async function startCoreListener({runtime, endpoint, onError = reportError} = {}) {
    if (!is.string(endpoint) || !endpoint) throw new TypeError('A Core listener endpoint must be a nonempty local pipe/socket path.');
    if (!runtime || !is.function(runtime.handle) || !is.function(runtime.onFrame)
        || !is.function(runtime.current) || !is.function(runtime.subscribe)) {
        throw new TypeError('A Core listener requires an existing Core runtime.');
    }
    if (['draining', 'closed'].includes(runtime.current().state)) throw failure('CORE_CLOSING', 'Core is closing.');
    const peers = new Set();
    const prefix = `listener-${randomUUID()}:`;
    let accepting = true;
    let closing;
    let terminalError;
    let resolveClosed;
    let rejectClosed;
    let resolveRuntimeClosed;
    const runtimeClosed = new Promise(
        function observeRuntimeClosure(resolve) { resolveRuntimeClosed = resolve; }
    );
    const closed = new Promise(
        function ownListener(resolve, reject) {
            resolveClosed = resolve;
            rejectClosed = reject;
        }
    );
    closed.catch(function observeReportedListenerFailure() {});

    function diagnostic(error) {
        report(onError, error);
    }

    function disconnect(peer) {
        if (peer.closed) return;
        peer.closed = true;
        peers.delete(peer);
        peer.connection.close().catch(diagnostic);
    }

    function send(peer, frame) {
        if (peer.closed) return;
        let content;
        try {
            content = encodeCoreFrame(frame);
        } catch (error) {
            diagnostic(error);
            peer.socket.destroy();
            return;
        }
        peer.writes = peer.writes.then(
            function writeNext() {
                if (!peer.closed) return write(peer.socket, content);
            }
        ).catch(
            function outputFailed(error) {
                diagnostic(error);
                peer.socket.destroy();
            }
        );
    }

    function accept(socket) {
        const peer = {socket, closed: false, writes: Promise.resolve(), connection: null};
        peers.add(peer);
        peer.connection = createCoreRuntimeConnection(
            {
                runtime,
                requestPrefix: prefix,
                send(frame) { send(peer, frame); }
            }
        );
        const decoder = createCoreFrameDecoder(
            function receiveFrame(frame) {
                if (peer.closed) return;
                if (!accepting && frame?.type === 'request') {
                    send(peer, response(frame.id, undefined, failure('CORE_CLOSING', 'The Core listener is closing.')));
                    return;
                }
                // No owning-host shutdown command or application dispatcher.
                peer.connection.handle(frame).catch(
                    function requestFailed(error) {
                        if (frame?.type === 'request') send(peer, response(frame.id, undefined, error));
                        else send(peer, event('core.error', serializeCoreError(error)));
                    }
                );
            }
        );
        socket.on(
            'data',
            function receiveData(chunk) {
                try {
                    decoder.push(chunk);
                } catch (error) {
                    diagnostic(error);
                    socket.destroy();
                }
            }
        );
        socket.on('error', diagnostic);
        socket.on(
            'end',
            function inputEnded() {
                try {
                    decoder.finish();
                } catch (error) {
                    diagnostic(error);
                }
                disconnect(peer);
            }
        );
        socket.on('close', function connectionClosed() { disconnect(peer); });
        socket.resume();
    }

    const server = createServer({pauseOnConnect: true}, accept);
    const binding = new Promise(
        function claimEndpoint(resolve, reject) {
            function failed(error) {
                server.off('listening', listening);
                reject(error);
            }
            function listening() {
                server.off('error', failed);
                resolve();
            }
            server.once('error', failed);
            server.once('listening', listening);
            server.listen({path: endpoint});
        }
    );

    function close() {
        if (closing) return closed;
        accepting = false;
        closing = Promise.resolve().then(
            async function closeListener() {
                try {
                    await binding;
                } catch (error) {
                    terminalError ??= error;
                }
                // Window/Core shutdown retains the endpoint through service
                // drain. Closing this listener never initiates runtime.close().
                if (runtime.current().state === 'draining') await runtimeClosed;
                const stopped = new Promise(
                    function stopListening(resolve, reject) {
                        server.close(
                            function listenerClosed(error) {
                                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                                else resolve();
                            }
                        );
                    }
                );
                stopped.catch(function observeListenerStopFailure() {});
                const connected = [...peers];
                const cancellations = await Promise.allSettled(
                    connected.map(
                        function detachConnection(peer) {
                            peer.socket.pause();
                            return peer.connection.close();
                        }
                    )
                );
                for (const outcome of cancellations) {
                    if (outcome.status === 'rejected') {
                        terminalError = terminalError
                            ? new AggregateError([terminalError, outcome.reason], 'Core listener closure failed.')
                            : outcome.reason;
                    }
                }
                await Promise.all(connected.map(function flushConnection(peer) { return peer.writes; }));
                for (const peer of connected) {
                    peer.socket.resume();
                    peer.socket.end();
                }
                await stopped;
                if (terminalError) throw terminalError;
                return {state: 'closed', endpoint};
            }
        );
        closing.then(
            function listenerClosed(result) {
                unsubscribe();
                resolveClosed(result);
            },
            function listenerFailed(error) {
                unsubscribe();
                diagnostic(error);
                rejectClosed(error);
            }
        );
        return closed;
    }

    const unsubscribe = runtime.subscribe(
        function runtimeChanged(state) {
            if (state.state === 'draining') accepting = false;
            if (state.state === 'closed') {
                resolveRuntimeClosed();
                close();
            }
        }
    );
    server.on(
        'error',
        function listenerFailed(error) {
            terminalError = error;
            close();
        }
    );
    try {
        await binding;
        if (!accepting) {
            await close();
            throw failure('CORE_CLOSING', 'Core closed while its listener was starting.');
        }
        return {endpoint, closed, close};
    } catch (error) {
        try {
            await close();
        } catch (closeError) {
            if (closeError !== error) throw new AggregateError([error, closeError], 'Core listener startup and cleanup failed.');
        }
        throw error;
    }
}

/** Claim one app-selected pipe/socket before importing or creating services. */
export async function startSharedCoreHost({
    endpoint, application, version, configure, getReplayEvents, signal, onError = reportError
} = {}) {
    signal?.throwIfAborted();
    if (typeof endpoint !== 'string' || !endpoint) throw new TypeError('A shared Core endpoint must be a nonempty local pipe/socket path.');
    const peers = new Set();
    const incoming = new Set();
    const lifetime = new AbortController();
    const prefix = `shared-${randomUUID()}:`;
    let runtime;
    let closing;
    let preparation = Promise.resolve();
    let ready = false;
    let terminalError;
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise(function ownHost(resolve, reject) { resolveClosed = resolve; rejectClosed = reject; });
    closed.catch(function observeHostFailure() {});
    function diagnostic(error) {
        report(onError, error);
    }
    function observe(task) {
        incoming.add(task);
        task.then(function completed() { incoming.delete(task); }, function failed(error) {
            incoming.delete(task);
            diagnostic(error);
        });
        return task;
    }
    function send(peer, frame) {
        if (peer.closed) return;
        let content;
        try { content = encodeCoreFrame(frame); }
        catch (error) { diagnostic(error); peer.socket.destroy(); return; }
        peer.writes = peer.writes.then(function writeNext() {
            if (!peer.closed) return write(peer.socket, content);
        }).catch(function outputFailed(error) { diagnostic(error); peer.socket.destroy(); });
    }
    function disconnect(peer) {
        if (peer.closed) return;
        peer.closed = true;
        peers.delete(peer);
        if (peer.connection) observe(peer.connection.close());
    }
    function attach(peer) {
        peer.connection = createCoreRuntimeConnection(
            {
                runtime,
                requestPrefix: prefix,
                preserveContextRequestId: false,
                getReplayEvents,
                send(frame) { send(peer, frame); },
                mapFrame(frame, record) {
                    // Preserve this owning adapter's established data correlation.
                    // The borrowed listener and stdio never apply this mapping.
                    if (record) {
                        return frame.type === 'event' && frame.data?.requestId === record.internalId
                            ? {...frame, data: {...frame.data, requestId: record.id}} : frame;
                    }
                    if (frame.event === 'core.state') {
                        return {...frame, data: {...frame.data, activeRequests: frame.data.activeRequests.map(
                            function requestState(request) {
                                const owned = peer.connection.request(request.id);
                                return owned ? {...request, id: owned.id} : request;
                            }
                        )}};
                    }
                    const id = frame.data?.requestId;
                    const owned = peer.connection.request(id);
                    if (owned) return {...frame, data: {...frame.data, requestId: owned.id}};
                    // A retired transport correlation is not a new app-wide event.
                    if (is.string(id) && id.startsWith(prefix)) return;
                    return frame;
                }
            }
        );
    }
    async function dispatch(peer, frame) {
        if (frame?.protocol !== CORE_PROTOCOL) throw failure('INVALID_RPC_REQUEST', 'Unknown Core protocol.');
        if (frame.type === 'control') {
            return peer.connection.handle(frame);
        }
        if (frame.type !== 'request' || typeof frame.id !== 'string' || !frame.id || typeof frame.method !== 'string') {
            throw failure('INVALID_RPC_REQUEST', 'A Core request requires an id and method.');
        }
        if (peer.connection.has(frame.id)) throw failure('RPC_REQUEST_ID_ACTIVE', 'The request id is already active on this connection.');
        if (frame.method === 'core.host.shutdown') {
            peer.shutdownIds.push(frame.id);
            close();
            return;
        }
        if (closing) throw failure('CORE_CLOSING', 'Core is closing.');
        return peer.connection.handle(frame);
    }
    function receive(peer, frame) {
        if (peer.closed) return;
        observe(dispatch(peer, frame).catch(function dispatchFailed(error) {
            if (frame?.type === 'request') send(peer, response(frame.id, undefined, error));
            else send(peer, event('core.error', serializeCoreError(error)));
        }));
    }
    function accept(socket) {
        const peer = {socket, connection: null, shutdownIds: [], closed: false, writes: Promise.resolve()};
        peers.add(peer);
        if (runtime) attach(peer);
        const decoder = createCoreFrameDecoder(function receiveFrame(frame) { receive(peer, frame); });
        socket.on('data', function data(chunk) {
            try { decoder.push(chunk); } catch (error) { diagnostic(error); socket.destroy(); }
        });
        socket.on('error', diagnostic);
        socket.on('end', function ended() {
            try { decoder.finish(); } catch (error) { diagnostic(error); }
            disconnect(peer);
        });
        socket.on('close', function connectionClosed() { disconnect(peer); });
        if (ready) socket.resume();
    }
    const server = createServer({pauseOnConnect: true}, accept);
    function close() {
        if (closing) return closing;
        closing = Promise.resolve().then(async function drainHost() {
            try { await preparation; } catch {}
            let error = terminalError;
            try { await runtime?.close(); } catch (cause) {
                error = error ? new AggregateError([error, cause], 'Core host shutdown failed.') : cause;
            }
            await Promise.allSettled([...incoming]);
            // Keep the endpoint claim through service drain/disposal. Releasing
            // a Unix socket sooner could start a second owner during a save.
            const stopped = new Promise(function stopListening(resolve, reject) {
                server.close(function listenerClosed(error) {
                    if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
                    else resolve();
                });
            });
            stopped.catch(function observeListenerFailure() {});
            for (const peer of peers) {
                for (const id of peer.shutdownIds) send(peer, response(id, {state: 'closed'}, error));
            }
            await Promise.all([...peers].map(function drainWrites(peer) { return peer.writes; }));
            for (const peer of peers) { peer.socket.resume(); peer.socket.end(); }
            await stopped;
            signal?.removeEventListener('abort', abortHost);
            if (error) throw error;
            return runtime?.current() ?? {state: 'closed'};
        });
        closing.then(resolveClosed, function failed(error) { diagnostic(error); rejectClosed(error); });
        lifetime.abort(failure('CORE_CLOSING', 'The shared Core host is closing.'));
        return closing;
    }
    function abortHost() { close(); }
    await new Promise(function claimEndpoint(resolve, reject) {
        function failed(error) {
            server.off('listening', listening);
            error.coreHostPhase = 'listen';
            reject(error);
        }
        function listening() { server.off('error', failed); resolve(); }
        server.once('error', failed);
        server.once('listening', listening);
        server.listen({path: endpoint});
    });
    server.on('error', function listenerFailed(error) { terminalError = error; diagnostic(error); close(); });
    try {
        // The endpoint is already owned. A losing launcher never calls configure.
        signal?.throwIfAborted();
        runtime = createCoreRuntime({application, version});
        for (const peer of peers) attach(peer);
        signal?.addEventListener('abort', abortHost, {once: true});
        preparation = Promise.resolve().then(function configureClaimedHost() {
            lifetime.signal.throwIfAborted();
            return configure?.(runtime, {signal: lifetime.signal});
        });
        if (signal?.aborted) close();
        await preparation;
        signal?.throwIfAborted();
        lifetime.signal.throwIfAborted();
        runtime.start();
        ready = true;
        for (const peer of peers) peer.socket.resume();
        if (signal?.aborted) close();
        return {runtime, endpoint, closed, close};
    } catch (error) {
        for (const peer of peers) send(peer, event('core.error', serializeCoreError(error)));
        try { await close(); } catch (closeError) { throw new AggregateError([error, closeError], 'Core startup and cleanup failed.'); }
        throw error;
    }
}

function connectSocket(endpoint, signal) {
    return connectCoreSocket(endpoint, signal, reportError);
}

// The child retains its own listener and complete diagnostic file after the
// launching client leaves. Aborting discovery never kills a shared service.
async function launch({command, args = [], cwd, env, logFile}, signal) {
    signal?.throwIfAborted();
    if (typeof logFile !== 'string' || !logFile) throw new TypeError('Headless Core launch requires a diagnostic logFile.');
    const log = await open(logFile, 'a');
    let child;
    try {
        signal?.throwIfAborted();
        child = spawn(command, args, {cwd, env, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd, 'ipc']});
        await new Promise(function awaitOwner(resolve, reject) {
            let settled = false;
            function finish(error) {
                if (settled) return;
                settled = true;
                child.off('message', message);
                child.off('error', failed);
                child.off('exit', exited);
                signal?.removeEventListener('abort', aborted);
                // Retain an error observer after relinquishing the child: a
                // startup abort can precede Node's asynchronous spawn error.
                child.on('error', reportError);
                if (child.connected) child.disconnect();
                child.unref();
                if (error) reject(error);
                else resolve();
            }
            function message(value) {
                if (value?.type !== 'arcane.shared-host.started') return;
                finish(value.error ? new CoreError(value.error) : null);
            }
            function failed(error) { finish(error); }
            function exited(code, exitSignal) {
                finish(new CoreError({code: 'CORE_HOST_START_FAILED', message: 'The headless Core exited before startup completed.', exitCode: code, signal: exitSignal, logFile}));
            }
            function aborted() { finish(signal.reason); }
            child.on('message', message);
            child.once('error', failed);
            child.once('exit', exited);
            signal?.addEventListener('abort', aborted, {once: true});
            if (signal?.aborted) aborted();
        });
    } finally { await log.close(); }
}

async function discover({endpoint, start, signal}) {
    try { return await connectSocket(endpoint, signal); }
    catch (error) {
        if (!start || !['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    }
    await launch(start, signal);
    return connectSocket(endpoint, signal);
}

function launchSelection(start) {
    return start ? {...start, args: [...(start.args ?? [])], ...(start.env ? {env: {...start.env}} : {})} : undefined;
}

/** Connect/reuse, optionally starting an explicit independent headless entry. */
export async function connectSharedCoreHost({endpoint, start, signal, onError = reportError} = {}) {
    const socket = await discover({endpoint, start: launchSelection(start), signal});
    const connection = createCoreSocketConnection({socket, endpoint, signal, onError,
        replayRuntimeState: true, name: 'shared-core', closedMessage: 'The shared Core connection closed.'});
    const {client, closed} = connection;
    return {...connection,
        async shutdown(options) {
            const result = await client.invoke('core.host.shutdown', {}, options);
            client.close();
            await closed;
            return result;
        }};
}

/** Headless entry hook: report startup to the explicit launcher, never exit. */
export async function runSharedCoreHost(options) {
    function announce(error) {
        if (!process.connected || typeof process.send !== 'function') return;
        process.send({type: 'arcane.shared-host.started', ...(error ? {error: serializeCoreError(error)} : {})},
            function sent(cause) { if (cause) report(options.onError ?? reportError, cause); });
    }
    try {
        let host;
        try { host = await startSharedCoreHost(options); }
        catch (error) {
            if (error.code !== 'EADDRINUSE' || error.coreHostPhase !== 'listen') throw error;
            const connection = await connectSharedCoreHost({endpoint: options.endpoint, onError: options.onError});
            try { await connection.client.invoke('system.ping'); }
            finally { await connection.close(); }
            announce();
            return null;
        }
        announce();
        return host;
    } catch (error) { announce(error); throw error; }
}

/** Native stdio child acts only as a connection, never as the shared owner. */
export async function startSharedCoreBridge({endpoint, start, input = process.stdin, output = process.stdout,
    signal, onError = reportError} = {}) {
    const socket = await discover({endpoint, start: launchSelection(start), signal});
    let closing;
    let outbound = Promise.resolve();
    let inbound = Promise.resolve();
    let resolveClosed;
    let rejectClosed;
    let failure;
    const closed = new Promise(function ownBridge(resolve, reject) { resolveClosed = resolve; rejectClosed = reject; });
    closed.catch(function observeBridgeFailure() {});
    function failed(error) {
        failure ??= error;
        report(onError, error);
        socket.destroy();
        close();
    }
    const fromCore = createCoreFrameDecoder(function frame(value) {
        const content = encodeCoreFrame(value);
        inbound = inbound.then(function outputFrame() { return write(output, content); });
        inbound.catch(failed);
    });
    const fromInput = createCoreFrameDecoder(function frame(value) {
        const content = encodeCoreFrame(value);
        outbound = outbound.then(function inputFrame() { return write(socket, content); });
        outbound.catch(failed);
    });
    function inputData(chunk) { try { fromInput.push(chunk); } catch (error) { failed(error); } }
    function inputEnded() { try { fromInput.finish(); } catch (error) { failed(error); } close(); }
    function outputClosed() { failed(failure ?? new CoreError({code: 'CORE_CONNECTION_CLOSED', message: 'The Core bridge output closed.'})); }
    function close() {
        if (closing) return closing;
        input.off('data', inputData);
        input.off('end', inputEnded);
        input.off('close', inputEnded);
        input.pause();
        signal?.removeEventListener('abort', close);
        closing = Promise.resolve().then(async function drainBridge() {
            await Promise.allSettled([outbound]);
            socket.end();
            if (!socket.closed) await new Promise(function waitForClose(resolve) { socket.once('close', resolve); });
            await Promise.allSettled([inbound]);
            input.off('error', failed);
            output.off('error', failed);
            output.off('close', outputClosed);
            output.off('finish', outputClosed);
            if (failure) throw failure;
        });
        closing.then(resolveClosed, rejectClosed);
        return closing;
    }
    socket.on('data', function coreData(chunk) { try { fromCore.push(chunk); } catch (error) { failed(error); } });
    socket.on('error', failed);
    socket.on('end', function coreEnded() { try { fromCore.finish(); } catch (error) { failed(error); } close(); });
    socket.on('close', close);
    input.on('data', inputData);
    input.on('error', failed);
    input.on('end', inputEnded);
    input.on('close', inputEnded);
    output.on('error', failed);
    output.on('close', outputClosed);
    output.on('finish', outputClosed);
    signal?.addEventListener('abort', close, {once: true});
    outbound = write(socket, encodeCoreFrame({protocol: CORE_PROTOCOL, type: 'control', control: 'runtime.replay'}));
    outbound.catch(failed);
    socket.resume();
    if (signal?.aborted || input.readableEnded || input.destroyed) close();
    return {endpoint, closed, close};
}
