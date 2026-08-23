import assert from 'node:assert/strict';
import {lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {
    buildApplication,
    checkApplication,
    createApplication,
    developApplication,
    initializeApplication,
    packageApplication,
    projectPackageManifest,
    runApplication,
    testApplication,
    validateWorkspace,
    verifyApplication
} from '../src/index.mjs';
import {temporaryDirectory} from './helpers.mjs';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

async function authorize(instance){
    const launch=new URL(instance.url);
    assert.equal(launch.origin,instance.origin);
    assert.equal(instance.cleanUrl,`${instance.origin}${launch.pathname}`);
    assert.match(launch.searchParams.get('arcane_session')||'',/^[0-9a-f]{64}$/);
    const response=await fetch(instance.url,{redirect:'manual'});
    assert.equal(response.status,302);
    assert.equal(response.headers.get('location'),launch.pathname);
    const cookie=response.headers.get('set-cookie')?.split(';',1)[0];
    assert.match(cookie||'',/^Arcane-Dev-Session-[0-9a-f]{16}=[0-9a-f]{64}$/);
    return cookie;
}

async function request(instance,requestPath,cookie){
    return fetch(`${instance.origin}${requestPath}`,{
        redirect:'manual',
        headers:{cookie}
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
        'document.documentElement.dataset.arcaneTheme="integrated";\n'
    );

    const strongTypeRoot=path.join(workspaceRoot,'node_modules','strong-type');
    await mkdir(strongTypeRoot,{recursive:true});
    await writeFile(
        path.join(strongTypeRoot,'index.js'),
        'export const type=value=>value;\n'
    );
    await writeFile(path.join(strongTypeRoot,'licence'),'MIT\n');
    await writeJson(path.join(strongTypeRoot,'package.json'),{
        name:'strong-type',
        version:'0.0.0-test',
        type:'module'
    });
}

test('integrated Arcane workspace supports the complete browser app workflow',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-integrated-workspace-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='integrated-app';
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
        const developmentCookie=await authorize(development);
        const sourceEntry=await request(
            development,
            `/apps/${appId}/index.html`,
            developmentCookie
        );
        assert.equal(sourceEntry.status,200);
        assert.match(await sourceEntry.text(),/Integrated App/);
        const sourceTheme=await request(development,'/arcane/css/theme.css',developmentCookie);
        assert.equal(sourceTheme.status,200);
        assert.match(await sourceTheme.text(),/--background/);
        await development.close();
        await development.lifecycle;
    });

    await t.test('packages an integrated application release',async()=>{
        packaged=await packageApplication({workspaceRoot,appId});
        assert.equal(packaged.workspaceMode,'integrated');
        assert.equal(packaged.runtimeContentSha256,null);
        assert.equal(packaged.release.app,appId);
        assert.match(packaged.release.contentSha256,/^[0-9a-f]{64}$/);
    });

    await t.test('verifies the packaged release against its content hash',async()=>{
        const verified=await verifyApplication({workspaceRoot,appId});
        assert.equal(verified.workspaceMode,'integrated');
        assert.equal(verified.runtimeContentSha256,null);
        assert.equal(verified.release.app,appId);
        assert.equal(verified.release.verified,true);
        assert.equal(verified.release.contentSha256,packaged.release.contentSha256);
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
        assert.equal(built.runtimeContentSha256,null);
        assert.equal(built.release.app,appId);
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
        const runningCookie=await authorize(running);
        const packagedEntry=await request(running,'/index.html',runningCookie);
        assert.equal(packagedEntry.status,200);
        assert.match(await packagedEntry.text(),/Integrated App/);
        const packagedTheme=await request(running,'/arcane/css/theme.css',runningCookie);
        assert.equal(packagedTheme.status,200);
        assert.match(await packagedTheme.text(),/--background/);
        await running.close();
        await running.lifecycle;
    });
});

test('programmatic application tests preserve bounded isolated failure diagnostics',async t=>{
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
        assert.equal(error.details?.outputTruncated,true);
        const capturedBytes=error.details.failures.reduce(
            (total,failure)=>total
                +Buffer.byteLength(failure.stdout,'utf8')
                +Buffer.byteLength(failure.stderr,'utf8'),
            0
        );
        assert.equal(error.details.outputBytes,capturedBytes);
        assert.ok(capturedBytes<=error.details.outputLimitBytes);
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

    await t.test('testApplication reports bounded per-file diagnostics',async()=>{
        await assert.rejects(
            testApplication({workspaceRoot,workspaceMode:'integrated',appId,appRoot}),
            assertDiagnostics
        );
    });
    await t.test('checkApplication preserves bounded per-file diagnostics',async()=>{
        await assert.rejects(
            checkApplication({workspaceRoot,appId}),
            assertDiagnostics
        );
    });
});
