import {randomBytes} from 'node:crypto';
import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {appDescriptorSha256,projectNativeDescriptor,validateAppDescriptor} from './app-descriptor.mjs';
import {authenticateAppReleaseReceipt} from './packager/core.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';

export const NATIVE_BUILD_PLAN_PROTOCOL='arcane-native-build-plan/1';
export const NATIVE_BUILDER_PROTOCOL='arcane-native-builder/1';

const NATIVE_TARGETS=Object.freeze({
    portable:Object.freeze({
        platforms:new Set(['windows','linux']),
        architectures:new Set(['x64','arm64']),
        formats:new Set(['portable'])
    }),
    'windows-x64':Object.freeze({
        platforms:new Set(['windows']),architectures:new Set(['x64']),formats:new Set(['exe'])
    }),
    'linux-x64':Object.freeze({
        platforms:new Set(['linux']),architectures:new Set(['x64']),formats:new Set(['appimage','deb','rpm'])
    }),
    'linux-arm64':Object.freeze({
        platforms:new Set(['linux']),architectures:new Set(['arm64']),formats:new Set(['appimage','deb','rpm'])
    }),
    'android-arm64':Object.freeze({
        platforms:new Set(['android']),architectures:new Set(['arm64']),formats:new Set(['apk','aab'])
    })
});
const SIGNING_MODES=new Set(['unsigned-local-test','development','production']);
const SHA256_PATTERN=/^[a-f0-9]{64}$/u;
const issuedPlans=new WeakMap();

function fail(message,code=ERROR_CODES.policyDenied,details){
    throw new ArcaneError(code,message,{details});
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

function immutable(value){
    if(Array.isArray(value))return Object.freeze(value.map(immutable));
    if(isObject(value))return Object.freeze(Object.fromEntries(
        Object.entries(value).map(([key,item])=>[key,immutable(item)])
    ));
    return value;
}

function sameOrDescendant(parent,candidate){
    const relative=path.relative(parent,candidate);
    return relative===''||Boolean(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
}

function overlaps(left,right){
    return sameOrDescendant(left,right)||sameOrDescendant(right,left);
}

async function canonicalDirectory(value,label){
    if(typeof value!=='string'||!value.trim())fail(`${label} is required.`,ERROR_CODES.usage);
    const requested=path.resolve(value);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} must be a real directory.`);
    return realpath(requested);
}

async function canonicalFutureDirectory(value,label){
    if(typeof value!=='string'||!value.trim())fail(`${label} is required.`,ERROR_CODES.usage);
    const requested=path.resolve(value);
    let cursor=requested;
    const missing=[];
    while(true){
        try{
            const info=await lstat(cursor);
            if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} has a linked or non-directory ancestor.`);
            const canonical=await realpath(cursor);
            return path.join(canonical,...missing.reverse());
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
            const parent=path.dirname(cursor);
            if(parent===cursor)throw error;
            missing.push(path.basename(cursor));
            cursor=parent;
        }
    }
}

export function validateNativeBuilder(provider){
    const methods=['describe','doctor','prepare','authenticateToolchainReceipt','build','verify','run'];
    if(!isObject(provider)||provider.protocol!==NATIVE_BUILDER_PROTOCOL
        ||methods.some(method=>typeof provider[method]!=='function')){
        fail(`Native builder must implement ${NATIVE_BUILDER_PROTOCOL} and its complete operation contract.`,ERROR_CODES.targetUnavailable);
    }
    return provider;
}

function validateTargetRequest(value){
    assertOnlyKeys(value,new Set(['target','platform','architecture','format','signing']),'targetRequest');
    const definition=NATIVE_TARGETS[value.target];
    if(!definition)fail(`Unsupported native target: ${String(value.target)}.`,ERROR_CODES.targetUnavailable);
    if(!definition.platforms.has(value.platform)||!definition.architectures.has(value.architecture)
        ||!definition.formats.has(value.format)){
        fail(`Target ${value.target} does not support ${value.platform}/${value.architecture}/${value.format}.`,ERROR_CODES.targetUnavailable);
    }
    assertOnlyKeys(value.signing,new Set(['mode','profileId']),'targetRequest.signing');
    if(!SIGNING_MODES.has(value.signing.mode))fail('targetRequest.signing.mode is unsupported.');
    const profileId=value.signing.profileId??null;
    if(value.signing.mode==='unsigned-local-test'){
        if(profileId!==null)fail('unsigned-local-test signing must not name a signing profile.');
    }else if(typeof profileId!=='string'||!profileId.trim()||profileId.length>160
        ||/[\u0000-\u001f\u007f]/u.test(profileId)){
        fail(`${value.signing.mode} signing requires a bounded explicit profileId.`);
    }
    return immutable({
        target:value.target,
        platform:value.platform,
        architecture:value.architecture,
        format:value.format,
        signing:{mode:value.signing.mode,profileId}
    });
}

function releaseApp(receipt){
    return isObject(receipt?.app)?receipt.app:null;
}

function releaseSummary(receipt){
    const app=releaseApp(receipt);
    if(!app||typeof app.id!=='string'||typeof app.version!=='string'
        ||!SHA256_PATTERN.test(receipt.policySha256)
        ||!SHA256_PATTERN.test(receipt.contentSha256)){
        fail('The app release receipt is missing its verified identity.',ERROR_CODES.integrityFailed);
    }
    return immutable({
        canonicalLocation:receipt.canonicalLocation,
        policySha256:receipt.policySha256,
        contentSha256:receipt.contentSha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes
    });
}

async function authenticateReleaseReceipt(receipt,releaseRoot,signal){
    try{
        return await authenticateAppReleaseReceipt(receipt,{releaseRoot,signal});
    }catch(error){
        if(error?.code===ERROR_CODES.cancelled)throw error;
        throw new ArcaneError(
            ERROR_CODES.integrityFailed,
            `App release authentication failed: ${error instanceof Error?error.message:String(error)}`,
            {cause:error}
        );
    }
}

async function authenticatedRelease(item,targetRequest,{signal}){
    assertOnlyKeys(
        item,
        new Set(['appDescriptor','appReleaseRoot','appReleaseReceipt']),
        'application release input'
    );
    const descriptor=validateAppDescriptor(item.appDescriptor,{appId:item.appDescriptor?.id});
    projectNativeDescriptor(descriptor);
    if(!descriptor.targets.includes(targetRequest.target)){
        fail(`App ${descriptor.id} does not declare target ${targetRequest.target}.`);
    }
    const root=await canonicalDirectory(item.appReleaseRoot,`Release root for ${descriptor.id}`);
    const receipt=await authenticateReleaseReceipt(item.appReleaseReceipt,root,signal);
    const app=releaseApp(receipt);
    if(app?.id!==descriptor.id||app?.version!==descriptor.version){
        fail(`Release identity for ${descriptor.id} does not match its canonical descriptor.`,ERROR_CODES.integrityFailed);
    }
    return Object.freeze({
        descriptor,
        descriptorSha256:appDescriptorSha256(descriptor),
        releaseRoot:root,
        releaseReceipt:receipt,
        summary:immutable({
            id:descriptor.id,
            version:descriptor.version,
            descriptorSha256:appDescriptorSha256(descriptor),
            release:releaseSummary(receipt)
        })
    });
}

function assertDependencyClosure(application,dependencies){
    const byId=new Map(dependencies.map(item=>[item.descriptor.id,item]));
    if(byId.size!==dependencies.length)fail('Dependency releases must have unique app ids.');
    if(byId.has(application.descriptor.id))fail('The selected app must not also be supplied as a dependency.');
    const reachable=new Set();
    const visiting=new Set();
    function visit(descriptor){
        if(visiting.has(descriptor.id))fail(`Bundled app dependency cycle includes ${descriptor.id}.`);
        visiting.add(descriptor.id);
        for(const id of descriptor.native.bundledApps){
            const dependency=byId.get(id);
            if(!dependency)fail(`Bundled app dependency ${id} is missing its verified release.`);
            if(visiting.has(id))fail(`Bundled app dependency cycle includes ${id}.`);
            if(!reachable.has(id)){
                reachable.add(id);
                visit(dependency.descriptor);
            }
        }
        visiting.delete(descriptor.id);
    }
    visit(application.descriptor);
    const extra=[...byId.keys()].filter(id=>!reachable.has(id));
    if(extra.length)fail(`Unrequested dependency releases were supplied: ${extra.sort().join(', ')}.`);
}

function toolchainSummary(receipt,toolchainRoot){
    if(!isObject(receipt)||receipt.canonicalLocation!==toolchainRoot
        ||typeof receipt.kind!=='string'||!receipt.kind
        ||typeof receipt.version!=='string'||!receipt.version
        ||!SHA256_PATTERN.test(receipt.contentSha256)){
        fail('The native builder returned an invalid authenticated toolchain receipt.',ERROR_CODES.integrityFailed);
    }
    return immutable({
        kind:receipt.kind,
        version:receipt.version,
        canonicalLocation:receipt.canonicalLocation,
        contentSha256:receipt.contentSha256
    });
}

function assertExpectedPlanBinding(state,{expectedNativeBuilder,expectedTarget}={}){
    if(expectedNativeBuilder!==undefined&&state.provider!==expectedNativeBuilder){
        fail('Native build plan belongs to a different paired provider.',ERROR_CODES.integrityFailed);
    }
    if(expectedTarget!==undefined&&state.plan.targetRequest.target!==expectedTarget){
        fail(
            `Native build plan target ${state.plan.targetRequest.target} does not match ${expectedTarget}.`,
            ERROR_CODES.integrityFailed
        );
    }
}

async function authenticateState(state,{expectedNativeBuilder,expectedTarget,signal,onEvent}={}){
    throwIfAborted(signal);
    assertExpectedPlanBinding(state,{expectedNativeBuilder,expectedTarget});
    const authenticatedToolchain=await state.provider.authenticateToolchainReceipt(
        state.toolchainReceipt,
        {toolchainRoot:state.toolchainRoot,signal,onEvent}
    );
    const summary=toolchainSummary(authenticatedToolchain,state.toolchainRoot);
    if(JSON.stringify(summary)!==JSON.stringify(state.plan.toolchain)){
        fail('The native toolchain identity changed after plan creation.',ERROR_CODES.integrityFailed);
    }
    await authenticateReleaseReceipt(
        state.application.releaseReceipt,
        state.application.releaseRoot,
        signal
    );
    for(const dependency of state.dependencies){
        await authenticateReleaseReceipt(dependency.releaseReceipt,dependency.releaseRoot,signal);
    }
    const outputRoot=await canonicalFutureDirectory(state.outputRoot,'Native output root');
    if(outputRoot!==state.outputRoot)fail('The native output root identity changed after plan creation.',ERROR_CODES.integrityFailed);
    return state.plan;
}

export async function createNativeBuildPlan({
    nativeBuilder,
    toolchainRoot,
    toolchainReceipt,
    appReleaseRoot,
    appReleaseReceipt,
    appDescriptor,
    dependencyReleases=[],
    protectedRoots=[],
    outputRoot,
    targetRequest,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({type:'native.plan.started'}));
    const provider=validateNativeBuilder(nativeBuilder);
    const request=validateTargetRequest(targetRequest);
    const canonicalToolchainRoot=await canonicalDirectory(toolchainRoot,'Native toolchain root');
    const authenticatedToolchain=await provider.authenticateToolchainReceipt(
        toolchainReceipt,
        {toolchainRoot:canonicalToolchainRoot,signal,onEvent}
    );
    const application=await authenticatedRelease({
        appDescriptor,
        appReleaseRoot,
        appReleaseReceipt
    },request,{signal});
    if(!Array.isArray(dependencyReleases)||dependencyReleases.length>64){
        fail('dependencyReleases must be an array with at most 64 entries.');
    }
    const dependencies=[];
    for(const dependency of dependencyReleases){
        dependencies.push(await authenticatedRelease(dependency,request,{signal}));
    }
    assertDependencyClosure(application,dependencies);
    dependencies.sort((left,right)=>left.descriptor.id.localeCompare(right.descriptor.id,'en'));

    const canonicalOutputRoot=await canonicalFutureDirectory(outputRoot,'Native output root');
    const protectedPaths=[
        canonicalToolchainRoot,
        application.releaseRoot,
        ...dependencies.map(item=>item.releaseRoot)
    ];
    if(!Array.isArray(protectedRoots))fail('protectedRoots must be an array.');
    for(const [index,root] of protectedRoots.entries()){
        protectedPaths.push(await canonicalDirectory(root,`Protected source root ${index}`));
    }
    const conflict=protectedPaths.find(root=>overlaps(root,canonicalOutputRoot));
    if(conflict)fail('Native output root must not overlap a toolchain, source, or verified release root.');

    const plan=immutable({
        protocol:NATIVE_BUILD_PLAN_PROTOCOL,
        generation:randomBytes(16).toString('hex'),
        toolchain:toolchainSummary(authenticatedToolchain,canonicalToolchainRoot),
        app:application.summary,
        dependencies:dependencies.map(item=>item.summary),
        targetRequest:request,
        outputRoot:canonicalOutputRoot,
        operations:[
            'authenticate-toolchain',
            'authenticate-app-release',
            'authenticate-dependency-releases',
            'build-selected-target',
            'verify-native-artifact'
        ]
    });
    issuedPlans.set(plan,Object.freeze({
        plan,
        provider,
        toolchainRoot:canonicalToolchainRoot,
        toolchainReceipt,
        application,
        dependencies:Object.freeze(dependencies),
        outputRoot:canonicalOutputRoot,
        targetRequest:request
    }));
    await onEvent?.(Object.freeze({type:'native.plan.completed',appId:application.descriptor.id,target:request.target}));
    return plan;
}

export async function authenticateNativeBuildPlan(plan,{
    expectedNativeBuilder,
    expectedTarget,
    signal,
    onEvent
}={}){
    const state=issuedPlans.get(plan);
    if(!state)fail('Native build plan was not issued by this SDK process.',ERROR_CODES.integrityFailed);
    return authenticateState(state,{expectedNativeBuilder,expectedTarget,signal,onEvent});
}

export async function executeNativeBuildPlan(plan,{
    expectedNativeBuilder,
    expectedTarget,
    signal,
    onEvent
}={}){
    const state=issuedPlans.get(plan);
    if(!state)fail('Native build plan was not issued by this SDK process.',ERROR_CODES.integrityFailed);
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({type:'native.build.started',appId:plan.app.id,target:plan.targetRequest.target}));
    await authenticateState(state,{expectedNativeBuilder,expectedTarget,signal,onEvent});
    const result=await state.provider.build({
        toolchainRoot:state.toolchainRoot,
        toolchainReceipt:state.toolchainReceipt,
        appReleaseRoot:state.application.releaseRoot,
        appReleaseReceipt:state.application.releaseReceipt,
        appDescriptor:state.application.descriptor,
        descriptorSha256:state.application.descriptorSha256,
        dependencyReleases:state.dependencies.map(item=>Object.freeze({
            appReleaseRoot:item.releaseRoot,
            appReleaseReceipt:item.releaseReceipt,
            appDescriptor:item.descriptor,
            descriptorSha256:item.descriptorSha256
        })),
        outputRoot:state.outputRoot,
        targetRequest:state.targetRequest,
        signal,
        onEvent
    });
    if(!isObject(result)||!result.artifactReceipt){
        fail('Native builder did not return an artifact receipt.',ERROR_CODES.integrityFailed);
    }
    await onEvent?.(Object.freeze({
        type:'native.verify.started',
        appId:plan.app.id,
        target:plan.targetRequest.target
    }));
    const artifactVerification=await state.provider.verify({
        toolchainRoot:state.toolchainRoot,
        toolchainReceipt:state.toolchainReceipt,
        artifactReceipt:result.artifactReceipt,
        outputRoot:state.outputRoot,
        targetRequest:state.targetRequest,
        signal,
        onEvent
    });
    if(!isObject(artifactVerification)||artifactVerification.verified!==true){
        fail('Native builder did not verify the built artifact.',ERROR_CODES.integrityFailed);
    }
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({
        type:'native.verify.completed',
        appId:plan.app.id,
        target:plan.targetRequest.target
    }));
    await onEvent?.(Object.freeze({type:'native.build.completed',appId:plan.app.id,target:plan.targetRequest.target}));
    return {...result,artifactVerification};
}
