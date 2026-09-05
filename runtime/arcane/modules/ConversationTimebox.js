import { arcaneLogging } from 'arcane-os/logging';
import {createArcaneEventSource} from 'arcane-os/event-manager';

const CONVERSATION_TIMEBOX_TOOL_NAME='conversation_timebox';
const CONVERSATION_TIMEBOX_TICK_MS=1000;
const MAX_DATE_MILLISECONDS=8_640_000_000_000_000;

const conversationTimeboxEventTypes={
    change:'conversation-timebox-change'
};

const conversationTimeboxErrorCodes={
    disposed:'ARCANE_CONVERSATION_TIMEBOX_DISPOSED',
    subscriptionHandlerInvalid:'ARCANE_CONVERSATION_TIMEBOX_SUBSCRIPTION_HANDLER_INVALID',
    subscriptionOptionsInvalid:'ARCANE_CONVERSATION_TIMEBOX_SUBSCRIPTION_OPTIONS_INVALID'
};

const conversationTimeboxReasons={
    deadlineReached:'conversation-timebox-deadline-reached',
    disposed:'conversation-timebox-disposed',
    elapsedTimeAdvanced:'conversation-timebox-elapsed-time-advanced',
    limitAdjusted:'conversation-timebox-limit-adjusted',
    limitCleared:'conversation-timebox-limit-cleared',
    limitSet:'conversation-timebox-limit-set',
    snapshotReplayed:'conversation-timebox-snapshot-replayed',
    started:'conversation-timebox-started'
};

export const CONVERSATION_TIMEBOX_EVENT_TYPES={...conversationTimeboxEventTypes};
export const CONVERSATION_TIMEBOX_ERROR_CODES={...conversationTimeboxErrorCodes};
export const CONVERSATION_TIMEBOX_REASONS={...conversationTimeboxReasons};

const CONVERSATION_TIMEBOX_OPENING_INSTRUCTION=`Before any other intake question, ask exactly one timing question: "Do you have a limited amount of time to talk right now?" Ask no other question in that opening reply, and wait for the answer before continuing the app's normal intake. The elapsed conversation timer is already visible. A time limit applies only to this conversation. Never infer, round, or invent a duration. The conversation_timebox tool is available on every turn. When the user explicitly sets a duration, call it with action "set" and convert the exact stated duration to whole milliseconds. When the user explicitly adds time, call it with action "adjust" and convert the exact added duration to whole milliseconds. When the user explicitly says there is no limit, asks to remove it, or chooses to continue after a due check without setting another duration, call it with action "clear". Every call must include a nonempty message containing the brief plain-language progress or next-step text shown to the user; do not claim the time check changed before the tool result confirms it. A duration is always sent as duration_milliseconds; for example, 75 seconds is 75000 and 10 minutes is 600000. If the duration is vague or ranged, ask one focused question and do not call the tool yet. Adapt the pace and prioritize the most important next action within an active limit without skipping safety. A message that the agreed time check is due is a check-in, not a request to end: ask whether the user wants to end now or continue, and do not assume their choice.`;

const CONVERSATION_TIMEBOX_LIMIT_MESSAGE='The agreed conversation time check is due. Please ask whether I want to end now or continue, and do not assume my choice or set another limit unless I explicitly state one.';

const conversationTimeboxTool={
    type:'function',
    function:{
        name:CONVERSATION_TIMEBOX_TOOL_NAME,
        description:'Control the current conversation time check whenever the user explicitly sets, adds, removes, or continues past it. Use action "set" to replace the deadline relative to now, "adjust" to add time to the active deadline, and "clear" to remove the deadline, including continuing after a due check without a new duration. Convert exact stated units to whole milliseconds; never infer, round, or choose a default.',
        parameters:{
            type:'object',
            properties:{
                action:{
                    type:'string',
                    enum:['set','adjust','clear'],
                    description:'Set a new deadline, add time to the active deadline, or clear the deadline.'
                },
                message:{
                    type:'string',
                    minLength:1,
                    description:'Brief plain-language progress or next-step text shown to the user for this tool call. Do not claim the time check changed before the tool result confirms it.'
                },
                duration_milliseconds:{
                    type:'integer',
                    minimum:0,
                    description:'The exact positive whole-millisecond duration. Required for "set" and "adjust"; ignored for "clear". Examples: 75 seconds = 75000; 10 minutes = 600000.'
                }
            },
            required:['action','message']
        }
    }
};

function isPlainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
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
    if(!['set','adjust','clear'].includes(input.action)){
        throw new TypeError('Conversation timebox action must be "set", "adjust", or "clear".');
    }
    if(typeof input.message!=='string'||!input.message.trim()){
        throw new TypeError('Conversation timebox message must contain user-facing text.');
    }
    if(input.action==='clear'){
        return {...input,action:'clear',message:input.message};
    }
    if(!Number.isSafeInteger(input.duration_milliseconds)||input.duration_milliseconds<=0){
        throw new TypeError('duration_milliseconds must be an explicit positive whole number.');
    }
    return {
        ...input,
        action:input.action,
        durationMilliseconds:input.duration_milliseconds,
        message:input.message
    };
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

function createConversationTimeboxControlMessage(action,milliseconds){
    if(action==='clear'){
        return 'I used the conversation controls to confirm that I do not have a time limit right now. The elapsed timer should keep running. The limit is already cleared; do not infer or set another limit unless I explicitly state one.';
    }
    if(
        !['set','adjust'].includes(action)
        ||!Number.isSafeInteger(milliseconds)
        ||milliseconds<=0
    ){
        throw new TypeError('A timebox control message requires an explicit positive whole-millisecond duration.');
    }
    const duration=formatConversationElapsed(milliseconds);
    return action==='adjust'
        ?`I used the conversation controls to add ${duration} to the active check-in. The timer is already adjusted. Please adapt our pace and priorities to it.`
        :`I used the conversation controls to set a check-in ${duration} from now. The timer is already set. Please adapt our pace and priorities to it, and do not reset it unless I explicitly revise it.`;
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
    arcaneLogging.error('A conversation timebox listener failed.',error);
}

function conversationTimeboxError(message,code,reason,ErrorType=Error){
    const error=new ErrorType(message);
    error.code=code;
    error.reason=reason;
    return error;
}

function isAbortSignal(value){
    return Boolean(value)
        &&typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function';
}

function normalizeSubscriptionOptions(value={}){
    if(!isPlainRecord(value)){
        throw conversationTimeboxError(
            'Conversation timebox subscription options must be a plain object.',
            conversationTimeboxErrorCodes.subscriptionOptionsInvalid,
            'conversation-timebox-subscription-options-invalid',
            TypeError
        );
    }
    if((value.once!==undefined
        &&typeof value.once!=='boolean'
    )||(
        value.signal!==undefined
        &&value.signal!==null
        &&!isAbortSignal(value.signal)
    )){
        throw conversationTimeboxError(
            'Conversation timebox subscription once must be boolean and signal must be an AbortSignal.',
            conversationTimeboxErrorCodes.subscriptionOptionsInvalid,
            'conversation-timebox-subscription-options-invalid',
            TypeError
        );
    }
    return {once:value.once===true,signal:value.signal??null};
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
    #durationMilliseconds=null;
    #events;
    #intervalHandle=null;
    #nowMs=null;
    #operationSequence=0;
    #revision=0;
    #schedule;
    #setAtMs=null;
    #startedAtMs=null;
    #tickMs;

    constructor(options={}){
        if(!isPlainRecord(options)){
            throw new TypeError('Conversation timebox options must be a plain object.');
        }
        this.#clock=options.clock??defaultClock;
        this.#schedule=options.schedule??defaultSchedule;
        this.#cancel=options.cancel??defaultCancel;
        const onListenerError=options.onListenerError??reportConversationTimeboxListenerError;
        this.#tickMs=options.tickMs??CONVERSATION_TIMEBOX_TICK_MS;

        for(const [name,value] of [
            ['clock',this.#clock],
            ['schedule',this.#schedule],
            ['cancel',this.#cancel],
            ['onListenerError',onListenerError]
        ]){
            if(typeof value!=='function'){
                throw new TypeError(`${name} must be a function.`);
            }
        }
        if(!Number.isFinite(this.#tickMs)||this.#tickMs<=0){
            throw new RangeError('tickMs must be a positive finite number.');
        }
        this.#events=createArcaneEventSource(this,{
            source:'conversation-timebox',
            eventTypes:Object.values(conversationTimeboxEventTypes),
            onListenerError
        });
    }

    get limitReachedMessage(){
        return CONVERSATION_TIMEBOX_LIMIT_MESSAGE;
    }

    controlMessage(action,milliseconds){
        return createConversationTimeboxControlMessage(action,milliseconds);
    }

    start(){
        this.#assertActive();
        if(this.#startedAtMs!==null){
            return this.snapshot();
        }
        const now=this.#readClock();
        this.#startAt(now,true,conversationTimeboxReasons.started);
        return this.snapshot();
    }

    setLimitMilliseconds(milliseconds,{source='user'}={}){
        this.#assertActive();
        if(!Number.isSafeInteger(milliseconds)||milliseconds<=0){
            throw new TypeError('Conversation time must be an explicit positive whole number of milliseconds.');
        }
        if(typeof source!=='string'||!source.trim()){
            throw new TypeError('Conversation timebox source must contain text.');
        }
        const commandSource=source.trim();
        const now=this.#readClock();
        const dueAtMs=now+milliseconds;
        if(!Number.isSafeInteger(dueAtMs)||dueAtMs>MAX_DATE_MILLISECONDS){
            throw new RangeError('The requested conversation duration exceeds the supported date range.');
        }
        if(this.#startedAtMs===null){
            this.#startAt(now,false,conversationTimeboxReasons.started);
        }

        this.#durationMilliseconds=milliseconds;
        this.#setAtMs=now;
        this.#dueAtMs=dueAtMs;
        this.#dueRevision=null;
        this.#revision++;
        this.#nowMs=now;
        this.#notify('change',conversationTimeboxReasons.limitSet,commandSource);
        return this.snapshot();
    }

    adjustLimitMilliseconds(milliseconds,{source='user'}={}){
        this.#assertActive();
        if(!Number.isSafeInteger(milliseconds)||milliseconds<=0){
            throw new TypeError('Conversation adjustment must be an explicit positive whole number of milliseconds.');
        }
        if(typeof source!=='string'||!source.trim()){
            throw new TypeError('Conversation timebox source must contain text.');
        }
        const commandSource=source.trim();
        if(this.#dueAtMs===null){
            throw new Error('An active conversation time check is required before adding time.');
        }

        const now=this.#readClock();
        const dueAtMs=Math.max(now,this.#dueAtMs)+milliseconds;
        if(!Number.isSafeInteger(dueAtMs)||dueAtMs>MAX_DATE_MILLISECONDS){
            throw new RangeError('The requested conversation adjustment exceeds the supported date range.');
        }

        this.#durationMilliseconds=dueAtMs-now;
        this.#setAtMs=now;
        this.#dueAtMs=dueAtMs;
        this.#dueRevision=null;
        this.#revision++;
        this.#nowMs=now;
        this.#notify('change',conversationTimeboxReasons.limitAdjusted,commandSource);
        return this.snapshot();
    }

    clearLimit({source='user'}={}){
        this.#assertActive();
        if(typeof source!=='string'||!source.trim()){
            throw new TypeError('Conversation timebox source must contain text.');
        }
        const commandSource=source.trim();
        if(this.#startedAtMs===null){
            this.start();
        }
        this.#durationMilliseconds=null;
        this.#setAtMs=null;
        this.#dueAtMs=null;
        this.#dueRevision=null;
        this.#revision++;
        this.#nowMs=this.#readClock();
        this.#notify('change',conversationTimeboxReasons.limitCleared,commandSource);
        return this.snapshot();
    }

    applyCommand(value){
        const command=normalizeConversationTimeboxCommand(value);
        let state;
        if(command.action==='clear'){
            state=this.clearLimit({source:'tool'});
        }else{
            state=command.action==='adjust'
                ?this.adjustLimitMilliseconds(
                    command.durationMilliseconds,
                    {source:'tool'}
                )
                :this.setLimitMilliseconds(
                    command.durationMilliseconds,
                    {source:'tool'}
                );
        }
        return {...state,message:command.message};
    }

    subscribe(listener,options={}){
        if(typeof listener!=='function'){
            throw conversationTimeboxError(
                'Conversation timebox listener must be a function.',
                conversationTimeboxErrorCodes.subscriptionHandlerInvalid,
                'conversation-timebox-subscription-handler-invalid',
                TypeError
            );
        }
        this.#assertActive();
        const normalized=normalizeSubscriptionOptions(options);
        function forwardConversationTimeboxChange(event){
            listener(event.detail.state,event.detail.event);
        }
        const unsubscribe=this.#events.on(
            conversationTimeboxEventTypes.change,
            forwardConversationTimeboxChange,
            normalized
        );
        if(normalized.signal?.aborted)return unsubscribe;
        try{
            listener(
                this.snapshot(),
                {
                    type:'snapshot',
                    reason:conversationTimeboxReasons.snapshotReplayed,
                    revision:this.#revision,
                    commandSource:null
                }
            );
        }catch(error){
            unsubscribe();
            throw error;
        }
        return unsubscribe;
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

        return {
            status,
            startedAtMs:this.#startedAtMs,
            elapsedMs,
            durationMilliseconds:this.#durationMilliseconds,
            setAtMs:this.#setAtMs,
            dueAtMs:this.#dueAtMs,
            remainingMs,
            revision:this.#revision,
            dueRevision:this.#dueRevision
        };
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
        this.#notify('change',conversationTimeboxReasons.disposed);
        const finalSnapshot=this.snapshot();
        this.#events.dispose();
        return finalSnapshot;
    }

    #assertActive(){
        if(this.#disposed){
            throw conversationTimeboxError(
                'The conversation timebox has been disposed.',
                conversationTimeboxErrorCodes.disposed,
                conversationTimeboxReasons.disposed
            );
        }
    }

    #readClock(){
        const now=this.#clock();
        if(!Number.isSafeInteger(now)||now<0||now>MAX_DATE_MILLISECONDS){
            throw new TypeError('Conversation timebox clock must return a supported non-negative integer timestamp.');
        }
        return this.#nowMs===null?now:Math.max(now,this.#nowMs);
    }

    #startAt(now,notify,reason){
        const intervalHandle=this.#schedule(
            this.#tick.bind(this),
            this.#tickMs
        );
        this.#startedAtMs=now;
        this.#nowMs=now;
        this.#intervalHandle=intervalHandle;
        if(notify){
            this.#notify('change',reason);
        }
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
        this.#notify(
            becameDue?'due':'tick',
            becameDue
                ?conversationTimeboxReasons.deadlineReached
                :conversationTimeboxReasons.elapsedTimeAdvanced
        );
    }

    #notify(type,reason,commandSource=null){
        const state=this.snapshot();
        const event={
            type,
            reason,
            revision:this.#revision,
            commandSource
        };
        const operationId=`${this.#events.instanceId}:change:${(++this.#operationSequence).toString(36)}`;
        this.#events.dispatch(
            conversationTimeboxEventTypes.change,
            {state:{...state},event:{...event}},
            {
                operationId,
                publicDetail:{
                    reason,
                    status:state.status,
                    revision:state.revision,
                    commandSource
                }
            }
        );
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
        return {
            handled:false,
            remainingCalls,
            result:null
        };
    }

    const argumentsValue=remainingCalls[CONVERSATION_TIMEBOX_TOOL_NAME];
    delete remainingCalls[CONVERSATION_TIMEBOX_TOOL_NAME];
    try{
        return {
            handled:true,
            remainingCalls,
            result:{
                status:'fulfilled',
                value:controller.applyCommand(argumentsValue)
            }
        };
    }catch(reason){
        return {
            handled:true,
            remainingCalls,
            result:{status:'rejected',reason}
        };
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
