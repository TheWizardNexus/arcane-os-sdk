import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {
    authenticateAppReleaseReceipt,
    packageApp,
    readVerifiedAppReleaseFile,
    verifyApp
} from '../src/packager/core.mjs';
import {packageApplication} from '../src/toolchain.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

async function createExternalFixture(root){
    await writeJson(path.join(root,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'node_modules/arcane-os/runtime/arcane',
                    destination:'arcane',
                    include:['components','css','entities','img','modules'],
                    exclude:[]
                },
                {
                    source:'node_modules/arcane-os/runtime/strong-type',
                    destination:'node_modules/strong-type',
                    include:['index.js','licence','package.json'],
                    exclude:[]
                }
            ]
        }
    });

    const appRoot=path.join(root,'apps','fixture-app');
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:'fixture-app',
        displayName:'Fixture App',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        security:{
            connectOrigins:['https://api.example.com'],
            frameOrigins:[],
            mediaOrigins:[]
        },
        include:['fixture-app.css','index.html','manifest.json','modules'],
        exclude:[],
        shared:['browser-runtime']
    });
    await writeJson(path.join(appRoot,'manifest.json'),{
        name:'Fixture App',
        start_url:'./index.html',
        display:'standalone',
        icons:[]
    });
    await writeFile(path.join(appRoot,'index.html'),'<!doctype html><title>Fixture App</title>\n');
    await writeFile(path.join(appRoot,'fixture-app.css'),'body { color: rgb(240, 240, 240); }\n');
    await mkdir(path.join(appRoot,'modules'));
    await writeFile(path.join(appRoot,'modules','App.js'),'export const ready=true;\n');

    const arcaneRoot=path.join(root,'node_modules','arcane-os','runtime','arcane');
    for(const directory of ['components','css','entities','img','modules']){
        await mkdir(path.join(arcaneRoot,directory),{recursive:true});
        await writeFile(path.join(arcaneRoot,directory,'fixture.txt'),`${directory}\n`);
    }
    const strongTypeRoot=path.join(root,'node_modules','arcane-os','runtime','strong-type');
    await mkdir(strongTypeRoot,{recursive:true});
    await writeFile(path.join(strongTypeRoot,'index.js'),'export const type=value=>value;\n');
    await writeFile(path.join(strongTypeRoot,'licence'),'MIT\n');
    await writeJson(path.join(strongTypeRoot,'package.json'),{
        name:'strong-type',
        version:'0.0.0-test',
        type:'module'
    });
}

async function snapshotRelease(workspaceRoot){
    const releaseRoot=path.join(workspaceRoot,'dist','fixture-app');
    const manifest=await readFile(path.join(releaseRoot,'ARCANE_APP_RELEASE.json'),'utf8');
    const entry=await readFile(path.join(releaseRoot,'apps','fixture-app','index.html'),'utf8');
    return {manifest,entry};
}

async function installSdkRuntime(workspaceRoot){
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    await cp(
        path.join(repositoryRoot,'runtime'),
        path.join(installedRoot,'runtime'),
        {recursive:true}
    );
    await cp(path.join(repositoryRoot,'package.json'),path.join(installedRoot,'package.json'));
    for(const license of ['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']){
        await cp(path.join(repositoryRoot,license),path.join(installedRoot,license));
    }
}

function delay(milliseconds){
    return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

test('external workspace packages deterministically and detects release tampering',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-external-package-'});
    await createExternalFixture(workspaceRoot);

    const first=await packageApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(first.app,'fixture-app');
    assert.match(first.contentSha256,/^[0-9a-f]{64}$/);
    assert.equal(first.receipt.kind,'arcane-app-release-verification');
    const releaseManifest=JSON.parse(await readFile(
        path.join(workspaceRoot,'dist','fixture-app','ARCANE_APP_RELEASE.json'),
        'utf8'
    ));
    assert.deepEqual(first.receipt.files,releaseManifest.files);
    assert.ok(Object.isFrozen(first.receipt.files));
    assert.ok(Object.isFrozen(first.receipt.files[0]));
    assert.ok(Object.isFrozen(first.receipt.app));
    assert.ok(Object.isFrozen(first.receipt.app.security));
    assert.deepEqual(first.receipt.app.security,{
        connectOrigins:['https://api.example.com'],
        frameOrigins:[],
        mediaOrigins:[]
    });
    assert.ok(Object.isFrozen(first.receipt.app.localAIModelPolicy));
    assert.throws(()=>first.receipt.files.push({}),TypeError);
    const releaseRoot=path.join(workspaceRoot,'dist','fixture-app');
    assert.equal(
        await authenticateAppReleaseReceipt(first.receipt,{releaseRoot}),
        first.receipt
    );
    assert.equal(
        (await readVerifiedAppReleaseFile(first.receipt,{
            releaseRoot,
            relativePath:'apps/fixture-app/index.html'
        })).toString('utf8'),
        await readFile(path.join(releaseRoot,'apps','fixture-app','index.html'),'utf8')
    );
    await assert.rejects(
        authenticateAppReleaseReceipt({...first.receipt},{releaseRoot}),
        /not issued/i
    );
    await assert.rejects(
        readVerifiedAppReleaseFile({...first.receipt},{
            releaseRoot,
            relativePath:'apps/fixture-app/index.html'
        }),
        /not issued/i
    );
    await assert.rejects(
        readVerifiedAppReleaseFile(first.receipt,{
            releaseRoot,
            relativePath:'ARCANE_APP_RELEASE.json'
        }),
        /not in the verified/i
    );
    const verified=await verifyApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(verified.verified,true);
    assert.equal(verified.contentSha256,first.contentSha256);
    assert.equal(
        await authenticateAppReleaseReceipt(verified.receipt,{releaseRoot}),
        verified.receipt
    );

    const second=await packageApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(second.contentSha256,first.contentSha256);
    assert.equal(second.fileCount,first.fileCount);
    assert.equal(second.totalBytes,first.totalBytes);

    await assert.rejects(readFile(path.join(releaseRoot,'arcane-package.json')),{code:'ENOENT'});
    await writeFile(path.join(releaseRoot,'apps','fixture-app','index.html'),'tampered\n');
    await assert.rejects(
        readVerifiedAppReleaseFile(second.receipt,{
            releaseRoot,
            relativePath:'apps/fixture-app/index.html'
        }),
        /changed|hash|inventory/i
    );
    await assert.rejects(
        authenticateAppReleaseReceipt(second.receipt,{releaseRoot}),
        /changed|receipt|inventory/i
    );
    await assert.rejects(
        verifyApp({workspaceRoot,appId:'fixture-app'}),
        /hash|integrity|inventory|bytes|release/i
    );
});

test('release verification binds the exact authored security policy',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-security-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const configPath=path.join(workspaceRoot,'apps','fixture-app','arcane-package.json');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    config.security.connectOrigins=['https://changed.example.com'];
    await writeJson(configPath,config);
    await assert.rejects(
        verifyApp({workspaceRoot,appId:'fixture-app'}),
        /identity|policy|security/u
    );
});

test('source replacement during copy cannot activate a mixed release',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-copy-race-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const before=await snapshotRelease(workspaceRoot);
    const mutableSource=path.join(workspaceRoot,'apps','fixture-app','modules','App.js');
    let changed=false;

    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'fixture-app',
            onEvent:async event=>{
                if(!changed&&event.type==='package.copy.progress'){
                    changed=true;
                    await writeFile(mutableSource,'export const ready=false;\n');
                }
            }
        }),
        /changed after its package inventory|changed while/i
    );
    assert.equal(changed,true);
    assert.deepEqual(await snapshotRelease(workspaceRoot),before);
    assert.equal((await verifyApp({workspaceRoot,appId:'fixture-app'})).verified,true);
});

test('cancelled package work preserves the previously verified release',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-cancelled-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const before=await snapshotRelease(workspaceRoot);

    await writeFile(
        path.join(workspaceRoot,'apps','fixture-app','index.html'),
        '<!doctype html><title>Changed but cancelled</title>\n'
    );
    const controller=new AbortController();
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'fixture-app',
            signal:controller.signal,
            onEvent:event=>{
                if(event.type==='package.copy.progress'){
                    const reason=new Error('Test cancellation.');
                    reason.code='ARCANE_CANCELLED';
                    controller.abort(reason);
                }
            }
        }),
        error=>error?.code==='ARCANE_CANCELLED'
    );

    const after=await snapshotRelease(workspaceRoot);
    assert.deepEqual(after,before);
    const verified=await verifyApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(verified.verified,true);
});

test('changed verified source state blocks package promotion',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-source-state-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const before=await snapshotRelease(workspaceRoot);

    await writeFile(
        path.join(workspaceRoot,'apps','fixture-app','index.html'),
        '<!doctype html><title>Changed source state</title>\n'
    );
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'fixture-app',
            validateSourceState:()=>{
                const error=new Error('Verified runtime source state changed.');
                error.code='ARCANE_INTEGRITY_FAILED';
                throw error;
            }
        }),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );

    assert.deepEqual(await snapshotRelease(workspaceRoot),before);
    assert.equal((await verifyApp({workspaceRoot,appId:'fixture-app'})).verified,true);
});

test('descriptor mutation during packaging blocks release promotion',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-descriptor-race-package-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='descriptor-race';
    await createWorkspace({targetPath:workspaceRoot,appId});
    await installSdkRuntime(workspaceRoot);
    await packageApp({workspaceRoot,appId});
    const releaseManifestPath=path.join(
        workspaceRoot,
        'dist',
        appId,
        'ARCANE_APP_RELEASE.json'
    );
    const before=await readFile(releaseManifestPath,'utf8');
    const descriptorPath=path.join(workspaceRoot,'apps',appId,'arcane-app.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    let changed=false;

    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId,
            onEvent:async event=>{
                if(changed||event.type!=='package.copy.progress')return;
                changed=true;
                descriptor.permissions.capabilities=['storage.read'];
                await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`);
            }
        }),
        /descriptor authority|changed after/u
    );
    assert.equal(changed,true);
    assert.equal(await readFile(releaseManifestPath,'utf8'),before);
});

test('toolchain package events serialize heartbeat and complete before settlement',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-toolchain-events-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'queued-app'});
    await installSdkRuntime(workspaceRoot);
    const delivered=[];
    let active=0;
    let maximumActive=0;
    let delayedProgress=false;

    const result=await packageApplication({
        workspaceRoot,
        appId:'queued-app',
        heartbeatMs:1000,
        onEvent:async event=>{
            active+=1;
            maximumActive=Math.max(maximumActive,active);
            try{
                if(event.type==='package.copy.progress'&&!delayedProgress){
                    delayedProgress=true;
                    await delay(1100);
                }
                delivered.push(event.type);
            }finally{
                active-=1;
            }
        }
    });

    assert.equal(result.release.app,'queued-app');
    assert.equal(delayedProgress,true);
    assert.equal(maximumActive,1);
    assert.equal(active,0);
    const packageEvents=delivered.filter(type=>type.startsWith('package.'));
    assert.ok(packageEvents.includes('package.heartbeat'));
    assert.equal(packageEvents.at(-1),'package.completed');
});

test('toolchain event rejection cancels package work and remains handled',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-toolchain-event-failure-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'rejected-events'});
    await installSdkRuntime(workspaceRoot);
    const callbackFailure=new Error('Toolchain event sink rejected package progress.');
    const unhandled=[];
    const observeUnhandled=reason=>unhandled.push(reason);
    process.on('unhandledRejection',observeUnhandled);
    t.after(()=>process.removeListener('unhandledRejection',observeUnhandled));
    const delivered=[];

    await assert.rejects(
        packageApplication({
            workspaceRoot,
            appId:'rejected-events',
            onEvent:async event=>{
                delivered.push(event.type);
                if(event.type==='package.copy.progress'){
                    await delay(10);
                    throw callbackFailure;
                }
            }
        }),
        error=>error===callbackFailure
    );
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
    assert.equal(delivered.includes('package.completed'),false);
    await assert.rejects(
        readFile(path.join(workspaceRoot,'dist','rejected-events','ARCANE_APP_RELEASE.json')),
        {code:'ENOENT'}
    );
});
