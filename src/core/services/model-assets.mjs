import {mkdir, mkdtemp, open, rm} from 'node:fs/promises';
import {Buffer} from 'node:buffer';
import path from 'node:path';
import Is from 'strong-type';
import {CoreError, serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';

const is = new Is(false);

function failure(code, message) {
    return new CoreError({code, message});
}

/** Working files for native engines. The browser's stored assets stay authoritative. */
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
            try { await record.finishing; } catch (error) { record.error ??= error; }
            try { await closeMembers(record); filesClosed = true; } catch (error) { errors.push(error); }
            if (record.directory && filesClosed) {
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
        publish(record);
        return cleanup(record);
    }

    async function failedOperation(record, error) {
        record.error = error;
        record.state = 'error';
        publish(record);
        try { await releasePreparation(record); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Preparing model assets failed and cleanup failed.'); }
        throw error;
    }

    async function openProjection({id, workingDirectory, members}, request) {
        request.signal.throwIfAborted();
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
        record.opening = Promise.resolve().then(async function createWorkingFiles() {
            const selectedDirectory = path.resolve(appRoot, workingDirectory);
            await mkdir(selectedDirectory, {recursive: true});
            request.signal.throwIfAborted();
            record.directory = await mkdtemp(path.join(selectedDirectory, 'arcane-model-'));
            record.members = members.map(function memberRecord(member) {
                const nativePath = path.resolve(record.directory, member.path);
                const relative = path.relative(record.directory, nativePath);
                // A projection consists of files under its one owned directory.
                // Absolute or escaping members cannot participate in that lifetime.
                if (path.isAbsolute(member.path) || !relative || relative === '..'
                    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                    throw new TypeError('Model asset member paths must be relative files within their projection.');
                }
                return {path: member.path, nativePath, handle: null, tail: Promise.resolve()};
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
            const task = member.tail.then(async function appendOriginalContent() {
                request.signal.throwIfAborted();
                if (!record.preparationOwned) throw failure('MODEL_ASSET_PROJECTION_RELEASED', 'Model asset preparation was released.');
                await member.handle.appendFile(Buffer.from(contentBase64, 'base64'));
                request.signal.throwIfAborted();
            });
            // File writes remain ordered; unrelated member files write independently.
            member.tail = task.catch(function observeWriteFailure() {});
            await task;
            return {id, memberIndex, written: true};
        } catch (error) { return failedOperation(record, error); }
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
        name: 'model-assets', current, retain,
        start(serviceContext) { context = serviceContext; },
        methods: {
            'modelAssets.open': openProjection,
            'modelAssets.write': writeMember,
            'modelAssets.complete': completeProjection,
            'modelAssets.status': function status() { return current(); },
            'modelAssets.release': {
                lifetime: 'service',
                handle({id}) {
                    const record = projections.get(id);
                    return record ? releasePreparation(record) : {id, state: 'released'};
                }
            }
        },
        dispose
    };
}

export default createModelAssetService;
