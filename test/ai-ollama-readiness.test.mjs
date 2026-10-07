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

const selectedModels = ['moon-raccoon:latest', 'moon-raccoon', 'registry.ollama.ai/library/moon-raccoon'];
for (const selectedModel of selectedModels) {
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
    let loadGate;
    let unloadGate;
    const lifecycleGates = [];
    const stateSubscriptions = [];
    function pauseLifecycle() {
        const gate = {...deferred(), started: deferred()};
        lifecycleGates.push(gate);
        return gate;
    }
    function ollamaRoutes(modelId) {
        const selected = {providerId: 'OLLAMA', modelId, localOnly: true};
        return {
            llm: {default: selected, localOnly: selected},
            stt: {default: null, localOnly: null},
            tts: {default: null, localOnly: null}
        };
    }
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
            async generate(payload, {signal} = {}) {
                generated.push(payload);
                if (payload.keep_alive === 0) {
                    if (unloadGate) {
                        const gate = unloadGate;
                        unloadGate = null;
                        gate.started.resolve();
                        await gate.promise;
                    }
                    residents = [];
                }
                else {
                    preloadStarted.resolve();
                    await preload.promise;
                    if (loadGate) {
                        const gate = loadGate;
                        loadGate = null;
                        gate.started.resolve({payload, signal});
                        await new Promise(function awaitSelectedPreload(resolve, reject) {
                            function cancel() { reject(signal.reason); }
                            signal.addEventListener('abort', cancel, {once: true});
                            gate.promise.then(resolve, reject).finally(function detach() {
                                signal.removeEventListener('abort', cancel);
                            });
                            if (signal.aborted) cancel();
                        });
                    }
                    const residentModel = sameOllamaModelIdentifier(payload.model, model) ? model : payload.model;
                    residents = [{model: residentModel, name: residentModel}];
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
                signal?.addEventListener('abort', cancel, {once: true});
                return chatResult.promise.finally(function detach() { signal?.removeEventListener('abort', cancel); });
            }
        }
    };
    let ai;
    let readinessEvents;
    function requestLoadedModel(messages, signal = null) {
        return ai.providerRuntime.request('llm', {
            operation: 'chat', payload: {messages}, localOnly: false, signal
        });
    }
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
        const cancelled = requestLoadedModel([{role: 'user', content: 'Keep every sandwich.'}], controller.signal);
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
        await assert.rejects(requestLoadedModel([{role: 'user', content: 'Count the sandwiches.'}]));
        assert.equal(chatCount, 0);
        await ai.providerRuntime.unload('llm');
        await ai.providerRuntime.load('llm');
        const messages = [{role: 'user', content: '  Keep every\ncrust.  '}];
        const request = requestLoadedModel(messages);
        const rejected = assert.rejects(request);
        const sent = await chatStarted.promise;
        assert.equal(sent.model, selectedModel);
        assert.deepEqual(sent.messages, messages);
        residents = [{model: 'replacement:latest'}];
        publish();
        assert.equal(chatSignal.aborted, true);
        const unloadingRequest = ai.providerRuntime.status('llm');
        assert.equal(unloadingRequest.state, 'unloading');
        assert.equal(unloadingRequest.loaded, true);
        assert.equal(unloadingRequest.busy, true);
        assert.ok(unloadingRequest.operationId);
        await assert.rejects(requestLoadedModel(messages), {code: 'ARCANE_AI_OPERATION_SUPERSEDED'});
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
        const streaming = (async function observeLoadedModelStream() {
            const handle = await ai.providerRuntime.request('llm', {
                operation: 'stream', payload: {messages}, localOnly: false, signal: null
            });
            const terminal = assert.rejects(handle.result);
            try {
                for await (const chunk of handle) {
                    chunks.push(chunk.message.content);
                    chunkSeen.resolve();
                }
            } finally {
                await terminal;
            }
        })();
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

        const {createArcaneEventSource} = await import('arcane-os/event-manager');
        readinessEvents = createArcaneEventSource({}, {
            source: 'ollama-selection-fixture', eventTypes: ['arcane-ollama-ready']
        });
        function publishReadiness() {
            ai.twinKey = '';
            readinessEvents.dispatch('arcane-ollama-ready', {});
        }
        const tuple = ['OLLAMA', 'LOCAL_SPEACH', 'LOCAL_SPEACH', selectedModel, 'LOCAL_SPEACH', 'LOCAL_SPEACH'];
        const beforeDeferred = generated.length;
        const deferredStatus = await ai.transitionAI(...tuple, {startLanguageModel: false});
        assert.equal(deferredStatus.roles.llm.state, 'unloaded');
        assert.equal(ai.model, selectedModel);
        assert.equal(ai.providerRuntime.selection('llm').modelId, selectedModel);
        assert.equal(ai.providerRuntime.hasProvider('llm', 'OLLAMA'), true);
        publishReadiness();
        assert.equal(ai.providerRuntime.status('llm').state, 'unloaded');
        assert.equal(generated.length, beforeDeferred);

        await ai.providerRuntime.load('llm');
        const afterExplicitLoad = generated.length;
        residents = [];
        publish();
        await ai.providerRuntime.unload('llm');
        publishReadiness();
        assert.equal(ai.providerRuntime.status('llm').state, 'unloaded');
        assert.equal(generated.length, afterExplicitLoad, 'Residency loss must not reactivate a deferred selection');

        assert.equal(ai.setAI(...tuple, {startLanguageModel: false}), true);
        const configured = ai.configureProviders(ollamaRoutes(selectedModel), {startLanguageModel: false});
        assert.equal(configured.llm.default.modelId, selectedModel);
        const transitioned = await ai.transitionProviders(ollamaRoutes(selectedModel), {startLanguageModel: false});
        assert.equal(transitioned.llm.default.modelId, selectedModel);
        publishReadiness();
        assert.equal(ai.providerRuntime.status('llm').state, 'unloaded');
        assert.equal(generated.length, afterExplicitLoad);

        const {subscribeAIRuntimeState} = await import('../runtime/arcane/modules/AIRuntimeState.js');
        for (const method of ['setAI', 'configureProviders']) {
            const outerModel = `${method}-outer-raccoon`;
            const newerModel = `${method}-newer-raccoon`;
            let replacement;
            const stop = subscribeAIRuntimeState(function selectDuringConfiguration(snapshot) {
                if (replacement || snapshot.roles.llm.modelId !== outerModel) return;
                replacement = ai.transitionProviders(ollamaRoutes(newerModel), {startLanguageModel: false});
            }, {emitCurrent: false});
            stateSubscriptions.push(stop);
            try {
                assert.throws(function configureOuterSelection() {
                    if (method === 'setAI') {
                        ai.setAI('OLLAMA', undefined, undefined, outerModel);
                    } else {
                        ai.configureProviders(ollamaRoutes(outerModel));
                    }
                }, {code: 'ARCANE_AI_OPERATION_SUPERSEDED'});
            } finally {
                stop();
            }
            assert.ok(replacement, 'Configuration must synchronously notify its listener');
            await replacement;
            assert.equal(ai.model, newerModel);
            assert.equal(ai.providerRuntime.selection('llm').modelId, newerModel);
            assert.equal(ai.providerRuntime.status('llm').state, 'unloaded');
            assert.equal(generated.length, afterExplicitLoad, 'The superseded outer selection must not preload');
        }

        const notificationCancellation = new AbortController();
        const stopCancellation = subscribeAIRuntimeState(function cancelCommittedConfiguration(snapshot) {
            if (snapshot.roles.llm.modelId === 'cancelled-notification-raccoon') notificationCancellation.abort();
        }, {emitCurrent: false});
        stateSubscriptions.push(stopCancellation);
        try {
            assert.throws(function configureThenCancelDuringNotification() {
                ai.configureProviders(ollamaRoutes('cancelled-notification-raccoon'), {signal: notificationCancellation.signal});
            }, {name: 'AbortError'});
        } finally {
            stopCancellation();
        }
        assert.equal(ai.model, 'cancelled-notification-raccoon');
        assert.equal(ai.providerRuntime.selection('llm').modelId, ai.model);
        assert.equal(generated.length, afterExplicitLoad);

        await ai.transitionProviders({
            llm: {default: null, localOnly: null},
            stt: {default: null, localOnly: null},
            tts: {default: null, localOnly: null}
        }, {startLanguageModel: false});
        assert.equal(ai.providerRuntime.hasProvider('llm', 'OLLAMA'), false);
        ai.providerRuntime.configure({
            llm: {default: {providerId: 'OLLAMA', modelId: 'pending-registration-raccoon', localOnly: null}, localOnly: null},
            stt: {default: null, localOnly: null},
            tts: {default: null, localOnly: null}
        });
        let registeredReplacement;
        const stopRegistration = subscribeAIRuntimeState(function selectDuringRegistration(snapshot) {
            if (snapshot.roles.llm.modelId === 'pending-registration-raccoon' && snapshot.roles.llm.localOnly === true) {
                ai.configureProviders({
                    llm: {default: null, localOnly: null},
                    stt: {default: null, localOnly: null},
                    tts: {default: null, localOnly: null}
                }, {startLanguageModel: false});
                assert.equal(ai.providerRuntime.hasProvider('llm', 'OLLAMA'), false);
                registeredReplacement = ai.configureProviders(ollamaRoutes('registered-newer-raccoon'), {startLanguageModel: false});
            }
        }, {emitCurrent: false});
        stateSubscriptions.push(stopRegistration);
        try {
            assert.throws(function registerThenSupersedeSelection() {
                ai.setAI('OLLAMA', undefined, undefined, 'registered-outer-raccoon');
            }, {code: 'ARCANE_AI_OPERATION_SUPERSEDED'});
        } finally {
            stopRegistration();
        }
        assert.equal(registeredReplacement.llm.default.modelId, 'registered-newer-raccoon');
        assert.equal(ai.model, 'registered-newer-raccoon');
        assert.equal(ai.providerRuntime.selection('llm').modelId, ai.model);
        assert.equal(ai.providerRuntime.hasProvider('llm', 'OLLAMA'), true);
        assert.equal(generated.length, afterExplicitLoad);
        await ai.providerRuntime.load('llm');
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
        await ai.providerRuntime.unload('llm');

        const preservedLoadGate = pauseLifecycle();
        loadGate = preservedLoadGate;
        const preservedSelection = ai.transitionAI(...tuple);
        const preservedLoad = await preservedLoadGate.started.promise;
        assert.throws(function rejectBusyTupleConfiguration() {
            ai.setAI('OLLAMA', undefined, undefined, 'busy-tuple-raccoon');
        }, {code: 'ARCANE_AI_ROLE_BUSY'});
        assert.throws(function rejectBusyRouteConfiguration() {
            ai.configureProviders(ollamaRoutes('busy-routes-raccoon'));
        }, {code: 'ARCANE_AI_ROLE_BUSY'});
        assert.equal(preservedLoad.signal.aborted, false, 'Rejected synchronous configuration must preserve the existing owned load');
        preservedLoadGate.resolve();
        await preservedSelection;
        assert.equal(ai.model, selectedModel);
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
        await ai.providerRuntime.unload('llm');
        const afterReentrantSelections = generated.length;

        const alreadyCancelled = new AbortController();
        alreadyCancelled.abort();
        const cancelledOptions = {signal: alreadyCancelled.signal};
        assert.throws(() => ai.setAI(...tuple, cancelledOptions), {name: 'AbortError'});
        assert.throws(() => ai.configureProviders(ollamaRoutes('cancelled-before-selection'), cancelledOptions), {name: 'AbortError'});
        await assert.rejects(ai.transitionAI(...tuple, cancelledOptions), {name: 'AbortError'});
        await assert.rejects(ai.transitionProviders(ollamaRoutes('cancelled-before-selection'), cancelledOptions), {name: 'AbortError'});
        assert.equal(ai.model, selectedModel);
        assert.equal(generated.length, afterReentrantSelections);

        await ai.providerRuntime.load('llm');
        const cleanupGate = pauseLifecycle();
        unloadGate = cleanupGate;
        const cleanupCancellation = new AbortController();
        const beforeCleanupCancellation = generated.length;
        const cancelledCleanup = ai.transitionProviders(ollamaRoutes('cancelled-after-cleanup'), {
            signal: cleanupCancellation.signal
        });
        const cleanupRejection = assert.rejects(cancelledCleanup, {name: 'AbortError'});
        await cleanupGate.started.promise;
        cleanupCancellation.abort();
        cleanupGate.resolve();
        await cleanupRejection;
        assert.equal(ai.model, selectedModel, 'Cancelled cleanup must not commit replacement preferences');
        assert.equal(ai.providerRuntime.selection('llm').modelId, selectedModel);
        assert.equal(generated.length, beforeCleanupCancellation + 1, 'Only the accepted old-model unload may run');

        await ai.providerRuntime.load('llm');
        const supersededCleanupGate = pauseLifecycle();
        unloadGate = supersededCleanupGate;
        const oldCleanup = ai.transitionAI('OLLAMA', undefined, undefined, 'old-cleanup-raccoon');
        const oldCleanupRejection = assert.rejects(oldCleanup, {code: 'ARCANE_AI_OPERATION_SUPERSEDED'});
        await supersededCleanupGate.started.promise;
        const newCleanup = ai.transitionProviders(ollamaRoutes('new-cleanup-raccoon'), {startLanguageModel: false});
        supersededCleanupGate.resolve();
        await Promise.all([oldCleanupRejection, newCleanup]);
        assert.equal(ai.model, 'new-cleanup-raccoon');
        assert.equal(ai.providerRuntime.status('llm').state, 'unloaded');
        assert.equal(generated.some(function oldSelectionPreloaded(payload) {
            return payload.model === 'old-cleanup-raccoon';
        }), false);

        const cancelledLoadGate = pauseLifecycle();
        loadGate = cancelledLoadGate;
        const loadCancellation = new AbortController();
        const cancelledLoad = ai.transitionAI('OLLAMA', undefined, undefined, 'cancelled-raccoon', undefined, undefined, {
            signal: loadCancellation.signal
        });
        const loadRejection = assert.rejects(cancelledLoad, {name: 'AbortError'});
        const actualLoad = await cancelledLoadGate.started.promise;
        assert.equal(actualLoad.payload.model, 'cancelled-raccoon');
        loadCancellation.abort();
        await loadRejection;
        assert.equal(actualLoad.signal.aborted, true);
        assert.equal(ai.model, 'cancelled-raccoon', 'Already-committed selection remains explicit after load cancellation');
        const afterCancelledLoad = generated.length;
        publishReadiness();
        assert.equal(generated.length, afterCancelledLoad);
        assert.equal(ai.providerRuntime.status('llm').loaded, false);

        const supersededGate = pauseLifecycle();
        loadGate = supersededGate;
        const superseded = ai.transitionProviders(ollamaRoutes('superseded-raccoon'));
        const supersededRejection = assert.rejects(superseded);
        const supersededLoad = await supersededGate.started.promise;
        const replacement = await ai.transitionProviders(ollamaRoutes('selected-raccoon'), {startLanguageModel: false});
        await supersededRejection;
        assert.equal(supersededLoad.signal.aborted, true);
        assert.equal(replacement.llm.default.modelId, 'selected-raccoon');
        assert.equal(ai.model, 'selected-raccoon');
        assert.equal(ai.providerRuntime.status('llm').state, 'unloaded');
        assert.equal(generated.some(function selectedPreloaded(payload) {
            return payload.model === 'selected-raccoon' && payload.keep_alive !== 0;
        }), false);

        const completedSelection = new AbortController();
        await ai.transitionAI(...tuple, {signal: completedSelection.signal});
        const afterCompletedSelection = generated.length;
        completedSelection.abort();
        publishReadiness();
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
        assert.equal(generated.length, afterCompletedSelection, 'A completed selection is independent of later caller abort');
        await ai.providerRuntime.unload('llm');
        assert.equal(ai.setAI(...tuple), true);
        await ai.providerRuntime.load('llm');
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
        await ai.providerRuntime.unload('llm');
        ai.configureProviders(ollamaRoutes(selectedModel));
        await ai.providerRuntime.load('llm');
        assert.equal(ai.providerRuntime.status('llm').loaded, true);
    } finally {
        try {
            preload.resolve();
            for (const gate of lifecycleGates) gate.resolve();
            for (const stop of stateSubscriptions) stop();
            readinessEvents?.dispose();
            ai?.stopAudio();
            await ai?.transitionProviders({
                llm: {default: null, localOnly: null},
                stt: {default: null, localOnly: null},
                tts: {default: null, localOnly: null}
            }, {startLanguageModel: false});
            if (selectedModel === selectedModels.at(-1)) await ai?.providerRuntime.disposeAll();
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
