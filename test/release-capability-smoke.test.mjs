import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import test from '../src/testing.mjs';
import {createModelController} from '../browser-runtime/ai/model-controller.mjs';
import {
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from '../browser-runtime/ai/browser-wasm-llm-provider.mjs';
import {verifyNpmReleaseArtifact} from '../tools/npm-release-contract.mjs';
import {runCommand,runNode,temporaryDirectory} from './helpers.mjs';

const FORBIDDEN_PACKED_ASSET_EXTENSION=
    /\.(?:gguf|ggml|safetensors|onnx|ort|tflite|mlmodel|pb|pt|pth|bin|data|exe|dll|so|dylib|node|a|lib|wav|flac|mp3|ogg|opus)$/iu;
const PACKED_WASM_ALLOWLIST=Object.freeze([
    'browser-runtime/ai/wllama/wllama.wasm'
]);
const sourceTest=process.env.ARCANE_SDK_EXACT_ARTIFACT_REQUIRED==='true'
    ?()=>undefined
    :test;

function deferred(){
    let resolve;
    let reject;
    const promise=new Promise((resolvePromise,rejectPromise)=>{
        resolve=resolvePromise;
        reject=rejectPromise;
    });
    return Object.freeze({promise,resolve,reject});
}

function errorWithCode(code){
    return error=>{
        assert.equal(error?.code,code);
        return true;
    };
}

function missingEntry(name){
    return Object.assign(new Error(`Missing ${name}.`),{name:'NotFoundError'});
}

function memoryDirectory(){
    const entries=new Map();
    return Object.freeze({
        async getFileHandle(name,{create=false}={}){
            if(!entries.has(name)&&!create) throw missingEntry(name);
            if(!entries.has(name)) entries.set(name,new Uint8Array());
            return Object.freeze({
                async getFile(){
                    return new Blob([entries.get(name)]);
                },
                async createWritable(){
                    const chunks=[];
                    return Object.freeze({
                        async write(value){
                            if(value instanceof Blob){
                                chunks.push(new Uint8Array(await value.arrayBuffer()));
                                return;
                            }
                            if(typeof value==='string'){
                                chunks.push(new TextEncoder().encode(value));
                                return;
                            }
                            if(ArrayBuffer.isView(value)){
                                chunks.push(new Uint8Array(
                                    value.buffer,
                                    value.byteOffset,
                                    value.byteLength
                                ).slice());
                                return;
                            }
                            if(value instanceof ArrayBuffer){
                                chunks.push(new Uint8Array(value).slice());
                                return;
                            }
                            throw new TypeError('Unsupported in-memory OPFS write.');
                        },
                        async close(){
                            const length=chunks.reduce((total,chunk)=>total+chunk.byteLength,0);
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
            if(!entries.delete(name)) throw missingEntry(name);
        }
    });
}

function modelAuthority({id='release-regression',byte=42}={}){
    const bytes=Uint8Array.of(byte);
    return Object.freeze({
        descriptor:Object.freeze({
            id,
            url:`https://example.invalid/models/0123456789abcdef/${id}.gguf`,
            bytes:bytes.byteLength,
            sha256:createHash('sha256').update(bytes).digest('hex')
        }),
        bytes
    });
}

function genuineSourceAndStore(api,{id='release-regression',byte=42}={}){
    const authority=modelAuthority({id,byte});
    const source=api.createBrowserModelSource(authority.descriptor,{
        fetchImpl:async()=>new Response(authority.bytes,{status:200})
    });
    const directory=memoryDirectory();
    const store=api.createDbopfsModelStore({
        dbopfs:{
            readyPromise:Promise.resolve(),
            async getTableHandle(){return directory;}
        },
        tableName:`${id}-models`
    });
    return Object.freeze({source,store});
}

function runNpm(arguments_,options){
    if(process.platform==='win32'){
        const npmCli=process.env.npm_execpath??path.join(
            path.dirname(process.execPath),
            'node_modules','npm','bin','npm-cli.js'
        );
        return runNode([npmCli,...arguments_],options);
    }
    return runCommand('npm',arguments_,options);
}

sourceTest('model controller supersedes late loads and treats unload as a request barrier',async()=>{
    {
        const unloadStarted=deferred();
        const releaseUnload=deferred();
        let state='ready';
        let loadCalls=0;
        let chatCalls=0;
        let unloadCalls=0;
        const provider={
            protocol:'arcane-ai-adapter/1',
            status:()=>({state}),
            capabilities:()=>({localOnly:true}),
            async load(){loadCalls+=1;},
            async chat(){chatCalls+=1;return {};},
            async unload(){
                unloadCalls+=1;
                unloadStarted.resolve();
                await releaseUnload.promise;
                state='unloaded';
            }
        };
        const controller=createModelController({provider,loadPolicy:'manual'});
        const unloading=controller.unload();
        await unloadStarted.promise;
        assert.equal(controller.status().state,'ready');
        await assert.rejects(
            controller.load(),
            errorWithCode('ARCANE_AI_OPERATION_SUPERSEDED')
        );
        await assert.rejects(
            controller.chat({messages:[]}),
            errorWithCode('ARCANE_AI_OPERATION_SUPERSEDED')
        );
        assert.equal(loadCalls,0);
        assert.equal(chatCalls,0);
        releaseUnload.resolve();
        await unloading;
        assert.equal(unloadCalls,1);
        assert.equal(controller.status().state,'unloaded');
    }

    {
        const loadStarted=deferred();
        const releaseLoad=deferred();
        const firstUnload=deferred();
        let state='unloaded';
        let loadCalls=0;
        let unloadCalls=0;
        const provider={
            protocol:'arcane-ai-adapter/1',
            status:()=>({state}),
            capabilities:()=>({localOnly:true}),
            async load(){
                loadCalls+=1;
                state='loading';
                loadStarted.resolve();
                await releaseLoad.promise;
                state='ready';
            },
            async unload(){
                unloadCalls+=1;
                state='unloaded';
                if(unloadCalls===1) firstUnload.resolve();
            }
        };
        const controller=createModelController({provider,loadPolicy:'manual'});
        const loading=controller.load();
        await loadStarted.promise;
        const unloading=controller.unload();
        await firstUnload.promise;
        await assert.rejects(
            controller.load(),
            errorWithCode('ARCANE_AI_OPERATION_SUPERSEDED')
        );
        assert.equal(loadCalls,1);
        releaseLoad.resolve();
        await Promise.all([loading,unloading]);
        assert.equal(unloadCalls,2);
        assert.equal(state,'unloaded');
        assert.equal(controller.status().state,'unloaded');
    }
});

sourceTest('model controller disposal supersedes a load and is an immediate barrier',async()=>{
    const loadStarted=deferred();
    const releaseLoad=deferred();
    let state='unloaded';
    let loadCalls=0;
    let unloadCalls=0;
    let disposeCalls=0;
    const provider={
        protocol:'arcane-ai-adapter/1',
        status:()=>({state}),
        capabilities:()=>({localOnly:true}),
        async load(){
            loadCalls+=1;
            state='loading';
            loadStarted.resolve();
            await releaseLoad.promise;
            state='ready';
        },
        async unload(){
            unloadCalls+=1;
            state='unloaded';
        },
        async dispose(){disposeCalls+=1;}
    };
    const controller=createModelController({provider,loadPolicy:'manual'});
    const loading=controller.load();
    await loadStarted.promise;
    const disposal=controller.dispose();
    await assert.rejects(controller.load(),errorWithCode('ARCANE_AI_DISPOSED'));
    assert.equal(loadCalls,1);
    releaseLoad.resolve();
    await Promise.all([loading,disposal]);
    assert.equal(unloadCalls,2);
    assert.equal(disposeCalls,1);
    assert.equal(state,'unloaded');
    assert.equal(controller.status().state,'unloaded');
    await assert.rejects(controller.load(),errorWithCode('ARCANE_AI_DISPOSED'));
});

sourceTest('model controller retries disposal after provider cleanup fails',async()=>{
    const failedUnloadStarted=deferred();
    const releaseFailedUnload=deferred();
    let state='ready';
    let loadCalls=0;
    let unloadCalls=0;
    let disposeCalls=0;
    const provider={
        protocol:'arcane-ai-adapter/1',
        status:()=>({state}),
        capabilities:()=>({localOnly:true}),
        async load(){loadCalls+=1;},
        async unload(){
            unloadCalls+=1;
            if(unloadCalls===1){
                failedUnloadStarted.resolve();
                await releaseFailedUnload.promise;
                throw new Error('synthetic controller cleanup failure');
            }
            state='unloaded';
        },
        async dispose(){disposeCalls+=1;}
    };
    const controller=createModelController({provider,loadPolicy:'manual'});
    const firstDisposal=controller.dispose();
    await failedUnloadStarted.promise;
    await assert.rejects(controller.load(),errorWithCode('ARCANE_AI_DISPOSED'));
    assert.equal(loadCalls,0);
    releaseFailedUnload.resolve();
    await assert.rejects(firstDisposal,/synthetic controller cleanup failure/u);
    await controller.dispose();
    assert.equal(unloadCalls,2);
    assert.equal(disposeCalls,1);
    assert.equal(controller.status().state,'unloaded');
    await assert.rejects(controller.load(),errorWithCode('ARCANE_AI_DISPOSED'));
});

sourceTest('browser-WASM provider admits only module-branded model sources and stores',()=>{
    const {source,store}=genuineSourceAndStore({
        createBrowserModelSource,
        createDbopfsModelStore
    },{id:'brand-regression'});
    const sourceLookalike=Object.freeze({...source});
    const storeLookalike=Object.freeze({...store});

    assert.throws(
        ()=>createBrowserWasmLlmProvider({source:sourceLookalike,store}),
        /requires createBrowserModelSource\(\)/u
    );
    assert.throws(
        ()=>createBrowserWasmLlmProvider({source,store:storeLookalike}),
        /requires createDbopfsModelStore\(\)/u
    );
    const provider=createBrowserWasmLlmProvider({source,store});
    assert.equal(provider.status().state,'unloaded');
    assert.equal(provider.model.id,'brand-regression');
    assert.equal(source.kind,'arcane-browser-model-source');
    assert.deepEqual(Object.keys(source.descriptor),['id','url','bytes','sha256']);
    assert.deepEqual(provider.status().security,{
        secure:false,
        checks:{byteLength:false,sha256:false}
    });
    assert.equal(provider.status().integrity.state,'unchecked');
});

sourceTest('browser-WASM provider serializes unload and retries failed disposal cleanup',async t=>{
    const temporary=await temporaryDirectory(t,{prefix:'arcane-provider-lifecycle-'});
    const internal=path.join(temporary,'internal');
    await mkdir(internal);
    await copyFile(
        path.resolve('browser-runtime/ai/browser-wasm-llm-provider.mjs'),
        path.join(temporary,'browser-wasm-llm-provider.mjs')
    );
    await copyFile(
        path.resolve('browser-runtime/ai/model-controller.mjs'),
        path.join(temporary,'model-controller.mjs')
    );
    await copyFile(
        path.resolve('browser-runtime/ai/internal/sha256.mjs'),
        path.join(internal,'sha256.mjs')
    );

    const stateKey=`__arcaneProviderLifecycle${Date.now()}${Math.random()}`;
    const runtimeState={instances:[]};
    globalThis[stateKey]=runtimeState;
    t.after(()=>{delete globalThis[stateKey];});
    await writeFile(path.join(temporary,'browser-wllama-runtime.mjs'),`
const state=globalThis[${JSON.stringify(stateKey)}];
export function createPackagedWllamaRuntime(){
    const instance={loaded:false,workers:0,exitCalls:0,exitBehavior:null};
    state.instances.push(instance);
    return Object.freeze({
        authority:Object.freeze({protocol:'test-runtime/1'}),
        capabilities:()=>Object.freeze({
            webAssembly:true,opfs:true,webgpu:false,crossOriginIsolated:false,
            secureContext:true,hardwareConcurrency:1
        }),
        async load(){instance.loaded=true;instance.workers=1;return {loaded:true};},
        async chat(){return {choices:[]};},
        async stream(){return {choices:[]};},
        async probe(){return {};},
        async exit(){
            instance.exitCalls+=1;
            if(!instance.loaded) return false;
            const behavior=instance.exitBehavior;
            if(behavior){
                behavior.started.resolve();
                await behavior.release.promise;
                instance.exitBehavior=null;
                if(behavior.reject) throw new Error('synthetic provider cleanup failure');
            }
            instance.loaded=false;
            instance.workers=0;
            return true;
        },
        isLoaded:()=>instance.loaded,
        isLoading:()=>false
    });
}
`);
    const temporaryModule=await import(`${pathToFileURL(
        path.join(temporary,'browser-wasm-llm-provider.mjs')
    ).href}?case=${Date.now()}`);
    const api={
        createBrowserModelSource:temporaryModule.createBrowserModelSource,
        createDbopfsModelStore:temporaryModule.createDbopfsModelStore
    };

    const first=genuineSourceAndStore(api,{id:'provider-unload-regression',byte:1});
    const firstProvider=temporaryModule.createBrowserWasmLlmProvider(first);
    await firstProvider.load();
    const firstRuntime=runtimeState.instances[0];
    assert.equal(firstRuntime.workers,1);
    const unloadStarted=deferred();
    const releaseUnload=deferred();
    firstRuntime.exitBehavior={started:unloadStarted,release:releaseUnload,reject:false};
    const unloading=firstProvider.unload();
    await unloadStarted.promise;
    await assert.rejects(
        firstProvider.load(),
        errorWithCode('ARCANE_AI_OPERATION_SUPERSEDED')
    );
    releaseUnload.resolve();
    await unloading;
    assert.equal(firstRuntime.workers,0);
    assert.equal(firstProvider.status().state,'unloaded');
    assert.equal(firstProvider.status().loaded,false);

    const second=genuineSourceAndStore(api,{id:'provider-dispose-regression',byte:2});
    const secondProvider=temporaryModule.createBrowserWasmLlmProvider(second);
    await secondProvider.load();
    const secondRuntime=runtimeState.instances[1];
    assert.equal(secondRuntime.workers,1);
    const failedExitStarted=deferred();
    const releaseFailedExit=deferred();
    secondRuntime.exitBehavior={
        started:failedExitStarted,
        release:releaseFailedExit,
        reject:true
    };
    const firstDisposal=secondProvider.dispose();
    await failedExitStarted.promise;
    await assert.rejects(secondProvider.load(),errorWithCode('ARCANE_AI_DISPOSED'));
    releaseFailedExit.resolve();
    await assert.rejects(firstDisposal,/synthetic provider cleanup failure/u);
    assert.equal(secondRuntime.workers,1);
    await secondProvider.dispose();
    assert.equal(secondRuntime.workers,0);
    assert.equal(secondProvider.status().state,'unloaded');
    await assert.rejects(secondProvider.load(),errorWithCode('ARCANE_AI_DISPOSED'));
});

sourceTest('packaged Wllama runtime retains and retries failed session exits',async t=>{
    const temporary=await temporaryDirectory(t,{prefix:'arcane-wllama-exit-'});
    const wllamaDirectory=path.join(temporary,'wllama');
    await mkdir(wllamaDirectory);
    await copyFile(
        path.resolve('browser-runtime/ai/browser-wllama-runtime.mjs'),
        path.join(temporary,'browser-wllama-runtime.mjs')
    );
    await writeFile(path.join(wllamaDirectory,'wllama.wasm'),Uint8Array.of(0,97,115,109));

    const stateKey=`__arcaneWllamaExit${Date.now()}${Math.random()}`;
    const runtimeState={failNextLoad:true,sessions:[]};
    globalThis[stateKey]=runtimeState;
    t.after(()=>{delete globalThis[stateKey];});
    await writeFile(path.join(wllamaDirectory,'index.mjs'),`
const state=globalThis[${JSON.stringify(stateKey)}];
export class Wllama{
    constructor(paths){
        this.paths=paths;
        this.proxy=null;
        this.loaded=false;
        this.exitCalls=0;
        state.sessions.push(this);
    }
    setCompat(value){this.compat=value;}
    getWorkerResources(){return {compat:false,wasmPath:this.paths.default,jsPath:null};}
    async loadModel(){
        if(state.failNextLoad){
            state.failNextLoad=false;
            throw new Error('synthetic Wllama load failure');
        }
        this.loaded=true;
    }
    getModelMetadata(){return {fixture:true};}
    isModelLoaded(){return this.loaded;}
    async exit(){
        this.exitCalls+=1;
        if(this.exitCalls===1) throw new Error('synthetic Wllama exit failure');
        this.loaded=false;
    }
}
`);
    const {createPackagedWllamaRuntime}=await import(`${pathToFileURL(
        path.join(temporary,'browser-wllama-runtime.mjs')
    ).href}?case=${Date.now()}`);
    const file=new Blob([Uint8Array.of(1)]);

    const failedLoadRuntime=createPackagedWllamaRuntime({logger:{}});
    await assert.rejects(
        failedLoadRuntime.load([file]),
        /synthetic Wllama load failure/u
    );
    assert.equal(runtimeState.sessions[0].exitCalls,1);
    assert.equal(failedLoadRuntime.isLoading(),true);
    await assert.rejects(
        failedLoadRuntime.load([file]),
        /already loaded or loading/u
    );
    await failedLoadRuntime.exit();
    assert.equal(runtimeState.sessions[0].exitCalls,2);
    assert.equal(failedLoadRuntime.isLoading(),false);

    const loadedRuntime=createPackagedWllamaRuntime({logger:{}});
    await loadedRuntime.load([file]);
    assert.equal(loadedRuntime.isLoaded(),true);
    await assert.rejects(loadedRuntime.exit(),/synthetic Wllama exit failure/u);
    assert.equal(loadedRuntime.isLoaded(),true);
    await loadedRuntime.exit();
    assert.equal(runtimeState.sessions[1].exitCalls,2);
    assert.equal(loadedRuntime.isLoaded(),false);
});

test('the exact npm artifact exposes the supported installed capability contract',{
    timeout:180_000
},async t=>{
    const metadataPath=process.env.ARCANE_SDK_NPM_RELEASE_METADATA;
    if(!metadataPath){
        assert.notEqual(process.env.ARCANE_SDK_EXACT_ARTIFACT_REQUIRED,'true');
        return;
    }

    assert.equal(process.env.ARCANE_SDK_EXACT_ARTIFACT_REQUIRED,'true');
    assert.equal(process.platform,process.env.ARCANE_SDK_EXPECTED_PLATFORM);
    assert.equal(process.arch,process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE);

    const verified=await verifyNpmReleaseArtifact({
        metadataPath,
        requireCleanSource:true
    });
    if(process.env.GITHUB_SHA){
        assert.equal(verified.manifest.source.commit,process.env.GITHUB_SHA);
    }
    const packedPaths=verified.manifest.package.files.map(file=>file.path);
    assert.deepEqual(
        packedPaths.filter(file=>FORBIDDEN_PACKED_ASSET_EXTENSION.test(file)),
        [],
        'The exact npm artifact contains model, native, or speech payload bytes.'
    );
    assert.deepEqual(
        packedPaths.filter(file=>file.toLowerCase().endsWith('.wasm')).sort(),
        PACKED_WASM_ALLOWLIST,
        'The exact npm artifact contains an unadmitted WASM asset.'
    );

    const temporary=await temporaryDirectory(t,{prefix:'arcane-release-smoke-'});
    const consumerRoot=path.join(temporary,'consumer');
    await mkdir(consumerRoot);
    await writeFile(path.join(consumerRoot,'package.json'),`${JSON.stringify({
        name:'arcane-release-capability-smoke',
        private:true,
        type:'module'
    },null,2)}\n`);

    const installed=await runNpm([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        verified.tarballPath
    ],{cwd:consumerRoot,timeout:90_000});
    assert.equal(installed.code,0,installed.stderr);

    const installedRoot=path.join(consumerRoot,'node_modules','arcane-os');
    const installedPackage=JSON.parse(await readFile(
        path.join(installedRoot,'package.json'),
        'utf8'
    ));
    assert.equal(installedPackage.name,verified.manifest.name);
    assert.equal(installedPackage.version,verified.manifest.version);
    const browserRuntimeReceipt=JSON.parse(await readFile(
        path.join(installedRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json'),
        'utf8'
    ));
    assert.equal(browserRuntimeReceipt.sdkVersion,verified.manifest.version);
    assert.equal(browserRuntimeReceipt.source.authority,'arcane-os-sdk');
    const browserAiComponents=JSON.parse(await readFile(
        path.join(
            installedRoot,'browser-runtime','ai','ARCANE_AI_BROWSER_WASM_COMPONENTS.json'
        ),
        'utf8'
    ));
    assert.equal(browserAiComponents.packageExport,'arcane-os/ai/browser-wasm');
    assert.equal(
        browserAiComponents.runtimePolicy.modelAuthorities,
        'fieldwise-security-default-false-with-optional-byteLength-and-sha256-checks'
    );
    assert.equal(browserAiComponents.runtimePolicy.modelWeightsPacked,false);
    assert.equal(browserAiComponents.runtimePolicy.remoteModelHelpers,false);
    assert.equal(browserAiComponents.runtimePolicy.toolCalls,'structural-only-never-executed');
    const componentFiles=browserAiComponents.components.flatMap(component=>component.files);
    for(const file of componentFiles){
        const bytes=await readFile(path.join(installedRoot,'browser-runtime',...file.path.split('/')));
        assert.equal(bytes.length,file.bytes,file.path);
        assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
    }
    const wasmBytes=await readFile(
        path.join(installedRoot,'browser-runtime','ai','wllama','wllama.wasm')
    );
    assert.deepEqual([...wasmBytes.subarray(0,4)],[0x00,0x61,0x73,0x6d]);

    const capabilityContract=path.join(consumerRoot,'installed-capability.test.mjs');
    await writeFile(capabilityContract,`import assert from 'node:assert/strict';
import {
    ARCANE_EVENT_STACK_PROTOCOL,
    SDK_VERSION,
    createEventManager,
    listTargets
} from 'arcane-os';
import runtimeRelease from 'arcane-os/runtime/manifest' with {type:'json'};
import test from 'arcane-os/testing';
import * as browserWasm from 'arcane-os/ai/browser-wasm';

test('installed public SDK capabilities are coherent',async()=>{
    assert.equal(SDK_VERSION,${JSON.stringify(verified.manifest.version)});
    assert.equal(runtimeRelease.sdkVersion,SDK_VERSION);
    assert.equal(runtimeRelease.source.protocol,'arcane/1');
    assert.ok(runtimeRelease.fileCount>0);

    const targets=listTargets();
    assert.equal(targets.find(target=>target.id==='browser')?.status,'available');
    assert.equal(targets.find(target=>target.id==='portable')?.status,'pairing-required');

    const manager=createEventManager({timeTravel:true,sessionId:'release-smoke'});
    let observed=null;
    manager.once('release.smoke',value=>{observed=value;});
    manager.emit('release.smoke',42);
    assert.equal(observed,42);
    assert.equal(manager.history[0]?.protocol,ARCANE_EVENT_STACK_PROTOCOL);

    assert.deepEqual(Object.keys(browserWasm).sort(),[
        'BROWSER_WASM_RUNTIME_AUTHORITY',
        'adaptV1LlmProvider',
        'createArcaneAI',
        'createBrowserModelSource',
        'createBrowserWasmLlmProvider',
        'createDbopfsModelStore'
    ]);
    const authority=browserWasm.BROWSER_WASM_RUNTIME_AUTHORITY;
    assert.equal(authority.protocol,'arcane-ai-browser-wasm/2');
    assert.deepEqual({
        name:authority.package.name,
        version:authority.package.version,
        sourceRevision:authority.package.sourceRevision,
        npmIntegrity:authority.package.npmIntegrity,
        licenseSpdx:authority.package.licenseSpdx
    },{
        name:'@wllama/wllama',
        version:'3.6.0',
        sourceRevision:'f16050d8d51a00602c6a2a6b8ac9c09f490eea7f',
        npmIntegrity:'sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w==',
        licenseSpdx:'MIT'
    });
    assert.equal(authority.llamaCpp.sourceRevision,'4df29be4f4c3673f428170fda944a5b19f743bb8');
    assert.equal(authority.runtimeAssets.module.bytes,389765);
    assert.equal(authority.runtimeAssets.module.sha256,'ae9a6ba2aa8687785ed651e28ef92573b409d5e6d3470bfd53340225287908b8');
    assert.equal(authority.runtimeAssets.wasm.bytes,8524865);
    assert.equal(authority.runtimeAssets.wasm.sha256,'95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6');
    assert.equal(authority.networkPolicy.remoteModelHelpers,false);

    let modelFetches=0;
    const source=browserWasm.createBrowserModelSource({
        id:'installed-smoke-model',
        url:'https://example.invalid/models/0123456789abcdef/installed-smoke.gguf',
        bytes:1,
        sha256:'${'0'.repeat(64)}'
    },{fetchImpl:async()=>{modelFetches+=1;throw new Error('network must remain idle');}});
    const directory={
        async getFileHandle(){throw Object.assign(new Error('missing'),{name:'NotFoundError'});},
        async removeEntry(){throw Object.assign(new Error('missing'),{name:'NotFoundError'});}
    };
    const store=browserWasm.createDbopfsModelStore({
        dbopfs:{readyPromise:Promise.resolve(),getTableHandle:async()=>directory}
    });
    await store.ready();
    const provider=browserWasm.createBrowserWasmLlmProvider({source,store});
    const provider2=browserWasm.adaptV1LlmProvider(provider);
    assert.equal(provider2.protocol,'arcane-ai-provider/2');
    assert.equal(provider2.role,'llm');
    assert.equal(provider2.localOnly,true);
    assert.equal(provider2.status().state,'unloaded');
    assert.equal(provider2.status().security.secure,false);
    assert.deepEqual(provider2.status().security.checks,{byteLength:false,sha256:false});
    assert.equal(provider2.status().integrity.state,'unchecked');
    assert.deepEqual(provider2.catalog().map(model=>model.id),['installed-smoke-model']);
    const ai=browserWasm.createArcaneAI({provider,loadPolicy:'manual'});
    assert.equal(ai.status().llm.state,'unloaded');
    assert.equal(ai.status().llm.capabilities.localOnly,true);
    assert.equal(ai.status().llm.runtime,authority);
    assert.equal(modelFetches,0);
});
`);

    const installedTestRunner=path.join(installedRoot,'bin','arcane-test.mjs');
    const contractResult=await runNode([installedTestRunner,capabilityContract],{
        cwd:consumerRoot,
        timeout:60_000
    });
    assert.equal(contractResult.code,0,contractResult.stderr);
    assert.match(contractResult.stdout,/Test Total : 1/u);
    assert.match(contractResult.stdout,/Passed :[^\r\n]*1/u);

    const cliResult=await runNpm(
        ['exec','--offline','--','arcane','--version'],
        {cwd:consumerRoot,timeout:30_000}
    );
    assert.equal(cliResult.code,0,cliResult.stderr);
    assert.equal(cliResult.stdout.trim(),verified.manifest.version);

    const after=await verifyNpmReleaseArtifact({
        metadataPath,
        tarballPath:verified.tarballPath,
        requireCleanSource:true
    });
    assert.deepEqual(after.manifest.artifact,verified.manifest.artifact);
});
