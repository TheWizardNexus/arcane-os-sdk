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
    script.replaceAll('import(', 'loadDependency(')
);

// Run the complete component script with controlled DOM geometry. Markdown
// parsing and native browser layout have their own owners; this fixture supplies
// explicit source-map records and rendered blocks without implementing a parser.
async function editorFixture(context, {dataset = {}, layout = [], images = [], manualMedia = false, beforePrintCapture, viewportEffects = false} = {}) {
    const publications = [];
    const errors = [];
    const renders = [];
    const frames = new Map();
    const cancelledFrames = [];
    const treeMoves = [];
    const printCalls = [];
    const printSessions = [];
    const mediaHandles = [];
    const dependencies = [];
    const document = {activeElement: null};
    let frameSequence = 0;
    let eventSourceDisposed = false;
    let renderedEntries = [];
    let renderedImages = [];
    let preview;
    let printOptions;

    class Element extends EventTarget {
        constructor(tagName = 'section') {
            super();
            this.tagName = tagName.toUpperCase();
            this.localName = tagName.toLowerCase();
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
                    this.append(...node.childNodes);
                    continue;
                }
                if (node.parentNode) {
                    node.parentNode.childNodes = node.parentNode.childNodes.filter(function other(child) {return child !== node;});
                    node.parentNode.children = node.parentNode.children.filter(function other(child) {return child !== node;});
                }
                node.parentElement = this.nodeType === 1 ? this : null;
                node.parentNode = this;
                if (node.nodeType === 1) this.children.push(node);
                this.childNodes.push(node);
            }
        }

        replaceChildren(...nodes) {
            for (const child of this.childNodes) {
                child.parentNode = null;
                child.parentElement = null;
            }
            this.children = [];
            this.childNodes = [];
            this.append(...nodes);
            // A live preview replacement may affect layout; detached template
            // parsing alone does not change either editor viewport.
            if (viewportEffects && this === preview) {
                input.scrollTop = 0;
                input.scrollLeft = 0;
            }
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
            const siblings = this.parentNode?.childNodes ?? [];
            return siblings[siblings.indexOf(this) + 1] ?? null;
        }

        get isConnected() {return this.connected === true || Boolean(this.parentNode?.isConnected);}
        get comments() {
            return this.childNodes.flatMap(function comments(node) {
                return node.nodeType === 8 ? [node] : node.comments ?? [];
            });
        }
        get links() {return this.querySelectorAll('a');}

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
        setRangeText(text, start, end, mode) {
            assert.equal(mode, 'end');
            this.value = this.value.slice(0, start) + text + this.value.slice(end);
            this.setSelectionRange(start + text.length, start + text.length);
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
        querySelectorAll(selector) {
            return this.childNodes.flatMap(function matching(child) {
                return [...(child.localName === selector ? [child] : []), ...(child.querySelectorAll?.(selector) ?? [])];
            });
        }

        getBoundingClientRect() {
            const top = this === preview ? 100 : 100 + (this.contentTop ?? 0) - preview.scrollTop;
            const height = this === preview ? this.clientHeight : this.contentHeight ?? 80;
            return {top, bottom: top + height, height, left: 0, right: 400, width: 400};
        }

        get innerHTML() {return this.html ?? '';}
        set innerHTML(value) {
            this.html = value;
            const target = this.localName === 'template' ? this.content : this;
            target.replaceChildren();
            for (const entry of renderedEntries) {
                const block = new Element('p');
                block.contentTop = entry.top;
                block.contentHeight = entry.height;
                const marker = {
                    nodeType: 8,
                    data: entry.marker,
                    nodeValue: entry.marker,
                    get nextSibling() {
                        const siblings = this.parentNode?.childNodes ?? [];
                        return siblings[siblings.indexOf(this) + 1] ?? null;
                    }
                };
                if (!entry.absorbed) {
                    target.append(marker);
                }
                target.append(block);
            }
            if (!target.children.length) target.append(new Element('p'));
            const link = new Element('a');
            link.setAttribute('rel', 'fixture-link-relation');
            target.children[0].append(link);
            for (const descriptor of renderedImages) {
                const image = new Element('img');
                for (const [name, value] of Object.entries(descriptor)) image.setAttribute(name, value);
                target.children[0].append(image);
            }
        }
    }

    const editor = new Element();
    const title = new Element('input');
    preview = new Element();
    const toolbar = new Element();
    const input = new Element('textarea');
    const actions = new Element();
    const status = new Element('span');
    const mediaStatus = new Element('span');
    const save = new Element('button');
    const print = new Element('button');
    actions.append(status, mediaStatus, print, save);
    editor.append(title, preview, toolbar, input, actions);
    const elements = new Map([
        ['.markdown-editor', editor], ['#entryTitle', title], ['#preview', preview],
        ['#toolbar', toolbar], ['#entryMarkdown', input], ['#save', save], ['#print', print], ['#status', status], ['#mediaStatus', mediaStatus]
    ]);
    const host = new Element('html-import');
    host.dataset = {...dataset};
    host.connected = true;
    editor.parentNode = host;
    host.shadowRoot = {querySelector(selector) {return elements.get(selector);}};
    document.createElement = function createElement(tagName) {
        const element = new Element(tagName);
        if (tagName === 'template') element.content = document.createDocumentFragment();
        return element;
    };
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
            renderedImages = raw ? images : [];
            this.sourceMap = renderedEntries.map(
                function sourceEntry({start, end, marker, type}) {return {start, end, marker, type};}
            );
            this.safeRendered = '<p>The fixture supplies rendered Markdown.</p>';
        }
    }

    async function loadDependency(specifier) {
        dependencies.push(specifier);
        if (specifier === 'strong-type') return {default: Is};
        if (specifier.startsWith('../modules/MD.js')) return {default: Markdown};
        if (specifier === '../modules/MarkdownMedia.js') {
            return {hydrateMarkdownMedia(root, {signal}) {
                assert.equal(root.nodeType, 11);
                assert.equal(root.isConnected, false);
                const localImages = root.querySelectorAll('img').filter(function localImage(image) {
                    return image.getAttribute('src')?.startsWith('arcane-media:');
                });
                const references = localImages.map(function reference(image) {return image.getAttribute('src');});
                for (const image of localImages) image.removeAttribute('src');
                let resolve;
                let reject;
                const ready = new Promise(function pendingMedia(accept, fail) {resolve = accept; reject = fail;});
                const handle = {
                    root, localImages, references, signal, ready,
                    destroyed: false, retained: 0, released: 0, retainers: 0, urls: [], revoked: [],
                    resolve() {
                        if (handle.destroyed) {
                            reject(new DOMException('Media display was destroyed.', 'AbortError'));
                            return;
                        }
                        for (const [index, image] of localImages.entries()) {
                            const url = `blob:fixture-media-${mediaHandles.indexOf(handle)}-${index}`;
                            handle.urls.push({image, url});
                            image.setAttribute('src', url);
                        }
                        resolve();
                    },
                    reject,
                    destroy() {
                        if (handle.destroyed) return;
                        handle.destroyed = true;
                        signal.removeEventListener('abort', handle.destroy);
                        const reason = new DOMException('Media display was destroyed.', 'AbortError');
                        const failure = new AggregateError(localImages.map(function cancelledImage() {return reason;}), 'Local image display was cancelled.');
                        failure.failures = localImages.map(function cancelledImage(image, index) {
                            return {image, reference: references[index], reason};
                        });
                        reject(localImages.length ? failure : reason);
                        releaseURLs();
                    },
                    retain() {
                        assert.equal(handle.destroyed, false);
                        handle.retained += 1;
                        handle.retainers += 1;
                        let released = false;
                        return function releaseMedia() {
                            if (released) return;
                            released = true;
                            handle.released += 1;
                            handle.retainers -= 1;
                            releaseURLs();
                        };
                    }
                };
                function releaseURLs() {
                    if (!handle.destroyed || handle.retainers) return;
                    for (const {image, url} of handle.urls) {
                        if (image.getAttribute('src') === url) image.removeAttribute('src');
                        handle.revoked.push(url);
                    }
                    handle.urls = [];
                }
                signal.addEventListener('abort', handle.destroy, {once: true});
                mediaHandles.push(handle);
                if (!manualMedia || !localImages.length) handle.resolve();
                return handle;
            }};
        }
        if (specifier === '../modules/ComponentContracts.js') return contracts;
        if (specifier === '../modules/PrintView.js') {
            return {
                createPrintView(options) {
                    printOptions = options;
                    return {
                        async print() {
                            if (options.signal.aborted) return false;
                            const session = {release: options.retain?.(), requested: false};
                            printSessions.push(session);
                            try {
                                options.content();
                                await beforePrintCapture?.();
                                await options.prepare?.(options.signal);
                                if (options.signal.aborted) {
                                    session.release?.();
                                    return false;
                                }
                                printCalls.push({content: options.content(), title: options.title()});
                                session.requested = true;
                                return true;
                            } catch (error) {
                                session.release?.();
                                throw error;
                            }
                        }
                    };
                }
            };
        }
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
    context.after(function destroyEditorFixture() {afterPrint(); host.destroy();});

    function afterPrint() {
        for (const session of printSessions) session.release?.();
        printSessions.length = 0;
    }

    return {
        host, editor, title, preview, toolbar, input, actions, status, mediaStatus, save, print, document,
        publications, errors, renders, frames, cancelledFrames, treeMoves, printCalls, mediaHandles, dependencies, afterPrint,
        nativePrint() {
            let release;
            try {
                release = printOptions.retain?.();
                printCalls.push({content: printOptions.content(), title: printOptions.title()});
                printSessions.push({release, requested: true});
                return true;
            } catch (error) {
                release?.();
                printOptions.onError(error);
                return false;
            }
        },
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

test('Markdown insertion replaces the current selection and emits the ordinary full change', async function markdownInsertion(context) {
    const fixture = await editorFixture(context, {dataset: {followPreview: 'true'}, viewportEffects: true});
    const {host, input} = fixture;
    host.entryTitle = 'Octopus mural';
    host.value = 'Before\nREPLACE\nAfter  ';
    input.setSelectionRange(7, 14, 'backward');
    input.scrollTop = 517;
    input.scrollLeft = 11;
    const inserted = '![Eight arms](saved-image.png)\n';
    const changes = [];
    host.configure({onChange(detail) {changes.push(detail);}});
    assert.equal(host.insertMarkdown(inserted), true);
    const expected = 'Before\n' + inserted + '\nAfter  ';
    assert.equal(host.value, expected);
    assert.equal(input.selectionStart, 7 + inserted.length);
    assert.equal(input.selectionEnd, input.selectionStart);
    assert.equal(input.scrollTop, 517);
    assert.equal(input.scrollLeft, 11);
    assert.deepEqual(changes, [{markdown: expected, title: 'Octopus mural'}]);
    assert.equal(fixture.frames.size, 1);
    assert.deepEqual(input.focusOptions, {preventScroll: true});
    fixture.flushFrames();
    assert.equal(fixture.renders.at(-1).raw, expected);
    host.configure({readOnly: true});
    assert.equal(host.insertMarkdown('ignored'), false);
    assert.equal(host.value, expected);
    host.destroy();
    assert.equal(host.insertMarkdown('ignored'), false);
});

test('Markdown printing uses the current rendered body and complete title without saving', async function renderedPrintContract(context) {
    const fixture = await editorFixture(context, {viewportEffects: true});
    const {host, input, preview} = fixture;
    const title = '  Octopus minutes: every arm accounted for  ';
    const markdown = '# Complete minutes\n\n![Eight signatures](signatures.png)\n\nFinal motion.\n';
    host.entryTitle = title;
    fixture.edit(markdown);
    input.scrollTop = 731;
    input.scrollLeft = 12;
    const selection = [input.selectionStart, input.selectionEnd, input.selectionDirection];
    assert.equal(fixture.frames.size, 1);
    assert.equal(await host.print(), true);
    assert.equal(fixture.frames.size, 0);
    assert.equal(fixture.renders.at(-1).raw, markdown);
    assert.deepEqual(fixture.printCalls, [{content: preview, title}]);
    assert.equal(input.scrollTop, 731);
    assert.equal(input.scrollLeft, 12);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], selection);
    assert.equal(host.value, markdown);
    assert.equal(fixture.publications.some(function saved(event) {return event.type === 'markdown-editor-saved';}), false);
    host.destroy();
    assert.equal(await host.print(), false);
    assert.equal(fixture.printCalls.length, 1);
});

test('Markdown editor hydrates detached image nodes while preserving source, comments and ordinary image URLs', async function localPreviewMedia(context) {
    const reference = 'arcane-media:journal-media/octopus.json';
    const markdown = `  # Octopus mural\n\n![Every arm](${reference})\n  `;
    const fixture = await editorFixture(context, {
        dataset: {fit: 'true', followPreview: 'true'},
        viewportEffects: true,
        manualMedia: true,
        images: [{src: reference, alt: 'Every arm'}, {src: 'https://images.example.test/moon.png', alt: 'Moon'}],
        layout: [{start: 0, end: markdown.length, marker: 'media-source-anchor', type: 'paragraph', top: 0, height: 80}]
    });
    const {host, input, preview} = fixture;
    host.value = markdown;
    input.focus({preventScroll: true});
    input.setSelectionRange(3, 11, 'backward');
    input.scrollTop = 480;
    input.scrollLeft = 17;
    preview.scrollTop = 260;
    host.configure({clearOnSave: false});
    const handle = fixture.mediaHandles.at(-1);
    const rendered = preview.querySelectorAll('img');
    assert.deepEqual(handle.references, [reference]);
    assert.equal(handle.root.childNodes.length, 0, 'Connecting a DocumentFragment moves every child, including comments.');
    assert.equal(rendered[0].getAttribute('src'), null, 'The custom scheme was removed before connection.');
    assert.equal(rendered[0].isConnected, true);
    assert.equal(rendered[1].getAttribute('src'), 'https://images.example.test/moon.png');
    assert.deepEqual(preview.comments.map(function marker(comment) {return comment.data;}), ['media-source-anchor']);
    assert.equal(preview.comments[0].parentNode, preview);
    assert.equal(preview.comments[0].nextSibling, preview.children[0]);
    handle.resolve();
    await handle.ready;
    assert.match(rendered[0].getAttribute('src'), /^blob:fixture-media-/u);
    assert.equal(host.value, markdown);
    assert.equal(fixture.renders.at(-1).raw, markdown);
    assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [3, 11, 'backward']);
    assert.deepEqual([input.scrollTop, input.scrollLeft, preview.scrollTop], [480, 17, 260]);
    assert.equal(fixture.document.activeElement, input);
    assert.equal(fixture.mediaStatus.innerText, '');
    const mdImport = fixture.dependencies.indexOf('../modules/MD.js');
    assert.equal(fixture.dependencies[mdImport + 1], '../modules/MarkdownMedia.js');
    assert.equal(fixture.dependencies.includes('../modules/DBOPFS.js'), false);
});

test('explicit Markdown print follows replacement hydration without waiting for a retired storage read', async function printLatestMedia(context) {
    const images = [{src: 'arcane-media:journal-media/first.json'}];
    const fixture = await editorFixture(context, {images, manualMedia: true});
    fixture.host.value = '![First](arcane-media:journal-media/first.json)';
    const first = fixture.mediaHandles.at(-1);
    const printing = fixture.host.print();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fixture.printCalls.length, 0);
    images[0] = {src: 'arcane-media:journal-media/second.json'};
    const replacement = '![Second](arcane-media:journal-media/second.json)\nComplete replacement.';
    fixture.host.value = replacement;
    const second = fixture.mediaHandles.at(-1);
    assert.equal(first.destroyed, true);
    second.resolve();
    assert.equal(await printing, true);
    assert.equal(fixture.renders.at(-1).raw, replacement);
    assert.equal(fixture.printCalls.length, 1);
    first.resolve();
    await first.ready.catch(function expectedRetiredRead() {});
    assert.equal(fixture.mediaStatus.innerText, '');
    assert.equal(fixture.errors.length, 0);
});

test('Markdown printing rechecks hydration during preparation and retains replacement media until afterprint', async function mediaPrintRetention(context) {
    let finishPreparation;
    let enteredPreparation;
    const pendingPreparation = new Promise(function waitForPreparation(resolve) {finishPreparation = resolve;});
    const startedPreparation = new Promise(function watchPreparation(resolve) {enteredPreparation = resolve;});
    const fixture = await editorFixture(context, {
        images: [{src: 'arcane-media:journal-media/mural.json'}],
        manualMedia: true,
        beforePrintCapture() {enteredPreparation(); return pendingPreparation;}
    });
    fixture.host.value = '![Mural](arcane-media:journal-media/mural.json)';
    const first = fixture.mediaHandles.at(-1);
    first.resolve();
    await first.ready;
    const printing = fixture.host.print();
    await startedPreparation;
    fixture.host.value = 'Updated caption.\n![Mural](arcane-media:journal-media/mural.json)';
    const second = fixture.mediaHandles.at(-1);
    assert.equal(first.retained, 1);
    assert.equal(first.destroyed, true);
    assert.equal(first.revoked.length, 0);
    assert.equal(second.retained, 1);
    finishPreparation();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fixture.printCalls.length, 0);
    second.resolve();
    assert.equal(await printing, true);
    fixture.host.destroy();
    assert.equal(first.revoked.length, 0);
    assert.equal(second.revoked.length, 0);
    fixture.afterPrint();
    assert.equal(first.revoked.length, 1);
    assert.equal(second.revoked.length, 1);
    assert.equal(first.released, 1);
    assert.equal(second.released, 1);
    fixture.afterPrint();
    assert.equal(first.released, 1);
});

test('native Markdown print reports pending media while independent save status and full content remain intact', async function nativeMediaReadiness(context) {
    const reference = 'arcane-media:journal-media/mural.json';
    const fixture = await editorFixture(context, {images: [{src: reference}], manualMedia: true});
    const markdown = `  Complete draft.\n![Mural](${reference})\n`;
    fixture.host.value = markdown;
    fixture.status.innerText = 'Saved draft';
    assert.equal(fixture.nativePrint(), false);
    assert.equal(fixture.printCalls.length, 0);
    assert.match(fixture.mediaStatus.innerText, /still loading/u);
    assert.equal(fixture.status.innerText, 'Saved draft');
    assert.equal(fixture.errors.at(-1)[1].code, 'ARCANE_MARKDOWN_MEDIA_PENDING');
    const handle = fixture.mediaHandles.at(-1);
    handle.resolve();
    await handle.ready;
    assert.equal(fixture.nativePrint(), true);
    assert.equal(fixture.host.value, markdown);
    assert.equal(fixture.status.innerText, 'Saved draft');
});

test('Markdown media failures preserve every diagnostic reason and do not replace Markdown or save state', async function failedPreviewMedia(context) {
    const reference = 'arcane-media:journal-media/missing.json';
    const fixture = await editorFixture(context, {images: [{src: reference}], manualMedia: true});
    const saves = [];
    const markdown = `  Complete draft with ![Missing](${reference})\n`;
    fixture.host.configure({initialValue: markdown, clearOnSave: false, onSave(value) {saves.push(value);}});
    const handle = fixture.mediaHandles.at(-1);
    const failure = new AggregateError([new Error('The complete storage diagnostic.')], 'Image hydration failed.');
    failure.failures = [{image: handle.localImages[0], reference, reason: failure.errors[0]}];
    handle.reject(failure);
    await handle.ready.catch(function observedFixtureFailure() {});
    assert.equal(fixture.errors[0][1], failure);
    assert.equal(fixture.mediaStatus.innerText, 'Some saved images could not be displayed.');
    assert.equal(fixture.host.value, markdown);
    await assert.rejects(fixture.host.print(), function originalMediaFailure(error) {return error === failure;});
    assert.equal(fixture.printCalls.length, 0);
    assert.equal(await fixture.host.saveEntry(), true);
    assert.deepEqual(saves, [{title: '', markdown}]);
    assert.equal(fixture.status.innerText, fixture.host.options.labels.saved);
    assert.equal(fixture.mediaStatus.innerText, 'Some saved images could not be displayed.');
});

test('destroying the Markdown editor settles a print waiting on uncooperative media', async function destroyedMediaPrint(context) {
    const fixture = await editorFixture(context, {images: [{src: 'arcane-media:journal-media/pending.json'}], manualMedia: true});
    fixture.host.value = '![Pending](arcane-media:journal-media/pending.json)';
    const handle = fixture.mediaHandles.at(-1);
    const printing = fixture.host.print();
    await Promise.resolve();
    fixture.host.destroy();
    assert.equal(await printing, false);
    assert.equal(handle.destroyed, true);
    assert.equal(fixture.printCalls.length, 0);
    handle.resolve();
    await handle.ready.catch(function expectedDestroyedRead() {});
    assert.equal(fixture.errors.length, 0);
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
