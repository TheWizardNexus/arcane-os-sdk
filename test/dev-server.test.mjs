import assert from 'node:assert/strict';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {startDevServer} from '../src/dev-server.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

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
    assert.equal((await request(origin,'/apps/served-app/index.html')).status,403);
    assert.equal((await requestWithHost(
        instance,
        '/apps/served-app/index.html',
        'attacker.invalid'
    )).statusCode,421);
    const {cookie}=await authorize(instance);
    const root=await request(origin,'/',{cookie});
    assert.equal(root.status,302);
    assert.equal(root.headers.get('location'),'/apps/served-app/index.html');

    const app=await request(origin,'/apps/served-app/index.html',{cookie});
    assert.equal(app.status,200);
    assert.match(app.headers.get('content-type'),/^text\/html/);
    assert.match(app.headers.get('content-security-policy'),/script-src 'self' 'unsafe-inline'/);
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
