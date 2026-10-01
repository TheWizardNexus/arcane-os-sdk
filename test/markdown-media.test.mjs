import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Is from '../browser-runtime/dependencies/strong-type/index.js';
import test from '../src/testing.mjs';

// Explicit in-memory DBOPFS, FileReader, IMG decode, and object-URL doubles
// exercise the helper contract, not durable OPFS or real browser image decoding.
const source = await readFile(
    new URL('../runtime/arcane/modules/MarkdownMedia.js', import.meta.url),
    'utf8'
);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function pending(resolvePromise, rejectPromise) {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {promise, resolve, reject};
}

function imageRecord(content, mediaType = 'image/svg+xml') {
    return {
        mediaType,
        dataUrl: `data:${mediaType};base64,${Buffer.from(content).toString('base64')}`
    };
}

class FixtureImage {
    constructor(reference, decode = function decodedImage() { return Promise.resolve(); }) {
        this.localName = 'img';
        this.attributes = new Map([['src', reference], ['alt', 'The complete drawing']]);
        this.decode = decode;
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    querySelectorAll() {
        return [];
    }
}

function fixtureRoot(...images) {
    return {
        querySelectorAll(selector) {
            assert.equal(selector, 'img');
            return images;
        }
    };
}

function createFixture(options = {}) {
    const records = new Map();
    const reads = [];
    const writes = [];
    const created = [];
    const revoked = [];
    const imports = [];

    function setRecord(tableName, fileName, value) {
        records.set(JSON.stringify([tableName, fileName]), JSON.parse(JSON.stringify(value)));
    }

    const database = {
        async set(tableName, fileName, value) {
            writes.push({tableName, fileName, value});
            await options.write?.(tableName, fileName, value);
            setRecord(tableName, fileName, value);
            return value;
        },
        async get(tableName, fileName) {
            reads.push({tableName, fileName});
            if (options.read) return options.read(tableName, fileName);
            const record = records.get(JSON.stringify([tableName, fileName])) ?? null;
            return record === null || fileName.endsWith('.json') ? record : JSON.stringify(record);
        }
    };

    class FixtureDBOPFS {
        constructor() {
            return database;
        }
    }

    class FixtureFileReader {
        readAsDataURL(blob) {
            const reader = this;
            blob.arrayBuffer().then(
                function encoded(buffer) {
                    if (options.encodingError) {
                        reader.error = options.encodingError;
                        reader.onerror();
                        return;
                    }
                    reader.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from(buffer).toString('base64')}`;
                    reader.onload();
                },
                function failed(error) {
                    reader.error = error;
                    reader.onerror();
                }
            );
        }
    }

    async function loadDatabase(specifier) {
        imports.push(specifier);
        assert.equal(specifier, './DBOPFS.js');
        return {default: FixtureDBOPFS};
    }

    const objectURLs = {
        createObjectURL(blob) {
            const url = `blob:fixture-${created.length + 1}`;
            created.push({url, blob});
            return url;
        },
        revokeObjectURL(url) {
            revoked.push(url);
        }
    };

    const initialize = new Function(
        'Is', 'loadDatabase', 'FileReader', 'Blob', 'crypto', 'atob', 'URL', 'DOMException',
        source.replace("import Is from 'strong-type';", '')
            .replaceAll('export ', '')
            .replaceAll("import('./DBOPFS.js')", "loadDatabase('./DBOPFS.js')")
            + '\nreturn {parseMarkdownMediaReference, saveMarkdownMedia, readMarkdownMedia, hydrateMarkdownMedia};'
    );
    const api = initialize(Is, loadDatabase, FixtureFileReader, Blob, {
        randomUUID() { return 'fixture-image'; }
    }, atob, objectURLs, DOMException);
    return {api, records, setRecord, reads, writes, created, revoked, imports};
}

test('Markdown media import and reference parsing do not start storage', function lazyStorage() {
    const fixture = createFixture();
    assert.deepEqual(fixture.imports, []);
    assert.equal(fixture.api.parseMarkdownMediaReference('https://example.test/image.png'), null);
    assert.equal(fixture.api.parseMarkdownMediaReference(null), null);
    assert.deepEqual(fixture.api.parseMarkdownMediaReference('arcane-media:my%20images/drawing%2Fmoon.json'), {
        tableName: 'my images', fileName: 'drawing/moon.json'
    });
    assert.throws(function missingAddress() {
        fixture.api.parseMarkdownMediaReference('arcane-media:no-separator');
    }, TypeError);
    assert.throws(function malformedEncoding() {
        fixture.api.parseMarkdownMediaReference('arcane-media:%/image.json');
    }, URIError);
    assert.deepEqual(fixture.imports, []);
});

test('Markdown media preserves complete image content in a JSON backup record', async function saveAndRead() {
    const fixture = createFixture();
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><text>Moon dragons: 月 🐉</text></svg>';
    const saved = await fixture.api.saveMarkdownMedia({blob: new Blob([content], {type: 'image/svg+xml'})});
    assert.deepEqual(saved, {
        reference: 'arcane-media:markdown-media/fixture-image.json',
        tableName: 'markdown-media', fileName: 'fixture-image.json', mediaType: 'image/svg+xml'
    });
    assert.deepEqual(fixture.writes[0].value, imageRecord(content));
    const restored = createFixture();
    restored.setRecord(saved.tableName, saved.fileName, JSON.parse(JSON.stringify(fixture.writes[0].value)));
    const blob = await restored.api.readMarkdownMedia(saved.reference);
    assert.equal(blob.type, 'image/svg+xml');
    assert.equal(await blob.text(), content);
});

test('Markdown media preserves application names and filenames without a JSON extension', async function namedRecords() {
    const fixture = createFixture();
    const saved = await fixture.api.saveMarkdownMedia({
        blob: new Blob(['complete drawing']), tableName: 'journal images', fileName: '月 drawing.media'
    });
    assert.deepEqual(fixture.api.parseMarkdownMediaReference(saved.reference), {
        tableName: 'journal images', fileName: '月 drawing.media'
    });
    assert.equal(saved.mediaType, 'application/octet-stream');
    assert.equal(await (await fixture.api.readMarkdownMedia(saved.reference)).text(), 'complete drawing');
});

test('Markdown media save waits for its durable write and exposes encoding and write failures', async function writeSettlement() {
    const write = deferred();
    const entered = deferred();
    const fixture = createFixture({write() { entered.resolve(); return write.promise; }});
    let settled = false;
    const saving = fixture.api.saveMarkdownMedia({blob: new Blob(['drawing'])}).then(function saved(value) {
        settled = true;
        return value;
    });
    await entered.promise;
    assert.equal(settled, false);
    assert.deepEqual([...fixture.records], []);
    write.resolve();
    await saving;
    assert.equal(settled, true);

    const writeError = new Error('The fixture storage write failed.');
    const failedWrite = createFixture({write() { throw writeError; }});
    await assert.rejects(failedWrite.api.saveMarkdownMedia({blob: new Blob(['drawing'])}), function sameWriteError(error) {
        return error === writeError;
    });
    const encodingError = new Error('The fixture encoder failed.');
    const failedEncoding = createFixture({encodingError});
    await assert.rejects(failedEncoding.api.saveMarkdownMedia({blob: new Blob(['drawing'])}), function sameEncodingError(error) {
        return error === encodingError;
    });
    assert.deepEqual(failedEncoding.writes, []);
});

test('Markdown media reads local records without network interpretation', async function localRecords() {
    const fixture = createFixture();
    await assert.rejects(fixture.api.readMarkdownMedia('https://example.test/image.png'), TypeError);
    await assert.rejects(fixture.api.readMarkdownMedia('arcane-media:images/missing.json'), {name: 'NotFoundError'});
    fixture.setRecord('images', 'remote.json', {mediaType: 'image/png', dataUrl: 'https://example.test/image.png'});
    await assert.rejects(fixture.api.readMarkdownMedia('arcane-media:images/remote.json'), TypeError);
    fixture.setRecord('images', 'broken.json', {mediaType: 'image/png', dataUrl: 'data:image/png;base64,%%%'});
    await assert.rejects(fixture.api.readMarkdownMedia('arcane-media:images/broken.json'), {name: 'InvalidCharacterError'});
    assert.deepEqual(fixture.writes, []);
});

test('Markdown media starts independent reads together and preserves external image attributes', async function concurrentHydration() {
    const first = deferred();
    const second = deferred();
    const readsStarted = deferred();
    const secondDecoded = deferred();
    const fixture = createFixture({read(tableName, fileName) {
        if (fixture.reads.length === 2) readsStarted.resolve();
        return fileName === 'first.json' ? first.promise : second.promise;
    }});
    const firstImage = new FixtureImage('arcane-media:images/first.json');
    const secondImage = new FixtureImage('arcane-media:images/second.json', function decodedSecond() {
        secondDecoded.resolve();
        return Promise.resolve();
    });
    const external = new FixtureImage('https://example.test/ordinary.png');
    const owner = fixture.api.hydrateMarkdownMedia(fixtureRoot(firstImage, secondImage, external));
    assert.equal(firstImage.getAttribute('src'), null);
    assert.equal(secondImage.getAttribute('src'), null);
    assert.equal(external.getAttribute('src'), 'https://example.test/ordinary.png');
    await readsStarted.promise;
    second.resolve(imageRecord('second drawing'));
    await secondDecoded.promise;
    assert.equal(firstImage.getAttribute('src'), null);
    assert.equal(secondImage.getAttribute('src'), 'blob:fixture-1');
    first.resolve(imageRecord('first drawing'));
    await owner.ready;
    assert.equal(firstImage.getAttribute('alt'), 'The complete drawing');
    assert.equal(await fixture.created[0].blob.text(), 'second drawing');
    assert.equal(await fixture.created[1].blob.text(), 'first drawing');
    owner.destroy();
    owner.destroy();
    assert.deepEqual(fixture.revoked, ['blob:fixture-1', 'blob:fixture-2']);
    assert.equal(external.getAttribute('src'), 'https://example.test/ordinary.png');
});

test('Markdown media readiness includes decode and reports all failures without discarding successful siblings', async function partialFailure() {
    const decode = deferred();
    const decodeEntered = deferred();
    const fixture = createFixture();
    fixture.setRecord('images', 'good.json', imageRecord('complete drawing'));
    fixture.setRecord('images', 'decode.json', imageRecord('unsupported fixture drawing'));
    const good = new FixtureImage('arcane-media:images/good.json', function pendingDecode() {
        decodeEntered.resolve();
        return decode.promise;
    });
    const decodeError = new Error('Fixture decoder failed.');
    const unsupported = new FixtureImage('arcane-media:images/decode.json', function failedDecode() {
        return Promise.reject(decodeError);
    });
    const missing = new FixtureImage('arcane-media:images/missing.json');
    const owner = fixture.api.hydrateMarkdownMedia(fixtureRoot(good, unsupported, missing));
    let settled = false;
    const observed = owner.ready.then(function unexpectedSuccess() {
        settled = true;
    }, function failed(error) {
        settled = true;
        return error;
    });
    await decodeEntered.promise;
    assert.equal(settled, false);
    decode.resolve();
    const error = await observed;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.failures.map(function failedReference(failure) { return failure.reference; }), [
        'arcane-media:images/decode.json', 'arcane-media:images/missing.json'
    ]);
    assert.equal(error.failures[0].reason, decodeError);
    assert.equal(error.failures[1].reason.name, 'NotFoundError');
    assert.ok(good.getAttribute('src').startsWith('blob:fixture-'));
    assert.deepEqual(fixture.revoked, []);
    owner.destroy();
});

test('Markdown media display cancellation settles before pending storage and observes its late result', async function destroyedRead() {
    for (const cancellation of ['destroy', 'abort']) {
        for (const outcome of ['resolve', 'reject']) {
            const read = deferred();
            const entered = deferred();
            const fixture = createFixture({read() { entered.resolve(); return read.promise; }});
            const image = new FixtureImage('arcane-media:images/late.json');
            const controller = new AbortController();
            const owner = fixture.api.hydrateMarkdownMedia(image, {signal: controller.signal});
            const rejected = assert.rejects(owner.ready, function destroyed(error) {
                return error instanceof AggregateError && error.failures[0].reason.name === 'AbortError';
            });
            await entered.promise;
            if (cancellation === 'destroy') owner.destroy();
            else controller.abort();
            // Readiness must reject while the platform read is still pending.
            await rejected;
            assert.equal(image.getAttribute('src'), null);
            assert.deepEqual(fixture.created, []);
            if (outcome === 'resolve') read.resolve(imageRecord('late drawing'));
            else read.reject(new Error('The pending platform read later failed.'));
            await new Promise(function drainLateRead(resolve) {setImmediate(resolve);});
            assert.equal(image.getAttribute('src'), null);
            assert.deepEqual(fixture.created, []);
            assert.deepEqual(fixture.revoked, []);
        }
    }
});

test('Markdown media print retention owns URLs until every print releases once', async function retainedPrint() {
    const fixture = createFixture();
    fixture.setRecord('images', 'print.json', imageRecord('print drawing'));
    const image = new FixtureImage('arcane-media:images/print.json');
    const owner = fixture.api.hydrateMarkdownMedia(image);
    const releaseFirst = owner.retain();
    const releaseSecond = owner.retain();
    await owner.ready;
    owner.destroy();
    assert.deepEqual(fixture.revoked, []);
    assert.equal(image.getAttribute('src'), 'blob:fixture-1');
    releaseFirst();
    releaseFirst();
    assert.deepEqual(fixture.revoked, []);
    releaseSecond();
    releaseSecond();
    assert.deepEqual(fixture.revoked, ['blob:fixture-1']);
    assert.equal(image.getAttribute('src'), null);
    assert.throws(function retainDestroyedOwner() { owner.retain(); }, {name: 'AbortError'});
});

test('Markdown media abort releases an active decode and preserves an independently replaced source', async function abortedDecode() {
    const fixture = createFixture();
    fixture.setRecord('images', 'active.json', imageRecord('active drawing'));
    const entered = deferred();
    const decode = deferred();
    const image = new FixtureImage('arcane-media:images/active.json', function decodeImage() {
        entered.resolve();
        return decode.promise;
    });
    const controller = new AbortController();
    const owner = fixture.api.hydrateMarkdownMedia(image, {signal: controller.signal});
    const reason = new Error('The displayed entry changed.');
    const rejected = assert.rejects(owner.ready, function originalAbortReason(error) {
        return error instanceof AggregateError && error.failures[0].reason === reason;
    });
    await entered.promise;
    image.setAttribute('src', 'https://example.test/replacement.png');
    controller.abort(reason);
    await rejected;
    assert.equal(image.getAttribute('src'), 'https://example.test/replacement.png');
    assert.deepEqual(fixture.revoked, ['blob:fixture-1']);
    decode.resolve();
});

test('Markdown media an already-aborted owner starts no reads or DOM changes', async function preAbortedOwner() {
    const fixture = createFixture();
    const image = new FixtureImage('arcane-media:images/unread.json');
    const controller = new AbortController();
    controller.abort();
    const owner = fixture.api.hydrateMarkdownMedia(image, {signal: controller.signal});
    await assert.rejects(owner.ready, AggregateError);
    assert.deepEqual(fixture.imports, []);
    assert.equal(image.getAttribute('src'), 'arcane-media:images/unread.json');
});
