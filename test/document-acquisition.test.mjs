import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import test from '../src/testing.mjs';
import {createDocumentAcquisitionService} from '../src/core/services/document-acquisition.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {createCoreRuntimeConnection} from '../src/core/runtime-connection.mjs';
import {createCoreClient} from '../browser-runtime/core/client.mjs';
import {acquireCoreDocument} from '../browser-runtime/document-acquisition.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(resolvePromise) {
        resolve = resolvePromise;
    });
    return {promise, resolve};
}

function response(url, body, options) {
    const result = new Response(body, options);
    Object.defineProperty(result, 'url', {value: url});
    return result;
}

function fixture(t, selectedFetch, options, beforeClose) {
    const originalFetch = globalThis.fetch;
    const service = createDocumentAcquisitionService(options);
    globalThis.fetch = selectedFetch;
    t.after(async function closeFixture() {
        try {
            await beforeClose?.();
            await service.dispose();
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
    return service;
}

function wireClient(t, runtime, requestId) {
    const frames = [];
    const errors = [];
    let receive;
    const connection = createCoreRuntimeConnection({
        runtime,
        preserveContextRequestId: false,
        send(frame) {
            const encoded = JSON.stringify(frame);
            frames.push(JSON.parse(encoded));
            receive?.(encoded);
        }
    });
    const client = createCoreClient({
        global: {crypto: {randomUUID() { return requestId; }}},
        onError(error) { errors.push(error); },
        transport: {
            name: 'fixture',
            send(frame) { return connection.handle(JSON.parse(JSON.stringify(frame))); },
            subscribe(listener) {
                receive = listener;
                return function unsubscribe() { receive = null; };
            }
        }
    });
    t.after(async function closeClient() {
        client.close();
        await connection.close();
    });
    return {client, frames, errors};
}

test('ordinary acquisition retains complete binary content and actual Fetch metadata without a predicate', async function ordinaryDocument(t) {
    const url = 'https://documents.invalid/lunar-cheese?edition=whole';
    const body = Buffer.from([0, 255, 13, 10, 128, 65, 0]);
    const headers = {'Content-Type': 'application/pdf', 'X-Source-Edition': '  complete  '};
    const received = response(url, body, {headers});
    const calls = [];
    const service = fixture(t, async function getDocument(requestUrl, options) {
        calls.push({requestUrl, options});
        return received;
    });
    const progress = [];
    const document = await service.acquire({url, onProgress(event) { progress.push(event); }});
    assert.equal(document.requestedUrl, url);
    assert.equal(document.finalUrl, received.url);
    assert.equal(document.url, received.url);
    assert.equal(document.ok, true);
    assert.equal(document.status, received.status);
    assert.equal(document.statusText, received.statusText);
    assert.equal(document.complete, true);
    assert.deepEqual(document.headers, Array.from(received.headers.entries()));
    assert.equal(document.mediaType, received.headers.get('content-type'));
    assert.deepEqual(document.body, body);
    assert.deepEqual(document.redirects, []);
    assert.equal(calls[0].requestUrl, url);
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.redirect, 'manual');
    assert.deepEqual(progress.map(function phase(event) { return event.phase; }), ['accepted', 'destination', 'request', 'response', 'complete']);
    assert.deepEqual(progress.at(-1), {phase: 'complete', completed: 1, total: 1, unit: 'documents', requestedUrl: url, url});
});

test('each supported redirect awaits the application predicate and retains its original response', async function redirectDecisions(t) {
    const statuses = [301, 302, 303, 307, 308];
    const entered = deferred();
    const permission = deferred();
    const order = [];
    const bodies = statuses.map(function originalRedirect(status) { return Buffer.from(`  Complete ${status} dispatch.\r\n🧀  `); });
    const service = fixture(t, async function getRedirect(url, options) {
        order.push(['request', url]);
        assert.equal(options.redirect, 'manual');
        const index = Number(new URL(url).pathname.substring(1));
        return index < statuses.length
            ? response(url, bodies[index], {status: statuses[index], headers: {Location: `/${index + 1}`}})
            : response(url, Buffer.from([255, 0, 1]));
    }, {
        async destinationPredicate(url, context) {
            order.push(['predicate', url]);
            assert.equal(context.requestedUrl, 'https://documents.invalid/0');
            assert.equal(context.previousUrl, url.endsWith('/0') ? null : `https://documents.invalid/${Number(new URL(url).pathname.substring(1)) - 1}`);
            if (url.endsWith('/1')) {
                entered.resolve();
                await permission.promise;
            }
            return true;
        }
    }, function releaseDecision() { permission.resolve(); });
    const acquisition = service.acquire({url: 'https://documents.invalid/0'});
    await entered.promise;
    assert.deepEqual(order, [
        ['predicate', 'https://documents.invalid/0'],
        ['request', 'https://documents.invalid/0'],
        ['predicate', 'https://documents.invalid/1']
    ]);
    permission.resolve();
    const document = await acquisition;
    assert.equal(document.finalUrl, 'https://documents.invalid/5');
    assert.deepEqual(document.body, Buffer.from([255, 0, 1]));
    assert.deepEqual(document.redirects.map(function status(record) { return record.status; }), statuses);
    for (const [index, record] of document.redirects.entries()) {
        assert.deepEqual(record.body, bodies[index]);
        assert.equal(record.complete, true);
    }
    assert.deepEqual(order, Array.from({length: 6}, function requestPair(unused, index) {
        return [['predicate', `https://documents.invalid/${index}`], ['request', `https://documents.invalid/${index}`]];
    }).flat());
});

test('HTTP failures and redirects without Location return their complete entity bodies', async function completeHttpResponses(t) {
    const body = Buffer.from('  Entire unavailable octopus ledger.\r\n最後の行\u0000  ');
    const service = fixture(t, async function getFailure(url) {
        return response(url, body, {status: Number(new URL(url).pathname.substring(1)), statusText: 'Complete source status'});
    });
    for (const status of [503, 302]) {
        const document = await service.acquire({url: `https://documents.invalid/${status}`});
        assert.equal(document.status, status);
        assert.equal(document.statusText, 'Complete source status');
        assert.equal(document.ok, false);
        assert.equal(document.complete, true);
        assert.deepEqual(document.body, body);
        assert.deepEqual(document.redirects, []);
    }
});

test('declined destinations make no request and preserve preceding redirect evidence', async function declinedDestination(t) {
    const calls = [];
    const body = Buffer.from([0, 254, 13, 10]);
    const service = fixture(t, async function firstRedirect(url) {
        calls.push(url);
        return response(url, body, {status: 307, headers: {Location: '/declined'}});
    }, {destinationPredicate(url) { return !url.endsWith('/declined'); }});
    await assert.rejects(service.acquire({url: 'https://documents.invalid/start'}), function declined(error) {
        assert.equal(error.code, 'DOCUMENT_DESTINATION_DECLINED');
        assert.equal(error.documentAcquisition.requestUrl, 'https://documents.invalid/declined');
        assert.deepEqual(error.documentAcquisition.redirects[0].body, body);
        return true;
    });
    await assert.rejects(service.acquire({url: 'https://documents.invalid/declined'}), {code: 'DOCUMENT_DESTINATION_DECLINED'});
    assert.deepEqual(calls, ['https://documents.invalid/start']);
});

test('predicate failures preserve the exact original error and cancellation prevents the next request', async function predicateLifetime(t) {
    const entered = deferred();
    const finish = deferred();
    const controller = new AbortController();
    const original = new Error('  Complete source decision failure.\n月  ');
    original.detail = {complete: 'The entire native decision detail.'};
    const calls = [];
    const service = fixture(t, async function unusedFetch(url) { calls.push(url); }, {
        async destinationPredicate(url) {
            if (url.endsWith('/failure')) throw original;
            entered.resolve();
            await finish.promise;
            return true;
        }
    }, function finishPredicate() { finish.resolve(); });
    await assert.rejects(service.acquire({url: 'https://documents.invalid/failure'}), function originalError(error) {
        assert.equal(error.cause, original);
        assert.deepEqual(error.detail, original.detail);
        return true;
    });
    const acquisition = service.acquire({url: 'https://documents.invalid/wait', signal: controller.signal});
    const rejected = assert.rejects(acquisition, function originalCancellation(error) { return error.cause === original; });
    await entered.promise;
    controller.abort(original);
    finish.resolve();
    await rejected;
    assert.deepEqual(calls, []);
});

test('an interrupted response retains every delivered chunk and the original read error', async function interruptedResponse(t) {
    const original = new Error('  Complete body stream failure.\nDo not replace this message.  ');
    const content = Buffer.from([0, 255, 128, 13, 10]);
    let delivered = false;
    const service = fixture(t, async function failingBody(url) {
        return response(url, new ReadableStream({
            pull(controller) {
                if (!delivered) {
                    delivered = true;
                    controller.enqueue(content);
                } else controller.error(original);
            }
        }));
    });
    await assert.rejects(service.acquire({url: 'https://documents.invalid/interrupted'}), function retainedBody(error) {
        // Cancelling an already errored reader may report that same stream error again.
        const cause = error.cause instanceof AggregateError ? error.cause.cause : error.cause;
        assert.equal(cause, original);
        assert.equal(error.documentAcquisition.response.complete, false);
        assert.deepEqual(error.documentAcquisition.response.body, content);
        return true;
    });
});

test('service disposal aborts concurrent requests and joins their fetch cleanup', async function concurrentDisposal(t) {
    const started = deferred();
    const aborted = deferred();
    const finish = deferred();
    const calls = [];
    const cancellations = [];
    const service = fixture(t, function pendingFetch(url, {signal}) {
        calls.push(url);
        if (calls.length === 2) started.resolve();
        return new Promise(function pending(resolve, reject) {
            signal.addEventListener('abort', function abortFetch() {
                cancellations.push(url);
                if (cancellations.length === 2) aborted.resolve();
                finish.promise.then(function completeCleanup() { reject(signal.reason); });
            }, {once: true});
        });
    }, undefined, function finishCleanup() { finish.resolve(); });
    const first = service.acquire({url: 'https://documents.invalid/first'});
    const second = service.acquire({url: 'https://documents.invalid/second'});
    const rejected = Promise.all([
        assert.rejects(first, {code: 'DOCUMENT_ACQUISITION_CLOSED'}),
        assert.rejects(second, {code: 'DOCUMENT_ACQUISITION_CLOSED'})
    ]);
    await started.promise;
    let closed = false;
    const closing = service.dispose();
    assert.equal(service.dispose(), closing);
    const observed = closing.then(function closedService() { closed = true; });
    await aborted.promise;
    assert.equal(closed, false);
    finish.resolve();
    await rejected;
    await observed;
    await assert.rejects(service.acquire({url: 'https://documents.invalid/after-close'}), {code: 'DOCUMENT_ACQUISITION_CLOSED'});
    assert.deepEqual(calls, ['https://documents.invalid/first', 'https://documents.invalid/second']);
});

test('one request cancellation joins its reader while an independent document completes', async function independentCancellation(t) {
    const entered = deferred();
    const cancelled = deferred();
    const finish = deferred();
    const controller = new AbortController();
    const original = new Error('Cancel only the first document.');
    const sibling = Buffer.from('  Complete sibling document.\r\n🦑  ');
    const service = fixture(t, async function documents(url) {
        if (url.endsWith('/sibling')) return response(url, sibling);
        return response(url, new ReadableStream({
            start() { entered.resolve(); },
            cancel(reason) {
                assert.equal(reason, original);
                cancelled.resolve();
                return finish.promise;
            }
        }));
    }, undefined, function finishReaderCleanup() { finish.resolve(); });
    const first = service.acquire({url: 'https://documents.invalid/pending', signal: controller.signal});
    let settled = false;
    const rejected = assert.rejects(first, function cancelledRequest(error) { return error.cause === original; });
    const observed = rejected.then(function requestSettled() { settled = true; });
    await entered.promise;
    controller.abort(original);
    await cancelled.promise;
    assert.equal(settled, false);
    const second = await service.acquire({url: 'https://documents.invalid/sibling'});
    assert.deepEqual(second.body, sibling);
    finish.resolve();
    await observed;
});

test('Core transport restores complete browser Blobs and isolates equal client request IDs', async function browserTransport(t) {
    const firstEntered = deferred();
    const secondEntered = deferred();
    const firstBody = Buffer.from([255, 0, 128, 13, 10]);
    const secondBody = Buffer.from('  Entire second document.\n月  ');
    const service = fixture(t, async function simultaneousDocuments(url) {
        if (url.endsWith('/first')) {
            firstEntered.resolve();
            await secondEntered.promise;
            return response(url, firstBody, {status: 503, headers: {'Content-Type': 'application/pdf'}});
        }
        secondEntered.resolve();
        await firstEntered.promise;
        return response(url, secondBody);
    }, undefined, function finishRequests() { firstEntered.resolve(); secondEntered.resolve(); });
    const runtime = createCoreRuntime({services: [service]});
    runtime.start();
    t.after(function closeRuntime() { return runtime.close(); });
    const first = wireClient(t, runtime, 'same-client-id');
    const second = wireClient(t, runtime, 'same-client-id');
    const firstProgress = [];
    const secondProgress = [];
    const results = await Promise.all([
        acquireCoreDocument({url: 'https://documents.invalid/first', client: first.client, onProgress(event) { firstProgress.push(event); }}),
        acquireCoreDocument({url: 'https://documents.invalid/second', client: second.client, onProgress(event) { secondProgress.push(event); }})
    ]);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].body instanceof Blob, true);
    assert.deepEqual(Buffer.from(await results[0].body.arrayBuffer()), firstBody);
    assert.deepEqual(Buffer.from(await results[1].body.arrayBuffer()), secondBody);
    for (const event of firstProgress) {
        assert.equal(event.requestId, 'same-client-id');
        assert.equal(event.requestedUrl, 'https://documents.invalid/first');
    }
    for (const event of secondProgress) assert.equal(event.requestedUrl, 'https://documents.invalid/second');
    assert.equal(firstProgress.at(-1).phase, 'complete');
    assert.equal(secondProgress.at(-1).phase, 'complete');
    const finalFrame = first.frames.find(function finalResponse(frame) { return frame.type === 'response'; });
    assert.deepEqual(finalFrame.result.body, {encoding: 'base64', data: firstBody.toString('base64')});
    assert.deepEqual(first.errors, []);
    assert.deepEqual(second.errors, []);
});

test('browser acquisition decodes complete redirect error evidence and never falls back without Core', async function browserErrors(t) {
    const body = Buffer.from([0, 255, 13, 10]);
    const calls = [];
    const service = fixture(t, async function redirectedDocument(url) {
        calls.push(url);
        return response(url, body, {status: 308, headers: {Location: '/declined'}});
    }, {destinationPredicate(url) { return !url.endsWith('/declined'); }});
    const runtime = createCoreRuntime({services: [service]});
    runtime.start();
    t.after(function closeRuntime() { return runtime.close(); });
    const {client} = wireClient(t, runtime, 'redirect-error');
    let receivedError;
    await assert.rejects(acquireCoreDocument({url: 'https://documents.invalid/start', client}), function receivedEvidence(error) {
        assert.equal(error.code, 'DOCUMENT_DESTINATION_DECLINED');
        assert.equal(error.cause.code, 'DOCUMENT_DESTINATION_DECLINED');
        receivedError = error;
        return true;
    });
    assert.deepEqual(Buffer.from(await receivedError.documentAcquisition.redirects[0].body.arrayBuffer()), body);
    await assert.rejects(acquireCoreDocument({url: 'https://documents.invalid/no-core', client: null}), {code: 'DOCUMENT_ACQUISITION_CORE_UNAVAILABLE'});
    assert.deepEqual(calls, ['https://documents.invalid/start']);
});

test('browser progress callback promises settle before success or failure and subscriptions are released', async function observerLifetime(t) {
    const service = fixture(t, async function document(url) { return response(url, 'Complete lunar report.'); });
    const runtime = createCoreRuntime({services: [service]});
    runtime.start();
    t.after(function closeRuntime() { return runtime.close(); });
    const {client} = wireClient(t, runtime, 'progress-observer');
    const subscribe = client.events.on;
    let subscriptions = 0;
    let subscriptionClosed;
    client.events.on = function observeSubscription(event, listener) {
        const unsubscribe = subscribe(event, listener);
        subscriptions += 1;
        return function observeUnsubscription() {
            subscriptions -= 1;
            const result = unsubscribe();
            subscriptionClosed.resolve();
            return result;
        };
    };
    for (const fail of [false, true]) {
        subscriptionClosed = deferred();
        const entered = deferred();
        const finish = deferred();
        const original = new Error('Complete asynchronous progress observer failure.');
        t.after(function finishObserver() { finish.resolve(); });
        let settled = false;
        const operation = acquireCoreDocument({
            url: 'https://documents.invalid/progress', client,
            async onProgress(progress) {
                if (progress.phase !== 'complete') return;
                entered.resolve();
                await finish.promise;
                if (fail) throw original;
            }
        });
        const observed = operation.then(function completed(result) { settled = true; return result; }, function rejected(error) { settled = true; throw error; });
        let receivedError;
        const outcome = fail ? assert.rejects(observed, function originalObserver(error) {
            receivedError = error;
            return error.cause === original;
        }) : observed;
        await entered.promise;
        // Progress completion precedes the RPC response. Unsubscription marks
        // that response's settlement before this deliberately late observer.
        await subscriptionClosed.promise;
        assert.equal(settled, false);
        finish.resolve();
        await outcome;
        assert.equal(subscriptions, 0);
        if (fail) {
            assert.equal(receivedError.documentAcquisition.response.complete, true);
            assert.equal(await receivedError.documentAcquisition.response.body.text(), 'Complete lunar report.');
        }
    }
});

test('browser error settlement joins every accepted observer and preserves simultaneous failures', async function allObserverFailures(t) {
    const first = deferred();
    const second = deferred();
    const cancelled = deferred();
    const operationError = new Error('Complete transport operation error.');
    const observerErrors = [new Error('Complete first observer error.'), new Error('Complete second observer error.')];
    let listener;
    let removed = false;
    let settled = false;
    const client = {
        events: {
            on(event, callback) {
                assert.equal(event, 'documents.progress');
                listener = callback;
                return function unsubscribe() { removed = true; };
            }
        },
        invoke(method, parameters, {signal, onRequest}) {
            assert.equal(method, 'documents.acquire');
            assert.deepEqual(parameters, {url: 'https://documents.invalid/failed'});
            signal.addEventListener('abort', function observerCancelledRequest() { cancelled.resolve(); }, {once: true});
            onRequest({requestId: 'observer-failures'});
            listener({requestId: 'observer-failures', phase: 'accepted'});
            listener({requestId: 'observer-failures', phase: 'request'});
            return Promise.reject(operationError);
        }
    };
    t.after(function releaseObservers() { first.resolve(); second.resolve(); });
    const operation = acquireCoreDocument({
        url: 'https://documents.invalid/failed', client,
        async onProgress(progress) {
            const index = progress.phase === 'accepted' ? 0 : 1;
            await (index === 0 ? first.promise : second.promise);
            throw observerErrors[index];
        }
    });
    const rejected = assert.rejects(operation, function completeErrors(error) {
        assert.equal(error instanceof AggregateError, true);
        assert.deepEqual(error.errors, [operationError, ...observerErrors]);
        assert.equal(error.cause, operationError);
        return true;
    });
    const observed = rejected.then(function operationSettled() { settled = true; });
    first.resolve();
    await cancelled.promise;
    assert.equal(settled, false);
    second.resolve();
    await observed;
    assert.equal(removed, true);
});
