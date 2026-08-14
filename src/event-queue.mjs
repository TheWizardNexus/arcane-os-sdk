function callbackError(value){
    if(value instanceof Error){
        return value;
    }
    return new Error(`The event callback failed: ${String(value)}`,{cause:value});
}

export function createEventQueue(onEvent,{onFailure}={}){
    const callback=typeof onEvent==='function'?onEvent:null;
    let firstError=null;
    let tail=Promise.resolve();
    const pendingKeys=new Set();
    let resolveFailure;
    const failure=new Promise(resolve=>{
        resolveFailure=resolve;
    });

    const capture=error=>{
        if(firstError){
            return;
        }
        firstError=callbackError(error);
        resolveFailure(firstError);
        try{
            const result=onFailure?.(firstError);
            if(result&&typeof result.then==='function'){
                void Promise.resolve(result).catch(()=>{});
            }
        }catch{
            // The callback failure remains authoritative. Failure cleanup must
            // never create a second unhandled error.
        }
    };

    const enqueue=(event,{coalesce}={})=>{
        if(!callback||firstError){
            return tail;
        }
        if(coalesce&&pendingKeys.has(coalesce)){
            return tail;
        }
        if(coalesce){
            pendingKeys.add(coalesce);
        }
        const task=tail.then(async()=>{
            if(firstError){
                return;
            }
            try{
                await callback(Object.freeze(event));
            }catch(error){
                capture(error);
            }
        });
        tail=task.finally(()=>{
            if(coalesce){
                pendingKeys.delete(coalesce);
            }
        }).catch(capture);
        return tail;
    };

    const send=async event=>{
        await enqueue(event);
        if(firstError){
            throw firstError;
        }
    };

    const drain=async()=>{
        let observed;
        do{
            observed=tail;
            await observed;
        }while(observed!==tail);
        if(firstError){
            throw firstError;
        }
    };

    return Object.freeze({
        drain,
        enqueue,
        failure,
        send,
        get error(){return firstError;}
    });
}
