import assert from 'node:assert/strict';
import {cp,mkdir,readFile,realpath,symlink,writeFile} from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as waitForHttpDateChange} from 'node:timers/promises';
import test from '../src/testing.mjs';
import {createWorkspace as scaffoldWorkspace} from '../src/scaffold.mjs';
import {startDevServer} from '../src/dev-server.mjs';
import {materializeInstalledSdkRuntime} from '../src/installed-sdk-runtime.mjs';
import {installedSdkRoutes} from '../src/sdk-runtime-layout.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {SDK_NAME,SDK_VERSION} from '../src/constants.mjs';
import {
    fetchSyntheticTls,repositoryRoot,temporaryDirectory,useSyntheticTls,writeSyntheticTlsFiles
} from './helpers.mjs';

async function createWorkspace(options) {
    const result = await scaffoldWorkspace(options);
    await writeSyntheticTlsFiles(options.targetPath);
    return result;
}

function assertPermissiveDevelopmentHeaders(response){
    for(const name of [
        'content-security-policy',
        'cross-origin-resource-policy',
        'referrer-policy',
        'x-content-type-options',
        'set-cookie'
    ]){
        assert.equal(response.headers.get(name),null,name);
    }
    const entry=response.status===200&&(
        response.headers.get('content-type')?.startsWith('text/html')
        ||new URL(response.url).pathname.endsWith('/arcane.importmap.json')
    );
    assert.equal(response.headers.get('cache-control'),entry?'no-cache':null);
}

async function request(origin,requestPath,options={}){
    return fetchSyntheticTls(`${origin}${requestPath}`,{redirect:'manual',...options});
}

function developmentOrigin(instance){
    const launch=new URL(instance.url);
    assert.equal(launch.origin,instance.origin);
    assert.equal(instance.cleanUrl,`${instance.origin}${launch.pathname}`);
    assert.equal(launch.search,'');
    return instance.origin;
}

async function installRuntime(workspaceRoot,dependencyName=SDK_NAME){
    const installedRoot=path.join(workspaceRoot,'node_modules',...dependencyName.split('/'));
    for(const directory of ['runtime','browser-runtime']){
        await cp(
            path.join(repositoryRoot,directory),
            path.join(installedRoot,directory),
            {recursive:true}
        );
    }
    await mkdir(path.join(installedRoot,'src'),{recursive:true});
    for(const relative of ['event-manager.mjs','dom-event-instrumentation.mjs']){
        await cp(path.join(repositoryRoot,'src',relative),path.join(installedRoot,'src',relative));
    }
    for(const dependency of ['event-pubsub','strong-type']){
        await cp(
            path.join(repositoryRoot,'node_modules',dependency),
            path.join(installedRoot,'node_modules',dependency),
            {recursive:true}
        );
    }
    await cp(path.join(repositoryRoot,'package.json'),path.join(installedRoot,'package.json'));
    for(const license of ['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']){
        await cp(path.join(repositoryRoot,license),path.join(installedRoot,license));
    }
}

async function configureSdkAlias(workspaceRoot,dependencyName='arcane-sdk'){
    const packagePath=path.join(workspaceRoot,'package.json');
    const packageDocument=JSON.parse(await readFile(packagePath,'utf8'));
    delete packageDocument.devDependencies[SDK_NAME];
    packageDocument.devDependencies[dependencyName]=`npm:${SDK_NAME}@${SDK_VERSION}`;
    await writeFile(packagePath,`${JSON.stringify(packageDocument,null,2)}\n`);

    const packageSource=`node_modules/${dependencyName}`;
    const rootConfigPath=path.join(workspaceRoot,'arcane-packager.json');
    const rootConfig=JSON.parse(await readFile(rootConfigPath,'utf8'));
    rootConfig.sharedPayloads['browser-runtime'][1].source=packageSource;
    await writeFile(rootConfigPath,`${JSON.stringify(rootConfig,null,2)}\n`);

    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    const lock=JSON.parse(await readFile(lockPath,'utf8'));
    lock.runtime.manifest=`${packageSource}/runtime/ARCANE_RUNTIME_RELEASE.json`;
    lock.sdkBrowserRuntime.manifest=
        `${packageSource}/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json`;
    await writeFile(lockPath,`${JSON.stringify(lock,null,2)}\n`);
}

async function createSdkRuntimeSource(parent,{
    directory='sdk-source',
    packageName=SDK_NAME,
    version=SDK_VERSION
}={}){
    const sourceRoot=path.join(parent,directory);
    for(const relative of [
        'runtime/arcane/components',
        'runtime/arcane/css',
        'runtime/arcane/entities',
        'runtime/arcane/img',
        'runtime/arcane/modules',
        'runtime/arcane/security',
        'runtime/arcane/dependencies',
        'runtime/arcane/outside',
        'runtime/strong-type',
        'browser-runtime/ai',
        'browser-runtime/.git',
        'browser-runtime/node_modules'
    ]){
        await mkdir(path.join(sourceRoot,...relative.split('/')),{recursive:true});
    }
    const files=new Map([
        ['package.json',`${JSON.stringify({name:packageName,version},null,2)}\n`],
        ['runtime/arcane/components/chat.html','<section>live chat component</section>\n'],
        ['runtime/arcane/css/theme.css',':root{--live-source:initial;}\n'],
        ['runtime/arcane/entities/Record.js','export default class Record {}\n'],
        ['runtime/arcane/img/icon.svg','<svg xmlns="http://www.w3.org/2000/svg"></svg>\n'],
        ['runtime/arcane/modules/AI.js','export const liveSource=true;\n'],
        ['runtime/arcane/security/policy.json','{"allowed":true}\n'],
        ['runtime/arcane/dependencies/private.js','export const leaked=true;\n'],
        ['runtime/arcane/outside/private.js','export const leaked=true;\n'],
        ['runtime/strong-type/index.js','export default function strongType(){}\n'],
        ['runtime/strong-type/package.json','{"name":"strong-type","version":"2.0.0"}\n'],
        ['browser-runtime/event-manager.mjs','export const liveBrowserRuntime=true;\n'],
        ['browser-runtime/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json','{"schemaVersion":1}\n'],
        ['browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json','{"private":true}\n'],
        ['browser-runtime/.git/config','private vcs content\n'],
        ['browser-runtime/node_modules/private.js','private dependency content\n']
    ]);
    for(const [relative,contents] of files){
        await writeFile(path.join(sourceRoot,...relative.split('/')),contents);
    }
    return sourceRoot;
}

async function availablePort(){
    const server=net.createServer();
    await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(0,'127.0.0.1',resolve);
    });
    const address=server.address();
    const port=address.port;
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    return port;
}

async function assertPortCanBeReused(port){
    const server=net.createServer();
    await new Promise((resolve,reject)=>{
        server.once('error',reject);
        server.listen(port,'127.0.0.1',resolve);
    });
    await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}

test(
    'module serving reuses unchanged files and rewrites changed source through conditional GET',
    async function conditionalDevelopmentResources(context) {
        useSyntheticTls(context);
        const parent = await temporaryDirectory(context, {prefix: 'arcane-conditional-source-'});
        const workspaceRoot = path.join(parent, 'workspace');
        const appId = 'conditional-app';
        await createWorkspace({targetPath: workspaceRoot, appId});
        const sourceRoot = await createSdkRuntimeSource(parent, {version: '9.8.7'});
        const documentPath = path.join(workspaceRoot, 'apps', appId, 'modules', 'raw notes.txt');
        const runtimePath = path.join(sourceRoot, 'runtime', 'arcane', 'modules', 'AI.js');
        const firstDocument = '  Complete document content.\nSecond line.  ';
        await Promise.all(
            [
                writeFile(documentPath, firstDocument),
                writeFile(runtimePath, "import './child.js?v=4'; export const state = 'first';")
            ]
        );
        const instance = await startDevServer(
            {workspaceRoot, appId, sdkRuntimeSourceRoot: sourceRoot}
        );
        context.after(
            async function closeConditionalSourceServer() {
                await instance.close();
            }
        );
        const resources = [
            `/apps/${appId}/modules/raw%20notes.txt?format=a%20b`,
            '/arcane/modules/AI.js?mode=worker',
            `/apps/${appId}/index.html`
        ];
        const modified = new Map();
        for (const resource of resources) {
            const response = await request(instance.origin, resource);
            assert.equal(response.status, 200);
            const lastModified = response.headers.get('last-modified');
            assert.ok(Number.isFinite(Date.parse(lastModified)));
            assert.equal(response.headers.get('etag'), null);
            assert.equal(response.headers.get('x-content-type-options'), null);
            const body = await response.text();
            if (resource === resources[0]) assert.equal(body, firstDocument);
            if (resource === resources[1]) assert.ok(body.includes('child.js?arcaneVersion=9.8.7'));
            modified.set(resource, lastModified);
            const unchanged = await request(
                instance.origin,
                resource,
                {headers: {'If-Modified-Since': lastModified}}
            );
            assert.equal(unchanged.status, 304);
            assert.equal(await unchanged.text(), '');
            const head = await request(instance.origin, resource, {method: 'HEAD'});
            assert.equal(head.status, 200);
            assert.equal(head.headers.get('last-modified'), lastModified);
            assert.equal(await head.text(), '');
        }

        // HTTP-date represents whole seconds, so the changed fixtures use the next second.
        await waitForHttpDateChange(1100);
        const updatedDocument = '  Updated complete document.\nSecond line remains.  ';
        const updatedRuntime = "import './child.js?v=4'; export const state = 'updated';";
        await Promise.all(
            [
                writeFile(documentPath, updatedDocument),
                writeFile(runtimePath, updatedRuntime),
                writeFile(
                    path.join(sourceRoot, 'package.json'),
                    JSON.stringify({name: SDK_NAME, version: '9.8.8'})
                )
            ]
        );
        // Navigation refreshes the selected SDK metadata before dependent resources.
        const entry = await request(
            instance.origin,
            resources[2],
            {headers: {'If-Modified-Since': modified.get(resources[2])}}
        );
        assert.equal(entry.status, 200);
        assert.ok((await entry.text()).includes('arcaneVersion=9.8.8'));
        for (const resource of [resources[0], resources[1]]) {
            const response = await request(
                instance.origin,
                resource,
                {headers: {'If-Modified-Since': modified.get(resource)}}
            );
            assert.equal(response.status, 200);
            assert.notEqual(response.headers.get('last-modified'), modified.get(resource));
            const body = await response.text();
            assert.equal(
                body,
                resource === resources[0]
                    ? updatedDocument
                    : "import './child.js?arcaneVersion=9.8.8'; export const state = 'updated';"
            );
        }
        assert.equal(await readFile(documentPath, 'utf8'), updatedDocument);
        assert.equal(await readFile(runtimePath, 'utf8'), updatedRuntime);
    }
);

test('source server versions local references from selected SDK metadata and revalidates entry HTML',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-versioned-source-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'served-app'});
    const sourceRoot=await createSdkRuntimeSource(parent,{version:'9.8.7'});
    await writeFile(path.join(sourceRoot,'runtime/arcane/modules/AI.js'),
        "import './child.js?v=2';\nnew Worker(new URL('./worker.js',import.meta.url),{type:'module'});\n");
    await writeFile(path.join(sourceRoot,'runtime/arcane/modules/child.js'),'export const ready=true;\n');
    await writeFile(path.join(sourceRoot,'runtime/arcane/modules/worker.js'),"import './child.js?v=2';\n");
    const corpus='<base href="./"><script src="./original.js"></script>'
        +'<style>p{background:url(original.svg)}</style><p>Complete supplied HTML</p>';
    await writeFile(path.join(workspaceRoot,'apps/served-app/modules/document.html'),corpus);
    const instance=await startDevServer({workspaceRoot,appId:'served-app',sdkRuntimeSourceRoot:sourceRoot});
    t.after(()=>instance.close());
    const entry=await request(instance.origin,'/apps/served-app/index.html');
    assert.equal(entry.status,200);
    assert.equal(entry.headers.get('cache-control'),'no-cache');
    assert.ok((await entry.text()).includes('arcaneVersion=9.8.7'));
    const module=await request(instance.origin,'/arcane/modules/AI.js?arcaneVersion=9.8.7');
    assert.equal(module.status,200);
    assert.equal(module.headers.get('cache-control'),null);
    const source=await module.text();
    assert.ok(source.includes('child.js?arcaneVersion=9.8.7'));
    assert.ok(source.includes('worker.js?arcaneVersion=9.8.7'));
    const worker=await request(instance.origin,'/arcane/modules/worker.js?arcaneVersion=9.8.7');
    assert.equal(worker.status,200);
    assert.ok((await worker.text()).includes('child.js?arcaneVersion=9.8.7'));
    assert.equal(await readFile(path.join(sourceRoot,'runtime/arcane/modules/worker.js'),'utf8'),
        "import './child.js?v=2';\n");
    const document=await request(instance.origin,'/apps/served-app/modules/document.html');
    assert.equal(document.status,200);
    assert.equal(document.headers.get('cache-control'),null);
    assert.equal(await document.text(),corpus);
    const malformedCorpus='<base href="./" href="../"><script src="./a.js" src="./b.js"></script>'
        +'<!-- data-arcane-import-map -->';
    await writeFile(path.join(workspaceRoot,'apps/served-app/modules/document.html'),malformedCorpus);
    const malformedDocument=await request(instance.origin,'/apps/served-app/modules/document.html');
    assert.equal(malformedDocument.status,200);
    assert.equal(await malformedDocument.text(),malformedCorpus);
    await writeFile(path.join(sourceRoot,'package.json'),JSON.stringify({name:SDK_NAME,version:'9.8.8'}));
    const refreshedEntry=await request(instance.origin,'/apps/served-app/index.html');
    assert.ok((await refreshedEntry.text()).includes('arcaneVersion=9.8.8'));
    const refreshedWorker=await request(instance.origin,'/arcane/modules/worker.js?arcaneVersion=9.8.8');
    assert.ok((await refreshedWorker.text()).includes('child.js?arcaneVersion=9.8.8'));
});

test('source server exposes the selected app and installed SDK browser routes',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'served-app'});
    await installRuntime(workspaceRoot);
    await materializeInstalledSdkRuntime({workspaceRoot});
    const appRoot=path.join(workspaceRoot,'apps','served-app');
    const descriptorPath=path.join(appRoot,'arcane-app.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    descriptor.package.include.push('TEST');
    descriptor.package.include.sort();
    await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`);
    await writeFile(
        path.join(appRoot,'arcane-package.json'),
        `${JSON.stringify(projectPackageManifest(descriptor),null,2)}\n`
    );
    await mkdir(path.join(appRoot,'TEST'),{recursive:true});
    await writeFile(path.join(appRoot,'TEST','secret.txt'),'private\n');
    const events=[];
    const instance=await startDevServer({
        workspaceRoot,
        appId:'served-app',
        host:'127.0.0.1',
        port:0,
        onEvent:event=>events.push(event)
    });
    t.after(()=>instance.close());
    const origin=instance.origin;

    assert.ok(events.find(event=>event.type==='server.starting'));
    assert.equal(events.at(-1).type,'server.started');
    assert.equal(Object.hasOwn(instance,'runtimeMode'),false);
    assert.equal(Object.hasOwn(instance,'runtime'),false);
    assert.equal(Object.hasOwn(events[0],'runtimeMode'),false);
    assert.equal(Object.hasOwn(events.at(-1),'runtimeMode'),false);
    const direct=await request(origin,'/apps/served-app/index.html');
    assert.equal(direct.status,200);
    assertPermissiveDevelopmentHeaders(direct);
    await direct.text();
    developmentOrigin(instance);
    const root=await request(origin,'/');
    assert.equal(root.status,302);
    assert.equal(root.headers.get('location'),'/apps/served-app/index.html');
    assertPermissiveDevelopmentHeaders(root);

    const app=await request(origin,'/apps/served-app/index.html');
    assert.equal(app.status,200);
    assert.match(app.headers.get('content-type'),/^text\/html/);
    assertPermissiveDevelopmentHeaders(app);
    assert.match(await app.text(),/<meta name="arcane-app-id" content="served-app">/);

    const theme=await request(origin,'/arcane/css/theme.css');
    assert.equal(theme.status,200);
    assert.match(theme.headers.get('content-type'),/^text\/css/);

    const speechWorker=await request(
        origin,
        '/arcane/sdk/ai/speech-worker-runtime.mjs'
    );
    assert.equal(speechWorker.status,200);
    assert.match(speechWorker.headers.get('content-type'),/^text\/javascript/);
    assertPermissiveDevelopmentHeaders(speechWorker);
    await speechWorker.arrayBuffer();

    const eventManager=await request(origin,'/arcane/sdk/event-manager.mjs');
    assert.equal(eventManager.status,200);
    assert.match(eventManager.headers.get('content-type'),/^text\/javascript/);
    assertPermissiveDevelopmentHeaders(eventManager);
    await eventManager.text();

    const networkPolicy=await request(origin,'/arcane/security/arcane-network-policy.json');
    assert.equal(networkPolicy.status,200);
    assert.match(networkPolicy.headers.get('content-type'),/^application\/json/);
    assert.equal((await networkPolicy.json()).schemaVersion,1);

    const strongType=await request(origin,'/arcane/dependencies/strong-type/index.js');
    assert.equal(strongType.status,200);
    assert.match(strongType.headers.get('content-type'),/^text\/javascript/);
    assert.equal(
        (await request(origin,'/node_modules/strong-type/index.js')).status,
        404
    );

    for(const deniedPath of [
        '/package.json',
        '/apps/served-app',
        '/apps/served-app/arcane-app.json',
        '/apps/served-app/arcane-package.json',
        '/apps/served-app/test/app.test.mjs',
        '/apps/served-app/tests/private.test.mjs',
        '/apps/served-app/scripts/build.mjs',
        '/apps/served-app/TEST/secret.txt',
        '/apps/served-app/.env',
        '/node_modules/arcane-os/package.json',
        '/ollama/api/version',
        '/arcane/..%2F..%2Fpackage.json',
        '/apps/served-app/%2e%2e%2f%2e%2e%2fpackage.json',
        '/apps/served-app/%5c..%5cpackage.json',
        '/apps/served-app/CLOCK$/child.js',
        '/apps/served-app/CONIN$.json',
        '/apps/served-app/CONOUT$/child.js',
        '/apps/served-app/COM%C2%B9.log',
        '/apps/served-app/lpt%C2%B2/child.js',
        '/apps/served-app/less%3Cthan.js',
        '/apps/served-app/greater%3Ethan.js',
        '/apps/served-app/double%22quote.js',
        '/apps/served-app/vertical%7Cbar.js',
        '/apps/served-app/question%3Fmark.js',
        '/apps/served-app/asterisk%2A.js'
    ]){
        const response=await request(origin,deniedPath);
        assert.ok([400,404].includes(response.status),`${deniedPath} returned ${response.status}`);
    }

    const post=await request(origin,'/apps/served-app/index.html',{method:'POST'});
    assert.equal(post.status,405);

    await writeFile(
        path.join(workspaceRoot,'node_modules','arcane-os','runtime','arcane','css','theme.css'),
        'changed installed runtime\n'
    );
    const unchangedWorkspaceRuntime=await request(origin,'/arcane/css/theme.css');
    assert.equal(unchangedWorkspaceRuntime.status,200);
    assert.doesNotMatch(await unchangedWorkspaceRuntime.text(),/changed installed runtime/);

    await writeFile(
        path.join(workspaceRoot,'arcane','css','theme.css'),
        'changed workspace runtime\n'
    );
    const changedRuntime=await request(origin,'/arcane/css/theme.css');
    assert.equal(changedRuntime.status,200);
    assert.match(await changedRuntime.text(),/changed workspace runtime/);
});

test('direct source serving is independent of the installed package dependency name',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-alias-source-server-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='alias-served-app';
    await createWorkspace({targetPath:workspaceRoot,appId});
    await configureSdkAlias(workspaceRoot);
    await installRuntime(workspaceRoot,'arcane-sdk');

    const instance=await startDevServer({
        workspaceRoot,
        appId,
        host:'127.0.0.1',
        port:0
    });
    t.after(()=>instance.close());
    const origin=developmentOrigin(instance);
    const theme=await request(origin,'/arcane/css/theme.css');
    assert.equal(theme.status,200);
    assert.match(theme.headers.get('content-type'),/^text\/css/u);
});

for (const liveSource of [false, true]) {
    test(`root application routes preserve direct npm aliases${liveSource ? ' with live SDK source' : ''}`,
        async function rootInstalledSourceRoutes(context) {
            const parent = await temporaryDirectory(context, {prefix: 'arcane-root-source-'});
            const workspaceRoot = path.join(parent, 'workspace');
            const appId = 'root-served-app';
            await scaffoldWorkspace({targetPath: workspaceRoot, appId, appsRoot: '.'});
            const packageSource = 'node_modules/arcane-sdk';
            const packagePath = path.join(workspaceRoot, 'package.json');
            const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
            delete packageDocument.devDependencies[SDK_NAME];
            packageDocument.devDependencies['arcane-sdk'] = `npm:${SDK_NAME}@${SDK_VERSION}`;
            await writeFile(packagePath, JSON.stringify(packageDocument), 'utf8');
            const configPath = path.join(workspaceRoot, 'arcane-packager.json');
            const config = JSON.parse(await readFile(configPath, 'utf8'));
            config.sharedPayloads['browser-runtime'] = installedSdkRoutes(packageSource, {direct: true});
            await writeFile(configPath, JSON.stringify(config), 'utf8');
            const installedRoot = await createSdkRuntimeSource(workspaceRoot, {directory: packageSource});
            await writeFile(path.join(installedRoot, 'runtime/arcane/modules/AI.js'), 'export const installedRuntime = true;');
            await writeFile(path.join(workspaceRoot, 'modules/root.js'), 'export const rootApplication = true;');
            const sdkRuntimeSourceRoot = liveSource ? await createSdkRuntimeSource(parent) : undefined;
            const instance = await startDevServer({
                workspaceRoot, appId, sdkRuntimeSourceRoot, port: 0, http: true
            });
            context.after(function closeRootSourceServer() { return instance.close(); });
            assert.equal(instance.url, `${instance.origin}/index.html`);
            const query = '?request=full%20content&tag=one&tag=two';
            const redirect = await globalThis.fetch(`${instance.origin}/apps/${appId}/index.html${query}`, {redirect: 'manual'});
            assert.equal(redirect.headers.get('location'), `/index.html${query}`);
            const app = await globalThis.fetch(`${instance.origin}/modules/root.js`);
            assert.equal(await app.text(), 'export const rootApplication = true;');
            const runtime = await globalThis.fetch(`${instance.origin}/${packageSource}/runtime/arcane/modules/AI.js`);
            assert.equal(runtime.status, 200);
            assert.equal(await runtime.text(), liveSource ? 'export const liveSource=true;\n' : 'export const installedRuntime = true;');
            for (const relative of ['browser-runtime/event-manager.mjs', 'runtime/strong-type/index.js']) {
                const shared = await globalThis.fetch(`${instance.origin}/${packageSource}/${relative}`);
                assert.equal(shared.status, 200, relative);
                await shared.text();
            }
            const oldVirtual = await globalThis.fetch(`${instance.origin}/arcane/sdk/event-manager.mjs`);
            assert.equal(oldVirtual.status, 404);
        }
    );
}

test('explicit SDK runtime source mount is live, narrow, and observable',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-sdk-source-server-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'source-mounted-app'});
    await installRuntime(workspaceRoot);
    const sourceRoot=await createSdkRuntimeSource(parent);
    const canonicalSourceRoot=await realpath(sourceRoot);
    const events=[];
    const instance=await startDevServer({
        workspaceRoot,
        appId:'source-mounted-app',
        sdkRuntimeSourceRoot:sourceRoot,
        host:'127.0.0.1',
        port:0,
        onEvent:function captureEvent(event){
            events.push(event);
        }
    });
    t.after(function closeSourceServer(){
        return instance.close();
    });

    assert.equal(instance.runtimeMode,'sdk-source');
    assert.deepEqual(instance.runtime,{
        mode:'sdk-source',
        protocol:'arcane-sdk-runtime-source/1',
        mutable:true,
        distributionAuthority:false,
        sourceRoot:canonicalSourceRoot
    });
    assert.deepEqual(events.map(function eventType(event){return event.type;}),[
        'server.starting',
        'runtime.source.mount.started',
        'runtime.source.mount.progress',
        'runtime.source.mount.progress',
        'runtime.source.mount.progress',
        'runtime.source.mount.ready',
        'server.started'
    ]);
    assert.equal(events[0].runtimeMode,'sdk-source');
    assert.deepEqual(
        events.filter(function isMountProgress(event){
            return event.type==='runtime.source.mount.progress';
        }).map(function progressPath(event){return event.path;}),
        ['runtime/arcane','runtime/strong-type','browser-runtime']
    );
    assert.equal(events.at(-2).routeCount,3);
    assert.equal(events.at(-2).canonicalRoot,canonicalSourceRoot);
    assert.equal(events.at(-1).runtimeMode,'sdk-source');

    const origin=developmentOrigin(instance);
    for(const allowedPath of [
        '/arcane/components/chat.html',
        '/arcane/css/theme.css',
        '/arcane/entities/Record.js',
        '/arcane/img/icon.svg',
        '/arcane/modules/AI.js',
        '/arcane/security/policy.json',
        '/arcane/dependencies/strong-type/index.js',
        '/arcane/dependencies/strong-type/package.json',
        '/arcane/sdk/event-manager.mjs',
        '/arcane/sdk/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json'
    ]){
        const response=await request(origin,allowedPath);
        assert.equal(response.status,200,allowedPath);
        await response.arrayBuffer();
    }
    for(const deniedPath of [
        '/arcane/dependencies/private.js',
        '/arcane/outside/private.js',
        '/arcane/sdk/ARCANE_SDK_BROWSER_RELEASE.json',
        '/arcane/sdk/.git/config',
        '/arcane/sdk/node_modules/private.js'
    ]){
        const response=await request(origin,deniedPath);
        assert.equal(response.status,404,deniedPath);
        await response.text();
    }

    const themePath=path.join(sourceRoot,'runtime','arcane','css','theme.css');
    const initialTheme=await request(origin,'/arcane/css/theme.css');
    assert.match(await initialTheme.text(),/live-source:initial/u);
    await writeFile(themePath,':root{--live-source:refreshed;}\n');
    const refreshedTheme=await request(origin,'/arcane/css/theme.css');
    assert.equal(refreshedTheme.status,200);
    assert.match(await refreshedTheme.text(),/live-source:refreshed/u);

    await instance.close();
    assert.equal(events.at(-2).type,'runtime.source.mount.stopped');
    assert.equal(events.at(-2).reason,'closed');
    assert.equal(events.at(-1).type,'server.stopped');
});

test('explicit SDK runtime source mount rejects overlap and linked roots',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-sdk-source-policy-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'source-policy-app'});
    await installRuntime(workspaceRoot);

    await assert.rejects(
        startDevServer({
            workspaceRoot,
            appId:'source-policy-app',
            sdkRuntimeSourceRoot:workspaceRoot,
            host:'127.0.0.1',
            port:0
        }),
        function isWorkspaceOverlap(error){
            return error?.code==='ARCANE_DEV_RUNTIME_SOURCE_INVALID';
        }
    );

    const sourceRoot=await createSdkRuntimeSource(parent,{directory:'canonical-source'});
    await assert.rejects(
        startDevServer({mode:'packaged',sdkRuntimeSourceRoot:sourceRoot}),
        function isPackagedModeUsageError(error){
            return error?.code==='ARCANE_USAGE';
        }
    );
    const linkedRoot=path.join(parent,'linked-source');
    await symlink(sourceRoot,linkedRoot,process.platform==='win32'?'junction':'dir');
    await assert.rejects(
        startDevServer({
            workspaceRoot,
            appId:'source-policy-app',
            sdkRuntimeSourceRoot:linkedRoot,
            host:'127.0.0.1',
            port:0
        }),
        function isLinkedRoot(error){
            return error?.code==='ARCANE_DEV_RUNTIME_SOURCE_INVALID';
        }
    );
});

test('packaged development server serves its selected real directory without admission gates',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-packaged-server-'});
    await writeSyntheticTlsFiles(parent);
    const releaseRoot=path.join(parent,'packaged-app');
    await mkdir(path.join(releaseRoot,'arcane','css'),{recursive:true});
    await Promise.all([
        writeFile(path.join(releaseRoot,'index.html'),'<main>Packaged App</main>\n'),
        writeFile(path.join(releaseRoot,'arcane','css','theme.css'),':root{--background:black;}\n')
    ]);
    const instance=await startDevServer({
        mode:'packaged',
        workspaceRoot:parent,
        releaseRoot,
        host:'127.0.0.1',
        port:0
    });
    t.after(()=>instance.close());
    const origin=developmentOrigin(instance);

    const root=await request(origin,'/');
    assert.equal(root.status,302);
    assert.equal(root.headers.get('location'),'/index.html');
    assertPermissiveDevelopmentHeaders(root);
    const entry=await request(origin,'/index.html');
    assert.equal(entry.status,200);
    assertPermissiveDevelopmentHeaders(entry);
    assert.match(await entry.text(),/Packaged App/);
    const lastModified = entry.headers.get('last-modified');
    assert.ok(Number.isFinite(Date.parse(lastModified)));
    assert.equal(entry.headers.get('etag'), null);
    const unchanged = await request(
        origin,
        '/index.html',
        {headers: {'If-Modified-Since': lastModified}}
    );
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), '');
    const head = await request(
        origin,
        '/index.html',
        {method: 'HEAD'}
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('last-modified'), lastModified);
    assert.equal(await head.text(), '');

    await writeFile(path.join(releaseRoot,'index.html'),'changed package content\n');
    const changedRelease=await request(origin,'/index.html');
    assert.equal(changedRelease.status,200);
    assert.equal(await changedRelease.text(),'changed package content\n');
});

test('development server keeps local defaults and supports explicit public binding',async function serverBindAddresses(t){
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-addresses-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='network-app';
    await createWorkspace({targetPath:workspaceRoot,appId});
    const sdkRuntimeSourceRoot=await createSdkRuntimeSource(parent);
    const originalNetworkInterfaces=os.networkInterfaces;
    let interfaceReads=0;
    os.networkInterfaces=function fixtureNetworkInterfaces(){
        interfaceReads+=1;
        return {
            loopback:[{address:'127.0.0.1',family:'IPv4',internal:true}],
            ethernet:[
                {address:'192.0.2.10',family:'IPv4',internal:false},
                {address:'2001:db8::10',family:'IPv6',scopeid:0,internal:false}
            ],
            wireless:[{address:'198.51.100.20',family:'IPv4',internal:false}],
            duplicate:[{address:'192.0.2.10',family:'IPv4',internal:false}]
        };
    };
    try{
        for(const host of [undefined,'localhost','0.0.0.0']){
            await t.test(host??'default loopback',async function bindSelectedHost(context){
                const events=[];
                const instance=await startDevServer({
                    workspaceRoot,
                    appId,
                    sdkRuntimeSourceRoot,
                    host,
                    port:0,
                    onEvent:function collectServerEvent(event){events.push(event);}
                });
                context.after(function closeSelectedServer(){return instance.close();});
                const publicBinding=host==='0.0.0.0';
                assert.equal(instance.protocol,'https:');
                if(publicBinding){
                    assert.equal(instance.server.address().address,'0.0.0.0');
                    assert.equal(instance.origin,`https://localhost:${instance.port}`);
                    assert.deepEqual(instance.networkUrls,[
                        `https://192.0.2.10:${instance.port}/apps/${appId}/index.html`,
                        `https://198.51.100.20:${instance.port}/apps/${appId}/index.html`
                    ]);
                }else{
                    assert.ok(['127.0.0.1','::1'].includes(instance.host));
                    if(host===undefined)assert.equal(instance.host,'127.0.0.1');
                    assert.deepEqual(instance.networkUrls,[]);
                }
                assert.equal(instance.url,`${instance.origin}/apps/${appId}/index.html`);
                assert.equal(instance.cleanUrl,instance.url);
                assert.deepEqual(events.at(-1).networkUrls,instance.networkUrls);
                const requestOrigin=publicBinding?`https://127.0.0.1:${instance.port}`:instance.origin;
                const response=await request(requestOrigin,`/apps/${appId}/index.html`);
                assert.equal(response.status,200);
                assert.ok((await response.text()).includes(`content="${appId}"`));
            });
        }
        assert.equal(interfaceReads,1);
    }finally{
        os.networkInterfaces=originalNetworkInterfaces;
    }
});

test(
    'explicit HTTP source development serves unchanged routes without certificates and owns one listener',
    async function explicitHttpDevelopment(context) {
        const parent = await temporaryDirectory(context, {prefix: 'arcane-http-source-'});
        const workspaceRoot = path.join(parent, 'workspace');
        const appId = 'http-source';
        await scaffoldWorkspace({targetPath: workspaceRoot, appId});
        const sdkRuntimeSourceRoot = await createSdkRuntimeSource(parent);
        const controller = new AbortController();
        const events = [];
        const instance = await startDevServer(
            {
                workspaceRoot, appId, sdkRuntimeSourceRoot, http: true, https: false, tls: false, port: 0,
                signal: controller.signal,
                onEvent: function rememberHttpSourceEvent(event) {
                    events.push(event);
                }
            }
        );
        context.after(
            async function closeHttpSourceFixture() {
                await instance.close();
            }
        );
        assert.ok(instance.server instanceof http.Server);
        assert.equal(instance.protocol, 'http:');
        assert.equal(instance.origin, `http://127.0.0.1:${instance.port}`);
        assert.equal(instance.url, `${instance.origin}/apps/${appId}/index.html`);
        assert.equal(instance.cleanUrl, instance.url);
        assert.equal(instance.httpPort, instance.port);
        assert.equal(instance.httpOrigin, instance.origin);
        assert.equal(instance.httpUrl, instance.url);
        assert.equal(events.at(-1).protocol, 'http:');
        assert.equal(events.at(-1).httpPort, instance.port);
        await assert.rejects(
            readFile(path.join(workspaceRoot, '.arcane', 'dev', 'server-cert.pem')),
            {code: 'ENOENT'}
        );
        const root = await fetch(`${instance.origin}/`, {redirect: 'manual'});
        assert.equal(root.status, 302);
        assert.equal(root.headers.get('location'), `/apps/${appId}/index.html`);
        await root.text();
        const entry = await fetch(instance.url, {redirect: 'manual'});
        assert.equal(entry.status, 200);
        assert.equal(entry.headers.get('location'), null);
        await entry.text();
        const resourceUrl = `${instance.origin}/arcane/modules/AI.js?mode=worker`;
        const resource = await fetch(resourceUrl, {redirect: 'manual'});
        assert.equal(resource.status, 200);
        assert.equal(await resource.text(), 'export const liveSource=true;\n');
        const lastModified = resource.headers.get('last-modified');
        assert.ok(lastModified);
        const unchanged = await fetch(
            resourceUrl,
            {headers: {'If-Modified-Since': lastModified}, redirect: 'manual'}
        );
        assert.equal(unchanged.status, 304);
        assert.equal(await unchanged.text(), '');
        const head = await fetch(resourceUrl, {method: 'HEAD', redirect: 'manual'});
        assert.equal(head.status, 200);
        assert.equal(head.headers.get('last-modified'), lastModified);
        assert.equal(await head.text(), '');
        const unsupported = await fetch(instance.url, {method: 'POST', redirect: 'manual'});
        assert.equal(unsupported.status, 405);
        await unsupported.text();
        controller.abort();
        await instance.closed;
        await instance.lifecycle;
        assert.equal(
            events.filter(
                function isHttpSourceStopped(event) {
                    return event.type === 'server.stopped';
                }
            ).length,
            1
        );
        await assertPortCanBeReused(instance.port);
    }
);

test(
    'explicit HTTP development releases its listener when startup event delivery fails',
    async function httpStartupEventFailure(context) {
        const parent = await temporaryDirectory(context, {prefix: 'arcane-http-start-failure-'});
        const workspaceRoot = path.join(parent, 'workspace');
        const appId = 'http-start-failure';
        await scaffoldWorkspace({targetPath: workspaceRoot, appId});
        const sdkRuntimeSourceRoot = await createSdkRuntimeSource(parent);
        const port = await availablePort();
        const callbackFailure = new Error('HTTP startup event failed.');
        await assert.rejects(
            startDevServer(
                {
                    workspaceRoot, appId, sdkRuntimeSourceRoot, http: true, port,
                    onEvent: function rejectHttpStartedEvent(event) {
                        if (event.type === 'server.started') throw callbackFailure;
                    }
                }
            ),
            function isHttpStartupCallbackFailure(error) {
                return error === callbackFailure;
            }
        );
        await assertPortCanBeReused(port);
    }
);

test(
    'HTTP development rejects conflicting transport inputs and packaged mode before startup',
    async function invalidHttpDevelopmentOptions() {
        for (const options of [
            {http: null}, {http: 1}, {http: 'true'}, {http: {}},
            {http: true, mode: 'packaged'},
            {http: true, https: true},
            {http: true, tls: {}},
            {http: true, certPath: 'certificate.pem'},
            {http: true, keyPath: 'private-key.pem'},
            {http: true, httpPort: 8124}
        ]) {
            await assert.rejects(
                startDevServer(options),
                function isHttpOptionUsageError(error) {
                    return error.code === 'ARCANE_USAGE';
                }
            );
        }
    }
);

test('HTTP redirects preserve request targets and close with either HTTPS transport', async function developmentRedirects(t) {
    const fixture = useSyntheticTls(t);
    const parent = await temporaryDirectory(t, {prefix: 'arcane-redirect-server-'});
    const workspaceRoot = path.join(parent, 'workspace');
    const appId = 'redirect-app';
    await createWorkspace({targetPath: workspaceRoot, appId});
    const sdkRuntimeSourceRoot = await createSdkRuntimeSource(parent);
    const tls = {cert: 'Synthetic raw certificate.', key: 'Synthetic raw key.'};
    for (const options of [{}, {tls}]) {
        const events = [];
        const instance = await startDevServer({
            workspaceRoot, appId, sdkRuntimeSourceRoot, ...options,
            onEvent: function rememberRedirectEvent(event) {events.push(event);}
        });
        t.after(function closeRedirectFixture() {return instance.close();});
        assert.equal(instance.httpUrl, `${instance.httpOrigin}/apps/${appId}/index.html`);
        assert.equal(events.at(-1).httpUrl, instance.httpUrl);
        assert.equal(events.at(-1).httpPort, instance.httpPort);
        if (options.tls) assert.equal(fixture.options.at(-1), tls);
        for (const method of ['GET', 'HEAD', 'POST']) {
            const target = `/apps/${appId}/file%20name.html?first=a%20b&first=c%2Fd`;
            const response = await fetch(`${instance.httpOrigin}${target}`, {method, redirect: 'manual'});
            assert.equal(response.status, 308);
            assert.equal(response.headers.get('location'), `${instance.origin}${target}`);
            assert.equal(await response.text(), '');
        }
        const entry = await request(instance.origin, `/apps/${appId}/index.html`);
        assert.equal(entry.status, 200);
        await entry.text();
        instance.server.close();
        await instance.closed;
        await assertPortCanBeReused(instance.port);
        await assertPortCanBeReused(instance.httpPort);
    }
});

test('a failed paired listener releases both selected ports', async function pairedListenerFailure(t) {
    useSyntheticTls(t);
    const parent = await temporaryDirectory(t, {prefix: 'arcane-paired-failure-'});
    const workspaceRoot = path.join(parent, 'workspace');
    const appId = 'paired-failure';
    await createWorkspace({targetPath: workspaceRoot, appId});
    const sdkRuntimeSourceRoot = await createSdkRuntimeSource(parent);
    const occupied = net.createServer();
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    t.after(function closeOccupiedPort() {return new Promise(resolve => occupied.close(resolve));});
    const occupiedPort = occupied.address().port;
    for (const selected of ['port', 'httpPort']) {
        const available = await availablePort();
        const options = selected === 'port'
            ? {port: occupiedPort, httpPort: available}
            : {port: available, httpPort: occupiedPort};
        await assert.rejects(
            startDevServer({workspaceRoot, appId, sdkRuntimeSourceRoot, ...options}),
            error => error.code === 'EADDRINUSE'
        );
        await assertPortCanBeReused(available);
    }
});

test('development server selects the HTTPS listener without exposing TLS settings',async function httpsDevelopmentTransport(t){
    const parent=await temporaryDirectory(t,{prefix:'arcane-https-server-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='https-app';
    await createWorkspace({targetPath:workspaceRoot,appId});
    const sdkRuntimeSourceRoot=await createSdkRuntimeSource(parent);
    const events=[];
    const instance=await startDevServer({
        workspaceRoot,appId,sdkRuntimeSourceRoot,host:'0.0.0.0',
        tls:{sessionIdContext:'fixture-private-tls-setting'},
        onEvent:function collectHttpsEvent(event){events.push(event);}
    });
    t.after(function closeHttpsServer(){return instance.close();});
    // This tests listener selection and reporting; it does not claim a certificate handshake.
    assert.ok(instance.server instanceof https.Server);
    assert.equal(instance.protocol,'https:');
    assert.equal(instance.origin,`https://localhost:${instance.port}`);
    assert.equal(instance.url,`${instance.origin}/apps/${appId}/index.html`);
    for(const url of instance.networkUrls)assert.equal(new URL(url).protocol,'https:');
    assert.equal(events.at(-1).protocol,'https:');
    assert.equal(Object.hasOwn(instance,'tls'),false);
    assert.equal(JSON.stringify(events).includes('fixture-private-tls-setting'),false);
});

test('HTTPS development reports missing certificate files without starting HTTP',async function missingDevelopmentCertificates(t){
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-missing-certificates-'});
    for (const options of [{}, {http: false}, {https: false}, {https: true}, {tls: false}, {mode: 'packaged'}]) {
        const events = [];
        await assert.rejects(
            startDevServer(
                {
                    workspaceRoot, ...options,
                    onEvent: function collectCertificateFailureEvent(event) {
                        events.push(event);
                    }
                }
            ),
            function isMissingCertificatePair(error) {
                assert.equal(error.code, 'ARCANE_DEV_TLS_MISSING');
                assert.ok(error.message.includes('require HTTPS'));
                assert.ok(error.message.includes(path.join(workspaceRoot, '.arcane', 'dev', 'server-cert.pem')));
                assert.ok(error.message.includes(path.join(workspaceRoot, '.arcane', 'dev', 'server-key.pem')));
                return true;
            }
        );
        assert.deepEqual(
            events.map(
                function certificateEventType(event) {return event.type;}
            ),
            ['server.starting']
        );
    }
    await assert.rejects(
        startDevServer({workspaceRoot,certPath:'cert.pem'}),
        function isIncompleteCertificatePair(error){return error.code==='ARCANE_USAGE';}
    );
});

test('development server reports malformed host options before binding',async function invalidServerHost(){
    for(const host of ['',null,17]){
        await assert.rejects(
            startDevServer({host}),
            function isHostUsageError(error){return error?.code==='ARCANE_USAGE';}
        );
    }
});

test('source server uses the application materialization without authenticating installed content',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-runtime-' });
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'tampered-runtime'});
    await installRuntime(workspaceRoot);
    await writeFile(
        path.join(
            workspaceRoot,
            'node_modules','arcane-os','runtime','arcane','css','theme.css'
        ),
        'tampered\n'
    );

    const instance=await startDevServer({workspaceRoot,host:'127.0.0.1',port:0});
    t.after(()=>instance.close());
    const response=await request(instance.origin,'/arcane/css/theme.css');
    assert.equal(response.status,200);
    assert.doesNotMatch(await response.text(),/^tampered$/m);
});

test('server startup callback rejection closes the listener before rejection',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-event-start-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'event-start'});
    await installRuntime(workspaceRoot);
    const port=await availablePort();
    const callbackFailure=new Error('Server event sink rejected startup.');

    await assert.rejects(
        startDevServer({
            workspaceRoot,
            appId:'event-start',
            host:'127.0.0.1',
            port,
            onEvent:event=>{
                if(event.type==='server.started'){
                    throw callbackFailure;
                }
            }
        }),
        error=>error===callbackFailure
    );
    await assertPortCanBeReused(port);
});

test('server close drains stopped delivery and propagates its first rejection',async t=>{
    useSyntheticTls(t);
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-event-stop-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'event-stop'});
    await installRuntime(workspaceRoot);
    const callbackFailure=new Error('Server event sink rejected shutdown.');
    let stoppedCalls=0;
    let releaseStopped;
    const stoppedGate=new Promise(resolve=>{
        releaseStopped=resolve;
    });
    let markStoppedStarted;
    const stoppedStarted=new Promise(resolve=>{
        markStoppedStarted=resolve;
    });
    const instance=await startDevServer({
        workspaceRoot,
        appId:'event-stop',
        host:'127.0.0.1',
        port:0,
        onEvent:async event=>{
            if(event.type==='server.stopped'){
                stoppedCalls+=1;
                markStoppedStarted();
                await stoppedGate;
                throw callbackFailure;
            }
        }
    });
    t.after(async()=>{
        releaseStopped();
        await instance.close().catch(()=>{});
    });

    const closing=instance.close();
    let settled=false;
    void closing.then(()=>{settled=true;},()=>{settled=true;});
    await stoppedStarted;
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false);
    releaseStopped();
    await assert.rejects(closing,error=>error===callbackFailure);
    await assert.rejects(instance.lifecycle,error=>error===callbackFailure);
    assert.equal(stoppedCalls,1);
});
