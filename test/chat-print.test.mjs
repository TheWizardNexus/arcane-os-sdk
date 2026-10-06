import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';

const source = (await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
)).replaceAll('\r\n', '\n');

function section(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, startMarker);
    assert.ok(end > start, endMarker);
    return source.slice(start, end);
}

const initializePrint = Function(
    'fixture',
    `'use strict';
    const {
        host, chatOutput, arcaneLogging, setSessionStatus, createPrintView,
        MD, hydrateMarkdownMedia
    } = fixture;
    const aiRuntimeStateAbortController = new AbortController();
    let destroyed = false;
    const transcriptMedia = new Map();
    let printMediaRetains = null;
    function scrollTranscriptToBottom() {}
    ${section('        function registerChatPrint(', '\n    );\n    void printViewPromise.catch')}
    const printViewPromise = Promise.resolve(registerChatPrint({createPrintView}));
    ${section('    function renderTranscriptMarkdown(', '\n    function setTranscriptMessageContent(')}
    ${section('    function renderedChatPrintContent(){', '\n    function reportTTSError(')}
    return {
        print,
        render: renderTranscriptMarkdown,
        release: releaseTranscriptMessageMedia,
        remove: removeTranscriptMessage,
        prepare: prepareChatPrintMedia,
        media: transcriptMedia,
        controller: aiRuntimeStateAbortController,
        destroy: function destroy() {
            destroyed = true;
            aiRuntimeStateAbortController.abort();
            ${section('        for(const target of transcriptMedia.keys())', '\n        aiActivationController.destroy();')}
        }
    };`
);

function fixture(result = true) {
    const errors = [];
    const statuses = [];
    const handles = [];
    const warnings = [];
    let requests = 0;
    let options;
    const host = {};
    const chatOutput = {children: [{textContent: 'Complete human conversation.'}]};
    const ownerDocument = {
        createElement(name) {
            if (name === 'template') {
                const content = {
                    markup: '',
                    displayed: false,
                    querySelectorAll() {
                        return this.markup.includes('arcane-media:')
                            ? [{getAttribute() { return 'arcane-media:images/octopus.json'; }}]
                            : [];
                    }
                };
                return {
                    content,
                    set innerHTML(value) { content.markup = value; }
                };
            }
            return {
                textContent: '',
                className: '',
                attributes: {},
                setAttribute(key, value) { this.attributes[key] = value; },
                remove() {
                    const index = warnings.indexOf(this);
                    if (index >= 0) warnings.splice(index, 1);
                }
            };
        }
    };
    // Storage, decoding and native URLs have their own MarkdownMedia fixture.
    // These handles expose their display/readiness/retention lifecycle to Chat.
    function hydrateMarkdownMedia(fragment, {signal}) {
        let resolve;
        let reject;
        const handle = {
            fragment,
            destroyed: false,
            retains: 0,
            released: false,
            ready: new Promise(function pendingMedia(done, fail) {
                resolve = done;
                reject = fail;
            }),
            complete() {
                if (handle.destroyed) return;
                fragment.displayed = true;
                resolve();
            },
            fail(error) { reject(error); },
            destroy() {
                if (handle.destroyed) return;
                handle.destroyed = true;
                handle.released = handle.retains === 0;
                signal.removeEventListener('abort', handle.destroy);
                reject(new DOMException('Display cancelled.', 'AbortError'));
            },
            retain() {
                handle.retains += 1;
                let released = false;
                return function releaseRetainedMedia() {
                    if (released) return;
                    released = true;
                    handle.retains -= 1;
                    handle.released = handle.destroyed && handle.retains === 0;
                };
            }
        };
        handles.push(handle);
        signal.addEventListener('abort', handle.destroy, {once: true});
        if (signal.aborted) handle.destroy();
        else if (!fragment.querySelectorAll('img').length) handle.complete();
        return handle;
    }
    const controller = initializePrint({
        host,
        chatOutput,
        MD: class Markdown {
            constructor(content) { this.rendered = content; }
        },
        hydrateMarkdownMedia,
        arcaneLogging: {error(...details) { errors.push(details); }},
        setSessionStatus(state, message) { statuses.push({state, message}); },
        createPrintView(configuration) {
            options = configuration;
            return {
                print() {
                    requests += 1;
                    if (result instanceof Error) throw result;
                    return result;
                }
            };
        }
    });
    function card() {
        const markdown = {
            ownerDocument,
            raw: '',
            fragment: null,
            replaceChildren(fragment) { this.fragment = fragment; },
            after(status) { warnings.push(status); }
        };
        const item = {
            markdown,
            removed: false,
            querySelector(selector) { return selector === '.markdown' ? markdown : null; },
            remove() {
                this.removed = true;
                const index = chatOutput.children.indexOf(this);
                if (index >= 0) chatOutput.children.splice(index, 1);
            }
        };
        chatOutput.children.push(item);
        return item;
    }
    return {
        host, chatOutput, errors, statuses, handles, warnings, controller, card,
        get options() { return options; }, get requests() { return requests; }
    };
}

test('Chat print delegates only its rendered transcript and lifecycle to the shared owner', async function testChatPrint() {
    const current = fixture();
    assert.equal(current.options.content(), current.chatOutput);
    assert.equal(current.options.title(), 'Conversation');
    current.host.printTitle = 'Octopus meeting';
    assert.equal(current.options.title(), 'Octopus meeting');
    assert.equal(current.options.active(), true);
    assert.equal(await current.controller.print(), true);
    assert.equal(current.requests, 1);
    current.chatOutput.children = [];
    assert.equal(current.options.active(), false);
    current.controller.destroy();
    assert.equal(current.options.signal.aborted, true);
    assert.equal(await current.controller.print(), false);
    assert.equal(current.requests, 1);
    assert.match(source, /host\.print=print;/u);
});

test('print preparation failures retain complete diagnostics and concise visible status', async function testPrintFailure() {
    const failure = new Error('Synthetic media preparation failure.');
    const current = fixture(failure);
    await assert.rejects(current.controller.print(), function exactError(error) { return error === failure; });
    assert.equal(current.errors[0][1], failure);
    assert.deepEqual(current.statuses, [{state: 'error', message: 'Unable to open print preview. Please try again.'}]);
    current.options.onError(failure);
    assert.equal(current.errors[1][1], failure);
    current.controller.destroy();
});

test('Chat renders complete Markdown immediately and replaces only its obsolete media owner', async function renderSavedImages() {
    const current = fixture();
    const card = current.card();
    const text = '  ![Eight pens](arcane-media:images/octopus.json)\nComplete **agenda**.  ';
    const first = current.controller.render(card.markdown, text);
    assert.equal(card.markdown.raw, text);
    assert.equal(card.markdown.fragment.markup, text);
    assert.equal(first.pending, true);
    assert.equal(current.handles[0].fragment.displayed, false);

    const finalText = `${text}\nEvery attendee has a pen.`;
    const second = current.controller.render(card.markdown, finalText);
    assert.equal(current.handles[0].destroyed, true);
    assert.equal(current.handles[0].released, true);
    current.handles[0].complete();
    assert.equal(current.handles[0].fragment.displayed, false);
    assert.equal(card.markdown.raw, finalText);
    current.handles[1].complete();
    await Promise.all([first.ready, second.ready]);
    assert.equal(second.pending, false);
    assert.deepEqual(current.errors, []);
    current.controller.destroy();
    assert.equal(current.handles[1].released, true);
    assert.equal(current.controller.media.size, 0);
});

test('Chat image failures remain visible beside complete content without changing session status', async function reportSavedImageFailure() {
    const current = fixture();
    const card = current.card();
    const text = '![Missing pen](arcane-media:images/missing.json)\nKeep the entire answer.';
    const media = current.controller.render(card.markdown, text);
    const failure = new AggregateError([new Error('Actual record read failure.')], 'Saved image failed.');
    current.handles[0].fail(failure);
    await media.ready;
    assert.equal(card.markdown.raw, text);
    assert.equal(current.errors[0][1], failure);
    assert.deepEqual(current.statuses, []);
    assert.equal(current.warnings[0].textContent, 'Some saved images could not be displayed.');
    assert.equal(current.warnings[0].attributes.role, 'status');
    assert.throws(current.options.content, function exactError(error) { return error === failure; });
    current.controller.remove(card);
    assert.equal(card.removed, true);
    assert.equal(current.handles[0].released, true);
    assert.deepEqual(current.warnings, []);
    current.controller.destroy();
});

test('Chat print waits for the current media generation and keeps requested snapshots retained', async function retainSavedImagePrint() {
    const current = fixture();
    const card = current.card();
    current.controller.render(card.markdown, '![Old map](arcane-media:images/old.json)');
    assert.throws(current.options.content, {code: 'ARCANE_MARKDOWN_MEDIA_PENDING'});
    const printing = current.controller.print();
    await Promise.resolve();
    assert.equal(current.requests, 0);

    const latest = current.controller.render(card.markdown, '![Current map](arcane-media:images/current.json)');
    current.handles[1].complete();
    await latest.ready;
    assert.equal(await printing, true);
    assert.equal(current.requests, 1);
    assert.equal(current.options.content(), current.chatOutput);

    // PrintView calls retain before snapshot preparation and releases at afterprint.
    const afterPrint = current.options.retain();
    assert.equal(current.handles[1].retains, 1);
    const replacement = current.controller.render(card.markdown, '![Later map](arcane-media:images/later.json)');
    assert.equal(current.handles[1].destroyed, true);
    assert.equal(current.handles[1].released, false);
    assert.equal(current.handles[2].retains, 1);
    current.handles[2].complete();
    await replacement.ready;
    assert.equal(await current.options.prepare(new AbortController().signal), true);
    current.controller.destroy();
    assert.equal(current.handles[2].released, false);
    afterPrint();
    afterPrint();
    assert.equal(current.handles[1].released, true);
    assert.equal(current.handles[2].released, true);
});

test('Chat removal and destruction cancel display and pending print without late errors', async function cancelSavedImages() {
    const current = fixture();
    const card = current.card();
    const first = current.controller.render(card.markdown, '![Temporary image](arcane-media:images/temporary.json)');
    const cancellation = new AbortController();
    const preparing = current.options.prepare(cancellation.signal);
    cancellation.abort();
    assert.equal(await preparing, false);
    assert.equal(current.handles[0].destroyed, false);
    current.controller.remove(card);
    await first.ready;
    assert.equal(current.handles[0].released, true);
    assert.equal(current.controller.media.size, 0);

    const nextCard = current.card();
    const next = current.controller.render(nextCard.markdown, '![Waiting image](arcane-media:images/waiting.json)');
    const printing = current.controller.print();
    current.controller.destroy();
    await next.ready;
    assert.equal(await printing, false);
    assert.equal(current.requests, 0);
    assert.equal(current.controller.render(nextCard.markdown, 'A late image request.'), null);
    assert.equal(current.handles.length, 2);
    assert.deepEqual(current.errors, []);
    assert.deepEqual(current.warnings, []);
});

test('all Chat Markdown and card lifecycle paths share the same media owner', function sharedMediaOwnership() {
    assert.match(section('    function setTranscriptMessageContent(', '\n    function setTranscriptMessageTimestamp('), /renderTranscriptMarkdown\(markdown,content\);/u);
    assert.match(section('    function createTranscriptMessage(', '\n    function appendTranscriptMessage('), /renderTranscriptMarkdown\(markdown,content\);/u);
    assert.match(section('    async function streamMessage(', '\n    textArea.addEventListener('), /renderTranscriptMarkdown\(target,target\.raw\?target\.raw\+text:text\);/u);
    assert.match(section('    function renderSessionMessageFailure(', '\n    function internalStructuralToolFailure('), /renderTranscriptMarkdown\(markdown,text\);/u);
    assert.match(section('    function renderSessionHistory(', '\n    async function bindSession('), /releaseTranscriptMessageMedia\(item\);[\s\S]*chatOutput\.replaceChildren\(fragment\);/u);
    assert.match(section('        function removeTransientSessionCards(', '\n        activeSessionMessageToken='), /removeTranscriptMessage\(card\);/u);
    assert.match(section('    function handleTranscriptChildren(', '\n    function scrollTranscriptToBottom('), /item\.parentElement !== chatOutput[\s\S]*releaseTranscriptMessageMedia\(item\);/u);
});
