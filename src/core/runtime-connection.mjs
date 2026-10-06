import {randomUUID} from 'node:crypto';
import Is from 'strong-type';
import {CORE_PROTOCOL, CoreError, serializeCoreError} from '../../browser-runtime/core/contracts.mjs';

const is = new Is(false);
const owners = new WeakMap();

function failure(code, message) {
    return new CoreError({code, message});
}

function event(event, data) {
    return {protocol: CORE_PROTOCOL, type: 'event', event, data, time: new Date().toISOString()};
}

function runtimeConnections(runtime) {
    const existing = owners.get(runtime);
    if (existing) return existing;
    const connections = new Set();
    const requests = new Map();
    const prefix = `connection-${randomUUID()}:`;
    let sequence = 0;

    function route(frame) {
        if (frame.type === 'response') {
            const record = requests.get(frame.id);
            if (record) {
                record.release();
                record.connection.send({...frame, id: record.id}, record);
            }
            return;
        }
        if (frame.type !== 'event') return;
        if (Object.hasOwn(frame, 'requestId')) {
            const record = requests.get(frame.requestId);
            if (record) record.connection.send({...frame, requestId: record.id}, record);
            return;
        }
        for (const connection of connections) connection.send(frame);
    }

    const unsubscribe = runtime.onFrame(route);
    const owner = {
        connections,
        requests,
        allocate(requestPrefix) {
            // Every acceptance gets a fresh transport correlation. A retired
            // service context must never target a later use of its client ID.
            const active = runtime.current().activeRequests;
            function inUse(candidate) {
                return requests.has(candidate) || active.some(
                    function activeRequest(request) { return request.id === candidate; }
                );
            }
            let internalId;
            do {
                internalId = `${requestPrefix ?? ''}${prefix}${++sequence}`;
            } while (inUse(internalId));
            return internalId;
        },
        release() {
            if (connections.size || requests.size) return;
            unsubscribe();
            owners.delete(runtime);
        }
    };
    owners.set(runtime, owner);
    return owner;
}

/** One transport connection borrows dispatch; only its host owns runtime.close. */
export function createCoreRuntimeConnection({
    runtime, send, requestPrefix, mapFrame, getReplayEvents, preserveContextRequestId = true
}) {
    const owner = runtimeConnections(runtime);
    const requests = new Map();
    const internalRequests = new Map();
    let disconnected = false;

    function deliver(frame, record) {
        if (disconnected) return;
        const outgoing = mapFrame ? mapFrame(frame, record) : frame;
        if (outgoing !== undefined) send(outgoing);
    }

    function cancel(record) {
        return runtime.handle(
            {protocol: CORE_PROTOCOL, type: 'control', control: 'request.cancel', requestId: record.internalId}
        );
    }

    function cancelAll() {
        return Promise.all([...requests.values()].map(cancel));
    }

    function replay() {
        const state = runtime.current();
        if (state.state === 'ready') deliver(event('core.ready', {version: state.version, app: state.application}));
        deliver(event('core.state', state));
        for (const service of state.services) deliver(event('core.service.state', service));
        // Only the existing owner's current snapshots, never requests/history.
        for (const snapshot of getReplayEvents?.() ?? []) deliver(event(snapshot.event, snapshot.data));
    }

    async function handle(frame) {
        if (disconnected) throw failure('CORE_CONNECTION_CLOSED', 'The Core connection is closed.');
        if (frame?.protocol !== CORE_PROTOCOL) throw failure('INVALID_RPC_REQUEST', 'Unknown Core protocol.');
        if (frame.type === 'control') {
            if (frame.control === 'runtime.replay') return replay();
            if (frame.control === 'requests.cancelAll') return cancelAll();
            if (frame.control === 'request.cancel') {
                const record = requests.get(frame.requestId);
                return record ? cancel(record) : undefined;
            }
            throw failure('INVALID_RPC_CONTROL', 'Unknown Core control.');
        }
        if (frame.type !== 'request' || !is.string(frame.id) || !frame.id || !is.string(frame.method)) {
            throw failure('INVALID_RPC_REQUEST', 'A Core request requires an id and method.');
        }
        if (requests.has(frame.id)) {
            const answer = {protocol: CORE_PROTOCOL, type: 'response', id: frame.id, ok: false,
                error: serializeCoreError(failure('RPC_REQUEST_ID_ACTIVE', 'The request id is already active on this connection.')),
                time: new Date().toISOString()};
            deliver(answer);
            return answer;
        }
        const record = {connection, id: frame.id, internalId: owner.allocate(requestPrefix), release: releaseRequest};
        function releaseRequest() {
            if (requests.get(record.id) === record) requests.delete(record.id);
            internalRequests.delete(record.internalId);
            owner.requests.delete(record.internalId);
            owner.release();
        }
        requests.set(record.id, record);
        internalRequests.set(record.internalId, record);
        owner.requests.set(record.internalId, record);
        try {
            return await runtime.handle(
                {...frame, id: record.internalId},
                preserveContextRequestId ? {contextRequestId: record.id} : undefined
            );
        } finally {
            releaseRequest();
        }
    }

    function close() {
        if (disconnected) return Promise.resolve();
        disconnected = true;
        owner.connections.delete(connection);
        const cancellation = cancelAll();
        owner.release();
        return cancellation;
    }

    const connection = {
        handle,
        close,
        send: deliver,
        has(id) { return requests.has(id); },
        request(internalId) { return internalRequests.get(internalId); }
    };
    owner.connections.add(connection);
    return connection;
}
