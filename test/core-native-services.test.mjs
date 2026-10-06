import assert from 'node:assert/strict';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {createLocalAIService} from '../src/core/services/local-ai.mjs';
import {createModelAssetService} from '../src/core/services/model-assets.mjs';
import {createExecutionDeviceService} from '../src/core/services/execution-devices.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

test('native services reuse the selected ONNX and model-assets owners without loading a model', async function nativeOwners(t) {
    let catalogDisposals = 0;
    const executionDevices = {
        devices() { throw new Error('Native owner lookup does not discover devices.'); },
        resolveTarget() { throw new Error('Native owner lookup does not select a model target.'); },
        dispose() { catalogDisposals += 1; }
    };
    const localAI = createLocalAIService(
        {runtimes: ['onnx']},
        {runtimes: [{id: 'onnx', modulePath: 'unused-synthetic-onnx-module'}], executionDevices}
    );
    const modelAssets = createModelAssetService();
    let owner;
    let assets;
    const runtime = createCoreRuntime({services: [createExecutionDeviceService({catalog: executionDevices}), localAI, modelAssets, {
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
    assert.equal(catalogDisposals, 0);
    unsubscribe();
    await runtime.close();
    assert.equal(replacement.current().closed, true);
    assert.equal(catalogDisposals, 1);
    await runtime.close();
    assert.equal(catalogDisposals, 1);
});

test('native ONNX access reports an unselected engine without constructing another owner', async function unselectedNativeOwner() {
    const localAI = createLocalAIService({runtimes: []});
    const runtime = createCoreRuntime({services: [localAI]});
    await runtime.getService('local-ai');
    assert.throws(function lookupUnselectedONNX() { localAI.getONNXRuntime(); }, {code: 'LOCAL_AI_RUNTIME_NOT_SELECTED'});
    await runtime.close();
});

test('Core ONNX forwards physical, automatic and omitted targets to its existing public owner', async function forwardExecutionTargets(t) {
    const appRoot = path.resolve('synthetic-moon-application');
    const localAI = createLocalAIService(
        {runtimes: ['onnx']},
        {appRoot, runtimes: [{id: 'onnx', modulePath: 'unused-synthetic-onnx-module'}]}
    );
    const runtime = createCoreRuntime({services: [localAI]});
    t.after(function closeForwardingOwner() { return runtime.close(); });
    await runtime.getService('local-ai');
    const onnx = localAI.getONNXRuntime();
    const calls = [];
    const result = {state: 'synthetic-forwarded-result', execution: {observedTarget: null}};
    onnx.load = function captureLoad(options) {
        calls.push(options);
        return result;
    };
    runtime.start();
    const sessionOptions = {graphOptimizationLevel: 'all', logId: '  Moon cheese\r\nComplete label.  '};
    for (const executionTarget of [{deviceId: 'synthetic-gpu-seven'}, null, undefined]) {
        const id = `forward-${calls.length}`;
        const response = await runtime.handle({
            protocol: CORE_PROTOCOL, type: 'request', id, method: 'onnx.load',
            parameters: {id, model: 'models/moon cheese.onnx', sessionOptions, executionPreference: 'gpu', executionTarget}
        });
        assert.equal(response.ok, true);
        assert.equal(response.result, result);
        const call = calls.at(-1);
        assert.equal(call.id, id);
        assert.equal(call.model, path.resolve(appRoot, 'models/moon cheese.onnx'));
        assert.equal(call.sessionOptions, sessionOptions);
        assert.equal(call.executionPreference, 'gpu');
        assert.equal(call.executionTarget, executionTarget);
        assert.ok(call.signal instanceof AbortSignal);
        assert.equal(call.signal.aborted, false);
    }
    assert.equal(calls.length, 3);
    assert.deepEqual(onnx.current().sessions, []);
});
