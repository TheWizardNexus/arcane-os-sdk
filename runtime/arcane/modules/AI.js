import './DBOPFS.js';
import UserEntity from '../entities/User.js';
import {
    arcaneEvents,
    createArcaneEventSource,
    projectArcaneDOMEvent
} from 'arcane-os/event-manager';
import {getAIPreferencesForRuntime} from './AIPreferenceRuntime.js';
import {
    AI_MODEL_AUTHORITY_PROTOCOL,
    AI_PROVIDER_PROTOCOL,
    getAIProviderRuntime
} from './AIProviderRuntime.js';
import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

let credentials='include';
const LEGACY_TTS_RESPONSE_FORMAT='opus';
credentials='omit';

const LEGACY_AI_SERVICES=new Set(['OPENAI','OLLAMA','LOCAL_SPEACH']);
export const AI_READY_EVENT='ai-ready';
export const AI_INITIALIZATION_ERROR_CODES=Object.freeze({
    userReadyRegistrationCollision:
        'ARCANE_AI_USER_READY_REGISTRATION_COLLISION'
});
export const AI_INITIALIZATION_REASONS=Object.freeze({
    initialized:'ai-initialized',
    userReadyRegistrationCollision:'ai-user-ready-registration-collision'
});
export const AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL=
    'arcane-ai-browser-speech-configuration/1';
export const AI_BROWSER_SPEECH_EVENT_TYPES=Object.freeze({
    configurationCancelled:'ai-browser-speech-configuration-cancelled',
    configurationError:'ai-browser-speech-configuration-error',
    configurationStarted:'ai-browser-speech-configuration-started',
    configured:'ai-browser-speech-configured',
    disposed:'ai-browser-speech-disposed'
});
export const AI_BROWSER_SPEECH_ERROR_CODES=Object.freeze({
    artifactStoreConstructionRejected:
        'ARCANE_AI_BROWSER_SPEECH_ARTIFACT_STORE_CONSTRUCTION_REJECTED',
    asyncTransitionRequired:
        'ARCANE_AI_BROWSER_SPEECH_ASYNC_TRANSITION_REQUIRED',
    configurationCancelled:'ARCANE_AI_BROWSER_SPEECH_CONFIGURATION_CANCELLED',
    configurationContractMismatch:
        'ARCANE_AI_BROWSER_SPEECH_CONFIGURATION_CONTRACT_MISMATCH',
    configurationSuperseded:
        'ARCANE_AI_BROWSER_SPEECH_CONFIGURATION_SUPERSEDED',
    operationOptionsContractMismatch:
        'ARCANE_AI_BROWSER_SPEECH_OPERATION_OPTIONS_CONTRACT_MISMATCH',
    operationSequenceExhausted:
        'ARCANE_AI_BROWSER_SPEECH_OPERATION_SEQUENCE_EXHAUSTED',
    moduleImportRejected:'ARCANE_AI_BROWSER_SPEECH_MODULE_IMPORT_REJECTED',
    providerConstructionRejected:
        'ARCANE_AI_BROWSER_SPEECH_PROVIDER_CONSTRUCTION_REJECTED',
    providerDisposalRejected:
        'ARCANE_AI_BROWSER_SPEECH_PROVIDER_DISPOSAL_REJECTED',
    providerRouteOwnershipMismatch:
        'ARCANE_AI_BROWSER_SPEECH_PROVIDER_ROUTE_OWNERSHIP_MISMATCH',
    providerUnregistrationRejected:
        'ARCANE_AI_BROWSER_SPEECH_PROVIDER_UNREGISTRATION_REJECTED',
    routeCommitRejected:'ARCANE_AI_BROWSER_SPEECH_ROUTE_COMMIT_REJECTED',
    routeRollbackRejected:'ARCANE_AI_BROWSER_SPEECH_ROUTE_ROLLBACK_REJECTED',
    routeViewUpdateRejected:
        'ARCANE_AI_BROWSER_SPEECH_ROUTE_VIEW_UPDATE_REJECTED'
});
export const AI_BROWSER_SPEECH_REASONS=Object.freeze({
    artifactStoreConstructionRejected:'speech-artifact-store-construction-rejected',
    asyncTransitionRequired:'speech-configuration-async-transition-required',
    configurationAdded:'speech-configuration-added',
    configurationCancelled:'speech-configuration-cancelled',
    configurationContractMismatch:'speech-configuration-contract-mismatch',
    configurationDisposed:'speech-configuration-disposed',
    configurationReplaced:'speech-configuration-replaced',
    moduleImportRejected:'speech-module-import-rejected',
    operationOptionsContractMismatch:'speech-operation-options-contract-mismatch',
    operationSequenceExhausted:'speech-operation-sequence-exhausted',
    providerConstructionRejected:'speech-provider-construction-rejected',
    providerDisposalRejected:'speech-provider-disposal-rejected',
    providerRouteOwnershipMismatch:'speech-provider-route-ownership-mismatch',
    providerUnregistrationRejected:'speech-provider-unregistration-rejected',
    routeCommitRejected:'speech-route-commit-rejected',
    routeRollbackRejected:'speech-route-rollback-rejected',
    routeViewUpdateRejected:'speech-route-view-update-rejected'
});
const AI_PUBLISH_READY=Symbol('publish-ai-ready');
const AI_USER_READY_REGISTRATION_KEY=Symbol.for(
    'arcane.ai.user-ready-registration'
);
const AI_USER_READY_REGISTRATION_PROTOCOL=
    'arcane-ai-user-ready-registration/1';

function aiInitializationError(code,reason,message){
    const error=new Error(message);
    error.code=code;
    error.reason=reason;
    return error;
}

function isAIRequestAbort(error,signal){
    return signal?.aborted
        ||error?.name==='AbortError'
        ||error?.code==='ARCANE_REQUEST_ABORTED'
        ||error?.code==='ARCANE_AI_REQUEST_ABORTED'
        ||error?.code==='AI_REQUEST_ABORTED';
}

function normalizeAIRequestAbort(error){
    if(error?.code==='ARCANE_AI_REQUEST_ABORTED'){
        return error;
    }
    const normalized=new Error('The AI request was cancelled.',{cause:error});
    normalized.name='AbortError';
    normalized.code='ARCANE_AI_REQUEST_ABORTED';
    return normalized;
}

function legacyAIProviderError(message,code,cause){
    const error=cause===undefined
        ?new Error(message)
        :new Error(message,{cause});
    error.code=code;
    return error;
}

function createLegacyAIStreamBridge(execute,sourceSignal){
    const controller=new AbortController();
    const queue=[];
    const waiters=[];
    let complete=false;
    let failure=null;
    let detached=false;

    function forwardLegacyAIStreamAbort(){
        if(!controller.signal.aborted){
            controller.abort(sourceSignal?.reason);
        }
    }

    function detachLegacyAIStreamAbort(){
        if(detached){
            return;
        }
        detached=true;
        sourceSignal?.removeEventListener?.(
            'abort',
            forwardLegacyAIStreamAbort
        );
    }

    if(sourceSignal?.aborted){
        forwardLegacyAIStreamAbort();
    }else{
        sourceSignal?.addEventListener?.(
            'abort',
            forwardLegacyAIStreamAbort,
            {once:true}
        );
    }

    function emitLegacyAIStreamChunk(chunk){
        if(complete){
            return false;
        }
        const waiter=waiters.shift();
        if(waiter){
            waiter.resolve({value:chunk,done:false});
        }else{
            queue.push(chunk);
        }
        return true;
    }

    function finishLegacyAIStream(error){
        if(complete){
            return;
        }
        complete=true;
        failure=error||null;
        detachLegacyAIStreamAbort();
        while(waiters.length){
            const waiter=waiters.shift();
            if(failure){
                waiter.reject(failure);
            }else{
                waiter.resolve({value:undefined,done:true});
            }
        }
    }

    const result=Promise.resolve().then(
        function executeLegacyAIStream(){
            if(controller.signal.aborted){
                throw normalizeAIRequestAbort(controller.signal.reason);
            }
            return execute({
                emit:emitLegacyAIStreamChunk,
                signal:controller.signal
            });
        }
    ).then(
        function acceptLegacyAIStreamResult(value){
            finishLegacyAIStream(null);
            return value;
        },
        function rejectLegacyAIStreamResult(error){
            const normalized=isAIRequestAbort(error,controller.signal)
                ?normalizeAIRequestAbort(error)
                :error;
            finishLegacyAIStream(normalized);
            throw normalized;
        }
    );
    result.catch(function retainLegacyAIStreamFailure() {});

    async function cancelLegacyAIStream(reason){
        if(!controller.signal.aborted){
            controller.abort(reason);
        }
        await result.catch(function retainCancelledLegacyAIStream() {});
        return true;
    }

    const handle={
        result,
        cancel:cancelLegacyAIStream,
        next:function readLegacyAIStreamChunk(){
            if(queue.length){
                return Promise.resolve({value:queue.shift(),done:false});
            }
            if(complete){
                return failure
                    ?Promise.reject(failure)
                    :Promise.resolve({value:undefined,done:true});
            }
            return new Promise(function waitForLegacyAIStreamChunk(resolve,reject){
                waiters.push({resolve,reject});
            });
        },
        return:async function returnLegacyAIStream(value){
            await cancelLegacyAIStream(
                legacyAIProviderError(
                    'The legacy AI stream consumer stopped before completion.',
                    'ARCANE_AI_REQUEST_ABORTED'
                )
            );
            return {value,done:true};
        },
        throw:async function throwLegacyAIStream(error){
            await cancelLegacyAIStream(error);
            throw error;
        },
        [Symbol.asyncIterator]:function iterateLegacyAIStream(){
            return this;
        }
    };
    return Object.freeze(handle);
}

function normalizeAIStartupOptions(options){
    if(options===undefined){
        return Object.freeze({
            startMuted:true,
            startTranscription:false,
            signal:null
        });
    }
    if(!options||typeof options!=='object'||Array.isArray(options)){
        throw new TypeError('AI startup options must be a plain object.');
    }
    const prototype=Object.getPrototypeOf(options);
    if(prototype!==Object.prototype&&prototype!==null){
        throw new TypeError('AI startup options must be a plain object.');
    }
    const descriptors=Object.getOwnPropertyDescriptors(options);
    for(const key of Reflect.ownKeys(descriptors)){
        if(typeof key==='symbol'||(
            key!=='startMuted'
            &&key!=='startTranscription'
            &&key!=='signal'
        )){
            throw new TypeError('AI startup options contain an unknown option.');
        }
        if(!Object.hasOwn(descriptors[key],'value')){
            throw new TypeError(`AI startup options.${key} must be a data property.`);
        }
    }
    const startMuted=Object.hasOwn(descriptors,'startMuted')
        ?descriptors.startMuted.value
        :true;
    const startTranscription=Object.hasOwn(descriptors,'startTranscription')
        ?descriptors.startTranscription.value
        :false;
    const signal=Object.hasOwn(descriptors,'signal')
        ?descriptors.signal.value
        :null;
    if(typeof startMuted!=='boolean'){
        throw new TypeError('AI startup startMuted must be a boolean.');
    }
    if(typeof startTranscription!=='boolean'){
        throw new TypeError('AI startup startTranscription must be a boolean.');
    }
    if(signal!==null&&signal!==undefined&&(
        typeof signal!=='object'
        ||typeof signal.aborted!=='boolean'
        ||typeof signal.addEventListener!=='function'
        ||typeof signal.removeEventListener!=='function'
    )){
        throw new TypeError('AI startup signal must be an AbortSignal.');
    }
    return Object.freeze({startMuted,startTranscription,signal});
}

function aiBrowserSpeechError(code,reason,message,cause,{committed=false,name='Error'}={}){
    const error=cause===undefined
        ?new Error(message)
        :new Error(message,{cause});
    error.name=name;
    error.code=code;
    error.reason=reason;
    if(committed)error.committed=true;
    return error;
}

function isAbortSignal(value){
    return Boolean(value)
        &&typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function';
}

function frozenClosedRecord(value,keys,required,label){
    if(!value
        ||typeof value!=='object'
        ||Array.isArray(value)
        ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
        ||!Object.isFrozen(value)){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label} must be a frozen plain data record.`
        );
    }
    const descriptors=Object.getOwnPropertyDescriptors(value);
    for(const key of Reflect.ownKeys(descriptors)){
        if(typeof key!=='string'
            ||!keys.includes(key)
            ||!Object.hasOwn(descriptors[key],'value')){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                `${label} contains an unsupported or accessor field.`
            );
        }
    }
    for(const key of required){
        if(!Object.hasOwn(descriptors,key)){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                `${label}.${key} is required.`
            );
        }
    }
    return descriptors;
}

function browserSpeechIdentifier(value,label){
    if(typeof value!=='string'
        ||value.trim()!==value
        ||value.length<1
        ||value.length>128){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label} must be a trimmed 1-128 character string.`
        );
    }
    return value;
}

function normalizeBrowserSpeechRole(value,role){
    const label=`AI browser speech ${role}`;
    const descriptors=frozenClosedRecord(
        value,
        ['providerId','graph','model','runtime','security','offline'],
        ['providerId','offline'],
        label
    );
    const providerId=browserSpeechIdentifier(
        descriptors.providerId.value,
        `${label}.providerId`
    );
    const hasGraph=Object.hasOwn(descriptors,'graph');
    const hasModel=Object.hasOwn(descriptors,'model');
    const hasRuntime=Object.hasOwn(descriptors,'runtime');
    const hasSecurity=Object.hasOwn(descriptors,'security');
    if(hasGraph&&(hasModel||hasRuntime)){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label}.graph is mutually exclusive with model and runtime.`
        );
    }
    if(!hasGraph&&(!hasModel||!hasRuntime)){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label} must provide graph or both model and runtime.`
        );
    }
    if(hasGraph){
        const graph=descriptors.graph.value;
        if(!graph||typeof graph!=='object'||!Object.isFrozen(graph)){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                `${label}.graph must be an SDK-created frozen artifact graph.`
            );
        }
        if(!hasSecurity){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                `${label}.security with secure:true is required for an artifact graph.`
            );
        }
        const security=frozenClosedRecord(
            descriptors.security.value,
            ['secure','checks'],
            ['secure'],
            `${label}.security`
        );
        if(security.secure.value!==true){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                `${label}.security.secure must be true for an artifact graph.`
            );
        }
    }else{
        for(const key of ['model','runtime']){
            const descriptor=descriptors[key].value;
            if(!descriptor||typeof descriptor!=='object'||Array.isArray(descriptor)){
                throw aiBrowserSpeechError(
                    AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                    AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                    `${label}.${key} must be a browser speech authority descriptor.`
                );
            }
        }
    }
    if(typeof descriptors.offline.value!=='boolean'){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label}.offline must be a boolean.`
        );
    }
    return Object.freeze({
        providerId,
        ...(hasGraph
            ?{
                graph:descriptors.graph.value,
                security:descriptors.security.value
            }
            :{
                model:descriptors.model.value,
                runtime:descriptors.runtime.value,
                ...(hasSecurity?{security:descriptors.security.value}:{})
            }),
        offline:descriptors.offline.value
    });
}

function normalizeBrowserSpeechConfiguration(value){
    const descriptors=frozenClosedRecord(
        value,
        ['protocol','id','dbopfs','tableName','stt','tts'],
        ['protocol','id','dbopfs'],
        'AI browser speech configuration'
    );
    if(descriptors.protocol.value!==AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `AI browser speech configuration.protocol must be ${AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL}.`
        );
    }
    const id=browserSpeechIdentifier(
        descriptors.id.value,
        'AI browser speech configuration.id'
    );
    const dbopfs=descriptors.dbopfs.value;
    if(!dbopfs||typeof dbopfs!=='object'){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            'AI browser speech configuration.dbopfs must be an existing DBOPFS instance.'
        );
    }
    const tableName=descriptors.tableName
        ?browserSpeechIdentifier(
            descriptors.tableName.value,
            'AI browser speech configuration.tableName'
        )
        :undefined;
    const roles=['stt','tts'].filter(role=>Object.hasOwn(descriptors,role));
    if(roles.length===0){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            'AI browser speech configuration must provide stt, tts, or both.'
        );
    }
    return Object.freeze({
        configuration:value,
        id,
        dbopfs,
        ...(tableName?{tableName}:{}),
        roles:Object.freeze(roles),
        ...Object.fromEntries(roles.map(role=>[
            role,
            normalizeBrowserSpeechRole(descriptors[role].value,role)
        ]))
    });
}

function normalizeBrowserSpeechOperationOptions(value,label){
    if(value===undefined)return Object.freeze({signal:null});
    if(!value
        ||typeof value!=='object'
        ||Array.isArray(value)
        ||![Object.prototype,null].includes(Object.getPrototypeOf(value))){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.operationOptionsContractMismatch,
            AI_BROWSER_SPEECH_REASONS.operationOptionsContractMismatch,
            `${label} options must be a plain object.`
        );
    }
    const descriptors=Object.getOwnPropertyDescriptors(value);
    for(const key of Reflect.ownKeys(descriptors)){
        if(key!=='signal'||!Object.hasOwn(descriptors[key],'value')){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.operationOptionsContractMismatch,
                AI_BROWSER_SPEECH_REASONS.operationOptionsContractMismatch,
                `${label} options support only a signal data property.`
            );
        }
    }
    const signal=descriptors.signal?.value??null;
    if(signal!==null&&!isAbortSignal(signal)){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.operationOptionsContractMismatch,
            AI_BROWSER_SPEECH_REASONS.operationOptionsContractMismatch,
            `${label} signal must be an AbortSignal.`
        );
    }
    return Object.freeze({signal});
}

class AI {
    // This is the enum section for inference configuration
    #service = {
        baseURL: {
            OPENAI: 'https://api.openai.com/v1'
        },
        sttURL: {
            LOCAL_SPEACH: 'http://127.0.0.1:8011/v1',
            OPENAI:       'https://api.openai.com/v1'
        },
        ttsURL: {
            LOCAL_SPEACH: 'http://127.0.0.1:8011/v1',
            OPENAI:       'https://api.openai.com/v1'
        },
    }

    #paths = {
        chat: {
            OPENAI: '/chat/completions'
        },
        stt: {
            LOCAL_SPEACH: '/audio/transcriptions',
            OPENAI:       '/audio/transcriptions'
        },
        tts: {
            LOCAL_SPEACH: '/audio/speech',
            OPENAI:       '/audio/speech'
        }
    }

    #models = {
        OPENAI:'gpt-4o'
    }

    #sttModels = {
        OPENAI:       'whisper-1',
        LOCAL_SPEACH: 'whisper-small'
    }

    #ttsModels = {
        OPENAI:       'gpt-4o-mini-tts',
        LOCAL_SPEACH: 'kokoro'
    }

    #speechAbbreviations=new Set([
        'co','dept','dr','e.g','etc','fig','i.e','inc','jr','ltd','mr',
        'mrs','ms','no','prof','sr','st','vs'
    ]);

    // Note: if we expand cloud providers, simply add their expected JSON metadata here
    get #serviceHeaders(){
        return {
            OPENAI: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.license}`
            }
        };
    }

    get #ttsHeaders(){
        return {
            OPENAI: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.license}`
            },
            LOCAL_SPEACH: {
                'Content-Type': 'application/json',
            }
        };
    }

    get #sttHeaders(){
        return {
            OPENAI: {
                'Authorization': `Bearer ${this.license}`,
            },
            LOCAL_SPEACH: {}
        };
    }

    ready=false;
    muted=true;
    

    llmService = '';
    sttService = '';
    ttsService = '';

    model    = '';
    modelTTS = '';
    modelSTT = '';
    reasoningEffort = '';

    audioFormat = 'opus';
    audioType   = 'audio/ogg; codecs=opus';
    voiceSpeed = 1.0;

    //audioFormat = 'wav';
    //audioType = 'audio/wav; codecs=1';

    constructor(
        llmService='',
        sttService='',
        ttsService='',
        model='',
        modelTTS='',
        modelSTT=''
    ) {
        if(window.ai){
            return window.ai;
        }

        this.#events=createArcaneEventSource(
            this,
            {
                source:'ai',
                eventTypes:Object.freeze(
                    [
                        AI_READY_EVENT,
                        ...Object.values(AI_BROWSER_SPEECH_EVENT_TYPES)
                    ]
                )
            }
        );

        const preferences=[
            llmService||'OPENAI',
            sttService||'OPENAI',
            ttsService||'OPENAI',
            model||'OPENAI',
            modelTTS||'OPENAI',
            modelSTT||'OPENAI'
        ];
        this.setAI(
            ...preferences
        );

        const runtime=this;
        this.#stopOllamaReady=arcaneEvents.subscribe(
            'arcane-ollama-ready',
            function reconcileLegacyOllamaReadiness(){
                runtime.#retainLegacyLLMReadiness(
                    runtime.#reconcileLegacyLLMReadiness()
                );
            }
        );
    }

    #providerRuntime=getAIProviderRuntime();
    #events=null;
    #browserSpeechConfigurationRecord=null;
    #browserSpeechController=null;
    #browserSpeechControllerRoles=Object.freeze([]);
    #browserSpeechGeneration=0;
    #browserSpeechModulePromise=null;
    #browserSpeechOperationSequence=0;
    #browserSpeechRetiredRecords=new Set();
    #browserSpeechRetiredLegacyRecords=new Set();
    #browserSpeechTransition=Promise.resolve();
    #legacyLLMProviders=new Map();
    #legacyLLMReadiness=Promise.resolve(null);
    #legacySpeechProviders=new Map();
    #legacySpeechReadiness=Promise.resolve(null);
    #speechControlGeneration=0;
    #stopOllamaReady=null;
    #preferenceTuple=Object.freeze([
        'OPENAI',
        'OPENAI',
        'OPENAI',
        'OPENAI',
        'OPENAI',
        'OPENAI'
    ]);

    get providerRuntime(){
        return this.#providerRuntime;
    }

    [AI_PUBLISH_READY](){
        const operationId=`${this.#events.instanceId}:ready:1`;
        const reason=AI_INITIALIZATION_REASONS.initialized;
        const {occurrence}=this.#events.dispatch(
            AI_READY_EVENT,
            Object.freeze({db:this,operationId,reason}),
            {
                operationId,
                publicDetail:Object.freeze({
                    ready:true,
                    reason
                })
            }
        );
        projectArcaneDOMEvent(window,occurrence);
        return occurrence;
    }

    get browserSpeechConfiguration(){
        return this.#browserSpeechRecordIsActive(
            this.#browserSpeechConfigurationRecord
        )
            ?this.#browserSpeechConfigurationRecord.configuration
            :null;
    }

    get browserSpeechDescriptor(){
        return this.#browserSpeechRecordIsActive(
            this.#browserSpeechConfigurationRecord
        )
            ?this.#browserSpeechConfigurationRecord.descriptor
            :null;
    }

    get url() {
        return `${this.#service.baseURL[this.llmService]}${this.#paths.chat[this.llmService]}`
    }

    set url(value) {
        return false;
    }

    get urlTTS() {
        return `${this.#service.ttsURL[this.ttsService]}${this.#paths.tts[this.ttsService]}`
    }

    set urlTTS(value) {
        return false;
    }

    get urlSTT() {
        return `${this.#service.sttURL[this.sttService]}${this.#paths.stt[this.sttService]}`
    }

    set urlSTT(value) {
        return false;
    }

    #license='';

    // Browser-delivered framework code must not contain provider credentials.
    // The selected host, application, or user profile supplies one at runtime.
    get license(){
        return this.#license || globalThis.arcane?.config?.openAI?.apiKey || '';
    }
    
    set license(value){
        this.#license=typeof value==='string' ? value.trim():'';
        this.#retainLegacyLLMReadiness(
            this.#reconcileLegacyLLMReadiness()
        );
        this.#retainLegacySpeechReadiness(
            this.#reconcileLegacySpeechReadiness()
        );
        return this.#license;
    }

    #legacyLLMCapability(providerId){
        if(providerId==='OPENAI'){
            return this.llmService==='OPENAI'
                &&Boolean(this.model)
                &&Boolean(this.license)
                &&typeof globalThis.fetch==='function';
        }
        if(providerId==='OLLAMA'){
            return this.llmService==='OLLAMA'
                &&Boolean(this.model)
                &&Boolean(this.#nativeOllama());
        }
        return false;
    }

    #legacyLLMInspection(providerId,selection){
        const localOnly=providerId==='OLLAMA';
        if(!selection
            ||selection.providerId!==providerId
            ||selection.modelId!==this.model
            ||selection.localOnly!==localOnly
            ||this.llmService!==providerId){
            return Object.freeze({
                available:false,
                code:'ARCANE_AI_MODEL_AUTHORITY_REQUIRED',
                message:'The selected legacy LLM route does not match the active AI configuration.'
            });
        }
        if(!this.#legacyLLMCapability(providerId)){
            return Object.freeze({
                available:false,
                code:providerId==='OLLAMA'
                    ?'AI_NATIVE_LOCAL_REQUIRED'
                    :'AI_PROVIDER_NOT_CONFIGURED',
                message:providerId==='OLLAMA'
                    ?'Local AI requires the capability-gated Arcane API.'
                    :'AI provider is not configured.'
            });
        }
        return Object.freeze({
            available:true,
            authority:Object.freeze({
                protocol:AI_MODEL_AUTHORITY_PROTOCOL,
                providerId,
                modelId:selection.modelId,
                admitted:true
            })
        });
    }

    #createLegacyLLMProvider(providerId){
        const runtime=this;
        const localOnly=providerId==='OLLAMA';
        let state='unloaded';
        let busy=false;

        function statusLegacyLLMProvider(){
            if(state==='ready'
                &&!busy
                &&!runtime.#legacyLLMCapability(providerId)){
                state='unloaded';
            }
            return Object.freeze({
                state,
                loaded:state==='ready',
                busy
            });
        }

        function assertLegacyLLMSelection(selection){
            const inspection=runtime.#legacyLLMInspection(
                providerId,
                selection
            );
            if(!inspection.available){
                throw legacyAIProviderError(
                    inspection.message,
                    inspection.code
                );
            }
            return inspection;
        }

        function releaseLegacyLLMRequest(){
            busy=false;
        }

        return Object.freeze({
            protocol:AI_PROVIDER_PROTOCOL,
            role:'llm',
            id:providerId,
            localOnly,
            catalog:function catalogLegacyLLMProvider(){
                if(runtime.llmService!==providerId||!runtime.model){
                    return Object.freeze([]);
                }
                return Object.freeze([
                    Object.freeze({id:runtime.model})
                ]);
            },
            inspect:function inspectLegacyLLMProvider(selection,{signal}={}){
                if(signal?.aborted){
                    throw normalizeAIRequestAbort(signal.reason);
                }
                return runtime.#legacyLLMInspection(providerId,selection);
            },
            status:statusLegacyLLMProvider,
            load:function loadLegacyLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(state==='disposed'){
                    throw legacyAIProviderError(
                        'The legacy LLM provider is disposed.',
                        'ARCANE_AI_PROVIDER_DISPOSED'
                    );
                }
                if(busy){
                    throw legacyAIProviderError(
                        'The legacy LLM provider owns an active request.',
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                if(typeof context.progress!=='function'){
                    throw new TypeError(
                        'Legacy LLM provider load progress must be a function.'
                    );
                }
                const inspection=assertLegacyLLMSelection(context.selection);
                state='loading';
                context.progress({
                    phase:'capability',
                    completed:0,
                    total:1,
                    unit:'items',
                    heartbeat:false
                });
                if(context.signal?.aborted){
                    state='unloaded';
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                state='ready';
                context.progress({
                    phase:'capability',
                    completed:1,
                    total:1,
                    unit:'items',
                    heartbeat:false
                });
                return Object.freeze({
                    authority:inspection.authority,
                    status:statusLegacyLLMProvider()
                });
            },
            request:function requestLegacyLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                assertLegacyLLMSelection(context.selection);
                const current=statusLegacyLLMProvider();
                if(current.state!=='ready'||!current.loaded){
                    throw legacyAIProviderError(
                        'The legacy LLM provider is not ready.',
                        'ARCANE_AI_ROLE_NOT_READY'
                    );
                }
                if(busy){
                    throw legacyAIProviderError(
                        'The legacy LLM provider owns an active request.',
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                busy=true;
                if(context.operation==='chat'){
                    return Promise.resolve(
                        runtime.#requestLegacyLLMChat(
                            context.payload,
                            context.signal
                        )
                    ).finally(releaseLegacyLLMRequest);
                }
                if(context.operation==='stream'){
                    const handle=createLegacyAIStreamBridge(
                        function executeLegacyLLMProviderStream(bridge){
                            return runtime.#requestLegacyLLMStream(
                                context.payload,
                                bridge
                            );
                        },
                        context.signal
                    );
                    handle.result.then(
                        releaseLegacyLLMRequest,
                        releaseLegacyLLMRequest
                    );
                    return handle;
                }
                busy=false;
                throw legacyAIProviderError(
                    'The legacy LLM provider operation is unsupported.',
                    'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
                );
            },
            unload:function unloadLegacyLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                state='unloaded';
                busy=false;
                return statusLegacyLLMProvider();
            },
            dispose:function disposeLegacyLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                state='disposed';
                busy=false;
                return statusLegacyLLMProvider();
            }
        });
    }

    #legacySpeechService(role){
        return role==='stt'?this.sttService:this.ttsService;
    }

    #legacySpeechModel(role){
        return role==='stt'?this.modelSTT:this.modelTTS;
    }

    #legacySpeechProviderKey(role,providerId){
        return `${role}:${providerId}`;
    }

    #legacySpeechDefaultVoice(role,providerId){
        if(role!=='tts'){
            return null;
        }
        if(providerId==='OPENAI'){
            const selected=typeof globalThis.window?.user?.AI_voice==='string'
                ?globalThis.window.user.AI_voice.trim()
                :'';
            return selected||'alloy';
        }
        if(providerId==='LOCAL_SPEACH'){
            return 'af_heart';
        }
        return null;
    }

    #legacySpeechCapability(role,providerId){
        const service=this.#legacySpeechService(role);
        const model=this.#legacySpeechModel(role);
        if(service!==providerId||!model){
            return false;
        }
        if(providerId==='OPENAI'){
            return Boolean(this.license)&&typeof globalThis.fetch==='function';
        }
        if(providerId==='LOCAL_SPEACH'){
            return Boolean(this.#nativeSpeech(service,role));
        }
        return false;
    }

    #legacySpeechInspection(role,providerId,selection){
        const localOnly=providerId==='LOCAL_SPEACH';
        if(!selection
            ||selection.providerId!==providerId
            ||selection.modelId!==this.#legacySpeechModel(role)
            ||selection.localOnly!==localOnly
            ||this.#legacySpeechService(role)!==providerId){
            return Object.freeze({
                available:false,
                code:'ARCANE_AI_MODEL_AUTHORITY_REQUIRED',
                message:`The selected legacy ${role.toUpperCase()} route does not match the active AI configuration.`
            });
        }
        if(!this.#legacySpeechCapability(role,providerId)){
            return Object.freeze({
                available:false,
                code:providerId==='LOCAL_SPEACH'
                    ?'AI_NATIVE_LOCAL_REQUIRED'
                    :'AI_PROVIDER_NOT_CONFIGURED',
                message:providerId==='LOCAL_SPEACH'
                    ?`Local ${role.toUpperCase()} requires the capability-gated Arcane API.`
                    :'AI provider is not configured.'
            });
        }
        return Object.freeze({
            available:true,
            authority:Object.freeze({
                protocol:AI_MODEL_AUTHORITY_PROTOCOL,
                providerId,
                modelId:selection.modelId,
                admitted:true
            })
        });
    }

    #createLegacySpeechProvider(role,providerId){
        const runtime=this;
        const localOnly=providerId==='LOCAL_SPEACH';
        const expectedOperation=role==='stt'?'transcribe':'synthesize';
        let state='unloaded';
        let busy=false;

        function statusLegacySpeechProvider(){
            if(state==='ready'
                &&!busy
                &&!runtime.#legacySpeechCapability(role,providerId)){
                state='unloaded';
            }
            return Object.freeze({
                state,
                loaded:state==='ready',
                busy
            });
        }

        function assertLegacySpeechSelection(selection){
            const inspection=runtime.#legacySpeechInspection(
                role,
                providerId,
                selection
            );
            if(!inspection.available){
                throw legacyAIProviderError(
                    inspection.message,
                    inspection.code
                );
            }
            return inspection;
        }

        function releaseLegacySpeechRequest(){
            busy=false;
        }

        return Object.freeze({
            protocol:AI_PROVIDER_PROTOCOL,
            role,
            id:providerId,
            localOnly,
            catalog:function catalogLegacySpeechProvider(){
                const model=runtime.#legacySpeechModel(role);
                if(runtime.#legacySpeechService(role)!==providerId||!model){
                    return Object.freeze([]);
                }
                const defaultVoice=runtime.#legacySpeechDefaultVoice(
                    role,
                    providerId
                );
                return Object.freeze([
                    Object.freeze({
                        id:model,
                        ...(defaultVoice?{defaultVoice}:{})
                    })
                ]);
            },
            inspect:function inspectLegacySpeechProvider(selection,{signal}={}){
                if(signal?.aborted){
                    throw normalizeAIRequestAbort(signal.reason);
                }
                return runtime.#legacySpeechInspection(role,providerId,selection);
            },
            status:statusLegacySpeechProvider,
            load:function loadLegacySpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(state==='disposed'){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider is disposed.`,
                        'ARCANE_AI_PROVIDER_DISPOSED'
                    );
                }
                if(busy){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                if(typeof context.progress!=='function'){
                    throw new TypeError(
                        `Legacy ${role.toUpperCase()} provider load progress must be a function.`
                    );
                }
                const inspection=assertLegacySpeechSelection(context.selection);
                state='loading';
                context.progress({
                    phase:'capability',
                    completed:0,
                    total:1,
                    unit:'items',
                    heartbeat:false
                });
                if(context.signal?.aborted){
                    state='unloaded';
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                state='ready';
                context.progress({
                    phase:'capability',
                    completed:1,
                    total:1,
                    unit:'items',
                    heartbeat:false
                });
                return Object.freeze({
                    authority:inspection.authority,
                    status:statusLegacySpeechProvider()
                });
            },
            request:function requestLegacySpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                assertLegacySpeechSelection(context.selection);
                const current=statusLegacySpeechProvider();
                if(current.state!=='ready'||!current.loaded){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider is not ready.`,
                        'ARCANE_AI_ROLE_NOT_READY'
                    );
                }
                if(busy){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                if(context.operation!==expectedOperation){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider operation is unsupported.`,
                        'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
                    );
                }
                busy=true;
                const request=role==='stt'
                    ?runtime.#requestLegacySpeechTranscription(
                        context.payload,
                        context.signal
                    )
                    :runtime.#requestLegacySpeechSynthesis(
                        context.payload,
                        context.signal
                    );
                return Promise.resolve(request).finally(releaseLegacySpeechRequest);
            },
            unload:function unloadLegacySpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(busy){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider still owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                state='unloaded';
                return statusLegacySpeechProvider();
            },
            dispose:function disposeLegacySpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(busy){
                    throw legacyAIProviderError(
                        `The legacy ${role.toUpperCase()} provider still owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                state='disposed';
                return statusLegacySpeechProvider();
            }
        });
    }

    #ensureLegacyLLMProvider(providerId){
        if(providerId!=='OPENAI'&&providerId!=='OLLAMA'){
            return false;
        }
        if(this.#providerRuntime.hasProvider('llm',providerId)){
            return false;
        }
        const provider=this.#createLegacyLLMProvider(providerId);
        const unregister=this.#providerRuntime.register(provider);
        this.#legacyLLMProviders.set(
            providerId,
            Object.freeze({provider,unregister})
        );
        return true;
    }

    #ensureLegacySpeechProvider(role,providerId){
        if(!['stt','tts'].includes(role)
            ||!['OPENAI','LOCAL_SPEACH'].includes(providerId)){
            return false;
        }
        if(this.#providerRuntime.hasProvider(role,providerId)){
            return false;
        }
        const provider=this.#createLegacySpeechProvider(role,providerId);
        const unregister=this.#providerRuntime.register(provider);
        this.#legacySpeechProviders.set(
            this.#legacySpeechProviderKey(role,providerId),
            Object.freeze({role,providerId,provider,unregister})
        );
        return true;
    }

    #releaseInactiveLegacyLLMProviders(activeProviderId){
        for(const [providerId,record] of this.#legacyLLMProviders){
            if(providerId===activeProviderId){
                continue;
            }
            if(record.unregister()){
                this.#legacyLLMProviders.delete(providerId);
            }
        }
    }

    #releaseInactiveLegacySpeechProviders(activeProviders){
        for(const [key,record] of this.#legacySpeechProviders){
            if(activeProviders[record.role]===record.providerId){
                continue;
            }
            if(record.unregister()){
                this.#legacySpeechProviders.delete(key);
            }
        }
    }

    #internalLegacyLLMSelection(localOnly=false){
        const selection=this.#providerRuntime.selection(
            'llm',
            {localOnly}
        );
        if(!selection
            ||!this.#legacyLLMProviders.has(selection.providerId)
            ||selection.providerId!==this.llmService
            ||selection.modelId!==this.model){
            return null;
        }
        return selection;
    }

    #internalLegacySpeechSelection(role,localOnly=false){
        const selection=this.#providerRuntime.selection(role,{localOnly});
        if(!selection
            ||!this.#legacySpeechProviders.has(
                this.#legacySpeechProviderKey(role,selection.providerId)
            )
            ||selection.providerId!==this.#legacySpeechService(role)
            ||selection.modelId!==this.#legacySpeechModel(role)){
            return null;
        }
        return selection;
    }

    #retainLegacyLLMReadiness(operation){
        this.#legacyLLMReadiness=Promise.resolve(operation).catch(
            function retainLegacyLLMReadinessFailure(){
                return null;
            }
        );
        return this.#legacyLLMReadiness;
    }

    #retainLegacySpeechReadiness(operation){
        this.#legacySpeechReadiness=Promise.resolve(operation).catch(
            function retainLegacySpeechReadinessFailure(){
                return null;
            }
        );
        return this.#legacySpeechReadiness;
    }

    #reconcileLegacyLLMReadiness(){
        const selection=this.#internalLegacyLLMSelection(false);
        if(!selection){
            return Promise.resolve(this.#providerRuntime.status('llm'));
        }
        const status=this.#providerRuntime.status('llm');
        if(this.#legacyLLMCapability(selection.providerId)){
            if(status.state==='ready'&&status.loaded===true){
                return Promise.resolve(status);
            }
            return this.#providerRuntime.load('llm');
        }
        if(status.loaded===true
            ||status.busy===true
            ||status.state==='loading'
            ||status.state==='unloading'){
            return this.#providerRuntime.unload('llm');
        }
        return Promise.resolve(status);
    }

    #reconcileLegacySpeechReadiness(){
        const runtime=this;
        return Promise.all(['stt','tts'].map(function reconcileLegacySpeechRole(role){
            const selection=runtime.#internalLegacySpeechSelection(role,false);
            if(!selection){
                return runtime.#providerRuntime.status(role);
            }
            const status=runtime.#providerRuntime.status(role);
            if(runtime.#legacySpeechCapability(role,selection.providerId)){
                return status;
            }
            if(status.loaded===true
                ||status.busy===true
                ||status.state==='loading'
                ||status.state==='unloading'){
                return runtime.#providerRuntime.unload(role);
            }
            return status;
        }));
    }

    get configured(){
        if(this.#usesProviderRuntime('llm',this.llmService)){
            if(this.#internalLegacyLLMSelection(false)
                &&!this.#legacyLLMCapability(this.llmService)){
                return false;
            }
            const state=this.#providerRuntime.status('llm');
            return state.state==='ready'&&state.loaded===true;
        }
        if(this.llmService==='OLLAMA'){
            return Boolean(this.model)&&Boolean(this.#nativeOllama());
        }

        return this.llmService==='OPENAI'
            &&Boolean(this.model)
            &&Boolean(this.license);
    }

    #assertServiceConfigured(service=this.llmService,role='llm'){
        if(this.#usesProviderRuntime(role,service)){
            const internal=role==='llm'
                ?this.#internalLegacyLLMSelection(false)
                :this.#internalLegacySpeechSelection(role,false);
            const internalAvailable=!internal
                ||(role==='llm'
                    ?this.#legacyLLMCapability(internal.providerId)
                    :this.#legacySpeechCapability(role,internal.providerId));
            if(!internalAvailable){
                const inspection=role==='llm'
                    ?this.#legacyLLMInspection(internal.providerId,internal)
                    :this.#legacySpeechInspection(
                        role,
                        internal.providerId,
                        internal
                    );
                throw legacyAIProviderError(
                    inspection.message,
                    inspection.code
                );
            }
            return true;
        }
        if(service==='OLLAMA'){
            if(role==='llm'&&this.#nativeOllama()){
                return true;
            }

            const error=new Error(
                'Local AI requires the capability-gated Arcane API.'
            );
            error.code='AI_NATIVE_LOCAL_REQUIRED';
            throw error;
        }
        if(service==='LOCAL_SPEACH'){
            if(this.#nativeSpeech(service,role)){
                return true;
            }

            const error=new Error(
                `Local ${role.toUpperCase()} requires the capability-gated Arcane API.`
            );
            error.code='AI_NATIVE_LOCAL_REQUIRED';
            throw error;
        }

        if(service==='OPENAI'&&this.license){
            return true;
        }

        const error=new Error('AI provider is not configured.');
        error.code='AI_PROVIDER_NOT_CONFIGURED';
        throw error;
    }

    #usesProviderRuntime(role,service){
        return Boolean(this.#providerRuntime.selection(role));
    }

    #shouldUseProviderRuntime(role,service,localOnly=false){
        // Legacy adapters publish lifecycle without replacing established
        // public transport callbacks or their cancellation behavior.
        if(role==='llm'&&this.#internalLegacyLLMSelection(localOnly)){
            return false;
        }
        if(!localOnly){
            return this.#usesProviderRuntime(role,service);
        }
        const selection=this.#providerRuntime.selection(
            role,
            {localOnly:true}
        );
        return Boolean(selection);
    }

    #hasLocalRoute(role,service){
        const selection=this.#providerRuntime.selection(
            role,
            {localOnly:true}
        );
        if(selection){
            return selection.localOnly===true;
        }
        if(this.#providerRuntime.selection(role)){
            return false;
        }
        return role==='llm'&&service==='OLLAMA';
    }

    audioMessageChunks='';
    sourceNodes=[];
    isSpeaking=false;
    audioContext=null;
    currentSpeechJob=null;
    speechGeneration=0;
    speechJobs=[];
    speechAwaitingGesture=false;
    speechPlaybackStarting=false;
    speechResumeAttempt=0;
    speechResumePending=false;
    speechSynthesisTail=Promise.resolve();
    speechUnlockHandler=null;

    #nextPreferenceTuple(values){
        const current=this.#preferenceTuple;
        const next=values.map(function normalizeAIPreference(value,index){
            if(value===undefined||value===null||value===''){
                return current[index];
            }
            if(typeof value!=='string'||value.trim()!==value||!value){
                throw new TypeError('AI preferences must be nonempty trimmed strings.');
            }
            return value;
        });
        return Object.freeze(next);
    }

    #assertValidProviderTuple(tuple){
        if(tuple[0]==='OLLAMA'){
            const mappedModel=tuple[3]==='OPENAI'?null:this.#models[tuple[3]];
            if(!mappedModel&&!normalizeOllamaModelIdentifier(tuple[3])){
                const error=new TypeError('The Ollama model preference is invalid.');
                error.code='AI_MODEL_INVALID';
                throw error;
            }
        }
    }

    #normalizedLLMModel(service,model){
        if(service==='OLLAMA'){
            const mappedModel=model==='OPENAI'?null:this.#models[model];
            return mappedModel
                ||normalizeOllamaModelIdentifier(model)
                ||model;
        }
        if(service==='OPENAI'){
            return this.#models.OPENAI;
        }
        return model;
    }

    #applyPreferenceTuple(tuple){
        const [
            llmService,
            sttService,
            ttsService,
            model,
            modelTTS,
            modelSTT
        ]=tuple;
        const normalizedLLMModel=this.#normalizedLLMModel(
            llmService,
            model
        );
        this.llmService=llmService;
        this.sttService=sttService;
        this.ttsService=ttsService;
        this.model=normalizedLLMModel;
        this.modelTTS=this.#ttsModels[modelTTS]||modelTTS;
        this.modelSTT=this.#sttModels[modelSTT]||modelSTT;
        this.reasoningEffort='';
        this.#preferenceTuple=Object.freeze(tuple.slice());
    }

    #applySpeechPreferenceTuple(tuple){
        this.sttService=tuple[1];
        this.ttsService=tuple[2];
        this.modelTTS=this.#ttsModels[tuple[4]]||tuple[4];
        this.modelSTT=this.#sttModels[tuple[5]]||tuple[5];
        this.#preferenceTuple=Object.freeze(tuple.slice());
    }

    #tupleFromProviderRoutes(selections){
        const llm=selections.llm.default;
        const stt=selections.stt.default;
        const tts=selections.tts.default;
        return Object.freeze([
            llm?.providerId||'',
            stt?.providerId||'',
            tts?.providerId||'',
            llm?.modelId||'',
            tts?.modelId||'',
            stt?.modelId||''
        ]);
    }

    #tupleFromSpeechProviderRoutes(selections){
        const current=this.#preferenceTuple;
        const stt=selections.stt.default;
        const tts=selections.tts.default;
        return Object.freeze([
            current[0],
            stt?.providerId||'',
            tts?.providerId||'',
            current[3],
            tts?.modelId||'',
            stt?.modelId||''
        ]);
    }

    #routesFromPreferenceTuple(tuple){
        const roles={
            llm:[
                tuple[0],
                this.#normalizedLLMModel(tuple[0],tuple[3])
            ],
            stt:[tuple[1],this.#sttModels[tuple[5]]||tuple[5]],
            tts:[tuple[2],this.#ttsModels[tuple[4]]||tuple[4]]
        };
        const selections={};
        for(const role of ['llm','stt','tts']){
            const [providerId,modelId]=roles[role];
            const identity=providerId&&modelId
                ?this.#providerRuntime.providerIdentity(role,providerId)
                :null;
            const pendingNonLegacy=Boolean(
                providerId
                &&modelId
                &&!LEGACY_AI_SERVICES.has(providerId)
            );
            if(!identity&&!pendingNonLegacy){
                selections[role]={default:null,localOnly:null};
                continue;
            }
            const selection={
                providerId,
                modelId,
                localOnly:identity?.localOnly??null
            };
            selections[role]={
                default:selection,
                localOnly:identity?.localOnly===true
                    ?{...selection,localOnly:true}
                    :null
            };
        }
        return selections;
    }

    #assertRegisteredLegacyRoutes(selections){
        for(const role of ['llm','stt','tts']){
            for(const routeName of ['default','localOnly']){
                const selection=selections?.[role]?.[routeName];
                if(selection
                    &&LEGACY_AI_SERVICES.has(selection.providerId)
                    &&!this.#providerRuntime.hasProvider(role,selection.providerId)){
                    const error=new Error(
                        `Legacy AI provider ${selection.providerId} requires an explicit ${role} adapter before routing.`
                    );
                    error.code='ARCANE_AI_PROVIDER_UNAVAILABLE';
                    throw error;
                }
            }
        }
    }

    async #unloadProviderRolesForTransition(){
        const settlements=await Promise.allSettled([
            this.#providerRuntime.unload('llm'),
            this.#providerRuntime.unload('stt'),
            this.#providerRuntime.unload('tts')
        ]);
        const failure=settlements.find(function findAITransitionCleanupFailure(result){
            return result.status==='rejected';
        });
        if(failure){
            throw failure.reason;
        }
    }

    async #unloadSpeechProviderRolesForTransition(
        signal=null,
        expectedProviders=null,
        roles=['stt','tts']
    ){
        const runtime=this;
        const settlements=await Promise.allSettled(
            roles.map(async function unloadSpeechProviderRole(role){
                if(expectedProviders?.[role]
                    &&!runtime.#providerRuntime.ownsProvider(
                        role,
                        expectedProviders[role]
                    )){
                    throw runtime.#browserSpeechProviderRouteOwnershipError(
                        `The ${role} browser speech provider identity changed before unload.`
                    );
                }
                return role==='tts'
                    ?runtime.#providerRuntime.setSpeechMuted(true)
                    :runtime.#providerRuntime.unload(role,{signal});
            })
        );
        const failure=settlements.find(function findAISpeechTransitionCleanupFailure(result){
            return result.status==='rejected';
        });
        if(failure){
            throw failure.reason;
        }
    }

    // Set models to be used by the AI. 
    // Note: Only those that are defined are set.
    setAI(
        llmService,
        sttService,
        ttsService,
        model,
        modelTTS,
        modelSTT
    ) {
        if (
            !(
                llmService ||
                sttService ||
                ttsService ||
                model ||
                modelTTS ||
                modelSTT
            )
        ) {
            return false;
        }
        const tuple=this.#nextPreferenceTuple([
            llmService,
            sttService,
            ttsService,
            model,
            modelTTS,
            modelSTT
        ]);
        this.#assertValidProviderTuple(tuple);
        this.#assertSynchronousBrowserSpeechSupersession('AI.setAI');
        this.#ensureLegacyLLMProvider(tuple[0]);
        this.#ensureLegacySpeechProvider('stt',tuple[1]);
        this.#ensureLegacySpeechProvider('tts',tuple[2]);
        this.#providerRuntime.configure(this.#routesFromPreferenceTuple(tuple));
        this.#invalidateSpeechControl();
        this.#applyPreferenceTuple(tuple);
        this.#releaseInactiveLegacyLLMProviders(tuple[0]);
        this.#releaseInactiveLegacySpeechProviders({
            stt:tuple[1],
            tts:tuple[2]
        });
        this.#retainLegacyLLMReadiness(
            this.#reconcileLegacyLLMReadiness()
        );
        this.#retainLegacySpeechReadiness(
            this.#reconcileLegacySpeechReadiness()
        );
        return true;
    }

    configureProviders(selections){
        const prepared=this.#providerRuntime.validateConfiguration(selections);
        this.#assertSynchronousBrowserSpeechSupersession('AI.configureProviders');
        this.#ensureLegacyLLMProvider(
            prepared.llm.default?.providerId
        );
        this.#ensureLegacySpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureLegacySpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredLegacyRoutes(prepared);
        const configured=this.#providerRuntime.configure(prepared);
        this.#invalidateSpeechControl();
        this.#applyPreferenceTuple(this.#tupleFromProviderRoutes(configured));
        this.#releaseInactiveLegacyLLMProviders(
            configured.llm.default?.providerId
        );
        this.#releaseInactiveLegacySpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        this.#retainLegacyLLMReadiness(
            this.#reconcileLegacyLLMReadiness()
        );
        this.#retainLegacySpeechReadiness(
            this.#reconcileLegacySpeechReadiness()
        );
        return configured;
    }

    configureSpeechProviders(selections){
        const prepared=this.#providerRuntime.validateSpeechConfiguration(selections);
        this.#assertSynchronousBrowserSpeechSupersession(
            'AI.configureSpeechProviders'
        );
        this.#ensureLegacySpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureLegacySpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredLegacyRoutes(prepared);
        const configured=this.#providerRuntime.configureSpeech(prepared);
        this.#invalidateSpeechControl();
        this.#applySpeechPreferenceTuple(
            this.#tupleFromSpeechProviderRoutes(configured)
        );
        this.#releaseInactiveLegacySpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        this.#retainLegacySpeechReadiness(
            this.#reconcileLegacySpeechReadiness()
        );
        this.muted=true;
        this.stopAudio();
        return configured;
    }

    async transitionAI(
        llmService,
        sttService,
        ttsService,
        model,
        modelTTS,
        modelSTT
    ){
        const tuple=this.#nextPreferenceTuple([
            llmService,
            sttService,
            ttsService,
            model,
            modelTTS,
            modelSTT
        ]);
        this.#assertValidProviderTuple(tuple);
        await this.#supersedeBrowserSpeechForRouteChange();
        this.#invalidateSpeechControl();
        await this.#unloadProviderRolesForTransition();
        this.#ensureLegacyLLMProvider(tuple[0]);
        this.#ensureLegacySpeechProvider('stt',tuple[1]);
        this.#ensureLegacySpeechProvider('tts',tuple[2]);
        this.#providerRuntime.configure(this.#routesFromPreferenceTuple(tuple));
        this.#applyPreferenceTuple(tuple);
        this.#releaseInactiveLegacyLLMProviders(tuple[0]);
        this.#releaseInactiveLegacySpeechProviders({
            stt:tuple[1],
            tts:tuple[2]
        });
        await this.#reconcileLegacyLLMReadiness();
        await this.#reconcileLegacySpeechReadiness();
        return this.#providerRuntime.status();
    }

    async transitionProviders(selections){
        const prepared=this.#providerRuntime.validateConfiguration(selections);
        await this.#supersedeBrowserSpeechForRouteChange();
        this.#ensureLegacyLLMProvider(
            prepared.llm.default?.providerId
        );
        this.#ensureLegacySpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureLegacySpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredLegacyRoutes(prepared);
        this.#invalidateSpeechControl();
        await this.#unloadProviderRolesForTransition();
        const configured=this.#providerRuntime.configure(prepared);
        this.#applyPreferenceTuple(this.#tupleFromProviderRoutes(configured));
        this.#releaseInactiveLegacyLLMProviders(
            configured.llm.default?.providerId
        );
        this.#releaseInactiveLegacySpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        await this.#reconcileLegacyLLMReadiness();
        await this.#reconcileLegacySpeechReadiness();
        return configured;
    }

    async transitionSpeechProviders(selections){
        const prepared=this.#providerRuntime.validateSpeechConfiguration(selections);
        await this.#supersedeBrowserSpeechForRouteChange();
        this.#invalidateSpeechControl();
        await this.#unloadSpeechProviderRolesForTransition();
        this.#ensureLegacySpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureLegacySpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredLegacyRoutes(prepared);
        const configured=this.#providerRuntime.configureSpeech(prepared);
        this.#applySpeechPreferenceTuple(
            this.#tupleFromSpeechProviderRoutes(configured)
        );
        this.#releaseInactiveLegacySpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        await this.#reconcileLegacySpeechReadiness();
        this.muted=true;
        return configured;
    }

    #browserSpeechOperationId(action){
        if(this.#browserSpeechOperationSequence===Number.MAX_SAFE_INTEGER){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.operationSequenceExhausted,
                AI_BROWSER_SPEECH_REASONS.operationSequenceExhausted,
                'The browser speech operation sequence is exhausted.'
            );
        }
        this.#browserSpeechOperationSequence+=1;
        return `${this.#events.instanceId}:${action}:${this.#browserSpeechOperationSequence.toString(36)}`;
    }

    #browserSpeechAbortError(controller,generation,{committed=false}={}){
        const reason=controller.signal.reason;
        if(reason?.code===AI_BROWSER_SPEECH_ERROR_CODES.configurationSuperseded){
            if(Boolean(reason.committed)===committed)return reason;
            return aiBrowserSpeechError(
                reason.code,
                reason.reason||AI_BROWSER_SPEECH_REASONS.configurationReplaced,
                reason.message
                    ||'The browser speech configuration was superseded.',
                reason,
                {committed,name:'AbortError'}
            );
        }
        if(generation!==this.#browserSpeechGeneration){
            return aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationSuperseded,
                AI_BROWSER_SPEECH_REASONS.configurationReplaced,
                'The browser speech configuration was replaced by a newer configuration.',
                controller.signal.reason,
                {committed,name:'AbortError'}
            );
        }
        return aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationCancelled,
            AI_BROWSER_SPEECH_REASONS.configurationCancelled,
            'The browser speech configuration was cancelled.',
            reason,
            {committed,name:'AbortError'}
        );
    }

    #assertBrowserSpeechOperation(controller,generation,{committed=false}={}){
        if(generation!==this.#browserSpeechGeneration||controller.signal.aborted){
            throw this.#browserSpeechAbortError(
                controller,
                generation,
                {committed}
            );
        }
    }

    #invalidateSpeechControl(){
        this.#speechControlGeneration+=1;
        this.muted=true;
        this.stopAudio();
    }

    #sameBrowserSpeechSelection(left,right){
        if(left===null||right===null)return left===right;
        return Boolean(left&&right)
            &&left.providerId===right.providerId
            &&left.modelId===right.modelId
            &&left.localOnly===right.localOnly;
    }

    #sameBrowserSpeechRoutes(left,right,roles=['stt','tts']){
        return roles.every(role=>
            ['default','localOnly'].every(routeName=>
                this.#sameBrowserSpeechSelection(
                    left?.[role]?.[routeName]??null,
                    right?.[role]?.[routeName]??null
                )
            )
        );
    }

    #browserSpeechRecordOwnsProviders(record){
        if(!record||record.managedRoles.length===0)return false;
        return record.managedRoles.every(role=>{
            if(record.registrationState?.[role]===false)return false;
            return this.#providerRuntime.ownsProvider(
                role,
                record.providers[role]
            );
        });
    }

    #browserSpeechRecordIsActive(record){
        return this.#browserSpeechRecordOwnsProviders(record)
            &&this.#sameBrowserSpeechRoutes(
                this.#currentSpeechRoutes(),
                record.routes,
                record.managedRoles
            );
    }

    #browserSpeechProviderRouteOwnershipError(message){
        return aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.providerRouteOwnershipMismatch,
            AI_BROWSER_SPEECH_REASONS.providerRouteOwnershipMismatch,
            message
        );
    }

    #browserSpeechReplacementBoundary(previousRecord,roles){
        const expectedProviders={stt:null,tts:null};
        const legacyRecords=[];
        for(const role of roles){
            if(previousRecord?.managedRoles.includes(role)){
                expectedProviders[role]=previousRecord.providers[role];
                continue;
            }
            const selection=this.#providerRuntime.selection(role);
            if(!selection){
                expectedProviders[role]=null;
                continue;
            }
            const record=this.#legacySpeechProviders.get(
                this.#legacySpeechProviderKey(role,selection.providerId)
            );
            if(!record
                ||!this.#providerRuntime.ownsProvider(role,record.provider)){
                throw this.#browserSpeechProviderRouteOwnershipError(
                    `The selected ${role} route is not owned by the replaceable AI legacy speech boundary.`
                );
            }
            expectedProviders[role]=record.provider;
            legacyRecords.push(record);
        }
        return Object.freeze({
            expectedProviders:Object.freeze(expectedProviders),
            legacyRecords:Object.freeze(legacyRecords)
        });
    }

    async #cleanupRetiredLegacySpeechProviders(
        {signal=null,committed=false}={}
    ){
        const failures=[];
        for(const record of [...this.#browserSpeechRetiredLegacyRecords]){
            try{
                if(this.#providerRuntime.ownsProvider(
                    record.role,
                    record.provider
                )){
                    throw this.#browserSpeechProviderRouteOwnershipError(
                        `The retired ${record.role} legacy speech provider still owns its registry entry.`
                    );
                }
                await record.provider.dispose({role:record.role,signal});
                const key=this.#legacySpeechProviderKey(
                    record.role,
                    record.providerId
                );
                if(this.#legacySpeechProviders.get(key)===record){
                    this.#legacySpeechProviders.delete(key);
                }
                this.#browserSpeechRetiredLegacyRecords.delete(record);
            }catch(error){
                failures.push(error);
            }
        }
        if(failures.length){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.providerDisposalRejected,
                AI_BROWSER_SPEECH_REASONS.providerDisposalRejected,
                'The replaced legacy speech providers could not be disposed.',
                failures.length===1
                    ?failures[0]
                    :new AggregateError(
                        failures,
                        'Multiple replaced legacy speech provider disposals were rejected.'
                    ),
                {committed}
            );
        }
        return true;
    }

    #assertSynchronousBrowserSpeechSupersession(method){
        if(!this.#browserSpeechConfigurationRecord
            &&this.#browserSpeechRetiredRecords.size===0){
            return;
        }
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.asyncTransitionRequired,
            AI_BROWSER_SPEECH_REASONS.asyncTransitionRequired,
            `${method} cannot replace SDK-owned browser speech providers synchronously; await AI.disposeBrowserSpeech() or use an asynchronous transition method.`
        );
    }

    async #supersedeBrowserSpeechForRouteChange(){
        if(!this.#browserSpeechConfigurationRecord
            &&this.#browserSpeechRetiredRecords.size===0){
            return false;
        }
        return this.disposeBrowserSpeech();
    }

    #publishBrowserSpeechEvent(type,normalized,operationId,reason,{descriptor=null,error=null}={}){
        const compatibilityDetail=Object.freeze({
            configuration:normalized.configuration,
            configurationId:normalized.id,
            ...(descriptor?{descriptor}:{}),
            ...(error?{error}:{}),
            reason
        });
        return this.#events.dispatch(
            type,
            compatibilityDetail,
            {
                operationId,
                publicDetail:Object.freeze({
                    configurationId:normalized.id,
                    ...(descriptor?{descriptor}:{}),
                    ...(typeof error?.code==='string'?{code:error.code}:{}),
                    reason
                })
            }
        );
    }

    #browserSpeechRoutes(normalized,providers,previousRecord){
        function roleRoutes(provider,catalog){
            const selection=Object.freeze({
                providerId:provider.id,
                modelId:catalog.id,
                localOnly:true
            });
            return Object.freeze({default:selection,localOnly:selection});
        }
        const currentRoutes=this.#currentSpeechRoutes();
        const routes={};
        const catalogs={};
        for(const role of ['stt','tts']){
            if(!normalized.roles.includes(role)){
                routes[role]=previousRecord?.managedRoles.includes(role)
                    ?previousRecord.routes[role]
                    :currentRoutes[role];
                catalogs[role]=null;
                continue;
            }
            const catalog=providers[role].catalog();
            if(catalog.length!==1||typeof catalog[0]?.id!=='string'){
                throw aiBrowserSpeechError(
                    AI_BROWSER_SPEECH_ERROR_CODES.providerConstructionRejected,
                    AI_BROWSER_SPEECH_REASONS.providerConstructionRejected,
                    `The browser speech ${role} provider must expose one admitted model.`
                );
            }
            catalogs[role]=catalog[0];
            routes[role]=roleRoutes(providers[role],catalog[0]);
        }
        return Object.freeze({
            routes:Object.freeze(routes),
            catalogs:Object.freeze(catalogs)
        });
    }

    #browserSpeechDescriptor(normalized,catalogs,previousRecord){
        function roleDescriptor(role,configured,catalog){
            return Object.freeze({
                role,
                providerId:configured.providerId,
                modelId:catalog.id,
                ...(configured.graph
                    ?{artifactGraphId:catalog.artifactGraphId}
                    :{}),
                offline:configured.offline,
                ...(role==='tts'?{defaultVoice:catalog.defaultVoice}:{})
            });
        }
        const roles={};
        for(const role of ['stt','tts']){
            roles[role]=normalized.roles.includes(role)
                ?roleDescriptor(role,normalized[role],catalogs[role])
                :previousRecord?.descriptor[role]??null;
        }
        return Object.freeze({
            protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
            configurationId:normalized.id,
            ...roles
        });
    }

    #browserSpeechConfiguration(normalized,previousRecord){
        if(!previousRecord)return normalized.configuration;
        if(normalized.roles.length===2)return normalized.configuration;
        if(normalized.dbopfs!==previousRecord.dbopfs
            ||normalized.tableName!==previousRecord.tableName){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                'A partial browser speech replacement must retain the active DBOPFS store and tableName.'
            );
        }
        const carriedRoles=previousRecord.managedRoles.filter(
            role=>!normalized.roles.includes(role)
        );
        if(carriedRoles.length===0)return normalized.configuration;
        return Object.freeze({
            protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
            id:normalized.id,
            dbopfs:normalized.dbopfs,
            ...(normalized.tableName?{tableName:normalized.tableName}:{}),
            ...(normalized.roles.includes('stt')
                ?{stt:normalized.configuration.stt}
                :previousRecord.managedRoles.includes('stt')
                    ?{stt:previousRecord.configuration.stt}
                    :{}),
            ...(normalized.roles.includes('tts')
                ?{tts:normalized.configuration.tts}
                :previousRecord.managedRoles.includes('tts')
                    ?{tts:previousRecord.configuration.tts}
                    :{})
        });
    }

    #currentSpeechRoutes(){
        return Object.freeze({
            stt:Object.freeze({
                default:this.#providerRuntime.selection('stt'),
                localOnly:this.#providerRuntime.selection('stt',{localOnly:true})
            }),
            tts:Object.freeze({
                default:this.#providerRuntime.selection('tts'),
                localOnly:this.#providerRuntime.selection('tts',{localOnly:true})
            })
        });
    }

    #emptySpeechRoutes(){
        return Object.freeze({
            stt:Object.freeze({default:null,localOnly:null}),
            tts:Object.freeze({default:null,localOnly:null})
        });
    }

    async #browserSpeechModule(){
        if(!this.#browserSpeechModulePromise){
            const runtime=this;
            this.#browserSpeechModulePromise=import(
                'arcane-os/ai/browser-speech'
            ).catch(function clearRejectedBrowserSpeechImport(error){
                runtime.#browserSpeechModulePromise=null;
                throw error;
            });
        }
        return this.#browserSpeechModulePromise;
    }

    #assertBrowserSpeechGraphs(normalized,module){
        for(const role of normalized.roles){
            const configured=normalized[role];
            const graph=configured.graph;
            if(!graph)continue;
            if(graph.protocol!==module.BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL
                ||graph.role!==role
                ||(graph.providerId!==null
                    &&graph.providerId!==undefined
                    &&graph.providerId!==configured.providerId)){
                throw aiBrowserSpeechError(
                    AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                    AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                    `AI browser speech ${role}.graph does not match its role, provider, or graph protocol.`
                );
            }
        }
    }

    #browserSpeechCandidate(
        normalized,
        configuration,
        descriptor,
        providers,
        routes,
        previousRecord
    ){
        const configurationByRole={};
        const managedRoles=Object.freeze(['stt','tts'].filter(role=>
            normalized.roles.includes(role)
            ||previousRecord?.managedRoles.includes(role)
        ));
        for(const role of ['stt','tts']){
            configurationByRole[role]=normalized.roles.includes(role)
                ?normalized.configuration
                :previousRecord?.configurationByRole[role]??null;
        }
        return {
            configuration,
            configurationByRole:Object.freeze(configurationByRole),
            dbopfs:normalized.dbopfs,
            tableName:normalized.tableName,
            descriptor,
            providers,
            routes,
            managedRoles,
            candidateRoles:normalized.roles,
            unregisters:{stt:null,tts:null},
            registrationState:{stt:false,tts:false},
            retirementState:{stt:false,tts:false}
        };
    }

    #freezeBrowserSpeechRecord(record){
        record.unregisters=Object.freeze({...record.unregisters});
        Object.seal(record.registrationState);
        Object.seal(record.retirementState);
        return Object.freeze(record);
    }

    #browserSpeechRecordFromReplacement(record,replacement){
        return this.#freezeBrowserSpeechRecord({
            configuration:record.configuration,
            configurationByRole:record.configurationByRole,
            dbopfs:record.dbopfs,
            tableName:record.tableName,
            descriptor:record.descriptor,
            providers:record.providers,
            routes:replacement.routes,
            managedRoles:record.managedRoles,
            candidateRoles:record.candidateRoles,
            unregisters:{
                stt:replacement.unregisters.stt,
                tts:replacement.unregisters.tts
            },
            registrationState:{
                stt:record.managedRoles.includes('stt'),
                tts:record.managedRoles.includes('tts')
            },
            retirementState:{stt:false,tts:false}
        });
    }

    #retireBrowserSpeechRegistration(record,roles=['stt','tts']){
        if(!record)return;
        let retired=false;
        for(const role of roles){
            if(record.registrationState[role]===false)continue;
            record.registrationState[role]=false;
            record.retirementState[role]=true;
            retired=true;
        }
        if(retired)this.#browserSpeechRetiredRecords.add(record);
    }

    #unregisterBrowserSpeechRecord(
        record,
        {roles=['stt','tts'],committed=false}={}
    ){
        const failures=[];
        for(const role of ['tts','stt'].filter(role=>roles.includes(role))){
            if(record.registrationState?.[role]===false)continue;
            const unregister=record.unregisters?.[role];
            if(typeof unregister!=='function'){
                failures.push(aiBrowserSpeechError(
                    AI_BROWSER_SPEECH_ERROR_CODES.providerUnregistrationRejected,
                    AI_BROWSER_SPEECH_REASONS.providerUnregistrationRejected,
                    `The ${role} browser speech provider ${record.providers[role].id} has no unregister handle.`
                ));
                continue;
            }
            try{
                const removed=unregister();
                if(removed!==true){
                    failures.push(aiBrowserSpeechError(
                        AI_BROWSER_SPEECH_ERROR_CODES.providerUnregistrationRejected,
                        AI_BROWSER_SPEECH_REASONS.providerUnregistrationRejected,
                        `The ${role} browser speech provider ${record.providers[role].id} no longer owns its registry entry.`
                    ));
                    continue;
                }
                if(record.registrationState)record.registrationState[role]=false;
            }catch(error){
                failures.push(error);
            }
        }
        if(failures.length){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.providerUnregistrationRejected,
                AI_BROWSER_SPEECH_REASONS.providerUnregistrationRejected,
                'The browser speech providers could not be unregistered.',
                failures.length===1
                    ?failures[0]
                    :new AggregateError(
                        failures,
                        'Multiple browser speech provider unregistrations were rejected.'
                    ),
                {committed}
            );
        }
    }

    async #disposeBrowserSpeechProviders(
        record,
        {roles=['stt','tts'],signal=null}={}
    ){
        if(!record)return;
        const disposableRoles=roles.filter(role=>record.providers?.[role]);
        const settlements=await Promise.allSettled(
            disposableRoles.map(function disposeBrowserSpeechProvider(role){
                return record.providers[role].dispose({
                    role,
                    selection:record.routes[role].default,
                    signal
                });
            })
        );
        const failures=settlements
            .filter(result=>result.status==='rejected')
            .map(result=>result.reason);
        if(failures.length){
            throw failures.length===1
                ?failures[0]
                :new AggregateError(
                    failures,
                    'Multiple browser speech provider disposals were rejected.'
                );
        }
    }

    async #cleanupBrowserSpeechRecord(
        record,
        {signal=null,committed=false}={}
    ){
        if(!record)return false;
        const retiredRoles=['stt','tts'].filter(
            role=>record.retirementState?.[role]===true
        );
        const roles=retiredRoles.length?retiredRoles:record.candidateRoles;
        this.#browserSpeechRetiredRecords.add(record);
        this.#unregisterBrowserSpeechRecord(record,{roles,committed});
        try{
            await this.#disposeBrowserSpeechProviders(record,{roles,signal});
        }catch(error){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.providerDisposalRejected,
                AI_BROWSER_SPEECH_REASONS.providerDisposalRejected,
                'The browser speech providers could not be disposed.',
                error,
                {committed}
            );
        }
        this.#browserSpeechRetiredRecords.delete(record);
        return true;
    }

    async #throwAfterBrowserSpeechCandidateCleanup(record,failure){
        try{
            await this.#cleanupBrowserSpeechRecord(record);
        }catch(cleanupError){
            throw aiBrowserSpeechError(
                cleanupError.code
                    ||AI_BROWSER_SPEECH_ERROR_CODES.providerDisposalRejected,
                cleanupError.reason
                    ||AI_BROWSER_SPEECH_REASONS.providerDisposalRejected,
                'Browser speech candidate cleanup was rejected after configuration rejection.',
                new AggregateError(
                    [failure,cleanupError],
                    'Browser speech configuration and candidate cleanup were both rejected.'
                )
            );
        }
        throw failure;
    }

    async #configureBrowserSpeechOperation(normalized,controller,generation,operationId){
        this.#assertBrowserSpeechOperation(controller,generation);
        const previousRecord=this.#browserSpeechConfigurationRecord;
        if(previousRecord&&!this.#browserSpeechRecordIsActive(previousRecord)){
            throw this.#browserSpeechProviderRouteOwnershipError(
                'The prior browser speech provider or route ownership changed before replacement.'
            );
        }
        const configuration=this.#browserSpeechConfiguration(
            normalized,
            previousRecord
        );
        this.#publishBrowserSpeechEvent(
            AI_BROWSER_SPEECH_EVENT_TYPES.configurationStarted,
            normalized,
            operationId,
            this.#browserSpeechConfigurationRecord
                ?AI_BROWSER_SPEECH_REASONS.configurationReplaced
                :AI_BROWSER_SPEECH_REASONS.configurationAdded
        );
        this.#assertBrowserSpeechOperation(controller,generation);

        let module;
        try{
            module=await this.#browserSpeechModule();
        }catch(error){
            this.#assertBrowserSpeechOperation(controller,generation);
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.moduleImportRejected,
                AI_BROWSER_SPEECH_REASONS.moduleImportRejected,
                'The browser speech SDK module could not be imported.',
                error
            );
        }
        this.#assertBrowserSpeechOperation(controller,generation);
        this.#assertBrowserSpeechGraphs(normalized,module);

        let store;
        try{
            store=module.createDbopfsSpeechArtifactStore({
                dbopfs:normalized.dbopfs,
                ...(normalized.tableName?{tableName:normalized.tableName}:{})
            });
        }catch(error){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.artifactStoreConstructionRejected,
                AI_BROWSER_SPEECH_REASONS.artifactStoreConstructionRejected,
                'The browser speech artifact store could not be constructed.',
                error
            );
        }

        const candidateProviders={
            stt:previousRecord?.providers.stt??null,
            tts:previousRecord?.providers.tts??null
        };
        for(const role of normalized.roles)candidateProviders[role]=null;
        let providers=null;
        let prepared=null;
        try{
            for(const role of normalized.roles){
                const factory=role==='stt'
                    ?module.createBrowserWhisperProvider
                    :module.createBrowserKokoroProvider;
                const configured=normalized[role];
                candidateProviders[role]=factory({
                    id:configured.providerId,
                    ...(configured.graph
                        ?{
                            graph:configured.graph,
                            security:configured.security
                        }
                        :{
                            model:configured.model,
                            runtime:configured.runtime,
                            ...(Object.hasOwn(configured,'security')
                                ?{security:configured.security}
                                :{})
                        }),
                    store,
                    offline:configured.offline
                });
            }
            providers=Object.freeze({...candidateProviders});
            prepared=this.#browserSpeechRoutes(
                normalized,
                providers,
                previousRecord
            );
        }catch(error){
            const failure=error?.code===AI_BROWSER_SPEECH_ERROR_CODES.providerConstructionRejected
                ?error
                :aiBrowserSpeechError(
                    AI_BROWSER_SPEECH_ERROR_CODES.providerConstructionRejected,
                    AI_BROWSER_SPEECH_REASONS.providerConstructionRejected,
                    'The browser speech providers could not be constructed.',
                    error
            );
            if(normalized.roles.some(role=>candidateProviders[role])){
                const currentRoutes=this.#currentSpeechRoutes();
                const partialRoutes={};
                for(const role of ['stt','tts']){
                    const provider=candidateProviders[role];
                    const changed=normalized.roles.includes(role);
                    const selection=changed&&provider
                        ?Object.freeze({
                            providerId:provider.id,
                            modelId:normalized[role].graph?.model.id
                                ??normalized[role].model.id,
                            localOnly:true
                        })
                        :null;
                    partialRoutes[role]=changed
                        ?Object.freeze({default:selection,localOnly:selection})
                        :previousRecord?.managedRoles.includes(role)
                            ?previousRecord.routes[role]
                            :currentRoutes[role];
                }
                const partial=this.#browserSpeechCandidate(
                    normalized,
                    configuration,
                    null,
                    Object.freeze({...candidateProviders}),
                    Object.freeze(partialRoutes),
                    previousRecord
                );
                return this.#throwAfterBrowserSpeechCandidateCleanup(
                    partial,
                    failure
                );
            }
            throw failure;
        }
        const descriptor=this.#browserSpeechDescriptor(
            normalized,
            prepared.catalogs,
            previousRecord
        );
        const candidate=this.#browserSpeechCandidate(
            normalized,
            configuration,
            descriptor,
            providers,
            prepared.routes,
            previousRecord
        );
        let replacementBoundary;
        try{
            replacementBoundary=this.#browserSpeechReplacementBoundary(
                previousRecord,
                normalized.roles
            );
        }catch(error){
            return this.#throwAfterBrowserSpeechCandidateCleanup(
                candidate,
                error
            );
        }
        try{
            await this.#unloadSpeechProviderRolesForTransition(
                controller.signal,
                replacementBoundary.expectedProviders,
                normalized.roles
            );
            this.#assertBrowserSpeechOperation(controller,generation);
        }catch(error){
            return this.#throwAfterBrowserSpeechCandidateCleanup(candidate,error);
        }

        let replacement;
        try{
            if(normalized.roles.length===2){
                replacement=this.#providerRuntime.replaceSpeechProviders({
                    providers,
                    routes:prepared.routes,
                    expectedProviders:replacementBoundary.expectedProviders
                });
            }else{
                const role=normalized.roles[0];
                const roleReplacement=this.#providerRuntime.replaceSpeechProvider(
                    role,
                    {
                        provider:providers[role],
                        routes:prepared.routes[role],
                        expectedProvider:replacementBoundary.expectedProviders[role]
                    }
                );
                replacement=Object.freeze({
                    routes:prepared.routes,
                    unregisters:Object.freeze({
                        stt:role==='stt'
                            ?roleReplacement.unregister
                            :previousRecord?.unregisters.stt??null,
                        tts:role==='tts'
                            ?roleReplacement.unregister
                            :previousRecord?.unregisters.tts??null
                    })
                });
            }
        }catch(error){
            const commitFailure=aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.routeCommitRejected,
                AI_BROWSER_SPEECH_REASONS.routeCommitRejected,
                'The browser speech provider and route replacement could not be committed.',
                error
            );
            return this.#throwAfterBrowserSpeechCandidateCleanup(
                candidate,
                commitFailure
            );
        }

        const record=this.#browserSpeechRecordFromReplacement(
            candidate,
            replacement
        );
        for(const legacyRecord of replacementBoundary.legacyRecords){
            this.#browserSpeechRetiredLegacyRecords.add(legacyRecord);
        }
        if(previousRecord){
            this.#retireBrowserSpeechRegistration(
                previousRecord,
                normalized.roles
            );
        }
        this.#browserSpeechConfigurationRecord=record;
        try{
            this.#applySpeechPreferenceTuple(
                this.#tupleFromSpeechProviderRoutes(replacement.routes)
            );
        }catch(error){
            const finalizationFailure=aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.routeViewUpdateRejected,
                AI_BROWSER_SPEECH_REASONS.routeViewUpdateRejected,
                'The committed browser speech replacement could not update the AI speech route view.',
                error
            );
            if(!previousRecord
                ||normalized.roles.some(
                    role=>!previousRecord.managedRoles.includes(role)
                )){
                finalizationFailure.committed=true;
                throw finalizationFailure;
            }

            let rollback;
            try{
                if(normalized.roles.length===2){
                    rollback=this.#providerRuntime.replaceSpeechProviders({
                        providers:previousRecord.providers,
                        routes:previousRecord.routes,
                        expectedProviders:record.providers
                    });
                }else{
                    const role=normalized.roles[0];
                    const roleRollback=this.#providerRuntime.replaceSpeechProvider(
                        role,
                        {
                            provider:previousRecord.providers[role],
                            routes:previousRecord.routes[role],
                            expectedProvider:record.providers[role]
                        }
                    );
                    rollback=Object.freeze({
                        routes:previousRecord.routes,
                        unregisters:Object.freeze({
                            stt:role==='stt'
                                ?roleRollback.unregister
                                :previousRecord.unregisters.stt,
                            tts:role==='tts'
                                ?roleRollback.unregister
                                :previousRecord.unregisters.tts
                        })
                    });
                }
            }catch(rollbackError){
                const candidateCommitted=this.#browserSpeechRecordIsActive(record);
                if(!candidateCommitted){
                    this.#browserSpeechConfigurationRecord=null;
                    this.#browserSpeechRetiredRecords.add(record);
                }
                throw aiBrowserSpeechError(
                    AI_BROWSER_SPEECH_ERROR_CODES.routeRollbackRejected,
                    AI_BROWSER_SPEECH_REASONS.routeRollbackRejected,
                    'The prior browser speech providers and routes could not be restored after AI speech route view rejection.',
                    new AggregateError(
                        [finalizationFailure,rollbackError],
                        'Browser speech replacement finalization and rollback were both rejected.'
                    ),
                    {committed:candidateCommitted}
                );
            }

            this.#retireBrowserSpeechRegistration(record,normalized.roles);
            const restoredRecord=this.#browserSpeechRecordFromReplacement(
                previousRecord,
                rollback
            );
            this.#browserSpeechRetiredRecords.delete(previousRecord);
            this.#browserSpeechConfigurationRecord=restoredRecord;
            this.#applySpeechPreferenceTuple(
                this.#tupleFromSpeechProviderRoutes(rollback.routes)
            );
            return this.#throwAfterBrowserSpeechCandidateCleanup(
                record,
                finalizationFailure
            );
        }
        this.#assertBrowserSpeechOperation(
            controller,
            generation,
            {committed:true}
        );
        await this.#cleanupRetiredLegacySpeechProviders({
            signal:controller.signal,
            committed:true
        });
        this.#assertBrowserSpeechOperation(
            controller,
            generation,
            {committed:true}
        );
        this.#publishBrowserSpeechEvent(
            AI_BROWSER_SPEECH_EVENT_TYPES.configured,
            normalized,
            operationId,
            previousRecord
                ?AI_BROWSER_SPEECH_REASONS.configurationReplaced
                :AI_BROWSER_SPEECH_REASONS.configurationAdded,
            {descriptor}
        );

        for(const retiredRecord of [...this.#browserSpeechRetiredRecords]){
            try{
                await this.#cleanupBrowserSpeechRecord(
                    retiredRecord,
                    {signal:controller.signal,committed:true}
                );
            }catch(error){
                if(error?.committed===true)throw error;
                if(generation!==this.#browserSpeechGeneration
                    ||controller.signal.aborted){
                    throw this.#browserSpeechAbortError(
                        controller,
                        generation,
                        {committed:true}
                    );
                }
                throw error;
            }
        }
        this.#assertBrowserSpeechOperation(
            controller,
            generation,
            {committed:true}
        );
        return descriptor;
    }

    configureBrowserSpeech(configuration,options={}){
        const normalized=normalizeBrowserSpeechConfiguration(configuration);
        const operation=normalizeBrowserSpeechOperationOptions(
            options,
            'AI.configureBrowserSpeech'
        );
        if(operation.signal?.aborted){
            return Promise.reject(aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationCancelled,
                AI_BROWSER_SPEECH_REASONS.configurationCancelled,
                'The browser speech configuration was cancelled before admission.',
                operation.signal.reason,
                {name:'AbortError'}
            ));
        }
        if(this.#browserSpeechConfigurationRecord
            &&normalized.roles.every(role=>
                this.#browserSpeechConfigurationRecord.configurationByRole[role]
                    ===configuration
            )
            &&this.#browserSpeechRecordIsActive(
                this.#browserSpeechConfigurationRecord
            )
            &&this.#browserSpeechRetiredRecords.size===0
            &&!this.#browserSpeechController){
            return Promise.resolve(this.#browserSpeechConfigurationRecord.descriptor);
        }
        const operationId=this.#browserSpeechOperationId('configure-browser-speech');
        const generation=++this.#browserSpeechGeneration;
        const superseded=aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationSuperseded,
            AI_BROWSER_SPEECH_REASONS.configurationReplaced,
            'The browser speech configuration was replaced by a newer configuration.',
            undefined,
            {name:'AbortError'}
        );
        this.#browserSpeechController?.abort(superseded);
        if(normalized.roles.includes('tts'))this.#invalidateSpeechControl();
        const controller=new AbortController();
        this.#browserSpeechController=controller;
        this.#browserSpeechControllerRoles=normalized.roles;
        const forwardAbort=function cancelBrowserSpeechConfiguration(){
            if(!controller.signal.aborted)controller.abort(operation.signal.reason);
        };
        if(operation.signal?.aborted)forwardAbort();
        else operation.signal?.addEventListener('abort',forwardAbort,{once:true});
        const runtime=this;
        const scheduled=this.#browserSpeechTransition.then(
            async function runBrowserSpeechConfiguration(){
                try{
                    return await runtime.#configureBrowserSpeechOperation(
                        normalized,
                        controller,
                        generation,
                        operationId
                    );
                }catch(error){
                    const failure=error?.committed===true
                        ?error
                        :(generation!==runtime.#browserSpeechGeneration
                            ||controller.signal.aborted)
                            ?runtime.#browserSpeechAbortError(controller,generation)
                            :error;
                    runtime.#publishBrowserSpeechEvent(
                        failure.name==='AbortError'
                            ?AI_BROWSER_SPEECH_EVENT_TYPES.configurationCancelled
                            :AI_BROWSER_SPEECH_EVENT_TYPES.configurationError,
                        normalized,
                        operationId,
                        failure.reason
                            ||AI_BROWSER_SPEECH_REASONS.routeCommitRejected,
                        {error:failure}
                    );
                    throw failure;
                }finally{
                    operation.signal?.removeEventListener('abort',forwardAbort);
                    if(runtime.#browserSpeechController===controller){
                        runtime.#browserSpeechController=null;
                        runtime.#browserSpeechControllerRoles=Object.freeze([]);
                    }
                }
            }
        );
        this.#browserSpeechTransition=scheduled.then(
            function completeBrowserSpeechConfigurationLane(){},
            function retainBrowserSpeechConfigurationFailure(){}
        );
        return scheduled;
    }

    disposeBrowserSpeech(options={}){
        const operation=normalizeBrowserSpeechOperationOptions(
            options,
            'AI.disposeBrowserSpeech'
        );
        if(operation.signal?.aborted){
            return Promise.reject(aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationCancelled,
                AI_BROWSER_SPEECH_REASONS.configurationCancelled,
                'Browser speech disposal was cancelled before admission.',
                operation.signal.reason,
                {name:'AbortError'}
            ));
        }
        const operationId=this.#browserSpeechOperationId('dispose-browser-speech');
        const generation=++this.#browserSpeechGeneration;
        const superseded=aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationSuperseded,
            AI_BROWSER_SPEECH_REASONS.configurationDisposed,
            'The browser speech configuration was superseded by disposal.',
            undefined,
            {name:'AbortError'}
        );
        const invalidatesSpeech=Boolean(
            this.#browserSpeechControllerRoles.includes('tts')
            ||this.#browserSpeechConfigurationRecord?.managedRoles.includes('tts')
            ||[...this.#browserSpeechRetiredRecords].some(record=>
                record.managedRoles.includes('tts')
                ||record.candidateRoles.includes('tts')
            )
            ||[...this.#browserSpeechRetiredLegacyRecords].some(
                record=>record.role==='tts'
            )
        );
        this.#browserSpeechController?.abort(superseded);
        if(invalidatesSpeech)this.#invalidateSpeechControl();
        const controller=new AbortController();
        this.#browserSpeechController=controller;
        this.#browserSpeechControllerRoles=Object.freeze([]);
        const forwardAbort=function cancelBrowserSpeechDisposal(){
            if(!controller.signal.aborted)controller.abort(operation.signal.reason);
        };
        if(operation.signal?.aborted)forwardAbort();
        else operation.signal?.addEventListener('abort',forwardAbort,{once:true});
        const runtime=this;
        const scheduled=this.#browserSpeechTransition.then(
            async function runBrowserSpeechDisposal(){
                let normalized=null;
                let descriptor=null;
                let changed=false;
                let committed=false;
                try{
                    runtime.#assertBrowserSpeechOperation(controller,generation);
                    const activeRecord=runtime.#browserSpeechConfigurationRecord;
                    const records=new Set(runtime.#browserSpeechRetiredRecords);
                    if(activeRecord)records.add(activeRecord);
                    const eventRecord=activeRecord||records.values().next().value||null;
                    if(!eventRecord
                        &&runtime.#browserSpeechRetiredLegacyRecords.size===0){
                        return false;
                    }
                    if(eventRecord){
                        normalized=normalizeBrowserSpeechConfiguration(
                            eventRecord.configuration
                        );
                        descriptor=eventRecord.descriptor;
                    }
                    if(activeRecord){
                        if(!runtime.#browserSpeechRecordIsActive(activeRecord)){
                            throw runtime.#browserSpeechProviderRouteOwnershipError(
                                'The configured browser speech provider or route ownership changed before disposal.'
                            );
                        }
                        await runtime.#unloadSpeechProviderRolesForTransition(
                            controller.signal,
                            activeRecord.providers,
                            activeRecord.managedRoles
                        );
                        runtime.#assertBrowserSpeechOperation(controller,generation);
                        let removed;
                        if(activeRecord.managedRoles.length===2){
                            removed=runtime.#providerRuntime.replaceSpeechProviders({
                                providers:{stt:null,tts:null},
                                routes:runtime.#emptySpeechRoutes(),
                                expectedProviders:activeRecord.providers
                            });
                        }else{
                            const role=activeRecord.managedRoles[0];
                            const currentRoutes=runtime.#currentSpeechRoutes();
                            const emptyRoleRoutes=Object.freeze({
                                default:null,
                                localOnly:null
                            });
                            runtime.#providerRuntime.replaceSpeechProvider(
                                role,
                                {
                                    provider:null,
                                    routes:emptyRoleRoutes,
                                    expectedProvider:activeRecord.providers[role]
                                }
                            );
                            removed=Object.freeze({
                                routes:Object.freeze({
                                    stt:role==='stt'
                                        ?emptyRoleRoutes
                                        :currentRoutes.stt,
                                    tts:role==='tts'
                                        ?emptyRoleRoutes
                                        :currentRoutes.tts
                                })
                            });
                        }
                        runtime.#retireBrowserSpeechRegistration(
                            activeRecord,
                            activeRecord.managedRoles
                        );
                        runtime.#browserSpeechConfigurationRecord=null;
                        changed=true;
                        committed=true;
                        try{
                            runtime.#applySpeechPreferenceTuple(
                                runtime.#tupleFromSpeechProviderRoutes(removed.routes)
                            );
                        }catch(error){
                            throw aiBrowserSpeechError(
                                AI_BROWSER_SPEECH_ERROR_CODES.routeViewUpdateRejected,
                                AI_BROWSER_SPEECH_REASONS.routeViewUpdateRejected,
                                'The committed browser speech removal could not update the AI speech route view.',
                                error,
                                {committed:true}
                            );
                        }
                    }

                    if(records.size)committed=true;
                    for(const record of records){
                        await runtime.#cleanupBrowserSpeechRecord(
                            record,
                            {signal:controller.signal,committed:true}
                        );
                        changed=true;
                    }
                    if(runtime.#browserSpeechRetiredLegacyRecords.size){
                        await runtime.#cleanupRetiredLegacySpeechProviders({
                            signal:controller.signal,
                            committed:true
                        });
                        changed=true;
                    }
                    runtime.#assertBrowserSpeechOperation(
                        controller,
                        generation,
                        {committed}
                    );
                    if(normalized){
                        runtime.#publishBrowserSpeechEvent(
                            AI_BROWSER_SPEECH_EVENT_TYPES.disposed,
                            normalized,
                            operationId,
                            AI_BROWSER_SPEECH_REASONS.configurationDisposed,
                            {descriptor}
                        );
                    }
                    return changed;
                }catch(error){
                    const failure=error?.committed===true
                        ?error
                        :(generation!==runtime.#browserSpeechGeneration
                            ||controller.signal.aborted)
                            ?runtime.#browserSpeechAbortError(
                                controller,
                                generation,
                                {committed}
                            )
                            :error;
                    if(normalized){
                        runtime.#publishBrowserSpeechEvent(
                            failure.name==='AbortError'
                                ?AI_BROWSER_SPEECH_EVENT_TYPES.configurationCancelled
                                :AI_BROWSER_SPEECH_EVENT_TYPES.configurationError,
                            normalized,
                            operationId,
                            failure.reason
                                ||AI_BROWSER_SPEECH_REASONS.providerDisposalRejected,
                            {error:failure}
                        );
                    }
                    throw failure;
                }finally{
                    operation.signal?.removeEventListener('abort',forwardAbort);
                    if(runtime.#browserSpeechController===controller){
                        runtime.#browserSpeechController=null;
                        runtime.#browserSpeechControllerRoles=Object.freeze([]);
                    }
                }
            }
        );
        this.#browserSpeechTransition=scheduled.then(
            function completeBrowserSpeechDisposalLane(){},
            function retainBrowserSpeechDisposalFailure(){}
        );
        return scheduled;
    }

    async startProviders(options){
        const normalized=normalizeAIStartupOptions(options);
        const generation=++this.#speechControlGeneration;
        this.muted=true;
        if(normalized.startMuted){
            this.stopAudio();
        }
        const handle=await this.#providerRuntime.start(normalized);
        if(!normalized.startMuted){
            const runtime=this;
            handle.settled.then(
                function admitReadyStartupSpeech(){
                    if(generation!==runtime.#speechControlGeneration)return;
                    const status=runtime.#providerRuntime.status('tts');
                    runtime.muted=!(status.state==='ready'&&status.loaded===true);
                },
                function retainFailClosedStartupSpeech(){
                    if(generation===runtime.#speechControlGeneration){
                        runtime.muted=true;
                    }
                }
            );
        }
        return handle;
    }

    async setSpeechMuted(muted){
        if(typeof muted!=='boolean'){
            throw new TypeError('AI speech muted state must be a boolean.');
        }
        const generation=++this.#speechControlGeneration;
        this.muted=true;
        if(muted){
            this.stopAudio();
        }
        if(!this.#usesProviderRuntime('tts',this.ttsService)){
            if(generation===this.#speechControlGeneration)this.muted=muted;
            return true;
        }
        await this.#providerRuntime.setSpeechMuted(muted);
        if(generation===this.#speechControlGeneration){
            const status=this.#providerRuntime.status('tts');
            this.muted=muted
                ||status.state!=='ready'
                ||status.loaded!==true;
        }
        return true;
    }

    async #assertResponseOK(response){
        if(response.ok){
            return response;
        }

        let detail='';

        try{
            const contentType=response.headers.get('content-type')||'';

            if(contentType.includes('application/json')){
                const errorResponse=await response.json();
                detail=errorResponse?.error?.message
                    || errorResponse?.message
                    || '';
            }else{
                const errorText=await response.text();

                if(errorText&&!errorText.trim().startsWith('<')){
                    detail=errorText.trim().slice(0,500);
                }
            }
        }catch{
            // The response status is enough when its body cannot be read.
        }

        const status=[response.status,response.statusText]
            .filter(Boolean)
            .join(' ');
        const message=`AI request failed${status ? ` (${status})`:''}`;
        const error=new Error(message);
        error.code='AI_REQUEST_FAILED';
        error.status=response.status;
        error.providerMessage=detail;
        throw error;
    }

    #nativeOllama(){
        const client=globalThis.Arcane?.ollama;

        return this.llmService==='OLLAMA'
            &&typeof client?.chat==='function'
            ?client
            :null;
    }

    #nativeSpeech(service,role){
        const client=globalThis.Arcane?.speech;

        if(service!=='LOCAL_SPEACH'){
            return null;
        }
        if(role==='tts'&&typeof client?.synthesize==='function'){
            return client;
        }
        if(role==='stt'&&typeof client?.transcribe==='function'){
            return client;
        }
        return null;
    }

    async #requestLegacySpeechTranscription(payload={},signal=null){
        const audio=payload?.audio;
        if(!audio||typeof audio.arrayBuffer!=='function'){
            throw new TypeError('Speech transcription requires an audio Blob or File.');
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        const mimeType=String(payload.mimeType||audio.type||'audio/webm');
        const model=String(payload.model||this.modelSTT);
        const nativeSpeech=this.#nativeSpeech(this.sttService,'stt');
        if(nativeSpeech){
            const audioBytes=await audio.arrayBuffer();
            if(signal?.aborted){
                throw normalizeAIRequestAbort(signal.reason);
            }
            const response=await nativeSpeech.transcribe({
                audioBase64:this.#arrayBufferToBase64(audioBytes),
                mimeType,
                model
            });
            if(signal?.aborted){
                throw normalizeAIRequestAbort(signal.reason);
            }
            if(!response||typeof response.text!=='string'){
                throw new TypeError('Arcane returned an invalid local speech transcription.');
            }
            return response.text;
        }

        await this.#assertAndroidSpeechBridge(this.sttService);
        const formData=new FormData();
        formData.append('file',audio);
        formData.append('model',model);
        formData.append('response_format','text');
        const response=await fetch(
            this.urlSTT,
            {
                method:'POST',
                credentials,
                headers:this.#sttHeaders[this.sttService],
                body:formData,
                signal
            }
        );
        if(!response.ok){
            throw new Error(`Speech transcription failed with status ${response.status}.`);
        }
        return response.text();
    }

    async #requestLegacySpeechSynthesis(payload={},signal=null){
        const input=typeof payload?.input==='string'?payload.input:'';
        if(!input){
            throw new TypeError('Speech synthesis requires nonempty input.');
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        const model=String(payload.model||this.modelTTS);
        const voice=typeof payload.voice==='string'&&payload.voice.trim()
            ?payload.voice.trim()
            :this.#legacySpeechDefaultVoice('tts',this.ttsService);
        if(!voice){
            throw new TypeError('The selected speech provider requires a voice.');
        }
        const responseFormat=String(payload.responseFormat||this.audioFormat);
        const speed=Number.isFinite(payload.speed)?payload.speed:this.voiceSpeed;
        const nativeSpeech=this.#nativeSpeech(this.ttsService,'tts');
        if(nativeSpeech){
            const response=await nativeSpeech.synthesize({
                model,
                voice,
                input,
                responseFormat,
                speed
            });
            if(signal?.aborted){
                throw normalizeAIRequestAbort(signal.reason);
            }
            if(!response||typeof response.audioBase64!=='string'){
                const error=new TypeError(
                    'The Arcane speech bridge returned invalid TTS audio.'
                );
                error.code='ARCANE_AI_TTS_NATIVE_AUDIO_INVALID';
                throw error;
            }
            return new Blob(
                [this.#base64ToBytes(response.audioBase64)],
                {
                    type:typeof response.contentType==='string'
                        ?response.contentType
                        :this.audioType
                }
            );
        }

        await this.#assertAndroidSpeechBridge(this.ttsService);
        let response;
        try{
            response=await fetch(
                this.urlTTS,
                {
                    method:'POST',
                    credentials,
                    headers:this.#ttsHeaders[this.ttsService],
                    body:JSON.stringify({
                        model,
                        voice,
                        input,
                        speed,
                        response_format:responseFormat
                    }),
                    signal
                }
            );
        }catch(error){
            if(isAIRequestAbort(error,signal)){
                throw normalizeAIRequestAbort(error);
            }
            throw legacyAIProviderError(
                'The configured TTS HTTP request failed.',
                'ARCANE_AI_TTS_HTTP_REQUEST_FAILED',
                error
            );
        }
        if(!response.ok){
            const error=legacyAIProviderError(
                `The configured TTS HTTP response was rejected with status ${response.status}.`,
                'ARCANE_AI_TTS_HTTP_RESPONSE_REJECTED'
            );
            error.status=response.status;
            throw error;
        }
        const contentType=response.headers.get('content-type')||this.audioType;
        return new Blob([await response.arrayBuffer()],{type:contentType});
    }

    async #androidNativeHost(){
        if(typeof globalThis.arcaneAndroid?.postMessage==='function'){
            return true;
        }

        try{
            const runtime=await globalThis.Arcane?.runtime?.current?.();
            return runtime?.native===true
                &&runtime?.transport==='android-webview';
        }catch{
            return false;
        }
    }

    async #assertAndroidSpeechBridge(service){
        if(service!=='LOCAL_SPEACH'||!await this.#androidNativeHost()){
            return;
        }

        const error=new Error(
            'Android local speech requires the capability-gated Arcane speech bridge.'
        );
        error.code='AI_ANDROID_NATIVE_SPEECH_UNAVAILABLE';
        throw error;
    }

    #arrayBufferToBase64(arrayBuffer){
        const bytes=new Uint8Array(arrayBuffer);

        if(!bytes.length||bytes.length>6*1024*1024){
            throw new RangeError('Microphone audio must be between 1 byte and 6 MiB.');
        }

        const chunks=[];

        for(let offset=0;offset<bytes.length;offset+=0x8000){
            chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
        }

        return btoa(chunks.join(''));
    }

    #base64ToBytes(value){
        if(typeof value!=='string'||!value||value.length>8*1024*1024){
            throw new TypeError('Arcane returned invalid local speech audio.');
        }

        const binary=atob(value);
        const bytes=new Uint8Array(binary.length);

        for(let index=0;index<binary.length;index+=1){
            bytes[index]=binary.charCodeAt(index);
        }

        return bytes;
    }

    #ollamaTools(tools=[],toolChoice='auto'){
        if(!Array.isArray(tools)){
            return [];
        }

        const requiredName=toolChoice?.function?.name;
        const requiredToolCount=requiredName
            ?tools.filter(tool=>tool?.function?.name===requiredName).length
            :0;

        if(requiredName&&requiredToolCount!==1){
            const error=new Error(`Required AI tool "${requiredName}" is not available.`);
            error.code='AI_REQUIRED_TOOL_UNAVAILABLE';
            throw error;
        }

        return tools;
    }

    #ollamaMessages(messages=[],toolChoice='auto'){
        const toolNamesByCallId=new Map();
        const sanitizedMessages=messages.map(function sanitizeOllamaMessage(message){
            const role=String(message?.role??'');
            const content=String(message?.content??'');

            if(role==='assistant'&&Array.isArray(message?.tool_calls)){
                const toolCalls=message.tool_calls.map(function sanitizeOllamaToolCall(call){
                    const name=String(call?.function?.name??'').trim();
                    const callId=String(call?.id??'').trim();
                    let argumentValue=call?.function?.arguments;
                    if(typeof argumentValue==='string'){
                        try{
                            argumentValue=JSON.parse(argumentValue);
                        }catch{
                            argumentValue={};
                        }
                    }
                    if(
                        !argumentValue
                        ||typeof argumentValue!=='object'
                        ||Array.isArray(argumentValue)
                    ){
                        argumentValue={};
                    }
                    if(callId&&name){
                        toolNamesByCallId.set(callId,name);
                    }
                    return {
                        type:'function',
                        function:{name,arguments:argumentValue}
                    };
                });

                return {
                    role,
                    content,
                    tool_calls:toolCalls
                };
            }

            if(role==='tool'){
                const callId=String(message?.tool_call_id??'').trim();
                const toolName=String(
                    message?.tool_name
                    ??message?.name
                    ??toolNamesByCallId.get(callId)
                    ??''
                ).trim();
                if(!toolName){
                    throw new TypeError('Ollama tool results require a matching tool name.');
                }
                return {role,tool_name:toolName,content};
            }

            return {role,content};
        });
        const requiredName=toolChoice?.function?.name;
        const instruction=requiredName
            ?`Call the ${requiredName} function now with concise values for every required field. Do not answer in prose.`
            :toolChoice==='none'
                ?'Do not call a function in this request. Follow the response instructions and answer in the requested format.'
                :'';

        if(!instruction){
            return sanitizedMessages;
        }
        const firstMessage=sanitizedMessages[0];

        if(firstMessage?.role==='system'){
            return [
                {
                    ...firstMessage,
                    content:`${firstMessage.content||''}\n\n${instruction}`
                },
                ...sanitizedMessages.slice(1)
            ];
        }

        return [
            {role:'system',content:instruction},
            ...sanitizedMessages
        ];
    }

    #structuredOutputFormat(value=false){
        if(value===false||value===null||value===undefined){
            return null;
        }
        if(value===true||value==='json'){
            return 'json';
        }
        if(
            typeof value==='object'
            &&!Array.isArray(value)
            &&(
                Object.getPrototypeOf(value)===Object.prototype
                ||Object.getPrototypeOf(value)===null
            )
        ){
            return value;
        }

        const error=new TypeError(
            'AI structured output must be enabled with true, json, or a JSON Schema object.'
        );
        error.code='AI_STRUCTURED_OUTPUT_INVALID';
        throw error;
    }

    #openAIResponseFormat(structuredOutputFormat){
        if(structuredOutputFormat==='json'){
            return {type:'json_object'};
        }
        if(structuredOutputFormat){
            return {
                type:'json_schema',
                json_schema:{
                    name:'structured_response',
                    strict:true,
                    schema:structuredOutputFormat
                }
            };
        }
        return null;
    }

    async #reportRequest(requestHandler,request,id){
        if(typeof requestHandler!=='function'){
            throw new TypeError('AI onRequest callback must be a function.');
        }
        await requestHandler(request,id);
    }

    #providerStreamEmissions(chunk,seeThinking){
        const chunks=[];
        const toolNames=[];
        const choices=Array.isArray(chunk?.choices)?chunk.choices:[];
        for(const choice of choices){
            const delta=choice?.delta||{};
            if(seeThinking&&typeof delta.reasoning_content==='string'){
                chunks.push({text:delta.reasoning_content,thinking:true});
            }
            if(typeof delta.content==='string'){
                chunks.push({text:delta.content,thinking:false});
            }
            for(const call of Array.isArray(delta.tool_calls)?delta.tool_calls:[]){
                const name=call?.function?.name;
                if(typeof name==='string'&&name){
                    toolNames.push(name);
                }
            }
        }
        if(!choices.length){
            if(seeThinking&&typeof chunk?.thinking==='string'){
                chunks.push({text:chunk.thinking,thinking:true});
            }
            const text=typeof chunk?.text==='string'
                ?chunk.text
                :typeof chunk?.content==='string'
                    ?chunk.content
                    :'';
            if(text){
                chunks.push({text,thinking:false});
            }
            const calls=Array.isArray(chunk?.toolCalls)
                ?chunk.toolCalls
                :Array.isArray(chunk?.tool_calls)
                    ?chunk.tool_calls
                    :[];
            for(const call of calls){
                const name=call?.function?.name||call?.name;
                if(typeof name==='string'&&name){
                    toolNames.push(name);
                }
            }
        }
        return {chunks,toolNames};
    }

    #providerCompletionOutput(completion){
        if(typeof completion==='string'){
            return completion;
        }
        const toolRecord={};
        let toolCount=0;
        for(const choice of Array.isArray(completion?.choices)?completion.choices:[]){
            for(const call of Array.isArray(choice?.message?.tool_calls)
                ?choice.message.tool_calls
                :[]){
                const name=call?.function?.name;
                if(typeof name==='string'&&name){
                    toolRecord[name]=call.function.arguments;
                    toolCount+=1;
                }
            }
        }
        if(toolCount){
            return toolRecord;
        }
        const content=completion?.choices?.[0]?.message?.content;
        return typeof content==='string'?content:completion;
    }

    #requestLegacyLLMChat(payload={},signal=null){
        return this.#fetchLegacy(
            payload.messages??[],
            function ignoreLegacyLLMProviderResponse(){},
            payload.structuredOutput??false,
            payload.tools??[],
            payload.toolChoice??'auto',
            payload.parallelToolCalls??true,
            payload.id??Date.now(),
            function ignoreLegacyLLMProviderRequest(){},
            signal
        );
    }

    #requestLegacyLLMStream(payload={},bridge){
        function emitLegacyLLMStreamText(text,id,thinking){
            if(typeof text!=='string'||!text){
                return;
            }
            bridge.emit(
                thinking
                    ?{thinking:text}
                    :{content:text}
            );
        }

        function emitLegacyLLMStreamTool(name){
            if(typeof name==='string'&&name){
                bridge.emit({toolCalls:[{name}]});
            }
        }

        return this.#streamLegacyMessage(
            payload.messages??[],
            emitLegacyLLMStreamText,
            function ignoreLegacyLLMProviderCompletion(){},
            payload.tools??[],
            payload.toolChoice??'auto',
            emitLegacyLLMStreamTool,
            payload.parallelToolCalls??true,
            payload.id??Date.now(),
            payload.seeThinking??false,
            bridge.signal,
            function ignoreLegacyLLMProviderRequest(){},
            payload.structuredOutput??false,
            false
        );
    }

    #assertRequiredOllamaToolCall(toolCalls=[],toolChoice='auto'){
        const requiredName=toolChoice?.function?.name;

        if(!requiredName){
            return;
        }

        const called=toolCalls.some(function isRequiredOllamaToolCall(call){
            return call?.function?.name===requiredName;
        });

        if(!called){
            const error=new Error(`Local AI did not call the required "${requiredName}" tool.`);
            error.code='AI_REQUIRED_TOOL_CALL_MISSING';
            throw error;
        }
    }

    #openAICompatibleOllamaResponse(response={},id=Date.now()){
        const message=response?.message||{};
        const toolCalls=Array.isArray(message.tool_calls)
            ?message.tool_calls.map(
                function normalizeOllamaToolCall(call,index){
                    return {
                        id:call?.id||`call-${id}-${index}`,
                        type:'function',
                        function:{
                            name:call?.function?.name||'',
                            arguments:typeof call?.function?.arguments==='string'
                                ?call.function.arguments
                                :JSON.stringify(call?.function?.arguments||{})
                        }
                    };
                }
            )
            :[];

        return {
            id:response?.id||`ollama-${id}`,
            object:'chat.completion',
            created:Math.floor(Date.now()/1000),
            model:response?.model||this.model,
            choices:[
                {
                    index:0,
                    message:{
                        role:message.role||'assistant',
                        content:message.content||'',
                        ...(toolCalls.length?{tool_calls:toolCalls}:{})
                    },
                    finish_reason:response?.done_reason
                        ||(toolCalls.length?'tool_calls':'stop')
                }
            ],
            usage:{
                prompt_tokens:Number(response?.prompt_eval_count)||0,
                completion_tokens:Number(response?.eval_count)||0,
                total_tokens:(Number(response?.prompt_eval_count)||0)
                    +(Number(response?.eval_count)||0)
            }
        };
    }


    async streamRequest({
        messages=[],
        structuredOutput=false,
        localOnly=false,
        onChunk=function ignoreStreamChunk(){},
        onComplete=function finishIgnoredStream(){},
        tools=[],
        toolChoice='auto',
        onToolCall=function ignoreEarlyFunction(){},
        onRequest=function ignoreStreamRequest(){},
        parallelToolCalls=true,
        id=Date.now(),
        seeThinking=false,
        signal=null
    }={}){
        if(localOnly!==true&&localOnly!==false){
            throw new TypeError('AI localOnly must be a boolean.');
        }
        if(localOnly&&!this.#hasLocalRoute('llm',this.llmService)){
            const error=new Error(
                'This AI request requires a configured local model.'
            );
            error.code='AI_LOCAL_MODEL_REQUIRED';
            throw error;
        }
        if(this.#shouldUseProviderRuntime('llm',this.llmService,localOnly)){
            const request={
                messages,
                structuredOutput,
                tools,
                toolChoice,
                parallelToolCalls,
                id,
                seeThinking
            };
            const displayId=`M-${id}`;
            const announcedTools=new Set();
            let handle=null;
            try{
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                await this.#reportRequest(onRequest,request,id);
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                handle=await this.#providerRuntime.request(
                    'llm',
                    {
                        operation:'stream',
                        payload:request,
                        localOnly,
                        signal
                    }
                );
                for await(const chunk of handle){
                    if(signal?.aborted){
                        throw normalizeAIRequestAbort();
                    }
                    const emissions=this.#providerStreamEmissions(chunk,seeThinking);
                    for(const emission of emissions.chunks){
                        if(signal?.aborted){
                            throw normalizeAIRequestAbort();
                        }
                        await onChunk(
                            emission.text,
                            displayId,
                            emission.thinking
                        );
                        if(signal?.aborted){
                            throw normalizeAIRequestAbort();
                        }
                    }
                    for(const name of emissions.toolNames){
                        if(signal?.aborted){
                            throw normalizeAIRequestAbort();
                        }
                        if(!announcedTools.has(name)){
                            announcedTools.add(name);
                            await onToolCall(name);
                            if(signal?.aborted){
                                throw normalizeAIRequestAbort();
                            }
                        }
                    }
                }
                const completion=await handle.result;
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                for(const choice of Array.isArray(completion?.choices)
                    ?completion.choices
                    :[]){
                    for(const call of Array.isArray(choice?.message?.tool_calls)
                        ?choice.message.tool_calls
                        :[]){
                        const name=call?.function?.name;
                        if(typeof name==='string'&&name&&!announcedTools.has(name)){
                            if(signal?.aborted){
                                throw normalizeAIRequestAbort();
                            }
                            announcedTools.add(name);
                            await onToolCall(name);
                            if(signal?.aborted){
                                throw normalizeAIRequestAbort();
                            }
                        }
                    }
                }
                const result=this.#providerCompletionOutput(completion);
                await onComplete(result,displayId,false);
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                this.finishTTS();
                return result;
            }catch(error){
                if(handle){
                    await handle.cancel(error).catch(
                        function retainProviderStreamCleanupFailure() {}
                    );
                }
                this.stopAudio();
                throw isAIRequestAbort(error,signal)
                    ?normalizeAIRequestAbort(error)
                    :error;
            }
        }

        return this.streamMessage(
            messages,
            onChunk,
            onComplete,
            tools,
            toolChoice,
            onToolCall,
            parallelToolCalls,
            id,
            seeThinking,
            signal,
            onRequest,
            structuredOutput
        );
    }

    async streamMessage(
        messages=[],
        streamHandler=function ignoreStreamChunk(){},
        streamComplete=function finishIgnoredStream(){},
        tools=[],
        tool_choice='auto',
        earlyFunctionTrigger=function ignoreEarlyFunction(){},
        parallel_tool_calls=true,
        id=Date.now(),
        seeThinking=false,
        signal=null,
        requestHandler=function ignoreStreamRequest(){},
        structuredOutput=false
    ){
        if(this.#shouldUseProviderRuntime('llm',this.llmService,false)){
            return this.streamRequest({
                messages,
                structuredOutput,
                localOnly:false,
                onChunk:streamHandler,
                onComplete:streamComplete,
                tools,
                toolChoice:tool_choice,
                onToolCall:earlyFunctionTrigger,
                onRequest:requestHandler,
                parallelToolCalls:parallel_tool_calls,
                id,
                seeThinking,
                signal
            });
        }

        return this.#streamLegacyMessage(
            messages,
            streamHandler,
            streamComplete,
            tools,
            tool_choice,
            earlyFunctionTrigger,
            parallel_tool_calls,
            id,
            seeThinking,
            signal,
            requestHandler,
            structuredOutput
        );
    }

    async #streamLegacyMessage(
        messages=[],
        streamHandler=function ignoreStreamChunk(){},
        streamComplete=function finishIgnoredStream(){},
        tools=[],
        tool_choice='auto',
        earlyFunctionTrigger=function ignoreEarlyFunction(){},
        parallel_tool_calls=true,
        id=Date.now(),
        seeThinking=false,
        signal=null,
        requestHandler=function ignoreStreamRequest(){},
        structuredOutput=false,
        finishSpeech=true
    ){
        let speechTurnCompleted=false;

        try{
            this.#assertServiceConfigured(this.llmService);
            if(signal&&(
                typeof signal.aborted!=='boolean'
                ||typeof signal.addEventListener!=='function'
            )){
                throw new TypeError('AI request signal must be an AbortSignal.');
            }
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            const structuredOutputFormat=this.#structuredOutputFormat(
                structuredOutput
            );

        const request={
            model:this.model,
            messages:messages, 
            stream:true
        }

        if(structuredOutputFormat){
            request.response_format=this.#openAIResponseFormat(
                structuredOutputFormat
            );
        }

        if(tools.length){
            request.tools=tools;
            request.tool_choice=tool_choice;
            request.parallel_tool_calls=parallel_tool_calls;
        }

        if(this.llmService==='OLLAMA'&&this.reasoningEffort){
            request.reasoning_effort=this.reasoningEffort;
        }

        let isThinking=true;
        let isWaiting=true;

        streamHandler('Thinking...',`M-${id}`,isThinking);

        const nativeOllama=this.#nativeOllama();

        if(this.llmService==='OLLAMA'&&!nativeOllama){
            throw legacyAIProviderError(
                'Local AI requires the capability-gated Arcane API.',
                'AI_NATIVE_LOCAL_REQUIRED'
            );
        }

        if(nativeOllama){
            let nativeContent='';
            const nativeToolCalls={};
            const triggeredTools=new Set();
            const ollamaTools=this.#ollamaTools(tools,tool_choice);
            const ollamaMessages=this.#ollamaMessages(messages,tool_choice);
            const ollamaRequest={
                model:this.model,
                messages:ollamaMessages,
                stream:true,
                ...(this.reasoningEffort?{think:this.reasoningEffort}:{}),
                ...(structuredOutputFormat?{format:structuredOutputFormat}:{}),
                ...(ollamaTools.length?{tools:ollamaTools}:{})
            };

            function reportEarlyFunctionFailure(error){
                console.error('Early tool trigger failed.');
            }

            function receiveNativeToolCalls(message={}){
                const calls=Array.isArray(message.tool_calls)?message.tool_calls:[];

                if(calls.length){
                    isThinking=false;
                }

                for(const call of calls){
                    const name=call?.function?.name;

                    if(!name){
                        continue;
                    }

                    nativeToolCalls[name]=typeof call.function.arguments==='string'
                        ?call.function.arguments
                        :JSON.stringify(call.function.arguments||{});

                    if(!triggeredTools.has(name)){
                        triggeredTools.add(name);
                        Promise.resolve(earlyFunctionTrigger(name)).catch(
                            reportEarlyFunctionFailure
                        );
                    }
                }
            }

            await this.#reportRequest(requestHandler,ollamaRequest,id,{
                operation:'stream',
                transport:'native',
                destination:'Arcane.ollama.chat'
            });
            const nativeResponse=await nativeOllama.chat(
                ollamaRequest,
                {
                    onChunk:function receiveNativeOllamaChunk(chunk){
                        if(signal?.aborted){
                            return;
                        }
                        const message=chunk?.message||{};
                        const thinking=seeThinking
                            ?String(message.thinking||'')
                            :'';
                        const content=String(message.content||'');

                        if(thinking){
                            streamHandler(thinking,`M-${id}`,true);
                        }

                        if(content){
                            isThinking=false;
                            nativeContent+=content;
                            streamHandler(content,`M-${id}`,false);
                        }

                        receiveNativeToolCalls(message);
                    },
                    signal
                }
            );
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            receiveNativeToolCalls(nativeResponse?.message);
            this.#assertRequiredOllamaToolCall(
                Object.keys(nativeToolCalls).map(function createToolCallName(name){
                    return {function:{name}};
                }),
                tool_choice
            );

            const nativeResult=Object.keys(nativeToolCalls).length
                ?nativeToolCalls
                :nativeContent;
            if(Object.keys(nativeToolCalls).length&&!nativeContent){
                streamHandler('',`M-${id}`,false);
            }
            if(finishSpeech){
                this.finishTTS();
            }
            await streamComplete(nativeResult,`M-${id}`,isThinking);
            speechTurnCompleted=true;
            return nativeResult;
        }

        await this.#reportRequest(requestHandler,request,id,{
            operation:'stream',
            transport:'http',
            destination:this.url
        });
        const body = JSON.stringify(request);
        let response;

        try{
            response=await fetch(
                this.url,
                {
                    method:'POST',
                    credentials,
                    headers:this.#serviceHeaders[this.llmService],
                    body,
                    ...(signal?{signal}:{})
                }
            );
        }catch(err){
            if(signal?.aborted||err?.name==='AbortError'){
                const error=new Error('The AI request was cancelled.',{cause:err});
                error.name='AbortError';
                error.code='ARCANE_AI_REQUEST_ABORTED';
                throw error;
            }
            const error=new Error(
                'Unable to reach the AI service.',
                {cause:err}
            );
            error.code='AI_SERVICE_UNREACHABLE';
            throw error;
        }

        await this.#assertResponseOK(response);

        let chunkString='';
        let chunkCache='';
        const streamedToolCalls=new Map();
        const triggeredTools=new Set();
        const decoder = new TextDecoder('utf-8');
        //alert(1)
        const reader=response.body?.getReader?.();

        if(!reader){
            throw new TypeError('Streaming response body is not readable');
        }

        function receiveStreamedToolCalls(toolCalls=[]){
            for(let position=0;position<toolCalls.length;position++){
                const toolCall=toolCalls[position]||{};
                const toolFunction=toolCall.function||{};
                const key=Number.isInteger(toolCall.index)
                    ?`index:${toolCall.index}`
                    :toolCall.id
                        ?`id:${toolCall.id}`
                        :`position:${position}`;
                const record=streamedToolCalls.get(key)||{
                    arguments:'',
                    name:'',
                    order:streamedToolCalls.size
                };

                if(toolFunction.name){
                    record.name=toolFunction.name;
                    if(!triggeredTools.has(record.name)){
                        triggeredTools.add(record.name);
                        Promise.resolve(
                            earlyFunctionTrigger(record.name)
                        ).catch(
                            ()=>console.error('Early tool trigger failed.')
                        );
                    }
                }

                if(typeof toolFunction.arguments==='string'){
                    record.arguments+=toolFunction.arguments;
                }else if(toolFunction.arguments&&typeof toolFunction.arguments==='object'){
                    record.arguments+=JSON.stringify(toolFunction.arguments);
                }

                streamedToolCalls.set(key,record);
            }
        }

        try{
            while(true){
                const {done,value:chunk}=await reader.read();

                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }

                if(done){
                    break;
                }

                //alert(2)    //const data=String.fromCharCode.apply(null, chunk).trim().replaceAll('data: ','');
                const data = decoder.decode(chunk, { stream: true})?.trim()?.replaceAll('data: ','');
                const lines=data.split('\n\n');
                //alert(3)
                //console.log(lines);

                lines.forEach(
                    function parsingAIGeneratedStream(delta,i){
                        chunkCache+=delta;

                        if (chunkCache.trim() === '[DONE]') {
                            chunkCache = '';
                            return;
                        }

                        try{
                            const resp=JSON.parse(chunkCache)||{};
                            //console.log(JSON.stringify(resp));
                            //console.log(resp)
                            const choice = resp.choices?.[0] || {};
                            const delta = choice.delta || {};
                            const content = delta.content || '';
                            const tool_calls=delta.tool_calls || [];
                            let value = content;

                            let reasoning = '';

                            if(seeThinking){
                                reasoning=delta.reasoning || '';
                            }

                            if (reasoning) {
                                isThinking = true;
                                value = reasoning;
                            }

                            if (!reasoning && isThinking) {
                                //remove thinking chunks
                                chunkString='';
                            }

                            if (!reasoning) {
                                isThinking = false;
                            }

                            chunkCache='';

                            if(value==='' && !tool_calls.length){
                                return;
                            }

                            if(value){
                                streamHandler(value,`M-${id}`, isThinking);
                                chunkString+=value;
                            }

                            if(tool_calls.length){
                                receiveStreamedToolCalls(tool_calls);
                            }
                        } catch(err) {
                            console.warn('AI stream callback failed.');
                        }
                    }
                );
            }
        }catch(error){
            if(isAIRequestAbort(error,signal)){
                throw normalizeAIRequestAbort(error);
            }
            throw error;
        }finally{
            reader.releaseLock();
        }

        const tool_funcs={};
        const orderedToolCalls=[...streamedToolCalls.values()].sort(
            function sortStreamedToolCalls(a,b){
                return a.order-b.order;
            }
        );

        for(const toolCall of orderedToolCalls){
            if(!toolCall.name){
                throw new Error('AI stream returned a tool call without a name.');
            }

            if(Object.hasOwn(tool_funcs,toolCall.name)){
                throw new Error(`AI stream returned duplicate tool ${toolCall.name}.`);
            }

            tool_funcs[toolCall.name]=toolCall.arguments;
        }

        const streamResult=Object.keys(tool_funcs).length
            ?tool_funcs
            :chunkString;
        if(Object.keys(tool_funcs).length&&!chunkString){
            streamHandler('',`M-${id}`,false);
        }
        if(finishSpeech){
            this.finishTTS();
        }
        await streamComplete(streamResult, `M-${id}`,isThinking);

        //sync
        speechTurnCompleted=true;
        return streamResult;
        }catch(error){
            if(isAIRequestAbort(error,signal)){
                throw normalizeAIRequestAbort(error);
            }
            throw error;
        }finally{
            if(!speechTurnCompleted){
                this.stopAudio();
            }
        }
    }

    async fetchRequest({
        messages=[],
        structuredOutput=false,
        localOnly=false,
        tools=[],
        toolChoice='auto',
        parallelToolCalls=true,
        id=Date.now(),
        signal=null,
        onRequest=function ignoreFetchRequest(){},
        onResponse=function ignoreFetchResponse(){}
    }={}){
        if(localOnly!==true&&localOnly!==false){
            throw new TypeError('AI localOnly must be a boolean.');
        }
        if(localOnly&&!this.#hasLocalRoute('llm',this.llmService)){
            const error=new Error(
                'This AI request requires a configured local model.'
            );
            error.code='AI_LOCAL_MODEL_REQUIRED';
            throw error;
        }
        if(this.#shouldUseProviderRuntime('llm',this.llmService,localOnly)){
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            const request={
                messages,
                structuredOutput,
                tools,
                toolChoice,
                parallelToolCalls,
                id
            };
            await this.#reportRequest(onRequest,request,id);
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            const response=await this.#providerRuntime.request(
                'llm',
                {
                    operation:'chat',
                    payload:request,
                    localOnly,
                    signal
                }
            );
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            await onResponse(response,id,false);
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            return response;
        }

        return this.fetch(
            messages,
            onResponse,
            structuredOutput,
            tools,
            toolChoice,
            parallelToolCalls,
            id,
            onRequest,
            signal
        );
    }

    async fetch(
        messages=[],
        responseHandler=function ignoreFetchResponse(){},
        structuredOutput=false,
        tools=[],
        tool_choice='auto',
        parallel_tool_calls=true,
        id=Date.now(),
        requestHandler=function ignoreFetchRequest(){},
        signal=null,
    ){
        if(this.#shouldUseProviderRuntime('llm',this.llmService,false)){
            return this.fetchRequest({
                messages,
                structuredOutput,
                localOnly:false,
                tools,
                toolChoice:tool_choice,
                parallelToolCalls:parallel_tool_calls,
                id,
                signal,
                onRequest:requestHandler,
                onResponse:responseHandler
            });
        }

        return this.#fetchLegacy(
            messages,
            responseHandler,
            structuredOutput,
            tools,
            tool_choice,
            parallel_tool_calls,
            id,
            requestHandler,
            signal
        );
    }

    async #fetchLegacy(
        messages=[],
        responseHandler=function ignoreFetchResponse(){},
        structuredOutput=false,
        tools=[],
        tool_choice='auto',
        parallel_tool_calls=true,
        id=Date.now(),
        requestHandler=function ignoreFetchRequest(){},
        signal=null,
    ){
        this.#assertServiceConfigured(this.llmService);
        if(signal&&(
            typeof signal.aborted!=='boolean'
            ||typeof signal.addEventListener!=='function'
        )){
            throw new TypeError('AI request signal must be an AbortSignal.');
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort();
        }
        const structuredOutputFormat=this.#structuredOutputFormat(structuredOutput);

        const request={
            model:this.model,
            messages:messages, 
            stream:false
        }

        if(structuredOutputFormat){
            request.response_format=this.#openAIResponseFormat(
                structuredOutputFormat
            );
        }

        if(tools.length){
            request.tools=tools;
            request.tool_choice=tool_choice;
            request.parallel_tool_calls=parallel_tool_calls;
        }

        if(this.llmService==='OLLAMA'&&this.reasoningEffort){
            request.reasoning_effort=this.reasoningEffort;
        }

        const nativeOllama=this.#nativeOllama();

        if(this.llmService==='OLLAMA'&&!nativeOllama){
            throw legacyAIProviderError(
                'Local AI requires the capability-gated Arcane API.',
                'AI_NATIVE_LOCAL_REQUIRED'
            );
        }

        if(nativeOllama){
            const ollamaTools=this.#ollamaTools(tools,tool_choice);
            const ollamaMessages=this.#ollamaMessages(messages,tool_choice);
            const nativeRequest={
                model:this.model,
                messages:ollamaMessages,
                stream:false,
                ...(this.reasoningEffort?{think:this.reasoningEffort}:{}),
                ...(structuredOutputFormat?{format:structuredOutputFormat}:{}),
                ...(ollamaTools.length?{tools:ollamaTools}:{})
            };
            await this.#reportRequest(requestHandler,nativeRequest,id,{
                operation:'fetch',
                transport:'native',
                destination:'Arcane.ollama.chat'
            });
            let nativeResponse;
            try{
                nativeResponse=await nativeOllama.chat(
                    nativeRequest,
                    {signal}
                );
            }catch(error){
                if(isAIRequestAbort(error,signal)){
                    throw normalizeAIRequestAbort(error);
                }
                throw error;
            }
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            this.#assertRequiredOllamaToolCall(
                Array.isArray(nativeResponse?.message?.tool_calls)
                    ?nativeResponse.message.tool_calls
                    :[],
                tool_choice
            );
            const responseJSON=this.#openAICompatibleOllamaResponse(
                nativeResponse,
                id
            );

            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            await responseHandler(responseJSON,id,false);
            return responseJSON;
        }

        await this.#reportRequest(requestHandler,request,id,{
            operation:'fetch',
            transport:'http',
            destination:this.url
        });
        const body = JSON.stringify(request);
        
        let response;
                
        try{
            response = await fetch(
                this.url, 
                {
                    method: 'POST',
                    credentials: credentials,
                    headers: this.#serviceHeaders[this.llmService],
                    body: body,
                    ...(signal?{signal}:{})
                }
            );
        }catch(err){
            if(isAIRequestAbort(err,signal)){
                throw normalizeAIRequestAbort(err);
            }
            const error=new Error(
                'Unable to reach the AI service.',
                {cause:err}
            );
            error.code='AI_SERVICE_UNREACHABLE';
            throw error;
        }

        await this.#assertResponseOK(response);

        const contentType=response.headers.get('content-type')||'';

        if(!contentType.includes('application/json')){
            throw new TypeError(
                `AI request returned ${contentType||'an unknown content type'} instead of JSON.`
            );
        }

        let responseJSON;
        try{
            responseJSON=await response.json();
        }catch(error){
            if(isAIRequestAbort(error,signal)){
                throw normalizeAIRequestAbort(error);
            }
            throw error;
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort();
        }

        if(!response.id){
            response.id=id;
        }

        //console.log(responseJSON);
        //async
        await responseHandler(responseJSON,id,false);
        //sync
        return responseJSON;
    }

    streamTTS(
        text='',
        end=false
    ){
        if(this.muted){
            if(end){
                this.audioMessageChunks='';
            }
            return Promise.resolve(false);
        }

        this.audioMessageChunks+=String(text||'');
        const outputs=this.#extractSpeechSegments(end);

        if(!outputs.length){
            return Promise.resolve(true);
        }

        try{
            this.#assertServiceConfigured(this.ttsService,'tts');
        }catch(error){
            console.warn('AI speech provider is unavailable.');
            return Promise.resolve(false);
        }

        const generation=this.speechGeneration;
        const jobs=[];

        for(const output of outputs){
            jobs.push(this.#queueSpeechJob(output,generation));
        }

        return Promise.all(jobs).then(
            function reportQueuedSpeechResult(results){
                return results.every(Boolean);
            }
        );
    }

    finishTTS(){
        return this.streamTTS('',true);
    }

    #extractSpeechSegments(end=false){
        const segments=[];
        const maximumLength=220;
        let remainder=this.audioMessageChunks;

        while(remainder.trim()){
            const terminator=this.#findSpeechTerminator(remainder,end);
            let boundary=terminator
                ?terminator.index+terminator[0].length
                :-1;

            if(boundary<0&&remainder.length>=maximumLength){
                const candidate=remainder.slice(0,maximumLength+1);
                const whitespace=candidate.lastIndexOf(' ');
                boundary=whitespace>=80?whitespace+1:maximumLength;
            }else if(boundary<0&&end){
                boundary=remainder.length;
            }

            if(boundary<0){
                break;
            }

            const segment=remainder.slice(0,boundary).trim();
            remainder=remainder.slice(boundary).trimStart();

            if(segment){
                segments.push(segment);
            }
        }

        this.audioMessageChunks=remainder;
        return segments;
    }

    #findSpeechTerminator(text,end=false){
        const pattern=end
            ?/(?:[\u3002\uFF01\uFF1F]|[.!?](?=\s|$))/g
            :/(?:[\u3002\uFF01\uFF1F]|[.!?](?=\s+\S))/g;
        let terminator;

        while((terminator=pattern.exec(text))){
            if(
                terminator[0]==='.'
                &&this.#isSpeechAbbreviation(text,terminator.index)
            ){
                continue;
            }

            return terminator;
        }

        return null;
    }

    #isSpeechAbbreviation(text,periodIndex){
        const beforePeriod=text.slice(0,periodIndex);
        const token=beforePeriod.match(/([A-Za-z][A-Za-z.]*)$/)?.[1]?.toLowerCase();

        if(!token){
            const currentLine=beforePeriod.slice(beforePeriod.lastIndexOf('\n')+1);
            return /^\s*\d+$/.test(currentLine);
        }

        if(token.length===1||/^(?:[a-z]\.)+[a-z]$/.test(token)){
            return true;
        }

        return this.#speechAbbreviations.has(token);
    }

    #queueSpeechJob(text,generation){
        const job={
            abortController:null,
            generation,
            sourceNode:null,
            state:'queued',
            text
        };
        const runtime=this;
        const previous=this.speechSynthesisTail;

        this.speechJobs.push(job);

        const synthesis=previous.then(
            function synthesizeQueuedSpeech(){
                return runtime.#prepareSpeechJob(job);
            }
        ).catch(
            function discardFailedSpeechJob(error){
                return runtime.#failSpeechJob(job,error);
            }
        );

        this.speechSynthesisTail=synthesis.then(
            function releaseSpeechSynthesisSlot(){
                return undefined;
            }
        );

        return synthesis;
    }

    async #prepareSpeechJob(job){
        if(job.generation!==this.speechGeneration||this.muted){
            return this.#cancelSpeechJob(job);
        }

        job.state='synthesizing';
        const audio=await this.#requestSpeechAudio(job);

        if(job.generation!==this.speechGeneration||this.muted){
            return this.#cancelSpeechJob(job);
        }

        const audioContext=this.#getSpeechAudioContext();
        return this.playAudio(
            audio.chunks,
            audioContext,
            null,
            audio.type,
            job
        );
    }

    async #requestSpeechAudio(job){
        job.abortController=new AbortController();
        const selection=this.#providerRuntime.selection('tts');
        const voice=selection?this.#providerSpeechVoice():null;
        const response=await this.fetchTTS(
            {
                model:selection?.modelId||this.modelTTS,
                input:job.text,
                ...(voice?{voice}:{}),
                responseFormat:selection
                    ?this.#providerSpeechResponseFormat()
                    :this.audioFormat,
                speed:this.voiceSpeed
            },
            job.abortController.signal
        );
        return this.#normalizeProviderSpeechAudio(response);
    }

    #providerSpeechVoice(){
        const selection=this.#providerRuntime.selection('tts');
        if(!selection){
            return null;
        }
        const provider=this.#providerRuntime.catalog('tts').find(
            entry=>entry.providerId===selection.providerId
        );
        const model=provider?.models.find(entry=>entry?.id===selection.modelId);
        return typeof model?.defaultVoice==='string'&&model.defaultVoice.trim()
            ?model.defaultVoice.trim()
            :null;
    }

    #providerSpeechResponseFormat(){
        const selection=this.#providerRuntime.selection('tts');
        if(!selection){
            return this.audioFormat;
        }
        const provider=this.#providerRuntime.catalog('tts').find(
            entry=>entry.providerId===selection.providerId
        );
        const model=provider?.models.find(entry=>entry?.id===selection.modelId);
        const speech=model?.speech;
        if(speech===undefined){
            return this.audioFormat;
        }
        const prototype=speech&&typeof speech==='object'
            ?Object.getPrototypeOf(speech)
            :null;
        const descriptors=prototype===Object.prototype||prototype===null
            ?Object.getOwnPropertyDescriptors(speech)
            :null;
        const formats=descriptors?.responseFormats?.value;
        const defaultFormat=descriptors?.defaultResponseFormat?.value;
        if(!Array.isArray(formats)
            ||formats.length<1
            ||!formats.every(format=>typeof format==='string'&&format.trim()===format&&format)
            ||typeof defaultFormat!=='string'
            ||!formats.includes(defaultFormat)){
            throw legacyAIProviderError(
                'The selected TTS provider returned an invalid speech format catalog.',
                'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
            );
        }
        if(formats.includes(this.audioFormat)){
            return this.audioFormat;
        }
        if(this.audioFormat===LEGACY_TTS_RESPONSE_FORMAT){
            return defaultFormat;
        }
        throw legacyAIProviderError(
            `The selected TTS provider does not support ${this.audioFormat}.`,
            'ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT'
        );
    }

    async #normalizeProviderSpeechAudio(response){
        if(response instanceof Blob){
            return {
                chunks:[new Uint8Array(await response.arrayBuffer())],
                type:response.type||this.audioType
            };
        }

        if(response instanceof ArrayBuffer||ArrayBuffer.isView(response)){
            const bytes=response instanceof ArrayBuffer
                ?new Uint8Array(response)
                :new Uint8Array(
                    response.buffer,
                    response.byteOffset,
                    response.byteLength
                );
            return {
                chunks:[bytes],
                type:this.audioType
            };
        }

        if(response&&typeof response==='object'){
            if(typeof response.audioBase64==='string'){
                return {
                    chunks:[this.#base64ToBytes(response.audioBase64)],
                    type:typeof response.contentType==='string'
                        ?response.contentType
                        :this.audioType
                };
            }
            if(response.audio instanceof Blob){
                return {
                    chunks:[new Uint8Array(await response.audio.arrayBuffer())],
                    type:response.audio.type
                        ||response.contentType
                        ||this.audioType
                };
            }
            if(response.audio instanceof ArrayBuffer
                ||ArrayBuffer.isView(response.audio)){
                const bytes=response.audio instanceof ArrayBuffer
                    ?new Uint8Array(response.audio)
                    :new Uint8Array(
                        response.audio.buffer,
                        response.audio.byteOffset,
                        response.audio.byteLength
                    );
                return {
                    chunks:[bytes],
                    type:typeof response.contentType==='string'
                        ?response.contentType
                        :this.audioType
                };
            }
        }

        const error=new TypeError(
            'The selected TTS provider returned invalid playable audio.'
        );
        error.code='ARCANE_AI_TTS_PROVIDER_AUDIO_INVALID';
        throw error;
    }

    async #normalizeProviderSpeechBlob(response){
        if(response instanceof Blob){
            return response;
        }
        const normalized=await this.#normalizeProviderSpeechAudio(response);
        return new Blob(normalized.chunks,{type:normalized.type||this.audioType});
    }

    #getSpeechAudioContext(){
        if(this.audioContext&&this.audioContext.state!=='closed'){
            return this.audioContext;
        }

        const AudioContext=window.AudioContext||window.webkitAudioContext;

        if(typeof AudioContext!=='function'){
            throw new TypeError('Audio playback is unavailable in this browser.');
        }

        this.audioContext=new AudioContext();
        return this.audioContext;
    }

    async fetchTTS(payload={},signal=null){
        this.#assertServiceConfigured(this.ttsService,'tts');
        if(!payload
            ||typeof payload!=='object'
            ||Array.isArray(payload)
            ||![Object.prototype,null].includes(Object.getPrototypeOf(payload))){
            const error=new TypeError('AI.fetchTTS requires a speech request object.');
            error.code='ARCANE_AI_TTS_REQUEST_INVALID';
            throw error;
        }
        const descriptors=Object.getOwnPropertyDescriptors(payload);
        const acceptedKeys=new Set([
            'model',
            'voice',
            'input',
            'responseFormat',
            'speed'
        ]);
        for(const key of Reflect.ownKeys(descriptors)){
            if(typeof key==='symbol'
                ||!acceptedKeys.has(key)
                ||!Object.hasOwn(descriptors[key],'value')){
                const error=new TypeError(
                    'AI.fetchTTS accepts only model, voice, input, responseFormat, and speed data properties.'
                );
                error.code='ARCANE_AI_TTS_REQUEST_INVALID';
                throw error;
            }
        }
        if(signal&&(
            typeof signal.aborted!=='boolean'
            ||typeof signal.addEventListener!=='function'
            ||typeof signal.removeEventListener!=='function'
        )){
            const error=new TypeError('AI.fetchTTS signal must be an AbortSignal.');
            error.code='ARCANE_AI_TTS_SIGNAL_INVALID';
            throw error;
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }

        const input=descriptors.input?.value;
        if(typeof input!=='string'||!input.trim()){
            const error=new TypeError('AI.fetchTTS input must be nonempty text.');
            error.code='ARCANE_AI_TTS_INPUT_INVALID';
            throw error;
        }
        const selection=this.#providerRuntime.selection('tts');
        const requestedModel=descriptors.model?.value;
        if(requestedModel!==undefined
            &&(typeof requestedModel!=='string'
                ||requestedModel.trim()!==requestedModel
                ||!requestedModel)){
            const error=new TypeError(
                'AI.fetchTTS model must be a nonempty trimmed string when provided.'
            );
            error.code='ARCANE_AI_TTS_MODEL_INVALID';
            throw error;
        }
        const model=requestedModel
            ||selection?.modelId
            ||this.modelTTS
            ||'';
        if(!model){
            const error=new TypeError('AI.fetchTTS model must be selected explicitly.');
            error.code='ARCANE_AI_TTS_MODEL_REQUIRED';
            throw error;
        }
        if(selection&&model!==selection.modelId){
            const error=new TypeError(
                'AI.fetchTTS model must match the admitted TTS route.'
            );
            error.code='ARCANE_AI_TTS_MODEL_SELECTION_MISMATCH';
            throw error;
        }
        const requestedVoice=descriptors.voice?.value;
        if(requestedVoice!==undefined
            &&(typeof requestedVoice!=='string'
                ||requestedVoice.trim()!==requestedVoice
                ||!requestedVoice)){
            const error=new TypeError(
                'AI.fetchTTS voice must be a nonempty trimmed string when provided.'
            );
            error.code='ARCANE_AI_TTS_VOICE_INVALID';
            throw error;
        }
        const voice=requestedVoice
            ?requestedVoice
            :selection
                ?this.#providerSpeechVoice()
                :this.#legacySpeechDefaultVoice('tts',this.ttsService);
        if(!voice){
            const error=new TypeError(
                'AI.fetchTTS requires a caller- or model-catalog-admitted voice.'
            );
            error.code='ARCANE_AI_TTS_VOICE_REQUIRED';
            throw error;
        }
        const requestedResponseFormat=descriptors.responseFormat?.value;
        if(requestedResponseFormat!==undefined
            &&(typeof requestedResponseFormat!=='string'
                ||requestedResponseFormat.trim()!==requestedResponseFormat
                ||!requestedResponseFormat)){
            const error=new TypeError(
                'AI.fetchTTS responseFormat must be a nonempty trimmed string when provided.'
            );
            error.code='ARCANE_AI_TTS_RESPONSE_FORMAT_INVALID';
            throw error;
        }
        const responseFormat=requestedResponseFormat
            ||(selection?this.#providerSpeechResponseFormat():this.audioFormat)
            ||'';
        if(!responseFormat){
            const error=new TypeError('AI.fetchTTS responseFormat must be nonempty.');
            error.code='ARCANE_AI_TTS_RESPONSE_FORMAT_INVALID';
            throw error;
        }
        const speed=descriptors.speed
            ?Number(descriptors.speed.value)
            :this.voiceSpeed;
        if(!Number.isFinite(speed)||speed<=0){
            const error=new RangeError('AI.fetchTTS speed must be a positive number.');
            error.code='ARCANE_AI_TTS_SPEED_INVALID';
            throw error;
        }

        if(selection){
            const response=await this.#providerRuntime.request(
                'tts',
                {
                    operation:'synthesize',
                    payload:{model,voice,input,responseFormat,speed},
                    localOnly:false,
                    signal
                }
            );
            if(signal?.aborted)throw normalizeAIRequestAbort(signal.reason);
            const audio=await this.#normalizeProviderSpeechBlob(response);
            if(signal?.aborted)throw normalizeAIRequestAbort(signal.reason);
            return audio;
        }

        return this.#requestLegacySpeechSynthesis(
            {model,voice,input,responseFormat,speed},
            signal
        );
    }

    async fetchSTT(
        audioFile,
        responseHandler=(text='')=>{},
        signal=null
    ){
        this.#assertServiceConfigured(this.sttService,'stt');
        if(typeof responseHandler!=='function'){
            const error=new TypeError('AI.fetchSTT responseHandler must be a function.');
            error.code='ARCANE_AI_STT_RESPONSE_HANDLER_INVALID';
            throw error;
        }
        if(signal&&(
            typeof signal.aborted!=='boolean'
            ||typeof signal.addEventListener!=='function'
            ||typeof signal.removeEventListener!=='function'
        )){
            const error=new TypeError('AI.fetchSTT signal must be an AbortSignal.');
            error.code='ARCANE_AI_STT_SIGNAL_INVALID';
            throw error;
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }

        if(this.#usesProviderRuntime('stt',this.sttService)){
            const response=await this.#providerRuntime.request(
                'stt',
                {
                    operation:'transcribe',
                    payload:{
                        audio:audioFile,
                        mimeType:typeof Blob==='function'
                            &&audioFile instanceof Blob
                            ?String(audioFile.type||'audio/webm')
                            :'audio/webm',
                        model:this.#providerRuntime.selection('stt')?.modelId
                    },
                    localOnly:false,
                    signal
                }
            );
            const text=typeof response==='string'
                ?response
                :response?.text;
            if(typeof text!=='string'){
                const error=new TypeError(
                    'Arcane returned an invalid provider speech transcription.'
                );
                error.code='ARCANE_AI_STT_PROVIDER_TRANSCRIPT_INVALID';
                throw error;
            }
            if(signal?.aborted)throw normalizeAIRequestAbort(signal.reason);
            await responseHandler(text);
            if(signal?.aborted)throw normalizeAIRequestAbort(signal.reason);
            return text;
        }

        const text=await this.#requestLegacySpeechTranscription(
            {
                audio:audioFile,
                mimeType:String(audioFile?.type||'audio/webm'),
                model:this.modelSTT
            },
            signal
        );
        if(signal?.aborted)throw normalizeAIRequestAbort(signal.reason);
        await responseHandler(text);
        if(signal?.aborted)throw normalizeAIRequestAbort(signal.reason);
        return text;
    }

    stopAudio(){
        this.speechGeneration+=1;
        this.speechResumeAttempt+=1;
        this.speechResumePending=false;
        this.audioMessageChunks='';
        this.#clearSpeechUnlock();

        for(const job of this.speechJobs){
            job.abortController?.abort();
            job.state='cancelled';

            if(job.sourceNode){
                job.sourceNode.onended=null;
            }
        }

        for(const sourceNode of this.sourceNodes){
            sourceNode.onended=null;

            if(sourceNode.__arcaneStarted){
                try{
                    sourceNode.stop();
                }catch(error){
                    console.warn('AI audio could not be stopped cleanly.');
                }
            }

            sourceNode.disconnect?.();
        }

        this.speechJobs.splice(0);
        this.sourceNodes.splice(0);
        this.currentSpeechJob=null;
        this.isSpeaking=false;
        return true;
    }

    async resumeAudio(audioContext=null,fromUserGesture=true){
        if(this.muted){
            return false;
        }

        if(fromUserGesture){
            this.#clearSpeechUnlock();
        }

        let attempt=0;
        let context;

        try{
            context=audioContext||this.#getSpeechAudioContext();

            if(context.state==='running'){
                this.#clearSpeechUnlock();
                this.#requestSpeechPlayback();
                return true;
            }

            if(typeof context.resume!=='function'){
                this.#waitForSpeechGesture();
                return false;
            }

            attempt=++this.speechResumeAttempt;
            this.speechResumePending=true;
            await context.resume();

            if(attempt!==this.speechResumeAttempt){
                return context.state==='running';
            }

            this.speechResumePending=false;

            if(context.state==='running'){
                this.#clearSpeechUnlock();
                this.#requestSpeechPlayback();
                return true;
            }
        }catch(error){
            if(attempt&&attempt!==this.speechResumeAttempt){
                return context?.state==='running';
            }

            if(attempt===this.speechResumeAttempt){
                this.speechResumePending=false;
            }
            this.#waitForSpeechGesture(error);
            return false;
        }

        this.#waitForSpeechGesture();
        return false;
    }

    async playAudio(
        audioChunks=[],
        audioContext=this.#getSpeechAudioContext(),
        sourceNode=null,
        audioType=this.audioType,
        speechJob=null
    ){
        const job=speechJob||{
            abortController:null,
            generation:this.speechGeneration,
            sourceNode:null,
            state:'decoding',
            text:''
        };

        if(!speechJob){
            this.speechJobs.push(job);
        }

        if(this.muted||job.generation!==this.speechGeneration){
            return this.#cancelSpeechJob(job);
        }

        try{
            job.state='decoding';
            const audioBlob=new Blob(audioChunks,{type:audioType});
            const arrayBuffer=await audioBlob.arrayBuffer();
            const audioBuffer=await audioContext.decodeAudioData(arrayBuffer);

            if(this.muted||job.generation!==this.speechGeneration){
                return this.#cancelSpeechJob(job);
            }

            const preparedSource=sourceNode||audioContext.createBufferSource();
            const runtime=this;

            preparedSource.buffer=audioBuffer;
            preparedSource.connect(audioContext.destination);
            preparedSource.__arcaneStarted=false;
            preparedSource.onended=function finishQueuedSpeechSource(){
                runtime.nextSentance(job);
            };
            job.sourceNode=preparedSource;
            job.state='ready';
            this.sourceNodes.push(preparedSource);
            this.#requestSpeechPlayback();
            return true;
        }catch(error){
            return this.#failSpeechJob(job,error);
        }
    }

    #requestSpeechPlayback(){
        this.#pumpSpeechPlayback().catch(
            function reportSpeechPlaybackFailure(error){
                console.warn('AI audio playback failed.');
            }
        );
    }

    async #pumpSpeechPlayback(){
        if(this.speechPlaybackStarting||this.isSpeaking||this.muted){
            return false;
        }

        this.speechPlaybackStarting=true;

        try{
            while(!this.isSpeaking&&!this.muted){
                const job=this.speechJobs[0];

                if(!job){
                    return false;
                }

                if(job.generation!==this.speechGeneration||['cancelled','failed'].includes(job.state)){
                    this.#removeSpeechJob(job);
                    continue;
                }

                if(job.state!=='ready'||!job.sourceNode?.buffer){
                    return false;
                }

                const audioContext=this.#getSpeechAudioContext();

                if(audioContext.state!=='running'){
                    this.#waitForSpeechGesture();

                    if(!this.speechResumePending){
                        this.resumeAudio(audioContext,false);
                    }

                    return false;
                }

                if(
                    this.muted
                    ||job!==this.speechJobs[0]
                    ||job.generation!==this.speechGeneration
                    ||job.state!=='ready'
                ){
                    continue;
                }

                try{
                    job.state='playing';
                    job.sourceNode.__arcaneStarted=true;
                    this.currentSpeechJob=job;
                    this.isSpeaking=true;
                    job.sourceNode.start(0);
                    return true;
                }catch(error){
                    this.currentSpeechJob=null;
                    this.isSpeaking=false;
                    this.#failSpeechJob(job,error);
                }
            }
        }finally{
            this.speechPlaybackStarting=false;

            if(
                !this.isSpeaking
                &&!this.muted
                &&!this.speechAwaitingGesture
                &&!this.speechResumePending
                &&this.speechJobs[0]?.state==='ready'
            ){
                this.#requestSpeechPlayback();
            }
        }

        return false;
    }

    nextSentance(job=this.currentSpeechJob){
        if(!job||job.generation!==this.speechGeneration){
            return false;
        }

        if(job.sourceNode){
            job.sourceNode.onended=null;
        }

        job.state='complete';
        this.#removeSpeechJob(job);

        if(this.currentSpeechJob===job){
            this.currentSpeechJob=null;
            this.isSpeaking=false;
        }

        this.#requestSpeechPlayback();
        return true;
    }

    #cancelSpeechJob(job){
        job.abortController?.abort();
        job.state='cancelled';
        this.#removeSpeechJob(job);
        return false;
    }

    #failSpeechJob(job,error){
        if(job.state==='failed'||job.state==='cancelled'){
            return false;
        }

        job.state='failed';

        if(job.sourceNode){
            job.sourceNode.onended=null;
        }

        this.#removeSpeechJob(job);

        if(this.currentSpeechJob===job){
            this.currentSpeechJob=null;
            this.isSpeaking=false;
        }

        if(job.generation===this.speechGeneration&&error?.name!=='AbortError'){
            console.warn('AI speech synthesis failed.');
        }

        this.#requestSpeechPlayback();
        return false;
    }

    #removeSpeechJob(job){
        const jobIndex=this.speechJobs.indexOf(job);

        if(jobIndex>=0){
            this.speechJobs.splice(jobIndex,1);
        }

        const sourceIndex=this.sourceNodes.indexOf(job.sourceNode);

        if(sourceIndex>=0){
            this.sourceNodes.splice(sourceIndex,1);
        }

        job.sourceNode?.disconnect?.();
    }

    #waitForSpeechGesture(error=null){
        if(this.speechUnlockHandler){
            return false;
        }

        const runtime=this;
        const target=window;

        this.speechAwaitingGesture=true;
        this.speechUnlockHandler=function unlockSpeechFromUserGesture(){
            runtime.#clearSpeechUnlock();
            runtime.resumeAudio();
        };

        target.addEventListener?.(
            'pointerdown',
            this.speechUnlockHandler,
            {capture:true,once:true}
        );
        target.addEventListener?.(
            'keydown',
            this.speechUnlockHandler,
            {capture:true,once:true}
        );

        if(error?.name&&error.name!=='NotAllowedError'){
            console.info('AI speech is waiting for audio playback permission.');
        }

        return true;
    }

    #clearSpeechUnlock(){
        if(this.speechUnlockHandler){
            window.removeEventListener?.(
                'pointerdown',
                this.speechUnlockHandler,
                true
            );
            window.removeEventListener?.(
                'keydown',
                this.speechUnlockHandler,
                true
            );
        }

        this.speechUnlockHandler=null;
        this.speechAwaitingGesture=false;
    }
}

installAIUserReadyRegistration();

function installAIUserReadyRegistration(){
    if(window.user?.ready){
        instantiateAI();
        return null;
    }

    const existingDescriptor=Object.getOwnPropertyDescriptor(
        globalThis,
        AI_USER_READY_REGISTRATION_KEY
    );
    if(existingDescriptor){
        const existing=Object.hasOwn(existingDescriptor,'value')
            ?existingDescriptor.value
            :null;
        if(existing?.protocol!==AI_USER_READY_REGISTRATION_PROTOCOL
            ||typeof existing.dispose!=='function'){
            throw aiInitializationError(
                AI_INITIALIZATION_ERROR_CODES.userReadyRegistrationCollision,
                AI_INITIALIZATION_REASONS.userReadyRegistrationCollision,
                'The AI user-readiness registration collides with an incompatible realm owner.'
            );
        }
        return existing;
    }

    let registration;
    let unsubscribe=null;
    function disposeAIUserReadyRegistration(){
        unsubscribe?.();
        unsubscribe=null;
        const descriptor=Object.getOwnPropertyDescriptor(
            globalThis,
            AI_USER_READY_REGISTRATION_KEY
        );
        if(descriptor?.value===registration){
            delete globalThis[AI_USER_READY_REGISTRATION_KEY];
        }
    }
    registration=Object.freeze({
        protocol:AI_USER_READY_REGISTRATION_PROTOCOL,
        dispose:disposeAIUserReadyRegistration
    });
    unsubscribe=arcaneEvents.subscribe(
        'user-entity-loaded',
        function initializeAIFromCanonicalUser(event){
            if(event?.detail?.user&&event.detail.user!==window.user)return;
            if(!window.user?.ready)return;
            registration.dispose();
            instantiateAI(event);
        }
    );
    Object.defineProperty(
        globalThis,
        AI_USER_READY_REGISTRATION_KEY,
        {
            value:registration,
            configurable:true,
            enumerable:false,
            writable:false
        }
    );
    return registration;
}

function instantiateAI(event) {
    if(
        event?.detail?.user
        &&event.detail.user!==window.user
    ){
        return;
    }

    if(!window.user?.ready){
        return;
    }

    if(!window.ai){
        const preferences=getAIPreferencesForRuntime(window.user);

        window.ai=new AI(
            preferences[0],
            preferences[1],
            preferences[2],
            preferences[3],
            preferences[4],
            preferences[5]
        );

        window.ai.ready=true;

        window.ai[AI_PUBLISH_READY]();

    }
}

export default AI;
