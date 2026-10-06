import {Buffer} from 'node:buffer';
import {isDeepStrictEqual} from 'node:util';
import Is from 'strong-type';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {CoreError, serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';
import {normalizeLocalAIConfig} from '../../local-ai/config.mjs';
import {createImageRuntime} from '../../local-ai/image-runtime.mjs';

const is = new Is(false);

function failure(code, message) {
    return new CoreError(
        {code, message}
    );
}

function waitForPreparation(task, signal) {
    signal.throwIfAborted();
    return new Promise(
        function awaitImagePreparation(resolve, reject) {
            function cancelled() {
                signal.removeEventListener('abort', cancelled);
                reject(signal.reason);
            }
            signal.addEventListener(
                'abort',
                cancelled,
                {once: true}
            );
            task.then(
                function prepared(runtime) {
                    signal.removeEventListener('abort', cancelled);
                    if (signal.aborted) {
                        reject(signal.reason);
                    } else {
                        resolve(runtime);
                    }
                },
                function preparationFailed(error) {
                    signal.removeEventListener('abort', cancelled);
                    reject(error);
                }
            );
        }
    );
}

/** PNG encoding here belongs exclusively to the JSON Core transport. */
function encodeImage(image) {
    const {data, ...metadata} = image;
    return {
        ...metadata,
        encoding: 'base64',
        data: Buffer.from(data).toString('base64')
    };
}

/** One selected native image runtime; applications own prompts and persistence. */
export function createLocalImageService(
    configuration,
    {appRoot, runtimes = [], signal, onEvent, prepare, modelAssets} = {}
) {
    const config = normalizeLocalAIConfig(configuration) ?? {runtimes: []};
    const requirement = config.runtimes.find(
        function selectedImageRuntime(record) {
            return record.id === 'stable-diffusion.cpp';
        }
    );
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const owner = {};
    const events = createArcaneEventSource(
        owner,
        {source: 'core-image', eventTypes: ['image.state']}
    );
    const jobs = new Set();
    const projections = new Map();
    const releases = new Set();
    const releaseFailures = [];
    let record = runtimes.find(
        function installedImageRuntime(value) {
            return value.id === 'stable-diffusion.cpp';
        }
    );
    let state = {
        id: 'stable-diffusion.cpp',
        installed: Boolean(record?.libraryPath && record?.bindingModulePath),
        available: false,
        selectedModel: null,
        loaded: false,
        state: requirement ? 'created' : 'unavailable',
        backend: record?.backend ?? null,
        devices: [],
        resources: {},
        progress: null,
        error: null,
        models: record?.models ?? requirement?.models ?? []
    };
    let context;
    let runtime;
    let preparation;
    let stopRuntimeSubscription;
    let closing;
    let closed = false;

    function current() {
        return {...state, closed};
    }

    function publish() {
        const snapshot = current();
        events.dispatch('image.state', snapshot);
        context?.emit('image.state', snapshot);
        return snapshot;
    }

    function acceptRuntimeState(value) {
        state = {
            ...state,
            ...value,
            available: value.available ?? (!value.closed && value.state !== 'error'),
            installed: Boolean(record?.libraryPath && record?.bindingModulePath),
            models: record?.models ?? requirement?.models ?? []
        };
        if (closing) {
            state.available = false;
            state.state = closed ? 'closed' : 'closing';
        }
        publish();
        releaseUnusedProjections();
    }

    function diagnostic(event) {
        if (!onEvent) {
            return;
        }
        function reportDiagnosticFailure(error) {
            console.error('Local image diagnostic observer failed.', error);
        }
        try {
            Promise.resolve(onEvent(event)).catch(reportDiagnosticFailure);
        } catch (error) {
            reportDiagnosticFailure(error);
        }
    }

    function notifyListener(listener, value) {
        const result = listener(value);
        if (result && is.function(result.then)) {
            Promise.resolve(result).catch(
                function reportImageListenerFailure(error) {
                    console.error('Local image state listener failed.', error);
                }
            );
        }
    }

    function preparationProgress(event) {
        if (!closing) {
            state = {...state, progress: event};
            publish();
        }
        diagnostic(event);
    }

    function beginPreparation() {
        if (preparation || !requirement || closing) {
            return preparation;
        }
        state = {...state, state: 'preparing', error: null};
        preparation = Promise.resolve().then(
            async function prepareSelectedImageRuntime() {
                lifetimeSignal.throwIfAborted();
                if (prepare) {
                    record = await prepare(
                        {
                            appRoot,
                            configuration: config,
                            requirement,
                            signal: lifetimeSignal,
                            onEvent: preparationProgress
                        }
                    );
                }
                lifetimeSignal.throwIfAborted();
                if (!record?.libraryPath || !record?.bindingModulePath) {
                    throw failure(
                        'LOCAL_AI_RUNTIME_UNAVAILABLE',
                        'The selected local image runtime has not been prepared.'
                    );
                }
                runtime = createImageRuntime(
                    {
                        libraryPath: record.libraryPath,
                        bindingModulePath: record.bindingModulePath,
                        models: record.models ?? [],
                        backend: record.backend,
                        variants: record.variants,
                        signal: lifetimeSignal,
                        onEvent: diagnostic
                    }
                );
                stopRuntimeSubscription = runtime.subscribe(
                    acceptRuntimeState,
                    {replay: true}
                );
                return runtime;
            }
        );
        preparation.catch(
            function preparationFailed(error) {
                state = {
                    ...state,
                    installed: Boolean(record?.libraryPath && record?.bindingModulePath),
                    available: false,
                    state: lifetimeSignal.aborted ? 'closing' : 'error',
                    error: lifetimeSignal.aborted ? null : serializeCoreError(error)
                };
                publish();
            }
        );
        publish();
        return preparation;
    }

    async function selectedRuntime(operationSignal) {
        operationSignal.throwIfAborted();
        if (!requirement) {
            throw failure(
                'LOCAL_AI_RUNTIME_NOT_SELECTED',
                'stable-diffusion.cpp is not selected in this application configuration.'
            );
        }
        const selected = await waitForPreparation(beginPreparation(), operationSignal);
        operationSignal.throwIfAborted();
        return selected;
    }

    async function projectedModel(model, assetProjectionId, resourcePaths, operationSignal) {
        if (assetProjectionId === undefined) {
            return model;
        }
        if (!modelAssets) {
            throw failure(
                'LOCAL_AI_IMAGE_ASSETS_UNAVAILABLE',
                'This Core has no model asset projection service.'
            );
        }
        let projection = projections.get(assetProjectionId);
        if (!projection) {
            projection = {id: assetProjectionId, lease: null, task: null, models: new Map()};
            projection.task = Promise.resolve().then(
                async function retainModelAssets() {
                    projection.lease = await modelAssets.retain(assetProjectionId);
                    return projection.lease;
                }
            );
            projections.set(assetProjectionId, projection);
        }
        const lease = await projection.task;
        operationSignal.throwIfAborted();
        if (!resourcePaths || !is.object(resourcePaths) || is.array(resourcePaths)) {
            throw new TypeError('Projected image models require resourcePaths mapping native roles to projection members.');
        }
        const entries = Object.entries(resourcePaths);
        const modelId = is.string(model) ? model : model?.id;
        const cached = projection.models.get(modelId);
        if (cached && isDeepStrictEqual(cached.model, model)
            && Object.keys(cached.resourcePaths).length === entries.length
            && entries.every(
                function matchingResource([role, memberPath]) {
                    return cached.resourcePaths[role] === memberPath;
                }
            )) {
            return cached.prepared;
        }
        const definition = is.string(model)
            ? record.models?.find(
                function selectedModelDefinition(value) {
                    return value.id === model;
                }
            ) : model;
        if (!definition) {
            throw failure(
                'LOCAL_AI_IMAGE_MODEL_UNAVAILABLE',
                `The selected image model ${String(model)} has no model definition.`
            );
        }
        const resources = {...definition.resources};
        for (const [role, memberPath] of entries) {
            const member = lease.members.find(
                function selectedProjectionMember(value) {
                    return value.path === memberPath;
                }
            );
            if (!member) {
                throw failure(
                    'LOCAL_AI_IMAGE_RESOURCE_UNAVAILABLE',
                    `The retained model projection has no member ${String(memberPath)} for ${role}.`
                );
            }
            resources[role] = member.nativePath;
        }
        const prepared = {...definition, resources};
        projection.models.set(
            modelId,
            {model, resourcePaths: {...resourcePaths}, prepared}
        );
        return prepared;
    }

    function releaseUnusedProjections(all = false) {
        // Native calls share one context. Retain every provisional projection
        // until those calls settle, then compare with the actual loaded inputs.
        if (jobs.size > 0) {
            return;
        }
        const resources = all ? [] : Object.values(runtime?.current().resources ?? {});
        for (const [id, projection] of projections) {
            const active = projection.lease?.members.some(
                function activeNativeResource(member) {
                    return resources.includes(member.nativePath);
                }
            );
            if (active) {
                continue;
            }
            projections.delete(id);
            if (!projection.lease) {
                continue;
            }
            const task = Promise.resolve().then(
                function releaseModelProjection() {
                    return projection.lease.release();
                }
            );
            releases.add(task);
            task.then(
                function projectionReleased() {
                    releases.delete(task);
                },
                function projectionReleaseFailed(error) {
                    releases.delete(task);
                    releaseFailures.push(error);
                    console.error('Local image model projection release failed.', error);
                }
            );
        }
    }

    function track(task, operationSignal) {
        jobs.add(task);
        function settled() {
            jobs.delete(task);
            releaseUnusedProjections();
        }
        task.then(
            settled,
            function imageOperationFailed(error) {
                if (!closing && !operationSignal.aborted) {
                    state = {...state, error: serializeCoreError(error)};
                    publish();
                }
                settled();
            }
        );
        return task;
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
        const unsubscribe = events.on(
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
            unsubscribe();
            throw error;
        }
        return unsubscribe;
    }

    function close() {
        if (closing) {
            return closing;
        }
        closing = Promise.resolve().then(
            async function closeImageService() {
                const runtimeClosing = Promise.resolve().then(
                    function closeNativeImageRuntime() {
                        return runtime?.close();
                    }
                );
                const results = await Promise.allSettled(
                    [runtimeClosing, ...jobs, ...(preparation ? [preparation] : [])]
                );
                try {
                    const errors = [];
                    if (results[0].status === 'rejected') {
                        errors.push(results[0].reason);
                    }
                    // Native close joins unload or worker exit even when it
                    // rejects. Its files can now complete their own cleanup.
                    try {
                        releaseUnusedProjections(true);
                    } catch (error) {
                        errors.push(error);
                    }
                    await Promise.allSettled([...releases]);
                    errors.push(...releaseFailures);
                    if (errors.length === 1) {
                        throw errors[0];
                    }
                    if (errors.length > 1) {
                        throw new AggregateError(
                            errors,
                            'Local image service cleanup failed.',
                            {cause: errors[0]}
                        );
                    }
                } catch (error) {
                    state = {...state, error: serializeCoreError(error)};
                    throw error;
                } finally {
                    stopRuntimeSubscription?.();
                    lifetimeSignal.removeEventListener('abort', abortService);
                    closed = true;
                    state = {...state, available: false, state: 'closed'};
                    publish();
                }
            }
        );
        lifetime.abort();
        state = {...state, available: false, state: 'closing'};
        publish();
        return closing;
    }

    function abortService() {
        close().catch(
            function reportImageShutdownFailure(error) {
                console.error('Local image service shutdown failed.', error);
            }
        );
    }

    lifetimeSignal.addEventListener(
        'abort',
        abortService,
        {once: true}
    );

    return {
        name: 'image',
        current,
        subscribe,
        start(currentContext) {
            context = currentContext;
            if (lifetimeSignal.aborted) {
                abortService();
                return;
            }
            beginPreparation();
            publish();
        },
        methods: {
            'image.status': current,
            'image.load': function loadImage(
                {model, context: modelContext, assetProjectionId, resourcePaths} = {},
                request
            ) {
                const operationSignal = AbortSignal.any([lifetimeSignal, request.signal]);
                return track(
                    (async function loadSelectedImageModel() {
                        const selected = await selectedRuntime(operationSignal);
                        const prepared = await projectedModel(model, assetProjectionId, resourcePaths, operationSignal);
                        await selected.load(
                            {model: prepared, context: modelContext, signal: operationSignal}
                        );
                        operationSignal.throwIfAborted();
                        return current();
                    })(),
                    operationSignal
                );
            },
            'image.generate': function generateImage(
                {model, prompt, parameters, streamId, assetProjectionId, resourcePaths} = {},
                request
            ) {
                const operationSignal = AbortSignal.any([lifetimeSignal, request.signal]);
                operationSignal.throwIfAborted();
                request.emit(
                    'image.progress',
                    {streamId, requestId: request.requestId, status: 'Thinking', progress: {phase: 'accepted'}}
                );
                return track(
                    (async function generateSelectedImage() {
                        const selected = await selectedRuntime(operationSignal);
                        const prepared = await projectedModel(model, assetProjectionId, resourcePaths, operationSignal);
                        const result = await selected.generate(
                            {
                                model: prepared,
                                prompt,
                                parameters,
                                signal: operationSignal,
                                onProgress(progress) {
                                    if (!operationSignal.aborted) {
                                        request.emit(
                                            'image.progress',
                                            {streamId, requestId: request.requestId, status: 'Thinking', progress}
                                        );
                                    }
                                }
                            }
                        );
                        operationSignal.throwIfAborted();
                        return {...result, images: result.images.map(encodeImage)};
                    })(),
                    operationSignal
                );
            },
            'image.unload': function unloadImage(_parameters, request) {
                const operationSignal = AbortSignal.any([lifetimeSignal, request.signal]);
                return track(
                    (async function unloadSelectedImageModel() {
                        const selected = await selectedRuntime(operationSignal);
                        await selected.unload(
                            {signal: operationSignal}
                        );
                        operationSignal.throwIfAborted();
                        return current();
                    })(),
                    operationSignal
                );
            }
        },
        drain: close,
        async dispose() {
            try {
                await close();
            } finally {
                events.dispose();
            }
        }
    };
}

export default createLocalImageService;
