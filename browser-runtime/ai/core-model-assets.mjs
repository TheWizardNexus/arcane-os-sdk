import Is from '../dependencies/strong-type/index.js';
import {getInstalledCoreClient} from '../core/client.mjs';

const is = new Is(false);

/** Inspect selected native directories without downloading or loading a model. */
export function discoverCoreModelAssets({client = getInstalledCoreClient(), directories, catalog, recursive, signal} = {}) {
    requireCore(client);
    return client.invoke('modelAssets.discover', {directories, catalog, recursive}, {signal, timeoutMs: 0});
}

/** Retain existing complete files without copying them into an application build. */
export function openExistingCoreModelAssets({client = getInstalledCoreClient(), directory, members, signal} = {}) {
    return prepareNativeProjection(client, 'modelAssets.openExisting', {directory, members}, {signal});
}

/** Explicitly download a selected complete native model and its companions. */
export function downloadCoreModelAssets({
    client = getInstalledCoreClient(), workingDirectory, members, archives, refresh = false, signal, onProgress
} = {}) {
    return prepareNativeProjection(client, 'modelAssets.prepare', {workingDirectory, members, archives, refresh}, {signal, onProgress});
}

function requireCore(client) {
    if (!is.function(client?.invoke)) {
        const error = new Error('Native model assets require an available Core connection.');
        error.code = 'ARCANE_MODEL_ASSETS_CORE_UNAVAILABLE';
        throw error;
    }
}

async function prepareNativeProjection(client, method, params, {signal, onProgress}) {
    requireCore(client);
    if (!is.function(client.uuid)) throw new TypeError('Model asset preparation requires Core operation ids.');
    if (onProgress !== undefined && !is.function(onProgress)) throw new TypeError('Model asset onProgress must be a function.');
    if (onProgress && !is.function(client.events?.on)) throw new TypeError('Model asset progress requires Core events.');
    const id = client.uuid();
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    operationSignal.throwIfAborted();
    let delivery = Promise.resolve();
    let callbackFailure;
    let releaseTask;
    const unsubscribe = onProgress ? client.events.on('modelAssets.progress', function receiveProgress(event) {
        if (event?.id !== id || operationSignal.aborted) return;
        delivery = delivery.then(function orderedProgress() {
            if (!operationSignal.aborted) return onProgress(event.progress);
        });
        delivery.catch(function failedProgress(error) {
            callbackFailure ??= error;
            controller.abort(error);
        });
    }) : undefined;

    function release() {
        releaseTask ??= client.invoke('modelAssets.release', {id}, {timeoutMs: 0});
        return releaseTask;
    }

    try {
        const projection = await client.invoke(method, {id, ...params}, {signal: operationSignal, timeoutMs: 0});
        await delivery;
        operationSignal.throwIfAborted();
        return {id, directory: projection.directory, members: projection.members, release};
    } catch (error) {
        // Core publishes the terminal transfer state before rejecting prepare.
        // Deliver that queued state before our cleanup cancellation can suppress
        // it. Explicit caller cancellation still owns its existing boundary.
        try { await delivery; }
        catch (deliveryError) { callbackFailure ??= deliveryError; }
        const reason = callbackFailure ?? (error?.code === 'ARCANE_REQUEST_ABORTED' && operationSignal.aborted ? operationSignal.reason : error);
        controller.abort(reason);
        const errors = [reason];
        try {
            if (method === 'modelAssets.prepare') await client.invoke('modelAssets.cancelPrepare', {id}, {timeoutMs: 0});
            else await release();
        } catch (cleanupError) { if (!errors.includes(cleanupError)) errors.push(cleanupError); }
        try { await delivery; }
        catch (deliveryError) { if (!errors.includes(deliveryError)) errors.push(deliveryError); }
        if (errors.length > 1) throw new AggregateError(errors, 'Native model preparation and cleanup failed.', {cause: reason});
        throw reason;
    } finally { unsubscribe?.(); }
}

/** Projects complete caller-owned assets through Core without changing their store. */
export async function prepareCoreModelAssets({
    client = getInstalledCoreClient(), workingDirectory, members, signal, onProgress
} = {}) {
    if (!is.function(client?.invoke) || !is.function(client?.uuid)) {
        const error = new Error('Native model assets require an available Core connection.');
        error.code = 'ARCANE_MODEL_ASSETS_CORE_UNAVAILABLE';
        throw error;
    }
    if (!is.string(workingDirectory) || workingDirectory === '') {
        throw new TypeError('Model asset workingDirectory must be a nonempty string.');
    }
    if (!is.array(members) || members.length === 0) {
        throw new TypeError('Model assets require at least one complete file.');
    }
    for (const member of members) {
        if (!is.string(member?.path) || member.path === '' || !is.function(member?.file?.stream)) {
            throw new TypeError('Each model asset requires a path and a complete Blob or File.');
        }
    }
    if (onProgress !== undefined && !is.function(onProgress)) {
        throw new TypeError('Model asset onProgress must be a function.');
    }

    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    operationSignal.throwIfAborted();
    const id = client.uuid();
    const cleanupErrors = [];
    let completed = 0;
    let openingStarted = false;
    let failed = false;
    let failure;
    let releaseTask;

    function retainFailure(error) {
        if (failed) return;
        failed = true;
        failure = error;
        controller.abort(error);
    }

    function progress(phase, memberIndex) {
        operationSignal.throwIfAborted();
        onProgress?.({
            phase, completed, total: members.length, unit: 'files',
            ...(memberIndex === undefined ? {} : {memberIndex, path: members[memberIndex].path})
        });
    }

    function release() {
        releaseTask ??= Promise.resolve().then(function releaseNativeProjection() {
            return client.invoke('modelAssets.release', {id}, {timeoutMs: 0});
        });
        return releaseTask;
    }

    async function transferMember(member, memberIndex) {
        let reader;
        let cancellation;

        function cancelReader() {
            if (!reader || cancellation) return;
            cancellation = Promise.resolve().then(function cancelMemberStream() {
                return reader.cancel(operationSignal.reason);
            }).catch(function retainReaderCleanupFailure(error) {
                cleanupErrors.push(error);
            });
        }

        try {
            operationSignal.throwIfAborted();
            reader = member.file.stream().getReader();
            operationSignal.addEventListener('abort', cancelReader, {once: true});
            if (operationSignal.aborted) cancelReader();
            progress('write', memberIndex);
            while (true) {
                operationSignal.throwIfAborted();
                const {done, value} = await reader.read();
                operationSignal.throwIfAborted();
                if (done) break;
                // Base64 belongs only to the existing JSON transport boundary.
                const contentBase64 = encodeChunk(value);
                await client.invoke('modelAssets.write', {id, memberIndex, contentBase64}, {
                    signal: operationSignal, timeoutMs: 0
                });
                progress('write', memberIndex);
            }
            completed += 1;
            progress('write', memberIndex);
        } catch (error) {
            retainFailure(error);
            throw error;
        } finally {
            operationSignal.removeEventListener('abort', cancelReader);
            if (operationSignal.aborted) cancelReader();
            if (cancellation) await cancellation;
            try { reader?.releaseLock(); } catch (error) {
                if (failed) cleanupErrors.push(error);
                else retainFailure(error);
            }
        }
    }

    try {
        progress('open');
        openingStarted = true;
        await client.invoke('modelAssets.open', {
            id, workingDirectory,
            members: members.map(function describeMember(member) { return {path: member.path}; })
        }, {signal: operationSignal, timeoutMs: 0});
        operationSignal.throwIfAborted();
        const results = await Promise.allSettled(members.map(transferMember));
        for (const result of results) {
            if (result.status === 'rejected') retainFailure(result.reason);
        }
        if (failed) throw failure;
        if (cleanupErrors.length) {
            throw new AggregateError(cleanupErrors.splice(0), 'Model asset streams could not be released.');
        }
        progress('complete');
        const projection = await client.invoke('modelAssets.complete', {id}, {
            signal: operationSignal, timeoutMs: 0
        });
        progress('ready');
        operationSignal.throwIfAborted();
        // The caller releases ownership after native consumers retain this projection.
        return {id, directory: projection.directory, members: projection.members, release};
    } catch (error) {
        retainFailure(error);
        if (openingStarted) {
            try { await release(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        if (cleanupErrors.length) {
            throw new AggregateError([failure, ...cleanupErrors],
                'Model asset preparation and cleanup failed.', {cause: failure});
        }
        throw failure;
    }
}

function encodeChunk(content) {
    if (is.function(content.toBase64)) return content.toBase64();
    let binary = '';
    for (const value of content) binary += String.fromCharCode(value);
    return btoa(binary);
}
