import {lstat,readFile,realpath,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {materializeWorkspaceRuntimeContent} from './workspace-runtime.mjs';
import {withWorkspaceOperationLock} from './workspace-operation-lock.mjs';
import {createWorkspaceLockDocument} from './templates/workspace-template.mjs';
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

async function canonicalWorkspaceRoot(workspaceRoot){
    if(typeof workspaceRoot!=='string'||!workspaceRoot.trim()){
        fail('workspaceRoot is required to materialize an installed SDK runtime.');
    }
    const requested=path.resolve(workspaceRoot);
    let info;
    try{info=await stat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`Workspace root does not exist: ${requested}.`);
        throw error;
    }
    if(!info.isDirectory())fail(`Workspace root must be a directory: ${requested}.`);
    return realpath(requested);
}

async function readRootPackage(workspaceRoot){
    const packagePath=path.join(workspaceRoot,'package.json');
    let document;
    try{document=JSON.parse(await readFile(packagePath,'utf8'));}
    catch(error){
        if(error?.code==='ENOENT')fail(`Workspace package.json is missing: ${packagePath}.`);
        fail(`Workspace package.json is not valid JSON: ${error.message}`);
    }
    return document;
}

async function installedSdkAuthority(canonicalRoot,{sdkPackageSource}={}){
    const declaration=resolveSdkPackageDeclaration(
        await readRootPackage(canonicalRoot),
        sdkPackageSource===undefined?{}:{packageSource:sdkPackageSource}
    );
    const installation=await resolveInstalledSdkInstallation(canonicalRoot,declaration);
    return {declaration,installation};
}

async function writeWorkspaceLock(lockPath,lock){
    try{
        const info=await lstat(lockPath);
        if(info.isSymbolicLink()||!info.isFile()){
            fail(`Workspace SDK lock must be a real file: ${lockPath}.`);
        }
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
    await writeFile(lockPath,`${JSON.stringify(lock,null,2)}\n`,'utf8');
}

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
        const authority=await installedSdkAuthority(canonicalRoot,{sdkPackageSource});
        const workspaceRuntime=await materializeWorkspaceRuntimeContent({
            workspaceRoot:canonicalRoot,
            runtimeRoot:authority.installation.runtimeRoot,
            browserRuntimeRoot:authority.installation.browserRuntimeRoot,
            sdkVersion:authority.installation.packageVersion,
            signal,
            onEvent
        });
        const lockPath=path.join(canonicalRoot,'arcane.lock.json');
        const lock=createWorkspaceLockDocument({
            dependencyName:authority.installation.dependencyName,
            packageName:authority.installation.packageName,
            packageVersion:authority.installation.packageVersion,
            packageSource:authority.installation.packageSource
        });
        await writeWorkspaceLock(lockPath,lock);
        return {
            schemaVersion:1,
            kind:'arcane-installed-sdk-runtime-materialization',
            status:'materialized',
            installation:authority.installation,
            workspaceRuntime,
            workspaceLock:{path:lockPath,document:lock}
        };
    });
}
