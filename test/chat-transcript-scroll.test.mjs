import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';

const source = await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
);
const scrollStart = source.indexOf('    let transcriptFollowing = true;');
const scrollEnd = source.indexOf('\n\n    function transcriptTime', scrollStart);
const visibilityStart = source.indexOf('        if(!conversationVisible && !host.conversationComplete)');
const visibilityEnd = source.indexOf('        send.disabled=', visibilityStart);
const resizeStart = source.indexOf('    async function resizeTextArea(');
const resizeEnd = source.indexOf('\n\n    function renderSessionMessageFailure', resizeStart);
const restoreStart = source.indexOf('\n    function restoreFromPageCache(){');
const destroyStart = source.indexOf('\n    function destroy(){');
const destroyEnd = source.indexOf('        aiActivationController.destroy();', destroyStart);
for(const boundary of [scrollStart, scrollEnd, visibilityStart, visibilityEnd, resizeStart, resizeEnd, restoreStart, destroyStart, destroyEnd]) {
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
        }
    };
    let destroyed = false;
    let sessionBindingGeneration = 0;
    const aiRuntimeStateAbortController = new AbortController();
    const activeSubmissionOwnerships = new Set();
    const chatReasons = {componentDestroyed: 'component-destroyed'};
    const host = {conversationComplete: false};
    const chatArea = {dataset: {}};
    function setSessionStatus() {}
    function setAIAvailability() {}
    function createChatSubmissionAbort(reason, message) {
        return new Error(message);
    }
    ${source.slice(scrollStart, scrollEnd)}
    ${source.slice(resizeStart, resizeEnd)}
    ${source.slice(restoreStart, destroyStart)}
    ${source.slice(destroyStart, destroyEnd)}
        return true;
    }
    return {
        scroll: scrollTranscriptToBottom,
        resize: resizeTextArea,
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
    const textArea = {scrollHeight: 80, style: {height: ''}};
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
