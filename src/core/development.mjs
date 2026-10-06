import path from 'node:path';
import {pathToFileURL} from 'node:url';
import Is from 'strong-type';
import {createCoreRuntime} from './runtime.mjs';
import {CORE_PROTOCOL, CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';

const is = new Is(false);

// The managed application import map owns this public module's actual URL.
const bootstrap = `import {getInstalledCoreClient,installCoreClient} from 'arcane-os/core/client';
let client=getInstalledCoreClient();
const installedRuntime=client?.runtime.current();
if(installedRuntime?.connected===false&&installedRuntime.transport==='standalone'){
    client.close();
    client=null;
}
if(!client){
    globalThis.__ARCANE_DEV_HTTP__=true;
    const id=crypto.randomUUID();
    let receive;
    let events;
    let resolveOpen;
    let rejectOpen;
    const pending=new Set();
    const opened=new Promise(function ownConnection(resolve,reject){resolveOpen=resolve;rejectOpen=reject;});
    opened.catch(function observeConnectionFailure(){});
    function connectionFailed(error){
        events.close();
        rejectOpen(error);
        client?.failTransport(error);
    }
    const transport={
        name:'development-http',
        subscribe(listener){
            receive=listener;
            events=new EventSource('/events?client='+encodeURIComponent(id));
            events.onopen=function connectionOpened(){resolveOpen();};
            events.onmessage=function receiveEvent(event){
                try{
                    const frame=JSON.parse(event.data);
                    if(frame.type==='response')pending.delete(frame.id);
                    receive(frame);
                }catch(error){connectionFailed(error);}
            };
            events.onerror=function eventConnectionFailed(event){
                const error=new Error('The Core development connection closed. Reload to reconnect.');
                error.code='CORE_DEV_CONNECTION_CLOSED';
                error.event=event;
                connectionFailed(error);
            };
            return function closeEventConnection(){
                events.close();
                rejectOpen(new Error('The development Core client closed.'));
            };
        },
        async send(frame){
            if(frame.type==='request')pending.add(frame.id);
            if(frame.type==='control'&&frame.control==='requests.cancelAll')frame={...frame,requestIds:[...pending]};
            try{
                await opened;
                const response=await fetch('/rpc?client='+encodeURIComponent(id),{
                    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(frame)
                });
                const result=await response.json();
                if(!response.ok)throw Object.assign(new Error(result.error?.message??'The Core request failed.'),result.error);
                // Responses arrive after their chunks on this same SSE connection.
            }catch(error){
                if(frame.type==='request')pending.delete(frame.id);
                throw error;
            }
        }
    };
    client=installCoreClient(globalThis,{transport,replayRuntimeState:true});
}
export {client};
`;

/**
 * Compose one source-development Core without blocking page serving.
 * Application factories retain their options and their native second context.
 */
export function createDevelopmentCore({
    appRoot = process.cwd(),
    application,
    version,
    services = [],
    serviceModules = [],
    context = {},
    getReplayEvents,
    signal,
    onEvent
} = {}) {
    const lifetime = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const sessions = new Map();
    const requestOwners = new Map();
    const streamOwners = new Map();
    const operations = new Set();
    const incoming = new Set();
    let runtime;
    let stopFrames;
    let preparationError = null;
    let closing = null;
    let closed = false;

    function diagnostic(error) {
        if (operationSignal.aborted && (error?.name === 'AbortError' || error?.code === 'ARCANE_CANCELLED')) return;
        if (!is.function(onEvent)) {
            console.error('Core development failed.', error);
            return;
        }
        try {
            Promise.resolve(onEvent({type: 'core.development.error', message: error.message, error: serializeCoreError(error)}))
                .catch(function observerFailed(cause) { console.error('Core development observer failed.', cause, error); });
        } catch (cause) { console.error('Core development observer failed.', cause, error); }
    }

    function sessionFor(id) {
        let session = sessions.get(id);
        if (!session) {
            session = {id, connections: new Set(), requests: new Map(), incoming: new Set(), cancelledRequests: new Set()};
            sessions.set(id, session);
        }
        return session;
    }

    function writeFrame(connection, frame) {
        const text = `data: ${JSON.stringify(frame)}\n\n`;
        connection.writes = connection.writes.then(function writeNextFrame() {
            if (connection.closed) return;
            return new Promise(function awaitWrite(resolve, reject) {
                function finish(error) {
                    connection.response.removeListener('close', disconnected);
                    if (error) reject(error);
                    else resolve();
                }
                function disconnected() { finish(); }
                connection.response.once('close', disconnected);
                connection.response.write(text, finish);
            });
        }).catch(function streamWriteFailed(error) {
            diagnostic(error);
            connection.response.destroy(error);
        });
    }

    function sendSession(session, frame) {
        for (const connection of session.connections) writeFrame(connection, frame);
    }

    function event(event, data) {
        return {protocol: CORE_PROTOCOL, type: 'event', event, data, time: new Date().toISOString()};
    }

    function routeFrame(frame) {
        if (frame.type === 'response') {
            const owner = requestOwners.get(frame.id);
            if (owner) sendSession(owner, frame);
            return;
        }
        if (frame.type !== 'event') return;
        if (frame.data?.requestId !== undefined) {
            const owner = requestOwners.get(frame.data.requestId);
            if (owner) {
                sendSession(owner, frame);
                return;
            }
        }
        if (frame.data?.streamId !== undefined) {
            const owner = streamOwners.get(frame.data.streamId);
            if (owner) sendSession(owner, frame);
            return;
        }
        for (const session of sessions.values()) sendSession(session, frame);
    }

    function replay(connection) {
        if (!runtime || connection.closed) return;
        const current = runtime.current();
        if (current.state === 'ready') writeFrame(connection, event('core.ready', {version: current.version, app: current.application}));
        writeFrame(connection, event('core.state', current));
        for (const record of current.services) writeFrame(connection, event('core.service.state', record));
        for (const snapshot of getReplayEvents?.() ?? []) {
            writeFrame(connection, event(snapshot.event, snapshot.data));
        }
    }

    const ready = Promise.resolve().then(async function prepareApplicationCore() {
        const launchContext = {appRoot, signal: operationSignal, onEvent, ...context};
        runtime = createCoreRuntime({application, version, services});
        stopFrames = runtime.onFrame(routeFrame);
        // Accepted definitions already own resources. Register their cleanup
        // before honoring an abort, even when close precedes this microtask.
        operationSignal.throwIfAborted();
        const composed = await Promise.allSettled(
            serviceModules.map(async function loadApplicationService(selection) {
                const source = pathToFileURL(path.resolve(appRoot, selection.module));
                const imported = await import(source.href);
                operationSignal.throwIfAborted();
                const definition = await imported.default(
                    selection.options === undefined ? {} : selection.options,
                    launchContext
                );
                runtime.registerService(definition);
            })
        );
        const failures = composed.filter(function rejected(result) {
            return result.status === 'rejected';
        }).map(function cause(result) { return result.reason; });
        // Join every factory before retirement so a slower sibling cannot
        // register a service after close has disposed the prepared runtime.
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Application Core service composition failed.');
        // Register before starting so each service starts independently and a
        // method waits only for its own service, never every application service.
        operationSignal.throwIfAborted();
        runtime.start();
        return runtime;
    });
    ready.catch(function preparationFailed(error) {
        preparationError = error;
        diagnostic(error);
    });

    function waitForReady(signal) {
        const waiting = AbortSignal.any([signal, operationSignal]);
        if (waiting.aborted) return Promise.reject(waiting.reason);
        return new Promise(function awaitPreparedCore(resolve, reject) {
            function abort() {
                waiting.removeEventListener('abort', abort);
                reject(waiting.reason);
            }
            waiting.addEventListener('abort', abort, {once: true});
            ready.then(function prepared(value) {
                waiting.removeEventListener('abort', abort);
                if (waiting.aborted) reject(waiting.reason);
                else resolve(value);
            }, function failed(error) {
                waiting.removeEventListener('abort', abort);
                reject(error);
            });
        });
    }

    function observe(operation) {
        operations.add(operation);
        operation.then(function operationDone() { operations.delete(operation); }, function operationFailed() { operations.delete(operation); });
        return operation;
    }

    function cancelRequest(id) {
        if (!runtime) return;
        const task = runtime.handle({protocol: CORE_PROTOCOL, type: 'control', control: 'request.cancel', requestId: id});
        observe(task).catch(diagnostic);
    }

    function disconnect(connection) {
        if (connection.closed) return;
        connection.closed = true;
        const session = connection.session;
        session.connections.delete(connection);
        if (session.connections.size) return;
        for (const request of session.requests.values()) {
            request.controller.abort(new CoreError({code: 'CORE_DEV_DISCONNECTED', message: 'The browser disconnected from Core.'}));
        }
        for (const rpc of session.incoming) {
            rpc.controller.abort(new CoreError({code: 'CORE_DEV_DISCONNECTED', message: 'The browser disconnected from Core.'}));
            if (!rpc.received) rpc.request.destroy(rpc.controller.signal.reason);
        }
        releaseSession(session);
    }

    function releaseSession(session) {
        if (!session.connections.size && !session.requests.size && !session.incoming.size
            && sessions.get(session.id) === session) sessions.delete(session.id);
    }

    function json(response, status, value) {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
        response.end(JSON.stringify(value));
    }

    async function dispatch(frame, session, controller) {
        if (frame?.protocol !== CORE_PROTOCOL) throw new CoreError({code: 'INVALID_RPC_REQUEST', message: 'Unknown Core protocol.'});
        if (frame.type === 'control' && frame.control === 'requests.cancelAll') {
            for (const id of frame.requestIds ?? []) session.cancelledRequests.add(id);
            for (const request of session.requests.values()) {
                request.controller.abort();
            }
            return;
        }
        if (frame.type === 'control' && frame.control === 'request.cancel') {
            session.cancelledRequests.add(frame.requestId);
            const request = session.requests.get(frame.requestId);
            if (request) {
                request.controller.abort();
            }
            return;
        }
        if (frame.type !== 'request') {
            await waitForReady(controller.signal);
            controller.signal.throwIfAborted();
            operationSignal.throwIfAborted();
            if (frame.type === 'control' && frame.control === 'runtime.replay') {
                for (const connection of session.connections) replay(connection);
                return;
            }
            return runtime.handle(frame);
        }
        if (requestOwners.has(frame.id)) throw new CoreError({code: 'RPC_REQUEST_ID_ACTIVE', message: 'The request id is already active.'});
        const owned = {id: frame.id, controller};
        const streamId = frame.parameters?.streamId;
        session.requests.set(frame.id, owned);
        requestOwners.set(frame.id, session);
        if (session.cancelledRequests.delete(frame.id)) controller.abort();
        if (streamId !== undefined) streamOwners.set(streamId, session);
        function cancelled() { cancelRequest(frame.id); }
        controller.signal.addEventListener('abort', cancelled, {once: true});
        try {
            await waitForReady(controller.signal);
            controller.signal.throwIfAborted();
            operationSignal.throwIfAborted();
            return await runtime.handle(frame);
        } finally {
            controller.signal.removeEventListener('abort', cancelled);
            session.requests.delete(frame.id);
            session.cancelledRequests.delete(frame.id);
            requestOwners.delete(frame.id);
            if (streamId !== undefined) streamOwners.delete(streamId);
            releaseSession(session);
        }
    }

    async function handler(request, response) {
        const url = new URL(request.url, 'http://arcane.local');
        if (!['/rpc', '/events', '/arcane-core.js', '/arcane-local-ai.js'].includes(url.pathname)) return false;
        if (closed) {
            json(response, 503, {error: {code: 'CORE_DEV_CLOSED', message: 'Core development is closed.'}});
            return true;
        }
        if (url.pathname === '/arcane-core.js' || url.pathname === '/arcane-local-ai.js') {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                json(response, 405, {error: {message: 'Use GET to load the Core bootstrap.'}});
                return true;
            }
            response.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
            response.end(request.method === 'HEAD' ? undefined : bootstrap);
            return true;
        }
        const clientId = url.searchParams.get('client');
        if (!clientId) {
            json(response, 400, {error: {code: 'CORE_DEV_CLIENT_REQUIRED', message: 'Load the Core development bootstrap before connecting.'}});
            return true;
        }
        const method = url.pathname === '/events' ? 'GET' : 'POST';
        if (request.method !== method) {
            json(response, 405, {error: {message: `Use ${method} for ${url.pathname}.`}});
            return true;
        }
        const session = sessionFor(clientId);
        if (url.pathname === '/events') {
            const connection = {response, session, closed: false, writes: Promise.resolve()};
            session.connections.add(connection);
            response.on('close', function eventConnectionClosed() { disconnect(connection); });
            response.on('error', diagnostic);
            response.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-store',
                ...(request.httpVersionMajor === 2 ? {} : {Connection: 'keep-alive'})
            });
            response.flushHeaders();
            ready.then(function replayReadyRuntime() { replay(connection); }, function reportPreparationFailure(error) {
                if (!connection.closed) writeFrame(connection, event('core.error', serializeCoreError(error)));
            }).catch(diagnostic);
            return true;
        }
        const controller = new AbortController();
        let finishIncoming;
        const finished = new Promise(function awaitIncoming(resolve) { finishIncoming = resolve; });
        const rpc = {request, response, controller, session, finished, received: false};
        incoming.add(rpc);
        session.incoming.add(rpc);
        const abortOnClose = function rpcConnectionClosed() {
            if (!response.writableEnded) controller.abort(new CoreError({code: 'CORE_DEV_DISCONNECTED', message: 'The Core request connection closed.'}));
        };
        response.once('close', abortOnClose);
        let frame;
        try {
            request.setEncoding('utf8');
            let body = '';
            for await (const part of request) body += part;
            frame = JSON.parse(body);
            rpc.received = true;
            const result = await observe(dispatch(frame, session, controller));
            json(response, 200, result ?? {ok: true});
        } catch (error) {
            diagnostic(error);
            if (frame?.type === 'request' && frame.id) {
                const result = {protocol: CORE_PROTOCOL, type: 'response', id: frame.id, ok: false, error: serializeCoreError(error), time: new Date().toISOString()};
                sendSession(session, result);
                json(response, 200, result);
            } else json(response, 400, {error: serializeCoreError(error)});
        } finally {
            incoming.delete(rpc);
            session.incoming.delete(rpc);
            response.removeListener('close', abortOnClose);
            releaseSession(session);
            finishIncoming();
        }
        return true;
    }

    function current() {
        const core = runtime?.current() ?? null;
        return {state: closed ? 'closed' : preparationError ? 'error' : core?.state === 'ready' ? 'ready' : 'preparing',
            error: preparationError ? serializeCoreError(preparationError) : null,
            core};
    }

    function close() {
        if (closing) return closing;
        closed = true;
        lifetime.abort();
        for (const rpc of incoming) {
            rpc.controller.abort(lifetime.signal.reason);
            // An incomplete request has no accepted service work to drain.
            if (!rpc.received) rpc.request.destroy();
        }
        closing = (async function closeDevelopmentCore() {
            try { await ready; } catch {}
            try {
                await runtime?.close();
            } finally {
                await Promise.allSettled([...operations]);
                await Promise.all([...incoming].map(function finishRequest(rpc) { return rpc.finished; }));
                const connections = [...sessions.values()].flatMap(function liveConnections(session) {
                    return [...session.connections];
                });
                await Promise.all(connections.map(function drainEventWrites(connection) {
                    return connection.writes;
                }));
                for (const connection of connections) connection.response.end();
                stopFrames?.();
                sessions.clear();
                signal?.removeEventListener('abort', abortDevelopment);
            }
            return current();
        })();
        return closing;
    }

    function abortDevelopment() { close().catch(diagnostic); }
    signal?.addEventListener('abort', abortDevelopment, {once: true});
    if (signal?.aborted) abortDevelopment();
    return {ready, handler, current, close};
}
