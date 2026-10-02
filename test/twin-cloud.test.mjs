import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {fetchRequest, fetchSystemOneRequest} from '../browser-runtime/ai/twin-cloud.mjs';

const destination = 'https://inference.do-ai.run/v1/chat/completions';
const twinKey = 'synthetic-twin-fixture-key';
const model = 'openai-gpt-oss-20b';

function response(status, content, contentType = 'application/json') {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(
            {'content-type': contentType}
        ),
        async json() {
            return content;
        },
        async text() {
            return content;
        }
    };
}

function runtimeFixture(context, answer, onRetryDelay) {
    const previousFetch = globalThis.fetch;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const requests = [];
    const delays = [];
    const timers = new Set();
    globalThis.fetch = async function syntheticCloudFetch(url, options) {
        requests.push(
            {url, options}
        );
        return answer(url, options);
    };
    globalThis.setTimeout = function syntheticRetryTimer(callback, milliseconds, ...arguments_) {
        if (milliseconds !== 3000) {
            return previousSetTimeout(callback, milliseconds, ...arguments_);
        }
        const timer = {active: true};
        timers.add(timer);
        delays.push(milliseconds);
        queueMicrotask(
            function finishSyntheticDelay() {
                if (!timer.active) {
                    return;
                }
                if (onRetryDelay) {
                    onRetryDelay();
                } else {
                    callback(...arguments_);
                }
            }
        );
        return timer;
    };
    globalThis.clearTimeout = function clearSyntheticRetryTimer(timer) {
        if (timers.has(timer)) {
            timer.active = false;
        } else {
            previousClearTimeout(timer);
        }
    };
    context.after(
        function restoreCloudRuntime() {
            for (const timer of timers) {
                timer.active = false;
            }
            globalThis.fetch = previousFetch;
            globalThis.setTimeout = previousSetTimeout;
            globalThis.clearTimeout = previousClearTimeout;
        }
    );
    return {
        requests,
        delays
    };
}

function requestAborted(error) {
    assert.equal(error.code, 'ARCANE_AI_REQUEST_ABORTED');
    assert.equal(error.name, 'AbortError');
    return true;
}

test(
    'TWiN System One preserves caller state, questions and the complete native response',
    async function completeSystemOneRequest(context) {
        const state = {document: '  The moon-powered toaster launched every croissant.\n  '};
        const questions = {launch: {description: '  Caller-owned question.\n', choices: {'0': 'Grounded', '4': 'In orbit'}}};
        const selectedModel = 'typesafe-jev-1.13.0';
        const payload = JSON.stringify({model: selectedModel, state, questions});
        const parsed = {answers: {launch: '4'}, extension: {detail: '  Complete native result.\n'}};
        const events = [];
        const controller = new AbortController();
        const fixture = runtimeFixture(
            context,
            async function answerSystemOne() {
                events.push('fetch');
                return response(200, parsed);
            }
        );
        const result = await fetchSystemOneRequest(
            {
                twinKey,
                model: selectedModel,
                state,
                questions,
                signal: controller.signal,
                id: 'caller-evaluation',
                async onRequest(request, id, metadata) {
                    assert.equal(request.state, state);
                    assert.equal(request.questions, questions);
                    assert.equal(id, 'caller-evaluation');
                    assert.deepEqual(
                        metadata,
                        {operation: 'systemone', transport: 'http', destination: 'https://inference.do-ai.run/v1/systemone'}
                    );
                    assert.equal(Object.hasOwn(request, 'twinKey'), false);
                    events.push('request');
                    request.state = {document: 'An observer cannot rewrite the submitted content.'};
                },
                async onResponse(value, id, streaming) {
                    assert.equal(value, parsed);
                    assert.equal(id, 'caller-evaluation');
                    assert.equal(streaming, false);
                    events.push('response');
                }
            }
        );
        assert.equal(result, parsed);
        assert.deepEqual(events, ['request', 'fetch', 'response']);
        assert.equal(fixture.requests.length, 1);
        const sent = fixture.requests[0];
        assert.equal(sent.url, 'https://inference.do-ai.run/v1/systemone');
        assert.equal(sent.options.method, 'POST');
        assert.equal(sent.options.credentials, 'omit');
        assert.equal(sent.options.signal, controller.signal);
        assert.equal(sent.options.body, payload);
        assert.equal(new Headers(sent.options.headers).get('Authorization'), `Bearer ${twinKey}`);
        assert.equal(new Headers(sent.options.headers).get('Content-Type'), 'application/json');
    }
);

test(
    'TWiN System One shares transport retries and complete provider failures',
    async function retrySystemOneRequest(context) {
        const failure = {error: {message: 'Synthetic provider failure'}, details: ['Full original diagnostic.']};
        const observations = [];
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function failSystemOne() {
                attempts += 1;
                return response(attempts === 1 ? 529 : 400, failure);
            }
        );
        await assert.rejects(
            fetchSystemOneRequest(
                {
                    twinKey,
                    model: 'caller-selected-system-one-model',
                    state: {source: '  Complete original source.\n'},
                    questions: {caller: ['All', 'questions']},
                    onRetry(observation) {
                        observations.push(observation);
                    }
                }
            ),
            function originalSystemOneFailure(error) {
                assert.equal(error, failure);
                return true;
            }
        );
        assert.equal(fixture.requests.length, 2);
        assert.equal(fixture.requests[1].options, fixture.requests[0].options);
        assert.deepEqual(fixture.delays, [3000]);
        assert.deepEqual(
            observations.map(function retryPhase(observation) {return observation.phase;}),
            ['waiting', 'requesting']
        );
        for (const observation of observations) {
            assert.equal(observation.error, failure);
            assert.equal(observation.status, 529);
        }
    }
);

test(
    'TWiN System One requires explicit credentials and model and respects callback cancellation',
    async function cancelledSystemOneRequest(context) {
        const fixture = runtimeFixture(
            context,
            async function unusedSystemOneFetch() {
                throw new Error('Cancelled or unconfigured System One requests must not dispatch.');
            }
        );
        await assert.rejects(fetchSystemOneRequest({model}), {code: 'AI_PROVIDER_NOT_CONFIGURED'});
        await assert.rejects(fetchSystemOneRequest({twinKey}), TypeError);
        const controller = new AbortController();
        await assert.rejects(
            fetchSystemOneRequest(
                {
                    twinKey,
                    model,
                    state: {},
                    questions: {},
                    signal: controller.signal,
                    async onRequest() {
                        controller.abort('Caller cancelled the evaluation.');
                    }
                }
            ),
            requestAborted
        );
        assert.equal(fixture.requests.length, 0);
    }
);

test(
    'Node TWiN fetch preserves explicit model, complete request and structured multi-choice response',
    async function completeCloudRequest(context) {
        const messages = [
            {role: 'system', content: 'Preserve every word in the supplied document.'},
            {role: 'user', content: '<article>  Full original HTML.\nSecond line.  </article>'},
            {role: 'tool', tool_call_id: 'existing-call', content: '  Complete tool result.\n', name: 'read_document'}
        ];
        const schema = {
            type: 'object',
            properties: {
                html: {type: 'string'},
                text: {type: 'string'}
            },
            required: ['html', 'text'],
            additionalProperties: false
        };
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'read_document',
                    description: 'Read the selected complete document.',
                    parameters: {
                        type: 'object',
                        properties: {message: {type: 'string', minLength: 1}},
                        required: ['message']
                    }
                }
            }
        ];
        const parsed = {
            id: 'complete-response',
            model,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: '{"html":"<p>Complete HTML</p>","text":"Complete text"}',
                        reasoning: '  Complete diagnostic reasoning.  ',
                        tool_calls: [
                            {
                                id: 'selected-call',
                                type: 'function',
                                function: {
                                    name: 'read_document',
                                    arguments: '{"message":"Reading the full document.","document":"Complete source"}'
                                }
                            }
                        ]
                    },
                    finish_reason: 'tool_calls'
                },
                {
                    index: 1,
                    message: {role: 'assistant', content: '  Complete alternative.\nSecond line.  '},
                    finish_reason: 'stop'
                }
            ],
            usage: {prompt_tokens: 21, completion_tokens: 34},
            extension: {complete: ['one', 'two']}
        };
        const events = [];
        const fixture = runtimeFixture(
            context,
            async function answerCompleteRequest() {
                events.push('fetch');
                return response(200, parsed);
            }
        );
        const controller = new AbortController();
        const id = 42;
        const result = await fetchRequest(
            {
                twinKey,
                model,
                messages,
                structuredOutput: schema,
                signal: controller.signal,
                id,
                reasoningEffort: 'high',
                tools,
                toolChoice: 'auto',
                parallelToolCalls: true,
                async onRequest(request, requestId, metadata) {
                    assert.equal(request.messages, messages);
                    assert.equal(request.tools, tools);
                    assert.equal(requestId, id);
                    assert.deepEqual(
                        metadata,
                        {operation: 'fetch', transport: 'http', destination}
                    );
                    events.push('request');
                },
                async onResponse(value, requestId, streaming) {
                    assert.equal(value, parsed);
                    assert.equal(requestId, id);
                    assert.equal(streaming, false);
                    events.push('response');
                }
            }
        );
        assert.equal(result, parsed);
        assert.deepEqual(
            events,
            ['request', 'fetch', 'response']
        );
        assert.equal(fixture.requests.length, 1);
        const sent = fixture.requests[0];
        assert.equal(sent.url, destination);
        assert.equal(sent.options.method, 'POST');
        assert.equal(sent.options.signal, controller.signal);
        assert.equal(new Headers(sent.options.headers).get('Authorization'), `Bearer ${twinKey}`);
        assert.equal(new Headers(sent.options.headers).get('Content-Type'), 'application/json');
        assert.deepEqual(
            JSON.parse(sent.options.body),
            {
                model,
                messages,
                stream: false,
                response_format: {
                    type: 'json_schema',
                    json_schema: {name: 'structured_response', strict: true, schema}
                },
                tools,
                tool_choice: 'auto',
                parallel_tool_calls: true,
                reasoning_effort: 'high'
            }
        );
    }
);

test(
    'TWiN JSON modes and separate calls retain no previous request or response context',
    async function independentCloudCalls(context) {
        const fixture = runtimeFixture(
            context,
            async function answerIndependentRequest() {
                return response(
                    200,
                    {choices: [{message: {role: 'assistant', content: 'A temporary response.'}}]}
                );
            }
        );
        const first = [{role: 'user', content: '  First complete document.  '}];
        const second = [{role: 'user', content: '  Second complete document.  '}];
        await fetchRequest(
            {twinKey, model, messages: first, structuredOutput: true}
        );
        await fetchRequest(
            {twinKey, model, messages: second, structuredOutput: 'json'}
        );
        await fetchRequest(
            {twinKey, model}
        );
        const bodies = fixture.requests.map(
            function sentBody(request) {
                return JSON.parse(request.options.body);
            }
        );
        assert.deepEqual(
            bodies[0],
            {model, messages: first, stream: false, response_format: {type: 'json_object'}}
        );
        assert.deepEqual(
            bodies[1],
            {model, messages: second, stream: false, response_format: {type: 'json_object'}}
        );
        assert.deepEqual(
            bodies[2],
            {model, messages: [], stream: false}
        );
        assert.deepEqual(
            first,
            [{role: 'user', content: '  First complete document.  '}]
        );
        assert.deepEqual(
            second,
            [{role: 'user', content: '  Second complete document.  '}]
        );
    }
);

test(
    'TWiN preserves unlimited overload retries and reports each attempt once',
    async function cloudOverloadRetry(context) {
        const parsed = {choices: [{message: {role: 'assistant', content: 'Complete eventual response.'}}]};
        const replies = [
            response(
                429,
                {error: {message: 'Model OVERLOADED, try later.'}}
            ),
            response(
                429,
                {message: 'Temporary overload.'}
            ),
            response(429, 'Server OverLoad continues.', 'text/plain'),
            response(429, 'Overload still continues.', 'text/plain'),
            response(200, parsed)
        ];
        const retries = [];
        let requestCallbacks = 0;
        let responseCallbacks = 0;
        const fixture = runtimeFixture(
            context,
            async function answerOverloadedRequest() {
                return replies.shift();
            }
        );
        const result = await fetchRequest(
            {
                twinKey,
                model,
                messages: [{role: 'user', content: '  Complete retried document.  '}],
                onRequest() {
                    requestCallbacks += 1;
                },
                onResponse() {
                    responseCallbacks += 1;
                },
                onRetry(state) {
                    retries.push(state);
                }
            }
        );
        assert.equal(result, parsed);
        assert.deepEqual(
            fixture.delays,
            [3000, 3000, 3000, 3000]
        );
        assert.equal(fixture.requests.length, 5);
        for (const request of fixture.requests) {
            assert.equal(request.options.body, fixture.requests[0].options.body);
        }
        assert.equal(requestCallbacks, 1);
        assert.equal(responseCallbacks, 1);
        assert.equal(retries.length, 8);
        for (let index = 0; index < retries.length; index += 2) {
            assert.deepEqual(
                retries[index],
                {
                    phase: 'waiting',
                    attempt: index / 2 + 1,
                    delayMs: 3000,
                    status: 429,
                    error: retries[index].error
                }
            );
            assert.deepEqual(
                retries[index + 1],
                {...retries[index], phase: 'requesting'}
            );
        }
    }
);

test(
    'TWiN recovers rejected Fetch and HTTP 529 using the exact request and retry cause',
    async function recoverCloudTransport(context) {
        const networkError = new TypeError('Failed to fetch. Complete network detail.');
        const overloadError = {error: {message: 'Temporarily unavailable.', detail: ['whole', 'body']}};
        const parsed = {choices: [{message: {role: 'assistant', content: 'Recovered response.'}}]};
        const events = [];
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerRecoveringRequest() {
                attempts += 1;
                events.push(`fetch:${attempts}`);
                if (attempts === 1) {
                    throw networkError;
                }
                return attempts === 2 ? response(529, overloadError) : response(200, parsed);
            }
        );
        const retries = [];
        const controller = new AbortController();
        const result = await fetchRequest(
            {
                twinKey,
                model,
                messages: [{role: 'user', content: '  Keep this exact\ndocument.  '}],
                signal: controller.signal,
                onRequest() {
                    events.push('request');
                },
                onRetry(state) {
                    retries.push(state);
                    events.push(`${state.phase}:${state.attempt}`);
                },
                onResponse() {
                    events.push('response');
                }
            }
        );
        assert.equal(result, parsed);
        assert.deepEqual(
            events,
            ['request', 'fetch:1', 'waiting:1', 'requesting:1', 'fetch:2', 'waiting:2', 'requesting:2', 'fetch:3', 'response']
        );
        assert.deepEqual(
            retries,
            [
                {phase: 'waiting', attempt: 1, delayMs: 3000, status: null, error: networkError},
                {phase: 'requesting', attempt: 1, delayMs: 3000, status: null, error: networkError},
                {phase: 'waiting', attempt: 2, delayMs: 3000, status: 529, error: overloadError},
                {phase: 'requesting', attempt: 2, delayMs: 3000, status: 529, error: overloadError}
            ]
        );
        for (const request of fixture.requests) {
            assert.equal(request.options, fixture.requests[0].options);
            assert.equal(request.options.signal, controller.signal);
            assert.equal(Object.hasOwn(request.options, 'onRetry'), false);
            assert.equal(Object.hasOwn(JSON.parse(request.options.body), 'onRetry'), false);
        }
    }
);

test(
    'TWiN limits Fetch and HTTP 529 recovery to three retries and preserves the terminal failure',
    async function boundedCloudRecovery(context) {
        const networkError = new TypeError('Complete final network failure.');
        const overloadError = {message: 'Complete final HTTP 529 failure.', details: ['one', 'two']};
        let attempt = 0;
        let retryCount = 0;
        let networkOnly = false;
        const fixture = runtimeFixture(
            context,
            async function rejectRepeatedCloudRequest() {
                attempt += 1;
                if (networkOnly || attempt % 2 === 1) {
                    throw networkError;
                }
                return response(529, overloadError);
            }
        );
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    onRetry() {
                        retryCount += 1;
                    }
                }
            ),
            function preserveFinalCloudFailure(error) {
                assert.equal(error, overloadError);
                return true;
            }
        );
        assert.equal(fixture.requests.length, 4);
        assert.equal(retryCount, 6);
        assert.deepEqual(
            fixture.delays,
            [3000, 3000, 3000]
        );
        networkOnly = true;
        await assert.rejects(
            fetchRequest(
                {twinKey, model}
            ),
            function preserveTerminalNetworkFailure(error) {
                assert.equal(error, networkError);
                return true;
            }
        );
        assert.equal(fixture.requests.length, 8);
        assert.deepEqual(
            fixture.delays,
            [3000, 3000, 3000, 3000, 3000, 3000]
        );
    }
);

test(
    'TWiN retries HTTP 529 malformed JSON and failed diagnostic reads with the original failures',
    async function recoverUnreadableOverloadDiagnostics(context) {
        const bodyReadError = new TypeError('The moon server closed its diagnostic stream.');
        const parsed = {choices: [{message: {content: 'The moon server recovered.'}}]};
        const retries = [];
        let parsingError;
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerUnreadableOverloadDiagnostics() {
                attempts += 1;
                if (attempts === 1) {
                    return {
                        ...response(529, null),
                        async json() {
                            try {
                                return JSON.parse('{The moon server is overloaded.');
                            } catch (error) {
                                parsingError = error;
                                throw error;
                            }
                        }
                    };
                }
                if (attempts === 2) {
                    return {
                        ...response(529, null, 'text/plain'),
                        async text() {
                            throw bodyReadError;
                        }
                    };
                }
                return response(200, parsed);
            }
        );
        const result = await fetchRequest(
            {
                twinKey,
                model,
                messages: [{role: 'user', content: '  Preserve the complete moon report.\n  '}],
                onRetry(state) {
                    retries.push(state);
                }
            }
        );
        assert.equal(result, parsed);
        assert.ok(parsingError instanceof SyntaxError);
        assert.deepEqual(
            retries,
            [
                {phase: 'waiting', attempt: 1, delayMs: 3000, status: 529, error: parsingError},
                {phase: 'requesting', attempt: 1, delayMs: 3000, status: 529, error: parsingError},
                {phase: 'waiting', attempt: 2, delayMs: 3000, status: 529, error: bodyReadError},
                {phase: 'requesting', attempt: 2, delayMs: 3000, status: 529, error: bodyReadError}
            ]
        );
        assert.equal(fixture.requests.length, 3);
        assert.deepEqual(
            fixture.delays,
            [3000, 3000]
        );
        for (const request of fixture.requests) {
            assert.equal(request.options, fixture.requests[0].options);
        }
        assert.deepEqual(
            JSON.parse(fixture.requests[0].options.body).messages,
            [{role: 'user', content: '  Preserve the complete moon report.\n  '}]
        );
    }
);

test(
    'TWiN exhausts HTTP 529 diagnostic retries with the exact final reading failure',
    async function exhaustUnreadableOverloadDiagnostics(context) {
        const failures = [
            new TypeError('First complete diagnostic read failure.'),
            new TypeError('Second complete diagnostic read failure.'),
            new TypeError('Third complete diagnostic read failure.'),
            new TypeError('Final complete diagnostic read failure.')
        ];
        const retries = [];
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function failEveryOverloadDiagnosticRead() {
                const failure = failures[attempts];
                attempts += 1;
                return {
                    ...response(529, null, 'text/plain'),
                    async text() {
                        throw failure;
                    }
                };
            }
        );
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    onRetry(state) {
                        retries.push(state);
                    }
                }
            ),
            function preserveFinalDiagnosticFailure(error) {
                assert.equal(error, failures[3]);
                return true;
            }
        );
        assert.equal(fixture.requests.length, 4);
        assert.deepEqual(
            fixture.delays,
            [3000, 3000, 3000]
        );
        assert.equal(retries.length, 6);
        for (let index = 0; index < retries.length; index += 1) {
            assert.equal(retries[index].status, 529);
            assert.equal(retries[index].error, failures[Math.floor(index / 2)]);
        }
    }
);

test(
    'TWiN cancellation during HTTP 529 diagnostic reading prevents retries',
    async function abortUnreadableOverloadDiagnostics(context) {
        let selectedResponse;
        const fixture = runtimeFixture(
            context,
            async function answerCancelledOverloadDiagnostics() {
                return selectedResponse;
            }
        );
        for (const contentType of ['application/json', 'text/plain']) {
            for (const cancellation of ['body-abort', 'signal-abort']) {
                const controller = new AbortController();
                const failure = cancellation === 'body-abort'
                    ? new DOMException('The diagnostic body was cancelled.', 'AbortError')
                    : new TypeError('The diagnostic body closed during cancellation.');
                async function failCancelledDiagnosticRead() {
                    await Promise.resolve();
                    if (cancellation === 'signal-abort') {
                        controller.abort('Moon recovery was cancelled.');
                    }
                    throw failure;
                }
                selectedResponse = {
                    ...response(529, null, contentType),
                    json: failCancelledDiagnosticRead,
                    text: failCancelledDiagnosticRead
                };
                await assert.rejects(
                    fetchRequest(
                        {
                            twinKey,
                            model,
                            signal: controller.signal,
                            onRetry() {
                                assert.fail('A cancelled diagnostic read must not retry.');
                            }
                        }
                    ),
                    function preserveDiagnosticCancellation(error) {
                        requestAborted(error);
                        assert.equal(error.cause, failure);
                        return true;
                    }
                );
            }
        }
        assert.equal(fixture.requests.length, 4);
        assert.deepEqual(
            fixture.delays,
            []
        );
    }
);

test(
    'TWiN leaves diagnostic decoding failures for other HTTP statuses unchanged',
    async function preserveOtherHTTPDiagnosticFailures(context) {
        let selectedResponse;
        const fixture = runtimeFixture(
            context,
            async function answerOtherUnreadableDiagnostics() {
                return selectedResponse;
            }
        );
        for (const status of [429, 503]) {
            for (const contentType of ['application/json', 'text/plain']) {
                const failure = contentType === 'application/json'
                    ? new SyntaxError('Complete malformed overload diagnostic.')
                    : new TypeError('Complete overload diagnostic read failure.');
                async function failOtherDiagnosticRead() {
                    throw failure;
                }
                selectedResponse = {
                    ...response(status, null, contentType),
                    json: failOtherDiagnosticRead,
                    text: failOtherDiagnosticRead
                };
                await assert.rejects(
                    fetchRequest(
                        {
                            twinKey,
                            model,
                            onRetry() {
                                assert.fail('Other diagnostic decoding failures must not retry.');
                            }
                        }
                    ),
                    function preserveOtherDiagnosticFailure(error) {
                        assert.equal(error, failure);
                        return true;
                    }
                );
            }
        }
        assert.equal(fixture.requests.length, 4);
        assert.deepEqual(
            fixture.delays,
            []
        );
    }
);

test(
    'TWiN retry observers cannot fail or delay request recovery',
    async function observeCloudRetryFailures(context) {
        const previousConsoleError = console.error;
        const diagnostics = [];
        console.error = function recordRetryObserverFailure(...args) {
            diagnostics.push(args);
        };
        context.after(
            function restoreRetryObserverConsole() {
                console.error = previousConsoleError;
            }
        );
        const synchronousFailure = new Error('Complete synchronous observer failure.');
        const asynchronousFailure = new Error('Complete asynchronous observer failure.');
        const parsed = {choices: [{message: {content: 'Recovered with broken observer.'}}]};
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerAfterObserverFailures() {
                attempts += 1;
                if (attempts < 3) {
                    throw new TypeError('Failed to fetch.');
                }
                return response(200, parsed);
            }
        );
        const result = await fetchRequest(
            {
                twinKey,
                model,
                onRetry(state) {
                    if (state.attempt === 1 && state.phase === 'waiting') {
                        throw synchronousFailure;
                    }
                    if (state.attempt === 1) {
                        return Promise.reject(asynchronousFailure);
                    }
                    return new Promise(
                        function retainPendingObserver() {}
                    );
                }
            }
        );
        assert.equal(result, parsed);
        assert.equal(fixture.requests.length, 3);
        assert.deepEqual(
            diagnostics,
            [
                ['Arcane AI retry observer failed.', synchronousFailure],
                ['Arcane AI retry observer failed.', asynchronousFailure]
            ]
        );
    }
);

test(
    'TWiN cancellation from either retry phase prevents a repeated Fetch',
    async function abortObservedCloudRetry(context) {
        const networkError = new TypeError('Failed to fetch.');
        const fixture = runtimeFixture(
            context,
            async function rejectBeforeRetryAbort() {
                throw networkError;
            }
        );
        for (const phase of ['waiting', 'requesting']) {
            const controller = new AbortController();
            const observed = [];
            await assert.rejects(
                fetchRequest(
                    {
                        twinKey,
                        model,
                        signal: controller.signal,
                        onRetry(state) {
                            observed.push(state.phase);
                            if (state.phase === phase) {
                                controller.abort('The request owner cancelled recovery.');
                            }
                        }
                    }
                ),
                requestAborted
            );
            assert.deepEqual(
                observed,
                phase === 'waiting' ? ['waiting'] : ['waiting', 'requesting']
            );
        }
        assert.equal(fixture.requests.length, 2);
    }
);

test(
    'TWiN does not retry successful response decoding or request and response callbacks',
    async function preserveCloudNontransportFailures(context) {
        const decodingError = new TypeError('Complete body-read failure.');
        const callbackError = new TypeError('Complete callback failure.');
        let failDecoding = true;
        let retryObservations = 0;
        const fixture = runtimeFixture(
            context,
            async function returnDecodingBoundary() {
                return {
                    ...response(200, null),
                    async json() {
                        if (failDecoding) {
                            throw decodingError;
                        }
                        return {choices: [{message: {content: 'Complete response.'}}]};
                    }
                };
            }
        );
        for (const boundary of ['decode', 'request', 'response']) {
            failDecoding = boundary === 'decode';
            await assert.rejects(
                fetchRequest(
                    {
                        twinKey,
                        model,
                        onRequest() {
                            if (boundary === 'request') {
                                throw callbackError;
                            }
                        },
                        onResponse() {
                            throw callbackError;
                        },
                        onRetry() {
                            retryObservations += 1;
                        }
                    }
                ),
                function preserveBoundaryFailure(error) {
                    assert.equal(error, boundary === 'decode' ? decodingError : callbackError);
                    return true;
                }
            );
        }
        assert.equal(fixture.requests.length, 2);
        assert.deepEqual(fixture.delays, []);
        assert.equal(retryObservations, 0);
    }
);

test(
    'TWiN preserves non-overload parsed failures without retrying or reporting a response',
    async function cloudOrdinaryFailures(context) {
        const failures = [
            response(
                429,
                {error: {message: 'Rate limit reached.', detail: ['complete', 'error']}}
            ),
            response(
                503,
                {message: 'Model overload.'}
            ),
            response(401, 'Complete authentication failure.', 'text/plain')
        ];
        let selected;
        const fixture = runtimeFixture(
            context,
            async function answerFailure() {
                return selected;
            }
        );
        for (const failure of failures) {
            selected = failure;
            const expected = await failure.json();
            await assert.rejects(
                fetchRequest(
                    {
                        twinKey,
                        model,
                        onResponse() {
                            assert.fail('A failed request must not publish a successful response.');
                        }
                    }
                ),
                function completeFailure(error) {
                    assert.equal(error, expected);
                    return true;
                }
            );
        }
        assert.equal(fixture.requests.length, failures.length);
        assert.deepEqual(fixture.delays, []);
    }
);

test(
    'TWiN abort during the overload delay stops the retry and response callback',
    async function abortCloudRetry(context) {
        const controller = new AbortController();
        const fixture = runtimeFixture(
            context,
            async function answerOverloadBeforeAbort() {
                return response(
                    429,
                    {error: {message: 'Model overload.'}}
                );
            },
            function abortRetryDelay() {
                controller.abort('The temporary operation ended.');
            }
        );
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    signal: controller.signal,
                    onResponse() {
                        assert.fail('An aborted retry must not publish a response.');
                    }
                }
            ),
            requestAborted
        );
        assert.equal(fixture.requests.length, 1);
        assert.deepEqual(fixture.delays, [3000]);
    }
);

test(
    'TWiN abort while awaiting fetch normalizes cancellation and publishes no response',
    async function abortCloudFetch(context) {
        const controller = new AbortController();
        const fixture = runtimeFixture(
            context,
            function pendingFetch(url, options) {
                return new Promise(
                    function holdFetch(resolve, reject) {
                        options.signal.addEventListener(
                            'abort',
                            function rejectAbortedFetch() {
                                reject(new DOMException('The synthetic fetch was aborted.', 'AbortError'));
                            },
                            {once: true}
                        );
                        queueMicrotask(
                            function abortPendingFetch() {
                                controller.abort();
                            }
                        );
                    }
                );
            }
        );
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    signal: controller.signal,
                    onResponse() {
                        assert.fail('An aborted fetch must not publish a response.');
                    }
                }
            ),
            requestAborted
        );
        assert.equal(fixture.requests.length, 1);
        assert.deepEqual(fixture.delays, []);
    }
);

test(
    'TWiN observes abort after request callbacks and response parsing',
    async function abortCloudBoundaries(context) {
        const controller = new AbortController();
        let responseCallbacks = 0;
        let abortDuringParse = true;
        const fixture = runtimeFixture(
            context,
            async function answerBeforeParseAbort() {
                return {
                    ...response(200, null),
                    async json() {
                        await Promise.resolve();
                        if (abortDuringParse) {
                            controller.abort();
                        }
                        return {choices: [{message: {content: 'Do not publish this cancelled response.'}}]};
                    }
                };
            }
        );
        const beforeFetch = new AbortController();
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    signal: alreadyAborted.signal,
                    onRequest() {
                        assert.fail('A pre-aborted operation must not publish a request.');
                    }
                }
            ),
            requestAborted
        );
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    signal: beforeFetch.signal,
                    async onRequest() {
                        await Promise.resolve();
                        beforeFetch.abort();
                    }
                }
            ),
            requestAborted
        );
        assert.equal(fixture.requests.length, 0);
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    signal: controller.signal,
                    onResponse() {
                        responseCallbacks += 1;
                    }
                }
            ),
            requestAborted
        );
        assert.equal(responseCallbacks, 0);
        assert.equal(fixture.requests.length, 1);
        abortDuringParse = false;
        const afterResponse = new AbortController();
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    signal: afterResponse.signal,
                    async onResponse() {
                        responseCallbacks += 1;
                        await Promise.resolve();
                        afterResponse.abort();
                    }
                }
            ),
            requestAborted
        );
        assert.equal(responseCallbacks, 1);
        assert.equal(fixture.requests.length, 2);
    }
);
