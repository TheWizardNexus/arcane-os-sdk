import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    ARCANE_NATIVE_PROVIDER_PATHS,
    loadArcaneNativeProvider
} from '../src/native-provider-loader.mjs';
import {NATIVE_BUILDER_PROTOCOL} from '../src/native-plan.mjs';

function provider(){
    return {
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe:async()=>({protocol:NATIVE_BUILDER_PROTOCOL,targets:['portable','windows-x64']}),
        doctor:async()=>({ready:true}),
        prepare:async()=>({version:'development'}),
        build:async request=>({outputRoot:request.outputRoot}),
        verify:async ({artifact})=>({verified:true,artifact}),
        run:async ({artifact})=>({launched:true,artifact})
    };
}

async function checkoutFixture(t,target='portable'){
    const arcaneRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-provider-content-'));
    t.after(()=>rm(arcaneRoot,{recursive:true,force:true}));
    const relative=ARCANE_NATIVE_PROVIDER_PATHS[target];
    const providerPath=path.join(arcaneRoot,...relative);
    await mkdir(path.dirname(providerPath),{recursive:true});
    await writeFile(providerPath,'export default {};\n');
    return {arcaneRoot,providerPath};
}

test('native provider paths remain exact first-party checkout paths',()=>{
    assert.deepEqual(ARCANE_NATIVE_PROVIDER_PATHS.portable,[
        'machine_bundles','arcane-os-machine-bundle','tools','portable-native-provider.mjs'
    ]);
    assert.equal(ARCANE_NATIVE_PROVIDER_PATHS['windows-x64'].at(-1),'windows-native-provider.mjs');
});

test('ordinary provider loading imports the selected module and returns direct builder values',async t=>{
    const selected=await checkoutFixture(t);
    const builder=provider();
    let imported;
    const pairing=await loadArcaneNativeProvider({
        arcaneRoot:selected.arcaneRoot,
        target:'portable',
        async importModule(specifier){
            imported=specifier;
            return {arcaneNativeBuilderProvider:builder};
        }
    });
    assert.equal(imported.startsWith('file:'),true);
    assert.equal(pairing.providerPath,selected.providerPath);
    assert.equal(pairing.toolchainRoot,selected.arcaneRoot);
    assert.equal(pairing.nativeBuilder,builder);
});

test('native provider loading preserves event and target context',async t=>{
    const selected=await checkoutFixture(t,'windows-x64');
    const events=[];
    const pairing=await loadArcaneNativeProvider({
        arcaneRoot:selected.arcaneRoot,
        target:'windows-x64',
        importModule:async()=>({default:provider()}),
        onEvent:event=>events.push(event)
    });
    assert.equal(pairing.providerPath,selected.providerPath);
    assert.deepEqual(events.map(event=>event.type),[
        'native.provider.load.started',
        'native.provider.load.completed'
    ]);
});
