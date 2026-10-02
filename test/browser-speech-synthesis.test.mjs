import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createBrowserSpeechSynthesisProvider} from '../browser-runtime/ai/browser-speech-synthesis.mjs';

const englishVoice = {voiceURI: 'native:dragon', name: 'Dragon', lang: 'en-US', default: true, localService: true};
const frenchVoice = {voiceURI: 'native:dragon-fr', name: 'Dragon', lang: 'fr-FR', default: true, localService: false};

class NativeUtterance {
    constructor(text) {
        this.text = text;
    }
}

class NativeSynthesis extends EventTarget {
    constructor(voices = []) {
        super();
        this.voices = voices;
        this.spoken = [];
        this.current = null;
        this.cancelCalls = 0;
        this.pauseCalls = 0;
        this.resumeCalls = 0;
        this.paused = false;
        this.catalogListeners = new Set();
        this.cancelFailure = null;
    }

    addEventListener(name, callback, options) {
        if (name === 'voiceschanged') this.catalogListeners.add(callback);
        super.addEventListener(name, callback, options);
    }

    removeEventListener(name, callback, options) {
        if (name === 'voiceschanged') this.catalogListeners.delete(callback);
        super.removeEventListener(name, callback, options);
    }

    getVoices() { return this.voices; }

    speak(utterance) {
        this.current = utterance;
        this.spoken.push(utterance);
        if (!this.paused) utterance.onstart?.({type: 'start'});
    }

    cancel() {
        this.cancelCalls += 1;
        if (this.cancelFailure) throw this.cancelFailure;
        const current = this.current;
        this.current = null;
        current?.onerror?.({error: 'interrupted'});
    }

    pause() {
        this.pauseCalls += 1;
        this.paused = true;
        this.current?.onpause?.({type: 'pause'});
    }

    resume() {
        this.resumeCalls += 1;
        this.paused = false;
        this.current?.onresume?.({type: 'resume'});
    }

    finish() {
        const current = this.current;
        this.current = null;
        current?.onend?.({type: 'end'});
    }

    fail(reason) {
        const current = this.current;
        this.current = null;
        current?.onerror?.({error: reason});
    }

    changeVoices(voices) {
        this.voices = voices;
        this.dispatchEvent(new Event('voiceschanged'));
    }
}

async function withNativeSpeech(voices, callback) {
    const synthesisDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'speechSynthesis');
    const utteranceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'SpeechSynthesisUtterance');
    const synthesis = new NativeSynthesis(voices);
    const providers = [];
    Object.defineProperty(globalThis, 'speechSynthesis', {configurable: true, writable: true, value: synthesis});
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {configurable: true, writable: true, value: NativeUtterance});
    function createProvider({id = 'native-speech', name, defaultVoice, language} = {}) {
        const provider = createBrowserSpeechSynthesisProvider({id, model: {id, name, defaultVoice}, language});
        providers.push(provider);
        return provider;
    }
    try {
        await callback({synthesis, createProvider});
    } finally {
        for (const provider of providers) await provider.dispose();
        if (synthesisDescriptor) Object.defineProperty(globalThis, 'speechSynthesis', synthesisDescriptor);
        else delete globalThis.speechSynthesis;
        if (utteranceDescriptor) Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', utteranceDescriptor);
        else delete globalThis.SpeechSynthesisUtterance;
    }
}

test('native voice catalog replays current real voices and releases its listener', async function nativeCatalogLifecycle() {
    await withNativeSpeech([], async function inspectCatalog({synthesis, createProvider}) {
        const provider = createProvider({name: 'Browser speech'});
        const snapshots = [];
        const unsubscribe = provider.subscribeCatalog(function receiveCatalog(models) { snapshots.push(models); });
        assert.deepEqual(snapshots[0][0].voices, []);
        assert.equal(snapshots[0][0].name, 'Browser speech');
        assert.equal(snapshots[0][0].defaultVoice, null);
        assert.deepEqual(snapshots[0][0].speech, {playback: 'native'});
        synthesis.changeVoices([englishVoice, frenchVoice]);
        assert.deepEqual(snapshots[1][0].voices, [
            {id: englishVoice.voiceURI, name: englishVoice.name, lang: englishVoice.lang, default: true, localService: true},
            {id: frenchVoice.voiceURI, name: frenchVoice.name, lang: frenchVoice.lang, default: true, localService: false}
        ]);
        assert.equal(synthesis.spoken.length, 0);
        assert.equal(unsubscribe(), true);
        assert.equal(unsubscribe(), false);
        assert.equal(synthesis.catalogListeners.size, 0);
        synthesis.changeVoices([]);
        assert.equal(snapshots.length, 2);
    });
});

test('native inspect load and request prepare silently while explicit play preserves selected text and voice', async function inertPreparation() {
    await withNativeSpeech([englishVoice, frenchVoice], async function inspectPreparation({synthesis, createProvider}) {
        const provider = createProvider({defaultVoice: englishVoice.voiceURI, language: englishVoice.lang});
        assert.equal((await provider.inspect()).available, true);
        await provider.load();
        const input = '  Bonjour, dragon.\nKeep **every** supplied character.  ';
        const prepared = await provider.request({operation: 'synthesize', payload: {input, voice: frenchVoice.voiceURI, speed: 1.25}});
        assert.equal(prepared.kind, 'native-speech');
        assert.equal(prepared.input, input);
        assert.equal(prepared.voice, frenchVoice.voiceURI);
        assert.equal(prepared.language, 'fr-FR');
        assert.equal(synthesis.spoken.length, 0);
        const states = [];
        const playback = prepared.play({onState: function recordState(value) { states.push(value.state); }});
        assert.equal(synthesis.current.text, input);
        assert.equal(synthesis.current.voice, frenchVoice);
        assert.equal(synthesis.current.lang, 'fr-FR');
        assert.equal(synthesis.current.rate, 1.25);
        assert.equal(provider.status().busy, false);
        assert.equal(provider.status().execution.activeRequestCount, 0);
        const next = await provider.request({operation: 'synthesize', payload: {input: 'The next dragon is ready.'}});
        assert.equal(next.kind, 'native-speech');
        assert.equal(synthesis.spoken.length, 1);
        assert.equal(playback.pause(), true);
        assert.equal(playback.state, 'paused');
        assert.equal(playback.resume(), true);
        synthesis.finish();
        assert.equal(await playback.finished, true);
        assert.equal(playback.state, 'complete');
        assert.deepEqual(states, ['queued', 'playing', 'paused', 'playing', 'complete']);
    });
});

test(
    'an application can select its current default from a late catalog without stale observer replay',
    async function currentDefaultCatalog() {
        await withNativeSpeech(
            [],
            async function inspectCurrentDefault({synthesis, createProvider}) {
                const provider = createProvider();
                let selections = 0;
                provider.subscribeCatalog(
                    function selectApplicationDefault(models) {
                        selections += 1;
                        const preferred = models[0].voices.find(
                            function preferFrenchVoice(voice) {
                                return voice.id === frenchVoice.voiceURI;
                            }
                        );
                        if (preferred) provider.setDefaultVoice(preferred.id);
                    }
                );
                const observedDefaults = [];
                provider.subscribeCatalog(
                    function receiveCurrentDefault(models) {
                        observedDefaults.push(models[0].defaultVoice);
                    }
                );

                synthesis.changeVoices(
                    [englishVoice, frenchVoice]
                );
                assert.deepEqual(
                    observedDefaults,
                    [null, frenchVoice.voiceURI]
                );
                assert.equal(selections, 3);
                assert.equal(provider.setDefaultVoice(frenchVoice.voiceURI), frenchVoice.voiceURI);
                assert.equal(selections, 3);
                assert.equal(provider.catalog()[0].defaultVoice, frenchVoice.voiceURI);
                const selected = provider.prepare(
                    {input: 'Bonjour, dragon.'}
                );
                const explicit = provider.prepare(
                    {input: 'Hello, dragon.', voice: englishVoice.voiceURI}
                );
                assert.equal(selected.voice, frenchVoice.voiceURI);
                assert.equal(explicit.voice, englishVoice.voiceURI);
                assert.equal(provider.status().state, 'unloaded');
                assert.equal(synthesis.spoken.length, 0);
                assert.equal(synthesis.cancelCalls, 0);
            }
        );
    }
);

test(
    'default changes preserve prepared queued and active speech and apply to future requests',
    async function currentDefaultPlayback() {
        await withNativeSpeech(
            [englishVoice, frenchVoice],
            async function inspectDefaultPlayback({synthesis, createProvider}) {
                const provider = createProvider(
                    {defaultVoice: englishVoice.voiceURI}
                );
                await provider.load();
                const prepared = provider.prepare(
                    {input: 'The waiting dragon.'}
                );
                const active = provider.play(
                    {input: 'The speaking dragon.'}
                );
                const queued = provider.play(
                    {input: 'The patient dragon.'}
                );
                const before = provider.status();

                assert.equal(provider.setDefaultVoice(frenchVoice.voiceURI), frenchVoice.voiceURI);
                assert.deepEqual(provider.status(), before);
                assert.equal(synthesis.current.voice, englishVoice);
                assert.equal(queued.state, 'queued');
                assert.equal(synthesis.cancelCalls, 0);
                assert.equal(synthesis.pauseCalls, 0);
                assert.equal(synthesis.resumeCalls, 0);
                const stillPrepared = prepared.play();
                const next = provider.play(
                    {input: 'Le prochain dragon.'}
                );
                const explicit = provider.play(
                    {input: 'The chosen dragon.', voice: englishVoice.voiceURI}
                );
                for (const [playback, voice] of [
                    [active, englishVoice],
                    [queued, englishVoice],
                    [stillPrepared, englishVoice],
                    [next, frenchVoice],
                    [explicit, englishVoice]
                ]) {
                    assert.equal(synthesis.current.voice, voice);
                    synthesis.finish();
                    assert.equal(await playback.finished, true);
                }

                assert.equal(provider.setDefaultVoice(null), null);
                const cleared = provider.prepare(
                    {input: 'The browser default dragon.'}
                );
                assert.equal(cleared.voice, englishVoice.voiceURI);
                assert.equal(provider.setDefaultVoice(''), null);
                assert.equal(provider.setDefaultVoice(), null);
                provider.setDefaultVoice('native:missing');
                assert.equal(provider.catalog()[0].defaultVoice, 'native:missing');
                assert.throws(
                    function useUnavailableDefault() {
                        provider.prepare(
                            {input: 'The missing dragon.'}
                        );
                    },
                    {code: 'ARCANE_AI_SPEECH_VOICE_UNAVAILABLE'}
                );
                const explicitWithMissingDefault = provider.prepare(
                    {input: 'The explicit dragon.', voice: englishVoice.voiceURI}
                );
                assert.equal(explicitWithMissingDefault.voice, englishVoice.voiceURI);
                assert.throws(
                    function setMalformedDefault() {
                        provider.setDefaultVoice(
                            {}
                        );
                    },
                    TypeError
                );
                const unloading = provider.unload();
                assert.throws(
                    function changeUnloadingDefault() {
                        provider.setDefaultVoice('native:missing');
                    },
                    {code: 'ARCANE_AI_OPERATION_SUPERSEDED'}
                );
                await unloading;
                assert.equal(provider.setDefaultVoice(englishVoice.voiceURI), englishVoice.voiceURI);
                await provider.dispose();
                assert.throws(
                    function changeDisposedDefault() {
                        provider.setDefaultVoice(englishVoice.voiceURI);
                    },
                    {code: 'ARCANE_AI_PROVIDER_DISPOSED'}
                );
            }
        );
    }
);

test('explicit preview works without activating automatic provider speech', async function independentPreview() {
    await withNativeSpeech([englishVoice], async function inspectPreview({synthesis, createProvider}) {
        const provider = createProvider();
        assert.equal(provider.status().state, 'unloaded');
        const preview = provider.play({input: 'Welcome aboard the dragon bus.'});
        assert.equal(provider.status().state, 'unloaded');
        assert.equal(synthesis.current.voice, englishVoice);
        synthesis.finish();
        assert.equal(await preview.finished, true);
        assert.equal(provider.status().state, 'unloaded');
    });
});

test('saved voice waits for native catalog readiness and owns cancellation', async function pendingSavedVoice() {
    await withNativeSpeech([], async function inspectPendingVoice({synthesis, createProvider}) {
        const provider = createProvider({defaultVoice: frenchVoice.voiceURI});
        const prepared = provider.prepare({input: 'Bonjour, dragon.'});
        const playback = prepared.play();
        assert.equal(playback.state, 'waiting-for-voices');
        assert.equal(synthesis.spoken.length, 0);
        assert.equal(synthesis.catalogListeners.size, 1);
        synthesis.changeVoices([englishVoice, frenchVoice]);
        assert.equal(synthesis.current.voice, frenchVoice);
        assert.equal(synthesis.current.lang, frenchVoice.lang);
        assert.equal(synthesis.catalogListeners.size, 0);
        synthesis.finish();
        assert.equal(await playback.finished, true);

        synthesis.changeVoices([]);
        const controller = new AbortController();
        const cancelled = provider.play({input: 'A waiting dragon.'}, {signal: controller.signal});
        controller.abort();
        assert.equal(await cancelled.finished, false);
        assert.equal(synthesis.catalogListeners.size, 0);
        synthesis.changeVoices([frenchVoice]);
        assert.equal(synthesis.spoken.length, 1);
    });
});

test('native queue cancels only its pending record and starts the next after actual end', async function nativeQueueOwnership() {
    await withNativeSpeech([englishVoice], async function inspectQueue({synthesis, createProvider}) {
        const firstProvider = createProvider({id: 'first'});
        const secondProvider = createProvider({id: 'second'});
        const first = firstProvider.play({input: 'First dragon.'});
        const discarded = secondProvider.play({input: 'Cancelled dragon.'});
        const third = secondProvider.play({input: 'Third dragon.'});
        assert.equal(synthesis.spoken.length, 1);
        assert.equal(discarded.state, 'queued');
        discarded.stop();
        assert.equal(await discarded.finished, false);
        assert.equal(synthesis.cancelCalls, 0);
        synthesis.finish();
        assert.equal(await first.finished, true);
        assert.deepEqual(synthesis.spoken.map(function spokenText(utterance) { return utterance.text; }), ['First dragon.', 'Third dragon.']);
        synthesis.finish();
        assert.equal(await third.finished, true);
    });
});

test('stopping paused speech releases its paused state before the next utterance', async function pausedCancellation() {
    await withNativeSpeech([englishVoice], async function inspectPausedCancellation({synthesis, createProvider}) {
        const provider = createProvider();
        const first = provider.play({input: 'Paused dragon.'});
        const second = provider.play({input: 'Moving dragon.'});
        first.pause();
        first.stop();
        assert.equal(await first.finished, false);
        assert.equal(synthesis.paused, false);
        assert.equal(second.state, 'playing');
        synthesis.finish();
        assert.equal(await second.finished, true);
    });
});

test('native failure rejects with its actual reason and releases the next request', async function nativeFailure() {
    await withNativeSpeech([englishVoice], async function inspectFailure({synthesis, createProvider}) {
        const provider = createProvider();
        const first = provider.play({input: 'Failed dragon.'});
        const second = provider.play({input: 'Next dragon.'});
        synthesis.fail('audio-busy');
        await assert.rejects(first.finished, function actualFailure(error) {
            return error.code === 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED' && error.reason === 'audio-busy';
        });
        assert.equal(first.state, 'error');
        assert.equal(second.state, 'playing');
        synthesis.finish();
        assert.equal(await second.finished, true);
    });
});

test('failed native cancellation retains resource ownership until actual end', async function failedStopOwnership() {
    await withNativeSpeech([englishVoice], async function inspectFailedStop({synthesis, createProvider}) {
        const provider = createProvider();
        const first = provider.play({input: 'Stubborn dragon.'});
        const second = provider.play({input: 'Patient dragon.'});
        let firstReleased = false;
        first.released.then(function recordActualRelease() { firstReleased = true; });
        synthesis.cancelFailure = new Error('The native service did not accept cancellation.');
        assert.equal(first.stop(), false);
        await assert.rejects(first.finished, {code: 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED'});
        assert.equal(firstReleased, false);
        assert.equal(synthesis.spoken.length, 1);
        synthesis.cancelFailure = null;
        synthesis.finish();
        await first.released;
        assert.equal(firstReleased, true);
        assert.equal(second.state, 'playing');
        synthesis.finish();
        assert.equal(await second.finished, true);
    });
});

test('dispose cancels pending voice readiness and removes catalog subscriptions', async function disposePendingSpeech() {
    await withNativeSpeech([], async function inspectDispose({synthesis, createProvider}) {
        const provider = createProvider({defaultVoice: englishVoice.voiceURI});
        const snapshots = [];
        provider.subscribeCatalog(function recordCatalog(value) { snapshots.push(value); });
        const prepared = provider.prepare({input: 'A waiting dragon.'});
        const playback = prepared.play();
        assert.equal(synthesis.catalogListeners.size, 2);
        await provider.dispose();
        assert.equal(await playback.finished, false);
        assert.equal(provider.status().state, 'disposed');
        assert.equal(synthesis.catalogListeners.size, 0);
        synthesis.changeVoices([englishVoice]);
        assert.equal(synthesis.spoken.length, 0);
        assert.equal(snapshots.length, 1);
        assert.throws(function playDisposedPreparation() { prepared.play(); }, {code: 'ARCANE_AI_PROVIDER_DISPOSED'});
    });
});

test('native synthesis reports unsupported hosts and unknown exact voice selections honestly', async function unavailableNativeSpeech() {
    await withNativeSpeech([englishVoice], async function inspectUnsupported({synthesis, createProvider}) {
        const provider = createProvider();
        assert.throws(function chooseUnknownVoice() {
            provider.prepare({input: 'One dragon.', voice: 'native:missing'});
        }, {code: 'ARCANE_AI_SPEECH_VOICE_UNAVAILABLE'});
        delete globalThis.SpeechSynthesisUtterance;
        assert.equal((await provider.inspect()).available, false);
        await assert.rejects(provider.load(), {code: 'ARCANE_AI_SPEECH_SYNTHESIS_UNAVAILABLE'});
        assert.equal(synthesis.spoken.length, 0);
    });
});
