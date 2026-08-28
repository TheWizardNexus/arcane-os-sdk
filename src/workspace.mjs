import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {
    normalizeRelativePath,
    validateAppConfig as validatePackagerAppConfig,
    validateRootConfig as validatePackagerRootConfig
} from './packager/core.mjs';
import {appDescriptorSha256,loadAppDescriptor} from './app-descriptor.mjs';
import {
    SDK_NAME as EXPECTED_SDK_NAME,
    SDK_VERSION as EXPECTED_SDK_VERSION
} from './constants.mjs';
import {inspectImportMapHtml} from './import-map.mjs';
import {
    SDK_BROWSER_RUNTIME_CONTENT_SHA256,
    SDK_BROWSER_RUNTIME_MANIFEST_SHA256
} from './sdk-browser-runtime.mjs';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const LOCAL_TARBALL_PATTERN=/^file:.+\.tgz$/iu;
const NPM_PACKAGE_NAME_PATTERN=/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const EXACT_SDK_ALIAS=`npm:${EXPECTED_SDK_NAME}@${EXPECTED_SDK_VERSION}`;
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

function sameDirectoryIdentity(left,right){
    return left.device===right.device&&left.inode===right.inode;
}

function sameDirectoryPath(left,right){
    const normalize=value=>{
        const resolved=path.resolve(value);
        return process.platform==='win32'?resolved.toLocaleLowerCase('en-US'):resolved;
    };
    return normalize(left)===normalize(right);
}

async function captureRealDirectoryIdentity(directory,label){
    const requested=path.resolve(directory);
    let requestedInfo;
    try{requestedInfo=await lstat(requested,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${requested}.`);
        throw error;
    }
    if(requestedInfo.isSymbolicLink()||!requestedInfo.isDirectory()){
        fail(`${label} must be a real directory: ${requested}.`);
    }
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical,{bigint:true});
    const requestedIdentity=Object.freeze({
        device:requestedInfo.dev,
        inode:requestedInfo.ino
    });
    const canonicalIdentity=Object.freeze({
        device:canonicalInfo.dev,
        inode:canonicalInfo.ino
    });
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()
        ||!sameDirectoryIdentity(requestedIdentity,canonicalIdentity)){
        fail(`${label} must resolve to one physical directory: ${requested}.`);
    }
    return Object.freeze({
        requested,
        requestedIdentity,
        canonical,
        identity:canonicalIdentity
    });
}

async function assertRealDirectoryIdentity(captured,label){
    let canonical;
    let requestedInfo;
    let canonicalInfo;
    try{
        [canonical,requestedInfo,canonicalInfo]=await Promise.all([
            realpath(captured.requested),
            lstat(captured.requested,{bigint:true}),
            lstat(captured.canonical,{bigint:true})
        ]);
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`${label} changed while focused validation was active.`,
                'ARCANE_INTEGRITY_FAILED');
        }
        throw error;
    }
    const requestedIdentity={device:requestedInfo.dev,inode:requestedInfo.ino};
    const canonicalIdentity={device:canonicalInfo.dev,inode:canonicalInfo.ino};
    if(!sameDirectoryPath(canonical,captured.canonical)
        ||requestedInfo.isSymbolicLink()||!requestedInfo.isDirectory()
        ||canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()
        ||!sameDirectoryIdentity(requestedIdentity,captured.requestedIdentity)
        ||!sameDirectoryIdentity(requestedIdentity,captured.identity)
        ||!sameDirectoryIdentity(canonicalIdentity,captured.identity)){
        fail(`${label} changed while focused validation was active.`,'ARCANE_INTEGRITY_FAILED');
    }
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

function supportedCanonicalSdkDeclaration(value){
    return value===EXPECTED_SDK_VERSION
        ||(typeof value==='string'&&LOCAL_TARBALL_PATTERN.test(value)
            &&!/[\x00-\x1f\x7f]/.test(value));
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
            const supported=canonicalName
                ?supportedCanonicalSdkDeclaration(specifier)
                :specifier===EXACT_SDK_ALIAS;
            if(!supported){
                fail(
                    `package.json ${groupName}.${dependencyName} must be ${EXPECTED_SDK_VERSION}, `
                    +`a local file: tarball under ${EXPECTED_SDK_NAME}, or the exact npm alias `
                    +`${EXACT_SDK_ALIAS} under a distinct dependency key.`
                );
            }
            candidates.push(Object.freeze({
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
            `package.json must declare exactly one ${EXPECTED_SDK_NAME} installation as `
            +`${EXPECTED_SDK_VERSION}, a local file: tarball, or the exact npm alias ${EXACT_SDK_ALIAS}.`
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

function sdkManifestPaths(packageSource){
    return Object.freeze({
        runtimeManifest:`${packageSource}/runtime/ARCANE_RUNTIME_RELEASE.json`,
        browserRuntimeManifest:`${packageSource}/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json`
    });
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
    const integratedLegacy=[
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
    let browserRuntimeLayout;
    if(matches(external)){
        workspaceMode='external';
        browserRuntimeLayout='physical-v1';
    }else if(matches(integrated)){
        workspaceMode='integrated';
        browserRuntimeLayout='physical-v1';
    }else if(matches(integratedLegacy)){
        workspaceMode='integrated';
        browserRuntimeLayout='integrated-legacy';
    }else{
        fail(`${ROOT_CONFIG_NAME} browser-runtime routes must match the external SDK or integrated Arcane workspace contract.`);
    }
    return Object.freeze({
        ...validated,
        workspaceMode,
        browserRuntimeLayout,
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

function validateLock(lock,sdkDeclaration){
    const browser=lock?.sdkBrowserRuntime;
    const browserSource=browser?.source;
    const dependencies=browserSource?.dependencies;
    const exactKeys=(value,keys)=>isObject(value)
        &&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
    const expectedDependencies=[
        {
            name:'event-pubsub',
            version:'6.1.0',
            resolved:'https://registry.npmjs.org/event-pubsub/-/event-pubsub-6.1.0.tgz',
            integrity:'sha512-FEMlhTxwqGM0hztTixG6FhVFXqp7Eq1ltk5mSreK6Mhy3xWWpLAzEUR6OMvMdNqT3jgSxA8JDhnhyAG3X4Xy7Q=='
        },
        {
            name:'strong-type',
            version:'2.0.0',
            resolved:'https://registry.npmjs.org/strong-type/-/strong-type-2.0.0.tgz',
            integrity:'sha512-HHrY9qYC7yn+5mlewiI3k9RQM9gZqGQsqbomZcd10Ks0h4RlX01nnkWbCe4AsVPCI6KaFvpkWm1nHMD+Ykup6g=='
        },
        {
            name:'@wllama/wllama',
            version:'3.6.0',
            resolved:'https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz',
            integrity:'sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w=='
        }
    ];
    const dependenciesMatch=Array.isArray(dependencies)&&dependencies.length===expectedDependencies.length
        &&dependencies.every((actual,index)=>{
            const expected=expectedDependencies[index];
            return exactKeys(actual,['name','version','resolved','integrity'])
                &&actual.name===expected.name&&actual.version===expected.version
                &&actual.resolved===expected.resolved&&actual.integrity===expected.integrity;
        });
    const manifests=sdkManifestPaths(sdkDeclaration.packageSource);
    if(!exactKeys(lock,['schemaVersion','sdk','runtime','sdkBrowserRuntime','protocols'])
        ||lock.schemaVersion!==1
        ||!exactKeys(lock.sdk,['name','version'])
        ||lock.sdk.name!==EXPECTED_SDK_NAME||lock.sdk.version!==EXPECTED_SDK_VERSION
        ||!exactKeys(lock.runtime,['manifest','contentSha256','upstreamCommit'])
        ||!SHA256_PATTERN.test(lock.runtime.contentSha256)
        ||!/^([a-f0-9]{40})$/.test(lock.runtime.upstreamCommit)
        ||lock.runtime.manifest!==manifests.runtimeManifest
        ||!exactKeys(browser,[
            'manifest','manifestSha256','contentSha256','builder','sdkVersion','source'
        ])
        ||browser.manifest!==manifests.browserRuntimeManifest
        ||browser.manifestSha256!==SDK_BROWSER_RUNTIME_MANIFEST_SHA256
        ||browser.contentSha256!==SDK_BROWSER_RUNTIME_CONTENT_SHA256
        ||browser.builder!=='arcane-sdk-browser-runtime-v1'
        ||browser.sdkVersion!==EXPECTED_SDK_VERSION
        ||!exactKeys(browserSource,[
            'authority','repository','protocol','browserEntry','dependencies'
        ])||browserSource.authority!=='arcane-os-sdk'
        ||browserSource.repository!=='https://github.com/TheWizardNexus/arcane-os-sdk.git'
        ||browserSource.protocol!=='arcane-sdk-browser-runtime/1'
        ||browserSource.browserEntry!=='arcane-os/event-manager'
        ||!dependenciesMatch
        ||!exactKeys(lock.protocols,['arcane','cliEvents','targetAdapter'])
        ||lock.protocols.arcane!=='arcane/1'
        ||lock.protocols.cliEvents!=='arcane-cli-events/1'
        ||lock.protocols.targetAdapter!=='arcane-target-adapter/1'){
        fail('arcane.lock.json is incompatible with this SDK. Run arcane init only after reviewing missing files; existing locks are never overwritten.');
    }
    return lock;
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
    if(installedPackage.name!==EXPECTED_SDK_NAME||installedPackage.version!==EXPECTED_SDK_VERSION){
        fail(`Installed SDK package must identify exactly as ${EXPECTED_SDK_NAME}@${EXPECTED_SDK_VERSION}.`);
    }
    const runtimeRoot=path.join(canonicalPackageRoot,'runtime');
    const browserRuntimeRoot=path.join(canonicalPackageRoot,'browser-runtime');
    await Promise.all([
        assertRealDirectory(runtimeRoot,'Installed SDK runtime root'),
        assertRealDirectory(browserRuntimeRoot,'Installed SDK browser runtime root')
    ]);
    const manifests=sdkManifestPaths(declaration.packageSource);
    return Object.freeze({
        dependencyName:declaration.dependencyName,
        packageSource:declaration.packageSource,
        canonicalPackageRoot,
        packageName:installedPackage.name,
        packageVersion:installedPackage.version,
        runtimeRoot,
        browserRuntimeRoot,
        runtimeManifest:manifests.runtimeManifest,
        browserRuntimeManifest:manifests.browserRuntimeManifest
    });
}

function sameBrowserRuntimeSource(actual,pinned){
    const exactKeys=(value,keys)=>isObject(value)
        &&Object.keys(value).sort().join('\0')===[...keys].sort().join('\0');
    const keys=['authority','repository','protocol','browserEntry','dependencies'];
    if(!exactKeys(actual,keys)||!exactKeys(pinned,keys)
        ||actual.authority!==pinned.authority
        ||actual.repository!==pinned.repository
        ||actual.protocol!==pinned.protocol
        ||actual.browserEntry!==pinned.browserEntry
        ||!Array.isArray(actual.dependencies)||!Array.isArray(pinned.dependencies)
        ||actual.dependencies.length!==pinned.dependencies.length){
        return false;
    }
    const dependencyKeys=['name','version','resolved','integrity'];
    return actual.dependencies.every((dependency,index)=>{
        const expected=pinned.dependencies[index];
        return exactKeys(dependency,dependencyKeys)&&exactKeys(expected,dependencyKeys)
            &&dependency.name===expected.name&&dependency.version===expected.version
            &&dependency.resolved===expected.resolved
            &&dependency.integrity===expected.integrity;
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
    const capturedWorkspace=await captureRealDirectoryIdentity(workspaceRoot,'Workspace');
    const canonicalWorkspaceRoot=capturedWorkspace.canonical;
    const capturedAppsRoot=await captureRealDirectoryIdentity(
        path.join(canonicalWorkspaceRoot,'apps'),
        'Workspace apps root'
    );
    const expectedAppRoot=path.join(canonicalWorkspaceRoot,'apps',app.appId);
    const [capturedExpectedApp,capturedDiscoveredApp]=await Promise.all([
        captureRealDirectoryIdentity(expectedAppRoot,`apps/${app.appId}`),
        captureRealDirectoryIdentity(app.appRoot,`Discovered app ${app.appId}`)
    ]);
    if(!sameDirectoryIdentity(capturedExpectedApp.identity,capturedDiscoveredApp.identity)){
        fail(`Discovered app ${app.appId} does not belong to the selected workspace.`);
    }
    const canonicalAppRoot=capturedExpectedApp.canonical;
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
    if(appDescriptorSha256(descriptor)!==appDescriptorSha256(app.descriptor)){
        fail(
            `The canonical descriptor for ${app.appId} changed after application discovery.`,
            'ARCANE_INTEGRITY_FAILED'
        );
    }
    const freshApp=Object.freeze({
        appId:app.appId,
        appRoot:canonicalAppRoot,
        manifest,
        descriptor,
        descriptorSource:loadedDescriptor.source,
        descriptorPath:loadedDescriptor.descriptorPath
    });
    const entryPath=path.join(canonicalAppRoot,manifest.entry);
    const info=await lstat(entryPath);
    if(info.isSymbolicLink()||!info.isFile()){
        fail(`apps/${app.appId}/${manifest.entry} must be a real file.`);
    }
    assertHtmlContract(await readFile(entryPath,'utf8'),app.appId,{
        entry:manifest.entry,
        strictStyles:workspaceMode==='external',
        allowMissingManagedImportMap
    });
    const assertCapturedDirectories=()=>Promise.all([
        assertRealDirectoryIdentity(capturedWorkspace,'Workspace'),
        assertRealDirectoryIdentity(capturedAppsRoot,'Workspace apps root'),
        assertRealDirectoryIdentity(capturedExpectedApp,`apps/${app.appId}`),
        assertRealDirectoryIdentity(capturedDiscoveredApp,`Discovered app ${app.appId}`)
    ]);
    await assertCapturedDirectories();
    const receipt=Object.freeze({
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
    await assertCapturedDirectories();
    return receipt;
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
        checks.push(Object.freeze({name,ok:true}));
        await emit(onEvent,{type:'workspace.validate.check',name,ok:true});
    };
    let lock;
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
    if(workspaceMode==='external'){
        await add('lock',async()=>{
            sdkDeclaration=resolveSdkPackageDeclaration(
                await readJson(path.join(resolved.workspaceRoot,'package.json'),'package.json'),
                {packageSource:resolved.config.sdkPackageSource}
            );
            lock=validateLock(
                await readJson(path.join(resolved.workspaceRoot,'arcane.lock.json'),'arcane.lock.json'),
                sdkDeclaration
            );
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
        const declaration=resolveSdkPackageDeclaration(rootPackage,{
            packageSource:resolved.config.sdkPackageSource
        });
        if(rootPackage?.private!==true||rootPackage?.type!=='module'){
            fail(
                `package.json must be private, use modules, and declare one exact `
                +`${EXPECTED_SDK_NAME} installation.`
            );
        }
        if(declaration.dependencyName!==sdkDeclaration.dependencyName
            ||declaration.dependencyGroup!==sdkDeclaration.dependencyGroup
            ||declaration.packageSource!==sdkDeclaration.packageSource
            ||declaration.specifier!==sdkDeclaration.specifier){
            fail('The declared SDK installation changed after workspace profile inspection.',
                'ARCANE_INTEGRITY_FAILED');
        }
    });
    if(workspaceMode==='external'){
        await add('installed-runtime',async()=>{
            sdkInstallation=await resolveInstalledSdkInstallation(
                resolved.workspaceRoot,
                sdkDeclaration
            );
            const installed=await readJson(
                path.join(sdkInstallation.runtimeRoot,'ARCANE_RUNTIME_RELEASE.json'),
                'installed SDK runtime manifest'
            );
            if(installed.contentSha256!==lock.runtime.contentSha256
                ||installed.source?.legacyProjection?.commit!==lock.runtime.upstreamCommit){
                fail('Installed SDK runtime does not match arcane.lock.json.');
            }
            const browserManifestPath=path.join(
                sdkInstallation.browserRuntimeRoot,
                'ARCANE_SDK_BROWSER_RELEASE.json'
            );
            const browserBytes=await readFile(browserManifestPath);
            let installedBrowser;
            try{installedBrowser=JSON.parse(browserBytes.toString('utf8'));}
            catch(error){
                fail(`Installed SDK browser runtime manifest is not valid JSON: ${error.message}`);
            }
            if(createHash('sha256').update(browserBytes).digest('hex')
                    !==lock.sdkBrowserRuntime.manifestSha256
                ||installedBrowser.contentSha256!==lock.sdkBrowserRuntime.contentSha256
                ||installedBrowser.builder!==lock.sdkBrowserRuntime.builder
                ||installedBrowser.sdkVersion!==lock.sdkBrowserRuntime.sdkVersion
                ||!sameBrowserRuntimeSource(
                    installedBrowser.source,
                    lock.sdkBrowserRuntime.source
                )){
                fail('Installed SDK browser runtime does not match arcane.lock.json.');
            }
        });
    }else{
        await add('workspace-runtime',async()=>{
            const strongType=resolved.config.browserRuntimeLayout==='integrated-legacy'
                ?path.join('node_modules','strong-type')
                :path.join('arcane','dependencies','strong-type');
            for(const [relative,label] of [
                ['arcane','Integrated Arcane runtime'],
                [strongType,'Integrated strong-type runtime']
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
            allowMissingManagedImportMap,
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
        ...(sdkInstallation?{sdkInstallation}:{}),
        checks:Object.freeze(checks)
    });
    await emit(onEvent,{type:'workspace.validate.completed',workspaceRoot:resolved.workspaceRoot,appId:resolved.appId,checks});
    return receipt;
}
