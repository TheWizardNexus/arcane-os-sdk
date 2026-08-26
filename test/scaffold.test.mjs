import assert from 'node:assert/strict';
import {cp,lstat,mkdir,readFile,rename,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createWorkspace,initWorkspace} from '../src/scaffold.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {SDK_VERSION} from '../src/constants.mjs';
import {
    resolveWorkspace,
    validateDiscoveredApplication,
    validateWorkspace
} from '../src/workspace.mjs';
import {verifyRuntime} from '../src/runtime.mjs';
import {
    SDK_BROWSER_RUNTIME_CONTENT_SHA256,
    SDK_BROWSER_RUNTIME_MANIFEST_SHA256,
    verifySdkBrowserRuntime
} from '../src/sdk-browser-runtime.mjs';
import {workspaceTemplate} from '../src/templates/workspace-template.mjs';
import {repositoryRoot,runNode,temporaryDirectory} from './helpers.mjs';

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
    assert.equal(packageDocument.engines.node,'>=22.23.2');
    assert.equal(packageDocument.devDependencies['arcane-os'],SDK_VERSION);

    const packager=JSON.parse(await readFile(path.join(targetPath,'arcane-packager.json'),'utf8'));
    assert.equal(packager.sharedPayloads['browser-runtime'].length,2);
    assert.equal(packager.sharedPayloads['browser-runtime'][0].source,'arcane');
    assert.equal(packager.sharedPayloads['browser-runtime'][0].destination,'arcane');
    assert.deepEqual(packager.sharedPayloads['browser-runtime'][0].include,[
        'components','css','dependencies','entities','img','modules','sdk','security'
    ]);
    assert.deepEqual(packager.sharedPayloads['browser-runtime'][1],{
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
    assert.equal(lock.sdk.version,SDK_VERSION);
    assert.equal(lock.protocols.arcane,'arcane/1');
    assert.match(lock.runtime.contentSha256,/^[0-9a-f]{64}$/);
    const browserRelease=JSON.parse(await readFile(
        path.join(repositoryRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json'),
        'utf8'
    ));
    assert.deepEqual(lock.sdkBrowserRuntime,{
        manifest:'node_modules/arcane-os/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json',
        manifestSha256:SDK_BROWSER_RUNTIME_MANIFEST_SHA256,
        contentSha256:SDK_BROWSER_RUNTIME_CONTENT_SHA256,
        builder:browserRelease.builder,
        sdkVersion:browserRelease.sdkVersion,
        source:browserRelease.source
    });

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
    const appModule=html.indexOf('./apps/signal-lab/modules/App.js');
    const managedImportMap=html.indexOf('data-arcane-import-map');
    assert.match(html,/<base href="\.\.\/\.\.\/">/);
    assert.match(html,/<meta name="arcane-app-id" content="signal-lab">/);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(managedImportMap>0&&managedImportMap<appModule);
    assert.ok(appModule>appStyle);
    assert.doesNotMatch(html,/ThemeBootstrap[.]js[?]/u);
    const appSource=await readFile(path.join(appRoot,'modules','App.js'),'utf8');
    assert.match(appSource,/from 'arcane\/ThemeBootstrap'/u);
    assert.match(appSource,/from 'arcane\/AppDataScope'/u);
    const importMap=JSON.parse(await readFile(
        path.join(appRoot,'modules','arcane.importmap.json'),
        'utf8'
    ));
    assert.deepEqual(Object.keys(importMap),['imports']);
    assert.equal(
        importMap.imports['./node_modules/strong-type/index.js'],
        './arcane/dependencies/strong-type/index.js'
    );
    assert.equal(
        await readFile(path.join(targetPath,'arcane','dependencies','strong-type','index.js'),'utf8'),
        await readFile(path.join(repositoryRoot,'runtime','strong-type','index.js'),'utf8')
    );

    const generatedTest=path.join(appRoot,'test','app.test.mjs');
    const generatedTestResult=await runNode([
        path.join(repositoryRoot,'bin','arcane-test.mjs'),
        generatedTest
    ],{cwd:targetPath});
    assert.equal(
        generatedTestResult.code,
        0,
        `Generated application test failed to parse or run:\n${generatedTestResult.stderr}`
    );

    const css=await readFile(path.join(appRoot,'signal-lab.css'),'utf8');
    assert.doesNotMatch(css,/#(?:[0-9a-f]{3}|[0-9a-f]{6})(?![0-9a-f])/iu);
});

test('workspace validation ignores required-element decoys inside classic-script raw text',async t=>{
    const parent=await temporaryDirectory(t);
    const physicalParent=path.join(parent,'physical');
    const workspaceRoot=path.join(physicalParent,'html-decoy-workspace');
    await mkdir(physicalParent);
    await createWorkspace({
        targetPath:workspaceRoot,
        appId:'html-decoy',
        displayName:'HTML Decoy'
    });
    const entryPath=path.join(workspaceRoot,'apps','html-decoy','index.html');
    const valid=await readFile(entryPath,'utf8');
    const selected=await resolveWorkspace({workspaceRoot,appId:'html-decoy'});
    const aliasParent=path.join(parent,'alias');
    await symlink(physicalParent,aliasParent,process.platform==='win32'?'junction':'dir');
    const aliasRoot=path.join(aliasParent,'html-decoy-workspace');
    const validate=()=>validateDiscoveredApplication({
        workspaceRoot:aliasRoot,
        workspaceMode:selected.config.workspaceMode,
        workspaceConfig:selected.config,
        app:selected.app
    });
    const cases=[
        {
            pattern:/[\t ]*<meta name="arcane-app-id" content="html-decoy">\r?\n/u,
            decoy:'<meta name="arcane-app-id" content="html-decoy">',
            message:/exactly one active matching arcane-app-id/u
        },
        {
            pattern:/[\t ]*<link rel="stylesheet" href="[.]\/arcane\/css\/theme[.]css[^"]*">\r?\n/u,
            decoy:'<link rel="stylesheet" href="./arcane/css/theme.css">',
            message:/must load the shared Arcane theme[.]css/u
        },
        {
            pattern:/[\t ]*<link rel="stylesheet" href="[.]\/apps\/html-decoy\/html-decoy[.]css[^"]*">\r?\n/u,
            decoy:'<link rel="stylesheet" href="./apps/html-decoy/html-decoy.css">',
            message:/theme[.]css, primitives[.]css, and app CSS in that order/u
        },
        {
            pattern:/[\t ]*<script type="module" src="[.]\/apps\/html-decoy\/modules\/App[.]js[^"]*"><\/script>\r?\n/u,
            decoy:'<script type="module" src="./apps/html-decoy/modules/App.js"></script>',
            message:/must load an active app-local module script/u
        }
    ];
    for(const fixture of cases){
        const withoutActive=valid.replace(fixture.pattern,'');
        assert.notEqual(withoutActive,valid);
        const poisoned=withoutActive.replace(
            '</body>',
            `    <script>const requiredElementDecoy=${JSON.stringify(fixture.decoy)};<\/script>\n</body>`
        );
        await writeFile(entryPath,poisoned,'utf8');
        await assert.rejects(
            validate(),
            fixture.message
        );
    }
    await writeFile(entryPath,valid,'utf8');
    assert.equal((await validate()).valid,true);

    const foreignRoot=path.join(parent,'foreign-workspace');
    await mkdir(path.join(foreignRoot,'apps','html-decoy'),{recursive:true});
    await assert.rejects(
        validateDiscoveredApplication({
            workspaceRoot:foreignRoot,
            workspaceMode:'external',
            workspaceConfig:selected.config,
            app:selected.app
        }),
        /does not belong to the selected workspace/u
    );

    const linkedAppRoot=path.join(parent,'linked-app-root');
    await symlink(
        selected.app.appRoot,
        linkedAppRoot,
        process.platform==='win32'?'junction':'dir'
    );
    await assert.rejects(
        validateDiscoveredApplication({
            workspaceRoot:selected.workspaceRoot,
            workspaceMode:'external',
            workspaceConfig:selected.config,
            app:{...selected.app,appRoot:linkedAppRoot}
        }),
        /must be a real directory/u
    );

    const appsRoot=path.join(workspaceRoot,'apps');
    const retiredAppsRoot=path.join(workspaceRoot,'retired-apps');
    let retargeted=false;
    await assert.rejects(
        validateDiscoveredApplication({
            workspaceRoot:aliasRoot,
            workspaceMode:selected.config.workspaceMode,
            workspaceConfig:selected.config,
            app:selected.app,
            onEvent:async event=>{
                if(retargeted||event.type!=='workspace.application.validated')return;
                await rename(appsRoot,retiredAppsRoot);
                await symlink(
                    retiredAppsRoot,
                    appsRoot,
                    process.platform==='win32'?'junction':'dir'
                );
                retargeted=true;
            }
        }),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );
    assert.equal(retargeted,true);
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

test('init rejects an unadmitted browser-runtime lock before materializing arcane bytes',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const runtimeRelease=await verifyRuntime();
    const sdkBrowserRuntimeRelease=await verifySdkBrowserRuntime();
    const generated=workspaceTemplate({
        appId:'forged-lock',
        runtimeRelease,
        sdkBrowserRuntimeRelease
    });
    const forged=JSON.parse(generated.files.get('arcane.lock.json'));
    forged.sdkBrowserRuntime.source.authority='forged-consumer';
    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    const original=`${JSON.stringify(forged,null,2)}\n`;
    await writeFile(lockPath,original);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'forged-lock'}),
        error=>error?.code==='ARCANE_WORKSPACE_INVALID'
            &&/does not match the authenticated SDK runtime admission/u.test(error.message)
    );
    assert.equal(await readFile(lockPath,'utf8'),original);
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane')),
        error=>error?.code==='ENOENT'
    );
});

test('workspace lock admission is exact-key closed and dependency-order deterministic',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-lock-admission-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'lock-contract'});
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    await mkdir(path.join(installedRoot,'runtime'),{recursive:true});
    await mkdir(path.join(installedRoot,'browser-runtime'),{recursive:true});
    for(const relative of [
        'package.json',
        'runtime/ARCANE_RUNTIME_RELEASE.json',
        'browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json'
    ]){
        await cp(path.join(repositoryRoot,relative),path.join(installedRoot,relative));
    }
    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    const admitted=JSON.parse(await readFile(lockPath,'utf8'));

    const reordered=structuredClone(admitted);
    const first=reordered.sdkBrowserRuntime.source.dependencies[0];
    reordered.sdkBrowserRuntime.source.dependencies[0]={
        integrity:first.integrity,
        resolved:first.resolved,
        version:first.version,
        name:first.name
    };
    const source=reordered.sdkBrowserRuntime.source;
    reordered.sdkBrowserRuntime.source={
        dependencies:source.dependencies,
        browserEntry:source.browserEntry,
        protocol:source.protocol,
        repository:source.repository,
        authority:source.authority
    };
    await writeFile(lockPath,`${JSON.stringify(reordered,null,2)}\n`);
    assert.equal(
        (await validateWorkspace({workspaceRoot,appId:'lock-contract'})).valid,
        true
    );

    const mutations=[
        ['root extra',lock=>{lock.extra=true;}],
        ['sdk extra',lock=>{lock.sdk.extra=true;}],
        ['runtime extra',lock=>{lock.runtime.extra=true;}],
        ['browser extra',lock=>{lock.sdkBrowserRuntime.extra=true;}],
        ['source extra',lock=>{lock.sdkBrowserRuntime.source.extra=true;}],
        ['protocol extra',lock=>{lock.protocols.extra='x';}],
        ['dependency extra',lock=>{lock.sdkBrowserRuntime.source.dependencies[0].extra=true;}],
        ['dependency order',lock=>{lock.sdkBrowserRuntime.source.dependencies.reverse();}],
        ['registry identity',lock=>{
            lock.sdkBrowserRuntime.source.dependencies[0].resolved=
                'https://registry.npmjs.org/event-pubsub/-/event-pubsub-6.1.1.tgz';
        }],
        ['manifest path',lock=>{lock.sdkBrowserRuntime.manifest='browser-runtime/forged.json';}],
        ['manifest hash',lock=>{lock.sdkBrowserRuntime.manifestSha256='0'.repeat(64);}],
        ['content hash',lock=>{lock.sdkBrowserRuntime.contentSha256='0'.repeat(64);}],
        ['source authority',lock=>{lock.sdkBrowserRuntime.source.authority='consumer';}]
    ];
    for(const [label,mutate] of mutations){
        const candidate=structuredClone(admitted);
        mutate(candidate);
        await writeFile(lockPath,`${JSON.stringify(candidate,null,2)}\n`);
        await assert.rejects(
            validateWorkspace({workspaceRoot,appId:'lock-contract'}),
            error=>error?.code==='ARCANE_WORKSPACE_INVALID'
                &&/lock|browser runtime|incompatible/u.test(error.message),
            label
        );
    }
});

test('workspace template rejects forged SDK browser receipt identities and digests',async()=>{
    const runtimeRelease=await verifyRuntime();
    const browserRelease=await verifySdkBrowserRuntime();
    const mutations=[
        receipt=>{receipt.manifestSha256='0'.repeat(64);},
        receipt=>{receipt.contentSha256='0'.repeat(64);},
        receipt=>{receipt.source.repository='https://example.invalid/consumer.git';},
        receipt=>{receipt.source.browserEntry='arcane-os';},
        receipt=>{receipt.source.dependencies.reverse();},
        receipt=>{receipt.source.dependencies[0].integrity='sha512-forged';}
    ];
    for(const mutate of mutations){
        const forged=structuredClone(browserRelease);
        mutate(forged);
        assert.throws(
            ()=>workspaceTemplate({
                appId:'forged-browser-receipt',
                runtimeRelease,
                sdkBrowserRuntimeRelease:forged
            }),
            /does not contain a valid trusted identity/u
        );
    }
});

// Five full authenticated scaffolds are serialized here. Each target retains the
// default watchdog while the aggregate admits their measured Windows runtime.
test('every native scaffold includes a real raster icon and declares browser plus its selected target',{timeout:60_000},async t=>{
    const parent=await temporaryDirectory(t);
    for(const target of ['portable','windows-x64','linux-x64','linux-arm64','android-arm64']){
        await t.test(target,async()=>{
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
            assert.match(readme,/npm run build -- --arcane-root/u);
        });
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

test('init preserves one exact npm alias and derives its package routes and lock paths',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-sdk-alias-init-'});
    await writeFile(path.join(workspaceRoot,'package.json'),`${JSON.stringify({
        name:'alias-sdk-app',
        private:true,
        type:'module',
        devDependencies:{'arcane-sdk':`npm:arcane-os@${SDK_VERSION}`}
    },null,2)}\n`);

    await initWorkspace({workspaceRoot,appId:'alias-sdk-app'});

    const packageDocument=JSON.parse(await readFile(path.join(workspaceRoot,'package.json'),'utf8'));
    assert.equal(packageDocument.devDependencies['arcane-sdk'],`npm:arcane-os@${SDK_VERSION}`);
    assert.equal(Object.hasOwn(packageDocument.devDependencies,'arcane-os'),false);
    const packager=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-packager.json'),'utf8'));
    assert.equal(
        packager.sharedPayloads['browser-runtime'][1].source,
        'node_modules/arcane-sdk'
    );
    const lock=JSON.parse(await readFile(path.join(workspaceRoot,'arcane.lock.json'),'utf8'));
    assert.equal(
        lock.runtime.manifest,
        'node_modules/arcane-sdk/runtime/ARCANE_RUNTIME_RELEASE.json'
    );
    assert.equal(
        lock.sdkBrowserRuntime.manifest,
        'node_modules/arcane-sdk/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json'
    );
});

test('init rejects multiple qualifying SDK installation declarations without creating template files',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-sdk-duplicate-init-'});
    await writeFile(path.join(workspaceRoot,'package.json'),`${JSON.stringify({
        name:'duplicate-sdk-app',
        private:true,
        type:'module',
        devDependencies:{
            'arcane-os':SDK_VERSION,
            'arcane-sdk':`npm:arcane-os@${SDK_VERSION}`
        }
    },null,2)}\n`);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'duplicate-sdk-app'}),
        /exactly one Arcane SDK installation/u
    );
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane-packager.json')),
        error=>error?.code==='ENOENT'
    );
});

test('init rejects an npm alias that does not target the exact SDK version',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-sdk-inexact-alias-init-'});
    await writeFile(path.join(workspaceRoot,'package.json'),`${JSON.stringify({
        name:'inexact-sdk-app',
        private:true,
        type:'module',
        devDependencies:{'arcane-sdk':`npm:arcane-os@^${SDK_VERSION}`}
    },null,2)}\n`);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'inexact-sdk-app'}),
        /exact npm alias/u
    );
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane-packager.json')),
        error=>error?.code==='ENOENT'
    );
});

test('init rejects a versionless npm alias even beside an exact canonical SDK declaration',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-sdk-versionless-alias-init-'});
    await writeFile(path.join(workspaceRoot,'package.json'),`${JSON.stringify({
        name:'versionless-alias-sdk-app',
        private:true,
        type:'module',
        devDependencies:{
            'arcane-os':SDK_VERSION,
            'arcane-sdk':'npm:arcane-os'
        }
    },null,2)}\n`);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'versionless-alias-sdk-app'}),
        /exact npm alias/u
    );
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane-packager.json')),
        error=>error?.code==='ENOENT'
    );
});

test('init rejects an npm alias declared under the canonical SDK dependency key',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-sdk-canonical-alias-init-'});
    await writeFile(path.join(workspaceRoot,'package.json'),`${JSON.stringify({
        name:'canonical-alias-sdk-app',
        private:true,
        type:'module',
        devDependencies:{'arcane-os':`npm:arcane-os@${SDK_VERSION}`}
    },null,2)}\n`);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'canonical-alias-sdk-app'}),
        /distinct dependency key/u
    );
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane-packager.json')),
        error=>error?.code==='ENOENT'
    );
});

test('init binds an existing external package route before defaulting a missing SDK declaration',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-sdk-bound-alias-init-'});
    const [runtimeRelease,sdkBrowserRuntimeRelease]=await Promise.all([
        verifyRuntime(),
        verifySdkBrowserRuntime()
    ]);
    const generated=workspaceTemplate({
        appId:'bound-alias-sdk-app',
        runtimeRelease,
        sdkBrowserRuntimeRelease,
        sdkDependencyName:'arcane-sdk',
        sdkDependencySpecifier:`npm:arcane-os@${SDK_VERSION}`,
        sdkPackageSource:'node_modules/arcane-sdk'
    });
    await writeFile(
        path.join(workspaceRoot,'arcane-packager.json'),
        generated.files.get('arcane-packager.json')
    );
    const packageSource=`${JSON.stringify({
        name:'bound-alias-sdk-app',
        private:true,
        type:'module',
        devDependencies:{}
    },null,2)}\n`;
    const packagePath=path.join(workspaceRoot,'package.json');
    await writeFile(packagePath,packageSource);

    await assert.rejects(
        initWorkspace({workspaceRoot,appId:'bound-alias-sdk-app'}),
        /must declare exactly one arcane-os installation/u
    );
    assert.equal(await readFile(packagePath,'utf8'),packageSource);
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane.lock.json')),
        error=>error?.code==='ENOENT'
    );
});

test('workspace template rejects an npm alias under the canonical SDK dependency key',async()=>{
    const [runtimeRelease,sdkBrowserRuntimeRelease]=await Promise.all([
        verifyRuntime(),
        verifySdkBrowserRuntime()
    ]);
    assert.throws(
        ()=>workspaceTemplate({
            appId:'canonical-alias-template-app',
            runtimeRelease,
            sdkBrowserRuntimeRelease,
            sdkDependencyName:'arcane-os',
            sdkDependencySpecifier:`npm:arcane-os@${SDK_VERSION}`,
            sdkPackageSource:'node_modules/arcane-os'
        }),
        /Invalid scaffold SDK installation authority/u
    );
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
                    include:['components','css','dependencies','entities','img','modules','sdk','security'],
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
    await cp(path.join(repositoryRoot,'runtime','arcane'),path.join(workspaceRoot,'arcane'),{
        recursive:true
    });
    await cp(
        path.join(repositoryRoot,'runtime','strong-type'),
        path.join(workspaceRoot,'arcane','dependencies','strong-type'),
        {recursive:true}
    );
    await mkdir(path.join(workspaceRoot,'arcane','sdk'),{recursive:true});
    for(const relative of [
        'ai',
        'dependencies/event-pubsub',
        'dependencies/strong-type',
        'dom-event-instrumentation.mjs',
        'event-manager.mjs'
    ]){
        await cp(
            path.join(repositoryRoot,'browser-runtime',relative),
            path.join(workspaceRoot,'arcane','sdk',relative),
            {recursive:true}
        );
    }

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
