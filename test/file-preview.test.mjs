import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';

// The complete component script runs against named DOM, storage, and Markdown
// doubles. These cases cover preview ownership and public callback contracts;
// native media decoding, Markdown parsing, and browser layout are separate seams.
async function fileManagerFixture(options = {}) {
    const keysRead = [];
    const metadataRead = [];
    const fileReads = [];
    const createdURLs = [];
    const revokedURLs = [];
    const errors = [];
    const ready = Promise.withResolvers();
    const files = options.files || {
        visible: {'entry.txt': {text: 'Complete document', mime: 'text/plain'}}
    };

    class FakeElement {
        constructor(localName = 'div') {
            this.localName = localName;
            this.children = [];
            this.attributes = new Map();
            this.listeners = new Map();
            this.dataset = {};
            this.className = '';
            this.parentElement = null;
            this.paused = false;
            this.loads = 0;
            const properties = new Map();
            this.style = {
                getPropertyValue(name) {return properties.get(name) || '';},
                setProperty(name, value) {properties.set(name, value);}
            };
        }

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
            if (name === 'src' || name === 'href' || name === 'srcdoc') this[name] = '';
        }
        toggleAttribute(name, enabled) {
            if (enabled) this.setAttribute(name, '');
            else this.removeAttribute(name);
        }
        append(...children) {
            for (const child of children) {
                child.parentElement = this;
                this.children.push(child);
            }
        }
        prepend(child) {
            child.parentElement = this;
            this.children.unshift(child);
        }
        replaceChildren(...children) {
            for (const child of this.children) child.parentElement = null;
            this.children = [];
            this.append(...children);
        }
        remove() {
            const parent = this.parentElement;
            if (parent) parent.children = parent.children.filter(function retainSibling(child) {return child !== this;}, this);
            this.parentElement = null;
        }
        cloneNode() {return new FakeElement(this.localName);}
        pause() {this.paused = true;}
        load() {this.loads += 1;}
        focus() {}
        contains(candidate) {
            return candidate === this || this.children.some(function containsChild(child) {return child.contains(candidate);});
        }
        querySelectorAll(selector) {
            const result = [];
            function visit(element) {
                for (const child of element.children) {
                    if (selector === '[data-file-path]' && child.dataset.filePath !== undefined) result.push(child);
                    visit(child);
                }
            }
            visit(this);
            return result;
        }
    }

    class FakeModal extends FakeElement {
        constructor() {
            super('html-import');
            this.ready = true;
            this.opened = false;
        }
        async populate(content) {this.replaceChildren(content);}
        open() {this.opened = true;}
        async close() {
            this.opened = false;
            await this.fire('modal-closed');
        }
        destroy() {this.opened = false;}
    }

    class FakeMarkdown {
        constructor(content) {this.safeRendered = `<fixture-markdown>${content}</fixture-markdown>`;}
    }

    class FixtureFileEntity {
        constructor(fileName, directory) {
            this.fileName = fileName;
            this.directory = directory;
        }
        async open() {
            fileReads.push([this.directory, this.fileName]);
            const source = files[this.directory][this.fileName];
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
    const fileModal = new FakeModal();
    const directoryModal = new FakeModal();
    const elements = new Map(
        [
            ['.file-manager', manager],
            ['style', new FakeElement('style')],
            ['#fileUpload', new FakeElement('input')],
            ['#fileModal', fileModal],
            ['#directoryModal', directoryModal],
            ['#deleteModal', new FakeModal()]
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
        if (specifier === 'strong-type') return {default: Is};
        if (specifier === '../modules/DBOPFS.js') return {};
        if (specifier === '../entities/File.js') return {default: FileEntity};
        if (specifier === '../modules/MD.js') return {default: FakeMarkdown};
        if (specifier === '../modules/WaitForComponent.js') {
            return {default: async function readyComponent(component) {return component;}};
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

    return {host, manager, fileModal, directoryModal, keysRead, metadataRead, fileReads, createdURLs, revokedURLs, errors, descendants, open, settle, source};
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
        const load = fixture.descendants(fixture.fileModal, function isLoad(element) {return element.textContent === 'Load Selected recording';})[0];
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
