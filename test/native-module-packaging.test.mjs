import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {packageApp,verifyApp} from '../src/packager/core.mjs';
import {installedSdkRoutes} from '../src/sdk-runtime-layout.mjs';

async function fixture(t,{secondDocument=false}={}){
    const parent=fileURLToPath(new URL('../.arcane/',import.meta.url));
    await mkdir(parent,{recursive:true});
    const workspaceRoot=await mkdtemp(path.join(parent,'native-module-fixture-'));
    t.after(function removeFixture(){return rm(workspaceRoot,{recursive:true,force:true});});
    async function write(file,content){
        const destination=path.join(workspaceRoot,...file.split('/'));
        await mkdir(path.dirname(destination),{recursive:true});
        await writeFile(destination,content,'utf8');
    }
    async function json(file,content){await write(file,JSON.stringify(content,null,2));}
    await json('package.json',{type:'module'});
    await json('arcane-packager.json',{
        schemaVersion:1,appsRoot:'.',distRoot:'dist',
        sharedPayloads:{runtime:[{
            source:'runtime',destination:'arcane',include:['modules','components'],exclude:[]
        }]}
    });
    await json('arcane-package.json',{
        schemaVersion:1,id:'native-example',displayName:'Moon burglar dashboard',version:'1.0.0',
        entry:'index.html',documents:secondDocument?['second.html']:[],strategy:'static',
        include:['index.html','lib','assets','content',...(secondDocument?['second.html']:[])],
        exclude:[],shared:['runtime']
    });
    const imports={
        flavor:'./lib/one.mjs',
        'parts/':'./lib/',
        './lib/alias.mjs':'./lib/one.mjs'
    };
    function document(map){
        return '<!doctype html>\n<base href="./">\n'
            +`<script type="importmap">${JSON.stringify(map)}</script>\n`
            +'<script type="module" src="./lib/entry.mjs" async></script>\n'
            +'<script type="module">import value from "flavor"; globalThis.moon=value;</script>\n'
            +'<script async async="async" defer="defer">globalThis.classicMoon="complete";</script>\n'
            +'<script src="./lib/classic.js" async defer></script>\n'
            +'<html-import href="./arcane/components/modal.html"></html-import>\n'
            +'<link rel="stylesheet" href="./assets/theme.css">\n'
            +'<img srcset="/assets/moon.svg 1x, /assets/moon.svg?phase=full&amp;view=night 2x, ">\n'
            +'<p>  Complete human content: import flavor from "flavor";  </p>\n';
    }
    const html=document({imports,scopes:{'./lib/scoped/':{flavor:'./lib/two.mjs'}}});
    await write('index.html',html);
    if(secondDocument){
        await write('second.html',document({imports:{...imports,flavor:'./lib/two.mjs'}}));
    }
    await write('lib/one.mjs','export default "moon-one";\n');
    await write('lib/two.mjs','export default "moon-two";\n');
    await write('lib/classic.js','globalThis.externalMoon="complete";\n');
    await write('lib/.moon.mjs','export const hiddenMoon="complete";\n');
    await write('lib/scoped/entry.mjs','export {default} from "flavor";\n');
    await write('lib/entry.mjs',[
        'import first from "flavor";',
        'import same from "./alias.mjs";',
        'export {default as scoped} from "./scoped/entry.mjs";',
        'export {cycle} from "./cycle.mjs";',
        'export {hiddenMoon} from "./.moon.mjs";',
        'export const later=()=>import("parts/two.mjs?role=night#moon");',
        'export const address=import.meta.resolve("flavor");',
        'export {first,same};'
    ].join('\n'));
    await write('lib/cycle.mjs','import "./entry.mjs"; export const cycle="complete";\n');
    await write('assets/theme.css','@import "./nested.css"; p{background:url(/assets/moon.svg)}\n');
    await write('assets/nested.css','p { color: rebeccapurple; }\n');
    await write('assets/moon.svg','<svg xmlns="http://www.w3.org/2000/svg"><text>Complete moon</text></svg>');
    const content='<script type="importmap">{"imports":{"unchanged":"./original.mjs"}}</script>'
        +'<script>Original supplied document content</script>\n';
    await write('content/original.html',content);
    await write('runtime/modules/runtime.mjs','export {default} from "flavor";\n');
    await write('runtime/modules/leaf.mjs','export default "external moon";\n');
    await write('runtime/modules/setup.js','this.externalValue=(await import("./leaf.mjs")).default;\n');
    await write('runtime/components/modal.html',
        '<p>Every component instance keeps this complete content.</p>\n'
        +'<script type="module">const {default:value}=await import("flavor");this.value=value;</script>\n'
        +'<script src="../modules/setup.js"></script>\n');
    return {workspaceRoot,write,json,html,content,document,imports};
}

test('native packaging emits local module references and complete external component scripts',async function nativeReferences(t){
    const selected=await fixture(t);
    const release=await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',
        outputDirectory:'dist/extension/app',moduleFormat:'native',browserPwa:false
    });
    async function output(file){return readFile(path.join(release.outputRoot,...file.split('/')),'utf8');}
    assert.equal(release.outputRoot,path.join(selected.workspaceRoot,'dist','extension','app'));
    assert.equal(release.manifest.app.start,'./index.html');
    const html=await output('index.html');
    assert.equal(html.includes('type="importmap"'),false);
    assert.ok(html.includes('<script type="module" src="./lib/entry.mjs" async>'));
    assert.ok(html.includes('src="./index.html.arcane-script-2.mjs"'));
    const classic=html.match(/<script[^>]+src="\.\/index\.html\.arcane-script-3\.js"[^>]*>/u)?.[0];
    assert.ok(classic,html);
    assert.equal(/\b(?:async|defer)\b/u.test(classic),false);
    assert.ok(html.includes('<script src="./lib/classic.js" async defer>'));
    assert.ok(html.includes('srcset="./assets/moon.svg 1x, ./assets/moon.svg?phase=full&amp;view=night 2x, "'));
    assert.ok(html.includes('<p>  Complete human content: import flavor from "flavor";  </p>'));
    const entry=await output('lib/entry.mjs');
    assert.ok(entry.includes('import first from "./one.mjs";'));
    assert.ok(entry.includes('import same from "./one.mjs";'));
    assert.ok(entry.includes('import("./two.mjs?role=night#moon")'));
    assert.ok(entry.includes('import.meta.resolve("./one.mjs")'));
    assert.ok(entry.includes('from "./.moon.mjs"'));
    assert.ok((await output('lib/scoped/entry.mjs')).includes('"../two.mjs"'));
    assert.ok((await output('assets/theme.css')).includes('url(./moon.svg)'));
    const component=await output('arcane/components/modal.html');
    assert.ok(component.includes('data-arcane-packaged-script=""'));
    assert.ok(component.includes('src="./modal.html.arcane-script-0.js"'));
    const script=await output('arcane/components/modal.html.arcane-script-0.js');
    assert.ok(script.includes('await import("../../lib/one.mjs")'));
    assert.ok(script.includes('this.value=value;'));
    assert.ok(script.includes('.call(binding.host)'));
    const external=await output('arcane/components/modal.html.arcane-script-1.js');
    assert.ok(external.includes('import("../modules/leaf.mjs")'));
    assert.ok(external.includes('this.externalValue='));
    assert.ok(release.files.includes('arcane/components/modal.html.arcane-script-0.js'));
    assert.equal(await output('content/original.html'),selected.content);
    assert.equal(await readFile(path.join(selected.workspaceRoot,'index.html'),'utf8'),selected.html);
    const verified=await verifyApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',outputDirectory:'dist/extension/app'
    });
    assert.equal(verified.outputRoot,release.outputRoot);
});

test(
    'native packaging removes source-generated PWA references before processing selected documents',
    async function nativeWithoutPwaReferences(context) {
        const selected = await fixture(
            context,
            {secondDocument: true}
        );
        const config = JSON.parse(await readFile(path.join(selected.workspaceRoot, 'arcane-package.json'), 'utf8'));
        config.pwa = {enabled: true};
        await selected.json('arcane-package.json', config);
        const savedConfig = await readFile(path.join(selected.workspaceRoot, 'arcane-package.json'), 'utf8');
        const references = '<link rel="manifest" href="./arcane.webmanifest">\n'
            + '<script type="module" async data-arcane-pwa src="./arcane-pwa.mjs"></script>\n'
            + '<script data-arcane-pwa>globalThis.unwantedPwaRegistration=true;</script>\n';
        const originals = new Map();
        for (const file of ['index.html', 'second.html']) {
            const original = await readFile(path.join(selected.workspaceRoot, file), 'utf8');
            const source = original.replace('<base href="./">', '<base href="./">\n' + references);
            originals.set(file, source);
            await selected.write(file, source);
        }
        const inactive = '<template>' + references + '</template>';
        const supplied = selected.content + references + inactive;
        await selected.write('content/original.html', supplied);
        const release = await packageApp(
            {
                workspaceRoot: selected.workspaceRoot,
                appId: 'native-example',
                outputDirectory: 'dist/extension/app',
                moduleFormat: 'native',
                browserPwa: false
            }
        );
        for (const [file, source] of originals) {
            const output = await readFile(path.join(release.outputRoot, file), 'utf8');
            assert.equal(output.includes('arcane.webmanifest'), false, file);
            assert.equal(output.includes('data-arcane-pwa'), false, file);
            assert.equal(output.includes('type="importmap"'), false, file);
            assert.equal(await readFile(path.join(selected.workspaceRoot, file), 'utf8'), source);
        }
        for (const file of release.files) {
            if (!/\.arcane-script-\d+\.[cm]?js$/u.test(file)) continue;
            const script = await readFile(path.join(release.outputRoot, file), 'utf8');
            assert.equal(script.includes('unwantedPwaRegistration'), false, file);
        }
        for (const file of ['arcane.webmanifest', 'arcane-pwa.mjs', 'arcane-sw.js', 'arcane-offline.json']) {
            assert.equal(release.files.includes(file), false, file);
        }
        assert.equal(
            await readFile(path.join(release.outputRoot, 'content/original.html'), 'utf8'),
            supplied
        );
        assert.equal(await readFile(path.join(selected.workspaceRoot, 'arcane-package.json'), 'utf8'), savedConfig);
        const verified = await verifyApp(
            {workspaceRoot: selected.workspaceRoot, appId: 'native-example', outputDirectory: 'dist/extension/app'}
        );
        assert.equal(verified.outputRoot, release.outputRoot);
    }
);

test('different document maps keep distinct cyclic graphs and share equal dependencies',async function nativeContexts(t){
    const selected=await fixture(t,{secondDocument:true});
    const release=await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',moduleFormat:'native',browserPwa:false
    });
    const second=await readFile(path.join(release.outputRoot,'second.html'),'utf8');
    const source=second.match(/src="(\.\/lib\/entry\.arcane-context-\d+\.mjs)"/u)?.[1];
    assert.ok(source,second);
    const entry=await readFile(path.join(release.outputRoot,source),'utf8');
    assert.ok(entry.includes('import first from "./two.mjs";'));
    assert.ok(entry.includes('import same from "./one.mjs";'));
    const cycleSource=entry.match(/from "(\.\/cycle\.arcane-context-\d+\.mjs)"/u)?.[1];
    assert.ok(cycleSource,entry);
    const cycle=await readFile(path.join(release.outputRoot,'lib',cycleSource),'utf8');
    assert.ok(cycle.includes(path.posix.basename(source)));
    assert.equal(release.files.filter(function duplicateLeaf(file){
        return /one\.arcane-context/u.test(file);
    }).length,0);
});

test('native output does not alter default maps or an existing browser destination',async function nativeDestination(t){
    const selected=await fixture(t);
    const browser=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'native-example'});
    const before=await readFile(path.join(browser.outputRoot,'index.html'),'utf8');
    assert.ok(before.includes('type="importmap"'));
    await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',moduleFormat:'native',
        outputDirectory:'dist/extension/app',browserPwa:false
    });
    assert.equal(await readFile(path.join(browser.outputRoot,'index.html'),'utf8'),before);
    const config=JSON.parse(await readFile(path.join(selected.workspaceRoot,'arcane-package.json'),'utf8'));
    assert.equal(config.outputDirectory,undefined);
});

test('an inline script with a remote base reports the incompatible transformation without replacing output',async function remoteInlineBase(t){
    const selected=await fixture(t);
    const browser=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'native-example'});
    const original=await readFile(path.join(browser.outputRoot,'index.html'),'utf8');
    await selected.write('index.html',selected.html.replace('<base href="./">','<base href="https://example.invalid/app/">'));
    await assert.rejects(packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',moduleFormat:'native',browserPwa:false
    }),/cannot externalize an inline script under a remote document base/u);
    assert.equal(await readFile(path.join(browser.outputRoot,'index.html'),'utf8'),original);
});

test('shared graphs use only the document contexts that reach them',async function laterDocumentGraph(t){
    const selected=await fixture(t,{secondDocument:true});
    await selected.write('second.html',selected.document({
        imports:{...selected.imports,'second-only':'./lib/two.mjs'}
    })+'<script type="module" src="./arcane/modules/later.mjs"></script>'
        +'<html-import href="./arcane/components/later.html"></html-import>');
    await selected.write('runtime/modules/later.mjs','export {default} from "second-only";\n');
    await selected.write('runtime/components/later.html','<script>this.later=await import("second-only");</script>');
    const release=await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',moduleFormat:'native',browserPwa:false
    });
    const later=await readFile(path.join(release.outputRoot,'arcane/modules/later.mjs'),'utf8');
    assert.ok(later.includes('from "../../lib/two.mjs"'));
    const component=await readFile(path.join(release.outputRoot,'arcane/components/later.html.arcane-script-0.js'),'utf8');
    assert.ok(component.includes('import("../../lib/two.mjs")'));
    assert.equal(await readFile(path.join(release.outputRoot,'arcane/modules/runtime.mjs'),'utf8'),
        'export {default} from "flavor";\n');
});

test('document and HTMLImport execution modes have separate generated source identities',async function documentAndComponent(t){
    const selected=await fixture(t);
    const config=JSON.parse(await readFile(path.join(selected.workspaceRoot,'arcane-package.json'),'utf8'));
    config.documents=['dual.html'];
    config.include.push('dual.html');
    await selected.json('arcane-package.json',config);
    await selected.write('dual.html','<!doctype html><script>this.dual=true;</script>');
    await selected.write('index.html',selected.html+'<html-import href="./dual.html"></html-import>');
    const release=await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',moduleFormat:'native',browserPwa:false
    });
    const documentScript=await readFile(path.join(release.outputRoot,'dual.html.arcane-script-0.js'),'utf8');
    assert.equal(documentScript,'this.dual=true;');
    const entry=await readFile(path.join(release.outputRoot,'index.html'),'utf8');
    const componentPath=entry.match(/<html-import href="([^"]*dual[^"]*)"/u)?.[1];
    assert.ok(componentPath,entry);
    const component=await readFile(path.join(release.outputRoot,componentPath),'utf8');
    const scriptPath=component.match(/src="([^"]+)"/u)?.[1];
    assert.ok(scriptPath,component);
    const wrapped=await readFile(path.join(release.outputRoot,path.posix.dirname(componentPath),scriptPath),'utf8');
    assert.ok(wrapped.includes('binding.promise='));
    assert.ok(wrapped.includes('this.dual=true;'));
});

test('literal runtime URLs reach selected shared components without rewriting supplied HTML documents',async function componentUrl(t){
    const selected=await fixture(t);
    await selected.write('lib/entry.mjs',
        'export const modal=new URL("../arcane/components/extra.html",import.meta.url).href;\n'
        +'export const document=new URL("../content/original.html",import.meta.url).href;\n');
    await selected.write('runtime/components/extra.html','<script>this.extra="complete";</script>');
    const release=await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'native-example',moduleFormat:'native',browserPwa:false
    });
    const component=await readFile(path.join(release.outputRoot,'arcane/components/extra.html'),'utf8');
    assert.ok(component.includes('data-arcane-packaged-script'));
    assert.equal(await readFile(path.join(release.outputRoot,'content/original.html'),'utf8'),selected.content);
});

async function installedDecisionFixture(context, {packageSource = 'node_modules/arcane-os', direct = true, pwa = false} = {}) {
    const selected = await fixture(context);
    const browserPath = direct ? `${packageSource}/browser-runtime` : 'arcane/sdk';
    await selected.json(
        'arcane-packager.json',
        {
            schemaVersion: 1, appsRoot: '.', distRoot: 'dist',
            sharedPayloads: {'browser-runtime': installedSdkRoutes(packageSource, {direct})}
        }
    );
    await selected.json(
        'arcane-package.json',
        {
            schemaVersion: 1, id: 'native-example', displayName: 'Moon burglar decisions', version: '1.0.0',
            entry: 'index.html', strategy: 'static', include: ['index.html'], exclude: [],
            shared: ['browser-runtime'], pwa: {enabled: pwa}
        }
    );
    await selected.json(`${packageSource}/package.json`, {name: 'arcane-os', version: '9.8.7', type: 'module'});
    const imports = {'arcane-os/ai/browser-decisions': `./${browserPath}/ai/browser-decisions.mjs`};
    const html = '<!doctype html><script type="importmap">'
        + JSON.stringify({imports}) + '</script>\n'
        + '<script type="module">import * as decisions from "arcane-os/ai/browser-decisions"; globalThis.decisions=decisions;</script>\n';
    await selected.write('index.html', html);
    for (const directory of ['components', 'css', 'entities', 'img', 'modules']) {
        await mkdir(path.join(selected.workspaceRoot, packageSource, 'runtime', 'arcane', directory), {recursive: true});
    }
    const module = 'import "./decision-worker.mjs";\n'
        + 'export const entry=new URL("./decisions-runtime/transformers.min.js",import.meta.url);\n';
    const resources = new Map([
        ['browser-runtime/ai/browser-decisions.mjs', module],
        ['browser-runtime/ai/decision-worker.mjs', 'export const localWorker="complete";\n'],
        ['browser-runtime/pwa.mjs', 'export function registerPwa() {}\nexport function mountPwaInstallPrompt() {}\n'],
        ['runtime/strong-type/index.js', 'export default function Is() {}\n'],
        ['LICENSE', 'Complete synthetic SDK license\n'],
        ['COMMERCIAL-LICENSE.md', 'Complete synthetic commercial license\n'],
        ['NOTICE', 'Complete synthetic SDK notice\n']
    ]);
    for (const [relative, content] of resources) {
        await selected.write(`${packageSource}/${relative}`, content);
    }
    return {...selected, packageSource, browserPath, html, module};
}

for (const moduleFormat of ['import-map', 'native']) {
    for (const route of [
        {packageSource: 'node_modules/arcane-os', direct: true},
        {packageSource: 'node_modules/@moon/arcane-sdk', direct: true},
        {packageSource: 'node_modules/arcane-sdk', direct: false}
    ]) {
        test(
            `${moduleFormat} decision packaging acquires opaque distribution beside ${route.packageSource} direct=${route.direct}`,
            async function installedDecisionDistribution(context) {
                const pwa = moduleFormat === 'import-map';
                const selected = await installedDecisionFixture(context, {...route, pwa});
                const originalFetch = globalThis.fetch;
                context.after(function restoreFetch() { globalThis.fetch = originalFetch; });
                const calls = [];
                const events = [];
                const moduleContent = 'import exact from "upstream-only";\n'
                    + 'export const url=new URL("./model.onnx?v=retain",import.meta.url); // 雪 complete trailing space \n';
                const wasmContent = new Uint8Array([0, 97, 115, 109, 0, 255, 0]);
                const licenseContent = 'Complete upstream license\nSecond line with trailing space \n';
                globalThis.fetch = async function selectedDistribution(url, {signal}) {
                    calls.push(url);
                    assert.equal(signal.aborted, false);
                    return new Response(url.endsWith('.wasm') ? wasmContent : url.endsWith('LICENSE') ? licenseContent : moduleContent);
                };
                const release = await packageApp(
                    {
                        workspaceRoot: selected.workspaceRoot, appId: 'native-example',
                        outputDirectory: 'dist/extension/app', moduleFormat, browserPwa: pwa, browserDecisions: true,
                        onEvent: function observeDistribution(event) {
                            if (event.type.startsWith('workspace.decisions.')) events.push(event);
                        }
                    }
                );
                const transformers = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/';
                const onnx = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/';
                assert.deepEqual(calls, [
                    `${transformers}dist/transformers.min.js`,
                    `${onnx}dist/ort-wasm-simd-threaded.asyncify.mjs`,
                    `${onnx}dist/ort-wasm-simd-threaded.asyncify.wasm`,
                    `${transformers}LICENSE`, `${onnx}LICENSE`
                ]);
                const distribution = `${selected.browserPath}/ai/decisions-runtime`;
                const offline = pwa
                    ? JSON.parse(await readFile(path.join(release.outputRoot, 'arcane-offline.json'), 'utf8'))
                    : null;
                if (!pwa) assert.equal(release.files.includes('arcane-offline.json'), false);
                for (const file of [
                    'transformers.min.js', 'ort-wasm-simd-threaded.asyncify.mjs',
                    'ort-wasm-simd-threaded.asyncify.wasm', 'TRANSFORMERS-LICENSE', 'ONNX-RUNTIME-LICENSE'
                ]) {
                    const relative = `${distribution}/${file}`;
                    const content = await readFile(path.join(release.outputRoot, relative));
                    if (file.endsWith('.wasm')) assert.deepEqual(new Uint8Array(content), wasmContent);
                    else assert.equal(content.toString('utf8'), file.endsWith('LICENSE') ? licenseContent : moduleContent);
                    assert.ok(release.files.includes(relative), relative);
                    assert.ok(release.manifest.files.includes(relative), relative);
                    if (offline) assert.ok(offline.assets.includes(`./${relative}`), relative);
                }
                assert.equal(events[0].type, 'workspace.decisions.started');
                assert.deepEqual(events.map(function completedFiles(event) { return event.completed; }), [0, 1, 2, 3, 4, 5]);
                const html = await readFile(path.join(release.outputRoot, 'index.html'), 'utf8');
                assert.equal(html.includes('type="importmap"'), moduleFormat === 'import-map');
                assert.equal(await readFile(path.join(selected.workspaceRoot, 'index.html'), 'utf8'), selected.html);
                assert.equal(
                    await readFile(path.join(selected.workspaceRoot, selected.packageSource, 'browser-runtime/ai/browser-decisions.mjs'), 'utf8'),
                    selected.module
                );
                await assert.rejects(readdir(path.join(selected.workspaceRoot, 'arcane')), {code: 'ENOENT'});
                await assert.rejects(
                    readdir(path.join(selected.workspaceRoot, selected.packageSource, 'browser-runtime/ai/decisions-runtime')),
                    {code: 'ENOENT'}
                );
            }
        );
    }
}

test('decision package acquisition is opt-in and dry runs leave the distribution unacquired', async function decisionDryRun(context) {
    const selected = await installedDecisionFixture(context);
    const originalFetch = globalThis.fetch;
    context.after(function restoreFetch() { globalThis.fetch = originalFetch; });
    globalThis.fetch = async function unexpectedAcquisition() {
        assert.fail('Default packaging and dry runs must not acquire optional browser executables.');
    };
    const ordinary = await packageApp({workspaceRoot: selected.workspaceRoot, appId: 'native-example'});
    assert.equal(ordinary.files.some(function distributionFile(file) { return file.includes('/decisions-runtime/'); }), false);
    const planned = await packageApp(
        {
            workspaceRoot: selected.workspaceRoot, appId: 'native-example',
            outputDirectory: 'dist/extension/app', moduleFormat: 'native', browserDecisions: true, dryRun: true
        }
    );
    assert.equal(planned.dryRun, true);
    await assert.rejects(readdir(path.join(selected.workspaceRoot, 'dist/extension/app')), {code: 'ENOENT'});
    await assert.rejects(
        readdir(path.join(selected.workspaceRoot, selected.packageSource, 'browser-runtime/ai/decisions-runtime')),
        {code: 'ENOENT'}
    );
});

test('decision distribution uses the existing offline selection without removing release files', async function decisionOfflineSelection(context) {
    const selected = await installedDecisionFixture(context, {pwa: true});
    const distribution = `${selected.browserPath}/ai/decisions-runtime`;
    const config = JSON.parse(await readFile(path.join(selected.workspaceRoot, 'arcane-package.json'), 'utf8'));
    config.pwa.offline = {exclude: [distribution]};
    await selected.json('arcane-package.json', config);
    const originalFetch = globalThis.fetch;
    context.after(function restoreFetch() { globalThis.fetch = originalFetch; });
    globalThis.fetch = async function distributionResponse() { return new Response('Complete selected distribution\n'); };
    const release = await packageApp(
        {workspaceRoot: selected.workspaceRoot, appId: 'native-example', browserDecisions: true}
    );
    const offline = JSON.parse(await readFile(path.join(release.outputRoot, 'arcane-offline.json'), 'utf8'));
    assert.ok(release.files.includes(`${distribution}/transformers.min.js`));
    assert.equal(offline.assets.some(function excludedDistribution(asset) { return asset.startsWith(`./${distribution}/`); }), false);
});

test('decision package option reports an unselected SDK module without acquiring files', async function missingDecisionModule(context) {
    const selected = await fixture(context);
    const originalFetch = globalThis.fetch;
    context.after(function restoreFetch() { globalThis.fetch = originalFetch; });
    globalThis.fetch = async function unexpectedAcquisition() { assert.fail('No selected SDK decision module to receive distribution.'); };
    await assert.rejects(
        packageApp({workspaceRoot: selected.workspaceRoot, appId: 'native-example', browserDecisions: true}),
        /requires the selected SDK browser-decisions module/u
    );
    assert.deepEqual(await readdir(path.join(selected.workspaceRoot, 'dist')), []);
});

for (const failureKind of ['http', 'observer']) {
    test(`decision package ${failureKind} failure preserves the previous release`, async function decisionFailure(context) {
        const selected = await installedDecisionFixture(context);
        const options = {
            workspaceRoot: selected.workspaceRoot, appId: 'native-example',
            outputDirectory: 'dist/extension/app', moduleFormat: 'native', browserPwa: false
        };
        const previous = await packageApp(options);
        const original = await readFile(path.join(previous.outputRoot, 'ARCANE_APP_RELEASE.json'), 'utf8');
        const originalFetch = globalThis.fetch;
        context.after(function restoreFetch() { globalThis.fetch = originalFetch; });
        const observerFailure = new Error('Complete selected-package observer failure.');
        const responseContent = 'Complete upstream HTTP explanation: 雪\nSecond line\n';
        globalThis.fetch = async function distributionResponse(url) {
            return failureKind === 'http' && url.endsWith('transformers.min.js')
                ? new Response(responseContent, {status: 503, statusText: 'Unavailable'})
                : new Response('Complete distribution fixture\n');
        };
        await assert.rejects(
            packageApp(
                {
                    ...options, browserDecisions: true,
                    onEvent: function observeDistribution(event) {
                        if (failureKind === 'observer' && event.type === 'workspace.decisions.progress') throw observerFailure;
                    }
                }
            ),
            function retainedFailure(error) {
                if (failureKind === 'observer') assert.equal(error, observerFailure);
                else {
                    assert.equal(error.code, 'ARCANE_DECISION_DISTRIBUTION_DOWNLOAD_FAILED');
                    assert.equal(error.response.status, 503);
                    assert.equal(new TextDecoder().decode(error.response.content), responseContent);
                }
                return true;
            }
        );
        assert.equal(await readFile(path.join(previous.outputRoot, 'ARCANE_APP_RELEASE.json'), 'utf8'), original);
        assert.deepEqual(await readdir(path.dirname(previous.outputRoot)), ['app']);
    });
}

test('decision package cancellation joins distribution work before removing its stage', async function decisionCancellation(context) {
    const selected = await installedDecisionFixture(context);
    const options = {
        workspaceRoot: selected.workspaceRoot, appId: 'native-example', outputDirectory: 'dist/extension/app'
    };
    const previous = await packageApp(options);
    const original = await readFile(path.join(previous.outputRoot, 'ARCANE_APP_RELEASE.json'), 'utf8');
    const originalFetch = globalThis.fetch;
    context.after(function restoreFetch() { globalThis.fetch = originalFetch; });
    const controller = new AbortController();
    const reason = new Error('Cancel selected package distribution.');
    let started;
    let finish;
    const allStarted = new Promise(function captureStarted(resolve) { started = resolve; });
    const cleanup = new Promise(function captureCleanup(resolve) { finish = resolve; });
    let calls = 0;
    let settled = 0;
    globalThis.fetch = async function pendingDistribution(url, {signal}) {
        const aborted = new Promise(function observeAbort(resolve) { signal.addEventListener('abort', resolve, {once: true}); });
        calls += 1;
        if (calls === 5) started();
        await aborted;
        await cleanup;
        settled += 1;
        throw signal.reason;
    };
    let returned = false;
    const operation = packageApp({...options, browserDecisions: true, signal: controller.signal});
    const rejected = assert.rejects(operation, function selectedReason(error) { return error === reason; })
        .then(function markReturned() { returned = true; });
    await allStarted;
    controller.abort(reason);
    await Promise.resolve();
    assert.equal(returned, false);
    finish();
    await rejected;
    assert.equal(settled, 5);
    assert.equal(await readFile(path.join(previous.outputRoot, 'ARCANE_APP_RELEASE.json'), 'utf8'), original);
    assert.deepEqual(await readdir(path.dirname(previous.outputRoot)), ['app']);
});
