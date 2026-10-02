import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import test from '../src/testing.mjs';

// These fixtures exercise authored component functions with an explicit native
// capture double. They do not activate a browser, microphone, or speech service.
const source = await readFile(
    new URL('../runtime/arcane/components/speech.html', import.meta.url),
    'utf8'
);
const languageSuggestions = Array.from(
    source.matchAll(/<button id="recognitionLanguage-[^"]+"[^>]*data-language="([^"]+)"[^>]*>([^<]+)<\/button>/gu),
    function languageSuggestion(match) {
        return {tag: match[1], label: match[2]};
    }
);

function sourceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, `Speech source contains ${startMarker}.`);
    assert.ok(end > start, `Speech source contains ${endMarker} after ${startMarker}.`);
    return source.slice(start, end);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function retainSettlement(accept, decline) {
        resolve = accept;
        reject = decline;
    });
    return {promise, resolve, reject};
}

function element() {
    return {
        value: '',
        hidden: false,
        disabled: false,
        textContent: '',
        dataset: {},
        attributes: {},
        classList: {remove() {}},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        focus() {},
        scrollIntoView(options) { this.scrollOptions = options; }
    };
}

const createSpeechFixture = Function(
    'settings', 'deferred', 'element', 'languageSuggestions',
    `'use strict';
    const is = {
        string(value) { return typeof value === 'string'; },
        boolean(value) { return typeof value === 'boolean'; },
        function(value) { return typeof value === 'function'; }
    };
    const host = {
        dataset: {},
        muted: true,
        availability: {microphone: true},
        language: 'american-spanish',
        ...settings.host
    };
    const navigator = {language: settings.browserLanguage ?? 'en-US'};
    const recognitionLanguageControl = element();
    const recognitionLanguageInput = element();
    const recognitionLanguageToggle = element();
    const recognitionLanguages = {...element(), hidden: true};
    const recognitionLanguageOptions = languageSuggestions.map(
        function languageOption(suggestion) {
            return {
                ...element(),
                id: 'recognitionLanguage-' + suggestion.tag,
                textContent: suggestion.label,
                dataset: {language: suggestion.tag}
            };
        }
    );
    recognitionLanguageInput.focus = function focusLanguageInput() {
        openRecognitionLanguages();
    };
    const speechStatus = element();
    const recordButton = element();
    const stopButton = element();
    const sttActivationButton = element();
    const sttActivationProgress = element();
    const muteButton = element();
    const transcriptionEnabled = settings.mobile !== true;
    const sttActivationController = {
        pending: false, visible: false, action: 'load',
        label: 'Start transcription', title: 'Start transcription',
        status: 'Transcription ready.'
    };
    let sttRole = {state: 'ready', busy: false};
    let ttsRole = {state: 'ready', busy: false, providerId: 'voice', modelId: 'voice'};
    let liveCapture = settings.liveCapture !== false;
    let destroyed = false;
    let captureSession = null;
    let nativeCaptureSession = null;
    let recordingRequested = false;
    let recordingGeneration = 0;
    let transcriptionGeneration = 0;
    let transcriptionActive = false;
    let transcriptionAbortController = null;
    let localStatus = null;
    let pendingTTSIntent = null;
    let pendingUnmute = false;
    let transcriptionOperationId = null;
    let eventOperationSequence = 0;
    let silenceTimer = null;
    const silenceDuration = 0;
    const captures = [];
    const publications = [];
    const errors = [];
    const mutedConfiguration = [];
    const events = {
        descriptor: {instanceId: 'fixture-speech'},
        dispatch(type, detail, options) {
            const occurrence = {type, detail, ...options};
            publications.push(occurrence);
            settings.onPublication?.(occurrence);
            return {accepted: true, occurrence};
        }
    };
    function projectArcaneDOMEvent() { return true; }
    const providerRuntime = {
        supportsTranscriptionCapture() { return liveCapture; },
        createTranscriptionCapture(options) {
            const settlement = deferred();
            const capture = {
                options,
                done: settlement.promise,
                starts: 0,
                stops: 0,
                cancels: 0,
                start({signal}) {
                    this.starts += 1;
                    this.signal = signal;
                    return true;
                },
                stop() { this.stops += 1; return this.done; },
                cancel() { this.cancels += 1; settlement.resolve(); },
                finish() { settlement.resolve(); },
                fail(error) { settlement.reject(error); }
            };
            captures.push(capture);
            return capture;
        }
    };
    function resetRecordPress() {}
    function applyConfiguredMutedState(value) { mutedConfiguration.push(value); }
    function formatAIRuntimeProgress(progress, fallback) { return fallback; }
    function canonicalSTTCancellationReason(reason) { return reason; }
    const arcaneLogging = {error(message, error) { errors.push(error); }};
    function visibleErrorMessage() { return 'Try again.'; }
    function publicSpeechErrorFields(error) { return {code: error.code}; }
    ${sourceBetween('let recognitionLanguage =', 'function nextSpeechOperationId')}
    ${sourceBetween('function nextSpeechOperationId', 'function publicSpeechErrorFields')}
    ${sourceBetween('host.displayTranscription = host.displayTranscription !== false;', 'host.muted = true;')}
    ${sourceBetween('function configure(options = {})', 'function updateMicrophoneAvailability')}
    ${sourceBetween('function renderControls()', 'async function observeMicrophonePermission()')}
    ${sourceBetween('async function transcribe(transcription =', 'function stopAfterSilence()')}
    ${sourceBetween('function stopAfterSilence()', 'async function finalizeCapture(session)')}
    ${sourceBetween('function reportTranscriptionError(', 'function isTranscriptionCancellation(')}
    ${sourceBetween('function reportTranscriptionCancellation(', 'function releaseCaptureSession(session)')}
    renderControls();
    renderStatus();
    return {
        host, captures, publications, errors, mutedConfiguration,
        input: recognitionLanguageInput,
        control: recognitionLanguageControl,
        suggestions: recognitionLanguageOptions,
        list: recognitionLanguages,
        toggle: recognitionLanguageToggle,
        openLanguages: openRecognitionLanguages,
        closeLanguages: closeRecognitionLanguages,
        toggleLanguages: toggleRecognitionLanguages,
        selectLanguage(tag) {
            const option = recognitionLanguageOptions.find(
                function matchingLanguage(candidate) { return candidate.dataset.language === tag; }
            );
            selectRecognitionLanguage({currentTarget: option});
        },
        languageKey(key, isComposing = false) {
            const event = {
                key, isComposing, prevented: false,
                preventDefault() { this.prevented = true; }
            };
            handleRecognitionLanguageKeyDown(event);
            return event;
        },
        status: speechStatus,
        muteButton,
        activationButton: sttActivationButton,
        configure,
        inputLanguage(value) {
            recognitionLanguageInput.value = value;
            updateRecognitionLanguage();
        },
        record,
        stop,
        cancel: cancelSTTOperation,
        setPresentation(options) {
            if ('liveCapture' in options) liveCapture = options.liveCapture;
            if (options.stt) sttRole = {...sttRole, ...options.stt};
            if (options.tts) ttsRole = {...ttsRole, ...options.tts};
            if ('activationStatus' in options) sttActivationController.status = options.activationStatus;
            if ('pending' in options) sttActivationController.pending = options.pending;
            if ('pendingTTSIntent' in options) pendingTTSIntent = options.pendingTTSIntent;
            if ('pendingUnmute' in options) pendingUnmute = options.pendingUnmute;
            if ('microphone' in options) host.availability.microphone = options.microphone;
            if ('localStatus' in options) localStatus = options.localStatus;
            if ('destroyed' in options) destroyed = options.destroyed;
            renderControls();
            renderStatus();
        }
    };`
);

function speechFixture(settings = {}) {
    return createSpeechFixture(settings, deferred, element, languageSuggestions);
}

function visibleLanguages(fixture) {
    return fixture.suggestions.filter(function visibleLanguage(option) {
        return !option.hidden;
    }).map(function languageTag(option) {
        return option.dataset.language;
    });
}

function eventsOf(fixture, type) {
    return fixture.publications.filter(function matchingEvent(event) {
        return event.type === type;
    });
}

test('native recognition language is an editable suggested control inside speech feedback', function languageMarkup() {
    const feedback = sourceBetween('<div class="speech_feedback">', '<button id="muteButton"');
    assert.match(feedback, /<label for="recognitionLanguage">Recognition language<\/label>/u);
    assert.match(feedback, /<input id="recognitionLanguage" type="text" role="combobox"/u);
    assert.match(feedback, /id="recognitionLanguages" role="listbox" aria-label="Suggested recognition languages"/u);
    assert.deepEqual(languageSuggestions.map(function suggestionTag(option) { return option.tag; }), [
        'en-US', 'en-GB', 'es-MX', 'es-ES', 'fr-FR', 'de-DE', 'it-IT',
        'pt-BR', 'ja-JP', 'ko-KR', 'zh-CN', 'hi-IN', 'ar-SA'
    ]);
    assert.ok(languageSuggestions.some(function nativeSpanish(option) {
        return option.tag === 'es-MX' && option.label === 'Español (México) — es-MX';
    }));
    assert.ok(languageSuggestions.some(function nativeJapanese(option) {
        return option.tag === 'ja-JP' && option.label === '日本語（日本） — ja-JP';
    }));
    assert.match(feedback, /<p id="speechStatus"[^>]*role="status"[^>]*aria-live="polite"/u);
    assert.match(feedback, /id="sttActivationProgress"/u);
    assert.match(source, /recognitionLanguageInput\.addEventListener\('input', updateRecognitionLanguage, lifecycleListenerOptions\)/u);
    assert.match(source, /recognitionLanguageInput\.addEventListener\('blur', closeRecognitionLanguages, lifecycleListenerOptions\)/u);
});

test('saved values, unchanged input events, reopen and selection show the full suggestion list', function languageSuggestionOpening() {
    const fixture = speechFixture({host: {recognitionLanguage: 'es-MX'}});
    const all = languageSuggestions.map(function tag(option) { return option.tag; });
    assert.equal(fixture.list.hidden, true);
    fixture.openLanguages();
    assert.deepEqual(visibleLanguages(fixture), all);
    fixture.inputLanguage('es-MX');
    assert.deepEqual(visibleLanguages(fixture), all);
    fixture.inputLanguage('es');
    assert.deepEqual(visibleLanguages(fixture), ['en-US', 'es-MX', 'es-ES']);
    fixture.closeLanguages();
    fixture.openLanguages();
    assert.deepEqual(visibleLanguages(fixture), all);
    assert.equal(fixture.input.value, 'es');
    fixture.selectLanguage('ja-JP');
    assert.equal(fixture.host.recognitionLanguage, 'ja-JP');
    assert.equal(fixture.input.value, 'ja-JP');
    assert.equal(fixture.list.hidden, true);
    fixture.openLanguages();
    assert.deepEqual(visibleLanguages(fixture), all);
    fixture.inputLanguage('Español');
    assert.deepEqual(visibleLanguages(fixture), ['es-MX', 'es-ES']);
    fixture.configure({recognitionLanguage: 'pt-BR'});
    assert.deepEqual(visibleLanguages(fixture), all);
    assert.equal(fixture.input.attributes['aria-activedescendant'], undefined);
    assert.equal(fixture.suggestions.find(function brazil(option) {
        return option.dataset.language === 'pt-BR';
    }).attributes['aria-selected'], 'true');
});

test('language keyboard navigation preserves custom text and exact tags', function languageKeyboard() {
    const fixture = speechFixture();
    assert.equal(fixture.languageKey('ArrowUp').prevented, true);
    assert.equal(fixture.input.attributes['aria-expanded'], 'true');
    assert.equal(fixture.input.attributes['aria-activedescendant'], 'recognitionLanguage-ar-SA');
    assert.equal(fixture.languageKey('Enter').prevented, true);
    assert.equal(fixture.host.recognitionLanguage, 'ar-SA');
    assert.equal(fixture.list.hidden, true);
    fixture.inputLanguage('Français');
    fixture.languageKey('ArrowDown');
    fixture.languageKey('Enter');
    assert.equal(fixture.host.recognitionLanguage, 'fr-FR');
    fixture.inputLanguage('  zh-Hant-TW  ');
    assert.deepEqual(visibleLanguages(fixture), []);
    fixture.languageKey('ArrowDown');
    fixture.languageKey('Enter');
    assert.equal(fixture.host.recognitionLanguage, '  zh-Hant-TW  ');
    fixture.openLanguages();
    assert.equal(fixture.languageKey('Escape').prevented, true);
    assert.equal(fixture.list.hidden, true);
    fixture.openLanguages();
    assert.equal(fixture.languageKey('Tab').prevented, false);
    assert.equal(fixture.list.hidden, true);
    fixture.toggleLanguages();
    assert.equal(fixture.list.hidden, false);
    fixture.toggleLanguages();
    assert.equal(fixture.list.hidden, true);
    assert.equal(fixture.languageKey('ArrowDown', true).prevented, false);
    assert.equal(fixture.list.hidden, true);
});

test('language picker closes and becomes inoperative outside desktop live transcription', function languageVisibility() {
    const fixture = speechFixture();
    fixture.openLanguages();
    fixture.setPresentation({liveCapture: false});
    assert.equal(fixture.control.hidden, true);
    assert.equal(fixture.input.disabled, true);
    assert.equal(fixture.toggle.disabled, true);
    assert.equal(fixture.list.hidden, true);
    fixture.openLanguages();
    fixture.inputLanguage('fr-FR');
    assert.equal(fixture.host.recognitionLanguage, 'en-US');
    assert.equal(fixture.list.hidden, true);
    fixture.setPresentation({liveCapture: true});
    assert.equal(fixture.input.disabled, false);
    fixture.setPresentation({destroyed: true});
    assert.equal(fixture.input.disabled, true);
    assert.equal(fixture.list.hidden, true);
    const mobile = speechFixture({mobile: true});
    assert.equal(mobile.control.hidden, true);
    assert.equal(mobile.input.disabled, true);
    mobile.toggleLanguages();
    assert.equal(mobile.list.hidden, true);
});

test('recognition language preserves app hydration and stays separate from conversation language', function languageProperty() {
    const browser = speechFixture({browserLanguage: 'fr-CA'});
    assert.equal(browser.host.recognitionLanguage, 'fr-CA');
    assert.equal(browser.input.value, 'fr-CA');
    assert.equal(browser.host.language, 'american-spanish');

    const fixture = speechFixture({host: {recognitionLanguage: 'es-US'}, browserLanguage: 'fr-CA'});
    assert.equal(fixture.host.recognitionLanguage, 'es-US');
    assert.equal(fixture.input.value, 'es-US');
    fixture.host.recognitionLanguage = 'zh-Hant-TW';
    assert.equal(fixture.input.value, 'zh-Hant-TW');
    assert.equal(fixture.configure({recognitionLanguage: 'pt-PT', initialMuted: false}), fixture.host);
    assert.equal(fixture.host.recognitionLanguage, 'pt-PT');
    assert.deepEqual(fixture.mutedConfiguration, [false]);
    fixture.inputLanguage('en-NZ');
    assert.equal(fixture.host.recognitionLanguage, 'en-NZ');
    fixture.inputLanguage('');
    assert.equal(fixture.host.recognitionLanguage, '');
    assert.throws(function rejectNonStringLanguage() {
        fixture.host.recognitionLanguage = null;
    }, TypeError);
});

test('native language replaces ready STT words while model status, TTS and failures remain', function statusPresentation() {
    const fixture = speechFixture();
    assert.equal(fixture.control.hidden, false);
    assert.equal(fixture.status.textContent, '');
    fixture.setPresentation({liveCapture: false});
    assert.equal(fixture.control.hidden, true);
    assert.equal(fixture.status.textContent, 'Transcription ready. Voice ready and muted.');
    fixture.setPresentation({liveCapture: true, stt: {state: 'loading'}, activationStatus: 'Transcription loading.'});
    assert.equal(fixture.status.textContent, 'Transcription loading.');
    assert.equal(fixture.status.attributes['aria-busy'], 'true');
    fixture.setPresentation({stt: {state: 'error'}, activationStatus: 'Transcription failed.'});
    assert.equal(fixture.status.textContent, 'Transcription failed.');
    assert.equal(fixture.status.dataset.tone, 'error');
    fixture.setPresentation({stt: {state: 'ready'}, microphone: false});
    assert.equal(fixture.status.textContent, 'Microphone unavailable.');
    fixture.setPresentation({microphone: true, tts: {state: 'loading'}});
    assert.equal(fixture.status.textContent, 'Voice loading; Cancel is available.');
    assert.equal(fixture.muteButton.textContent, 'Cancel voice load');
    assert.equal(fixture.muteButton.disabled, false);
    fixture.setPresentation({localStatus: {message: 'Speech audio could not play.', tone: 'error'}});
    assert.match(fixture.status.textContent, /^Speech audio could not play\. Voice loading/u);
    assert.equal(fixture.status.dataset.tone, 'error');
    fixture.setPresentation({localStatus: null, tts: {state: 'unloaded'}});
    assert.equal(fixture.status.textContent, '');
    fixture.setPresentation({pendingTTSIntent: 'load'});
    assert.equal(fixture.status.textContent, 'Voice load requested; Cancel is available.');
    fixture.setPresentation({pendingTTSIntent: null, pendingUnmute: true});
    assert.equal(fixture.status.textContent, 'Voice unloaded.');
    fixture.setPresentation({pendingUnmute: false});
    assert.equal(fixture.status.textContent, '');
    fixture.setPresentation({pendingTTSIntent: null, tts: {state: 'ready', busy: true}});
    fixture.host.muted = false;
    fixture.setPresentation({});
    assert.equal(fixture.status.textContent, 'Voice speaking.');
    fixture.setPresentation({tts: {state: 'error', busy: false}});
    assert.equal(fixture.status.textContent, 'Voice error: Unknown error.');
    assert.equal(fixture.muteButton.textContent, 'Retry voice');
    const mobile = speechFixture({mobile: true});
    assert.equal(mobile.control.hidden, true);
    assert.equal(mobile.status.textContent, 'Voice ready and muted.');
});

test('native capture latches language synchronously and stop drains exact final text once', async function nativeLanguageAndFinals() {
    const fixture = speechFixture({host: {recognitionLanguage: 'es-MX'}});
    const starting = fixture.record();
    assert.equal(fixture.captures.length, 1);
    const capture = fixture.captures[0];
    assert.equal(capture.starts, 1);
    assert.equal(capture.options.language, 'es-MX');
    assert.equal(capture.options.continuous, true);
    assert.equal(fixture.input.disabled, true);
    fixture.host.recognitionLanguage = 'ja-JP';
    assert.equal(capture.options.language, 'es-MX');
    await starting;

    capture.options.onInterim({text: 'Hola\n'});
    capture.options.onSegment({text: 'Hola\n', sequence: 1});
    capture.options.onInterim({text: 'mundo'});
    fixture.stop();
    assert.equal(capture.stops, 1);
    assert.equal(eventsOf(fixture, 'speech-transcription-complete').length, 0);
    capture.options.onSegment({text: 'mundo 🌎', sequence: 2});
    capture.finish();
    await setImmediate();

    const progress = eventsOf(fixture, 'speech-transcription-progress');
    assert.deepEqual(progress.map(function detail(event) { return event.detail; }), [
        {text: '', interim: 'Hola\n'},
        {text: 'Hola\n', interim: ''},
        {text: 'Hola\n', interim: 'mundo'},
        {text: 'Hola\nmundo 🌎', interim: ''}
    ]);
    const complete = eventsOf(fixture, 'speech-transcription-complete');
    assert.equal(complete.length, 1);
    assert.deepEqual(complete[0].detail, {text: 'Hola\nmundo 🌎'});
    for (const event of progress) {
        assert.equal(event.operationId, complete[0].operationId);
        assert.deepEqual(event.publicDetail, event.detail);
    }
    assert.equal(fixture.input.disabled, false);
    await fixture.record();
    assert.equal(fixture.captures[1].options.language, 'ja-JP');
    fixture.cancel('fixture-cleanup');
    await setImmediate();
    fixture.inputLanguage('');
    await fixture.record();
    assert.equal(fixture.captures[2].options.language, undefined);
    fixture.cancel('fixture-cleanup');
    await setImmediate();
});

test('draft presentation emits live snapshots without duplicate status words and clears unfinished interim on end', async function draftProgress() {
    const fixture = speechFixture({host: {displayTranscription: false}});
    await fixture.record();
    const capture = fixture.captures[0];
    capture.options.onInterim({text: 'Only provisional words'});
    assert.equal(fixture.status.textContent, 'Listening. Release to finish.');
    assert.deepEqual(eventsOf(fixture, 'speech-transcription-progress')[0].detail, {
        text: '', interim: 'Only provisional words'
    });
    capture.finish();
    await setImmediate();
    const progress = eventsOf(fixture, 'speech-transcription-progress');
    assert.deepEqual(progress.at(-1).detail, {text: '', interim: ''});
    assert.equal(eventsOf(fixture, 'speech-transcription-complete').length, 0);
    fixture.configure({displayTranscription: true});
    await fixture.record();
    const next = fixture.captures[1];
    next.options.onSegment({text: 'Visible words', sequence: 1});
    assert.equal(fixture.status.textContent, 'Visible words');
    const failure = new Error('Synthetic service failure');
    next.options.onError(failure);
    next.fail(failure);
    await setImmediate();
    assert.deepEqual(fixture.errors, [failure]);
    assert.match(fixture.status.textContent, /^Transcription failed: Try again\./u);
    assert.equal(eventsOf(fixture, 'speech-transcription-complete')[0].detail.text, 'Visible words');
});

test('cancelled native capture preserves cancellation identity and ignores all late text', async function cancelledProgress() {
    const fixture = speechFixture();
    await fixture.record();
    const capture = fixture.captures[0];
    capture.options.onInterim({text: 'Temporary draft'});
    const progress = eventsOf(fixture, 'speech-transcription-progress')[0];
    fixture.cancel('runtime-unready');
    assert.equal(capture.signal.aborted, true);
    assert.equal(capture.cancels, 1);
    const cancellation = eventsOf(fixture, 'speech-transcription-cancelled')[0];
    assert.equal(cancellation.operationId, progress.operationId);
    assert.deepEqual(cancellation.detail, {reason: 'runtime-unready'});
    capture.options.onSegment({text: 'Late words', sequence: 1});
    capture.options.onInterim({text: 'Late provisional words'});
    await setImmediate();
    assert.equal(eventsOf(fixture, 'speech-transcription-progress').length, 1);
    assert.equal(eventsOf(fixture, 'speech-transcription-complete').length, 0);
});

test('native error before cancellation retains the original draft operation identity', async function errorThenCancelledProgress() {
    const fixture = speechFixture();
    await fixture.record();
    const capture = fixture.captures[0];
    capture.options.onSegment({text: 'Confirmed words. ', sequence: 1});
    capture.options.onInterim({text: 'Unfinished hypothesis'});
    const progress = eventsOf(fixture, 'speech-transcription-progress').at(-1);
    const failure = new Error('Synthetic native failure before onend.');
    capture.options.onError(failure);
    assert.equal(eventsOf(fixture, 'speech-transcription-error')[0].operationId, progress.operationId);
    fixture.cancel('runtime-unready');
    const cancellation = eventsOf(fixture, 'speech-transcription-cancelled')[0];
    assert.equal(cancellation.operationId, progress.operationId);
    assert.equal(capture.signal.aborted, true);
    capture.options.onInterim({text: 'Late hypothesis'});
    await setImmediate();
    assert.deepEqual(eventsOf(fixture, 'speech-transcription-progress').at(-1).detail, {
        text: 'Confirmed words. ', interim: 'Unfinished hypothesis'
    });
    assert.equal(eventsOf(fixture, 'speech-transcription-complete').length, 0);
    assert.deepEqual(fixture.errors, [failure]);
});
