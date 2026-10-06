import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createSpeechService} from '../src/core/services/speech.mjs';

test('speech service forwards actual Core request correlation outside the complete payload', async function speechCorrelation() {
    const payload = {audioBase64: 'YWJj', model: 'whisper-small', complete: '  all\ncontent  '};
    const result = {text: '  Complete transcript\n  '};
    const state = {providerId: 'whisper.cpp', modelId: 'whisper-small', state: 'ready', loaded: true, busy: false};
    let received;
    const engine = {
        current() { return state; },
        subscribe(listener) { listener(state); return function unsubscribe() {}; },
        async load() {},
        async close() {},
        async transcribe(request, options) {
            received = {request, options};
            return result;
        }
    };
    const service = createSpeechService({stt: engine});
    const controller = new AbortController();
    try {
        service.start({emit() {}});
        assert.equal(await service.methods['speech.transcribe'](payload, {
            requestId: 'actual-core-request', signal: controller.signal
        }), result);
        assert.equal(received.request, payload);
        assert.equal(received.options.requestId, 'actual-core-request');
        assert.equal(Object.hasOwn(payload, 'requestId'), false);
        controller.abort();
        assert.equal(received.options.signal.aborted, true);
    } finally {
        await service.dispose();
    }
});
