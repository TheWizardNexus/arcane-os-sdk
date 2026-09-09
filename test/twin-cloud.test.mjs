import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {fetchRequest} from '../browser-runtime/ai/twin-cloud.mjs';

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
    'TWiN retries only overload responses at the shared three-second interval',
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
            response(200, parsed)
        ];
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
                }
            }
        );
        assert.equal(result, parsed);
        assert.deepEqual(
            fixture.delays,
            [3000, 3000, 3000]
        );
        assert.equal(fixture.requests.length, 4);
        for (const request of fixture.requests) {
            assert.equal(request.options.body, fixture.requests[0].options.body);
        }
        assert.equal(requestCallbacks, 1);
        assert.equal(responseCallbacks, 1);
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
