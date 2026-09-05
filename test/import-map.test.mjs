import assert from 'node:assert/strict';
import {
    lstat,
    mkdir,
    readFile,
    rm,
    symlink,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from '../src/testing.mjs';
import {
    buildImportMap,
    createApplicationTestImportMapContext,
    generateImportMap,
    inspectImportMapHtml,
    readApplicationTestImportMapContext,
    scanModuleImports
} from '../src/import-map.mjs';
import {temporaryDirectory} from './helpers.mjs';
import {SDK_VERSION} from '../src/constants.mjs';

async function writeWorkspaceFile(workspaceRoot,relative,source){
    const filePath=path.join(workspaceRoot,...relative.split('/'));
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,source,'utf8');
    return filePath;
}

async function writeRuntimeFixture(workspaceRoot){
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/ThemeBootstrap.js',
        'export default class ThemeBootstrap {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/PreferenceStore.js',
        'export default class PreferenceStore {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/SpeechPlayback.js',
        'export default class SpeechPlayback {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/modules/PersistentAIChatSession.js',
        'export default class PersistentAIChatSession {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/entities/Preference.js',
        'export default class Preference {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/dependencies/strong-type/index.js',
        'export default class Is {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/event-manager.mjs',
        'export default class EventManager {}\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dom-event-instrumentation.mjs',
        'export const domEvent=true;\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/ai/browser-wasm.mjs',
        'export const browserWasm=true;\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/ai/browser-speech.mjs',
        'export const browserSpeech=true;\n'
    );
    await writeWorkspaceFile(
        workspaceRoot,
        'arcane/sdk/dependencies/event-pubsub/index.js',
        'export default class EventPubSub {}\n'
    );
}

async function createApplication(workspaceRoot,appId='import-map-app'){
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const entryPath=await writeWorkspaceFile(workspaceRoot,`apps/${appId}/index.html`,[
        '<!doctype html>',
        '<html>',
        '<head>',
        '    <base href="../../">',
        '</head>',
        '<body>',
        `    <script type="module" src="./apps/${appId}/modules/App.js"></script>`,
        '</body>',
        '</html>',
        ''
    ].join('\n'));
    await writeWorkspaceFile(
        workspaceRoot,
        `apps/${appId}/modules/App.js`,
        "import ThemeBootstrap from 'arcane/ThemeBootstrap';\nvoid ThemeBootstrap;\n"
    );
    return {appRoot,entryPath};
}

async function createSymlinkOrSkip(t,target,link,type){
    try{
        await symlink(target,link,type);
        return true;
    }catch(error){
        if(['EPERM','EACCES','ENOTSUP'].includes(error?.code)){
            t.skip(`symbolic links unavailable: ${String(error?.code)}`);
            return false;
        }
        throw error;
    }
}

test('complete runtime inventory produces a mutable named import map without reading file content',async()=>{
    let readAttempted=false;
    const result=await buildImportMap({
        files:[
            'modules/ThemeBootstrap.js',
            'modules/PreferenceStore.js',
            'modules/SpeechPlayback.js',
            'modules/PersistentAIChatSession.js',
            'entities/Preference.js',
            'dependencies/strong-type/index.js',
            'sdk/event-manager.mjs',
            'sdk/dom-event-instrumentation.mjs',
            'sdk/ai/browser-wasm.mjs',
            'sdk/ai/browser-speech.mjs',
            'sdk/dependencies/event-pubsub/index.js'
        ],
        readFile:async()=>{
            readAttempted=true;
            throw new Error('runtime content should not be read');
        }
    });

    assert.equal(readAttempted,false);
    const expected={
        '#arcane/persistent-ai-chat-session':'./arcane/modules/PersistentAIChatSession.js',
        './node_modules/strong-type/index.js':'./arcane/dependencies/strong-type/index.js',
        'arcane-os/ai/browser-speech':'./arcane/sdk/ai/browser-speech.mjs',
        'arcane-os/ai/browser-wasm':'./arcane/sdk/ai/browser-wasm.mjs',
        'arcane-os/dom-event-instrumentation':'./arcane/sdk/dom-event-instrumentation.mjs',
        'arcane-os/event-manager':'./arcane/sdk/event-manager.mjs',
        'arcane-os/preference-store':'./arcane/modules/PreferenceStore.js',
        'arcane-os/speech-playback':'./arcane/modules/SpeechPlayback.js',
        'arcane/PersistentAIChatSession':'./arcane/modules/PersistentAIChatSession.js',
        'arcane/PreferenceStore':'./arcane/modules/PreferenceStore.js',
        'arcane/SpeechPlayback':'./arcane/modules/SpeechPlayback.js',
        'arcane/ThemeBootstrap':'./arcane/modules/ThemeBootstrap.js',
        'arcane/entities/Preference':'./arcane/entities/Preference.js',
        'event-pubsub':'./arcane/sdk/dependencies/event-pubsub/index.js'
    };
    for(const target of Object.values(expected))expected[target]=target;
    for(const specifier of Object.keys(expected))expected[specifier]+=`?arcaneVersion=${SDK_VERSION}`;
    assert.deepEqual(result.imports,expected);
    assert.deepEqual(result.excludedModules,[]);
    result.imports['fixture/mutable']='./fixture.js';
    result.excludedModules.push('fixture.js');
    assert.equal(result.imports['fixture/mutable'],'./fixture.js');
    assert.equal(result.excludedModules.at(-1),'fixture.js');
});

test('module scanning reports literal imports while allowing runtime-selected dynamic imports',()=>{
    const selected='./selected.mjs';
    const result=scanModuleImports([
        "import first from './first.mjs';",
        "export {second} from './second.mjs';",
        "await import('./third.mjs');",
        'await import(selected);',
        'void first;',
        'void second;'
    ].join('\n'),{importer:'fixture.mjs'});

    assert.equal(result.hasModuleSyntax,true);
    assert.deepEqual(result.imports.map(item=>item.specifier),[
        './first.mjs',
        './second.mjs',
        './third.mjs'
    ]);
    result.imports.push({kind:'dynamic',specifier:selected,offset:0});
    assert.equal(result.imports.at(-1).specifier,selected);
});

test('generator writes one complete map into every selected browser document',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await writeRuntimeFixture(workspaceRoot);
    const {appRoot,entryPath}=await createApplication(workspaceRoot,'multi-document-map');
    const reviewPath=await writeWorkspaceFile(
        workspaceRoot,
        'apps/multi-document-map/pages/review.html',
        [
            '<!doctype html>',
            '<html>',
            '<head>',
            '    <base href="../../../">',
            '</head>',
            '<body>',
            '    <script type="module" src="./apps/multi-document-map/modules/App.js"></script>',
            '</body>',
            '</html>',
            ''
        ].join('\n')
    );
    const events=[];
    const result=await generateImportMap({
        workspaceRoot,
        appId:'multi-document-map',
        documents:['index.html','pages/review.html'],
        onEvent:event=>{events.push(event);}
    });

    const mapText=await readFile(result.artifactPath,'utf8');
    assert.equal(result.artifactPath,path.join(appRoot,'modules','arcane.importmap.json'));
    assert.equal(result.entryPath,entryPath);
    assert.equal(result.documentCount,2);
    assert.deepEqual(result.documentPaths,[entryPath,reviewPath]);
    assert.equal(result.committed,true);
    assert.equal('eventDelivery' in result,false);
    assert.equal(mapText,`${JSON.stringify({imports:result.imports},null,2)}\n`);

    for(const documentPath of result.documentPaths){
        const html=await readFile(documentPath,'utf8');
        const managed=html.match(
            /<script type="importmap" data-arcane-import-map>\n([\s\S]*?)<\/script>/u
        );
        assert.ok(managed);
        assert.equal(managed[1],mapText);
    }
    assert.equal(events[0].type,'import-map.started');
    assert.equal(events.at(-1).type,'import-map.completed');
    events[0].documentPaths.push('mutable');
    result.documentPaths.push('mutable');
    assert.equal(events[0].documentPaths.at(-1),'mutable');
    assert.equal(result.documentPaths.at(-1),'mutable');
});

test('regeneration replaces stale managed maps and keeps complete authored document content',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await writeRuntimeFixture(workspaceRoot);
    const {entryPath}=await createApplication(workspaceRoot,'regeneration');
    const authored=await readFile(entryPath,'utf8');
    await writeFile(entryPath,authored.replace(
        '</head>',
        '    <script type="importmap" data-arcane-import-map>\n{"imports":{"stale":"./stale.js"}}\n</script>\n</head>'
    ),'utf8');

    const first=await generateImportMap({workspaceRoot,appId:'regeneration'});
    const firstHtml=await readFile(entryPath,'utf8');
    const second=await generateImportMap({workspaceRoot,appId:'regeneration'});
    const secondHtml=await readFile(entryPath,'utf8');

    assert.equal(secondHtml,firstHtml);
    assert.deepEqual(second.imports,first.imports);
    assert.equal(secondHtml.includes('stale'),false);
    assert.equal(secondHtml.includes('<body>'),true);
    assert.equal(secondHtml.includes('</html>'),true);
});

test('malformed application HTML is rejected before any managed map is written',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await writeRuntimeFixture(workspaceRoot);
    const {appRoot,entryPath}=await createApplication(workspaceRoot,'malformed-html');
    await writeFile(entryPath,[
        '<!doctype html>',
        '<html>',
        '<head>',
        '    <base href="../../">',
        '    <base href="../../">',
        '</head>',
        '<body></body>',
        '</html>',
        ''
    ].join('\n'),'utf8');

    await assert.rejects(
        generateImportMap({workspaceRoot,appId:'malformed-html'}),
        /exactly one active <base/u
    );
    await assert.rejects(
        lstat(path.join(appRoot,'modules','arcane.importmap.json')),
        error=>error?.code==='ENOENT'
    );
});

test('HTML inspection exposes complete mutable structure records',()=>{
    const html=[
        '<!doctype html>',
        '<html>',
        '<head>',
        '    <base href="../../">',
        '    <script type="importmap" data-arcane-import-map>',
        '    {"imports":{}}',
        '    </script>',
        '    <link rel="modulepreload" href="./module.js">',
        '</head>',
        '<body><script type="module" src="./app.js"></script></body>',
        '</html>'
    ].join('\n');
    const inspected=inspectImportMapHtml(html);

    assert.equal(inspected.bases.length,1);
    assert.equal(inspected.managedMaps.length,1);
    assert.equal(inspected.links.length,1);
    assert.equal(inspected.scripts.length,2);
    inspected.scripts.push({type:'module',src:'./more.js'});
    inspected.bases[0].href='../';
    assert.equal(inspected.scripts.at(-1).src,'./more.js');
    assert.equal(inspected.bases[0].href,'../');
});

test('application documents and generated destinations reject symbolic links',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await writeRuntimeFixture(workspaceRoot);
    const {appRoot,entryPath}=await createApplication(workspaceRoot,'physical-files');
    const outside=await writeWorkspaceFile(workspaceRoot,'outside.html','<!doctype html>\n');
    await rm(entryPath);
    if(!await createSymlinkOrSkip(t,outside,entryPath,'file'))return;

    await assert.rejects(
        generateImportMap({workspaceRoot,appId:'physical-files'}),
        /must be a real file/u
    );

    await rm(entryPath);
    await writeFile(entryPath,[
        '<!doctype html>',
        '<html><head><base href="../../"></head><body></body></html>',
        ''
    ].join('\n'),'utf8');
    const destination=path.join(appRoot,'modules','arcane.importmap.json');
    await mkdir(path.dirname(destination),{recursive:true});
    if(!await createSymlinkOrSkip(t,outside,destination,'file'))return;
    await assert.rejects(
        generateImportMap({workspaceRoot,appId:'physical-files'}),
        /destination must be a real file/u
    );
});

test('application test maps stay inside the selected physical source, dist, or test boundary',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const applicationRoot=path.join(workspaceRoot,'app');
    const sourcePath=await writeWorkspaceFile(workspaceRoot,'app/source.js','export const source=true;\n');
    await writeWorkspaceFile(workspaceRoot,'app/dist/index.js','export const dist=true;\n');
    await writeWorkspaceFile(workspaceRoot,'app/test/helper.mjs','export const helper=true;\n');

    const sourceContext=await createApplicationTestImportMapContext({
        applicationRoot,
        boundary:'source',
        imports:{fixture:'./source.js'}
    });
    const distContext=await createApplicationTestImportMapContext({
        applicationRoot,
        boundary:'dist',
        imports:{fixture:'./index.js'}
    });
    const testContext=await createApplicationTestImportMapContext({
        applicationRoot,
        boundary:'test',
        imports:{fixture:'./helper.mjs'}
    });

    assert.equal(sourceContext.boundary,'source');
    assert.equal(sourceContext.imports.fixture,'./source.js');
    assert.equal(distContext.boundary,'dist');
    assert.equal(testContext.boundary,'test');
    sourceContext.imports.mutable='./source.js';
    assert.equal(sourceContext.imports.mutable,'./source.js');

    const outside=await writeWorkspaceFile(workspaceRoot,'outside.mjs','export default true;\n');
    await rm(sourcePath);
    if(!await createSymlinkOrSkip(t,outside,sourcePath,'file'))return;
    await assert.rejects(
        createApplicationTestImportMapContext({
            applicationRoot,
            boundary:'source',
            imports:{fixture:'./source.js'}
        }),
        /physical source directory/u
    );
});

test('application tests read the existing managed browser map from the workspace source',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    await writeRuntimeFixture(workspaceRoot);
    const {appRoot}=await createApplication(workspaceRoot,'managed-test-map');
    const generated=await generateImportMap({workspaceRoot,appId:'managed-test-map'});

    const context=await readApplicationTestImportMapContext({
        workspaceRoot,
        applicationRoot:appRoot
    });
    assert.equal(context.boundary,'source');
    assert.equal(context.baseURL,pathToFileURL(`${workspaceRoot}${path.sep}`).href);
    assert.deepEqual(context.imports,generated.imports);
    assert.equal(
        context.imports['arcane/ThemeBootstrap'],
        `./arcane/modules/ThemeBootstrap.js?arcaneVersion=${SDK_VERSION}`
    );
});
