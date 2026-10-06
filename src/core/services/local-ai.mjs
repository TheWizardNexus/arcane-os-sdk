import {createArcaneEventSource} from '../../event-manager.mjs';
import Is from 'strong-type';
import path from 'node:path';
import {CoreError, serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';
import {structuredOutputFormat, openAIResponseFormat} from '../../../browser-runtime/ai/twin-cloud.mjs';
import {normalizeLocalAIConfig} from '../../local-ai/config.mjs';
import {createLocalAIServer} from '../../local-ai/server.mjs';
import {createONNXRuntime} from '../../local-ai/onnx.mjs';
import {encodeTensorMap, decodeTensorMap, decodeTensorFetches} from '../../../browser-runtime/ai/onnx-tensors.mjs';
import {requestLocalJSON, streamLocalJSON} from '../../local-ai/http.mjs';

const is = new Is(false);

function failure(code, message) {
    return new CoreError({code, message});
}

function upstreamFailure(value) {
    return new CoreError({code: 'LOCAL_AI_UPSTREAM_ERROR', message: value.error?.message ?? String(value.error), details: value});
}

function awaitReadiness(task, signal) {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise(function awaitSelectedEngine(resolve, reject) {
        function abort() { signal.removeEventListener('abort', abort); reject(signal.reason); }
        signal.addEventListener('abort', abort, {once: true});
        task.then(function ready(value) {
            signal.removeEventListener('abort', abort);
            if (signal.aborted) reject(signal.reason);
            else resolve(value);
        }, function failed(error) {
            signal.removeEventListener('abort', abort);
            reject(error);
        });
    });
}

/** Translate SDK option names only at the upstream HTTP protocol boundary. */
function llamaPayload(payload, model, stream) {
    const result = {...payload, model, stream};
    const names = {
        topK: 'top_k', topP: 'top_p', minP: 'min_p', repeatPenalty: 'repeat_penalty',
        maxTokens: 'max_tokens', maxOutputTokens: 'max_tokens', templateOptions: 'chat_template_kwargs',
        toolChoice: 'tool_choice', parallelToolCalls: 'parallel_tool_calls',
        reasoningEffort: 'reasoning_effort'
    };
    for (const [source, destination] of Object.entries(names)) {
        if (Object.hasOwn(result, source)) {
            if (!Object.hasOwn(result, destination)) result[destination] = result[source];
            delete result[source];
        }
    }
    if (Object.hasOwn(result, 'structuredOutput')) {
        const format = openAIResponseFormat(structuredOutputFormat(result.structuredOutput));
        if (format && !Object.hasOwn(result, 'response_format')) result.response_format = format;
        delete result.structuredOutput;
    }
    // These fields identify the SDK request and its presentation, not model input.
    delete result.id;
    delete result.seeThinking;
    return result;
}

/** Assemble actual OpenAI deltas while publishing each original chunk separately. */
function collectCompletion(completion, chunk) {
    const {choices = [], ...metadata} = chunk;
    Object.assign(completion, metadata);
    for (const value of choices) {
        const {delta, message, logprobs, ...fields} = value;
        let choice = completion.choices.find(function sameChoice(current) { return current.index === value.index; });
        if (!choice) {
            choice = {...fields, message: {}};
            completion.choices.push(choice);
        }
        Object.assign(choice, fields);
        if (logprobs) {
            choice.logprobs ??= {};
            for (const [key, data] of Object.entries(logprobs)) {
                if (is.array(data)) {
                    choice.logprobs[key] ??= [];
                    for (const record of data) choice.logprobs[key].push(record);
                } else if (data !== null || !Object.hasOwn(choice.logprobs, key)) {
                    choice.logprobs[key] = data;
                }
            }
        } else if (Object.hasOwn(value, 'logprobs') && !Object.hasOwn(choice, 'logprobs')) {
            choice.logprobs = logprobs;
        }
        if (message) choice.message = message;
        if (!delta) continue;
        for (const [key, data] of Object.entries(delta)) {
            if (key === 'tool_calls') {
                choice.message.tool_calls ??= [];
                for (const fragment of data) {
                    let call = choice.message.tool_calls.find(function sameCall(current) { return current.index === fragment.index; });
                    if (!call) {
                        call = {index: fragment.index};
                        choice.message.tool_calls.push(call);
                    }
                    for (const [field, content] of Object.entries(fragment)) {
                        if (field === 'function') {
                            call.function ??= {};
                            for (const [member, text] of Object.entries(content)) {
                                call.function[member] = is.string(text)
                                    ? (call.function[member] ?? '') + text : text;
                            }
                        } else if (field === 'type') call[field] = content;
                        else if (field !== 'index' && is.string(content)) {
                            call[field] = (call[field] ?? '') + content;
                        } else call[field] = content;
                    }
                }
            } else if (key === 'role') choice.message.role = data;
            else if (is.string(data)) choice.message[key] = (choice.message[key] ?? '') + data;
            else if (is.array(data)) choice.message[key] = [...(choice.message[key] ?? []), ...data];
            else if (data !== null || !Object.hasOwn(choice.message, key)) choice.message[key] = data;
        }
    }
    return completion;
}

/** Core owns native processes; applications own runtime and model selection. */
export function createLocalAIService(configuration, {appRoot, runtimes = [], signal, onEvent, prepare} = {}) {
    const config = normalizeLocalAIConfig(configuration) ?? {runtimes: []};
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const engines = new Map();
    const jobs = new Set();
    const owner = {};
    const events = createArcaneEventSource(owner, {source: 'core-local-ai', eventTypes: ['localai.state']});
    let context;
    let closed = false;
    let onnx;
    let onnxRecovery;
    let onnxRecoveryError;
    let stopONNXSubscription;
    const onnxSelected = config.runtimes.some(function selectedONNX(requirement) { return requirement.id === 'onnx'; });
    let onnxRecord = runtimes.find(function installedONNX(runtime) { return runtime.id === 'onnx'; });

    function onnxStatus() {
        const current = onnx?.current();
        return {
            id: 'onnx', installed: Boolean(onnxRecord?.modulePath),
            available: Boolean(current) && !current.closed && !closed && !onnxRecovery && !onnxRecoveryError && !lifetimeSignal.aborted,
            state: closed ? 'closed' : onnxRecovery ? 'recovering' : onnxRecoveryError ? 'error'
                : current?.closed ? 'closed' : lifetimeSignal.aborted ? 'closing' : onnx ? 'ready' : 'unavailable',
            models: current?.sessions ?? [], error: onnxRecoveryError ?? null
        };
    }

    function snapshot() {
        const records = [...engines.values()].map(function runtimeRecord(engine) { return {...engine.state, models: [...engine.models]}; });
        if (onnxSelected) records.push(onnxStatus());
        const ollama = records.find(function ollamaRecord(record) { return record.id === 'ollama'; });
        return {
            runtimes: records,
            ...(ollama ? {ollama, models: {ollama: ollama.models}} : {})
        };
    }

    function publish() {
        const state = snapshot();
        events.dispatch('localai.state', state);
        context?.emit('localai.state', state);
        return state;
    }

    function startONNX() {
        if (!onnxRecord?.modulePath) return;
        onnx = createONNXRuntime({modulePath: onnxRecord.modulePath, signal: lifetimeSignal, onEvent});
        stopONNXSubscription = onnx.subscribe(function onnxChanged() { publish(); });
    }

    function requireONNX() {
        lifetimeSignal.throwIfAborted();
        if (!onnxSelected) throw failure('LOCAL_AI_RUNTIME_NOT_SELECTED', 'ONNX is not selected in this application configuration.');
        if (!onnx || onnx.current().closed || onnxRecovery || onnxRecoveryError) {
            throw failure('LOCAL_AI_RUNTIME_UNAVAILABLE', 'The selected ONNX runtime is unavailable.');
        }
        return onnx;
    }

    function recoverONNX() {
        if (onnxRecovery) return onnxRecovery;
        onnxRecoveryError = undefined;
        onnxRecovery = Promise.resolve().then(async function replaceONNXOwner() {
            await onnx?.close();
            stopONNXSubscription?.();
            onnx = undefined;
            lifetimeSignal.throwIfAborted();
            startONNX();
        });
        function recovered() { onnxRecovery = undefined; if (!closed) publish(); }
        function recoveryFailed(error) { onnxRecoveryError = serializeCoreError(error); recovered(); }
        onnxRecovery.then(recovered, recoveryFailed);
        publish();
        return onnxRecovery;
    }

    function recordFailure(engine, error) {
        if (!closed && error.code === 'LOCAL_AI_LOADING') {
            engine.state = {...engine.state, available: false, state: 'loading', error: null};
            publish();
            return;
        }
        engine.state = {...engine.state, available: false, state: closed ? 'closed' : 'error', error: serializeCoreError(error)};
        publish();
    }

    function recordOllamaModels(engine, catalog, running, revision) {
        if (revision < engine.ollamaAppliedRevision) return;
        engine.ollamaAppliedRevision = revision;
        const resident = new Map((running.models ?? []).map(function residentModel(model) {
            return [model.model ?? model.name, model];
        }));
        const models = new Map((catalog.models ?? []).map(function catalogModel(model) {
            const id = model.model ?? model.name ?? model.id;
            return [id, {...model, id, loaded: resident.has(id)}];
        }));
        for (const [id, model] of resident) {
            if (!models.has(id)) models.set(id, {...model, id, loaded: true});
        }
        engine.models = [...models.values()];
    }

    async function refreshModels(engine, signal) {
        const revision = engine.revision;
        if (engine.id === 'ollama') {
            const observation = ++engine.ollamaRevision;
            const [catalog, running] = await Promise.all([
                requestLocalJSON({url: engine.server.url, path: '/api/tags', signal}),
                requestLocalJSON({url: engine.server.url, path: '/api/ps', signal})
            ]);
            signal?.throwIfAborted();
            recordOllamaModels(engine, catalog, running, observation);
        } else {
            const properties = await requestLocalJSON({url: engine.server.url, path: '/props', signal});
            engine.router = properties.role === 'router';
            let catalog;
            try {
                catalog = await requestLocalJSON({url: engine.server.url, path: '/models', signal});
            } catch (error) {
                if (error.status !== 404) throw error;
                catalog = await requestLocalJSON({url: engine.server.url, path: '/v1/models', signal});
            }
            const models = (catalog.data ?? []).map(function llamaModel(model) {
                return {...model,
                    ...(!engine.router ? {status: {value: properties.is_sleeping ? 'sleeping' : 'loaded'}} : {}),
                    loaded: engine.router ? model.status?.value === 'loaded' : properties.is_sleeping === false
                };
            });
            // A snapshot must not replace lifecycle events received after it began.
            const current = new Map(engine.models.map(function modelEntry(model) { return [model.id, model]; }));
            const merged = new Map(models.map(function modelEntry(model) { return [model.id, model]; }));
            for (const [id, changedAt] of engine.modelChanges) {
                if (changedAt <= revision) continue;
                if (current.has(id)) merged.set(id, current.get(id));
                else merged.delete(id);
            }
            engine.models = [...merged.values()];
        }
        publish();
        return {...engine.state, models: [...engine.models]};
    }

    function observeModels(engine) {
        const signal = engine.signal;
        let opened;
        let failed;
        const connected = new Promise(function eventConnection(resolve, reject) { opened = resolve; failed = reject; });
        const task = (async function watchModelLifecycle() {
            for await (const event of streamLocalJSON({
                url: engine.server.url, path: '/models/sse', method: 'GET', format: 'sse',
                signal, onOpen: opened
            })) {
                if (event.event === 'model_status' || event.event === 'status_change') {
                    engine.modelChanges.set(event.model, ++engine.revision);
                    let model = engine.models.find(function matchingModel(value) { return value.id === event.model; });
                    if (!model) { model = {id: event.model}; engine.models.push(model); }
                    model.status = {...event.data, value: event.data.status,
                        ...(event.data.status === 'unloaded' && event.data.exit_code !== undefined
                            ? {failed: event.data.exit_code !== 0} : {})};
                    model.loaded = event.data.status === 'loaded';
                    publish();
                } else if (event.event === 'model_remove') {
                    engine.modelChanges.set(event.model, ++engine.revision);
                    engine.models = engine.models.filter(function retainedModel(model) { return model.id !== event.model; });
                    publish();
                } else if (event.event === 'models_reload') await refreshModels(engine, signal);
                context?.emit('llama.model.event', event);
            }
            if (!signal.aborted) throw failure('LOCAL_AI_EVENT_CONNECTION_CLOSED', 'The llama.cpp model event connection closed.');
        })();
        jobs.add(task);
        task.then(function eventStreamClosed() {
            jobs.delete(task);
        }, function eventStreamFailed(error) {
            jobs.delete(task);
            failed(error);
            if (!signal.aborted) recordFailure(engine, error);
        });
        return connected;
    }

    function restartEngine(engine) {
        if (engine.recovering) return engine.recovering;
        const recovering = Promise.resolve().then(async function recoverSelectedEngine() {
            lifetimeSignal.throwIfAborted();
            engine.controller.abort();
            await engine.server.close();
            await Promise.allSettled([...engine.loads.values()]);
            lifetimeSignal.throwIfAborted();
            engine.models = [];
            engine.modelChanges.clear();
            engine.revision = 0;
            engine.released = false;
            startEngine(engine);
        });
        engine.recovering = recovering;
        function releaseRecovery() {
            if (engine.recovering === recovering) engine.recovering = null;
        }
        recovering.then(releaseRecovery, releaseRecovery);
        return recovering;
    }

    async function engineReady(id, signal, {retryLoading = false} = {}) {
        signal?.throwIfAborted();
        const engine = engines.get(id);
        if (!engine) throw failure('LOCAL_AI_RUNTIME_NOT_SELECTED', `${id} is not selected in this application's localAI configuration.`);
        if (engine.recovering) await awaitReadiness(engine.recovering, signal);
        if (engine.stopping) await awaitReadiness(engine.stopping, signal);
        // An external server exposes no readiness subscription during initial
        // loading. A new explicit load makes one fresh attempt, without polling.
        if (retryLoading && engine.state.state === 'loading') {
            await awaitReadiness(restartEngine(engine), signal);
        }
        if (engine.released) { engine.released = false; startEngine(engine); }
        await awaitReadiness(engine.ready, signal);
        signal?.throwIfAborted();
        if (!engine.state.available) throw failure('LOCAL_AI_RUNTIME_UNAVAILABLE', `${id} is unavailable.`);
        return engine;
    }

    function waitForModel(engine, model, signal) {
        return new Promise(function awaitModel(resolve, reject) {
            let unsubscribe;
            function cleanup() { unsubscribe?.(); signal?.removeEventListener('abort', abort); }
            function abort() { cleanup(); reject(signal.reason); }
            function inspect() {
                const selected = engine.models.find(function matchingModel(value) { return value.id === model; });
                if (signal?.aborted) return abort();
                if (selected?.loaded) { cleanup(); resolve(); }
                else if (engine.state.error || selected?.status?.failed) {
                    cleanup(); reject(failure('LOCAL_AI_MODEL_LOAD_FAILED', `llama.cpp could not load ${model}.`));
                }
            }
            unsubscribe = events.on('localai.state', inspect);
            signal?.addEventListener('abort', abort, {once: true});
            inspect();
        });
    }

    async function prepareLlamaModel(engine, model, signal) {
        if (!engine.router || !engine.models.some(function matchingModel(value) { return value.id === model; })) {
            await refreshModels(engine, signal);
        }
        const selected = engine.models.find(function matchingModel(value) { return value.id === model; });
        if (selected?.loaded) {
            return {...engine.state, models: [...engine.models]};
        }
        if (!selected) throw failure('LOCAL_AI_MODEL_UNAVAILABLE', `The running llama.cpp server does not expose ${model}.`);
        const loaded = engine.router ? waitForModel(engine, model, signal) : Promise.resolve();
        loaded.catch(function observedModelWait() {});
        if (selected.status?.value === 'sleeping') {
            // Tokenization wakes upstream's sleeping model without generating a reply.
            await requestLocalJSON({url: engine.server.url, path: '/tokenize', method: 'POST', payload: {model, content: ''}, signal});
        } else if (selected.status?.value !== 'loading') {
            await requestLocalJSON({url: engine.server.url, path: '/models/load', method: 'POST', payload: {model}, signal});
        }
        await refreshModels(engine, signal);
        await loaded;
        if (!engine.models.some(function loadedModel(value) { return value.id === model && value.loaded; })) {
            throw failure('LOCAL_AI_MODEL_NOT_READY', `The llama.cpp model ${model} has not reported readiness.`);
        }
        return {...engine.state, models: [...engine.models]};
    }

    async function loadLlama({model}, request) {
        const engine = await engineReady('llama.cpp', request.signal, {retryLoading: true});
        let task = engine.loads.get(model);
        if (!task) {
            const controller = new AbortController();
            engine.loadControllers.set(model, controller);
            task = prepareLlamaModel(engine, model, AbortSignal.any([engine.signal, controller.signal]));
            engine.loads.set(model, task);
            function releaseLoad() {
                controller.abort();
                if (engine.loads.get(model) === task) {
                    engine.loads.delete(model);
                    engine.loadControllers.delete(model);
                }
            }
            task.then(releaseLoad, releaseLoad);
        }
        return awaitReadiness(task, request.signal);
    }

    async function chatLlama({model, payload, stream = false, streamId}, request) {
        model = payload?.model ?? model;
        const engine = await engineReady('llama.cpp', request.signal, {retryLoading: true});
        await loadLlama({model}, request);
        const controller = new AbortController();
        const signal = AbortSignal.any([request.signal, engine.signal, controller.signal]);
        function preserveReadiness() {
            if (!engine.state.available || !engine.models.some(function loadedModel(value) { return value.id === model && value.loaded; })) {
                controller.abort(failure('LOCAL_AI_MODEL_NOT_READY', `The selected llama.cpp model ${model} is not ready.`));
            }
        }
        const unsubscribe = events.on('localai.state', preserveReadiness);
        preserveReadiness();
        try {
            signal.throwIfAborted();
            const body = llamaPayload(payload, model, stream);
            if (!stream) {
                const result = await requestLocalJSON({url: engine.server.url, path: '/v1/chat/completions', method: 'POST', payload: body, signal});
                signal.throwIfAborted();
                if (result?.error) throw upstreamFailure(result);
                return result;
            }
            const completion = {choices: []};
            for await (const chunk of streamLocalJSON({url: engine.server.url, path: '/v1/chat/completions', payload: body, signal, format: 'sse'})) {
                request.emit('llama.chunk', {streamId, chunk});
                if (chunk.error) throw upstreamFailure(chunk);
                collectCompletion(completion, chunk);
            }
            signal.throwIfAborted();
            return completion;
        } finally { unsubscribe(); }
    }

    async function ollamaRequest(operation, parameters = {}, request, method = 'POST') {
        const engine = await engineReady('ollama', request.signal);
        const observation = operation === 'ps' ? ++engine.ollamaRevision : null;
        try {
            const result = await ollamaResponse(engine, operation, parameters, request, method);
            if (operation === 'ps') {
                recordOllamaModels(engine, {models: engine.models}, result, observation);
                publish();
            }
            return result;
        } catch (error) {
            if (operation === 'ps' && !request.signal.aborted && !engine.signal.aborted) recordFailure(engine, error);
            throw error;
        } finally {
            // Every owned operation that can change residency/catalog leaves
            // a real upstream observation, including cancellation or failure.
            if (['chat', 'generate', 'embed', 'pull', 'create', 'copy', 'delete'].includes(operation)
                && !engine.signal.aborted) {
                try {
                    await refreshModels(engine, engine.signal);
                } catch (error) {
                    if (!engine.signal.aborted) recordFailure(engine, error);
                }
            }
        }
    }

    async function ollamaResponse(engine, operation, parameters, request, method) {
        const signal = AbortSignal.any([request.signal, engine.signal]);
        const {streamId, ...payload} = parameters;
        if (payload.stream !== true) {
            const streamingAPI = ['chat', 'generate', 'pull', 'push', 'create'].includes(operation);
            const body = streamingAPI ? {...payload, stream: false} : payload;
            const result = await requestLocalJSON({url: engine.server.url, path: `/api/${operation}`, method, payload: method === 'GET' ? undefined : body, signal});
            if (result?.error) throw upstreamFailure(result);
            return result;
        }
        let result;
        const message = {};
        let content = '';
        let thinking = '';
        let response = '';
        let generatedThinking;
        let hasLogprobs = false;
        const logprobs = [];
        const calls = [];
        for await (const chunk of streamLocalJSON({url: engine.server.url, path: `/api/${operation}`, payload, signal, format: 'ndjson'})) {
            request.emit('ollama.chunk', {streamId, chunk});
            if (chunk.error) throw upstreamFailure(chunk);
            result = chunk;
            if (chunk.message) Object.assign(message, chunk.message);
            if (is.string(chunk.response)) response += chunk.response;
            if (is.string(chunk.thinking)) generatedThinking = (generatedThinking ?? '') + chunk.thinking;
            if (is.array(chunk.logprobs)) {
                hasLogprobs = true;
                for (const record of chunk.logprobs) logprobs.push(record);
            }
            if (is.string(chunk.message?.content)) content += chunk.message.content;
            if (is.string(chunk.message?.thinking)) thinking += chunk.message.thinking;
            if (chunk.message?.tool_calls) calls.push(...chunk.message.tool_calls);
        }
        if (!result) throw failure('LOCAL_AI_EMPTY_STREAM', 'Ollama closed the stream without a response.');
        if (operation === 'generate') return {...result, response,
            ...(generatedThinking !== undefined ? {thinking: generatedThinking} : {}),
            ...(hasLogprobs ? {logprobs} : {})};
        if (operation === 'chat') return {...result, ...(hasLogprobs ? {logprobs} : {}),
            message: {...message, content, ...(thinking ? {thinking} : {}), ...(calls.length ? {tool_calls: calls} : {})}};
        return result;
    }

    function startEngine(engine) {
        engine.controller = new AbortController();
        engine.signal = AbortSignal.any([lifetimeSignal, engine.controller.signal]);
        engine.ollamaRevision = 0;
        engine.ollamaAppliedRevision = 0;
        const signal = engine.signal;
        engine.server = createLocalAIServer({
            id: engine.id, appRoot, runtime: runtimes.find(function runtimeRecord(record) { return record.id === engine.id; }),
            configuration: engine.id === 'llama.cpp' ? config.llamaCpp : config.ollama,
            signal, onEvent,
            onState(state) { engine.state = {...engine.state, ...state, error: state.error ?? null}; publish(); }
        });
        engine.ready = engine.server.ready.then(async function prepareModelCatalog() {
            await refreshModels(engine, signal);
            if (engine.id === 'llama.cpp' && engine.router) {
                await observeModels(engine);
                await refreshModels(engine, signal);
            }
            return engine;
        });
        engine.ready.catch(function startupFailed(error) { if (!signal.aborted) recordFailure(engine, error); });
    }

    const service = {
        name: 'local-ai',
        current: snapshot,
        async start(currentContext) {
            context = currentContext;
            if (prepare) {
                runtimes = await prepare({signal: lifetimeSignal, onEvent});
                lifetimeSignal.throwIfAborted();
                onnxRecord = runtimes.find(function installedONNX(runtime) { return runtime.id === 'onnx'; });
            }
            for (const requirement of config.runtimes) {
                if (!['llama.cpp', 'ollama', 'onnx'].includes(requirement.id)) {
                    throw failure('LOCAL_AI_RUNTIME_UNAVAILABLE', `Core runtime ${requirement.id} is not available in this service.`);
                }
            }
            for (const requirement of config.runtimes) {
                if (requirement.id === 'onnx') { if (!onnx) startONNX(); continue; }
                if (engines.has(requirement.id)) continue;
                const engine = {
                    id: requirement.id, models: [], revision: 0, modelChanges: new Map(), loads: new Map(), loadControllers: new Map(),
                    state: {id: requirement.id, installed: runtimes.some(function installed(record) { return record.id === requirement.id && record.executable; }), available: false, state: 'starting'}
                };
                engines.set(engine.id, engine);
                startEngine(engine);
            }
            publish();
        },
        methods: {
            'localai.services.recover': async function recoverServices({runtimes: selected = [...engines.keys(), ...(onnxSelected ? ['onnx'] : [])]} = {}, request) {
                request.signal.throwIfAborted();
                const selectedEngines = selected.map(function selectedEngine(id) {
                    if (id === 'onnx' && onnxSelected) return {id};
                    const engine = engines.get(id);
                    if (!engine) throw failure('LOCAL_AI_RUNTIME_NOT_SELECTED', `${id} is not selected in this application's localAI configuration.`);
                    return engine;
                });
                await Promise.all(selectedEngines.map(async function recoverEngine(engine) {
                    if (engine.id === 'onnx') {
                        await awaitReadiness(recoverONNX(), request.signal);
                        return;
                    }
                    await awaitReadiness(restartEngine(engine), request.signal);
                    await awaitReadiness(engine.ready, request.signal);
                }));
                return snapshot();
            },
            'onnx.status': function currentONNX() { return onnxStatus(); },
            'onnx.load': function loadONNX({id, model, sessionOptions}, request) {
                return requireONNX().load({id, model: path.resolve(appRoot ?? process.cwd(), model), sessionOptions,
                    signal: AbortSignal.any([lifetimeSignal, request.signal])});
            },
            'onnx.run': async function runONNX({id, feeds, fetches, runOptions}, request) {
                const outputs = await requireONNX().run({id, feeds: decodeTensorMap(feeds),
                    fetches: decodeTensorFetches(fetches),
                    runOptions, signal: AbortSignal.any([lifetimeSignal, request.signal])});
                return encodeTensorMap(outputs);
            },
            'onnx.unload': function unloadONNX({id}, request) {
                return requireONNX().unload({id, signal: AbortSignal.any([lifetimeSignal, request.signal])});
            },
            'localai.status': async function currentStatus(_parameters, request) {
                await Promise.all([...engines.values()].map(async function refreshEngine(engine) {
                    if (!engine.state.available) return;
                    try {
                        await refreshModels(engine, request.signal);
                    } catch (error) {
                        request.signal.throwIfAborted();
                        recordFailure(engine, error);
                    }
                }));
                return snapshot();
            },
            'llama.status': async function llamaStatus(_parameters, request) {
                const engine = await engineReady('llama.cpp', request.signal);
                return refreshModels(engine, request.signal);
            },
            'llama.models': async function llamaModels(_parameters, request) {
                const engine = await engineReady('llama.cpp', request.signal);
                const status = await refreshModels(engine, request.signal);
                return {models: status.models};
            },
            'llama.load': loadLlama,
            'llama.unload': async function unloadLlama({model}, request) {
                const engine = await engineReady('llama.cpp', request.signal);
                engine.loadControllers.get(model)?.abort(failure('LOCAL_AI_MODEL_UNLOADED', `The application unloaded ${model}.`));
                if (engine.loads.has(model)) await Promise.allSettled([engine.loads.get(model)]);
                if (!engine.router) {
                    if (!engine.server.owned) return {...engine.state, models: [...engine.models], released: true, unloaded: false};
                    engine.controller.abort();
                    engine.stopping = engine.server.close();
                    await engine.stopping;
                    engine.stopping = null;
                    engine.released = true;
                    engine.models = engine.models.map(function unloadedModel(value) { return {...value, loaded: false}; });
                    publish();
                    return {...engine.state, models: [...engine.models], released: true, unloaded: true};
                }
                await requestLocalJSON({url: engine.server.url, path: '/models/unload', method: 'POST', payload: {model}, signal: request.signal});
                return refreshModels(engine, request.signal);
            },
            'llama.chat': chatLlama,
            'ollama.version': function version(parameters, request) { return ollamaRequest('version', parameters, request, 'GET'); },
            'ollama.models': function models(parameters, request) { return ollamaRequest('tags', parameters, request, 'GET'); },
            'ollama.running': function running(parameters, request) { return ollamaRequest('ps', parameters, request, 'GET'); },
            'ollama.show': function show(parameters, request) { return ollamaRequest('show', parameters, request); },
            'ollama.chat': function chat(parameters, request) { return ollamaRequest('chat', parameters, request); },
            'ollama.generate': function generate(parameters, request) { return ollamaRequest('generate', parameters, request); },
            'ollama.embed': function embed(parameters, request) { return ollamaRequest('embed', parameters, request); },
            'ollama.pull': function pull(parameters, request) { return ollamaRequest('pull', parameters, request); },
            'ollama.push': function push(parameters, request) { return ollamaRequest('push', parameters, request); },
            'ollama.create': function create(parameters, request) { return ollamaRequest('create', parameters, request); },
            'ollama.copy': function copy(parameters, request) { return ollamaRequest('copy', parameters, request); },
            'ollama.delete': function remove(parameters, request) { return ollamaRequest('delete', parameters, request, 'DELETE'); }
        },
        async dispose() {
            closed = true;
            lifetime.abort();
            const results = await Promise.allSettled([
                ...[...engines.values()].map(function stopEngine(engine) { return engine.server.close(); }),
                ...(onnx ? [onnx.close()] : [])
            ]);
            stopONNXSubscription?.();
            await Promise.allSettled([...jobs, ...(onnxRecovery ? [onnxRecovery] : []), ...[...engines.values()].flatMap(function pendingWork(engine) {
                return [...engine.loads.values(), ...(engine.recovering ? [engine.recovering] : [])];
            })]);
            events.dispose();
            const failures = results.filter(function failed(result) { return result.status === 'rejected'; }).map(function cause(result) { return result.reason; });
            if (failures.length) throw new AggregateError(failures, 'Local AI shutdown failed.');
        }
    };
    return service;
}

export default createLocalAIService;
