import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createPreferencesService} from '../src/core/services/preferences.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

async function fixture(t) {
    const parent = fileURLToPath(new URL('../.arcane/test-core-preferences/', import.meta.url));
    await mkdir(parent, {recursive: true});
    const directory = await mkdtemp(path.join(parent, 'case-'));
    t.after(async function removeOwnedFixture() { await rm(directory, {recursive: true, force: true}); });
    return {directory, file: path.join(directory, 'preferences.json')};
}

function invoke(service, name, parameters = {}, context = {}) {
    const method = service.methods[`preferences.${name}`];
    return typeof method === 'function' ? method(parameters, context) : method.handle(parameters, context);
}

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(settle) { resolve = settle; });
    return {promise, resolve};
}

function request(id, method, parameters) {
    return {protocol: CORE_PROTOCOL, type: 'request', id, method, parameters};
}

test('preferences use the existing record and five RPC results without inventing app defaults', async function publicShapes(t) {
    const {directory, file} = await fixture(t);
    const service = createPreferencesService({file});
    t.after(function drainService() { return service.drain(); });
    assert.equal(service.name, 'preferences');
    assert.deepEqual(await invoke(service, 'list'), {keys: []});
    assert.deepEqual(await invoke(service, 'get', {key: 'moon.favoriteCheese'}), {
        key: 'moon.favoriteCheese', found: false, value: null
    });
    assert.deepEqual(await invoke(service, 'delete', {key: 'not-saved'}), {key: 'not-saved', deleted: false});
    await assert.rejects(readFile(file), {code: 'ENOENT'});

    const value = {text: '  Lunar cheddar 🦑\r\nKeep every line.  ', list: [false, 0, null, '', 1.25], nested: {theme: 'app-selected'}};
    assert.deepEqual(await invoke(service, 'set', {key: 'moon.favoriteCheese', value}), {key: 'moon.favoriteCheese', value});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {schemaVersion: 1, entries: {'moon.favoriteCheese': value}});
    assert.deepEqual(await invoke(service, 'get', {key: 'moon.favoriteCheese'}), {key: 'moon.favoriteCheese', found: true, value});
    assert.deepEqual(await invoke(service, 'setMany', {entries: {zebra: false, asteroid: null}}), {keys: ['asteroid', 'zebra'], count: 2});
    assert.deepEqual(await invoke(service, 'list'), {keys: ['asteroid', 'moon.favoriteCheese', 'zebra']});
    assert.deepEqual(await invoke(service, 'delete', {key: 'moon.favoriteCheese'}), {key: 'moon.favoriteCheese', deleted: true});
    assert.deepEqual(await invoke(service, 'get', {key: 'asteroid'}), {key: 'asteroid', found: true, value: null});
    assert.deepEqual(await readdir(directory), ['preferences.json']);
});

test('exact empty, whitespace, Unicode and prototype-like preference keys survive replacement', async function exactKeys(t) {
    const {file} = await fixture(t);
    const service = createPreferencesService({file});
    t.after(function drainService() { return service.drain(); });
    const entries = JSON.parse('{"__proto__":{"complete":"original"},"constructor":false,"prototype":null,"toString":"own value","":"empty key","  moon 🦑  ":"  exact value  "}');
    assert.deepEqual(await invoke(service, 'setMany', {entries}), {keys: Object.keys(entries).sort(), count: Object.keys(entries).length});
    const replacement = {text: 'Full replacement\n🦑'};
    assert.deepEqual(await invoke(service, 'set', {key: '__proto__', value: replacement}), {key: '__proto__', value: replacement});
    Object.defineProperty(entries, '__proto__', {value: replacement, enumerable: true, configurable: true, writable: true});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).entries, entries);
    for (const key of Object.keys(entries)) {
        assert.deepEqual(await invoke(service, 'get', {key}), {key, found: true, value: entries[key]});
    }
    assert.deepEqual(await invoke(service, 'delete', {key: '__proto__'}), {key: '__proto__', deleted: true});
    assert.deepEqual(await invoke(service, 'get', {key: '__proto__'}), {key: '__proto__', found: false, value: null});
    assert.deepEqual(await invoke(service, 'setMany', {entries: {}}), {keys: [], count: 0});
});

test('existing complete values and additional record metadata survive unrelated writes', async function preserveExisting(t) {
    const {file} = await fixture(t);
    const original = {
        schemaVersion: 1,
        applicationMetadata: {note: 'Keep this application-owned information exactly.\n🦑'},
        entries: {existing: {paragraphs: [' First ', '', ' Last '], numbers: [0, 1.75, -50], flags: [true, false, null]}}
    };
    await writeFile(file, JSON.stringify(original), 'utf8');
    const service = createPreferencesService({file});
    t.after(function drainService() { return service.drain(); });
    await invoke(service, 'set', {key: 'new', value: 'Complete new content'});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        ...original, entries: {...original.entries, new: 'Complete new content'}
    });
});

test('same-file service instances retain accepted mutation order and acknowledge saved content', async function sharedFileOrder(t) {
    const {directory, file} = await fixture(t);
    const first = createPreferencesService({file});
    const second = createPreferencesService({file: path.join(directory, '.', 'preferences.json')});
    t.after(async function drainServices() { await Promise.all([first.drain(), second.drain()]); });
    const operations = [
        invoke(first, 'set', {key: 'order', value: 'first'}),
        invoke(second, 'setMany', {entries: {order: 'second', companion: {saved: true}}}),
        invoke(first, 'delete', {key: 'order'}),
        invoke(second, 'set', {key: 'order', value: 'last'}),
        invoke(first, 'get', {key: 'order'})
    ];
    const results = await Promise.all(operations);
    assert.deepEqual(results[2], {key: 'order', deleted: true});
    assert.deepEqual(results[4], {key: 'order', found: true, value: 'last'});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        schemaVersion: 1, entries: {companion: {saved: true}, order: 'last'}
    });
});

test('malformed existing files report their parser error and remain untouched', async function malformedFile(t) {
    const {file} = await fixture(t);
    const original = '{"schemaVersion":1,"entries":{"moon":"every original character 🦑"';
    await writeFile(file, original, 'utf8');
    const service = createPreferencesService({file});
    t.after(function drainService() { return service.drain(); });
    let actual;
    await assert.rejects(invoke(service, 'set', {key: 'new', value: 'unsaved'}), function parserFailure(error) {
        actual = error;
        assert.ok(error instanceof SyntaxError);
        assert.equal(typeof error.stack, 'string');
        return true;
    });
    let expected;
    try { JSON.parse(original); } catch (error) { expected = error; }
    assert.equal(actual.message, expected.message);
    assert.equal(await readFile(file, 'utf8'), original);
    await writeFile(file, '{"schemaVersion":1,"entries":{"restored":"by application owner"}}', 'utf8');
    assert.deepEqual(await invoke(service, 'set', {key: 'new', value: 'now saved'}), {key: 'new', value: 'now saved'});
});

test('unreadable and unsupported existing records are not replaced by empty state', async function unreadableRecords(t) {
    const {directory, file} = await fixture(t);
    const occupiedPath = path.join(directory, 'directory-not-file');
    await mkdir(occupiedPath);
    const occupied = createPreferencesService({file: occupiedPath});
    const service = createPreferencesService({file});
    t.after(async function drainServices() { await Promise.all([occupied.drain(), service.drain()]); });
    let expected;
    try { await readFile(occupiedPath, 'utf8'); } catch (error) { expected = error; }
    assert.ok(expected);
    await assert.rejects(invoke(occupied, 'set', {key: 'new', value: true}), function filesystemFailure(error) {
        assert.equal(error.code, expected.code);
        assert.equal(error.syscall, expected.syscall);
        assert.equal(error.path, expected.path);
        assert.equal(error.message, expected.message);
        assert.equal(typeof error.stack, 'string');
        return true;
    });
    assert.deepEqual(await readdir(occupiedPath), []);
    for (const original of ['null', '{"schemaVersion":1,"entries":[]}', '{"schemaVersion":2,"entries":{"saved":"original"}}']) {
        await writeFile(file, original, 'utf8');
        await assert.rejects(invoke(service, 'set', {key: 'new', value: true}), TypeError);
        assert.equal(await readFile(file, 'utf8'), original);
    }
});

test('unrepresentable values fail before replacement instead of silently dropping content', async function jsonBoundary(t) {
    const {directory, file} = await fixture(t);
    const original = '{"schemaVersion":1,"entries":{"saved":"complete original"}}';
    await writeFile(file, original, 'utf8');
    const service = createPreferencesService({file});
    t.after(function drainService() { return service.drain(); });
    const circular = {};
    circular.self = circular;
    for (const value of [undefined, {nested: undefined}, [Infinity], {callable() {}}, {symbol: Symbol('not JSON')}, 1n, circular]) {
        await assert.rejects(invoke(service, 'set', {key: 'new', value}), TypeError);
        assert.equal(await readFile(file, 'utf8'), original);
    }
    await assert.rejects(invoke(service, 'setMany', {entries: {wouldSave: true, unavailable: undefined}}), TypeError);
    assert.equal(await readFile(file, 'utf8'), original);
    assert.deepEqual(await readdir(directory), ['preferences.json']);
});

test('queued preference reads honor cancellation without poisoning later writes', async function cancelledRead(t) {
    const {file} = await fixture(t);
    const service = createPreferencesService({file});
    t.after(function drainService() { return service.drain(); });
    const controller = new AbortController();
    const reason = new Error('The complete caller cancellation reason.\n🦑');
    controller.abort(reason);
    await assert.rejects(invoke(service, 'get', {key: 'moon'}, {signal: controller.signal}), function originalReason(error) {
        return error === reason;
    });
    await invoke(service, 'set', {key: 'moon', value: 'saved despite unrelated read cancellation'}, {signal: controller.signal});
    assert.deepEqual(await invoke(service, 'get', {key: 'moon'}), {
        key: 'moon', found: true, value: 'saved despite unrelated read cancellation'
    });
});

test('drain closes acceptance and waits for every already accepted preference write', async function directDrain(t) {
    const {file} = await fixture(t);
    const service = createPreferencesService({file});
    const saving = invoke(service, 'set', {key: 'moon', value: 'accepted before drain'});
    const batch = invoke(service, 'setMany', {entries: {last: 'also accepted'}});
    const closing = service.drain();
    assert.equal(service.drain(), closing);
    assert.equal(service.dispose(), closing);
    await assert.rejects(invoke(service, 'set', {key: 'tooLate', value: true}), {code: 'CORE_CLOSING'});
    await Promise.all([saving, batch, closing]);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        schemaVersion: 1, entries: {moon: 'accepted before drain', last: 'also accepted'}
    });
});

test('drain observes every accepted failure and retains the complete original errors', async function failedDrain(t) {
    const {file} = await fixture(t);
    const original = '{"schemaVersion":1,"entries":';
    await writeFile(file, original, 'utf8');
    const service = createPreferencesService({file});
    const outcomes = Promise.allSettled([
        invoke(service, 'set', {key: 'first', value: 'not saved'}),
        invoke(service, 'set', {key: 'second', value: 'also not saved'})
    ]);
    const closing = service.drain();
    let failure;
    await assert.rejects(closing, function drainedFailures(error) {
        failure = error;
        return error instanceof AggregateError;
    });
    const results = await outcomes;
    assert.deepEqual(results.map(function status(result) { return result.status; }), ['rejected', 'rejected']);
    assert.deepEqual(failure.errors, results.map(function reason(result) { return result.reason; }));
    assert.equal(await readFile(file, 'utf8'), original);
    assert.equal(service.dispose(), closing);
});

test('Core renderer cancellation and close retain accepted preference work through its saved response', async function coreLifecycle(t) {
    const {file} = await fixture(t);
    const service = createPreferencesService({file});
    for (const method of ['set', 'setMany', 'delete']) {
        assert.equal(service.methods[`preferences.${method}`].lifetime, 'service');
    }
    const entered = deferred();
    const release = deferred();
    const original = service.methods['preferences.set'].handle;
    let activeSignal;
    service.methods['preferences.set'].handle = async function holdFixtureWrite(parameters, context) {
        activeSignal = context.signal;
        entered.resolve();
        await release.promise;
        return original(parameters, context);
    };
    const runtime = createCoreRuntime({services: [service]});
    t.after(async function releaseRuntime() { release.resolve(); await runtime.close(); });
    runtime.start();
    const parameters = {key: 'moon', value: {text: 'Every accepted line\n🦑'}};
    const saving = runtime.handle(request('accepted-save', 'preferences.set', parameters));
    await entered.promise;
    await runtime.handle({protocol: CORE_PROTOCOL, type: 'control', control: 'requests.cancelAll'});
    assert.equal(activeSignal.aborted, false);
    const closing = runtime.close();
    assert.equal(runtime.current().state, 'draining');
    release.resolve();
    const response = await saving;
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, parameters);
    await closing;
    assert.equal(runtime.current().state, 'closed');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {schemaVersion: 1, entries: {moon: parameters.value}});
});
