import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);
const owners = new WeakMap();
// Physical OPFS framing only; every input chunk is written in full. This is
// neither a model limit nor public progress, and avoids a file per network read.
const PART_FRAME = 8 * 1024 * 1024;

export function withDbopfsModelLock(dbopfs, tableName, name, operation, {signal} = {}) {
    let tables = owners.get(dbopfs);
    if (!tables) owners.set(dbopfs, tables = new Map());
    let entries = tables.get(tableName);
    if (!entries) tables.set(tableName, entries = new Map());
    const preceding = entries.get(name) ?? Promise.resolve();
    let acquired = false;
    function runOwnedOperation() {
        throwIfModelAborted(signal);
        acquired = true;
        return operation();
    }
    async function acquireStorageOwner() {
        throwIfModelAborted(signal);
        if (dbopfs.readyPromise) await dbopfs.readyPromise;
        throwIfModelAborted(signal);
        const locks = dbopfs.lockManager ?? globalThis.navigator?.locks;
        if (!is.function(locks?.request)) return runOwnedOperation();
        const lockName = `arcane-model-storage:${JSON.stringify([dbopfs.storagePath ?? '', tableName, name])}`;
        return locks.request(lockName, signal ? {mode: 'exclusive', signal} : {mode: 'exclusive'}, runOwnedOperation);
    }
    const current = preceding.then(acquireStorageOwner, acquireStorageOwner);
    entries.set(name, current);
    function releaseOwner() {
        if (entries.get(name) === current) entries.delete(name);
        if (entries.size === 0) tables.delete(tableName);
    }
    current.then(releaseOwner, releaseOwner);
    if (!signal) return current;
    // A cancelled waiter can leave promptly, while its inert queue link stays
    // behind the preceding owner. Once acquired, durable cleanup must settle.
    return new Promise(function observeStorageWait(resolve, reject) {
        function cancelWait() {
            if (!acquired) {
                try {
                    throwIfModelAborted(signal);
                } catch (error) {
                    reject(error);
                }
            }
        }
        signal.addEventListener('abort', cancelWait, {once: true});
        if (signal.aborted) cancelWait();
        current.then(function ownedOperationFinished(value) {
            signal.removeEventListener('abort', cancelWait);
            resolve(value);
        }, function ownedOperationFailed(error) {
            signal.removeEventListener('abort', cancelWait);
            reject(error);
        });
    });
}

export function throwIfModelAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('The model resource operation was cancelled.', 'AbortError');
    }
}

function missingFile(error) {
    return error?.name === 'NotFoundError' || error?.code === 'ENOENT';
}

/** Own the reader until its cancellation and pending read have settled. */
export async function* readModelChunks(body, signal) {
    throwIfModelAborted(signal);
    if (body === null || body === undefined) return;
    if (is.function(body.stream)) body = body.stream();
    if (!is.function(body.getReader)) {
        if (body instanceof ArrayBuffer || ArrayBuffer.isView(body) || is.string(body)) {
            body = new Blob([body]).stream();
        } else {
            for await (const chunk of body) {
                throwIfModelAborted(signal);
                yield chunk;
            }
            throwIfModelAborted(signal);
            return;
        }
    }
    const reader = body.getReader();
    let ended = false;
    let cancellation;
    function cancelReader() {
        cancellation ??= Promise.resolve(reader.cancel(signal?.reason));
        // Observe immediately; cleanup below retains and reports any failure.
        cancellation.catch(function observeCancellation() {});
    }
    signal?.addEventListener('abort', cancelReader, {once: true});
    try {
        if (signal?.aborted) cancelReader();
        while (true) {
            throwIfModelAborted(signal);
            const {value, done} = await reader.read();
            throwIfModelAborted(signal);
            if (done) {
                ended = true;
                return;
            }
            yield value;
        }
    } finally {
        signal?.removeEventListener('abort', cancelReader);
        try {
            if (!ended) cancelReader();
            await cancellation;
        } finally {
            reader.releaseLock();
        }
    }
}

/** Shared private storage for complete resources and resumable closed parts. */
export function createDbopfsModelPartStore({dbopfs, tableName}) {
    let directoryPromise;
    async function directory() {
        if (dbopfs.readyPromise) await dbopfs.readyPromise;
        directoryPromise ??= Promise.resolve(dbopfs.getTableHandle(tableName));
        return directoryPromise;
    }
    async function file(name) {
        try {
            const handle = await (await directory()).getFileHandle(name, {create: false});
            return await handle.getFile();
        } catch (error) {
            if (missingFile(error)) return null;
            throw error;
        }
    }
    async function removeFile(name) {
        try {
            await (await directory()).removeEntry(name);
            return true;
        } catch (error) {
            if (missingFile(error)) return false;
            throw error;
        }
    }
    function manifestName(name) {
        return `${name}.arcane-parts.json`;
    }
    async function readState(name) {
        const record = await file(manifestName(name));
        return record ? JSON.parse(await record.text()) : null;
    }
    async function saveState(name, record) {
        const target = manifestName(name);
        const existing = await file(target);
        let writer;
        try {
            const handle = await (await directory()).getFileHandle(target, {create: true});
            writer = await handle.createWritable();
            await writer.write(JSON.stringify(record));
            await writer.close();
        } catch (error) {
            const failures = [error];
            try {
                await writer?.abort(error);
            } catch (cleanupError) {
                failures.push(cleanupError);
            }
            if (!existing) {
                try {
                    await removeFile(target);
                } catch (cleanupError) {
                    failures.push(cleanupError);
                }
            }
            if (failures.length > 1) throw new AggregateError(failures, 'Unable to settle the model part index.');
            throw error;
        }
    }
    async function assemble(record, signal, onProgress) {
        const parts = [];
        function reportStoredPart() {
            throwIfModelAborted(signal);
            onProgress?.({phase: 'load', message: 'Reading stored model resource',
                completed: parts.length, total: record.parts.length, unit: 'shards', cached: true});
        }
        reportStoredPart();
        for (const name of record.parts) {
            throwIfModelAborted(signal);
            const part = await file(name);
            if (!part) return null;
            parts.push(part);
            reportStoredPart();
        }
        throwIfModelAborted(signal);
        return new Blob(parts);
    }
    async function clear(name, signal) {
        throwIfModelAborted(signal);
        const record = await readState(name);
        if (!record) return false;
        for (const part of record.parts) {
            throwIfModelAborted(signal);
            await removeFile(part);
        }
        await removeFile(manifestName(name));
        return true;
    }
    function locked(name, operation, signal) {
        return withDbopfsModelLock(dbopfs, tableName, `parts:${name}`, operation, {signal});
    }
    function state(name, {signal} = {}) {
        return locked(name, async function readModelPartState() {
            throwIfModelAborted(signal);
            return readState(name);
        }, signal);
    }
    function read(name, {signal, onProgress} = {}) {
        return locked(name, async function readCompleteModelParts() {
            throwIfModelAborted(signal);
            const record = await readState(name);
            return record?.complete ? assemble(record, signal, onProgress) : null;
        }, signal);
    }
    function readPartial(name, {signal, onProgress} = {}) {
        return locked(name, async function readClosedModelParts() {
            throwIfModelAborted(signal);
            const record = await readState(name);
            return record ? assemble(record, signal, onProgress) : null;
        }, signal);
    }
    function remove(name, {signal} = {}) {
        return locked(name, async function removeModelParts() {
            return clear(name, signal);
        }, signal);
    }
    function write(name, body, {signal, onProgress, append = false} = {}) {
        return locked(name, async function writeModelParts() {
            throwIfModelAborted(signal);
            let record = append ? await readState(name) : null;
            if (!record) {
                await clear(name, signal);
                record = {parts: [], complete: false};
            } else {
                record.complete = false;
            }
            await saveState(name, record);
            let writer = null;
            let openName;
            let framed = 0;
            function report(complete = false) {
                onProgress?.({phase: 'download', completed: record.parts.length,
                    total: complete ? record.parts.length : null, unit: 'shards'});
            }
            async function closePart() {
                await writer.close();
                writer = null;
                record.parts.push(openName);
                await saveState(name, record);
                framed = 0;
                report();
            }
            try {
                report();
                for await (const value of readModelChunks(body, signal)) {
                    let chunk;
                    if (is.string(value)) chunk = new TextEncoder().encode(value);
                    else if (value instanceof ArrayBuffer) chunk = new Uint8Array(value);
                    else if (ArrayBuffer.isView(value)) {
                        chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                    } else {
                        throw new TypeError('Model stream chunks must be strings, ArrayBuffers or typed arrays.');
                    }
                    let offset = 0;
                    while (offset < chunk.byteLength) {
                        throwIfModelAborted(signal);
                        if (!writer) {
                            openName = `${name}.arcane-part-${record.parts.length}`;
                            const handle = await (await directory()).getFileHandle(openName, {create: true});
                            writer = await handle.createWritable();
                        }
                        const end = Math.min(chunk.byteLength, offset + PART_FRAME - framed);
                        await writer.write(chunk.subarray(offset, end));
                        framed += end - offset;
                        offset = end;
                        if (framed === PART_FRAME) await closePart();
                    }
                }
                throwIfModelAborted(signal);
                if (writer) await closePart();
                throwIfModelAborted(signal);
                record.complete = true;
                await saveState(name, record);
                report(true);
                return await assemble(record, signal);
            } catch (error) {
                if (writer) {
                    const failures = [error];
                    try {
                        await writer.abort(error);
                    } catch (cleanupError) {
                        failures.push(cleanupError);
                    }
                    try {
                        await removeFile(openName);
                    } catch (cleanupError) {
                        failures.push(cleanupError);
                    }
                    if (failures.length > 1) {
                        throw new AggregateError(failures, 'Unable to settle the interrupted model part.');
                    }
                }
                throw error;
            }
        }, signal);
    }
    // The HTTP Range owner already selected one physical part and owns its
    // protocol framing. Keep its established filename and complete-file reads.
    function writePart(name, body, {signal} = {}) {
        return locked(name, async function writeNamedModelPart() {
            throwIfModelAborted(signal);
            const handle = await (await directory()).getFileHandle(name, {create: true});
            const writer = await handle.createWritable();
            let closed = false;
            try {
                for await (const chunk of readModelChunks(body, signal)) await writer.write(chunk);
                throwIfModelAborted(signal);
                await writer.close();
                closed = true;
                return await handle.getFile();
            } catch (error) {
                if (closed) throw error;
                const failures = [error];
                try {
                    await writer.abort(error);
                } catch (cleanupError) {
                    failures.push(cleanupError);
                }
                try {
                    await removeFile(name);
                } catch (cleanupError) {
                    failures.push(cleanupError);
                }
                if (failures.length > 1) throw new AggregateError(failures, 'Unable to settle the model range part.');
                throw error;
            }
        }, signal);
    }
    return {read, write, remove, state, readPartial, writePart};
}
