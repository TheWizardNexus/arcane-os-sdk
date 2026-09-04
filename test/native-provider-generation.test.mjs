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

function builder(name){
    return {
        name,
        protocol:NATIVE_BUILDER_PROTOCOL,
        describe:async()=>({protocol:NATIVE_BUILDER_PROTOCOL,targets:['portable']}),
        doctor:async()=>({ready:true}),
        prepare:async()=>({name}),
        build:async()=>({name}),
        verify:async({artifact})=>({verified:true,artifact}),
        run:async({artifact})=>({launched:true,artifact})
    };
}

async function checkout(t){
    const arcaneRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-provider-refresh-'));
    t.after(()=>rm(arcaneRoot,{recursive:true,force:true}));
    const providerPath=path.join(arcaneRoot,...ARCANE_NATIVE_PROVIDER_PATHS.portable);
    await mkdir(path.dirname(providerPath),{recursive:true});
    await writeFile(providerPath,'export default {};\n');
    return {arcaneRoot,providerPath};
}

test('each provider load uses the current ordinary module result',async t=>{
    const selected=await checkout(t);
    let calls=0;
    const importModule=async()=>({default:builder(`provider-${++calls}`)});
    const first=await loadArcaneNativeProvider({
        arcaneRoot:selected.arcaneRoot,
        importModule,
        target:'portable'
    });
    const second=await loadArcaneNativeProvider({
        arcaneRoot:selected.arcaneRoot,
        importModule,
        target:'portable'
    });
    assert.equal(calls,2);
    assert.equal(first.nativeBuilder.name,'provider-1');
    assert.equal(second.nativeBuilder.name,'provider-2');
    assert.equal(first.providerPath,selected.providerPath);
    assert.equal(second.providerPath,selected.providerPath);
});

test('concurrent ordinary loads remain independent and complete',async t=>{
    const selected=await checkout(t);
    let calls=0;
    const importModule=async()=>({default:builder(`provider-${++calls}`)});
    const [first,second]=await Promise.all([
        loadArcaneNativeProvider({arcaneRoot:selected.arcaneRoot,importModule,target:'portable'}),
        loadArcaneNativeProvider({arcaneRoot:selected.arcaneRoot,importModule,target:'portable'})
    ]);
    assert.equal(calls,2);
    assert.notEqual(first.nativeBuilder,second.nativeBuilder);
});
