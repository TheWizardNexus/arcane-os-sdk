import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createCoreClient, getInstalledCoreClient, installCoreClient} from '../browser-runtime/core/client.mjs';
import {CoreError} from '../browser-runtime/core/contracts.mjs';
import {createCoreImageRuntime} from '../browser-runtime/ai/core-image.mjs';
import {createCoreONNXRuntime} from '../browser-runtime/ai/core-onnx.mjs';
import {createCoreLocalAIProvider} from '../browser-runtime/ai/core-local.mjs';

const selection = {providerId: 'llama.cpp', modelId: 'moon-raccoon', localOnly: true};

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(
        function retainSettlement(onResolve, onReject) {
            resolve = onResolve;
            reject = onReject;
        }
    );
    return {promise, resolve, reject};
}

function fixtureClient({installed = true, loaded = true} = {}) {
    const calls = [];
    const held = new Map();
    let receive;
    const state = {
        image: {id: 'stable-diffusion.cpp', installed: true, available: true, state: 'ready', loaded, selectedModel: 'moon-painter', models: []},
        llama: {id: 'llama.cpp', installed: true, available: true, state: 'ready', models: [{id: selection.modelId, loaded}]},
        onnx: {id: 'onnx', installed: true, available: true, state: 'ready', models: loaded ? [{id: 'cheese-radar', loaded: true}] : []}
    };
    const options = {
        transport: {
            name: 'fixture',
            subscribe(listener) {
                receive = listener;
                return function releaseTransport() {};
            },
            send(frame) {
                if (frame.type !== 'request') return;
                const family = frame.method.split('.')[0];
                if (frame.method === 'llama.load') state.llama.models[0].loaded = true;
                if (frame.method === 'llama.unload') state.llama.models[0].loaded = false;
                receive({protocol: 'arcane/1', type: 'response', id: frame.id, ok: true, result: state[family]});
            }
        },
        onError: function observeFixtureFailure() {}
    };
    const client = installed ? installCoreClient(globalThis, options)
        : createCoreClient({...options, global: {console, crypto: globalThis.crypto}});
    const invoke = client.invoke;
    client.invoke = function invokeFixture(method, parameters, requestOptions) {
        calls.push({method, parameters, options: requestOptions});
        const retained = held.get(method);
        if (retained) {
            retained.started.resolve();
            // Deliberately ignores abort to prove the accessor suppresses late results.
            return retained.result.promise;
        }
        return invoke(method, parameters, requestOptions);
    };
    function hold(method) {
        const retained = {started: deferred(), result: deferred()};
        held.set(method, retained);
        return retained;
    }
    function emit(event, data) {
        return client.receive({protocol: 'arcane/1', type: 'event', event, data});
    }
    return {client, calls, hold, emit, state};
}

test('default Core AI accessors observe late installation and cancel retired ownership without late results', async function lateInstallationAndReplacement(t) {
    assert.equal(getInstalledCoreClient(), null);
    const clients = [];
    const settlements = [];
    const diagnostics = [];
    const images = createCoreImageRuntime({onEvent: function imageEvent(value) { diagnostics.push(value); }});
    const onnx = createCoreONNXRuntime();
    const local = createCoreLocalAIProvider();
    t.after(async function releaseAccessors() {
        for (const retained of settlements) retained.result.resolve({});
        await images.close();
        onnx.close();
        await local.dispose();
        for (const fixture of clients) fixture.client.close();
    });
    assert.equal(images.current().available, false);
    assert.equal(onnx.current().available, false);
    assert.equal(local.status().available, false);
    const first = fixtureClient();
    clients.push(first);
    await Promise.all([images.inspect(), onnx.inspect(), local.inspect(selection)]);
    await local.load({selection});
    assert.equal(images.current().loaded, true);
    assert.equal(onnx.current().models[0].loaded, true);
    assert.equal(local.status().loaded, true);
    assert.equal(first.calls.some(function downloaded(call) { return call.method.includes('ensure'); }), false);

    const generation = first.hold('image.generate');
    const tensorRun = first.hold('onnx.run');
    const chat = first.hold('llama.chat');
    settlements.push(generation, tensorRun, chat);
    const prompt = '  A dignified raccoon\nwith the complete moon charter.  ';
    const payload = {messages: [{role: 'user', content: prompt}]};
    const imageTask = images.generate({model: 'moon-painter', prompt});
    assert.equal(images.current().status, 'Thinking');
    const tensorTask = onnx.run({id: 'cheese-radar', feeds: {input: {type: 'float32', dims: [1], data: new Float32Array([7])}}});
    const chatTask = local.request({selection, operation: 'chat', payload});
    const rejected = [assert.rejects(imageTask), assert.rejects(tensorTask), assert.rejects(chatTask)];
    await Promise.all([generation.started.promise, tensorRun.started.promise, chat.started.promise]);
    const inference = first.calls.filter(function inferenceCall(call) { return ['image.generate', 'onnx.run', 'llama.chat'].includes(call.method); });
    assert.equal(inference.find(function imageCall(call) { return call.method === 'image.generate'; }).parameters.prompt, prompt);
    assert.equal(inference.find(function chatCall(call) { return call.method === 'llama.chat'; }).parameters.payload, payload);
    first.client.close();
    assert.equal(images.current().loaded, false);
    assert.equal(images.current().status, null);
    assert.deepEqual(onnx.current().models, []);
    assert.equal(local.status().loaded, false);
    for (const call of inference) assert.equal(call.options.signal.aborted, true);

    const second = fixtureClient({loaded: false});
    clients.push(second);
    await Promise.all([images.inspect(), onnx.inspect(), local.inspect(selection)]);
    generation.result.resolve({images: [{data: 'bW9vbg==', encoding: 'base64', mediaType: 'image/png'}]});
    tensorRun.result.resolve({output: {type: 'float32', dims: [1], data: [99]}});
    chat.result.resolve({message: {content: 'Stale moon charter'}});
    await Promise.all(rejected);
    assert.equal(images.current().loaded, false);
    assert.deepEqual(onnx.current().models, []);
    assert.equal(local.status().loaded, false);
    assert.equal(diagnostics.some(function deliveredOldImage(event) { return event.type === 'image.result'; }), false);
    await local.load({selection});
    assert.equal(local.status().loaded, true);
    await local.dispose();
    await images.close();
    onnx.close();
    second.client.close();
    const third = fixtureClient();
    clients.push(third);
    assert.deepEqual(third.calls, []);
    assert.equal(local.status().state, 'disposed');
    assert.equal(images.current().closed, true);
    assert.equal(onnx.current().closed, true);
});

test('retired status and load completions cannot publish readiness or terminal progress', async function lateLifecycleResults(t) {
    const images = createCoreImageRuntime();
    const onnx = createCoreONNXRuntime();
    const local = createCoreLocalAIProvider();
    const first = fixtureClient({loaded: false});
    const retained = [];
    let second;
    t.after(async function releaseLifecycleOwners() {
        for (const pending of retained) pending.result.resolve({});
        await images.close();
        onnx.close();
        await local.dispose();
        first.client.close();
        second?.client.close();
    });
    await Promise.all([images.inspect(), onnx.inspect(), local.inspect(selection)]);
    const imageStatus = first.hold('image.status');
    const onnxStatus = first.hold('onnx.status');
    const modelLoad = first.hold('llama.load');
    retained.push(imageStatus, onnxStatus, modelLoad);
    const progress = [];
    const rejected = [
        assert.rejects(images.inspect()),
        assert.rejects(onnx.inspect()),
        assert.rejects(local.load({selection, progress: function modelProgress(value) { progress.push(value); }}))
    ];
    await Promise.all(retained.map(function requestStarted(pending) { return pending.started.promise; }));
    first.client.close();
    second = fixtureClient({loaded: false});
    await Promise.all([images.inspect(), onnx.inspect(), local.inspect(selection)]);
    await local.load({selection});
    imageStatus.result.resolve({...first.state.image, loaded: true});
    onnxStatus.result.resolve({...first.state.onnx, models: [{id: 'retired-cheese', loaded: true}]});
    modelLoad.result.resolve({...first.state.llama, models: [{id: selection.modelId, loaded: true}]});
    await Promise.all(rejected);
    assert.equal(images.current().loaded, false);
    assert.deepEqual(onnx.current().models, []);
    assert.equal(local.status().loaded, true);
    assert.deepEqual(progress, [{phase: 'loading', modelId: selection.modelId}]);
});

test('retirement cancels streamed local output without delivering queued or late chunks', async function retiredStream(t) {
    const local = createCoreLocalAIProvider();
    const first = fixtureClient();
    let second;
    let chat;
    t.after(async function releaseStreamOwner() {
        chat?.result.resolve({});
        await local.dispose();
        first.client.close();
        second?.client.close();
    });
    await local.load({selection});
    chat = first.hold('llama.chat');
    const payload = {messages: [{role: 'user', content: 'Keep every moon charter paragraph.'}]};
    const stream = await local.request({selection, operation: 'stream', payload});
    const failed = assert.rejects(stream.result);
    await chat.started.promise;
    const call = first.calls.find(function streamCall(value) { return value.method === 'llama.chat'; });
    const reader = stream[Symbol.asyncIterator]();
    first.emit('llama.chunk', {streamId: call.parameters.streamId, chunk: 'Visible moon charter'});
    assert.deepEqual(await reader.next(), {value: 'Visible moon charter', done: false});
    first.emit('llama.chunk', {streamId: call.parameters.streamId, chunk: 'Uncommitted paragraph'});
    first.client.close();
    assert.equal(call.options.signal.aborted, true);
    await assert.rejects(reader.next());
    first.emit('llama.chunk', {streamId: call.parameters.streamId, chunk: 'Late retired paragraph'});
    second = fixtureClient({loaded: false});
    await local.load({selection});
    chat.result.resolve({message: {content: 'Retired complete charter'}});
    await failed;
    assert.equal(local.status().loaded, true);
});

test('explicit clients and explicit null keep caller ownership across global installation', async function explicitOwnership(t) {
    const injected = fixtureClient({installed: false});
    const images = createCoreImageRuntime({client: injected.client});
    const onnx = createCoreONNXRuntime({client: injected.client});
    const local = createCoreLocalAIProvider({client: injected.client});
    const absentImages = createCoreImageRuntime({client: null});
    const absentONNX = createCoreONNXRuntime({client: null});
    const absentLocal = createCoreLocalAIProvider({client: null});
    let installed;
    t.after(async function releaseExplicitOwners() {
        await images.close();
        await absentImages.close();
        onnx.close();
        absentONNX.close();
        await local.dispose();
        await absentLocal.dispose();
        injected.client.close();
        installed?.client.close();
    });
    await Promise.all([images.inspect(), onnx.inspect(), local.inspect(selection)]);
    await local.load({selection});
    installed = fixtureClient({loaded: false});
    installed.client.close();
    assert.equal(images.current().loaded, true);
    assert.equal(onnx.current().models[0].loaded, true);
    assert.equal(local.status().loaded, true);
    assert.equal(absentImages.current().available, false);
    assert.equal(absentONNX.current().available, false);
    assert.equal(absentLocal.status().available, false);
    assert.deepEqual(installed.calls, []);
});

test('failed retired-client unload rejects with the actual error after provider subscriptions are disposed', async function failedNativeRelease(t) {
    const local = createCoreLocalAIProvider();
    const first = fixtureClient();
    let second;
    t.after(async function releaseFailedOwner() {
        await local.dispose().catch(function expectedReleaseFailure() {});
        first.client.close();
        second?.client.close();
    });
    await local.load({selection});
    const failure = new CoreError({code: 'MOON_CORE_FAILED', message: 'Complete\n native failure', details: {cause: '  engine stopped  '}});
    first.client.failTransport(failure);
    assert.equal(local.status().loaded, false);
    assert.equal(local.status().error, failure);
    second = fixtureClient({loaded: false});
    await local.inspect(selection);
    const pending = local.dispose();
    assert.equal(local.status().state, 'disposed');
    await assert.rejects(pending, function actualFailure(error) { return error === failure; });
    assert.equal(local.status().error, failure);
    assert.equal(second.calls.some(function wronglyUnloadedReplacement(call) { return call.method === 'llama.unload'; }), false);
    second.emit('localai.state', {runtimes: [second.state.llama]});
    assert.equal(local.status().error, failure);
    assert.equal(local.status().available, false);
});

test('disposing configured but never-loaded local providers does not release a native model', async function disposeUnownedSelection(t) {
    const injected = fixtureClient({installed: false});
    const local = createCoreLocalAIProvider({client: injected.client});
    const absent = createCoreLocalAIProvider({client: null});
    t.after(async function closeUnownedProviders() {
        await Promise.all([local.dispose(), absent.dispose()]);
        injected.client.close();
    });
    assert.equal((await local.dispose({selection})).state, 'disposed');
    assert.equal((await absent.dispose({selection})).state, 'disposed');
    assert.deepEqual(injected.calls, []);
});

test('runtime-style unload then disposal releases only the actually retained local selection once', async function disposeAfterUnload(t) {
    const injected = fixtureClient({installed: false});
    const local = createCoreLocalAIProvider({client: injected.client});
    t.after(async function closeReleasedProvider() { await local.dispose(); injected.client.close(); });
    await local.load({selection});
    await local.unload({selection});
    assert.equal(local.status().modelId, null);
    await local.dispose({selection: {...selection}});
    assert.equal(injected.calls.filter(function unloadCall(call) { return call.method === 'llama.unload'; }).length, 1);
    assert.equal(local.status().state, 'disposed');
});

test('local inspection permits explicit startup load without inventing catalog entries or readiness', async function inspectStartingLoad(t) {
    const fixtures = [];
    t.after(async function releaseStartingProviders() {
        for (const {local, injected, pending} of fixtures) {
            pending?.result.resolve({});
            await local.dispose();
            injected.client.close();
        }
    });
    for (const state of ['starting', 'loading']) {
        const injected = fixtureClient({installed: false, loaded: false});
        const local = createCoreLocalAIProvider({client: injected.client});
        const pending = injected.hold('llama.load');
        fixtures.push({local, injected, pending});
        Object.assign(injected.state.llama, {available: false, state, models: [], error: null});
        const inspection = await local.inspect(selection);
        assert.equal(inspection.available, true);
        assert.equal(inspection.authority.modelId, selection.modelId);
        assert.deepEqual(local.catalog(), []);
        assert.equal(local.status().loaded, false);
        assert.deepEqual(injected.calls.map(function method(call) { return call.method; }), ['llama.status']);

        const loading = local.load({selection});
        await pending.started.promise;
        assert.equal(local.status().loaded, false);
        Object.assign(injected.state.llama, {available: true, state: 'ready', models: [{id: selection.modelId, loaded: true}]});
        injected.emit('localai.state', {runtimes: [injected.state.llama]});
        pending.result.resolve(injected.state.llama);
        await loading;
        assert.equal(local.status().loaded, true);
        await local.dispose();
    }
});

test('released owned known models remain explicitly loadable while unavailable and unknown selections stay honest', async function inspectReleasedLoad(t) {
    const injected = fixtureClient({installed: false});
    const local = createCoreLocalAIProvider({client: injected.client});
    let pending;
    t.after(async function releaseReloadedProvider() {
        pending?.result.resolve({});
        await local.dispose();
        injected.client.close();
    });
    await local.load({selection});
    await local.unload({selection});
    Object.assign(injected.state.llama, {available: false, state: 'stopped', owned: true, released: true, error: null});
    injected.emit('localai.state', {runtimes: [injected.state.llama]});
    const inspection = await local.inspect(selection);
    assert.equal(inspection.available, true);
    assert.equal(inspection.authority.modelId, selection.modelId);
    assert.equal(local.status().loaded, false);
    assert.equal(local.status().available, false);
    assert.equal((await local.inspect({...selection, modelId: 'unseen-moon-model'})).available, false);
    assert.equal(injected.calls.filter(function loadCall(call) { return call.method === 'llama.load'; }).length, 1);

    for (const unavailable of [
        {owned: false, state: 'stopped', error: null},
        {owned: true, state: 'closed', error: null},
        {owned: true, state: 'error', error: new Error('Complete\n release failure')}
    ]) {
        Object.assign(injected.state.llama, unavailable);
        assert.equal((await local.inspect(selection)).available, false);
        assert.equal(local.status().loaded, false);
    }
    Object.assign(injected.state.llama, {owned: true, state: 'stopped', error: null});
    assert.equal((await local.inspect(selection)).available, true);
    pending = injected.hold('llama.load');
    const loading = local.load({selection});
    await pending.started.promise;
    assert.equal(local.status().loaded, false);
    Object.assign(injected.state.llama, {available: true, state: 'ready', released: false, models: [{id: selection.modelId, loaded: true}]});
    injected.emit('localai.state', {runtimes: [injected.state.llama]});
    pending.result.resolve(injected.state.llama);
    await loading;
    assert.equal(local.status().loaded, true);
    assert.equal(injected.calls.filter(function loadCall(call) { return call.method === 'llama.load'; }).length, 2);
});
