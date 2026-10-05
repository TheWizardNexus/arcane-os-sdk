import Is from '../dependencies/strong-type/index.js';
import {getInstalledCoreClient} from '../core/client.mjs';

const is = new Is(false);
const PROVIDER_PROTOCOL = 'arcane-ai-provider/2';
const AUTHORITY_PROTOCOL = 'arcane-ai-model-authority/1';

function localAIError(code, message, cause) {
    const error = cause === undefined ? new Error(message) : new Error(message, {cause});
    error.code = code;
    return error;
}

function cancelled(reason) {
    const error = localAIError('ARCANE_AI_REQUEST_ABORTED', 'The local AI request was cancelled.', reason);
    error.name = 'AbortError';
    return error;
}

/**
 * Browser-safe llama.cpp access through an existing Core connection. The app
 * selects its model; Core owns the running engine and its loaded sessions.
 * Creating this provider neither connects a transport nor installs a runtime.
 */
export function createCoreLocalAIProvider({client = getInstalledCoreClient(), id = 'llama.cpp'} = {}) {
    if (!is.string(id) || !id.trim()) throw new TypeError('The Core AI provider id must be a nonempty string.');
    if (client !== null && (!is.function(client?.invoke) || !is.function(client?.events?.on))) {
        throw new TypeError('The Core AI client must expose invoke and events.on.');
    }

    let runtime = null;
    let models = [];
    let selection = null;
    let disposed = false;
    let loading = false;
    let sequence = 0;
    let lifecycleRevision = 0;
    const requests = new Set();

    function requireClient() {
        if (disposed) throw localAIError('ARCANE_AI_PROVIDER_DISPOSED', 'The Core AI provider is disposed.');
        if (!client) throw localAIError('ARCANE_AI_CORE_UNAVAILABLE', 'Local llama.cpp requires an available Core connection.');
        return client;
    }

    function requireSelection(value) {
        if (value?.providerId !== id || !is.string(value?.modelId) || !value.modelId
            || value.localOnly !== true) {
            throw localAIError('ARCANE_AI_MODEL_AUTHORITY_REQUIRED', 'The local provider requires an explicit matching provider and model.');
        }
        return value;
    }

    function loadedModel() {
        return selection && models.find(function selectedModel(model) {
            return model.id === selection.modelId && model.loaded === true;
        });
    }

    function modelReady() {
        return runtime?.available === true && runtime.state === 'ready' && Boolean(loadedModel());
    }

    function status() {
        const loaded = !disposed && modelReady();
        return {
            state: disposed ? 'disposed' : loading ? 'loading' : loaded ? 'ready'
                : runtime?.error ? 'error' : runtime?.available === true ? 'unloaded' : 'unavailable',
            loaded,
            busy: loading || requests.size > 0,
            modelId: selection?.modelId ?? null,
            available: !disposed && runtime?.available === true,
            installed: runtime?.installed === true,
            error: runtime?.error ?? null
        };
    }

    function acceptRuntime(value) {
        runtime = value ?? null;
        models = is.array(runtime?.models) ? runtime.models : [];
        for (const request of requests) {
            const model = models.find(function requestModel(record) { return record.id === request.modelId; });
            if (model?.loaded === true) request.loaded = true;
            if (runtime?.available !== true || (request.loaded && (runtime.state !== 'ready' || model?.loaded !== true))) {
                request.controller.abort(localAIError('ARCANE_AI_MODEL_NOT_READY', 'The requested local model is no longer ready.', runtime?.error));
            }
        }
        return status();
    }

    const unsubscribe = client?.events.on('localai.state', function localRuntimeChanged(snapshot) {
        if (disposed || !is.array(snapshot?.runtimes)) return;
        lifecycleRevision += 1;
        acceptRuntime(snapshot.runtimes.find(function llamaRuntime(value) {
            return value.id === 'llama.cpp';
        }));
    }) ?? function noCoreSubscription() {};

    function authority(value) {
        return {protocol: AUTHORITY_PROTOCOL, providerId: id, modelId: value.modelId};
    }

    async function inspect(value, {signal} = {}) {
        requireSelection(value);
        if (signal?.aborted) throw cancelled(signal.reason);
        try {
            const core = requireClient();
            const statusRevision = lifecycleRevision;
            const current = await core.invoke('llama.status', {}, {signal});
            if (lifecycleRevision === statusRevision) acceptRuntime(current);
            if (runtime?.available !== true) {
                return {
                    available: false,
                    code: 'ARCANE_AI_PROVIDER_UNAVAILABLE',
                    message: 'The local llama.cpp runtime is unavailable.',
                    error: runtime?.error ?? null
                };
            }
            if (!models.some(function matchesModel(model) { return model.id === value.modelId; })) {
                return {
                    available: false,
                    code: 'ARCANE_AI_MODEL_UNAVAILABLE',
                    message: 'The selected model is unavailable in the local llama.cpp runtime.'
                };
            }
            return {available: true, authority: authority(value)};
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            acceptRuntime({...runtime, available: false, state: 'error', error});
            return {available: false, code: error.code ?? 'ARCANE_AI_CORE_UNAVAILABLE', message: error.message, error};
        }
    }

    async function load({selection: value, signal, progress} = {}) {
        const core = requireClient();
        requireSelection(value);
        if (signal?.aborted) throw cancelled(signal.reason);
        selection = value;
        loading = true;
        try {
            progress?.({phase: 'loading', modelId: value.modelId});
            const revision = lifecycleRevision;
            const current = await core.invoke('llama.load', {model: value.modelId}, {signal});
            if (lifecycleRevision === revision) acceptRuntime(current);
            if (!modelReady()) throw localAIError('ARCANE_AI_MODEL_NOT_READY', 'Core did not report the selected model loaded and ready.', current?.error);
            progress?.({phase: 'ready', modelId: value.modelId});
            return {authority: authority(value), status: {...status(), state: 'ready', busy: false}};
        } finally {
            loading = false;
        }
    }

    function ownRequest(signal, modelId) {
        const controller = new AbortController();
        function forwardAbort() { controller.abort(signal.reason); }
        signal?.addEventListener('abort', forwardAbort, {once: true});
        if (signal?.aborted) forwardAbort();
        const request = {controller, result: null, modelId, loaded: models.some(function loadedTarget(model) {
            return model.id === modelId && model.loaded === true;
        })};
        requests.add(request);
        request.release = function releaseRequest() {
            signal?.removeEventListener('abort', forwardAbort);
            requests.delete(request);
        };
        return request;
    }

    function streamRequest(core, parameters, signal) {
        const request = ownRequest(signal, parameters.model);
        const chunks = [];
        const readers = [];
        let complete = false;
        let failure = null;
        sequence += 1;
        const streamId = is.function(core.uuid) ? core.uuid()
            : globalThis.crypto?.randomUUID?.() ?? `${id}:${Date.now()}:${sequence}:${Math.random()}`;

        function flush() {
            while (readers.length && chunks.length && !request.controller.signal.aborted) {
                readers.shift().resolve({value: chunks.shift(), done: false});
            }
            if (!complete || (chunks.length && !request.controller.signal.aborted)) return;
            while (readers.length) {
                const reader = readers.shift();
                if (failure) reader.reject(failure);
                else reader.resolve({value: undefined, done: true});
            }
        }

        const stopChunks = core.events.on('llama.chunk', function receiveChunk(event) {
            if (event?.streamId !== streamId || complete || request.controller.signal.aborted) return;
            chunks.push(event.chunk);
            flush();
        });

        request.result = Promise.resolve().then(function invokeStream() {
            return core.invoke('llama.chat', {...parameters, stream: true, streamId}, {signal: request.controller.signal});
        }).then(function streamCompleted(result) {
            if (request.controller.signal.aborted) throw cancelled(request.controller.signal.reason);
            return result;
        }).catch(function streamFailed(error) {
            failure = error;
            throw error;
        }).finally(function releaseStream() {
            complete = true;
            stopChunks();
            request.release();
            flush();
        });
        request.result.catch(function observeRetainedStreamFailure() {});

        function cancel(reason) {
            if (!complete) request.controller.abort(reason);
            return request.result.then(function cancelledAfterSuccess() {}, function cancelledAfterFailure() {});
        }

        return {
            result: request.result,
            cancel,
            [Symbol.asyncIterator]() {
                return {
                    next() {
                        if (request.controller.signal.aborted) return Promise.reject(failure ?? cancelled(request.controller.signal.reason));
                        if (chunks.length) return Promise.resolve({value: chunks.shift(), done: false});
                        if (complete) return failure ? Promise.reject(failure) : Promise.resolve({value: undefined, done: true});
                        return new Promise(function awaitChunk(resolve, reject) { readers.push({resolve, reject}); });
                    },
                    async return() {
                        await cancel();
                        return {value: undefined, done: true};
                    }
                };
            }
        };
    }

    async function request({selection: value, operation, payload, signal} = {}) {
        const core = requireClient();
        requireSelection(value);
        if (signal?.aborted) throw cancelled(signal.reason);
        if (loading || selection?.modelId !== value.modelId) {
            throw localAIError('ARCANE_AI_MODEL_NOT_READY', 'Load the selected local model before requesting inference.');
        }
        const model = payload?.model ?? value.modelId;
        if (!models.some(function knownModel(record) { return record.id === model; })) {
            const revision = lifecycleRevision;
            const current = await core.invoke('llama.status', {}, {signal});
            if (lifecycleRevision === revision) acceptRuntime(current);
        }
        if (!models.some(function knownModel(record) { return record.id === model; })) {
            throw localAIError('ARCANE_AI_MODEL_UNAVAILABLE', 'The requested model is unavailable in the local llama.cpp runtime.');
        }
        if (runtime?.available !== true || runtime.state !== 'ready'
            || (model === value.modelId && !modelReady())) {
            throw localAIError('ARCANE_AI_MODEL_NOT_READY', 'The requested local runtime or selected model is not ready.');
        }
        const parameters = {model, payload};
        if (operation === 'stream') return streamRequest(core, parameters, signal);
        if (operation !== 'chat') throw localAIError('ARCANE_AI_PROVIDER_OPERATION_UNAVAILABLE', 'The local llama.cpp provider supports chat and stream.');
        const pending = ownRequest(signal, model);
        pending.result = Promise.resolve().then(function invokeChat() {
            return core.invoke('llama.chat', {...parameters, stream: false}, {signal: pending.controller.signal});
        }).then(function chatCompleted(result) {
            if (pending.controller.signal.aborted) throw cancelled(pending.controller.signal.reason);
            return result;
        }).finally(pending.release);
        return pending.result;
    }

    async function unload({selection: value = selection, signal} = {}) {
        const core = requireClient();
        if (signal?.aborted) throw cancelled(signal.reason);
        for (const request of requests) request.controller.abort();
        await Promise.allSettled([...requests].map(function activeResult(request) { return request.result; }));
        if (!value) return status();
        requireSelection(value);
        const revision = lifecycleRevision;
        const current = await core.invoke('llama.unload', {model: value.modelId}, {signal});
        if (lifecycleRevision === revision) acceptRuntime(current);
        selection = null;
        return status();
    }

    async function dispose(options = {}) {
        if (disposed) return status();
        if (selection || requests.size) await unload(options);
        disposed = true;
        unsubscribe();
        return status();
    }

    return {
        protocol: PROVIDER_PROTOCOL,
        role: 'llm',
        id,
        localOnly: true,
        catalog: function catalog() { return [...models]; },
        status,
        inspect,
        load,
        request,
        unload,
        dispose
    };
}
