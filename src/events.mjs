import {randomUUID} from 'node:crypto';
import {CLI_EVENT_PROTOCOL,OUTPUT_MODES} from './constants.mjs';
import {ArcaneError,ERROR_CODES,errorRecord} from './errors.mjs';

function write(stream,value){
    stream.write(`${value}\n`);
}

function jsonSafe(value,seen=new WeakSet()){
    if(value===undefined||value===null||typeof value==='string'
        ||typeof value==='number'||typeof value==='boolean'){
        return value;
    }

    if(typeof value==='bigint'){
        return value.toString();
    }

    if(typeof value==='function'||typeof value==='symbol'){
        return undefined;
    }

    if(value instanceof Error){
        return errorRecord(value);
    }

    if(Array.isArray(value)){
        if(seen.has(value)){
            return undefined;
        }

        seen.add(value);
        const result=value.map(item=>jsonSafe(item,seen)).filter(item=>item!==undefined);
        seen.delete(value);
        return result;
    }

    if(typeof value==='object'){
        if(seen.has(value)){
            return undefined;
        }

        seen.add(value);
        const result={};
        for(const [key,item] of Object.entries(value)){
            const safe=jsonSafe(item,seen);
            if(safe!==undefined){
                result[key]=safe;
            }
        }
        seen.delete(value);
        return result;
    }

    return String(value);
}

function humanEvent(event){
    const label=event.message||event.type;
    return `[${event.sequence}] ${label}`;
}

export function createReporter({
    command,
    output='human',
    stdout=process.stdout,
    stderr=process.stderr,
    operationId=randomUUID(),
    clock=()=>new Date()
}={}){
    if(!OUTPUT_MODES.includes(output)){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `Unsupported output mode: ${String(output)}. Expected human, json, or ndjson.`
        );
    }

    let sequence=0;
    let accepted=false;
    let terminal=false;

    function event(type,{message,data,status}={}){
        return {
            protocol:CLI_EVENT_PROTOCOL,
            operationId,
            sequence:++sequence,
            timestamp:clock().toISOString(),
            command,
            type,
            ...(status?{status}:{}),
            ...(message?{message}:{}),
            ...(data===undefined?{}:{data:jsonSafe(data)})
        };
    }

    function streamEvent(current){
        if(output==='ndjson'){
            write(stdout,JSON.stringify(current));
        }else if(output==='json'){
            write(stderr,JSON.stringify(current));
        }else{
            write(stderr,humanEvent(current));
        }
        return current;
    }

    function accept(data){
        if(accepted){
            return null;
        }
        accepted=true;
        return streamEvent(event('operation.accepted',{
            status:'accepted',
            message:`Accepted ${command}.`,
            data
        }));
    }

    function emit(type,data,message){
        if(!accepted){
            throw new ArcaneError(
                ERROR_CODES.operationFailed,
                'The operation must be accepted before work events are emitted.'
            );
        }
        if(terminal){
            return null;
        }
        return streamEvent(event(type,{message,data,status:'running'}));
    }

    function complete(result){
        if(terminal){
            return null;
        }
        terminal=true;
        const current=event('operation.completed',{
            status:'completed',
            message:`Completed ${command}.`,
            data:{result}
        });

        if(output==='ndjson'){
            write(stdout,JSON.stringify(current));
        }else if(output==='json'){
            write(stdout,JSON.stringify({
                protocol:CLI_EVENT_PROTOCOL,
                ok:true,
                operationId,
                command,
                result:jsonSafe(result)
            }));
        }else{
            if(result!==undefined){
                if(typeof result==='string'){
                    write(stdout,result);
                }else{
                    write(stdout,JSON.stringify(jsonSafe(result),null,2));
                }
            }
            write(stderr,humanEvent(current));
        }
        return current;
    }

    function reject(error){
        if(terminal){
            return null;
        }
        terminal=true;
        const normalized=errorRecord(error);
        const current=event(
            normalized.code===ERROR_CODES.cancelled?'operation.cancelled':'operation.failed',
            {
                status:normalized.code===ERROR_CODES.cancelled?'cancelled':'failed',
                message:normalized.message,
                data:{error:normalized}
            }
        );

        if(output==='ndjson'){
            write(stdout,JSON.stringify(current));
        }else if(output==='json'){
            write(stdout,JSON.stringify({
                protocol:CLI_EVENT_PROTOCOL,
                ok:false,
                operationId,
                command,
                error:normalized
            }));
        }else{
            write(stderr,`${normalized.code}: ${normalized.message}`);
        }
        return current;
    }

    function forward(value,data){
        if(typeof value==='string'){
            return emit(value,data);
        }
        if(value&&typeof value==='object'){
            const {type='operation.progress',message,...rest}=value;
            return emit(type,rest.data??rest,message);
        }
        return emit('operation.progress',data);
    }

    return {
        operationId,
        output,
        accept,
        emit,
        forward,
        complete,
        reject,
        get accepted(){return accepted;},
        get terminal(){return terminal;}
    };
}
