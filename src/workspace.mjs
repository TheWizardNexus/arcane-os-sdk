import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {parseSemver} from './packager/core.mjs';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const EXPECTED_SDK_NAME='arcane-os';
const EXPECTED_SDK_VERSION='0.1.0-dev.0';
const LOCAL_TARBALL_PATTERN=/^file:.+\.tgz$/iu;
const ROOT_CONFIG_NAME='arcane-packager.json';
const APP_CONFIG_NAME='arcane-package.json';

function fail(message,code='ARCANE_WORKSPACE_INVALID'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function isObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function ordinal(left,right){
    return left<right?-1:left>right?1:0;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

async function emit(onEvent,event){
    if(typeof onEvent==='function')await onEvent(Object.freeze(event));
}

async function readJson(filePath,label){
    let text;
    try{
        const info=await lstat(filePath);
        if(info.isSymbolicLink()||!info.isFile())fail(`${label} must be a real file.`);
        text=await readFile(filePath,'utf8');
    }catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist.`);
        throw error;
    }
    try{return JSON.parse(text);}
    catch(error){fail(`${label} is not valid JSON: ${error.message}`);}
}

async function assertRealDirectory(directory,label){
    let info;
    try{info=await lstat(directory);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${directory}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} must be a real directory: ${directory}.`);
}

function validateRootConfig(config){
    if(!isObject(config)||config.schemaVersion!==1||config.appsRoot!=='apps'||config.distRoot!=='dist'
        ||!isObject(config.sharedPayloads)){
        fail(`${ROOT_CONFIG_NAME} must use schema 1 with appsRoot "apps", distRoot "dist", and sharedPayloads.`);
    }
    const routes=config.sharedPayloads['browser-runtime'];
    if(!Array.isArray(routes)||routes.length!==3)fail(`${ROOT_CONFIG_NAME} must define the three browser-runtime routes.`);
    const expected=[
        {
            source:'node_modules/arcane-os/runtime/arcane',
            destination:'arcane',
            include:['components','css','entities','img','modules']
        },
        {
            source:'node_modules/arcane-os/runtime/strong-type',
            destination:'node_modules/strong-type',
            include:['index.js','licence','package.json']
        },
        {
            source:'node_modules/arcane-os',
            destination:'licenses/arcane-os',
            include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']
        }
    ];
    for(const [index,route] of routes.entries()){
        const wanted=expected[index];
        if(!isObject(route)||route.source!==wanted.source||route.destination!==wanted.destination
            ||JSON.stringify(route.include)!==JSON.stringify(wanted.include)
            ||!Array.isArray(route.exclude)||route.exclude.length){
            fail(`${ROOT_CONFIG_NAME} browser-runtime route ${index} does not match the exact SDK payload contract.`);
        }
    }
    return config;
}

function validateAppManifest(manifest,appId){
    let validVersion=true;
    try{
        parseSemver(manifest?.version);
    }catch{
        validVersion=false;
    }
    if(!isObject(manifest)||manifest.schemaVersion!==1||manifest.id!==appId
        ||typeof manifest.displayName!=='string'||!manifest.displayName.trim()
        ||!validVersion
        ||typeof manifest.entry!=='string'||!manifest.entry||manifest.entry.includes('\\')
        ||path.posix.normalize(manifest.entry)!==manifest.entry||manifest.entry.startsWith('../')
        ||!['static','adapter'].includes(manifest.strategy)
        ||!Array.isArray(manifest.include)||!manifest.include.some(item=>
            item===manifest.entry||manifest.entry.startsWith(`${item}/`)
        )
        ||(manifest.exclude!==undefined&&!Array.isArray(manifest.exclude))||!Array.isArray(manifest.shared)
        ||!manifest.shared.includes('browser-runtime')){
        fail(`apps/${appId}/${APP_CONFIG_NAME} is not a compatible Arcane package.`);
    }
    if(manifest.strategy==='adapter'){
        if(typeof manifest.adapter!=='string'||!/^scripts\/[a-zA-Z0-9._/-]+\.mjs$/.test(manifest.adapter)
            ||path.posix.normalize(manifest.adapter)!==manifest.adapter||manifest.adapter.includes('../')){
            fail(`apps/${appId}/${APP_CONFIG_NAME} must declare a safe app-local scripts/*.mjs adapter.`);
        }
    }else if(manifest.adapter!==undefined){
        fail(`apps/${appId}/${APP_CONFIG_NAME} declares an adapter for a static strategy.`);
    }
    return manifest;
}

export async function discoverApps(workspaceRoot=process.cwd()){
    const root=path.resolve(workspaceRoot);
    await assertRealDirectory(root,'Workspace');
    const appsRoot=path.join(root,'apps');
    await assertRealDirectory(appsRoot,'Workspace apps root');
    const entries=await readdir(appsRoot,{withFileTypes:true});
    const apps=[];
    for(const entry of entries.sort((left,right)=>ordinal(left.name,right.name))){
        if(!APP_ID_PATTERN.test(entry.name))continue;
        if(entry.isSymbolicLink())fail(`apps/${entry.name} must not be a symbolic link or junction.`);
        if(!entry.isDirectory())continue;
        const appRoot=path.join(appsRoot,entry.name);
        try{
            const manifest=await readJson(path.join(appRoot,APP_CONFIG_NAME),`apps/${entry.name}/${APP_CONFIG_NAME}`);
            apps.push(Object.freeze({appId:entry.name,appRoot,manifest:validateAppManifest(manifest,entry.name)}));
        }catch(error){
            if(!String(error?.message).includes('does not exist'))throw error;
        }
    }
    return Object.freeze(apps);
}

export async function selectApp(workspaceRoot=process.cwd(),appId){
    const apps=await discoverApps(workspaceRoot);
    if(appId!==undefined&&(typeof appId!=='string'||!APP_ID_PATTERN.test(appId))){
        fail(`Invalid app id: ${String(appId)}.`,'ARCANE_USAGE');
    }
    if(appId){
        const selected=apps.find(app=>app.appId===appId);
        if(!selected)fail(`Unknown app "${appId}". Available apps: ${apps.map(app=>app.appId).join(', ')||'[none]'}.`);
        return selected;
    }
    if(apps.length===0)fail('No Arcane applications were found under apps/.');
    if(apps.length>1){
        fail(`This workspace contains multiple apps; select one explicitly: ${apps.map(app=>app.appId).join(', ')}.`,'ARCANE_USAGE');
    }
    return apps[0];
}

export async function resolveWorkspace({workspaceRoot=process.cwd(),appId}={}){
    const requestedRoot=path.resolve(workspaceRoot);
    await assertRealDirectory(requestedRoot,'Workspace');
    const canonicalRoot=await realpath(requestedRoot);
    const config=validateRootConfig(await readJson(path.join(canonicalRoot,ROOT_CONFIG_NAME),ROOT_CONFIG_NAME));
    const apps=await discoverApps(canonicalRoot);
    if(appId!==undefined&&(typeof appId!=='string'||!APP_ID_PATTERN.test(appId))){
        fail(`Invalid app id: ${String(appId)}.`,'ARCANE_USAGE');
    }
    let app;
    if(appId){
        app=apps.find(item=>item.appId===appId);
        if(!app)fail(`Unknown app "${appId}". Available apps: ${apps.map(item=>item.appId).join(', ')||'[none]'}.`);
    }else if(apps.length===1){
        [app]=apps;
    }else if(apps.length===0){
        fail('No Arcane applications were found under apps/.');
    }else{
        fail(`This workspace contains multiple apps; select one explicitly: ${apps.map(item=>item.appId).join(', ')}.`,'ARCANE_USAGE');
    }
    return Object.freeze({
        workspaceRoot:canonicalRoot,
        config,
        app,
        appId:app.appId,
        appRoot:app.appRoot,
        appIds:Object.freeze(apps.map(item=>item.appId))
    });
}

function validateLock(lock){
    if(!isObject(lock)||lock.schemaVersion!==1||!isObject(lock.sdk)
        ||lock.sdk.name!==EXPECTED_SDK_NAME||lock.sdk.version!==EXPECTED_SDK_VERSION
        ||!isObject(lock.runtime)||!SHA256_PATTERN.test(lock.runtime.contentSha256)
        ||!/^([a-f0-9]{40})$/.test(lock.runtime.upstreamCommit)
        ||lock.runtime.manifest!=='node_modules/arcane-os/runtime/ARCANE_RUNTIME_RELEASE.json'
        ||!isObject(lock.protocols)||lock.protocols.arcane!=='arcane/1'
        ||lock.protocols.cliEvents!=='arcane-cli-events/1'
        ||lock.protocols.targetAdapter!=='arcane-target-adapter/1'){
        fail('arcane.lock.json is incompatible with this SDK. Run arcane init only after reviewing missing files; existing locks are never overwritten.');
    }
    return lock;
}

function assertHtmlContract(source,appId){
    if(!new RegExp(`<meta\\s+name=["']arcane-app-id["']\\s+content=["']${appId}["']`).test(source)){
        fail(`apps/${appId}/index.html must declare matching arcane-app-id metadata.`);
    }
    if(!/<base\s+href=["']\.\.\/\.\.\/["']/.test(source)){
        fail(`apps/${appId}/index.html must declare <base href="../../">.`);
    }
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyleMatches=[...source.matchAll(new RegExp(`(?:\\./|/)apps/${appId.replaceAll('-','\\-')}/[^"']+\\.css(?:\\?[^"']*)?(?=["'])`, 'g'))];
    const appStyle=appStyleMatches.length?Math.min(...appStyleMatches.map(match=>match.index)):-1;
    const bootstrap=source.indexOf('./arcane/modules/ThemeBootstrap.js');
    const appModuleMatches=[...source.matchAll(new RegExp(`(?:\\./|/)apps/${appId.replaceAll('-','\\-')}/[^"']+\\.(?:js|mjs)(?:\\?[^"']*)?(?=["'])`, 'g'))];
    const appModule=appModuleMatches.length?Math.min(...appModuleMatches.map(match=>match.index)):-1;
    if(theme<0||primitives<=theme||appStyle<=primitives){
        fail(`apps/${appId}/index.html must load theme.css, primitives.css, and app CSS in that order.`);
    }
    if(bootstrap<=appStyle||(appModule>=0&&appModule<=bootstrap)){
        fail(`apps/${appId}/index.html must load ThemeBootstrap.js before app-local module scripts.`);
    }
}

export async function validateWorkspace({workspaceRoot=process.cwd(),appId,signal,onEvent}={}){
    throwIfAborted(signal);
    const resolved=await resolveWorkspace({workspaceRoot,appId});
    await emit(onEvent,{type:'workspace.validate.started',workspaceRoot:resolved.workspaceRoot,appId:resolved.appId});
    const checks=[];
    const add=async(name,operation)=>{
        throwIfAborted(signal);
        await operation();
        checks.push(Object.freeze({name,ok:true}));
        await emit(onEvent,{type:'workspace.validate.check',name,ok:true});
    };
    let lock;
    await add('lock',async()=>{
        lock=validateLock(await readJson(path.join(resolved.workspaceRoot,'arcane.lock.json'),'arcane.lock.json'));
    });
    await add('package',async()=>{
        const rootPackage=await readJson(path.join(resolved.workspaceRoot,'package.json'),'package.json');
        const configured=rootPackage?.devDependencies?.[EXPECTED_SDK_NAME]??rootPackage?.dependencies?.[EXPECTED_SDK_NAME];
        const supported=configured===EXPECTED_SDK_VERSION
            ||(typeof configured==='string'&&LOCAL_TARBALL_PATTERN.test(configured)
                &&!/[\x00-\x1f\x7f]/.test(configured));
        if(rootPackage?.private!==true||rootPackage?.type!=='module'||!supported){
            fail(`package.json must be private, use modules, and declare ${EXPECTED_SDK_NAME} as ${EXPECTED_SDK_VERSION} or a local file: tarball.`);
        }
    });
    await add('installed-runtime',async()=>{
        const installedPackage=await readJson(
            path.join(resolved.workspaceRoot,'node_modules','arcane-os','package.json'),
            'installed SDK package manifest'
        );
        if(installedPackage.name!==EXPECTED_SDK_NAME||installedPackage.version!==EXPECTED_SDK_VERSION){
            fail(`Installed SDK package must identify exactly as ${EXPECTED_SDK_NAME}@${EXPECTED_SDK_VERSION}.`);
        }
        const installed=await readJson(
            path.join(resolved.workspaceRoot,'node_modules','arcane-os','runtime','ARCANE_RUNTIME_RELEASE.json'),
            'installed SDK runtime manifest'
        );
        if(installed.contentSha256!==lock.runtime.contentSha256
            ||installed.source?.commit!==lock.runtime.upstreamCommit){
            fail('Installed SDK runtime does not match arcane.lock.json.');
        }
    });
    await add('app-entry',async()=>{
        const entryPath=path.join(resolved.appRoot,resolved.app.manifest.entry);
        const info=await lstat(entryPath);
        if(info.isSymbolicLink()||!info.isFile())fail(`apps/${resolved.appId}/index.html must be a real file.`);
        assertHtmlContract(await readFile(entryPath,'utf8'),resolved.appId);
    });
    const receipt=Object.freeze({
        valid:true,
        workspaceRoot:resolved.workspaceRoot,
        appId:resolved.appId,
        appRoot:resolved.appRoot,
        config:resolved.config,
        app:resolved.app,
        lock,
        checks:Object.freeze(checks)
    });
    await emit(onEvent,{type:'workspace.validate.completed',workspaceRoot:resolved.workspaceRoot,appId:resolved.appId,checks});
    return receipt;
}
