import {mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import path from 'node:path';
import Is from 'strong-type';
import {CoreError, serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';

const is = new Is(false);
const nativeAcquisitions = new Map();
let nativeAcquisitionOrder = 0;

function failure(code, message) {
    return new CoreError({code, message});
}

function memberLocation(directory, member) {
    const nativePath = path.resolve(directory, member.path);
    const relative = path.relative(directory, nativePath);
    if (path.isAbsolute(member.path) || !relative || relative === '..'
        || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new TypeError('Model asset member paths must be relative files within their projection.');
    }
    return {path: member.path, nativePath};
}

function sameMembers(left, right) {
    return is.array(left) && left.length === right.length
        && left.every(function sameMember(member, index) {
            return member.path === right[index].path && member.url === right[index].url;
        });
}

async function storedAcquisition(directory, members, signal) {
    let latest;
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !entry.name.startsWith('acquisition-')) continue;
        const root = path.join(directory, entry.name);
        let selected;
        try { selected = JSON.parse(await readFile(path.join(root, 'acquisition.json'), {encoding: 'utf8', signal})); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (!sameMembers(selected.members, members)) continue;
        nativeAcquisitionOrder = Math.max(nativeAcquisitionOrder, selected.order);
        const files = path.join(root, 'files');
        const locations = members.map(function originalLocation(member) { return memberLocation(files, member); });
        let available = true;
        for (const member of locations) {
            signal.throwIfAborted();
            try { if (!(await stat(member.nativePath)).isFile()) available = false; }
            catch (error) { if (error.code !== 'ENOENT') throw error; available = false; }
        }
        if (available && (!latest || selected.order > latest.order
            || (selected.order === latest.order && entry.name > latest.name))) {
            latest = {name: entry.name, order: selected.order, directory: files, members: locations};
        }
    }
    return latest ? {directory: latest.directory, members: latest.members} : null;
}

async function acquireNativeMembers(entry) {
    const {directory, members, controller} = entry;
    const {signal} = controller;
    let attempt;
    let completed = 0;
    let committed = false;
    let firstFailure;
    function progress(phase, memberIndex) {
        entry.publish({phase, completed, total: members.length, unit: 'files',
            ...(memberIndex === undefined ? {} : {memberIndex, path: members[memberIndex].path})});
    }
    try {
        signal.throwIfAborted();
        const stored = await storedAcquisition(directory, members, signal);
        if (stored && !entry.refresh) {
            entry.location = stored;
            completed = members.length;
            progress('reuse');
            progress('ready');
            return stored;
        }
        signal.throwIfAborted();
        attempt = await mkdtemp(path.join(directory, 'acquisition-'));
        const files = path.join(attempt, 'files');
        await mkdir(files);
        entry.location = {directory: files, members: members.map(function selectedMember(member) { return memberLocation(files, member); })};
        progress('open');
        const results = await Promise.allSettled(members.map(async function downloadMember(member, memberIndex) {
            let handle;
            let response;
            let downloadError;
            const failures = [];
            let bodyOwned = false;
            try {
                signal.throwIfAborted();
                const nativePath = entry.location.members[memberIndex].nativePath;
                await mkdir(path.dirname(nativePath), {recursive: true});
                handle = await open(nativePath, 'wx');
                signal.throwIfAborted();
                progress('download', memberIndex);
                response = await fetch(member.url, {signal});
                if (!response.ok) {
                    const error = failure('MODEL_ASSET_DOWNLOAD_FAILED', `Model asset request failed: ${response.status} ${response.statusText}`);
                    error.url = member.url;
                    error.status = response.status;
                    error.response = await response.text();
                    throw error;
                }
                if (!response.body) throw failure('MODEL_ASSET_DOWNLOAD_FAILED', `Model asset response has no content stream: ${member.url}`);
                bodyOwned = true;
                for await (const content of response.body) {
                    signal.throwIfAborted();
                    await handle.appendFile(content);
                    progress('download', memberIndex);
                }
                signal.throwIfAborted();
            } catch (error) {
                downloadError = error;
                failures.push(error);
                firstFailure ??= error;
                controller.abort(error);
            }
            if (response?.body && !bodyOwned && !response.bodyUsed && !response.body.locked) {
                try { await response.body.cancel(downloadError); } catch (error) { if (error !== downloadError) failures.push(error); }
            }
            if (handle) {
                try { await handle.close(); } catch (error) { failures.push(error); }
            }
            if (failures.length) {
                const error = failures.length === 1 ? failures[0] : new AggregateError(failures, 'Downloading a model member and closing its resources failed.');
                firstFailure ??= error;
                controller.abort(error);
                throw error;
            }
            completed += 1;
            progress('download', memberIndex);
        }));
        const failures = results.filter(function rejected(result) { return result.status === 'rejected'; })
            .map(function reason(result) { return result.reason; });
        if (failures.length > 1) throw new AggregateError(failures, 'Downloading model asset members failed.', {cause: firstFailure});
        if (failures.length) throw failures[0];
        signal.throwIfAborted();
        progress('complete');
        // The record describes a completed acquisition, not content identity.
        // Publish it after every stream and file close, leaving older entries alone.
        const pending = path.join(attempt, 'acquisition.pending.json');
        await writeFile(pending, JSON.stringify({members, order: ++nativeAcquisitionOrder}), {encoding: 'utf8', flag: 'wx', signal});
        signal.throwIfAborted();
        await rename(pending, path.join(attempt, 'acquisition.json'));
        committed = true;
        progress('ready');
        return entry.location;
    } catch (error) {
        if (attempt && !committed) {
            try { await rm(attempt, {recursive: true}); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Preparing native model assets failed and cleanup failed.'); }
        }
        throw error;
    }
}

function shareNativeAcquisition({directory, members, refresh, signal, onProgress}) {
    signal.throwIfAborted();
    const key = JSON.stringify([directory, members, refresh]);
    let entry = nativeAcquisitions.get(key);
    if (entry?.controller.signal.aborted) {
        return entry.task.catch(function observeRetiringAcquisition() {}).then(function acquireAfterDrain() {
            return shareNativeAcquisition({directory, members, refresh, signal, onProgress});
        });
    }
    if (!entry) {
        entry = {directory, members, refresh, controller: new AbortController(), consumers: new Set(), task: null, location: null, progress: null};
        nativeAcquisitions.set(key, entry);
        entry.publish = function publishProgress(progress) {
            entry.progress = progress;
            for (const consumer of entry.consumers) consumer.progress(progress);
        };
    }
    const acquisition = entry;
    return new Promise(function observeAcquisition(resolve, reject) {
        let settled = false;
        let cancelled;
        let observer = Promise.resolve();
        const consumer = {progress};
        function finish(failed, error, location) {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', abort);
            acquisition.consumers.delete(consumer);
            if (consumer.cancelled && failed && error !== cancelled) {
                reject(new AggregateError([cancelled, error], 'Native model acquisition cancellation and cleanup failed.', {cause: cancelled}));
            } else if (consumer.cancelled) reject(cancelled);
            else if (failed) reject(error);
            else resolve(location);
        }
        function cancel(error) {
            if (settled || consumer.cancelled) return;
            cancelled = error;
            consumer.cancelled = true;
            const others = [...acquisition.consumers].some(function interested(other) { return other !== consumer && !other.cancelled; });
            if (others) observer.then(function cancelledObserverSettled() { finish(true, error); });
            else acquisition.controller.abort(error);
        }
        function abort() { cancel(signal.reason); }
        function progress(value) {
            const notification = {...value};
            // Each subscriber owns its ordered observers. A slow or failing
            // observer never holds another subscriber's transfer or result.
            observer = observer.then(async function observeProgress() {
                if (!consumer.cancelled && !settled) await onProgress?.(notification, acquisition.location);
            }).catch(cancel);
        }
        acquisition.consumers.add(consumer);
        signal.addEventListener('abort', abort, {once: true});
        if (acquisition.progress) progress(acquisition.progress);
        if (signal.aborted) abort();
        if (!acquisition.task) {
            acquisition.task = Promise.resolve().then(function acquireSelectedMembers() { return acquireNativeMembers(acquisition); });
            function releaseAcquisition() { if (nativeAcquisitions.get(key) === acquisition) nativeAcquisitions.delete(key); }
            acquisition.task.then(releaseAcquisition, releaseAcquisition);
        }
        acquisition.task.then(function completed(location) {
            observer.then(function observersCompleted() { finish(false, null, location); });
        }, function failed(error) {
            observer.then(function observersCompleted() { finish(true, error); });
        });
    });
}

/** Temporary browser projections and persistent selected native acquisitions. */
export function createModelAssetService({appRoot = process.cwd()} = {}) {
    const projections = new Map();
    let context;
    let closing;

    function snapshot(record) {
        return {
            id: record.id, directory: record.directory, state: record.state,
            members: record.members.map(function memberLocation(member) {
                return {path: member.path, nativePath: member.nativePath};
            }),
            preparationOwned: record.preparationOwned, uses: record.uses.size,
            error: record.error ? serializeCoreError(record.error) : null
        };
    }

    function current() {
        return {closing: Boolean(closing), projections: [...projections.values()].map(snapshot)};
    }

    function publish(record) {
        context?.emit('modelAssets.state', snapshot(record));
    }

    function requireProjection(id) {
        const record = projections.get(id);
        if (!record) throw failure('MODEL_ASSET_PROJECTION_UNAVAILABLE', `Model asset projection ${id} is unavailable.`);
        return record;
    }

    async function closeMembers(record) {
        const results = await Promise.allSettled(record.members.map(async function closeMember(member) {
            await member.tail;
            if (!member.handle) return;
            const handle = member.handle;
            await handle.close();
            member.handle = null;
        }));
        const errors = results.filter(function rejected(result) { return result.status === 'rejected'; })
            .map(function reason(result) { return result.reason; });
        if (errors.length) throw new AggregateError(errors, 'Closing model asset files failed.');
    }

    function cleanup(record) {
        if (record.preparationOwned || record.uses.size) return Promise.resolve(snapshot(record));
        if (record.cleanup) return record.cleanup;
        record.state = 'releasing';
        // Retain the cleanup task before events can trigger another release.
        record.cleanup = Promise.resolve().then(async function removeWorkingProjection() {
            const errors = [];
            let filesClosed = false;
            try { await record.opening; } catch (error) { record.error ??= error; }
            try { await record.downloading; } catch (error) { record.error ??= error; }
            try { await record.finishing; } catch (error) { record.error ??= error; }
            try { await closeMembers(record); filesClosed = true; } catch (error) { errors.push(error); }
            if (record.directory && filesClosed && !record.persistent) {
                try { await rm(record.directory, {recursive: true}); }
                catch (error) { if (error.code !== 'ENOENT') errors.push(error); }
            }
            if (errors.length) throw new AggregateError(errors, 'Releasing model asset working files failed.');
            record.state = 'released';
            projections.delete(record.id);
            publish(record);
            return snapshot(record);
        });
        record.cleanup.then(record.resolveReleased, function cleanupFailed(error) {
            record.error = error;
            record.state = 'error';
            publish(record);
            record.rejectReleased(error);
        });
        publish(record);
        return record.cleanup;
    }

    function releasePreparation(record) {
        record.preparationOwned = false;
        record.downloadController?.abort(failure('MODEL_ASSET_PROJECTION_RELEASED', 'Model asset preparation was released.'));
        publish(record);
        return cleanup(record);
    }

    function release(id) {
        const record = projections.get(id);
        return record ? releasePreparation(record) : Promise.resolve({id, state: 'released'});
    }

    async function failedOperation(record, error) {
        record.error = error;
        record.state = 'error';
        publish(record);
        try { await releasePreparation(record); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Preparing model assets failed and cleanup failed.'); }
        throw error;
    }

    function beginProjection({id, workingDirectory, members}, signal) {
        signal.throwIfAborted();
        if (closing) throw failure('MODEL_ASSETS_CLOSING', 'Model asset preparation is closing.');
        if (!is.string(id) || !id) throw new TypeError('A model asset projection needs an operation id.');
        if (!is.string(workingDirectory) || !workingDirectory) {
            throw new TypeError('Model asset preparation needs an explicit working directory.');
        }
        if (!is.array(members) || !members.length) throw new TypeError('Select the complete model asset members.');
        if (projections.has(id)) throw failure('MODEL_ASSET_PROJECTION_ACTIVE', `Model asset projection ${id} already exists.`);
        const record = {
            id, state: 'preparing', directory: null, members: [], uses: new Set(),
            preparationOwned: true, error: null, opening: null, finishing: null, cleanup: null
        };
        record.released = new Promise(function projectionReleased(resolve, reject) {
            record.resolveReleased = resolve;
            record.rejectReleased = reject;
        });
        record.released.catch(function observeReleaseFailure() {});
        projections.set(id, record);
        return record;
    }

    async function openProjection({id, workingDirectory, members}, request) {
        const record = beginProjection({id, workingDirectory, members}, request.signal);
        record.opening = Promise.resolve().then(async function createWorkingFiles() {
            const selectedDirectory = path.resolve(appRoot, workingDirectory);
            await mkdir(selectedDirectory, {recursive: true});
            request.signal.throwIfAborted();
            record.directory = await mkdtemp(path.join(selectedDirectory, 'arcane-model-'));
            record.members = members.map(function memberRecord(member) {
                // A projection consists of files under its one owned directory.
                // Absolute or escaping members cannot participate in that lifetime.
                return {...memberLocation(record.directory, member), handle: null, tail: Promise.resolve()};
            });
            const results = await Promise.allSettled(record.members.map(async function createMember(member) {
                request.signal.throwIfAborted();
                await mkdir(path.dirname(member.nativePath), {recursive: true});
                request.signal.throwIfAborted();
                member.handle = await open(member.nativePath, 'wx');
                request.signal.throwIfAborted();
            }));
            const errors = results.filter(function rejected(result) { return result.status === 'rejected'; })
                .map(function reason(result) { return result.reason; });
            if (errors.length) throw new AggregateError(errors, 'Opening model asset working files failed.');
        });
        publish(record);
        try {
            await record.opening;
            request.signal.throwIfAborted();
            if (!record.preparationOwned) throw failure('MODEL_ASSET_PROJECTION_RELEASED', 'Model asset preparation was released.');
            return snapshot(record);
        } catch (error) { return failedOperation(record, error); }
    }

    async function writeMember({id, memberIndex, contentBase64}, request) {
        const record = requireProjection(id);
        await record.opening;
        request.signal.throwIfAborted();
        if (record.state !== 'preparing' || !record.preparationOwned) {
            throw failure('MODEL_ASSET_PROJECTION_NOT_WRITABLE', 'Model asset preparation is no longer accepting content.');
        }
        const member = record.members[memberIndex];
        if (!member) throw new TypeError('Select an existing model asset member.');
        try {
            await appendMemberContent(record, member, Buffer.from(contentBase64, 'base64'), request.signal);
            return {id, memberIndex, written: true};
        } catch (error) { return failedOperation(record, error); }
    }

    function appendMemberContent(record, member, content, signal) {
        const task = member.tail.then(async function appendOriginalContent() {
            signal.throwIfAborted();
            if (!record.preparationOwned) throw failure('MODEL_ASSET_PROJECTION_RELEASED', 'Model asset preparation was released.');
            await member.handle.appendFile(content);
            signal.throwIfAborted();
        });
        // File writes remain ordered; unrelated member files write independently.
        member.tail = task.catch(function observeWriteFailure() {});
        return task;
    }

    async function prepare({id, workingDirectory, members, signal, onProgress, refresh = false} = {}) {
        const controller = new AbortController();
        const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const record = beginProjection({id, workingDirectory, members}, operationSignal);
        let selectedMembers;
        try { selectedMembers = members.map(function selectedMember(member) { return {path: member.path, url: member.url}; }); }
        catch (error) { return failedOperation(record, error); }
        record.persistent = true;
        record.downloadController = controller;
        // This task owns only acquisition. Failure cleanup may join it without
        // recursively waiting for the preparation promise that requests cleanup.
        record.downloading = Promise.resolve().then(async function prepareNativeFiles() {
            operationSignal.throwIfAborted();
            const selectedDirectory = path.join(path.resolve(appRoot, workingDirectory), 'model-assets');
            await mkdir(selectedDirectory, {recursive: true});
            const directory = await realpath(selectedDirectory);
            operationSignal.throwIfAborted();
            return shareNativeAcquisition({directory, members: selectedMembers, refresh: refresh === true, signal: operationSignal,
                async onProgress(value, location) {
                    if (location) {
                        record.directory = location.directory;
                        record.members = location.members;
                    }
                    await onProgress?.(value);
                }});
        });
        publish(record);
        try {
            const location = await record.downloading;
            operationSignal.throwIfAborted();
            record.directory = location.directory;
            record.members = location.members;
            record.state = 'ready';
            publish(record);
            return snapshot(record);
        } catch (error) {
            controller.abort(error);
            return failedOperation(record, error);
        }
    }

    async function completeProjection({id}, request) {
        const record = requireProjection(id);
        await record.opening;
        request.signal.throwIfAborted();
        if (record.state === 'completing') {
            await record.finishing;
            request.signal.throwIfAborted();
        }
        if (record.state === 'ready') return snapshot(record);
        if (record.state !== 'preparing' || !record.preparationOwned) {
            throw failure('MODEL_ASSET_PROJECTION_NOT_WRITABLE', 'Model asset preparation cannot be completed in its current state.');
        }
        record.state = 'completing';
        record.finishing = Promise.resolve().then(async function finishProjection() {
            await closeMembers(record);
            request.signal.throwIfAborted();
            if (!record.preparationOwned || record.error) {
                throw record.error ?? failure('MODEL_ASSET_PROJECTION_RELEASED', 'Model asset preparation was released.');
            }
            record.state = 'ready';
            publish(record);
            return snapshot(record);
        });
        try { return await record.finishing; }
        catch (error) { return failedOperation(record, error); }
    }

    function retain(id) {
        const record = requireProjection(id);
        if (closing || record.state !== 'ready') {
            throw failure('MODEL_ASSET_PROJECTION_NOT_READY', 'The complete native model asset projection is not ready.');
        }
        const use = {};
        record.uses.add(use);
        let released;
        publish(record);
        return {
            id: record.id, directory: record.directory, members: snapshot(record).members,
            release() {
                if (released) return released;
                record.uses.delete(use);
                // Assign before publishing so reentrant release remains idempotent.
                released = Promise.resolve().then(function releaseEngineUse() { return cleanup(record); });
                publish(record);
                return released;
            }
        };
    }

    function dispose() {
        if (closing) return closing;
        closing = Promise.resolve().then(async function releaseAllProjections() {
            const records = [...projections.values()];
            for (const record of records) {
                releasePreparation(record).catch(function observeCleanupFailure() {});
            }
            // Core closes services concurrently. Engine retain handles keep files
            // alive until those owners finish actual native unload/worker exit.
            const results = await Promise.allSettled(records.map(function awaitRelease(record) { return record.released; }));
            const errors = results.filter(function rejected(result) { return result.status === 'rejected'; })
                .map(function reason(result) { return result.reason; });
            if (errors.length) throw new AggregateError(errors, 'Closing model asset preparation failed.');
        });
        return closing;
    }

    return {
        name: 'model-assets', current, prepare, retain, release,
        start(serviceContext) { context = serviceContext; },
        methods: {
            'modelAssets.open': openProjection,
            'modelAssets.write': writeMember,
            'modelAssets.complete': completeProjection,
            'modelAssets.status': function status() { return current(); },
            'modelAssets.release': {
                lifetime: 'service',
                handle({id}) {
                    return release(id);
                }
            }
        },
        dispose
    };
}

export default createModelAssetService;
