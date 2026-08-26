import assert from 'node:assert/strict';
import {
    copyFile,
    cp,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {
    ARCANE_MACHINE_BUNDLE_VERSION,
    ARCANE_UPSTREAM_COMMIT,
    ARCANE_UPSTREAM_REPOSITORY,
    SDK_VERSION
} from '../src/constants.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';
import {
    authenticateRuntimeReceipt,
    readVerifiedRuntimeFile,
    verifyRuntime
} from '../src/runtime.mjs';
import {
    authenticateSdkBrowserRuntimeReceipt,
    verifySdkBrowserRuntime
} from '../src/sdk-browser-runtime.mjs';
import {
    authenticateWorkspaceRuntimeReceipt,
    materializeWorkspaceRuntime,
    verifyWorkspaceRuntime
} from '../src/workspace-runtime.mjs';

async function verifiedRuntimeCopy(t,prefix){
    const temporary=await temporaryDirectory(t,{prefix});
    const runtimeRoot=path.join(temporary,'runtime');
    await cp(path.join(repositoryRoot,'runtime'),runtimeRoot,{recursive:true});
    const receipt=await verifyRuntime({runtimeRoot});
    return {temporary,runtimeRoot,receipt};
}

async function browserRuntimePackageCopy(t,prefix='arcane-sdk-browser-'){
    const packageRoot=await temporaryDirectory(t,{prefix});
    await cp(path.join(repositoryRoot,'browser-runtime'),path.join(packageRoot,'browser-runtime'),{
        recursive:true
    });
    for(const relative of ['event-manager.mjs','dom-event-instrumentation.mjs']){
        const destination=path.join(packageRoot,'src',relative);
        await mkdir(path.dirname(destination),{recursive:true});
        await copyFile(path.join(repositoryRoot,'src',relative),destination);
    }
    for(const dependency of ['event-pubsub','strong-type']){
        const destination=path.join(packageRoot,'node_modules',dependency);
        await mkdir(destination,{recursive:true});
        for(const relative of ['index.js','licence','package.json']){
            await copyFile(
                path.join(repositoryRoot,'node_modules',dependency,relative),
                path.join(destination,relative)
            );
        }
    }
    await cp(
        path.join(repositoryRoot,'node_modules','@wllama','wllama'),
        path.join(packageRoot,'node_modules','@wllama','wllama'),
        {recursive:true}
    );
    return {packageRoot,browserRuntimeRoot:path.join(packageRoot,'browser-runtime')};
}

function selectedReceiptFile(receipt){
    return receipt.files.find(file=>file.bytes>0)??receipt.files[0];
}

test('bundled Arcane runtime matches its immutable release manifest',async()=>{
    const events=[];
    const receipt=await verifyRuntime({onEvent:event=>events.push(event)});
    const manifest=JSON.parse(await readFile(path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json'),'utf8'));

    assert.equal(receipt.contentSha256,manifest.contentSha256);
    assert.equal(receipt.fileCount,manifest.fileCount);
    assert.equal(receipt.totalBytes,manifest.totalBytes);
    assert.deepEqual(receipt.files,manifest.files);
    assert.ok(Object.isFrozen(receipt));
    assert.ok(Object.isFrozen(receipt.rootIdentity));
    assert.ok(Object.isFrozen(receipt.files));
    assert.ok(Object.isFrozen(receipt.files[0]));
    assert.throws(()=>receipt.files.push({}),TypeError);
    assert.equal(await authenticateRuntimeReceipt(receipt),receipt);
    const selected=selectedReceiptFile(receipt);
    assert.deepEqual(
        await readVerifiedRuntimeFile(receipt,{relativePath:selected.path}),
        await readFile(path.join(repositoryRoot,'runtime',...selected.path.split('/')))
    );
    await assert.rejects(
        readVerifiedRuntimeFile({...receipt},{relativePath:selected.path}),
        /not issued/i
    );
    assert.equal(events.at(0).type,'runtime.verify.started');
    assert.equal(events.at(-1).type,'runtime.verify.completed');
    assert.equal(events.filter(event=>event.type==='runtime.verify.progress').length,manifest.fileCount);
});

test('runtime provenance and shared network-policy closure are complete',async()=>{
    const manifest=JSON.parse(await readFile(
        path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json'),
        'utf8'
    ));
    const sourceConfig=JSON.parse(await readFile(
        path.join(repositoryRoot,'tools','runtime-source.json'),
        'utf8'
    ));
    assert.equal(manifest.sdkVersion,SDK_VERSION);
    assert.deepEqual(manifest.source,{
        authority:'sdk-canonical',
        repository:'https://github.com/TheWizardNexus/arcane-os-sdk.git',
        path:'runtime/arcane',
        protocol:'arcane/1',
        legacyProjection:{
            repository:ARCANE_UPSTREAM_REPOSITORY,
            commit:ARCANE_UPSTREAM_COMMIT,
            bundleVersion:ARCANE_MACHINE_BUNDLE_VERSION
        }
    });
    assert.deepEqual(sourceConfig.runtimeDirectories,[
        'components','css','entities','img','modules','security'
    ]);
    assert.deepEqual(sourceConfig.authority,{
        kind:manifest.source.authority,
        repository:manifest.source.repository,
        path:manifest.source.path,
        protocol:manifest.source.protocol
    });
    assert.deepEqual(sourceConfig.legacyProjection,manifest.source.legacyProjection);
    const paths=new Set(manifest.files.map(file=>file.path));
    assert.ok(paths.has('arcane/modules/ArcaneNetworkPolicy.js'));
    assert.ok(paths.has('arcane/modules/ScamRiskPolicy.js'));
    assert.ok(paths.has('arcane/security/arcane-network-policy.json'));

    const networkPolicy={
        schemaVersion:1,
        generation:2,
        domainRules:[{
            id:'blocked-domain',
            domain:'blocked.example',
            reason:{code:'test',title:'Blocked',description:'Test policy.'},
            source:{id:'test',label:'Test',reference:null}
        }],
        networkRules:[]
    };
    const {loadScamNetworkPolicy,assessScamRisk}=await import(
        '../runtime/arcane/modules/ScamRiskPolicy.js'
    );
    await loadScamNetworkPolicy({
        fetchImpl:async()=>({ok:true,json:async()=>networkPolicy})
    });
    assert.ok(assessScamRisk('Visit https://blocked.example now.').matches.some(
        match=>match.id==='blocked-domain'
    ));
});

test('runtime receipt rejects an added unverified file',async t=>{
    const {runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-added-');
    await writeFile(
        path.join(runtimeRoot,'arcane','modules','unexpected-runtime-file.js'),
        'unverified\n'
    );
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/inventory changed/.test(error.message)
    );
});

test('runtime receipt rejects a deleted verified file',async t=>{
    const {runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-deleted-');
    const selected=selectedReceiptFile(receipt);
    await rm(path.join(runtimeRoot,...selected.path.split('/')));
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/inventory changed/.test(error.message)
    );
});

test('runtime receipt rejects changed bytes without rehashing',async t=>{
    const {runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-changed-');
    const selected=selectedReceiptFile(receipt);
    const selectedPath=path.join(runtimeRoot,...selected.path.split('/'));
    const bytes=await readFile(selectedPath);
    bytes[0]^=0xff;
    await writeFile(selectedPath,bytes);
    await assert.rejects(
        readVerifiedRuntimeFile(receipt,{runtimeRoot,relativePath:selected.path}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/changed|hash/.test(error.message)
    );
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/file changed/.test(error.message)
    );
});

test('runtime receipt rejects a linked runtime subtree',async t=>{
    const {temporary,runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-link-');
    const linkedPath=path.join(runtimeRoot,'arcane','css');
    const targetPath=path.join(temporary,'linked-css-target');
    await rename(linkedPath,targetPath);
    await symlink(targetPath,linkedPath,'junction');
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/symbolic link|junction/.test(error.message)
    );
});

test('runtime receipt rejects replacement of its canonical root',async t=>{
    const {temporary,runtimeRoot,receipt}=await verifiedRuntimeCopy(t,'arcane-runtime-root-');
    await rename(runtimeRoot,path.join(temporary,'original-runtime'));
    await cp(path.join(repositoryRoot,'runtime'),runtimeRoot,{recursive:true});
    await assert.rejects(
        authenticateRuntimeReceipt(receipt,{runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/root changed/.test(error.message)
    );
});

test('runtime verification rejects changed bytes without mutating the SDK copy',async t=>{
    const temporary=await temporaryDirectory(t);
    const runtimeRoot=path.join(temporary,'runtime');
    await mkdir(runtimeRoot);
    await copyFile(
        path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json'),
        path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json')
    );
    const release=JSON.parse(await readFile(path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json'),'utf8'));
    const selected=release.files.find(file=>file.path.endsWith('.json'))??release.files[0];
    const source=path.join(repositoryRoot,'runtime',...selected.path.split('/'));
    const destination=path.join(runtimeRoot,...selected.path.split('/'));
    await mkdir(path.dirname(destination),{recursive:true});
    await cp(source,destination);
    await writeFile(destination,Buffer.alloc(selected.bytes,0x61));

    release.files=[selected];
    release.fileCount=1;
    release.totalBytes=selected.bytes;
    const {createHash}=await import('node:crypto');
    release.contentSha256=createHash('sha256').update(JSON.stringify(release.files)).digest('hex');
    await writeFile(
        path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json'),
        `${JSON.stringify(release,null,2)}\n`
    );

    await assert.rejects(
        verifyRuntime({runtimeRoot}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'&&/integrity check failed/.test(error.message)
    );
});

test('SDK browser receipt authenticates its exact package sources and rejects later drift',async t=>{
    const attributes=(await readFile(path.join(repositoryRoot,'.gitattributes'),'utf8'))
        .trim().split(/\r?\n/u);
    assert.ok(attributes.includes('browser-runtime/** -text -whitespace'));
    assert.equal(attributes.at(-1),'runtime/** -text -whitespace');
    const {packageRoot,browserRuntimeRoot}=await browserRuntimePackageCopy(t);
    const receipt=await verifySdkBrowserRuntime({browserRuntimeRoot});
    assert.equal(receipt.fileCount,25);
    assert.equal(receipt.sourceIdentities.length,22);
    assert.equal(
        await authenticateSdkBrowserRuntimeReceipt(receipt,{browserRuntimeRoot}),
        receipt
    );
    await writeFile(path.join(packageRoot,'src','event-manager.mjs'),'export default null;\n');
    await assert.rejects(
        authenticateSdkBrowserRuntimeReceipt(receipt,{browserRuntimeRoot}),
        error=>error?.code==='ARCANE_SDK_BROWSER_INTEGRITY_FAILED'
            &&/package source changed|file changed/u.test(error.message)
    );
});

test('SDK browser verification rejects missing, extra, and tampered closure files',async t=>{
    for(const mode of ['missing','extra','tampered']){
        const {browserRuntimeRoot}=await browserRuntimePackageCopy(t,`arcane-sdk-browser-${mode}-`);
        if(mode==='missing'){
            await rm(path.join(browserRuntimeRoot,'event-manager.mjs'));
        }else if(mode==='extra'){
            await writeFile(path.join(browserRuntimeRoot,'unexpected.js'),'export default true;\n');
        }else{
            await writeFile(path.join(browserRuntimeRoot,'event-manager.mjs'),'export default null;\n');
        }
        await assert.rejects(
            verifySdkBrowserRuntime({browserRuntimeRoot}),
            error=>error?.code==='ARCANE_SDK_BROWSER_INTEGRITY_FAILED'
                &&/inventory|integrity|unexpected|changed|does not match/u.test(error.message),
            mode
        );
    }
});

test('SDK browser verification rejects manifest source, dependency, and sourcePath drift',async t=>{
    for(const mode of ['source','dependency','sourcePath']){
        const {browserRuntimeRoot}=await browserRuntimePackageCopy(t,`arcane-sdk-browser-${mode}-`);
        const manifestPath=path.join(browserRuntimeRoot,'ARCANE_SDK_BROWSER_RELEASE.json');
        const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
        if(mode==='source')manifest.source.authority='consumer';
        if(mode==='dependency')manifest.source.dependencies[0].integrity='sha512-forged';
        if(mode==='sourcePath')manifest.files[0].sourcePath='node_modules/strong-type/index.js';
        await writeFile(manifestPath,`${JSON.stringify(manifest,null,2)}\n`);
        await assert.rejects(
            verifySdkBrowserRuntime({browserRuntimeRoot}),
            error=>error?.code==='ARCANE_SDK_BROWSER_INTEGRITY_FAILED'
                &&/source authority|dependency identity|inventory/u.test(error.message),
            mode
        );
    }
});

test('SDK browser verification pins the exact receipt bytes, not only its JSON meaning',async t=>{
    const {browserRuntimeRoot}=await browserRuntimePackageCopy(t,'arcane-sdk-browser-manifest-bytes-');
    const manifestPath=path.join(browserRuntimeRoot,'ARCANE_SDK_BROWSER_RELEASE.json');
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    await writeFile(manifestPath,JSON.stringify(manifest));
    await assert.rejects(
        verifySdkBrowserRuntime({browserRuntimeRoot}),
        error=>error?.code==='ARCANE_SDK_BROWSER_INTEGRITY_FAILED'
            &&/manifest bytes/u.test(error.message)
    );
});

test('composed workspace receipt rejects tampered projected SDK browser bytes',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-composed-runtime-'});
    const runtimeReceipt=await verifyRuntime();
    const sdkBrowserRuntimeReceipt=await verifySdkBrowserRuntime();
    const receipt=await materializeWorkspaceRuntime({
        workspaceRoot,
        runtimeRoot:runtimeReceipt.canonicalLocation,
        runtimeReceipt,
        browserRuntimeRoot:sdkBrowserRuntimeReceipt.canonicalLocation,
        sdkBrowserRuntimeReceipt
    });
    assert.equal(receipt.fileCount,185);
    assert.equal(receipt.sources.arcane.authority,'arcane-os-sdk');
    assert.equal(receipt.sources.arcane.contentSha256,runtimeReceipt.contentSha256);
    assert.equal(
        receipt.sources.sdkBrowser.contentSha256,
        sdkBrowserRuntimeReceipt.contentSha256
    );
    await writeFile(
        path.join(workspaceRoot,'arcane','sdk','event-manager.mjs'),
        'export default null;\n'
    );
    await assert.rejects(
        authenticateWorkspaceRuntimeReceipt(receipt,{workspaceRoot}),
        error=>error?.code==='ARCANE_WORKSPACE_RUNTIME_INTEGRITY_FAILED'
            &&/changed/u.test(error.message)
    );
    await assert.rejects(
        verifyWorkspaceRuntime({
            workspaceRoot,
            runtimeRoot:runtimeReceipt.canonicalLocation,
            runtimeReceipt,
            browserRuntimeRoot:sdkBrowserRuntimeReceipt.canonicalLocation,
            sdkBrowserRuntimeReceipt
        }),
        error=>error?.code==='ARCANE_WORKSPACE_RUNTIME_INTEGRITY_FAILED'
            &&/size|integrity/u.test(error.message)
    );
});

test('workspace runtime materialization buffers callbacks and authenticates cleanup paths',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-runtime-callback-workspace-'});
    const outsideRoot=await temporaryDirectory(t,{prefix:'arcane-runtime-callback-outside-'});
    const sentinelPath=path.join(outsideRoot,'sentinel.txt');
    const sentinelBytes='outside runtime sentinel\n';
    await writeFile(sentinelPath,sentinelBytes);
    const runtimeReceipt=await verifyRuntime();
    const sdkBrowserRuntimeReceipt=await verifySdkBrowserRuntime();
    let attacked=false;
    let stagingRoot;
    let linkedModules;

    await assert.rejects(
        materializeWorkspaceRuntime({
            workspaceRoot,
            runtimeRoot:runtimeReceipt.canonicalLocation,
            runtimeReceipt,
            browserRuntimeRoot:sdkBrowserRuntimeReceipt.canonicalLocation,
            sdkBrowserRuntimeReceipt,
            onEvent:async event=>{
                if(attacked||event.type!=='workspace.runtime.materialize.progress')return;
                const stagingEntry=(await readdir(workspaceRoot,{withFileTypes:true}))
                    .find(entry=>entry.name.startsWith('.arcane-runtime-stage-'));
                assert.ok(stagingEntry?.isDirectory());
                stagingRoot=path.join(workspaceRoot,stagingEntry.name);
                linkedModules=path.join(stagingRoot,'modules');
                const displacedModules=path.join(stagingRoot,'modules.authenticated');
                try{await rename(linkedModules,displacedModules);}
                catch(error){
                    if(error?.code!=='ENOENT')throw error;
                }
                await symlink(
                    outsideRoot,
                    linkedModules,
                    process.platform==='win32'?'junction':'dir'
                );
                attacked=true;
            }
        }),
        error=>error?.code==='ARCANE_WORKSPACE_RUNTIME_INTEGRITY_FAILED'
            &&/Refusing to clean an unauthenticated workspace runtime staging tree/u
                .test(error.message)
            &&/symbolic link|junction/u.test(error.message)
    );

    assert.equal(attacked,true);
    assert.equal(await readFile(sentinelPath,'utf8'),sentinelBytes);
    assert.deepEqual(await readdir(outsideRoot),['sentinel.txt']);
    await assert.rejects(
        lstat(path.join(workspaceRoot,'arcane')),
        error=>error?.code==='ENOENT'
    );
    assert.equal((await lstat(linkedModules)).isSymbolicLink(),true);

    await rm(linkedModules,{recursive:true,force:true});
    await rm(stagingRoot,{recursive:true,force:true});
});
