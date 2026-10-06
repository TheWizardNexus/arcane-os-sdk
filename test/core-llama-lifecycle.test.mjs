import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createLocalAIService} from '../src/core/services/local-ai.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function settlement(accept, fail) { resolve = accept; reject = fail; });
    return {promise, resolve, reject};
}

function response(value, status = 200) {
    return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}

test('llama status and model observations return while the selected service is still starting', async function observeStarting(t) {
    const originalFetch = globalThis.fetch;
    const health = deferred();
    const healthStarted = deferred();
    const catalogReady = deferred();
    const requests = [];
    const model = {id: 'moon-raccoon', description: '  Every moon charter\nparagraph remains.  '};
    const request = {signal: new AbortController().signal, emit() {}};
    let service;
    globalThis.fetch = async function llamaHTTP(url, options = {}) {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname === '/health') {
            const abort = function abortHealth() { health.reject(options.signal.reason); };
            options.signal.addEventListener('abort', abort, {once: true});
            healthStarted.resolve();
            try { return await health.promise; }
            finally { options.signal.removeEventListener('abort', abort); }
        }
        if (pathname === '/props') return response({role: 'model', is_sleeping: false});
        if (pathname === '/models') return response({data: [model]});
        throw new Error(`Unexpected fixture route: ${pathname}`);
    };
    t.after(async function releaseStartingFixture() {
        health.resolve(response({status: 'ok'}));
        try { await service?.dispose(); }
        finally { globalThis.fetch = originalFetch; }
    });
    service = createLocalAIService({runtimes: ['llama.cpp']});
    await service.start({emit(name, value) {
        if (name === 'localai.state' && value.runtimes[0]?.models[0]?.loaded) catalogReady.resolve();
    }});
    await healthStarted.promise;

    const starting = await service.methods['llama.status']({}, request);
    assert.equal(starting.state, 'starting');
    assert.equal(starting.available, false);
    assert.deepEqual(starting.models, []);
    assert.deepEqual(await service.methods['llama.models']({}, request), {models: []});
    assert.deepEqual(requests, ['/health']);

    health.resolve(response({status: 'ok'}));
    await catalogReady.promise;
    const ready = await service.methods['llama.status']({}, request);
    assert.equal(ready.available, true);
    assert.deepEqual(ready.models, [{...model, status: {value: 'loaded'}, loaded: true}]);
    assert.deepEqual(requests, ['/health', '/props', '/models', '/props', '/models']);
});

test('llama observations retain loading and complete failure state without starting another attempt', async function observeUnavailable(t) {
    const originalFetch = globalThis.fetch;
    let service;
    t.after(async function releaseUnavailableFixture() {
        try { await service?.dispose(); }
        finally { globalThis.fetch = originalFetch; }
    });
    const request = {signal: new AbortController().signal, emit() {}};
    for (const example of [
        {status: 503, body: {error: {message: 'Loading model'}}, state: 'loading'},
        {status: 502, body: {error: {message: '  Complete engine failure\nwith all diagnostic context.  ', details: {moon: 'cheese'}}}, state: 'error'}
    ]) {
        const requests = [];
        const observed = deferred();
        globalThis.fetch = async function unavailableLlamaHTTP(url) {
            requests.push(new URL(url).pathname);
            return response(example.body, example.status);
        };
        service = createLocalAIService({runtimes: ['llama.cpp']});
        await service.start({emit(name, value) {
            if (name === 'localai.state' && value.runtimes[0]?.state === example.state) observed.resolve();
        }});
        await observed.promise;
        const retained = service.current().runtimes[0];
        const status = await service.methods['llama.status']({}, request);
        assert.deepEqual(status, retained);
        assert.equal(status.available, false);
        assert.equal(status.state, example.state);
        if (example.state === 'loading') assert.equal(status.error, null);
        else assert.deepEqual(status.error.details.result, example.body);
        assert.deepEqual(await service.methods['llama.models']({}, request), {models: retained.models});
        assert.deepEqual(requests, ['/health']);
        await service.dispose();
        service = undefined;
    }
});

test('llama external release preserves actual residency and stopped observation performs no I/O', async function observeExternalRelease(t) {
    const originalFetch = globalThis.fetch;
    const catalogReady = deferred();
    const requests = [];
    const model = {id: 'moon-raccoon', metadata: {charter: '  Complete\nmoon charter.  '}};
    const request = {signal: new AbortController().signal, emit() {}};
    let service;
    let disposed = false;
    globalThis.fetch = async function externalLlamaHTTP(url) {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname === '/health') return response({status: 'ok'});
        if (pathname === '/props') return response({role: 'model', is_sleeping: false});
        if (pathname === '/models') return response({data: [model]});
        throw new Error(`Unexpected fixture route: ${pathname}`);
    };
    t.after(async function releaseExternalFixture() {
        try { if (!disposed) await service?.dispose(); }
        finally { globalThis.fetch = originalFetch; }
    });
    service = createLocalAIService({runtimes: ['llama.cpp']});
    await service.start({emit(name, value) {
        if (name === 'localai.state' && value.runtimes[0]?.models[0]?.loaded) catalogReady.resolve();
    }});
    await catalogReady.promise;
    for (const attempt of [1, 2]) {
        const released = await service.methods['llama.unload']({model: model.id}, request);
        assert.equal(released.owned, false, `External ownership on attempt ${attempt}`);
        assert.equal(released.released, true);
        assert.equal(released.unloaded, false);
        assert.equal(released.models[0].loaded, true);
        assert.deepEqual(released.models[0].metadata, model.metadata);
    }
    assert.deepEqual(requests, ['/health', '/props', '/models']);
    await service.dispose();
    disposed = true;
    const retained = service.current().runtimes[0];
    const stopped = await service.methods['llama.status']({}, request);
    assert.deepEqual(stopped, retained);
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.available, false);
    assert.deepEqual(await service.methods['llama.models']({}, request), {models: retained.models});
    assert.deepEqual(requests, ['/health', '/props', '/models']);
});
