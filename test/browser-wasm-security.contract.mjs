import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

import test from '../src/testing.mjs';
import {
    createModelController,
    normalizeModelSecurity,
    resolveModelSecurity,
    sameModelSecurity
} from '../browser-runtime/ai/model-controller.mjs';
import {
    adaptV1LlmProvider,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from '../browser-runtime/ai/browser-wasm-llm-provider.mjs';

function missingEntry(name){
    return Object.assign(new Error(`Missing ${name}.`),{name:'NotFoundError'});
}

function observedDirectory(){
    const entries=new Map();
    let modelReadPasses=0;
    const table=Object.freeze({
        async getFileHandle(name,{create=false}={}){
            if(!entries.has(name)&&!create)throw missingEntry(name);
            if(!entries.has(name))entries.set(name,new Uint8Array());
            return Object.freeze({
                async getFile(){
                    const bytes=entries.get(name);
                    if(name.endsWith('.json'))return new Blob([bytes]);
                    return Object.freeze({
                        size:bytes.byteLength,
                        stream(){
                            modelReadPasses+=1;
                            return new Blob([bytes]).stream();
                        }
                    });
                },
                async createWritable(){
                    const chunks=[];
                    return Object.freeze({
                        async write(value){
                            if(typeof value==='string'){
                                chunks.push(new TextEncoder().encode(value));
                            }else if(ArrayBuffer.isView(value)){
                                chunks.push(new Uint8Array(
                                    value.buffer,
                                    value.byteOffset,
                                    value.byteLength
                                ).slice());
                            }else if(value instanceof ArrayBuffer){
                                chunks.push(new Uint8Array(value).slice());
                            }else{
                                throw new TypeError('Unsupported in-memory OPFS write.');
                            }
                        },
                        async close(){
                            const length=chunks.reduce(
                                (total,chunk)=>total+chunk.byteLength,
                                0
                            );
                            const bytes=new Uint8Array(length);
                            let offset=0;
                            for(const chunk of chunks){
                                bytes.set(chunk,offset);
                                offset+=chunk.byteLength;
                            }
                            entries.set(name,bytes);
                        },
                        async abort(){}
                    });
                }
            });
        },
        async removeEntry(name){
            if(!entries.delete(name))throw missingEntry(name);
        }
    });
    return Object.freeze({
        table,
        modelReadPasses:()=>modelReadPasses,
        names:()=>[...entries.keys()],
        seed(name,value){
            entries.set(name,value instanceof Uint8Array
                ?value.slice()
                :new TextEncoder().encode(String(value)));
        },
    });
}

function storeFor(directory,options={}){
    return createDbopfsModelStore({
        dbopfs:{
            readyPromise:Promise.resolve(),
            async getTableHandle(){return directory.table;}
        },
        ...options
    });
}

test('browser-WASM security resolves omitted fields without coercing them to false',()=>{
    assert.deepEqual(resolveModelSecurity(),{
        secure:false,
        checks:{byteLength:false,sha256:false}
    });
    assert.deepEqual(resolveModelSecurity({app:{secure:true}}),{
        secure:true,
        checks:{byteLength:true,sha256:true}
    });
    assert.deepEqual(resolveModelSecurity({
        app:{secure:true},
        binding:{secure:false}
    }),{
        secure:false,
        checks:{byteLength:false,sha256:false}
    });
    assert.deepEqual(resolveModelSecurity({
        app:{checks:{sha256:true}},
        load:{secure:false}
    }),{
        secure:false,
        checks:{byteLength:false,sha256:true}
    });
    assert.deepEqual(resolveModelSecurity({
        binding:{checks:{byteLength:false}},
        load:{secure:true}
    }),{
        secure:true,
        checks:{byteLength:false,sha256:true}
    });
    assert.deepEqual(resolveModelSecurity({
        app:{secure:true},
        binding:{checks:{}},
        load:{checks:{}}
    }),{
        secure:true,
        checks:{byteLength:true,sha256:true}
    });
    assert.deepEqual(resolveModelSecurity({
        app:{checks:{sha256:true}},
        binding:{checks:{}},
        load:{checks:{sha256:false}}
    }),{
        secure:false,
        checks:{byteLength:false,sha256:false}
    });
    const explicitFalse=normalizeModelSecurity({secure:false,checks:{byteLength:false}});
    assert.equal(Object.hasOwn(explicitFalse,'secure'),true);
    assert.equal(Object.hasOwn(explicitFalse.checks,'byteLength'),true);
    assert.equal(sameModelSecurity(
        resolveModelSecurity({app:{secure:true}}),
        resolveModelSecurity({app:{secure:false,checks:{byteLength:true,sha256:true}}})
    ),true);
});

test('a ready controller preserves the operation policy that actually loaded the model',async()=>{
    let state='unloaded';
    let activeSecurity=null;
    let loadCalls=0;
    let chatCalls=0;
    const provider={
        protocol:'arcane-ai-adapter/1',
        capabilities:()=>({localOnly:true}),
        status:()=>({state}),
        async load(options={},context={}){
            const next=resolveModelSecurity({
                app:context.security,
                load:options.security
            });
            if(state==='ready'&&!sameModelSecurity(activeSecurity,next)){
                throw Object.assign(new Error('reload required'),{
                    code:'ARCANE_AI_SECURITY_RELOAD_REQUIRED'
                });
            }
            loadCalls+=1;
            activeSecurity=next;
            state='ready';
        },
        async chat(){
            chatCalls+=1;
            return {choices:[{index:0,message:{role:'assistant',content:'ready'}}]};
        },
        async unload(){state='unloaded';}
    };
    const controller=createModelController({
        provider,
        loadPolicy:'manual',
        security:{secure:true}
    });

    await controller.load({security:{secure:false}});
    assert.deepEqual(activeSecurity,{
        secure:false,
        checks:{byteLength:false,sha256:false}
    });
    await controller.chat({messages:[]});
    assert.equal(loadCalls,1);
    assert.equal(chatCalls,1);
    await assert.rejects(
        controller.load({security:{secure:true}}),
        error=>error?.code==='ARCANE_AI_SECURITY_RELOAD_REQUIRED'
    );
});

test('disabled model checks record observed bytes without expected-size rejection or SHA reads',async()=>{
    const directory=observedDirectory();
    const store=storeFor(directory);
    const actual=Uint8Array.of(1,2,3);
    let fetches=0;
    const source=createBrowserModelSource({
        id:'unchecked-model',
        files:[{
            url:'https://example.invalid/models/0123456789abcdef/unchecked.gguf',
            bytes:99,
            sha256:'0'.repeat(64)
        }]
    },{
        fetchImpl:async()=>{
            fetches+=1;
            return new Response(actual,{
                status:200,
                headers:{'content-length':String(actual.byteLength)}
            });
        }
    });

    assert.deepEqual(source.descriptor,{
        id:'unchecked-model',
        files:[{
            name:'unchecked.gguf',
            url:'https://example.invalid/models/0123456789abcdef/unchecked.gguf',
            bytes:99
        }]
    });
    const installed=await store.ensure(source);
    assert.equal(installed.observedBytes,actual.byteLength);
    assert.equal(installed.integrity.state,'unchecked');
    assert.equal(installed.integrity.byteLength.state,'unchecked');
    assert.equal(installed.integrity.sha256.state,'unchecked');
    assert.equal(directory.modelReadPasses(),0);

    const cached=await store.ensure(source,{offline:true});
    assert.equal(cached.cache,'cached');
    assert.equal(cached.observedBytes,actual.byteLength);
    assert.equal(cached.integrity.state,'unchecked');
    assert.equal(directory.modelReadPasses(),0);
    assert.equal(fetches,1);
});

test('the default unchecked policy accepts the minimal canonical descriptor',async()=>{
    const directory=observedDirectory();
    const source=createBrowserModelSource({
        id:'minimal-model',
        files:[{
            url:'https://example.invalid/models/0123456789abcdef/minimal.gguf'
        }]
    },{fetchImpl:async()=>new Response(Uint8Array.of(4,5))});

    assert.deepEqual(source.descriptor,{
        id:'minimal-model',
        files:[{
            name:'minimal.gguf',
            url:'https://example.invalid/models/0123456789abcdef/minimal.gguf'
        }]
    });
    const installed=await storeFor(directory).ensure(source);
    assert.equal(installed.observedBytes,2);
    assert.equal(installed.integrity.state,'unchecked');
    assert.equal(directory.modelReadPasses(),0);
});

test('enabled checks require and enforce only their corresponding descriptor fields',async()=>{
    const directory=observedDirectory();
    const store=storeFor(directory);
    let fetches=0;
    const missing=createBrowserModelSource({
        id:'missing-authority',
        files:[{
            url:'https://example.invalid/models/0123456789abcdef/missing.gguf'
        }]
    },{fetchImpl:async()=>{fetches+=1;return new Response(Uint8Array.of(1));}});
    await assert.rejects(
        store.ensure(missing,{security:{checks:{byteLength:true}}}),
        /bytes is required/u
    );
    await assert.rejects(
        store.ensure(missing,{security:{checks:{sha256:true}}}),
        /sha256 is required/u
    );
    assert.equal(fetches,0);

    const mismatched=createBrowserModelSource({
        id:'length-mismatch',
        files:[{
            url:'https://example.invalid/models/0123456789abcdef/mismatch.gguf',
            bytes:4
        }]
    },{
        fetchImpl:async()=>new Response(Uint8Array.of(1,2,3),{
            status:200,
            headers:{'content-length':'3'}
        })
    });
    await assert.rejects(
        store.ensure(mismatched,{security:{checks:{byteLength:true}}}),
        error=>error?.code==='ARCANE_AI_MODEL_SIZE_MISMATCH'
    );
});

test('ordered model files require canonical descriptors and reject ambiguous members',()=>{
    const files=[
        {
            name:'model-00001-of-00002.gguf',
            url:'https://example.invalid/models/0123456789abcdef/model-00001-of-00002.gguf',
            bytes:2,
            sha256:'1'.repeat(64)
        },
        {
            name:'model-00002-of-00002.gguf',
            url:'https://example.invalid/models/0123456789abcdef/model-00002-of-00002.gguf',
            bytes:3,
            sha256:'2'.repeat(64)
        }
    ];
    const split=createBrowserModelSource({id:'split-model',files});
    assert.deepEqual(split.descriptor,{id:'split-model',files});

    assert.throws(()=>createBrowserModelSource({
        id:'ambiguous-model',
        url:'https://example.invalid/models/0123456789abcdef/model.gguf',
        files
    }),/must be declared in files/u);
    assert.throws(()=>createBrowserModelSource({
        id:'missing-files',
        url:'https://example.invalid/models/0123456789abcdef/model.gguf'
    }),/must be declared in files/u);
    assert.throws(()=>createBrowserModelSource({
        id:'removed-file-alias',
        files:[{
            name:'model.gguf',
            immutableUrl:'https://example.invalid/models/0123456789abcdef/model.gguf'
        }]
    }),/must use url/u);
    assert.throws(()=>createBrowserModelSource({
        id:'duplicate-name',
        files:[files[0],{...files[1],name:'MODEL-00001-OF-00002.GGUF'}]
    }),/names must be unique/u);
    assert.throws(()=>createBrowserModelSource({
        id:'duplicate-url',
        files:[files[0],{...files[1],url:files[0].url}]
    }),/URLs must be unique/u);
    assert.throws(()=>createBrowserModelSource({
        id:'unsafe-name',
        files:[{...files[0],name:'../model.gguf'}]
    }),/safe single filenames/u);
    assert.throws(()=>createBrowserModelSource({
        id:'lone-high-\ud800',
        files:[files[0]]
    }),/Unicode scalar values/u);
    assert.throws(()=>createBrowserModelSource({
        id:'lone-high-\ud801',
        files:[files[0]]
    }),/Unicode scalar values/u);
    assert.throws(()=>createBrowserModelSource({
        id:'non-nfc-e\u0301',
        files:[files[0]]
    }),/Unicode NFC normalization/u);
});

test('ordered model files retain descriptor order and cache their complete set',async()=>{
    const directory=observedDirectory();
    const downloads=[];
    let estimates=0;
    const bodies=new Map([
        ['model-00001-of-00002.gguf',Uint8Array.of(1,2)],
        ['model-00002-of-00002.gguf',Uint8Array.of(3,4,5)]
    ]);
    const source=createBrowserModelSource({
        id:'split-admission',
        files:[...bodies].map(([name,body])=>({
            name,
            url:`https://example.invalid/models/0123456789abcdef/${name}`,
            bytes:body.byteLength
        }))
    },{
        fetchImpl:async url=>{
            const name=new URL(url).pathname.split('/').pop();
            downloads.push(name);
            const body=bodies.get(name);
            return new Response(body,{
                status:200,
                headers:{'content-length':String(body.byteLength)}
            });
        }
    });
    const store=storeFor(directory,{
        estimateStorage:async()=>{
            estimates+=1;
            return {quota:10_000,usage:10};
        }
    });

    await assert.rejects(
        store.ensure(source,{security:{secure:true}}),
        /sha256 is required/u
    );
    assert.deepEqual(downloads,[]);
    const installed=await store.ensure(source,{
        security:{secure:true,checks:{sha256:false}}
    });
    assert.deepEqual(downloads,[...bodies.keys()]);
    assert.equal(installed.files.length,2);
    assert.equal(installed.observedBytes,5);
    assert.equal(installed.integrity.byteLength.state,'verified');
    assert.equal(installed.integrity.sha256.state,'unchecked');
    assert.equal(estimates,1);

    const cached=await store.ensure(source,{
        offline:true,
        security:{secure:true,checks:{sha256:false}}
    });
    assert.equal(cached.cache,'cached');
    assert.equal(cached.files.length,2);
    assert.deepEqual(downloads,[...bodies.keys()]);
    assert.equal(estimates,1);
});

test('catalog compatibility records measured storage failure before model download',async()=>{
    const directory=observedDirectory();
    let downloads=0;
    const source=createBrowserModelSource({
        id:'storage-limited-model',
        files:[
            {
                name:'model-00001-of-00002.gguf',
                url:'https://example.invalid/models/0123456789abcdef/model-00001-of-00002.gguf',
                bytes:2
            },
            {
                name:'model-00002-of-00002.gguf',
                url:'https://example.invalid/models/0123456789abcdef/model-00002-of-00002.gguf',
                bytes:3
            }
        ]
    },{
        fetchImpl:async()=>{
            downloads+=1;
            return new Response(Uint8Array.of(1));
        }
    });
    const store=storeFor(directory,{
        estimateStorage:async()=>({quota:5,usage:0})
    });
    const provider=createBrowserWasmLlmProvider({sources:[source],store});
    await assert.rejects(
        provider.load({security:{checks:{byteLength:true}}}),
        error=>error?.code==='ARCANE_AI_STORAGE_CAPACITY_INSUFFICIENT'
    );
    assert.equal(downloads,0);
    const [model]=provider.catalog();
    assert.equal(model.id,'storage-limited-model');
    assert.equal(model.compatibility,'incompatible');
    assert.equal(model.compatibilityDetails.protocol,'arcane-ai-browser-capability-policy/1');
    assert.equal(model.compatibilityDetails.model.fileCount,2);
    assert.equal(model.compatibilityDetails.model.declaredBytes,5);
    assert.equal(model.compatibilityDetails.storage.payloadBytes,5);
    assert.equal(model.compatibilityDetails.storage.requiredBytes>5,true);
    assert.equal(Object.isFrozen(model.compatibilityDetails),true);
    assert.equal(model.compatibilityDetails.reasons.some(
        reason=>reason.code==='ARCANE_AI_STORAGE_CAPACITY_INSUFFICIENT'
    ),true);
});

test('secure download hashes each member while writing and rejects tamper without rereading',async()=>{
    const actual=Uint8Array.of(9,8,7,6);
    const digest=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',actual));
    const sha256=Array.from(digest,value=>value.toString(16).padStart(2,'0')).join('');
    const admittedDirectory=observedDirectory();
    const admittedSource=createBrowserModelSource({
        id:'streaming-digest',
        files:[{
            name:'streaming.gguf',
            url:'https://example.invalid/models/0123456789abcdef/streaming.gguf',
            bytes:actual.byteLength,
            sha256
        }]
    },{fetchImpl:async()=>new Response(actual)});
    const admitted=await storeFor(admittedDirectory).ensure(admittedSource,{
        security:{secure:true}
    });
    assert.equal(admitted.integrity.state,'verified');
    assert.equal(admitted.integrity.files[0].sha256.actual,sha256);
    assert.equal(admittedDirectory.modelReadPasses(),0);

    const tamperedDirectory=observedDirectory();
    const tamperedSource=createBrowserModelSource({
        id:'streaming-tamper',
        files:[{
            name:'tampered.gguf',
            url:'https://example.invalid/models/0123456789abcdef/tampered.gguf',
            bytes:actual.byteLength,
            sha256:'0'.repeat(64)
        }]
    },{fetchImpl:async()=>new Response(actual)});
    await assert.rejects(
        storeFor(tamperedDirectory).ensure(tamperedSource,{security:{secure:true}}),
        error=>error?.code==='ARCANE_AI_MODEL_DIGEST_MISMATCH'
    );
    assert.equal(tamperedDirectory.modelReadPasses(),0);
});

test('injective model storage ids cannot collide after lossy filename normalization',async()=>{
    const directory=observedDirectory();
    const descriptors=[
        {id:'model/a',name:'first.gguf'},
        {id:'model_a',name:'second.gguf'}
    ];
    for(const descriptor of descriptors){
        const source=createBrowserModelSource({
            id:descriptor.id,
            files:[{
                url:`https://example.invalid/models/0123456789abcdef/${descriptor.name}`
            }]
        },{fetchImpl:async()=>new Response(Uint8Array.of(1))});
        await storeFor(directory).ensure(source);
    }
    const storedModels=directory.names().filter(name=>name.endsWith('.gguf'));
    assert.equal(storedModels.length,2);
    assert.notEqual(storedModels[0],storedModels[1]);
    assert.equal(storedModels.every(name=>/^id-[a-f0-9]+--(?:first|second)\.gguf$/u.test(name)),true);
});

test('unchecked declared bytes stay unknown until observed model files are admitted',async()=>{
    const directory=observedDirectory();
    const policies=[];
    let estimates=0;
    const source=createBrowserModelSource({
        id:'unchecked-storage',
        files:[{
            url:'https://example.invalid/models/0123456789abcdef/unchecked-storage.gguf',
            bytes:1
        }]
    },{fetchImpl:async()=>new Response(Uint8Array.of(1,2,3))});
    const installed=await storeFor(directory,{
        estimateStorage:async()=>{
            estimates+=1;
            return {quota:1,usage:0};
        }
    }).ensure(source,{onCapabilityPolicy:policy=>policies.push(policy)});
    assert.equal(estimates,0);
    assert.equal(policies[0].compatibility,'unknown');
    assert.equal(policies[0].code,'ARCANE_AI_MODEL_STORAGE_REQUIREMENT_UNBOUNDED');
    assert.equal(policies[0].requiredBytes,null);
    assert.equal(policies[1].compatibility,'compatible');
    assert.equal(policies[1].code,'ARCANE_AI_MODEL_CACHE_COMPLETE');
    assert.equal(policies[1].payloadBytes,3);
    assert.equal(policies[1].requiredBytes>policies[1].payloadBytes,true);
    assert.equal(installed.storage,policies[1]);
});

test('one provider catalogs caller models and v2 selection fails closed for oversized shards',async()=>{
    const directory=observedDirectory();
    const primary=createBrowserModelSource({
        id:'catalog-primary',
        files:[{
            url:'https://example.invalid/models/0123456789abcdef/primary.gguf',
            bytes:1
        }]
    });
    const oversized=createBrowserModelSource({
        id:'catalog-oversized',
        files:[{
            name:'oversized.gguf',
            url:'https://example.invalid/models/0123456789abcdef/oversized.gguf',
            bytes:2_000_000_001
        }]
    });
    const provider=createBrowserWasmLlmProvider({
        sources:[primary,oversized],
        store:storeFor(directory)
    });
    const catalog=provider.catalog();
    assert.deepEqual(catalog.map(model=>model.id),['catalog-primary','catalog-oversized']);
    assert.equal(catalog[1].compatibility,'incompatible');
    assert.equal(catalog[1].compatibilityDetails.reasons.some(
        reason=>reason.code==='ARCANE_AI_MODEL_SHARD_TOO_LARGE'
    ),true);
    const runtimeProvider=adaptV1LlmProvider(provider);
    await assert.rejects(runtimeProvider.load({
        selection:{
            providerId:'arcane-browser-wasm-wllama',
            modelId:'catalog-oversized',
            localOnly:true
        }
    }),error=>error?.code==='ARCANE_AI_MODEL_SHARD_TOO_LARGE');
    await assert.rejects(runtimeProvider.load({
        selection:{
            providerId:'arcane-browser-wasm-wllama',
            modelId:'not-in-catalog',
            localOnly:true
        }
    }),error=>error?.code==='ARCANE_AI_MODEL_AUTHORITY_REQUIRED');
});

test('provider source preserves ordered File handoff and exact load-plan reuse checks',async()=>{
    const providerSource=await readFile(new URL(
        '../browser-runtime/ai/browser-wasm-llm-provider.mjs',
        import.meta.url
    ),'utf8');
    assert.match(providerSource,/const modelFiles = admitted\.files\.map/u);
    assert.match(providerSource,/await runtime\.load\(modelFiles,/u);
    assert.match(providerSource,/sameLoadPlan\(activeLoadPlan, requestedLoadPlan\)/u);
});
