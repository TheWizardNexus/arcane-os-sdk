import assert from 'node:assert/strict';
import {test} from '../src/testing.mjs';
import {createBrowserDecisionModel} from '../browser-runtime/ai/browser-decisions.mjs';
import {createDecisionInputs, encodeDecisionRows, loadDecisionRuntime} from '../browser-runtime/ai/decision-runtime.mjs';

// Synthetic tokenizers, tensors and Workers exercise SDK boundaries without
// downloading a runtime/model or claiming real inference or accelerator proof.
test(
    'decision framing preserves whole fields and distinguishes option markers from literal masks',
    function completeDecisionFraming() {
        const longValue = '  octopus  雪 🐙\n'.repeat(600);
        for (const family of ['laya', 'julia']) {
            const literalMask = family === 'laya' ? '[MASK]' : '<mask>';
            const state = `${longValue}${literalMask}  end\n`;
            const question = `  choose  ${literalMask} 🐙\n`;
            const option = ` keep  ${literalMask}  雪`;
            const rows = [
                {state, question, options: [option, longValue]},
                {state, question: 'Score?', options: ['only'], type: 'score'},
                {state, question: 'True?', options: ['false', 'true'], type: 'noul'}
            ];
            const vocabulary = new Map(
                [
                    [`choice question: ${question}`, [11, 3, 12]],
                    [` ${option}`, [13, 3, 14]],
                    [` ${longValue}`, [15, 16]],
                    [state, [17, 18, 3, 19]],
                    ['score question: Score?', [20]],
                    [' only', [21]],
                    ['noul question: True?', [22]],
                    [' false', [23]],
                    [' true', [24]]
                ]
            );
            const calls = [];
            const specialTokens = [];
            const tokenizer = {
                cls_token_id: family === 'laya' ? 1 : undefined,
                sep_token_id: family === 'laya' ? 2 : undefined,
                mask_token_id: family === 'laya' ? 3 : undefined,
                pad_token_id: family === 'laya' ? 0 : undefined,
                convert_tokens_to_ids(token) {
                    specialTokens.push(token);
                    const tokens = ['<bos>', '<eos>', '<mask>', '<pad>'];
                    const ids = [1, 2, 3, 0];
                    const index = tokens.indexOf(token);
                    assert.notEqual(index, -1);
                    return ids[index];
                },
                encode(text, options) {
                    calls.push(
                        {text, options}
                    );
                    assert.ok(vocabulary.has(text), 'Each whole framed field has one tokenizer call.');
                    return vocabulary.get(text);
                }
            };
            const result = encodeDecisionRows(tokenizer, rows, family);
            assert.deepEqual(
                specialTokens,
                family === 'julia' ? ['<bos>', '<eos>', '<mask>', '<pad>'] : []
            );
            assert.deepEqual(
                result,
                {
                    pad: 0,
                    encoded: [
                        {ids: [1, 11, 3, 12, 2, 3, 13, 3, 14, 3, 15, 16, 2, 17, 18, 3, 19, 2], markers: [5, 9], qtype: 0},
                        {ids: [1, 20, 2, 3, 21, 2, 17, 18, 3, 19, 2], markers: [3], qtype: 1},
                        {ids: [1, 22, 2, 3, 23, 3, 24, 2, 17, 18, 3, 19, 2], markers: [3, 5], qtype: 2}
                    ]
                }
            );
            assert.deepEqual(
                calls.map(
                    function framedText(call) { return call.text; }
                ),
                [...vocabulary.keys()]
            );
            for (const call of calls) {
                assert.deepEqual(
                    call.options,
                    {add_special_tokens: false}
                );
            }
            assert.equal(rows[0].state, state);
            assert.equal(rows[0].question, question);
            assert.equal(rows[0].options[0], option);
            assert.equal(rows[0].options[1], longValue);
        }
    }
);

const RUNTIME_FIXTURE_SOURCE = `
export const fixture = {loads: [], calls: [], inputs: [], tensors: [], outputs: null};
export const env = {backends: {onnx: {wasm: {}}}};
export class Tensor {
    constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
        this.disposed = false;
        fixture.tensors.push(this);
    }
    async getData() { return this.data; }
    dispose() { this.disposed = true; }
}
export const AutoTokenizer = {
    async from_pretrained(repository, options) {
        fixture.loads.push(
            {loader: 'tokenizer', repository, options}
        );
        return {
            cls_token_id: 1,
            sep_token_id: 2,
            mask_token_id: 3,
            pad_token_id: 0,
            encode(text, settings) {
                fixture.calls.push(
                    {text, settings}
                );
                return Array.from(
                    text,
                    function syntheticToken(character) { return character.codePointAt(0) + 10; }
                );
            }
        };
    }
};
async function evaluateFixtureModel(inputs) {
    fixture.inputs.push(inputs);
    return fixture.outputs;
}
export const AutoModel = {
    async from_pretrained(repository, options) {
        fixture.loads.push(
            {loader: 'auto', repository, options}
        );
        return evaluateFixtureModel;
    }
};
export const PreTrainedModel = {
    async from_pretrained(repository, options) {
        fixture.loads.push(
            {loader: 'pretrained', repository, options}
        );
        return evaluateFixtureModel;
    }
};
`;

test(
    'selected runtime receives exact precision and graph tensors and preserves complete model outputs',
    async function selectedRuntimeContracts() {
        for (const [family, dtype] of [['laya', undefined], ['julia', undefined], ['laya', 'fp32']]) {
            const moduleUrl = `data:text/javascript,${encodeURIComponent(RUNTIME_FIXTURE_SOURCE)}#${family}-${dtype}`;
            const namespace = await import(moduleUrl);
            const {fixture, Tensor} = namespace;
            const phases = [];
            const configuration = {
                family,
                model: `fixture/${family}`,
                revision: 'fixture-revision',
                device: 'wasm',
                dtype,
                runtime: {moduleUrl, wasmPaths: 'https://runtime.example.test/wasm/'}
            };
            const engine = await loadDecisionRuntime(
                configuration,
                function recordPhase(progress) { phases.push(progress.phase); }
            );
            assert.deepEqual(
                phases,
                ['loading-runtime', 'loading-tokenizer', 'loading-model', 'ready']
            );
            assert.equal(namespace.env.backends.onnx.wasm.wasmPaths, configuration.runtime.wasmPaths);
            assert.deepEqual(
                fixture.loads[0],
                {loader: 'tokenizer', repository: configuration.model, options: {revision: 'fixture-revision'}}
            );
            const expectedOptions = family === 'laya'
                ? {revision: 'fixture-revision', device: 'wasm', dtype: dtype ?? 'fp16', use_external_data_format: true}
                : {
                    revision: 'fixture-revision',
                    device: 'wasm',
                    dtype: 'fp32',
                    config: {model_type: 'custom'},
                    subfolder: '',
                    model_file_name: 'model',
                    use_external_data_format: false,
                    session_options: {externalData: [{path: 'model.onnx.data', data: 'model.onnx.data'}]}
                };
            assert.deepEqual(
                fixture.loads[1],
                {loader: family === 'laya' ? 'auto' : 'pretrained', repository: configuration.model, options: expectedOptions}
            );
            const rows = [
                {state: 'x', question: '', options: ['', '', '']},
                {state: 'x', question: '', options: ['', ''], type: 'score'},
                {state: 'x', question: '', options: ['false', 'true'], type: 'noul'}
            ];
            const rawLogits = new Float32Array(
                [0, 1, 2, 0, 1, -99, 0, 1, -88]
            );
            const extraValues = new BigInt64Array(
                [91n, 92n, 93n, 94n]
            );
            fixture.outputs = {
                logits: new Tensor(
                    'float32', rawLogits,
                    [3, 3]
                ),
                extra: new Tensor(
                    'int64', extraValues,
                    [2, 2]
                )
            };
            if (family === 'laya') {
                fixture.outputs.act_logits = new Tensor(
                    'float32',
                    new Float32Array(
                        [1, 0, 0, 1, 2, 0]
                    ),
                    [3, 2]
                );
            }
            const result = await engine.evaluate(rows);
            const inputs = fixture.inputs[0];
            assert.deepEqual(
                Object.keys(inputs),
                ['input_ids', 'attention_mask', 'marker_pos', 'marker_mask', 'qtype']
            );
            for (const name of ['input_ids', 'attention_mask', 'marker_pos', 'qtype']) {
                assert.equal(inputs[name].type, 'int64');
                assert.ok(inputs[name].data instanceof BigInt64Array);
            }
            assert.equal(inputs.marker_mask.type, 'bool');
            assert.ok(inputs.marker_mask.data instanceof Uint8Array);
            assert.deepEqual(
                inputs.input_ids.dims,
                [3, 33]
            );
            assert.deepEqual(
                inputs.attention_mask.dims,
                [3, 33]
            );
            assert.deepEqual(
                inputs.marker_pos.dims,
                [3, 3]
            );
            assert.deepEqual(
                inputs.marker_mask.dims,
                [3, 3]
            );
            assert.deepEqual(
                inputs.qtype.dims,
                [3]
            );
            assert.deepEqual(
                Array.from(inputs.marker_pos.data),
                [19n, 21n, 23n, 18n, 20n, 0n, 17n, 24n, 0n]
            );
            assert.deepEqual(
                Array.from(inputs.marker_mask.data),
                [1, 1, 1, 1, 1, 0, 1, 1, 0]
            );
            assert.deepEqual(
                Array.from(inputs.qtype.data),
                [0n, 1n, 2n]
            );
            const rowLengths = [28, 25, 33];
            for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
                for (let position = 0; position < 33; position += 1) {
                    const offset = rowIndex * 33 + position;
                    const populated = position < rowLengths[rowIndex];
                    assert.equal(inputs.attention_mask.data[offset], populated ? 1n : 0n);
                    if (!populated) assert.equal(inputs.input_ids.data[offset], 0n);
                }
            }
            assert.deepEqual(result.outputs.logits.data, rawLogits);
            assert.notEqual(result.outputs.logits.data, rawLogits);
            assert.deepEqual(
                result.outputs.logits.dims,
                [3, 3]
            );
            assert.deepEqual(result.outputs.extra.data, extraValues);
            assert.deepEqual(
                result.outputs.extra.dims,
                [2, 2]
            );
            assert.equal(result.outputs.extra.type, 'int64');
            assert.equal(result.decisions[0].answerIndex, 2);
            assert.equal(result.decisions[0].row, rows[0]);
            assert.deepEqual(
                result.decisions[1].logits,
                [0, 1]
            );
            assert.deepEqual(
                result.decisions[2].logits,
                [0, 1]
            );
            const probability = 1 / (1 + Math.exp(-1));
            assert.equal(result.decisions[1].value, probability);
            assert.equal(result.decisions[2].value, probability);
            assert.equal(result.decisions[2].probabilities[1], probability);
            assert.notEqual(probability, Number(probability.toFixed(4)));
            if (family === 'laya') {
                assert.deepEqual(
                    result.decisions[0].actionLogits,
                    [1, 0]
                );
                assert.deepEqual(
                    result.decisions[0].actionProbabilities,
                    [probability, Math.exp(-1) / (1 + Math.exp(-1))]
                );
                assert.equal(result.decisions[0].actProbability, probability);
                assert.deepEqual(result.outputs.act_logits.data, fixture.outputs.act_logits.data);
            } else {
                for (const decision of result.decisions) {
                    assert.equal(Object.hasOwn(decision, 'actionLogits'), false);
                    assert.equal(Object.hasOwn(decision, 'actionProbabilities'), false);
                    assert.equal(Object.hasOwn(decision, 'actProbability'), false);
                }
            }
            for (const tensor of fixture.tensors) assert.equal(tensor.disposed, true);
            assert.deepEqual(
                await engine.evaluate(
                    []
                ),
                {decisions: [], outputs: {}}
            );
            assert.equal(fixture.inputs.length, 1);
        }
    }
);

test('shared decision tensors preserve complete native records and browser precision selection', function decisionTensorRecords() {
    const records = createDecisionInputs(
        [{ids: [1, 2, 3], markers: [2], qtype: 0}, {ids: [4], markers: [0], qtype: 2}],
        9
    );
    assert.deepEqual(records.input_ids, {type: 'int64', data: new BigInt64Array([1n, 2n, 3n, 4n, 9n, 9n]), dims: [2, 3]});
    assert.deepEqual(records.attention_mask.data, new BigInt64Array([1n, 1n, 1n, 1n, 0n, 0n]));
    assert.deepEqual(records.marker_pos, {type: 'int64', data: new BigInt64Array([2n, 0n]), dims: [2, 1]});
    assert.deepEqual(records.marker_mask, {type: 'bool', data: new Uint8Array([1, 1]), dims: [2, 1]});
    assert.deepEqual(records.qtype, {type: 'int64', data: new BigInt64Array([0n, 2n]), dims: [2]});
    const selected = createBrowserDecisionModel({family: 'laya', model: 'fixture/laya', dtype: 'fp32'});
    assert.equal(selected.status().dtype, 'fp32');
    assert.equal(selected.status().state, 'unloaded');
    selected.dispose();
});

function createWorkerFixture(context) {
    const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const workers = [];
    const clients = [];
    class FixtureWorker extends EventTarget {
        constructor(url, options) {
            super();
            this.url = url;
            this.options = options;
            this.messages = [];
            this.messageListeners = [];
            this.terminated = false;
            workers.push(this);
        }

        addEventListener(type, listener, options) {
            if (type === 'message') this.messageListeners.push(listener);
            super.addEventListener(type, listener, options);
        }

        postMessage(message) {
            this.messages.push(structuredClone(message));
            this.dispatchEvent(new Event('fixture-posted'));
        }

        terminate() {
            this.terminated = true;
        }

        reply(message) {
            this.dispatchEvent(
                new MessageEvent(
                    'message',
                    {data: structuredClone(message)}
                )
            );
        }

        waitForLoad() {
            const worker = this;
            return new Promise(function observeLoad(resolve) {
                function loadPosted() {
                    const request = worker.messages.find(function isLoad(message) {
                        return message.op === 'load';
                    });
                    if (!request) return;
                    worker.removeEventListener('fixture-posted', loadPosted);
                    resolve(request);
                }
                worker.addEventListener('fixture-posted', loadPosted);
                loadPosted();
            });
        }

        waitForEvaluation(count = 1) {
            const worker = this;
            return new Promise(
                function observeEvaluation(resolve) {
                    function evaluationPosted() {
                        const requests = worker.messages.filter(
                            function isEvaluation(message) { return message.op === 'evaluate'; }
                        );
                        if (requests.length < count) return;
                        worker.removeEventListener('fixture-posted', evaluationPosted);
                        resolve(requests[count - 1]);
                    }
                    worker.addEventListener('fixture-posted', evaluationPosted);
                    evaluationPosted();
                }
            );
        }
    }
    Object.defineProperty(
        globalThis,
        'Worker',
        {value: FixtureWorker, writable: true, configurable: true}
    );
    context.after(
        function releaseWorkerFixture() {
            try {
                for (const client of clients) client.dispose();
                for (const worker of workers) assert.equal(worker.terminated, true);
            } finally {
                if (originalWorker) {
                    Object.defineProperty(globalThis, 'Worker', originalWorker);
                } else {
                    delete globalThis.Worker;
                }
            }
        }
    );
    function createClient(family = 'laya', store = null, configuration = {}) {
        const client = createBrowserDecisionModel(
            {family, model: `fixture/${family}`, ...configuration, store}
        );
        clients.push(client);
        return client;
    }
    return {workers, createClient};
}

function finishFixtureLoad(worker) {
    worker.reply(
        {id: worker.messages[0].id, result: {loaded: true}}
    );
}

function createRuntimeUrlFixture(context, workers) {
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const created = [];
    const revoked = [];
    Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        writable: true,
        value: function createFixtureRuntimeUrl(blob) {
            const url = `blob:https://runtime.example.test/decision-${created.length + 1}`;
            created.push({url, blob});
            return url;
        }
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        writable: true,
        value: function revokeFixtureRuntimeUrl(url) {
            const worker = workers.find(function ownsRuntime(candidate) {
                return candidate.messages.some(function selectedRuntime(message) {
                    return message.payload?.runtime?.moduleUrl === url;
                });
            }) ?? workers.at(-1);
            revoked.push({url, terminated: worker.terminated});
        }
    });
    context.after(function restoreRuntimeUrlFixture() {
        if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
        else delete URL.createObjectURL;
        if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
        else delete URL.revokeObjectURL;
    });
    return {created, revoked};
}

function storedRuntimeResponse() {
    return {
        file: new Blob([RUNTIME_FIXTURE_SOURCE], {type: 'application/octet-stream'}),
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/octet-stream']],
        url: 'https://runtime.example.test/transformers.js',
        redirected: false
    };
}

test('stored runtime entry is lazy, complete and reused through its original URL across activations', async function storedRuntimeEntry(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    const sourceUrl = 'https://runtime.example.test/transformers.js';
    const requests = [];
    const saved = new Map();
    const response = storedRuntimeResponse();
    let downloads = 0;
    const store = {
        async fetchResource(input, {signal, onProgress}) {
            assert.equal(signal.aborted, false);
            requests.push(input);
            const cached = saved.has(input);
            if (!cached) {
                downloads += 1;
                saved.set(input, response);
            }
            onProgress({phase: 'download', completed: 1, total: 1, unit: 'shards', url: input, cached});
            return saved.get(input);
        }
    };
    const runtime = {moduleUrl: sourceUrl, wasmPaths: 'https://runtime.example.test/onnx/'};
    const client = fixture.createClient('laya', store, {runtime});
    const progress = [];
    client.subscribe(function observeStoredProgress(state) {
        if (state.progress?.phase === 'download') progress.push(state.progress);
    });
    assert.deepEqual(requests, []);
    assert.deepEqual(urls.created, []);
    assert.equal(fixture.workers.length, 0);
    for (let activation = 0; activation < 2; activation += 1) {
        const loading = client.load();
        const sharedLoad = client.load();
        const worker = fixture.workers[activation];
        const request = await worker.waitForLoad();
        const materialized = urls.created[activation];
        assert.equal(request.payload.runtime.moduleUrl, materialized.url);
        assert.equal(request.payload.runtime.wasmPaths, runtime.wasmPaths);
        assert.equal(request.storedResources, true);
        assert.equal(Object.hasOwn(request.payload, 'store'), false);
        assert.equal(materialized.blob.type, 'text/javascript');
        assert.equal(await materialized.blob.text(), RUNTIME_FIXTURE_SOURCE);
        assert.equal(urls.revoked.length, activation);
        finishFixtureLoad(worker);
        await Promise.all([loading, sharedLoad]);
        assert.equal(client.status().loaded, true);
        if (activation === 0) client.unload();
        else client.dispose();
        assert.equal(worker.terminated, true);
        assert.deepEqual(urls.revoked[activation], {url: materialized.url, terminated: true});
    }
    assert.deepEqual(requests, [sourceUrl, sourceUrl]);
    assert.equal(downloads, 1);
    assert.deepEqual(progress.map(function cacheState(item) { return item.cached; }), [false, true]);
    assert.equal(runtime.moduleUrl, sourceUrl);
    assert.notEqual(urls.created[0].url, urls.created[1].url);
});

test('cancelling runtime preparation joins storage cleanup and never materializes a late result', async function cancelRuntimeEntry(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    for (const result of ['reject', 'resolve']) {
        let started;
        let finish;
        const downloading = new Promise(function observeStart(resolve) { started = resolve; });
        const cleanup = new Promise(function delayCleanup(resolve) { finish = resolve; });
        let storeSignal;
        const store = {
            async fetchResource(input, {signal}) {
                storeSignal = signal;
                started();
                await cleanup;
                if (result === 'reject') throw signal.reason;
                return storedRuntimeResponse();
            }
        };
        const client = fixture.createClient('laya', store);
        const controller = new AbortController();
        let settled = false;
        const outcome = client.load({signal: controller.signal}).then(
            function unexpectedLoad() { assert.fail('Cancelled runtime preparation cannot load.'); },
            function cancelledLoad(error) { settled = true; return error; }
        );
        const worker = fixture.workers.at(-1);
        await downloading;
        const reason = new Error(`Cancel stored runtime and ${result} after cleanup.`);
        controller.abort(reason);
        assert.equal(client.status().state, 'unloaded');
        assert.equal(worker.terminated, true);
        assert.equal(storeSignal.reason, reason);
        await Promise.resolve();
        assert.equal(settled, false);
        finish();
        assert.equal(await outcome, reason);
        assert.deepEqual(worker.messages, []);
        assert.deepEqual(urls.created, []);
    }
});

test('runtime progress can unload reentrantly while cleanup remains owned', async function reentrantRuntimeUnload(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    let finish;
    const cleanup = new Promise(function delayCleanup(resolve) { finish = resolve; });
    let unloading;
    const cancelled = new Promise(function observeUnload(resolve) { unloading = resolve; });
    const store = {
        async fetchResource(input, {signal, onProgress}) {
            onProgress({phase: 'download', completed: 1, total: null, unit: 'shards', url: input});
            assert.equal(signal.aborted, true);
            await cleanup;
            return storedRuntimeResponse();
        }
    };
    const client = fixture.createClient('laya', store);
    client.subscribe(function unloadFromProgress(state) {
        if (state.progress?.phase !== 'download') return;
        client.unload();
        unloading();
    });
    let settled = false;
    const outcome = client.load().catch(function recordCancellation(error) { settled = true; return error; });
    await cancelled;
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(fixture.workers[0].terminated, true);
    finish();
    assert.equal((await outcome).name, 'AbortError');
    assert.deepEqual(urls.created, []);
});

test('runtime transport and Worker failures revoke the module URL after termination', async function failedRuntimeActivation(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    for (const failure of ['post', 'worker']) {
        const store = {async fetchResource() { return storedRuntimeResponse(); }};
        const client = fixture.createClient('laya', store);
        const reason = new Error(`Complete ${failure} failure: 雪\nsecond line`);
        const loading = client.load();
        const rejected = assert.rejects(loading, function originalFailure(error) { return error === reason; });
        const worker = fixture.workers.at(-1);
        if (failure === 'post') {
            worker.postMessage = function failRuntimeDispatch() { throw reason; };
        } else {
            await worker.waitForLoad();
            const event = new Event('error');
            Object.defineProperty(event, 'error', {value: reason});
            worker.dispatchEvent(event);
        }
        await rejected;
        assert.equal(client.status().state, 'error');
        assert.equal(client.status().error, reason);
        assert.equal(worker.terminated, true);
        assert.deepEqual(urls.revoked.at(-1), {url: urls.created.at(-1).url, terminated: true});
    }
    assert.equal(urls.created.length, 2);
    assert.equal(urls.revoked.length, 2);
});

test('runtime HTTP failures retain the complete stored response without importing it', async function failedRuntimeResponse(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    const response = {...storedRuntimeResponse(), status: 404, statusText: 'Not Found',
        file: new Blob(['Complete runtime error: 雪\nsecond line'])};
    const store = {async fetchResource() { return response; }};
    const client = fixture.createClient('laya', store);
    await assert.rejects(client.load(), function completeRuntimeFailure(error) {
        return error.code === 'ARCANE_DECISION_RUNTIME_DOWNLOAD_FAILED' && error.response === response;
    });
    assert.equal(await client.status().error.response.file.text(), 'Complete runtime error: 雪\nsecond line');
    assert.equal(fixture.workers[0].terminated, true);
    assert.deepEqual(fixture.workers[0].messages, []);
    assert.deepEqual(urls.created, []);
});

test('runtime cancellation preserves a genuine storage cleanup failure', async function failedRuntimeCleanup(context) {
    const fixture = createWorkerFixture(context);
    let started;
    let finish;
    const downloading = new Promise(function observeStart(resolve) { started = resolve; });
    const cleanup = new Promise(function delayCleanup(resolve) { finish = resolve; });
    const failure = new Error('Complete runtime writer cleanup failure.');
    const store = {
        async fetchResource() {
            started();
            await cleanup;
            throw failure;
        }
    };
    const client = fixture.createClient('laya', store);
    const controller = new AbortController();
    const reason = new Error('Cancel runtime activation.');
    const loading = client.load({signal: controller.signal});
    const rejected = assert.rejects(loading, function joinedFailures(error) {
        return error instanceof AggregateError && error.errors[0] === reason && error.errors[1] === failure;
    });
    await downloading;
    controller.abort(reason);
    finish();
    await rejected;
    assert.equal(client.status().error.errors[1], failure);
    assert.equal(fixture.workers[0].terminated, true);
});

test('without a store the selected runtime URL keeps direct Worker loading', async function directRuntimeEntry(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    const runtime = {moduleUrl: 'https://runtime.example.test/custom-transformers.js'};
    const client = fixture.createClient('laya', null, {runtime});
    assert.equal(fixture.workers.length, 0);
    const loading = client.load();
    const worker = fixture.workers[0];
    assert.equal(worker.messages.length, 1);
    assert.equal(worker.messages[0].payload.runtime.moduleUrl, runtime.moduleUrl);
    assert.equal(worker.messages[0].storedResources, false);
    finishFixtureLoad(worker);
    await loading;
    client.dispose();
    assert.deepEqual(urls.created, []);
    assert.deepEqual(urls.revoked, []);
});

test('local executable mode keeps model storage without preparing an executable Blob', async function localRuntimeEntry(context) {
    const fixture = createWorkerFixture(context);
    const urls = createRuntimeUrlFixture(context, fixture.workers);
    const calls = [];
    const store = {
        async fetchResource(input) {
            calls.push(input);
            return storedRuntimeResponse();
        }
    };
    const client = fixture.createClient('laya', store, {runtime: {local: true}});
    const loading = client.load();
    const worker = fixture.workers[0];
    const runtime = worker.messages[0].payload.runtime;
    const distribution = new URL('../browser-runtime/ai/decisions-runtime/', import.meta.url);
    assert.equal(runtime.moduleUrl, new URL('transformers.min.js', distribution).href);
    assert.deepEqual(runtime.wasmPaths, {
        mjs: new URL('ort-wasm-simd-threaded.asyncify.mjs', distribution).href,
        wasm: new URL('ort-wasm-simd-threaded.asyncify.wasm', distribution).href
    });
    assert.equal(worker.messages[0].storedResources, true);
    assert.equal(worker.messages[0].payload.dtype, 'fp16');
    assert.deepEqual(calls, []);
    finishFixtureLoad(worker);
    await loading;
    await client.dispose();
    assert.deepEqual(urls.created, []);
    assert.deepEqual(urls.revoked, []);

    const explicit = {
        local: true,
        moduleUrl: new URL('custom-transformers.js', distribution).href,
        wasmPaths: {
            mjs: new URL('custom-ort.mjs', distribution).href,
            wasm: new URL('custom-ort.wasm', distribution).href
        }
    };
    const julia = fixture.createClient('julia', null, {runtime: explicit});
    const juliaLoading = julia.load();
    const juliaWorker = fixture.workers[1];
    assert.deepEqual(juliaWorker.messages[0].payload.runtime, explicit);
    assert.equal(juliaWorker.messages[0].payload.dtype, 'fp32');
    assert.equal(juliaWorker.messages[0].storedResources, false);
    finishFixtureLoad(juliaWorker);
    await juliaLoading;
    assert.throws(function remoteLocalEntry() {
        fixture.createClient('laya', store, {runtime: {local: true, moduleUrl: 'https://runtime.example.test/remote.js'}});
    }, /local deployment/u);
});

test('local decision runtime disables executable Blob preparation only for the selected mode', async function localRuntimeEnvironment() {
    const moduleUrl = `data:text/javascript,${encodeURIComponent(RUNTIME_FIXTURE_SOURCE)}#local-executables`;
    const namespace = await import(moduleUrl);
    const wasmPaths = {mjs: 'https://extension.example.test/ort.mjs', wasm: 'https://extension.example.test/ort.wasm'};
    await loadDecisionRuntime(
        {family: 'julia', model: 'fixture/julia', device: 'webgpu', dtype: 'fp32', runtime: {local: true, moduleUrl, wasmPaths}},
        function observeProgress() {}
    );
    assert.equal(namespace.env.useWasmCache, false);
    assert.equal(namespace.env.backends.onnx.wasm.proxy, false);
    assert.equal(namespace.env.backends.onnx.wasm.numThreads, 1);
    assert.equal(namespace.env.backends.onnx.wasm.wasmPaths, wasmPaths);
    assert.deepEqual(namespace.fixture.loads[0].options, {revision: 'main'});
    assert.equal(namespace.fixture.loads[1].options.device, 'webgpu');
    assert.equal(namespace.fixture.loads[1].options.dtype, 'fp32');
    assert.deepEqual(namespace.fixture.loads[1].options.session_options.externalData, [
        {path: 'model.onnx.data', data: 'model.onnx.data'}
    ]);
});

test('the actual decision Worker routes only selected local executables outside model storage', async function localWorkerRouting() {
    const descriptors = new Map();
    for (const name of ['fetch', 'location', 'addEventListener', 'postMessage']) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    }
    const nativeCalls = [];
    const storedCalls = [];
    const replies = [];
    let handler;
    const moduleUrl = `data:text/javascript,${encodeURIComponent(RUNTIME_FIXTURE_SOURCE)}#local-worker-routing`;
    const wasmPaths = {mjs: 'https://extension.example.test/ort.mjs', wasm: 'https://extension.example.test/ort.wasm'};
    try {
        globalThis.fetch = async function nativeExecutable(input) {
            nativeCalls.push(input);
            return new Response('complete local executable fixture');
        };
        Object.defineProperty(globalThis, 'location', {configurable: true, value: {href: 'https://extension.example.test/decision-worker.mjs'}});
        globalThis.addEventListener = function captureWorkerHandler(type, listener) {
            assert.equal(type, 'message');
            handler = listener;
        };
        globalThis.postMessage = function serveStoredResource(message) {
            if (!message.arcaneModelResource) {
                replies.push(message);
                return;
            }
            assert.equal(message.op, 'fetch');
            storedCalls.push(message.request.url);
            void handler({data: {arcaneModelResource: true, resourceId: message.resourceId, op: 'result', result: {
                file: new Blob(['complete model configuration: 雪\n']),
                status: 200, statusText: 'OK', headers: [['content-type', 'application/json']],
                url: message.request.url, redirected: false
            }}});
        };
        await import('../browser-runtime/ai/decision-worker.mjs?local-routing-fixture');
        await handler({data: {id: 1, op: 'load', storedResources: true, payload: {
            family: 'laya', model: 'fixture/laya', runtime: {local: true, moduleUrl, wasmPaths}
        }}});
        assert.deepEqual(replies.at(-1), {id: 1, result: {loaded: true}});
        const namespace = await import(moduleUrl);
        const executable = await namespace.env.fetch(wasmPaths.wasm);
        assert.equal(await executable.text(), 'complete local executable fixture');
        const modelUrl = 'https://models.example.test/dragon/config.json';
        const model = await namespace.env.fetch(modelUrl);
        assert.equal(await model.text(), 'complete model configuration: 雪\n');
        assert.equal(model.url, modelUrl);
        const sameDeploymentModel = 'https://extension.example.test/models/config.json';
        await namespace.env.fetch(sameDeploymentModel);
        assert.deepEqual(nativeCalls, [wasmPaths.wasm]);
        assert.deepEqual(storedCalls, [modelUrl, sameDeploymentModel]);
    } finally {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});

for (const local of [false, true]) {
    test(`decision resource store receives cancellation with local executables ${local}`, async function decisionStore(context) {
        const fixture = createWorkerFixture(context);
        let aborted;
        let finish;
        let started;
        const downloading = new Promise(function observeDownload(resolve) { started = resolve; });
        const cancellation = new Promise(function observeAbort(resolve) { aborted = resolve; });
        const cleanup = new Promise(function delayCleanup(resolve) { finish = resolve; });
        const store = {
            async fetchResource(input, {signal}) {
                if (input === 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js') {
                    return storedRuntimeResponse();
                }
                assert.equal(input, 'https://models.example.test/dragon/model.onnx_data');
                signal.addEventListener('abort', function resourceAborted() { aborted(); }, {once: true});
                started();
                await cancellation;
                await cleanup;
                throw signal.reason;
            }
        };
        const client = fixture.createClient('laya', store, {runtime: {local}});
        assert.equal(fixture.workers.length, 0);
        const loading = client.load();
        const failed = assert.rejects(loading, /unloaded/u);
        const worker = fixture.workers[0];
        await worker.waitForLoad();
        assert.equal(worker.messages[0].storedResources, true);
        assert.equal(Object.hasOwn(worker.messages[0].payload, 'store'), false);
        worker.reply({arcaneModelResource: true, resourceId: 1, op: 'fetch',
            request: {url: 'https://models.example.test/dragon/model.onnx_data', options: {}}});
        await downloading;
        client.unload();
        await cancellation;
        assert.equal(worker.terminated, true);
        finish();
        await failed;
    });
}

test('decision stored mode selects env.fetch and disables competing model caches', async function decisionStoredRuntime() {
    const moduleUrl = `data:text/javascript,${encodeURIComponent(RUNTIME_FIXTURE_SOURCE)}#stored-resources`;
    const namespace = await import(moduleUrl);
    const progress = [];
    const calls = [];
    await loadDecisionRuntime(
        {family: 'laya', model: 'fixture/laya', runtime: {moduleUrl}},
        function recordProgress(value) { progress.push(value); },
        async function fetchResource(input, options) {
            calls.push(input);
            options.onProgress({phase: 'download', completed: 1, total: 1, unit: 'shards'});
            return new Response('complete fixture configuration');
        }
    );
    assert.equal(namespace.env.useBrowserCache, false);
    assert.equal(namespace.env.useCustomCache, false);
    assert.equal(namespace.env.useFSCache, false);
    assert.equal(namespace.env.useWasmCache, undefined);
    assert.equal(namespace.env.backends.onnx.wasm.numThreads, undefined);
    const response = await namespace.env.fetch('https://models.example.test/dragon/config.json');
    assert.deepEqual(calls, ['https://models.example.test/dragon/config.json']);
    assert.equal(await response.text(), 'complete fixture configuration');
    assert.deepEqual(progress.at(-1), {phase: 'download', completed: 1, total: 1, unit: 'shards'});
});

test(
    'client is lazy, shares activation and exposes complete evaluation and terminal lifecycle',
    async function clientLifecycle(context) {
        const fixture = createWorkerFixture(context);
        const client = fixture.createClient();
        const states = [];
        const unsubscribe = client.subscribe(
            function recordState(state) { states.push(state); }
        );
        assert.equal(fixture.workers.length, 0);
        assert.equal(states[0].state, 'unloaded');
        assert.equal(client.status().dtype, 'fp16');
        const rows = [{state: '  sea 🐙\n', question: 'Keep  spaces?', options: ['yes', 'no']}];
        const firstLoad = client.load();
        const secondLoad = client.load();
        const evaluation = client.evaluate(rows);
        const worker = fixture.workers[0];
        assert.equal(fixture.workers.length, 1);
        assert.equal(worker.messages.length, 1);
        assert.equal(worker.messages[0].op, 'load');
        assert.equal(worker.messages[0].payload.family, 'laya');
        assert.equal(worker.messages[0].payload.dtype, 'fp16');
        assert.equal(
            worker.messages[0].payload.runtime.moduleUrl,
            'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js'
        );
        assert.match(worker.url.pathname, /\/decision-worker\.mjs$/u);
        assert.deepEqual(
            worker.options,
            {type: 'module', name: 'arcane-decisions'}
        );
        assert.equal(client.status().busy, true);
        assert.equal(client.status().activeRequests, 1);
        worker.reply(
            {id: worker.messages[0].id, progress: {phase: 'loading-model'}}
        );
        assert.equal(states.at(-1).progress.phase, 'loading-model');
        finishFixtureLoad(worker);
        await Promise.all(
            [firstLoad, secondLoad]
        );
        const request = await worker.waitForEvaluation();
        assert.deepEqual(request.payload, rows);
        const result = {decisions: [{row: rows[0], value: 'yes'}], outputs: {extra: {data: [1, 2, 3], dims: [3], type: 'float32'}}};
        worker.reply(
            {id: request.id, result}
        );
        assert.deepEqual(await evaluation, result);
        assert.equal(client.status().loaded, true);
        assert.equal(client.status().busy, false);
        assert.equal(client.status().activeRequests, 0);
        client.unload();
        assert.equal(worker.terminated, true);
        assert.equal(client.status().state, 'unloaded');
        unsubscribe();
        const eventCount = states.length;
        const reloaded = client.load();
        finishFixtureLoad(fixture.workers[1]);
        await reloaded;
        client.dispose();
        assert.equal(fixture.workers[1].terminated, true);
        assert.equal(client.status().state, 'disposed');
        assert.equal(states.length, eventCount);
        await assert.rejects(
            client.load(),
            {code: 'ARCANE_AI_DISPOSED'}
        );
        await assert.rejects(
            client.evaluate(rows),
            {code: 'ARCANE_AI_DISPOSED'}
        );
        assert.equal(client.dispose().state, 'disposed');
    }
);

test(
    'abort cancels the shared Worker while loading or evaluating and ignores stale replies',
    async function cancellationAcrossActivation(context) {
        const fixture = createWorkerFixture(context);
        const preAborted = new AbortController();
        preAborted.abort(new Error('Cancelled before use.'));
        const untouched = fixture.createClient();
        await assert.rejects(
            untouched.load(
                {signal: preAborted.signal}
            ),
            preAborted.signal.reason
        );
        assert.equal(fixture.workers.length, 0);
        for (const phase of ['loading', 'evaluating']) {
            const client = fixture.createClient();
            const controller = new AbortController();
            const rows = [{state: 'x', question: 'Continue?', options: ['yes', 'no']}];
            const first = client.evaluate(
                rows,
                {signal: controller.signal}
            );
            const second = client.evaluate(rows);
            const outcomes = Promise.allSettled(
                [first, second]
            );
            const worker = fixture.workers.at(-1);
            const staleListener = worker.messageListeners[0];
            if (phase === 'evaluating') {
                finishFixtureLoad(worker);
                await worker.waitForEvaluation(2);
            }
            const reason = new Error(`Fixture cancellation during ${phase}.`);
            controller.abort(reason);
            for (const outcome of await outcomes) {
                assert.equal(outcome.status, 'rejected');
                assert.equal(outcome.reason, reason);
            }
            assert.equal(worker.terminated, true);
            assert.equal(client.status().state, 'unloaded');
            assert.equal(client.status().activeRequests, 0);
            const replacement = client.load();
            const nextWorker = fixture.workers.at(-1);
            assert.notEqual(nextWorker, worker);
            staleListener(
                {data: {id: worker.messages[0].id, result: {loaded: true}}}
            );
            assert.equal(client.status().state, 'loading');
            finishFixtureLoad(nextWorker);
            await replacement;
            assert.equal(client.status().loaded, true);
            client.dispose();
        }
    }
);

test(
    'backend failure rejects all active calls, retains its error and requires a fresh Worker',
    async function failedSessionReplacement(context) {
        const fixture = createWorkerFixture(context);
        const client = fixture.createClient('julia');
        const rows = [{state: 'x', question: 'Continue?', options: ['yes', 'no']}];
        const first = client.evaluate(rows);
        const second = client.evaluate(rows);
        const outcomes = Promise.allSettled(
            [first, second]
        );
        const worker = fixture.workers[0];
        assert.equal(worker.messages[0].payload.dtype, 'fp32');
        finishFixtureLoad(worker);
        const request = await worker.waitForEvaluation(2);
        worker.reply(
            {
                id: request.id,
                error: {
                    name: 'Error',
                    message: 'Complete synthetic backend failure: 雪\nsecond line',
                    code: 'FIXTURE_BACKEND_FAILURE',
                    stack: 'complete fixture stack',
                    cause: {name: 'TypeError', message: 'synthetic cause', detail: [1, 2, 3]}
                }
            }
        );
        const settled = await outcomes;
        assert.equal(settled[0].status, 'rejected');
        assert.equal(settled[1].status, 'rejected');
        assert.equal(settled[0].reason, settled[1].reason);
        assert.equal(settled[0].reason.code, 'FIXTURE_BACKEND_FAILURE');
        assert.equal(settled[0].reason.message, 'Complete synthetic backend failure: 雪\nsecond line');
        assert.equal(settled[0].reason.stack, 'complete fixture stack');
        assert.equal(settled[0].reason.cause.name, 'TypeError');
        assert.deepEqual(
            settled[0].reason.cause.detail,
            [1, 2, 3]
        );
        assert.equal(client.status().error, settled[0].reason);
        assert.equal(client.status().state, 'error');
        assert.equal(client.status().loaded, false);
        assert.equal(worker.terminated, true);
        const recovered = client.evaluate(rows);
        const nextWorker = fixture.workers[1];
        assert.equal(client.status().state, 'loading');
        assert.equal(client.status().error, null);
        worker.messageListeners[0](
            {data: {id: request.id, result: {decisions: [{value: 'stale'}]}}}
        );
        assert.equal(client.status().state, 'loading');
        finishFixtureLoad(nextWorker);
        const nextRequest = await nextWorker.waitForEvaluation();
        const result = {decisions: [{value: 'fresh'}], outputs: {}};
        nextWorker.reply(
            {id: nextRequest.id, result}
        );
        assert.deepEqual(await recovered, result);
        assert.equal(client.status().state, 'ready');
    }
);
