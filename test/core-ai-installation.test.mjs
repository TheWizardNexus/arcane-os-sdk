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

test('Core ONNX accessor preserves physical, automatic and omitted target selections and request cancellation', async function forwardONNXTargets(t) {
    const injected = fixtureClient({installed: false, loaded: false});
    const onnx = createCoreONNXRuntime({client: injected.client});
    let retained;
    t.after(function releaseTargetAccessor() {
        retained?.result.resolve({});
        onnx.close();
        injected.client.close();
    });
    const sessionOptions = {graphOptimizationLevel: 'all', logId: '  Complete moon target\r\n🧀  '};
    for (const executionTarget of [{deviceId: 'synthetic-gpu-five'}, null, undefined]) {
        const id = `target-${injected.calls.length}`;
        const result = await onnx.load({
            id, model: 'models/moon cheese.onnx', sessionOptions,
            executionPreference: 'gpu', executionTarget, timeoutMs: 4321
        });
        const call = injected.calls.at(-1);
        assert.equal(call.method, 'onnx.load');
        assert.deepEqual(call.parameters, {
            id, model: 'models/moon cheese.onnx', sessionOptions, executionPreference: 'gpu', executionTarget
        });
        assert.equal(call.parameters.executionTarget, executionTarget);
        assert.equal(call.parameters.sessionOptions, sessionOptions);
        assert.equal(call.options.timeoutMs, 4321);
        assert.ok(call.options.signal instanceof AbortSignal);
        assert.deepEqual(result, injected.state.onnx);
    }
    retained = injected.hold('onnx.load');
    const controller = new AbortController();
    const loading = onnx.load({id: 'cancel-target', model: 'models/moon cheese.onnx', executionTarget: null, signal: controller.signal});
    const rejected = assert.rejects(loading, {name: 'AbortError'});
    await retained.started.promise;
    controller.abort();
    assert.equal(injected.calls.at(-1).options.signal.aborted, true);
    retained.result.resolve({state: 'late-target-result'});
    await rejected;
});

test('local model preparation forwards the exact projection and target and releases after Core load', async function prepareProjectedModel(t) {
    const injected = fixtureClient({installed: false, loaded: false});
    const preparationStarted = deferred();
    const prepared = deferred();
    const releaseStarted = deferred();
    const released = deferred();
    const pending = injected.hold('llama.load');
    const progress = [];
    const preparationCalls = [];
    const resourcePaths = {model: 'models/Moon charter 🧀.gguf'};
    const executionTarget = {deviceId: 'synthetic-gpu-five'};
    const execution = {deviceId: 'synthetic-gpu-five', backend: 'cuda'};
    let releaseCount = 0;
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: async function prepareMoonModel(options) {
            preparationCalls.push(options);
            preparationStarted.resolve();
            await prepared.promise;
            options.progress({phase: 'projecting', modelId: options.selection.modelId});
            return {
                assetProjectionId: 'moon-projection', resourcePaths, executionTarget,
                release: async function releaseMoonProjection() {
                    releaseCount += 1;
                    releaseStarted.resolve();
                    await released.promise;
                }
            };
        }
    });
    t.after(async function releaseProjectedProvider() {
        prepared.resolve();
        pending.result.resolve(injected.state.llama);
        released.resolve();
        await local.dispose();
        injected.client.close();
    });
    const loading = local.load({selection, progress: function retainProjectionProgress(event) { progress.push(event); }});
    await preparationStarted.promise;
    assert.equal(local.status().state, 'loading');
    assert.equal(local.status().execution, null);
    assert.deepEqual(injected.calls, []);
    assert.equal(preparationCalls[0].selection, selection);
    prepared.resolve();
    await pending.started.promise;
    const call = injected.calls[0];
    assert.equal(call.method, 'llama.load');
    assert.deepEqual(call.parameters, {model: selection.modelId, assetProjectionId: 'moon-projection', resourcePaths, executionTarget});
    assert.equal(call.parameters.resourcePaths, resourcePaths);
    assert.equal(call.parameters.executionTarget, executionTarget);
    assert.equal(call.options.signal, preparationCalls[0].signal);
    assert.equal(releaseCount, 0);
    Object.assign(injected.state.llama, {models: [{id: selection.modelId, loaded: true}], execution});
    pending.result.resolve(injected.state.llama);
    await releaseStarted.promise;
    assert.equal(local.status().state, 'loading');
    assert.equal(progress.some(function prematurelyReady(event) { return event.phase === 'ready'; }), false);
    released.resolve();
    const result = await loading;
    assert.equal(result.authority.modelId, selection.modelId);
    assert.equal(result.status.execution, execution);
    assert.equal(local.status().execution, execution);
    assert.equal(local.status().loaded, true);
    assert.equal(releaseCount, 1);
    assert.deepEqual(progress, [
        {phase: 'loading', modelId: selection.modelId},
        {phase: 'projecting', modelId: selection.modelId},
        {phase: 'ready', modelId: selection.modelId}
    ]);
    preparationCalls[0].progress({phase: 'late'});
    assert.equal(progress.length, 3);
});

test('explicit local projection fields override preparation and retain automatic or omitted device choices', async function explicitProjectedLoad(t) {
    const injected = fixtureClient({installed: false});
    const preparation = {
        assetProjectionId: 'prepared-projection', resourcePaths: {model: 'prepared.gguf'},
        executionTarget: {deviceId: 'prepared-device'}
    };
    let preparationCount = 0;
    let releaseCount = 0;
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: function prepareDefaultProjection() {
            preparationCount += 1;
            return {...preparation, release: function releasePreparedProjection() { releaseCount += 1; }};
        }
    });
    const direct = createCoreLocalAIProvider({client: injected.client});
    t.after(async function releaseExplicitProjectionProviders() {
        await local.dispose();
        await direct.dispose();
        injected.client.close();
    });
    const resourcePaths = {model: 'Exact direct model.gguf'};
    for (const executionTarget of [{deviceId: 'explicit-device'}, null, undefined]) {
        await local.load({selection, assetProjectionId: 'explicit-projection', resourcePaths, executionTarget});
        const call = injected.calls.at(-1);
        assert.deepEqual(call.parameters, {
            model: selection.modelId, assetProjectionId: 'explicit-projection', resourcePaths,
            executionTarget: executionTarget === undefined ? preparation.executionTarget : executionTarget
        });
        assert.equal(call.parameters.resourcePaths, resourcePaths);
    }
    assert.equal(preparationCount, 3);
    assert.equal(releaseCount, 3);
    await direct.load({selection, assetProjectionId: 'direct-projection', resourcePaths, executionTarget: null});
    assert.deepEqual(injected.calls.at(-1).parameters, {
        model: selection.modelId, assetProjectionId: 'direct-projection', resourcePaths, executionTarget: null
    });
    await direct.load({selection});
    assert.deepEqual(injected.calls.at(-1).parameters, {model: selection.modelId});
    assert.equal(direct.status().execution, null);
});

test('superseded local preparation is cancelled and late projections are released without dispatch or progress', async function supersedeModelPreparation(t) {
    const injected = fixtureClient({installed: false});
    const firstStarted = deferred();
    const firstPrepared = deferred();
    const progress = [];
    const preparationCalls = [];
    const releases = [];
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: async function prepareSelectedProjection(options) {
            preparationCalls.push(options);
            const index = preparationCalls.length;
            if (index === 1) {
                firstStarted.resolve();
                await firstPrepared.promise;
            }
            options.progress({phase: `prepared-${index}`});
            return {
                assetProjectionId: `projection-${index}`, resourcePaths: {model: `moon-${index}.gguf`},
                release: function releaseSelectedProjection() { releases.push(index); }
            };
        }
    });
    t.after(async function releaseSupersededPreparation() {
        firstPrepared.resolve();
        await local.dispose();
        injected.client.close();
    });
    const first = local.load({selection, progress: function retainRetiredProgress(event) { progress.push(event); }});
    const rejected = assert.rejects(first, {name: 'AbortError'});
    await firstStarted.promise;
    await local.load({selection});
    assert.equal(preparationCalls[0].signal.aborted, true);
    assert.equal(preparationCalls[1].signal.aborted, false);
    firstPrepared.resolve();
    await rejected;
    const loads = injected.calls.filter(function loadCall(call) { return call.method === 'llama.load'; });
    assert.equal(loads.length, 1);
    assert.equal(loads[0].parameters.assetProjectionId, 'projection-2');
    assert.deepEqual(releases, [2, 1]);
    assert.deepEqual(progress, [{phase: 'loading', modelId: selection.modelId}]);
    assert.equal(local.status().loaded, true);
});

test('local preparation follows caller cancellation and unload or disposal waits for its release', async function cancelModelPreparation(t) {
    for (const action of ['abort', 'unload', 'dispose']) {
        const injected = fixtureClient({installed: false});
        const started = deferred();
        const prepared = deferred();
        const releaseStarted = deferred();
        const released = deferred();
        const controller = new AbortController();
        const progress = [];
        let preparationSignal;
        let releaseCount = 0;
        const local = createCoreLocalAIProvider({
            client: injected.client,
            prepareModel: async function prepareCancelledProjection({signal, progress: report}) {
                preparationSignal = signal;
                started.resolve();
                await prepared.promise;
                report({phase: 'late'});
                return {
                    assetProjectionId: 'cancelled-projection', resourcePaths: {model: 'cancelled.gguf'},
                    release: async function releaseCancelledProjection() {
                        releaseCount += 1;
                        releaseStarted.resolve();
                        await released.promise;
                    }
                };
            }
        });
        t.after(async function releaseCancelledProvider() {
            prepared.resolve();
            released.resolve();
            await local.dispose();
            injected.client.close();
        });
        const loading = local.load({selection, signal: controller.signal, progress: function retainCancelledProgress(event) { progress.push(event); }});
        const rejected = assert.rejects(loading, {name: 'AbortError'});
        await started.promise;
        let ending;
        if (action === 'abort') controller.abort();
        else if (action === 'unload') ending = local.unload();
        else ending = local.dispose();
        assert.equal(preparationSignal.aborted, true);
        prepared.resolve();
        await releaseStarted.promise;
        assert.deepEqual(injected.calls, []);
        released.resolve();
        await rejected;
        await ending;
        assert.equal(releaseCount, 1);
        assert.deepEqual(injected.calls, []);
        assert.deepEqual(progress, [{phase: 'loading', modelId: selection.modelId}]);
    }
});

test('local preparation release preserves Core failure and cleanup failure together', async function preserveProjectionFailures(t) {
    const injected = fixtureClient({installed: false});
    const pending = injected.hold('llama.load');
    const loadFailure = new Error('Complete\n native load failure');
    const releaseFailure = new Error('Complete\n projection release failure');
    let releases = 0;
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: function prepareFailingProjection() {
            return {
                assetProjectionId: 'failing-projection', resourcePaths: {model: 'failing.gguf'},
                release: function releaseFailingProjection() { releases += 1; throw releaseFailure; }
            };
        }
    });
    t.after(async function releaseFailureFixture() {
        pending.result.resolve(injected.state.llama);
        await local.dispose();
        injected.client.close();
    });
    const loading = local.load({selection});
    const rejected = assert.rejects(loading, function completeFailures(error) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [loadFailure, releaseFailure]);
        assert.equal(error.cause, loadFailure);
        return true;
    });
    await pending.started.promise;
    pending.result.reject(loadFailure);
    await rejected;
    assert.equal(releases, 1);
    assert.equal(local.status().busy, false);
});

test('Core readiness changes during projection release cannot publish ready progress', async function revokedReadinessDuringProjectionRelease(t) {
    const injected = fixtureClient({installed: false});
    const releaseStarted = deferred();
    const released = deferred();
    const progress = [];
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: function prepareRetiringProjection() {
            return {
                assetProjectionId: 'retiring-projection', resourcePaths: {model: 'retiring.gguf'},
                release: async function releaseRetiringProjection() { releaseStarted.resolve(); await released.promise; }
            };
        }
    });
    t.after(async function releaseReadinessFixture() {
        released.resolve();
        await local.dispose();
        injected.client.close();
    });
    const loading = local.load({selection, progress: function retainReadinessProgress(event) { progress.push(event); }});
    const rejected = assert.rejects(loading, {code: 'ARCANE_AI_MODEL_NOT_READY'});
    await releaseStarted.promise;
    injected.state.llama.models[0].loaded = false;
    injected.emit('localai.state', {runtimes: [injected.state.llama]});
    released.resolve();
    await rejected;
    assert.equal(local.status().loaded, false);
    assert.deepEqual(progress, [{phase: 'loading', modelId: selection.modelId}]);
});

test('local preparation inspection observes managed load capability without preparing or inventing catalog entries', async function inspectPreparedCapability(t) {
    const injected = fixtureClient({installed: false, loaded: false});
    let preparations = 0;
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: function prepareOnActualLoad() { preparations += 1; return {}; }
    });
    const ordinary = createCoreLocalAIProvider({client: injected.client});
    t.after(async function releaseInspectionProviders() {
        await local.dispose();
        await ordinary.dispose();
        injected.client.close();
    });
    Object.assign(injected.state.llama, {
        installed: true, available: false, state: 'stopped', managed: true,
        owned: false, released: false, models: [], error: null
    });
    const inspected = await local.inspect(selection);
    assert.equal(inspected.available, true);
    assert.equal(inspected.authority.modelId, selection.modelId);
    assert.equal(local.status().loaded, false);
    assert.equal(local.status().execution, null);
    assert.deepEqual(local.catalog(), []);
    assert.equal((await ordinary.inspect(selection)).available, false);
    for (const unavailable of [
        {installed: false, available: false, managed: true, state: 'stopped', error: null},
        {installed: true, available: false, managed: false, state: 'stopped', error: null},
        {installed: true, available: true, managed: false, state: 'ready', error: null},
        {installed: true, available: false, managed: true, state: 'closed', error: null},
        {installed: true, available: false, managed: true, state: 'closing', error: null},
        {installed: true, available: false, managed: true, state: 'error', error: new Error('Complete native preparation failure')}
    ]) {
        Object.assign(injected.state.llama, unavailable);
        assert.equal((await local.inspect(selection)).available, false);
    }
    assert.equal(preparations, 0);
    assert.equal(injected.calls.every(function observedOnly(call) { return call.method === 'llama.status'; }), true);
    assert.deepEqual(local.catalog(), []);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(local.load({selection, signal: controller.signal}), {name: 'AbortError'});
    assert.equal(preparations, 0);
});

test('Core replacement cancels pending preparation and retains the replacement readiness after late release', async function retirePreparedConnection(t) {
    const first = fixtureClient();
    const firstStarted = deferred();
    const firstPrepared = deferred();
    const preparationCalls = [];
    const releases = [];
    const progress = [];
    let second;
    const local = createCoreLocalAIProvider({
        prepareModel: async function prepareConnectionProjection(options) {
            preparationCalls.push(options);
            const index = preparationCalls.length;
            if (index === 1) {
                firstStarted.resolve();
                await firstPrepared.promise;
            }
            options.progress({phase: `prepared-${index}`});
            return {
                assetProjectionId: `connection-projection-${index}`, resourcePaths: {model: `connection-${index}.gguf`},
                release: function releaseConnectionProjection() { releases.push(index); }
            };
        }
    });
    t.after(async function releaseConnectionFixtures() {
        firstPrepared.resolve();
        await local.dispose();
        first.client.close();
        second?.client.close();
    });
    const loading = local.load({selection, progress: function retainRetiredPreparationProgress(event) { progress.push(event); }});
    const rejected = assert.rejects(loading, {name: 'AbortError'});
    await firstStarted.promise;
    first.client.close();
    assert.equal(preparationCalls[0].signal.aborted, true);
    second = fixtureClient();
    await local.load({selection});
    firstPrepared.resolve();
    await rejected;
    assert.equal(first.calls.some(function loadedRetiredConnection(call) { return call.method === 'llama.load'; }), false);
    const loads = second.calls.filter(function loadedReplacement(call) { return call.method === 'llama.load'; });
    assert.equal(loads.length, 1);
    assert.equal(loads[0].parameters.assetProjectionId, 'connection-projection-2');
    assert.deepEqual(releases, [2, 1]);
    assert.deepEqual(progress, [{phase: 'loading', modelId: selection.modelId}]);
    assert.equal(local.status().loaded, true);
});

test('cancelling replacement preparation releases the previously dispatched model only', async function retainDispatchedModelDuringPreparation(t) {
    const injected = fixtureClient({installed: false});
    const replacementStarted = deferred();
    const replacementPrepared = deferred();
    const releases = [];
    const replacement = {...selection, modelId: 'unloaded-moon-replacement'};
    const local = createCoreLocalAIProvider({
        client: injected.client,
        prepareModel: async function prepareReplacementProjection({selection: value}) {
            if (value === replacement) {
                replacementStarted.resolve();
                await replacementPrepared.promise;
            }
            return {
                assetProjectionId: `${value.modelId}-projection`, resourcePaths: {model: `${value.modelId}.gguf`},
                release: function releaseReplacementProjection() { releases.push(value.modelId); }
            };
        }
    });
    t.after(async function releaseRetainedModelFixture() {
        replacementPrepared.resolve();
        await local.dispose();
        injected.client.close();
    });
    await local.load({selection});
    const loading = local.load({selection: replacement});
    const rejected = assert.rejects(loading, {name: 'AbortError'});
    await replacementStarted.promise;
    const unloading = local.unload();
    replacementPrepared.resolve();
    await rejected;
    await unloading;
    assert.deepEqual(injected.calls.map(function nativeModelCall(call) { return {method: call.method, model: call.parameters.model}; }), [
        {method: 'llama.load', model: selection.modelId},
        {method: 'llama.unload', model: selection.modelId}
    ]);
    assert.deepEqual(releases, [selection.modelId, replacement.modelId]);
    await local.dispose();
    assert.equal(injected.calls.length, 2);
});

test('a failed same-name projection or device reload cannot accept the previous model readiness', async function rejectStaleReloadReadiness(t) {
    for (const replacement of [
        {assetProjectionId: 'replacement-moon-projection', resourcePaths: {model: 'replacement-moon.gguf'}},
        {executionTarget: {deviceId: 'replacement-moon-gpu'}}
    ]) {
        const injected = fixtureClient({installed: false});
        const local = createCoreLocalAIProvider({client: injected.client});
        let pending;
        t.after(async function releaseFailedReloadFixture() {
            pending?.result.resolve(injected.state.llama);
            await local.dispose();
            injected.client.close();
        });
        await local.load({selection});
        assert.equal(local.status().loaded, true);
        pending = injected.hold('llama.load');
        const failure = new Error('The exact replacement could not load.');
        const loading = local.load({selection, ...replacement});
        const rejected = assert.rejects(loading, function retainReloadFailure(error) { return error === failure; });
        await pending.started.promise;
        assert.equal(local.status().loaded, false);
        pending.result.reject(failure);
        await rejected;
        assert.equal(local.status().loaded, false);
        injected.emit('localai.state', {runtimes: [injected.state.llama]});
        assert.equal(local.status().loaded, false);
        await assert.rejects(local.request({
            selection, operation: 'chat', payload: {messages: [{role: 'user', content: 'Keep the complete moon charter.'}]}
        }), {code: 'ARCANE_AI_MODEL_NOT_READY'});
        assert.equal(injected.calls.some(function dispatchedInference(call) { return call.method === 'llama.chat'; }), false);
        await local.unload();
        assert.deepEqual(injected.calls.at(-1).parameters, {model: selection.modelId});
    }
});

test('failed or cancelled dispatched replacements release the replacement model on unload or disposal', async function releaseDispatchedReplacement(t) {
    for (const result of ['failure', 'cancel']) {
        for (const action of ['unload', 'dispose']) {
            const injected = fixtureClient({installed: false});
            const local = createCoreLocalAIProvider({client: injected.client});
            const replacement = {...selection, modelId: 'dispatched-moon-replacement'};
            let pending;
            t.after(async function releaseDispatchedReplacementFixture() {
                pending?.result.resolve(injected.state.llama);
                await local.dispose();
                injected.client.close();
            });
            await local.load({selection});
            pending = injected.hold('llama.load');
            const failure = new Error('The dispatched replacement stopped during startup.');
            const loading = local.load({selection: replacement, assetProjectionId: 'replacement-projection', resourcePaths: {model: 'replacement.gguf'}});
            const rejected = assert.rejects(loading, function retainReplacementFailure(error) {
                return result === 'failure' ? error === failure : error.name === 'AbortError';
            });
            await pending.started.promise;
            let ending;
            if (result === 'failure') {
                pending.result.reject(failure);
                await rejected;
                ending = local[action]();
            } else {
                ending = local[action]();
                assert.equal(injected.calls.at(-1).options.signal.aborted, true);
                injected.state.llama.models = [{id: replacement.modelId, loaded: true}];
                pending.result.resolve(injected.state.llama);
                await rejected;
            }
            await ending;
            assert.equal(local.status().loaded, false);
            assert.deepEqual(injected.calls.map(function dispatchedModelCall(call) {
                return {method: call.method, model: call.parameters.model};
            }), [
                {method: 'llama.load', model: selection.modelId},
                {method: 'llama.load', model: replacement.modelId},
                {method: 'llama.unload', model: replacement.modelId}
            ]);
        }
    }
});

test('catalog lookup cannot carry an inference request into a replacement load', async function revokeCatalogLookupAcceptance(t) {
    for (const replacement of [selection, {...selection, modelId: 'replacement-moon-raccoon'}]) {
        for (const operation of ['chat', 'stream']) {
            const injected = fixtureClient({installed: false});
            const local = createCoreLocalAIProvider({client: injected.client});
            let pending;
            t.after(async function releaseCatalogAcceptanceFixture() {
                pending?.result.resolve(injected.state.llama);
                await local.dispose();
                injected.client.close();
            });
            await local.load({selection});
            pending = injected.hold('llama.status');
            const payload = {
                model: 'moon-charter-search',
                messages: [{role: 'user', content: '  Find the complete\nmoon charter.  '}]
            };
            const requested = local.request({selection, operation, payload});
            const rejected = assert.rejects(requested, {code: 'ARCANE_AI_MODEL_NOT_READY'});
            await pending.started.promise;
            injected.state.llama.models = [
                {id: replacement.modelId, loaded: true},
                {id: payload.model, loaded: true}
            ];
            await local.load({selection: replacement, executionTarget: {deviceId: 'replacement-moon-gpu'}});
            assert.equal(local.status().loaded, true);
            pending.result.resolve(injected.state.llama);
            await rejected;
            assert.equal(injected.calls.some(function dispatchedRetiredInference(call) {
                return call.method === 'llama.chat';
            }), false);
            assert.equal(local.status().loaded, true);
            assert.equal(local.status().modelId, replacement.modelId);
        }
    }
});

test('a new load revokes chat and stream acceptance before their deferred Core dispatch', async function revokeDeferredInferenceDispatch(t) {
    for (const operation of ['chat', 'stream']) {
        const injected = fixtureClient({installed: false});
        const local = createCoreLocalAIProvider({client: injected.client});
        t.after(async function releaseDeferredAcceptanceFixture() {
            await local.dispose();
            injected.client.close();
        });
        await local.load({selection});
        const requested = local.request({
            selection, operation, payload: {messages: [{role: 'user', content: '  Preserve every\nmoon charter clause.  '}]}
        });
        const replacement = local.load({selection, executionTarget: {deviceId: 'replacement-moon-gpu'}});
        const rejected = operation === 'chat'
            ? assert.rejects(requested, {code: 'ARCANE_AI_MODEL_NOT_READY'})
            : requested.then(async function rejectRetiredStream(stream) {
                await assert.rejects(stream.result, {code: 'ARCANE_AI_MODEL_NOT_READY'});
                await assert.rejects(stream[Symbol.asyncIterator]().next(), {code: 'ARCANE_AI_MODEL_NOT_READY'});
            });
        await Promise.all([replacement, rejected]);
        assert.equal(injected.calls.some(function dispatchedRetiredInference(call) {
            return call.method === 'llama.chat';
        }), false);
        assert.equal(local.status().loaded, true);
    }
});

test('synchronous ready progress cannot accept revoked native readiness', async function revokeReadinessFromReadyProgress(t) {
    const injected = fixtureClient({installed: false});
    const progress = [];
    const local = createCoreLocalAIProvider({client: injected.client});
    t.after(async function releaseReadyProgressFixture() {
        await local.dispose();
        injected.client.close();
    });
    await assert.rejects(local.load({
        selection,
        progress: function revokeReadyModel(event) {
            progress.push(event);
            if (event.phase !== 'ready') return;
            injected.state.llama.models[0].loaded = false;
            injected.emit('localai.state', {runtimes: [injected.state.llama]});
        }
    }), {code: 'ARCANE_AI_MODEL_NOT_READY'});
    assert.deepEqual(progress, [
        {phase: 'loading', modelId: selection.modelId},
        {phase: 'ready', modelId: selection.modelId}
    ]);
    assert.equal(local.status().loaded, false);
    injected.state.llama.models[0].loaded = true;
    injected.emit('localai.state', {runtimes: [injected.state.llama]});
    assert.equal(local.status().loaded, false);
    await assert.rejects(local.request({
        selection, operation: 'chat', payload: {messages: [{role: 'user', content: 'Keep the complete moon charter.'}]}
    }), {code: 'ARCANE_AI_MODEL_NOT_READY'});
    assert.equal(injected.calls.some(function dispatchedUnacceptedInference(call) {
        return call.method === 'llama.chat';
    }), false);
});
