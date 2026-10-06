import Is from '../dependencies/strong-type/index.js';
import {getInstalledCoreClient} from '../core/client.mjs';

const is = new Is(false);

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
