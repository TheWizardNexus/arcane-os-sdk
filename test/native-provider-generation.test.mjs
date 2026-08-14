import assert from 'node:assert/strict';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {
    ARCANE_NATIVE_PROVIDER_PATHS,
    ARCANE_PORTABLE_PROVIDER_PATH,
    loadArcaneNativeProvider,
    loadArcanePortableProvider
} from '../src/native-provider-loader.mjs';
import {temporaryDirectory} from './helpers.mjs';

function provider(){
    const operation=async()=>({});
    return Object.freeze({
        protocol:'arcane-native-builder/1',
        describe:async()=>({protocol:'arcane-native-builder/1',targets:['portable']}),
        doctor:operation,
        prepare:operation,
        authenticateToolchainReceipt:operation,
        build:operation,
        verify:operation,
        run:operation
    });
}

async function providerFixture(t,prefix='arcane-provider-generation-'){
    const arcaneRoot=await temporaryDirectory(t,{prefix});
    const providerPath=path.join(arcaneRoot,...ARCANE_PORTABLE_PROVIDER_PATH);
    const helperPath=path.join(path.dirname(providerPath),'provider-helper.mjs');
    const deepHelperPath=path.join(path.dirname(providerPath),'provider-deep.mjs');
    await mkdir(path.dirname(providerPath),{recursive:true});
    await writeFile(deepHelperPath,'export const marker = 1;\n','utf8');
    await writeFile(helperPath,"export {marker} from './provider-deep.mjs';\n",'utf8');
    await writeFile(
        providerPath,
        "import {marker} from './provider-helper.mjs';\nexport const observed = marker;\n",
        'utf8'
    );
    return {arcaneRoot,deepHelperPath,helperPath,providerPath};
}

function loaderOptions(fixture,generationCache,importModule){
    return {
        arcaneRoot:fixture.arcaneRoot,
        generationCache,
        importModule
    };
}

function realProviderHelperSource(){
    return `export function createProvider(targets){
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
}\n`;
}

function realProviderEntrySource(targets){
    return `import {createProvider} from './real-provider-shared.mjs';
export const arcaneNativeBuilderProvider=createProvider(${JSON.stringify(targets)});\n`;
}

async function realProviderFixture(t,prefix){
    const arcaneRoot=await temporaryDirectory(t,{prefix});
    const toolsRoot=path.join(
        arcaneRoot,
        ...ARCANE_PORTABLE_PROVIDER_PATH.slice(0,-1)
    );
    const sharedPath=path.join(toolsRoot,'real-provider-shared.mjs');
    await mkdir(toolsRoot,{recursive:true});
    await writeFile(sharedPath,realProviderHelperSource(),'utf8');
    return {arcaneRoot,sharedPath,toolsRoot};
}

test('unchanged provider closure reuses one imported namespace and immutable generation',async t=>{
    const fixture=await providerFixture(t);
    const generationCache=new Map();
    const namespace={arcaneNativeBuilderProvider:provider()};
    let importCalls=0;
    let importedSpecifier;
    const importModule=async specifier=>{
        importCalls+=1;
        importedSpecifier=specifier;
        return namespace;
    };

    const first=await loadArcanePortableProvider(
        loaderOptions(fixture,generationCache,importModule)
    );
    const second=await loadArcanePortableProvider(
        loaderOptions(fixture,generationCache,importModule)
    );

    assert.equal(importCalls,1);
    assert.equal(first,second);
    assert.equal(importedSpecifier,pathToFileURL(await realpath(fixture.providerPath)).href);
    assert.equal(first.providerGeneration.kind,'arcane-native-provider-generation');
    assert.equal(first.nativeBuilder.providerGeneration,first.providerGeneration);
    assert.equal(first.providerGeneration.moduleCount,3);
    assert.match(first.providerGeneration.contentSha256,/^[a-f0-9]{64}$/u);
    assert.match(first.providerGeneration.filesystemIdentitySha256,/^[a-f0-9]{64}$/u);
    assert.match(first.providerGeneration.generationSha256,/^[a-f0-9]{64}$/u);
    assert.ok(Object.isFrozen(first.providerGeneration));
    assert.ok(Object.isFrozen(first.providerGeneration.modules));
    assert.ok(first.providerGeneration.modules.every(Object.isFrozen));
    assert.deepEqual(
        first.providerGeneration.modules.map(module=>path.posix.basename(module.path)),
        ['portable-native-provider.mjs','provider-deep.mjs','provider-helper.mjs']
    );
});

test('every exposed provider operation reauthenticates the exact loaded closure',async t=>{
    const fixture=await providerFixture(t,'arcane-provider-operation-guard-');
    const generationCache=new Map();
    let doctorCalls=0;
    const rawProvider=provider();
    const instrumentedProvider=Object.freeze({
        ...rawProvider,
        doctor:async()=>{
            doctorCalls+=1;
            return {ready:true};
        }
    });
    let readCalls=0;
    const pairing=await loadArcanePortableProvider({
        arcaneRoot:fixture.arcaneRoot,
        generationCache,
        readModule:async modulePath=>{
            readCalls+=1;
            return readFile(modulePath);
        },
        importModule:async()=>({arcaneNativeBuilderProvider:instrumentedProvider})
    });

    const readsAfterPairing=readCalls;
    assert.deepEqual(await pairing.nativeBuilder.doctor(),{ready:true});
    await pairing.nativeBuilder.describe();
    assert.equal(doctorCalls,1);
    assert.equal(readCalls,readsAfterPairing);
    await writeFile(fixture.deepHelperPath,'export const marker = 9000;\n','utf8');
    await assert.rejects(
        ()=>pairing.nativeBuilder.doctor(),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
            &&/Restart the Arcane SDK process/u.test(error.message)
    );
    assert.equal(doctorCalls,1);
    assert.equal(readCalls,readsAfterPairing);
});

test('concurrent identical first loads reserve before scanning and share one pairing',async t=>{
    const fixture=await providerFixture(t,'arcane-provider-concurrent-identical-');
    let releaseFirstRead;
    let reportFirstRead;
    const firstReadStarted=new Promise(resolve=>{reportFirstRead=resolve;});
    const firstReadGate=new Promise(resolve=>{releaseFirstRead=resolve;});
    let blocked=false;
    let readCalls=0;
    let importCalls=0;
    const options={
        arcaneRoot:fixture.arcaneRoot,
        readModule:async modulePath=>{
            readCalls+=1;
            if(!blocked){
                blocked=true;
                reportFirstRead();
                await firstReadGate;
            }
            return readFile(modulePath);
        },
        importModule:async()=>{
            importCalls+=1;
            return {arcaneNativeBuilderProvider:provider()};
        }
    };

    const first=loadArcanePortableProvider(options);
    await firstReadStarted;
    const second=loadArcanePortableProvider(options);
    releaseFirstRead();
    const [left,right]=await Promise.all([first,second]);

    assert.equal(left,right);
    assert.equal(importCalls,1);
    assert.equal(readCalls,left.providerGeneration.moduleCount*2);
});

test('a concurrent mutation cannot race past the reserved first generation',async t=>{
    const fixture=await providerFixture(t,'arcane-provider-concurrent-mutation-');
    let releaseImport;
    let reportImport;
    const importStarted=new Promise(resolve=>{reportImport=resolve;});
    const importGate=new Promise(resolve=>{releaseImport=resolve;});
    let importCalls=0;
    const options={
        arcaneRoot:fixture.arcaneRoot,
        importModule:async()=>{
            importCalls+=1;
            reportImport();
            await importGate;
            return {arcaneNativeBuilderProvider:provider()};
        }
    };

    const first=loadArcanePortableProvider(options);
    await importStarted;
    const second=loadArcanePortableProvider(options);
    await writeFile(fixture.helperPath,'export const marker = 4000;\n','utf8');
    releaseImport();
    const outcomes=await Promise.allSettled([first,second]);

    assert.equal(importCalls,1);
    assert.ok(outcomes.every(outcome=>outcome.status==='rejected'));
    assert.ok(outcomes.every(outcome=>
        outcome.reason.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
    ));
});

test('process-global registry rejects a changed entry reused by another target',async t=>{
    const fixture=await realProviderFixture(t,'arcane-provider-cross-target-');
    const linuxEntry=path.join(
        fixture.arcaneRoot,
        ...ARCANE_NATIVE_PROVIDER_PATHS['linux-x64']
    );
    await writeFile(
        linuxEntry,
        realProviderEntrySource(['linux-arm64','linux-x64']),
        'utf8'
    );
    let importCalls=0;
    const importModule=async specifier=>{
        importCalls+=1;
        return import(specifier);
    };
    await loadArcaneNativeProvider({
        arcaneRoot:fixture.arcaneRoot,
        target:'linux-x64',
        importModule
    });
    await writeFile(
        linuxEntry,
        `${realProviderEntrySource(['linux-arm64','linux-x64'])}export const changed=true;\n`,
        'utf8'
    );
    const secondLoader=await import(
        '../src/native-provider-loader.mjs?process-global-registry-test'
    );

    await assert.rejects(
        ()=>secondLoader.loadArcaneNativeProvider({
            arcaneRoot:fixture.arcaneRoot,
            target:'linux-arm64',
            importModule
        }),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
            &&/Restart the Arcane SDK process/u.test(error.message)
    );
    assert.equal(importCalls,1);
});

test('process-global registry rejects a changed helper shared by different entries',async t=>{
    const fixture=await realProviderFixture(t,'arcane-provider-shared-helper-');
    const portableEntry=path.join(
        fixture.arcaneRoot,
        ...ARCANE_NATIVE_PROVIDER_PATHS.portable
    );
    const windowsEntry=path.join(
        fixture.arcaneRoot,
        ...ARCANE_NATIVE_PROVIDER_PATHS['windows-x64']
    );
    await writeFile(portableEntry,realProviderEntrySource(['portable']),'utf8');
    await writeFile(windowsEntry,realProviderEntrySource(['windows-x64']),'utf8');
    let importCalls=0;
    const importModule=async specifier=>{
        importCalls+=1;
        return import(specifier);
    };
    await loadArcaneNativeProvider({
        arcaneRoot:fixture.arcaneRoot,
        target:'portable',
        importModule
    });
    await writeFile(
        fixture.sharedPath,
        `${realProviderHelperSource()}export const changed=true;\n`,
        'utf8'
    );

    await assert.rejects(
        ()=>loadArcaneNativeProvider({
            arcaneRoot:fixture.arcaneRoot,
            target:'windows-x64',
            importModule
        }),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
            &&/Restart the Arcane SDK process/u.test(error.message)
    );
    assert.equal(importCalls,1);
});

test('entry or relative helper changes require a process restart before another import',async t=>{
    for(const selected of ['entry','helper']){
        const fixture=await providerFixture(t,`arcane-provider-${selected}-change-`);
        const generationCache=new Map();
        let importCalls=0;
        const importModule=async()=>{
            importCalls+=1;
            return {arcaneNativeBuilderProvider:provider()};
        };
        await loadArcanePortableProvider(loaderOptions(fixture,generationCache,importModule));
        const changedPath=selected==='entry'?fixture.providerPath:fixture.helperPath;
        await writeFile(
            changedPath,
            selected==='entry'
                ?"import {marker} from './provider-helper.mjs';\nexport const observed = marker + 1;\n"
                :'export const marker = 2;\n',
            'utf8'
        );

        await assert.rejects(
            ()=>loadArcanePortableProvider(loaderOptions(fixture,generationCache,importModule)),
            error=>error.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
                &&/Restart the Arcane SDK process/u.test(error.message)
        );
        assert.equal(importCalls,1);
    }
});

test('mutation during provider import poisons the in-process generation',async t=>{
    const fixture=await providerFixture(t,'arcane-provider-import-mutation-');
    const generationCache=new Map();
    let importCalls=0;
    const importModule=async()=>{
        importCalls+=1;
        await writeFile(fixture.helperPath,'export const marker = 3;\n','utf8');
        return {arcaneNativeBuilderProvider:provider()};
    };

    await assert.rejects(
        ()=>loadArcanePortableProvider(loaderOptions(fixture,generationCache,importModule)),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
            &&/Restart the Arcane SDK process/u.test(error.message)
    );
    await assert.rejects(
        ()=>loadArcanePortableProvider(loaderOptions(fixture,generationCache,importModule)),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_RESTART_REQUIRED'
    );
    assert.equal(importCalls,1);
});

test('canonical Arcane roots own separate provider generations',async t=>{
    const left=await providerFixture(t,'arcane-provider-root-left-');
    const right=await providerFixture(t,'arcane-provider-root-right-');
    const generationCache=new Map();
    let importCalls=0;
    const importModule=async()=>{
        importCalls+=1;
        return {arcaneNativeBuilderProvider:provider()};
    };

    const leftPairing=await loadArcanePortableProvider(
        loaderOptions(left,generationCache,importModule)
    );
    const rightPairing=await loadArcanePortableProvider(
        loaderOptions(right,generationCache,importModule)
    );

    assert.equal(importCalls,2);
    assert.notEqual(leftPairing,rightPairing);
    assert.notEqual(
        leftPairing.providerGeneration.canonicalArcaneRoot,
        rightPairing.providerGeneration.canonicalArcaneRoot
    );
});

test('provider closure rejects escaped, linked, and dynamic modules',async t=>{
    const escaped=await providerFixture(t,'arcane-provider-escaped-');
    await writeFile(
        escaped.providerPath,
        "import {marker} from '../../../../outside-provider-helper.mjs';\nexport {marker};\n",
        'utf8'
    );
    await assert.rejects(
        ()=>loadArcanePortableProvider({
            arcaneRoot:escaped.arcaneRoot,
            generationCache:new Map(),
            importModule:async()=>({arcaneNativeBuilderProvider:provider()})
        }),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_CLOSURE_INVALID'&&/escapes/u.test(error.message)
    );

    const linked=await providerFixture(t,'arcane-provider-linked-');
    const canonicalLinkedHelper=await realpath(linked.helperPath);
    const canonicalize=async candidate=>{
        const canonical=await realpath(candidate);
        return sameFile(canonical,canonicalLinkedHelper)
            ?path.join(path.dirname(linked.arcaneRoot),'linked-provider-target.mjs')
            :canonical;
    };
    await assert.rejects(
        ()=>loadArcanePortableProvider({
            arcaneRoot:linked.arcaneRoot,
            canonicalize,
            generationCache:new Map(),
            importModule:async()=>({arcaneNativeBuilderProvider:provider()})
        }),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_CLOSURE_INVALID'&&/linked/u.test(error.message)
    );

    const dynamic=await providerFixture(t,'arcane-provider-dynamic-');
    await writeFile(
        dynamic.providerPath,
        "export async function loadHelper(){ return import('./provider-helper.mjs'); }\n",
        'utf8'
    );
    await assert.rejects(
        ()=>loadArcanePortableProvider({
            arcaneRoot:dynamic.arcaneRoot,
            generationCache:new Map(),
            importModule:async()=>({arcaneNativeBuilderProvider:provider()})
        }),
        error=>error.code==='ARCANE_NATIVE_PROVIDER_CLOSURE_INVALID'&&/dynamic import/u.test(error.message)
    );
});

function sameFile(left,right){
    const normalize=value=>process.platform==='win32'
        ?path.resolve(value).toLowerCase()
        :path.resolve(value);
    return normalize(left)===normalize(right);
}
