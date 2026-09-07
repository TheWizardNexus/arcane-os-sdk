import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Script, createContext} from 'node:vm';

import Is from '../browser-runtime/dependencies/strong-type/index.js';
import {
    ARCANE_AI_ADAPTER_PROTOCOL,
    ArcaneAIError,
    normalizeModelSecurity,
    normalizeArcaneAIError,
    resolveModelSecurity
} from '../browser-runtime/ai/model-controller.mjs';
import test from '../src/testing.mjs';

const runtimeUrl = new URL('../browser-runtime/ai/browser-wllama-runtime.mjs', import.meta.url);
const providerUrl = new URL('../browser-runtime/ai/browser-wasm-llm-provider.mjs', import.meta.url);
const [runtimeSource, providerSource] = await Promise.all(
    [readFile(runtimeUrl, 'utf8'), readFile(providerUrl, 'utf8')]
);

function authoredModule(source, returned) {
    const start = source.indexOf('const is = new Is(false);');
    assert.ok(start >= 0);
    const body = source.slice(start)
        .replace(/^export /gmu, '')
        .replaceAll('import.meta.url', 'runtimeUrl');
    return new Script(`(function evaluateAuthoredModule() {\n${body}\nreturn ${returned};\n})()`);
}

const runtimeScript = authoredModule(runtimeSource, '{createPackagedWllamaRuntime}');
const providerScript = authoredModule(
    providerSource,
    '{createBrowserModelSource, createBrowserWasmLlmProvider, adaptV1LlmProvider, registerStore(store) {DBOPFS_MODEL_STORES.add(store);}}'
);

function deferred() {
    let resolvePromise;
    const promise = new Promise(
        function retainResolution(resolve) {
            resolvePromise = resolve;
        }
    );
    return {promise, resolve: resolvePromise};
}

function fixture({webgpu = false, loadDefaults = {}, onLoad = null, onCompletion = null} = {}) {
    const loads = [];
    const completions = [];
    const events = [];
    const terminations = [];
    let telemetryRequests = 0;
    let adapterRequests = 0;
    let ensured = 0;
    const modelFile = new Blob(
        ['synthetic model fixture']
    );
    const logger = {
        debug() {},
        log() {},
        warn() {},
        error() {}
    };

    class SyntheticWllama {
        constructor(paths) {
            this.paths = paths;
            this.loaded = false;
        }

        setCompat(value) {
            this.compat = value;
        }

        getWorkerResources() {
            assert.equal(this.compat, null);
            return {compat: false, wasmPath: this.paths.default};
        }

        async arcaneLoadModel(files, options, signal) {
            this.loadOptions = options;
            loads.push(
                {files, options, signal}
            );
            if (onLoad) {
                await onLoad(files, options, signal);
            }
            if (signal.aborted) {
                throw signal.reason;
            }
            this.loaded = true;
        }

        isModelLoaded() {
            return this.loaded;
        }

        async arcaneTelemetry() {
            telemetryRequests += 1;
            assert.notEqual(this.loadOptions.n_gpu_layers, 0, 'CPU loading must not observe GPU telemetry.');
            return {worker: {adapter: {name: 'Synthetic GPU'}}};
        }

        async arcaneTerminate() {
            this.loaded = false;
            terminations.push(this);
            return {cleanup: {kind: 'worker-terminated'}};
        }

        async createChatCompletion(options) {
            completions.push(options);
            return onCompletion ? onCompletion(options) : null;
        }
    }

    class SyntheticWllamaRuntimeError extends Error {}

    const navigator = {
        hardwareConcurrency: 8,
        deviceMemory: 8,
        storage: {
            async getDirectory() {
                throw new Error('Storage is supplied by the synthetic model store.');
            }
        }
    };
    if (webgpu) {
        navigator.gpu = {
            requestAdapter() {
                adapterRequests += 1;
                throw new Error('The page must not initialize a second GPU adapter.');
            }
        };
    }
    const context = createContext(
        {
            Is,
            Error,
            URL,
            Blob,
            File,
            TextEncoder,
            AbortController,
            WebAssembly,
            navigator,
            isSecureContext: true,
            crossOriginIsolated: false,
            setInterval,
            clearInterval,
            runtimeUrl: runtimeUrl.href,
            Wllama: SyntheticWllama,
            WllamaRuntimeError: SyntheticWllamaRuntimeError,
            arcaneLogging: logger,
            ARCANE_AI_ADAPTER_PROTOCOL,
            ArcaneAIError,
            normalizeModelSecurity,
            normalizeArcaneAIError,
            resolveModelSecurity,
            getBrowserDeviceSettings() {
                return {};
            },
            describeBrowserGpu() {
                return {};
            },
            arcaneEvents: {
                instrument(...args) {
                    events.push(args);
                }
            }
        }
    );
    const runtimeModule = runtimeScript.runInContext(context);
    const runtimes = [];
    context.createPackagedWllamaRuntime = function retainAuthoredRuntime(options) {
        const runtime = runtimeModule.createPackagedWllamaRuntime(options);
        runtimes.push(runtime);
        return runtime;
    };
    const providerModule = providerScript.runInContext(context);
    const source = providerModule.createBrowserModelSource(
        {
            id: 'synthetic-cpu-model',
            files: [
                {
                    name: 'synthetic-cpu.gguf',
                    url: 'https://example.test/synthetic-cpu.gguf'
                }
            ]
        }
    );
    const store = {
        async ensure(selected, {onCapabilityPolicy}) {
            assert.equal(selected, source);
            ensured += 1;
            onCapabilityPolicy(
                {compatibility: 'compatible'}
            );
            return {cache: 'cached', files: [modelFile]};
        }
    };
    providerModule.registerStore(store);
    const provider = providerModule.createBrowserWasmLlmProvider(
        {sources: [source], store, loadDefaults, logger}
    );
    const adapted = providerModule.adaptV1LlmProvider(provider);
    const selection = {providerId: provider.id, modelId: source.id, localOnly: true};
    return {
        provider,
        adapted,
        selection,
        runtime: runtimes[0],
        loads,
        completions,
        events,
        terminations,
        counters() {
            return {telemetryRequests, adapterRequests, ensured};
        }
    };
}

test(
    'CPU defaults inspect and load without WebGPU and never report GPU execution',
    async function cpuWithoutWebgpu() {
        const current = fixture(
            {loadDefaults: {gpuLayers: 0}}
        );
        const inspection = await current.adapted.inspect(current.selection);
        assert.equal(inspection.available, true);
        assert.equal(current.provider.capabilities().webgpuApiPresent, false);
        assert.equal(current.provider.capabilities().webgpuRequired, false);
        assert.equal(current.provider.capabilities().executionDevice, 'cpu');
        const initial = current.provider.catalog()[0].compatibilityDetails;
        assert.notEqual(initial.compatibility, 'incompatible');
        assert.ok(
            initial.reasons.every(
                function noGpuReason(reason) {
                    return !reason.code.includes('WEBGPU');
                }
            )
        );

        await current.adapted.load(
            {selection: current.selection}
        );
        const status = current.provider.status();
        assert.equal(status.loaded, true);
        assert.equal(status.cache.state, 'cached');
        assert.equal(status.capabilityPolicy.compatibility, 'compatible');
        assert.equal(status.capabilityPolicy.load.gpuLayers, 0);
        assert.equal(status.runtime.executionPolicy.defaultGpuLayers, 99_999);
        assert.equal(status.runtime.executionPolicy.cpuGpuLayers, 0);
        assert.equal(status.runtime.executionPolicy.cpuFallback, false);
        assert.equal(status.runtimeEvidence.executionDevice, 'cpu');
        assert.equal(status.runtimeEvidence.webgpu.observed, false);
        assert.equal(status.runtimeEvidence.webgpu.adapter, null);
        assert.equal(status.capabilities.webgpuOperational, false);
        assert.equal(current.loads[0].options.n_gpu_layers, 0);
        assert.equal(current.events.length, 0);
        assert.deepEqual(
            current.counters(),
            {telemetryRequests: 0, adapterRequests: 0, ensured: 1}
        );
        await current.provider.unload();
        assert.equal(current.terminations.length, 1);
        assert.equal(current.provider.capabilities().executionDevice, 'cpu');
    }
);

test(
    'CPU per-load overrides preserve GPU defaults and require unload before device changes',
    async function explicitCpuAndDefaultGpuReloads() {
        const absentGpu = fixture();
        assert.equal((await absentGpu.adapted.inspect(absentGpu.selection)).available, false);
        await absentGpu.provider.load(
            {gpuLayers: 0}
        );
        assert.equal(absentGpu.provider.status().loaded, true);
        await absentGpu.provider.unload();
        assert.equal(absentGpu.provider.status().capabilityPolicy.load.gpuLayers, 99_999);
        assert.equal((await absentGpu.adapted.inspect(absentGpu.selection)).available, false);
        await assert.rejects(
            absentGpu.provider.load(),
            {code: 'ARCANE_AI_WEBGPU_REQUIRED'}
        );
        assert.equal(absentGpu.loads.length, 1);
        await absentGpu.provider.unload();

        const current = fixture(
            {webgpu: true}
        );
        await current.provider.load();
        assert.equal(current.loads[0].options.n_gpu_layers, 99_999);
        assert.equal(current.provider.status().runtimeEvidence.webgpu.observed, true);
        await assert.rejects(
            current.provider.load(
                {gpuLayers: 0}
            ),
            {code: 'ARCANE_AI_LOAD_PLAN_RELOAD_REQUIRED'}
        );
        await current.provider.unload();
        await current.provider.load(
            {gpuLayers: 0}
        );
        assert.equal(current.loads[1].options.n_gpu_layers, 0);
        assert.equal(current.provider.status().runtimeEvidence.executionDevice, 'cpu');
        await current.provider.unload();
        await current.provider.load(
            {gpuLayers: 3}
        );
        assert.equal(current.loads[2].options.n_gpu_layers, 99_999, 'Positive provider values retain full GPU selection.');
        assert.equal(current.provider.status().runtimeEvidence.executionDevice, 'webgpu');
        assert.equal(current.counters().telemetryRequests, 2);
        assert.equal(current.counters().adapterRequests, 0);
        await current.provider.unload();
    }
);

test(
    'CPU loading cancels the owned load and preserves reload availability',
    async function cpuLoadCancellation() {
        const entered = deferred();
        let first = true;
        const current = fixture(
            {
                loadDefaults: {gpuLayers: 0},
                async onLoad(files, options, signal) {
                    if (!first) return;
                    first = false;
                    entered.resolve();
                    await new Promise(
                        function awaitLoadAbort(resolve, reject) {
                            signal.addEventListener(
                                'abort',
                                function rejectCancelledLoad() {
                                    reject(signal.reason);
                                },
                                {once: true}
                            );
                        }
                    );
                }
            }
        );
        const controller = new AbortController();
        const loading = current.provider.load(
            {signal: controller.signal}
        );
        const cancellation = assert.rejects(
            loading,
            {code: 'ARCANE_AI_REQUEST_ABORTED'}
        );
        await entered.promise;
        controller.abort(
            new Error('Synthetic CPU load cancellation.')
        );
        await cancellation;
        assert.equal(current.provider.status().loaded, false);
        assert.equal(current.terminations.length, 1);
        assert.equal(current.counters().telemetryRequests, 0);
        await current.provider.unload();
        await current.provider.load();
        assert.equal(current.provider.status().loaded, true);
        assert.equal(current.loads[1].options.n_gpu_layers, 0);
        await current.provider.unload();
    }
);

test(
    'CPU inference retains complete messages tools chunks and active cancellation',
    async function cpuInferenceFidelity() {
        const messages = [{role: 'user', content: '  First line\nSecond line with all content.  '}];
        const tools = [{type: 'function', function: {name: 'example', description: 'Complete tool description.'}}];
        const chunks = [
            {choices: [{index: 0, delta: {content: '  First\n'}}]},
            {choices: [{index: 0, delta: {content: 'Second  '}}]},
            {choices: [{index: 0, delta: {tool_calls: [{index: 0, function: {arguments: '{"message":"Complete"}'}}]}}]}
        ];
        const terminal = {choices: [{index: 0, message: {role: 'assistant', content: '  First\nSecond  '}}]};
        const requestStarted = deferred();
        const current = fixture(
            {
                loadDefaults: {gpuLayers: 0},
                async onCompletion(options) {
                    if (options.cancelFixture) {
                        requestStarted.resolve();
                        await new Promise(
                            function awaitInferenceAbort(resolve, reject) {
                                options.abortSignal.addEventListener(
                                    'abort',
                                    function rejectCancelledInference() {
                                        reject(options.abortSignal.reason);
                                    },
                                    {once: true}
                                );
                            }
                        );
                    }
                    if (options.onData) {
                        for (const chunk of chunks) options.onData(chunk);
                    }
                    return terminal;
                }
            }
        );
        await current.provider.load();
        const received = [];
        const streamed = await current.runtime.stream(
            {messages, tools},
            function receiveExactChunk(chunk) {
                received.push(chunk);
            }
        );
        assert.equal(streamed, terminal);
        assert.deepEqual(received, chunks);
        for (let index = 0; index < chunks.length; index += 1) {
            assert.equal(received[index], chunks[index]);
        }
        assert.equal(current.completions[0].messages, messages);
        assert.equal(current.completions[0].tools, tools);
        assert.equal(
            await current.runtime.chat(
                {messages, tools}
            ),
            terminal
        );

        const controller = new AbortController();
        const pending = current.runtime.chat(
            {messages, tools, cancelFixture: true, abortSignal: controller.signal}
        );
        const reason = new Error('Synthetic CPU inference cancelled.');
        reason.name = 'AbortError';
        const cancelled = assert.rejects(pending, reason);
        await requestStarted.promise;
        controller.abort(reason);
        await cancelled;
        assert.equal(current.runtime.isLoaded(), true);
        assert.equal(
            await current.runtime.chat(
                {messages, tools}
            ),
            terminal
        );
        assert.equal(current.counters().telemetryRequests, 0);
        await current.provider.unload();
    }
);

test(
    'CPU memory failures are labeled for CPU and do not inherit a GPU failure',
    async function deviceSpecificFailurePolicy() {
        const current = fixture(
            {
                webgpu: true,
                loadDefaults: {gpuLayers: 0},
                async onLoad() {
                    throw new Error('Synthetic allocation failed.');
                }
            }
        );
        await assert.rejects(
            current.provider.load(
                {gpuLayers: 99_999}
            ),
            /Synthetic allocation failed/u
        );
        assert.ok(
            current.provider.status().capabilityPolicy.reasons.some(
                function gpuFailure(reason) {
                    return reason.code === 'ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT';
                }
            )
        );
        await current.provider.unload();
        const cpuPolicy = current.provider.catalog()[0].compatibilityDetails;
        assert.ok(
            cpuPolicy.reasons.every(
                function noPriorGpuFailure(reason) {
                    return reason.code !== 'ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT';
                }
            )
        );
        assert.equal((await current.adapted.inspect(current.selection)).available, true);
        await assert.rejects(current.provider.load(), /Synthetic allocation failed/u);
        assert.ok(
            current.provider.status().capabilityPolicy.reasons.some(
                function cpuFailure(reason) {
                    return reason.code === 'ARCANE_AI_MODEL_CPU_MEMORY_INSUFFICIENT';
                }
            )
        );
        await current.provider.unload();
    }
);
