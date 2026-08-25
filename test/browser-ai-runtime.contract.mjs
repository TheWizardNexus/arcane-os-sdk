import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
    access,
    lstat,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import test from 'arcane-os/testing';

const AUTHORITATIVE_ENABLED=
    process.env.ARCANE_BROWSER_AI_RUNTIME_CONTRACT_INSTALLED==='1';
const DEBUG_ENABLED=
    process.env.ARCANE_BROWSER_AI_DEBUG_CONTRACT_INSTALLED==='1';
const DEBUG_PATH_PRESENT=Object.hasOwn(
    process.env,
    'ARCANE_BROWSER_AI_DEBUG_MODEL_PATH'
);
const ENABLED=AUTHORITATIVE_ENABLED||DEBUG_ENABLED;
const REPORT_PATH='/__arcane_browser_ai_contract_report';
const DEBUG_MODEL_PATH='/__arcane_browser_ai_debug_model';
const REPORT_LIMIT=256*1024;
const OPERATION_TIMEOUT_MS=45*60*1000;
const PROFILE_CLEANUP_TIMEOUT_MS=60*1000;
const EXACT_EXPORTS=Object.freeze([
    'BROWSER_WASM_RUNTIME_AUTHORITY',
    'createArcaneAI',
    'createBrowserModelSource',
    'createBrowserWasmLlmProvider',
    'createDbopfsModelStore'
]);
const GRANITE_AUTHORITY=Object.freeze({
    id:'ibm-granite-4.1-3b-q4-k-s',
    name:'granite-4.1-3b-Q4_K_S.gguf',
    immutableUrl:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf',
    bytes:1_998_371_424,
    sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a',
    licenseSpdx:'Apache-2.0',
    sourceRevision:'ab4701481089b58a082ef63cc1cee738887293ff'
});

function json(value){
    return `${JSON.stringify(value,null,2)}\n`;
}

function contentType(filePath){
    const extension=path.extname(filePath).toLowerCase();
    if(extension==='.html')return 'text/html; charset=utf-8';
    if(extension==='.js'||extension==='.mjs')return 'text/javascript; charset=utf-8';
    if(extension==='.json')return 'application/json; charset=utf-8';
    if(extension==='.wasm')return 'application/wasm';
    if(extension==='.css')return 'text/css; charset=utf-8';
    return 'application/octet-stream';
}

function relativeFile(root,urlPath){
    let decoded;
    try{decoded=decodeURIComponent(urlPath);}
    catch{return null;}
    if(decoded.includes('\\')||decoded.includes('\0'))return null;
    const relative=decoded.replace(/^\/+/, '');
    const absolute=path.resolve(root,relative);
    const relation=path.relative(root,absolute);
    if(!relation||relation.startsWith('..')||path.isAbsolute(relation))return null;
    return absolute;
}

async function sha256File(filePath){
    const digest=createHash('sha256');
    await new Promise((resolve,reject)=>{
        const stream=createReadStream(filePath);
        stream.on('data',chunk=>digest.update(chunk));
        stream.once('error',reject);
        stream.once('end',resolve);
    });
    return digest.digest('hex');
}

async function debugAuthority(){
    const configured=process.env.ARCANE_BROWSER_AI_DEBUG_MODEL_PATH;
    if(!configured)return null;
    const absolute=path.resolve(configured);
    const info=await lstat(absolute);
    assert.equal(info.isSymbolicLink(),false,'The disposable debug model must not be a link.');
    assert.equal(info.isFile(),true,'The disposable debug model must be a regular file.');
    assert.ok(info.size>0,'The disposable debug model must not be empty.');
    const sha256=await sha256File(absolute);
    const name=path.basename(absolute);
    return Object.freeze({
        path:absolute,
        descriptor:Object.freeze({
            id:`disposable-debug-${sha256.slice(0,16)}`,
            name,
            immutableUrl:`https://debug.invalid/arcane/${sha256}/${encodeURIComponent(name)}`,
            bytes:info.size,
            sha256,
            licenseSpdx:'DEBUG-ONLY-NOT-FOR-RELEASE',
            sourceRevision:`disposable-debug-${sha256}`
        })
    });
}

async function regularFile(filePath){
    try{
        const info=await lstat(filePath);
        return !info.isSymbolicLink()&&info.isFile();
    }catch(error){
        if(error?.code==='ENOENT')return false;
        throw error;
    }
}

async function chromePath(){
    const configured=process.env.ARCANE_CHROME_PATH;
    const candidates=configured?[configured]:process.platform==='win32'?
        [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA
                ?path.join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')
                :null
        ]:process.platform==='darwin'?
            ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:
            [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/opt/google/chrome/google-chrome',
                '/opt/google/chrome/chrome'
            ];
    for(const candidate of candidates.filter(Boolean)){
        if(await regularFile(candidate))return candidate;
    }
    assert.fail(configured
        ?`ARCANE_CHROME_PATH is not a regular file: ${configured}`
        :'Google Chrome is required; set ARCANE_CHROME_PATH to its executable.');
}

function appendTail(current,chunk,limit=64*1024){
    const next=Buffer.concat([current,Buffer.from(chunk)]);
    return next.length<=limit?next:next.subarray(next.length-limit);
}

function waitForExit(child){
    return new Promise(resolve=>{
        if(child.exitCode!==null||child.signalCode!==null){
            resolve({code:child.exitCode,signal:child.signalCode});
            return;
        }
        child.once('exit',(code,signal)=>resolve({code,signal}));
    });
}

async function settleWithin(promise,milliseconds){
    let timer=null;
    const deadline=new Promise(resolve=>{
        timer=setTimeout(resolve,milliseconds);
        timer.unref?.();
    });
    try{
        await Promise.race([promise,deadline]);
    }finally{
        if(timer!==null)clearTimeout(timer);
    }
}

async function terminateProcess(child){
    if(!child||child.exitCode!==null||child.signalCode!==null)return;
    if(process.platform==='win32'){
        const killer=spawn('taskkill',['/pid',String(child.pid),'/t','/f'],{
            stdio:'ignore',
            windowsHide:true
        });
        await settleWithin(waitForExit(killer),10_000);
    }else{
        try{process.kill(-child.pid,'SIGTERM');}catch{}
    }
    await settleWithin(waitForExit(child),5_000);
    if(child.exitCode===null&&child.signalCode===null){
        try{
            if(process.platform==='win32')child.kill('SIGKILL');
            else process.kill(-child.pid,'SIGKILL');
        }catch{}
        await settleWithin(waitForExit(child),5_000);
    }
}

function closeServer(server){
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    if(!server.listening)return Promise.resolve();
    return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}

async function createContractServer({root,token,debugModel}){
    const requests=[];
    let reportResolve;
    let reportReject;
    const report=new Promise((resolve,reject)=>{
        reportResolve=resolve;
        reportReject=reject;
    });
    const server=http.createServer(async(request,response)=>{
        const parsed=new URL(request.url,'http://127.0.0.1');
        requests.push(`${request.method} ${parsed.pathname}`);
        if(request.method==='POST'&&parsed.pathname===REPORT_PATH){
            const chunks=[];
            let length=0;
            request.on('data',chunk=>{
                length+=chunk.length;
                if(length>REPORT_LIMIT){
                    request.destroy(new Error('Browser report exceeded its byte limit.'));
                    return;
                }
                chunks.push(chunk);
            });
            request.once('error',reportReject);
            request.once('end',()=>{
                try{
                    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    assert.equal(value.token,token);
                    reportResolve(value);
                    response.writeHead(204,{'cache-control':'no-store'});
                    response.end();
                }catch(error){
                    reportReject(error);
                    response.writeHead(400,{'content-type':'text/plain; charset=utf-8'});
                    response.end('invalid report');
                }
            });
            return;
        }
        if(request.method==='GET'&&parsed.pathname===DEBUG_MODEL_PATH&&debugModel){
            response.writeHead(200,{
                'cache-control':'no-store',
                'content-length':String(debugModel.descriptor.bytes),
                'content-type':'application/octet-stream'
            });
            createReadStream(debugModel.path).pipe(response);
            return;
        }
        if(request.method!=='GET'&&request.method!=='HEAD'){
            response.writeHead(405,{'content-type':'text/plain; charset=utf-8'});
            response.end('method not allowed');
            return;
        }
        const filePath=relativeFile(root,parsed.pathname);
        if(!filePath){
            response.writeHead(404,{'content-type':'text/plain; charset=utf-8'});
            response.end('not found');
            return;
        }
        try{
            const info=await stat(filePath);
            if(!info.isFile())throw Object.assign(new Error('not a file'),{code:'ENOENT'});
            response.writeHead(200,{
                'cache-control':'no-store',
                'content-length':String(info.size),
                'content-type':contentType(filePath)
            });
            if(request.method==='HEAD')response.end();
            else createReadStream(filePath).pipe(response);
        }catch(error){
            if(error?.code!=='ENOENT')reportReject(error);
            response.writeHead(404,{'content-type':'text/plain; charset=utf-8'});
            response.end('not found');
        }
    });
    await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
    });
    const address=server.address();
    assert.ok(address&&typeof address==='object');
    return Object.freeze({
        server,
        report,
        requests,
        url:`http://127.0.0.1:${address.port}/browser-ai-runtime.contract.html`
    });
}

function browserProbeSource({token,model,debug}){
    return `const TOKEN=${JSON.stringify(token)};
const MODEL=${JSON.stringify(model)};
const DEBUG=${JSON.stringify(debug)};
const EXACT_EXPORTS=${JSON.stringify(EXACT_EXPORTS)};

function invariant(value,message){
    if(!value)throw new Error(message);
}

function equal(actual,expected,message){
    if(actual!==expected)throw new Error(message+' (actual '+String(actual)+', expected '+String(expected)+')');
}

function scriptedHandle(chunks,completion){
    let index=0;
    let cancelled=false;
    return Object.freeze({
        result:Promise.resolve(completion),
        async cancel(){cancelled=true;return true;},
        async next(){
            if(cancelled||index>=chunks.length)return {value:undefined,done:true};
            return {value:chunks[index++],done:false};
        },
        async return(value){cancelled=true;return {value,done:true};},
        [Symbol.asyncIterator](){return this;}
    });
}

async function sendReport(value){
    await fetch(${JSON.stringify(REPORT_PATH)},{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({...value,token:TOKEN})
    });
}

async function run(){
    const api=await import('arcane-os/ai/browser-wasm');
    equal(JSON.stringify(Object.keys(api).sort()),JSON.stringify(EXACT_EXPORTS),'Public export inventory drifted');
    const componentResponse=await fetch('/arcane/sdk/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json');
    invariant(componentResponse.ok,'The authenticated browser-AI component receipt was not served');
    const components=await componentResponse.json();
    equal(components.packageExport,'arcane-os/ai/browser-wasm','Component export authority drifted');
    equal(components.runtimePolicy.modelWeightsPacked,false,'Model weights entered the package');
    equal(components.runtimePolicy.toolCalls,'structural-only-never-executed','Tool policy drifted');

    let fakeState='ready';
    const compatibility={requests:[],responses:[],chunks:[],completions:[],tools:[],executions:0};
    const fakeProvider={
        protocol:'arcane-ai-adapter/1',
        capabilities:()=>Object.freeze({localOnly:true}),
        status:()=>Object.freeze({state:fakeState,loaded:fakeState==='ready'}),
        async load(){fakeState='ready';},
        async unload(){fakeState='unloaded';},
        async chat(request){
            return {id:request.id,object:'chat.completion',choices:[{
                index:0,
                message:{role:'assistant',content:'compatibility response'},
                finish_reason:'stop'
            }]};
        },
        stream(request){
            const call={
                id:'boss-contract-call',
                type:'function',
                function:{name:'search_boss_library',arguments:'{"query":"local"}'}
            };
            return scriptedHandle([{
                id:request.id,
                object:'chat.completion.chunk',
                choices:[{
                    index:0,
                    delta:{tool_calls:[{index:0,...call}]},
                    finish_reason:'tool_calls'
                }]
            }],{
                id:request.id,
                object:'chat.completion',
                choices:[{
                    index:0,
                    message:{role:'assistant',content:null,tool_calls:[call]},
                    finish_reason:'tool_calls'
                }]
            });
        },
        async dispose(){fakeState='unloaded';}
    };
    const compatibilityAi=api.createArcaneAI({provider:fakeProvider,loadPolicy:'manual'});
    const toolDefinition={
        type:'function',
        function:{
            name:'search_boss_library',
            description:'Visible structural test tool',
            parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}
        }
    };
    const fetched=await compatibilityAi.fetchRequest({
        id:'boss-fetch-request',
        localOnly:true,
        messages:[{role:'user',content:'compatibility'}],
        structuredOutput:true,
        tools:[toolDefinition],
        onRequest:(request,id)=>compatibility.requests.push({id,structuredOutput:request.structuredOutput,tools:request.tools.length}),
        onResponse:(response,id)=>compatibility.responses.push({id,responseId:response.id})
    });
    equal(fetched.id,'boss-fetch-request','fetchRequest did not preserve its request ID');
    const toolResult=await compatibilityAi.streamRequest({
        id:'boss-stream-request',
        localOnly:true,
        messages:[{role:'user',content:'use the visible tool'}],
        tools:[toolDefinition],
        toolHandlers:{search_boss_library:()=>{compatibility.executions+=1;}},
        executeTools:true,
        onRequest:(request,id)=>compatibility.requests.push({id,tools:request.tools.length}),
        onChunk:(text,id,isThinking)=>compatibility.chunks.push({text,id,isThinking}),
        onToolCall:name=>compatibility.tools.push(name),
        onComplete:(result,id,isThinking)=>compatibility.completions.push({result,id,isThinking})
    });
    await Promise.resolve();
    equal(toolResult.search_boss_library,'{"query":"local"}','Structural tool arguments drifted');
    equal(compatibility.tools[0],'search_boss_library','Structural tool visibility drifted');
    equal(compatibility.completions[0].id,'M-boss-stream-request','streamRequest display ID drifted');
    equal(compatibility.executions,0,'The SDK executed an application-owned tool');
    await compatibilityAi.dispose();

    const {default:DBOPFS}=await import('arcane/DBOPFS');
    const dbopfs=globalThis.dbopfs||new DBOPFS({applicationId:'arcane-browser-ai-contract'});
    await dbopfs.readyPromise;
    const store=api.createDbopfsModelStore({dbopfs});
    await store.ready();
    let debugFetches=0;
    const source=api.createBrowserModelSource(MODEL,DEBUG?{
        fetchImpl:async(_url,options)=>{
            debugFetches+=1;
            const response=await fetch(${JSON.stringify(DEBUG_MODEL_PATH)},{signal:options?.signal,cache:'no-store'});
            return {
                ok:response.ok,
                status:response.status,
                url:MODEL.immutableUrl,
                headers:response.headers,
                body:response.body
            };
        }
    }:undefined);
    const loadDefaults={
        contextTokens:DEBUG?128:1024,
        threads:Math.max(1,Math.min(8,(navigator.hardwareConcurrency||2)-1)),
        batchTokens:DEBUG?64:256,
        microBatchTokens:64,
        gpuLayers:0
    };
    const provider=api.createBrowserWasmLlmProvider({source,store,loadDefaults});
    const ai=api.createArcaneAI({provider,loadPolicy:'manual'});
    const lifecycle=[];
    const progress=[];
    ai.llm.addEventListener('statechange',event=>lifecycle.push(event.detail.state));
    ai.llm.addEventListener('progress',event=>{
        if(event.detail.progress)progress.push(event.detail.progress);
    });
    const cold=await ai.load();
    equal(cold.state,'ready','Cold model load did not reach ready');
    equal(cold.cache.state,'installed','A clean browser profile did not install the model');
    invariant(progress.some(value=>value.phase==='download'&&value.loaded===MODEL.bytes),'The model download did not reach its exact byte length');
    invariant(progress.some(value=>value.phase==='verify-cache'&&value.loaded===MODEL.bytes),'The installed model was not actual-byte rehashed');
    const table=await dbopfs.getTableHandle(store.tableName);
    const safeId=MODEL.id.replace(/[^a-z0-9._-]+/giu,'_');
    const modelFile=await (await table.getFileHandle(safeId+'--'+MODEL.name,{create:false})).getFile();
    const manifestFile=await (await table.getFileHandle(safeId+'.complete.json',{create:false})).getFile();
    const completionManifest=JSON.parse(await manifestFile.text());
    equal(modelFile.size,MODEL.bytes,'DBOPFS model bytes drifted');
    invariant(manifestFile.lastModified>=modelFile.lastModified,'The completion manifest was not committed after model bytes');
    equal(completionManifest.schema,'arcane.ai.browser-wasm.model.v2','DBOPFS completion schema drifted');
    equal(completionManifest.model.sha256,MODEL.sha256,'DBOPFS completion digest drifted');

    const coldCallbacks={request:null,response:null};
    const coldCompletion=await ai.fetchRequest({
        id:'wasm-cold-inference',
        localOnly:true,
        messages:[{role:'user',content:'Reply with a short greeting.'}],
        temperature:0,
        maxTokens:24,
        onRequest:(request,id)=>{coldCallbacks.request={id,messageCount:request.messages.length};},
        onResponse:(response,id)=>{coldCallbacks.response={id,responseId:response.id};}
    });
    const coldText=coldCompletion?.choices?.[0]?.message?.content;
    invariant(typeof coldText==='string'&&coldText.trim(),'Packaged Wllama produced no cold inference text');
    equal(coldCallbacks.request.id,'wasm-cold-inference','Cold onRequest ID drifted');
    equal(coldCallbacks.response.id,'wasm-cold-inference','Cold onResponse ID drifted');

    const cancelController=new AbortController();
    let cancelTrigger='deadline';
    const cancelTimer=setTimeout(()=>cancelController.abort('browser contract deadline cancellation'),30_000);
    let cancelCode=null;
    try{
        await ai.streamRequest({
            id:'wasm-cancel-inference',
            localOnly:true,
            signal:cancelController.signal,
            messages:[{role:'user',content:'Write an extremely long numbered list without stopping.'}],
            temperature:0,
            maxTokens:512,
            onChunk:()=>{
                cancelTrigger='chunk';
                cancelController.abort('browser contract in-flight cancellation');
            }
        });
    }catch(error){
        cancelCode=error?.code||null;
    }finally{
        clearTimeout(cancelTimer);
    }
    equal(cancelCode,'ARCANE_AI_REQUEST_ABORTED','AbortSignal did not cancel active local inference');
    const unloaded=await ai.unload();
    equal(unloaded.state,'unloaded','The cold provider did not unload');
    await ai.dispose();

    let offlineFetches=0;
    const offlineSource=api.createBrowserModelSource(MODEL,{
        fetchImpl:async()=>{
            offlineFetches+=1;
            throw new Error('Offline cache reload attempted model networking');
        }
    });
    const offlineProvider=api.createBrowserWasmLlmProvider({
        source:offlineSource,
        store,
        loadDefaults
    });
    const offlineAi=api.createArcaneAI({provider:offlineProvider,loadPolicy:'manual'});
    const offlineProgress=[];
    offlineAi.llm.addEventListener('progress',event=>{
        if(event.detail.progress)offlineProgress.push(event.detail.progress);
    });
    const warm=await offlineAi.load({offline:true});
    equal(warm.state,'ready','Offline model reload did not reach ready');
    equal(warm.cache.state,'verified','Offline reload did not use the verified DBOPFS cache');
    equal(offlineFetches,0,'Offline DBOPFS reload used the model network');
    invariant(offlineProgress.some(value=>value.phase==='verify-cache'&&value.loaded===MODEL.bytes),'Warm cache was not actual-byte rehashed');
    const warmCompletion=await offlineAi.fetchRequest({
        id:'wasm-offline-inference',
        localOnly:true,
        messages:[{role:'user',content:'Reply with a short greeting.'}],
        temperature:0,
        maxTokens:24
    });
    const warmText=warmCompletion?.choices?.[0]?.message?.content;
    invariant(typeof warmText==='string'&&warmText.trim(),'Packaged Wllama produced no offline inference text');
    const warmUnloaded=await offlineAi.unload();
    equal(warmUnloaded.state,'unloaded','The offline provider did not unload');
    await offlineAi.dispose();

    return {
        exports:Object.keys(api).sort(),
        mode:DEBUG?'disposable-debug':'granite-authority',
        authoritative:!DEBUG,
        model:{id:MODEL.id,name:MODEL.name,bytes:MODEL.bytes,sha256:MODEL.sha256},
        runtime:api.BROWSER_WASM_RUNTIME_AUTHORITY,
        compatibility,
        cold:{
            cache:cold.cache.state,
            text:coldText.slice(0,256),
            progressPhases:[...new Set(progress.map(value=>value.phase))],
            lifecycle,
            debugFetches
        },
        cancellation:{code:cancelCode,trigger:cancelTrigger},
        offline:{
            cache:warm.cache.state,
            text:warmText.slice(0,256),
            progressPhases:[...new Set(offlineProgress.map(value=>value.phase))],
            modelFetches:offlineFetches
        },
        origin:location.origin,
        secureContext:isSecureContext,
        crossOriginIsolated
    };
}

run().then(
    result=>sendReport({ok:true,result}),
    error=>sendReport({
        ok:false,
        error:{name:error?.name||'Error',code:error?.code||null,message:error?.message||String(error)}
    })
);
`;
}

if(!ENABLED){
    test('the installed real-Chrome browser-WASM contract remains an explicit one-host gate',()=>{
        assert.equal(ENABLED,false);
        assert.deepEqual(Object.keys(GRANITE_AUTHORITY),[
            'id','name','immutableUrl','bytes','sha256','licenseSpdx','sourceRevision'
        ]);
        assert.equal(GRANITE_AUTHORITY.bytes,1_998_371_424);
        assert.equal(
            GRANITE_AUTHORITY.sha256,
            'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a'
        );
    });
}else test('the installed package runs real browser-WASM inference and offline DBOPFS reuse',{
    timeout:60*60*1000
},async t=>{
    assert.equal(
        AUTHORITATIVE_ENABLED&&DEBUG_ENABLED,
        false,
        'Authoritative and disposable-debug browser-AI modes are mutually exclusive.'
    );
    if(AUTHORITATIVE_ENABLED){
        assert.equal(
            DEBUG_PATH_PRESENT,
            false,
            'Authoritative Granite validation rejects the disposable debug model environment.'
        );
    }else{
        assert.equal(
            DEBUG_PATH_PRESENT,
            true,
            'Disposable-debug validation requires ARCANE_BROWSER_AI_DEBUG_MODEL_PATH.'
        );
    }
    const workspaceRoot=process.cwd();
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    assert.equal(await regularFile(path.join(installedRoot,'package.json')),true);
    const packageDocument=JSON.parse(await readFile(path.join(installedRoot,'package.json'),'utf8'));
    assert.equal(packageDocument.name,'arcane-os');
    assert.equal(packageDocument.exports['./ai/browser-wasm'],'./browser-runtime/ai/browser-wasm.mjs');
    const resolved=await import.meta.resolve('arcane-os/ai/browser-wasm');
    assert.match(resolved,/node_modules\/arcane-os\/browser-runtime\/ai\/browser-wasm\.mjs$/u);
    const map=JSON.parse(await readFile(
        path.join(
            workspaceRoot,'apps','external-app','modules','arcane.importmap.json'
        ),
        'utf8'
    ));
    assert.equal(
        map.imports['arcane-os/ai/browser-wasm'],
        './arcane/sdk/ai/browser-wasm.mjs'
    );

    const debugModel=DEBUG_ENABLED?await debugAuthority():null;
    if(DEBUG_ENABLED)assert.ok(debugModel,'Disposable-debug model authority is required.');
    const model=debugModel?.descriptor??GRANITE_AUTHORITY;
    const token=randomBytes(32).toString('hex');
    const htmlPath=path.join(workspaceRoot,'browser-ai-runtime.contract.html');
    const probePath=path.join(workspaceRoot,'browser-ai-runtime.contract.probe.mjs');
    const safeImportMap=JSON.stringify(map).replaceAll('<','\\u003c');
    await writeFile(htmlPath,`<!doctype html>
<html lang="en" data-arcane-app-id="arcane-browser-ai-contract">
<head>
<meta charset="utf-8">
<meta name="arcane-app-id" content="arcane-browser-ai-contract">
<title>Arcane installed browser-WASM contract</title>
<script type="importmap">${safeImportMap}</script>
<script type="module" src="/browser-ai-runtime.contract.probe.mjs"></script>
</head>
<body>Installed browser-WASM contract</body>
</html>
`);
    await writeFile(probePath,browserProbeSource({
        token,
        model,
        debug:Boolean(debugModel)
    }));
    t.after(()=>rm(htmlPath,{force:true}));
    t.after(()=>rm(probePath,{force:true}));

    const contractServer=await createContractServer({
        root:workspaceRoot,
        token,
        debugModel
    });
    const profile=await mkdtemp(path.join(os.tmpdir(),'arcane-browser-ai-chrome-'));
    let chrome=null;
    t.after(async()=>{
        let cleanupTimer=null;
        const cleanup=(async()=>{
            await terminateProcess(chrome);
            await closeServer(contractServer.server);
            await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:250});
        })();
        void cleanup.catch(()=>{});
        const cleanupTimeout=new Promise((_,reject)=>{
            cleanupTimer=setTimeout(
                ()=>reject(new Error(
                    `Browser-AI cleanup exceeded ${PROFILE_CLEANUP_TIMEOUT_MS}ms.`
                )),
                PROFILE_CLEANUP_TIMEOUT_MS
            );
            cleanupTimer.unref?.();
        });
        void cleanupTimeout.catch(()=>{});
        try{
            await Promise.race([cleanup,cleanupTimeout]);
        }finally{
            if(cleanupTimer!==null)clearTimeout(cleanupTimer);
        }
    });

    const executable=await chromePath();
    const args=[
        '--headless=new',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-features=MediaRouter,DialMediaRouteProvider,OptimizationHints',
        '--disable-gpu',
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--password-store=basic',
        `--user-data-dir=${profile}`,
        ...(process.platform==='darwin'?['--use-mock-keychain']:[]),
        ...(typeof process.getuid==='function'&&process.getuid()===0?['--no-sandbox']:[]),
        contractServer.url
    ];
    chrome=spawn(executable,args,{
        detached:process.platform!=='win32',
        stdio:['ignore','pipe','pipe'],
        windowsHide:true
    });
    let stdout=Buffer.alloc(0);
    let stderr=Buffer.alloc(0);
    chrome.stdout.on('data',chunk=>{stdout=appendTail(stdout,chunk);});
    chrome.stderr.on('data',chunk=>{stderr=appendTail(stderr,chunk);});
    const exited=waitForExit(chrome).then(result=>{
        throw new Error(
            `Chrome exited before the browser-AI report (code ${String(result.code)}, `+
            `signal ${String(result.signal)}): ${stderr.toString('utf8')||stdout.toString('utf8')}`
        );
    });
    void exited.catch(()=>{});
    void contractServer.report.catch(()=>{});
    let operationTimer=null;
    const timeout=new Promise((_,reject)=>{
        operationTimer=setTimeout(
            ()=>reject(new Error(`Browser-AI contract exceeded ${OPERATION_TIMEOUT_MS}ms.`)),
            OPERATION_TIMEOUT_MS
        );
        operationTimer.unref?.();
    });
    void timeout.catch(()=>{});
    let report;
    try{
        report=await Promise.race([contractServer.report,exited,timeout]);
    }finally{
        if(operationTimer!==null)clearTimeout(operationTimer);
    }
    assert.equal(report.ok,true,report.error?.message??'Browser-AI contract failed.');
    assert.deepEqual(report.result.exports,EXACT_EXPORTS);
    assert.equal(report.result.runtime.runtimeAssets.wasm.sha256,
        '95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6');
    assert.equal(report.result.compatibility.executions,0);
    assert.equal(report.result.cold.cache,'installed');
    assert.ok(report.result.cold.text.trim());
    assert.equal(report.result.cancellation.code,'ARCANE_AI_REQUEST_ABORTED');
    assert.equal(report.result.offline.cache,'verified');
    assert.equal(report.result.offline.modelFetches,0);
    assert.ok(report.result.offline.text.trim());
    if(AUTHORITATIVE_ENABLED)assert.equal(report.result.authoritative,true);
    else assert.equal(report.result.authoritative,false);
    assert.equal(report.result.crossOriginIsolated,false);
    assert.ok(contractServer.requests.includes('GET /arcane/sdk/ai/wllama/index.mjs'));
    assert.ok(contractServer.requests.includes('GET /arcane/sdk/ai/wllama/wllama.wasm'));
});
