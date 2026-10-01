import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';

// The complete component script and MarkdownMedia helper run against named DOM,
// storage, Markdown, image-decode, and PrintView callback doubles. These cases cover preview ownership and public
// callback contracts; the PrintView double does not clone DOM or invoke printing.
// Native media decoding, Markdown parsing, and browser layout are separate seams.
async function fileManagerFixture(options = {}) {
    const keysRead = [];
    const metadataRead = [];
    const fileReads = [];
    const createdURLs = [];
    const revokedURLs = [];
    const errors = [];
    const printViews = [];
    const printRequests = [];
    const modalWaits = [];
    const modalCloseEvents = [];
    const dependencyImports = [];
    const markdownReads = [];
    const markdownHandles = [];
    const ready = Promise.withResolvers();
    const files = options.files || {
        visible: {'entry.txt': {text: 'Complete document', mime: 'text/plain'}}
    };

    class FakeText {
        constructor(content) {this.textContent = content;}
        get outerHTML() {return this.textContent;}
    }

    class FakeElement {
        constructor(localName = 'div') {
            this.localName = localName;
            this.childNodes = [];
            this.attributes = new Map();
            this.listeners = new Map();
            this.dataset = {};
            this.className = '';
            this.parentElement = null;
            this.paused = false;
            this.loads = 0;
            if (localName === 'template') this.content = new FakeElement('#document-fragment');
            const properties = new Map();
            this.style = {
                getPropertyValue(name) {return properties.get(name) || '';},
                setProperty(name, value) {properties.set(name, value);}
            };
        }

        get children() {return this.childNodes.filter(function elementChild(child) {return child instanceof FakeElement;});}
        get src() {return this.getAttribute('src') ?? '';}
        set src(value) {this.setAttribute('src', value);}
        get href() {return this.getAttribute('href') ?? '';}
        set href(value) {this.setAttribute('href', value);}
        get textContent() {return this.childNodes.map(function nodeText(child) {return child.textContent;}).join('');}
        set textContent(value) {this.replaceChildren(new FakeText(String(value)));}
        get innerText() {return this.textContent;}
        set innerText(value) {this.textContent = value;}
        get innerHTML() {
            return (this.content || this).childNodes.map(function nodeHTML(child) {return child.outerHTML;}).join('');
        }
        set innerHTML(html) {
            const target = this.content || this;
            target.replaceChildren();
            const stack = [target];
            // The Markdown double emits this explicit wrapper/IMG HTML subset;
            // template content is inert and fragment insertion moves its nodes.
            for (const [token] of html.matchAll(/<\/?[\w-]+(?:\s+[^<>]*?)?\/?>|[^<]+|</gu)) {
                if (token.startsWith('</')) {
                    stack.pop();
                } else if (token.startsWith('<') && token !== '<') {
                    const tag = /^<([\w-]+)/u.exec(token)[1];
                    const child = new FakeElement(tag);
                    for (const [, name, value] of token.matchAll(/([\w-]+)="([^"]*)"/gu)) {
                        child.setAttribute(name, value.replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
                    }
                    stack.at(-1).append(child);
                    if (!['img', 'br', 'hr', 'input'].includes(tag) && !token.endsWith('/>')) stack.push(child);
                } else {
                    stack.at(-1).append(new FakeText(token));
                }
            }
        }
        get outerHTML() {
            const attributes = [...this.attributes].map(function htmlAttribute([name, value]) {
                return ` ${name}="${value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
            }).join('');
            return ['img', 'br', 'hr', 'input'].includes(this.localName)
                ?`<${this.localName}${attributes}>`
                :`<${this.localName}${attributes}>${this.innerHTML}</${this.localName}>`;
        }
        decode() {return options.decodeMarkdown?.(this) ?? Promise.resolve();}

        addEventListener(type, listener, configuration = {}) {
            const listeners = this.listeners.get(type) || new Set();
            listeners.add(listener);
            this.listeners.set(type, listeners);
            configuration.signal?.addEventListener(
                'abort',
                function removeAbortedListener() {listeners.delete(listener);},
                {once: true}
            );
        }

        async fire(type, event = {}) {
            if (typeof this[`on${type}`] === 'function') await this[`on${type}`](event);
            for (const listener of this.listeners.get(type) || []) {
                await listener.call(this, event);
            }
        }

        setAttribute(name, value) {this.attributes.set(name, String(value));}
        getAttribute(name) {return this.attributes.get(name) ?? null;}
        hasAttribute(name) {return this.attributes.has(name);}
        removeAttribute(name) {
            this.attributes.delete(name);
            if (name === 'srcdoc') this.srcdoc = '';
        }
        toggleAttribute(name, enabled) {
            if (enabled) this.setAttribute(name, '');
            else this.removeAttribute(name);
        }
        append(...children) {
            for (const child of children) {
                if (child.localName === '#document-fragment') {
                    this.append(...child.childNodes);
                    child.childNodes = [];
                    continue;
                }
                child.remove?.();
                child.parentElement = this;
                this.childNodes.push(child);
            }
        }
        prepend(child) {
            child.parentElement = this;
            this.childNodes.unshift(child);
        }
        replaceChildren(...children) {
            for (const child of this.children) child.parentElement = null;
            this.childNodes = [];
            this.append(...children);
        }
        remove() {
            const parent = this.parentElement;
            if (parent) parent.childNodes = parent.childNodes.filter(function retainSibling(child) {return child !== this;}, this);
            this.parentElement = null;
        }
        cloneNode() {return new FakeElement(this.localName);}
        pause() {this.paused = true;}
        load() {this.loads += 1;}
        focus() {}
        closest(selector) {
            for (let element = this; element; element = element.parentElement) {
                if (selector.startsWith('.') && element.className.split(' ').includes(selector.substring(1))) return element;
            }
            return null;
        }
        contains(candidate) {
            return candidate === this || this.children.some(function containsChild(child) {return child.contains(candidate);});
        }
        querySelectorAll(selector) {
            const result = [];
            function visit(element) {
                for (const child of element.children) {
                    if (selector === '[data-file-path]' && child.dataset.filePath !== undefined) result.push(child);
                    if (selector === 'img' && child.localName === 'img') result.push(child);
                    visit(child);
                }
            }
            visit(this);
            return result;
        }
    }

    class FakeModal extends FakeElement {
        constructor(name) {
            super('html-import');
            this.name = name;
            this.ready = true;
            this.opened = false;
            this.openCalls = 0;
        }
        async populate(content) {this.replaceChildren(content);}
        open() {
            this.opened = true;
            this.openCalls += 1;
        }
        async close() {
            modalCloseEvents.push([this.name, 'start']);
            if (await options.closeModal?.(this) === false) return false;
            this.opened = false;
            await this.fire('modal-closed');
            modalCloseEvents.push([this.name, 'finish']);
            return true;
        }
        destroy() {this.opened = false;}
    }

    class FakeMarkdown {
        constructor(content) {
            this.safeRendered = `<fixture-markdown>${content.replace(/!\[([^\]]*)\]\(([^)]+)\)/gu, function renderedImage(_match, alt, reference) {
                return `<img src="${reference}" alt="${alt}">`;
            })}</fixture-markdown>`;
        }
    }

    class FixtureFileEntity {
        constructor(fileName, directory) {
            this.fileName = fileName;
            this.directory = directory;
        }
        async open() {
            fileReads.push([this.directory, this.fileName]);
            const source = files[this.directory][this.fileName];
            await options.readFile?.(this.directory, this.fileName);
            if (source.error) throw source.error;
            const file = new File([source.text || ''], this.fileName, {type: source.mime || ''});
            file.ext = this.fileName.split('.').at(-1);
            file.mime = source.mime || 'application/octet-stream';
            file.parsed = source.parsed ?? null;
            file.text = async function readFixtureText() {return source.text || '';};
            return file;
        }
    }

    class FixtureURL extends URL {
        static createObjectURL(content) {
            const url = `blob:fixture-${createdURLs.length + 1}`;
            createdURLs.push({url, content});
            return url;
        }
        static revokeObjectURL(url) {revokedURLs.push(url);}
    }

    const host = new FakeElement('html-import');
    host.dataset = {layout: options.layout ?? 'files', ...options.dataset};
    host.previewDescriptor = options.previewDescriptor;
    host.previewTransform = options.previewTransform;
    host.directoryFilter = options.directoryFilter;
    host.setAttribute('href', './arcane/components/file-manager.html');
    const manager = new FakeElement();
    const fileModal = new FakeModal('file');
    const directoryModal = new FakeModal('directory');
    const deleteModal = new FakeModal('delete');
    const elements = new Map(
        [
            ['.file-manager', manager],
            ['style', new FakeElement('style')],
            ['#fileUpload', new FakeElement('input')],
            ['#fileModal', fileModal],
            ['#directoryModal', directoryModal],
            ['#deleteModal', deleteModal]
        ]
    );
    host.shadowRoot = {querySelector: function selectComponentPart(selector) {return elements.get(selector);}};
    const document = {
        baseURI: 'https://preview.example/',
        createElement: function createFixtureElement(name) {return new FakeElement(name);}
    };
    const dbopfs = {
        ready: true,
        async getTableNames() {return Object.keys(files);},
        async getAllKeys(directory) {
            keysRead.push(directory);
            return Object.keys(files[directory]);
        },
        async getFileMetadata(directory, fileName) {
            metadataRead.push([directory, fileName]);
            return {type: files[directory][fileName].mime || ''};
        },
        async readFile(directory, fileName) {
            fileReads.push([directory, fileName]);
            return files[directory][fileName].file;
        }
    };
    const window = new EventTarget();
    window.dbopfs = dbopfs;

    const mediaSource = await readFile(new URL('../runtime/arcane/modules/MarkdownMedia.js', import.meta.url), 'utf8');
    const loadMediaHelper = new Function('Is', 'loadDatabase', 'URL', mediaSource
        .replace("import Is from 'strong-type';", '')
        .replaceAll('export ', '')
        .replaceAll("import('./DBOPFS.js')", 'loadDatabase()')
        + '\nreturn {decodeMarkdownMediaRecord, hydrateMarkdownMedia};');
    const {decodeMarkdownMediaRecord, hydrateMarkdownMedia} = loadMediaHelper(Is, async function mediaDatabase() {
        class FixtureMediaDBOPFS {
            async get(tableName, fileName) {
                markdownReads.push({tableName, fileName});
                if (options.readMarkdown) return options.readMarkdown(tableName, fileName);
                return options.markdownRecords?.[`${tableName}/${fileName}`] ?? null;
            }
        }
        return {default: FixtureMediaDBOPFS};
    }, FixtureURL);

    function createPrintViewCallbackDouble(configuration) {
        const view = {configuration, destroyed: false, preparations: 0};
        printViews.push(view);
        configuration.signal.addEventListener('abort', function destroyPrintViewDouble() {view.destroyed = true;}, {once: true});
        return {
            async print() {
                if (view.destroyed || !configuration.active() || options.printAvailable === false) return false;
                const release = configuration.retain();
                let request;
                try {
                    request = {content: configuration.content(), title: configuration.title(), released: false};
                    if (configuration.prepare) {
                        view.preparations += 1;
                        await configuration.prepare(configuration.signal);
                        request.content = configuration.content();
                    }
                } catch (error) {
                    release();
                    throw error;
                }
                printRequests.push(request);
                window.addEventListener('afterprint', function finishPrintViewDouble() {
                    request.released = true;
                    release();
                }, {once: true});
                return true;
            }
        };
    }

    let FileEntity = FixtureFileEntity;
    if (options.realFileEntity) {
        const entitySource = await readFile(new URL('../runtime/arcane/entities/File.js', import.meta.url), 'utf8');
        const loadFileEntity = Function(
            'Is', 'MD', 'dbopfs',
            entitySource
                .replace(/^import[^\r\n]*;\r?$/gmu, '')
                .replace('export default FileEntity;', 'return FileEntity;')
        );
        FileEntity = loadFileEntity(Is, FakeMarkdown, dbopfs);
    }

    async function loadDependency(specifier) {
        dependencyImports.push(specifier);
        await options.loadDependency?.(specifier);
        if (specifier === 'strong-type') return {default: Is};
        if (specifier === '../modules/DBOPFS.js') return {};
        if (specifier === '../entities/File.js') return {default: FileEntity};
        if (specifier === '../modules/MD.js') return {default: FakeMarkdown};
        if (specifier === '../modules/MarkdownMedia.js') {
            return {decodeMarkdownMediaRecord, hydrateMarkdownMedia: function hydratePreview(root, configuration) {
                assert.equal(root.localName, '#document-fragment');
                assert.equal(root.parentElement, null);
                const images = root.querySelectorAll('img');
                const owner = hydrateMarkdownMedia(root, configuration);
                markdownHandles.push({root, images, owner, signal: configuration.signal});
                return owner;
            }};
        }
        if (specifier === '../modules/PrintView.js') return {createPrintView: createPrintViewCallbackDouble};
        if (specifier === '../modules/WaitForComponent.js') {
            return {default: async function readyComponent(component, configuration) {
                modalWaits.push({component, configuration});
                await options.waitForComponent?.(component, configuration);
                return component;
            }};
        }
        if (specifier === 'arcane-os/logging') {
            return {arcaneLogging: {error: function recordError(...values) {errors.push(values);}}};
        }
        if (specifier === 'arcane-os/event-manager') {
            return {
                createArcaneEventSource: function fixtureEventSource() {
                    return {
                        descriptor: {instanceId: 'file-preview-fixture'},
                        dispatch: function dispatchFixtureEvent(type, detail) {
                            if (type === 'file-manager-ready') ready.resolve();
                            return {accepted: true, occurrence: {type, detail}};
                        },
                        dispose: function disposeFixtureSource() {}
                    };
                },
                projectArcaneDOMEvent: function projectFixtureEvent() {return true;}
            };
        }
        throw new Error(`Unexpected file preview dependency: ${specifier}`);
    }

    const source = await readFile(new URL('../runtime/arcane/components/file-manager.html', import.meta.url), 'utf8');
    const script = source.match(/<script type="module">([\s\S]*?)<\/script>/u)[1];
    const AsyncFunction = Object.getPrototypeOf(async function componentScript() {}).constructor;
    const run = new AsyncFunction('window', 'document', 'dbopfs', 'importModule', 'URL', 'getComputedStyle', script.replaceAll('import(', 'importModule('));
    await run.call(host, window, document, dbopfs, loadDependency, FixtureURL, function computedFixtureStyle(element) {return element.style;});
    await ready.promise;

    function descendants(element, predicate) {
        const result = [];
        function visit(current) {
            if (predicate(current)) result.push(current);
            for (const child of current.children) visit(child);
        }
        visit(element);
        return result;
    }

    async function settle() {
        await new Promise(function settleComponentContinuations(resolve) {setImmediate(resolve);});
    }

    async function open(fileName = 'entry.txt') {
        const button = descendants(manager, function isOpenButton(element) {
            return element.dataset.fileAction === 'open' && element.dataset.file === fileName;
        })[0];
        assert.ok(button, `Missing open control for ${fileName}`);
        await button.fire('click');
        await settle();
    }

    async function openDirectory() {
        const folder = descendants(manager, function isFolder(element) {return element.className === 'file folder';})[0];
        await manager.fire('click', {target: folder});
        await settle();
    }

    function afterPrint() {window.dispatchEvent(new Event('afterprint'));}

    function nativePrint() {
        const view = printViews.at(-1);
        const release = view.configuration.retain();
        try {
            return view.configuration.content();
        } catch (error) {
            view.configuration.onError(error);
            return null;
        } finally {
            release();
        }
    }

    return {host, manager, fileModal, directoryModal, deleteModal, keysRead, metadataRead, fileReads, createdURLs, revokedURLs, errors, printViews, printRequests, modalWaits, modalCloseEvents, dependencyImports, markdownReads, markdownHandles, descendants, open, openDirectory, afterPrint, nativePrint, settle, source};
}

test('file preview filters directories before keys and preserves file-predicate input', async function directoryFilteringContract() {
    for (const layout of ['', 'files', 'grid', 'tree']) {
        const directoryCalls = [];
        const fixture = await fileManagerFixture(
            {
                layout,
                dataset: {hiddenPrefixes: 'cache-'},
                files: {
                    'cache-internal': {'hidden.txt': {text: 'Hidden'}},
                    excluded: {'hidden.txt': {text: 'Excluded'}},
                    visible: {'entry.txt': {text: 'Shown'}}
                },
                directoryFilter: function visibleDirectories(entry, context) {
                    directoryCalls.push({entry, context});
                    return entry.name !== 'excluded';
                }
            }
        );
        try {
            assert.deepEqual(fixture.keysRead, layout === 'tree' ? [] : ['visible']);
            assert.deepEqual(fixture.metadataRead, layout === 'files' ? [['visible', 'entry.txt']] : []);
            assert.ok(directoryCalls.some(function sawVisible(call) {return call.entry.name === 'visible';}));
            assert.ok(!directoryCalls.some(function sawHidden(call) {return call.entry.name === 'cache-internal';}));
            if (layout === 'tree') continue;
            const calls = [];
            await fixture.host.setFilter(function filesOnly(entry, context) {
                calls.push({entry, context});
                return entry.name.endsWith('.txt');
            });
            assert.deepEqual(calls[0], {
                entry: {name: 'entry.txt', path: 'entry.txt', kind: 'file'},
                context: {directory: 'visible', fileName: 'entry.txt', path: 'visible/entry.txt', layout}
            });
            await fixture.host.setDirectoryFilter(function excludeEveryDirectory() {return false;});
            assert.deepEqual(fixture.keysRead, ['visible', 'visible']);
            assert.equal(fixture.manager.children.length, 0);
        } finally {
            fixture.host.destroy();
        }
    }
});

test('native previews retain full JSONL and render Markdown and HTML in grid and files', async function nativePreviewContract() {
    const raw = '{"content":"First"}\ninvalid original row\n{"content":"Last"}\n';
    const html = '<!doctype html><html><head><style>article{color:purple}</style></head><body><article>Complete HTML</article></body></html>';
    for (const layout of ['grid', 'files']) {
        const fixture = await fileManagerFixture(
            {
                layout,
                files: {visible: {
                    'history.jsonl': {text: raw, parsed: [{content: 'First'}, {content: 'Last'}]},
                    'article.md': {text: '# Heading', parsed: '<h1>Heading</h1>'},
                    'article.html': {text: html},
                    'extensionless-html': {text: html, mime: 'text/html;charset=utf-8'},
                    'extensionless-markdown': {text: '# Complete extensionless Markdown', mime: 'text/markdown;charset=utf-8'}
                }}
            }
        );
        try {
            await fixture.open('history.jsonl');
            assert.equal(fixture.descendants(fixture.fileModal, function isPre(element) {return element.localName === 'pre';})[0].innerText, raw);
            await fixture.open('article.md');
            assert.ok(fixture.descendants(fixture.fileModal, function hasMarkdown(element) {return element.innerHTML === '<fixture-markdown># Heading</fixture-markdown>';}).length);
            await fixture.open('article.html');
            const frame = fixture.descendants(fixture.fileModal, function isHTMLFrame(element) {return element.localName === 'iframe';})[0];
            assert.equal(frame.srcdoc, html);
            assert.equal(frame.title, 'article.html');
            await fixture.open('extensionless-html');
            assert.equal(frame.srcdoc, '');
            assert.equal(fixture.descendants(fixture.fileModal, function isHTMLFrame(element) {return element.localName === 'iframe';})[0].srcdoc, html);
            await fixture.open('extensionless-markdown');
            assert.ok(fixture.descendants(fixture.fileModal, function hasMarkdown(element) {return element.innerHTML === '<fixture-markdown># Complete extensionless Markdown</fixture-markdown>';}).length);
        } finally {
            fixture.host.destroy();
        }
    }
});

test('null descriptors preserve the old JSON transform and complete context', async function transformCompatibilityContract() {
    const callbacks = [];
    const fixture = await fileManagerFixture(
        {
            files: {visible: {'entry.json': {text: '{"text":"Original"}', parsed: {text: 'Original'}, mime: 'application/json'}}},
            previewDescriptor: function describeFile(file, context) {
                callbacks.push({file, context});
                return null;
            },
            previewTransform: function transformJSON(value, context) {
                callbacks.push({value, context});
                return {text: 'Explicitly transformed'};
            }
        }
    );
    try {
        await fixture.open('entry.json');
        assert.ok(callbacks[0].file instanceof File);
        assert.equal(callbacks[0].context.path, 'visible/entry.json');
        assert.equal(callbacks[0].context.mimeType, 'application/json');
        assert.ok(callbacks[0].context.signal instanceof AbortSignal);
        assert.deepEqual(callbacks[1], {value: {text: 'Original'}, context: {directory: 'visible', extension: 'json', fileName: 'entry.json'}});
        assert.equal(fixture.descendants(fixture.fileModal, function isPre(element) {return element.localName === 'pre';})[0].innerText, JSON.stringify({text: 'Explicitly transformed'}, null, 4));
    } finally {
        fixture.host.destroy();
    }
});

test('JSON-family image records render through real FileEntity while original files and app folders stay unchanged', async function encodedImagePreview() {
    const content = '<svg><text>Complete moon-dragon portrait: 月 🐉</text></svg>';
    const record = markdownImageRecord(content);
    for (const tableName of ['images', 'journal_media']) {
        const files = {[tableName]: {}};
        for (const fileName of ['portrait.json', 'portrait.JSON', 'portrait.jsonl', 'portrait.NDJSON', 'restored.ndjson']) {
            const text = fileName === 'restored.ndjson' ? JSON.stringify([[record]]) : JSON.stringify(record);
            files[tableName][fileName] = {file: new File([text], fileName), text};
        }
        const fixture = await fileManagerFixture({realFileEntity: true, files});
        try {
            assert.equal(fixture.dependencyImports.includes('../modules/MarkdownMedia.js'), false);
            for (const [fileName, source] of Object.entries(files[tableName])) {
                await fixture.open(fileName);
                const image = fixture.descendants(fixture.fileModal, function isImage(element) {
                    return element.localName === 'img' && element.src.startsWith('blob:');
                })[0];
                const rendered = fixture.createdURLs.at(-1);
                assert.ok(image, fileName);
                assert.equal(image.src, rendered.url);
                assert.equal(image.alt, fileName);
                assert.equal(rendered.content.type, record.mediaType);
                assert.equal(await rendered.content.text(), content);
                assert.equal(await source.file.text(), source.text);
                assert.equal(source.file.type, '');
                assert.equal(source.file.mime, fileName.toLowerCase().endsWith('.json') ? 'application/json' : 'application/x-ndjson');
            }
            assert.deepEqual(fixture.markdownReads, []);
            assert.deepEqual(fixture.errors, []);
        } finally {
            fixture.host.destroy();
        }
        assert.deepEqual(fixture.revokedURLs, fixture.createdURLs.map(function ownedURL(entry) {return entry.url;}));
    }
});

test('image recognition preserves complete generic JSON and every mixed or multiple JSONL row', async function completeRecordFallback() {
    const record = markdownImageRecord('The complete first image');
    const serialized = JSON.stringify(record);
    const texts = {
        'ordinary.json': JSON.stringify({content: 'The complete ordinary journal record'}),
        'text-data.json': JSON.stringify({mediaType: 'text/plain', dataUrl: 'data:text/plain;base64,Q29tcGxldGUgdGV4dA=='}),
        'untyped.json': JSON.stringify({dataUrl: record.dataUrl}),
        'multiple.json': JSON.stringify([record, record]),
        'multiple.jsonl': `${serialized}\n${serialized}\n`,
        'mixed.jsonl': `${serialized}\nThe complete unparseable original row.\n`,
        'nested.ndjson': `${JSON.stringify([[record, record]])}\n`,
        'ordinary.ndjson': '{"content":"Complete first row"}\n{"content":"Complete second row"}\n'
    };
    const files = {visible: {}};
    for (const [fileName, text] of Object.entries(texts)) files.visible[fileName] = {file: new File([text], fileName)};
    const fixture = await fileManagerFixture({realFileEntity: true, files});
    try {
        for (const [fileName, text] of Object.entries(texts)) {
            await fixture.open(fileName);
            const pre = fixture.descendants(fixture.fileModal, function isPre(element) {return element.localName === 'pre';})[0];
            assert.equal(pre.textContent, fileName.endsWith('.json') ? JSON.stringify(JSON.parse(text), null, 4) : text);
            assert.equal(await files.visible[fileName].file.text(), text);
        }
        assert.deepEqual(fixture.createdURLs, []);
        assert.deepEqual(fixture.markdownReads, []);
        assert.deepEqual(fixture.errors, []);
    } finally {
        fixture.host.destroy();
    }
});

test('application descriptors and JSON transforms keep precedence over encoded image previews', async function imageCallbackPrecedence() {
    const record = markdownImageRecord('Complete application-owned drawing');
    for (const descriptorOwnsPreview of [true, false]) {
        const file = new File([JSON.stringify(record)], 'drawing.json');
        const observed = [];
        const fixture = await fileManagerFixture({
            realFileEntity: true,
            files: {visible: {'drawing.json': {file}}},
            previewDescriptor(opened, context) {
                assert.equal(opened, file);
                assert.equal(context.mimeType, 'application/json');
                observed.push('descriptor');
                return descriptorOwnsPreview ? {kind: 'text', content: 'Application descriptor'} : null;
            },
            previewTransform(parsed, context) {
                assert.deepEqual(parsed, record);
                assert.equal(context.fileName, 'drawing.json');
                observed.push('transform');
                return {content: 'Application transform'};
            }
        });
        try {
            await fixture.open('drawing.json');
            const pre = fixture.descendants(fixture.fileModal, function isPre(element) {return element.localName === 'pre';})[0];
            assert.equal(pre.textContent, descriptorOwnsPreview ? 'Application descriptor' : JSON.stringify({content: 'Application transform'}, null, 4));
            assert.deepEqual(observed, descriptorOwnsPreview ? ['descriptor'] : ['descriptor', 'transform']);
            assert.equal(fixture.dependencyImports.includes('../modules/MarkdownMedia.js'), false);
            assert.deepEqual(fixture.createdURLs, []);
            assert.equal(await file.text(), JSON.stringify(record));
        } finally {
            fixture.host.destroy();
        }
    }
});

test('recognized image-record encoding failures stay visible through the existing preview error owner', async function encodedImageFailure() {
    for (const [fileName, dataUrl, errorName] of [
        ['remote.json', 'https://example.test/not-a-local-image.png', 'TypeError'],
        ['broken.jsonl', 'data:image/png;base64,%%%', 'InvalidCharacterError']
    ]) {
        const text = JSON.stringify({mediaType: 'image/png', dataUrl});
        const file = new File([text], fileName);
        const fixture = await fileManagerFixture({realFileEntity: true, files: {visible: {[fileName]: {file}}}});
        try {
            await fixture.open(fileName);
            assert.ok(fixture.fileModal.textContent.includes('Unable to open this file.'));
            assert.equal(fixture.errors[0][0], 'Unable to open file:');
            assert.equal(fixture.errors[0][1].name, errorName);
            assert.deepEqual(fixture.createdURLs, []);
            assert.deepEqual(fixture.markdownReads, []);
            assert.equal(await fixture.host.printPreview(), false);
            assert.equal(await file.text(), text);
        } finally {
            fixture.host.destroy();
        }
    }
});

test('encoded image previews retain only their owned display URL through print closeout', async function encodedImagePrintLifetime() {
    const text = JSON.stringify(markdownImageRecord('Complete printable portrait'));
    const file = new File([text], 'portrait.json');
    const fixture = await fileManagerFixture({realFileEntity: true, files: {images: {'portrait.json': {file}}}});
    try {
        await fixture.open('portrait.json');
        const image = fixture.descendants(fixture.fileModal, function isImage(element) {
            return element.localName === 'img' && element.src.startsWith('blob:');
        })[0];
        assert.equal(await fixture.host.printPreview(), true);
        assert.equal(fixture.printRequests[0].content.contains(image), true);
        assert.equal(fixture.printRequests[0].title, 'images/portrait.json');
        assert.equal(await fixture.host.close(), true);
        assert.equal(image.src, '');
        assert.deepEqual(fixture.revokedURLs, []);
        fixture.afterPrint();
        assert.deepEqual(fixture.revokedURLs, ['blob:fixture-1']);
        fixture.afterPrint();
        assert.deepEqual(fixture.revokedURLs, ['blob:fixture-1']);
        assert.equal(await file.text(), text);
    } finally {
        fixture.afterPrint();
        fixture.host.destroy();
    }
});

test('closed, replaced, and destroyed previews ignore encoded images after a pending decoder import', async function cancelledImageRecognition() {
    for (const action of ['close', 'replace', 'destroy']) {
        const moduleReady = Promise.withResolvers();
        const importEntered = Promise.withResolvers();
        const file = new File([JSON.stringify(markdownImageRecord('Complete pending image'))], 'portrait.json');
        const fixture = await fileManagerFixture({
            realFileEntity: true,
            files: {visible: {'portrait.json': {file}, 'replacement.txt': {file: new File(['Complete replacement'], 'replacement.txt')}}},
            loadDependency(specifier) {
                if (specifier === '../modules/MarkdownMedia.js') {
                    importEntered.resolve();
                    return moduleReady.promise;
                }
            }
        });
        try {
            const opening = fixture.open('portrait.json');
            await importEntered.promise;
            if (action === 'close') await fixture.host.close();
            if (action === 'replace') await fixture.open('replacement.txt');
            if (action === 'destroy') fixture.host.destroy();
            moduleReady.resolve();
            await opening;
            assert.deepEqual(fixture.createdURLs, [], action);
            assert.deepEqual(fixture.markdownReads, [], action);
            assert.deepEqual(fixture.errors, [], action);
            if (action === 'replace') assert.ok(fixture.fileModal.textContent.includes('Complete replacement'));
        } finally {
            moduleReady.resolve();
            fixture.host.destroy();
        }
    }
});

test('unsupported binary previews offer the original file for download', async function binaryDownloadContract() {
    let originalFile;
    const fixture = await fileManagerFixture(
        {
            files: {visible: {'archive.bin': {text: 'Fixture binary payload', mime: 'application/octet-stream'}}},
            previewDescriptor: function useNativePreview(file) {
                originalFile = file;
                file.text = async function rejectBinaryTextRead() {throw new Error('Binary preview must not decode text.');};
                return null;
            }
        }
    );
    try {
        await fixture.open('archive.bin');
        const link = fixture.descendants(fixture.fileModal, function isDownload(element) {return element.localName === 'a';})[0];
        assert.equal(link.download, 'archive.bin');
        assert.equal(fixture.createdURLs[0].content, originalFile);
        assert.equal(fixture.descendants(fixture.fileModal, function isPre(element) {return element.localName === 'pre';}).length, 0);
        await fixture.fileModal.close();
        assert.deepEqual(fixture.revokedURLs, [fixture.createdURLs[0].url]);
    } finally {
        fixture.host.destroy();
    }
});

test('an unreadable file keeps its modal delete control available', async function unreadableFileControlContract() {
    const failure = new Error('Fixture read diagnostics');
    const fixture = await fileManagerFixture({files: {visible: {'entry.txt': {error: failure}}}});
    try {
        await fixture.open();
        const status = fixture.descendants(fixture.fileModal, function isAlert(element) {return element.getAttribute('role') === 'alert';})[0];
        assert.equal(status.innerText, 'Unable to open this file.');
        assert.equal(fixture.errors[0][1], failure);
        const remove = fixture.descendants(fixture.fileModal, function isDelete(element) {return element.className === 'file-view-delete';})[0];
        await remove.fire('click');
        assert.equal(fixture.host.shadowRoot.querySelector('#deleteModal').opened, true);
    } finally {
        fixture.host.destroy();
    }
});

test('real FileEntity infers native audio previews without a supplied MIME or text decoding', async function storedAudioMIMEContract() {
    const formats = {
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        oga: 'audio/ogg',
        opus: 'audio/ogg',
        aac: 'audio/aac',
        m4a: 'audio/mp4',
        flac: 'audio/flac',
        weba: 'audio/webm'
    };
    const payload = 'The complete synthetic moon-whale recording — unchanged from storage.';
    const files = {visible: {}};
    const opened = [];
    let textReads = 0;
    for (const extension of Object.keys(formats)) {
        const name = `recording.${extension === 'mp3' ? 'MP3' : extension}`;
        const file = new File([payload], name);
        file.text = async function rejectAudioTextDecoding() {
            textReads += 1;
            throw new Error('Audio previews must not decode the stored file as text.');
        };
        files.visible[name] = {file};
    }
    const fixture = await fileManagerFixture({
        realFileEntity: true,
        files,
        previewDescriptor: function useNativeAudio(file, context) {
            opened.push({file, context});
            return null;
        }
    });
    try {
        for (const [name, source] of Object.entries(files.visible)) {
            await fixture.open(name);
            const extension = name.split('.').at(-1).toLowerCase();
            const expectedMIME = formats[extension];
            const current = opened.at(-1);
            assert.equal(current.file, source.file);
            assert.equal(current.file.ext, extension);
            assert.equal(current.file.type, '');
            assert.equal(current.file.mime, expectedMIME);
            assert.equal(current.file.parsed, null);
            assert.equal(current.context.mimeType, expectedMIME);
            const audio = fixture.descendants(fixture.fileModal, function isAudio(element) {return element.localName === 'audio';})[0];
            assert.ok(audio, `${name} reaches native audio controls.`);
            assert.equal(audio.controls, true);
            const renderedContent = fixture.createdURLs.at(-1).content;
            assert.equal(renderedContent.type, expectedMIME);
            assert.equal(await Blob.prototype.text.call(renderedContent), payload);
            assert.equal(textReads, 0);
            await fixture.fileModal.close();
        }
        assert.deepEqual(fixture.errors, []);
        assert.deepEqual(fixture.fileReads, Object.keys(files.visible).map(function storedFileRead(name) {return ['visible', name];}));
        assert.deepEqual(fixture.revokedURLs, fixture.createdURLs.map(function createdURL(entry) {return entry.url;}));
    } finally {
        fixture.host.destroy();
    }
});

test('real FileEntity preserves supplied MIME and leaves untyped WebM uninferred', async function suppliedAudioMIMEContract() {
    const cases = [
        {name: 'movie.ogg', type: 'video/ogg', expected: 'video/ogg', audio: false},
        {name: 'custom.wav', type: 'application/x-recording', expected: 'application/x-recording', audio: false},
        {name: 'generic.mp3', type: 'application/octet-stream', expected: 'application/octet-stream', audio: false},
        {name: 'custom.mp3', type: 'audio/x-recording', expected: 'audio/x-recording', audio: true},
        {name: 'movie.webm', type: 'video/webm', expected: 'video/webm', audio: false},
        {name: 'sound.webm', type: 'audio/webm;codecs=opus', expected: 'audio/webm;codecs=opus', audio: true},
        {name: 'untyped.webm', type: '', expected: 'application/octet-stream', audio: false}
    ];
    const payload = 'The original supplied recording remains complete.';
    const files = {visible: {}};
    let textReads = 0;
    for (const entry of cases) {
        const file = new File([payload], entry.name, {type: entry.type});
        file.text = async function rejectBinaryTextDecoding() {
            textReads += 1;
            throw new Error('Binary previews must not decode the stored file as text.');
        };
        files.visible[entry.name] = {file, mime: entry.type};
    }
    const fixture = await fileManagerFixture({realFileEntity: true, files});
    try {
        for (const entry of cases) {
            await fixture.open(entry.name);
            const original = files.visible[entry.name].file;
            assert.equal(original.type, entry.type);
            assert.equal(original.mime, entry.expected);
            const audio = fixture.descendants(fixture.fileModal, function isAudio(element) {return element.localName === 'audio';});
            assert.equal(audio.length, entry.audio ? 1 : 0, entry.name);
            const renderedContent = fixture.createdURLs.at(-1).content;
            if (!entry.audio) {
                const download = fixture.descendants(fixture.fileModal, function isDownload(element) {return element.localName === 'a';})[0];
                assert.equal(download.download, entry.name);
                assert.equal(renderedContent, original);
            }
            assert.equal(await Blob.prototype.text.call(renderedContent), payload);
            assert.equal(textReads, 0);
            await fixture.fileModal.close();
        }
        assert.deepEqual(fixture.errors, []);
        assert.deepEqual(fixture.revokedURLs, fixture.createdURLs.map(function createdURL(entry) {return entry.url;}));
    } finally {
        fixture.host.destroy();
    }
});

test('conversation preview preserves exact assistant names and uses shared role presentation', async function conversationPresentationContract() {
    const cases = [
        {role: 'assistant', name: 'Captain Comet', label: 'Captain Comet'},
        {role: 'assistant', name: '  Moon pilot\t', label: '  Moon pilot\t'},
        {role: 'assistant', name: 'assistant', label: 'assistant'},
        {role: 'assistant', label: 'AI'},
        {role: 'assistant', name: '', label: 'AI'},
        {role: 'assistant', name: ' \t\n ', label: 'AI'},
        {role: 'assistant', name: null, label: 'AI'},
        {role: 'assistant', name: 42, label: 'AI'},
        {role: 'assistant', name: {label: 'Not a saved string'}, label: 'AI'},
        {role: 'user', label: 'user'},
        {role: 'user', name: 'Astronaut', label: 'Astronaut · user'},
        {role: 'user', name: null, label: 'null · user'},
        {role: 'tool', name: 'Cargo manifest', label: 'Cargo manifest · tool'},
        {role: 'tool', label: 'tool'},
        {role: 'system', name: 'Recorded context', label: 'Recorded context · system'}
    ];
    const timestamp = '2026-09-29T06:00:00Z';
    const messages = cases.map(function createSavedMessage(entry, index) {
        const message = {
            role: entry.role,
            content: `Complete saved message ${index}: **moon cheese**\n\nEvery detail stays visible.`,
            timestamp,
            status: 'recorded'
        };
        if (Object.hasOwn(entry, 'name')) message.name = entry.name;
        return message;
    });
    const originalMessages = structuredClone(messages);
    const fixture = await fileManagerFixture({
        previewDescriptor: function describeSavedConversation() {return {kind: 'conversation', messages};}
    });
    try {
        await fixture.open();
        const articles = fixture.descendants(fixture.fileModal, function isMessage(element) {
            return element.className === 'file-preview-message';
        });
        assert.equal(articles.length, messages.length);
        for (let index = 0; index < messages.length; index++) {
            const article = articles[index];
            const message = messages[index];
            assert.equal(article.dataset.role, message.role);
            assert.equal(article.children[0].children[0].textContent, cases[index].label);
            assert.equal(article.children[1].children[0].innerHTML, `<fixture-markdown>${message.content}</fixture-markdown>`);
            assert.equal(article.children[2].children[0].dateTime, new Date(timestamp).toISOString());
            assert.equal(article.children[2].children[1].textContent, message.status);
        }
        assert.deepEqual(messages, originalMessages);
        assert.deepEqual(fixture.errors, []);

        // This asserts the authored palette contract, not browser-computed appearance.
        const userRule = fixture.source.match(/\.file-preview-message\[data-role="user"\]\s*\{([^}]*)\}/u)[1];
        const assistantRule = fixture.source.match(/\.file-preview-message\[data-role="assistant"\]\s*\{([^}]*)\}/u)[1];
        assert.match(userRule, /background:\s*var\(--arcane-action,var\(--primary-color\)\)/u);
        assert.match(userRule, /color:\s*var\(--arcane-action-text,var\(--button-text-color,var\(--text-color\)\)\)/u);
        assert.match(assistantRule, /background:\s*var\(--arcane-surface,var\(--background\)\)/u);
        assert.match(assistantRule, /color:\s*var\(--text-color\)/u);
    } finally {
        fixture.host.destroy();
    }
});

test('nested media and downloads release on close and preserve supplied conversation timestamps', async function collectionOwnershipContract() {
    const timestamp = '2026-09-28T19:22:31Z';
    const fixture = await fileManagerFixture(
        {
            previewDescriptor: function describeCollection() {
                return {kind: 'collection', items: [
                    {kind: 'conversation', messages: [{role: 'user', content: 'Complete first message', timestamp}, {role: 'assistant', content: 'Complete second message'}]},
                    {kind: 'audio', content: new Blob(['audio'], {type: 'audio/wav'})},
                    {kind: 'image', content: new Blob(['image'], {type: 'image/png'}), alt: 'Fixture image'},
                    {kind: 'pdf', content: new Blob(['pdf'], {type: 'application/pdf'})},
                    {kind: 'download', content: new Blob(['attachment']), fileName: 'attachment.txt'}
                ]};
            }
        }
    );
    try {
        await fixture.open();
        const times = fixture.descendants(fixture.fileModal, function isTime(element) {return element.localName === 'time';});
        assert.equal(times[0].dateTime, new Date(timestamp).toISOString());
        assert.equal(times[1].textContent, 'Time unavailable');
        const audio = fixture.descendants(fixture.fileModal, function isAudio(element) {return element.localName === 'audio';})[0];
        const download = fixture.descendants(fixture.fileModal, function isDownload(element) {return element.localName === 'a';})[0];
        assert.equal(audio.controls, true);
        assert.equal(download.download, 'attachment.txt');
        assert.equal(fixture.createdURLs.length, 4);
        await fixture.fileModal.close();
        assert.deepEqual(fixture.revokedURLs, fixture.createdURLs.map(function createdURL(entry) {return entry.url;}));
        assert.equal(audio.paused, true);
        assert.equal(audio.loads, 1);
        fixture.host.destroy();
        assert.equal(fixture.revokedURLs.length, 4);
    } finally {
        fixture.host.destroy();
    }
});

test('lazy media loads only on selection, retries locally, and ignores late completion after close', async function lazyMediaContract() {
    let attempts = 0;
    let signal;
    const late = Promise.withResolvers();
    const fixture = await fileManagerFixture(
        {
            previewDescriptor: function describeLazyCollection() {
                return {kind: 'collection', items: [
                    {kind: 'text', content: 'Visible before media loads'},
                    {kind: 'audio', title: 'Selected recording', content: async function loadRecording(context) {
                        attempts += 1;
                        signal = context.signal;
                        if (attempts === 1) throw new Error('Fixture read failure');
                        return late.promise;
                    }}
                ]};
            }
        }
    );
    try {
        await fixture.open();
        assert.equal(attempts, 0);
        assert.equal(fixture.createdURLs.length, 0);
        const load = fixture.descendants(fixture.fileModal, function isLoad(element) {return element.localName === 'button' && element.textContent === 'Load Selected recording';})[0];
        await load.fire('click');
        assert.equal(attempts, 1);
        assert.equal(load.disabled, false);
        assert.ok(fixture.descendants(fixture.fileModal, function isFailure(element) {return element.textContent === 'Unable to load this item.';}).length);
        assert.equal(fixture.errors[0][0], 'Unable to load file preview item:');
        assert.ok(fixture.errors[0][1] instanceof Error);
        assert.equal(fixture.errors[0][1].message, 'Fixture read failure');
        const pending = load.fire('click');
        await fixture.settle();
        await fixture.fileModal.close();
        assert.equal(signal.aborted, true);
        late.resolve(new Blob(['late'], {type: 'audio/wav'}));
        await pending;
        assert.equal(fixture.createdURLs.length, 0);
    } finally {
        late.resolve(new Blob());
        fixture.host.destroy();
    }
});

test('superseded mappers cannot replace current content and descriptor failures stay visible', async function asynchronousPreviewContract() {
    const late = Promise.withResolvers();
    let firstSignal;
    let calls = 0;
    const fixture = await fileManagerFixture(
        {
            previewDescriptor: function describeAsynchronously(_file, context) {
                calls += 1;
                if (calls === 1) {
                    firstSignal = context.signal;
                    return late.promise;
                }
                if (calls === 2) return {kind: 'text', content: 'Current complete content'};
                return {kind: 'unsupported-fixture-kind'};
            }
        }
    );
    try {
        await fixture.open();
        await fixture.open();
        assert.equal(firstSignal.aborted, true);
        late.resolve({kind: 'audio', content: new Blob(['late'])});
        await fixture.settle();
        assert.equal(fixture.createdURLs.length, 0);
        assert.ok(fixture.descendants(fixture.fileModal, function isCurrent(element) {return element.innerText === 'Current complete content';}).length);
        await fixture.open();
        const failure = fixture.descendants(fixture.fileModal, function isAlert(element) {return element.getAttribute('role') === 'alert';})[0];
        assert.equal(failure.innerText, 'Unable to open this file.');
        assert.equal(fixture.errors[0][1].message, 'Unsupported file preview kind: unsupported-fixture-kind.');
        assert.ok(failure.parentElement, 'The failure must remain attached to the open modal.');
    } finally {
        late.resolve(null);
        fixture.host.destroy();
    }
});

test('printPreview supplies the current rendered body and file title to the PrintView callback double', async function renderedPreviewPrintContract() {
    const text = Array.from({length: 120}, function completeParagraph(_value, index) {
        return `Moon-whale journal paragraph ${index + 1}: the entire account remains available.`;
    }).join('\n\n');
    const html = '<!doctype html><html><body><article>Complete embedded journal</article></body></html>';
    let descriptorCalls = 0;
    const fixture = await fileManagerFixture({
        previewDescriptor: function describePrintedCollection() {
            descriptorCalls += 1;
            return {kind: 'collection', title: 'Observed moon-whale migration', items: [
                {kind: 'text', content: text},
                {kind: 'markdown', content: '**The complete route**'},
                {kind: 'html', content: html, title: 'Embedded route'},
                {kind: 'image', content: new Blob(['image'], {type: 'image/png'}), alt: 'Observed route'}
            ]};
        }
    });
    try {
        await fixture.open();
        const rendered = fixture.fileModal.children[0].children.at(-1);
        const pre = fixture.descendants(rendered, function isText(element) {return element.localName === 'pre';})[0];
        const frame = fixture.descendants(rendered, function isHTML(element) {return element.localName === 'iframe';})[0];
        const image = fixture.descendants(rendered, function isImage(element) {return element.localName === 'img';})[0];
        assert.equal(pre.innerText, text);
        assert.equal(frame.srcdoc, html);
        assert.equal(image.src, fixture.createdURLs[0].url);
        assert.ok(fixture.descendants(rendered, function isMarkdown(element) {
            return element.innerHTML === '<fixture-markdown>**The complete route**</fixture-markdown>';
        }).length);
        pre.innerText = `${text}\n\nThe current rendered annotation stays with the print request.`;
        const printButton = fixture.descendants(fixture.fileModal, function isPrintButton(element) {return element.textContent === 'Print';})[0];
        assert.equal(printButton.disabled, false);

        assert.equal(await fixture.host.printPreview(), true);
        assert.equal(fixture.printRequests.length, 1);
        assert.equal(fixture.printRequests[0].content, rendered);
        assert.equal(fixture.printRequests[0].title, 'visible/entry.txt');
        assert.equal(fixture.printViews[0].configuration.host, fixture.host);
        assert.equal(fixture.printViews[0].configuration.priority, 1);
        assert.equal(fixture.printViews[0].configuration.active(), true);
        assert.equal(fixture.printRequests[0].content.contains(pre), true);
        assert.equal(pre.innerText, `${text}\n\nThe current rendered annotation stays with the print request.`);
        assert.equal(fixture.printRequests[0].content.contains(frame), true);
        assert.equal(fixture.printRequests[0].content.contains(image), true);
        assert.equal(fixture.printRequests[0].content.contains(printButton), false);
        assert.equal(descriptorCalls, 1);
        assert.deepEqual(fixture.fileReads, [['visible', 'entry.txt']]);
        assert.deepEqual(fixture.errors, []);
    } finally {
        fixture.afterPrint();
        fixture.host.destroy();
    }
});

test('PrintView callback resource leases survive preview close and release after the fixture afterprint event', async function printResourceLifetimeContract() {
    for (const closeFirst of [true, false]) {
        const fixture = await fileManagerFixture({
            previewDescriptor: function describeRetainedMedia() {
                return {kind: 'collection', items: [
                    {kind: 'image', content: new Blob(['image'], {type: 'image/png'})},
                    {kind: 'audio', content: new Blob(['audio'], {type: 'audio/wav'})}
                ]};
            }
        });
        try {
            await fixture.open();
            const image = fixture.descendants(fixture.fileModal, function isImage(element) {return element.localName === 'img' && element.src?.startsWith('blob:');})[0];
            const audio = fixture.descendants(fixture.fileModal, function isAudio(element) {return element.localName === 'audio';})[0];
            assert.equal(await fixture.host.printPreview(), true);
            if (closeFirst) {
                assert.equal(await fixture.host.close(), true);
                assert.equal(fixture.printViews[0].destroyed, true);
                assert.equal(image.src, '');
                assert.equal(audio.paused, true);
                assert.equal(audio.loads, 1);
                assert.deepEqual(fixture.revokedURLs, []);
                fixture.afterPrint();
            } else {
                fixture.afterPrint();
                assert.equal(fixture.printRequests[0].released, true);
                assert.deepEqual(fixture.revokedURLs, []);
                assert.equal(await fixture.host.close(), true);
            }
            assert.equal(fixture.printRequests[0].released, true);
            assert.deepEqual(fixture.revokedURLs, fixture.createdURLs.map(function createdURL(entry) {return entry.url;}));
            assert.equal(await fixture.host.printPreview(), false);
            fixture.afterPrint();
            assert.equal(await fixture.host.close(), true);
            assert.deepEqual(fixture.revokedURLs, fixture.createdURLs.map(function createdURL(entry) {return entry.url;}));
        } finally {
            fixture.afterPrint();
            fixture.host.destroy();
        }
    }
});

test('printPreview returns false for absent, helper-unavailable, closed, and destroyed previews', async function unavailablePreviewPrintContract() {
    const fixture = await fileManagerFixture({printAvailable: false});
    try {
        assert.equal(await fixture.host.printPreview(), false);
        assert.equal(fixture.printViews.length, 0);
        await fixture.open();
        assert.equal(await fixture.host.printPreview(), false);
        assert.equal(fixture.printViews.length, 1);
        assert.deepEqual(fixture.printRequests, []);
        await fixture.fileModal.close();
        assert.equal(await fixture.host.printPreview(), false);
        fixture.host.destroy();
        assert.equal(await fixture.host.printPreview(), false);
        assert.equal(await fixture.host.close(), false);
        assert.deepEqual(fixture.errors, []);
    } finally {
        fixture.host.destroy();
    }
});

test('close awaits child modal completion before parents and leaves the manager reusable', async function reusableManagerCloseContract() {
    const childClose = Promise.withResolvers();
    let waitForChild = true;
    const fixture = await fileManagerFixture({
        layout: 'grid',
        closeModal: function finishOwnedModal(modal) {
            if (modal.name === 'delete' && waitForChild) {
                waitForChild = false;
                return childClose.promise;
            }
        }
    });
    try {
        await fixture.openDirectory();
        await fixture.open();
        const remove = fixture.descendants(fixture.fileModal, function isDelete(element) {return element.className === 'file-view-delete';})[0];
        await remove.fire('click');
        assert.equal(fixture.deleteModal.opened, true);
        assert.equal(fixture.fileModal.opened, true);
        assert.equal(fixture.directoryModal.opened, true);

        const closing = fixture.host.close();
        assert.equal(fixture.printViews[0].configuration.signal.aborted, false);
        await fixture.settle();
        assert.deepEqual(fixture.modalCloseEvents, [['delete', 'start']]);
        assert.equal(fixture.fileModal.opened, true);
        assert.equal(fixture.directoryModal.opened, true);
        childClose.resolve(true);
        assert.equal(await closing, true);
        assert.equal(fixture.printViews[0].configuration.signal.aborted, true);
        assert.deepEqual(fixture.modalCloseEvents, [
            ['delete', 'start'], ['delete', 'finish'],
            ['file', 'start'], ['file', 'finish'],
            ['directory', 'start'], ['directory', 'finish']
        ]);
        assert.equal(fixture.host.ready, true);
        assert.equal(fixture.deleteModal.opened, false);
        assert.equal(fixture.fileModal.opened, false);
        assert.equal(fixture.directoryModal.opened, false);
        assert.equal(await fixture.host.close(), true);

        await fixture.openDirectory();
        await fixture.open();
        assert.equal(fixture.fileModal.opened, true);
        assert.equal(fixture.directoryModal.opened, true);
        assert.equal(await fixture.host.printPreview(), true);
        assert.equal(fixture.printViews.at(-1).configuration.signal.aborted, false);
        assert.deepEqual(fixture.errors, []);
    } finally {
        childClose.resolve(true);
        fixture.afterPrint();
        fixture.host.destroy();
    }
});

test('close invalidates late readiness, storage reads, and descriptor completion without reopening', async function pendingPreviewCloseContract() {
    for (const stage of ['readiness', 'storage', 'descriptor']) {
        const late = Promise.withResolvers();
        const entered = Promise.withResolvers();
        let waiting = true;
        function pauseSelectedStage(current) {
            if (stage !== current || !waiting) return undefined;
            waiting = false;
            entered.resolve();
            return late.promise;
        }
        const fixture = await fileManagerFixture({
            waitForComponent: function waitForPreviewModal(component) {
                return component.name === 'file' ? pauseSelectedStage('readiness') : undefined;
            },
            readFile: function readStoredPreview() {return pauseSelectedStage('storage');},
            previewDescriptor: async function describePendingPreview() {
                await pauseSelectedStage('descriptor');
                return {kind: 'image', content: new Blob(['complete image'], {type: 'image/png'})};
            }
        });
        try {
            await fixture.open();
            await entered.promise;
            assert.equal(await fixture.host.printPreview(), false);
            const openCalls = fixture.fileModal.openCalls;
            const closing = fixture.host.close();
            assert.equal(fixture.modalWaits[0].configuration.signal.aborted, true, stage);
            assert.equal(await closing, true);
            late.resolve();
            await fixture.settle();
            assert.equal(fixture.fileModal.opened, false, stage);
            assert.equal(fixture.fileModal.openCalls, openCalls, stage);
            assert.deepEqual(fixture.createdURLs, [], stage);
            assert.deepEqual(fixture.printViews, [], stage);
            assert.equal(await fixture.host.printPreview(), false);

            await fixture.open();
            assert.equal(fixture.fileModal.opened, true, stage);
            assert.equal(fixture.createdURLs.length, 1, stage);
            assert.equal(await fixture.host.printPreview(), true);
            assert.deepEqual(fixture.errors, [], stage);
        } finally {
            late.resolve();
            fixture.afterPrint();
            fixture.host.destroy();
        }
    }
});

test('failed close preserves the rendered preview until its modal actually closes', async function failedManagerCloseContract() {
    const html = '<!doctype html><html><body>Complete moon-whale log</body></html>';
    for (const modalName of ['delete', 'file']) {
        for (const failure of ['refusal', 'throw', 'still-open']) {
            const fixture = await fileManagerFixture({
                layout: 'grid',
                previewDescriptor: function describePreservedPreview() {
                    return {kind: 'collection', items: [
                        {kind: 'html', content: html},
                        {kind: 'image', content: new Blob(['complete image'], {type: 'image/png'})},
                        {kind: 'audio', content: new Blob(['complete audio'], {type: 'audio/wav'})}
                    ]};
                }
            });
            const blockedModal = modalName === 'delete' ? fixture.deleteModal : fixture.fileModal;
            const closeModal = blockedModal.close.bind(blockedModal);
            const error = new Error('Fixture modal close failed');
            let firstClose = true;
            blockedModal.close = async function failInitialModalClose() {
                if (!firstClose) return closeModal();
                firstClose = false;
                fixture.modalCloseEvents.push([modalName, 'start']);
                if (failure === 'throw') throw error;
                return failure === 'still-open';
            };
            try {
                await fixture.openDirectory();
                await fixture.open();
                if (modalName === 'delete') {
                    const remove = fixture.descendants(fixture.fileModal, function isDelete(element) {return element.className === 'file-view-delete';})[0];
                    await remove.fire('click');
                    assert.equal(fixture.deleteModal.opened, true);
                }
                const rendered = fixture.fileModal.children[0].children.at(-1);
                const frame = fixture.descendants(rendered, function isHTML(element) {return element.localName === 'iframe';})[0];
                const image = fixture.descendants(rendered, function isImage(element) {return element.localName === 'img';})[0];
                const audio = fixture.descendants(rendered, function isAudio(element) {return element.localName === 'audio';})[0];
                const urls = fixture.createdURLs.map(function createdURL(entry) {return entry.url;});

                assert.equal(await fixture.host.close(), false);
                assert.equal(fixture.fileModal.opened, true);
                assert.equal(fixture.directoryModal.opened, true);
                assert.equal(fixture.fileModal.children[0].children.at(-1), rendered);
                assert.equal(frame.srcdoc, html);
                assert.equal(image.src, urls[0]);
                assert.equal(audio.src, urls[1]);
                assert.equal(audio.paused, false);
                assert.equal(audio.loads, 0);
                assert.deepEqual(fixture.revokedURLs, []);
                assert.equal(fixture.printViews[0].configuration.signal.aborted, false);
                assert.equal(await fixture.host.printPreview(), true);
                assert.equal(fixture.printRequests[0].content, rendered);
                fixture.afterPrint();
                assert.deepEqual(fixture.revokedURLs, []);

                assert.equal(await fixture.host.close(), true);
                assert.equal(fixture.fileModal.opened, false);
                assert.equal(fixture.directoryModal.opened, false);
                assert.equal(fixture.printViews[0].configuration.signal.aborted, true);
                assert.equal(frame.srcdoc, '');
                assert.equal(image.src, '');
                assert.equal(audio.src, '');
                assert.equal(audio.paused, true);
                assert.equal(audio.loads, 1);
                assert.deepEqual(fixture.revokedURLs, urls);
                assert.equal(await fixture.host.printPreview(), false);
                assert.equal(fixture.host.ready, true);
                assert.deepEqual(fixture.errors, failure === 'throw' ? [['Unable to close file manager:', error]] : []);
            } finally {
                fixture.afterPrint();
                fixture.host.destroy();
            }
        }
    }
});

function markdownImageRecord(content) {
    return {mediaType: 'image/svg+xml', dataUrl: `data:image/svg+xml;base64,${Buffer.from(content).toString('base64')}`};
}

test('Markdown preview starts both lazy imports together and hydrates detached nodes without delaying text', async function detachedMarkdownHydration() {
    const moduleReady = Promise.withResolvers();
    const recordReady = Promise.withResolvers();
    const fixture = await fileManagerFixture({
        files: {visible: {'drawing.md': {text: 'Complete scene ![Moon dragon](arcane-media:journal/moon.json) ![Outside](https://example.test/outside.png)'}}},
        loadDependency(specifier) {
            if (specifier === '../modules/MD.js') return moduleReady.promise;
        },
        readMarkdown() {return recordReady.promise;}
    });
    try {
        assert.equal(fixture.dependencyImports.includes('../modules/MD.js'), false);
        assert.equal(fixture.dependencyImports.includes('../modules/MarkdownMedia.js'), false);
        await fixture.open('drawing.md');
        assert.equal(fixture.dependencyImports.includes('../modules/MD.js'), true);
        assert.equal(fixture.dependencyImports.includes('../modules/MarkdownMedia.js'), true);
        moduleReady.resolve();
        await fixture.settle();
        const handle = fixture.markdownHandles[0];
        assert.deepEqual(handle.root.children, [], 'Inserting the fragment moves its actual nodes.');
        assert.equal(handle.images[0].getAttribute('src'), null);
        assert.equal(handle.images[1].src, 'https://example.test/outside.png');
        assert.equal(fixture.fileModal.contains(handle.images[0]), true);
        assert.ok(fixture.fileModal.textContent.includes('Complete scene'));
        assert.equal(fixture.printViews.length, 1);
        assert.deepEqual(fixture.markdownReads, [{tableName: 'journal', fileName: 'moon.json'}]);
        recordReady.resolve(markdownImageRecord('<svg><text>Complete moon dragon</text></svg>'));
        await handle.owner.ready;
        assert.equal(handle.images[0].src, 'blob:fixture-1');
        assert.equal(handle.images[0].getAttribute('alt'), 'Moon dragon');
        assert.equal(await fixture.createdURLs[0].content.text(), '<svg><text>Complete moon dragon</text></svg>');
    } finally {
        moduleReady.resolve();
        recordReady.resolve(markdownImageRecord('complete fixture'));
        fixture.host.destroy();
    }
});

test('explicit Markdown printing awaits read and decode while native printing reports pending media', async function markdownPrintReadiness() {
    const record = Promise.withResolvers();
    const decode = Promise.withResolvers();
    const decodeEntered = Promise.withResolvers();
    const fixture = await fileManagerFixture({
        previewDescriptor() {return {kind: 'markdown', content: '![Scene](arcane-media:journal/scene.json)'};},
        readMarkdown() {return record.promise;},
        decodeMarkdown() {decodeEntered.resolve(); return decode.promise;}
    });
    try {
        await fixture.open();
        assert.equal(fixture.nativePrint(), null);
        assert.ok(fixture.fileModal.textContent.includes('Images are still loading. Close this print dialog'));
        const printing = fixture.host.printPreview();
        await fixture.settle();
        assert.deepEqual(fixture.printRequests, []);
        record.resolve(markdownImageRecord('complete scene'));
        await decodeEntered.promise;
        assert.deepEqual(fixture.printRequests, []);
        decode.resolve();
        assert.equal(await printing, true);
        assert.equal(fixture.printRequests.length, 1);
        assert.equal(fixture.printViews[0].preparations, 1);
        assert.equal(fixture.fileModal.textContent.includes('Images are still loading.'), false);
        assert.equal(fixture.printRequests[0].content.contains(fixture.markdownHandles[0].images[0]), true);
        assert.equal(fixture.errors.length, 1);
        assert.equal(fixture.errors[0][0], 'Unable to print file preview:');
    } finally {
        record.resolve(markdownImageRecord('complete scene'));
        decode.resolve();
        fixture.afterPrint();
        fixture.host.destroy();
    }
});

test('failed Markdown images remain observable without hiding text or successful siblings', async function partialMarkdownMediaFailure() {
    const fixture = await fileManagerFixture({
        previewDescriptor() {return {kind: 'collection', items: [
            {kind: 'markdown', content: 'First complete account ![Good](arcane-media:journal/good.json)'},
            {kind: 'markdown', content: 'Second complete account ![Missing](arcane-media:journal/missing.json)'}
        ]};},
        markdownRecords: {'journal/good.json': markdownImageRecord('good complete scene')}
    });
    try {
        await fixture.open();
        await Promise.allSettled(fixture.markdownHandles.map(function mediaReadiness(handle) {return handle.owner.ready;}));
        assert.ok(fixture.fileModal.textContent.includes('First complete account'));
        assert.ok(fixture.fileModal.textContent.includes('Second complete account'));
        assert.ok(fixture.fileModal.textContent.includes('Some images could not be loaded.'));
        assert.equal(fixture.markdownHandles[0].images[0].src, 'blob:fixture-1');
        assert.deepEqual(fixture.revokedURLs, []);
        await assert.rejects(fixture.host.printPreview(), AggregateError);
        assert.equal(fixture.nativePrint(), null);
        assert.deepEqual(fixture.printRequests, []);
        assert.equal(fixture.errors[0][0], 'Unable to load local Markdown images:');
        assert.equal(fixture.errors[0][1].failures[0].reason.name, 'NotFoundError');
    } finally {
        fixture.host.destroy();
    }
});

test('closed, replaced, and destroyed previews prevent late Markdown images or print requests', async function cancelledMarkdownHydration() {
    for (const action of ['close', 'replace', 'destroy']) {
        const record = Promise.withResolvers();
        let descriptions = 0;
        const fixture = await fileManagerFixture({
            previewDescriptor() {
                descriptions += 1;
                return descriptions === 1
                    ?{kind: 'markdown', content: '![Late](arcane-media:journal/late.json)'}
                    :{kind: 'text', content: 'The replacement stays current.'};
            },
            readMarkdown() {return record.promise;}
        });
        try {
            await fixture.open();
            const handle = fixture.markdownHandles[0];
            const printing = fixture.host.printPreview();
            if (action === 'close') assert.equal(await fixture.host.close(), true);
            if (action === 'replace') await fixture.open();
            if (action === 'destroy') fixture.host.destroy();
            assert.equal(handle.signal.aborted, true, action);
            assert.equal(await printing, false, action);
            record.resolve(markdownImageRecord('late complete scene'));
            await fixture.settle();
            assert.equal(handle.images[0].getAttribute('src'), null, action);
            assert.deepEqual(fixture.createdURLs, [], action);
            assert.deepEqual(fixture.printRequests, [], action);
            assert.deepEqual(fixture.errors, [], action);
            if (action === 'replace') assert.ok(fixture.fileModal.textContent.includes('The replacement stays current.'));
        } finally {
            record.resolve(markdownImageRecord('late complete scene'));
            fixture.host.destroy();
        }
    }
});

test('Markdown and ordinary preview URL leases both survive close until afterprint', async function mixedPrintMediaLifetime() {
    for (const closeFirst of [true, false]) {
        const fixture = await fileManagerFixture({
            previewDescriptor() {return {kind: 'collection', items: [
                {kind: 'markdown', content: '![Saved](arcane-media:journal/saved.json)'},
                {kind: 'image', content: new Blob(['ordinary complete image'], {type: 'image/png'})}
            ]};},
            markdownRecords: {'journal/saved.json': markdownImageRecord('saved complete drawing')}
        });
        try {
            await fixture.open();
            assert.equal(await fixture.host.printPreview(), true);
            const expected = new Set(fixture.createdURLs.map(function createdURL(entry) {return entry.url;}));
            assert.equal(expected.size, 2);
            if (closeFirst) {
                assert.equal(await fixture.host.close(), true);
                assert.deepEqual(fixture.revokedURLs, []);
                fixture.afterPrint();
            } else {
                fixture.afterPrint();
                assert.deepEqual(fixture.revokedURLs, []);
                assert.equal(await fixture.host.close(), true);
            }
            assert.deepEqual(new Set(fixture.revokedURLs), expected);
            assert.equal(fixture.revokedURLs.length, 2);
            fixture.afterPrint();
            fixture.host.destroy();
            assert.equal(fixture.revokedURLs.length, 2);
        } finally {
            fixture.afterPrint();
            fixture.host.destroy();
        }
    }
});

test('refused, throwing, and still-open closes preserve settled Markdown media until actual closure', async function refusedMarkdownClose() {
    for (const failure of ['refusal', 'throw', 'still-open']) {
        const fixture = await fileManagerFixture({
            previewDescriptor() {return {kind: 'markdown', content: '![Keep](arcane-media:journal/keep.json)'};},
            markdownRecords: {'journal/keep.json': markdownImageRecord('complete retained scene')}
        });
        const closeModal = fixture.fileModal.close.bind(fixture.fileModal);
        let firstClose = true;
        fixture.fileModal.close = async function refuseFirstClose() {
            if (!firstClose) return closeModal();
            firstClose = false;
            if (failure === 'throw') throw new Error('Fixture close failed.');
            return failure === 'still-open';
        };
        try {
            await fixture.open();
            const handle = fixture.markdownHandles[0];
            await handle.owner.ready;
            assert.equal(await fixture.host.close(), false, failure);
            assert.equal(handle.signal.aborted, false, failure);
            assert.equal(handle.images[0].src, 'blob:fixture-1', failure);
            assert.deepEqual(fixture.revokedURLs, [], failure);
            assert.equal(await fixture.host.printPreview(), true, failure);
            fixture.afterPrint();
            assert.deepEqual(fixture.revokedURLs, [], failure);
            assert.equal(await fixture.host.close(), true, failure);
            assert.equal(handle.signal.aborted, true, failure);
            assert.deepEqual(fixture.revokedURLs, ['blob:fixture-1'], failure);
        } finally {
            fixture.afterPrint();
            fixture.host.destroy();
        }
    }
});
