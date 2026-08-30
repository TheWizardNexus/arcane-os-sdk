import {createArcaneEventSource} from 'arcane-os/event-manager';
import ApiModelRecord from '../entities/ApiModelRecord.js';

const apiModelEvents={
    requestStarted:'api-model-request',
    requestSucceeded:'api-model-success',
    requestFailed:'api-model-error'
};

export const API_MODEL_EVENTS={...apiModelEvents};
const API_MODEL_EVENT_TYPES=Object.values(apiModelEvents);

const apiModelErrors={
    requestAborted:{code:'ARCANE_API_MODEL_REQUEST_ABORTED',reason:'api-model-request-aborted'},
    cacheReadFailed:{code:'ARCANE_API_MODEL_CACHE_READ_FAILED',reason:'api-model-cache-read-rejected'},
    cacheWriteFailed:{code:'ARCANE_API_MODEL_CACHE_WRITE_FAILED',reason:'api-model-cache-write-rejected'},
    databaseDisposed:{code:'ARCANE_API_MODEL_DATABASE_DISPOSED',reason:'api-model-database-disposed'},
    requestFetchFailed:{code:'ARCANE_API_MODEL_REQUEST_FETCH_FAILED',reason:'api-model-request-fetch-rejected'},
    requestOptionsInvalid:{code:'ARCANE_API_MODEL_REQUEST_OPTIONS_INVALID',reason:'api-model-request-options-invalid'},
    responseContractInvalid:{code:'ARCANE_API_MODEL_RESPONSE_CONTRACT_INVALID',reason:'api-model-response-contract-mismatch'},
    responseJSONInvalid:{code:'ARCANE_API_MODEL_RESPONSE_JSON_INVALID',reason:'api-model-response-json-invalid'},
    responseParseFailed:{code:'ARCANE_API_MODEL_RESPONSE_PARSE_FAILED',reason:'api-model-response-parse-rejected'},
    responseStatusRejected:{code:'ARCANE_API_MODEL_RESPONSE_STATUS_REJECTED',reason:'api-model-response-status-rejected'}
};

export const API_MODEL_ERRORS=Object.fromEntries(
    Object.entries(apiModelErrors).map(function copyApiModelError([key,value]){
        return [key,{...value}];
    })
);

function endpoint(value){
    const url=new URL(String(value||''));
    if(!['http:','https:'].includes(url.protocol))throw new TypeError('API model endpoints must use HTTP or HTTPS.');
    return url.href;
}

function appendParameters(url,parameters={}){
    for(const [key,value] of Object.entries(parameters||{})){
        if(value===undefined||value===null||value==='')continue;
        url.searchParams.set(key,Array.isArray(value)?value.join(','):String(value));
    }
    return url;
}

function publicEndpoint(url){
    const safe=new URL(url);
    for(const key of [...safe.searchParams.keys()]){
        if(/(?:auth|key|password|secret|token)/i.test(key))safe.searchParams.set(key,'[redacted]');
    }
    return safe.href;
}

function signalLike(value){
    return value===undefined
        ||value===null
        ||(
            typeof value==='object'
            &&typeof value.aborted==='boolean'
            &&typeof value.addEventListener==='function'
            &&typeof value.removeEventListener==='function'
        );
}

function errorMessage(value,fallback){
    if(typeof value?.message==='string'&&value.message.trim())return value.message;
    if(typeof value==='string'&&value.trim())return value;
    return fallback;
}

function defineErrorContract(error,contract,cause){
    const priorCode=typeof error?.code==='string'&&error.code?error.code:null;
    try{
        if(priorCode&&priorCode!==contract.code&&!Object.hasOwn(error,'providerCode')){
            Object.defineProperty(error,'providerCode',{configurable:true,enumerable:false,value:priorCode,writable:true});
        }
        Object.defineProperty(error,'code',{configurable:true,enumerable:false,value:contract.code,writable:true});
        Object.defineProperty(error,'reason',{configurable:true,enumerable:false,value:contract.reason,writable:true});
        if(cause!==undefined&&cause!==error&&!('cause' in error)){
            Object.defineProperty(error,'cause',{configurable:true,enumerable:false,value:cause,writable:true});
        }
        return error;
    }catch{
        const replacement=new Error(errorMessage(error,'The API model operation failed.'));
        replacement.code=contract.code;
        replacement.reason=contract.reason;
        if(priorCode&&priorCode!==contract.code)replacement.providerCode=priorCode;
        if(cause!==undefined)replacement.cause=cause;
        else if(error!==undefined)replacement.cause=error;
        return replacement;
    }
}

function apiModelError(error,contract,message){
    const candidate=error&&(typeof error==='object'||typeof error==='function')
        ?error
        :new Error(errorMessage(error,message));
    return defineErrorContract(candidate,contract,error!==candidate?error:undefined);
}

function disposedError(){
    return apiModelError(
        new Error('The API model database has been disposed.'),
        apiModelErrors.databaseDisposed,
        'The API model database has been disposed.'
    );
}

function requestOptions(value){
    if(value===undefined)return {operationId:null,signal:null};
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw apiModelError(
            new TypeError('API model request options must be an object.'),
            apiModelErrors.requestOptionsInvalid,
            'API model request options must be an object.'
        );
    }
    if(!signalLike(value.signal)){
        throw apiModelError(
            new TypeError('API model request signal must be an AbortSignal.'),
            apiModelErrors.requestOptionsInvalid,
            'API model request signal must be an AbortSignal.'
        );
    }
    const operationId=value.operationId??null;
    if(operationId!==null&&(
        typeof operationId!=='string'
        ||operationId.trim()!==operationId
        ||operationId.length<1
    )){
        throw apiModelError(
            new TypeError('API model operationId must contain non-edge-whitespace characters.'),
            apiModelErrors.requestOptionsInvalid,
            'API model operationId is invalid.'
        );
    }
    return {operationId,signal:value.signal??null};
}

function linkAbortSignal(signal,controller,cleanup){
    if(signal===null)return;
    function abortLinkedOperation(){
        if(!controller.signal.aborted)controller.abort(signal.reason);
    }
    if(signal.aborted){
        abortLinkedOperation();
        return;
    }
    signal.addEventListener('abort',abortLinkedOperation,{once:true});
    cleanup.push(function removeLinkedAbortListener(){
        signal.removeEventListener('abort',abortLinkedOperation);
    });
}

function operationError(error,stage,signal){
    if(signal.aborted){
        const reason=signal.reason;
        if(reason
            &&typeof reason==='object'
            &&typeof reason.code==='string'
            &&reason.code
            &&typeof reason.reason==='string'
            &&reason.reason)return reason;
        return apiModelError(reason??error,apiModelErrors.requestAborted,'The API model request was aborted.');
    }
    if(stage==='fetch')return apiModelError(error,apiModelErrors.requestFetchFailed,'The API model request failed.');
    if(stage==='response')return apiModelError(error,apiModelErrors.responseContractInvalid,'The API model response contract is invalid.');
    if(stage==='response-json')return apiModelError(error,apiModelErrors.responseJSONInvalid,'The API model response body is not valid JSON.');
    if(stage==='response-status')return apiModelError(error,apiModelErrors.responseStatusRejected,'The API model response status rejected the request.');
    if(stage==='response-parse')return apiModelError(error,apiModelErrors.responseParseFailed,'The API model response parser failed.');
    return apiModelError(error,apiModelErrors.cacheWriteFailed,'The API model cache write failed.');
}

export default class ApiModelDatabase extends EventTarget{
    #disposed=false;
    #events;
    #operationSequence=0;
    #operations=new Set();

    constructor({endpoint:source,parser=value=>value,fetchImpl=globalThis.fetch,cache=null,request={}}={}){
        super();
        this.endpoint=endpoint(source);
        if(typeof parser!=='function')throw new TypeError('API model parser must be a function.');
        if(typeof fetchImpl!=='function')throw new TypeError('API model fetch implementation must be a function.');
        this.parser=parser;
        this.fetchImpl=fetchImpl;
        this.cache=cache;
        this.request={...request};
        this.latest=null;
        this.#events=createArcaneEventSource(this,{
            source:'api-model-database',
            eventTypes:API_MODEL_EVENT_TYPES
        });
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    #assertOpen(){if(this.#disposed)throw disposedError();}

    #publishError(operation,error){
        if(operation.errorPublished||this.#events.disposed)return false;
        operation.errorPublished=true;
        this.#events.dispatch(
            apiModelEvents.requestFailed,
            {
                requestId:operation.operationId,
                endpoint:operation.visibleEndpoint,
                error,
                reason:error.reason
            },
            {
                operationId:operation.operationId,
                publicDetail:{code:error.code,reason:error.reason}
            }
        );
        return true;
    }

    #startOperation(visibleEndpoint,options){
        const controller=new AbortController();
        const cleanup=[];
        const requestSignal=this.request?.signal??null;
        if(!signalLike(requestSignal)){
            throw apiModelError(
                new TypeError('The configured API model request signal must be an AbortSignal.'),
                apiModelErrors.requestOptionsInvalid,
                'The configured API model request signal must be an AbortSignal.'
            );
        }
        linkAbortSignal(requestSignal,controller,cleanup);
        if(options.signal!==requestSignal)linkAbortSignal(options.signal,controller,cleanup);
        const operationId=options.operationId
            ??`${this.#events.instanceId}:fetch:${(++this.#operationSequence).toString(36)}`;
        const operation={
            cleanup,
            controller,
            errorPublished:false,
            operationId,
            settled:false,
            terminalError:null,
            visibleEndpoint
        };
        this.#operations.add(operation);
        return operation;
    }

    #finishOperation(operation){
        operation.settled=true;
        this.#operations.delete(operation);
        for(const remove of operation.cleanup.splice(0))remove();
    }

    setEndpoint(value){
        this.#assertOpen();
        this.endpoint=endpoint(value);
        return this.endpoint;
    }

    async fetch(parameters={},context={},optionsValue={}){
        this.#assertOpen();
        const options=requestOptions(optionsValue);
        const url=appendParameters(new URL(this.endpoint),parameters);
        const visibleEndpoint=publicEndpoint(url);
        const operation=this.#startOperation(visibleEndpoint,options);
        let started=false;
        let stage='fetch';
        try{
            if(operation.controller.signal.aborted){
                throw operationError(operation.controller.signal.reason,stage,operation.controller.signal);
            }
            started=true;
            this.#events.dispatch(
                apiModelEvents.requestStarted,
                {requestId:operation.operationId,endpoint:visibleEndpoint},
                {
                    operationId:operation.operationId,
                    publicDetail:{requestId:operation.operationId}
                }
            );
            if(operation.controller.signal.aborted)throw operation.controller.signal.reason;
            const request={...this.request};
            delete request.signal;
            const response=await this.fetchImpl(url,{
                method:'GET',
                ...request,
                headers:{Accept:'application/json',...(request.headers||{})},
                signal:operation.controller.signal
            });
            if(operation.controller.signal.aborted)throw operation.controller.signal.reason;
            stage='response';
            if(!response||typeof response!=='object'||typeof response.json!=='function'){
                throw new TypeError('The API model fetch implementation returned an invalid response.');
            }
            stage='response-json';
            const raw=await response.json();
            if(operation.controller.signal.aborted)throw operation.controller.signal.reason;
            stage='response-status';
            if(!response.ok){
                const reason=typeof raw?.reason==='string'&&raw.reason.trim()
                    ?raw.reason
                    :typeof raw?.error==='string'&&raw.error.trim()
                        ?raw.error
                        :`API request failed (${response.status}).`;
                throw new Error(reason);
            }
            stage='response-parse';
            const value=await this.parser(raw,{
                context,
                endpoint:url.href,
                response:{status:response.status,headers:response.headers}
            });
            if(operation.controller.signal.aborted)throw operation.controller.signal.reason;
            const record=new ApiModelRecord({
                endpoint:visibleEndpoint,
                value,
                metadata:{requestId:operation.operationId,status:response.status}
            });
            stage='cache-write';
            if(this.cache?.set){
                await this.cache.set(
                    visibleEndpoint,
                    record.toJSON(),
                    {signal:operation.controller.signal}
                );
            }
            if(operation.controller.signal.aborted)throw operation.controller.signal.reason;
            this.#assertOpen();
            operation.settled=true;
            this.#operations.delete(operation);
            this.latest=record;
            this.#events.dispatch(
                apiModelEvents.requestSucceeded,
                {requestId:operation.operationId,record},
                {
                    operationId:operation.operationId,
                    publicDetail:{requestId:operation.operationId}
                }
            );
            return record;
        }catch(error){
            const normalized=operation.terminalError??operationError(error,stage,operation.controller.signal);
            operation.settled=true;
            this.#operations.delete(operation);
            if(started)this.#publishError(operation,normalized);
            throw normalized;
        }finally{
            this.#finishOperation(operation);
        }
    }

    async cached(parameters={},optionsValue={}){
        this.#assertOpen();
        const options=requestOptions(optionsValue);
        if(options.operationId!==null){
            throw apiModelError(
                new TypeError('cached() does not accept operationId.'),
                apiModelErrors.requestOptionsInvalid,
                'cached() does not accept operationId.'
            );
        }
        if(options.signal?.aborted){
            throw apiModelError(options.signal.reason,apiModelErrors.requestAborted,'The API model cache read was aborted.');
        }
        const url=appendParameters(new URL(this.endpoint),parameters);
        if(!this.cache?.get)return null;
        let value;
        try{
            value=await this.cache.get(
                publicEndpoint(url),
                {signal:options.signal}
            );
        }catch(error){
            if(options.signal?.aborted){
                throw apiModelError(options.signal.reason??error,apiModelErrors.requestAborted,'The API model cache read was aborted.');
            }
            throw apiModelError(error,apiModelErrors.cacheReadFailed,'The API model cache read failed.');
        }
        this.#assertOpen();
        if(options.signal?.aborted){
            throw apiModelError(options.signal.reason,apiModelErrors.requestAborted,'The API model cache read was aborted.');
        }
        return value?new ApiModelRecord(value):null;
    }

    dispose(){
        if(this.#disposed)return false;
        this.#disposed=true;
        for(const operation of [...this.#operations]){
            const error=disposedError();
            operation.terminalError=error;
            this.#publishError(operation,error);
            if(!operation.controller.signal.aborted)operation.controller.abort(error);
            this.#finishOperation(operation);
        }
        return this.#events.dispose();
    }

    destroy(){return this.dispose();}
}

export {appendParameters,publicEndpoint};
