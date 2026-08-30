import {createArcaneEventSource} from 'arcane-os/event-manager';
import {resolveApplicationLocalStorageKey} from './AppDataScope.js';

export const RECORD_REVIEW_STORE_ERROR_CODES={
    adapterInvalid:'ARCANE_RECORD_REVIEW_STORE_ADAPTER_INVALID',
    disposed:'ARCANE_RECORD_REVIEW_STORE_DISPOSED',
    operationAborted:'ARCANE_RECORD_REVIEW_STORE_OPERATION_ABORTED',
    operationOptionsInvalid:'ARCANE_RECORD_REVIEW_STORE_OPERATION_OPTIONS_INVALID',
    recordIdInvalid:'ARCANE_RECORD_REVIEW_ID_INVALID',
    storedRecordsInvalid:'ARCANE_RECORD_REVIEW_STORED_RECORDS_INVALID'
};

export const RECORD_REVIEW_STORE_EVENT_TYPES={
    change:'record-review-change'
};

function recordReviewStoreError(code,reason,message,ErrorType=Error,cause){
    const error=new ErrorType(message);
    error.code=code;
    error.reason=reason;
    if(cause!==undefined) error.cause=cause;
    return error;
}

function disposedError(){
    return recordReviewStoreError(
        RECORD_REVIEW_STORE_ERROR_CODES.disposed,
        'record-review-store-disposed',
        'The record review store has been disposed.'
    );
}

function operationAbortedError(reason){
    const error=recordReviewStoreError(
        RECORD_REVIEW_STORE_ERROR_CODES.operationAborted,
        'record-review-operation-aborted',
        'The record review operation was aborted.',
        Error,
        reason
    );
    error.name='AbortError';
    return error;
}

function isPlainRecord(value){
    if(!value||typeof value!=='object'||Array.isArray(value)) return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function isAbortSignal(value){
    return Boolean(value)
        &&typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function';
}

function normalizeOperationOptions(value={}){
    if(!isPlainRecord(value)){
        throw recordReviewStoreError(
            RECORD_REVIEW_STORE_ERROR_CODES.operationOptionsInvalid,
            'record-review-operation-options-invalid',
            'Record review operation options must be a plain object.',
            TypeError
        );
    }
    const keys=Reflect.ownKeys(value);
    if(keys.some(function hasUnsupportedRecordReviewOperationOption(key){
        return key!=='signal';
    })){
        throw recordReviewStoreError(
            RECORD_REVIEW_STORE_ERROR_CODES.operationOptionsInvalid,
            'record-review-operation-options-invalid',
            'Record review operation options support only signal.',
            TypeError
        );
    }
    const signal=value.signal??null;
    if(signal!==null&&!isAbortSignal(signal)){
        throw recordReviewStoreError(
            RECORD_REVIEW_STORE_ERROR_CODES.operationOptionsInvalid,
            'record-review-operation-signal-invalid',
            'Record review operation signal must be an AbortSignal.',
            TypeError
        );
    }
    return {signal};
}

function setDataProperty(target,key,value){
    Object.defineProperty(
        target,
        key,
        {configurable:true,enumerable:true,value,writable:true}
    );
}

function normalizeRecordId(value=''){
    const id=String(value);
    if(!id.trim()||/[\x00-\x1f]/.test(id)){
        throw recordReviewStoreError(
            RECORD_REVIEW_STORE_ERROR_CODES.recordIdInvalid,
            'record-review-id-invalid',
            'A valid record id is required.',
            TypeError
        );
    }
    return id;
}

function normalizeReview(value={}){
    const source=value&&typeof value==='object'?value:{};
    const attributes={};
    if(source.attributes&&typeof source.attributes==='object'&&!Array.isArray(source.attributes)){
        for(const [key,value] of Object.entries(source.attributes)){
            const normalizedKey=String(key);
            setDataProperty(
                attributes,
                normalizedKey,
                Array.isArray(value)
                    ?value.map(function normalizeReviewAttributeItem(item){
                        return String(item);
                    })
                    :String(value??'')
            );
        }
    }
    return {
        status:source.status===undefined||source.status===null||source.status===''
            ?'not-reviewed'
            :String(source.status),
        classification:source.classification===undefined||source.classification===null||source.classification===''
            ?'unassigned'
            :String(source.classification),
        attributes,
        notes:String(source.notes??''),
        updatedAt:source.updatedAt?String(source.updatedAt):null
    };
}

function recordMap(records){
    const copy={};
    for(const [id,review] of Object.entries(records)){
        setDataProperty(copy,id,normalizeReview(review));
    }
    return copy;
}

function normalizedStoredRecords(value){
    if(!isPlainRecord(value)) return {};
    const records={};
    for(const [recordId,review] of Object.entries(value)){
        let id;
        try{
            id=normalizeRecordId(recordId);
        }catch(error){
            throw recordReviewStoreError(
                RECORD_REVIEW_STORE_ERROR_CODES.storedRecordsInvalid,
                'record-review-stored-id-invalid',
                'Stored record reviews contain an invalid record id.',
                TypeError,
                error
            );
        }
        if(Object.prototype.hasOwnProperty.call(records,id)){
            throw recordReviewStoreError(
                RECORD_REVIEW_STORE_ERROR_CODES.storedRecordsInvalid,
                'record-review-stored-id-collision',
                'Stored record reviews contain colliding record ids.',
                TypeError
            );
        }
        setDataProperty(records,id,normalizeReview(review));
    }
    return records;
}

function validateAdapter(adapter){
    if(!adapter||typeof adapter.get!=='function'||typeof adapter.set!=='function'){
        throw recordReviewStoreError(
            RECORD_REVIEW_STORE_ERROR_CODES.adapterInvalid,
            'record-review-storage-adapter-invalid',
            'The record review storage adapter must provide get and set methods.',
            TypeError
        );
    }
    return adapter;
}

function localAdapter(namespace){
    const key=resolveApplicationLocalStorageKey(`arcane.record-review:${namespace}`);
    return {
        async get(){
            const raw=globalThis.localStorage?.getItem(key);
            if(!raw) return {};
            try{
                return JSON.parse(raw);
            }catch{
                return {};
            }
        },
        async set(value){
            globalThis.localStorage?.setItem(key,JSON.stringify(value));
            return value;
        }
    };
}

function nativeAdapter(namespace){
    const storage=globalThis.Arcane?.storage;
    if(!storage?.get||!storage?.set) return null;
    const key=`record-reviews.${namespace}`;
    return {
        async get(){
            const result=await storage.get(key);
            return result?.value??result??{};
        },
        async set(value){
            await storage.set(key,value);
            return value;
        }
    };
}

class RecordReviewStore extends EventTarget{
    #disposed=false;
    #events;
    #operationSequence=0;
    #operationTail=Promise.resolve();
    #pendingOperations=new Set();

    constructor({namespace='records',adapter=null}={}){
        super();
        this.namespace=namespace===undefined||namespace===null||namespace===''
            ?'records'
            :String(namespace);
        this.adapter=validateAdapter(adapter||nativeAdapter(this.namespace)||localAdapter(this.namespace));
        this.records={};
        this.loaded=false;
        this.#events=createArcaneEventSource(
            this,
            {
                source:'record-review-store',
                eventTypes:Object.values(RECORD_REVIEW_STORE_EVENT_TYPES)
            }
        );
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    async load(options={}){
        const operation=normalizeOperationOptions(options);
        const operationId=this.#nextOperationId('load');
        const store=this;
        return this.#enqueueOperation(
            async function loadRecordReviews(){
                const stored=await store.adapter.get(
                    {operationId,signal:operation.signal}
                );
                store.#assertOperationActive(operation.signal);
                store.records=normalizedStoredRecords(stored);
                store.loaded=true;
                return store.snapshot();
            },
            operation.signal
        );
    }

    get(recordId){
        const id=normalizeRecordId(recordId);
        return normalizeReview(this.records[id]);
    }

    async set(recordId,value={},options={}){
        const operation=normalizeOperationOptions(options);
        const id=normalizeRecordId(recordId);
        const operationId=this.#nextOperationId('set');
        const store=this;
        return this.#enqueueOperation(
            async function setRecordReview(){
                const review=normalizeReview({
                    ...store.get(id),
                    ...value,
                    updatedAt:new Date().toISOString()
                });
                const records=recordMap({...store.records,[id]:review});
                await store.adapter.set(
                    recordMap(records),
                    {operationId,signal:operation.signal}
                );
                store.#assertOperationActive(operation.signal);
                store.records=recordMap(records);
                const detail={
                    namespace:store.namespace,
                    recordId:id,
                    review:normalizeReview(review)
                };
                store.#events.dispatch(
                    RECORD_REVIEW_STORE_EVENT_TYPES.change,
                    detail,
                    {operationId,publicDetail:detail}
                );
                return normalizeReview(review);
            },
            operation.signal
        );
    }

    snapshot(){
        return recordMap(this.records);
    }

    dispose(){
        if(this.#disposed) return false;
        this.#disposed=true;
        const error=disposedError();
        for(const cancel of [...this.#pendingOperations]) cancel(error);
        return this.#events.dispose();
    }

    destroy(){return this.dispose();}

    #assertOpen(){
        if(this.#disposed) throw disposedError();
    }

    #assertOperationActive(signal){
        this.#assertOpen();
        if(signal?.aborted) throw operationAbortedError(signal.reason);
    }

    #nextOperationId(action){
        this.#assertOpen();
        this.#operationSequence+=1;
        return `${this.#events.instanceId}:${action}:${this.#operationSequence.toString(36)}`;
    }

    #enqueueOperation(operation,signal){
        this.#assertOperationActive(signal);
        const store=this;
        let abortHandler=null;
        let rejectResult;
        let resolveResult;
        let settled=false;
        const result=new Promise(function captureRecordReviewOperationSettlement(resolve,reject){
            resolveResult=resolve;
            rejectResult=reject;
        });
        function cleanupRecordReviewOperation(){
            signal?.removeEventListener('abort',abortHandler);
            store.#pendingOperations.delete(cancelRecordReviewOperation);
        }
        function settleRecordReviewOperation(handler,value){
            if(settled) return false;
            settled=true;
            cleanupRecordReviewOperation();
            handler(value);
            return true;
        }
        function cancelRecordReviewOperation(error){
            return settleRecordReviewOperation(rejectResult,error);
        }
        abortHandler=function abortRecordReviewOperation(){
            cancelRecordReviewOperation(operationAbortedError(signal.reason));
        };
        store.#pendingOperations.add(cancelRecordReviewOperation);
        signal?.addEventListener('abort',abortHandler,{once:true});
        if(signal?.aborted) abortHandler();

        async function runRecordReviewOperation(){
            if(settled) return;
            try{
                store.#assertOperationActive(signal);
                const value=await operation();
                store.#assertOperationActive(signal);
                settleRecordReviewOperation(resolveResult,value);
            }catch(error){
                settleRecordReviewOperation(rejectResult,error);
            }
        }
        const queued=this.#operationTail.then(
            runRecordReviewOperation,
            runRecordReviewOperation
        );
        this.#operationTail=queued.then(
            function completeRecordReviewOperationLane(){},
            function recoverRecordReviewOperationLane(){}
        );
        return result;
    }
}

export {normalizeRecordId,normalizeReview};
export default RecordReviewStore;
