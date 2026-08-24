import assert from 'node:assert/strict';
import {lstat,mkdir,readFile,readdir,realpath,rename,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {withWorkspaceOperationLock} from '../src/workspace-operation-lock.mjs';
import {temporaryDirectory} from './helpers.mjs';

const LOCK_RELATIVE=path.join('.arcane','workspace-operation.lock.json');

async function pathExists(filePath){
    try{
        await lstat(filePath);
        return true;
    }catch(error){
        if(error?.code==='ENOENT')return false;
        throw error;
    }
}

async function assertLockAbsent(workspaceRoot){
    assert.equal(await pathExists(path.join(workspaceRoot,LOCK_RELATIVE)),false);
}

function deferred(){
    let resolve;
    const promise=new Promise(settle=>{resolve=settle;});
    return {promise,resolve};
}

async function capturedDocument(workspaceRoot){
    let document;
    await withWorkspaceOperationLock({workspaceRoot,operation:'capture'},async()=>{
        document=JSON.parse(await readFile(path.join(workspaceRoot,LOCK_RELATIVE),'utf8'));
    });
    await assertLockAbsent(workspaceRoot);
    return document;
}

function staleDocument(document,{pid=2_147_483_647}={}){
    const acquiredAt=new Date(Date.now()-document.ttlMilliseconds-60_000);
    return {
        ...document,
        operation:'stale-test',
        owner:{pid},
        acquiredAt:acquiredAt.toISOString(),
        expiresAt:new Date(acquiredAt.getTime()+document.ttlMilliseconds).toISOString()
    };
}

test('workspace lock metadata and explicit derived leases reject forgery and sibling concurrency',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-lock-'});
    const lockPath=path.join(workspaceRoot,LOCK_RELATIVE);
    let savedLease;
    const events=[];
    const result=await withWorkspaceOperationLock({
        workspaceRoot,
        operation:'outer-test',
        onEvent:event=>events.push(event.type)
    },async lease=>{
        savedLease=lease;
        const document=JSON.parse(await readFile(lockPath,'utf8'));
        assert.deepEqual(Object.keys(document).sort(),[
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
        ]);
        assert.deepEqual(Object.keys(document.owner),['pid']);
        assert.equal(document.kind,'arcane-workspace-operation-lock');
        assert.equal(document.operation,'outer-test');
        assert.equal(document.owner.pid,process.pid);
        assert.equal(document.scope,lease.workspaceRoot);
        const [requestedCanonical,scopeCanonical]=await Promise.all([
            realpath(workspaceRoot),
            realpath(document.scope)
        ]);
        const [requestedIdentity,scopeIdentity]=await Promise.all([
            lstat(requestedCanonical,{bigint:true}),
            lstat(scopeCanonical,{bigint:true})
        ]);
        assert.equal(requestedIdentity.isDirectory(),true);
        assert.equal(scopeIdentity.isDirectory(),true);
        assert.equal(requestedIdentity.dev,scopeIdentity.dev);
        assert.equal(requestedIdentity.ino,scopeIdentity.ino);
        assert.equal(document.ttlMilliseconds,6*60*60*1000);
        assert.equal(
            Date.parse(document.expiresAt)-Date.parse(document.acquiredAt),
            document.ttlMilliseconds
        );
        assert.match(document.releaseProcedure,/identity-checked lock/u);
        assert.match(document.staleRecovery,/live owner is never displaced/iu);
        assert.match(document.securityBoundary,/cooperative Arcane SDK mutators/iu);
        assert.match(document.securityBoundary,/non-cooperating filesystem mutation/iu);

        await assert.rejects(
            withWorkspaceOperationLock({
                workspaceRoot,
                operation:'forged',
                workspaceOperationLease:{...lease}
            },async()=>{}),
            error=>error?.code==='ARCANE_POLICY_DENIED'
        );

        let enterNested;
        const entered=new Promise(resolve=>{enterNested=resolve;});
        let finishNested;
        const finish=new Promise(resolve=>{finishNested=resolve;});
        const first=withWorkspaceOperationLock({
            workspaceRoot,
            operation:'nested-first',
            workspaceOperationLease:lease
        },async nestedLease=>{
            assert.notEqual(nestedLease,lease);
            enterNested();
            await finish;
            return 'nested-result';
        });
        await entered;
        await assert.rejects(
            withWorkspaceOperationLock({
                workspaceRoot,
                operation:'nested-sibling',
                workspaceOperationLease:lease
            },async()=>{}),
            error=>error?.code==='ARCANE_WORKSPACE_BUSY'
        );
        await assert.rejects(
            withWorkspaceOperationLock({workspaceRoot,operation:'concurrent-root'},async()=>{}),
            error=>error?.code==='ARCANE_WORKSPACE_BUSY'
        );
        finishNested();
        assert.equal(await first,'nested-result');

        assert.equal(await withWorkspaceOperationLock({
            workspaceRoot,
            operation:'nested-sequential',
            workspaceOperationLease:lease
        },async nestedLease=>withWorkspaceOperationLock({
            workspaceRoot,
            operation:'nested-depth-two',
            workspaceOperationLease:nestedLease
        },async()=>42)),42);
        return 'outer-result';
    });
    assert.equal(result,'outer-result');
    assert.deepEqual(events,['workspace.operation.locked','workspace.operation.released']);
    await assertLockAbsent(workspaceRoot);
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'expired-token',
            workspaceOperationLease:savedLease
        },async()=>{}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    await assertLockAbsent(workspaceRoot);
});

test('parent settlement drains active child and grandchild leases before releasing the root',async t=>{
    const childWorkspace=await temporaryDirectory(t,{prefix:'arcane-operation-child-drain-'});
    const childStarted=deferred();
    const finishChild=deferred();
    let childOperation;
    const earlyParent=withWorkspaceOperationLock({
        workspaceRoot:childWorkspace,
        operation:'early-parent'
    },async lease=>{
        childOperation=withWorkspaceOperationLock({
            workspaceRoot:childWorkspace,
            operation:'late-child',
            workspaceOperationLease:lease
        },async()=>{
            childStarted.resolve();
            await finishChild.promise;
            return 'child-finished';
        });
        await childStarted.promise;
        return 'parent-returned-early';
    });
    await childStarted.promise;
    const earlyParentFailure=assert.rejects(
        earlyParent,
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.equal(await pathExists(path.join(childWorkspace,LOCK_RELATIVE)),true);
    finishChild.resolve();
    assert.equal(await childOperation,'child-finished');
    await earlyParentFailure;
    await assertLockAbsent(childWorkspace);
    assert.equal(await withWorkspaceOperationLock({
        workspaceRoot:childWorkspace,
        operation:'after-child-drain'
    },async()=>17),17);
    await assertLockAbsent(childWorkspace);

    const grandchildWorkspace=await temporaryDirectory(t,{
        prefix:'arcane-operation-grandchild-drain-'
    });
    const grandchildStarted=deferred();
    const finishGrandchild=deferred();
    let childWithGrandchild;
    let grandchildOperation;
    const earlyRoot=withWorkspaceOperationLock({
        workspaceRoot:grandchildWorkspace,
        operation:'early-root'
    },async rootLease=>{
        childWithGrandchild=withWorkspaceOperationLock({
            workspaceRoot:grandchildWorkspace,
            operation:'early-child',
            workspaceOperationLease:rootLease
        },async childLease=>{
            grandchildOperation=withWorkspaceOperationLock({
                workspaceRoot:grandchildWorkspace,
                operation:'late-grandchild',
                workspaceOperationLease:childLease
            },async()=>{
                grandchildStarted.resolve();
                await finishGrandchild.promise;
                return 'grandchild-finished';
            });
            await grandchildStarted.promise;
            return 'child-returned-early';
        });
        await grandchildStarted.promise;
        return 'root-returned-early';
    });
    await grandchildStarted.promise;
    const childFailure=assert.rejects(
        childWithGrandchild,
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    const rootFailure=assert.rejects(
        earlyRoot,
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.equal(await pathExists(path.join(grandchildWorkspace,LOCK_RELATIVE)),true);
    finishGrandchild.resolve();
    assert.equal(await grandchildOperation,'grandchild-finished');
    await childFailure;
    await rootFailure;
    await assertLockAbsent(grandchildWorkspace);

    const failureWorkspace=await temporaryDirectory(t,{prefix:'arcane-operation-error-drain-'});
    const failureChildStarted=deferred();
    const finishFailureChild=deferred();
    const workFailure=new Error('parent work failed before its child settled');
    let failureChild;
    const failedParent=withWorkspaceOperationLock({
        workspaceRoot:failureWorkspace,
        operation:'failed-parent'
    },async lease=>{
        failureChild=withWorkspaceOperationLock({
            workspaceRoot:failureWorkspace,
            operation:'failure-child',
            workspaceOperationLease:lease
        },async()=>{
            failureChildStarted.resolve();
            await finishFailureChild.promise;
        });
        await failureChildStarted.promise;
        throw workFailure;
    });
    await failureChildStarted.promise;
    const failedParentAssertion=assert.rejects(
        failedParent,
        error=>error===workFailure&&error.releaseError?.code==='ARCANE_WORKSPACE_BUSY'
    );
    finishFailureChild.resolve();
    await failureChild;
    await failedParentAssertion;
    await assertLockAbsent(failureWorkspace);
});

test('expired locks are recovered only for an absent owner and acquisition really retries',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-stale-'});
    const lockPath=path.join(workspaceRoot,LOCK_RELATIVE);
    const template=await capturedDocument(workspaceRoot);

    const live=staleDocument(template,{pid:process.pid});
    await writeFile(lockPath,`${JSON.stringify(live,null,2)}\n`,'utf8');
    const liveBytes=await readFile(lockPath);
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'must-not-steal'},async()=>{}),
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.deepEqual(await readFile(lockPath),liveBytes);
    await rm(lockPath);

    const stale=staleDocument(template);
    const wrongScope={...stale,scope:path.join(workspaceRoot,'different-workspace')};
    await writeFile(lockPath,`${JSON.stringify(wrongScope,null,2)}\n`,'utf8');
    const wrongScopeBytes=await readFile(lockPath);
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'wrong-scope-recovery'},async()=>{}),
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.deepEqual(await readFile(lockPath),wrongScopeBytes);
    await rm(lockPath);

    await writeFile(lockPath,`${JSON.stringify(stale,null,2)}\n`,'utf8');
    let executed=false;
    const value=await withWorkspaceOperationLock({
        workspaceRoot,
        operation:'after-stale-recovery'
    },async()=>{
        executed=true;
        const current=JSON.parse(await readFile(lockPath,'utf8'));
        assert.equal(current.operation,'after-stale-recovery');
        assert.equal(current.owner.pid,process.pid);
        return 17;
    });
    assert.equal(executed,true);
    assert.equal(value,17);
    await assertLockAbsent(workspaceRoot);

    await writeFile(lockPath,`${JSON.stringify(stale,null,2)}\n`,'utf8');
    let abaWorkCalled=false;
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'same-inode-aba-recovery',
            async onEvent(event){
                if(event.type!=='workspace.operation.stale-quarantined')return;
                const original=await readFile(event.quarantinePath,'utf8');
                const replacement=`${stale.nonce.slice(0,-1)}${stale.nonce.endsWith('0')?'1':'0'}`;
                const changed=original.replace(stale.nonce,replacement);
                assert.equal(Buffer.byteLength(changed),Buffer.byteLength(original));
                await writeFile(event.quarantinePath,changed,'utf8');
            }
        },async()=>{abaWorkCalled=true;}),
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.equal(abaWorkCalled,false);
    assert.notDeepEqual(await readFile(lockPath),Buffer.from(`${JSON.stringify(stale,null,2)}\n`));
    assert.deepEqual(
        (await readdir(path.dirname(lockPath))).filter(name=>name.includes('.arcane-stale-')),
        []
    );
    await rm(lockPath);
});

test('acquisition callbacks cannot mutate or remove the owned lock',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-callback-'});
    const lockPath=path.join(workspaceRoot,LOCK_RELATIVE);
    let workCalled=false;
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'callback-tamper',
            async onEvent(event){
                if(event.type==='workspace.operation.locked'){
                    await writeFile(lockPath,'tampered\n','utf8');
                }
            }
        },async()=>{workCalled=true;}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    assert.equal(workCalled,false);
    await assertLockAbsent(workspaceRoot);

    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'callback-removal',
            async onEvent(event){
                if(event.type==='workspace.operation.locked')await rm(lockPath);
            }
        },async()=>{workCalled=true;}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    assert.equal(workCalled,false);
    await assertLockAbsent(workspaceRoot);

    const callbackFailure=new Error('acquisition callback failed');
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'callback-failure',
            onEvent(event){
                if(event.type==='workspace.operation.locked')throw callbackFailure;
            }
        },async()=>{}),
        error=>error===callbackFailure
    );
    await assertLockAbsent(workspaceRoot);
});

test('cancellation and work failures release the exact owned lock',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-failure-'});
    const preAborted=new AbortController();
    const preAbortFailure=new Error('cancel before lock acquisition');
    preAborted.abort(preAbortFailure);
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'pre-abort-test',
            signal:preAborted.signal
        },async()=>{}),
        error=>error===preAbortFailure&&error.code==='ARCANE_CANCELLED'
    );
    await assertLockAbsent(workspaceRoot);

    const controller=new AbortController();
    assert.equal(
        await withWorkspaceOperationLock({
            workspaceRoot,
            operation:'committed-cancellation-test',
            signal:controller.signal
        },async()=>{
            controller.abort(new Error('observer cancelled after commit'));
            return 'committed-result';
        }),
        'committed-result'
    );
    await assertLockAbsent(workspaceRoot);

    const cancellation=new Error('cancel cooperative work');
    cancellation.code='ARCANE_CANCELLED';
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'work-cancel-test'},async()=>{
            throw cancellation;
        }),
        error=>error===cancellation
    );
    await assertLockAbsent(workspaceRoot);

    const workFailure=new Error('protected work failed');
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'work-failure'},async()=>{
            throw workFailure;
        }),
        error=>error===workFailure
    );
    await assertLockAbsent(workspaceRoot);

    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'work-tamper'},async()=>{
            await writeFile(
                path.join(workspaceRoot,LOCK_RELATIVE),
                'cooperative work tampered with its own lock\n',
                'utf8'
            );
        }),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    await assertLockAbsent(workspaceRoot);

    const combinedWorkFailure=new Error('combined work failed');
    const releaseFailure=new Error('release callback failed');
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'combined-failure',
            onEvent(event){
                if(event.type==='workspace.operation.released')throw releaseFailure;
            }
        },async()=>{throw combinedWorkFailure;}),
        error=>error===combinedWorkFailure&&error.releaseError===releaseFailure
    );
    await assertLockAbsent(workspaceRoot);

    const successfulReleaseFailure=new Error('successful release callback failed');
    assert.equal(
        await withWorkspaceOperationLock({
            workspaceRoot,
            operation:'successful-release-listener-failure',
            onEvent(event){
                if(event.type==='workspace.operation.released')throw successfulReleaseFailure;
            }
        },async()=> 'committed-despite-listener'),
        'committed-despite-listener'
    );
    await assertLockAbsent(workspaceRoot);
});

test('static workspace and lock-directory links fail closed without touching their targets',async t=>{
    const root=await temporaryDirectory(t,{prefix:'arcane-operation-links-'});
    const realWorkspace=path.join(root,'real-workspace');
    const linkedWorkspace=path.join(root,'linked-workspace');
    await mkdir(realWorkspace);
    await symlink(
        realWorkspace,
        linkedWorkspace,
        process.platform==='win32'?'junction':'dir'
    );
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot:linkedWorkspace,operation:'linked-root'},async()=>{}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    assert.equal(await pathExists(path.join(realWorkspace,'.arcane')),false);

    const workspaceRoot=path.join(root,'workspace');
    const outside=path.join(root,'outside-lock-directory');
    await mkdir(workspaceRoot);
    await mkdir(outside);
    const sentinel=path.join(outside,'sentinel.txt');
    await writeFile(sentinel,'unchanged\n','utf8');
    await symlink(
        outside,
        path.join(workspaceRoot,'.arcane'),
        process.platform==='win32'?'junction':'dir'
    );
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'linked-lock-directory'},async()=>{}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    assert.equal(await readFile(sentinel,'utf8'),'unchanged\n');
    assert.equal(await pathExists(path.join(outside,'workspace-operation.lock.json')),false);
});

test('identity-equivalent Windows namespace aliases preserve the workspace boundary',async t=>{
    if(process.platform!=='win32')return;
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-windows-alias-'});
    const alias=`\\\\?\\${workspaceRoot}`;
    const canonical=await realpath(workspaceRoot);
    assert.notEqual(path.resolve(alias).toLocaleLowerCase('en-US'),canonical.toLocaleLowerCase('en-US'));
    await withWorkspaceOperationLock({
        workspaceRoot:alias,
        operation:'windows-namespace-alias'
    },async lease=>{
        assert.equal(lease.workspaceRoot,canonical);
        assert.equal(await realpath(alias),canonical);
    });
    await assertLockAbsent(workspaceRoot);
});

test('a physical workspace beneath a stable linked ancestor binds to its canonical identity',async t=>{
    const root=await temporaryDirectory(t,{prefix:'arcane-operation-ancestor-alias-'});
    const physicalParent=path.join(root,'physical-parent');
    const workspaceRoot=path.join(physicalParent,'workspace');
    const aliasParent=path.join(root,'runner-alias');
    await mkdir(workspaceRoot,{recursive:true});
    await symlink(physicalParent,aliasParent,process.platform==='win32'?'junction':'dir');
    const aliasedWorkspace=path.join(aliasParent,'workspace');
    const canonical=await realpath(workspaceRoot);
    await withWorkspaceOperationLock({
        workspaceRoot:aliasedWorkspace,
        operation:'stable-ancestor-alias'
    },async lease=>{
        assert.equal(lease.workspaceRoot,canonical);
        assert.equal(await pathExists(path.join(workspaceRoot,LOCK_RELATIVE)),true);
    });
    await assertLockAbsent(workspaceRoot);
});

test('retargeting an admitted linked ancestor fails closed without touching its replacement',async t=>{
    const root=await temporaryDirectory(t,{prefix:'arcane-operation-ancestor-swap-'});
    const originalParent=path.join(root,'original-parent');
    const replacementParent=path.join(root,'replacement-parent');
    const originalWorkspace=path.join(originalParent,'workspace');
    const replacementWorkspace=path.join(replacementParent,'workspace');
    const aliasParent=path.join(root,'runner-alias');
    const retiredAlias=path.join(root,'retired-runner-alias');
    await mkdir(originalWorkspace,{recursive:true});
    await mkdir(replacementWorkspace,{recursive:true});
    await symlink(originalParent,aliasParent,process.platform==='win32'?'junction':'dir');
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot:path.join(aliasParent,'workspace'),
            operation:'ancestor-alias-swap'
        },async()=>{
            await rename(aliasParent,retiredAlias);
            await symlink(
                replacementParent,
                aliasParent,
                process.platform==='win32'?'junction':'dir'
            );
        }),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    await assertLockAbsent(originalWorkspace);
    assert.equal(await pathExists(path.join(replacementWorkspace,'.arcane')),false);
});
