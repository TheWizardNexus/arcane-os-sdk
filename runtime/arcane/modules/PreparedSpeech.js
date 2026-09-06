import Is from 'strong-type';
import {arcaneLogging} from 'arcane-os/logging';

const is=new Is(false);
const owners=new WeakMap();
const storageQueues=new WeakMap();

function deferred(){
    let resolve;
    let reject;
    const promise=new Promise(function captureSettlement(accept,decline){
        resolve=accept;
        reject=decline;
    });
    // The preparation owns failures even before a caller requests a segment.
    promise.catch(function observeDeferredFailure(){});
    return {promise,resolve,reject};
}

function abortError(){
    const error=new Error('Speech preparation was cancelled.');
    error.name='AbortError';
    error.code='ARCANE_AI_REQUEST_ABORTED';
    return error;
}

function copyJSON(value,ancestors=new Set()){
    if(value===null||is.string(value)||is.boolean(value))return value;
    if(is.finite(value))return value;
    if(!value||!is.object(value)||ancestors.has(value)){
        throw new TypeError('Speech preparation metadata must contain JSON-compatible values.');
    }
    const prototype=Object.getPrototypeOf(value);
    if(!is.array(value)&&prototype!==Object.prototype&&prototype!==null){
        throw new TypeError('Speech preparation metadata must contain JSON-compatible values.');
    }
    ancestors.add(value);
    const result=is.array(value)?[]:{};
    const keys=is.array(value)
        ?Array.from({length:value.length},function arrayIndex(unused,index){return String(index);})
        :Object.keys(value);
    for(const key of keys){
        Object.defineProperty(result,key,{
            value:copyJSON(value[key],ancestors),
            enumerable:true,
            configurable:true,
            writable:true
        });
    }
    ancestors.delete(value);
    return result;
}

function sameJSON(first,second){
    if(Object.is(first,second))return true;
    if(!first||!second||!is.object(first)||!is.object(second))return false;
    if(is.array(first)!==is.array(second))return false;
    const keys=Object.keys(first);
    if(keys.length!==Object.keys(second).length)return false;
    for(const key of keys){
        if(!Object.hasOwn(second,key)||!sameJSON(first[key],second[key]))return false;
    }
    return true;
}

function sameInput(first,second){
    return sameJSON(first.parts,second.parts)
        &&sameJSON(first.originalParts,second.originalParts)
        &&sameJSON(first.selection,second.selection)
        &&sameJSON(first.segmentation,second.segmentation)
        &&sameJSON(first.identity,second.identity);
}

function normalizeStorage(storage){
    if(storage===null||storage===undefined)return null;
    const {db,table,key}=storage;
    if(!db||!is.string(table)||!table||!is.string(key)||!key){
        throw new TypeError('Speech storage requires an existing database, table, and key.');
    }
    for(const method of ['get','set','readFile','writeFile']){
        if(!is.function(db[method])){
            throw new TypeError(`Speech storage requires db.${method}().`);
        }
    }
    return {db,table,key,fileName:`${encodeURIComponent(key)}.json`};
}

function sameStorage(first,second){
    return first===second||Boolean(first&&second
        &&first.db===second.db&&first.table===second.table&&first.key===second.key);
}

function serializeStorage(storage,execute){
    let tables=storageQueues.get(storage.db);
    if(!tables){
        tables=new Map();
        storageQueues.set(storage.db,tables);
    }
    let keys=tables.get(storage.table);
    if(!keys){
        keys=new Map();
        tables.set(storage.table,keys);
    }
    const previous=keys.get(storage.key)||Promise.resolve();
    const operation=previous.then(execute,execute);
    keys.set(storage.key,operation);
    function releaseStorageQueue(){
        if(keys.get(storage.key)===operation)keys.delete(storage.key);
    }
    operation.then(releaseStorageQueue,releaseStorageQueue);
    return operation;
}

async function readManifest(storage){
    const stored=await storage.db.get(storage.table,storage.fileName,true);
    if(stored===null||stored===undefined)return {version:1,entries:[]};
    const manifest=copyJSON(stored);
    if(manifest.version!==1||!is.array(manifest.entries)){
        throw new TypeError('Stored speech preparation metadata is unreadable.');
    }
    return manifest;
}

function createRecord(input){
    return {
        id:globalThis.crypto.randomUUID(),
        ...copyJSON(input),
        segments:input.parts.map(function emptyAudioRecord(){
            return {audioFile:null,contentType:null};
        })
    };
}

function publish(interest,error=null){
    const job=interest.job;
    let completed=0;
    for(const segment of job.segments){
        if(segment.state==='ready'||segment.state==='error')completed+=1;
    }
    try{
        interest.onState?.({
            state:interest.state,
            completed,
            total:job.segments.length,
            segments:job.segments,
            error
        });
    }catch(observerError){
        arcaneLogging.error('Speech preparation state observer failed.',observerError);
    }
}

function publishJob(job,error=null){
    for(const interest of Array.from(job.interests)){
        if(!interest.active)continue;
        interest.state=job.state;
        publish(interest,error);
    }
}

function settleSegment(job,index,error){
    const slot=job.slots[index];
    if(slot.settled)return;
    slot.settled=true;
    const segment=job.segments[index];
    if(arguments.length===3){
        segment.state='error';
        segment.error=error;
        slot.ready.reject(error);
        if(error?.name!=='AbortError'){
            arcaneLogging.error('Speech preparation segment failed.',{index,error});
        }
    }else{
        const saved=job.record.segments[index];
        segment.state='ready';
        segment.audioFile=saved.audioFile;
        segment.contentType=saved.contentType;
        slot.ready.resolve();
    }
    publishJob(job);
}

async function saveAudio(job,index,blob){
    const contentType=blob.type;
    if(!job.storage){
        job.record.segments[index]={audioFile:null,contentType};
        return;
    }
    const storage=job.storage;
    const audioFile=`${job.record.id}.${index}.audio`;
    await serializeStorage(storage,async function writePreparedAudio(){
        if(job.controller.signal.aborted)throw abortError();
        const manifest=await readManifest(storage);
        let entry=manifest.entries.find(function findPreparedEntry(candidate){
            return candidate.id===job.record.id;
        });
        if(!entry){
            entry=copyJSON(job.record);
            manifest.entries.push(entry);
        }
        if(job.controller.signal.aborted)throw abortError();
        // DB writes cannot be aborted; finish this started write and its metadata
        // together so a cancelled interest still leaves successful audio reusable.
        await storage.db.writeFile(storage.table,audioFile,blob,false);
        entry.segments[index]={audioFile,contentType};
        await storage.db.set(storage.table,storage.fileName,manifest);
        job.record.segments[index]={audioFile,contentType};
        // Durable audio is reopened on demand rather than retained in memory.
        job.slots[index].blob=null;
    });
}

async function prepareSegment(job,index,request){
    const slot=job.slots[index];
    try{
        const blob=slot.blob||await request;
        if(!(blob instanceof Blob)){
            throw new TypeError('Speech synthesis must return a Blob.');
        }
        slot.blob=blob;
        if(job.controller.signal.aborted)throw abortError();
        await saveAudio(job,index,blob);
        settleSegment(job,index);
    }catch(error){
        settleSegment(job,index,error);
    }
}

async function loadRecord(job){
    if(job.previous){
        await job.previous.finished.promise;
        for(let index=0;index<job.slots.length;index+=1){
            job.slots[index].blob=job.previous.slots[index].blob;
        }
        if(!job.storage&&job.previous.record){
            job.record=copyJSON(job.previous.record);
        }
        job.previous=null;
    }
    if(job.controller.signal.aborted)throw abortError();
    if(job.storage){
        const storage=job.storage;
        job.record=await serializeStorage(storage,async function findStoredPreparation(){
            const manifest=await readManifest(storage);
            const existing=manifest.entries.find(function findMatchingPreparation(entry){
                return sameInput(entry,job.input);
            });
            if(existing){
                if(!is.array(existing.segments)||existing.segments.length!==job.slots.length){
                    throw new TypeError('Stored speech preparation segments are unreadable.');
                }
                return copyJSON(existing);
            }
            const record=createRecord(job.input);
            manifest.entries.push(record);
            if(job.controller.signal.aborted)throw abortError();
            await storage.db.set(storage.table,storage.fileName,manifest);
            return record;
        });
    }else if(!job.record){
        job.record=createRecord(job.input);
    }
    for(let index=0;index<job.slots.length;index+=1){
        if(job.controller.signal.aborted)throw abortError();
        const audio=job.record.segments[index];
        if(!job.storage){
            if(job.slots[index].blob){
                job.record.segments[index]={
                    audioFile:null,
                    contentType:job.slots[index].blob.type
                };
                settleSegment(job,index);
            }
            continue;
        }
        if(!audio?.audioFile)continue;
        try{
            if(!is.string(audio.contentType)){
                throw new TypeError('Stored speech audio content type is unreadable.');
            }
            await job.storage.db.readFile(job.storage.table,audio.audioFile);
            job.slots[index].blob=null;
            settleSegment(job,index);
        }catch(error){
            if(error?.name==='NotFoundError'){
                job.record.segments[index]={audioFile:null,contentType:null};
            }else{
                settleSegment(job,index,error);
            }
        }
    }
}

async function admitPreparation(job){
    await loadRecord(job);
    if(job.controller.signal.aborted)throw abortError();
    job.state='preparing';
    publishJob(job);
    const pending=[];
    // Calls enter the existing provider queue in order, before awaiting results.
    for(let index=0;index<job.slots.length;index+=1){
        const slot=job.slots[index];
        if(slot.settled)continue;
        if(job.controller.signal.aborted){
            settleSegment(job,index,abortError());
            continue;
        }
        job.segments[index].state='preparing';
        let request;
        if(!slot.blob){
            try{
                request=job.synthesize(copyJSON(job.input.parts[index]),job.controller.signal);
            }catch(error){
                request=Promise.reject(error);
            }
        }
        pending.push(prepareSegment(job,index,request));
    }
    publishJob(job);
    return pending;
}

function finishPreparation(job,error){
    if(arguments.length===2){
        for(let index=0;index<job.slots.length;index+=1){
            if(!job.slots[index].settled)settleSegment(job,index,error);
        }
    }
    const errors=[];
    for(const segment of job.segments){
        if(segment.state==='error')errors.push(segment.error);
    }
    if(arguments.length===2&&errors.length===0)errors.push(error);
    job.done=true;
    job.failed=errors.length>0;
    if(job.failed){
        const failure=errors.length===1?errors[0]:new AggregateError(
            errors,
            'Some speech segments could not be prepared.'
        );
        job.state=job.controller.signal.aborted?'cancelled':'error';
        publishJob(job,failure);
        job.ready.reject(failure);
    }else{
        job.state='ready';
        publishJob(job);
        job.ready.resolve(copyJSON(job.record));
    }
    job.finished.resolve();
}

function createJob(ownerState,input,storage,synthesize,previous){
    const job={
        input,storage,synthesize,previous,
        controller:new AbortController(),
        interests:new Set(),
        state:'queued',
        done:false,
        failed:false,
        record:null,
        ready:deferred(),
        finished:deferred(),
        slots:input.parts.map(function createSegmentSlot(){
            return {ready:deferred(),blob:null,settled:false};
        }),
        segments:input.parts.map(function createPublicSegment(part,index){
            return {...part,index,state:'queued',audioFile:null,contentType:null,error:null};
        })
    };
    const admission=ownerState.admission.then(function admitOrderedPreparation(){
        return admitPreparation(job);
    });
    ownerState.admission=admission.then(
        function preparationAdmitted(){},
        function preparationAdmissionFailed(){}
    );
    admission.then(async function settleAdmittedPreparation(pending){
        await Promise.allSettled(pending);
        finishPreparation(job);
    },function failPreparationAdmission(error){
        finishPreparation(job,error);
    }).catch(function reportPreparationSettlementFailure(error){
        finishPreparation(job,error);
    });
    return job;
}

function createHandle(job,signal,onState){
    const ready=deferred();
    const cancelled=deferred();
    const interest={job,onState,active:true,state:job.state};
    function removeSignal(){signal?.removeEventListener('abort',cancel);}
    function cancel(){
        if(!interest.active)return false;
        interest.active=false;
        interest.state='cancelled';
        removeSignal();
        job.interests.delete(interest);
        const error=abortError();
        ready.reject(error);
        cancelled.reject(error);
        publish(interest,error);
        if(!job.done&&job.interests.size===0)job.controller.abort();
        return true;
    }
    const handle={
        segments:job.segments,
        get state(){return interest.state;},
        ready:ready.promise,
        async getAudio(index){
            if(!interest.active)throw abortError();
            if(!is.safeInteger(index)||index<0||index>=job.slots.length){
                throw new RangeError('Speech segment index is outside this preparation.');
            }
            await Promise.race([job.slots[index].ready.promise,cancelled.promise]);
            if(!interest.active)throw abortError();
            if(!job.storage)return job.slots[index].blob;
            const audio=job.record.segments[index];
            const file=await job.storage.db.readFile(job.storage.table,audio.audioFile);
            if(!interest.active)throw abortError();
            return file.type===audio.contentType?file:new Blob([file],{type:audio.contentType});
        },
        cancel
    };
    job.interests.add(interest);
    job.ready.promise.then(function preparationReady(record){
        if(interest.active)ready.resolve(copyJSON(record));
        removeSignal();
        job.interests.delete(interest);
    },function preparationFailed(error){
        if(interest.active)ready.reject(error);
        removeSignal();
        job.interests.delete(interest);
    });
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    else publish(interest);
    return handle;
}

/** Prepare complete ordered speech without constructing or controlling playback. */
function prepareSpeech({
    owner,
    parts,
    originalParts=parts,
    selection=null,
    segmentation=null,
    storage=null,
    identity=null,
    signal=null,
    onState=null,
    synthesize
}={}){
    if((!owner||!is.object(owner))&&!is.function(owner)){
        throw new TypeError('Speech preparation requires its owning AI instance.');
    }
    if(!is.array(parts)||!is.function(synthesize)
        ||(onState!==null&&!is.function(onState))){
        throw new TypeError('Speech preparation requires ordered parts and synthesis/state callbacks.');
    }
    const input=copyJSON({parts,originalParts,selection,segmentation,identity});
    const destination=normalizeStorage(storage);
    let ownerState=owners.get(owner);
    if(!ownerState){
        ownerState={admission:Promise.resolve(),jobs:new Set()};
        owners.set(owner,ownerState);
    }
    let previous=null;
    for(const candidate of ownerState.jobs){
        if(sameStorage(candidate.storage,destination)&&sameInput(candidate.input,input)){
            previous=candidate;
            break;
        }
    }
    if(previous&&!previous.failed&&!previous.controller.signal.aborted
        &&(!previous.done||!destination)){
        return createHandle(previous,signal,onState);
    }
    const job=createJob(ownerState,input,destination,synthesize,previous);
    if(previous)ownerState.jobs.delete(previous);
    ownerState.jobs.add(job);
    return createHandle(job,signal,onState);
}

export {prepareSpeech};
