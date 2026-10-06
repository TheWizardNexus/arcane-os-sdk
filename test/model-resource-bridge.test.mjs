import assert from 'node:assert/strict';
import {test} from '../src/testing.mjs';
import {createModelResourceClient, createModelResourceHost} from '../browser-runtime/ai/model-resource-bridge.mjs';

function deferred() {
    const result = {};
    result.promise = new Promise(function retainCompletion(resolve) {
        result.resolve = resolve;
    });
    return result;
}

test('resource bridge preserves response metadata and complete error bodies', async function responseBridge() {
    const client = createModelResourceClient({send: function sendToHost(message) {
        host.receive(structuredClone(message));
    }});
    const host = createModelResourceHost({
        send: function sendToClient(message) { client.receive(structuredClone(message)); },
        async fetchResource(input, options) {
            assert.equal(input, 'https://models.example.test/dragon/config.json');
            options.onProgress({phase: 'download', completed: 1, total: 1, unit: 'shards'});
            return {file: new Blob(['Complete missing-resource explanation.']), status: 404,
                statusText: 'Missing dragon', headers: [['content-type', 'text/plain']],
                url: 'https://mirror.example.test/dragon/config.json', redirected: true};
        }
    });
    const progress = [];
    const response = await client.fetch('https://models.example.test/dragon/config.json', {
        onProgress: function retainProgress(value) { progress.push(value); }
    });
    assert.equal(response.status, 404);
    assert.equal(response.statusText, 'Missing dragon');
    assert.equal(response.url, 'https://mirror.example.test/dragon/config.json');
    assert.equal(response.redirected, true);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(await response.text(), 'Complete missing-resource explanation.');
    assert.deepEqual(progress, [{phase: 'download', completed: 1, total: 1, unit: 'shards'}]);
    assert.equal(host.receive({op: 'load'}), false);
    assert.equal(client.receive({op: 'load'}), false);
    client.close();
    await host.close();
});

test('closing a nested resource bridge cancels upstream and joins durable cleanup', async function bridgeCancellation() {
    const started = deferred();
    const aborted = deferred();
    const cleanup = deferred();
    const client = createModelResourceClient({send: function sendToHost(message) {
        host.receive(structuredClone(message));
    }});
    const host = createModelResourceHost({
        send: function sendToClient(message) { client.receive(structuredClone(message)); },
        async fetchResource(input, {signal}) {
            started.resolve();
            signal.addEventListener('abort', function retainAbort() { aborted.resolve(); }, {once: true});
            await aborted.promise;
            await cleanup.promise;
            throw signal.reason;
        }
    });
    const loading = client.fetch('https://models.example.test/dragon/model.onnx');
    const rejected = assert.rejects(loading, /Changed models/u);
    await started.promise;
    client.close(new Error('Changed models'));
    await aborted.promise;
    let settled = false;
    const closing = host.close();
    assert.equal(host.close(), closing);
    closing.then(function recordCleanup() { settled = true; });
    assert.equal(settled, false);
    cleanup.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(settled, true);
});

test('host close preserves a storage cleanup failure after cancellation', async function cleanupFailure() {
    const started = deferred();
    const cleanupError = new Error('The durable writer could not close.');
    const host = createModelResourceHost({
        send: function unusedResponse() {},
        async fetchResource(input, {signal}) {
            started.resolve();
            await new Promise(function waitForAbort(resolve) {
                signal.addEventListener('abort', resolve, {once: true});
            });
            throw new AggregateError([signal.reason, cleanupError], 'Reader and writer cleanup failed.');
        }
    });
    host.receive({arcaneModelResource: true, resourceId: 1, op: 'fetch',
        request: {url: 'https://models.example.test/dragon/model.onnx', options: {}}});
    await started.promise;
    await assert.rejects(host.close(), function retainsCleanup(error) {
        assert.equal(error.errors[0].errors[1], cleanupError);
        return true;
    });
});

test('host records ownership before synchronous progress can close it', async function reentrantHostClose() {
    const started = deferred();
    const finish = deferred();
    let closing;
    let settled = false;
    const host = createModelResourceHost({
        send: function closeFromProgress(message) {
            if (message.op === 'progress') closing = host.close();
        },
        async fetchResource(input, {onProgress}) {
            onProgress({phase: 'download', completed: 0, total: null, unit: 'shards'});
            started.resolve();
            await finish.promise;
            settled = true;
            return {file: new Blob(['complete'])};
        }
    });
    host.receive({arcaneModelResource: true, resourceId: 1, op: 'fetch',
        request: {url: 'https://models.example.test/dragon/model.onnx', options: {}}});
    await started.promise;
    assert.equal(settled, false);
    finish.resolve();
    await closing;
    assert.equal(settled, true);
});

test('HEAD remains bodyless and failed error delivery retains both causes', async function responseTransportDetails() {
    const client = createModelResourceClient({send: function sendToHost(message) {
        host.receive(structuredClone(message));
    }});
    const host = createModelResourceHost({
        send: function sendToClient(message) { client.receive(structuredClone(message)); },
        async fetchResource(input, {method}) {
            assert.equal(method, 'HEAD');
            return {file: new Blob([]), status: 200, statusText: 'OK', headers: [], url: input, redirected: false};
        }
    });
    const response = await client.fetch('https://models.example.test/dragon/model.onnx', {method: 'HEAD'});
    assert.equal(response.body, null);
    client.close();
    await host.close();

    const observed = deferred();
    const originalError = new Error('The complete resource failure.');
    const transportError = new Error('The error could not cross the Worker boundary.');
    const failingHost = createModelResourceHost({
        send: function failedSend() { throw transportError; },
        onError: function retainFailure(error) { observed.resolve(error); },
        async fetchResource() { throw originalError; }
    });
    failingHost.receive({arcaneModelResource: true, resourceId: 1, op: 'fetch',
        request: {url: 'https://models.example.test/dragon/model.onnx', options: {}}});
    const error = await observed.promise;
    assert.deepEqual(error.errors, [originalError, transportError]);
    await assert.rejects(failingHost.close(), function completeTransportFailure(failure) {
        assert.equal(failure.errors[0], error);
        return true;
    });
});
