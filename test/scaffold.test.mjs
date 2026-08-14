import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {createWorkspace,initWorkspace} from '../src/scaffold.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {runNode,temporaryDirectory} from './helpers.mjs';

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
    assert.equal(receipt.target,'browser');
    assert.equal(events.at(0).type,'scaffold.started');
    assert.equal(events.at(-1).type,'scaffold.completed');

    const packageDocument=JSON.parse(await readFile(path.join(targetPath,'package.json'),'utf8'));
    assert.equal(packageDocument.private,true);
    assert.equal(packageDocument.type,'module');
    assert.equal(packageDocument.devDependencies['arcane-os'],'0.1.0-dev.1');

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
    assert.match(await readFile(path.join(targetPath,'.gitignore'),'utf8'),/^build\/$/mu);

    const lock=JSON.parse(await readFile(path.join(targetPath,'arcane.lock.json'),'utf8'));
    assert.equal(lock.sdk.name,'arcane-os');
    assert.equal(lock.sdk.version,'0.1.0-dev.1');
    assert.equal(lock.protocols.arcane,'arcane/1');
    assert.match(lock.runtime.contentSha256,/^[0-9a-f]{64}$/);

    const appRoot=path.join(targetPath,'apps','signal-lab');
    const descriptor=JSON.parse(await readFile(path.join(appRoot,'arcane-app.json'),'utf8'));
    const packageManifest=JSON.parse(await readFile(path.join(appRoot,'arcane-package.json'),'utf8'));
    assert.equal(descriptor.schemaVersion,2);
    assert.equal(descriptor.id,'signal-lab');
    assert.deepEqual(projectPackageManifest(descriptor),packageManifest);
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

    const generatedTest=path.join(appRoot,'test','app.test.mjs');
    const generatedTestResult=await runNode(['--test',generatedTest],{cwd:targetPath});
    assert.equal(
        generatedTestResult.code,
        0,
        `Generated application test failed to parse or run:\n${generatedTestResult.stderr}`
    );

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

test('every native scaffold includes a real raster icon and declares browser plus its selected target',async t=>{
    const parent=await temporaryDirectory(t);
    for(const target of ['portable','windows-x64','linux-x64','linux-arm64','android-arm64']){
        const appId=`scaffold-${target}`;
        const targetPath=path.join(parent,appId);
        const receipt=await createWorkspace({targetPath,appId,target});
        const appRoot=path.join(targetPath,'apps',appId);
        const descriptor=JSON.parse(await readFile(path.join(appRoot,'arcane-app.json'),'utf8'));
        const packageManifest=JSON.parse(await readFile(path.join(appRoot,'arcane-package.json'),'utf8'));
        const icon=await readFile(path.join(appRoot,'img','icon.png'));
        const readme=await readFile(path.join(targetPath,'README.md'),'utf8');
        const packageDocument=JSON.parse(await readFile(path.join(targetPath,'package.json'),'utf8'));

        assert.equal(receipt.target,target);
        assert.deepEqual(descriptor.targets,['browser',target].sort());
        assert.equal(descriptor.native.icon,'img/icon.png');
        assert.ok(descriptor.package.include.includes('img/icon.png'));
        assert.deepEqual(projectPackageManifest(descriptor),packageManifest);
        assert.deepEqual([...icon.subarray(0,8)],[137,80,78,71,13,10,26,10]);
        assert.equal(packageDocument.scripts.build,`arcane build --target ${target}`);
        assert.equal(
            packageDocument.scripts.run,
            `arcane run --target ${target==='portable'?'browser':target}`
        );
        assert.equal(packageDocument.scripts['build:browser'],'arcane build --target browser');
        assert.equal(packageDocument.scripts['run:browser'],'arcane run --target browser');
        if(['linux-arm64','android-arm64'].includes(target)){
            assert.match(readme,new RegExp(`reports ${target} as deferred`,'u'));
            assert.doesNotMatch(readme,new RegExp(`arcane build --target ${target}`,'u'));
        }else{
            assert.match(readme,/npm run build -- --arcane-root/u);
        }
    }
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

test('init adds only app-owned files to an integrated Arcane workspace',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const rootPackage={
        name:'arcane-os',
        version:'0.1.0',
        private:true,
        type:'module',
        scripts:{check:'node existing-check.mjs'}
    };
    const packageSource=`${JSON.stringify(rootPackage,null,2)}\n`;
    await writeFile(path.join(workspaceRoot,'package.json'),packageSource);
    await writeFile(path.join(workspaceRoot,'arcane-packager.json'),`${JSON.stringify({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'arcane',
                    destination:'arcane',
                    include:['components','css','entities','img','modules'],
                    exclude:[]
                },
                {
                    source:'node_modules/strong-type',
                    destination:'node_modules/strong-type',
                    include:['index.js','licence','package.json'],
                    exclude:[]
                }
            ]
        }
    },null,2)}\n`);
    const machineRoot=path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle');
    await mkdir(machineRoot,{recursive:true});
    await writeFile(path.join(machineRoot,'package.json'),`${JSON.stringify({
        name:'arcane-os-machine-bundle',
        version:'0.8.11'
    },null,2)}\n`);

    const receipt=await initWorkspace({
        workspaceRoot,
        appId:'integrated-app',
        displayName:'Integrated App'
    });

    assert.equal(receipt.workspaceMode,'integrated');
    assert.equal(receipt.packageUpdated,false);
    assert.equal(await readFile(path.join(workspaceRoot,'package.json'),'utf8'),packageSource);
    assert.ok(receipt.createdFiles.every(relative=>relative.startsWith('apps/integrated-app/')));
    const descriptor=JSON.parse(await readFile(
        path.join(workspaceRoot,'apps','integrated-app','arcane-app.json'),
        'utf8'
    ));
    assert.equal(descriptor.requirements.minimumCoreVersion,'0.8.11');
    await assert.rejects(
        readFile(path.join(workspaceRoot,'arcane.lock.json'),'utf8'),
        error=>error?.code==='ENOENT'
    );
    await assert.rejects(
        readFile(path.join(workspaceRoot,'.github','workflows','check.yml'),'utf8'),
        error=>error?.code==='ENOENT'
    );
});
