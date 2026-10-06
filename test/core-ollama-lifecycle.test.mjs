import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createLocalAIService} from '../src/core/services/local-ai.mjs';

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
