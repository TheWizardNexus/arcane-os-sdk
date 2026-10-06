import assert from 'node:assert/strict';
import {test} from '../src/testing.mjs';
import {createDbopfsModelPartStore, withDbopfsModelLock} from '../browser-runtime/ai/dbopfs-model-parts.mjs';
import {createDbopfsResourceStore} from '../browser-runtime/ai/dbopfs-model-resources.mjs';

function memoryStorage() {
    const files = new Map();
    function missing() {
        return new DOMException('Missing fixture file.', 'NotFoundError');
    }
    const directory = {
        async getFileHandle(name, {create = false} = {}) {
            if (!files.has(name) && !create) throw missing();
            return {
                async getFile() {
                    if (!files.has(name)) throw missing();
                    return files.get(name);
                },
                async createWritable() {
                    const chunks = [];
                    return {
                        async write(chunk) { chunks.push(chunk); },
                        async close() { files.set(name, new Blob(chunks)); },
                        async abort() {}
                    };
                }
            };
        },
        async removeEntry(name) {
            if (!files.delete(name)) throw missing();
        }
    };
    return {
        files,
        dbopfs: {async getTableHandle() { return directory; }}
    };
}

function deferred() {
    const result = {};
    result.promise = new Promise(function retainCompletion(resolve) {
        result.resolve = resolve;
    });
    return result;
}

test('unknown-total streams aggregate network chunks and preserve full text', async function streamedParts() {
    const fixture = memoryStorage();
    const store = createDbopfsModelPartStore({dbopfs: fixture.dbopfs, tableName: 'models'});
    const progress = [];
    async function* dragonPages() {
        for (let index = 0; index < 100; index += 1) yield '  dragon 🐉\n';
    }
    const result = await store.write('dragon', dragonPages(), {
        onProgress: function recordProgress(value) { progress.push(value); }
    });
    assert.equal(await result.text(), '  dragon 🐉\n'.repeat(100));
    assert.equal(await (await store.read('dragon')).text(), await result.text());
    assert.deepEqual((await store.state('dragon')).parts, ['dragon.arcane-part-0']);
    assert.deepEqual(progress.at(-1), {phase: 'download', completed: 1, total: 1, unit: 'shards'});
    for (const update of progress.slice(0, -1)) assert.equal(update.total, null);
});

test('a queued cancellation leaves the active storage owner running', async function cancelledStorageWait() {
    const fixture = memoryStorage();
    const started = deferred();
    const finish = deferred();
    const controller = new AbortController();
    let waiterRan = false;
    const first = withDbopfsModelLock(fixture.dbopfs, 'models', 'same-resource', async function activeOwner() {
        started.resolve();
        await finish.promise;
        return 'complete';
    });
    await started.promise;
    const second = withDbopfsModelLock(fixture.dbopfs, 'models', 'same-resource', function queuedOwner() {
        waiterRan = true;
    }, {signal: controller.signal});
    controller.abort(new Error('The second reader left.'));
    await assert.rejects(second, /second reader left/u);
    assert.equal(waiterRan, false);
    finish.resolve();
    assert.equal(await first, 'complete');
    const third = await withDbopfsModelLock(fixture.dbopfs, 'models', 'same-resource', function nextOwner() {
        return 'next';
    });
    assert.equal(third, 'next');
    assert.equal(waiterRan, false);
});

test('interrupted sharding preserves closed parts and joins reader cancellation', async function cancelledParts() {
    const fixture = memoryStorage();
    const store = createDbopfsModelPartStore({dbopfs: fixture.dbopfs, tableName: 'models'});
    const controller = new AbortController();
    const cancelling = deferred();
    const finishCancellation = deferred();
    const closed = deferred();
    const body = new ReadableStream(
        {
            start(stream) {
                // This is the physical framing boundary, not a model acceptance limit.
                stream.enqueue(new Uint8Array(8 * 1024 * 1024).fill(42));
            },
            async cancel() {
                cancelling.resolve();
                await finishCancellation.promise;
            }
        }
    );
    const writing = store.write('dragon', body, {
        signal: controller.signal,
        onProgress: function observeClosedPart(progress) {
            if (progress.completed === 1) closed.resolve();
        }
    });
    let settled = false;
    const outcome = writing.then(function unexpectedlyCompleted() {
        settled = true;
        assert.fail('The aborted stream completed.');
    }, function cancelled(error) {
        settled = true;
        assert.equal(error, controller.signal.reason);
    });
    await closed.promise;
    controller.abort(new Error('The tea robot changed models.'));
    await cancelling.promise;
    assert.equal(settled, false);
    finishCancellation.resolve();
    await outcome;
    assert.equal(await store.read('dragon'), null);
    assert.deepEqual(await store.state('dragon'), {parts: ['dragon.arcane-part-0'], complete: false});
    assert.ok(await store.readPartial('dragon'));
});

function seedInterruptedResource(fixture, url, content) {
    const key = JSON.stringify(['GET', url, 'same-origin', []]);
    fixture.files.set('arcane-model-resources.json', new Blob([JSON.stringify({entries: [
        {key, name: 'arcane-resource-0', metadata: {status: 200, statusText: 'OK',
            headers: [['content-type', 'text/plain'], ['etag', 'dragon-edition']], url, redirected: false}}
    ]})]));
    fixture.files.set('arcane-resource-0.arcane-parts.json', new Blob([JSON.stringify(
        {parts: ['arcane-resource-0.arcane-part-0'], complete: false}
    )]));
    fixture.files.set('arcane-resource-0.arcane-part-0', new Blob([content]));
}

test('resource resume accepts honored 206 and full 200 replaces the interrupted prefix', async function resourceResume() {
    for (const resume of [true, false]) {
        const fixture = memoryStorage();
        const url = 'https://models.example.test/dragon/onnx/model.onnx_data';
        seedInterruptedResource(fixture, url, 'dragon ');
        const calls = [];
        const store = createDbopfsResourceStore({dbopfs: fixture.dbopfs, tableName: 'models',
            fetchImpl: async function fetchDragon(request) {
                calls.push(request);
                assert.equal(request.headers.get('range'), 'bytes=7-');
                assert.equal(request.headers.get('if-range'), 'dragon-edition');
                return resume
                    ? new Response('tea', {status: 206, headers: {'content-range': 'bytes 7-9/10'}})
                    : new Response('dragon tea', {status: 200});
            }});
        const resource = await store.fetchResource(url);
        assert.equal(resource.status, 200);
        assert.equal(await resource.file.text(), 'dragon tea');
        assert.equal(await (await store.fetchResource(url)).file.text(), 'dragon tea');
        assert.equal(calls.length, 1);
    }
});

test('stored resource progress reports a cache read without another network download', async function cachedResourceProgress() {
    const fixture = memoryStorage();
    const progress = [];
    let networkRequests = 0;
    const store = createDbopfsResourceStore({
        dbopfs: fixture.dbopfs,
        tableName: 'models',
        fetchImpl: async function fetchMoonRaccoon() {
            networkRequests += 1;
            return new Response('Every moon raccoon voice sample.');
        },
    });
    const url = 'https://models.example.test/moon-raccoon/voice.bin';
    await store.fetchResource(url);
    const stored = await store.fetchResource(url, {
        onProgress: function observeStoredRead(value) { progress.push(value); },
    });
    assert.equal(await stored.file.text(), 'Every moon raccoon voice sample.');
    assert.equal(networkRequests, 1);
    assert.deepEqual(progress, [0, 1].map(function expectedStoredRead(completed) {
        return {
            phase: 'load',
            message: 'Reading stored model resource',
            completed,
            total: 1,
            unit: 'shards',
            cached: true,
            url,
        };
    }));
});

test('stored parts report each known shard and preserve cancellation and observer failures', async function storedPartProgress() {
    const fixture = memoryStorage();
    const store = createDbopfsModelPartStore({dbopfs: fixture.dbopfs, tableName: 'models'});
    const names = ['dragon-one', 'dragon-two', 'dragon-three'];
    fixture.files.set('dragon.arcane-parts.json', new Blob([JSON.stringify({parts: names, complete: true})]));
    for (const name of names) fixture.files.set(name, new Blob([`  ${name}\n`]));
    const progress = [];
    const stored = await store.read('dragon', {
        onProgress: function observePart(value) { progress.push(value); },
    });
    assert.equal(await stored.text(), names.map(function partContent(name) { return `  ${name}\n`; }).join(''));
    assert.deepEqual(progress.map(function count(value) { return value.completed; }), [0, 1, 2, 3]);
    assert.ok(progress.every(function knownCachePlan(value) {
        return value.phase === 'load' && value.total === 3 && value.unit === 'shards' && value.cached === true;
    }));
    const controller = new AbortController();
    const reason = new Error('The dragon reader changed its selection.');
    await assert.rejects(store.read('dragon', {
        signal: controller.signal,
        onProgress: function cancelAfterFirstPart(value) {
            if (value.completed === 1) controller.abort(reason);
        },
    }), function sameCancellation(error) { return error === reason; });
    const observerFailure = new Error('The dragon progress observer failed.');
    await assert.rejects(store.read('dragon', {
        onProgress: function failObserver() { throw observerFailure; },
    }), function sameFailure(error) { return error === observerFailure; });
    assert.equal(await (await store.read('dragon')).text(), await stored.text());
});

test('honest HTTP error responses preserve interrupted successful resource parts', async function failedResourceResponse() {
    const fixture = memoryStorage();
    const url = 'https://models.example.test/dragon/tokenizer.json';
    seedInterruptedResource(fixture, url, 'dragon ');
    const store = createDbopfsResourceStore({dbopfs: fixture.dbopfs, tableName: 'models',
        fetchImpl: async function unavailableResource() {
            return new Response('The tea server is resting.\nComplete diagnostic.', {
                status: 503, statusText: 'Tea break', headers: {'retry-after': '1'}
            });
        }});
    const resource = await store.fetchResource(url);
    assert.equal(resource.status, 503);
    assert.equal(resource.statusText, 'Tea break');
    assert.equal(await resource.file.text(), 'The tea server is resting.\nComplete diagnostic.');
    const parts = createDbopfsModelPartStore({dbopfs: fixture.dbopfs, tableName: 'models'});
    assert.equal(await (await parts.readPartial('arcane-resource-0')).text(), 'dragon ');
    assert.equal(await parts.read('arcane-resource-0'), null);
});

test('unhonored resumed ranges restart through an ordinary full request', async function unhonoredRange() {
    const fixture = memoryStorage();
    const url = 'https://models.example.test/dragon/model.onnx';
    seedInterruptedResource(fixture, url, 'dragon ');
    const requests = [];
    const store = createDbopfsResourceStore({dbopfs: fixture.dbopfs, tableName: 'models',
        fetchImpl: async function fetchDragon(request) {
            requests.push(request);
            return requests.length === 1
                ? new Response('dragon tea', {status: 206, headers: {'content-range': 'bytes 0-9/10'}})
                : new Response('dragon tea');
        }});
    const result = await store.fetchResource(url);
    assert.equal(await result.file.text(), 'dragon tea');
    assert.equal(requests[0].headers.get('range'), 'bytes=7-');
    assert.equal(requests[1].headers.has('range'), false);
});

test('same-resource requests from separate DBOPFS instances use the shared lock owner', async function sharedStorageLocks() {
    const fixture = memoryStorage();
    const tails = new Map();
    const lockNames = [];
    const lockManager = {
        request(name, options, operation) {
            lockNames.push(name);
            assert.equal(options.mode, 'exclusive');
            assert.equal(Object.hasOwn(options, 'ifAvailable'), false);
            const previous = tails.get(name) ?? Promise.resolve();
            const current = previous.then(operation, operation);
            tails.set(name, current);
            return current;
        }
    };
    let calls = 0;
    async function fetchDragon() {
        calls += 1;
        return new Response('One dragon, two readers.');
    }
    const first = createDbopfsResourceStore({
        dbopfs: {...fixture.dbopfs, lockManager}, tableName: 'models', fetchImpl: fetchDragon
    });
    const second = createDbopfsResourceStore({
        dbopfs: {...fixture.dbopfs, lockManager}, tableName: 'models', fetchImpl: fetchDragon
    });
    const results = await Promise.all([
        first.fetchResource('https://models.example.test/dragon/config.json'),
        second.fetchResource('https://models.example.test/dragon/config.json')
    ]);
    assert.equal(calls, 1);
    assert.equal(await results[0].file.text(), 'One dragon, two readers.');
    assert.equal(await results[1].file.text(), 'One dragon, two readers.');
    assert.ok(lockNames.some(function ownsIndex(name) { return name.includes('resource-index'); }));
});

test('independent resources fetch concurrently and credential selection stays transient', async function resourceOwnership() {
    const fixture = memoryStorage();
    const bothStarted = deferred();
    const finish = deferred();
    const calls = [];
    const store = createDbopfsResourceStore({dbopfs: fixture.dbopfs, tableName: 'models',
        fetchImpl: async function fetchResource(request) {
            calls.push(request.url);
            if (calls.length === 2) bothStarted.resolve();
            await finish.promise;
            return new Response(request.url);
        }});
    const first = store.fetchResource('https://models.example.test/dragon/config.json', {
        headers: {Authorization: 'synthetic-fixture-only'}
    });
    const second = store.fetchResource('https://models.example.test/dragon/tokenizer.json');
    await bothStarted.promise;
    finish.resolve();
    await Promise.all([first, second]);
    const index = await fixture.files.get('arcane-model-resources.json').text();
    assert.equal(index.includes('synthetic-fixture-only'), false);
    assert.equal(index.includes('authorization'), false);
    await store.fetchResource('https://models.example.test/dragon/config.json', {
        headers: {Authorization: 'synthetic-fixture-only'}
    });
    assert.equal(calls.length, 2);
});
