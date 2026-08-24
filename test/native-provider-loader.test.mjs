import assert from 'node:assert/strict';
import {cp,lstat,mkdir,readFile,realpath,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from '../src/testing.mjs';
import {
    ARCANE_NATIVE_PROVIDER_PATHS,
    ARCANE_PORTABLE_PROVIDER_PATH,
    loadArcaneNativeProvider,
    loadArcanePortableProvider
} from '../src/native-provider-loader.mjs';
import {createNativeTargetRequest,runCli} from '../src/cli/main.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {createWorkspace,initWorkspace} from '../src/scaffold.mjs';
import {
    assertIntegratedNativeToolchain,
    assertIntegratedPortableToolchain,
    assertPortableToolchainCompatibility,
    buildApplication,
    describeTargets,
    resolveNativeBuildOutputRoot,
    resolvePortableBuildOutputRoot,
    runApplication
} from '../src/toolchain.mjs';
import {parseNdjson,repositoryRoot,temporaryDirectory} from './helpers.mjs';

function provider(targets=['portable']){
    const operation=async()=>({});
    return Object.freeze({
        protocol:'arcane-native-builder/1',
        describe:async()=>({protocol:'arcane-native-builder/1',targets}),
        doctor:operation,
        prepare:operation,
        authenticateToolchainReceipt:operation,
        build:operation,
        verify:operation,
        run:operation
    });
}

function memoryStream(){
    let value='';
    return {
        write(chunk){value+=chunk.toString();return true;},
        read(){return value;}
    };
}

test('loader imports only the fixed allowlisted provider path for every native target',async t=>{
    const arcaneRoot=await temporaryDirectory(t,{prefix:'arcane-provider-loader-'});
    const canonicalArcaneRoot=await realpath(arcaneRoot);
    await t.test('portable alias and Linux architectures share their fixed paths',()=>{
        assert.equal(ARCANE_NATIVE_PROVIDER_PATHS.portable,ARCANE_PORTABLE_PROVIDER_PATH);
        assert.equal(ARCANE_NATIVE_PROVIDER_PATHS['linux-x64'],ARCANE_NATIVE_PROVIDER_PATHS['linux-arm64']);
    });
    for(const relativeProviderPath of new Set(Object.values(ARCANE_NATIVE_PROVIDER_PATHS))){
        const fixedProviderPath=path.join(canonicalArcaneRoot,...relativeProviderPath);
        await mkdir(path.dirname(fixedProviderPath),{recursive:true});
        await writeFile(fixedProviderPath,'export default {};\n','utf8');
    }
    for(const [target,relativeProviderPath] of Object.entries(ARCANE_NATIVE_PROVIDER_PATHS)){
        await t.test(`${target} imports and binds only its allowlisted provider`,async()=>{
            const fixedProviderPath=path.join(canonicalArcaneRoot,...relativeProviderPath);
            const expectedProvider=provider([target]);
            let importedSpecifier;
            const loaded=await loadArcaneNativeProvider({
                arcaneRoot,
                target,
                importModule:async specifier=>{
                    importedSpecifier=specifier;
                    return {arcaneNativeBuilderProvider:expectedProvider};
                }
            });
            assert.equal(importedSpecifier,pathToFileURL(fixedProviderPath).href);
            assert.notEqual(loaded.nativeBuilder,expectedProvider);
            assert.equal(loaded.nativeBuilder.protocol,expectedProvider.protocol);
            assert.equal(typeof loaded.nativeBuilder.build,'function');
            assert.equal(loaded.nativeBuilder.providerGeneration,loaded.providerGeneration);
            assert.match(loaded.providerGeneration.generationSha256,/^[a-f0-9]{64}$/u);
            assert.equal(loaded.providerPath,fixedProviderPath);
            assert.equal(loaded.toolchainRoot,canonicalArcaneRoot);
        });
    }

    await t.test('portable convenience loader resolves the portable allowlist entry',async()=>{
        const portable=await loadArcanePortableProvider({
            arcaneRoot,
            importModule:async()=>({arcaneNativeBuilderProvider:provider()})
        });
        assert.equal(portable.providerPath,path.join(canonicalArcaneRoot,...ARCANE_PORTABLE_PROVIDER_PATH));
    });
});

test('loader rejects an Arcane checkout reached through a linked ancestor',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-provider-linked-root-'});
    const realParent=path.join(parent,'real-parent');
    const arcaneRoot=path.join(realParent,'arcane');
    const providerPath=path.join(arcaneRoot,...ARCANE_PORTABLE_PROVIDER_PATH);
    await mkdir(path.dirname(providerPath),{recursive:true});
    await writeFile(providerPath,'export default {};\n','utf8');
    const linkedParent=path.join(parent,'linked-parent');
    await symlink(realParent,linkedParent,process.platform==='win32'?'junction':'dir');

    await assert.rejects(
        ()=>loadArcanePortableProvider({
            arcaneRoot:path.join(linkedParent,'arcane'),
            importModule:async()=>({arcaneNativeBuilderProvider:provider()})
        }),
        error=>error.code==='ARCANE_TARGET_UNAVAILABLE'
            &&/linked or non-directory ancestor/u.test(error.message)
    );
});

test('loader fails honestly when the provider is absent or violates the protocol',async t=>{
    const arcaneRoot=await temporaryDirectory(t,{prefix:'arcane-provider-missing-'});
    await t.test('absent provider reports target unavailable',async()=>{
        await assert.rejects(
            ()=>loadArcanePortableProvider({arcaneRoot}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/does not contain/u.test(error.message)
        );
    });

    const providerPath=path.join(arcaneRoot,...ARCANE_PORTABLE_PROVIDER_PATH);
    await mkdir(path.dirname(providerPath),{recursive:true});
    await writeFile(providerPath,'export default {};\n','utf8');
    await t.test('protocol-invalid provider reports target unavailable',async()=>{
        await assert.rejects(
            ()=>loadArcanePortableProvider({arcaneRoot,importModule:async()=>({default:{}})}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/arcane-native-builder\/1/u.test(error.message)
        );
    });
});

test('CLI requires an explicit Arcane root whenever it pairs a native provider',async t=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    let loadCalls=0;
    let execution;
    const execute=async(command,options)=>{
        execution={command,options};
        return {ready:true};
    };
    const loadNativeProvider=async({arcaneRoot,target})=>{
        loadCalls+=1;
        assert.equal(target,'portable');
        return {
            nativeBuilder:provider(),
            toolchainRoot:arcaneRoot
        };
    };

    await t.test('missing Arcane root fails before provider loading',async()=>{
        const missing=await runCli(
            ['native-doctor','--target','portable','--output','ndjson'],
            {stdout,stderr,execute,loadNativeProvider}
        );
        assert.equal(missing,1);
        assert.match(stdout.read(),/requires --arcane-root/u);
        assert.equal(loadCalls,0);
    });

    await t.test('explicit Arcane root pairs a canonical portable prepare request',async()=>{
        const secondStdout=memoryStream();
        const secondStderr=memoryStream();
        const result=await runCli(
            [
                'native-prepare','--target','portable',
                '--arcane-root','C:\\Arcane',
                '--output','ndjson'
            ],
            {
                cwd:'C:\\workspace',
                stdout:secondStdout,
                stderr:secondStderr,
                execute,
                loadNativeProvider
            }
        );
        assert.equal(result,0,secondStdout.read());
        assert.equal(loadCalls,1);
        assert.equal(execution.command,'native-prepare');
        assert.equal(execution.options.target,'portable');
        assert.equal(execution.options.targetRequest.format,'portable');
        assert.equal(execution.options.targetRequest.signing.mode,'unsigned-local-test');
        assert.equal(execution.options.nativeBuilder.protocol,'arcane-native-builder/1');
        assert.match(execution.options.toolchainRoot,/Arcane$/u);
    });
});

test('CLI pairs Windows and Linux x64 builds with canonical truthful requests',async t=>{
    const stdout=memoryStream();
    const stderr=memoryStream();
    const executions=[];
    const loadCalls=[];
    const loadNativeProvider=async({arcaneRoot,target})=>{
        loadCalls.push({arcaneRoot,target});
        return {
            nativeBuilder:provider([target]),
            toolchainRoot:arcaneRoot
        };
    };
    const execute=async(command,options)=>{
        executions.push({command,options});
        return {target:options.target};
    };

    await t.test('native build without an Arcane root fails before provider loading',async()=>{
        const missingRoot=await runCli(
            ['build','--target','linux-x64','--output','ndjson'],
            {stdout,stderr,execute,loadNativeProvider}
        );
        assert.equal(missingRoot,1);
        assert.match(stdout.read(),/requires --arcane-root/u);
        assert.equal(loadCalls.length,0);
    });

    for(const expected of [
        {target:'windows-x64',platform:'windows',architecture:'x64',format:'exe'},
        {target:'linux-x64',platform:'linux',architecture:'x64',format:'deb'}
    ]){
        await t.test(`${expected.target} build uses its canonical request`,async()=>{
            const operationStdout=memoryStream();
            assert.equal(await runCli(
                [
                    'build','--target',expected.target,'--arcane-root','C:\\Arcane',
                    '--output','ndjson'
                ],
                {stdout:operationStdout,stderr:memoryStream(),execute,loadNativeProvider}
            ),0,operationStdout.read());
            const request=executions.at(-1).options.targetRequest;
            assert.deepEqual(request,{
                target:expected.target,
                platform:expected.platform,
                architecture:expected.architecture,
                format:expected.format,
                signing:{mode:'unsigned-local-test',profileId:null}
            });
            assert.equal(executions.at(-1).options.nativeBuilder.protocol,'arcane-native-builder/1');
        });
    }
    await t.test('provider loading follows the requested target order',()=>{
        assert.deepEqual(loadCalls.map(call=>call.target),['windows-x64','linux-x64']);
    });
});

test('canonical CLI target requests bind every implemented format and signing profile',async t=>{
    await t.test('Windows x64 binds unsigned EXE',()=>{
        assert.deepEqual(createNativeTargetRequest({target:'windows-x64'}),{
            target:'windows-x64',
            platform:'windows',
            architecture:'x64',
            format:'exe',
            signing:{mode:'unsigned-local-test',profileId:null}
        });
    });
    await t.test('Linux x64 binds unsigned DEB',()=>{
        assert.deepEqual(createNativeTargetRequest({target:'linux-x64'}),{
            target:'linux-x64',
            platform:'linux',
            architecture:'x64',
            format:'deb',
            signing:{mode:'unsigned-local-test',profileId:null}
        });
    });
    await t.test('Linux x64 rejects an AppImage override',()=>{
        assert.throws(
            ()=>createNativeTargetRequest({target:'linux-x64',format:'appimage'}),
            error=>error.code==='ARCANE_USAGE'&&/does not support --format/u.test(error.message)
        );
    });
    await t.test('Linux arm64 binds unsigned DEB',()=>{
        assert.deepEqual(createNativeTargetRequest({target:'linux-arm64'}),{
            target:'linux-arm64',platform:'linux',architecture:'arm64',format:'deb',
            signing:{mode:'unsigned-local-test',profileId:null}
        });
    });
    await t.test('Android arm64 binds development APK signing',()=>{
        assert.deepEqual(createNativeTargetRequest({target:'android-arm64'}),{
            target:'android-arm64',platform:'android',architecture:'arm64',format:'apk',
            signing:{mode:'development',profileId:'arcane-android-development-v1'}
        });
    });
});

test('portable run rejects before workspace, package, toolchain, build, verify, or launch work',async t=>{
    const workspaceRoot=path.join(await temporaryDirectory(t,{prefix:'arcane-portable-run-'}),'workspace');
    await createWorkspace({targetPath:workspaceRoot,appId:'portable-run-app',target:'portable'});
    const calls=[];
    const operation=name=>async()=>{calls.push(name);return {};};
    const nativeBuilder=Object.freeze({
        protocol:'arcane-native-builder/1',
        describe:operation('describe'),
        doctor:operation('doctor'),
        prepare:operation('prepare'),
        authenticateToolchainReceipt:operation('authenticate'),
        build:operation('build'),
        verify:operation('verify'),
        run:operation('run')
    });
    const stdout=memoryStream();
    const exitCode=await runCli([
        'run','--target','portable','--workspace',workspaceRoot,
        '--arcane-root',path.dirname(workspaceRoot),'--output','ndjson'
    ],{
        stdout,
        stderr:memoryStream(),
        loadNativeProvider:async()=>({nativeBuilder,toolchainRoot:path.dirname(workspaceRoot)})
    });
    const events=parseNdjson(stdout.read());
    await t.test('portable run reports unsupported without calling the provider',()=>{
        assert.equal(exitCode,1,stdout.read());
        assert.deepEqual(calls,[]);
        assert.equal(events.at(-1).data.error.code,'ARCANE_NATIVE_RUN_UNSUPPORTED');
    });
    await t.test('portable run emits no package or native work events',()=>{
        assert.equal(events.some(event=>event.type.startsWith('package.')),false);
        assert.equal(events.some(event=>event.type.startsWith('native.')),false);
    });
    await t.test('portable run creates neither dist nor build output',async()=>{
        for(const relative of ['dist','build']){
            await assert.rejects(lstat(path.join(workspaceRoot,relative)),error=>error?.code==='ENOENT');
        }
    });
});

test('target pairing requires the provider to declare the selected target',async t=>{
    await t.test('undeclared target is unavailable',async()=>{
        await assert.rejects(
            ()=>describeTargets({target:'windows-x64',nativeBuilder:provider()}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/does not declare support/u.test(error.message)
        );
    });
    await t.test('declared target is available',async()=>{
        const paired=await describeTargets({target:'portable',nativeBuilder:provider()});
        assert.equal(paired.targets.find(item=>item.id==='portable').status,'available');
    });
});

test('integrated portable builds require an explicit external output root',async t=>{
    const integratedRoot=path.resolve('integrated-arcane-workspace');
    const externalRoot=path.resolve('external-arcane-workspace');
    await t.test('integrated portable output must be explicit',()=>{
        assert.throws(
            ()=>resolvePortableBuildOutputRoot({
                workspaceMode:'integrated',
                workspaceRoot:integratedRoot
            }),
            error=>error.code==='ARCANE_USAGE'&&/requires --output-root/u.test(error.message)
        );
    });
    await t.test('external workspaces default portable and native output under build',()=>{
        assert.equal(
            resolvePortableBuildOutputRoot({
                workspaceMode:'external',
                workspaceRoot:externalRoot
            }),
            path.join(externalRoot,'build','portable')
        );
        assert.equal(
            resolveNativeBuildOutputRoot({
                target:'windows-x64',
                workspaceMode:'external',
                workspaceRoot:externalRoot
            }),
            path.join(externalRoot,'build','windows-x64')
        );
    });
    for(const relative of ['.git','apps','apps/unrelated-app','dist','node_modules']){
        await t.test(`external native output rejects reserved ${relative} path`,()=>{
            assert.throws(
                ()=>resolveNativeBuildOutputRoot({
                    target:'windows-x64',
                    workspaceMode:'external',
                    workspaceRoot:externalRoot,
                    outputRoot:path.join(externalRoot,...relative.split('/'))
                }),
                error=>error.code==='ARCANE_POLICY_DENIED'&&/dedicated build\/ namespace/u.test(error.message),
                relative
            );
        });
    }
    await t.test('integrated native output must be outside the Arcane checkout',()=>{
        assert.throws(
            ()=>resolveNativeBuildOutputRoot({
                target:'windows-x64',
                workspaceMode:'integrated',
                workspaceRoot:integratedRoot,
                outputRoot:path.join(integratedRoot,'build','windows-x64')
            }),
            error=>error.code==='ARCANE_POLICY_DENIED'&&/must be outside/u.test(error.message)
        );
    });
    await t.test('integrated portable toolchain accepts the same checkout',()=>{
        assert.doesNotThrow(()=>assertIntegratedPortableToolchain({
            workspaceMode:'integrated',
            workspaceRoot:integratedRoot,
            toolchainRoot:integratedRoot
        }));
    });
    await t.test('integrated portable toolchain rejects another checkout',()=>{
        assert.throws(
            ()=>assertIntegratedPortableToolchain({
                workspaceMode:'integrated',
                workspaceRoot:integratedRoot,
                toolchainRoot:path.resolve('different-arcane-workspace')
            }),
            error=>error.code==='ARCANE_POLICY_DENIED'&&/same Arcane OS checkout/u.test(error.message)
        );
    });
    await t.test('integrated native toolchain accepts the same checkout',()=>{
        assert.doesNotThrow(()=>assertIntegratedNativeToolchain({
            target:'windows-x64',
            workspaceMode:'integrated',
            workspaceRoot:integratedRoot,
            toolchainRoot:integratedRoot
        }));
    });
});

test('portable compatibility accepts newer compatible Core and rejects missing requirements',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-portable-compatibility-'});
    const workspaceRoot=path.join(parent,'workspace');
    const appId='compatibility-app';
    await createWorkspace({targetPath:workspaceRoot,appId,displayName:'Compatibility App'});
    const descriptor=JSON.parse(await readFile(
        path.join(workspaceRoot,'apps',appId,'arcane-app.json'),
        'utf8'
    ));
    const prepared={
        workspaceMode:'external',
        runtimeReceipt:{source:{bundleVersion:'0.8.12'}},
        descriptor:{
            ...descriptor,
            requirements:{
                ...descriptor.requirements,
                arcaneProtocol:'arcane/1',
                minimumCoreVersion:'0.8.10',
                features:['app.receipts']
            },
            permissions:{
                capabilities:['storage.read'],
                methods:['storage.list']
            }
        }
    };
    const compatible={
        version:'0.8.12',
        protocolVersion:'arcane/1',
        features:['app.receipts'],
        supportedCapabilities:['storage.read'],
        supportedMethods:['storage.list']
    };
    await t.test('compatible Core satisfies every portable requirement',()=>{
        assert.doesNotThrow(()=>assertPortableToolchainCompatibility({prepared,toolchainReceipt:compatible}));
    });
    await t.test('installed runtime raises the external workspace Core floor',()=>{
        assert.throws(
            ()=>assertPortableToolchainCompatibility({prepared,toolchainReceipt:{...compatible,version:'0.8.10'}}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/required minimum 0\.8\.12/u.test(error.message)
        );
    });
    await t.test('current Core raises the integrated workspace Core floor',()=>{
        assert.throws(
            ()=>assertPortableToolchainCompatibility({
                prepared:{
                    ...prepared,
                    workspaceMode:'integrated',
                    runtimeReceipt:null
                },
                toolchainReceipt:{...compatible,version:'0.8.10'}
            }),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/required minimum 0\.8\.12/u.test(error.message)
        );
    });
    await t.test('protocol mismatch is unavailable',()=>{
        assert.throws(
            ()=>assertPortableToolchainCompatibility({prepared,toolchainReceipt:{...compatible,protocolVersion:'arcane/2'}}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/requires arcane\/1/u.test(error.message)
        );
    });
    await t.test('missing feature is unavailable',()=>{
        assert.throws(
            ()=>assertPortableToolchainCompatibility({prepared,toolchainReceipt:{...compatible,features:[]}}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/required features: app\.receipts/u.test(error.message)
        );
    });
    await t.test('missing capability is unavailable',()=>{
        assert.throws(
            ()=>assertPortableToolchainCompatibility({prepared,toolchainReceipt:{...compatible,supportedCapabilities:[]}}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/required capabilities: storage\.read/u.test(error.message)
        );
    });
    await t.test('missing method is unavailable',()=>{
        assert.throws(
            ()=>assertPortableToolchainCompatibility({prepared,toolchainReceipt:{...compatible,supportedMethods:[]}}),
            error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&/required methods: storage\.list/u.test(error.message)
        );
    });
});

test('paired CLI build packages one selected app and its exact dependency closure as verified readers',async t=>{
    const parent=await temporaryDirectory(t,{prefix:'arcane-portable-cli-'});
    const workspaceRoot=path.join(parent,'workspace');
    const toolchainRoot=path.join(parent,'arcane');
    const appId='portable-app';
    await createWorkspace({targetPath:workspaceRoot,appId,displayName:'Portable App'});
    await initWorkspace({
        workspaceRoot,
        appId:'portable-dependency',
        displayName:'Portable Dependency',
        target:'portable'
    });
    await mkdir(toolchainRoot);

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

    const appRoot=path.join(workspaceRoot,'apps',appId);
    const descriptorPath=path.join(appRoot,'arcane-app.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    descriptor.native.icon='img/icon.png';
    descriptor.package.include.push('img');
    descriptor.package.include.sort();
    descriptor.native.bundledApps=['portable-dependency'];
    descriptor.targets=['portable','windows-x64'];
    await mkdir(path.join(appRoot,'img'));
    await writeFile(path.join(appRoot,'img','icon.png'),'portable icon bytes\n');
    await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`);
    await writeFile(
        path.join(appRoot,'arcane-package.json'),
        `${JSON.stringify(projectPackageManifest(descriptor),null,2)}\n`
    );
    const dependencyRoot=path.join(workspaceRoot,'apps','portable-dependency');
    const dependencyDescriptorPath=path.join(dependencyRoot,'arcane-app.json');
    const dependencyDescriptor=JSON.parse(await readFile(dependencyDescriptorPath,'utf8'));
    dependencyDescriptor.targets=[...new Set([...dependencyDescriptor.targets,'windows-x64'])].sort();
    await writeFile(dependencyDescriptorPath,`${JSON.stringify(dependencyDescriptor,null,2)}\n`);
    await writeFile(
        path.join(dependencyRoot,'arcane-package.json'),
        `${JSON.stringify(projectPackageManifest(dependencyDescriptor),null,2)}\n`
    );

    const canonicalToolchainRoot=await realpath(toolchainRoot);
    const canonicalWorkspaceRoot=await realpath(workspaceRoot);
    const toolchainReceipt=Object.freeze({
        kind:'arcane-portable-toolchain',
        version:'0.8.12',
        protocolVersion:'arcane/1',
        features:Object.freeze([]),
        supportedCapabilities:Object.freeze([]),
        supportedMethods:Object.freeze([]),
        canonicalLocation:canonicalToolchainRoot,
        contentSha256:'b'.repeat(64)
    });
    const artifactReceipt=Object.freeze({kind:'synthetic-portable-artifact'});
    const capture={};
    const nativeBuilder=Object.freeze({
        protocol:'arcane-native-builder/1',
        describe:async()=>({protocol:'arcane-native-builder/1',targets:['portable']}),
        doctor:async()=>({ready:true}),
        prepare:async request=>{
            capture.prepare=request;
            return toolchainReceipt;
        },
        authenticateToolchainReceipt:async(receipt,{toolchainRoot:root})=>{
            assert.equal(receipt,toolchainReceipt);
            assert.equal(root,canonicalToolchainRoot);
            return receipt;
        },
        build:async request=>{
            capture.build=request;
            const file=request.appReleaseReceipt.files.find(item=>item.path.endsWith('/index.html'))
                ??request.appReleaseReceipt.files[0];
            capture.readPath=file.path;
            capture.readBytes=await request.readAppReleaseFile(file.path);
            const dependency=request.dependencyReleases[0];
            const dependencyFile=dependency.appReleaseReceipt.files.find(item=>item.path.endsWith('/index.html'))
                ??dependency.appReleaseReceipt.files[0];
            capture.dependencyBytes=await dependency.readFile(dependencyFile.path);
            return {artifactReceipt};
        },
        verify:async request=>{
            capture.verify=request;
            return {verified:true};
        },
        run:async request=>{
            capture.run=request;
            return {running:true};
        }
    });
    const stdout=memoryStream();
    const stderr=memoryStream();

    await t.test('portable build succeeds without stderr',async()=>{
        const exitCode=await runCli(
            [
                'build','--target','portable',
                '--workspace',workspaceRoot,
                '--app',appId,
                '--arcane-root',toolchainRoot,
                '--output','ndjson'
            ],
            {
                stdout,
                stderr,
                loadNativeProvider:async()=>({
                    nativeBuilder,
                    toolchainRoot:canonicalToolchainRoot
                })
            }
        );
        assert.equal(exitCode,0,stdout.read());
        assert.equal(stderr.read(),'');
    });
    await t.test('portable build uses canonical toolchain, app, and output roots',()=>{
        assert.equal(capture.prepare.toolchainRoot,canonicalToolchainRoot);
        assert.equal(capture.build.appDescriptor.id,appId);
        assert.equal(capture.build.outputRoot,path.join(canonicalWorkspaceRoot,'build','portable'));
    });
    await t.test('portable build exposes exactly one verified dependency reader',()=>{
        assert.equal(capture.build.dependencyReleases.length,1);
        assert.equal(capture.build.dependencyReleases[0].appDescriptor.id,'portable-dependency');
        assert.equal(Object.hasOwn(capture.build.dependencyReleases[0],'workspaceRoot'),false);
        assert.equal(Object.hasOwn(capture.build.dependencyReleases[0],'appRoot'),false);
        assert.ok(capture.dependencyBytes.length>0);
    });
    await t.test('portable build exposes release readers without source paths',()=>{
        assert.equal(Object.hasOwn(capture.build,'workspaceRoot'),false);
        assert.equal(Object.hasOwn(capture.build,'appRoot'),false);
        assert.equal(typeof capture.build.readAppReleaseFile,'function');
        assert.equal(capture.readBytes.length,capture.build.appReleaseReceipt.files
            .find(item=>item.path===capture.readPath).bytes);
        assert.equal(capture.verify.artifactReceipt,artifactReceipt);
    });
    await t.test('portable build reports authenticated refresh validation and the exact packaged closure',()=>{
        const events=parseNdjson(stdout.read());
        assert.equal(events.filter(event=>event.type==='workspace.validate.started').length,7);
        assert.equal(events.filter(event=>event.type==='runtime.verify.started').length,1);
        assert.equal(events.filter(event=>event.type==='sdk-browser-runtime.verify.started').length,1);
        assert.equal(events.filter(event=>event.type==='workspace.runtime.verify.started').length,1);
        assert.equal(events.filter(event=>event.type==='shared-payload.snapshot.started').length,1);
        assert.equal(events.filter(event=>event.type==='runtime.snapshot.verified').length,1);
        assert.equal(events.filter(event=>event.type==='workspace.application.validated').length,8);
        assert.equal(events.at(-1).data.result.artifactReceipt.kind,'synthetic-portable-artifact');
        assert.equal(events.at(-1).data.result.release.receipt.kind,'arcane-app-release-verification');
        assert.deepEqual(
            events.at(-1).data.result.dependencyReleases.map(item=>item.appId),
            ['portable-dependency']
        );
    });

    await t.test('portable build reuses one runtime receipt and rejects a post-verification tamper',async()=>{
        const tamperPath=path.join(installedRoot,'runtime','arcane','modules','MD.js');
        const original=await readFile(tamperPath);
        const events=[];
        let tampered=false;
        let nativeBuildCalled=false;
        const tamperProvider=Object.freeze({
            ...nativeBuilder,
            build:async request=>{
                nativeBuildCalled=true;
                return nativeBuilder.build(request);
            }
        });
        try{
            await assert.rejects(
                buildApplication({
                    target:'portable',
                    targetRequest:createNativeTargetRequest({target:'portable'}),
                    workspaceRoot,
                    appId,
                    toolchainRoot:canonicalToolchainRoot,
                    nativeBuilder:tamperProvider,
                    onEvent:async event=>{
                        events.push(event);
                        if(event.type==='runtime.snapshot.verified'&&!tampered){
                            tampered=true;
                            await writeFile(tamperPath,Buffer.concat([original,Buffer.from('\n// tampered\n')]));
                        }
                    }
                }),
                /runtime file changed after verification/i
            );
        }finally{
            await writeFile(tamperPath,original);
        }
        assert.equal(tampered,true);
        assert.equal(nativeBuildCalled,false);
        assert.equal(events.filter(event=>event.type==='runtime.verify.started').length,1);
        assert.equal(events.filter(event=>event.type==='sdk-browser-runtime.verify.started').length,1);
        assert.equal(events.filter(event=>event.type==='workspace.runtime.verify.started').length,1);
    });

    await t.test('portable run rejects before another prepare, package, build, or launch',async()=>{
        const runStdout=memoryStream();
        const priorPrepareRequest=capture.prepare;
        const priorBuildForRun=capture.build;
        const runExitCode=await runCli(
            [
                'run','--target','portable',
                '--workspace',workspaceRoot,
                '--app',appId,
                '--arcane-root',toolchainRoot,
                '--output','ndjson'
            ],
            {
                stdout:runStdout,
                stderr:memoryStream(),
                loadNativeProvider:async()=>({nativeBuilder,toolchainRoot:canonicalToolchainRoot})
            }
        );
        assert.equal(runExitCode,1,runStdout.read());
        assert.equal(capture.prepare,priorPrepareRequest);
        assert.equal(capture.build,priorBuildForRun);
        assert.equal(capture.run,undefined);
        const runEvents=parseNdjson(runStdout.read());
        assert.equal(runEvents.at(-1).data.error.code,'ARCANE_NATIVE_RUN_UNSUPPORTED');
        assert.equal(runEvents.some(event=>event.type.startsWith('package.')),false);
        assert.equal(runEvents.some(event=>event.type.startsWith('native.build.')),false);
    });

    const windowsRequest=createNativeTargetRequest({target:'windows-x64'});
    const committedArtifact=Object.freeze({kind:'synthetic-windows-artifact',generation:'commit'});
    const commitEventFailure=new Error('The native run event sink rejected commit delivery.');
    let committedSignal;
    let launchedAfterCommitFailure=false;
    const commitFailureProvider=Object.freeze({
        ...nativeBuilder,
        describe:async()=>({protocol:'arcane-native-builder/1',targets:['windows-x64']}),
        build:async request=>{
            committedSignal=request.signal;
            return {artifactReceipt:committedArtifact};
        },
        verify:async()=>({verified:true}),
        run:async()=>{
            launchedAfterCommitFailure=true;
            return {running:true};
        }
    });
    await t.test('commit event failure aborts the build signal before launch',async()=>{
        await assert.rejects(
            runApplication({
                target:'windows-x64',
                targetRequest:windowsRequest,
                workspaceRoot,
                appId,
                toolchainRoot:canonicalToolchainRoot,
                nativeBuilder:commitFailureProvider,
                onEvent:event=>{
                    if(event.type==='native.build.committed')throw commitEventFailure;
                }
            }),
            error=>error===commitEventFailure
        );
        assert.equal(committedSignal.aborted,true);
        assert.equal(launchedAfterCommitFailure,false);
    });

    const launchedArtifact=Object.freeze({kind:'synthetic-windows-artifact',generation:'launch'});
    const launchEventFailure=new Error('The native run event sink rejected process delivery.');
    let launched=false;
    let launchCleaned=false;
    let launchSignalAborted=false;
    const launchFailureProvider=Object.freeze({
        ...commitFailureProvider,
        build:async()=>({artifactReceipt:launchedArtifact}),
        run:async({signal,onEvent})=>{
            launched=true;
            try{
                await onEvent({type:'native.process.started'});
                return {running:true};
            }finally{
                launchSignalAborted=signal.aborted;
                launchCleaned=true;
            }
        }
    });
    await t.test('process event failure aborts and cleans the launched process',async()=>{
        await assert.rejects(
            runApplication({
                target:'windows-x64',
                targetRequest:windowsRequest,
                workspaceRoot,
                appId,
                toolchainRoot:canonicalToolchainRoot,
                nativeBuilder:launchFailureProvider,
                onEvent:event=>{
                    if(event.type==='native.process.started')throw launchEventFailure;
                }
            }),
            error=>error===launchEventFailure
        );
        assert.equal(launched,true);
        assert.equal(launchCleaned,true);
        assert.equal(launchSignalAborted,true);
    });

    await t.test('authenticated toolchain downgrade is rejected before another build',async()=>{
    const mismatchStdout=memoryStream();
    const spoofedReceipt=Object.freeze({...toolchainReceipt,version:'0.8.12'});
    const mismatchedProvider=Object.freeze({
        ...nativeBuilder,
        prepare:async()=>spoofedReceipt,
        authenticateToolchainReceipt:async(receipt,{toolchainRoot:root})=>{
            assert.equal(receipt,spoofedReceipt);
            assert.equal(root,canonicalToolchainRoot);
            return Object.freeze({...toolchainReceipt,version:'0.8.10'});
        }
    });
    const priorBuildRequest=capture.build;
    const mismatch=await runCli(
        [
            'build','--target','portable',
            '--workspace',workspaceRoot,
            '--app',appId,
            '--arcane-root',toolchainRoot,
            '--output','ndjson'
        ],
        {
            stdout:mismatchStdout,
            stderr:memoryStream(),
            loadNativeProvider:async()=>(
                {nativeBuilder:mismatchedProvider,toolchainRoot:canonicalToolchainRoot}
            )
        }
    );
    assert.equal(mismatch,1);
    assert.equal(capture.build,priorBuildRequest);
    const mismatchEvents=parseNdjson(mismatchStdout.read());
    assert.equal(mismatchEvents.at(-1).data.error.code,'ARCANE_TARGET_UNAVAILABLE');
    assert.match(mismatchEvents.at(-1).data.error.message,/0\.8\.10.*required minimum 0\.8\.12/u);
    });

    await t.test('output overlapping the toolchain is rejected',async()=>{
    const rejectedStdout=memoryStream();
    const rejected=await runCli(
        [
            'build','--target','portable',
            '--workspace',workspaceRoot,
            '--app',appId,
            '--arcane-root',toolchainRoot,
            '--output-root',path.join(toolchainRoot,'nested-output'),
            '--output','ndjson'
        ],
        {
            stdout:rejectedStdout,
            stderr:memoryStream(),
            loadNativeProvider:async()=>({
                nativeBuilder,
                toolchainRoot:canonicalToolchainRoot
            })
        }
    );
    assert.equal(rejected,1);
    const rejectedEvents=parseNdjson(rejectedStdout.read());
    assert.equal(rejectedEvents.at(-1).data.error.code,'ARCANE_POLICY_DENIED');
    assert.match(rejectedEvents.at(-1).data.error.message,/must not overlap/u);
    });

    await t.test('linked output is rejected before package or prepare work',async()=>{
    const linkedOutput=path.join(parent,'linked-output');
    await symlink(
        path.join(workspaceRoot,'apps'),
        linkedOutput,
        process.platform==='win32'?'junction':'dir'
    );
    const linkedStdout=memoryStream();
    const prepareBeforeLinkedOutput=capture.prepare;
    const linked=await runCli([
        'build','--target','portable','--workspace',workspaceRoot,'--app',appId,
        '--arcane-root',toolchainRoot,'--output-root',linkedOutput,'--output','ndjson'
    ],{
        stdout:linkedStdout,
        stderr:memoryStream(),
        loadNativeProvider:async()=>({nativeBuilder,toolchainRoot:canonicalToolchainRoot})
    });
    assert.equal(linked,1,linkedStdout.read());
    assert.equal(capture.prepare,prepareBeforeLinkedOutput);
    const linkedEvents=parseNdjson(linkedStdout.read());
    assert.equal(linkedEvents.some(event=>event.type.startsWith('package.')),false);
    assert.equal(linkedEvents.at(-1).data.error.code,'ARCANE_POLICY_DENIED');
    assert.match(linkedEvents.at(-1).data.error.message,/linked or non-directory ancestor/u);
    });
});
