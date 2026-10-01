import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import Is from '../browser-runtime/dependencies/strong-type/index.js';
import test from '../src/testing.mjs';

const is = new Is(false);

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
    const files = new Map();
    const records = new Map();
    const reads = [];
    const writes = [];
    const created = [];
    const revoked = [];
    const imports = [];

    function parseStoredValue(fileName, text) {
        const extension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
        if (extension === 'json') {
            try {return JSON.parse(text.trim());} catch {return text;}
        }
        if (extension === 'jsonl' || extension === 'ndjson') {
            const values = [];
            for (const row of text.split('\n')) {
                if (!row.trim()) continue;
                try {values.push(JSON.parse(row.trim()));} catch {values.push(row);}
            }
            return values;
        }
        return text;
    }

    function setStoredFile(tableName, fileName, text) {
        const key = JSON.stringify([tableName, fileName]);
        files.set(key, text);
        records.delete(key);
    }

    function setRecord(tableName, fileName, value) {
        const text = is.string(value) ? value : JSON.stringify(value);
        setStoredFile(tableName, fileName, text);
        records.set(JSON.stringify([tableName, fileName]), parseStoredValue(fileName, text));
    }

    const database = {
        async set(tableName, fileName, value) {
            writes.push({tableName, fileName, value});
            await options.write?.(tableName, fileName, value);
            setRecord(tableName, fileName, value);
            return records.get(JSON.stringify([tableName, fileName]));
        },
        async get(tableName, fileName) {
            reads.push({tableName, fileName});
            if (options.read) return options.read(tableName, fileName);
            const key = JSON.stringify([tableName, fileName]);
            if (!records.get(key)) {
                if (!files.has(key)) return null;
                records.set(key, parseStoredValue(fileName, files.get(key)));
            }
            return records.get(key);
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
            + '\nreturn {parseMarkdownMediaReference, saveMarkdownMedia, decodeMarkdownMediaRecord, readMarkdownMedia, hydrateMarkdownMedia};'
    );
    const api = initialize(Is, loadDatabase, FixtureFileReader, Blob, {
        randomUUID() { return 'fixture-image'; }
    }, atob, objectURLs, DOMException);
    return {api, files, records, setRecord, setStoredFile, reads, writes, created, revoked, imports};
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

test('Markdown media synchronously decodes complete records and JSON without storage or mutation', async function decodeCompleteRecord() {
    const fixture = createFixture();
    const content = '<svg><text>Complete moon library: 月 🐉</text></svg>';
    const record = imageRecord(content);
    const before = JSON.stringify(record);
    for (const value of [record, [record], [[record]], before, `\n ${before}\n`, JSON.stringify([[record]])]) {
        const blob = fixture.api.decodeMarkdownMediaRecord(value);
        assert.ok(blob instanceof Blob);
        assert.equal(blob.type, record.mediaType);
        assert.equal(await blob.text(), content);
    }
    assert.equal(JSON.stringify(record), before);
    const untyped = fixture.api.decodeMarkdownMediaRecord({dataUrl: record.dataUrl});
    assert.equal(untyped.type, '');
    assert.equal(await untyped.text(), content);
    assert.deepEqual(fixture.imports, []);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.created, []);
});

test('Markdown media decoder leaves unrecognized, multiple, and mixed records to their existing owner', function unrecognizedRecords() {
    const fixture = createFixture();
    const record = imageRecord('Complete drawing');
    const serialized = JSON.stringify(record);
    for (const value of [
        null, undefined, 42, {}, [], {content: 'Ordinary complete JSON'},
        {mediaType: 'image/png'},
        [record, record], [[record, record]], [record, 'Unparseable row'],
        'null', '\n  \n', 'Unparseable complete text',
        `${serialized}\n${serialized}\n`, `${serialized}\nUnparseable original row\n`
    ]) {
        assert.equal(fixture.api.decodeMarkdownMediaRecord(value), null);
    }
    assert.deepEqual(fixture.imports, []);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(fixture.writes, []);
});

test('Markdown media decoder exposes recognized encoding errors without interpreting remote URLs', function decodeErrors() {
    const fixture = createFixture();
    assert.throws(function remoteRecord() {
        fixture.api.decodeMarkdownMediaRecord({mediaType: 'image/png', dataUrl: 'https://example.test/drawing.png'});
    }, {name: 'TypeError', message: 'Markdown image has an unreadable data URL.'});
    assert.throws(function malformedEncoding() {
        fixture.api.decodeMarkdownMediaRecord(JSON.stringify({mediaType: 'image/png', dataUrl: 'data:image/png;base64,%%%'}));
    }, {name: 'InvalidCharacterError'});
    assert.deepEqual(fixture.imports, []);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(fixture.writes, []);
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
    restored.setStoredFile(saved.tableName, saved.fileName, JSON.stringify(fixture.writes[0].value));
    assert.deepEqual([...restored.records], []);
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

test('Markdown media reads warm and cold records with DBOPFS case-insensitive filename parsing', async function recordFileNames() {
    const content = '<svg><text>Complete lunar library: 月 🐉</text></svg>';
    const expected = imageRecord(content);
    for (const fileName of ['drawing.json', 'drawing.JSON', 'drawing.jsonl', 'drawing.JsOnL', 'drawing.ndjson', 'drawing.NDJSON', 'drawing.media', 'drawing']) {
        const fixture = createFixture();
        const saved = await fixture.api.saveMarkdownMedia({
            blob: new Blob([content], {type: expected.mediaType}), tableName: 'journal images', fileName
        });
        const key = JSON.stringify([saved.tableName, fileName]);
        const extension = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
        const parsed = extension === 'json' ? expected
            :['jsonl', 'ndjson'].includes(extension) ? [expected] : JSON.stringify(expected);
        assert.equal(saved.fileName, fileName);
        assert.equal(fixture.writes[0].fileName, fileName);
        assert.equal(fixture.files.get(key), JSON.stringify(expected));
        assert.deepEqual(fixture.records.get(key), parsed);
        assert.equal(await (await fixture.api.readMarkdownMedia(saved.reference)).text(), content);

        const cold = createFixture();
        cold.setStoredFile(saved.tableName, fileName, fixture.files.get(key));
        assert.deepEqual([...cold.records], []);
        const blob = await cold.api.readMarkdownMedia(saved.reference);
        assert.equal(blob.type, expected.mediaType);
        assert.equal(await blob.text(), content);
        assert.deepEqual(cold.records.get(key), parsed);
        assert.deepEqual(cold.writes, []);
        assert.equal(cold.files.get(key), fixture.files.get(key));
    }
});

test('Markdown media reads singleton record layers after cold JSONL backup restoration', async function restoredRecordArrays() {
    const content = '<svg><text>The complete restored moon atlas.</text></svg>';
    for (const fileName of ['atlas.jsonl', 'atlas.NDJSON']) {
        let fixture = createFixture();
        const saved = await fixture.api.saveMarkdownMedia({blob: new Blob([content], {type: 'image/svg+xml'}), fileName});
        const key = JSON.stringify([saved.tableName, fileName]);
        for (let restoration = 0; restoration < 2; restoration += 1) {
            // DBOPFS backup serializes get()'s parsed value; restore passes that
            // complete value to setMany/set, which serializes it as one row.
            const backupValue = JSON.parse(JSON.stringify(fixture.records.get(key)));
            const restored = createFixture();
            restored.setRecord(saved.tableName, fileName, backupValue);
            const restoredText = restored.files.get(key);
            assert.equal(restoredText, JSON.stringify(backupValue));
            restored.records.clear();
            const blob = await restored.api.readMarkdownMedia(saved.reference);
            assert.equal(blob.type, 'image/svg+xml');
            assert.equal(await blob.text(), content);
            assert.equal(restored.files.get(key), restoredText);
            assert.deepEqual(restored.writes, []);
            fixture = restored;
        }
    }
});

test('Markdown media never selects an image from multiple records or unreadable JSONL rows', async function unreadableRecordArrays() {
    const first = imageRecord('First complete drawing');
    const second = imageRecord('Second complete drawing');
    const cases = [
        ['multiple.jsonl', `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`],
        ['nested.NDJSON', `${JSON.stringify([[first, second]])}\n`],
        ['mixed.JsOnL', `${JSON.stringify(first)}\nComplete unparseable row.\n`],
        ['unreadable.ndjson', 'Complete unparseable row.\n'],
        ['empty.jsonl', '\n  \n'],
        ['null.ndjson', 'null\n'],
        ['multiple.JSON', JSON.stringify([first, second])]
    ];
    for (const [fileName, content] of cases) {
        const fixture = createFixture();
        fixture.setStoredFile('images', fileName, content);
        const reference = `arcane-media:images/${encodeURIComponent(fileName)}`;
        await assert.rejects(fixture.api.readMarkdownMedia(reference), {
            name: 'TypeError', message: `Markdown image has an unreadable data URL: ${reference}`
        });
        assert.equal(fixture.files.get(JSON.stringify(['images', fileName])), content);
        assert.deepEqual(fixture.writes, []);
    }
    const malformed = createFixture();
    malformed.setStoredFile('images', 'unreadable.json', 'Complete unparseable record.');
    await assert.rejects(malformed.api.readMarkdownMedia('arcane-media:images/unreadable.json'), SyntaxError);
    assert.deepEqual(malformed.writes, []);
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
    fixture.setRecord('images', 'untyped.json', {dataUrl: imageRecord('Complete untyped drawing').dataUrl});
    const untyped = await fixture.api.readMarkdownMedia('arcane-media:images/untyped.json');
    assert.equal(untyped.type, '');
    assert.equal(await untyped.text(), 'Complete untyped drawing');
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
