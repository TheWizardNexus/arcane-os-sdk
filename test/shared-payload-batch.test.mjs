import assert from 'node:assert/strict';
import {lstat,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
    PACKAGER_VERSION,
    authenticateSharedPayloadSnapshot,
    packageApp,
    prepareSharedPayloadSnapshot,
    verifyApp
} from '../src/packager/core.mjs';
import {temporaryDirectory} from './helpers.mjs';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

async function createApp(workspaceRoot,appId,displayName){
    const appRoot=path.join(workspaceRoot,'apps',appId);
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:appId,
        displayName,
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        include:['index.html'],
        exclude:[],
        shared:['browser-runtime']
    });
    await writeFile(
        path.join(appRoot,'index.html'),
        `<!doctype html><title>${displayName}</title>\n`
    );
}

async function createBatchFixture(workspaceRoot){
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'runtime-source',
                    destination:'arcane',
                    include:['css','modules'],
                    exclude:[]
                }
            ]
        }
    });
    await createApp(workspaceRoot,'alpha-app','Alpha App');
    await createApp(workspaceRoot,'beta-app','Beta App');
    const runtimeRoot=path.join(workspaceRoot,'runtime-source');
    await mkdir(path.join(runtimeRoot,'css'),{recursive:true});
    await mkdir(path.join(runtimeRoot,'modules'),{recursive:true});
    const theme=':root { --arcane-accent: 120 180 255; }\n';
    const bootstrap='export const themeReady=true;\n';
    await writeFile(path.join(runtimeRoot,'css','theme.css'),theme);
    await writeFile(path.join(runtimeRoot,'modules','ThemeBootstrap.js'),bootstrap);
    return {runtimeRoot,theme,bootstrap};
}

test('one immutable shared snapshot supplies byte-identical runtime payloads to multiple verified apps',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-shared-batch-'});
    const fixture=await createBatchFixture(workspaceRoot);
    const events=[];
    const snapshot=await prepareSharedPayloadSnapshot({
        workspaceRoot,
        sharedPayloadIds:['browser-runtime'],
        onEvent:event=>events.push(event)
    });

    assert.equal(snapshot.kind,'arcane-shared-payload-snapshot');
    assert.equal(snapshot.schemaVersion,1);
    assert.equal(snapshot.fileCount,2);
    assert.equal(events.filter(event=>event.type==='shared-payload.snapshot.started').length,1);
    assert.equal(events.filter(event=>event.type==='shared-payload.snapshot.progress').length,2);
    assert.equal(events.filter(event=>event.type==='shared-payload.snapshot.completed').length,1);
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.files));
    assert.ok(Object.isFrozen(snapshot.files[0]));
    assert.ok(Object.isFrozen(snapshot.rootConfig));
    assert.equal(snapshot.files.some(file=>Object.values(file).some(Buffer.isBuffer)),false);
    assert.equal(
        await authenticateSharedPayloadSnapshot(snapshot,{
            workspaceRoot,
            sharedPayloadIds:['browser-runtime']
        }),
        snapshot
    );

    await writeFile(
        path.join(fixture.runtimeRoot,'css','theme.css'),
        ':root { --arcane-accent: 255 0 0; }\n'
    );
    await writeFile(
        path.join(fixture.runtimeRoot,'modules','ThemeBootstrap.js'),
        'throw new Error("post-snapshot mutation");\n'
    );

    const packageEvents=[];
    for(const appId of ['alpha-app','beta-app']){
        await packageApp({
            workspaceRoot,
            appId,
            sharedPayloadSnapshot:snapshot,
            onEvent:event=>packageEvents.push(event)
        });
    }
    assert.equal(
        packageEvents.filter(event=>event.type.startsWith('shared-payload.snapshot.')).length,
        0
    );

    const payloads=[];
    for(const appId of ['alpha-app','beta-app']){
        const outputRoot=path.join(workspaceRoot,'dist',appId);
        const theme=await readFile(path.join(outputRoot,'arcane','css','theme.css'),'utf8');
        const bootstrap=await readFile(
            path.join(outputRoot,'arcane','modules','ThemeBootstrap.js'),
            'utf8'
        );
        const release=JSON.parse(await readFile(
            path.join(outputRoot,'ARCANE_APP_RELEASE.json'),
            'utf8'
        ));
        assert.equal(theme,fixture.theme);
        assert.equal(bootstrap,fixture.bootstrap);
        assert.equal(release.schemaVersion,1);
        assert.equal(release.builder,PACKAGER_VERSION);
        assert.equal((await verifyApp({workspaceRoot,appId})).verified,true);
        payloads.push({theme,bootstrap});
    }
    assert.deepEqual(payloads[0],payloads[1]);
});

test('root package configuration mutation invalidates a prepared shared snapshot before output mutation',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-shared-config-change-'});
    await createBatchFixture(workspaceRoot);
    const snapshot=await prepareSharedPayloadSnapshot({
        workspaceRoot,
        sharedPayloadIds:['browser-runtime']
    });
    const configPath=path.join(workspaceRoot,'arcane-packager.json');
    const unchangedJson=await readFile(configPath,'utf8');
    await writeFile(configPath,`${unchangedJson.trimEnd()}\n\n`);

    await assert.rejects(
        authenticateSharedPayloadSnapshot(snapshot,{workspaceRoot}),
        /root configuration changed/i
    );
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'alpha-app',
            sharedPayloadSnapshot:snapshot
        }),
        /root configuration changed/i
    );
    await assert.rejects(lstat(path.join(workspaceRoot,'dist')),{code:'ENOENT'});
});

test('foreign shared snapshot receipts are rejected before package output mutation',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-shared-foreign-'});
    await createBatchFixture(workspaceRoot);
    const snapshot=await prepareSharedPayloadSnapshot({
        workspaceRoot,
        sharedPayloadIds:['browser-runtime']
    });
    const foreign=JSON.parse(JSON.stringify(snapshot));

    await assert.rejects(
        authenticateSharedPayloadSnapshot(foreign,{workspaceRoot}),
        /not issued by this SDK process/i
    );
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'alpha-app',
            sharedPayloadSnapshot:foreign
        }),
        /not issued by this SDK process/i
    );
    await assert.rejects(lstat(path.join(workspaceRoot,'dist')),{code:'ENOENT'});
});

test('shared snapshot reauthentication blocks root configuration changes before promotion',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-shared-finalization-'});
    await createBatchFixture(workspaceRoot);
    const snapshot=await prepareSharedPayloadSnapshot({
        workspaceRoot,
        sharedPayloadIds:['browser-runtime']
    });
    const configPath=path.join(workspaceRoot,'arcane-packager.json');
    let changed=false;

    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'alpha-app',
            sharedPayloadSnapshot:snapshot,
            onEvent:async event=>{
                if(changed||event.type!=='package.copy.progress')return;
                changed=true;
                const config=await readFile(configPath,'utf8');
                await writeFile(configPath,`${config.trimEnd()}\n\n`);
            }
        }),
        /root configuration changed/i
    );
    assert.equal(changed,true);
    await assert.rejects(
        lstat(path.join(workspaceRoot,'dist','alpha-app')),
        {code:'ENOENT'}
    );
});
