import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

const MAX_CORE_LOCAL_MODELS=64;

export const USER_MANAGED_LOOPBACK_PROVIDER_MODE='user-managed-loopback';

/**
 * Identifies the bounded Android host response that delegates inference to a
 * user-owned loopback Ollama process. This is provider discovery only: it does
 * not claim that Arcane manages the service or any model lifecycle operation.
 */
export function isUserManagedLoopbackLocalAIStatus(status){
    return status?.schemaVersion===2
        &&status?.providerMode===USER_MANAGED_LOOPBACK_PROVIDER_MODE;
}

function modelDescriptor(model){
    const id=normalizeOllamaModelIdentifier(model?.id);
    const name=normalizeOllamaModelIdentifier(model?.name);

    if(!id||!name){
        throw new TypeError('Arcane Core returned an invalid local-model identifier.');
    }

    return Object.freeze({
        providerValue:'OLLAMA',
        preferenceValue:id,
        modelId:id,
        label:name
    });
}

/**
 * Converts the authoritative Core catalog to UI-safe descriptors without
 * filtering, sorting, or interpreting admission metadata in the renderer.
 */
export function getCoreLocalModelCatalog(status){
    const models=status?.models?.ollama;

    if(!Array.isArray(models)){
        return Object.freeze([]);
    }
    if(models.length>MAX_CORE_LOCAL_MODELS){
        throw new RangeError('Arcane Core returned too many local models.');
    }

    return Object.freeze(models.map(modelDescriptor));
}
