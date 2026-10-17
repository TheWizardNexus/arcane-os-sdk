import {mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, rmdir, stat, unlink, writeFile} from 'node:fs/promises';
import {watch} from 'node:fs';
import {randomUUID} from 'node:crypto';
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
            return member.path === right[index].path && member.url === right[index].url
                && member.archiveMember === right[index].archiveMember;
        });
}

function selectedSources(members = [], archives = []) {
    const selected = members.map(function ordinaryMember(member) { return {path: member.path, url: member.url}; });
    for (const archive of archives) {
        if (archive.format !== 'tar') throw new TypeError('Model asset archives require the uncompressed tar format.');
        for (const member of archive.members) {
            selected.push({path: member.path, url: archive.url, archiveMember: member.member});
        }
    }
    return selected;
}

async function memberAvailability(directory, members, signal) {
    const result = [];
    for (const member of members) {
        signal?.throwIfAborted();
        const location = memberLocation(directory, member);
        let available;
        try { available = (await stat(location.nativePath)).isFile(); }
        catch (error) { if (error.code !== 'ENOENT') throw error; available = false; }
        result.push({...location, available});
    }
    return result;
}

function discoveryRecord(directory, members, source, catalog, entryPath) {
    const missingMembers = members.filter(function missing(member) { return !member.available; })
        .map(function memberPath(member) { return member.path; });
    return {directory, entryPath: entryPath ?? members[0]?.path, members, missingMembers,
        complete: missingMembers.length === 0, source, ...(catalog ? {catalogId: catalog.id} : {})};
}

function groupedMembers(members) {
    const groups = [];
    const shards = new Map();
    for (const member of members) {
        const filename = path.basename(member.path);
        const split = /^(.*)-(\d+)-of-(\d+)(\.gguf)$/i.exec(filename);
        if (!split) {
            groups.push({members: [member], gguf: /\.gguf$/i.test(filename), entryPath: member.path});
            continue;
        }
        const total = Number(split[3]);
        if (!Number.isSafeInteger(total) || total < 1) {
            throw failure('MODEL_ASSET_SHARDS_UNREADABLE', `The split GGUF member count is unreadable: ${member.path}`);
        }
        const directory = member.path.substring(0, member.path.length - filename.length);
        const key = `${directory}${split[1]}-of-${split[3]}${split[4]}`;
        if (!shards.has(key)) {
            const group = {members: [], observed: new Map(), gguf: true, total, directory,
                prefix: split[1], width: split[2].length, totalText: split[3], extension: split[4]};
            shards.set(key, group);
            groups.push(group);
        }
        shards.get(key).observed.set(Number(split[2]), member);
    }
    for (const group of shards.values()) {
        for (let index = 1; index <= group.total; index += 1) {
            group.members.push(group.observed.get(index) ?? {path: `${group.directory}${group.prefix}-${String(index).padStart(group.width, '0')}-of-${group.totalText}${group.extension}`});
        }
        // Preserve any supplied out-of-sequence member instead of dropping it.
        for (const [index, member] of group.observed) if (index < 1 || index > group.total) group.members.push(member);
        group.entryPath = group.members[0].path;
    }
    return groups;
}

function discoveryEntry(groups, selected) {
    if (selected) {
        const group = groups.find(function selectedGroup(candidate) {
            return candidate.members.some(function selectedMember(member) { return member.path === selected; });
        });
        return group?.observed ? group.entryPath : selected;
    }
    return groups.find(function modelGroup(group) { return group.gguf; })?.entryPath ?? groups[0]?.entryPath;
}

async function discoverDirectories(appRoot, {directories, catalog = [], recursive = true, signal} = {}) {
    if (!is.array(directories)) throw new TypeError('Model discovery requires explicit directories.');
    const roots = [];
    const models = [];
    const visited = new Set();
    const candidates = new Set();
    const claimed = new Set();
    const selections = catalog.map(function catalogSelection(item) {
        return {id: item.id, entryPath: item.entryPath, members: selectedSources(item.members, item.archives)};
    });

    function add(record) {
        const key = JSON.stringify([record.directory, record.members.map(function memberPath(member) { return member.path; })]);
        if (candidates.has(key)) return;
        candidates.add(key);
        models.push(record);
    }

    async function scan(directory, root = false) {
        signal?.throwIfAborted();
        let entries;
        try { entries = await readdir(directory, {withFileTypes: true}); }
        catch (error) {
            if (!root) throw error;
            roots.push({directory, exists: error.code !== 'ENOENT', ...(error.code === 'ENOENT' ? {} : {error: serializeCoreError(error)})});
            return;
        }
        if (root) roots.push({directory, exists: true});
        const canonical = await realpath(directory);
        if (visited.has(canonical)) return;
        visited.add(canonical);
        entries.sort(function byName(left, right) { return left.name.localeCompare(right.name); });
        const linked = new Map();
        for (const entry of entries) {
            if (!entry.isSymbolicLink()) continue;
            signal?.throwIfAborted();
            try { linked.set(entry, await stat(path.join(directory, entry.name))); }
            catch (error) { if (error.code !== 'ENOENT') throw error; linked.set(entry, null); }
        }
        let acquisition;
        let acquisitionComplete = false;
        if (path.basename(directory).startsWith('acquisition-')) {
            try { acquisition = JSON.parse(await readFile(path.join(directory, 'acquisition.json'), {encoding: 'utf8', signal})); acquisitionComplete = true; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (!acquisition) {
                try { acquisition = JSON.parse(await readFile(path.join(directory, 'transfer.json'), {encoding: 'utf8', signal})); }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    if (path.basename(path.dirname(directory)) === 'model-assets') return;
                }
            }
        }
        if (acquisition) {
            const files = path.join(directory, 'files');
            const groups = groupedMembers(acquisition.members);
            const members = await memberAvailability(files, groups.flatMap(function completeGroup(group) { return group.members; }), signal);
            const selection = selections.find(function matching(item) {
                return item.members.length === acquisition.members.length && item.members.every(function samePath(member, index) {
                    const original = acquisition.members[index];
                    return member.path === original.path && (member.url === undefined || member.url === original.url)
                        && (member.archiveMember === undefined || member.archiveMember === original.archiveMember);
                });
            });
            const record = discoveryRecord(files, members, 'acquisition', selection, discoveryEntry(groups, selection?.entryPath));
            if (!acquisitionComplete) record.complete = false;
            add(record);
            return;
        }
        for (const selection of selections) {
            const groups = groupedMembers(selection.members);
            const members = await memberAvailability(directory, groups.flatMap(function completeGroup(group) { return group.members; }), signal);
            if (!members.some(function present(member) { return member.available; })) continue;
            add(discoveryRecord(directory, members, 'catalog', selection, discoveryEntry(groups, selection.entryPath)));
            for (const member of members) claimed.add(member.nativePath);
        }
        const ggufMembers = entries.filter(function gguf(entry) {
            const file = linked.has(entry) ? linked.get(entry)?.isFile() ?? true : entry.isFile();
            return file && entry.name.toLowerCase().endsWith('.gguf') && !claimed.has(path.join(directory, entry.name));
        }).map(function memberPath(entry) { return {path: entry.name}; });
        for (const group of groupedMembers(ggufMembers)) {
            add(discoveryRecord(directory, await memberAvailability(directory, group.members, signal), 'directory', null, group.entryPath));
        }
        if (recursive) {
            for (const entry of entries) {
                if (linked.has(entry) ? linked.get(entry)?.isDirectory() : entry.isDirectory()) await scan(path.join(directory, entry.name));
            }
        }
    }

    for (const directory of directories) await scan(path.resolve(appRoot, directory), true);
    signal?.throwIfAborted();
    return {directories: roots, models};
}

async function storedAcquisitions(directory, members, signal) {
    const acquisitions = [];
    for (const entry of await readdir(directory, {withFileTypes: true})) {
        signal.throwIfAborted();
        if (!entry.isDirectory() || !entry.name.startsWith('acquisition-')) continue;
        const root = path.join(directory, entry.name);
        let selected;
        let committed = false;
        try { selected = JSON.parse(await readFile(path.join(root, 'acquisition.json'), {encoding: 'utf8', signal})); committed = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!selected) {
            try { selected = JSON.parse(await readFile(path.join(root, 'transfer.json'), {encoding: 'utf8', signal})); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        }
        if (!sameMembers(selected.members, members)) continue;
        nativeAcquisitionOrder = Math.max(nativeAcquisitionOrder, selected.order ?? 0);
        const files = path.join(root, 'files');
        const locations = members.map(function originalLocation(member) { return memberLocation(files, member); });
        const completedMembers = [];
        for (const [index, member] of locations.entries()) {
            signal.throwIfAborted();
            // Only an atomically promoted final filename is a completed member
            // in the resumable layout. Older completion records keep their meaning.
            try { if ((await stat(member.nativePath)).isFile()) completedMembers.push(index); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        acquisitions.push({root, name: entry.name, order: selected.order ?? 0, refresh: selected.refresh === true,
            complete: committed && completedMembers.length === members.length, completedMembers, directory: files, members: locations});
    }
    acquisitions.sort(function newestAcquisition(left, right) { return right.order - left.order || right.name.localeCompare(left.name); });
    return acquisitions;
}

async function saveAcquisitionState(root, name, record) {
    const pending = path.join(root, `${name}.${randomUUID()}.pending`);
    await writeFile(pending, JSON.stringify(record), {encoding: 'utf8', flag: 'wx'});
    await rename(pending, path.join(root, name));
}

function processExists(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

/** Atomic directory publication keeps an owner record visible with its lock. */
async function acquireDirectoryOwner(directory, name, signal, waiting) {
    const lock = path.join(directory, name);
    const candidate = await mkdtemp(path.join(directory, `${name}-candidate-`));
    const owner = {pid: process.pid, token: randomUUID(), acquiredAt: new Date().toISOString(),
        scope: lock, expires: 'When the recorded process exits; live ownership has no elapsed-time expiry.',
        release: 'Retire the owned directory atomically after owned I/O settles, then remove its own metadata.',
        recovery: 'A contender may recover this directory only after its recorded process has exited.'};
    let acquired = false;
    async function retireOwner(selectedLock) {
        const retired = path.join(directory, `${name}-released-${randomUUID()}`);
        await rename(selectedLock, retired);
        await unlink(path.join(retired, 'owner.json'));
        await rmdir(retired);
    }
    let acquisitionError;
    try {
        await writeFile(path.join(candidate, 'owner.json'), JSON.stringify(owner), {encoding: 'utf8', flag: 'wx'});
        while (!acquired) {
            signal.throwIfAborted();
            let notify;
            let rejectWait;
            const changed = new Promise(function observeOwnerChange(resolve, reject) { notify = resolve; rejectWait = reject; });
            changed.catch(function observeWaitRejection() {});
            const watcher = watch(directory, function ownerChanged() { notify(); });
            watcher.on('error', rejectWait);
            // A crashed process emits no filesystem event. This heartbeat checks
            // that exact owner, and also keeps a live wait observable to callers.
            const heartbeat = setTimeout(notify, 5000);
            heartbeat.unref?.();
            function aborted() { rejectWait(signal.reason); }
            signal.addEventListener('abort', aborted, {once: true});
            try {
                try { await rename(candidate, lock); acquired = true; }
                catch (error) {
                    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
                    let active;
                    try { active = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')); }
                    catch (readError) {
                        if (readError.code !== 'ENOENT') throw readError;
                        try {
                            // Empty ownerless directories can remain from an
                            // older interrupted release. rmdir cannot remove a
                            // newly published nonempty owner directory.
                            await rmdir(lock);
                            continue;
                        } catch (emptyError) {
                            if (emptyError.code === 'ENOENT') {
                                if (error.code === 'EPERM' || error.code === 'EACCES') throw error;
                                continue;
                            }
                            if (!['ENOTEMPTY', 'EEXIST'].includes(emptyError.code)) throw emptyError;
                        }
                    }
                    if (active && !processExists(active.pid)) {
                        let current;
                        try { current = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')); }
                        catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
                        // The old process may have released normally and then
                        // exited after our first read. Do not retire its successor.
                        if (current.token !== active.token) continue;
                        // Keep this nonempty operation record after recovery.
                        // A delayed contender for the same dead owner cannot
                        // replace it with a newly published live owner's lock.
                        const retired = path.join(directory, `${name}-exited-${active.token}`);
                        try { await rename(lock, retired); }
                        catch (recoveryError) {
                            if (recoveryError.code === 'ENOENT') continue;
                            if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(recoveryError.code)) throw recoveryError;
                            const recovered = JSON.parse(await readFile(path.join(retired, 'owner.json'), 'utf8'));
                            if (recovered.token !== active.token) throw recoveryError;
                        }
                        continue;
                    }
                    await waiting?.(active);
                    signal.throwIfAborted();
                    await changed;
                }
            } finally {
                clearTimeout(heartbeat);
                watcher.close();
                signal.removeEventListener('abort', aborted);
            }
        }
    } catch (error) { acquisitionError = error; throw error; }
    finally {
        if (!acquired) {
            try {
                try { await unlink(path.join(candidate, 'owner.json')); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
                await rmdir(candidate);
            } catch (error) {
                if (acquisitionError) throw new AggregateError([acquisitionError, error], 'Acquiring model ownership and releasing its candidate failed.');
                throw error;
            }
        }
    }
    return async function releaseDirectoryOwner() {
        const current = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
        if (current.token !== owner.token) throw failure('MODEL_ASSET_OWNER_CHANGED', 'Model acquisition ownership changed before release.');
        await retireOwner(lock);
    };
}

async function retainRestartedPart(attempt, memberIndex) {
    const partial = path.join(attempt, 'parts', `${memberIndex}.part`);
    const previous = path.join(attempt, 'parts', `${memberIndex}.previous.part`);
    try { await stat(previous); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        try { await rename(partial, previous); return; }
        catch (renameError) { if (renameError.code !== 'ENOENT') throw renameError; return; }
    }
    // Retain the earlier resumable original while replacing only this member's
    // failed replacement. Repeated retries do not accumulate duplicate parts.
    try { await unlink(partial); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function selectNativeAcquisition(entry, progress) {
    const {directory, members, controller, refresh} = entry;
    const {signal} = controller;
    const release = await acquireDirectoryOwner(directory, '.selection-owner', signal, function waitingForSelection() { progress('waiting'); });
    let selectionError;
    try {
        const stored = await storedAcquisitions(directory, members, signal);
        if (!refresh) {
            const complete = stored.find(function completeAcquisition(candidate) { return candidate.complete; });
            if (complete) return complete;
        }
        const resumable = stored.find(function incompleteAcquisition(candidate) { return !candidate.complete && (!refresh || candidate.refresh); });
        if (resumable) return resumable;
        const root = await mkdtemp(path.join(directory, 'acquisition-'));
        const files = path.join(root, 'files');
        await mkdir(files);
        await mkdir(path.join(root, 'parts'));
        const order = ++nativeAcquisitionOrder;
        await saveAcquisitionState(root, 'transfer.json', {members, order, refresh, completedMembers: [], transports: {}});
        return {root, order, refresh, complete: false, completedMembers: [], directory: files,
            members: members.map(function selectedMember(member) { return memberLocation(files, member); })};
    } catch (error) { selectionError = error; throw error; }
    finally {
        try { await release(); }
        catch (error) {
            if (selectionError) throw new AggregateError([selectionError, error], 'Selecting model assets and releasing selection ownership failed.');
            throw error;
        }
    }
}

async function fetchModelResponse(url, signal, range) {
    const response = await fetch(url, {signal, ...(range ? {headers: {Range: `bytes=${range.start}-${range.end}`}} : {})});
    if (!response.ok) {
        const error = failure('MODEL_ASSET_DOWNLOAD_FAILED', `Model asset request failed: ${response.status} ${response.statusText}`);
        error.url = url;
        error.status = response.status;
        error.response = await response.text();
        throw error;
    }
    if (!response.body) throw failure('MODEL_ASSET_DOWNLOAD_FAILED', `Model asset response has no content stream: ${url}`);
    if (range) {
        const contentRange = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/.exec(response.headers.get('content-range') ?? '');
        if (response.status !== 206 || !contentRange || Number(contentRange[1]) !== range.start || Number(contentRange[2]) !== range.end) {
            const error = failure('MODEL_ASSET_ARCHIVE_RANGE_FAILED', 'The archive server did not return the requested TAR segment.');
            error.url = url;
            error.status = response.status;
            try { await response.body.cancel(error); }
            catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Rejecting an unusable HTTP range and closing its response failed.'); }
            throw error;
        }
    }
    return response;
}

function tarName(name) { return name.replace(/^(?:\.\/)+/, ''); }

function tarText(header, start, end) {
    const field = header.subarray(start, end);
    const terminator = field.indexOf(0);
    return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8');
}

function paxFields(content) {
    const fields = {};
    let offset = 0;
    while (offset < content.length) {
        const space = content.indexOf(32, offset);
        const length = Number(content.subarray(offset, space).toString('ascii'));
        if (space === -1 || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > content.length) {
            throw failure('MODEL_ASSET_ARCHIVE_FORMAT', 'The TAR PAX record is incomplete or unreadable.');
        }
        const record = content.subarray(space + 1, offset + length - 1).toString('utf8');
        const equals = record.indexOf('=');
        if (equals !== -1) fields[record.substring(0, equals)] = record.substring(equals + 1);
        offset += length;
    }
    return fields;
}

// TAR framing and HTTP range offsets stay inside this transport reader. They
// never describe model readiness, download progress or content identity.
async function extractTarRange(response, range, selected, found, entry, progress, completeMember) {
    const {signal} = entry.controller;
    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    let ended = false;
    let localPax = {};
    let globalPax = {};
    let operationError;

    async function consume(length, consumePart, allowEnd = false) {
        let remaining = length;
        while (remaining) {
            signal.throwIfAborted();
            if (!pending.length && !ended) {
                const chunk = await reader.read();
                ended = chunk.done;
                if (!ended) { pending = Buffer.from(chunk.value); entry.activity(); }
            }
            if (!pending.length && ended) {
                if (allowEnd && remaining === length) return false;
                throw failure('MODEL_ASSET_ARCHIVE_INCOMPLETE', 'The TAR segment ended inside a member or header.');
            }
            const consumed = Math.min(remaining, pending.length);
            if (consumePart) await consumePart(pending.subarray(0, consumed));
            pending = pending.subarray(consumed);
            remaining -= consumed;
        }
        return true;
    }

    try {
        while (true) {
            const headers = [];
            if (!await consume(512, function headerPart(part) { headers.push(part); }, true)) break;
            const header = Buffer.concat(headers);
            if (header.every(function empty(value) { return value === 0; })) break;
            const type = String.fromCharCode(header[156]);
            const prefix = tarText(header, 345, 500);
            const name = tarText(header, 0, 100);
            const framingLength = Number.parseInt(tarText(header, 124, 136).trim(), 8);
            const length = type === 'x' || type === 'g' ? framingLength : Number(localPax.size ?? globalPax.size ?? framingLength);
            if (!Number.isSafeInteger(length) || length < 0) throw failure('MODEL_ASSET_ARCHIVE_FORMAT', 'The TAR member has unreadable framing.');
            if (type === 'x' || type === 'g') {
                const parts = [];
                await consume(length, function paxPart(part) { parts.push(part); });
                const fields = paxFields(Buffer.concat(parts));
                if (type === 'g') globalPax = {...globalPax, ...fields};
                else localPax = fields;
                await consume((512 - length % 512) % 512);
                continue;
            }
            const memberName = tarName(localPax.path ?? globalPax.path ?? (prefix ? `${prefix}/${name}` : name));
            localPax = {};
            if (range?.stopBefore && (memberName === range.stopBefore || path.posix.basename(memberName) === range.stopBefore)) break;
            const memberIndexes = selected.get(memberName);
            if (memberIndexes && (type === '0' || type === '\0')) {
                if (memberIndexes.some(function alreadyRead(index) { return found.has(index); })) {
                    throw failure('MODEL_ASSET_ARCHIVE_FORMAT', `The selected TAR member occurs more than once: ${memberName}`);
                }
                const handles = [];
                const errors = [];
                try {
                    for (const memberIndex of memberIndexes) {
                        const location = entry.location.members[memberIndex];
                        await mkdir(path.dirname(location.nativePath), {recursive: true});
                        const partial = await entry.archivePart(memberIndex);
                        handles.push(await open(partial, 'wx'));
                        progress('download', memberIndex);
                    }
                    await consume(length, async function originalMemberContent(content) {
                        const writes = await Promise.allSettled(handles.map(function appendOriginal(handle) { return handle.appendFile(content); }));
                        const failures = writes.filter(function failed(result) { return result.status === 'rejected'; }).map(function reason(result) { return result.reason; });
                        if (failures.length) throw new AggregateError(failures, 'Writing selected TAR member destinations failed.');
                        for (const memberIndex of memberIndexes) progress('download', memberIndex, true);
                    });
                } catch (error) { errors.push(error); }
                const closes = await Promise.allSettled(handles.map(function closeOriginal(handle) { return handle.close(); }));
                for (const result of closes) if (result.status === 'rejected') errors.push(result.reason);
                if (errors.length === 1) throw errors[0];
                if (errors.length) throw new AggregateError(errors, 'Extracting a model member and closing its files failed.');
                for (const memberIndex of memberIndexes) {
                    found.add(memberIndex);
                    await completeMember(memberIndex);
                }
            } else await consume(length);
            await consume((512 - length % 512) % 512);
        }
    } catch (error) { operationError = error; }
    try { if (!ended) await reader.cancel(operationError); }
    catch (error) { operationError = operationError ? new AggregateError([operationError, error], 'Reading a TAR segment and closing its response failed.') : error; }
    try { reader.releaseLock(); }
    catch (error) { operationError = operationError ? new AggregateError([operationError, error], 'Reading a TAR segment and releasing its reader failed.') : error; }
    if (operationError) throw operationError;
}

async function downloadNativeMember(entry, memberIndex, state, save, progress, completeMember, noteFailure) {
    const member = entry.members[memberIndex];
    const {signal} = entry.controller;
    const partial = path.join(entry.attempt, 'parts', `${memberIndex}.part`);
    let offset = 0;
    try { offset = (await stat(partial)).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const previous = state.transports[memberIndex];
    let response;
    let reader;
    let handle;
    let cancellation;
    let ended = false;
    let operationError;
    let remaining;

    async function restart(reason) {
        progress('restart', memberIndex, false, {reason});
        await retainRestartedPart(entry.attempt, memberIndex);
        offset = 0;
    }
    async function request(headers) {
        try { return await fetch(member.url, {signal, headers}); }
        catch (error) { noteFailure(error, 'interrupted'); throw error; }
    }
    function cancelReader() {
        if (!reader || ended) return;
        cancellation ??= reader.cancel(signal.reason);
        cancellation.catch(function observeReaderCancellation() {});
    }
    try {
        signal.throwIfAborted();
        if (offset && previous?.encoding && previous.encoding !== 'identity') await restart('The previous response used encoded HTTP content and cannot be appended by Range.');
        const validator = previous?.etag && !previous.etag.startsWith('W/') ? previous.etag : previous?.lastModified;
        if (offset && !validator) await restart('The source supplied no HTTP validator for continuing its earlier response.');
        const headers = {'Accept-Encoding': 'identity'};
        if (offset) {
            headers.Range = `bytes=${offset}-`;
            headers['If-Range'] = validator;
            progress('resume', memberIndex);
        } else progress('download', memberIndex);
        response = await request(headers);
        signal.throwIfAborted();
        if (offset && response.status === 416) {
            await response.body?.cancel();
            response = undefined;
            await restart('The server no longer accepts this saved HTTP range.');
            response = await request({'Accept-Encoding': 'identity'});
        }
        if (!response.ok) {
            const error = failure('MODEL_ASSET_DOWNLOAD_FAILED', `Model asset request failed: ${response.status} ${response.statusText}`);
            error.url = member.url;
            error.status = response.status;
            error.response = await response.text();
            noteFailure(error, response.status >= 500 || response.status === 408 || response.status === 429 ? 'interrupted' : 'failed');
            throw error;
        }
        if (!response.body) throw failure('MODEL_ASSET_DOWNLOAD_FAILED', `Model asset response has no content stream: ${member.url}`);
        if (offset && response.status === 200) await restart('The server returned the complete file instead of the saved HTTP range.');
        if (response.status === 206) {
            const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
            const encoding = response.headers.get('content-encoding');
            const validatorHeader = previous?.etag && !previous.etag.startsWith('W/') ? 'etag' : 'last-modified';
            const currentValidator = response.headers.get(validatorHeader);
            const changed = currentValidator && currentValidator !== validator;
            if (!offset || !range || Number(range[1]) !== offset || Number(range[2]) < offset
                || Number(range[2]) + 1 !== Number(range[3]) || (encoding && encoding !== 'identity') || changed) {
                const error = failure('MODEL_ASSET_DOWNLOAD_RANGE_FAILED', 'The server did not return the requested continuation of this model file.');
                error.url = member.url;
                error.status = response.status;
                throw error;
            }
            // Content-Range framing is private to this HTTP transfer. It never
            // participates in model identity, admission or user-facing progress.
            remaining = Number(range[2]) - Number(range[1]) + 1;
        }
        state.transports[memberIndex] = {
            etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
            encoding: response.headers.get('content-encoding')
        };
        await save();
        handle = await open(partial, 'a');
        reader = response.body.getReader();
        signal.addEventListener('abort', cancelReader, {once: true});
        if (signal.aborted) cancelReader();
        while (true) {
            signal.throwIfAborted();
            let chunk;
            try { chunk = await reader.read(); }
            catch (error) { noteFailure(error, 'interrupted'); throw error; }
            signal.throwIfAborted();
            if (chunk.done) { ended = true; break; }
            if (remaining !== undefined) {
                remaining -= chunk.value.byteLength;
                if (remaining < 0) throw failure('MODEL_ASSET_DOWNLOAD_RANGE_FAILED', 'The server exceeded its HTTP Content-Range.');
            }
            await handle.appendFile(chunk.value);
            progress('download', memberIndex, true);
        }
        if (remaining !== undefined && remaining !== 0) throw failure('MODEL_ASSET_DOWNLOAD_RANGE_FAILED', 'The server ended before its HTTP Content-Range.');
        signal.throwIfAborted();
    } catch (error) { operationError = error; noteFailure(error, 'failed'); }
    signal.removeEventListener('abort', cancelReader);
    try {
        if (reader && !ended) { cancellation ??= reader.cancel(operationError); await cancellation; }
        else if (!reader && response?.body && !response.bodyUsed && !response.body.locked) await response.body.cancel(operationError);
    } catch (error) {
        if (error !== operationError) operationError = operationError ? new AggregateError([operationError, error], 'Downloading a model member and closing its response failed.') : error;
    }
    try { reader?.releaseLock(); }
    catch (error) { operationError = operationError ? new AggregateError([operationError, error], 'Downloading a model member and releasing its reader failed.') : error; }
    try { await handle?.close(); }
    catch (error) { operationError = operationError ? new AggregateError([operationError, error], 'Downloading a model member and closing its file failed.') : error; }
    if (operationError) { noteFailure(operationError, 'failed'); throw operationError; }
    await completeMember(memberIndex);
}

async function acquireNativeMembers(entry) {
    const {members, controller} = entry;
    const {signal} = controller;
    let completed = 0;
    let firstFailure;
    let failureState;
    let releaseOwner;
    let state;
    let stateTail = Promise.resolve();
    let heartbeat;
    let acquisitionError;
    let lastActivity = Date.now();
    entry.activity = function receivedTransportContent() { lastActivity = Date.now(); };
    const activity = new Map();
    function noteFailure(error, selectedState) {
        if (firstFailure || signal.aborted) return;
        firstFailure = error;
        failureState = selectedState;
        controller.abort(error);
    }
    function save() {
        const next = stateTail.then(function saveTransferState() { return saveAcquisitionState(entry.attempt, 'transfer.json', state); });
        stateTail = next.catch(function observeStateFailure(error) { noteFailure(error, 'failed'); });
        return next;
    }
    function progress(phase, memberIndex, repeatedActivity = false, details = {}) {
        if (phase === 'download') lastActivity = Date.now();
        if (repeatedActivity) {
            const now = Date.now();
            if (now - (activity.get(memberIndex) ?? 0) < 1000) return;
            activity.set(memberIndex, now);
        }
        const selectedState = details.state ?? ({waiting: 'waiting', stalled: 'stalled', interrupted: 'interrupted',
            cancelled: 'cancelled', failed: 'failed', ready: 'ready'})[phase] ?? 'downloading';
        const messages = {
            waiting: 'Another application is preparing these model files. Waiting for its acquisition.',
            downloading: 'Downloading model files.', stalled: 'The model download is still open; no recent data has arrived.',
            interrupted: 'The model download was interrupted. Completed files and resumable data were kept.',
            cancelled: 'The model download was cancelled. Completed files and resumable data were kept.',
            failed: 'The model download failed. Existing files and resumable data were kept.', ready: 'Model files are ready.'
        };
        const notification = {phase, state: selectedState, message: phase === 'resume' ? 'Resuming the saved model download.'
            : phase === 'restart' ? 'Restarting this model file because its saved HTTP continuation is unavailable. Earlier partial data was retained.'
                : phase === 'reuse' ? 'Reusing downloaded model files.' : messages[selectedState],
            completed, total: members.length, unit: 'files',
            ...(memberIndex === undefined ? {} : {memberIndex, path: members[memberIndex].path}), ...details};
        if (['interrupted', 'cancelled', 'failed'].includes(selectedState)) notification.recovery = 'Retry to reuse completed files and continue saved downloads.';
        if (selectedState === 'stalled') notification.recovery = 'Wait for the source to respond, or cancel and retry later.';
        if (state) state.progress = notification;
        entry.publish(notification);
    }
    try {
        signal.throwIfAborted();
        const selected = await selectNativeAcquisition(entry, progress);
        entry.attempt = selected.root;
        entry.location = {directory: selected.directory, members: selected.members};
        if (selected.complete) {
            completed = members.length;
            progress('reuse');
            progress('ready');
            return entry.location;
        }
        signal.throwIfAborted();
        releaseOwner = await acquireDirectoryOwner(selected.root, '.transfer-owner', signal, async function waitingForTransfer() {
            try {
                const observed = JSON.parse(await readFile(path.join(selected.root, 'transfer.json'), 'utf8'));
                completed = observed.completedMembers?.length ?? 0;
                progress('waiting', undefined, false, {activity: observed.progress});
            } catch (error) { if (error.code !== 'ENOENT') throw error; progress('waiting'); }
        });
        const current = (await storedAcquisitions(entry.directory, members, signal)).find(function ownedAttempt(candidate) { return candidate.root === selected.root; });
        if (current?.complete) {
            completed = members.length;
            progress('reuse');
            progress('ready');
            return entry.location;
        }
        try { state = JSON.parse(await readFile(path.join(selected.root, 'transfer.json'), 'utf8')); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            state = {members, order: selected.order, refresh: selected.refresh, transports: {}};
        }
        state.transports ??= {};
        state.completedMembers = current?.completedMembers ?? [];
        const finished = new Set(state.completedMembers);
        completed = finished.size;
        await mkdir(path.join(selected.root, 'parts'), {recursive: true});
        progress('open');
        await save();
        heartbeat = setInterval(function reportTransferHeartbeat() {
            const stalled = Date.now() - lastActivity >= 15000;
            progress(stalled ? 'stalled' : 'heartbeat');
            save().catch(function observeHeartbeatFailure(error) { noteFailure(error, 'failed'); });
        }, 5000);
        heartbeat.unref?.();
        async function completeMember(memberIndex) {
            const location = entry.location.members[memberIndex];
            await mkdir(path.dirname(location.nativePath), {recursive: true});
            await rename(path.join(entry.attempt, 'parts', `${memberIndex}.part`), location.nativePath);
            finished.add(memberIndex);
            state.completedMembers = [...finished];
            completed = finished.size;
            await save();
            try { await unlink(path.join(entry.attempt, 'parts', `${memberIndex}.previous.part`)); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            progress('download', memberIndex);
        }
        entry.archivePart = async function prepareArchivePart(memberIndex) {
            const partial = path.join(entry.attempt, 'parts', `${memberIndex}.part`);
            try {
                await stat(partial);
                await retainRestartedPart(entry.attempt, memberIndex);
                progress('restart', memberIndex, false, {reason: 'The selected TAR segment must be replayed to recover its member framing.'});
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
            return partial;
        };
        if (completed) progress('reuse');
        const jobs = members.map(function ordinaryJob(member, memberIndex) {
            if (member.archiveMember !== undefined || finished.has(memberIndex)) return null;
            return async function downloadMember() {
                try { await downloadNativeMember(entry, memberIndex, state, save, progress, completeMember, noteFailure); }
                catch (error) { noteFailure(error, 'failed'); throw error; }
            };
        }).filter(Boolean);
        let archiveIndex = members.findIndex(function archiveMember(member) { return member.archiveMember !== undefined; });
        for (const archive of entry.archives) {
            const selected = new Map();
            for (const member of archive.members) {
                const memberIndex = archiveIndex++;
                if (finished.has(memberIndex)) continue;
                const name = tarName(member.member);
                if (!selected.has(name)) selected.set(name, []);
                selected.get(name).push(memberIndex);
            }
            if (!selected.size) continue;
            jobs.push(async function downloadArchiveMembers() {
                const found = new Set();
                try {
                    for (const range of archive.ranges ?? [undefined]) {
                        signal.throwIfAborted();
                        const response = await fetchModelResponse(archive.url, signal, range);
                        await extractTarRange(response, range, selected, found, entry, progress, completeMember);
                    }
                    const missing = [...selected.entries()].filter(function absent([name, indexes]) {
                        return indexes.some(function missingDestination(index) { return !found.has(index); });
                    })
                        .map(function memberName([name]) { return name; });
                    if (missing.length) {
                        const error = failure('MODEL_ASSET_ARCHIVE_MEMBERS_MISSING', 'The archive did not provide every selected model member.');
                        error.members = missing;
                        throw error;
                    }
                } catch (error) {
                    noteFailure(error, error.code?.startsWith('MODEL_ASSET_ARCHIVE_') ? 'failed' : 'interrupted');
                    throw error;
                }
            });
        }
        let nextJob = 0;
        const results = await Promise.allSettled(Array.from({length: Math.min(4, jobs.length)}, async function downloadWorker() {
            while (nextJob < jobs.length) {
                signal.throwIfAborted();
                await jobs[nextJob++]();
            }
        }));
        const failures = [...new Set(results.filter(function rejected(result) { return result.status === 'rejected'; })
            .map(function reason(result) { return result.reason; }))];
        if (failures.length > 1) throw new AggregateError(failures, 'Downloading model asset members failed.', {cause: firstFailure});
        if (failures.length) throw failures[0];
        signal.throwIfAborted();
        progress('complete');
        // The record describes a completed acquisition, not content identity.
        // Publish it after every stream and file close, leaving older entries alone.
        await save();
        signal.throwIfAborted();
        await saveAcquisitionState(entry.attempt, 'acquisition.json', {members, order: state.order, refresh: state.refresh});
        clearInterval(heartbeat);
        progress('ready');
        await save();
        return entry.location;
    } catch (error) {
        acquisitionError = error;
        clearInterval(heartbeat);
        progress(failureState ?? (signal.aborted ? 'cancelled' : 'failed'), undefined, false, {error: serializeCoreError(error)});
        if (state) {
            try { await save(); }
            catch (stateError) {
                acquisitionError = new AggregateError([error, stateError], 'Preparing model assets and retaining their interrupted state failed.');
                throw acquisitionError;
            }
        }
        throw error;
    } finally {
        clearInterval(heartbeat);
        await stateTail;
        try { await releaseOwner?.(); }
        catch (error) {
            if (acquisitionError) throw new AggregateError([acquisitionError, error], 'Preparing model assets and releasing their acquisition owner failed.');
            throw error;
        }
    }
}

function shareNativeAcquisition({directory, members, archives, refresh, signal, onProgress}) {
    signal.throwIfAborted();
    const key = JSON.stringify([directory, members, refresh]);
    let entry = nativeAcquisitions.get(key);
    if (entry?.controller.signal.aborted) {
        return entry.task.catch(function observeRetiringAcquisition() {}).then(function acquireAfterDrain() {
            return shareNativeAcquisition({directory, members, archives, refresh, signal, onProgress});
        });
    }
    if (!entry) {
        entry = {directory, members, archives, refresh, controller: new AbortController(), consumers: new Set(), task: null, location: null, progress: null};
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
    const preparations = new Map();
    let context;
    let closing;

    function snapshot(record) {
        return {
            id: record.id, directory: record.directory, state: record.state,
            members: record.members.map(function memberLocation(member) {
                return {path: member.path, nativePath: member.nativePath};
            }),
            preparationOwned: record.preparationOwned, uses: record.uses.size,
            error: record.error ? serializeCoreError(record.error) : null,
            ...(record.progress ? {progress: record.progress} : {})
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

    async function prepare({id, workingDirectory, members = [], archives = [], signal, onProgress, refresh = false} = {}) {
        const controller = new AbortController();
        const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const selectedMembers = selectedSources(members, archives);
        const record = beginProjection({id, workingDirectory, members: selectedMembers}, operationSignal);
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
            return shareNativeAcquisition({directory, members: selectedMembers, archives, refresh: refresh === true, signal: operationSignal,
                async onProgress(value, location) {
                    if (location) {
                        record.directory = location.directory;
                        record.members = location.members;
                    }
                    record.progress = value;
                    record.state = value.state;
                    publish(record);
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

    function discover(options) { return discoverDirectories(appRoot, options); }

    async function openExisting({id, directory, members, signal} = {}) {
        const controller = new AbortController();
        const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const record = beginProjection({id, workingDirectory: directory, members}, operationSignal);
        // Borrowed originals never become disposable working files, even when
        // opening fails or the caller releases while filesystem I/O is pending.
        record.persistent = true;
        record.downloadController = controller;
        record.opening = Promise.resolve().then(async function inspectExistingMembers() {
            record.directory = path.resolve(appRoot, directory);
            const locations = await memberAvailability(record.directory, members, operationSignal);
            const missing = locations.filter(function absent(member) { return !member.available; });
            if (missing.length) {
                const error = failure('MODEL_ASSET_MEMBERS_MISSING', 'The selected model has missing members.');
                error.members = missing.map(function memberPath(member) { return member.path; });
                throw error;
            }
            record.members = locations;
        });
        publish(record);
        try {
            await record.opening;
            operationSignal.throwIfAborted();
            record.state = 'ready';
            publish(record);
            return snapshot(record);
        } catch (error) { return failedOperation(record, error); }
    }

    function prepareRequest(params, request) {
        if (preparations.has(params.id)) throw failure('MODEL_ASSET_PROJECTION_ACTIVE', `Model asset preparation ${params.id} already exists.`);
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, controller.signal]);
        const operation = {controller, signal, task: null};
        preparations.set(params.id, operation);
        operation.task = prepare({...params, signal,
            onProgress(progress) { request.emit?.('modelAssets.progress', {id: params.id, progress}); }
        });
        // Retain failed completion until the caller's explicit cleanup control
        // joins it; local RPC cancellation alone settles before native cleanup.
        operation.task.then(function prepared() {
            preparations.delete(params.id);
        }, function preparationFailed() {
            if (!signal.aborted) preparations.delete(params.id);
        });
        return operation.task;
    }

    function cancellationOnly(error, reason) {
        return error === reason || (error instanceof AggregateError && error.errors.length > 0
            && error.errors.every(function cancellation(member) { return cancellationOnly(member, reason); }));
    }

    async function cancelPrepare({id}) {
        const operation = preparations.get(id);
        const errors = [];
        if (operation) {
            operation.controller.abort(failure('MODEL_ASSET_PROJECTION_RELEASED', 'Model asset preparation was cancelled.'));
            try { await operation.task; }
            catch (error) { if (!cancellationOnly(error, operation.signal.reason)) errors.push(error); }
            preparations.delete(id);
        }
        try { await release(id); } catch (error) { errors.push(error); }
        if (errors.length === 1) throw errors[0];
        if (errors.length) throw new AggregateError(errors, 'Cancelling native model preparation failed.');
        return {id, state: 'released'};
    }

    async function releaseRequest({id}) {
        const operation = preparations.get(id);
        if (operation && projections.get(id)?.state !== 'ready') return cancelPrepare({id});
        const result = await release(id);
        preparations.delete(id);
        return result;
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
            preparations.clear();
            if (errors.length) throw new AggregateError(errors, 'Closing model asset preparation failed.');
        });
        return closing;
    }

    return {
        name: 'model-assets', current, discover, openExisting, prepare, retain, release,
        start(serviceContext) { context = serviceContext; },
        methods: {
            'modelAssets.open': openProjection,
            'modelAssets.discover': function discoverRequest(params, request) { return discover({...params, signal: request.signal}); },
            'modelAssets.openExisting': function openExistingRequest(params, request) { return openExisting({...params, signal: request.signal}); },
            'modelAssets.prepare': prepareRequest,
            'modelAssets.cancelPrepare': {lifetime: 'service', handle: cancelPrepare},
            'modelAssets.write': writeMember,
            'modelAssets.complete': completeProjection,
            'modelAssets.status': function status() { return current(); },
            'modelAssets.release': {
                lifetime: 'service',
                handle: releaseRequest
            }
        },
        dispose
    };
}

export default createModelAssetService;
