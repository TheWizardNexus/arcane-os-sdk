import assert from 'node:assert/strict';
import {cp,lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
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
import {resolveWorkspace,validateDiscoveredApplication} from '../src/workspace.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

async function prepareNativeRelease(parent,{
    appId='native-app',
    displayName='Native App',
    mutateDescriptor
}={}){
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
    mutateDescriptor?.(descriptor);
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

test('native plan public boundary admits only the exact dev.4 target matrix before provider or toolchain work',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-target-matrix-'});
    const missingToolchainRoot=path.join(parent,'missing-toolchain');
    let authenticateCalls=0;
    const unused=async()=>({});
    const provider=Object.freeze({
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe:unused,
        doctor:unused,
        prepare:unused,
        authenticateToolchainReceipt:async()=>{
            authenticateCalls+=1;
            return {};
        },
        build:unused,
        verify:unused,
        run:unused
    });
    const unsigned=Object.freeze({mode:'unsigned-local-test',profileId:null});
    const androidDevelopment=Object.freeze({
        mode:'development',
        profileId:'arcane-android-development-v1'
    });
    const admitted=[
        ['portable/windows-x64',{
            target:'portable',platform:'windows',architecture:'x64',format:'portable',signing:unsigned
        }],
        ['portable/linux-arm64',{
            target:'portable',platform:'linux',architecture:'arm64',format:'portable',signing:unsigned
        }],
        ['windows-x64',{
            target:'windows-x64',platform:'windows',architecture:'x64',format:'exe',signing:unsigned
        }],
        ['linux-x64',{
            target:'linux-x64',platform:'linux',architecture:'x64',format:'deb',signing:unsigned
        }],
        ['linux-arm64',{
            target:'linux-arm64',platform:'linux',architecture:'arm64',format:'deb',signing:unsigned
        }],
        ['android-arm64',{
            target:'android-arm64',platform:'android',architecture:'arm64',format:'apk',signing:androidDevelopment
        }]
    ];
    for(const [label,targetRequest] of admitted){
        await t.test(`admits ${label} before toolchain policy`,async()=>{
            await assert.rejects(
                createNativeBuildPlan({nativeBuilder:provider,toolchainRoot:missingToolchainRoot,targetRequest}),
                error=>error?.code==='ARCANE_POLICY_DENIED'
                    &&/Native toolchain root does not exist/u.test(error.message),
                label
            );
        });
    }
    await t.test('admitted targets stop before receipt authentication',()=>{
        assert.equal(authenticateCalls,0);
    });

    const rejected=[
        ['AppImage',{
            target:'linux-x64',platform:'linux',architecture:'x64',format:'appimage',signing:unsigned
        }],
        ['RPM',{
            target:'linux-arm64',platform:'linux',architecture:'arm64',format:'rpm',signing:unsigned
        }],
        ['AAB',{
            target:'android-arm64',platform:'android',architecture:'arm64',format:'aab',signing:androidDevelopment
        }],
        ['production signing',{
            target:'android-arm64',platform:'android',architecture:'arm64',format:'apk',
            signing:{mode:'production',profileId:'arcane-android-development-v1'}
        }],
        ['missing Android development profile',{
            target:'android-arm64',platform:'android',architecture:'arm64',format:'apk',
            signing:{mode:'development',profileId:null}
        }],
        ['wrong Android development profile',{
            target:'android-arm64',platform:'android',architecture:'arm64',format:'apk',
            signing:{mode:'development',profileId:'another-profile'}
        }],
        ['target/platform mismatch',{
            target:'windows-x64',platform:'linux',architecture:'x64',format:'exe',signing:unsigned
        }],
        ['target/architecture mismatch',{
            target:'windows-x64',platform:'windows',architecture:'arm64',format:'exe',signing:unsigned
        }],
        ['target/format mismatch',{
            target:'windows-x64',platform:'windows',architecture:'x64',format:'deb',signing:unsigned
        }],
        ['unsigned target with a profile',{
            target:'linux-x64',platform:'linux',architecture:'x64',format:'deb',
            signing:{mode:'unsigned-local-test',profileId:'unexpected-profile'}
        }]
    ];
    let providerReads=0;
    const unreadProvider=new Proxy({}, {
        get(){
            providerReads+=1;
            throw new Error('provider must not be read for a rejected target request');
        }
    });
    for(const [label,targetRequest] of rejected){
        await t.test(`rejects ${label} before provider access`,async()=>{
            await assert.rejects(
                createNativeBuildPlan({
                    nativeBuilder:unreadProvider,
                    toolchainRoot:missingToolchainRoot,
                    targetRequest
                }),
                error=>error?.code==='ARCANE_TARGET_UNAVAILABLE',
                label
            );
        });
    }
    await t.test('rejected targets neither read nor authenticate a provider',()=>{
        assert.equal(providerReads,0);
        assert.equal(authenticateCalls,0);
    });
});

test('native plan binds explicit verified inputs and withholds source paths from the provider',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-plan-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.12',
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

    await t.test('plan records the verified app, target, toolchain, and dependency projection',()=>{
        assert.equal(plan.protocol,'arcane-native-build-plan/1');
        assert.equal(plan.app.id,application.appId);
        assert.equal(plan.targetRequest.target,'windows-x64');
        assert.equal(plan.minimumCoreVersion,'0.8.12');
        assert.equal(plan.toolchain.protocolVersion,'arcane/1');
        assert.deepEqual(plan.toolchain.features,[]);
        assert.deepEqual(plan.toolchain.supportedCapabilities,[]);
        assert.deepEqual(plan.toolchain.supportedMethods,[]);
        assert.equal(plan.toolchain.contentSha256,'a'.repeat(64));
        assert.deepEqual(plan.dependencies,[]);
    });
    await t.test('plan is frozen, emits its lifecycle, and authenticates only by identity',async()=>{
        assert.ok(Object.isFrozen(plan));
        assert.ok(Object.isFrozen(plan.app.release));
        assert.deepEqual(events.map(event=>event.type),['native.plan.started','native.plan.completed']);
        assert.equal(await authenticateNativeBuildPlan(plan),plan);
        await assert.rejects(
            authenticateNativeBuildPlan(JSON.parse(JSON.stringify(plan))),
            error=>error?.code==='ARCANE_INTEGRITY_FAILED'
        );
    });

    let result;
    await t.test('execution returns the verified native artifact',async()=>{
        result=await executeNativeBuildPlan(plan);
        assert.equal(result.artifactReceipt.kind,'synthetic-native-artifact');
        assert.equal(result.artifactVerification.verified,true);
        assert.equal(capture.verifyRequest.artifactReceipt,result.artifactReceipt);
    });
    await t.test('provider receives canonical release readers without authored source paths',async()=>{
        assert.equal(capture.request.toolchainRoot,canonicalToolchainRoot);
        assert.equal(capture.request.appReleaseRoot,await realpath(application.releaseRoot));
        assert.equal(capture.readPath,application.releaseReceipt.files[0].path);
        assert.equal(capture.readBytes.length,application.releaseReceipt.files[0].bytes);
        assert.equal(typeof capture.request.readAppReleaseFile,'function');
        assert.equal(capture.request.outputRoot,plan.outputRoot);
        assert.equal(capture.request.appDescriptor.id,application.appId);
        assert.equal(Object.hasOwn(capture.request,'workspaceRoot'),false);
        assert.equal(Object.hasOwn(capture.request,'appRoot'),false);
    });

    await t.test('failed artifact verification prevents completion and makes the plan single-use',async()=>{
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
    });

    await t.test('output root cannot overlap the packaged release',async()=>{
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
    });

    await t.test('authored package policy must match the release receipt',async()=>{
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
    });

    await t.test('release tampering invalidates the authenticated plan',async()=>{
        await writeFile(
            path.join(application.releaseRoot,'apps',application.appId,'index.html'),
            '<!doctype html><title>tampered</title>\n'
        );
        await assert.rejects(
            authenticateNativeBuildPlan(plan),
            error=>error?.code==='ARCANE_PACKAGE_INVALID'||error?.code==='ARCANE_INTEGRITY_FAILED'
        );
    });
});

test('focused validation and release authority reject descriptor-only source drift',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-descriptor-authority-'});
    const application=await prepareNativeRelease(parent);
    const discovered=await resolveWorkspace({
        workspaceRoot:application.workspaceRoot,
        appId:application.appId
    });
    const descriptorPath=path.join(application.appRoot,'arcane-app.json');
    const original=JSON.parse(await readFile(descriptorPath,'utf8'));
    const mutations=[
        ['permissions.capabilities',descriptor=>{
            descriptor.permissions.capabilities=['storage.read'];
        }],
        ['requirements.minimumCoreVersion',descriptor=>{
            descriptor.requirements.minimumCoreVersion='0.8.13';
        }],
        ['native.bundledApps',descriptor=>{
            descriptor.native.bundledApps=['dependency-app'];
        }],
        ['targets',descriptor=>{
            descriptor.targets=['browser','windows-x64'];
        }]
    ];

    for(const [label,mutate] of mutations){
        await t.test(`focused validation rejects ${label} drift`,async()=>{
            const changed=structuredClone(original);
            mutate(changed);
            await writeFile(descriptorPath,`${JSON.stringify(changed,null,2)}\n`);
            await assert.rejects(
                validateDiscoveredApplication({
                    workspaceRoot:discovered.workspaceRoot,
                    workspaceMode:discovered.config.workspaceMode,
                    workspaceConfig:discovered.config,
                    app:discovered.app
                }),
                error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                    &&/canonical descriptor/u.test(error.message),
                label
            );
            await writeFile(descriptorPath,`${JSON.stringify(original,null,2)}\n`);
        });
    }

    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.12',
        protocolVersion:'arcane/1',
        features:Object.freeze([]),
        supportedCapabilities:Object.freeze(['storage.read']),
        supportedMethods:Object.freeze([]),
        canonicalLocation:await realpath(toolchainRoot),
        contentSha256:'e'.repeat(64)
    });
    let buildCalls=0;
    const baseProvider=nativeProvider(toolchainReceipt,{});
    const provider=Object.freeze({
        ...baseProvider,
        build:async()=>{
            buildCalls+=1;
            return {artifactReceipt:Object.freeze({kind:'unexpected-artifact'})};
        }
    });
    for(const [index,[label,mutate]] of mutations.entries()){
        await t.test(`release authority rejects ${label} before creating output`,async()=>{
            const changed=structuredClone(original);
            mutate(changed);
            const outputRoot=path.join(parent,'rejected-output',String(index));
            await assert.rejects(
                createNativeBuildPlan({
                    nativeBuilder:provider,
                    toolchainRoot,
                    toolchainReceipt,
                    appReleaseRoot:application.releaseRoot,
                    appReleaseReceipt:application.releaseReceipt,
                    appDescriptor:changed,
                    outputRoot,
                    targetRequest:{
                        target:'windows-x64',
                        platform:'windows',
                        architecture:'x64',
                        format:'exe',
                        signing:{mode:'unsigned-local-test',profileId:null}
                    }
                }),
                error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                    &&/different canonical app descriptor/u.test(error.message),
                label
            );
            await assert.rejects(lstat(outputRoot),{code:'ENOENT'});
        });
    }
    await t.test('descriptor drift never reaches the native build provider',()=>{
        assert.equal(buildCalls,0);
    });
});

test('native plan binds the provider generation projection and rejects drift before provider work',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-provider-plan-generation-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.12',
        protocolVersion:'arcane/1',
        features:Object.freeze([]),
        supportedCapabilities:Object.freeze([]),
        supportedMethods:Object.freeze([]),
        canonicalLocation:await realpath(toolchainRoot),
        contentSha256:'f'.repeat(64)
    });
    let generation=Object.freeze({
        kind:'arcane-native-provider-generation',
        generationSha256:'1'.repeat(64),
        contentSha256:'2'.repeat(64),
        moduleCount:3,
        canonicalArcaneRoot:'must-not-enter-the-plan'
    });
    let authenticateCalls=0;
    let buildCalls=0;
    const base=nativeProvider(toolchainReceipt,{});
    const provider={
        ...base,
        get providerGeneration(){return generation;},
        authenticateToolchainReceipt:async(...args)=>{
            authenticateCalls+=1;
            return base.authenticateToolchainReceipt(...args);
        },
        build:async()=>{
            buildCalls+=1;
            return {artifactReceipt:Object.freeze({kind:'unexpected-artifact'})};
        }
    };
    const outputRoot=path.join(parent,'generation-output');
    const plan=await createNativeBuildPlan({
        nativeBuilder:provider,
        providerGeneration:generation,
        toolchainRoot,
        toolchainReceipt,
        appReleaseRoot:application.releaseRoot,
        appReleaseReceipt:application.releaseReceipt,
        appDescriptor:application.descriptor,
        outputRoot,
        targetRequest:{
            target:'windows-x64',
            platform:'windows',
            architecture:'x64',
            format:'exe',
            signing:{mode:'unsigned-local-test',profileId:null}
        }
    });
    await t.test('plan stores only the provider generation integrity projection',()=>{
        assert.deepEqual(plan.providerGeneration,{
            kind:'arcane-native-provider-generation',
            generationSha256:'1'.repeat(64),
            contentSha256:'2'.repeat(64),
            moduleCount:3
        });
        assert.deepEqual(Object.keys(plan.providerGeneration),[
            'kind','generationSha256','contentSha256','moduleCount'
        ]);
        assert.equal(authenticateCalls,1);
    });

    generation=Object.freeze({
        ...generation,
        generationSha256:'3'.repeat(64),
        contentSha256:'4'.repeat(64)
    });
    await t.test('provider generation drift stops before authentication, build, or output',async()=>{
        await assert.rejects(
            executeNativeBuildPlan(plan,{expectedNativeBuilder:provider}),
            error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                &&/different native provider module generation/u.test(error.message)
        );
        assert.equal(authenticateCalls,1);
        assert.equal(buildCalls,0);
        await assert.rejects(lstat(outputRoot),{code:'ENOENT'});
    });
});

test('native plan enforces the highest bundled dependency requirements',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-dependency-'});
    const dependency=await prepareNativeRelease(path.join(parent,'dependency'),{
        appId:'dependency-app',
        displayName:'Dependency App',
        mutateDescriptor:descriptor=>{
            descriptor.requirements.minimumCoreVersion='0.8.12';
            descriptor.requirements.features=['dependency.contract'];
        }
    });
    const application=await prepareNativeRelease(path.join(parent,'application'),{
        mutateDescriptor:descriptor=>{
            descriptor.native.bundledApps=[dependency.appId];
        }
    });
    const appDescriptor=application.descriptor;
    const dependencyDescriptor=dependency.descriptor;
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
    await t.test('compatible toolchain binds the dependency and its higher Core floor',async()=>{
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
    });

    const oldReceipt=Object.freeze({...compatibleReceipt,version:'0.8.11'});
    await t.test('older Core is rejected by the dependency minimum',async()=>{
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
    });

    const missingFeatureReceipt=Object.freeze({...compatibleReceipt,features:Object.freeze([])});
    await t.test('missing dependency feature is rejected',async()=>{
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
});

test('native plan execution admits one owner and rejects concurrent or sequential reuse',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-plan-owner-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.12',
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
    await t.test('concurrent execution is rejected while the owner is building',async()=>{
        try{
            await assert.rejects(
                executeNativeBuildPlan(plan),
                error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                    &&/already been attempted/u.test(error.message)
            );
        }finally{
            releaseBuild();
        }
    });
    await t.test('the first execution remains the sole build owner',async()=>{
        const result=await firstExecution;
        assert.equal(result.artifactReceipt.kind,'single-owner-artifact');
        assert.equal(buildCalls,1);
    });
    await t.test('sequential plan reuse is rejected without another build',async()=>{
        await assert.rejects(
            executeNativeBuildPlan(plan),
            error=>error?.code==='ARCANE_INTEGRITY_FAILED'
                &&/already been attempted/u.test(error.message)
        );
        assert.equal(buildCalls,1);
    });
});

test('an injected toolchain plans and builds one native target without changing the default registry',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-native-toolchain-'});
    const application=await prepareNativeRelease(parent);
    const toolchainRoot=path.join(parent,'toolchain');
    await mkdir(toolchainRoot);
    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-native-toolchain',
        version:'0.8.12',
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

    await t.test('paired doctor and prepare use the injected toolchain root',async()=>{
        assert.deepEqual(await toolchain.doctorNative(),{ready:true});
        assert.equal(await toolchain.prepareNative(),toolchainReceipt);
        assert.equal(capture.doctorRequest.toolchainRoot,toolchainRoot);
        assert.equal(capture.prepareRequest.toolchainRoot,toolchainRoot);
    });

    let plan;
    await t.test('planning binds the target and emits the complete lifecycle',async()=>{
        plan=await toolchain.plan({onEvent:event=>events.push(event)});
        assert.deepEqual(plan.targetRequest,targetRequest);
        assert.equal(plan.app.id,application.appId);
        assert.deepEqual(
            events.map(event=>event.type),
            ['plan.started','native.plan.started','native.plan.completed','plan.completed']
        );
    });
    await t.test('target discovery exposes only the paired native target',async()=>{
        const pairedTargets=(await toolchain.targets()).targets;
        assert.equal(pairedTargets.find(target=>target.id==='windows-x64').status,'available');
        assert.equal(pairedTargets.find(target=>target.id==='linux-x64').status,'pairing-required');
    });

    events.length=0;
    let built;
    await t.test('build returns the canonical target and verified artifact result',async()=>{
        built=await toolchain.build({
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
    });
    await t.test('build provider receives canonical release inputs without source authority',async()=>{
        assert.equal(capture.request.toolchainRoot,canonicalToolchainRoot);
        assert.equal(capture.request.appReleaseRoot,await realpath(application.releaseRoot));
        for(const withheld of ['workspaceRoot','appRoot','protectedRoots','nativeBuilder']){
            assert.equal(Object.hasOwn(capture.request,withheld),false,withheld);
        }
    });
    await t.test('build emits the complete commit and verification lifecycle',()=>{
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
    });

    await t.test('explicit native verification returns the provider result',async()=>{
        const verifiedArtifact=await toolchain.verifyNative({
            artifactReceipt:built.artifactReceipt
        });
        assert.equal(verifiedArtifact.artifactReceipt,built.artifactReceipt);
        assert.equal(capture.verifyRequest.artifactReceipt,built.artifactReceipt);
        assert.equal(verifiedArtifact.verification.verified,true);
    });

    await t.test('native run forwards the verified artifact and withholds source authority',async()=>{
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
    });
    await t.test('native run requires an artifact receipt',async()=>{
        await assert.rejects(
            toolchain.run(),
            error=>error?.code==='ARCANE_INTEGRITY_FAILED'
        );
    });

    await t.test('post-commit event failure degrades delivery without losing the artifact',async()=>{
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
    });

    await t.test('pre-commit event failure stops before another provider build',async()=>{
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
    });

    await t.test('a plan cannot move to a differently paired provider',async()=>{
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
    });

    await t.test('a plan cannot move to a differently targeted toolchain',async()=>{
        const differentTargetToolchain=createToolchain({
            target:'linux-x64',
            nativeBuilder:provider,
            toolchainRoot,
            toolchainReceipt,
            targetRequest:{
                target:'linux-x64',
                platform:'linux',
                architecture:'x64',
                format:'deb',
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
    });

    await t.test('injection does not change the default native target registry',async()=>{
        const defaultAdapter=getTargetAdapter('windows-x64');
        assert.equal((await defaultAdapter.describe()).status,'pairing-required');
        await assert.rejects(
            defaultAdapter.build({target:'windows-x64'}),
            error=>error?.code==='ARCANE_TARGET_DEFERRED'
        );
    });

    await t.test('unpaired toolchain defers doctor, prepare, verify, and run operations',async()=>{
        const unpaired=createToolchain({target:'windows-x64',targetRequest});
        assert.equal((await unpaired.doctorNative()).status,'pairing-required');
        for(const operation of [
            ()=>unpaired.prepareNative(),
            ()=>unpaired.verifyNative({artifactReceipt:built.artifactReceipt}),
            ()=>unpaired.run({artifactReceipt:built.artifactReceipt})
        ]){
            await assert.rejects(operation,error=>error?.code==='ARCANE_TARGET_DEFERRED');
        }
    });
});
