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

test('the selected npm tarball installs and exposes the public SDK',{
    timeout:180_000
},async t=>{
    const tarballPath=process.env.ARCANE_SDK_NPM_RELEASE_TARBALL;
    if(!tarballPath)return;

    assert.equal(process.platform,process.env.ARCANE_SDK_EXPECTED_PLATFORM);
    assert.equal(process.arch,process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE);
    const verified=await verifyNpmReleaseArtifact({tarballPath});

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
    assert.equal(installedPackage.name,'arcane-os');
    assert.equal(installedPackage.version,verified.version);
    assert.equal(installedPackage.exports['./mail'],'./src/mail-api.mjs');
    assert.equal(installedPackage.exports['./testing'],'./src/testing.mjs');
    assert.equal(
        installedPackage.exports['./preference-store'],
        './runtime/arcane/modules/PreferenceStore.js'
    );
    assert.equal(
        installedPackage.exports['./speech-playback'],
        './runtime/arcane/modules/SpeechPlayback.js'
    );

    const capabilityContract=path.join(consumerRoot,'installed-capability.test.mjs');
    await writeFile(capabilityContract,`import assert from 'node:assert/strict';
import {SDK_VERSION,createEventManager,listTargets} from 'arcane-os';
import test from 'arcane-os/testing';
import * as browserSpeech from 'arcane-os/ai/browser-speech';
import * as browserWasm from 'arcane-os/ai/browser-wasm';
import * as mail from 'arcane-os/mail';
import PreferenceStore from 'arcane-os/preference-store';
import SpeechPlayback from 'arcane-os/speech-playback';

test('installed public SDK entrypoints are functional',()=>{
    assert.equal(SDK_VERSION,${JSON.stringify(verified.version)});
    assert.equal(typeof createEventManager,'function');
    assert.ok(Array.isArray(listTargets()));
    assert.equal(typeof mail.Mail,'function');
    assert.equal(typeof PreferenceStore,'function');
    assert.equal(typeof SpeechPlayback,'function');
    assert.equal(typeof browserSpeech.createBrowserWhisperProvider,'function');
    assert.equal(typeof browserSpeech.createBrowserKokoroProvider,'function');
    assert.equal(typeof browserWasm.createBrowserWasmLlmProvider,'function');
    assert.equal(typeof browserWasm.createArcaneAI,'function');
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
    assert.equal(cliResult.stdout.trim(),verified.version);
});
