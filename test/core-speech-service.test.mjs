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

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function retainSettlement(accept, decline) {
        resolve = accept;
        reject = decline;
    });
    return {promise, resolve, reject};
}

test('explicit speech activation preserves selection and leaves the other role independent', async function selectedSpeechActivation() {
    const sttLoading = deferred();
    const sttState = {providerId: 'whisper.cpp', modelId: 'whisper-small', state: 'loading', loaded: false, busy: true};
    let ttsState = {providerId: 'kokoro-onnx', modelId: 'kokoro', state: 'unloaded', loaded: false, busy: false};
    let ttsListener;
    const selections = [];
    const progress = [];
    const loaded = {complete: '  Native activation\n🌙  ', execution: {requestedTarget: null}};
    const audio = {audioBase64: 'Q29tcGxldGU=', contentType: 'audio/ogg; codecs=opus', detail: {complete: true}};
    const input = {model: 'kokoro', input: '  The moon swallowed a trombone.\r\n🎺  ', voice: 'af_heart', responseFormat: 'opus', speed: 1};
    let receivedInput;
    const service = createSpeechService({
        stt: {
            current() { return sttState; },
            subscribe(listener) { listener(sttState); return function stopSTT() {}; },
            load() { return sttLoading.promise; },
            async transcribe() { return {text: 'Complete transcript'}; },
            async close() { sttLoading.resolve(); }
        },
        tts: {
            current() { return ttsState; },
            subscribe(listener) { ttsListener = listener; listener(ttsState); return function stopTTS() { ttsListener = null; }; },
            async load(selection) {
                selections.push(selection);
                ttsState = {...ttsState, state: 'ready', loaded: true};
                ttsListener?.(ttsState);
                return loaded;
            },
            async synthesize(request) { receivedInput = request; return audio; },
            async unload() {
                ttsState = {...ttsState, state: 'unloaded', loaded: false};
                ttsListener?.(ttsState);
                return ttsState;
            },
            async close() { ttsState = {...ttsState, state: 'closed', loaded: false}; }
        }
    });
    const resourcePaths = {
        model: 'onnx/model.onnx', tokenizer: 'tokenizer.json', tokenizerConfig: 'tokenizer_config.json',
        voices: {af_heart: 'voices/af_heart.bin', bm_george: 'voices/bm_george.bin'}
    };
    const parameters = {role: 'tts', modelId: 'kokoro', assetProjectionId: 'prepared-moon', resourcePaths, executionTarget: null};
    try {
        service.start({emit() {}});
        const operation = service.methods['speech.load'](parameters, {
            requestId: 'load-moon',
            emit(event, data) { progress.push({event, data}); }
        });
        assert.deepEqual(progress, [{event: 'speech.progress', data: {
            requestId: 'load-moon', role: 'tts', operation: 'load', status: 'Thinking', progress: {phase: 'accepted'}
        }}]);
        assert.equal(await operation, loaded);
        assert.equal(selections.length, 1, 'The explicit selection supersedes the not-yet-dispatched startup load.');
        assert.equal(selections[0].resourcePaths, resourcePaths);
        assert.equal(selections[0].assetProjectionId, parameters.assetProjectionId);
        assert.equal(selections[0].modelId, 'kokoro');
        assert.equal(selections[0].executionTarget, null);
        assert.equal(Object.hasOwn(selections[0], 'role'), false);
        assert.equal(Object.hasOwn(parameters, 'signal'), false);
        assert.equal(service.current().synthesisAvailable, true);
        assert.equal(service.current().transcriptionAvailable, false);
        assert.equal(service.current().roles.stt.state, 'loading');
        assert.equal(await service.methods['speech.synthesize'](input), audio);
        assert.equal(receivedInput, input);
        await service.methods['speech.load']({role: 'tts', assetProjectionId: 'prepared-moon', resourcePaths});
        assert.equal(Object.hasOwn(selections[1], 'executionTarget'), false);
        assert.equal(await service.methods['speech.unload']({role: 'tts'}), ttsState);
        assert.equal(service.current().synthesisAvailable, false);
        assert.equal(service.current().roles.stt.state, 'loading');
    } finally {
        await service.dispose();
    }
});

test('explicit unload supersedes a pending startup without publishing its stale failure', async function retiredSpeechStartup() {
    const startup = deferred();
    const entered = deferred();
    let state = {providerId: 'kokoro-onnx', modelId: 'kokoro', state: 'loading', loaded: false, busy: true};
    let listener;
    const snapshots = [];
    const service = createSpeechService({tts: {
        current() { return state; },
        subscribe(observe) { listener = observe; observe(state); return function stop() { listener = null; }; },
        load() { entered.resolve(); return startup.promise; },
        async synthesize() {},
        async unload() {
            state = {...state, state: 'unloaded', busy: false};
            listener?.(state);
            startup.reject(new Error('The retired startup failed after explicit unload.'));
            return state;
        },
        async close() { startup.resolve(); }
    }});
    service.subscribe(function observeState(snapshot) { snapshots.push(snapshot); });
    try {
        service.start({emit() {}});
        await entered.promise;
        const result = await service.methods['speech.unload']({role: 'tts'});
        assert.equal(result, state);
        assert.equal(service.current().roles.tts.state, 'unloaded');
        assert.equal(snapshots.some(function failed(snapshot) { return snapshot.roles.tts.state === 'error'; }), false);
    } finally {
        await service.dispose();
    }
});

test('a cancelled activation wait does not become another speech request cancellation', async function independentActivationWait() {
    const entered = deferred();
    const waiting = deferred();
    const notReady = new Error('The selected model is still loading.');
    notReady.code = 'KOKORO_MODEL_NOT_READY';
    const state = {providerId: 'kokoro-onnx', modelId: 'kokoro', state: 'loading', loaded: false, busy: true};
    let stopWaiting;
    const service = createSpeechService({tts: {
        current() { return state; },
        subscribe(listener) { listener(state); return function stop() {}; },
        load({signal}) {
            function cancelled() { waiting.reject(signal.reason); }
            signal.addEventListener('abort', cancelled, {once: true});
            stopWaiting = function removeCancellation() { signal.removeEventListener('abort', cancelled); };
            entered.resolve();
            return waiting.promise.finally(stopWaiting);
        },
        async synthesize() { throw notReady; },
        async close() { stopWaiting?.(); waiting.resolve(); }
    }});
    const controller = new AbortController();
    const reason = new Error('Only this caller stopped waiting.');
    try {
        service.start({emit() {}});
        const loading = service.methods['speech.load']({role: 'tts'}, {signal: controller.signal});
        const cancelled = assert.rejects(loading, function actualCancellation(error) { return error === reason; });
        await entered.promise;
        const inference = service.methods['speech.synthesize']({input: 'The moon is still tuning its trombone.'});
        const unavailable = assert.rejects(inference, function actualReadiness(error) { return error === notReady; });
        controller.abort(reason);
        await Promise.all([cancelled, unavailable]);
        assert.equal(service.current().roles.tts.state, 'loading');
        assert.equal(service.current().roles.tts.error, undefined);
    } finally {
        await service.dispose();
    }
});

test('a selection made during startup replay keeps its complete activation options', async function reentrantSpeechSelection() {
    const selection = {role: 'tts', assetProjectionId: 'prepared-replay-moon', executionTarget: null};
    const loads = [];
    const state = {providerId: 'kokoro-onnx', modelId: 'kokoro', state: 'unloaded', loaded: false, busy: false};
    const service = createSpeechService({tts: {
        current() { return state; },
        subscribe(listener) { listener(state); return function stop() {}; },
        async load(options) { loads.push(options); return state; },
        async synthesize() {},
        async close() {}
    }});
    let loading;
    service.subscribe(function selectWhenStarted(snapshot) {
        if (snapshot.status === 'ok' && !loading) loading = service.methods['speech.load'](selection);
    });
    try {
        service.start({emit() {}});
        await loading;
        assert.equal(loads.length, 1);
        assert.equal(loads[0].assetProjectionId, selection.assetProjectionId);
        assert.equal(loads[0].executionTarget, null);
    } finally {
        await service.dispose();
    }
});

test('cancelled unload and service shutdown retain ownership through engine cleanup', async function speechCleanupSettlement() {
    const draining = deferred();
    const entered = deferred();
    const state = {providerId: 'kokoro-onnx', modelId: 'kokoro', state: 'ready', loaded: true, busy: false};
    let operationSignal;
    let closed = false;
    let settled = false;
    const service = createSpeechService({tts: {
        current() { return state; },
        subscribe(listener) { listener(state); return function stop() {}; },
        async load() {},
        async synthesize() {},
        unload(options) { operationSignal = options.signal; entered.resolve(); return draining.promise; },
        close() { return draining.promise; }
    }});
    const controller = new AbortController();
    const reason = new Error('The caller stopped waiting for the moon.');
    try {
        service.start({emit() {}});
        const operation = service.methods['speech.unload']({role: 'tts'}, {signal: controller.signal});
        const rejected = assert.rejects(operation, function cancelled(error) { return error === reason; });
        operation.then(function resolved() { settled = true; }, function failed() { settled = true; });
        await entered.promise;
        controller.abort(reason);
        assert.equal(operationSignal.aborted, true);
        const closing = service.close().then(function shutdownFinished() { closed = true; });
        await Promise.resolve();
        assert.equal(settled, false);
        assert.equal(closed, false);
        assert.throws(function rejectNewActivation() {
            service.methods['speech.load']({role: 'tts'});
        }, {code: 'CORE_CLOSING'});
        draining.resolve({state: 'unloaded'});
        await rejected;
        await closing;
        assert.equal(closed, true);
    } finally {
        draining.resolve();
        await service.dispose();
    }
});

test('speech activation rejects unavailable operations and preserves complete engine failures', async function speechActivationFailures() {
    const cause = new Error('Complete native cause\nwith every line.');
    const nativeFailure = new AggregateError([cause, {complete: 'second failure'}], 'Activation failed', {cause});
    nativeFailure.execution = {attempts: [{provider: 'dml', error: {complete: 'Full provider failure'}}]};
    const state = {providerId: 'kokoro-onnx', modelId: 'kokoro', state: 'unloaded', loaded: false, busy: false};
    const service = createSpeechService({tts: {
        current() { return state; },
        subscribe(listener) { listener(state); return function stop() {}; },
        async load() { throw nativeFailure; },
        async synthesize() {},
        async close() {}
    }});
    try {
        assert.throws(function missingRole() { service.methods['speech.load']({}); }, {code: 'SPEECH_ROLE_INVALID'});
        assert.throws(function missingEngine() { service.methods['speech.load']({role: 'stt'}); }, {code: 'SPEECH_ENGINE_UNAVAILABLE'});
        assert.throws(function missingUnload() { service.methods['speech.unload']({role: 'tts'}); }, {code: 'SPEECH_OPERATION_UNAVAILABLE'});
        service.start({emit() {}});
        await assert.rejects(service.methods['speech.load']({role: 'tts'}), function completeError(error) {
            assert.equal(error, nativeFailure);
            assert.equal(error.cause, cause);
            assert.equal(error.errors[1].complete, 'second failure');
            assert.deepEqual(error.execution, nativeFailure.execution);
            return true;
        });
    } finally {
        await service.dispose();
    }
});
