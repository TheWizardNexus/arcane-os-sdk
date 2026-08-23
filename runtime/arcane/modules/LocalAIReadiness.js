import {AI_PREFERENCE_SLOT_KEYS} from './AIPreferenceTuple.js';
import {
    getCoreLocalModelCatalog,
    isUserManagedLoopbackLocalAIStatus,
    USER_MANAGED_LOOPBACK_PROVIDER_MODE
} from './CoreLocalModelCatalog.js';
import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

export const LOCAL_AI_BROWSER_ENDPOINTS=Object.freeze({
    speech:'http://127.0.0.1:8011/health'
});

const DEFAULT_TIMEOUT_MS=3000;
const MAX_TIMEOUT_MS=10000;
const MAX_HEALTH_RESPONSE_CHARACTERS=64*1024;
const LOCAL_SPEECH_PROVIDERS=new Set([
    'LOCAL',
    'LOCAL_SPEACH',
    'LOCAL_SPEECH'
]);

function token(value,{uppercase=false}={}){
    const normalized=typeof value==='string'
        ?value.trim()
        :'';

    return uppercase
        ?normalized.toUpperCase()
        :normalized;
}

function errorCode(error,fallback){
    const code=token(error?.code,{uppercase:true});
    return code&&code.length<=128
        ?code
        :fallback;
}

function freeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value)){
        return value;
    }

    for(const child of Object.values(value)){
        freeze(child);
    }

    return Object.freeze(value);
}

function positiveSafeInteger(value){
    return Number.isSafeInteger(value)&&value>0
        ?value
        :null;
}

function preferenceSlot(preferences,index){
    const value=preferences[index];

    if(typeof value!=='string'||!value.trim()){
        throw new TypeError(
            'The AI preference for '
            +AI_PREFERENCE_SLOT_KEYS[index]
            +' must be a non-empty string.'
        );
    }

    return value.trim();
}

/**
 * Maps Arcane's six-slot AI preference tuple onto the local services that the
 * selected provider/model pairs require. This function does not alter the
 * tuple or choose a replacement provider.
 */
export function deriveLocalAIRequirements(preferences){
    if(!Array.isArray(preferences)||preferences.length!==AI_PREFERENCE_SLOT_KEYS.length){
        throw new TypeError(
            'AI preferences must contain exactly '
            +AI_PREFERENCE_SLOT_KEYS.length
            +' slots.'
        );
    }

    const llmProvider=preferenceSlot(preferences,0);
    const sttProvider=preferenceSlot(preferences,1);
    const ttsProvider=preferenceSlot(preferences,2);
    const llmModel=preferenceSlot(preferences,3);
    const ttsModel=preferenceSlot(preferences,4);
    const sttModel=preferenceSlot(preferences,5);

    return freeze({
        llm:{
            slot:'llm',
            provider:llmProvider,
            model:llmModel,
            required:token(llmProvider,{uppercase:true})==='OLLAMA',
            service:'ollama'
        },
        stt:{
            slot:'stt',
            provider:sttProvider,
            model:sttModel,
            required:LOCAL_SPEECH_PROVIDERS.has(
                token(sttProvider,{uppercase:true})
            ),
            service:'speech'
        },
        tts:{
            slot:'tts',
            provider:ttsProvider,
            model:ttsModel,
            required:LOCAL_SPEECH_PROVIDERS.has(
                token(ttsProvider,{uppercase:true})
            ),
            service:'speech'
        }
    });
}

function explicitHealthBoolean(status,names){
    for(const name of names){
        if(Object.prototype.hasOwnProperty.call(status,name)){
            return status[name]===true;
        }
    }

    return null;
}

function healthBoolean(status,names){
    return explicitHealthBoolean(status,names)??status.ready===true;
}

function healthText(status,names){
    for(const name of names){
        const value=token(status[name]);

        if(value){
            return value.slice(0,128);
        }
    }

    return null;
}

/**
 * Evaluates STT and TTS independently. Raw browser health responses use
 * snake_case fields; Arcane Core responses may use camelCase or their bounded
 * aggregate ready proof.
 */
export function evaluateLocalSpeechHealth(status){
    if(!status||typeof status!=='object'||Array.isArray(status)){
        return freeze({
            reachable:false,
            ready:false,
            status:'unavailable',
            ttsEngine:null,
            sttEngine:null,
            stt:{
                ready:false,
                ffmpeg:false,
                whisperCli:false,
                whisperServer:false,
                whisperModel:false
            },
            tts:{
                ready:false,
                kokoro:false,
                voices:false
            }
        });
    }

    const serviceStatus=healthText(status,['status'])||'unknown';
    const statusReady=serviceStatus.toLowerCase()==='ok'
        ||(serviceStatus==='unknown'&&status.ready===true);
    const ttsEngine=healthText(status,['ttsEngine','tts_engine']);
    const sttEngine=healthText(status,['sttEngine','stt_engine']);
    const ffmpeg=healthBoolean(status,['ffmpeg','ffmpegExists','ffmpeg_exists']);
    const whisperCli=healthBoolean(
        status,
        ['whisperCli','whisperCliExists','whisper_cli_exists']
    );
    const whisperServer=healthBoolean(
        status,
        ['whisperServer','whisperServerExists','whisper_server_exists']
    );
    const whisperModel=healthBoolean(
        status,
        ['whisperModel','whisperExists','whisper_exists']
    );
    const kokoro=healthBoolean(
        status,
        ['kokoro','kokoroExists','kokoro_exists']
    );
    const voices=healthBoolean(
        status,
        ['voices','voicesExists','voices_exists']
    );
    const transcriptionAvailable=explicitHealthBoolean(
        status,
        ['transcriptionAvailable','transcription_available']
    );
    const synthesisAvailable=explicitHealthBoolean(
        status,
        ['synthesisAvailable','synthesis_available']
    );
    const sttReady=statusReady
        &&sttEngine?.toLowerCase()==='whisper.cpp'
        &&(transcriptionAvailable??(
            ffmpeg
            &&whisperCli
            &&whisperServer
            &&whisperModel
        ));
    const ttsReady=statusReady
        &&ttsEngine?.toLowerCase()==='kokoro-onnx'
        &&(synthesisAvailable??(kokoro&&voices));

    return freeze({
        reachable:true,
        ready:sttReady&&ttsReady,
        status:serviceStatus,
        ttsEngine,
        sttEngine,
        stt:{
            ready:Boolean(sttReady),
            ffmpeg,
            whisperCli,
            whisperServer,
            whisperModel
        },
        tts:{
            ready:Boolean(ttsReady),
            kokoro,
            voices
        }
    });
}

function normalizedTimeout(value){
    if(value===undefined){
        return DEFAULT_TIMEOUT_MS;
    }

    if(!Number.isSafeInteger(value)||value<1||value>MAX_TIMEOUT_MS){
        throw new RangeError(
            'Local AI readiness timeout must be between 1 and '
            +MAX_TIMEOUT_MS
            +' milliseconds.'
        );
    }

    return value;
}

async function boundedFetchJSON(fetchImpl,url,timeoutMs){
    if(typeof fetchImpl!=='function'){
        const error=new Error('Browser fetch is unavailable.');
        error.code='BROWSER_FETCH_UNAVAILABLE';
        throw error;
    }

    const controller=typeof AbortController==='function'
        ?new AbortController()
        :null;
    let timer;
    const timeout=new Promise((_resolve,reject)=>{
        timer=setTimeout(()=>{
            controller?.abort();
            const error=new Error('The local readiness request timed out.');
            error.code='LOCAL_AI_READINESS_TIMEOUT';
            reject(error);
        },timeoutMs);
    });
    const request=(async()=>{
        const response=await fetchImpl(
            url,
            {
                method:'GET',
                credentials:'omit',
                cache:'no-store',
                ...(controller?{signal:controller.signal}:{})
            }
        );

        if(!response||response.ok!==true){
            const error=new Error('The local readiness endpoint was not ready.');
            error.code='LOCAL_AI_HEALTH_HTTP_ERROR';
            throw error;
        }

        if(typeof response.text!=='function'){
            const error=new Error('The local readiness endpoint returned an invalid response.');
            error.code='LOCAL_AI_HEALTH_INVALID_RESPONSE';
            throw error;
        }

        const text=await response.text();

        if(
            typeof text!=='string'
            ||!text
            ||text.length>MAX_HEALTH_RESPONSE_CHARACTERS
        ){
            const error=new Error('The local readiness response was outside Arcane limits.');
            error.code='LOCAL_AI_HEALTH_INVALID_RESPONSE';
            throw error;
        }

        let parsed;

        try{
            parsed=JSON.parse(text);
        }catch{
            const error=new Error('The local readiness endpoint returned invalid JSON.');
            error.code='LOCAL_AI_HEALTH_INVALID_RESPONSE';
            throw error;
        }

        if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){
            const error=new Error('The local readiness endpoint returned an invalid record.');
            error.code='LOCAL_AI_HEALTH_INVALID_RESPONSE';
            throw error;
        }

        return parsed;
    })();

    try{
        return await Promise.race([request,timeout]);
    }finally{
        clearTimeout(timer);
    }
}

async function probeNativeOllama(arcane,selectedModel){
    if(typeof arcane?.localAI?.status!=='function'){
        return freeze({
            ready:false,
            model:null,
            errorCode:'ARCANE_LOCAL_AI_STATUS_UNAVAILABLE'
        });
    }

    const model=normalizeOllamaModelIdentifier(selectedModel);

    if(!model){
        return freeze({
            ready:false,
            model:null,
            errorCode:'OLLAMA_MODEL_INVALID'
        });
    }

    try{
        const status=await arcane.localAI.status();
        const activeParallelRequests=positiveSafeInteger(
            status?.ollama?.activeParallelRequests
        );

        if(status?.ollama?.available===false){
            return freeze({
                ready:false,
                model,
                ...(activeParallelRequests===null
                    ?{}
                    :{activeParallelRequests}),
                errorCode:errorCode(
                    {code:status.ollama.errorCode},
                    'OLLAMA_UNAVAILABLE'
                )
            });
        }

        const catalog=getCoreLocalModelCatalog(status);
        const available=catalog.some(function matchesSelectedModel(entry){
            return entry.modelId===model;
        });

        return freeze({
            ready:available,
            model,
            ...(activeParallelRequests===null
                ?{}
                :{activeParallelRequests}),
            errorCode:available?null:'OLLAMA_MODEL_UNAVAILABLE'
        });
    }catch(error){
        return freeze({
            ready:false,
            model,
            errorCode:errorCode(error,'ARCANE_LOCAL_AI_STATUS_INVALID')
        });
    }
}

async function probeUserManagedLoopbackOllama(arcane,selectedModel){
    if(typeof arcane?.localAI?.status!=='function'){
        return freeze({
            ready:false,
            model:null,
            providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE,
            managed:false,
            errorCode:'ARCANE_LOCAL_AI_STATUS_UNAVAILABLE'
        });
    }

    const model=normalizeOllamaModelIdentifier(selectedModel);

    if(!model){
        return freeze({
            ready:false,
            model:null,
            providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE,
            managed:false,
            errorCode:'OLLAMA_MODEL_INVALID'
        });
    }

    try{
        const status=await arcane.localAI.status();

        if(!isUserManagedLoopbackLocalAIStatus(status)){
            return freeze({
                ready:false,
                model,
                providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE,
                managed:false,
                errorCode:'ANDROID_USER_MANAGED_OLLAMA_UNAVAILABLE'
            });
        }

        if(status?.ollama?.available!==true){
            return freeze({
                ready:false,
                model,
                providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE,
                managed:false,
                errorCode:errorCode(
                    {code:status?.ollama?.errorCode},
                    'OLLAMA_UNAVAILABLE'
                )
            });
        }

        const catalog=getCoreLocalModelCatalog(status);
        const available=catalog.some(function matchesSelectedModel(entry){
            return entry.modelId===model;
        });

        return freeze({
            ready:available,
            model,
            providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE,
            managed:false,
            errorCode:available?null:'OLLAMA_MODEL_UNAVAILABLE'
        });
    }catch(error){
        return freeze({
            ready:false,
            model,
            providerMode:USER_MANAGED_LOOPBACK_PROVIDER_MODE,
            managed:false,
            errorCode:errorCode(error,'ANDROID_USER_MANAGED_OLLAMA_UNAVAILABLE')
        });
    }
}

function unavailableBrowserOllama(){
    return freeze({
        ready:false,
        model:null,
        errorCode:'ARCANE_CORE_REQUIRED'
    });
}

async function probeNativeSpeech(arcane){
    if(typeof arcane?.speech?.status!=='function'){
        return freeze({
            ...evaluateLocalSpeechHealth(null),
            errorCode:'ARCANE_SPEECH_UNAVAILABLE'
        });
    }

    try{
        return freeze({
            ...evaluateLocalSpeechHealth(await arcane.speech.status()),
            errorCode:null
        });
    }catch(error){
        return freeze({
            ...evaluateLocalSpeechHealth(null),
            errorCode:errorCode(error,'LOCAL_SPEECH_UNAVAILABLE')
        });
    }
}

async function probeBrowserSpeech(fetchImpl,timeoutMs){
    try{
        return freeze({
            ...evaluateLocalSpeechHealth(
                await boundedFetchJSON(
                    fetchImpl,
                    LOCAL_AI_BROWSER_ENDPOINTS.speech,
                    timeoutMs
                )
            ),
            errorCode:null
        });
    }catch(error){
        return freeze({
            ...evaluateLocalSpeechHealth(null),
            errorCode:errorCode(error,'LOCAL_SPEECH_UNAVAILABLE')
        });
    }
}

async function resolveMode(runtime,arcane){
    if(
        runtime==='native'
        ||runtime==='browser'
        ||runtime===USER_MANAGED_LOOPBACK_PROVIDER_MODE
    ){
        return runtime;
    }

    if(runtime!==undefined&&(!runtime||typeof runtime!=='object')){
        throw new TypeError(
            'Local AI runtime must be "native", "browser", '
            +'"user-managed-loopback", or a runtime snapshot.'
        );
    }

    let snapshot=runtime;

    if(snapshot===undefined&&typeof arcane?.runtime?.current==='function'){
        try{
            snapshot=await arcane.runtime.current();
        }catch{
            snapshot=null;
        }
    }

    if(snapshot?.managedLocalAI===true){
        return 'native';
    }
    if(
        snapshot?.native===true
        &&snapshot?.transport==='android-webview'
    ){
        return USER_MANAGED_LOOPBACK_PROVIDER_MODE;
    }
    return 'browser';
}

async function probeRequiredServices({
    requirements,
    mode,
    arcane,
    fetchImpl,
    timeoutMs
}){
    const requiresSpeech=requirements.stt.required||requirements.tts.required;
    const [ollama,speech]=await Promise.all([
        requirements.llm.required
            ?mode==='native'
                ?probeNativeOllama(arcane,requirements.llm.model)
                :mode===USER_MANAGED_LOOPBACK_PROVIDER_MODE
                    ?probeUserManagedLoopbackOllama(
                        arcane,
                        requirements.llm.model
                    )
                    :unavailableBrowserOllama()
            :null,
        requiresSpeech
            ?mode==='native'
                ?probeNativeSpeech(arcane)
                :mode===USER_MANAGED_LOOPBACK_PROVIDER_MODE
                    ?probeNativeSpeech(arcane)
                    :probeBrowserSpeech(fetchImpl,timeoutMs)
            :null
    ]);

    return freeze({ollama,speech});
}

function slotResults(requirements,services){
    const activeParallelRequests=positiveSafeInteger(
        services.ollama?.activeParallelRequests
    );

    return freeze({
        llm:{
            ...requirements.llm,
            ...(activeParallelRequests===null
                ?{}
                :{activeParallelRequests}),
            ready:requirements.llm.required
                ?services.ollama?.ready===true
                :null,
            status:!requirements.llm.required
                ?'not-selected'
                :services.ollama?.ready===true?'ready':'unavailable',
            errorCode:requirements.llm.required&&services.ollama?.ready!==true
                ?services.ollama?.errorCode||'OLLAMA_UNAVAILABLE'
                :null
        },
        stt:{
            ...requirements.stt,
            ready:requirements.stt.required
                ?services.speech?.stt?.ready===true
                :null,
            status:!requirements.stt.required
                ?'not-selected'
                :services.speech?.stt?.ready===true?'ready':'unavailable',
            errorCode:requirements.stt.required&&services.speech?.stt?.ready!==true
                ?services.speech?.errorCode||'LOCAL_STT_NOT_READY'
                :null
        },
        tts:{
            ...requirements.tts,
            ready:requirements.tts.required
                ?services.speech?.tts?.ready===true
                :null,
            status:!requirements.tts.required
                ?'not-selected'
                :services.speech?.tts?.ready===true?'ready':'unavailable',
            errorCode:requirements.tts.required&&services.speech?.tts?.ready!==true
                ?services.speech?.errorCode||'LOCAL_TTS_NOT_READY'
                :null
        }
    });
}

function unavailableSlots(slots){
    return ['llm','stt','tts'].filter(
        slot=>slots[slot].required&&slots[slot].ready!==true
    );
}

function recoveryServices(slots){
    const services=[];

    if(
        slots.llm.required
        &&slots.llm.ready!==true
        &&!['OLLAMA_MODEL_INVALID','OLLAMA_MODEL_UNAVAILABLE'].includes(
            slots.llm.errorCode
        )
    ){
        services.push('ollama');
    }

    if(
        (slots.stt.required&&slots.stt.ready!==true)
        ||(slots.tts.required&&slots.tts.ready!==true)
    ){
        services.push('speech');
    }

    return services;
}

function recoveryFailureService(error,failedServices){
    const service=token(
        error?.diagnosticDetails?.service?.id,
        {uppercase:false}
    ).toLowerCase();

    return failedServices.includes(service)
        ?service
        :null;
}

function preserveRecoveryFailure(
    services,
    failedServices,
    recoveryErrorCode,
    failedService
){
    if(!recoveryErrorCode){
        return services;
    }

    const targets=failedService
        ?[failedService]
        :failedServices.length===1
            ?failedServices
            :[];

    return freeze({
        ollama:targets.includes('ollama')
            &&services.ollama?.ready!==true
            ?freeze({...services.ollama,errorCode:recoveryErrorCode})
            :services.ollama,
        speech:targets.includes('speech')
            &&(
                services.speech?.stt?.ready!==true
                ||services.speech?.tts?.ready!==true
            )
            ?freeze({...services.speech,errorCode:recoveryErrorCode})
            :services.speech
    });
}

function browserManualInstruction(services){
    if(services.includes('ollama')&&services.includes('speech')){
        return 'Local model access requires Arcane Core. Manually start your local speech service if you still need it.';
    }

    if(services.includes('ollama')){
        return 'Local model access requires Arcane Core.';
    }

    return 'Manually start your local speech service.';
}

function userManagedLoopbackInstruction(services){
    if(services.includes('ollama')&&services.includes('speech')){
        return 'Start your Ollama service in Android Linux Terminal, make the selected model available, and start the Arcane speech service on its configured loopback endpoint.';
    }

    if(services.includes('ollama')){
        return 'Start your Ollama service in Android Linux Terminal and make the selected model available.';
    }

    return 'Start the Arcane speech service on its configured loopback endpoint.';
}

function guidance(mode,slots){
    const affectedSlots=unavailableSlots(slots);

    if(!affectedSlots.length){
        return null;
    }

    const services=recoveryServices(slots);
    const profileSettings=affectedSlots.map(slot=>slot+'Provider');
    const message=mode==='browser'
        ?browserManualInstruction(services)
            +' Alternatively, switch the affected Profile setting to OpenAI and enter an OpenAI API/license key. Arcane will not switch providers automatically.'
        :mode===USER_MANAGED_LOOPBACK_PROVIDER_MODE
            ?userManagedLoopbackInstruction(services)
                +' Arcane does not install, start, repair, pull, or otherwise manage this service or its models. Alternatively, switch the affected Profile setting to OpenAI. Arcane will not switch providers automatically.'
            :'Arcane could not recover the selected local AI service. Retry or review Local AI in Arcane Settings. Arcane will not switch providers automatically.';

    return freeze({
        mode,
        affectedSlots,
        services,
        profileSettings,
        message,
        automaticProviderSwitch:false
    });
}

function nativeRecovery(arcane,recover){
    if(recover!==undefined){
        if(typeof recover!=='function'){
            throw new TypeError('Local AI recovery must be a function.');
        }

        return recover;
    }

    return typeof arcane?.localAI?.recover==='function'
        ?arcane.localAI.recover.bind(arcane.localAI)
        :null;
}

function report({
    mode,
    requirements,
    services,
    recovery
}){
    const slots=slotResults(requirements,services);
    const unavailable=unavailableSlots(slots);

    return freeze({
        ready:unavailable.length===0,
        mode,
        requirements,
        slots,
        services,
        unavailableSlots:unavailable,
        recovery,
        guidance:guidance(mode,slots)
    });
}

/**
 * Checks only the local providers selected in the supplied preference tuple.
 *
 * Managed native Arcane apps use capability-gated bridge methods and may
 * request one bounded recovery attempt before one re-probe. Android uses only
 * admitted native status/chat and speech-status methods for user-managed
 * loopback services and never invokes lifecycle recovery. Ordinary browsers
 * never probe Ollama; browser speech health remains read-only and never invokes
 * recovery.
 */
export async function checkLocalAIReadiness({
    preferences,
    runtime,
    arcane=globalThis.Arcane,
    fetchImpl=globalThis.fetch,
    recover,
    timeoutMs
}={}){
    const requirements=deriveLocalAIRequirements(preferences);
    const mode=await resolveMode(runtime,arcane);
    const timeout=normalizedTimeout(timeoutMs);
    let services=await probeRequiredServices({
        requirements,
        mode,
        arcane,
        fetchImpl,
        timeoutMs:timeout
    });
    let slots=slotResults(requirements,services);
    const failedServices=recoveryServices(slots);
    const recoverNative=mode==='native'
        ?nativeRecovery(arcane,recover)
        :null;
    const recovery={
        attempted:false,
        services:[],
        errorCode:null
    };
    let failedRecoveryService=null;

    if(failedServices.length&&recoverNative){
        recovery.attempted=true;
        recovery.services=[...failedServices];

        try{
            await recoverNative({services:[...failedServices]});
        }catch(error){
            recovery.errorCode=errorCode(error,'LOCAL_AI_RECOVERY_FAILED');
            failedRecoveryService=recoveryFailureService(
                error,
                failedServices
            );
        }

        services=await probeRequiredServices({
            requirements,
            mode,
            arcane,
            fetchImpl,
            timeoutMs:timeout
        });
        services=preserveRecoveryFailure(
            services,
            failedServices,
            recovery.errorCode,
            failedRecoveryService
        );
        slots=slotResults(requirements,services);
    }

    return report({
        mode,
        requirements,
        services,
        recovery:freeze(recovery)
    });
}
