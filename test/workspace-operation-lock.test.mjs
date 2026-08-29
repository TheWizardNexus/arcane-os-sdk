import assert from 'node:assert/strict';
import {lstat,readFile,writeFile} from 'node:fs/promises';
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

test('workspace operations use one inspectable cooperative root lock and derived leases',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-lock-'});
    const lockPath=path.join(workspaceRoot,LOCK_RELATIVE);
    const events=[];
    let savedLease;
    const result=await withWorkspaceOperationLock({
        workspaceRoot,
        operation:'outer-test',
        onEvent:event=>events.push(event)
    },async lease=>{
        savedLease=lease;
        assert.equal(Object.isFrozen(lease),false);
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
            'staleRecovery',
            'ttlMilliseconds'
        ]);
        assert.deepEqual(Object.keys(document.owner),['pid']);
        assert.equal(document.kind,'arcane-workspace-operation-lock');
        assert.equal(document.operation,'outer-test');
        assert.equal(document.owner.pid,process.pid);
        assert.equal(document.scope,lease.workspaceRoot);
        assert.equal(document.nonce,lease.nonce);
        assert.equal(document.ttlMilliseconds,6*60*60*1000);
        assert.equal(
            Date.parse(document.expiresAt)-Date.parse(document.acquiredAt),
            document.ttlMilliseconds
        );
        assert.match(document.releaseProcedure,/cooperative lock/u);
        assert.match(document.staleRecovery,/recorded owner process is absent/u);

        await assert.rejects(
            withWorkspaceOperationLock({
                workspaceRoot,
                operation:'forged',
                workspaceOperationLease:{...lease}
            },async()=>{}),
            error=>error?.code==='ARCANE_POLICY_DENIED'
        );
        await assert.rejects(
            withWorkspaceOperationLock({workspaceRoot,operation:'sibling'},async()=>{}),
            error=>error?.code==='ARCANE_WORKSPACE_BUSY'
        );

        const gate=deferred();
        const nested=withWorkspaceOperationLock({
            workspaceRoot,
            operation:'nested-first',
            workspaceOperationLease:lease
        },async nestedLease=>{
            assert.equal(Object.isFrozen(nestedLease),false);
            await gate.promise;
            return 'nested-complete';
        });
        await assert.rejects(
            withWorkspaceOperationLock({
                workspaceRoot,
                operation:'nested-second',
                workspaceOperationLease:lease
            },async()=>{}),
            error=>error?.code==='ARCANE_WORKSPACE_BUSY'
        );
        gate.resolve();
        assert.equal(await nested,'nested-complete');
        return 'outer-complete';
    });

    assert.equal(result,'outer-complete');
    assert.deepEqual(events.map(event=>event.type),[
        'workspace.operation.locked',
        'workspace.operation.released'
    ]);
    assert.equal(events.every(event=>!Object.isFrozen(event)),true);
    await assertLockAbsent(workspaceRoot);
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'expired-derived',
            workspaceOperationLease:savedLease
        },async()=>{}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
});

test('an expired lock with an absent owner is recovered by its logical record',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-stale-'});
    const lockPath=path.join(workspaceRoot,LOCK_RELATIVE);
    const template=await capturedDocument(workspaceRoot);
    const acquiredAt=new Date(Date.now()-template.ttlMilliseconds-60_000);
    await writeFile(lockPath,`${JSON.stringify({
        ...template,
        operation:'stale-test',
        owner:{pid:2_147_483_647},
        acquiredAt:acquiredAt.toISOString(),
        expiresAt:new Date(acquiredAt.getTime()+template.ttlMilliseconds).toISOString()
    },null,2)}\n`,'utf8');

    const events=[];
    await withWorkspaceOperationLock({
        workspaceRoot,
        operation:'replacement',
        onEvent:event=>events.push(event)
    },async lease=>{
        assert.equal(lease.operation,'replacement');
    });
    assert.deepEqual(events.map(event=>event.type),[
        'workspace.operation.stale-recovered',
        'workspace.operation.locked',
        'workspace.operation.released'
    ]);
    assert.equal(events[0].previousOperation,'stale-test');
    await assertLockAbsent(workspaceRoot);
});

test('an unreadable or live lock is preserved and reported busy',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-busy-'});
    const template=await capturedDocument(workspaceRoot);
    const lockPath=path.join(workspaceRoot,LOCK_RELATIVE);

    await writeFile(lockPath,'not json','utf8');
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'blocked'},async()=>{}),
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.equal(await readFile(lockPath,'utf8'),'not json');

    await writeFile(lockPath,`${JSON.stringify({
        ...template,
        operation:'live-test',
        owner:{pid:process.pid}
    },null,2)}\n`,'utf8');
    await assert.rejects(
        withWorkspaceOperationLock({workspaceRoot,operation:'still-blocked'},async()=>{}),
        error=>error?.code==='ARCANE_WORKSPACE_BUSY'
    );
    assert.equal(JSON.parse(await readFile(lockPath,'utf8')).operation,'live-test');
});

test('caller cancellation before acquisition creates no lock',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-operation-cancel-'});
    const controller=new AbortController();
    controller.abort(Object.assign(new Error('cancelled'),{code:'ARCANE_CANCELLED'}));
    await assert.rejects(
        withWorkspaceOperationLock({
            workspaceRoot,
            operation:'cancelled',
            signal:controller.signal
        },async()=>{}),
        error=>error?.code==='ARCANE_CANCELLED'
    );
    await assertLockAbsent(workspaceRoot);
});
