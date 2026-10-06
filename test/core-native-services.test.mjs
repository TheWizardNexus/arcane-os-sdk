import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {createLocalAIService} from '../src/core/services/local-ai.mjs';
import {createModelAssetService} from '../src/core/services/model-assets.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

test('native services reuse the selected ONNX and model-assets owners without loading a model', async function nativeOwners(t) {
    const localAI = createLocalAIService(
        {runtimes: ['onnx']},
        {runtimes: [{id: 'onnx', modulePath: 'unused-synthetic-onnx-module'}]}
    );
    const modelAssets = createModelAssetService();
    let owner;
    let assets;
    const runtime = createCoreRuntime({services: [localAI, modelAssets, {
        name: 'lunar-decisions',
        async start(context) {
            const service = await context.getService('local-ai');
            owner = service.getONNXRuntime();
            assets = await context.getService('model-assets');
        }
    }]});
    t.after(async function closeNativeOwners() { await runtime.close(); });
    assert.throws(function lookupBeforeStartup() { localAI.getONNXRuntime(); }, {code: 'LOCAL_AI_RUNTIME_UNAVAILABLE'});
    await runtime.getService('lunar-decisions');
    assert.equal(await runtime.getService('local-ai'), localAI);
    assert.equal(owner, localAI.getONNXRuntime());
    assert.equal(assets, modelAssets);
    assert.deepEqual(owner.current(), {sessions: [], closed: false});
    assert.deepEqual(assets.current(), {closing: false, projections: []});
    const states = [];
    const unsubscribe = owner.subscribe(function observeNativeOwner(state) { states.push(state); });
    assert.deepEqual(states, [{sessions: [], closed: false}]);
    runtime.start();
    const recovery = await runtime.handle({
        protocol: CORE_PROTOCOL, type: 'request', id: 'native-recovery',
        method: 'localai.services.recover', parameters: {runtimes: ['onnx']}
    });
    assert.equal(recovery.ok, true);
    assert.equal(owner.current().closed, true);
    const replacement = (await runtime.getService('local-ai')).getONNXRuntime();
    assert.notEqual(replacement, owner);
    assert.deepEqual(replacement.current(), {sessions: [], closed: false});
    unsubscribe();
    await runtime.close();
    assert.equal(replacement.current().closed, true);
});

test('native ONNX access reports an unselected engine without constructing another owner', async function unselectedNativeOwner() {
    const localAI = createLocalAIService({runtimes: []});
    const runtime = createCoreRuntime({services: [localAI]});
    await runtime.getService('local-ai');
    assert.throws(function lookupUnselectedONNX() { localAI.getONNXRuntime(); }, {code: 'LOCAL_AI_RUNTIME_NOT_SELECTED'});
    await runtime.close();
});
