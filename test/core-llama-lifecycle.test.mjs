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

test('llama projected and device selections preserve an adopted external model and its chat route', async function preserveExternalSelection(t) {
    const originalFetch = globalThis.fetch;
    const catalogReady = deferred();
    const requests = [];
    const model = {id: 'moon-raccoon', metadata: {charter: '  Complete\nmoon charter.  '}};
    const payload = {messages: [{role: 'user', content: '  Keep every crater.\nIncluding this one.  '}]};
    const completion = {choices: [{message: {role: 'assistant', content: '  The complete\nmoon charter.  '}}]};
    const request = {signal: new AbortController().signal, emit() {}};
    let assetLookups = 0;
    let service;
    globalThis.fetch = async function externalSelectionHTTP(url, options = {}) {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname === '/health') return response({status: 'ok'});
        if (pathname === '/props') return response({role: 'model', is_sleeping: false});
        if (pathname === '/models') return response({data: [model]});
        if (pathname === '/v1/chat/completions') {
            assert.deepEqual(JSON.parse(options.body), {...payload, model: model.id, stream: false});
            return response(completion);
        }
        throw new Error(`Unexpected fixture route: ${pathname}`);
    };
    t.after(async function releaseExternalSelectionFixture() {
        try { await service?.dispose(); }
        finally { globalThis.fetch = originalFetch; }
    });
    service = createLocalAIService({runtimes: ['llama.cpp']}, {
        runtimes: [{id: 'llama.cpp', executable: 'fixture/llama-server'}]
    });
    await service.start({
        emit(name, value) {
            if (name === 'localai.state' && value.runtimes[0]?.models[0]?.loaded) catalogReady.resolve();
        },
        async getService() {
            assetLookups += 1;
            throw new Error('External selection must not retain a model projection.');
        }
    });
    await catalogReady.promise;
    for (const selection of [
        {assetProjectionId: 'moon-projection', resourcePaths: {model: 'moon.gguf'}},
        {executionTarget: {deviceId: 'fixture-gpu'}},
        {executionTarget: null}
    ]) {
        await assert.rejects(service.methods['llama.load']({model: model.id, ...selection}, request), {
            code: 'LOCAL_AI_EXTERNAL_SELECTION_UNSUPPORTED'
        });
    }
    assert.equal(assetLookups, 0);
    const status = await service.methods['llama.status']({}, request);
    assert.equal(status.installed, true);
    assert.equal(status.managed, false);
    assert.equal(status.owned, false);
    assert.equal(status.available, true);
    assert.equal(status.error, null);
    assert.equal(status.execution, null);
    assert.deepEqual(status.models, [{...model, status: {value: 'loaded'}, loaded: true}]);
    assert.deepEqual(await service.methods['llama.chat']({model: model.id, payload}, request), completion);
    assert.deepEqual(requests, [
        '/health', '/props', '/models', '/props', '/models',
        '/props', '/models', '/v1/chat/completions'
    ]);
});

test('llama selection cancellation during discovery preserves the external startup owner', async function preservePendingExternalDiscovery(t) {
    const originalFetch = globalThis.fetch;
    const health = deferred();
    const healthStarted = deferred();
    const catalogReady = deferred();
    const requests = [];
    const states = [];
    const controller = new AbortController();
    const cancellation = new Error('The moon mission changed before discovery finished.');
    const selection = {model: 'moon-raccoon', assetProjectionId: 'moon-projection', resourcePaths: {model: 'moon.gguf'}};
    let healthSignal;
    let assetLookups = 0;
    let service;
    globalThis.fetch = async function pendingExternalSelectionHTTP(url, options = {}) {
        const pathname = new URL(url).pathname;
        requests.push(pathname);
        if (pathname === '/health') {
            healthSignal = options.signal;
            function abortHealth() { health.reject(options.signal.reason); }
            options.signal.addEventListener('abort', abortHealth, {once: true});
            healthStarted.resolve();
            try { return await health.promise; }
            finally { options.signal.removeEventListener('abort', abortHealth); }
        }
        if (pathname === '/props') return response({role: 'model', is_sleeping: false});
        if (pathname === '/models') return response({data: [{id: selection.model}]});
        throw new Error(`Unexpected fixture route: ${pathname}`);
    };
    t.after(async function releasePendingExternalSelectionFixture() {
        health.resolve(response({status: 'ok'}));
        try { await service?.dispose(); }
        finally { globalThis.fetch = originalFetch; }
    });
    service = createLocalAIService({runtimes: ['llama.cpp']}, {
        runtimes: [{id: 'llama.cpp', executable: 'fixture/llama-server'}]
    });
    await service.start({
        emit(name, value) {
            if (name !== 'localai.state') return;
            states.push(value.runtimes[0]?.state);
            if (value.runtimes[0]?.models[0]?.loaded) catalogReady.resolve();
        },
        async getService() {
            assetLookups += 1;
            throw new Error('Discovery must finish before projection retention.');
        }
    });
    await healthStarted.promise;
    const cancelled = assert.rejects(
        service.methods['llama.load'](selection, {signal: controller.signal, emit() {}}),
        function sameCancellation(error) { return error === cancellation; }
    );
    controller.abort(cancellation);
    await cancelled;
    assert.equal(healthSignal.aborted, false);
    const rejected = assert.rejects(
        service.methods['llama.load'](selection, {signal: new AbortController().signal, emit() {}}),
        {code: 'LOCAL_AI_EXTERNAL_SELECTION_UNSUPPORTED'}
    );
    health.resolve(response({status: 'ok'}));
    await Promise.all([rejected, catalogReady.promise]);
    assert.equal(healthSignal.aborted, false);
    assert.equal(assetLookups, 0);
    assert.equal(states.includes('stopped'), false);
    assert.equal(service.current().runtimes[0].managed, false);
    assert.equal(service.current().runtimes[0].models[0].loaded, true);
    assert.deepEqual(requests, ['/health', '/props', '/models']);
});

test('llama selected startup failure releases its projection and recovery retains the exact selection', async function releaseFailedSelectedStartup(t) {
    const originalFetch = globalThis.fetch;
    const initialFailure = deferred();
    const releaseStarted = deferred();
    const finishRelease = deferred();
    const requests = [];
    const processEvents = [];
    const retainedIds = [];
    const request = {signal: new AbortController().signal, emit() {}};
    const missingProjection = Object.assign(new Error('The moon projection must be prepared again.'), {
        code: 'MODEL_ASSET_PROJECTION_UNAVAILABLE'
    });
    let projectionAvailable = true;
    let releasedUses = 0;
    let loadSettled = false;
    let service;
    globalThis.fetch = async function refusedManagedSelectionHTTP(url) {
        requests.push(new URL(url).pathname);
        throw Object.assign(new Error('The fixture listener is unused.'), {code: 'ECONNREFUSED'});
    };
    t.after(async function releaseFailedSelectedStartupFixture() {
        finishRelease.resolve();
        try { await service?.dispose(); }
        finally { globalThis.fetch = originalFetch; }
    });
    service = createLocalAIService({
        runtimes: ['llama.cpp'],
        // This existing argument error occurs before directory creation or process launch.
        llamaCpp: {args: 'invalid fixture arguments'}
    }, {
        appRoot: '.',
        runtimes: [{id: 'llama.cpp', executable: 'fixture/llama-server'}],
        onEvent(event) {
            if (event.type.startsWith('process.')) processEvents.push(event);
        }
    });
    await service.start({
        emit(name, value) {
            if (name === 'localai.state' && value.runtimes[0]?.state === 'error') initialFailure.resolve();
        },
        async getService(name) {
            assert.equal(name, 'model-assets');
            return {
                retain(id) {
                    retainedIds.push(id);
                    if (!projectionAvailable) throw missingProjection;
                    let releaseTask;
                    return {
                        id,
                        members: [{path: 'moon.gguf', nativePath: 'fixture/selected-moon.gguf'}],
                        release() {
                            releaseTask ??= (async function releaseProjectionUse() {
                                releasedUses += 1;
                                projectionAvailable = false;
                                releaseStarted.resolve();
                                await finishRelease.promise;
                            })();
                            return releaseTask;
                        }
                    };
                }
            };
        }
    });
    await initialFailure.promise;
    const load = service.methods['llama.load']({
        model: 'moon-raccoon', assetProjectionId: 'moon-projection',
        resourcePaths: {model: 'moon.gguf'}, executionTarget: null
    }, request).finally(function selectedLoadSettled() { loadSettled = true; });
    const rejected = assert.rejects(load, {code: 'ARCANE_USAGE', message: 'llama.cpp arguments must be an array of strings.'});
    await releaseStarted.promise;
    assert.equal(loadSettled, false);
    finishRelease.resolve();
    await rejected;
    assert.equal(releasedUses, 1);
    assert.deepEqual(retainedIds, ['moon-projection']);
    assert.deepEqual(requests, ['/health', '/health']);
    assert.deepEqual(processEvents, []);
    const unloaded = await service.methods['llama.unload']({model: 'moon-raccoon'}, request);
    assert.equal(unloaded.unloaded, true);
    assert.equal(unloaded.released, true);
    assert.equal(unloaded.state, 'stopped');
    assert.equal(releasedUses, 1);
    assert.deepEqual(requests, ['/health', '/health']);
    await assert.rejects(service.methods['localai.services.recover']({runtimes: ['llama.cpp']}, request),
        function exactMissingProjection(error) { return error === missingProjection; });
    assert.deepEqual(retainedIds, ['moon-projection', 'moon-projection']);
    assert.deepEqual(requests, ['/health', '/health']);
    assert.deepEqual(processEvents, []);
    await assert.rejects(service.methods['llama.load']({
        model: 'moon-raccoon', executionTarget: {deviceId: 'fixture-gpu'}
    }, request), function exactReselectionFailure(error) { return error === missingProjection; });
    assert.deepEqual(retainedIds, ['moon-projection', 'moon-projection', 'moon-projection']);
    assert.deepEqual(requests, ['/health', '/health']);
    assert.deepEqual(processEvents, []);
});
