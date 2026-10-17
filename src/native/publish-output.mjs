import {lstat, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {outputFile} from './portable-layout.mjs';

/** Publish only a complete native artifact, retaining the previous app until acceptance. */
export async function publishNativeOutput({sourceRoot, outputRoot, appId, bundle = false, signal, onPublished}) {
    const parent = path.resolve(outputRoot);
    const source = path.resolve(sourceRoot);
    const name = bundle ? `${appId}.app` : appId;
    // Keep valid application IDs usable on Windows without changing their
    // descriptor identity, including when another platform assembles the app.
    const outputName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) ? `_${name}` : name;
    const destination = outputFile(parent, outputName);
    if (path.dirname(destination) !== parent || source === destination) {
        throw new ArcaneError(ERROR_CODES.usage, 'Native publication requires a separate app-specific output child.');
    }
    const reservation = path.join(parent, `.arcane-publish-${path.basename(destination)}`);
    const backup = path.join(reservation, 'previous');
    const state = {sourceRoot: source, outputRoot: destination, reservation, backup, promoted: false, committed: false};
    throwIfAborted(signal);
    try { await mkdir(reservation); }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        throw new ArcaneError(ERROR_CODES.operationFailed,
            `Native output publication is already reserved at ${reservation}. Finish or recover that publication before retrying.`,
            {cause: error, details: state});
    }
    let previous = false;
    let failure;
    let retainReservation = false;
    try {
        // This short filesystem reservation protects only final replacement,
        // including across processes. Assembly and other apps stay independent.
        const acquiredAt = new Date();
        const ttlMs = 5 * 60 * 1000;
        await writeFile(path.join(reservation, 'owner.json'), JSON.stringify({
            pid: process.pid, acquiredAt: acquiredAt.toISOString(), expiresAt: new Date(acquiredAt.getTime() + ttlMs).toISOString(), ttlMs,
            sourceRoot: source, outputRoot: destination, reservation, backup,
            recovery: 'Expiry is informational and never permits automatic takeover. After the owning build has stopped, inspect both outputs. Restore previous if publication did not finish; preserve the current output if it did. Remove this reservation only after recovery.'
        }, null, 2) + '\n', {flag: 'wx'});
        throwIfAborted(signal);
        let existing;
        try { existing = await lstat(destination); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing) {
            // Replacement is scoped to this app's generated artifact, never a
            // cache, source directory, linked folder or unrelated user data.
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
                throw new ArcaneError(ERROR_CODES.usage, `Native output is not a replaceable app directory: ${destination}.`);
            }
            const manifestRoot = bundle ? path.join(destination, 'Contents', 'Resources') : destination;
            const manifest = JSON.parse(await readFile(path.join(manifestRoot, 'arcane-native.json'), 'utf8'));
            if (manifest.app?.id !== appId || !['arcane-portable-native', 'arcane-windows-native', 'arcane-macos-native'].includes(manifest.kind)) {
                throw new ArcaneError(ERROR_CODES.usage, `Native output belongs to a different artifact: ${destination}.`);
            }
            throwIfAborted(signal);
            await rename(destination, backup);
            previous = true;
        }
        throwIfAborted(signal);
        await rename(source, destination);
        state.promoted = true;
        throwIfAborted(signal);
        // Completion observers see the actual final paths. Their ordinary
        // rejection/cancellation still rolls back before the build is accepted.
        await onPublished?.(destination);
        throwIfAborted(signal);
        state.committed = true;
    } catch (error) {
        const failures = [error];
        if (state.promoted) {
            try {
                await rename(destination, source);
                state.promoted = false;
            } catch (restoreError) { failures.push(restoreError); }
        }
        if (previous && !state.promoted) {
            try {
                await rename(backup, destination);
                previous = false;
            } catch (restoreError) { failures.push(restoreError); }
        }
        retainReservation = failures.length > 1;
        failure = retainReservation
            ? new ArcaneError(ERROR_CODES.operationFailed,
                `Native output recovery is incomplete. Preserve and inspect ${destination}, ${source} and ${reservation}.`,
                {cause: new AggregateError(failures, 'Native publication and recovery failed.'), details: state})
            : error;
    }
    if (!retainReservation) {
        try { await rm(reservation, {recursive: true, force: true}); }
        catch (cleanupError) {
            failure = new ArcaneError(ERROR_CODES.operationFailed,
                `Native output ${state.committed ? 'was published' : 'was not accepted'}, and publication cleanup failed at ${reservation}.`,
                {cause: failure ? new AggregateError([failure, cleanupError], 'Native publication cleanup failed.') : cleanupError, details: state});
        }
    }
    if (failure) throw failure;
    return destination;
}
