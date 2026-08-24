import path from 'node:path';
import {readdir,lstat,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
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
import {authenticateRuntimeReceipt,verifyRuntime} from './runtime.mjs';
import {
    authenticateSdkBrowserRuntimeReceipt,
    verifySdkBrowserRuntime
} from './sdk-browser-runtime.mjs';
import {
    authenticateWorkspaceRuntimeReceipt,
    verifyWorkspaceRuntime
} from './workspace-runtime.mjs';
import {generateImportMap} from './import-map.mjs';
import {withWorkspaceOperationLock} from './workspace-operation-lock.mjs';
import {
    authenticateSharedPayloadSnapshot,
    packageApp,
    prepareSharedPayloadSnapshot,
    verifyApp
} from './packager/core.mjs';
import {assertNativeToolchainCompatibility} from './native-plan.mjs';
import {runDoctor} from './doctor.mjs';
import {runProcess} from './process.mjs';
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
import {
    APP_BUNDLE_EXTENSION,
    createAppReleaseBundle,
    verifyAppReleaseBundle
} from './release-bundle.mjs';

const TEST_RUNNER_PATH=fileURLToPath(new URL('../bin/arcane-test.mjs',import.meta.url));
const MAX_TEST_FAILURE_STREAM_BYTES=32*1024;
const MAX_TEST_FAILURE_AGGREGATE_BYTES=256*1024;
const MAX_TEST_FAILURE_MESSAGE_BYTES=24*1024;
const TEST_OUTPUT_TRUNCATION_NOTICE='[... earlier test output omitted ...]\n';

function normalizedTestOutput(value){
    return typeof value==='string'?value.trim():'';
}

function boundedTestOutputTail(value,maxBytes){
    const source=normalizedTestOutput(value);
    const sourceBytes=Buffer.byteLength(source,'utf8');
    if(sourceBytes<=maxBytes){
        return {text:source,bytes:sourceBytes,truncated:false};
    }
    const noticeBytes=Buffer.byteLength(TEST_OUTPUT_TRUNCATION_NOTICE,'utf8');
    if(maxBytes<noticeBytes){
        return {text:'',bytes:0,truncated:sourceBytes>0};
    }
    const buffer=Buffer.from(source,'utf8');
    let start=buffer.length-(maxBytes-noticeBytes);
    while(start<buffer.length&&(buffer[start]&0xc0)===0x80){
        start+=1;
    }
    const text=`${TEST_OUTPUT_TRUNCATION_NOTICE}${buffer.subarray(start).toString('utf8')}`;
    return {text,bytes:Buffer.byteLength(text,'utf8'),truncated:true};
}

function failedTestOutputBudgets(stderr,stdout,maxBytes){
    const desiredStderr=Math.min(
        MAX_TEST_FAILURE_STREAM_BYTES,
        Buffer.byteLength(normalizedTestOutput(stderr),'utf8')
    );
    const desiredStdout=Math.min(
        MAX_TEST_FAILURE_STREAM_BYTES,
        Buffer.byteLength(normalizedTestOutput(stdout),'utf8')
    );
    if(desiredStderr+desiredStdout<=maxBytes){
        return {stderr:desiredStderr,stdout:desiredStdout};
    }
    const shared=Math.floor(maxBytes/2);
    let stderrBudget=Math.min(desiredStderr,shared);
    let stdoutBudget=Math.min(desiredStdout,shared);
    let remaining=maxBytes-stderrBudget-stdoutBudget;
    const additionalStderr=Math.min(remaining,desiredStderr-stderrBudget);
    stderrBudget+=additionalStderr;
    remaining-=additionalStderr;
    stdoutBudget+=Math.min(remaining,desiredStdout-stdoutBudget);
    return {stderr:stderrBudget,stdout:stdoutBudget};
}

function captureFailedTest(testFile,result,workspaceRoot,maxBytes){
    const budgets=failedTestOutputBudgets(result.stderr,result.stdout,maxBytes);
    const stderr=boundedTestOutputTail(result.stderr,budgets.stderr);
    const stdout=boundedTestOutputTail(result.stdout,budgets.stdout);
    return {
        failure:Object.freeze({
            testFile:path.relative(workspaceRoot,testFile).replaceAll('\\','/'),
            exitCode:result.code,
            signal:result.signal,
            stdout:stdout.text,
            stderr:stderr.text,
            stdoutTruncated:stdout.truncated,
            stderrTruncated:stderr.truncated
        }),
        bytes:stdout.bytes+stderr.bytes
    };
}

function failedTestMessage(failures){
    const summary=`${String(failures.length)} isolated test file${failures.length===1?'':'s'} failed.`;
    const actionable=failures.find(failure=>failure.stderr||failure.stdout);
    if(!actionable){
        return summary;
    }
    const heading=`\n\n${actionable.testFile}:\n`;
    const available=Math.max(
        0,
        MAX_TEST_FAILURE_MESSAGE_BYTES-Buffer.byteLength(`${summary}${heading}`,'utf8')
    );
    const diagnostic=boundedTestOutputTail(
        actionable.stderr||actionable.stdout,
        available
    ).text;
    return diagnostic?`${summary}${heading}${diagnostic}`:summary;
}

async function emit(onEvent,event){
    await onEvent?.(event);
}

function nativeArtifactReceipt(result){
    return result?.artifactReceipt??result?.built?.artifactReceipt??null;
}

function withEventDeliveryFailure(result,error){
    const eventDelivery=Object.freeze({
        status:'degraded',
        errorCode:'ARCANE_EVENT_DELIVERY_FAILED',
        message:String(error?.message??error)
    });
    if(result?.built?.artifactReceipt){
        return {...result,built:{...result.built,eventDelivery}};
    }
    return {...result,eventDelivery};
}

function isOuterCommitEvent(label,event){
    if(label==='build')return event?.type==='native.build.committed';
    return label==='bundle'&&event?.type==='bundle.committed'
        &&event?.phase==='publish'&&event?.status==='completed';
}

function isAppReleaseReceipt(value){
    return value?.kind==='arcane-app-release-verification'
        &&typeof value?.contentSha256==='string';
}

function hasAuthenticatedOuterResult(label,result){
    if(label==='import-map')return result?.committed===true;
    if(label==='package')return isAppReleaseReceipt(result?.receipt);
    if(label==='bundle')return result?.artifactReceipt?.kind
        ==='arcane-app-release-bundle-artifact';
    if(label!=='build')return false;
    return nativeArtifactReceipt(result)!=null||isAppReleaseReceipt(result?.release?.receipt);
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
        if(hasAuthenticatedOuterResult(label,result))committed=true;
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
            return Object.freeze({
                scope:'shared',
                workspaceMode:'integrated',
                workspaceRoot:profile.workspaceRoot,
                providerGeneration:provider.providerGeneration,
                result
            });
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
    const runtimeRoot=external
        ?path.join(workspace.workspaceRoot,'node_modules','arcane-os','runtime')
        :workspace.workspaceRoot;
    const browserRuntimeRoot=external
        ?path.join(workspace.workspaceRoot,'node_modules','arcane-os','browser-runtime')
        :null;
    const runtimeReceipt=external&&!options.deferRuntimeVerification
        ?await verifyRuntime({
            runtimeRoot,
            signal:options.signal,
            onEvent:options.onEvent
        })
        :null;
    const sdkBrowserRuntimeReceipt=external&&!options.deferRuntimeVerification
        ?await verifySdkBrowserRuntime({
            browserRuntimeRoot,
            signal:options.signal,
            onEvent:options.onEvent
        })
        :null;
    const workspaceRuntimeReceipt=external&&!options.deferRuntimeVerification
        ?await verifyWorkspaceRuntime({
            workspaceRoot:workspace.workspaceRoot,
            runtimeRoot,
            runtimeReceipt,
            browserRuntimeRoot,
            sdkBrowserRuntimeReceipt,
            signal:options.signal,
            onEvent:options.onEvent
        })
        :null;
    const runtimeVerificationState=external&&!options.deferRuntimeVerification
        ?Object.freeze({runtimeReceipt,sdkBrowserRuntimeReceipt,workspaceRuntimeReceipt})
        :null;
    return {
        runtimeReceipt,
        sdkBrowserRuntimeReceipt,
        workspaceRuntimeReceipt,
        runtimeVerificationState,
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

function forwardedRuntimeVerificationState(options,prepared){
    return Object.hasOwn(options,'runtimeVerificationState')
        ?options.runtimeVerificationState
        :prepared.runtimeVerificationState??undefined;
}

function compareRuntimeInventory(left,right){
    return left.path.localeCompare(right.path,'en');
}

async function externalRuntimeSnapshotReceipt(prepared,sharedPayloadSnapshot,sharedPayloadIds,{signal,onEvent}={}){
    throwIfAborted(signal);
    await authenticateSharedPayloadSnapshot(sharedPayloadSnapshot,{
        workspaceRoot:prepared.workspaceRoot,
        sharedPayloadIds,
        signal
    });
    const runtimeReceipt=await verifyRuntime({
        runtimeRoot:prepared.runtimeRoot,
        signal,
        onEvent
    });
    const sdkBrowserRuntimeReceipt=await verifySdkBrowserRuntime({
        browserRuntimeRoot:prepared.browserRuntimeRoot,
        signal,
        onEvent
    });
    const workspaceRuntimeReceipt=await verifyWorkspaceRuntime({
        workspaceRoot:prepared.workspaceRoot,
        runtimeRoot:prepared.runtimeRoot,
        runtimeReceipt,
        browserRuntimeRoot:prepared.browserRuntimeRoot,
        sdkBrowserRuntimeReceipt,
        signal,
        onEvent
    });
    const retained=sharedPayloadSnapshot.files
        .filter(file=>file.source.startsWith('arcane/'))
        .map(file=>Object.freeze({
            path:file.source.slice('arcane/'.length),
            bytes:file.bytes,
            sha256:file.sha256
        }))
        .sort(compareRuntimeInventory);
    const upstreamFiles=runtimeReceipt.files.map(file=>Object.freeze({
        path:file.path.startsWith('arcane/')
            ?file.path.slice('arcane/'.length)
            :`dependencies/strong-type/${file.path.slice('strong-type/'.length)}`,
        sourcePath:file.path,
        bytes:file.bytes,
        sha256:file.sha256
    })).sort(compareRuntimeInventory);
    const sdkFiles=sdkBrowserRuntimeReceipt.files.map(file=>Object.freeze({
        path:`sdk/${file.path}`,
        sourcePath:file.path,
        bytes:file.bytes,
        sha256:file.sha256
    })).sort(compareRuntimeInventory);
    const expected=[...upstreamFiles,...sdkFiles]
        .map(file=>Object.freeze({path:file.path,bytes:file.bytes,sha256:file.sha256}))
        .sort(compareRuntimeInventory);
    if(JSON.stringify(retained)!==JSON.stringify(expected)){
        throw new ArcaneError(
            ERROR_CODES.integrityFailed,
            'The retained shared payload does not match the composed Arcane and SDK browser runtime receipts.'
        );
    }
    const receipt=Object.freeze({
        schemaVersion:1,
        kind:'arcane-sdk-runtime-shared-payload',
        canonicalLocation:prepared.runtimeRoot,
        source:Object.freeze({...runtimeReceipt.source}),
        sources:Object.freeze({
            arcane:Object.freeze({
                manifestSha256:runtimeReceipt.manifestSha256,
                contentSha256:runtimeReceipt.contentSha256,
                source:runtimeReceipt.source
            }),
            sdkBrowser:Object.freeze({
                manifestSha256:sdkBrowserRuntimeReceipt.manifestSha256,
                contentSha256:sdkBrowserRuntimeReceipt.contentSha256,
                source:sdkBrowserRuntimeReceipt.source
            })
        }),
        files:Object.freeze(runtimeReceipt.files.map(file=>Object.freeze({...file}))),
        fileCount:runtimeReceipt.fileCount,
        totalBytes:runtimeReceipt.totalBytes,
        contentSha256:runtimeReceipt.contentSha256,
        browserFiles:Object.freeze(sdkBrowserRuntimeReceipt.files.map(
            file=>Object.freeze({...file})
        )),
        browserFileCount:sdkBrowserRuntimeReceipt.fileCount,
        browserTotalBytes:sdkBrowserRuntimeReceipt.totalBytes,
        browserContentSha256:sdkBrowserRuntimeReceipt.contentSha256,
        sharedFiles:Object.freeze(retained),
        sharedFileCount:retained.length,
        sharedTotalBytes:retained.reduce((total,file)=>total+file.bytes,0),
        sharedPayloadContentSha256:sharedPayloadSnapshot.contentSha256
    });
    await emit(onEvent,{
        type:'runtime.snapshot.verified',
        contentSha256:receipt.contentSha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes,
        browserContentSha256:receipt.browserContentSha256,
        browserFileCount:receipt.browserFileCount,
        browserTotalBytes:receipt.browserTotalBytes
    });
    return Object.freeze({
        receipt,
        runtimeVerificationState:Object.freeze({
            runtimeReceipt,
            sdkBrowserRuntimeReceipt,
            workspaceRuntimeReceipt
        })
    });
}

async function validatePreparedRuntime(prepared,{signal}={}){
    if(prepared.workspaceMode==='external'){
        await authenticateRuntimeReceipt(prepared.runtimeReceipt,{
            runtimeRoot:prepared.runtimeRoot,
            signal
        });
        await authenticateSdkBrowserRuntimeReceipt(prepared.sdkBrowserRuntimeReceipt,{
            browserRuntimeRoot:prepared.browserRuntimeRoot,
            signal
        });
        return authenticateWorkspaceRuntimeReceipt(prepared.workspaceRuntimeReceipt,{
            workspaceRoot:prepared.workspaceRoot,
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

async function refreshPreparedImportMap(prepared,{signal,onEvent,workspaceOperationLease}={}){
    if(prepared.workspaceMode==='integrated'
        &&prepared.validation.config.browserRuntimeLayout==='integrated-legacy'){
        const receipt=Object.freeze({
            appId:prepared.appId,
            skipped:true,
            compatibility:'integrated-legacy',
            reason:'The canonical integrated Arcane OS root retains its physical two-route browser runtime.'
        });
        await emit(onEvent,{type:'import-map.compatibility.skipped',...receipt});
        return receipt;
    }
    return generateImportMap({
        workspaceRoot:prepared.workspaceRoot,
        appId:prepared.appId,
        appRoot:prepared.appRoot,
        entry:prepared.validation.app.manifest.entry,
        workspaceRuntimeReceipt:prepared.workspaceRuntimeReceipt,
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
    if(operationScope(options)==='shared'){
        if(typeof options.testFile!=='string'||!options.testFile){
            throw new ArcaneError(
                ERROR_CODES.usage,
                'Shared testing requires one exact repo-relative .test.mjs file.'
            );
        }
        return executeIntegratedSharedOperation('focused-test',options);
    }
    const workspace=options.workspaceRoot&&options.appId&&options.appRoot
        ?{
            workspaceRoot:options.workspaceRoot,
            workspaceMode:options.workspaceMode
                ??(await inspectWorkspaceProfile(options.workspaceRoot)).workspaceMode,
            appId:options.appId,
            appRoot:options.appRoot
        }
        :await selectedWorkspace(options);
    const files=new Set();
    if(workspace.workspaceMode==='external'){
        await collectTests(path.join(workspace.workspaceRoot,'test'),files,options.signal);
    }
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
    const outputs=[];
    const failures=[];
    let failureOutputBytes=0;
    const perFileFailureOutputBytes=Math.min(
        MAX_TEST_FAILURE_STREAM_BYTES*2,
        Math.floor(MAX_TEST_FAILURE_AGGREGATE_BYTES/testFiles.length)
    );
    for(const testFile of testFiles){
        throwIfAborted(options.signal);
        const result=await runProcess(
            process.execPath,
            [TEST_RUNNER_PATH,testFile],
            {
                cwd:workspace.workspaceRoot,
                signal:options.signal,
                onEvent:options.onEvent,
                allowNonzero:true
            }
        );
        if(result.code===0){
            if(result.stdout.trim())outputs.push(result.stdout.trim());
        }else if(result.code===1){
            const captured=captureFailedTest(
                testFile,
                result,
                workspace.workspaceRoot,
                Math.min(
                    perFileFailureOutputBytes,
                    MAX_TEST_FAILURE_AGGREGATE_BYTES-failureOutputBytes
                )
            );
            failures.push(captured.failure);
            failureOutputBytes+=captured.bytes;
        }else if(result.code!==0){
            throw new ArcaneError(
                ERROR_CODES.operationFailed,
                `The isolated test runner exited with code ${String(result.code)} for ${path.basename(testFile)}.`,
                {details:{testFile,result}}
            );
        }
    }
    if(failures.length>0){
        throw new ArcaneError(
            ERROR_CODES.operationFailed,
            failedTestMessage(failures),
            {
                details:{
                    testFiles:failures.map(failure=>failure.testFile),
                    failures,
                    outputBytes:failureOutputBytes,
                    outputLimitBytes:MAX_TEST_FAILURE_AGGREGATE_BYTES,
                    outputTruncated:failures.some(
                        failure=>failure.stdoutTruncated||failure.stderrTruncated
                    )
                }
            }
        );
    }
    return {
        ...workspace,
        passed:true,
        skipped:false,
        testFiles:testFiles.map(file=>path.relative(workspace.workspaceRoot,file).replaceAll('\\','/')),
        output:outputs.join('\n')
    };
}

export async function checkApplication(options={}){
    if(operationScope(options)==='shared'){
        if(options.skipTests){
            throw new ArcaneError(ERROR_CODES.usage,'Shared check does not accept skipTests.');
        }
        return executeIntegratedSharedOperation('development-check',options);
    }
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
        workspaceRuntimeReceipt:prepared.workspaceRuntimeReceipt,
        workspaceMode:prepared.workspaceMode,
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
        ({signal,onEvent,workspaceOperationLease})=>packageApp({
                workspaceRoot:prepared.workspaceRoot,
                appId:prepared.appId,
                dryRun:Boolean(options.dryRun),
                signal,
                onEvent,
                workspaceOperationLease,
                runtimeVerificationState:forwardedRuntimeVerificationState(options,prepared),
                validateSourceState:({signal}={})=>validatePreparedRuntime(prepared,{signal})
            }),
        {...options,workspaceRoot:prepared.workspaceRoot}
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
    assertApplicationScope(options,'Package verification');
    const prepared=await preparedWorkspace(options);
    const release=await ownedWork(
        'verify',
        ({signal,onEvent})=>verifyApp({
            workspaceRoot:prepared.workspaceRoot,
            appId:prepared.appId,
            runtimeVerificationState:forwardedRuntimeVerificationState(options,prepared),
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
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null,
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
                runtimeVerificationState:forwardedRuntimeVerificationState(options,prepared),
                signal,
                onEvent
            });
            await validatePreparedRuntime(prepared,{signal});
            const releaseRoot=verified.receipt.canonicalLocation;
            const outputPath=options.artifactPath??path.join(
                path.dirname(releaseRoot),
                `${prepared.appId}-${verified.version}${APP_BUNDLE_EXTENSION}`
            );
            return createAppReleaseBundle({
                receipt:verified.receipt,
                releaseRoot,
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
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null,
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

export function resolvePortableBuildOutputRoot(options={}){
    return resolveNativeBuildOutputRoot({...options,target:'portable'});
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

export function assertIntegratedPortableToolchain(options={}){
    return assertIntegratedNativeToolchain({...options,target:'portable'});
}

export function assertNativeApplicationToolchainCompatibility({prepared,toolchainReceipt}={}){
    return assertNativeToolchainCompatibility({
        appDescriptor:prepared?.descriptor,
        toolchainReceipt,
        minimumCoreVersion:prepared?.runtimeReceipt?.source?.bundleVersion
            ??ARCANE_MACHINE_BUNDLE_VERSION
    });
}

export function assertPortableToolchainCompatibility(options={}){
    return assertNativeApplicationToolchainCompatibility(options);
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
            ERROR_CODES.integrityFailed
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
    const discovered=new Set();
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
            if(discovered.size>=64){
                nativeDependencyError('A native app dependency closure may contain at most 64 apps.');
            }
            discovered.add(dependencyId);
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
        validated.push(Object.freeze({
            ...dependency,
            descriptor:validation.app.descriptor,
            validation
        }));
    }
    return Object.freeze(validated);
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
    sharedPayloadSnapshot,
    workspaceOperationLease,
    signal,
    onEvent
}={}){
    const sourceState={
        ...prepared,
        appId:app.appId,
        appRoot:app.appRoot,
        descriptor:app.descriptor,
        validation:app.validation??prepared.validation
    };
    const release=await packageApp({
        workspaceRoot:prepared.workspaceRoot,
        appId:app.appId,
        sharedPayloadSnapshot,
        runtimeVerificationState:prepared.runtimeVerificationState??undefined,
        workspaceOperationLease,
        signal,
        onEvent,
        validateSourceState:({signal:validationSignal}={})=>validateDiscoveredApplication({
            workspaceRoot:sourceState.workspaceRoot,
            workspaceMode:sourceState.workspaceMode,
            workspaceConfig:prepared.validation.config,
            app,
            signal:validationSignal
        })
    });
    return Object.freeze({
        appId:app.appId,
        appRoot:app.appRoot,
        descriptor:app.descriptor,
        release,
        nativeInput:Object.freeze({
            appDescriptor:app.descriptor,
            appReleaseRoot:path.resolve(prepared.workspaceRoot,release.output),
            appReleaseReceipt:release.receipt
        })
    });
}

async function executePairedNativeBuild(options,adapter,{
    signal,
    onEvent,
    workspaceOperationLease
}={}){
    const target=options.target??options.targetRequest?.target;
    const initialPrepared=await preparedWorkspace({
        ...options,
        deferRuntimeVerification:true,
        signal,
        onEvent
    });
    assertIntegratedNativeToolchain({
        target,
        workspaceMode:initialPrepared.workspaceMode,
        workspaceRoot:initialPrepared.workspaceRoot,
        toolchainRoot:options.toolchainRoot
    });
    if(options.dryRun){
        throw new ArcaneError(
            ERROR_CODES.usage,
            `${target} native build does not support --dry-run because verified app release receipts are required.`
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
    const sharedPayloadIds=[...new Set([
        ...initialPrepared.validation.app.manifest.shared,
        ...dependencyApps.flatMap(app=>app.manifest.shared)
    ])].sort((left,right)=>left.localeCompare(right,'en'));
    const sharedPayloadSnapshot=await prepareSharedPayloadSnapshot({
        workspaceRoot:initialPrepared.workspaceRoot,
        sharedPayloadIds,
        signal,
        onEvent
    });
    const externalRuntimeState=initialPrepared.workspaceMode==='external'
        ?await externalRuntimeSnapshotReceipt(
            initialPrepared,
            sharedPayloadSnapshot,
            sharedPayloadIds,
            {signal,onEvent}
        )
        :null;
    const prepared={
        ...initialPrepared,
        runtimeReceipt:externalRuntimeState?.receipt??null,
        runtimeVerificationState:externalRuntimeState?.runtimeVerificationState??null,
        workspaceRuntimeReceipt:
            externalRuntimeState?.runtimeVerificationState.workspaceRuntimeReceipt??null
    };
    const selectedRelease=await packageNativeRelease(prepared,{
        appId:prepared.appId,
        appRoot:prepared.appRoot,
        manifest:prepared.validation.app.manifest,
        descriptor:prepared.descriptor,
        descriptorSource:prepared.validation.app.descriptorSource,
        descriptorPath:prepared.validation.app.descriptorPath,
        validation:prepared.validation
    },{sharedPayloadSnapshot,workspaceOperationLease,signal,onEvent});
    const dependencyReleases=[];
    for(const dependency of dependencyApps){
        dependencyReleases.push(await packageNativeRelease(
            prepared,
            dependency,
            {sharedPayloadSnapshot,workspaceOperationLease,signal,onEvent}
        ));
    }
    const toolchainReceipt=await adapter.prepare({
        toolchainRoot:options.toolchainRoot,
        targetRequest:options.targetRequest,
        signal,
        onEvent
    });
    protectedRoots.push(...(options.protectedRoots??[]));
    const built=await adapter.build({
        nativeBuilder:options.nativeBuilder,
        toolchainRoot:options.toolchainRoot,
        toolchainReceipt,
        ...selectedRelease.nativeInput,
        dependencyReleases:dependencyReleases.map(item=>item.nativeInput),
        providerGeneration:options.providerGeneration??options.nativeBuilder?.providerGeneration,
        minimumCoreVersion:prepared.runtimeReceipt?.source?.bundleVersion
            ??ARCANE_MACHINE_BUNDLE_VERSION,
        protectedRoots,
        outputRoot,
        targetRequest:options.targetRequest,
        signal,
        onEvent
    });
    return Object.freeze({
        prepared,
        outputRoot,
        toolchainReceipt,
        selectedRelease,
        dependencyReleases:Object.freeze(dependencyReleases),
        built
    });
}

function nativeBuildResult(assembly){
    const {prepared}=assembly;
    return {
        ...assembly.built,
        workspaceRoot:prepared.workspaceRoot,
        workspaceMode:prepared.workspaceMode,
        appId:prepared.appId,
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null,
        release:assembly.selectedRelease.release,
        dependencyReleases:assembly.dependencyReleases.map(item=>Object.freeze({
            appId:item.appId,
            release:item.release
        }))
    };
}

function usesWorkspaceNativeAssembly(options){
    return options.nativeBuilder!=null
        &&typeof options.workspaceRoot==='string'
        &&options.appReleaseReceipt==null
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
                runtimeVerificationState:forwardedRuntimeVerificationState(options,prepared),
                signal,
                onEvent,
                workspaceOperationLease,
                validateSourceState:({signal}={})=>validatePreparedRuntime(prepared,{signal})
            }),
        {...options,workspaceRoot:prepared.workspaceRoot}
    );
    return {
        ...result,
        workspaceMode:prepared.workspaceMode,
        runtimeContentSha256:prepared.runtimeReceipt?.contentSha256??null
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
        if(usesWorkspaceNativeAssembly(selectedOptions)&&selectedOptions.artifactReceipt==null){
            return ownedWork(
                'run',
                async context=>{
                    const assembly=await executePairedNativeBuild(selectedOptions,adapter,context);
                    const launched=await adapter.run({
                        toolchainRoot:selectedOptions.toolchainRoot,
                        toolchainReceipt:assembly.toolchainReceipt,
                        artifactReceipt:assembly.built.artifactReceipt,
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
        runtimeVerificationState:forwardedRuntimeVerificationState(selectedOptions,prepared),
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
    return Object.freeze({
        execute:(command,options={})=>executeOperation(command,{...defaults,...options}),
        create:options=>createApplication({...defaults,...options}),
        init:options=>initializeApplication({...defaults,...options}),
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
        targets:options=>describeTargets({...defaults,...options}),
        repository:options=>repositoryApplication({...defaults,...options})
    });
}
