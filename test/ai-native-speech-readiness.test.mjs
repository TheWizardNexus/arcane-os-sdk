import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function retainSettlement(accept, fail) {
        resolve = accept;
        reject = fail;
    });
    return {promise, resolve, reject};
}

test('AI native speech follows independent authoritative role readiness', async function nativeSpeechReadiness() {
    const previousGlobals = new Map(
        ['window', 'document', 'localStorage', 'Arcane'].map(function retainGlobal(key) {
            return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
        })
    );
    const registrationKey = Symbol.for('arcane.ai.user-ready-registration');
    const previousRegistration = globalThis[registrationKey];
    const values = new Map();
    const localStorage = {
        getItem(key) { return values.get(String(key)) ?? null; },
        setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); }
    };
    const documentObject = {
        documentElement: {dataset: {arcaneAppId: 'native-speech-readiness'}},
        querySelector() { return null; }
    };
    const windowTarget = new EventTarget();
    windowTarget.dbopfs = {ready: false, get() {}};
    windowTarget.user = {ready: false};
    windowTarget.document = documentObject;
    windowTarget.localStorage = localStorage;
    globalThis.window = windowTarget;
    globalThis.document = documentObject;
    globalThis.localStorage = localStorage;

    const listeners = new Set();
    let statusRequested;
    let statusResponse;
    let transcriptionRequested;
    let transcriptionSignal;
    let transcriptionPayload;
    const events = {
        on(name, listener) {
            assert.equal(name, 'speech.state');
            listeners.add(listener);
            return function unsubscribeSpeech() { listeners.delete(listener); };
        }
    };
    globalThis.Arcane = {
        events,
        speech: {
            status() {
                if (globalThis.Arcane.events) assert.ok(listeners.size > 0);
                statusRequested.resolve();
                return statusResponse;
            },
            synthesize() { throw new Error('This fixture never requests synthesis.'); },
            transcribe(payload, {signal}) {
                transcriptionPayload = payload;
                transcriptionSignal = signal;
                transcriptionRequested.resolve();
                return new Promise(function awaitNativeCancellation(resolve, reject) {
                    signal.addEventListener('abort', function cancelNativeTranscription() {
                        const error = new Error('The native request was cancelled.');
                        error.name = 'AbortError';
                        error.code = 'ARCANE_REQUEST_ABORTED';
                        reject(error);
                    }, {once: true});
                });
            }
        }
    };
    function roleState(role, state, modelId = role === 'stt' ? 'whisper-small' : 'kokoro') {
        const loaded = state === 'ready' || state === 'running';
        return {
            providerId: role === 'stt' ? 'whisper.cpp' : 'kokoro-onnx',
            modelId, state, loaded, available: loaded, busy: state === 'running'
        };
    }
    function snapshot(stt, tts) {
        return {status: 'ok', ready: false, roles: {stt, tts}};
    }
    function publish(value) {
        for (const listener of [...listeners]) listener(value);
    }
    function nextStatus(value) {
        statusRequested = deferred();
        statusResponse = Promise.resolve(value);
    }

    let ai;
    try {
        const {default: AI} = await import('arcane-os/ai');
        ai = new AI('TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH', 'TWIN');
        const loading = snapshot(roleState('stt', 'loading'), roleState('tts', 'loading'));
        const sttReady = snapshot(roleState('stt', 'ready'), roleState('tts', 'loading'));
        const bothReady = snapshot(roleState('stt', 'ready'), roleState('tts', 'ready'));

        const stale = deferred();
        nextStatus(stale.promise);
        const loadingSTT = ai.providerRuntime.load('stt');
        await statusRequested.promise;
        assert.equal(ai.providerRuntime.status('stt').loaded, false);
        assert.equal(ai.providerRuntime.status('stt').state, 'loading');
        publish(sttReady);
        await loadingSTT;
        assert.equal(ai.providerRuntime.status('stt').loaded, true);
        stale.resolve(loading);
        await stale.promise;
        assert.equal(ai.providerRuntime.status('stt').loaded, true);

        nextStatus(sttReady);
        const unmuting = ai.setSpeechMuted(false);
        await statusRequested.promise;
        assert.equal(ai.muted, true);
        assert.equal(ai.providerRuntime.status('tts').loaded, false);
        publish(bothReady);
        assert.equal(await unmuting, true);
        assert.equal(ai.muted, false);
        publish(snapshot(roleState('stt', 'running'), roleState('tts', 'ready')));
        assert.equal(ai.providerRuntime.status('stt').state, 'ready');

        const audio = '  Moon raccoons\nkeep every sandwich.  ';
        transcriptionRequested = deferred();
        const transcribing = ai.providerRuntime.transcribe({
            audio: new Blob([audio], {type: 'audio/webm'}),
            mimeType: 'audio/webm', model: 'whisper-small'
        });
        const cancelledTranscription = assert.rejects(transcribing, {code: 'ARCANE_AI_REQUEST_ABORTED'});
        await transcriptionRequested.promise;
        assert.deepEqual(transcriptionPayload, {
            audioBase64: btoa(audio), mimeType: 'audio/webm', model: 'whisper-small'
        });
        publish(snapshot(roleState('stt', 'ready', 'replacement-model'), roleState('tts', 'ready')));
        assert.equal(transcriptionSignal.aborted, true);
        await cancelledTranscription;
        await ai.providerRuntime.unload('stt');
        assert.equal(ai.providerRuntime.status('stt').loaded, false);
        assert.equal(ai.providerRuntime.status('tts').loaded, true);
        assert.equal(listeners.size, 1);

        const pendingStatus = deferred();
        nextStatus(pendingStatus.promise);
        const controller = new AbortController();
        const cancelledLoad = ai.providerRuntime.load('stt', {signal: controller.signal});
        const cancellation = assert.rejects(cancelledLoad, {code: 'ARCANE_AI_REQUEST_ABORTED'});
        await statusRequested.promise;
        controller.abort();
        await cancellation;
        assert.equal(listeners.size, 1);
        pendingStatus.resolve(bothReady);
        await pendingStatus.promise;
        assert.equal(ai.providerRuntime.status('stt').loaded, false);

        nextStatus(snapshot(roleState('stt', 'ready', 'other-model'), roleState('tts', 'ready')));
        await assert.rejects(ai.providerRuntime.load('stt'), {code: 'ARCANE_AI_MODEL_AUTHORITY_REQUIRED'});
        assert.equal(listeners.size, 1);
        await ai.setSpeechMuted(true);
        assert.equal(listeners.size, 0);

        nextStatus(loading);
        const cancelledUnmute = ai.setSpeechMuted(false);
        await statusRequested.promise;
        await ai.setSpeechMuted(true);
        assert.equal(await cancelledUnmute, false);
        assert.equal(ai.muted, true);
        assert.equal(listeners.size, 0);
        nextStatus(bothReady);
        assert.equal(await ai.setSpeechMuted(false), true);
        await ai.setSpeechMuted(true);
        assert.equal(listeners.size, 0);

        delete globalThis.Arcane.events;
        nextStatus({
            status: 'ok', ready: false, sttEngine: 'whisper.cpp', ttsEngine: 'kokoro-onnx',
            transcriptionAvailable: true, synthesisAvailable: false
        });
        await ai.providerRuntime.load('stt');
        assert.equal(ai.providerRuntime.status('stt').loaded, true);
        await ai.providerRuntime.unload('stt');
        nextStatus({
            status: 'ok', ready: false, sttEngine: 'whisper.cpp', ttsEngine: 'kokoro-onnx',
            transcriptionAvailable: false, synthesisAvailable: false
        });
        await assert.rejects(ai.providerRuntime.load('stt'), {code: 'ARCANE_AI_ROLE_NOT_READY'});
        assert.equal(listeners.size, 0);
    } finally {
        try {
            ai?.stopAudio();
            await ai?.providerRuntime.disposeAll();
            assert.equal(listeners.size, 0);
        } finally {
            const registration = globalThis[registrationKey];
            if (registration !== previousRegistration) registration?.dispose();
            for (const [key, descriptor] of previousGlobals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
        }
    }
});
