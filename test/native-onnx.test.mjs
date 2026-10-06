import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createONNXRuntime} from '../src/local-ai/onnx.mjs';

const fixtureURL = new URL('./fixtures/native-onnx/runtime.mjs', import.meta.url);
const artifactRoot = fileURLToPath(
    new URL('../.arcane/task-artifacts/native-onnx-verification/', import.meta.url)
);
const model = 'moon-cheese-detector.onnx';

async function fixture(t, configuration, onEvent, executionDevices) {
    await mkdir(
        artifactRoot,
        {recursive: true}
    );
    const directory = await mkdtemp(
        path.join(artifactRoot, 'session-')
    );
    const modulePath = path.join(directory, 'runtime.mjs');
    await writeFile(
        modulePath,
        `import {createFixtureRuntime} from ${JSON.stringify(fixtureURL.href)};\n`
            + `export default createFixtureRuntime(${JSON.stringify(configuration)});\n`
    );
    const runtime = createONNXRuntime(
        {modulePath, onEvent, executionDevices}
    );
    t.after(
        async function releaseFixture() {
            try {
                if (configuration.releaseFailure) {
                    await assert.rejects(runtime.close(), function reportedRelease(error) {
                        return error instanceof AggregateError
                            && error.errors.some(function original(value) { return value.message === configuration.releaseFailure; });
                    });
                } else await runtime.close();
            } finally {
                await rm(directory, {recursive: true});
            }
        }
    );
    return runtime;
}

function deviceCatalog({device = null, devices = device ? [device] : [], resolution = 'matched', reason = null} = {}) {
    const catalog = {
        calls: [],
        disposals: 0,
        resolveTarget(options) {
            catalog.calls.push({method: 'resolveTarget', options});
            return {
                requestedTarget: options.executionTarget,
                resolvedDevice: options.executionTarget === null ? null : device,
                resolution: options.executionTarget === null ? 'automatic' : resolution,
                reason: options.executionTarget === null ? 'engine-default-required' : reason
            };
        },
        devices(options) {
            catalog.calls.push({method: 'devices', options});
            return {platform: 'win32', state: 'ready', devices, issues: []};
        },
        dispose() { catalog.disposals += 1; }
    };
    return catalog;
}

async function preserveProviderSelection(t) {
    for (const sessionOptions of [undefined, {graphOptimizationLevel: 'all'}]) {
        const runtime = await fixture(
            t,
            {expectedOptions: {...sessionOptions, executionProviders: ['cpu']}}
        );
        const loaded = await runtime.load(
            {id: 'cpu-default', model, sessionOptions}
        );
        assert.equal(loaded.state, 'ready');
        const configuredTarget = {source: 'cpu-default', executionProviders: ['cpu']};
        assert.deepEqual(loaded.execution, {
            preference: 'cpu', requestedTarget: null, resolvedDevice: null,
            resolution: 'automatic', reason: 'engine-default-required',
            configuredTarget, observedTarget: null, supportedBackends: [], selectedProviders: ['cpu'],
            attempts: [{executionProviders: ['cpu'], configuredTarget, status: 'configured', error: null}],
            fallback: false, discoveryError: null
        });
    }
    for (const executionProviders of [[], [{name: 'cuda', deviceId: 2}, 'cpu']]) {
        const sessionOptions = {executionProviders, graphOptimizationLevel: 'basic'};
        const runtime = await fixture(
            t,
            {expectedOptions: sessionOptions}
        );
        const loaded = await runtime.load(
            {id: 'explicit', model, sessionOptions, executionPreference: 'gpu'}
        );
        assert.equal(loaded.state, 'ready');
        const configuredTarget = {source: 'session-options', executionProviders};
        const names = executionProviders.map(function providerName(provider) {
            return typeof provider === 'string' ? provider : provider.name;
        });
        assert.deepEqual(loaded.execution, {
            preference: 'gpu', requestedTarget: null, resolvedDevice: null,
            resolution: 'automatic', reason: 'caller-session-options',
            configuredTarget, observedTarget: null, supportedBackends: [], selectedProviders: names,
            attempts: [{executionProviders: names, configuredTarget, status: 'configured', error: null}],
            fallback: false, discoveryError: null
        });
    }
}
test('native ONNX keeps CPU defaults and exact explicit provider options', preserveProviderSelection);

async function advertisedCUDA(t) {
    const backends = [
        {name: 'cpu', bundled: true},
        {name: 'webgpu', bundled: true},
        {name: 'cuda', bundled: false}
    ];
    const runtime = await fixture(
        t,
        {backends, expectedDiscoveryCalls: 1, expectedOptions: {executionProviders: ['cuda', 'cpu']}}
    );
    const loaded = await runtime.load(
        {id: 'advertised-cuda', model, executionPreference: 'gpu'}
    );
    assert.deepEqual(loaded.execution.supportedBackends, backends);
    assert.deepEqual(
        loaded.execution.selectedProviders,
        ['cuda', 'cpu']
    );
    assert.equal(loaded.execution.attempts.length, 1);
    assert.equal(loaded.execution.attempts[0].status, 'configured');
    assert.equal(loaded.execution.fallback, false);
    assert.deepEqual(runtime.current().sessions[0].execution, loaded.execution);
    assert.equal(runtime.current().sessions[0].stopping, false);
    const unloading = runtime.unload(
        {id: loaded.id}
    );
    assert.equal(runtime.current().sessions[0].stopping, true);
    assert.equal(runtime.current().sessions[0].loaded, true);
    assert.equal(runtime.current().sessions[0].exited, false);
    const unloaded = await unloading;
    assert.equal(unloaded.loaded, false);
    assert.equal(runtime.current().sessions[0].exited, true);
}
test('native ONNX attempts advertised CUDA even when its library is separately packaged', advertisedCUDA);

async function providerAlternatives(t) {
    const runtime = await fixture(
        t,
        {
            backends: ['cpu', 'cuda', 'tensorrt', 'dml', 'webgpu'].map(
                function backend(name) { return {name, bundled: name !== 'cuda' && name !== 'tensorrt'}; }
            ),
            expectedDiscoveryCalls: 1,
            failProviders: ['cuda', 'tensorrt'],
            expectedOptionsByProvider: {
                dml: {executionProviders: ['dml', 'cpu'], enableMemPattern: false, executionMode: 'sequential'}
            }
        }
    );
    const loaded = await runtime.load(
        {id: 'provider-alternatives', model, executionPreference: 'gpu'}
    );
    assert.deepEqual(
        loaded.execution.attempts.map(
            function attempted(record) { return record.executionProviders[0]; }
        ),
        ['cuda', 'tensorrt', 'dml']
    );
    assert.deepEqual(
        loaded.execution.selectedProviders,
        ['dml', 'cpu']
    );
    assert.equal(loaded.execution.fallback, false);
    assert.equal(loaded.execution.attempts[0].error.code, 'FIXTURE_PROVIDER_UNAVAILABLE');
}
test('native ONNX advances failed providers and supplies required DirectML defaults', providerAlternatives);

async function completeCPUFallback(t) {
    const sessionOptions = {enableMemPattern: true, executionMode: 'parallel'};
    const runtime = await fixture(
        t,
        {
            backends: [{name: 'cpu', bundled: true}, {name: 'dml', bundled: true}],
            expectedDiscoveryCalls: 1,
            failProviders: ['dml'],
            expectedOptionsByProvider: {
                dml: {...sessionOptions, executionProviders: ['dml', 'cpu']},
                cpu: {...sessionOptions, executionProviders: ['cpu']}
            }
        }
    );
    const loaded = await runtime.load(
        {id: 'cpu-fallback', model, sessionOptions, executionPreference: 'gpu'}
    );
    assert.equal(loaded.execution.fallback, true);
    assert.deepEqual(
        loaded.execution.selectedProviders,
        ['cpu']
    );
    const error = loaded.execution.attempts[0].error;
    assert.equal(error.message, 'dml could not load.\n  Keep the complete native diagnostic.  ');
    assert.equal(error.cause.message, 'dml driver detail\nwith another line.');
    assert.deepEqual(
        error.details,
        {provider: 'dml', content: '  Every moon-cheese wheel.\nEvery rind.  '}
    );
    assert.ok(error.stack.includes(error.message));
    const feeds = {
        float: {type: 'float32', dims: [4], data: Float32Array.of(0, -0, Infinity, NaN)},
        integer: {type: 'int64', dims: [2], data: BigInt64Array.of(1n, -9223372036854775808n)},
        text: {type: 'string', dims: [1], data: ['  Moon cheese\nwhole wheels.  ']}
    };
    const outputs = await runtime.run(
        {id: loaded.id, feeds}
    );
    assert.deepEqual(outputs, feeds);
}
test('native ONNX CPU fallback retains complete errors, caller settings and tensor data', completeCPUFallback);

async function unavailableDiscovery(t) {
    for (const configuration of [
        {backends: [{name: 'cpu', bundled: true}, {name: 'qnn', bundled: true}]},
        {discoveryFailure: 'Complete discovery failure\nwith provider details.'}
    ]) {
        const runtime = await fixture(
            t,
            {...configuration, expectedDiscoveryCalls: 1, expectedOptions: {executionProviders: ['cpu']}}
        );
        const loaded = await runtime.load(
            {id: 'cpu-after-discovery', model, executionPreference: 'gpu'}
        );
        assert.equal(loaded.execution.fallback, true);
        assert.deepEqual(
            loaded.execution.selectedProviders,
            ['cpu']
        );
        assert.equal(loaded.execution.attempts.length, 1);
        assert.equal(loaded.execution.discoveryError?.message ?? null, configuration.discoveryFailure ?? null);
    }
}
test('native ONNX uses CPU when discovery advertises no GPU or fails', unavailableDiscovery);

async function failedSessions(t) {
    const runtime = await fixture(
        t,
        {
            backends: [{name: 'cpu', bundled: true}, {name: 'webgpu', bundled: true}],
            expectedDiscoveryCalls: 1,
            failProviders: ['webgpu', 'cpu']
        }
    );
    await assert.rejects(
        runtime.load(
            {id: 'failed-sessions', model, executionPreference: 'gpu'}
        ),
        function completeFailure(error) {
            assert.equal(error.name, 'AggregateError');
            assert.equal(error.errors.length, 2);
            assert.deepEqual(
                error.errors.map(
                    function failedProvider(record) { return record.details.provider; }
                ),
                ['webgpu', 'cpu']
            );
            assert.equal(error.execution.attempts.length, 2);
            assert.deepEqual(
                error.execution.selectedProviders,
                []
            );
            assert.equal(error.execution.attempts[1].status, 'failed');
            return true;
        }
    );
}
test('native ONNX retains accelerator and CPU errors when every session attempt fails', failedSessions);

async function cancelCreation(t) {
    let began;
    let output = '';
    const started = new Promise(
        function observeCreation(resolve) { began = resolve; }
    );
    const runtime = await fixture(
        t,
        {
            backends: [{name: 'cuda', bundled: false}],
            expectedDiscoveryCalls: 1,
            holdProvider: 'cuda'
        },
        function diagnostic(event) {
            if (event.type !== 'local-ai.onnx.stdout') return;
            output += event.message;
            if (output.includes('native-onnx-create-started\n')) began();
        }
    );
    const controller = new AbortController();
    const loading = runtime.load(
        {id: 'cancel-creation', model, executionPreference: 'gpu', signal: controller.signal}
    );
    const rejected = assert.rejects(
        loading,
        {name: 'AbortError', code: 'ARCANE_CANCELLED'}
    );
    await started;
    controller.abort();
    await rejected;
    const released = await runtime.unload(
        {id: 'cancel-creation'}
    );
    assert.equal(released.state, 'unloaded');
    assert.equal(released.loaded, false);
}
test('native ONNX cancellation retires the worker during selected provider creation', cancelCreation);

test('native ONNX reports actual exit after a rejected session release', async function failedReleaseExited(t) {
    const message = 'Complete native release failure.\nKeep every diagnostic line.';
    const runtime = await fixture(t, {releaseFailure: message, expectedOptions: {executionProviders: ['cpu']}});
    await runtime.load({id: 'failed-release', model});
    await assert.rejects(runtime.unload({id: 'failed-release'}), {message});
    assert.equal(runtime.current().sessions[0].exited, true);
    assert.equal(runtime.current().sessions[0].loaded, false);
});

test('native ONNX configures an explicit CPU and retains borrowed catalog ownership', async function physicalCPU(t) {
    const device = {deviceId: 'cpu', kind: 'cpu', present: true, name: 'Moon Cheese CPU'};
    const catalog = deviceCatalog({device});
    const runtime = await fixture(t, {expectedOptions: {executionProviders: ['cpu']}}, undefined, catalog);
    assert.deepEqual(catalog.calls, []);
    const executionTarget = {deviceId: device.deviceId};
    const loaded = await runtime.load({id: 'physical-cpu', model, executionTarget, executionPreference: 'gpu'});
    assert.deepEqual(loaded.execution.requestedTarget, executionTarget);
    assert.deepEqual(loaded.execution.resolvedDevice, device);
    assert.equal(loaded.execution.resolution, 'matched');
    assert.equal(loaded.execution.reason, null);
    assert.deepEqual(loaded.execution.configuredTarget, {source: 'execution-target', executionProviders: ['cpu']});
    assert.equal(loaded.execution.observedTarget, null);
    assert.equal(loaded.execution.fallback, false);
    assert.equal(loaded.execution.attempts.length, 1);
    assert.deepEqual(catalog.calls.map(function method(call) { return call.method; }), ['resolveTarget']);
    assert.equal(catalog.calls[0].options.executionTarget, executionTarget);
    assert.ok(catalog.calls[0].options.signal instanceof AbortSignal);
    await runtime.close();
    await runtime.close();
    assert.equal(catalog.disposals, 0);
});

test('native ONNX configures the resolved DirectML adapter ordinal and fills only omitted defaults', async function physicalDirectML(t) {
    const device = {
        deviceId: 'synthetic-gpu-ordinal-seven', kind: 'gpu', present: true, isHardware: true,
        dedicatedMemoryMiB: 8192, addresses: {dxgiAdapterIndex: 7}
    };
    for (const sessionOptions of [
        {graphOptimizationLevel: 'all'},
        {graphOptimizationLevel: 'all', executionProviders: [{name: 'dml', deviceId: 7}, 'cpu']},
        {executionProviders: [{name: 'dml', deviceId: 7}, 'cpu'], enableMemPattern: true, executionMode: 'parallel'}
    ]) {
        const originalOptions = structuredClone(sessionOptions);
        const catalog = deviceCatalog({device});
        const expectedOptions = {
            ...sessionOptions, executionProviders: [{name: 'dml', deviceId: 7}, 'cpu'],
            enableMemPattern: sessionOptions.enableMemPattern ?? false,
            executionMode: sessionOptions.executionMode ?? 'sequential'
        };
        const runtime = await fixture(t, {
            backends: [{name: 'cpu', bundled: true}, {name: 'dml', bundled: true}],
            expectedDiscoveryCalls: 1, expectedOptions
        }, undefined, catalog);
        const loaded = await runtime.load({id: 'physical-dml', model, executionTarget: {deviceId: device.deviceId}, sessionOptions});
        assert.deepEqual(loaded.execution.resolvedDevice, device);
        assert.deepEqual(loaded.execution.configuredTarget, {
            source: 'execution-target', executionProviders: [{name: 'dml', deviceId: 7}, 'cpu']
        });
        assert.deepEqual(loaded.execution.selectedProviders, ['dml', 'cpu']);
        assert.equal(loaded.execution.observedTarget, null);
        assert.equal(loaded.execution.fallback, false);
        assert.deepEqual(sessionOptions, originalOptions);
    }
});

test('explicit automatic GPU selection uses the largest known hardware memory and its actual ordinal', async function automaticPhysicalGPU(t) {
    const integrated = {
        deviceId: 'synthetic-integrated-gpu', kind: 'gpu', present: true, isHardware: true,
        dedicatedMemoryMiB: 12288, addresses: {dxgiAdapterIndex: 5}
    };
    const catalog = deviceCatalog({devices: [
        {deviceId: 'synthetic-software', kind: 'gpu', present: true, isHardware: false,
            dedicatedMemoryMiB: 65536, addresses: {dxgiAdapterIndex: 0}},
        {deviceId: 'synthetic-discrete-gpu', kind: 'gpu', present: true, isHardware: true,
            dedicatedMemoryMiB: 8192, addresses: {dxgiAdapterIndex: 2}},
        integrated,
        {deviceId: 'synthetic-unknown-memory', kind: 'gpu', present: true, isHardware: true,
            dedicatedMemoryMiB: null, addresses: {dxgiAdapterIndex: 9}}
    ]});
    const runtime = await fixture(t, {
        backends: [{name: 'cpu', bundled: true}, {name: 'dml', bundled: true}], expectedDiscoveryCalls: 1,
        expectedOptions: {executionProviders: [{name: 'dml', deviceId: 5}, 'cpu'], enableMemPattern: false, executionMode: 'sequential'}
    }, undefined, catalog);
    const loaded = await runtime.load({id: 'automatic-physical', model, executionTarget: null, executionPreference: 'gpu'});
    assert.equal(loaded.execution.requestedTarget, null);
    assert.equal(loaded.execution.resolution, 'automatic');
    assert.equal(loaded.execution.reason, 'largest-supported-dedicated-memory-gpu');
    assert.deepEqual(loaded.execution.resolvedDevice, integrated);
    assert.deepEqual(loaded.execution.configuredTarget, {
        source: 'automatic-physical-target', executionProviders: [{name: 'dml', deviceId: 5}, 'cpu']
    });
    assert.equal(loaded.execution.observedTarget, null);
    assert.deepEqual(catalog.calls.map(function method(call) { return call.method; }), ['resolveTarget', 'devices']);
});

test('physical and automatic targets report conflicting explicit provider options before session creation', async function targetConflicts(t) {
    const cpu = {deviceId: 'cpu', kind: 'cpu', present: true};
    const gpu = {deviceId: 'synthetic-gpu', kind: 'gpu', present: true, addresses: {dxgiAdapterIndex: 3}};
    for (const selection of [
        {device: cpu, executionTarget: {deviceId: 'cpu'}, sessionOptions: {executionProviders: []}, reason: 'session-options-do-not-select-target'},
        {device: cpu, executionTarget: {deviceId: 'cpu'}, sessionOptions: {executionProviders: ['cuda', 'cpu']}, reason: 'session-options-target-conflict'},
        {device: gpu, executionTarget: {deviceId: gpu.deviceId}, sessionOptions: {executionProviders: [{name: 'dml', deviceId: 0}, 'cpu']}, reason: 'session-options-target-conflict'},
        {device: null, executionTarget: null, sessionOptions: {executionProviders: [{name: 'dml', deviceId: 3}, 'cpu']}, reason: 'automatic-target-fixed-session-device'}
    ]) {
        const catalog = deviceCatalog({device: selection.device});
        const runtime = await fixture(t, {backends: [{name: 'dml', bundled: true}]}, undefined, catalog);
        await assert.rejects(runtime.load({
            id: 'target-conflict', model, executionTarget: selection.executionTarget, sessionOptions: selection.sessionOptions
        }), function reportsConflict(error) {
            assert.equal(error.code, 'LOCAL_AI_EXECUTION_TARGET_CONFLICT');
            assert.equal(error.execution.reason, selection.reason);
            assert.deepEqual(error.execution.attempts, []);
            assert.equal(error.execution.configuredTarget, null);
            assert.equal(error.execution.observedTarget, null);
            return true;
        });
    }
});

test('unavailable devices and unsupported physical mappings preserve explicit failure without replacement', async function unresolvedTargets(t) {
    for (const selection of [
        {device: null, resolution: 'unavailable', reason: 'device-not-present', code: 'LOCAL_AI_EXECUTION_TARGET_UNAVAILABLE'},
        {device: null, resolution: 'unsupported', reason: 'inventory-unavailable', code: 'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED'},
        {device: {deviceId: 'synthetic-npu', kind: 'npu', present: true}, resolution: 'matched', reason: 'provider-device-mapping-unavailable', code: 'LOCAL_AI_EXECUTION_TARGET_UNSUPPORTED'}
    ]) {
        const executionTarget = {deviceId: selection.device?.deviceId ?? 'synthetic-absent-device'};
        const catalog = deviceCatalog({...selection, reason: selection.resolution === 'matched' ? null : selection.reason});
        const runtime = await fixture(t, {backends: [{name: 'dml', bundled: true}]}, undefined, catalog);
        await assert.rejects(runtime.load({id: 'unresolved-device', model, executionTarget}), function exactTargetFailure(error) {
            assert.equal(error.code, selection.code);
            assert.equal(error.execution.reason, selection.reason);
            assert.deepEqual(error.execution.requestedTarget, executionTarget);
            assert.deepEqual(error.execution.attempts, []);
            assert.equal(error.execution.configuredTarget, null);
            assert.equal(error.execution.observedTarget, null);
            assert.equal(error.execution.fallback, false);
            return true;
        });
    }
});

test('selected physical GPU failure never retries another GPU or CPU', async function noPhysicalRetry(t) {
    const device = {
        deviceId: 'synthetic-fixed-gpu', kind: 'gpu', present: true, isHardware: true,
        dedicatedMemoryMiB: 8192, addresses: {dxgiAdapterIndex: 4}
    };
    for (const executionTarget of [{deviceId: device.deviceId}, null]) {
        const catalog = deviceCatalog({device});
        const runtime = await fixture(t, {
            backends: [{name: 'cpu', bundled: true}, {name: 'dml', bundled: true}],
            expectedDiscoveryCalls: 1, failProviders: ['dml'],
            expectedOptionsByProvider: {
                dml: {executionProviders: [{name: 'dml', deviceId: 4}, 'cpu'], enableMemPattern: false, executionMode: 'sequential'}
            }
        }, undefined, catalog);
        await assert.rejects(runtime.load({id: 'no-retry', model, executionTarget, executionPreference: 'gpu'}), function retainedFailure(error) {
            assert.equal(error.code, 'FIXTURE_PROVIDER_UNAVAILABLE');
            assert.equal(error.message, 'dml could not load.\n  Keep the complete native diagnostic.  ');
            assert.equal(error.execution.attempts.length, 1);
            assert.equal(error.execution.attempts[0].status, 'failed');
            assert.deepEqual(error.execution.attempts[0].configuredTarget.executionProviders, [{name: 'dml', deviceId: 4}, 'cpu']);
            assert.deepEqual(error.execution.selectedProviders, []);
            assert.equal(error.execution.configuredTarget, null);
            assert.equal(error.execution.observedTarget, null);
            assert.equal(error.execution.fallback, false);
            return true;
        });
    }
});

test('cancelling target preparation aborts its signal and joins it after actual worker exit', async function cancelTargetPreparation(t) {
    const device = {deviceId: 'cpu', kind: 'cpu', present: true};
    const catalog = deviceCatalog({device});
    let entered;
    let completePreparation;
    let preparationSignal;
    const started = new Promise(function observePreparation(resolve) { entered = resolve; });
    const preparation = new Promise(function retainPreparation(resolve) { completePreparation = resolve; });
    catalog.resolveTarget = function holdTarget({signal}) {
        preparationSignal = signal;
        entered();
        return preparation;
    };
    const runtime = await fixture(t, {}, undefined, catalog);
    let exited;
    const workerExit = new Promise(function observeExit(resolve) { exited = resolve; });
    const unsubscribe = runtime.subscribe(function observeSession(state) {
        if (state.sessions.some(function exitedSession(session) { return session.exited; })) exited();
    });
    const resolvedTarget = {requestedTarget: {deviceId: 'cpu'}, resolvedDevice: device, resolution: 'matched', reason: null};
    try {
        const controller = new AbortController();
        const loading = runtime.load({id: 'cancel-target', model, executionTarget: {deviceId: 'cpu'}, signal: controller.signal});
        const rejected = assert.rejects(loading, {name: 'AbortError', code: 'ARCANE_CANCELLED'});
        await started;
        controller.abort();
        await rejected;
        assert.equal(preparationSignal.aborted, true);
        let released = false;
        const unloading = runtime.unload({id: 'cancel-target'}).then(function unloaded(value) { released = true; return value; });
        await workerExit;
        assert.equal(released, false);
        completePreparation(resolvedTarget);
        const unloaded = await unloading;
        assert.equal(unloaded.loaded, false);
        assert.equal(runtime.current().sessions[0].exited, true);
        assert.equal(catalog.disposals, 0);
    } finally {
        completePreparation(resolvedTarget);
        unsubscribe();
    }
});
