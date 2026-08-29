import assert from 'node:assert/strict';
import {access,readFile} from 'node:fs/promises';
import test from 'arcane-os/testing';

const appRoot=new URL('../',import.meta.url);
const exampleRoot=new URL('../../../',import.meta.url);

async function readApp(path){
    return readFile(new URL(path,appRoot),'utf8');
}

test('the authored page is a minimal SDK chat wrapper',async function minimalChatPage(){
    const html=await readApp('index.html');
    const themeIndex=html.indexOf('/runtime/arcane/css/theme.css');
    const appStyleIndex=html.indexOf('./hello-world.css');
    assert.ok(themeIndex>=0);
    assert.ok(appStyleIndex>themeIndex);
    assert.match(html,/id="hello-world-chat"/u);
    assert.match(html,/href="\/runtime\/arcane\/components\/chat\.html\?v=1"/u);
    assert.match(html,/presentation="basic"/u);
    assert.match(html,/src="\.\/modules\/App\.js\?v=1"/u);
    assert.match(html,/"arcane\/AI": "\/runtime\/arcane\/modules\/AI\.js"/u);
    assert.match(html,/"arcane-os\/ai\/browser-wasm": "\/browser-runtime\/ai\/browser-wasm\.mjs"/u);
    assert.match(html,/"arcane-os\/event-manager": "\/src\/event-manager\.mjs"/u);
    assert.doesNotMatch(html,/id="(?:ai|llm|stt|tts)-(?:load|unload|cancel|progress|prompt|response|transcribe|synthesize)"/u);
    assert.doesNotMatch(html,/Full SDK AI lifecycle|Named browser imports|Same files in dev and dist/u);
    assert.doesNotMatch(html,/arcane-card|eyebrow|app-status|app-environment/u);
});

test('the app composes canonical SDK providers and session ownership',async function canonicalSDKComposition(){
    const source=await readApp('modules/App.js');
    assert.match(source,/from 'arcane\/ThemeBootstrap'/u);
    assert.match(source,/import 'arcane\/HTMLImport'/u);
    assert.match(source,/from 'arcane\/AI'/u);
    assert.match(source,/from 'arcane\/WaitForComponent'/u);
    assert.match(source,/from 'arcane-os\/ai\/browser-wasm'/u);
    assert.match(source,/createBrowserWasmLlmProvider/u);
    assert.match(source,/configureBrowserSpeech/u);
    assert.match(source,/chat\.bindSession\(\{/u);
    assert.match(source,/loadExisting:true/u);
    assert.match(source,/memory:false/u);
    assert.doesNotMatch(source,/createPersistentAIChatSession|sendMessageThroughSDK|chat\.sendMessage\s*=|new AbortController|providerRuntime\.load|providerRuntime\.unload|setSpeechMuted|addEventListener\(['"]pagehide|Object\.freeze/u);
});

test('the maintained speech defaults are concrete upstream selections',async function maintainedSpeechDefaults(){
    const source=await readApp('modules/SpeechAuthorities.js');
    assert.match(source,/Xenova\/whisper-small/u);
    assert.match(source,/2d67713f236afa48a18992566e7647f6ca848e13/u);
    assert.match(source,/dtype:'q8'/u);
    assert.match(source,/@huggingface\/transformers@\$\{transformersVersion\}/u);
    assert.match(source,/onnx-community\/Kokoro-82M-v1\.0-ONNX/u);
    assert.match(source,/1939ad2a8e416c0acfeecc08a694d14ef25f2231/u);
    assert.match(source,/defaultVoice:'af_heart'/u);
    assert.match(source,/kokoro-js@1\.2\.1/u);
    assert.doesNotMatch(source,/\bfetch\s*\(|Object\.freeze/u);
});

test('the browser descriptors need no authored permission or security scaffolding',async function ordinaryBrowserDescriptors(){
    const descriptor=JSON.parse(await readApp('arcane-app.json'));
    const packageDescriptor=JSON.parse(await readApp('arcane-package.json'));
    assert.deepEqual(descriptor.targets,['browser']);
    assert.equal(Object.hasOwn(descriptor,'permissions'),false);
    assert.equal(Object.hasOwn(descriptor,'security'),false);
    assert.equal(Object.hasOwn(packageDescriptor,'permissions'),false);
    assert.equal(Object.hasOwn(packageDescriptor,'security'),false);
    assert.equal(Object.hasOwn(descriptor.requirements,'minimumCoreVersion'),false);
});

test('the intended 0.3.2 example has no authored Arcane lock',async function intendedReleaseMetadata(){
    const packageManifest=JSON.parse(
        await readFile(new URL('package.json',exampleRoot),'utf8')
    );
    const packageLock=JSON.parse(
        await readFile(new URL('package-lock.json',exampleRoot),'utf8')
    );
    assert.equal(packageManifest.devDependencies['arcane-os'],'0.3.2');
    assert.equal(packageLock.packages[''].devDependencies['arcane-os'],'0.3.2');
    await assert.rejects(access(new URL('arcane.lock.json',exampleRoot)));
});

test('the README documents the SDK-owned chat contract',async function documentedContract(){
    const readme=await readFile(new URL('README.md',exampleRoot),'utf8');
    assert.match(readme,/minimal browser chat application composed from[\s\S]*current Arcane SDK source/u);
    assert.match(readme,/arcane-os@0\.3\.2/u);
    assert.match(readme,/SDK owns the session binding,[\s\S]*page teardown/u);
    assert.match(readme,/page load performs no model, voice, or speech-runtime download/u);
    assert.match(readme,/arcane\.lock\.json` is intentionally[\s\S]*absent/u);
});
