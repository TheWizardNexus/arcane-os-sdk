import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import { createCompleteKokoroSynthesis } from '../browser-runtime/ai/kokoro-complete-input.mjs';
import { createSpeechWorkerRuntime, SPEECH_WORKER_PROTOCOL } from '../browser-runtime/ai/speech-worker-runtime.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function createDeferred(resolvePromise) { resolve = resolvePromise; });
    return { promise, resolve };
}

function contentIds(text) {
    return Array.from(text, function encodeCharacter(character) {
        return character === '$' ? 0n : BigInt(character.codePointAt(0));
    });
}

// Synthetic public-class contracts: no upstream dependency, model or runtime is
// loaded. Callable construction mirrors the published tokenizer class boundary.
function createKokoroContract({ prepareTokenizer, infer, dispose } = {}) {
    const trace = {
        modelLoads: [],
        tokenizerLoads: [],
        tokenizations: [],
        preparations: [],
        instances: [],
        inferences: [],
        outputs: [],
        disposals: 0,
    };
    class Tensor {
        constructor(type, data, dims) {
            this.type = type;
            this.data = data;
            this.dims = dims;
        }
    }
    class RawAudio {
        constructor(audio, samplingRate) {
            this.audio = audio;
            this.sampling_rate = samplingRate;
        }
    }
    class Tokenizer {
        constructor() {
            function callableTokenizer(...args) { return callableTokenizer._call(...args); }
            Object.setPrototypeOf(callableTokenizer, new.target.prototype);
            callableTokenizer.model_max_length = 512;
            callableTokenizer.pad_token_id = 0;
            return callableTokenizer;
        }

        static async from_pretrained(repository, options = {}) {
            trace.tokenizerLoads.push({ repository, options, Constructor: this });
            await prepareTokenizer?.();
            return new this();
        }

        _call(text, options = {}) {
            trace.tokenizations.push({ tokenizer: this, text, options });
            let ids = contentIds(text);
            if (options.add_special_tokens !== false) ids = [0n, ...ids, 0n];
            if (options.truncation) ids = ids.slice(0, this.model_max_length);
            return {
                input_ids: options.return_tensor === false
                    ? ids.map(function numberId(id) { return Number(id); })
                    : new Tensor('int64', BigInt64Array.from(ids), [1, ids.length]),
            };
        }
    }
    async function model(inputIds, options) {
        const record = { inputIds, options };
        trace.inferences.push(record);
        await infer?.(record, trace.inferences.length);
        const audio = Float32Array.from(inputIds.data.subarray(1, inputIds.data.length - 1), Number);
        const output = new RawAudio(audio, 24_000);
        trace.outputs.push(output);
        return output;
    }
    model.dispose = async function disposeModel() {
        trace.disposals += 1;
        await dispose?.();
    };
    class KokoroTTS {
        constructor(selectedModel, tokenizer) {
            this.model = selectedModel;
            this.tokenizer = tokenizer;
            trace.instances.push(this);
        }

        static async from_pretrained(repository, { dtype, device, progress_callback } = {}) {
            trace.modelLoads.push({ repository, dtype, device, progress_callback });
            return new KokoroTTS(model, new Tokenizer());
        }

        async generate(text, { voice = 'af_heart', speed = 1 } = {}) {
            trace.preparations.push({ text, voice, speed });
            await Promise.resolve();
            const { input_ids: inputIds } = this.tokenizer(text, { truncation: true });
            return this.generate_from_ids(inputIds, { voice, speed });
        }

        async generate_from_ids(inputIds, options) {
            return this.model(inputIds, options);
        }
    }
    return { KokoroTTS, Tokenizer, Tensor, RawAudio, model, trace };
}

async function prepareContract(contract, options = {}) {
    const synthesizer = await contract.KokoroTTS.from_pretrained('example/complete-kokoro');
    const synthesize = await createCompleteKokoroSynthesis({
        KokoroTTS: contract.KokoroTTS,
        synthesizer,
        repository: 'example/complete-kokoro',
        ...options,
    });
    return { synthesizer, synthesize };
}

test('complete Kokoro keeps short input, public classes and loaded instance ownership unchanged', async function shortKokoroInput() {
    const contract = createKokoroContract();
    const synthesizer = await contract.KokoroTTS.from_pretrained('example/complete-kokoro');
    const descriptors = Object.getOwnPropertyDescriptors(synthesizer);
    const tokenizerDescriptors = Object.getOwnPropertyDescriptors(synthesizer.tokenizer);
    const tokenizerCall = contract.Tokenizer.prototype._call;
    const generation = contract.KokoroTTS.prototype.generate_from_ids;
    const synthesize = await createCompleteKokoroSynthesis({
        KokoroTTS: contract.KokoroTTS,
        synthesizer,
        repository: 'example/complete-kokoro',
    });
    const text = '  **Moon raccoons** speak. Every original symbol stays!\n';
    const result = await synthesize(text, { voice: 'bf_emma', speed: 0.95 });
    assert.deepEqual(contract.trace.preparations, [{ text, voice: 'bf_emma', speed: 0.95 }]);
    assert.equal(result, contract.trace.outputs[0]);
    assert.ok(result instanceof contract.RawAudio);
    assert.deepEqual([...result.audio], contentIds(text).map(Number));
    assert.equal(contract.trace.inferences.length, 1);
    assert.ok(contract.trace.inferences[0].inputIds instanceof contract.Tensor);
    assert.equal(contract.trace.inferences[0].inputIds.type, 'int64');
    const request = contract.trace.instances.at(-1);
    assert.ok(request instanceof contract.KokoroTTS);
    assert.ok(request.tokenizer instanceof contract.Tokenizer);
    assert.equal(typeof request.tokenizer, 'function');
    assert.equal(request.model, synthesizer.model);
    assert.notEqual(request.tokenizer, synthesizer.tokenizer);
    assert.equal(contract.trace.tokenizerLoads.length, 1);
    assert.equal(Object.hasOwn(contract.trace.tokenizerLoads[0].options, 'revision'), false);
    assert.equal(contract.trace.tokenizations.at(-1).options.truncation, false);
    assert.deepEqual(Object.getOwnPropertyDescriptors(synthesizer), descriptors);
    assert.deepEqual(Object.getOwnPropertyDescriptors(synthesizer.tokenizer), tokenizerDescriptors);
    assert.equal(contract.Tokenizer.prototype._call, tokenizerCall);
    assert.equal(contract.KokoroTTS.prototype.generate_from_ids, generation);
    assert.equal(contract.trace.modelLoads.length, 1);
    assert.equal(contract.trace.disposals, 0);
});

test('complete Kokoro preserves every content token and audio sample across model-capacity segments', async function completeTokenOrder() {
    const contract = createKokoroContract();
    const { synthesize } = await prepareContract(contract);
    const text = `${'a'.repeat(400)}.${'b'.repeat(550)} ${'c'.repeat(400)}$${'d'.repeat(650)}`;
    const result = await synthesize(text, { voice: 'af_heart', speed: 1.2 });
    const observed = contract.trace.inferences.flatMap(function inferenceContent({ inputIds }) {
        assert.ok(inputIds.dims[1] <= 512);
        assert.deepEqual(inputIds.dims, [1, inputIds.data.length]);
        assert.equal(inputIds.data[0], 0n);
        assert.equal(inputIds.data.at(-1), 0n);
        return [...inputIds.data.subarray(1, inputIds.data.length - 1)];
    });
    assert.deepEqual(observed, contentIds(text));
    assert.deepEqual([...result.audio], contentIds(text).map(Number));
    assert.ok(result instanceof contract.RawAudio);
    assert.equal(result.sampling_rate, 24_000);
    assert.equal(contract.trace.inferences[0].inputIds.data.at(-2), BigInt('.'.codePointAt(0)));
    for (const { options } of contract.trace.inferences) assert.deepEqual(options, { voice: 'af_heart', speed: 1.2 });
    assert.equal(contract.trace.modelLoads.length, 1);
    assert.ok(contract.trace.instances.every(function sharesModel(instance) { return instance.model === contract.model; }));
});

test('complete Kokoro prefers an actual space token before an unavoidable capacity split', async function spaceTokenBoundary() {
    const contract = createKokoroContract();
    const { synthesize } = await prepareContract(contract);
    const text = `${'a'.repeat(400)} ${'b'.repeat(700)}`;
    await synthesize(text);
    assert.equal(contract.trace.inferences[0].inputIds.data.at(-2), 32n);
    assert.equal(contract.trace.inferences[1].inputIds.dims[1], 512);
    assert.deepEqual(contract.trace.inferences.flatMap(function allContent({ inputIds }) {
        return [...inputIds.data.subarray(1, inputIds.data.length - 1)];
    }), contentIds(text));
});

test('complete Kokoro accepts the exact short boundary and segments its next token', async function modelTokenBoundary() {
    const contract = createKokoroContract();
    const { synthesize } = await prepareContract(contract);
    await synthesize('a'.repeat(510));
    assert.equal(contract.trace.inferences.length, 1);
    assert.equal(contract.trace.inferences[0].inputIds.dims[1], 512);
    await synthesize('b'.repeat(511));
    assert.deepEqual(contract.trace.inferences.map(function inputLength({ inputIds }) { return inputIds.dims[1]; }), [512, 512, 3]);
});

test('complete Kokoro cancellation prevents preparation or any inference after the active segment', async function cancelledKokoroRequest() {
    const controller = new AbortController();
    const reason = new Error('Complete original cancellation reason');
    const contract = createKokoroContract({
        infer: function cancelAfterFirstInference() { controller.abort(reason); },
    });
    const { synthesize } = await prepareContract(contract);
    await assert.rejects(synthesize('a'.repeat(1100), { signal: controller.signal }), function exactReason(error) { return error === reason; });
    assert.equal(contract.trace.inferences.length, 1);
    const preparations = contract.trace.preparations.length;
    await assert.rejects(synthesize('Already cancelled input', { signal: controller.signal }), function exactReason(error) { return error === reason; });
    assert.equal(contract.trace.preparations.length, preparations);
    assert.equal(contract.trace.disposals, 0);
});

test('complete Kokoro signals remain request-local when another request finishes first', async function independentKokoroSignals(t) {
    const firstStarted = deferred();
    const firstMayFinish = deferred();
    const controller = new AbortController();
    const reason = new Error('Only the first request was cancelled');
    const contract = createKokoroContract({
        infer: async function holdFirstVoice({ options }) {
            if (options.voice !== 'af_heart') return;
            firstStarted.resolve();
            await firstMayFinish.promise;
        },
    });
    t.after(function releaseInference() { firstMayFinish.resolve(); });
    const { synthesize } = await prepareContract(contract);
    const first = synthesize('a'.repeat(1100), { voice: 'af_heart', signal: controller.signal });
    const rejected = assert.rejects(first, function exactReason(error) { return error === reason; });
    await firstStarted.promise;
    const second = await synthesize('The independent second request.', { voice: 'bf_emma' });
    assert.deepEqual([...second.audio], contentIds('The independent second request.').map(Number));
    controller.abort(reason);
    firstMayFinish.resolve();
    await rejected;
    assert.equal(contract.trace.inferences.filter(function firstVoice({ options }) { return options.voice === 'af_heart'; }).length, 1);
    assert.equal(contract.trace.modelLoads.length, 1);
});

test('complete Kokoro preserves inference errors and stops subsequent segments', async function inferenceFailure() {
    const failure = new Error('Complete model failure, including its original cause', { cause: new Error('Actual inference cause') });
    const contract = createKokoroContract({
        infer: function failSecondInference(_record, index) { if (index === 2) throw failure; },
    });
    const { synthesize } = await prepareContract(contract);
    await assert.rejects(synthesize('a'.repeat(1600)), function exactFailure(error) { return error === failure; });
    assert.equal(contract.trace.inferences.length, 2);
    assert.equal(contract.trace.disposals, 0);
});

let nextRuntimeFixture = 0;

function runtimeFixture(t, contract) {
    const key = `__arcaneCompleteKokoroFixture${++nextRuntimeFixture}`;
    globalThis[key] = contract;
    t.after(function removeFixture() { delete globalThis[key]; });
    const source = `export const KokoroTTS = globalThis[${JSON.stringify(key)}].KokoroTTS; export const env = { wasmPaths: undefined };`;
    const configuration = {
        role: 'tts',
        runtime: {
            adapter: 'kokoro-js',
            moduleGraph: 'self-contained',
            entry: 'runtime.mjs',
            files: [{ path: 'runtime.mjs', moduleUrl: `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}` }],
        },
        model: {
            id: 'complete-kokoro',
            repository: 'example/complete-kokoro',
            revision: 'caller-selected-materialization',
            dtype: 'q8',
            outputSampleRate: 24_000,
            defaultVoice: 'af_heart',
            voices: ['af_heart'],
            files: [],
        },
        execution: { device: 'wasm' },
    };
    const runtime = createSpeechWorkerRuntime({
        role: 'tts',
        scope: { fetch: globalThis.fetch, Request },
        send: function observeRuntimeMessage() {},
    });
    function request(id, op, payload) {
        return runtime.handleMessage({ protocol: SPEECH_WORKER_PROTOCOL, id, op, payload });
    }
    return { request, configuration };
}

test('Kokoro worker owns the one model through complete synthesis and repeated unload', async function runtimeModelOwnership(t) {
    const contract = createKokoroContract();
    const { request, configuration } = runtimeFixture(t, contract);
    await request(1, 'load', { configuration });
    try {
        const text = 'a'.repeat(1200);
        const result = await request(2, 'use', { text, voice: 'af_heart', speed: 1 });
        assert.deepEqual([...result.audio], contentIds(text).map(Number));
        assert.equal(result.sampleRate, 24_000);
        assert.equal(contract.trace.modelLoads.length, 1);
        assert.equal(Object.hasOwn(contract.trace.tokenizerLoads[0].options, 'revision'), false);
    } finally {
        await request(3, 'unload');
        await request(4, 'unload');
    }
    assert.equal(contract.trace.disposals, 1);
});

test('Kokoro tokenizer reconstruction failure releases its already-loaded model', async function tokenizerFailureCleanup(t) {
    const failure = new Error('Complete tokenizer reconstruction error');
    const contract = createKokoroContract({
        prepareTokenizer: function rejectTokenizer() { throw failure; },
    });
    const { request, configuration } = runtimeFixture(t, contract);
    await assert.rejects(request(1, 'load', { configuration }), function originalFailure(error) { return error.cause === failure; });
    await request(2, 'unload');
    assert.equal(contract.trace.modelLoads.length, 1);
    assert.equal(contract.trace.disposals, 1);
    assert.equal(contract.trace.inferences.length, 0);
});

test('Kokoro cancellation during tokenizer reconstruction releases the model before load settles', async function tokenizerCancellationCleanup(t) {
    const started = deferred();
    const finish = deferred();
    const contract = createKokoroContract({
        prepareTokenizer: async function heldTokenizer() { started.resolve(); await finish.promise; },
    });
    t.after(function releaseTokenizer() { finish.resolve(); });
    const { request, configuration } = runtimeFixture(t, contract);
    const load = request(1, 'load', { configuration });
    const rejected = assert.rejects(load, function cancelled(error) { return error.code === 'ARCANE_AI_REQUEST_ABORTED'; });
    await started.promise;
    await request(2, 'cancel', { targetId: 1 });
    assert.equal(contract.trace.disposals, 0);
    finish.resolve();
    await rejected;
    assert.equal(contract.trace.disposals, 1);
    await request(3, 'unload');
    assert.equal(contract.trace.disposals, 1);
});

test('Kokoro reconstruction and cleanup failures remain complete together', async function tokenizerAndCleanupFailure(t) {
    const failure = new Error('Original tokenizer failure');
    const cleanupFailure = new Error('Original model cleanup failure');
    const contract = createKokoroContract({
        prepareTokenizer: function rejectTokenizer() { throw failure; },
        dispose: function rejectCleanup() { throw cleanupFailure; },
    });
    const { request, configuration } = runtimeFixture(t, contract);
    await assert.rejects(request(1, 'load', { configuration }), function completeFailures(error) {
        assert.ok(error.cause instanceof AggregateError);
        assert.deepEqual(error.cause.errors, [failure, cleanupFailure]);
        assert.equal(error.cause.cause, failure);
        return true;
    });
    assert.equal(contract.trace.disposals, 1);
});
