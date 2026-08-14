import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createWorkspace,initWorkspace} from '../src/scaffold.mjs';
import {temporaryDirectory} from './helpers.mjs';

test('workspace scaffold creates a private external app using the exact SDK version',async t=>{
    const parent=await temporaryDirectory(t);
    const targetPath=path.join(parent,'signal-lab');
    const events=[];
    const receipt=await createWorkspace({
        targetPath,
        appId:'signal-lab',
        displayName:'Signal Lab',
        onEvent:event=>events.push(event)
    });

    assert.equal(receipt.workspaceRoot,targetPath);
    assert.equal(events.at(0).type,'scaffold.started');
    assert.equal(events.at(-1).type,'scaffold.completed');

    const packageDocument=JSON.parse(await readFile(path.join(targetPath,'package.json'),'utf8'));
    assert.equal(packageDocument.private,true);
    assert.equal(packageDocument.type,'module');
    assert.equal(packageDocument.devDependencies['arcane-os'],'0.1.0-dev.0');

    const packager=JSON.parse(await readFile(path.join(targetPath,'arcane-packager.json'),'utf8'));
    assert.equal(packager.sharedPayloads['browser-runtime'].length,3);
    assert.deepEqual(packager.sharedPayloads['browser-runtime'][2],{
        source:'node_modules/arcane-os',
        destination:'licenses/arcane-os',
        include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],
        exclude:[]
    });

    const workflow=await readFile(path.join(targetPath,'.github','workflows','check.yml'),'utf8');
    assert.match(workflow,/run: npm ci --ignore-scripts/);
    assert.doesNotMatch(workflow,/run: npm install/);

    const lock=JSON.parse(await readFile(path.join(targetPath,'arcane.lock.json'),'utf8'));
    assert.equal(lock.sdk.name,'arcane-os');
    assert.equal(lock.sdk.version,'0.1.0-dev.0');
    assert.equal(lock.protocols.arcane,'arcane/1');
    assert.match(lock.runtime.contentSha256,/^[0-9a-f]{64}$/);

    const appRoot=path.join(targetPath,'apps','signal-lab');
    const html=await readFile(path.join(appRoot,'index.html'),'utf8');
    const theme=html.indexOf('./arcane/css/theme.css');
    const primitives=html.indexOf('./arcane/css/primitives.css');
    const appStyle=html.indexOf('./apps/signal-lab/signal-lab.css');
    const bootstrap=html.indexOf('./arcane/modules/ThemeBootstrap.js');
    const appModule=html.indexOf('./apps/signal-lab/modules/App.js');
    assert.match(html,/<base href="\.\.\/\.\.\/">/);
    assert.match(html,/<meta name="arcane-app-id" content="signal-lab">/);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(bootstrap>appStyle&&appModule>bootstrap);

    const css=await readFile(path.join(appRoot,'signal-lab.css'),'utf8');
    assert.doesNotMatch(css,/#(?:[0-9a-f]{3}|[0-9a-f]{6})(?![0-9a-f])/iu);
});

test('create refuses a nonempty target and init preserves existing authored files',async t=>{
    const parent=await temporaryDirectory(t);
    const nonempty=path.join(parent,'nonempty');
    await mkdir(nonempty);
    await writeFile(path.join(nonempty,'ownership.txt'),'user content\n');

    await assert.rejects(
        createWorkspace({targetPath:nonempty,appId:'no-overwrite'}),
        error=>error?.code==='ARCANE_WORKSPACE_INVALID'&&/Refusing to overwrite/.test(error.message)
    );
    assert.equal(await readFile(path.join(nonempty,'ownership.txt'),'utf8'),'user content\n');

    const initialized=path.join(parent,'initialized');
    await mkdir(initialized);
    await writeFile(path.join(initialized,'README.md'),'# Existing README\n');
    const receipt=await initWorkspace({workspaceRoot:initialized,appId:'preserved-app'});
    assert.equal(await readFile(path.join(initialized,'README.md'),'utf8'),'# Existing README\n');
    assert.ok(receipt.skippedFiles.includes('README.md'));
    assert.ok(receipt.createdFiles.includes('apps/preserved-app/index.html'));
});

test('init preflights package conflicts before creating any template files',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const packageSource=`${JSON.stringify({
        name:'existing-project',
        scripts:{check:'custom-check'}
    },null,2)}\n`;
    await writeFile(path.join(workspaceRoot,'package.json'),packageSource);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'conflict-app'}),
        error=>error?.code==='ARCANE_WORKSPACE_INVALID'&&/no values were overwritten/.test(error.message)
    );
    assert.equal(await readFile(path.join(workspaceRoot,'package.json'),'utf8'),packageSource);
    await assert.rejects(
        readFile(path.join(workspaceRoot,'arcane-packager.json'),'utf8'),
        error=>error?.code==='ENOENT'
    );
    await assert.rejects(
        readFile(path.join(workspaceRoot,'apps','conflict-app','index.html'),'utf8'),
        error=>error?.code==='ENOENT'
    );
});

test('init preserves a supported local SDK tarball declaration',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await writeFile(path.join(workspaceRoot,'package.json'),`${JSON.stringify({
        name:'local-sdk-app',
        private:true,
        type:'module',
        devDependencies:{'arcane-os':'file:../sdk-artifacts/arcane-os-0.1.0-dev.0.tgz'}
    },null,2)}\n`);

    await initWorkspace({workspaceRoot,appId:'local-sdk-app'});
    const result=JSON.parse(await readFile(path.join(workspaceRoot,'package.json'),'utf8'));
    assert.equal(result.devDependencies['arcane-os'],'file:../sdk-artifacts/arcane-os-0.1.0-dev.0.tgz');
});
