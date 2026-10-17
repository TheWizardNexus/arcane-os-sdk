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
        if (path.basename(directory).startsWith('acquisition-')) {
            try { acquisition = JSON.parse(await readFile(path.join(directory, 'acquisition.json'), {encoding: 'utf8', signal})); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                if (path.basename(path.dirname(directory)) === 'model-assets') return;
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
            add(discoveryRecord(files, members, 'acquisition', selection, discoveryEntry(groups, selection?.entryPath)));
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
                if (!ended) pending = Buffer.from(chunk.value);
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
                        handles.push(await open(location.nativePath, 'wx'));
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
                    completeMember(memberIndex);
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

async function acquireNativeMembers(entry) {
    const {directory, members, controller} = entry;
    const {signal} = controller;
    let attempt;
    let completed = 0;
    let committed = false;
    let firstFailure;
    const activity = new Map();
    function progress(phase, memberIndex, repeatedActivity = false) {
        if (repeatedActivity) {
            const now = Date.now();
            if (now - (activity.get(memberIndex) ?? 0) < 1000) return;
            activity.set(memberIndex, now);
        }
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
        function completeMember(memberIndex) {
            completed += 1;
            progress('download', memberIndex);
        }
        const jobs = members.map(function ordinaryJob(member, memberIndex) {
            if (member.archiveMember !== undefined) return null;
            return async function downloadMember() {
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
                    response = await fetchModelResponse(member.url, signal);
                    bodyOwned = true;
                    for await (const content of response.body) {
                        signal.throwIfAborted();
                        await handle.appendFile(content);
                        progress('download', memberIndex, true);
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
                completeMember(memberIndex);
            };
        }).filter(Boolean);
        let archiveIndex = members.findIndex(function archiveMember(member) { return member.archiveMember !== undefined; });
        for (const archive of entry.archives) {
            const selected = new Map();
            for (const member of archive.members) {
                const name = tarName(member.member);
                if (!selected.has(name)) selected.set(name, []);
                selected.get(name).push(archiveIndex++);
            }
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
                    firstFailure ??= error;
                    controller.abort(error);
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
