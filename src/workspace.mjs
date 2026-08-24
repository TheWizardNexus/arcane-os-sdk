import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {
    validateAppConfig as validatePackagerAppConfig,
    validateRootConfig as validatePackagerRootConfig
} from './packager/core.mjs';
import {appDescriptorSha256,loadAppDescriptor} from './app-descriptor.mjs';
import {
    SDK_NAME as EXPECTED_SDK_NAME,
    SDK_VERSION as EXPECTED_SDK_VERSION
} from './constants.mjs';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
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

function classifyRootConfig(config){
    const validated=validatePackagerRootConfig(config,ROOT_CONFIG_NAME);
    const routes=validated.sharedPayloads['browser-runtime'];
    if(!Array.isArray(routes))fail(`${ROOT_CONFIG_NAME} must define browser-runtime routes.`);
    const external=[
        {
            source:'node_modules/arcane-os/runtime/arcane',
            destination:'arcane',
            include:['components','css','entities','img','modules','security']
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
    const integrated=[
        {
            source:'arcane',
            destination:'arcane',
            include:['components','css','entities','img','modules','security']
        },
        {
            source:'node_modules/strong-type',
            destination:'node_modules/strong-type',
            include:['index.js','licence','package.json']
        }
    ];
    const matches=expected=>routes.length===expected.length&&routes.every((route,index)=>{
        const wanted=expected[index];
        return isObject(route)&&Object.keys(route).every(key=>['source','destination','include','exclude'].includes(key))
            &&route.source===wanted.source&&route.destination===wanted.destination
            &&JSON.stringify(route.include)===JSON.stringify(wanted.include)
            &&Array.isArray(route.exclude)&&route.exclude.length===0;
    });
    let workspaceMode;
    if(matches(external)){
        workspaceMode='external';
    }else if(matches(integrated)){
        workspaceMode='integrated';
    }else{
        fail(`${ROOT_CONFIG_NAME} browser-runtime routes must match the external SDK or integrated Arcane workspace contract.`);
    }
    return Object.freeze({...validated,workspaceMode});
}

async function discoverAppsInRoot(root,config){
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
            const configPath=path.join(appRoot,APP_CONFIG_NAME);
            const manifest=await readJson(configPath,`apps/${entry.name}/${APP_CONFIG_NAME}`);
            const validatedManifest=validatePackagerAppConfig(manifest,entry.name,config,configPath);
            if(!validatedManifest.shared.includes('browser-runtime')){
                fail(`apps/${entry.name}/${APP_CONFIG_NAME} must include the browser-runtime shared payload.`);
            }
            const descriptor=await loadAppDescriptor({
                workspaceRoot:root,
                appRoot,
                appId:entry.name,
                packageManifest:manifest
            });
            apps.push(Object.freeze({
                appId:entry.name,
                appRoot,
                manifest:validatedManifest,
                descriptor:descriptor.descriptor,
                descriptorSource:descriptor.source,
                descriptorPath:descriptor.descriptorPath
            }));
        }catch(error){
            if(!String(error?.message).includes('does not exist'))throw error;
        }
    }
    return Object.freeze(apps);
}

export async function discoverApps(workspaceRoot=process.cwd()){
    const profile=await inspectWorkspaceProfile(workspaceRoot);
    return discoverAppsInRoot(profile.workspaceRoot,profile.config);
}

export async function inspectWorkspaceProfile(workspaceRoot=process.cwd()){
    const requested=path.resolve(workspaceRoot);
    await assertRealDirectory(requested,'Workspace');
    const canonicalRoot=await realpath(requested);
    const config=classifyRootConfig(
        await readJson(path.join(canonicalRoot,ROOT_CONFIG_NAME),ROOT_CONFIG_NAME)
    );
    return Object.freeze({
        workspaceRoot:canonicalRoot,
        workspaceMode:config.workspaceMode,
        config
    });
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
    const profile=await inspectWorkspaceProfile(workspaceRoot);
    const canonicalRoot=profile.workspaceRoot;
    const config=profile.config;
    const apps=await discoverAppsInRoot(canonicalRoot,config);
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

function assertHtmlContract(source,appId,{entry='index.html',strictStyles=true}={}){
    const entryLabel=`apps/${appId}/${entry}`;
    if(!new RegExp(`<meta\\s+name=["']arcane-app-id["']\\s+content=["']${appId}["']`).test(source)){
        fail(`${entryLabel} must declare matching arcane-app-id metadata.`);
    }
    if(!/<base\s+href=["']\.\.\/\.\.\/["']/.test(source)){
        fail(`${entryLabel} must declare <base href="../../">.`);
    }
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyleMatches=[...source.matchAll(new RegExp(`(?:\\./|/)apps/${appId.replaceAll('-','\\-')}/[^"']+\\.css(?:\\?[^"']*)?(?=["'])`, 'g'))];
    const appStyle=appStyleMatches.length?Math.min(...appStyleMatches.map(match=>match.index)):-1;
    const bootstrap=source.indexOf('./arcane/modules/ThemeBootstrap.js');
    const appModuleMatches=[...source.matchAll(new RegExp(`(?:\\./|/)apps/${appId.replaceAll('-','\\-')}/[^"']+\\.(?:js|mjs)(?:\\?[^"']*)?(?=["'])`, 'g'))];
    const appModule=appModuleMatches.length?Math.min(...appModuleMatches.map(match=>match.index)):-1;
    if(theme<0){
        fail(`${entryLabel} must load the shared Arcane theme.css.`);
    }
    if(strictStyles&&(primitives<=theme||appStyle<=primitives)){
        fail(`${entryLabel} must load theme.css, primitives.css, and app CSS in that order.`);
    }
    if(!strictStyles&&((primitives>=0&&primitives<=theme)||(appStyle>=0&&appStyle<=theme))){
        fail(`${entryLabel} must load shared and app CSS after theme.css.`);
    }
    if(bootstrap<0||(appModule>=0&&appModule<=bootstrap)){
        fail(`${entryLabel} must load ThemeBootstrap.js before app-local module scripts.`);
    }
}

export async function validateDiscoveredApplication({
    workspaceRoot,
    workspaceMode,
    workspaceConfig,
    app,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    if(!app||typeof app.appId!=='string'||typeof app.appRoot!=='string'
        ||!app.manifest||!app.descriptor){
        fail('A discovered Arcane application is required for focused validation.');
    }
    const canonicalWorkspaceRoot=path.resolve(workspaceRoot);
    const expectedAppRoot=path.join(canonicalWorkspaceRoot,'apps',app.appId);
    if(path.resolve(app.appRoot)!==expectedAppRoot){
        fail(`Discovered app ${app.appId} does not belong to the selected workspace.`);
    }
    let config=workspaceConfig;
    if(!config){
        const profile=await inspectWorkspaceProfile(canonicalWorkspaceRoot);
        if(profile.workspaceMode!==workspaceMode){
            fail('The selected Arcane workspace profile changed before focused validation.');
        }
        config=profile.config;
    }
    if(!isObject(config?.sharedPayloads)){
        fail('The selected Arcane workspace configuration is unavailable for focused validation.');
    }
    const configPath=path.join(app.appRoot,APP_CONFIG_NAME);
    const rawManifest=await readJson(
        configPath,
        `apps/${app.appId}/${APP_CONFIG_NAME}`
    );
    const manifest=validatePackagerAppConfig(rawManifest,app.appId,config,configPath);
    if(!manifest.shared.includes('browser-runtime')){
        fail(`apps/${app.appId}/${APP_CONFIG_NAME} must include the browser-runtime shared payload.`);
    }
    const loadedDescriptor=await loadAppDescriptor({
        workspaceRoot:canonicalWorkspaceRoot,
        appRoot:app.appRoot,
        appId:app.appId,
        packageManifest:rawManifest
    });
    const descriptor=loadedDescriptor.descriptor;
    if(appDescriptorSha256(descriptor)!==appDescriptorSha256(app.descriptor)){
        fail(
            `The canonical descriptor for ${app.appId} changed after application discovery.`,
            'ARCANE_INTEGRITY_FAILED'
        );
    }
    const freshApp=Object.freeze({
        appId:app.appId,
        appRoot:app.appRoot,
        manifest,
        descriptor,
        descriptorSource:loadedDescriptor.source,
        descriptorPath:loadedDescriptor.descriptorPath
    });
    const entryPath=path.join(app.appRoot,manifest.entry);
    const info=await lstat(entryPath);
    if(info.isSymbolicLink()||!info.isFile()){
        fail(`apps/${app.appId}/${manifest.entry} must be a real file.`);
    }
    assertHtmlContract(await readFile(entryPath,'utf8'),app.appId,{
        entry:manifest.entry,
        strictStyles:workspaceMode==='external'
    });
    const receipt=Object.freeze({
        valid:true,
        workspaceRoot:canonicalWorkspaceRoot,
        workspaceMode,
        appId:app.appId,
        appRoot:app.appRoot,
        app:freshApp
    });
    await emit(onEvent,{
        type:'workspace.application.validated',
        workspaceRoot:canonicalWorkspaceRoot,
        appId:app.appId
    });
    return receipt;
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
    let validatedApplication;
    const workspaceMode=resolved.config.workspaceMode;
    await add('workspace-profile',async()=>{
        if(workspaceMode!=='external'&&workspaceMode!=='integrated'){
            fail(`Unsupported Arcane workspace mode: ${String(workspaceMode)}.`);
        }
    });
    await add('descriptor',async()=>{
        if(resolved.app.descriptor.id!==resolved.appId){
            fail('The selected Arcane application descriptor does not match the app id.');
        }
    });
    if(workspaceMode==='external'){
        await add('lock',async()=>{
            lock=validateLock(await readJson(path.join(resolved.workspaceRoot,'arcane.lock.json'),'arcane.lock.json'));
        });
    }
    await add('package',async()=>{
        const rootPackage=await readJson(path.join(resolved.workspaceRoot,'package.json'),'package.json');
        if(workspaceMode==='integrated'){
            if(rootPackage?.name!=='arcane-os'||rootPackage?.type!=='module'){
                fail('An integrated Arcane workspace package.json must identify as arcane-os and use modules.');
            }
            return;
        }
        const configured=rootPackage?.devDependencies?.[EXPECTED_SDK_NAME]
            ??rootPackage?.dependencies?.[EXPECTED_SDK_NAME];
        const supported=configured===EXPECTED_SDK_VERSION
            ||(typeof configured==='string'&&LOCAL_TARBALL_PATTERN.test(configured)
                &&!/[\x00-\x1f\x7f]/.test(configured));
        if(rootPackage?.private!==true||rootPackage?.type!=='module'||!supported){
            fail(`package.json must be private, use modules, and declare ${EXPECTED_SDK_NAME} as ${EXPECTED_SDK_VERSION} or a local file: tarball.`);
        }
    });
    if(workspaceMode==='external'){
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
    }else{
        await add('workspace-runtime',async()=>{
            for(const [relative,label] of [
                ['arcane','Integrated Arcane runtime'],
                [path.join('node_modules','strong-type'),'Integrated strong-type runtime']
            ]){
                const info=await lstat(path.join(resolved.workspaceRoot,relative));
                if(info.isSymbolicLink()||!info.isDirectory()){
                    fail(`${label} must be a real directory.`);
                }
            }
        });
    }
    await add('app-entry',async()=>{
        validatedApplication=await validateDiscoveredApplication({
            workspaceRoot:resolved.workspaceRoot,
            workspaceMode,
            workspaceConfig:resolved.config,
            app:resolved.app,
            signal,
            onEvent
        });
    });
    const receipt=Object.freeze({
        valid:true,
        workspaceMode,
        workspaceRoot:resolved.workspaceRoot,
        appId:resolved.appId,
        appRoot:resolved.appRoot,
        config:resolved.config,
        app:validatedApplication.app,
        lock,
        checks:Object.freeze(checks)
    });
    await emit(onEvent,{type:'workspace.validate.completed',workspaceRoot:resolved.workspaceRoot,appId:resolved.appId,checks});
    return receipt;
}
