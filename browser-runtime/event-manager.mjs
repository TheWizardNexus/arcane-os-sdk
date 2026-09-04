import EventPubSub from 'event-pubsub';
import {createDOMInstrumentation} from './dom-event-instrumentation.mjs';

export {
    createDOMInstrumentation,
    DEFAULT_DOM_EVENT_TYPES,
    describeDOMTarget,
    DOM_INTERACTION_EVENT,
    DOM_MUTATION_EVENT,
    DOM_OBSERVATION_STARTED_EVENT,
    DOM_OBSERVATION_STOPPED_EVENT,
    domSelector
} from './dom-event-instrumentation.mjs';

export const ARCANE_EVENT_STACK_PROTOCOL='arcane-event-stack/1';
export const ARCANE_EVENT_AUTHORITY_PROTOCOL='arcane-event-authority/1';
export const ARCANE_EVENT_OCCURRENCE_PROTOCOL='arcane-event-occurrence/1';
export const ARCANE_EVENT_SOURCE_PROTOCOL='arcane-event-source/1';
export const ARCANE_EVENT_AUTHORITY_BRAND=Symbol.for('arcane-os.arcane-events-authority');
export const TIME_TRAVEL_SEEK_EVENT='arcane.time-travel.seek';
export const PLAYBACK_STARTED_EVENT='arcane.time-travel.playback.started';
export const PLAYBACK_RECORD_EVENT='arcane.time-travel.playback.record';
export const PLAYBACK_COMPLETED_EVENT='arcane.time-travel.playback.completed';
export const PLAYBACK_CANCELLED_EVENT='arcane.time-travel.playback.cancelled';
export const PLAYBACK_FAILED_EVENT='arcane.time-travel.playback.failed';

export const ARCANE_EVENT_AUTHORITY_KIND='arcane-event-authority';
export const ARCANE_EVENT_SOURCE_KIND='arcane-event-source';
export const ARCANE_EVENT_LISTENER_ERROR_EVENT='arcane.event.listener.error';
export const ARCANE_EVENT_SOURCE_DISPOSED_EVENT='arcane.event.source.disposed';
const ARCANE_EVENT_NAME_PATTERN=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const ARCANE_EVENT_CHANNEL_PREFIX='arcane.event.authority.internal:';
const ARCANE_EVENT_PROJECTION_KEYS=[
    'occurrenceId','arcaneSource','instanceId','operationId'
];
const ARCANE_EVENT_REQUIRED_AUTHORITY_API=[
    'on','once','off','reset','emit','instrument','forward','subscribe','createSource',
    'projectDOMEvent','isOccurrence','addEventListener','removeEventListener'
];
const EVENT_MANAGER_BUS_ON=Symbol('EventManager.busOn');
const EVENT_MANAGER_BUS_OFF=Symbol('EventManager.busOff');
const EVENT_MANAGER_DISPATCH=Symbol('EventManager.dispatch');

const ARCANE_EVENT_ERRORS={
    ARCANE_EVENT_AUTHORITY_ACCESSOR_COLLISION:
        'globalThis.arcaneEvents must be an own data property.',
    ARCANE_EVENT_AUTHORITY_VALUE_COLLISION:
        'globalThis.arcaneEvents is occupied by an unbranded value.',
    ARCANE_EVENT_AUTHORITY_DESCRIPTOR_MISMATCH:
        'The globalThis.arcaneEvents property, authority brand, or protocol descriptor is incompatible.',
    ARCANE_EVENT_AUTHORITY_PROTOCOL_MISMATCH:
        'globalThis.arcaneEvents uses an incompatible authority protocol.',
    ARCANE_EVENT_AUTHORITY_API_MISMATCH:
        'globalThis.arcaneEvents does not expose the required authority API.',
    ARCANE_EVENT_AUTHORITY_INSTALL_FAILED:
        'The Arcane event authority could not be installed on globalThis.',
    ARCANE_EVENT_SOURCE_INVALID:
        'Arcane event source options are invalid.',
    ARCANE_EVENT_SOURCE_ALREADY_REGISTERED:
        'The owner already has an active Arcane event source.',
    ARCANE_EVENT_SOURCE_DISPOSED:
        'The Arcane event source is disposed.',
    ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED:
        'The Arcane event source cannot publish an undeclared event type.',
    ARCANE_EVENT_COMPATIBILITY_DETAIL_INVALID:
        'Arcane event compatibility detail must be safely shallow-copyable.',
    ARCANE_EVENT_OCCURRENCE_INVALID:
        'The Arcane event occurrence value or creation options are invalid.',
    ARCANE_EVENT_OCCURRENCE_SEQUENCE_EXHAUSTED:
        'The Arcane event occurrence sequence is exhausted.',
    ARCANE_EVENT_SOURCE_SEQUENCE_EXHAUSTED:
        'The Arcane event source sequence is exhausted.',
    ARCANE_EVENT_LISTENER_CALLBACK_FAILED:
        'An Arcane event listener threw during observational delivery.',
    ARCANE_EVENT_DOM_DETAIL_COLLISION:
        'Arcane DOM projection metadata conflicts with compatibility detail.',
    ARCANE_EVENT_DOM_TARGET_INVALID:
        'Arcane DOM projection requires a target with dispatchEvent and CustomEvent support.',
    ARCANE_EVENT_DOM_OPTIONS_INVALID:
        'Arcane DOM projection options are invalid.',
    ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID:
        'Arcane event subscription type must be a nonempty trimmed string.',
    ARCANE_EVENT_SUBSCRIPTION_HANDLER_INVALID:
        'Arcane event subscription handler must be a function or EventListener object.',
    ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID:
        'Arcane event subscription options are invalid.',
    ARCANE_EVENT_SUBSCRIPTION_SIGNAL_INVALID:
        'Arcane event subscription signal must be an AbortSignal.',
    ARCANE_EVENT_DISPATCH_EVENT_INVALID:
        'dispatchEvent requires an Event-like object with a valid type and data detail.'
};
export const ARCANE_EVENT_ERROR_CODES=Object.fromEntries(
    Object.keys(ARCANE_EVENT_ERRORS).map(code=>[code,code])
);

const DOCUMENT_KEYS=['protocol','sessionId','createdAt','events'];
const RECORD_KEYS=[
    'protocol','sessionId','id','sequence','timestamp','monotonicMs','type','source',
    'category','correlationId','causationId','parentSequence','depth','stack','payload',
    'metadata','status','completedAt','durationMs','error'
];
const EVENT_STATUSES=new Set(['dispatching','completed','failed']);
const DATE_TO_ISO=Date.prototype.toISOString;
const REGEXP_SOURCE_GETTER=Object.getOwnPropertyDescriptor(RegExp.prototype,'source')?.get;
const REGEXP_FLAG_GETTERS=[
    ['d',Object.getOwnPropertyDescriptor(RegExp.prototype,'hasIndices')?.get],
    ['g',Object.getOwnPropertyDescriptor(RegExp.prototype,'global')?.get],
    ['i',Object.getOwnPropertyDescriptor(RegExp.prototype,'ignoreCase')?.get],
    ['m',Object.getOwnPropertyDescriptor(RegExp.prototype,'multiline')?.get],
    ['s',Object.getOwnPropertyDescriptor(RegExp.prototype,'dotAll')?.get],
    ['u',Object.getOwnPropertyDescriptor(RegExp.prototype,'unicode')?.get],
    ['v',Object.getOwnPropertyDescriptor(RegExp.prototype,'unicodeSets')?.get],
    ['y',Object.getOwnPropertyDescriptor(RegExp.prototype,'sticky')?.get]
];
const MAP_ENTRIES=Map.prototype.entries;
const MAP_SIZE_GETTER=Object.getOwnPropertyDescriptor(Map.prototype,'size')?.get;
const SET_VALUES=Set.prototype.values;
const SET_SIZE_GETTER=Object.getOwnPropertyDescriptor(Set.prototype,'size')?.get;
const TYPED_ARRAY_PROTOTYPE=Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_LENGTH_GETTER=
    Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,'length')?.get;
const TYPED_ARRAY_VALUES=TYPED_ARRAY_PROTOTYPE.values;
const TYPED_ARRAY_TAG_GETTER=
    Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE,Symbol.toStringTag)?.get;
const DATA_VIEW_BUFFER_GETTER=Object.getOwnPropertyDescriptor(DataView.prototype,'buffer')?.get;

function dataObject(entries=[]){
    const result=Object.create(null);
    for(const [key,value] of entries){
        Object.defineProperty(result,key,{
            value,
            enumerable:true,
            configurable:true,
            writable:true
        });
    }
    return result;
}

function snapshotObject(entries=[]){
    const result={};
    for(const [key,value] of entries){
        Object.defineProperty(result,key,{
            value,
            enumerable:true,
            configurable:true,
            writable:true
        });
    }
    return result;
}

function taggedSnapshot(type,entries=[]){
    return snapshotObject([['$type',type],...entries]);
}

function safeDataString(value,key,{fallback=''}={}){
    try{
        const current=Reflect.get(value,key);
        if(typeof current==='string')return current;
    }catch{}
    return fallback;
}

function regexpFlags(value){
    let result='';
    for(const [flag,getter] of REGEXP_FLAG_GETTERS){
        if(typeof getter==='function'&&getter.call(value))result+=flag;
    }
    return result;
}

function safeString(value){
    return String(value);
}

function safeErrorText(error){
    let text='Snapshot capture failed.';
    try{
        if(error!==null&&(typeof error==='object'||typeof error==='function')){
            const message=safeDataString(error,'message');
            if(message)text=message;
        }else if(error!==undefined){
            text=String(error);
        }
    }catch{}
    try{return safeString(text);}
    catch{return 'Snapshot capture failed.';}
}

function sessionIdentifier(){
    if(typeof globalThis.crypto?.randomUUID==='function')return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function clockDate(clock){
    const value=clock();
    const result=value instanceof Date?new Date(value.getTime()):new Date(value);
    if(Number.isNaN(result.getTime()))throw new TypeError('The event clock returned an invalid timestamp.');
    return result;
}

function monotonicValue(now){
    const value=Number(now());
    if(!Number.isFinite(value)||value<0){
        throw new TypeError('The monotonic event clock returned an invalid value.');
    }
    return value;
}

function defaultMonotonicClock(){
    return typeof globalThis.performance?.now==='function'
        ?globalThis.performance.now()
        :Date.now();
}

function sourceStack(){
    const stack=new Error('Arcane event source').stack;
    return typeof stack==='string'?stack:null;
}

function snapshot(value,{
    key='',
    path='$',
    depth=0,
    seen=new Map()
}={}){
    if(value===null||value===undefined||typeof value==='boolean')return value;
    if(typeof value==='string')return safeString(value);
    if(typeof value==='number')return Number.isFinite(value)
        ?value
        :taggedSnapshot('number',[['value',String(value)]]);
    if(typeof value==='bigint')return taggedSnapshot('bigint',[[
        'value',safeString(value.toString())
    ]]);
    if(typeof value==='symbol')return taggedSnapshot('symbol',[[
        'value',value.description===undefined
            ?null
            :safeString(value.description)
    ]]);
    if(typeof value==='function'){
        const name=safeDataString(value,'name');
        return taggedSnapshot('function',[[
            'name',name?safeString(name):null
        ]]);
    }
    if(seen.has(value))return snapshotObject([[
        '$ref',safeString(seen.get(value))
    ]]);
    seen.set(value,path);

    const next=(item,itemKey,itemPath)=>{
        try{
            return snapshot(item,{
                key:itemKey,
                path:safeString(itemPath),
                depth:depth+1,
                seen
            });
        }catch(error){
            return snapshotFailure(error,{
                path:itemPath
            });
        }
    };
    if(value instanceof Date)return taggedSnapshot('date',[['value',DATE_TO_ISO.call(value)]]);
    if(value instanceof RegExp)return taggedSnapshot('regexp',[
        ['source',safeString(REGEXP_SOURCE_GETTER.call(value))],
        ['flags',regexpFlags(value)]
    ]);
    if(value instanceof Error){
        const name=safeDataString(value,'name',{fallback:'Error',inherited:true});
        const message=safeDataString(value,'message');
        const stack=safeDataString(value,'stack');
        const entries=[
            ['name',safeString(name||'Error')],
            ['message',safeString(message)],
            ['stack',stack?safeString(stack):null]
        ];
        let causeDescriptor;
        try{causeDescriptor=Object.getOwnPropertyDescriptor(value,'cause');}catch{}
        if(causeDescriptor){
            let cause;
            try{cause=Reflect.get(value,'cause');}
            catch(error){cause=snapshotFailure(error,{path:`${path}.cause`});}
            entries.push(['cause',next(cause,'cause',`${path}.cause`)]);
        }
        return taggedSnapshot('error',entries);
    }
    if(Array.isArray(value)){
        const result=[];
        for(let index=0;index<value.length;index+=1){
            let item;
            try{item=Reflect.get(value,String(index));}
            catch(error){item=snapshotFailure(error,{path:`${path}[${index}]`});}
            result.push(next(item,String(index),`${path}[${index}]`));
        }
        return result;
    }
    if(value instanceof Map){
        const entries=[];
        let index=0;
        for(const [mapKey,item] of MAP_ENTRIES.call(value)){
            entries.push([
                next(mapKey,'mapKey',`${path}.entries[${index}].key`),
                next(item,'value',`${path}.entries[${index}].value`)
            ]);
            index+=1;
        }
        return taggedSnapshot('map',[['entries',entries]]);
    }
    if(value instanceof Set){
        const values=[];
        let index=0;
        for(const item of SET_VALUES.call(value)){
            values.push(next(item,String(index),`${path}.values[${index}]`));
            index+=1;
        }
        return taggedSnapshot('set',[['values',values]]);
    }
    if(ArrayBuffer.isView(value)){
        const dataView=value instanceof DataView;
        let values;
        let type='DataView';
        if(dataView){
            const buffer=DATA_VIEW_BUFFER_GETTER.call(value);
            values=Array.from(new Uint8Array(buffer));
        }else{
            const length=TYPED_ARRAY_LENGTH_GETTER.call(value);
            type=TYPED_ARRAY_TAG_GETTER.call(value)??'TypedArray';
            values=[];
            const iterator=TYPED_ARRAY_VALUES.call(value);
            while(values.length<length){
                const step=iterator.next();
                if(step.done)break;
                values.push(step.value);
            }
        }
        return taggedSnapshot(type,[['values',values]]);
    }
    if(value instanceof ArrayBuffer){
        return taggedSnapshot('ArrayBuffer',[[
            'values',Array.from(new Uint8Array(value))
        ]]);
    }

    const result=snapshotObject();
    const properties=Reflect.ownKeys(value).filter(property=>{
        if(typeof property!=='string')return false;
        const descriptor=Object.getOwnPropertyDescriptor(value,property);
        return descriptor?.enumerable===true;
    });
    for(let index=0;index<properties.length;index+=1){
        const property=properties[index];
        let item;
        try{item=Reflect.get(value,property);}
        catch(error){item=snapshotFailure(error,{path:`${path}.${property}`});}
        let outputKey=safeString(property);
        if(Object.hasOwn(result,outputKey))outputKey=`$arcaneCollision:${String(index)}`;
        Object.defineProperty(result,outputKey,{
            value:next(item,property,`${path}.${property}`),
            enumerable:true,
            configurable:true,
            writable:true
        });
    }
    return result;
}

function snapshotFailure(error,{path='$'}={}){
    const name=safeDataString(error,'name',{fallback:'Error',inherited:true})||'Error';
    return taggedSnapshot('snapshot-failed',[
        ['name',safeString(name)],
        ['message',safeErrorText(error)],
        ['path',safeString(path)]
    ]);
}

function completeSnapshot(value,options){
    try{return snapshot(value,options);}
    catch(error){return snapshotFailure(error,options);}
}

function completeErrorSnapshot(value,options){
    const captured=completeSnapshot(value,options);
    if(captured&&typeof captured==='object'&&!Array.isArray(captured))return captured;
    return taggedSnapshot('thrown',[['value',captured]]);
}

function normalizeMetadata(metadata){
    if(metadata===undefined)return {};
    if(metadata===null||typeof metadata!=='object'||Array.isArray(metadata)){
        throw new TypeError('Event instrumentation metadata must be an object.');
    }
    return metadata;
}

function abortError(reason){
    if(reason instanceof Error)return reason;
    const error=new Error(reason===undefined?'Playback was aborted.':String(reason));
    error.name='AbortError';
    return error;
}

function wait(milliseconds,signal){
    if(milliseconds<=0)return Promise.resolve();
    return new Promise((resolve,reject)=>{
        if(signal?.aborted){
            reject(abortError(signal.reason));
            return;
        }
        const timer=setTimeout(done,milliseconds);
        function done(){
            signal?.removeEventListener?.('abort',cancel);
            resolve();
        }
        function cancel(){
            clearTimeout(timer);
            signal?.removeEventListener?.('abort',cancel);
            reject(abortError(signal.reason));
        }
        signal?.addEventListener?.('abort',cancel,{once:true});
    });
}

function invalidStack(label){
    throw new TypeError(`${label} is invalid.`);
}

function exactDataObject(value,expectedKeys,label){
    try{
        if(!value||typeof value!=='object'||Array.isArray(value))invalidStack(label);
        const prototype=Object.getPrototypeOf(value);
        if(prototype!==Object.prototype&&prototype!==null)invalidStack(label);
        const keys=Reflect.ownKeys(value);
        if(keys.length!==expectedKeys.length||keys.some(key=>typeof key!=='string')){
            invalidStack(label);
        }
        const expected=new Set(expectedKeys);
        if(keys.some(key=>!expected.has(key)))invalidStack(label);
        const result=dataObject();
        for(const key of expectedKeys){
            const descriptor=Object.getOwnPropertyDescriptor(value,key);
            if(!descriptor||descriptor.enumerable!==true||!('value' in descriptor)){
                invalidStack(label);
            }
            Object.defineProperty(result,key,{
                value:descriptor.value,
                enumerable:true,
                configurable:true,
                writable:true
            });
        }
        return result;
    }catch(error){
        if(error instanceof TypeError&&error.message===`${label} is invalid.`)throw error;
        throw new TypeError(`${label} is invalid.`,{cause:error});
    }
}

function denseArrayValues(value,label){
    try{
        if(!Array.isArray(value)||!Number.isSafeInteger(value.length)||value.length<0){
            invalidStack(label);
        }
        const keys=Reflect.ownKeys(value);
        if(keys.some(key=>typeof key!=='string'))invalidStack(label);
        const expected=new Set(['length']);
        for(let index=0;index<value.length;index+=1)expected.add(String(index));
        if(keys.length!==expected.size||keys.some(key=>!expected.has(key)))invalidStack(label);
        const result=[];
        for(let index=0;index<value.length;index+=1){
            const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
            if(!descriptor||descriptor.enumerable!==true||!('value' in descriptor)){
                invalidStack(label);
            }
            result.push(descriptor.value);
        }
        return result;
    }catch(error){
        if(error instanceof TypeError&&error.message===`${label} is invalid.`)throw error;
        throw new TypeError(`${label} is invalid.`,{cause:error});
    }
}

function cloneImportedValue(value,{
    path='$',
    depth=0,
    seen=new WeakSet()
}){
    if(value===null||typeof value==='boolean')return value;
    if(typeof value==='number'){
        if(!Number.isFinite(value))invalidStack(`Event stack value at ${path}`);
        return value;
    }
    if(typeof value==='string')return value;
    if(!value||typeof value!=='object')invalidStack(`Event stack value at ${path}`);
    if(seen.has(value))invalidStack(`Event stack value at ${path}`);
    seen.add(value);

    if(Array.isArray(value)){
        const items=denseArrayValues(value,`Event stack array at ${path}`);
        return items.map((item,index)=>cloneImportedValue(item,{
            path:`${path}[${String(index)}]`,
            depth:depth+1,
            seen
        }));
    }

    let prototype;
    let keys;
    try{
        prototype=Object.getPrototypeOf(value);
        keys=Reflect.ownKeys(value);
    }catch(error){
        throw new TypeError(`Event stack value at ${path} is invalid.`,{cause:error});
    }
    if((prototype!==Object.prototype&&prototype!==null)
        ||keys.some(key=>typeof key!=='string')){
        invalidStack(`Event stack value at ${path}`);
    }
    const result=dataObject();
    for(const key of keys){
        let descriptor;
        try{descriptor=Object.getOwnPropertyDescriptor(value,key);}catch(error){
            throw new TypeError(`Event stack value at ${path} is invalid.`,{cause:error});
        }
        if(!descriptor||descriptor.enumerable!==true||!('value' in descriptor)){
            invalidStack(`Event stack value at ${path}`);
        }
        Object.defineProperty(result,key,{
            value:cloneImportedValue(descriptor.value,{
                path:`${path}.${key}`,
                depth:depth+1,
                seen
            }),
            enumerable:true,
            configurable:true,
            writable:true
        });
    }
    return result;
}

function canonicalTimestamp(value,label){
    if(typeof value!=='string')invalidStack(label);
    const milliseconds=Date.parse(value);
    if(!Number.isFinite(milliseconds)||new Date(milliseconds).toISOString()!==value){
        invalidStack(label);
    }
    return milliseconds;
}

function recordString(value,label,{nullable=false,empty=true}={}){
    if(nullable&&value===null)return null;
    if(typeof value!=='string'||(!empty&&!value)){
        invalidStack(label);
    }
    return value;
}

function validateRecord(record,index,{
    sessionId
}){
    const label=`Event stack record ${String(index)}`;
    const fields=exactDataObject(record,RECORD_KEYS,label);
    if(fields.protocol!==ARCANE_EVENT_STACK_PROTOCOL||fields.sessionId!==sessionId){
        invalidStack(label);
    }
    if(!Number.isSafeInteger(fields.sequence)||fields.sequence<1
        ||fields.id!==`${sessionId}:${String(fields.sequence)}`){
        invalidStack(label);
    }
    const timestampMs=canonicalTimestamp(fields.timestamp,`${label} timestamp`);
    if(typeof fields.monotonicMs!=='number'||!Number.isFinite(fields.monotonicMs)
        ||fields.monotonicMs<0){
        invalidStack(`${label} monotonic timing`);
    }
    recordString(fields.type,`${label} type`);
    recordString(fields.source,`${label} source`,{empty:false});
    recordString(fields.category,`${label} category`,{
        nullable:true,empty:false
    });
    recordString(fields.correlationId,`${label} correlation`,{
        nullable:true,empty:false
    });
    recordString(fields.causationId,`${label} causation`,{
        nullable:true,empty:false
    });
    if(fields.parentSequence!==null
        &&(!Number.isSafeInteger(fields.parentSequence)||fields.parentSequence<1
            ||fields.parentSequence>=fields.sequence)){
        invalidStack(`${label} parent`);
    }
    if(!Number.isSafeInteger(fields.depth)||fields.depth<0
        ||(fields.parentSequence===null)!==(fields.depth===0)){
        invalidStack(`${label} depth`);
    }
    recordString(fields.stack,`${label} stack`,{nullable:true});
    if(!EVENT_STATUSES.has(fields.status))invalidStack(`${label} status`);

    const payloadValues=denseArrayValues(fields.payload,`${label} payload`);
    const payload=payloadValues.map((item,payloadIndex)=>cloneImportedValue(item,{
        path:`$.events[${String(index)}].payload[${String(payloadIndex)}]`,
        depth:1,
        seen:new WeakSet()
    }));
    const metadata=cloneImportedValue(fields.metadata,{
        path:`$.events[${String(index)}].metadata`,
        depth:0,
        seen:new WeakSet()
    });
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)){
        invalidStack(`${label} metadata`);
    }

    let completedAt=null;
    let durationMs=null;
    let error=null;
    if(fields.status==='dispatching'){
        if(fields.completedAt!==null||fields.durationMs!==null||fields.error!==null){
            invalidStack(`${label} dispatch timing`);
        }
    }else{
        const completedAtMs=canonicalTimestamp(fields.completedAt,`${label} completion timestamp`);
        if(completedAtMs<timestampMs
            ||typeof fields.durationMs!=='number'||!Number.isFinite(fields.durationMs)
            ||fields.durationMs<0){
            invalidStack(`${label} completion timing`);
        }
        completedAt=fields.completedAt;
        durationMs=fields.durationMs;
        if(fields.status==='completed'){
            if(fields.error!==null)invalidStack(`${label} error`);
        }else{
            error=cloneImportedValue(fields.error,{
                path:`$.events[${String(index)}].error`,
                depth:0,
                seen:new WeakSet()
            });
            if(!error||typeof error!=='object'||Array.isArray(error)){
                invalidStack(`${label} error`);
            }
        }
    }

    return dataObject([
        ['protocol',ARCANE_EVENT_STACK_PROTOCOL],
        ['sessionId',sessionId],
        ['id',fields.id],
        ['sequence',fields.sequence],
        ['timestamp',fields.timestamp],
        ['monotonicMs',fields.monotonicMs],
        ['type',fields.type],
        ['source',fields.source],
        ['category',fields.category],
        ['correlationId',fields.correlationId],
        ['causationId',fields.causationId],
        ['parentSequence',fields.parentSequence],
        ['depth',fields.depth],
        ['stack',fields.stack],
        ['payload',payload],
        ['metadata',metadata],
        ['status',fields.status],
        ['completedAt',completedAt],
        ['durationMs',durationMs],
        ['error',error]
    ]);
}

export function parseEventStack(source){
    let document=source;
    if(typeof source==='string'){
        try{document=JSON.parse(source);}catch(error){
            throw new TypeError('The event stack is not valid JSON.',{cause:error});
        }
    }
    const fields=exactDataObject(document,DOCUMENT_KEYS,'The event stack document');
    if(fields.protocol!==ARCANE_EVENT_STACK_PROTOCOL
        ||typeof fields.sessionId!=='string'||!fields.sessionId){
        invalidStack('The event stack document');
    }
    canonicalTimestamp(fields.createdAt,'The event stack creation timestamp');
    const sourceEvents=denseArrayValues(fields.events,'The event stack events');
    let previous=0;
    const bySequence=new Map();
    const events=sourceEvents.map((record,index)=>{
        const validated=validateRecord(record,index,{sessionId:fields.sessionId});
        if(validated.sequence<=previous){
            throw new TypeError('Event stack sequences must be strictly increasing.');
        }
        if(validated.parentSequence!==null){
            const parent=bySequence.get(validated.parentSequence);
            if(!parent||validated.depth!==parent.depth+1||validated.causationId===null){
                invalidStack(`Event stack record ${String(index)} parent`);
            }
        }
        previous=validated.sequence;
        bySequence.set(validated.sequence,validated);
        return validated;
    });
    return dataObject([
        ['protocol',ARCANE_EVENT_STACK_PROTOCOL],
        ['sessionId',fields.sessionId],
        ['createdAt',fields.createdAt],
        ['events',events]
    ]);
}

export class EventManager{
    #activeDispatch=[];
    #bus=new EventPubSub();
    #clock;
    #cursor=0;
    #domInstrumentation=null;
    #history=[];
    #now;
    #replaying=false;
    #sequence=0;
    #sessionId;
    #timeTravelEnabled=false;

    constructor({
        timeTravel=false,
        dom=null,
        clock=()=>new Date(),
        now=defaultMonotonicClock,
        sessionId=sessionIdentifier()
    }={}){
        if(typeof timeTravel!=='boolean'){
            throw new TypeError('EventManager flags must be boolean values.');
        }
        if(typeof clock!=='function'||typeof now!=='function'){
            throw new TypeError('EventManager clocks must be functions.');
        }
        if(typeof sessionId!=='string'||!sessionId){
            throw new TypeError('EventManager sessionId must be a non-empty string.');
        }
        this.#clock=clock;
        this.#now=now;
        this.#sessionId=sessionId;
        this.#timeTravelEnabled=timeTravel;
        if(dom)this.attachDOM(dom?.root??dom,dom?.root?dom:{});
    }

    get list(){return this.#bus.list;}
    get sessionId(){return this.#sessionId;}
    get timeTravelEnabled(){return this.#timeTravelEnabled;}
    get replaying(){return this.#replaying;}
    get cursor(){return this.#cursor;}
    get eventCount(){return this.#history.length;}
    get history(){return [...this.#history];}
    get domInstrumentation(){return this.#domInstrumentation;}

    [EVENT_MANAGER_BUS_ON](type,handler,once=false){
        this.#bus.on(type,handler,once);
        return this;
    }

    [EVENT_MANAGER_BUS_OFF](type,handler='*'){
        this.#bus.off(type,handler);
        return this;
    }

    [EVENT_MANAGER_DISPATCH](type,payload,metadata={}){
        return this.#dispatch(type,[payload],metadata);
    }

    on(type,handler,once=false){
        this.#bus.on(type,handler,once);
        return this;
    }

    once(type,handler){
        this.#bus.once(type,handler);
        return this;
    }

    off(type='*',handler='*'){
        this.#bus.off(type,handler);
        return this;
    }

    reset(){
        this.#bus.reset();
        return this;
    }

    emit(type,...payload){
        return this.#dispatch(type,payload,{});
    }

    instrument(type,payload,metadata={}){
        return this.#dispatch(type,[payload],normalizeMetadata(metadata));
    }

    forward(event,metadata={}){
        if(!event||typeof event!=='object'||Array.isArray(event)||typeof event.type!=='string'){
            throw new TypeError('Forwarded events must be objects with a string type.');
        }
        return this.instrument(event.type,event,metadata);
    }

    #dispatch(type,payload,metadata){
        if(typeof type!=='string'){
            this.#bus.emit(type,...payload);
            return this;
        }
        let recording=this.#timeTravelEnabled&&!this.#replaying;
        let draft=null;
        let startedMonotonic=null;
        if(recording){
            try{
                const timestamp=clockDate(this.#clock).toISOString();
                startedMonotonic=monotonicValue(this.#now);
                const payloadSnapshot=completeSnapshot(payload);
                const metadataSnapshot=completeSnapshot(metadata);
                const safeMetadata=metadataSnapshot&&typeof metadataSnapshot==='object'
                    &&!Array.isArray(metadataSnapshot)
                    ?metadataSnapshot
                    :snapshotObject();
                const sequence=this.#sequence+1;
                const parentSequence=this.#activeDispatch.at(-1)??null;
                let stack=null;
                try{
                    stack=safeString(sourceStack()??'');
                }catch{
                    stack='[STACK CAPTURE FAILED]';
                }
                draft={
                    protocol:ARCANE_EVENT_STACK_PROTOCOL,
                    sessionId:this.#sessionId,
                    id:`${this.#sessionId}:${sequence}`,
                    sequence,
                    timestamp,
                    monotonicMs:startedMonotonic,
                    type:safeString(type),
                    source:typeof safeMetadata.source==='string'&&safeMetadata.source
                        ?safeString(safeMetadata.source)
                        :'application',
                    category:typeof safeMetadata.category==='string'&&safeMetadata.category
                        ?safeString(safeMetadata.category)
                        :null,
                    correlationId:typeof safeMetadata.correlationId==='string'
                        &&safeMetadata.correlationId
                        ?safeString(safeMetadata.correlationId):null,
                    causationId:typeof safeMetadata.causationId==='string'
                        &&safeMetadata.causationId
                        ?safeString(safeMetadata.causationId)
                        :(parentSequence===null?null:`${this.#sessionId}:${parentSequence}`),
                    parentSequence,
                    depth:this.#activeDispatch.length,
                    stack,
                    payload:Array.isArray(payloadSnapshot)
                        ?payloadSnapshot
                        :[payloadSnapshot],
                    metadata:safeMetadata,
                    status:'dispatching',
                    completedAt:null,
                    durationMs:null,
                    error:null
                };
                this.#history.push({...draft});
                this.#sequence=sequence;
                this.#cursor=sequence;
                this.#activeDispatch.push(sequence);
            }catch{
                draft=null;
                startedMonotonic=null;
            }
        }

        let listenerFailed=false;
        let listenerError;
        try{
            this.#bus.emit(type,...payload);
        }catch(error){
            listenerFailed=true;
            listenerError=error;
        }finally{
            if(draft){
                this.#finalize(
                    draft,
                    startedMonotonic,
                    listenerFailed?'failed':'completed',
                    listenerFailed?listenerError:null
                );
                this.#activeDispatch.pop();
            }
        }
        if(listenerFailed)throw listenerError;
        return this;
    }

    #finalize(draft,startedMonotonic,status,error){
        try{
            const index=this.#history.findIndex(record=>record.sequence===draft.sequence);
            if(index<0)return;
            let completedAt=draft.timestamp;
            let durationMs=0;
            try{
                const completion=clockDate(this.#clock);
                if(completion.getTime()>=Date.parse(draft.timestamp)){
                    completedAt=completion.toISOString();
                }
            }catch{}
            try{
                durationMs=Math.max(0,monotonicValue(this.#now)-startedMonotonic);
            }catch{}
            this.#history[index]={
                ...draft,
                status,
                completedAt,
                durationMs,
                error:error===null?null:completeErrorSnapshot(error)
            };
        }catch{}
    }

    enableTimeTravel({dom}={}){
        const wasEnabled=this.#timeTravelEnabled;
        this.#timeTravelEnabled=true;
        try{
            if(dom)this.attachDOM(dom?.root??dom,dom?.root?dom:{});
            else this.#domInstrumentation?.start();
        }catch(error){
            this.#timeTravelEnabled=wasEnabled;
            throw error;
        }
        return this;
    }

    disableTimeTravel(){
        try{return this.#domInstrumentation?.stop(),this;}
        finally{this.#timeTravelEnabled=false;}
    }

    attachDOM(root=globalThis.document,options={}){
        const previous=this.#domInstrumentation;
        const replacement=createDOMInstrumentation({
            ...options,
            root,
            eventManager:this
        });
        if(previous&&previous!==replacement){
            previous.stop();
            if(this.#domInstrumentation===previous)this.#domInstrumentation=null;
        }
        try{
            if(this.#timeTravelEnabled)replacement.start();
            if(!this.#timeTravelEnabled){
                replacement.stop({emitLifecycle:false});
            }
        }catch(error){
            try{replacement.stop({emitLifecycle:false});}catch{}
            if(replacement.active||replacement.cleanupPending){
                this.#domInstrumentation=replacement;
                try{
                    if(error&&(typeof error==='object'||typeof error==='function')){
                        Object.defineProperty(error,'domInstrumentation',{
                            value:replacement,
                            enumerable:false,
                            configurable:true
                        });
                    }
                }catch{}
            }
            throw error;
        }
        this.#domInstrumentation=replacement;
        return replacement;
    }

    detachDOM(){
        const current=this.#domInstrumentation;
        try{current?.stop();}
        finally{
            if(this.#domInstrumentation===current
                &&!current?.active&&!current?.cleanupPending){
                this.#domInstrumentation=null;
            }
        }
        return this;
    }

    clearHistory({newSession=true}={}){
        if(typeof newSession!=='boolean')throw new TypeError('newSession must be boolean.');
        if(this.#activeDispatch.length||this.#replaying){
            throw new Error('Event history cannot be cleared during dispatch or playback.');
        }
        this.#history=[];
        this.#sequence=0;
        this.#cursor=0;
        this.#activeDispatch=[];
        if(newSession)this.#sessionId=sessionIdentifier();
        return this;
    }

    getEventStack({fromSequence=1,toSequence=Number.MAX_SAFE_INTEGER,type=null}={}){
        if(!Number.isSafeInteger(fromSequence)||fromSequence<1
            ||!Number.isSafeInteger(toSequence)||toSequence<fromSequence
            ||(type!==null&&typeof type!=='string')){
            throw new TypeError('The event stack range is invalid.');
        }
        return this.#history.filter(record=>
            record.sequence>=fromSequence&&record.sequence<=toSequence
                &&(type===null||record.type===type)
        );
    }

    exportStack({space=2}={}){
        if(!Number.isSafeInteger(space)||space<0||space>10){
            throw new RangeError('Event stack JSON indentation must be from 0 through 10.');
        }
        return JSON.stringify({
            protocol:ARCANE_EVENT_STACK_PROTOCOL,
            sessionId:this.#sessionId,
            createdAt:clockDate(this.#clock).toISOString(),
            events:this.#history
        },null,space);
    }

    seek(sequence){
        if(!Number.isSafeInteger(sequence)||sequence<0||sequence>this.#sequence){
            throw new RangeError('The time-travel sequence is outside this event stack.');
        }
        this.#cursor=sequence;
        const record=sequence===0?null:this.#history.find(item=>item.sequence===sequence)??null;
        this.#bus.emit(TIME_TRAVEL_SEEK_EVENT,{sessionId:this.#sessionId,sequence,record});
        return record;
    }

    async playback({
        stack=null,
        fromSequence=1,
        toSequence=Number.MAX_SAFE_INTEGER,
        speed=0,
        mode='review',
        signal,
        onRecord
    }={}){
        if(!Number.isSafeInteger(fromSequence)||fromSequence<1
            ||!Number.isSafeInteger(toSequence)||toSequence<fromSequence){
            throw new TypeError('The playback range is invalid.');
        }
        if(typeof speed!=='number'||!Number.isFinite(speed)||speed<0){
            throw new RangeError('Playback speed must be zero or a positive finite number.');
        }
        if(!['review','events','none'].includes(mode)){
            throw new TypeError('Playback mode must be review, events, or none.');
        }
        if(onRecord!==undefined&&typeof onRecord!=='function'){
            throw new TypeError('onRecord must be a function.');
        }
        if(this.#replaying)throw new Error('Event playback is already active.');
        const document=stack===null
            ?{protocol:ARCANE_EVENT_STACK_PROTOCOL,sessionId:this.#sessionId,events:this.#history}
            :parseEventStack(stack);
        const records=document.events.filter(record=>
            record.sequence>=fromSequence&&record.sequence<=toSequence
        );
        this.#replaying=true;
        let delivered=0;
        let previousTimestamp=null;
        let previousMonotonic=null;
        try{
            if(signal?.aborted)throw abortError(signal.reason);
            this.#bus.emit(PLAYBACK_STARTED_EVENT,{
                sessionId:document.sessionId,
                count:records.length,
                fromSequence,
                toSequence,
                speed,
                mode
            });
            for(const record of records){
                if(signal?.aborted)throw abortError(signal.reason);
                if(speed>0&&(previousTimestamp!==null||previousMonotonic!==null)){
                    const monotonic=Number(record.monotonicMs);
                    const difference=Number.isFinite(monotonic)&&previousMonotonic!==null
                        ?Math.max(0,monotonic-previousMonotonic)
                        :Math.max(0,Date.parse(record.timestamp)-previousTimestamp);
                    await wait(difference/speed,signal);
                }
                previousTimestamp=Date.parse(record.timestamp);
                previousMonotonic=Number.isFinite(Number(record.monotonicMs))
                    ?Number(record.monotonicMs)
                    :null;
                if(mode==='review')this.#bus.emit(PLAYBACK_RECORD_EVENT,record);
                else if(mode==='events')this.#bus.emit(record.type,...record.payload);
                await onRecord?.(record);
                this.#cursor=record.sequence;
                delivered+=1;
            }
            const result={
                sessionId:document.sessionId,
                delivered,
                cursor:this.#cursor,
                completed:true
            };
            this.#bus.emit(PLAYBACK_COMPLETED_EVENT,result);
            return result;
        }catch(error){
            const cancelled=signal?.aborted||error?.name==='AbortError';
            this.#bus.emit(cancelled?PLAYBACK_CANCELLED_EVENT:PLAYBACK_FAILED_EVENT,{
                sessionId:document.sessionId,
                delivered,
                cursor:this.#cursor,
                completed:false,
                error:completeSnapshot(error)
            });
            throw error;
        }finally{
            this.#replaying=false;
        }
    }
}

export function createEventManager(options){
    return new EventManager(options);
}

function eventAuthorityError(code,cause,ErrorType=Error){
    const message=ARCANE_EVENT_ERRORS[code]??'The Arcane event authority failed.';
    const error=cause===undefined
        ?new ErrorType(message)
        :new ErrorType(message,{cause});
    error.code=code;
    return error;
}

function eventName(value,code='ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID'){
    if(typeof value!=='string'
        ||value.trim()!==value
        ||value.length<1
        ||!ARCANE_EVENT_NAME_PATTERN.test(value)){
        throw eventAuthorityError(code,undefined,TypeError);
    }
    return value;
}

function eventDataOptions(value,allowed,code){
    if(value===undefined)return Object.create(null);
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw eventAuthorityError(code,undefined,TypeError);
    }
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null){
        throw eventAuthorityError(code,undefined,TypeError);
    }
    const result=Object.create(null);
    for(const key of Reflect.ownKeys(value)){
        if(typeof key!=='string'||!allowed.has(key)){
            throw eventAuthorityError(code,undefined,TypeError);
        }
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(!descriptor||!('value' in descriptor)){
            throw eventAuthorityError(code,undefined,TypeError);
        }
        result[key]=descriptor.value;
    }
    return result;
}

function eventSignal(value){
    if(value===undefined||value===null)return null;
    if(!value
        ||typeof value!=='object'
        ||typeof value.aborted!=='boolean'
        ||typeof value.addEventListener!=='function'
        ||typeof value.removeEventListener!=='function'){
        throw eventAuthorityError(
            'ARCANE_EVENT_SUBSCRIPTION_SIGNAL_INVALID',
            undefined,
            TypeError
        );
    }
    return value;
}

function eventListener(value){
    if(typeof value==='function'){
        return {
            identity:value,
            invoke(event,thisArg,...rest){return value.call(thisArg,event,...rest);}
        };
    }
    if(value&&typeof value==='object'&&typeof value.handleEvent==='function'){
        return {
            identity:value,
            invoke(event){return value.handleEvent(event);}
        };
    }
    throw eventAuthorityError(
        'ARCANE_EVENT_SUBSCRIPTION_HANDLER_INVALID',
        undefined,
        TypeError
    );
}

function eventTargetListener(value){
    if(typeof value==='function'){
        return {
            identity:value,
            invoke(event,thisArg,...rest){return value.call(thisArg,event,...rest);}
        };
    }
    if(value&&typeof value==='object'&&typeof value.handleEvent==='function'){
        return {
            identity:value,
            invoke(event){return value.handleEvent(event);}
        };
    }
    return null;
}

function compatibilityDetail(value){
    if(value===null||(typeof value!=='object'&&typeof value!=='function'))return value;
    if(Array.isArray(value))return value.slice();
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)return value;
    const copy=prototype===null?Object.create(null):{};
    for(const key of Reflect.ownKeys(value)){
        const descriptor=Object.getOwnPropertyDescriptor(value,key);
        if(!descriptor)continue;
        let item;
        try{item=Reflect.get(value,key);}
        catch(error){item=snapshotFailure(error,{path:`$.${String(key)}`});}
        Object.defineProperty(copy,key,{
            value:item,
            enumerable:descriptor.enumerable,
            configurable:true,
            writable:true
        });
    }
    return copy;
}

function eventTargetOptions(value){
    if(value===undefined)return {capture:false,once:false,signal:null};
    if(typeof value==='boolean'){
        return {capture:value,once:false,signal:null};
    }
    const options=eventDataOptions(
        value,
        new Set(['capture','once','passive','signal']),
        'ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID'
    );
    for(const key of ['capture','once','passive']){
        if(options[key]!==undefined&&typeof options[key]!=='boolean'){
            throw eventAuthorityError(
                'ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID',
                undefined,
                TypeError
            );
        }
    }
    return {
        capture:options.capture===true,
        once:options.once===true,
        signal:eventSignal(options.signal)
    };
}

function subscriptionOptions(value){
    const options=eventDataOptions(
        value,
        new Set(['once','signal']),
        'ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID'
    );
    if(options.once!==undefined&&typeof options.once!=='boolean'){
        throw eventAuthorityError(
            'ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID',
            undefined,
            TypeError
        );
    }
    return {
        once:options.once===true,
        signal:eventSignal(options.signal)
    };
}

function defineDisposable(unsubscribe){
    Object.defineProperty(unsubscribe,'dispose',{
        value:unsubscribe,
        enumerable:false,
        configurable:true,
        writable:true
    });
    return unsubscribe;
}

function eventLikeRecord(value){
    try{
        if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError();
        const EventConstructor=globalThis.Event;
        if(typeof EventConstructor==='function'&&value instanceof EventConstructor){
            if(!('detail' in value))throw new TypeError();
            return {
                type:eventName(value.type,'ARCANE_EVENT_DISPATCH_EVENT_INVALID'),
                detail:value.detail,
                cancelable:value.cancelable===true,
                defaultPrevented:value.defaultPrevented===true,
                preventDefault:typeof value.preventDefault==='function'
                    ?()=>value.preventDefault()
                    :null
            };
        }
        const typeDescriptor=Object.getOwnPropertyDescriptor(value,'type');
        const detailDescriptor=Object.getOwnPropertyDescriptor(value,'detail');
        const cancelableDescriptor=Object.getOwnPropertyDescriptor(value,'cancelable');
        const preventedDescriptor=Object.getOwnPropertyDescriptor(value,'defaultPrevented');
        if(!typeDescriptor||!('value' in typeDescriptor)
            ||!detailDescriptor||!('value' in detailDescriptor)
            ||(cancelableDescriptor&&!('value' in cancelableDescriptor))
            ||(preventedDescriptor&&!('value' in preventedDescriptor))){
            throw new TypeError();
        }
        return {
            type:eventName(typeDescriptor.value,'ARCANE_EVENT_DISPATCH_EVENT_INVALID'),
            detail:detailDescriptor?.value,
            cancelable:cancelableDescriptor?.value===true,
            defaultPrevented:preventedDescriptor?.value===true,
            preventDefault:typeof value.preventDefault==='function'
                ?()=>value.preventDefault()
                :null
        };
    }catch(error){
        if(error?.code==='ARCANE_EVENT_DISPATCH_EVENT_INVALID')throw error;
        throw eventAuthorityError(
            'ARCANE_EVENT_DISPATCH_EVENT_INVALID',
            error,
            TypeError
        );
    }
}

function createArcaneEventAuthority(){
    const manager=new EventManager();
    const sourceByOwner=new WeakMap();
    const occurrences=new WeakSet();
    const canonicalByView=new WeakMap();
    const compatibilityByOccurrence=new WeakMap();
    const sourceRecordByOccurrence=new WeakMap();
    const authorityTargetListeners=[];
    const directListeners=[];
    let occurrenceSequence=0;
    let sourceSequence=0;
    let reportingListenerError=false;
    let canonicalDispatchDepth=0;
    const pendingChannelRemovals=[];

    const descriptor={
        kind:ARCANE_EVENT_AUTHORITY_KIND,
        protocol:ARCANE_EVENT_AUTHORITY_PROTOCOL,
        realm:'current'
    };

    function nextOccurrenceId(){
        if(occurrenceSequence===Number.MAX_SAFE_INTEGER){
            throw eventAuthorityError('ARCANE_EVENT_OCCURRENCE_SEQUENCE_EXHAUSTED');
        }
        occurrenceSequence+=1;
        return `arcane-event-${occurrenceSequence.toString(36)}`;
    }

    function nextSourceId(){
        if(sourceSequence===Number.MAX_SAFE_INTEGER){
            throw eventAuthorityError('ARCANE_EVENT_SOURCE_SEQUENCE_EXHAUSTED');
        }
        sourceSequence+=1;
        return `arcane-source-${sourceSequence.toString(36)}`;
    }

    function directListenerFailure(error){
        try{
            if(typeof globalThis.reportError==='function'){
                globalThis.reportError(error);
                return;
            }
        }catch{}
        try{globalThis.console?.error?.('Arcane event listener failed.',error);}
        catch{}
    }

    function publicEventDetail(value){
        return completeSnapshot(value??{});
    }

    function completeEventDetail(compatibility,publicDetail){
        if(publicDetail===undefined)return compatibility??{};
        const compatibilityRecord=compatibility&&typeof compatibility==='object'
            &&!Array.isArray(compatibility);
        const publicRecord=publicDetail&&typeof publicDetail==='object'
            &&!Array.isArray(publicDetail);
        if(compatibilityRecord&&publicRecord)return {...compatibility,...publicDetail};
        return {compatibility,publicDetail};
    }

    function canonicalOccurrence({
        type,
        source,
        instanceId,
        operationId,
        detail,
        cancelable,
        defaultPrevented=false
    }){
        let prevented=cancelable&&defaultPrevented;
        const occurrence={};
        Object.defineProperties(occurrence,{
            protocol:{value:ARCANE_EVENT_OCCURRENCE_PROTOCOL,enumerable:true,writable:true,configurable:true},
            occurrenceId:{value:nextOccurrenceId(),enumerable:true,writable:true,configurable:true},
            type:{value:type,enumerable:true,writable:true,configurable:true},
            source:{value:source,enumerable:true,writable:true,configurable:true},
            instanceId:{value:instanceId,enumerable:true,writable:true,configurable:true},
            operationId:{value:operationId,enumerable:true,writable:true,configurable:true},
            detail:{value:detail,enumerable:true,writable:true,configurable:true},
            cancelable:{value:cancelable,enumerable:true,writable:true,configurable:true},
            defaultPrevented:{get(){return prevented;},enumerable:true,configurable:true},
            preventDefault:{
                value:function preventArcaneEventDefault(){
                    if(cancelable)prevented=true;
                },
                enumerable:true,
                writable:true,
                configurable:true
            }
        });
        occurrences.add(occurrence);
        return occurrence;
    }

    function compatibilityView(occurrence,detail,target=null){
        const view={};
        Object.defineProperties(view,{
            protocol:{value:occurrence.protocol,enumerable:true,writable:true,configurable:true},
            occurrenceId:{value:occurrence.occurrenceId,enumerable:true,writable:true,configurable:true},
            type:{value:occurrence.type,enumerable:true,writable:true,configurable:true},
            source:{value:occurrence.source,enumerable:true,writable:true,configurable:true},
            instanceId:{value:occurrence.instanceId,enumerable:true,writable:true,configurable:true},
            operationId:{value:occurrence.operationId,enumerable:true,writable:true,configurable:true},
            detail:{value:detail,enumerable:true,writable:true,configurable:true},
            target:{value:target,enumerable:true,writable:true,configurable:true},
            currentTarget:{value:target,enumerable:true,writable:true,configurable:true},
            cancelable:{value:occurrence.cancelable,enumerable:true,writable:true,configurable:true},
            defaultPrevented:{get(){return occurrence.defaultPrevented;},enumerable:true,configurable:true},
            preventDefault:{value:()=>occurrence.preventDefault(),enumerable:true,writable:true,configurable:true}
        });
        canonicalByView.set(view,occurrence);
        return view;
    }

    function removeChannelListener(channel,handler){
        if(canonicalDispatchDepth>0){
            pendingChannelRemovals.push({channel,handler});
            return;
        }
        manager[EVENT_MANAGER_BUS_OFF](channel,handler);
    }

    function flushChannelRemovals(){
        if(canonicalDispatchDepth>0)return;
        for(const {channel,handler} of pendingChannelRemovals.splice(0)){
            manager[EVENT_MANAGER_BUS_OFF](channel,handler);
        }
    }

    function dispatchChannel(channel,value,metadata){
        canonicalDispatchDepth+=1;
        try{return manager[EVENT_MANAGER_DISPATCH](channel,value,metadata);}
        finally{
            canonicalDispatchDepth-=1;
            flushChannelRemovals();
        }
    }

    function subscribeChannel(channel,handler,options,{
        thisArg=undefined,
        sourceRecord=null,
        select=value=>value,
        onRemove=null
    }={}){
        const admitted=eventListener(handler);
        const normalized=subscriptionOptions(options);
        let active=false;
        let abortHandler=null;
        function unsubscribeArcaneEvent(){
            if(!active)return false;
            active=false;
            removeChannelListener(channel,deliverArcaneEvent);
            if(abortHandler){
                normalized.signal?.removeEventListener('abort',abortHandler);
                abortHandler=null;
            }
            onRemove?.(unsubscribeArcaneEvent);
            return true;
        }
        defineDisposable(unsubscribeArcaneEvent);
        if(normalized.signal?.aborted)return unsubscribeArcaneEvent;
        function deliverArcaneEvent(value){
            if(!active)return;
            if(normalized.once)unsubscribeArcaneEvent();
            const delivered=select(value);
            try{admitted.invoke(delivered,thisArg);}
            catch(error){reportListenerFailure(error,delivered,sourceRecord);}
        }
        manager[EVENT_MANAGER_BUS_ON](channel,deliverArcaneEvent);
        active=true;
        if(normalized.signal){
            abortHandler=unsubscribeArcaneEvent;
            normalized.signal.addEventListener('abort',abortHandler,{once:true});
        }
        return unsubscribeArcaneEvent;
    }

    function reportListenerFailure(error,event,sourceRecord){
        const occurrence=occurrences.has(event)
            ?event
            :canonicalByView.get(event)??null;
        const ownerRecord=sourceRecord??(occurrence
            ?sourceRecordByOccurrence.get(occurrence)??null
            :null);
        if(reportingListenerError){
            directListenerFailure(error);
            return;
        }
        reportingListenerError=true;
        let errorOccurrence=null;
        try{
            const detail={
                code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',
                reason:'listener-threw',
                eventType:occurrence?.type??null,
                occurrenceId:occurrence?.occurrenceId??null,
                source:occurrence?.source??ownerRecord?.source??'event-authority',
                instanceId:occurrence?.instanceId??ownerRecord?.instanceId??null,
                operationId:occurrence?.operationId??null,
                error
            };
            errorOccurrence=dispatchOccurrence({
                type:ARCANE_EVENT_LISTENER_ERROR_EVENT,
                sourceRecord:null,
                source:'event-authority',
                instanceId:'arcane-source-authority',
                compatibility:detail,
                publicDetail:detail,
                operationId:occurrence?.operationId??null,
                cancelable:false
            }).occurrence;
        }catch(reportingError){
            directListenerFailure(reportingError);
        }
        directListenerFailure(error);
        try{ownerRecord?.onListenerError?.(error,errorOccurrence);}
        catch(callbackError){directListenerFailure(callbackError);}
        reportingListenerError=false;
    }

    function globalChannel(type){return `${ARCANE_EVENT_CHANNEL_PREFIX}global:${type}`;}
    function sourceChannel(instanceId,type){
        return `${ARCANE_EVENT_CHANNEL_PREFIX}source:${instanceId}:${type}`;
    }

    function dispatchOccurrence({
        type,
        sourceRecord,
        source,
        instanceId,
        compatibility,
        publicDetail,
        operationId=null,
        cancelable=false,
        defaultPrevented=false
    }){
        const admittedType=eventName(type,'ARCANE_EVENT_OCCURRENCE_INVALID');
        const admittedCompatibility=compatibilityDetail(compatibility);
        const occurrence=canonicalOccurrence({
            type:admittedType,
            source,
            instanceId,
            operationId,
            detail:publicEventDetail(completeEventDetail(compatibility,publicDetail)),
            cancelable,
            defaultPrevented
        });
        const view=compatibilityView(
            occurrence,
            admittedCompatibility,
            sourceRecord?.owner??null
        );
        compatibilityByOccurrence.set(occurrence,admittedCompatibility);
        if(sourceRecord)sourceRecordByOccurrence.set(occurrence,sourceRecord);
        dispatchChannel(globalChannel(admittedType),occurrence,{
            source:'event-authority',
            category:'semantic'
        });
        if(sourceRecord){
            dispatchChannel(
                sourceChannel(instanceId,admittedType),
                view,
                {source,category:'semantic',correlationId:operationId}
            );
        }
        return {occurrence,accepted:!occurrence.defaultPrevented};
    }

    function subscribe(type,handler,options){
        const admittedType=eventName(type);
        return subscribeChannel(globalChannel(admittedType),handler,options,{
            thisArg:manager
        });
    }

    function addEventTargetListener(registrations,type,handler,options,subscribeWith,thisArg){
        const admittedType=eventName(type);
        const admitted=eventTargetListener(handler);
        if(!admitted)return;
        const normalized=eventTargetOptions(options);
        if(normalized.signal?.aborted)return;
        if(registrations.some(record=>record.type===admittedType
            &&record.identity===admitted.identity
            &&record.capture===normalized.capture))return;
        const record={
            type:admittedType,
            identity:admitted.identity,
            capture:normalized.capture,
            unsubscribe:null
        };
        const unsubscribe=subscribeWith(
            admittedType,
            function deliverEventTargetOccurrence(event){
                if(normalized.once){
                    const index=registrations.indexOf(record);
                    if(index>=0)registrations.splice(index,1);
                    record.unsubscribe?.();
                }
                return admitted.invoke(event,thisArg);
            },
            {once:false,signal:normalized.signal}
        );
        record.unsubscribe=unsubscribe;
        registrations.push(record);
        if(normalized.signal){
            normalized.signal.addEventListener('abort',function removeAbortedEventTargetRecord(){
                const index=registrations.indexOf(record);
                if(index>=0)registrations.splice(index,1);
            },{once:true});
        }
    }

    function removeEventTargetListener(registrations,type,handler,options){
        const admittedType=eventName(type);
        const admitted=eventTargetListener(handler);
        if(!admitted)return;
        const normalized=eventTargetOptions(options);
        const index=registrations.findIndex(record=>record.type===admittedType
            &&record.identity===admitted.identity
            &&record.capture===normalized.capture);
        if(index<0)return;
        const [record]=registrations.splice(index,1);
        record.unsubscribe();
    }

    function dispatchEventLike(value,sourceRecord){
        const admitted=eventLikeRecord(value);
        if(!sourceRecord.eventTypes.has(admitted.type)){
            throw eventAuthorityError('ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED');
        }
        const detail=compatibilityDetail(admitted.detail);
        const operationId=detail&&typeof detail==='object'
            &&typeof detail.operationId==='string'
            &&detail.operationId.trim()===detail.operationId
            &&detail.operationId
            ?detail.operationId
            :null;
        const publication=dispatchOccurrence({
            type:admitted.type,
            sourceRecord,
            source:sourceRecord.source,
            instanceId:sourceRecord.instanceId,
            compatibility:detail,
            publicDetail:detail,
            operationId,
            cancelable:admitted.cancelable,
            defaultPrevented:admitted.defaultPrevented
        });
        if(publication.occurrence.defaultPrevented)admitted.preventDefault?.();
        return !publication.occurrence.defaultPrevented;
    }

    function createSource(owner,options){
        if(!owner||(typeof owner!=='object'&&typeof owner!=='function')){
            throw eventAuthorityError('ARCANE_EVENT_SOURCE_INVALID',undefined,TypeError);
        }
        const admitted=eventDataOptions(
            options,
            new Set(['source','eventTypes','onListenerError']),
            'ARCANE_EVENT_SOURCE_INVALID'
        );
        const source=eventName(admitted.source,'ARCANE_EVENT_SOURCE_INVALID');
        if(!Array.isArray(admitted.eventTypes)
            ||admitted.eventTypes.length<1){
            throw eventAuthorityError('ARCANE_EVENT_SOURCE_INVALID',undefined,TypeError);
        }
        const eventTypes=[];
        const seen=new Set();
        for(const type of admitted.eventTypes){
            const normalized=eventName(type,'ARCANE_EVENT_SOURCE_INVALID');
            if(seen.has(normalized)){
                throw eventAuthorityError('ARCANE_EVENT_SOURCE_INVALID',undefined,TypeError);
            }
            seen.add(normalized);
            eventTypes.push(normalized);
        }
        if(admitted.onListenerError!==undefined
            &&typeof admitted.onListenerError!=='function'){
            throw eventAuthorityError('ARCANE_EVENT_SOURCE_INVALID',undefined,TypeError);
        }
        const existing=sourceByOwner.get(owner);
        if(existing&&!existing.disposed){
            throw eventAuthorityError('ARCANE_EVENT_SOURCE_ALREADY_REGISTERED');
        }
        const record={
            owner,
            source,
            instanceId:nextSourceId(),
            eventTypes:new Set(eventTypes),
            onListenerError:admitted.onListenerError??null,
            subscriptions:new Set(),
            targetListeners:[],
            disposing:false,
            disposed:false,
            handle:null
        };
        function assertOpen(){
            if(record.disposing||record.disposed){
                throw eventAuthorityError('ARCANE_EVENT_SOURCE_DISPOSED');
            }
        }
        function sourceSubscribe(type,handler,subscribeOptions){
            assertOpen();
            const admittedType=eventName(type);
            if(!record.eventTypes.has(admittedType)
                &&admittedType!==ARCANE_EVENT_SOURCE_DISPOSED_EVENT){
                throw eventAuthorityError('ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED');
            }
            let unsubscribe;
            unsubscribe=subscribeChannel(
                sourceChannel(record.instanceId,admittedType),
                handler,
                subscribeOptions,
                {
                    thisArg:record.owner,
                    sourceRecord:record,
                    onRemove(){record.subscriptions.delete(unsubscribe);}
                }
            );
            record.subscriptions.add(unsubscribe);
            return unsubscribe;
        }
        function dispatch(type,detail,dispatchOptions){
            assertOpen();
            const admittedType=eventName(type,'ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED');
            if(!record.eventTypes.has(admittedType)){
                throw eventAuthorityError('ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED');
            }
            const normalized=eventDataOptions(
                dispatchOptions,
                new Set(['operationId','publicDetail','cancelable']),
                'ARCANE_EVENT_OCCURRENCE_INVALID'
            );
            const operationId=normalized.operationId??null;
            if(operationId!==null&&(typeof operationId!=='string'
                ||operationId.trim()!==operationId
                ||operationId.length<1)){
                throw eventAuthorityError('ARCANE_EVENT_OCCURRENCE_INVALID',undefined,TypeError);
            }
            if(normalized.cancelable!==undefined&&typeof normalized.cancelable!=='boolean'){
                throw eventAuthorityError('ARCANE_EVENT_OCCURRENCE_INVALID',undefined,TypeError);
            }
            return dispatchOccurrence({
                type:admittedType,
                sourceRecord:record,
                source:record.source,
                instanceId:record.instanceId,
                compatibility:detail,
                publicDetail:normalized.publicDetail,
                operationId,
                cancelable:normalized.cancelable===true
            });
        }
        function dispose(){
            if(record.disposed||record.disposing)return false;
            record.disposing=true;
            try{
                dispatchOccurrence({
                    type:ARCANE_EVENT_SOURCE_DISPOSED_EVENT,
                    sourceRecord:record,
                    source:record.source,
                    instanceId:record.instanceId,
                    compatibility:{
                        source:record.source,
                        instanceId:record.instanceId,
                        reason:'source-disposed'
                    },
                    publicDetail:{reason:'source-disposed'},
                    operationId:null,
                    cancelable:false
                });
                return true;
            }finally{
                record.disposed=true;
                for(const unsubscribe of [...record.subscriptions])unsubscribe();
                record.targetListeners.length=0;
                sourceByOwner.delete(owner);
                record.disposing=false;
            }
        }
        const sourceDescriptor={
            kind:ARCANE_EVENT_SOURCE_KIND,
            protocol:ARCANE_EVENT_SOURCE_PROTOCOL,
            source,
            instanceId:record.instanceId,
            eventTypes:[...eventTypes,ARCANE_EVENT_SOURCE_DISPOSED_EVENT]
        };
        const handle={
            protocol:ARCANE_EVENT_SOURCE_PROTOCOL,
            descriptor:sourceDescriptor,
            source,
            instanceId:record.instanceId,
            eventTypes:sourceDescriptor.eventTypes,
            subscribe:sourceSubscribe,
            on:sourceSubscribe,
            once(type,handler,options={}){
                const normalized=subscriptionOptions(options);
                return sourceSubscribe(type,handler,{
                    once:true,
                    signal:normalized.signal
                });
            },
            addEventListener(type,handler,options){
                assertOpen();
                addEventTargetListener(
                    record.targetListeners,
                    type,
                    handler,
                    options,
                    sourceSubscribe,
                    record.owner
                );
            },
            removeEventListener(type,handler,options){
                removeEventTargetListener(record.targetListeners,type,handler,options);
            },
            dispatch,
            dispatchEvent(value){assertOpen();return dispatchEventLike(value,record);},
            dispose,
            destroy:dispose
        };
        Object.defineProperty(handle,'disposed',{
            get(){return record.disposing||record.disposed;},
            enumerable:true
        });
        record.handle=handle;
        sourceByOwner.set(owner,record);
        return record.handle;
    }

    function projectDOMEvent(target,occurrence,options){
        if(!occurrences.has(occurrence)){
            throw eventAuthorityError('ARCANE_EVENT_OCCURRENCE_INVALID',undefined,TypeError);
        }
        if(occurrence.defaultPrevented)return false;
        const admitted=eventDataOptions(
            options,
            new Set(['type','bubbles','composed','cancelable']),
            'ARCANE_EVENT_DOM_OPTIONS_INVALID'
        );
        const type=admitted.type===undefined
            ?occurrence.type
            :eventName(admitted.type,'ARCANE_EVENT_DOM_OPTIONS_INVALID');
        for(const key of ['bubbles','composed','cancelable']){
            if(admitted[key]!==undefined&&typeof admitted[key]!=='boolean'){
                throw eventAuthorityError('ARCANE_EVENT_DOM_OPTIONS_INVALID',undefined,TypeError);
            }
        }
        if(!target||typeof target.dispatchEvent!=='function'
            ||typeof globalThis.CustomEvent!=='function'){
            throw eventAuthorityError('ARCANE_EVENT_DOM_TARGET_INVALID',undefined,TypeError);
        }
        const compatibility=compatibilityByOccurrence.get(occurrence);
        let detail;
        const compatibilityPrototype=compatibility&&typeof compatibility==='object'
            ?Object.getPrototypeOf(compatibility)
            :undefined;
        if(compatibility&&typeof compatibility==='object'
            &&!Array.isArray(compatibility)
            &&(compatibilityPrototype===Object.prototype||compatibilityPrototype===null)){
            detail={};
            for(const key of Reflect.ownKeys(compatibility)){
                const descriptor=Object.getOwnPropertyDescriptor(compatibility,key);
                if(!descriptor)continue;
                let item;
                try{item=Reflect.get(compatibility,key);}
                catch(error){item=snapshotFailure(error,{path:`$.${String(key)}`});}
                Object.defineProperty(detail,key,{
                    value:item,
                    enumerable:descriptor.enumerable,
                    configurable:true,
                    writable:true
                });
            }
        }else{
            detail={value:compatibility};
        }
        const metadata={
            occurrenceId:occurrence.occurrenceId,
            arcaneSource:occurrence.source,
            instanceId:occurrence.instanceId,
            operationId:occurrence.operationId
        };
        for(const key of ARCANE_EVENT_PROJECTION_KEYS){
            if(Object.hasOwn(detail,key)&&detail[key]!==metadata[key]){
                throw eventAuthorityError('ARCANE_EVENT_DOM_DETAIL_COLLISION');
            }
            detail[key]=metadata[key];
        }
        if(!Object.hasOwn(detail,'source')){
            detail.source=metadata.arcaneSource;
        }
        const cancelable=admitted.cancelable??occurrence.cancelable;
        const event=new CustomEvent(type,{
            detail,
            bubbles:admitted.bubbles===true,
            composed:admitted.composed===true,
            cancelable
        });
        const accepted=target.dispatchEvent(event)!==false&&!event.defaultPrevented;
        if(!accepted&&occurrence.cancelable)occurrence.preventDefault();
        return accepted&&!occurrence.defaultPrevented;
    }

    function safeDirectOn(type,handler,once=false){
        const admittedType=type==='*'?'*':eventName(type);
        const admitted=eventListener(handler);
        if(typeof once!=='boolean'){
            throw eventAuthorityError('ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID',undefined,TypeError);
        }
        const record={type:admittedType,identity:admitted.identity,wrapper:null};
        function safeDirectListener(value,...rest){
            if(once)removeDirectRecord(record);
            try{admitted.invoke(value,manager,...rest);}
            catch(error){reportListenerFailure(error,null,null);}
        }
        record.wrapper=safeDirectListener;
        directListeners.push(record);
        manager[EVENT_MANAGER_BUS_ON](admittedType,safeDirectListener);
        return manager;
    }

    function removeDirectRecord(record){
        const index=directListeners.indexOf(record);
        if(index<0)return false;
        directListeners.splice(index,1);
        manager[EVENT_MANAGER_BUS_OFF](record.type,record.wrapper);
        return true;
    }

    function safeDirectOff(type='*',handler='*'){
        const admittedType=type==='*'?'*':eventName(type);
        const selected=directListeners.filter(record=>(admittedType==='*'||record.type===admittedType)
            &&(handler==='*'||record.identity===handler));
        if(handler!=='*')eventListener(handler);
        for(const record of selected)removeDirectRecord(record);
        return manager;
    }

    function safeDirectReset(){
        for(const record of [...directListeners])removeDirectRecord(record);
        return manager;
    }

    Object.assign(manager,{
        [ARCANE_EVENT_AUTHORITY_BRAND]:ARCANE_EVENT_AUTHORITY_PROTOCOL,
        protocol:ARCANE_EVENT_AUTHORITY_PROTOCOL,
        descriptor,
        on:safeDirectOn,
        once:(type,handler)=>safeDirectOn(type,handler,true),
        off:safeDirectOff,
        reset:safeDirectReset,
        subscribe,
        createSource,
        projectDOMEvent,
        isOccurrence:value=>occurrences.has(value)||canonicalByView.has(value),
        addEventListener(type,handler,options){
            addEventTargetListener(
                authorityTargetListeners,
                type,
                handler,
                options,
                subscribe,
                manager
            );
        },
        removeEventListener(type,handler,options){
            removeEventTargetListener(authorityTargetListeners,type,handler,options);
        }
    });
    return manager;
}

function usableArcaneEventAuthority(value){
    return Boolean(value)
        &&(typeof value==='object'||typeof value==='function')
        &&value.protocol===ARCANE_EVENT_AUTHORITY_PROTOCOL
        &&ARCANE_EVENT_REQUIRED_AUTHORITY_API.every(name=>typeof value[name]==='function');
}

function installArcaneEventAuthority(){
    let existing=null;
    try{existing=globalThis.arcaneEvents??null;}catch{}
    if(usableArcaneEventAuthority(existing))return existing;
    const authority=createArcaneEventAuthority();
    try{
        Object.defineProperty(globalThis,'arcaneEvents',{
            value:authority,
            enumerable:false,
            configurable:true,
            writable:true
        });
    }catch(error){
        throw eventAuthorityError('ARCANE_EVENT_AUTHORITY_INSTALL_FAILED',error);
    }
    return authority;
}

export const arcaneEvents=installArcaneEventAuthority();

export function createArcaneEventSource(owner,options){
    return arcaneEvents.createSource(owner,options);
}

export function projectArcaneDOMEvent(target,occurrence,options){
    return arcaneEvents.projectDOMEvent(target,occurrence,options);
}

export function isArcaneEventOccurrence(value){
    return arcaneEvents.isOccurrence(value);
}
