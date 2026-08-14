import path from 'node:path';
import {readdir,lstat} from 'node:fs/promises';
import {createWorkspace,initWorkspace} from './scaffold.mjs';
import {resolveWorkspace,validateWorkspace} from './workspace.mjs';
import {startDevServer} from './dev-server.mjs';
import {authenticateRuntimeReceipt,verifyRuntime} from './runtime.mjs';
import {packageApp,verifyApp} from './packager/core.mjs';
import {runDoctor} from './doctor.mjs';
import {runProcess} from './process.mjs';
import {buildTarget,getTargetAdapter,listTargets,runTarget} from './targets/index.mjs';
import {runRepositoryAction} from './repository.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {createEventQueue} from './event-queue.mjs';

async function emit(onEvent,event){
    await onEvent?.(event);
}

async function ownedWork(label,work,{signal,onEvent,heartbeatMs=5000}={}){
    throwIfAborted(signal);
    const controller=new AbortController();
    const forwardAbort=()=>controller.abort(signal?.reason);
    signal?.addEventListener('abort',forwardAbort,{once:true});
    if(signal?.aborted){
        forwardAbort();
    }
    throwIfAborted(controller.signal);
    const events=createEventQueue(onEvent,{
        onFailure:error=>controller.abort(error)
    });
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
        const result=await work({
            signal:controller.signal,
            onEvent:event=>events.send(event)
        });
        stopProducers();
        throwIfAborted(controller.signal);
        await events.send({type:`${label}.completed`,message:`${label} completed.`});
        await events.drain();
        throwIfAborted(controller.signal);
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

async function collectTests(root,files,signal){
    let entries;
    try{
        entries=await readdir(root,{withFileTypes:true});
    }catch(error){
        if(error?.code==='ENOENT'){
            return;
        }
        throw error;
    }
    for(const entry of entries.sort((left,right)=>left.name.localeCompare(right.name,'en'))){
        throwIfAborted(signal);
        const absolute=path.join(root,entry.name);
        if(entry.isSymbolicLink()){
            continue;
        }
        if(entry.isDirectory()){
            await collectTests(absolute,files,signal);
        }else if(entry.isFile()&&/\.test\.(?:mjs|cjs|js)$/u.test(entry.name)){
            const info=await lstat(absolute);
            if(info.isFile()&&!info.isSymbolicLink()){
                files.add(absolute);
            }
        }
    }
}

async function selectedWorkspace(options){
    const resolved=await resolveWorkspace({
        workspaceRoot:options.workspaceRoot,
        appId:options.appId
    });
    return {
        workspaceRoot:resolved.workspaceRoot,
        appId:resolved.appId??resolved.app?.id??resolved.app?.appId,
        appRoot:resolved.appRoot??resolved.app?.appRoot
    };
}

async function preparedWorkspace(options){
    const workspace=await validateWorkspace({
        workspaceRoot:options.workspaceRoot,
        appId:options.appId,
        signal:options.signal,
        onEvent:options.onEvent
    });
    const external=workspace.workspaceMode==='external';
    const runtimeRoot=external
        ?path.join(workspace.workspaceRoot,'node_modules','arcane-os','runtime')
        :workspace.workspaceRoot;
    const runtimeReceipt=external
        ?await verifyRuntime({
            runtimeRoot,
            signal:options.signal,
            onEvent:options.onEvent
        })
        :null;
    return {
        runtimeReceipt,
        runtimeRoot,
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
    if(prepared.workspaceMode==='external'){
        return authenticateRuntimeReceipt(prepared.runtimeReceipt,{
            runtimeRoot:prepared.runtimeRoot,
            signal
        });
    }
    const validation=await validateWorkspace({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        signal
    });
    if(validation.workspaceMode!=='integrated'){
        throw new ArcaneError(ERROR_CODES.workspaceInvalid,'The integrated Arcane workspace profile changed during the operation.');
    }
    return validation;
}

export async function createApplication(options={}){
    return createWorkspace(options);
}

export async function initializeApplication(options={}){
    return initWorkspace(options);
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

export async function testApplication(options={}){
    throwIfAborted(options.signal);
    const workspace=options.workspaceRoot&&options.appId&&options.appRoot
        ?{
            workspaceRoot:options.workspaceRoot,
            appId:options.appId,
            appRoot:options.appRoot
        }
        :await selectedWorkspace(options);
    const files=new Set();
    await collectTests(path.join(workspace.workspaceRoot,'test'),files,options.signal);
    if(workspace.appRoot){
        await collectTests(path.join(workspace.appRoot,'test'),files,options.signal);
    }
    const testFiles=[...files].sort();
    if(testFiles.length===0){
        await emit(options.onEvent,{
            type:'test.skipped',
            message:'No JavaScript test files were found.',
            data:{workspaceRoot:workspace.workspaceRoot,appId:workspace.appId}
        });
        return {...workspace,passed:true,skipped:true,testFiles:[]};
    }
    const result=await runProcess(process.execPath,['--test',...testFiles],{
        cwd:workspace.workspaceRoot,
        signal:options.signal,
        onEvent:options.onEvent
    });
    return {
        ...workspace,
        passed:true,
        skipped:false,
        testFiles:testFiles.map(file=>path.relative(workspace.workspaceRoot,file).replaceAll('\\','/')),
        output:result.stdout.trim()
    };
}

export async function checkApplication(options={}){
    const prepared=await preparedWorkspace(options);
    const tests=options.skipTests
        ?{passed:true,skipped:true,testFiles:[]}
        :await testApplication({...options,...prepared});
    await validatePreparedRuntime(prepared,{signal:options.signal});
    return {
        ok:true,
        workspaceMode:prepared.workspaceMode,
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        descriptorSource:prepared.descriptorSource,
        runtime:prepared.runtimeReceipt
            ?{
                mode:'sdk',
                manifestSha256:prepared.runtimeReceipt.manifestSha256,
                contentSha256:prepared.runtimeReceipt.contentSha256,
                fileCount:prepared.runtimeReceipt.fileCount
            }
            :{
                mode:'workspace',
                sourceRoot:'arcane'
            },
        checks:prepared.validation.checks,
        tests
    };
}

export async function developApplication(options={}){
    const prepared=await preparedWorkspace(options);
    const server=await startDevServer({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        mode:'source',
        runtimeReceipt:prepared.runtimeReceipt,
        workspaceMode:prepared.workspaceMode,
        host:options.host,
        port:options.port,
        signal:options.signal,
        onEvent:options.onEvent
    });
    return {...server,appId:prepared.appId,mode:'source'};
}

export async function packageApplication(options={}){
    const prepared=await preparedWorkspace(options);
    const release=await ownedWork(
        'package',
        ({signal,onEvent})=>packageApp({
            workspaceRoot:prepared.workspaceRoot,
            appId:prepared.appId,
            dryRun:Boolean(options.dryRun),
            signal,
            onEvent,
            validateSourceState:({signal}={})=>validatePreparedRuntime(prepared,{signal})
        }),
        options
    );
    return {
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null,
        release
    };
}

export async function verifyApplication(options={}){
    const prepared=await preparedWorkspace(options);
    const release=await ownedWork(
        'verify',
        ({signal,onEvent})=>verifyApp({
            workspaceRoot:prepared.workspaceRoot,
            appId:prepared.appId,
            signal,
            onEvent
        }),
        options
    );
    await validatePreparedRuntime(prepared,{signal:options.signal});
    return {
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null,
        release
    };
}

export async function buildApplication(options={}){
    const target=options.target;
    const adapter=getTargetAdapter(target);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return buildTarget(options);
    }
    const prepared=await preparedWorkspace(options);
    const result=await ownedWork(
        'build',
        ({signal,onEvent})=>buildTarget({
            ...options,
            ...prepared,
            signal,
            onEvent,
            validateSourceState:({signal}={})=>validatePreparedRuntime(prepared,{signal})
        }),
        options
    );
    return {
        ...result,
        workspaceMode:prepared.workspaceMode,
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null
    };
}

export async function runApplication(options={}){
    const target=options.target??'browser';
    const adapter=getTargetAdapter(target);
    const targetDescription=await adapter.describe();
    if(targetDescription.status!=='available'){
        return runTarget({...options,target});
    }
    const prepared=await preparedWorkspace(options);
    return runTarget({...options,...prepared,target});
}

export function describeTargets(){
    return {protocol:'arcane-target-adapter/1',targets:listTargets()};
}

export async function repositoryApplication(options={}){
    return runRepositoryAction(options.action,options);
}

export async function executeOperation(command,options={}){
    const operations={
        new:createApplication,
        init:initializeApplication,
        doctor:doctorApplication,
        dev:developApplication,
        test:testApplication,
        check:checkApplication,
        package:packageApplication,
        verify:verifyApplication,
        build:buildApplication,
        run:runApplication,
        targets:async()=>describeTargets(),
        repo:repositoryApplication
    };
    const operation=operations[command];
    if(!operation){
        throw new ArcaneError(ERROR_CODES.usage,`Unknown Arcane command: ${String(command)}.`);
    }
    return operation(options);
}

export function createToolchain(defaults={}){
    return Object.freeze({
        execute:(command,options={})=>executeOperation(command,{...defaults,...options}),
        create:options=>createApplication({...defaults,...options}),
        init:options=>initializeApplication({...defaults,...options}),
        doctor:options=>doctorApplication({...defaults,...options}),
        dev:options=>developApplication({...defaults,...options}),
        test:options=>testApplication({...defaults,...options}),
        check:options=>checkApplication({...defaults,...options}),
        package:options=>packageApplication({...defaults,...options}),
        verify:options=>verifyApplication({...defaults,...options}),
        build:options=>buildApplication({...defaults,...options}),
        run:options=>runApplication({...defaults,...options}),
        targets:()=>describeTargets(),
        repository:options=>repositoryApplication({...defaults,...options})
    });
}
