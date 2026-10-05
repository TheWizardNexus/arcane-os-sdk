import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
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
    assert.equal(pairing.providerSource,'arcane-checkout');
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

for(const [target,module] of [['portable','portable-provider.mjs'],['windows-x64','windows-provider.mjs']]){
test(`${target} without an override loads the installed SDK provider directly`,async()=>{
    const builder=provider();
    const providerURL=new URL(`../src/native/${module}`,import.meta.url);
    let imported;
    const pairing=await loadArcaneNativeProvider({
        target,
        inspect(){throw new Error('A packaged provider does not inspect an OS checkout.');},
        async importModule(specifier){
            imported=specifier;
            return {default:builder};
        }
    });
    assert.equal(imported,providerURL.href);
    assert.equal(pairing.providerPath,fileURLToPath(providerURL));
    assert.equal(pairing.toolchainRoot,path.resolve(fileURLToPath(new URL('../',import.meta.url))));
    assert.equal(pairing.arcaneRoot,null);
    assert.equal(pairing.providerSource,'sdk-package');
    assert.equal(pairing.nativeBuilder,builder);
});
}

test('packaged provider import errors retain their cause and never select a checkout',async()=>{
    const cause=new Error('Selected package provider import failed.');
    await assert.rejects(()=>loadArcaneNativeProvider({
        target:'portable',
        importModule(){throw cause;}
    }),error=>error.code==='ARCANE_TARGET_UNAVAILABLE'&&error.cause===cause);
});

test('unimplemented SDK targets require an explicit checkout and invalid overrides remain errors',async()=>{
    for(const target of ['linux-x64','linux-arm64','android-arm64']){
        await assert.rejects(()=>loadArcaneNativeProvider({target}),/requires an Arcane OS checkout/u);
    }
    await assert.rejects(()=>loadArcaneNativeProvider({target:'portable',arcaneRoot:''}),
        /requires an Arcane OS checkout/u);
});
