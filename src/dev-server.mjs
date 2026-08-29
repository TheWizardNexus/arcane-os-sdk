import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {resolveWorkspace} from './workspace.mjs';
import {createEventQueue} from './event-queue.mjs';

const MIME_TYPES=new Map([
    ['.css','text/css; charset=utf-8'],
    ['.gif','image/gif'],
    ['.html','text/html; charset=utf-8'],
    ['.ico','image/x-icon'],
    ['.jpeg','image/jpeg'],
    ['.jpg','image/jpeg'],
    ['.js','text/javascript; charset=utf-8'],
    ['.json','application/json; charset=utf-8'],
    ['.mjs','text/javascript; charset=utf-8'],
    ['.png','image/png'],
    ['.svg','image/svg+xml; charset=utf-8'],
    ['.txt','text/plain; charset=utf-8'],
    ['.wasm','application/wasm'],
    ['.webp','image/webp'],
    ['.woff','font/woff'],
    ['.woff2','font/woff2']
]);
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const PRIVATE_SOURCE_SEGMENTS=new Set([
    'arcane-app.json','arcane-package.json','test','tests','scripts','node_modules','dist','local'
]);
const SDK_RUNTIME_SOURCE_PROTOCOL='arcane-sdk-runtime-source/1';
const SDK_RUNTIME_SOURCE_ARCANE_ROOTS=new Set([
    'components','css','entities','img','modules','security'
]);
const SDK_RUNTIME_SOURCE_PRIVATE_SEGMENTS=new Set([
    'node_modules','.git','.hg','.svn','cvs'
]);
const SDK_RUNTIME_SOURCE_PRIVATE_MANIFESTS=new Set([
    'arcane-app.json','arcane-package.json','arcane.lock.json',
    'arcane_app_release.json','arcane_runtime_release.json','arcane_sdk_browser_release.json'
]);

function fail(message,code='ARCANE_OPERATION_FAILED'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

function deny(response,status,message){
    response.writeHead(status,{
        'content-type':'text/plain; charset=utf-8'
    });
    response.end(`${message}\n`);
}

function parseRequestTarget(rawUrl){
    const raw=String(rawUrl||'/');
    if(!raw.startsWith('/'))return null;
    const rawPath=raw.split(/[?#]/u,1)[0];
    let decoded;
    try{decoded=decodeURIComponent(rawPath);}
    catch{return null;}
    if(!decoded.startsWith('/')||/[\x00-\x1f\x7f]/u.test(decoded)
        ||/[<>"|?*]/u.test(decoded)||decoded.includes('\\'))return null;
    const segments=decoded.split('/').filter(Boolean);
    if(segments.some(segment=>segment==='.'||segment==='..'||segment.includes(':')
        ||segment.endsWith('.')||segment.endsWith(' ')
        ||/^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu
            .test(segment)))return null;
    let parsed;
    try{parsed=new URL(raw,'http://127.0.0.1');}
    catch{return null;}
    return {segments,path:decoded,searchParams:parsed.searchParams};
}

function resolveInside(root,segments){
    const candidate=path.resolve(root,...segments);
    const relative=path.relative(root,candidate);
    if(relative.startsWith('..')||path.isAbsolute(relative))return null;
    return candidate;
}

function inventoryKey(value){
    return process.platform==='win32'?value.toLowerCase():value;
}

function canonicalLocationKey(value){
    return inventoryKey(path.resolve(value));
}

function pathIsWithin(root,candidate){
    const relative=path.relative(root,candidate);
    return relative===''||(!path.isAbsolute(relative)&&relative!=='..'
        &&!relative.startsWith(`..${path.sep}`));
}

function pathsOverlap(left,right){
    return pathIsWithin(left,right)||pathIsWithin(right,left);
}

async function canonicalRealDirectory(requested,label){
    let info;
    try{
        info=await lstat(requested);
    }catch{
        fail(`${label} must be an existing real directory.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail(`${label} must be an existing real directory.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    let canonical;
    try{
        canonical=await realpath(requested);
    }catch{
        fail(`${label} could not be resolved as a real directory.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    if(canonicalLocationKey(canonical)!==canonicalLocationKey(requested)){
        fail(`${label} must not contain a symlink or reparse-point escape.`,'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    return canonical;
}

function sdkRuntimeSourcePathAllowed(relative,{arcaneRoot=false}={}){
    if(relative.length===0)return false;
    const normalized=relative.map(function normalizeRuntimeSourceSegment(segment){
        return segment.normalize('NFC').toLowerCase();
    });
    if(normalized.some(function runtimeSourceSegmentIsPrivate(segment){
        return segment.startsWith('.')||SDK_RUNTIME_SOURCE_PRIVATE_SEGMENTS.has(segment)
            ||SDK_RUNTIME_SOURCE_PRIVATE_MANIFESTS.has(segment);
    }))return false;
    return !arcaneRoot||SDK_RUNTIME_SOURCE_ARCANE_ROOTS.has(normalized[0]);
}

function sdkArcaneSourcePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative,{arcaneRoot:true});
}

function sdkDependencySourcePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative);
}

function sdkBrowserSourcePathAllowed(relative){
    return sdkRuntimeSourcePathAllowed(relative);
}

async function emitRuntimeSourceEvent(onEvent,event){
    if(typeof onEvent==='function')await onEvent(event);
}

async function verifySdkRuntimeSourceRoot(sourceRoot,workspaceRoot,appId,{signal,onEvent}={}){
    throwIfAborted(signal);
    if(typeof sourceRoot!=='string'||!sourceRoot.trim()){
        fail('sdkRuntimeSourceRoot must name an Arcane SDK directory.',
            'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }
    const requestedRoot=path.resolve(sourceRoot);
    await emitRuntimeSourceEvent(onEvent,{
        type:'runtime.source.mount.started',
        appId,
        requestedRoot,
        target:'browser'
    });
    const canonicalRoot=await canonicalRealDirectory(requestedRoot,'SDK runtime source root');
    const canonicalWorkspaceRoot=await realpath(workspaceRoot);
    if(pathsOverlap(canonicalRoot,canonicalWorkspaceRoot)){
        fail('SDK runtime source root must not overlap the application workspace.',
            'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
    }

    const roots=[
        {
            path:'runtime/arcane',
            prefix:['arcane'],
            allow:sdkArcaneSourcePathAllowed
        },
        {
            path:'runtime/strong-type',
            prefix:['arcane','dependencies','strong-type'],
            allow:sdkDependencySourcePathAllowed
        },
        {
            path:'browser-runtime',
            prefix:['arcane','sdk'],
            allow:sdkBrowserSourcePathAllowed
        }
    ];
    const mappings=[];
    for(let index=0;index<roots.length;index+=1){
        throwIfAborted(signal);
        const root=roots[index];
        const requested=path.join(canonicalRoot,...root.path.split('/'));
        const canonical=await canonicalRealDirectory(requested,`SDK runtime source ${root.path}`);
        if(!pathIsWithin(canonicalRoot,canonical)){
            fail(`SDK runtime source ${root.path} must remain inside the SDK root.`,
                'ARCANE_DEV_RUNTIME_SOURCE_INVALID');
        }
        mappings.push({prefix:root.prefix,root:canonical,allow:root.allow});
        await emitRuntimeSourceEvent(onEvent,{
            type:'runtime.source.mount.progress',
            current:index+1,
            total:roots.length,
            path:root.path
        });
    }
    const runtime={
        mode:'sdk-source',
        protocol:SDK_RUNTIME_SOURCE_PROTOCOL,
        mutable:true,
        distributionAuthority:false,
        sourceRoot:canonicalRoot
    };
    await emitRuntimeSourceEvent(onEvent,{
        type:'runtime.source.mount.ready',
        appId,
        canonicalRoot,
        protocol:SDK_RUNTIME_SOURCE_PROTOCOL,
        routeCount:mappings.length
    });
    return {mappings,runtime};
}

function routePrefixKey(prefix){
    return prefix.map(segment=>segment.normalize('NFC').toLowerCase()).join('/');
}

function deterministicMappings(mappings){
    const seen=new Map();
    for(const mapping of mappings){
        const key=routePrefixKey(mapping.prefix);
        const prior=seen.get(key);
        if(prior){
            fail(
                `Development server routes collide after case/NFC normalization: `
                +`/${prior.prefix.join('/')} and /${mapping.prefix.join('/')}.`
            );
        }
        seen.set(key,mapping);
    }
    return [...mappings].sort((left,right)=>{
        if(left.prefix.length!==right.prefix.length)return right.prefix.length-left.prefix.length;
        const leftKey=routePrefixKey(left.prefix);
        const rightKey=routePrefixKey(right.prefix);
        return leftKey<rightKey?-1:leftKey>rightKey?1:0;
    });
}

function createFileWorkLimiter(){
    return async work=>work();
}

async function openSafeFile(root,segments){
    const candidate=resolveInside(root,segments);
    if(!candidate)return null;
    let current=root;
    for(const segment of segments){
        current=path.join(current,segment);
        let info;
        try{info=await lstat(current);}
        catch(error){
            if(error?.code==='ENOENT')return null;
            throw error;
        }
        if(info.isSymbolicLink())return null;
    }

    const currentInfo=await lstat(candidate);
    if(currentInfo.isSymbolicLink()||!currentInfo.isFile())return null;
    const canonicalCandidate=await realpath(candidate);
    if(!pathIsWithin(root,canonicalCandidate))return null;
    let handle;
    try{
        handle=await open(candidate,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ENOENT'||error?.code==='ELOOP')return null;
        throw error;
    }
    try{
        const opened=await handle.stat();
        if(!opened.isFile())return null;
        const content=await handle.readFile();
        const servedCandidate=await realpath(candidate);
        if(!pathIsWithin(root,servedCandidate)
            ||canonicalLocationKey(servedCandidate)!==canonicalLocationKey(canonicalCandidate)){
            return null;
        }
        return {candidate:servedCandidate,content};
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }finally{
        await handle.close().catch(()=>{});
    }
}

async function sendFile(response,opened,{head=false}={}){
    const extension=path.extname(opened.candidate).toLowerCase();
    response.writeHead(200,{
        'content-type':MIME_TYPES.get(extension)||'application/octet-stream',
        'content-length':opened.content.byteLength
    });
    await new Promise((resolve,reject)=>{
        let settled=false;
        const cleanup=()=>{
            response.removeListener('error',failed);
            response.removeListener('finish',completed);
            response.removeListener('close',completed);
        };
        const completed=()=>{
            if(settled)return;
            settled=true;
            cleanup();
            resolve();
        };
        const failed=error=>{
            if(settled)return;
            settled=true;
            cleanup();
            reject(error);
        };
        response.once('error',failed);
        response.once('finish',completed);
        response.once('close',completed);
        response.end(head?undefined:opened.content);
    });
}

function sourcePathAllowed(relative,manifest){
    const posix=relative.join('/');
    if(!posix)return false;
    const segments=posix.split('/');
    if(segments.some(segment=>segment.startsWith('.')
        ||PRIVATE_SOURCE_SEGMENTS.has(segment.toLowerCase())))return false;
    const comparable=inventoryKey(posix);
    const excluded=(manifest.exclude||[]).some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
    if(excluded)return false;
    return manifest.include.some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
}

function sharedPathAllowed(relative,route){
    const posix=relative.join('/');
    if(!posix||relative.some(segment=>segment.startsWith('.')))return false;
    const comparable=inventoryKey(posix);
    const excluded=(route.exclude??[]).some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
    if(excluded)return false;
    return route.include.some(item=>{
        const candidate=inventoryKey(item);
        return comparable===candidate||comparable.startsWith(`${candidate}/`);
    });
}

async function sourceRoutes(workspaceRoot,appId,{
    sdkRuntimeSourceRoot,
    signal,
    onEvent
}){
    const resolved=await resolveWorkspace({workspaceRoot,appId});
    const appMapping={
        prefix:['apps',resolved.appId],
        root:resolved.appRoot,
        allow:relative=>sourcePathAllowed(relative,resolved.app.manifest)
    };
    if(sdkRuntimeSourceRoot!==undefined){
        const sdkSource=await verifySdkRuntimeSourceRoot(
            sdkRuntimeSourceRoot,
            resolved.workspaceRoot,
            resolved.appId,
            {signal,onEvent}
        );
        return {
            workspaceRoot:resolved.workspaceRoot,
            workspaceMode:resolved.config.workspaceMode,
            appId:resolved.appId,
            startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
            runtime:sdkSource.runtime,
            mappings:[appMapping,...sdkSource.mappings]
        };
    }
    if(resolved.config.workspaceMode==='integrated'){
        return {
            workspaceRoot:resolved.workspaceRoot,
            workspaceMode:'integrated',
            appId:resolved.appId,
            startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
            mappings:[
                appMapping,
                ...resolved.config.sharedPayloads['browser-runtime'].map(route=>({
                    prefix:route.destination.split('/'),
                    root:path.join(resolved.workspaceRoot,...route.source.split('/')),
                    allow:relative=>sharedPathAllowed(relative,route)
                }))
            ]
        };
    }
    const runtimeRoot=path.join(resolved.workspaceRoot,'arcane');
    return {
        workspaceRoot:resolved.workspaceRoot,
        workspaceMode:'external',
        appId:resolved.appId,
        startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
        mappings:[
            appMapping,
            {
                prefix:['arcane'],
                root:runtimeRoot,
                allow:sdkArcaneSourcePathAllowed
            }
        ]
    };
}

async function packagedRoutes(releaseRoot){
    if(typeof releaseRoot!=='string'||!releaseRoot.trim())fail('releaseRoot is required in packaged mode.','ARCANE_USAGE');
    const requested=path.resolve(releaseRoot);
    const canonical=await canonicalRealDirectory(requested,'Packaged release root');
    return {
        workspaceRoot:null,
        appId:null,
        startPath:'/index.html',
        mappings:[{
            prefix:[],
            root:canonical
        }]
    };
}

function listen(server,{host,port,signal}){
    return new Promise((resolve,reject)=>{
        const cleanup=()=>{
            signal?.removeEventListener('abort',abort);
            server.removeListener('error',failed);
        };
        const abort=()=>server.close(()=>{
            cleanup();
            reject(signal.reason||new Error('Operation cancelled.'));
        });
        const failed=error=>{
            cleanup();
            reject(error);
        };
        signal?.addEventListener('abort',abort,{once:true});
        server.once('error',failed);
        server.listen(port,host,()=>{
            cleanup();
            resolve();
        });
    });
}

async function startOwnedDevServer({
    workspaceRoot=process.cwd(),
    appId,
    mode='source',
    releaseRoot,
    host='127.0.0.1',
    port=0,
    signal,
    sdkRuntimeSourceRoot
}={},events,releaseSignal){
    throwIfAborted(signal);
    if(mode!=='source'&&mode!=='packaged')fail(`Unsupported server mode: ${String(mode)}.`,'ARCANE_USAGE');
    if(sdkRuntimeSourceRoot!==undefined&&mode!=='source'){
        fail('sdkRuntimeSourceRoot is supported only in source development mode.','ARCANE_USAGE');
    }
    if(host!=='127.0.0.1'&&host!=='::1'){
        fail('Development server host must be a numeric loopback address (127.0.0.1 or ::1).','ARCANE_POLICY_DENIED');
    }
    if(!Number.isInteger(port)||port<0||port>65535)fail('port must be an integer from 0 through 65535.','ARCANE_USAGE');
    const requestedRuntimeMode=mode==='source'&&sdkRuntimeSourceRoot!==undefined
        ?'sdk-source'
        :null;
    await events.send({
        type:'server.starting',
        mode,
        host,
        port,
        appId,
        ...(requestedRuntimeMode?{runtimeMode:requestedRuntimeMode}:{})
    });
    const routeSet=mode==='source'
        ?await sourceRoutes(workspaceRoot,appId,{
            sdkRuntimeSourceRoot,
            signal,
            onEvent:event=>events.send(event)
        })
        :await packagedRoutes(releaseRoot);
    const mappings=deterministicMappings(routeSet.mappings);
    for(const mapping of mappings){
        const info=await lstat(mapping.root);
        if(info.isSymbolicLink()||!info.isDirectory())fail(`Server route root must be a real directory: ${mapping.root}.`);
        mapping.root=await realpath(mapping.root);
    }
    const requestTasks=new Set();
    const runFileWork=createFileWorkLimiter();
    const server=http.createServer((request,response)=>{
        let task;
        task=(async()=>{
            if(request.method!=='GET'&&request.method!=='HEAD'){
                deny(response,405,'Method not allowed.');
                return;
            }
            const target=parseRequestTarget(request.url);
            if(!target){deny(response,400,'Invalid request path.');return;}
            const {segments}=target;
            if(segments.length===0){
                response.writeHead(302,{location:routeSet.startPath});
                response.end();
                return;
            }
            const mapping=mappings.find(route=>
                route.prefix.every((segment,index)=>segments[index]===segment)
            );
            if(!mapping){deny(response,404,'Not found.');return;}
            const relative=segments.slice(mapping.prefix.length);
            if(relative.length===0){deny(response,404,'Not found.');return;}
            if(mapping.allow&&!mapping.allow(relative)){deny(response,404,'Not found.');return;}
            await runFileWork(async()=>{
                const opened=await openSafeFile(mapping.root,relative);
                if(!opened){deny(response,404,'Not found.');return;}
                await sendFile(response,opened,{head:request.method==='HEAD'});
            });
        })().catch(async error=>{
            await events.enqueue({type:'server.request.failed',message:error.message});
            if(!response.headersSent){
                const status=error?.code==='ARCANE_BACKPRESSURE'?503:500;
                deny(response,status,'Internal server error.');
            }
            else response.destroy(error);
        }).finally(()=>{
            requestTasks.delete(task);
        });
        requestTasks.add(task);
    });
    await listen(server,{host,port,signal});
    const address=server.address();
    if(!address||typeof address==='string'){
        server.close();
        fail('Development server did not expose a TCP address.');
    }
    const visibleHost=address.family==='IPv6'?`[${address.address}]`:address.address;
    const endpoint=new URL(`http://${visibleHost}:${address.port}`);
    const origin=endpoint.origin;
    const cleanUrl=`${origin}${routeSet.startPath}`;
    const url=cleanUrl;
    let closeInitiated=false;
    let lifecycleSettlementStarted=false;
    let operationalError=null;
    let resolveLifecycle;
    let rejectLifecycle;
    const lifecycle=new Promise((resolve,reject)=>{
        resolveLifecycle=resolve;
        rejectLifecycle=reject;
    });
    // A library consumer may only use the raw server. Keep a later lifecycle
    // rejection observable without allowing it to become unhandled.
    void lifecycle.catch(()=>{});

    const finishLifecycle=async()=>{
        if(lifecycleSettlementStarted){
            return;
        }
        lifecycleSettlementStarted=true;
        signal?.removeEventListener('abort',abort);
        server.removeListener('error',serverFailed);
        try{
            while(requestTasks.size>0){
                await Promise.allSettled([...requestTasks]);
            }
            if(routeSet.runtime?.mode==='sdk-source'){
                await events.send({
                    type:'runtime.source.mount.stopped',
                    appId:routeSet.appId,
                    reason:events.error||operationalError
                        ?'failed'
                        :signal?.aborted
                            ?'cancelled'
                            :'closed'
                });
            }
            await events.send({
                type:'server.stopped',
                host:address.address,
                port:address.port
            });
            await events.drain();
            if(operationalError){
                rejectLifecycle(operationalError);
            }else{
                resolveLifecycle();
            }
        }catch(error){
            rejectLifecycle(events.error??operationalError??error);
        }finally{
            releaseSignal();
        }
    };

    const close=error=>{
        if(error&&!operationalError){
            operationalError=error;
        }
        if(!closeInitiated){
            closeInitiated=true;
            try{
                server.close(closeError=>{
                    if(closeError){
                        operationalError??=closeError;
                        void finishLifecycle();
                    }
                });
            }catch(closeError){
                operationalError??=closeError;
                void finishLifecycle();
            }
        }
        return lifecycle;
    };
    const abort=()=>{void close().catch(()=>{});};
    const serverFailed=error=>{void close(error).catch(()=>{});};
    signal?.addEventListener('abort',abort,{once:true});
    server.on('error',serverFailed);
    server.once('close',()=>{void finishLifecycle();});
    const result={
        server,
        mode,
        workspaceRoot:routeSet.workspaceRoot,
        appId:routeSet.appId,
        ...(routeSet.runtime?{
            runtimeMode:routeSet.runtime.mode,
            runtime:routeSet.runtime
        }:{}),
        host:address.address,
        port:address.port,
        origin,
        cleanUrl,
        url,
        close,
        closed:lifecycle,
        lifecycle
    };
    try{
        await events.send({
            type:'server.started',
            mode,
            host:result.host,
            port:result.port,
            url,
            appId:result.appId,
            ...(routeSet.runtime?{
                runtimeMode:routeSet.runtime.mode,
                runtime:routeSet.runtime
            }:{})
        });
        throwIfAborted(signal);
    }catch(error){
        try{
            await close();
        }catch(lifecycleError){
            throw events.error??lifecycleError;
        }
        throw error;
    }
    return result;
}

export async function startDevServer(options={}){
    const inputSignal=options.signal;
    throwIfAborted(inputSignal);
    const controller=new AbortController();
    const forwardAbort=()=>controller.abort(inputSignal?.reason);
    inputSignal?.addEventListener('abort',forwardAbort,{once:true});
    if(inputSignal?.aborted){
        forwardAbort();
    }
    let released=false;
    const releaseSignal=()=>{
        if(released){
            return;
        }
        released=true;
        inputSignal?.removeEventListener('abort',forwardAbort);
    };
    const events=createEventQueue(options.onEvent,{
        onFailure:error=>controller.abort(error)
    });
    try{
        return await startOwnedDevServer(
            {...options,signal:controller.signal},
            events,
            releaseSignal
        );
    }catch(error){
        releaseSignal();
        try{
            await events.drain();
        }catch(callbackFailure){
            throw callbackFailure;
        }
        throw error;
    }
}
