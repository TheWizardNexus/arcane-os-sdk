import assert from 'node:assert/strict';
import {cp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {getTargetAdapter,listTargets} from '../src/targets/index.mjs';
import {
    fetchSyntheticTls,repositoryRoot,temporaryDirectory,useSyntheticTls,writeSyntheticTlsFiles
} from './helpers.mjs';

test(
    'browser run preserves TLS inputs and the selected HTTP redirect port',
    async function browserRunTlsOptions(context) {
        const fixture = useSyntheticTls(context);
        const workspaceRoot = await temporaryDirectory(context, {prefix: 'arcane-browser-tls-'});
        const appId = 'tls-preview';
        const releaseRoot = path.join(workspaceRoot, 'dist', appId);
        await mkdir(releaseRoot, {recursive: true});
        const content = '  Complete packaged preview content.\nSecond line.  ';
        await writeFile(path.join(releaseRoot, 'index.html'), content);
        await writeSyntheticTlsFiles(workspaceRoot);
        const selected = await writeSyntheticTlsFiles(
            workspaceRoot,
            {certPath: 'selected/cert.pem', keyPath: 'selected/key.pem'}
        );
        await writeFile(selected.certPath, 'Selected synthetic certificate input.');
        await writeFile(selected.keyPath, 'Selected synthetic key input.');
        const tls = {
            cert: ['Raw synthetic certificate input.'],
            key: 'Raw synthetic key input.',
            SNICallback: function selectSyntheticContext() {}
        };
        let httpPort = 0;
        for (const options of [{}, selected, {tls}]) {
            const instance = await getTargetAdapter('browser').run(
                {workspaceRoot, appId, host: '127.0.0.1', port: 0, httpPort, ...options}
            );
            context.after(
                async function closeSyntheticBrowserPreview() {
                    await instance.close();
                }
            );
            assert.equal(instance.protocol, 'https:');
            assert.equal(instance.origin, `https://127.0.0.1:${instance.port}`);
            assert.equal(instance.url, `${instance.origin}/index.html`);
            if (httpPort !== 0) assert.equal(instance.httpPort, httpPort);
            assert.ok(instance.httpPort > 0);
            assert.equal(instance.httpOrigin, `http://127.0.0.1:${instance.httpPort}`);
            assert.equal(instance.httpUrl, `${instance.httpOrigin}/index.html`);
            assert.equal(instance.releaseRoot, releaseRoot);
            if (options.tls) {
                assert.equal(fixture.options.at(-1), tls);
            } else {
                assert.equal(
                    fixture.options.at(-1).cert.toString(),
                    options.certPath
                        ? 'Selected synthetic certificate input.'
                        : 'Synthetic certificate input; not a certificate.'
                );
                assert.equal(
                    fixture.options.at(-1).key.toString(),
                    options.keyPath
                        ? 'Selected synthetic key input.'
                        : 'Synthetic key input; not a private key.'
                );
            }
            const response = await fetchSyntheticTls(instance.url);
            assert.equal(response.status, 200);
            assert.equal(await response.text(), content);
            const redirect = await fetch(
                `${instance.httpOrigin}/index.html?mode=a%20b`,
                {redirect: 'manual'}
            );
            assert.equal(redirect.status, 308);
            assert.equal(redirect.headers.get('location'), `${instance.origin}/index.html?mode=a%20b`);
            await instance.close();
            httpPort = instance.httpPort;
        }
    }
);

async function installSdkPayload(workspaceRoot){
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

test('target registry distinguishes browser availability from native pairing requirements',async()=>{
    const targets=listTargets();
    assert.deepEqual(
        targets.map(target=>target.id),
        ['browser','portable','windows-x64','linux-x64','linux-arm64','android-arm64']
    );
    assert.equal(targets[0].status,'available');
    assert.equal(targets[1].status,'pairing-required');
    assert.deepEqual(targets[1].signingModes,['unsigned-local-test']);
    assert.match(targets[1].reason,/--arcane-root/);
    assert.deepEqual(targets.find(target=>target.id==='windows-x64').formats,['exe']);
    assert.deepEqual(targets.find(target=>target.id==='windows-x64').signingModes,['unsigned-local-test']);
    assert.deepEqual(targets.find(target=>target.id==='linux-x64').formats,['deb']);
    assert.deepEqual(targets.find(target=>target.id==='linux-x64').signingModes,['unsigned-local-test']);
    assert.deepEqual(targets.find(target=>target.id==='linux-arm64').formats,['deb']);
    assert.deepEqual(targets.find(target=>target.id==='android-arm64').formats,['apk']);
    assert.deepEqual(targets.find(target=>target.id==='android-arm64').signingModes,['development']);
    for(const target of targets.slice(1)){
        assert.equal(target.protocol,'arcane-target-adapter/1');
        assert.ok(target.reason);
    }
    for(const target of targets){
        const adapter=getTargetAdapter(target.id);
        for(const method of target.methods)assert.equal(typeof adapter[method],'function',`${target.id}.${method}`);
    }
    assert.deepEqual(await getTargetAdapter('browser').prepare(),{
        target:'browser',status:'available',ready:true,required:false
    });
    for(const targetId of ['portable','windows-x64','linux-x64','linux-arm64','android-arm64']){
        assert.equal(targets.find(target=>target.id===targetId).status,'pairing-required');
    }
});

test('unpaired native adapters reject plan and build without producing substitute output',async()=>{
    for(const targetId of ['portable','windows-x64','linux-x64','linux-arm64','android-arm64']){
        const adapter=getTargetAdapter(targetId);
        const status=await adapter.doctor();
        assert.equal(status.status,'pairing-required');
        assert.equal(status.ready,false);
        await assert.rejects(
            adapter.plan({workspaceRoot:'ignored',appId:'ignored'}),
            error=>error?.code==='ARCANE_TARGET_DEFERRED'&&error?.details?.id===targetId
        );
        await assert.rejects(
            adapter.build({workspaceRoot:'ignored',appId:'ignored'}),
            error=>error?.code==='ARCANE_TARGET_DEFERRED'
        );
    }
});

test('unknown targets use a stable unavailable error',()=>{
    assert.throws(
        ()=>getTargetAdapter('not-a-real-target'),
        error=>error?.code==='ARCANE_TARGET_UNAVAILABLE'
    );
});

test('browser target carries a verified release receipt into packaged serving',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-browser-target-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'target-app'});
    await installSdkPayload(workspaceRoot);
    const adapter=getTargetAdapter('browser');
    const built=await adapter.build({workspaceRoot,appId:'target-app'});
    assert.equal(built.release.receipt.kind,'arcane-app-release-verification');
    const instance=await adapter.run({
        workspaceRoot,
        appId:'target-app',
        host:'127.0.0.1',
        port:0
    });
    t.after(()=>instance.close());
    assert.equal(instance.verified.verified,true);
    assert.match(instance.url,/\?arcane_session=[0-9a-f]{64}$/);
    assert.doesNotMatch(instance.cleanUrl,/arcane_session/);
});
