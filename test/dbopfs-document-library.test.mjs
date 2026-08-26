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

    const search=await library.search('blue whale',{limit:1});
    assert.equal(search.matches.length,1);
    assert.equal(search.matches[0].id,'beta');
    assert.ok(search.matches[0].matchedFields.includes('body'));

    const context=await library.buildContext('red fox',{limit:1,maxCharacters:2048});
    assert.match(context.text,/UNTRUSTED DBOPFS DOCUMENT CONTEXT/u);
    assert.match(context.text,/red fox/u);
    const contextBuilder=library.createContextBuilder({limit:1,maxCharacters:2048});
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
    cleanupDB.rejectDeletesForPrefix(`cleanup-library--${prior.generation}--`);
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
    assert.equal((await ranked.search('alpha beta',{limit:1})).matches[0].id,'z-body');
});
