import ChatEntity from '../entities/Chat.js';
import ConfiguredAIChatSession,{
    normalizeStructuralToolCall
} from './ConfiguredAIChatSession.js';

const SESSION_MANAGED_REQUEST_FIELDS=new Set([
    'messages',
    'onChunk',
    'onDataChunk',
    'onDataResult',
    'onResponse',
    'onToolCall',
    'signal',
    'stream',
]);
const PROVIDER_LIFECYCLE_FIELDS=new Set([
    'onChunk',
    'onDataChunk',
    'onDataResult',
    'onResponse',
    'onToolCall'
]);

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function isPlainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function assertKnownKeys(value,allowed,label){
    const unknown=Object.keys(value).find(key=>!allowed.has(key));
    if(unknown) throw new TypeError(`${label} contains an unsupported field: ${unknown}.`);
}

function boolean(value,label,defaultValue){
    if(value===undefined) return defaultValue;
    if(typeof value!=='boolean') throw new TypeError(`${label} must be a boolean.`);
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

function providerRequestWithoutLifecycleCallbacks(value){
    return Object.fromEntries(
        Object.entries(value).filter(([key])=>!PROVIDER_LIFECYCLE_FIELDS.has(key))
    );
}

async function configuredArcaneChat(request){
    const api=globalThis.Arcane?.ai;
    if(typeof api?.chat!=='function'){
        throw coded(
            new Error('The configured Arcane AI chat capability is unavailable.'),
            'AI_CHAT_UNAVAILABLE'
        );
    }
    return api.chat(request);
}

function configuredAIChat(ai){
    return function requestConfiguredAI(request){
        return ai.fetchRequest(request);
    };
}

function normalizeStreamHandlers(value){
    if(value===undefined) return {};
    if(!isPlainRecord(value)) throw new TypeError('Persistent chat stream handlers must be a plain object.');
    assertKnownKeys(
        value,
        new Set(['onChunk','onDataChunk','onDataResult','onToolCall']),
        'Persistent chat stream handlers',
    );
    for(const key of ['onChunk','onDataChunk','onDataResult','onToolCall']){
        if(value[key]!==undefined&&typeof value[key]!=='function'){
            throw new TypeError(`${key} must be a function when provided.`);
        }
    }
    return {
        onChunk:value.onChunk??function ignorePersistentChatChunk(){},
        onDataChunk:value.onDataChunk??function ignorePersistentChatDataChunk(){},
        onDataResult:value.onDataResult??function ignorePersistentChatDataResult(){},
        onToolCall:value.onToolCall??function ignorePersistentChatToolCall(){},
    };
}

function normalizeStreamResponse(terminal,output){
    const value=terminal??output;
    if(typeof value==='string'){
        return {message:{role:'assistant',content:value}};
    }
    if(isPlainRecord(value)) return value;
    throw coded(
        new TypeError('The AI stream did not return a terminal response.'),
        'AI_CHAT_INVALID_RESPONSE',
    );
}

function terminalStructuralToolCalls(response){
    const hasMessage=Object.hasOwn(response,'message');
    const hasChoices=Object.hasOwn(response,'choices');
    if(hasMessage&&hasChoices){
        throw coded(
            new TypeError('The AI stream terminal response cannot mix message and choices envelopes.'),
            'AI_CHAT_INVALID_RESPONSE',
        );
    }
    const messages=hasMessage
        ?[response.message]
        :hasChoices&&Array.isArray(response.choices)
            ?response.choices.map(choice=>choice?.message).filter(Boolean)
            :[];
    const calls=[];
    for(let messageIndex=0;messageIndex<messages.length;messageIndex++){
        const value=messages[messageIndex]?.tool_calls;
        if(value===undefined) continue;
        if(!Array.isArray(value)){
            throw coded(
                new TypeError('The AI stream terminal response contains invalid structural tool calls.'),
                'AI_CHAT_INVALID_TOOL_CALL',
            );
        }
        for(let callIndex=0;callIndex<value.length;callIndex++){
            const normalized=normalizeStructuralToolCall(
                value[callIndex],
                `The terminal structural tool call ${messageIndex+1}.${callIndex+1}`,
            );
            if(messageIndex===0) calls.push(normalized);
        }
    }
    return calls;
}

function sameDataValue(left,right,seen=new Map()){
    if(Object.is(left,right)) return true;
    if(!left||!right||typeof left!=='object'||typeof right!=='object') return false;
    if(Array.isArray(left)!==Array.isArray(right)) return false;
    const matched=seen.get(left);
    if(matched!==undefined) return matched===right;
    seen.set(left,right);
    if(Array.isArray(left)){
        return left.length===right.length
            &&left.every((value,index)=>sameDataValue(value,right[index],seen));
    }
    if(!isPlainRecord(left)||!isPlainRecord(right)) return false;
    const leftKeys=Reflect.ownKeys(left).filter(key=>Object.prototype.propertyIsEnumerable.call(left,key));
    const rightKeys=Reflect.ownKeys(right).filter(key=>Object.prototype.propertyIsEnumerable.call(right,key));
    return leftKeys.length===rightKeys.length
        &&leftKeys.every(key=>Object.prototype.propertyIsEnumerable.call(right,key)
            &&sameDataValue(left[key],right[key],seen));
}

function sameStructuralToolCall(left,right){
    return sameDataValue(left,right);
}

function sameStructuralToolCalls(left,right){
    return Array.isArray(left)
        &&Array.isArray(right)
        &&left.length===right.length
        &&left.every((call,index)=>sameStructuralToolCall(call,right[index]));
}

function normalizeSend(input){
    if(!isPlainRecord(input)) throw new TypeError('Persistent chat input must be a plain object.');
    assertKnownKeys(input,new Set(['message','messages','request','response','signal']),'Persistent chat input');
    const hasMessage=Object.hasOwn(input,'message');
    const hasMessages=Object.hasOwn(input,'messages');
    if(hasMessage===hasMessages){
        throw new TypeError('Persistent chat input must contain exactly one message or messages field.');
    }
    const sourceMessages=hasMessages?input.messages:[input.message];
    if(!Array.isArray(sourceMessages)||!sourceMessages.length){
        throw new TypeError('messages must be a nonempty array of tool-result messages.');
    }
    const normalizedMessages=sourceMessages.map((value,index)=>{
        const label=hasMessages?`messages[${index}]`:'message';
        if(!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
        if(typeof value.content!=='string'||!value.content.trim()){
            throw new TypeError(`${label}.content must contain text.`);
        }
        const role=value.role??'user';
        if(!['tool','user'].includes(role)) throw new TypeError(`${label}.role must be user or tool.`);
        if(hasMessages&&role!=='tool'){
            throw new TypeError('messages accepts only tool-result messages.');
        }
        let toolCallId=null;
        let persistenceMessage=null;
        let persistenceName=null;
        let persistenceStatus=null;
        if(role==='tool'){
            if(typeof value.tool_call_id!=='string'||!value.tool_call_id.trim()){
                throw new TypeError(`${label}.tool_call_id is required for tool messages.`);
            }
            toolCallId=value.tool_call_id;
            if(value.message!==undefined){
                if(typeof value.message!=='string'||!value.message.trim()){
                    throw new TypeError(`${label}.message must contain user-facing text when provided.`);
                }
                persistenceMessage=value.message;
            }
            if(value.name!==undefined){
                if(typeof value.name!=='string'||!value.name.trim()){
                    throw new TypeError(`${label}.name must contain text when provided.`);
                }
                persistenceName=value.name;
            }
            if(value.status!==undefined){
                if(typeof value.status!=='string'||!value.status.trim()){
                    throw new TypeError(`${label}.status must contain text when provided.`);
                }
                persistenceStatus=value.status;
            }
        }else if(value.tool_call_id!==undefined){
            throw new TypeError(`${label}.tool_call_id is supported only for tool messages.`);
        }
        const completeMessage={...value};
        delete completeMessage.persist;
        delete completeMessage.message;
        delete completeMessage.name;
        delete completeMessage.status;
        const providerMessage={
            ...completeMessage,
            content:value.content,
            role,
            ...(toolCallId?{tool_call_id:toolCallId}:{})
        };
        return {
            persist:boolean(value.persist,`${label}.persist`,true),
            message:providerMessage,
            entityMessage:role==='tool'
                ?{
                    ...providerMessage,
                    ...(persistenceMessage?{persistence_message:persistenceMessage}:{}),
                    ...(persistenceName?{persistence_name:persistenceName}:{}),
                    ...(persistenceStatus?{persistence_status:persistenceStatus}:{}),
                }
                :providerMessage,
        };
    });
    const messagePersist=normalizedMessages[0].persist;
    if(normalizedMessages.some(item=>item.persist!==messagePersist)){
        throw coded(
            new TypeError('Every message in one tool-result batch must use the same persistence choice.'),
            'AI_CHAT_INCOHERENT_PERSISTENCE',
        );
    }
    const response=input.response??{};
    if(!isPlainRecord(response)) throw new TypeError('response must be a plain object.');
    assertKnownKeys(response,new Set(['persist']),'response');
    const responsePersist=boolean(response.persist,'response.persist',messagePersist);
    if(responsePersist!==messagePersist){
        throw coded(
            new TypeError('message.persist and response.persist must match for one coherent durable turn.'),
            'AI_CHAT_INCOHERENT_PERSISTENCE',
        );
    }
    const request=input.request??{};
    if(!isPlainRecord(request)) throw new TypeError('request must be a plain object.');
    const managedRequestField=Object.keys(request).find(
        key=>SESSION_MANAGED_REQUEST_FIELDS.has(key)
    );
    if(managedRequestField){
        throw new TypeError(`request.${managedRequestField} is managed by the chat session.`);
    }
    if(!signalLike(input.signal)) throw new TypeError('signal must be an AbortSignal.');
    return {
        messagePersist,
        entityRequestMessages:normalizedMessages.map(item=>item.entityMessage),
        requestMessages:normalizedMessages.map(item=>item.message),
        responsePersist,
        request:{...request},
        signal:input.signal??null,
    };
}

function fileName(value){
    if(typeof value!=='string'||value.length===0){
        throw new TypeError('chatFileName must be a nonempty string.');
    }
    return value;
}

/**
 * Composes the configured chat session with one automatically selected
 * ChatEntity. Request-only context is delegated to ConfiguredAIChatSession;
 * persist:false uses the turn for one request and retains it nowhere afterward.
 */
class PersistentAIChatSession{
    #activeStream=null;
    #configured=null;
    #entity;
    #fetchChat;
    #historyError=null;
    #memory;
    #options;
    #pending=false;
    #readyPromise;
    #toolCallPersistence=new Map();

    constructor(options={}){
        if(!isPlainRecord(options)) throw new TypeError('Persistent chat options must be a plain object.');
        assertKnownKeys(
            options,
            new Set([
                'ai','chat','chatEntity','chatFileName','contextBuilder','loadExisting','maxContextCharacters',
                'maxMessageCharacters','maxMessages','memory','request','responseLength','systemPrompt'
            ]),
            'Persistent chat options',
        );
        if(options.chatEntity!==undefined&&!(options.chatEntity instanceof ChatEntity)){
            throw new TypeError('chatEntity must be a ChatEntity.');
        }
        if(options.ai!==undefined&&(
            !options.ai
            ||typeof options.ai!=='object'
            ||typeof options.ai.fetchRequest!=='function'
        )){
            throw new TypeError('ai must expose fetchRequest(request).');
        }
        if(options.ai!==undefined&&options.chat!==undefined){
            throw coded(
                new TypeError('Specify either ai or chat, not both.'),
                'AI_CHAT_AMBIGUOUS_PROVIDER',
            );
        }
        const chat=options.ai===undefined
            ?options.chat??configuredArcaneChat
            :configuredAIChat(options.ai);
        if(typeof chat!=='function') throw new TypeError('chat must be a function.');
        if(options.request!==undefined&&!isPlainRecord(options.request)){
            throw new TypeError('request must be a plain object.');
        }
        const request={...(options.request??{})};
        const managedRequestField=Object.keys(request).find(
            key=>SESSION_MANAGED_REQUEST_FIELDS.has(key)
        );
        if(managedRequestField){
            throw new TypeError(`request.${managedRequestField} is managed by the chat session.`);
        }
        for(const key of ['parallelToolCalls','parallel_tool_calls']){
            if(Object.hasOwn(request,key)&&typeof request[key]!=='boolean'){
                throw new TypeError(`request.${key} must be a boolean when provided.`);
            }
        }
        const systemPrompt=options.systemPrompt??'';
        if(typeof systemPrompt!=='string') throw new TypeError('systemPrompt must be a string.');
        this.#entity=options.chatEntity??new ChatEntity(systemPrompt);
        if(options.chatFileName!==undefined){
            this.#entity.fileName=fileName(options.chatFileName);
        }
        const loadExisting=boolean(
            options.loadExisting,
            'loadExisting',
            options.chatFileName!==undefined,
        );
        if(loadExisting&&!options.chatEntity&&options.chatFileName===undefined){
            throw new TypeError('loadExisting requires chatFileName or chatEntity.');
        }
        this.#memory=boolean(options.memory,'memory',true);
        this.#fetchChat=chat;
        this.#options={...options,chat,loadExisting,request,systemPrompt};
        this.#readyPromise=this.#initialize();
    }

    static async create(options={}){
        const session=new PersistentAIChatSession(options);
        await session.ready();
        return session;
    }

    get chatEntity(){return this.#entity;}
    get fileName(){return this.#entity.fileName;}
    get ai(){return this.#options.ai??null;}

    async #requestConfiguredAI(request){
        const providerRequest=providerRequestWithoutLifecycleCallbacks(request);
        if(!this.#activeStream) return this.#fetchChat(providerRequest);
        if(typeof this.#options.ai?.streamRequest!=='function'){
            const response=await this.#fetchChat(providerRequest);
            await this.#activeStream.onDataResult(response,providerRequest.id??null);
            return response;
        }
        const activeStream=this.#activeStream;
        let terminal=null;
        const streamedToolCalls=[];
        const streamedToolDetails=[];
        const output=await this.#options.ai.streamRequest({
            ...providerRequest,
            onChunk:activeStream.onChunk,
            onDataChunk:activeStream.onDataChunk,
            onDataResult:activeStream.onDataResult,
            onToolCall:function retainStructuralToolCall(call,...details){
                const normalized=normalizeStructuralToolCall(
                    call,
                    'The streamed structural tool call',
                );
                if(streamedToolCalls.some(call=>call.id===normalized.id)){
                    throw coded(
                        new TypeError('The AI stream emitted a duplicate structural tool call.'),
                        'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                    );
                }
                streamedToolCalls.push(normalized);
                streamedToolDetails.push(details);
            },
            onResponse:async function retainPersistentChatTerminal(response){
                terminal=response;
            },
        });
        const response=normalizeStreamResponse(terminal,output);
        const terminalToolCalls=terminalStructuralToolCalls(response);
        if(streamedToolCalls.length&&!sameStructuralToolCalls(streamedToolCalls,terminalToolCalls)){
            throw coded(
                new TypeError(
                    'The AI stream terminal response omitted, reordered, or changed its structural tool calls.'
                ),
                'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
            );
        }
        activeStream.streamedToolCalls=streamedToolCalls;
        activeStream.streamedToolDetails=streamedToolDetails;
        activeStream.terminalToolCalls=terminalToolCalls;
        return response;
    }

    async #initialize(){
        let storedMessages=[];
        try{
            if(this.#options.loadExisting) await this.#entity.load();
            storedMessages=this.#entity.messages;
        }catch(error){
            this.#historyError=coded(
                error instanceof Error?error:new Error('The saved chat history is invalid.'),
                'AI_CHAT_INCOHERENT_PERSISTENCE',
            );
            console.error('Arcane saved chat history is readable but not actionable.',error);
        }
        const storedSystem=storedMessages.find(message=>message.role==='system');
        const initialMessages=storedMessages
            .filter(message=>['user','assistant','tool'].includes(message.role))
            .map(message=>({
                ...message,
                role:message.role,
                content:String(message.content??''),
                ...(message.role==='assistant'&&Object.hasOwn(message,'reasoning_content')
                    ?{reasoning_content:message.reasoning_content}
                    :{}),
                ...(message.tool_calls?{tool_calls:message.tool_calls}:{}),
                ...(message.tool_call_id?{tool_call_id:message.tool_call_id}:{}),
            }));
        for(const message of initialMessages){
            if(message.role==='assistant'){
                for(const call of message.tool_calls??[]) this.#toolCallPersistence.set(call.id,true);
            }else if(message.role==='tool'){
                this.#toolCallPersistence.delete(message.tool_call_id);
            }
        }
        const configuredOptions={
            chat:request=>this.#requestConfiguredAI(request),
            contextBuilder:this.#options.contextBuilder,
            initialMessages,
            request:this.#options.request,
            systemPrompt:this.#options.systemPrompt||String(storedSystem?.content??''),
        };
        if(Object.hasOwn(this.#options,'responseLength')){
            configuredOptions.responseLength=this.#options.responseLength;
        }
        for(const key of Object.keys(configuredOptions)){
            if(configuredOptions[key]===undefined) delete configuredOptions[key];
        }
        this.#configured=new ConfiguredAIChatSession(configuredOptions);
        return this;
    }

    async ready(){
        await this.#readyPromise;
        return this;
    }

    async history(){
        await this.ready();
        if(this.#historyError)throw this.#historyError;
        return this.#configured.history();
    }

    async transcript(){
        await this.ready();
        return this.#entity.transcript;
    }

    async settleMemory(){
        await this.ready();
        return this.#entity.settleMemory();
    }

    async #requestTurn(input,streamHandlers=null){
        const settings=normalizeSend(input);
        if(this.#pending){
            throw coded(new Error('A chat request is already active for this session.'),'AI_CHAT_BUSY');
        }
        this.#pending=true;
        let prepared=null;
        try{
            await this.ready();
            if(this.#historyError)throw this.#historyError;
            await this.#entity.settleMemory();
            const requestMessage=settings.requestMessages[0];
            if(requestMessage.role==='user'&&this.#toolCallPersistence.size){
                throw coded(
                    new TypeError('The pending structural tool result must be supplied before a new user turn.'),
                    'AI_CHAT_TOOL_RESULT_REQUIRED',
                );
            }
            if(requestMessage.role==='tool'){
                const submittedIds=new Set();
                for(const message of settings.requestMessages){
                    const persistence=this.#toolCallPersistence.get(message.tool_call_id);
                    if(persistence===undefined||submittedIds.has(message.tool_call_id)){
                        throw coded(new TypeError('A tool message has no unique pending structural tool call.'),'AI_CHAT_INVALID_TOOL_MESSAGE');
                    }
                    if(persistence!==settings.messagePersist){
                        throw coded(
                            new TypeError('A tool result must use the persistence of its assistant tool call.'),
                            'AI_CHAT_INCOHERENT_PERSISTENCE',
                        );
                    }
                    submittedIds.add(message.tool_call_id);
                }
                if(submittedIds.size!==this.#toolCallPersistence.size){
                    throw coded(
                        new TypeError('Every pending structural tool result must be supplied before provider continuation.'),
                        'AI_CHAT_TOOL_RESULT_REQUIRED',
                    );
                }
            }
            const streamState=streamHandlers?{
                ...streamHandlers,
                streamedToolCalls:[],
                streamedToolDetails:[],
                terminalToolCalls:[],
            }:null;
            if(streamState) this.#activeStream=streamState;
            try{
                prepared=await this.#configured.prepare(
                    settings.requestMessages.length===1
                        ?settings.requestMessages[0]
                        :settings.requestMessages,
                    {request:settings.request,signal:settings.signal},
                );
            }finally{
                if(this.#activeStream===streamState) this.#activeStream=null;
            }
            const result=prepared.response;
            if(streamState){
                const validatedToolCalls=result.message.tool_calls??[];
                if(
                    streamState.terminalToolCalls.length
                    &&!sameStructuralToolCalls(streamState.terminalToolCalls,validatedToolCalls)
                ){
                    throw coded(
                        new TypeError(
                            'The validated AI response changed its terminal structural tool calls.'
                        ),
                        'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                    );
                }
                for(let index=0;index<validatedToolCalls.length;index++){
                    await streamState.onToolCall(
                        validatedToolCalls[index],
                        ...(streamState.streamedToolDetails[index]??[]),
                    );
                }
            }
            if(!settings.messagePersist){
                prepared.rollback();
                prepared=null;
                return result;
            }
            await this.#entity.addTurn({
                assistantMessage:result.message,
                extractMemory:this.#memory&&settings.messagePersist&&settings.responsePersist,
                memoryRequest:messages=>this.#fetchChat(
                    providerRequestWithoutLifecycleCallbacks({
                        ...this.#options.request,
                        messages,
                    })
                ),
                messagePersist:settings.messagePersist,
                ...(settings.entityRequestMessages.length===1
                    ?{requestMessage:settings.entityRequestMessages[0]}
                    :{requestMessages:settings.entityRequestMessages}),
                responsePersist:settings.responsePersist,
            });
            const committed=prepared.commit();
            if(requestMessage.role==='tool'){
                for(const message of settings.requestMessages){
                    this.#toolCallPersistence.delete(message.tool_call_id);
                }
            }
            for(const call of result.message.tool_calls??[]){
                this.#toolCallPersistence.set(call.id,settings.responsePersist);
            }
            const transcript=this.#entity.transcript;
            const assistantRecord=transcript.at(-1);
            return assistantRecord?.role==='assistant'
                ?{
                    ...committed,
                    message:{
                        ...committed.message,
                        ...(assistantRecord.timestamp!==undefined
                            ?{timestamp:assistantRecord.timestamp}
                            :{}),
                    },
                }
                :committed;
        }catch(error){
            prepared?.rollback();
            throw error;
        }finally{
            this.#pending=false;
        }
    }

    async send(input){
        return this.#requestTurn(input);
    }

    async stream(input,handlers={}){
        return this.#requestTurn(input,normalizeStreamHandlers(handlers));
    }
}

function createPersistentAIChatSession(options){
    return PersistentAIChatSession.create(options);
}

export {PersistentAIChatSession,createPersistentAIChatSession};
export default PersistentAIChatSession;
