import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {workspaceTemplate} from '../src/templates/workspace-template.mjs';
import {discoverApps,resolveWorkspace,selectApp} from '../src/workspace.mjs';
import {temporaryDirectory} from './helpers.mjs';

async function selectionFixture(context,{invalidSibling=true}={}){
    const workspaceRoot=await temporaryDirectory(context);
    for(const appId of ['docs','unrelated']){
        const {files}=workspaceTemplate({appId,appsRoot:'apps',appOnly:appId==='unrelated'});
        for(const [relative,content] of files){
            const target=path.join(workspaceRoot,relative);
            await mkdir(path.dirname(target),{recursive:true});
            await writeFile(target,content);
        }
    }
    if(invalidSibling){
        const descriptorPath=path.join(workspaceRoot,'apps/unrelated/arcane-app.json');
        const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
        descriptor.native={...descriptor.native,documentCatalog:{policy:'public-only'}};
        await writeFile(descriptorPath,JSON.stringify(descriptor));
    }
    return workspaceRoot;
}

test('named selection and resolution do not validate an unrelated invalid descriptor',async t=>{
    const workspaceRoot=await selectionFixture(t);
    assert.equal((await selectApp(workspaceRoot,'docs')).appId,'docs');
    const resolved=await resolveWorkspace({workspaceRoot,appId:'docs'});
    assert.equal(resolved.appId,'docs');
    assert.deepEqual(resolved.appIds,['docs']);
});

test('the selected descriptor and unscoped discovery remain strictly validated',async t=>{
    const workspaceRoot=await selectionFixture(t);
    for(const operation of [
        ()=>selectApp(workspaceRoot,'unrelated'),
        ()=>resolveWorkspace({workspaceRoot,appId:'unrelated'}),
        ()=>discoverApps(workspaceRoot),
        ()=>selectApp(workspaceRoot),
        ()=>resolveWorkspace({workspaceRoot})
    ]){
        await assert.rejects(operation,error=>error.code==='ARCANE_APP_DESCRIPTOR_INVALID');
    }
});

test('invalid and unknown selected identifiers retain explicit errors',async t=>{
    const workspaceRoot=await selectionFixture(t);
    for(const appId of ['',null,42,'../docs']){
        await assert.rejects(()=>selectApp(workspaceRoot,appId),error=>error.code==='ARCANE_USAGE');
        await assert.rejects(()=>resolveWorkspace({workspaceRoot,appId}),error=>error.code==='ARCANE_USAGE');
    }
    await assert.rejects(()=>selectApp(workspaceRoot,'missing'),/Unknown app "missing"/u);
    await assert.rejects(()=>resolveWorkspace({workspaceRoot,appId:'missing'}),/Unknown app "missing"/u);
});

test('unscoped discovery retains all valid apps and requires a selection for multiple apps',async t=>{
    const workspaceRoot=await selectionFixture(t,{invalidSibling:false});
    assert.deepEqual((await discoverApps(workspaceRoot)).map(app=>app.appId),['docs','unrelated']);
    await assert.rejects(()=>selectApp(workspaceRoot),error=>error.code==='ARCANE_USAGE');
    await assert.rejects(()=>resolveWorkspace({workspaceRoot}),error=>error.code==='ARCANE_USAGE');
});
