import Is from '../dependencies/strong-type/index.js';
import {getInstalledCoreClient} from '../core/client.mjs';
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

/** Browser access to the selected native image service; no result persistence. */
export function createCoreImageRuntime(
    {client = getInstalledCoreClient(), signal, onEvent} = {}
) {
    const owner = {};
    const events = createArcaneEventSource(
        owner,
        {source: 'core-image', eventTypes: ['image.state']}
    );
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const pending = new Set();
    let state = {
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
        error: null,
        models: []
    };
    let revision = 0;
    let closed = false;
    let closing;

    function current() {
        const requests = [...pending].map(
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
            busy: pending.size > 0,
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

    const unsubscribe = client?.events.on('image.state', accept)
        ?? function noCoreSubscription() {};

    function invoke(method, parameters, {signal: requestSignal, onProgress} = {}) {
        if (closed) {
            throw unavailable('The Core image accessor is closed.');
        }
        if (!client) {
            throw unavailable('Local image generation requires an available Core connection.');
        }
        const operationSignal = requestSignal
            ? AbortSignal.any([requestSignal, lifetimeSignal]) : lifetimeSignal;
        operationSignal.throwIfAborted();
        const request = {
            method,
            revision,
            streamId: parameters.streamId,
            status: method === 'image.generate' ? 'Thinking' : null,
            progress: null,
            task: null
        };
        let stopProgress;
        if (request.streamId) {
            stopProgress = client.events.on(
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
                observe(
                    onEvent,
                    {type: 'image.request', data: {method, parameters}}
                );
                operationSignal.throwIfAborted();
                const result = await client.invoke(
                    method,
                    parameters,
                    {signal: operationSignal, timeoutMs: 0}
                );
                operationSignal.throwIfAborted();
                if (method === 'image.generate') {
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
                if (!closed) {
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
        try {
            const result = await invoke(
                'image.status',
                {},
                {signal: requestSignal}
            );
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
        const result = await invoke(
            'image.load',
            {model, context, assetProjectionId, resourcePaths},
            {signal: requestSignal}
        );
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

    async function unload({signal: requestSignal} = {}) {
        const before = revision;
        const result = await invoke(
            'image.unload',
            {},
            {signal: requestSignal}
        );
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
        unsubscribe();
        state = {...state, available: false, state: 'closed'};
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
    } else if (client) {
        // Subscribe before the snapshot request so a later lifecycle event wins.
        inspect().catch(
            function initialImageStateUnavailable(error) {
                globalThis.console?.error('Core image initial state unavailable.', error);
            }
        );
    }

    return {load, generate, unload, inspect, current, subscribe, close};
}
