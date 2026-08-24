const OLLAMA_MODEL_IDENTIFIER=
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

/**
 * Returns an exact bounded Ollama model identifier or null. This validates
 * transport shape only; it does not infer ownership, capability, or hardware
 * compatibility from the name.
 */
export function normalizeOllamaModelIdentifier(value){
    if(typeof value!=='string'||value!==value.trim()){
        return null;
    }
    if(!OLLAMA_MODEL_IDENTIFIER.test(value)||value.toUpperCase()==='OPENAI'){
        return null;
    }
    return value;
}

export function isOllamaModelIdentifier(value){
    return normalizeOllamaModelIdentifier(value)!==null;
}
