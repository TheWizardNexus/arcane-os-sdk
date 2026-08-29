import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {validateAppDescriptor} from './app-descriptor.mjs';
import {normalizeRelativePath} from './packager/core.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';

export const NATIVE_BUILD_PLAN_PROTOCOL='arcane-native-build-plan/1';
export const NATIVE_BUILDER_PROTOCOL='arcane-native-builder/1';

const NATIVE_TARGETS={
    portable:{
        platforms:new Set(['windows','linux']),
        architectures:new Set(['x64','arm64']),
        format:'portable',
        signingMode:'unsigned-local-test',
        signingProfileId:null
    },
    'windows-x64':{
        platforms:new Set(['windows']),architectures:new Set(['x64']),format:'exe',
        signingMode:'unsigned-local-test',signingProfileId:null
    },
    'linux-x64':{
        platforms:new Set(['linux']),architectures:new Set(['x64']),format:'deb',
        signingMode:'unsigned-local-test',signingProfileId:null
    },
    'linux-arm64':{
        platforms:new Set(['linux']),architectures:new Set(['arm64']),format:'deb',
        signingMode:'unsigned-local-test',signingProfileId:null
    },
    'android-arm64':{
        platforms:new Set(['android']),architectures:new Set(['arm64']),format:'apk',
        signingMode:'development',signingProfileId:'arcane-android-development-v1'
    }
};

function fail(message,code=ERROR_CODES.policyDenied,details){
    throw new ArcaneError(code,message,{details});
}

function isObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

async function emit(onEvent,event){
    if(typeof onEvent==='function')await onEvent(event);
}

async function realDirectory(location,label){
    if(typeof location!=='string'||!location.trim())fail(`${label} is required.`,ERROR_CODES.usage);
    const requested=path.resolve(location);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${requested}.`,ERROR_CODES.prerequisiteMissing);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail(`${label} must be a real directory.`,ERROR_CODES.policyDenied);
    }
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical);
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()){
        fail(`${label} must be a real directory.`,ERROR_CODES.policyDenied);
    }
    return canonical;
}

function inside(root,candidate,{allowEqual=false}={}){
    const relative=path.relative(path.resolve(root),path.resolve(candidate));
    return (allowEqual&&relative==='')
        ||Boolean(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
}

function overlap(left,right){
    return inside(left,right,{allowEqual:true})||inside(right,left,{allowEqual:true});
}

function selectedTargetRequest(value){
    if(!isObject(value))fail('targetRequest must be an object.',ERROR_CODES.usage);
    const definition=NATIVE_TARGETS[value.target];
    if(!definition)fail(`Unsupported native target: ${String(value.target)}.`,ERROR_CODES.targetUnavailable);
    if(!definition.platforms.has(value.platform)){
        fail(`Target ${value.target} does not support platform ${String(value.platform)}.`,ERROR_CODES.targetUnavailable);
    }
    if(!definition.architectures.has(value.architecture)){
        fail(`Target ${value.target} does not support architecture ${String(value.architecture)}.`,ERROR_CODES.targetUnavailable);
    }
    if(value.format!==definition.format){
        fail(`Target ${value.target} requires format ${definition.format}.`,ERROR_CODES.targetUnavailable);
    }
    if(value.signing!==definition.signingMode){
        fail(`Target ${value.target} requires signing mode ${definition.signingMode}.`,ERROR_CODES.targetUnavailable);
    }
    if((value.signingProfileId??null)!==definition.signingProfileId){
        fail(`Target ${value.target} has a different signing profile.`,ERROR_CODES.targetUnavailable);
    }
    return {
        target:value.target,
        platform:value.platform,
        architecture:value.architecture,
        format:value.format,
        signing:value.signing,
        signingProfileId:value.signingProfileId??null
    };
}

export function validateNativeBuilder(provider){
    if(!isObject(provider))fail('Native builder must be an object.',ERROR_CODES.usage);
    if(provider.protocol!==NATIVE_BUILDER_PROTOCOL){
        fail(`Native builder protocol must be ${NATIVE_BUILDER_PROTOCOL}.`,ERROR_CODES.targetUnavailable);
    }
    for(const method of ['describe','doctor','prepare','build','verify','run']){
        if(typeof provider[method]!=='function'){
            fail(`Native builder must implement ${method}().`,ERROR_CODES.targetUnavailable);
        }
    }
    return provider;
}

async function releaseSelection(releaseRoot,release,label){
    const root=await realDirectory(releaseRoot,`${label} root`);
    if(!isObject(release)||!Array.isArray(release.files)){
        fail(`${label} must provide its structural file inventory.`,ERROR_CODES.usage);
    }
    const files=release.files.map((entry,index)=>normalizeRelativePath(
        entry,
        `${label}.files[${index}]`
    ));
    if(new Set(files.map(file=>file.toLocaleLowerCase('en-US'))).size!==files.length){
        fail(`${label} contains duplicate file paths.`,ERROR_CODES.usage);
    }
    async function readSelectedFile(relativePath,{signal}={}){
        throwIfAborted(signal);
        const normalized=normalizeRelativePath(relativePath,`${label} file`);
        if(!files.some(file=>file.toLocaleLowerCase('en-US')===normalized.toLocaleLowerCase('en-US'))){
            fail(`${label} does not contain ${normalized}.`,ERROR_CODES.usage);
        }
        const selected=path.resolve(root,...normalized.split('/'));
        if(!inside(root,selected))fail(`${label} file leaves its root.`,ERROR_CODES.policyDenied);
        const info=await lstat(selected);
        if(info.isSymbolicLink()||!info.isFile()){
            fail(`${label} file must be a real file: ${normalized}.`,ERROR_CODES.policyDenied);
        }
        const canonical=await realpath(selected);
        if(!inside(root,canonical))fail(`${label} file resolves outside its root.`,ERROR_CODES.policyDenied);
        return readFile(canonical);
    }
    return {root,release:{...release,files:[...files]},readFile:readSelectedFile};
}

async function dependencySelections(value,{signal}={}){
    if(value===undefined)return [];
    if(!Array.isArray(value))fail('dependencyReleases must be an array.',ERROR_CODES.usage);
    const dependencies=[];
    for(const [index,item] of value.entries()){
        throwIfAborted(signal);
        if(!isObject(item)||typeof item.appId!=='string'){
            fail(`dependencyReleases[${index}] is malformed.`,ERROR_CODES.usage);
        }
        const selected=await releaseSelection(
            item.releaseRoot,
            item.release,
            `dependency release ${item.appId}`
        );
        dependencies.push({appId:item.appId,...selected});
    }
    return dependencies;
}

export async function createNativeBuildPlan({
    nativeBuilder,
    toolchainRoot,
    toolchain,
    appReleaseRoot,
    release,
    appDescriptor,
    dependencyReleases,
    minimumCoreVersion,
    protectedRoots=[],
    outputRoot,
    targetRequest,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const provider=validateNativeBuilder(nativeBuilder);
    const selectedToolchainRoot=await realDirectory(toolchainRoot,'Native toolchain root');
    if(!isObject(toolchain))fail('Native toolchain preparation result is required.',ERROR_CODES.usage);
    const descriptor=JSON.parse(JSON.stringify(
        validateAppDescriptor(appDescriptor,{appId:appDescriptor?.id})
    ));
    const application=await releaseSelection(appReleaseRoot,release,'application release');
    const dependencies=await dependencySelections(dependencyReleases,{signal});
    if(!Array.isArray(protectedRoots)){
        fail('protectedRoots must be an array.',ERROR_CODES.usage);
    }
    if(typeof outputRoot!=='string'||!outputRoot.trim()){
        fail('outputRoot is required.',ERROR_CODES.usage);
    }
    const selectedOutput=path.resolve(outputRoot);
    if(protectedRoots.some(root=>overlap(path.resolve(root),selectedOutput))){
        fail('Native output root overlaps a protected source directory.',ERROR_CODES.policyDenied);
    }
    const request=selectedTargetRequest(targetRequest);
    const plan={
        protocol:NATIVE_BUILD_PLAN_PROTOCOL,
        nativeBuilder:provider,
        toolchainRoot:selectedToolchainRoot,
        toolchain:{...toolchain},
        appDescriptor:descriptor,
        application,
        dependencies,
        minimumCoreVersion:minimumCoreVersion??null,
        protectedRoots:protectedRoots.map(root=>path.resolve(root)),
        outputRoot:selectedOutput,
        targetRequest:request
    };
    await emit(onEvent,{type:'native.plan.created',target:request.target,outputRoot:selectedOutput});
    return plan;
}

export async function executeNativeBuildPlan(plan,{
    expectedNativeBuilder,
    expectedTarget,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    if(!isObject(plan)||plan.protocol!==NATIVE_BUILD_PLAN_PROTOCOL){
        fail('Native build plan is malformed.',ERROR_CODES.usage);
    }
    const provider=validateNativeBuilder(plan.nativeBuilder);
    if(expectedNativeBuilder!==undefined&&provider!==expectedNativeBuilder){
        fail('Native build plan belongs to a different provider.',ERROR_CODES.usage);
    }
    if(expectedTarget!==undefined&&plan.targetRequest?.target!==expectedTarget){
        fail('Native build plan targets a different platform.',ERROR_CODES.usage);
    }
    await emit(onEvent,{type:'native.build.started',target:plan.targetRequest.target});
    const result=await provider.build({
        toolchainRoot:plan.toolchainRoot,
        toolchain:plan.toolchain,
        appDescriptor:plan.appDescriptor,
        appReleaseRoot:plan.application.root,
        release:plan.application.release,
        readReleaseFile:plan.application.readFile,
        dependencies:plan.dependencies.map(dependency=>({
            appId:dependency.appId,
            releaseRoot:dependency.root,
            release:dependency.release,
            readReleaseFile:dependency.readFile
        })),
        minimumCoreVersion:plan.minimumCoreVersion,
        protectedRoots:[...plan.protectedRoots],
        outputRoot:plan.outputRoot,
        targetRequest:{...plan.targetRequest},
        signal,
        onEvent
    });
    throwIfAborted(signal);
    await emit(onEvent,{type:'native.build.completed',target:plan.targetRequest.target});
    return result;
}
