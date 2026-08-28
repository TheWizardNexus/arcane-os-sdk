import {createArcaneEventSource} from 'arcane-os/event-manager';
import Preference,{preferenceSchema} from '../entities/Preference.js';
import {resolveApplicationLocalStorageKey} from './AppDataScope.js';

export const PREFERENCE_STORE_ERROR_CODES=Object.freeze({
    adapterInvalid:'ARCANE_PREFERENCE_STORE_ADAPTER_INVALID',
    disposed:'ARCANE_PREFERENCE_STORE_DISPOSED',
    eventDetailInvalid:'ARCANE_PREFERENCE_EVENT_DETAIL_INVALID',
    keyUnknown:'ARCANE_PREFERENCE_KEY_UNKNOWN',
    operationAborted:'ARCANE_PREFERENCE_STORE_OPERATION_ABORTED',
    operationOptionsInvalid:'ARCANE_PREFERENCE_STORE_OPERATION_OPTIONS_INVALID',
    valuesInvalid:'ARCANE_PREFERENCE_VALUES_INVALID'
});

export const PREFERENCE_STORE_EVENT_TYPES=Object.freeze({
    change:'preference-change',
    load:'preference-load',
    reset:'preference-reset'
});

function preferenceStoreError(code,reason,message,ErrorType=Error,cause){
    const error=new ErrorType(message);
    error.code=code;
    error.reason=reason;
    if(cause!==undefined) error.cause=cause;
    return error;
}

function disposedError(){
    return preferenceStoreError(
        PREFERENCE_STORE_ERROR_CODES.disposed,
        'preference-store-disposed',
        'The preference store has been disposed.'
    );
}

function operationAbortedError(reason){
    const error=preferenceStoreError(
        PREFERENCE_STORE_ERROR_CODES.operationAborted,
        'preference-operation-aborted',
        'The preference operation was aborted.',
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
        throw preferenceStoreError(
            PREFERENCE_STORE_ERROR_CODES.operationOptionsInvalid,
            'preference-operation-options-invalid',
            'Preference operation options must be a plain object.',
            TypeError
        );
    }
    const keys=Reflect.ownKeys(value);
    if(keys.some(function hasUnsupportedPreferenceOperationOption(key){
        return key!=='signal';
    })){
        throw preferenceStoreError(
            PREFERENCE_STORE_ERROR_CODES.operationOptionsInvalid,
            'preference-operation-options-invalid',
            'Preference operation options support only signal.',
            TypeError
        );
    }
    const signal=value.signal??null;
    if(signal!==null&&!isAbortSignal(signal)){
        throw preferenceStoreError(
            PREFERENCE_STORE_ERROR_CODES.operationOptionsInvalid,
            'preference-operation-signal-invalid',
            'Preference operation signal must be an AbortSignal.',
            TypeError
        );
    }
    return Object.freeze({signal});
}

function setDataProperty(target,key,value){
    Object.defineProperty(
        target,
        key,
        {configurable:true,enumerable:true,value,writable:true}
    );
}

function frozenPreferenceValues(values){
    const copy={};
    for(const [key,value] of Object.entries(values)) setDataProperty(copy,key,value);
    return Object.freeze(copy);
}

function validateAdapter(adapter){
    if(!adapter
        ||typeof adapter.get!=='function'
        ||typeof adapter.set!=='function'
        ||typeof adapter.delete!=='function'){
        throw preferenceStoreError(
            PREFERENCE_STORE_ERROR_CODES.adapterInvalid,
            'preference-storage-adapter-invalid',
            'The preference storage adapter must provide get, set, and delete methods.',
            TypeError
        );
    }
    return adapter;
}

function localAdapter(prefix){
    const storage=globalThis.localStorage;
    const scopedPrefix=resolveApplicationLocalStorageKey(prefix);
    return {
        async get(key){
            const raw=storage?.getItem(`${scopedPrefix}:${key}`);
            return {found:raw!==null&&raw!==undefined,value:raw==null?null:JSON.parse(raw)};
        },
        async set(key,value){
            storage?.setItem(`${scopedPrefix}:${key}`,JSON.stringify(value));
            return {key,value};
        },
        async delete(key){
            storage?.removeItem(`${scopedPrefix}:${key}`);
            return {key,deleted:true};
        }
    };
}

function nativeAdapter(){
    const preferences=globalThis.Arcane?.preferences;
    if(!preferences?.get||!preferences?.set||!preferences?.delete) return null;
    return preferences;
}

function isUnsupportedNativeAdapter(error){
    return error?.code==='ANDROID_CAPABILITY_UNSUPPORTED';
}

function preferenceAdapter(){
    const local=localAdapter('arcane.preferences');
    if(typeof globalThis.arcaneAndroid?.postMessage==='function') return local;
    const native=nativeAdapter();
    if(!native) return local;
    let active=native;
    async function call(method,args){
        try{
            return await active[method](...args);
        }catch(error){
            if(active!==native||!isUnsupportedNativeAdapter(error)) throw error;
            active=local;
            return active[method](...args);
        }
    }
    return {
        async get(key){
            return call('get',[key]);
        },
        async set(key,value){
            return call('set',[key,value]);
        },
        async delete(key){
            return call('delete',[key]);
        }
    };
}

export default class PreferenceStore extends EventTarget{
    #disposed=false;
    #events;
    #operationSequence=0;
    #operationTail=Promise.resolve();
    #pendingOperations=new Set();

    constructor({namespace='arcane',schema=[],adapter=null}={}){
        super();
        this.namespace=String(namespace||'arcane');
        this.schema=preferenceSchema(schema);
        this.adapter=validateAdapter(adapter||preferenceAdapter());
        this.values=this.defaults();
        this.#events=createArcaneEventSource(
            this,
            {
                source:'preference-store',
                eventTypes:Object.freeze(Object.values(PREFERENCE_STORE_EVENT_TYPES))
            }
        );
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    defaults(){
        const values={};
        for(const definition of this.schema){
            setDataProperty(values,definition.key,definition.defaultValue);
        }
        return frozenPreferenceValues(values);
    }

    storageKey(key){return `${this.namespace}.${key}`;}

    definition(key){
        const definition=this.schema.find(function findPreferenceDefinition(item){
            return item.key===key;
        });
        if(!definition){
            throw preferenceStoreError(
                PREFERENCE_STORE_ERROR_CODES.keyUnknown,
                'preference-key-unknown',
                `Unknown preference: ${key}`,
                RangeError
            );
        }
        return definition;
    }

    async load(options={}){
        const operation=normalizeOperationOptions(options);
        const operationId=this.#nextOperationId('load');
        const store=this;
        return this.#enqueueOperation(
            async function loadPreferences(){
                const values={};
                for(const definition of store.schema){
                    const result=await store.adapter.get(
                        store.storageKey(definition.key),
                        Object.freeze({operationId,signal:operation.signal})
                    );
                    store.#assertOperationActive(operation.signal);
                    setDataProperty(
                        values,
                        definition.key,
                        result?.found
                            ?definition.value(result.value)
                            :definition.defaultValue
                    );
                }
                store.values=frozenPreferenceValues(values);
                store.#publish(PREFERENCE_STORE_EVENT_TYPES.load,{},operationId);
                return frozenPreferenceValues(store.values);
            },
            operation.signal
        );
    }

    async set(key,value,options={}){
        const operation=normalizeOperationOptions(options);
        const definition=this.definition(key);
        const normalized=definition.value(value);
        const operationId=this.#nextOperationId('set');
        const store=this;
        return this.#enqueueOperation(
            async function setPreference(){
                await store.adapter.set(
                    store.storageKey(key),
                    normalized,
                    Object.freeze({operationId,signal:operation.signal})
                );
                store.#assertOperationActive(operation.signal);
                store.values=frozenPreferenceValues({...store.values,[key]:normalized});
                store.#publish(
                    PREFERENCE_STORE_EVENT_TYPES.change,
                    {key,value:normalized},
                    operationId
                );
                return normalized;
            },
            operation.signal
        );
    }

    async setAll(values={},options={}){
        const operation=normalizeOperationOptions(options);
        if(!isPlainRecord(values)){
            throw preferenceStoreError(
                PREFERENCE_STORE_ERROR_CODES.valuesInvalid,
                'preference-values-invalid',
                'Preference values must be a plain object.',
                TypeError
            );
        }
        for(const definition of this.schema){
            if(Object.prototype.hasOwnProperty.call(values,definition.key)){
                await this.set(definition.key,values[definition.key],operation);
            }
        }
        this.#assertOperationActive(operation.signal);
        return frozenPreferenceValues(this.values);
    }

    async reset(options={}){
        const operation=normalizeOperationOptions(options);
        const operationId=this.#nextOperationId('reset');
        const store=this;
        return this.#enqueueOperation(
            async function resetPreferences(){
                for(const definition of store.schema){
                    await store.adapter.delete(
                        store.storageKey(definition.key),
                        Object.freeze({operationId,signal:operation.signal})
                    );
                    store.#assertOperationActive(operation.signal);
                }
                store.values=store.defaults();
                store.#publish(PREFERENCE_STORE_EVENT_TYPES.reset,{},operationId);
                return frozenPreferenceValues(store.values);
            },
            operation.signal
        );
    }

    emit(type,detail={}){
        this.#assertOpen();
        if(!isPlainRecord(detail)){
            throw preferenceStoreError(
                PREFERENCE_STORE_ERROR_CODES.eventDetailInvalid,
                'preference-event-detail-invalid',
                'Preference event detail must be a plain object.',
                TypeError
            );
        }
        const eventType=PREFERENCE_STORE_EVENT_TYPES[type]??type;
        this.#publish(eventType,detail,this.#nextOperationId('emit'));
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

    #publish(type,detail,operationId){
        const values=frozenPreferenceValues(this.values);
        const compatibilityDetail=Object.freeze({
            ...detail,
            namespace:this.namespace,
            values
        });
        const publicDetail=Object.freeze({
            namespace:this.namespace,
            values,
            ...(typeof detail.key==='string'
                ?{preferenceId:detail.key,value:detail.value}
                :{})
        });
        this.#events.dispatch(
            type,
            compatibilityDetail,
            {operationId,publicDetail}
        );
    }

    #enqueueOperation(operation,signal){
        this.#assertOperationActive(signal);
        const store=this;
        let abortHandler=null;
        let rejectResult;
        let resolveResult;
        let settled=false;
        const result=new Promise(function capturePreferenceOperationSettlement(resolve,reject){
            resolveResult=resolve;
            rejectResult=reject;
        });
        function cleanupPreferenceOperation(){
            signal?.removeEventListener('abort',abortHandler);
            store.#pendingOperations.delete(cancelPreferenceOperation);
        }
        function settlePreferenceOperation(handler,value){
            if(settled) return false;
            settled=true;
            cleanupPreferenceOperation();
            handler(value);
            return true;
        }
        function cancelPreferenceOperation(error){
            return settlePreferenceOperation(rejectResult,error);
        }
        abortHandler=function abortPreferenceOperation(){
            cancelPreferenceOperation(operationAbortedError(signal.reason));
        };
        store.#pendingOperations.add(cancelPreferenceOperation);
        signal?.addEventListener('abort',abortHandler,{once:true});
        if(signal?.aborted) abortHandler();

        async function runPreferenceOperation(){
            if(settled) return;
            try{
                store.#assertOperationActive(signal);
                const value=await operation();
                store.#assertOperationActive(signal);
                settlePreferenceOperation(resolveResult,value);
            }catch(error){
                settlePreferenceOperation(rejectResult,error);
            }
        }
        const queued=this.#operationTail.then(
            runPreferenceOperation,
            runPreferenceOperation
        );
        this.#operationTail=queued.then(
            function completePreferenceOperationLane(){},
            function recoverPreferenceOperationLane(){}
        );
        return result;
    }
}

export {Preference,preferenceSchema};
