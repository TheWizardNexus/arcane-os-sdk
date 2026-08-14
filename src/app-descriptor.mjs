import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';
import {
    ARCANE_MACHINE_BUNDLE_VERSION,
    ARCANE_PROTOCOL,
    TARGET_IDS
} from './constants.mjs';
import {
    normalizeRelativePath,
    parseSemver,
    validateAppConfig as validateAppPackageConfig
} from './packager/core.mjs';

export const APP_DESCRIPTOR_NAME='arcane-app.json';
export const APP_DESCRIPTOR_SCHEMA_VERSION=2;

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const CAPABILITY_PATTERN=/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u;
const METHOD_PATTERN=/^[a-z][a-z0-9]*(?:\.[a-z][a-zA-Z0-9]*)+$/u;
const FEATURE_PATTERN=/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const PUBLISHER_PATTERN=/^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const NATIVE_TYPES=new Set(['app']);
const SAFE_ICON_EXTENSIONS=new Set(['.ico','.jpeg','.jpg','.png','.webp']);
const REGISTRY_PATH=path.join(
    'machine_bundles',
    'arcane-os-machine-bundle',
    'arcane-apps.json'
);

function fail(message){
    const error=new Error(message);
    error.code='ARCANE_APP_DESCRIPTOR_INVALID';
    throw error;
}

function isObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function assertOnlyKeys(value,allowed,label){
    if(!isObject(value))fail(`${label} must be an object.`);
    for(const key of Object.keys(value)){
        if(!allowed.has(key))fail(`${label} contains an unsupported key: ${key}.`);
    }
}

function safeText(value,label,{maximum=500}={}){
    if(typeof value!=='string'||value!==value.trim()||!value||value.length>maximum
        ||/[<>\u0000-\u001f\u007f]/u.test(value)){
        fail(`${label} must be nonempty, trimmed, bounded presentation text.`);
    }
    return value;
}

function uniqueSortedStrings(value,label,{pattern,maximum=256,required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)||value.length>maximum){
        fail(`${label} must be ${required?'a nonempty':'an'} array with at most ${maximum} entries.`);
    }
    const normalized=value.map((entry,index)=>{
        if(typeof entry!=='string'||entry!==entry.trim()||!entry
            ||(pattern&&!pattern.test(entry))){
            fail(`${label}[${index}] is invalid.`);
        }
        return entry;
    });
    if(new Set(normalized).size!==normalized.length)fail(`${label} must not contain duplicates.`);
    if(JSON.stringify(normalized)!==JSON.stringify([...normalized].sort())){
        fail(`${label} must be sorted for deterministic projection.`);
    }
    return Object.freeze(normalized);
}

function relativePaths(value,label,{required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)||value.length>512){
        fail(`${label} must be ${required?'a nonempty':'an'} array with at most 512 entries.`);
    }
    const normalized=value.map((entry,index)=>normalizeRelativePath(entry,`${label}[${index}]`));
    if(new Set(normalized.map(entry=>entry.toLocaleLowerCase('en-US'))).size!==normalized.length){
        fail(`${label} must not contain duplicate paths.`);
    }
    return Object.freeze(normalized);
}

function validateOrigins(value,label,{allowLoopbackHttp=false,allowHttpsScheme=false}={}){
    if(!Array.isArray(value)||value.length>16)fail(`${label} must be an array with at most 16 origins.`);
    const origins=value.map((origin,index)=>{
        if(typeof origin!=='string'||origin!==origin.trim())fail(`${label}[${index}] is invalid.`);
        if(origin==='https:'&&allowHttpsScheme)return origin;
        let parsed;
        try{parsed=new URL(origin);}
        catch{fail(`${label}[${index}] is not a valid URL origin.`);}
        if(parsed.origin!==origin||parsed.username||parsed.password
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
    if(JSON.stringify(origins)!==JSON.stringify([...origins].sort())){
        fail(`${label} must be sorted for deterministic projection.`);
    }
    return Object.freeze(origins);
}

function validateLocalAIModelPolicy(value,label){
    if(value===undefined)return undefined;
    assertOnlyKeys(value,new Set(['verified_only','models']),label);
    if(typeof value.verified_only!=='boolean'||!Array.isArray(value.models)||value.models.length>64){
        fail(`${label} is invalid.`);
    }
    const models=value.models.map((model,index)=>{
        const itemLabel=`${label}.models[${index}]`;
        assertOnlyKeys(model,new Set(['name','definition']),itemLabel);
        if(typeof model.name!=='string'||!model.name||model.name.length>256
            ||typeof model.definition!=='string'||!model.definition.endsWith('Modelfile')){
            fail(`${itemLabel} is invalid.`);
        }
        return Object.freeze({name:model.name,definition:normalizeRelativePath(model.definition,`${itemLabel}.definition`)});
    });
    return Object.freeze({verified_only:value.verified_only,models:Object.freeze(models)});
}

function validatePackage(value,appId){
    assertOnlyKeys(value,new Set([
        'entry','strategy','include','exclude','shared','adapter','localAIModelPolicy'
    ]),'descriptor.package');
    const entry=normalizeRelativePath(value.entry,'descriptor.package.entry');
    if(!['static','adapter'].includes(value.strategy))fail('descriptor.package.strategy must be static or adapter.');
    const include=relativePaths(value.include,'descriptor.package.include',{required:true});
    const exclude=relativePaths(value.exclude??[],'descriptor.package.exclude');
    if(!include.some(candidate=>entry===candidate||entry.startsWith(`${candidate}/`))){
        fail('descriptor.package.entry must be covered by descriptor.package.include.');
    }
    const shared=uniqueSortedStrings(value.shared,'descriptor.package.shared',{
        pattern:/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u,
        maximum:64,
        required:true
    });
    let adapter;
    if(value.strategy==='adapter'){
        adapter=normalizeRelativePath(value.adapter,'descriptor.package.adapter');
        if(!/^scripts\/[A-Za-z0-9._/-]+\.mjs$/u.test(adapter)){
            fail('descriptor.package.adapter must be an app-local scripts/*.mjs path.');
        }
    }else if(value.adapter!==undefined){
        fail('descriptor.package.adapter is only valid for adapter packages.');
    }
    return Object.freeze({
        entry,
        strategy:value.strategy,
        include,
        exclude,
        shared,
        ...(adapter?{adapter}:{}),
        ...(value.localAIModelPolicy===undefined?{}:{
            localAIModelPolicy:validateLocalAIModelPolicy(
                value.localAIModelPolicy,
                `descriptor ${appId} localAIModelPolicy`
            )
        })
    });
}

function validatePublisher(value){
    assertOnlyKeys(value,new Set(['id','name']),'descriptor.publisher');
    if(typeof value.id!=='string'||!PUBLISHER_PATTERN.test(value.id)){
        fail('descriptor.publisher.id must be a lowercase publisher identifier.');
    }
    return Object.freeze({id:value.id,name:safeText(value.name,'descriptor.publisher.name',{maximum:160})});
}

function validatePermissions(value){
    assertOnlyKeys(value,new Set(['capabilities','methods']),'descriptor.permissions');
    const capabilities=uniqueSortedStrings(value.capabilities,'descriptor.permissions.capabilities',{
            pattern:CAPABILITY_PATTERN,
            maximum:256
        });
    if(capabilities.includes('external.open')&&capabilities.includes('web.embed')){
        fail('descriptor.permissions.capabilities must not combine external.open with web.embed.');
    }
    return Object.freeze({
        capabilities,
        methods:uniqueSortedStrings(value.methods,'descriptor.permissions.methods',{
            pattern:METHOD_PATTERN,
            maximum:512
        })
    });
}

function validateSecurity(value,{appId,capabilities}){
    assertOnlyKeys(value,new Set(['connectOrigins','frameOrigins','mediaOrigins']),'descriptor.security');
    const frameOrigins=validateOrigins(
        value.frameOrigins,
        'descriptor.security.frameOrigins',
        {allowHttpsScheme:appId==='browser'}
    );
    if(frameOrigins.length&&!capabilities.includes('web.embed')){
        fail('descriptor.security.frameOrigins requires the web.embed capability.');
    }
    return Object.freeze({
        connectOrigins:validateOrigins(
            value.connectOrigins,
            'descriptor.security.connectOrigins',
            {allowLoopbackHttp:true}
        ),
        frameOrigins,
        mediaOrigins:validateOrigins(value.mediaOrigins,'descriptor.security.mediaOrigins')
    });
}

function validateDocumentCatalog(value){
    if(value===undefined)return undefined;
    const label='descriptor.native.documentCatalog';
    if(value.policy==='empty-unpublished'){
        assertOnlyKeys(value,new Set(['policy','destination','manifest']),label);
        const manifest=normalizeRelativePath(value.manifest,`${label}.manifest`);
        if(manifest.includes('/')||path.posix.extname(manifest).toLowerCase()!=='.json'){
            fail(`${label}.manifest must be a JSON filename.`);
        }
        return Object.freeze({
            policy:value.policy,
            destination:normalizeRelativePath(value.destination,`${label}.destination`),
            manifest
        });
    }
    assertOnlyKeys(value,new Set([
        'policy','release','destination','originals','manifest','expectedCount'
    ]),label);
    if(value.policy!=='public-only'||!Number.isInteger(value.expectedCount)
        ||value.expectedCount<1||value.expectedCount>512){
        fail(`${label} has unsupported policy or expectedCount.`);
    }
    const destination=normalizeRelativePath(value.destination,`${label}.destination`);
    const originals=normalizeRelativePath(value.originals,`${label}.originals`);
    const manifest=normalizeRelativePath(value.manifest,`${label}.manifest`);
    if(manifest.includes('/')||path.posix.extname(manifest).toLowerCase()!=='.json'){
        fail(`${label}.manifest must be a JSON filename.`);
    }
    if(destination===originals||destination.startsWith(`${originals}/`)
        ||originals.startsWith(`${destination}/`)){
        fail(`${label}.destination and originals must not overlap.`);
    }
    return Object.freeze({
        policy:value.policy,
        release:normalizeRelativePath(value.release,`${label}.release`),
        destination,
        originals,
        manifest,
        expectedCount:value.expectedCount
    });
}

function validateNative(value,appId){
    assertOnlyKeys(value,new Set(['type','icon','order','bundledApps','documentCatalog']),'descriptor.native');
    if(!NATIVE_TYPES.has(value.type))fail('descriptor.native.type is unsupported.');
    const icon=value.icon===null?null:normalizeRelativePath(value.icon,'descriptor.native.icon');
    if(icon&&(!SAFE_ICON_EXTENSIONS.has(path.posix.extname(icon).toLowerCase())||icon.length>160)){
        fail('descriptor.native.icon must identify a bounded safe raster image or icon file.');
    }
    if(!Number.isInteger(value.order)||value.order<0||value.order>10000){
        fail('descriptor.native.order must be an integer from 0 through 10000.');
    }
    const bundledApps=uniqueSortedStrings(value.bundledApps,'descriptor.native.bundledApps',{
        pattern:APP_ID_PATTERN,
        maximum:16
    });
    if(bundledApps.includes(appId))fail('descriptor.native.bundledApps must not include the app itself.');
    const documentCatalog=validateDocumentCatalog(value.documentCatalog);
    return Object.freeze({
        type:value.type,
        icon,
        order:value.order,
        bundledApps,
        ...(documentCatalog?{documentCatalog}:{})
    });
}

function validateRequirements(value){
    assertOnlyKeys(value,new Set(['arcaneProtocol','minimumCoreVersion','features']),'descriptor.requirements');
    if(value.arcaneProtocol!==ARCANE_PROTOCOL)fail(`descriptor.requirements.arcaneProtocol must be ${ARCANE_PROTOCOL}.`);
    parseSemver(value.minimumCoreVersion);
    return Object.freeze({
        arcaneProtocol:value.arcaneProtocol,
        minimumCoreVersion:value.minimumCoreVersion,
        features:uniqueSortedStrings(value.features,'descriptor.requirements.features',{
            pattern:FEATURE_PATTERN,
            maximum:128
        })
    });
}

export function validateAppDescriptor(value,{appId}={}){
    assertOnlyKeys(value,new Set([
        'schemaVersion','id','displayName','description','version','publisher','package',
        'permissions','security','native','requirements','targets'
    ]),'Arcane app descriptor');
    if(value.schemaVersion!==APP_DESCRIPTOR_SCHEMA_VERSION){
        fail(`Arcane app descriptor schemaVersion must be ${APP_DESCRIPTOR_SCHEMA_VERSION}.`);
    }
    if(!APP_ID_PATTERN.test(value.id)||(appId&&value.id!==appId)){
        fail('Arcane app descriptor id must match its apps directory.');
    }
    parseSemver(value.version);
    const targets=uniqueSortedStrings(value.targets,'descriptor.targets',{
        pattern:APP_ID_PATTERN,
        maximum:TARGET_IDS.length,
        required:true
    });
    if(targets.some(target=>!TARGET_IDS.includes(target)))fail('descriptor.targets contains an unknown SDK target.');
    const packageDescriptor=validatePackage(value.package,value.id);
    const native=validateNative(value.native,value.id);
    const displayName=safeText(value.displayName,'descriptor.displayName',{maximum:160});
    const description=safeText(value.description,'descriptor.description');
    if(targets.some(target=>target!=='browser')){
        if(displayName.length>80||description.length>240){
            fail('Native app displayName and description must fit the Arcane presentation limits.');
        }
        if(!native.icon){
            fail('descriptor.native.icon is required when a native target is declared.');
        }
        if(!packageDescriptor.include.some(candidate=>
            native.icon===candidate||native.icon.startsWith(`${candidate}/`)
        )){
            fail('descriptor.native.icon must be covered by descriptor.package.include.');
        }
    }
    const permissions=validatePermissions(value.permissions);
    return Object.freeze({
        schemaVersion:APP_DESCRIPTOR_SCHEMA_VERSION,
        id:value.id,
        displayName,
        description,
        version:value.version,
        publisher:validatePublisher(value.publisher),
        package:packageDescriptor,
        permissions,
        security:validateSecurity(value.security,{appId:value.id,capabilities:permissions.capabilities}),
        native,
        requirements:validateRequirements(value.requirements),
        targets
    });
}

export function projectPackageManifest(descriptor){
    const value=validateAppDescriptor(descriptor,{appId:descriptor?.id});
    const projection={
        schemaVersion:1,
        id:value.id,
        displayName:value.displayName,
        version:value.version,
        entry:value.package.entry,
        strategy:value.package.strategy,
        ...(value.package.localAIModelPolicy?{localAIModelPolicy:value.package.localAIModelPolicy}:{}),
        include:[...value.package.include],
        exclude:[...value.package.exclude],
        shared:[...value.package.shared],
        ...(value.package.adapter?{adapter:value.package.adapter}:{})
    };
    const sharedPayloads=Object.fromEntries(
        value.package.shared.map(id=>[id,Object.freeze([])])
    );
    validateAppPackageConfig(
        projection,
        value.id,
        {sharedPayloads:Object.freeze(sharedPayloads)},
        `${APP_DESCRIPTOR_NAME} projection`
    );
    return projection;
}

export function appDescriptorSha256(descriptor){
    const value=validateAppDescriptor(descriptor,{appId:descriptor?.id});
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function projectNativeDescriptor(descriptor,{source}={}){
    const value=validateAppDescriptor(descriptor,{appId:descriptor?.id});
    if(!value.targets.some(target=>target!=='browser')){
        fail('A browser-only descriptor cannot be projected as a native Arcane app.');
    }
    return {
        displayName:value.displayName,
        description:value.description,
        icon:value.native.icon,
        order:value.native.order,
        type:value.native.type,
        source:source??`apps/${value.id}`,
        entry:value.package.entry,
        capabilities:[...value.permissions.capabilities],
        security:{
            connectOrigins:[...value.security.connectOrigins],
            frameOrigins:[...value.security.frameOrigins],
            mediaOrigins:[...value.security.mediaOrigins]
        },
        ...(value.native.bundledApps.length?{bundledApps:[...value.native.bundledApps]}:{}),
        ...(value.native.documentCatalog?{documentCatalog:value.native.documentCatalog}:{}),
        include:[...value.package.include]
    };
}

function synthesizedDescriptor(packageManifest,nativeDescriptor){
    const native=nativeDescriptor??{};
    const security=native.security??{};
    return validateAppDescriptor({
        schemaVersion:APP_DESCRIPTOR_SCHEMA_VERSION,
        id:packageManifest.id,
        displayName:packageManifest.displayName,
        description:native.description??`${packageManifest.displayName} Arcane application.`,
        version:packageManifest.version,
        publisher:{id:'publisher-undeclared',name:'Publisher not declared'},
        package:{
            entry:packageManifest.entry,
            strategy:packageManifest.strategy,
            ...(packageManifest.localAIModelPolicy?{localAIModelPolicy:packageManifest.localAIModelPolicy}:{}),
            include:[...packageManifest.include],
            exclude:[...(packageManifest.exclude??[])],
            shared:[...packageManifest.shared].sort(),
            ...(packageManifest.adapter?{adapter:packageManifest.adapter}:{})
        },
        permissions:{
            capabilities:[...(native.capabilities??[])].sort(),
            methods:[]
        },
        security:{
            connectOrigins:[...(security.connectOrigins??[])].sort(),
            frameOrigins:[...(security.frameOrigins??[])].sort(),
            mediaOrigins:[...(security.mediaOrigins??[])].sort()
        },
        native:{
            type:native.type??'app',
            icon:native.icon??null,
            order:Number.isInteger(native.order)?native.order:100,
            bundledApps:[...(native.bundledApps??[])].sort(),
            ...(native.documentCatalog?{documentCatalog:native.documentCatalog}:{})
        },
        requirements:{
            arcaneProtocol:ARCANE_PROTOCOL,
            minimumCoreVersion:ARCANE_MACHINE_BUNDLE_VERSION,
            features:[]
        },
        targets:nativeDescriptor!==undefined
            ?['android-arm64','browser','linux-arm64','linux-x64','portable','windows-x64']
            :['browser']
    },{appId:packageManifest.id});
}

async function readJsonFile(filePath,label,{optional=false}={}){
    try{
        const info=await lstat(filePath);
        if(info.isSymbolicLink()||!info.isFile())fail(`${label} must be a real file.`);
        return JSON.parse(await readFile(filePath,'utf8'));
    }catch(error){
        if(optional&&error?.code==='ENOENT')return null;
        if(error instanceof SyntaxError)fail(`${label} is not valid JSON: ${error.message}`);
        throw error;
    }
}

export async function loadAppDescriptor({workspaceRoot,appRoot,appId,packageManifest}){
    const descriptorPath=path.join(appRoot,APP_DESCRIPTOR_NAME);
    const authored=await readJsonFile(descriptorPath,`apps/${appId}/${APP_DESCRIPTOR_NAME}`,{optional:true});
    if(authored){
        const descriptor=validateAppDescriptor(authored,{appId});
        const projection=projectPackageManifest(descriptor);
        if(!isDeepStrictEqual(projection,packageManifest)){
            fail(`${APP_DESCRIPTOR_NAME} does not project exactly to arcane-package.json.`);
        }
        return Object.freeze({descriptor,source:'authored',descriptorPath});
    }

    const registry=await readJsonFile(
        path.join(workspaceRoot,REGISTRY_PATH),
        'Arcane native app registry',
        {optional:true}
    );
    const nativeDescriptor=isObject(registry?.apps?.[appId])?registry.apps[appId]:undefined;
    return Object.freeze({
        descriptor:synthesizedDescriptor(packageManifest,nativeDescriptor),
        source:nativeDescriptor?'legacy-registry':'legacy-package',
        descriptorPath:null
    });
}
