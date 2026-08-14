import assert from 'node:assert/strict';
import {
    copyFile,
    cp,
    mkdir,
    readFile,
    rename,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';
import {
    authenticateRuntimeReceipt,
    readVerifiedRuntimeFile,
    verifyRuntime
} from '../src/runtime.mjs';

async function verifiedRuntimeCopy(t,prefix){
    const temporary=await temporaryDirectory(t,{prefix});
    const runtimeRoot=path.join(temporary,'runtime');
    await cp(path.join(repositoryRoot,'runtime'),runtimeRoot,{recursive:true});
    const receipt=await verifyRuntime({runtimeRoot});
    return {temporary,runtimeRoot,receipt};
}

function selectedReceiptFile(receipt){
    return receipt.files.find(file=>file.bytes>0)??receipt.files[0];
}

test('bundled Arcane runtime matches its immutable release manifest',async()=>{
    const events=[];
    const receipt=await verifyRuntime({onEvent:event=>events.push(event)});
    const manifest=JSON.parse(await readFile(path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json'),'utf8'));

    assert.equal(receipt.contentSha256,manifest.contentSha256);
    assert.equal(receipt.fileCount,manifest.fileCount);
    assert.equal(receipt.totalBytes,manifest.totalBytes);
    assert.deepEqual(receipt.files,manifest.files);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.rootIdentity));
    assert.ok(Object.isFrozen(receipt.files));
    assert.ok(Object.isFrozen(receipt.files[0]));
    assert.throws(()=>receipt.files.push({}),TypeError);
    assert.equal(await authenticateRuntimeReceipt(receipt),receipt);
    const selected=selectedReceiptFile(receipt);
    assert.deepEqual(
        await readVerifiedRuntimeFile(receipt,{relativePath:selected.path}),
        await readFile(path.join(repositoryRoot,'runtime',...selected.path.split('/')))
    );
    await assert.rejects(
        readVerifiedRuntimeFile({...receipt},{relativePath:selected.path}),
        /not issued/i
    );
    assert.equal(events.at(0).type,'runtime.verify.started');
    assert.equal(events.at(-1).type,'runtime.verify.completed');
    assert.equal(events.filter(event=>event.type==='runtime.verify.progress').length,manifest.fileCount);
});

test('runtime receipt rejects an added unverified file',async t=>{
    const {runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-added-');
    await writeFile(
        path.join(runtimeRoot,'arcane','modules','unexpected-runtime-file.js'),
        'unverified\n'
    );
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/inventory changed/.test(error.message)
    );
});

test('runtime receipt rejects a deleted verified file',async t=>{
    const {runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-deleted-');
    const selected=selectedReceiptFile(receipt);
    await rm(path.join(runtimeRoot,...selected.path.split('/')));
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/inventory changed/.test(error.message)
    );
});

test('runtime receipt rejects changed bytes without rehashing',async t=>{
    const {runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-changed-');
    const selected=selectedReceiptFile(receipt);
    const selectedPath=path.join(runtimeRoot,...selected.path.split('/'));
    const bytes=await readFile(selectedPath);
    bytes[0]^=0xff;
    await writeFile(selectedPath,bytes);
    await assert.rejects(
        readVerifiedRuntimeFile(receipt,{runtimeRoot,relativePath:selected.path}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/changed|hash/.test(error.message)
    );
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/file changed/.test(error.message)
    );
});

test('runtime receipt rejects a linked runtime subtree',async t=>{
    const {temporary,runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-link-');
    const linkedPath=path.join(runtimeRoot,'arcane','css');
    const targetPath=path.join(temporary,'linked-css-target');
    await rename(linkedPath,targetPath);
    await symlink(targetPath,linkedPath,'junction');
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/symbolic link|junction/.test(error.message)
    );
});

test('runtime receipt rejects replacement of its canonical root',async t=>{
    const {temporary,runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-root-');
    await rename(runtimeRoot,path.join(temporary,'original-runtime'));
    await cp(path.join(repositoryRoot,'runtime'),runtimeRoot,{recursive:true});
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/root changed/.test(error.message)
    );
});

test('runtime verification rejects changed bytes without mutating the SDK copy',async t=>{
    const temporary=await temporaryDirectory(t);
    const runtimeRoot=path.join(temporary,'runtime');
    await mkdir(runtimeRoot);
    await copyFile(
        path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json'),
        path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json')
    );
    const release=JSON.parse(await readFile(path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json'),'utf8'));
    const selected=release.files.find(file=>file.path.endsWith('.json'))??release.files[0];
    const source=path.join(repositoryRoot,'runtime',...selected.path.split('/'));
    const destination=path.join(runtimeRoot,...selected.path.split('/'));
    await mkdir(path.dirname(destination),{recursive:true});
    await cp(source,destination);
    await writeFile(destination,Buffer.alloc(selected.bytes,0x61));

    release.files=[selected];
    release.fileCount=1;
    release.totalBytes=selected.bytes;
    const {createHash}=await import('node:crypto');
    release.contentSha256=createHash('sha256').update(JSON.stringify(release.files)).digest('hex');
    await writeFile(
        path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json'),
        `${JSON.stringify(release,null,2)}\n`
    );

    await assert.rejects(
        verifyRuntime({runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/integrity check failed/.test(error.message)
    );
});
