import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createBrowserSpeechSynthesisProvider} from '../browser-runtime/ai/browser-speech.mjs';

test('AI native speech preserves real completion, cancellation and buffered audio ownership', async function nativeSpeechQueue() {
    const keys = ['window', 'document', 'localStorage', 'speechSynthesis', 'SpeechSynthesisUtterance', 'AudioContext'];
    const previous = new Map(keys.map(function saveGlobal(key) {
        return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
    }));
    const registrationKey = Symbol.for('arcane.ai.user-ready-registration');
    const priorRegistration = globalThis[registrationKey];
    const storage = new Map();
    const localStorage = {
        getItem(key) {return storage.get(String(key)) ?? null;},
        setItem(key, value) {storage.set(String(key), String(value));},
        removeItem(key) {storage.delete(String(key));}
    };
    const document = {
        documentElement: {dataset: {arcaneAppId: 'native-speech-contract'}},
        querySelector() {return null;}
    };
    const window = new EventTarget();
    window.dbopfs = {ready: false, get() {}};
    window.user = {ready: false};
    window.document = document;
    window.localStorage = localStorage;
    const utterances = [];
    const arrivals = new Map();
    const synthesis = new EventTarget();
    synthesis.getVoices = function getVoices() {
        return [
            {voiceURI: 'lunar-squid', name: 'Lunar Squid', lang: 'en-GB', default: true, localService: true},
            {voiceURI: 'cosmic-gecko', name: 'Cosmic Gecko', lang: 'fr-FR', default: false, localService: false}
        ];
    };
    synthesis.speak = function speak(utterance) {
        const index = utterances.push(utterance) - 1;
        utterance.onstart?.({});
        arrivals.get(index)?.(utterance);
        arrivals.delete(index);
    };
    synthesis.cancel = function cancel() {};
    synthesis.pause = function pause() {};
    synthesis.resume = function resume() {};
    function nextUtterance(index) {
        return utterances[index] ? Promise.resolve(utterances[index]) : new Promise(function waitForUtterance(resolve) {
            arrivals.set(index, resolve);
        });
    }
    globalThis.window = window;
    globalThis.document = document;
    globalThis.localStorage = localStorage;
    globalThis.speechSynthesis = synthesis;
    globalThis.SpeechSynthesisUtterance = class ContractUtterance {
        constructor(text) {this.text = text;}
    };
    globalThis.AudioContext = class UnexpectedAudioContext {
        constructor() {throw new Error('Native playback must not allocate Web Audio.');}
    };
    let ai;
    try {
        const {default: AI} = await import('arcane-os/ai');
        ai = new AI('TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH', 'TWIN');
        const provider = createBrowserSpeechSynthesisProvider({
            id: 'native-speech-fixture',
            model: {id: 'browser-voices', defaultVoice: 'lunar-squid'}
        });
        await ai.configureSpeechProvider('tts', provider);
        await ai.setSpeechMuted(false);
        await assert.rejects(ai.fetchTTS({input: 'Export the moon.'}), {
            code: 'ARCANE_AI_TTS_AUDIO_EXPORT_UNAVAILABLE'
        });

        const controller = new AbortController();
        const prepared = await ai.prepareTTSPlayback({input: '  Exact **visible** text.\n '}, controller.signal);
        assert.equal(prepared.input, '  Exact **visible** text.\n ');
        assert.equal(utterances.length, 0);
        controller.abort('Retire the prepared operation.');
        assert.equal(await prepared.play().finished, false);
        assert.equal(utterances.length, 0);

        const played = ai.streamTTS('First squid. Second squid.', true, {waitForPlayback: true});
        const first = await nextUtterance(0);
        assert.equal(first.text, 'First squid. ');
        assert.equal(first.voice.voiceURI, 'lunar-squid');
        assert.equal(first.lang, 'en-GB');
        assert.equal(utterances.length, 1);
        first.onend();
        const second = await nextUtterance(1);
        assert.equal(second.text, 'Second squid.');
        second.onend();
        assert.equal(await played, true);
        assert.equal(ai.speechJobs.length, 0);

        const cancelled = ai.streamTTS('A temporary squid.', true, {waitForPlayback: true});
        await nextUtterance(2);
        ai.stopAudio();
        assert.equal(await cancelled, false);
        assert.equal(ai.isSpeaking, false);

        const context = Object.assign(new EventTarget(), {
            state: 'suspended', currentTime: 0,
            async resume() {this.state = 'running'; this.dispatchEvent(new Event('statechange'));}
        });
        assert.equal(await ai.resumeAudio(context, false), true);
        assert.equal(context.state, 'running');

        const buffered = {
            generation: ai.speechGeneration, state: 'scheduled', scheduledEnd: 1,
            sourceNode: {buffer: {}, context, disconnect() {}}, audioContext: context
        };
        ai.speechJobs.push(buffered);
        ai.currentSpeechJob = buffered;
        // Preparation may complete while the preceding real-audio job is playing.
        assert.equal(await ai.streamTTS('After the saved recording.', true), true);
        assert.equal(utterances.length, 3);
        ai.speechScheduleContext = context;
        ai.speechScheduleTime = 1;
        context.state = 'suspended';
        ai.nextSentance(buffered);
        await Promise.resolve();
        assert.equal(utterances.length, 3);
        context.currentTime = 1;
        await context.resume();
        const afterBuffered = await nextUtterance(3);
        afterBuffered.onend();
        await Promise.resolve();
        assert.equal(ai.speechJobs.length, 0);

        // Stop retires a native segment still waiting on the prior audio clock.
        ai.speechScheduleContext = context;
        ai.speechScheduleTime = 2;
        context.state = 'suspended';
        const waiting = ai.streamTTS('Cancel during the inter-part pause.', true, {waitForPlayback: true});
        await Promise.resolve();
        ai.stopAudio();
        assert.equal(await waiting, false);
        context.currentTime = 2;
        await context.resume();
        assert.equal(utterances.length, 4);

        // Natural completion settles before native trailing silence; Stop clears the gap.
        const withPause = ai.streamTTS('Finish before the long pause.', true, {
            waitForPlayback: true, pauseAfterMs: 60000
        });
        const trailing = await nextUtterance(4);
        trailing.onend();
        assert.equal(await withPause, true);
        ai.stopAudio();

        const failed = ai.streamTTS('Retain the still-speaking squid.', true, {waitForPlayback: true});
        const failedUtterance = await nextUtterance(5);
        synthesis.resume = function rejectNativeResume() {throw new Error('Synthetic native resume failure.');};
        assert.equal(await ai.resumeAudio(), false);
        assert.equal(await failed, false);
        assert.equal(ai.isSpeaking, true);
        let bufferStarts = 0;
        const nextBuffer = {
            generation: ai.speechGeneration, state: 'ready', scheduledEnd: null,
            sourceNode: {buffer: {}, context, disconnect() {}, start() {bufferStarts += 1;}},
            audioContext: context, audioBuffer: {duration: 1}
        };
        ai.speechJobs.push(nextBuffer);
        await ai.resumeAudio(context, false);
        assert.equal(bufferStarts, 0);
        failedUtterance.onend();
        await Promise.resolve();
        assert.equal(bufferStarts, 1);
        context.currentTime = 3;
        ai.nextSentance(nextBuffer);

        const stoppedFailure = ai.streamTTS('Stop still owns this squid.', true, {waitForPlayback: true});
        await nextUtterance(6);
        assert.equal(await ai.resumeAudio(), false);
        assert.equal(await stoppedFailure, false);
        assert.equal(ai.isSpeaking, true);
        ai.stopAudio();
        await Promise.resolve();
        assert.equal(ai.isSpeaking, false);

        synthesis.resume = function resumeNativeSpeech() {};
        const originalDefault = await ai.prepareTTSPlayback(
            {input: 'Keep the prepared squid.'}
        );
        provider.setDefaultVoice('cosmic-gecko');
        const changedDefault = await ai.prepareTTSPlayback(
            {input: 'Use the current gecko.'}
        );
        const explicitChoice = await ai.prepareTTSPlayback(
            {input: 'Keep the chosen squid.', voice: 'lunar-squid'}
        );
        assert.equal(originalDefault.voice, 'lunar-squid');
        assert.equal(changedDefault.voice, 'cosmic-gecko');
        assert.equal(changedDefault.language, 'fr-FR');
        assert.equal(explicitChoice.voice, 'lunar-squid');
        const changedSpeech = ai.streamTTS(
            'A newly selected gecko.',
            true,
            {waitForPlayback: true}
        );
        const gecko = await nextUtterance(7);
        assert.equal(gecko.voice.voiceURI, 'cosmic-gecko');
        gecko.onend();
        assert.equal(await changedSpeech, true);
    } finally {
        try {
            ai?.stopAudio();
            await ai?.providerRuntime.disposeAll();
        } finally {
            const registration = globalThis[registrationKey];
            if (registration !== priorRegistration) registration?.dispose();
            for (const [key, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
        }
    }
});
