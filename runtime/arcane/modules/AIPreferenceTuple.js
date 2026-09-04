export const AI_PREFERENCE_SLOT_KEYS=Object.freeze([
    'llmProvider',
    'sttProvider',
    'ttsProvider',
    'llmModel',
    'ttsModel',
    'sttModel'
]);

function preferenceToken(value){
    return typeof value==='string'
        ?value.trim()
        :'';
}

function allowedTokensForSlot(allowedValues,index){
    const supplied=allowedValues[index];

    if(supplied===undefined||supplied===null){
        return null;
    }

    if(!Array.isArray(supplied)&&!(supplied instanceof Set)){
        throw new TypeError(
            `Allowed AI preference values for ${AI_PREFERENCE_SLOT_KEYS[index]} must be an array or Set.`
        );
    }

    return new Set(
        Array.from(supplied,preferenceToken).filter(Boolean)
    );
}

/**
 * Normalizes the shared six-slot AI preference contract without choosing any
 * provider or model policy. Applications supply their own defaults, allowed
 * values, and provider aliases.
 *
 * Slot order:
 * [LLM provider, STT provider, TTS provider, LLM model, TTS model, STT model]
 */
export function normalizeAIPreferenceTuple(
    value,
    {
        defaults,
        allowedValues=[],
        aliases=[]
    }={}
){
    if(!Array.isArray(defaults)||defaults.length!==AI_PREFERENCE_SLOT_KEYS.length){
        throw new TypeError(
            `AI preference defaults must contain exactly ${AI_PREFERENCE_SLOT_KEYS.length} slots.`
        );
    }

    const source=Array.isArray(value)?value:[];

    return AI_PREFERENCE_SLOT_KEYS.map((slot,index)=>{
        const fallback=preferenceToken(defaults[index]);

        if(!fallback){
            throw new TypeError(`The default AI preference for ${slot} must be a non-empty string.`);
        }

        const slotAliases=aliases[index]||{};
        let candidate=preferenceToken(source[index]);

        if(candidate&&Object.prototype.hasOwnProperty.call(slotAliases,candidate)){
            candidate=preferenceToken(slotAliases[candidate]);
        }

        const allowed=allowedTokensForSlot(allowedValues,index);

        if(allowed&&!allowed.has(fallback)){
            throw new TypeError(`The default AI preference for ${slot} must be allowed.`);
        }

        if(!candidate||(allowed&&!allowed.has(candidate))){
            return fallback;
        }

        return candidate;
    });
}

export function aiPreferenceTuplesEqual(left,right){
    return Array.isArray(left)
        &&Array.isArray(right)
        &&left.length===AI_PREFERENCE_SLOT_KEYS.length
        &&right.length===AI_PREFERENCE_SLOT_KEYS.length
        &&left.every((value,index)=>value===right[index]);
}
