import DocumentLexicalSearch,{
    documentContextExcerpt,
    documentSearchTokens,
    normalizedDocumentSearchText,
    scoreDocumentBody,
} from './DocumentLexicalSearch.js';

const SCHEMA_FIELDS=[
    'audiences','body','category','headings','id','kind','language','mediaType',
    'navigationGroup','navigationParent','path','platforms','searchTerms','sourcePath',
    'summary','tags','title'
];
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const TABLE=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DEFAULT_CONCURRENCY=4;
const EVALUATION_BATCH_SIZE=64;
const PARTIAL_COMPLETION='partial';
const READ_FAILURE_POLICIES=new Set(['preserve-readable','reject']);
const CANONICAL_FIELDS=Object.fromEntries(SCHEMA_FIELDS.map(field=>[field,field]));
const ACTIVE_BOOTSTRAPS=new WeakMap();
let generationSequence=0;

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function fail(message,code='DBOPFS_DOCUMENT_INVALID',ErrorType=TypeError){
    throw coded(new ErrorType(message),code);
}

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function assertKnownKeys(value,allowed,label){
    const unknown=Object.keys(value).find(key=>!allowed.has(key));
    if(unknown) fail(`${label} contains an unsupported field: ${unknown}.`);
}

function boundedInteger(value,label,{minimum,maximum}){
    if(!Number.isSafeInteger(value)||value<minimum||(maximum!==undefined&&value>maximum)){
        const range=maximum===undefined?`${minimum} or greater`:`${minimum} through ${maximum}`;
        fail(`${label} must be an integer from ${range}.`,'DBOPFS_DOCUMENT_INVALID_LIMIT',RangeError);
    }
    return value;
}

function normalizedText(value,label,{optional=false}={}){
    if(optional&&(value===undefined||value===null||value==='')) return '';
    if(typeof value!=='string') fail(`${label} must be a string.`);
    const text=value;
    if(!text.trim()&&!optional) fail(`${label} cannot be empty.`);
    return text;
}

function signalLike(value){
    return value===undefined||value===null||(
        typeof value==='object'
        &&typeof value.aborted==='boolean'
        &&typeof value.addEventListener==='function'
        &&typeof value.removeEventListener==='function'
    );
}

function abortError(){
    const error=coded(new Error('The DBOPFS document operation was aborted.'),'DBOPFS_DOCUMENT_ABORTED');
    error.name='AbortError';
    return error;
}

function throwIfAborted(signal){
    if(signal?.aborted) throw abortError();
}

async function yieldEvaluationTask(signal){
    throwIfAborted(signal);
    await new Promise((resolve,reject)=>{
        try{
            if(typeof globalThis.MessageChannel==='function'){
                const channel=new globalThis.MessageChannel();
                channel.port1.onmessage=()=>{
                    channel.port1.close();
                    channel.port2.close();
                    resolve();
                };
                channel.port1.start?.();
                channel.port2.postMessage(null);
            }else globalThis.setTimeout(resolve,0);
        }catch(error){reject(error);}
    });
    throwIfAborted(signal);
}

function normalizeSchema(input){
    if(!isPlainRecord(input)) fail('Document schema must be a plain object.');
    assertKnownKeys(input,new Set(['fields','id','table','version']),'Document schema');
    const id=normalizedText(input.id,'Document schema id');
    if(!IDENTIFIER.test(id)) fail('Document schema id is invalid.');
    const version=normalizedText(String(input.version??''),'Document schema version');
    if(!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) fail('Document schema version is invalid.');
    const table=normalizedText(input.table??'documents','Document schema table');
    if(!TABLE.test(table)) fail('Document schema table is invalid.');
    const supplied=input.fields??{};
    if(!isPlainRecord(supplied)) fail('Document schema fields must be a plain object.');
    assertKnownKeys(supplied,new Set(SCHEMA_FIELDS),'Document schema fields');
    const fields={};
    const used=new Set();
    for(const field of SCHEMA_FIELDS){
        const property=normalizedText(supplied[field]??field,`Document schema ${field} field`);
        if(!/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(property)) fail(`Document schema ${field} field is invalid.`);
        const canonical=property.toLowerCase();
        if(used.has(canonical)) fail(`Document schema fields contain a collision: ${property}.`);
        used.add(canonical);
        fields[field]=property;
    }
    return {fields,id,table,version};
}

function stringList(value,label){
    if(value===undefined||value===null) return [];
    if(!Array.isArray(value)) fail(`${label} must be an array.`);
    return value.map((item,index)=>normalizedText(item,`${label} entry ${index+1}`));
}

function headings(value){
    if(value===undefined||value===null) return [];
    if(!Array.isArray(value)) fail('Document headings must be an array.');
    return value.map((item,index)=>{
        if(!isPlainRecord(item)) fail(`Document heading ${index+1} must be a plain object.`);
        assertKnownKeys(item,new Set(['id','level','text']),`Document heading ${index+1}`);
        return {
            id:normalizedText(item.id,`Document heading ${index+1} id`),
            level:boundedInteger(item.level,`Document heading ${index+1} level`,{minimum:1,maximum:6}),
            text:normalizedText(item.text,`Document heading ${index+1} text`),
        };
    });
}

function documentKeys(schema){
    return new Set(Object.values(schema.fields));
}

function normalizeDocument(input,schema,index,{stored=false}={}){
    if(!isPlainRecord(input)) fail(`Document ${index+1} must be a plain object.`);
    const fields=schema.fields;
    const allowed=documentKeys(schema);
    if(stored){allowed.add('schemaId');allowed.add('schemaVersion');}
    assertKnownKeys(input,allowed,`Document ${index+1}`);
    const id=normalizedText(input[fields.id],`Document ${index+1} id`);
    if(!IDENTIFIER.test(id)) fail(`Document ${index+1} id is invalid.`);
    const body=input[fields.body];
    if(typeof body!=='string') fail(`Document ${id} body must be a string.`);
    const mediaType=normalizedText(input[fields.mediaType]??'text/markdown',`Document ${id} mediaType`);
    if(!['text/markdown','text/plain'].includes(mediaType)) fail(`Document ${id} mediaType is unsupported.`);
    const kind=normalizedText(input[fields.kind]??'document',`Document ${id} kind`).toLowerCase();
    const title=normalizedText(input[fields.title]??id,`Document ${id} title`);
    return {
        audiences:stringList(input[fields.audiences],`Document ${id} audiences`),
        body,
        category:normalizedText(input[fields.category]??'',`Document ${id} category`,{optional:true}),
        headings:headings(input[fields.headings]),
        id,
        kind,
        language:normalizedText(input[fields.language]??'',`Document ${id} language`,{optional:true}),
        mediaType,
        navigationGroup:normalizedText(input[fields.navigationGroup]??'',`Document ${id} navigationGroup`,{optional:true}),
        navigationParent:normalizedText(input[fields.navigationParent]??'',`Document ${id} navigationParent`,{optional:true}),
        path:normalizedText(input[fields.path]??id,`Document ${id} path`),
        platforms:stringList(input[fields.platforms],`Document ${id} platforms`),
        schemaId:schema.id,
        schemaVersion:schema.version,
        searchTerms:stringList(input[fields.searchTerms],`Document ${id} searchTerms`),
        sourcePath:normalizedText(input[fields.sourcePath]??'',`Document ${id} sourcePath`,{optional:true}),
        summary:normalizedText(input[fields.summary]??'',`Document ${id} summary`,{optional:true}),
        tags:stringList(input[fields.tags],`Document ${id} tags`),
        title,
    };
}

function normalizeStoredDocument(input,schema,index){
    if(
        !isPlainRecord(input)
        ||input.schemaId!==schema.id
        ||input.schemaVersion!==schema.version
    ) fail(`Stored document ${index+1} does not match the configured schema.`);
    return normalizeDocument(
        input,
        {...schema,fields:CANONICAL_FIELDS},
        index,
        {stored:true},
    );
}

function corpusPrefix(schema){
    return `${encodeURIComponent(schema.table)}--${encodeURIComponent(schema.id)}--`;
}

function storagePrefix(schema,generation){
    return `${corpusPrefix(schema)}${generation}--`;
}

function storageKey(schema,generation,id){
    return `${storagePrefix(schema,generation)}${encodeURIComponent(id)}.json`;
}

function manifestKey(schema){
    return `${encodeURIComponent(schema.table)}--${encodeURIComponent(schema.id)}.json`;
}

function generationId(){
    const value=globalThis.crypto?.randomUUID?.();
    if(typeof value==='string'&&value)return value;
    generationSequence+=1;
    return `generation-${Date.now().toString(36)}-${generationSequence.toString(36)}`;
}

function publicRecord(record){
    return {...record};
}

function normalizedFailureText(value,fallback){
    let text=fallback;
    try{if(value!==undefined&&value!==null) text=String(value);}
    catch{text=fallback;}
    return text||fallback;
}

function failure(error,key,{phase}={}){
    const record={
        code:normalizedFailureText(error?.code,'DBOPFS_DOCUMENT_ERROR'),
        key:normalizedFailureText(key,'unknown'),
        message:normalizedFailureText(error?.message??error,'Document operation failed.'),
    };
    if(phase) record.phase=phase;
    return record;
}

function readFailureError(message,errors,failures){
    const error=coded(new AggregateError(errors,message),'DBOPFS_DOCUMENT_READ_FAILED');
    error.failures=[...failures];
    return error;
}

function sourceFailureKey(file,index,schema){
    for(const field of ['id','sourcePath','path']){
        const value=file?.[schema.fields[field]];
        if(typeof value==='string'&&value.trim()) return normalizedFailureText(value,`source:${index+1}`);
    }
    return `source:${index+1}`;
}

function normalizeReadCoverage(input,count){
    if(input===undefined) return {errors:0,failures:[],readable:count,total:count};
    if(
        !isPlainRecord(input)
        ||Object.keys(input).some(key=>!['errors','failures','readable','total'].includes(key))
        ||!Array.isArray(input.failures)
        ||Object.keys(input.failures).length!==input.failures.length
        ||!Number.isSafeInteger(input.errors)
        ||!Number.isSafeInteger(input.readable)
        ||!Number.isSafeInteger(input.total)
    ) fail('Stored document read coverage is invalid.','DBOPFS_DOCUMENT_INCOMPLETE');
    const failures=input.failures.map((item,index)=>{
        if(!isPlainRecord(item)||item.phase!=='source-read'
            ||Object.keys(item).some(key=>!['code','key','message','phase'].includes(key))){
            fail(`Stored document read failure ${index+1} is invalid.`,'DBOPFS_DOCUMENT_INCOMPLETE');
        }
        const normalized=failure({code:item.code,message:item.message},item.key,{phase:'source-read'});
        if(normalized.code!==item.code||normalized.key!==item.key||normalized.message!==item.message){
            fail(`Stored document read failure ${index+1} is not normalized.`,'DBOPFS_DOCUMENT_INCOMPLETE');
        }
        return normalized;
    });
    if(
        input.errors!==failures.length
        ||input.readable!==count
        ||input.total!==input.readable+input.errors
        ||input.total<0
    ) fail('Stored document read coverage is inconsistent.','DBOPFS_DOCUMENT_INCOMPLETE');
    return {errors:input.errors,failures,readable:input.readable,total:input.total};
}

function reportProgress(callback,value){
    if(!callback) return;
    try{callback(value);}catch{
        // Progress is observational and cannot change corpus admission.
    }
}

async function boundedMap(items,concurrency,signal,operation,onSettle){
    let cursor=0;
    let aborted=false;
    const results=new Array(items.length);
    async function worker(){
        while(true){
            if(signal?.aborted){aborted=true;return;}
            const index=cursor++;
            if(index>=items.length) return;
            try{
                results[index]={status:'fulfilled',value:await operation(items[index],index)};
            }catch(error){
                results[index]={status:'rejected',reason:error};
            }
            onSettle?.(results[index],items[index],index);
        }
    }
    await Promise.all(Array.from({length:Math.min(concurrency,Math.max(items.length,1))},worker));
    if(aborted||signal?.aborted) throw abortError();
    return results;
}

function normalizedEvaluationFilters(kinds,tags){
    const normalize=values=>values===undefined?null:new Set(
        values.map(value=>normalizedDocumentSearchText(String(value).trim())),
    );
    return {kinds:normalize(kinds),tags:normalize(tags)};
}

function matchesEvaluationFilters(record,filters){
    if(
        filters.kinds
        &&!filters.kinds.has(normalizedDocumentSearchText(record.kind))
    ) return false;
    return !filters.tags||[...filters.tags].every(tag=>record.tags.some(
        value=>normalizedDocumentSearchText(value)===tag,
    ));
}

async function rankEvaluationRecords(records,query,options){
    const phrase=normalizedDocumentSearchText(String(query).trim());
    const tokens=documentSearchTokens(query);
    const matches=[];
    reportProgress(options.onProgress,{completed:0,failed:options.failed,phase:'ranking',total:records.length});
    await yieldEvaluationTask(options.signal);
    for(let start=0;start<records.length;start+=EVALUATION_BATCH_SIZE){
        const end=Math.min(start+EVALUATION_BATCH_SIZE,records.length);
        const batch=records.slice(start,end);
        const metadata=new Map(new DocumentLexicalSearch(batch)
            .rank(query).map(match=>[match.id,match]));
        for(const record of batch){
            const scoring=record.body;
            const bodyScore=scoreDocumentBody(scoring,phrase,tokens);
            const existing=metadata.get(record.id);
            matches.push({
                ...(existing??record),
                matchedFields:[
                    ...(existing?.matchedFields??[]),
                    ...(bodyScore?['body']:[]),
                ],
                score:(existing?.score??0)+bodyScore,
                scoredCharacters:scoring.length,
            });
        }
        reportProgress(options.onProgress,{completed:end,failed:options.failed,
            phase:'ranking',total:records.length});
        await yieldEvaluationTask(options.signal);
    }
    throwIfAborted(options.signal);
    matches.sort((left,right)=>right.score-left.score
        ||options.ordinals.get(left.id)-options.ordinals.get(right.id)
        ||normalizedDocumentSearchText(left.sourcePath||left.path)
            .localeCompare(normalizedDocumentSearchText(right.sourcePath||right.path))
        ||normalizedDocumentSearchText(left.title).localeCompare(normalizedDocumentSearchText(right.title))
        ||left.id.localeCompare(right.id));
    throwIfAborted(options.signal);
    return matches;
}

async function readEvaluationSources(sources,options){
    const {
        concurrency,filters,onProgress,
        read,readFailurePolicy,schema,signal,
    }=options;
    const descriptors=[];
    const seen=new Set();
    let filtered=0;
    reportProgress(onProgress,{completed:0,failed:0,phase:'preparing',total:sources.length});
    await yieldEvaluationTask(signal);
    for(let index=0;index<sources.length;index++){
        throwIfAborted(signal);
        const source=sources[index];
        assertKnownKeys(source,documentKeys(schema),`Document source ${index+1}`);
        if(Object.hasOwn(source,schema.fields.body)){
            fail(`Document source ${index+1} must omit body; read owns source text.`);
        }
        const record=normalizeDocument({...source,[schema.fields.body]:''},schema,index);
        const key=record.id.toLowerCase();
        if(seen.has(key)) fail(`Document evaluation contains a case-colliding id: ${record.id}.`,
            'DBOPFS_DOCUMENT_CASE_COLLISION');
        seen.add(key);
        if(matchesEvaluationFilters(record,filters)){
            descriptors.push({ordinal:index,record,source});
        }else filtered++;
        const completed=index+1;
        if(completed%EVALUATION_BATCH_SIZE===0||completed===sources.length){
            reportProgress(onProgress,{completed,failed:0,filtered,phase:'preparing',total:sources.length});
            await yieldEvaluationTask(signal);
        }
    }
    const failures=[];
    const rawReadErrors=[];
    const records=[];
    let completed=0;
    let failed=0;
    reportProgress(onProgress,{completed,failed,filtered,phase:'reading',total:descriptors.length});
    for(let start=0;start<descriptors.length;start+=concurrency){
        throwIfAborted(signal);
        const batch=descriptors.slice(start,start+concurrency);
        const settled=await Promise.allSettled(batch.map(async descriptor=>{
            let body;
            try{
                body=await read(descriptor.source,{
                    ordinal:descriptor.ordinal,signal:signal??null
                });
                if(typeof body!=='string') fail('read must resolve to document text.');
            }catch(error){return {error};}
            return {body,record:{...descriptor.record,body}};
        }));
        throwIfAborted(signal);

        let batchReadFailed=false;
        for(let index=0;index<settled.length;index++){
            const result=settled[index];
            const descriptor=batch[index];
            completed++;
            if(
                result.status==='rejected'
                ||(result.value&&Object.hasOwn(result.value,'error'))
            ) failed++;
            if(result.status==='fulfilled'&&Object.hasOwn(result.value,'error')){
                rawReadErrors.push(result.value.error);
                failures.push(failure(result.value.error,
                    sourceFailureKey(descriptor.source,descriptor.ordinal,schema),{phase:'source-read'}));
                batchReadFailed=true;
            }
            reportProgress(onProgress,{completed,failed,id:descriptor.record.id,
                ordinal:descriptor.ordinal,phase:'reading',total:descriptors.length});
        }
        throwIfAborted(signal);
        const fatal=settled.find(result=>result.status==='rejected');
        if(fatal) throw fatal.reason;
        if(batchReadFailed&&readFailurePolicy==='reject') throw readFailureError(
            `Document evaluation could not read ${failures.length} source(s).`,rawReadErrors,failures);

        for(const result of settled){
            if(!Object.hasOwn(result.value,'record')) continue;
            records.push(result.value.record);
        }
        await yieldEvaluationTask(signal);
    }
    if(descriptors.length>0&&!records.length){
        throw readFailureError('Document evaluation could not read any sources.',rawReadErrors,failures);
    }
    return {
        failures,filtered,
        ordinals:new Map(descriptors.map(({ordinal,record})=>[record.id,ordinal])),
        records,
    };
}

/**
 * Stores and searches one application-defined document corpus in DBOPFS.
 * Applications explicitly call bootstrap and opt a chat into request context;
 * constructing this object performs no reads, writes, fetches, or searches.
 */
class DBOPFSDocumentLibrary{
    #concurrency;
    #db;
    #schema;

    constructor(options={}){
        if(!isPlainRecord(options)) fail('DBOPFS document library options must be a plain object.');
        assertKnownKeys(options,new Set([
            'concurrency','db','maxCorpusCharacters','maxDocumentCharacters','maxSearchCharacters','schema'
        ]),'DBOPFS document library options');
        const db=options.db??globalThis.dbopfs;
        if(!db||typeof db.get!=='function'||typeof db.set!=='function'||typeof db.getAllKeys!=='function'||typeof db.delete!=='function'){
            fail('A DBOPFS-compatible db with get, set, getAllKeys, and delete is required.','DBOPFS_DOCUMENT_STORAGE_UNAVAILABLE');
        }
        this.#db=db;
        this.#schema=normalizeSchema(options.schema);
        this.#concurrency=boundedInteger(options.concurrency??DEFAULT_CONCURRENCY,'concurrency',{minimum:1});
    }

    get schema(){return this.#schema;}

    async bootstrap(options={}){
        let locks=ACTIVE_BOOTSTRAPS.get(this.#db);
        if(!locks){locks=new Map();ACTIVE_BOOTSTRAPS.set(this.#db,locks);}
        const lockKey=`${this.#schema.table}\u0000${this.#schema.id}`;
        if(locks.has(lockKey)){
            fail('A bootstrap is already active for this document corpus.','DBOPFS_DOCUMENT_BUSY');
        }
        const operation=this.#bootstrap(options);
        locks.set(lockKey,operation);
        try{return await operation;}
        finally{
            if(locks.get(lockKey)===operation) locks.delete(lockKey);
            if(!locks.size) ACTIVE_BOOTSTRAPS.delete(this.#db);
        }
    }

    async #bootstrap(options={}){
        if(!isPlainRecord(options)) fail('Document bootstrap options must be a plain object.');
        assertKnownKeys(
            options,
            new Set(['files','onProgress','read','readFailurePolicy','signal']),
            'Document bootstrap options',
        );
        if(!Array.isArray(options.files)) fail('Document bootstrap files must be an array.');
        if(options.onProgress!==undefined&&typeof options.onProgress!=='function') fail('onProgress must be a function.');
        if(options.read!==undefined&&typeof options.read!=='function') fail('read must be a function.');
        const readFailurePolicy=options.readFailurePolicy??'preserve-readable';
        if(!READ_FAILURE_POLICIES.has(readFailurePolicy)){
            fail('readFailurePolicy must be "reject" or "preserve-readable".');
        }
        if(!signalLike(options.signal)) fail('signal must be an AbortSignal.');
        throwIfAborted(options.signal);

        for(let index=0;index<options.files.length;index++){
            const file=options.files[index];
            if(!isPlainRecord(file)) fail(`Document ${index+1} must be a plain object.`);
            assertKnownKeys(file,documentKeys(this.#schema),`Document ${index+1}`);
        }

        let sourceFiles=options.files;
        let readFailures=[];
        if(options.read){
            let readCompleted=0;
            reportProgress(options.onProgress,{completed:0,phase:'reading',total:sourceFiles.length});
            const reads=await boundedMap(
                sourceFiles,
                this.#concurrency,
                options.signal,
                async file=>{
                    if(typeof file?.[this.#schema.fields.body]==='string') return file;
                    const body=await options.read({...file},{signal:options.signal??null});
                    if(typeof body!=='string') fail('read must resolve to document text.');
                    return {...file,[this.#schema.fields.body]:body};
                },
                (_result,file)=>reportProgress(options.onProgress,{
                    completed:++readCompleted,
                    id:String(file?.[this.#schema.fields.id]??''),
                    phase:'reading',
                    total:sourceFiles.length,
                }),
            );
            readFailures=reads
                .map((result,index)=>result.status==='rejected'
                    ?failure(
                        result.reason,
                        sourceFailureKey(sourceFiles[index],index,this.#schema),
                        {phase:'source-read'},
                    )
                    :null)
                .filter(Boolean);
            if(readFailures.length){
                const error=coded(new AggregateError(
                    reads.filter(result=>result.status==='rejected').map(result=>result.reason),
                    `Document bootstrap could not read ${readFailures.length} file(s).`,
                ),'DBOPFS_DOCUMENT_READ_FAILED');
                error.failures=readFailures;
                if(readFailurePolicy==='reject') throw error;
            }
            sourceFiles=reads
                .filter(result=>result.status==='fulfilled')
                .map(result=>result.value);
            if(options.files.length>0&&!sourceFiles.length){
                const error=coded(new AggregateError(
                    reads.filter(result=>result.status==='rejected').map(result=>result.reason),
                    'Document bootstrap could not read any files.',
                ),'DBOPFS_DOCUMENT_READ_FAILED');
                error.failures=readFailures;
                throw error;
            }
        }

        const normalized=sourceFiles.map((file,index)=>normalizeDocument(
            file,
            this.#schema,
            index,
        ));
        const seen=new Set();
        for(const record of normalized){
            const key=record.id.toLowerCase();
            if(seen.has(key)) fail(`Document bootstrap contains a case-colliding id: ${record.id}.`,'DBOPFS_DOCUMENT_CASE_COLLISION');
            seen.add(key);
        }

        const marker=manifestKey(this.#schema);
        const generation=generationId();
        const keys=normalized.map(record=>storageKey(this.#schema,generation,record.id)).sort();
        const newKeys=new Set(keys);
        const priorKeys=(await this.#db.getAllKeys(this.#schema.table))
            .filter(key=>key.startsWith(corpusPrefix(this.#schema))&&key.endsWith('.json'));
        let completed=0;
        reportProgress(options.onProgress,{completed,phase:'writing',total:normalized.length});
        let results;
        try{
            results=await boundedMap(
                normalized,
                this.#concurrency,
                options.signal,
                record=>this.#db.set(this.#schema.table,storageKey(this.#schema,generation,record.id),record),
                (_result,record)=>{
                    completed++;
                    reportProgress(options.onProgress,{completed,id:record.id,phase:'writing',total:normalized.length});
                },
            );
        }catch(error){
            await boundedMap(keys,this.#concurrency,null,key=>this.#db.delete(this.#schema.table,key));
            throw error;
        }
        const failures=results
            .map((result,index)=>result.status==='rejected'?failure(result.reason,normalized[index].id):null)
            .filter(Boolean);
        if(failures.length){
            await boundedMap(keys,this.#concurrency,null,key=>this.#db.delete(this.#schema.table,key));
            const error=coded(new AggregateError(
                results.filter(result=>result.status==='rejected').map(result=>result.reason),
                `Document bootstrap failed for ${failures.length} file(s).`,
            ),'DBOPFS_DOCUMENT_BOOTSTRAP_FAILED');
            error.failures=failures;
            throw error;
        }

        const manifest={
            completed:readFailures.length?PARTIAL_COMPLETION:true,
            generation,
            keys,
            ...(readFailures.length?{readCoverage:{
                errors:readFailures.length,failures:readFailures,
                readable:normalized.length,total:options.files.length,
            }}:{}),
            schemaId:this.#schema.id,
            table:this.#schema.table,
            schemaVersion:this.#schema.version,
        };
        try{
            throwIfAborted(options.signal);
            await this.#db.set('document_library_manifests',marker,manifest);
        }catch(error){
            await boundedMap(keys,this.#concurrency,null,key=>this.#db.delete(this.#schema.table,key));
            throw error;
        }
        const staleKeys=priorKeys.filter(key=>!newKeys.has(key));
        const cleanup=await boundedMap(
            staleKeys,
            this.#concurrency,
            null,
            key=>this.#db.delete(this.#schema.table,key),
        );
        const cleanupFailures=cleanup.filter(result=>result.status==='rejected').length;
        reportProgress(options.onProgress,{
            completed:staleKeys.length-cleanupFailures,
            failed:cleanupFailures,
            phase:'cleanup',
            total:staleKeys.length,
        });
        reportProgress(options.onProgress,{
            cleanupFailures,
            completed:normalized.length,
            failed:readFailures.length,
            phase:'complete',
            total:options.files.length,
        });
        await this.#db.set('document_library_manifests',marker,manifest);
        return manifest;
    }

    async #corpus(signal){
        return this.#corpusSnapshot(signal);
    }

    async #corpusSnapshot(signal){
        throwIfAborted(signal);
        const manifest=await this.#db.get(
            'document_library_manifests',
            manifestKey(this.#schema),
            true,
        );
        if(
            !isPlainRecord(manifest)
            ||(manifest.completed!==true&&manifest.completed!==PARTIAL_COMPLETION)
            ||manifest.schemaId!==this.#schema.id
            ||manifest.table!==this.#schema.table
            ||manifest.schemaVersion!==this.#schema.version
            ||typeof manifest.generation!=='string'
            ||!manifest.generation
            ||!Array.isArray(manifest.keys)
        ) fail('The DBOPFS document corpus has not completed bootstrap.','DBOPFS_DOCUMENT_NOT_BOOTSTRAPPED');
        const readCoverage=normalizeReadCoverage(manifest.readCoverage,manifest.keys.length);
        if((manifest.completed===PARTIAL_COMPLETION)!==(readCoverage.errors>0)){
            fail('Stored document completion state is inconsistent.','DBOPFS_DOCUMENT_INCOMPLETE');
        }
        const keys=[...manifest.keys];
        if(
            new Set(keys).size!==keys.length
            ||keys.some(key=>typeof key!=='string'||!key)
        ) fail('The DBOPFS document corpus differs from its completion manifest.','DBOPFS_DOCUMENT_INCOMPLETE');
        const settled=await boundedMap(
            keys,
            this.#concurrency,
            signal,
            key=>this.#db.get(this.#schema.table,key,true),
        );
        const records=[];
        const failures=[...readCoverage.failures];
        for(let index=0;index<settled.length;index++){
            const result=settled[index];
            if(result.status==='rejected'){
                failures.push(failure(result.reason,keys[index],{phase:'corpus-read'}));
                continue;
            }
            try{
                const record=normalizeStoredDocument(
                    result.value,
                    this.#schema,
                    index,
                );
                records.push(record);
            }catch(error){
                failures.push(failure(error,keys[index],{phase:'corpus-read'}));
            }
        }
        return {failures,records};
    }

    async search(query,options={}){
        if(!isPlainRecord(options)) fail('Document search options must be a plain object.');
        assertKnownKeys(options,new Set(['kinds','signal','tags']),'Document search options');
        if(!signalLike(options.signal)) fail('signal must be an AbortSignal.');
        const corpus=await this.#corpus(options.signal);
        const search=new DocumentLexicalSearch(corpus.records);
        const metadataMatches=search.rank(query,{kinds:options.kinds,tags:options.tags});
        const candidates=new Map(metadataMatches.map(match=>[match.id,match]));
        const phrase=normalizedDocumentSearchText(String(query).trim());
        const tokens=documentSearchTokens(query);
        const kinds=options.kinds?new Set(options.kinds.map(value=>String(value).trim().toLowerCase())):null;
        const tags=options.tags?new Set(options.tags.map(value=>String(value).trim().toLowerCase())):null;
        for(const record of corpus.records){
            if(kinds&&!kinds.has(record.kind.toLowerCase())) continue;
            if(tags&&![...tags].every(tag=>record.tags.some(value=>value.toLowerCase()===tag))) continue;
            const score=scoreDocumentBody(record.body,phrase,tokens);
            if(!score) continue;
            const existing=candidates.get(record.id);
            candidates.set(record.id,{
                ...(existing??record),
                matchedFields:[...(existing?.matchedFields??[]),'body'],
                score:(existing?.score??0)+score,
            });
        }
        const matches=[...candidates.values()]
            .sort((left,right)=>right.score-left.score
                ||normalizedDocumentSearchText(left.title).localeCompare(normalizedDocumentSearchText(right.title))
                ||left.id.localeCompare(right.id))
            .map(publicRecord);
        return {
            failures:corpus.failures,
            matches,
            total:corpus.records.length,
        };
    }

    /**
     * Evaluates complete caller-owned source records without copying bodies into DBOPFS.
     */
    async evaluate(query,options={}){
        if(!isPlainRecord(options)) fail('Document evaluation options must be a plain object.');
        assertKnownKeys(options,new Set([
            'kinds','maxCharacters','maxCorpusCharacters','maxDocumentCharacters',
            'maxScoringCharacters','onProgress','read','readFailurePolicy','signal','sources','tags'
        ]),'Document evaluation options');
        if(!signalLike(options.signal)) fail('signal must be an AbortSignal.');
        if(options.onProgress!==undefined&&typeof options.onProgress!=='function') fail('onProgress must be a function.');
        throwIfAborted(options.signal);
        new DocumentLexicalSearch([]).rank(query,{
            kinds:options.kinds,
            tags:options.tags,
        });
        const filters=normalizedEvaluationFilters(options.kinds,options.tags);

        if(!Array.isArray(options.sources)) fail('Document evaluation sources must be an array.');
        if(typeof options.read!=='function') fail('Source evaluation requires a read function.');
        const readFailurePolicy=options.readFailurePolicy??'preserve-readable';
        if(!READ_FAILURE_POLICIES.has(readFailurePolicy)){
            fail('readFailurePolicy must be "reject" or "preserve-readable".');
        }
        const sources=options.sources.map((source,index)=>{
            if(!isPlainRecord(source)) fail(`Document source ${index+1} must be a plain object.`);
            return {...source};
        });
        const sourceResult=await readEvaluationSources(sources,{
            concurrency:this.#concurrency,filters,onProgress:options.onProgress,
            read:options.read,readFailurePolicy,schema:this.#schema,signal:options.signal,
        });
        const {failures,filtered,ordinals,records}=sourceResult;
        reportProgress(options.onProgress,{completed:sources.length-filtered,failed:failures.length,
            filtered,phase:'read-complete',readable:records.length,total:sources.length-filtered});

        const matches=await rankEvaluationRecords(records,query,{
            failed:failures.length,onProgress:options.onProgress,
            ordinals,signal:options.signal,
        });
        const preamble='DBOPFS DOCUMENT CONTEXT\n';
        let characters=0;
        const chunks=[];
        const documents=[];
        reportProgress(options.onProgress,{completed:0,failed:failures.length,
            phase:'assembling',total:matches.length});
        await yieldEvaluationTask(options.signal);
        for(let index=0;index<matches.length;index++){
            throwIfAborted(options.signal);
            const match=matches[index];
            const heading=`\n[BEGIN DOCUMENT]\nid: ${JSON.stringify(match.id)}\npath: ${JSON.stringify(match.path)}\ntitle: ${JSON.stringify(match.title)}\ncontent:\n`;
            const footer='\n[END DOCUMENT]\n';
            const prefix=characters?'':preamble;
            const excerpt=documentContextExcerpt(match.body);
            const addition=prefix+heading+excerpt.text+footer;
            chunks.push(addition);
            characters+=addition.length;
            documents.push({
                ...match,
                body:excerpt.text,
                characters:excerpt.text.length,
                lineEnd:excerpt.lineEnd,
                lineStart:excerpt.lineStart,
                ordinal:ordinals.get(match.id),
                sourceCharacters:match.body.length,
            });
            const completed=index+1;
            if(completed%EVALUATION_BATCH_SIZE===0||completed===matches.length){
                reportProgress(options.onProgress,{completed,failed:failures.length,
                    phase:'assembling',total:matches.length});
                await yieldEvaluationTask(options.signal);
            }
        }
        throwIfAborted(options.signal);
        const text=chunks.join('');
        throwIfAborted(options.signal);
        const coverage={
            eligible:sources.length-filtered,errors:failures.length,filtered,included:documents.length,
            matched:matches.filter(match=>match.score>0).length,
            omitted:0,readable:records.length,total:sources.length,
        };
        const result={
            authority:'sources',
            characters,
            coverage,
            documents,
            failures,
            query,
            text,
        };
        reportProgress(options.onProgress,{completed:documents.length,failed:failures.length,
            filtered,phase:'complete',readable:records.length,total:sources.length});
        return result;
    }

    async buildContext(query,options={}){
        if(!isPlainRecord(options)) fail('Document context options must be a plain object.');
        assertKnownKeys(options,new Set(['signal']),'Document context options');
        if(!signalLike(options.signal)) fail('signal must be an AbortSignal.');
        const result=await this.search(query,{signal:options.signal});
        const preamble='DBOPFS DOCUMENT CONTEXT\n';
        let text='';
        const documents=[];
        for(const match of result.matches){
            const heading=`\n[BEGIN DOCUMENT]\nid: ${JSON.stringify(match.id)}\npath: ${JSON.stringify(match.path)}\ntitle: ${JSON.stringify(match.title)}\ncontent:\n`;
            const footer='\n[END DOCUMENT]\n';
            if(!text) text=preamble;
            const excerpt=documentContextExcerpt(match.body);
            text+=heading+excerpt.text+footer;
            documents.push({
                characters:excerpt.text.length,
                id:match.id,
                lineEnd:excerpt.lineEnd,
                lineStart:excerpt.lineStart,
                path:match.path,
                score:match.score,
                title:match.title,
            });
        }
        return {
            characters:text.length,
            documents,
            failures:result.failures,
            text,
        };
    }

    createContextBuilder(options={}){
        if(!isPlainRecord(options)) fail('Context builder options must be a plain object.');
        assertKnownKeys(options,new Set(),'Context builder options');
        return async({input,signal}={})=>(await this.buildContext(input,{signal})).text;
    }
}

function createDBOPFSDocumentLibrary(options){
    return new DBOPFSDocumentLibrary(options);
}

export {
    DBOPFSDocumentLibrary,
    createDBOPFSDocumentLibrary,
    normalizeSchema as normalizeDBOPFSDocumentSchema,
};

export default DBOPFSDocumentLibrary;
