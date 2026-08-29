import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    RELEASE_MANIFEST_NAME,
    discoverApps,
    inspectApp,
    packageApp,
    verifyApp
} from '../src/packager/core.mjs';

async function writeJson(filePath,value){
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function workspaceFixture(t,{security}={}){
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-packager-content-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const appRoot=path.join(workspaceRoot,'apps','complete-app');
    await Promise.all([
        mkdir(path.join(appRoot,'content'),{recursive:true}),
        mkdir(path.join(workspaceRoot,'runtime','modules'),{recursive:true})
    ]);
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            runtime:[{
                source:'runtime',
                destination:'arcane',
                include:['modules'],
                exclude:[]
            }]
        }
    });
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:'complete-app',
        displayName:'Complete App',
        version:'1.2.3',
        entry:'index.html',
        strategy:'static',
        ...(security===undefined?{}:{security}),
        include:['index.html','content'],
        exclude:[],
        shared:['runtime']
    });
    const html='<!doctype html>\n<title>Complete content</title>\n<p>  preserve spacing  </p>\n';
    const document='first line\nsecond line\nthird line with trailing space \n';
    const module='export const complete = `all shared content`;\n';
    await Promise.all([
        writeFile(path.join(appRoot,'index.html'),html),
        writeFile(path.join(appRoot,'content','document.txt'),document),
        writeFile(path.join(workspaceRoot,'runtime','modules','complete.js'),module)
    ]);
    return {workspaceRoot,appRoot,html,document,module};
}

test('packager materializes every selected app and shared file with complete content',async t=>{
    const selected=await workspaceFixture(t);
    assert.deepEqual(await discoverApps({workspaceRoot:selected.workspaceRoot}),['complete-app']);
    const inspected=await inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(inspected.files,[
        'arcane/modules/complete.js',
        'content/document.txt',
        'index.html'
    ]);

    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(packaged.files,inspected.files);
    assert.equal(await readFile(path.join(packaged.outputRoot,'index.html'),'utf8'),selected.html);
    assert.equal(await readFile(
        path.join(packaged.outputRoot,'content','document.txt'),
        'utf8'
    ),selected.document);
    assert.equal(await readFile(
        path.join(packaged.outputRoot,'arcane','modules','complete.js'),
        'utf8'
    ),selected.module);

    const release=JSON.parse(await readFile(
        path.join(packaged.outputRoot,RELEASE_MANIFEST_NAME),
        'utf8'
    ));
    assert.deepEqual(release.files,inspected.files);
    assert.equal(release.app.id,'complete-app');
    assert.equal(release.app.version,'1.2.3');

    const verified=await verifyApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.equal(verified.verified,true);
    assert.deepEqual(verified.files,inspected.files);
});

test('ordinary app packaging permits omitted security and preserves an explicit record',async t=>{
    const ordinary=await workspaceFixture(t);
    const ordinaryResult=await packageApp({
        workspaceRoot:ordinary.workspaceRoot,
        appId:'complete-app'
    });
    assert.equal(Object.hasOwn(ordinaryResult.manifest.app,'security'),false);

    const explicit=await workspaceFixture(t,{
        security:{connectOrigins:['https://example.test']}
    });
    const explicitResult=await packageApp({
        workspaceRoot:explicit.workspaceRoot,
        appId:'complete-app'
    });
    assert.deepEqual(explicitResult.manifest.app.security,{
        connectOrigins:['https://example.test']
    });
});

test('dry-run returns the complete structural inventory without creating release output',async t=>{
    const selected=await workspaceFixture(t);
    const result=await packageApp({
        workspaceRoot:selected.workspaceRoot,
        appId:'complete-app',
        dryRun:true
    });
    assert.equal(result.dryRun,true);
    assert.deepEqual(result.files,[
        'arcane/modules/complete.js',
        'content/document.txt',
        'index.html'
    ]);
});
