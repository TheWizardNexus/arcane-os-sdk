import {AsyncLocalStorage} from 'node:async_hooks';
import {arcaneEvents} from './event-manager.mjs';

const deliveryStorage=new AsyncLocalStorage();

function deliveryOccurrence(event){
    const active=deliveryStorage.getStore();
    if(active&&!active.closed&&Object.is(active.event,event)){
        return active;
    }
    return {
        event,
        managers:new Set(),
        pending:0,
        closed:false
    };
}

function mirror(manager,event,eventMetadata,occurrence){
    if(!manager||!event||typeof event!=='object'||occurrence.managers.has(manager)){
        return;
    }
    occurrence.managers.add(manager);
    try{
        const result=manager.forward(event,eventMetadata);
        if(result&&typeof result.then==='function'){
            void Promise.resolve(result).catch(()=>{});
        }
    }catch{
        // Central instrumentation is observational. Its subscribers must not
        // replace the queue callback's backpressure or failure semantics.
    }
}

function callbackError(value){
    if(value instanceof Error){
        return value;
    }
    return new Error(`The event callback failed: ${String(value)}`,{cause:value});
}

export function createEventQueue(onEvent,{
    onFailure,
    eventManager=arcaneEvents,
    eventMetadata={source:'sdk',category:'operation'}
}={}){
    const callback=typeof onEvent==='function'?onEvent:null;
    const manager=eventManager===null?null:eventManager;
    if(manager&&typeof manager.forward!=='function'){
        throw new TypeError('The central event manager must provide forward(event, metadata).');
    }
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
        if((!callback&&!manager)||firstError){
            return tail;
        }
        if(coalesce&&pendingKeys.has(coalesce)){
            return tail;
        }
        if(coalesce){
            pendingKeys.add(coalesce);
        }
        const occurrence=deliveryOccurrence(event);
        occurrence.pending+=1;
        const task=tail.then(()=>deliveryStorage.run(occurrence,async()=>{
            if(firstError){
                return;
            }
            const current=Object.freeze(event);
            mirror(manager,current,eventMetadata,occurrence);
            try{
                await callback?.(current);
            }catch(error){
                capture(error);
            }
        }));
        tail=task.finally(()=>{
            occurrence.pending-=1;
            if(occurrence.pending===0){
                occurrence.closed=true;
            }
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
