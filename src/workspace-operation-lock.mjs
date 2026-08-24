import {randomUUID} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,mkdir,open,realpath,rename,rm} from 'node:fs/promises';
import path from 'node:path';

const LOCK_DIRECTORY='.arcane';
const LOCK_NAME='workspace-operation.lock.json';
const LOCK_TTL_MILLISECONDS=6*60*60*1000;
const MAX_LOCK_BYTES=64*1024;
const OPEN_EXCLUSIVE=FS_CONSTANTS.O_CREAT|FS_CONSTANTS.O_EXCL|FS_CONSTANTS.O_RDWR
    |(FS_CONSTANTS.O_NOFOLLOW??0);
const OPEN_READ=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const RELEASE_PROCEDURE=
    'The owning Arcane process removes this identity-checked lock after the operation settles.';
const STALE_RECOVERY=
    'Only after expiresAt, confirm the recorded owner process is absent, preserve workspace '
    +'changes, and remove this exact identity-checked lock. A live owner is never displaced.';
const SECURITY_BOUNDARY=
    'This lock coordinates cooperative Arcane SDK mutators. Privileged or non-cooperating '
    +'filesystem mutation is outside the portable JavaScript security boundary.';
const DOCUMENT_KEYS=Object.freeze([
    'acquiredAt',
    'expiresAt',
    'kind',
    'nonce',
    'operation',
    'owner',
    'releaseProcedure',
    'schemaVersion',
    'scope',
    'securityBoundary',
    'staleRecovery',
    'ttlMilliseconds'
].sort());
const OWNER_KEYS=Object.freeze(['pid']);
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

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

function sameLocation(left,right){
    return left.dev===right.dev&&left.ino===right.ino;
}

function sameFileState(left,right){
    return sameLocation(left,right)&&left.size===right.size
        &&left.mtimeNs===right.mtimeNs&&left.ctimeNs===right.ctimeNs
        &&left.nlink===right.nlink&&left.mode===right.mode;
}

function samePath(left,right){
    const normalize=value=>{
        const resolved=path.resolve(value);
        return process.platform==='win32'?resolved.toLocaleLowerCase('en-US'):resolved;
    };
    return normalize(left)===normalize(right);
}

function exactKeys(value,expected){
    return value!==null&&typeof value==='object'&&!Array.isArray(value)
        &&JSON.stringify(Object.keys(value).sort())===JSON.stringify(expected);
}

async function captureRealDirectoryChain(directory,label){
    const resolved=path.resolve(directory);
    let requestedIdentity;
    try{requestedIdentity=await lstat(resolved,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT'){
            fail(`${label} does not exist.`, 'ARCANE_POLICY_DENIED');
        }
        throw error;
    }
    if(requestedIdentity.isSymbolicLink()||!requestedIdentity.isDirectory()){
        fail(`${label} must be a physical directory, not a symbolic link or junction.`,
            'ARCANE_POLICY_DENIED');
    }
    const canonical=await realpath(resolved);
    const root=path.parse(canonical).root;
    const relative=path.relative(root,canonical);
    const segments=relative===''?[]:relative.split(path.sep).filter(Boolean);
    const records=[];
    let current=root;
    for(const segment of [null,...segments]){
        if(segment!==null)current=path.join(current,segment);
        let info;
        try{info=await lstat(current,{bigint:true});}
        catch(error){
            if(error?.code==='ENOENT'){
                fail(`${label} does not exist.`, 'ARCANE_POLICY_DENIED');
            }
            throw error;
        }
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail(`${label} must not contain a symbolic link, junction, or non-directory ancestor.`,
                'ARCANE_POLICY_DENIED');
        }
        records.push(Object.freeze({path:current,identity:info}));
    }
    const identity=records.at(-1).identity;
    if(!sameLocation(requestedIdentity,identity)){
        fail(`${label} must resolve to its captured directory identity.`,
            'ARCANE_POLICY_DENIED');
    }
    return Object.freeze({
        requested:resolved,
        requestedIdentity,
        canonical,
        identity,
        records:Object.freeze(records)
    });
}

async function assertDirectoryChain(chain,label){
    for(const record of chain.records){
        let current;
        try{current=await lstat(record.path,{bigint:true});}
        catch(error){
            if(error?.code==='ENOENT'){
                fail(`${label} changed while its operation boundary was active.`,
                    'ARCANE_POLICY_DENIED');
            }
            throw error;
        }
        if(current.isSymbolicLink()||!current.isDirectory()
            ||!sameLocation(current,record.identity)){
            fail(`${label} changed while its operation boundary was active.`,
                'ARCANE_POLICY_DENIED');
        }
    }
    let canonical;
    let requestedIdentity;
    try{
        canonical=await realpath(chain.requested);
        requestedIdentity=await lstat(chain.requested,{bigint:true});
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`${label} changed while its operation boundary was active.`,
                'ARCANE_POLICY_DENIED');
        }
        throw error;
    }
    if(!samePath(canonical,chain.canonical)
        ||requestedIdentity.isSymbolicLink()||!requestedIdentity.isDirectory()
        ||!sameLocation(requestedIdentity,chain.requestedIdentity)
        ||!sameLocation(requestedIdentity,chain.identity)){
        fail(`${label} changed while its operation boundary was active.`,
            'ARCANE_POLICY_DENIED');
    }
}

async function ensureLockDirectory(workspace){
    await assertDirectoryChain(workspace,'Arcane workspace');
    const requested=path.join(workspace.canonical,LOCK_DIRECTORY);
    try{await mkdir(requested,{mode:0o700});}
    catch(error){if(error?.code!=='EEXIST')throw error;}
    const directory=await captureRealDirectoryChain(
        requested,
        'Workspace operation-lock directory'
    );
    if(!samePath(path.dirname(directory.canonical),workspace.canonical)){
        fail('Workspace operation-lock directory must remain directly inside the workspace.',
            'ARCANE_POLICY_DENIED');
    }
    await assertDirectoryChain(workspace,'Arcane workspace');
    return directory;
}

function ownerIsAlive(pid){
    if(!Number.isSafeInteger(pid)||pid<=0)return true;
    try{
        process.kill(pid,0);
        return true;
    }catch(error){
        return error?.code==='EPERM';
    }
}

function validOperation(operation){
    return typeof operation==='string'&&/^[a-z0-9][a-z0-9.-]*$/u.test(operation);
}

function recoverableDocument(document,{workspaceRoot,now}){
    if(!exactKeys(document,DOCUMENT_KEYS)||!exactKeys(document.owner,OWNER_KEYS))return false;
    const acquired=Date.parse(document.acquiredAt);
    const expires=Date.parse(document.expiresAt);
    return document.schemaVersion===1
        &&document.kind==='arcane-workspace-operation-lock'
        &&validOperation(document.operation)
        &&Number.isSafeInteger(document.owner.pid)
        &&document.owner.pid>0
        &&typeof document.scope==='string'
        &&samePath(document.scope,workspaceRoot)
        &&typeof document.nonce==='string'
        &&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
            .test(document.nonce)
        &&Number.isFinite(acquired)
        &&Number.isFinite(expires)
        &&document.ttlMilliseconds===LOCK_TTL_MILLISECONDS
        &&expires===acquired+LOCK_TTL_MILLISECONDS
        &&expires<=now
        &&document.releaseProcedure===RELEASE_PROCEDURE
        &&document.staleRecovery===STALE_RECOVERY
        &&document.securityBoundary===SECURITY_BOUNDARY
        &&!ownerIsAlive(document.owner.pid);
}

async function existingRegularLock(lockPath){
    let current;
    try{current=await lstat(lockPath,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
    if(current.isSymbolicLink()||!current.isFile()){
        fail('Workspace operation lock path is a symbolic link, junction, or non-file.',
            'ARCANE_POLICY_DENIED');
    }
    return current;
}

async function restoreQuarantinedLock({directory,lockPath,quarantinePath,identity}){
    await assertDirectoryChain(directory,'Workspace operation-lock directory');
    const quarantined=await existingRegularLock(quarantinePath);
    if(quarantined===null||!sameLocation(quarantined,identity))return false;
    if(await existingRegularLock(lockPath)!==null)return false;
    await rename(quarantinePath,lockPath);
    const restored=await existingRegularLock(lockPath);
    return restored!==null&&sameLocation(restored,identity);
}

async function recoverExpiredLock(lockPath,directory,workspaceRoot,onEvent){
    await assertDirectoryChain(directory,'Workspace operation-lock directory');
    const initial=await existingRegularLock(lockPath);
    if(initial===null)return true;
    let handle;
    try{handle=await open(lockPath,OPEN_READ);}
    catch(error){
        if(error?.code==='ENOENT')return true;
        if(error?.code==='ELOOP'){
            fail('Workspace operation lock path is a symbolic link or junction.',
                'ARCANE_POLICY_DENIED');
        }
        throw error;
    }
    try{
        const before=await handle.stat({bigint:true});
        if(!before.isFile()||before.size>BigInt(MAX_LOCK_BYTES)
            ||!sameFileState(before,initial))return false;
        const bytes=await handle.readFile();
        const after=await handle.stat({bigint:true});
        const current=await existingRegularLock(lockPath);
        if(current===null)return true;
        await assertDirectoryChain(directory,'Workspace operation-lock directory');
        if(!sameFileState(before,after)||!sameFileState(after,current))return false;
        let document;
        try{document=JSON.parse(bytes.toString('utf8'));}
        catch{return false;}
        if(!recoverableDocument(document,{workspaceRoot,now:Date.now()}))return false;
        const canonical=Buffer.from(`${JSON.stringify(document,null,2)}\n`,'utf8');
        if(!canonical.equals(bytes))return false;
        await handle.close();
        handle=null;
        await assertDirectoryChain(directory,'Workspace operation-lock directory');
        const final=await existingRegularLock(lockPath);
        if(final===null)return true;
        if(!sameFileState(final,current))return false;

        const quarantinePath=path.join(
            directory.canonical,
            `.${LOCK_NAME}.arcane-stale-${String(process.pid)}-${randomUUID()}`
        );
        await rename(lockPath,quarantinePath);
        let quarantinedHandle;
        let quarantineIdentity=await existingRegularLock(quarantinePath);
        if(quarantineIdentity===null||!sameLocation(quarantineIdentity,final)){
            return false;
        }
        let valid=false;
        try{
            await onEvent?.(Object.freeze({
                type:'workspace.operation.stale-quarantined',
                workspaceRoot,
                quarantinePath
            }));
            await assertDirectoryChain(directory,'Workspace operation-lock directory');
            const quarantined=await existingRegularLock(quarantinePath);
            if(quarantined===null||!sameFileState(quarantined,quarantineIdentity))return false;
            quarantinedHandle=await open(quarantinePath,OPEN_READ);
            const quarantineBefore=await quarantinedHandle.stat({bigint:true});
            if(!sameFileState(quarantineBefore,quarantineIdentity))return false;
            const quarantineBytes=await quarantinedHandle.readFile();
            const quarantineAfter=await quarantinedHandle.stat({bigint:true});
            const quarantineCurrent=await existingRegularLock(quarantinePath);
            if(quarantineCurrent===null
                ||!sameFileState(quarantineBefore,quarantineAfter)
                ||!sameFileState(quarantineAfter,quarantineCurrent)
                ||!quarantineBytes.equals(bytes))return false;
            let quarantineDocument;
            try{quarantineDocument=JSON.parse(quarantineBytes.toString('utf8'));}
            catch{return false;}
            const quarantineCanonical=Buffer.from(
                `${JSON.stringify(quarantineDocument,null,2)}\n`,
                'utf8'
            );
            if(!quarantineCanonical.equals(quarantineBytes)
                ||!recoverableDocument(quarantineDocument,{workspaceRoot,now:Date.now()})){
                return false;
            }
            valid=true;
        }finally{
            await quarantinedHandle?.close().catch(()=>{});
            if(!valid){
                await restoreQuarantinedLock({
                    directory,lockPath,quarantinePath,identity:quarantineIdentity
                }).catch(()=>{});
            }
        }
        await assertDirectoryChain(directory,'Workspace operation-lock directory');
        const deletionCandidate=await existingRegularLock(quarantinePath);
        if(deletionCandidate===null||!sameFileState(deletionCandidate,quarantineIdentity)){
            await restoreQuarantinedLock({
                directory,lockPath,quarantinePath,identity:quarantineIdentity
            }).catch(()=>{});
            return false;
        }
        await rm(quarantinePath);
        return true;
    }finally{
        await handle?.close().catch(()=>{});
    }
}

async function validateOwnedLock({workspace,directory,lockPath,handle,identity,bytes,label}){
    await assertDirectoryChain(workspace,'Arcane workspace');
    await assertDirectoryChain(directory,'Workspace operation-lock directory');
    let opened;
    let current;
    try{
        opened=await handle.stat({bigint:true});
        current=await lstat(lockPath,{bigint:true});
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`Workspace operation lock disappeared ${label}.`, 'ARCANE_POLICY_DENIED');
        }
        throw error;
    }
    if(!opened.isFile()||opened.size!==BigInt(bytes.length)
        ||!sameLocation(opened,identity)||current.isSymbolicLink()||!current.isFile()
        ||!sameLocation(current,identity)){
        fail(`Workspace operation lock changed ${label}.`, 'ARCANE_POLICY_DENIED');
    }
    const read=Buffer.alloc(bytes.length);
    const result=await handle.read(read,0,read.length,0);
    const after=await handle.stat({bigint:true});
    if(result.bytesRead!==bytes.length||!read.equals(bytes)
        ||!sameLocation(after,identity)||after.size!==BigInt(bytes.length)){
        fail(`Workspace operation lock contents changed ${label}.`, 'ARCANE_POLICY_DENIED');
    }
}

async function removeOwnedLock({directory,lockPath,handle,identity}){
    if(!handle||!identity)return {handle:null,removed:false};
    let owned=false;
    try{
        await assertDirectoryChain(directory,'Workspace operation-lock directory');
        const opened=await handle.stat({bigint:true});
        const current=await existingRegularLock(lockPath);
        owned=current!==null&&sameLocation(opened,identity)&&sameLocation(current,identity);
    }finally{
        await handle.close().catch(()=>{});
        handle=null;
    }
    if(!owned)return {handle,removed:false};
    await assertDirectoryChain(directory,'Workspace operation-lock directory');
    const final=await existingRegularLock(lockPath);
    if(final===null)return {handle,removed:true};
    if(!sameLocation(final,identity))return {handle,removed:false};
    await rm(lockPath);
    return {handle,removed:true};
}

function leaseFor(state,operation){
    const lease=Object.freeze({
        workspaceRoot:state.root.workspace.canonical,
        operation,
        nonce:randomUUID(),
        lockPath:state.root.lockPath
    });
    leaseStates.set(lease,state);
    return lease;
}

function inheritedLease(workspace,operation,supplied){
    const parent=leaseStates.get(supplied);
    const root=parent?.root;
    if(!parent?.active||!root?.active
        ||!samePath(parent.root.workspace.canonical,workspace.canonical)
        ||activeRoots.get(workspace.canonical)!==root.lease){
        fail('Arcane workspace operation lease is missing, inactive, or belongs to another workspace.',
            'ARCANE_POLICY_DENIED');
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
    const workspace=await captureRealDirectoryChain(path.resolve(workspaceRoot),'Arcane workspace');
    if(workspaceOperationLease!==undefined){
        return inheritedLease(workspace,operation,workspaceOperationLease);
    }
    if(activeRoots.has(workspace.canonical)){
        fail(`Another Arcane operation already owns ${workspace.canonical}.`);
    }
    const reservation=Object.freeze({kind:'arcane-workspace-operation-reservation'});
    activeRoots.set(workspace.canonical,reservation);
    let directory;
    let lockPath;
    let handle;
    let identity;
    let rootState;
    try{
        directory=await ensureLockDirectory(workspace);
        lockPath=path.join(directory.canonical,LOCK_NAME);
        let recovered=false;
        for(;;){
            try{
                handle=await open(lockPath,OPEN_EXCLUSIVE,0o600);
                break;
            }catch(error){
                if(error?.code==='EEXIST'){
                    if(recovered){
                        fail(
                            `Workspace is locked by another Arcane operation: ${lockPath}. `
                            +'Inspect its owner, expiry, and staleRecovery before retrying.'
                        );
                    }
                    const didRecover=await recoverExpiredLock(
                        lockPath,
                        directory,
                        workspace.canonical,
                        onEvent
                    );
                    if(!didRecover){
                        fail(
                            `Workspace is locked by another Arcane operation: ${lockPath}. `
                            +'Inspect its owner, expiry, and staleRecovery before retrying.'
                        );
                    }
                    recovered=true;
                    continue;
                }
                if(error?.code==='ELOOP'){
                    fail('Workspace operation lock path is a symbolic link or junction.',
                        'ARCANE_POLICY_DENIED');
                }
                throw error;
            }
        }
        // Claim cleanup ownership immediately after O_EXCL succeeds. This identity remains
        // usable even if a later write, sync, callback, or cancellation boundary fails.
        identity=await handle.stat({bigint:true});
        if(!identity.isFile()){
            fail('Workspace operation lock must be a regular file.','ARCANE_POLICY_DENIED');
        }
        const nonce=randomUUID();
        const acquiredAt=new Date();
        const document=Object.freeze({
            schemaVersion:1,
            kind:'arcane-workspace-operation-lock',
            operation,
            owner:Object.freeze({pid:process.pid}),
            scope:workspace.canonical,
            nonce,
            acquiredAt:acquiredAt.toISOString(),
            expiresAt:new Date(acquiredAt.getTime()+LOCK_TTL_MILLISECONDS).toISOString(),
            ttlMilliseconds:LOCK_TTL_MILLISECONDS,
            releaseProcedure:RELEASE_PROCEDURE,
            staleRecovery:STALE_RECOVERY,
            securityBoundary:SECURITY_BOUNDARY
        });
        const bytes=Buffer.from(`${JSON.stringify(document,null,2)}\n`,'utf8');
        await handle.writeFile(bytes);
        await handle.sync();
        await validateOwnedLock({
            workspace,directory,lockPath,handle,identity,bytes,label:'while it was acquired'
        });
        rootState=trackedLeaseState({
            active:true,
            child:null,
            workspace,
            directory,
            lockPath,
            handle,
            identity,
            bytes
        });
        rootState.root=rootState;
        const lease=Object.freeze({
            workspaceRoot:workspace.canonical,
            operation,
            nonce,
            lockPath
        });
        rootState.lease=lease;
        leaseStates.set(lease,rootState);
        activeRoots.set(workspace.canonical,lease);
        await onEvent?.(Object.freeze({
            type:'workspace.operation.locked',
            workspaceRoot:workspace.canonical,
            operation
        }));
        throwIfAborted(signal);
        await validateOwnedLock({
            workspace,directory,lockPath,handle,identity,bytes,
            label:'after the acquisition callback'
        });
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
                        await validateOwnedLock({
                            workspace,directory,lockPath,handle,identity,bytes,
                            label:'before release'
                        });
                        const removed=await removeOwnedLock({directory,lockPath,handle,identity});
                        handle=removed.handle;
                        rootState.handle=handle;
                        if(!removed.removed){
                            fail('Workspace operation lock path changed before cleanup.',
                                'ARCANE_POLICY_DENIED');
                        }
                    }catch(error){
                        releaseError=error;
                        if(misuseError)releaseError.nestedLeaseError=misuseError;
                        if(handle){
                            try{
                                const removed=await removeOwnedLock({
                                    directory,lockPath,handle,identity
                                });
                                handle=removed.handle;
                                rootState.handle=handle;
                            }catch(cleanupError){
                                releaseError.cleanupError=cleanupError;
                            }
                        }
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
                        await onEvent?.(Object.freeze({
                            type:'workspace.operation.released',
                            workspaceRoot:workspace.canonical,
                            operation
                        }));
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
        if(handle&&directory&&lockPath&&identity){
            try{
                const removed=await removeOwnedLock({directory,lockPath,handle,identity});
                handle=removed.handle;
            }catch(cleanupError){
                error.cleanupError=cleanupError;
            }
        }
        await handle?.close().catch(()=>{});
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
