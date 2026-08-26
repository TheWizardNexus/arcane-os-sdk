import assert from 'node:assert/strict';

import test from '../src/testing.mjs';
import {
    createModelController,
    normalizeModelSecurity,
    resolveModelSecurity,
    sameModelSecurity
} from '../browser-runtime/ai/model-controller.mjs';
import {
    createBrowserModelSource,
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
        seed(name,value){
            entries.set(name,value instanceof Uint8Array
                ?value.slice()
                :new TextEncoder().encode(String(value)));
        },
        async completion(){
            const name=[...entries.keys()].find(value=>value.endsWith('.complete.json'));
            return name?JSON.parse(new TextDecoder().decode(entries.get(name))):null;
        }
    });
}

function storeFor(directory){
    return createDbopfsModelStore({
        dbopfs:{
            readyPromise:Promise.resolve(),
            async getTableHandle(){return directory.table;}
        }
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
        url:'https://example.invalid/models/0123456789abcdef/unchecked.gguf',
        bytes:99,
        sha256:'0'.repeat(64)
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
        url:'https://example.invalid/models/0123456789abcdef/unchecked.gguf',
        bytes:99,
        sha256:'0'.repeat(64)
    });
    const installed=await store.ensure(source);
    assert.equal(installed.observedBytes,actual.byteLength);
    assert.equal(installed.integrity.state,'unchecked');
    assert.equal(installed.integrity.byteLength.state,'unchecked');
    assert.equal(installed.integrity.sha256.state,'unchecked');
    assert.equal(directory.modelReadPasses(),0);
    assert.equal((await directory.completion()).observedBytes,actual.byteLength);

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
        url:'https://example.invalid/models/0123456789abcdef/minimal.gguf'
    },{fetchImpl:async()=>new Response(Uint8Array.of(4,5))});

    assert.deepEqual(source.descriptor,{
        id:'minimal-model',
        url:'https://example.invalid/models/0123456789abcdef/minimal.gguf'
    });
    const installed=await storeFor(directory).ensure(source);
    assert.equal(installed.observedBytes,2);
    assert.equal(installed.integrity.state,'unchecked');
    assert.equal((await directory.completion()).observedBytes,2);
    assert.equal(directory.modelReadPasses(),0);
});

test('enabled checks require and enforce only their corresponding descriptor fields',async()=>{
    const directory=observedDirectory();
    const store=storeFor(directory);
    let fetches=0;
    const missing=createBrowserModelSource({
        id:'missing-authority',
        url:'https://example.invalid/models/0123456789abcdef/missing.gguf'
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
        url:'https://example.invalid/models/0123456789abcdef/mismatch.gguf',
        bytes:4
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

test('disabled byte-length checking reuses legacy caches without rewriting them',async()=>{
    const directory=observedDirectory();
    const actual=Uint8Array.of(7,8,9);
    const url='https://example.invalid/models/0123456789abcdef/legacy.gguf';
    directory.seed('legacy-unchecked--legacy.gguf',actual);
    directory.seed('legacy-unchecked.complete.json',`${JSON.stringify({
        schema:'arcane.ai.browser-wasm.model.v2',
        complete:true,
        model:{
            id:'legacy-unchecked',
            name:'legacy.gguf',
            immutableUrl:url,
            bytes:99,
            sha256:'0'.repeat(64),
            licenseSpdx:'Apache-2.0',
            sourceRevision:'legacy-revision'
        },
        finalUrl:url
    })}\n`);
    const source=createBrowserModelSource({
        id:'legacy-unchecked',
        url,
        bytes:99,
        sha256:'0'.repeat(64)
    },{fetchImpl:async()=>{throw new Error('offline cache must not fetch');}});

    const cached=await storeFor(directory).ensure(source,{offline:true});
    assert.equal(cached.cache,'cached');
    assert.equal(cached.observedBytes,actual.byteLength);
    assert.equal(cached.integrity.state,'unchecked');
    assert.equal(directory.modelReadPasses(),0);
    const completion=await directory.completion();
    assert.equal(completion.schema,'arcane.ai.browser-wasm.model.v2');
    assert.equal(completion.observedBytes,undefined);
    assert.equal(completion.model.id,'legacy-unchecked');
    assert.equal(completion.model.immutableUrl,url);
});
