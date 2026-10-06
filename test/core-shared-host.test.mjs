import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PassThrough, Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {connectSharedCoreHost, startCoreListener, startSharedCoreHost, startSharedCoreBridge} from '../src/core/host.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {createCoreFrameDecoder, encodeCoreFrame, startCoreStdio} from '../src/core/stdio.mjs';

const fixtureRoot = fileURLToPath(new URL('../.arcane/shared-host-fixtures/', import.meta.url));
const hostModule = new URL('../src/core/host.mjs', import.meta.url).href;
const protocol = 'arcane/1';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function own(resolveValue, rejectValue) { resolve = resolveValue; reject = rejectValue; });
    return {promise, resolve, reject};
}
async function fixture(t) {
    await mkdir(fixtureRoot, {recursive: true});
    const root = await mkdtemp(path.join(fixtureRoot, 'case-'));
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\arcane-fixture-${path.basename(root)}` : path.join(root, 'core.sock');
    const cleanups = [];
    t.after(async function removeOwnedFixture() {
        for (const cleanup of cleanups.reverse()) await cleanup();
        await rm(root, {recursive: true, force: true});
    });
    return {root, endpoint, own(cleanup) { cleanups.push(cleanup); }};
}
async function rawPeer(endpoint) {
    const socket = createConnection(endpoint);
    const frames = [];
    const waiters = [];
    const errors = [];
    const decoder = createCoreFrameDecoder(function receive(frame) {
        frames.push(frame);
        for (const waiter of [...waiters]) if (waiter.select(frame)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(frame);
        }
    });
    socket.on('data', function data(chunk) { decoder.push(chunk); });
    socket.on('error', function error(cause) { errors.push(cause); });
    await once(socket, 'connect');
    return {
        frames, errors,
        send(frame) { socket.write(encodeCoreFrame({protocol, ...frame})); },
        next(select) {
            const previous = frames.find(select);
            if (previous) return Promise.resolve(previous);
            return new Promise(function wait(resolve) { waiters.push({select, resolve}); });
        },
        async close() { if (socket.closed) return; const closed = once(socket, 'close'); socket.end(); await closed; }
    };
}

test('borrowed listener reuses its runtime and preserves payload fields without owning shutdown', async function borrowedRuntime(t) {
    const {endpoint, own} = await fixture(t);
    const payload = {content: '  Every squid manifesto line.\r\n🦑  ', requestId: 'authored-id'};
    let starts = 0;
    let calls = 0;
    let emitted;
    const runtime = createCoreRuntime();
    runtime.registerService(
        {
            name: 'echo',
            start() { starts++; },
            methods: {
                'echo.read': function read(parameters, context) {
                    calls++;
                    emitted = {requestId: runtime.current().activeRequests[0].id, parameters};
                    context.emit('echo.progress', emitted);
                    return parameters;
                }
            }
        }
    );
    own(function closeRuntime() { return runtime.close(); });
    runtime.start();
    const listener = await startCoreListener({runtime, endpoint});
    own(function closeListener() { return listener.close(); });
    await assert.rejects(startCoreListener({runtime, endpoint, onError() {}}), {code: 'EADDRINUSE'});
    assert.equal(runtime.current().state, 'ready');
    const connection = await connectSharedCoreHost({endpoint, onError() {}});
    own(function closeConnection() { return connection.close(); });
    const progress = deferred();
    connection.client.events.on('echo.progress', progress.resolve);
    assert.deepEqual(await connection.client.invoke('echo.read', payload), payload);
    assert.deepEqual(await progress.promise, emitted);
    assert.equal(starts, 1);
    assert.equal(calls, 1);
    await assert.rejects(connection.client.invoke('core.host.shutdown'), {code: 'METHOD_NOT_ALLOWED'});
    await connection.close();
    assert.equal(runtime.current().state, 'ready');
    await listener.close();
    assert.equal(runtime.current().state, 'ready');
    assert.equal(listener.close(), listener.closed);
    assert.deepEqual((await runtime.handle({protocol, type: 'request', id: 'still-live', method: 'system.ping'})).result, {ok: true});
});

test('stdio and listener peers own correlation, replay and cancellation independently', async function attachedConnections(t) {
    const {endpoint, own} = await fixture(t);
    const accepted = new Map(['first', 'second', 'window'].map(function acceptance(owner) { return [owner, deferred()]; }));
    const gates = new Map(['first', 'second', 'window'].map(function completion(owner) { return [owner, deferred()]; }));
    const contexts = new Map();
    const windowAborted = deferred();
    const firstAborted = deferred();
    const windowAnswered = deferred();
    const windowFrames = [];
    const input = new PassThrough();
    const decoder = createCoreFrameDecoder(
        function collectWindowFrame(frame) {
            windowFrames.push(frame);
            if (frame.type === 'response') windowAnswered.resolve(frame);
        }
    );
    const output = new Writable({write(chunk, encoding, callback) { decoder.push(chunk); callback(); }});
    const runtime = createCoreRuntime(
        {
            services: [
                {
                    name: 'echo',
                    methods: {
                        'echo.wait': async function wait(parameters, context) {
                            contexts.set(parameters.owner, context);
                            if (parameters.owner === 'window') context.signal.addEventListener('abort', windowAborted.resolve, {once: true});
                            if (parameters.owner === 'first') context.signal.addEventListener('abort', firstAborted.resolve, {once: true});
                            accepted.get(parameters.owner).resolve();
                            await gates.get(parameters.owner).promise;
                            context.emit('echo.progress', parameters);
                            return parameters;
                        }
                    }
                }
            ]
        }
    );
    const host = startCoreStdio({runtime, input, output});
    own(
        async function closeAttachedFixture() {
            for (const gate of gates.values()) gate.resolve();
            await host.close();
            input.destroy();
            output.end();
        }
    );
    const listener = await startCoreListener({runtime, endpoint});
    own(async function closeAttachedListener() {
        for (const gate of gates.values()) gate.resolve();
        await listener.close();
    });
    const first = await rawPeer(endpoint);
    const second = await rawPeer(endpoint);
    own(function closeFirst() { return first.close(); });
    own(function closeSecond() { return second.close(); });
    first.send({type: 'request', id: 'same-id', method: 'echo.wait', parameters: {owner: 'first'}});
    second.send({type: 'request', id: 'same-id', method: 'echo.wait', parameters: {owner: 'second', requestId: 'leave-this-field'}});
    await Promise.all([accepted.get('first').promise, accepted.get('second').promise]);
    const collision = runtime.current().activeRequests[0].id;
    input.write(encodeCoreFrame({protocol, type: 'request', id: collision, method: 'echo.wait', parameters: {owner: 'window'}}));
    await accepted.get('window').promise;
    assert.equal(contexts.get('window').requestId, collision);
    assert.equal(contexts.get('window').clientRequestId, collision);
    assert.equal(contexts.get('first').requestId, 'same-id');
    assert.equal(contexts.get('first').clientRequestId, 'same-id');
    assert.equal(contexts.get('second').requestId, 'same-id');
    assert.equal(contexts.get('second').clientRequestId, 'same-id');
    assert.notEqual(contexts.get('first').coreRequestId, contexts.get('second').coreRequestId);
    assert.notEqual(contexts.get('window').coreRequestId, collision);
    input.write(encodeCoreFrame({protocol, type: 'control', control: 'requests.cancelAll'}));
    await windowAborted.promise;
    assert.equal(contexts.get('first').signal.aborted, false);
    assert.equal(contexts.get('second').signal.aborted, false);
    await first.close();
    await firstAborted.promise;
    assert.equal(contexts.get('second').signal.aborted, false);
    const beforeReplay = windowFrames.filter(function ready(frame) { return frame.event === 'core.ready'; }).length;
    second.send({type: 'control', control: 'runtime.replay'});
    await second.next(function ready(frame) { return frame.event === 'core.ready'; });
    assert.equal(windowFrames.filter(function ready(frame) { return frame.event === 'core.ready'; }).length, beforeReplay);
    for (const gate of gates.values()) gate.resolve();
    const answer = await second.next(function responseFrame(frame) { return frame.type === 'response'; });
    assert.equal(answer.id, 'same-id');
    assert.deepEqual(answer.result, {owner: 'second', requestId: 'leave-this-field'});
    assert.equal((await windowAnswered.promise).id, collision);
    assert.equal(windowFrames.some(function foreignEvent(frame) { return frame.event === 'echo.progress' && frame.data.owner !== 'window'; }), false);
    assert.equal(windowFrames.filter(function responseFrame(frame) { return frame.type === 'response'; }).length, 1);
    input.end();
    await Promise.all([host.closed, listener.closed]);
});

test('listener disconnect and explicit close retain accepted service work and window shutdown drains the endpoint', async function borrowedDrain(t) {
    const {endpoint, own} = await fixture(t);
    const accepted = deferred();
    const saved = deferred();
    const disposed = deferred();
    let serviceSignal;
    let completed = false;
    const runtime = createCoreRuntime(
        {
            services: [
                {
                    name: 'ledger',
                    methods: {
                        'ledger.save': {
                            lifetime: 'service',
                            async handle(parameters, {signal}) {
                                serviceSignal = signal;
                                accepted.resolve();
                                await saved.promise;
                                completed = true;
                                return parameters;
                            }
                        }
                    },
                    dispose() { disposed.resolve(); }
                }
            ]
        }
    );
    own(async function finishSave() { saved.resolve(); await runtime.close(); });
    runtime.start();
    const listener = await startCoreListener({runtime, endpoint});
    own(async function closeSaveListener() { saved.resolve(); await listener.close(); });
    const peer = await rawPeer(endpoint);
    own(function closePeer() { return peer.close(); });
    peer.send({type: 'request', id: 'save', method: 'ledger.save', parameters: {content: 'Complete lunar ledger'}});
    await accepted.promise;
    await peer.close();
    await listener.close();
    assert.equal(serviceSignal.aborted, false);
    assert.equal(completed, false);
    assert.equal(runtime.current().state, 'ready');
    const replacement = await startCoreListener({runtime, endpoint});
    own(async function closeReplacement() { saved.resolve(); await replacement.close(); });
    const closing = runtime.close();
    await assert.rejects(startSharedCoreHost({endpoint}), {code: 'EADDRINUSE', coreHostPhase: 'listen'});
    assert.equal(serviceSignal.aborted, false);
    saved.resolve();
    await Promise.all([closing, replacement.closed, disposed.promise]);
    assert.equal(completed, true);
});

test('shared host claims before factories and replays current lifecycle without duplicating the owner', async function claimAndReplay(t) {
    const {endpoint, own} = await fixture(t);
    let factories = 0;
    let disposals = 0;
    const host = await startSharedCoreHost({endpoint, application: {id: 'moon-cheese'}, version: '1.0.0',
        configure(runtime) {
            factories++;
            runtime.registerService({name: 'catalog', methods: {'catalog.read': function read() { return ['Complete lunar cheese ledger 🧀']; }},
                dispose() { disposals++; }});
        },
        getReplayEvents() { return [{event: 'catalog.current', data: {revision: 'full current value'}}]; }
    });
    own(function closeHost() { return host.close(); });
    await assert.rejects(startSharedCoreHost({endpoint, configure() { factories++; }}), {code: 'EADDRINUSE', coreHostPhase: 'listen'});
    const first = await connectSharedCoreHost({endpoint, onError() {}});
    own(function closeFirst() { return first.close(); });
    const current = deferred();
    first.client.events.on('catalog.current', current.resolve);
    assert.deepEqual(await current.promise, {revision: 'full current value'});
    assert.deepEqual(await first.client.invoke('catalog.read'), ['Complete lunar cheese ledger 🧀']);
    await first.close();
    assert.equal(host.runtime.current().state, 'ready');
    assert.equal(disposals, 0);
    const second = await connectSharedCoreHost({endpoint, onError() {}});
    own(function closeSecond() { return second.close(); });
    assert.deepEqual(await second.client.invoke('app.current'), {id: 'moon-cheese'});
    assert.equal(factories, 1);
    assert.deepEqual(await second.shutdown(), {state: 'closed'});
    await host.closed;
    assert.equal(disposals, 1);
});

test('equal request IDs remain connection-local and complete payloads and correlated events retain their order', async function correlation(t) {
    const {endpoint, own} = await fixture(t);
    const gates = new Map([['first', deferred()], ['second', deferred()]]);
    const contexts = new Map();
    const accepted = deferred();
    let calls = 0;
    const host = await startSharedCoreHost({endpoint, configure(runtime) {
        runtime.registerService({name: 'echo', methods: {'echo.wait': async function wait(parameters, context) {
            contexts.set(parameters.owner, context);
            if (++calls === 2) accepted.resolve();
            await gates.get(parameters.owner).promise;
            const chunk = {requestId: context.requestId, content: parameters.content};
            context.emit('echo.chunk', chunk);
            chunk.content = 'Later owner mutation must not rewrite an accepted frame.';
            context.emit('echo.stream', {streamId: parameters.streamId, chunk: {content: parameters.content}});
            return parameters;
        }}});
    }});
    own(function closeHost() { for (const gate of gates.values()) gate.resolve(); return host.close(); });
    const first = await rawPeer(endpoint);
    const second = await rawPeer(endpoint);
    own(function closeFirst() { return first.close(); });
    own(function closeSecond() { return second.close(); });
    const content = '  \uFEFF日本語\r\nNUL\0 🧀 e\u0301\nFull final line  ';
    first.send({type: 'request', id: 'same-id', method: 'echo.wait', parameters: {owner: 'first', streamId: 'same-stream', content}});
    second.send({type: 'request', id: 'same-id', method: 'echo.wait', parameters: {owner: 'second', streamId: 'same-stream', content}});
    await accepted.promise;
    for (const context of contexts.values()) {
        assert.equal(context.clientRequestId, 'same-id');
        assert.notEqual(context.requestId, 'same-id');
        assert.equal(context.requestId, context.coreRequestId);
    }
    assert.notEqual(contexts.get('first').coreRequestId, contexts.get('second').coreRequestId);
    gates.get('second').resolve();
    assert.deepEqual((await second.next(function answer(frame) { return frame.type === 'response'; })).result,
        {owner: 'second', streamId: 'same-stream', content});
    assert.equal(first.frames.some(function reply(frame) { return frame.type === 'response' || frame.event?.startsWith('echo.'); }), false);
    gates.get('first').resolve();
    await first.next(function answer(frame) { return frame.type === 'response'; });
    for (const peer of [first, second]) {
        const selected = peer.frames.filter(function relevant(frame) { return frame.type === 'response' || frame.event?.startsWith('echo.'); });
        assert.equal(selected[0].event, 'echo.chunk');
        assert.deepEqual(selected[0].data, {requestId: 'same-id', content});
        assert.equal(selected[0].requestId, 'same-id');
        assert.equal(selected[1].event, 'echo.stream');
        assert.equal(selected[1].requestId, 'same-id');
        assert.deepEqual(selected[1].data, {streamId: 'same-stream', chunk: {content}});
        assert.equal(selected[2].id, 'same-id');
        assert.equal(selected[2].ok, true);
    }
    contexts.get('second').emit('echo.retired', {streamId: 'same-stream', content});
    host.runtime.emit('catalog.changed', {content});
    for (const peer of [first, second]) {
        assert.deepEqual((await peer.next(function changed(frame) { return frame.event === 'catalog.changed'; })).data, {content});
        assert.equal(peer.frames.some(function retired(frame) { return frame.event === 'echo.retired'; }), false);
    }
});

test('disconnect cancels only its request lifetime while accepted service work survives and explicit shutdown drains it', async function scopedCancellation(t) {
    const {endpoint, own} = await fixture(t);
    const accepted = deferred();
    const durable = deferred();
    const durableStarted = deferred();
    const live = new Map();
    let drained = false;
    const host = await startSharedCoreHost({endpoint, configure(runtime) {
        runtime.registerService({name: 'work', methods: {
            'work.wait': async function wait(parameters, {signal}) {
                live.set(parameters.owner, signal);
                if (live.size === 2) accepted.resolve();
                await new Promise(function waitForAbort(resolve, reject) {
                    signal.addEventListener('abort', function abort() { reject(signal.reason); }, {once: true});
                });
            },
            'work.save': {lifetime: 'service', async handle(parameters, {signal}) {
                durableStarted.resolve(signal);
                await durable.promise;
                return parameters;
            }}
        }, drain() { drained = true; }});
    }});
    own(function closeHost() { durable.resolve(); return host.close(); });
    const first = await connectSharedCoreHost({endpoint, onError() {}});
    const second = await connectSharedCoreHost({endpoint, onError() {}});
    own(function closeFirst() { return first.close(); });
    own(function closeSecond() { return second.close(); });
    const a = first.client.invoke('work.wait', {owner: 'first'});
    const b = second.client.invoke('work.wait', {owner: 'second'});
    a.catch(function observed() {});
    b.catch(function observed() {});
    await accepted.promise;
    const saving = first.client.invoke('work.save', {content: 'Complete durable content'});
    saving.catch(function observed() {});
    const serviceSignal = await durableStarted.promise;
    await first.close();
    await assert.rejects(a, {code: 'ARCANE_REQUEST_ABORTED'});
    await assert.rejects(saving, {code: 'ARCANE_REQUEST_ABORTED'});
    assert.equal(live.get('first').aborted, true);
    assert.equal(live.get('second').aborted, false);
    assert.equal(serviceSignal.aborted, false);
    const shutdown = second.shutdown();
    await assert.rejects(b, {code: 'REQUEST_ABORTED'});
    assert.equal(drained, false);
    await assert.rejects(startSharedCoreHost({endpoint, configure() {
        assert.fail('A replacement factory must not run during the old owner drain.');
    }}), {code: 'EADDRINUSE', coreHostPhase: 'listen'});
    durable.resolve();
    assert.deepEqual(await shutdown, {state: 'closed'});
    assert.equal(drained, true);
});

test('startup cancellation joins the lazy factory and disposes every registered owner', async function cancelledFactory(t) {
    const {endpoint, own} = await fixture(t);
    const entered = deferred();
    const gate = deferred();
    const controller = new AbortController();
    let disposed = false;
    const starting = startSharedCoreHost({endpoint, signal: controller.signal, async configure(runtime, {signal}) {
        entered.resolve(signal);
        await gate.promise;
        runtime.registerService({name: 'late-owner', dispose() { disposed = true; }});
    }});
    starting.catch(function observed() {});
    own(async function closeStartup() {
        controller.abort();
        gate.resolve();
        await starting.catch(function expectedCancellation() {});
    });
    const factorySignal = await entered.promise;
    controller.abort(new Error('stop selected startup'));
    assert.equal(factorySignal.aborted, true);
    assert.equal(disposed, false);
    gate.resolve();
    await assert.rejects(starting, {message: 'stop selected startup'});
    assert.equal(disposed, true);
});

test('native bridge disconnect leaves the host alive and terminal output failure settles pending writes', async function bridgeLifetime(t) {
    const {endpoint, own} = await fixture(t);
    const host = await startSharedCoreHost({endpoint});
    own(function closeHost() { return host.close(); });
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const bridge = await startSharedCoreBridge({endpoint, input, output, onError() {}});
    own(function closeBridge() { return bridge.close(); });
    input.end();
    await bridge.closed;
    assert.equal(host.runtime.current().state, 'ready');
    const writeStarted = deferred();
    const failingOutput = new Writable({write(content, encoding, callback) { writeStarted.resolve(); }});
    const failedBridge = await startSharedCoreBridge({endpoint, input: new PassThrough(), output: failingOutput, onError() {}});
    own(async function closeFailedBridge() {
        failingOutput.destroy();
        await failedBridge.close().catch(function expectedOutputFailure() {});
    });
    await writeStarted.promise;
    failingOutput.destroy(new Error('terminal output failure'));
    await assert.rejects(failedBridge.closed, {message: 'terminal output failure'});
    assert.equal(host.runtime.current().state, 'ready');
});

test('headless startup uses one lazy owner across two launchers and survives both client disconnects', async function independentHeadless(t) {
    const {root, endpoint, own} = await fixture(t);
    const entry = path.join(root, 'host.mjs');
    const factoryLog = path.join(root, 'factories.txt');
    const logFile = path.join(root, 'host.log');
    await writeFile(entry, [
        `import {runSharedCoreHost} from ${JSON.stringify(hostModule)};`,
        "import {appendFile} from 'node:fs/promises';",
        `const host = await runSharedCoreHost({endpoint: ${JSON.stringify(endpoint)},`,
        '    async configure(runtime) {',
        `        await appendFile(${JSON.stringify(factoryLog)}, 'factory\\n');`,
        "        runtime.registerService({name:'ledger', methods:{'ledger.read': function read() {return 'One moon cheese owner';}}});",
        '    }',
        '});',
        'await host?.closed;',
        ''
    ].join('\n'));
    const start = {command: process.execPath, args: [entry], logFile};
    own(async function stopOwnedHost() {
        const connection = await connectSharedCoreHost({endpoint, onError() {}}).catch(function alreadyStopped() { return null; });
        await connection?.shutdown();
    });
    const [first, second] = await Promise.all([
        connectSharedCoreHost({endpoint, start, onError() {}}),
        connectSharedCoreHost({endpoint, start, onError() {}})
    ]);
    own(function closeFirst() { return first.close(); });
    own(function closeSecond() { return second.close(); });
    assert.equal(await first.client.invoke('ledger.read'), 'One moon cheese owner');
    assert.equal(await second.client.invoke('ledger.read'), 'One moon cheese owner');
    await Promise.all([first.close(), second.close()]);
    const third = await connectSharedCoreHost({endpoint, onError() {}});
    own(function closeThird() { return third.close(); });
    assert.equal(await third.client.invoke('ledger.read'), 'One moon cheese owner');
    assert.equal(await readFile(factoryLog, 'utf8'), 'factory\n');
    await third.shutdown();
});
