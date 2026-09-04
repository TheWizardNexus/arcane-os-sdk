import path from 'node:path';
import {readdir,lstat,realpath} from 'node:fs/promises';
import {createWorkspace,initWorkspace} from './scaffold.mjs';
import {
    discoverApps as discoverWorkspaceApps,
    inspectWorkspaceProfile,
    resolveWorkspace,
    validateDiscoveredApplication,
    validateWorkspace
} from './workspace.mjs';
import {loadArcaneIntegratedProvider} from './integrated-provider-loader.mjs';
import {startDevServer} from './dev-server.mjs';
import {generateImportMap,readApplicationTestImportMapContext} from './import-map.mjs';
import {withWorkspaceOperationLock} from './workspace-operation-lock.mjs';
import {
    inspectApp as inspectPackagedApp,
    packageApp,
    verifyApp
} from './packager/core.mjs';
import {runDoctor} from './doctor.mjs';
import {runProcess} from './process.mjs';
import {runApplicationTests} from './application-tests.mjs';
import {
    buildTarget,
    createNativeTargetAdapter,
    getTargetAdapter,
    listTargets,
    runTarget
} from './targets/index.mjs';
import {runRepositoryAction} from './repository.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {createEventQueue} from './event-queue.mjs';
import {ARCANE_MACHINE_BUNDLE_VERSION} from './constants.mjs';
import {checkForSdkUpdate} from './update-check.mjs';
import {executeMailCommand} from './mail.mjs';
import {
    APP_BUNDLE_EXTENSION,
    createAppReleaseBundle,
    verifyAppReleaseBundle
} from './release-bundle.mjs';

async function emit(onEvent,event){
    await onEvent?.(event);
}

function withEventDeliveryFailure(result,error){
    const eventDelivery={
        status:'degraded',
        errorCode:'ARCANE_EVENT_DELIVERY_FAILED',
        message:String(error?.message??error)
    };
    if(result?.built?.artifact){
        return {...result,built:{...result.built,eventDelivery}};
    }
    return {...result,eventDelivery};
}

function isOuterCommitEvent(label,event){
    if(label==='build')return event?.type==='native.build.completed';
    return label==='bundle'&&event?.type==='bundle.completed'
        &&event?.phase==='publish'&&event?.status==='completed';
}

function hasCommittedOuterResult(label,result){
    if(label==='import-map')return result?.committed===true;
    if(label==='package')return typeof result?.outputRoot==='string';
    if(label==='bundle')return typeof result?.bundlePath==='string';
    if(label!=='build')return false;
    return result?.artifact!=null||typeof result?.release?.outputRoot==='string';
}

async function ownedWork(label,work,{
    signal,
    onEvent,
    heartbeatMs=5000,
    workspaceRoot
}={}){
    throwIfAborted(signal);
    const controller=new AbortController();
    const forwardAbort=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',forwardAbort,{once:true});
    if(signal?.aborted){
        forwardAbort();
    }
    throwIfAborted(controller.signal);
    let committed=false;
    const events=createEventQueue(onEvent,{
        onFailure:error=>{
            if(!committed||label==='run')controller.abort(error);
        }
    });
    const forwardEvent=async event=>{
        if(isOuterCommitEvent(label,event))committed=true;
        try{
            await events.send(event);
        }catch(error){
            if(!committed||label==='run')throw error;
        }
    };
    const abort=()=>{
        void events.enqueue({
            type:`${label}.cancellation-pending`,
            message:`${label} will stop at the next safe boundary.`
        });
    };
    let heartbeat=null;
    let producersStopped=false;
    const stopProducers=()=>{
        if(producersStopped){
            return;
        }
        producersStopped=true;
        clearInterval(heartbeat);
        controller.signal.removeEventListener('abort',abort);
        signal?.removeEventListener('abort',forwardAbort);
    };
    try{
        await events.send({type:`${label}.started`,message:`${label} started.`});
        controller.signal.addEventListener('abort',abort,{once:true});
        heartbeat=setInterval(()=>{
            void events.enqueue(
                {type:`${label}.heartbeat`,message:`${label} is still running.`},
                {coalesce:`${label}.heartbeat`}
            );
        },Math.max(1000,heartbeatMs));
        heartbeat.unref?.();
        const execute=workspaceOperationLease=>work({
            signal:controller.signal,
            onEvent:forwardEvent,
            workspaceOperationLease
        });
        const mutating=new Set(['import-map','package','bundle','build','run']).has(label);
        const result=mutating&&workspaceRoot
            ?await withWorkspaceOperationLock({
                workspaceRoot,
                operation:label,
                signal:controller.signal,
                onEvent:forwardEvent
            },execute)
            :await execute();
        if(hasCommittedOuterResult(label,result))committed=true;
        stopProducers();
        if(!committed||label==='run')throwIfAborted(controller.signal);
        try{
            await events.send({type:`${label}.completed`,message:`${label} completed.`});
            await events.drain();
        }catch(error){
            if(committed){
                if(label==='run')throwIfAborted(controller.signal);
                return withEventDeliveryFailure(result,error);
            }
            throw error;
        }
        if(!committed||label==='run')throwIfAborted(controller.signal);
        if(events.error&&committed)return withEventDeliveryFailure(result,events.error);
        return result;
    }catch(error){
        stopProducers();
        try{
            await events.drain();
        }catch(callbackFailure){
            throw callbackFailure;
        }
        throw error;
    }finally{
        stopProducers();
    }
}

async function selectedWorkspace(options){
    const resolved=await resolveWorkspace({
        workspaceRoot:options.workspaceRoot,
        appId:options.appId
    });
    return {
        workspaceRoot:resolved.workspaceRoot,
        workspaceMode:resolved.config.workspaceMode,
        appId:resolved.appId??resolved.app?.id??resolved.app?.appId,
        appRoot:resolved.appRoot??resolved.app?.appRoot
    };
}

function operationScope(options){
    const scope=options.scope??'app';
    if(!['app','shared'].includes(scope)){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `Unsupported Arcane development scope: ${String(scope)}. Expected app or shared.`
        );
    }
    return scope;
}

function assertApplicationScope(options,operation){
    if(operationScope(options)!=='app'){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `${operation} supports only --scope app. Shared development cannot package or build application output.`
        );
    }
}

async function executeIntegratedSharedOperation(operation,options){
    const label=operation==='focused-test'?'shared.test':'shared.check';
    return ownedWork(
        label,
        async({signal,onEvent})=>{
            const profile=await inspectWorkspaceProfile(options.workspaceRoot);
            if(profile.workspaceMode!=='integrated'){
                throw new ArcaneError(
                    ERROR_CODES.policyDenied,
                    `--scope shared is available only in an integrated Arcane OS workspace.`
                );
            }
            const provider=await loadArcaneIntegratedProvider({
                arcaneRoot:profile.workspaceRoot,
                signal,
                onEvent,
                run:options.processRunner??runProcess
            });
            const result=await provider.execute({
                operation,
                ...(operation==='focused-test'?{testFile:options.testFile}:{}),
                signal,
                onEvent
            });
            return {
                scope:'shared',
                workspaceMode:'integrated',
                workspaceRoot:profile.workspaceRoot,
                result
            };
        },
        options
    );
}

async function preparedWorkspace(options){
    const workspace=await validateWorkspace({
        workspaceRoot:options.workspaceRoot,
        appId:options.appId,
        allowMissingManagedImportMap:Boolean(options.allowMissingManagedImportMap),
        signal:options.signal,
        onEvent:options.onEvent
    });
    const external=workspace.workspaceMode==='external';
    if(external&&(!workspace.sdkInstallation
        ||typeof workspace.sdkInstallation.runtimeRoot!=='string'
        ||typeof workspace.sdkInstallation.browserRuntimeRoot!=='string')){
        throw new ArcaneError(
            ERROR_CODES.workspaceInvalid,
            'Validated external workspace is missing its SDK runtime directories.'
        );
    }
    const runtimeRoot=external
        ?workspace.sdkInstallation.runtimeRoot
        :workspace.workspaceRoot;
    const browserRuntimeRoot=external
        ?workspace.sdkInstallation.browserRuntimeRoot
        :null;
    return {
        runtimeRoot,
        browserRuntimeRoot,
        workspaceMode:workspace.workspaceMode,
        descriptor:workspace.app.descriptor,
        descriptorSource:workspace.app.descriptorSource,
        workspaceRoot:workspace.workspaceRoot,
        appId:workspace.appId,
        appRoot:workspace.appRoot,
        validation:workspace
    };
}

async function validatePreparedRuntime(prepared,{signal}={}){
    const validation=await validateWorkspace({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        signal
    });
    if(validation.workspaceMode!==prepared.workspaceMode){
        throw new ArcaneError(ERROR_CODES.workspaceInvalid,'The Arcane workspace profile changed during the operation.');
    }
    return validation;
}

async function refreshPreparedImportMap(prepared,{signal,onEvent,workspaceOperationLease}={}){
    const manifest=prepared.validation.app.manifest;
    const inspected=await inspectPackagedApp({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        signal
    });
    if(inspected.entry!==manifest.entry
        ||JSON.stringify(inspected.include)!==JSON.stringify(manifest.include)
        ||JSON.stringify(inspected.exclude)!==JSON.stringify(manifest.exclude)){
        throw new ArcaneError(
            ERROR_CODES.workspaceInvalid,
            'The selected application package descriptor changed before import-map refresh.'
        );
    }
    return generateImportMap({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        appRoot:prepared.appRoot,
        entry:manifest.entry,
        documents:inspected.browserDocuments.map(function selectBrowserDocumentPath(document){
            return document.path;
        }),
        workspaceOperationLease,
        signal,
        onEvent
    });
}

async function importMapApplication(options={}){
    assertApplicationScope(options,'Import-map generation');
    const prepared=await preparedWorkspace({...options,allowMissingManagedImportMap:true});
    const importMap=await ownedWork(
        'import-map',
        context=>refreshPreparedImportMap(prepared,context),
        {...options,workspaceRoot:prepared.workspaceRoot}
    );
    await validatePreparedRuntime(prepared,{signal:options.signal});
    return {
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        importMap
    };
}

export async function createApplication(options={}){
    return createWorkspace(options);
}

export async function initializeApplication(options={}){
    return initWorkspace(options);
}

export async function upgradeApplication(options={}){
    assertApplicationScope(options,'Workspace upgrade');
    const selected=await resolveWorkspace({
        workspaceRoot:options.workspaceRoot,
        appId:options.appId
    });
    if(selected.config.workspaceMode!=='external'){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            'Workspace upgrade is available only to installed-SDK external workspaces.'
        );
    }
    const result=await runProcess('npm',['upgrade'],{
        cwd:selected.workspaceRoot,
        signal:options.signal,
        onEvent:options.onEvent
    });
    return {
        schemaVersion:1,
        kind:'arcane-application-upgrade',
        workspaceRoot:selected.workspaceRoot,
        workspaceMode:selected.config.workspaceMode,
        appId:selected.appId,
        ...result
    };
}

export async function doctorApplication(options={}){
    const result=await runDoctor(options);
    if(!result.ok){
        throw new ArcaneError(
            ERROR_CODES.prerequisiteMissing,
            'One or more required Arcane development prerequisites failed.',
            {details:result}
        );
    }
    return result;
}

async function runPreparedApplicationTests(prepared,options={}){
    throwIfAborted(options.signal);
    const managedImportMapContext=await readApplicationTestImportMapContext({
        workspaceRoot:prepared.workspaceRoot,
        applicationRoot:prepared.appRoot,
        signal:options.signal
    });
    return runApplicationTests({
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        appRoot:prepared.appRoot,
        managedImportMapContext,
        signal:options.signal,
        onEvent:options.onEvent
    });
}

export async function testApplication(options={}){
    throwIfAborted(options.signal);
    if(operationScope(options)==='shared'){
        if(typeof options.testFile!=='string'||!options.testFile){
            throw new ArcaneError(
                ERROR_CODES.usage,
                'Shared testing requires one exact repo-relative .test.mjs file.'
            );
        }
        return executeIntegratedSharedOperation('focused-test',options);
    }
    const prepared=await preparedWorkspace({...options,allowMissingManagedImportMap:true});
    return runPreparedApplicationTests(prepared,options);
}

export async function checkApplication(options={}){
    if(operationScope(options)==='shared'){
        if(options.skipTests){
            throw new ArcaneError(ERROR_CODES.usage,'Shared check does not accept skipTests.');
        }
        return executeIntegratedSharedOperation('development-check',options);
    }
    const prepared=await preparedWorkspace({...options,allowMissingManagedImportMap:true});
    const tests=options.skipTests
        ?{
            passed:true,
            skipped:true,
            testFiles:[],
            output:''
        }
        :await runPreparedApplicationTests(prepared,options);
    await validatePreparedRuntime(prepared,{signal:options.signal});
    return {
        ok:true,
        workspaceMode:prepared.workspaceMode,
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        descriptorSource:prepared.descriptorSource,
        runtime:{
            mode:prepared.workspaceMode==='external'?'sdk':'workspace',
            sourceRoot:'arcane'
        },
        checks:prepared.validation.checks,
        tests
    };
}

export async function developApplication(options={}){
    assertApplicationScope(options,'Development serving');
    const prepared=await preparedWorkspace({...options,allowMissingManagedImportMap:true});
    await withWorkspaceOperationLock({
        workspaceRoot:prepared.workspaceRoot,
        operation:'dev-refresh',
        signal:options.signal,
        onEvent:options.onEvent
    },workspaceOperationLease=>refreshPreparedImportMap(prepared,{
        ...options,
        workspaceOperationLease
    }));
    const server=await startDevServer({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        mode:'source',
        workspaceMode:prepared.workspaceMode,
        ...(options.sdkRuntimeSourceRoot===undefined?{}:{
            sdkRuntimeSourceRoot:options.sdkRuntimeSourceRoot
        }),
        host:options.host,
        port:options.port,
        signal:options.signal,
        onEvent:options.onEvent
    });
    return {...server,appId:prepared.appId,mode:'source'};
}

export async function packageApplication(options={}){
    assertApplicationScope(options,'Packaging');
    const prepared=await preparedWorkspace({
        ...options,
        allowMissingManagedImportMap:!options.dryRun
    });
    const release=await ownedWork(
        'package',
        async({signal,onEvent,workspaceOperationLease})=>{
            return packageApp({
                workspaceRoot:prepared.workspaceRoot,
                appId:prepared.appId,
                dryRun:Boolean(options.dryRun),
                signal,
                onEvent,
                workspaceOperationLease
            });
        },
        {...options,workspaceRoot:prepared.workspaceRoot}
    );
    return {
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        release
    };
}

export async function verifyApplication(options={}){
    assertApplicationScope(options,'Package verification');
    const prepared=await preparedWorkspace(options);
    const release=await ownedWork(
        'verify',
        ({signal,onEvent})=>verifyApp({
            workspaceRoot:prepared.workspaceRoot,
            appId:prepared.appId,
            signal,
            onEvent
        }),
        {...options,workspaceRoot:prepared.workspaceRoot}
    );
    await validatePreparedRuntime(prepared,{signal:options.signal});
    return {
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        release
    };
}

export async function bundleApplication(options={}){
    assertApplicationScope(options,'Release bundling');
    if(options.overwrite!==undefined&&typeof options.overwrite!=='boolean'){
        throw new ArcaneError(ERROR_CODES.usage,'overwrite must be a literal boolean.');
    }
    const prepared=await preparedWorkspace(options);
    const bundle=await ownedWork(
        'bundle',
        async({signal,onEvent})=>{
            const verified=await verifyApp({
                workspaceRoot:prepared.workspaceRoot,
                appId:prepared.appId,
                signal,
                onEvent
            });
            await validatePreparedRuntime(prepared,{signal});
            const releaseRoot=verified.outputRoot;
            const outputPath=options.artifactPath??path.join(
                path.dirname(releaseRoot),
                `${prepared.appId}-${verified.version}${APP_BUNDLE_EXTENSION}`
            );
            return createAppReleaseBundle({
                releaseRoot,
                appDescriptor:prepared.descriptor,
                outputPath,
                overwrite:options.overwrite,
                signal,
                onEvent
            });
        },
        {...options,workspaceRoot:prepared.workspaceRoot}
    );
    return {
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        bundle
    };
}

export async function verifyBundleApplication(options={}){
    return ownedWork(
        'verify-bundle',
        ({signal,onEvent})=>verifyAppReleaseBundle({
            bundlePath:options.artifactPath,
            signal,
            onEvent
        }),
        options
    );
}

function targetSelection(options){
    const target=options.target??options.targetRequest?.target;
    const registered=getTargetAdapter(target);
    if(target!=='browser'&&options.nativeBuilder!=null){
        return {
            target,
            adapter:createNativeTargetAdapter({
                targetId:target,
                nativeBuilder:options.nativeBuilder
            })
        };
    }
    return {target,adapter:registered};
}

export async function planApplication(options={}){
    assertApplicationScope(options,'Target planning');
    const {target,adapter}=targetSelection(options);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return adapter.plan({...options,target});
    }
    if(target==='browser'){
        const prepared=await preparedWorkspace(options);
        return ownedWork(
            'plan',
            ({signal,onEvent})=>adapter.plan({
                ...options,
                ...prepared,
                target,
                signal,
                onEvent
            }),
            options
        );
    }
    return ownedWork(
        'plan',
        ({signal,onEvent})=>adapter.plan({...options,target,signal,onEvent}),
        options
    );
}

export async function doctorNativeTarget(options={}){
    const {target,adapter}=targetSelection(options);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return adapter.doctor({...options,target});
    }
    if(target==='browser'){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            'Native target doctor requires one explicitly selected native target.'
        );
    }
    return ownedWork(
        'native.doctor',
        ({signal,onEvent})=>adapter.doctor({...options,target,signal,onEvent}),
        options
    );
}

export async function prepareNativeTarget(options={}){
    const {target,adapter}=targetSelection(options);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return adapter.prepare({...options,target});
    }
    if(target==='browser'){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            'Native target preparation requires one explicitly selected native target.'
        );
    }
    return ownedWork(
        'native.prepare',
        ({signal,onEvent})=>adapter.prepare({...options,target,signal,onEvent}),
        options
    );
}

function sameOrDescendant(parent,candidate){
    const relative=path.relative(path.resolve(parent),path.resolve(candidate));
    return relative===''||Boolean(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
}

export function resolveNativeBuildOutputRoot({target,workspaceMode,workspaceRoot,outputRoot}={}){
    if(typeof target!=='string'||!target||target==='browser'){
        throw new ArcaneError(ERROR_CODES.usage,'A native output root requires one explicit native target.');
    }
    if(workspaceMode==='integrated'&&!outputRoot){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `An integrated ${target} build requires --output-root outside the Arcane OS checkout.`
        );
    }
    const resolved=path.resolve(outputRoot??path.join(workspaceRoot,'build',target));
    if(workspaceMode==='integrated'&&sameOrDescendant(workspaceRoot,resolved)){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            `An integrated ${target} output root must be outside the Arcane OS checkout.`
        );
    }
    if(workspaceMode==='external'&&sameOrDescendant(workspaceRoot,resolved)){
        const buildRoot=path.resolve(workspaceRoot,'build');
        if(!sameOrDescendant(buildRoot,resolved)){
            throw new ArcaneError(
                ERROR_CODES.policyDenied,
                `An external ${target} output inside the app workspace must remain under its dedicated build/ namespace.`
            );
        }
    }
    return resolved;
}

function sameCanonicalPath(left,right){
    const normalize=value=>{
        const normalized=path.normalize(path.resolve(value));
        return process.platform==='win32'?normalized.toLowerCase():normalized;
    };
    return normalize(left)===normalize(right);
}

export function assertIntegratedNativeToolchain({workspaceMode,workspaceRoot,toolchainRoot,target}={}){
    if(workspaceMode!=='integrated')return;
    if(typeof toolchainRoot!=='string'||!sameCanonicalPath(workspaceRoot,toolchainRoot)){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            `An integrated ${target??'native'} build must use the same Arcane OS checkout for --workspace and --arcane-root.`
        );
    }
}

export async function verifyNativeArtifact(options={}){
    const {target,adapter}=targetSelection(options);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return adapter.verify({...options,target});
    }
    if(target==='browser'){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            'Native artifact verification requires one explicitly selected native target.'
        );
    }
    return ownedWork(
        'native.verify',
        ({signal,onEvent})=>adapter.verify({...options,target,signal,onEvent}),
        options
    );
}

function nativeDependencyError(message,code=ERROR_CODES.workspaceInvalid){
    throw new ArcaneError(code,message);
}

async function nativeDependencyClosure(prepared,{target,signal,onEvent}={}){
    throwIfAborted(signal);
    const apps=await discoverWorkspaceApps(prepared.workspaceRoot);
    const byId=new Map(apps.map(app=>[app.appId,app]));
    const selected=byId.get(prepared.appId);
    if(!selected){
        nativeDependencyError(`The selected app ${prepared.appId} disappeared during native build preflight.`);
    }
    if(JSON.stringify(selected.descriptor)!==JSON.stringify(prepared.descriptor)){
        nativeDependencyError(
            `The selected app ${prepared.appId} descriptor changed during native build preflight.`,
            ERROR_CODES.workspaceInvalid
        );
    }
    if(!prepared.descriptor.targets.includes(target)){
        nativeDependencyError(
            `App ${prepared.appId} does not declare target ${target}.`,
            ERROR_CODES.targetUnavailable
        );
    }

    const visiting=new Set([prepared.appId]);
    const visited=new Set();
    const dependencies=[];
    function visit(descriptor){
        for(const dependencyId of descriptor.native.bundledApps){
            if(visiting.has(dependencyId)){
                nativeDependencyError(`Bundled app dependency cycle includes ${dependencyId}.`);
            }
            if(visited.has(dependencyId))continue;
            const dependency=byId.get(dependencyId);
            if(!dependency){
                nativeDependencyError(
                    `Bundled app dependency ${dependencyId} must be present in the same Arcane workspace.`
                );
            }
            if(!dependency.descriptor.targets.includes(target)){
                nativeDependencyError(
                    `Bundled app dependency ${dependencyId} does not declare target ${target}.`,
                    ERROR_CODES.targetUnavailable
                );
            }
            visiting.add(dependencyId);
            visit(dependency.descriptor);
            visiting.delete(dependencyId);
            visited.add(dependencyId);
            dependencies.push(dependency);
        }
    }
    visit(prepared.descriptor);
    dependencies.sort((left,right)=>left.appId.localeCompare(right.appId,'en'));

    const validated=[];
    for(const dependency of dependencies){
        throwIfAborted(signal);
        const validation=await validateDiscoveredApplication({
            workspaceRoot:prepared.workspaceRoot,
            workspaceMode:prepared.workspaceMode,
            app:dependency,
            signal,
            onEvent
        });
        validated.push({
            ...dependency,
            descriptor:validation.app.descriptor,
            validation
        });
    }
    return validated;
}

async function externalWorkspaceProtectedRoots(prepared,{signal}={}){
    if(prepared.workspaceMode!=='external')return [await realpath(prepared.workspaceRoot)];
    const protectedRoots=[];
    const entries=await readdir(prepared.workspaceRoot,{withFileTypes:true});
    for(const entry of entries.sort((left,right)=>left.name.localeCompare(right.name,'en'))){
        throwIfAborted(signal);
        if(entry.name==='build')continue;
        if(entry.isDirectory()||entry.isSymbolicLink()){
            const candidate=path.join(prepared.workspaceRoot,entry.name);
            const info=await lstat(candidate);
            if(info.isSymbolicLink()){
                const canonical=await realpath(candidate);
                const canonicalInfo=await lstat(canonical);
                if(canonicalInfo.isDirectory())protectedRoots.push(canonical);
            }else if(info.isDirectory()){
                protectedRoots.push(await realpath(candidate));
            }
        }
    }
    return protectedRoots;
}

async function canonicalNativeOutputRoot(outputRoot,{signal}={}){
    let cursor=path.resolve(outputRoot);
    const missing=[];
    while(true){
        throwIfAborted(signal);
        try{
            const info=await lstat(cursor);
            if(info.isSymbolicLink()||!info.isDirectory()){
                throw new ArcaneError(
                    ERROR_CODES.policyDenied,
                    'The native output root must not use a linked or non-directory ancestor.'
                );
            }
            return path.join(await realpath(cursor),...missing.reverse());
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
            const parent=path.dirname(cursor);
            if(parent===cursor)throw error;
            missing.push(path.basename(cursor));
            cursor=parent;
        }
    }
}

function pathsOverlap(left,right){
    return sameOrDescendant(left,right)||sameOrDescendant(right,left);
}

async function packageNativeRelease(prepared,app,{
    workspaceOperationLease,
    signal,
    onEvent
}={}){
    const release=await packageApp({
        workspaceRoot:prepared.workspaceRoot,
        appId:app.appId,
        workspaceOperationLease,
        signal,
        onEvent
    });
    return {
        appId:app.appId,
        appRoot:app.appRoot,
        descriptor:app.descriptor,
        release,
        nativeInput:{
            appDescriptor:app.descriptor,
            appReleaseRoot:release.outputRoot??path.resolve(prepared.workspaceRoot,release.output),
            release:{manifest:release.manifest,files:[...release.files]}
        }
    };
}

async function executePairedNativeBuild(options,adapter,{
    signal,
    onEvent,
    workspaceOperationLease
}={}){
    const target=options.target??options.targetRequest?.target;
    const initialPrepared=await preparedWorkspace({...options,signal,onEvent});
    assertIntegratedNativeToolchain({
        target,
        workspaceMode:initialPrepared.workspaceMode,
        workspaceRoot:initialPrepared.workspaceRoot,
        toolchainRoot:options.toolchainRoot
    });
    if(options.dryRun){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `${target} native build does not support --dry-run because the native provider needs materialized app files.`
        );
    }
    const requestedOutputRoot=resolveNativeBuildOutputRoot({
        target,
        workspaceMode:initialPrepared.workspaceMode,
        workspaceRoot:initialPrepared.workspaceRoot,
        outputRoot:options.outputRoot
    });
    const protectedRoots=await externalWorkspaceProtectedRoots(initialPrepared,{signal});
    const outputRoot=await canonicalNativeOutputRoot(requestedOutputRoot,{signal});
    if(protectedRoots.some(root=>pathsOverlap(root,outputRoot))){
        throw new ArcaneError(
            ERROR_CODES.policyDenied,
            'The native output root must not overlap an application workspace source or control directory.'
        );
    }
    const dependencyApps=await nativeDependencyClosure(initialPrepared,{target,signal,onEvent});
    const prepared=initialPrepared;
    const selectedRelease=await packageNativeRelease(prepared,{
        appId:prepared.appId,
        appRoot:prepared.appRoot,
        manifest:prepared.validation.app.manifest,
        descriptor:prepared.descriptor,
        descriptorSource:prepared.validation.app.descriptorSource,
        descriptorPath:prepared.validation.app.descriptorPath,
        validation:prepared.validation
    },{workspaceOperationLease,signal,onEvent});
    const dependencyReleases=[];
    for(const dependency of dependencyApps){
        dependencyReleases.push(await packageNativeRelease(
            prepared,
            dependency,
            {workspaceOperationLease,signal,onEvent}
        ));
    }
    const toolchain=await adapter.prepare({
        toolchainRoot:options.toolchainRoot,
        targetRequest:options.targetRequest,
        signal,
        onEvent
    });
    protectedRoots.push(...(options.protectedRoots??[]));
    const built=await adapter.build({
        nativeBuilder:options.nativeBuilder,
        toolchainRoot:options.toolchainRoot,
        toolchain,
        ...selectedRelease.nativeInput,
        dependencyReleases:dependencyReleases.map(item=>item.nativeInput),
        minimumCoreVersion:ARCANE_MACHINE_BUNDLE_VERSION,
        protectedRoots,
        outputRoot,
        targetRequest:options.targetRequest,
        signal,
        onEvent
    });
    return {
        prepared,
        outputRoot,
        toolchain,
        selectedRelease,
        dependencyReleases,
        built
    };
}

function nativeBuildResult(assembly){
    const {prepared}=assembly;
    return {
        ...assembly.built,
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        release:assembly.selectedRelease.release,
        dependencyReleases:assembly.dependencyReleases.map(item=>({
            appId:item.appId,
            release:item.release
        }))
    };
}

function usesWorkspaceNativeAssembly(options){
    return options.nativeBuilder!=null
        &&typeof options.workspaceRoot==='string'
        &&options.release==null
        &&options.appReleaseRoot==null
        &&options.appDescriptor==null;
}

export async function buildApplication(options={}){
    assertApplicationScope(options,'Building');
    const {target,adapter}=targetSelection(options);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return adapter.build({...options,target});
    }
    if(target!=='browser'){
        if(usesWorkspaceNativeAssembly(options)&&options.nativePlan==null){
            const assembly=await ownedWork(
                'build',
                context=>executePairedNativeBuild(options,adapter,context),
                options
            );
            return nativeBuildResult(assembly);
        }
        return ownedWork(
            'build',
            ({signal,onEvent})=>adapter.build({...options,target,signal,onEvent}),
            options
        );
    }
    const prepared=await preparedWorkspace({
        ...options,
        allowMissingManagedImportMap:!options.dryRun
    });
    const result=await ownedWork(
        'build',
        ({signal,onEvent,workspaceOperationLease})=>buildTarget({
                ...options,
                ...prepared,
                signal,
                onEvent,
                workspaceOperationLease
            }),
        {...options,workspaceRoot:prepared.workspaceRoot}
    );
    return {
        ...result,
        workspaceMode:prepared.workspaceMode
    };
}

export async function runApplication(options={}){
    assertApplicationScope(options,'Running');
    const selectedOptions=options.target==null&&options.targetRequest?.target==null
        ?{...options,target:'browser'}
        :options;
    const {target,adapter}=targetSelection(selectedOptions);
    if(target==='portable'){
        throw new ArcaneError(
            ERROR_CODES.nativeRunUnsupported,
            'The portable target is a verified directory payload and cannot be launched. Select an executable target such as windows-x64 or linux-x64.'
        );
    }
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return adapter.run({...selectedOptions,target});
    }
    if(target!=='browser'){
        if(usesWorkspaceNativeAssembly(selectedOptions)&&selectedOptions.artifact==null){
            return ownedWork(
                'run',
                async context=>{
                    const assembly=await executePairedNativeBuild(selectedOptions,adapter,context);
                    const launched=await adapter.run({
                        toolchainRoot:selectedOptions.toolchainRoot,
                        toolchain:assembly.toolchain,
                        artifact:assembly.built.artifact,
                        targetRequest:selectedOptions.targetRequest,
                        signal:context.signal,
                        onEvent:context.onEvent
                    });
                    return {...nativeBuildResult(assembly),run:launched};
                },
                selectedOptions
            );
        }
        return ownedWork(
            'run',
            ({signal,onEvent})=>adapter.run({...selectedOptions,target,signal,onEvent}),
            selectedOptions
        );
    }
    const prepared=await preparedWorkspace(selectedOptions);
    return runTarget({
        ...selectedOptions,
        ...prepared,
        target
    });
}

export async function describeTargets(options={}){
    const targets=listTargets();
    const pairedTarget=options.target??options.targetRequest?.target;
    if(options.nativeBuilder==null||pairedTarget==null||pairedTarget==='browser'){
        return {protocol:'arcane-target-adapter/1',targets};
    }
    const pairedAdapter=createNativeTargetAdapter({
        targetId:pairedTarget,
        nativeBuilder:options.nativeBuilder
    });
    await pairedAdapter.describe();
    return {
        protocol:'arcane-target-adapter/1',
        targets:targets.map(target=>target.id===pairedTarget
            ?{...target,status:'available',reason:null}
            :target)
    };
}

export async function repositoryApplication(options={}){
    return runRepositoryAction(options.action,options);
}

export async function checkSdkUpdate(options={}){
    return checkForSdkUpdate(options);
}

export async function executeOperation(command,options={}){
    const operations={
        new:createApplication,
        init:initializeApplication,
        upgrade:upgradeApplication,
        doctor:doctorApplication,
        'import-map':importMapApplication,
        dev:developApplication,
        test:testApplication,
        check:checkApplication,
        package:packageApplication,
        verify:verifyApplication,
        bundle:bundleApplication,
        'verify-bundle':verifyBundleApplication,
        'native-doctor':doctorNativeTarget,
        'native-prepare':prepareNativeTarget,
        'native-verify':verifyNativeArtifact,
        plan:planApplication,
        build:buildApplication,
        run:runApplication,
        'update-check':checkSdkUpdate,
        mail:executeMailCommand,
        targets:async options=>describeTargets(options),
        repo:repositoryApplication
    };
    const operation=operations[command];
    if(!operation){
        throw new ArcaneError(ERROR_CODES.usage,`Unknown Arcane command: ${String(command)}.`);
    }
    return operation(options);
}

export function createToolchain(defaults={}){
    return {
        execute:(command,options={})=>executeOperation(command,{...defaults,...options}),
        create:options=>createApplication({...defaults,...options}),
        init:options=>initializeApplication({...defaults,...options}),
        upgrade:options=>upgradeApplication({...defaults,...options}),
        doctor:options=>doctorApplication({...defaults,...options}),
        importMap:options=>importMapApplication({...defaults,...options}),
        dev:options=>developApplication({...defaults,...options}),
        test:options=>testApplication({...defaults,...options}),
        check:options=>checkApplication({...defaults,...options}),
        package:options=>packageApplication({...defaults,...options}),
        verify:options=>verifyApplication({...defaults,...options}),
        bundle:options=>bundleApplication({...defaults,...options}),
        verifyBundle:options=>verifyBundleApplication({...defaults,...options}),
        doctorNative:options=>doctorNativeTarget({...defaults,...options}),
        prepareNative:options=>prepareNativeTarget({...defaults,...options}),
        verifyNative:options=>verifyNativeArtifact({...defaults,...options}),
        plan:options=>planApplication({...defaults,...options}),
        build:options=>buildApplication({...defaults,...options}),
        run:options=>runApplication({...defaults,...options}),
        updateCheck:options=>checkSdkUpdate({...defaults,...options}),
        mail:options=>executeMailCommand({...defaults,...options}),
        targets:options=>describeTargets({...defaults,...options}),
        repository:options=>repositoryApplication({...defaults,...options})
    };
}
