import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createDiarization} from '../src/diarization/index.mjs';

function createFixture(onEvent) {
    return createDiarization({
        executable: process.execPath,
        modelPath: fileURLToPath(new URL('./fixtures/diarization/helper.mjs', import.meta.url)),
        onEvent
    });
}

test('diarization preserves all float32 samples and streams complete probability deltas', async function completeAudio() {
    const model = createFixture();
    const frames = [];
    const audio = new Float32Array(6001);
    audio.set([0, -0, 0.25, -0.5, 1]);
    try {
        const result = await model.diarize({
            audio, sampleRate: 16000,
            onProbabilities: function probabilityFrames(frame) { frames.push(frame); }
        });
        assert.deepEqual(result.sampleBits, [...new Uint32Array(audio.buffer)]);
        assert.equal(result.final, true);
        assert.deepEqual(frames.map(function start(frame) { return frame.startFrame; }), [0, 1, 2, 3]);
        assert.deepEqual(frames.flatMap(function probabilities(frame) { return frame.values; }), [
            1, 0, 0, 0, 0, 0, 0, 0,
            1, 0, 0, 0, 0, 0, 0, 0,
            1, 0, 0, 0, 0, 0, 0, 0
        ]);
    } finally {
        await model.close();
    }
    const processResult = await model.completion;
    assert.equal(processResult.stderr, 'Opening synthetic stream\nComplete synthetic helper drain 🧀\n');
});

test('cancelling from a callback closes only its own stream without waiting on itself', async function independentCancellation() {
    const model = createFixture();
    let stream;
    try {
        stream = await model.openStream({
            onUpdate: async function cancelThisStream() { await stream.cancel(); }
        });
        const other = await model.openStream();
        await assert.rejects(stream.push(new Float32Array([0.2])), {code: 'DIARIZATION_CANCELLED'});
        await other.push(new Float32Array([0.4]));
        assert.equal((await other.finish()).final, true);
        assert.equal(model.current().state, 'ready');
    } finally {
        await model.close();
    }
});

test('an abort during finish preserves the model and other callers', async function finishingCancellation() {
    const model = createFixture();
    const controller = new AbortController();
    try {
        const stream = await model.openStream({
            signal: controller.signal,
            onUpdate: function cancelFinishedCallback(result) { if (result.final) controller.abort(); }
        });
        await stream.push(new Float32Array([0.1]));
        await assert.rejects(stream.finish());
        const result = await model.diarize({audio: new Float32Array([0.3])});
        assert.equal(result.final, true);
        assert.equal(model.current().state, 'ready');
    } finally {
        await model.close();
    }
});

test('close drains or rejects concurrent openings before completing', async function openingDrain() {
    let openingStarted;
    const nativeOpening = new Promise(function opened(resolve) { openingStarted = resolve; });
    const model = createFixture(function observeNativeOpening(event) {
        if (event.type === 'process.stderr' && event.message === 'Opening synthetic stream') openingStarted();
    });
    await model.ready;
    const opening = model.openStream();
    await nativeOpening;
    const closing = model.close();
    const [opened] = await Promise.allSettled([opening]);
    await closing;
    if (opened.status === 'fulfilled') assert.equal(opened.value.current().final, true);
    else assert.equal(opened.reason.code, 'DIARIZATION_CLOSING');
    assert.equal(model.current().state, 'closed');
});

test('recursive finish reports its lifecycle error instead of deadlocking', async function recursiveFinish() {
    const model = createFixture();
    let stream;
    try {
        stream = await model.openStream({
            onUpdate: function finishInsideCallback() { return stream.finish(); }
        });
        await assert.rejects(stream.push(new Float32Array([0.1])), {code: 'DIARIZATION_CALLBACK_WAIT'});
        await stream.cancel();
    } finally {
        await model.close();
    }
});
