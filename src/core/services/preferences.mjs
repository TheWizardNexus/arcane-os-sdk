import {mkdir, mkdtemp, open, readFile, rename, rmdir, unlink} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';

const is = new Is(false);

// A selected file has one read/modify/write order within this Core process,
// including when separate service instances select the same file.
const fileOperations = new Map();

/**
 * Native implementation of the existing Arcane.preferences methods.
 * The application selects its file; namespaces, defaults and preference schemas
 * remain with the caller. Factory construction performs no I/O.
 *
 * Writes have service lifetime. Once accepted, renderer cancellation cannot
 * discard them. drain()/dispose() stop acceptance and await owned operations.
 * Success follows a flushed file replacement, not a promise of filesystem
 * survival across every possible operating-system or hardware failure.
 */
export function createPreferencesService({file} = {}) {
    if (!is.string(file) || file === '') {
        throw new TypeError('Preferences require an application-selected file path.');
    }
    const filename = path.resolve(file);
    const pending = new Set();
    let closing = null;

    function accept(operation) {
        if (closing) {
            const error = new Error('The preferences service is closing.');
            error.code = 'CORE_CLOSING';
            return Promise.reject(error);
        }
        const result = orderFileOperation(filename, operation);
        pending.add(result);
        function releaseOperation() { pending.delete(result); }
        result.then(releaseOperation, releaseOperation);
        return result;
    }

    function list(parameters, {signal} = {}) {
        return accept(async function readKeys() {
            const document = await readPreferences(filename, signal);
            return {keys: Object.keys(document.entries).sort()};
        });
    }

    function get({key}, {signal} = {}) {
        return accept(async function readValue() {
            requireKey(key);
            const document = await readPreferences(filename, signal);
            const found = Object.hasOwn(document.entries, key);
            return {key, found, value: found ? document.entries[key] : null};
        });
    }

    function set({key, value}) {
        return accept(async function saveValue() {
            requireKey(key);
            const document = await readPreferences(filename);
            setEntry(document.entries, key, value);
            await writePreferences(filename, document);
            return {key, value};
        });
    }

    function setMany({entries}) {
        return accept(async function saveBatch() {
            if (!entries || !is.object(entries) || is.array(entries)) {
                throw new TypeError('Preference entries must be a JSON object.');
            }
            const document = await readPreferences(filename);
            const batch = Object.entries(entries);
            for (const [key, value] of batch) setEntry(document.entries, key, value);
            await writePreferences(filename, document);
            return {keys: batch.map(function entryKey([key]) { return key; }).sort(), count: batch.length};
        });
    }

    function deletePreference({key}) {
        return accept(async function removeValue() {
            requireKey(key);
            const document = await readPreferences(filename);
            const deleted = Object.hasOwn(document.entries, key);
            if (deleted) {
                delete document.entries[key];
                await writePreferences(filename, document);
            }
            return {key, deleted};
        });
    }

    function drain() {
        if (closing) return closing;
        closing = Promise.allSettled([...pending]).then(function operationsDrained(results) {
            const failures = results.filter(function failed(result) {
                return result.status === 'rejected';
            }).map(function reason(result) { return result.reason; });
            if (failures.length) throw new AggregateError(failures, 'Preference operations failed while draining.');
        });
        return closing;
    }

    return {
        name: 'preferences',
        methods: {
            'preferences.list': list,
            'preferences.get': get,
            'preferences.set': {lifetime: 'service', handle: set},
            'preferences.setMany': {lifetime: 'service', handle: setMany},
            'preferences.delete': {lifetime: 'service', handle: deletePreference}
        },
        drain,
        dispose: drain
    };
}

function orderFileOperation(file, operation) {
    const previous = fileOperations.get(file) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    function releaseQueue() {
        if (fileOperations.get(file) === tail) fileOperations.delete(file);
    }
    // The caller retains the rejecting result. This fulfilled scheduling tail
    // lets a later operation proceed after an earlier reported failure.
    const tail = result.then(releaseQueue, releaseQueue);
    fileOperations.set(file, tail);
    return result;
}

async function readPreferences(file, signal) {
    signal?.throwIfAborted();
    let source;
    try {
        source = await readFile(file, {encoding: 'utf8', signal});
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        signal?.throwIfAborted();
        return {schemaVersion: 1, entries: {}};
    }
    const document = JSON.parse(source);
    if (!document || document.schemaVersion !== 1 || !document.entries
        || !is.object(document.entries) || is.array(document.entries)) {
        throw new TypeError(`Preferences at ${file} do not contain the existing schemaVersion 1 entries record.`);
    }
    return document;
}

function requireKey(key) {
    if (!is.string(key)) throw new TypeError('A preference key must be a string.');
}

function setEntry(entries, key, value) {
    // Define an ordinary own data property: "__proto__" is a preference key,
    // not an instruction to change the entries object's prototype.
    Object.defineProperty(entries, key, {value, enumerable: true, writable: true, configurable: true});
}

function jsonValue(key, value) {
    const kind = typeof value;
    if (value === undefined || kind === 'function' || kind === 'symbol'
        || (kind === 'number' && !Number.isFinite(value))) {
        throw new TypeError(`Preference value at ${JSON.stringify(key)} cannot be represented completely in JSON.`);
    }
    return value;
}

async function writePreferences(file, document) {
    // Serialization happens before any filesystem write. The JSON boundary
    // reports unrepresentable values instead of silently omitting them.
    const source = JSON.stringify(document, jsonValue);
    const directory = path.dirname(file);
    await mkdir(directory, {recursive: true});
    const temporaryDirectory = await mkdtemp(path.join(directory, '.arcane-preferences-'));
    const temporary = path.join(temporaryDirectory, 'preferences.json');
    const failures = [];
    let handle = null;
    try {
        handle = await open(temporary, 'w');
        await handle.writeFile(source, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporary, file);
    } catch (error) {
        failures.push(error);
    } finally {
        if (handle) {
            try { await handle.close(); } catch (error) { failures.push(error); }
        }
        try { await unlink(temporary); } catch (error) {
            if (error.code !== 'ENOENT') failures.push(error);
        }
        try { await rmdir(temporaryDirectory); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Preference replacement and cleanup failed.');
}

export default createPreferencesService;
