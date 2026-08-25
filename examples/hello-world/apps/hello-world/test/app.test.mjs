import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'arcane-os/testing';

const appRoot=new URL('../',import.meta.url);
const MODEL=Object.freeze({
    id:'ibm-granite-4.1-3b-q4-k-s',
    url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf',
    bytes:1_998_371_424,
    sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a'
});

async function runtimeRoot(){
    const physical=new URL('../../../arcane/',import.meta.url);
    await stat(new URL('modules/AppDataScope.js',physical));
    return physical;
}

function interactiveElement({textContent='',value='',disabled=false,hidden=false,max=0}={}){
    const listeners=new Map();
    const element={textContent,value,disabled,hidden,max};
    element.addEventListener=function addEventListener(type,listener){
        const values=listeners.get(type)??new Set();
        values.add(listener);
        listeners.set(type,values);
    };
    element.removeEventListener=function removeEventListener(type,listener){
        listeners.get(type)?.delete(listener);
    };
    element.trigger=async function trigger(type){
        const values=[...(listeners.get(type)??[])];
        assert.ok(values.length>0,`Missing ${type} listener.`);
        for(const listener of values){
            await listener.call(element,{type,target:element,currentTarget:element});
        }
    };
    return element;
}

function browserHarness(){
    const elements=new Map([
        ['#app-action',interactiveElement()],
        ['#app-status',interactiveElement({textContent:'Ready to say hello.'})],
        ['#ai-load',interactiveElement()],
        ['#ai-load-offline',interactiveElement()],
        ['#ai-unload',interactiveElement({disabled:true})],
        ['#ai-cancel',interactiveElement({disabled:true,hidden:true})],
        ['#ai-prompt',interactiveElement({
            value:'Say hello in one short sentence. If useful, propose the show_greeting tool.'
        })],
        ['#ai-send',interactiveElement({disabled:true})],
        ['#ai-status',interactiveElement({
            textContent:'Model not loaded. No model download has started.'
        })],
        ['#ai-lifecycle',interactiveElement({textContent:'Lifecycle: unloaded.'})],
        ['#ai-progress',interactiveElement({value:0,max:MODEL.bytes,hidden:true})],
        ['#ai-progress-label',interactiveElement()],
        ['#ai-response',interactiveElement({textContent:'Load the model to begin.'})],
        ['#ai-tool-calls',interactiveElement({
            textContent:'No tool calls proposed. Structural output is displayed only; the application invokes no tool.'
        })]
    ]);
    const values=new Map();
    const storage={
        getItem(key){ return values.has(key)?values.get(key):null; },
        setItem(key,value){ values.set(key,String(value)); },
        removeItem(key){ values.delete(key); }
    };
    const dataset={arcaneAppId:'hello-world'};
    const properties=new Map();
    const root={
        dataset,
        style:{
            fontSize:'',
            setProperty(name,value){ properties.set(name,value); },
            removeProperty(name){ properties.delete(name); }
        },
        removeAttribute(name){
            if(!name.startsWith('data-'))return;
            const key=name.slice(5).replace(/-([a-z])/gu,(_match,letter)=>letter.toUpperCase());
            delete dataset[key];
        }
    };
    const documentObject={
        documentElement:root,
        querySelector(selector){
            if(selector==='meta[name="arcane-app-id"]'){
                return {getAttribute:name=>name==='content'?'hello-world':null};
            }
            return elements.get(selector)??null;
        }
    };
    const pageListeners=new Map();
    function addPageListener(type,listener,options={}){
        const records=pageListeners.get(type)??new Set();
        records.add({listener,once:options?.once===true});
        pageListeners.set(type,records);
    }
    function removePageListener(type,listener){
        const records=pageListeners.get(type);
        for(const record of records??[]){
            if(record.listener===listener)records.delete(record);
        }
    }
    async function triggerPage(type){
        const records=[...(pageListeners.get(type)??[])];
        for(const record of records){
            record.listener({type,target:globalThis,currentTarget:globalThis});
            if(record.once)pageListeners.get(type)?.delete(record);
        }
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    return {
        addPageListener,
        documentObject,
        elements,
        removePageListener,
        storage,
        triggerPage,
        values
    };
}

function arcaneFailure(code,message='provider-private-message'){
    return Object.assign(new Error(message),{code});
}

function aiHarness(options={}){
    const behavior={
        deferRequest:options.deferRequest===true,
        offlineMiss:options.offlineMiss===true
    };
    const calls={
        createAI:[],
        dbopfs:[],
        dispose:0,
        load:[],
        modelSources:[],
        provider:[],
        requests:[],
        store:[],
        storeRemove:0,
        unload:0
    };
    const listeners=new Map();
    let state='unloaded';
    let cacheState='unknown';
    let progress=null;

    function flatStatus(){
        return Object.freeze({
            state,
            cache:Object.freeze({state:cacheState}),
            progress
        });
    }

    function emit(type){
        const event={type,detail:flatStatus()};
        for(const listener of [...(listeners.get(type)??[])]){
            listener(event);
        }
    }

    function report(phase,loaded){
        progress=Object.freeze({
            modelId:MODEL.id,
            phase,
            loaded,
            total:MODEL.bytes,
            percent:(loaded/MODEL.bytes)*100
        });
        emit('progress');
    }

    const facade={
        llm:{
            addEventListener(type,listener){
                const values=listeners.get(type)??new Set();
                values.add(listener);
                listeners.set(type,values);
            },
            removeEventListener(type,listener){ listeners.get(type)?.delete(listener); }
        },
        status(){ return Object.freeze({llm:flatStatus()}); },
        async load(loadOptions={}){
            calls.load.push(loadOptions);
            state='loading';
            progress=null;
            emit('statechange');
            if(loadOptions.offline===true){
                report('verify-cache',MODEL.bytes);
                if(behavior.offlineMiss){
                    state='error';
                    progress=null;
                    emit('statechange');
                    throw arcaneFailure(
                        'ARCANE_AI_MODEL_OFFLINE_MISS',
                        'PRIVATE OFFLINE PROVIDER DETAIL'
                    );
                }
                cacheState='cached';
            }else{
                report('download',Math.floor(MODEL.bytes/2));
                report('verify-download',MODEL.bytes);
                cacheState='installed';
            }
            report('initialize',MODEL.bytes);
            if(loadOptions.signal?.aborted){
                throw arcaneFailure('ARCANE_AI_REQUEST_ABORTED');
            }
            state='ready';
            progress=null;
            emit('statechange');
            return flatStatus();
        },
        async streamRequest(request){
            calls.requests.push(request);
            if(behavior.deferRequest){
                await new Promise((resolve,reject)=>{
                    const abort=()=>reject(arcaneFailure(
                        'ARCANE_AI_REQUEST_ABORTED',
                        'PRIVATE ABORT PROVIDER DETAIL'
                    ));
                    if(request.signal?.aborted)abort();
                    else request.signal?.addEventListener('abort',abort,{once:true});
                    calls.resolveRequest=resolve;
                });
            }
            if(request.signal?.aborted){
                throw arcaneFailure('ARCANE_AI_REQUEST_ABORTED');
            }
            request.onChunk?.('Hello locally.',`M-${request.id}`,false);
            request.onToolCall?.('show_greeting');
            return {show_greeting:'{"message":"Hello from Granite."}'};
        },
        async unload(){
            calls.unload+=1;
            state='unloaded';
            progress=null;
            emit('statechange');
            return flatStatus();
        },
        async dispose(){
            calls.dispose+=1;
            state='unloaded';
            progress=null;
            emit('statechange');
            return flatStatus();
        }
    };

    const store=Object.freeze({
        async remove(){ calls.storeRemove+=1; return true; }
    });

    return {
        behavior,
        calls,
        facade,
        createDbopfs(constructorOptions={}){
            const value={
                applicationId:constructorOptions.applicationId??'hello-world',
                readyPromise:Promise.resolve(),
                getTableHandle(){ return {}; }
            };
            calls.dbopfs.push({options:constructorOptions,value});
            return value;
        },
        createDbopfsModelStore(storeOptions){
            calls.store.push(storeOptions);
            return store;
        },
        createBrowserModelSource(descriptor){
            calls.modelSources.push(descriptor);
            return Object.freeze({descriptor});
        },
        createBrowserWasmLlmProvider(providerOptions){
            calls.provider.push(providerOptions);
            return Object.freeze({kind:'fake-browser-wasm-provider'});
        },
        createArcaneAI(createOptions){
            calls.createAI.push(createOptions);
            return facade;
        }
    };
}

function installGlobals(browser,aiRuntime){
    const names=[
        'document',
        'localStorage',
        'Arcane',
        'arcaneThemeReady',
        'arcaneThemeAppearanceListener',
        '__arcaneHelloWorldAIHarness',
        'dbopfs',
        'addEventListener',
        'removeEventListener'
    ];
    const previous=new Map(names.map(name=>[
        name,
        Object.getOwnPropertyDescriptor(globalThis,name)
    ]));
    for(const name of names)delete globalThis[name];
    Object.defineProperties(globalThis,{
        document:{value:browser.documentObject,writable:true,configurable:true},
        localStorage:{value:browser.storage,writable:true,configurable:true},
        __arcaneHelloWorldAIHarness:{value:aiRuntime,writable:true,configurable:true},
        addEventListener:{value:browser.addPageListener,writable:true,configurable:true},
        removeEventListener:{value:browser.removePageListener,writable:true,configurable:true}
    });
    return function restoreGlobals(){
        for(const name of names){
            const descriptor=previous.get(name);
            if(descriptor)Object.defineProperty(globalThis,name,descriptor);
            else delete globalThis[name];
        }
    };
}

async function runApplication(callback,{aiOptions={}}={}){
    const temporaryRoot=await mkdtemp(path.join(tmpdir(),'arcane-hello-world-test-'));
    const appModules=path.join(temporaryRoot,'apps','hello-world','modules');
    const fakeRoot=path.join(temporaryRoot,'fakes');
    const arcaneRoot=await runtimeRoot();
    await Promise.all([
        cp(fileURLToPath(new URL('modules/',appRoot)),appModules,{recursive:true}),
        cp(fileURLToPath(new URL('modules/',arcaneRoot)),path.join(temporaryRoot,'arcane','modules'),{
            recursive:true
        }),
        cp(fileURLToPath(new URL('entities/',arcaneRoot)),path.join(temporaryRoot,'arcane','entities'),{
            recursive:true
        })
    ]);
    await mkdir(fakeRoot,{recursive:true});
    await writeFile(path.join(fakeRoot,'dbopfs.mjs'),`
const harness=globalThis.__arcaneHelloWorldAIHarness;
class DBOPFS {
    constructor(options={}){ return harness.createDbopfs(options); }
}
if(!globalThis.dbopfs?.getTableHandle){ globalThis.dbopfs=new DBOPFS(); }
export default DBOPFS;
`,'utf8');
    await writeFile(path.join(fakeRoot,'browser-ai.mjs'),`
const harness=globalThis.__arcaneHelloWorldAIHarness;
export const createDbopfsModelStore=options=>harness.createDbopfsModelStore(options);
export const createBrowserModelSource=descriptor=>harness.createBrowserModelSource(descriptor);
export const createBrowserWasmLlmProvider=options=>harness.createBrowserWasmLlmProvider(options);
export const createArcaneAI=options=>harness.createArcaneAI(options);
`,'utf8');

    const appPath=path.join(appModules,'App.js');
    const namedTargets=new Map([
        [
            'arcane/ThemeBootstrap',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','ThemeBootstrap.js')).href
        ],
        [
            'arcane/AppDataScope',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','AppDataScope.js')).href
        ],
        ['arcane/DBOPFS',pathToFileURL(path.join(fakeRoot,'dbopfs.mjs')).href],
        ['arcane-os/ai/browser-wasm',pathToFileURL(path.join(fakeRoot,'browser-ai.mjs')).href]
    ]);
    const moduleHooks=registerHooks({
        resolve(specifier,context,nextResolve){
            const target=namedTargets.get(specifier);
            return target?{url:target,shortCircuit:true}:nextResolve(specifier,context);
        }
    });

    const browser=browserHarness();
    const aiRuntime=aiHarness(aiOptions);
    const restoreGlobals=installGlobals(browser,aiRuntime);
    try{
        await import(pathToFileURL(appPath).href);
        await new Promise(resolve=>setTimeout(resolve,0));
        return await callback({...browser,aiRuntime});
    }finally{
        restoreGlobals();
        moduleHooks.deregister();
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

async function waitFor(predicate,label){
    for(let attempt=0;attempt<50;attempt+=1){
        if(predicate())return;
        await new Promise(resolve=>setTimeout(resolve,0));
    }
    assert.fail(`Timed out waiting for ${label}.`);
}

test('application shell installs its managed import map before every module',async function verifyImportMapOrder(){
    const [source,mapSource]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/arcane.importmap.json',appRoot),'utf8')
    ]);
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/hello-world/hello-world.css');
    const base=source.indexOf('<base href="../../">');
    const importMap=source.indexOf('data-arcane-import-map');
    const appModule=source.indexOf('<script type="module"');
    const managed=source.match(
        /<script type="importmap" data-arcane-import-map>\s*([\s\S]*?)\s*<\/script>/u
    );
    const parsed=JSON.parse(mapSource);

    assert.match(source,/<meta name="arcane-app-id" content="hello-world">/u);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(base>=0&&importMap>base&&appModule>importMap);
    assert.ok(managed);
    assert.deepEqual(Object.keys(parsed),['imports']);
    assert.equal(Object.keys(parsed.imports).length,86);
    assert.equal(
        parsed.imports['arcane-os/ai/browser-wasm'],
        './arcane/sdk/ai/browser-wasm.mjs'
    );
    assert.deepEqual(JSON.parse(managed[1]),parsed);
    assert.equal(`${managed[1].trim()}\n`,mapSource);
    assert.doesNotMatch(source,/ThemeBootstrap[.]js[?]/u);
});

test('application package is browser-only with one explicit initial model origin',async function verifyPackageIdentity(){
    const [manifest,descriptor]=await Promise.all([
        readFile(new URL('arcane-package.json',appRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-app.json',appRoot),'utf8').then(JSON.parse)
    ]);
    assert.equal(manifest.id,'hello-world');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
    assert.equal(manifest.include.includes('img/icon.png'),false);
    assert.deepEqual(manifest.security.connectOrigins,['https://huggingface.co']);
    assert.deepEqual(descriptor.targets,['browser']);
    assert.deepEqual(descriptor.permissions,{capabilities:[],methods:[]});
    assert.deepEqual(descriptor.security.connectOrigins,['https://huggingface.co']);
    assert.equal(descriptor.native.icon,null);
});

test('workspace pins the published SDK and browser release workflow',async function verifyWorkspaceWorkflow(){
    const workspaceRoot=new URL('../../../',import.meta.url);
    const [packageJson,packageLock,lock,packager,readme]=await Promise.all([
        readFile(new URL('package.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('package-lock.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane.lock.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-packager.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('README.md',workspaceRoot),'utf8')
    ]);
    assert.equal(packageJson.devDependencies['arcane-os'],'0.1.2');
    assert.equal(packageJson.engines.node,'>=22.23.2');
    assert.equal(packageLock.packages[''].devDependencies['arcane-os'],'0.1.2');
    assert.equal(packageLock.packages['node_modules/arcane-os'].version,'0.1.2');
    assert.equal(
        packageLock.packages['node_modules/arcane-os'].integrity,
        'sha512-fzVbd01xwFVCHTN6k8x/xPK8xtPy5yCtSkzFLmr1jNVTUBHzmnubLK8a5pWSGH7IhsWce+/AFHOu/TnWSKwDsQ=='
    );
    assert.equal(lock.sdk.version,'0.1.2');
    assert.equal(lock.sdkBrowserRuntime.sdkVersion,'0.1.2');
    assert.equal(
        lock.sdkBrowserRuntime.contentSha256,
        '5e03f45a732db51cb5a2b2193cc79ecda34501d07a9b2e82e794e5fa37d55d00'
    );
    assert.deepEqual(
        Object.fromEntries([
            'import-map',
            'package',
            'verify',
            'bundle',
            'build',
            'run'
        ].map(name=>[name,packageJson.scripts[name]])),
        {
            'import-map':'arcane import-map',
            package:'arcane package',
            verify:'arcane verify',
            bundle:'arcane bundle',
            build:'arcane build --target browser',
            run:'arcane run --target browser'
        }
    );
    const runtimeRoutes=packager.sharedPayloads['browser-runtime'];
    assert.deepEqual(runtimeRoutes[0],{
        source:'arcane',
        destination:'arcane',
        include:['components','css','dependencies','entities','img','modules','sdk','security'],
        exclude:[]
    });
    assert.equal(
        runtimeRoutes.some(route=>route.destination==='node_modules/strong-type'),
        false
    );
    assert.match(readme,/173 files/u);
    assert.match(readme,/86 entries/u);
    assert.match(readme,/does not create a\s+standalone native executable/u);
    assert.match(readme,/no model download starts until a load button is chosen/u);
    assert.match(readme,/`load\(\{offline:true\}\)` makes no model-source request/u);
    assert.match(readme,/Packaged same-origin Wllama\/WASM\s+runtime assets may still load/u);
    assert.match(readme,/stable `ARCANE_AI_\*` and\s+`APP_DATA_\*` codes/u);
    assert.match(readme,/pinned model URL's initial Hugging Face origin/u);
    assert.match(readme,/provider-controlled HTTPS redirect\s+chain/u);
    assert.doesNotMatch(readme,/`load\(\{offline:true\}\)` never fetches|regional CDN hostname[^.]*in `security[.]connectOrigins`/iu);
    assert.doesNotMatch(readme,/--arcane-root|source sync|SDK update poll/iu);
});

test('application demonstrates direct named Arcane and browser-AI imports',async function verifyNamedImports(){
    const [html,script]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8')
    ]);
    assert.match(html,/Hello, Arcane World!/u);
    assert.match(html,/>Say hello<\/button>/u);
    assert.match(html,/Optional browser-local AI/u);
    assert.match(html,/No model download has started/u);
    assert.match(html,/no model download starts until you choose the network-permitted load button/u);
    assert.match(html,/1,998,371,424 bytes \(1[.]86 GiB\)/u);
    assert.match(html,/<h3>Proposed tool calls<\/h3>/u);
    assert.match(script,/from 'arcane\/ThemeBootstrap'/u);
    assert.match(script,/from 'arcane\/AppDataScope'/u);
    assert.match(script,/from 'arcane\/DBOPFS'/u);
    assert.match(script,/from 'arcane-os\/ai\/browser-wasm'/u);
    assert.match(script,/loadPolicy:'manual'/u);
    assert.match(script,/localOnly:true/u);
    assert.match(script,/toolChoice:'auto'/u);
    assert.match(script,/ARCANE_AI_MODEL_OFFLINE_MISS/u);
    assert.match(script,/without a model-source request/u);
    assert.match(script,/Packaged same-origin Wllama\/WASM assets may still load/u);
    assert.match(script,/Any verified cache remains; an interrupted model download is discarded/u);
    assert.match(script,/Proposed tool calls \(structural output only\)/u);
    assert.doesNotMatch(`${html}\n${script}`,/Tool-call receipt|never executed|executes tool calls/iu);
    assert.doesNotMatch(script,/ThemeBootstrap[.]js|AppDataScope[.]js|DBOPFS[.]js/u);
    assert.doesNotMatch(script,/toolHandlers|executeTools|Date[.]now|SDK update/iu);
});

test('browser mode persists a greeting without loading a model',async function verifyBrowserBehavior(){
    await runApplication(async({elements,values,aiRuntime})=>{
        const action=elements.get('#app-action');
        const status=elements.get('#app-status');

        assert.equal(aiRuntime.calls.load.length,0);
        assert.equal(aiRuntime.calls.requests.length,0);
        assert.equal(aiRuntime.calls.modelSources.length,0);
        await action.trigger('click');
        await action.trigger('click');
        assert.equal(values.get('arcane.apps.hello-world:hello-count'),'2');
        assert.equal(status.textContent,'Hello from Arcane OS! Greeting 2.');
        assert.equal(aiRuntime.calls.load.length,0);
    });
});

test('online load authenticates the exact model and request stays local',async function verifyLocalAI(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load').trigger('click');

        assert.deepEqual(aiRuntime.calls.modelSources,[MODEL]);
        assert.equal(aiRuntime.calls.store.length,1);
        assert.equal(aiRuntime.calls.store[0].dbopfs.applicationId,'hello-world');
        assert.equal(aiRuntime.calls.createAI.length,1);
        assert.equal(aiRuntime.calls.createAI[0].loadPolicy,'manual');
        assert.deepEqual(aiRuntime.calls.createAI[0].security,{secure:true});
        assert.deepEqual(aiRuntime.calls.provider[0].loadDefaults,{
            contextTokens:1024,
            threads:1,
            batchTokens:256,
            microBatchTokens:64,
            gpuLayers:0
        });
        assert.equal(aiRuntime.calls.load.length,1);
        assert.equal(aiRuntime.calls.load[0].offline,false);
        assert.ok(aiRuntime.calls.load[0].signal instanceof AbortSignal);
        assert.equal(elements.get('#ai-progress').value,MODEL.bytes);
        assert.match(elements.get('#ai-status').textContent,/SHA-256 verified/u);

        await elements.get('#ai-send').trigger('click');
        assert.equal(aiRuntime.calls.requests.length,1);
        const request=aiRuntime.calls.requests[0];
        assert.equal(request.id,'hello-world-1');
        assert.equal(request.localOnly,true);
        assert.ok(request.signal instanceof AbortSignal);
        assert.equal(request.tools.length,1);
        assert.equal(request.tools[0].function.name,'show_greeting');
        assert.equal('toolHandlers' in request,false);
        assert.equal('executeTools' in request,false);
        assert.equal(elements.get('#ai-response').textContent,'Hello locally.');
        assert.match(elements.get('#ai-tool-calls').textContent,/Proposed tool calls \(structural output only\)/u);
        assert.match(elements.get('#ai-tool-calls').textContent,/show_greeting/u);
        assert.match(elements.get('#ai-tool-calls').textContent,/Hello from Granite/u);
        assert.equal(aiRuntime.calls.storeRemove,0);
    });
});

test('offline load reuses a verified cache without a model-source request',async function verifyOfflineLoad(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load-offline').trigger('click');
        assert.equal(aiRuntime.calls.load.length,1);
        assert.equal(aiRuntime.calls.load[0].offline,true);
        assert.match(elements.get('#ai-status').textContent,/without a model-source request/u);
        assert.equal(aiRuntime.calls.storeRemove,0);
    });
});

test('offline miss renders stable copy without leaking provider detail',async function verifyOfflineMiss(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load-offline').trigger('click');
        const rendered=elements.get('#ai-status').textContent;
        assert.match(rendered,/ARCANE_AI_MODEL_OFFLINE_MISS/u);
        assert.match(rendered,/No verified offline model cache is available/u);
        assert.doesNotMatch(rendered,/PRIVATE OFFLINE PROVIDER DETAIL/u);
        assert.equal(aiRuntime.calls.storeRemove,0);
    },{aiOptions:{offlineMiss:true}});
});

test('cancel aborts a pending local request with stable copy',async function verifyCancellation(){
    await runApplication(async({elements,aiRuntime})=>{
        await elements.get('#ai-load').trigger('click');
        aiRuntime.behavior.deferRequest=true;
        const requestOperation=elements.get('#ai-send').trigger('click');
        await waitFor(()=>aiRuntime.calls.requests.length===1,'pending AI request');
        const signal=aiRuntime.calls.requests[0].signal;
        assert.equal(signal.aborted,false);
        await elements.get('#ai-cancel').trigger('click');
        await requestOperation;
        assert.equal(signal.aborted,true);
        const rendered=elements.get('#ai-status').textContent;
        assert.match(rendered,/ARCANE_AI_REQUEST_ABORTED/u);
        assert.match(rendered,/Any verified cache remains/u);
        assert.match(rendered,/interrupted model download is discarded/u);
        assert.doesNotMatch(rendered,/partial bytes were removed/u);
        assert.doesNotMatch(rendered,/PRIVATE ABORT PROVIDER DETAIL/u);
    });
});

test('unload and page exit release runtime state but never delete cache',async function verifyLifecycle(){
    await runApplication(async({elements,aiRuntime,triggerPage})=>{
        await elements.get('#ai-load').trigger('click');
        await elements.get('#ai-unload').trigger('click');
        assert.equal(aiRuntime.calls.unload,1);
        assert.match(elements.get('#ai-status').textContent,/verified DBOPFS cache remains/u);
        assert.equal(aiRuntime.calls.storeRemove,0);

        await elements.get('#ai-load').trigger('click');
        aiRuntime.behavior.deferRequest=true;
        const requestOperation=elements.get('#ai-send').trigger('click');
        await waitFor(()=>aiRuntime.calls.requests.length===1,'page-exit AI request');
        const signal=aiRuntime.calls.requests[0].signal;
        await triggerPage('pagehide');
        await requestOperation;
        await waitFor(()=>aiRuntime.calls.dispose===1,'AI dispose');
        assert.equal(signal.aborted,true);
        assert.equal(aiRuntime.calls.dispose,1);
        assert.equal(aiRuntime.calls.storeRemove,0);
    });
});
