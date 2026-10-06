import {spawn} from 'node:child_process';
import {open} from 'node:fs/promises';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {CORE_PROTOCOL, CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';
import {createCoreRuntime} from './runtime.mjs';
import {createCoreFrameDecoder, encodeCoreFrame} from './stdio.mjs';
import {connectCoreSocket, createCoreSocketConnection, writeCoreSocket as write} from './socket-connection.mjs';

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

/** Claim one app-selected pipe/socket before importing or creating services. */
export async function startSharedCoreHost({
    endpoint, application, version, configure, getReplayEvents, signal, onError = reportError
} = {}) {
    signal?.throwIfAborted();
    if (typeof endpoint !== 'string' || !endpoint) throw new TypeError('A shared Core endpoint must be a nonempty local pipe/socket path.');
    const peers = new Set();
    const requests = new Map();
    const incoming = new Set();
    const lifetime = new AbortController();
    const prefix = `shared-${randomUUID()}:`;
    let sequence = 0;
    let runtime;
    let unsubscribe;
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
    function cancel(record) {
        observe(runtime.handle({protocol: CORE_PROTOCOL, type: 'control',
            control: 'request.cancel', requestId: record.internalId}));
    }
    function disconnect(peer) {
        if (peer.closed) return;
        peer.closed = true;
        peers.delete(peer);
        for (const record of peer.requests.values()) cancel(record);
    }
    function stateFor(peer, state) {
        return {...state, activeRequests: state.activeRequests.map(function requestState(record) {
            const owned = requests.get(record.id);
            return owned?.peer === peer ? {...record, id: owned.id} : record;
        })};
    }
    function replay(peer) {
        const state = runtime.current();
        if (state.state === 'ready') send(peer, event('core.ready', {version: state.version, app: state.application}));
        send(peer, event('core.state', stateFor(peer, state)));
        for (const service of state.services) send(peer, event('core.service.state', service));
        // Domain snapshots belong to the app/service owner, never event history.
        for (const snapshot of getReplayEvents?.() ?? []) send(peer, event(snapshot.event, snapshot.data));
    }
    function route(frame) {
        if (frame.type === 'response') {
            const record = requests.get(frame.id);
            if (record) send(record.peer, {...frame, id: record.id});
            return;
        }
        if (frame.type !== 'event') return;
        if (Object.hasOwn(frame, 'requestId')) {
            const owned = requests.get(frame.requestId);
            if (owned) send(owned.peer, {...frame, requestId: owned.id,
                data: frame.data?.requestId === owned.internalId ? {...frame.data, requestId: owned.id} : frame.data});
            return;
        }
        const id = frame.data?.requestId;
        const record = requests.get(id);
        if (record) {
            send(record.peer, {...frame, data: {...frame.data, requestId: record.id}});
            return;
        }
        // A retired transport correlation is not a new app-wide event.
        if (typeof id === 'string' && id.startsWith(prefix)) return;
        for (const peer of peers) send(peer, frame.event === 'core.state'
            ? {...frame, data: stateFor(peer, frame.data)} : frame);
    }
    async function dispatch(peer, frame) {
        if (frame?.protocol !== CORE_PROTOCOL) throw failure('INVALID_RPC_REQUEST', 'Unknown Core protocol.');
        if (frame.type === 'control') {
            if (frame.control === 'runtime.replay') { replay(peer); return; }
            if (frame.control === 'request.cancel') {
                const record = peer.requests.get(frame.requestId);
                if (record) cancel(record);
                return;
            }
            if (frame.control === 'requests.cancelAll') {
                for (const record of peer.requests.values()) cancel(record);
                return;
            }
            throw failure('INVALID_RPC_CONTROL', 'Unknown Core control.');
        }
        if (frame.type !== 'request' || typeof frame.id !== 'string' || !frame.id || typeof frame.method !== 'string') {
            throw failure('INVALID_RPC_REQUEST', 'A Core request requires an id and method.');
        }
        if (peer.requests.has(frame.id)) throw failure('RPC_REQUEST_ID_ACTIVE', 'The request id is already active on this connection.');
        if (frame.method === 'core.host.shutdown') {
            peer.shutdownIds.push(frame.id);
            close();
            return;
        }
        if (closing) throw failure('CORE_CLOSING', 'Core is closing.');
        const record = {peer, id: frame.id, internalId: `${prefix}${++sequence}`};
        peer.requests.set(record.id, record);
        requests.set(record.internalId, record);
        try {
            // Only protocol correlation changes; parameters remain untouched.
            await runtime.handle({...frame, id: record.internalId});
        } finally {
            peer.requests.delete(record.id);
            requests.delete(record.internalId);
        }
    }
    function receive(peer, frame) {
        if (peer.closed) return;
        observe(dispatch(peer, frame).catch(function dispatchFailed(error) {
            if (frame?.type === 'request') send(peer, response(frame.id, undefined, error));
            else send(peer, event('core.error', serializeCoreError(error)));
        }));
    }
    function accept(socket) {
        const peer = {socket, requests: new Map(), shutdownIds: [], closed: false, writes: Promise.resolve()};
        peers.add(peer);
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
            unsubscribe?.();
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
        unsubscribe = runtime.onFrame(route);
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
