import ChatEntity from '../entities/Chat.js';
import ConfiguredAIChatSession from './ConfiguredAIChatSession.js';

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
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

function normalizeSend(input){
    if(!isPlainRecord(input)) throw new TypeError('Persistent chat input must be a plain object.');
    assertKnownKeys(input,new Set(['message','response','signal']),'Persistent chat input');
    if(!isPlainRecord(input.message)) throw new TypeError('message must be a plain object.');
    assertKnownKeys(input.message,new Set(['content','persist','role','tool_call_id']),'message');
    if(typeof input.message.content!=='string'||!input.message.content.trim()){
        throw new TypeError('message.content must contain text.');
    }
    const role=input.message.role??'user';
    if(!['tool','user'].includes(role)) throw new TypeError('message.role must be user or tool.');
    let toolCallId=null;
    if(role==='tool'){
        if(typeof input.message.tool_call_id!=='string'||!input.message.tool_call_id.trim()){
            throw new TypeError('message.tool_call_id is required for tool messages.');
        }
        toolCallId=input.message.tool_call_id;
    }else if(input.message.tool_call_id!==undefined){
        throw new TypeError('message.tool_call_id is supported only for tool messages.');
    }
    const messagePersist=boolean(input.message.persist,'message.persist',true);
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
    if(!signalLike(input.signal)) throw new TypeError('signal must be an AbortSignal.');
    return {
        messagePersist,
        requestMessage:{
            content:input.message.content,
            role,
            ...(toolCallId?{tool_call_id:toolCallId}:{}),
        },
        responsePersist,
        signal:input.signal??null,
    };
}

function fileName(value){
    if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.jsonl$/.test(value)){
        throw new TypeError('chatFileName must be a safe .jsonl file name.');
    }
    return value;
}

/**
 * Composes the bounded configured chat session with one automatically selected
 * ChatEntity. Request-only context is delegated to ConfiguredAIChatSession;
 * per-turn persistence affects DBOPFS and memory, never the live model context.
 */
class PersistentAIChatSession{
    #configured=null;
    #entity;
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
        this.#options={...options,chat,loadExisting,systemPrompt};
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

    async #initialize(){
        if(this.#options.loadExisting) await this.#entity.load();
        const storedMessages=this.#entity.messages;
        const storedSystem=storedMessages.find(message=>message.role==='system');
        const initialMessages=storedMessages
            .filter(message=>['user','assistant','tool'].includes(message.role))
            .map(message=>({
                role:message.role,
                content:String(message.content??''),
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
            chat:this.#options.chat,
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
        return this.#configured.history();
    }

    async settleMemory(){
        await this.ready();
        return this.#entity.settleMemory();
    }

    async send(input){
        const settings=normalizeSend(input);
        if(this.#pending){
            throw coded(new Error('A chat request is already active for this session.'),'AI_CHAT_BUSY');
        }
        this.#pending=true;
        let prepared=null;
        try{
            await this.ready();
            await this.#entity.settleMemory();
            if(settings.requestMessage.role==='user'&&this.#toolCallPersistence.size){
                throw coded(
                    new TypeError('The pending structural tool result must be supplied before a new user turn.'),
                    'AI_CHAT_TOOL_RESULT_REQUIRED',
                );
            }
            if(settings.requestMessage.role==='tool'){
                const persistence=this.#toolCallPersistence.get(settings.requestMessage.tool_call_id);
                if(persistence===undefined){
                    throw coded(new TypeError('The tool message has no pending structural tool call.'),'AI_CHAT_INVALID_TOOL_MESSAGE');
                }
                if(persistence!==settings.messagePersist){
                    throw coded(
                        new TypeError('A tool result must use the persistence of its assistant tool call.'),
                        'AI_CHAT_INCOHERENT_PERSISTENCE',
                    );
                }
            }
            prepared=await this.#configured.prepare(settings.requestMessage,{signal:settings.signal});
            const result=prepared.response;
            await this.#entity.addTurn({
                assistantMessage:result.message,
                extractMemory:this.#memory&&settings.messagePersist&&settings.responsePersist,
                memoryRequest:messages=>this.#options.chat({
                    ...this.#options.request,
                    messages,
                }),
                messagePersist:settings.messagePersist,
                requestMessage:settings.requestMessage,
                responsePersist:settings.responsePersist,
            });
            const committed=prepared.commit();
            if(settings.requestMessage.role==='tool'){
                this.#toolCallPersistence.delete(settings.requestMessage.tool_call_id);
            }
            for(const call of result.message.tool_calls??[]){
                this.#toolCallPersistence.set(call.id,settings.responsePersist);
            }
            return committed;
        }catch(error){
            prepared?.rollback();
            throw error;
        }finally{
            this.#pending=false;
        }
    }
}

function createPersistentAIChatSession(options){
    return PersistentAIChatSession.create(options);
}

export {PersistentAIChatSession,createPersistentAIChatSession};
export default PersistentAIChatSession;
