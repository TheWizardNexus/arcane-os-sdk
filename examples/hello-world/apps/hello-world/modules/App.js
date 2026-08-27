import arcaneThemeReady from 'arcane/ThemeBootstrap';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from 'arcane/AppDataScope';
import DBOPFS from 'arcane/DBOPFS';
import {
    createArcaneAI,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';
import {
    createBrowserKokoroProvider,
    createBrowserSpeechAuthority,
    createBrowserWhisperProvider,
    createDbopfsSpeechArtifactStore
} from 'arcane-os/ai/browser-speech';
import speechAuthorities from './SpeechAuthorities.js';

const MODEL=Object.freeze({
    id:'ibm-granite-4.1-3b-q4-k-s',
    url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf',
    bytes:1_998_371_424,
    sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a'
});

const SPEECH_PROVIDER_IDS=Object.freeze({
    stt:'hello-world-browser-whisper',
    tts:'hello-world-browser-kokoro'
});
const MAX_LLM_PROMPT_LENGTH=2000;
const MAX_STT_FILE_BYTES=8*1024*1024;
const MAX_TTS_TEXT_LENGTH=500;

const SHOW_GREETING_TOOL=Object.freeze({
    type:'function',
    function:Object.freeze({
        name:'show_greeting',
        description:'Propose greeting text for the application to review.',
        parameters:Object.freeze({
            type:'object',
            properties:Object.freeze({
                message:Object.freeze({type:'string'})
            }),
            required:Object.freeze(['message']),
            additionalProperties:false
        })
    })
});

const ERROR_COPY=Object.freeze({
    HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED:'This speech role has no complete app-owned model, runtime, license, revision, URL, and hash authority. TTS also requires a voice. Configure SpeechAuthorities.js before loading it.',
    HELLO_WORLD_STT_FILE_REQUIRED:'Choose a nonempty audio file before transcribing.',
    HELLO_WORLD_STT_FILE_TOO_LARGE:'Choose an audio file no larger than 8 MiB so browser decoding remains bounded.',
    HELLO_WORLD_STT_MIME_TYPE_REQUIRED:'The chosen audio file must declare its audio media type.',
    HELLO_WORLD_TTS_TEXT_REQUIRED:'Enter text before synthesizing speech.',
    HELLO_WORLD_TTS_TEXT_TOO_LONG:'Keep text-to-speech input at 500 characters or fewer so synthesis remains bounded.',
    HELLO_WORLD_AUDIO_PLAYBACK_UNAVAILABLE:'This browser cannot expose the synthesized WAV for user-controlled playback.',
    HELLO_WORLD_LLM_PROMPT_TOO_LONG:'Keep the language-model prompt at 2,000 characters or fewer so tokenization remains bounded.',
    ARCANE_AI_REQUEST_ABORTED:'The operation was cancelled. Any admitted DBOPFS cache remains; interrupted downloads are discarded.',
    ARCANE_AI_OPERATION_SUPERSEDED:'A newer lifecycle operation replaced this one safely.',
    ARCANE_AI_MODEL_AUTHORITY_REQUIRED:'The selected model does not match the admitted application authority.',
    ARCANE_AI_MODEL_OFFLINE_MISS:'No verified offline LLM cache is available. Load once while online first.',
    ARCANE_AI_ARTIFACT_OFFLINE_MISS:'No admitted offline speech cache is available. Load this role once while online first.',
    ARCANE_AI_MODEL_DOWNLOAD_FAILED:'The model download failed. Check the network and try again.',
    ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED:'A declared speech artifact could not be downloaded.',
    ARCANE_AI_MODEL_REDIRECT_BLOCKED:'The model response left HTTPS and was rejected.',
    ARCANE_AI_ARTIFACT_SOURCE_CHANGED:'A speech artifact response left its admitted immutable URL and was rejected.',
    ARCANE_AI_ARTIFACT_SOURCE_INVALID:'A declared speech artifact did not provide readable bytes.',
    ARCANE_AI_ARTIFACT_SOURCE_UNAVAILABLE:'Speech artifact fetching is unavailable in this browser.',
    ARCANE_AI_MODEL_SIZE_MISMATCH:'The downloaded model size did not match its declared authority.',
    ARCANE_AI_ARTIFACT_SIZE_MISMATCH:'A speech artifact size did not match its declared authority.',
    ARCANE_AI_MODEL_DIGEST_MISMATCH:'The downloaded bytes failed SHA-256 verification and were removed.',
    ARCANE_AI_ARTIFACT_DIGEST_MISMATCH:'A speech artifact failed SHA-256 verification and was removed.',
    ARCANE_AI_MODEL_CACHE_REJECTED:'The completed model cache failed revalidation and was not admitted.',
    ARCANE_AI_ARTIFACT_CACHE_REJECTED:'The completed speech cache failed revalidation and was not admitted.',
    ARCANE_AI_WEBGPU_REQUIRED:'This LLM requires a WebGPU-capable browser and device.',
    ARCANE_AI_WEBGPU_API_UNAVAILABLE:'This browser does not expose the WebGPU API required by this LLM.',
    ARCANE_AI_WEBGPU_EVIDENCE_INVALID:'The provider could not prove the required WebGPU execution boundary.',
    ARCANE_AI_MODEL_WEBGPU_REQUIREMENT_FAILED:'The selected model could not satisfy its required WebGPU execution policy.',
    ARCANE_AI_MODEL_FULL_OFFLOAD_UNPROVEN:'The provider could not prove full model offload to WebGPU.',
    ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT:'The selected device does not have enough reported GPU memory for this model.',
    ARCANE_AI_MODEL_SHARD_TOO_LARGE:'A model shard is too large for the selected WebGPU device.',
    ARCANE_AI_WEBASSEMBLY_UNAVAILABLE:'This browser does not provide the WebAssembly support required by the local runtime.',
    ARCANE_AI_SECURE_CONTEXT_REQUIRED:'Open this app from HTTPS or a loopback development URL so secure browser APIs are available.',
    ARCANE_AI_OPFS_UNAVAILABLE:'This browser does not provide the origin-private storage required for verified model cache data.',
    ARCANE_AI_STORAGE_BUSY:'Another browser context is updating this exact authority.',
    ARCANE_AI_STORAGE_UNAVAILABLE:'App-scoped browser storage is unavailable.',
    ARCANE_AI_STORAGE_READ_FAILED:'The admitted speech cache could not be read.',
    ARCANE_AI_STORAGE_DELETE_FAILED:'An invalid speech cache could not be removed safely.',
    ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED:'The speech runtime attempted to leave its declared module closure.',
    ARCANE_AI_AUDIO_DECODE_UNAVAILABLE:'This browser cannot decode the selected file to the required speech input.',
    ARCANE_AI_AUDIO_DECODE_FAILED:'The selected audio file could not be decoded to 16 kHz mono speech input.',
    ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT:'The speech provider did not admit the requested WAV format.',
    ARCANE_AI_UNDECLARED_ARTIFACT:'The speech runtime requested an artifact outside its admitted closure.',
    ARCANE_AI_WORKER_CRASHED:'The isolated speech Worker stopped unexpectedly.',
    ARCANE_AI_WORKER_MESSAGE_ERROR:'The isolated speech Worker returned an invalid message.',
    ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH:'The admitted speech runtime does not implement the SDK protocol.',
    ARCANE_AI_PROVIDER_LOAD_FAILED:'The selected local provider could not be loaded.',
    ARCANE_AI_PROVIDER_REQUEST_FAILED:'The selected local provider could not complete the request.',
    ARCANE_AI_PROVIDER_UNAVAILABLE:'The selected local provider is unavailable.',
    ARCANE_AI_PROVIDER_BUSY:'This role is already processing one request.',
    ARCANE_AI_PROVIDER_DISPOSED:'This speech provider generation is closed. Load the role to create another.',
    ARCANE_AI_INVALID_REQUEST:'The request did not match the selected role contract.',
    ARCANE_AI_INVALID_PROVIDER_RESULT:'The provider returned data outside the SDK contract.',
    ARCANE_AI_NOT_READY:'Load this role before requesting local inference.',
    ARCANE_AI_LOCAL_ONLY_UNAVAILABLE:'The selected provider cannot guarantee browser-local inference.',
    ARCANE_AI_DISPOSED:'This local AI session is closed. Reload the page to create another.',
    ARCANE_AI_REQUEST_FAILED:'The browser-local AI operation failed safely.',
    APP_DATA_SCOPE_MISMATCH:'The browser storage singleton belongs to another application.',
    APP_DATA_STORAGE_UNAVAILABLE:'App-scoped browser storage is unavailable.'
});

const action=document.querySelector('#app-action');
const status=document.querySelector('#app-status');
const aiLoad=document.querySelector('#ai-load');
const aiLoadOffline=document.querySelector('#ai-load-offline');
const aiUnload=document.querySelector('#ai-unload');
const aiCancel=document.querySelector('#ai-cancel');
const aiPrompt=document.querySelector('#ai-prompt');
const aiSend=document.querySelector('#ai-send');
const aiStatus=document.querySelector('#ai-status');
const aiLifecycle=document.querySelector('#ai-lifecycle');
const aiProgress=document.querySelector('#ai-progress');
const aiProgressLabel=document.querySelector('#ai-progress-label');
const aiResponse=document.querySelector('#ai-response');
const aiToolCalls=document.querySelector('#ai-tool-calls');
const speechAuthorityStatus=document.querySelector('#speech-authority-status');

const speechControls=Object.freeze({
    tts:Object.freeze({
        lifecycle:document.querySelector('#tts-lifecycle'),
        status:document.querySelector('#tts-status'),
        load:document.querySelector('#tts-load'),
        loadOffline:document.querySelector('#tts-load-offline'),
        cancel:document.querySelector('#tts-cancel'),
        unload:document.querySelector('#tts-unload'),
        progress:document.querySelector('#tts-progress'),
        progressLabel:document.querySelector('#tts-progress-label'),
        input:document.querySelector('#tts-input'),
        request:document.querySelector('#tts-synthesize'),
        audio:document.querySelector('#tts-audio')
    }),
    stt:Object.freeze({
        lifecycle:document.querySelector('#stt-lifecycle'),
        status:document.querySelector('#stt-status'),
        load:document.querySelector('#stt-load'),
        loadOffline:document.querySelector('#stt-load-offline'),
        cancel:document.querySelector('#stt-cancel'),
        unload:document.querySelector('#stt-unload'),
        progress:document.querySelector('#stt-progress'),
        progressLabel:document.querySelector('#stt-progress-label'),
        file:document.querySelector('#stt-file'),
        request:document.querySelector('#stt-transcribe'),
        transcript:document.querySelector('#stt-transcript')
    })
});

function ignoreReadyFailure(){
    // The first explicit AI action reports storage readiness with a stable code.
}

globalThis.dbopfs?.readyPromise?.catch(ignoreReadyFailure);
await arcaneThemeReady;

const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey('hello-count',{applicationId:appId});
const pageController=new AbortController();
const roleOperations={
    llm:{controller:null,name:null,pageAbortHandler:null},
    stt:{controller:null,name:null,pageAbortHandler:null},
    tts:{controller:null,name:null,pageAbortHandler:null}
};
const speechProviders={stt:null,tts:null};
const speechProviderOffline={stt:null,tts:null};
const speechAuthorityCache={stt:undefined,tts:undefined};
let dbopfsPromise=null;
let speechStorePromise=null;
let ai=null;
let aiPromise=null;
let pageDisposePromise=null;
let requestNumber=0;
let ttsAudioUrl=null;

function loadHelloCount(){
    try{
        const value=Number(globalThis.localStorage?.getItem(countKey)??0);
        return Number.isSafeInteger(value)&&value>=0?value:0;
    }catch{
        return 0;
    }
}

function saveHelloCount(value){
    try{
        globalThis.localStorage?.setItem(countKey,String(value));
    }catch{
        // The greeting still works when browser persistence is unavailable.
    }
}

function sayHello(){
    const count=loadHelloCount()+1;
    saveHelloCount(count);
    status.textContent=`Hello from Arcane OS! Greeting ${count}.`;
}

function createPublicError(code){
    const error=new Error(code);
    error.code=code;
    return error;
}

function publicErrorCode(error){
    const suppliedCode=typeof error?.code==='string'?error.code:'';
    if(suppliedCode.startsWith('ARCANE_AI_')
        ||suppliedCode.startsWith('APP_DATA_')
        ||suppliedCode.startsWith('HELLO_WORLD_')){
        return suppliedCode;
    }
    return 'ARCANE_AI_REQUEST_FAILED';
}

function renderPublicError(target,error){
    const code=publicErrorCode(error);
    const message=ERROR_COPY[code]??ERROR_COPY.ARCANE_AI_REQUEST_FAILED;
    target.textContent=`${code}: ${message}`;
}

function throwIfAborted(signal){
    if(signal?.aborted)throw createPublicError('ARCANE_AI_REQUEST_ABORTED');
}

function beginRoleOperation(role,name){
    const operation=roleOperations[role];
    if(pageController.signal.aborted||operation.controller)return null;
    const controller=new AbortController();
    function abortOperationForPage(){
        controller.abort('The page is closing.');
    }
    pageController.signal.addEventListener('abort',abortOperationForPage,{once:true});
    operation.controller=controller;
    operation.name=name;
    operation.pageAbortHandler=abortOperationForPage;
    updateRoleControls(role);
    return controller;
}

function finishRoleOperation(role,controller){
    const operation=roleOperations[role];
    if(operation.controller!==controller)return;
    if(operation.pageAbortHandler){
        pageController.signal.removeEventListener('abort',operation.pageAbortHandler);
    }
    operation.controller=null;
    operation.name=null;
    operation.pageAbortHandler=null;
    updateRoleControls(role);
}

function cancelRoleOperation(role){
    roleOperations[role].controller?.abort('Cancelled by the application user.');
}

function lifecycleState(){
    return ai?.status?.().llm?.state??'unloaded';
}

function updateLlmControls(){
    const state=lifecycleState();
    const operation=roleOperations.llm;
    const busy=operation.controller!==null;
    aiLifecycle.textContent=`Lifecycle: ${state}.`;
    aiLoad.disabled=busy||state==='ready';
    aiLoadOffline.disabled=busy||state==='ready';
    aiSend.disabled=busy||state!=='ready';
    aiUnload.disabled=busy||ai===null||state==='unloaded';
    aiCancel.disabled=!busy||operation.name==='unload';
    aiCancel.hidden=!busy||operation.name==='unload';
}

function speechLifecycleState(role){
    if(!configuredSpeechAuthority(role))return 'authority-required';
    return speechProviders[role]?.status?.().state??'unloaded';
}

function updateSpeechControls(role){
    const controls=speechControls[role];
    if(!controls.lifecycle)return;
    const state=speechLifecycleState(role);
    const operation=roleOperations[role];
    const busy=operation.controller!==null;
    controls.lifecycle.textContent=`Lifecycle: ${state}.`;
    controls.load.disabled=busy||state==='ready';
    controls.loadOffline.disabled=busy||state==='ready';
    controls.request.disabled=busy||state!=='ready';
    if(role==='stt')controls.file.disabled=busy||state!=='ready';
    controls.unload.disabled=busy||speechProviders[role]===null||state==='unloaded';
    controls.cancel.disabled=!busy||operation.name==='unload';
    controls.cancel.hidden=!busy||operation.name==='unload';
}

function updateRoleControls(role){
    if(role==='llm'){
        updateLlmControls();
        return;
    }
    updateSpeechControls(role);
}

function renderSpeechAuthorityStatus(){
    if(!speechAuthorityStatus)return;
    const missing=[];
    if(!configuredSpeechAuthority('tts'))missing.push('TTS');
    if(!configuredSpeechAuthority('stt'))missing.push('STT');
    if(missing.length===0){
        speechAuthorityStatus.textContent='Speech authorities configured. Loading still starts only from the matching role button.';
        return;
    }
    speechAuthorityStatus.textContent=`HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED: ${missing.join(' and ')} remain fail-closed until the application supplies immutable, licensed authority in SpeechAuthorities.js.`;
}

async function initializeApplicationDbopfs(){
    const dbopfs=globalThis.dbopfs||new DBOPFS({applicationId:appId});
    try{
        await dbopfs.readyPromise;
    }catch(cause){
        if(typeof cause?.code==='string'&&cause.code.startsWith('APP_DATA_')){
            throw cause;
        }
        const error=new Error('App-scoped browser storage is unavailable.',{cause});
        error.code='APP_DATA_STORAGE_UNAVAILABLE';
        throw error;
    }
    if(dbopfs.applicationId!==appId){
        throw createPublicError('APP_DATA_SCOPE_MISMATCH');
    }
    return dbopfs;
}

function resetDbopfsPromise(error){
    dbopfsPromise=null;
    throw error;
}

function applicationDbopfs(){
    if(dbopfsPromise)return dbopfsPromise;
    dbopfsPromise=initializeApplicationDbopfs().catch(resetDbopfsPromise);
    return dbopfsPromise;
}

async function initializeSpeechStore(){
    return createDbopfsSpeechArtifactStore({dbopfs:await applicationDbopfs()});
}

function resetSpeechStorePromise(error){
    speechStorePromise=null;
    throw error;
}

function speechArtifactStore(){
    if(speechStorePromise)return speechStorePromise;
    speechStorePromise=initializeSpeechStore().catch(resetSpeechStorePromise);
    return speechStorePromise;
}

function renderLlmProgress(value){
    if(!value||typeof value!=='object')return;
    const total=Number(value.total)||MODEL.bytes;
    const loaded=Math.min(total,Math.max(0,Number(value.loaded)||0));
    const phase={
        download:'Downloading model bytes',
        'verify-download':'Verifying the downloaded model SHA-256',
        'verify-cache':'Rehashing the DBOPFS cache',
        initialize:'Starting the browser-local runtime'
    }[value.phase]??'Preparing local AI';
    aiProgress.max=total;
    aiProgress.value=loaded;
    aiProgress.hidden=false;
    const percent=Number.isFinite(value.percent)?`${value.percent.toFixed(1)}%`:'in progress';
    aiProgressLabel.textContent=`${phase}: ${percent}.`;
}

function handleLlmProgressEvent(event){
    renderLlmProgress(event.detail?.progress);
}

async function createLocalAIInstance(){
    const dbopfs=await applicationDbopfs();
    const store=createDbopfsModelStore({dbopfs});
    const source=createBrowserModelSource(MODEL);
    const provider=createBrowserWasmLlmProvider({
        source,
        store,
        loadDefaults:{
            contextTokens:1024,
            threads:1,
            batchTokens:256,
            microBatchTokens:64
        }
    });
    const created=createArcaneAI({
        provider,
        loadPolicy:'manual',
        security:{secure:true}
    });
    created.llm.addEventListener('progress',handleLlmProgressEvent);
    created.llm.addEventListener('statechange',updateLlmControls);
    ai=created;
    updateLlmControls();
    return created;
}

function resetAiPromise(error){
    aiPromise=null;
    throw error;
}

function localAI(){
    if(ai)return Promise.resolve(ai);
    if(aiPromise)return aiPromise;
    aiPromise=createLocalAIInstance().catch(resetAiPromise);
    return aiPromise;
}

async function loadModel(options={}){
    const offline=options.offline===true;
    const controller=beginRoleOperation('llm',offline?'offline-load':'load');
    if(!controller)return;
    aiStatus.textContent=offline
        ?'Checking the verified DBOPFS cache without a model-source request. Packaged same-origin Wllama/WASM assets may still load.'
        :'Checking the strict cache. A 1.86 GiB model download starts only if it is missing.';
    aiProgress.hidden=true;
    aiProgressLabel.textContent='';
    try{
        const local=await localAI();
        const result=await local.load({signal:controller.signal,offline});
        const cacheState=result.cache?.state??local.status().llm.cache?.state;
        aiProgress.max=MODEL.bytes;
        aiProgress.value=MODEL.bytes;
        aiProgress.hidden=false;
        if(cacheState==='installed'){
            aiStatus.textContent='Model downloaded, SHA-256 verified, admitted to app-scoped DBOPFS, and loaded locally.';
        }else{
            aiStatus.textContent=offline
                ?'Verified DBOPFS cache loaded without a model-source request.'
                :'Verified DBOPFS cache reused and loaded locally.';
        }
        aiProgressLabel.textContent='Browser-local model ready.';
    }catch(error){
        renderPublicError(aiStatus,error);
    }finally{
        finishRoleOperation('llm',controller);
    }
}

function renderToolCalls(result){
    if(!result||typeof result!=='object'||Array.isArray(result)){
        aiToolCalls.textContent='No tool calls were proposed. Structural output is displayed only; the application invokes no tool.';
        return;
    }
    const records=Object.entries(result);
    if(records.length===0){
        aiToolCalls.textContent='No tool calls were proposed. Structural output is displayed only; the application invokes no tool.';
        return;
    }
    const lines=['Proposed tool calls (structural output only):'];
    for(const [name,argumentsJson] of records){
        lines.push(`name: ${name}`,`arguments: ${String(argumentsJson)}`);
    }
    aiToolCalls.textContent=lines.join('\n');
}

async function askLocalAI(){
    const controller=beginRoleOperation('llm','request');
    if(!controller)return;
    aiResponse.textContent='';
    aiToolCalls.textContent='Waiting for a response. Proposed tool calls remain structural output only.';
    aiStatus.textContent='Running this request locally in the browser.';
    try{
        const prompt=aiPrompt.value.trim()||'Say hello in one short sentence.';
        if(prompt.length>MAX_LLM_PROMPT_LENGTH){
            throw createPublicError('HELLO_WORLD_LLM_PROMPT_TOO_LONG');
        }
        const local=await localAI();
        const result=await local.streamRequest({
            id:`hello-world-${++requestNumber}`,
            localOnly:true,
            signal:controller.signal,
            messages:[{
                role:'user',
                content:prompt
            }],
            temperature:0,
            maxTokens:128,
            tools:[SHOW_GREETING_TOOL],
            toolChoice:'auto',
            onChunk(text,_requestId,isThinking){
                if(!isThinking)aiResponse.textContent+=text;
            },
            onToolCall(name){
                aiToolCalls.textContent=`Model proposed ${name}; the application has not invoked it.`;
            }
        });
        if(typeof result==='string'&&!aiResponse.textContent){
            aiResponse.textContent=result;
        }
        renderToolCalls(result);
        aiStatus.textContent='Local-only request complete.';
    }catch(error){
        renderPublicError(aiStatus,error);
    }finally{
        finishRoleOperation('llm',controller);
    }
}

async function unloadModel(){
    const controller=beginRoleOperation('llm','unload');
    if(!controller)return;
    aiStatus.textContent='Ending the browser model session without deleting any verified cache.';
    try{
        const local=await localAI();
        await local.unload();
        aiStatus.textContent='Model unloaded. The browser model Worker is no longer active; any verified DBOPFS cache remains.';
    }catch(error){
        renderPublicError(aiStatus,error);
    }finally{
        finishRoleOperation('llm',controller);
    }
}

function configuredSpeechAuthority(role){
    if(speechAuthorityCache[role]!==undefined)return speechAuthorityCache[role];
    const authority=speechAuthorities[role];
    if(!authority||typeof authority!=='object'||Array.isArray(authority)){
        speechAuthorityCache[role]=null;
        return null;
    }
    try{
        createBrowserSpeechAuthority({
            providerId:SPEECH_PROVIDER_IDS[role],
            role,
            model:authority.model,
            runtime:authority.runtime,
            security:{
                secure:true,
                checks:{byteLength:true,sha256:true}
            }
        });
        speechAuthorityCache[role]=authority;
    }catch{
        speechAuthorityCache[role]=null;
    }
    return speechAuthorityCache[role];
}

function requiredSpeechAuthority(role){
    const authority=configuredSpeechAuthority(role);
    if(!authority)throw createPublicError('HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED');
    return authority;
}

async function createSpeechProvider(role,offline,signal){
    const authority=requiredSpeechAuthority(role);
    const store=await speechArtifactStore();
    throwIfAborted(signal);
    const options={
        id:SPEECH_PROVIDER_IDS[role],
        localOnly:true,
        model:authority.model,
        runtime:authority.runtime,
        appSecurity:{secure:true},
        store,
        offline
    };
    return role==='stt'
        ?createBrowserWhisperProvider(options)
        :createBrowserKokoroProvider(options);
}

async function speechProvider(role,offline,signal){
    const current=speechProviders[role];
    if(current&&speechProviderOffline[role]===offline)return current;
    if(current){
        await current.dispose();
        if(speechProviders[role]===current){
            speechProviders[role]=null;
            speechProviderOffline[role]=null;
        }
    }
    throwIfAborted(signal);
    const created=await createSpeechProvider(role,offline,signal);
    if(signal?.aborted){
        await created.dispose();
        throw createPublicError('ARCANE_AI_REQUEST_ABORTED');
    }
    speechProviders[role]=created;
    speechProviderOffline[role]=offline;
    updateSpeechControls(role);
    return created;
}

function speechSelection(provider){
    const catalog=provider.catalog();
    return Object.freeze({
        providerId:provider.id,
        modelId:catalog[0].id,
        localOnly:true
    });
}

function speechPhaseLabel(phase){
    return {
        download:'Downloading declared artifacts',
        'verify-download':'Verifying downloaded artifact authority',
        'verify-cache':'Revalidating the admitted DBOPFS cache',
        'runtime-import':'Importing the isolated runtime',
        'model-load':'Loading the speech model in its Worker',
        ready:'Speech Worker ready'
    }[phase]??'Preparing browser-local speech';
}

function renderSpeechProgress(role,value){
    const controls=speechControls[role];
    if(!controls.progress||!value||typeof value!=='object')return;
    const total=Math.max(0,Number(value.total)||0);
    const completed=Math.min(total,Math.max(0,Number(value.completed)||0));
    controls.progress.hidden=false;
    if(value.heartbeat||total===0){
        controls.progress.removeAttribute('value');
    }else{
        controls.progress.max=total;
        controls.progress.value=completed;
    }
    const unit=typeof value.unit==='string'?` ${value.unit}`:'';
    const amount=total>0?` ${completed} of ${total}${unit}`:'';
    controls.progressLabel.textContent=`${speechPhaseLabel(value.phase)}.${amount}`;
}

async function loadSpeechRole(role,offline){
    const controller=beginRoleOperation(role,offline?'offline-load':'load');
    if(!controller)return;
    const controls=speechControls[role];
    controls.status.textContent=offline
        ?'Checking this exact role authority in DBOPFS with network access disabled.'
        :'Checking the admitted cache. Missing declared artifacts download only after this explicit action.';
    controls.progress.hidden=true;
    controls.progressLabel.textContent='';
    try{
        const provider=await speechProvider(role,offline,controller.signal);
        const selection=speechSelection(provider);
        function handleSpeechLoadProgress(progress){
            renderSpeechProgress(role,progress);
        }
        const result=await provider.load({
            role,
            selection,
            signal:controller.signal,
            progress:handleSpeechLoadProgress
        });
        const cacheState=typeof result.cache==='string'
            ?result.cache
            :result.cache?.state??provider.status().cache;
        controls.progress.hidden=true;
        controls.status.textContent=offline
            ?'Admitted DBOPFS artifacts loaded with network access disabled.'
            :cacheState==='installed'
                ?'Declared artifacts downloaded, verified, admitted to DBOPFS, and loaded in this role Worker.'
                :'Admitted DBOPFS artifacts reused and loaded in this role Worker.';
        controls.progressLabel.textContent='Browser-local speech role ready.';
    }catch(error){
        controls.progress.hidden=true;
        controls.progressLabel.textContent='';
        renderPublicError(controls.status,error);
    }finally{
        finishRoleOperation(role,controller);
    }
}

async function unloadSpeechRole(role){
    const controller=beginRoleOperation(role,'unload');
    if(!controller)return;
    const controls=speechControls[role];
    const provider=speechProviders[role];
    controls.status.textContent='Ending only this speech role session without deleting any admitted DBOPFS cache.';
    try{
        if(provider)await provider.unload();
        if(role==='tts')revokeTtsAudioUrl();
        controls.status.textContent='Role unloaded. Its Worker is no longer active and any admitted DBOPFS cache remains.';
    }catch(error){
        renderPublicError(controls.status,error);
    }finally{
        finishRoleOperation(role,controller);
    }
}

function revokeTtsAudioUrl(){
    if(!ttsAudioUrl)return;
    try{
        globalThis.URL?.revokeObjectURL?.(ttsAudioUrl);
    }catch{
        // The page still clears its reference if the host already revoked it.
    }
    ttsAudioUrl=null;
    const audio=speechControls.tts.audio;
    audio?.pause?.();
    audio?.removeAttribute?.('src');
    audio?.load?.();
    if(audio)audio.hidden=true;
}

function installTtsAudio(result){
    if(!(result?.audio instanceof Uint8Array)||result.contentType!=='audio/wav'){
        throw createPublicError('ARCANE_AI_INVALID_PROVIDER_RESULT');
    }
    if(typeof Blob!=='function'||typeof globalThis.URL?.createObjectURL!=='function'){
        throw createPublicError('HELLO_WORLD_AUDIO_PLAYBACK_UNAVAILABLE');
    }
    revokeTtsAudioUrl();
    const blob=new Blob([result.audio],{type:'audio/wav'});
    ttsAudioUrl=globalThis.URL.createObjectURL(blob);
    speechControls.tts.audio.src=ttsAudioUrl;
    speechControls.tts.audio.hidden=false;
}

async function synthesizeSpeech(){
    const controller=beginRoleOperation('tts','request');
    if(!controller)return;
    const controls=speechControls.tts;
    controls.status.textContent='Synthesizing WAV audio in the TTS Worker. Playback remains under your control.';
    try{
        const text=controls.input.value.trim();
        if(!text)throw createPublicError('HELLO_WORLD_TTS_TEXT_REQUIRED');
        if(text.length>MAX_TTS_TEXT_LENGTH){
            throw createPublicError('HELLO_WORLD_TTS_TEXT_TOO_LONG');
        }
        const provider=speechProviders.tts;
        if(!provider)throw createPublicError('ARCANE_AI_NOT_READY');
        const selection=speechSelection(provider);
        const result=await provider.request({
            role:'tts',
            operation:'synthesize',
            selection,
            signal:controller.signal,
            payload:{
                model:selection.modelId,
                input:text,
                responseFormat:'wav',
                speed:1
            }
        });
        installTtsAudio(result);
        controls.status.textContent='WAV synthesis complete. Press play when you choose; the application never autoplays it.';
    }catch(error){
        renderPublicError(controls.status,error);
    }finally{
        finishRoleOperation('tts',controller);
    }
}

async function transcribeSpeech(){
    const controller=beginRoleOperation('stt','request');
    if(!controller)return;
    const controls=speechControls.stt;
    controls.status.textContent='Decoding the selected file, then transcribing it in the STT Worker.';
    controls.transcript.textContent='';
    try{
        const file=controls.file.files?.[0];
        if(!file||file.size<1)throw createPublicError('HELLO_WORLD_STT_FILE_REQUIRED');
        if(file.size>MAX_STT_FILE_BYTES){
            throw createPublicError('HELLO_WORLD_STT_FILE_TOO_LARGE');
        }
        const mimeType=typeof file.type==='string'?file.type.trim():'';
        const mimeEssence=mimeType.split(';',1)[0].trim().toLowerCase();
        if(!/^audio\/[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(mimeEssence)){
            throw createPublicError('HELLO_WORLD_STT_MIME_TYPE_REQUIRED');
        }
        const provider=speechProviders.stt;
        if(!provider)throw createPublicError('ARCANE_AI_NOT_READY');
        const selection=speechSelection(provider);
        const result=await provider.request({
            role:'stt',
            operation:'transcribe',
            selection,
            signal:controller.signal,
            payload:{
                audio:file,
                mimeType,
                model:selection.modelId
            }
        });
        if(typeof result?.text!=='string'){
            throw createPublicError('ARCANE_AI_INVALID_PROVIDER_RESULT');
        }
        controls.transcript.textContent=result.text;
        controls.status.textContent='File transcription complete. No microphone was opened or requested.';
    }catch(error){
        renderPublicError(controls.status,error);
    }finally{
        finishRoleOperation('stt',controller);
    }
}

function loadOnlineModel(){
    return loadModel();
}

function loadOfflineModel(){
    return loadModel({offline:true});
}

function cancelLlmOperation(){
    cancelRoleOperation('llm');
}

function loadTtsOnline(){
    return loadSpeechRole('tts',false);
}

function loadTtsOffline(){
    return loadSpeechRole('tts',true);
}

function cancelTtsOperation(){
    cancelRoleOperation('tts');
}

function unloadTts(){
    return unloadSpeechRole('tts');
}

function loadSttOnline(){
    return loadSpeechRole('stt',false);
}

function loadSttOffline(){
    return loadSpeechRole('stt',true);
}

function cancelSttOperation(){
    cancelRoleOperation('stt');
}

function unloadStt(){
    return unloadSpeechRole('stt');
}

function disposeResolvedAi(value){
    return value.dispose();
}

function ignoreDisposeFailure(){
    // Page teardown is best effort after every active operation is aborted.
}

function disposeApplication(){
    if(pageDisposePromise)return;
    pageController.abort('The page is closing.');
    revokeTtsAudioUrl();
    const disposals=[];
    const currentAi=ai??aiPromise;
    if(currentAi){
        disposals.push(Promise.resolve(currentAi).then(disposeResolvedAi,ignoreDisposeFailure));
    }
    for(const role of ['stt','tts']){
        const provider=speechProviders[role];
        if(provider)disposals.push(provider.dispose().catch(ignoreDisposeFailure));
    }
    pageDisposePromise=Promise.allSettled(disposals);
}

function reloadAfterBackForwardCache(event){
    if(event?.persisted===true)globalThis.location?.reload?.();
}

action?.addEventListener('click',sayHello);
aiLoad?.addEventListener('click',loadOnlineModel);
aiLoadOffline?.addEventListener('click',loadOfflineModel);
aiSend?.addEventListener('click',askLocalAI);
aiCancel?.addEventListener('click',cancelLlmOperation);
aiUnload?.addEventListener('click',unloadModel);
speechControls.tts.load?.addEventListener('click',loadTtsOnline);
speechControls.tts.loadOffline?.addEventListener('click',loadTtsOffline);
speechControls.tts.cancel?.addEventListener('click',cancelTtsOperation);
speechControls.tts.unload?.addEventListener('click',unloadTts);
speechControls.tts.request?.addEventListener('click',synthesizeSpeech);
speechControls.stt.load?.addEventListener('click',loadSttOnline);
speechControls.stt.loadOffline?.addEventListener('click',loadSttOffline);
speechControls.stt.cancel?.addEventListener('click',cancelSttOperation);
speechControls.stt.unload?.addEventListener('click',unloadStt);
speechControls.stt.request?.addEventListener('click',transcribeSpeech);
globalThis.addEventListener('pagehide',disposeApplication,{once:true});
globalThis.addEventListener('pageshow',reloadAfterBackForwardCache);
renderSpeechAuthorityStatus();
updateLlmControls();
updateSpeechControls('tts');
updateSpeechControls('stt');
