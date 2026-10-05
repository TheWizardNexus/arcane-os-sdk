import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';

const is = new Is(false);
export const LOCAL_AI_RUNTIME_IDS = ['llama.cpp', 'ollama'];

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
