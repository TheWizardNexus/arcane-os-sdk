import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {verifyNpmReleaseArtifact} from '../tools/npm-release-contract.mjs';
import {runCommand,runNode,temporaryDirectory} from './helpers.mjs';

function runNpm(arguments_,options){
    if(process.platform==='win32'){
        const npmCli=process.env.npm_execpath??path.join(
            path.dirname(process.execPath),
            'node_modules','npm','bin','npm-cli.js'
        );
        return runNode([npmCli,...arguments_],options);
    }
    return runCommand('npm',arguments_,options);
}

test('the exact npm artifact exposes the supported installed capability contract',{
    timeout:180_000
},async t=>{
    const metadataPath=process.env.ARCANE_SDK_NPM_RELEASE_METADATA;
    if(!metadataPath){
        assert.notEqual(process.env.ARCANE_SDK_EXACT_ARTIFACT_REQUIRED,'true');
        return;
    }

    assert.equal(process.env.ARCANE_SDK_EXACT_ARTIFACT_REQUIRED,'true');
    assert.equal(process.platform,process.env.ARCANE_SDK_EXPECTED_PLATFORM);
    assert.equal(process.arch,process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE);

    const verified=await verifyNpmReleaseArtifact({
        metadataPath,
        requireCleanSource:true
    });
    if(process.env.GITHUB_SHA){
        assert.equal(verified.manifest.source.commit,process.env.GITHUB_SHA);
    }

    const temporary=await temporaryDirectory(t,{prefix:'arcane-release-smoke-'});
    const consumerRoot=path.join(temporary,'consumer');
    await mkdir(consumerRoot);
    await writeFile(path.join(consumerRoot,'package.json'),`${JSON.stringify({
        name:'arcane-release-capability-smoke',
        private:true,
        type:'module'
    },null,2)}\n`);

    const installed=await runNpm([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        verified.tarballPath
    ],{cwd:consumerRoot,timeout:90_000});
    assert.equal(installed.code,0,installed.stderr);

    const installedRoot=path.join(consumerRoot,'node_modules','arcane-os');
    const installedPackage=JSON.parse(await readFile(
        path.join(installedRoot,'package.json'),
        'utf8'
    ));
    assert.equal(installedPackage.name,verified.manifest.name);
    assert.equal(installedPackage.version,verified.manifest.version);
    const browserRuntimeReceipt=JSON.parse(await readFile(
        path.join(installedRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json'),
        'utf8'
    ));
    assert.equal(browserRuntimeReceipt.sdkVersion,verified.manifest.version);
    assert.equal(browserRuntimeReceipt.source.authority,'arcane-os-sdk');

    const capabilityContract=path.join(consumerRoot,'installed-capability.test.mjs');
    await writeFile(capabilityContract,`import assert from 'node:assert/strict';
import {
    ARCANE_EVENT_STACK_PROTOCOL,
    SDK_VERSION,
    createEventManager,
    listTargets
} from 'arcane-os';
import runtimeRelease from 'arcane-os/runtime/manifest' with {type:'json'};
import test from 'arcane-os/testing';

test('installed public SDK capabilities are coherent',()=>{
    assert.equal(SDK_VERSION,${JSON.stringify(verified.manifest.version)});
    assert.equal(runtimeRelease.sdkVersion,SDK_VERSION);
    assert.equal(runtimeRelease.source.protocol,'arcane/1');
    assert.ok(runtimeRelease.fileCount>0);

    const targets=listTargets();
    assert.equal(targets.find(target=>target.id==='browser')?.status,'available');
    assert.equal(targets.find(target=>target.id==='portable')?.status,'pairing-required');

    const manager=createEventManager({timeTravel:true,sessionId:'release-smoke'});
    let observed=null;
    manager.once('release.smoke',value=>{observed=value;});
    manager.emit('release.smoke',42);
    assert.equal(observed,42);
    assert.equal(manager.history[0]?.protocol,ARCANE_EVENT_STACK_PROTOCOL);
});
`);

    const installedTestRunner=path.join(installedRoot,'bin','arcane-test.mjs');
    const contractResult=await runNode([installedTestRunner,capabilityContract],{
        cwd:consumerRoot,
        timeout:60_000
    });
    assert.equal(contractResult.code,0,contractResult.stderr);
    assert.match(contractResult.stdout,/Test Total : 1/u);
    assert.match(contractResult.stdout,/Passed :[^\r\n]*1/u);

    const cliResult=await runNpm(
        ['exec','--offline','--','arcane','--version'],
        {cwd:consumerRoot,timeout:30_000}
    );
    assert.equal(cliResult.code,0,cliResult.stderr);
    assert.equal(cliResult.stdout.trim(),verified.manifest.version);

    const after=await verifyNpmReleaseArtifact({
        metadataPath,
        tarballPath:verified.tarballPath,
        requireCleanSource:true
    });
    assert.deepEqual(after.manifest.artifact,verified.manifest.artifact);
});
