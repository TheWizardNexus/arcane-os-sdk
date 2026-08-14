import {packageApp,verifyApp} from '../packager/core.mjs';
import {startDevServer} from '../dev-server.mjs';
import path from 'node:path';
import {
    TARGET_ADAPTER_PROTOCOL,
    TARGET_IDS
} from '../constants.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from '../errors.mjs';

const DEFINITIONS=Object.freeze([
    Object.freeze({
        id:'browser',
        displayName:'Browser/static',
        status:'available',
        platforms:['any'],
        architectures:['any'],
        formats:['directory'],
        signingModes:['none'],
        reason:null
    }),
    Object.freeze({
        id:'portable',
        displayName:'Portable native application',
        status:'deferred',
        platforms:['windows','linux'],
        architectures:['x64','arm64'],
        formats:['portable'],
        signingModes:['development','production'],
        reason:'The external single-app portable builder has not been extracted from Arcane OS.'
    }),
    Object.freeze({
        id:'windows-x64',
        displayName:'Windows x64 executable',
        status:'deferred',
        platforms:['windows'],
        architectures:['x64'],
        formats:['exe'],
        signingModes:['development','production'],
        reason:'The Windows builder still requires an explicit, external app-release input seam.'
    }),
    Object.freeze({
        id:'linux-x64',
        displayName:'Linux x64 executable',
        status:'deferred',
        platforms:['linux'],
        architectures:['x64'],
        formats:['appimage','deb','rpm'],
        signingModes:['development','production'],
        reason:'The Linux single-app native target adapter is planned but not implemented.'
    }),
    Object.freeze({
        id:'linux-arm64',
        displayName:'Linux ARM64 executable',
        status:'deferred',
        platforms:['linux'],
        architectures:['arm64'],
        formats:['appimage','deb','rpm'],
        signingModes:['development','production'],
        reason:'The Linux ARM64 single-app native target adapter is planned but not implemented.'
    }),
    Object.freeze({
        id:'android-arm64',
        displayName:'Android ARM64 application',
        status:'deferred',
        platforms:['android'],
        architectures:['arm64'],
        formats:['apk','aab'],
        signingModes:['development','production'],
        reason:'The Android single-app Gradle target adapter is planned but not implemented.'
    })
]);

function describe(definition){
    return {
        protocol:TARGET_ADAPTER_PROTOCOL,
        ...definition,
        platforms:[...definition.platforms],
        architectures:[...definition.architectures],
        formats:[...definition.formats],
        signingModes:[...definition.signingModes],
        methods:['describe','doctor','plan','build','verify','run']
    };
}

function deferredError(definition){
    return new ArcaneError(
        ERROR_CODES.targetDeferred,
        `Target ${definition.id} is deferred. ${definition.reason}`,
        {details:describe(definition)}
    );
}

function createDeferredAdapter(definition){
    const unavailable=async options=>{
        throwIfAborted(options?.signal);
        throw deferredError(definition);
    };
    return Object.freeze({
        protocol:TARGET_ADAPTER_PROTOCOL,
        id:definition.id,
        describe:async()=>describe(definition),
        doctor:async()=>({
            target:definition.id,
            status:'deferred',
            ready:false,
            reason:definition.reason
        }),
        plan:unavailable,
        build:unavailable,
        verify:unavailable,
        run:unavailable
    });
}

const browserDefinition=DEFINITIONS[0];
const browserAdapter=Object.freeze({
    protocol:TARGET_ADAPTER_PROTOCOL,
    id:'browser',
    describe:async()=>describe(browserDefinition),
    doctor:async()=>({target:'browser',status:'available',ready:true}),
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
            operations:['verify-sdk-runtime','validate-workspace','package-selected-app']
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
        validateSourceState
    }={}){
        await this.plan({workspaceRoot,appId,format,signing,signal});
        throwIfAborted(signal);
        const release=await packageApp({
            workspaceRoot,
            appId,
            dryRun,
            signal,
            onEvent,
            validateSourceState
        });
        return {target:'browser',format,signing,release};
    },
    async verify({workspaceRoot,appId,signal,onEvent}={}){
        throwIfAborted(signal);
        return {target:'browser',release:await verifyApp({workspaceRoot,appId,signal,onEvent})};
    },
    async run({workspaceRoot,appId,host='127.0.0.1',port=0,signal,onEvent}={}){
        throwIfAborted(signal);
        const verified=await verifyApp({workspaceRoot,appId,signal,onEvent});
        const server=await startDevServer({
            workspaceRoot,
            appId,
            mode:'packaged',
            releaseRoot:path.join(workspaceRoot,'dist',appId),
            releaseReceipt:verified.receipt,
            host,
            port,
            signal,
            onEvent
        });
        return {...server,target:'browser',verified};
    }
});

const adapters=new Map([
    ['browser',browserAdapter],
    ...DEFINITIONS.slice(1).map(definition=>[
        definition.id,
        createDeferredAdapter(definition)
    ])
]);

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
    const adapter=getTargetAdapter(options.target);
    return adapter.build(options);
}

export async function verifyTarget(options={}){
    const adapter=getTargetAdapter(options.target);
    return adapter.verify(options);
}

export async function runTarget(options={}){
    const adapter=getTargetAdapter(options.target);
    return adapter.run(options);
}
