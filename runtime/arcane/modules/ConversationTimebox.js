const CONVERSATION_TIMEBOX_TOOL_NAME='conversation_timebox';
const CONVERSATION_TIMEBOX_TICK_MS=1000;
const MAX_DATE_MILLISECONDS=8_640_000_000_000_000;

const CONVERSATION_TIMEBOX_OPENING_INSTRUCTION=`Before any other intake question, ask exactly one timing question: "Do you have a limited amount of time to talk right now?" Ask no other question in that opening reply, and wait for the answer before continuing the app's normal intake. The elapsed conversation timer is already visible. A time limit applies only to this conversation. Never infer, round, or invent a duration. When the user explicitly provides a positive whole number of minutes, call the conversation_timebox tool with action "set" and that exact duration. When the user explicitly says there is no limit or asks to remove it, call the tool with action "clear". If the duration is vague, ranged, fractional, or expressed without a clear whole-minute value, ask one focused question and do not call the tool yet. Adapt the pace and prioritize the most important next action within an active limit without skipping safety. A message that the agreed time check is due is a check-in, not a request to end: ask whether the user wants to end now or continue, and do not assume their choice or set another limit unless they explicitly state one.`;

const CONVERSATION_TIMEBOX_LIMIT_MESSAGE='The agreed conversation time check is due. Please ask whether I want to end now or continue, and do not assume my choice or set another limit unless I explicitly state one.';

const conversationTimeboxTool=Object.freeze({
    type:'function',
    function:Object.freeze({
        name:CONVERSATION_TIMEBOX_TOOL_NAME,
        description:'Set, revise, or clear the current conversation time check only when the user explicitly states their availability. Use action "set" only with the exact positive whole number of minutes the user supplied. Use action "clear" only when the user explicitly says there is no limit or asks to remove it. Never infer, round, convert a vague range, or choose a default duration; ask one focused question instead.',
        parameters:Object.freeze({
            type:'object',
            additionalProperties:false,
            properties:Object.freeze({
                action:Object.freeze({
                    type:'string',
                    enum:Object.freeze(['set','clear']),
                    description:'Set or revise an explicit time check, or clear an explicitly declined/removed limit.'
                }),
                duration_minutes:Object.freeze({
                    type:'integer',
                    minimum:1,
                    description:'The exact positive whole number of minutes explicitly supplied by the user. Required only for action "set".'
                })
            }),
            required:Object.freeze(['action'])
        })
    })
});

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function parseToolArguments(value){
    if(isPlainRecord(value)){
        return value;
    }
    if(typeof value!=='string'){
        throw new TypeError('The conversation timebox tool requires JSON object arguments.');
    }
    try{
        const parsed=JSON.parse(value);
        if(!isPlainRecord(parsed)){
            throw new TypeError('The conversation timebox tool requires a JSON object.');
        }
        return parsed;
    }catch(error){
        if(error instanceof TypeError){
            throw error;
        }
        throw new TypeError('The conversation timebox tool returned invalid JSON arguments.');
    }
}

function normalizeConversationTimeboxCommand(value){
    const input=parseToolArguments(value);
    const allowed=new Set(['action','duration_minutes']);
    const unsupported=Object.keys(input).find(function findUnsupportedTimeboxField(key){
        return !allowed.has(key);
    });

    if(unsupported){
        throw new TypeError(`Unsupported conversation timebox field: ${unsupported}`);
    }
    if(input.action!=='set'&&input.action!=='clear'){
        throw new TypeError('Conversation timebox action must be "set" or "clear".');
    }
    if(input.action==='clear'){
        if(Object.hasOwn(input,'duration_minutes')){
            throw new TypeError('A clear conversation timebox command must not include duration_minutes.');
        }
        return Object.freeze({action:'clear'});
    }
    if(!Number.isSafeInteger(input.duration_minutes)||input.duration_minutes<=0){
        throw new TypeError('duration_minutes must be an explicit positive whole number.');
    }
    return Object.freeze({
        action:'set',
        durationMinutes:input.duration_minutes
    });
}

function appendConversationTimeboxOpeningInstruction(message=''){
    if(typeof message!=='string'){
        throw new TypeError('The opening message must be a string.');
    }
    const base=message.trim();
    return base
        ?`${base}\n\n${CONVERSATION_TIMEBOX_OPENING_INSTRUCTION}`
        :CONVERSATION_TIMEBOX_OPENING_INSTRUCTION;
}

function formatConversationElapsed(milliseconds=0){
    if(!Number.isFinite(milliseconds)||milliseconds<0){
        throw new TypeError('Elapsed time must be a non-negative finite number.');
    }
    const totalSeconds=Math.floor(milliseconds/1000);
    const hours=Math.floor(totalSeconds/3600);
    const minutes=Math.floor((totalSeconds%3600)/60);
    const seconds=totalSeconds%60;
    return hours>0
        ?`${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`
        :`${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

function createConversationTimeboxControlMessage(action,minutes){
    if(action==='clear'){
        return 'I used the conversation controls to confirm that I do not have a time limit right now. The elapsed timer should keep running. The limit is already cleared; do not infer or set another limit unless I explicitly state one.';
    }
    if(action!=='set'||!Number.isSafeInteger(minutes)||minutes<=0){
        throw new TypeError('A timebox control message requires an explicit positive whole-minute duration.');
    }
    return `I used the conversation controls to set a check-in ${minutes} minute${minutes===1?'':'s'} from now. The timer is already set. Please adapt our pace and priorities to that limit, and do not reset it unless I explicitly revise it.`;
}

function conversationTimeboxSubmissionKey(context={}){
    if(!isPlainRecord(context)||context.synthetic!==true){
        return '';
    }
    const source=String(context.source||'');
    const revision=context.timeboxRevision;
    if(
        !source.startsWith('conversation-timebox')
        ||!Number.isSafeInteger(revision)
        ||revision<1
    ){
        return '';
    }
    return `${source}:${revision}`;
}

function reportConversationTimeboxListenerError(error){
    console.error('A conversation timebox listener failed.',error);
}

function defaultClock(){
    return Date.now();
}

function defaultSchedule(callback,delay){
    return globalThis.setInterval(callback,delay);
}

function defaultCancel(handle){
    globalThis.clearInterval(handle);
}

class ConversationSubmissionBarrier{
    #pending=new Set();

    get pendingCount(){
        return this.#pending.size;
    }

    track(result){
        const pending=Promise.resolve(result);
        this.#pending.add(pending);
        const removePending=function removeTrackedConversationSubmission(){
            this.#pending.delete(pending);
        }.bind(this);
        void pending.then(removePending,removePending);
        return pending;
    }

    async waitForIdle(){
        while(this.#pending.size){
            await Promise.allSettled([...this.#pending]);
        }
    }
}

function requireConversationTimeboxDelivery(result){
    if(result===false){
        throw new Error('The host did not complete the conversation timebox message.');
    }
    return result;
}

class ConversationTimebox{
    #cancel;
    #clock;
    #disposed=false;
    #dueAtMs=null;
    #dueRevision=null;
    #durationMinutes=null;
    #intervalHandle=null;
    #listeners=new Set();
    #nowMs=null;
    #onListenerError;
    #revision=0;
    #schedule;
    #setAtMs=null;
    #startedAtMs=null;
    #tickMs;

    constructor(options={}){
        if(!isPlainRecord(options)){
            throw new TypeError('Conversation timebox options must be a plain object.');
        }
        const allowed=new Set(['cancel','clock','onListenerError','schedule','tickMs']);
        const unsupported=Object.keys(options).find(function findUnsupportedTimeboxOption(key){
            return !allowed.has(key);
        });
        if(unsupported){
            throw new TypeError(`Unsupported conversation timebox option: ${unsupported}`);
        }

        this.#clock=options.clock??defaultClock;
        this.#schedule=options.schedule??defaultSchedule;
        this.#cancel=options.cancel??defaultCancel;
        this.#onListenerError=options.onListenerError??reportConversationTimeboxListenerError;
        this.#tickMs=options.tickMs??CONVERSATION_TIMEBOX_TICK_MS;

        for(const [name,value] of [
            ['clock',this.#clock],
            ['schedule',this.#schedule],
            ['cancel',this.#cancel],
            ['onListenerError',this.#onListenerError]
        ]){
            if(typeof value!=='function'){
                throw new TypeError(`${name} must be a function.`);
            }
        }
        if(!Number.isSafeInteger(this.#tickMs)||this.#tickMs<100||this.#tickMs>60_000){
            throw new RangeError('tickMs must be an integer between 100 and 60000.');
        }
    }

    get limitReachedMessage(){
        return CONVERSATION_TIMEBOX_LIMIT_MESSAGE;
    }

    controlMessage(action,minutes){
        return createConversationTimeboxControlMessage(action,minutes);
    }

    start(){
        this.#assertActive();
        if(this.#startedAtMs!==null){
            return this.snapshot();
        }
        const now=this.#readClock();
        const intervalHandle=this.#schedule(
            this.#tick.bind(this),
            this.#tickMs
        );
        this.#startedAtMs=now;
        this.#nowMs=now;
        this.#intervalHandle=intervalHandle;
        this.#notify('change');
        return this.snapshot();
    }

    setLimitMinutes(minutes,{source='user'}={}){
        this.#assertActive();
        if(!Number.isSafeInteger(minutes)||minutes<=0){
            throw new TypeError('Conversation time must be an explicit positive whole number of minutes.');
        }
        if(typeof source!=='string'||!source.trim()){
            throw new TypeError('Conversation timebox source must contain text.');
        }
        if(this.#startedAtMs===null){
            this.start();
        }

        const now=this.#readClock();
        const durationMs=minutes*60_000;
        const dueAtMs=now+durationMs;
        if(!Number.isSafeInteger(durationMs)||!Number.isSafeInteger(dueAtMs)||dueAtMs>MAX_DATE_MILLISECONDS){
            throw new RangeError('The requested conversation duration exceeds the supported date range.');
        }

        this.#durationMinutes=minutes;
        this.#setAtMs=now;
        this.#dueAtMs=dueAtMs;
        this.#dueRevision=null;
        this.#revision++;
        this.#nowMs=now;
        this.#notify('change');
        return this.snapshot();
    }

    clearLimit({source='user'}={}){
        this.#assertActive();
        if(typeof source!=='string'||!source.trim()){
            throw new TypeError('Conversation timebox source must contain text.');
        }
        if(this.#startedAtMs===null){
            this.start();
        }
        this.#durationMinutes=null;
        this.#setAtMs=null;
        this.#dueAtMs=null;
        this.#dueRevision=null;
        this.#revision++;
        this.#nowMs=this.#readClock();
        this.#notify('change');
        return this.snapshot();
    }

    applyCommand(value){
        const command=normalizeConversationTimeboxCommand(value);
        return command.action==='clear'
            ?this.clearLimit({source:'tool'})
            :this.setLimitMinutes(command.durationMinutes,{source:'tool'});
    }

    subscribe(listener){
        if(typeof listener!=='function'){
            throw new TypeError('Conversation timebox listener must be a function.');
        }
        this.#listeners.add(listener);
        listener(
            this.snapshot(),
            Object.freeze({type:'snapshot',revision:this.#revision})
        );
        const listeners=this.#listeners;
        return function unsubscribeConversationTimeboxListener(){
            return listeners.delete(listener);
        };
    }

    snapshot(){
        const now=this.#startedAtMs===null
            ?null
            :Math.max(this.#nowMs??this.#startedAtMs,this.#startedAtMs);
        const elapsedMs=now===null?0:now-this.#startedAtMs;
        const remainingMs=this.#dueAtMs===null||now===null
            ?null
            :Math.max(0,this.#dueAtMs-now);
        const status=this.#disposed
            ?'disposed'
            :this.#startedAtMs===null
                ?'idle'
                :this.#dueRevision===this.#revision&&this.#dueAtMs!==null
                    ?'due'
                    :this.#dueAtMs!==null
                        ?'armed'
                        :'unlimited';

        return Object.freeze({
            status,
            startedAtMs:this.#startedAtMs,
            elapsedMs,
            durationMinutes:this.#durationMinutes,
            setAtMs:this.#setAtMs,
            dueAtMs:this.#dueAtMs,
            remainingMs,
            revision:this.#revision,
            dueRevision:this.#dueRevision
        });
    }

    dispose(){
        if(this.#disposed){
            return this.snapshot();
        }
        if(this.#intervalHandle!==null){
            this.#cancel(this.#intervalHandle);
            this.#intervalHandle=null;
        }
        this.#disposed=true;
        this.#notify('change');
        const finalSnapshot=this.snapshot();
        this.#listeners.clear();
        return finalSnapshot;
    }

    #assertActive(){
        if(this.#disposed){
            throw new Error('The conversation timebox has been disposed.');
        }
    }

    #readClock(){
        const now=this.#clock();
        if(!Number.isSafeInteger(now)||now<0||now>MAX_DATE_MILLISECONDS){
            throw new TypeError('Conversation timebox clock must return a supported non-negative integer timestamp.');
        }
        return this.#nowMs===null?now:Math.max(now,this.#nowMs);
    }

    #tick(){
        if(this.#disposed||this.#startedAtMs===null){
            return;
        }
        this.#nowMs=this.#readClock();
        let becameDue=false;
        if(
            this.#dueAtMs!==null
            &&this.#nowMs>=this.#dueAtMs
            &&this.#dueRevision!==this.#revision
        ){
            this.#dueRevision=this.#revision;
            becameDue=true;
        }
        this.#notify(becameDue?'due':'tick');
    }

    #notify(type='change'){
        const state=this.snapshot();
        const event=Object.freeze({type,revision:this.#revision});
        for(const listener of this.#listeners){
            try{
                listener(state,event);
            }catch(error){
                this.#onListenerError(error);
            }
        }
    }
}

function consumeConversationTimeboxCall(calls,controller){
    if(!isPlainRecord(calls)){
        throw new TypeError('Streamed conversation tool calls must be a plain object.');
    }
    if(!controller||typeof controller.applyCommand!=='function'){
        throw new TypeError('A conversation timebox controller is required.');
    }
    const remainingCalls={...calls};
    if(!Object.hasOwn(remainingCalls,CONVERSATION_TIMEBOX_TOOL_NAME)){
        return Object.freeze({
            handled:false,
            remainingCalls:Object.freeze(remainingCalls),
            result:null
        });
    }

    const argumentsValue=remainingCalls[CONVERSATION_TIMEBOX_TOOL_NAME];
    delete remainingCalls[CONVERSATION_TIMEBOX_TOOL_NAME];
    try{
        return Object.freeze({
            handled:true,
            remainingCalls:Object.freeze(remainingCalls),
            result:Object.freeze({
                status:'fulfilled',
                value:controller.applyCommand(argumentsValue)
            })
        });
    }catch(reason){
        return Object.freeze({
            handled:true,
            remainingCalls:Object.freeze(remainingCalls),
            result:Object.freeze({status:'rejected',reason})
        });
    }
}

export {
    appendConversationTimeboxOpeningInstruction,
    CONVERSATION_TIMEBOX_LIMIT_MESSAGE,
    CONVERSATION_TIMEBOX_OPENING_INSTRUCTION,
    CONVERSATION_TIMEBOX_TOOL_NAME,
    ConversationSubmissionBarrier,
    consumeConversationTimeboxCall,
    conversationTimeboxTool,
    conversationTimeboxSubmissionKey,
    createConversationTimeboxControlMessage,
    formatConversationElapsed,
    normalizeConversationTimeboxCommand,
    requireConversationTimeboxDelivery
};

export default ConversationTimebox;
