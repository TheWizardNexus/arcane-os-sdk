import Is from 'strong-type';
import {createCoreRuntime} from '../core/runtime.mjs';
import {createLocalAIService} from '../core/services/local-ai.mjs';
import {createLocalImageService} from '../core/services/image.mjs';
import {createModelAssetService} from '../core/services/model-assets.mjs';
import {CORE_PROTOCOL, CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';
import {normalizeLocalAIConfig} from './config.mjs';
import {discoverLocalAIRuntimes} from './discover.mjs';
import {ensureLocalAIRuntimes} from './install.mjs';

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
    const opened=new Promise((resolve,reject)=>{resolveOpen=resolve;rejectOpen=reject;});
    opened.catch(()=>{});
    const transport={
        name:'development-http',
        subscribe(listener){
            receive=listener;
            events=new EventSource('/events?client='+encodeURIComponent(id));
            events.onopen=()=>resolveOpen();
            events.onmessage=event=>{
                const frame=JSON.parse(event.data);
                if(frame.type==='response')pending.delete(frame.id);
                receive(frame);
            };
            events.onerror=event=>{
                const error=new Error('The local AI development connection closed. Reload to reconnect.');
                error.code='LOCAL_AI_DEV_CONNECTION_CLOSED';
                error.event=event;
                events.close();
                rejectOpen(error);
                client?.failTransport(error);
            };
            return ()=>events.close();
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
                if(!response.ok)throw Object.assign(new Error(result.error?.message??'The local AI request failed.'),result.error);
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

/** Start local preparation without delaying the application's HTTP listener. */
export function createDevelopmentLocalAI({config, appRoot, directory, application, version, signal, onEvent} = {}) {
    const selected = normalizeLocalAIConfig(config) ?? {runtimes: []};
    const lifetime = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const sessions = new Map();
    const requestOwners = new Map();
    const streamOwners = new Map();
    const operations = new Set();
    const incoming = new Set();
    let runtime;
    let service;
    let imageService;
    let modelAssets;
    let stopFrames;
    let preparationError = null;
    let closing = null;
    let closed = false;

    function diagnostic(error) {
        if (operationSignal.aborted && (error?.name === 'AbortError' || error?.code === 'ARCANE_CANCELLED')) return;
        if (!is.function(onEvent)) {
            console.error('Local AI development failed.', error);
            return;
        }
        try {
            Promise.resolve(onEvent({type: 'local-ai.development.error', message: error.message, error: serializeCoreError(error)}))
                .catch(function observerFailed(cause) { console.error('Local AI development observer failed.', cause, error); });
        } catch (cause) { console.error('Local AI development observer failed.', cause, error); }
    }

    function sessionFor(id) {
        let session = sessions.get(id);
        if (!session) {
            session = {id, connections: new Set(), requests: new Map(), cancelledRequests: new Set()};
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
        writeFrame(connection, event('localai.state', service.current()));
        if (imageService) writeFrame(connection, event('image.state', imageService.current()));
        if (modelAssets) writeFrame(connection, event('modelAssets.state', modelAssets.current()));
    }

    const ready = Promise.resolve().then(function prepareLocalAI() {
        operationSignal.throwIfAborted();
        const localConfig = {
            ...selected,
            runtimes: selected.runtimes.filter(function selectedChatRuntime(requirement) {
                return requirement.id !== 'stable-diffusion.cpp';
            })
        };
        service = createLocalAIService(
            localConfig,
            {
                appRoot, signal: operationSignal, onEvent,
                async prepare({signal, onEvent: report}) {
                    const discovered = await discoverLocalAIRuntimes({config: localConfig, appRoot, signal});
                    const installed = await ensureLocalAIRuntimes({runtimes: discovered.missing, directory, signal, onEvent: report});
                    return [...discovered.available, ...installed];
                }
            }
        );
        const services = [service];
        if (selected.runtimes.some(function selectedImageRuntime(requirement) {
            return requirement.id === 'stable-diffusion.cpp';
        })) {
            modelAssets = createModelAssetService({appRoot});
            imageService = createLocalImageService(
                selected,
                {
                    appRoot, modelAssets, signal: operationSignal, onEvent,
                    async prepare({requirement, signal, onEvent: report}) {
                        const installed = await ensureLocalAIRuntimes(
                            {runtimes: [requirement], directory, signal, onEvent: report}
                        );
                        return installed[0];
                    }
                }
            );
            services.push(modelAssets, imageService);
        }
        runtime = createCoreRuntime({application, version, services});
        stopFrames = runtime.onFrame(routeFrame);
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
            request.controller.abort(new CoreError({code: 'LOCAL_AI_DEV_DISCONNECTED', message: 'The browser disconnected from local AI.'}));
        }
        if (!session.requests.size) sessions.delete(session.id);
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
            if (!session.connections.size && !session.requests.size) sessions.delete(session.id);
        }
    }

    async function handler(request, response) {
        const url = new URL(request.url, 'http://arcane.local');
        if (!['/rpc', '/events', '/arcane-local-ai.js'].includes(url.pathname)) return false;
        if (closed) {
            json(response, 503, {error: {code: 'LOCAL_AI_DEV_CLOSED', message: 'Local AI development is closed.'}});
            return true;
        }
        if (url.pathname === '/arcane-local-ai.js') {
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                json(response, 405, {error: {message: 'Use GET to load the local AI bootstrap.'}});
                return true;
            }
            response.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store'});
            response.end(request.method === 'HEAD' ? undefined : bootstrap);
            return true;
        }
        const clientId = url.searchParams.get('client');
        if (!clientId) {
            json(response, 400, {error: {code: 'LOCAL_AI_DEV_CLIENT_REQUIRED', message: 'Load the local AI development bootstrap before connecting.'}});
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
            response.writeHead(200, {'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive'});
            response.flushHeaders();
            ready.then(function replayReadyRuntime() { replay(connection); }, function reportPreparationFailure(error) {
                if (!connection.closed) writeFrame(connection, event('core.error', serializeCoreError(error)));
            }).catch(diagnostic);
            return true;
        }
        const controller = new AbortController();
        const rpc = {request, response, controller};
        incoming.add(rpc);
        const abortOnClose = function rpcConnectionClosed() {
            if (!response.writableEnded) controller.abort(new CoreError({code: 'LOCAL_AI_DEV_DISCONNECTED', message: 'The local AI request connection closed.'}));
        };
        response.once('close', abortOnClose);
        let frame;
        try {
            request.setEncoding('utf8');
            let body = '';
            for await (const part of request) body += part;
            frame = JSON.parse(body);
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
            response.removeListener('close', abortOnClose);
            if (!session.connections.size && !session.requests.size) sessions.delete(session.id);
        }
        return true;
    }

    function current() {
        return {state: closed ? 'closed' : preparationError ? 'error' : runtime ? 'ready' : 'preparing',
            error: preparationError ? serializeCoreError(preparationError) : null,
            core: runtime?.current() ?? null, localAI: service?.current() ?? null,
            image: imageService?.current() ?? null};
    }

    function close() {
        if (closing) return closing;
        closed = true;
        lifetime.abort();
        for (const rpc of incoming) {
            rpc.controller.abort(lifetime.signal.reason);
            rpc.request.destroy();
            rpc.response.destroy();
        }
        for (const session of sessions.values()) {
            for (const connection of [...session.connections]) {
                disconnect(connection);
                connection.response.destroy();
            }
        }
        closing = (async function closeLocalAI() {
            try { await ready; } catch {}
            try {
                await runtime?.close();
            } finally {
                await Promise.allSettled([...operations]);
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
