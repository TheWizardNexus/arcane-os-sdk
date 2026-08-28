import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {verifyRuntime} from './runtime.mjs';
import {verifySdkBrowserRuntime} from './sdk-browser-runtime.mjs';
import {materializeWorkspaceRuntime} from './workspace-runtime.mjs';
import {withWorkspaceOperationLock} from './workspace-operation-lock.mjs';
import {
    resolveInstalledSdkInstallation,
    resolveSdkPackageDeclaration
} from './workspace.mjs';

function fail(message,code='ARCANE_INSTALLED_SDK_RUNTIME_INVALID'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

function samePath(left,right){
    const normalize=value=>path.resolve(value).replaceAll('\\','/');
    const a=normalize(left);
    const b=normalize(right);
    return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

async function canonicalWorkspaceRoot(workspaceRoot){
    if(typeof workspaceRoot!=='string'||!workspaceRoot.trim()){
        fail('workspaceRoot is required to materialize an installed SDK runtime.');
    }
    const requested=path.resolve(workspaceRoot);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`Workspace root does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail(`Workspace root must be a real directory: ${requested}.`);
    }
    const canonical=await realpath(requested);
    if(!samePath(requested,canonical)){
        fail(`Workspace root must not resolve through another path: ${requested}.`);
    }
    return canonical;
}

async function readRootPackage(workspaceRoot){
    const packagePath=path.join(workspaceRoot,'package.json');
    let info;
    try{info=await lstat(packagePath);}
    catch(error){
        if(error?.code==='ENOENT')fail(`Workspace package.json is missing: ${packagePath}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isFile()){
        fail('Workspace package.json must be a real file.');
    }
    try{return JSON.parse(await readFile(packagePath,'utf8'));}
    catch(error){fail(`Workspace package.json is not valid JSON: ${error.message}`);}
}

/**
 * Resolves the workspace's one exact installed Arcane SDK declaration, verifies
 * both physical runtime receipts, and materializes their dynamic inventories.
 */
export async function materializeInstalledSdkRuntime({
    workspaceRoot,
    sdkPackageSource,
    workspaceOperationLease,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const canonicalRoot=await canonicalWorkspaceRoot(workspaceRoot);
    return withWorkspaceOperationLock({
        workspaceRoot:canonicalRoot,
        operation:'installed-sdk-runtime',
        signal,
        onEvent,
        workspaceOperationLease
    },async()=>{
        throwIfAborted(signal);
        const rootPackage=await readRootPackage(canonicalRoot);
        const declaration=resolveSdkPackageDeclaration(rootPackage,
            sdkPackageSource===undefined?{}:{packageSource:sdkPackageSource});
        const installation=await resolveInstalledSdkInstallation(canonicalRoot,declaration);
        const [runtimeReceipt,sdkBrowserRuntimeReceipt]=await Promise.all([
            verifyRuntime({
                runtimeRoot:installation.runtimeRoot,
                signal,
                onEvent
            }),
            verifySdkBrowserRuntime({
                browserRuntimeRoot:installation.browserRuntimeRoot,
                signal,
                onEvent
            })
        ]);
        const workspaceRuntimeReceipt=await materializeWorkspaceRuntime({
            workspaceRoot:canonicalRoot,
            runtimeRoot:installation.runtimeRoot,
            runtimeReceipt,
            browserRuntimeRoot:installation.browserRuntimeRoot,
            sdkBrowserRuntimeReceipt,
            installedSdkAuthority:Object.freeze({declaration,installation}),
            signal,
            onEvent
        });
        const materialization=workspaceRuntimeReceipt.materialization;
        return Object.freeze({
            schemaVersion:1,
            kind:'arcane-installed-sdk-runtime-materialization',
            status:materialization.status,
            generation:materialization.generation,
            receiptPath:materialization.receiptPath,
            persistentReceipt:materialization.persistentReceipt,
            cleanupWarnings:materialization.cleanupWarnings,
            installation,
            runtimeReceipt,
            sdkBrowserRuntimeReceipt,
            workspaceRuntimeReceipt
        });
    });
}
