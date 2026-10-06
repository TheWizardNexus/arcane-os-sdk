import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {createExecutionDeviceService} from '../src/core/services/execution-devices.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function retainCompletion(done) { resolve = done; });
    return {promise, resolve};
}

function request(id, method, parameters = {}) {
    return {protocol: CORE_PROTOCOL, type: 'request', id, method, parameters};
}

test('execution-device service construction is lazy and forwards catalog options and results', async function injectedCatalog() {
    const inventory = {platform: 'synthetic', state: 'ready', devices: [], issues: []};
    const executionTarget = {deviceId: 'synthetic-moon-cheese-accelerator'};
    const resolution = {
        requestedTarget: executionTarget, resolvedDevice: null,
        resolution: 'unavailable', reason: 'device-not-present'
    };
    const calls = [];
    let disposals = 0;
    const catalog = {
        devices(options) {
            calls.push({method: 'devices', options});
            return inventory;
        },
        resolveTarget(options) {
            calls.push({method: 'resolveTarget', options});
            return resolution;
        },
        dispose() { disposals += 1; }
    };
    const service = createExecutionDeviceService({catalog});
    assert.equal(service.name, 'execution-devices');
    assert.deepEqual(Object.keys(service.methods), ['localai.devices', 'localai.resolveTarget']);
    assert.deepEqual(calls, []);
    assert.equal(disposals, 0);
    const controller = new AbortController();
    const context = {signal: controller.signal};
    assert.equal(await service.methods['localai.devices']({refresh: true}, context), inventory);
    assert.equal(await service.methods['localai.resolveTarget']({executionTarget, refresh: true}, context), resolution);
    assert.equal(await service.methods['localai.devices'](), inventory);
    assert.equal(await service.methods['localai.resolveTarget'](), resolution);
    assert.deepEqual(calls, [
        {method: 'devices', options: {refresh: true, signal: controller.signal}},
        {method: 'resolveTarget', options: {executionTarget, refresh: true, signal: controller.signal}},
        {method: 'devices', options: {refresh: false, signal: undefined}},
        {method: 'resolveTarget', options: {executionTarget: null, refresh: false, signal: undefined}}
    ]);
    assert.equal(calls[1].options.executionTarget, executionTarget);
    assert.equal(calls[0].options.signal, controller.signal);
    assert.equal(calls[1].options.signal, controller.signal);
    await service.dispose();
    assert.equal(disposals, 1);
});

test('device inventory stays independent of pending local-AI startup and Core closes its catalog once', async function independentInventory(t) {
    const startup = deferred();
    const started = deferred();
    const inventory = {platform: 'synthetic', state: 'ready', devices: [], issues: []};
    const resolution = {
        requestedTarget: null, resolvedDevice: null,
        resolution: 'automatic', reason: 'engine-default-required'
    };
    const calls = [];
    let disposals = 0;
    const service = createExecutionDeviceService({catalog: {
        devices(options) {
            calls.push({method: 'devices', options});
            return inventory;
        },
        resolveTarget(options) {
            calls.push({method: 'resolveTarget', options});
            return resolution;
        },
        dispose() { disposals += 1; }
    }});
    const runtime = createCoreRuntime({services: [service, {
        name: 'local-ai',
        start() {
            started.resolve();
            return startup.promise;
        }
    }]});
    t.after(async function finishOwnedCore() {
        startup.resolve();
        await runtime.close();
    });
    assert.equal(runtime.start().state, 'ready');
    await started.promise;
    assert.equal(await runtime.getService('execution-devices'), service);
    assert.deepEqual(calls, []);
    const devices = await runtime.handle(request('inventory', 'localai.devices', {refresh: true}));
    assert.equal(devices.ok, true);
    assert.equal(devices.result, inventory);
    const target = await runtime.handle(request('automatic', 'localai.resolveTarget', {executionTarget: null}));
    assert.equal(target.ok, true);
    assert.equal(target.result, resolution);
    assert.equal(runtime.current().services.find(function localAI(candidate) { return candidate.name === 'local-ai'; }).state, 'starting');
    assert.equal(calls[0].options.refresh, true);
    assert.equal(calls[1].options.executionTarget, null);
    assert.equal(calls[1].options.refresh, false);
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.ok(calls[1].options.signal instanceof AbortSignal);
    assert.equal(disposals, 0);
    startup.resolve();
    const closing = runtime.close();
    assert.equal(runtime.close(), closing);
    await closing;
    assert.equal(disposals, 1);
    await runtime.close();
    assert.equal(disposals, 1);
    assert.equal(runtime.current().state, 'closed');
});

test('Core request cancellation reaches the inventory catalog without disposing its host', async function inventoryCancellation(t) {
    const entered = deferred();
    const result = deferred();
    const inventory = {platform: 'synthetic', state: 'ready', devices: [], issues: []};
    let requestedRefresh;
    let requestSignal;
    let disposals = 0;
    const runtime = createCoreRuntime({services: [createExecutionDeviceService({catalog: {
        devices({refresh, signal}) {
            requestedRefresh = refresh;
            requestSignal = signal;
            entered.resolve();
            return result.promise;
        },
        resolveTarget() { throw new Error('This request selects inventory only.'); },
        dispose() { disposals += 1; }
    }})]});
    t.after(async function finishOwnedInventory() {
        result.resolve(inventory);
        await runtime.close();
    });
    runtime.start();
    const pending = runtime.handle(request('cancelled-inventory', 'localai.devices', {refresh: true}));
    await entered.promise;
    assert.equal(requestedRefresh, true);
    assert.equal(requestSignal.aborted, false);
    assert.equal(await runtime.handle({
        protocol: CORE_PROTOCOL, type: 'control', control: 'request.cancel', requestId: 'cancelled-inventory'
    }), true);
    assert.equal(requestSignal.aborted, true);
    assert.equal(disposals, 0);
    result.resolve(inventory);
    const response = await pending;
    assert.equal(response.ok, false);
    assert.equal(response.error.code, 'REQUEST_ABORTED');
    assert.equal(disposals, 0);
    await runtime.close();
    assert.equal(disposals, 1);
});
