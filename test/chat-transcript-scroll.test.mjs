import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

const source = await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
);
const historyStart = source.indexOf('    function renderSessionHistory(history){');
const historyEnd = source.indexOf('\n    async function bindSession(', historyStart);
assert.notEqual(historyStart, -1);
assert.notEqual(historyEnd, -1);

// Exercise the actual restoration function with record-only DOM substitutes.
const initializeHistory = Function('host', `'use strict';
    const is = {array: Array.isArray, string: value => typeof value === 'string'};
    const isPlainRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    let sessionHistoryRecoveryMessage = '';
    let transcriptFollowing = false;
    let transcriptScrollTop = 0;
    const chatOutput = {
        scrollTop: 0,
        children: [],
        ownerDocument: {
            createDocumentFragment() {
                return {children: [], append(item) {this.children.push(item);}};
            }
        },
        replaceChildren(fragment) {this.children = fragment.children;}
    };
    function normalizeVisibleToolCalls(calls) {return calls ?? [];}
    function setPendingStructuralToolCalls() {}
    function scrollTranscriptToBottom() {}
    function createTranscriptMessage(role, content, name, options) {
        return {role, content, name, ...options};
    }
    function chatError(message, code) {return Object.assign(new Error(message), {code});}
    const arcaneLogging = {error(message, error) {throw error;}};
    function createSavedRecordFallback() {throw new Error('Unexpected saved-record fallback.');}
    ${source.slice(historyStart, historyEnd)}
    return {render: renderSessionHistory, chatOutput};
`);

test('chat history restores exact saved assistant names without current-name inference', function restoreSavedNames() {
    const host = {name: 'Current user', aiName: 'Current assistant is different'};
    const fixture = initializeHistory(host);
    const history = [
        {role: 'assistant', content: 'Complete named reply.\nSecond line.', name: '  Orbit / 🐙  ', timestamp: 1},
        {role: 'assistant', content: 'Older nameless reply.', timestamp: 2},
        {role: 'assistant', content: 'Blank saved name.', name: ' \n\t ', timestamp: 3},
        {role: 'assistant', content: 'Nonstrings are not display names.', name: 42, timestamp: 4},
        {role: 'assistant', content: 'Null is not a display name.', name: null, timestamp: 5},
        {role: 'user', content: 'User content.', name: 'Saved user metadata', timestamp: 6},
        {role: 'tool', content: 'Complete tool message.', name: 'lookup', status: 'completed', timestamp: 7},
        {role: 'system', content: 'Existing system record.', timestamp: 8},
    ];
    const original = structuredClone(history);
    const rendered = fixture.render(history);
    assert.deepEqual(rendered.map(message => message.name),
        ['  Orbit / 🐙  ', 'AI', 'AI', 'AI', 'AI', 'Current user', 'Tool · lookup', 'System']);
    assert.deepEqual(rendered.map(message => message.content), history.map(message => message.content));
    assert.deepEqual(rendered.map(message => message.timestamp), history.map(message => message.timestamp));
    host.aiName = 'Another future assistant';
    assert.deepEqual(fixture.render(history), rendered);
    assert.deepEqual(history, original);
});

const scrollStart = source.indexOf('    let transcriptFollowing = true;');
const scrollEnd = source.indexOf('\n\n    function transcriptTime', scrollStart);
const visibilityStart = source.indexOf('        if(!conversationVisible && !host.conversationComplete)');
const visibilityEnd = source.indexOf('        send.disabled=', visibilityStart);
const resizeStart = source.indexOf('    async function resizeTextArea(');
const resizeEnd = source.indexOf('\n\n    function renderSessionMessageFailure', resizeStart);
const ownershipStart = source.indexOf('    function isAbortSignal(');
const ownershipEnd = source.indexOf('\n    host.sendMessage=', ownershipStart);
const submissionStart = source.indexOf('    async function submitMessage(');
const submissionEnd = source.indexOf('\n\n    function receivedMessage', submissionStart);
const restoreStart = source.indexOf('\n    function restoreFromPageCache(){');
const destroyStart = source.indexOf('\n    function destroy(){');
const destroyEnd = source.indexOf('        aiActivationController.destroy();', destroyStart);
for(const boundary of [scrollStart, scrollEnd, visibilityStart, visibilityEnd, resizeStart, resizeEnd, ownershipStart, ownershipEnd, submissionStart, submissionEnd, restoreStart, destroyStart, destroyEnd]) {
    assert.notEqual(boundary, -1);
}

// Execute the component's scrolling and terminal cleanup against explicit layout
// measurements. Native layout and observer scheduling remain browser evidence.
const initializeScrolling = Function(
    'chatOutput',
    'ResizeObserver',
    'MutationObserver',
    'textArea',
    `'use strict';
    const globalThis = {ResizeObserver, MutationObserver};
    const is = {
        function: function isFunction(value) {
            return typeof value === 'function';
        },
        string: function isString(value) {
            return typeof value === 'string';
        },
        object: function isObject(value) {
            return typeof value === 'object';
        },
        boolean: function isBoolean(value) {
            return typeof value === 'boolean';
        },
        array: Array.isArray
    };
    let destroyed = false;
    let sessionBindingGeneration = 0;
    let hostSubmissionGeneration = 0;
    let submissionSequence = 0;
    const sessionBindingPending = false;
    const sessionMessagePending = false;
    const pendingStructuralToolMessage = '';
    const sessionHistoryRecoveryMessage = '';
    const boundChatSession = null;
    const boundChatAI = null;
    const aiRuntimeStateAbortController = new AbortController();
    const activeSubmissionOwnerships = new Set();
    const chatReasons = {
        componentDestroyed: 'component-destroyed',
        callerSignalAborted: 'caller-signal-aborted',
        messageSubmissionRequested: 'message-submission-requested',
        messageSubmissionCancelled: 'message-submission-cancelled'
    };
    const chatErrorCodes = {messageSubmissionAborted: 'ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED'};
    const submission = {accepted: true, events: [], sent: [], onDispatch: null, onSend: null};
    const host = {
        name: 'User',
        conversationComplete: false,
        aiAvailability: {llm: true, tts: false},
        sendMessage(text, context) {
            const request = {text, context};
            submission.sent.push(request);
            submission.onSend?.(request);
            return true;
        }
    };
    const chatArea = {dataset: {}};
    function setSessionStatus() {}
    function finishRecognitionDraft() {}
    function setAIAvailability() {}
    function nextChatOperationId(kind) {
        submissionSequence += 1;
        return kind + ':' + submissionSequence;
    }
    function dispatchChatEvent(type, detail, options) {
        submission.events.push(
            {type, detail, options}
        );
        submission.onDispatch?.(detail);
        return submission.accepted;
    }
    function appendTranscriptMessage(role, text, name) {
        const item = {localName: 'li', dataset: {role}, text, name, parentElement: chatOutput};
        chatOutput.children.push(item);
        chatOutput.scrollHeight += 240;
        scrollTranscriptToBottom();
        return item;
    }
    function observeHostSubmission(result, context, ownership) {
        return Promise.resolve(result).finally(ownership.release);
    }
    ${source.slice(scrollStart, scrollEnd)}
    ${source.slice(resizeStart, resizeEnd)}
    ${source.slice(ownershipStart, ownershipEnd)}
    ${source.slice(submissionStart, submissionEnd)}
    ${source.slice(restoreStart, destroyStart)}
    ${source.slice(destroyStart, destroyEnd)}
        return true;
    }
    return {
        scroll: scrollTranscriptToBottom,
        resize: resizeTextArea,
        submit: submitMessage,
        submission,
        host,
        restore: restoreFromPageCache,
        destroy,
        signal: aiRuntimeStateAbortController.signal,
        setConversationVisible: function setConversationVisible(conversationVisible) {
            ${source.slice(visibilityStart, visibilityEnd)}
        }
    };`
);

function createScrollFixture(cards = []) {
    let resizeObserver;
    let mutationObserver;

    class TranscriptViewport extends EventTarget {
        #scrollTop = 0;
        clientHeight = 400;
        scrollHeight = 1600;
        children = cards;

        get scrollTop() {
            return this.#scrollTop;
        }

        set scrollTop(value) {
            this.#scrollTop = Math.min(
                Math.max(0, value),
                Math.max(0, this.scrollHeight - this.clientHeight)
            );
        }
    }

    class TranscriptResizeObserver {
        observed = new Map();
        disconnected = false;

        constructor(callback) {
            this.callback = callback;
            resizeObserver = this;
        }

        observe(target, options) {
            this.observed.set(target, options);
        }

        unobserve(target) {
            this.observed.delete(target);
        }

        disconnect() {
            this.disconnected = true;
            this.observed.clear();
        }

        deliver() {
            this.callback([]);
        }
    }

    class TranscriptMutationObserver {
        disconnected = false;

        constructor(callback) {
            this.callback = callback;
            mutationObserver = this;
        }

        observe(target, options) {
            this.target = target;
            this.options = options;
        }

        disconnect() {
            this.disconnected = true;
            this.target = null;
        }

        deliver(records) {
            this.callback(records);
        }
    }

    const viewport = new TranscriptViewport();
    const textArea = {value: '', scrollHeight: 80, style: {height: ''}};
    for(const card of cards) {
        card.parentElement = viewport;
    }
    const scrolling = initializeScrolling(
        viewport,
        TranscriptResizeObserver,
        TranscriptMutationObserver,
        textArea
    );
    return {viewport, textArea, resizeObserver, mutationObserver, ...scrolling};
}

test(
    'chat follows delayed card growth and viewport resizing to the actual bottom',
    function followLayoutChanges() {
        const card = {localName: 'li'};
        const fixture = createScrollFixture(
            [card]
        );
        assert.deepEqual(
            fixture.resizeObserver.observed.get(card),
            {box: 'border-box'}
        );
        assert.deepEqual(
            fixture.resizeObserver.observed.get(fixture.viewport),
            {box: 'border-box'}
        );
        assert.equal(fixture.scroll(), true);
        assert.equal(fixture.viewport.scrollTop, 1200);

        fixture.viewport.scrollHeight = 2000;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1600);

        fixture.viewport.clientHeight = 250;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1750);

        fixture.viewport.clientHeight = 700;
        fixture.viewport.scrollTop = fixture.viewport.scrollTop;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1300);
        fixture.destroy();
    }
);

test(
    'chat follows synchronous send status and later composer layout changes',
    function followSendAndComposerLayout() {
        const fixture = createScrollFixture();
        fixture.scroll();

        // Submission appends the user card and scrolls before the host shows status.
        fixture.viewport.scrollHeight = 1840;
        fixture.scroll();
        assert.equal(fixture.viewport.scrollTop, 1440);
        fixture.viewport.clientHeight = 300;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1540);

        // Hiding status expands the flex viewport and clamps its scroll position.
        fixture.viewport.clientHeight = 400;
        fixture.viewport.scrollTop = fixture.viewport.scrollTop;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1440);

        fixture.viewport.clientHeight = 260;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1580);

        fixture.viewport.scrollTop = 700;
        fixture.viewport.clientHeight = 220;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 700);
        fixture.viewport.clientHeight = 400;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 700);
        fixture.destroy();
    }
);

test(
    'chat retains reader intent across intermediate composer height clamping',
    async function preserveComposerResizeIntent() {
        for(const readerAway of [false, true]) {
            const fixture = createScrollFixture();
            fixture.scroll();
            if(readerAway) fixture.viewport.scrollTop = 700;
            Object.defineProperty(
                fixture.textArea.style,
                'height',
                {
                    set(height) {
                        fixture.viewport.clientHeight = height === 'auto' ? 500 : 320;
                        fixture.viewport.scrollTop = fixture.viewport.scrollTop;
                    }
                }
            );
            const resize = fixture.resize();
            assert.equal(fixture.viewport.scrollTop, readerAway ? 700 : 1280);
            await resize;
            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, readerAway ? 700 : 1280);
            fixture.destroy();
        }
    }
);

test(
    'chat preserves reader-away intent when layout clamps the position to the bottom',
    function preserveReaderAwayAfterLayoutClamp() {
        for(const layout of ['viewport-growth', 'content-shrink']) {
            for(const delivery of ['resize-first', 'scroll-first']) {
                const fixture = createScrollFixture();
                fixture.scroll();
                fixture.viewport.scrollTop = 1000;
                fixture.viewport.dispatchEvent(new Event('scroll'));

                if(layout === 'viewport-growth') {
                    fixture.viewport.clientHeight = 700;
                } else {
                    fixture.viewport.scrollHeight = 1300;
                }
                fixture.viewport.scrollTop = fixture.viewport.scrollTop;
                assert.equal(fixture.viewport.scrollTop, 900);
                if(delivery === 'resize-first') {
                    fixture.resizeObserver.deliver();
                    fixture.viewport.dispatchEvent(new Event('scroll'));
                } else {
                    fixture.viewport.dispatchEvent(new Event('scroll'));
                    fixture.resizeObserver.deliver();
                }
                assert.equal(fixture.scroll(), false);

                fixture.viewport.scrollHeight += 400;
                fixture.resizeObserver.deliver();
                assert.equal(fixture.viewport.scrollTop, 900);

                fixture.viewport.scrollTop = 1300;
                fixture.viewport.dispatchEvent(new Event('scroll'));
                fixture.viewport.scrollHeight += 200;
                fixture.resizeObserver.deliver();
                assert.equal(fixture.viewport.scrollTop, 1500);
                fixture.destroy();
            }
        }
    }
);

test(
    'accepted user sends and retries resume following from earlier transcript content',
    async function resumeFollowingOnAcceptedUserSubmission() {
        for(const retry of [false, true]) {
            const existing = {localName: 'li', dataset: {role: 'user'}};
            const cards = retry ? [existing] : [];
            const fixture = createScrollFixture(cards);
            fixture.scroll();
            fixture.viewport.scrollTop = 900;
            fixture.viewport.dispatchEvent(
                new Event('scroll')
            );
            fixture.submission.onSend = function showSubmissionStatus() {
                fixture.viewport.clientHeight = 300;
            };
            const text = '  Please continue.\nKeep this complete text.  ';
            fixture.textArea.value = text;
            const context = retry
                ? {source: 'user-retry', reuseVisibleMessage: true}
                : {source: 'user'};
            const pending = fixture.submit('', context);
            assert.equal(fixture.viewport.scrollTop, retry ? 1200 : 1440);
            assert.equal(fixture.viewport.children.length, 1);
            assert.equal(fixture.submission.sent.length, 1);
            assert.equal(fixture.submission.sent[0].text, text);
            assert.equal(fixture.submission.events[0].detail.message, text);
            assert.equal(fixture.textArea.value, '');
            assert.equal(await pending, true);

            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, retry ? 1300 : 1540);
            fixture.viewport.scrollHeight += 400;
            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, retry ? 1700 : 1940);
            fixture.destroy();
        }
    }
);

test(
    'accepted user submissions resume following after the transcript becomes visible',
    async function resumeAcceptedSubmissionFromHiddenTranscript() {
        const fixture = createScrollFixture();
        fixture.scroll();
        fixture.viewport.scrollTop = 900;
        fixture.viewport.dispatchEvent(
            new Event('scroll')
        );
        fixture.viewport.clientHeight = 0;
        fixture.viewport.scrollTop = 0;
        fixture.resizeObserver.deliver();
        const result = await fixture.submit('Continue when the view returns.');
        assert.equal(result, true);
        assert.equal(fixture.viewport.scrollTop, 0);
        assert.equal(fixture.submission.sent.length, 1);

        fixture.viewport.clientHeight = 400;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1440);
        fixture.destroy();
    }
);

test(
    'unaccepted user submissions preserve reader position and draft',
    async function preserveReaderOnUnacceptedSubmission() {
        for(const reason of ['cancelled', 'pre-aborted', 'destroyed', 'unavailable', 'abort-during-dispatch', 'destroy-during-dispatch']) {
            const fixture = createScrollFixture();
            fixture.scroll();
            fixture.viewport.scrollTop = 900;
            fixture.viewport.dispatchEvent(
                new Event('scroll')
            );
            const text = '  Keep my unsent draft.\nAll of it.  ';
            fixture.textArea.value = text;
            const caller = new AbortController();
            if(reason === 'cancelled') fixture.submission.accepted = false;
            if(reason === 'pre-aborted') {
                caller.abort(
                    new Error('Cancelled before submission.')
                );
            }
            if(reason === 'destroyed') fixture.destroy();
            if(reason === 'unavailable') fixture.host.aiAvailability.llm = false;
            if(reason === 'abort-during-dispatch') {
                fixture.submission.onDispatch = function abortBeforeHostCallback() {
                    caller.abort(
                        new Error('Cancelled during submission dispatch.')
                    );
                };
            }
            if(reason === 'destroy-during-dispatch') {
                fixture.submission.onDispatch = function destroyBeforeHostCallback() {
                    fixture.destroy();
                };
            }
            const result = await fixture.submit(
                '',
                {source: 'user', signal: caller.signal}
            );
            assert.equal(result, false, reason);
            assert.equal(fixture.viewport.scrollTop, 900, reason);
            assert.equal(fixture.viewport.children.length, 0, reason);
            assert.equal(fixture.submission.sent.length, 0, reason);
            assert.equal(fixture.textArea.value, text, reason);

            fixture.viewport.scrollHeight += 400;
            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, 900, reason);
            fixture.destroy();
        }
    }
);

test(
    'accepted synthetic submissions preserve the reader position through later layout',
    async function preserveReaderOnSyntheticSubmission() {
        const fixture = createScrollFixture();
        fixture.scroll();
        fixture.viewport.scrollTop = 900;
        fixture.textArea.value = 'An unfinished user draft.';
        const text = '  Internal timebox notice.\nKeep its original text.  ';
        const result = await fixture.submit(
            text,
            {source: 'conversation-timebox', synthetic: true, preserveDraft: true}
        );
        assert.equal(result, true);
        assert.equal(fixture.viewport.scrollTop, 900);
        assert.equal(fixture.viewport.children.length, 0);
        assert.equal(fixture.submission.sent.length, 1);
        assert.equal(fixture.submission.sent[0].text, text);
        assert.equal(fixture.submission.events[0].detail.message, text);
        assert.equal(fixture.textArea.value, 'An unfinished user draft.');

        fixture.viewport.clientHeight = 300;
        fixture.resizeObserver.deliver();
        fixture.viewport.scrollHeight += 400;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 900);
        fixture.destroy();
    }
);

test(
    'chat preserves upward reader movement before its scroll event is delivered',
    function preserveQueuedReaderScroll() {
        const fixture = createScrollFixture();
        fixture.scroll();
        fixture.viewport.scrollTop = 900;
        fixture.viewport.scrollHeight = 2000;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 900);
        assert.equal(fixture.scroll(), false);
        fixture.viewport.dispatchEvent(new Event('scroll'));

        fixture.viewport.scrollHeight = 2400;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 900);
        fixture.restore();
        assert.equal(fixture.viewport.scrollTop, 900);

        fixture.viewport.scrollTop = 2000;
        fixture.viewport.dispatchEvent(new Event('scroll'));
        fixture.viewport.scrollHeight = 2800;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 2400);
        fixture.destroy();
    }
);

test(
    'chat mutation scrolling respects a reader before observer or scroll delivery',
    function preserveReaderBeforeMutationScroll() {
        const fixture = createScrollFixture();
        fixture.scroll();
        fixture.viewport.scrollTop = 850;
        fixture.viewport.scrollHeight = 2200;
        assert.equal(fixture.scroll(), false);
        assert.equal(fixture.viewport.scrollTop, 850);
        fixture.destroy();
    }
);

test(
    'chat accepts bottom rounding and retains deliberate fractional reader movement',
    function retainRoundedBottom() {
        const fixture = createScrollFixture();
        fixture.scroll();
        fixture.viewport.scrollTop = 1199.5;
        fixture.viewport.dispatchEvent(new Event('scroll'));
        fixture.viewport.scrollHeight = 1800;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1400);

        for(const position of [1399.5, 1399, 1398.5]) {
            fixture.viewport.scrollTop = position;
            fixture.viewport.dispatchEvent(new Event('scroll'));
        }
        fixture.viewport.scrollHeight = 2200;
        fixture.resizeObserver.deliver();
        assert.equal(fixture.viewport.scrollTop, 1398.5);
        fixture.destroy();
    }
);

test(
    'chat preserves following and reader-away choices across a hidden viewport',
    function retainHiddenViewportChoice() {
        for(const readerAway of [false, true]) {
            const fixture = createScrollFixture();
            fixture.scroll();
            if(readerAway) {
                fixture.viewport.scrollTop = 800;
                fixture.viewport.dispatchEvent(new Event('scroll'));
            }
            fixture.viewport.clientHeight = 0;
            fixture.viewport.scrollTop = 0;
            fixture.resizeObserver.deliver();
            fixture.viewport.dispatchEvent(new Event('scroll'));
            fixture.viewport.clientHeight = 400;
            fixture.viewport.scrollHeight = 2400;
            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, readerAway ? 0 : 2000);

            fixture.viewport.scrollHeight = 2600;
            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, readerAway ? 0 : 2200);
            fixture.destroy();
        }
    }
);

test(
    'chat readiness hide and show preserves choice before resize delivery',
    function retainReadinessVisibilityChoice() {
        for(const readerAway of [false, true]) {
            const fixture = createScrollFixture();
            fixture.scroll();
            if(readerAway) {
                fixture.viewport.scrollTop = 700;
            }
            fixture.setConversationVisible(false);
            fixture.viewport.clientHeight = 0;
            fixture.viewport.scrollTop = 0;
            fixture.setConversationVisible(true);
            fixture.viewport.clientHeight = 400;
            fixture.viewport.scrollHeight = 2400;
            fixture.resizeObserver.deliver();
            assert.equal(fixture.viewport.scrollTop, readerAway ? 0 : 2000);
            fixture.destroy();
        }
    }
);

test(
    'chat observes added cards and releases removed cards without subtree observation',
    function updateObservedTranscriptCards() {
        const initial = {localName: 'li'};
        const fixture = createScrollFixture(
            [initial]
        );
        assert.equal(fixture.mutationObserver.target, fixture.viewport);
        assert.deepEqual(
            fixture.mutationObserver.options,
            {childList: true}
        );
        const added = {localName: 'li', parentElement: fixture.viewport};
        fixture.viewport.children.push(added);
        fixture.mutationObserver.deliver(
            [{addedNodes: [added], removedNodes: []}]
        );
        assert.equal(fixture.resizeObserver.observed.has(added), true);

        initial.parentElement = null;
        fixture.viewport.children.splice(fixture.viewport.children.indexOf(initial), 1);
        fixture.mutationObserver.deliver(
            [{addedNodes: [], removedNodes: [initial]}]
        );
        assert.equal(fixture.resizeObserver.observed.has(initial), false);

        fixture.mutationObserver.deliver(
            [
                {addedNodes: [added], removedNodes: []},
                {addedNodes: [], removedNodes: [added]}
            ]
        );
        assert.equal(fixture.resizeObserver.observed.has(added), true);
        fixture.destroy();
    }
);

test(
    'chat destruction disconnects observers and ignores queued callbacks',
    function stopTranscriptObservation() {
        const fixture = createScrollFixture();
        fixture.scroll();
        assert.equal(fixture.destroy(), true);
        assert.equal(fixture.destroy(), false);
        assert.equal(fixture.signal.aborted, true);
        assert.equal(fixture.resizeObserver.disconnected, true);
        assert.equal(fixture.resizeObserver.observed.size, 0);
        assert.equal(fixture.mutationObserver.disconnected, true);
        assert.equal(fixture.mutationObserver.target, null);

        fixture.viewport.scrollHeight = 3000;
        const added = {localName: 'li', parentElement: fixture.viewport};
        fixture.resizeObserver.deliver();
        fixture.mutationObserver.deliver(
            [{addedNodes: [added], removedNodes: []}]
        );
        fixture.viewport.dispatchEvent(new Event('scroll'));
        assert.equal(fixture.scroll(), false);
        assert.equal(fixture.viewport.scrollTop, 1200);
        assert.equal(fixture.resizeObserver.observed.has(added), false);
    }
);
