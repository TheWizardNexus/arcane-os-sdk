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

const completeValue=(value)=>value;

let credentials='include';
const DEFAULT_TTS_RESPONSE_FORMAT='opus';
const DEFAULT_TTS_SEGMENTATION={
    punctuation:'sentence',
    wordCadence:null
};
const TTS_PUNCTUATION_MODES=new Set(['sentence','any','none']);
// A complete punctuation run is a boundary unless the whole run consists of
// apostrophe, comma, or dash punctuation joining Unicode letters or numbers.
// The streaming expression leaves a trailing joining run for the next chunk.
const TTS_ANY_PUNCTUATION=/(?<!\p{P})(?:(?<![\p{L}\p{N}])\p{P}+(?!\p{P})(?=[\s\S])|\p{P}+(?!\p{P})(?=[^\p{L}\p{N}])|\p{P}*[^\P{P}'\u2019\uFF07,\u060C\u3001\uFF0C\p{Pd}]\p{P}*)(?!\p{P})/gu;
const TTS_ANY_PUNCTUATION_AT_END=/(?<!\p{P})(?:(?<![\p{L}\p{N}])\p{P}+|\p{P}+(?![\p{L}\p{N}])|\p{P}*[^\P{P}'\u2019\uFF07,\u060C\u3001\uFF0C\p{Pd}]\p{P}*)(?!\p{P})/gu;
credentials='omit';

const BUILT_IN_AI_SERVICES=new Set(['OPENAI','OLLAMA','LOCAL_SPEACH']);
const AI_REASONING_EFFORTS=new Set(['none','low','medium','high','max']);
export const AI_READY_EVENT='ai-ready';
const AI_TTS_FAILURE_EVENT='ai-tts-failure';
export const AI_INITIALIZATION_ERROR_CODES=completeValue({
    userReadyRegistrationCollision:
        'ARCANE_AI_USER_READY_REGISTRATION_COLLISION'
});
export const AI_INITIALIZATION_REASONS=completeValue({
    initialized:'ai-initialized',
    userReadyRegistrationCollision:'ai-user-ready-registration-collision'
});
export const AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL=
    'arcane-ai-browser-speech-configuration/1';
export const AI_BROWSER_SPEECH_EVENT_TYPES=completeValue({
    configurationCancelled:'ai-browser-speech-configuration-cancelled',
    configurationError:'ai-browser-speech-configuration-error',
    configurationStarted:'ai-browser-speech-configuration-started',
    configured:'ai-browser-speech-configured',
    disposed:'ai-browser-speech-disposed'
});
export const AI_BROWSER_SPEECH_ERROR_CODES=completeValue({
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
export const AI_BROWSER_SPEECH_REASONS=completeValue({
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

function normalizeAIReasoningEffort(value){
    if(value===undefined||value===null||value===''){
        return '';
    }
    if(typeof value!=='string'||!AI_REASONING_EFFORTS.has(value)){
        const error=new TypeError(
            'AI reasoningEffort must be none, low, medium, high, or max.'
        );
        error.code='AI_REASONING_EFFORT_INVALID';
        throw error;
    }
    return value;
}

function aiProviderError(message,code,cause){
    const error=cause===undefined
        ?new Error(message)
        :new Error(message,{cause});
    error.code=code;
    return error;
}

function aiStructuralError(code,message,cause){
    const error=cause===undefined
        ?new TypeError(message)
        :new TypeError(message,{cause});
    error.code=code;
    return error;
}

function isPlainAIRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value)){
        return false;
    }
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function normalizeTTSSegmentation(value,current=DEFAULT_TTS_SEGMENTATION){
    if(value===undefined||value===null){
        return {...current};
    }
    if(!isPlainAIRecord(value)){
        throw new TypeError('TTS segmentation must be a plain object.');
    }

    const punctuation=value.punctuation===undefined
        ?current.punctuation
        :value.punctuation;
    if(!TTS_PUNCTUATION_MODES.has(punctuation)){
        throw new TypeError(
            'TTS segmentation punctuation must be sentence, any, or none.'
        );
    }

    const wordCadence=value.wordCadence===undefined
        ?current.wordCadence
        :value.wordCadence;
    if(
        wordCadence!==null
        &&(!Number.isSafeInteger(wordCadence)||wordCadence<1)
    ){
        throw new RangeError(
            'TTS segmentation wordCadence must be null or a positive integer.'
        );
    }

    return {punctuation,wordCadence};
}

function requireAIToolMessageSchemas(value,label='AI tools'){
    if(!Array.isArray(value)){
        throw aiStructuralError(
            'AI_CHAT_INVALID_TOOL_CALL',
            `${label} must be an array.`
        );
    }
    for(let index=0;index<value.length;index+=1){
        const tool=value[index];
        const parameters=tool?.function?.parameters;
        const messageSchema=parameters?.properties?.message;
        if(
            !isPlainAIRecord(tool)
            ||tool.type!=='function'
            ||!isPlainAIRecord(tool.function)
            ||!isPlainAIRecord(parameters)
            ||parameters.type!=='object'
            ||!isPlainAIRecord(parameters.properties)
            ||!isPlainAIRecord(messageSchema)
            ||messageSchema.type!=='string'
            ||!Number.isInteger(messageSchema.minLength)
            ||messageSchema.minLength<1
            ||!Array.isArray(parameters.required)
            ||!parameters.required.includes('message')
        ){
            throw aiStructuralError(
                'AI_CHAT_TOOL_MESSAGE_REQUIRED',
                `${label}[${index}] must require a nonempty string parameters.properties.message.`
            );
        }
    }
}

function normalizeAIStructuralToolCall(call,label='Structural tool call'){
    if(
        !isPlainAIRecord(call)
        ||typeof call.id!=='string'
        ||!call.id.trim()
        ||call.type!=='function'
        ||!isPlainAIRecord(call.function)
        ||typeof call.function.name!=='string'
        ||!call.function.name.trim()
        ||typeof call.function.arguments!=='string'
    ){
        throw aiStructuralError(
            'AI_CHAT_INVALID_TOOL_CALL',
            `${label} is not a complete structural function call.`
        );
    }
    let argumentsRecord;
    try{
        argumentsRecord=JSON.parse(call.function.arguments);
    }catch(cause){
        throw aiStructuralError(
            'AI_CHAT_INVALID_TOOL_CALL',
            `${label} arguments must encode a JSON object.`,
            cause
        );
    }
    if(!isPlainAIRecord(argumentsRecord)){
        throw aiStructuralError(
            'AI_CHAT_INVALID_TOOL_CALL',
            `${label} arguments must encode a JSON object.`
        );
    }
    if(typeof argumentsRecord.message!=='string'||!argumentsRecord.message.trim()){
        throw aiStructuralError(
            'AI_CHAT_TOOL_MESSAGE_REQUIRED',
            `${label} arguments must include a nonempty user-facing message.`
        );
    }
    return {
        ...call,
        id:call.id,
        type:'function',
        function:{
            ...call.function,
            name:call.function.name,
            arguments:call.function.arguments
        }
    };
}

function validateAIRequestMessages(messages=[]){
    if(!Array.isArray(messages)){
        throw new TypeError('AI messages must be an array.');
    }
    const pendingToolCallIds=new Set();
    for(let messageIndex=0;messageIndex<messages.length;messageIndex+=1){
        const message=messages[messageIndex];
        const calls=message?.tool_calls;
        let openedToolCall=false;
        if(calls!==undefined){
            if(message?.role!=='assistant'||!Array.isArray(calls)){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_TOOL_CALL',
                    `AI messages[${messageIndex}].tool_calls is invalid.`
                );
            }
            if(pendingToolCallIds.size&&calls.length){
                throw aiStructuralError(
                    'AI_CHAT_TOOL_RESULT_REQUIRED',
                    'Every pending structural tool result must be supplied before another assistant tool-call sequence.'
                );
            }
            if(calls.length){
                for(let callIndex=0;callIndex<calls.length;callIndex+=1){
                    const normalized=normalizeAIStructuralToolCall(
                        calls[callIndex],
                        `AI messages[${messageIndex}].tool_calls[${callIndex}]`
                    );
                    if(pendingToolCallIds.has(normalized.id)){
                        throw aiStructuralError(
                            'AI_CHAT_INVALID_TOOL_CALL',
                            `AI messages[${messageIndex}].tool_calls contains a duplicate ID.`
                        );
                    }
                    pendingToolCallIds.add(normalized.id);
                }
                openedToolCall=true;
            }
        }
        if(message?.role==='tool'){
            if(typeof message.content!=='string'||!message.content.trim()){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_TOOL_MESSAGE',
                    `AI messages[${messageIndex}] must contain a nonblank user-facing tool result.`
                );
            }
            if(
                !pendingToolCallIds.size
                ||typeof message.tool_call_id!=='string'
                ||!pendingToolCallIds.has(message.tool_call_id)
            ){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_TOOL_MESSAGE',
                    `AI messages[${messageIndex}] does not settle the pending structural tool call.`
                );
            }
            pendingToolCallIds.delete(message.tool_call_id);
        }else if(pendingToolCallIds.size&&!openedToolCall){
            throw aiStructuralError(
                'AI_CHAT_TOOL_RESULT_REQUIRED',
                `AI messages[${messageIndex}] precedes the pending structural tool result.`
            );
        }
    }
    if(pendingToolCallIds.size){
        throw aiStructuralError(
            'AI_CHAT_TOOL_RESULT_REQUIRED',
            'The pending structural tool call must be settled before requesting another response.'
        );
    }
}

function validateAIStructuralRequest(messages,tools,parallelToolCalls){
    validateAIRequestMessages(messages);
    requireAIToolMessageSchemas(tools);
    if(parallelToolCalls!==undefined&&typeof parallelToolCalls!=='boolean'){
        throw new TypeError('AI parallelToolCalls must be a boolean when provided.');
    }
}

function normalizeAICompletionToolCalls(completion){
    const calls=[];
    const hasMessage=Boolean(
        completion
        &&typeof completion==='object'
        &&Object.hasOwn(completion,'message')
    );
    const hasChoices=Boolean(
        completion
        &&typeof completion==='object'
        &&Object.hasOwn(completion,'choices')
    );
    if(hasMessage&&hasChoices){
        throw aiStructuralError(
            'AI_CHAT_INVALID_RESPONSE',
            'The AI completion must not mix message and choices envelopes.'
        );
    }
    if(hasChoices&&!Array.isArray(completion.choices)){
        throw aiStructuralError(
            'AI_CHAT_INVALID_RESPONSE',
            'The AI completion choices envelope must be an array.'
        );
    }
    const messages=hasChoices
        ?completion.choices.map(choice=>choice?.message)
        :hasMessage
            ?[completion.message]
            :[];
    for(let messageIndex=0;messageIndex<messages.length;messageIndex+=1){
        const toolCalls=messages[messageIndex]?.tool_calls;
        if(toolCalls!==undefined&&!Array.isArray(toolCalls)){
            throw aiStructuralError(
                'AI_CHAT_INVALID_TOOL_CALL',
                `AI response message ${messageIndex+1} contains invalid structural tool calls.`
            );
        }
        const messageIds=new Set();
        for(let callIndex=0;callIndex<(toolCalls??[]).length;callIndex+=1){
            const normalized=normalizeAIStructuralToolCall(
                toolCalls[callIndex],
                `AI response structural tool call ${messageIndex+1}.${callIndex+1}`
            );
            if(messageIds.has(normalized.id)){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_TOOL_CALL',
                    `AI response message ${messageIndex+1} contains a duplicate structural tool-call ID.`
                );
            }
            messageIds.add(normalized.id);
            if(messageIndex===0)calls.push(normalized);
        }
    }
    return calls;
}

function sameAIDataValue(left,right,seen=new Map()){
    if(Object.is(left,right))return true;
    if(!left||!right||typeof left!=='object'||typeof right!=='object')return false;
    if(Array.isArray(left)!==Array.isArray(right))return false;
    const matched=seen.get(left);
    if(matched!==undefined)return matched===right;
    seen.set(left,right);
    if(Array.isArray(left)){
        return left.length===right.length
            &&left.every((value,index)=>sameAIDataValue(value,right[index],seen));
    }
    if(!isPlainAIRecord(left)||!isPlainAIRecord(right))return false;
    const leftKeys=Reflect.ownKeys(left).filter(key=>Object.prototype.propertyIsEnumerable.call(left,key));
    const rightKeys=Reflect.ownKeys(right).filter(key=>Object.prototype.propertyIsEnumerable.call(right,key));
    return leftKeys.length===rightKeys.length
        &&leftKeys.every(key=>Object.prototype.propertyIsEnumerable.call(right,key)
            &&sameAIDataValue(left[key],right[key],seen));
}

function sameAIStructuralToolCall(left,right){
    return sameAIDataValue(left,right);
}

function sameAICanonicalToolCall(left,right){
    return left?.id===right?.id
        &&left?.type===right?.type
        &&left?.function?.name===right?.function?.name
        &&left?.function?.arguments===right?.function?.arguments;
}

function assertAIStreamToolCallCorrelation(
    streamedCalls,
    terminalCalls,
    label='AI stream'
){
    if(!streamedCalls.length){
        return;
    }
    if(
        streamedCalls.length!==terminalCalls.length
        ||streamedCalls.some(
            (call,index)=>!sameAIStructuralToolCall(call,terminalCalls[index])
        )
    ){
        throw aiStructuralError(
            'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
            `${label} changed or omitted its terminal structural tool call.`
        );
    }
}

function normalizeAIStreamToolCallObservation(completion,label){
    try{
        return normalizeAICompletionToolCalls(completion);
    }catch(cause){
        if(
            cause?.code==='AI_CHAT_INVALID_TOOL_CALL'
            ||cause?.code==='AI_CHAT_TOOL_MESSAGE_REQUIRED'
        ){
            throw aiStructuralError(
                'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                `${label} did not retain a complete structural tool call.`,
                cause
            );
        }
        throw cause;
    }
}

function isAIStreamStructuralKey(key){
    return key==='tool_calls'
        ||key==='toolCalls'
        ||key==='tool_call'
        ||key==='toolCall'
        ||key==='function_call'
        ||key==='functionCall';
}

const OMITTED_AI_STREAM_DATA=Symbol('omitted-ai-stream-data');

function projectAIStreamData(value,seen=new Map()){
    if(value===null||value===undefined||typeof value!=='object'){
        return value;
    }
    if(seen.has(value)) return seen.get(value);
    if(Array.isArray(value)){
        const result=[];
        seen.set(value,result);
        for(const item of value){
            const projected=projectAIStreamData(item,seen);
            if(projected!==OMITTED_AI_STREAM_DATA)result.push(projected);
        }
        return result.length||value.length===0?result:OMITTED_AI_STREAM_DATA;
    }
    const result={};
    seen.set(value,result);
    let sourceDataFields=0;
    for(const [key,descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value)
    )){
        if(!Object.hasOwn(descriptor,'value')){
            continue;
        }
        sourceDataFields+=1;
        if(isAIStreamStructuralKey(key))continue;
        const projected=projectAIStreamData(descriptor.value,seen);
        if(projected!==OMITTED_AI_STREAM_DATA)result[key]=projected;
    }
    return Object.keys(result).length||sourceDataFields===0
        ?result
        :OMITTED_AI_STREAM_DATA;
}

function projectAIStreamChunk(value){
    return projectAIStreamData(value);
}

function createBuiltInAIStreamBridge(execute,sourceSignal){
    const controller=new AbortController();
    const queue=[];
    const waiters=[];
    let complete=false;
    let failure=null;
    let detached=false;

    function forwardBuiltInAIStreamAbort(){
        if(!controller.signal.aborted){
            controller.abort(sourceSignal?.reason);
        }
    }

    function detachBuiltInAIStreamAbort(){
        if(detached){
            return;
        }
        detached=true;
        sourceSignal?.removeEventListener?.(
            'abort',
            forwardBuiltInAIStreamAbort
        );
    }

    if(sourceSignal?.aborted){
        forwardBuiltInAIStreamAbort();
    }else{
        sourceSignal?.addEventListener?.(
            'abort',
            forwardBuiltInAIStreamAbort,
            {once:true}
        );
    }

    function emitBuiltInAIStreamChunk(chunk){
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

    function finishBuiltInAIStream(error){
        if(complete){
            return;
        }
        complete=true;
        failure=error||null;
        detachBuiltInAIStreamAbort();
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
        function executeBuiltInAIStream(){
            if(controller.signal.aborted){
                throw normalizeAIRequestAbort(controller.signal.reason);
            }
            return execute({
                emit:emitBuiltInAIStreamChunk,
                signal:controller.signal
            });
        }
    ).then(
        function acceptBuiltInAIStreamResult(value){
            finishBuiltInAIStream(null);
            return value;
        },
        function rejectBuiltInAIStreamResult(error){
            const normalized=isAIRequestAbort(error,controller.signal)
                ?normalizeAIRequestAbort(error)
                :error;
            finishBuiltInAIStream(normalized);
            throw normalized;
        }
    );
    result.catch(function retainBuiltInAIStreamFailure() {});

    async function cancelBuiltInAIStream(reason){
        if(!controller.signal.aborted){
            controller.abort(reason);
        }
        await result.catch(function retainCancelledBuiltInAIStream() {});
        return true;
    }

    const handle={
        result,
        cancel:cancelBuiltInAIStream,
        next:function readBuiltInAIStreamChunk(){
            if(queue.length){
                return Promise.resolve({value:queue.shift(),done:false});
            }
            if(complete){
                return failure
                    ?Promise.reject(failure)
                    :Promise.resolve({value:undefined,done:true});
            }
            return new Promise(function waitForBuiltInAIStreamChunk(resolve,reject){
                waiters.push({resolve,reject});
            });
        },
        return:async function returnBuiltInAIStream(value){
            await cancelBuiltInAIStream(
                aiProviderError(
                    'The built-in AI stream consumer stopped before completion.',
                    'ARCANE_AI_REQUEST_ABORTED'
                )
            );
            return {value,done:true};
        },
        throw:async function throwBuiltInAIStream(error){
            await cancelBuiltInAIStream(error);
            throw error;
        },
        [Symbol.asyncIterator]:function iterateBuiltInAIStream(){
            return this;
        }
    };
    return completeValue(handle);
}

function normalizeAIStartupOptions(options){
    if(options===undefined){
        return completeValue({
            startLanguageModel:true,
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
            key!=='startLanguageModel'
            &&key!=='startMuted'
            &&key!=='startTranscription'
            &&key!=='signal'
        )){
            throw new TypeError('AI startup options contain an unknown option.');
        }
        if(!Object.hasOwn(descriptors[key],'value')){
            throw new TypeError(`AI startup options.${key} must be a data property.`);
        }
    }
    const startLanguageModel=Object.hasOwn(descriptors,'startLanguageModel')
        ?descriptors.startLanguageModel.value
        :true;
    const startMuted=Object.hasOwn(descriptors,'startMuted')
        ?descriptors.startMuted.value
        :true;
    const startTranscription=Object.hasOwn(descriptors,'startTranscription')
        ?descriptors.startTranscription.value
        :false;
    const signal=Object.hasOwn(descriptors,'signal')
        ?descriptors.signal.value
        :null;
    if(typeof startLanguageModel!=='boolean'){
        throw new TypeError('AI startup startLanguageModel must be a boolean.');
    }
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
    return completeValue({
        startLanguageModel,
        startMuted,
        startTranscription,
        signal
    });
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

function closedRecord(value,keys,required,label){
    if(!value
        ||typeof value!=='object'
        ||Array.isArray(value)
        ||![Object.prototype,null].includes(Object.getPrototypeOf(value))){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label} must be a plain data record.`
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
        ||value.length<1){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label} must be a nonempty trimmed string.`
        );
    }
    return value;
}

function normalizeBrowserSpeechRole(value,role){
    const label=`AI browser speech ${role}`;
    const descriptors=closedRecord(
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
    let secure=false;
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
        if(!graph||typeof graph!=='object'){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
                AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
                `${label}.graph must be an SDK-created artifact graph.`
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
    if(hasSecurity){
        // Security is an intent-only seam. Stale or future fields do not run
        // checks in ordinary mode, and secure mode requires user review before
        // an implementation may be enabled.
        secure=descriptors.security.value?.secure===true;
    }
    if(typeof descriptors.offline.value!=='boolean'){
        throw aiBrowserSpeechError(
            AI_BROWSER_SPEECH_ERROR_CODES.configurationContractMismatch,
            AI_BROWSER_SPEECH_REASONS.configurationContractMismatch,
            `${label}.offline must be a boolean.`
        );
    }
    return completeValue({
        providerId,
        ...(hasGraph
            ?{
                graph:descriptors.graph.value,
                ...(secure?{security:{secure:true}}:{})
            }
            :{
                model:descriptors.model.value,
                runtime:descriptors.runtime.value,
                ...(secure?{security:{secure:true}}:{})
            }),
        offline:descriptors.offline.value
    });
}

function normalizeBrowserSpeechConfiguration(value){
    const descriptors=closedRecord(
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
    return completeValue({
        configuration:value,
        id,
        dbopfs,
        ...(tableName?{tableName}:{}),
        roles:completeValue(roles),
        ...Object.fromEntries(roles.map(role=>[
            role,
            normalizeBrowserSpeechRole(descriptors[role].value,role)
        ]))
    });
}

function normalizeBrowserSpeechOperationOptions(value,label){
    if(value===undefined)return completeValue({signal:null});
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
    return completeValue({signal});
}

class AI {
    // This is the enum section for inference configuration
    #service = {
        baseURL: {
            // OPENAI remains the established public route identifier;
            // remote LLM chat is provided by TWiN Cloud.
            OPENAI: 'https://inference.do-ai.run/v1'
        },
        sttURL: {
            LOCAL_SPEACH: 'http://127.0.0.1:8011/v1'
        },
        ttsURL: {
            LOCAL_SPEACH: 'http://127.0.0.1:8011/v1'
        },
    }

    #paths = {
        chat: {
            OPENAI: '/chat/completions'
        },
        stt: {
            LOCAL_SPEACH: '/audio/transcriptions'
        },
        tts: {
            LOCAL_SPEACH: '/audio/speech'
        }
    }

    #models = {
        OPENAI:'openai-gpt-oss-120b'
    }

    #sttModels = {
        LOCAL_SPEACH: 'whisper-small'
    }

    #ttsModels = {
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
                'Authorization': `Bearer ${this.twinKey}`
            }
        };
    }

    get #ttsHeaders(){
        return {
            LOCAL_SPEACH: {
                'Content-Type': 'application/json',
            }
        };
    }

    get #sttHeaders(){
        return {
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
                eventTypes:completeValue(
                    [
                        AI_READY_EVENT,
                        AI_TTS_FAILURE_EVENT,
                        ...Object.values(AI_BROWSER_SPEECH_EVENT_TYPES)
                    ]
                )
            }
        );

        const preferences=[
            llmService||'OPENAI',
            sttService||'LOCAL_SPEACH',
            ttsService||'LOCAL_SPEACH',
            model||'OPENAI',
            modelTTS||'LOCAL_SPEACH',
            modelSTT||'LOCAL_SPEACH'
        ];
        this.setAI(
            ...preferences
        );

        const runtime=this;
        this.#stopOllamaReady=arcaneEvents.subscribe(
            'arcane-ollama-ready',
            function reconcileBuiltInOllamaReadiness(){
                runtime.#retainBuiltInLLMReadiness(
                    runtime.#reconcileBuiltInLLMReadiness()
                );
            }
        );
    }

    #providerRuntime=getAIProviderRuntime();
    #events=null;
    #browserSpeechConfigurationRecord=null;
    #browserSpeechController=null;
    #browserSpeechControllerRoles=completeValue([]);
    #browserSpeechGeneration=0;
    #browserSpeechModulePromise=null;
    #browserSpeechOperationSequence=0;
    #browserSpeechRetiredRecords=new Set();
    #browserSpeechRetiredBuiltInRecords=new Set();
    #browserSpeechTransition=Promise.resolve();
    #builtInLLMProviders=new Map();
    #builtInLLMReadiness=Promise.resolve(null);
    #builtInSpeechProviders=new Map();
    #builtInSpeechReadiness=Promise.resolve(null);
    #speechControlGeneration=0;
    #speechFailureSequence=0;
    #stopOllamaReady=null;
    #ttsSegmentation={...DEFAULT_TTS_SEGMENTATION};
    #preferenceTuple=completeValue([
        'OPENAI',
        'LOCAL_SPEACH',
        'LOCAL_SPEACH',
        'OPENAI',
        'LOCAL_SPEACH',
        'LOCAL_SPEACH'
    ]);

    get providerRuntime(){
        return this.#providerRuntime;
    }

    [AI_PUBLISH_READY](){
        const operationId=`${this.#events.instanceId}:ready:1`;
        const reason=AI_INITIALIZATION_REASONS.initialized;
        const {occurrence}=this.#events.dispatch(
            AI_READY_EVENT,
            completeValue({db:this,operationId,reason}),
            {
                operationId,
                publicDetail:completeValue({
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
    get twinKey(){
        return this.#license
            ||globalThis.arcane?.config?.twinCloud?.accessKey
            ||'';
    }

    set twinKey(value){
        this.#license=typeof value==='string' ? value.trim():'';
        this.#retainBuiltInLLMReadiness(
            this.#reconcileBuiltInLLMReadiness()
        );
        return this.#license;
    }

    // Retain the established credential property while consumers move their
    // user-facing profile field to the TWiN key name.
    get license(){
        return this.twinKey;
    }

    set license(value){
        this.twinKey=value;
        return this.#license;
    }

    #builtInLLMCapability(providerId){
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

    #builtInLLMInspection(providerId,selection){
        const localOnly=providerId==='OLLAMA';
        if(!selection
            ||selection.providerId!==providerId
            ||selection.modelId!==this.model
            ||selection.localOnly!==localOnly
            ||this.llmService!==providerId){
            return completeValue({
                available:false,
                code:'ARCANE_AI_MODEL_AUTHORITY_REQUIRED',
                message:'The selected built-in LLM route does not match the active AI configuration.'
            });
        }
        if(!this.#builtInLLMCapability(providerId)){
            return completeValue({
                available:false,
                code:providerId==='OLLAMA'
                    ?'AI_NATIVE_LOCAL_REQUIRED'
                    :'AI_PROVIDER_NOT_CONFIGURED',
                message:providerId==='OLLAMA'
                    ?'Local AI requires the capability-gated Arcane API.'
                    :'AI provider is not configured.'
            });
        }
        return completeValue({
            available:true,
            authority:completeValue({
                protocol:AI_MODEL_AUTHORITY_PROTOCOL,
                providerId,
                modelId:selection.modelId,
            })
        });
    }

    #createBuiltInLLMProvider(providerId){
        const runtime=this;
        const localOnly=providerId==='OLLAMA';
        let state='unloaded';
        let busy=false;

        function statusBuiltInLLMProvider(){
            if(state==='ready'
                &&!busy
                &&!runtime.#builtInLLMCapability(providerId)){
                state='unloaded';
            }
            return completeValue({
                state,
                loaded:state==='ready',
                busy
            });
        }

        function assertBuiltInLLMSelection(selection){
            const inspection=runtime.#builtInLLMInspection(
                providerId,
                selection
            );
            if(!inspection.available){
                throw aiProviderError(
                    inspection.message,
                    inspection.code
                );
            }
            return inspection;
        }

        function releaseBuiltInLLMRequest(){
            busy=false;
        }

        return completeValue({
            protocol:AI_PROVIDER_PROTOCOL,
            role:'llm',
            id:providerId,
            localOnly,
            catalog:function catalogBuiltInLLMProvider(){
                if(runtime.llmService!==providerId||!runtime.model){
                    return completeValue([]);
                }
                return completeValue([
                    completeValue({id:runtime.model})
                ]);
            },
            inspect:function inspectBuiltInLLMProvider(selection,{signal}={}){
                if(signal?.aborted){
                    throw normalizeAIRequestAbort(signal.reason);
                }
                return runtime.#builtInLLMInspection(providerId,selection);
            },
            status:statusBuiltInLLMProvider,
            load:function loadBuiltInLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(state==='disposed'){
                    throw aiProviderError(
                        'The built-in LLM provider is disposed.',
                        'ARCANE_AI_PROVIDER_DISPOSED'
                    );
                }
                if(busy){
                    throw aiProviderError(
                        'The built-in LLM provider owns an active request.',
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                if(typeof context.progress!=='function'){
                    throw new TypeError(
                        'Built-in LLM provider load progress must be a function.'
                    );
                }
                const inspection=assertBuiltInLLMSelection(context.selection);
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
                return completeValue({
                    authority:inspection.authority,
                    status:statusBuiltInLLMProvider()
                });
            },
            request:function requestBuiltInLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                assertBuiltInLLMSelection(context.selection);
                const current=statusBuiltInLLMProvider();
                if(current.state!=='ready'||!current.loaded){
                    throw aiProviderError(
                        'The built-in LLM provider is not ready.',
                        'ARCANE_AI_ROLE_NOT_READY'
                    );
                }
                if(busy){
                    throw aiProviderError(
                        'The built-in LLM provider owns an active request.',
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                busy=true;
                if(context.operation==='chat'){
                    return Promise.resolve(
                        runtime.#requestBuiltInLLMChat(
                            context.payload,
                            context.signal
                        )
                    ).finally(releaseBuiltInLLMRequest);
                }
                if(context.operation==='stream'){
                    const handle=createBuiltInAIStreamBridge(
                        function executeBuiltInLLMProviderStream(bridge){
                            return runtime.#requestBuiltInLLMStream(
                                context.payload,
                                bridge
                            );
                        },
                        context.signal
                    );
                    handle.result.then(
                        releaseBuiltInLLMRequest,
                        releaseBuiltInLLMRequest
                    );
                    return handle;
                }
                busy=false;
                throw aiProviderError(
                    'The built-in LLM provider operation is unsupported.',
                    'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
                );
            },
            unload:function unloadBuiltInLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                state='unloaded';
                busy=false;
                return statusBuiltInLLMProvider();
            },
            dispose:function disposeBuiltInLLMProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                state='disposed';
                busy=false;
                return statusBuiltInLLMProvider();
            }
        });
    }

    #builtInSpeechService(role){
        return role==='stt'?this.sttService:this.ttsService;
    }

    #builtInSpeechModel(role){
        return role==='stt'?this.modelSTT:this.modelTTS;
    }

    #builtInSpeechProviderKey(role,providerId){
        return `${role}:${providerId}`;
    }

    #builtInSpeechDefaultVoice(role,providerId){
        if(role!=='tts'){
            return null;
        }
        if(providerId==='LOCAL_SPEACH'){
            return 'af_heart';
        }
        return null;
    }

    #builtInSpeechCapability(role,providerId){
        const service=this.#builtInSpeechService(role);
        const model=this.#builtInSpeechModel(role);
        if(service!==providerId||!model){
            return false;
        }
        if(providerId==='LOCAL_SPEACH'){
            return Boolean(this.#nativeSpeech(service,role));
        }
        return false;
    }

    #builtInSpeechInspection(role,providerId,selection){
        const localOnly=providerId==='LOCAL_SPEACH';
        if(!selection
            ||selection.providerId!==providerId
            ||selection.modelId!==this.#builtInSpeechModel(role)
            ||selection.localOnly!==localOnly
            ||this.#builtInSpeechService(role)!==providerId){
            return completeValue({
                available:false,
                code:'ARCANE_AI_MODEL_AUTHORITY_REQUIRED',
                message:`The selected built-in ${role.toUpperCase()} route does not match the active AI configuration.`
            });
        }
        if(!this.#builtInSpeechCapability(role,providerId)){
            return completeValue({
                available:false,
                code:providerId==='LOCAL_SPEACH'
                    ?'AI_NATIVE_LOCAL_REQUIRED'
                    :'AI_PROVIDER_NOT_CONFIGURED',
                message:providerId==='LOCAL_SPEACH'
                    ?`Local ${role.toUpperCase()} requires the capability-gated Arcane API.`
                    :'AI provider is not configured.'
            });
        }
        return completeValue({
            available:true,
            authority:completeValue({
                protocol:AI_MODEL_AUTHORITY_PROTOCOL,
                providerId,
                modelId:selection.modelId,
            })
        });
    }

    #createBuiltInSpeechProvider(role,providerId){
        const runtime=this;
        const localOnly=providerId==='LOCAL_SPEACH';
        const expectedOperation=role==='stt'?'transcribe':'synthesize';
        let state='unloaded';
        let busy=false;

        function statusBuiltInSpeechProvider(){
            if(state==='ready'
                &&!busy
                &&!runtime.#builtInSpeechCapability(role,providerId)){
                state='unloaded';
            }
            return completeValue({
                state,
                loaded:state==='ready',
                busy
            });
        }

        function assertBuiltInSpeechSelection(selection){
            const inspection=runtime.#builtInSpeechInspection(
                role,
                providerId,
                selection
            );
            if(!inspection.available){
                throw aiProviderError(
                    inspection.message,
                    inspection.code
                );
            }
            return inspection;
        }

        function releaseBuiltInSpeechRequest(){
            busy=false;
        }

        return completeValue({
            protocol:AI_PROVIDER_PROTOCOL,
            role,
            id:providerId,
            localOnly,
            catalog:function catalogBuiltInSpeechProvider(){
                const model=runtime.#builtInSpeechModel(role);
                if(runtime.#builtInSpeechService(role)!==providerId||!model){
                    return completeValue([]);
                }
                const defaultVoice=runtime.#builtInSpeechDefaultVoice(
                    role,
                    providerId
                );
                return completeValue([
                    completeValue({
                        id:model,
                        ...(defaultVoice?{defaultVoice}:{})
                    })
                ]);
            },
            inspect:function inspectBuiltInSpeechProvider(selection,{signal}={}){
                if(signal?.aborted){
                    throw normalizeAIRequestAbort(signal.reason);
                }
                return runtime.#builtInSpeechInspection(role,providerId,selection);
            },
            status:statusBuiltInSpeechProvider,
            load:function loadBuiltInSpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(state==='disposed'){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider is disposed.`,
                        'ARCANE_AI_PROVIDER_DISPOSED'
                    );
                }
                if(busy){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                if(typeof context.progress!=='function'){
                    throw new TypeError(
                        `Built-in ${role.toUpperCase()} provider load progress must be a function.`
                    );
                }
                const inspection=assertBuiltInSpeechSelection(context.selection);
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
                return completeValue({
                    authority:inspection.authority,
                    status:statusBuiltInSpeechProvider()
                });
            },
            request:function requestBuiltInSpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                assertBuiltInSpeechSelection(context.selection);
                const current=statusBuiltInSpeechProvider();
                if(current.state!=='ready'||!current.loaded){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider is not ready.`,
                        'ARCANE_AI_ROLE_NOT_READY'
                    );
                }
                if(busy){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                if(context.operation!==expectedOperation){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider operation is unsupported.`,
                        'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
                    );
                }
                busy=true;
                const request=role==='stt'
                    ?runtime.#requestBuiltInSpeechTranscription(
                        context.payload,
                        context.signal
                    )
                    :runtime.#requestBuiltInSpeechSynthesis(
                        context.payload,
                        context.signal
                    );
                return Promise.resolve(request).finally(releaseBuiltInSpeechRequest);
            },
            unload:function unloadBuiltInSpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(busy){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider still owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                state='unloaded';
                return statusBuiltInSpeechProvider();
            },
            dispose:function disposeBuiltInSpeechProvider(context={}){
                if(context.signal?.aborted){
                    throw normalizeAIRequestAbort(context.signal.reason);
                }
                if(busy){
                    throw aiProviderError(
                        `The built-in ${role.toUpperCase()} provider still owns an active request.`,
                        'ARCANE_AI_ROLE_BUSY'
                    );
                }
                state='disposed';
                return statusBuiltInSpeechProvider();
            }
        });
    }

    #ensureBuiltInLLMProvider(providerId){
        if(providerId!=='OPENAI'&&providerId!=='OLLAMA'){
            return false;
        }
        if(this.#providerRuntime.hasProvider('llm',providerId)){
            return false;
        }
        const provider=this.#createBuiltInLLMProvider(providerId);
        const unregister=this.#providerRuntime.register(provider);
        this.#builtInLLMProviders.set(
            providerId,
            completeValue({provider,unregister})
        );
        return true;
    }

    #ensureBuiltInSpeechProvider(role,providerId){
        if(!['stt','tts'].includes(role)||providerId!=='LOCAL_SPEACH'){
            return false;
        }
        if(this.#providerRuntime.hasProvider(role,providerId)){
            return false;
        }
        const provider=this.#createBuiltInSpeechProvider(role,providerId);
        const unregister=this.#providerRuntime.register(provider);
        this.#builtInSpeechProviders.set(
            this.#builtInSpeechProviderKey(role,providerId),
            completeValue({role,providerId,provider,unregister})
        );
        return true;
    }

    #releaseInactiveBuiltInLLMProviders(activeProviderId){
        for(const [providerId,record] of this.#builtInLLMProviders){
            if(providerId===activeProviderId){
                continue;
            }
            if(record.unregister()){
                this.#builtInLLMProviders.delete(providerId);
            }
        }
    }

    #releaseInactiveBuiltInSpeechProviders(activeProviders){
        for(const [key,record] of this.#builtInSpeechProviders){
            if(activeProviders[record.role]===record.providerId){
                continue;
            }
            if(record.unregister()){
                this.#builtInSpeechProviders.delete(key);
            }
        }
    }

    #builtInLLMSelection(localOnly=false){
        const selection=this.#providerRuntime.selection(
            'llm',
            {localOnly}
        );
        if(!selection
            ||!this.#builtInLLMProviders.has(selection.providerId)
            ||selection.providerId!==this.llmService
            ||selection.modelId!==this.model){
            return null;
        }
        return selection;
    }

    #builtInSpeechSelection(role,localOnly=false){
        const selection=this.#providerRuntime.selection(role,{localOnly});
        if(!selection
            ||!this.#builtInSpeechProviders.has(
                this.#builtInSpeechProviderKey(role,selection.providerId)
            )
            ||selection.providerId!==this.#builtInSpeechService(role)
            ||selection.modelId!==this.#builtInSpeechModel(role)){
            return null;
        }
        return selection;
    }

    #retainBuiltInLLMReadiness(operation){
        this.#builtInLLMReadiness=Promise.resolve(operation).catch(
            function retainBuiltInLLMReadinessFailure(){
                return null;
            }
        );
        return this.#builtInLLMReadiness;
    }

    #retainBuiltInSpeechReadiness(operation){
        this.#builtInSpeechReadiness=Promise.resolve(operation).catch(
            function retainBuiltInSpeechReadinessFailure(){
                return null;
            }
        );
        return this.#builtInSpeechReadiness;
    }

    #reconcileBuiltInLLMReadiness(){
        const selection=this.#builtInLLMSelection(false);
        if(!selection){
            return Promise.resolve(this.#providerRuntime.status('llm'));
        }
        const status=this.#providerRuntime.status('llm');
        if(this.#builtInLLMCapability(selection.providerId)){
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

    #reconcileBuiltInSpeechReadiness(){
        const runtime=this;
        return Promise.all(['stt','tts'].map(function reconcileBuiltInSpeechRole(role){
            const selection=runtime.#builtInSpeechSelection(role,false);
            if(!selection){
                return runtime.#providerRuntime.status(role);
            }
            const status=runtime.#providerRuntime.status(role);
            if(runtime.#builtInSpeechCapability(role,selection.providerId)){
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
            if(this.#builtInLLMSelection(false)
                &&!this.#builtInLLMCapability(this.llmService)){
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
                ?this.#builtInLLMSelection(false)
                :this.#builtInSpeechSelection(role,false);
            const internalAvailable=!internal
                ||(role==='llm'
                    ?this.#builtInLLMCapability(internal.providerId)
                    :this.#builtInSpeechCapability(role,internal.providerId));
            if(!internalAvailable){
                const inspection=role==='llm'
                    ?this.#builtInLLMInspection(internal.providerId,internal)
                    :this.#builtInSpeechInspection(
                        role,
                        internal.providerId,
                        internal
                    );
                throw aiProviderError(
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

        if(service==='OPENAI'&&role==='llm'&&Boolean(this.twinKey)){
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
        // Built-in adapters publish lifecycle without replacing established
        // public transport callbacks or their cancellation behavior.
        if(role==='llm'&&this.#builtInLLMSelection(localOnly)){
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
        next[1]='LOCAL_SPEACH';
        next[2]='LOCAL_SPEACH';
        next[4]='LOCAL_SPEACH';
        next[5]='LOCAL_SPEACH';
        return completeValue(next);
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

    #assertDeviceSpeechConfiguration(configuration){
        for(const role of ['stt','tts']){
            for(const routeName of ['default','localOnly']){
                const selection=configuration?.[role]?.[routeName];
                if(selection&&selection.localOnly!==true){
                    const operation=role==='stt'
                        ?'Speech recognition'
                        :'Speech synthesis';
                    const error=new TypeError(
                        `${operation} supports on-device providers only.`
                    );
                    error.code=role==='stt'
                        ?'AI_STT_DEVICE_ONLY'
                        :'AI_TTS_DEVICE_ONLY';
                    throw error;
                }
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
            return model==='OPENAI'?this.#models.OPENAI:model;
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
        this.#preferenceTuple=completeValue(tuple.slice());
    }

    #applySpeechPreferenceTuple(tuple){
        this.sttService=tuple[1];
        this.ttsService=tuple[2];
        this.modelTTS=this.#ttsModels[tuple[4]]||tuple[4];
        this.modelSTT=this.#sttModels[tuple[5]]||tuple[5];
        this.#preferenceTuple=completeValue(tuple.slice());
    }

    #tupleFromProviderRoutes(selections){
        const llm=selections.llm.default;
        const stt=selections.stt.default;
        const tts=selections.tts.default;
        return completeValue([
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
        return completeValue([
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
            const pendingExternalRoute=Boolean(
                providerId
                &&modelId
                &&!BUILT_IN_AI_SERVICES.has(providerId)
            );
            if(!identity&&!pendingExternalRoute){
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

    #assertRegisteredBuiltInRoutes(selections){
        for(const role of ['llm','stt','tts']){
            for(const routeName of ['default','localOnly']){
                const selection=selections?.[role]?.[routeName];
                if(selection
                    &&BUILT_IN_AI_SERVICES.has(selection.providerId)
                    &&!this.#providerRuntime.hasProvider(role,selection.providerId)){
                    const error=new Error(
                        `Built-in AI provider ${selection.providerId} requires an explicit ${role} adapter before routing.`
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
        this.#ensureBuiltInLLMProvider(tuple[0]);
        this.#ensureBuiltInSpeechProvider('stt',tuple[1]);
        this.#ensureBuiltInSpeechProvider('tts',tuple[2]);
        this.#providerRuntime.configure(this.#routesFromPreferenceTuple(tuple));
        this.#invalidateSpeechControl();
        this.#applyPreferenceTuple(tuple);
        this.#releaseInactiveBuiltInLLMProviders(tuple[0]);
        this.#releaseInactiveBuiltInSpeechProviders({
            stt:tuple[1],
            tts:tuple[2]
        });
        this.#retainBuiltInLLMReadiness(
            this.#reconcileBuiltInLLMReadiness()
        );
        this.#retainBuiltInSpeechReadiness(
            this.#reconcileBuiltInSpeechReadiness()
        );
        return true;
    }

    configureProviders(selections){
        const prepared=this.#providerRuntime.validateConfiguration(selections);
        this.#assertDeviceSpeechConfiguration(prepared);
        this.#assertSynchronousBrowserSpeechSupersession('AI.configureProviders');
        this.#ensureBuiltInLLMProvider(
            prepared.llm.default?.providerId
        );
        this.#ensureBuiltInSpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureBuiltInSpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredBuiltInRoutes(prepared);
        const configured=this.#providerRuntime.configure(prepared);
        this.#invalidateSpeechControl();
        this.#applyPreferenceTuple(this.#tupleFromProviderRoutes(configured));
        this.#releaseInactiveBuiltInLLMProviders(
            configured.llm.default?.providerId
        );
        this.#releaseInactiveBuiltInSpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        this.#retainBuiltInLLMReadiness(
            this.#reconcileBuiltInLLMReadiness()
        );
        this.#retainBuiltInSpeechReadiness(
            this.#reconcileBuiltInSpeechReadiness()
        );
        return configured;
    }

    configureSpeechProviders(selections){
        const prepared=this.#providerRuntime.validateSpeechConfiguration(selections);
        this.#assertDeviceSpeechConfiguration(prepared);
        this.#assertSynchronousBrowserSpeechSupersession(
            'AI.configureSpeechProviders'
        );
        this.#ensureBuiltInSpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureBuiltInSpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredBuiltInRoutes(prepared);
        const configured=this.#providerRuntime.configureSpeech(prepared);
        this.#invalidateSpeechControl();
        this.#applySpeechPreferenceTuple(
            this.#tupleFromSpeechProviderRoutes(configured)
        );
        this.#releaseInactiveBuiltInSpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        this.#retainBuiltInSpeechReadiness(
            this.#reconcileBuiltInSpeechReadiness()
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
        this.#ensureBuiltInLLMProvider(tuple[0]);
        this.#ensureBuiltInSpeechProvider('stt',tuple[1]);
        this.#ensureBuiltInSpeechProvider('tts',tuple[2]);
        this.#providerRuntime.configure(this.#routesFromPreferenceTuple(tuple));
        this.#applyPreferenceTuple(tuple);
        this.#releaseInactiveBuiltInLLMProviders(tuple[0]);
        this.#releaseInactiveBuiltInSpeechProviders({
            stt:tuple[1],
            tts:tuple[2]
        });
        await this.#reconcileBuiltInLLMReadiness();
        await this.#reconcileBuiltInSpeechReadiness();
        return this.#providerRuntime.status();
    }

    async transitionProviders(selections){
        const prepared=this.#providerRuntime.validateConfiguration(selections);
        this.#assertDeviceSpeechConfiguration(prepared);
        await this.#supersedeBrowserSpeechForRouteChange();
        this.#ensureBuiltInLLMProvider(
            prepared.llm.default?.providerId
        );
        this.#ensureBuiltInSpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureBuiltInSpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredBuiltInRoutes(prepared);
        this.#invalidateSpeechControl();
        await this.#unloadProviderRolesForTransition();
        const configured=this.#providerRuntime.configure(prepared);
        this.#applyPreferenceTuple(this.#tupleFromProviderRoutes(configured));
        this.#releaseInactiveBuiltInLLMProviders(
            configured.llm.default?.providerId
        );
        this.#releaseInactiveBuiltInSpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        await this.#reconcileBuiltInLLMReadiness();
        await this.#reconcileBuiltInSpeechReadiness();
        return configured;
    }

    async transitionSpeechProviders(selections){
        const prepared=this.#providerRuntime.validateSpeechConfiguration(selections);
        this.#assertDeviceSpeechConfiguration(prepared);
        await this.#supersedeBrowserSpeechForRouteChange();
        this.#invalidateSpeechControl();
        await this.#unloadSpeechProviderRolesForTransition();
        this.#ensureBuiltInSpeechProvider(
            'stt',
            prepared.stt.default?.providerId
        );
        this.#ensureBuiltInSpeechProvider(
            'tts',
            prepared.tts.default?.providerId
        );
        this.#assertRegisteredBuiltInRoutes(prepared);
        const configured=this.#providerRuntime.configureSpeech(prepared);
        this.#applySpeechPreferenceTuple(
            this.#tupleFromSpeechProviderRoutes(configured)
        );
        this.#releaseInactiveBuiltInSpeechProviders({
            stt:configured.stt.default?.providerId,
            tts:configured.tts.default?.providerId
        });
        await this.#reconcileBuiltInSpeechReadiness();
        this.muted=true;
        return configured;
    }

    #browserSpeechOperationId(action){
        this.#browserSpeechOperationSequence=
            typeof this.#browserSpeechOperationSequence==='bigint'
                ? this.#browserSpeechOperationSequence+1n
                : this.#browserSpeechOperationSequence===Number.MAX_SAFE_INTEGER
                    ? BigInt(this.#browserSpeechOperationSequence)+1n
                    : this.#browserSpeechOperationSequence+1;
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
        const builtInRecords=[];
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
            const record=this.#builtInSpeechProviders.get(
                this.#builtInSpeechProviderKey(role,selection.providerId)
            );
            if(!record
                ||!this.#providerRuntime.ownsProvider(role,record.provider)){
                const pendingIdentity=this.#providerRuntime.providerIdentity(
                    role,
                    selection.providerId
                );
                if(pendingIdentity===null&&selection.localOnly===null){
                    expectedProviders[role]=null;
                    continue;
                }
                throw this.#browserSpeechProviderRouteOwnershipError(
                    `The selected ${role} route is not owned by the replaceable built-in AI speech boundary.`
                );
            }
            expectedProviders[role]=record.provider;
            builtInRecords.push(record);
        }
        return completeValue({
            expectedProviders:completeValue(expectedProviders),
            builtInRecords:completeValue(builtInRecords)
        });
    }

    async #cleanupRetiredBuiltInSpeechProviders(
        {signal=null,committed=false}={}
    ){
        const failures=[];
        for(const record of [...this.#browserSpeechRetiredBuiltInRecords]){
            try{
                if(this.#providerRuntime.ownsProvider(
                    record.role,
                    record.provider
                )){
                    throw this.#browserSpeechProviderRouteOwnershipError(
                        `The retired ${record.role} built-in speech provider still owns its registry entry.`
                    );
                }
                await record.provider.dispose({role:record.role,signal});
                const key=this.#builtInSpeechProviderKey(
                    record.role,
                    record.providerId
                );
                if(this.#builtInSpeechProviders.get(key)===record){
                    this.#builtInSpeechProviders.delete(key);
                }
                this.#browserSpeechRetiredBuiltInRecords.delete(record);
            }catch(error){
                failures.push(error);
            }
        }
        if(failures.length){
            throw aiBrowserSpeechError(
                AI_BROWSER_SPEECH_ERROR_CODES.providerDisposalRejected,
                AI_BROWSER_SPEECH_REASONS.providerDisposalRejected,
                'The replaced built-in speech providers could not be disposed.',
                failures.length===1
                    ?failures[0]
                    :new AggregateError(
                        failures,
                        'Multiple replaced built-in speech provider disposals were rejected.'
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
        const compatibilityDetail=completeValue({
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
                publicDetail:completeValue({
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
            const selection=completeValue({
                providerId:provider.id,
                modelId:catalog.id,
                localOnly:true
            });
            return completeValue({default:selection,localOnly:selection});
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
        return completeValue({
            routes:completeValue(routes),
            catalogs:completeValue(catalogs)
        });
    }

    #browserSpeechDescriptor(normalized,catalogs,previousRecord){
        function roleDescriptor(role,configured,catalog){
            return completeValue({
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
        return completeValue({
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
        return completeValue({
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
        return completeValue({
            stt:completeValue({
                default:this.#providerRuntime.selection('stt'),
                localOnly:this.#providerRuntime.selection('stt',{localOnly:true})
            }),
            tts:completeValue({
                default:this.#providerRuntime.selection('tts'),
                localOnly:this.#providerRuntime.selection('tts',{localOnly:true})
            })
        });
    }

    #emptySpeechRoutes(){
        return completeValue({
            stt:completeValue({default:null,localOnly:null}),
            tts:completeValue({default:null,localOnly:null})
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
        const managedRoles=completeValue(['stt','tts'].filter(role=>
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
            configurationByRole:completeValue(configurationByRole),
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

    #finalizeBrowserSpeechRecord(record){
        record.unregisters=completeValue({...record.unregisters});
        return completeValue(record);
    }

    #browserSpeechRecordFromReplacement(record,replacement){
        return this.#finalizeBrowserSpeechRecord({
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
                        ?{graph:configured.graph}
                        :{
                            model:configured.model,
                            runtime:configured.runtime
                        }),
                    store,
                    offline:configured.offline
                });
            }
            providers=completeValue({...candidateProviders});
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
                        ?completeValue({
                            providerId:provider.id,
                            modelId:normalized[role].graph?.model.id
                                ??normalized[role].model.id,
                            localOnly:true
                        })
                        :null;
                    partialRoutes[role]=changed
                        ?completeValue({default:selection,localOnly:selection})
                        :previousRecord?.managedRoles.includes(role)
                            ?previousRecord.routes[role]
                            :currentRoutes[role];
                }
                const partial=this.#browserSpeechCandidate(
                    normalized,
                    configuration,
                    null,
                    completeValue({...candidateProviders}),
                    completeValue(partialRoutes),
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
                replacement=completeValue({
                    routes:prepared.routes,
                    unregisters:completeValue({
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
        for(const builtInRecord of replacementBoundary.builtInRecords){
            this.#browserSpeechRetiredBuiltInRecords.add(builtInRecord);
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
                    rollback=completeValue({
                        routes:previousRecord.routes,
                        unregisters:completeValue({
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
        await this.#cleanupRetiredBuiltInSpeechProviders({
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
                        runtime.#browserSpeechControllerRoles=completeValue([]);
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
            ||[...this.#browserSpeechRetiredBuiltInRecords].some(
                record=>record.role==='tts'
            )
        );
        this.#browserSpeechController?.abort(superseded);
        if(invalidatesSpeech)this.#invalidateSpeechControl();
        const controller=new AbortController();
        this.#browserSpeechController=controller;
        this.#browserSpeechControllerRoles=completeValue([]);
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
                        &&runtime.#browserSpeechRetiredBuiltInRecords.size===0){
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
                            const emptyRoleRoutes=completeValue({
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
                            removed=completeValue({
                                routes:completeValue({
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
                    if(runtime.#browserSpeechRetiredBuiltInRecords.size){
                        await runtime.#cleanupRetiredBuiltInSpeechProviders({
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
                        runtime.#browserSpeechControllerRoles=completeValue([]);
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
                    detail=errorText;
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

    async #requestBuiltInSpeechTranscription(payload={},signal=null){
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

    async #requestBuiltInSpeechSynthesis(payload={},signal=null){
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
            :this.#builtInSpeechDefaultVoice('tts',this.ttsService);
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
            throw aiProviderError(
                'The configured TTS HTTP request failed.',
                'ARCANE_AI_TTS_HTTP_REQUEST_FAILED',
                error
            );
        }
        if(!response.ok){
            const error=aiProviderError(
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

        if(!bytes.length){
            throw new RangeError('Microphone audio must not be empty.');
        }

        const chunks=[];

        for(let offset=0;offset<bytes.length;offset+=0x8000){
            chunks.push(String.fromCharCode(...bytes.subarray(offset,offset+0x8000)));
        }

        return btoa(chunks.join(''));
    }

    #base64ToBytes(value){
        if(typeof value!=='string'||!value){
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
                        }catch(cause){
                            const error=new TypeError(
                                'Ollama tool call arguments must contain valid JSON.'
                            );
                            error.code='AI_TOOL_ARGUMENTS_INVALID';
                            error.cause=cause;
                            throw error;
                        }
                    }
                    if(
                        !argumentValue
                        ||typeof argumentValue!=='object'
                        ||Array.isArray(argumentValue)
                    ){
                        const error=new TypeError(
                            'Ollama tool call arguments must contain a JSON object.'
                        );
                        error.code='AI_TOOL_ARGUMENTS_INVALID';
                        throw error;
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
            ?`Call the ${requiredName} function now with complete values for every required field. Do not answer in prose.`
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

    async #reportRequest(requestHandler,request,id,metadata){
        if(typeof requestHandler!=='function'){
            throw new TypeError('AI onRequest callback must be a function.');
        }
        await requestHandler(request,id,metadata);
    }

    #providerStreamEmissions(chunk,seeThinking){
        const chunks=[];
        if(typeof chunk==='string'){
            if(chunk) chunks.push({text:chunk,thinking:false});
            return {chunks};
        }
        const choices=Array.isArray(chunk?.choices)?chunk.choices:[];
        for(const choice of choices){
            const delta=choice?.delta||{};
            if(
                seeThinking
                &&typeof delta.reasoning_content==='string'
                &&delta.reasoning_content
            ){
                chunks.push({text:delta.reasoning_content,thinking:true});
            }
            if(typeof delta.content==='string'&&delta.content){
                chunks.push({text:delta.content,thinking:false});
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
        }
        return {chunks};
    }

    #providerCompletionOutput(completion){
        if(typeof completion==='string'){
            return completion;
        }
        if(Array.isArray(completion?.choices)&&completion.choices.length>1){
            return completion;
        }
        const structuralToolCalls=normalizeAICompletionToolCalls(completion);
        if(structuralToolCalls.length)return structuralToolCalls;
        const content=completion?.choices?.[0]?.message?.content;
        return typeof content==='string'?content:completion;
    }

    #requestBuiltInLLMChat(payload={},signal=null){
        const parallelToolCalls=payload.parallelToolCalls!==undefined
            ?payload.parallelToolCalls
            :payload.parallel_tool_calls;
        return this.#fetchBuiltIn(
            payload.messages??[],
            function ignoreBuiltInLLMProviderResponse(){},
            payload.structuredOutput??false,
            payload.tools??[],
            payload.toolChoice??'auto',
            parallelToolCalls,
            payload.id??Date.now(),
            function ignoreBuiltInLLMProviderRequest(){},
            signal,
            payload.reasoningEffort
        );
    }

    #requestBuiltInLLMStream(payload={},bridge){
        const parallelToolCalls=payload.parallelToolCalls!==undefined
            ?payload.parallelToolCalls
            :payload.parallel_tool_calls;
        function emitBuiltInLLMStreamData(chunk){
            bridge.emit(chunk);
        }

        return this.#streamBuiltInMessage(
            payload.messages??[],
            function ignoreBuiltInLLMScalarStream(){},
            function ignoreBuiltInLLMProviderCompletion(){},
            payload.tools??[],
            payload.toolChoice??'auto',
            function retainBuiltInLLMStreamToolUntilCompletion(){},
            parallelToolCalls,
            payload.id??Date.now(),
            payload.seeThinking??false,
            bridge.signal,
            function ignoreBuiltInLLMProviderRequest(){},
            payload.structuredOutput??false,
            false,
            true,
            emitBuiltInLLMStreamData,
            function ignoreBuiltInLLMStreamResult(){},
            payload.reasoningEffort
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

    #openAICompatibleOllamaToolCalls(value,id=Date.now()){
        if(value===undefined){
            return [];
        }
        if(!Array.isArray(value)){
            throw aiStructuralError(
                'AI_CHAT_INVALID_TOOL_CALL',
                'The native Ollama response contains invalid structural tool calls.'
            );
        }
        return value.map(function adaptNativeOllamaToolCall(call,index){
            if(!call||typeof call!=='object'||Array.isArray(call)){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_TOOL_CALL',
                    `The native Ollama structural tool call ${index+1} is invalid.`
                );
            }
            const nativeFunction=call.function;
            if(
                !nativeFunction
                ||typeof nativeFunction!=='object'
                ||Array.isArray(nativeFunction)
            ){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_TOOL_CALL',
                    `The native Ollama structural tool call ${index+1} is invalid.`
                );
            }
            let encodedArguments=nativeFunction.arguments;
            if(
                encodedArguments
                &&typeof encodedArguments==='object'
                &&!Array.isArray(encodedArguments)
            ){
                try{
                    encodedArguments=JSON.stringify(encodedArguments);
                }catch(cause){
                    throw aiStructuralError(
                        'AI_CHAT_INVALID_TOOL_CALL',
                        `The native Ollama structural tool call ${index+1} arguments cannot be encoded.`,
                        cause
                    );
                }
            }
            return {
                ...call,
                id:call.id===undefined
                    ?`ollama-${id}-tool-${index+1}`
                    :call.id,
                type:call.type===undefined?'function':call.type,
                function:{
                    ...nativeFunction,
                    name:nativeFunction.name,
                    arguments:encodedArguments
                }
            };
        });
    }

    #openAICompatibleOllamaResponse(response={},id=Date.now()){
        const responseRecord=isPlainAIRecord(response)?response:{};
        const message=isPlainAIRecord(responseRecord.message)
            ?responseRecord.message
            :{};
        const responseFields={...responseRecord};
        delete responseFields.message;
        const responseId=typeof response?.id==='string'&&response.id
            ?response.id
            :`ollama-${id}`;
        const adaptedToolCalls=this.#openAICompatibleOllamaToolCalls(
            message.tool_calls,
            id
        );
        const toolCalls=normalizeAICompletionToolCalls({
            message:{tool_calls:adaptedToolCalls}
        });
        const messageRecord={
            ...message,
            role:typeof message.role==='string'&&message.role
                ?message.role
                :'assistant',
            content:Object.hasOwn(message,'content')?message.content:'',
            ...(Object.hasOwn(message,'tool_calls')||toolCalls.length
                ?{tool_calls:toolCalls}
                :{})
        };
        const usage=isPlainAIRecord(responseRecord.usage)
            ?responseRecord.usage
            :{};

        return {
            ...responseFields,
            id:responseId,
            object:Object.hasOwn(responseRecord,'object')
                ?responseRecord.object
                :'chat.completion',
            created:Object.hasOwn(responseRecord,'created')
                ?responseRecord.created
                :Math.floor(Date.now()/1000),
            model:Object.hasOwn(responseRecord,'model')
                ?responseRecord.model
                :this.model,
            choices:[
                {
                    index:0,
                    message:messageRecord,
                    finish_reason:Object.hasOwn(responseRecord,'done_reason')
                        ?responseRecord.done_reason
                        :toolCalls.length?'tool_calls':'stop'
                }
            ],
            usage:{
                ...usage,
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
        onDataChunk=function ignoreStreamDataChunk(){},
        onDataResult=function ignoreStreamDataResult(){},
        onResponse=function ignoreStreamResponse(){},
        tools=[],
        toolChoice='auto',
        onToolCall=function ignoreEarlyFunction(){},
        onRequest=function ignoreStreamRequest(){},
        parallelToolCalls,
        id=Date.now(),
        seeThinking=false,
        signal=null,
        maxOutputTokens,
        maxTokens,
        temperature,
        topK,
        topP,
        repeatPenalty,
        minP,
        seed,
        stop,
        templateOptions,
        reasoningEffort
    }={}){
        validateAIStructuralRequest(messages,tools,parallelToolCalls);
        const normalizedReasoningEffort=normalizeAIReasoningEffort(
            reasoningEffort===undefined?this.reasoningEffort:reasoningEffort
        );
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
                ...(parallelToolCalls!==undefined?{parallelToolCalls}:{}),
                id,
                seeThinking,
                ...(maxOutputTokens!==undefined
                    ?{maxTokens:maxOutputTokens}
                    :maxTokens!==undefined?{maxTokens}:{}),
                ...(temperature!==undefined?{temperature}:{}),
                ...(topK!==undefined?{topK}:{}),
                ...(topP!==undefined?{topP}:{}),
                ...(repeatPenalty!==undefined?{repeatPenalty}:{}),
                ...(minP!==undefined?{minP}:{}),
                ...(seed!==undefined?{seed}:{}),
                ...(stop!==undefined?{stop}:{}),
                ...(templateOptions!==undefined?{templateOptions}:{}),
                ...(normalizedReasoningEffort
                    ?{reasoningEffort:normalizedReasoningEffort}
                    :{})
            };
            const displayId=`M-${id}`;
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
                    await onDataChunk(chunk,id);
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
                }
                const completion=await handle.result;
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                const structuralToolCalls=normalizeAICompletionToolCalls(
                    completion
                );
                await onDataResult(completion,id);
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                await onResponse(completion,id,false);
                for(const call of structuralToolCalls){
                    if(signal?.aborted){
                        throw normalizeAIRequestAbort();
                    }
                    await onToolCall(call,displayId);
                    if(signal?.aborted){
                        throw normalizeAIRequestAbort();
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

        try{
            const completion=await this.#streamBuiltInMessage(
                messages,
                onChunk,
                function retainBuiltInCompletionUntilResponse(){},
                tools,
                toolChoice,
                function retainBuiltInToolCallUntilResponse(){},
                parallelToolCalls,
                id,
                seeThinking,
                signal,
                onRequest,
                structuredOutput,
                false,
                true,
                onDataChunk,
                onDataResult,
                normalizedReasoningEffort
            );
            const structuralToolCalls=normalizeAICompletionToolCalls(
                completion
            );
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            await onResponse(completion,id,false);
            for(const call of structuralToolCalls){
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                await onToolCall(call,`M-${id}`);
            }
            const result=this.#providerCompletionOutput(completion);
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            await onComplete(result,`M-${id}`,false);
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            this.finishTTS();
            return result;
        }catch(error){
            this.stopAudio();
            throw isAIRequestAbort(error,signal)
                ?normalizeAIRequestAbort(error)
                :error;
        }
    }

    async streamMessage(
        messages=[],
        streamHandler=function ignoreStreamChunk(){},
        streamComplete=function finishIgnoredStream(){},
        tools=[],
        tool_choice='auto',
        earlyFunctionTrigger=function ignoreEarlyFunction(){},
        parallel_tool_calls,
        id=Date.now(),
        seeThinking=false,
        signal=null,
        requestHandler=function ignoreStreamRequest(){},
        structuredOutput=false,
        returnCompletion=false,
        onDataChunk=function ignoreStreamDataChunk(){},
        onDataResult=function ignoreStreamDataResult(){}
    ){
        if(this.#shouldUseProviderRuntime('llm',this.llmService,false)){
            return this.streamRequest({
                messages,
                structuredOutput,
                localOnly:false,
                onChunk:streamHandler,
                onComplete:streamComplete,
                onDataChunk,
                onDataResult,
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

        return this.#streamBuiltInMessage(
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
            structuredOutput,
            true,
            returnCompletion,
            onDataChunk,
            onDataResult
        );
    }

    async #streamBuiltInMessage(
        messages=[],
        streamHandler=function ignoreStreamChunk(){},
        streamComplete=function finishIgnoredStream(){},
        tools=[],
        tool_choice='auto',
        earlyFunctionTrigger=function ignoreEarlyFunction(){},
        parallel_tool_calls,
        id=Date.now(),
        seeThinking=false,
        signal=null,
        requestHandler=function ignoreStreamRequest(){},
        structuredOutput=false,
        finishSpeech=true,
        returnCompletion=false,
        dataChunkHandler=function ignoreBuiltInStreamDataChunk(){},
        dataResultHandler=function ignoreBuiltInStreamDataResult(){},
        reasoningEffort
    ){
        let speechTurnCompleted=false;

        try{
            validateAIStructuralRequest(messages,tools,parallel_tool_calls);
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

        const normalizedReasoningEffort=normalizeAIReasoningEffort(
            reasoningEffort===undefined?this.reasoningEffort:reasoningEffort
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
            if(parallel_tool_calls!==undefined){
                request.parallel_tool_calls=parallel_tool_calls;
            }
        }

        if(
            normalizedReasoningEffort
            &&(this.llmService==='OPENAI'||this.llmService==='OLLAMA')
        ){
            request.reasoning_effort=normalizedReasoningEffort;
        }

        let isThinking=true;
        let isWaiting=true;

        await streamHandler('Thinking...',`M-${id}`,isThinking);

        const nativeOllama=this.#nativeOllama();

        if(this.llmService==='OLLAMA'&&!nativeOllama){
            throw aiProviderError(
                'Local AI requires the capability-gated Arcane API.',
                'AI_NATIVE_LOCAL_REQUIRED'
            );
        }

        if(nativeOllama){
            let nativeContent='';
            let streamedNativeToolCalls=null;
            const ollamaTools=this.#ollamaTools(tools,tool_choice);
            const ollamaMessages=this.#ollamaMessages(messages,tool_choice);
            const adaptNativeToolCalls=value=>this.#openAICompatibleOllamaToolCalls(value,id);
            const ollamaRequest={
                model:this.model,
                messages:ollamaMessages,
                stream:true,
                ...(normalizedReasoningEffort
                    ?{think:normalizedReasoningEffort}
                    :{}),
                ...(structuredOutputFormat?{format:structuredOutputFormat}:{}),
                ...(ollamaTools.length?{tools:ollamaTools}:{})
            };

            let nativeChunkPipeline=Promise.resolve();
            function queueNativeOllamaChunk(chunk){
                nativeChunkPipeline=nativeChunkPipeline.then(
                    async function processNativeOllamaChunk(){
                        if(signal?.aborted){
                            return;
                        }
                        const dataChunk=projectAIStreamChunk(chunk);
                        if(dataChunk!==OMITTED_AI_STREAM_DATA){
                            await dataChunkHandler(dataChunk,id);
                        }
                        if(signal?.aborted){
                            return;
                        }
                        const message=chunk?.message||{};
                        if(isPlainAIRecord(message)&&Object.hasOwn(message,'tool_calls')){
                            const observed=normalizeAIStreamToolCallObservation(
                                {message:{tool_calls:adaptNativeToolCalls(message.tool_calls)}},
                                'The native Ollama stream'
                            );
                            if(
                                streamedNativeToolCalls
                                &&(
                                    streamedNativeToolCalls.length!==observed.length
                                    ||streamedNativeToolCalls.some(
                                        (call,index)=>!sameAIStructuralToolCall(call,observed[index])
                                    )
                                )
                            ){
                                throw aiStructuralError(
                                    'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                                    'The native Ollama stream changed its complete structural tool calls.'
                                );
                            }
                            streamedNativeToolCalls=observed;
                        }
                        const thinking=seeThinking
                            ?String(message.thinking||'')
                            :'';
                        const content=String(message.content||'');

                        if(thinking){
                            await streamHandler(thinking,`M-${id}`,true);
                        }

                        if(content){
                            isThinking=false;
                            nativeContent+=content;
                            await streamHandler(content,`M-${id}`,false);
                        }
                    }
                );
                return nativeChunkPipeline;
            }

            await this.#reportRequest(requestHandler,ollamaRequest,id,{
                operation:'stream',
                transport:'native',
                destination:'Arcane.ollama.chat'
            });
            let nativeResponse;
            let nativeRequestFailure=null;
            try{
                nativeResponse=await nativeOllama.chat(
                    ollamaRequest,
                    {onChunk:queueNativeOllamaChunk,signal}
                );
            }catch(error){
                nativeRequestFailure=error;
            }
            try{
                await nativeChunkPipeline;
            }catch(error){
                nativeRequestFailure??=error;
            }
            if(nativeRequestFailure){
                throw nativeRequestFailure;
            }
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            const nativeMessage=isPlainAIRecord(nativeResponse?.message)
                ?nativeResponse.message
                :{};
            const nativeCompletion=this.#openAICompatibleOllamaResponse(
                {
                    ...nativeResponse,
                    message:{
                        ...nativeMessage,
                        content:Object.hasOwn(nativeMessage,'content')
                            ?nativeMessage.content
                            :nativeContent
                    }
                },
                id
            );
            const structuralToolCalls=normalizeAICompletionToolCalls(
                nativeCompletion
            );
            assertAIStreamToolCallCorrelation(
                streamedNativeToolCalls??[],
                structuralToolCalls,
                'The native Ollama stream'
            );
            this.#assertRequiredOllamaToolCall(
                structuralToolCalls,
                tool_choice
            );
            await dataResultHandler(nativeCompletion,id);
            for(const call of structuralToolCalls){
                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }
                await earlyFunctionTrigger(call,`M-${id}`);
            }

            const nativeResult=this.#providerCompletionOutput(nativeCompletion);
            if(finishSpeech){
                this.finishTTS();
            }
            await streamComplete(nativeResult,`M-${id}`,isThinking);
            speechTurnCompleted=true;
            return returnCompletion?nativeCompletion:nativeResult;
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

        let sseBuffer='';
        const completeToolCallsByChoice=new Map();
        const streamedToolCallsByChoice=new Map();
        const streamedChoicesByIndex=new Map();
        const streamedChoiceOrder=[];
        let selectedChoiceIndex=null;
        const streamMetadata={};
        let receivedSseDone=false;
        const decoder = new TextDecoder('utf-8');
        //alert(1)
        const reader=response.body?.getReader?.();

        if(!reader){
            throw new TypeError('Streaming response body is not readable');
        }

        function receiveStreamedToolCalls(toolCalls=[],choiceIndex=0){
            const streamedToolCalls=streamedToolCallsByChoice.get(choiceIndex)
                ||new Map();
            for(let position=0;position<toolCalls.length;position++){
                const toolCall=toolCalls[position]||{};
                const toolFunction=toolCall.function||{};
                if(
                    toolCall.index!==undefined
                    &&(!Number.isSafeInteger(toolCall.index)||toolCall.index<0)
                ){
                    throw aiStructuralError(
                        'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                        `AI stream choice ${choiceIndex} contains an invalid structural tool-call index.`
                    );
                }
                const toolIndex=toolCall.index??position;
                const record=streamedToolCalls.get(toolIndex)||{
                    arguments:'',
                    id:'',
                    index:toolIndex,
                    invalidArguments:false,
                    invalidIdentity:false,
                    invalidName:false,
                    name:'',
                    type:''
                };

                if(toolCall.id!==undefined){
                    if(typeof toolCall.id!=='string'||!toolCall.id){
                        record.invalidIdentity=true;
                    }else if(record.id&&record.id!==toolCall.id){
                        record.invalidIdentity=true;
                    }else{
                        record.id=toolCall.id;
                    }
                }

                if(toolCall.type!==undefined){
                    if(typeof toolCall.type!=='string'||!toolCall.type){
                        record.invalidIdentity=true;
                    }else if(record.type&&record.type!==toolCall.type){
                        record.invalidIdentity=true;
                    }else{
                        record.type=toolCall.type;
                    }
                }

                if(toolFunction.name!==undefined){
                    if(typeof toolFunction.name!=='string'){
                        record.invalidName=true;
                    }else{
                        record.name+=toolFunction.name;
                    }
                }

                if(typeof toolFunction.arguments==='string'){
                    record.arguments+=toolFunction.arguments;
                }else if(toolFunction.arguments!==undefined){
                    record.invalidArguments=true;
                }

                streamedToolCalls.set(toolIndex,record);
            }
            streamedToolCallsByChoice.set(choiceIndex,streamedToolCalls);
        }

        function receiveStreamedChoice(choice={},choicePosition=0){
            if(
                choice.index!==undefined
                &&(!Number.isSafeInteger(choice.index)||choice.index<0)
            ){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_RESPONSE',
                    `AI stream choice ${choicePosition+1} has an invalid index.`
                );
            }
            const choiceIndex=choice.index??choicePosition;
            if(!streamedChoicesByIndex.has(choiceIndex)){
                streamedChoiceOrder.push(choiceIndex);
                if(selectedChoiceIndex===null) selectedChoiceIndex=choiceIndex;
            }
            const record=streamedChoicesByIndex.get(choiceIndex)||{
                choice:{index:choiceIndex},
                message:{role:'assistant'}
            };
            for(const [key,value] of Object.entries(choice)){
                if(key!=='delta'&&key!=='message') record.choice[key]=value;
            }
            record.choice.index=choiceIndex;
            const delta=isPlainAIRecord(choice.delta)?choice.delta:null;
            const completeMessage=isPlainAIRecord(choice.message)?choice.message:null;
            for(const [source,replaceText] of [
                [delta,false],
                [completeMessage,true]
            ]){
                if(!source) continue;
                for(const [key,value] of Object.entries(source)){
                    if(isAIStreamStructuralKey(key)) continue;
                    if(key==='content'||key==='reasoning'||key==='reasoning_content'){
                        if(
                            !replaceText
                            &&typeof value==='string'
                            &&typeof record.message[key]==='string'
                        ){
                            record.message[key]+=value;
                        }else{
                            record.message[key]=value;
                        }
                        continue;
                    }
                    record.message[key]=value;
                }
            }
            if(typeof record.message.role!=='string'||!record.message.role){
                record.message.role='assistant';
            }
            if(!Object.hasOwn(record.message,'content')) record.message.content='';
            streamedChoicesByIndex.set(choiceIndex,record);
            return choiceIndex;
        }

        async function receiveStreamedResponse(streamedResponse){
            if(!isPlainAIRecord(streamedResponse)){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_RESPONSE',
                    'The AI stream returned a non-object event payload.'
                );
            }
            const dataChunk=projectAIStreamChunk(streamedResponse);
            if(dataChunk!==OMITTED_AI_STREAM_DATA){
                await dataChunkHandler(dataChunk,id);
            }
            for(const [key,value] of Object.entries(streamedResponse)){
                if(key!=='choices') streamMetadata[key]=value;
            }
            const choices=Array.isArray(streamedResponse.choices)
                ?streamedResponse.choices
                :[];
            for(let choicePosition=0;choicePosition<choices.length;choicePosition+=1){
                const choice=choices[choicePosition];
                if(!isPlainAIRecord(choice)){
                    throw aiStructuralError(
                        'AI_CHAT_INVALID_RESPONSE',
                        `AI stream choice ${choicePosition+1} is not an object.`
                    );
                }
                const choiceIndex=receiveStreamedChoice(choice,choicePosition);
                if(choice.delta!==undefined&&!isPlainAIRecord(choice.delta)){
                    throw aiStructuralError(
                        'AI_CHAT_INVALID_RESPONSE',
                        `AI stream choice ${choicePosition+1} contains an invalid delta.`
                    );
                }
                if(choice.message!==undefined&&!isPlainAIRecord(choice.message)){
                    throw aiStructuralError(
                        'AI_CHAT_INVALID_RESPONSE',
                        `AI stream choice ${choicePosition+1} contains an invalid terminal message.`
                    );
                }
                const choiceDelta=choice.delta??{};
                const choiceMessage=choice.message??null;
                if(Object.hasOwn(choiceDelta,'tool_calls')){
                    if(!Array.isArray(choiceDelta.tool_calls)){
                        throw aiStructuralError(
                            'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                            `AI stream choice ${choicePosition+1} contains invalid structural tool-call data.`
                        );
                    }
                    receiveStreamedToolCalls(choiceDelta.tool_calls,choiceIndex);
                }
                if(choiceMessage&&Object.hasOwn(choiceMessage,'tool_calls')){
                    if(!Array.isArray(choiceMessage.tool_calls)){
                        throw aiStructuralError(
                            'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                            `AI stream choice ${choicePosition+1} contains invalid terminal structural tool-call data.`
                        );
                    }
                    completeToolCallsByChoice.set(
                        choiceIndex,
                        normalizeAIStreamToolCallObservation(
                            {message:{tool_calls:choiceMessage.tool_calls}},
                            `AI stream choice ${choicePosition+1} terminal message`
                        )
                    );
                }
                const content=typeof choiceDelta.content==='string'
                    ?choiceDelta.content
                    :'';
                let reasoning='';
                if(seeThinking){
                    reasoning=typeof choiceDelta.reasoning_content==='string'
                        ?choiceDelta.reasoning_content
                        :typeof choiceDelta.reasoning==='string'
                            ?choiceDelta.reasoning
                            :'';
                }
                isThinking=Boolean(reasoning);
                if(reasoning){
                    await streamHandler(reasoning,`M-${id}`,true);
                }
                if(content){
                    isThinking=false;
                    await streamHandler(content,`M-${id}`,false);
                }
            }
        }

        function sseDataText(eventText){
            const values=[];
            for(const line of eventText.split(/\r\n|\r|\n/)){
                if(!line||line.startsWith(':')) continue;
                const separator=line.indexOf(':');
                const field=separator<0?line:line.slice(0,separator);
                if(field!=='data') continue;
                let value=separator<0?'':line.slice(separator+1);
                if(value.startsWith(' ')) value=value.slice(1);
                values.push(value);
            }
            return values.length?values.join('\n'):null;
        }

        async function receiveSseEvent(eventText){
            const eventData=sseDataText(eventText);
            if(eventData===null) return false;
            if(eventData==='[DONE]'){
                receivedSseDone=true;
                return true;
            }
            if(receivedSseDone) return true;
            let streamedResponse;
            try{
                streamedResponse=JSON.parse(eventData);
            }catch(cause){
                throw aiStructuralError(
                    'AI_CHAT_INVALID_RESPONSE',
                    'The AI stream returned malformed JSON event data.',
                    cause
                );
            }
            await receiveStreamedResponse(streamedResponse);
            return false;
        }

        async function drainSseBuffer(final=false){
            while(true){
                const separator=sseBuffer.match(/(?:\r\n|\r|\n){2}/);
                if(!separator) break;
                const eventText=sseBuffer.slice(0,separator.index);
                sseBuffer=sseBuffer.slice(separator.index+separator[0].length);
                if(await receiveSseEvent(eventText)){
                    sseBuffer='';
                    return true;
                }
            }
            if(final&&sseBuffer.length){
                const eventText=sseBuffer;
                sseBuffer='';
                return receiveSseEvent(eventText);
            }
            return receivedSseDone;
        }

        try{
            while(!receivedSseDone){
                const {done,value:chunk}=await reader.read();

                if(signal?.aborted){
                    throw normalizeAIRequestAbort();
                }

                if(done){
                    break;
                }
                sseBuffer+=decoder.decode(chunk,{stream:true});
                if(await drainSseBuffer()) break;
            }
            if(receivedSseDone){
                await reader.cancel('[DONE]').catch(
                    error=>console.error('Arcane SSE reader cleanup failed.',error)
                );
            }else{
                sseBuffer+=decoder.decode();
                await drainSseBuffer(true);
            }
        }catch(error){
            if(isAIRequestAbort(error,signal)){
                throw normalizeAIRequestAbort(error);
            }
            throw error;
        }finally{
            reader.releaseLock();
        }

        const structuralToolCallsByChoice=new Map();
        const toolChoiceIndexes=new Set([
            ...streamedToolCallsByChoice.keys(),
            ...completeToolCallsByChoice.keys()
        ]);
        for(const choiceIndex of [...toolChoiceIndexes].sort((left,right)=>left-right)){
            const toolCallRecords=streamedToolCallsByChoice.get(choiceIndex)??new Map();
            const orderedToolCalls=[...toolCallRecords.values()].sort(
                function sortStreamedToolCalls(a,b){
                    return a.index-b.index;
                }
            );
            for(let index=0;index<orderedToolCalls.length;index+=1){
                if(orderedToolCalls[index].index!==index){
                    throw aiStructuralError(
                        'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                        `AI stream choice ${choiceIndex} omitted an ordered structural tool-call index.`
                    );
                }
            }
            const rawToolCalls=orderedToolCalls.map(
                function completeStreamedToolCall(toolCall,index){
                    if(
                        toolCall.invalidArguments
                        ||toolCall.invalidIdentity
                        ||toolCall.invalidName
                    ){
                        throw aiStructuralError(
                            'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                            `AI stream choice ${choiceIndex} structural tool call ${index+1} changed an exact field.`
                        );
                    }
                    return {
                        id:toolCall.id,
                        type:toolCall.type,
                        function:{
                            name:toolCall.name,
                            arguments:toolCall.arguments
                        }
                    };
                }
            );
            const streamedCalls=normalizeAIStreamToolCallObservation(
                    {message:{tool_calls:rawToolCalls}},
                    `AI stream choice ${choiceIndex}`
                );
            const completeCalls=completeToolCallsByChoice.get(choiceIndex);
            if(completeCalls!==undefined){
                if(
                    streamedCalls.length
                    &&(
                        streamedCalls.length!==completeCalls.length
                        ||streamedCalls.some(
                            (call,index)=>!sameAICanonicalToolCall(call,completeCalls[index])
                        )
                    )
                ){
                    throw aiStructuralError(
                        'AI_CHAT_STREAM_TOOL_CALL_MISMATCH',
                        `AI stream choice ${choiceIndex} changed or omitted its terminal structural tool calls.`
                    );
                }
                structuralToolCallsByChoice.set(choiceIndex,completeCalls);
            }else{
                structuralToolCallsByChoice.set(choiceIndex,streamedCalls);
            }
        }
        const completionChoiceIndexes=[...streamedChoiceOrder];
        for(const choiceIndex of structuralToolCallsByChoice.keys()){
            if(!completionChoiceIndexes.includes(choiceIndex)){
                completionChoiceIndexes.push(choiceIndex);
            }
        }
        if(!completionChoiceIndexes.length) completionChoiceIndexes.push(0);
        const selectedTerminalChoiceIndex=selectedChoiceIndex??completionChoiceIndexes[0];
        const structuralToolCalls=structuralToolCallsByChoice.get(selectedTerminalChoiceIndex)||[];
        const completionChoices=completionChoiceIndexes
            .map(function completeBuiltInStreamChoice(choicePosition){
                const retained=streamedChoicesByIndex.get(choicePosition)||{
                    choice:{index:choicePosition},
                    message:{role:'assistant'}
                };
                const toolCalls=structuralToolCallsByChoice.get(choicePosition)||[];
                const finishReason=retained.choice.finish_reason;
                const hasToolCalls=structuralToolCallsByChoice.has(choicePosition);
                return {
                    ...retained.choice,
                    index:Number.isSafeInteger(retained.choice.index)
                        &&retained.choice.index>=0
                        ?retained.choice.index
                        :choicePosition,
                    message:{
                        ...retained.message,
                        role:'assistant',
                        content:Object.hasOwn(retained.message,'content')
                            ?retained.message.content
                            :'',
                        ...(hasToolCalls?{tool_calls:toolCalls}:{})
                    },
                    finish_reason:Object.hasOwn(retained.choice,'finish_reason')
                        ?finishReason
                        :toolCalls.length?'tool_calls':'stop'
                };
            });
        const completion={
            ...streamMetadata,
            id:Object.hasOwn(streamMetadata,'id')?streamMetadata.id:`stream-${id}`,
            object:Object.hasOwn(streamMetadata,'object')
                ?streamMetadata.object
                :'chat.completion',
            created:Object.hasOwn(streamMetadata,'created')
                ?streamMetadata.created
                :Math.floor(Date.now()/1000),
            model:Object.hasOwn(streamMetadata,'model')?streamMetadata.model:this.model,
            choices:completionChoices
        };
        const terminalToolCalls=normalizeAICompletionToolCalls(completion);
        assertAIStreamToolCallCorrelation(
            structuralToolCalls,
            terminalToolCalls,
            'The built-in HTTP stream'
        );
        await dataResultHandler(completion,id);
        for(const call of terminalToolCalls){
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            await earlyFunctionTrigger(call,`M-${id}`);
        }
        const streamResult=this.#providerCompletionOutput(completion);
        if(finishSpeech){
            this.finishTTS();
        }
        await streamComplete(streamResult, `M-${id}`,isThinking);

        //sync
        speechTurnCompleted=true;
        return returnCompletion?completion:streamResult;
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
        parallelToolCalls,
        id=Date.now(),
        signal=null,
        onRequest=function ignoreFetchRequest(){},
        onResponse=function ignoreFetchResponse(){},
        maxOutputTokens,
        maxTokens,
        temperature,
        topK,
        topP,
        repeatPenalty,
        minP,
        seed,
        stop,
        templateOptions,
        reasoningEffort
    }={}){
        validateAIStructuralRequest(messages,tools,parallelToolCalls);
        const normalizedReasoningEffort=normalizeAIReasoningEffort(
            reasoningEffort===undefined?this.reasoningEffort:reasoningEffort
        );
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
                ...(parallelToolCalls!==undefined?{parallelToolCalls}:{}),
                id,
                ...(maxOutputTokens!==undefined
                    ?{maxTokens:maxOutputTokens}
                    :maxTokens!==undefined?{maxTokens}:{}),
                ...(temperature!==undefined?{temperature}:{}),
                ...(topK!==undefined?{topK}:{}),
                ...(topP!==undefined?{topP}:{}),
                ...(repeatPenalty!==undefined?{repeatPenalty}:{}),
                ...(minP!==undefined?{minP}:{}),
                ...(seed!==undefined?{seed}:{}),
                ...(stop!==undefined?{stop}:{}),
                ...(templateOptions!==undefined?{templateOptions}:{}),
                ...(normalizedReasoningEffort
                    ?{reasoningEffort:normalizedReasoningEffort}
                    :{})
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
            normalizeAICompletionToolCalls(response);
            await onResponse(response,id,false);
            if(signal?.aborted){
                throw normalizeAIRequestAbort();
            }
            return response;
        }

        return this.#fetchBuiltIn(
            messages,
            onResponse,
            structuredOutput,
            tools,
            toolChoice,
            parallelToolCalls,
            id,
            onRequest,
            signal,
            normalizedReasoningEffort
        );
    }

    async fetch(
        messages=[],
        responseHandler=function ignoreFetchResponse(){},
        structuredOutput=false,
        tools=[],
        tool_choice='auto',
        parallel_tool_calls,
        id=Date.now(),
        requestHandler=function ignoreFetchRequest(){},
        signal=null
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

        return this.#fetchBuiltIn(
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

    async #fetchBuiltIn(
        messages=[],
        responseHandler=function ignoreFetchResponse(){},
        structuredOutput=false,
        tools=[],
        tool_choice='auto',
        parallel_tool_calls,
        id=Date.now(),
        requestHandler=function ignoreFetchRequest(){},
        signal=null,
        reasoningEffort
    ){
        validateAIStructuralRequest(messages,tools,parallel_tool_calls);
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

        const normalizedReasoningEffort=normalizeAIReasoningEffort(
            reasoningEffort===undefined?this.reasoningEffort:reasoningEffort
        );
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
            if(parallel_tool_calls!==undefined){
                request.parallel_tool_calls=parallel_tool_calls;
            }
        }

        if(
            normalizedReasoningEffort
            &&(this.llmService==='OPENAI'||this.llmService==='OLLAMA')
        ){
            request.reasoning_effort=normalizedReasoningEffort;
        }

        const nativeOllama=this.#nativeOllama();

        if(this.llmService==='OLLAMA'&&!nativeOllama){
            throw aiProviderError(
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
                ...(normalizedReasoningEffort
                    ?{think:normalizedReasoningEffort}
                    :{}),
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
            const responseJSON=this.#openAICompatibleOllamaResponse(
                nativeResponse,
                id
            );
            this.#assertRequiredOllamaToolCall(
                normalizeAICompletionToolCalls(responseJSON),
                tool_choice
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
        normalizeAICompletionToolCalls(responseJSON);
        await responseHandler(responseJSON,id,false);
        //sync
        return responseJSON;
    }

    get ttsSegmentation(){
        return {...this.#ttsSegmentation};
    }

    configureTTSSegmentation(options={}){
        this.#ttsSegmentation=normalizeTTSSegmentation(
            options,
            this.#ttsSegmentation
        );
        return this.ttsSegmentation;
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
            this.#publishTTSFailure(error,{
                boundary:'synthesis',
                generation:this.speechGeneration
            });
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
        let remainder=this.audioMessageChunks;

        while(remainder.length>0){
            const punctuationBoundary=this.#findSpeechPunctuationBoundary(
                remainder,
                end
            );
            const cadenceBoundary=this.#findSpeechCadenceBoundary(remainder,end);
            let boundary=punctuationBoundary;

            if(boundary<0||(cadenceBoundary>0&&cadenceBoundary<boundary)){
                boundary=cadenceBoundary;
            }

            if(boundary<0&&end){
                boundary=remainder.length;
            }

            if(boundary<0){
                break;
            }

            const segment=remainder.slice(0,boundary);
            remainder=remainder.slice(boundary);

            if(segment){
                segments.push(segment);
            }
        }

        this.audioMessageChunks=remainder;
        return segments;
    }

    #findSpeechPunctuationBoundary(text,end=false){
        if(this.#ttsSegmentation.punctuation==='none'){
            return -1;
        }
        if(this.#ttsSegmentation.punctuation==='any'){
            return this.#findAnySpeechPunctuationBoundary(text,end);
        }

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

            return this.#includeSpeechBoundaryWhitespace(
                text,
                terminator.index+terminator[0].length
            );
        }

        return -1;
    }

    #findAnySpeechPunctuationBoundary(text,end=false){
        const pattern=end
            ?TTS_ANY_PUNCTUATION_AT_END
            :TTS_ANY_PUNCTUATION;
        pattern.lastIndex=0;
        const firstContent=text.search(/\S/u);
        let punctuation;

        while((punctuation=pattern.exec(text))){
            if(firstContent<0||punctuation.index<=firstContent){
                continue;
            }
            const boundary=punctuation.index+punctuation[0].length;
            return this.#includeSpeechBoundaryWhitespace(text,boundary);
        }

        return -1;
    }

    #findSpeechCadenceBoundary(text,end=false){
        const wordCadence=this.#ttsSegmentation.wordCadence;
        if(wordCadence===null){
            return -1;
        }

        const words=/\S+/gu;
        let word;
        let wordCount=0;

        while((word=words.exec(text))){
            wordCount+=1;
            if(wordCount!==wordCadence){
                continue;
            }
            const boundary=word.index+word[0].length;
            if(boundary===text.length&&!end){
                return -1;
            }
            if(boundary<text.length&&!/\s/u.test(text[boundary])){
                return -1;
            }
            return this.#includeSpeechBoundaryWhitespace(text,boundary);
        }

        return -1;
    }

    #includeSpeechBoundaryWhitespace(text,boundary){
        let completeBoundary=boundary;
        while(
            completeBoundary<text.length
            &&/\s/u.test(text[completeBoundary])
        ){
            completeBoundary+=1;
        }
        return completeBoundary;
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
                return runtime.#failSpeechJob(
                    job,
                    error,
                    job.state==='decoding'?'decode':'synthesis'
                );
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

        job.state='decoding';
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
            throw aiProviderError(
                'The selected TTS provider returned an invalid speech format catalog.',
                'ARCANE_AI_PROVIDER_RUNTIME_INVALID'
            );
        }
        if(formats.includes(this.audioFormat)){
            return this.audioFormat;
        }
        if(this.audioFormat===DEFAULT_TTS_RESPONSE_FORMAT){
            return defaultFormat;
        }
        throw aiProviderError(
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
                :this.#builtInSpeechDefaultVoice('tts',this.ttsService);
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

        return this.#requestBuiltInSpeechSynthesis(
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

        const text=await this.#requestBuiltInSpeechTranscription(
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
            if(error?.name!=='NotAllowedError'){
                this.#publishTTSFailure(error,{
                    boundary:'playback-resume',
                    generation:this.speechGeneration
                });
            }
            return false;
        }

        this.#waitForSpeechGesture();
        return false;
    }

    async playAudio(
        audioChunks=[],
        audioContext=null,
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
            const playbackContext=audioContext||this.#getSpeechAudioContext();
            const audioBlob=new Blob(audioChunks,{type:audioType});
            const arrayBuffer=await audioBlob.arrayBuffer();
            const audioBuffer=await playbackContext.decodeAudioData(arrayBuffer);

            if(this.muted||job.generation!==this.speechGeneration){
                return this.#cancelSpeechJob(job);
            }

            const preparedSource=sourceNode||playbackContext.createBufferSource();
            const runtime=this;

            preparedSource.buffer=audioBuffer;
            preparedSource.connect(playbackContext.destination);
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
            return this.#failSpeechJob(job,error,'decode');
        }
    }

    #requestSpeechPlayback(){
        const runtime=this;
        this.#pumpSpeechPlayback().catch(
            function reportSpeechPlaybackFailure(error){
                const job=runtime.speechJobs[0];
                if(job){
                    runtime.#failSpeechJob(job,error,'playback-start');
                    return;
                }
                console.error('AI audio playback failed without an active speech job.',error);
            }
        );
    }

    async #pumpSpeechPlayback(){
        if(this.speechPlaybackStarting||this.isSpeaking||this.muted){
            return false;
        }

        this.speechPlaybackStarting=true;
        let activeJob=null;

        try{
            while(!this.isSpeaking&&!this.muted){
                const job=this.speechJobs[0];
                activeJob=job||null;

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
                    await job.sourceNode.start(0);
                    return true;
                }catch(error){
                    this.currentSpeechJob=null;
                    this.isSpeaking=false;
                    this.#failSpeechJob(job,error,'playback-start');
                }
            }
        }catch(error){
            if(activeJob){
                this.#failSpeechJob(activeJob,error,'playback-start');
            }else if(!this.muted&&!isAIRequestAbort(error)){
                console.error('AI audio playback failed without an active speech job.',error);
            }
            return false;
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

    #publishTTSFailure(error,{
        boundary='synthesis',
        generation=this.speechGeneration
    }={}){
        if(
            generation!==this.speechGeneration
            ||this.muted
            ||isAIRequestAbort(error)
        ){
            return false;
        }

        const boundaries=new Set([
            'synthesis',
            'decode',
            'playback-start',
            'playback-resume'
        ]);
        const normalizedBoundary=boundaries.has(boundary)
            ?boundary
            :'synthesis';
        const reason=`tts-${normalizedBoundary}-rejected`;
        const operationId=
            `${this.#events.instanceId}:tts-failure:${(++this.#speechFailureSequence).toString(36)}`;

        console.error(`AI speech ${normalizedBoundary} failed.`,error);

        try{
            const {occurrence}=this.#events.dispatch(
                AI_TTS_FAILURE_EVENT,
                completeValue({
                    ai:this,
                    boundary:normalizedBoundary,
                    error,
                    generation,
                    reason
                }),
                {
                    operationId,
                    publicDetail:completeValue({
                        boundary:normalizedBoundary,
                        ...(typeof error?.code==='string'?{code:error.code}:{}),
                        generation,
                        reason
                    })
                }
            );
            projectArcaneDOMEvent(window,occurrence);
        }catch(reportingError){
            console.error(
                'AI speech failure could not be published to the runtime event boundary.',
                reportingError
            );
        }

        return true;
    }

    #failSpeechJob(job,error,boundary='synthesis'){
        if(job.state==='failed'||job.state==='cancelled'){
            return false;
        }

        job.state='failed';

        this.#publishTTSFailure(error,{
            boundary,
            generation:job.generation
        });

        if(job.sourceNode){
            job.sourceNode.onended=null;
        }

        this.#removeSpeechJob(job);

        if(this.currentSpeechJob===job){
            this.currentSpeechJob=null;
            this.isSpeaking=false;
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
    registration=completeValue({
        protocol:AI_USER_READY_REGISTRATION_PROTOCOL,
        dispose:disposeAIUserReadyRegistration
    });
    unsubscribe=arcaneEvents.subscribe(
        'user-entity-loaded',
        function initializeAIFromCanonicalUser(){
            if(!window.user?.ready)return;
            registration.dispose();
            instantiateAI();
        }
    );
    Object.defineProperty(
        globalThis,
        AI_USER_READY_REGISTRATION_KEY,
        {
            value:registration,
            configurable:true,
            enumerable:false,
            writable:true
        }
    );
    if(window.user?.ready){
        registration.dispose();
        instantiateAI();
        return null;
    }
    return registration;
}

function instantiateAI() {
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
