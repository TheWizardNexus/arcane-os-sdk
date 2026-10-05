import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {packageApp,verifyApp} from '../src/packager/core.mjs';

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
