import Is from 'strong-type';
const is=new Is(false);

const OLLAMA_MODEL_IDENTIFIER=
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;

/**
 * Returns an exact bounded Ollama model identifier or null. This validates
 * transport shape only; it does not infer ownership, capability, or hardware
 * compatibility from the name.
 */
export function normalizeOllamaModelIdentifier(value){
    if(!is.string(value)||value!==value.trim()){
        return null;
    }
    if(!OLLAMA_MODEL_IDENTIFIER.test(value)||value.toUpperCase()==='TWIN'){
        return null;
    }
    return value;
}

export function isOllamaModelIdentifier(value){
    return normalizeOllamaModelIdentifier(value)!==null;
}

/** Compare Ollama names with its default host, namespace and tag; never rewrite a request. */
export function sameOllamaModelIdentifier(left,right){
    if(!is.string(left)||!is.string(right))return false;
    function identity(value){
        const parts=value.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//,'').split('/');
        const model=parts.pop();
        const namespace=parts.pop()??'library';
        const host=parts.join('/')||'registry.ollama.ai';
        return `${host}/${namespace}/${model.includes(':')?model:`${model}:latest`}`.toLowerCase();
    }
    return identity(left)===identity(right);
}
