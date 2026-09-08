import assert from 'node:assert/strict';
import {
    lstat,
    mkdir,
    readFile,
    readdir,
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
import {generateDocumentImportMaps} from '../src/index.mjs';

function assertDocumentImportMap(html, prefix, suffix) {
    const maps = [
        ...html.matchAll(/<script\b(?=[^>]*\bdata-arcane-import-map(?:\s|>|=))[^>]*>([\s\S]*?)<\/script\s*>/gu)
    ];
    assert.equal(maps.length, 1);
    assert.ok(
        html.startsWith(prefix)
    );
    assert.ok(
        html.endsWith(suffix)
    );
    const inserted = html.slice(prefix.length, html.length - suffix.length);
    assert.match(
        inserted.replace(maps[0][0], ''),
        /^\s*$/u
    );
    return JSON.parse(maps[0][1]).imports;
}

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
        'event-pubsub':'./arcane/sdk/dependencies/event-pubsub/index.js',
        'strong-type':'./arcane/dependencies/strong-type/index.js'
    };
    for(const target of Object.values(expected))expected[target]=target;
    for(const specifier of Object.keys(expected)){
        expected[specifier]+=`?arcaneVersion=${SDK_VERSION}`;
        if(specifier.startsWith('./'))expected[`${specifier}?arcaneVersion=${SDK_VERSION}`]=expected[specifier];
    }
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

test(
    'public document map generation preserves host content and concurrent script loading without app metadata',
    async function hostDocumentMaps(context) {
        const documentRoot = await temporaryDirectory(context);
        await writeRuntimeFixture(documentRoot);
        const authoredMap = '<script type="importmap" data-product-map>{"imports":{"host":"../shared/host.js"}}</script>';
        const documents = [
            {
                path: 'shell/index.html',
                prefix: '<!doctype html>\r\n<html lang="en"><head>\r\n'
                    + '<link rel="manifest" href="../shared/document.webmanifest?theme=night#start">\r\n'
                    + authoredMap + '\r\n  ',
                suffix: '<script src="../shared/boot.js?keep=one#ready" defer></script>\r\n'
                    + '<script src="../shared/background.js" async></script>\r\n'
                    + '<script type="module" src="./Shell.js?keep=two" async></script>\r\n'
                    + '</head><body><main>  Keep every line, &amp; every trailing space.  </main></body></html>\r\n'
            },
            {
                path: 'provisioner/index.html',
                prefix: '<!doctype html>\n<html lang="en"><head>\n' + authoredMap + '\n    ',
                suffix: '<link rel="modulepreload" href="../shared/ready.js?mode=quick">\n'
                    + '<script type="module" src="./Provisioner.js" defer></script>\n'
                    + '</head><body><main>Complete provisioner content.</main></body></html>\n'
            }
        ];
        await Promise.all(
            documents.map(
                function writeHostDocument(document) {
                    return writeWorkspaceFile(documentRoot, document.path, document.prefix + document.suffix);
                }
            )
        );
        const inventory = await readdir(
            documentRoot,
            {recursive: true}
        );
        const documentPaths = documents.map(
            function hostDocumentPath(document) {
                return document.path;
            }
        );
        const options = {documentRoot, documents: documentPaths, version: '7.8.9'};
        const result = await generateDocumentImportMaps(options);
        assert.equal(result.documentRoot, documentRoot);
        assert.equal(
            result.runtimeRoot,
            path.join(documentRoot, 'arcane')
        );
        assert.deepEqual(
            result.documentPaths,
            documentPaths.map(
                function absoluteHostDocumentPath(relative) {
                    return path.join(documentRoot, relative);
                }
            )
        );
        assert.equal(result.documentCount, 2);
        assert.equal(result.committed, true);
        const firstDocuments = new Map();
        const mount = new URL('https://example.test/releases/deep/host/');
        for (const document of documents) {
            const filePath = path.join(documentRoot, document.path);
            const html = await readFile(filePath, 'utf8');
            const imports = assertDocumentImportMap(html, document.prefix, document.suffix);
            firstDocuments.set(document.path, html);
            const target = '../arcane/modules/ThemeBootstrap.js?arcaneVersion=7.8.9';
            assert.equal(imports['arcane/ThemeBootstrap'], target);
            assert.equal(imports['../arcane/modules/ThemeBootstrap.js'], target);
            assert.equal(imports['../arcane/modules/ThemeBootstrap.js?arcaneVersion=7.8.9'], target);
            assert.equal(
                imports['../node_modules/strong-type/index.js'],
                '../arcane/dependencies/strong-type/index.js?arcaneVersion=7.8.9'
            );
            const documentUrl = new URL(document.path, mount);
            assert.equal(
                new URL(imports['arcane/ThemeBootstrap'], documentUrl).href,
                new URL('arcane/modules/ThemeBootstrap.js?arcaneVersion=7.8.9', mount).href
            );
            const reported = result.documents.find(
                function matchingHostDocument(record) {
                    return record.path === document.path;
                }
            );
            assert.equal(reported.filePath, filePath);
            assert.deepEqual(reported.imports, imports);
        }
        await generateDocumentImportMaps(options);
        for (const document of documents) {
            const html = await readFile(
                path.join(documentRoot, document.path),
                'utf8'
            );
            assert.equal(
                html,
                firstDocuments.get(document.path)
            );
        }
        const finalInventory = await readdir(
            documentRoot,
            {recursive: true}
        );
        assert.deepEqual(
            finalInventory.sort(),
            inventory.sort()
        );
    }
);

test(
    'document maps use the first href base and distinguish directory and file bases without changing authored maps',
    async function authoredDocumentBases(context) {
        const documentRoot = await temporaryDirectory(context);
        await writeRuntimeFixture(documentRoot);
        const staleMap = '<script data-arcane-import-map type="importmap">{"imports":{"stale":"./old.js"}}</script>';
        const cases = [
            {path: 'shell/pages/directory.html', base: '../assets/', expected: '../../arcane/modules/ThemeBootstrap.js'},
            {path: 'shell/pages/file.html', base: '../assets', expected: '../arcane/modules/ThemeBootstrap.js'},
            {path: 'shell/pages/repeated.html', base: './/', expected: '../../../arcane/modules/ThemeBootstrap.js'}
        ];
        const documents = [];
        for (const selected of cases) {
            const prefix = '<!doctype html><html lang="en"><head>\n'
                + '<base target="_self">\n'
                + `<base href="${selected.base}">\n`
                + '<base href="../../../ignored/">\n'
                + '<script type="importmap"> { "imports": { "authored": "./local.js?original=yes" } } </script>\n \t';
            const suffix = '\t \n<link rel="manifest" href="./document.webmanifest">\n'
                + '<script type="module" src="./App.js?original=yes" async></script>\n'
                + '</head><body><main>Original host page.</main></body></html>\n';
            await writeWorkspaceFile(documentRoot, selected.path, prefix + staleMap + suffix);
            documents.push(
                {...selected, prefix, suffix}
            );
        }
        await generateDocumentImportMaps(
            {
                documentRoot,
                documents: cases.map(
                    function basedDocumentPath(selected) {
                        return selected.path;
                    }
                ),
                version: null
            }
        );
        const mount = new URL('https://example.test/releases/deep/host/');
        for (const document of documents) {
            const html = await readFile(
                path.join(documentRoot, document.path),
                'utf8'
            );
            const imports = assertDocumentImportMap(html, document.prefix, document.suffix);
            assert.equal(imports['arcane/ThemeBootstrap'], document.expected);
            const documentUrl = new URL(document.path, mount);
            const baseUrl = new URL(document.base, documentUrl);
            assert.equal(
                new URL(imports['arcane/ThemeBootstrap'], baseUrl).href,
                new URL('arcane/modules/ThemeBootstrap.js', mount).href
            );
            assert.equal(
                Object.hasOwn(imports, 'stale'),
                false
            );
        }
    }
);

test(
    'document maps encode runtime filenames and custom runtime locations while preserving document filenames',
    async function encodedDocumentMapPaths(context) {
        const documentRoot = await temporaryDirectory(context);
        const runtimeParent = path.join(documentRoot, 'payload#% library');
        const runtimeRoot = path.join(runtimeParent, 'arcane');
        await writeRuntimeFixture(runtimeParent);
        await writeWorkspaceFile(runtimeRoot, 'modules/Panel#100% ready.js', 'export const ready = true;\n');
        const documentPath = 'shell#% space/index#% page.html';
        const prefix = '<!doctype html><html lang="en"><head><title>Encoded paths</title>\n';
        const suffix = '<script type="module" src="./Host.js" async></script></head>'
            + '<body><main>Keep shell#% space/index#% page.html.</main></body></html>\n';
        const filePath = await writeWorkspaceFile(documentRoot, documentPath, prefix + suffix);
        const documentPaths = [documentPath];
        const result = await generateDocumentImportMaps(
            {documentRoot, runtimeRoot, documents: documentPaths, version: '7.8.9'}
        );
        const html = await readFile(filePath, 'utf8');
        const imports = assertDocumentImportMap(html, prefix, suffix);
        const targetPath = '../payload%23%25%20library/arcane/modules/Panel%23100%25%20ready.js';
        const target = `${targetPath}?arcaneVersion=7.8.9`;
        assert.equal(imports['arcane/Panel#100% ready'], target);
        assert.equal(imports[targetPath], target);
        assert.equal(imports[target], target);
        assert.equal(result.documents[0].path, documentPath);
        assert.equal(result.documents[0].filePath, filePath);
        const documentUrl = new URL('https://example.test/releases/deep/host/shell%23%25%20space/index%23%25%20page.html');
        assert.equal(
            new URL(imports['arcane/Panel#100% ready'], documentUrl).href,
            'https://example.test/releases/deep/host/payload%23%25%20library/arcane/modules/Panel%23100%25%20ready.js?arcaneVersion=7.8.9'
        );
    }
);

test(
    'a dot-prefixed runtime folder produces relative URL targets and compatibility keys',
    async function dotPrefixedDocumentRuntime(context) {
        const documentRoot = await temporaryDirectory(context);
        const runtimeRoot = path.join(documentRoot, '.arcane');
        await writeWorkspaceFile(runtimeRoot, 'modules/ThemeBootstrap.js', 'export default class ThemeBootstrap {}\n');
        const prefix = '<!doctype html><html lang="en"><head>\n';
        const suffix = '<script type="module" src="./Host.js" async></script>'
            + '</head><body><main>Complete host content.</main></body></html>\n';
        const filePath = await writeWorkspaceFile(documentRoot, 'index.html', prefix + suffix);
        const documents = ['index.html'];
        await generateDocumentImportMaps(
            {documentRoot, runtimeRoot, documents, version: null}
        );
        const html = await readFile(filePath, 'utf8');
        const imports = assertDocumentImportMap(html, prefix, suffix);
        const target = './.arcane/modules/ThemeBootstrap.js';
        assert.equal(imports['arcane/ThemeBootstrap'], target);
        assert.equal(imports[target], target);
        const documentUrl = new URL('https://example.test/releases/deep/host/index.html');
        assert.equal(
            new URL(imports['arcane/ThemeBootstrap'], documentUrl).href,
            'https://example.test/releases/deep/host/.arcane/modules/ThemeBootstrap.js'
        );
    }
);

test(
    'absolute document bases require the deployment URL before writing any selected document',
    async function deployedDocumentBases(context) {
        const documentRoot = await temporaryDirectory(context);
        await writeRuntimeFixture(documentRoot);
        const cases = [
            {path: 'plain.html', base: ''},
            {path: 'shell/root.html', base: '/other/assets/'},
            {path: 'shell/absolute.html', base: 'https://cdn.example.test/layout/page.html'},
            {path: 'shell/spaced-absolute.html', base: ' https://cdn.example.test/layout/page.html '}
        ];
        const documents = [];
        for (const selected of cases) {
            const prefix = '<!doctype html><html lang="en"><head>'
                + (selected.base ? `<base href="${selected.base}">` : '') + '\n';
            const suffix = '<script type="module" src="./Host.js" async></script>'
                + '</head><body><main>Complete deployed page.</main></body></html>\n';
            await writeWorkspaceFile(documentRoot, selected.path, prefix + suffix);
            documents.push(
                {...selected, prefix, suffix}
            );
        }
        const options = {
            documentRoot,
            documents: cases.map(
                function deployedDocumentPath(selected) {
                    return selected.path;
                }
            ),
            version: null
        };
        for (const selected of cases) {
            if (!selected.base) continue;
            const selectedDocuments = ['plain.html', selected.path];
            await assert.rejects(
                generateDocumentImportMaps(
                    {...options, documents: selectedDocuments}
                ),
                /deploymentUrl/u
            );
        }
        for (const document of documents) {
            const html = await readFile(
                path.join(documentRoot, document.path),
                'utf8'
            );
            assert.equal(html, document.prefix + document.suffix);
        }
        const deploymentUrl = 'https://example.test/releases/deep/host/';
        await generateDocumentImportMaps(
            {...options, deploymentUrl}
        );
        for (const document of documents) {
            const html = await readFile(
                path.join(documentRoot, document.path),
                'utf8'
            );
            const imports = assertDocumentImportMap(html, document.prefix, document.suffix);
            const documentUrl = new URL(document.path, deploymentUrl);
            const baseUrl = document.base ? new URL(document.base, documentUrl) : documentUrl;
            assert.equal(
                new URL(imports['arcane/ThemeBootstrap'], baseUrl).href,
                new URL('arcane/modules/ThemeBootstrap.js', deploymentUrl).href
            );
        }
    }
);

test(
    'documents without executable loads receive the managed map after an authored base outside the head',
    async function bodyBaseDocumentMap(context) {
        const documentRoot = await temporaryDirectory(context);
        await writeRuntimeFixture(documentRoot);
        const prefix = '<html><head></head><body><base href="../">';
        const suffix = '</body></html>';
        const filePath = await writeWorkspaceFile(documentRoot, 'shell/index.html', prefix + suffix);
        const documents = ['shell/index.html'];
        await generateDocumentImportMaps(
            {documentRoot, documents, version: null}
        );
        const html = await readFile(filePath, 'utf8');
        const imports = assertDocumentImportMap(html, prefix, suffix);
        const documentUrl = new URL('https://example.test/releases/deep/host/shell/index.html');
        const baseUrl = new URL('../', documentUrl);
        assert.equal(
            new URL(imports['arcane/ThemeBootstrap'], baseUrl).href,
            'https://example.test/releases/deep/host/arcane/modules/ThemeBootstrap.js'
        );
    }
);

test(
    'relative bases that traverse above the document root require a deployment URL even when they return',
    async function relativeBaseDeploymentCoordinates(context) {
        const documentRoot = await temporaryDirectory(context);
        await writeRuntimeFixture(documentRoot);
        const rootName = path.basename(documentRoot);
        const cases = [
            {path: 'shell/index.html', base: '../'},
            {path: 'shell/above.html', base: '../../'},
            {path: 'shell/return.html', base: `../../${rootName}/`},
            {path: 'shell/encoded-return.html', base: `%2e%2e/%2E%2E/${rootName}/`}
        ];
        const records = [];
        for (const selected of cases) {
            const prefix = `<html><head><base href="${selected.base}">`;
            const suffix = '</head><body>Complete authored document.</body></html>\n';
            const filePath = await writeWorkspaceFile(documentRoot, selected.path, prefix + suffix);
            records.push(
                {...selected, prefix, suffix, filePath}
            );
        }
        for (const record of records) {
            if (record.path === 'shell/index.html') continue;
            const documents = ['shell/index.html', record.path];
            await assert.rejects(
                generateDocumentImportMaps(
                    {documentRoot, documents, version: null}
                ),
                /deploymentUrl/u
            );
        }
        for (const record of records) {
            assert.equal(
                await readFile(record.filePath, 'utf8'),
                record.prefix + record.suffix
            );
        }
        const ordinaryDocuments = ['shell/index.html'];
        await generateDocumentImportMaps(
            {documentRoot, documents: ordinaryDocuments, version: null}
        );
        const ordinary = records[0];
        const ordinaryHtml = await readFile(ordinary.filePath, 'utf8');
        const ordinaryImports = assertDocumentImportMap(ordinaryHtml, ordinary.prefix, ordinary.suffix);
        assert.equal(ordinaryImports['arcane/ThemeBootstrap'], './arcane/modules/ThemeBootstrap.js');
        const deploymentUrl = 'https://example.test/releases/deep/host/';
        const documents = records.map(
            function relativeBaseDocumentPath(record) {
                return record.path;
            }
        );
        await generateDocumentImportMaps(
            {documentRoot, documents, version: null, deploymentUrl}
        );
        for (const record of records) {
            const html = await readFile(record.filePath, 'utf8');
            const imports = assertDocumentImportMap(html, record.prefix, record.suffix);
            const documentUrl = new URL(record.path, deploymentUrl);
            const baseUrl = new URL(record.base, documentUrl);
            assert.equal(
                new URL(imports['arcane/ThemeBootstrap'], baseUrl).href,
                new URL('arcane/modules/ThemeBootstrap.js', deploymentUrl).href
            );
        }
    }
);

test(
    'pre-aborted document map generation preserves every selected document',
    async function cancelledDocumentMaps(context) {
        const documentRoot = await temporaryDirectory(context);
        await writeRuntimeFixture(documentRoot);
        const source = '<!doctype html><html lang="en"><head></head><body>Complete source.\n</body></html>\n';
        const filePath = await writeWorkspaceFile(documentRoot, 'shell/index.html', source);
        const controller = new AbortController();
        const reason = new Error('Document-map request cancelled by its owner.');
        controller.abort(reason);
        const documents = ['shell/index.html'];
        await assert.rejects(
            generateDocumentImportMaps(
                {documentRoot, documents, signal: controller.signal}
            ),
            function originalCancellation(error) {
                return error === reason;
            }
        );
        const ordinaryController = new AbortController();
        ordinaryController.abort();
        await assert.rejects(
            generateDocumentImportMaps(
                {documentRoot, documents, signal: ordinaryController.signal}
            ),
            function originalPlatformCancellation(error) {
                return error === ordinaryController.signal.reason && error.name === 'AbortError';
            }
        );
        assert.equal(
            await readFile(filePath, 'utf8'),
            source
        );
    }
);
