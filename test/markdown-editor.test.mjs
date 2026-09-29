import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';
import * as contracts from '../runtime/arcane/modules/ComponentContracts.js';

const source = await readFile(
    new URL('../runtime/arcane/components/markdown-editor.html', import.meta.url),
    'utf8'
);
const script = source.match(/<script type="module">([\s\S]*?)<\/script>/u)[1];
const AsyncFunction = Object.getPrototypeOf(async function componentScript() {}).constructor;
const initialize = new AsyncFunction(
    'loadDependency', 'document', 'NodeFilter', 'requestAnimationFrame', 'cancelAnimationFrame',
    script.replaceAll('await import(', 'await loadDependency(')
);

// Run the complete component script with controlled DOM geometry. Markdown
// parsing and native browser layout have their own owners; this fixture supplies
// explicit source-map records and rendered blocks without implementing a parser.
async function editorFixture(context, {dataset = {}, layout = [], viewportEffects = false} = {}) {
    const publications = [];
    const errors = [];
    const renders = [];
    const frames = new Map();
    const cancelledFrames = [];
    const treeMoves = [];
    const document = {activeElement: null};
    let frameSequence = 0;
    let eventSourceDisposed = false;
    let renderedEntries = [];
    let preview;

    class Element extends EventTarget {
        constructor(tagName = 'section') {
            super();
            this.tagName = tagName.toUpperCase();
            this.nodeType = 1;
            this.dataset = {};
            this.attributes = new Map();
            this.children = [];
            this.childNodes = [];
            this.parentElement = null;
            this.value = '';
            this.innerText = '';
            this.scrollTop = 0;
            this.scrollLeft = 0;
            this.clientHeight = 240;
            this.clientTop = 0;
            this.scrollHeight = 2400;
            this.selectionStart = 0;
            this.selectionEnd = 0;
            this.selectionDirection = 'none';
            const classes = new Set();
            this.classList = {
                contains(name) {return classes.has(name);},
                toggle(name, enabled) {
                    if (enabled) classes.add(name);
                    else classes.delete(name);
                    return enabled;
                }
            };
        }

        append(...nodes) {
            for (const node of nodes) {
                if (node.nodeType === 11) {
                    this.append(...node.children);
                    continue;
                }
                node.parentElement = this;
                node.parentNode = this;
                this.children.push(node);
            }
            this.childNodes = [...this.children];
        }

        replaceChildren(...nodes) {
            this.children = [];
            this.childNodes = [];
            this.append(...nodes);
        }

        insertBefore(node, reference) {
            if (node === reference) return node;
            treeMoves.push(node);
            if (viewportEffects && node.tagName === 'TEXTAREA') {
                if (document.activeElement === node) document.activeElement = null;
                node.scrollTop = 0;
                node.scrollLeft = 0;
            }
            const oldIndex = this.children.indexOf(node);
            if (oldIndex !== -1) this.children.splice(oldIndex, 1);
            const nextIndex = reference === null ? this.children.length : this.children.indexOf(reference);
            assert.notEqual(nextIndex, -1, 'The component must use an existing sibling.');
            this.children.splice(nextIndex, 0, node);
            this.childNodes = [...this.children];
            node.parentElement = this;
            node.parentNode = this;
            return node;
        }

        get nextSibling() {
            const siblings = this.parentElement?.childNodes ?? [];
            return siblings[siblings.indexOf(this) + 1] ?? null;
        }

        setAttribute(name, value) {this.attributes.set(name, String(value));}
        getAttribute(name) {return this.attributes.get(name) ?? null;}
        removeAttribute(name) {this.attributes.delete(name);}
        focus(options) {
            document.activeElement = this;
            this.focusOptions = options;
            if (viewportEffects && this.tagName === 'TEXTAREA' && !options?.preventScroll) {
                this.scrollTop = this.scrollHeight;
                this.scrollLeft = 0;
            }
        }
        setSelectionRange(start, end, direction = 'none') {
            this.selectionStart = Math.min(start, this.value.length);
            this.selectionEnd = Math.min(end, this.value.length);
            this.selectionDirection = direction;
            if (viewportEffects && this.tagName === 'TEXTAREA') {
                this.scrollTop = this.scrollHeight;
                this.scrollLeft = 0;
            }
        }
        get value() {return this.text ?? '';}
        set value(value) {
            this.text = value;
            if (viewportEffects && this.tagName === 'TEXTAREA') {
                this.selectionStart = value.length;
                this.selectionEnd = value.length;
                this.selectionDirection = 'none';
                this.scrollTop = this.scrollHeight ?? 0;
                this.scrollLeft = 0;
            }
        }
        closest(selector) {return selector === '[data-format]' && this.dataset.format ? this : null;}
        querySelectorAll(selector) {return selector === 'a' ? this.links ?? [] : [];}

        getBoundingClientRect() {
            const top = this === preview ? 100 : 100 + (this.contentTop ?? 0) - preview.scrollTop;
            const height = this === preview ? this.clientHeight : this.contentHeight ?? 80;
            return {top, bottom: top + height, height, left: 0, right: 400, width: 400};
        }

        get innerHTML() {return this.html ?? '';}
        set innerHTML(value) {
            this.html = value;
            // Model layout adjustment at the replaced preview boundary. The
            // controller must preserve the source pane without a scroll lock.
            if (viewportEffects && this === preview) {
                input.scrollTop = 0;
                input.scrollLeft = 0;
            }
            this.replaceChildren();
            this.comments = [];
            for (const entry of renderedEntries) {
                const block = new Element('p');
                block.contentTop = entry.top;
                block.contentHeight = entry.height;
                block.parentElement = this;
                block.parentNode = this;
                const marker = {
                    nodeType: 8,
                    data: entry.marker,
                    nodeValue: entry.marker,
                    parentNode: this,
                    parentElement: this,
                    nextSibling: block,
                    nextElementSibling: block
                };
                this.children.push(block);
                if (!entry.absorbed) {
                    this.childNodes.push(marker);
                    this.comments.push(marker);
                }
                this.childNodes.push(block);
            }
            const link = new Element('a');
            link.setAttribute('rel', 'fixture-link-relation');
            this.links = [link];
        }
    }

    const editor = new Element();
    const title = new Element('input');
    preview = new Element();
    const toolbar = new Element();
    const input = new Element('textarea');
    const actions = new Element();
    const status = new Element('span');
    const save = new Element('button');
    actions.append(status, save);
    editor.append(title, preview, toolbar, input, actions);
    const elements = new Map([
        ['.markdown-editor', editor], ['#entryTitle', title], ['#preview', preview],
        ['#toolbar', toolbar], ['#entryMarkdown', input], ['#save', save], ['#status', status]
    ]);
    const host = new Element('html-import');
    host.dataset = {...dataset};
    host.shadowRoot = {querySelector(selector) {return elements.get(selector);}};
    document.createElement = function createElement(tagName) {return new Element(tagName);};
    document.createDocumentFragment = function createDocumentFragment() {
        const fragment = new Element();
        fragment.nodeType = 11;
        return fragment;
    };
    document.createTreeWalker = function createTreeWalker(root, kind) {
        assert.equal(root, preview);
        assert.equal(kind, 128);
        let index = 0;
        return {nextNode() {return root.comments[index++] ?? null;}};
    };
    document.createRange = function createRange() {
        let start = 0;
        let end = preview.children.length;
        return {
            selectNodeContents(node) {
                assert.equal(node, preview);
                start = 0;
                end = preview.children.length;
            },
            setStartAfter(marker) {
                assert.ok(preview.comments.includes(marker));
                start = preview.children.indexOf(marker.nextSibling);
                assert.notEqual(start, -1);
            },
            setEndBefore(marker) {
                assert.ok(preview.comments.includes(marker));
                end = preview.children.indexOf(marker.nextSibling);
                assert.notEqual(end, -1);
            },
            setEnd(node, offset) {
                assert.equal(node, preview);
                end = node.childNodes.slice(0, offset).filter(function element(child) {return child.nodeType === 1;}).length;
            },
            getBoundingClientRect() {
                const bounds = preview.children.slice(start, end).map(
                    function blockBounds(block) {return block.getBoundingClientRect();}
                ).filter(function visibleBounds(rect) {return rect.height > 0;});
                if (!bounds.length) return {top: 0, bottom: 0, height: 0, left: 0, right: 0, width: 0};
                const top = Math.min(...bounds.map(function blockTop(rect) {return rect.top;}));
                const bottom = Math.max(...bounds.map(function blockBottom(rect) {return rect.bottom;}));
                return {top, bottom, height: bottom - top, left: 0, right: 400, width: 400};
            }
        };
    };

    class Markdown {
        constructor(raw, options) {
            renders.push({raw, options});
            renderedEntries = options?.sourceMap && raw ? layout : [];
            this.sourceMap = renderedEntries.map(
                function sourceEntry({start, end, marker, type}) {return {start, end, marker, type};}
            );
            this.safeRendered = '<p>The fixture supplies rendered Markdown.</p>';
        }
    }

    async function loadDependency(specifier) {
        if (specifier === 'strong-type') return {default: Is};
        if (specifier.startsWith('../modules/MD.js')) return {default: Markdown};
        if (specifier === '../modules/ComponentContracts.js') return contracts;
        if (specifier === 'arcane-os/logging') {
            return {arcaneLogging: {error(...values) {errors.push(values);}}};
        }
        if (specifier === 'arcane-os/event-manager') {
            return {
                createArcaneEventSource() {
                    return {
                        descriptor: {instanceId: 'fixture-markdown-editor'},
                        dispatch(type, detail, options) {return {occurrence: {type, detail, ...options}};},
                        dispose() {eventSourceDisposed = true;}
                    };
                },
                projectArcaneDOMEvent(_host, occurrence) {publications.push(occurrence); return true;}
            };
        }
        throw new Error(`Unexpected Markdown editor dependency: ${specifier}`);
    }

    function requestFrame(callback) {
        const id = ++frameSequence;
        frames.set(id, callback);
        return id;
    }
    function cancelFrame(id) {
        cancelledFrames.push(id);
        frames.delete(id);
    }
    await initialize.call(host, loadDependency, document, {SHOW_COMMENT: 128}, requestFrame, cancelFrame);
    context.after(function destroyEditorFixture() {host.destroy();});

    return {
        host, editor, title, preview, toolbar, input, actions, status, save, document,
        publications, errors, renders, frames, cancelledFrames, treeMoves,
        get eventSourceDisposed() {return eventSourceDisposed;},
        flushFrames() {
            for (const [id, callback] of [...frames]) {
                frames.delete(id);
                callback(0);
            }
        },
        edit(value, caret = value.length) {
            input.value = value;
            input.setSelectionRange(caret, caret);
            input.dispatchEvent(new Event('input'));
        },
        format(id) {
            const button = toolbar.children.find(function namedFormat(candidate) {return candidate.dataset.format === id;});
            assert.ok(button, `Missing Markdown format ${id}.`);
            const event = new Event('click');
            Object.defineProperty(event, 'target', {value: button});
            toolbar.dispatchEvent(event);
        }
    };
}

test('Markdown editor preserves default controls, complete payloads, formatting and save', async function defaultEditor(context) {
    const fixture = await editorFixture(context);
    const {host, input, title, preview, toolbar, save, status} = fixture;
    assert.equal(host.ready, true);
    assert.equal(host.options.fit, false);
    assert.equal(host.options.followPreview, false);
    assert.equal(host.dataset.fit, 'false');
    assert.deepEqual(fixture.editor.children, [title, preview, toolbar, input, fixture.actions]);
    for (const element of [title, preview, toolbar, save]) assert.equal(element.classList.contains('hidden'), false);
    assert.equal(toolbar.children.length, contracts.MARKDOWN_FORMATS.length);
    assert.equal(fixture.publications[0].type, 'markdown-editor-ready');
    assert.equal(await host.saveEntry(), false);
    assert.equal(status.innerText, host.options.labels.emptyError);
    assert.equal(fixture.document.activeElement, input);

    const changes = [];
    const saves = [];
    host.configure({
        onChange(detail) {changes.push(detail);},
        onSave(payload, operation) {saves.push({payload, operation});}
    });
    const markdown = '  Kraken tea party 🐙\r\n\r\n[Full guest list](https://example.invalid/guests)\n  ';
    const entryTitle = '  <Kraken & friends>  ';
    host.entryTitle = entryTitle;
    preview.scrollTop = 515;
    fixture.edit(markdown);
    assert.deepEqual(changes, [{title: entryTitle, markdown}]);
    fixture.flushFrames();
    assert.equal(fixture.renders.at(-1).raw, markdown);
    assert.equal(preview.scrollTop, 515);
    assert.equal(preview.links[0].target, '_blank');
    assert.equal(preview.links[0].getAttribute('rel'), null);
    assert.equal(await host.saveEntry(), true);
    assert.deepEqual(saves[0].payload, {title: entryTitle, markdown});
    assert.equal(saves[0].operation.signal.aborted, false);
    assert.match(saves[0].operation.operationId, /:save:/u);
    assert.equal(host.value, '');
    assert.equal(host.entryTitle, '');
    assert.equal(status.innerText, host.options.labels.saved);
    assert.equal(save.disabled, false);
    assert.deepEqual(fixture.publications.at(-1).detail, {title: entryTitle, markdown});

    host.value = 'The kraken waves.';
    input.setSelectionRange(4, 10);
    fixture.format('bold');
    assert.equal(host.value, 'The **kraken** waves.');
    assert.deepEqual([input.selectionStart, input.selectionEnd], [6, 12]);
    fixture.flushFrames();
    assert.equal(fixture.renders.at(-1).raw, host.value);
});

test('Markdown editor fit options merge, reset, expose parts and retain independently scrolling panes', async function fitEditor(context) {
    const fixture = await editorFixture(context, {dataset: {fit: 'true', followPreview: 'true'}});
    const {host, editor, title, preview, toolbar, input, actions} = fixture;
    assert.equal(host.options.fit, true);
    assert.equal(host.options.followPreview, true);
    assert.equal(editor.classList.contains('fit'), true);
    assert.deepEqual(editor.children, [title, toolbar, input, preview, actions]);
    host.configure({saveLabel: 'Keep this draft'});
    assert.equal(host.options.fit, true);
    assert.equal(host.options.followPreview, true);
    assert.equal(fixture.save.innerText, 'Keep this draft');
    input.scrollTop = 730;
    preview.scrollTop = 210;
    input.dispatchEvent(new Event('scroll'));
    assert.equal(preview.scrollTop, 210);
    preview.scrollTop = 910;
    preview.dispatchEvent(new Event('scroll'));
    assert.equal(input.scrollTop, 730);
    assert.equal(fixture.frames.size, 0);

    host.configure({showPreview: false});
    assert.equal(editor.classList.contains('without-preview'), true);
    assert.equal(preview.classList.contains('hidden'), true);
    host.configure({fit: false, followPreview: false, showPreview: true});
    assert.equal(host.dataset.fit, 'false');
    assert.equal(host.options.followPreview, false);
    assert.equal(editor.classList.contains('fit'), false);
    assert.deepEqual(editor.children, [title, preview, toolbar, input, actions]);
    const copiedOptions = host.options;
    copiedOptions.labels.save = 'Changed copy';
    copiedOptions.formats[0].label = 'Changed copy';
    assert.equal(host.options.labels.save, 'Keep this draft');
    assert.equal(host.options.formats[0].label, 'Heading');
    const enabled = contracts.normalizeMarkdownOptions({fit: true, followPreview: true});
    const reset = contracts.normalizeMarkdownOptions({fit: false, followPreview: false}, enabled);
    assert.equal(reset.fit, false);
    assert.equal(reset.followPreview, false);
    const strings = contracts.normalizeMarkdownOptions({fit: 'true', followPreview: 'true'});
    assert.equal(strings.fit, false);
    assert.equal(strings.followPreview, false);

    for (const part of ['editor', 'title', 'preview', 'toolbar', 'input', 'actions', 'status', 'save-action']) {
        assert.ok(source.includes(`part="${part}"`), `Missing public editor part ${part}.`);
    }
    const paneStyles = source.match(/\.fit \.entry-markdown,\s*\.fit \.preview\s*\{([^}]+)\}/u)[1];
    assert.match(paneStyles, /min-height:\s*0/u);
    assert.match(paneStyles, /overflow:\s*auto/u);
    assert.match(source, /@container arcane-markdown-editor/u);
});

test('Markdown editor retains labels, hidden controls, read-only and save failure behavior', async function configuredEditor(context) {
    const fixture = await editorFixture(context);
    const {host, title, input, preview, toolbar, save, status} = fixture;
    const failure = new Error('The kraken declined this filing.');
    host.configure({
        initialTitle: 'The title stays plain <text>',
        initialValue: '  A complete draft.\n',
        titlePlaceholder: 'Entry title', bodyPlaceholder: 'Full Markdown',
        previewLabel: 'Rendered entry', toolbarLabel: 'Format entry',
        clearOnSave: false,
        onSave() {throw failure;}
    });
    assert.equal(title.getAttribute('aria-label'), 'Entry title');
    assert.equal(input.getAttribute('aria-label'), 'Full Markdown');
    assert.equal(preview.getAttribute('aria-label'), 'Rendered entry');
    assert.equal(toolbar.getAttribute('aria-label'), 'Format entry');
    assert.equal(await host.saveEntry(), false);
    assert.equal(status.innerText, host.options.labels.saveError);
    assert.equal(fixture.errors[0][1], failure);
    assert.equal(host.value, '  A complete draft.\n');
    assert.equal(host.entryTitle, 'The title stays plain <text>');
    host.configure({readOnly: true, showTitle: false, showToolbar: false, showSave: false});
    assert.equal(title.readOnly, true);
    assert.equal(input.readOnly, true);
    assert.equal(save.disabled, true);
    for (const control of [title, toolbar, save]) assert.equal(control.classList.contains('hidden'), true);
    assert.ok(toolbar.children.every(function disabledFormat(button) {return button.disabled;}));
    fixture.format('bold');
    assert.equal(host.value, '  A complete draft.\n');
    assert.equal(await host.saveEntry(), false);
    host.configure({readOnly: false, showSave: true, onSave() {}});
    assert.equal(await host.saveEntry(), true);
    assert.equal(host.value, '  A complete draft.\n');
    assert.equal(host.clear(), true);
    assert.equal(host.value, '');
    assert.equal(host.entryTitle, '');
});

test('Markdown editor preserves source viewport and selection through configuration, replacement and formatting', async function preserveSourceView(context) {
    const fixture = await editorFixture(
        context,
        {dataset: {fit: 'true', followPreview: 'true'}, viewportEffects: true}
    );
    const {host, input, title, preview, toolbar, editor, actions} = fixture;
    const markdown = 'The kraken waves.\n\nThe complete journal remains here.\n';
    const entryTitle = '  <Kraken & friends>  ';
    const saves = [];
    host.configure(
        {
            initialValue: markdown,
            initialTitle: entryTitle,
            clearOnSave: false,
            onSave(payload) {saves.push(payload);}
        }
    );
    input.focus({preventScroll: true});
    input.setSelectionRange(4, 10, 'backward');
    input.scrollTop = 730;
    input.scrollLeft = 51;
    const movesBeforeUpdate = fixture.treeMoves.length;
    host.configure({saveLabel: 'Keep this draft'});
    assert.equal(fixture.treeMoves.length, movesBeforeUpdate, 'An unchanged layout must not reparent controls.');
    host.configure({fit: false});
    assert.deepEqual(editor.children, [title, preview, toolbar, input, actions]);
    host.configure({fit: true});
    assert.deepEqual(editor.children, [title, toolbar, input, preview, actions]);
    assert.equal(fixture.treeMoves.includes(input), false, 'Layout changes must keep the live textarea attached.');
    assert.equal(fixture.document.activeElement, input);

    const extended = `${markdown}The octopus keeps every line.\n`;
    host.value = extended;
    host.configure({initialValue: extended});
    assert.equal(host.value, extended);
    assert.equal(host.entryTitle, entryTitle);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [4, 10, 'backward']);
    assert.deepEqual([input.scrollTop, input.scrollLeft], [730, 51]);

    fixture.format('bold');
    const formatted = extended.replace('kraken', '**kraken**');
    assert.equal(host.value, formatted);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [6, 12, 'backward']);
    assert.deepEqual(input.focusOptions, {preventScroll: true});
    assert.deepEqual([input.scrollTop, input.scrollLeft], [730, 51]);
    fixture.flushFrames();
    assert.equal(fixture.renders.at(-1).raw, formatted);
    assert.deepEqual([input.scrollTop, input.scrollLeft], [730, 51]);
    assert.equal(await host.saveEntry(), true);
    assert.deepEqual(saves, [{title: entryTitle, markdown: formatted}]);
    assert.equal(host.value, formatted);
    assert.deepEqual([input.scrollTop, input.scrollLeft], [730, 51]);
});

test('Markdown preview retains the latest native editing and manual source viewport before its queued render', async function preserveCurrentSourceView(context) {
    const markdown = 'The kraken reads.\n\nThe octopus keeps the whole journal.\n';
    const second = markdown.indexOf('The octopus');
    const fixture = await editorFixture(
        context,
        {
            dataset: {fit: 'true', followPreview: 'true'},
            viewportEffects: true,
            layout: [
                {start: 0, end: second, marker: 'viewport-first', type: 'paragraph', top: 0, height: 80},
                {start: second, end: markdown.length, marker: 'viewport-second', type: 'paragraph', top: 1700, height: 120}
            ]
        }
    );
    const {input, preview} = fixture;
    fixture.edit(markdown, second + 4);
    // Native typing can reveal its caret; the SDK must not restore an older
    // position captured before that user operation or a later manual scroll.
    input.scrollTop = 620;
    input.scrollLeft = 35;
    input.dispatchEvent(new Event('scroll'));
    input.setSelectionRange(second + 2, second + 8, 'backward');
    input.scrollTop = 880;
    input.scrollLeft = 57;
    input.dispatchEvent(new Event('keydown'));
    input.dispatchEvent(new Event('select'));
    preview.scrollTop = 400;
    fixture.flushFrames();
    assert.deepEqual([input.scrollTop, input.scrollLeft], [880, 57]);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [second + 2, second + 8, 'backward']);
    assert.equal(fixture.renders.at(-1).raw, markdown);
    assert.notEqual(preview.scrollTop, 400, 'Only the preview follows the edited block.');
    input.scrollTop = 270;
    input.scrollLeft = 12;
    input.dispatchEvent(new Event('scroll'));
    assert.equal(fixture.frames.size, 0, 'Manual source scrolling must not schedule a restoration.');
    assert.deepEqual([input.scrollTop, input.scrollLeft], [270, 12]);
});

test('Markdown preview follows the edited source block without coupling independent scrollers', async function followEditedBlock(context) {
    const markdown = '# Kraken seating\n\nSecond room hosts the accordion octopus.\n\nLast room serves tea.\n';
    const second = markdown.indexOf('Second');
    const last = markdown.indexOf('Last');
    const layout = [
        {start: 0, end: second, marker: 'fixture-block-first', type: 'heading', top: 0, height: 100},
        {start: second, end: last, marker: 'fixture-block-second', type: 'paragraph', top: 1500, height: 120},
        {start: last, end: markdown.length, marker: 'fixture-block-last', type: 'paragraph', top: 2200, height: 80}
    ];
    const fixture = await editorFixture(context, {dataset: {fit: 'true', followPreview: 'true'}, layout});
    const {host, preview, input, title} = fixture;
    input.scrollTop = 730;
    preview.scrollTop = 250;
    preview.scrollLeft = 27;
    host.configure({initialValue: markdown});
    assert.equal(preview.scrollTop, 250);
    fixture.edit(markdown, markdown.indexOf('accordion'));
    assert.equal(preview.scrollTop, 250);
    assert.equal(fixture.frames.size, 1);
    fixture.flushFrames();
    assert.equal(fixture.renders.at(-1).raw, markdown);
    assert.equal(fixture.renders.at(-1).options.sourceMap, true);
    const viewport = preview.getBoundingClientRect();
    const editedBlock = preview.children[1].getBoundingClientRect();
    assert.ok(editedBlock.top >= viewport.top && editedBlock.bottom <= viewport.bottom,
        'The edited block must be visible despite unequal source and rendered block lengths.');
    assert.equal(input.scrollTop, 730);
    assert.equal(preview.scrollLeft, 27);

    preview.scrollTop = 250;
    fixture.edit(markdown, markdown.length);
    input.setSelectionRange(second + 2, markdown.length);
    input.selectionDirection = 'backward';
    fixture.flushFrames();
    const selectedBlock = preview.children[1].getBoundingClientRect();
    assert.ok(selectedBlock.top >= viewport.top && selectedBlock.bottom <= viewport.bottom);
    input.selectionDirection = 'forward';

    preview.scrollTop = 420;
    preview.dispatchEvent(new Event('scroll'));
    input.scrollTop = 900;
    input.dispatchEvent(new Event('scroll'));
    input.setSelectionRange(markdown.length, markdown.length);
    input.dispatchEvent(new Event('select'));
    input.dispatchEvent(new Event('keydown'));
    assert.equal(fixture.frames.size, 0);
    assert.equal(preview.scrollTop, 420);
    assert.equal(input.scrollTop, 900);
    title.value = 'Changed title';
    title.dispatchEvent(new Event('input'));
    fixture.flushFrames();
    assert.equal(preview.scrollTop, 420);
    fixture.edit(markdown, markdown.indexOf('accordion'));
    host.value = markdown;
    assert.equal(fixture.frames.size, 0);
    assert.equal(preview.scrollTop, 420);
    fixture.edit(markdown, markdown.indexOf('accordion'));
    host.configure({saveLabel: 'Save complete entry'});
    assert.equal(fixture.frames.size, 0);
    assert.equal(preview.scrollTop, 420);
    assert.equal(input.scrollTop, 900);

    fixture.edit(markdown, markdown.indexOf('accordion'));
    fixture.flushFrames();
    assert.notEqual(preview.scrollTop, 420);
    assert.equal(input.scrollTop, 900);
    host.configure({followPreview: false});
    preview.scrollTop = 330;
    fixture.edit(markdown, markdown.length);
    fixture.flushFrames();
    assert.equal(preview.scrollTop, 330);
});

test('Markdown preview keeps manual reader intent until another body edit or format action', async function preserveManualPreview(context) {
    const markdown = 'The kraken opens the book.\n\nThe octopus keeps reading.\n';
    const second = markdown.indexOf('The octopus');
    const layout = [
        {start: 0, end: second, marker: 'reader-first', type: 'paragraph', top: 0, height: 100},
        {start: second, end: markdown.length, marker: 'reader-second', type: 'paragraph', top: 1700, height: 120}
    ];
    const fixture = await editorFixture(context, {dataset: {fit: 'true', followPreview: 'true'}, layout});
    const {preview, input} = fixture;
    for (const readerEvent of ['wheel', 'pointerdown', 'touchstart', 'keydown']) {
        preview.scrollTop = 450;
        fixture.edit(markdown, markdown.length);
        preview.dispatchEvent(new Event(readerEvent));
        fixture.flushFrames();
        assert.equal(preview.scrollTop, 450, readerEvent);
        assert.equal(fixture.renders.at(-1).raw, markdown);
        fixture.edit(markdown, markdown.length);
        fixture.flushFrames();
        assert.notEqual(preview.scrollTop, 450, readerEvent);
    }
    preview.scrollTop = 450;
    preview.dispatchEvent(new Event('wheel'));
    layout[1].end = markdown.length + 4;
    input.setSelectionRange(second, second + 11);
    fixture.format('bold');
    fixture.flushFrames();
    assert.equal(fixture.host.value, 'The kraken opens the book.\n\n**The octopus** keeps reading.\n');
    assert.notEqual(preview.scrollTop, 450);
});

test('Markdown preview follows the approximate caret position inside a tall block', async function followTallBlock(context) {
    const markdown = 'A kraken paragraph.\nA kraken paragraph.\n';
    const layout = [
        {start: 0, end: markdown.length, marker: 'tall-paragraph', type: 'paragraph', top: 1000, height: 1200}
    ];
    const fixture = await editorFixture(context, {dataset: {fit: 'true', followPreview: 'true'}, layout});
    fixture.input.scrollTop = 610;
    const caret = markdown.indexOf('A', 1);
    fixture.edit(markdown, caret);
    fixture.flushFrames();
    const expectedPosition = layout[0].top + caret / markdown.length * layout[0].height;
    assert.equal(fixture.preview.scrollTop, expectedPosition - fixture.preview.clientHeight / 2);
    assert.equal(fixture.input.scrollTop, 610);
    assert.equal(fixture.renders.at(-1).raw, markdown);
});

test('Markdown preview uses a nearby visible block for invisible or absorbed source anchors', async function followVisibleNeighbor(context) {
    const markdown = 'The kraken reads.\n\nA hidden intermission.\n\nThe octopus resumes.\n';
    const hidden = markdown.indexOf('A hidden');
    const last = markdown.indexOf('The octopus');
    for (const absorbed of [false, true]) {
        const layout = [
            {start: 0, end: hidden, marker: 'visible-before', type: 'paragraph', top: 0, height: 80},
            {start: hidden, end: last, marker: 'hidden-block', type: 'html', top: 800, height: 0, absorbed},
            {start: last, end: markdown.length, marker: 'visible-after', type: 'paragraph', top: 1700, height: 120}
        ];
        const fixture = await editorFixture(context, {dataset: {fit: 'true', followPreview: 'true'}, layout});
        fixture.preview.scrollTop = 450;
        fixture.input.scrollTop = 320;
        fixture.edit(markdown, last - 1);
        fixture.flushFrames();
        const viewport = fixture.preview.getBoundingClientRect();
        const visibleNeighbor = fixture.preview.children[2].getBoundingClientRect();
        assert.ok(visibleNeighbor.top >= viewport.top && visibleNeighbor.bottom <= viewport.bottom,
            absorbed ? 'An absorbed marker must allow nearby visible content to follow.' : 'An invisible block must allow nearby visible content to follow.');
        assert.equal(fixture.input.scrollTop, 320);
        assert.equal(fixture.renders.at(-1).raw, markdown);
    }
});

test('Markdown edits cancel pending saves and destruction releases queued preview work', async function editorCleanup(context) {
    const fixture = await editorFixture(context, {dataset: {fit: 'true', followPreview: 'true'}});
    const {host, preview, input} = fixture;
    const operations = [];
    host.configure({onSave(_payload, operation) {
        return new Promise(function pendingSave(resolve) {operations.push({...operation, resolve});});
    }});
    host.value = 'First draft';
    const firstSave = host.saveEntry();
    fixture.edit('Second draft');
    assert.equal(operations[0].signal.aborted, true);
    operations[0].resolve();
    assert.equal(await firstSave, false);
    assert.equal(host.value, 'Second draft');
    assert.equal(fixture.publications.some(function saved(event) {return event.type === 'markdown-editor-saved';}), false);
    fixture.edit('Final draft');
    assert.equal(fixture.frames.size, 1);
    const pendingFrame = [...fixture.frames.values()][0];
    const rendersBeforeDestroy = fixture.renders.length;
    const secondSave = host.saveEntry();
    assert.equal(host.destroy(), true);
    assert.equal(host.destroy(), false);
    assert.equal(operations[1].signal.aborted, true);
    assert.equal(host.ready, false);
    assert.equal(fixture.eventSourceDisposed, true);
    assert.equal(fixture.frames.size, 0);
    assert.ok(fixture.cancelledFrames.length > 0);
    assert.deepEqual(preview.children, []);
    const publicationsBeforeLateInput = fixture.publications.length;
    input.dispatchEvent(new Event('input'));
    pendingFrame(0);
    assert.equal(fixture.renders.length, rendersBeforeDestroy);
    assert.equal(fixture.publications.length, publicationsBeforeLateInput);
    assert.equal(fixture.frames.size, 0);
    operations[1].resolve();
    assert.equal(await secondSave, false);
    assert.equal(host.configure({fit: true}), false);
    assert.equal(host.clear(), false);
    assert.equal(host.focus(), false);
    assert.equal(await host.saveEntry(), false);
});
