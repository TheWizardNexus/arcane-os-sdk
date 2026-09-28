import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

test(
    'AI request retries cross built-in provider controls once and never replay delivered work',
    async function aiRequestRetryContract() {
        const previousGlobals = new Map(
            ['window', 'document', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout'].map(
                function readRetryGlobalDescriptor(key) {
                    return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
                }
            )
        );
        const previousSetTimeout = globalThis.setTimeout;
        const previousClearTimeout = globalThis.clearTimeout;
        const registrationKey = Symbol.for('arcane.ai.user-ready-registration');
        const previousRegistration = globalThis[registrationKey];
        const values = new Map();
        const localStorage = {
            getItem(key) {
                return values.get(String(key)) ?? null;
            },
            setItem(key, value) {
                values.set(String(key), String(value));
            },
            removeItem(key) {
                values.delete(String(key));
            }
        };
        const windowTarget = new EventTarget();
        const documentObject = {
            documentElement: {dataset: {arcaneAppId: 'request-retry-contract'}},
            querySelector() {
                return null;
            }
        };
        windowTarget.dbopfs = {ready: false, get() {}};
        windowTarget.user = {ready: false};
        windowTarget.document = documentObject;
        windowTarget.localStorage = localStorage;
        globalThis.window = windowTarget;
        globalThis.document = documentObject;
        globalThis.localStorage = localStorage;
        const timers = new Set();
        let onDelay = null;
        globalThis.setTimeout = function syntheticAIRecoveryDelay(callback, milliseconds, ...args) {
            if (milliseconds !== 3000) {
                return previousSetTimeout(callback, milliseconds, ...args);
            }
            const timer = {active: true};
            timers.add(timer);
            queueMicrotask(
                function finishAIRecoveryDelay() {
                    if (timer.active) {
                        onDelay?.();
                    }
                    if (timer.active) {
                        callback(...args);
                    }
                }
            );
            return timer;
        };
        globalThis.clearTimeout = function clearAIRecoveryDelay(timer) {
            if (timers.has(timer)) {
                timer.active = false;
            } else {
                previousClearTimeout(timer);
            }
        };

        function completion(content) {
            return {choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}]};
        }

        function jsonResponse(value, status = 200) {
            return new Response(
                JSON.stringify(value),
                {status, headers: {'content-type': 'application/json'}}
            );
        }

        function streamResponse() {
            return new Response(
                [
                    'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"First "}}]}',
                    'data: {"choices":[{"index":0,"delta":{"content":"second."},"finish_reason":"stop"}]}',
                    'data: [DONE]',
                    ''
                ].join('\n\n'),
                {status: 200, headers: {'content-type': 'text/event-stream'}}
            );
        }

        let ai;
        try {
            const {default: AI} = await import(process.env.ARCANE_SDK_RETRY_AI_URL ?? 'arcane-os/ai');
            ai = new AI('TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH', 'TWIN');
            ai.twinKey = 'synthetic-retry-credential';
            await ai.providerRuntime.load('llm');

            for (const method of ['fetchRequest', 'streamRequest']) {
                const controller = new AbortController();
                const networkError = new TypeError('Failed to fetch.');
                const overloadError = {message: 'Complete HTTP 529 failure.', details: ['one', 'two']};
                const requests = [];
                const phases = [];
                const chunks = [];
                const thinking = [];
                let requestCallbacks = 0;
                let responseCallbacks = 0;
                globalThis.fetch = async function recoverBuiltInAIRequest(url, options) {
                    requests.push(
                        {url, options}
                    );
                    if (requests.length === 1) {
                        throw networkError;
                    }
                    if (requests.length === 2) {
                        return jsonResponse(overloadError, 529);
                    }
                    return method === 'streamRequest' ? streamResponse() : jsonResponse(completion('First second.'));
                };
                const request = ai[method](
                    {
                        messages: [{role: 'user', content: '  Preserve the complete\nrequest.  '}],
                        reasoningEffort: 'high',
                        signal: controller.signal,
                        onRequest(request) {
                            requestCallbacks += 1;
                            assert.equal(Object.hasOwn(request, 'onRetry'), false);
                        },
                        onRetry(state) {
                            phases.push(state);
                        },
                        onChunk(text, id, isThinking) {
                            if (isThinking) {
                                thinking.push(text);
                                return;
                            }
                            chunks.push(text);
                        },
                        onResponse() {
                            responseCallbacks += 1;
                        }
                    }
                );
                assert.deepEqual(
                    thinking,
                    method === 'streamRequest' ? ['Thinking...'] : [],
                    `${method}: Thinking is published synchronously before retry waits`
                );
                assert.equal(phases.length, 0, method);
                const result = await request;
                assert.equal(requestCallbacks, 1, method);
                assert.equal(responseCallbacks, 1, method);
                assert.equal(requests.length, 3, method);
                assert.deepEqual(
                    phases.map(
                        function retryPhase(state) {
                            return [state.phase, state.attempt, state.delayMs, state.status];
                        }
                    ),
                    [['waiting', 1, 3000, null], ['requesting', 1, 3000, null], ['waiting', 2, 3000, 529], ['requesting', 2, 3000, 529]],
                    method
                );
                assert.equal(phases[0].error, networkError, method);
                assert.deepEqual(phases[2].error, overloadError, method);
                for (const request of requests) {
                    assert.equal(request.options, requests[0].options, method);
                    assert.equal(Object.hasOwn(request.options, 'onRetry'), false, method);
                    assert.equal(Object.hasOwn(JSON.parse(request.options.body), 'onRetry'), false, method);
                    assert.equal(request.options.signal.aborted, false, method);
                }
                assert.deepEqual(
                    chunks,
                    method === 'streamRequest' ? ['First ', 'second.'] : [],
                    method
                );
                assert.deepEqual(
                    thinking,
                    method === 'streamRequest' ? ['Thinking...'] : [],
                    `${method}: retries preserve one Thinking notification`
                );
                assert.equal(method === 'streamRequest' ? result : result.choices[0].message.content, 'First second.');
            }

            let releaseFirstRequest;
            let openFirstRequest;
            const firstOpened = new Promise(
                function observeFirstQueuedRequest(resolve) {
                    openFirstRequest = resolve;
                }
            );
            const queuedPhases = [];
            let queueRequests = 0;
            globalThis.fetch = function answerQueuedAIRequest() {
                queueRequests += 1;
                if (queueRequests === 1) {
                    openFirstRequest();
                    return new Promise(
                        function retainFirstQueuedRequest(resolve) {
                            releaseFirstRequest = resolve;
                        }
                    );
                }
                if (queueRequests === 2) {
                    throw new TypeError('Queued request failed to fetch.');
                }
                return Promise.resolve(jsonResponse(completion('Queued recovery.')));
            };
            const firstRequest = ai.fetchRequest(
                {messages: [{role: 'user', content: 'First operation.'}]}
            );
            await firstOpened;
            const queuedRequest = ai.providerRuntime.request(
                'llm',
                {
                    operation: 'chat',
                    payload: {messages: [{role: 'user', content: 'Second operation.'}]},
                    localOnly: false,
                    signal: null
                },
                {
                    onRetry(state) {
                        queuedPhases.push(state.phase);
                    }
                }
            );
            releaseFirstRequest(jsonResponse(completion('First operation complete.')));
            await firstRequest;
            const queuedResult = await queuedRequest;
            assert.equal(queuedResult.choices[0].message.content, 'Queued recovery.');
            assert.deepEqual(
                queuedPhases,
                ['waiting', 'requesting']
            );
            assert.equal(queueRequests, 3);

            for (const method of ['fetchRequest', 'streamRequest']) {
                const controller = new AbortController();
                const phases = [];
                let attempts = 0;
                let ownedSignal;
                globalThis.fetch = async function rejectBeforeOwnedRetryAbort(url, options) {
                    attempts += 1;
                    ownedSignal = options.signal;
                    throw new TypeError('Failed to fetch before cancellation.');
                };
                onDelay = function abortCallerDuringRetry() {
                    controller.abort('The caller cancelled the active request.');
                };
                await assert.rejects(
                    ai[method](
                        {
                            messages: [{role: 'user', content: 'Cancel during recovery.'}],
                            signal: controller.signal,
                            onRetry(state) {
                                phases.push(state.phase);
                            }
                        }
                    ),
                    function preserveOwnedRetryAbort(error) {
                        assert.equal(error.code, 'ARCANE_AI_REQUEST_ABORTED', method);
                        return true;
                    }
                );
                onDelay = null;
                assert.equal(attempts, 1, method);
                assert.equal(ownedSignal.aborted, true, method);
                assert.deepEqual(
                    phases,
                    ['waiting'],
                    method
                );
            }

            for (const failureAt of ['body', 'chunk', 'tool']) {
                const failure = new TypeError(`Complete ${failureAt} failure.`);
                const chunks = [];
                const thinking = [];
                let fetches = 0;
                let retryObservations = 0;
                let toolCallbacks = 0;
                let releaseVisibleChunk;
                const visibleChunk = new Promise(
                    function observeVisibleStreamChunk(resolve) {
                        releaseVisibleChunk = resolve;
                    }
                );
                globalThis.fetch = async function streamThenFailAtOwnedBoundary() {
                    fetches += 1;
                    let pulls = 0;
                    const body = new ReadableStream(
                        {
                            async pull(streamController) {
                                pulls += 1;
                                if (pulls === 1) {
                                    streamController.enqueue(
                                        new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"Already visible."}}]}\n\n')
                                    );
                                } else {
                                    await visibleChunk;
                                    if (failureAt === 'body') {
                                        streamController.error(failure);
                                        return;
                                    }
                                    const terminal = {
                                        choices: [
                                            {
                                                index: 0,
                                                message: {
                                                    role: 'assistant',
                                                    content: 'Already visible.',
                                                    tool_calls: [
                                                        {
                                                            id: 'delivered-tool',
                                                            type: 'function',
                                                            function: {
                                                                name: 'show_result',
                                                                arguments: '{"message":"The result is ready."}'
                                                            }
                                                        }
                                                    ]
                                                },
                                                finish_reason: 'tool_calls'
                                            }
                                        ]
                                    };
                                    streamController.enqueue(
                                        new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`)
                                    );
                                    streamController.close();
                                }
                            }
                        },
                        {highWaterMark: 0}
                    );
                    return new Response(
                        body,
                        {status: 200, headers: {'content-type': 'text/event-stream'}}
                    );
                };
                await assert.rejects(
                    ai.streamRequest(
                        {
                            messages: [{role: 'user', content: 'Preserve delivered output.'}],
                            onRetry() {
                                retryObservations += 1;
                            },
                            onChunk(text, id, isThinking) {
                                if (isThinking) {
                                    thinking.push(text);
                                    return;
                                }
                                chunks.push(text);
                                releaseVisibleChunk();
                                if (failureAt === 'chunk') {
                                    throw failure;
                                }
                            },
                            onToolCall() {
                                toolCallbacks += 1;
                                throw failure;
                            }
                        }
                    ),
                    function preserveStreamBoundaryFailure(error) {
                        assert.equal(error, failure, failureAt);
                        return true;
                    }
                );
                assert.deepEqual(
                    chunks,
                    ['Already visible.'],
                    failureAt
                );
                assert.deepEqual(
                    thinking,
                    ['Thinking...'],
                    failureAt
                );
                assert.equal(fetches, 1, failureAt);
                assert.equal(retryObservations, 0, failureAt);
                assert.equal(toolCallbacks, failureAt === 'tool' ? 1 : 0, failureAt);
            }
        } finally {
            try {
                ai?.stopAudio();
                await ai?.providerRuntime.disposeAll();
            } finally {
                for (const timer of timers) {
                    timer.active = false;
                }
                const registration = globalThis[registrationKey];
                if (registration !== previousRegistration) {
                    registration?.dispose();
                }
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
