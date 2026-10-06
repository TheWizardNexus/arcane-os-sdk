import {parentPort, workerData} from 'node:worker_threads';
import {createImageLibrary} from './image-library.mjs';
import {encodePNG} from './image-png.mjs';
import {decodeImage} from './image-editing.mjs';

let library;
let active;
let selection;
let selectedBackend;
let state = {
    state: 'unloaded', available: true, selectedModel: null, loaded: false,
    backend: null, devices: [], resources: {}, progress: null, error: null, closed: false
};

function publish(fields) {
    state = {...state, ...fields};
    parentPort.postMessage({type: 'state', state});
}

function diagnostic(event) { parentPort.postMessage({type: 'diagnostic', event}); }

function progress(value) {
    if (!active) return;
    parentPort.postMessage({type: 'progress', id: active.id, progress: value});
}

async function initialize() {
    const variants = workerData.variants.length ? workerData.variants : [
        {backend: workerData.backend, libraryPath: workerData.libraryPath}
    ];
    const failures = [];
    for (const variant of variants) {
        try {
            library = createImageLibrary(
                {
                    libraryPath: variant.libraryPath,
                    bindingModulePath: workerData.bindingModulePath,
                    onLog: diagnostic,
                    onProgress: progress
                }
            );
        } catch (error) {
            if (error.code !== 'LOCAL_IMAGE_LIBRARY_UNAVAILABLE') throw error;
            failures.push(error);
            diagnostic({type: 'local-image.backend.unavailable', backend: variant.backend, error: describeError(error)});
            continue;
        }
        const inventory = await library.listDevices();
        const requested = workerData.backend;
        const device = inventory.devices.find(function preferredDevice(value) {
            if (requested === 'cpu' || variant.backend === 'cpu') return /^cpu/iu.test(value.name);
            return /^(cuda|vulkan|metal)/iu.test(value.name);
        });
        if (device) {
            selectedBackend = device.name;
            state = {...state, backend: selectedBackend, devices: inventory.devices};
            diagnostic({type: 'local-image.devices', ...inventory, backend: selectedBackend});
            return;
        }
        await library.close();
        library = undefined;
        diagnostic({type: 'local-image.backend.unavailable', backend: variant.backend, ...inventory});
    }
    if (failures.length) throw new AggregateError(failures, 'The selected image runtime libraries could not load.');
    throw Object.assign(new Error('No compatible image generation device is available.'), {code: 'LOCAL_IMAGE_BACKEND_UNAVAILABLE'});
}

async function unload() {
    if (!state.loaded) return;
    publish({state: 'unloading'});
    await library.unload();
    selection = undefined;
    publish({state: 'unloaded', selectedModel: null, loaded: false, resources: {}, progress: null});
}

async function load(parameters, signal) {
    signal.throwIfAborted();
    if (selection === parameters.selection && state.loaded) return;
    await unload();
    signal.throwIfAborted();
    const model = parameters.model;
    const requestedBackend = parameters.backend ?? 'auto';
    const requestedDevice = state.devices.find(function requestedModelDevice(device) {
        if (requestedBackend === 'auto') return device.name === selectedBackend;
        return device.name.toLowerCase().startsWith(requestedBackend.toLowerCase());
    }) ?? state.devices.find(function fallbackCPU(device) {
        return /^cpu/iu.test(device.name);
    });
    if (!requestedDevice && model.context?.backend === undefined) {
        throw Object.assign(new Error(`No available device can run the requested ${requestedBackend} image backend.`), {code: 'LOCAL_IMAGE_BACKEND_UNAVAILABLE'});
    }
    publish({state: 'loading', selectedModel: model.id, error: null});
    try {
        const loaded = await library.load(
            {
                resources: model.resources,
                context: {...model.context, backend: model.context?.backend ?? requestedDevice.name},
                signal
            }
        );
        signal.throwIfAborted();
        selection = parameters.selection;
        publish(
            {
                state: 'ready', loaded: true, resources: model.resources,
                backend: loaded.backend ?? selectedBackend, modelVersion: loaded.modelVersion
            }
        );
    } catch (error) {
        await library.unload();
        selection = undefined;
        publish({state: signal.aborted ? 'unloaded' : 'error', loaded: false, resources: {}, error: describeError(error)});
        throw error;
    }
}

async function execute(message, signal) {
    if (message.operation === 'close') {
        const errors = [];
        try {
            await unload();
        } catch (error) {
            errors.push(error);
        }
        try {
            await library.close();
        } catch (error) {
            errors.push(error);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, 'The native image engine could not finish cleanup.');
        publish({state: 'closed', available: false, closed: true});
        return state;
    }
    if (message.operation === 'unload') {
        await unload();
        return state;
    }
    const parameters = message.parameters;
    let image;
    if (message.operation === 'edit') {
        try {
            image = await decodeImage({...parameters.image, signal});
        } catch (error) {
            // Decoding leaves the selected context unchanged. Replay its actual
            // state so a broker cancellation cannot remain visibly unsettled.
            publish({error: describeError(error)});
            throw error;
        }
    }
    await load(parameters, signal);
    if (message.operation === 'load') return state;
    signal.throwIfAborted();
    publish({state: 'generating', progress: null, error: null});
    try {
        const defaults = parameters.model.defaults ?? {};
        const supplied = parameters.parameters ?? {};
        const rasterImages = await library.generate(
            {
                prompt: parameters.prompt,
                parameters: {
                    ...defaults, ...supplied,
                    ...(message.operation === 'edit' ? {strength: parameters.strength} : {}),
                    sample_params: {
                        ...defaults.sample_params, ...supplied.sample_params,
                        guidance: {...defaults.sample_params?.guidance, ...supplied.sample_params?.guidance}
                    }
                },
                image,
                signal
            }
        );
        signal.throwIfAborted();
        const images = [];
        for (const image of rasterImages) {
            const data = await encodePNG({...image, signal});
            images.push({data, mediaType: 'image/png', width: image.width, height: image.height});
        }
        signal.throwIfAborted();
        publish({state: 'ready', progress: null});
        return {images};
    } catch (error) {
        publish({state: state.loaded ? 'ready' : 'error', progress: null, error: describeError(error)});
        throw error;
    }
}

parentPort.on('message', function incoming(message) {
    if (message.type === 'cancel') {
        if (active?.id === message.id) active.controller.abort();
        return;
    }
    if (message.type !== 'operation') return;
    const controller = new AbortController();
    active = {id: message.id, controller};
    const task = execute(message, controller.signal);
    task.then(
        function completed(result) {
            active = undefined;
            parentPort.postMessage({type: 'result', id: message.id, result});
            if (message.operation === 'close') parentPort.close();
        },
        function operationFailed(error) {
            active = undefined;
            parentPort.postMessage({type: 'result', id: message.id, error: describeError(error)});
            if (message.operation === 'close') parentPort.close();
        }
    );
});

function describeError(error) {
    if (!(error instanceof Error)) return {name: 'Error', message: String(error), cause: error};
    return {
        ...error, name: error.name, message: error.message, stack: error.stack,
        ...(error.cause !== undefined ? {cause: describeError(error.cause)} : {}),
        ...(error instanceof AggregateError ? {errors: error.errors.map(describeError)} : {})
    };
}

try {
    await initialize();
    parentPort.postMessage({type: 'ready', state});
} catch (error) {
    let failure = error;
    try {
        await library?.close();
    } catch (cleanupError) {
        failure = new AggregateError([error, cleanupError], 'Image runtime initialization and cleanup failed.');
    }
    parentPort.postMessage({type: 'fatal', error: describeError(failure)});
    parentPort.close();
}
