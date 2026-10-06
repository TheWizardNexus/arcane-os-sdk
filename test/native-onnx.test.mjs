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

async function fixture(t, configuration, onEvent) {
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
        {modulePath, onEvent}
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
        assert.equal(loaded.execution, undefined);
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
        assert.equal(loaded.execution, undefined);
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
    const unloaded = await runtime.unload(
        {id: loaded.id}
    );
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
