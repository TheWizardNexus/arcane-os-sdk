import {isDeepStrictEqual} from 'node:util';
import {readFile} from 'node:fs/promises';
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
const completeValue=value=>value;
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

function safeText(value,label){
    if(typeof value!=='string'||value!==value.trim()||!value
        ||/[<>\u0000-\u001f\u007f]/u.test(value)){
        fail(`${label} must be nonempty, trimmed presentation text.`);
    }
    return value;
}

function uniqueSortedStrings(value,label,{pattern,required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)){
        fail(`${label} must be ${required?'a nonempty':'an'} array.`);
    }
    const normalized=value.map((entry,index)=>{
        if(typeof entry!=='string'||entry!==entry.trim()||!entry
            ||(pattern&&!pattern.test(entry))){
            fail(`${label}[${index}] is invalid.`);
        }
        return entry;
    });
    return completeValue(normalized);
}

function relativePaths(value,label,{required=false}={}){
    if(!Array.isArray(value)||(required&&value.length===0)){
        fail(`${label} must be ${required?'a nonempty':'an'} array.`);
    }
    const normalized=value.map((entry,index)=>normalizeRelativePath(entry,`${label}[${index}]`));
    return completeValue(normalized);
}

function validateOrigins(value,label){
    if(!Array.isArray(value))fail(`${label} must be an array of origins.`);
    const origins=value.map((origin,index)=>{
        if(typeof origin!=='string'||!origin.trim())fail(`${label}[${index}] is invalid.`);
        return origin;
    });
    return completeValue(origins);
}

function validateLocalAIModelPolicy(value,label){
    if(value===undefined)return undefined;
    assertOnlyKeys(value,new Set(['verified_only','models']),label);
    if(typeof value.verified_only!=='boolean'||!Array.isArray(value.models)){
        fail(`${label} is invalid.`);
    }
    const models=value.models.map((model,index)=>{
        const itemLabel=`${label}.models[${index}]`;
        assertOnlyKeys(model,new Set(['name','definition']),itemLabel);
        if(typeof model.name!=='string'||!model.name
            ||typeof model.definition!=='string'||!model.definition.endsWith('Modelfile')){
            fail(`${itemLabel} is invalid.`);
        }
        return completeValue({name:model.name,definition:normalizeRelativePath(model.definition,`${itemLabel}.definition`)});
    });
    return completeValue({verified_only:value.verified_only,models:completeValue(models)});
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
    return completeValue({
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
    return completeValue({id:value.id,name:safeText(value.name,'descriptor.publisher.name')});
}

function validatePermissions(value={}){
    assertOnlyKeys(value,new Set(['capabilities','methods']),'descriptor.permissions');
    const capabilities=uniqueSortedStrings(value.capabilities??[],'descriptor.permissions.capabilities',{
            pattern:CAPABILITY_PATTERN
        });
    return completeValue({
        capabilities,
        methods:uniqueSortedStrings(value.methods??[],'descriptor.permissions.methods',{
            pattern:METHOD_PATTERN
        })
    });
}

function validateSecurity(value={}){
    assertOnlyKeys(value,new Set(['connectOrigins','frameOrigins','mediaOrigins']),'descriptor.security');
    const frameOrigins=validateOrigins(value.frameOrigins??[],'descriptor.security.frameOrigins');
    return completeValue({
        connectOrigins:validateOrigins(value.connectOrigins??[],'descriptor.security.connectOrigins'),
        frameOrigins,
        mediaOrigins:validateOrigins(value.mediaOrigins??[],'descriptor.security.mediaOrigins')
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
        return completeValue({
            policy:value.policy,
            destination:normalizeRelativePath(value.destination,`${label}.destination`),
            manifest
        });
    }
    assertOnlyKeys(value,new Set([
        'policy','release','destination','originals','manifest','expectedCount'
    ]),label);
    if(value.policy!=='public-only'||!Number.isInteger(value.expectedCount)
        ||value.expectedCount<1){
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
    return completeValue({
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
    if(!Number.isInteger(value.order)||value.order<0){
        fail('descriptor.native.order must be a nonnegative integer.');
    }
    const bundledApps=uniqueSortedStrings(value.bundledApps,'descriptor.native.bundledApps',{
        pattern:APP_ID_PATTERN
    });
    const documentCatalog=validateDocumentCatalog(value.documentCatalog);
    return completeValue({
        type:value.type,
        icon,
        order:value.order,
        bundledApps,
        ...(documentCatalog?{documentCatalog}:{})
    });
}

function validateRequirements(value,{targets}){
    assertOnlyKeys(value,new Set(['arcaneProtocol','minimumCoreVersion','features']),'descriptor.requirements');
    if(value.arcaneProtocol!==ARCANE_PROTOCOL)fail(`descriptor.requirements.arcaneProtocol must be ${ARCANE_PROTOCOL}.`);
    const needsCore=targets.some(target=>target!=='browser');
    if(needsCore&&value.minimumCoreVersion===undefined){
        fail('descriptor.requirements.minimumCoreVersion is required for non-browser targets.');
    }
    if(value.minimumCoreVersion!==undefined)parseSemver(value.minimumCoreVersion);
    return completeValue({
        arcaneProtocol:value.arcaneProtocol,
        ...(value.minimumCoreVersion===undefined?{}:{minimumCoreVersion:value.minimumCoreVersion}),
        features:uniqueSortedStrings(value.features,'descriptor.requirements.features',{
            pattern:FEATURE_PATTERN
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
    const displayName=safeText(value.displayName,'descriptor.displayName');
    const description=safeText(value.description,'descriptor.description');
    if(targets.some(target=>target!=='browser')){
        if(!native.icon){
            fail('descriptor.native.icon is required when a native target is declared.');
        }
        if(!packageDescriptor.include.some(candidate=>
            native.icon===candidate||native.icon.startsWith(`${candidate}/`)
        )){
            fail('descriptor.native.icon must be covered by descriptor.package.include.');
        }
    }
    const permissions=validatePermissions(value.permissions??{});
    return completeValue({
        schemaVersion:APP_DESCRIPTOR_SCHEMA_VERSION,
        id:value.id,
        displayName,
        description,
        version:value.version,
        publisher:validatePublisher(value.publisher),
        package:packageDescriptor,
        permissions,
        security:validateSecurity(value.security??{}),
        native,
        requirements:validateRequirements(value.requirements,{targets}),
        targets
    });
}

export function projectPackageManifest(descriptor){
    const hasAuthoredSecurity=descriptor?.security!==undefined;
    const value=validateAppDescriptor(descriptor,{appId:descriptor?.id});
    const projection={
        schemaVersion:1,
        id:value.id,
        displayName:value.displayName,
        version:value.version,
        entry:value.package.entry,
        strategy:value.package.strategy,
        ...(hasAuthoredSecurity?{security:{
            connectOrigins:[...value.security.connectOrigins],
            frameOrigins:[...value.security.frameOrigins],
            mediaOrigins:[...value.security.mediaOrigins]
        }}:{}),
        ...(value.package.localAIModelPolicy?{localAIModelPolicy:value.package.localAIModelPolicy}:{}),
        include:[...value.package.include],
        exclude:[...value.package.exclude],
        shared:[...value.package.shared],
        ...(value.package.adapter?{adapter:value.package.adapter}:{})
    };
    const sharedPayloads=Object.fromEntries(
        value.package.shared.map(id=>[id,completeValue([])])
    );
    validateAppPackageConfig(
        projection,
        value.id,
        {sharedPayloads:completeValue(sharedPayloads)},
        `${APP_DESCRIPTOR_NAME} projection`
    );
    return projection;
}

export function projectNativeDescriptor(descriptor,{source}={}){
    const hasAuthoredPermissions=descriptor?.permissions!==undefined;
    const hasAuthoredSecurity=descriptor?.security!==undefined;
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
        ...(hasAuthoredPermissions?{capabilities:[...value.permissions.capabilities]}:{}),
        ...(hasAuthoredSecurity?{security:{
            connectOrigins:[...value.security.connectOrigins],
            frameOrigins:[...value.security.frameOrigins],
            mediaOrigins:[...value.security.mediaOrigins]
        }}:{}),
        ...(value.native.bundledApps.length?{bundledApps:[...value.native.bundledApps]}:{}),
        ...(value.native.documentCatalog?{documentCatalog:value.native.documentCatalog}:{}),
        include:[...value.package.include]
    };
}

function synthesizedDescriptor(packageManifest,nativeDescriptor){
    const native=nativeDescriptor??{};
    const security=packageManifest.security??native.security??{};
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
            shared:[...packageManifest.shared],
            ...(packageManifest.adapter?{adapter:packageManifest.adapter}:{})
        },
        permissions:{
            capabilities:[...(native.capabilities??[])],
            methods:[]
        },
        security:{
            connectOrigins:[...(security.connectOrigins??[])],
            frameOrigins:[...(security.frameOrigins??[])],
            mediaOrigins:[...(security.mediaOrigins??[])]
        },
        native:{
            type:native.type??'app',
            icon:native.icon??null,
            order:Number.isInteger(native.order)?native.order:100,
            bundledApps:[...(native.bundledApps??[])],
            ...(native.documentCatalog?{documentCatalog:native.documentCatalog}:{})
        },
        requirements:{
            arcaneProtocol:ARCANE_PROTOCOL,
            ...(nativeDescriptor===undefined?{}:{minimumCoreVersion:ARCANE_MACHINE_BUNDLE_VERSION}),
            features:[]
        },
        targets:nativeDescriptor!==undefined
            ?['android-arm64','browser','linux-arm64','linux-x64','portable','windows-x64']
            :['browser']
    },{appId:packageManifest.id});
}

async function readJsonFile(filePath,label,{optional=false}={}){
    try{
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
        const projection=projectPackageManifest(authored);
        if(!isDeepStrictEqual(projection,packageManifest)){
            fail(`${APP_DESCRIPTOR_NAME} does not project exactly to arcane-package.json.`);
        }
        return completeValue({descriptor,source:'authored',descriptorPath});
    }

    const registry=await readJsonFile(
        path.join(workspaceRoot,REGISTRY_PATH),
        'Arcane native app registry',
        {optional:true}
    );
    const nativeDescriptor=isObject(registry?.apps?.[appId])?registry.apps[appId]:undefined;
    return completeValue({
        descriptor:synthesizedDescriptor(packageManifest,nativeDescriptor),
        source:nativeDescriptor?'registry-projection':'package-projection',
        descriptorPath:null
    });
}
