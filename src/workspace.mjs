import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {
    normalizeRelativePath,
    validateAppConfig as validatePackagerAppConfig,
    validateRootConfig as validatePackagerRootConfig
} from './packager/core.mjs';
import {loadAppDescriptor} from './app-descriptor.mjs';
import {SDK_NAME as EXPECTED_SDK_NAME} from './constants.mjs';
import {inspectImportMapHtml} from './import-map.mjs';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const NPM_PACKAGE_NAME_PATTERN=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const ROOT_CONFIG_NAME='arcane-packager.json';
const APP_CONFIG_NAME='arcane-package.json';
const completeValue=value=>value;

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
    if(typeof onEvent==='function')await onEvent(event);
}

async function readJson(filePath,label){
    let text;
    try{
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
    try{info=await stat(directory);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${directory}.`);
        throw error;
    }
    if(!info.isDirectory())fail(`${label} must be a directory: ${directory}.`);
}

function sameDirectoryPath(left,right){
    const normalize=value=>{
        const resolved=path.resolve(value);
        return process.platform==='win32'?resolved.toLocaleLowerCase('en-US'):resolved;
    };
    return normalize(left)===normalize(right);
}

function sdkPackageSourceForDependency(dependencyName){
    if(typeof dependencyName!=='string'||dependencyName.length>214
        ||!NPM_PACKAGE_NAME_PATTERN.test(dependencyName)){
        fail(`Invalid installed SDK dependency name: ${String(dependencyName)}.`);
    }
    const source=`node_modules/${dependencyName}`;
    try{
        if(normalizeRelativePath(source,'installed SDK package source')!==source)throw new Error();
    }catch{
        fail(`Invalid installed SDK package source for dependency ${dependencyName}.`);
    }
    return source;
}

function dependencyNameForSdkPackageSource(source){
    if(typeof source!=='string'||!source.startsWith('node_modules/'))return null;
    const dependencyName=source.slice('node_modules/'.length);
    try{
        return sdkPackageSourceForDependency(dependencyName)===source?dependencyName:null;
    }catch{
        return null;
    }
}

function routeIncludeMatches(actual,wanted,optionalSecurity){
    if(!Array.isArray(actual)||!Array.isArray(wanted))return false;
    if(actual.length===wanted.length
        &&actual.every(function sameIncludedPath(value,index){return value===wanted[index];})){
        return true;
    }
    return optionalSecurity
        &&wanted.at(-1)==='security'
        &&actual.length===wanted.length-1
        &&actual.every(function sameFunctionalPath(value,index){return value===wanted[index];});
}

export function resolveSdkPackageDeclaration(rootPackage,{
    allowMissing=false,
    packageSource
}={}){
    if(!isObject(rootPackage))fail('package.json must contain a JSON object.');
    const candidates=[];
    for(const groupName of ['devDependencies','dependencies']){
        const group=rootPackage[groupName];
        if(group===undefined)continue;
        if(!isObject(group))fail(`package.json ${groupName} must be a JSON object.`);
        for(const [dependencyName,specifier] of Object.entries(group)){
            const canonicalName=dependencyName===EXPECTED_SDK_NAME;
            const aliasTarget=typeof specifier==='string'
                &&(specifier===`npm:${EXPECTED_SDK_NAME}`
                    ||specifier.startsWith(`npm:${EXPECTED_SDK_NAME}@`));
            if(!canonicalName&&!aliasTarget)continue;
            if(typeof specifier!=='string'||!specifier.trim()){
                fail(`package.json ${groupName}.${dependencyName} must declare an SDK package version or source.`);
            }
            candidates.push(completeValue({
                dependencyName,
                dependencyGroup:groupName,
                packageSource:sdkPackageSourceForDependency(dependencyName),
                specifier
            }));
        }
    }
    if(candidates.length>1){
        fail('package.json must declare exactly one Arcane SDK installation; remove duplicate canonical or alias declarations.');
    }
    if(candidates.length===0){
        if(allowMissing&&packageSource===undefined)return null;
        fail(
            `package.json must declare exactly one ${EXPECTED_SDK_NAME} installation.`
        );
    }
    const [declaration]=candidates;
    if(packageSource!==undefined&&declaration.packageSource!==packageSource){
        fail(
            `${ROOT_CONFIG_NAME} SDK license source ${String(packageSource)} does not match `
            +`the declared SDK installation ${declaration.packageSource}.`
        );
    }
    return declaration;
}

function classifyRootConfig(config){
    const validated=validatePackagerRootConfig(config,ROOT_CONFIG_NAME);
    const routes=validated.sharedPayloads['browser-runtime'];
    if(!Array.isArray(routes))fail(`${ROOT_CONFIG_NAME} must define browser-runtime routes.`);
    const externalPackageSource=routes.length===2
        &&dependencyNameForSdkPackageSource(routes[1]?.source)!==null
        ?routes[1].source
        :null;
    const external=[
        {
            source:'arcane',
            destination:'arcane',
            include:['components','css','dependencies','entities','img','modules','sdk','security']
        },
        {
            source:externalPackageSource,
            destination:'licenses/arcane-os',
            include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']
        }
    ];
    const integrated=[
        {
            source:'arcane',
            destination:'arcane',
            include:['components','css','dependencies','entities','img','modules','sdk','security']
        }
    ];
    const matches=(expected,{optionalArcaneSecurity=false}={})=>{
        if(routes.length!==expected.length)return false;
        return routes.every(function routeMatches(route,index){
            const wanted=expected[index];
            return isObject(route)
                &&Object.keys(route).every(function knownRouteKey(key){
                    return ['source','destination','include','exclude'].includes(key);
                })
                &&route.source===wanted.source&&route.destination===wanted.destination
                &&routeIncludeMatches(
                    route.include,
                    wanted.include,
                    optionalArcaneSecurity&&index===0
                        &&wanted.source==='arcane'&&wanted.destination==='arcane'
                )
                &&Array.isArray(route.exclude)&&route.exclude.length===0;
        });
    };
    let workspaceMode;
    if(matches(external,{optionalArcaneSecurity:true})){
        workspaceMode='external';
    }else if(matches(integrated,{optionalArcaneSecurity:true})){
        workspaceMode='integrated';
    }else{
        fail(`${ROOT_CONFIG_NAME} browser-runtime routes must match the external SDK or integrated Arcane workspace contract.`);
    }
    return completeValue({
        ...validated,
        workspaceMode,
        browserRuntimeLayout:'physical-v1',
        ...(workspaceMode==='external'?{sdkPackageSource:externalPackageSource}:{})
    });
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
            apps.push(completeValue({
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
    return completeValue(apps);
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
    return completeValue({
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
    return completeValue({
        workspaceRoot:canonicalRoot,
        config,
        app,
        appId:app.appId,
        appRoot:app.appRoot,
        appIds:completeValue(apps.map(item=>item.appId))
    });
}

export async function resolveInstalledSdkInstallation(workspaceRoot,declaration){
    let current=workspaceRoot;
    for(const segment of declaration.packageSource.split('/')){
        current=path.join(current,segment);
        await assertRealDirectory(current,`Installed SDK package path ${declaration.packageSource}`);
    }
    const canonicalPackageRoot=await realpath(current);
    if(!sameDirectoryPath(current,canonicalPackageRoot)){
        fail(`Installed SDK package root must be one direct physical directory: ${current}.`);
    }
    const installedPackage=await readJson(
        path.join(canonicalPackageRoot,'package.json'),
        'installed SDK package manifest'
    );
    if(installedPackage.name!==EXPECTED_SDK_NAME||typeof installedPackage.version!=='string'){
        fail(`Installed SDK package must identify as ${EXPECTED_SDK_NAME}.`);
    }
    const runtimeRoot=path.join(canonicalPackageRoot,'runtime');
    const browserRuntimeRoot=path.join(canonicalPackageRoot,'browser-runtime');
    await Promise.all([
        assertRealDirectory(runtimeRoot,'Installed SDK runtime root'),
        assertRealDirectory(browserRuntimeRoot,'Installed SDK browser runtime root')
    ]);
    return completeValue({
        dependencyName:declaration.dependencyName,
        packageSource:declaration.packageSource,
        canonicalPackageRoot,
        packageName:installedPackage.name,
        packageVersion:installedPackage.version,
        runtimeRoot,
        browserRuntimeRoot
    });
}

function assertHtmlContract(source,appId,{
    entry='index.html',
    strictStyles=true,
    allowMissingManagedImportMap=false
}={}){
    const entryLabel=`apps/${appId}/${entry}`;
    const htmlContract=inspectImportMapHtml(source);
    const appIdMetadata=htmlContract.metas.filter(meta=>meta.name==='arcane-app-id');
    if(appIdMetadata.length!==1||appIdMetadata[0].content!==appId){
        fail(`${entryLabel} must declare exactly one active matching arcane-app-id metadata element.`);
    }
    if(htmlContract.bases.length!==1||htmlContract.bases[0].href!=='../../'){
        fail(`${entryLabel} must declare exactly one active <base href="../../">.`);
    }
    const resourcePath=value=>value.split(/[?#]/u,1)[0];
    const styles=htmlContract.links.filter(link=>link.rel
        .split(/[\t\n\f\r ]+/u).includes('stylesheet'));
    const positionOfStyle=expected=>styles.find(link=>resourcePath(link.href)===expected)?.start??-1;
    const theme=positionOfStyle('./arcane/css/theme.css');
    const primitives=positionOfStyle('./arcane/css/primitives.css');
    const escapedAppId=appId.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
    const appStyle=styles.find(link=>new RegExp(
        `^(?:\\./|/)apps/${escapedAppId}/[^/]+\\.css$`,
        'u'
    ).test(resourcePath(link.href)))?.start??-1;
    const modules=htmlContract.scripts.filter(script=>script.type==='module'&&script.src);
    const bootstrap=modules.find(script=>resourcePath(script.src)
        ==='./arcane/modules/ThemeBootstrap.js')?.start??-1;
    if(htmlContract.managedMaps.length>1){
        fail(`${entryLabel} must contain at most one active managed Arcane import map.`);
    }
    const managedImportMap=htmlContract.managedMaps[0]?.start??-1;
    const firstModule=htmlContract.firstModulePosition;
    const appModule=modules.find(script=>new RegExp(
        `^(?:\\./|/)apps/${escapedAppId}/.+\\.(?:js|mjs)$`,
        'u'
    ).test(resourcePath(script.src)))?.start??-1;
    if(theme<0){
        fail(`${entryLabel} must load the shared Arcane theme.css.`);
    }
    if(appModule<0){
        fail(`${entryLabel} must load an active app-local module script.`);
    }
    if(strictStyles&&(primitives<=theme||appStyle<=primitives)){
        fail(`${entryLabel} must load theme.css, primitives.css, and app CSS in that order.`);
    }
    if(!strictStyles&&((primitives>=0&&primitives<=theme)||(appStyle>=0&&appStyle<=theme))){
        fail(`${entryLabel} must load shared and app CSS after theme.css.`);
    }
    if(bootstrap>=0&&appModule>=0&&appModule<=bootstrap){
        fail(`${entryLabel} must load ThemeBootstrap.js before app-local module scripts.`);
    }
    if((managedImportMap>=0&&htmlContract.bases[0].end>managedImportMap)
        ||(firstModule>=0&&htmlContract.bases[0].end>firstModule)){
        fail(`${entryLabel} must place its base element before import maps and module loads.`);
    }
    if(bootstrap<0&&(
        (managedImportMap<0&&!allowMissingManagedImportMap)
        ||(managedImportMap>=0&&appModule>=0&&appModule<=managedImportMap)
    )){
        fail(
            `${entryLabel} must install its managed Arcane import map before app-local `
            +'module scripts when ThemeBootstrap.js is imported by name.'
        );
    }
}

export async function validateDiscoveredApplication({
    workspaceRoot,
    workspaceMode,
    workspaceConfig,
    app,
    allowMissingManagedImportMap=false,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    if(!app||typeof app.appId!=='string'||!APP_ID_PATTERN.test(app.appId)
        ||typeof app.appRoot!=='string'
        ||!app.manifest||!app.descriptor){
        fail('A discovered Arcane application is required for focused validation.');
    }
    const canonicalWorkspaceRoot=await realpath(workspaceRoot);
    await assertRealDirectory(path.join(canonicalWorkspaceRoot,'apps'),'Workspace apps root');
    const expectedAppRoot=path.join(canonicalWorkspaceRoot,'apps',app.appId);
    if(!sameDirectoryPath(app.appRoot,expectedAppRoot)){
        fail(`Discovered app ${app.appId} does not belong to the selected workspace.`);
    }
    const canonicalAppRoot=await realpath(app.appRoot);
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
    const configPath=path.join(canonicalAppRoot,APP_CONFIG_NAME);
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
        appRoot:canonicalAppRoot,
        appId:app.appId,
        packageManifest:rawManifest
    });
    const descriptor=loadedDescriptor.descriptor;
    const freshApp=completeValue({
        appId:app.appId,
        appRoot:canonicalAppRoot,
        manifest,
        descriptor,
        descriptorSource:loadedDescriptor.source,
        descriptorPath:loadedDescriptor.descriptorPath
    });
    const entryPath=path.join(canonicalAppRoot,manifest.entry);
    const info=await stat(entryPath);
    if(!info.isFile()){
        fail(`apps/${app.appId}/${manifest.entry} must be a file.`);
    }
    assertHtmlContract(await readFile(entryPath,'utf8'),app.appId,{
        entry:manifest.entry,
        strictStyles:workspaceMode==='external',
        allowMissingManagedImportMap
    });
    const result=completeValue({
        valid:true,
        workspaceRoot:canonicalWorkspaceRoot,
        workspaceMode,
        appId:app.appId,
        appRoot:canonicalAppRoot,
        app:freshApp
    });
    await emit(onEvent,{
        type:'workspace.application.validated',
        workspaceRoot:canonicalWorkspaceRoot,
        appId:app.appId
    });
    return result;
}

export async function validateWorkspace({
    workspaceRoot=process.cwd(),
    appId,
    allowMissingManagedImportMap=false,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const resolved=await resolveWorkspace({workspaceRoot,appId});
    await emit(onEvent,{type:'workspace.validate.started',workspaceRoot:resolved.workspaceRoot,appId:resolved.appId});
    const checks=[];
    const add=async(name,operation)=>{
        throwIfAborted(signal);
        await operation();
        checks.push(completeValue({name,ok:true}));
        await emit(onEvent,{type:'workspace.validate.check',name,ok:true});
    };
    let sdkDeclaration;
    let sdkInstallation;
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
    await add('package',async()=>{
        const rootPackage=await readJson(path.join(resolved.workspaceRoot,'package.json'),'package.json');
        if(workspaceMode==='integrated'){
            if(rootPackage?.name!=='arcane-os'||rootPackage?.type!=='module'){
                fail('An integrated Arcane workspace package.json must identify as arcane-os and use modules.');
            }
            return;
        }
        const declaration=resolveSdkPackageDeclaration(rootPackage,{
            packageSource:resolved.config.sdkPackageSource
        });
        sdkDeclaration=declaration;
        if(rootPackage?.private!==true||rootPackage?.type!=='module'){
            fail(
                `package.json must be private, use modules, and declare one `
                +`${EXPECTED_SDK_NAME} installation.`
            );
        }
    });
    if(workspaceMode==='external'){
        await add('installed-runtime',async()=>{
            sdkInstallation=await resolveInstalledSdkInstallation(
                resolved.workspaceRoot,
                sdkDeclaration
            );
        });
    }else{
        await add('workspace-runtime',async()=>{
            for(const [relative,label] of [
                ['arcane','Integrated Arcane runtime'],
                [path.join('arcane','dependencies','strong-type'),'Integrated strong-type runtime']
            ]){
                const info=await stat(path.join(resolved.workspaceRoot,relative));
                if(!info.isDirectory()){
                    fail(`${label} must be a directory.`);
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
            allowMissingManagedImportMap,
            signal,
            onEvent
        });
    });
    const result=completeValue({
        valid:true,
        workspaceMode,
        workspaceRoot:resolved.workspaceRoot,
        appId:resolved.appId,
        appRoot:resolved.appRoot,
        config:resolved.config,
        app:validatedApplication.app,
        ...(sdkInstallation?{sdkInstallation}:{}),
        checks:completeValue(checks)
    });
    await emit(onEvent,{type:'workspace.validate.completed',workspaceRoot:resolved.workspaceRoot,appId:resolved.appId,checks});
    return result;
}
