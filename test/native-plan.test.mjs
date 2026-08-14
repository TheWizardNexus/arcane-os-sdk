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
import {createToolchain} from '../src/toolchain.mjs';
import {getTargetAdapter} from '../src/targets/index.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

async function prepareNativeRelease(parent,{appId='native-app',displayName='Native App'}={}){
    const workspaceRoot=path.join(parent,'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId,displayName});
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
        describe:async()=>({
            protocol:NATIVE_BUILDER_PROTOCOL,
            targets:['windows-x64','linux-x64']
        }),
        doctor:async request=>{
            capture.doctorRequest=request;
            return {ready:true};
        },
        prepare:async request=>{
            capture.prepareRequest=request;
            return toolchainReceipt;
        },
        authenticateToolchainReceipt:async(receipt,{toolchainRoot})=>{
            assert.equal(receipt,toolchainReceipt);
            assert.equal(toolchainRoot,toolchainReceipt.canonicalLocation);
            return receipt;
        },
        build:async request=>{
            capture.request=request;
            capture.readPath=request.appReleaseReceipt.files[0].path;
            capture.readBytes=await request.readAppReleaseFile(capture.readPath);
            return {
                target:'spoofed-provider-target',
                artifactReceipt:Object.freeze({kind:'synthetic-native-artifact'})
            };
        },
        verify:async request=>{
            capture.verifyRequest=request;
            return {verified:true};
        },
        run:async request=>{
            capture.runRequest=request;
            return {running:true};
        }
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
        protocolVersion:'arcane/1',
        features:Object.freeze([]),
        supportedCapabilities:Object.freeze([]),
        supportedMethods:Object.freeze([]),
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
    assert.equal(plan.minimumCoreVersion,'0.8.11');
    assert.equal(plan.toolchain.protocolVersion,'arcane/1');
    assert.deepEqual(plan.toolchain.features,[]);
    assert.deepEqual(plan.toolchain.supportedCapabilities,[]);
    assert.deepEqual(plan.toolchain.supportedMethods,[]);
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
    assert.equal(result.artifactVerification.verified,true);
    assert.equal(capture.verifyRequest.artifactReceipt,result.artifactReceipt);
    assert.equal(capture.request.toolchainRoot,canonicalToolchainRoot);
    assert.equal(capture.request.appReleaseRoot,await realpath(application.releaseRoot));
    assert.equal(capture.readPath,application.releaseReceipt.files[0].path);
    assert.equal(capture.readBytes.length,application.releaseReceipt.files[0].bytes);
    assert.equal(typeof capture.request.readAppReleaseFile,'function');
    assert.equal(capture.request.outputRoot,plan.outputRoot);
    assert.equal(capture.request.appDescriptor.id,application.appId);
    assert.equal(Object.hasOwn(capture.request,'workspaceRoot'),false);
    assert.equal(Object.hasOwn(capture.request,'appRoot'),false);

    const failingCapture={};
    const baseFailingProvider=nativeProvider(toolchainReceipt,failingCapture);
    const failingProvider=Object.freeze({
        ...baseFailingProvider,
        verify:async request=>{
            failingCapture.verifyRequest=request;
            return {verified:false};
        }
    });
    const failingPlan=await createNativeBuildPlan({
        nativeBuilder:failingProvider,
        toolchainRoot,
        toolchainReceipt,
        appReleaseRoot:application.releaseRoot,
        appReleaseReceipt:application.releaseReceipt,
        appDescriptor:application.descriptor,
        protectedRoots:[application.appRoot],
        outputRoot:path.join(application.workspaceRoot,'build','verification-failure'),
        targetRequest:plan.targetRequest
    });
    const failingEvents=[];
    await assert.rejects(
        executeNativeBuildPlan(failingPlan,{onEvent:event=>failingEvents.push(event)}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );
    assert.equal(failingCapture.verifyRequest.artifactReceipt.kind,'synthetic-native-artifact');
    assert.equal(failingEvents.some(event=>event.type==='native.build.completed'),false);
    await assert.rejects(
        executeNativeBuildPlan(failingPlan),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
            &&/already been attempted/u.test(error.message)
    );

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

    const differentPackagePolicy={
        ...application.descriptor,
        package:{
            ...application.descriptor.package,
            exclude:['modules/private-development-only.js']
        }
    };
    await assert.rejects(
        createNativeBuildPlan({
            nativeBuilder:provider,
            toolchainRoot,
            toolchainReceipt,
            appReleaseRoot:application.releaseRoot,
            appReleaseReceipt:application.releaseReceipt,
            appDescriptor:differentPackagePolicy,
            protectedRoots:[application.appRoot],
            outputRoot:path.join(application.workspaceRoot,'build','different-package-policy'),
            targetRequest:plan.targetRequest
        }),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
            &&/different authored package policy/u.test(error.message)
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

test('native plan enforces the highest bundled dependency requirements',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-dependency-'});
    const application=await prepareNativeRelease(path.join(parent,'application'));
    const dependency=await prepareNativeRelease(path.join(parent,'dependency'),{
        appId:'dependency-app',
        displayName:'Dependency App'
    });
    const appDescriptor={
        ...application.descriptor,
        native:{...application.descriptor.native,bundledApps:[dependency.appId]}
    };
    const dependencyDescriptor={
        ...dependency.descriptor,
        requirements:{
            ...dependency.descriptor.requirements,
            minimumCoreVersion:'0.8.12',
            features:['dependency.contract']
        }
    };
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const targetRequest={
        target:'windows-x64',
        platform:'windows',
        architecture:'x64',
        format:'exe',
        signing:{mode:'unsigned-local-test',profileId:null}
    };
    const dependencyReleases=[{
        appReleaseRoot:dependency.releaseRoot,
        appReleaseReceipt:dependency.releaseReceipt,
        appDescriptor:dependencyDescriptor
    }];
    const compatibleReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.12',
        protocolVersion:'arcane/1',
        features:Object.freeze(['dependency.contract']),
        supportedCapabilities:Object.freeze([]),
        supportedMethods:Object.freeze([]),
        canonicalLocation:canonicalToolchainRoot,
        contentSha256:'d'.repeat(64)
    });
    const plan=await createNativeBuildPlan({
        nativeBuilder:nativeProvider(compatibleReceipt,{}),
        toolchainRoot,
        toolchainReceipt:compatibleReceipt,
        appReleaseRoot:application.releaseRoot,
        appReleaseReceipt:application.releaseReceipt,
        appDescriptor,
        dependencyReleases,
        outputRoot:path.join(parent,'compatible-output'),
        targetRequest
    });
    assert.equal(plan.minimumCoreVersion,'0.8.12');
    assert.deepEqual(plan.dependencies.map(item=>item.id),[dependency.appId]);

    const oldReceipt=Object.freeze({...compatibleReceipt,version:'0.8.11'});
    await assert.rejects(
        createNativeBuildPlan({
            nativeBuilder:nativeProvider(oldReceipt,{}),
            toolchainRoot,
            toolchainReceipt:oldReceipt,
            appReleaseRoot:application.releaseRoot,
            appReleaseReceipt:application.releaseReceipt,
            appDescriptor,
            dependencyReleases,
            outputRoot:path.join(parent,'old-core-output'),
            targetRequest
        }),
        error=>error?.code==='ARCANE_TARGET_UNAVAILABLE'
            &&/required minimum 0\.8\.12/u.test(error.message)
    );

    const missingFeatureReceipt=Object.freeze({...compatibleReceipt,features:Object.freeze([])});
    await assert.rejects(
        createNativeBuildPlan({
            nativeBuilder:nativeProvider(missingFeatureReceipt,{}),
            toolchainRoot,
            toolchainReceipt:missingFeatureReceipt,
            appReleaseRoot:application.releaseRoot,
            appReleaseReceipt:application.releaseReceipt,
            appDescriptor,
            dependencyReleases,
            outputRoot:path.join(parent,'missing-feature-output'),
            targetRequest
        }),
        error=>error?.code==='ARCANE_TARGET_UNAVAILABLE'
            &&/required features: dependency\.contract/u.test(error.message)
    );
});

test('native plan execution admits one owner and rejects concurrent or sequential reuse',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-plan-owner-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.11',
        protocolVersion:'arcane/1',
        features:Object.freeze([]),
        supportedCapabilities:Object.freeze([]),
        supportedMethods:Object.freeze([]),
        canonicalLocation:canonicalToolchainRoot,
        contentSha256:'c'.repeat(64)
    });
    const capture={};
    const baseProvider=nativeProvider(toolchainReceipt,capture);
    let signalBuildStarted;
    let releaseBuild;
    const buildStarted=new Promise(resolve=>{signalBuildStarted=resolve;});
    const buildGate=new Promise(resolve=>{releaseBuild=resolve;});
    let buildCalls=0;
    const provider=Object.freeze({
        ...baseProvider,
        build:async request=>{
            buildCalls+=1;
            capture.request=request;
            signalBuildStarted();
            await buildGate;
            return {
                artifactReceipt:Object.freeze({kind:'single-owner-artifact'})
            };
        }
    });
    const plan=await createNativeBuildPlan({
        nativeBuilder:provider,
        toolchainRoot,
        toolchainReceipt,
        appReleaseRoot:application.releaseRoot,
        appReleaseReceipt:application.releaseReceipt,
        appDescriptor:application.descriptor,
        protectedRoots:[application.appRoot],
        outputRoot:path.join(application.workspaceRoot,'build','single-owner'),
        targetRequest:{
            target:'windows-x64',
            platform:'windows',
            architecture:'x64',
            format:'exe',
            signing:{mode:'unsigned-local-test',profileId:null}
        }
    });

    const firstExecution=executeNativeBuildPlan(plan);
    await buildStarted;
    try{
        await assert.rejects(
            executeNativeBuildPlan(plan),
            error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                &&/already been attempted/u.test(error.message)
        );
    }finally{
        releaseBuild();
    }
    const result=await firstExecution;
    assert.equal(result.artifactReceipt.kind,'single-owner-artifact');
    assert.equal(buildCalls,1);
    await assert.rejects(
        executeNativeBuildPlan(plan),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
            &&/already been attempted/u.test(error.message)
    );
    assert.equal(buildCalls,1);
});

test('an injected toolchain plans and builds one native target without changing the default registry',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-toolchain-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.11',
        protocolVersion:'arcane/1',
        features:Object.freeze([]),
        supportedCapabilities:Object.freeze([]),
        supportedMethods:Object.freeze([]),
        canonicalLocation:canonicalToolchainRoot,
        contentSha256:'b'.repeat(64)
    });
    const targetRequest=Object.freeze({
        target:'windows-x64',
        platform:'windows',
        architecture:'x64',
        format:'exe',
        signing:Object.freeze({mode:'unsigned-local-test',profileId:null})
    });
    const capture={};
    const provider=nativeProvider(toolchainReceipt,capture);
    const toolchain=createToolchain({
        target:'windows-x64',
        nativeBuilder:provider,
        toolchainRoot,
        toolchainReceipt,
        appReleaseRoot:application.releaseRoot,
        appReleaseReceipt:application.releaseReceipt,
        appDescriptor:application.descriptor,
        dependencyReleases:[],
        protectedRoots:[application.appRoot],
        outputRoot:path.join(application.workspaceRoot,'build','windows-x64'),
        targetRequest
    });
    const events=[];

    assert.deepEqual(await toolchain.doctorNative(),{ready:true});
    assert.equal(await toolchain.prepareNative(),toolchainReceipt);
    assert.equal(capture.doctorRequest.toolchainRoot,toolchainRoot);
    assert.equal(capture.prepareRequest.toolchainRoot,toolchainRoot);

    const plan=await toolchain.plan({onEvent:event=>events.push(event)});
    assert.deepEqual(plan.targetRequest,targetRequest);
    assert.equal(plan.app.id,application.appId);
    assert.deepEqual(
        events.map(event=>event.type),
        ['plan.started','native.plan.started','native.plan.completed','plan.completed']
    );
    const pairedTargets=(await toolchain.targets()).targets;
    assert.equal(pairedTargets.find(target=>target.id==='windows-x64').status,'available');
    assert.equal(pairedTargets.find(target=>target.id==='linux-x64').status,'deferred');

    events.length=0;
    const built=await toolchain.build({
        nativePlan:plan,
        onEvent:event=>events.push(event)
    });
    assert.equal(built.target,'windows-x64');
    assert.equal(built.platform,'windows');
    assert.equal(built.architecture,'x64');
    assert.equal(built.format,'exe');
    assert.deepEqual(built.signing,{mode:'unsigned-local-test',profileId:null});
    assert.equal(built.artifactReceipt.kind,'synthetic-native-artifact');
    assert.equal(built.artifactVerification.verified,true);
    assert.equal(capture.verifyRequest.artifactReceipt,built.artifactReceipt);
    assert.equal(capture.request.toolchainRoot,canonicalToolchainRoot);
    assert.equal(capture.request.appReleaseRoot,await realpath(application.releaseRoot));
    for(const withheld of ['workspaceRoot','appRoot','protectedRoots','nativeBuilder']){
        assert.equal(Object.hasOwn(capture.request,withheld),false,withheld);
    }
    assert.deepEqual(
        events.map(event=>event.type),
        [
            'build.started',
            'native.build.started',
            'native.build.committed',
            'native.verify.started',
            'native.verify.completed',
            'native.build.completed',
            'build.completed'
        ]
    );

    const verifiedArtifact=await toolchain.verifyNative({
        artifactReceipt:built.artifactReceipt
    });
    assert.equal(verifiedArtifact.artifactReceipt,built.artifactReceipt);
    assert.equal(capture.verifyRequest.artifactReceipt,built.artifactReceipt);
    assert.equal(verifiedArtifact.verification.verified,true);

    const running=await toolchain.run({artifactReceipt:built.artifactReceipt});
    assert.equal(running.artifactReceipt,built.artifactReceipt);
    assert.equal(capture.runRequest.artifactReceipt,built.artifactReceipt);
    assert.equal(running.result.running,true);
    for(const request of [
        capture.request,
        capture.doctorRequest,
        capture.prepareRequest,
        capture.verifyRequest,
        capture.runRequest
    ]){
        for(const withheld of ['workspaceRoot','appRoot','protectedRoots','nativeBuilder']){
            assert.equal(Object.hasOwn(request,withheld),false,withheld);
        }
    }
    await assert.rejects(
        toolchain.run(),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
    );

    const deliveryFailurePlan=await toolchain.plan({
        outputRoot:path.join(application.workspaceRoot,'build','delivery-failure')
    });
    const delivered=await toolchain.build({
        nativePlan:deliveryFailurePlan,
        onEvent:event=>{
            if(event.type==='native.build.committed'){
                throw new Error('synthetic post-commit delivery failure');
            }
        }
    });
    assert.equal(delivered.artifactReceipt.kind,'synthetic-native-artifact');
    assert.equal(delivered.artifactVerification.verified,true);
    assert.equal(delivered.eventDelivery.status,'degraded');
    assert.equal(delivered.eventDelivery.errorCode,'ARCANE_EVENT_DELIVERY_FAILED');
    assert.match(delivered.eventDelivery.message,/synthetic post-commit delivery failure/u);

    const preCommitFailurePlan=await toolchain.plan({
        outputRoot:path.join(application.workspaceRoot,'build','pre-commit-delivery-failure')
    });
    const priorBuildRequest=capture.request;
    await assert.rejects(
        toolchain.build({
            nativePlan:preCommitFailurePlan,
            onEvent:event=>{
                if(event.type==='native.build.started'){
                    throw new Error('synthetic pre-commit delivery failure');
                }
            }
        }),
        /synthetic pre-commit delivery failure/u
    );
    assert.equal(capture.request,priorBuildRequest);

    const differentProviderToolchain=createToolchain({
        target:'windows-x64',
        nativeBuilder:nativeProvider(toolchainReceipt,{}),
        toolchainRoot,
        toolchainReceipt,
        targetRequest
    });
    const differentProviderPlan=await toolchain.plan({
        outputRoot:path.join(application.workspaceRoot,'build','different-provider')
    });
    await assert.rejects(
        differentProviderToolchain.build({nativePlan:differentProviderPlan}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
            &&/different paired provider/u.test(error.message)
    );

    const differentTargetToolchain=createToolchain({
        target:'linux-x64',
        nativeBuilder:provider,
        toolchainRoot,
        toolchainReceipt,
        targetRequest:{
            target:'linux-x64',
            platform:'linux',
            architecture:'x64',
            format:'appimage',
            signing:{mode:'unsigned-local-test',profileId:null}
        }
    });
    const differentTargetPlan=await toolchain.plan({
        outputRoot:path.join(application.workspaceRoot,'build','different-target')
    });
    await assert.rejects(
        differentTargetToolchain.build({nativePlan:differentTargetPlan}),
        error=>error?.code==='ARCANE_INTEGRITY_FAILED'
            &&/does not match linux-x64/u.test(error.message)
    );

    const defaultAdapter=getTargetAdapter('windows-x64');
    assert.equal((await defaultAdapter.describe()).status,'deferred');
    await assert.rejects(
        defaultAdapter.build({target:'windows-x64'}),
        error=>error?.code==='ARCANE_TARGET_DEFERRED'
    );

    const unpaired=createToolchain({target:'windows-x64',targetRequest});
    assert.equal((await unpaired.doctorNative()).status,'deferred');
    for(const operation of [
        ()=>unpaired.prepareNative(),
        ()=>unpaired.verifyNative({artifactReceipt:built.artifactReceipt}),
        ()=>unpaired.run({artifactReceipt:built.artifactReceipt})
    ]){
        await assert.rejects(operation,error=>error?.code==='ARCANE_TARGET_DEFERRED');
    }
});
