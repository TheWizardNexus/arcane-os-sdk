import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise(function settlement(accept, fail) { resolve = accept; reject = fail; });
    return {promise, resolve, reject};
}

test('AI Ollama loads the exact resident model and observes owned lifecycle through commit', async function ollamaReadiness() {
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
                return {model, response: '', done: true};
            },
            async running() { return {models: residents}; },
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
        ai = new AI('OLLAMA', 'LOCAL_SPEACH', 'LOCAL_SPEACH', model);
        const load = ai.providerRuntime.load('llm');
        await preloadStarted.promise;
        assert.equal(ai.providerRuntime.status('llm').loaded, false);
        assert.equal(ai.providerRuntime.status('llm').state, 'loading');
        assert.ok(listeners.size > 0);
        preload.resolve();
        await load;
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
        assert.deepEqual(generated[0], {model, prompt: '', stream: false});

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
