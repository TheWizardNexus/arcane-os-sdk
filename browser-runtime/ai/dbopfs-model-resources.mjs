import {createDbopfsModelPartStore, readModelChunks, throwIfModelAborted, withDbopfsModelLock} from './dbopfs-model-parts.mjs';

const INDEX_NAME = 'arcane-model-resources.json';

/** URL/request semantics identify resources; OPFS names are ordinary index IDs. */
export function createDbopfsResourceStore({dbopfs, tableName, fetchImpl = globalThis.fetch?.bind(globalThis)}) {
    const parts = createDbopfsModelPartStore({dbopfs, tableName});
    // Credential-bearing request selection stays transient. Its durable entry
    // has an ordinary index name and response metadata, never request headers.
    const privateEntries = new Map();
    let directoryPromise;
    async function directory() {
        if (dbopfs.readyPromise) await dbopfs.readyPromise;
        directoryPromise ??= Promise.resolve(dbopfs.getTableHandle(tableName));
        return directoryPromise;
    }
    async function readIndex() {
        try {
            const handle = await (await directory()).getFileHandle(INDEX_NAME, {create: false});
            return JSON.parse(await (await handle.getFile()).text());
        } catch (error) {
            if (error?.name === 'NotFoundError' || error?.code === 'ENOENT') return {entries: []};
            throw error;
        }
    }
    async function writeIndex(index) {
        const table = await directory();
        let existing;
        try {
            existing = await table.getFileHandle(INDEX_NAME, {create: false});
        } catch (error) {
            if (error?.name !== 'NotFoundError' && error?.code !== 'ENOENT') throw error;
        }
        let writer;
        try {
            const handle = existing ?? await table.getFileHandle(INDEX_NAME, {create: true});
            writer = await handle.createWritable();
            await writer.write(JSON.stringify(index));
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
                    await table.removeEntry(INDEX_NAME);
                } catch (cleanupError) {
                    if (cleanupError?.name !== 'NotFoundError' && cleanupError?.code !== 'ENOENT') failures.push(cleanupError);
                }
            }
            if (failures.length > 1) throw new AggregateError(failures, 'Unable to settle the model resource index.');
            throw error;
        }
    }
    function entryFor(key, metadata, privateRequest, signal) {
        return withDbopfsModelLock(dbopfs, tableName, 'resource-index', async function updateResourceIndex() {
            const index = await readIndex();
            let entry = index.entries.find(function sameResource(candidate) {
                return privateRequest ? candidate.name === privateEntries.get(key) : candidate.key === key;
            });
            let changed = false;
            if (!entry) {
                entry = {name: `arcane-resource-${index.entries.length}`};
                if (!privateRequest) entry.key = key;
                index.entries.push(entry);
                changed = true;
            }
            if (metadata !== undefined) {
                entry.metadata = metadata;
                changed = true;
            }
            if (changed) await writeIndex(index);
            if (privateRequest) privateEntries.set(key, entry.name);
            return entry;
        }, {signal});
    }
    async function fetchResource(input, {onProgress, ...options} = {}) {
        const request = new Request(input, options);
        const signal = request.signal;
        const key = JSON.stringify([request.method, request.url, request.credentials, [...request.headers]]);
        const privateRequest = request.headers.has('authorization') || request.headers.has('cookie');
        function reportResourceProgress(progress) {
            onProgress?.({...progress, url: request.url});
        }
        throwIfModelAborted(signal);
        const selected = await entryFor(key, undefined, privateRequest, signal);
        return withDbopfsModelLock(dbopfs, tableName, `resource:${selected.name}`, async function fetchStoredResource() {
            throwIfModelAborted(signal);
            const entry = await entryFor(key, undefined, privateRequest, signal);
            const reusable = request.method === 'GET' && !request.headers.has('range')
                && !['reload', 'no-cache', 'no-store'].includes(request.cache);
            if (reusable && entry.metadata?.status === 200) {
                const file = await parts.read(entry.name, {signal});
                if (file) {
                    const state = await parts.state(entry.name, {signal});
                    onProgress?.({phase: 'download', completed: state.parts.length,
                        total: state.parts.length, unit: 'shards', cached: true, url: request.url});
                    return {...entry.metadata, file};
                }
            }
            let response;
            let append = false;
            let metadata;
            let remaining;
            // Offset/Content-Range exist only at the HTTP resume boundary, never
            // in resource identity, model admission, or application progress.
            const previousHeaders = new Headers(entry.metadata?.headers);
            const encoding = previousHeaders.get('content-encoding');
            const partial = reusable && entry.metadata?.status === 200
                && (!encoding || encoding === 'identity')
                ? await parts.readPartial(entry.name, {signal}) : null;
            try {
                if (partial?.size) {
                    const headers = new Headers(request.headers);
                    headers.set('Range', `bytes=${partial.size}-`);
                    const validator = previousHeaders.get('etag') ?? previousHeaders.get('last-modified');
                    if (validator) headers.set('If-Range', validator);
                    response = await fetchImpl(new Request(request, {headers}));
                    const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get('content-range') ?? '');
                    if (response.status === 206 && range && Number(range[1]) === partial.size
                        && Number(range[2]) >= Number(range[1])
                        && Number(range[2]) + 1 === Number(range[3])) {
                        append = true;
                        remaining = Number(range[2]) - Number(range[1]) + 1;
                        // The completed response is the original full resource,
                        // not the resumed transport fragment delivered as a 206.
                        metadata = {...entry.metadata};
                    } else if (response.status === 206 || response.status === 416) {
                        await response.body?.cancel();
                        response = undefined;
                    }
                }
                response ??= await fetchImpl(request);
                throwIfModelAborted(signal);
                metadata ??= {
                    status: response.status,
                    statusText: response.statusText,
                    headers: [...response.headers],
                    url: response.url || request.url,
                    redirected: response.redirected
                };
                if (!response.ok) {
                    // A transient server error must not erase a resumable model.
                    // Keep its complete response separate and preserve its status.
                    const file = await parts.write(`${entry.name}.response`, response.body, {
                        signal, onProgress: reportResourceProgress
                    });
                    return {...metadata, file};
                }
                if (!append) await parts.remove(entry.name, {signal});
                await entryFor(key, metadata, privateRequest, signal);
                let body = response.body;
                if (append) {
                    const responseBody = body;
                    async function* resumedResponse() {
                        let received = 0;
                        for await (const chunk of readModelChunks(responseBody, signal)) {
                            received += chunk.byteLength;
                            if (received > remaining) throw new Error('The model server exceeded its HTTP Content-Range.');
                            yield chunk;
                        }
                        if (received !== remaining) throw new Error('The model server ended before its HTTP Content-Range.');
                    }
                    body = resumedResponse();
                }
                const file = await parts.write(entry.name, body, {
                    signal,
                    append,
                    onProgress: reportResourceProgress
                });
                return {...metadata, file};
            } catch (error) {
                if (response?.body && !response.body.locked) {
                    try {
                        await response.body.cancel(error);
                    } catch (cleanupError) {
                        if (cleanupError !== error) {
                            throw new AggregateError([error, cleanupError], 'Unable to settle the model resource response.');
                        }
                    }
                }
                throw error;
            }
        }, {signal});
    }
    return {fetchResource};
}
