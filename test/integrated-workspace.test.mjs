import assert from 'node:assert/strict';
import {cp,lstat,mkdir,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {SDK_NAME,SDK_VERSION} from '../src/constants.mjs';
import {
    buildApplication,
    checkApplication,
    createApplication,
    developApplication,
    executeOperation,
    initializeApplication,
    materializeInstalledSdkRuntime,
    packageApplication,
    projectPackageManifest,
    runApplication,
    testApplication,
    upgradeApplication,
    validateWorkspace,
    verifyApplication
} from '../src/index.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

function developmentOrigin(instance){
    const launch=new URL(instance.url);
    assert.equal(launch.origin,instance.origin);
    assert.equal(instance.cleanUrl,`${instance.origin}${launch.pathname}`);
    assert.equal(launch.search,'');
    return instance.origin;
}

async function installSdkAliasRuntime(workspaceRoot,dependencyName='arcane-sdk'){
    const installedRoot=path.join(workspaceRoot,'node_modules',dependencyName);
    await mkdir(path.join(installedRoot,'src'),{recursive:true});
    await Promise.all([
        cp(path.join(repositoryRoot,'runtime'),path.join(installedRoot,'runtime'),{recursive:true}),
        cp(
            path.join(repositoryRoot,'browser-runtime'),
            path.join(installedRoot,'browser-runtime'),
            {recursive:true}
        ),
        cp(
            path.join(repositoryRoot,'node_modules','event-pubsub'),
            path.join(installedRoot,'node_modules','event-pubsub'),
            {recursive:true}
        ),
        cp(
            path.join(repositoryRoot,'node_modules','strong-type'),
            path.join(installedRoot,'node_modules','strong-type'),
            {recursive:true}
        ),
        cp(
            path.join(repositoryRoot,'src','event-manager.mjs'),
            path.join(installedRoot,'src','event-manager.mjs')
        ),
        cp(
            path.join(repositoryRoot,'src','dom-event-instrumentation.mjs'),
            path.join(installedRoot,'src','dom-event-instrumentation.mjs')
        ),
        cp(path.join(repositoryRoot,'package.json'),path.join(installedRoot,'package.json'))
    ]);
    return installedRoot;
}

async function request(instance,requestPath){
    return fetch(`${instance.origin}${requestPath}`,{
        redirect:'manual'
    });
}

async function configureIntegratedWorkspace(workspaceRoot){
    await writeJson(path.join(workspaceRoot,'package.json'),{
        name:'arcane-os',
        private:true,
        type:'module'
    });
    await writeJson(
        path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle','package.json'),
        {
            name:'arcane-os-machine-bundle',
            version:'0.8.12'
        }
    );
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'arcane',
                    destination:'arcane',
                    include:['components','css','dependencies','entities','img','modules','sdk'],
                    exclude:[]
                }
            ]
        }
    });
    await rm(path.join(workspaceRoot,'arcane.lock.json'),{force:true});

    const arcaneRoot=path.join(workspaceRoot,'arcane');
    for(const directory of ['components','css','entities','img','modules','security']){
        await mkdir(path.join(arcaneRoot,directory),{recursive:true});
    }
    await writeFile(
        path.join(arcaneRoot,'components','IntegratedFixture.js'),
        'export const integratedComponent=true;\n'
    );
    await writeFile(
        path.join(arcaneRoot,'css','theme.css'),
        ':root { --background: rgb(13, 18, 32); --text-color: rgb(235, 241, 255); }\n'
    );
    await writeFile(
        path.join(arcaneRoot,'css','primitives.css'),
        '.arcane-card { color: var(--text-color); }\n'
    );
    await writeFile(
        path.join(arcaneRoot,'entities','IntegratedFixture.js'),
        'export const integratedEntity=true;\n'
    );
    await writeFile(path.join(arcaneRoot,'img','integrated-fixture.txt'),'fixture\n');
    await writeFile(
        path.join(arcaneRoot,'modules','ThemeBootstrap.js'),
        'document.documentElement.dataset.arcaneTheme="integrated"; export const integratedTheme=true;\n'
    );

    const runtimeStrongType=JSON.parse(await readFile(
        path.join(arcaneRoot,'dependencies','strong-type','package.json'),
        'utf8'
    ));
    assert.equal(runtimeStrongType.name,'strong-type');
    assert.equal(runtimeStrongType.version,'1.1.0');
}

async function configureLegacyIntegratedWorkspace(workspaceRoot){
    await mkdir(workspaceRoot,{recursive:true});
    await writeJson(path.join(workspaceRoot,'package.json'),{
        name:'arcane-os',
        private:true,
        type:'module'
    });
    await writeJson(
        path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle','package.json'),
        {name:'arcane-os-machine-bundle',version:'0.8.12'}
    );
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'arcane',
                    destination:'arcane',
                    include:['components','css','entities','img','modules','security'],
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
    });
    await cp(path.join(repositoryRoot,'runtime','arcane'),path.join(workspaceRoot,'arcane'),{
        recursive:true
    });
    await cp(
        path.join(repositoryRoot,'runtime','strong-type'),
        path.join(workspaceRoot,'node_modules','strong-type'),
        {recursive:true}
    );
}

test('installed SDK materialization copies the complete alias runtime without byte identity metadata',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-installed-runtime-'});
    await writeJson(path.join(workspaceRoot,'package.json'),{
        name:'installed-runtime-fixture',
        private:true,
        type:'module',
        devDependencies:{'arcane-sdk':`npm:${SDK_NAME}@${SDK_VERSION}`}
    });
    const installedRoot=await installSdkAliasRuntime(workspaceRoot);
    const legacyRuntimeLock=path.join(workspaceRoot,'arcane.lock.json');
    await writeJson(legacyRuntimeLock,{
        schemaVersion:1,
        sdk:{name:SDK_NAME,version:'0.2.1'}
    });

    const created=await materializeInstalledSdkRuntime({workspaceRoot});
    assert.equal(created.status,'materialized');
    assert.equal(created.installation.dependencyName,'arcane-sdk');
    assert.equal(created.installation.packageSource,'node_modules/arcane-sdk');
    assert.equal(created.installation.canonicalPackageRoot,installedRoot);
    assert.equal(created.workspaceRuntime.kind,'arcane-workspace-runtime-content');
    assert.equal(created.workspaceRuntime.runtimeRoot,path.join(workspaceRoot,'arcane'));
    assert.equal(Object.hasOwn(created,'generation'),false);
    assert.equal(Object.hasOwn(created,'persistentReceipt'),false);
    assert.equal(Object.hasOwn(created,'receiptPath'),false);
    assert.equal(Object.hasOwn(created,'lockReconciliation'),false);
    const refreshedLock=JSON.parse(await readFile(legacyRuntimeLock,'utf8'));
    assert.deepEqual(refreshedLock,{
        schemaVersion:1,
        sdk:{name:SDK_NAME,version:SDK_VERSION},
        runtime:{root:'node_modules/arcane-sdk/runtime'},
        sdkBrowserRuntime:{root:'node_modules/arcane-sdk/browser-runtime'},
        protocols:{
            arcane:'arcane/1',
            cliEvents:'arcane-cli-events/1',
            targetAdapter:'arcane-target-adapter/1'
        }
    });
    assert.equal(created.workspaceLock.path,legacyRuntimeLock);
    assert.deepEqual(created.workspaceLock.document,refreshedLock);

    const stalePath=path.join(workspaceRoot,'arcane','stale-runtime-file.txt');
    await writeFile(stalePath,'stale\n');
    const refreshed=await materializeInstalledSdkRuntime({workspaceRoot});
    assert.equal(refreshed.status,'materialized');
    await assert.rejects(lstat(stalePath),{code:'ENOENT'});
});

test('application upgrade runs the application npm upgrade without runtime reconciliation',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-upgrade-'});
    const appId='upgrade-app';
    await createApplication({
        targetPath:workspaceRoot,
        appId,
        displayName:'Upgrade App'
    });
    await installSdkAliasRuntime(workspaceRoot,SDK_NAME);
    const staleRuntimePath=path.join(workspaceRoot,'arcane','stale-runtime-file.txt');
    await writeFile(staleRuntimePath,'stale\n');
    const reviewPath=path.join(workspaceRoot,'apps',appId,'modules','review.html');
    await writeFile(reviewPath,'<main>ordinary application content</main>\n');

    const upgraded=await upgradeApplication({workspaceRoot,appId});
    assert.equal(upgraded.kind,'arcane-application-upgrade');
    assert.equal(upgraded.command,'npm');
    assert.deepEqual(upgraded.args,['upgrade']);
    assert.equal(upgraded.cwd,workspaceRoot);
    assert.equal(upgraded.code,0);
    assert.equal(typeof upgraded.stdout,'string');
    assert.equal(typeof upgraded.stderr,'string');
    assert.equal(Object.hasOwn(upgraded,'runtime'),false);
    assert.equal(Object.hasOwn(upgraded,'importMap'),false);
    assert.equal(Object.hasOwn(upgraded,'lockReconciliation'),false);
    assert.equal(await readFile(staleRuntimePath,'utf8'),'stale\n');
    assert.equal(await readFile(reviewPath,'utf8'),'<main>ordinary application content</main>\n');
});

test('unchanged two-route integrated Arcane workspace keeps legacy dev and package behavior',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-integrated-legacy-'});
    const appId='legacy-app';
    await configureLegacyIntegratedWorkspace(workspaceRoot);
    const initialized=await initializeApplication({
        workspaceRoot,
        appId,
        displayName:'Legacy App'
    });
    assert.equal(initialized.workspaceMode,'integrated');
    assert.equal(initialized.importMap.skipped,true);
    assert.equal(initialized.importMap.compatibility,'integrated-legacy');
    const appRoot=path.join(workspaceRoot,'apps',appId);
    assert.match(
        await readFile(path.join(appRoot,'modules','App.js'),'utf8'),
        /from '[.][.][\/][.][.][\/][.][.][\/]arcane\/modules\/ThemeBootstrap[.]js'/u
    );
    await assert.rejects(
        lstat(path.join(appRoot,'modules','arcane.importmap.json')),
        error=>error?.code==='ENOENT'
    );
    const validation=await validateWorkspace({workspaceRoot,appId});
    assert.equal(validation.config.browserRuntimeLayout,'integrated-legacy');

    const development=await developApplication({workspaceRoot,appId,host:'127.0.0.1',port:0});
    t.after(()=>development.close());
    developmentOrigin(development);
    assert.equal(
        (await request(development,'/node_modules/strong-type/index.js')).status,
        200
    );
    await development.close();
    await development.lifecycle;

    const packaged=await packageApplication({workspaceRoot,appId});
    assert.equal(packaged.release.appId,appId);
    assert.equal(
        await readFile(path.join(workspaceRoot,'dist',appId,'node_modules','strong-type','index.js'),'utf8'),
        await readFile(path.join(workspaceRoot,'node_modules','strong-type','index.js'),'utf8')
    );
    const built=await buildApplication({workspaceRoot,appId,target:'browser'});
    assert.equal(built.target,'browser');
    assert.equal(built.release.appId,appId);
    const running=await runApplication({
        workspaceRoot,
        appId,
        target:'browser',
        host:'127.0.0.1',
        port:0
    });
    assert.equal(running.target,'browser');
    assert.equal(running.verified.verified,true);
    await running.close();
    await running.lifecycle;
});

test('integrated Arcane workspace supports the complete browser app workflow',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-integrated-workspace-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='integrated-app';
    const fragmentPath=path.join(
        workspaceRoot,'apps',appId,'modules','navigation-fragment.html'
    );
    const fragmentBytes='<nav data-arcane-fragment>Navigation fragment</nav>\n';
    let packaged;

    await t.test('creates an integrated workspace without a managed SDK install',async()=>{
        await createApplication({
            targetPath:workspaceRoot,
            appId,
            displayName:'Integrated App'
        });
        await configureIntegratedWorkspace(workspaceRoot);
        await initializeApplication({
            workspaceRoot,
            appId:'other-app',
            displayName:'Other App'
        });
        await mkdir(path.join(workspaceRoot,'test'),{recursive:true});
        await writeFile(
            path.join(workspaceRoot,'test','root-must-not-run.test.mjs'),
            "import test from 'arcane-os/testing';\ntest('root test must not run in app scope',()=>{throw new Error('root test ran');});\n"
        );
        await writeFile(
            path.join(workspaceRoot,'apps','other-app','test','other-must-not-run.test.mjs'),
            "import test from 'arcane-os/testing';\ntest('other app test must not run',()=>{throw new Error('other app test ran');});\n"
        );
        await writeFile(
            path.join(workspaceRoot,'apps',appId,'test','managed-runtime.test.mjs'),
            `import assert from 'node:assert/strict';
import SpeechPlayback,{splitSpeechText} from 'arcane-os/speech-playback';
import test from 'arcane-os/testing';
test('selected source app tests consume public Node package entrypoints',()=>{
    assert.equal(typeof SpeechPlayback,'function');
    assert.deepEqual(splitSpeechText('complete source content'),['complete source content']);
});
`
        );
        const entryPath=path.join(workspaceRoot,'apps',appId,'index.html');
        const reviewPath=path.join(workspaceRoot,'apps',appId,'modules','review.html');
        await writeFile(
            reviewPath,
            (await readFile(entryPath,'utf8')).replace(
                '<base href="../../">',
                '<base href="../../../">'
            )
        );
        await writeFile(fragmentPath,fragmentBytes);

        await assert.rejects(lstat(path.join(workspaceRoot,'arcane.lock.json')),{code:'ENOENT'});
        await assert.rejects(
            lstat(path.join(workspaceRoot,'node_modules','arcane-os')),
            {code:'ENOENT'}
        );
    });

    await t.test('keeps authored and projected app descriptors aligned',async()=>{
        const descriptor=JSON.parse(await readFile(
            path.join(workspaceRoot,'apps',appId,'arcane-app.json'),
            'utf8'
        ));
        const packageManifest=JSON.parse(await readFile(
            path.join(workspaceRoot,'apps',appId,'arcane-package.json'),
            'utf8'
        ));
        assert.equal(descriptor.schemaVersion,2);
        assert.deepEqual(packageManifest,projectPackageManifest(descriptor));
    });

    await t.test('validates the integrated workspace profile',async()=>{
        const validation=await validateWorkspace({workspaceRoot,appId});
        assert.equal(validation.valid,true);
        assert.equal(validation.workspaceMode,'integrated');
        assert.equal(validation.lock,undefined);
        assert.equal(validation.app.descriptorSource,'authored');
        assert.deepEqual(
            validation.checks.map(check=>check.name),
            ['workspace-profile','descriptor','package','workspace-runtime','app-entry']
        );
    });

    await t.test('refreshes directly navigable documents and preserves HTML fragments',async()=>{
        const refreshed=await executeOperation('import-map',{workspaceRoot,appId});
        assert.equal(refreshed.importMap.documentCount,2);
        assert.deepEqual(
            refreshed.importMap.documentPaths.map(file=>path.relative(workspaceRoot,file).replaceAll('\\','/')),
            [`apps/${appId}/index.html`,`apps/${appId}/modules/review.html`]
        );
        assert.match(
            await readFile(path.join(workspaceRoot,'apps',appId,'modules','review.html'),'utf8'),
            /<script type="importmap" data-arcane-import-map>[\s\S]*arcane\/SpeechPlayback/u
        );
        assert.equal(await readFile(fragmentPath,'utf8'),fragmentBytes);
    });

    await t.test('checks only the selected application test scope',async()=>{
        const checked=await checkApplication({workspaceRoot,appId});
        assert.equal(checked.ok,true);
        assert.equal(checked.workspaceMode,'integrated');
        assert.equal(checked.descriptorSource,'authored');
        assert.equal(checked.runtime.mode,'workspace');
        assert.equal(checked.runtime.sourceRoot,'arcane');
        assert.equal(checked.tests.passed,true);
        assert.equal(checked.tests.skipped,false);
        assert.ok(checked.tests.testFiles.length>0);
        assert.ok(checked.tests.testFiles.every(file=>file.startsWith(`apps/${appId}/test/`)));
    });

    await t.test('serves source app and shared runtime assets during development',async()=>{
        const development=await developApplication({
            workspaceRoot,
            appId,
            host:'127.0.0.1',
            port:0
        });
        t.after(()=>development.close());
        assert.equal(development.mode,'source');
        developmentOrigin(development);
        const sourceEntry=await request(
            development,
            `/apps/${appId}/index.html`
        );
        assert.equal(sourceEntry.status,200);
        assert.match(await sourceEntry.text(),/Integrated App/);
        const sourceTheme=await request(development,'/arcane/css/theme.css');
        assert.equal(sourceTheme.status,200);
        assert.match(await sourceTheme.text(),/--background/);
        await development.close();
        await development.lifecycle;
    });

    await t.test('packages an integrated application release',async()=>{
        packaged=await packageApplication({workspaceRoot,appId});
        assert.equal(packaged.workspaceMode,'integrated');
        assert.equal(packaged.release.appId,appId);
        assert.equal(packaged.release.manifest.app.id,appId);
        assert.ok(packaged.release.files.includes('index.html'));
        assert.equal(Object.hasOwn(packaged,'tests'),false);
        assert.equal(Object.hasOwn(packaged.release,'contentSha256'),false);
    });

    await t.test('inspects the packaged release against its complete file inventory',async()=>{
        const verified=await verifyApplication({workspaceRoot,appId});
        assert.equal(verified.workspaceMode,'integrated');
        assert.equal(verified.release.appId,appId);
        assert.equal(verified.release.verified,true);
        assert.deepEqual(verified.release.files,packaged.release.files);
        assert.equal(Object.hasOwn(verified.release,'contentSha256'),false);
    });

    await t.test('builds an unsigned browser directory from the release',async()=>{
        const built=await buildApplication({
            workspaceRoot,
            appId,
            target:'browser',
            format:'directory',
            signing:'none'
        });
        assert.equal(built.workspaceMode,'integrated');
        assert.equal(built.target,'browser');
        assert.equal(built.format,'directory');
        assert.equal(built.signing,'none');
        assert.equal(Object.hasOwn(built,'runtimeContentSha256'),false);
        assert.equal(built.release.appId,appId);
    });

    await t.test('runs packaged app and shared runtime assets in a browser host',async()=>{
        const running=await runApplication({
            workspaceRoot,
            appId,
            target:'browser',
            host:'127.0.0.1',
            port:0
        });
        t.after(()=>running.close());
        assert.equal(running.target,'browser');
        assert.equal(running.mode,'packaged');
        assert.equal(running.verified.verified,true);
        developmentOrigin(running);
        const packagedEntry=await request(running,'/index.html');
        assert.equal(packagedEntry.status,200);
        assert.match(await packagedEntry.text(),/Integrated App/);
        const packagedTheme=await request(running,'/arcane/css/theme.css');
        assert.equal(packagedTheme.status,200);
        assert.match(await packagedTheme.text(),/--background/);
        await running.close();
        await running.lifecycle;
    });
});

test('programmatic application tests preserve complete isolated failure diagnostics',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-test-diagnostics-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='diagnostic-app';
    await createApplication({
        targetPath:workspaceRoot,
        appId,
        displayName:'Diagnostic App'
    });
    await configureIntegratedWorkspace(workspaceRoot);
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const testRoot=path.join(appRoot,'test');
    await rm(testRoot,{recursive:true,force:true});
    await mkdir(testRoot,{recursive:true});
    const relativeFiles=[];
    for(let index=0;index<5;index+=1){
        const relative=`apps/${appId}/test/diagnostic-${String(index)}.test.mjs`;
        relativeFiles.push(relative);
        await writeFile(
            path.join(workspaceRoot,...relative.split('/')),
            `import test from 'arcane-os/testing';\n`
                +`test('diagnostic failure ${String(index)}',()=>{\n`
                +`  console.log('o'.repeat(100000));\n`
                +`  console.log('ARCANE_STDOUT_SENTINEL_${String(index)}');\n`
                +`  console.error('e'.repeat(100000));\n`
                +`  console.error('ARCANE_STDERR_SENTINEL_${String(index)}');\n`
                +`  throw new Error('ARCANE_DIAGNOSTIC_STACK_${String(index)}');\n`
                +`});\n`
        );
    }

    const assertDiagnostics=error=>{
        assert.equal(error?.code,'ARCANE_OPERATION_FAILED');
        assert.match(error.message,/5 isolated test files failed\./);
        assert.match(error.message,/apps\/diagnostic-app\/test\/diagnostic-0\.test\.mjs/);
        assert.match(error.message,/Error: ARCANE_DIAGNOSTIC_STACK_0/);
        assert.match(error.message,/at .*diagnostic-0\.test\.mjs/);
        assert.deepEqual(error.details?.testFiles,relativeFiles);
        assert.equal(error.details?.failures?.length,relativeFiles.length);
        for(let index=0;index<error.details.failures.length;index+=1){
            const failure=error.details.failures[index];
            assert.equal(failure.testFile,relativeFiles[index]);
            assert.equal(failure.exitCode,1);
            assert.equal(failure.signal,null);
            assert.match(failure.stdout,new RegExp(`ARCANE_STDOUT_SENTINEL_${String(index)}`));
            assert.match(failure.stderr,new RegExp(`ARCANE_STDERR_SENTINEL_${String(index)}`));
            assert.match(failure.stderr,new RegExp(`Error: ARCANE_DIAGNOSTIC_STACK_${String(index)}`));
            assert.match(failure.stderr,new RegExp(`at .*diagnostic-${String(index)}\\.test\\.mjs`));
        }
        return true;
    };

    await t.test('testApplication reports complete per-file diagnostics',async()=>{
        await assert.rejects(
            testApplication({workspaceRoot,workspaceMode:'integrated',appId,appRoot}),
            assertDiagnostics
        );
    });
    await t.test('checkApplication preserves complete per-file diagnostics',async()=>{
        await assert.rejects(
            checkApplication({workspaceRoot,appId}),
            assertDiagnostics
        );
    });
});

test('application test discovery rejects links that leave the selected app test-code tree',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-test-path-boundary-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='test-path-app';
    await createApplication({targetPath:workspaceRoot,appId,displayName:'Test Path App'});
    await configureIntegratedWorkspace(workspaceRoot);
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const testRoot=path.join(appRoot,'test');
    const outside=path.join(parent,'outside.test.mjs');
    await writeFile(outside,"export const outside=true;\n");
    await symlink(outside,path.join(testRoot,'linked.test.mjs'),'file');

    await assert.rejects(
        testApplication({workspaceRoot,workspaceMode:'integrated',appId,appRoot}),
        /tests refuse symbolic links/u
    );
});
