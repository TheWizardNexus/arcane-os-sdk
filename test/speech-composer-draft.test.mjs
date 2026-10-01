import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';

const source = (await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
)).replaceAll('\r\n', '\n');

function componentSection(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, startMarker);
    assert.ok(end > start, endMarker);
    return source.slice(start, end);
}

// Exercise the actual shared completion listener and draft owner. Browser
// layout, native recognition, and provider submission are outside this fixture.
const initialize = Function(
    'fixture',
    `'use strict';
    const {host, speech, textArea, shadowRoot, sent, inputEvents} = fixture;
    const is = {string: function string(value) { return typeof value === 'string'; }};
    let destroyed = false;
    let recognitionDraft = null;
    let writingRecognitionDraft = false;
    const aiRuntimeStateAbortController = new AbortController();
    function submitMessage(text, context) { sent.push({text, context}); }
    ${componentSection('    host.language=host.language', '    host.name =')}
    ${componentSection('    function trackRecognitionDraftEdit(', '    async function resizeTextArea(')}
    ${componentSection("    speech.addEventListener(\n        'speech-transcription-progress',", "    shadowRoot.querySelector('#languages')")}
    textArea.addEventListener('input', trackRecognitionDraftEdit);
    textArea.addEventListener('input', function recordInput(event) {
        inputEvents.push({value: textArea.value, bubbles: event.bubbles, composed: event.composed});
    });
    return {
        appendDraft,
        destroy: function destroy() {
            destroyed = true;
            finishRecognitionDraft();
            aiRuntimeStateAbortController.abort();
        }
    };`
);

function createFixture(properties = {}) {
    const textArea = Object.assign(
        new EventTarget(),
        {
            value: '',
            selectionStart: 0,
            selectionEnd: 0,
            selectionDirection: 'none',
            setSelectionRange(start, end, direction) {
                this.selectionStart = start;
                this.selectionEnd = end;
                this.selectionDirection = direction;
            }
        }
    );
    const fixture = {
        host: {...properties},
        speech: new EventTarget(),
        textArea,
        shadowRoot: {activeElement: textArea},
        sent: [],
        inputEvents: []
    };
    Object.assign(fixture, initialize(fixture));
    return fixture;
}

function completeRecognition(fixture, text, operationId = 'recognition:1') {
    const event = new Event('speech-transcription-complete');
    Object.defineProperty(event, 'detail', {value: {text, operationId}});
    fixture.speech.dispatchEvent(event);
}

function progressRecognition(fixture, text, interim, operationId = 'recognition:1') {
    const event = new Event('speech-transcription-progress');
    Object.defineProperty(event, 'detail', {value: {text, interim, operationId}});
    fixture.speech.dispatchEvent(event);
}

function editDraft(fixture, value) {
    fixture.textArea.value = value;
    fixture.textArea.dispatchEvent(new Event('input'));
}

test(
    'live recognition updates the composer and completion does not append twice',
    function renderLiveRecognitionWithoutSending() {
        const fixture = createFixture({transcriptionMode: 'draft'});
        fixture.textArea.value = 'Typed agenda';
        progressRecognition(fixture, '', 'Tentative words');
        assert.equal(fixture.textArea.value, 'Typed agenda\nTentative words');
        progressRecognition(fixture, '', 'Corrected words');
        assert.equal(fixture.textArea.value, 'Typed agenda\nCorrected words');
        progressRecognition(fixture, 'Corrected words. ', 'More');
        assert.equal(fixture.textArea.value, 'Typed agenda\nCorrected words. More');
        progressRecognition(fixture, 'Corrected words. More arrived.', '');
        completeRecognition(fixture, 'Corrected words. More arrived.');
        assert.equal(fixture.textArea.value, 'Typed agenda\nCorrected words. More arrived.');
        assert.equal(fixture.sent.length, 0);
        assert.equal(fixture.speech.displayTranscription, false);
    }
);

test(
    'edits before and inside a live hypothesis survive later recognition',
    function preserveEditsDuringRecognition() {
        const fixture = createFixture({transcriptionMode: 'draft'});
        fixture.textArea.value = 'Agenda';
        progressRecognition(fixture, '', 'Wrong phrase');
        editDraft(fixture, 'Edited agenda\nWrong phrase');
        progressRecognition(fixture, '', 'Another hypothesis');
        assert.equal(fixture.textArea.value, 'Edited agenda\nAnother hypothesis');
        editDraft(fixture, 'Edited agenda\nHuman correction');
        progressRecognition(fixture, '', 'Provider correction');
        assert.equal(fixture.textArea.value, 'Edited agenda\nHuman correction');
        progressRecognition(fixture, 'Provider final.', 'Next phrase');
        assert.equal(fixture.textArea.value, 'Edited agenda\nHuman correction\nNext phrase');
        progressRecognition(fixture, 'Provider final.Next final.', '');
        completeRecognition(fixture, 'Provider final.Next final.');
        assert.equal(fixture.textArea.value, 'Edited agenda\nHuman correction\nNext final.');
        assert.equal(fixture.sent.length, 0);
    }
);

test(
    'cancellation removes only the unedited hypothesis and preserves final draft words',
    function cancelProvisionalRecognition() {
        const fixture = createFixture({transcriptionMode: 'draft'});
        fixture.textArea.value = 'Typed';
        progressRecognition(fixture, 'Final. ', 'Hypothesis');
        const event = new Event('speech-transcription-cancelled');
        Object.defineProperty(event, 'detail', {value: {operationId: 'recognition:1'}});
        fixture.speech.dispatchEvent(event);
        assert.equal(fixture.textArea.value, 'Typed\nFinal. ');
        progressRecognition(fixture, '', 'New provisional', 'recognition:2');
        fixture.destroy();
        assert.equal(fixture.textArea.value, 'Typed\nFinal. ');
        assert.equal(fixture.sent.length, 0);
    }
);

test(
    'terminal input observers cannot erase a newer recognition operation',
    function preserveReentrantDraftOwnership() {
        for (const terminal of ['cancel', 'complete']) {
            const fixture = createFixture({transcriptionMode: 'draft'});
            progressRecognition(fixture, 'First. ', 'Provisional', 'recognition:first');
            fixture.textArea.addEventListener('input', function startNextRecognition() {
                progressRecognition(fixture, 'Second. ', 'Pending', 'recognition:second');
            }, {once: true});
            if (terminal === 'complete') {
                completeRecognition(fixture, 'First. ', 'recognition:first');
            } else {
                const event = new Event('speech-transcription-cancelled');
                Object.defineProperty(event, 'detail', {value: {operationId: 'recognition:first'}});
                fixture.speech.dispatchEvent(event);
            }
            progressRecognition(fixture, 'Second. Finished.', '', 'recognition:second');
            completeRecognition(fixture, 'Second. Finished.', 'recognition:second');
            assert.equal(fixture.textArea.value, 'First. Second. Finished.');
            assert.equal(fixture.sent.length, 0);
            fixture.destroy();
        }
    }
);

test(
    'draft transcription preserves current edits and never submits on completion',
    function preserveEditableRecognition() {
        const fixture = createFixture();
        // Apps may select draft mode after component readiness.
        fixture.host.transcriptionMode = 'draft';
        fixture.textArea.value = 'My edited agenda';
        fixture.textArea.setSelectionRange(3, 9, 'backward');
        completeRecognition(fixture, 'The octopus chairs this meeting.  ');
        assert.equal(
            fixture.textArea.value,
            'My edited agenda\nThe octopus chairs this meeting.  '
        );
        assert.equal(fixture.sent.length, 0);
        assert.deepEqual(
            [fixture.textArea.selectionStart, fixture.textArea.selectionEnd, fixture.textArea.selectionDirection],
            [3, 9, 'backward']
        );
        assert.equal(fixture.inputEvents.length, 1);
        assert.equal(fixture.inputEvents[0].bubbles, true);
        assert.equal(fixture.inputEvents[0].composed, true);

        fixture.textArea.value = 'Human revision.\n';
        completeRecognition(fixture, '  Keep every spoken space.\n');
        assert.equal(fixture.textArea.value, 'Human revision.\n  Keep every spoken space.\n');
        assert.equal(fixture.sent.length, 0);
    }
);

test(
    'default transcription submission remains compatible and language is independent',
    function preserveExistingConsumers() {
        const fixture = createFixture({language: 'american-spanish', recognitionLanguage: 'es-MX'});
        assert.equal(fixture.host.transcriptionMode, 'submit');
        assert.equal(fixture.speech.recognitionLanguage, 'es-MX');
        fixture.host.recognitionLanguage = 'en-GB';
        assert.equal(fixture.speech.recognitionLanguage, 'en-GB');
        fixture.speech.recognitionLanguage = 'fr-CA';
        assert.equal(fixture.host.recognitionLanguage, 'fr-CA');
        assert.equal(fixture.host.language, 'american-spanish');
        completeRecognition(fixture, '  Complete spoken input.\n');
        assert.deepEqual(
            fixture.sent,
            [{text: '  Complete spoken input.\n', context: {source: 'speech'}}]
        );
    }
);

test(
    'draft append preserves whitespace and stops after destruction',
    function retainCompleteDraftAndLifetime() {
        const fixture = createFixture({transcriptionMode: 'draft'});
        assert.equal(fixture.appendDraft(''), false);
        assert.equal(fixture.appendDraft('  \n'), true);
        assert.equal(fixture.textArea.value, '  \n');
        fixture.destroy();
        assert.equal(fixture.appendDraft('late'), false);
        completeRecognition(fixture, 'late final');
        assert.equal(fixture.textArea.value, '  \n');
        assert.equal(fixture.sent.length, 0);
        assert.match(source, /host\.appendDraft=appendDraft;/);
    }
);
