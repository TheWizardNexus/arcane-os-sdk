function parseArguments(value,name=''){
    let parsed=value;
    if(typeof parsed==='string'){
        try{
            parsed=JSON.parse(parsed);
        }catch(error){
            console.warn(error);
            throw new Error(`Tool ${name} returned invalid JSON arguments.`);
        }
    }
    const prototype=parsed&&typeof parsed==='object'
        ?Object.getPrototypeOf(parsed)
        :undefined;
    if(
        !parsed
        ||typeof parsed!=='object'
        ||Array.isArray(parsed)
        ||(prototype!==Object.prototype&&prototype!==null)
        ||typeof parsed.message!=='string'
        ||!parsed.message.trim()
    ){
        const error=new Error(
            `Tool ${name} must provide a nonempty user-facing message in its arguments.`
        );
        error.code='AI_TOOL_MESSAGE_REQUIRED';
        throw error;
    }
    return parsed;
}

function getResponseCalls(response={}){
    const calls=response?.choices?.[0]?.message?.tool_calls;

    if(!Array.isArray(calls)||!calls.length){
        throw new Error('AI response did not contain a tool call.');
    }

    return calls;
}

function dispatch(name='',argumentsValue='',handlers={}){
    if(typeof handlers[name]!=='function'){
        throw new Error(`No handler is registered for tool ${name}.`);
    }

    return handlers[name](
        parseArguments(argumentsValue,name)
    );
}

async function handleResponse(response={},handlers={}){
    const calls=getResponseCalls(response);
    const results=[];

    for(let i=0;i<calls.length;i++){
        const toolCall=calls[i]?.function;

        if(!toolCall?.name){
            throw new Error('AI response contained an invalid tool call.');
        }

        results.push(
            await dispatch(
                toolCall.name,
                toolCall.arguments,
                handlers
            )
        );
    }

    return results.length===1
        ?results[0]
        :results;
}

async function handleStreamedCalls(calls={},handlers={}){
    if(!calls||typeof calls!=='object'||Array.isArray(calls)){
        throw new Error('Streamed tool calls must be an object.');
    }

    const names=Object.keys(calls);

    return Promise.allSettled(
        names.map(
            name=>Promise.resolve().then(
                ()=>dispatch(name,calls[name],handlers)
            )
        )
    );
}

export {
    handleResponse,
    handleStreamedCalls,
    parseArguments
};
