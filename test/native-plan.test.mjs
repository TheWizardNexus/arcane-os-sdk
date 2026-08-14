import assert from 'node:assert/strict';
import {cp,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
    NATIVE_BUILDER_PROTOCOL,
    authenticateNativeBuildPlan,
    createNativeBuildPlan,
    executeNativeBuildPlan
} from '../src/native-plan.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

async function prepareNativeRelease(parent){
    const workspaceRoot=path.join(parent,'workspace');
    const appId='native-app';
    await createWorkspace({targetPath:workspaceRoot,appId,displayName:'Native App'});
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    await cp(path.join(repositoryRoot,'runtime'),path.join(installedRoot,'runtime'),{recursive:true});
    for(const license of ['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']){
        await cp(path.join(repositoryRoot,license),path.join(installedRoot,license));
    }

    const appRoot=path.join(workspaceRoot,'apps',appId);
    const descriptorPath=path.join(appRoot,'arcane-app.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    descriptor.native.icon='img/icon.png';
    descriptor.targets=['windows-x64'];
    descriptor.package.include.push('img');
    descriptor.package.include.sort();
    await mkdir(path.join(appRoot,'img'),{recursive:true});
    await writeFile(path.join(appRoot,'img','icon.png'),'synthetic development icon\n');
    await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`);
    await writeFile(
        path.join(appRoot,'arcane-package.json'),
        `${JSON.stringify(projectPackageManifest(descriptor),null,2)}\n`
    );
    const packaged=await packageApp({workspaceRoot,appId});
    return {
        workspaceRoot,
        appRoot,
        appId,
        descriptor,
        releaseRoot:path.join(workspaceRoot,'dist',appId),
        releaseReceipt:packaged.receipt
    };
}

function nativeProvider(toolchainReceipt,capture){
    return Object.freeze({
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe:async()=>({protocol:NATIVE_BUILDER_PROTOCOL}),
        doctor:async()=>({ready:true}),
        prepare:async()=>toolchainReceipt,
        authenticateToolchainReceipt:async(receipt,{toolchainRoot})=>{
            assert.equal(receipt,toolchainReceipt);
            assert.equal(toolchainRoot,toolchainReceipt.canonicalLocation);
            return receipt;
        },
        build:async request=>{
            capture.request=request;
            return {artifactReceipt:Object.freeze({kind:'synthetic-native-artifact'})};
        },
        verify:async()=>({verified:true}),
        run:async()=>({running:true})
    });
}

test('native plan binds explicit verified inputs and withholds source paths from the provider',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-plan-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.11',
        canonicalLocation:canonicalToolchainRoot,
        contentSha256:'a'.repeat(64)
    });
    const capture={};
    const provider=nativeProvider(toolchainReceipt,capture);
    const outputRoot=path.join(application.workspaceRoot,'build','windows-x64');
    const events=[];
    const plan=await createNativeBuildPlan({
        nativeBuilder:provider,
        toolchainRoot,
        toolchainReceipt,
        appReleaseRoot:application.releaseRoot,
        appReleaseReceipt:application.releaseReceipt,
        appDescriptor:application.descriptor,
        protectedRoots:[application.appRoot],
        outputRoot,
        targetRequest:{
            target:'windows-x64',
            platform:'windows',
            architecture:'x64',
            format:'exe',
            signing:{mode:'unsigned-local-test',profileId:null}
        },
        onEvent:event=>events.push(event)
    });

    assert.equal(plan.protocol,'arcane-native-build-plan/1');
    assert.equal(plan.app.id,application.appId);
    assert.equal(plan.targetRequest.target,'windows-x64');
    assert.equal(plan.toolchain.contentSha256,'a'.repeat(64));
    assert.deepEqual(plan.dependencies,[]);
    assert.ok(Object.isFrozen(plan));
    assert.ok(Object.isFrozen(plan.app.release));
    assert.deepEqual(events.map(event=>event.type),['native.plan.started','native.plan.completed']);
    assert.equal(await authenticateNativeBuildPlan(plan),plan);
    await assert.rejects(
        authenticateNativeBuildPlan(JSON.parse(JSON.stringify(plan))),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );

    const result=await executeNativeBuildPlan(plan);
    assert.equal(result.artifactReceipt.kind,'synthetic-native-artifact');
    assert.equal(capture.request.toolchainRoot,canonicalToolchainRoot);
    assert.equal(capture.request.appReleaseRoot,await realpath(application.releaseRoot));
    assert.equal(capture.request.outputRoot,path.resolve(outputRoot));
    assert.equal(capture.request.appDescriptor.id,application.appId);
    assert.equal(Object.hasOwn(capture.request,'workspaceRoot'),false);
    assert.equal(Object.hasOwn(capture.request,'appRoot'),false);

    await assert.rejects(
        createNativeBuildPlan({
            nativeBuilder:provider,
            toolchainRoot,
            toolchainReceipt,
            appReleaseRoot:application.releaseRoot,
            appReleaseReceipt:application.releaseReceipt,
            appDescriptor:application.descriptor,
            outputRoot:application.releaseRoot,
            targetRequest:plan.targetRequest
        }),
        /must not overlap/u
    );

    await writeFile(
        path.join(application.releaseRoot,'apps',application.appId,'index.html'),
        '<!doctype html><title>tampered</title>\n'
    );
    await assert.rejects(
        authenticateNativeBuildPlan(plan),
        error=>error?.code==='ARCANE_PACKAGE_INVALID'||error?.code==='ARCANE_INTEGRITY_FAILED'
    );
});
