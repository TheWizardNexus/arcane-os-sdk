import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {SD14_MODEL} from './image-models/sd14.mjs';
import {FLUX2_KLEIN_4B_MODEL} from './image-models/flux.mjs';
import {SDXL_BASE_1_0_MODEL} from './image-models/sdxl.mjs';
import {normalizeWhisperRuntimeRequirement} from './whisper/config.mjs';

const is = new Is(false);
export const LOCAL_AI_RUNTIME_IDS = ['llama.cpp', 'ollama', 'onnx', 'stable-diffusion.cpp', 'whisper.cpp'];

/** Image requirements describe assets without acquiring or loading a model. */
export function normalizeImageRuntimeRequirement(record) {
    const backend = record.backend ?? 'auto';
    if (!['auto', 'metal', 'cpu'].includes(backend)) {
        throw new ArcaneError(ERROR_CODES.usage, `Unknown stable-diffusion.cpp backend: ${String(backend)}.`);
    }
    if (record.models !== undefined && !is.array(record.models)) {
        throw new ArcaneError(ERROR_CODES.usage, 'stable-diffusion.cpp models must be an array of model IDs or descriptors.');
    }
    const models = (record.models ?? []).map(
        function selectedImageModel(value) {
            const model = value === 'sd14' ? SD14_MODEL
                : value === 'flux2-klein-4b' ? FLUX2_KLEIN_4B_MODEL
                : value === 'sdxl-base-1.0' ? SDXL_BASE_1_0_MODEL : value;
            if (!model || !is.object(model) || is.array(model) || !is.string(model.id) || !model.id) {
                throw new ArcaneError(ERROR_CODES.usage, 'An image model needs a descriptor with an id, or a built-in model ID (sd14, flux2-klein-4b, or sdxl-base-1.0).');
            }
            if (!model.resources || !is.object(model.resources) || is.array(model.resources)) {
                throw new ArcaneError(ERROR_CODES.usage, `Image model ${model.id} needs resources keyed by model role.`);
            }
            if (model.operations !== undefined && !is.array(model.operations)) {
                throw new ArcaneError(ERROR_CODES.usage, `Image model ${model.id} operations must be an array.`);
            }
            return {
                ...model,
                resources: {...model.resources},
                context: {...model.context},
                defaults: {...model.defaults},
                operations: [...(model.operations ?? [])]
            };
        }
    );
    return {
        ...record,
        version: record.version ?? 'master-929-3f8527a',
        backend,
        models
    };
}

/** Runtime requirements are application configuration, separate from models. */
export function normalizeLocalAIConfig(value) {
    if (value === undefined) return undefined;
    if (!value || !is.object(value) || is.array(value) || !is.array(value.runtimes)) {
        throw new ArcaneError(ERROR_CODES.usage, 'localAI requires a runtimes array.');
    }
    const runtimes = value.runtimes.map(function runtimeRequirement(item) {
        const record = is.string(item) ? {id: item} : item;
        if (!record || !LOCAL_AI_RUNTIME_IDS.includes(record.id)) {
            throw new ArcaneError(ERROR_CODES.usage, `Unknown local AI runtime: ${String(record?.id ?? item)}.`);
        }
        if (record.id === 'stable-diffusion.cpp') return normalizeImageRuntimeRequirement(record);
        if (record.id === 'whisper.cpp') return normalizeWhisperRuntimeRequirement(record);
        return {...record};
    });
    return {...value, runtimes};
}

export function parseLocalAIRuntimeSelection(value) {
    if (value === undefined) return undefined;
    const selected = is.string(value) ? value.split(',').map(function runtimeName(name) {
        return name.trim();
    }) : value;
    return normalizeLocalAIConfig({runtimes: selected}).runtimes;
}

/** Add explicitly requested development runtimes to the authored app owner. */
export async function configureDevelopmentLocalAI({appRoot, runtimes, signal} = {}) {
    throwIfAborted(signal);
    if (runtimes === undefined) return;
    const selected = parseLocalAIRuntimeSelection(runtimes);
    let filename = path.join(appRoot, 'arcane-app.json');
    let record;
    let authored = true;
    try {
        record = JSON.parse(await readFile(filename, {encoding: 'utf8', signal}));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        authored = false;
        filename = path.join(appRoot, 'arcane-package.json');
        record = JSON.parse(await readFile(filename, {encoding: 'utf8', signal}));
    }
    const current = normalizeLocalAIConfig(authored ? record.native?.localAI : record.localAI);
    const requirements = new Map((current?.runtimes ?? []).map(function runtimePair(runtime) {
        return [runtime.id, runtime];
    }));
    for (const runtime of selected) {
        requirements.set(runtime.id, {...requirements.get(runtime.id), ...runtime});
    }
    const localAI = {...current, runtimes: [...requirements.values()]};
    if (authored) record.native = {...record.native, localAI};
    else record.localAI = localAI;
    throwIfAborted(signal);
    await writeFile(filename, `${JSON.stringify(record, null, 2)}\n`, {encoding: 'utf8', signal});
    return {path: filename, localAI};
}
