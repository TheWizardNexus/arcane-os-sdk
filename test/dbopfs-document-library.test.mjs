import assert from 'node:assert/strict';

import test from '../src/testing.mjs';
import {
    createDBOPFSDocumentLibrary,
    normalizeDBOPFSDocumentSchema,
} from '../runtime/arcane/modules/DBOPFSDocumentLibrary.js';

function memoryDB({rejectId=null,setHook=null}={}){
    const tables=new Map();
    const operations=[];
    let rejectedDeletePrefix=null;
    let rejectedId=rejectId;
    const table=name=>{
        if(!tables.has(name)) tables.set(name,new Map());
        return tables.get(name);
    };
    return {
        operations,
        async delete(tableName,key){
            operations.push(['delete',tableName,key]);
            if(rejectedDeletePrefix&&key.startsWith(rejectedDeletePrefix)){
                throw new Error('synthetic delete failure');
            }
            table(tableName).delete(key);
            return true;
        },
        async get(tableName,key){return table(tableName).get(key)??null;},
        async getAllKeys(tableName){return [...table(tableName).keys()];},
        keys(tableName){return [...table(tableName).keys()];},
        rejectDeletesForPrefix(value){rejectedDeletePrefix=value;},
        async set(tableName,key,value){
            operations.push(['set',tableName,key]);
            if(setHook) await setHook({key,tableName,value});
            if(rejectedId&&value?.id===rejectedId) throw new Error('synthetic write failure');
            table(tableName).set(key,structuredClone(value));
            return value;
        },
        rejectWritesFor(value){rejectedId=value;},
    };
}

const mappedSchema={
    id:'boss-library',
    version:'1',
    table:'documents',
    fields:{
        body:'markdown',
        id:'documentId',
        searchTerms:'terms',
        tags:'labels',
        title:'name',
    },
};

const files=[
    {
        documentId:'alpha',
        labels:['guidance'],
        markdown:'The red fox uses a bounded document index.',
        name:'Alpha guide',
        terms:['document search'],
    },
    {
        documentId:'beta',
        labels:['reference'],
        markdown:'A blue whale appears only in this document body.',
        name:'Beta reference',
        terms:['corpus'],
    },
];

test('DBOPFS document libraries own schema-bound manifest-last bootstrap and explicit lexical context',async()=>{
    const db=memoryDB();
    const progress=[];
    const library=createDBOPFSDocumentLibrary({db,schema:mappedSchema});
    const normalized=normalizeDBOPFSDocumentSchema(mappedSchema);
    assert.equal(normalized.fields.body,'markdown');
    assert.equal(normalized.fields.id,'documentId');

    const manifest=await library.bootstrap({files,onProgress:value=>progress.push(value)});
    assert.equal(manifest.completed,true);
    assert.equal(manifest.count,2);
    assert.match(manifest.generation,/^[a-f0-9-]{36}$/u);
    assert.equal(progress.at(-1).phase,'complete');
    assert.deepEqual(db.operations.at(-1).slice(0,2),['set','document_library_manifests']);

    const search=await library.search('blue whale');
    assert.equal(search.matches.length,1);
    assert.equal(search.matches[0].id,'beta');
    assert.ok(search.matches[0].matchedFields.includes('body'));

    const context=await library.buildContext('red fox');
    assert.match(context.text,/UNTRUSTED DBOPFS DOCUMENT CONTEXT/u);
    assert.match(context.text,/red fox/u);
    const contextBuilder=library.createContextBuilder();
    assert.equal(typeof await contextBuilder({input:'red fox'}),'string');

    const replacement=await library.bootstrap({files:[files[0]]});
    assert.notEqual(replacement.generation,manifest.generation);
    assert.equal((await library.search('blue whale')).matches.length,0);
    assert.equal(db.keys('documents').length,1);

    const empty=await library.bootstrap({files:[]});
    assert.equal(empty.count,0);
    assert.deepEqual(db.keys('documents'),[]);
    assert.deepEqual((await library.search('anything')).matches,[]);

    const otherTable=createDBOPFSDocumentLibrary({
        db,
        schema:{...mappedSchema,table:'other-documents'},
    });
    await otherTable.bootstrap({files:[files[1]]});
    assert.deepEqual(
        db.keys('document_library_manifests').sort(),
        ['documents--boss-library.json','other-documents--boss-library.json'],
    );
});

test('DBOPFS document bootstrap preserves readable sources only through an explicit partial policy',async()=>{
    const db=memoryDB();
    const library=createDBOPFSDocumentLibrary({db,schema:mappedSchema});
    const descriptors=files.map(({markdown:_,...file})=>file);
    const read=async file=>{
        if(file.documentId==='beta'){
            const error=new Error('The beta source is unavailable.');
            error.code='SOURCE_UNAVAILABLE';
            throw error;
        }
        return files.find(candidate=>candidate.documentId===file.documentId).markdown;
    };

    await assert.rejects(
        library.bootstrap({files:descriptors,read}),
        error=>error?.code==='DBOPFS_DOCUMENT_READ_FAILED'
            &&Object.isFrozen(error.failures)
            &&error.failures.length===1
            &&error.failures[0].phase==='source-read'
            &&error.failures[0].key==='beta',
    );
    assert.equal(
        await db.get('document_library_manifests','documents--boss-library.json'),
        null,
    );

    const manifest=await library.bootstrap({
        files:descriptors,
        read,
        readFailurePolicy:'preserve-readable',
    });
    assert.equal(manifest.completed,'partial');
    assert.equal(manifest.count,1);
    assert.deepEqual(manifest.readCoverage,{
        errors:1,
        failures:[{
            code:'SOURCE_UNAVAILABLE',
            key:'beta',
            message:'The beta source is unavailable.',
            phase:'source-read',
        }],
        readable:1,
        total:2,
    });
    assert.equal(Object.isFrozen(manifest.readCoverage),true);
    assert.equal(Object.isFrozen(manifest.readCoverage.failures),true);

    const restored=createDBOPFSDocumentLibrary({db,schema:mappedSchema});
    const search=await restored.search('red fox');
    assert.equal(search.total,1);
    assert.equal(search.matches[0].id,'alpha');
    assert.deepEqual(search.failures,manifest.readCoverage.failures);

    const directDB=memoryDB();
    const direct=createDBOPFSDocumentLibrary({db:directDB,schema:mappedSchema});
    const directProgress=[];
    const directEvaluation=await direct.evaluate('fox',{
        maxCharacters:2048,
        maxCorpusCharacters:4096,
        maxDocumentCharacters:512,
        maxScoringCharacters:512,
        onProgress:value=>directProgress.push(value),
        read,
        readFailurePolicy:'preserve-readable',
        sources:descriptors,
    });
    assert.equal(directEvaluation.authority,'sources');
    assert.deepEqual(directEvaluation.coverage,{
        eligible:2,
        errors:1,
        filtered:0,
        included:1,
        matched:1,
        omitted:0,
        readable:1,
        total:2,
    });
    assert.equal(directEvaluation.documents[0].body,files[0].markdown);
    assert.equal(directEvaluation.documents[0].ordinal,0);
    assert.equal(directEvaluation.documents[0].kind,'document');
    assert.deepEqual(directEvaluation.documents[0].tags,[]);
    assert.deepEqual(directDB.operations,[]);
    assert.equal(directProgress[0].phase,'preparing');
    assert.ok(directProgress.some(value=>value.phase==='reading'));
    assert.equal(directProgress.at(-1).phase,'complete');

    await assert.rejects(
        restored.bootstrap({
            files:[descriptors[1]],
            read,
            readFailurePolicy:'preserve-readable',
        }),
        error=>error?.code==='DBOPFS_DOCUMENT_READ_FAILED'
            &&error.failures.length===1,
    );
    assert.equal(
        (await db.get('document_library_manifests','documents--boss-library.json')).generation,
        manifest.generation,
    );

});

test('DBOPFS document evaluation ranks complete source authority into bounded truthful excerpts',async()=>{
    const db=memoryDB();
    const library=createDBOPFSDocumentLibrary({db,schema:mappedSchema});
    const bodies=new Map();
    const sources=Array.from({length:125},(_,index)=>{
        const suffix=String(index).padStart(3,'0');
        const id=`document-${suffix}`;
        bodies.set(
            id,
            index===124?`Complete unrelated body ${suffix}.`:`Complete evidence body ${suffix}.`,
        );
        return {
            documentId:id,
            name:index===124?`Unrelated ${suffix}`:`Evidence ${suffix}`,
            sourcePath:`source-records/${id}`,
        };
    }).reverse();
    const read=async source=>bodies.get(source.documentId);

    const complete=await library.evaluate('  evidence  ',{
        maxCharacters:65536,
        maxCorpusCharacters:65536,
        maxDocumentCharacters:64,
        maxScoringCharacters:8,
        read,
        readFailurePolicy:'preserve-readable',
        sources,
    });
    assert.equal(complete.authority,'sources');
    assert.equal(complete.query,'  evidence  ');
    assert.equal(complete.documents.length,125);
    assert.equal(complete.documents[0].id,'document-123');
    assert.equal(complete.documents.at(-1).id,'document-124');
    assert.deepEqual(complete.coverage,{
        eligible:125,
        errors:0,
        filtered:0,
        included:125,
        matched:124,
        omitted:0,
        readable:125,
        total:125,
    });
    assert.deepEqual(complete.limits,{
        maxCharacters:65536,
        maxCorpusCharacters:65536,
        maxDocumentCharacters:64,
        maxScoringCharacters:8,
    });
    assert.equal(complete.truncated,false);
    assert.ok(Object.isFrozen(complete)&&Object.isFrozen(complete.coverage)
        &&Object.isFrozen(complete.documents));
    assert.equal(complete.documents[0].ordinal,1);
    assert.equal(complete.documents[0].kind,'document');
    assert.deepEqual(complete.documents[0].tags,[]);
    assert.equal(complete.documents[0].sourcePath,'source-records/document-123');
    assert.equal(complete.documents[0].body,'Complete evidence body 123.');
    assert.equal(complete.documents[0].scoredCharacters,8);
    assert.equal(complete.documents[0].scoreTruncated,true);
    assert.equal(complete.scoringTruncated,true);
    assert.match(complete.text,/Complete unrelated body 124[.]/u);
    assert.deepEqual(db.operations,[]);

    const filteredReads=[];
    const selected=await library.evaluate('evidence',{
        kinds:['authority'],
        maxCharacters:2048,
        maxCorpusCharacters:4096,
        maxDocumentCharacters:64,
        maxScoringCharacters:64,
        read:async(source,bounds)=>{
            filteredReads.push({bounds,source});
            if(source.documentId!=='selected') throw new Error('excluded source was read');
            return 'Selected evidence body.';
        },
        sources:[
            {documentId:'wrong-kind',kind:'description',labels:['review'],name:'Wrong kind'},
            {documentId:'wrong-tag',kind:'authority',labels:['other'],name:'Wrong tag'},
            {documentId:'selected',kind:'authority',labels:['review'],name:'Selected'},
        ],
        tags:['review'],
    });
    assert.equal(filteredReads.length,1);
    assert.equal(filteredReads[0].source.documentId,'selected');
    assert.equal(filteredReads[0].bounds.ordinal,2);
    assert.equal(filteredReads[0].bounds.maxCorpusCharacters,4096);
    assert.ok(filteredReads[0].bounds.maxCharacters>0);
    assert.equal(Object.isFrozen(filteredReads[0].bounds),true);
    assert.equal(selected.documents[0].ordinal,2);
    assert.deepEqual(selected.coverage,{
        eligible:1,
        errors:0,
        filtered:2,
        included:1,
        matched:1,
        omitted:0,
        readable:1,
        total:3,
    });

    const budgeted=await library.evaluate('evidence',{
        maxCharacters:512,
        maxCorpusCharacters:65536,
        maxDocumentCharacters:64,
        maxScoringCharacters:8,
        read,
        readFailurePolicy:'preserve-readable',
        sources,
    });
    assert.ok(budgeted.documents.length>0);
    assert.ok(budgeted.documents.length<sources.length);
    assert.ok(budgeted.characters<=512);
    assert.equal(budgeted.coverage.omitted,sources.length-budgeted.documents.length);
    assert.equal(budgeted.truncated,true);
    assert.ok(budgeted.documents.every(document=>document.body.length<=64));
    for(const document of budgeted.documents){
        assert.ok(budgeted.text.includes(document.body));
        if(!document.truncated) assert.equal(document.body,bodies.get(document.id));
    }

    const boundedExcerpts=await library.evaluate('evidence',{
        maxCharacters:2048,
        maxCorpusCharacters:65536,
        maxDocumentCharacters:8,
        maxScoringCharacters:18,
        read,
        readFailurePolicy:'preserve-readable',
        sources,
    });
    assert.ok(boundedExcerpts.documents.length>0);
    assert.ok(boundedExcerpts.documents.every(document=>document.body.length<=8));
    assert.ok(boundedExcerpts.documents.every(document=>document.scoredCharacters===18));
    assert.ok(boundedExcerpts.documents.every(document=>document.truncated===true));
    assert.equal(boundedExcerpts.truncated,true);

    let drainReads;
    let drained=0;
    let releaseReads;
    let started=0;
    const readsStarted=new Promise(resolve=>{drainReads=resolve;});
    const readGate=new Promise(resolve=>{releaseReads=resolve;});
    const boundedMovement=library.evaluate('',{
        maxCharacters:2048,
        maxCorpusCharacters:4096,
        maxDocumentCharacters:64,
        maxScoringCharacters:64,
        read:async(_source,bounds)=>{
            started++;
            if(started===4) drainReads();
            await readGate;
            drained++;
            return 'x'.repeat(Math.min(1024,bounds.maxCharacters));
        },
        sources:Array.from({length:8},(_,index)=>({
            documentId:`movement-${index}`,
            name:`Movement ${index}`,
        })),
    });
    await readsStarted;
    releaseReads();
    await assert.rejects(
        boundedMovement,
        error=>error?.code==='DBOPFS_DOCUMENT_LIMIT',
    );
    assert.equal(started,4);
    assert.equal(drained,4);

    await assert.rejects(library.evaluate('evidence',{
        maxCharacters:2048,maxCorpusCharacters:4096,maxScoringCharacters:64,read,
        sources:[{...sources[0],markdown:'inline bodies are not source descriptors'}],
    }),error=>error?.code==='DBOPFS_DOCUMENT_INVALID');
    await assert.rejects(library.evaluate('',{
        maxCharacters:2048,maxCorpusCharacters:4096,maxDocumentCharacters:64,
        maxScoringCharacters:64,
        read:async(source,bounds)=>{
            if(source.documentId==='read-failure') throw new Error('synthetic read failure');
            return 'x'.repeat(bounds.maxCharacters+1);
        },
        sources:[
            {documentId:'over-limit',name:'Over limit'},
            {documentId:'read-failure',name:'Read failure'},
        ],
    }),error=>error?.code==='DBOPFS_DOCUMENT_LIMIT');
    const readAbort=new AbortController();
    await assert.rejects(library.evaluate('',{
        maxCharacters:2048,maxCorpusCharacters:4096,maxDocumentCharacters:64,
        maxScoringCharacters:64,
        onProgress:value=>{
            if(value.phase==='reading'&&value.completed===1) readAbort.abort();
        },
        read:async(_source,bounds)=>'x'.repeat(bounds.maxCharacters+1),
        signal:readAbort.signal,
        sources:[{documentId:'abort-over-limit',name:'Abort over limit'}],
    }),error=>error?.code==='DBOPFS_DOCUMENT_ABORTED');
    await assert.rejects(
        library.evaluate('evidence'),
        error=>error?.code==='DBOPFS_DOCUMENT_INVALID_LIMIT',
    );
});

test('DBOPFS document evaluation yields during preparation, ranking, and assembly cancellation',async()=>{
    const library=createDBOPFSDocumentLibrary({db:memoryDB(),schema:mappedSchema});
    const sources=Array.from({length:130},(_,index)=>({
        documentId:`cancel-${String(index).padStart(3,'0')}`,
        name:`Cancellation evidence ${index}`,
    }));
    for(const phase of ['preparing','ranking','assembling']){
        const controller=new AbortController();
        let reads=0;
        let scheduled=false;
        const operation=library.evaluate('evidence',{
            maxCharacters:65536,
            maxCorpusCharacters:65536,
            maxDocumentCharacters:64,
            maxScoringCharacters:64,
            onProgress:value=>{
                if(value.phase!==phase||value.completed!==64||scheduled) return;
                scheduled=true;
                globalThis.queueMicrotask(()=>controller.abort());
            },
            read:async source=>{reads++;return `Evidence body for ${source.documentId}.`;},
            signal:controller.signal,
            sources,
        });
        await assert.rejects(operation,error=>error?.code==='DBOPFS_DOCUMENT_ABORTED');
        assert.equal(scheduled,true);
        if(phase==='preparing') assert.equal(reads,0);
        else assert.equal(reads,sources.length);
    }
});

test('aborted bootstrap drains active writes before generation rollback',async()=>{
    let releaseWrite;
    let reportStarted;
    const started=new Promise(resolve=>{reportStarted=resolve;});
    const gate=new Promise(resolve=>{releaseWrite=resolve;});
    const db=memoryDB({setHook:async({tableName})=>{
        if(tableName!=='documents') return;
        reportStarted();
        await gate;
    }});
    const library=createDBOPFSDocumentLibrary({concurrency:2,db,schema:mappedSchema});
    const controller=new AbortController();
    const operation=library.bootstrap({files,signal:controller.signal});
    await started;
    controller.abort();
    releaseWrite();
    await assert.rejects(operation,error=>error?.code==='DBOPFS_DOCUMENT_ABORTED');
    assert.deepEqual(db.keys('documents'),[]);
    assert.deepEqual(db.keys('document_library_manifests'),[]);
});

test('document searches retry a generation replaced after manifest capture',async()=>{
    const db=memoryDB();
    const library=createDBOPFSDocumentLibrary({db,schema:mappedSchema});
    await library.bootstrap({files:[files[0]]});

    const originalGet=db.get.bind(db);
    let releaseRead;
    let reportRead;
    const readStarted=new Promise(resolve=>{reportRead=resolve;});
    const gate=new Promise(resolve=>{releaseRead=resolve;});
    let blocked=true;
    db.get=async(tableName,key,...rest)=>{
        if(blocked&&tableName==='documents'){
            blocked=false;
            reportRead();
            await gate;
        }
        return originalGet(tableName,key,...rest);
    };

    const search=library.search('blue whale');
    await readStarted;
    await library.bootstrap({files:[files[1]]});
    releaseRead();
    const result=await search;
    assert.equal(result.matches[0].id,'beta');
});

test('failed and cancelled DBOPFS bootstraps never publish a completion manifest',async()=>{
    const failingDB=memoryDB({rejectId:'beta'});
    const library=createDBOPFSDocumentLibrary({db:failingDB,schema:mappedSchema});
    await assert.rejects(
        library.bootstrap({files}),
        error=>error?.code==='DBOPFS_DOCUMENT_BOOTSTRAP_FAILED'
            &&error.failures.length===1,
    );
    assert.equal(
        await failingDB.get('document_library_manifests','documents--boss-library.json'),
        null,
    );

    const controller=new AbortController();
    controller.abort();
    await assert.rejects(
        library.bootstrap({files,signal:controller.signal}),
        error=>error?.code==='DBOPFS_DOCUMENT_ABORTED',
    );

    const replacementDB=memoryDB();
    const replacing=createDBOPFSDocumentLibrary({db:replacementDB,schema:mappedSchema});
    const admitted=await replacing.bootstrap({files:[files[0]]});
    replacementDB.rejectWritesFor('beta');
    await assert.rejects(
        replacing.bootstrap({files}),
        error=>error?.code==='DBOPFS_DOCUMENT_BOOTSTRAP_FAILED',
    );
    assert.equal(
        (await replacementDB.get('document_library_manifests','documents--boss-library.json')).generation,
        admitted.generation,
    );
    assert.equal((await replacing.search('red fox')).matches[0].id,'alpha');

    const cleanupDB=memoryDB();
    const cleanupLibrary=createDBOPFSDocumentLibrary({db:cleanupDB,schema:{...mappedSchema,id:'cleanup-library'}});
    const prior=await cleanupLibrary.bootstrap({files:[files[0]]});
    cleanupDB.rejectDeletesForPrefix(prior.keys[0]);
    const cleanupProgress=[];
    const active=await cleanupLibrary.bootstrap({
        files:[files[1]],
        onProgress:value=>cleanupProgress.push(value),
    });
    assert.notEqual(active.generation,prior.generation);
    assert.equal((await cleanupLibrary.search('blue whale')).matches[0].id,'beta');
    assert.equal(cleanupProgress.at(-1).cleanupFailures,1);
});

test('document bootstrap rejects schema drift and bounds aggregate corpus and search work',async()=>{
    const db=memoryDB();
    const library=createDBOPFSDocumentLibrary({
        db,
        maxCorpusCharacters:1024,
        maxDocumentCharacters:512,
        maxSearchCharacters:128,
        schema:mappedSchema,
    });
    await assert.rejects(
        library.bootstrap({files:[{...files[0],unexpected:true}]}),
        error=>error?.code==='DBOPFS_DOCUMENT_INVALID',
    );
    await library.bootstrap({files:[{...files[0],markdown:'fox '.repeat(80)}]});
    await assert.rejects(
        library.search('fox'),
        error=>error?.code==='DBOPFS_DOCUMENT_LIMIT',
    );

    const bounded=createDBOPFSDocumentLibrary({
        db:memoryDB(),
        maxCorpusCharacters:512,
        maxDocumentCharacters:256,
        maxSearchCharacters:512,
        schema:{...mappedSchema,id:'bounded-library'},
    });
    await assert.rejects(
        bounded.bootstrap({files:[
            {...files[0],markdown:'a'.repeat(240)},
            {...files[1],markdown:'b'.repeat(240)},
        ]}),
        error=>error?.code==='DBOPFS_DOCUMENT_LIMIT',
    );

    const ranked=createDBOPFSDocumentLibrary({
        db:memoryDB(),
        maxCorpusCharacters:262144,
        maxDocumentCharacters:512,
        maxSearchCharacters:262144,
        schema:{...mappedSchema,id:'ranked-library'},
    });
    const metadata=Array.from({length:100},(_,index)=>({
        documentId:`a-${String(index).padStart(3,'0')}`,
        markdown:'unrelated',
        name:`A ${index}`,
        summary:'alpha beta',
    }));
    await ranked.bootstrap({files:[...metadata,{
        documentId:'z-body',
        markdown:'alpha',
        name:'Z body',
        summary:'alpha beta',
    }]});
    assert.equal((await ranked.search('alpha beta')).matches[0].id,'z-body');
});
