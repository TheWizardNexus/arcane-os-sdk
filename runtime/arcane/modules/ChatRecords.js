function hasUserEntry(chat=[]){
    const messages=Array.isArray(chat)
        ?chat
        :chat?.messages||[];

    return messages.some(
        message=>message?.role==='user'
    );
}

function hasConversationEntry(chat=[]){
    const messages=Array.isArray(chat)
        ?chat
        :chat?.messages||[];

    return hasUserEntry(messages)||messages.some(
        message=>
            message?.role==='assistant'
            &&typeof message.content==='string'
            &&Boolean(message.content.trim())
    );
}

function plainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function coded(error,code){
    if(!error.code)error.code=code;
    return error;
}

function copyCompleteValue(value,seen=new Map()){
    if(value===null||typeof value!=='object')return value;
    if(seen.has(value))return seen.get(value);
    if(Array.isArray(value)){
        const result=[];
        seen.set(value,result);
        for(const item of value)result.push(copyCompleteValue(item,seen));
        return result;
    }
    const result={};
    seen.set(value,result);
    for(const [key,descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value)
    )){
        if(Object.hasOwn(descriptor,'value')){
            result[key]=copyCompleteValue(descriptor.value,seen);
        }
    }
    return result;
}

function providerMessageCopy(message){
    const copy=copyCompleteValue(message);
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

function structuralToolMessage(call,label){
    const argumentValue=call?.function?.arguments;
    if(typeof argumentValue!=='string'){
        throw coded(
            new TypeError(`${label}.function.arguments must be a JSON string.`),
            'AI_CHAT_INVALID_TOOL_CALL'
        );
    }
    let argumentsRecord;
    try{
        argumentsRecord=JSON.parse(argumentValue);
    }catch(cause){
        throw coded(
            new TypeError(`${label}.function.arguments must encode a JSON object.`,{cause}),
            'AI_CHAT_INVALID_TOOL_CALL'
        );
    }
    if(!plainRecord(argumentsRecord)){
        throw coded(
            new TypeError(`${label}.function.arguments must encode a JSON object.`),
            'AI_CHAT_INVALID_TOOL_CALL'
        );
    }
    if(typeof argumentsRecord.message!=='string'||!argumentsRecord.message.trim()){
        throw coded(
            new TypeError(`${label}.function.arguments.message must contain user-facing text.`),
            'AI_CHAT_TOOL_MESSAGE_REQUIRED'
        );
    }
    return argumentsRecord.message;
}

function activeToolProtocolState(messages){
    const pending=new Set();
    let start=-1;
    for(let index=0;index<messages.length;index++){
        const message=messages[index];
        if(message?.role==='assistant'){
            if(start>=0&&!pending.size)start=-1;
            if(Array.isArray(message.tool_calls)){
                if(!pending.size&&message.tool_calls.length)start=index;
                for(const call of message.tool_calls){
                    if(typeof call?.id==='string'&&call.id)pending.add(call.id);
                }
            }
        }
        if(message?.role==='tool'&&typeof message.tool_call_id==='string'){
            pending.delete(message.tool_call_id);
        }
    }
    return {pending:pending.size,start};
}

function appendOrdinaryMessages(result,message,index){
    if(!plainRecord(message))return;
    if(['system','user'].includes(message.role)){
        if(Object.hasOwn(message,'content')){
            result.push({role:message.role,content:message.content});
        }
        return;
    }
    if(message.role==='assistant'){
        if(message.content!==undefined&&message.content!==null&&String(message.content)){
            result.push({role:'assistant',content:String(message.content)});
        }
        if(message.tool_calls===undefined)return;
        if(!Array.isArray(message.tool_calls)){
            throw coded(
                new TypeError(`Chat message ${index+1}.tool_calls must be an array.`),
                'AI_CHAT_INVALID_TOOL_CALL'
            );
        }
        for(let callIndex=0;callIndex<message.tool_calls.length;callIndex++){
            result.push({
                role:'assistant',
                content:structuralToolMessage(
                    message.tool_calls[callIndex],
                    `Chat message ${index+1}.tool_calls[${callIndex}]`
                )
            });
        }
        return;
    }
    if(message.role!=='tool')return;
    const content=typeof message.tool_call_id==='string'
        ?message.persistence_message??message.message
        :message.content;
    if(typeof content==='string'&&content.trim()){
        result.push({role:'assistant',content});
    }
}

/**
 * Projects retained chat state into recurring provider context. Raw structural
 * protocol is preserved only for the one unresolved continuation at the tail.
 * Settled exchanges become complete ordinary visible conversation messages.
 */
function recurringChatMessages(chat=[],{settleCompleteToolTail=false}={}){
    const messages=Array.isArray(chat)
        ?chat
        :chat?.messages||[];
    const active=activeToolProtocolState(messages);
    const activeStart=settleCompleteToolTail&&!active.pending
        ?-1
        :active.start;
    const settledEnd=activeStart<0?messages.length:activeStart;
    const result=[];
    for(let index=0;index<settledEnd;index++){
        appendOrdinaryMessages(result,messages[index],index);
    }
    if(activeStart>=0){
        for(let index=activeStart;index<messages.length;index++){
            result.push(providerMessageCopy(messages[index]));
        }
    }
    return result;
}

export {
    hasConversationEntry,
    hasUserEntry,
    recurringChatMessages
};
