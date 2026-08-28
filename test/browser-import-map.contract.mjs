import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {constants as fsConstants} from 'node:fs';
import {
    access,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    writeFile
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {inspect} from 'node:util';
import test from 'arcane-os/testing';
import {
    developApplication,
    packageApplication,
    runApplication,
    verifyApplication
} from 'arcane-os/toolchain';

const APP_ID='external-app';
const CHROME_CAPTURE_TIMEOUT_MS=50_000;
const CHROME_EXECUTION_TIMEOUT_MS=60_000;
const BROWSER_REPORT_TIMEOUT_MS=60_000;
const CHROME_VIRTUAL_TIME_BUDGET_MS=45_000;
const CHROME_OUTPUT_LIMIT=16*1024*1024;
const CHROME_IDENTITY_OUTPUT_LIMIT=16*1024;
const CHROME_IDENTITY_LIMIT=128;
const CHROME_STDOUT_TAIL_LIMIT=2*1024;
const CHROME_STDERR_TAIL_LIMIT=4*1024;
const REPORT_ERROR_SUMMARY_LIMIT=512;
const PROBE_FAILURE_SUMMARY_LIMIT=8*1024;
const ERROR_NAME_LIMIT=64;
const ERROR_CODE_LIMIT=128;
const REPORT_LIMIT=128*1024;
const SERVER_CLEANUP_TIMEOUT_MS=3_500;
const TASKKILL_TIMEOUT_MS=3_000;
const TASKKILL_DRAIN_TIMEOUT_MS=2_000;
const CHROME_DRAIN_TIMEOUT_MS=5_000;
const PROFILE_CLEANUP_TIMEOUT_MS=5_000;
const HOSTILE_DEPENDENCY_PATHS=Object.freeze([
    'node_modules/event-pubsub/index.js',
    'node_modules/event-pubsub/package.json',
    'node_modules/strong-type/index.js',
    'node_modules/strong-type/package.json'
]);
const REQUIRED_BROWSER_RESOURCES=Object.freeze([
    '/arcane/dependencies/strong-type/index.js',
    '/arcane/entities/Chat.js',
    '/arcane/entities/File.js',
    '/arcane/entities/User.js',
    '/arcane/modules/DBOPFS.js',
    '/arcane/modules/MD.js',
    '/arcane/modules/TimeGuard.js',
    '/arcane/sdk/dependencies/event-pubsub/index.js',
    '/arcane/sdk/dependencies/strong-type/index.js',
    '/arcane/sdk/event-manager.mjs',
    '/arcane/sdk/ai/wllama/wllama.wasm'
]);

function sha256(bytes){
    return createHash('sha256').update(bytes).digest('hex');
}

function json(value){
    return `${JSON.stringify(value,null,2)}\n`;
}

async function exists(filePath){
    try{
        await access(filePath,fsConstants.F_OK);
        return true;
    }catch(error){
        if(error?.code==='ENOENT')return false;
        throw error;
    }
}

async function assertSameRegularFileIdentity({actualPath,expectedPath,inspect=lstat}){
    const [actualInfo,expectedInfo]=await Promise.all([
        inspect(actualPath,{bigint:true}),
        inspect(expectedPath,{bigint:true})
    ]);
    assert.equal(
        actualInfo.isSymbolicLink(),
        false,
        `Resolved file must not be a final symbolic link: ${actualPath}`
    );
    assert.equal(actualInfo.isFile(),true,`Resolved path must be a regular file: ${actualPath}`);
    assert.equal(
        expectedInfo.isSymbolicLink(),
        false,
        `Expected file must not be a final symbolic link: ${expectedPath}`
    );
    assert.equal(expectedInfo.isFile(),true,`Expected path must be a regular file: ${expectedPath}`);
    assert.equal(actualInfo.dev,expectedInfo.dev,'Resolved file must be on the expected device.');
    assert.equal(actualInfo.ino,expectedInfo.ino,'Resolved file must have the expected physical identity.');
}

async function realFileInventory(root,relativeRoot=''){
    const absolute=relativeRoot
        ?path.join(root,...relativeRoot.split('/'))
        :root;
    const entries=await readdir(absolute,{withFileTypes:true});
    entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
    const files=[];
    for(const entry of entries){
        const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
        assert.equal(entry.isSymbolicLink(),false,`${relative} must not be a link.`);
        if(entry.isDirectory()){
            files.push(...await realFileInventory(root,relative));
        }else{
            assert.equal(entry.isFile(),true,`${relative} must be a regular file.`);
            files.push(relative);
        }
    }
    return files;
}

async function fileRecords(root,relativePaths){
    const records=[];
    for(const relative of [...new Set(relativePaths)].sort()){
        const absolute=path.join(root,...relative.split('/'));
        const info=await lstat(absolute);
        assert.equal(info.isSymbolicLink(),false,`${relative} must not be a link.`);
        assert.equal(info.isFile(),true,`${relative} must be a regular file.`);
        const bytes=await readFile(absolute);
        records.push({path:relative,bytes:bytes.length,sha256:sha256(bytes)});
    }
    return records;
}

async function paritySnapshot(root,{expectedArcaneFileCount}){
    const mapRelative=`apps/${APP_ID}/modules/arcane.importmap.json`;
    const htmlRelative=`apps/${APP_ID}/index.html`;
    const probeRelative=`apps/${APP_ID}/modules/App.js`;
    const mapBytes=await readFile(path.join(root,...mapRelative.split('/')));
    const map=JSON.parse(mapBytes.toString('utf8'));
    const htmlBytes=await readFile(path.join(root,...htmlRelative.split('/')));
    const managedMaps=[...htmlBytes.toString('utf8').matchAll(
        /<script\b[^>]*\bdata-arcane-import-map(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>([\s\S]*?)<\/script\s*>/giu
    )];
    assert.equal(managedMaps.length,1);
    assert.equal(managedMaps[0][1],`\n${mapBytes.toString('utf8')}`);
    assert.deepEqual(JSON.parse(managedMaps[0][1]),map);
    assert.deepEqual(Object.keys(map),['imports']);
    assert.equal(
        map.imports['./node_modules/strong-type/index.js'],
        './arcane/dependencies/strong-type/index.js'
    );
    assert.equal(
        map.imports['arcane-os/event-manager'],
        './arcane/sdk/event-manager.mjs'
    );
    assert.equal(
        map.imports['arcane-os/ai/browser-wasm'],
        './arcane/sdk/ai/browser-wasm.mjs'
    );
    assert.equal(
        map.imports['arcane-os/ai/browser-speech'],
        './arcane/sdk/ai/browser-speech.mjs'
    );
    assert.equal(
        map.imports['#arcane/persistent-ai-chat-session'],
        './arcane/modules/PersistentAIChatSession.js'
    );
    assert.equal(
        map.imports['arcane/DBOPFSDocumentLibrary'],
        './arcane/modules/DBOPFSDocumentLibrary.js'
    );
    assert.equal(
        map.imports['arcane/DocumentLexicalSearch'],
        './arcane/modules/DocumentLexicalSearch.js'
    );
    assert.equal(
        map.imports['arcane/entities/Chat'],
        './arcane/entities/Chat.js'
    );
    assert.equal(
        map.imports['event-pubsub'],
        './arcane/sdk/dependencies/event-pubsub/index.js'
    );
    assert.equal(map.imports['strong-type'],undefined);
    assert.equal(map.imports['arcane-os'],undefined);
    for(const specifier of [
        'arcane/DBOPFS',
        'arcane/MD',
        'arcane/TimeGuard',
        'arcane/entities/User'
    ])assert.equal(typeof map.imports[specifier],'string',specifier);

    const arcaneFiles=await realFileInventory(path.join(root,'arcane'));
    assert.equal(arcaneFiles.length,expectedArcaneFileCount);
    const mappedTargets=Object.values(map.imports).map(target=>{
        assert.match(target,/^\.\/arcane\//u);
        return target.slice(2);
    });
    return {
        importCount:Object.keys(map.imports).length,
        contract:await fileRecords(root,[mapRelative,htmlRelative,probeRelative]),
        mappedTargets:await fileRecords(root,mappedTargets),
        arcane:await fileRecords(
            root,
            arcaneFiles.map(relative=>`arcane/${relative}`)
        )
    };
}

async function writeHostileDependencies(workspaceRoot){
    const traps=new Map([
        ['strong-type',{
            package:{
                name:'strong-type',
                version:'2.0.1',
                type:'module',
                main:'./index.js',
                exports:{'.':'./index.js'}
            },
            source:"throw new Error('HOSTILE_ROOT_STRONG_TYPE_EXECUTED');\n"
        }],
        ['event-pubsub',{
            package:{
                name:'event-pubsub',
                version:'6.1.0',
                type:'module',
                main:'./index.js',
                exports:{'.':'./index.js'}
            },
            source:"throw new Error('HOSTILE_ROOT_EVENT_PUBSUB_EXECUTED');\n"
        }]
    ]);
    for(const [name,trap] of traps){
        const root=path.join(workspaceRoot,'node_modules',name);
        const info=await lstat(root).catch(error=>{
            if(error?.code==='ENOENT')return null;
            throw error;
        });
        assert.equal(Boolean(info?.isSymbolicLink()),false,`${name} dependency root must not be linked.`);
        await mkdir(root,{recursive:true});
        await writeFile(path.join(root,'package.json'),json(trap.package));
        await writeFile(path.join(root,'index.js'),trap.source);
    }
    return fileRecords(workspaceRoot,HOSTILE_DEPENDENCY_PATHS);
}

async function configureProbe(workspaceRoot,reportUrl,reportToken){
    const appRoot=path.join(workspaceRoot,'apps',APP_ID);
    const descriptorPath=path.join(appRoot,'arcane-app.json');
    const packagePath=path.join(appRoot,'arcane-package.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    const packageDocument=JSON.parse(await readFile(packagePath,'utf8'));
    const reportOrigin=new URL(reportUrl).origin;
    descriptor.security.connectOrigins=[reportOrigin];
    packageDocument.security.connectOrigins=[reportOrigin];
    await writeFile(descriptorPath,json(descriptor));
    await writeFile(packagePath,json(packageDocument));

    const probe=`const REPORT_URL=${JSON.stringify(reportUrl)};
const REPORT_TOKEN=${JSON.stringify(reportToken)};

function requireCondition(value,message){
    if(!value)throw new Error(message);
}

async function fetchJson(requestPath){
    const response=await fetch(requestPath,{cache:'no-store'});
    requireCondition(response.ok,\`\${requestPath} returned \${response.status}.\`);
    return response.json();
}

async function sendReport(report){
    const response=await fetch(REPORT_URL,{
        method:'POST',
        mode:'cors',
        cache:'no-store',
        headers:{'content-type':'text/plain;charset=UTF-8'},
        body:JSON.stringify({...report,token:REPORT_TOKEN})
    });
    requireCondition(response.ok,\`Browser sentinel returned \${response.status}.\`);
}

try{
    const [
        eventManagerModule,
        dbopfsModule,
        mdModule,
        timeGuardModule,
        fileModule,
        chatModule,
        userModule,
        browserAiModule,
        browserSpeechModule
    ]=await Promise.all([
        import('arcane-os/event-manager'),
        import('arcane/DBOPFS'),
        import('arcane/MD'),
        import('arcane/TimeGuard'),
        import('../../../arcane/entities/File.js'),
        import('../../../arcane/entities/Chat.js'),
        import('arcane/entities/User'),
        import('arcane-os/ai/browser-wasm'),
        import('arcane-os/ai/browser-speech')
    ]);
    const {ARCANE_EVENT_STACK_PROTOCOL,createEventManager}=eventManagerModule;
    const {default:DBOPFS}=dbopfsModule;
    const {default:MD}=mdModule;
    const {default:TimeGuard}=timeGuardModule;
    const {default:FileEntity}=fileModule;
    const {default:ChatEntity}=chatModule;
    const {default:UserEntity}=userModule;
    const {BROWSER_WASM_RUNTIME_AUTHORITY}=browserAiModule;
    requireCondition(
        typeof browserSpeechModule.createBrowserWhisperProvider==='function'
            &&typeof browserSpeechModule.createBrowserKokoroProvider==='function',
        'The authenticated browser-speech entry did not expose both provider factories.'
    );
    const constructors={
        DBOPFS:typeof DBOPFS,
        MD:typeof MD,
        TimeGuard:typeof TimeGuard,
        File:typeof FileEntity,
        Chat:typeof ChatEntity,
        User:typeof UserEntity
    };
    requireCondition(
        Object.values(constructors).every(value=>value==='function'),
        'One or more Arcane runtime importer modules did not execute.'
    );

    const manager=createEventManager({
        timeTravel:true,
        sessionId:'arcane-browser-import-map-contract'
    });
    let observed=null;
    manager.once('arcane.browser.import-map.proof',value=>{observed=value;});
    manager.emit('arcane.browser.import-map.proof',42);
    requireCondition(observed===42,'EventManager did not dispatch through event-pubsub.');

    const [runtimeStrongType,eventPubSub,sdkStrongType]=await Promise.all([
        fetchJson('./arcane/dependencies/strong-type/package.json'),
        fetchJson('./arcane/sdk/dependencies/event-pubsub/package.json'),
        fetchJson('./arcane/sdk/dependencies/strong-type/package.json')
    ]);
    requireCondition(runtimeStrongType.version==='1.1.0','Arcane runtime strong-type identity drifted.');
    requireCondition(eventPubSub.version==='6.1.0','SDK event-pubsub identity drifted.');
    requireCondition(sdkStrongType.version==='2.0.0','SDK sibling strong-type identity drifted.');

    const documentResponse=await fetch(location.href,{cache:'no-store'});
    requireCondition(documentResponse.ok,'The Arcane browser server did not return its document.');
    const policy=documentResponse.headers.get('content-security-policy')||'';
    const scriptDirective=policy.split(';')
        .map(value=>value.trim())
        .find(value=>value.startsWith('script-src '));
    const scriptTokens=(scriptDirective||'').split(/\\s+/u).slice(1);
    requireCondition(
        JSON.stringify(scriptTokens)===JSON.stringify([
            "'self'","'unsafe-inline'","'wasm-unsafe-eval'"
        ]),
        'The Arcane browser server did not return the narrow WebAssembly CSP: '
            +JSON.stringify(scriptTokens)+'.'
    );
    requireCondition(!scriptTokens.includes("'unsafe-eval'"),'Broad string evaluation was enabled.');

    let evalError=null;
    let functionError=null;
    try{globalThis.eval('1');}
    catch(error){evalError=error;}
    try{new Function('return 1')();}
    catch(error){functionError=error;}
    requireCondition(evalError?.name==='EvalError','CSP did not deny indirect string eval.');
    requireCondition(functionError?.name==='EvalError','CSP did not deny Function construction.');

    const wasmUrl=BROWSER_WASM_RUNTIME_AUTHORITY.runtimeAssets.wasm.url;
    const reflectedResponse=await fetch(wasmUrl,{cache:'no-store'});
    requireCondition(reflectedResponse.ok,'The authenticated Wllama WASM was not served.');
    requireCondition(
        reflectedResponse.headers.get('content-type')==='application/wasm',
        'The authenticated Wllama WASM media type drifted.'
    );
    const wasmBytes=await reflectedResponse.arrayBuffer();
    requireCondition(
        wasmBytes.byteLength===BROWSER_WASM_RUNTIME_AUTHORITY.runtimeAssets.wasm.bytes,
        'The authenticated Wllama WASM byte length drifted.'
    );
    const wasmSha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',wasmBytes))]
        .map(value=>value.toString(16).padStart(2,'0'))
        .join('');
    requireCondition(
        wasmSha256===BROWSER_WASM_RUNTIME_AUTHORITY.runtimeAssets.wasm.sha256,
        'The authenticated Wllama WASM digest drifted.'
    );
    const reflectedModule=await WebAssembly.compile(wasmBytes);
    requireCondition(
        reflectedModule instanceof WebAssembly.Module,
        'The authenticated Wllama WASM did not compile.'
    );

    const trapFetches={
        strongType:(await fetch('./node_modules/strong-type/index.js',{cache:'no-store'})).status,
        eventPubSub:(await fetch('./node_modules/event-pubsub/index.js',{cache:'no-store'})).status
    };
    requireCondition(trapFetches.strongType===404,'Root strong-type trap was web-reachable.');
    requireCondition(trapFetches.eventPubSub===404,'Root event-pubsub trap was web-reachable.');
    await new Promise(resolve=>setTimeout(resolve,50));

    const localResources=[...new Set(
        performance.getEntriesByType('resource')
            .filter(entry=>new URL(entry.name).origin===location.origin)
            .map(entry=>{
                const resource=new URL(entry.name);
                return \`\${entry.initiatorType}:\${resource.pathname}\${resource.search}\`;
            })
    )].sort();
    const contractResources=localResources.filter(value=>
        value.startsWith('script:')||value.startsWith('fetch:'));
    const nodeModuleResources=localResources.filter(value=>value.includes(':/node_modules/'));
    requireCondition(
        nodeModuleResources.every(value=>value.startsWith('fetch:')),
        'A script or module loaded from the hostile root node_modules tree.'
    );
    for(const required of ${JSON.stringify(REQUIRED_BROWSER_RESOURCES)}){
        requireCondition(
            contractResources.some(
                value=>value.split(':').slice(1).join(':').split('?')[0]===required
            ),
            \`Required browser resource \${required} was not loaded.\`
        );
    }

    document.documentElement.dataset.arcaneBrowserContract='passed';
    await sendReport({
        ok:true,
        protocol:ARCANE_EVENT_STACK_PROTOCOL,
        observed,
        eventCount:manager.eventCount,
        eventType:manager.history[0]?.type,
        constructors,
        versions:{
            runtimeStrongType:runtimeStrongType.version,
            eventPubSub:eventPubSub.version,
            sdkStrongType:sdkStrongType.version
        },
        userAgent:navigator.userAgent,
        csp:{
            scriptTokens,
            evalError:evalError.name,
            functionError:functionError.name,
            wasmBytes:wasmBytes.byteLength,
            wasmSha256,
            compiled:true
        },
        trapFetches,
        resources:contractResources,
        nodeModuleResources
    });
}catch(error){
    document.documentElement.dataset.arcaneBrowserContract='failed';
    await sendReport({
        ok:false,
        error:{name:error?.name??'Error',message:error?.message??String(error)}
    });
    throw error;
}
`;
    await writeFile(path.join(appRoot,'modules','App.js'),probe);
}

function closeServer(server){
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    if(!server.listening)return Promise.resolve();
    return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{
            server.closeAllConnections?.();
            reject(new Error(`Browser contract server did not close within ${SERVER_CLEANUP_TIMEOUT_MS}ms.`));
        },SERVER_CLEANUP_TIMEOUT_MS);
        server.close(error=>{
            clearTimeout(timer);
            if(error&&error.code!=='ERR_SERVER_NOT_RUNNING')reject(error);
            else resolve();
        });
    });
}

async function closeApplicationServer(instance){
    const forceTimer=setTimeout(()=>{
        instance.server?.closeIdleConnections?.();
        instance.server?.closeAllConnections?.();
    },1_000);
    let timeoutTimer;
    try{
        await Promise.race([
            (async()=>{
                await instance.close();
                await instance.lifecycle;
            })(),
            new Promise((resolve,reject)=>{
                timeoutTimer=setTimeout(()=>{
                    instance.server?.closeAllConnections?.();
                    reject(new Error(
                        `Arcane browser server lifecycle did not settle within ${SERVER_CLEANUP_TIMEOUT_MS}ms.`
                    ));
                },SERVER_CLEANUP_TIMEOUT_MS);
            })
        ]);
    }finally{
        clearTimeout(forceTimer);
        clearTimeout(timeoutTimer);
    }
}

async function createSentinel(){
    const token=randomBytes(32).toString('hex');
    const requestPath=`/arcane-browser-contract/${token}`;
    const reports=[];
    const waiters=[];
    const server=http.createServer((request,response)=>{
        response.setHeader('access-control-allow-origin','*');
        response.setHeader('cache-control','no-store');
        if(request.method==='OPTIONS'){
            response.writeHead(204,{
                'access-control-allow-methods':'POST, OPTIONS',
                'access-control-allow-headers':'content-type'
            });
            response.end();
            return;
        }
        if(request.method!=='POST'||request.url!==requestPath){
            response.writeHead(404);
            response.end();
            return;
        }
        let bytes=0;
        const chunks=[];
        request.on('data',chunk=>{
            bytes+=chunk.length;
            if(bytes>REPORT_LIMIT){
                request.destroy(new Error('Browser sentinel report exceeded its byte limit.'));
                return;
            }
            chunks.push(chunk);
        });
        request.on('end',()=>{
            let report;
            try{
                report=JSON.parse(Buffer.concat(chunks).toString('utf8'));
                assert.equal(report?.token,token);
            }catch{
                response.writeHead(400);
                response.end();
                return;
            }
            response.writeHead(204);
            response.end();
            const waiter=waiters.shift();
            if(waiter)waiter.resolve(report);
            else reports.push(report);
        });
    });
    await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
    });
    const address=server.address();
    assert.ok(address&&typeof address!=='string');
    return {
        token,
        url:`http://127.0.0.1:${address.port}${requestPath}`,
        next(label='browser probe'){
            if(reports.length>0)return Promise.resolve(reports.shift());
            return new Promise((resolve,reject)=>{
                const waiter={resolve,reject};
                waiters.push(waiter);
                const timer=setTimeout(()=>{
                    const index=waiters.indexOf(waiter);
                    if(index>=0)waiters.splice(index,1);
                    reject(new Error(
                        `${label} did not deliver its browser report within ${BROWSER_REPORT_TIMEOUT_MS}ms.`
                    ));
                },BROWSER_REPORT_TIMEOUT_MS);
                waiter.resolve=value=>{
                    clearTimeout(timer);
                    resolve(value);
                };
                waiter.reject=error=>{
                    clearTimeout(timer);
                    reject(error);
                };
            });
        },
        async close(){
            const error=new Error('Browser sentinel closed before receiving its report.');
            for(const waiter of waiters.splice(0))waiter.reject(error);
            await closeServer(server);
        }
    };
}

const trackedProcesses=new WeakSet();
const closedProcesses=new WeakSet();

function trackProcessClose(child){
    if(!child||trackedProcesses.has(child))return child;
    trackedProcesses.add(child);
    if(child.closed===true)closedProcesses.add(child);
    child.once?.('close',()=>closedProcesses.add(child));
    return child;
}

function processClosed(child){
    trackProcessClose(child);
    return Boolean(child)&&(closedProcesses.has(child)||child.closed===true);
}

function waitForProcessClose(child,{timeout,label}){
    if(processClosed(child))return Promise.resolve();
    return new Promise((resolve,reject)=>{
        let settled=false;
        const finish=error=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            child.removeListener?.('close',onClose);
            if(error)reject(error);
            else resolve();
        };
        const onClose=()=>finish();
        const timer=setTimeout(()=>finish(new Error(`${label} did not drain within ${timeout}ms.`)),timeout);
        child.once('close',onClose);
        if(processClosed(child))finish();
    });
}

async function terminateTaskkillHelper(killer,{timeout,label}){
    let killError=null;
    if(!processClosed(killer)){
        try{
            if(killer.kill('SIGKILL')===false){
                killError=new Error(`${label} refused forced termination.`);
            }
        }catch(error){
            killError=error;
        }
    }
    let drainError=null;
    try{await waitForProcessClose(killer,{timeout,label});}
    catch(error){drainError=error;}
    if(killError&&drainError){
        throw new AggregateError([killError,drainError],`${label} could not be terminated and drained.`);
    }
    if(killError)throw killError;
    if(drainError)throw drainError;
}

async function runWindowsTaskkill(pid,{
    spawnProcess=spawn,
    timeout=TASKKILL_TIMEOUT_MS,
    drainTimeout=TASKKILL_DRAIN_TIMEOUT_MS
}={}){
    let killer;
    try{
        killer=spawnProcess('taskkill',['/pid',String(pid),'/t','/f'],{
            stdio:'ignore',windowsHide:true
        });
        trackProcessClose(killer);
    }catch(error){
        throw new Error(`Could not start taskkill for Google Chrome process tree ${pid}.`,{cause:error});
    }
    const outcome=await new Promise(resolve=>{
        let settled=false;
        const finish=value=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer=setTimeout(()=>finish({kind:'timeout'}),timeout);
        killer.once('error',error=>finish({kind:'spawn-error',error}));
        killer.once('close',(code,signal)=>finish({kind:'close',code,signal}));
    });
    if(outcome.kind==='close'){
        if(outcome.code===0&&outcome.signal===null)return;
        throw new Error(
            `taskkill failed for Google Chrome process tree ${pid} `+
            `(exit ${String(outcome.code)}, signal ${String(outcome.signal)}).`
        );
    }
    let helperError=null;
    try{
        await terminateTaskkillHelper(killer,{
            timeout:drainTimeout,
            label:`taskkill helper for Google Chrome process tree ${pid}`
        });
    }catch(error){helperError=error;}
    const taskkillError=outcome.kind==='spawn-error'
        ?new Error(`taskkill could not start for Google Chrome process tree ${pid}.`,{
            cause:outcome.error
        })
        :new Error(`taskkill exceeded ${timeout}ms for Google Chrome process tree ${pid}.`);
    if(helperError){
        throw new AggregateError(
            [taskkillError,helperError],
            `taskkill failed and its helper did not drain for Google Chrome process tree ${pid}.`
        );
    }
    throw taskkillError;
}

async function terminateProcessTree(child,{
    platform=process.platform,
    spawnProcess=spawn,
    killGroup=process.kill,
    taskkillTimeout=TASKKILL_TIMEOUT_MS,
    taskkillDrainTimeout=TASKKILL_DRAIN_TIMEOUT_MS,
    chromeDrainTimeout=CHROME_DRAIN_TIMEOUT_MS
}={}){
    if(!child)return;
    trackProcessClose(child);
    let terminationError=null;
    if(!child.pid){
        // A ChildProcess can emit `error` before a PID is assigned. It still owns
        // a close lifecycle, so drain it instead of rejecting while it is live.
    }else if(platform==='win32'){
        try{
            await runWindowsTaskkill(child.pid,{
                spawnProcess,
                timeout:taskkillTimeout,
                drainTimeout:taskkillDrainTimeout
            });
        }catch(error){
            terminationError=error;
            try{child.kill('SIGKILL');}catch{}
        }
    }else{
        try{killGroup(-child.pid,'SIGKILL');}
        catch(error){
            terminationError=error;
            try{
                if(child.kill('SIGKILL')===false){
                    terminationError=new AggregateError(
                        [error,new Error(`Google Chrome leader ${child.pid} refused forced termination.`)],
                        `Google Chrome process group ${child.pid} and its leader could not be terminated.`
                    );
                }
            }catch(fallbackError){
                terminationError=new AggregateError(
                    [error,fallbackError],
                    `Google Chrome process group ${child.pid} and its leader could not be terminated.`
                );
            }
        }
    }
    let drainError=null;
    try{
        await waitForProcessClose(child,{
            timeout:chromeDrainTimeout,
            label:`Google Chrome process tree ${child.pid??'without a PID'}`
        });
    }catch(error){drainError=error;}
    if(terminationError&&drainError){
        throw new AggregateError(
            [terminationError,drainError],
            `Google Chrome process tree ${child.pid} could not be terminated and drained.`
        );
    }
    if(terminationError)throw terminationError;
    if(drainError)throw drainError;
}

function redactDiagnosticText(value,redactions=[]){
    let text=String(value??'');
    const secrets=[...new Set(redactions.map(value=>String(value??'')).filter(Boolean))]
        .sort((left,right)=>right.length-left.length);
    for(const secret of secrets)text=text.split(secret).join('[redacted]');
    return text;
}

function boundedUtf8Tail(value,limit){
    const bytes=Buffer.from(String(value??''));
    if(bytes.length<=limit)return bytes.toString();
    let start=bytes.length-limit;
    while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start+=1;
    return bytes.subarray(start).toString();
}

function boundedOutputRecord(chunks,{limit,redactions=[],observedBytes,suppressTail=false}){
    const raw=Buffer.concat(chunks);
    const bytes=observedBytes??raw.length;
    const redacted=suppressTail?'':redactDiagnosticText(raw.toString(),redactions);
    const tail=suppressTail
        ?'[suppressed after output limit]'
        :boundedUtf8Tail(redacted,limit);
    return Object.freeze({
        bytes,
        retainedBytes:raw.length,
        droppedBytes:Math.max(0,bytes-raw.length),
        tailBytes:Buffer.byteLength(tail),
        truncated:suppressTail||bytes>raw.length||Buffer.byteLength(redacted)>limit,
        tail
    });
}

function boundedProcessDiagnostics({
    stdout,stderr,stdoutBytes,stderrBytes,suppressedStream,redactions=[]
}){
    const record=(stream,chunks,bytes,limit)=>boundedOutputRecord(chunks,{
        limit,
        redactions,
        observedBytes:bytes,
        suppressTail:suppressedStream===stream
    });
    return Object.freeze({
        stdout:record('stdout',stdout,stdoutBytes,CHROME_STDOUT_TAIL_LIMIT),
        stderr:record('stderr',stderr,stderrBytes,CHROME_STDERR_TAIL_LIMIT)
    });
}

function formatOutputRecord(label,record){
    const scope=record.truncated?'bounded tail':'complete output';
    return `${label}: ${record.bytes} bytes observed, ${record.retainedBytes} retained, `+
        `${record.droppedBytes} dropped; ${scope} ${record.tailBytes} bytes\n`+
        (record.tail||'[empty]');
}

function boundedFailureSummary(error,{redactions=[],limit=PROBE_FAILURE_SUMMARY_LIMIT}={}){
    return boundedUtf8Head(redactDiagnosticText(error?.message??error,redactions),limit);
}

function sanitizedErrorProjection(error,{redactions=[],limit=PROBE_FAILURE_SUMMARY_LIMIT}={}){
    const clean=(value,size)=>boundedUtf8Head(
        redactDiagnosticText(value,redactions).replace(/[\u0000-\u001f\u007f]/gu,'?'),
        size
    );
    const projection=new Error(
        boundedFailureSummary(error,{redactions,limit})||'[no error message]'
    );
    projection.name=clean(error?.name??'Error',ERROR_NAME_LIMIT)||'Error';
    if(error?.stack)projection.stack=boundedUtf8Head(
        redactDiagnosticText(error.stack,redactions),
        limit
    );
    if(typeof error?.code==='string'||typeof error?.code==='number'){
        projection.code=clean(error.code,ERROR_CODE_LIMIT);
    }
    return projection;
}

function assertSafeDiagnostic(error,secrets,label='diagnostic error'){
    const rendered=[
        error?.message,
        error?.stack,
        JSON.stringify(error),
        inspect(error,{depth:8,showHidden:true})
    ].join('\n');
    for(const secret of secrets.filter(Boolean)){
        assert.equal(rendered.includes(secret),false,`${label} retained a secret.`);
    }
}

function boundedProcessError(message,{
    label,startedAt,stdout,stderr,stdoutBytes,stderrBytes,suppressedStream,
    redactions=[],elapsedMs:measuredElapsedMs,cause,
    clock=performance.now.bind(performance)
}){
    const elapsedMs=measuredElapsedMs??Math.max(0,Math.round(clock()-startedAt));
    const diagnostics=boundedProcessDiagnostics({
        stdout,stderr,stdoutBytes,stderrBytes,suppressedStream,redactions
    });
    const error=new Error(
        `${label} ${message} after ${elapsedMs}ms.\n`+
        `${formatOutputRecord('stdout',diagnostics.stdout)}\n`+
        formatOutputRecord('stderr',diagnostics.stderr)
    );
    if(cause)error.cause=sanitizedErrorProjection(cause,{redactions});
    Object.assign(error,{elapsedMs,diagnostics});
    return error;
}

function runBounded(command,args,{
    timeout=CHROME_EXECUTION_TIMEOUT_MS,
    maxOutput=CHROME_OUTPUT_LIMIT,
    env=process.env,
    label='Google Chrome',
    redactions=[],
    spawnProcess=spawn,
    terminateProcess=terminateProcessTree,
    clock=performance.now.bind(performance)
}={}){
    return new Promise((resolve,reject)=>{
        let settled=false;
        let outputBytes=0;
        let stdoutBytes=0;
        let stderrBytes=0;
        const stdout=[];
        const stderr=[];
        const startedAt=clock();
        let child;
        const processError=(message,options={})=>boundedProcessError(message,{
            label,
            startedAt,
            stdout,
            stderr,
            stdoutBytes,
            stderrBytes,
            redactions,
            clock,
            ...options
        });
        try{
            child=trackProcessClose(spawnProcess(command,args,{
                stdio:['ignore','pipe','pipe'],
                windowsHide:true,
                detached:process.platform!=='win32',
                env
            }));
        }catch(error){
            reject(processError(
                `could not start: ${boundedFailureSummary(error,{redactions})}`,
                {cause:error}
            ));
            return;
        }
        const rejectAfterDrain=(primary,context)=>{
            void terminateProcess(child).then(
                ()=>reject(primary),
                drainError=>{
                    const error=new AggregateError(
                        [
                            sanitizedErrorProjection(primary,{redactions}),
                            sanitizedErrorProjection(drainError,{redactions})
                        ],
                        `${label} ${context}.\nExecution failure: ${primary.message}\n`+
                        `Drain failure: ${boundedFailureSummary(drainError,{redactions})}`
                    );
                    error.elapsedMs=primary.elapsedMs;
                    error.diagnostics=primary.diagnostics;
                    reject(error);
                }
            );
        };
        const abort=(primary,context)=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            rejectAfterDrain(primary,context);
        };
        const timer=setTimeout(()=>{
            const timeoutError=processError(
                `exceeded the ${timeout}ms execution limit`,
                {}
            );
            abort(timeoutError,'timed out and its process tree did not drain');
        },timeout);
        const collect=(stream,target,chunk)=>{
            if(settled)return;
            const bytes=Buffer.byteLength(chunk);
            outputBytes+=bytes;
            if(stream==='stdout')stdoutBytes+=bytes;
            else stderrBytes+=bytes;
            if(outputBytes>maxOutput){
                const outputError=processError(
                    `exceeded the ${maxOutput}-byte output limit`,
                    {suppressedStream:stream}
                );
                abort(
                    outputError,
                    'exceeded its output limit and its process tree did not drain'
                );
                return;
            }
            target.push(chunk);
        };
        child.stdout.on('data',chunk=>collect('stdout',stdout,chunk));
        child.stderr.on('data',chunk=>collect('stderr',stderr,chunk));
        child.once('error',error=>{
            const executionError=processError(
                `failed to execute: ${boundedFailureSummary(error,{redactions})}`,
                {cause:error}
            );
            abort(executionError,'failed and its process tree did not drain');
        });
        child.once('close',(code,signal)=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            resolve({
                code,
                signal,
                elapsedMs:Math.max(0,Math.round(clock()-startedAt)),
                stdout:Buffer.concat(stdout).toString('utf8'),
                stderr:Buffer.concat(stderr).toString('utf8')
            });
        });
    });
}

async function selectRegularChromeCandidate({configured,candidates,inspect=lstat}){
    const inspectedCandidates=configured?[configured]:candidates;
    for(const candidate of inspectedCandidates.filter(Boolean)){
        let info;
        try{info=await inspect(candidate);}
        catch(error){
            if(error?.code==='ENOENT'&&!configured)continue;
            if(error?.code==='ENOENT'){
                throw new Error(`ARCANE_CHROME_PATH does not identify a file: ${candidate}`);
            }
            throw error;
        }
        const reason=info.isSymbolicLink()
            ?'is a symbolic link':!info.isFile()?'is not a regular file':null;
        if(reason&&configured){
            throw new Error(`ARCANE_CHROME_PATH ${reason}: ${candidate}`);
        }
        if(reason)continue;
        return candidate;
    }
    return null;
}

function chromeIdentityProbeError(message,result,{redactions=[]}={}){
    return boundedProcessError(message,{
        label:'Google Chrome identity probe',
        elapsedMs:result?.elapsedMs??0,
        stdout:[Buffer.from(String(result?.stdout??''))],
        stderr:[Buffer.from(String(result?.stderr??''))],
        redactions
    });
}

function validateChromeIdentityProbeResult(result,{redactions=[]}={}){
    if(result?.code!==0||result?.signal!==null){
        throw chromeIdentityProbeError(
            `exited with code ${String(result?.code)} and signal ${String(result?.signal)}`,
            result,
            {redactions}
        );
    }
    return result;
}

function parseChromeIdentityMetadata(result,{redactions=[]}={}){
    validateChromeIdentityProbeResult(result,{redactions});
    let metadata;
    try{metadata=JSON.parse(result.stdout);}
    catch{
        throw chromeIdentityProbeError('returned invalid JSON metadata',result,{redactions});
    }
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)){
        throw chromeIdentityProbeError('returned non-object JSON metadata',result,{redactions});
    }
    for(const field of ['ProductName','FileDescription']){
        if(!/^Google Chrome(?: for Testing)?$/u.test(String(metadata[field]??''))){
            throw chromeIdentityProbeError(
                `returned an invalid ${field} field`,
                result,
                {redactions}
            );
        }
    }
    return metadata;
}

function canonicalChromeIdentity(value){
    const text=String(value??'');
    if(/\b(?:Edge|Chromium)\b/iu.test(text)){
        throw new Error('Google Chrome returned a conflicting browser identity.');
    }
    const matches=[...text.matchAll(
        /\bGoogle Chrome(?: for Testing)?\s+\d+(?:\.\d+){2,}\b/gu
    )];
    if(matches.length!==1){
        throw new Error('Google Chrome returned an ambiguous or invalid identity.');
    }
    const identity=matches[0][0];
    if(Buffer.byteLength(identity)>CHROME_IDENTITY_LIMIT){
        throw new Error(`Google Chrome identity exceeds ${CHROME_IDENTITY_LIMIT} bytes.`);
    }
    return identity;
}

async function findGoogleChrome(){
    const configured=process.env.ARCANE_CHROME_PATH;
    const candidates=process.platform==='win32'?
        [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            process.env.LOCALAPPDATA
                ?path.join(process.env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe')
                :null
        ]:
        process.platform==='darwin'?
            ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']:
            [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/opt/google/chrome/google-chrome',
                '/opt/google/chrome/chrome'
            ];
    const chromePath=await selectRegularChromeCandidate({configured,candidates});
    assert.ok(
        chromePath,
        configured
            ?`ARCANE_CHROME_PATH does not identify a file: ${configured}`
            :'Google Chrome is required; set ARCANE_CHROME_PATH to its executable.'
    );
    let identity;
    if(process.platform==='win32'){
        const inspected=await runBounded(
            'powershell.exe',
            [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                "$item=Get-Item -LiteralPath $env:ARCANE_CHROME_IDENTITY_PATH; [pscustomobject]@{ProductName=$item.VersionInfo.ProductName;ProductVersion=$item.VersionInfo.ProductVersion;FileDescription=$item.VersionInfo.FileDescription}|ConvertTo-Json -Compress"
            ],
            {
                timeout:5_000,
                maxOutput:CHROME_IDENTITY_OUTPUT_LIMIT,
                label:'Google Chrome identity probe',
                env:{...process.env,ARCANE_CHROME_IDENTITY_PATH:chromePath}
            }
        );
        const metadata=parseChromeIdentityMetadata(inspected);
        identity=canonicalChromeIdentity(`${metadata.ProductName} ${metadata.ProductVersion}`);
    }else{
        const version=await runBounded(chromePath,['--version'],{
            timeout:5_000,
            maxOutput:CHROME_IDENTITY_OUTPUT_LIMIT,
            label:'Google Chrome identity probe'
        });
        validateChromeIdentityProbeResult(version);
        identity=canonicalChromeIdentity(`${version.stdout}\n${version.stderr}`);
    }
    return {
        chromePath,
        identity,
        major:Number(identity.match(/\s(\d+)\./u)?.[1])
    };
}

function withDeadline(work,{timeout,label}){
    return new Promise((resolve,reject)=>{
        let settled=false;
        const finish=(error,value)=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            if(error)reject(error);
            else resolve(value);
        };
        const timer=setTimeout(()=>{
            finish(new Error(`${label} exceeded ${timeout}ms.`));
        },timeout);
        Promise.resolve()
            .then(work)
            .then(value=>finish(null,value),finish);
    });
}

async function completeWithCleanup(operation,cleanup,message,{redactions=[]}={}){
    let value;
    let operationError=null;
    try{value=await operation();}
    catch(error){operationError=error;}
    let cleanupError=null;
    try{await cleanup();}
    catch(error){cleanupError=error;}
    if(operationError&&cleanupError){
        throw new AggregateError(
            [
                sanitizedErrorProjection(operationError,{redactions}),
                sanitizedErrorProjection(cleanupError,{redactions})
            ],
            `${message}\nOperation failure: `+
            `${boundedFailureSummary(operationError,{redactions})}\nCleanup failure: `+
            boundedFailureSummary(cleanupError,{redactions})
        );
    }
    if(operationError)throw sanitizedErrorProjection(operationError,{redactions});
    if(cleanupError)throw sanitizedErrorProjection(cleanupError,{redactions});
    return value;
}

async function settleCleanup(cleanups,message,{redactions=[]}={}){
    const results=await Promise.allSettled(
        cleanups.map(cleanup=>Promise.resolve().then(cleanup))
    );
    const failures=results
        .filter(result=>result.status==='rejected')
        .map(result=>result.reason);
    if(failures.length===1){
        throw sanitizedErrorProjection(failures[0],{redactions});
    }
    if(failures.length>1){
        const summaries=failures.map(
            (failure,index)=>`Cleanup ${index+1}: ${boundedFailureSummary(failure,{redactions})}`
        );
        throw new AggregateError(
            failures.map(failure=>sanitizedErrorProjection(failure,{redactions})),
            `${message}\n${summaries.join('\n')}`
        );
    }
}

function chromeLaunchArguments({
    profile,
    url,
    platform=process.platform,
    isRoot=typeof process.getuid==='function'&&process.getuid()===0
}){
    return [
        '--headless=new',
        '--dump-dom',
        `--timeout=${CHROME_CAPTURE_TIMEOUT_MS}`,
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
        `--virtual-time-budget=${CHROME_VIRTUAL_TIME_BUDGET_MS}`,
        `--user-data-dir=${profile}`,
        ...(platform==='darwin'?['--use-mock-keychain']:[]),
        ...(isRoot?['--no-sandbox']:[]),
        url
    ];
}

function validateChromeProcessResult(result,{label,redactions=[]}){
    const rejectResult=message=>{
        throw boundedProcessError(message,{
            label,
            elapsedMs:result.elapsedMs,
            stdout:[Buffer.from(result.stdout)],
            stderr:[Buffer.from(result.stderr)],
            redactions
        });
    };
    if(result.code!==0||result.signal!==null){
        rejectResult(
            `exited with code ${String(result.code)} and signal ${String(result.signal)}`
        );
    }
    if(!/<html\b/iu.test(result.stdout)){
        rejectResult('did not emit an HTML document');
    }
    if(!/data-arcane-browser-contract="passed"/u.test(result.stdout)){
        rejectResult('did not emit the passed DOM contract marker');
    }
    return result;
}

async function launchChrome({chromePath,chromeIdentity,url,stage,redactions=[]}){
    const profile=await mkdtemp(path.join(os.tmpdir(),'arcane-google-chrome-'));
    const label=`${stage} using ${chromeIdentity}`;
    const executionRedactions=[...redactions,profile];
    return completeWithCleanup(async()=>{
        const args=chromeLaunchArguments({profile,url});
        const result=await runBounded(chromePath,args,{
            label,
            redactions:executionRedactions
        });
        validateChromeProcessResult(result,{label,redactions:executionRedactions});
        return Object.freeze({
            ...result,
            stage,
            chromeIdentity,
            htmlDocument:true,
            domContractPassed:true
        });
    },()=>withDeadline(
        ()=>rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}),
        {
            timeout:PROFILE_CLEANUP_TIMEOUT_MS,
            label:`${stage} profile cleanup`
        }
    ),`${stage} execution and profile cleanup both failed.`,{
        redactions:executionRedactions
    });
}

function boundedUtf8Head(value,limit){
    const bytes=Buffer.from(String(value??''),'utf8');
    if(bytes.length<=limit)return bytes.toString('utf8');
    let end=limit;
    while(end>0&&(bytes[end]&0xc0)===0x80)end-=1;
    return bytes.subarray(0,end).toString('utf8');
}

function browserReportSummary(report,{redactions=[]}={}){
    const detail=report?.error&&typeof report.error==='object'
        ?`${String(report.error.name??'Error')}: ${String(report.error.message??'')}`
        :'none';
    return Object.freeze({
        ok:report?.ok===true,
        error:boundedUtf8Head(redactDiagnosticText(detail,redactions),REPORT_ERROR_SUMMARY_LIMIT)
    });
}

function createProbeError(message,{errors=[],probe,redactions=[]}){
    const projected=errors.map(({error,limit})=>
        sanitizedErrorProjection(error,{redactions,limit})
    );
    const diagnostic=projected.length>1
        ?new AggregateError(projected,message)
        :new Error(message);
    if(projected.length===1)diagnostic.cause=projected[0];
    diagnostic.probe=Object.freeze({
        ...probe,
        report:Object.freeze(probe.report),
        chrome:Object.freeze(probe.chrome)
    });
    return diagnostic;
}

function settleBrowserProbeResults({
    stage,chromeIdentity,results,reportElapsedMs,chromeElapsedMs,elapsedMs,redactions=[]
}){
    const [reportResult,chromeResult]=results;
    if(results.every(result=>result.status==='fulfilled')){
        return results.map(result=>result.value);
    }
    const snapshot=(result,elapsed,includeSummary=false)=>({
        status:result.status,
        elapsedMs:elapsed,
        ...(includeSummary&&result.status==='fulfilled'
            ?{summary:browserReportSummary(result.value,{redactions})}:{})
    });
    const report=snapshot(reportResult,reportElapsedMs,true);
    const chrome=snapshot(chromeResult,chromeElapsedMs);
    const failures=[
        ...(reportResult.status==='rejected'
            ?[{label:'report',error:reportResult.reason,limit:REPORT_ERROR_SUMMARY_LIMIT}]:[]),
        ...(chromeResult.status==='rejected'
            ?[{label:'Chrome',error:chromeResult.reason,limit:PROBE_FAILURE_SUMMARY_LIMIT}]:[])
    ];
    const summaries=failures.map(({label,error,limit})=>
        `${label}: ${boundedFailureSummary(error,{redactions,limit})}`
    );
    if(report.summary)summaries.unshift(
        `report: ok=${String(report.summary.ok)}, error=${report.summary.error}`
    );
    throw createProbeError(
        `${stage} using ${chromeIdentity} failed after ${elapsedMs}ms; `+
        `report ${report.status} after ${reportElapsedMs}ms and Chrome ${chrome.status} `+
        `after ${chromeElapsedMs}ms. ${summaries.join(' ')}`,
        {
            errors:failures,
            redactions,
            probe:{stage,chromeIdentity,report,chrome,elapsedMs}
        }
    );
}

async function runBrowserProbe({sentinel,chromePath,chromeIdentity,chromeMajor,url,stage}){
    const startedAt=performance.now();
    let reportElapsedMs=null;
    let chromeElapsedMs=null;
    const elapsed=()=>Math.max(0,Math.round(performance.now()-startedAt));
    const redactions=[sentinel.token,sentinel.url];
    const results=await Promise.allSettled([
        sentinel.next(stage).finally(()=>{reportElapsedMs=elapsed();}),
        launchChrome({
            chromePath,chromeIdentity,url,stage,redactions
        }).finally(()=>{chromeElapsedMs=elapsed();})
    ]);
    const settled=settleBrowserProbeResults({
        stage,chromeIdentity,results,reportElapsedMs,chromeElapsedMs,
        elapsedMs:elapsed(),redactions
    });
    assertBrowserReportSafely(settled[0],{
        chromeMajor,stage,chromeIdentity,reportElapsedMs,chromeElapsedMs,
        elapsedMs:elapsed(),redactions
    });
    return settled;
}

function assertBrowserReport(report,{chromeMajor}){
    assert.equal(report.ok,true,report.error?.message??'Browser probe failed without an error message.');
    assert.equal(report.protocol,'arcane-event-stack/1');
    assert.equal(report.observed,42);
    assert.equal(report.eventCount,1);
    assert.equal(report.eventType,'arcane.browser.import-map.proof');
    assert.deepEqual(report.constructors,{
        DBOPFS:'function',
        MD:'function',
        TimeGuard:'function',
        File:'function',
        Chat:'function',
        User:'function'
    });
    assert.deepEqual(report.versions,{
        runtimeStrongType:'1.1.0',
        eventPubSub:'6.1.0',
        sdkStrongType:'2.0.0'
    });
    assert.match(report.userAgent,/\bHeadlessChrome\/\d+(?:\.\d+){3}\b/u);
    assert.doesNotMatch(report.userAgent,/\b(?:Edg|OPR)\//u);
    assert.equal(Number(report.userAgent.match(/HeadlessChrome\/(\d+)\./u)?.[1]),chromeMajor);
    assert.deepEqual(report.csp,{
        scriptTokens:["'self'","'unsafe-inline'","'wasm-unsafe-eval'"],
        evalError:'EvalError',
        functionError:'EvalError',
        wasmBytes:8_524_865,
        wasmSha256:'95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6',
        compiled:true
    });
    assert.deepEqual(report.trapFetches,{strongType:404,eventPubSub:404});
    assert.ok(Array.isArray(report.resources));
    assert.ok(Array.isArray(report.nodeModuleResources));
    assert.ok(
        report.nodeModuleResources.every(value=>value.startsWith('fetch:')),
        'A real browser module or script request reached root node_modules.'
    );
    for(const required of REQUIRED_BROWSER_RESOURCES){
        assert.ok(
            report.resources.some(value=>value.split(':').slice(1).join(':').split('?')[0]===required),
            `${required} was absent from real Chrome Resource Timing.`
        );
    }
}

function assertBrowserReportSafely(report,{
    chromeMajor,stage,chromeIdentity,reportElapsedMs,chromeElapsedMs,elapsedMs,redactions=[]
}){
    try{
        assertBrowserReport(report,{chromeMajor});
        return report;
    }catch(error){
        const summary=browserReportSummary(report,{redactions});
        throw createProbeError(
            `${stage} delivered an invalid browser report after ${reportElapsedMs}ms `+
            `using ${chromeIdentity} (ok=${String(summary.ok)}, error=${summary.error}). `+
            boundedFailureSummary(error,{redactions}),
            {
                errors:[{error,limit:PROBE_FAILURE_SUMMARY_LIMIT}],
                redactions,
                probe:{
                    stage,
                    chromeIdentity,
                    report:{status:'fulfilled',elapsedMs:reportElapsedMs,summary},
                    chrome:{status:'fulfilled',elapsedMs:chromeElapsedMs},
                    elapsedMs
                }
            }
        );
    }
}

class FakeProcess extends EventEmitter{
    constructor({pid,onKill}={}){
        super();
        this.pid=pid;
        this.exitCode=null;
        this.signalCode=null;
        this.closed=false;
        this.kills=[];
        this.onKill=onKill;
        this.stdout=new EventEmitter();
        this.stderr=new EventEmitter();
    }

    kill(signal){
        this.kills.push(signal);
        return this.onKill?this.onKill(this,signal):true;
    }

    close(code,signal=null){
        if(this.closed)return;
        this.exitCode=code;
        this.signalCode=signal;
        this.closed=true;
        this.emit('close',code,signal);
    }
}

async function assertChromeLifecycleContracts(){
    assert.ok(CHROME_VIRTUAL_TIME_BUDGET_MS<CHROME_CAPTURE_TIMEOUT_MS);
    assert.ok(CHROME_CAPTURE_TIMEOUT_MS<CHROME_EXECUTION_TIMEOUT_MS);
    assert.ok(CHROME_CAPTURE_TIMEOUT_MS<BROWSER_REPORT_TIMEOUT_MS);
    for(const [platform,isRoot,required,excluded] of [
        ['darwin',false,'--use-mock-keychain','--no-sandbox'],
        ['linux',true,'--no-sandbox','--use-mock-keychain']
    ]){
        const args=chromeLaunchArguments({
            profile:'/tmp/arcane-profile',url:'http://127.0.0.1:4173/',platform,isRoot
        });
        assert.equal(args.filter(value=>value===`--timeout=${CHROME_CAPTURE_TIMEOUT_MS}`).length,1);
        assert.ok(args.includes(`--virtual-time-budget=${CHROME_VIRTUAL_TIME_BUDGET_MS}`));
        assert.ok(args.includes('--disable-features=MediaRouter,DialMediaRouteProvider,OptimizationHints'));
        assert.ok(args.includes(required));
        assert.equal(args.includes(excluded),false);
        assert.equal(args.at(-1),'http://127.0.0.1:4173/');
    }
    const chromeIdentity='Google Chrome 150.0.0.0';
    const secret='arcane-diagnostic-secret';
    const endpoint=`http://127.0.0.1/arcane-browser-contract/${secret}`;
    const profile='/tmp/arcane-secret-profile';
    const redactions=[secret,endpoint,profile];
    const safe=error=>(assertSafeDiagnostic(error,redactions),true);
    const safeThrow=(run,pattern,check=()=>{})=>assert.throws(run,error=>{
        assert.match(error.message,pattern);check(error);
        return safe(error);
    });
    const safeReject=(promise,pattern,check=()=>{})=>assert.rejects(promise,error=>{
        if(pattern)assert.match(error.message,pattern);check(error);
        return safe(error);
    });
    assert.equal(
        canonicalChromeIdentity(`${'x'.repeat(CHROME_IDENTITY_OUTPUT_LIMIT*2)} ${chromeIdentity}`),
        chromeIdentity
    );
    const identityResult={code:1,signal:null,elapsedMs:12,
        stdout:`prefix ${secret}`,stderr:`suffix ${endpoint}`};
    for(const [run,pattern] of [
        [()=>canonicalChromeIdentity(`${secret} Chromium ${chromeIdentity} ${endpoint}`),
            /conflicting browser identity/u],
        [
            ()=>canonicalChromeIdentity(
                `${secret} Google Chrome ${'1234567890.'.repeat(20)}1 ${endpoint}`
            ),
            /identity exceeds 128 bytes/u
        ],
        [()=>validateChromeIdentityProbeResult(identityResult,{redactions}),
            /identity probe exited with code 1/u],
        [
            ()=>parseChromeIdentityMetadata(
                {...identityResult,code:0,stdout:`{${secret}`},
                {redactions}
            ),
            /invalid JSON metadata/u
        ],
        [
            ()=>parseChromeIdentityMetadata({
                ...identityResult,
                code:0,
                stdout:JSON.stringify({
                    ProductName:secret,
                    ProductVersion:'150.0.0.0',
                    FileDescription:'Google Chrome'
                })
            },{redactions}),
            /invalid ProductName field/u
        ]
    ])safeThrow(run,pattern);
    const report={ok:true};
    const chrome={code:0,stdout:'<html data-arcane-browser-contract="passed"></html>'};
    const reportFailure=new Error(`${endpoint} report failure`);
    const chromeFailure=new Error(`${profile} Chrome failure`);
    const settlements=[
        [{status:'fulfilled',value:report},{status:'fulfilled',value:chrome}],
        [{status:'rejected',reason:reportFailure},{status:'fulfilled',value:chrome}],
        [
            {status:'fulfilled',value:{ok:false,error:{message:endpoint},token:secret}},
            {status:'rejected',reason:chromeFailure}
        ],
        [{status:'rejected',reason:reportFailure},{status:'rejected',reason:chromeFailure}]
    ];
    for(const [index,results] of settlements.entries()){
        const options={
            stage:index%2?'distribution browser probe':'source browser probe',
            chromeIdentity,results,reportElapsedMs:120+index,
            chromeElapsedMs:180+index,elapsedMs:180+index,redactions
        };
        if(index===0){
            assert.deepEqual(settleBrowserProbeResults(options),[report,chrome]);
        }else safeThrow(()=>settleBrowserProbeResults(options),/browser probe|failed/u,error=>{
            assert.equal(error.probe.report.status,results[0].status);
            assert.equal(error.probe.chrome.status,results[1].status);
            assert.equal(error.probe.elapsedMs,180+index);
        });
    }
    safeThrow(
        ()=>assertBrowserReportSafely({
            ok:false,token:secret,extra:profile,error:{name:'SyntheticError',message:endpoint}
        },{
            chromeMajor:150,stage:'source browser probe',chromeIdentity,
            reportElapsedMs:125,chromeElapsedMs:185,elapsedMs:185,redactions
        }),
        /invalid browser report/u,
        error=>assert.deepEqual(Object.keys(error.probe.report.summary),['ok','error'])
    );
    const timeoutChild=new FakeProcess({pid:4001});
    let timeoutTerminated=false;
    const timeoutRun=runBounded('synthetic-chrome',[],{
        timeout:10,label:`source browser probe using ${chromeIdentity}`,redactions,
        spawnProcess:()=>timeoutChild,
        terminateProcess:async child=>{
            timeoutTerminated=true;
            child.close(null,'SIGKILL');
        }
    });
    timeoutChild.stdout.emit('data',Buffer.from(`${'s'.repeat(5000)}${secret}`));
    await safeReject(timeoutRun,/execution limit/u,error=>{
        assert.equal(timeoutTerminated&&timeoutChild.closed,true);
        assert.ok(error.diagnostics.stdout.tailBytes<=CHROME_STDOUT_TAIL_LIMIT);
        assert.match(error.diagnostics.stdout.tail,/\[redacted\]/u);
    });
    const kept=Buffer.from(`safe:${secret.slice(0,10)}`);
    const overflow=Buffer.from(`${secret.slice(10)}:${'x'.repeat(32)}`);
    const outputChild=new FakeProcess({pid:4002});
    let outputTerminated=false;
    const outputRun=runBounded('synthetic-chrome',[],{
        timeout:1_000,maxOutput:kept.length,
        label:`distribution browser probe using ${chromeIdentity}`,redactions,
        spawnProcess:()=>outputChild,
        terminateProcess:async child=>{
            outputTerminated=true;
            child.close(null,'SIGKILL');
        }
    });
    outputChild.stderr.emit('data',kept);
    outputChild.stderr.emit('data',overflow);
    await safeReject(outputRun,/output limit/u,error=>{
        const output=error.diagnostics.stderr;
        assert.equal(outputTerminated&&outputChild.closed,true);
        assert.deepEqual(
            [output.bytes,output.retainedBytes,output.droppedBytes],
            [kept.length+overflow.length,kept.length,overflow.length]
        );
        assert.equal(output.tail,'[suppressed after output limit]');
        assert.equal(output.tail.includes(secret.slice(0,10)),false);
        assert.equal(output.tail.includes(secret.slice(10)),false);
    });
    for(const pid of [4003,undefined]){
        const child=new FakeProcess({pid});
        let terminated=false;
        const failed=runBounded('synthetic-chrome',[],{
            timeout:1_000,label:`source browser probe using ${chromeIdentity}`,redactions,
            spawnProcess:()=>child,
            ...(pid?{terminateProcess:async process=>{
                terminated=true;
                process.close(-2);
            }}:{})
        });
        child.stderr.emit('data',Buffer.from(`${secret}:stderr`));
        child.emit('error',new Error(`${endpoint} child error`));
        if(!pid)queueMicrotask(()=>child.close(-2));
        await safeReject(failed,/failed to execute/u,error=>{
            assert.equal(child.closed,true);
            if(pid)assert.equal(terminated,true);
            assert.ok(error.cause);
        });
    }
    const drainChild=new FakeProcess({pid:4004});
    const drainRun=runBounded('synthetic-chrome',[],{
        timeout:1_000,label:`source browser probe using ${chromeIdentity}`,redactions,
        spawnProcess:()=>drainChild,
        terminateProcess:async()=>{throw new Error(`${secret} drain failure`);}
    });
    drainChild.emit('error',new Error(`${endpoint} child failure`));
    await safeReject(drainRun,/did not drain/u,error=>{
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length,2);
    });
    drainChild.close(-2);
    await safeReject(runBounded('synthetic-chrome',[],{
        label:`source browser probe using ${chromeIdentity}`,redactions,
        spawnProcess:()=>{throw new Error(`${secret} spawn failure`);}
    }),/could not start/u);
    for(const [result,pattern] of [
        [{code:1,signal:null,elapsedMs:25,stdout:secret,stderr:endpoint},/exited with code 1/u],
        [{code:0,signal:null,elapsedMs:26,stdout:secret,stderr:''},/HTML document/u],
        [
            {code:0,signal:null,elapsedMs:27,stdout:`<html>${secret}</html>`,stderr:''},
            /passed DOM contract marker/u
        ]
    ])safeThrow(
        ()=>validateChromeProcessResult(result,{
            label:`source browser probe using ${chromeIdentity}`,
            redactions
        }),
        pattern,
        error=>assert.ok(error.diagnostics.stdout.tailBytes<=CHROME_STDOUT_TAIL_LIMIT)
    );
    const terminationOptions={
        platform:'win32',taskkillTimeout:10,taskkillDrainTimeout:50,chromeDrainTimeout:50
    };
    for(const [kind,pattern] of [
        ['nonzero',/taskkill failed.*exit 1/iu],
        ['spawn-error',/taskkill could not start/iu],
        ['timeout',/taskkill exceeded 10ms/iu]
    ]){
        const closeOnKill=process=>(process.close(null,'SIGKILL'),true);
        const child=new FakeProcess({pid:4100+kind.length,onKill:closeOnKill});
        let killer;
        await assert.rejects(terminateProcessTree(child,{
            ...terminationOptions,
            spawnProcess:()=>{
                killer=new FakeProcess({pid:5100+kind.length,onKill:closeOnKill});
                if(kind==='nonzero')queueMicrotask(()=>killer.close(1));
                if(kind==='spawn-error')queueMicrotask(()=>{
                    killer.emit('error',new Error('synthetic taskkill spawn failure'));
                    killer.close(-2);
                });
                return killer;
            }
        }),pattern);
        assert.deepEqual(child.kills,['SIGKILL']);
        if(kind==='timeout')assert.deepEqual(killer.kills,['SIGKILL']);
    }
    const unixChild=new FakeProcess({
        pid:4104,onKill:process=>(process.close(null,'SIGKILL'),true)
    });
    await assert.rejects(terminateProcessTree(unixChild,{
        platform:'linux',
        killGroup:()=>{throw new Error('synthetic process-group termination failure');},
        chromeDrainTimeout:50
    }),/synthetic process-group termination failure/u);
    assert.deepEqual(unixChild.kills,['SIGKILL']);
    const exitedLeader=new FakeProcess({pid:4105});
    exitedLeader.exitCode=0;
    let groupKill;
    await terminateProcessTree(exitedLeader,{
        platform:'linux',chromeDrainTimeout:50,
        killGroup:(pid,signal)=>(groupKill={pid,signal},exitedLeader.close(0))
    });
    assert.deepEqual(groupKill,{pid:-4105,signal:'SIGKILL'});
    const operationFailure=new Error(`${endpoint} operation failure`);
    const cleanupFailure=new Error(`${profile} cleanup failure`);
    const singleFailure=new Error(`${endpoint} single cleanup failure`);
    singleFailure.code=`ARCANE_${secret}`;
    singleFailure.cause=new Error(profile);
    singleFailure.custom={endpoint};
    for(const operation of [
        ()=>completeWithCleanup(async()=>{throw operationFailure;},async()=>{},
            'Synthetic operation failed.',{redactions}),
        ()=>completeWithCleanup(async()=>true,async()=>{throw cleanupFailure;},
            'Synthetic cleanup failed.',{redactions}),
        ()=>completeWithCleanup(async()=>{throw operationFailure;},
            async()=>{throw cleanupFailure;},'Synthetic operation and cleanup failed.',{redactions}),
        ()=>settleCleanup([async()=>{throw singleFailure;}],
            'Synthetic single cleanup failed.',{redactions}),
        ()=>settleCleanup([async()=>{throw operationFailure;},async()=>{throw cleanupFailure;}],
            'Synthetic cleanup failed.',{redactions})
    ])await safeReject(operation,null,error=>{
        assert.notEqual(error,operationFailure);
        assert.notEqual(error,cleanupFailure);
        assert.equal(error.custom,undefined);
    });
    await assert.rejects(withDeadline(()=>new Promise(()=>{}),{
        timeout:10,
        label:'Synthetic profile cleanup'
    }),/Synthetic profile cleanup exceeded 10ms/u);
}
if(process.env.ARCANE_BROWSER_LIFECYCLE_SELF_TEST==='1'){
    await assertChromeLifecycleContracts();
}else test('installed SDK resolves its authenticated named browser graph identically in dev and dist',{
    timeout:270_000
},async t=>{
    const workspaceRoot=process.cwd();
    const workspaceName=JSON.parse(await readFile(path.join(workspaceRoot,'package.json'),'utf8')).name;
    assert.equal(workspaceName,'arcane-external-app');
    assert.equal(await exists(path.join(workspaceRoot,'node_modules','arcane-os','package.json')),true);
    const resolvedToolchainPath=fileURLToPath(import.meta.resolve('arcane-os/toolchain'));
    const expectedToolchainPath=path.join(
        workspaceRoot,'node_modules','arcane-os','src','toolchain.mjs'
    );
    await assertSameRegularFileIdentity({
        actualPath:resolvedToolchainPath,
        expectedPath:expectedToolchainPath
    });
    const installedSdkRoot=path.dirname(path.dirname(expectedToolchainPath));
    const [runtimeManifest,browserRuntimeManifest]=await Promise.all([
        readFile(path.join(installedSdkRoot,'runtime','ARCANE_RUNTIME_RELEASE.json'),'utf8')
            .then(JSON.parse),
        readFile(
            path.join(installedSdkRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json'),
            'utf8'
        ).then(JSON.parse)
    ]);
    const expectedProjection=Object.freeze({
        expectedArcaneFileCount:
            runtimeManifest.files.length+browserRuntimeManifest.files.length
    });

    const identityProbeRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-toolchain-identity-'));
    t.after(()=>rm(identityProbeRoot,{recursive:true,force:true}));
    const decoyToolchainPath=path.join(identityProbeRoot,'toolchain.mjs');
    await writeFile(decoyToolchainPath,await readFile(expectedToolchainPath));
    assert.deepEqual(
        await readFile(decoyToolchainPath),
        await readFile(expectedToolchainPath)
    );
    await assert.rejects(
        assertSameRegularFileIdentity({
            actualPath:resolvedToolchainPath,
            expectedPath:decoyToolchainPath
        }),
        /expected physical identity/u
    );

    const expectedToolchainInfo=await lstat(expectedToolchainPath,{bigint:true});
    await assert.rejects(
        assertSameRegularFileIdentity({
            actualPath:resolvedToolchainPath,
            expectedPath:expectedToolchainPath,
            inspect:async filePath=>filePath===resolvedToolchainPath?{
                dev:expectedToolchainInfo.dev,
                ino:expectedToolchainInfo.ino,
                isFile:()=>false,
                isSymbolicLink:()=>true
            }:expectedToolchainInfo
        }),
        /must not be a final symbolic link/u
    );
    await assertChromeLifecycleContracts();

    const linuxCandidates=[
        '/usr/bin/google-chrome',
        '/opt/google/chrome/google-chrome'
    ];
    const inspectedLinuxCandidates=[];
    const inspectLinuxCandidate=async candidate=>{
        inspectedLinuxCandidates.push(candidate);
        return candidate===linuxCandidates[0]
            ?{isSymbolicLink:()=>true,isFile:()=>false}
            :{isSymbolicLink:()=>false,isFile:()=>true};
    };
    assert.equal(
        await selectRegularChromeCandidate({
            configured:null,
            candidates:linuxCandidates,
            inspect:inspectLinuxCandidate
        }),
        linuxCandidates[1]
    );
    assert.deepEqual(inspectedLinuxCandidates,linuxCandidates);
    await assert.rejects(
        selectRegularChromeCandidate({
            configured:linuxCandidates[0],
            candidates:linuxCandidates,
            inspect:inspectLinuxCandidate
        }),
        /ARCANE_CHROME_PATH is a symbolic link/u
    );

    const chrome=await findGoogleChrome();
    assert.match(chrome.identity,/Google Chrome/u);
    const sentinel=await createSentinel();
    const instances=new Set();
    t.after(async()=>{
        await settleCleanup([
            ...[...instances].map(instance=>()=>closeApplicationServer(instance)),
            ()=>sentinel.close()
        ],'Browser contract teardown left owned resources open.',{
            redactions:[sentinel.token,sentinel.url]
        });
    });
    await configureProbe(workspaceRoot,sentinel.url,sentinel.token);
    const trapBaseline=await writeHostileDependencies(workspaceRoot);

    let source;
    let sourceReport;
    try{
        source=await developApplication({
            workspaceRoot,
            appId:APP_ID,
            host:'127.0.0.1',
            port:0
        });
        instances.add(source);
        const [report,chromeRun]=await runBrowserProbe({
            sentinel,
            chromePath:chrome.chromePath,
            chromeIdentity:chrome.identity,
            chromeMajor:chrome.major,
            url:source.url,
            stage:'source browser probe'
        });
        sourceReport=report;
        assert.equal(chromeRun.stage,'source browser probe');
        assert.equal(chromeRun.chromeIdentity,chrome.identity);
        assert.equal(chromeRun.htmlDocument,true);
        assert.equal(chromeRun.domContractPassed,true);
    }finally{
        if(source){
            await closeApplicationServer(source);
            instances.delete(source);
        }
    }
    const sourceBeforePackage=await paritySnapshot(workspaceRoot,expectedProjection);
    assert.deepEqual(await fileRecords(workspaceRoot,HOSTILE_DEPENDENCY_PATHS),trapBaseline);

    const packaged=await packageApplication({workspaceRoot,appId:APP_ID});
    assert.equal(packaged.release.app,APP_ID);
    assert.equal(
        sourceBeforePackage.importCount,
        packaged.release.importMapReceipt.entryCount
    );
    const verified=await verifyApplication({workspaceRoot,appId:APP_ID});
    assert.equal(verified.release.verified,true);

    let distribution;
    let distributionReport;
    try{
        distribution=await runApplication({
            workspaceRoot,
            appId:APP_ID,
            target:'browser',
            host:'127.0.0.1',
            port:0
        });
        instances.add(distribution);
        const [report,chromeRun]=await runBrowserProbe({
            sentinel,
            chromePath:chrome.chromePath,
            chromeIdentity:chrome.identity,
            chromeMajor:chrome.major,
            url:distribution.url,
            stage:'distribution browser probe'
        });
        distributionReport=report;
        assert.equal(chromeRun.stage,'distribution browser probe');
        assert.equal(chromeRun.chromeIdentity,chrome.identity);
        assert.equal(chromeRun.htmlDocument,true);
        assert.equal(chromeRun.domContractPassed,true);
    }finally{
        if(distribution){
            await closeApplicationServer(distribution);
            instances.delete(distribution);
        }
    }

    assert.deepEqual(distributionReport.resources,sourceReport.resources);
    assert.deepEqual(distributionReport.nodeModuleResources,sourceReport.nodeModuleResources);
    assert.deepEqual(await fileRecords(workspaceRoot,HOSTILE_DEPENDENCY_PATHS),trapBaseline);

    const sourceAfterPackage=await paritySnapshot(workspaceRoot,expectedProjection);
    const distRoot=path.join(workspaceRoot,'dist',APP_ID);
    const distSnapshot=await paritySnapshot(distRoot,expectedProjection);
    assert.deepEqual(sourceAfterPackage,sourceBeforePackage);
    assert.deepEqual(distSnapshot,sourceBeforePackage);

    const distFiles=await realFileInventory(distRoot);
    assert.ok(distFiles.every(relative=>!relative.split('/').includes('node_modules')));
});
