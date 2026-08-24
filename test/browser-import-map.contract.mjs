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
import {fileURLToPath} from 'node:url';
import test from 'arcane-os/testing';
import {
    developApplication,
    packageApplication,
    runApplication,
    verifyApplication
} from 'arcane-os/toolchain';

const APP_ID='external-app';
const CHROME_TIMEOUT_MS=60_000;
const CHROME_VIRTUAL_TIME_BUDGET_MS=45_000;
const CHROME_OUTPUT_LIMIT=16*1024*1024;
const REPORT_LIMIT=128*1024;
const SERVER_CLEANUP_TIMEOUT_MS=3_500;
const TASKKILL_TIMEOUT_MS=3_000;
const TASKKILL_DRAIN_TIMEOUT_MS=2_000;
const CHROME_DRAIN_TIMEOUT_MS=5_000;
const PROFILE_CLEANUP_TIMEOUT_MS=5_000;
const EXPECTED_IMPORT_COUNT=85;
const EXPECTED_ARCANE_FILE_COUNT=163;
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
    '/arcane/sdk/event-manager.mjs'
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

async function paritySnapshot(root){
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
    assert.equal(Object.keys(map.imports).length,EXPECTED_IMPORT_COUNT);
    assert.equal(
        map.imports['./node_modules/strong-type/index.js'],
        './arcane/dependencies/strong-type/index.js'
    );
    assert.equal(
        map.imports['arcane-os/event-manager'],
        './arcane/sdk/event-manager.mjs'
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
    assert.equal(arcaneFiles.length,EXPECTED_ARCANE_FILE_COUNT);
    const mappedTargets=Object.values(map.imports).map(target=>{
        assert.match(target,/^\.\/arcane\//u);
        return target.slice(2);
    });
    return {
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
        userModule
    ]=await Promise.all([
        import('arcane-os/event-manager'),
        import('arcane/DBOPFS'),
        import('arcane/MD'),
        import('arcane/TimeGuard'),
        import('../../../arcane/entities/File.js'),
        import('../../../arcane/entities/Chat.js'),
        import('arcane/entities/User')
    ]);
    const {ARCANE_EVENT_STACK_PROTOCOL,createEventManager}=eventManagerModule;
    const {default:DBOPFS}=dbopfsModule;
    const {default:MD}=mdModule;
    const {default:TimeGuard}=timeGuardModule;
    const {default:FileEntity}=fileModule;
    const {default:ChatEntity}=chatModule;
    const {default:UserEntity}=userModule;
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
        next(){
            if(reports.length>0)return Promise.resolve(reports.shift());
            return new Promise((resolve,reject)=>{
                const waiter={resolve,reject};
                waiters.push(waiter);
                const timer=setTimeout(()=>{
                    const index=waiters.indexOf(waiter);
                    if(index>=0)waiters.splice(index,1);
                    reject(new Error(`Real Chrome did not report within ${CHROME_TIMEOUT_MS}ms.`));
                },CHROME_TIMEOUT_MS);
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
    if(!child?.pid)return;
    trackProcessClose(child);
    let terminationError=null;
    if(platform==='win32'){
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
            label:`Google Chrome process tree ${child.pid}`
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

function runBounded(command,args,{
    timeout=CHROME_TIMEOUT_MS,
    maxOutput=CHROME_OUTPUT_LIMIT,
    env=process.env
}={}){
    return new Promise((resolve,reject)=>{
        let settled=false;
        let outputBytes=0;
        const stdout=[];
        const stderr=[];
        const child=trackProcessClose(spawn(command,args,{
            stdio:['ignore','pipe','pipe'],
            windowsHide:true,
            detached:process.platform!=='win32',
            env
        }));
        const timer=setTimeout(()=>{
            if(settled)return;
            settled=true;
            const timeoutError=new Error(`Google Chrome exceeded the ${timeout}ms execution limit.`);
            void terminateProcessTree(child).then(
                ()=>reject(timeoutError),
                drainError=>reject(new AggregateError(
                    [timeoutError,drainError],
                    'Google Chrome timed out and its process tree did not drain.'
                ))
            );
        },timeout);
        const collect=(target,chunk)=>{
            if(settled)return;
            outputBytes+=chunk.length;
            if(outputBytes>maxOutput){
                settled=true;
                clearTimeout(timer);
                const outputError=new Error(
                    `Google Chrome exceeded the ${maxOutput}-byte output limit.`
                );
                void terminateProcessTree(child).then(
                    ()=>reject(outputError),
                    drainError=>reject(new AggregateError(
                        [outputError,drainError],
                        'Google Chrome exceeded its output limit and its process tree did not drain.'
                    ))
                );
                return;
            }
            target.push(chunk);
        };
        child.stdout.on('data',chunk=>collect(stdout,chunk));
        child.stderr.on('data',chunk=>collect(stderr,chunk));
        child.once('error',error=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            reject(error);
        });
        child.once('close',(code,signal)=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            resolve({
                code,
                signal,
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
                maxOutput:1024*1024,
                env:{...process.env,ARCANE_CHROME_IDENTITY_PATH:chromePath}
            }
        );
        assert.equal(inspected.code,0,inspected.stderr||inspected.stdout);
        const metadata=JSON.parse(inspected.stdout.trim());
        assert.match(metadata.ProductName,/^Google Chrome(?: for Testing)?$/u);
        assert.match(metadata.FileDescription,/^Google Chrome(?: for Testing)?$/u);
        identity=`${metadata.ProductName} ${metadata.ProductVersion}`;
    }else{
        const version=await runBounded(chromePath,['--version'],{
            timeout:5_000,
            maxOutput:1024*1024
        });
        assert.equal(version.code,0,version.stderr||version.stdout);
        identity=`${version.stdout}\n${version.stderr}`.trim();
    }
    assert.match(identity,/\bGoogle Chrome(?: for Testing)?\s+\d+(?:\.\d+){2,}\b/u);
    assert.doesNotMatch(identity,/Edge|Chromium/u);
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

async function completeWithCleanup(operation,cleanup,message){
    let value;
    let operationError=null;
    try{value=await operation();}
    catch(error){operationError=error;}
    let cleanupError=null;
    try{await cleanup();}
    catch(error){cleanupError=error;}
    if(operationError&&cleanupError){
        throw new AggregateError([operationError,cleanupError],message);
    }
    if(operationError)throw operationError;
    if(cleanupError)throw cleanupError;
    return value;
}

async function settleCleanup(cleanups,message){
    const results=await Promise.allSettled(
        cleanups.map(cleanup=>Promise.resolve().then(cleanup))
    );
    const failures=results
        .filter(result=>result.status==='rejected')
        .map(result=>result.reason);
    if(failures.length===1)throw failures[0];
    if(failures.length>1)throw new AggregateError(failures,message);
}

async function launchChrome({chromePath,url}){
    const profile=await mkdtemp(path.join(os.tmpdir(),'arcane-google-chrome-'));
    return completeWithCleanup(async()=>{
        const args=[
            '--headless=new',
            '--dump-dom',
            '--disable-background-networking',
            '--disable-component-update',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-features=MediaRouter,OptimizationHints',
            '--disable-gpu',
            '--disable-sync',
            '--metrics-recording-only',
            '--no-default-browser-check',
            '--no-first-run',
            '--password-store=basic',
            `--virtual-time-budget=${CHROME_VIRTUAL_TIME_BUDGET_MS}`,
            `--user-data-dir=${profile}`,
            ...(typeof process.getuid==='function'&&process.getuid()===0?['--no-sandbox']:[]),
            url
        ];
        const result=await runBounded(chromePath,args);
        assert.equal(result.code,0,`${result.stdout.slice(-2000)}\n${result.stderr.slice(-4000)}`);
        assert.match(result.stdout,/<html\b/iu);
        return result;
    },()=>withDeadline(
        ()=>rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}),
        {
            timeout:PROFILE_CLEANUP_TIMEOUT_MS,
            label:`Google Chrome profile cleanup ${profile}`
        }
    ),'Google Chrome execution and profile cleanup both failed.');
}

async function runBrowserProbe({sentinel,chromePath,url}){
    const results=await Promise.allSettled([
        sentinel.next(),
        launchChrome({chromePath,url})
    ]);
    const failures=results.filter(result=>result.status==='rejected');
    if(failures.length===1)throw failures[0].reason;
    if(failures.length>1){
        throw new AggregateError(
            failures.map(result=>result.reason),
            'The browser report and Google Chrome execution both failed.'
        );
    }
    return results.map(result=>result.value);
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

class FakeProcess extends EventEmitter{
    constructor({pid,onKill}={}){
        super();
        this.pid=pid;
        this.exitCode=null;
        this.signalCode=null;
        this.closed=false;
        this.kills=[];
        this.onKill=onKill;
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
    const terminationOptions={
        platform:'win32',
        taskkillTimeout:10,
        taskkillDrainTimeout:50,
        chromeDrainTimeout:50
    };

    const nonzeroChrome=new FakeProcess({
        pid:4101,
        onKill:process=>{
            process.close(null,'SIGKILL');
            return true;
        }
    });
    let nonzeroKiller;
    await assert.rejects(
        terminateProcessTree(nonzeroChrome,{
            ...terminationOptions,
            spawnProcess:()=>{
                nonzeroKiller=new FakeProcess({pid:5101});
                queueMicrotask(()=>nonzeroKiller.close(1));
                return nonzeroKiller;
            }
        }),
        /taskkill failed.*exit 1/iu
    );
    assert.deepEqual(nonzeroChrome.kills,['SIGKILL']);

    const spawnErrorChrome=new FakeProcess({
        pid:4102,
        onKill:process=>{
            process.close(null,'SIGKILL');
            return true;
        }
    });
    let spawnErrorKiller;
    await assert.rejects(
        terminateProcessTree(spawnErrorChrome,{
            ...terminationOptions,
            spawnProcess:()=>{
                spawnErrorKiller=new FakeProcess({pid:5102});
                queueMicrotask(()=>{
                    spawnErrorKiller.emit('error',new Error('synthetic taskkill spawn failure'));
                    spawnErrorKiller.close(-2);
                });
                return spawnErrorKiller;
            }
        }),
        /taskkill could not start/iu
    );
    assert.deepEqual(spawnErrorChrome.kills,['SIGKILL']);

    const timeoutChrome=new FakeProcess({
        pid:4103,
        onKill:process=>{
            process.close(null,'SIGKILL');
            return true;
        }
    });
    let timeoutKiller;
    await assert.rejects(
        terminateProcessTree(timeoutChrome,{
            ...terminationOptions,
            spawnProcess:()=>{
                timeoutKiller=new FakeProcess({
                    pid:5103,
                    onKill:process=>{
                        process.close(null,'SIGKILL');
                        return true;
                    }
                });
                return timeoutKiller;
            }
        }),
        /taskkill exceeded 10ms/iu
    );
    assert.deepEqual(timeoutKiller.kills,['SIGKILL']);
    assert.deepEqual(timeoutChrome.kills,['SIGKILL']);

    const groupFailure=new Error('synthetic process-group termination failure');
    const unixChrome=new FakeProcess({
        pid:4104,
        onKill:process=>{
            process.close(null,'SIGKILL');
            return true;
        }
    });
    await assert.rejects(
        terminateProcessTree(unixChrome,{
            platform:'linux',
            killGroup:()=>{throw groupFailure;},
            chromeDrainTimeout:50
        }),
        error=>{
            assert.equal(error,groupFailure);
            return true;
        }
    );
    assert.deepEqual(unixChrome.kills,['SIGKILL']);

    const exitedLeader=new FakeProcess({pid:4105});
    exitedLeader.exitCode=0;
    let exitedLeaderGroupKill=null;
    await terminateProcessTree(exitedLeader,{
        platform:'linux',
        killGroup:(pid,signal)=>{
            exitedLeaderGroupKill={pid,signal};
            exitedLeader.close(0);
        },
        chromeDrainTimeout:50
    });
    assert.deepEqual(exitedLeaderGroupKill,{pid:-4105,signal:'SIGKILL'});
    assert.equal(exitedLeader.closed,true);

    const cleanupOne=new Error('synthetic application cleanup failure');
    const cleanupTwo=new Error('synthetic sentinel cleanup failure');
    await assert.rejects(
        settleCleanup([
            async()=>{throw cleanupOne;},
            async()=>{throw cleanupTwo;}
        ],'Synthetic browser cleanup failed.'),
        error=>{
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors,[cleanupOne,cleanupTwo]);
            return true;
        }
    );

    const chromeFailure=new Error('synthetic Chrome failure');
    const profileFailure=new Error('synthetic profile cleanup failure');
    await assert.rejects(
        completeWithCleanup(
            async()=>{throw chromeFailure;},
            async()=>{throw profileFailure;},
            'Synthetic Chrome and profile cleanup both failed.'
        ),
        error=>{
            assert.ok(error instanceof AggregateError);
            assert.deepEqual(error.errors,[chromeFailure,profileFailure]);
            return true;
        }
    );
    await assert.rejects(
        withDeadline(()=>new Promise(()=>{}),{
            timeout:10,
            label:'Synthetic profile cleanup'
        }),
        /Synthetic profile cleanup exceeded 10ms/u
    );
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
        ],'Browser contract teardown left owned resources open.');
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
            url:source.url
        });
        sourceReport=report;
        assertBrowserReport(sourceReport,{chromeMajor:chrome.major});
        assert.match(chromeRun.stdout,/data-arcane-browser-contract="passed"/u);
    }finally{
        if(source){
            await closeApplicationServer(source);
            instances.delete(source);
        }
    }
    const sourceBeforePackage=await paritySnapshot(workspaceRoot);
    assert.deepEqual(await fileRecords(workspaceRoot,HOSTILE_DEPENDENCY_PATHS),trapBaseline);

    const packaged=await packageApplication({workspaceRoot,appId:APP_ID});
    assert.equal(packaged.release.app,APP_ID);
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
            url:distribution.url
        });
        distributionReport=report;
        assertBrowserReport(distributionReport,{chromeMajor:chrome.major});
        assert.match(chromeRun.stdout,/data-arcane-browser-contract="passed"/u);
    }finally{
        if(distribution){
            await closeApplicationServer(distribution);
            instances.delete(distribution);
        }
    }

    assert.deepEqual(distributionReport.resources,sourceReport.resources);
    assert.deepEqual(distributionReport.nodeModuleResources,sourceReport.nodeModuleResources);
    assert.deepEqual(await fileRecords(workspaceRoot,HOSTILE_DEPENDENCY_PATHS),trapBaseline);

    const sourceAfterPackage=await paritySnapshot(workspaceRoot);
    const distRoot=path.join(workspaceRoot,'dist',APP_ID);
    const distSnapshot=await paritySnapshot(distRoot);
    assert.deepEqual(sourceAfterPackage,sourceBeforePackage);
    assert.deepEqual(distSnapshot,sourceBeforePackage);

    const distFiles=await realFileInventory(distRoot);
    assert.ok(distFiles.every(relative=>!relative.split('/').includes('node_modules')));
});
