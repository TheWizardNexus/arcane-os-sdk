import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Is from 'strong-type';

import test from '../src/testing.mjs';
import {getBrowserDeviceClass} from '../browser-runtime/browser-device.mjs';

const source = await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
);

function componentSection(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, startMarker);
    assert.ok(end > start, endMarker);
    return source.slice(start, end);
}

// Execute the component's actual input listeners, resize, submission, and
// cancellation ownership. DOM layout, rendering, and provider delivery are
// explicit doubles; native keyboard insertion requires browser evidence.
const initializeInput = Function(
    'ui',
    'getBrowserDeviceClass',
    `'use strict';
    const {
        host, textArea, send, speech, chatOutput, is, dispatchChatEvent,
        appendTranscriptMessage, observeHostSubmission,
        trackTranscriptScrollPosition, scrollTranscriptToBottom
    } = ui;
    ${componentSection('    const browserDeviceClass =', '\n\n')}
    const aiRuntimeStateAbortController = new AbortController();
    const activeSubmissionOwnerships = new Set();
    const boundChatAI = {};
    const boundChatSession = null;
    const destroyed = false;
    let recognitionDraft = null;
    let writingRecognitionDraft = false;
    const sessionBindingPending = false;
    const sessionMessagePending = false;
    const pendingStructuralToolMessage = '';
    const sessionHistoryRecoveryMessage = '';
    let hostSubmissionGeneration = 0;
    let transcriptScrollTop = 0;
    let operationSequence = 0;
    const chatErrorCodes = {messageSubmissionAborted: 'ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED'};
    const chatReasons = {
        componentDestroyed: 'component-destroyed',
        callerSignalAborted: 'caller-signal-aborted',
        messageSubmissionRequested: 'message-submission-requested',
        messageSubmissionCancelled: 'message-submission-cancelled'
    };
    function nextChatOperationId() {
        operationSequence += 1;
        return 'input:' + operationSequence;
    }
    ${componentSection('    function isAbortSignal(', '\n    host.sendMessage=')}
    ${componentSection('    async function submitMessage(', '\n\n    function receivedMessage')}
    ${componentSection('    function handleChatKeyDown(', '\n\n    function renderSessionMessageFailure')}
    ${componentSection('    textArea.addEventListener(', '\n\n    uploadBtn.addEventListener(')}
    return {
        submit: submitMessage,
        controller: aiRuntimeStateAbortController,
        activeSubmissionOwnerships
    };`
);

function createInputFixture(navigatorObject = {}) {
    const sent = [];
    const events = [];
    const pending = [];
    const layout = [];
    const textArea = Object.assign(
        new EventTarget(),
        {value: '', style: {}, scrollHeight: 80}
    );
    const send = Object.assign(
        new EventTarget(),
        {disabled: false}
    );
    const host = {
        name: 'User',
        conversationComplete: false,
        aiAvailability: {llm: true, tts: false},
        sendMessage(text, context) {
            sent.push(
                {text, context}
            );
            return true;
        }
    };
    const ui = {
        host,
        textArea,
        send,
        speech: {},
        chatOutput: {scrollTop: 240},
        is: new Is(false),
        accepted: true,
        dispatchChatEvent(type, detail) {
            events.push(
                {type, detail}
            );
            return ui.accepted;
        },
        appendTranscriptMessage(role, text, name) {
            return {role, text, name, dataset: {}};
        },
        observeHostSubmission(result, context, ownership) {
            const completion = Promise.resolve(result).finally(ownership.release);
            pending.push(completion);
            return completion;
        },
        trackTranscriptScrollPosition() {
            layout.push('track');
        },
        scrollTranscriptToBottom() {
            layout.push('scroll');
        }
    };
    function classifyFixtureDevice() {
        return getBrowserDeviceClass(navigatorObject);
    }
    return {
        ui,
        host,
        textArea,
        send,
        sent,
        events,
        pending,
        layout,
        ...initializeInput(ui, classifyFixtureDevice)
    };
}

function keyEvent(fixture, options = {}, type = 'keydown') {
    const event = Object.assign(
        new Event(
            type,
            {cancelable: true}
        ),
        {key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, repeat: false},
        options
    );
    fixture.textArea.dispatchEvent(event);
    return event;
}

test(
    'desktop Enter submits the exact draft once before native insertion',
    async function submitDesktopDraft() {
        const fixture = createInputFixture(
            {platform: 'Win32', userAgent: 'Desktop browser'}
        );
        const draft = '  Octopus board meeting.\nBring all eight pens.  ';
        fixture.textArea.value = draft;
        assert.equal(keyEvent(fixture).defaultPrevented, true);
        assert.equal(fixture.sent.length, 1);
        assert.equal(fixture.sent[0].text, draft);
        assert.equal(fixture.sent[0].context.source, 'keyboard');
        assert.equal(fixture.events[0].detail.message, draft);
        assert.equal(fixture.textArea.value, '');
        assert.equal(fixture.textArea.style.height, '80px');
        const repeated = keyEvent(
            fixture,
            {repeat: true}
        );
        assert.equal(repeated.defaultPrevented, true);
        keyEvent(fixture, undefined, 'keyup');
        assert.equal(fixture.sent.length, 1);
        await Promise.all(fixture.pending);
        assert.equal(fixture.activeSubmissionOwnerships.size, 0);
        fixture.controller.abort();
    }
);

test(
    'mobile and tablet Enter preserve native multiline editing and the Send button',
    async function preserveMobileNewlines() {
        const devices = [
            {userAgentData: {mobile: true, platform: 'Android'}},
            {userAgent: 'Mozilla/5.0 (Linux; Android 14; Tablet)'},
            {userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18)'},
            {platform: 'iPad'},
            {platform: 'MacIntel', maxTouchPoints: 5}
        ];
        for(const device of devices) {
            const fixture = createInputFixture(device);
            fixture.textArea.value = 'Octopus roll call.';
            assert.equal(keyEvent(fixture).defaultPrevented, false);
            keyEvent(fixture, undefined, 'keyup');
            assert.equal(fixture.sent.length, 0);
            assert.equal(fixture.textArea.value, 'Octopus roll call.');

            // Model the browser's completed edit, not native keyboard behavior.
            const draft = 'Octopus roll call.\n  Eight arms present.  ';
            fixture.textArea.value = draft;
            fixture.textArea.scrollHeight = 120;
            fixture.textArea.dispatchEvent(new Event('input'));
            assert.equal(fixture.textArea.value, draft);
            assert.equal(fixture.textArea.style.height, '120px');
            assert.deepEqual(
                fixture.layout,
                ['track', 'scroll']
            );
            assert.equal(fixture.sent.length, 0);

            fixture.send.dispatchEvent(new Event('click'));
            assert.equal(fixture.sent.length, 1);
            assert.equal(fixture.sent[0].text, draft);
            assert.equal(fixture.sent[0].context.source, 'user');
            await Promise.all(fixture.pending);
            fixture.controller.abort();
        }
    }
);

test(
    'Shift Enter and composition confirmation never submit a desktop draft',
    function preserveCompositionAndShift() {
        const fixture = createInputFixture();
        const draft = '  会議の議題\nEight pens.  ';
        fixture.textArea.value = draft;
        for(const options of [
            {shiftKey: true},
            {isComposing: true},
            {isComposing: false, keyCode: 229},
            {key: 'Process', keyCode: 229},
            {key: 'a', keyCode: 65}
        ]) {
            assert.equal(keyEvent(fixture, options).defaultPrevented, false);
            keyEvent(fixture, undefined, 'keyup');
            assert.equal(fixture.sent.length, 0);
            assert.equal(fixture.textArea.value, draft);
        }
        fixture.controller.abort();
    }
);

test(
    'input-only edits resize without submitting and abort removes the input listeners',
    function resizeInputAndReleaseListeners() {
        const fixture = createInputFixture();
        const draft = '  Pasted agenda.\nDictated roll call.\n  ';
        fixture.textArea.value = draft;
        fixture.textArea.scrollHeight = 160;
        fixture.textArea.dispatchEvent(new Event('input'));
        assert.equal(fixture.textArea.style.height, '160px');
        assert.equal(fixture.textArea.value, draft);
        assert.deepEqual(
            fixture.layout,
            ['track', 'scroll']
        );
        assert.equal(fixture.sent.length, 0);

        fixture.controller.abort();
        fixture.textArea.scrollHeight = 200;
        fixture.textArea.dispatchEvent(new Event('input'));
        assert.equal(keyEvent(fixture).defaultPrevented, false);
        fixture.send.dispatchEvent(new Event('click'));
        assert.equal(fixture.textArea.style.height, '160px');
        assert.equal(fixture.textArea.value, draft);
        assert.equal(fixture.sent.length, 0);
    }
);

test(
    'keyboard submission retains disabled, completed, cancellation, and programmatic boundaries',
    async function preserveSubmissionBoundaries() {
        const fixture = createInputFixture();
        const draft = '  Keep the entire octopus agenda.\n  ';
        fixture.textArea.value = draft;
        fixture.send.disabled = true;
        assert.equal(keyEvent(fixture).defaultPrevented, false);
        assert.equal(fixture.sent.length, 0);
        fixture.send.disabled = false;

        fixture.host.conversationComplete = true;
        keyEvent(fixture);
        assert.equal(fixture.sent.length, 0);
        assert.equal(fixture.events.length, 0);
        assert.equal(fixture.textArea.value, draft);
        fixture.host.conversationComplete = false;

        fixture.ui.accepted = false;
        keyEvent(fixture);
        assert.equal(fixture.sent.length, 0);
        assert.equal(fixture.textArea.value, draft);
        assert.equal(fixture.events[0].detail.context.signal.aborted, true);
        assert.equal(fixture.activeSubmissionOwnerships.size, 0);

        fixture.ui.accepted = true;
        const controller = new AbortController();
        controller.abort();
        const cancelled = await fixture.submit(
            draft,
            {signal: controller.signal}
        );
        assert.equal(cancelled, false);
        assert.equal(fixture.sent.length, 0);

        const submitted = await fixture.submit(
            draft,
            {source: 'speech', preserveDraft: true}
        );
        assert.equal(submitted, true);
        assert.equal(fixture.sent[0].text, draft);
        assert.equal(fixture.sent[0].context.source, 'speech');
        assert.equal(fixture.textArea.value, draft);
        assert.equal(fixture.activeSubmissionOwnerships.size, 0);
        fixture.controller.abort();
    }
);
