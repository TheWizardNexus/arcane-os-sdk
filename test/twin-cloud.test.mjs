import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {fetchHTTPResponse, fetchRequest, fetchSystemOneRequest} from '../browser-runtime/ai/twin-cloud.mjs';

const destination = 'https://inference.do-ai.run/v1/chat/completions';
const twinKey = 'synthetic-twin-fixture-key';
const model = 'openai-gpt-oss-20b';

function response(status, content, contentType = 'application/json', retryAfter) {
    const headers = new Headers(
        {'content-type': contentType}
    );
    if (retryAfter !== undefined) {
        headers.set('retry-after', retryAfter);
    }
    return {
        ok: status >= 200 && status < 300,
        status,
        headers,
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
    const previousNow = Date.now;
    const requests = [];
    const delays = [];
    const timers = new Set();
    let now = Date.UTC(2026, 9, 8, 12);
    let scheduled = null;
    Date.now = function syntheticCloudTime() {
        return now;
    };

    function advanceSyntheticTimers() {
        scheduled = null;
        let next = null;
        for (const timer of timers) {
            if (!next || timer.due < next.due) {
                next = timer;
            }
        }
        if (!next) return;
        now = Math.max(now, next.due);
        const due = Array.from(timers).filter(
            function readySyntheticTimer(timer) {
                return timer.due <= now;
            }
        );
        for (const timer of due) {
            if (timer.active && onRetryDelay) {
                onRetryDelay();
            }
            if (timer.active) {
                timer.active = false;
                timers.delete(timer);
                timer.callback(...timer.arguments_);
            }
        }
        scheduleSyntheticTimers();
    }

    function scheduleSyntheticTimers() {
        if (scheduled === null && timers.size) {
            // Let all request continuations settle before advancing the shared clock.
            scheduled = previousSetTimeout(advanceSyntheticTimers, 0);
        }
    }

    globalThis.fetch = async function syntheticCloudFetch(url, options) {
        requests.push(
            {url, options, at: now}
        );
        return answer(url, options);
    };
    globalThis.setTimeout = function syntheticRetryTimer(callback, milliseconds, ...arguments_) {
        const timer = {active: true, due: now + milliseconds, callback, arguments_};
        timers.add(timer);
        delays.push(milliseconds);
        scheduleSyntheticTimers();
        return timer;
    };
    globalThis.clearTimeout = function clearSyntheticRetryTimer(timer) {
        if (timers.has(timer)) {
            timer.active = false;
            timers.delete(timer);
        } else {
            previousClearTimeout(timer);
        }
    };
    context.after(
        function restoreCloudRuntime() {
            for (const timer of timers) {
                timer.active = false;
            }
            if (scheduled !== null) previousClearTimeout(scheduled);
            globalThis.fetch = previousFetch;
            globalThis.setTimeout = previousSetTimeout;
            globalThis.clearTimeout = previousClearTimeout;
            Date.now = previousNow;
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
    'TWiN temperature preserves zero, omission, independent calls and retries',
    async function callerOwnedTemperature(context) {
        const messages = [
            {role: 'system', content: 'Keep the lunar lunch inventory complete.'},
            {role: 'user', content: '  Count every moon raccoon.\n🦝  '}
        ];
        const originalMessages = structuredClone(messages);
        const parsed = {choices: [{message: {role: 'assistant', content: '  Every raccoon counted.\n'}}], extension: {complete: true}};
        let failNextAttempt = false;
        const fixture = runtimeFixture(
            context,
            async function answerTemperatureRequest() {
                if (failNextAttempt) {
                    failNextAttempt = false;
                    throw new TypeError('Synthetic transport failure.');
                }
                return response(200, parsed);
            }
        );
        for (const options of [{}, {temperature: 0.8}, {temperature: 0}, {temperature: undefined}, {}]) {
            const start = fixture.requests.length;
            failNextAttempt = options.temperature === 0;
            const result = await fetchRequest({
                twinKey,
                model,
                messages,
                ...options,
                onRequest(request) {
                    assert.equal(request.messages, messages);
                    assert.equal(request.temperature, options.temperature);
                    assert.equal(Object.hasOwn(request, 'temperature'), options.temperature !== undefined);
                }
            });
            assert.equal(result, parsed);
            assert.deepEqual(messages, originalMessages);
            const expected = {model, messages: originalMessages, stream: false};
            if (options.temperature !== undefined) expected.temperature = options.temperature;
            for (let index = start; index < fixture.requests.length; index += 1) {
                assert.deepEqual(JSON.parse(fixture.requests[index].options.body), expected);
            }
            assert.equal(fixture.requests.length - start, options.temperature === 0 ? 2 : 1);
        }
        assert.deepEqual(fixture.delays, [3000]);
    }
);

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
    'TWiN retries every HTTP 429 with exponential delays and reports each attempt once',
    async function cloudOverloadRetry(context) {
        const parsed = {choices: [{message: {role: 'assistant', content: 'Complete eventual response.'}}]};
        const replies = [
            response(
                429,
                {error: {message: 'Model OVERLOADED, try later.'}}
            ),
            response(
                429,
                {error: {message: 'Request quota exhausted.', code: 'quota_exceeded'}, details: ['Complete quota diagnostic.', 'Second line.']}
            ),
            response(429, '  The moon raccoons used the request quota.\nTry again later.  ', 'text/plain'),
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
            [3000, 6000, 12000]
        );
        assert.equal(fixture.requests.length, 4);
        for (const request of fixture.requests) {
            assert.equal(request.options.body, fixture.requests[0].options.body);
        }
        assert.equal(requestCallbacks, 1);
        assert.equal(responseCallbacks, 1);
        assert.equal(retries.length, 6);
        for (let index = 0; index < retries.length; index += 2) {
            assert.deepEqual(
                retries[index],
                {
                    phase: 'waiting',
                    attempt: index / 2 + 1,
                    delayMs: 3000 * (2 ** (index / 2)),
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
    'TWiN honors complete Retry-After seconds and dates and falls back for invalid values',
    async function cloudRetryAfterContract(context) {
        const quota = {error: {message: '  Quota reached.\nKeep the whole diagnostic.  ', code: 'request_quota'}, details: ['first', 'second']};
        const parsed = {choices: [{message: {content: 'Quota recovered.'}}]};
        let selected;
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerRetryAfterRequest() {
                attempts += 1;
                return attempts % 2 === 1 ? selected : response(200, parsed);
            }
        );
        const scenarios = [
            {header: '7', delay: 7000, timers: [7000]},
            {header: '1.5', delay: 1500, timers: [1500]},
            {header: '0', delay: 0, timers: [0]},
            {offset: 17000, delay: 17000, timers: [17000]},
            {offset: -1000, delay: 0, timers: [0]},
            {header: 'The moon has no clocks.', delay: 3000, timers: [3000]},
            {header: '-1', delay: 3000, timers: [3000]},
            {header: 'Infinity', delay: 3000, timers: [3000]},
            {header: '', delay: 3000, timers: [3000]},
            {header: '2147484', delay: 2147484000, timers: [2147483647, 353]}
        ];
        const expectedDelays = [];
        for (const scenario of scenarios) {
            const start = Date.now();
            const header = scenario.offset === undefined
                ? scenario.header : new Date(start + scenario.offset).toUTCString();
            const expectedDelay = scenario.offset === undefined
                ? scenario.delay : Math.max(0, Date.parse(header) - start);
            expectedDelays.push(...(scenario.offset === undefined ? scenario.timers : [expectedDelay]));
            selected = response(429, quota, 'application/json', header);
            const retries = [];
            const result = await fetchRequest(
                {
                    twinKey,
                    model,
                    onRetry(state) {
                        retries.push(state);
                    }
                }
            );
            assert.equal(result, parsed, header);
            assert.equal(Date.now() - start, expectedDelay, header);
            assert.deepEqual(fixture.delays, expectedDelays, header);
            assert.deepEqual(
                retries,
                [
                    {phase: 'waiting', attempt: 1, delayMs: expectedDelay, status: 429, error: quota},
                    {phase: 'requesting', attempt: 1, delayMs: expectedDelay, status: 429, error: quota}
                ],
                header
            );
            assert.equal(retries[0].error, quota, header);
            assert.equal(retries[1].error, quota, header);
        }
        assert.equal(fixture.requests.length, scenarios.length * 2);
    }
);

test(
    'TWiN HTTP 429 exhaustion preserves the complete final quota and releases shared pacing',
    async function exhaustCloudQuotaRecovery(context) {
        const failures = [
            {error: {message: 'First quota diagnostic.', code: 'quota_exceeded'}, details: ['first']},
            {error: {message: 'Second quota diagnostic.', code: 'quota_exceeded'}, details: ['second']},
            {error: {message: 'Third quota diagnostic.', code: 'quota_exceeded'}, details: ['third']},
            {error: {message: '  Final quota diagnostic.\nAll details remain.  ', code: 'quota_exceeded'}, details: ['one', 'two', {remaining: 0}]}
        ];
        const parsed = {choices: [{message: {content: 'A later independent request.'}}]};
        const retries = [];
        let attempts = 0;
        let responses = 0;
        const fixture = runtimeFixture(
            context,
            async function rejectCloudQuotaUntilExhausted() {
                const failure = failures[attempts];
                attempts += 1;
                return failure ? response(429, failure) : response(200, parsed);
            }
        );
        await assert.rejects(
            fetchRequest(
                {
                    twinKey,
                    model,
                    onRetry(state) {
                        retries.push(state);
                    },
                    onResponse() {
                        responses += 1;
                    }
                }
            ),
            function preserveFinalQuota(error) {
                assert.equal(error, failures[3]);
                return true;
            }
        );
        assert.equal(fixture.requests.length, 4);
        assert.equal(responses, 0);
        assert.deepEqual(fixture.delays, [3000, 6000, 12000]);
        assert.equal(retries.length, 6);
        for (let index = 0; index < retries.length; index += 1) {
            assert.equal(retries[index].status, 429);
            assert.equal(retries[index].error, failures[Math.floor(index / 2)]);
        }
        const settledAt = Date.now();
        const result = await fetchRequest(
            {twinKey, model}
        );
        assert.equal(result, parsed);
        assert.equal(fixture.requests[4].at, settledAt);
        assert.deepEqual(fixture.delays, [3000, 6000, 12000]);
    }
);

test(
    'TWiN shares three recovery attempts across quota, Fetch and HTTP 529 failures',
    async function sharedCloudRetryBudget(context) {
        const quota = {error: {message: 'Request quota reached.'}, details: ['Complete quota cause.']};
        const network = new TypeError('Complete transport failure after quota recovery.');
        const overload = {error: {message: 'Complete HTTP 529 failure.'}};
        const final = {error: {message: '  Final quota response.\n', code: 'quota_exceeded'}};
        const retries = [];
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerMixedRecoveryFailures() {
                attempts += 1;
                if (attempts === 1) return response(429, quota);
                if (attempts === 2) throw network;
                if (attempts === 3) return response(529, overload);
                return response(429, final);
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
            function preserveMixedTerminalFailure(error) {
                assert.equal(error, final);
                return true;
            }
        );
        assert.equal(fixture.requests.length, 4);
        assert.deepEqual(fixture.delays, [3000, 3000, 3000]);
        assert.deepEqual(
            retries,
            [
                {phase: 'waiting', attempt: 1, delayMs: 3000, status: 429, error: quota},
                {phase: 'requesting', attempt: 1, delayMs: 3000, status: 429, error: quota},
                {phase: 'waiting', attempt: 2, delayMs: 3000, status: null, error: network},
                {phase: 'requesting', attempt: 2, delayMs: 3000, status: null, error: network},
                {phase: 'waiting', attempt: 3, delayMs: 3000, status: 529, error: overload},
                {phase: 'requesting', attempt: 3, delayMs: 3000, status: 529, error: overload}
            ]
        );
    }
);

test(
    'TWiN concurrent quota responses share cooldown and pace retries and queued initial calls',
    async function sharedCloudQuotaPacing(context) {
        const quota = {error: {message: '  The moon cafeteria exhausted its request quota.\n', code: 'quota_exceeded'}, details: ['Whole provider body.']};
        const counts = new Map();
        const retries = [];
        const queuedPhases = [];
        let queuedRequest;
        const fixture = runtimeFixture(
            context,
            async function answerConcurrentQuota(url, options) {
                const label = JSON.parse(options.body).messages[0].content;
                const count = (counts.get(label) ?? 0) + 1;
                counts.set(label, count);
                return label !== 'queued' && count === 1
                    ? response(429, quota)
                    : response(200, {label});
            }
        );
        const startedAt = Date.now();
        function observeConcurrentRetry(state) {
            retries.push(state);
            if (!queuedRequest && state.phase === 'waiting') {
                queuedRequest = fetchRequest(
                    {
                        twinKey,
                        model,
                        messages: [{role: 'user', content: 'queued'}],
                        onRetry(queuedState) {
                            queuedPhases.push(queuedState);
                        }
                    }
                );
            }
        }
        const first = fetchRequest(
            {twinKey, model, messages: [{role: 'user', content: 'first'}], onRetry: observeConcurrentRetry}
        );
        const second = fetchRequest(
            {twinKey, model, messages: [{role: 'user', content: 'second'}], onRetry: observeConcurrentRetry}
        );
        assert.deepEqual(await Promise.all([first, second]), [{label: 'first'}, {label: 'second'}]);
        assert.deepEqual(await queuedRequest, {label: 'queued'});
        assert.deepEqual(
            fixture.requests.map(
                function quotaDispatchTime(request) {
                    return request.at - startedAt;
                }
            ),
            [0, 0, 3000, 6000, 9000]
        );
        assert.equal(retries.length, 4);
        for (const state of retries) {
            assert.equal(state.attempt, 1);
            assert.equal(state.delayMs, 3000);
            assert.equal(state.status, 429);
            assert.equal(state.error, quota);
        }
        assert.deepEqual(
            queuedPhases,
            [
                {phase: 'waiting', attempt: 0, delayMs: 3000, status: 429, error: quota},
                {phase: 'requesting', attempt: 0, delayMs: 3000, status: 429, error: quota}
            ]
        );
        const settledAt = Date.now();
        await fetchRequest(
            {twinKey, model, messages: [{role: 'user', content: 'queued'}]}
        );
        assert.equal(fixture.requests[5].at, settledAt);
    }
);

test(
    'TWiN a later HTTP 429 extends shared cooldown without duplicating retry observations',
    async function extendedCloudQuotaCooldown(context) {
        const quota = {error: {message: 'A later quota response needs more time.'}};
        const counts = new Map();
        const observations = new Map();
        const fixture = runtimeFixture(
            context,
            async function answerExtendedQuota(url, options) {
                const label = options.body;
                const count = (counts.get(label) ?? 0) + 1;
                counts.set(label, count);
                if (count > 1) return response(200, {label});
                if (label === 'later') {
                    await new Promise(
                        function delayLaterQuota(resolve) {
                            setTimeout(resolve, 2000);
                        }
                    );
                    return response(429, quota, 'application/json', '10');
                }
                return response(429, quota);
            }
        );
        const startedAt = Date.now();
        await Promise.all(
            ['first', 'later'].map(
                function requestExtendedQuota(label) {
                    const phases = [];
                    observations.set(label, phases);
                    return fetchHTTPResponse(
                        destination,
                        {headers: {Authorization: `Bearer ${twinKey}`}, body: label},
                        {
                            onRetry(state) {
                                phases.push(state);
                            }
                        }
                    );
                }
            )
        );
        assert.deepEqual(
            fixture.requests.map(
                function extendedQuotaDispatchTime(request) {
                    return request.at - startedAt;
                }
            ),
            [0, 0, 12000, 15000]
        );
        for (const [label, phases] of observations) {
            assert.deepEqual(
                phases,
                [
                    {phase: 'waiting', attempt: 1, delayMs: label === 'first' ? 3000 : 10000, status: 429, error: quota},
                    {phase: 'requesting', attempt: 1, delayMs: label === 'first' ? 3000 : 10000, status: 429, error: quota}
                ]
            );
        }
    }
);

test(
    'TWiN quota cooldown keeps different endpoints and credentials independent',
    async function independentCloudQuotaGroups(context) {
        const quota = {error: {message: 'Only one endpoint and credential reached quota.'}};
        const firstOptions = {headers: {Authorization: `Bearer ${twinKey}`}, body: 'first'};
        const otherOptions = {headers: {Authorization: 'Bearer synthetic-other-key'}, body: 'other'};
        const otherDestination = 'https://inference.do-ai.run/v1/systemone';
        const independent = [];
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerIndependentQuotaGroup(url, options) {
                if (url === destination && options.body === firstOptions.body) {
                    attempts += 1;
                    if (attempts === 1) return response(429, quota, 'application/json', '11');
                }
                return response(200, {complete: true});
            }
        );
        const startedAt = Date.now();
        await fetchHTTPResponse(
            destination,
            firstOptions,
            {
                onRetry(state) {
                    if (state.phase === 'waiting') {
                        independent.push(fetchHTTPResponse(destination, otherOptions));
                        independent.push(fetchHTTPResponse(otherDestination, firstOptions));
                    }
                }
            }
        );
        await Promise.all(independent);
        assert.deepEqual(
            fixture.requests.map(
                function independentDispatch(request) {
                    return [request.url, request.options.body, request.options.headers.get('authorization'), request.at - startedAt];
                }
            ),
            [
                [destination, 'first', `Bearer ${twinKey}`, 0],
                [destination, 'other', 'Bearer synthetic-other-key', 0],
                [otherDestination, 'first', `Bearer ${twinKey}`, 0],
                [destination, 'first', `Bearer ${twinKey}`, 11000]
            ]
        );
    }
);

test(
    'TWiN preserves one-shot iterable headers throughout quota recovery',
    async function preserveIterableCloudHeaders(context) {
        const quota = {error: {message: 'The lunar kitchen reached quota.'}};
        const body = '  Keep the complete lunar order.\n  ';
        let headerIterations = 0;
        let attempts = 0;
        function* requestHeaders() {
            headerIterations += 1;
            yield ['Authorization', `Bearer ${twinKey}`];
            yield ['X-Lunar-Order', 'moon-cafeteria'];
        }
        const headers = requestHeaders();
        const controller = new AbortController();
        const fixture = runtimeFixture(
            context,
            async function answerIterableHeaderRequest() {
                attempts += 1;
                return attempts === 1 ? response(429, quota) : response(200, {complete: true});
            }
        );
        const result = await fetchHTTPResponse(
            destination,
            {method: 'POST', headers, body, signal: controller.signal}
        );
        assert.equal(result.status, 200);
        assert.equal(headerIterations, 1);
        assert.equal(fixture.requests.length, 2);
        for (const request of fixture.requests) {
            assert.equal(request.options.headers.get('authorization'), `Bearer ${twinKey}`);
            assert.equal(request.options.headers.get('x-lunar-order'), 'moon-cafeteria');
            assert.equal(request.options.headers, fixture.requests[0].options.headers);
            assert.equal(request.options.method, 'POST');
            assert.equal(request.options.body, body);
            assert.equal(request.options.signal, controller.signal);
        }
        assert.deepEqual(fixture.delays, [3000]);
    }
);

test(
    'TWiN an exhausted quota request extends active siblings by the final twelve-second fallback',
    async function preserveTerminalQuotaCooldown(context) {
        const quota = {error: {message: 'Complete terminal quota diagnostic.'}};
        const headers = {Authorization: `Bearer ${twinKey}`};
        let attempts = 0;
        let sibling;
        const fixture = runtimeFixture(
            context,
            async function answerTerminalQuotaGroup(url, options) {
                if (options.body === 'sibling') return response(200, {complete: true});
                attempts += 1;
                if (attempts === 4) {
                    sibling = fetchHTTPResponse(destination, {headers, body: 'sibling'});
                }
                return response(429, quota);
            }
        );
        const startedAt = Date.now();
        await assert.rejects(
            fetchHTTPResponse(destination, {headers, body: 'exhausted'}),
            function preserveTerminalQuota(error) {
                assert.equal(error, quota);
                return true;
            }
        );
        assert.equal((await sibling).status, 200);
        assert.deepEqual(
            fixture.requests.map(
                function terminalQuotaDispatch(request) {
                    return [request.options.body, request.at - startedAt];
                }
            ),
            [['exhausted', 0], ['exhausted', 3000], ['exhausted', 9000], ['exhausted', 21000], ['sibling', 33000]]
        );
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

for (const status of [429, 529]) {
    test(
        `TWiN retries HTTP ${status} malformed JSON and failed diagnostic reads with the original failures`,
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
                            ...response(status, null),
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
                            ...response(status, null, 'text/plain'),
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
                    {phase: 'waiting', attempt: 1, delayMs: 3000, status, error: parsingError},
                    {phase: 'requesting', attempt: 1, delayMs: 3000, status, error: parsingError},
                    {phase: 'waiting', attempt: 2, delayMs: status === 429 ? 6000 : 3000, status, error: bodyReadError},
                    {phase: 'requesting', attempt: 2, delayMs: status === 429 ? 6000 : 3000, status, error: bodyReadError}
                ]
            );
            assert.equal(fixture.requests.length, 3);
            assert.deepEqual(
                fixture.delays,
                status === 429 ? [3000, 6000] : [3000, 3000]
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
        `TWiN exhausts HTTP ${status} diagnostic retries with the exact final reading failure`,
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
                        ...response(status, null, 'text/plain'),
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
                status === 429 ? [3000, 6000, 12000] : [3000, 3000, 3000]
            );
            assert.equal(retries.length, 6);
            for (let index = 0; index < retries.length; index += 1) {
                assert.equal(retries[index].status, status);
                assert.equal(retries[index].error, failures[Math.floor(index / 2)]);
            }
        }
    );

    test(
        `TWiN cancellation during HTTP ${status} diagnostic reading prevents retries`,
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
                        ...response(status, null, contentType),
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
}

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
        for (const status of [400, 413, 503]) {
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
        assert.equal(fixture.requests.length, 6);
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
    'TWiN preserves ordinary HTTP failures without retrying or reporting a response',
    async function cloudOrdinaryFailures(context) {
        const failures = [
            response(
                400,
                {error: {message: 'Complete malformed request.', detail: ['complete', 'error']}}
            ),
            response(
                413,
                {error: {message: 'Complete provider input-capacity failure.', detail: ['complete', 'error']}}
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
    'TWiN abort during Retry-After cancels recovery and releases quota pacing',
    async function abortCloudRetry(context) {
        const controller = new AbortController();
        let quotaActive = true;
        const parsed = {choices: [{message: {content: 'A fresh operation after cancellation.'}}]};
        const fixture = runtimeFixture(
            context,
            async function answerOverloadBeforeAbort() {
                if (!quotaActive) return response(200, parsed);
                return response(
                    429,
                    {error: {message: 'The request quota is exhausted.'}},
                    'application/json',
                    '90'
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
        assert.deepEqual(fixture.delays, [90000]);
        quotaActive = false;
        const cancelledAt = Date.now();
        assert.equal(
            await fetchRequest(
                {twinKey, model}
            ),
            parsed
        );
        assert.equal(fixture.requests[1].at, cancelledAt);
        assert.deepEqual(fixture.delays, [90000]);
    }
);

test(
    'TWiN aborting a queued initial call preserves the active request and cancels its own dispatch',
    async function abortQueuedCloudQuotaCall(context) {
        const quota = {error: {message: 'Wait for the moon cafeteria quota.'}};
        const queuedController = new AbortController();
        const queuedPhases = [];
        let queuedResult;
        let attempts = 0;
        const fixture = runtimeFixture(
            context,
            async function answerBeforeQueuedAbort() {
                attempts += 1;
                return attempts === 1 ? response(429, quota) : response(200, {complete: true});
            }
        );
        const result = await fetchRequest(
            {
                twinKey,
                model,
                onRetry(state) {
                    if (state.phase !== 'waiting') return;
                    queuedResult = assert.rejects(
                        fetchRequest(
                            {
                                twinKey,
                                model,
                                signal: queuedController.signal,
                                onRetry(queuedState) {
                                    queuedPhases.push(queuedState);
                                    queuedController.abort('The queued operation was cancelled.');
                                },
                                onResponse() {
                                    assert.fail('A cancelled queued operation cannot publish a response.');
                                }
                            }
                        ),
                        requestAborted
                    );
                }
            }
        );
        await queuedResult;
        assert.deepEqual(result, {complete: true});
        assert.equal(fixture.requests.length, 2);
        assert.deepEqual(
            queuedPhases,
            [{phase: 'waiting', attempt: 0, delayMs: 3000, status: 429, error: quota}]
        );
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
