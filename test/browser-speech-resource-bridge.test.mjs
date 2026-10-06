import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import { createModelResourceHost } from '../browser-runtime/ai/model-resource-bridge.mjs';
import { createSpeechWorkerClient } from '../browser-runtime/ai/speech-worker-client.mjs';
import { createSpeechWorkerRuntime, SPEECH_WORKER_PROTOCOL } from '../browser-runtime/ai/speech-worker-runtime.mjs';
import { createSpeechWorkerContract } from './browser-speech-workers.contract.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function createDeferred(resolvePromise, rejectPromise) {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function configuration(source, files = []) {
    return {
        role: 'stt',
        runtime: {
            adapter: 'transformers-whisper',
            moduleGraph: 'self-contained',
            entry: 'runtime.mjs',
            files: [{
                path: 'runtime.mjs',
                sourceUrl: 'https://speech.example/runtime.mjs',
                moduleUrl: `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`,
                mediaType: 'text/javascript',
            }],
        },
        model: {
            id: 'resource-whisper',
            repository: 'example/resource-whisper',
            revision: 'selected',
            dtype: 'q8',
            files,
        },
    };
}

const runtimeSource = `
    export const env = {
        allowLocalModels: true,
        allowRemoteModels: false,
        useBrowserCache: true,
        useCustomCache: true,
        useFSCache: true,
        backends: { onnx: { wasm: {} } },
    };
    export async function pipeline() {
        async function transcribe() { return { text: 'complete resource result' }; }
        transcribe.dispose = async function disposeTranscriber() {};
        return transcribe;
    }
`;

function request(runtime, id, op, payload) {
    return runtime.handleMessage({ protocol: SPEECH_WORKER_PROTOCOL, id, op, payload });
}

function connectRuntime(scope, fetchResource) {
    let runtime;
    const host = createModelResourceHost({
        fetchResource,
        send: function sendResourceResult(message) {
            void runtime.handleMessage(message);
        },
    });
    runtime = createSpeechWorkerRuntime({
        role: 'stt',
        scope,
        send: function sendSpeechResource(message) { host.receive(message); },
    });
    return { runtime, host };
}

test('ordinary speech Worker fetch uses the parent store and restores real CacheStorage descriptors', async function ordinaryResources() {
    const nativeFetch = globalThis.fetch;
    const calls = [];
    const cacheStorage = { open() { throw new Error('Native cache must remain unused.'); } };
    const prototype = {};
    const descriptor = { configurable: true, enumerable: true, get() { return cacheStorage; } };
    Object.defineProperty(prototype, 'caches', descriptor);
    const originalDescriptor = Object.getOwnPropertyDescriptor(prototype, 'caches');
    const scope = Object.assign(Object.create(prototype), {
        fetch: nativeFetch,
        location: { href: 'https://speech.example/worker.mjs' },
        Request,
    });
    const connection = connectRuntime(scope, async function storedResource(url, options) {
        calls.push({ url, options });
        return {
            file: new Blob(['complete model, configuration and voice content']),
            status: 203,
            statusText: 'Non-Authoritative Information',
            headers: [['content-type', 'application/octet-stream'], ['x-source', 'dbopfs']],
            url: 'https://speech.example/resolved/config.json',
            redirected: true,
        };
    });
    try {
        await request(connection.runtime, 1, 'load', { configuration: configuration(runtimeSource) });
        assert.notEqual(scope.caches, cacheStorage);
        const response = await scope.fetch(new Request('https://speech.example/model/config.json', {
            headers: { 'x-request': 'complete request' },
        }));
        assert.equal(await response.text(), 'complete model, configuration and voice content');
        assert.equal(response.status, 203);
        assert.equal(response.statusText, 'Non-Authoritative Information');
        assert.equal(response.headers.get('x-source'), 'dbopfs');
        assert.equal(response.url, 'https://speech.example/resolved/config.json');
        assert.equal(response.redirected, true);
        assert.equal(calls[0].url, 'https://speech.example/model/config.json');
        assert.equal(new Headers(calls[0].options.headers).get('x-request'), 'complete request');
        const cache = await scope.caches.open('kokoro-voices');
        assert.equal(await cache.match('https://speech.example/voices/voice.bin'), undefined);
        assert.equal(calls.length, 1);
        const voice = new Response('complete voice content', { headers: { 'x-voice': 'selected' } });
        await cache.put('https://speech.example/voices/voice.bin', voice);
        assert.equal(await voice.text(), 'complete voice content');
        const cachedVoice = await cache.match('https://speech.example/voices/voice.bin');
        assert.equal(await cachedVoice.text(), 'complete voice content');
        assert.equal(cachedVoice.headers.get('x-voice'), 'selected');
        assert.equal(await (await cache.match('https://speech.example/voices/voice.bin')).text(), 'complete voice content');
        assert.equal(await scope.__arcaneBrowserSpeechModuleRouterV1.openCache('runtime.mjs', 'kokoro-voices'), cache);
        assert.equal(calls.length, 1);
    } finally {
        await request(connection.runtime, 2, 'unload');
        await connection.host.close();
    }
    assert.equal(scope.fetch, nativeFetch);
    assert.deepEqual(Object.getOwnPropertyDescriptor(prototype, 'caches'), originalDescriptor);
    assert.equal(scope.caches, cacheStorage);
});

test('response caches appear after import and discard an unfinished put on unload', async function responseCacheLifetime(t) {
    const scope = { fetch: globalThis.fetch, Request };
    globalThis.__arcaneSpeechCacheFixtureScope = scope;
    t.after(function removeCacheFixtureScope() { delete globalThis.__arcaneSpeechCacheFixtureScope; });
    const source = `${runtimeSource}
        globalThis.__arcaneSpeechCacheFixtureScope.cachePresentDuringImport = 'caches' in globalThis.__arcaneSpeechCacheFixtureScope;
    `;
    const connection = connectRuntime(scope, async function unusedResource() {
        throw new Error('Response cache operations do not fetch.');
    });
    await request(connection.runtime, 1, 'load', { configuration: configuration(source) });
    assert.equal(scope.cachePresentDuringImport, false);
    const cache = await scope.caches.open('kokoro-voices');
    let controller;
    const response = new Response(new ReadableStream({
        start(streamController) { controller = streamController; },
    }));
    const writing = cache.put('https://speech.example/voices/late.bin', response);
    const rejected = assert.rejects(writing, /response cache was unloaded/u);
    await request(connection.runtime, 2, 'unload');
    controller.enqueue(new TextEncoder().encode('complete late voice'));
    controller.close();
    await rejected;
    await assert.rejects(cache.match('https://speech.example/voices/late.bin'), /response cache was unloaded/u);
    assert.equal('caches' in scope, false);
    await connection.host.close();
});

test('declared speech files retain local routing while unmapped resources reach DBOPFS', async function declaredResources() {
    const calls = [];
    const scope = { fetch: globalThis.fetch, Request, location: { href: 'https://speech.example/worker.mjs' } };
    const connection = connectRuntime(scope, async function unmappedResource(url) {
        calls.push(url);
        return { file: new Blob(['complete remote voice']), status: 200, statusText: 'OK', headers: [], url, redirected: false };
    });
    const file = {
        path: 'model/config.json',
        sourceUrl: 'https://speech.example/model/config.json',
        moduleUrl: 'data:application/json,%7B%22complete%22%3Atrue%7D',
        mediaType: 'application/json',
        runtimeRequestUrls: ['https://speech.example/model/alias.json'],
    };
    try {
        await request(connection.runtime, 1, 'load', { configuration: configuration(runtimeSource, [file]) });
        assert.equal(await (await scope.fetch(file.runtimeRequestUrls[0])).text(), '{"complete":true}');
        assert.deepEqual(calls, []);
        assert.equal(await (await scope.fetch('https://speech.example/voices/voice.bin')).text(), 'complete remote voice');
        assert.deepEqual(calls, ['https://speech.example/voices/voice.bin']);
    } finally {
        await request(connection.runtime, 2, 'unload');
        await connection.host.close();
    }
});

test('speech runtime import failure restores the dedicated Worker environment', async function failedImportRestores() {
    const originalFetch = globalThis.fetch;
    const scope = { fetch: originalFetch, caches: { name: 'existing cache' }, Request };
    const descriptor = Object.getOwnPropertyDescriptor(scope, 'caches');
    const connection = connectRuntime(scope, async function unusedResource() {
        throw new Error('Import failure does not fetch resources.');
    });
    await assert.rejects(request(connection.runtime, 1, 'load', {
        configuration: configuration('throw new Error("complete runtime import failure");'),
    }));
    assert.equal(scope.fetch, originalFetch);
    assert.deepEqual(Object.getOwnPropertyDescriptor(scope, 'caches'), descriptor);
    await connection.host.close();
});

test('nested module speech Workers forward resources to the same store owner', async function nestedResources() {
    const nested = createSpeechWorkerContract({ role: 'stt' });
    const calls = [];
    let workerUrl;
    const scope = {
        fetch: globalThis.fetch,
        Request,
        location: { href: 'https://speech.example/worker.mjs' },
        Worker: function NestedContractWorker(url) {
            workerUrl = String(url);
            return nested.worker;
        },
    };
    const connection = connectRuntime(scope, async function sharedResource(url) {
        calls.push(url);
        return { file: new Blob(['complete nested resource']), status: 200, statusText: 'OK', headers: [], url, redirected: false };
    });
    try {
        await request(connection.runtime, 1, 'load', { configuration: configuration(runtimeSource) });
        new scope.Worker('https://speech.example/runtime/thread.mjs', { type: 'module' });
        assert.equal(new URL(workerUrl).searchParams.get('arcaneSpeechWorkerMode'), 'artifact-module-worker');
        assert.equal(nested.posted[0].targetUrl, 'https://speech.example/runtime/thread.mjs');
        const resource = await nested.fetchResource('https://speech.example/runtime/thread.wasm');
        assert.equal(await resource.file.text(), 'complete nested resource');
        assert.deepEqual(calls, ['https://speech.example/runtime/thread.wasm']);
    } finally {
        await request(connection.runtime, 2, 'unload');
        await connection.host.close();
    }
    assert.equal(nested.terminated, true);
});

test('speech operation cancellation reaches resource requests without an upstream signal option', async function operationCancelsResources(t) {
    const started = deferred();
    const aborted = deferred();
    const cleanup = deferred();
    const scope = { fetch: globalThis.fetch, Request };
    globalThis.__arcaneSpeechResourceFixtureScope = scope;
    t.after(function removeFixtureScope() { delete globalThis.__arcaneSpeechResourceFixtureScope; });
    const source = `
        export const env = { allowLocalModels: true, allowRemoteModels: false, backends: { onnx: { wasm: {} } } };
        export async function pipeline() {
            async function transcribe() {
                const response = await globalThis.__arcaneSpeechResourceFixtureScope.fetch('https://speech.example/model/resource');
                return { text: await response.text() };
            }
            transcribe.dispose = async function disposeTranscriber() {};
            return transcribe;
        }
    `;
    const connection = connectRuntime(scope, async function heldResource(_url, { signal }) {
        signal.addEventListener('abort', function resourceCancelled() { aborted.resolve(); }, { once: true });
        started.resolve();
        await aborted.promise;
        await cleanup.promise;
        throw signal.reason;
    });
    t.after(async function settleHeldResource() {
        cleanup.resolve();
        await connection.host.close();
        await request(connection.runtime, 5, 'unload');
    });
    await request(connection.runtime, 1, 'load', { configuration: configuration(source) });
    const use = request(connection.runtime, 2, 'use', { audio: new Float32Array([0]), sampleRate: 16_000 });
    const rejected = assert.rejects(use);
    await started.promise;
    await request(connection.runtime, 3, 'cancel', { targetId: 2 });
    await aborted.promise;
    cleanup.resolve();
    await rejected;
    await request(connection.runtime, 4, 'unload');
    await connection.host.close();
});

test('speech client termination joins aborted resource writes for every caller', async function joinsResourceCleanup(t) {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const contract = createSpeechWorkerContract({ role: 'tts' });
    Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: function ResourceContractWorker() { return contract.worker; },
    });
    t.after(function restoreWorker() {
        if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
        else delete globalThis.Worker;
    });
    const started = deferred();
    const aborted = deferred();
    const cleanup = deferred();
    let terminationNotifications = 0;
    let reentrantTermination;
    const client = createSpeechWorkerClient({
        role: 'tts',
        fetchResource: async function pendingResource(_url, { signal }) {
            signal.addEventListener('abort', function resourceAborted() { aborted.resolve(signal.reason); }, { once: true });
            started.resolve();
            await aborted.promise;
            await cleanup.promise;
            throw signal.reason;
        },
        onTermination() {
            terminationNotifications += 1;
            reentrantTermination = client.terminate();
        },
    });
    t.after(async function settleTermination() {
        cleanup.resolve();
        await client.terminate();
    });
    await client.request('status');
    const fetching = contract.fetchResource('https://speech.example/model.onnx');
    const fetchRejected = assert.rejects(fetching);
    await started.promise;
    let firstDone = false;
    let secondDone = false;
    const first = client.terminate().then(function firstTermination() { firstDone = true; });
    const second = client.terminate().then(function secondTermination() { secondDone = true; });
    await aborted.promise;
    assert.equal(firstDone, false);
    assert.equal(secondDone, false);
    assert.equal(terminationNotifications, 1);
    cleanup.resolve();
    await Promise.all([first, second, reentrantTermination, fetchRejected]);
    assert.equal(contract.terminated, true);
    assert.equal(terminationNotifications, 1);
});

test('actual speech loader fetch forwards semantic shard progress to client onProgress', async function loaderResourceProgress(t) {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const listeners = new Set();
    const scope = { fetch: globalThis.fetch, Request };
    globalThis.__arcaneSpeechProgressFixtureScope = scope;
    const runtime = createSpeechWorkerRuntime({
        role: 'stt',
        scope,
        send: function sendWorkerMessage(message) {
            queueMicrotask(function deliverWorkerMessage() {
                for (const listener of listeners) listener({ data: message });
            });
        },
    });
    const worker = {
        addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
        postMessage(message) {
            void runtime.handleMessage(message).catch(function observeContractRejection() {});
        },
        terminate() {},
    };
    Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: function RuntimeContractWorker() { return worker; },
    });
    t.after(function restoreProgressFixture() {
        if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
        else delete globalThis.Worker;
        delete globalThis.__arcaneSpeechProgressFixtureScope;
    });
    const semanticProgress = {
        phase: 'download',
        unit: 'shards',
        completed: 1,
        url: 'https://speech.example/runtime/model.onnx',
        message: 'Stored complete model shard',
    };
    const progress = [];
    const client = createSpeechWorkerClient({
        role: 'stt',
        fetchResource: async function fetchLoaderResource(url, { onProgress }) {
            onProgress(semanticProgress);
            return { file: new Blob(['complete model']), status: 200, statusText: 'OK', headers: [], url, redirected: false };
        },
    });
    const source = `
        export const env = { allowLocalModels: true, allowRemoteModels: false, backends: { onnx: { wasm: {} } } };
        export async function pipeline() {
            await globalThis.__arcaneSpeechProgressFixtureScope.fetch('https://speech.example/runtime/model.onnx');
            async function transcribe() { return { text: 'complete progress result' }; }
            transcribe.dispose = async function disposeTranscriber() {};
            return transcribe;
        }
    `;
    try {
        await client.request('load', { configuration: configuration(source) }, {
            onProgress: function observeProgress(value) { progress.push(value); },
        });
        assert.ok(progress.some(function isStoredShard(value) {
            return value.unit === 'shards' && value.completed === 1;
        }));
        assert.deepEqual(progress.find(function isResourceProgress(value) { return value.unit === 'shards'; }), semanticProgress);
    } finally {
        await client.request('unload');
        await client.terminate();
    }
});

test('undeliverable resource envelopes terminate the speech client and preserve transport failures', async function resourceTransportFailure(t) {
    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const contract = createSpeechWorkerContract({ role: 'tts', holdUse: true });
    const originalPostMessage = contract.worker.postMessage;
    const resultFailure = new Error('Complete result clone failure');
    const errorFailure = new Error('Complete error envelope clone failure');
    const terminated = deferred();
    contract.worker.postMessage = function rejectResourceDelivery(message) {
        if (message.arcaneModelResource) {
            throw message.op === 'result' ? resultFailure : errorFailure;
        }
        return originalPostMessage.call(contract.worker, message);
    };
    Object.defineProperty(globalThis, 'Worker', {
        configurable: true,
        writable: true,
        value: function FailingTransportWorker() { return contract.worker; },
    });
    t.after(function restoreTransportWorker() {
        if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor);
        else delete globalThis.Worker;
    });
    const client = createSpeechWorkerClient({
        role: 'tts',
        fetchResource: async function completedResource(url) {
            return { file: new Blob(['complete resource']), status: 200, statusText: 'OK', headers: [], url, redirected: false };
        },
        onTermination(detail) { terminated.resolve(detail); },
    });
    const use = client.request('use', { text: 'Complete synthetic speech request', voice: 'af_heart' });
    const rejectedUse = assert.rejects(use, function hasOriginalFailures(error) {
        return error.code === 'ARCANE_AI_WORKER_MESSAGE_ERROR'
            && error.cause.errors.includes(resultFailure)
            && error.cause.errors.includes(errorFailure);
    });
    const fetching = contract.fetchResource('https://speech.example/voices/voice.bin');
    const rejectedFetch = assert.rejects(fetching);
    const detail = await terminated.promise;
    assert.equal(detail.intentional, false);
    await Promise.all([rejectedUse, rejectedFetch]);
    await assert.rejects(client.terminate(), AggregateError);
    assert.equal(contract.terminated, true);
});
