import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';

import test from '../src/testing.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(
        function captureSettlement(accept, decline) {
            resolve = accept;
            reject = decline;
        }
    );
    promise.catch(function observeFixtureRejection() {});
    return {promise, resolve, reject};
}

function observeCompletion(promise) {
    const completion = {settled: false, result: undefined};
    promise.then(
        function recordCompletion(result) {
            completion.settled = true;
            completion.result = result;
        },
        function recordFailure(error) {
            completion.settled = true;
            completion.error = error;
        }
    );
    return completion;
}

function createFakeStorage(key) {
    const records = new Map();
    const files = new Map();
    const writes = [];
    const audioWrite = deferred();
    let writeGate = null;
    const db = {
        async get(table, name) {
            return structuredClone(records.get(`${table}/${name}`) ?? null);
        },
        async set(table, name, value) {
            records.set(`${table}/${name}`, structuredClone(value));
        },
        async writeFile(table, name, blob) {
            writes.push({table, name, blob});
            audioWrite.resolve();
            if(writeGate) await writeGate.promise;
            files.set(`${table}/${name}`, new Blob([blob]));
        },
        async readFile(table, name) {
            const file = files.get(`${table}/${name}`);
            if(!file) {
                const error = new Error('Synthetic audio is absent.');
                error.name = 'NotFoundError';
                throw error;
            }
            // DBOPFS may reopen raw files without the original MIME type.
            return file;
        }
    };
    return {
        storage: {db, table: 'prepared_speech_fixture', key},
        records,
        files,
        writes,
        audioWrite,
        holdWrites() {
            writeGate = deferred();
            return writeGate;
        },
        releaseWrites() {
            writeGate?.resolve();
        }
    };
}

test(
    'prepared speech separates durable generation from controlled ordered replay',
    async function testPreparedSpeech(t) {
        // The real AI/provider queue and preparation module are the subjects.
        // Storage, synthesis and the Web Audio clock below are explicit fakes;
        // this is not browser OPFS, real model or audible playback evidence.
        const globalKeys = ['window', 'document', 'localStorage', 'user', 'AudioContext'];
        const previousGlobals = new Map(
            globalKeys.map(
                function recordGlobal(key) {
                    return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
                }
            )
        );
        const windowTarget = new EventTarget();
        const documentObject = {
            documentElement: {dataset: {arcaneAppId: 'prepared-speech-fixture'}},
            querySelector() { return null; }
        };
        const storedValues = new Map();
        const localStorage = {
            getItem(key) { return storedValues.get(String(key)) ?? null; },
            setItem(key, value) { storedValues.set(String(key), String(value)); },
            removeItem(key) { storedValues.delete(String(key)); }
        };
        windowTarget.dbopfs = {ready: false, get() {}};
        windowTarget.user = {ready: false, developer: false};
        windowTarget.document = documentObject;
        windowTarget.localStorage = localStorage;
        globalThis.window = windowTarget;
        globalThis.document = documentObject;
        globalThis.localStorage = localStorage;
        globalThis.user = windowTarget.user;

        const responses = new Map();
        const pendingResponses = [];
        const requests = [];
        const contexts = [];
        const sources = [];
        const starts = [];
        const preparations = [];
        const instances = [];
        const stores = [];
        const loadGates = [];
        const pendingLoadGates = [];
        let providerState = 'unloaded';
        let loads = 0;
        let ai;
        let unregisterProvider;

        class FakeAudioContext {
            state = 'running';
            currentTime = 10;
            destination = {};

            constructor() {
                contexts.push(this);
            }

            async decodeAudioData(buffer) {
                const token = new TextDecoder().decode(buffer);
                const response = responses.get(token);
                assert.ok(response, 'Decoded synthetic audio belongs to a provider response.');
                response.decoded.resolve();
                if(response.decodeGate) await response.decodeGate.promise;
                if(response.decodeError) throw response.decodeError;
                return {token, duration: response.duration, sampleRate: 24_000, numberOfChannels: 1};
            }

            createBufferSource() {
                const source = {
                    context: this,
                    buffer: null,
                    playbackRate: {value: 1},
                    onended: null,
                    stopped: false,
                    connect() {},
                    disconnect() { this.disconnected = true; },
                    start(time) {
                        this.startTime = time;
                        const response = responses.get(this.buffer.token);
                        response.source = this;
                        starts.push({token: this.buffer.token, time, context: this.context});
                        response.scheduled.resolve();
                    },
                    stop() { this.stopped = true; },
                    finish() {
                        this.context.currentTime = this.startTime + this.buffer.duration;
                        this.onended?.();
                    }
                };
                sources.push(source);
                return source;
            }

            async suspend() { this.state = 'suspended'; }
            async resume() { this.state = 'running'; }
            async close() { this.state = 'closed'; }
        }
        globalThis.AudioContext = FakeAudioContext;

        t.after(
            async function restorePreparedSpeechFixture() {
                try {
                    for(const preparation of preparations) preparation.cancel();
                    for(const store of stores) store.releaseWrites();
                    for(const gate of loadGates) gate.released.resolve();
                    for(const response of responses.values()) {
                        response.release();
                        response.decodeGate?.resolve();
                    }
                    for(const instance of instances) instance.stopAudio();
                    await Promise.allSettled(
                        preparations.map(function preparationReady(preparation) { return preparation.ready; })
                    );
                    if(ai) {
                        await ai.setSpeechMuted(true);
                        ai.providerRuntime.configure(
                            {
                                llm: {default: null, localOnly: null},
                                stt: {default: null, localOnly: null},
                                tts: {default: null, localOnly: null}
                            }
                        );
                    }
                    if(unregisterProvider) await unregisterProvider();
                    for(const context of contexts) await context.close();
                } finally {
                    globalThis[Symbol.for('arcane.ai.user-ready-registration')]?.dispose();
                    for(const [key, descriptor] of previousGlobals) {
                        if(descriptor) Object.defineProperty(globalThis, key, descriptor);
                        else delete globalThis[key];
                    }
                }
            }
        );

        const {default: AI} = await import('../runtime/arcane/modules/AI.js');
        const {AI_MODEL_AUTHORITY_PROTOCOL, AI_PROVIDER_PROTOCOL} = await import('../runtime/arcane/modules/AIProviderRuntime.js');
        class PreparedSpeechFixtureAI extends AI {
            setAI() { return true; }
        }
        ai = new PreparedSpeechFixtureAI();
        instances.push(ai);
        const model = {
            id: 'prepared-speech-fixture-model',
            defaultVoice: 'fixture-default-voice',
            speech: {
                outputSampleRate: 24_000,
                responseFormats: ['wav'],
                defaultResponseFormat: 'wav'
            }
        };
        const provider = {
            protocol: AI_PROVIDER_PROTOCOL,
            id: 'prepared-speech-fixture-provider',
            role: 'tts',
            localOnly: true,
            maxConcurrentRequests: 4,
            catalog() { return [model]; },
            inspect(selection) {
                return {
                    available: true,
                    authority: {
                        protocol: AI_MODEL_AUTHORITY_PROTOCOL,
                        providerId: this.id,
                        modelId: selection.modelId
                    }
                };
            },
            status() {
                return {state: providerState, loaded: providerState === 'ready', busy: false};
            },
            async load(context) {
                loads += 1;
                const gate = pendingLoadGates.shift();
                if(gate) {
                    const cancelled = deferred();
                    providerState = 'loading';
                    gate.context = context;
                    function cancelFixtureLoad() {
                        gate.aborted.resolve();
                        cancelled.reject(context.signal.reason);
                    }
                    context.signal.addEventListener('abort', cancelFixtureLoad, {once: true});
                    if(context.signal.aborted) cancelFixtureLoad();
                    gate.started.resolve();
                    try {
                        await Promise.race([gate.released.promise, cancelled.promise]);
                    } catch(error) {
                        providerState = 'unloaded';
                        throw error;
                    } finally {
                        context.signal.removeEventListener('abort', cancelFixtureLoad);
                    }
                }
                providerState = 'ready';
            },
            async request(context) {
                const response = pendingResponses.shift();
                assert.ok(response, 'Each provider request has an explicit synthetic result.');
                requests.push(context);
                response.request = context;
                response.requested.resolve();
                return response.generated.promise;
            },
            async unload() { providerState = 'unloaded'; },
            async dispose() { providerState = 'disposed'; }
        };
        unregisterProvider = ai.providerRuntime.register(provider);
        const selection = {providerId: provider.id, modelId: model.id, localOnly: true};
        ai.providerRuntime.configure(
            {
                llm: {default: null, localOnly: null},
                stt: {default: null, localOnly: null},
                tts: {default: selection, localOnly: selection}
            }
        );
        ai.ttsService = provider.id;
        ai.modelTTS = model.id;

        function responseFor(token, duration = 1) {
            const response = {
                token,
                duration,
                requested: deferred(),
                generated: deferred(),
                decoded: deferred(),
                scheduled: deferred(),
                release() {
                    this.generated.resolve(
                        {audio: new TextEncoder().encode(this.token), contentType: 'audio/wav'}
                    );
                }
            };
            responses.set(token, response);
            pendingResponses.push(response);
            return response;
        }

        function prepare(options) {
            const handle = ai.prepareTTS(options);
            preparations.push(handle);
            return handle;
        }

        function storeFor(key) {
            const store = createFakeStorage(key);
            stores.push(store);
            return store;
        }

        function holdNextLoad() {
            const gate = {started: deferred(), released: deferred(), aborted: deferred(), context: null};
            loadGates.push(gate);
            pendingLoadGates.push(gate);
            return gate;
        }

        await t.test(
            'preparation captures punctuation and complete text, uses four slots, and waits for durable audio',
            async function testDurablePreparation() {
                ai.configureTTSSegmentation({punctuation: 'any', wordCadence: null});
                const store = storeFor('durable-page');
                const writeGate = store.holdWrites();
                const expected = ['  First; ', 'Café? ', '東京。 ', 'مرحبا! ', '*##*'];
                const generated = expected.map(
                    function makeDurableResponse(unused, index) { return responseFor(`durable-${index}`); }
                );
                const states = [];
                const options = {
                    parts: [{input: '  **First**; Café? 東京。 مرحبا! *##*', voice: 'af_heart', speed: 0.875, pauseAfterMs: 125}],
                    storage: store.storage,
                    identity: {page: 'durable', runtime: {dtype: 'fp32'}},
                    onState(state) { states.push({state: state.state, completed: state.completed, total: state.total}); }
                };
                const originalParts = structuredClone(options.parts);
                const handle = prepare(options);
                assert.equal(handle.state, 'queued');
                assert.deepEqual(options.parts, originalParts);
                assert.equal(states[0].state, 'queued');
                ai.configureTTSSegmentation({punctuation: 'none', wordCadence: null});
                await Promise.all(
                    generated.slice(0, 4).map(function requested(response) { return response.requested.promise; })
                );
                assert.equal(generated[4].request, undefined);
                assert.equal(contexts.length, 0);
                assert.equal(starts.length, 0);
                generated[2].release();
                await generated[4].requested.promise;
                for(const response of generated) response.release();
                await store.audioWrite.promise;
                const completion = observeCompletion(handle.ready);
                await setImmediate();
                assert.equal(completion.settled, false);
                writeGate.resolve();
                await handle.ready;
                assert.equal(handle.state, 'ready');
                assert.equal(store.writes.length, 5);
                assert.equal(states.at(-1).completed, 5);
                assert.equal(states.at(-1).total, 5);
                assert.deepEqual(
                    generated.map(function generatedText(response) { return response.request.payload.input; }),
                    ['  First; ', 'Café? ', '東京。 ', 'مرحبا! ', '**']
                );
                for(const response of generated) {
                    assert.equal(response.request.payload.voice, 'af_heart');
                    assert.equal(response.request.payload.speed, 0.875);
                    assert.equal(response.request.payload.responseFormat, 'wav');
                    assert.equal(Object.hasOwn(response.request.payload, 'language'), false);
                }
                assert.deepEqual(
                    handle.segments.map(function readPause(segment) { return segment.pauseAfterMs; }),
                    [0, 0, 0, 0, 125]
                );
                assert.equal(contexts.length, 0);
                for(const [index, response] of generated.entries()) {
                    const audio = await handle.getAudio(index);
                    assert.equal(audio.type, 'audio/wav');
                    assert.equal(await audio.text(), response.token);
                }
            }
        );

        await t.test(
            'shared in-flight preparation survives one cancelled interest',
            async function testSharedPreparation() {
                ai.configureTTSSegmentation({punctuation: 'none', wordCadence: null});
                const store = storeFor('shared-page');
                const response = responseFor('shared-result');
                const options = {parts: ['Shared narration.'], storage: store.storage, identity: {page: 'shared'}};
                const first = prepare(options);
                const second = prepare(options);
                await response.requested.promise;
                const before = requests.length;
                assert.equal(first.cancel(), true);
                await assert.rejects(first.ready, {name: 'AbortError'});
                assert.equal(response.request.signal.aborted, false);
                response.release();
                await second.ready;
                assert.equal(requests.length, before);
                assert.equal(second.state, 'ready');
                assert.equal(await (await second.getAudio(0)).text(), response.token);
                await assert.rejects(first.getAudio(0), {name: 'AbortError'});
            }
        );

        await t.test(
            'a stored cache hit replays while the provider is unloaded',
            async function testCachedReplay() {
                const store = storeFor('replay-page');
                const first = responseFor('replay-first', 1.25);
                const second = responseFor('replay-second', 0.75);
                const options = {
                    parts: [{input: 'First.', pauseAfterMs: 125}, 'Second.'],
                    storage: store.storage,
                    identity: {page: 'replay'}
                };
                const prepared = prepare(options);
                await Promise.all([first.requested.promise, second.requested.promise]);
                second.release();
                first.release();
                await prepared.ready;
                await ai.setSpeechMuted(true);
                assert.equal(providerState, 'unloaded');
                const initialLoads = loads;
                const initialRequests = requests.length;
                const replayAI = new PreparedSpeechFixtureAI();
                instances.push(replayAI);
                replayAI.ttsService = provider.id;
                replayAI.modelTTS = model.id;
                replayAI.configureTTSSegmentation({punctuation: 'none', wordCadence: null});
                const cached = replayAI.prepareTTS(options);
                preparations.push(cached);
                await cached.ready;
                assert.equal(providerState, 'unloaded');
                assert.equal(loads, initialLoads);
                assert.equal(requests.length, initialRequests);
                const states = [];
                const playback = replayAI.playPreparedTTS(
                    cached,
                    {
                        onState(state) { states.push(state); }
                    }
                );
                assert.equal(playback.state, 'waiting');
                assert.equal(playback.error, null);
                const finished = observeCompletion(playback.finished);
                await Promise.all([first.scheduled.promise, second.scheduled.promise]);
                assert.equal(first.source.context, second.source.context);
                assert.equal(second.source.startTime, first.source.startTime + first.duration + 0.125);
                assert.equal(finished.settled, false);
                assert.equal(await playback.pause(), true);
                assert.equal(first.source.context.state, 'suspended');
                assert.equal(playback.state, 'paused');
                assert.equal(await playback.resume(), true);
                assert.equal(first.source.context.state, 'running');
                assert.equal(playback.state, 'scheduled');
                first.source.finish();
                await setImmediate();
                assert.equal(finished.settled, false);
                second.source.finish();
                assert.equal(await playback.finished, true);
                assert.equal(playback.state, 'complete');
                assert.equal(states[0].state, 'waiting');
                assert.equal(states.at(-1).state, 'complete');
                assert.equal(states.some(function hasPlaybackError(state) { return state.error !== null; }), false);
                assert.equal(first.source.context.state, 'closed');
                assert.equal(loads, initialLoads);
                assert.equal(requests.length, initialRequests);
            }
        );

        await t.test(
            'stopping selected playback preserves unfinished background preparation',
            async function testIndependentPlaybackStop() {
                const store = storeFor('stopped-page');
                const first = responseFor('stopped-ready');
                const second = responseFor('stopped-pending');
                const prepared = prepare({parts: ['First.', 'Second.'], storage: store.storage});
                const playback = ai.playPreparedTTS(prepared);
                assert.equal(playback.state, 'waiting');
                assert.equal(await playback.resume(), true);
                assert.equal(playback.state, 'waiting');
                await Promise.all([first.requested.promise, second.requested.promise]);
                first.release();
                await first.scheduled.promise;
                const scheduled = starts.length;
                assert.equal(playback.stop(), true);
                assert.equal(await playback.finished, false);
                assert.equal(playback.state, 'stopped');
                assert.equal(playback.error, null);
                assert.equal(first.source.stopped, true);
                assert.equal(second.request.signal.aborted, false);
                second.release();
                await prepared.ready;
                await setImmediate();
                assert.equal(starts.length, scheduled);
                assert.equal(store.writes.length, 2);
                assert.equal(await (await prepared.getAudio(1)).text(), second.token);
            }
        );

        await t.test(
            'stopping during decode never recreates or schedules cancelled playback',
            async function testStopDuringDecode() {
                const response = responseFor('cancelled-decode');
                response.decodeGate = deferred();
                const prepared = prepare({parts: ['Decode pending.']});
                await response.requested.promise;
                response.release();
                await prepared.ready;
                const beforeSources = sources.length;
                const beforeStarts = starts.length;
                const playback = ai.playPreparedTTS(prepared);
                await response.decoded.promise;
                assert.equal(playback.stop(), true);
                assert.equal(await playback.finished, false);
                response.decodeGate.resolve();
                await setImmediate();
                assert.equal(sources.length, beforeSources);
                assert.equal(starts.length, beforeStarts);
                assert.equal(await (await prepared.getAudio(0)).text(), response.token);
            }
        );

        await t.test(
            'decode failure settles its playback state without discarding prepared audio',
            async function testScopedPlaybackFailure() {
                const response = responseFor('failed-playback-decode');
                response.decodeError = new Error('Synthetic audio decoder failure.');
                const prepared = prepare({parts: ['Saved audio remains.']});
                await response.requested.promise;
                response.release();
                await prepared.ready;
                const states = [];
                const playback = ai.playPreparedTTS(
                    prepared,
                    {
                        onState(state) { states.push(state); }
                    }
                );
                assert.equal(await playback.finished, false);
                assert.equal(playback.state, 'error');
                assert.equal(playback.error, response.decodeError);
                assert.equal(states.at(-1).state, 'error');
                assert.equal(states.at(-1).error, response.decodeError);
                assert.equal(prepared.state, 'ready');
                assert.equal(await (await prepared.getAudio(0)).text(), response.token);
                assert.equal(response.source, undefined);
            }
        );

        await t.test(
            'retry retains successful segments and synthesizes only the failed segment',
            async function testPartialRetry() {
                const store = storeFor('partial-page');
                const first = responseFor('partial-success');
                const second = responseFor('partial-failure');
                const options = {parts: ['Keep me.', 'Retry me.'], storage: store.storage};
                const initial = prepare(options);
                await Promise.all([first.requested.promise, second.requested.promise]);
                first.release();
                await initial.getAudio(0);
                second.generated.reject(new Error('Synthetic provider failure.'));
                await assert.rejects(initial.ready, /Synthetic provider failure/);
                assert.equal(store.writes.length, 1);
                const retryResponse = responseFor('partial-retry-success');
                const retry = prepare(options);
                await retryResponse.requested.promise;
                assert.equal(retryResponse.request.payload.input, 'Retry me.');
                retryResponse.release();
                await retry.ready;
                assert.equal(store.writes.length, 2);
                assert.equal(await (await retry.getAudio(0)).text(), first.token);
                assert.equal(await (await retry.getAudio(1)).text(), retryResponse.token);
            }
        );

        await t.test(
            'complete source, voice, speed and semantic identity distinguish cached preparation',
            async function testSemanticCacheIdentity() {
                const store = storeFor('semantic-page');
                const cases = [
                    {input: '**Same** words.', voice: 'af_heart', speed: 1, identity: {page: 'semantic', runtime: {dtype: 'fp32'}}},
                    {input: 'Same words.', voice: 'af_heart', speed: 1, identity: {page: 'semantic', runtime: {dtype: 'fp32'}}},
                    {input: 'Same words.', voice: 'bf_emma', speed: 1, identity: {page: 'semantic', runtime: {dtype: 'fp32'}}},
                    {input: 'Same words.', voice: 'bf_emma', speed: 0.875, identity: {page: 'semantic', runtime: {dtype: 'fp32'}}},
                    {input: 'Same words.', voice: 'bf_emma', speed: 0.875, identity: {page: 'semantic', runtime: {dtype: 'q8'}}}
                ];
                const before = requests.length;
                for(const [index, entry] of cases.entries()) {
                    const response = responseFor(`semantic-${index}`);
                    const {identity, ...part} = entry;
                    const prepared = prepare({parts: [part], storage: store.storage, identity});
                    await response.requested.promise;
                    response.release();
                    await prepared.ready;
                    assert.equal(await (await prepared.getAudio(0)).text(), response.token);
                }
                assert.equal(requests.length, before + cases.length);
                const {identity, ...part} = cases[0];
                const repeated = prepare({parts: [part], storage: store.storage, identity});
                await repeated.ready;
                assert.equal(await (await repeated.getAudio(0)).text(), 'semantic-0');
                assert.equal(requests.length, before + cases.length);
            }
        );

        await t.test(
            'public plain input preserves complete previews through preparation, fetch and queued runtime requests',
            async function testPlainSpeechInput() {
                const segmentation = ai.ttsSegmentation;
                ai.configureTTSSegmentation({punctuation: 'none', wordCadence: null});
                const input = '  **Moon raccoons launch.**\nThe *##* comet follows.  ';
                const cleaned = '  Moon raccoons launch.\nThe ** comet follows.  ';
                const store = storeFor('plain-preview');
                const parts = [{input, voice: 'af_heart', speed: 0.875}];
                const originalParts = structuredClone(parts);
                try {
                    for(const mode of [
                        {punctuation: 'sentence', wordCadence: null},
                        {punctuation: 'any', wordCadence: null},
                        {punctuation: 'none', wordCadence: 2}
                    ]) {
                        ai.configureTTSSegmentation(mode);
                        const segmented = prepare({parts, textFormat: 'plain'});
                        const segmentedResponses = segmented.segments.map(function responseForPlainSegment(unused, index) {
                            return responseFor(`plain-${mode.punctuation}-${index}`);
                        });
                        assert.equal(segmented.segments.map(function segmentInput(segment) {
                            return segment.input;
                        }).join(''), input);
                        for(const response of segmentedResponses) response.release();
                        await segmented.ready;
                        assert.equal(segmentedResponses.map(function dispatchedSegment(response) {
                            return response.request.payload.input;
                        }).join(''), input);
                    }
                    ai.configureTTSSegmentation({punctuation: 'none', wordCadence: null});
                    const exactResponse = responseFor('plain-preparation');
                    const exact = prepare({parts, textFormat: 'plain', storage: store.storage});
                    await exactResponse.requested.promise;
                    assert.equal(exactResponse.request.payload.input, input);
                    assert.equal(Object.hasOwn(exactResponse.request.payload, 'textFormat'), false);
                    assert.deepEqual(parts, originalParts);
                    exactResponse.release();
                    const exactRecord = await exact.ready;
                    assert.deepEqual(exactRecord.originalParts, originalParts);

                    // The different synthesis text cannot reuse the plain preparation's audio.
                    const defaultResponse = responseFor('default-preparation');
                    const narration = prepare({parts, storage: store.storage});
                    await defaultResponse.requested.promise;
                    assert.equal(defaultResponse.request.payload.input, cleaned);
                    defaultResponse.release();
                    await narration.ready;

                    const payload = {input, textFormat: 'plain', voice: 'af_heart', speed: 0.875};
                    const originalPayload = structuredClone(payload);
                    const fetchResponse = responseFor('plain-fetch');
                    const fetched = ai.fetchTTS(payload);
                    await fetchResponse.requested.promise;
                    assert.equal(fetchResponse.request.payload.input, input);
                    assert.equal(Object.hasOwn(fetchResponse.request.payload, 'textFormat'), false);
                    assert.deepEqual(payload, originalPayload);
                    fetchResponse.release();
                    assert.equal(await (await fetched).text(), fetchResponse.token);

                    const queuedResponses = Array.from({length: 5}, function createPlainResponse(unused, index) {
                        return responseFor(`plain-runtime-${index}`);
                    });
                    const beforeQueued = requests.length;
                    const runtimePayloads = [];
                    const queuedRequests = queuedResponses.map(function requestPlainSpeech(response, index) {
                        const request = {
                            model: model.id,
                            ...(index === 4 ? {input} : {text: input}),
                            textFormat: 'plain',
                            voice: 'af_heart'
                        };
                        runtimePayloads.push(request);
                        return index === 4
                            ? ai.providerRuntime.request('tts', {
                                operation: 'synthesize', payload: request, localOnly: true
                            })
                            : ai.providerRuntime.synthesize(request, {localOnly: true});
                    });
                    await Promise.all(queuedResponses.filter(function firstFour(unused, index) {
                        return index < 4;
                    }).map(function waitForPlainRequest(response) { return response.requested.promise; }));
                    assert.equal(requests.length, beforeQueued + 4);
                    for(const response of queuedResponses) {
                        if(response.request) response.release();
                    }
                    await queuedResponses[4].requested.promise;
                    queuedResponses[4].release();
                    await Promise.all(queuedRequests);
                    for(const [index, response] of queuedResponses.entries()) {
                        assert.equal(response.request.payload.input ?? response.request.payload.text, input);
                        assert.equal(Object.hasOwn(response.request.payload, 'textFormat'), false);
                        assert.equal(runtimePayloads[index].textFormat, 'plain');
                        assert.equal(runtimePayloads[index].input ?? runtimePayloads[index].text, input);
                    }

                    const cancelled = new AbortController();
                    cancelled.abort();
                    const beforeCancelled = requests.length;
                    await assert.rejects(ai.fetchTTS(payload, cancelled.signal), {name: 'AbortError'});
                    assert.equal(requests.length, beforeCancelled);
                } finally {
                    ai.configureTTSSegmentation(segmentation);
                }
            }
        );

        await t.test(
            'cancelled activation interests do not begin a cold load',
            async function testCancelledActivationBeforeLoad() {
                await ai.setSpeechMuted(true);
                const before = loads;
                const alreadyCancelled = new AbortController();
                alreadyCancelled.abort();
                await assert.rejects(
                    ai.providerRuntime.setSpeechMuted(false, {signal: alreadyCancelled.signal}),
                    {name: 'AbortError'}
                );
                assert.equal(ai.providerRuntime.speechMuted, true);
                const cancelled = new AbortController();
                const activation = ai.providerRuntime.setSpeechMuted(false, {signal: cancelled.signal});
                cancelled.abort();
                await assert.rejects(activation, {name: 'AbortError'});
                await ai.setSpeechMuted(true);
                assert.equal(loads, before);
            }
        );

        await t.test(
            'cancelling a cold preparation retires its otherwise-unneeded activation',
            async function testCancelledPreparationActivation() {
                await ai.setSpeechMuted(true);
                const gate = holdNextLoad();
                const controller = new AbortController();
                const before = requests.length;
                const prepared = prepare({parts: ['Cancelled cold preview.'], signal: controller.signal});
                await gate.started.promise;
                controller.abort();
                await assert.rejects(prepared.ready, {name: 'AbortError'});
                await gate.aborted.promise;
                assert.equal(gate.context.signal.aborted, true);
                assert.equal(requests.length, before);
                await ai.setSpeechMuted(true);
                assert.equal(providerState, 'unloaded');
            }
        );

        await t.test(
            'another preparation keeps shared cold activation alive',
            async function testSharedPreparationActivation() {
                const gate = holdNextLoad();
                const controller = new AbortController();
                const secondPreparing = deferred();
                const before = loads;
                const first = prepare({parts: ['Cancelled first preview.'], signal: controller.signal});
                const response = responseFor('surviving-preview');
                const second = prepare({
                    parts: ['Surviving second preview.'],
                    onState(state) { if(state.state === 'preparing') secondPreparing.resolve(); }
                });
                await Promise.all([gate.started.promise, secondPreparing.promise]);
                controller.abort();
                await assert.rejects(first.ready, {name: 'AbortError'});
                assert.equal(gate.context.signal.aborted, false);
                gate.released.resolve();
                await response.requested.promise;
                assert.equal(response.request.payload.input, 'Surviving second preview.');
                response.release();
                await second.ready;
                assert.equal(loads, before + 1);
                await ai.setSpeechMuted(true);
            }
        );

        await t.test(
            'explicit playback activation survives cancellation of a joining preview',
            async function testPlaybackActivationInterest() {
                const gate = holdNextLoad();
                const playbackActivation = ai.setSpeechMuted(false);
                await gate.started.promise;
                const controller = new AbortController();
                const preparing = deferred();
                const before = requests.length;
                const preview = prepare({
                    parts: ['Cancelled alongside playback.'], signal: controller.signal,
                    onState(state) { if(state.state === 'preparing') preparing.resolve(); }
                });
                await preparing.promise;
                controller.abort();
                await assert.rejects(preview.ready, {name: 'AbortError'});
                assert.equal(gate.context.signal.aborted, false);
                gate.released.resolve();
                assert.equal(await playbackActivation, true);
                assert.equal(requests.length, before);
                assert.equal(providerState, 'ready');
                await ai.setSpeechMuted(true);
            }
        );

        await t.test(
            'a direct TTS load joining preview activation owns a separate interest',
            async function testDirectLoadActivationInterest() {
                const gate = holdNextLoad();
                const controller = new AbortController();
                const preview = prepare({parts: ['Preview yields to explicit load.'], signal: controller.signal});
                await gate.started.promise;
                const explicitLoad = ai.providerRuntime.load('tts');
                controller.abort();
                await assert.rejects(preview.ready, {name: 'AbortError'});
                assert.equal(gate.context.signal.aborted, false);
                gate.released.resolve();
                assert.equal((await explicitLoad).loaded, true);
                await ai.setSpeechMuted(true);
            }
        );

        await t.test(
            'shared activation preserves complete load failures and explicit mute overrides every interest',
            async function testActivationFailureAndMute() {
                const failedLoad = holdNextLoad();
                const first = ai.providerRuntime.setSpeechMuted(false);
                const second = ai.providerRuntime.setSpeechMuted(false);
                await failedLoad.started.promise;
                const failure = new Error('Synthetic complete cold-load failure.');
                const firstFailure = assert.rejects(first, function firstLoadFailure(error) { return error === failure; });
                const secondFailure = assert.rejects(second, function secondLoadFailure(error) { return error === failure; });
                failedLoad.released.reject(failure);
                await Promise.all([firstFailure, secondFailure]);
                await ai.setSpeechMuted(true);

                const mutedLoad = holdNextLoad();
                const firstUnmute = ai.providerRuntime.setSpeechMuted(false);
                const secondUnmute = ai.providerRuntime.setSpeechMuted(false);
                await mutedLoad.started.promise;
                const firstAbort = assert.rejects(firstUnmute, {name: 'AbortError'});
                const secondAbort = assert.rejects(secondUnmute, {name: 'AbortError'});
                const muteSignal = new AbortController();
                const mute = ai.providerRuntime.setSpeechMuted(true, {signal: muteSignal.signal});
                muteSignal.abort();
                await mutedLoad.aborted.promise;
                await Promise.all([firstAbort, secondAbort, mute]);
                assert.equal(providerState, 'unloaded');
                assert.equal(ai.providerRuntime.speechMuted, true);
            }
        );
    }
);
