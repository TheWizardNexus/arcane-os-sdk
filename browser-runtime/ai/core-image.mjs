import Is from '../dependencies/strong-type/index.js';
import {subscribeCoreClient} from '../core/client.mjs';
import {CoreError, serializeCoreError} from '../core/contracts.mjs';
import {createArcaneEventSource} from '../event-manager.mjs';

const is = new Is(false);

function unavailable(message) {
    return new CoreError(
        {code: 'ARCANE_IMAGE_CORE_UNAVAILABLE', message}
    );
}

/** Decode the complete JSON transport representation without retaining it. */
function decodeImage(image) {
    const {data, encoding, ...metadata} = image;
    if (encoding !== 'base64') {
        throw new TypeError('Core image results require base64 transport encoding.');
    }
    const decoded = Uint8Array.from(
        globalThis.atob(data),
        function decodeImageCharacter(character) {
            return character.charCodeAt(0);
        }
    );
    const blob = new Blob(
        [decoded],
        {type: metadata.mediaType}
    );
    return {...metadata, blob};
}

/** Preserve the complete encoded input at the JSON transport boundary. */
async function encodeImage(image, signal) {
    if (!(image instanceof Blob)) {
        throw new TypeError('Image editing requires the original PNG Blob or File.');
    }
    const content = new Uint8Array(await image.arrayBuffer());
    signal.throwIfAborted();
    let data;
    if (is.function(content.toBase64)) {
        data = content.toBase64();
    } else {
        let binary = '';
        for (const value of content) binary += String.fromCharCode(value);
        data = globalThis.btoa(binary);
    }
    return {data, encoding: 'base64', mediaType: image.type};
}

/** Browser access to the selected native image service; no result persistence. */
export function createCoreImageRuntime(
    {client: suppliedClient, signal, onEvent} = {}
) {
    const owner = {};
    const events = createArcaneEventSource(
        owner,
        {source: 'core-image', eventTypes: ['image.state']}
    );
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const pending = new Set();
    let client = null;
    let connection = null;
    let stopInstallation;
    let state = emptyState();
    let revision = 0;
    let closed = false;
    let closing;

    function emptyState(error = null) {
        return {
            id: 'stable-diffusion.cpp',
            installed: false,
            available: false,
            selectedModel: null,
            loaded: false,
            state: client ? 'unknown' : 'unavailable',
            backend: null,
            devices: [],
            resources: {},
            progress: null,
            error: error ? serializeCoreError(error) : null,
            models: []
        };
    }

    function current() {
        const requests = [...pending].filter(
            function currentConnectionRequest(request) {
                return request.connection === connection && !request.signal.aborted;
            }
        ).map(
            function requestState(request) {
                return {
                    method: request.method,
                    streamId: request.streamId,
                    status: request.status,
                    progress: request.progress
                };
            }
        );
        return {
            ...state,
            requests,
            status: !closed && requests.some(
                function generationPending(request) {
                    return request.status === 'Thinking';
                }
            ) ? 'Thinking' : null,
            busy: requests.length > 0,
            closed
        };
    }

    function reportObserverFailure(error) {
        globalThis.console?.error('Core image observer failed.', error);
    }

    function notifyListener(listener, value) {
        const result = listener(value);
        if (result && is.function(result.then)) {
            // Observers own their callback lifetimes and may await close().
            Promise.resolve(result).catch(reportObserverFailure);
        }
    }

    function observe(callback, value) {
        if (!is.function(callback)) {
            return;
        }
        try {
            notifyListener(callback, value);
        } catch (error) {
            reportObserverFailure(error);
        }
    }

    function publish() {
        const snapshot = current();
        events.dispatch('image.state', snapshot);
        if (snapshot.closed === closed) {
            observe(
                onEvent,
                {type: 'image.state', data: snapshot}
            );
        }
        return snapshot;
    }

    function accept(value) {
        if (closed) {
            return;
        }
        state = value;
        revision += 1;
        publish();
    }

    function bindClient({client: nextClient, error = null}) {
        if (closed || (connection && nextClient === client)) {
            return;
        }
        const previous = connection;
        client = nextClient;
        const currentConnection = {client, controller: new AbortController(), unsubscribe: null};
        connection = currentConnection;
        revision += 1;
        state = emptyState(error);
        previous?.unsubscribe?.();
        previous?.controller.abort();
        if (client) {
            currentConnection.unsubscribe = client.events.on(
                'image.state',
                function currentImageState(value) {
                    if (connection === currentConnection) accept(value);
                }
            );
        }
        publish();
        if (!closed && connection === currentConnection && client) {
            // Observe only; installation never loads an engine or model.
            inspect().catch(
                function initialImageStateUnavailable(error) {
                    if (!closed && connection === currentConnection && !currentConnection.controller.signal.aborted) {
                        reportObserverFailure(error);
                    }
                }
            );
        }
    }

    function invoke(method, parameters, {signal: requestSignal, onProgress} = {}) {
        if (closed) {
            throw unavailable('The Core image accessor is closed.');
        }
        if (!client) {
            throw unavailable('Local image generation requires an available Core connection.');
        }
        const currentConnection = connection;
        const operationSignal = AbortSignal.any(
            [lifetimeSignal, currentConnection.controller.signal, ...(requestSignal ? [requestSignal] : [])]
        );
        operationSignal.throwIfAborted();
        const request = {
            method,
            connection: currentConnection,
            signal: operationSignal,
            revision,
            streamId: parameters.streamId,
            status: method === 'image.generate' || method === 'image.edit' ? 'Thinking' : null,
            progress: null,
            task: null
        };
        let stopProgress;
        if (request.streamId) {
            stopProgress = currentConnection.client.events.on(
                'image.progress',
                function imageProgress(value) {
                    if (closed || operationSignal.aborted || value.streamId !== request.streamId) {
                        return;
                    }
                    request.progress = value.progress;
                    publish();
                    if (closed || operationSignal.aborted) {
                        return;
                    }
                    observe(onProgress, value.progress);
                    if (closed || operationSignal.aborted) {
                        return;
                    }
                    observe(
                        onEvent,
                        {type: 'image.progress', data: value}
                    );
                }
            );
        }
        request.task = Promise.resolve().then(
            async function executeImageRequest() {
                operationSignal.throwIfAborted();
                const requestParameters = method === 'image.edit'
                    ? {...parameters, image: await encodeImage(parameters.image, operationSignal)} : parameters;
                operationSignal.throwIfAborted();
                observe(
                    onEvent,
                    {type: 'image.request', data: {method, parameters: requestParameters}}
                );
                operationSignal.throwIfAborted();
                const result = await currentConnection.client.invoke(
                    method,
                    requestParameters,
                    {signal: operationSignal, timeoutMs: 0}
                );
                operationSignal.throwIfAborted();
                if (method === 'image.generate' || method === 'image.edit') {
                    const images = result.images.map(decodeImage);
                    operationSignal.throwIfAborted();
                    const decoded = {...result, images};
                    observe(
                        onEvent,
                        {type: 'image.result', data: decoded}
                    );
                    operationSignal.throwIfAborted();
                    return decoded;
                }
                return result;
            }
        ).catch(
            function imageRequestFailed(error) {
                if (!closed && !operationSignal.aborted) {
                    if (method !== 'image.status' || revision === request.revision) {
                        state = {...state, error: serializeCoreError(error)};
                    }
                    observe(
                        onEvent,
                        {type: 'image.error', data: {method, error: serializeCoreError(error)}}
                    );
                }
                throw error;
            }
        ).finally(
            function releaseImageRequest() {
                stopProgress?.();
                pending.delete(request);
                if (!closed && connection === currentConnection) {
                    publish();
                }
            }
        );
        pending.add(request);
        // Acknowledgement precedes transport, preparation, model loading and inference.
        publish();
        return request.task;
    }

    async function inspect({signal: requestSignal} = {}) {
        const before = revision;
        const currentConnection = connection;
        try {
            const result = await invoke(
                'image.status',
                {},
                {signal: requestSignal}
            );
            currentConnection.controller.signal.throwIfAborted();
            if (!closed && revision === before) {
                accept(result);
            }
            return current();
        } catch (error) {
            if (!closed && !requestSignal?.aborted && revision === before) {
                accept(
                    {...state, available: false, state: 'unavailable', error: serializeCoreError(error)}
                );
            }
            throw error;
        }
    }

    async function load({model, context, assetProjectionId, resourcePaths, signal: requestSignal} = {}) {
        const before = revision;
        const currentConnection = connection;
        const result = await invoke(
            'image.load',
            {model, context, assetProjectionId, resourcePaths},
            {signal: requestSignal}
        );
        currentConnection.controller.signal.throwIfAborted();
        if (!closed && revision === before) {
            accept(result);
        }
        return result;
    }

    function generate(
        {model, prompt, parameters, assetProjectionId, resourcePaths, signal: requestSignal, onProgress} = {}
    ) {
        const streamId = client?.uuid?.() ?? globalThis.crypto.randomUUID();
        return invoke(
            'image.generate',
            {model, prompt, parameters, streamId, assetProjectionId, resourcePaths},
            {signal: requestSignal, onProgress}
        );
    }

    function edit(
        {model, image, prompt, strength, parameters, assetProjectionId, resourcePaths, signal: requestSignal, onProgress} = {}
    ) {
        const streamId = client?.uuid?.() ?? globalThis.crypto.randomUUID();
        return invoke(
            'image.edit',
            {model, image, prompt, strength, parameters, streamId, assetProjectionId, resourcePaths},
            {signal: requestSignal, onProgress}
        );
    }

    async function unload({signal: requestSignal} = {}) {
        const before = revision;
        const currentConnection = connection;
        const result = await invoke(
            'image.unload',
            {},
            {signal: requestSignal}
        );
        currentConnection.controller.signal.throwIfAborted();
        if (!closed && revision === before) {
            accept(result);
        }
        return result;
    }

    function subscribe(listener, {replay = true, signal: subscriptionSignal} = {}) {
        if (!is.function(listener)) {
            throw new TypeError('An image state listener must be a function.');
        }
        if (closed) {
            if (replay && !subscriptionSignal?.aborted) {
                notifyListener(listener, current());
            }
            return function closedSubscription() {};
        }
        const stop = events.on(
            'image.state',
            function imageStateChanged(event) {
                notifyListener(listener, event.detail);
            },
            {signal: subscriptionSignal}
        );
        try {
            if (replay && !subscriptionSignal?.aborted) {
                notifyListener(listener, current());
            }
        } catch (error) {
            stop();
            throw error;
        }
        return stop;
    }

    function close() {
        if (closing) {
            return closing;
        }
        closed = true;
        closing = Promise.resolve().then(
            async function closeImageAccessor() {
                await Promise.allSettled(
                    [...pending].map(
                        function requestCompletion(request) {
                            return request.task;
                        }
                    )
                );
            }
        );
        lifetime.abort();
        lifetimeSignal.removeEventListener('abort', close);
        stopInstallation?.();
        connection?.unsubscribe?.();
        connection?.controller.abort();
        state = {...state, available: false, loaded: false, state: 'closed'};
        publish();
        events.dispose();
        return closing;
    }

    lifetimeSignal.addEventListener(
        'abort',
        close,
        {once: true}
    );
    if (lifetimeSignal.aborted) {
        close();
    } else if (suppliedClient === undefined) {
        stopInstallation = subscribeCoreClient(bindClient, {signal: lifetimeSignal});
    } else {
        bindClient({client: suppliedClient});
    }

    return {load, generate, edit, unload, inspect, current, subscribe, close};
}
