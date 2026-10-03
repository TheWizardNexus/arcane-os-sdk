import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

test(
    'AI request models and TWiN temperatures stay local to each transport operation',
    async function aiRequestModelContract() {
        const previousGlobals = new Map(
            ['window', 'document', 'localStorage', 'fetch', 'Arcane'].map(
                function readRequestModelGlobalDescriptor(key) {
                    return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
                }
            )
        );
        const registrationKey = Symbol.for('arcane.ai.user-ready-registration');
        const previousRegistration = globalThis[registrationKey];
        const values = new Map();
        const localStorage = {
            getItem(key) { return values.get(String(key)) ?? null; },
            setItem(key, value) { values.set(String(key), String(value)); },
            removeItem(key) { values.delete(String(key)); }
        };
        const windowTarget = new EventTarget();
        const documentObject = {
            documentElement: {dataset: {arcaneAppId: 'request-model-contract'}},
            querySelector() { return null; }
        };
        windowTarget.dbopfs = {ready: false, get() {}};
        windowTarget.user = {ready: false};
        windowTarget.document = documentObject;
        windowTarget.localStorage = localStorage;
        globalThis.window = windowTarget;
        globalThis.document = documentObject;
        globalThis.localStorage = localStorage;

        const smallerModel = 'openai-gpt-oss-20b';
        const content = 'The moon raccoons returned every sandwich.\nIncluding the crusts.';
        const messages = [
            {role: 'system', content: 'Keep the complete lunar lunch inventory.'},
            {role: 'user', content: '  Count the raccoons\n\nand their sandwiches. 🦝  '}
        ];
        const originalMessages = structuredClone(messages);

        function completion(model) {
            return {
                ...(model === undefined ? {} : {model}),
                choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}]
            };
        }

        function jsonResponse(model) {
            return new Response(
                JSON.stringify(completion(model)),
                {status: 200, headers: {'content-type': 'application/json'}}
            );
        }

        function streamResponse(model) {
            const chunk = {
                ...(model === undefined ? {} : {model}),
                choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: 'stop'}]
            };
            return new Response(
                `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
                {status: 200, headers: {'content-type': 'text/event-stream'}}
            );
        }

        let ai;
        try {
            const {default: AI} = await import(process.env.ARCANE_SDK_REQUEST_MODEL_AI_URL ?? 'arcane-os/ai');
            ai = new AI('TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH', 'TWIN');
            ai.twinKey = 'synthetic-request-model-credential';
            await ai.providerRuntime.load('llm');
            const defaultModel = ai.model;
            const defaultSelection = structuredClone(ai.providerRuntime.selection('llm'));
            assert.equal(defaultModel, 'openai-gpt-oss-120b');

            function assertDefaultSelection(label) {
                assert.equal(ai.model, defaultModel, label);
                assert.equal(ai.llmService, 'TWIN', label);
                assert.deepEqual(ai.providerRuntime.selection('llm'), defaultSelection, label);
                assert.deepEqual(messages, originalMessages, label);
            }

            const cases = [
                {name: 'supplied', options: {model: smallerModel}, expectedModel: smallerModel},
                {name: 'omitted', options: {}, expectedModel: defaultModel},
                {name: 'undefined', options: {model: undefined}, expectedModel: defaultModel},
                {name: 'temperature zero', options: {model: smallerModel, temperature: 0, reasoningEffort: 'low'}, expectedModel: smallerModel},
                {name: 'temperature supplied', options: {model: smallerModel, temperature: 0.8}, expectedModel: smallerModel},
                {name: 'temperature undefined', options: {temperature: undefined}, expectedModel: defaultModel},
                {
                    name: 'authoritative response',
                    options: {model: smallerModel},
                    expectedModel: smallerModel,
                    responseModel: 'provider-returned-model'
                }
            ];
            for (const method of ['fetchRequest', 'streamRequest']) {
                for (const scenario of cases) {
                    const label = `${method}: ${scenario.name}`;
                    const expectedResponseModel = scenario.responseModel ?? scenario.expectedModel;
                    const requests = [];
                    const responses = [];
                    const results = [];
                    const chunks = [];
                    const events = [];
                    let callbackRequest;
                    globalThis.fetch = async function answerRequestModel(url, options) {
                        const request = JSON.parse(options.body);
                        requests.push(request);
                        assert.equal(url, ai.url, label);
                        assert.equal(options.method, 'POST', label);
                        assert.equal(request.model, scenario.expectedModel, label);
                        assert.equal(request.temperature, scenario.options.temperature, label);
                        assert.equal(request.reasoning_effort, scenario.options.reasoningEffort, label);
                        assert.equal(Object.hasOwn(request, 'temperature'), scenario.options.temperature !== undefined, label);
                        assert.deepEqual(request.messages, originalMessages, label);
                        assert.deepEqual(request, callbackRequest, label);
                        assertDefaultSelection(label);
                        return method === 'streamRequest'
                            ? streamResponse(scenario.responseModel)
                            : jsonResponse(expectedResponseModel);
                    };
                    const operation = ai[method]({
                        ...scenario.options,
                        messages,
                        id: label,
                        onRequest(request, id) {
                            assert.equal(id, label);
                            assert.equal(request.model, scenario.expectedModel, label);
                            assert.equal(request.temperature, scenario.options.temperature, label);
                            assert.equal(request.reasoning_effort, scenario.options.reasoningEffort, label);
                            assert.equal(Object.hasOwn(request, 'temperature'), scenario.options.temperature !== undefined, label);
                            assert.equal(request.messages, messages, label);
                            assertDefaultSelection(label);
                            callbackRequest = structuredClone(request);
                            events.push('request');
                        },
                        onChunk(text, id, thinking) {
                            assert.equal(id, `M-${label}`);
                            events.push(thinking ? 'thinking' : 'chunk');
                            if (!thinking) chunks.push(text);
                            assertDefaultSelection(label);
                        },
                        onDataResult(value) {
                            results.push(value);
                            events.push('data result');
                        },
                        onResponse(value, id) {
                            assert.equal(id, label);
                            responses.push(value);
                            events.push('response');
                            assertDefaultSelection(label);
                        },
                        onComplete(value, id) {
                            assert.equal(value, content, label);
                            assert.equal(id, `M-${label}`);
                            events.push('complete');
                        }
                    });
                    if (method === 'streamRequest') {
                        assert.deepEqual(events, ['thinking'], `${label}: Thinking is synchronous`);
                    }
                    const result = await operation;
                    assert.equal(requests.length, 1, label);
                    assert.equal(responses.length, 1, label);
                    assert.equal(responses[0].model, expectedResponseModel, label);
                    assert.equal(responses[0].choices[0].message.content, content, label);
                    if (method === 'streamRequest') {
                        assert.equal(result, content, label);
                        assert.deepEqual(chunks, [content], label);
                        assert.deepEqual(results, responses, label);
                        assert.deepEqual(events, ['thinking', 'request', 'chunk', 'data result', 'response', 'complete'], label);
                    } else {
                        assert.equal(result, responses[0], label);
                        assert.deepEqual(events, ['request', 'response'], label);
                    }
                    assertDefaultSelection(label);
                }
            }

            let releaseConcurrentRequests;
            const concurrentReady = new Promise(function awaitConcurrentRequests(resolve) {
                releaseConcurrentRequests = resolve;
            });
            const concurrentRequests = [];
            const concurrentResponses = [];
            globalThis.fetch = async function answerConcurrentRequestModels(url, options) {
                const request = JSON.parse(options.body);
                concurrentRequests.push(request);
                assertDefaultSelection('concurrent dispatch');
                if (concurrentRequests.length === 2) releaseConcurrentRequests();
                await concurrentReady;
                assertDefaultSelection('concurrent response');
                return request.stream ? streamResponse() : jsonResponse(request.model);
            };
            const concurrentFetch = ai.fetchRequest({messages, model: smallerModel, temperature: 0});
            const concurrentStream = ai.streamRequest({
                messages,
                model: defaultModel,
                temperature: 0.8,
                onResponse(response) { concurrentResponses.push(response); }
            });
            const concurrentResults = await Promise.all([concurrentFetch, concurrentStream]);
            assert.deepEqual(
                concurrentRequests.map(function requestModel(request) { return request.model; }).sort(),
                [smallerModel, defaultModel].sort()
            );
            for (const request of concurrentRequests) assert.deepEqual(request.messages, originalMessages);
            assert.equal(concurrentRequests.find(function isFetch(request) { return !request.stream; }).temperature, 0);
            assert.equal(concurrentRequests.find(function isStream(request) { return request.stream; }).temperature, 0.8);
            assert.equal(concurrentResults[0].model, smallerModel);
            assert.equal(concurrentResults[1], content);
            assert.equal(concurrentResponses[0].model, defaultModel);
            assertDefaultSelection('concurrent completion');

            for (const operation of ['chat', 'stream']) {
                for (const scenario of [{}, {temperature: undefined}, {temperature: 0}, {temperature: 0.8}]) {
                    let transportModel;
                    globalThis.fetch = async function answerBuiltInModelBridge(url, options) {
                        const request = JSON.parse(options.body);
                        transportModel = request.model;
                        assert.equal(request.temperature, scenario.temperature);
                        assert.equal(Object.hasOwn(request, 'temperature'), scenario.temperature !== undefined);
                        assert.deepEqual(request.messages, originalMessages);
                        assertDefaultSelection('built-in runtime bridge');
                        return request.stream ? streamResponse() : jsonResponse(request.model);
                    };
                    const response = await ai.providerRuntime.request('llm', {
                        operation,
                        payload: {messages, model: smallerModel, ...scenario},
                        localOnly: false,
                        signal: null
                    });
                    if (operation === 'stream') {
                        for await (const chunk of response) assert.ok(chunk);
                        assert.equal((await response.result).model, smallerModel);
                    } else {
                        assert.equal(response.model, smallerModel);
                    }
                    assert.equal(transportModel, smallerModel);
                    assertDefaultSelection('built-in runtime completion');
                }
            }

            for (const method of ['fetchRequest', 'streamRequest']) {
                let transportCalls = 0;
                globalThis.fetch = async function rejectUnexpectedCancelledTransport() {
                    transportCalls += 1;
                    throw new Error('A cancelled request reached its transport.');
                };
                const controller = new AbortController();
                controller.abort('The lunar lunch order was cancelled.');
                await assert.rejects(
                    ai[method]({messages, model: smallerModel, signal: controller.signal}),
                    function preserveRequestModelCancellation(error) {
                        assert.equal(error.code, 'ARCANE_AI_REQUEST_ABORTED');
                        return true;
                    }
                );
                const callbackError = new Error('The request observer failed.');
                await assert.rejects(
                    ai[method]({
                        messages,
                        model: smallerModel,
                        onRequest(request) {
                            assert.equal(request.model, smallerModel);
                            assertDefaultSelection('failed callback');
                            throw callbackError;
                        }
                    }),
                    function preserveRequestModelCallbackFailure(error) {
                        assert.equal(error, callbackError);
                        return true;
                    }
                );
                assert.equal(transportCalls, 0);
                assertDefaultSelection('cancelled and failed requests');
            }

            const retryRequests = [];
            const retryPhases = [];
            globalThis.fetch = async function retryRequestLocalModel(url, options) {
                retryRequests.push(JSON.parse(options.body));
                assertDefaultSelection('retry dispatch');
                if (retryRequests.length === 1) throw new TypeError('Failed to fetch.');
                return jsonResponse(smallerModel);
            };
            const retried = await ai.fetchRequest({
                messages,
                model: smallerModel,
                temperature: 0.8,
                onRetry(state) {
                    retryPhases.push(state.phase);
                    assertDefaultSelection('retry callback');
                }
            });
            assert.equal(retried.model, smallerModel);
            assert.equal(retryRequests.length, 2);
            assert.equal(retryRequests[0].model, smallerModel);
            assert.equal(retryRequests[0].temperature, 0.8);
            assert.deepEqual(retryRequests[0], retryRequests[1]);
            assert.deepEqual(retryRequests[0].messages, originalMessages);
            assert.deepEqual(retryPhases, ['waiting', 'requesting']);
            assertDefaultSelection('retry completion');

            const nativeCalls = [];
            let nativeResponseModel;
            globalThis.Arcane = {
                ollama: {
                    async chat(request, options) {
                        nativeCalls.push(request);
                        if (request.stream) {
                            await options.onChunk({message: {content}});
                        }
                        return {
                            ...(nativeResponseModel === undefined ? {} : {model: nativeResponseModel}),
                            message: {role: 'assistant', content},
                            done_reason: 'stop'
                        };
                    }
                }
            };
            await ai.transitionAI('OLLAMA', undefined, undefined, 'granite3.3:8b');
            const nativeSelection = structuredClone(ai.providerRuntime.selection('llm'));
            for (const method of ['fetchRequest', 'streamRequest']) {
                for (const returnedModel of [undefined, 'native-returned-model']) {
                    nativeResponseModel = returnedModel;
                    let observedModel;
                    await ai[method]({
                        messages,
                        model: 'granite3.3:2b',
                        temperature: 0.8,
                        localOnly: true,
                        onResponse(response) { observedModel = response.model; }
                    });
                    assert.equal(nativeCalls.at(-1).model, 'granite3.3:2b');
                    assert.equal(Object.hasOwn(nativeCalls.at(-1), 'temperature'), false);
                    assert.equal(Object.hasOwn(nativeCalls.at(-1), 'options'), false);
                    assert.deepEqual(nativeCalls.at(-1).messages, originalMessages);
                    assert.equal(observedModel, returnedModel ?? 'granite3.3:2b');
                    assert.equal(ai.model, 'granite3.3:8b');
                    assert.equal(ai.llmService, 'OLLAMA');
                    assert.deepEqual(ai.providerRuntime.selection('llm'), nativeSelection);
                    assert.deepEqual(messages, originalMessages);
                }
            }
        } finally {
            try {
                ai?.stopAudio();
                await ai?.providerRuntime.disposeAll();
            } finally {
                const registration = globalThis[registrationKey];
                if (registration !== previousRegistration) registration?.dispose();
                for (const [key, descriptor] of previousGlobals) {
                    if (descriptor) {
                        Object.defineProperty(globalThis, key, descriptor);
                    } else {
                        delete globalThis[key];
                    }
                }
            }
        }
    }
);
