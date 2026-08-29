import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import * as sdk from '../src/index.mjs';
import {loadRuntimeRelease} from '../src/runtime.mjs';
import {loadSdkBrowserRuntimeRelease} from '../src/sdk-browser-runtime.mjs';

const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('public package metadata exposes the same lowercase browser and Node module paths',async()=>{
    const packageDocument=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
    assert.equal(
        packageDocument.exports['./speech-playback'],
        './runtime/arcane/modules/SpeechPlayback.js'
    );
    assert.equal(
        packageDocument.exports['./preference-store'],
        './runtime/arcane/modules/PreferenceStore.js'
    );
    const importMapSource=await readFile(path.join(repositoryRoot,'src','import-map.mjs'),'utf8');
    assert.match(importMapSource,/\['arcane-os\/speech-playback','modules\/SpeechPlayback\.js'\]/u);
    assert.match(importMapSource,/\['arcane-os\/preference-store','modules\/PreferenceStore\.js'\]/u);
});

test('public runtime contracts expose complete structural file and content APIs',async()=>{
    const runtime=await loadRuntimeRelease();
    const browser=await loadSdkBrowserRuntimeRelease();
    assert.equal(runtime.files.length>0,true);
    assert.equal(browser.files.length>0,true);
    for(const name of [
        'getSdkRoot',
        'listRuntimeFiles',
        'loadRuntimeRelease',
        'readRuntimeFile',
        'getSdkBrowserRuntimeRoot',
        'listSdkBrowserRuntimeFiles',
        'loadSdkBrowserRuntimeRelease',
        'readSdkBrowserRuntimeFile',
        'materializeWorkspaceRuntimeContent',
        'materializeWorkspaceRuntime'
    ]){
        assert.equal(typeof sdk[name],'function',`${name} is public.`);
    }
});
