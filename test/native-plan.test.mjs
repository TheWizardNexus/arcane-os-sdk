import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {createNativeTargetAdapter} from '../src/targets/index.mjs';
import {assertIntegratedNativeToolchain, buildApplication} from '../src/toolchain.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {
    NATIVE_BUILDER_PROTOCOL,
    createNativeBuildPlan,
    executeNativeBuildPlan,
    validateNativeBuilder
} from '../src/native-plan.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('SDK macOS providers use the installed package independently of integrated checkout pairing', function macOSPairing() {
    for (const target of ['macos-arm64', 'macos-x64']) {
        assert.doesNotThrow(function packagedProvider() {
            assertIntegratedNativeToolchain({
                workspaceMode: 'integrated', workspaceRoot: '/selected-app', toolchainRoot: '/installed-sdk',
                providerSource: 'sdk-package', target
            });
        });
        assert.throws(function checkoutProvider() {
            assertIntegratedNativeToolchain({
                workspaceMode: 'integrated', workspaceRoot: '/selected-app', toolchainRoot: '/different-checkout',
                providerSource: 'arcane-checkout', target
            });
        }, {code: 'ARCANE_POLICY_DENIED'});
    }
});

test('paired native packaging selects app and bundled native resources without replacing browser outputs',async t=>{
    const fixtures=path.join(repositoryRoot,'.arcane','native-resource-fixtures');
    await mkdir(fixtures,{recursive:true});
    const root=await mkdtemp(path.join(fixtures,'paired-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const workspaceRoot=path.join(root,'workspace');
    async function write(relative,content){
        const location=path.join(workspaceRoot,relative);
        await mkdir(path.dirname(location),{recursive:true});
        await writeFile(location,content);
    }
    const sharedDirectories=['components','css','dependencies','entities','img','modules','sdk'];
    await Promise.all(sharedDirectories.map(directory=>mkdir(path.join(workspaceRoot,'arcane',directory),{recursive:true})));
    await mkdir(path.join(workspaceRoot,'arcane','dependencies','strong-type'));
    await Promise.all([
        write('package.json',JSON.stringify({name:'arcane-os',type:'module',private:true})),
        write('arcane-packager.json',JSON.stringify({schemaVersion:1,appsRoot:'apps',distRoot:'dist',
            sharedPayloads:{'browser-runtime':[{source:'arcane',destination:'arcane',include:sharedDirectories,exclude:[]}]}})),
        write('arcane/css/theme.css',':root{color:rgb(10,20,30)}\n'),
        write('arcane/modules/ThemeBootstrap.js','export const themeReady=true;\n'),
        write('browser-public/kept.txt','Existing browser publication stays complete.\n')
    ]);
    const contents=new Map();
    for(const id of ['dragon-desk','dragon-library']){
        const service=`export const app='${id}';\r\nexport const text='  complete 🐉  ';\r\n`;
        contents.set(id,service);
        const descriptor={schemaVersion:2,id,displayName:id,description:'Dragon service composition.',version:'1.0.0',
            publisher:{id:'dragon-publisher',name:'Dragon Publisher'},
            package:{entry:'index.html',strategy:'static',include:['index.html','modules','img'],exclude:[],
                shared:['browser-runtime'],nativeResources:{include:['server'],exclude:[]},pwa:{enabled:true}},
            native:{type:'app',icon:'img/icon.png',order:0,bundledApps:id==='dragon-desk'?['dragon-library']:[]},
            requirements:{arcaneProtocol:'arcane/1',minimumCoreVersion:'0.8.12',features:[]},targets:['browser','portable']};
        await Promise.all([
            write(`apps/${id}/arcane-app.json`,JSON.stringify(descriptor)),
            // A shared browser destination would collide if native preflight used browser output paths.
            write(`apps/${id}/arcane-package.json`,JSON.stringify({...projectPackageManifest(descriptor),outputDirectory:'browser-public'})),
            write(`apps/${id}/index.html`,`<!doctype html><meta name="arcane-app-id" content="${id}">`
                +'<base href="../../"><link rel="stylesheet" href="./arcane/css/theme.css">'
                +'<script type="module" src="./arcane/modules/ThemeBootstrap.js"></script>'
                +`<script type="module" src="./apps/${id}/modules/App.js"></script>`),
            write(`apps/${id}/modules/App.js`,'export const ready=true;\n'),
            write(`apps/${id}/img/icon.png`,'Synthetic icon input'),
            write(`apps/${id}/server/RepositoryService.mjs`,service)
        ]);
    }
    let captured;
    const provider={protocol:NATIVE_BUILDER_PROTOCOL,
        describe:async()=>({protocol:NATIVE_BUILDER_PROTOCOL,targets:['portable']}),
        doctor:async()=>({ready:true}),prepare:async()=>({version:'development'}),
        async build(request){
            captured=request;
            return {outputRoot:request.outputRoot,files:[]};
        },
        verify(){throw new Error('Packaging must not invoke provider verification.');},
        run(){throw new Error('Packaging must not launch app services.');}
    };
    const result=await buildApplication({workspaceRoot,appId:'dragon-desk',target:'portable',nativeBuilder:provider,
        toolchainRoot:workspaceRoot,outputRoot:path.join(root,'native-output'),targetRequest:{
            target:'portable',platform:'linux',architecture:'x64',format:'portable',signing:'unsigned-local-test'
        }});
    assert.equal(result.plan.nativeBuilder,provider);
    assert.equal(result.release.output,'dist/.native/portable/dragon-desk');
    assert.equal(result.dependencyReleases[0].release.output,'dist/.native/portable/dragon-library');
    assert.equal(captured.appReleaseRoot,path.join(workspaceRoot,'dist','.native','portable','dragon-desk'));
    assert.equal(captured.dependencies[0].releaseRoot,path.join(workspaceRoot,'dist','.native','portable','dragon-library'));
    assert.equal((await captured.readReleaseFile('apps/dragon-desk/server/RepositoryService.mjs')).toString('utf8'),contents.get('dragon-desk'));
    assert.equal((await captured.dependencies[0].readReleaseFile('apps/dragon-library/server/RepositoryService.mjs')).toString('utf8'),contents.get('dragon-library'));
    assert.deepEqual(captured.release.manifest,result.release.manifest);
    assert.deepEqual(captured.dependencies[0].release.manifest,result.dependencyReleases[0].release.manifest);
    assert.equal(captured.release.manifest.app.pwa,undefined);
    assert.equal(await readFile(path.join(workspaceRoot,'browser-public/kept.txt'),'utf8'),'Existing browser publication stays complete.\n');
});

test('native plan passes complete release content through direct structural values',async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'arcane-native-content-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const toolchainRoot=path.join(root,'toolchain');
    const releaseRoot=path.join(root,'release');
    const outputRoot=path.join(root,'output');
    await Promise.all([mkdir(toolchainRoot),mkdir(releaseRoot),mkdir(outputRoot)]);
    const complete='complete native application content with trailing space \n';
    await writeFile(path.join(releaseRoot,'index.html'),complete);
    const appDescriptor=JSON.parse(await readFile(
        path.join(repositoryRoot,'examples','hello-world','apps','hello-world','arcane-app.json'),
        'utf8'
    ));
    let captured;
    const provider={
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe:async()=>({
            protocol:NATIVE_BUILDER_PROTOCOL,
            targets:['portable']
        }),
        doctor:async()=>({ready:true}),
        prepare:async()=>({version:'development'}),
        async build(request){
            captured={...request,content:(await request.readReleaseFile('index.html')).toString('utf8')};
            return {outputRoot:request.outputRoot,files:['complete-native-output']};
        },
        verify:async({artifact})=>({verified:true,artifact}),
        run:async({artifact})=>({launched:true,artifact})
    };
    assert.equal(validateNativeBuilder(provider),provider);
    const plan=await createNativeBuildPlan({
        nativeBuilder:provider,
        toolchainRoot,
        toolchain:{version:'development'},
        appReleaseRoot:releaseRoot,
        release:{files:['index.html']},
        appDescriptor,
        outputRoot,
        targetRequest:{
            target:'portable',
            platform:'windows',
            architecture:'x64',
            format:'portable',
            signing:'unsigned-local-test',
            signingProfileId:null
        }
    });
    const artifact=await executeNativeBuildPlan(plan,{
        expectedNativeBuilder:provider,
        expectedTarget:'portable'
    });
    assert.equal(captured.content,complete);
    assert.deepEqual(artifact,{outputRoot,files:['complete-native-output']});
});

test('native release reader rejects traversal and non-selected files',async t=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'arcane-native-path-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const toolchainRoot=path.join(root,'toolchain');
    const releaseRoot=path.join(root,'release');
    await Promise.all([mkdir(toolchainRoot),mkdir(releaseRoot)]);
    await writeFile(path.join(releaseRoot,'index.html'),'complete\n');
    const descriptor=JSON.parse(await readFile(
        path.join(repositoryRoot,'examples','hello-world','apps','hello-world','arcane-app.json'),
        'utf8'
    ));
    const provider={
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe(){},doctor(){},prepare(){},build(){},verify(){},run(){}
    };
    const plan=await createNativeBuildPlan({
        nativeBuilder:provider,
        toolchainRoot,
        toolchain:{},
        appReleaseRoot:releaseRoot,
        release:{files:['index.html']},
        appDescriptor:descriptor,
        outputRoot:path.join(root,'output'),
        targetRequest:{
            target:'portable',platform:'linux',architecture:'x64',format:'portable',
            signing:'unsigned-local-test',signingProfileId:null
        }
    });
    await assert.rejects(()=>plan.application.readFile('../outside'),/Unsafe/u);
    await assert.rejects(()=>plan.application.readFile('missing.html'),/does not contain/u);
});

test('native plans normalize nested CLI signing and preserve complete dependency selections',async t=>{
    const fixtureRoot=path.join(repositoryRoot,'.arcane','native-plan-fixtures');
    await mkdir(fixtureRoot,{recursive:true});
    const root=await mkdtemp(path.join(fixtureRoot,'request-'));
    t.after(()=>rm(root,{recursive:true,force:true}));
    const releaseRoot=path.join(root,'release');
    const dependencyRoot=path.join(root,'dependency');
    await Promise.all([mkdir(releaseRoot),mkdir(dependencyRoot)]);
    const complete='Dragon dispatch ledger\n  retain every line and trailing space \n';
    await writeFile(path.join(dependencyRoot,'ledger.txt'),complete);
    const descriptor={
        schemaVersion:2,id:'dragon-dispatch',displayName:'Dragon Dispatch',
        description:'Complete dragon ledger dispatch.',version:'1.0.0',
        publisher:{id:'dragon-publisher',name:'Dragon Publisher'},
        package:{entry:'index.html',strategy:'static',include:['index.html','img/icon.png'],
            exclude:[],shared:['browser-runtime']},
        native:{type:'app',icon:'img/icon.png',order:0,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',minimumCoreVersion:'0.8.12',features:[]},
        targets:['browser','portable','android-arm64']
    };
    const provider={
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe:async()=>({protocol:NATIVE_BUILDER_PROTOCOL,targets:['portable','android-arm64']}),
        doctor(){},prepare(){},verify(){},run(){},
        build:async request=>request
    };
    const dependencyRelease={files:['ledger.txt'],manifest:{id:'dragon-ledger',title:'Complete ledger'}};
    const selectedSdk={packageRoot:repositoryRoot,packageSource:'node_modules/dragon-sdk'};
    for(const request of [
        {target:'portable',platform:'linux',architecture:'arm64',format:'portable',
            signing:{mode:'unsigned-local-test',profileId:null}},
        {target:'android-arm64',platform:'android',architecture:'arm64',format:'apk',
            signing:{mode:'development',profileId:'arcane-android-development-v1'}}
    ]){
        const adapter=createNativeTargetAdapter({targetId:request.target,nativeBuilder:provider});
        const plan=await adapter.plan({
            nativeBuilder:provider,toolchainRoot:root,toolchain:{},
            appReleaseRoot:releaseRoot,release:{files:[]},appDescriptor:descriptor,
            selectedSdk,
            dependencyReleases:[{appId:'dragon-ledger',releaseRoot:dependencyRoot,release:dependencyRelease}],
            outputRoot:path.join(root,'output'),targetRequest:request
        });
        assert.deepEqual(plan.targetRequest,{
            ...request,signing:request.signing.mode,signingProfileId:request.signing.profileId
        });
        const built=await executeNativeBuildPlan(plan);
        assert.equal(plan.selectedSdk,selectedSdk);
        assert.equal(built.selectedSdk,selectedSdk);
        assert.equal(built.dependencies[0].appId,'dragon-ledger');
        assert.equal(built.dependencies[0].releaseRoot,dependencyRoot);
        assert.deepEqual(built.dependencies[0].release,dependencyRelease);
        assert.equal((await built.dependencies[0].readReleaseFile('ledger.txt')).toString('utf8'),complete);
    }
});
