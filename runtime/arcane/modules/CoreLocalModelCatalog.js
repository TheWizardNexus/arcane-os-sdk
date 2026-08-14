import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

const MAX_CORE_LOCAL_MODELS=64;

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
