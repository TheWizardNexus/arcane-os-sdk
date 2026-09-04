import {randomUUID} from 'node:crypto';
import {copyFile,lstat,mkdir,readdir,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';
import {getSdkRoot} from './runtime.mjs';
import {getSdkBrowserRuntimeRoot} from './sdk-browser-runtime.mjs';

const STAGING_PREFIX='.arcane-runtime-content-staging-';
const BACKUP_PREFIX='.arcane-runtime-content-backup-';

function fail(message,code='ARCANE_WORKSPACE_RUNTIME_INVALID'){
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

async function emit(onEvent,event){
    if(typeof onEvent==='function')await onEvent(event);
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

async function realDirectory(location,label){
    const requested=path.resolve(location);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} must be a real directory.`);
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical);
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()){
        fail(`${label} must be a real directory.`);
    }
    return canonical;
}

async function copyCompleteEntry(source,destination,label,signal){
    throwIfAborted(signal);
    const info=await lstat(source);
    if(info.isSymbolicLink())fail(`${label} must not contain a symbolic link or junction.`);
    if(info.isFile()){
        await copyFile(source,destination);
        return;
    }
    if(!info.isDirectory())fail(`${label} contains a non-file entry.`);
    await mkdir(destination,{recursive:true});
    const entries=await readdir(source,{withFileTypes:true});
    entries.sort((left,right)=>compareText(left.name,right.name));
    for(const entry of entries){
        throwIfAborted(signal);
        await copyCompleteEntry(
            path.join(source,entry.name),
            path.join(destination,entry.name),
            `${label}/${entry.name}`,
            signal
        );
    }
}

async function removeTemporaryTree(location){
    await rm(location,{recursive:true,force:true}).catch(()=>{});
}

export async function materializeWorkspaceRuntimeContent({
    workspaceRoot,
    runtimeRoot=path.join(getSdkRoot(),'runtime'),
    browserRuntimeRoot=getSdkBrowserRuntimeRoot(),
    signal,
    onEvent
}={}){
    if(!workspaceRoot)fail('workspaceRoot is required to materialize a workspace runtime.');
    throwIfAborted(signal);
    const workspace=await realDirectory(workspaceRoot,'Workspace root');
    const runtime=await realDirectory(runtimeRoot,'SDK runtime root');
    const browserRuntime=await realDirectory(browserRuntimeRoot,'SDK browser runtime root');
    const runtimeArcane=await realDirectory(path.join(runtime,'arcane'),'SDK Arcane runtime');
    const runtimeStrongType=await realDirectory(
        path.join(runtime,'strong-type'),
        'SDK strong-type runtime'
    );
    const destinationRoot=path.join(workspace,'arcane');
    const token=randomUUID();
    const stagingRoot=path.join(workspace,`${STAGING_PREFIX}${token}`);
    const backupRoot=path.join(workspace,`${BACKUP_PREFIX}${token}`);
    let backedUp=false;
    let promoted=false;

    await mkdir(stagingRoot);
    try{
        await copyCompleteEntry(runtimeArcane,stagingRoot,'SDK Arcane runtime',signal);
        await mkdir(path.join(stagingRoot,'dependencies'),{recursive:true});
        await copyCompleteEntry(
            runtimeStrongType,
            path.join(stagingRoot,'dependencies','strong-type'),
            'SDK strong-type runtime',
            signal
        );
        const sdkDestination=path.join(stagingRoot,'sdk');
        await mkdir(sdkDestination,{recursive:true});
        const browserEntries=await readdir(browserRuntime,{withFileTypes:true});
        browserEntries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of browserEntries){
            throwIfAborted(signal);
            await copyCompleteEntry(
                path.join(browserRuntime,entry.name),
                path.join(sdkDestination,entry.name),
                `SDK browser runtime/${entry.name}`,
                signal
            );
        }

        throwIfAborted(signal);
        try{
            const existing=await lstat(destinationRoot);
            if(existing.isSymbolicLink()||!existing.isDirectory()){
                fail('Workspace Arcane runtime destination must be a real directory when present.');
            }
            await rename(destinationRoot,backupRoot);
            backedUp=true;
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
        }

        await rename(stagingRoot,destinationRoot);
        promoted=true;
        await emit(onEvent,{
            type:'workspace.runtime.materialized',
            workspaceRoot:workspace,
            runtimeRoot:destinationRoot
        });
        if(backedUp){
            await rm(backupRoot,{recursive:true});
            backedUp=false;
        }
        return {
            kind:'arcane-workspace-runtime-content',
            workspaceRoot:workspace,
            runtimeRoot:destinationRoot
        };
    }catch(error){
        if(promoted)await removeTemporaryTree(destinationRoot);
        if(backedUp){
            try{await rename(backupRoot,destinationRoot);}
            catch(rollbackError){
                throw new AggregateError(
                    [error,rollbackError],
                    'Workspace runtime materialization and rollback both failed.',
                    {cause:error}
                );
            }
        }
        throw error;
    }finally{
        await removeTemporaryTree(stagingRoot);
        if(!backedUp||promoted)await removeTemporaryTree(backupRoot);
    }
}
