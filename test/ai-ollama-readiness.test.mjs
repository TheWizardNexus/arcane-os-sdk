import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {sameOllamaModelIdentifier} from '../runtime/arcane/modules/OllamaModelIdentifier.js';

test('Ollama residency comparisons use upstream default names without changing caller strings',function defaultNames(){
    const resident='moon-raccoon:latest';
    for(const selected of ['moon-raccoon','library/moon-raccoon','registry.ollama.ai/library/moon-raccoon',
        'registry.ollama.ai/library/moon-raccoon:latest','REGISTRY.OLLAMA.AI/LIBRARY/Moon-Raccoon:LATEST']){
        assert.equal(sameOllamaModelIdentifier(selected,resident),true);
    }
    assert.equal(sameOllamaModelIdentifier('moon-raccoon:small',resident),false);
    assert.equal(sameOllamaModelIdentifier('observatory/moon-raccoon',resident),false);
    assert.equal(sameOllamaModelIdentifier('other.registry/library/moon-raccoon',resident),false);
    assert.equal(sameOllamaModelIdentifier(undefined,resident),false);
});

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function settlement(accept, fail) { resolve = accept; reject = fail; });
    return {promise, resolve, reject};
}

for (const selectedModel of ['moon-raccoon:latest', 'moon-raccoon', 'registry.ollama.ai/library/moon-raccoon']) {
test(`AI Ollama observes residency and cancellation for ${selectedModel}`, async function ollamaReadiness() {
    const globals = new Map(['window', 'document', 'localStorage', 'Arcane'].map(function descriptor(key) {
        return [key, Object.getOwnPropertyDescriptor(globalThis, key)];
    }));
    const registrationKey = Symbol.for('arcane.ai.user-ready-registration');
    const previousRegistration = globalThis[registrationKey];
    const values = new Map();
    const localStorage = {
        getItem(key) { return values.get(String(key)) ?? null; },
        setItem(key, value) { values.set(String(key), String(value)); },
        removeItem(key) { values.delete(String(key)); }
    };
    const document = {documentElement: {dataset: {arcaneAppId: 'ollama-readiness'}}, querySelector() { return null; }};
    const window = new EventTarget();
    Object.assign(window, {document, localStorage, dbopfs: {ready: false, get() {}}, user: {ready: false}});
    Object.assign(globalThis, {window, document, localStorage});
    const model = 'moon-raccoon:latest';
    const listeners = new Set();
    const generated = [];
    const preloadStarted = deferred();
    const preload = deferred();
    let residents = [];
    let chatStarted = deferred();
    let chatResult;
    let chatSignal;
    let chatOnChunk;
    let chatCount = 0;
    let runningGate;
    function publish(available = true) {
        const snapshot = {ollama: {available, state: available ? 'ready' : 'error', models: residents.map(function resident(record) {
            return {...record, id: record.model, loaded: true};
        })}};
        for (const listener of [...listeners]) listener(snapshot);
    }
    globalThis.Arcane = {
        events: {on(name, listener) {
            assert.equal(name, 'localai.state');
            listeners.add(listener);
            return function unsubscribe() { listeners.delete(listener); };
        }},
        ollama: {
            async generate(payload) {
                generated.push(payload);
                if (payload.keep_alive === 0) residents = [];
                else {
                    preloadStarted.resolve();
                    await preload.promise;
                    residents = [{model, name: model}];
                }
                publish();
                return {model: payload.model, response: '', done: true};
            },
            async running({signal} = {}) {
                assert.ok(signal instanceof AbortSignal);
                if (runningGate) {
                    const gate = runningGate;
                    runningGate = null;
                    gate.started.resolve(signal);
                    await new Promise(function awaitCancellation(_resolve, reject) {
                        signal.addEventListener('abort', function cancelInspection() { reject(signal.reason); }, {once: true});
                    });
                }
                return {models: residents};
            },
            chat(payload, {signal, onChunk}) {
                chatCount += 1;
                chatSignal = signal;
                chatOnChunk = onChunk;
                chatResult = deferred();
                chatStarted.resolve(payload);
                function cancel() {
                    const error = new Error('The selected request was cancelled.');
                    error.name = 'AbortError';
                    chatResult.reject(error);
                }
                signal.addEventListener('abort', cancel, {once: true});
                return chatResult.promise.finally(function detach() { signal.removeEventListener('abort', cancel); });
            }
        }
    };
    let ai;
    try {
        const {default: AI} = await import('arcane-os/ai');
        ai = new AI('OLLAMA', 'LOCAL_SPEACH', 'LOCAL_SPEACH', selectedModel);
        const load = ai.providerRuntime.load('llm');
        await preloadStarted.promise;
        assert.equal(ai.providerRuntime.status('llm').loaded, false);
        assert.equal(ai.providerRuntime.status('llm').state, 'loading');
        assert.ok(listeners.size > 0);
        preload.resolve();
        await load;
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
        assert.deepEqual(generated[0], {model: selectedModel, prompt: '', stream: false});

        const controller = new AbortController();
        runningGate = {started: deferred()};
        const inspecting = runningGate.started.promise;
        const cancelled = ai.fetchRequest({messages: [{role: 'user', content: 'Keep every sandwich.'}], signal: controller.signal});
        const cancelledResult = assert.rejects(cancelled);
        const inspectionSignal = await inspecting;
        controller.abort();
        await cancelledResult;
        assert.equal(inspectionSignal.aborted, true);
        assert.equal(chatCount, 0);

        await ai.providerRuntime.unload('llm');
        await ai.providerRuntime.load('llm');

        // An idle observation never substitutes for the next inference boundary.
        residents = [];
        await assert.rejects(ai.fetchRequest({messages: [{role: 'user', content: 'Count the sandwiches.'}]}));
        assert.equal(chatCount, 0);
        await ai.providerRuntime.unload('llm');
        await ai.providerRuntime.load('llm');
        const messages = [{role: 'user', content: '  Keep every\ncrust.  '}];
        const request = ai.fetchRequest({messages});
        const rejected = assert.rejects(request);
        const sent = await chatStarted.promise;
        assert.equal(sent.model, selectedModel);
        assert.deepEqual(sent.messages, messages);
        residents = [{model: 'replacement:latest'}];
        publish();
        assert.equal(chatSignal.aborted, true);
        await rejected;
        await ai.providerRuntime.unload('llm');
        assert.equal(ai.providerRuntime.status('llm').loaded, false);

        await ai.providerRuntime.load('llm');
        chatStarted = deferred();
        const completed = ai.fetchRequest({messages});
        await chatStarted.promise;
        chatResult.resolve({model, message: {role: 'assistant', content: '  All crusts.\nEvery one.  '}, done_reason: 'stop'});
        const result = await completed;
        assert.equal(result.choices[0].message.content, '  All crusts.\nEvery one.  ');

        chatStarted = deferred();
        const chunkSeen = deferred();
        const chunks = [];
        const streaming = ai.streamRequest({messages, onChunk(chunk) {
            chunks.push(chunk);
            chunkSeen.resolve();
        }});
        const rejectedStream = assert.rejects(streaming);
        await chatStarted.promise;
        await chatOnChunk({model, message: {content: 'Keep every crust.'}});
        await chunkSeen.promise;
        assert.equal(chunks.join(''), 'Keep every crust.');
        publish(false);
        assert.equal(chatSignal.aborted, true);
        await rejectedStream;
        await ai.providerRuntime.unload('llm');
        await ai.providerRuntime.load('llm');
        await ai.providerRuntime.unload('llm');
        assert.equal(generated.at(-1).keep_alive, 0);
        assert.equal(generated.at(-1).model, selectedModel);
        assert.equal(listeners.size, 0);
    } finally {
        try {
            preload.resolve();
            ai?.stopAudio();
            await ai?.providerRuntime.disposeAll();
        } finally {
            const registration = globalThis[registrationKey];
            if (registration !== previousRegistration) registration?.dispose();
            for (const [key, descriptor] of globals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete globalThis[key];
            }
        }
    }
});
}
