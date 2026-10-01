import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {generateImages} from '../browser-runtime/ai/twin-cloud.mjs';

const twinKey = 'synthetic-image-fixture-key';
const synchronousModel = 'stable-diffusion-3.5-large';
const asynchronousModel = 'fal-ai/flux/schnell';
const synchronousURL = 'https://inference.do-ai.run/v1/images/generations';
const asynchronousURL = 'https://inference.do-ai.run/v1/async-invoke';
const mediaURL = 'https://media.example.test/moon-toaster.png';
const prompt = '  A moon-powered toaster launches breakfast.\nKeep the purple craters. 🥐  ';

function response(status, content, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers({'content-type': 'application/json', ...headers}),
        async json() {return content;},
        async text() {return content;}
    };
}

function runtimeFixture(context, answer) {
    const previousFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async function syntheticImageFetch(url, options) {
        requests.push({url, options});
        return answer(url, options);
    };
    context.after(function restoreImageFetch() {globalThis.fetch = previousFetch;});
    return requests;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function retainSettlement(accept, fail) {
        resolve = accept;
        reject = fail;
    });
    return {promise, resolve, reject};
}

function requestAborted(error) {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'ARCANE_AI_REQUEST_ABORTED');
    return true;
}

test('TWiN images preserve the explicit synchronous payload and every returned image', async function completeImages(context) {
    const parameters = {
        n: 3,
        size: '1024x1024',
        output_format: 'png',
        response_format: 'b64_json',
        extension: {complete: ['first', 'second']}
    };
    const originalParameters = structuredClone(parameters);
    const contents = ['First complete synthetic image.', 'Second complete synthetic image.', 'Third complete synthetic image.'];
    const parsed = {
        created: 42,
        data: contents.map(function imageData(content) {return {b64_json: btoa(content)};}),
        usage: {complete: ['provider', 'diagnostics']}
    };
    const requests = runtimeFixture(context, async function answerImages() {return response(200, parsed);});
    const observations = [];
    const progress = [];
    const result = await generateImages({
        model: synchronousModel,
        prompt,
        parameters,
        twinKey,
        id: 'moon-breakfast',
        onRequest(request, id, metadata) {
            observations.push('request');
            assert.deepEqual(request, {...originalParameters, model: synchronousModel, prompt});
            assert.equal(id, 'moon-breakfast');
            assert.deepEqual(metadata, {operation: 'images', transport: 'http', destination: synchronousURL});
            assert.equal(Object.hasOwn(request, 'twinKey'), false);
            // Diagnostic observers do not replace the caller's serialized request.
            request.prompt = 'A diagnostic-only edit.';
        },
        onResponse(value, id, streaming) {
            observations.push('response');
            assert.equal(value, parsed);
            assert.equal(id, 'moon-breakfast');
            assert.equal(streaming, false);
            value.data[0].b64_json = btoa('A diagnostic-only response edit.');
        },
        onProgress(state) {progress.push(state);}
    });
    assert.deepEqual(observations, ['request', 'response']);
    assert.deepEqual(progress.map(function stage(state) {return state.stage;}), ['credentials', 'requesting', 'downloading', 'complete']);
    for (const state of progress) {
        assert.deepEqual(state, {stage: state.stage, model: synchronousModel, id: 'moon-breakfast'});
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, synchronousURL);
    assert.equal(requests[0].options.method, 'POST');
    assert.equal(requests[0].options.credentials, 'omit');
    assert.equal(new Headers(requests[0].options.headers).get('authorization'), `Bearer ${twinKey}`);
    assert.deepEqual(JSON.parse(requests[0].options.body), {...originalParameters, model: synchronousModel, prompt});
    assert.deepEqual(parameters, originalParameters);
    assert.equal(result.images.length, contents.length);
    for (const [index, image] of result.images.entries()) {
        assert.ok(image.blob instanceof Blob);
        assert.equal(image.mediaType, 'image/png');
        assert.equal(await image.blob.text(), contents[index]);
        assert.equal(Object.hasOwn(image, 'width'), false);
        assert.equal(Object.hasOwn(image, 'height'), false);
    }
});

test('TWiN FAL images follow status and result routes and download all media without inference credentials', async function asyncImages(context) {
    const firstURL = 'https://media.example.test/first.jpg';
    const secondURL = 'https://media.example.test/second.webp';
    const requestId = 'moon/request';
    const parsed = {
        request_id: requestId,
        model_id: asynchronousModel,
        status: 'COMPLETED',
        output: {images: [
            {url: firstURL, content_type: 'image/jpeg', width: 1024, height: 768},
            {url: secondURL, content_type: 'image/webp', width: 768, height: 1024}
        ]}
    };
    let statusCalls = 0;
    let credentialCalls = 0;
    const progress = [];
    const observed = [];
    const requests = runtimeFixture(context, async function answerAsyncImages(url, options) {
        if (url === asynchronousURL) return response(202, {request_id: requestId, status: 'QUEUED'}, {'retry-after': '0'});
        if (url === `${asynchronousURL}/moon%2Frequest/status`) {
            statusCalls += 1;
            return response(200, {request_id: requestId, status: statusCalls === 1 ? 'IN_PROGRESS' : 'COMPLETED'}, {'retry-after': '0'});
        }
        if (url === `${asynchronousURL}/moon%2Frequest`) return response(200, parsed);
        assert.equal(options.credentials, 'omit');
        assert.equal(Object.hasOwn(options, 'headers'), false);
        return {
            ...response(200, null),
            async blob() {return new Blob([url], {type: url === firstURL ? 'image/jpeg' : 'image/webp'});}
        };
    });
    const parameters = {num_images: 2, image_size: {width: 1024, height: 768}, seed: 0};
    const result = await generateImages({
        model: asynchronousModel,
        prompt,
        parameters,
        async getApiKey() {credentialCalls += 1; return twinKey;},
        onResponse(value) {observed.push(value);},
        onProgress(value) {progress.push(value);}
    });
    assert.equal(credentialCalls, 1);
    assert.deepEqual(JSON.parse(requests[0].options.body), {model_id: asynchronousModel, input: {...parameters, prompt}});
    assert.deepEqual(requests.map(function destination(request) {return request.url;}), [
        asynchronousURL,
        `${asynchronousURL}/moon%2Frequest/status`,
        `${asynchronousURL}/moon%2Frequest/status`,
        `${asynchronousURL}/moon%2Frequest`,
        firstURL,
        secondURL
    ]);
    for (const request of requests.filter(function inferenceRequest(request) {return request.url.startsWith(asynchronousURL);})) {
        assert.equal(request.options.method, request.url === asynchronousURL ? 'POST' : 'GET');
        assert.equal(new Headers(request.options.headers).get('authorization'), `Bearer ${twinKey}`);
    }
    assert.deepEqual(observed, [parsed]);
    assert.deepEqual(progress.map(function stage(value) {return value.stage;}), ['credentials', 'requesting', 'queued', 'generating', 'downloading', 'complete']);
    assert.deepEqual(result.images.map(function dimensions(image) {return [image.mediaType, image.width, image.height];}), [
        ['image/jpeg', 1024, 768], ['image/webp', 768, 1024]
    ]);
    assert.deepEqual(await Promise.all(result.images.map(function content(image) {return image.blob.text();})), [firstURL, secondURL]);
});

test('TWiN FAL accepts an immediately completed response without polling', async function immediateImages(context) {
    const requests = runtimeFixture(context, async function answerImmediateImages() {
        return response(200, {
            status: 'COMPLETED',
            output: {images: [{b64_json: btoa('Complete immediate image.'), content_type: 'image/webp'}]}
        });
    });
    const result = await generateImages({model: asynchronousModel, prompt, twinKey});
    assert.equal(requests.length, 1);
    assert.equal(result.images[0].mediaType, 'image/webp');
    assert.equal(await result.images[0].blob.text(), 'Complete immediate image.');
});

test('TWiN image submissions do not retry paid requests or replace complete failures', async function imageSubmissionFailures(context) {
    const networkError = new TypeError('The accepted submission lost its response.');
    const bodyError = new SyntaxError('The response body is unreadable.');
    const providerError = {id: 'rate_limit', message: 'Complete provider detail.', request_id: 'moon-job'};
    const plainError = 'Complete plain provider failure.\nSecond line.';
    const replies = [
        function failedFetch() {throw networkError;},
        function failedBody() {return {...response(200, null), async json() {throw bodyError;}};},
        function failedJSON() {return response(429, providerError);},
        function failedText() {return response(500, plainError, {'content-type': 'text/plain'});}
    ];
    const requests = runtimeFixture(context, async function rejectImageSubmission() {return replies.shift()();});
    for (const failure of [networkError, bodyError, providerError, plainError]) {
        await assert.rejects(generateImages({model: synchronousModel, prompt, twinKey}), function originalFailure(error) {
            assert.equal(error, failure);
            return true;
        });
    }
    assert.equal(requests.length, 4);
});

test('TWiN image model routing and reserved fields are explicit with no credential fallback over a supplied key', async function imageInputs(context) {
    const requests = runtimeFixture(context, async function unexpectedImageFetch() {assert.fail('Invalid image inputs must not submit.');});
    for (const model of [undefined, 'a-caller-display-label']) {
        await assert.rejects(generateImages({model, prompt, twinKey}), {code: 'ARCANE_AI_IMAGE_MODEL_UNSUPPORTED'});
    }
    for (const parameters of [{prompt: 'Another prompt'}, {model: 'Another model'}, null, []]) {
        await assert.rejects(generateImages({model: synchronousModel, prompt, twinKey, parameters}), TypeError);
    }
    await assert.rejects(generateImages({model: synchronousModel, prompt: undefined, twinKey}), TypeError);
    await assert.rejects(generateImages({model: synchronousModel, prompt}), {code: 'AI_PROVIDER_NOT_CONFIGURED'});
    await assert.rejects(generateImages({
        model: synchronousModel,
        prompt,
        twinKey: '',
        getApiKey() {assert.fail('An explicitly supplied key must not be replaced.');}
    }), {code: 'AI_PROVIDER_NOT_CONFIGURED'});
    assert.equal(requests.length, 0);
});

test('TWiN image job errors retain the complete provider result as their cause', async function imageJobErrors(context) {
    const failed = {request_id: 'failed-job', status: 'FAILED', error: {message: 'Complete failure.', details: ['all', 'details']}};
    const missingId = {status: 'QUEUED'};
    const unknownStatus = {request_id: 'unknown-job', status: 'UNKNOWN'};
    const missingImages = {request_id: 'empty-job', status: 'COMPLETED', output: {other: 'Complete unexpected result.'}};
    const replies = [failed, missingId, unknownStatus, missingImages, missingImages];
    const requests = runtimeFixture(context, async function answerMalformedJob() {return response(200, replies.shift());});
    for (const value of [failed, missingId, unknownStatus, missingImages]) {
        await assert.rejects(generateImages({model: asynchronousModel, prompt, twinKey}), function originalJobFailure(error) {
            assert.equal(error.code, 'ARCANE_AI_INVALID_PROVIDER_RESULT');
            assert.equal(error.cause, value);
            return true;
        });
    }
    assert.equal(requests.length, 5);
});

test('TWiN image download errors reject the operation without returning partial images', async function imageDownloadFailure(context) {
    const downloadError = {message: 'Complete media download failure.'};
    const requests = runtimeFixture(context, async function answerMissingMedia(url) {
        if (url === synchronousURL) return response(200, {data: [{url: mediaURL}, {b64_json: btoa('Another complete image.')}]});
        return response(403, downloadError);
    });
    await assert.rejects(generateImages({model: synchronousModel, prompt, twinKey}), function originalDownloadFailure(error) {
        assert.equal(error, downloadError);
        return true;
    });
    assert.equal(requests.length, 2);
    assert.equal(Object.hasOwn(requests[1].options, 'headers'), false);
});

test('TWiN image diagnostic callback failures remain original and never repeat submissions', async function imageObserverFailures(context) {
    const requestError = new Error('The request observer failed.');
    const responseError = new Error('The response observer failed.');
    const requests = runtimeFixture(context, async function answerBeforeObserverFailure() {
        return response(200, {data: [{url: mediaURL}]});
    });
    await assert.rejects(generateImages({
        model: synchronousModel,
        prompt,
        twinKey,
        onRequest() {throw requestError;}
    }), function originalRequestObserverFailure(error) {return error === requestError;});
    assert.equal(requests.length, 0);
    await assert.rejects(generateImages({
        model: synchronousModel,
        prompt,
        twinKey,
        onResponse() {throw responseError;}
    }), function originalResponseObserverFailure(error) {return error === responseError;});
    assert.equal(requests.length, 1);
});

test('TWiN images do not infer missing media metadata or retain earlier calls', async function independentImages(context) {
    const requests = runtimeFixture(context, async function answerIndependentImages() {
        return response(200, {data: [{b64_json: btoa('Complete image with no declared format.')}]});
    });
    const first = await generateImages({model: synchronousModel, prompt, twinKey});
    await generateImages({model: synchronousModel, prompt: '', twinKey});
    assert.equal(first.images[0].mediaType, 'application/octet-stream');
    assert.deepEqual(JSON.parse(requests[1].options.body), {model: synchronousModel, prompt: ''});
});

test('TWiN image pre-cancellation starts no credentials, callbacks, or request', async function preCancelledImages(context) {
    const controller = new AbortController();
    controller.abort('The page detached.');
    const requests = runtimeFixture(context, async function unexpectedCancelledFetch() {assert.fail('No cancelled request.');});
    await assert.rejects(generateImages({
        model: synchronousModel,
        prompt,
        signal: controller.signal,
        getApiKey() {assert.fail('No cancelled credential lookup.');},
        onRequest() {assert.fail('No cancelled request callback.');},
        onProgress() {assert.fail('No cancelled progress callback.');}
    }), requestAborted);
    assert.equal(requests.length, 0);
});

for (const boundary of ['credentials', 'onRequest', 'fetch', 'json', 'onResponse', 'media', 'blob', 'complete']) {
    test(`TWiN image cancellation settles an uncooperative ${boundary} wait and ignores its late result`, async function cancelledImageBoundary(context) {
        const controller = new AbortController();
        const entered = deferred();
        const pending = deferred();
        const events = [];
        const parsed = {data: [{url: mediaURL}]};
        function pause() {entered.resolve(); return pending.promise;}
        const requests = runtimeFixture(context, async function answerCancellableImage(url) {
            if (url === synchronousURL) {
                if (boundary === 'fetch') return pause();
                return {...response(200, parsed), json() {return boundary === 'json' ? pause() : parsed;}};
            }
            if (boundary === 'media') return pause();
            return {...response(200, null), blob() {return boundary === 'blob' ? pause() : new Blob(['Complete image.'], {type: 'image/png'});}};
        });
        const operation = generateImages({
            model: synchronousModel,
            prompt,
            signal: controller.signal,
            getApiKey() {return boundary === 'credentials' ? pause() : twinKey;},
            onRequest() {events.push('request'); if (boundary === 'onRequest') return pause();},
            onResponse() {events.push('response'); if (boundary === 'onResponse') return pause();},
            onProgress(state) {events.push(state.stage); if (boundary === 'complete' && state.stage === 'complete') return pause();}
        });
        const rejected = assert.rejects(operation, requestAborted);
        await entered.promise;
        controller.abort(`Cancelled at ${boundary}.`);
        await rejected;
        const settledEvents = [...events];
        const settledRequests = [...requests];
        pending.resolve(boundary === 'fetch' ? response(200, parsed) : parsed);
        await Promise.resolve();
        await Promise.resolve();
        assert.deepEqual(events, settledEvents);
        assert.deepEqual(requests, settledRequests);
        for (const request of requests) assert.equal(request.options.signal.aborted, true);
    });
}

test('TWiN image cancellation clears the pending poll timer without another request', async function cancelImagePoll(context) {
    const controller = new AbortController();
    const entered = deferred();
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const timer = {cleared: false};
    globalThis.setTimeout = function retainImagePoll(callback, milliseconds, ...arguments_) {
        if (milliseconds !== 1000) return previousSetTimeout(callback, milliseconds, ...arguments_);
        entered.resolve();
        return timer;
    };
    globalThis.clearTimeout = function clearImagePoll(value) {
        if (value === timer) timer.cleared = true;
        else previousClearTimeout(value);
    };
    context.after(function restoreImageTimers() {
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    });
    const requests = runtimeFixture(context, async function answerQueuedImage() {return response(202, {request_id: 'queued-job', status: 'QUEUED'});});
    const operation = generateImages({model: asynchronousModel, prompt, twinKey, signal: controller.signal});
    const rejected = assert.rejects(operation, requestAborted);
    await entered.promise;
    controller.abort('The page detached during polling.');
    await rejected;
    assert.equal(timer.cleared, true);
    assert.equal(requests.length, 1);
});
