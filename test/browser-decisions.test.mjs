import assert from 'node:assert/strict';
import {test} from '../src/testing.mjs';
import {createBrowserDecisionModel} from '../browser-runtime/ai/browser-decisions.mjs';
import {encodeDecisionRows, loadDecisionRuntime} from '../browser-runtime/ai/decision-runtime.mjs';

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
        for (const family of ['laya', 'julia']) {
            const moduleUrl = `data:text/javascript,${encodeURIComponent(RUNTIME_FIXTURE_SOURCE)}#${family}`;
            const namespace = await import(moduleUrl);
            const {fixture, Tensor} = namespace;
            const phases = [];
            const configuration = {
                family,
                model: `fixture/${family}`,
                revision: 'fixture-revision',
                device: 'wasm',
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
                ? {revision: 'fixture-revision', device: 'wasm', dtype: 'fp16', use_external_data_format: true}
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
    function createClient(family = 'laya') {
        const client = createBrowserDecisionModel(
            {family, model: `fixture/${family}`}
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
