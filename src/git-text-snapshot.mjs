import Is from 'strong-type';
import {mkdir, readdir} from 'node:fs/promises';
import path from 'node:path';
import {runProcess} from './process.mjs';
import {ArcaneError, ERROR_CODES, throwIfAborted} from './errors.mjs';
import {createEventQueue} from './event-queue.mjs';

const is = new Is(false);
const snapshotRef = 'refs/arcane/text-snapshot';

/**
 * Read complete selected text from a fetched revision, never a working tree.
 * One application service owns each dedicated cache directory. Construction
 * performs no I/O; refresh coalesces callers and close drains accepted work.
 */
export function createGitTextSnapshot({cacheDirectory, remote, ref, selectPath, onEvent, run = runProcess} = {}) {
    for (const [name, value] of Object.entries({cacheDirectory, remote, ref})) {
        if (!is.string(value) || value === '') throw new TypeError(`${name} must be a nonempty string.`);
    }
    if (!is.function(selectPath)) throw new TypeError('selectPath must be a function.');
    const directory = path.resolve(cacheDirectory);
    let prepared = false;
    let retained = null;
    let active = null;
    let closing = null;

    async function git(args, options = {}) {
        let outputFailure;
        const execution = {...options};
        if (options.onOutput) {
            execution.onOutput = async function consumeGitOutput(record) {
                try { await options.onOutput(record); }
                catch (error) { outputFailure ??= error; throw error; }
            };
        }
        try {
            return await run('git', ['--git-dir', directory, ...args], execution);
        } catch (error) {
            // runProcess first drains its child and preserves complete transport
            // failures. Keep the Git parser's public code with that full cause.
            if (outputFailure instanceof ArcaneError) {
                throw new ArcaneError(outputFailure.code, outputFailure.message,
                    {details: outputFailure.details, cause: error});
            }
            throw error;
        }
    }

    async function prepare(events) {
        if (prepared) return;
        await mkdir(directory, {recursive: true});
        if ((await readdir(directory)).length === 0) {
            await run('git', ['init', '--bare', directory], {onEvent: events.send});
        }
        const result = await git(['rev-parse', '--is-bare-repository'], {onEvent: events.send});
        // This is the selected cache's functional role: never reinterpret an
        // existing working checkout as disposable object-cache storage.
        if (result.stdout.trim() !== 'true') {
            throw new ArcaneError('ARCANE_GIT_SNAPSHOT_CACHE_INVALID', 'The snapshot cache must be a bare Git repository.');
        }
        prepared = true;
    }

    async function acquire() {
        const events = createEventQueue(onEvent);
        try {
            await events.send({type: 'git.snapshot.refreshing', message: 'Refreshing the selected repository revision.', data: {ref}});
            await prepare(events);
            await git(['fetch', '--no-tags', '--no-write-fetch-head', '--', remote, `+${ref}:${snapshotRef}`], {onEvent: events.send});
            const selected = await git(['rev-parse', '--verify', `${snapshotRef}^{commit}`], {onEvent: events.send});
            const revision = selected.stdout.trim();
            if (retained?.revision === revision) {
                await events.send({type: 'git.snapshot.completed', message: 'The selected repository revision is unchanged.', data: {revision, reused: true}});
                await events.drain();
                return retained;
            }

            const entries = [];
            let treeParts = [];
            await git(['ls-tree', '-r', '-z', '--full-tree', revision], {
                outputEncoding: {stdout: null},
                captureOutput: {stdout: false},
                emitOutputEvents: {stdout: false},
                onEvent: events.send,
                onOutput: async function readTree({stream, chunk}) {
                    if (stream !== 'stdout') return;
                    let start = 0;
                    for (let end = chunk.indexOf(0); end !== -1; end = chunk.indexOf(0, start)) {
                        treeParts.push(chunk.subarray(start, end));
                        const record = Buffer.concat(treeParts);
                        treeParts = [];
                        const tab = record.indexOf(9);
                        if (tab < 0) throw protocolError('Git returned an unreadable tree record.', {record});
                        const [mode, type, object] = record.subarray(0, tab).toString('ascii').split(' ');
                        const filename = decodeText(record.subarray(tab + 1), 'repository path');
                        if (await selectPath(filename)) {
                            if (type !== 'blob') throw new ArcaneError('ARCANE_GIT_SNAPSHOT_NOT_TEXT',
                                `The selected path is a ${type}, not a text blob.`, {details: {path: filename, mode, type}});
                            entries.push({path: filename, object});
                        }
                        start = end + 1;
                    }
                    if (start < chunk.length) treeParts.push(chunk.subarray(start));
                }
            });
            if (treeParts.length) throw protocolError('Git ended before its tree record delimiter.', {record: Buffer.concat(treeParts)});

            const reader = createBlobReader(entries);
            if (entries.length) {
                async function* requestedObjects() {
                    for (const entry of entries) yield `${entry.object}\n`;
                }
                await git(['cat-file', '--batch'], {
                    input: requestedObjects(),
                    outputEncoding: {stdout: null},
                    captureOutput: {stdout: false},
                    emitOutputEvents: {stdout: false},
                    onEvent: events.send,
                    onOutput: function readBlobs({stream, chunk}) {
                        if (stream === 'stdout') reader.write(chunk);
                    }
                });
            }
            const result = {revision, files: reader.finish()};
            await events.send({type: 'git.snapshot.completed', message: 'Repository text snapshot is ready.', data: {revision, reused: false}});
            await events.drain();
            retained = result;
            return result;
        } catch (error) {
            try {
                await events.send({type: 'git.snapshot.failed', message: 'Repository text snapshot failed.', data: {error}});
                await events.drain();
            } catch (observerError) {
                if (observerError !== error) throw new AggregateError([error, observerError], 'Snapshot operation and event delivery failed.');
            }
            throw error;
        }
    }

    function refresh({signal} = {}) {
        try {
            throwIfAborted(signal);
            if (closing) throw new ArcaneError('CORE_CLOSING', 'The Git snapshot owner is closing.');
        } catch (error) {
            return Promise.reject(error);
        }
        if (!active) {
            // Install ownership before an observer can issue another refresh.
            active = Promise.resolve().then(acquire);
            const accepted = active;
            function settled() { if (active === accepted) active = null; }
            accepted.then(settled, settled);
        }
        return waitForSnapshot(active, signal).then(function copyResult(snapshot) {
            return {revision: snapshot.revision, files: snapshot.files.map(function copyFile(file) { return {...file}; })};
        });
    }

    function close() {
        if (!closing) {
            closing = (active ?? Promise.resolve()).then(function drained() { retained = null; });
        }
        return closing;
    }

    return {refresh, close, drain: close, dispose: close};
}

function waitForSnapshot(operation, signal) {
    if (!signal) return operation;
    return new Promise(function wait(resolve, reject) {
        function abort() {
            signal.removeEventListener('abort', abort);
            reject(new ArcaneError(ERROR_CODES.cancelled, 'The snapshot caller was cancelled.', {cause: signal.reason, exitCode: 130}));
        }
        signal.addEventListener('abort', abort, {once: true});
        operation.then(function completed(result) {
            signal.removeEventListener('abort', abort);
            if (!signal.aborted) resolve(result);
        }, function failed(error) {
            signal.removeEventListener('abort', abort);
            if (!signal.aborted) reject(error);
        });
        if (signal.aborted) abort();
    });
}

function decodeText(input, filename) {
    try {
        // ignoreBOM preserves an authored leading U+FEFF instead of consuming it.
        return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(input);
    } catch (cause) {
        throw new ArcaneError('ARCANE_GIT_SNAPSHOT_NOT_TEXT', 'The selected Git content cannot be represented as UTF-8 text.',
            {cause, details: {path: filename}});
    }
}

function protocolError(message, details) {
    return new ArcaneError('ARCANE_GIT_SNAPSHOT_PROTOCOL', message, {details});
}

function createBlobReader(entries) {
    const files = [];
    let headerParts = [];
    let state = 'header';
    let remaining = 0n;
    let content = [];
    let decoder;

    function write(chunk) {
        let offset = 0;
        while (offset < chunk.length) {
            if (state === 'header') {
                const newline = chunk.indexOf(10, offset);
                if (newline === -1) { headerParts.push(chunk.subarray(offset)); return; }
                headerParts.push(chunk.subarray(offset, newline));
                const header = Buffer.concat(headerParts).toString('ascii');
                headerParts = [];
                const [object, type, extent] = header.split(' ');
                const entry = entries[files.length];
                if (!entry || object !== entry.object || type !== 'blob' || !/^\d+$/u.test(extent)) {
                    throw protocolError('Git returned an unexpected blob response.', {header, path: entry?.path});
                }
                // Git requires this encoded extent to delimit the raw body.
                // It never enters product metadata, admission or progress.
                remaining = BigInt(extent);
                decoder = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});
                content = [];
                offset = newline + 1;
                state = remaining === 0n ? 'delimiter' : 'body';
            } else if (state === 'body') {
                const available = chunk.length - offset;
                const taking = remaining < BigInt(available) ? Number(remaining) : available;
                try {
                    content.push(decoder.decode(chunk.subarray(offset, offset + taking), {stream: true}));
                } catch (cause) {
                    throw new ArcaneError('ARCANE_GIT_SNAPSHOT_NOT_TEXT', 'The selected Git blob is not UTF-8 text.',
                        {cause, details: {path: entries[files.length].path}});
                }
                offset += taking;
                remaining -= BigInt(taking);
                if (remaining === 0n) state = 'delimiter';
            } else {
                if (chunk[offset] !== 10) throw protocolError('Git returned an unreadable blob delimiter.', {path: entries[files.length].path});
                try { content.push(decoder.decode()); }
                catch (cause) {
                    throw new ArcaneError('ARCANE_GIT_SNAPSHOT_NOT_TEXT', 'The selected Git blob ended inside a UTF-8 character.',
                        {cause, details: {path: entries[files.length].path}});
                }
                files.push({path: entries[files.length].path, content: content.join('')});
                offset += 1;
                state = 'header';
            }
        }
    }

    function finish() {
        if (state !== 'header' || headerParts.length || files.length !== entries.length) {
            throw protocolError('Git ended before all requested text blobs were returned.', {paths: entries.map(function filename(entry) { return entry.path; })});
        }
        return files;
    }

    return {write, finish};
}
