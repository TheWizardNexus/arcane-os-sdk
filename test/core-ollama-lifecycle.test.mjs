import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createLocalAIService} from '../src/core/services/local-ai.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function settlement(accept, fail) { resolve = accept; reject = fail; });
    return {promise, resolve, reject};
}

test('Core publishes actual Ollama residency after owned operations and running inspection', async function ollamaLifecycle() {
    const originalFetch = globalThis.fetch;
    const model = 'moon-raccoon:latest';
    const events = [];
    const requests = [];
    let residents = [];
    let service;
    globalThis.fetch = async function ollamaHTTP(url, options = {}) {
        const pathname = new URL(url).pathname;
        const payload = options.body ? JSON.parse(options.body) : undefined;
        requests.push({pathname, payload});
        let result;
        if (pathname === '/api/version') result = {version: 'fixture'};
        else if (pathname === '/api/tags') result = {models: [{model, name: model}]};
        else if (pathname === '/api/ps') result = {models: residents};
        else if (pathname === '/api/generate') {
            residents = payload.keep_alive === 0 ? [] : [{model, name: model}];
            result = {model, response: '', done: true};
        } else if (pathname === '/api/chat') {
            residents = [{model, name: model}];
            result = {model, message: {role: 'assistant', content: '  Every sandwich.\nEvery crust.  '}, done: true};
        } else throw new Error(`Unexpected fixture route: ${pathname}`);
        return new Response(JSON.stringify(result), {headers: {'content-type': 'application/json'}});
    };
    try {
        service = createLocalAIService({runtimes: ['ollama']});
        await service.start({emit(name, value) { events.push({name, value}); }});
        const request = {signal: new AbortController().signal, emit() {}};
        await service.methods['ollama.generate']({model, prompt: '', stream: false}, request);
        assert.equal(service.current().ollama.models[0].loaded, true);
        assert.equal(events.at(-1).name, 'localai.state');
        assert.equal(events.at(-1).value.ollama.models[0].loaded, true);

        const payload = {model, messages: [{role: 'user', content: '  Keep all\nmy sandwiches.  '}], stream: false};
        const response = await service.methods['ollama.chat'](payload, request);
        assert.deepEqual(requests.find(function chatRequest(record) { return record.pathname === '/api/chat'; }).payload, payload);
        assert.equal(response.message.content, '  Every sandwich.\nEvery crust.  ');
        await service.methods['ollama.generate']({model, prompt: '', keep_alive: 0, stream: false}, request);
        assert.equal(service.current().ollama.models[0].loaded, false);

        residents = [{model: 'outside-catalog:latest', name: 'outside-catalog:latest'}];
        const running = await service.methods['ollama.running']({}, request);
        assert.deepEqual(running.models, residents);
        assert.equal(service.current().ollama.models[0].loaded, false);
        assert.equal(service.current().ollama.models[1].loaded, true);
        assert.equal(service.current().ollama.models[1].id, 'outside-catalog:latest');
    } finally {
        await service?.dispose();
        globalThis.fetch = originalFetch;
    }
});

test('Ollama observations order failures and successes within their engine lifetime', async function observationOwnership() {
    const originalFetch = globalThis.fetch;
    const model = 'moon-raccoon:latest';
    const request = {signal: new AbortController().signal, emit() {}};
    let service;
    let nextInspection;
    const residents = [{model}];
    function response(value) { return new Response(JSON.stringify(value)); }
    function holdInspection() {
        const gate = {...deferred(), started: deferred()};
        nextInspection = gate;
        return gate;
    }
    function assertCurrent() {
        assert.equal(service.current().ollama.available, true);
        assert.equal(service.current().ollama.error, null);
        assert.equal(service.current().ollama.models.find(function selected(record) { return record.id === model; }).loaded, true);
    }
    globalThis.fetch = async function ollamaHTTP(url, options = {}) {
        const pathname = new URL(url).pathname;
        if (pathname === '/api/version') return response({version: 'fixture'});
        if (pathname === '/api/tags') return response({models: [{model}]});
        if (pathname === '/api/generate') return response({model, response: '', done: true});
        if (pathname === '/api/ps') {
            if (nextInspection) {
                const gate = nextInspection;
                nextInspection = null;
                gate.started.resolve(options.signal);
                // Intentionally ignore abort to exercise late completion ownership.
                return gate.promise;
            }
            return response({models: residents});
        }
        throw new Error(`Unexpected fixture route: ${pathname}`);
    };
    try {
        service = createLocalAIService({runtimes: ['ollama']});
        await service.start({emit() {}});
        await service.methods['ollama.version']({}, request);

        const stale = holdInspection();
        const older = service.methods['ollama.running']({}, request);
        const staleError = new Error('Complete older resident failure\nwith diagnostic context.');
        const failedOlder = assert.rejects(older, function actualError(error) { return error === staleError; });
        await stale.started.promise;
        await service.methods['ollama.running']({}, request);
        stale.reject(staleError);
        await failedOlder;
        assertCurrent();

        for (const operation of ['localai.status', 'ollama.generate']) {
            const refresh = holdInspection();
            const refreshing = service.methods[operation]({model, prompt: '', stream: false}, request);
            await refresh.started.promise;
            await service.methods['ollama.running']({}, request);
            refresh.reject(new Error(`Older ${operation} observation failed.`));
            await refreshing;
            assertCurrent();
        }

        const first = holdInspection();
        const firstRequest = service.methods['ollama.running']({}, request);
        const firstFailure = new Error('Complete current error', {cause: new Error('Complete original cause')});
        firstFailure.details = {complete: '  Keep all\ndiagnostics.  '};
        const firstRejected = assert.rejects(firstRequest, function actualError(error) { return error === firstFailure; });
        await first.started.promise;
        const second = holdInspection();
        const secondRequest = service.methods['ollama.running']({}, request);
        await second.started.promise;
        first.reject(firstFailure);
        await firstRejected;
        assert.equal(service.current().ollama.error.cause.message, firstFailure.cause.message);
        assert.deepEqual(service.current().ollama.error.details, firstFailure.details);
        second.resolve(response({models: residents}));
        await secondRequest;
        assertCurrent();

        const cancelled = holdInspection();
        const controller = new AbortController();
        const cancelledRequest = service.methods['ollama.running']({}, {...request, signal: controller.signal});
        const cancelledResult = assert.rejects(cancelledRequest);
        const requestSignal = await cancelled.started.promise;
        controller.abort();
        assert.equal(requestSignal.aborted, true);
        cancelled.reject(requestSignal.reason);
        await cancelledResult;
        assertCurrent();

        for (const completion of ['failure', 'success']) {
            const previous = holdInspection();
            const oldRequest = service.methods['ollama.running']({}, request);
            const outcome = oldRequest.then(function completed(value) { return {value}; }, function rejected(error) { return {error}; });
            const oldSignal = await previous.started.promise;
            await service.methods['localai.services.recover']({runtimes: ['ollama']}, request);
            assert.equal(oldSignal.aborted, true);
            if (completion === 'failure') previous.reject(new Error('Previous engine observation failed.'));
            else previous.resolve(response({models: []}));
            await outcome;
            assertCurrent();
        }
    } finally {
        await service?.dispose();
        globalThis.fetch = originalFetch;
    }
});
