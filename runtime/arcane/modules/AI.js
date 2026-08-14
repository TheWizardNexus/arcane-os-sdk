import './DBOPFS.js';
import UserEntity from '../entities/User.js';
import {getAIPreferencesForRuntime} from './AIPreferenceRuntime.js';
import {normalizeOllamaModelIdentifier} from './OllamaModelIdentifier.js';

let credentials='include';
credentials='omit';

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
    muted=false;
    

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

        this.setAI(
            llmService || 'OPENAI',
            sttService || 'OPENAI',
            ttsService || 'OPENAI',
            model || 'OPENAI',
            modelTTS || 'OPENAI',
            modelSTT || 'OPENAI'
        );
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
        if(this.llmService==='OLLAMA'){
            return Boolean(this.model)&&Boolean(this.#nativeOllama());
        }

        return this.llmService==='OPENAI'
            &&Boolean(this.model)
            &&Boolean(this.license);
    }

    #assertServiceConfigured(service=this.llmService){
        if(service==='OLLAMA'){
            if(this.#nativeOllama()){
                return true;
            }

            const error=new Error(
                'Local AI requires the capability-gated Arcane API.'
            );
            error.code='AI_NATIVE_LOCAL_REQUIRED';
            throw error;
        }
        if(service&&service!=='OPENAI'){
            return true;
        }

        if(service==='OPENAI'&&this.license){
            return true;
        }

        const error=new Error('AI provider is not configured.');
        error.code='AI_PROVIDER_NOT_CONFIGURED';
        throw error;
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

        this.llmService=llmService;
        this.sttService=sttService;
        this.ttsService=ttsService;
        if(llmService==='OLLAMA'){
            const mappedModel=model==='OPENAI'?null:this.#models[model];
            this.model=mappedModel||normalizeOllamaModelIdentifier(model)||'';

            if(!this.model){
                const error=new TypeError('The Ollama model preference is invalid.');
                error.code='AI_MODEL_INVALID';
                throw error;
            }
        }else if(llmService==='OPENAI'){
            this.model=this.#models.OPENAI;
        }else{
            this.model='';
        }
        this.modelTTS=this.#ttsModels[modelTTS];
        this.modelTTS=this.#ttsModels[modelTTS];
        this.modelSTT=this.#sttModels[modelSTT];
        this.reasoningEffort='';

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

    #nativeSpeech(service){
        const client=globalThis.Arcane?.speech;

        return service==='LOCAL_SPEACH'
            &&typeof client?.synthesize==='function'
            &&typeof client?.transcribe==='function'
            ?client
            :null;
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
        const selectedTools=requiredName
            ?tools.filter(function isRequiredOllamaTool(tool){
                return tool?.function?.name===requiredName;
            })
            :tools;

        if(requiredName&&selectedTools.length!==1){
            const error=new Error(`Required AI tool "${requiredName}" is not available.`);
            error.code='AI_REQUIRED_TOOL_UNAVAILABLE';
            throw error;
        }

        return selectedTools;
    }

    #ollamaMessages(messages=[],toolChoice='auto'){
        const sanitizedMessages=messages.map(function sanitizeOllamaMessage(message){
            return {
                role:String(message?.role??''),
                content:String(message?.content??'')
            };
        });
        const requiredName=toolChoice?.function?.name;

        if(!requiredName){
            return sanitizedMessages;
        }

        const instruction=`Call the ${requiredName} function now with concise values for every required field. Do not answer in prose.`;
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


    async streamMessage(
        messages=[],
        streamHandler=function ignoreStreamChunk(){},
        streamComplete=function finishIgnoredStream(){},
        tools=[],
        tool_choice='auto',
        earlyFunctionTrigger=function ignoreEarlyFunction(){},
        parallel_tool_calls=true,
        id=Date.now(),
        seeThinking=false
    ){
        let speechTurnCompleted=false;

        try{
            this.#assertServiceConfigured(this.llmService);

        const request={
            model:this.model,
            messages:messages, 
            stream:true
        }

        if(tools.length){
            request.tools=tools;
            request.tool_choice=tool_choice;
            request.parallel_tool_calls=parallel_tool_calls;
        }

        if(this.llmService==='OLLAMA'&&this.reasoningEffort){
            request.reasoning_effort=this.reasoningEffort;
        }

        const body = JSON.stringify(request);

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
                ...(ollamaTools.length?{tools:ollamaTools}:{})
            };

            function reportEarlyFunctionFailure(error){
                console.error('Early tool trigger failed:',error);
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

            const nativeResponse=await nativeOllama.chat(
                ollamaRequest,
                {
                    onChunk:function receiveNativeOllamaChunk(chunk){
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
                    }
                }
            );
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

        let response;

        try{
            response=await fetch(
                this.url,
                {
                    method:'POST',
                    credentials,
                    headers:this.#serviceHeaders[this.llmService],
                    body
                }
            );
        }catch(err){
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
                            error=>console.error('Early tool trigger failed:',error)
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
                            console.warn(err);
                        }
                    }
                );
            }
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
        }finally{
            if(!speechTurnCompleted){
                this.stopAudio();
            }
        }
    }

    async fetch(
        messages=[],
        responseHandler=function ignoreFetchResponse(){},
        json=false,
        tools=[],
        tool_choice='auto',
        parallel_tool_calls=true,
        id=Date.now(),
    ){
        this.#assertServiceConfigured(this.llmService);

        const request={
            model:this.model,
            messages:messages, 
            stream:false
        }

        if(json){
            request.response_format={ type: "json_object" };
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
            const nativeResponse=await nativeOllama.chat({
                model:this.model,
                messages:ollamaMessages,
                stream:false,
                ...(this.reasoningEffort?{think:this.reasoningEffort}:{}),
                ...(json&&!ollamaTools.length?{format:'json'}:{}),
                ...(ollamaTools.length?{tools:ollamaTools}:{})
            });
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

            await responseHandler(responseJSON,id,false);
            return responseJSON;
        }

        const body = JSON.stringify(request);
        
        let response;
                
        try{
            response = await fetch(
                this.url, 
                {
                    method: 'POST',
                    credentials: credentials,
                    headers: this.#serviceHeaders[this.llmService],
                    body: body
                }
            );
        }catch(err){
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

        const responseJSON=await response.json();

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
            this.#assertServiceConfigured(this.ttsService);
        }catch(error){
            console.warn('Error preparing speech from AI:',error);
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
        const nativeSpeech=this.#nativeSpeech(this.ttsService);

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
        responseHandler=(text='')=>{}
    ){
        this.#assertServiceConfigured(this.sttService);

        const nativeSpeech=this.#nativeSpeech(this.sttService);

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
                body: formData
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
                    console.warn('Error stopping AI audio:',error);
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
                console.warn('Error playing audio data:',error);
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
            console.warn('Error preparing audio from AI:',error);
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
            console.info('AI speech is waiting for audio playback permission:',error);
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
