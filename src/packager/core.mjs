import Is from 'strong-type';
import {
    copyFile,
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {appRelativeRoot,resolveAppRoot,resolvePackageOutputRoot} from '../app-layout.mjs';
import {readInstalledSdkLayout} from '../sdk-runtime-layout.mjs';
import {withWorkspaceOperationLock} from '../workspace-operation-lock.mjs';
import {materializeNativeModules} from './native-modules.mjs';
import {
    applyPwaEntryReferences,
    inspectImportMapHtml,
    readWorkspaceAssetVersion,
    removePwaEntryReferences,
    resolveAssetReference,
    rewriteAssetReferences,
    versionAssetUrl
} from '../import-map.mjs';
import {
    createPwaArtifacts,
    normalizePwaConfig,
    selectPwaFiles,
    PWA_MANIFEST_NAME,
    PWA_OFFLINE_MANIFEST_NAME,
    PWA_WORKER_NAME,
    PWA_BOOTSTRAP_NAME
} from '../pwa.mjs';

const is = new Is(false);

export const ROOT_CONFIG_NAME='arcane-packager.json';
export const APP_CONFIG_NAME='arcane-package.json';
export const RELEASE_MANIFEST_NAME='ARCANE_APP_RELEASE.json';
export const PACKAGER_VERSION='arcane-app-packager-v1';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const SAFE_SHARED_ID_PATTERN=APP_ID_PATTERN;
const WINDOWS_RESERVED_NAME=
    /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const WINDOWS_UNSAFE_FILENAME_CHARACTER_PATTERN=/[<>"|?*]/u;
const TEXT_CONTROL_PATTERN=/[\x00-\x1f\x7f]/u;
const FORBIDDEN_SEGMENTS=new Set(['.agents','.codex','.git','dist','local']);
const APP_DESCRIPTOR_NAME='arcane-app.json';

function fail(message,code='ARCANE_PACKAGE_INVALID'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Arcane package operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

async function emit(onEvent,event){
    if(is.function(onEvent))await onEvent(event);
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

function isPlainObject(value){
    return value!==null&&is.object(value)&&!is.array(value);
}

function copyJson(value){
    return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}

function assertOnlyKeys(value,allowed,label){
    if(!isPlainObject(value))fail(`${label} must be a JSON object.`);
    for(const key of Object.keys(value)){
        if(!allowed.has(key))fail(`${label} has an unsupported key: ${key}`);
    }
}

function normalizeWorkspaceRoot(workspaceRoot){
    if(!is.string(workspaceRoot)||!workspaceRoot.trim()){
        fail('workspaceRoot must be a directory path.');
    }
    return path.resolve(workspaceRoot);
}

export function normalizeRelativePath(value,label='path'){
    if(!is.string(value)||!value||value.includes('\\')||TEXT_CONTROL_PATTERN.test(value)){
        fail(`Unsafe ${label}: ${String(value)}`);
    }
    if(path.posix.isAbsolute(value)||/^[a-z]:/iu.test(value))fail(`Unsafe ${label}: ${value}`);
    const segments=value.split('/');
    for(const segment of segments){
        if(!segment||segment==='.'||segment==='..'||segment.includes(':')
            ||WINDOWS_UNSAFE_FILENAME_CHARACTER_PATTERN.test(segment)
            ||segment.endsWith('.')||segment.endsWith(' ')
            ||WINDOWS_RESERVED_NAME.test(segment)){
            fail(`Unsafe ${label}: ${value}`);
        }
    }
    return segments.join('/');
}

function normalizeRelativeRoot(value,label){
    return value==='.'?'.':normalizeRelativePath(value,label);
}

function pathKey(relative){
    return relative.toLocaleLowerCase('en-US');
}

function sameOrDescendant(candidate,parent){
    const selected=pathKey(candidate);
    const root=pathKey(parent);
    return selected===root||selected.startsWith(`${root}/`);
}

function resolveInside(root,relative,label,{allowRoot=false}={}){
    const normalized=relative==='.'&&allowRoot?'.':normalizeRelativePath(relative,label);
    const candidate=path.resolve(root,...(normalized==='.'?[]:normalized.split('/')));
    const fromRoot=path.relative(path.resolve(root),candidate);
    if((!allowRoot&&fromRoot==='')||fromRoot.startsWith('..')||path.isAbsolute(fromRoot)){
        fail(`${label} leaves its allowed root: ${relative}`);
    }
    return candidate;
}

function isGlobLike(value){
    return /[*?\[\]{}]/u.test(value);
}

function validatePathList(value,label,{required=false,allowRoot=false}={}){
    if(!is.array(value)||(required&&value.length===0)){
        fail(`${label} must be ${required?'a non-empty':'an'} array of literal relative paths.`);
    }
    const normalized=value.map((entry,index)=>{
        const item=allowRoot?normalizeRelativeRoot(entry,`${label}[${index}]`)
            :normalizeRelativePath(entry,`${label}[${index}]`);
        if(isGlobLike(item))fail(`${label}[${index}] must be literal; directories include descendants.`);
        return item;
    });
    if(new Set(normalized.map(pathKey)).size!==normalized.length){
        fail(`${label} contains duplicate paths.`);
    }
    if(required){
        for(let left=0;left<normalized.length;left+=1){
            for(let right=left+1;right<normalized.length;right+=1){
                if(normalized[left]==='.'||normalized[right]==='.'
                    ||sameOrDescendant(normalized[left],normalized[right])
                    ||sameOrDescendant(normalized[right],normalized[left])){
                    fail(`${label} has overlapping paths: ${normalized[left]} and ${normalized[right]}`);
                }
            }
        }
    }
    return normalized;
}

export function normalizeAppDocuments(value,label='documents'){
    if(value===undefined)return undefined;
    if(!is.array(value))fail(`${label} must be an array of application-relative HTML paths.`);
    return value.map(function normalizeDocumentPath(entry,index){
        const document=normalizeRelativePath(entry,`${label}[${index}]`);
        if(!/\.html?$/iu.test(document))fail(`${label}[${index}] must name an HTML or HTM file.`);
        return document;
    });
}

function isAlwaysForbidden(relative){
    return relative.split('/').some(segment=>{
        const key=pathKey(segment);
        return FORBIDDEN_SEGMENTS.has(key)||key==='.env'||key.startsWith('.env.');
    });
}

function isAppSourceForbidden(relative){
    return isAlwaysForbidden(relative)
        ||relative.split('/').some(segment=>pathKey(segment)==='node_modules');
}

function isExcluded(relative,excludes){
    return excludes.some(excluded=>sameOrDescendant(relative,excluded));
}

function assertPresentationText(value,label){
    if(!is.string(value)||!value.trim()){
        fail(`${label} must be nonempty text.`);
    }
    return value;
}

export function parseSemver(value){
    if(!is.string(value))fail(`Invalid semantic version: ${String(value)}`);
    const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
    if(!match)fail(`Invalid semantic version: ${value}`);
    const prerelease=match[4]?match[4].split('.'):[];
    for(const identifier of prerelease){
        if(/^\d+$/u.test(identifier)&&identifier.length>1&&identifier.startsWith('0')){
            fail(`Invalid semantic version: ${value}`);
        }
    }
    const numbers=match.slice(1,4).map(Number);
    if(numbers.some(number=>!is.safeInteger(number))){
        fail(`Semantic version component exceeds JavaScript's safe integer range: ${value}`);
    }
    return {
        major:numbers[0],
        minor:numbers[1],
        patch:numbers[2],
        prerelease,
        build:match[5]?match[5].split('.'):[]
    };
}

function formatSemver(version){
    let rendered=`${version.major}.${version.minor}.${version.patch}`;
    if(version.prerelease?.length)rendered+=`-${version.prerelease.join('.')}`;
    if(version.build?.length)rendered+=`+${version.build.join('.')}`;
    return rendered;
}

export function incrementSemver(value,bump,preid='rc'){
    const current=parseSemver(value);
    if(!['major','minor','patch','prerelease'].includes(bump)){
        fail(`Unsupported semantic version bump: ${String(bump)}`);
    }
    if(bump==='major')return formatSemver({major:current.major+1,minor:0,patch:0});
    if(bump==='minor')return formatSemver({major:current.major,minor:current.minor+1,patch:0});
    if(bump==='patch')return formatSemver({major:current.major,minor:current.minor,patch:current.patch+1});
    if(!is.string(preid)||!/^[0-9A-Za-z-]+$/u.test(preid)){
        fail(`Invalid prerelease identifier: ${String(preid)}`);
    }
    const next={major:current.major,minor:current.minor,patch:current.patch,prerelease:[]};
    if(current.prerelease[0]!==preid){
        if(current.prerelease.length===0)next.patch+=1;
        next.prerelease=[preid,'0'];
        return formatSemver(next);
    }
    next.prerelease=[...current.prerelease];
    const numericIndex=next.prerelease.findLastIndex(identifier=>/^\d+$/u.test(identifier));
    if(numericIndex<0)next.prerelease.push('0');
    else next.prerelease[numericIndex]=String(Number(next.prerelease[numericIndex])+1);
    return formatSemver(next);
}

async function readJson(filePath,label=filePath){
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

function validateSharedRoute(route,label){
    assertOnlyKeys(route,new Set(['source','destination','include','exclude']),label);
    const source=normalizeRelativeRoot(route.source,`${label}.source`);
    const destination=normalizeRelativeRoot(route.destination,`${label}.destination`);
    const include=validatePathList(route.include,`${label}.include`,{required:true,allowRoot:true});
    const exclude=validatePathList(route.exclude??[],`${label}.exclude`);
    if(source==='.'||source==='apps'||source.startsWith('apps/')
        ||source==='dist'||source.startsWith('dist/')||source==='node_modules'
        ||isAlwaysForbidden(source)){
        fail(`${label}.source is outside the shared-payload boundary: ${source}`);
    }
    if(destination==='apps'||destination.startsWith('apps/')
        ||pathKey(destination)===pathKey(RELEASE_MANIFEST_NAME)){
        fail(`${label}.destination overlaps a reserved package path: ${destination}`);
    }
    return {source,destination,include,exclude};
}

export function validateRootConfig(value,configPath=ROOT_CONFIG_NAME){
    assertOnlyKeys(value,new Set(['schemaVersion','appsRoot','distRoot','sharedPayloads']),ROOT_CONFIG_NAME);
    if(value.schemaVersion!==1)fail(`${ROOT_CONFIG_NAME}.schemaVersion must be 1.`);
    if(!['apps','.'].includes(value.appsRoot)||value.distRoot!=='dist'){
        fail(`${ROOT_CONFIG_NAME} must bind appsRoot to "apps" or "." and distRoot to "dist".`);
    }
    if(!isPlainObject(value.sharedPayloads)){
        fail(`${ROOT_CONFIG_NAME}.sharedPayloads must be an object.`);
    }
    const sharedPayloads={};
    for(const [id,routes] of Object.entries(value.sharedPayloads).sort(([left],[right])=>compareText(left,right))){
        if(!SAFE_SHARED_ID_PATTERN.test(id))fail(`Unsafe shared payload id: ${id}`);
        if(!is.array(routes)||routes.length===0){
            fail(`sharedPayloads.${id} must be a non-empty array.`);
        }
        sharedPayloads[id]=routes.map((route,index)=>
            validateSharedRoute(route,`sharedPayloads.${id}[${index}]`)
        );
    }
    return {
        schemaVersion:1,appsRoot:value.appsRoot,distRoot:'dist',sharedPayloads,configPath
    };
}

function normalizeOptionalRecord(value,label){
    if(value===undefined)return undefined;
    if(!isPlainObject(value))fail(`${label} must be an object.`);
    return copyJson(value);
}

export function validateAppConfig(value,appId,rootConfig,configPath=path.posix.join(appRelativeRoot(rootConfig,appId),APP_CONFIG_NAME)){
    assertOnlyKeys(value,new Set([
        'schemaVersion','id','displayName','version','entry','strategy','security',
        'localAIModelPolicy','include','exclude','shared','adapter','pwa','outputDirectory','documents'
    ]),`${appId}/${APP_CONFIG_NAME}`);
    if(value.schemaVersion!==1)fail(`${appId}/${APP_CONFIG_NAME}.schemaVersion must be 1.`);
    if(!is.string(value.id)||value.id!==appId||!APP_ID_PATTERN.test(value.id)){
        fail(`${APP_CONFIG_NAME}.id must be a valid application id matching the selected application: ${String(appId)}.`);
    }
    const displayName=assertPresentationText(value.displayName,`${appId}/${APP_CONFIG_NAME}.displayName`);
    parseSemver(value.version);
    const entry=normalizeRelativePath(value.entry,`${appId}/${APP_CONFIG_NAME}.entry`);
    const documents=normalizeAppDocuments(value.documents,`${appId}/${APP_CONFIG_NAME}.documents`);
    const outputDirectory=value.outputDirectory===undefined?undefined:normalizeRelativePath(
        value.outputDirectory,`${appId}/${APP_CONFIG_NAME}.outputDirectory`
    );
    const include=validatePathList(value.include,`${appId}/${APP_CONFIG_NAME}.include`,{required:true});
    const exclude=validatePathList(value.exclude??[],`${appId}/${APP_CONFIG_NAME}.exclude`);
    if(include.some(allowed=>sameOrDescendant(APP_CONFIG_NAME,allowed))){
        fail(`${appId}/${APP_CONFIG_NAME}.include must not expose the authored package configuration.`);
    }
    if(isAppSourceForbidden(entry)||isExcluded(entry,exclude)
        ||!include.some(allowed=>sameOrDescendant(entry,allowed))){
        fail(`${appId}/${APP_CONFIG_NAME}.entry is not covered by its public include rules.`);
    }
    if(!['static','adapter'].includes(value.strategy)){
        fail(`${appId}/${APP_CONFIG_NAME}.strategy must be "static" or "adapter".`);
    }
    if(!is.array(value.shared)||new Set(value.shared).size!==value.shared.length){
        fail(`${appId}/${APP_CONFIG_NAME}.shared must be an array of unique shared payload ids.`);
    }
    for(const [index,id] of value.shared.entries()){
        if(!is.string(id)||!Object.hasOwn(rootConfig.sharedPayloads,id)){
            fail(`${appId}/${APP_CONFIG_NAME}.shared[${index}] references an unknown shared payload.`);
        }
    }
    let adapter;
    if(value.strategy==='adapter'){
        adapter=normalizeRelativePath(value.adapter,`${appId}/${APP_CONFIG_NAME}.adapter`);
        if(!adapter.startsWith('scripts/')||path.posix.extname(adapter)!=='.mjs'){
            fail(`${appId}/${APP_CONFIG_NAME}.adapter must be an app-local scripts/*.mjs module.`);
        }
    }else if(value.adapter!==undefined){
        fail(`${appId}/${APP_CONFIG_NAME}.adapter is only valid with strategy "adapter".`);
    }
    return {
        schemaVersion:1,
        id:appId,
        displayName,
        version:value.version,
        entry,
        ...(documents===undefined?{}:{documents}),
        ...(outputDirectory===undefined?{}:{outputDirectory}),
        strategy:value.strategy,
        ...(value.pwa===undefined?{}:{pwa:normalizePwaConfig(value.pwa)}),
        ...(value.security===undefined?{}:{security:normalizeOptionalRecord(
            value.security,
            `${appId}/${APP_CONFIG_NAME}.security`
        )}),
        ...(value.localAIModelPolicy===undefined?{}:{localAIModelPolicy:normalizeOptionalRecord(
            value.localAIModelPolicy,
            `${appId}/${APP_CONFIG_NAME}.localAIModelPolicy`
        )}),
        include,
        exclude,
        shared:[...value.shared],
        ...(adapter===undefined?{}:{adapter}),
        configPath
    };
}

async function realDirectory(location,label){
    const requested=path.resolve(location);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} must be a real directory.`);
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical);
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()){
        fail(`${label} must be a real directory.`);
    }
    return canonical;
}

async function assertContainedRealPath(root,candidate,label){
    const absolute=path.resolve(candidate);
    const fromRoot=path.relative(path.resolve(root),absolute);
    if(fromRoot.startsWith('..')||path.isAbsolute(fromRoot))fail(`${label} leaves its allowed root.`);
    let current=path.resolve(root);
    for(const segment of fromRoot.split(path.sep).filter(Boolean)){
        current=path.join(current,segment);
        const info=await lstat(current);
        if(info.isSymbolicLink())fail(`${label} contains a symbolic link or junction.`);
    }
    const canonicalRoot=await realpath(root);
    const canonicalCandidate=await realpath(absolute);
    const canonicalRelative=path.relative(canonicalRoot,canonicalCandidate);
    if(canonicalRelative.startsWith('..')||path.isAbsolute(canonicalRelative)){
        fail(`${label} resolves outside its allowed root.`);
    }
}

async function loadContext(requestedWorkspaceRoot,appId,{outputDirectory}={}){
    const workspaceRoot=await realDirectory(normalizeWorkspaceRoot(requestedWorkspaceRoot),'Workspace root');
    const rootConfigPath=path.join(workspaceRoot,ROOT_CONFIG_NAME);
    const rootConfig=validateRootConfig(await readJson(rootConfigPath,ROOT_CONFIG_NAME),rootConfigPath);
    if(!is.string(appId)||!APP_ID_PATTERN.test(appId))fail(`Unsafe app id: ${String(appId)}`);
    const appsRoot=await realDirectory(path.join(workspaceRoot,rootConfig.appsRoot),'Apps root');
    const appRoot=resolveAppRoot(workspaceRoot,rootConfig,appId);
    await assertContainedRealPath(appsRoot,appRoot,appId);
    const configPath=path.join(appRoot,APP_CONFIG_NAME);
    const config=validateAppConfig(await readJson(configPath,`${appId}/${APP_CONFIG_NAME}`),appId,rootConfig,configPath);
    if(outputDirectory!==undefined){
        config.outputDirectory=normalizeRelativePath(outputDirectory,'package outputDirectory');
    }
    return {
        workspaceRoot,
        rootConfig,
        appsRoot,
        appRoot,
        appId,
        config,
        outputRoot:resolvePackageOutputRoot(workspaceRoot,rootConfig,config)
    };
}

async function assertPackageOutputLocation(context){
    const output=context.outputRoot.split(path.sep).join('/');
    const absolute=location=>path.resolve(location).split(path.sep).join('/');
    const controls=[
        context.appRoot,
        path.join(context.workspaceRoot,ROOT_CONFIG_NAME),
        path.join(context.appRoot,APP_CONFIG_NAME),
        path.join(context.appRoot,APP_DESCRIPTOR_NAME),
        ...(context.config.adapter?[path.join(context.appRoot,context.config.adapter)]:[])
    ];
    for(const control of controls){
        if(sameOrDescendant(absolute(control),output)){
            fail(`Package output would replace application source or configuration: ${control}.`);
        }
    }
    for(const name of ['.git','.arcane','.agents','.codex','node_modules']){
        const control=absolute(path.join(context.workspaceRoot,name));
        if(sameOrDescendant(output,control)||sameOrDescendant(control,output)){
            fail(`Package output overlaps the workspace control directory: ${name}.`);
        }
    }
    if(context.rootConfig.appsRoot!=='.'){
        const relative=path.relative(context.appsRoot,context.outputRoot);
        if(relative&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative)){
            const [otherAppId]=relative.split(path.sep);
            if(pathKey(otherAppId)!==pathKey(context.appId)){
                const otherAppRoot=path.join(context.appsRoot,otherAppId);
                for(const manifest of [APP_CONFIG_NAME,APP_DESCRIPTOR_NAME]){
                    try{await lstat(path.join(otherAppRoot,manifest));}
                    catch(error){if(error?.code==='ENOENT')continue;throw error;}
                    fail(`Package output overlaps another application's source directory: ${otherAppRoot}.`);
                }
            }
        }
    }
    function assertSelectedInput(sourceRoot,selected,excludes,label){
        if(isExcluded(selected,excludes))return;
        const source=absolute(path.resolve(sourceRoot,selected));
        const relativeOutput=path.relative(sourceRoot,context.outputRoot).split(path.sep).join('/');
        if(sameOrDescendant(source,output)
            ||(sameOrDescendant(output,source)&&!isExcluded(relativeOutput,excludes))){
            fail(`Package output overlaps selected ${label} content: ${selected}.`);
        }
    }
    for(const selected of context.config.include){
        assertSelectedInput(context.appRoot,selected,context.config.exclude,context.appId);
    }
    for(const sharedId of context.config.shared){
        for(const route of context.rootConfig.sharedPayloads[sharedId]){
            const sourceRoot=path.resolve(context.workspaceRoot,route.source);
            for(const selected of route.include){
                assertSelectedInput(sourceRoot,selected,route.exclude,`sharedPayloads.${sharedId}`);
            }
        }
    }
}

function destinationJoin(root,relative){
    return relative==='.'?root:root==='.'?relative:`${root}/${relative}`;
}

function appPackagePath(context, relative) {
    const root=appRelativeRoot(context.rootConfig,context.appId);
    return root?`${root}/${relative}`:relative;
}

function packageResourceUrl(relative) {
    const segments = relative.split('/');
    return `./${segments.map(encodeURIComponent).join('/')}`;
}

async function collectSelectedPath({
    sourceRoot,
    selected,
    destination,
    excludes,
    reject,
    records,
    destinations,
    signal,
    label,
    allowRoot=false
}){
    throwIfAborted(signal);
    if(isExcluded(selected,excludes))return;
    if(reject(selected))fail(`${label} selects a reserved private or generated path: ${selected}.`);
    const absolute=resolveInside(sourceRoot,selected,label,{allowRoot});
    let info;
    try{info=await lstat(absolute);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${selected}.`);
        throw error;
    }
    if(info.isSymbolicLink())fail(`${label} contains a symbolic link or junction: ${selected}.`);
    if(selected==='.'&&!info.isDirectory())fail(`${label} root selection must be a directory.`);
    if(info.isDirectory()){
        const entries=await readdir(absolute,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            const child=destinationJoin(selected,entry.name);
            await collectSelectedPath({
                sourceRoot,
                selected:child,
                destination:destinationJoin(destination,entry.name),
                excludes,
                reject,
                records,
                destinations,
                signal,
                label
            });
        }
        return;
    }
    if(!info.isFile())fail(`${label} contains a non-file entry: ${selected}.`);
    const normalizedDestination=normalizeRelativePath(destination,`${label} destination`);
    if(pathKey(normalizedDestination)===pathKey(RELEASE_MANIFEST_NAME)){
        fail(`${label} overlaps the generated release manifest.`);
    }
    const key=pathKey(normalizedDestination);
    if(destinations.has(key))fail(`Package destination collision: ${normalizedDestination}.`);
    destinations.add(key);
    records.push({source:absolute,destination:normalizedDestination});
}

async function collectPackageRecords(context,{signal}={}){
    await assertPackageOutputLocation(context);
    const records=[];
    const destinations=new Set();
    for(const selected of context.config.include){
        await collectSelectedPath({
            sourceRoot:context.appRoot,
            selected,
            destination:appPackagePath(context, selected),
            excludes:context.config.exclude,
            reject:isAppSourceForbidden,
            records,
            destinations,
            signal,
            label:context.appId
        });
    }
    // App ownership comes from its selected files, including in a root layout.
    for(const record of records){
        record.appRelativePath=path.relative(context.appRoot,record.source).split(path.sep).join('/');
    }
    for(const sharedId of context.config.shared){
        for(const route of context.rootConfig.sharedPayloads[sharedId]){
            const sourceRoot=resolveInside(context.workspaceRoot,route.source,`sharedPayloads.${sharedId}.source`);
            await assertContainedRealPath(context.workspaceRoot,sourceRoot,`sharedPayloads.${sharedId}.source`);
            for(const selected of route.include){
                await collectSelectedPath({
                    sourceRoot,
                    selected,
                    destination:destinationJoin(route.destination,selected),
                    excludes:route.exclude,
                    reject:isAlwaysForbidden,
                    records,
                    destinations,
                    signal,
                    label:`sharedPayloads.${sharedId}`,
                    allowRoot:true
                });
            }
        }
    }
    records.sort((left,right)=>compareText(left.destination,right.destination));
    if(!records.some(record=>pathKey(record.destination)===pathKey(appPackagePath(context, context.config.entry)))){
        fail(`Package entry is missing from the selected files: ${context.config.entry}.`);
    }
    return records;
}

async function browserDocuments(records,entry,selected){
    if(selected!==undefined){
        const appRecords=new Map(records.filter(function applicationRecord(record){
            return record.appRelativePath!==undefined;
        }).map(function applicationRecordPath(record){
            return [record.appRelativePath,record];
        }));
        const documentPaths=[entry,...[...new Set(selected)].filter(function secondaryDocument(document){
            return document!==entry;
        }).sort(compareText)];
        return Promise.all(documentPaths.map(async function inspectSelectedDocument(documentPath){
            const record=appRecords.get(documentPath);
            if(!record)fail(`Application document is missing from the selected files: ${documentPath}.`);
            const inspected=inspectImportMapHtml(await readFile(record.source,'utf8'),{documentPath});
            return {path:documentPath,packagePath:record.destination,...copyJson(inspected)};
        }));
    }
    let entryDocument=null;
    const documents=[];
    for(const record of records){
        if(record.appRelativePath===undefined)continue;
        const extension=path.posix.extname(record.destination).toLocaleLowerCase('en-US');
        if(extension!=='.html'&&extension!=='.htm')continue;
        const documentPath=record.appRelativePath;
        const inspected=inspectImportMapHtml(await readFile(record.source,'utf8'),{
            documentPath
        });
        const document={path:documentPath,packagePath:record.destination,...copyJson(inspected)};
        if(documentPath===entry){
            entryDocument=document;
        }else if(inspected.bases.length>0){
            documents.push(document);
        }
    }
    return entryDocument===null?documents:[entryDocument,...documents];
}

async function optionalDescriptor(context){
    const descriptorPath=path.join(context.appRoot,APP_DESCRIPTOR_NAME);
    try{
        const info=await lstat(descriptorPath);
        if(info.isSymbolicLink()||!info.isFile())fail(`${APP_DESCRIPTOR_NAME} must be a real file.`);
        return await readJson(descriptorPath,APP_DESCRIPTOR_NAME);
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
}

async function inspectContext(context,{signal,records}={}){
    const selectedRecords=records??await collectPackageRecords(context,{signal});
    const documents=await browserDocuments(selectedRecords,context.config.entry,context.config.documents);
    return {
        appId:context.appId,
        displayName:context.config.displayName,
        version:context.config.version,
        entry:context.config.entry,
        ...(context.config.documents===undefined?{}:{documents:[...context.config.documents]}),
        ...(context.config.outputDirectory===undefined?{}:{outputDirectory:context.config.outputDirectory}),
        strategy:context.config.strategy,
        ...(context.config.pwa===undefined?{}:{pwa:copyJson(context.config.pwa)}),
        include:[...context.config.include],
        exclude:[...context.config.exclude],
        shared:[...context.config.shared],
        ...(context.config.security===undefined?{}:{security:copyJson(context.config.security)}),
        ...(context.config.localAIModelPolicy===undefined?{}:{
            localAIModelPolicy:copyJson(context.config.localAIModelPolicy)
        }),
        ...(context.config.adapter===undefined?{}:{adapter:context.config.adapter}),
        descriptor:await optionalDescriptor(context),
        browserDocuments:documents,
        files:[...new Set(['index.html',...selectedRecords.map(record=>record.destination)])].sort(compareText),
        output:path.relative(context.workspaceRoot,context.outputRoot).split(path.sep).join('/')
    };
}

export async function discoverApps({workspaceRoot:requestedWorkspaceRoot}={}){
    const workspaceRoot=await realDirectory(normalizeWorkspaceRoot(requestedWorkspaceRoot),'Workspace root');
    const rootConfig=validateRootConfig(
        await readJson(path.join(workspaceRoot,ROOT_CONFIG_NAME),ROOT_CONFIG_NAME),
        path.join(workspaceRoot,ROOT_CONFIG_NAME)
    );
    if(rootConfig.appsRoot==='.'){
        const configPath=path.join(workspaceRoot,APP_CONFIG_NAME);
        const value=await readJson(configPath,APP_CONFIG_NAME);
        const config=validateAppConfig(value,value?.id,rootConfig,configPath);
        return [config.id];
    }
    const appsRoot=await realDirectory(path.join(workspaceRoot,rootConfig.appsRoot),'Apps root');
    const entries=await readdir(appsRoot,{withFileTypes:true});
    const apps=[];
    for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
        if(!entry.isDirectory()||!APP_ID_PATTERN.test(entry.name))continue;
        const configPath=path.join(appsRoot,entry.name,APP_CONFIG_NAME);
        try{
            const info=await lstat(configPath);
            if(!info.isSymbolicLink()&&info.isFile())apps.push(entry.name);
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
        }
    }
    return apps;
}

export async function inspectApp({workspaceRoot,appId,signal}={}){
    throwIfAborted(signal);
    const context=await loadContext(workspaceRoot,appId);
    return inspectContext(context,{signal});
}

async function copyRecords(records,stagingRoot,{signal,onEvent}={}){
    for(const record of records){
        throwIfAborted(signal);
        const destination=resolveInside(stagingRoot,record.destination,'package destination');
        await mkdir(path.dirname(destination),{recursive:true});
        await copyFile(record.source,destination);
        await emit(onEvent,{type:'package.file.copied',path:record.destination});
    }
}

async function writePackageLauncher(context, stagingRoot) {
    function escapeHtml(value) {
        return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
            .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    }
    const start = escapeHtml(packageResourceUrl(appPackagePath(context, context.config.entry)));
    const title = escapeHtml(context.config.displayName);
    const content = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta http-equiv="refresh" content="0; url=${start}">
    <title>${title}</title>
</head>
<body>
    <a href="${start}">Open ${title}</a>
</body>
</html>
`;
    await writeFile(path.join(stagingRoot, 'index.html'), content, 'utf8');
}

async function listOutputFiles(root,{signal}={}){
    const files=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink())fail(`Package output contains a symbolic link: ${relative}.`);
            if(info.isDirectory())await visit(absolute,relative);
            else if(info.isFile())files.push(relative);
            else fail(`Package output contains a non-file entry: ${relative}.`);
        }
    }
    await visit(root);
    return files.sort(compareText);
}

async function loadAdapter(context){
    if(context.config.strategy!=='adapter')return null;
    const adapterPath=resolveInside(context.appRoot,context.config.adapter,`${context.appId} adapter`);
    await assertContainedRealPath(context.appRoot,adapterPath,`${context.appId} adapter`);
    const module=await import(`${pathToFileURL(adapterPath).href}?source=${Date.now()}`);
    if(!is.function(module.buildArcanePackage)){
        fail(`${context.appId} adapter must export buildArcanePackage.`);
    }
    return module;
}

function releaseManifest(context,files,pwaArtifacts,rootDocument){
    return {
        schemaVersion:1,
        kind:'arcane-app-release',
        packagerVersion:PACKAGER_VERSION,
        app:{
            id:context.appId,
            displayName:context.config.displayName,
            version:context.config.version,
            entry:context.config.entry,
            start:packageResourceUrl(appPackagePath(context, context.config.entry)),
            ...(rootDocument ? {rootDocument} : {}),
            strategy:context.config.strategy,
            shared:[...context.config.shared],
            ...(pwaArtifacts?{pwa:{
                manifest:pwaArtifacts.entryAssets.manifest,
                offlineManifest:PWA_OFFLINE_MANIFEST_NAME,
                worker:PWA_WORKER_NAME,
                sdkVersion:pwaArtifacts.offlineManifest.sdkVersion,
                revision:pwaArtifacts.offlineManifest.revision
            }}:{}),
            ...(context.config.security===undefined?{}:{security:copyJson(context.config.security)}),
            ...(context.config.localAIModelPolicy===undefined?{}:{
                localAIModelPolicy:copyJson(context.config.localAIModelPolicy)
            })
        },
        files:[...files]
    };
}

async function replaceDirectory(stagingRoot,outputRoot){
    const backupRoot=`${outputRoot}.backup-${process.pid}-${Date.now()}`;
    let backedUp=false;
    try{
        const existing=await lstat(outputRoot);
        if(existing.isSymbolicLink()||!existing.isDirectory()){
            fail('Existing package output must be a real directory.');
        }
        await rename(outputRoot,backupRoot);
        backedUp=true;
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
    try{
        await rename(stagingRoot,outputRoot);
        if(backedUp)await rm(backupRoot,{recursive:true});
    }catch(error){
        if(backedUp)await rename(backupRoot,outputRoot).catch(()=>{});
        throw error;
    }
}

async function packageWithContext(context,options={}){
    const {signal,onEvent,browserPwa=true,moduleFormat='import-map'}=options;
    if(!['import-map','native'].includes(moduleFormat)){
        throw new TypeError('packageApp moduleFormat must be "import-map" or "native".');
    }
    const pwaEnabled=browserPwa&&context.config.pwa?.enabled===true;
    const appPath=appRelativeRoot(context.rootConfig,context.appId);
    const entryPath=appPackagePath(context,context.config.entry);
    const records=await collectPackageRecords(context,{signal});
    const rootDocument = records.some(
        function selectedRootIndex(record) {
            return record.destination === 'index.html';
        }
    ) ? './index.html' : undefined;
    const inspected=await inspectContext(context,{signal,records});
    if(options.dryRun){
        return {
            appId:context.appId,
            version:context.config.version,
            output:inspected.output,
            dryRun:true,
            files:[
                ...inspected.files,
                ...(pwaEnabled?[
                    PWA_MANIFEST_NAME,
                    PWA_OFFLINE_MANIFEST_NAME,
                    PWA_WORKER_NAME,
                    PWA_BOOTSTRAP_NAME
                ]:[])
            ].sort(compareText)
        };
    }
    // Directory replacement must stay on the requested physical path before
    // mkdir or rename can affect an existing source tree through an ancestor.
    let current=context.workspaceRoot;
    for(const segment of path.relative(context.workspaceRoot,context.outputRoot).split(path.sep)){
        current=path.join(current,segment);
        let info;
        try{info=await lstat(current);}
        catch(error){if(error?.code==='ENOENT')break;throw error;}
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail(`Package output must use real directories: ${current}.`);
        }
    }
    const outputParent=path.dirname(context.outputRoot);
    await mkdir(outputParent,{recursive:true});
    const parentInfo=await lstat(outputParent);
    if(parentInfo.isSymbolicLink()||!parentInfo.isDirectory())fail('Package output parent must be a real directory.');
    const stagingRoot=path.join(
        outputParent,
        `.${context.appId}-staging-${process.pid}-${Date.now()}`
    );
    await mkdir(stagingRoot);
    let promoted=false;
    try{
        async function copyBase() {
            await copyRecords(records,stagingRoot,{signal,onEvent});
            if (!rootDocument) {
                await writePackageLauncher(context, stagingRoot);
            }
        }
        const adapter=await loadAdapter(context);
        if(adapter){
            await adapter.buildArcanePackage({
                appId:context.appId,
                workspaceRoot:context.workspaceRoot,
                appRoot:context.appRoot,
                outputRoot:stagingRoot,
                copyBase,
                signal,
                onEvent
            });
        }else{
            await copyBase();
        }
        let files=await listOutputFiles(stagingRoot,{signal});
        const entryUrl=new URL(packageResourceUrl(entryPath),'http://arcane.invalid/');
        const selectedFiles=new Set(files);
        const explicitDocumentPaths=context.config.documents===undefined?null:new Set(
            inspected.browserDocuments.map(function selectedDocumentPath(document){return document.packagePath;})
        );
        const pwaDocumentPaths=new Set(explicitDocumentPaths??[entryPath]);
        for(const selected of explicitDocumentPaths===null?context.config.include:[]){
            const selectedPath=appPackagePath(context,selected);
            if(/\.html?$/iu.test(selected)&&selectedFiles.has(selectedPath))pwaDocumentPaths.add(selectedPath);
        }
        for(const document of inspected.browserDocuments){
            const appDocument=context.config.include.some(function includesAppDocument(selected){
                return sameOrDescendant(document.path,selected);
            });
            if(appDocument&&(appPath===''||document.managedMaps.length>0)&&selectedFiles.has(document.packagePath)){
                pwaDocumentPaths.add(document.packagePath);
            }
        }
        if (!pwaEnabled) {
            // Remove source-generated registration before native processing can follow it.
            const removals = await Promise.allSettled(
                [...pwaDocumentPaths].map(
                    async function removeStagedPwaReferences(documentPath) {
                        throwIfAborted(signal);
                        const filePath = path.join(stagingRoot, ...documentPath.split('/'));
                        const source = await readFile(filePath, 'utf8');
                        const content = removePwaEntryReferences(
                            source,
                            {
                                documentUrl: new URL(packageResourceUrl(documentPath), entryUrl.origin),
                                manifestUrl: new URL(`/${PWA_MANIFEST_NAME}`, entryUrl.origin)
                            }
                        );
                        if (content !== source) await writeFile(filePath, content, 'utf8');
                    }
                )
            );
            // Settle every stage write before a failure can trigger stage cleanup.
            const errors = [];
            for (const removal of removals) {
                if (removal.status === 'rejected') errors.push(removal.reason);
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) throw new AggregateError(errors, 'Selected PWA reference removal failed.');
        }
        if(moduleFormat==='native'){
            files=await materializeNativeModules({
                stagingRoot,
                files,
                documents:inspected.browserDocuments.map(function documentPath(document){return document.packagePath;}),
                sharedFiles:records.filter(function sharedRecord(record){return record.appRelativePath===undefined;})
                    .map(function sharedPath(record){return record.destination;}),
                signal,
                onEvent
            });
        }
        // Traverse actual browser resources after the adapter finishes. Files
        // included only as application documents retain their original content.
        const assetVersion=await readWorkspaceAssetVersion(context.workspaceRoot);
        const inventory=new Set(files);
        const offlineInventory=pwaEnabled?new Set(selectPwaFiles(files,context.config.pwa,appPath)):null;
        const offlineReferences=new Set();
        const pwaDocumentSources=new Map();
        if(pwaEnabled){
            await Promise.all(
                [...pwaDocumentPaths].map(
                    async function readPwaDocument(documentPath) {
                        const source = await readFile(
                            path.join(stagingRoot, ...documentPath.split('/')),
                            'utf8'
                        );
                        pwaDocumentSources.set(
                            documentPath,
                            {source, inspected: inspectImportMapHtml(source)}
                        );
                    }
                )
            );
        }
        const entryDocument=pwaEnabled?pwaDocumentSources.get(entryPath).inspected
            :inspected.browserDocuments.find(function matchingEntryDocument(document){
                return document.path===context.config.entry;
            });
        const documentUrl=entryDocument?.bases[0]?.href
            ?new URL(entryDocument.bases[0].href,entryUrl):entryUrl;
        const pending=[{file:entryPath,documentUrl}];
        const sharedFiles=new Set(records.filter(record=>record.appRelativePath===undefined).map(record=>record.destination));
        const applicationFiles=new Set(records.filter(function applicationRecord(record){
            return record.appRelativePath!==undefined;
        }).map(function applicationDestination(record){return record.destination;}));
        for(const file of files){
            if((sharedFiles.has(file)||/^arcane\/(?:modules|entities|components|css|sdk|dependencies)\//u.test(file))
                &&/\.(?:m?js|html?|css)$/iu.test(file))pending.push({file,documentUrl});
            if(path.posix.basename(file)==='arcane.importmap.json'){
                pending.push({file,documentUrl});
            }
        }
        for(const document of inspected.browserDocuments){
            if(document.managedMaps.length>0&&!pwaDocumentSources.has(document.packagePath)){
                const url=new URL(packageResourceUrl(document.packagePath),entryUrl.origin);
                pending.push({file:document.packagePath,documentUrl:document.bases[0]?.href
                    ?new URL(document.bases[0].href,url):url});
            }
        }
        for(const [file,document] of pwaDocumentSources){
            if(file===entryPath)continue;
            const url=new URL(packageResourceUrl(file),entryUrl.origin);
            pending.push({file,documentUrl:document.inspected.bases[0]?.href
                ?new URL(document.inspected.bases[0].href,url):url});
        }
        const visited=new Set();
        const resources=new Map();
        for(const current of pending){
            const relative=current.file;
            throwIfAborted(signal);
            const contextKey=`${relative}\n${current.documentUrl.href}`;
            if(visited.has(contextKey)||!inventory.has(relative)
                ||(!/\.(?:m?js|html?|css)$/iu.test(relative)
                    &&path.posix.basename(relative)!=='arcane.importmap.json'))continue;
            visited.add(contextKey);
            const filePath=path.join(stagingRoot,...relative.split('/'));
            let resource=resources.get(relative);
            if(!resource){
                const original=pwaDocumentSources.get(relative)?.source??await readFile(filePath,'utf8');
                const references=[];
                const content=rewriteAssetReferences(original,{
                    filePath:relative,version:null,onReference:reference=>references.push(reference)
                });
                if(content!==original)await writeFile(filePath,content,'utf8');
                resource={references,...(pwaDocumentSources.has(relative)?{content}:{})};
                resources.set(relative,resource);
            }
            for(const reference of resource.references){
                const {url,kind,baseHref}=reference;
                const traversable=kind!=='fetch'&&(kind!=='asset'||/\.css(?:[?#]|$)/iu.test(url))
                    &&(kind!=='import'||/^(?:\.{1,2}\/|\/)/u.test(url));
                if(!pwaEnabled&&!traversable)continue;
                if(kind==='import'&&!/^(?:\.{1,2}\/|\/)/u.test(url))continue;
                try{
                    const ownerUrl=new URL(packageResourceUrl(relative),entryUrl.origin);
                    const target=resolveAssetReference(reference,{
                        ownerUrl,
                        documentUrl:current.documentUrl,
                        managedMap:path.posix.basename(relative)==='arcane.importmap.json'
                    });
                    if(target.origin===entryUrl.origin){
                        const file=decodeURIComponent(target.pathname).replace(/^\//u,'');
                        if(pwaEnabled&&offlineInventory.has(file)){
                            offlineReferences.add(versionAssetUrl(`.${target.pathname}${target.search}`,null));
                        }
                        const selectedDocument=kind!=='document'||!applicationFiles.has(file)||explicitDocumentPaths===null
                            ||explicitDocumentPaths.has(file);
                        if(traversable&&selectedDocument)pending.push({
                            file,
                            documentUrl:kind==='document'?target
                                :baseHref?new URL(baseHref,ownerUrl):current.documentUrl
                        });
                    }
                }catch{ /* Non-URL values remain under their existing owner. */ }
            }
        }
        if(files.some(file=>pathKey(file)===pathKey(RELEASE_MANIFEST_NAME))){
            fail(`Package content must not author ${RELEASE_MANIFEST_NAME}.`);
        }
        if(!files.some(file=>pathKey(file)===pathKey(entryPath))){
            fail(`Package output is missing its entry file: ${context.config.entry}.`);
        }
        const installed=pwaEnabled?await readInstalledSdkLayout(context.workspaceRoot,context.rootConfig):null;
        const pwaArtifacts=pwaEnabled?createPwaArtifacts({
            app:{
                id:context.appId,
                displayName:context.config.displayName,
                version:context.config.version,
                entry:packageResourceUrl(entryPath)
            },
            appPath,
            ...(installed?.direct?{runtimeBase:`.${installed.browserRuntimeBase}`} : {}),
            sdkVersion:assetVersion,
            pwa:context.config.pwa,
            files,
            navigationAliases: rootDocument ? {} : {'./': packageResourceUrl(entryPath)},
            assets:[...offlineReferences]
        }):null;
        if(pwaArtifacts){
            for(const artifact of pwaArtifacts.files){
                if(inventory.has(artifact.path)){
                    fail(`Package content overlaps generated PWA file: ${artifact.path}.`);
                }
                const artifactPath=path.join(stagingRoot,...artifact.path.split('/'));
                await mkdir(path.dirname(artifactPath),{recursive:true});
                await writeFile(artifactPath,artifact.content,'utf8');
                files.push(artifact.path);
            }
            for(const [documentPath,document] of pwaDocumentSources){
                const documentUrl=new URL(packageResourceUrl(documentPath),entryUrl.origin);
                const outputBase=document.inspected.bases[0]?.href
                    ?new URL(document.inspected.bases[0].href,documentUrl):documentUrl;
                const outputDirectory=new URL('./',outputBase).pathname;
                function entryReference(relative){
                    const target=path.posix.relative(outputDirectory,`/${relative}`);
                    return target.startsWith('.')?target:`./${target}`;
                }
                const content=resources.get(documentPath)?.content??document.source;
                await writeFile(path.join(stagingRoot,...documentPath.split('/')),
                    applyPwaEntryReferences(content,{
                        manifestUrl:entryReference(pwaArtifacts.entryAssets.manifest),
                        bootstrapUrl:entryReference(pwaArtifacts.entryAssets.bootstrap)
                    }),'utf8');
            }
            files.sort(compareText);
        }
        const manifest=releaseManifest(context,files,pwaArtifacts,rootDocument);
        await writeFile(
            path.join(stagingRoot,RELEASE_MANIFEST_NAME),
            `${JSON.stringify(manifest,null,2)}\n`,
            'utf8'
        );
        throwIfAborted(signal);
        await replaceDirectory(stagingRoot,context.outputRoot);
        promoted=true;
        await emit(onEvent,{
            type:'package.completed',
            appId:context.appId,
            outputRoot:context.outputRoot,
            files:[...files]
        });
        return {
            appId:context.appId,
            version:context.config.version,
            output:path.relative(context.workspaceRoot,context.outputRoot).split(path.sep).join('/'),
            outputRoot:context.outputRoot,
            manifest,
            files:[...files]
        };
    }finally{
        if(!promoted)await rm(stagingRoot,{recursive:true,force:true}).catch(()=>{});
    }
}

export async function packageApp(options={}){
    const context=await loadContext(options.workspaceRoot,options.appId,options);
    const execute=()=>packageWithContext(context,options);
    if(options.workspaceOperationLease)return execute();
    return withWorkspaceOperationLock({
        workspaceRoot:context.workspaceRoot,
        operation:'package',
        signal:options.signal,
        onEvent:options.onEvent
    },execute);
}

export async function verifyApp({workspaceRoot,appId,outputDirectory,signal,onEvent}={}){
    throwIfAborted(signal);
    const context=await loadContext(workspaceRoot,appId,{outputDirectory});
    const outputRoot=await realDirectory(context.outputRoot,'Package output');
    const manifest=await readJson(path.join(outputRoot,RELEASE_MANIFEST_NAME),RELEASE_MANIFEST_NAME);
    if(!isPlainObject(manifest)||manifest.schemaVersion!==1||manifest.kind!=='arcane-app-release'
        ||manifest.packagerVersion!==PACKAGER_VERSION||manifest.app?.id!==appId
        ||manifest.app?.version!==context.config.version||!is.array(manifest.files)){
        fail(`${RELEASE_MANIFEST_NAME} is malformed.`);
    }
    const expected=manifest.files.map((file,index)=>normalizeRelativePath(
        file,
        `${RELEASE_MANIFEST_NAME}.files[${index}]`
    )).sort(compareText);
    if(new Set(expected.map(pathKey)).size!==expected.length){
        fail(`${RELEASE_MANIFEST_NAME} contains duplicate files.`);
    }
    const actual=(await listOutputFiles(outputRoot,{signal}))
        .filter(file=>pathKey(file)!==pathKey(RELEASE_MANIFEST_NAME));
    if(JSON.stringify(actual)!==JSON.stringify(expected)){
        fail('Packaged file inventory differs from its release manifest.');
    }
    await emit(onEvent,{type:'package.inspected',appId,outputRoot,files:[...actual]});
    return {
        verified:true,
        appId,
        version:context.config.version,
        outputRoot,
        manifest:copyJson(manifest),
        files:[...actual]
    };
}

export async function bumpVersion({workspaceRoot,appId,bump='patch',preid,signal,onEvent}={}){
    throwIfAborted(signal);
    const context=await loadContext(workspaceRoot,appId);
    const nextVersion=incrementSemver(context.config.version,bump,preid);
    const configDocument=await readJson(context.config.configPath,`${appId}/${APP_CONFIG_NAME}`);
    configDocument.version=nextVersion;
    const descriptorPath=path.join(context.appRoot,APP_DESCRIPTOR_NAME);
    let descriptor=null;
    try{
        descriptor=await readJson(descriptorPath,APP_DESCRIPTOR_NAME);
        descriptor.version=nextVersion;
    }catch(error){
        if(error?.code!=='ARCANE_PACKAGE_INVALID'||!String(error.message).includes('does not exist'))throw error;
    }
    await writeFile(context.config.configPath,`${JSON.stringify(configDocument,null,2)}\n`,'utf8');
    if(descriptor)await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`,'utf8');
    await emit(onEvent,{type:'package.version.updated',appId,version:nextVersion});
    return {appId,previousVersion:context.config.version,version:nextVersion};
}
