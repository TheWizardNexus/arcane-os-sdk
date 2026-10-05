import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {PassThrough, Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {readCoreLaunchContext, startCoreHost} from '../src/core/host.mjs';
import {createCoreFrameDecoder, encodeCoreFrame} from '../src/core/stdio.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

const launchFixtureDirectory = fileURLToPath(new URL('../.arcane/core-launch-context-fixtures/', import.meta.url));

async function createLaunchFixture(t) {
    await mkdir(launchFixtureDirectory, {recursive: true});
    const root = await mkdtemp(path.join(launchFixtureDirectory, 'case-'));
    t.after(async function removeLaunchFixture() {
        const relative = path.relative(launchFixtureDirectory, root);
        assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        await rm(root, {recursive: true, force: true});
    });
    return root;
}

test('Core launch context reads only an explicit file and preserves every object field', async function explicitLaunchContext(t) {
    const root = await createLaunchFixture(t);
    const filename = path.join(root, 'moon cheese launch.json');
    const content = '{\r\n\t"appRoot": "  Explicit app root 🧀  ",\r\n\t"applicationURL": "https://moon.example/arrival?message=cheese",\r\n\t"unknownOwner": {"instructions": "  Café é 🦑\\r\\nFinal line.  ", "values": [null, false, 0, "", {"moon": "月"}]},\r\n\t"optional": null\r\n}\r\n';
    await writeFile(filename, content);

    assert.deepEqual(await readCoreLaunchContext({argv: []}), {});
    assert.deepEqual(await readCoreLaunchContext({argv: [filename]}), {});
    assert.deepEqual(await readCoreLaunchContext({argv: [`--arcane-launch-config=${filename}`]}), {});
    const context = await readCoreLaunchContext({argv: ['--unrelated', 'untouched', '--arcane-launch-config', filename]});
    assert.deepEqual(context, JSON.parse(content));
    assert.equal(await readFile(filename, 'utf8'), content);
});

test('Core launch context reports missing filenames and preserves file and JSON errors', async function launchContextFailures(t) {
    const root = await createLaunchFixture(t);
    const missing = path.join(root, 'not-created.json');
    for (const argv of [['--arcane-launch-config'], ['--arcane-launch-config', '']]) {
        await assert.rejects(readCoreLaunchContext({argv}), {
            name: 'TypeError', message: '--arcane-launch-config requires a filename.'
        });
    }
    await assert.rejects(readCoreLaunchContext({argv: ['--arcane-launch-config', missing]}), function originalFileError(error) {
        assert.equal(error.code, 'ENOENT');
        assert.equal(error.path, missing);
        return true;
    });
    const filename = path.join(root, 'launch.json');
    await writeFile(filename, '{"complete":');
    await assert.rejects(readCoreLaunchContext({argv: ['--arcane-launch-config', filename]}), {name: 'SyntaxError'});
    for (const content of ['null', '[]', '"moon cheese"', '42', 'false']) {
        await writeFile(filename, content);
        await assert.rejects(readCoreLaunchContext({argv: ['--arcane-launch-config', filename]}), {
            name: 'TypeError', message: 'Core launch configuration must be a JSON object.'
        });
    }
});

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(resolvePromise) { resolve = resolvePromise; });
    return {promise, resolve};
}

function request(id, method, parameters = {}) {
    return {protocol: CORE_PROTOCOL, type: 'request', id, method, parameters};
}

function createHostStreams(onFrame = function observeFrame() {}) {
    const frames = [];
    const input = new PassThrough();
    const decoder = createCoreFrameDecoder(function collectFrame(frame) {
        frames.push(frame);
        onFrame(frame);
    });
    const output = new Writable({
        write(chunk, encoding, callback) {
            decoder.push(chunk);
            callback();
        }
    });
    return {input, output, frames, decoder};
}

test('Core host readiness and independent service requests do not wait for another service startup', async function independentStartup(t) {
    const startReleased = deferred();
    const answered = deferred();
    const order = [];
    const failures = [];
    const application = {id: 'moon-cheese-catalog', name: 'Moon Cheese Catalog'};
    const streams = createHostStreams(function observeAnswer(frame) {
        if (frame.type === 'response' && frame.id === 'echo') answered.resolve(frame);
    });
    const host = startCoreHost({
        application,
        version: '1.2.3',
        input: streams.input,
        output: streams.output,
        onError(error) { failures.push(error); },
        services: [{
            name: 'observatory',
            async start() {
                order.push('observatory-starting');
                await startReleased.promise;
                order.push('observatory-ready');
            }
        }, {
            name: 'catalog',
            start() { order.push('catalog-ready'); },
            methods: {
                'catalog.echo': function echo(record) { return record; }
            }
        }]
    });
    t.after(async function releaseHost() {
        startReleased.resolve();
        await host.close();
        streams.input.destroy();
        streams.output.end();
    });

    assert.equal(host.runtime.current().state, 'ready');
    assert.equal(host.runtime.current().application, application);
    assert.equal(host.runtime.current().version, '1.2.3');
    const parameters = {text: '  Complete moon cheese notes: 🦑\r\nFinal line  ', nested: {value: null}};
    streams.input.write(encodeCoreFrame(request('echo', 'catalog.echo', parameters)));
    const response = await answered.promise;
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, parameters);
    assert.deepEqual(order, ['observatory-starting', 'catalog-ready']);
    assert.ok(streams.frames.some(function dispatcherReady(frame) { return frame.event === 'core.ready'; }));

    startReleased.resolve();
    const closing = host.close();
    assert.equal(closing, host.closed);
    assert.equal(host.close(), closing);
    assert.equal((await closing).state, 'closed');
    assert.deepEqual(order, ['observatory-starting', 'catalog-ready', 'observatory-ready']);
    assert.deepEqual(failures, []);
    streams.decoder.finish();
});

test('Core host abort drains an accepted save after renderer cancellation', async function abortDrainsAcceptedWork(t) {
    const saved = deferred();
    const saveAccepted = deferred();
    const searchAccepted = deferred();
    const searchReleased = deferred();
    const draining = deferred();
    const drainStarted = deferred();
    const drainReleased = deferred();
    const controller = new AbortController();
    const streams = createHostStreams();
    const failures = [];
    const order = [];
    let saveSignal;
    let searchSignal;
    let settled = false;
    const host = startCoreHost({
        input: streams.input,
        output: streams.output,
        signal: controller.signal,
        onError(error) { failures.push(error); },
        services: [{
            name: 'catalog',
            methods: {
                'catalog.save': {
                    lifetime: 'service',
                    async handle(record, context) {
                        saveSignal = context.signal;
                        saveAccepted.resolve();
                        await saved.promise;
                        order.push('saved');
                        return record;
                    }
                },
                'catalog.search': async function search(parameters, context) {
                    searchSignal = context.signal;
                    searchAccepted.resolve();
                    await searchReleased.promise;
                    return parameters;
                }
            },
            async drain() {
                order.push('drain');
                drainStarted.resolve();
                await drainReleased.promise;
            },
            dispose() { order.push('dispose'); }
        }]
    });
    t.after(async function releaseHost() {
        saved.resolve();
        searchReleased.resolve();
        drainReleased.resolve();
        await host.close();
        streams.input.destroy();
        streams.output.end();
    });
    host.runtime.subscribe(function observeDraining(state) {
        if (state.state === 'draining') draining.resolve();
    });
    function observeSettlement() { settled = true; }
    host.closed.then(observeSettlement, observeSettlement);
    const record = {name: 'Lunar cheddar', content: 'Every accepted line\nEvery accepted character 🦑'};
    streams.input.write(encodeCoreFrame(request('save', 'catalog.save', record)));
    streams.input.write(encodeCoreFrame(request('search', 'catalog.search', {query: 'moon'})));
    await Promise.all([saveAccepted.promise, searchAccepted.promise]);
    streams.input.write(encodeCoreFrame({protocol: CORE_PROTOCOL, type: 'control', control: 'requests.cancelAll'}));
    assert.equal(searchSignal.aborted, true);
    assert.equal(saveSignal.aborted, false);

    controller.abort(new Error('The native owner requested shutdown.'));
    await draining.promise;
    assert.equal(host.close(), host.closed);
    assert.equal(saveSignal.aborted, false);
    assert.equal(settled, false);
    searchReleased.resolve();
    saved.resolve();
    await drainStarted.promise;
    assert.deepEqual(order, ['saved', 'drain']);
    assert.equal(settled, false);
    drainReleased.resolve();

    assert.equal((await host.closed).state, 'closed');
    const saveResponse = streams.frames.find(function savedResponse(frame) { return frame.type === 'response' && frame.id === 'save'; });
    const searchResponse = streams.frames.find(function cancelledResponse(frame) { return frame.type === 'response' && frame.id === 'search'; });
    assert.deepEqual(saveResponse.result, record);
    assert.equal(saveResponse.ok, true);
    assert.equal(searchResponse.ok, false);
    assert.equal(searchResponse.error.code, 'REQUEST_ABORTED');
    assert.deepEqual(order, ['saved', 'drain', 'dispose']);
    assert.deepEqual(failures, []);
    assert.equal(streams.output.writableEnded, false);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    streams.decoder.finish();
});

test('an already aborted Core host still drains and disposes its services once', async function alreadyAbortedHost(t) {
    const controller = new AbortController();
    const streams = createHostStreams();
    const order = [];
    const failures = [];
    controller.abort();
    const host = startCoreHost({
        input: streams.input,
        output: streams.output,
        signal: controller.signal,
        onError(error) { failures.push(error); },
        services: [{
            name: 'catalog',
            start() { order.push('start'); },
            drain() { order.push('drain'); },
            dispose() { order.push('dispose'); }
        }]
    });
    t.after(function releaseStreams() { streams.input.destroy(); streams.output.end(); });
    assert.equal(host.close(), host.closed);
    assert.equal((await host.closed).state, 'closed');
    assert.deepEqual(order, ['start', 'drain', 'dispose']);
    assert.deepEqual(failures, []);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('Core host EOF releases its optional abort listener without owning output shutdown', async function eofReleasesListener(t) {
    const controller = new AbortController();
    const streams = createHostStreams();
    const failures = [];
    const host = startCoreHost({
        input: streams.input,
        output: streams.output,
        signal: controller.signal,
        onError(error) { failures.push(error); }
    });
    t.after(function releaseStreams() { streams.input.destroy(); streams.output.end(); });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    streams.input.end();
    assert.equal((await host.closed).state, 'closed');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(streams.output.writableEnded, false);
    assert.deepEqual(failures, []);
    controller.abort();
    assert.equal(host.close(), host.closed);
});

test('Core host preserves shutdown errors and removes abort subscription on failure', async function shutdownFailure(t) {
    const controller = new AbortController();
    const streams = createHostStreams();
    const failure = new Error('The complete catalog drain failure.\nFinal diagnostic line.');
    const failures = [];
    let disposed = false;
    const host = startCoreHost({
        input: streams.input,
        output: streams.output,
        signal: controller.signal,
        onError(error) { failures.push(error); },
        services: [{
            name: 'catalog',
            drain() { throw failure; },
            dispose() { disposed = true; }
        }]
    });
    t.after(function releaseStreams() { streams.input.destroy(); streams.output.end(); });
    const closing = host.close();
    assert.equal(closing, host.closed);
    await assert.rejects(closing, function completeShutdownFailure(error) {
        assert.equal(error.name, 'AggregateError');
        assert.deepEqual(error.errors, failures);
        assert.equal(error.errors[0].name, 'AggregateError');
        assert.deepEqual(error.errors[0].errors, [failure]);
        return true;
    });
    assert.equal(disposed, true);
    assert.equal(host.runtime.current().state, 'closed');
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(host.close(), closing);
});
