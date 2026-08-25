import './DBOPFS.js';
import UserEntity from '../entities/User.js';
import {getAIPreferencesForRuntime} from './AIPreferenceRuntime.js';
import {getAIProviderRuntime} from './AIProviderRuntime.js';
import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

let credentials='include';
credentials='omit';

const LEGACY_AI_SERVICES=new Set(['OPENAI','OLLAMA','LOCAL_SPEACH']);

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

function normalizeAIStartupOptions(options){
    if(options===undefined){
        return Object.freeze({startMuted:true,signal:null});
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
        if(typeof key==='symbol'||(key!=='startMuted'&&key!=='signal')){
            throw new TypeError('AI startup options contain an unknown option.');
        }
        if(!Object.hasOwn(descriptors[key],'value')){
            throw new TypeError(`AI startup options.${key} must be a data property.`);
        }
    }
    const startMuted=Object.hasOwn(descriptors,'startMuted')
        ?descriptors.startMuted.value
        :true;
    const signal=Object.hasOwn(descriptors,'signal')
        ?descriptors.signal.value
        :null;
    if(typeof startMuted!=='boolean'){
        throw new TypeError('AI startup startMuted must be a boolean.');
    }
    if(signal!==null&&signal!==undefined&&(
        typeof signal!=='object'
        ||typeof signal.aborted!=='boolean'
        ||typeof signal.addEventListener!=='function'
        ||typeof signal.removeEventListener!=='function'
    )){
        throw new TypeError('AI startup signal must be an AbortSignal.');
    }
    return Object.freeze({startMuted,signal});
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
    }

    #providerRuntime=getAIProviderRuntime();
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
        return this.#license;
    }

    get configured(){
        if(this.#usesProviderRuntime('llm',this.llmService)){
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

    #applyPreferenceTuple(tuple){
        const [
            llmService,
            sttService,
            ttsService,
            model,
            modelTTS,
            modelSTT
        ]=tuple;
        let normalizedLLMModel=model;
        if(llmService==='OLLAMA'){
            const mappedModel=model==='OPENAI'?null:this.#models[model];
            normalizedLLMModel=mappedModel
                ||normalizeOllamaModelIdentifier(model)
                ||model;
        }else if(llmService==='OPENAI'){
            normalizedLLMModel=this.#models.OPENAI;
        }
        this.llmService=llmService;
        this.sttService=sttService;
        this.ttsService=ttsService;
        this.model=normalizedLLMModel;
        this.modelTTS=this.#ttsModels[modelTTS]||modelTTS;
        this.modelSTT=this.#sttModels[modelSTT]||modelSTT;
        this.reasoningEffort='';
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

    #routesFromPreferenceTuple(tuple){
        const roles={
            llm:[tuple[0],tuple[3]],
            stt:[tuple[1],tuple[5]],
            tts:[tuple[2],tuple[4]]
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
        this.#providerRuntime.configure(this.#routesFromPreferenceTuple(tuple));
        this.#applyPreferenceTuple(tuple);
        return true;
    }

    configureProviders(selections){
        this.#assertRegisteredLegacyRoutes(selections);
        const configured=this.#providerRuntime.configure(selections);
        this.#applyPreferenceTuple(this.#tupleFromProviderRoutes(configured));
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
        this.stopAudio();
        await this.#unloadProviderRolesForTransition();
        this.#providerRuntime.configure(this.#routesFromPreferenceTuple(tuple));
        this.#applyPreferenceTuple(tuple);
        return this.#providerRuntime.status();
    }

    async transitionProviders(selections){
        this.#assertRegisteredLegacyRoutes(selections);
        const prepared=this.#providerRuntime.validateConfiguration(selections);
        this.stopAudio();
        await this.#unloadProviderRolesForTransition();
        const configured=this.#providerRuntime.configure(prepared);
        this.#applyPreferenceTuple(this.#tupleFromProviderRoutes(configured));
        return configured;
    }

    async startProviders(options){
        const normalized=normalizeAIStartupOptions(options);
        this.muted=normalized.startMuted;
        if(normalized.startMuted){
            this.stopAudio();
        }
        return this.#providerRuntime.start(normalized);
    }

    async setSpeechMuted(muted){
        if(typeof muted!=='boolean'){
            throw new TypeError('AI speech muted state must be a boolean.');
        }
        this.muted=muted;
        if(muted){
            this.stopAudio();
        }
        if(!this.#usesProviderRuntime('tts',this.ttsService)){
            return true;
        }
        await this.#providerRuntime.setSpeechMuted(muted);
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
            this.finishTTS();
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
        this.finishTTS();
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
        if(this.#usesProviderRuntime('tts',this.ttsService)){
            job.abortController=new AbortController();
            const response=await this.#providerRuntime.request(
                'tts',
                {
                    operation:'synthesize',
                    payload:{
                        model:this.#providerRuntime.selection('tts')?.modelId,
                        voice:String(window.user?.AI_voice||'af_heart'),
                        input:job.text,
                        responseFormat:this.audioFormat,
                        speed:this.voiceSpeed
                    },
                    localOnly:false,
                    signal:job.abortController.signal
                }
            );
            return this.#normalizeProviderSpeechAudio(response);
        }

        const nativeSpeech=this.#nativeSpeech(this.ttsService,'tts');

        if(nativeSpeech){
            const response=await nativeSpeech.synthesize({
                model:this.modelTTS,
                voice:String(window.user?.AI_voice||'af_heart'),
                input:job.text,
                responseFormat:this.audioFormat,
                speed:this.voiceSpeed
            });

            if(!response||typeof response.audioBase64!=='string'){
                throw new TypeError('Arcane returned an invalid local speech response.');
            }

            return {
                chunks:[this.#base64ToBytes(response.audioBase64)],
                type:typeof response.contentType==='string'
                    ?response.contentType
                    :this.audioType
            };
        }

        await this.#assertAndroidSpeechBridge(this.ttsService);

        job.abortController=new AbortController();
        const personality=await window.user?.personality
            ||'A behavioral health technician with a slight veteran feel on occasion.';
        const religion=await window.user?.religion||'caring';
        const request={
            model:this.modelTTS,
            voice:window.user?.AI_voice,
            input:job.text,
            speed:this.voiceSpeed,
            instructions:`${personality} and sounding a bit ${religion}`,
            response_format:this.audioFormat
        };
        const response=await fetch(
            this.urlTTS,
            {
                method:'POST',
                credentials,
                headers:this.#ttsHeaders[this.ttsService],
                body:JSON.stringify(request),
                signal:job.abortController.signal
            }
        );

        if(!response.ok){
            throw new Error(`Speech synthesis failed with status ${response.status}.`);
        }

        const reader=response.body?.getReader?.();

        if(!reader){
            throw new TypeError('Speech synthesis response body is not readable.');
        }

        const chunks=[];

        try{
            while(true){
                const {done,value}=await reader.read();

                if(done){
                    break;
                }

                if(value){
                    chunks.push(value);
                }
            }
        }finally{
            reader.releaseLock?.();
        }

        return {chunks,type:this.audioType};
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

        throw new TypeError('Arcane returned an invalid provider speech response.');
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

    async fetchSTT(
        audioFile,
        responseHandler=(text='')=>{},
        signal=null
    ){
        this.#assertServiceConfigured(this.sttService,'stt');
        if(signal&&(
            typeof signal.aborted!=='boolean'
            ||typeof signal.addEventListener!=='function'
        )){
            throw new TypeError('AI request signal must be an AbortSignal.');
        }
        if(signal?.aborted){
            throw normalizeAIRequestAbort();
        }

        if(this.#usesProviderRuntime('stt',this.sttService)){
            if(!audioFile||typeof audioFile.arrayBuffer!=='function'){
                throw new TypeError('Speech transcription requires an audio Blob or File.');
            }
            const response=await this.#providerRuntime.request(
                'stt',
                {
                    operation:'transcribe',
                    payload:{
                        audio:audioFile,
                        mimeType:String(audioFile.type||'audio/webm'),
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
                throw new TypeError(
                    'Arcane returned an invalid provider speech transcription.'
                );
            }
            await responseHandler(text);
            return text;
        }

        const nativeSpeech=this.#nativeSpeech(this.sttService,'stt');

        if(nativeSpeech){
            if(!audioFile||typeof audioFile.arrayBuffer!=='function'){
                throw new TypeError('Speech transcription requires an audio Blob or File.');
            }

            const response=await nativeSpeech.transcribe({
                audioBase64:this.#arrayBufferToBase64(await audioFile.arrayBuffer()),
                mimeType:String(audioFile.type||'audio/webm'),
                model:this.modelSTT
            });

            if(!response||typeof response.text!=='string'){
                throw new TypeError('Arcane returned an invalid local speech transcription.');
            }

            await responseHandler(response.text);
            return response.text;
        }

        await this.#assertAndroidSpeechBridge(this.sttService);

        const formData = new FormData();
        formData.append('file', audioFile);
        formData.append('model', this.modelSTT);
        formData.append('response_format', 'text');

        const response = await fetch(
            this.urlSTT, 
            {
                method: 'POST',
                credentials: credentials,
                headers: this.#sttHeaders[this.sttService],
                body: formData,
                signal
            }
        );

        if(!response.ok){
            throw new Error(`Speech transcription failed with status ${response.status}.`);
        }

        const text = await response.text();
        
        //async
        await responseHandler(text);

        //sync
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

window.addEventListener(
    'user-entity-loaded',
    instantiateAI
);

if(window.user?.ready){
    instantiateAI();
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

        const aiReady=new CustomEvent(
            'ai-ready', {
                detail: { db: window.ai }
            }
        );

        window.dispatchEvent(aiReady);

    }
}

export default AI;
