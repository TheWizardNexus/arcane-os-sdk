import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {packageApp} from '../src/packager/core.mjs';

async function fixture(context,{secondDocument=false}={}){
    const parent=fileURLToPath(new URL('../.arcane/',import.meta.url));
    await mkdir(parent,{recursive:true});
    const workspaceRoot=await mkdtemp(path.join(parent,'embedded-module-fixture-'));
    context.after(function removeFixture(){return rm(workspaceRoot,{recursive:true,force:true});});
    const originals=new Map();
    async function write(file,content){
        const destination=path.join(workspaceRoot,...file.split('/'));
        await mkdir(path.dirname(destination),{recursive:true});
        await writeFile(destination,content,'utf8');
        originals.set(file,content);
    }
    async function json(file,content){await write(file,JSON.stringify(content,null,2));}
    await json('package.json',{type:'module'});
    await json('arcane-packager.json',{schemaVersion:1,appsRoot:'.',distRoot:'dist',sharedPayloads:{}});
    const config={
        schemaVersion:1,id:'embedded-example',displayName:'Moon burglar ledger',version:'1.0.0',
        entry:'index.html',documents:secondDocument?['second.html']:[],strategy:'static',
        include:['index.html','boot.js','lib','assets','content','LICENSE',...(secondDocument?['second.html']:[])],
        exclude:[],shared:[],pwa:{enabled:true}
    };
    await json('arcane-package.json',config);
    function document(flavor,scopedFlavor){
        return '<!doctype html>\n<html><head>\n'
            +'<script type="importmap">'+JSON.stringify({
                imports:{'moon-ledger':'./lib/entry.mjs',flavor:`./lib/${flavor}.mjs`},
                scopes:{'./lib/scoped/':{flavor:`./lib/${scopedFlavor}.mjs`}}
            })+'</script>\n'
            +'<link rel="modulepreload" href="./lib/entry.mjs">\n'
            +'<script data-moon-boot src="./boot.js" defer></script>\n'
            +'<script type="module" src="./lib/entry.mjs"></script>\n'
            +'<script type="module">import {read} from "moon-ledger";globalThis.moonInline=read;</script>\n'
            +'<link rel="manifest" href="./arcane.webmanifest">\n'
            +'<script type="module" data-arcane-pwa src="./arcane-pwa.mjs"></script>\n'
            +'<script data-arcane-pwa>globalThis.unwantedMoonPwa=true;</script>\n'
            +'<link rel="stylesheet" href="./assets/theme.css">\n'
            +'</head><body><p>  Complete moon ledger: 雪, craters, and trailing spaces.  </p>\n'
            +'<img src="./assets/moon.svg"></body></html>\n';
    }
    await write('index.html',document('red','green'));
    if(secondDocument)await write('second.html',document('blue','red'));
    await write('boot.js','globalThis.moonBoot=import("moon-ledger");\n');
    await write('lib/entry.mjs',[
        'import {count,increment} from "./counter.mjs";',
        'import {orbit} from "./orbit.mjs";',
        'import flavor from "flavor";',
        'export {default as scopedFlavor} from "./scoped/entry.mjs";',
        'export {count,increment,flavor};',
        'export const read=()=>({count,orbit:orbit()});',
        'export const later=()=>import("./counter.mjs?phase=full#north");',
        '// Complete source survives embedding: 雪 and trailing space ',
        ''
    ].join('\n'));
    await write('lib/counter.mjs','export let count=0;\nexport function increment(){count+=1;}\n');
    await write('lib/orbit.mjs','import {count} from "./entry.mjs";\nexport const orbit=()=>count;\n');
    await write('lib/scoped/entry.mjs','export {default} from "flavor";\n');
    for(const flavor of ['red','green','blue']){
        await write(`lib/${flavor}.mjs`,`export default "${flavor} moon";\n`);
    }
    await write('lib/unreferenced.mjs','import "unselected-moon";\nexport const untouched="complete";\n');
    await write('assets/theme.css','p { color: rebeccapurple; }\n');
    await write('assets/moon.svg','<svg xmlns="http://www.w3.org/2000/svg"><text>Complete moon 雪</text></svg>\n');
    await write('content/original.html','<script type="importmap">{"imports":{"moon":"./original.mjs"}}</script>\n'
        +'<script type="module">import "missing-supplied-content";</script>\n'
        +'<p>  This supplied document remains complete.  </p>\n');
    await write('LICENSE','Complete synthetic moon license\nEvery crater retains its notice. \n');
    return {workspaceRoot,write,json,config,originals};
}

function embeddedMap(html){
    const matches=[...html.matchAll(/<script\b[^>]*data-arcane-embedded-modules[^>]*>([\s\S]*?)<\/script>/gu)];
    assert.equal(matches.length,1,'The selected document has one generated module map.');
    assert.equal([...html.matchAll(/<script\b[^>]*type="importmap"/gu)].length,1);
    return JSON.parse(matches[0][1]).imports;
}

function moduleSource(imports,specifier){
    const url=imports[specifier];
    assert.equal(typeof url,'string',`The document map resolves ${specifier}.`);
    const match=url.match(/^data:text\/javascript;base64,([^#]+)(?:#.*)?$/u);
    assert.ok(match,`The selected module ${specifier} uses a JavaScript data URL.`);
    return Buffer.from(match[1],'base64').toString('utf8');
}

function reference(source,pattern){
    const match=source.match(pattern);
    assert.ok(match,`Expected executable reference ${pattern}.`);
    return match[1];
}

async function output(release,file){
    return readFile(path.join(release.outputRoot,...file.split('/')),'utf8');
}

async function graph(release,file){
    const html=await output(release,file);
    const imports=embeddedMap(html);
    const bootPath=reference(html,/<script data-moon-boot src="([^"]+)"/u);
    const boot=await output(release,bootPath);
    const entryKey=reference(boot,/import\("([^"]+)"\)/u);
    const entry=moduleSource(imports,entryKey);
    const counterKey=reference(entry,/import \{count,increment\} from "([^"]+)"/u);
    const orbitKey=reference(entry,/import \{orbit\} from "([^"]+)"/u);
    const flavorKey=reference(entry,/import flavor from "([^"]+)"/u);
    const scopedKey=reference(entry,/export \{default as scopedFlavor\} from "([^"]+)"/u);
    const laterKey=reference(entry,/later=\(\)=>import\("([^"]+)"\)/u);
    return {html,imports,boot,entryKey,entry,counterKey,orbitKey,flavorKey,scopedKey,laterKey};
}

test('embedded file output retains complete ESM cycles and live-binding source behind classic dynamic imports',async function completeEmbeddedGraph(context){
    const selected=await fixture(context);
    const release=await packageApp({
        workspaceRoot:selected.workspaceRoot,appId:'embedded-example',
        outputDirectory:'dist/thumb-drive',moduleFormat:'embedded'
    });
    assert.equal(release.outputRoot,path.join(selected.workspaceRoot,'dist','thumb-drive'));
    assert.equal(release.manifest.app.start,'./index.html');
    const result=await graph(release,'index.html');
    const {html,imports,entryKey,entry,counterKey,orbitKey,flavorKey,scopedKey,laterKey}=result;
    assert.equal(result.boot,selected.originals.get('boot.js').replace('"moon-ledger"',JSON.stringify(entryKey)));
    assert.equal(entry,selected.originals.get('lib/entry.mjs')
        .replace('"./counter.mjs"',JSON.stringify(counterKey))
        .replace('"./orbit.mjs"',JSON.stringify(orbitKey))
        .replace('"flavor"',JSON.stringify(flavorKey))
        .replace('"./scoped/entry.mjs"',JSON.stringify(scopedKey))
        .replace('"./counter.mjs?phase=full#north"',JSON.stringify(laterKey)));
    assert.equal(moduleSource(imports,counterKey),selected.originals.get('lib/counter.mjs'));
    assert.equal(moduleSource(imports,laterKey),selected.originals.get('lib/counter.mjs'));
    assert.notEqual(imports[counterKey],imports[laterKey],'A query/fragment module retains its separate module identity.');
    assert.equal(moduleSource(imports,orbitKey),selected.originals.get('lib/orbit.mjs')
        .replace('"./entry.mjs"',JSON.stringify(entryKey)));
    assert.equal(moduleSource(imports,flavorKey),selected.originals.get('lib/red.mjs'));
    const scoped=moduleSource(imports,scopedKey);
    const scopedFlavorKey=reference(scoped,/from "([^"]+)"/u);
    assert.equal(scoped,selected.originals.get('lib/scoped/entry.mjs').replace('"flavor"',JSON.stringify(scopedFlavorKey)));
    assert.equal(moduleSource(imports,scopedFlavorKey),selected.originals.get('lib/green.mjs'));
    const moduleScripts=[...html.matchAll(/<script type="module" src="([^"]+)"/gu)];
    assert.equal(moduleScripts.length,2);
    assert.equal(moduleScripts[0][1],imports[entryKey]);
    const inlineKey=Object.keys(imports).find(function inlineModule(key){return imports[key]===moduleScripts[1][1];});
    assert.equal(moduleSource(imports,inlineKey),`import {read} from "${entryKey}";globalThis.moonInline=read;`);
    assert.equal(reference(html,/<link rel="modulepreload" href="([^"]+)"/u),imports[entryKey]);
    const mapEnd=html.indexOf('</script>',html.indexOf('data-arcane-embedded-modules'));
    assert.ok(mapEnd<html.indexOf('<link rel="modulepreload"'));
    assert.ok(mapEnd<html.indexOf('<script data-moon-boot'));
    assert.ok(mapEnd<html.indexOf('<script type="module"'));
    assert.ok(html.includes('<p>  Complete moon ledger: 雪, craters, and trailing spaces.  </p>'));
    for(const name of ['arcane.webmanifest','arcane-pwa.mjs','arcane-sw.js','arcane-offline.json']){
        assert.equal(release.files.includes(name),false,name);
        assert.equal(html.includes(name),false,name);
    }
    assert.equal(html.includes('data-arcane-pwa'),false);
    assert.equal(html.includes('unwantedMoonPwa'),false);
    for(const [file,source] of selected.originals){
        assert.equal(await readFile(path.join(selected.workspaceRoot,file),'utf8'),source,`Original ${file}`);
        if(file.startsWith('lib/')||file.startsWith('assets/')||file.startsWith('content/')||file==='LICENSE'){
            assert.equal(await output(release,file),source,`Selected complete file ${file}`);
            assert.ok(release.files.includes(file),file);
        }
    }
});

test('embedded document scopes and equal-source query identities remain distinct where their imports differ',async function embeddedContexts(context){
    const selected=await fixture(context,{secondDocument:true});
    const identical='export let arrivals=0;\nexport function arrive(){arrivals+=1;}\n';
    for(const file of ['identity','twin-a','twin-b'])await selected.write(`lib/${file}.mjs`,identical);
    const identities=[
        './lib/identity.mjs?phase=one#north','./lib/identity.mjs?phase=one#south',
        './lib/identity.mjs?phase=two#north','./lib/twin-a.mjs','./lib/twin-b.mjs'
    ];
    await selected.write('boot.js',selected.originals.get('boot.js')
        +`globalThis.moonArrivals=[${identities.map(function literalImport(value){return `import(${JSON.stringify(value)})`;}).join(',')}];\n`);
    const release=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'embedded-example',moduleFormat:'embedded'});
    const first=await graph(release,'index.html');
    const second=await graph(release,'second.html');
    assert.notEqual(first.imports[first.entryKey],second.imports[second.entryKey]);
    assert.notEqual(first.imports[first.orbitKey],second.imports[second.orbitKey]);
    assert.equal(first.imports[first.counterKey],second.imports[second.counterKey]);
    assert.equal(second.imports[first.entryKey],undefined);
    assert.equal(first.imports[second.entryKey],undefined);
    for(const [result,flavor,scopedFlavor] of [[first,'red','green'],[second,'blue','red']]){
        assert.equal(moduleSource(result.imports,result.flavorKey),selected.originals.get(`lib/${flavor}.mjs`));
        const scoped=moduleSource(result.imports,result.scopedKey);
        const scopedFlavorKey=reference(scoped,/from "([^"]+)"/u);
        assert.equal(moduleSource(result.imports,scopedFlavorKey),selected.originals.get(`lib/${scopedFlavor}.mjs`));
        assert.equal(moduleSource(result.imports,result.orbitKey),selected.originals.get('lib/orbit.mjs')
            .replace('"./entry.mjs"',JSON.stringify(result.entryKey)));
        const arrivals=reference(result.boot,/globalThis\.moonArrivals=\[([^\]]+)\]/u);
        const keys=[...arrivals.matchAll(/import\("([^"]+)"\)/gu)].map(function importedKey(match){return match[1];});
        assert.equal(keys.length,identities.length);
        assert.equal(new Set(keys.map(function moduleUrl(key){return result.imports[key];})).size,identities.length);
        for(const key of keys)assert.equal(moduleSource(result.imports,key),identical);
    }
});

test('an unavailable embedded dependency reports its exact importer and preserves the previous output',async function missingEmbeddedDependency(context){
    const selected=await fixture(context);
    const options={
        workspaceRoot:selected.workspaceRoot,appId:'embedded-example',
        outputDirectory:'dist/thumb-drive',moduleFormat:'embedded'
    };
    const previous=await packageApp(options);
    const originals=new Map();
    for(const file of previous.files)originals.set(file,await output(previous,file));
    const manifest=await output(previous,'ARCANE_APP_RELEASE.json');
    await selected.write('lib/entry.mjs',selected.originals.get('lib/entry.mjs')
        +'export {absent} from "./missing.mjs?phase=night#crater";\n');
    await assert.rejects(packageApp(options),function missingModule(error){
        assert.ok(error instanceof TypeError);
        assert.equal(error.message,'Embedded module output requires the selected module '
            +'https://arcane.invalid/lib/missing.mjs?phase=night#crater imported by https://arcane.invalid/lib/entry.mjs.');
        return true;
    });
    for(const [file,source] of originals)assert.equal(await output(previous,file),source,file);
    assert.equal(await output(previous,'ARCANE_APP_RELEASE.json'),manifest);
    assert.deepEqual(await readdir(path.dirname(previous.outputRoot)),['thumb-drive']);
});

test('embedded SDK cloud and Markdown imports include the complete selected SDK source graph without evaluating it',async function selectedSdkSources(context){
    const selected=await fixture(context);
    const sources=new Map();
    for(const file of [
        'browser-runtime/ai/twin-cloud.mjs','browser-runtime/logging.mjs',
        'runtime/arcane/modules/MD.js','runtime/arcane/modules/Marked.min.js',
        'runtime/strong-type/index.js','runtime/strong-type/licence'
    ]){
        const source=await readFile(new URL(`../${file}`,import.meta.url),'utf8');
        sources.set(file,source);
        await selected.write(`sdk/${file}`,source);
    }
    selected.config.include.push('sdk');
    await selected.json('arcane-package.json',selected.config);
    await selected.write('index.html','<!doctype html>\n<script type="importmap">'+JSON.stringify({imports:{
        'arcane-os/ai/twin-cloud':'./sdk/browser-runtime/ai/twin-cloud.mjs',
        'arcane-os/logging':'./sdk/browser-runtime/logging.mjs',
        'arcane-os/MD':'./sdk/runtime/arcane/modules/MD.js',
        'strong-type':'./sdk/runtime/strong-type/index.js'
    }})+'</script>\n<script src="./boot.js" defer></script>\n');
    await selected.write('boot.js','globalThis.moonSdk=Promise.all([import("arcane-os/ai/twin-cloud"),import("arcane-os/MD")]);\n');
    const release=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'embedded-example',moduleFormat:'embedded'});
    const imports=embeddedMap(await output(release,'index.html'));
    const boot=await output(release,'boot.js');
    const keys=[...boot.matchAll(/import\("([^"]+)"\)/gu)].map(function importedKey(match){return match[1];});
    assert.equal(keys.length,2);
    const cloud=moduleSource(imports,keys[0]);
    const markdown=moduleSource(imports,keys[1]);
    const strongKey=reference(cloud,/import Is from '([^']+)'/u);
    const loggingKey=reference(cloud,/import \{arcaneLogging\} from '([^']+)'/u);
    const markedKey=reference(markdown,/import \{ Marked, marked \} from '([^']+)'/u);
    assert.equal(cloud,sources.get('browser-runtime/ai/twin-cloud.mjs')
        .replace("'strong-type'",`'${strongKey}'`)
        .replace("'../logging.mjs'",`'${loggingKey}'`));
    assert.equal(markdown,sources.get('runtime/arcane/modules/MD.js')
        .replace("'arcane-os/logging'",`'${loggingKey}'`)
        .replace("'./Marked.min.js'",`'${markedKey}'`)
        .replace("'strong-type'",`'${strongKey}'`));
    assert.equal(moduleSource(imports,strongKey),sources.get('runtime/strong-type/index.js'));
    assert.equal(moduleSource(imports,loggingKey),sources.get('browser-runtime/logging.mjs'));
    assert.equal(moduleSource(imports,markedKey),sources.get('runtime/arcane/modules/Marked.min.js'));
    for(const [file,source] of sources){
        assert.equal(await output(release,`sdk/${file}`),source,file);
        assert.equal(await readFile(path.join(selected.workspaceRoot,'sdk',file),'utf8'),source,file);
    }
});
