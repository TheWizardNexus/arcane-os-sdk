import path from 'node:path';
import {packageApp,verifyApp} from '../packager/core.mjs';
import {startDevServer} from '../dev-server.mjs';
import {TARGET_ADAPTER_PROTOCOL,TARGET_IDS} from '../constants.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from '../errors.mjs';
import {
    createNativeBuildPlan,
    executeNativeBuildPlan,
    validateNativeBuilder
} from '../native-plan.mjs';

const DEFINITIONS=[
    {
        id:'browser',displayName:'Browser/static',status:'available',
        platforms:['any'],architectures:['any'],formats:['directory'],signingModes:['none'],reason:null
    },
    {
        id:'portable',displayName:'Portable native application',status:'pairing-required',
        platforms:['windows','linux'],architectures:['x64','arm64'],formats:['portable'],
        signingModes:['unsigned-local-test'],
        reason:'Portable output is available when paired to an Arcane OS native provider.'
    },
    {
        id:'windows-x64',displayName:'Windows x64 executable',status:'pairing-required',
        platforms:['windows'],architectures:['x64'],formats:['exe'],signingModes:['unsigned-local-test'],
        reason:'Windows output requires an Arcane OS native provider.'
    },
    {
        id:'linux-x64',displayName:'Linux x64 executable',status:'pairing-required',
        platforms:['linux'],architectures:['x64'],formats:['deb'],signingModes:['unsigned-local-test'],
        reason:'Linux x64 output requires an Arcane OS native provider.'
    },
    {
        id:'linux-arm64',displayName:'Linux ARM64 executable',status:'pairing-required',
        platforms:['linux'],architectures:['arm64'],formats:['deb'],signingModes:['unsigned-local-test'],
        reason:'Linux ARM64 output requires an Arcane OS native provider.'
    },
    {
        id:'android-arm64',displayName:'Android ARM64 application',status:'pairing-required',
        platforms:['android'],architectures:['arm64'],formats:['apk'],signingModes:['development'],
        reason:'Android output requires an Arcane OS native provider and Android development toolchain.'
    }
];

function describe(definition){
    return {
        protocol:TARGET_ADAPTER_PROTOCOL,
        ...definition,
        platforms:[...definition.platforms],
        architectures:[...definition.architectures],
        formats:[...definition.formats],
        signingModes:[...definition.signingModes],
        methods:['describe','doctor','prepare','plan','build','verify','run']
    };
}

function deferredError(definition){
    return new ArcaneError(
        ERROR_CODES.targetDeferred,
        `Target ${definition.id} requires pairing. ${definition.reason}`,
        {details:describe(definition)}
    );
}

function createDeferredAdapter(definition){
    const unavailable=async options=>{
        throwIfAborted(options?.signal);
        throw deferredError(definition);
    };
    return {
        protocol:TARGET_ADAPTER_PROTOCOL,
        id:definition.id,
        describe:async()=>describe(definition),
        doctor:async()=>({
            target:definition.id,
            status:definition.status,
            ready:false,
            reason:definition.reason
        }),
        prepare:unavailable,
        plan:unavailable,
        build:unavailable,
        verify:unavailable,
        run:unavailable
    };
}

const browserDefinition=DEFINITIONS[0];
const browserAdapter={
    protocol:TARGET_ADAPTER_PROTOCOL,
    id:'browser',
    describe:async()=>describe(browserDefinition),
    doctor:async()=>({target:'browser',status:'available',ready:true}),
    async prepare({signal}={}){
        throwIfAborted(signal);
        return {target:'browser',status:'available',ready:true,required:false};
    },
    async plan({workspaceRoot,appId,format='directory',signing='none',signal}={}){
        throwIfAborted(signal);
        if(format!=='directory'){
            throw new ArcaneError(
                ERROR_CODES.targetUnavailable,
                `Browser target format ${format} is unavailable; use directory.`
            );
        }
        if(signing!=='none'){
            throw new ArcaneError(
                ERROR_CODES.targetUnavailable,
                'The browser/static development target does not use a signing profile.'
            );
        }
        return {
            protocol:TARGET_ADAPTER_PROTOCOL,
            target:'browser',
            workspaceRoot,
            appId,
            format,
            signing,
            operations:['validate-workspace','package-selected-app']
        };
    },
    async build({
        workspaceRoot,
        appId,
        format='directory',
        signing='none',
        dryRun=false,
        signal,
        onEvent,
        workspaceOperationLease
    }={}){
        await this.plan({workspaceRoot,appId,format,signing,signal});
        const release=await packageApp({
            workspaceRoot,
            appId,
            dryRun,
            signal,
            onEvent,
            workspaceOperationLease
        });
        return {target:'browser',format,signing,release};
    },
    async verify({workspaceRoot,appId,signal,onEvent}={}){
        throwIfAborted(signal);
        return {target:'browser',release:await verifyApp({workspaceRoot,appId,signal,onEvent})};
    },
    async run({workspaceRoot,appId,host='127.0.0.1',port=0,signal,onEvent}={}){
        throwIfAborted(signal);
        const releaseRoot=path.join(workspaceRoot,'dist',appId);
        const server=await startDevServer({
            workspaceRoot,
            appId,
            mode:'packaged',
            releaseRoot,
            host,
            port,
            signal,
            onEvent
        });
        return {...server,target:'browser',releaseRoot};
    }
};

const adapters=new Map([
    ['browser',browserAdapter],
    ...DEFINITIONS.slice(1).map(definition=>[definition.id,createDeferredAdapter(definition)])
]);

function nativeDefinition(targetId){
    const definition=DEFINITIONS.find(item=>item.id===targetId);
    if(!definition||definition.id==='browser'){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `A native target adapter cannot be paired for ${String(targetId)}.`
        );
    }
    return definition;
}

function selectedNativeRequest(targetId,targetRequest){
    if(targetRequest?.target!==targetId){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `The injected native adapter for ${targetId} requires a matching targetRequest.`
        );
    }
    return targetRequest;
}

function selectedArtifact(artifact){
    if(!artifact||typeof artifact!=='object'||Array.isArray(artifact)){
        throw new ArcaneError(ERROR_CODES.usage,'A native artifact is required.');
    }
    return artifact;
}

export function createNativeTargetAdapter({targetId,nativeBuilder}={}){
    const definition=nativeDefinition(targetId);
    const provider=validateNativeBuilder(nativeBuilder);
    let providerDescriptionPromise;

    async function requireProviderTarget(){
        providerDescriptionPromise??=Promise.resolve(provider.describe()).then(description=>{
            if(!description||description.protocol!=='arcane-native-builder/1'
                ||!Array.isArray(description.targets)||!description.targets.includes(targetId)){
                throw new ArcaneError(
                    ERROR_CODES.targetUnavailable,
                    `The selected native provider does not support target ${targetId}.`
                );
            }
            return description;
        });
        return providerDescriptionPromise;
    }

    async function plan({
        toolchainRoot,
        toolchain,
        appReleaseRoot,
        release,
        appDescriptor,
        dependencyReleases,
        minimumCoreVersion,
        protectedRoots,
        outputRoot,
        targetRequest,
        signal,
        onEvent
    }={}){
        await requireProviderTarget();
        return createNativeBuildPlan({
            nativeBuilder:provider,
            toolchainRoot,
            toolchain,
            appReleaseRoot,
            release,
            appDescriptor,
            dependencyReleases,
            minimumCoreVersion,
            protectedRoots,
            outputRoot,
            targetRequest:selectedNativeRequest(targetId,targetRequest),
            signal,
            onEvent
        });
    }

    return {
        protocol:TARGET_ADAPTER_PROTOCOL,
        id:definition.id,
        describe:async()=>{
            await requireProviderTarget();
            return {...describe(definition),status:'available',reason:null};
        },
        async doctor({toolchainRoot,toolchain,targetRequest,signal,onEvent}={}){
            throwIfAborted(signal);
            await requireProviderTarget();
            return provider.doctor({
                toolchainRoot,
                toolchain,
                targetRequest:selectedNativeRequest(targetId,targetRequest),
                signal,
                onEvent
            });
        },
        async prepare({toolchainRoot,targetRequest,signal,onEvent}={}){
            throwIfAborted(signal);
            await requireProviderTarget();
            return provider.prepare({
                toolchainRoot,
                targetRequest:selectedNativeRequest(targetId,targetRequest),
                signal,
                onEvent
            });
        },
        plan,
        async build({nativePlan,...options}={}){
            throwIfAborted(options.signal);
            await requireProviderTarget();
            const selectedPlan=nativePlan??await plan(options);
            const artifact=await executeNativeBuildPlan(selectedPlan,{
                expectedNativeBuilder:provider,
                expectedTarget:targetId,
                signal:options.signal,
                onEvent:options.onEvent
            });
            return {
                artifact,
                target:targetId,
                platform:selectedPlan.targetRequest.platform,
                architecture:selectedPlan.targetRequest.architecture,
                format:selectedPlan.targetRequest.format,
                signing:selectedPlan.targetRequest.signing,
                plan:selectedPlan
            };
        },
        async verify({toolchainRoot,toolchain,artifact,targetRequest,signal,onEvent}={}){
            throwIfAborted(signal);
            await requireProviderTarget();
            const selected=selectedArtifact(artifact);
            const result=await provider.verify({
                toolchainRoot,
                toolchain,
                artifact:selected,
                targetRequest:selectedNativeRequest(targetId,targetRequest),
                signal,
                onEvent
            });
            return {target:targetId,targetRequest,artifact:selected,result};
        },
        async run({toolchainRoot,toolchain,artifact,targetRequest,signal,onEvent}={}){
            throwIfAborted(signal);
            await requireProviderTarget();
            const selected=selectedArtifact(artifact);
            const result=await provider.run({
                toolchainRoot,
                toolchain,
                artifact:selected,
                targetRequest:selectedNativeRequest(targetId,targetRequest),
                signal,
                onEvent
            });
            return {target:targetId,targetRequest,artifact:selected,result};
        }
    };
}

export function listTargets(){
    return DEFINITIONS.map(describe);
}

export function getTargetAdapter(targetId){
    if(!TARGET_IDS.includes(targetId)||!adapters.has(targetId)){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `Unknown Arcane target: ${String(targetId)}.`,
            {details:{available:[...TARGET_IDS]}}
        );
    }
    return adapters.get(targetId);
}

export async function buildTarget(options={}){
    return getTargetAdapter(options.target).build(options);
}

export async function verifyTarget(options={}){
    return getTargetAdapter(options.target).verify(options);
}

export async function runTarget(options={}){
    return getTargetAdapter(options.target).run(options);
}
