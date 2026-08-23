import {createHash,randomBytes} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    stat,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {isDeepStrictEqual} from 'node:util';

export const ROOT_CONFIG_NAME='arcane-packager.json';
export const APP_CONFIG_NAME='arcane-package.json';
export const RELEASE_MANIFEST_NAME='ARCANE_APP_RELEASE.json';
export const PACKAGER_VERSION='arcane-app-packager-v1';

const RENAME_RETRY_CODES=new Set(['EACCES','EBUSY','EPERM']);
const RENAME_RETRY_LIMIT=20;
const RENAME_RETRY_DELAY_MS=250;
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const MAX_VERIFIED_APP_FILE_BYTES=64*1024*1024;
const MAX_SHARED_SNAPSHOT_FILE_COUNT=10000;
const MAX_SHARED_SNAPSHOT_FILE_BYTES=64*1024*1024;
const MAX_SHARED_SNAPSHOT_TOTAL_BYTES=64*1024*1024;
const APP_DESCRIPTOR_NAME='arcane-app.json';
const LEGACY_APP_REGISTRY_PATH=path.join(
    'machine_bundles',
    'arcane-os-machine-bundle',
    'arcane-apps.json'
);
const issuedAppReleaseReceipts=new WeakMap();
const issuedSharedPayloadSnapshots=new WeakMap();
let appDescriptorContractsPromise;

function fileIdentity(info){
    return Object.freeze({
        device:String(info.dev),
        inode:String(info.ino),
        bytes:Number(info.size),
        modifiedNanoseconds:String(info.mtimeNs),
        changedNanoseconds:String(info.ctimeNs),
        links:String(info.nlink)
    });
}

function identityMatches(info,identity){
    return String(info.dev)===identity.device
        &&String(info.ino)===identity.inode
        &&Number(info.size)===identity.bytes
        &&String(info.mtimeNs)===identity.modifiedNanoseconds
        &&String(info.ctimeNs)===identity.changedNanoseconds
        &&String(info.nlink)===identity.links;
}

async function openStableRegularFile(filePath,label,expectedIdentity){
    const before=await lstat(filePath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()){
        fail(`${label} must be a regular file, not a link or special entry.`);
    }
    if(expectedIdentity&&!identityMatches(before,expectedIdentity)){
        fail(`${label} changed after its package inventory was selected.`);
    }

    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')fail(`${label} became a symbolic link.`);
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!identityMatches(opened,fileIdentity(before))){
            fail(`${label} changed while it was being opened.`);
        }
        return {handle,identity:fileIdentity(opened)};
    }catch(error){
        await handle.close().catch(()=>{});
        throw error;
    }
}

async function readStableBytes(filePath,label,expectedIdentity){
    const opened=await openStableRegularFile(filePath,label,expectedIdentity);
    try{
        const bytes=await opened.handle.readFile();
        const after=await opened.handle.stat({bigint:true});
        if(!identityMatches(after,opened.identity)){
            fail(`${label} changed while it was being read.`);
        }
        return {bytes,identity:opened.identity};
    }finally{
        await opened.handle.close();
    }
}

async function renamePackageDirectory(source,destination){
    for(let attempt=0;;attempt++){
        try{
            await rename(source,destination);
            return;
        }catch(error){
            if(!RENAME_RETRY_CODES.has(error?.code)||attempt>=RENAME_RETRY_LIMIT){
                throw error;
            }

            await delay(RENAME_RETRY_DELAY_MS);
        }
    }
}

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SAFE_SHARED_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_NAME=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const FORBIDDEN_SEGMENTS=new Set([
    '.agents',
    '.codex',
    '.git',
    'dist',
    'local'
]);
const TEXT_CONTROL_PATTERN=/[\x00-\x1f\x7f]/;
const OLLAMA_MODEL_IDENTIFIER=
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const MODEL_DEFINITION_PATTERN=/^(?:Modelfile|[A-Za-z0-9][A-Za-z0-9._-]{0,118}\.Modelfile)$/;
const MAX_LOCAL_AI_MODELS=64;
const MAX_MODEL_DEFINITION_BYTES=512*1024;

function fail(message,code){
    const error=new Error(message);
    if(code)error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted){
        return;
    }

    const error=signal.reason instanceof Error
        ?signal.reason
        :new Error('Arcane package operation cancelled.');
    if(!error.code){
        error.code='ARCANE_CANCELLED';
    }
    throw error;
}

async function emitOperation(onEvent,event){
    if(typeof onEvent==='function'){
        await onEvent(event);
    }
}

function isPlainObject(value){
    return value!==null
        &&typeof value==='object'
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function immutableJsonCopy(value){
    if(Array.isArray(value)){
        return Object.freeze(value.map(item=>immutableJsonCopy(item)));
    }
    if(isPlainObject(value)){
        return Object.freeze(Object.fromEntries(
            Object.entries(value).map(([key,item])=>[key,immutableJsonCopy(item)])
        ));
    }
    return value;
}

function compareText(left,right){
    return String(left).localeCompare(String(right),'en');
}

function assertOnlyKeys(value,allowed,label){
    if(!isPlainObject(value)){
        fail(`${label} must be a JSON object.`);
    }

    for(const key of Object.keys(value)){
        if(!allowed.has(key)){
            fail(`${label} has an unsupported key: ${key}`);
        }
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

    if(path.posix.isAbsolute(value)||/^[a-z]:/i.test(value)){
        fail(`Unsafe ${label}: ${value}`);
    }

    const segments=value.split('/');

    for(const segment of segments){
        if(!segment||segment==='.'||segment==='..'||segment.includes(':')
            ||segment.endsWith('.')||segment.endsWith(' ')
            ||WINDOWS_RESERVED_NAME.test(segment)){
            fail(`Unsafe ${label}: ${value}`);
        }
    }

    return segments.join('/');
}

function normalizeRelativeRoot(value,label){
    if(value==='.'){
        return '.';
    }

    return normalizeRelativePath(value,label);
}

function isInside(root,candidate,{allowEqual=false}={}){
    const relative=path.relative(path.resolve(root),path.resolve(candidate));
    return (allowEqual&&relative==='')
        ||Boolean(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
}

function resolveInside(root,relative,label,{allowRoot=false}={}){
    const normalized=relative==='.'&&allowRoot
        ?'.'
        :normalizeRelativePath(relative,label);
    const candidate=path.resolve(root,...(normalized==='.'?[]:normalized.split('/')));

    if(!isInside(root,candidate,{allowEqual:allowRoot})){
        fail(`${label} leaves its allowed root: ${relative}`);
    }

    return candidate;
}

function pathKey(relative){
    return relative.toLocaleLowerCase('en-US');
}

function pathIsSameOrDescendant(candidate,parent){
    const candidateKey=pathKey(candidate);
    const parentKey=pathKey(parent);
    return candidateKey===parentKey||candidateKey.startsWith(`${parentKey}/`);
}

function isGlobLike(value){
    return /[*?\[\]{}]/.test(value);
}

function validatePathList(value,label,{required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)){
        fail(`${label} must be ${required?'a non-empty':'an'} array of literal relative paths.`);
    }

    if(value.length>512){
        fail(`${label} is unreasonably large.`);
    }

    const normalized=value.map((entry,index)=>{
        const item=normalizeRelativePath(entry,`${label}[${index}]`);

        if(isGlobLike(item)){
            fail(`${label}[${index}] must be literal; directories already include descendants.`);
        }

        return item;
    });
    const keys=new Set();

    for(const item of normalized){
        const key=pathKey(item);

        if(keys.has(key)){
            fail(`${label} contains a duplicate path: ${item}`);
        }

        keys.add(key);
    }

    if(required){
        for(let left=0;left<normalized.length;left++){
            for(let right=left+1;right<normalized.length;right++){
                if(pathIsSameOrDescendant(normalized[left],normalized[right])
                    ||pathIsSameOrDescendant(normalized[right],normalized[left])){
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
    return isAlwaysForbidden(relative)
        ||excludes.some(excluded=>pathIsSameOrDescendant(relative,excluded));
}

function assertSafePresentationText(value,label,maximum=160){
    if(typeof value!=='string'||!value.trim()||value.length>maximum
        ||TEXT_CONTROL_PATTERN.test(value)||/[<>]/.test(value)){
        fail(`${label} must be plain text no longer than ${maximum} characters.`);
    }

    return value.trim();
}

export function parseSemver(value){
    if(typeof value!=='string'){
        fail(`Invalid semantic version: ${String(value)}`);
    }

    const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);

    if(!match){
        fail(`Invalid semantic version: ${value}`);
    }

    const prerelease=match[4]?match[4].split('.'):[];
    const build=match[5]?match[5].split('.'):[];

    for(const identifier of prerelease){
        if(/^\d+$/.test(identifier)&&identifier.length>1&&identifier.startsWith('0')){
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
        build
    };
}

function formatSemver(version){
    let rendered=`${version.major}.${version.minor}.${version.patch}`;

    if(version.prerelease?.length){
        rendered+=`-${version.prerelease.join('.')}`;
    }

    if(version.build?.length){
        rendered+=`+${version.build.join('.')}`;
    }

    return rendered;
}

function validatePreid(preid){
    const value=preid??'rc';

    if(typeof value!=='string'||!/^[0-9A-Za-z-]+$/.test(value)
        ||(/^\d+$/.test(value)&&value.length>1&&value.startsWith('0'))){
        fail(`Invalid prerelease identifier: ${String(value)}`);
    }

    return value;
}

export function incrementSemver(value,bump,preid){
    const current=parseSemver(value);

    if(!['major','minor','patch','prerelease'].includes(bump)){
        fail(`Unsupported semantic version bump: ${String(bump)}`);
    }

    if(bump==='major'){
        return formatSemver({major:current.major+1,minor:0,patch:0});
    }

    if(bump==='minor'){
        return formatSemver({major:current.major,minor:current.minor+1,patch:0});
    }

    if(bump==='patch'){
        return formatSemver({major:current.major,minor:current.minor,patch:current.patch+1});
    }

    const requestedPreid=validatePreid(preid);
    const next={
        major:current.major,
        minor:current.minor,
        patch:current.patch,
        prerelease:[]
    };

    if(!current.prerelease.length){
        next.patch+=1;
        next.prerelease=[requestedPreid,'0'];
        return formatSemver(next);
    }

    if(current.prerelease[0]!==requestedPreid){
        next.prerelease=[requestedPreid,'0'];
        return formatSemver(next);
    }

    next.prerelease=[...current.prerelease];
    let incremented=false;

    for(let index=next.prerelease.length-1;index>=0;index--){
        if(/^\d+$/.test(next.prerelease[index])){
            const number=Number(next.prerelease[index]);

            if(!Number.isSafeInteger(number)||number===Number.MAX_SAFE_INTEGER){
                fail(`Prerelease number is too large to increment: ${value}`);
            }

            next.prerelease[index]=String(number+1);
            incremented=true;
            break;
        }
    }

    if(!incremented){
        next.prerelease.push('0');
    }

    return formatSemver(next);
}

async function readJsonDocument(filePath,label=filePath,{expectedIdentity}={}){
    let document;
    try{
        document=await readStableBytes(filePath,label,expectedIdentity);
    }catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist.`);
        throw error;
    }

    try{
        return {
            value:JSON.parse(document.bytes.toString('utf8')),
            bytes:document.bytes,
            identity:document.identity
        };
    }catch(error){
        fail(`${label} is not valid JSON: ${error.message}`);
    }
}

async function readJson(filePath,label=filePath){
    return (await readJsonDocument(filePath,label)).value;
}

function validateSharedRoute(route,label){
    assertOnlyKeys(route,new Set(['source','destination','include','exclude']),label);
    const source=normalizeRelativeRoot(route.source,`${label}.source`);
    const destination=normalizeRelativeRoot(route.destination,`${label}.destination`);
    const include=validatePathList(route.include,`${label}.include`,{required:true});
    const exclude=validatePathList(route.exclude??[],`${label}.exclude`);

    if(source==='.'||source==='apps'||source.startsWith('apps/')
        ||source==='dist'||source.startsWith('dist/')
        ||source==='node_modules'
        ||isAlwaysForbidden(source)){
        fail(`${label}.source is outside the permitted shared-payload boundary: ${source}`);
    }

    if(destination==='apps'||destination.startsWith('apps/')
        ||destination===RELEASE_MANIFEST_NAME){
        fail(`${label}.destination overlaps a reserved package path: ${destination}`);
    }

    return Object.freeze({source,destination,include,exclude});
}

async function loadRootConfigDocument(workspaceRoot){
    const configPath=path.join(workspaceRoot,ROOT_CONFIG_NAME);
    const document=await readJsonDocument(configPath,ROOT_CONFIG_NAME);
    return {
        ...document,
        value:validateRootConfig(document.value,configPath),
        configPath
    };
}

async function loadRootConfig(workspaceRoot){
    return (await loadRootConfigDocument(workspaceRoot)).value;
}

export function validateRootConfig(value,configPath=ROOT_CONFIG_NAME){
    assertOnlyKeys(value,new Set(['schemaVersion','appsRoot','distRoot','sharedPayloads']),ROOT_CONFIG_NAME);

    if(value.schemaVersion!==1){
        fail(`${ROOT_CONFIG_NAME}.schemaVersion must be 1.`);
    }

    if(value.appsRoot!=='apps'||value.distRoot!=='dist'){
        fail(`${ROOT_CONFIG_NAME} must bind appsRoot to "apps" and distRoot to "dist".`);
    }

    if(!isPlainObject(value.sharedPayloads)){
        fail(`${ROOT_CONFIG_NAME}.sharedPayloads must be an object.`);
    }

    const sharedPayloads={};

    for(const [id,routes] of Object.entries(value.sharedPayloads).sort(([left],[right])=>compareText(left,right))){
        if(!SAFE_SHARED_ID_PATTERN.test(id)){
            fail(`Unsafe shared payload id: ${id}`);
        }

        if(!Array.isArray(routes)||routes.length===0){
            fail(`sharedPayloads.${id} must be a non-empty array.`);
        }

        sharedPayloads[id]=Object.freeze(routes.map((route,index)=>
            validateSharedRoute(route,`sharedPayloads.${id}[${index}]`)
        ));
    }

    return Object.freeze({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:Object.freeze(sharedPayloads),
        configPath
    });
}

export function validateAppConfig(value,appId,rootConfig,configPath=`apps/${appId}/${APP_CONFIG_NAME}`){
    assertOnlyKeys(
        value,
        new Set([
            'schemaVersion',
            'id',
            'displayName',
            'version',
            'entry',
            'strategy',
            'security',
            'localAIModelPolicy',
            'include',
            'exclude',
            'shared',
            'adapter'
        ]),
        `${appId}/${APP_CONFIG_NAME}`
    );

    if(value.schemaVersion!==1){
        fail(`${appId}/${APP_CONFIG_NAME}.schemaVersion must be 1.`);
    }

    if(value.id!==appId||!APP_ID_PATTERN.test(value.id)){
        fail(`${appId}/${APP_CONFIG_NAME}.id must exactly match its apps directory.`);
    }

    const displayName=assertSafePresentationText(
        value.displayName,
        `${appId}/${APP_CONFIG_NAME}.displayName`
    );
    parseSemver(value.version);
    const entry=normalizeRelativePath(value.entry,`${appId}/${APP_CONFIG_NAME}.entry`);
    const include=validatePathList(value.include,`${appId}/${APP_CONFIG_NAME}.include`,{required:true});
    const exclude=validatePathList(value.exclude??[],`${appId}/${APP_CONFIG_NAME}.exclude`);

    if(include.some(allowed=>pathIsSameOrDescendant(APP_CONFIG_NAME,allowed))){
        fail(`${appId}/${APP_CONFIG_NAME}.include must not expose the authored package configuration.`);
    }

    const localAIModelPolicy=value.localAIModelPolicy===undefined
        ?Object.freeze({verified_only:true,models:Object.freeze([])})
        :validateLocalAIModelPolicy(value.localAIModelPolicy,`${appId}/${APP_CONFIG_NAME}.localAIModelPolicy`);
    const security=validateAppSecurity(value.security,appId);

    for(const model of localAIModelPolicy.models){
        if(isAlwaysForbidden(model.definition)||isExcluded(model.definition,exclude)
            ||!include.some(allowed=>pathIsSameOrDescendant(model.definition,allowed))){
            fail(`${appId}/${APP_CONFIG_NAME}.localAIModelPolicy model definition is not covered by its public include rules: ${model.definition}`);
        }
    }

    if(isAlwaysForbidden(entry)||isExcluded(entry,exclude)
        ||!include.some(allowed=>pathIsSameOrDescendant(entry,allowed))){
        fail(`${appId}/${APP_CONFIG_NAME}.entry is not covered by its public include rules.`);
    }

    if(!['static','adapter'].includes(value.strategy)){
        fail(`${appId}/${APP_CONFIG_NAME}.strategy must be "static" or "adapter".`);
    }

    if(!Array.isArray(value.shared)||new Set(value.shared).size!==value.shared.length){
        fail(`${appId}/${APP_CONFIG_NAME}.shared must be an array of unique shared payload ids.`);
    }

    for(const [index,sharedId] of value.shared.entries()){
        if(typeof sharedId!=='string'||!Object.hasOwn(rootConfig.sharedPayloads,sharedId)){
            fail(`${appId}/${APP_CONFIG_NAME}.shared[${index}] references an unknown shared payload: ${String(sharedId)}`);
        }
    }

    let adapter=null;

    if(value.strategy==='adapter'){
        adapter=normalizeRelativePath(value.adapter,`${appId}/${APP_CONFIG_NAME}.adapter`);

        if(!adapter.startsWith('scripts/')||path.posix.extname(adapter)!=='.mjs'){
            fail(`${appId}/${APP_CONFIG_NAME}.adapter must be an app-local scripts/*.mjs module.`);
        }
    }else if(value.adapter!==undefined){
        fail(`${appId}/${APP_CONFIG_NAME}.adapter is only valid with strategy "adapter".`);
    }

    return Object.freeze({
        schemaVersion:1,
        id:appId,
        displayName,
        version:value.version,
        entry,
        strategy:value.strategy,
        security,
        localAIModelPolicy,
        include:Object.freeze(include),
        exclude:Object.freeze(exclude),
        shared:Object.freeze([...value.shared]),
        adapter,
        configPath
    });
}

function validateOriginList(value,label,{allowLoopbackHttp=false,allowHttpsScheme=false}={}){
    if(!Array.isArray(value)||value.length>16){
        fail(`${label} must be an array with at most 16 origins.`);
    }
    const origins=value.map((origin,index)=>{
        if(typeof origin!=='string'||origin!==origin.trim()){
            fail(`${label}[${index}] is invalid.`);
        }
        if(origin==='https:'&&allowHttpsScheme)return origin;
        let parsed;
        try{
            parsed=new URL(origin);
        }catch{
            fail(`${label}[${index}] is not a valid URL origin.`);
        }
        if(parsed.origin!==origin||parsed.hostname.endsWith('.')||parsed.username||parsed.password
            ||parsed.pathname!=='/'||parsed.search||parsed.hash){
            fail(`${label}[${index}] must be a canonical allowed origin.`);
        }
        if(parsed.protocol==='http:'){
            if(!allowLoopbackHttp||!['127.0.0.1','[::1]'].includes(parsed.hostname)){
                fail(`${label}[${index}] may use HTTP only for a numeric loopback host.`);
            }
        }else if(parsed.protocol!=='https:'){
            fail(`${label}[${index}] must use HTTPS or an approved loopback HTTP origin.`);
        }
        return parsed.origin;
    });
    if(new Set(origins).size!==origins.length)fail(`${label} must not contain duplicates.`);
    if(JSON.stringify(origins)!==JSON.stringify([...origins].sort(compareText))){
        fail(`${label} must be sorted for deterministic projection.`);
    }
    return Object.freeze(origins);
}

function validateAppSecurity(value,appId){
    if(!isPlainObject(value))fail(`${appId}/${APP_CONFIG_NAME}.security must be an object.`);
    const label=`${appId}/${APP_CONFIG_NAME}.security`;
    assertOnlyKeys(value,new Set(['connectOrigins','frameOrigins','mediaOrigins']),label);
    return Object.freeze({
        connectOrigins:validateOriginList(value.connectOrigins,`${label}.connectOrigins`,{allowLoopbackHttp:true}),
        frameOrigins:validateOriginList(value.frameOrigins,`${label}.frameOrigins`,{allowHttpsScheme:appId==='browser'}),
        mediaOrigins:validateOriginList(value.mediaOrigins,`${label}.mediaOrigins`)
    });
}

function validateLocalAIModelPolicy(value,label){
    assertOnlyKeys(value,new Set(['verified_only','models']),label);

    if(typeof value.verified_only!=='boolean'){
        fail(`${label}.verified_only must be a boolean.`);
    }

    if(!Array.isArray(value.models)){
        fail(`${label}.models must be an array.`);
    }

    if(value.models.length>MAX_LOCAL_AI_MODELS){
        fail(`${label}.models must contain no more than ${MAX_LOCAL_AI_MODELS} entries.`);
    }

    const modelNames=new Set();
    const definitions=new Set();
    const models=value.models.map((model,index)=>{
        const modelLabel=`${label}.models[${index}]`;
        assertOnlyKeys(model,new Set(['name','definition']),modelLabel);

        if(typeof model.name!=='string'||model.name!==model.name.trim()
            ||!OLLAMA_MODEL_IDENTIFIER.test(model.name)||model.name.toUpperCase()==='OPENAI'){
            fail(`${modelLabel}.name must be a canonical bounded Ollama model identifier.`);
        }

        if(typeof model.definition!=='string'||model.definition.length>128
            ||!MODEL_DEFINITION_PATTERN.test(model.definition)
            ||normalizeRelativePath(model.definition,`${modelLabel}.definition`)!==model.definition){
            fail(`${modelLabel}.definition must be a safe app-relative Modelfile basename.`);
        }

        const canonicalName=model.name.toLocaleLowerCase('en-US');
        const canonicalAlias=canonicalName.includes(':')?canonicalName:`${canonicalName}:latest`;
        const definitionKey=pathKey(model.definition);

        if(modelNames.has(canonicalAlias)){
            fail(`${label}.models contains a duplicate canonical model name: ${model.name}`);
        }
        if(definitions.has(definitionKey)){
            fail(`${label}.models contains a duplicate definition: ${model.definition}`);
        }

        modelNames.add(canonicalAlias);
        definitions.add(definitionKey);
        return Object.freeze({name:model.name,definition:model.definition});
    });

    return Object.freeze({
        verified_only:value.verified_only,
        models:Object.freeze(models)
    });
}

async function validateLocalAIModelDefinitions(appRoot,config){
    for(const [index,model] of config.localAIModelPolicy.models.entries()){
        const label=`${config.id}/${APP_CONFIG_NAME}.localAIModelPolicy.models[${index}].definition`;
        const definitionPath=resolveInside(appRoot,model.definition,label);
        let details;

        try{
            await assertNoLinks(appRoot,definitionPath,label);
            details=await lstat(definitionPath);
        }catch(error){
            if(error?.code==='ENOENT'){
                fail(`${label} does not exist: ${model.definition}`);
            }
            throw error;
        }

        if(details.isSymbolicLink()||!details.isFile()||details.size<1
            ||details.size>MAX_MODEL_DEFINITION_BYTES){
            fail(`${label} must be a non-empty regular file no larger than 512 KiB.`);
        }
    }
}

async function assertNoLinks(root,candidate,label){
    const resolvedRoot=path.resolve(root);
    const resolvedCandidate=path.resolve(candidate);

    if(!isInside(resolvedRoot,resolvedCandidate,{allowEqual:true})){
        fail(`${label} leaves its allowed root.`);
    }

    const relative=path.relative(resolvedRoot,resolvedCandidate);
    let current=resolvedRoot;
    const rootInfo=await lstat(resolvedRoot);

    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail(`${label} root must be a real directory.`);
    }

    for(const segment of relative.split(path.sep).filter(Boolean)){
        current=path.join(current,segment);
        const info=await lstat(current);

        if(info.isSymbolicLink()){
            fail(`${label} contains a symbolic link or junction: ${current}`);
        }
    }

    const [actualRoot,actualCandidate]=await Promise.all([
        realpath(resolvedRoot),
        realpath(resolvedCandidate)
    ]);

    if(!isInside(actualRoot,actualCandidate,{allowEqual:true})){
        fail(`${label} resolves outside its allowed root.`);
    }
}

async function assertSafeDistBoundary(workspaceRoot,distRoot,{create=false}={}){
    await assertNoLinks(workspaceRoot,workspaceRoot,'workspace');
    let details;

    try{
        details=await lstat(distRoot);
    }catch(error){
        if(error?.code!=='ENOENT'){
            throw error;
        }

        if(!create){
            return false;
        }

        try{
            await mkdir(distRoot);
        }catch(createError){
            if(createError?.code!=='EEXIST'){
                throw createError;
            }
        }

        details=await lstat(distRoot);
    }

    if(details.isSymbolicLink()||!details.isDirectory()){
        fail('dist must be a real workspace directory, not a link, junction, or special entry.');
    }

    await assertNoLinks(workspaceRoot,distRoot,'dist');
    return true;
}

async function assertOptionalSafeOutput(distRoot,outputRoot,appId){
    let details;

    try{
        details=await lstat(outputRoot);
    }catch(error){
        if(error?.code==='ENOENT'){
            return false;
        }

        throw error;
    }

    if(details.isSymbolicLink()||!details.isDirectory()){
        fail(`dist/${appId} must be a real directory, not a link, junction, or special entry.`);
    }

    await assertNoLinks(distRoot,outputRoot,`dist/${appId}`);
    return true;
}

async function appDescriptorContracts(){
    appDescriptorContractsPromise??=import('../app-descriptor.mjs');
    return appDescriptorContractsPromise;
}

async function optionalRegularFileIdentity(filePath,label){
    let info;
    try{
        info=await lstat(filePath,{bigint:true});
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
    if(info.isSymbolicLink()||!info.isFile()){
        fail(`${label} must be a regular file, not a link or special entry.`);
    }
    return fileIdentity(info);
}

function recordedIdentityMatches(left,right){
    if(left===null||right===null)return left===right;
    return left.device===right.device
        &&left.inode===right.inode
        &&left.bytes===right.bytes
        &&left.modifiedNanoseconds===right.modifiedNanoseconds
        &&left.changedNanoseconds===right.changedNanoseconds
        &&left.links===right.links;
}

async function createAppDescriptorAuthority(context,packageDocument,{signal}={}){
    throwIfAborted(signal);
    const contracts=await appDescriptorContracts();
    const descriptorPath=path.join(context.appRoot,APP_DESCRIPTOR_NAME);
    const descriptorIdentity=await optionalRegularFileIdentity(
        descriptorPath,
        `apps/${context.config.id}/${APP_DESCRIPTOR_NAME}`
    );
    let descriptor;
    let source;
    let sourcePath;
    let sourceIdentity;

    if(descriptorIdentity){
        const descriptorDocument=await readJsonDocument(
            descriptorPath,
            `apps/${context.config.id}/${APP_DESCRIPTOR_NAME}`,
            {expectedIdentity:descriptorIdentity}
        );
        descriptor=contracts.validateAppDescriptor(descriptorDocument.value,{
            appId:context.config.id
        });
        if(!isDeepStrictEqual(
            contracts.projectPackageManifest(descriptor),
            packageDocument.value
        )){
            fail(`${APP_DESCRIPTOR_NAME} does not project exactly to ${APP_CONFIG_NAME}.`);
        }
        source='authored';
        sourcePath=descriptorPath;
        sourceIdentity=descriptorDocument.identity;
    }else{
        const registryPath=path.join(context.workspaceRoot,LEGACY_APP_REGISTRY_PATH);
        const registryBefore=await optionalRegularFileIdentity(
            registryPath,
            'Arcane native app registry'
        );
        const loaded=await contracts.loadAppDescriptor({
            workspaceRoot:context.workspaceRoot,
            appRoot:context.appRoot,
            appId:context.config.id,
            packageManifest:packageDocument.value
        });
        const [descriptorAfter,registryAfter]=await Promise.all([
            optionalRegularFileIdentity(
                descriptorPath,
                `apps/${context.config.id}/${APP_DESCRIPTOR_NAME}`
            ),
            optionalRegularFileIdentity(registryPath,'Arcane native app registry')
        ]);
        if(descriptorAfter!==null||!recordedIdentityMatches(registryBefore,registryAfter)){
            fail(`The descriptor source for ${context.config.id} changed while it was selected.`);
        }
        descriptor=loaded.descriptor;
        source=loaded.source;
        sourcePath=registryBefore?registryPath:null;
        sourceIdentity=registryBefore;
    }

    const canonicalDescriptor=immutableJsonCopy(descriptor);
    return Object.freeze({
        descriptor:canonicalDescriptor,
        descriptorSha256:contracts.appDescriptorSha256(canonicalDescriptor),
        source,
        sourcePath,
        sourceIdentity,
        packageConfigPath:context.config.configPath,
        packageConfigIdentity:packageDocument.identity
    });
}

async function assertAppDescriptorAuthorityCurrent(context,{signal}={}){
    const expected=context.descriptorAuthority;
    if(!expected)fail('Canonical app descriptor authority is unavailable.');
    const packageDocument=await readJsonDocument(
        expected.packageConfigPath,
        expected.packageConfigPath,
        {expectedIdentity:expected.packageConfigIdentity}
    );
    const config=validateAppConfig(
        packageDocument.value,
        context.config.id,
        context.rootConfig,
        expected.packageConfigPath
    );
    const current=await createAppDescriptorAuthority(
        {...context,config},
        packageDocument,
        {signal}
    );
    if(current.descriptorSha256!==expected.descriptorSha256
        ||current.source!==expected.source
        ||current.sourcePath!==expected.sourcePath
        ||!recordedIdentityMatches(current.sourceIdentity,expected.sourceIdentity)
        ||!recordedIdentityMatches(
            current.packageConfigIdentity,
            expected.packageConfigIdentity
        )){
        fail(`The canonical descriptor authority for ${context.config.id} changed during packaging.`);
    }
    return expected;
}

async function assertValidatedDescriptorAuthority(validation,descriptorAuthority){
    if(validation===undefined||validation?.app?.descriptor===undefined)return;
    const descriptor=validation?.app?.descriptor;
    const contracts=await appDescriptorContracts();
    if(contracts.appDescriptorSha256(descriptor)!==descriptorAuthority.descriptorSha256){
        fail('Source validation returned a different canonical Arcane application descriptor.');
    }
}

async function getAppContext({
    workspaceRoot:requestedWorkspaceRoot,
    appId,
    bindDescriptorAuthority=false,
    signal
}){
    const workspaceRoot=normalizeWorkspaceRoot(requestedWorkspaceRoot);

    if(typeof appId!=='string'||!APP_ID_PATTERN.test(appId)){
        fail(`Invalid app id: ${String(appId)}`);
    }

    const rootConfig=await loadRootConfig(workspaceRoot);
    const appsRoot=path.join(workspaceRoot,rootConfig.appsRoot);
    const appRoot=resolveInside(appsRoot,appId,'app id');
    let appInfo;

    try{
        appInfo=await lstat(appRoot);
    }catch(error){
        if(error?.code==='ENOENT'){
            const available=(await readdir(appsRoot,{withFileTypes:true}))
                .filter(entry=>entry.isDirectory()&&APP_ID_PATTERN.test(entry.name))
                .map(entry=>entry.name)
                .sort(compareText);
            fail(`Unknown app "${appId}". Available apps: ${available.join(', ')||'[none]'}.`);
        }

        throw error;
    }

    if(appInfo.isSymbolicLink()||!appInfo.isDirectory()){
        fail(`apps/${appId} must be a real directory, not a link or special entry.`);
    }

    await assertNoLinks(appsRoot,appRoot,`apps/${appId}`);
    const configPath=path.join(appRoot,APP_CONFIG_NAME);
    const configDocument=await readJsonDocument(
        configPath,
        `apps/${appId}/${APP_CONFIG_NAME}`
    );
    const config=validateAppConfig(configDocument.value,appId,rootConfig,configPath);
    await validateLocalAIModelDefinitions(appRoot,config);
    const distRoot=path.join(workspaceRoot,rootConfig.distRoot);
    const outputRoot=resolveInside(distRoot,appId,'package output');
    const distExists=await assertSafeDistBoundary(workspaceRoot,distRoot);

    if(distExists){
        await assertOptionalSafeOutput(distRoot,outputRoot,appId);
    }

    const context={workspaceRoot,rootConfig,appsRoot,appRoot,distRoot,outputRoot,config};
    if(!bindDescriptorAuthority)return context;
    return {
        ...context,
        descriptorAuthority:await createAppDescriptorAuthority(context,configDocument,{signal})
    };
}

async function enumerateRoute({
    workspaceRoot,
    sourceRoot,
    destinationRoot,
    include,
    exclude,
    label,
    appPayload=false,
    signal
}){
    throwIfAborted(signal);
    await assertNoLinks(workspaceRoot,sourceRoot,`${label}.source`);
    const files=[];

    async function visit(absolute,relative){
        throwIfAborted(signal);
        if(isExcluded(relative,exclude)||(appPayload&&isAppSourceForbidden(relative))){
            return;
        }

        const info=await lstat(absolute,{bigint:true});

        if(info.isSymbolicLink()){
            fail(`${label} contains a symbolic link or junction: ${relative}`);
        }

        if(info.isDirectory()){
            const entries=await readdir(absolute,{withFileTypes:true});

            for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
                throwIfAborted(signal);
                const childRelative=`${relative}/${entry.name}`;

                if(isExcluded(childRelative,exclude)
                    ||(appPayload&&isAppSourceForbidden(childRelative))){
                    continue;
                }

                if(entry.isSymbolicLink()){
                    fail(`${label} contains a symbolic link or junction: ${childRelative}`);
                }

                await visit(path.join(absolute,entry.name),childRelative);
            }

            return;
        }

        if(!info.isFile()){
            fail(`${label} contains a non-file entry: ${relative}`);
        }

        const destination=destinationRoot==='.'
            ?relative
            :`${destinationRoot}/${relative}`;
        const bytes=Number(info.size);
        if(!Number.isSafeInteger(bytes)||bytes<0){
            fail(`${label} contains a file whose size is not safely representable: ${relative}`);
        }
        files.push({
            source:absolute,
            sourceRelative:relative,
            destination:normalizeRelativePath(destination,`${label} destination`),
            bytes,
            identity:fileIdentity(info),
            label
        });
    }

    for(const allowed of include){
        throwIfAborted(signal);
        if(isExcluded(allowed,exclude)||(appPayload&&isAppSourceForbidden(allowed))){
            continue;
        }

        const candidate=resolveInside(sourceRoot,allowed,`${label}.include`);

        try{
            await assertNoLinks(sourceRoot,candidate,`${label}.include "${allowed}"`);
        }catch(error){
            if(error?.code==='ENOENT'){
                fail(`${label}.include does not exist: ${allowed}`);
            }

            throw error;
        }

        await visit(candidate,allowed);
    }

    return files;
}

function workspaceLocationIdentity(info){
    return Object.freeze({
        device:String(info.dev),
        inode:String(info.ino)
    });
}

function workspaceLocationMatches(info,identity){
    return String(info.dev)===identity.device&&String(info.ino)===identity.inode;
}

function normalizeSharedPayloadSelection(sharedPayloadIds,rootConfig,{required=false}={}){
    const selected=sharedPayloadIds===undefined
        ?Object.keys(rootConfig.sharedPayloads)
        :sharedPayloadIds;

    if(!Array.isArray(selected)||selected.length>256||(required&&selected.length===0)){
        fail('sharedPayloadIds must be a non-empty array with at most 256 entries.');
    }

    const normalized=[];
    const seen=new Set();
    for(const [index,id] of selected.entries()){
        if(typeof id!=='string'||!SAFE_SHARED_ID_PATTERN.test(id)
            ||!Object.hasOwn(rootConfig.sharedPayloads,id)){
            fail(`sharedPayloadIds[${index}] references an unknown shared payload: ${String(id)}`);
        }
        if(seen.has(id))fail(`sharedPayloadIds contains a duplicate shared payload: ${id}`);
        seen.add(id);
        normalized.push(id);
    }
    return Object.freeze(normalized.sort(compareText));
}

function assertSnapshotCoverage(state,requiredIds){
    for(const id of requiredIds){
        if(!Object.hasOwn(state.filesBySharedPayload,id)){
            fail(`Shared payload snapshot does not include the required payload: ${id}`);
        }
    }
}

async function authenticateSharedPayloadSnapshotState(receipt,{
    workspaceRoot,
    sharedPayloadIds,
    signal
}={}){
    throwIfAborted(signal);
    const state=issuedSharedPayloadSnapshots.get(receipt);
    if(!state)fail('Shared payload snapshot was not issued by this SDK process.');
    const requested=normalizeWorkspaceRoot(workspaceRoot);
    let workspaceInfo;
    let canonicalWorkspaceRoot;
    try{
        workspaceInfo=await lstat(requested,{bigint:true});
        canonicalWorkspaceRoot=await realpath(requested);
    }catch(error){
        fail(`Shared payload snapshot workspace is unavailable: ${error.message}`);
    }
    if(workspaceInfo.isSymbolicLink()||!workspaceInfo.isDirectory()
        ||canonicalWorkspaceRoot!==state.canonicalWorkspaceRoot
        ||receipt.canonicalWorkspaceRoot!==canonicalWorkspaceRoot
        ||!workspaceLocationMatches(workspaceInfo,state.workspaceIdentity)){
        fail('Shared payload snapshot belongs to a different workspace identity.');
    }
    let configInfo;
    try{
        configInfo=await lstat(state.rootConfigPath,{bigint:true});
    }catch(error){
        fail(`Shared payload snapshot root configuration changed: ${error.message}`);
    }
    if(configInfo.isSymbolicLink()||!configInfo.isFile()
        ||!identityMatches(configInfo,state.rootConfigIdentity)){
        fail('Shared payload snapshot root configuration changed after preparation.');
    }
    if(sharedPayloadIds!==undefined){
        if(!Array.isArray(sharedPayloadIds)||sharedPayloadIds.length>256){
            fail('sharedPayloadIds must be an array with at most 256 entries.');
        }
        const seen=new Set();
        for(const [index,id] of sharedPayloadIds.entries()){
            if(typeof id!=='string'||!SAFE_SHARED_ID_PATTERN.test(id)||seen.has(id)){
                fail(`sharedPayloadIds[${index}] is invalid or duplicated.`);
            }
            seen.add(id);
        }
        assertSnapshotCoverage(state,sharedPayloadIds);
    }
    throwIfAborted(signal);
    return state;
}

export async function prepareSharedPayloadSnapshot({
    workspaceRoot:requestedWorkspaceRoot,
    sharedPayloadIds,
    signal,
    onEvent
}={}){
    await emitOperation(onEvent,{type:'shared-payload.snapshot.started'});
    throwIfAborted(signal);
    const resolvedWorkspaceRoot=normalizeWorkspaceRoot(requestedWorkspaceRoot);
    const initialWorkspaceInfo=await lstat(resolvedWorkspaceRoot,{bigint:true});
    if(initialWorkspaceInfo.isSymbolicLink()||!initialWorkspaceInfo.isDirectory()){
        fail('Shared payload snapshot workspace must be a real directory.');
    }
    const canonicalWorkspaceRoot=await realpath(resolvedWorkspaceRoot);
    await assertNoLinks(canonicalWorkspaceRoot,canonicalWorkspaceRoot,'shared payload snapshot workspace');
    const rootConfigDocument=await loadRootConfigDocument(canonicalWorkspaceRoot);
    const selectedIds=normalizeSharedPayloadSelection(
        sharedPayloadIds,
        rootConfigDocument.value,
        {required:true}
    );
    const retained=[];
    const retainedBySharedPayload=Object.fromEntries(selectedIds.map(id=>[id,[]]));
    let totalBytes=0;
    let completedFiles=0;

    for(const sharedPayloadId of selectedIds){
        const routes=rootConfigDocument.value.sharedPayloads[sharedPayloadId];
        for(const [routeIndex,route] of routes.entries()){
            throwIfAborted(signal);
            const sourceRoot=resolveInside(
                canonicalWorkspaceRoot,
                route.source,
                `sharedPayloads.${sharedPayloadId}[${routeIndex}].source`
            );
            const files=await enumerateRoute({
                workspaceRoot:canonicalWorkspaceRoot,
                sourceRoot,
                destinationRoot:route.destination,
                include:route.include,
                exclude:route.exclude,
                label:`sharedPayloads.${sharedPayloadId}[${routeIndex}]`,
                signal
            });
            for(const file of files){
                throwIfAborted(signal);
                if(retained.length>=MAX_SHARED_SNAPSHOT_FILE_COUNT){
                    fail(`Shared payload snapshot exceeds ${MAX_SHARED_SNAPSHOT_FILE_COUNT} files.`);
                }
                if(file.bytes>MAX_SHARED_SNAPSHOT_FILE_BYTES){
                    fail(`Shared payload snapshot file exceeds ${MAX_SHARED_SNAPSHOT_FILE_BYTES} bytes: ${file.sourceRelative}`);
                }
                if(totalBytes+file.bytes>MAX_SHARED_SNAPSHOT_TOTAL_BYTES){
                    fail(`Shared payload snapshot exceeds ${MAX_SHARED_SNAPSHOT_TOTAL_BYTES} retained bytes.`);
                }
                const stable=await readStableBytes(file.source,file.label,file.identity);
                if(stable.bytes.length!==file.bytes){
                    fail(`Shared payload snapshot file changed size while retained: ${file.sourceRelative}`);
                }
                const digest=createHash('sha256').update(stable.bytes).digest('hex');
                const source=route.source==='.'
                    ?file.sourceRelative
                    :`${route.source}/${file.sourceRelative}`;
                const record=Object.freeze({
                    ...file,
                    sharedPayloadId,
                    routeIndex,
                    sourceRelative:normalizeRelativePath(source,'shared payload snapshot source'),
                    retainedBytes:stable.bytes,
                    sha256:digest
                });
                retained.push(record);
                retainedBySharedPayload[sharedPayloadId].push(record);
                totalBytes+=stable.bytes.length;
                completedFiles+=1;
                await emitOperation(onEvent,{
                    type:'shared-payload.snapshot.progress',
                    current:completedFiles,
                    completedBytes:totalBytes,
                    sharedPayloadId,
                    path:record.sourceRelative
                });
            }
        }
    }

    const [finalWorkspaceInfo,finalConfigInfo]=await Promise.all([
        lstat(canonicalWorkspaceRoot,{bigint:true}),
        lstat(rootConfigDocument.configPath,{bigint:true})
    ]);
    const workspaceIdentity=workspaceLocationIdentity(initialWorkspaceInfo);
    if(finalWorkspaceInfo.isSymbolicLink()||!finalWorkspaceInfo.isDirectory()
        ||!workspaceLocationMatches(finalWorkspaceInfo,workspaceIdentity)
        ||finalConfigInfo.isSymbolicLink()||!finalConfigInfo.isFile()
        ||!identityMatches(finalConfigInfo,rootConfigDocument.identity)){
        fail('Shared payload snapshot workspace or root configuration changed during preparation.');
    }

    const inventory=retained.map(record=>({
        sharedPayloadId:record.sharedPayloadId,
        routeIndex:record.routeIndex,
        source:record.sourceRelative,
        destination:record.destination,
        bytes:record.bytes,
        sha256:record.sha256
    })).sort((left,right)=>compareText(JSON.stringify(left),JSON.stringify(right)));
    const receipt=immutableJsonCopy({
        schemaVersion:1,
        kind:'arcane-shared-payload-snapshot',
        canonicalWorkspaceRoot,
        workspaceIdentity,
        rootConfig:Object.freeze({
            path:ROOT_CONFIG_NAME,
            identity:rootConfigDocument.identity,
            sha256:createHash('sha256').update(rootConfigDocument.bytes).digest('hex')
        }),
        sharedPayloadIds:selectedIds,
        files:inventory,
        fileCount:inventory.length,
        totalBytes,
        contentSha256:createHash('sha256').update(JSON.stringify(inventory)).digest('hex')
    });
    const filesBySharedPayload=Object.freeze(Object.fromEntries(
        Object.entries(retainedBySharedPayload).map(([id,files])=>[id,Object.freeze(files)])
    ));
    issuedSharedPayloadSnapshots.set(receipt,Object.freeze({
        receipt,
        canonicalWorkspaceRoot,
        workspaceIdentity,
        rootConfigPath:rootConfigDocument.configPath,
        rootConfigIdentity:rootConfigDocument.identity,
        files:Object.freeze(retained),
        filesBySharedPayload
    }));
    await emitOperation(onEvent,{
        type:'shared-payload.snapshot.completed',
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes,
        contentSha256:receipt.contentSha256
    });
    return receipt;
}

export async function authenticateSharedPayloadSnapshot(receipt,options={}){
    await authenticateSharedPayloadSnapshotState(receipt,options);
    return receipt;
}

async function collectPackageFiles(context,{signal,sharedPayloadState}={}){
    const {workspaceRoot,appRoot,config,rootConfig}=context;
    const files=await enumerateRoute({
        workspaceRoot,
        sourceRoot:appRoot,
        destinationRoot:`apps/${config.id}`,
        include:config.include,
        exclude:config.exclude,
        label:`apps.${config.id}`,
        appPayload:true,
        signal
    });

    if(sharedPayloadState){
        assertSnapshotCoverage(sharedPayloadState,config.shared);
        for(const sharedId of config.shared){
            files.push(...sharedPayloadState.filesBySharedPayload[sharedId]);
        }
    }else{
        for(const sharedId of config.shared){
            const routes=rootConfig.sharedPayloads[sharedId];

            for(const [index,route] of routes.entries()){
                const sourceRoot=resolveInside(
                    workspaceRoot,
                    route.source,
                    `sharedPayloads.${sharedId}[${index}].source`
                );
                files.push(...await enumerateRoute({
                    workspaceRoot,
                    sourceRoot,
                    destinationRoot:route.destination,
                    include:route.include,
                    exclude:route.exclude,
                    label:`sharedPayloads.${sharedId}[${index}]`,
                    signal
                }));
            }
        }
    }

    const destinations=new Map();

    for(const file of files){
        throwIfAborted(signal);
        if(file.destination===RELEASE_MANIFEST_NAME||file.destination==='index.html'){
            fail(`${file.label} collides with generated package path: ${file.destination}`);
        }

        const key=pathKey(file.destination);

        if(destinations.has(key)){
            fail(`Package destination collision: ${file.destination} from ${file.source} and ${destinations.get(key).source}.`);
        }

        destinations.set(key,file);
    }

    const expectedEntry=`apps/${config.id}/${config.entry}`;

    if(!destinations.has(pathKey(expectedEntry))){
        fail(`The configured entry file was not found in the package payload: ${expectedEntry}`);
    }

    return files.sort((left,right)=>compareText(left.destination,right.destination));
}

async function copyPackageFiles(files,outputRoot,{signal,onEvent}={}){
    let completedBytes=0;
    const buffer=Buffer.allocUnsafe(1024*1024);

    for(const [index,file] of files.entries()){
        throwIfAborted(signal);
        const destination=resolveInside(outputRoot,file.destination,'package destination');
        await mkdir(path.dirname(destination),{recursive:true});
        if(file.retainedBytes!==undefined){
            if(!Buffer.isBuffer(file.retainedBytes)||file.retainedBytes.length!==file.bytes){
                fail(`Retained shared payload bytes are invalid for ${file.destination}.`);
            }
            const output=await open(destination,'wx');
            let copiedBytes=0;
            try{
                throwIfAborted(signal);
                await output.writeFile(file.retainedBytes);
                copiedBytes=file.retainedBytes.length;
                const outputAfter=await output.stat({bigint:true});
                if(Number(outputAfter.size)!==copiedBytes){
                    fail(`Could not finish writing retained shared payload ${file.destination}.`);
                }
            }finally{
                await output.close().catch(()=>{});
            }
            completedBytes+=copiedBytes;
            await emitOperation(onEvent,{
                type:'package.copy.progress',
                current:index+1,
                total:files.length,
                completedBytes,
                path:file.destination
            });
            continue;
        }
        const source=await openStableRegularFile(file.source,file.label,file.identity);
        let output;
        let copiedBytes=0;
        try{
            output=await open(destination,'wx');
            while(true){
                throwIfAborted(signal);
                const {bytesRead}=await source.handle.read(buffer,0,buffer.length,null);
                if(bytesRead===0)break;
                let written=0;
                while(written<bytesRead){
                    const result=await output.write(buffer,written,bytesRead-written,null);
                    if(result.bytesWritten<=0)fail(`Could not finish writing ${file.destination}.`);
                    written+=result.bytesWritten;
                }
                copiedBytes+=bytesRead;
            }
            const [sourceAfter,outputAfter]=await Promise.all([
                source.handle.stat({bigint:true}),
                output.stat({bigint:true})
            ]);
            if(!identityMatches(sourceAfter,file.identity)||copiedBytes!==file.bytes
                ||Number(outputAfter.size)!==copiedBytes){
                fail(`${file.label} changed while ${file.destination} was being copied.`);
            }
        }finally{
            await output?.close().catch(()=>{});
            await source.handle.close().catch(()=>{});
        }
        completedBytes+=copiedBytes;
        await emitOperation(onEvent,{
            type:'package.copy.progress',
            current:index+1,
            total:files.length,
            completedBytes,
            path:file.destination
        });
    }
}

function escapeHtml(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;');
}

async function materializeBasePackage(context,outputRoot,files,{signal,onEvent}={}){
    throwIfAborted(signal);
    await mkdir(outputRoot,{recursive:true});
    await assertNoLinks(context.distRoot,outputRoot,'package staging root');
    await copyPackageFiles(files,outputRoot,{signal,onEvent});
    throwIfAborted(signal);
    const start=`./apps/${context.config.id}/${context.config.entry}`;
    const title=escapeHtml(context.config.displayName);
    await writeFile(
        path.join(outputRoot,'index.html'),
        [
            '<!doctype html>',
            '<meta charset="utf-8">',
            `<meta http-equiv="refresh" content="0; url=${escapeHtml(start)}">`,
            `<title>${title}</title>`,
            `<a href="${escapeHtml(start)}">Open ${title}</a>`,
            ''
        ].join('\n'),
        'utf8'
    );
}

async function sha256WithIdentity(filePath,{signal,expectedIdentity,label=filePath}={}){
    throwIfAborted(signal);
    const hash=createHash('sha256');
    const opened=await openStableRegularFile(filePath,label,expectedIdentity);
    const buffer=Buffer.allocUnsafe(1024*1024);

    try{
        while(true){
            throwIfAborted(signal);
            const {bytesRead}=await opened.handle.read(buffer,0,buffer.length,null);

            if(bytesRead===0){
                break;
            }

            hash.update(buffer.subarray(0,bytesRead));
        }
        const after=await opened.handle.stat({bigint:true});
        if(!identityMatches(after,opened.identity))fail(`${label} changed while it was being hashed.`);
    }finally{
        await opened.handle.close();
    }

    return {sha256:hash.digest('hex'),identity:opened.identity};
}

async function sha256(filePath,options={}){
    return (await sha256WithIdentity(filePath,options)).sha256;
}

async function listOutputFiles(root,{signal}={}){
    const files=[];

    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});

        for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
            throwIfAborted(signal);
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            const absolute=path.join(directory,entry.name);

            if(isAlwaysForbidden(relative)){
                fail(`Package contains a globally forbidden path: ${relative}`);
            }
            if(path.posix.basename(relative)===APP_CONFIG_NAME){
                fail(`Package contains authored configuration that must remain outside the browser payload: ${relative}`);
            }

            if(entry.isSymbolicLink()){
                fail(`Package contains a symbolic link or junction: ${relative}`);
            }

            if(entry.isDirectory()){
                await visit(absolute,relative);
            }else if(entry.isFile()){
                files.push({absolute,relative});
            }else{
                fail(`Package contains a non-file entry: ${relative}`);
            }
        }
    }

    await visit(root);
    return files.sort((left,right)=>compareText(left.relative,right.relative));
}

async function inventoryEntries(root,{signal,onEvent}={}){
    const files=(await listOutputFiles(root,{signal})).filter(file=>
        file.relative!==RELEASE_MANIFEST_NAME
    );
    const entries=[];
    const identities=[];

    let completedBytes=0;

    for(const [index,file] of files.entries()){
        throwIfAborted(signal);
        const verified=await sha256WithIdentity(file.absolute,{
            signal,
            label:`package file ${file.relative}`
        });
        entries.push({
            path:file.relative,
            bytes:verified.identity.bytes,
            sha256:verified.sha256
        });
        identities.push(Object.freeze({path:file.relative,...verified.identity}));
        completedBytes+=verified.identity.bytes;
        await emitOperation(onEvent,{
            type:'package.hash.progress',
            current:index+1,
            total:files.length,
            completedBytes,
            path:file.relative
        });
    }

    return {entries,identities};
}

async function assertArtifactState(root,identities,{signal}={}){
    throwIfAborted(signal);
    const requested=path.resolve(root);
    const rootBefore=await lstat(requested,{bigint:true});
    if(rootBefore.isSymbolicLink()||!rootBefore.isDirectory()){
        fail('App release root must be a real directory.');
    }
    const canonical=await realpath(requested);
    const actualPaths=(await listOutputFiles(canonical,{signal}))
        .map(file=>file.relative)
        .sort(compareText);
    const expectedPaths=identities.map(identity=>identity.path).sort(compareText);
    if(JSON.stringify(actualPaths)!==JSON.stringify(expectedPaths)){
        fail('App release inventory changed after verification.');
    }

    for(const identity of identities){
        throwIfAborted(signal);
        const filePath=resolveInside(canonical,identity.path,'verified app release path');
        const info=await lstat(filePath,{bigint:true});
        if(info.isSymbolicLink()||!info.isFile()||!identityMatches(info,identity)){
            fail(`App release file changed after verification: ${identity.path}`);
        }
    }
    const rootAfter=await lstat(canonical,{bigint:true});
    if(!rootAfter.isDirectory()||rootAfter.isSymbolicLink()
        ||!identityMatches(rootAfter,fileIdentity(rootBefore))){
        fail('App release root changed while its verification state was authenticated.');
    }
    return {canonical,rootIdentity:fileIdentity(rootAfter)};
}

function appReleasePackageBinding(config){
    if(!isPlainObject(config)){
        fail('App release package binding is missing.');
    }
    return immutableJsonCopy({
        schemaVersion:1,
        id:config.id,
        displayName:config.displayName,
        version:config.version,
        entry:config.entry,
        strategy:config.strategy,
        security:config.security,
        localAIModelPolicy:config.localAIModelPolicy??{verified_only:true,models:[]},
        include:[...(config.include??[])],
        exclude:[...(config.exclude??[])],
        shared:[...(config.shared??[])],
        adapter:config.adapter??null
    });
}

async function issueAppReleaseReceipt(root,release,identities,{
    signal,
    packageConfig,
    descriptorAuthority
}={}){
    const state=await assertArtifactState(root,identities,{signal});
    const packageBinding=appReleasePackageBinding(packageConfig);
    if(!descriptorAuthority?.descriptor
        ||!/^[a-f0-9]{64}$/u.test(descriptorAuthority.descriptorSha256)){
        fail('Canonical app descriptor authority is required to issue a release receipt.');
    }
    const receipt={
        schemaVersion:1,
        kind:'arcane-app-release-verification',
        generation:randomBytes(16).toString('hex'),
        canonicalLocation:state.canonical,
        builder:release.builder,
        app:immutableJsonCopy(release.app),
        policySha256:release.policySha256,
        files:immutableJsonCopy(release.files),
        fileCount:release.fileCount,
        totalBytes:release.totalBytes,
        contentSha256:release.contentSha256
    };
    Object.defineProperty(receipt,'identities',{
        value:Object.freeze([...identities]),
        enumerable:false,
        writable:false,
        configurable:false
    });
    Object.freeze(receipt);
    issuedAppReleaseReceipts.set(receipt,Object.freeze({
        canonicalLocation:state.canonical,
        rootIdentity:state.rootIdentity,
        identities:receipt.identities,
        packageBinding,
        descriptorAuthority:Object.freeze({
            descriptor:descriptorAuthority.descriptor,
            descriptorSha256:descriptorAuthority.descriptorSha256
        })
    }));
    return receipt;
}

async function authenticateAppReleaseReceiptState(receipt,{
    releaseRoot,
    expectedPackageConfig,
    signal
}={}){
    const state=issuedAppReleaseReceipts.get(receipt);
    if(!state)fail('App release receipt was not issued by this SDK process.');
    if(typeof releaseRoot!=='string'||!releaseRoot.trim())fail('releaseRoot is required to authenticate an app release receipt.');
    const requested=path.resolve(releaseRoot);
    const canonical=await realpath(requested);
    if(canonical!==state.canonicalLocation||receipt.canonicalLocation!==canonical){
        fail('App release receipt belongs to a different release location.');
    }
    const rootInfo=await lstat(canonical,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()
        ||!identityMatches(rootInfo,state.rootIdentity)){
        fail('App release root changed after its receipt was issued.');
    }
    if(expectedPackageConfig!==undefined
        &&JSON.stringify(appReleasePackageBinding(expectedPackageConfig))
            !==JSON.stringify(state.packageBinding)){
        fail('App release receipt belongs to a different authored package policy.');
    }
    await assertArtifactState(canonical,state.identities,{signal});
    return state;
}

export async function authenticateAppReleaseReceipt(receipt,options={}){
    await authenticateAppReleaseReceiptState(receipt,options);
    return receipt;
}

export async function authenticateAppReleaseAuthority(receipt,{
    releaseRoot,
    expectedPackageConfig,
    expectedDescriptor,
    signal
}={}){
    const state=await authenticateAppReleaseReceiptState(receipt,{
        releaseRoot,
        expectedPackageConfig,
        signal
    });
    const authority=state.descriptorAuthority;
    if(!authority?.descriptor||!/^[a-f0-9]{64}$/u.test(authority.descriptorSha256)){
        fail('App release receipt is missing its canonical descriptor authority.');
    }
    if(expectedDescriptor!==undefined){
        const contracts=await appDescriptorContracts();
        if(contracts.appDescriptorSha256(expectedDescriptor)!==authority.descriptorSha256){
            fail('App release receipt belongs to a different canonical app descriptor.');
        }
    }
    return Object.freeze({
        receipt,
        descriptor:authority.descriptor,
        descriptorSha256:authority.descriptorSha256
    });
}

export async function readVerifiedAppReleaseFile(receipt,{
    releaseRoot,
    relativePath,
    signal
}={}){
    throwIfAborted(signal);
    const state=issuedAppReleaseReceipts.get(receipt);
    if(!state)fail('App release receipt was not issued by this SDK process.');
    if(typeof releaseRoot!=='string'||!releaseRoot.trim()){
        fail('releaseRoot is required to read a verified app release file.');
    }
    const requested=path.resolve(releaseRoot);
    const canonical=await realpath(requested);
    if(canonical!==state.canonicalLocation||receipt.canonicalLocation!==canonical){
        fail('App release receipt belongs to a different release location.');
    }
    const rootInfo=await lstat(canonical,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()
        ||!identityMatches(rootInfo,state.rootIdentity)){
        fail('App release root changed after its receipt was issued.');
    }

    const normalized=normalizeRelativePath(relativePath,'verified app release path');
    const file=receipt.files.find(candidate=>pathKey(candidate.path)===pathKey(normalized));
    if(!file)fail(`Path is not in the verified app release inventory: ${normalized}.`);
    if(file.bytes>MAX_VERIFIED_APP_FILE_BYTES){
        fail(
            `Verified browser file exceeds the ${MAX_VERIFIED_APP_FILE_BYTES}-byte development serving limit: ${file.path}.`,
            'ARCANE_POLICY_DENIED'
        );
    }
    const identity=state.identities.find(candidate=>
        pathKey(candidate.path)===pathKey(file.path)
    );
    if(!identity)fail(`Verified app release identity is missing for ${file.path}.`);
    const filePath=resolveInside(canonical,file.path,'verified app release path');
    const opened=await openStableRegularFile(filePath,`verified app release file ${file.path}`,identity);
    try{
        throwIfAborted(signal);
        const bytes=await opened.handle.readFile();
        throwIfAborted(signal);
        const after=await opened.handle.stat({bigint:true});
        if(!identityMatches(after,opened.identity)||bytes.length!==file.bytes){
            fail(`Verified app release file changed while it was being read: ${file.path}.`);
        }
        const digest=createHash('sha256').update(bytes).digest('hex');
        if(digest!==file.sha256){
            fail(`Verified app release file hash changed: ${file.path}.`);
        }
        const current=await lstat(filePath,{bigint:true});
        if(current.isSymbolicLink()||!current.isFile()||!identityMatches(current,identity)){
            fail(`Verified app release path changed while it was being read: ${file.path}.`);
        }
        const canonicalFile=await realpath(filePath);
        if(!isInside(canonical,canonicalFile)){
            fail(`Verified app release path left its release root: ${file.path}.`);
        }
        return bytes;
    }finally{
        await opened.handle.close();
    }
}

function normalizedRoutePolicy(route){
    return {
        source:route.source,
        destination:route.destination,
        include:[...route.include].sort(compareText),
        exclude:[...route.exclude].sort(compareText)
    };
}

async function packagePolicySha256(context,{signal}={}){
    throwIfAborted(signal);
    const {config,rootConfig,appRoot}=context;
    let adapter=null;

    if(config.adapter){
        const adapterPath=resolveInside(appRoot,config.adapter,`${config.id} adapter`);
        await assertNoLinks(appRoot,adapterPath,`${config.id} adapter`);
        adapter={
            path:config.adapter,
            sha256:await sha256(adapterPath,{signal})
        };
    }

    const shared=[...config.shared]
        .sort(compareText)
        .map(id=>({
            id,
            routes:rootConfig.sharedPayloads[id]
                .map(normalizedRoutePolicy)
                .sort((left,right)=>compareText(JSON.stringify(left),JSON.stringify(right)))
        }));
    const policy={
        strategy:config.strategy,
        security:config.security,
        localAIModelPolicy:{...config.localAIModelPolicy},
        include:[...config.include].sort(compareText),
        exclude:[...config.exclude].sort(compareText),
        shared,
        adapter
    };

    return createHash('sha256')
        .update(JSON.stringify(policy))
        .digest('hex');
}

async function writeReleaseManifest(root,context,version,{signal,onEvent}={}){
    const {config}=context;
    const inventory=await inventoryEntries(root,{signal,onEvent});
    const files=inventory.entries;
    const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
    const contentSha256=createHash('sha256')
        .update(JSON.stringify(files))
        .digest('hex');
    const release={
        schemaVersion:1,
        builder:PACKAGER_VERSION,
        app:{
            id:config.id,
            displayName:config.displayName,
            version,
            entry:config.entry,
            start:`./apps/${config.id}/${config.entry}`,
            security:config.security,
            localAIModelPolicy:{...config.localAIModelPolicy}
        },
        policySha256:await packagePolicySha256(context,{signal}),
        fileCount:files.length,
        totalBytes,
        contentSha256,
        files
    };

    const manifestPath=path.join(root,RELEASE_MANIFEST_NAME);
    await writeFile(
        manifestPath,
        `${JSON.stringify(release,null,2)}\n`,
        {encoding:'utf8',flag:'wx'}
    );
    const manifest=await openStableRegularFile(manifestPath,RELEASE_MANIFEST_NAME);
    await manifest.handle.close();
    return {
        release,
        identities:Object.freeze([
            ...inventory.identities,
            Object.freeze({path:RELEASE_MANIFEST_NAME,...manifest.identity})
        ])
    };
}

function expectedReleaseApp(context,version){
    const {config}=context;
    return {
        id:config.id,
        displayName:config.displayName,
        version,
        entry:config.entry,
        start:`./apps/${config.id}/${config.entry}`,
        security:config.security,
        localAIModelPolicy:{...config.localAIModelPolicy}
    };
}

async function verifyFreshStaticRelease(root,context,version,releaseState,{signal}={}){
    throwIfAborted(signal);
    const {config}=context;
    const expectedApp=expectedReleaseApp(context,version);
    const release=releaseState.release;

    if(release?.schemaVersion!==1||release?.builder!==PACKAGER_VERSION
        ||JSON.stringify(release?.app)!==JSON.stringify(expectedApp)
        ||!Array.isArray(release?.files)
        ||release.fileCount!==release.files.length){
        fail(`${config.id}/${RELEASE_MANIFEST_NAME} identity is invalid.`);
    }

    // This staging tree is owned by this operation and no adapter has run. The
    // release inventory was produced from the final bytes immediately before
    // this check, so reuse that receipt instead of hashing every file twice.
    const rootIndex=path.join(root,'index.html');
    const entry=resolveInside(root,expectedApp.start.slice(2),'package entry');
    const [indexInfo,entryInfo,manifestInfo]=await Promise.all([
        lstat(rootIndex),
        lstat(entry),
        lstat(path.join(root,RELEASE_MANIFEST_NAME))
    ]);

    if(!indexInfo.isFile()||indexInfo.isSymbolicLink()
        ||!entryInfo.isFile()||entryInfo.isSymbolicLink()
        ||!manifestInfo.isFile()||manifestInfo.isSymbolicLink()){
        fail(`Package entry files for ${config.id} are invalid.`);
    }

    return releaseState;
}

async function verifyGenericRelease(root,context,version,{signal,onEvent}={}){
    const {config}=context;
    const manifestDocument=await readJsonDocument(
        path.join(root,RELEASE_MANIFEST_NAME),
        `${config.id}/${RELEASE_MANIFEST_NAME}`
    );
    const release=manifestDocument.value;
    const expectedApp=expectedReleaseApp(context,version);

    if(release?.schemaVersion!==1||release?.builder!==PACKAGER_VERSION
        ||JSON.stringify(release?.app)!==JSON.stringify(expectedApp)
        ||release?.policySha256!==await packagePolicySha256(context,{signal})
        ||!Array.isArray(release?.files)){
        fail(`${config.id}/${RELEASE_MANIFEST_NAME} identity is invalid.`);
    }

    const inventory=await inventoryEntries(root,{signal,onEvent});
    const actualFiles=inventory.entries;
    const totalBytes=actualFiles.reduce((total,file)=>total+file.bytes,0);
    const contentSha256=createHash('sha256')
        .update(JSON.stringify(actualFiles))
        .digest('hex');

    if(release.fileCount!==actualFiles.length
        ||release.totalBytes!==totalBytes
        ||release.contentSha256!==contentSha256
        ||JSON.stringify(release.files)!==JSON.stringify(actualFiles)){
        fail(`${config.id}/${RELEASE_MANIFEST_NAME} does not match the package tree.`);
    }

    const rootIndex=path.join(root,'index.html');
    const entry=resolveInside(root,expectedApp.start.slice(2),'package entry');
    const [indexInfo,entryInfo]=await Promise.all([lstat(rootIndex),lstat(entry)]);

    if(!indexInfo.isFile()||indexInfo.isSymbolicLink()
        ||!entryInfo.isFile()||entryInfo.isSymbolicLink()){
        fail(`Package entry files for ${config.id} are invalid.`);
    }

    return {
        release,
        identities:Object.freeze([
            ...inventory.identities,
            Object.freeze({path:RELEASE_MANIFEST_NAME,...manifestDocument.identity})
        ])
    };
}

async function loadAdapter(context){
    if(context.config.strategy!=='adapter'){
        return null;
    }

    const adapterPath=resolveInside(
        context.appRoot,
        context.config.adapter,
        `${context.config.id} adapter`
    );
    await assertNoLinks(context.appRoot,adapterPath,`${context.config.id} adapter`);
    const details=await stat(adapterPath);

    if(!details.isFile()){
        fail(`${context.config.id} adapter is not a regular file.`);
    }

    const adapterBytes=await readFile(adapterPath);

    if(adapterBytes.includes(0x0d)){
        fail(`${context.config.id} adapter must use canonical LF line endings.`);
    }

    const module=await import(`${pathToFileURL(adapterPath).href}?mtime=${details.mtimeMs}`);

    if(typeof module.buildArcanePackage!=='function'
        ||typeof module.verifyArcanePackage!=='function'){
        fail(`${context.config.id} adapter must export buildArcanePackage and verifyArcanePackage.`);
    }

    return module;
}

async function verifyBuiltPackage(context,outputRoot,version,adapter,{signal,onEvent}={}){
    throwIfAborted(signal);
    if(adapter){
        await adapter.verifyArcanePackage({
            workspaceRoot:context.workspaceRoot,
            appRoot:context.appRoot,
            outputRoot,
            config:context.config,
            version,
            signal,
            onEvent
        });
    }

    return verifyGenericRelease(outputRoot,context,version,{signal,onEvent});
}

async function writeAppVersion(context,version){
    parseSemver(version);
    const raw=await readJson(context.config.configPath,context.config.configPath);
    raw.version=version;
    const temporary=`${context.config.configPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const backup=`${context.config.configPath}.bak-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(temporary,`${JSON.stringify(raw,null,2)}\n`,'utf8');

    let originalMoved=false;
    let replacementInstalled=false;

    try{
        await rename(context.config.configPath,backup);
        originalMoved=true;
        await rename(temporary,context.config.configPath);
        replacementInstalled=true;
    }catch(error){
        await rm(temporary,{force:true});

        if(originalMoved&&!replacementInstalled){
            try{
                await rename(backup,context.config.configPath);
            }catch{
                // Preserve the original error; the backup path remains recoverable.
            }
        }

        throw error;
    }

    await rm(backup,{force:true}).catch(()=>{});
}

function resolveTargetVersion(current,{bump,exactVersion,preid}={}){
    if(bump&&exactVersion){
        fail('Choose either a semantic version bump or an exact version, not both.');
    }

    if(exactVersion!==undefined){
        parseSemver(exactVersion);

        if(exactVersion===current){
            fail(`Version is already ${current}.`);
        }

        return exactVersion;
    }

    return bump?incrementSemver(current,bump,preid):current;
}

async function acquirePackageLock(distRoot,appId){
    const lockPath=path.join(distRoot,`.arcane-packager-${appId}.lock`);
    let handle;

    try{
        handle=await open(lockPath,'wx');
        await handle.writeFile(`${JSON.stringify({pid:process.pid,app:appId})}\n`,'utf8');
    }catch(error){
        if(handle){
            await handle.close().catch(()=>{});
            await rm(lockPath,{force:true}).catch(()=>{});
        }

        if(error?.code==='EEXIST'){
            fail(`Another package operation for ${appId} is already running. If no process is active, remove the stale lock at ${lockPath}.`);
        }

        throw error;
    }

    let released=false;

    return async()=>{
        if(released){
            return;
        }

        released=true;
        const cleanupErrors=[];

        try{
            await handle.close();
        }catch(error){
            cleanupErrors.push(`close failed: ${error.message}`);
        }

        try{
            await rm(lockPath,{force:true});
        }catch(error){
            cleanupErrors.push(`remove failed: ${error.message}`);
        }

        if(cleanupErrors.length){
            console.error(
                `Arcane packager completed but could not fully clean ${lockPath} (${cleanupErrors.join('; ')}). Remove the stale lock before the next operation.`
            );
        }
    };
}

async function acquireOperationLock(workspaceRoot,appId){
    const resolvedWorkspace=normalizeWorkspaceRoot(workspaceRoot);

    if(typeof appId!=='string'||!APP_ID_PATTERN.test(appId)){
        fail(`Invalid app id: ${String(appId)}`);
    }

    const rootConfig=await loadRootConfig(resolvedWorkspace);
    const distRoot=path.join(resolvedWorkspace,rootConfig.distRoot);
    await assertSafeDistBoundary(resolvedWorkspace,distRoot,{create:true});
    return acquirePackageLock(distRoot,appId);
}

async function readDistVersion(outputRoot){
    try{
        const release=await readJson(path.join(outputRoot,RELEASE_MANIFEST_NAME));
        return typeof release?.app?.version==='string'?release.app.version:null;
    }catch{
        return null;
    }
}

export async function discoverApps({workspaceRoot:requestedWorkspaceRoot}){
    const workspaceRoot=normalizeWorkspaceRoot(requestedWorkspaceRoot);
    const rootConfig=await loadRootConfig(workspaceRoot);
    const appsRoot=path.join(workspaceRoot,rootConfig.appsRoot);
    const entries=await readdir(appsRoot,{withFileTypes:true});
    const apps=[];

    for(const entry of entries.sort((left,right)=>compareText(left.name,right.name))){
        if(!APP_ID_PATTERN.test(entry.name)||(entry.isFile()&&!entry.isSymbolicLink())){
            continue;
        }

        if(entry.isSymbolicLink()){
            apps.push({
                id:entry.name,
                displayName:entry.name,
                configured:false,
                status:'unsafe-link',
                version:null,
                distVersion:null
            });
            continue;
        }

        if(!entry.isDirectory()){
            continue;
        }

        const configPath=path.join(appsRoot,entry.name,APP_CONFIG_NAME);

        try{
            const context=await getAppContext({workspaceRoot,appId:entry.name});
            apps.push({
                id:entry.name,
                displayName:context.config.displayName,
                configured:true,
                status:'ready',
                version:context.config.version,
                distVersion:await readDistVersion(context.outputRoot),
                strategy:context.config.strategy,
                entry:context.config.entry,
                output:path.relative(workspaceRoot,context.outputRoot).replaceAll('\\','/')
            });
        }catch(error){
            let configured=true;

            try{
                await lstat(configPath);
            }catch{
                configured=false;
            }

            let displayName=entry.name;

            try{
                const manifest=await readJson(path.join(appsRoot,entry.name,'manifest.json'));
                if(typeof manifest?.name==='string'&&manifest.name.trim()){
                    displayName=manifest.name.trim();
                }
            }catch{
                // An unconfigured app can still be listed without a PWA manifest.
            }

            apps.push({
                id:entry.name,
                displayName,
                configured,
                status:configured?'invalid':'unconfigured',
                version:null,
                distVersion:null,
                error:configured?error.message:undefined
            });
        }
    }

    return apps;
}

export async function inspectApp({workspaceRoot,appId}){
    const context=await getAppContext({workspaceRoot,appId});
    const files=await collectPackageFiles(context);
    const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
    const largestFiles=[...files]
        .sort((left,right)=>right.bytes-left.bytes||compareText(left.destination,right.destination))
        .slice(0,10)
        .map(file=>({path:file.destination,bytes:file.bytes}));

    return {
        id:context.config.id,
        displayName:context.config.displayName,
        version:context.config.version,
        distVersion:await readDistVersion(context.outputRoot),
        strategy:context.config.strategy,
        entry:context.config.entry,
        output:path.relative(context.workspaceRoot,context.outputRoot).replaceAll('\\','/'),
        include:[...context.config.include],
        exclude:[...context.config.exclude],
        shared:[...context.config.shared],
        adapter:context.config.adapter,
        baseFileCount:files.length,
        baseBytes:totalBytes,
        largestFiles,
        note:context.config.strategy==='adapter'
            ?'Counts cover the static base; the adapter can add generated public files.'
            :undefined
    };
}

async function packageAppUnlocked({
    workspaceRoot,
    appId,
    bump,
    preid,
    exactVersion,
    dryRun=false,
    context:preparedContext,
    sharedPayloadSnapshot,
    authenticatedSharedPayloadState,
    signal,
    onEvent,
    validateSourceState
}){
    throwIfAborted(signal);
    if(validateSourceState!==undefined&&typeof validateSourceState!=='function'){
        fail('validateSourceState must be a function when provided.');
    }
    const context=preparedContext??await getAppContext({
        workspaceRoot,
        appId,
        bindDescriptorAuthority:true,
        signal
    });
    const currentVersion=context.config.version;
    const version=resolveTargetVersion(currentVersion,{bump,exactVersion,preid});
    const files=await collectPackageFiles(context,{
        signal,
        sharedPayloadState:authenticatedSharedPayloadState
    });
    const preview={
        app:appId,
        currentVersion,
        version,
        bump:bump??null,
        dryRun:Boolean(dryRun),
        output:path.relative(context.workspaceRoot,context.outputRoot).replaceAll('\\','/'),
        baseFileCount:files.length,
        baseBytes:files.reduce((total,file)=>total+file.bytes,0),
        strategy:context.config.strategy
    };

    if(dryRun){
        throwIfAborted(signal);
        return preview;
    }

    const token=`${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
    const staging=resolveInside(context.distRoot,`.arcane-packager-${appId}-${token}`,'staging output');
    const stagingTemporary=`${staging}.tmp`;
    const backup=resolveInside(context.distRoot,`.arcane-packager-${appId}-backup-${token}`,'backup output');
    const failedOutput=resolveInside(context.distRoot,`.arcane-packager-${appId}-failed-${token}`,'failed output');
    let adapter=null;
    let movedExisting=false;
    let promoted=false;
    let operationSucceeded=false;
    let rollbackRestored=false;

    try{
        await rm(staging,{recursive:true,force:true});
        await rm(stagingTemporary,{recursive:true,force:true});
        await rm(backup,{recursive:true,force:true}).catch(()=>{});
        await rm(failedOutput,{recursive:true,force:true}).catch(()=>{});
        adapter=await loadAdapter(context);
        throwIfAborted(signal);

        if(adapter){
            let prepared=false;
            await adapter.buildArcanePackage({
                workspaceRoot:context.workspaceRoot,
                appRoot:context.appRoot,
                outputRoot:staging,
                config:context.config,
                version,
                signal,
                onEvent,
                deferFinalVerification:true,
                prepareBase:async outputRoot=>{
                    if(prepared){
                        fail(`${appId} adapter requested its base payload more than once.`);
                    }

                    prepared=true;
                    const requestedRoot=path.resolve(outputRoot);

                    if(requestedRoot!==path.resolve(staging)
                        &&requestedRoot!==path.resolve(stagingTemporary)){
                        fail(`${appId} adapter requested its base payload outside its assigned staging roots.`);
                    }

                    await materializeBasePackage(context,outputRoot,files,{signal,onEvent});
                }
            });

            if(!prepared){
                fail(`${appId} adapter did not materialize the configured public base payload.`);
            }
        }else{
            await materializeBasePackage(context,staging,files,{signal,onEvent});
        }

        throwIfAborted(signal);
        const releaseState=await writeReleaseManifest(staging,context,version,{signal,onEvent});
        const verifiedRelease=adapter
            ?await verifyBuiltPackage(context,staging,version,adapter,{signal,onEvent})
            :await verifyFreshStaticRelease(staging,context,version,releaseState,{signal});

        throwIfAborted(signal);
        if(validateSourceState){
            const validation=await validateSourceState({signal});
            await assertValidatedDescriptorAuthority(validation,context.descriptorAuthority);
        }
        await assertAppDescriptorAuthorityCurrent(context,{signal});
        if(sharedPayloadSnapshot!==undefined){
            await authenticateSharedPayloadSnapshotState(sharedPayloadSnapshot,{
                workspaceRoot:context.workspaceRoot,
                sharedPayloadIds:context.config.shared,
                signal
            });
        }
        await assertArtifactState(staging,verifiedRelease.identities,{signal});
        throwIfAborted(signal);

        try{
            await lstat(context.outputRoot);
            await renamePackageDirectory(context.outputRoot,backup);
            movedExisting=true;
        }catch(error){
            if(error?.code!=='ENOENT'){
                throw error;
            }
        }

        throwIfAborted(signal);
        await renamePackageDirectory(staging,context.outputRoot);
        promoted=true;

        throwIfAborted(signal);
        const receipt=await issueAppReleaseReceipt(
            context.outputRoot,
            verifiedRelease.release,
            verifiedRelease.identities,
            {
                signal,
                packageConfig:{...context.config,version},
                descriptorAuthority:context.descriptorAuthority
            }
        );

        if(version!==currentVersion){
            await writeAppVersion(context,version);
        }

        operationSucceeded=true;
        return {
            ...preview,
            dryRun:false,
            fileCount:verifiedRelease.release.fileCount,
            totalBytes:verifiedRelease.release.totalBytes,
            contentSha256:verifiedRelease.release.contentSha256,
            receipt
        };
    }catch(error){
        const rollbackErrors=[];
        let targetVacated=!promoted;

        if(promoted){
            try{
                await renamePackageDirectory(context.outputRoot,failedOutput);
                targetVacated=true;
            }catch(moveError){
                targetVacated=false;
                rollbackErrors.push(`could not move the failed package aside: ${moveError.message}`);
            }
        }

        if(movedExisting&&targetVacated){
            try{
                await renamePackageDirectory(backup,context.outputRoot);
                rollbackRestored=true;
            }catch(restoreError){
                rollbackErrors.push(`could not restore the previous package from ${backup}: ${restoreError.message}`);
            }
        }

        if(rollbackErrors.length){
            error.message+=` Rollback warning: ${rollbackErrors.join('; ')}. Preserve ${backup} until manually recovered.`;
        }

        throw error;
    }finally{
        await rm(staging,{recursive:true,force:true}).catch(()=>{});
        await rm(stagingTemporary,{recursive:true,force:true}).catch(()=>{});
        await rm(failedOutput,{recursive:true,force:true}).catch(()=>{});

        if(operationSucceeded||rollbackRestored||!movedExisting){
            await rm(backup,{recursive:true,force:true}).catch(()=>{});
        }
    }
}

export async function packageApp(options){
    throwIfAborted(options?.signal);
    const context=await getAppContext({
        workspaceRoot:options?.workspaceRoot,
        appId:options?.appId,
        bindDescriptorAuthority:true,
        signal:options?.signal
    });
    throwIfAborted(options?.signal);
    const authenticatedSharedPayloadState=options?.sharedPayloadSnapshot===undefined
        ?null
        :await authenticateSharedPayloadSnapshotState(options.sharedPayloadSnapshot,{
            workspaceRoot:context.workspaceRoot,
            sharedPayloadIds:context.config.shared,
            signal:options?.signal
        });
    if(options?.dryRun){
        return packageAppUnlocked({...options,context,authenticatedSharedPayloadState});
    }

    await assertSafeDistBoundary(context.workspaceRoot,context.distRoot,{create:true});
    const releaseLock=await acquirePackageLock(context.distRoot,options?.appId);

    try{
        return await packageAppUnlocked({...options,context,authenticatedSharedPayloadState});
    }finally{
        await releaseLock();
    }
}

export async function verifyApp({workspaceRoot,appId,signal,onEvent}){
    throwIfAborted(signal);
    const context=await getAppContext({
        workspaceRoot,
        appId,
        bindDescriptorAuthority:true,
        signal
    });
    const adapter=await loadAdapter(context);
    const releaseState=await verifyBuiltPackage(
        context,
        context.outputRoot,
        context.config.version,
        adapter,
        {signal,onEvent}
    );
    const release=releaseState.release;
    const receipt=await issueAppReleaseReceipt(
        context.outputRoot,
        release,
        releaseState.identities,
        {
            signal,
            packageConfig:context.config,
            descriptorAuthority:context.descriptorAuthority
        }
    );

    return {
        app:appId,
        // The verified manifest is already bound to this exact configured
        // version; do not couple the public verify result to a nested app
        // representation used by a particular schema generation.
        version:context.config.version,
        output:path.relative(context.workspaceRoot,context.outputRoot).replaceAll('\\','/'),
        fileCount:release.fileCount,
        totalBytes:release.totalBytes,
        contentSha256:release.contentSha256,
        verified:true,
        receipt
    };
}

async function bumpVersionUnlocked({
    workspaceRoot,
    appId,
    bump,
    preid,
    exactVersion,
    dryRun=false
}){
    const context=await getAppContext({workspaceRoot,appId});
    const currentVersion=context.config.version;
    const version=resolveTargetVersion(currentVersion,{bump,exactVersion,preid});

    if(version===currentVersion){
        fail('A bump level or exact version is required.');
    }

    if(!dryRun){
        await writeAppVersion(context,version);
    }

    return {
        app:appId,
        currentVersion,
        version,
        bump:bump??null,
        dryRun:Boolean(dryRun)
    };
}

export async function bumpVersion(options){
    if(options?.dryRun){
        return bumpVersionUnlocked(options);
    }

    await getAppContext({
        workspaceRoot:options?.workspaceRoot,
        appId:options?.appId
    });
    const releaseLock=await acquireOperationLock(
        options?.workspaceRoot,
        options?.appId
    );

    try{
        return await bumpVersionUnlocked(options);
    }finally{
        await releaseLock();
    }
}
