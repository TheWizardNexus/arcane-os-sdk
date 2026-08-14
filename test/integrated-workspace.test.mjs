import assert from 'node:assert/strict';
import {lstat,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
    buildApplication,
    checkApplication,
    createApplication,
    developApplication,
    packageApplication,
    projectPackageManifest,
    runApplication,
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
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
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
    });
    await rm(path.join(workspaceRoot,'arcane.lock.json'),{force:true});

    const arcaneRoot=path.join(workspaceRoot,'arcane');
    for(const directory of ['components','css','entities','img','modules']){
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

    await createApplication({
        targetPath:workspaceRoot,
        appId,
        displayName:'Integrated App'
    });
    await configureIntegratedWorkspace(workspaceRoot);

    await assert.rejects(lstat(path.join(workspaceRoot,'arcane.lock.json')),{code:'ENOENT'});
    await assert.rejects(
        lstat(path.join(workspaceRoot,'node_modules','arcane-os')),
        {code:'ENOENT'}
    );

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

    const validation=await validateWorkspace({workspaceRoot,appId});
    assert.equal(validation.valid,true);
    assert.equal(validation.workspaceMode,'integrated');
    assert.equal(validation.lock,undefined);
    assert.equal(validation.app.descriptorSource,'authored');
    assert.deepEqual(
        validation.checks.map(check=>check.name),
        ['workspace-profile','descriptor','package','workspace-runtime','app-entry']
    );

    const checked=await checkApplication({workspaceRoot,appId});
    assert.equal(checked.ok,true);
    assert.equal(checked.workspaceMode,'integrated');
    assert.equal(checked.descriptorSource,'authored');
    assert.equal(checked.runtime.mode,'workspace');
    assert.equal(checked.runtime.sourceRoot,'arcane');
    assert.equal(checked.tests.passed,true);
    assert.equal(checked.tests.skipped,false);

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

    const packaged=await packageApplication({workspaceRoot,appId});
    assert.equal(packaged.workspaceMode,'integrated');
    assert.equal(packaged.runtimeContentSha256,null);
    assert.equal(packaged.release.app,appId);
    assert.match(packaged.release.contentSha256,/^[0-9a-f]{64}$/);

    const verified=await verifyApplication({workspaceRoot,appId});
    assert.equal(verified.workspaceMode,'integrated');
    assert.equal(verified.runtimeContentSha256,null);
    assert.equal(verified.release.app,appId);
    assert.equal(verified.release.verified,true);
    assert.equal(verified.release.contentSha256,packaged.release.contentSha256);

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
