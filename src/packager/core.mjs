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
import {withWorkspaceOperationLock} from '../workspace-operation-lock.mjs';
import {inspectImportMapHtml} from '../import-map.mjs';

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
    if(typeof onEvent==='function')await onEvent(event);
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

function isPlainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
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
    if(typeof workspaceRoot!=='string'||!workspaceRoot.trim()){
        fail('workspaceRoot must be a directory path.');
    }
    return path.resolve(workspaceRoot);
}

export function normalizeRelativePath(value,label='path'){
    if(typeof value!=='string'||!value||value.includes('\\')||TEXT_CONTROL_PATTERN.test(value)){
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

function validatePathList(value,label,{required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)){
        fail(`${label} must be ${required?'a non-empty':'an'} array of literal relative paths.`);
    }
    const normalized=value.map((entry,index)=>{
        const item=normalizeRelativePath(entry,`${label}[${index}]`);
        if(isGlobLike(item))fail(`${label}[${index}] must be literal; directories include descendants.`);
        return item;
    });
    if(new Set(normalized.map(pathKey)).size!==normalized.length){
        fail(`${label} contains duplicate paths.`);
    }
    if(required){
        for(let left=0;left<normalized.length;left+=1){
            for(let right=left+1;right<normalized.length;right+=1){
                if(sameOrDescendant(normalized[left],normalized[right])
                    ||sameOrDescendant(normalized[right],normalized[left])){
                    fail(`${label} has overlapping paths: ${normalized[left]} and ${normalized[right]}`);
                }
            }
        }
    }
    return normalized;
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
    if(typeof value!=='string'||!value.trim()){
        fail(`${label} must be nonempty text.`);
    }
    return value;
}

export function parseSemver(value){
    if(typeof value!=='string')fail(`Invalid semantic version: ${String(value)}`);
    const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
    if(!match)fail(`Invalid semantic version: ${value}`);
    const prerelease=match[4]?match[4].split('.'):[];
    for(const identifier of prerelease){
        if(/^\d+$/u.test(identifier)&&identifier.length>1&&identifier.startsWith('0')){
            fail(`Invalid semantic version: ${value}`);
        }
    }
    const numbers=match.slice(1,4).map(Number);
    if(numbers.some(number=>!Number.isSafeInteger(number))){
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
    if(typeof preid!=='string'||!/^[0-9A-Za-z-]+$/u.test(preid)){
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
    const include=validatePathList(route.include,`${label}.include`,{required:true});
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
    if(value.appsRoot!=='apps'||value.distRoot!=='dist'){
        fail(`${ROOT_CONFIG_NAME} must bind appsRoot to "apps" and distRoot to "dist".`);
    }
    if(!isPlainObject(value.sharedPayloads)){
        fail(`${ROOT_CONFIG_NAME}.sharedPayloads must be an object.`);
    }
    const sharedPayloads={};
    for(const [id,routes] of Object.entries(value.sharedPayloads).sort(([left],[right])=>compareText(left,right))){
        if(!SAFE_SHARED_ID_PATTERN.test(id))fail(`Unsafe shared payload id: ${id}`);
        if(!Array.isArray(routes)||routes.length===0){
            fail(`sharedPayloads.${id} must be a non-empty array.`);
        }
        sharedPayloads[id]=routes.map((route,index)=>
            validateSharedRoute(route,`sharedPayloads.${id}[${index}]`)
        );
    }
    return {schemaVersion:1,appsRoot:'apps',distRoot:'dist',sharedPayloads,configPath};
}

function normalizeOptionalRecord(value,label){
    if(value===undefined)return undefined;
    if(!isPlainObject(value))fail(`${label} must be an object.`);
    return copyJson(value);
}

export function validateAppConfig(value,appId,rootConfig,configPath=`apps/${appId}/${APP_CONFIG_NAME}`){
    assertOnlyKeys(value,new Set([
        'schemaVersion','id','displayName','version','entry','strategy','security',
        'localAIModelPolicy','include','exclude','shared','adapter'
    ]),`${appId}/${APP_CONFIG_NAME}`);
    if(value.schemaVersion!==1)fail(`${appId}/${APP_CONFIG_NAME}.schemaVersion must be 1.`);
    if(value.id!==appId||!APP_ID_PATTERN.test(value.id)){
        fail(`${appId}/${APP_CONFIG_NAME}.id must exactly match its apps directory.`);
    }
    const displayName=assertPresentationText(value.displayName,`${appId}/${APP_CONFIG_NAME}.displayName`);
    parseSemver(value.version);
    const entry=normalizeRelativePath(value.entry,`${appId}/${APP_CONFIG_NAME}.entry`);
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
    if(!Array.isArray(value.shared)||new Set(value.shared).size!==value.shared.length){
        fail(`${appId}/${APP_CONFIG_NAME}.shared must be an array of unique shared payload ids.`);
    }
    for(const [index,id] of value.shared.entries()){
        if(typeof id!=='string'||!Object.hasOwn(rootConfig.sharedPayloads,id)){
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
        strategy:value.strategy,
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

async function loadContext(requestedWorkspaceRoot,appId){
    const workspaceRoot=await realDirectory(normalizeWorkspaceRoot(requestedWorkspaceRoot),'Workspace root');
    const rootConfigPath=path.join(workspaceRoot,ROOT_CONFIG_NAME);
    const rootConfig=validateRootConfig(await readJson(rootConfigPath,ROOT_CONFIG_NAME),rootConfigPath);
    if(typeof appId!=='string'||!APP_ID_PATTERN.test(appId))fail(`Unsafe app id: ${String(appId)}`);
    const appsRoot=await realDirectory(path.join(workspaceRoot,rootConfig.appsRoot),'Apps root');
    const appRoot=resolveInside(appsRoot,appId,'app id');
    await assertContainedRealPath(appsRoot,appRoot,`apps/${appId}`);
    const configPath=path.join(appRoot,APP_CONFIG_NAME);
    const config=validateAppConfig(await readJson(configPath,`${appId}/${APP_CONFIG_NAME}`),appId,rootConfig,configPath);
    return {
        workspaceRoot,
        rootConfig,
        appsRoot,
        appRoot,
        appId,
        config,
        distRoot:path.join(workspaceRoot,rootConfig.distRoot),
        outputRoot:path.join(workspaceRoot,rootConfig.distRoot,appId)
    };
}

function destinationJoin(root,relative){
    return root==='.'?relative:`${root}/${relative}`;
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
    label
}){
    throwIfAborted(signal);
    if(isExcluded(selected,excludes))return;
    if(reject(selected))fail(`${label} selects a reserved private or generated path: ${selected}.`);
    const absolute=resolveInside(sourceRoot,selected,label);
    let info;
    try{info=await lstat(absolute);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${selected}.`);
        throw error;
    }
    if(info.isSymbolicLink())fail(`${label} contains a symbolic link or junction: ${selected}.`);
    if(info.isDirectory()){
        const entries=await readdir(absolute,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            const child=`${selected}/${entry.name}`;
            await collectSelectedPath({
                sourceRoot,
                selected:child,
                destination:`${destination}/${entry.name}`,
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
    const records=[];
    const destinations=new Set();
    for(const selected of context.config.include){
        await collectSelectedPath({
            sourceRoot:context.appRoot,
            selected,
            destination:selected,
            excludes:context.config.exclude,
            reject:isAppSourceForbidden,
            records,
            destinations,
            signal,
            label:`apps/${context.appId}`
        });
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
                    label:`sharedPayloads.${sharedId}`
                });
            }
        }
    }
    records.sort((left,right)=>compareText(left.destination,right.destination));
    if(!records.some(record=>pathKey(record.destination)===pathKey(context.config.entry))){
        fail(`Package entry is missing from the selected files: ${context.config.entry}.`);
    }
    return records;
}

async function browserDocuments(records,entry){
    let entryDocument=null;
    const documents=[];
    for(const record of records){
        const extension=path.posix.extname(record.destination).toLocaleLowerCase('en-US');
        if(extension!=='.html'&&extension!=='.htm')continue;
        const inspected=inspectImportMapHtml(await readFile(record.source,'utf8'),{
            documentPath:record.destination
        });
        const document={path:record.destination,...copyJson(inspected)};
        if(record.destination===entry){
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

async function inspectContext(context,{signal}={}){
    const records=await collectPackageRecords(context,{signal});
    return {
        appId:context.appId,
        displayName:context.config.displayName,
        version:context.config.version,
        entry:context.config.entry,
        strategy:context.config.strategy,
        include:[...context.config.include],
        exclude:[...context.config.exclude],
        shared:[...context.config.shared],
        ...(context.config.security===undefined?{}:{security:copyJson(context.config.security)}),
        ...(context.config.localAIModelPolicy===undefined?{}:{
            localAIModelPolicy:copyJson(context.config.localAIModelPolicy)
        }),
        ...(context.config.adapter===undefined?{}:{adapter:context.config.adapter}),
        descriptor:await optionalDescriptor(context),
        browserDocuments:await browserDocuments(records,context.config.entry),
        files:records.map(record=>record.destination),
        output:path.relative(context.workspaceRoot,context.outputRoot).split(path.sep).join('/')
    };
}

export async function discoverApps({workspaceRoot:requestedWorkspaceRoot}={}){
    const workspaceRoot=await realDirectory(normalizeWorkspaceRoot(requestedWorkspaceRoot),'Workspace root');
    const rootConfig=validateRootConfig(
        await readJson(path.join(workspaceRoot,ROOT_CONFIG_NAME),ROOT_CONFIG_NAME),
        path.join(workspaceRoot,ROOT_CONFIG_NAME)
    );
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
    if(typeof module.buildArcanePackage!=='function'){
        fail(`${context.appId} adapter must export buildArcanePackage.`);
    }
    return module;
}

function releaseManifest(context,files){
    return {
        schemaVersion:1,
        kind:'arcane-app-release',
        packagerVersion:PACKAGER_VERSION,
        app:{
            id:context.appId,
            displayName:context.config.displayName,
            version:context.config.version,
            entry:context.config.entry,
            strategy:context.config.strategy,
            shared:[...context.config.shared],
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
    const {signal,onEvent}=options;
    const inspected=await inspectContext(context,{signal});
    if(options.dryRun){
        return {
            appId:context.appId,
            version:context.config.version,
            output:inspected.output,
            dryRun:true,
            files:[...inspected.files]
        };
    }
    await mkdir(context.distRoot,{recursive:true});
    const distInfo=await lstat(context.distRoot);
    if(distInfo.isSymbolicLink()||!distInfo.isDirectory())fail('dist must be a real directory.');
    const stagingRoot=path.join(
        context.distRoot,
        `.${context.appId}-staging-${process.pid}-${Date.now()}`
    );
    await mkdir(stagingRoot);
    let promoted=false;
    try{
        const records=await collectPackageRecords(context,{signal});
        const copyBase=()=>copyRecords(records,stagingRoot,{signal,onEvent});
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
        const files=await listOutputFiles(stagingRoot,{signal});
        if(files.some(file=>pathKey(file)===pathKey(RELEASE_MANIFEST_NAME))){
            fail(`Package content must not author ${RELEASE_MANIFEST_NAME}.`);
        }
        if(!files.some(file=>pathKey(file)===pathKey(context.config.entry))){
            fail(`Package output is missing its entry file: ${context.config.entry}.`);
        }
        const manifest=releaseManifest(context,files);
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
    const context=await loadContext(options.workspaceRoot,options.appId);
    const execute=()=>packageWithContext(context,options);
    if(options.workspaceOperationLease)return execute();
    return withWorkspaceOperationLock({
        workspaceRoot:context.workspaceRoot,
        operation:'package',
        signal:options.signal,
        onEvent:options.onEvent
    },execute);
}

export async function verifyApp({workspaceRoot,appId,signal,onEvent}={}){
    throwIfAborted(signal);
    const context=await loadContext(workspaceRoot,appId);
    const outputRoot=await realDirectory(context.outputRoot,`dist/${appId}`);
    const manifest=await readJson(path.join(outputRoot,RELEASE_MANIFEST_NAME),RELEASE_MANIFEST_NAME);
    if(!isPlainObject(manifest)||manifest.schemaVersion!==1||manifest.kind!=='arcane-app-release'
        ||manifest.packagerVersion!==PACKAGER_VERSION||manifest.app?.id!==appId
        ||manifest.app?.version!==context.config.version||!Array.isArray(manifest.files)){
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
