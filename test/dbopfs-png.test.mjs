import assert from 'node:assert/strict';

import test from '../src/testing.mjs';

async function withDBOPFSPNGFixture(run) {
    const originals = new Map();
    const rasters = new WeakMap();
    const storedTables = new Map();
    const fixture = {
        bitmaps: [],
        bitmapFailure: null,
        contextFailure: null,
        contextUnavailable: false,
        pixelFailure: null,
        events: [],
        directoryCreations: [],
        fileReads: [],
        storageWrites: [],
        downloads: [],
        anchors: [],
        urls: [],
        revokedURLs: [],
        seed(tables) {
            for (const [tableName, records] of Object.entries(tables)) {
                storedTables.set(
                    tableName,
                    {
                        kind: 'directory',
                        name: tableName,
                        async *entries() {
                            for (const fileName of Object.keys(records)) {
                                yield [fileName, {kind: 'file', name: fileName}];
                            }
                        },
                        async getFileHandle(fileName, {create = false} = {}) {
                            if (create) {
                                fixture.storageWrites.push(
                                    {tableName, fileName}
                                );
                            }
                            assert.ok(Object.hasOwn(records, fileName));
                            return {
                                async getFile() {
                                    fixture.fileReads.push(`${tableName}/${fileName}`);
                                    const value = records[fileName];
                                    const content = typeof value === 'string' ? value : JSON.stringify(value);
                                    return new Blob(
                                        [content]
                                    );
                                }
                            };
                        }
                    }
                );
            }
        },
        async backup(json) {
            const compressed = new Blob(
                [json]
            ).stream().pipeThrough(
                new CompressionStream('deflate')
            );
            const compressedData = new Uint8Array(
                await new Response(compressed).arrayBuffer()
            );

            // These fields reproduce the existing PNG transport framing only.
            const payload = new Uint8Array(compressedData.length + 4);
            const header = new DataView(payload.buffer);
            header.setUint32(0, compressedData.length, true);
            payload.set(compressedData, 4);
            return this.backupPayload(payload);
        },
        backupPayload(payload) {
            const width = Math.ceil(Math.sqrt(payload.length / 3));
            const data = new Uint8ClampedArray(width * width * 4);
            let payloadOffset = 0;

            for (let pixelOffset = 0; pixelOffset < data.length; pixelOffset += 4) {
                data[pixelOffset] = payload[payloadOffset++] ?? 0;
                data[pixelOffset + 1] = payload[payloadOffset++] ?? 0;
                data[pixelOffset + 2] = payload[payloadOffset++] ?? 0;
                data[pixelOffset + 3] = 255;
            }

            // Canvas and image decoding are synthetic; deflate and DBOPFS are real.
            const file = new Blob(
                ['synthetic PNG fixture'],
                {type: 'image/png'}
            );
            rasters.set(
                file,
                {width, height: width, data}
            );
            return file;
        }
    };
    const directory = {
        async getDirectoryHandle(name, {create = false} = {}) {
            if (name === 'apps' || name === 'dbopfs-png-fixture') {
                return directory;
            }
            if (!storedTables.has(name) && create) {
                fixture.directoryCreations.push(name);
                fixture.seed(
                    {[name]: {}}
                );
            }
            assert.ok(storedTables.has(name), `The fixture table ${name} exists.`);
            return storedTables.get(name);
        },
        async *entries() {
            yield* storedTables;
        }
    };
    const documentObject = {
        documentElement: {dataset: {arcaneAppId: 'dbopfs-png-fixture'}},
        body: {
            appendChild(anchor) {
                fixture.anchors.push(anchor);
                return anchor;
            }
        },
        createElement(name) {
            if (name === 'a') {
                return {
                    href: '',
                    download: '',
                    removed: false,
                    click() {
                        fixture.downloads.push(
                            {href: this.href, name: this.download}
                        );
                    },
                    remove() {
                        this.removed = true;
                    }
                };
            }
            assert.equal(name, 'canvas');
            let bitmap;
            let raster;

            const canvas = {
                width: 0,
                height: 0,
                getContext(kind) {
                    assert.equal(kind, '2d');
                    if (fixture.contextFailure) {
                        throw fixture.contextFailure;
                    }
                    if (fixture.contextUnavailable) {
                        return null;
                    }

                    return {
                        createImageData(width, height) {
                            return {data: new Uint8ClampedArray(width * height * 4)};
                        },
                        putImageData(image, x, y) {
                            assert.equal(x, 0);
                            assert.equal(y, 0);
                            raster = {width: canvas.width, height: canvas.height, data: image.data};
                        },
                        drawImage(image, x, y) {
                            assert.equal(x, 0);
                            assert.equal(y, 0);
                            bitmap = image;
                        },
                        getImageData(x, y, width, height) {
                            assert.equal(x, 0);
                            assert.equal(y, 0);
                            assert.equal(width, bitmap.width);
                            assert.equal(height, bitmap.height);
                            if (fixture.pixelFailure) {
                                throw fixture.pixelFailure;
                            }
                            fixture.events.push('pixels');
                            return {data: bitmap.data};
                        }
                    };
                },
                toBlob(callback, type) {
                    assert.equal(type, 'image/png');
                    const blob = new Blob(
                        ['synthetic PNG fixture'],
                        {type}
                    );
                    rasters.set(blob, raster);
                    callback(blob);
                }
            };
            return canvas;
        }
    };
    class FixtureURL extends URL {
        static createObjectURL(blob) {
            const url = `blob:dbopfs-png-fixture/${fixture.urls.length}`;
            fixture.urls.push(
                {url, blob}
            );
            return url;
        }

        static revokeObjectURL(url) {
            fixture.revokedURLs.push(url);
        }
    }
    const windowTarget = new EventTarget();
    windowTarget.document = documentObject;
    windowTarget.CompressionStream = CompressionStream;
    const globals = {
        document: documentObject,
        navigator: {
            storage: {
                async getDirectory() {
                    return directory;
                },
                async persist() {
                    return true;
                }
            }
        },
        window: windowTarget,
        URL: FixtureURL,
        async createImageBitmap(file, options) {
            assert.deepEqual(
                options,
                {premultiplyAlpha: 'none'}
            );
            if (fixture.bitmapFailure) {
                throw fixture.bitmapFailure;
            }
            const raster = rasters.get(file);
            assert.ok(raster, 'The fixture owns the supplied synthetic PNG.');
            const bitmap = {
                width: raster.width,
                height: raster.height,
                data: raster.data,
                closeCalls: 0,
                close() {
                    this.closeCalls += 1;
                    fixture.events.push('close');
                }
            };
            fixture.bitmaps.push(bitmap);
            return bitmap;
        }
    };

    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(
            globalThis,
            name,
            {configurable: true, value, writable: true}
        );
    }

    try {
        const {default: DBOPFS} = await import(
            '../runtime/arcane/modules/DBOPFS.js?png-fixture'
        );
        const dbopfs = windowTarget.dbopfs || new DBOPFS();
        await dbopfs.readyPromise;
        await run(dbopfs, fixture);
    } finally {
        for (const [name, descriptor] of originals) {
            if (descriptor) {
                Object.defineProperty(globalThis, name, descriptor);
            } else {
                delete globalThis[name];
            }
        }
    }
}

async function decodedBackup(dbopfs, file) {
    let decoded;
    await dbopfs.restoreFromPNG(
        file,
        {
            selectTables(tables) {
                decoded = tables;
                return {};
            }
        }
    );
    return decoded;
}

test(
    'DBOPFS PNG restore preserves complete records and releases its decoded bitmap',
    async function testPNGRestoreContent() {
        await withDBOPFSPNGFixture(
            async function restoreCompleteRecords(dbopfs, fixture) {
                const content = '  The moon librarian filed a complaint.\r\n雪 ☄️\n  ';
                const records = {
                    documents: {
                        'moon.txt': content,
                        'catalogue.json': {
                            title: 'Météorites et dragons',
                            values: [null, false, 0, '', content],
                            nested: {complete: true}
                        }
                    },
                    memories: {
                        'opening.json': {role: 'assistant', content}
                    },
                    empty: {}
                };
                const writes = [];
                const tables = [];
                const setMany = dbopfs.setMany;
                dbopfs.setMany = function recordTableBatch(tableName, items) {
                    tables.push(tableName);
                    return setMany.call(this, tableName, items);
                };
                dbopfs.writeFile = async function fixtureWrite(tableName, fileName, data, append) {
                    assert.equal(fixture.bitmaps[0].closeCalls, 1);
                    writes.push(
                        {tableName, fileName, data, append}
                    );
                    fixture.events.push(`write:${tableName}/${fileName}`);
                    return true;
                };

                const file = await fixture.backup(JSON.stringify(records));
                assert.equal(await dbopfs.restoreFromPNG(file), undefined);
                assert.deepEqual(tables, ['documents', 'memories', 'empty']);
                assert.deepEqual(
                    writes,
                    [
                        {tableName: 'documents', fileName: 'moon.txt', data: content, append: false},
                        {
                            tableName: 'documents',
                            fileName: 'catalogue.json',
                            data: JSON.stringify(records.documents['catalogue.json']),
                            append: false
                        },
                        {
                            tableName: 'memories',
                            fileName: 'opening.json',
                            data: JSON.stringify(records.memories['opening.json']),
                            append: false
                        }
                    ]
                );
                assert.deepEqual(dbopfs.tables.documents, records.documents);
                assert.deepEqual(dbopfs.tables.memories, records.memories);
                assert.equal(fixture.bitmaps[0].closeCalls, 1);
                assert.deepEqual(
                    fixture.events,
                    [
                        'pixels',
                        'close',
                        'write:documents/moon.txt',
                        'write:documents/catalogue.json',
                        'write:memories/opening.json'
                    ]
                );
            }
        );
    }
);

test(
    'DBOPFS creates a complete PNG Blob without downloading or writing storage',
    async function testPNGBlobExport() {
        await withDBOPFSPNGFixture(
            async function exportCompleteDatabase(dbopfs, fixture) {
                const content = '  A dragon ate the index.\r\n星図 🐉\n  ';
                const documents = {
                    'note.txt': content,
                    'catalogue.json': {content, values: [null, false, 0, '']},
                    'literal.txt': '  {"this":"stays a string"}\n'
                };
                const memories = {'opening.json': {role: 'assistant', content}};
                fixture.seed(
                    {documents, memory: memories, empty: {}}
                );

                const blob = await dbopfs.createCompressedPNG();
                assert.ok(blob instanceof Blob);
                assert.equal(blob.type, 'image/png');
                assert.deepEqual(
                    await decodedBackup(dbopfs, blob),
                    {documents, memories, empty: {}}
                );
                assert.deepEqual(
                    fixture.fileReads,
                    [
                        'documents/note.txt',
                        'documents/catalogue.json',
                        'documents/literal.txt',
                        'memory/opening.json'
                    ]
                );
                assert.deepEqual(fixture.storageWrites, []);
                assert.deepEqual(fixture.directoryCreations, []);
                assert.deepEqual(fixture.downloads, []);
                assert.deepEqual(fixture.anchors, []);
                assert.deepEqual(fixture.urls, []);
            }
        );
    }
);

test(
    'DBOPFS PNG export selects tables and replaces saved tables with caller records',
    async function testPNGSelectedTables() {
        await withDBOPFSPNGFixture(
            async function exportSelectedAndSuppliedTables(dbopfs, fixture) {
                const records = {
                    documents: {'old.txt': 'saved document'},
                    memory: {'saved.json': {content: 'saved memory'}},
                    ignored: {'outside.txt': 'outside the selection'}
                };
                const memory = {'chosen.json': {content: '  Complete supplied memory.\n雪  '}};
                const supplied = {'weather.txt': 'Meteor showers, indoors.\n'};
                const options = {
                    tableNames: ['memory', 'memories', 'missing'],
                    additionalTables: {memory, supplied}
                };
                const originalOptions = structuredClone(options);
                fixture.seed(records);

                const blob = await dbopfs.createCompressedPNG(options);
                assert.deepEqual(
                    await decodedBackup(dbopfs, blob),
                    {memories: memory, missing: {}, supplied}
                );
                assert.deepEqual(options, originalOptions);
                assert.deepEqual(fixture.fileReads, []);
                assert.deepEqual(fixture.directoryCreations, []);
                assert.deepEqual(fixture.storageWrites, []);

                const savedMemory = await dbopfs.get('memories', 'saved.json');
                assert.deepEqual(savedMemory, records.memory['saved.json']);
                const selected = await dbopfs.createCompressedPNG(
                    {tableNames: ['documents']}
                );
                assert.deepEqual(
                    await decodedBackup(dbopfs, selected),
                    {documents: records.documents}
                );
                const empty = await dbopfs.createCompressedPNG(
                    {tableNames: []}
                );
                assert.deepEqual(await decodedBackup(dbopfs, empty), {});
                assert.deepEqual(fixture.directoryCreations, []);
                assert.deepEqual(fixture.storageWrites, []);
                assert.deepEqual(fixture.downloads, []);
            }
        );
    }
);

test(
    'DBOPFS PNG download delegates its options and cleans its one download link',
    async function testPNGDownloadDelegation() {
        await withDBOPFSPNGFixture(
            async function downloadSelectedBlob(dbopfs, fixture) {
                const records = {documents: {'note.txt': 'The library is orbiting.'}};
                const supplied = {weather: {'forecast.txt': 'Light asteroid rain.'}};
                fixture.seed(records);
                const options = {tableNames: [], additionalTables: supplied};
                const create = dbopfs.createCompressedPNG;
                const receivedOptions = [];
                dbopfs.createCompressedPNG = function recordPNGOptions(selection) {
                    receivedOptions.push(selection);
                    return create.call(this, selection);
                };

                assert.equal(await dbopfs.downloadCompressedPNG('moon-archive', options), undefined);
                assert.equal(receivedOptions[0], options);
                assert.equal(fixture.downloads.length, 1);
                assert.match(
                    fixture.downloads[0].name,
                    /^moon-archive-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/u
                );
                assert.equal(fixture.downloads[0].href, fixture.urls[0].url);
                assert.deepEqual(fixture.revokedURLs, [fixture.urls[0].url]);
                assert.equal(fixture.anchors[0].removed, true);
                assert.deepEqual(
                    await decodedBackup(dbopfs, fixture.urls[0].blob),
                    supplied
                );

                assert.equal(await dbopfs.downloadCompressedPNG(), undefined);
                assert.equal(fixture.downloads.length, 2);
                assert.match(
                    fixture.downloads[1].name,
                    /^DBOPFS-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/u
                );
                assert.deepEqual(
                    await decodedBackup(dbopfs, fixture.urls[1].blob),
                    records
                );
                assert.deepEqual(
                    fixture.revokedURLs,
                    [fixture.urls[0].url, fixture.urls[1].url]
                );
                assert.equal(fixture.anchors[1].removed, true);
                assert.deepEqual(fixture.storageWrites, []);
            }
        );
    }
);

test(
    'DBOPFS PNG export cancellation prevents later reads and download effects',
    async function testPNGExportCancellation() {
        await withDBOPFSPNGFixture(
            async function cancelPNGPreparation(dbopfs, fixture) {
                fixture.seed(
                    {documents: {'first.txt': 'first complete record', 'later.txt': 'later complete record'}}
                );
                const before = new AbortController();
                const beforeReason = new Error('Cancelled before PNG preparation.');
                before.abort(beforeReason);
                function originalBeforeReason(reason) {
                    return reason === beforeReason;
                }

                await assert.rejects(
                    dbopfs.createCompressedPNG(
                        {signal: before.signal}
                    ),
                    originalBeforeReason
                );
                await assert.rejects(
                    dbopfs.downloadCompressedPNG(
                        'cancelled',
                        {signal: before.signal}
                    ),
                    originalBeforeReason
                );
                assert.deepEqual(fixture.fileReads, []);

                const during = new AbortController();
                const duringReason = new Error('Cancelled while reading the first record.');
                const started = Promise.withResolvers();
                const released = Promise.withResolvers();
                const finished = Promise.withResolvers();
                const get = dbopfs.get;
                const requests = [];
                dbopfs.get = async function fixturePendingRead(tableName, fileName) {
                    requests.push(`${tableName}/${fileName}`);
                    started.resolve();
                    try {
                        await released.promise;
                        return await get.call(this, tableName, fileName);
                    } finally {
                        finished.resolve();
                    }
                };
                const download = dbopfs.downloadCompressedPNG(
                    'cancelled',
                    {signal: during.signal}
                );
                const rejection = assert.rejects(
                    download,
                    function originalDuringReason(reason) {
                        return reason === duringReason;
                    }
                );

                try {
                    await Promise.race(
                        [started.promise, rejection]
                    );
                    during.abort(duringReason);
                    released.resolve();
                    await rejection;
                    await finished.promise;
                    assert.deepEqual(requests, ['documents/first.txt']);
                    assert.deepEqual(fixture.downloads, []);
                    assert.deepEqual(fixture.anchors, []);
                    assert.deepEqual(fixture.urls, []);
                    assert.deepEqual(fixture.storageWrites, []);
                } finally {
                    released.resolve();
                    await rejection;
                }
            }
        );
    }
);

test(
    'DBOPFS PNG restore awaits one complete caller selection before writing',
    async function testPNGRestoreSelection() {
        await withDBOPFSPNGFixture(
            async function selectRestoredTables(dbopfs, fixture) {
                const records = {
                    documents: {'chosen.txt': '  Preserve this text.\n雪  ', 'other.txt': 'another record'},
                    memories: {'saved.json': {content: 'unselected memory'}},
                    metadata: {'backup.json': {version: 1}}
                };
                const writes = [];
                const selected = Promise.withResolvers();
                const releaseSelection = Promise.withResolvers();
                let calls = 0;
                let received;
                dbopfs.writeFile = async function fixtureSelectedWrite(tableName, fileName, data) {
                    writes.push(
                        {tableName, fileName, data}
                    );
                    return true;
                };
                const file = await fixture.backup(JSON.stringify(records));
                const restoration = dbopfs.restoreFromPNG(
                    file,
                    {
                        async selectTables(tables) {
                            calls += 1;
                            received = tables;
                            selected.resolve();
                            await releaseSelection.promise;
                            return {restored: {'note.txt': tables.documents['chosen.txt']}};
                        }
                    }
                );

                try {
                    await Promise.race(
                        [selected.promise, restoration]
                    );
                    assert.equal(calls, 1);
                    assert.deepEqual(received, records);
                    assert.deepEqual(writes, []);
                    assert.equal(fixture.bitmaps[0].closeCalls, 1);
                    releaseSelection.resolve();
                    assert.equal(await restoration, undefined);
                    assert.equal(calls, 1);
                    assert.deepEqual(
                        writes,
                        [
                            {tableName: 'restored', fileName: 'note.txt', data: records.documents['chosen.txt']}
                        ]
                    );
                    assert.deepEqual(received, records);
                } finally {
                    releaseSelection.resolve();
                    await restoration;
                }

                writes.length = 0;
                const selectionFailure = new Error('The caller declined this backup.');
                await assert.rejects(
                    dbopfs.restoreFromPNG(
                        file,
                        {
                            async selectTables(tables) {
                                assert.deepEqual(tables, records);
                                throw selectionFailure;
                            }
                        }
                    ),
                    function originalSelectionFailure(reason) {
                        return reason === selectionFailure;
                    }
                );
                assert.deepEqual(writes, []);
                assert.equal(fixture.bitmaps.at(-1).closeCalls, 1);
            }
        );
    }
);

test(
    'DBOPFS PNG restore settles every table and retains original write failures',
    async function testPNGRestoreSettledFailures() {
        await withDBOPFSPNGFixture(
            async function restoreRejectedWrites(dbopfs, fixture) {
                const firstFailure = new Error('The first fixture write failed.');
                const laterFailure = {message: 'The later fixture write failed.', detail: ['complete', 'reason']};
                const records = {
                    documents: {'failed.txt': 'first', 'saved.txt': 'keep this'},
                    memories: {'later.txt': 'second failure', 'last.txt': 'keep that'},
                    final: {'complete.txt': 'the final table was attempted'}
                };
                const attempted = [];
                const settled = [];
                const saved = new Map();
                const firstStarted = Promise.withResolvers();
                const finalStarted = Promise.withResolvers();
                const firstWrite = Promise.withResolvers();
                const finalWrite = Promise.withResolvers();
                let completed = false;

                dbopfs.writeFile = async function fixtureSettledWrite(tableName, fileName, data) {
                    const key = `${tableName}/${fileName}`;
                    attempted.push(key);
                    try {
                        if (key === 'documents/failed.txt') {
                            firstStarted.resolve();
                            await firstWrite.promise;
                        }
                        if (key === 'memories/later.txt') {
                            throw laterFailure;
                        }
                        if (key === 'final/complete.txt') {
                            finalStarted.resolve();
                            await finalWrite.promise;
                        }
                        saved.set(key, data);
                        return true;
                    } finally {
                        settled.push(key);
                    }
                };

                const file = await fixture.backup(JSON.stringify(records));
                const outcome = dbopfs.restoreFromPNG(file).then(
                    function restoreFulfilled(value) {
                        completed = true;
                        return {status: 'fulfilled', value};
                    },
                    function restoreRejected(reason) {
                        completed = true;
                        return {status: 'rejected', reason};
                    }
                );

                try {
                    await Promise.race(
                        [firstStarted.promise, outcome]
                    );
                    assert.equal(completed, false);
                    assert.equal(fixture.bitmaps[0].closeCalls, 1);
                    firstWrite.reject(firstFailure);
                    await Promise.race(
                        [finalStarted.promise, outcome]
                    );
                    assert.equal(completed, false, 'Restore waits for the final outstanding write.');
                    assert.deepEqual(
                        attempted,
                        [
                            'documents/failed.txt',
                            'documents/saved.txt',
                            'memories/later.txt',
                            'memories/last.txt',
                            'final/complete.txt'
                        ]
                    );
                    finalWrite.resolve();

                    const result = await outcome;
                    assert.equal(result.status, 'rejected');
                    assert.ok(result.reason instanceof AggregateError);
                    assert.equal(result.reason.code, 'DBOPFS_RESTORE_WRITE_FAILED');
                    assert.deepEqual(result.reason.errors, [firstFailure, laterFailure]);
                    assert.equal(result.reason.errors[0], firstFailure);
                    assert.equal(result.reason.errors[1], laterFailure);
                    assert.deepEqual(
                        result.reason.failures,
                        [
                            {tableName: 'documents', fileName: 'failed.txt', reason: firstFailure},
                            {tableName: 'memories', fileName: 'later.txt', reason: laterFailure}
                        ]
                    );
                    assert.equal(result.reason.failures[0].reason, firstFailure);
                    assert.equal(result.reason.failures[1].reason, laterFailure);
                    assert.deepEqual(new Set(settled), new Set(attempted));
                    assert.deepEqual(
                        Array.from(saved),
                        [
                            ['documents/saved.txt', 'keep this'],
                            ['memories/last.txt', 'keep that'],
                            ['final/complete.txt', 'the final table was attempted']
                        ]
                    );
                    assert.equal(fixture.bitmaps[0].closeCalls, 1);
                } finally {
                    firstWrite.resolve();
                    finalWrite.resolve();
                    await outcome;
                }
            }
        );
    }
);

test(
    'DBOPFS PNG restore closes allocated bitmaps when decoding or extraction fails',
    async function testPNGRestoreDecodeCleanup() {
        await withDBOPFSPNGFixture(
            async function restoreDecodeFailures(dbopfs, fixture) {
                const file = await fixture.backup('{"documents":{"note.txt":"complete"}}');
                let writes = 0;
                dbopfs.writeFile = async function unexpectedFixtureWrite() {
                    writes += 1;
                };

                const bitmapFailure = new Error('Synthetic image decoder failure.');
                fixture.bitmapFailure = bitmapFailure;
                await assert.rejects(
                    dbopfs.restoreFromPNG(file),
                    function originalBitmapFailure(reason) {
                        return reason === bitmapFailure;
                    }
                );
                assert.deepEqual(fixture.bitmaps, []);
                fixture.bitmapFailure = null;

                fixture.contextUnavailable = true;
                await assert.rejects(
                    dbopfs.restoreFromPNG(file),
                    {message: 'Canvas 2D context unavailable.'}
                );
                assert.equal(fixture.bitmaps.at(-1).closeCalls, 1);
                fixture.contextUnavailable = false;

                const contextFailure = new Error('Synthetic canvas context failure.');
                fixture.contextFailure = contextFailure;
                await assert.rejects(
                    dbopfs.restoreFromPNG(file),
                    function originalContextFailure(reason) {
                        return reason === contextFailure;
                    }
                );
                assert.equal(fixture.bitmaps.at(-1).closeCalls, 1);
                fixture.contextFailure = null;

                const pixelFailure = new Error('Synthetic pixel extraction failure.');
                fixture.pixelFailure = pixelFailure;
                await assert.rejects(
                    dbopfs.restoreFromPNG(file),
                    function originalPixelFailure(reason) {
                        return reason === pixelFailure;
                    }
                );
                assert.equal(fixture.bitmaps.at(-1).closeCalls, 1);
                fixture.pixelFailure = null;

                const invalidJSON = await fixture.backup('{this is incomplete JSON');
                await assert.rejects(dbopfs.restoreFromPNG(invalidJSON), SyntaxError);
                assert.equal(fixture.bitmaps.at(-1).closeCalls, 1);

                const invalidDeflate = fixture.backupPayload(
                    new Uint8Array([1, 0, 0, 0, 0])
                );
                await assert.rejects(dbopfs.restoreFromPNG(invalidDeflate));
                assert.equal(fixture.bitmaps.at(-1).closeCalls, 1);
                assert.equal(writes, 0);
            }
        );
    }
);
