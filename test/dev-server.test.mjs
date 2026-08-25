import assert from 'node:assert/strict';
import {cp,mkdir,readFile,realpath,symlink,writeFile} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {startDevServer} from '../src/dev-server.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {SDK_NAME,SDK_VERSION} from '../src/constants.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

const BROWSER_RUNTIME_CSP=[
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' data: blob: http: https: ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' data: blob: http: https:",
    "media-src 'self' data: blob: http: https:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ');

function assertBrowserRuntimeCsp(response){
    const policy=response.headers.get('content-security-policy');
    assert.equal(policy,BROWSER_RUNTIME_CSP);
    const scriptTokens=policy.split('; ')
        .find(directive=>directive.startsWith('script-src '))
        .split(/\s+/u)
        .slice(1);
    assert.deepEqual(scriptTokens,["'self'","'unsafe-inline'","'wasm-unsafe-eval'"]);
    assert.equal(scriptTokens.includes("'unsafe-eval'"),false);
}

async function request(origin,requestPath,options={}){
    const {cookie,...fetchOptions}=options;
    const headers=new Headers(fetchOptions.headers);
    if(cookie)headers.set('cookie',cookie);
    return fetch(`${origin}${requestPath}`,{redirect:'manual',...fetchOptions,headers});
}

async function authorize(instance){
    const launch=new URL(instance.url);
    assert.equal(launch.origin,instance.origin);
    assert.equal(instance.cleanUrl,`${instance.origin}${launch.pathname}`);
    assert.match(launch.searchParams.get('arcane_session')||'',/^[0-9a-f]{64}$/);
    const response=await fetch(instance.url,{redirect:'manual'});
    assert.equal(response.status,302);
    assert.equal(response.headers.get('location'),launch.pathname);
    assert.doesNotMatch(response.headers.get('location'),/arcane_session/);
    const cookie=response.headers.get('set-cookie')?.split(';',1)[0];
    assert.match(cookie||'',/^Arcane-Dev-Session-[0-9a-f]{16}=[0-9a-f]{64}$/);
    return {origin:instance.origin,cookie};
}

async function requestWithHost(instance,requestPath,host){
    return new Promise((resolve,reject)=>{
        const request=http.get({
            hostname:instance.host,
            port:instance.port,
            path:requestPath,
            headers:{host}
        },response=>{
            response.resume();
            response.once('end',()=>resolve(response));
        });
        request.once('error',reject);
    });
}

async function installRuntime(workspaceRoot){
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
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
        ['browser-runtime/.git/config','private vcs bytes\n'],
        ['browser-runtime/node_modules/private.js','private dependency bytes\n']
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

test('source server exposes only the selected app and SDK browser routes',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'served-app'});
    await installRuntime(workspaceRoot);
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
    const origin=`http://127.0.0.1:${instance.port}`;

    assert.ok(events.find(event=>event.type==='server.starting'));
    assert.equal(events.at(-1).type,'server.started');
    assert.equal(Object.hasOwn(instance,'runtimeMode'),false);
    assert.equal(Object.hasOwn(instance,'runtime'),false);
    assert.equal(Object.hasOwn(events[0],'runtimeMode'),false);
    assert.equal(Object.hasOwn(events.at(-1),'runtimeMode'),false);
    const unauthorized=await request(origin,'/apps/served-app/index.html');
    assert.equal(unauthorized.status,403);
    assert.equal(
        unauthorized.headers.get('content-security-policy'),
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    const misdirected=await requestWithHost(
        instance,
        '/apps/served-app/index.html',
        'attacker.invalid'
    );
    assert.equal(misdirected.statusCode,421);
    assert.equal(
        misdirected.headers['content-security-policy'],
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
    );
    const {cookie}=await authorize(instance);
    const root=await request(origin,'/',{cookie});
    assert.equal(root.status,302);
    assert.equal(root.headers.get('location'),'/apps/served-app/index.html');

    const app=await request(origin,'/apps/served-app/index.html',{cookie});
    assert.equal(app.status,200);
    assert.match(app.headers.get('content-type'),/^text\/html/);
    assertBrowserRuntimeCsp(app);
    assert.match(app.headers.get('content-security-policy'),/connect-src[^;]*http:/);
    assert.equal(app.headers.get('cross-origin-resource-policy'),'same-origin');
    assert.match(await app.text(),/<meta name="arcane-app-id" content="served-app">/);

    const theme=await request(origin,'/arcane/css/theme.css',{cookie});
    assert.equal(theme.status,200);
    assert.match(theme.headers.get('content-type'),/^text\/css/);

    const networkPolicy=await request(origin,'/arcane/security/arcane-network-policy.json',{cookie});
    assert.equal(networkPolicy.status,200);
    assert.match(networkPolicy.headers.get('content-type'),/^application\/json/);
    assert.equal((await networkPolicy.json()).schemaVersion,1);

    const strongType=await request(origin,'/arcane/dependencies/strong-type/index.js',{cookie});
    assert.equal(strongType.status,200);
    assert.match(strongType.headers.get('content-type'),/^text\/javascript/);
    assert.equal(
        (await request(origin,'/node_modules/strong-type/index.js',{cookie})).status,
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
        const response=await request(origin,deniedPath,{cookie});
        assert.ok([400,404].includes(response.status),`${deniedPath} returned ${response.status}`);
    }

    const post=await request(origin,'/apps/served-app/index.html',{method:'POST',cookie});
    assert.equal(post.status,405);

    await writeFile(
        path.join(workspaceRoot,'node_modules','arcane-os','runtime','arcane','css','theme.css'),
        'tampered runtime bytes\n'
    );
    const unchangedWorkspaceRuntime=await request(origin,'/arcane/css/theme.css',{cookie});
    assert.equal(unchangedWorkspaceRuntime.status,200);
    assert.doesNotMatch(await unchangedWorkspaceRuntime.text(),/tampered runtime bytes/);

    await writeFile(
        path.join(workspaceRoot,'arcane','css','theme.css'),
        'tampered workspace runtime bytes\n'
    );
    const changedRuntime=await request(origin,'/arcane/css/theme.css',{cookie});
    assert.equal(changedRuntime.status,500);
    assert.doesNotMatch(await changedRuntime.text(),/tampered workspace runtime bytes/);
});

test('explicit SDK runtime source mount is live, narrow, and observable',async t=>{
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
        sdkVersion:SDK_VERSION,
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

    const {origin,cookie}=await authorize(instance);
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
        const response=await request(origin,allowedPath,{cookie});
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
        const response=await request(origin,deniedPath,{cookie});
        assert.equal(response.status,404,deniedPath);
        await response.text();
    }

    const themePath=path.join(sourceRoot,'runtime','arcane','css','theme.css');
    const initialTheme=await request(origin,'/arcane/css/theme.css',{cookie});
    assert.match(await initialTheme.text(),/live-source:initial/u);
    await writeFile(themePath,':root{--live-source:refreshed;}\n');
    const refreshedTheme=await request(origin,'/arcane/css/theme.css',{cookie});
    assert.equal(refreshedTheme.status,200);
    assert.match(await refreshedTheme.text(),/live-source:refreshed/u);

    await instance.close();
    assert.equal(events.at(-2).type,'runtime.source.mount.stopped');
    assert.equal(events.at(-2).reason,'closed');
    assert.equal(events.at(-1).type,'server.stopped');
});

test('explicit SDK runtime source mount rejects drift, overlap, and linked roots',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-sdk-source-policy-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'source-policy-app'});
    await installRuntime(workspaceRoot);

    const mismatchRoot=await createSdkRuntimeSource(parent,{
        directory:'version-mismatch',
        version:'999.0.0'
    });
    await assert.rejects(
        startDevServer({
            workspaceRoot,
            appId:'source-policy-app',
            sdkRuntimeSourceRoot:mismatchRoot,
            host:'127.0.0.1',
            port:0
        }),
        function isVersionMismatch(error){
            return error?.code==='ARCANE_DEV_RUNTIME_VERSION_MISMATCH';
        }
    );

    const wrongPackageRoot=await createSdkRuntimeSource(parent,{
        directory:'wrong-package',
        packageName:'not-arcane-os'
    });
    await assert.rejects(
        startDevServer({
            workspaceRoot,
            appId:'source-policy-app',
            sdkRuntimeSourceRoot:wrongPackageRoot,
            host:'127.0.0.1',
            port:0
        }),
        function isInvalidPackage(error){
            return error?.code==='ARCANE_DEV_RUNTIME_SOURCE_INVALID';
        }
    );

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

test('packaged server redirects to index and withholds its integrity receipt',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-packaged-server-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'packaged-app'});
    await installRuntime(workspaceRoot);
    const release=await packageApp({workspaceRoot,appId:'packaged-app'});
    const releaseRoot=path.join(workspaceRoot,'dist','packaged-app');
    await assert.rejects(
        startDevServer({mode:'packaged',releaseRoot,host:'127.0.0.1',port:0}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    const instance=await startDevServer({
        mode:'packaged',
        releaseRoot,
        releaseReceipt:release.receipt,
        host:'127.0.0.1',
        port:0
    });
    t.after(()=>instance.close());
    const {origin,cookie}=await authorize(instance);

    const root=await request(origin,'/',{cookie});
    assert.equal(root.status,302);
    assert.equal(root.headers.get('location'),'/index.html');
    const entry=await request(origin,'/index.html',{cookie});
    assert.equal(entry.status,200);
    assertBrowserRuntimeCsp(entry);
    assert.match(await entry.text(),/Packaged App/);
    const receipt=await request(origin,'/ARCANE_APP_RELEASE.json',{cookie});
    assert.equal(receipt.status,404);
    const receiptCaseVariant=await request(origin,'/arcane_app_release.JSON',{cookie});
    assert.equal(receiptCaseVariant.status,404);

    await writeFile(path.join(releaseRoot,'index.html'),'tampered\n');
    const changedRelease=await request(origin,'/index.html',{cookie});
    assert.equal(changedRelease.status,500);
    assert.doesNotMatch(await changedRelease.text(),/^tampered$/m);
    await instance.close();
    await assert.rejects(
        startDevServer({
            mode:'packaged',
            releaseRoot,
            releaseReceipt:release.receipt,
            host:'127.0.0.1',
            port:0
        }),
        /changed|receipt|inventory/i
    );
});

test('development server refuses non-loopback binding',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-server-policy-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'loopback-only'});
    await assert.rejects(
        startDevServer({workspaceRoot,host:'0.0.0.0'}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
    await assert.rejects(
        startDevServer({workspaceRoot,host:'localhost'}),
        error=>error?.code==='ARCANE_POLICY_DENIED'
    );
});

test('source server verifies the workspace-installed runtime, not a global SDK copy',async t=>{
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

    await assert.rejects(
        startDevServer({workspaceRoot,host:'127.0.0.1',port:0}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );
});

test('server startup callback rejection closes the listener before rejection',async t=>{
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
