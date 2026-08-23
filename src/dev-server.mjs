import {randomBytes,timingSafeEqual} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
    authenticateAppReleaseReceipt,
    readVerifiedAppReleaseFile,
    RELEASE_MANIFEST_NAME
} from './packager/core.mjs';
import {
    authenticateRuntimeReceipt,
    readVerifiedRuntimeFile,
    verifyRuntime
} from './runtime.mjs';
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
    ['.webp','image/webp'],
    ['.woff','font/woff'],
    ['.woff2','font/woff2']
]);
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const MAX_DEVELOPMENT_FILE_BYTES=64*1024*1024;
const MAX_CONCURRENT_FILE_RESPONSES=4;
const MAX_PENDING_FILE_RESPONSES=256;
const SESSION_COOKIE='Arcane-Dev-Session';
const PRIVATE_SOURCE_SEGMENTS=new Set([
    'arcane-app.json','arcane-package.json','test','tests','scripts','node_modules','dist','local'
]);

// This server is a loopback-only development host, not a production policy
// boundary. The bundled runtime currently needs inline component execution,
// workers, remote provider requests, media, and embedded web content. The
// unguessable session cookie and exact numeric Host check protect this broad
// development CSP from being exposed as a general network service.
const DEVELOPMENT_CSP=[
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: http: https: ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ');

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

function responseSecurityHeaders(contentSecurityPolicy=DEVELOPMENT_CSP){
    return {
        'cache-control':'no-store',
        'x-content-type-options':'nosniff',
        'content-security-policy':contentSecurityPolicy,
        'cross-origin-resource-policy':'same-origin',
        'referrer-policy':'no-referrer'
    };
}

function deny(response,status,message){
    response.writeHead(status,{
        'content-type':'text/plain; charset=utf-8',
        ...responseSecurityHeaders("default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
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

function identityMatches(info,identity){
    return !identity||(
        String(info.dev)===identity.device
        &&String(info.ino)===identity.inode
        &&Number(info.size)===identity.bytes
        &&String(info.mtimeNs)===identity.modifiedNanoseconds
        &&String(info.ctimeNs)===identity.changedNanoseconds
        &&(identity.links===undefined||String(info.nlink)===identity.links)
    );
}

function inventoryKey(value){
    return process.platform==='win32'?value.toLowerCase():value;
}

function identityMap(identities,prefix=''){
    const normalizedPrefix=prefix?`${prefix}/`:'';
    const result=new Map();
    for(const identity of identities||[]){
        if(!identity.path.startsWith(normalizedPrefix))continue;
        const relative=identity.path.slice(normalizedPrefix.length);
        if(relative)result.set(inventoryKey(relative),identity);
    }
    return result;
}

function createFileWorkLimiter(){
    let active=0;
    const pending=[];
    const release=()=>{
        const next=pending.shift();
        if(next)next();
        else active-=1;
    };
    return async work=>{
        if(active>=MAX_CONCURRENT_FILE_RESPONSES){
            if(pending.length>=MAX_PENDING_FILE_RESPONSES){
                fail('Development server file queue is full.','ARCANE_BACKPRESSURE');
            }
            await new Promise(resolve=>pending.push(resolve));
        }else{
            active+=1;
        }
        try{
            return await work();
        }finally{
            release();
        }
    };
}

async function openSafeFile(root,segments,expectedIdentity){
    const candidate=resolveInside(root,segments);
    if(!candidate)return null;
    let current=root;
    for(const segment of segments){
        current=path.join(current,segment);
        let info;
        try{info=await lstat(current,{bigint:true});}
        catch(error){
            if(error?.code==='ENOENT')return null;
            throw error;
        }
        if(info.isSymbolicLink())return null;
    }

    const before=await lstat(candidate,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()||!identityMatches(before,expectedIdentity))return null;
    let handle;
    try{
        handle=await open(candidate,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ENOENT'||error?.code==='ELOOP')return null;
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!identityMatches(opened,expectedIdentity)
            ||!identityMatches(opened,{
                device:String(before.dev),
                inode:String(before.ino),
                bytes:Number(before.size),
                modifiedNanoseconds:String(before.mtimeNs),
                changedNanoseconds:String(before.ctimeNs),
                links:String(before.nlink)
            })){
            return null;
        }
        if(Number(opened.size)>MAX_DEVELOPMENT_FILE_BYTES){
            fail(
                `Development file exceeds the ${MAX_DEVELOPMENT_FILE_BYTES}-byte serving limit.`,
                'ARCANE_POLICY_DENIED'
            );
        }
        const bytes=await handle.readFile();
        const after=await handle.stat({bigint:true});
        if(!identityMatches(after,{
            device:String(opened.dev),
            inode:String(opened.ino),
            bytes:Number(opened.size),
            modifiedNanoseconds:String(opened.mtimeNs),
            changedNanoseconds:String(opened.ctimeNs),
            links:String(opened.nlink)
        })||bytes.length!==Number(opened.size)){
            return null;
        }
        const canonicalCandidate=await realpath(candidate);
        const relative=path.relative(root,canonicalCandidate);
        if(relative.startsWith('..')||path.isAbsolute(relative)){
            return null;
        }
        const currentInfo=await lstat(candidate,{bigint:true});
        if(!identityMatches(currentInfo,{
            device:String(opened.dev),
            inode:String(opened.ino),
            bytes:Number(opened.size),
            modifiedNanoseconds:String(opened.mtimeNs),
            changedNanoseconds:String(opened.ctimeNs),
            links:String(opened.nlink)
        })){
            return null;
        }
        return {candidate:canonicalCandidate,bytes,size:bytes.length};
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
        'content-length':opened.size,
        ...responseSecurityHeaders()
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
        response.end(head?undefined:opened.bytes);
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

async function sourceRoutes(workspaceRoot,appId,{runtimeReceipt,signal,onEvent}){
    const resolved=await resolveWorkspace({workspaceRoot,appId});
    if(resolved.config.workspaceMode==='integrated'){
        return {
            workspaceRoot:resolved.workspaceRoot,
            workspaceMode:'integrated',
            appId:resolved.appId,
            startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
            mappings:[
                {
                    prefix:['apps',resolved.appId],
                    root:resolved.appRoot,
                    allow:relative=>sourcePathAllowed(relative,resolved.app.manifest)
                },
                ...resolved.config.sharedPayloads['browser-runtime'].map(route=>({
                    prefix:route.destination.split('/'),
                    root:path.join(resolved.workspaceRoot,...route.source.split('/')),
                    allow:relative=>sharedPathAllowed(relative,route)
                }))
            ]
        };
    }
    const runtimeRoot=path.join(
        resolved.workspaceRoot,
        'node_modules',
        'arcane-os',
        'runtime'
    );
    const verified=runtimeReceipt??await verifyRuntime({runtimeRoot,signal,onEvent});
    await authenticateRuntimeReceipt(verified,{runtimeRoot});
    const arcaneIdentities=identityMap(verified.identities,'arcane');
    const strongTypeIdentities=identityMap(verified.identities,'strong-type');
    return {
        workspaceRoot:resolved.workspaceRoot,
        workspaceMode:'external',
        appId:resolved.appId,
        startPath:`/apps/${resolved.appId}/${resolved.app.manifest.entry}`,
        mappings:[
            {
                prefix:['apps',resolved.appId],
                root:resolved.appRoot,
                allow:relative=>sourcePathAllowed(relative,resolved.app.manifest)
            },
            {
                prefix:['arcane'],
                root:path.join(runtimeRoot,'arcane'),
                identities:arcaneIdentities,
                read:relative=>readVerifiedRuntimeFile(verified,{
                    runtimeRoot,
                    relativePath:`arcane/${relative.join('/')}`,
                    signal
                }),
                allow:relative=>arcaneIdentities.has(inventoryKey(relative.join('/')))
            },
            {
                prefix:['node_modules','strong-type'],
                root:path.join(runtimeRoot,'strong-type'),
                identities:strongTypeIdentities,
                read:relative=>readVerifiedRuntimeFile(verified,{
                    runtimeRoot,
                    relativePath:`strong-type/${relative.join('/')}`,
                    signal
                }),
                allow:relative=>strongTypeIdentities.has(inventoryKey(relative.join('/')))
            }
        ]
    };
}

async function packagedRoutes(releaseRoot,releaseReceipt,{signal}={}){
    if(typeof releaseRoot!=='string'||!releaseRoot.trim())fail('releaseRoot is required in packaged mode.','ARCANE_USAGE');
    if(!releaseReceipt)fail('An authenticated release receipt is required in packaged mode.','ARCANE_POLICY_DENIED');
    const requested=path.resolve(releaseRoot);
    await authenticateAppReleaseReceipt(releaseReceipt,{releaseRoot:requested,signal});
    const info=await lstat(requested);
    if(info.isSymbolicLink()||!info.isDirectory())fail('Packaged release root must be a real directory.');
    const canonical=await realpath(requested);
    const identities=identityMap(releaseReceipt.identities);
    return {
        workspaceRoot:null,
        appId:null,
        startPath:'/index.html',
        mappings:[{
            prefix:[],
            root:canonical,
            identities,
            read:relative=>readVerifiedAppReleaseFile(releaseReceipt,{
                releaseRoot:canonical,
                relativePath:relative.join('/'),
                signal
            }),
            allow:relative=>identities.has(inventoryKey(relative.join('/')))
        }]
    };
}

function tokenMatches(value,expected){
    if(typeof value!=='string')return false;
    const received=Buffer.from(value,'utf8');
    const wanted=Buffer.from(expected,'utf8');
    return received.length===wanted.length&&timingSafeEqual(received,wanted);
}

function hasSessionCookie(request,cookieName,sessionToken){
    const matches=String(request.headers.cookie||'')
        .split(';')
        .map(part=>part.trim())
        .filter(part=>part.startsWith(`${cookieName}=`))
        .map(part=>part.slice(cookieName.length+1));
    return matches.length===1&&tokenMatches(matches[0],sessionToken);
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
    runtimeReceipt,
    releaseReceipt
}={},events,releaseSignal){
    throwIfAborted(signal);
    if(mode!=='source'&&mode!=='packaged')fail(`Unsupported server mode: ${String(mode)}.`,'ARCANE_USAGE');
    if(host!=='127.0.0.1'&&host!=='::1'){
        fail('Development server host must be a numeric loopback address (127.0.0.1 or ::1).','ARCANE_POLICY_DENIED');
    }
    if(!Number.isInteger(port)||port<0||port>65535)fail('port must be an integer from 0 through 65535.','ARCANE_USAGE');
    await events.send({type:'server.starting',mode,host,port,appId});
    const routeSet=mode==='source'
        ?await sourceRoutes(workspaceRoot,appId,{
            runtimeReceipt,
            signal,
            onEvent:event=>events.send(event)
        })
        :await packagedRoutes(releaseRoot,releaseReceipt,{signal});
    for(const mapping of routeSet.mappings){
        const info=await lstat(mapping.root);
        if(info.isSymbolicLink()||!info.isDirectory())fail(`Server route root must be a real directory: ${mapping.root}.`);
        mapping.root=await realpath(mapping.root);
    }
    const sessionToken=randomBytes(32).toString('hex');
    const sessionCookieName=`${SESSION_COOKIE}-${randomBytes(8).toString('hex')}`;
    let expectedAuthority=null;
    const requestTasks=new Set();
    const runFileWork=createFileWorkLimiter();
    const server=http.createServer((request,response)=>{
        let task;
        task=(async()=>{
            if(!expectedAuthority){deny(response,503,'Server is starting.');return;}
            if(request.headers.host!==expectedAuthority){
                deny(response,421,'Misdirected request.');
                return;
            }
            if(request.method!=='GET'&&request.method!=='HEAD'){
                deny(response,405,'Method not allowed.');
                return;
            }
            const target=parseRequestTarget(request.url);
            if(!target){deny(response,400,'Invalid request path.');return;}
            const queryKeys=[...target.searchParams.keys()];
            const isBootstrap=request.method==='GET'
                &&target.path===routeSet.startPath
                &&queryKeys.length===1
                &&queryKeys[0]==='arcane_session'
                &&tokenMatches(target.searchParams.get('arcane_session'),sessionToken);
            if(isBootstrap){
                response.writeHead(302,{
                    location:routeSet.startPath,
                    'set-cookie':`${sessionCookieName}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`,
                    ...responseSecurityHeaders()
                });
                response.end();
                return;
            }
            if(!hasSessionCookie(request,sessionCookieName,sessionToken)){
                deny(response,403,'Development server session required.');
                return;
            }
            const {segments}=target;
            if(mode==='packaged'&&segments.some(segment=>
                segment.toLowerCase()===RELEASE_MANIFEST_NAME.toLowerCase()
            )){
                deny(response,404,'Not found.');
                return;
            }
            if(segments.length===0){
                response.writeHead(302,{location:routeSet.startPath,...responseSecurityHeaders()});
                response.end();
                return;
            }
            const mapping=routeSet.mappings.find(route=>
                route.prefix.every((segment,index)=>segments[index]===segment)
            );
            if(!mapping){deny(response,404,'Not found.');return;}
            const relative=segments.slice(mapping.prefix.length);
            if(relative.length===0){deny(response,404,'Not found.');return;}
            if(mapping.allow&&!mapping.allow(relative)){deny(response,404,'Not found.');return;}
            await runFileWork(async()=>{
                const expectedIdentity=mapping.identities?.get(inventoryKey(relative.join('/')));
                const opened=mapping.read
                    ?{
                        candidate:path.join(mapping.root,...relative),
                        bytes:await mapping.read(relative)
                    }
                    :await openSafeFile(mapping.root,relative,expectedIdentity);
                if(!opened){deny(response,404,'Not found.');return;}
                opened.size=opened.bytes.length;
                await sendFile(response,opened,{head:request.method==='HEAD'});
            });
        })().catch(async error=>{
            await events.enqueue({type:'server.request.failed',message:error.message});
            if(!response.headersSent){
                const status=error?.code==='ARCANE_POLICY_DENIED'?413
                    :error?.code==='ARCANE_BACKPRESSURE'?503
                        :500;
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
    expectedAuthority=endpoint.host;
    const origin=endpoint.origin;
    const cleanUrl=`${origin}${routeSet.startPath}`;
    const url=`${cleanUrl}?arcane_session=${sessionToken}`;
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
            appId:result.appId
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
