import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

const source = await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
);
const start = source.indexOf('    function renderSessionMessageFailure(');
const end = source.indexOf('\n\n    async function submitToolResults(', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);

// Exercise the real request and rejection paths; rendering and provider work
// remain explicit fixture boundaries rather than an alternate cleanup model.
const initializeSession = Function(
    'session',
    'ui',
    `'use strict';
    const {
        chatOutput, textArea, host, is, MD, arcaneLogging, chatError,
        receivedMessage, streamMessage, setMessageProgress,
        scrollTranscriptToBottom, applyAIAvailability, setSessionStatus,
        setTranscriptMessageContent, setTranscriptMessageTimestamp,
        normalizeVisibleToolCalls, sameStructuralToolCall,
        sameStructuralToolCalls, appendVisibleToolCall,
        dispatchChatEvent, visibleErrorMessage, publicErrorFields
    } = ui;
    const chatErrorCodes = {sessionBindingRejected: 'BINDING', sessionMessageRejected: 'MESSAGE'};
    const chatReasons = {sessionMessageCompleted: 'completed', sessionMessageRejected: 'rejected'};
    let boundChatSession = session;
    let sessionBindingGeneration = 1;
    let sessionMessageSequence = 0;
    let activeSessionMessageToken = null;
    let sessionMessagePending = false;
    let destroyed = false;
    let pendingStructuralToolCalls = [];
    let pendingStructuralToolMessage = '';
    function setPendingStructuralToolCalls(calls = []) {
        pendingStructuralToolCalls = [...calls];
        pendingStructuralToolMessage = calls.length ? 'Tool pending.' : '';
    }
    function pendingStructuralToolSummary() { return pendingStructuralToolCalls[0] ?? null; }
    function pendingStructuralToolSummaries() { return [...pendingStructuralToolCalls]; }
    function pendingStructuralToolCallComplete() { return pendingStructuralToolSummary(); }
    function pendingStructuralToolCallsComplete() { return pendingStructuralToolSummaries(); }
    function latestCommittedTranscriptTurn() { return null; }
    ${source.slice(start, end)}
    return {
        send: sendMessageThroughBoundSession,
        pendingCalls: pendingStructuralToolCallsComplete,
        pending() { return sessionMessagePending; },
        destroy() {
            destroyed = true;
            sessionBindingGeneration++;
            boundChatSession = null;
            activeSessionMessageToken = null;
            sessionMessagePending = false;
            setPendingStructuralToolCalls();
        },
        rebind(nextSession) {
            sessionBindingGeneration++;
            boundChatSession = nextSession;
        }
    };`
);

function createFixture(session) {
    const chatOutput = {children: []};
    const textArea = {value: 'A newer unsent draft.', style: {}, scrollHeight: 60};
    const events = [];
    const errors = [];
    const ui = {
        chatOutput,
        textArea,
        host: {aiName: 'Assistant', aiAvailability: {llm: true}},
        is: {
            array: Array.isArray,
            boolean(value) { return typeof value === 'boolean'; },
            function(value) { return typeof value === 'function'; },
            object(value) { return typeof value === 'object'; },
            string(value) { return typeof value === 'string'; }
        },
        MD: class Markdown {
            constructor(text) { this.rendered = text; }
        },
        arcaneLogging: {
            error(message, error) { errors.push({message, error}); }
        },
        chatError(message, code) { return Object.assign(new Error(message), {code}); },
        receivedMessage(name, text, id) { return appendCard('assistant', text, '', `message-${id}`); },
        async streamMessage(text, id) {
            const card = chatOutput.children.find(function matchesResponse(candidate) {
                return candidate.id === `message-${id}`;
            });
            if(card) card.markdown.raw += text;
        },
        setMessageProgress() {},
        scrollTranscriptToBottom() {},
        applyAIAvailability() {},
        setSessionStatus(state, message) { ui.status = {state, message}; },
        setTranscriptMessageContent(card, content) { card.markdown.raw = content; },
        setTranscriptMessageTimestamp(card, timestamp) { card.timestamp = timestamp; },
        normalizeVisibleToolCalls(calls = []) { return calls; },
        sameStructuralToolCall(left, right) { return JSON.stringify(left) === JSON.stringify(right); },
        sameStructuralToolCalls(left, right) { return JSON.stringify(left) === JSON.stringify(right); },
        appendVisibleToolCall(card, call) { card.calls.push(call); },
        dispatchChatEvent(type, detail, options) {
            events.push({type, detail, options});
            ui.onEvent?.(type, detail);
            return true;
        },
        visibleErrorMessage(error, fallback) { return error.userSafe ? error.message : fallback; },
        publicErrorFields(error, code) { return {error, code}; }
    };
    function appendCard(role, content, operationId = '', id = '') {
        const card = {
            role,
            id,
            dataset: {operationId},
            markdown: {raw: content, innerHTML: content},
            calls: [],
            classes: new Set(),
            classList: {
                add(name) { card.classes.add(name); }
            },
            querySelector(selector) { return selector === '.markdown' ? card.markdown : null; },
            remove() {
                const index = chatOutput.children.indexOf(card);
                if(index >= 0) chatOutput.children.splice(index, 1);
            }
        };
        chatOutput.children.push(card);
        return card;
    }
    const retained = appendCard('user', 'An existing conversation turn.');
    return {ui, textArea, events, errors, retained, appendCard, ...initializeSession(session, ui)};
}

function submit(fixture, persist = false, context = {operationId: 'current-operation'}) {
    const content = '  Temporary dragon census.\nKeep the complete input.  ';
    const requestCard = fixture.appendCard('user', content, context.operationId);
    return fixture.send(content, context, {role: 'user', content, persist}, null, [requestCard]);
}

function deferred() {
    let resolve;
    const promise = new Promise(function captureResolver(resolvePromise) {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

function response() {
    return {message: {role: 'assistant', content: 'All dragons accounted for.'}};
}

test('transient streaming cards disappear before completion is delivered', async function releaseSuccessfulTurn() {
    const call = {id: 'census', type: 'function', function: {name: 'countDragons', arguments: '{"message":"Counting dragons."}'}};
    const result = {message: {...response().message, tool_calls: [call]}};
    const fixture = createFixture(
        {
            async stream(request, handlers) {
                assert.equal(request.message.content, '  Temporary dragon census.\nKeep the complete input.  ');
                await handlers.onChunk('Counting every dragon.', 'provider-request', false);
                await handlers.onToolCall(call);
                assert.equal(fixture.ui.chatOutput.children.length, 3);
                assert.deepEqual(fixture.pendingCalls(), [call]);
                return result;
            }
        }
    );
    fixture.ui.onEvent = function observeCompletion(type) {
        if(type === 'chat-session-message') {
            assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained]);
            assert.deepEqual(fixture.pendingCalls(), []);
            assert.equal(fixture.pending(), false);
        }
    };
    assert.deepEqual(await submit(fixture), result);
    assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained]);
    assert.equal(fixture.textArea.value, 'A newer unsent draft.');
    assert.equal(fixture.events.length, 1);
});

test('transient failures and cancellation release cards without restoring the input', async function releaseRejectedTurns() {
    for(const mode of ['provider', 'structural', 'abort']) {
        const failure = new Error(`Synthetic ${mode} failure.`);
        if(mode === 'structural') failure.code = 'AI_CHAT_INVALID_TOOL_CALL';
        if(mode === 'abort') failure.name = 'AbortError';
        const controller = new AbortController();
        const fixture = createFixture(
            {
                async stream(request, handlers) {
                    await handlers.onChunk('A partial response.', 'provider-request', false);
                    if(mode === 'abort') controller.abort(failure);
                    throw failure;
                }
            }
        );
        await assert.rejects(
            submit(fixture, false, {operationId: 'rejected-operation', signal: controller.signal}),
            function preservesFailure(error) { return error === failure; }
        );
        assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained], mode);
        assert.equal(fixture.textArea.value, 'A newer unsent draft.', mode);
        assert.equal(fixture.pending(), false, mode);
        assert.equal(fixture.errors[0].error, failure, mode);
        assert.equal(fixture.ui.status.state, mode === 'structural' ? 'ready' : 'error', mode);
        if(mode !== 'structural') assert.equal(fixture.events[0].detail.error, failure, mode);
    }
});

test('lifecycle exits remove only cards captured by the transient operation', async function releaseSupersededTurns() {
    for(const lifecycle of ['destroy', 'rebind']) {
        const entered = deferred();
        const terminal = deferred();
        const fixture = createFixture(
            {
                send() {
                    entered.resolve();
                    return terminal.promise;
                }
            }
        );
        const pending = submit(fixture);
        await entered.promise;
        if(lifecycle === 'destroy') fixture.destroy();
        else fixture.rebind({});
        const newer = fixture.appendCard('user', 'A separate later request.', 'current-operation');
        terminal.resolve(response());
        assert.equal(await pending, false, lifecycle);
        assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained, newer], lifecycle);
        assert.equal(fixture.events.length, 0, lifecycle);
    }
});

test('terminal cleanup preserves a reentrant turn that reuses the operation identifier', async function preserveReentrantTurn() {
    const secondEntered = deferred();
    const secondTerminal = deferred();
    let requests = 0;
    let second;
    const fixture = createFixture(
        {
            send() {
                requests++;
                if(requests === 1) return response();
                secondEntered.resolve();
                return secondTerminal.promise;
            }
        }
    );
    fixture.ui.onEvent = function submitDuringCompletion(type) {
        if(type === 'chat-session-message' && requests === 1) second = submit(fixture, true);
    };
    await submit(fixture);
    await secondEntered.promise;
    assert.equal(fixture.pending(), true);
    assert.equal(fixture.ui.chatOutput.children.length, 3);
    secondTerminal.resolve(response());
    await second;
    assert.equal(fixture.ui.chatOutput.children.length, 3);
    assert.equal(fixture.ui.chatOutput.children[2].markdown.raw, response().message.content);
    assert.equal(fixture.pending(), false);
});

test(
    'transient reused identifiers preserve earlier persistent cards through every terminal path',
    async function preserveEarlierPersistentCards() {
        for(const [role, mode] of [
            ['user', 'success'],
            ['user', 'provider'],
            ['user', 'structural'],
            ['user', 'abort'],
            ['tool', 'provider'],
            ['tool', 'structural']
        ]) {
            const failure = new Error(`Synthetic ${mode} failure.`);
            if(mode === 'structural') failure.code = 'AI_CHAT_INVALID_TOOL_CALL';
            if(mode === 'abort') failure.name = 'AbortError';
            const controller = new AbortController();
            let requests = 0;
            const fixture = createFixture(
                {
                    async send(request) {
                        requests++;
                        if(requests === 1 || mode === 'success') return response();
                        if(mode === 'abort') {
                            assert.equal(request.signal, controller.signal);
                            controller.abort(failure);
                        }
                        throw failure;
                    }
                }
            );
            await submit(fixture, true);
            const earlierCards = [...fixture.ui.chatOutput.children];
            earlierCards[1].timestamp = '2026-09-28T10:00:00.000Z';
            earlierCards[2].timestamp = '2026-09-28T10:00:01.000Z';
            const earlierContent = earlierCards.map(function retainEarlierContent(card) {
                return {content: card.markdown.raw, timestamp: card.timestamp};
            });
            const context = {operationId: 'current-operation', signal: controller.signal};
            let pending;
            if(role === 'user') {
                pending = submit(fixture, false, context);
            } else {
                const messages = ['First dragon counted.', 'Second dragon counted.'].map(
                    function transientToolMessage(content, index) {
                        return {role: 'tool', content, persist: false, tool_call_id: `count-${index}`};
                    }
                );
                const cards = messages.map(function appendToolResult(message) {
                    return fixture.appendCard('tool', message.content, context.operationId);
                });
                pending = fixture.send('Both dragon counts.', context, messages, null, cards);
            }
            if(mode === 'success') await pending;
            else await assert.rejects(pending, function preservesFailure(error) { return error === failure; });
            assert.equal(fixture.ui.chatOutput.children.length, earlierCards.length, `${role}/${mode}`);
            for(const [index, card] of earlierCards.entries()) {
                assert.equal(fixture.ui.chatOutput.children[index], card, `${role}/${mode}`);
                assert.equal(card.markdown.raw, earlierContent[index].content, `${role}/${mode}`);
                assert.equal(card.timestamp, earlierContent[index].timestamp, `${role}/${mode}`);
            }
            assert.equal(fixture.textArea.value, 'A newer unsent draft.', `${role}/${mode}`);
            assert.equal(fixture.pending(), false, `${role}/${mode}`);
        }
    }
);

test('entity-wide no-retention also removes ordinary default-submission cards', async function entityNonpersistentTurns() {
    for(const mode of ['success', 'provider', 'structural', 'abort', 'reenabled']) {
        const failure = new Error(`Entity-disabled ${mode} failure.`);
        if(mode === 'structural') failure.code = 'AI_CHAT_INVALID_TOOL_CALL';
        if(mode === 'abort') failure.name = 'AbortError';
        const session = {
            chatEntity: {persist: false},
            async send(request) {
                assert.equal(Object.hasOwn(request.message, 'persist'), false);
                if(mode === 'reenabled') session.chatEntity.persist = true;
                if(['provider', 'structural', 'abort'].includes(mode)) throw failure;
                return {...response(), retained: false};
            }
        };
        const fixture = createFixture(session);
        const content = 'The complete temporary batch.';
        const card = fixture.appendCard('user', content);
        const pending = fixture.send(content, {}, undefined, null, [card]);
        if(['success', 'reenabled'].includes(mode)) await pending;
        else await assert.rejects(pending, function originalFailure(error) { return error === failure; });
        assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained], mode);
        assert.equal(fixture.textArea.value, 'A newer unsent draft.', mode);
        assert.deepEqual(fixture.pendingCalls(), [], mode);
    }
});

test('Chat follows the session commit decision rather than a later entity toggle', async function settledRetention() {
    for(const retained of [false, true]) {
        const session = {
            chatEntity: {persist: true},
            async send() {
                // The session can finish an already accepted durable write even
                // when the flag is changed for the next operation.
                session.chatEntity.persist = false;
                return {...response(), retained};
            }
        };
        const fixture = createFixture(session);
        await submit(fixture, true);
        assert.equal(fixture.ui.chatOutput.children.length, retained ? 3 : 1);
    }
});

test('entity disable during a failed turn does not retain partial cards or restore the batch', async function disabledDuringFailure() {
    const failure = new Error('Provider failed after retention was disabled.');
    const session = {
        chatEntity: {persist: true},
        async stream(request, handlers) {
            await handlers.onChunk('Partial temporary response.', 'request', false);
            session.chatEntity.persist = false;
            throw failure;
        }
    };
    const fixture = createFixture(session);
    await assert.rejects(submit(fixture, true), function originalFailure(error) { return error === failure; });
    assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained]);
    assert.equal(fixture.textArea.value, 'A newer unsent draft.');
});

test('completion listeners cannot retroactively remove the settled previous turn', async function reentrantRetentionToggle() {
    const session = {
        chatEntity: {persist: true},
        async send() { return {...response(), retained: true}; }
    };
    const fixture = createFixture(session);
    fixture.ui.onEvent = function disableLaterRetention(type) {
        if(type === 'chat-session-message') session.chatEntity.persist = false;
    };
    await submit(fixture, true);
    assert.equal(fixture.ui.chatOutput.children.length, 3);
});

test('persistent success and rejection retain their existing transcript and draft behavior', async function preservePersistentTurns() {
    for(const mode of ['success', 'provider', 'structural']) {
        const failure = new Error('A persistent request failed.');
        if(mode === 'structural') failure.code = 'AI_CHAT_INVALID_TOOL_CALL';
        const fixture = createFixture(
            {
                async send() {
                    if(mode !== 'success') throw failure;
                    return response();
                }
            }
        );
        if(mode === 'success') await submit(fixture, true);
        else await assert.rejects(submit(fixture, true));
        if(mode === 'structural') {
            assert.deepEqual(fixture.ui.chatOutput.children, [fixture.retained]);
            assert.equal(fixture.textArea.value, '  Temporary dragon census.\nKeep the complete input.  \nA newer unsent draft.');
        } else {
            assert.equal(fixture.ui.chatOutput.children.length, 3, mode);
            assert.equal(fixture.ui.chatOutput.children[2].classes.has('session_error'), mode === 'provider');
            assert.equal(fixture.textArea.value, 'A newer unsent draft.', mode);
        }
    }
});
