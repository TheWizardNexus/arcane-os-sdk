import Is from '../dependencies/strong-type/index.js';
import {subscribeCoreClient} from '../core/client.mjs';

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
export function createCoreLocalAIProvider({client: suppliedClient, id = 'llama.cpp'} = {}) {
    if (!is.string(id) || !id.trim()) throw new TypeError('The Core AI provider id must be a nonempty string.');
    if (suppliedClient !== undefined && suppliedClient !== null
        && (!is.function(suppliedClient?.invoke) || !is.function(suppliedClient?.events?.on))) {
        throw new TypeError('The Core AI client must expose invoke and events.on.');
    }

    let runtime = null;
    let models = [];
    let selection = null;
    let selectionConnection = null;
    let disposed = false;
    let loading = false;
    let unloading = false;
    let sequence = 0;
    let lifecycleRevision = 0;
    let client = null;
    let connection = null;
    let stopInstallation;
    let disposing;
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
        return !unloading && selectionConnection === connection && runtime?.available === true
            && runtime.state === 'ready' && Boolean(loadedModel());
    }

    function assertCurrentConnection(value) {
        if (disposed || connection !== value) throw cancelled();
        value.controller.signal.throwIfAborted();
    }

    function status() {
        const loaded = !disposed && modelReady();
        return {
            state: disposed ? 'disposed' : loading ? 'loading' : loaded ? 'ready'
                : runtime?.error ? 'error' : runtime?.available === true ? 'unloaded' : 'unavailable',
            loaded,
            busy: Boolean(loading || unloading) || [...requests].some(function currentRequest(request) {
                return request.connection === connection && !request.controller.signal.aborted;
            }),
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
            if (request.connection !== connection || request.modelId === null) continue;
            const model = models.find(function requestModel(record) { return record.id === request.modelId; });
            if (model?.loaded === true) request.loaded = true;
            if (runtime?.available !== true || (request.loaded && (runtime.state !== 'ready' || model?.loaded !== true))) {
                request.controller.abort(localAIError('ARCANE_AI_MODEL_NOT_READY', 'The requested local model is no longer ready.', runtime?.error));
            }
        }
        return status();
    }

    function bindClient({client: nextClient, error = null}) {
        if (disposed || (connection && nextClient === client)) return;
        const previous = connection;
        client = nextClient;
        const currentConnection = {client, controller: new AbortController(), unsubscribe: null};
        connection = currentConnection;
        lifecycleRevision += 1;
        loading = false;
        unloading = false;
        runtime = {installed: false, available: false, state: client ? 'unknown' : 'unavailable', error};
        models = [];
        previous?.unsubscribe?.();
        previous?.controller.abort();
        if (client) {
            currentConnection.unsubscribe = client.events.on(
                'localai.state',
                function localRuntimeChanged(snapshot) {
                    if (disposed || connection !== currentConnection || !is.array(snapshot?.runtimes)) return;
                    lifecycleRevision += 1;
                    acceptRuntime(snapshot.runtimes.find(function llamaRuntime(value) {
                        return value.id === 'llama.cpp';
                    }));
                }
            );
        }
        if (client && suppliedClient === undefined) {
            const revision = lifecycleRevision;
            invokeOwned(client, 'llama.status', {}).then(
                function installedRuntimeObserved(value) {
                    if (!disposed && connection === currentConnection && lifecycleRevision === revision) acceptRuntime(value);
                },
                function installedRuntimeFailed(error) {
                    if (!disposed && connection === currentConnection && lifecycleRevision === revision) {
                        acceptRuntime({...runtime, available: false, state: 'error', error});
                    }
                }
            );
        }
    }

    async function invokeOwned(core, method, parameters, signal) {
        const request = ownRequest(signal, null, core);
        request.result = Promise.resolve().then(
            function invokeLocalOperation() {
                request.controller.signal.throwIfAborted();
                return core.invoke(method, parameters, {signal: request.controller.signal});
            }
        );
        try {
            const result = await request.result;
            request.controller.signal.throwIfAborted();
            return result;
        } finally {
            request.release();
        }
    }

    function authority(value) {
        return {protocol: AUTHORITY_PROTOCOL, providerId: id, modelId: value.modelId};
    }

    async function inspect(value, {signal} = {}) {
        requireSelection(value);
        if (signal?.aborted) throw cancelled(signal.reason);
        const currentConnection = connection;
        const statusRevision = lifecycleRevision;
        try {
            const core = requireClient();
            const current = await invokeOwned(core, 'llama.status', {}, signal);
            assertCurrentConnection(currentConnection);
            if (lifecycleRevision === statusRevision) acceptRuntime(current);
            const knownModel = models.some(function matchesModel(model) { return model.id === value.modelId; });
            // Inspection describes an explicit load capability, never readiness.
            // Core still verifies the exact model at the actual load boundary.
            const starting = !runtime?.error && ['starting', 'loading'].includes(runtime?.state);
            const released = !runtime?.error && runtime?.released === true && runtime.owned === true
                && runtime.state === 'stopped' && knownModel;
            if (runtime?.error || (runtime?.available !== true && !starting && !released)) {
                return {
                    available: false,
                    code: 'ARCANE_AI_PROVIDER_UNAVAILABLE',
                    message: 'The local llama.cpp runtime is unavailable.',
                    error: runtime?.error ?? null
                };
            }
            if (!starting && !knownModel) {
                return {
                    available: false,
                    code: 'ARCANE_AI_MODEL_UNAVAILABLE',
                    message: 'The selected model is unavailable in the local llama.cpp runtime.'
                };
            }
            return {available: true, authority: authority(value)};
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') throw error;
            if (!disposed && connection === currentConnection && lifecycleRevision === statusRevision) {
                acceptRuntime({...runtime, available: false, state: 'error', error});
            }
            return {available: false, code: error.code ?? 'ARCANE_AI_CORE_UNAVAILABLE', message: error.message, error};
        }
    }

    async function load({selection: value, signal, progress} = {}) {
        const core = requireClient();
        const currentConnection = connection;
        requireSelection(value);
        if (signal?.aborted) throw cancelled(signal.reason);
        selection = value;
        selectionConnection = currentConnection;
        const operation = {};
        loading = operation;
        unloading = false;
        lifecycleRevision += 1;
        try {
            progress?.({phase: 'loading', modelId: value.modelId});
            const revision = lifecycleRevision;
            const current = await invokeOwned(core, 'llama.load', {model: value.modelId}, signal);
            assertCurrentConnection(currentConnection);
            if (loading !== operation || selection !== value) throw cancelled();
            if (lifecycleRevision === revision) acceptRuntime(current);
            if (!modelReady()) throw localAIError('ARCANE_AI_MODEL_NOT_READY', 'Core did not report the selected model loaded and ready.', current?.error);
            progress?.({phase: 'ready', modelId: value.modelId});
            assertCurrentConnection(currentConnection);
            if (loading !== operation || selection !== value) throw cancelled();
            return {authority: authority(value), status: {...status(), state: 'ready', busy: false}};
        } finally {
            if (loading === operation) loading = false;
        }
    }

    function ownRequest(signal, modelId, core = requireClient()) {
        const currentConnection = connection;
        if (core !== currentConnection?.client) throw cancelled();
        const controller = new AbortController();
        const operationSignal = signal
            ? AbortSignal.any([signal, currentConnection.controller.signal]) : currentConnection.controller.signal;
        function forwardAbort() { controller.abort(operationSignal.reason); }
        operationSignal.addEventListener('abort', forwardAbort, {once: true});
        if (operationSignal.aborted) forwardAbort();
        const request = {controller, connection: currentConnection, result: null, modelId, loaded: models.some(function loadedTarget(model) {
            return model.id === modelId && model.loaded === true;
        })};
        requests.add(request);
        request.release = function releaseRequest() {
            operationSignal.removeEventListener('abort', forwardAbort);
            requests.delete(request);
        };
        return request;
    }

    function streamRequest(core, parameters, signal) {
        const request = ownRequest(signal, parameters.model, core);
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
            request.controller.signal.throwIfAborted();
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
        const currentConnection = connection;
        requireSelection(value);
        if (signal?.aborted) throw cancelled(signal.reason);
        if (loading || unloading || selectionConnection !== connection || selection?.modelId !== value.modelId) {
            throw localAIError('ARCANE_AI_MODEL_NOT_READY', 'Load the selected local model before requesting inference.');
        }
        const model = payload?.model ?? value.modelId;
        if (!models.some(function knownModel(record) { return record.id === model; })) {
            const revision = lifecycleRevision;
            const current = await invokeOwned(core, 'llama.status', {}, signal);
            assertCurrentConnection(currentConnection);
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
        const pending = ownRequest(signal, model, core);
        pending.result = Promise.resolve().then(function invokeChat() {
            pending.controller.signal.throwIfAborted();
            return core.invoke('llama.chat', {...parameters, stream: false}, {signal: pending.controller.signal});
        }).then(function chatCompleted(result) {
            if (pending.controller.signal.aborted) throw cancelled(pending.controller.signal.reason);
            return result;
        }).finally(pending.release);
        return pending.result;
    }

    async function unload({signal} = {}) {
        const value = selection;
        const core = requireClient();
        const currentConnection = connection;
        if (signal?.aborted) throw cancelled(signal.reason);
        if (value && value === selection && selectionConnection !== currentConnection) {
            throw localAIError('ARCANE_AI_CORE_UNAVAILABLE', 'The selected model belongs to a retired Core connection.');
        }
        if (value) requireSelection(value);
        const operation = {};
        unloading = operation;
        loading = false;
        lifecycleRevision += 1;
        for (const request of requests) request.controller.abort();
        try {
            await Promise.allSettled([...requests].map(function activeResult(request) { return request.result; }));
            assertCurrentConnection(currentConnection);
            if (unloading !== operation) throw cancelled();
            if (value) {
                const revision = lifecycleRevision;
                const current = await invokeOwned(core, 'llama.unload', {model: value.modelId}, signal);
                assertCurrentConnection(currentConnection);
                if (unloading !== operation) throw cancelled();
                if (lifecycleRevision === revision) acceptRuntime(current);
            }
            if (unloading !== operation) throw cancelled();
            selection = null;
            selectionConnection = null;
            unloading = false;
            return status();
        } catch (error) {
            if (!disposed && connection === currentConnection && unloading === operation) {
                runtime = {...runtime, state: 'error', error};
            }
            throw error;
        } finally {
            if (unloading === operation) unloading = false;
        }
    }

    function dispose({signal} = {}) {
        if (disposing) return disposing;
        // The runtime also supplies its configured selection after unload.
        // Only this provider's retained selection owns a native release.
        const value = selection;
        const core = selectionConnection?.client;
        disposed = true;
        loading = false;
        unloading = false;
        lifecycleRevision += 1;
        stopInstallation?.();
        connection?.unsubscribe?.();
        connection?.controller.abort();
        disposing = Promise.resolve().then(
            async function disposeLocalProvider() {
                await Promise.allSettled([...requests].map(function activeResult(request) { return request.result; }));
                if (value) {
                    requireSelection(value);
                    if (!core) throw localAIError('ARCANE_AI_CORE_UNAVAILABLE', 'The retired Core connection cannot unload the selected model.');
                    // Disposal owns this final release on the captured client only.
                    // Subscription cleanup above remains complete if it rejects.
                    await core.invoke('llama.unload', {model: value.modelId}, {signal});
                }
                selection = null;
                selectionConnection = null;
                return status();
            }
        ).catch(
            function nativeReleaseFailed(error) {
                runtime = {...runtime, error};
                throw error;
            }
        );
        return disposing;
    }

    if (suppliedClient === undefined) {
        stopInstallation = subscribeCoreClient(bindClient);
    } else {
        bindClient({client: suppliedClient});
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
