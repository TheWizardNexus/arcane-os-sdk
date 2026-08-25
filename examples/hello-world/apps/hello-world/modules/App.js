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

const MODEL=Object.freeze({
    id:'ibm-granite-4.1-3b-q4-k-s',
    name:'granite-4.1-3b-Q4_K_S.gguf',
    immutableUrl:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf',
    bytes:1_998_371_424,
    sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a',
    licenseSpdx:'Apache-2.0',
    sourceRevision:'ab4701481089b58a082ef63cc1cee738887293ff'
});

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
    ARCANE_AI_REQUEST_ABORTED:'The operation was cancelled. Any verified cache remains; an interrupted model download is discarded.',
    ARCANE_AI_MODEL_OFFLINE_MISS:'No verified offline model cache is available. Load once while online first.',
    ARCANE_AI_MODEL_DOWNLOAD_FAILED:'The model download failed. Check the network and try again.',
    ARCANE_AI_MODEL_REDIRECT_BLOCKED:'The model response left HTTPS and was rejected.',
    ARCANE_AI_MODEL_SIZE_MISMATCH:'The downloaded model size did not match its declared authority.',
    ARCANE_AI_MODEL_DIGEST_MISMATCH:'The downloaded bytes failed SHA-256 verification and were removed.',
    ARCANE_AI_MODEL_CACHE_REJECTED:'The completed model cache failed revalidation and was not admitted.',
    ARCANE_AI_STORAGE_UNAVAILABLE:'App-scoped browser storage is unavailable.',
    ARCANE_AI_NOT_READY:'Load the verified model before asking the local AI.',
    ARCANE_AI_LOCAL_ONLY_UNAVAILABLE:'The selected provider cannot guarantee browser-local inference.',
    ARCANE_AI_DISPOSED:'This local AI session is closed. Reload the page to create another.',
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

globalThis.dbopfs?.readyPromise?.catch(()=>undefined);
await arcaneThemeReady;

const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey('hello-count',{applicationId:appId});
let ai=null;
let aiPromise=null;
let activeController=null;
let activeOperation=null;
let disposePromise=null;
let requestNumber=0;

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

function lifecycleState(){
    return ai?.status?.().llm?.state??'unloaded';
}

function updateControls(){
    const state=lifecycleState();
    const busy=activeController!==null;
    aiLifecycle.textContent=`Lifecycle: ${state}.`;
    aiLoad.disabled=busy||state==='ready';
    aiLoadOffline.disabled=busy||state==='ready';
    aiSend.disabled=busy||state!=='ready';
    aiUnload.disabled=busy||ai===null||state==='unloaded';
    aiCancel.disabled=!busy||activeOperation==='unload';
    aiCancel.hidden=!busy||activeOperation==='unload';
}

function renderProgress(value){
    if(!value||typeof value!=='object')return;
    const total=Number(value.total)||MODEL.bytes;
    const loaded=Math.min(total,Math.max(0,Number(value.loaded)||0));
    const phase={
        download:'Downloading authenticated model bytes',
        'verify-cache':'Rehashing the DBOPFS cache',
        initialize:'Starting the browser-local runtime'
    }[value.phase]??'Preparing local AI';
    aiProgress.max=total;
    aiProgress.value=loaded;
    aiProgress.hidden=false;
    const percent=Number.isFinite(value.percent)?`${value.percent.toFixed(1)}%`:'in progress';
    aiProgressLabel.textContent=`${phase}: ${percent}.`;
}

function renderError(error){
    const suppliedCode=typeof error?.code==='string'?error.code:'';
    const code=suppliedCode.startsWith('ARCANE_AI_')||suppliedCode.startsWith('APP_DATA_')
        ?suppliedCode
        :'ARCANE_AI_REQUEST_FAILED';
    const message=ERROR_COPY[code]??'The browser-local AI operation failed safely.';
    aiStatus.textContent=`${code}: ${message}`;
}

function beginOperation(name){
    if(activeController)return null;
    activeController=new AbortController();
    activeOperation=name;
    updateControls();
    return activeController;
}

function finishOperation(controller){
    if(activeController!==controller)return;
    activeController=null;
    activeOperation=null;
    updateControls();
}

async function localAI(){
    if(ai)return ai;
    if(aiPromise)return aiPromise;
    aiPromise=(async()=>{
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
            const error=new Error('The DBOPFS application scope does not match this app.');
            error.code='APP_DATA_SCOPE_MISMATCH';
            throw error;
        }
        const store=createDbopfsModelStore({dbopfs});
        const source=createBrowserModelSource(MODEL);
        const provider=createBrowserWasmLlmProvider({
            source,
            store,
            loadDefaults:{
                contextTokens:1024,
                threads:1,
                batchTokens:256,
                microBatchTokens:64,
                gpuLayers:0
            }
        });
        const created=createArcaneAI({provider,loadPolicy:'manual'});
        created.llm.addEventListener('progress',event=>{
            renderProgress(event.detail?.progress);
        });
        created.llm.addEventListener('statechange',updateControls);
        ai=created;
        updateControls();
        return created;
    })().catch(error=>{
        aiPromise=null;
        throw error;
    });
    return aiPromise;
}

async function loadModel({offline=false}={}){
    const controller=beginOperation(offline?'offline-load':'load');
    if(!controller)return;
    aiStatus.textContent=offline
        ?'Checking the verified DBOPFS cache without a model-source request. Packaged same-origin Wllama/WASM assets may still load.'
        :'Checking the verified cache. A 1.86 GiB model download starts only if it is missing.';
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
        renderError(error);
    }finally{
        finishOperation(controller);
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
    aiToolCalls.textContent=[
        'Proposed tool calls (structural output only):',
        ...records.flatMap(([name,argumentsJson])=>[
            `name: ${name}`,
            `arguments: ${String(argumentsJson)}`
        ])
    ].join('\n');
}

async function askLocalAI(){
    const controller=beginOperation('request');
    if(!controller)return;
    aiResponse.textContent='';
    aiToolCalls.textContent='Waiting for a response. Proposed tool calls remain structural output only.';
    aiStatus.textContent='Running this request locally in the browser.';
    try{
        const local=await localAI();
        const result=await local.streamRequest({
            id:`hello-world-${++requestNumber}`,
            localOnly:true,
            signal:controller.signal,
            messages:[{
                role:'user',
                content:aiPrompt.value.trim()||'Say hello in one short sentence.'
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
        renderError(error);
    }finally{
        finishOperation(controller);
    }
}

async function unloadModel(){
    const controller=beginOperation('unload');
    if(!controller)return;
    aiStatus.textContent='Unloading the model and releasing its worker memory.';
    try{
        const local=await localAI();
        await local.unload();
        aiStatus.textContent='Model unloaded. Worker memory was released; the verified DBOPFS cache remains.';
    }catch(error){
        renderError(error);
    }finally{
        finishOperation(controller);
    }
}

function cancelOperation(){
    activeController?.abort('Cancelled by the application user.');
}

function disposeLocalAI(){
    activeController?.abort('The page is closing.');
    if(disposePromise)return;
    const current=ai??aiPromise;
    if(!current)return;
    disposePromise=Promise.resolve(current)
        .then(value=>value.dispose())
        .catch(()=>undefined);
}

action?.addEventListener('click',sayHello);
aiLoad?.addEventListener('click',()=>loadModel());
aiLoadOffline?.addEventListener('click',()=>loadModel({offline:true}));
aiSend?.addEventListener('click',askLocalAI);
aiCancel?.addEventListener('click',cancelOperation);
aiUnload?.addEventListener('click',unloadModel);
globalThis.addEventListener('pagehide',disposeLocalAI,{once:true});
updateControls();
