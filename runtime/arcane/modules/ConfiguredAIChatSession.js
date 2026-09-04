import {recurringChatMessages} from './ChatRecords.js';

const FORBIDDEN_REQUEST_FIELDS=new Set([
    'messages',
    'onChunk',
    'onDataChunk',
    'onDataResult',
    'onResponse',
    'onToolCall',
    'signal',
    'stream',
]);

function isPlainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function contentText(value,label,{optional=false}={}){
    if(typeof value!=='string') throw new TypeError(`${label} must be a string.`);
    if(!value.trim()){
        if(optional) return null;
        throw new TypeError(`${label} must contain text.`);
    }
    return value;
}

function optionalMetadata(value,label){
    if(value===undefined||value===null||value==='') return null;
    if(typeof value!=='string'){
        throw coded(new TypeError(`${label} must be a string when provided.`),'AI_CHAT_INVALID_RESPONSE');
    }
    if(!value.trim()) return null;
    return value;
}

function usageCount(value){
    return Number.isSafeInteger(value)&&value>=0?value:null;
}

function providerUsageCount(value,label){
    if(value===undefined) return null;
    if(!Number.isSafeInteger(value)||value<0){
        throw coded(
            new TypeError(`${label} must be a nonnegative integer when provided.`),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    return value;
}

function signalLike(value){
    return value===undefined||value===null||(
        typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function'
    );
}

function abortError(){
    const error=coded(new Error('The chat request was aborted.'),'AI_CHAT_ABORTED');
    error.name='AbortError';
    return error;
}

function assertMessageKeys(value,allowed,label){
    const unknown=Object.keys(value).find(key=>!allowed.has(key));
    if(unknown) throw new TypeError(`${label} contains an unsupported field: ${unknown}.`);
}

function toolCallArgumentMessage(value,label){
    if(typeof value!=='string'){
        throw new TypeError(`${label} must be a JSON string.`);
    }
    let argumentsRecord;
    try{
        argumentsRecord=JSON.parse(value);
    }catch(error){
        throw coded(
            new TypeError(`${label} must encode a JSON object.`,{cause:error}),
            'AI_CHAT_INVALID_TOOL_CALL',
        );
    }
    if(!isPlainRecord(argumentsRecord)){
        throw coded(
            new TypeError(`${label} must encode a JSON object.`),
            'AI_CHAT_INVALID_TOOL_CALL',
        );
    }
    if(typeof argumentsRecord.message!=='string'||!argumentsRecord.message.trim()){
        throw coded(
            new TypeError(`${label}.message must contain user-facing text.`),
            'AI_CHAT_TOOL_MESSAGE_REQUIRED',
        );
    }
    return argumentsRecord.message;
}

function requireToolMessageSchemas(value,label){
    if(value===undefined) return;
    if(!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
    for(let index=0;index<value.length;index++){
        const tool=value[index];
        const parameters=tool?.function?.parameters;
        const messageSchema=parameters?.properties?.message;
        if(
            !isPlainRecord(tool)
            ||tool.type!=='function'
            ||!isPlainRecord(tool.function)
            ||!isPlainRecord(parameters)
            ||parameters.type!=='object'
            ||!isPlainRecord(parameters.properties)
            ||!isPlainRecord(messageSchema)
            ||messageSchema.type!=='string'
            ||!Number.isInteger(messageSchema.minLength)
            ||messageSchema.minLength<1
            ||!Array.isArray(parameters.required)
            ||!parameters.required.includes('message')
        ){
            throw coded(
                new TypeError(
                    `${label}[${index}] must require a nonempty string parameters.properties.message.`
                ),
                'AI_CHAT_TOOL_MESSAGE_REQUIRED',
            );
        }
    }
}

function normalizeRequestOptions(value,label){
    if(value===undefined) return {};
    if(!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
    const forbidden=Object.keys(value).find(key=>FORBIDDEN_REQUEST_FIELDS.has(key));
    if(forbidden) throw new TypeError(`${label}.${forbidden} is managed by the chat session.`);
    requireToolMessageSchemas(value.tools,`${label}.tools`);
    for(const key of ['parallelToolCalls','parallel_tool_calls']){
        if(Object.hasOwn(value,key)&&typeof value[key]!=='boolean'){
            throw new TypeError(`${label}.${key} must be a boolean when provided.`);
        }
    }
    return {...value};
}

export function normalizeStructuralToolCall(call,label='Structural tool call'){
    try{
        if(!isPlainRecord(call)) throw new TypeError(`${label} must be a plain object.`);
        if(typeof call.id!=='string'||!call.id.trim()){
            throw new TypeError(`${label}.id must contain text.`);
        }
        if(call.type!=='function') throw new TypeError(`${label}.type must be function.`);
        if(!isPlainRecord(call.function)) throw new TypeError(`${label}.function must be a plain object.`);
        if(typeof call.function.name!=='string'||!call.function.name.trim()){
            throw new TypeError(`${label}.function.name must contain text.`);
        }
        toolCallArgumentMessage(call.function.arguments,`${label}.function.arguments`);
    }catch(error){
        throw coded(error,'AI_CHAT_INVALID_TOOL_CALL');
    }
    return {
        ...call,
        function:{
            ...call.function,
            arguments:call.function.arguments,
            name:call.function.name,
        },
        id:call.id,
        type:'function',
    };
}

function normalizeToolCalls(value,label){
    if(value===undefined) return null;
    if(!Array.isArray(value)){
        throw new TypeError(`${label} must be an array of structural tool calls.`);
    }
    const ids=new Set();
    return value.map((call,index)=>{
        const normalized=normalizeStructuralToolCall(call,`${label}[${index}]`);
        if(ids.has(normalized.id)){
            throw coded(
                new TypeError(`${label} contains a duplicate id.`),
                'AI_CHAT_INVALID_TOOL_CALL',
            );
        }
        ids.add(normalized.id);
        return normalized;
    });
}

function normalizeMessage(value,label,allowedRoles){
    if(!isPlainRecord(value)||!allowedRoles.has(value.role)){
        throw new TypeError(`${label} has an unsupported role.`);
    }
    const toolCalls=value.role==='assistant'
        ?normalizeToolCalls(value.tool_calls,`${label}.tool_calls`)
        :null;
    if(
        value.role==='assistant'
        &&Object.hasOwn(value,'reasoning_content')
        &&typeof value.reasoning_content!=='string'
    ){
        throw new TypeError(`${label}.reasoning_content must be a string when provided.`);
    }
    const hasReasoning=Boolean(
        value.role==='assistant'
        &&typeof value.reasoning_content==='string'
        &&value.reasoning_content.length
    );
    let content;
    if(value.role==='assistant'&&(toolCalls?.length||hasReasoning)){
        if(value.content===undefined||value.content===null||value.content==='') content='';
        else content=contentText(value.content,`${label}.content`);
    }else{
        content=contentText(value.content,`${label}.content`);
    }
    let toolCallId=null;
    if(value.role==='tool'){
        toolCallId=contentText(value.tool_call_id,`${label}.tool_call_id`);
    }
    const normalized={
        ...value,
        role:value.role,
        content,
        ...(value.role==='assistant'&&Object.hasOwn(value,'reasoning_content')
            ?{reasoning_content:value.reasoning_content}
            :{}),
        ...(toolCalls?{tool_calls:toolCalls}:{}),
        ...(toolCallId?{tool_call_id:toolCallId}:{}),
    };
    return normalized;
}

function cloneMessage(value){
    return {
        ...value,
        role:value.role,
        content:value.content,
        ...(Object.hasOwn(value,'reasoning_content')
            ?{reasoning_content:value.reasoning_content}
            :{}),
        ...(value.tool_calls?{
            tool_calls:value.tool_calls.map(call=>({
                ...call,
                function:{...call.function},
            }))
        }:{}),
        ...(value.tool_call_id?{tool_call_id:value.tool_call_id}:{}),
    };
}

function publicMessage(value){
    const copy=cloneMessage(value);
    if(copy.role==='tool'){
        delete copy.message;
        delete copy.name;
        delete copy.status;
    }
    delete copy.memory_excluded;
    delete copy.persistence_excluded;
    delete copy.persistence_message;
    delete copy.persistence_name;
    delete copy.persistence_status;
    delete copy.timestamp;
    delete copy.ui_hidden;
    return copy;
}

function normalizeInitialMessages(value){
    if(value===undefined) return [];
    if(!Array.isArray(value)) throw new TypeError('initialMessages must be an array.');
    const messages=value.map((item,index)=>normalizeMessage(
        item,
        `initialMessages[${index}]`,
        new Set(['assistant','tool','user']),
    ));
    pendingToolCallIds(messages,true);
    return messages;
}

function normalizeInputMessages(value){
    if(typeof value==='string'){
        return [normalizeMessage(
            {role:'user',content:value},
            'The user message',
            new Set(['user']),
        )];
    }
    if(Array.isArray(value)){
        if(!value.length){
            throw new TypeError('The request tool-result batch must not be empty.');
        }
        return value.map((item,index)=>normalizeMessage(
            item,
            `The request tool-result batch[${index}]`,
            new Set(['tool']),
        ));
    }
    return [normalizeMessage(
        value,
        'The request message',
        new Set(['tool','user']),
    )];
}

function message(role,content){
    return {role,content};
}

function snapshot(messages){
    return messages.map(cloneMessage);
}

function completeHistory(systemPrompt,conversation){
    return [
        ...(systemPrompt?[message('system',systemPrompt)]:[]),
        ...conversation.map(cloneMessage),
    ];
}

function matchingToolCallIndex(messages,id){
    for(let index=messages.length-1;index>=0;index--){
        if(messages[index].role==='assistant'&&messages[index].tool_calls?.some(call=>call.id===id)){
            return index;
        }
    }
    return -1;
}

function pendingToolCallIds(messages,validate=false){
    const pending=new Set();
    for(let index=0;index<messages.length;index++){
        const item=messages[index];
        if(item.role==='user'&&pending.size&&validate){
            throw coded(
                new TypeError(`Message ${index+1} starts a user turn before the pending tool result.`),
                'AI_CHAT_INCOHERENT_PERSISTENCE',
            );
        }
        if(item.role==='assistant'&&pending.size&&validate){
            throw coded(
                new TypeError(`Message ${index+1} precedes the pending tool result.`),
                'AI_CHAT_INCOHERENT_PERSISTENCE',
            );
        }
        if(item.role==='assistant'&&item.tool_calls){
            for(const call of item.tool_calls){
                if(pending.has(call.id)&&validate){
                    throw coded(
                        new TypeError(`Message ${index+1} repeats a pending assistant tool-call ID.`),
                        'AI_CHAT_INCOHERENT_PERSISTENCE',
                    );
                }
                pending.add(call.id);
            }
        }
        if(item.role==='tool'){
            if(!pending.has(item.tool_call_id)&&validate){
                throw coded(
                    new TypeError(`Message ${index+1} does not match the pending assistant tool call.`),
                    'AI_CHAT_INCOHERENT_PERSISTENCE',
                );
            }
            pending.delete(item.tool_call_id);
        }
    }
    return pending;
}

async function configuredArcaneChat(request){
    const api=globalThis.Arcane?.ai;
    if(typeof api?.chat!=='function'){
        throw coded(
            new Error('The configured Arcane AI chat capability is unavailable.'),
            'AI_CHAT_UNAVAILABLE',
        );
    }
    return api.chat(request);
}

function normalizeAssistantResponseMessage(value,{requireRole=false}={}){
    if(!isPlainRecord(value)){
        throw coded(
            new TypeError('The chat provider returned an invalid response.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    if((requireRole&&value.role!=='assistant')||(value.role!==undefined&&value.role!=='assistant')){
        throw coded(
            new TypeError('The chat provider response must contain an assistant message.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }

    let responseMessage;
    try{
        responseMessage=normalizeMessage(
            {...value,role:'assistant'},
            'The assistant message',
            new Set(['assistant']),
        );
    }catch(error){
        throw coded(error,'AI_CHAT_INVALID_RESPONSE');
    }
    return responseMessage;
}

function normalizeSessionResponse(response){
    const responseMessage=normalizeAssistantResponseMessage(response.message);

    return {
        provider:optionalMetadata(response.provider,'The provider name'),
        model:optionalMetadata(response.model,'The model name'),
        message:responseMessage,
        providerResponse:response,
        done:response.done===undefined?true:Boolean(response.done),
        doneReason:optionalMetadata(response.doneReason,'The completion reason'),
        promptEvalCount:usageCount(response.promptEvalCount),
        evalCount:usageCount(response.evalCount),
    };
}

function normalizeOpenAICompatibleResponse(response){
    if(!Array.isArray(response.choices)||response.choices.length===0){
        throw coded(
            new TypeError('The chat provider completion must contain at least one choice.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    let responseMessage=null;
    for(let index=0;index<response.choices.length;index++){
        const candidate=response.choices[index];
        if(!isPlainRecord(candidate)){
            throw coded(
                new TypeError('The chat provider completion contains an invalid choice.'),
                'AI_CHAT_INVALID_RESPONSE',
            );
        }
        const candidateMessage=normalizeAssistantResponseMessage(
            candidate.message,
            {requireRole:true},
        );
        if(index===0) responseMessage=candidateMessage;
    }
    const choice=response.choices[0];
    if(response.usage!==undefined&&response.usage!==null&&!isPlainRecord(response.usage)){
        throw coded(
            new TypeError('The chat provider completion usage must be a plain object when provided.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    const usage=response.usage??{};
    return {
        provider:optionalMetadata(response.provider,'The provider name'),
        model:optionalMetadata(response.model,'The model name'),
        message:responseMessage,
        providerResponse:response,
        done:true,
        doneReason:optionalMetadata(choice.finish_reason,'The completion reason'),
        promptEvalCount:providerUsageCount(
            usage.prompt_tokens,
            'The provider prompt token count',
        ),
        evalCount:providerUsageCount(
            usage.completion_tokens,
            'The provider completion token count',
        ),
    };
}

function normalizeResponse(response){
    if(!isPlainRecord(response)){
        throw coded(
            new TypeError('The chat provider returned an invalid response.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    const hasMessage=Object.hasOwn(response,'message');
    const hasChoices=Object.hasOwn(response,'choices');
    if(hasMessage&&hasChoices){
        throw coded(
            new TypeError('The chat provider response cannot mix message and choices envelopes.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    if(hasMessage){
        return normalizeSessionResponse(response);
    }
    return normalizeOpenAICompatibleResponse(response);
}

/**
 * Maintains complete ordinary visible recurring conversation content plus only
 * the active structural protocol required by a configured chat provider.
 *
 * This module performs no persistence, streaming, tool execution, rendering, or
 * provider selection. Applications own their prompt policy and may supply an
 * asynchronous contextBuilder that returns additional system text for each send.
 * The response-length preference is accepted without changing or shortening
 * the caller's prompt. A configured chat function may return either the normalized
 * session response or a non-stream OpenAI-compatible completion.
 */
export default class ConfiguredAIChatSession{
    #chat;
    #contextBuilder;
    #conversation=[];
    #pending=false;
    #request;
    #systemPrompt;

    constructor(options={}){
        if(!isPlainRecord(options)) throw new TypeError('Chat session options must be a plain object.');
        const allowedOptions=new Set([
            'chat',
            'contextBuilder',
            'initialMessages',
            'request',
            'responseLength',
            'systemPrompt',
        ]);
        const unsupported=Object.keys(options).find(key=>!allowedOptions.has(key));
        if(unsupported) throw new TypeError(`Unsupported chat session option: ${unsupported}`);

        const chat=options.chat===undefined?configuredArcaneChat:options.chat;
        const contextBuilder=options.contextBuilder??null;
        const request=normalizeRequestOptions(options.request,'request');
        if(typeof chat!=='function') throw new TypeError('chat must be a function.');
        if(contextBuilder!==null&&typeof contextBuilder!=='function'){
            throw new TypeError('contextBuilder must be a function when provided.');
        }
        const rawSystemPrompt=options.systemPrompt??'';
        const systemPrompt=contentText(
            rawSystemPrompt,
            'systemPrompt',
            {optional:true},
        );

        this.#chat=chat;
        this.#contextBuilder=contextBuilder;
        this.#request={...request};
        this.#systemPrompt=systemPrompt;
        const initialMessages=normalizeInitialMessages(options.initialMessages);
        this.#conversation=recurringChatMessages(
            initialMessages,
            {settleCompleteToolTail:true},
        );
    }

    history(){
        return snapshot([
            ...(this.#systemPrompt?[message('system',this.#systemPrompt)]:[]),
            ...this.#conversation,
        ]);
    }

    clear(){
        if(this.#pending){
            throw coded(new Error('The active chat request must finish before clearing the session.'),'AI_CHAT_BUSY');
        }
        this.#conversation=[];
        return this.history();
    }

    async #contextFor(input,signal){
        let context=null;
        if(this.#contextBuilder){
            const value=await this.#contextBuilder({
                input,
                history:this.history(),
                signal:signal??null,
            });
            if(value!==undefined&&value!==null){
                const raw=contentText(
                    value,
                    'The contextBuilder result',
                    {optional:true},
                );
                if(raw) context=raw;
            }
        }
        return context;
    }

    /** Prepares one transient bootstrap request whose assistant response alone may be committed. */
    async prepareOpening(input,options={}){
        if(!isPlainRecord(options)) throw new TypeError('Chat opening options must be a plain object.');
        const unsupported=Object.keys(options).find(key=>!['request','signal'].includes(key));
        if(unsupported) throw new TypeError(`Unsupported chat opening option: ${unsupported}`);
        if(!signalLike(options.signal)) throw new TypeError('signal must be an AbortSignal.');
        if(options.signal?.aborted) throw abortError();
        const turnRequest=normalizeRequestOptions(options.request,'request');
        const [normalizedInputMessage]=normalizeInputMessages(input);
        if(normalizedInputMessage.role!=='user'){
            throw new TypeError('The chat opening bootstrap must be a user message.');
        }
        const inputMessage=message('user',normalizedInputMessage.content);
        if(this.#pending){
            throw coded(new Error('A chat request is already active for this session.'),'AI_CHAT_BUSY');
        }
        if(this.#conversation.length){
            throw coded(
                new Error('The chat already contains a retained conversation turn.'),
                'AI_CHAT_OPENING_EXISTS',
            );
        }
        this.#pending=true;
        try{
            const context=await this.#contextFor(inputMessage.content,options.signal);
            if(options.signal?.aborted) throw abortError();
            const transientContext=context
                ?message('user',context)
                :null;
            const requestMessages=completeHistory(
                this.#systemPrompt,
                [...(transientContext?[transientContext]:[]),inputMessage],
            );
            let providerResponse;
            try{
                providerResponse=await this.#chat({
                    ...this.#request,
                    ...turnRequest,
                    ...(options.signal?{signal:options.signal}:{}),
                    messages:requestMessages.map(publicMessage),
                });
            }catch(error){
                if(options.signal?.aborted) throw abortError();
                throw error;
            }
            const response=normalizeResponse(providerResponse);
            if(options.signal?.aborted) throw abortError();
            if(response.message.tool_calls?.length||!response.message.content.trim()){
                throw coded(
                    new TypeError('The model-authored chat opening must contain visible assistant text.'),
                    'AI_CHAT_INVALID_OPENING_RESPONSE',
                );
            }
            const openingMessage=message('assistant',response.message.content);
            let settled=false;
            return {
                response,
                commit:()=>{
                    if(settled) throw coded(new Error('The prepared chat opening is already settled.'),'AI_CHAT_TRANSACTION_SETTLED');
                    this.#conversation=[openingMessage];
                    settled=true;
                    this.#pending=false;
                    return response;
                },
                rollback:()=>{
                    if(settled) return false;
                    settled=true;
                    this.#pending=false;
                    return true;
                },
            };
        }catch(error){
            this.#pending=false;
            throw error;
        }
    }

    async prepare(input,options={}){
        if(!isPlainRecord(options)) throw new TypeError('Chat send options must be a plain object.');
        const unsupported=Object.keys(options).find(key=>!['request','signal'].includes(key));
        if(unsupported) throw new TypeError(`Unsupported chat send option: ${unsupported}`);
        if(!signalLike(options.signal)) throw new TypeError('signal must be an AbortSignal.');
        if(options.signal?.aborted) throw abortError();
        const turnRequest=normalizeRequestOptions(options.request,'request');
        const inputMessages=normalizeInputMessages(input);
        const inputMessage=inputMessages[0];
        if(this.#pending){
            throw coded(new Error('A chat request is already active for this session.'),'AI_CHAT_BUSY');
        }
        this.#pending=true;
        try{
            const pendingTools=pendingToolCallIds(this.#conversation);
            if(inputMessage.role==='user'&&pendingTools.size){
                throw coded(
                    new TypeError('The pending structural tool result must be supplied before a new user turn.'),
                    'AI_CHAT_TOOL_RESULT_REQUIRED',
                );
            }
            if(inputMessage.role==='tool'){
                const submittedIds=new Set();
                for(const item of inputMessages){
                    if(
                        submittedIds.has(item.tool_call_id)
                        ||!pendingTools.has(item.tool_call_id)
                        ||matchingToolCallIndex(this.#conversation,item.tool_call_id)<0
                    ){
                        throw coded(
                            new TypeError('A tool message does not match a pending assistant tool call in this session.'),
                            'AI_CHAT_INVALID_TOOL_MESSAGE',
                        );
                    }
                    submittedIds.add(item.tool_call_id);
                }
                if(submittedIds.size!==pendingTools.size){
                    throw coded(
                        new TypeError('Every pending structural tool result must be supplied before provider continuation.'),
                        'AI_CHAT_TOOL_RESULT_REQUIRED',
                    );
                }
            }
            const context=inputMessage.role==='user'
                ?await this.#contextFor(inputMessage.content,options.signal)
                :null;
            if(options.signal?.aborted) throw abortError();
            const transientContext=context
                ?message('user',context)
                :null;
            const transientMessages=[...(transientContext?[transientContext]:[]),...inputMessages];
            const requestMessages=completeHistory(
                this.#systemPrompt,
                [...this.#conversation,...transientMessages],
            );
            let providerResponse;
            try{
                const providerRequest={
                    ...this.#request,
                    ...turnRequest,
                    ...(options.signal?{signal:options.signal}:{}),
                    messages:requestMessages.map(publicMessage),
                };
                providerResponse=await this.#chat(providerRequest);
            }catch(error){
                if(options.signal?.aborted) throw abortError();
                throw error;
            }
            const response=normalizeResponse(providerResponse);
            if(options.signal?.aborted) throw abortError();
            const retainedConversation=this.#conversation.map(cloneMessage);
            const nextConversation=recurringChatMessages([
                ...retainedConversation,
                ...inputMessages,
                response.message,
            ]);
            let settled=false;
            return {
                response,
                commit:()=>{
                    if(settled) throw coded(new Error('The prepared chat turn is already settled.'),'AI_CHAT_TRANSACTION_SETTLED');
                    this.#conversation=nextConversation;
                    settled=true;
                    this.#pending=false;
                    return response;
                },
                rollback:()=>{
                    if(settled) return false;
                    settled=true;
                    this.#pending=false;
                    return true;
                },
            };
        }catch(error){
            this.#pending=false;
            throw error;
        }
    }

    async send(input,options={}){
        const prepared=await this.prepare(input,options);
        return prepared.commit();
    }
}
