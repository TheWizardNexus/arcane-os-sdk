import {randomUUID} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath,rm} from 'node:fs/promises';
import path from 'node:path';

const LOCK_DIRECTORY='.arcane';
const LOCK_NAME='workspace-operation.lock.json';
const LOCK_TTL_MILLISECONDS=6*60*60*1000;
const OPEN_EXCLUSIVE=FS_CONSTANTS.O_CREAT|FS_CONSTANTS.O_EXCL|FS_CONSTANTS.O_RDWR
    |(FS_CONSTANTS.O_NOFOLLOW??0);
const RELEASE_PROCEDURE=
    'The owning Arcane process removes this cooperative lock after the operation settles.';
const STALE_RECOVERY=
    'After expiresAt, confirm the recorded owner process is absent, preserve workspace changes, '
    +'and remove only this exact cooperative lock.';
const activeRoots=new Map();
const leaseStates=new WeakMap();

function fail(message,code='ARCANE_WORKSPACE_BUSY'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function workspaceBusy(message){
    const error=new Error(message);
    error.code='ARCANE_WORKSPACE_BUSY';
    return error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

function samePath(left,right){
    const normalize=value=>{
        const resolved=path.resolve(value);
        return process.platform==='win32'?resolved.toLocaleLowerCase('en-US'):resolved;
    };
    return normalize(left)===normalize(right);
}

function validOperation(value){
    return typeof value==='string'&&/^[a-z][a-z0-9._-]*$/u.test(value);
}

function trackedLeaseState(fields){
    let resolveSettled;
    const settled=new Promise(resolve=>{resolveSettled=resolve;});
    return {
        ...fields,
        releasePromise:null,
        settled,
        settledComplete:false,
        resolveSettled
    };
}

function settleLeaseState(state){
    if(state.settledComplete)return;
    state.settledComplete=true;
    state.resolveSettled();
}

async function physicalDirectory(directory,label,{create=false}={}){
    const requested=path.resolve(directory);
    if(create){
        await mkdir(requested,{recursive:true});
    }
    let information;
    try{
        information=await lstat(requested);
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`${label} does not exist.`,'ARCANE_POLICY_DENIED');
        }
        throw error;
    }
    if(information.isSymbolicLink()||!information.isDirectory()){
        fail(`${label} must be a physical directory.`,'ARCANE_POLICY_DENIED');
    }
    const canonical=await realpath(requested);
    const canonicalInformation=await lstat(canonical);
    if(canonicalInformation.isSymbolicLink()||!canonicalInformation.isDirectory()){
        fail(`${label} must resolve to a physical directory.`,'ARCANE_POLICY_DENIED');
    }
    return {requested,canonical};
}

async function ensureLockDirectory(workspace){
    const directory=path.join(workspace.canonical,LOCK_DIRECTORY);
    return physicalDirectory(directory,'Workspace operation-lock directory',{create:true});
}

function ownerIsAlive(pid){
    if(!Number.isSafeInteger(pid)||pid<1)return false;
    try{
        process.kill(pid,0);
        return true;
    }catch(error){
        return error?.code==='EPERM';
    }
}

function lockDocument(value,{workspaceRoot,now=Date.now()}={}){
    if(!value||typeof value!=='object'||Array.isArray(value)
        ||value.schemaVersion!==1
        ||value.kind!=='arcane-workspace-operation-lock'
        ||!validOperation(value.operation)
        ||typeof value.nonce!=='string'||!value.nonce
        ||!value.owner||!Number.isSafeInteger(value.owner.pid)
        ||typeof value.scope!=='string'||!samePath(value.scope,workspaceRoot)
        ||typeof value.acquiredAt!=='string'
        ||typeof value.expiresAt!=='string'
        ||value.releaseProcedure!==RELEASE_PROCEDURE
        ||value.staleRecovery!==STALE_RECOVERY){
        return null;
    }
    const expiresAt=Date.parse(value.expiresAt);
    if(!Number.isFinite(expiresAt))return null;
    return {...value,expired:expiresAt<=now};
}

async function readLock(lockPath,workspaceRoot){
    let information;
    try{
        information=await lstat(lockPath);
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
    if(information.isSymbolicLink()||!information.isFile())return null;
    let value;
    try{
        value=JSON.parse(await readFile(lockPath,'utf8'));
    }catch{
        return null;
    }
    return lockDocument(value,{workspaceRoot});
}

async function recoverExpiredLock(lockPath,workspaceRoot,onEvent){
    const document=await readLock(lockPath,workspaceRoot);
    if(!document?.expired||ownerIsAlive(document.owner.pid))return false;
    await onEvent?.({
        type:'workspace.operation.stale-recovered',
        workspaceRoot,
        lockPath,
        previousOwner:document.owner,
        previousOperation:document.operation
    });
    await rm(lockPath);
    return true;
}

async function removeOwnedLock({lockPath,workspaceRoot,nonce,handle}){
    await handle?.close().catch(()=>{});
    const document=await readLock(lockPath,workspaceRoot);
    if(document===null)return true;
    if(document.nonce!==nonce||document.owner.pid!==process.pid)return false;
    await rm(lockPath);
    return true;
}

function leaseFor(state,operation){
    const lease={
        workspaceRoot:state.root.workspace.canonical,
        operation,
        nonce:randomUUID(),
        lockPath:state.root.lockPath
    };
    leaseStates.set(lease,state);
    return lease;
}

function inheritedLease(workspace,operation,supplied){
    const parent=leaseStates.get(supplied);
    const root=parent?.root;
    if(!parent?.active||!root?.active
        ||!samePath(root.workspace.canonical,workspace.canonical)
        ||activeRoots.get(workspace.canonical)!==root.lease){
        fail(
            'Arcane workspace operation lease is missing, inactive, or belongs to another workspace.',
            'ARCANE_POLICY_DENIED'
        );
    }
    if(parent.child!==null){
        fail('The supplied Arcane workspace operation lease already has active nested work.');
    }
    const state=trackedLeaseState({active:true,child:null,parent,root});
    const lease=leaseFor(state,operation);
    state.lease=lease;
    parent.child=state;
    return {
        inherited:true,
        lease,
        release(){
            if(state.releasePromise)return state.releasePromise;
            state.active=false;
            state.releasePromise=(async()=>{
                const child=state.child;
                const misuseError=child===null?null:workspaceBusy(
                    'A nested Arcane workspace operation was still active when its parent settled.'
                );
                try{
                    if(child!==null)await child.settled;
                }finally{
                    leaseStates.delete(lease);
                    if(parent.child===state)parent.child=null;
                    settleLeaseState(state);
                }
                if(misuseError)throw misuseError;
            })();
            return state.releasePromise;
        }
    };
}

async function acquire({
    workspaceRoot,
    operation,
    workspaceOperationLease,
    signal,
    onEvent
}){
    throwIfAborted(signal);
    if(typeof workspaceRoot!=='string'||!workspaceRoot.trim()){
        throw new TypeError('workspaceRoot is required for an Arcane workspace operation lock.');
    }
    if(!validOperation(operation)){
        throw new TypeError('operation must be a stable lowercase Arcane operation name.');
    }
    const workspace=await physicalDirectory(workspaceRoot,'Arcane workspace');
    if(workspaceOperationLease!==undefined){
        return inheritedLease(workspace,operation,workspaceOperationLease);
    }
    if(activeRoots.has(workspace.canonical)){
        fail(`Another Arcane operation already owns ${workspace.canonical}.`);
    }
    const reservation={kind:'arcane-workspace-operation-reservation'};
    activeRoots.set(workspace.canonical,reservation);
    let handle;
    let lockPath;
    let rootState;
    let nonce;
    try{
        const directory=await ensureLockDirectory(workspace);
        lockPath=path.join(directory.canonical,LOCK_NAME);
        let recovered=false;
        for(;;){
            try{
                handle=await open(lockPath,OPEN_EXCLUSIVE,0o600);
                break;
            }catch(error){
                if(error?.code!=='EEXIST')throw error;
                if(recovered||!(await recoverExpiredLock(
                    lockPath,
                    workspace.canonical,
                    onEvent
                ))){
                    fail(
                        `Workspace is locked by another Arcane operation: ${lockPath}. `
                        +'Inspect its owner, expiry, and staleRecovery before retrying.'
                    );
                }
                recovered=true;
            }
        }
        nonce=randomUUID();
        const acquiredAt=new Date();
        const document={
            schemaVersion:1,
            kind:'arcane-workspace-operation-lock',
            operation,
            owner:{pid:process.pid},
            scope:workspace.canonical,
            nonce,
            acquiredAt:acquiredAt.toISOString(),
            expiresAt:new Date(acquiredAt.getTime()+LOCK_TTL_MILLISECONDS).toISOString(),
            ttlMilliseconds:LOCK_TTL_MILLISECONDS,
            releaseProcedure:RELEASE_PROCEDURE,
            staleRecovery:STALE_RECOVERY
        };
        await handle.writeFile(`${JSON.stringify(document,null,2)}\n`,'utf8');
        await handle.sync();
        rootState=trackedLeaseState({
            active:true,
            child:null,
            workspace,
            lockPath,
            handle,
            nonce
        });
        rootState.root=rootState;
        const lease={workspaceRoot:workspace.canonical,operation,nonce,lockPath};
        rootState.lease=lease;
        leaseStates.set(lease,rootState);
        activeRoots.set(workspace.canonical,lease);
        await onEvent?.({
            type:'workspace.operation.locked',
            workspaceRoot:workspace.canonical,
            operation
        });
        throwIfAborted(signal);
        return {
            inherited:false,
            lease,
            release(){
                if(rootState.releasePromise)return rootState.releasePromise;
                rootState.active=false;
                rootState.releasePromise=(async()=>{
                    const child=rootState.child;
                    const misuseError=child===null?null:workspaceBusy(
                        'A nested Arcane workspace operation was still active when its root settled.'
                    );
                    let releaseError;
                    let observerError;
                    if(child!==null)await child.settled;
                    try{
                        const removed=await removeOwnedLock({
                            lockPath,
                            workspaceRoot:workspace.canonical,
                            nonce,
                            handle
                        });
                        handle=null;
                        rootState.handle=null;
                        if(!removed){
                            fail('Workspace operation lock belongs to another owner at cleanup.');
                        }
                    }catch(error){
                        releaseError=error;
                        if(misuseError)releaseError.nestedLeaseError=misuseError;
                    }finally{
                        if(activeRoots.get(workspace.canonical)===lease){
                            activeRoots.delete(workspace.canonical);
                        }
                        leaseStates.delete(lease);
                        await handle?.close().catch(()=>{});
                        handle=null;
                        rootState.handle=null;
                        settleLeaseState(rootState);
                    }
                    if(releaseError)throw releaseError;
                    try{
                        await onEvent?.({
                            type:'workspace.operation.released',
                            workspaceRoot:workspace.canonical,
                            operation
                        });
                    }catch(error){observerError=error;}
                    if(misuseError){
                        if(observerError)misuseError.observerError=observerError;
                        throw misuseError;
                    }
                    return observerError;
                })();
                return rootState.releasePromise;
            }
        };
    }catch(error){
        if(rootState){
            rootState.active=false;
            if(rootState.lease)leaseStates.delete(rootState.lease);
            settleLeaseState(rootState);
        }
        if(activeRoots.get(workspace.canonical)===reservation
            ||activeRoots.get(workspace.canonical)===rootState?.lease){
            activeRoots.delete(workspace.canonical);
        }
        if(handle&&lockPath&&nonce){
            try{
                await removeOwnedLock({
                    lockPath,
                    workspaceRoot:workspace.canonical,
                    nonce,
                    handle
                });
                handle=null;
            }catch(cleanupError){
                error.cleanupError=cleanupError;
            }
        }else{
            await handle?.close().catch(()=>{});
        }
        throw error;
    }
}

function attachReleaseError(workError,releaseError){
    try{
        workError.releaseError=releaseError;
        return workError;
    }catch{
        return new AggregateError(
            [workError,releaseError],
            'The Arcane workspace operation and its lock release both failed.',
            {cause:workError}
        );
    }
}

export async function withWorkspaceOperationLock(options,work){
    if(typeof work!=='function')throw new TypeError('Workspace operation lock work must be a function.');
    const acquired=await acquire(options);
    let result;
    let workError;
    try{
        result=await work(acquired.lease);
    }catch(error){workError=error;}
    let releaseObserverError;
    try{releaseObserverError=await acquired.release();}
    catch(releaseError){
        if(workError)workError=attachReleaseError(workError,releaseError);
        else throw releaseError;
    }
    if(workError&&releaseObserverError){
        workError=attachReleaseError(workError,releaseObserverError);
    }
    if(workError)throw workError;
    return result;
}
