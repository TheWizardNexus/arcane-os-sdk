import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {
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
const FINAL_WARM_KEYS=Object.freeze([
    'ARCANE_BROWSER_AI_FINAL_WARM_PROFILE',
    'ARCANE_BROWSER_AI_FINAL_WARM_PORT',
    'ARCANE_BROWSER_AI_FINAL_WARM_APPLICATION_ID',
    'ARCANE_BROWSER_AI_FINAL_WARM_PROFILE_DIRECTORY'
]);
const FINAL_WARM_PRESENT=FINAL_WARM_KEYS.filter(key=>Object.hasOwn(process.env,key));
if(FINAL_WARM_PRESENT.length!==0&&FINAL_WARM_PRESENT.length!==FINAL_WARM_KEYS.length){
    throw new Error('The final warm browser-AI environment must provide all four exact keys.');
}
const FINAL_WARM_ONLY=FINAL_WARM_PRESENT.length===FINAL_WARM_KEYS.length;
if(FINAL_WARM_ONLY&&!AUTHORITATIVE_ENABLED){
    throw new Error('The final warm browser-AI environment requires the authoritative installed-artifact gate.');
}
if(FINAL_WARM_ONLY&&FINAL_WARM_KEYS.some(key=>!process.env[key]?.trim())){
    throw new Error('The final warm browser-AI environment rejects empty values.');
}
const FINAL_WARM_PORT=FINAL_WARM_ONLY
    ?Number(process.env.ARCANE_BROWSER_AI_FINAL_WARM_PORT)
    :0;
const FINAL_WARM_APPLICATION_ID=FINAL_WARM_ONLY
    ?process.env.ARCANE_BROWSER_AI_FINAL_WARM_APPLICATION_ID
    :null;
const FINAL_WARM_PROFILE_DIRECTORY=FINAL_WARM_ONLY
    ?process.env.ARCANE_BROWSER_AI_FINAL_WARM_PROFILE_DIRECTORY
    :null;
const ENABLED=AUTHORITATIVE_ENABLED||DEBUG_ENABLED;
const REPORT_PATH='/__arcane_browser_ai_contract_report';
const DEBUG_MODEL_PATH='/__arcane_browser_ai_debug_model';
const REPORT_LIMIT=256*1024;
const OPERATION_TIMEOUT_MS=45*60*1000;
const PROFILE_CLEANUP_TIMEOUT_MS=60*1000;
const EXACT_EXPORTS=Object.freeze([
    'BROWSER_WASM_RUNTIME_AUTHORITY',
    'adaptV1LlmProvider',
    'createArcaneAI',
    'createBrowserModelSource',
    'createBrowserWasmLlmProvider',
    'createDbopfsModelStore'
]);
const GRANITE_AUTHORITY=Object.freeze({
    id:'ibm-granite-4.1-3b-q4-k-s',
    url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf',
    bytes:1_998_371_424,
    sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a'
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
            url:`https://debug.invalid/arcane/${sha256}/${encodeURIComponent(name)}`,
            bytes:info.size,
            sha256
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

async function activeWindowsChromeProfileOwners(profile){
    assert.equal(process.platform,'win32','Chrome profile ownership inspection is Windows-only.');
    const script=[
        "$ErrorActionPreference='Stop'",
        '$target=[IO.Path]::GetFullPath($env:ARCANE_BROWSER_AI_PROFILE_INSPECTION_TARGET).ToLowerInvariant()',
        "$owners=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "+
            'Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($target) } | '+
            'Select-Object -ExpandProperty ProcessId)',
        "[Console]::Out.Write(($owners -join ','))"
    ].join(';');
    const inspector=spawn('powershell.exe',[
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script
    ],{
        env:{
            ...process.env,
            ARCANE_BROWSER_AI_PROFILE_INSPECTION_TARGET:profile
        },
        stdio:['ignore','pipe','pipe'],
        windowsHide:true
    });
    let stdout=Buffer.alloc(0);
    let stderr=Buffer.alloc(0);
    inspector.stdout.on('data',chunk=>{stdout=appendTail(stdout,chunk,8*1024);});
    inspector.stderr.on('data',chunk=>{stderr=appendTail(stderr,chunk,8*1024);});
    let timer=null;
    const timeout=new Promise((_,reject)=>{
        timer=setTimeout(
            ()=>reject(new Error('Chrome profile ownership inspection exceeded 15 seconds.')),
            15_000
        );
        timer.unref?.();
    });
    void timeout.catch(()=>{});
    let result;
    try{
        result=await Promise.race([waitForExit(inspector),timeout]);
    }catch(error){
        await terminateProcess(inspector);
        throw error;
    }finally{
        if(timer!==null)clearTimeout(timer);
    }
    assert.equal(
        result.code,
        0,
        `Chrome profile ownership inspection failed: ${stderr.toString('utf8').trim()}`
    );
    assert.equal(result.signal,null,'Chrome profile ownership inspection was terminated.');
    const output=stdout.toString('utf8').trim();
    return output?output.split(',').filter(Boolean):[];
}

function closeServer(server){
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    if(!server.listening)return Promise.resolve();
    return new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}

async function createContractServer({root,token,debugModel,port=0}){
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
        server.listen(port,'127.0.0.1',resolve);
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

function browserProbeSource({token,model,debug,warmOnly,applicationId}){
    return `const TOKEN=${JSON.stringify(token)};
const MODEL=${JSON.stringify(model)};
const DEBUG=${JSON.stringify(debug)};
const WARM_ONLY=${JSON.stringify(warmOnly)};
const APPLICATION_ID=${JSON.stringify(applicationId)};
const EXACT_EXPORTS=${JSON.stringify(EXACT_EXPORTS)};
const MODEL_FILE_NAME=decodeURIComponent(
    new URL(MODEL.url).pathname.split('/').filter(Boolean).pop()
);

function invariant(value,message){
    if(!value)throw new Error(message);
}

function equal(actual,expected,message){
    if(actual!==expected)throw new Error(message+' (actual '+String(actual)+', expected '+String(expected)+')');
}

function positiveInteger(value,message){
    invariant(Number.isSafeInteger(value)&&value>0,message);
}

async function openReadOnlyDbopfs(applicationId,tableName){
    const root=await navigator.storage.getDirectory();
    const applications=await root.getDirectoryHandle('apps',{create:false});
    const application=await applications.getDirectoryHandle(applicationId,{create:false});
    const table=await application.getDirectoryHandle(tableName,{create:false});
    const readOnlyTable=Object.freeze({
        async getFileHandle(entry,options={}){
            if(options?.create===true)throw new Error('Final warm proof cannot create DBOPFS entries');
            const handle=await table.getFileHandle(entry,{create:false});
            return Object.freeze({
                getFile:()=>handle.getFile(),
                async createWritable(){throw new Error('Final warm proof cannot write DBOPFS entries');}
            });
        },
        async removeEntry(){throw new Error('Final warm proof cannot remove DBOPFS entries');}
    });
    return Object.freeze({
        readyPromise:Promise.resolve(),
        async getTableHandle(name){
            equal(name,tableName,'Final warm proof requested an unexpected DBOPFS table');
            return readOnlyTable;
        }
    });
}

function projectProviderStatus(status,{inference=false,cancellation=false,cleanup=false}={}){
    const evidence=status?.runtimeEvidence;
    equal(evidence?.protocol,'arcane-wllama-runtime-evidence/1','Runtime evidence protocol drifted');
    if(cleanup){
        equal(status.state,'unloaded','Provider did not settle at unloaded');
        equal(status.loaded,false,'Unloaded provider still reports loaded');
        equal(evidence.state,'unloaded','Runtime evidence did not settle at unloaded');
        equal(evidence.cleanup?.kind,'worker-terminated','Worker termination was not proved');
        equal(evidence.webgpu?.lastObservedOperational,true,'Unload lost prior WebGPU evidence');
    }else{
        equal(status.security?.secure,true,'Strict browser contract lost secure mode');
        equal(status.security?.checks?.byteLength,true,'Strict byte-length check was disabled');
        equal(status.security?.checks?.sha256,true,'Strict SHA-256 check was disabled');
        equal(status.integrity?.state,'verified','Strict model integrity was not verified');
        equal(status.capabilities?.webgpuOperational,true,'Provider did not admit operational WebGPU');
        equal(status.capabilities?.webgpuEvidenceProtocol,'arcane-wllama-runtime-evidence/1','Capability evidence protocol drifted');
        equal(evidence.state,'ready','Runtime evidence is not ready');
        equal(evidence.webgpu?.observed,true,'WebGPU operation was not observed');
        invariant(evidence.webgpu?.adapter&&typeof evidence.webgpu.adapter.name==='string','WebGPU adapter evidence is absent');
        const offload=evidence.webgpu?.offload;
        positiveInteger(offload?.totalLayers,'Total model-layer evidence is absent');
        equal(offload.layers,offload.totalLayers,'Not all reported model layers were offloaded');
        equal(offload.allReportedModelLayers,true,'Full-offload admission marker is absent');
        positiveInteger(evidence.webgpu?.buffers?.count,'GPU buffer evidence is absent');
        positiveInteger(evidence.webgpu?.buffers?.descriptorBytes,'GPU buffer-byte evidence is absent');
        const queue=evidence.webgpu?.queue;
        positiveInteger(queue?.submissions,'WebGPU queue submission evidence is absent');
        positiveInteger(queue?.commandBuffers,'WebGPU command-buffer evidence is absent');
        positiveInteger(queue?.fenceRequests,'WebGPU queue-fence evidence is absent');
        invariant(queue.fenceCompletions>=queue.fenceRequests,'WebGPU queue fences did not settle');
        if(inference){
            const last=evidence.webgpu?.lastInference;
            positiveInteger(last?.submissions,'Inference submitted no WebGPU work');
            positiveInteger(last?.commandBuffers,'Inference produced no WebGPU command buffers');
            positiveInteger(last?.fenceRequests,'Inference requested no WebGPU completion fence');
            invariant(last.fenceCompletions>=last.fenceRequests,'Inference WebGPU fences did not settle');
        }
        if(cancellation){
            equal(evidence.cancellation?.deliverySuppressed,true,'Cancelled delivery was not suppressed');
            equal(evidence.cancellation?.upstream?.kind,'llama-request-cancel-acknowledged','Upstream cancellation was not acknowledged');
            equal(evidence.cancellation?.upstream?.responseName,'cncl_res','Cancellation response drifted');
            equal(evidence.cancellation?.upstream?.acknowledged,true,'Cancellation acknowledgement is absent');
            equal(evidence.cancellation?.upstream?.failed,false,'Cancellation acknowledgement reported failure');
        }
    }
    return {
        state:status.state,
        loaded:status.loaded,
        cache:status.cache?.state??null,
        security:status.security??null,
        integrity:status.integrity??null,
        capabilities:{
            webgpuOperational:status.capabilities?.webgpuOperational===true,
            evidenceProtocol:status.capabilities?.webgpuEvidenceProtocol??null
        },
        runtimeEvidence:{
            protocol:evidence.protocol,
            state:evidence.state,
            webgpu:{
                observed:evidence.webgpu?.observed===true,
                lastObservedOperational:evidence.webgpu?.lastObservedOperational===true,
                adapter:evidence.webgpu?.adapter?{
                    vendorId:evidence.webgpu.adapter.vendorId,
                    deviceId:evidence.webgpu.adapter.deviceId,
                    name:String(evidence.webgpu.adapter.name).slice(0,256)
                }:null,
                offload:evidence.webgpu?.offload??null,
                buffers:evidence.webgpu?.buffers??null,
                queue:evidence.webgpu?.queue??null,
                lastInference:evidence.webgpu?.lastInference??null
            },
            cancellation:evidence.cancellation??null,
            cleanup:evidence.cleanup??null
        }
    };
}

async function cacheSnapshot(table){
    const safeId=MODEL.id.replace(/[^a-z0-9._-]+/giu,'_');
    const modelFile=await (await table.getFileHandle(safeId+'--'+MODEL_FILE_NAME,{create:false})).getFile();
    const manifestFile=await (await table.getFileHandle(safeId+'.complete.json',{create:false})).getFile();
    const manifestText=await manifestFile.text();
    const manifest=JSON.parse(manifestText);
    equal(modelFile.size,MODEL.bytes,'DBOPFS model bytes drifted');
    equal(manifest.complete,true,'DBOPFS completion marker drifted');
    if(manifest.schema==='arcane.ai.browser-wasm.model.v3'){
        equal(manifest.observedBytes,MODEL.bytes,'DBOPFS observed byte metadata drifted');
        for(const field of ['id','url']){
            equal(manifest.model?.[field],MODEL[field],'DBOPFS completion authority drifted for '+field);
        }
    }else{
        equal(manifest.schema,'arcane.ai.browser-wasm.model.v2','DBOPFS completion schema drifted');
        equal(manifest.model?.id,MODEL.id,'DBOPFS legacy model ID drifted');
        equal(manifest.model?.name,MODEL_FILE_NAME,'DBOPFS legacy model filename drifted');
        equal(manifest.model?.immutableUrl,MODEL.url,'DBOPFS legacy model URL drifted');
        equal(manifest.model?.bytes,MODEL.bytes,'DBOPFS legacy model bytes drifted');
        equal(manifest.model?.sha256,MODEL.sha256,'DBOPFS legacy model SHA-256 drifted');
    }
    return {modelFile,manifestFile,manifestText,manifest};
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
    equal(components.protocol,'arcane-ai-browser-wasm/2','Component receipt protocol drifted');
    equal(components.packageExport,'arcane-os/ai/browser-wasm','Component export authority drifted');
    equal(
        components.runtimePolicy.modelAuthorities,
        'fieldwise-security-default-false-with-optional-byteLength-and-sha256-checks',
        'Component model-security policy drifted'
    );
    equal(components.runtimePolicy.modelWeightsPacked,false,'Model weights entered the package');
    equal(components.runtimePolicy.webgpuAdmission,'adapter-plus-full-offload-plus-buffer-queue-and-settled-fence-evidence','WebGPU receipt policy drifted');
    equal(components.runtimePolicy.cpuFallback,false,'CPU fallback entered the WebGPU-required release');
    equal(components.runtimePolicy.cancellation,'abortSignal-plus-llama-cancel-acknowledgement','Cancellation receipt policy drifted');
    equal(components.runtimePolicy.cleanup,'worker-termination-only-no-native-unload-claim','Cleanup receipt policy drifted');
    equal(components.runtimePolicy.toolCalls,'structural-only-never-executed','Tool policy drifted');
    const projectedModule=components.components
        .find(component=>component.name==='@wllama/wllama')?.files
        ?.find(file=>file.role==='runtime-module');
    equal(projectedModule?.sha256,'ae9a6ba2aa8687785ed651e28ef92573b409d5e6d3470bfd53340225287908b8','Projected Wllama receipt digest drifted');

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

    let dbopfs;
    if(WARM_ONLY){
        dbopfs=await openReadOnlyDbopfs(APPLICATION_ID,'arcane_ai_browser_models');
    }else{
        const {default:DBOPFS}=await import('arcane/DBOPFS');
        dbopfs=globalThis.dbopfs||new DBOPFS({applicationId:APPLICATION_ID});
        await dbopfs.readyPromise;
    }
    const store=api.createDbopfsModelStore({dbopfs});
    await store.ready();
    let debugFetches=0;
    let prohibitedFetches=0;
    const source=api.createBrowserModelSource(MODEL,WARM_ONLY?{
        fetchImpl:async()=>{
            prohibitedFetches+=1;
            throw new Error('Final warm proof attempted model networking');
        }
    }:DEBUG?{
        fetchImpl:async(_url,options)=>{
            debugFetches+=1;
            const response=await fetch(${JSON.stringify(DEBUG_MODEL_PATH)},{signal:options?.signal,cache:'no-store'});
            return {
                ok:response.ok,
                status:response.status,
                url:MODEL.url,
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
        gpuLayers:99_999
    };
    const provider=api.createBrowserWasmLlmProvider({source,store,loadDefaults});
    const adapted=api.adaptV1LlmProvider(provider);
    equal(adapted.protocol,'arcane-ai-provider/2','Adapted provider protocol drifted');
    equal(adapted.role,'llm','Adapted provider role drifted');
    equal(adapted.localOnly,true,'Adapted provider lost local-only admission');
    equal(adapted.catalog().length,1,'Adapted provider catalog drifted');
    equal(adapted.catalog()[0].id,MODEL.id,'Adapted provider model authority drifted');
    const ai=api.createArcaneAI({
        provider,
        loadPolicy:'manual',
        security:{secure:true}
    });
    const lifecycle=[];
    const progress=[];
    ai.llm.addEventListener('statechange',event=>lifecycle.push(event.detail.state));
    ai.llm.addEventListener('progress',event=>{
        if(event.detail.progress)progress.push(event.detail.progress);
    });
    const table=await dbopfs.getTableHandle(store.tableName);
    if(WARM_ONLY){
        const cacheBefore=await cacheSnapshot(table);
        const warm=await ai.load({offline:true});
        equal(warm.state,'ready','Final warm model load did not reach ready');
        equal(warm.cache.state,'cached','Final warm model load did not use checked DBOPFS bytes');
        equal(prohibitedFetches,0,'Final warm load attempted model networking');
        invariant(progress.some(value=>value.phase==='verify-cache'&&value.loaded===MODEL.bytes),'Final warm cache was not actual-byte rehashed');
        const loadEvidence=projectProviderStatus(provider.status());
        const warmCompletion=await ai.fetchRequest({
            id:'wasm-final-warm-inference',
            localOnly:true,
            messages:[{role:'user',content:'Reply with a short greeting.'}],
            temperature:0,
            maxTokens:24
        });
        const warmText=warmCompletion?.choices?.[0]?.message?.content;
        invariant(typeof warmText==='string'&&warmText.trim(),'Packaged Wllama produced no final warm inference text');
        const inferenceEvidence=projectProviderStatus(provider.status(),{inference:true});

        const cancelController=new AbortController();
        let cancelTrigger='deadline';
        const cancelTimer=setTimeout(()=>cancelController.abort('final warm contract deadline cancellation'),30_000);
        let cancelCode=null;
        try{
            await ai.streamRequest({
                id:'wasm-final-warm-cancel',
                localOnly:true,
                signal:cancelController.signal,
                messages:[{role:'user',content:'Write an extremely long numbered list without stopping.'}],
                temperature:0,
                maxTokens:512,
                onChunk:()=>{
                    cancelTrigger='chunk';
                    cancelController.abort('final warm contract in-flight cancellation');
                }
            });
        }catch(error){
            cancelCode=error?.code||null;
        }finally{
            clearTimeout(cancelTimer);
        }
        equal(cancelCode,'ARCANE_AI_REQUEST_ABORTED','Final warm AbortSignal did not cancel active inference');
        const cancellationEvidence=projectProviderStatus(provider.status(),{
            inference:true,
            cancellation:true
        });
        const unloaded=await ai.unload();
        equal(unloaded.state,'unloaded','Final warm provider did not unload');
        const cleanupEvidence=projectProviderStatus(provider.status(),{cleanup:true});
        await ai.dispose();

        const cacheAfter=await cacheSnapshot(table);
        equal(cacheAfter.modelFile.size,cacheBefore.modelFile.size,'Final warm proof changed model size');
        equal(cacheAfter.modelFile.lastModified,cacheBefore.modelFile.lastModified,'Final warm proof changed model bytes');
        equal(cacheAfter.manifestFile.lastModified,cacheBefore.manifestFile.lastModified,'Final warm proof changed completion metadata');
        equal(cacheAfter.manifestText,cacheBefore.manifestText,'Final warm proof changed completion authority');
        equal(prohibitedFetches,0,'Final warm proof used the model network');

        return {
            exports:Object.keys(api).sort(),
            mode:'granite-final-warm-only',
            authoritative:true,
            model:{id:MODEL.id,url:MODEL.url,bytes:MODEL.bytes,sha256:MODEL.sha256},
            runtime:api.BROWSER_WASM_RUNTIME_AUTHORITY,
            receipt:{
                protocol:components.protocol,
                runtimePolicy:components.runtimePolicy,
                projectedModule:{bytes:projectedModule.bytes,sha256:projectedModule.sha256}
            },
            adapted:{
                protocol:adapted.protocol,
                role:adapted.role,
                localOnly:adapted.localOnly,
                catalog:adapted.catalog().map(item=>({id:item.id,url:item.url,sha256:item.sha256}))
            },
            compatibility,
            finalWarm:{
                cache:warm.cache.state,
                text:warmText.slice(0,256),
                progressPhases:[...new Set(progress.map(value=>value.phase))],
                modelFetches:prohibitedFetches,
                loadEvidence,
                inferenceEvidence,
                cancellation:{code:cancelCode,trigger:cancelTrigger,evidence:cancellationEvidence},
                cleanupEvidence,
                cachePreserved:true
            },
            origin:location.origin,
            secureContext:isSecureContext,
            crossOriginIsolated
        };
    }
    const cold=await ai.load();
    equal(cold.state,'ready','Cold model load did not reach ready');
    equal(cold.cache.state,'installed','A clean browser profile did not install the model');
    invariant(progress.some(value=>value.phase==='download'&&value.loaded===MODEL.bytes),'The model download did not reach its exact byte length');
    invariant(progress.some(value=>value.phase==='verify-download'&&value.loaded===MODEL.bytes),'The installed model was not SHA-256 checked');
    const safeId=MODEL.id.replace(/[^a-z0-9._-]+/giu,'_');
    const modelFile=await (await table.getFileHandle(safeId+'--'+MODEL_FILE_NAME,{create:false})).getFile();
    const manifestFile=await (await table.getFileHandle(safeId+'.complete.json',{create:false})).getFile();
    const completionManifest=JSON.parse(await manifestFile.text());
    equal(modelFile.size,MODEL.bytes,'DBOPFS model bytes drifted');
    invariant(manifestFile.lastModified>=modelFile.lastModified,'The completion manifest was not committed after model bytes');
    equal(completionManifest.schema,'arcane.ai.browser-wasm.model.v3','DBOPFS completion schema drifted');
    equal(completionManifest.observedBytes,MODEL.bytes,'DBOPFS observed byte metadata drifted');
    equal(completionManifest.model.id,MODEL.id,'DBOPFS completion model ID drifted');
    equal(completionManifest.model.url,MODEL.url,'DBOPFS completion model URL drifted');

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
    const offlineAi=api.createArcaneAI({
        provider:offlineProvider,
        loadPolicy:'manual',
        security:{secure:true}
    });
    const offlineProgress=[];
    offlineAi.llm.addEventListener('progress',event=>{
        if(event.detail.progress)offlineProgress.push(event.detail.progress);
    });
    const warm=await offlineAi.load({offline:true});
    equal(warm.state,'ready','Offline model reload did not reach ready');
    equal(warm.cache.state,'cached','Offline reload did not use the checked DBOPFS cache');
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
        model:{id:MODEL.id,url:MODEL.url,bytes:MODEL.bytes,sha256:MODEL.sha256},
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
            'id','url','bytes','sha256'
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
        if(FINAL_WARM_ONLY){
            assert.equal(process.platform,'win32','The retained final warm authority is Windows-only.');
            assert.equal(FINAL_WARM_PORT,8000,'The retained final warm origin must use port 8000.');
            assert.equal(FINAL_WARM_APPLICATION_ID,'boss','The retained final warm DBOPFS application must be boss.');
            assert.equal(FINAL_WARM_PROFILE_DIRECTORY,'Default','The retained final warm Chrome profile must be Default.');
        }
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
    const applicationId=FINAL_WARM_ONLY
        ?FINAL_WARM_APPLICATION_ID
        :'arcane-browser-ai-contract';
    const token=randomBytes(32).toString('hex');
    const htmlPath=path.join(workspaceRoot,'browser-ai-runtime.contract.html');
    const probePath=path.join(workspaceRoot,'browser-ai-runtime.contract.probe.mjs');
    const safeImportMap=JSON.stringify(map).replaceAll('<','\\u003c');
    await writeFile(htmlPath,`<!doctype html>
<html lang="en" data-arcane-app-id="${applicationId}">
<head>
<meta charset="utf-8">
<meta name="arcane-app-id" content="${applicationId}">
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
        debug:Boolean(debugModel),
        warmOnly:FINAL_WARM_ONLY,
        applicationId
    }));
    t.after(()=>rm(htmlPath,{force:true}));
    t.after(()=>rm(probePath,{force:true}));

    let profileOwned=false;
    let profile;
    if(FINAL_WARM_ONLY){
        const configuredProfile=process.env.ARCANE_BROWSER_AI_FINAL_WARM_PROFILE;
        assert.equal(
            path.isAbsolute(configuredProfile),
            true,
            'The external warm profile root must be an absolute path.'
        );
        profile=path.resolve(configuredProfile);
        const profileInfo=await lstat(profile);
        assert.equal(profileInfo.isSymbolicLink(),false,'The external warm profile root must not be a link.');
        assert.equal(profileInfo.isDirectory(),true,'The external warm profile root must be a directory.');
        const selectedProfileInfo=await lstat(path.join(profile,FINAL_WARM_PROFILE_DIRECTORY));
        assert.equal(selectedProfileInfo.isSymbolicLink(),false,'The selected warm profile must not be a link.');
        assert.equal(selectedProfileInfo.isDirectory(),true,'The selected warm profile must be a directory.');
        const owners=await activeWindowsChromeProfileOwners(profile);
        assert.deepEqual(
            owners,
            [],
            `The external warm Chrome profile is already owned by process IDs: ${owners.join(', ')}.`
        );
    }else{
        profile=await mkdtemp(path.join(os.tmpdir(),'arcane-browser-ai-chrome-'));
        profileOwned=true;
    }

    const contractServer=await createContractServer({
        root:workspaceRoot,
        token,
        debugModel,
        port:FINAL_WARM_PORT
    });
    let chrome=null;
    t.after(async()=>{
        let cleanupTimer=null;
        const cleanup=(async()=>{
            await terminateProcess(chrome);
            await closeServer(contractServer.server);
            if(profileOwned){
                await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:250});
            }
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
        '--disable-sync',
        '--metrics-recording-only',
        '--no-default-browser-check',
        '--no-first-run',
        '--password-store=basic',
        `--user-data-dir=${profile}`,
        ...(FINAL_WARM_ONLY?[`--profile-directory=${FINAL_WARM_PROFILE_DIRECTORY}`]:[]),
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
    await new Promise(resolve=>setTimeout(resolve,2_000));
    assert.equal(
        chrome.exitCode,
        null,
        'The proof-owned Chrome process exited; refusing a report that may have been delegated to an existing profile owner.'
    );
    assert.equal(
        chrome.signalCode,
        null,
        'The proof-owned Chrome process was signalled before report acceptance.'
    );
    assert.equal(report.ok,true,report.error?.message??'Browser-AI contract failed.');
    assert.deepEqual(report.result.exports,EXACT_EXPORTS);
    assert.equal(report.result.runtime.protocol,'arcane-ai-browser-wasm/2');
    assert.equal(report.result.runtime.executionPolicy.cpuFallback,false);
    assert.equal(
        report.result.runtime.executionPolicy.operationalEvidence,
        'arcane-wllama-runtime-evidence/1'
    );
    assert.equal(report.result.runtime.runtimeAssets.module.sha256,
        'ae9a6ba2aa8687785ed651e28ef92573b409d5e6d3470bfd53340225287908b8');
    assert.equal(report.result.runtime.runtimeAssets.wasm.sha256,
        '95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6');
    assert.equal(report.result.compatibility.executions,0);
    if(FINAL_WARM_ONLY){
        assert.equal(report.result.mode,'granite-final-warm-only');
        assert.equal(report.result.origin,'http://127.0.0.1:8000');
        assert.equal(report.result.receipt.protocol,'arcane-ai-browser-wasm/2');
        assert.equal(report.result.receipt.runtimePolicy.cpuFallback,false);
        assert.equal(report.result.receipt.projectedModule.bytes,389_765);
        assert.equal(report.result.receipt.projectedModule.sha256,
            'ae9a6ba2aa8687785ed651e28ef92573b409d5e6d3470bfd53340225287908b8');
        assert.deepEqual(report.result.adapted,{
            protocol:'arcane-ai-provider/2',
            role:'llm',
            localOnly:true,
            catalog:[{
                id:GRANITE_AUTHORITY.id,
                url:GRANITE_AUTHORITY.url,
                sha256:GRANITE_AUTHORITY.sha256
            }]
        });
        const finalWarm=report.result.finalWarm;
        assert.equal(finalWarm.cache,'cached');
        assert.equal(finalWarm.modelFetches,0);
        assert.ok(finalWarm.text.trim());
        assert.equal(finalWarm.cachePreserved,true);
        assert.equal(finalWarm.loadEvidence.runtimeEvidence.protocol,'arcane-wllama-runtime-evidence/1');
        assert.equal(finalWarm.loadEvidence.capabilities.webgpuOperational,true);
        assert.equal(finalWarm.inferenceEvidence.runtimeEvidence.webgpu.observed,true);
        assert.ok(finalWarm.inferenceEvidence.runtimeEvidence.webgpu.lastInference.submissions>0);
        assert.ok(finalWarm.inferenceEvidence.runtimeEvidence.webgpu.lastInference.fenceRequests>0);
        assert.ok(
            finalWarm.inferenceEvidence.runtimeEvidence.webgpu.lastInference.fenceCompletions>=
            finalWarm.inferenceEvidence.runtimeEvidence.webgpu.lastInference.fenceRequests
        );
        assert.equal(finalWarm.cancellation.code,'ARCANE_AI_REQUEST_ABORTED');
        assert.equal(
            finalWarm.cancellation.evidence.runtimeEvidence.cancellation.upstream.kind,
            'llama-request-cancel-acknowledged'
        );
        assert.equal(
            finalWarm.cancellation.evidence.runtimeEvidence.cancellation.upstream.responseName,
            'cncl_res'
        );
        assert.equal(
            finalWarm.cleanupEvidence.runtimeEvidence.cleanup.kind,
            'worker-terminated'
        );
    }else{
        assert.equal(report.result.cold.cache,'installed');
        assert.ok(report.result.cold.text.trim());
        assert.equal(report.result.cancellation.code,'ARCANE_AI_REQUEST_ABORTED');
        assert.equal(report.result.offline.cache,'cached');
        assert.equal(report.result.offline.modelFetches,0);
        assert.ok(report.result.offline.text.trim());
    }
    if(AUTHORITATIVE_ENABLED)assert.equal(report.result.authoritative,true);
    else assert.equal(report.result.authoritative,false);
    assert.equal(report.result.crossOriginIsolated,false);
    assert.ok(contractServer.requests.includes('GET /arcane/sdk/ai/wllama/index.mjs'));
    assert.ok(contractServer.requests.includes('GET /arcane/sdk/ai/wllama/wllama.wasm'));
});
