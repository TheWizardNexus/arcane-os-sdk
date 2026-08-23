import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

const MAX_CORE_LOCAL_SPEECH_MODELS=8;

const ADMISSION_REASON_BY_CODE=Object.freeze({
    MODEL_ADMISSION_CONTEXT_EXCEEDS_MODEL_LIMIT:'context exceeds model limit',
    MODEL_ADMISSION_CONTEXT_UNAVAILABLE:'context metadata unavailable',
    MODEL_ADMISSION_DEFINITION_INVALID:'model definition unavailable',
    MODEL_ADMISSION_DEFINITION_UNAVAILABLE:'model definition unavailable',
    MODEL_ADMISSION_KV_EVIDENCE_UNAVAILABLE:'KV-cache metadata unavailable',
    MODEL_ADMISSION_MEMORY_INSUFFICIENT:'insufficient memory at this context',
    MODEL_ADMISSION_METADATA_UNAVAILABLE:'model metadata unavailable',
    MODEL_ADMISSION_RUNNING_MODELS_UNAVAILABLE:'loaded-model state unavailable',
    MODEL_ADMISSION_SIZE_UNAVAILABLE:'model size unavailable',
    MODEL_ADMISSION_STORAGE_INSUFFICIENT:'insufficient model storage',
    MODEL_ADMISSION_STORAGE_UNAVAILABLE:'model storage unavailable',
    MODEL_ADMISSION_SYSTEM_MEMORY_UNAVAILABLE:'system memory unavailable',
    MODEL_DEFINITION_VERIFICATION_FAILED:'model definition needs repair',
    MODEL_PREFLIGHT_FAILED:'registry preflight unavailable'
});

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

function boundedParallelRequests(value,{allowZero=false}={}){
    return Number.isSafeInteger(value)
        &&(allowZero?value>=0:value>=1)
        ?value
        :null;
}

function admissionCode(compatibility){
    const code=compatibility?.code;

    return typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,95}$/.test(code)
        ?code
        :null;
}

function unavailableReason({
    activeParallelRequests,
    code,
    maxAllowedParallelRequests
}){
    if(
        activeParallelRequests!==null
        &&maxAllowedParallelRequests!==null
        &&activeParallelRequests>maxAllowedParallelRequests
    ){
        if(maxAllowedParallelRequests===0){
            return 'insufficient memory at this context';
        }

        const noun=maxAllowedParallelRequests===1?'request':'requests';
        return `active ${activeParallelRequests}; max ${maxAllowedParallelRequests} parallel ${noun}`;
    }

    return ADMISSION_REASON_BY_CODE[code]||'not currently available';
}

function admissionAwareModelDescriptor(model,{rejected=false,activeFallback=null}={}){
    const id=normalizeOllamaModelIdentifier(model?.id);
    const name=normalizeOllamaModelIdentifier(model?.name??model?.id);

    if(!id||!name){
        throw new TypeError('Arcane Core returned an invalid local-model identifier.');
    }

    const compatibility=model?.compatibility&&typeof model.compatibility==='object'
        &&!Array.isArray(model.compatibility)
        ?model.compatibility
        :null;
    const activeParallelRequests=boundedParallelRequests(
        compatibility?.activeParallelRequests
    )??activeFallback;
    const maxAllowedParallelRequests=boundedParallelRequests(
        compatibility?.maxAllowedParallelRequests,
        {allowZero:true}
    );
    const activeParallelRequestsAllowed=
        typeof compatibility?.activeParallelRequestsAllowed==='boolean'
            ?compatibility.activeParallelRequestsAllowed
            :null;
    const repairRequired=compatibility?.creationRequired===true
        &&compatibility?.baseModelInstalled===true;
    const downloadRequired=compatibility?.pullRequired===true
        &&compatibility?.baseModelInstalled!==true;
    const code=admissionCode(compatibility);
    const disabled=rejected
        ||model?.runnable===false
        ||activeParallelRequestsAllowed===false;
    const unavailable=disabled
        ?unavailableReason({
            activeParallelRequests,
            code,
            maxAllowedParallelRequests
        })
        :null;
    const reason=[
        repairRequired?'repair required':null,
        downloadRequired?'download required':null,
        unavailable
    ].filter(Boolean).join('; ')||null;
    const status=rejected
        ?'rejected'
        :disabled
            ?'not-runnable'
            :repairRequired
                ?'repair-required'
                :downloadRequired
                    ?'download-required'
                    :'available';

    return Object.freeze({
        providerValue:'OLLAMA',
        preferenceValue:id,
        modelId:id,
        label:reason?`${name} (${reason})`:name,
        disabled,
        status,
        reason,
        repairRequired,
        downloadRequired,
        admissionCode:code,
        activeParallelRequests,
        maxAllowedParallelRequests,
        activeParallelRequestsAllowed
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
    return Object.freeze(models.map(modelDescriptor));
}

/**
 * Preserves Core admission failures for a bounded model-picker inventory.
 * Failure text is projected from stable codes instead of rendering native
 * diagnostic messages in the application UI.
 */
export function getCoreLocalModelCatalogWithAdmissionFailures(status){
    const admitted=Array.isArray(status?.models?.ollama)
        ?status.models.ollama
        :[];
    const rejected=Array.isArray(status?.admission?.rejected)
        ?status.admission.rejected
        :[];

    const activeFallback=boundedParallelRequests(
        status?.ollama?.activeParallelRequests
    );
    const descriptors=[
        ...admitted.map(model=>admissionAwareModelDescriptor(
            model,
            {activeFallback}
        )),
        ...rejected.map(model=>admissionAwareModelDescriptor(
            model,
            {rejected:true,activeFallback}
        ))
    ];
    const identifiers=new Set();

    for(const descriptor of descriptors){
        const canonical=descriptor.modelId.toLowerCase();

        if(identifiers.has(canonical)){
            throw new TypeError('Arcane Core returned a duplicate local-model identifier.');
        }
        identifiers.add(canonical);
    }

    return Object.freeze(descriptors);
}

function hasAvailableSpeechRole(models,role){
    if(!Array.isArray(models)){
        return false;
    }
    if(models.length>MAX_CORE_LOCAL_SPEECH_MODELS){
        throw new RangeError('Arcane Core returned too many local speech models.');
    }

    let available=false;
    for(const model of models){
        if(
            !model
            ||typeof model!=='object'
            ||Array.isArray(model)
            ||typeof model.id!=='string'
            ||!model.id
            ||model.id.length>128
            ||typeof model.name!=='string'
            ||!model.name
            ||model.name.length>128
            ||model.provider!=='speech'
            ||!Array.isArray(model.roles)
            ||model.roles.length<1
            ||model.roles.length>2
            ||!model.roles.every(candidate=>candidate==='stt'||candidate==='tts')
        ){
            throw new TypeError('Arcane Core returned an invalid local speech model.');
        }
        if(model.available===true&&model.roles.includes(role)){
            available=true;
        }
    }
    return available;
}

/**
 * Projects Core's role-specific speech health and catalog into the two local
 * profile choices without granting the renderer any service endpoint access.
 */
export function getCoreLocalSpeechAvailability(status){
    return Object.freeze({
        stt:status?.speech?.transcriptionAvailable===true
            &&hasAvailableSpeechRole(status?.models?.transcription,'stt'),
        tts:status?.speech?.synthesisAvailable===true
            &&hasAvailableSpeechRole(status?.models?.speech,'tts')
    });
}
