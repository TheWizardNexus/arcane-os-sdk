import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    createBrowserSpeechAuthority,
    createDbopfsSpeechArtifactStore,
} from '../browser-runtime/ai/browser-speech-artifacts.mjs';

function memoryDbopfs() {
    const files = new Map();
    function missing() {
        return new DOMException('File does not exist.', 'NotFoundError');
    }
    const directory = {
        async getFileHandle(name, {create = false} = {}) {
            if (!create && !files.has(name)) throw missing();
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
                        async abort() {},
                    };
                },
            };
        },
        async removeEntry(name) {
            if (!files.delete(name)) throw missing();
        },
    };
    return {
        files,
        async getTableHandle() { return directory; },
        lockManager: {
            async request(name, options, callback) {
                return callback({name});
            },
        },
    };
}

function authority() {
    return createBrowserSpeechAuthority({
        providerId: 'complete-speech',
        role: 'tts',
        model: {
            id: 'caller-model',
            repository: 'caller/model',
            revision: 'selected-revision',
            dtype: 'fp32',
            defaultVoice: 'caller-voice',
            files: [{
                path: 'model.onnx',
                url: 'https://example.invalid/model.onnx',
                mediaType: 'application/octet-stream',
            }],
        },
        runtime: {
            adapter: 'kokoro-js',
            version: '1.2.1',
            revision: 'selected-runtime',
            entry: 'runtime.mjs',
            files: [{
                path: 'runtime.mjs',
                url: 'https://example.invalid/runtime.mjs',
                mediaType: 'text/javascript',
            }],
        },
    });
}

test('speech full responses use complete ordered parts and reuse finished peers after cancellation',
    async function preserveSpeechParts() {
        const dbopfs = memoryDbopfs();
        const controller = new AbortController();
        const interruption = new DOMException('Caller cancelled.', 'AbortError');
        const runtime = 'export const runtime = "complete runtime";';
        const model = 'complete speech model\n'.repeat(500000);
        const requests = [];
        const materialized = [];
        const store = createDbopfsSpeechArtifactStore({
            dbopfs,
            async fetchImpl(input) {
                const url = String(input);
                requests.push(url);
                return new Response(url.endsWith('runtime.mjs') ? runtime : model);
            },
            objectUrlFactory: {
                create(file) {
                    materialized.push(file);
                    return `blob:speech-fixture-${materialized.length}`;
                },
                revoke() {},
            },
        });
        const selected = authority();
        await assert.rejects(store.prepare(selected, {
            signal: controller.signal,
            onProgress(progress) {
                if (progress.resource?.file === 'model.onnx'
                    && progress.resource.completed === 1
                    && progress.resource.total === null) controller.abort(interruption);
            },
        }), function isCallerCancellation(error) {
            return error === interruption;
        });
        assert.equal(materialized.length, 0);
        const partialIndexes = [...dbopfs.files.entries()].filter(function isPartIndex(entry) {
            return entry[0].endsWith('.arcane-parts.json');
        });
        assert.equal(partialIndexes.length, 2);
        const states = await Promise.all(partialIndexes.map(async function readPartIndex(entry) {
            return JSON.parse(await entry[1].text());
        }));
        assert.equal(states.filter(function isComplete(state) { return state.complete; }).length, 1);
        assert.equal(states.find(function isInterrupted(state) { return !state.complete; }).parts.length, 1);

        const prepared = await store.prepare(selected);
        assert.equal(requests.filter(function isRuntime(url) { return url.endsWith('runtime.mjs'); }).length, 1);
        assert.equal(requests.filter(function isModel(url) { return url.endsWith('model.onnx'); }).length, 2);
        assert.equal(await materialized[0].text(), runtime);
        assert.equal(await materialized[1].text(), model);
        prepared.release();
        const cached = await store.prepare(selected, {offline: true});
        assert.equal(cached.cache, 'cached');
        assert.equal(requests.length, 3);
        cached.release();
        await store.remove(selected);
        assert.equal(dbopfs.files.size, 0);
    });
