import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PassThrough, Readable, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createDevelopmentCore} from '../src/core/development.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function retainCompletion(done) { resolve = done; });
    return {promise, resolve};
}

class Response extends Writable {
    text = '';
    status = null;
    headers = {};
    _write(chunk, encoding, done) {
        this.text += chunk.toString();
        done();
    }
    writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
    }
    flushHeaders() {}
    frames() {
        return this.text.split('\n\n').filter(Boolean).map(function eventFrame(line) {
            return JSON.parse(line.substring('data: '.length));
        });
    }
}

function request(url, method = 'GET', frame) {
    const incoming = Readable.from(frame === undefined ? [] : [JSON.stringify(frame)]);
    incoming.url = url;
    incoming.method = method;
    return incoming;
}

function rpc(id, method, parameters = {}) {
    return {protocol: CORE_PROTOCOL, type: 'request', id, method, parameters};
}

async function dispatch(core, client, frame) {
    const response = new Response();
    assert.equal(await core.handler(request(`/rpc?client=${client}`, 'POST', frame), response), true);
    return JSON.parse(response.text);
}

async function connect(core, client) {
    const response = new Response();
    assert.equal(await core.handler(request(`/events?client=${client}`), response), true);
    return response;
}

test('immediate Core close drains and disposes accepted definitions without starting them', async function immediateClose() {
    const lifecycle = [];
    const core = createDevelopmentCore({services: [{
        name: 'moon',
        start() { lifecycle.push('started'); },
        drain() { lifecycle.push('drained'); },
        dispose() { lifecycle.push('disposed'); }
    }]});
    const closing = core.close();
    assert.strictEqual(core.close(), closing);
    await assert.rejects(core.ready, {name: 'AbortError'});
    await closing;
    assert.deepEqual(lifecycle, ['drained', 'disposed']);
    assert.equal(core.current().state, 'closed');
    assert.equal(core.current().core.services[0].state, 'closed');
});

test('source Core composes app factories without local AI and preserves complete options/context', async function appServices(t) {
    const directory = fileURLToPath(new URL('../.arcane/core-development-fixtures/', import.meta.url));
    await mkdir(directory, {recursive: true});
    const root = await mkdtemp(path.join(directory, 'app-'));
    t.after(async function removeFixture() {
        assert.equal(path.dirname(root), directory.replace(/[\\/]$/u, ''));
        await rm(root, {recursive: true, force: true});
    });
    await writeFile(path.join(root, 'service.mjs'), `
export default function createService(options, context) {
    return {
        name: 'moon',
        methods: {
            'moon.read': function read(parameters) {
                return {options, selected: context.selected, appRoot: context.appRoot, parameters};
            }
        }
    };
}
`);
    const options = {message: '  Complete 🧀\r\nsecond line  ', other: [null, false, {value: 7}]};
    const core = createDevelopmentCore({
        appRoot: root,
        application: {id: 'moon'}, version: '1.0.0',
        serviceModules: [{module: 'service.mjs', options}],
        context: {selected: '  application location  '}
    });
    t.after(function closeCore() { return core.close(); });
    await core.ready;
    const result = await dispatch(core, 'document-a', rpc('one', 'moon.read', options));
    assert.equal(result.ok, true);
    assert.deepEqual(result.result, {options, selected: '  application location  ', appRoot: root, parameters: options});
    assert.deepEqual(core.current().core.services.map(function name(service) { return service.name; }), ['moon']);
    for (const url of ['/arcane-core.js', '/arcane-local-ai.js']) {
        const response = new Response();
        await core.handler(request(url), response);
        assert.equal(response.status, 200);
        assert.match(response.text, /export \{client\}/u);
        assert.match(response.text, /replayRuntimeState:true/u);
        assert.equal(response.text.includes('await installCoreClient'), false);
    }
    assert.equal(await core.handler(request('/ordinary-page.html'), new Response()), false);
});

test('Core request cancellation and responses stay with their document while accepted saves drain', async function documentLifetimes(t) {
    const aStarted = deferred();
    const bStarted = deferred();
    const bDone = deferred();
    const saveStarted = deferred();
    const saveDone = deferred();
    const lifecycle = [];
    let saveSignal;
    const core = createDevelopmentCore({services: [{
        name: 'moon',
        methods: {
            'moon.wait': async function wait(parameters, {signal}) {
                if (parameters.document === 'a') {
                    aStarted.resolve();
                    await new Promise(function waitForAbort(resolve) {
                        if (signal.aborted) resolve();
                        else signal.addEventListener('abort', resolve, {once: true});
                    });
                } else {
                    bStarted.resolve();
                    await bDone.promise;
                }
                return parameters;
            },
            'moon.save': {
                lifetime: 'service',
                async handle(parameters, {signal}) {
                    saveSignal = signal;
                    saveStarted.resolve();
                    await saveDone.promise;
                    lifecycle.push('saved');
                    return parameters;
                }
            }
        },
        drain() { lifecycle.push('drained'); },
        dispose() { lifecycle.push('disposed'); }
    }]});
    t.after(function releaseWaiters() {
        bDone.resolve();
        saveDone.resolve();
        return core.close();
    });
    await core.ready;
    const a = await connect(core, 'a');
    const b = await connect(core, 'b');
    const requestA = dispatch(core, 'a', rpc('a-request', 'moon.wait', {document: 'a'}));
    const requestB = dispatch(core, 'b', rpc('b-request', 'moon.wait', {document: 'b'}));
    const save = dispatch(core, 'a', rpc('save', 'moon.save', {content: 'complete saved value'}));
    await Promise.all([aStarted.promise, bStarted.promise, saveStarted.promise]);
    a.destroy();
    const cancelled = await requestA;
    assert.equal(cancelled.error.code, 'REQUEST_ABORTED');
    assert.equal(saveSignal.aborted, false);
    bDone.resolve();
    assert.deepEqual((await requestB).result, {document: 'b'});
    const closing = core.close();
    assert.strictEqual(core.close(), closing);
    assert.equal(saveSignal.aborted, false);
    saveDone.resolve();
    assert.deepEqual((await save).result, {content: 'complete saved value'});
    await closing;
    assert.deepEqual(lifecycle, ['saved', 'drained', 'disposed']);
    const ids = b.frames().filter(function response(frame) { return frame.type === 'response'; })
        .map(function requestId(frame) { return frame.id; });
    assert.deepEqual(ids, ['b-request']);
});

test('a late Core document receives current lifecycle and explicit app snapshots without historical responses', async function replayState(t) {
    const core = createDevelopmentCore({
        application: {id: 'moon'}, version: '1.0.0',
        services: [{name: 'moon', methods: {'moon.read': function read() { return 'complete'; }}}],
        getReplayEvents() { return [{event: 'moon.state', data: {value: 'current complete state'}}]; }
    });
    t.after(function closeCore() { return core.close(); });
    await core.ready;
    await dispatch(core, 'old', rpc('old', 'moon.read'));
    const late = await connect(core, 'late');
    await dispatch(core, 'late', {protocol: CORE_PROTOCOL, type: 'control', control: 'runtime.replay'});
    await core.close();
    const frames = late.frames();
    assert.equal(frames.some(function hasReady(frame) { return frame.event === 'core.ready'; }), true);
    assert.equal(frames.some(function hasSnapshot(frame) { return frame.event === 'moon.state' && frame.data.value === 'current complete state'; }), true);
    assert.equal(frames.some(function hasHistory(frame) { return frame.type === 'response'; }), false);
});

test('disconnect cancels an incomplete document POST before its method can run', async function partialRequest(t) {
    const diagnostics = [];
    let invoked = false;
    const core = createDevelopmentCore({
        onEvent(event) { diagnostics.push(event); },
        services: [{name: 'moon', methods: {'moon.save': function save() { invoked = true; }}}]
    });
    t.after(function closeCore() { return core.close(); });
    await core.ready;
    const events = await connect(core, 'departing');
    const body = new PassThrough();
    body.url = '/rpc?client=departing';
    body.method = 'POST';
    const response = new Response();
    const handling = core.handler(body, response);
    body.write('{"protocol":"arcane/1",');
    events.destroy();
    await handling;
    assert.equal(body.destroyed, true);
    assert.equal(invoked, false);
    assert.equal(diagnostics.some(function disconnected(event) {
        return event.error.code === 'CORE_DEV_DISCONNECTED';
    }), true);
});

test('factory preparation remains preparing and close joins slower sibling factories after failure', async function factoryLifetime(t) {
    const directory = fileURLToPath(new URL('../.arcane/core-development-fixtures/', import.meta.url));
    await mkdir(directory, {recursive: true});
    const root = await mkdtemp(path.join(directory, 'lifecycle-'));
    const entered = deferred();
    const failed = deferred();
    const complete = deferred();
    const disposed = [];
    await writeFile(path.join(root, 'failed.mjs'), `
export default function fail(options, context) {
    context.failed();
    throw new Error('The moon pantry failed to open.');
}
`);
    await writeFile(path.join(root, 'slow.mjs'), `
export default async function createService(options, context) {
    context.entered();
    await context.complete;
    return {name: 'slow', dispose() { context.disposed.push('slow'); }};
}
`);
    const core = createDevelopmentCore({
        appRoot: root,
        serviceModules: [{module: 'failed.mjs'}, {module: 'slow.mjs'}],
        context: {entered: entered.resolve, failed: failed.resolve, complete: complete.promise, disposed},
        onEvent() {}
    });
    t.after(async function cleanFixture() {
        complete.resolve();
        await core.close();
        assert.equal(path.dirname(root), directory.replace(/[\\/]$/u, ''));
        await rm(root, {recursive: true, force: true});
    });
    const rejected = assert.rejects(core.ready, /pantry failed/u);
    await Promise.all([entered.promise, failed.promise]);
    assert.equal(core.current().state, 'preparing');
    const closing = core.close();
    assert.deepEqual(disposed, []);
    complete.resolve();
    await rejected;
    await closing;
    assert.deepEqual(disposed, ['slow']);
});
