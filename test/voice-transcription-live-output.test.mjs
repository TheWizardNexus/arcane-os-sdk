import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Is from 'strong-type';

import test from '../src/testing.mjs';
import {
    appendTranscription,
    normalizeVoiceOptions
} from '../runtime/arcane/modules/ComponentContracts.js';

const source = await readFile(
    new URL('../runtime/arcane/components/voice-transcription.html', import.meta.url),
    'utf8'
);

function componentSection(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, startMarker);
    assert.ok(end > start, endMarker);
    return source.slice(start, end);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function captureSettlement(accept, decline) {
        resolve = accept;
        reject = decline;
    });
    return {promise, resolve, reject};
}

// Exercise the authored capture callbacks, output projection, ordered queue,
// replacement and cleanup. Recognition, storage and DOM/Markdown rendering are
// explicit doubles; this fixture does not exercise a microphone or browser.
const initializeVoice = Function(
    'ui', 'Is', 'appendTranscription', 'normalizeVoiceOptions',
    `'use strict';
    const is = new Is(false);
    const {
        host, transcriptElement, MD, providerRuntime, ContinuousVoiceCapture,
        arcaneLogging, window
    } = ui;
    let options = normalizeVoiceOptions(ui.options);
    let destroyed = false;
    let sessionGeneration = 0;
    let state = 'idle';
    let stateMessage = '';
    let transcript = options.initialValue;
    let continuousSession = null;
    let completionAbortController = null;
    let transcriptionAbortController = null;
    let mediaStream = null;
    let recorder = null;
    let voiceOperationId = 'live-output';
    let sttRole = {
        state: 'ready', loaded: true, busy: false,
        providerId: 'fixture-native', modelId: 'fixture-recognition'
    };
    const runtimeStateAbortController = new AbortController();
    const sttActivationController = {synchronize() {}, destroy() {}};
    const events = {dispose() {}};
    function completeValue(value) { return value; }
    function nextVoiceOperationId() { return 'live-output'; }
    function currentVoiceOperationId() { return voiceOperationId; }
    function canonicalSTTCancellationReason(reason) { return reason; }
    function renderState() {}
    function renderOptions() {}
    function getOptions() { return options; }
    function releaseMicrophone() {}
    function dispatchVoiceEvent(type, detail) {
        ui.events.push({type, detail});
        ui.onEvent?.(type, detail);
        return true;
    }
    function transcribeAudio(file, context, signal) {
        return ui.transcribe(file, context, signal);
    }
    ${componentSection('    function canStartVoiceRecording(', '    function optionsFromDataset(')}
    ${componentSection('    function configure(', '    function handlePrimaryClick(')}
    ${componentSection('    function isCurrentContinuousSession(', '    async function startRecording(')}
    ${componentSection('    function isCurrentVoiceOperation(', '    function rejectRecordingStart(')}
    ${componentSection('    async function completeStream(', '    function renderOptions(')}
    ${componentSection('    function setState(', '    function renderState(')}
    ${componentSection('    function handlePageHide(', '\n    renderOptions();')}
    Object.defineProperty(host, 'value', {
        get: function currentTranscript() { return transcript; },
        set: setValue
    });
    renderTranscript();
    return {
        start: startContinuousRecording,
        stop() { return stopContinuousRecording(continuousSession); },
        retry: retryTranscription,
        cancel: cancelRecording,
        complete: completeStream,
        configure,
        destroy,
        pageHide: handlePageHide,
        get state() { return state; },
        get session() { return continuousSession; },
        async settled() { await continuousSession?.worker; },
        setRole(patch) {
            synchronizeAIRuntimeState({roles: {stt: {...sttRole, ...patch}}});
        }
    };`
);

function createVoiceFixture(settings = {}) {
    const captures = [];
    const saved = [];
    const completed = [];
    const events = [];
    const errors = [];
    const host = {};
    const transcriptElement = {
        innerHTML: '',
        querySelectorAll() { return []; }
    };
    class MarkdownDouble {
        constructor(text) {
            // Retain the complete authored Markdown input for inspection.
            this.safeRendered = text;
        }
    }
    class CaptureDouble {
        constructor(callbacks) {
            this.callbacks = callbacks;
            this.terminal = deferred();
            this.done = this.terminal.promise;
            this.starts = 0;
            this.stops = 0;
            this.cancels = 0;
            captures.push(this);
        }
        start({signal}) {
            this.signal = signal;
            this.starts += 1;
            this.callbacks.onState('listening');
            return Promise.resolve(true);
        }
        segment(text, sequence) {
            this.callbacks.onSegment({text, sequence});
        }
        interim(text) {
            this.callbacks.onInterim({text});
        }
        stop() {
            this.stops += 1;
            settings.onStop?.(this);
            return this.done;
        }
        finish() {
            this.callbacks.onState('stopped');
            this.terminal.resolve(true);
        }
        cancel() {
            this.cancels += 1;
            this.finish();
            return this.done;
        }
        fail(error) {
            this.callbacks.onError(error);
            this.callbacks.onState('interrupted');
            this.terminal.resolve(false);
        }
    }
    const ui = {
        host,
        transcriptElement,
        MD: MarkdownDouble,
        providerRuntime: {
            createTranscriptionCapture(callbacks) {
                return new CaptureDouble(callbacks);
            }
        },
        ContinuousVoiceCapture: CaptureDouble,
        arcaneLogging: {error(...details) { errors.push(details); }},
        window: new EventTarget(),
        events,
        onEvent: settings.onEvent,
        transcribe: settings.transcribe,
        options: {
            initialValue: settings.initialValue ?? '',
            separator: settings.separator ?? '\n\n',
            capture: {mode: 'continuous'},
            persist: settings.persist ?? true,
            transcribe: settings.transcribe,
            onSave(input) {
                saved.push(input);
                return settings.onSave?.(input) ?? true;
            },
            onComplete(input) {
                completed.push(input);
                return settings.onComplete?.(input) ?? true;
            }
        }
    };
    const component = initializeVoice(ui, Is, appendTranscription, normalizeVoiceOptions);
    return {
        component, host, captures, saved, completed, events, errors,
        get output() { return transcriptElement.innerHTML; }
    };
}

test('live hypotheses use the existing output immediately and remain transient', async function testLiveOutput() {
    const fixture = createVoiceFixture({initialValue: 'Existing writing.'});
    assert.match(source, /<section id="transcript"[^>]*aria-live="polite"/u);
    assert.doesNotMatch(source, /id="interim"|interimElement/u);
    await fixture.component.start();
    const capture = fixture.captures[0];

    capture.interim('The dragon carries');
    assert.equal(fixture.output, 'Existing writing.\n\nThe dragon carries');
    assert.equal(fixture.host.value, 'Existing writing.');
    assert.deepEqual(fixture.saved, []);
    assert.deepEqual(fixture.events, []);

    capture.interim('The dragon carries tea.');
    assert.equal(fixture.output, 'Existing writing.\n\nThe dragon carries tea.');
    capture.segment('The dragon carries tea.', 1);
    assert.equal(fixture.output, 'Existing writing.\n\nThe dragon carries tea.');
    assert.equal(fixture.host.value, 'Existing writing.', 'Display precedes the queue microtask.');
    await fixture.component.settled();
    assert.equal(fixture.host.value, fixture.output);
    assert.equal(fixture.saved[0].transcript, fixture.output);
    assert.deepEqual(fixture.events.map(function eventName(event) { return event.type; }), [
        'speech-transcription-complete', 'voice-transcription-segment'
    ]);
    fixture.component.destroy();
});

test('later finals remain visible while the ordered first save waits and retries', async function testSaveOrdering() {
    const saving = deferred();
    const saveStarted = deferred();
    let attempts = 0;
    const fixture = createVoiceFixture({
        initialValue: 'Notes',
        separator: '\n',
        onSave(input) {
            attempts += 1;
            if (attempts === 1) {
                saveStarted.resolve();
                return saving.promise;
            }
            return true;
        }
    });
    await fixture.component.start();
    const capture = fixture.captures[0];
    capture.segment('First final.', 1);
    await saveStarted.promise;
    capture.segment('Second final.', 2);
    capture.segment('Third final.', 3);
    capture.interim('Still changing');
    assert.equal(fixture.output, 'Notes\nFirst final.\nSecond final.\nThird final.\nStill changing');
    assert.equal(fixture.host.value, 'Notes\nFirst final.');
    assert.equal(fixture.saved.length, 1);
    assert.equal(fixture.saved[0].transcript, 'Notes\nFirst final.');
    assert.deepEqual(fixture.events, []);

    saving.reject(new Error('Synthetic save failure.'));
    await fixture.component.settled();
    assert.equal(fixture.output, 'Notes\nFirst final.\nSecond final.\nThird final.\nStill changing');
    assert.equal(fixture.component.session.failure.phase, 'save');
    assert.equal(fixture.component.retry(), true);
    await fixture.component.settled();
    assert.deepEqual(fixture.saved.map(function saveText(input) { return input.transcript; }), [
        'Notes\nFirst final.',
        'Notes\nFirst final.',
        'Notes\nFirst final.\nSecond final.',
        'Notes\nFirst final.\nSecond final.\nThird final.'
    ]);
    assert.equal(fixture.host.value, 'Notes\nFirst final.\nSecond final.\nThird final.');
    assert.equal(fixture.output, fixture.host.value + '\nStill changing');
    assert.deepEqual(fixture.events.filter(function success(event) {
        return event.type === 'voice-transcription-segment';
    }).map(function sequence(event) { return event.detail.sequence; }), [1, 2, 3]);
    fixture.component.destroy();
});

test('completion drains the stop final while hypotheses never enter completion', async function testStopFlush() {
    const saving = deferred();
    const saveStarted = deferred();
    const fixture = createVoiceFixture({
        onSave() { saveStarted.resolve(); return saving.promise; },
        onStop(capture) { capture.segment('Complete final.', 1); capture.finish(); }
    });
    await fixture.component.start();
    const capture = fixture.captures[0];
    capture.interim('Incomplete hypothesis');
    const completion = fixture.component.complete();
    assert.equal(fixture.output, 'Complete final.');
    await saveStarted.promise;
    assert.deepEqual(fixture.completed, []);
    saving.resolve(true);
    assert.equal(await completion, true);
    assert.equal(fixture.completed[0].transcript, 'Complete final.');
    assert.equal(fixture.output, 'Complete final.');
    assert.equal(capture.starts, 1);
    assert.equal(capture.stops, 1);
    fixture.component.destroy();
});

test('cancel clears projected pending text and ignores late capture and save callbacks', async function testCancellation() {
    const saving = deferred();
    const saveStarted = deferred();
    const fixture = createVoiceFixture({
        onSave() { saveStarted.resolve(); return saving.promise; }
    });
    await fixture.component.start();
    const capture = fixture.captures[0];
    capture.segment('Already appended.', 1);
    await saveStarted.promise;
    capture.segment('Queued final.', 2);
    capture.interim('Changing hypothesis');
    const worker = fixture.component.session.worker;
    assert.equal(fixture.output, 'Already appended.\n\nQueued final.\n\nChanging hypothesis');
    assert.equal(fixture.component.cancel(), true);
    await worker;
    assert.equal(fixture.output, 'Already appended.');
    capture.segment('Late final.', 3);
    capture.interim('Late hypothesis');
    saving.resolve(true);
    await saving.promise;
    assert.equal(fixture.output, 'Already appended.');
    assert.equal(fixture.host.value, 'Already appended.');
    assert.equal(fixture.saved.length, 1);
    assert.deepEqual(fixture.events.map(function eventName(event) { return event.type; }), [
        'speech-transcription-cancelled'
    ]);
    fixture.component.destroy();
});

test('public transcript replacement preserves user edits across late saves and a new session', async function testTranscriptReplacement() {
    const saving = deferred();
    const saveStarted = deferred();
    const fixture = createVoiceFixture({
        onSave() {
            if (fixture.saved.length === 1) {
                saveStarted.resolve();
                return saving.promise;
            }
            return true;
        }
    });
    await fixture.component.start();
    const oldCapture = fixture.captures[0];
    oldCapture.segment('Old final.', 1);
    await saveStarted.promise;
    oldCapture.segment('Queued old final.', 2);
    oldCapture.interim('Old hypothesis');
    const worker = fixture.component.session.worker;
    fixture.host.value = '**User-edited writing.**\nComplete replacement.';
    await worker;
    assert.equal(fixture.output, fixture.host.value);
    assert.equal(fixture.host.value, '**User-edited writing.**\nComplete replacement.');
    assert.equal(fixture.saved[0].transcript, 'Old final.');
    await fixture.component.start();
    const newCapture = fixture.captures[1];
    oldCapture.segment('Stale final.', 3);
    oldCapture.interim('Stale hypothesis');
    newCapture.interim('New words');
    saving.resolve(true);
    await saving.promise;
    assert.equal(fixture.output, '**User-edited writing.**\nComplete replacement.\n\nNew words');
    assert.equal(fixture.host.value, '**User-edited writing.**\nComplete replacement.');
    newCapture.segment('New final.', 1);
    await fixture.component.settled();
    assert.equal(fixture.saved[1].transcript, '**User-edited writing.**\nComplete replacement.\n\nNew final.');
    fixture.component.destroy();
});

test('capture interruption removes interim text while retaining ordered final output', async function testInterruption() {
    const saving = deferred();
    const saveStarted = deferred();
    const fixture = createVoiceFixture({
        onSave() {
            if (fixture.saved.length === 1) {
                saveStarted.resolve();
                return saving.promise;
            }
            return true;
        }
    });
    await fixture.component.start();
    const capture = fixture.captures[0];
    capture.segment('First final.', 1);
    await saveStarted.promise;
    capture.segment('Next final.', 2);
    capture.interim('Unfinished');
    capture.fail(new Error('Synthetic recognition interruption.'));
    assert.equal(fixture.output, 'First final.\n\nNext final.');
    saving.resolve(true);
    await fixture.component.settled();
    assert.equal(fixture.output, 'First final.\n\nNext final.');
    assert.equal(fixture.host.value, fixture.output);
    assert.equal(capture.starts, 1);
    fixture.component.destroy();
});

test('destroy removes transient projection and rejects late recognition', async function testDestroy() {
    const fixture = createVoiceFixture({initialValue: 'Retained writing.', persist: false});
    await fixture.component.start();
    const capture = fixture.captures[0];
    capture.interim('Temporary words');
    assert.equal(fixture.output, 'Retained writing.\n\nTemporary words');
    fixture.component.destroy();
    capture.interim('Late words');
    capture.segment('Late final.', 1);
    assert.equal(fixture.output, 'Retained writing.');
    assert.equal(fixture.host.value, 'Retained writing.');
    assert.equal(capture.cancels, 1);
});

test('custom audio transcription retains its route and displays only returned text', async function testAudioRoute() {
    const result = deferred();
    const requested = deferred();
    const requests = [];
    const fixture = createVoiceFixture({
        initialValue: 'Existing audio notes.',
        transcribe(file, context, signal) {
            requests.push({file, context, signal});
            requested.resolve();
            return result.promise;
        }
    });
    await fixture.component.start();
    const capture = fixture.captures[0];
    assert.equal(fixture.component.session.native, false);
    capture.callbacks.onSegment({
        audio: new Blob(['Synthetic audio fixture.'], {type: 'audio/wav'}),
        sequence: 1
    });
    await requested.promise;
    assert.equal(fixture.output, 'Existing audio notes.');
    assert.equal(requests[0].file.name, 'segment-1.wav');
    assert.equal(requests[0].context.transcript, 'Existing audio notes.');
    assert.deepEqual(fixture.saved, []);
    result.resolve('Complete audio transcription.');
    await fixture.component.settled();
    assert.equal(fixture.output, 'Existing audio notes.\n\nComplete audio transcription.');
    assert.equal(fixture.host.value, fixture.output);
    assert.equal(fixture.saved[0].transcript, fixture.output);
    fixture.component.destroy();
});
