import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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
const FINAL_WARM_KEYS=[
    'ARCANE_BROWSER_AI_FINAL_WARM_PROFILE',
    'ARCANE_BROWSER_AI_FINAL_WARM_PORT',
    'ARCANE_BROWSER_AI_FINAL_WARM_APPLICATION_ID',
    'ARCANE_BROWSER_AI_FINAL_WARM_PROFILE_DIRECTORY'
];
const FINAL_WARM_PRESENT=FINAL_WARM_KEYS.filter(key=>Object.hasOwn(process.env,key));
if(FINAL_WARM_PRESENT.length!==0&&FINAL_WARM_PRESENT.length!==FINAL_WARM_KEYS.length){
    throw new Error('The final warm browser-AI environment must provide all four exact keys.');
}
const FINAL_WARM_ONLY=FINAL_WARM_PRESENT.length===FINAL_WARM_KEYS.length;
const FINAL_WARM_BROWSER_MODE_KEY='ARCANE_BROWSER_AI_FINAL_WARM_BROWSER_MODE';
const FINAL_WARM_BROWSER_MODE=FINAL_WARM_ONLY
    ?process.env[FINAL_WARM_BROWSER_MODE_KEY]?.trim()
    :null;
if(FINAL_WARM_ONLY&&!AUTHORITATIVE_ENABLED){
    throw new Error('The final warm browser-AI environment requires the authoritative installed-artifact gate.');
}
if(FINAL_WARM_ONLY&&FINAL_WARM_KEYS.some(key=>!process.env[key]?.trim())){
    throw new Error('The final warm browser-AI environment rejects empty values.');
}
if(FINAL_WARM_ONLY&&!['existing','managed'].includes(FINAL_WARM_BROWSER_MODE)){
    throw new Error(
        `${FINAL_WARM_BROWSER_MODE_KEY} must explicitly select existing or managed.`
    );
}
if(!FINAL_WARM_ONLY&&Object.hasOwn(process.env,FINAL_WARM_BROWSER_MODE_KEY)){
    throw new Error(`${FINAL_WARM_BROWSER_MODE_KEY} is valid only for the final warm proof.`);
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
const OPERATION_TIMEOUT_MS=45*60*1000;
const PROFILE_CLEANUP_TIMEOUT_MS=60*1000;
const EXACT_EXPORTS=[
    'BROWSER_WASM_RUNTIME_AUTHORITY',
    'adaptV1LlmProvider',
    'completeValueText',
    'createArcaneAI',
    'createBrowserModelSource',
    'createBrowserWasmLlmProvider',
    'createDbopfsModelStore'
];
const GRANITE_AUTHORITY={
    id:'ibm-granite-4.1-3b-q4-k-s',
    files:[{
        name:'granite-4.1-3b-Q4_K_S.gguf',
        url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/main/granite-4.1-3b-Q4_K_S.gguf'
    }]
};

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

async function debugAuthority(){
    const configured=process.env.ARCANE_BROWSER_AI_DEBUG_MODEL_PATH;
    if(!configured)return null;
    const absolute=path.resolve(configured);
    const info=await lstat(absolute);
    assert.equal(info.isSymbolicLink(),false,'The disposable debug model must not be a link.');
    assert.equal(info.isFile(),true,'The disposable debug model must be a regular file.');
    const name=path.basename(absolute);
    return {
        path:absolute,
        descriptor:{
            id:'disposable-debug-model',
            files:[{
                name,
                url:`https://debug.invalid/arcane/${encodeURIComponent(name)}`
            }]
        }
    };
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

function appendOutput(current,chunk){
    return Buffer.concat([current,Buffer.from(chunk)]);
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
        "$default=[IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Google\\Chrome\\User Data')).ToLowerInvariant()",
        "$owners=@(Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "+
            'Where-Object { $_.CommandLine -and (& { '+
                '$command=$_.CommandLine.ToLowerInvariant(); '+
                '$browserRoot=$command -notmatch "(?i)(?:^|\\s)--type="; '+
                '$explicitProfile=$command.Contains("--user-data-dir="); '+
                '$browserRoot -and (($explicitProfile -and $command.Contains($target)) -or '+
                    '(-not $explicitProfile -and $target -eq $default)) '+
            '}) } | '+
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
    inspector.stdout.on('data',chunk=>{stdout=appendOutput(stdout,chunk);});
    inspector.stderr.on('data',chunk=>{stderr=appendOutput(stderr,chunk);});
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

async function createContractServer({root,debugModel,port=0}){
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
            request.on('data',chunk=>{
                chunks.push(chunk);
            });
            request.once('error',reportReject);
            request.once('end',()=>{
                try{
                    const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
    return {
        server,
        report,
        requests,
        url:`http://127.0.0.1:${address.port}/browser-ai-runtime.contract.html`
    };
}

function browserProbeSource({model,debug,warmOnly,applicationId}){
    return `const MODEL=${JSON.stringify(model)};
const DEBUG=${JSON.stringify(debug)};
const WARM_ONLY=${JSON.stringify(warmOnly)};
const APPLICATION_ID=${JSON.stringify(applicationId)};
const EXACT_EXPORTS=${JSON.stringify(EXACT_EXPORTS)};
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
    const readOnlyTable={
        async getFileHandle(entry,options={}){
            if(options?.create===true)throw new Error('Final warm proof cannot create DBOPFS entries');
            const handle=await table.getFileHandle(entry,{create:false});
            return {
                getFile:()=>handle.getFile(),
                async createWritable(){throw new Error('Final warm proof cannot write DBOPFS entries');}
            };
        },
        async removeEntry(){throw new Error('Final warm proof cannot remove DBOPFS entries');}
    };
    return {
        readyPromise:Promise.resolve(),
        async getTableHandle(name){
            equal(name,tableName,'Final warm proof requested an unexpected DBOPFS table');
            return readOnlyTable;
        }
    };
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
        equal(status.capabilities?.webgpuOperational,true,'Provider did not report operational WebGPU');
        equal(status.capabilities?.webgpuEvidenceProtocol,'arcane-wllama-runtime-evidence/1','Capability evidence protocol drifted');
        equal(evidence.state,'ready','Runtime evidence is not ready');
        equal(evidence.webgpu?.observed,true,'WebGPU operation was not observed');
        invariant(evidence.webgpu?.adapter&&typeof evidence.webgpu.adapter.name==='string','WebGPU adapter evidence is absent');
        const offload=evidence.webgpu?.offload;
        positiveInteger(offload?.totalLayers,'Total model-layer evidence is absent');
        equal(offload.layers,offload.totalLayers,'Not all reported model layers were offloaded');
        equal(offload.allReportedModelLayers,true,'Full-offload result is absent');
        positiveInteger(evidence.webgpu?.buffers?.count,'GPU buffer evidence is absent');
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
                    name:String(evidence.webgpu.adapter.name)
                }:null,
                offload:evidence.webgpu?.offload??null,
                buffers:evidence.webgpu?.buffers?{
                    count:evidence.webgpu.buffers.count
                }:null,
                queue:evidence.webgpu?.queue??null,
                lastInference:evidence.webgpu?.lastInference??null
            },
            cancellation:evidence.cancellation??null,
            cleanup:evidence.cleanup??null
        }
    };
}

function scriptedHandle(chunks,completion){
    let index=0;
    let cancelled=false;
    return {
        result:Promise.resolve(completion),
        async cancel(){cancelled=true;return true;},
        async next(){
            if(cancelled||index>=chunks.length)return {value:undefined,done:true};
            return {value:chunks[index++],done:false};
        },
        async return(value){cancelled=true;return {value,done:true};},
        [Symbol.asyncIterator](){return this;}
    };
}

async function expectRejectionCode(promise,expectedCode,label){
    try{
        await promise;
    }catch(error){
        equal(error?.code,expectedCode,label+' error code drifted');
        return error;
    }
    throw new Error(label+' did not reject');
}

async function sendReport(value){
    await fetch(${JSON.stringify(REPORT_PATH)},{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(value)
    });
}

async function run(){
    const api=await import('arcane-os/ai/browser-wasm');
    equal(JSON.stringify(Object.keys(api).sort()),JSON.stringify(EXACT_EXPORTS),'Public export inventory drifted');
    const runtimeAuthority=api.BROWSER_WASM_RUNTIME_AUTHORITY;
    equal(runtimeAuthority.protocol,'arcane-ai-browser-wasm/2','Runtime authority protocol drifted');
    equal(runtimeAuthority.package.name,'@wllama/wllama','Runtime package authority drifted');
    equal(runtimeAuthority.package.version,'3.6.0','Runtime package version drifted');
    equal(runtimeAuthority.runtimeAssets.module.path,'ai/wllama/index.mjs','Runtime module path drifted');
    equal(runtimeAuthority.runtimeAssets.module.mediaType,'text/javascript','Runtime module media type drifted');
    equal(runtimeAuthority.runtimeAssets.wasm.path,'ai/wllama/wllama.wasm','Runtime WASM path drifted');
    equal(runtimeAuthority.runtimeAssets.wasm.mediaType,'application/wasm','Runtime WASM media type drifted');

    let fakeState='ready';
    const compatibility={requests:[],responses:[],chunks:[],completions:[],tools:[],executions:0};
    const fakeProvider={
        protocol:'arcane-ai-adapter/1',
        capabilities:()=>({localOnly:true}),
        status:()=>({state:fakeState,loaded:fakeState==='ready'}),
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
                id:'catalog-contract-call',
                type:'function',
                function:{
                    name:'search_local_catalog',
                    arguments:'{"query":"local","message":"Searching the local catalog."}'
                }
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
            name:'search_local_catalog',
            description:'Visible structural test tool',
            parameters:{
                type:'object',
                properties:{
                    query:{type:'string'},
                    message:{type:'string',minLength:1}
                },
                required:['query','message']
            }
        }
    };
    const fetched=await compatibilityAi.fetchRequest({
        id:'catalog-fetch-request',
        localOnly:true,
        messages:[{role:'user',content:'compatibility'}],
        structuredOutput:true,
        tools:[toolDefinition],
        onRequest:(request,id)=>compatibility.requests.push({id,structuredOutput:request.structuredOutput,tools:request.tools.length}),
        onResponse:(response,id)=>compatibility.responses.push({id,responseId:response.id})
    });
    equal(fetched.id,'catalog-fetch-request','fetchRequest did not preserve its request ID');
    const persistentChat=await compatibilityAi.createChatSession({
        memory:false,
        systemPrompt:'Use the same configured Arcane AI controller.'
    });
    const persistentResult=await persistentChat.send({
        message:{content:'session-only compatibility',persist:false},
        response:{persist:false}
    });
    equal(
        persistentResult.message.content,
        'compatibility response',
        'createChatSession did not use the owning Arcane AI controller'
    );
    equal(
        persistentChat.chatEntity.messages.some(message=>message.content==='session-only compatibility'),
        true,
        'Session-only chat input did not remain in recurring context'
    );
    const toolResult=await compatibilityAi.streamRequest({
        id:'catalog-stream-request',
        localOnly:true,
        messages:[{role:'user',content:'use the visible tool'}],
        tools:[toolDefinition],
        toolHandlers:{search_local_catalog:()=>{compatibility.executions+=1;}},
        executeTools:true,
        onRequest:(request,id)=>compatibility.requests.push({id,tools:request.tools.length}),
        onChunk:(text,id,isThinking)=>compatibility.chunks.push({text,id,isThinking}),
        onToolCall:call=>compatibility.tools.push(call),
        onComplete:(result,id,isThinking)=>compatibility.completions.push({result,id,isThinking})
    });
    await Promise.resolve();
    const expectedStructuralToolCall=[{
        id:'catalog-contract-call',
        type:'function',
        function:{
            name:'search_local_catalog',
            arguments:'{"query":"local","message":"Searching the local catalog."}'
        }
    }];
    equal(
        JSON.stringify(toolResult),
        JSON.stringify(expectedStructuralToolCall),
        'Structural tool envelope or user-facing message drifted'
    );
    equal(
        JSON.stringify(compatibility.tools),
        JSON.stringify(expectedStructuralToolCall),
        'Structural tool visibility drifted'
    );
    equal(
        JSON.stringify(compatibility.completions[0].result),
        JSON.stringify(expectedStructuralToolCall),
        'Structural tool completion envelope drifted'
    );
    equal(compatibility.completions[0].id,'M-catalog-stream-request','streamRequest display ID drifted');
    equal(compatibility.executions,0,'The SDK executed an application-owned tool');
    await compatibilityAi.dispose();

    const focusedStreams=new Map();
    let focusedState='ready';
    const focusedProvider={
        protocol:'arcane-ai-adapter/1',
        capabilities:()=>({localOnly:true}),
        status:()=>({state:focusedState,loaded:focusedState==='ready'}),
        async load(){focusedState='ready';},
        async unload(){focusedState='unloaded';},
        stream(request){
            const script=focusedStreams.get(request.id);
            invariant(script,'No focused stream was registered for '+String(request.id));
            return scriptedHandle(script.chunks,script.completion);
        },
        async dispose(){focusedState='unloaded';}
    };
    const focusedAi=api.createArcaneAI({provider:focusedProvider,loadPolicy:'manual'});
    function registerFocusedStream(id,chunks,completion){
        focusedStreams.set(id,{chunks,completion});
    }

    const resultFirstCall={
        id:'result-first-tool',
        type:'function',
        source:{phase:'streamed'},
        function:{
            name:'search_local_catalog',
            arguments:'{"query":"result first","message":"Reviewing the result-first stream."}',
            format:{type:'json'}
        }
    };
    const resultFirstChunk={
        id:'result-first-private-drain',
        object:'chat.completion.chunk',
        choices:[{
            index:0,
            delta:{
                content:'result-first content',
                tool_calls:[{index:0,...resultFirstCall}]
            }
        }]
    };
    const resultFirstCompletion={
        id:'result-first-private-drain',
        object:'chat.completion',
        choices:[{
            index:0,
            message:{role:'assistant',content:null,tool_calls:[resultFirstCall]},
            finish_reason:'tool_calls'
        }]
    };
    registerFocusedStream(
        'result-first-private-drain',
        [resultFirstChunk],
        resultFirstCompletion
    );
    const resultFirstHandle=focusedAi.llm.stream({
        id:'result-first-private-drain',
        localOnly:true,
        messages:[{role:'user',content:'Drain before resolving the result.'}],
        tools:[toolDefinition]
    });
    equal(
        await resultFirstHandle.result,
        resultFirstCompletion,
        'Result-first stream changed the terminal completion'
    );
    const resultFirstPublic=[];
    for await (const chunk of resultFirstHandle)resultFirstPublic.push(chunk);
    equal(resultFirstPublic.length,1,'Result-first stream did not retain its complete public chunk');
    equal(
        resultFirstPublic[0].choices[0].delta.content,
        'result-first content',
        'Result-first stream lost nonstructural content'
    );
    equal(
        Object.hasOwn(resultFirstPublic[0].choices[0].delta,'tool_calls'),
        false,
        'Result-first stream exposed a partial structural delta'
    );

    const iteratorFirstCall={
        id:'iterator-first-later-choice-tool',
        type:'function',
        source:{phase:'complete',choice:4},
        function:{
            name:'search_local_catalog',
            arguments:'{"query":"iterator first","message":"Reviewing the later streamed choice."}',
            format:{type:'json',complete:true}
        }
    };
    const iteratorFirstChunk={
        id:'iterator-first-private-drain',
        object:'chat.completion.chunk',
        choices:[
            {index:0,delta:{content:'first public choice'}},
            {
                index:4,
                message:{
                    role:'assistant',
                    content:null,
                    tool_calls:[iteratorFirstCall]
                }
            }
        ]
    };
    const iteratorFirstCompletion={
        id:'iterator-first-private-drain',
        object:'chat.completion',
        choices:[
            {
                index:0,
                message:{role:'assistant',content:'first terminal choice'},
                finish_reason:'stop'
            },
            {
                index:4,
                message:{role:'assistant',content:null,tool_calls:[iteratorFirstCall]},
                finish_reason:'tool_calls'
            }
        ]
    };
    registerFocusedStream(
        'iterator-first-private-drain',
        [iteratorFirstChunk],
        iteratorFirstCompletion
    );
    const iteratorFirstHandle=focusedAi.llm.stream({
        id:'iterator-first-private-drain',
        localOnly:true,
        messages:[{role:'user',content:'Drain through the iterator first.'}],
        tools:[toolDefinition]
    });
    const iteratorFirstPublic=[];
    for await (const chunk of iteratorFirstHandle)iteratorFirstPublic.push(chunk);
    equal(
        await iteratorFirstHandle.result,
        iteratorFirstCompletion,
        'Iterator-first stream changed the terminal completion'
    );
    equal(iteratorFirstPublic.length,1,'Iterator-first stream did not retain its public chunk');
    equal(
        iteratorFirstPublic[0].choices[0].delta.content,
        'first public choice',
        'Iterator-first stream lost first-choice content'
    );
    equal(
        Object.hasOwn(iteratorFirstPublic[0].choices[1].message,'tool_calls'),
        false,
        'Iterator-first stream exposed a later-choice structural envelope'
    );

    const multiChoiceChunk={
        id:'multi-choice-scalar',
        object:'chat.completion.chunk',
        choices:[
            {index:2,delta:{reasoning_content:'reason two',content:'content two'}},
            {index:0,delta:{content:'content zero'}},
            {index:1,delta:{reasoning_content:'reason one'}}
        ]
    };
    const multiChoiceCompletion={
        id:'multi-choice-scalar',
        object:'chat.completion',
        metadata:{complete:true},
        choices:[
            {index:2,message:{role:'assistant',content:null},finish_reason:'stop'},
            {index:0,message:{role:'assistant',content:''},finish_reason:'stop'},
            {
                index:1,
                message:{role:'assistant',content:{kind:'complete-object'}},
                finish_reason:'stop'
            }
        ]
    };
    registerFocusedStream(
        'multi-choice-scalar',
        [multiChoiceChunk],
        multiChoiceCompletion
    );
    const multiChoiceData=[];
    const multiChoiceScalar=[];
    const multiChoiceResults=[];
    const multiChoiceCompletions=[];
    const multiChoiceOutput=await focusedAi.streamRequest({
        id:'multi-choice-scalar',
        localOnly:true,
        messages:[{role:'user',content:'Return every choice.'}],
        seeThinking:true,
        onDataChunk:chunk=>multiChoiceData.push(chunk),
        onChunk:(text,_id,isThinking)=>multiChoiceScalar.push({text,isThinking}),
        onDataResult:completion=>multiChoiceResults.push(completion),
        onComplete:completion=>multiChoiceCompletions.push(completion)
    });
    const expectedMultiChoiceText=JSON.stringify(multiChoiceCompletion,null,2);
    equal(
        JSON.stringify(multiChoiceData[0]),
        JSON.stringify(multiChoiceChunk),
        'Multi-choice onDataChunk lost provider data'
    );
    equal(
        JSON.stringify(multiChoiceScalar),
        JSON.stringify([
            {text:'reason two',isThinking:true},
            {text:'content two',isThinking:false},
            {text:'content zero',isThinking:false},
            {text:'reason one',isThinking:true}
        ]),
        'Multi-choice scalar chunks lost provider order or content'
    );
    equal(multiChoiceResults[0],multiChoiceCompletion,'onDataResult changed the terminal completion');
    equal(multiChoiceResults[0].choices[0].message.content,null,'onDataResult lost null content');
    equal(multiChoiceResults[0].choices[1].message.content,'','onDataResult lost empty content');
    equal(
        JSON.stringify(multiChoiceResults[0].choices[2].message.content),
        '{"kind":"complete-object"}',
        'onDataResult lost non-string content'
    );
    equal(multiChoiceOutput,expectedMultiChoiceText,'Multi-choice return reduced the completion');
    equal(
        multiChoiceCompletions[0],
        expectedMultiChoiceText,
        'Multi-choice onComplete reduced the completion'
    );

    for(const scalarCase of [
        {id:'single-null-content',content:null,expected:'null'},
        {id:'single-empty-content',content:'',expected:''},
        {
            id:'single-object-content',
            content:{kind:'complete-object',nested:{answer:true}},
            expected:JSON.stringify({kind:'complete-object',nested:{answer:true}},null,2)
        }
    ]){
        const completion={
            id:scalarCase.id,
            object:'chat.completion',
            choices:[{
                index:0,
                message:{role:'assistant',content:scalarCase.content},
                finish_reason:'stop'
            }]
        };
        registerFocusedStream(scalarCase.id,[],completion);
        const completed=[];
        const output=await focusedAi.streamRequest({
            id:scalarCase.id,
            localOnly:true,
            messages:[{role:'user',content:'Preserve the complete single-choice content.'}],
            onComplete:value=>completed.push(value)
        });
        equal(output,scalarCase.expected,scalarCase.id+' return content drifted');
        equal(completed[0],scalarCase.expected,scalarCase.id+' onComplete content drifted');
    }

    const terminalOnlyCall={
        id:'terminal-only-tool',
        type:'function',
        function:{
            name:'search_local_catalog',
            arguments:'{"query":"terminal only","message":"Reviewing the terminal-only call."}'
        }
    };
    registerFocusedStream(
        'terminal-only-tool',
        [{
            id:'terminal-only-tool',
            object:'chat.completion.chunk',
            choices:[{index:0,delta:{content:'terminal tool follows'}}]
        }],
        {
            id:'terminal-only-tool',
            object:'chat.completion',
            choices:[{
                index:0,
                message:{role:'assistant',content:null,tool_calls:[terminalOnlyCall]},
                finish_reason:'tool_calls'
            }]
        }
    );
    const terminalOnlyVisible=[];
    const terminalOnlyResult=await focusedAi.streamRequest({
        id:'terminal-only-tool',
        localOnly:true,
        messages:[{role:'user',content:'Accept a terminal-only tool call.'}],
        tools:[toolDefinition],
        onToolCall:call=>terminalOnlyVisible.push(call)
    });
    equal(
        JSON.stringify(terminalOnlyResult),
        JSON.stringify([terminalOnlyCall]),
        'Terminal-only structural call was not accepted'
    );
    equal(
        JSON.stringify(terminalOnlyVisible),
        JSON.stringify([terminalOnlyCall]),
        'Terminal-only structural call was not published after validation'
    );

    const wrongIndexCall={
        ...terminalOnlyCall,
        id:'wrong-choice-index-tool',
        envelope:{source:'stream'}
    };
    registerFocusedStream(
        'later-choice-wrong-index',
        [{
            id:'later-choice-wrong-index',
            object:'chat.completion.chunk',
            choices:[
                {index:0,delta:{content:'ordinary first choice'}},
                {
                    index:5,
                    message:{role:'assistant',content:null,tool_calls:[wrongIndexCall]}
                }
            ]
        }],
        {
            id:'later-choice-wrong-index',
            object:'chat.completion',
            choices:[
                {index:0,message:{role:'assistant',content:'ordinary terminal choice'}},
                {
                    index:6,
                    message:{role:'assistant',content:null,tool_calls:[wrongIndexCall]}
                }
            ]
        }
    );
    await expectRejectionCode(
        focusedAi.streamRequest({
            id:'later-choice-wrong-index',
            localOnly:true,
            messages:[{role:'user',content:'Reject a moved later-choice call.'}],
            tools:[toolDefinition]
        }),
        'ARCANE_AI_TOOL_CALL_INVALID',
        'Later-choice index mismatch'
    );

    const streamedEnvelopeCall={
        ...terminalOnlyCall,
        id:'later-choice-envelope-tool',
        envelope:{phase:'stream',detail:{complete:true}}
    };
    const terminalEnvelopeCall={
        ...streamedEnvelopeCall,
        envelope:{phase:'terminal',detail:{complete:true}}
    };
    registerFocusedStream(
        'later-choice-envelope-mismatch',
        [{
            id:'later-choice-envelope-mismatch',
            object:'chat.completion.chunk',
            choices:[
                {index:0,delta:{content:'ordinary first choice'}},
                {
                    index:7,
                    message:{role:'assistant',content:null,tool_calls:[streamedEnvelopeCall]}
                }
            ]
        }],
        {
            id:'later-choice-envelope-mismatch',
            object:'chat.completion',
            choices:[
                {index:0,message:{role:'assistant',content:'ordinary terminal choice'}},
                {
                    index:7,
                    message:{role:'assistant',content:null,tool_calls:[terminalEnvelopeCall]}
                }
            ]
        }
    );
    await expectRejectionCode(
        focusedAi.streamRequest({
            id:'later-choice-envelope-mismatch',
            localOnly:true,
            messages:[{role:'user',content:'Reject a changed later-choice envelope.'}],
            tools:[toolDefinition]
        }),
        'ARCANE_AI_TOOL_CALL_INVALID',
        'Later-choice complete-envelope mismatch'
    );

    for(const singularField of ['tool_call','toolCall']){
        const requestId='singular-terminal-'+singularField;
        registerFocusedStream(
            requestId,
            [],
            {
                id:requestId,
                object:'chat.completion',
                message:{
                    role:'assistant',
                    content:null,
                    [singularField]:terminalOnlyCall
                }
            }
        );
        await expectRejectionCode(
            focusedAi.streamRequest({
                id:requestId,
                localOnly:true,
                messages:[{role:'user',content:'Reject singular structural fields.'}],
                tools:[toolDefinition]
            }),
            'ARCANE_AI_TOOL_CALL_INVALID',
            'Singular terminal '+singularField
        );
    }

    registerFocusedStream(
        'gapped-structural-fragments',
        [{
            id:'gapped-structural-fragments',
            object:'chat.completion.chunk',
            choices:[{
                index:0,
                delta:{tool_calls:[{index:1,...terminalOnlyCall}]}
            }]
        }],
        {
            id:'gapped-structural-fragments',
            object:'chat.completion',
            choices:[{
                index:0,
                message:{role:'assistant',content:null,tool_calls:[terminalOnlyCall]},
                finish_reason:'tool_calls'
            }]
        }
    );
    await expectRejectionCode(
        focusedAi.streamRequest({
            id:'gapped-structural-fragments',
            localOnly:true,
            messages:[{role:'user',content:'Reject gapped tool-call fragments.'}],
            tools:[toolDefinition]
        }),
        'ARCANE_AI_TOOL_CALL_INVALID',
        'Gapped structural fragment indexes'
    );
    await focusedAi.dispose();

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
                url:MODEL.files[0].url,
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
    const provider=api.createBrowserWasmLlmProvider({sources:[source],store,loadDefaults});
    const adapted=api.adaptV1LlmProvider(provider);
    equal(adapted.protocol,'arcane-ai-provider/2','Adapted provider protocol drifted');
    equal(adapted.role,'llm','Adapted provider role drifted');
    equal(adapted.localOnly,true,'Adapted provider lost local-only operation');
    equal(adapted.catalog().length,1,'Adapted provider catalog drifted');
    equal(adapted.catalog()[0].id,MODEL.id,'Adapted provider model authority drifted');
    const ai=api.createArcaneAI({provider,loadPolicy:'manual'});
    const lifecycle=[];
    const progress=[];
    ai.llm.addEventListener('statechange',event=>lifecycle.push(event.detail.state));
    ai.llm.addEventListener('progress',event=>{
        if(event.detail.progress)progress.push(event.detail.progress);
    });
    if(WARM_ONLY){
        const warm=await ai.load({offline:true});
        equal(warm.state,'ready','Final warm model load did not reach ready');
        equal(warm.cache.state,'cached','Final warm model load did not use the DBOPFS cache');
        equal(prohibitedFetches,0,'Final warm load attempted model networking');
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

        equal(prohibitedFetches,0,'Final warm proof used the model network');

        return {
            exports:Object.keys(api).sort(),
            mode:'granite-final-warm-only',
            authoritative:true,
            model:{id:MODEL.id,files:MODEL.files},
            runtime:api.BROWSER_WASM_RUNTIME_AUTHORITY,
            adapted:{
                protocol:adapted.protocol,
                role:adapted.role,
                localOnly:adapted.localOnly,
                catalog:adapted.catalog().map(item=>({id:item.id,files:item.files}))
            },
            compatibility,
            finalWarm:{
                cache:warm.cache.state,
                text:warmText,
                progressPhases:[...new Set(progress.map(value=>value.phase))],
                modelFetches:prohibitedFetches,
                loadEvidence,
                inferenceEvidence,
                cancellation:{code:cancelCode,trigger:cancelTrigger,evidence:cancellationEvidence},
                cleanupEvidence,
                cachePreserved:true
            },
            origin:location.origin
        };
    }
    const cold=await ai.load();
    equal(cold.state,'ready','Cold model load did not reach ready');
    equal(cold.cache.state,'installed','A clean browser profile did not install the model');
    invariant(progress.some(value=>value.phase==='download'),'The model download phase was not reported');

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
        sources:[offlineSource],
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
    equal(warm.cache.state,'cached','Offline reload did not use the DBOPFS cache');
    equal(offlineFetches,0,'Offline DBOPFS reload used the model network');
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
        model:{id:MODEL.id,files:MODEL.files},
        runtime:api.BROWSER_WASM_RUNTIME_AUTHORITY,
        compatibility,
        cold:{
            cache:cold.cache.state,
            text:coldText,
            progressPhases:[...new Set(progress.map(value=>value.phase))],
            lifecycle,
            debugFetches
        },
        cancellation:{code:cancelCode,trigger:cancelTrigger},
        offline:{
            cache:warm.cache.state,
            text:warmText,
            progressPhases:[...new Set(offlineProgress.map(value=>value.phase))],
            modelFetches:offlineFetches
        },
        origin:location.origin
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
            'id','files'
        ]);
        assert.equal(GRANITE_AUTHORITY.id,'ibm-granite-4.1-3b-q4-k-s');
        assert.equal(GRANITE_AUTHORITY.files[0].name,'granite-4.1-3b-Q4_K_S.gguf');
        assert.match(GRANITE_AUTHORITY.files[0].url,/^https:\/\/huggingface\.co\/ibm-granite\//u);
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
        if(FINAL_WARM_BROWSER_MODE==='managed'){
            const owners=await activeWindowsChromeProfileOwners(profile);
            assert.deepEqual(
                owners,
                [],
                `Managed Chrome requires the selected profile to be free; owner PIDs: ${owners.join(', ')}.`
            );
        }
    }else{
        profile=await mkdtemp(path.join(os.tmpdir(),'arcane-browser-ai-chrome-'));
        profileOwned=true;
    }

    const contractServer=await createContractServer({
        root:workspaceRoot,
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

    let exited=null;
    if(FINAL_WARM_BROWSER_MODE==='existing'){
        console.log(`ARCANE_BROWSER_AI_FINAL_WARM_URL=${contractServer.url}`);
    }else{
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
        chrome.stdout.on('data',chunk=>{stdout=appendOutput(stdout,chunk);});
        chrome.stderr.on('data',chunk=>{stderr=appendOutput(stderr,chunk);});
        exited=waitForExit(chrome).then(result=>{
            throw new Error(
                `Chrome exited before the browser-AI report (code ${String(result.code)}, `+
                `signal ${String(result.signal)}): ${stderr.toString('utf8')||stdout.toString('utf8')}`
            );
        });
        void exited.catch(()=>{});
    }
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
        report=await Promise.race([
            contractServer.report,
            ...(exited?[exited]:[]),
            timeout
        ]);
    }finally{
        if(operationTimer!==null)clearTimeout(operationTimer);
    }
    if(chrome){
        await new Promise(resolve=>setTimeout(resolve,2_000));
        assert.equal(chrome.exitCode,null,'The proof-owned Chrome process exited before report acceptance.');
        assert.equal(chrome.signalCode,null,'The proof-owned Chrome process was signalled before report acceptance.');
    }
    assert.equal(report.ok,true,report.error?.message??'Browser-AI contract failed.');
    assert.deepEqual(report.result.exports,EXACT_EXPORTS);
    assert.equal(report.result.runtime.protocol,'arcane-ai-browser-wasm/2');
    assert.equal(report.result.runtime.executionPolicy.cpuFallback,false);
    assert.equal(
        report.result.runtime.executionPolicy.operationalEvidence,
        'arcane-wllama-runtime-evidence/1'
    );
    assert.equal(report.result.runtime.package.name,'@wllama/wllama');
    assert.equal(report.result.runtime.package.version,'3.6.0');
    assert.deepEqual(report.result.runtime.runtimeAssets.module,{
        path:'ai/wllama/index.mjs',
        url:report.result.runtime.runtimeAssets.module.url,
        mediaType:'text/javascript'
    });
    assert.deepEqual(report.result.runtime.runtimeAssets.wasm,{
        path:'ai/wllama/wllama.wasm',
        url:report.result.runtime.runtimeAssets.wasm.url,
        mediaType:'application/wasm'
    });
    assert.equal(report.result.compatibility.executions,0);
    if(FINAL_WARM_ONLY){
        assert.equal(report.result.mode,'granite-final-warm-only');
        assert.equal(report.result.origin,'http://127.0.0.1:8000');
        assert.deepEqual(report.result.adapted,{
            protocol:'arcane-ai-provider/2',
            role:'llm',
            localOnly:true,
            catalog:[{
                id:GRANITE_AUTHORITY.id,
                files:GRANITE_AUTHORITY.files
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
    assert.ok(contractServer.requests.includes('GET /arcane/sdk/ai/wllama/index.mjs'));
    assert.ok(contractServer.requests.includes('GET /arcane/sdk/ai/wllama/wllama.wasm'));
});
