import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
    NATIVE_BUILDER_PROTOCOL,
    createNativeBuildPlan,
    executeNativeBuildPlan,
    validateNativeBuilder
} from '../src/native-plan.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

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
