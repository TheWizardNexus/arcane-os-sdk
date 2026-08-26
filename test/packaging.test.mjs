import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp,lstat,mkdir,readFile,readdir,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {SDK_NAME,SDK_VERSION} from '../src/constants.mjs';
import {verifyRuntime} from '../src/runtime.mjs';
import {verifySdkBrowserRuntime} from '../src/sdk-browser-runtime.mjs';
import {verifyWorkspaceRuntime} from '../src/workspace-runtime.mjs';
import {validateWorkspace} from '../src/workspace.mjs';
import {
    authenticateAppReleaseReceipt,
    normalizeRelativePath,
    packageApp,
    readVerifiedAppReleaseFile,
    verifyApp
} from '../src/packager/core.mjs';
import {
    buildApplication,
    bundleApplication,
    createToolchain,
    executeOperation,
    packageApplication,
    runApplication,
    verifyApplication
} from '../src/toolchain.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

const RUNTIME_AUTHORITIES_NAME='ARCANE_RUNTIME_AUTHORITIES.json';
const RUNTIME_PROJECTION_NAME='ARCANE_RUNTIME_PROJECTION.json';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`);
}

async function createExternalFixture(root){
    await writeJson(path.join(root,'arcane-packager.json'),{
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
    });

    const appRoot=path.join(root,'apps','fixture-app');
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:'fixture-app',
        displayName:'Fixture App',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        security:{
            connectOrigins:['https://api.example.com'],
            frameOrigins:[],
            mediaOrigins:[]
        },
        include:['fixture-app.css','index.html','manifest.json','modules'],
        exclude:[],
        shared:['browser-runtime']
    });
    await writeJson(path.join(appRoot,'manifest.json'),{
        name:'Fixture App',
        start_url:'./index.html',
        display:'standalone',
        icons:[]
    });
    await writeFile(path.join(appRoot,'index.html'),'<!doctype html><title>Fixture App</title>\n');
    await writeFile(path.join(appRoot,'fixture-app.css'),'body { color: rgb(240, 240, 240); }\n');
    await mkdir(path.join(appRoot,'modules'));
    await writeFile(path.join(appRoot,'modules','App.js'),'export const ready=true;\n');
    await writeFile(path.join(appRoot,'modules','z.js'),'export const latin=true;\n');
    await writeFile(path.join(appRoot,'modules','é.js'),'export const accented=true;\n');

    const arcaneRoot=path.join(root,'arcane');
    for(const directory of ['components','css','entities','img','modules','sdk','security']){
        await mkdir(path.join(arcaneRoot,directory),{recursive:true});
        await writeFile(path.join(arcaneRoot,directory,'fixture.txt'),`${directory}\n`);
    }
    const strongTypeRoot=path.join(arcaneRoot,'dependencies','strong-type');
    await mkdir(strongTypeRoot,{recursive:true});
    await writeFile(path.join(strongTypeRoot,'index.js'),'export const type=value=>value;\n');
    await writeFile(path.join(strongTypeRoot,'licence'),'MIT\n');
    await writeJson(path.join(strongTypeRoot,'package.json'),{
        name:'strong-type',
        version:'0.0.0-test',
        type:'module'
    });
}

test('packager rejects Windows device aliases and unsafe filename characters',()=>{
    for(const filePath of [
        'CLOCK$',
        'assets/CONIN$.json',
        'CONOUT$/child.js',
        'models/COM¹.modelfile',
        'devices/lpt²/value.json',
        'assets/less<than.js',
        'assets/greater>than.js',
        'assets/double"quote.js',
        'assets/vertical|bar.js',
        'assets/question?mark.js',
        'assets/asterisk*.js'
    ]){
        assert.throws(()=>normalizeRelativePath(filePath,'portable path'),/Unsafe portable path/u);
    }
});

async function snapshotRelease(workspaceRoot){
    const releaseRoot=path.join(workspaceRoot,'dist','fixture-app');
    const manifest=await readFile(path.join(releaseRoot,'ARCANE_APP_RELEASE.json'),'utf8');
    const entry=await readFile(path.join(releaseRoot,'apps','fixture-app','index.html'),'utf8');
    return {manifest,entry};
}

async function installSdkRuntime(workspaceRoot,dependencyName=SDK_NAME){
    const installedRoot=path.join(workspaceRoot,'node_modules',...dependencyName.split('/'));
    await mkdir(path.join(installedRoot,'src'),{recursive:true});
    await Promise.all([
        cp(
            path.join(repositoryRoot,'runtime'),
            path.join(installedRoot,'runtime'),
            {recursive:true}
        ),
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
    for(const license of ['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']){
        await cp(path.join(repositoryRoot,license),path.join(installedRoot,license));
    }
}

async function configureSdkAlias(workspaceRoot,dependencyName='arcane-sdk'){
    const packagePath=path.join(workspaceRoot,'package.json');
    const packageDocument=JSON.parse(await readFile(packagePath,'utf8'));
    delete packageDocument.devDependencies[SDK_NAME];
    packageDocument.devDependencies[dependencyName]=`npm:${SDK_NAME}@${SDK_VERSION}`;
    await writeJson(packagePath,packageDocument);

    const packageSource=`node_modules/${dependencyName}`;
    const rootConfigPath=path.join(workspaceRoot,'arcane-packager.json');
    const rootConfig=JSON.parse(await readFile(rootConfigPath,'utf8'));
    rootConfig.sharedPayloads['browser-runtime'][1].source=packageSource;
    await writeJson(rootConfigPath,rootConfig);

    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    const lock=JSON.parse(await readFile(lockPath,'utf8'));
    lock.runtime.manifest=`${packageSource}/runtime/ARCANE_RUNTIME_RELEASE.json`;
    lock.sdkBrowserRuntime.manifest=
        `${packageSource}/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json`;
    await writeJson(lockPath,lock);
}

async function authenticatedWorkspace(t,{prefix,appId}){
    const parent=await temporaryDirectory(t,{prefix});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId});
    await installSdkRuntime(workspaceRoot);
    return workspaceRoot;
}

async function issueRuntimeVerificationState(workspaceRoot){
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    const runtimeRoot=path.join(installedRoot,'runtime');
    const browserRuntimeRoot=path.join(installedRoot,'browser-runtime');
    const [runtimeReceipt,sdkBrowserRuntimeReceipt]=await Promise.all([
        verifyRuntime({runtimeRoot}),
        verifySdkBrowserRuntime({browserRuntimeRoot})
    ]);
    const workspaceRuntimeReceipt=await verifyWorkspaceRuntime({
        workspaceRoot,
        runtimeRoot,
        runtimeReceipt,
        browserRuntimeRoot,
        sdkBrowserRuntimeReceipt
    });
    return Object.freeze({runtimeReceipt,sdkBrowserRuntimeReceipt,workspaceRuntimeReceipt});
}

function delay(milliseconds){
    return new Promise(resolve=>setTimeout(resolve,milliseconds));
}

function managedInlineMap(source){
    const match=source.match(
        /<script\b[^>]*\bdata-arcane-import-map\b[^>]*>([\s\S]*?)<\/script\s*>/iu
    );
    assert.ok(match,'managed Arcane import map must be present');
    return JSON.parse(match[1]);
}

function replaceManagedInlineMap(source,value){
    const pattern=/(<script\b[^>]*\bdata-arcane-import-map\b[^>]*>)[\s\S]*?(<\/script\s*>)/iu;
    assert.match(source,pattern);
    return source.replace(pattern,(_match,start,end)=>{
        return `${start}\n${JSON.stringify(value,null,2)}\n    ${end}`;
    });
}

async function rewriteReleaseInventory(releaseRoot,mutate){
    const manifestPath=path.join(releaseRoot,'ARCANE_APP_RELEASE.json');
    const release=JSON.parse(await readFile(manifestPath,'utf8'));
    await mutate(release);
    release.fileCount=release.files.length;
    release.totalBytes=release.files.reduce((total,file)=>total+file.bytes,0);
    release.contentSha256=createHash('sha256')
        .update(JSON.stringify(release.files))
        .digest('hex');
    await writeFile(manifestPath,`${JSON.stringify(release,null,2)}\n`);
}

test('external workspace packages deterministically and detects release tampering',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-external-package-'});
    await createExternalFixture(workspaceRoot);

    const first=await packageApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(first.app,'fixture-app');
    assert.match(first.contentSha256,/^[0-9a-f]{64}$/);
    assert.equal(first.receipt.kind,'arcane-app-release-verification');
    const releaseManifest=JSON.parse(await readFile(
        path.join(workspaceRoot,'dist','fixture-app','ARCANE_APP_RELEASE.json'),
        'utf8'
    ));
    assert.deepEqual(first.receipt.files,releaseManifest.files);
    const releasePaths=first.receipt.files.map(file=>file.path);
    assert.deepEqual(
        releasePaths,
        [...releasePaths].sort((left,right)=>Buffer.compare(Buffer.from(left,'utf8'),Buffer.from(right,'utf8')))
    );
    assert.ok(
        releasePaths.indexOf('apps/fixture-app/modules/z.js')
            <releasePaths.indexOf('apps/fixture-app/modules/é.js'),
        'NFC release paths must use defined UTF-8 byte order rather than locale collation'
    );
    assert.ok(releasePaths.includes('arcane/security/fixture.txt'));
    assert.ok(releasePaths.includes('arcane/dependencies/strong-type/index.js'));
    assert.equal(releasePaths.some(file=>file.startsWith('node_modules/strong-type/')),false);
    assert.ok(Object.isFrozen(first.receipt.files));
    assert.ok(Object.isFrozen(first.receipt.files[0]));
    assert.ok(Object.isFrozen(first.receipt.app));
    assert.ok(Object.isFrozen(first.receipt.app.security));
    assert.deepEqual(first.receipt.app.security,{
        connectOrigins:['https://api.example.com'],
        frameOrigins:[],
        mediaOrigins:[]
    });
    assert.ok(Object.isFrozen(first.receipt.app.localAIModelPolicy));
    assert.throws(()=>first.receipt.files.push({}),TypeError);
    const releaseRoot=path.join(workspaceRoot,'dist','fixture-app');
    assert.equal(
        await authenticateAppReleaseReceipt(first.receipt,{releaseRoot}),
        first.receipt
    );
    assert.equal(
        (await readVerifiedAppReleaseFile(first.receipt,{
            releaseRoot,
            relativePath:'apps/fixture-app/index.html'
        })).toString('utf8'),
        await readFile(path.join(releaseRoot,'apps','fixture-app','index.html'),'utf8')
    );
    await assert.rejects(
        authenticateAppReleaseReceipt({...first.receipt},{releaseRoot}),
        /not issued/i
    );
    await assert.rejects(
        readVerifiedAppReleaseFile({...first.receipt},{
            releaseRoot,
            relativePath:'apps/fixture-app/index.html'
        }),
        /not issued/i
    );
    await assert.rejects(
        readVerifiedAppReleaseFile(first.receipt,{
            releaseRoot,
            relativePath:'ARCANE_APP_RELEASE.json'
        }),
        /not in the verified/i
    );
    const verified=await verifyApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(verified.verified,true);
    assert.equal(verified.contentSha256,first.contentSha256);
    assert.equal(
        await authenticateAppReleaseReceipt(verified.receipt,{releaseRoot}),
        verified.receipt
    );

    const second=await packageApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(second.contentSha256,first.contentSha256);
    assert.equal(second.fileCount,first.fileCount);
    assert.equal(second.totalBytes,first.totalBytes);

    await assert.rejects(readFile(path.join(releaseRoot,'arcane-package.json')),{code:'ENOENT'});
    await writeFile(path.join(releaseRoot,'apps','fixture-app','index.html'),'tampered\n');
    await assert.rejects(
        readVerifiedAppReleaseFile(second.receipt,{
            releaseRoot,
            relativePath:'apps/fixture-app/index.html'
        }),
        /changed|hash|inventory/i
    );
    await assert.rejects(
        authenticateAppReleaseReceipt(second.receipt,{releaseRoot}),
        /changed|receipt|inventory/i
    );
    await assert.rejects(
        verifyApp({workspaceRoot,appId:'fixture-app'}),
        /hash|integrity|inventory|bytes|release/i
    );
});

test('workspace validation and packaging bind one exact npm alias installation authority',async t=>{
    const appId='alias-authority-app';
    const parent=await temporaryDirectory(t,{prefix:'arcane-sdk-alias-package-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId});
    await configureSdkAlias(workspaceRoot);
    await installSdkRuntime(workspaceRoot,'arcane-sdk');

    const validation=await validateWorkspace({workspaceRoot,appId});
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-sdk');
    assert.equal(validation.sdkInstallation.dependencyName,'arcane-sdk');
    assert.equal(validation.sdkInstallation.packageSource,'node_modules/arcane-sdk');
    assert.equal(validation.sdkInstallation.canonicalPackageRoot,installedRoot);
    assert.equal(validation.sdkInstallation.packageName,SDK_NAME);
    assert.equal(validation.sdkInstallation.packageVersion,SDK_VERSION);
    assert.equal(validation.sdkInstallation.runtimeRoot,path.join(installedRoot,'runtime'));
    assert.equal(
        validation.sdkInstallation.browserRuntimeRoot,
        path.join(installedRoot,'browser-runtime')
    );
    assert.equal(
        validation.sdkInstallation.runtimeManifest,
        'node_modules/arcane-sdk/runtime/ARCANE_RUNTIME_RELEASE.json'
    );
    assert.equal(
        validation.sdkInstallation.browserRuntimeManifest,
        'node_modules/arcane-sdk/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json'
    );

    const packaged=await packageApplication({workspaceRoot,appId});
    assert.equal(packaged.workspaceMode,'external');
    assert.ok(packaged.release.receipt.files.some(
        file=>file.path==='licenses/arcane-os/LICENSE'
    ));
    assert.equal(
        await readFile(path.join(workspaceRoot,'dist',appId,'licenses','arcane-os','LICENSE'),'utf8'),
        await readFile(path.join(repositoryRoot,'LICENSE'),'utf8')
    );
});

test('workspace validation rejects a linked npm-alias installation root',async t=>{
    const appId='linked-alias-app';
    const parent=await temporaryDirectory(t,{prefix:'arcane-sdk-linked-alias-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId});
    await configureSdkAlias(workspaceRoot);
    const physicalRoot=path.join(parent,'physical-sdk');
    await installSdkRuntime(physicalRoot,'arcane-sdk');
    await mkdir(path.join(workspaceRoot,'node_modules'),{recursive:true});
    await symlink(
        path.join(physicalRoot,'node_modules','arcane-sdk'),
        path.join(workspaceRoot,'node_modules','arcane-sdk'),
        process.platform==='win32'?'junction':'dir'
    );

    await assert.rejects(
        validateWorkspace({workspaceRoot,appId}),
        /must be a real directory/u
    );
});

test('authenticated external package refreshes maps and preserves both runtime authorities',async t=>{
    const appId='provenance-app';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-runtime-provenance-package-',
        appId
    });
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const mapPath=path.join(appRoot,'modules','arcane.importmap.json');
    const entryPath=path.join(appRoot,'index.html');
    const staleMap=`${JSON.stringify({imports:{}},null,2)}\n`;
    await writeFile(mapPath,staleMap);
    await writeFile(
        entryPath,
        replaceManagedInlineMap(await readFile(entryPath,'utf8'),{imports:{}})
    );
    const staleEntry=await readFile(entryPath,'utf8');

    const preview=await packageApp({workspaceRoot,appId,dryRun:true});
    assert.equal(preview.dryRun,true);
    assert.equal(await readFile(mapPath,'utf8'),staleMap);
    assert.equal(await readFile(entryPath,'utf8'),staleEntry);

    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    const runtimeRoot=path.join(installedRoot,'runtime');
    const browserRuntimeRoot=path.join(installedRoot,'browser-runtime');
    const [runtimeReceipt,sdkBrowserRuntimeReceipt]=await Promise.all([
        verifyRuntime({runtimeRoot}),
        verifySdkBrowserRuntime({browserRuntimeRoot})
    ]);
    const workspaceRuntimeReceipt=await verifyWorkspaceRuntime({
        workspaceRoot,
        runtimeRoot,
        runtimeReceipt,
        browserRuntimeRoot,
        sdkBrowserRuntimeReceipt
    });
    assert.equal((await packageApp({
        workspaceRoot,
        appId,
        dryRun:true,
        runtimeVerificationState:Object.freeze({
            runtimeReceipt,
            sdkBrowserRuntimeReceipt,
            workspaceRuntimeReceipt
        })
    })).dryRun,true);
    const alternateRuntimeParent=await temporaryDirectory(t,{
        prefix:'arcane-mixed-runtime-receipt-'
    });
    const alternateRuntimeRoot=path.join(alternateRuntimeParent,'runtime');
    await cp(runtimeRoot,alternateRuntimeRoot,{recursive:true});
    const alternateRuntimeReceipt=await verifyRuntime({runtimeRoot:alternateRuntimeRoot});
    const mixedWorkspaceRuntimeReceipt=await verifyWorkspaceRuntime({
        workspaceRoot,
        runtimeRoot:alternateRuntimeRoot,
        runtimeReceipt:alternateRuntimeReceipt,
        browserRuntimeRoot,
        sdkBrowserRuntimeReceipt
    });
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId,
            runtimeVerificationState:Object.freeze({
                runtimeReceipt,
                sdkBrowserRuntimeReceipt,
                workspaceRuntimeReceipt:mixedWorkspaceRuntimeReceipt
            })
        }),
        /not bound to the supplied source runtime receipts/u
    );
    const accessorState={};
    for(const [key,value] of Object.entries({
        runtimeReceipt,
        sdkBrowserRuntimeReceipt,
        workspaceRuntimeReceipt
    })){
        Object.defineProperty(accessorState,key,{
            enumerable:true,
            get:()=>value
        });
    }
    await assert.rejects(
        packageApp({workspaceRoot,appId,runtimeVerificationState:accessorState}),
        /fixed receipt references/u
    );

    const packageEvents=[];
    const packaged=await packageApp({
        workspaceRoot,
        appId,
        onEvent:event=>packageEvents.push(event)
    });
    assert.equal(packageEvents.filter(event=>event.type==='runtime.verify.started').length,1);
    assert.equal(
        packageEvents.filter(event=>event.type==='sdk-browser-runtime.verify.started').length,
        1
    );
    assert.equal(
        packageEvents.filter(event=>event.type==='workspace.runtime.verify.started').length,
        1
    );
    assert.equal(packaged.importMapReceipt.committed,true);
    assert.deepEqual(packaged.importMapReceipt.cleanupWarnings,[]);
    assert.equal(Object.isFrozen(packaged.importMapReceipt.cleanupWarnings),true);
    const releaseRoot=path.join(workspaceRoot,'dist',appId);
    const sourceMapBytes=await readFile(mapPath);
    const distMapBytes=await readFile(path.join(
        releaseRoot,
        'apps',
        appId,
        'modules',
        'arcane.importmap.json'
    ));
    assert.deepEqual(distMapBytes,sourceMapBytes);
    const sourceMap=JSON.parse(sourceMapBytes.toString('utf8'));
    assert.equal(Object.keys(sourceMap.imports).length,91);
    assert.equal(
        sourceMap.imports['./node_modules/strong-type/index.js'],
        './arcane/dependencies/strong-type/index.js'
    );
    assert.equal(sourceMap.imports['arcane-os/event-manager'],'./arcane/sdk/event-manager.mjs');
    assert.equal(
        sourceMap.imports['arcane-os/ai/browser-wasm'],
        './arcane/sdk/ai/browser-wasm.mjs'
    );
    assert.equal(
        sourceMap.imports['arcane-os/ai/browser-speech'],
        './arcane/sdk/ai/browser-speech.mjs'
    );
    assert.equal(
        sourceMap.imports['#arcane/persistent-ai-chat-session'],
        './arcane/modules/PersistentAIChatSession.js'
    );
    assert.equal(
        sourceMap.imports['event-pubsub'],
        './arcane/sdk/dependencies/event-pubsub/index.js'
    );
    const sourceEntryBytes=await readFile(entryPath);
    const distEntryBytes=await readFile(path.join(releaseRoot,'apps',appId,'index.html'));
    assert.deepEqual(distEntryBytes,sourceEntryBytes);
    assert.deepEqual(managedInlineMap(sourceEntryBytes.toString('utf8')),sourceMap);
    assert.deepEqual(managedInlineMap(distEntryBytes.toString('utf8')),sourceMap);

    const authorityBytes=await readFile(path.join(releaseRoot,RUNTIME_AUTHORITIES_NAME));
    const authorities=JSON.parse(authorityBytes.toString('utf8'));
    assert.deepEqual(authorities,{
        schemaVersion:1,
        kind:'arcane-app-runtime-authorities',
        sdkVersion:workspaceRuntimeReceipt.sdkVersion,
        projection:{
            fileCount:workspaceRuntimeReceipt.fileCount,
            totalBytes:workspaceRuntimeReceipt.totalBytes,
            contentSha256:workspaceRuntimeReceipt.contentSha256
        },
        sources:{
            arcane:{
                authority:workspaceRuntimeReceipt.sources.arcane.authority,
                manifestSha256:workspaceRuntimeReceipt.sources.arcane.manifestSha256,
                contentSha256:workspaceRuntimeReceipt.sources.arcane.contentSha256,
                source:workspaceRuntimeReceipt.sources.arcane.source
            },
            sdkBrowser:{
                authority:workspaceRuntimeReceipt.sources.sdkBrowser.authority,
                manifestSha256:workspaceRuntimeReceipt.sources.sdkBrowser.manifestSha256,
                contentSha256:workspaceRuntimeReceipt.sources.sdkBrowser.contentSha256,
                source:workspaceRuntimeReceipt.sources.sdkBrowser.source
            }
        }
    });
    assert.deepEqual(
        await readVerifiedAppReleaseFile(packaged.receipt,{
            releaseRoot,
            relativePath:RUNTIME_AUTHORITIES_NAME
        }),
        authorityBytes
    );
    const projectionBytes=await readFile(path.join(releaseRoot,RUNTIME_PROJECTION_NAME));
    const projection=JSON.parse(projectionBytes.toString('utf8'));
    const projectionFiles=workspaceRuntimeReceipt.files.map(file=>({
        path:file.path,
        bytes:file.bytes,
        sha256:file.sha256
    }));
    assert.deepEqual(projection,{
        schemaVersion:1,
        kind:'arcane-app-runtime-projection',
        sdkVersion:workspaceRuntimeReceipt.sdkVersion,
        pathPrefix:'arcane/',
        fileCount:projectionFiles.length,
        totalBytes:projectionFiles.reduce((total,file)=>total+file.bytes,0),
        contentSha256:createHash('sha256')
            .update(JSON.stringify(projectionFiles))
            .digest('hex'),
        files:projectionFiles
    });
    assert.deepEqual(
        {
            fileCount:projection.fileCount,
            totalBytes:projection.totalBytes,
            contentSha256:projection.contentSha256
        },
        authorities.projection
    );
    assert.deepEqual(
        await readVerifiedAppReleaseFile(packaged.receipt,{
            releaseRoot,
            relativePath:RUNTIME_PROJECTION_NAME
        }),
        projectionBytes
    );
    const release=JSON.parse(await readFile(path.join(releaseRoot,'ARCANE_APP_RELEASE.json'),'utf8'));
    assert.ok(release.files.some(file=>file.path===RUNTIME_AUTHORITIES_NAME));
    assert.ok(release.files.some(file=>file.path===RUNTIME_PROJECTION_NAME));
    const distProjection=release.files
        .filter(file=>file.path.startsWith('arcane/'))
        .map(file=>({path:file.path.slice('arcane/'.length),bytes:file.bytes,sha256:file.sha256}));
    assert.deepEqual(distProjection,projection.files);
    assert.equal(distProjection.length,workspaceRuntimeReceipt.fileCount);
    assert.equal(
        createHash('sha256').update(JSON.stringify(distProjection)).digest('hex'),
        workspaceRuntimeReceipt.contentSha256
    );
    assert.equal((await verifyApp({workspaceRoot,appId})).verified,true);
});

test('packager authenticates the same managed dependency map across its dynamic browser-document inventory',async t=>{
    const appId='multi-page-package';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-multi-page-package-',
        appId
    });
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const entryPath=path.join(appRoot,'index.html');
    const reviewPath=path.join(appRoot,'review.html');
    const ignoredPath=path.join(appRoot,'ignored.html');
    const packageConfigPath=path.join(appRoot,'arcane-package.json');
    const descriptorPath=path.join(appRoot,'arcane-app.json');
    const packageConfig=JSON.parse(await readFile(packageConfigPath,'utf8'));
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    packageConfig.include.push('review.html','ignored.html');
    packageConfig.exclude.push('ignored.html');
    descriptor.package.include.push('review.html','ignored.html');
    descriptor.package.exclude.push('ignored.html');
    await writeJson(packageConfigPath,packageConfig);
    await writeJson(descriptorPath,descriptor);
    await writeFile(reviewPath,await readFile(entryPath));
    const ignoredBytes=Buffer.from('excluded application document remains untouched\n');
    await writeFile(ignoredPath,ignoredBytes);

    const packaged=await packageApp({workspaceRoot,appId});
    const mapPath=path.join(appRoot,'modules','arcane.importmap.json');
    const map=JSON.parse(await readFile(mapPath,'utf8'));
    const releaseRoot=path.join(workspaceRoot,'dist',appId);
    const release=JSON.parse(await readFile(path.join(releaseRoot,'ARCANE_APP_RELEASE.json'),'utf8'));

    assert.equal(packaged.importMapReceipt.documentCount,2);
    assert.deepEqual(packaged.importMapReceipt.documentPaths,[entryPath,reviewPath]);
    assert.deepEqual(packaged.importMapReceipt.files.map(file=>[file.role,file.path]),[
        ['artifact',`apps/${appId}/modules/arcane.importmap.json`],
        ['entry',`apps/${appId}/index.html`],
        ['document',`apps/${appId}/review.html`]
    ]);
    for(const documentPath of [entryPath,reviewPath]){
        assert.deepEqual(managedInlineMap(await readFile(documentPath,'utf8')),map);
        assert.deepEqual(
            managedInlineMap(await readFile(path.join(
                releaseRoot,
                'apps',
                appId,
                path.basename(documentPath)
            ),'utf8')),
            map
        );
    }
    assert.deepEqual(await readFile(ignoredPath),ignoredBytes);
    assert.equal(release.files.some(file=>file.path===`apps/${appId}/ignored.html`),false);
    for(const committed of packaged.importMapReceipt.files){
        const released=release.files.find(file=>file.path===committed.path);
        assert.ok(released);
        assert.equal(released.bytes,committed.bytes);
        assert.equal(released.sha256,committed.sha256);
    }
});

test('browser toolchain operations verify each exact runtime state once',async t=>{
    const appId='runtime-reuse-app';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-browser-runtime-reuse-',
        appId
    });
    const invoke=async operation=>{
        const events=[];
        const result=await operation(event=>events.push(event));
        assert.equal(events.filter(event=>event.type==='runtime.verify.started').length,1);
        assert.equal(
            events.filter(event=>event.type==='sdk-browser-runtime.verify.started').length,
            1
        );
        assert.equal(
            events.filter(event=>event.type==='workspace.runtime.verify.started').length,
            1
        );
        return {events,result};
    };

    const packaged=await invoke(onEvent=>packageApplication({workspaceRoot,appId,onEvent}));
    assert.equal(packaged.events.filter(event=>event.type==='import-map.completed').length,1);
    const built=await invoke(onEvent=>buildApplication({
        workspaceRoot,
        appId,
        target:'browser',
        onEvent
    }));
    assert.equal(built.events.filter(event=>event.type==='import-map.completed').length,1);
    await invoke(onEvent=>verifyApplication({workspaceRoot,appId,onEvent}));
    await invoke(onEvent=>bundleApplication({workspaceRoot,appId,onEvent}));
    const running=await invoke(onEvent=>runApplication({
        workspaceRoot,
        appId,
        target:'browser',
        host:'127.0.0.1',
        port:0,
        onEvent
    }));
    await running.result.close();
});

test('public import-map operation is available through dispatch and the headless toolchain',async t=>{
    const appId='public-import-map-app';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-public-import-map-',
        appId
    });

    const dispatched=await executeOperation('import-map',{workspaceRoot,appId});
    const [requestedIdentity,dispatchedIdentity]=await Promise.all([
        lstat(workspaceRoot,{bigint:true}),
        lstat(dispatched.workspaceRoot,{bigint:true})
    ]);
    assert.equal(requestedIdentity.isDirectory(),true);
    assert.equal(dispatchedIdentity.isDirectory(),true);
    assert.equal(requestedIdentity.dev,dispatchedIdentity.dev);
    assert.equal(requestedIdentity.ino,dispatchedIdentity.ino);
    assert.equal(dispatched.appId,appId);
    assert.equal(dispatched.importMap.committed,true);

    const toolchain=createToolchain({workspaceRoot,appId});
    assert.equal(typeof toolchain.importMap,'function');
    const headless=await toolchain.importMap();
    const headlessIdentity=await lstat(headless.workspaceRoot,{bigint:true});
    assert.equal(headlessIdentity.isDirectory(),true);
    assert.equal(headlessIdentity.dev,requestedIdentity.dev);
    assert.equal(headlessIdentity.ino,requestedIdentity.ino);
    assert.equal(headless.appId,appId);
    assert.equal(headless.importMap.committed,true);
});

test('package release fails closed when import-map cleanup reports a warning',async t=>{
    const appId='cleanup-warning';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-import-map-cleanup-warning-',
        appId
    });
    const appRoot=path.join(workspaceRoot,'apps',appId);
    let tamperedBackup=false;

    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId,
            onEvent:async event=>{
                if(tamperedBackup||event.type!=='import-map.commit.progress')return;
                const entries=await readdir(appRoot);
                const backup=entries.find(name=>name.includes('.arcane-backup-'));
                assert.ok(backup,'entry backup must exist at the cleanup boundary');
                const backupPath=path.join(appRoot,backup);
                await rm(backupPath);
                await mkdir(backupPath);
                tamperedBackup=true;
            }
        }),
        error=>error?.code==='ARCANE_IMPORT_MAP_CLEANUP_FAILED'
            &&/Import-map application entry backup changed before transaction cleanup\./u
                .test(error.message)
    );
    assert.equal(tamperedBackup,true);
    await assert.rejects(
        readFile(path.join(workspaceRoot,'dist',appId,'ARCANE_APP_RELEASE.json')),
        {code:'ENOENT'}
    );
});

// Each case performs a complete authenticated package traversal. Keep the
// default watchdog per case while admitting their measured serialized sum.
test('package rejects terminal import-map listener removal, truncation, and mismatch',{timeout:60_000},async t=>{
    const cases=[
        {
            name:'removed-artifact',
            mutate:({mapPath})=>unlink(mapPath)
        },
        {
            name:'truncated-entry',
            mutate:({entryPath})=>writeFile(entryPath,'')
        },
        {
            name:'mismatched-artifact',
            mutate:({mapPath})=>writeFile(mapPath,'{"imports":{}}\n')
        }
    ];
    for(const scenario of cases){
        await t.test(scenario.name,async child=>{
            const appId=`listener-${scenario.name}`;
            const workspaceRoot=await authenticatedWorkspace(child,{
                prefix:`arcane-terminal-${scenario.name}-`,
                appId
            });
            const appRoot=path.join(workspaceRoot,'apps',appId);
            let mutated=false;

            await assert.rejects(
                packageApp({
                    workspaceRoot,
                    appId,
                    onEvent:async event=>{
                        if(mutated||event.type!=='import-map.completed')return;
                        await scenario.mutate({
                            entryPath:path.join(appRoot,'index.html'),
                            mapPath:path.join(appRoot,'modules','arcane.importmap.json')
                        });
                        mutated=true;
                    }
                }),
                /import-map (?:artifact|entry).*(?:changed|unavailable)|does not bind/iu
            );
            assert.equal(mutated,true);
            await assert.rejects(
                readFile(path.join(workspaceRoot,'dist',appId,'ARCANE_APP_RELEASE.json')),
                {code:'ENOENT'}
            );
        });
    }
});

test('release verification rejects removed or coherently rehashed runtime authority and projection metadata',async t=>{
    const appId='authority-tamper';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-runtime-authority-tamper-',
        appId
    });
    const releaseRoot=path.join(workspaceRoot,'dist',appId);
    const authorityPath=path.join(releaseRoot,RUNTIME_AUTHORITIES_NAME);
    const projectionPath=path.join(releaseRoot,RUNTIME_PROJECTION_NAME);

    await packageApp({workspaceRoot,appId});
    await unlink(authorityPath);
    await rewriteReleaseInventory(releaseRoot,release=>{
        release.files=release.files.filter(file=>file.path!==RUNTIME_AUTHORITIES_NAME);
    });
    await assert.rejects(
        verifyApp({workspaceRoot,appId}),
        /ARCANE_RUNTIME_AUTHORITIES|runtime authorit|does not exist/iu
    );

    await packageApp({workspaceRoot,appId});
    const tampered=JSON.parse(await readFile(authorityPath,'utf8'));
    tampered.sources.sdkBrowser.source.dependencies[0].integrity='sha512-tampered';
    const tamperedBytes=Buffer.from(`${JSON.stringify(tampered,null,2)}\n`);
    await writeFile(authorityPath,tamperedBytes);
    await rewriteReleaseInventory(releaseRoot,release=>{
        const record=release.files.find(file=>file.path===RUNTIME_AUTHORITIES_NAME);
        assert.ok(record);
        record.bytes=tamperedBytes.length;
        record.sha256=createHash('sha256').update(tamperedBytes).digest('hex');
    });
    await assert.rejects(
        verifyApp({workspaceRoot,appId}),
        /ARCANE_RUNTIME_AUTHORITIES|runtime authorit/iu
    );

    await packageApp({workspaceRoot,appId});
    await unlink(projectionPath);
    await rewriteReleaseInventory(releaseRoot,release=>{
        release.files=release.files.filter(file=>file.path!==RUNTIME_PROJECTION_NAME);
    });
    await assert.rejects(
        verifyApp({workspaceRoot,appId}),
        error=>error?.code==='ARCANE_RUNTIME_PROJECTION_INVALID'
            &&/ARCANE_RUNTIME_PROJECTION\.json/u.test(error.message)
    );

    await packageApp({workspaceRoot,appId});
    const tamperedProjection=JSON.parse(await readFile(projectionPath,'utf8'));
    tamperedProjection.files[0].sha256='0'.repeat(64);
    tamperedProjection.contentSha256=createHash('sha256')
        .update(JSON.stringify(tamperedProjection.files))
        .digest('hex');
    const tamperedProjectionBytes=Buffer.from(`${JSON.stringify(tamperedProjection,null,2)}\n`);
    await writeFile(projectionPath,tamperedProjectionBytes);
    await rewriteReleaseInventory(releaseRoot,release=>{
        const record=release.files.find(file=>file.path===RUNTIME_PROJECTION_NAME);
        assert.ok(record);
        record.bytes=tamperedProjectionBytes.length;
        record.sha256=createHash('sha256').update(tamperedProjectionBytes).digest('hex');
    });
    await assert.rejects(
        verifyApp({workspaceRoot,appId}),
        error=>error?.code==='ARCANE_RUNTIME_PROJECTION_INVALID'
            &&/ARCANE_RUNTIME_PROJECTION\.json/u.test(error.message)
    );

    await packageApp({workspaceRoot,appId});
    const arcanePath='arcane/modules/MD.js';
    const tamperedArcaneBytes=Buffer.from('export default "tampered dist runtime";\n');
    await writeFile(path.join(releaseRoot,...arcanePath.split('/')),tamperedArcaneBytes);
    await rewriteReleaseInventory(releaseRoot,release=>{
        const record=release.files.find(file=>file.path===arcanePath);
        assert.ok(record);
        record.bytes=tamperedArcaneBytes.length;
        record.sha256=createHash('sha256').update(tamperedArcaneBytes).digest('hex');
    });
    await assert.rejects(
        verifyApp({workspaceRoot,appId}),
        /packaged arcane runtime|runtime authorit/iu
    );
});

test('integrated physical packages reject external receipt tuples instead of ignoring them',async t=>{
    const appId='integrated-physical-package';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-integrated-physical-package-',
        appId
    });
    const runtimeVerificationState=await issueRuntimeVerificationState(workspaceRoot);
    await writeJson(path.join(workspaceRoot,'package.json'),{
        name:'arcane-os',
        private:true,
        type:'module'
    });
    const rootConfigPath=path.join(workspaceRoot,'arcane-packager.json');
    const rootConfig=JSON.parse(await readFile(rootConfigPath,'utf8'));
    rootConfig.sharedPayloads['browser-runtime']=rootConfig.sharedPayloads['browser-runtime'].slice(0,1);
    await writeJson(rootConfigPath,rootConfig);
    await rm(path.join(workspaceRoot,'arcane.lock.json'));
    await assert.rejects(
        packageApp({workspaceRoot,appId,runtimeVerificationState}),
        /runtime verification state cannot be supplied to an integrated workspace/u
    );
    await assert.rejects(
        packageApp({workspaceRoot,appId,dryRun:true,runtimeVerificationState}),
        /runtime verification state cannot be supplied to an integrated workspace/u
    );
    assert.equal(
        (await packageApp({workspaceRoot,appId})).receipt.kind,
        'arcane-app-release-verification'
    );
    await assert.rejects(
        verifyApp({workspaceRoot,appId,runtimeVerificationState}),
        /runtime verification state cannot be supplied to an integrated workspace/u
    );
    await assert.rejects(
        runApplication({
            workspaceRoot,
            appId,
            target:'browser',
            runtimeVerificationState
        }),
        /runtime verification state cannot be supplied to an integrated workspace/u
    );
});

test('integrated legacy packages retain their physical two-route contract without SDK authority metadata',async t=>{
    const appId='legacy-package';
    const workspaceRoot=await authenticatedWorkspace(t,{
        prefix:'arcane-legacy-package-',
        appId
    });
    const runtimeVerificationState=await issueRuntimeVerificationState(workspaceRoot);
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
    await rm(path.join(workspaceRoot,'arcane.lock.json'));
    await cp(
        path.join(workspaceRoot,'arcane','dependencies','strong-type'),
        path.join(workspaceRoot,'node_modules','strong-type'),
        {recursive:true}
    );
    await rm(path.join(workspaceRoot,'arcane','dependencies'),{recursive:true});
    await rm(path.join(workspaceRoot,'arcane','sdk'),{recursive:true});

    await assert.rejects(
        packageApp({workspaceRoot,appId,runtimeVerificationState}),
        /runtime verification state cannot be supplied to an integrated workspace/u
    );

    const packaged=await packageApp({workspaceRoot,appId});
    const releaseRoot=path.join(workspaceRoot,'dist',appId);
    await assert.rejects(readFile(path.join(releaseRoot,RUNTIME_AUTHORITIES_NAME)),{code:'ENOENT'});
    await assert.rejects(readFile(path.join(releaseRoot,RUNTIME_PROJECTION_NAME)),{code:'ENOENT'});
    assert.equal(
        packaged.receipt.files.some(file=>file.path===RUNTIME_AUTHORITIES_NAME),
        false
    );
    assert.equal(
        packaged.receipt.files.some(file=>file.path===RUNTIME_PROJECTION_NAME),
        false
    );
    assert.ok(packaged.receipt.files.some(file=>{
        return file.path==='node_modules/strong-type/index.js';
    }));
    assert.equal(packaged.receipt.files.some(file=>file.path.startsWith('arcane/sdk/')),false);
    assert.equal((await verifyApp({workspaceRoot,appId})).verified,true);
});

test('release verification binds the exact authored security policy',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-security-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const configPath=path.join(workspaceRoot,'apps','fixture-app','arcane-package.json');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    config.security.connectOrigins=['https://changed.example.com'];
    await writeJson(configPath,config);
    await assert.rejects(
        verifyApp({workspaceRoot,appId:'fixture-app'}),
        /identity|policy|security/u
    );
});

test('source replacement during copy cannot activate a mixed release',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-copy-race-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const before=await snapshotRelease(workspaceRoot);
    const mutableSource=path.join(workspaceRoot,'apps','fixture-app','modules','App.js');
    let changed=false;

    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'fixture-app',
            onEvent:async event=>{
                if(!changed&&event.type==='package.copy.progress'){
                    changed=true;
                    await writeFile(mutableSource,'export const ready=false;\n');
                }
            }
        }),
        /changed after its package inventory|changed while/i
    );
    assert.equal(changed,true);
    assert.deepEqual(await snapshotRelease(workspaceRoot),before);
    assert.equal((await verifyApp({workspaceRoot,appId:'fixture-app'})).verified,true);
});

test('cancelled package work preserves the previously verified release',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-cancelled-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const before=await snapshotRelease(workspaceRoot);

    await writeFile(
        path.join(workspaceRoot,'apps','fixture-app','index.html'),
        '<!doctype html><title>Changed but cancelled</title>\n'
    );
    const controller=new AbortController();
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'fixture-app',
            signal:controller.signal,
            onEvent:event=>{
                if(event.type==='package.copy.progress'){
                    const reason=new Error('Test cancellation.');
                    reason.code='ARCANE_CANCELLED';
                    controller.abort(reason);
                }
            }
        }),
        error=>error?.code==='ARCANE_CANCELLED'
    );

    const after=await snapshotRelease(workspaceRoot);
    assert.deepEqual(after,before);
    const verified=await verifyApp({workspaceRoot,appId:'fixture-app'});
    assert.equal(verified.verified,true);
});

test('changed verified source state blocks package promotion',async t=>{
    const workspaceRoot=await temporaryDirectory(t,{prefix:'arcane-source-state-package-'});
    await createExternalFixture(workspaceRoot);
    await packageApp({workspaceRoot,appId:'fixture-app'});
    const before=await snapshotRelease(workspaceRoot);

    await writeFile(
        path.join(workspaceRoot,'apps','fixture-app','index.html'),
        '<!doctype html><title>Changed source state</title>\n'
    );
    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId:'fixture-app',
            validateSourceState:()=>{
                const error=new Error('Verified runtime source state changed.');
                error.code='ARCANE_INTEGRITY_FAILED';
                throw error;
            }
        }),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );

    assert.deepEqual(await snapshotRelease(workspaceRoot),before);
    assert.equal((await verifyApp({workspaceRoot,appId:'fixture-app'})).verified,true);
});

test('descriptor mutation during packaging blocks release promotion',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-descriptor-race-package-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='descriptor-race';
    await createWorkspace({targetPath:workspaceRoot,appId});
    await installSdkRuntime(workspaceRoot);
    await packageApp({workspaceRoot,appId});
    const releaseManifestPath=path.join(
        workspaceRoot,
        'dist',
        appId,
        'ARCANE_APP_RELEASE.json'
    );
    const before=await readFile(releaseManifestPath,'utf8');
    const descriptorPath=path.join(workspaceRoot,'apps',appId,'arcane-app.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    let changed=false;

    await assert.rejects(
        packageApp({
            workspaceRoot,
            appId,
            onEvent:async event=>{
                if(changed||event.type!=='package.copy.progress')return;
                changed=true;
                descriptor.permissions.capabilities=['storage.read'];
                await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`);
            }
        }),
        /descriptor authority|changed after/u
    );
    assert.equal(changed,true);
    assert.equal(await readFile(releaseManifestPath,'utf8'),before);
});

test('toolchain package events serialize heartbeat and complete before settlement',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-toolchain-events-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'queued-app'});
    await installSdkRuntime(workspaceRoot);
    const delivered=[];
    let active=0;
    let maximumActive=0;
    let delayedProgress=false;

    const result=await packageApplication({
        workspaceRoot,
        appId:'queued-app',
        heartbeatMs:1000,
        onEvent:async event=>{
            active+=1;
            maximumActive=Math.max(maximumActive,active);
            try{
                if(event.type==='package.copy.progress'&&!delayedProgress){
                    delayedProgress=true;
                    await delay(1100);
                }
                delivered.push(event.type);
            }finally{
                active-=1;
            }
        }
    });

    assert.equal(result.release.app,'queued-app');
    assert.equal(delayedProgress,true);
    assert.equal(maximumActive,1);
    assert.equal(active,0);
    const packageEvents=delivered.filter(type=>type.startsWith('package.'));
    assert.ok(packageEvents.includes('package.heartbeat'));
    assert.equal(packageEvents.at(-1),'package.completed');
});

test('toolchain event rejection before import-map commit cancels package work and remains handled',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-toolchain-event-failure-'});
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'rejected-events'});
    await installSdkRuntime(workspaceRoot);
    const callbackFailure=new Error('Toolchain event sink rejected package progress.');
    const unhandled=[];
    const observeUnhandled=reason=>unhandled.push(reason);
    process.on('unhandledRejection',observeUnhandled);
    t.after(()=>process.removeListener('unhandledRejection',observeUnhandled));
    const delivered=[];

    await assert.rejects(
        packageApplication({
            workspaceRoot,
            appId:'rejected-events',
            onEvent:async event=>{
                delivered.push(event.type);
                if(event.type==='import-map.started'){
                    await delay(10);
                    throw callbackFailure;
                }
            }
        }),
        error=>error===callbackFailure
    );
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(unhandled,[]);
    assert.equal(delivered.includes('package.completed'),false);
    await assert.rejects(
        readFile(path.join(workspaceRoot,'dist','rejected-events','ARCANE_APP_RELEASE.json')),
        {code:'ENOENT'}
    );
});

test('child import-map completion does not mark an uncommitted outer package',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-toolchain-child-map-event-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='uncommitted-child-map';
    await createWorkspace({targetPath:workspaceRoot,appId});
    await installSdkRuntime(workspaceRoot);
    const callbackFailure=new Error('Rejected child import-map completion.');

    await assert.rejects(
        packageApplication({
            workspaceRoot,
            appId,
            onEvent:async event=>{
                if(event.type==='import-map.completed')throw callbackFailure;
            }
        }),
        error=>error===callbackFailure
    );
    await assert.rejects(
        readFile(path.join(workspaceRoot,'dist',appId,'ARCANE_APP_RELEASE.json')),
        {code:'ENOENT'}
    );
    assert.equal(
        JSON.parse(await readFile(path.join(
            workspaceRoot,'apps',appId,'modules','arcane.importmap.json'
        ),'utf8')).imports['arcane-os/event-manager'],
        './arcane/sdk/event-manager.mjs'
    );
    await assert.rejects(
        readFile(path.join(workspaceRoot,'.arcane','workspace-operation.lock.json')),
        {code:'ENOENT'}
    );
});

test('toolchain preserves an authenticated package when lock-release delivery fails',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-toolchain-committed-release-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='committed-release';
    await createWorkspace({targetPath:workspaceRoot,appId});
    await installSdkRuntime(workspaceRoot);
    const callbackFailure=new Error('Rejected committed lock-release event.');

    const result=await packageApplication({
        workspaceRoot,
        appId,
        onEvent:async event=>{
            if(event.type==='workspace.operation.released')throw callbackFailure;
        }
    });

    assert.equal(result.release.eventDelivery.status,'degraded');
    assert.equal(result.release.eventDelivery.errorCode,'ARCANE_EVENT_DELIVERY_FAILED');
    assert.equal(result.release.eventDelivery.message,callbackFailure.message);
    assert.equal(result.release.importMapReceipt.committed,true);
    assert.deepEqual(result.release.importMapReceipt.cleanupWarnings,[]);
    assert.equal(Object.isFrozen(result.release.importMapReceipt.cleanupWarnings),true);
    assert.equal((await verifyApp({workspaceRoot,appId})).verified,true);
    const sourceMap=await readFile(path.join(
        workspaceRoot,'apps',appId,'modules','arcane.importmap.json'
    ));
    const packagedMap=await readFile(path.join(
        workspaceRoot,'dist',appId,'apps',appId,'modules','arcane.importmap.json'
    ));
    assert.deepEqual(packagedMap,sourceMap);
    await assert.rejects(
        readFile(path.join(workspaceRoot,'.arcane','workspace-operation.lock.json')),
        {code:'ENOENT'}
    );
});
