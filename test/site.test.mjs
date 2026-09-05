import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {lstat,readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {projectPackageManifest,validateAppDescriptor} from '../src/app-descriptor.mjs';
import {buildImportMap} from '../src/import-map.mjs';
import test from '../src/testing.mjs';
import {
    createReferenceSite,
    publicContractSyntax,
    runtimeModuleSlug
} from '../tools/build-reference-site.mjs';
import {extractRuntimeReferenceContracts} from '../tools/reference-contract-extractor.mjs';
import {createReferenceModuleContractMap} from '../tools/reference-module-contracts.mjs';
import {
    filterModuleSearchRecords,
    moduleMatchesSearch,
    normalizeModuleSearch
} from '../site/reference/reference.js';
import {repositoryRoot} from './helpers.mjs';

const siteRoot=path.join(repositoryRoot,'site');
const exampleRoot=path.join(repositoryRoot,'examples','hello-world');
const canonicalRoot='https://thewizardnexus.github.io/arcane-os-sdk/';
const expectedCapabilityStrings=[
    'ai.inference',
    'ai.models.manage',
    'ai.models.read',
    'ai.runtime.manage',
    'ai.settings.manage',
    'appearance.read',
    'appearance.write',
    'applications.launch',
    'applications.read',
    'development.manage',
    'development.read',
    'diagnostics.read',
    'environment.protected.read',
    'environment.read',
    'environment.write',
    'external.open',
    'filesystem.directory.select',
    'firewall.manage',
    'firewall.read',
    'identity.read',
    'installation.read',
    'mail.send',
    'network.status.read',
    'preferences.read',
    'preferences.write',
    'provisioning.manage',
    'repository.kempo.read',
    'repository.kempo.write',
    'repository.spellwire.read',
    'requirements.read',
    'session.control',
    'storage.read',
    'storage.write',
    'system.metrics.read',
    'system.read',
    'terminal.execute',
    'users.manage'
];
const htmlCache=new Map();
const staticPageRoutes=new Map([
    ['index.html',''],
    ['quick-start/index.html','quick-start/'],
    ['guides/index.html','guides/'],
    ['guides/external-app/index.html','guides/external-app/'],
    ['guides/integrated-workspace/index.html','guides/integrated-workspace/'],
    ['guides/native-builds/index.html','guides/native-builds/'],
    ['examples/index.html','examples/'],
    ['playground/index.html','playground/'],
    ['testing/index.html','testing/'],
    ['reference/index.html','reference/'],
    ['architecture/index.html','architecture/'],
    ['compatibility/index.html','compatibility/']
]);
const compatibilityPageRoutes=new Map([
    ['examples/hello-world/index.html','examples/']
]);
const repositoryUrl='https://github.com/TheWizardNexus/arcane-os-sdk';
const pagesNavigationLabels=['Overview','Hello World','Guides','API','Reference','GitHub'];
const pagesNavigationHrefs=new Map([
    ['index.html',['./','examples/','guides/','reference/sdk-api/','reference/',repositoryUrl]],
    ['quick-start/index.html',['../','../examples/','../guides/','../reference/sdk-api/','../reference/',repositoryUrl]],
    ['guides/index.html',['../','../examples/','./','../reference/sdk-api/','../reference/',repositoryUrl]],
    ['guides/external-app/index.html',['../../','../../examples/','../','../../reference/sdk-api/','../../reference/',repositoryUrl]],
    ['guides/integrated-workspace/index.html',['../../','../../examples/','../','../../reference/sdk-api/','../../reference/',repositoryUrl]],
    ['guides/native-builds/index.html',['../../','../../examples/','../','../../reference/sdk-api/','../../reference/',repositoryUrl]],
    ['examples/index.html',['../','./','../guides/','../reference/sdk-api/','../reference/',repositoryUrl]],
    ['examples/hello-world/index.html',['../../','../','../../guides/','../../reference/sdk-api/','../../reference/',repositoryUrl]],
    ['playground/index.html',['../','../examples/','../guides/','../reference/sdk-api/','../reference/',repositoryUrl]],
    ['testing/index.html',['../','../examples/','../guides/','../reference/sdk-api/','../reference/',repositoryUrl]],
    ['architecture/index.html',['../','../examples/','../guides/','../reference/sdk-api/','../reference/',repositoryUrl]],
    ['compatibility/index.html',['../','../examples/','../guides/','../reference/sdk-api/','../reference/',repositoryUrl]]
]);

async function loadReferenceManifest(){
    return readJson(path.join(siteRoot,'reference','reference-manifest.json'));
}

async function loadPageRoutes(){
    const manifest=await loadReferenceManifest();
    const routes=new Map(staticPageRoutes);
    for(const page of manifest.pages){
        assert.match(page.output,/^site\/reference\/.+\/index[.]html$/u);
        assert.match(page.route,/^reference\/.+\/$/u);
        routes.set(page.output.slice('site/'.length),page.route);
    }
    return routes;
}

function sitePath(fileName){
    return path.join(siteRoot,...fileName.split('/'));
}

async function readSiteFile(fileName,encoding='utf8'){
    return readFile(sitePath(fileName),encoding);
}

async function readHtmlFile(filePath){
    let html=htmlCache.get(filePath);
    if(html===undefined){
        html=await readFile(filePath,'utf8');
        htmlCache.set(filePath,html);
    }
    return html;
}

async function readJson(filePath){
    return JSON.parse(await readFile(filePath,'utf8'));
}

function localReferences(html){
    const references=[];
    for(const tag of html.match(/<(?:a|img|link|script)\b[^>]*>/gu)??[]){
        const attribute=tag.match(/\b(?:href|src)="([^"]+)"/u);
        if(attribute)references.push(attribute[1]);
    }
    return references;
}

function externalReference(reference){
    return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(reference);
}

function escapePattern(value){
    return value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
}

function escapeHtmlSource(value){
    return value
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;');
}

function decodeReferenceHtml(value){
    return value
        .replace(/&#x([0-9a-f]+);/giu,(_,digits)=>String.fromCodePoint(Number.parseInt(digits,16)))
        .replace(/&#([0-9]+);/gu,(_,digits)=>String.fromCodePoint(Number.parseInt(digits,10)))
        .replaceAll('&quot;','"')
        .replaceAll('&apos;',"'")
        .replaceAll('&lt;','<')
        .replaceAll('&gt;','>')
        .replaceAll('&amp;','&');
}

function moduleExample(html){
    const start=html.indexOf('<h2 id="example">');
    const end=html.indexOf('<h2 id="related">',start);
    assert.ok(start>=0&&end>start,'The module page must have an example followed by related links.');
    const section=html.slice(start,end);
    const source=section.match(
        /<pre><code class="language-(javascript|html)">([\s\S]*?)<\/code><\/pre>/u
    );
    return source?{
        language:source[1],
        source:decodeReferenceHtml(source[2])
    }:null;
}

function htmlCellText(value){
    return decodeReferenceHtml(value.replace(/<[^>]*>/gu,''));
}

function primaryNavigationLinks(html){
    const navigation=html.match(
        /<nav id="primary-navigation"(?=[\s>])[^>]*>([\s\S]*?)<\/nav>/u
    );
    assert.ok(navigation,'The page must expose primary navigation.');
    return [...navigation[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gu)].map(anchor=>{
        const href=anchor[1].match(/\bhref="([^"]+)"/u);
        assert.ok(href,'Every primary-navigation link must have an href.');
        return {
            attributes:anchor[1],
            href:href[1],
            label:htmlCellText(anchor[2]).replace('↗','').trim()
        };
    });
}

function contractTableRows(html,label){
    const table=html.match(new RegExp(
        `aria-label="${escapePattern(label)}"[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>`,
        'u'
    ));
    if(!table)return [];
    return [...table[1].matchAll(/<tr>([\s\S]*?)<\/tr>/gu)].map(row=>
        [...row[1].matchAll(/<td>([\s\S]*?)<\/td>/gu)].map(cell=>
            htmlCellText(cell[1])
        )
    );
}

function contractListItems(html,startId,endId){
    const start=html.indexOf(`id="${startId}"`);
    const end=html.indexOf(`id="${endId}"`,start+1);
    assert.ok(start>=0&&end>start,`${startId} must precede ${endId}.`);
    return [...html.slice(start,end).matchAll(/<li>([\s\S]*?)<\/li>/gu)]
        .map(item=>htmlCellText(item[1]));
}

function bindingSignature(binding){
    if(binding.rawSignature)return binding.rawSignature;
    if(['alias','re-export'].includes(binding.form))return binding.rawDeclaration;
    return [binding.declarationKind??binding.valueKind??binding.form,binding.name]
        .filter(Boolean).join(' ');
}

function expectedStructuralMemberRows(sourceContract){
    const rows=[];
    const constructors=new Set();
    const fields=new Set();
    for(const binding of sourceContract.exports){
        const classContract=binding.classContract;
        if(!classContract)continue;
        const owner=classContract.name??binding.localName??binding.name;
        if(classContract.constructor){
            const key=`${owner}:${classContract.constructor.range.start}`;
            if(!constructors.has(key)){
                constructors.add(key);
                rows.push([
                    `${owner}.constructor`,
                    publicContractSyntax(classContract.constructor.rawSignature),
                    publicContractSyntax(classContract.constructor.parameters)
                ]);
            }
        }
        for(const field of classContract.fields){
            const key=`${owner}:${field.range.start}`;
            if(fields.has(key))continue;
            fields.add(key);
            rows.push([
                `${owner}.${field.name}`,
                publicContractSyntax(field.rawDeclaration),
                '—'
            ]);
        }
    }
    return rows;
}

function assertModuleExamplesParse(examples){
    const parser=`import vm from 'node:vm';
let input='';
for await (const chunk of process.stdin) input+=chunk;
for(const [name,source] of JSON.parse(input)){
    try{new vm.SourceTextModule(source,{identifier:name});}
    catch(error){
        process.stderr.write(name+': '+error.stack+'\\n');
        process.exitCode=1;
    }
}`;
    const result=spawnSync(
        process.execPath,
        ['--experimental-vm-modules','--input-type=module','--eval',parser],
        {
            input:JSON.stringify(examples),
            encoding:'utf8',
            maxBuffer:16*1024*1024,
            timeout:30_000,
            windowsHide:true
        }
    );
    assert.equal(result.status,0,result.stderr||result.error?.message);
}

async function assertLocalReference(sourceFile,reference){
    if(externalReference(reference))return;
    const [pathAndQuery,rawFragment='']=reference.split('#',2);
    const referencePath=pathAndQuery.split('?',1)[0];
    const sourcePath=sitePath(sourceFile);
    let targetPath=referencePath
        ?path.resolve(path.dirname(sourcePath),...referencePath.split('/'))
        :sourcePath;
    const relative=path.relative(siteRoot,targetPath);
    assert.equal(relative.startsWith('..')||path.isAbsolute(relative),false,`${sourceFile}: ${reference}`);
    const targetInfo=await stat(targetPath);
    if(targetInfo.isDirectory())targetPath=path.join(targetPath,'index.html');
    assert.equal((await stat(targetPath)).isFile(),true,`${sourceFile}: ${reference}`);
    if(!rawFragment)return;
    assert.equal(path.extname(targetPath),'.html',`${sourceFile}: ${reference}`);
    const fragment=decodeURIComponent(rawFragment);
    const targetHtml=await readHtmlFile(targetPath);
    assert.match(targetHtml,new RegExp(`\\bid="${escapePattern(fragment)}"`,'u'),`${sourceFile}: ${reference}`);
}

async function listHtmlFiles(directory=siteRoot,prefix=''){
    const files=[];
    for(const entry of await readdir(directory,{withFileTypes:true})){
        const relative=prefix?`${prefix}/${entry.name}`:entry.name;
        if(entry.isDirectory())files.push(...await listHtmlFiles(path.join(directory,entry.name),relative));
        if(entry.isFile()&&entry.name.endsWith('.html'))files.push(relative);
    }
    return files;
}

test('Pages routes are semantic, canonical, and project-path safe',async t=>{
    const canonicalPageRoutes=await loadPageRoutes();
    const pageRoutes=new Map([...canonicalPageRoutes,...compatibilityPageRoutes]);
    const actualPages=(await listHtmlFiles()).sort();
    assert.equal(staticPageRoutes.size,12);
    assert.equal(canonicalPageRoutes.size,128);
    assert.equal(compatibilityPageRoutes.size,1);
    assert.equal(pageRoutes.size,129);
    assert.equal(canonicalPageRoutes.get('examples/index.html'),'examples/');
    assert.equal(canonicalPageRoutes.has('examples/hello-world/index.html'),false);
    assert.equal(compatibilityPageRoutes.get('examples/hello-world/index.html'),'examples/');
    assert.deepEqual(actualPages,[...pageRoutes.keys()].sort());

    for(const [fileName,route] of pageRoutes){
        await t.test(fileName,async()=>{
            const html=await readSiteFile(fileName);
            const canonical=`${canonicalRoot}${route}`;
            const compatibility=compatibilityPageRoutes.has(fileName);
            assert.match(html,/^<!doctype html>/u);
            assert.match(html,/<html lang="en">/u);
            assert.match(html,/<meta name="viewport"/u);
            assert.match(html,/<meta name="description"/u);
            assert.match(
                html,
                compatibility
                    ?/<meta name="robots" content="noindex, follow">/u
                    :/<meta name="robots" content="index, follow">/u
            );
            assert.match(html,/Content-Security-Policy/u);
            assert.match(html,/default-src 'self'/u);
            assert.match(html,/connect-src 'none'/u);
            assert.match(html,/<a class="skip-link" href="#main-content">/u);
            assert.match(html,/<main id="main-content">/u);
            assert.equal((html.match(/<h1\b/gu)??[]).length,1);
            assert.doesNotMatch(html,/tabindex="[1-9][0-9]*"/u);
            assert.doesNotMatch(html,/(?:href|src)="\//u);
            assert.match(html,new RegExp(`<link rel="canonical" href="${escapePattern(canonical)}">`,'u'));
            assert.match(html,new RegExp(`<meta property="og:url" content="${escapePattern(canonical)}">`,'u'));
            assert.match(html,/arcane-os-sdk-readme-header[.]png/u);

            for(const anchor of html.match(/<a\b[^>]*target="_blank"[^>]*>/gu)??[]){
                assert.match(anchor,/rel="noreferrer"/u);
            }
            const references=localReferences(html);
            assert.ok(references.length>=5,fileName);
            for(const reference of references)await assertLocalReference(fileName,reference);
        });
    }

    const alias=await readSiteFile('examples/hello-world/index.html');
    assert.match(alias,/<a\b[^>]*href="[.][.]\/"[^>]*>/u);
});

test('Pages-owned primary navigation has one responsive global information architecture',async()=>{
    for(const [fileName,hrefs] of pagesNavigationHrefs){
        const links=primaryNavigationLinks(await readSiteFile(fileName));
        assert.deepEqual(links.map(link=>link.label),pagesNavigationLabels,fileName);
        assert.deepEqual(links.map(link=>link.href),hrefs,fileName);
        const repositoryLink=links.at(-1);
        assert.match(repositoryLink.attributes,/\bclass="repo-link"/u,fileName);
        assert.match(repositoryLink.attributes,/\btarget="_blank"/u,fileName);
        assert.match(repositoryLink.attributes,/\brel="noreferrer"/u,fileName);
    }
});

test('the complete API reference is a first-party generated Pages corpus',async t=>{
    const manifest=await loadReferenceManifest();
    const packageDocument=await readJson(path.join(repositoryRoot,'package.json'));
    assert.equal(manifest.schema,'arcane-reference-site/1');
    assert.deepEqual(manifest.versions,{
        sdk:packageDocument.version,
        runtime:'0.8.12',
        protocol:'arcane/1'
    });
    assert.deepEqual(manifest.counts,{
        markdownPages:28,
        collectionPages:2,
        generatedPages:86,
        runtimeModulePages:84,
        htmlPages:116,
        inventories:4
    });
    assert.equal(manifest.pages.filter(page=>page.kind==='markdown').length,28);
    assert.equal(manifest.pages.filter(page=>page.kind==='collection').length,2);
    assert.equal(manifest.pages.filter(page=>page.kind==='runtime-module').length,84);
    assert.equal(manifest.pages.filter(page=>page.kind==='generated').length,2);
    assert.equal(new Set(manifest.pages.map(page=>page.source)).size,116);
    assert.equal(new Set(manifest.pages.map(page=>page.output)).size,116);
    assert.equal(new Set(manifest.pages.map(page=>page.route)).size,116);
    const browserWasmPages=manifest.pages.filter(page=>
        page.source==='docs/reference/ai/browser-wasm.md'
    );
    assert.equal(browserWasmPages.length,1);
    assert.deepEqual(
        {
            source:browserWasmPages[0].source,
            output:browserWasmPages[0].output,
            route:browserWasmPages[0].route,
            kind:browserWasmPages[0].kind
        },
        {
            source:'docs/reference/ai/browser-wasm.md',
            output:'site/reference/ai/browser-wasm/index.html',
            route:'reference/ai/browser-wasm/',
            kind:'markdown'
        }
    );
    const browserSpeechPages=manifest.pages.filter(page=>
        page.source==='docs/reference/ai/browser-speech.md'
    );
    assert.equal(browserSpeechPages.length,1);
    assert.deepEqual(
        {
            source:browserSpeechPages[0].source,
            output:browserSpeechPages[0].output,
            route:browserSpeechPages[0].route,
            kind:browserSpeechPages[0].kind
        },
        {
            source:'docs/reference/ai/browser-speech.md',
            output:'site/reference/ai/browser-speech/index.html',
            route:'reference/ai/browser-speech/',
            kind:'markdown'
        }
    );

    await t.test('browser-local AI guides are complete, subordinate to normalized AI, and directly discoverable',async()=>{
        const [landing,overview,guide,speechGuide,normalized,sdk,referenceCss,sitemap]=await Promise.all([
            readSiteFile('reference/index.html'),
            readSiteFile('reference/overview/index.html'),
            readSiteFile('reference/ai/browser-wasm/index.html'),
            readSiteFile('reference/ai/browser-speech/index.html'),
            readSiteFile('reference/ai/index.html'),
            readSiteFile('reference/sdk-api/index.html'),
            readSiteFile('reference/reference.css'),
            readSiteFile('sitemap.xml')
        ]);
        const decodedGuide=decodeReferenceHtml(guide);
        const decodedSpeechGuide=decodeReferenceHtml(speechGuide);
        const decodedNormalized=decodeReferenceHtml(normalized);
        const decodedOverview=decodeReferenceHtml(overview);
        const decodedSdk=decodeReferenceHtml(sdk);
        assert.match(landing,/href="sdk-api\/">API<\/a>/u);
        assert.match(landing,/href="ai\/browser-wasm\/">Browser-WASM AI<\/a>/u);
        assert.match(landing,/<strong>202<\/strong>[\s\S]*18 JavaScript package entrypoints/u);
        assert.match(normalized,/Application default[.][\s\S]*browser-wasm-local-text-inference/u);
        assert.match(decodedNormalized,/arcane-os\/ai\/browser-wasm/u);
        assert.match(decodedNormalized,/AIProviderRuntime[.]js[\s\S]*AIRuntimeState[.]js/u);
        assert.match(decodedNormalized,/arcane-os\/ai\/browser-speech/u);
        assert.match(decodedNormalized,/PersistentAIChatSession[.]js[\s\S]*DBOPFSDocumentLibrary[.]js/u);
        assert.match(decodedNormalized,/\{id, files:\[\{name\?,url,bytes\?,sha256\?\},[.][.][.]\]\}/u);
        for(const value of [
            'arcane-os@0.2.3',
            'd717f21d45664d20e4ed6377596db87c47492e11',
            'sha512-TZewkGM7dh9PdVnOtnkBO7QalJ6qyWWdKruCmsTxoHyeoG5XpqVbkNgiJhtBLhrIzgUV3vydYplxZQkIbIWoHg==',
            '8e978a23289a41db130253e6475a0c8bb0c0d73f',
            '857f179c2f9d4549e7691b4e6cebc49e5ab5e18600816443b26319c61fc1f85d',
            '.github/workflows/publish-dev.yml'
        ])assert.ok(decodedOverview.includes(value),value);
        for(const target of [
            'https://github.com/TheWizardNexus/arcane-os-sdk/releases/tag/0.2.3',
            'https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/33052271534',
            'https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/33052383457'
        ])assert.match(overview,new RegExp(`href="${escapePattern(target)}"`,'u'),target);
        assert.match(decodedGuide,/arcane-ai-browser-wasm\/2/u);
        assert.match(decodedGuide,/@wllama\/wllama[\s\S]*3[.]6[.]0/u);
        assert.match(decodedGuide,/arcane[.]ai[.]browser-wasm[.]model[.]v4/u);
        assert.match(decodedGuide,/SDK default is secure:false/u);
        assert.match(decodedGuide,/observed byte length/u);
        assert.match(decodedGuide,/load\(\{offline:true\}\)[\s\S]*ARCANE_AI_MODEL_OFFLINE_MISS/u);
        assert.match(decodedGuide,/AbortSignal[\s\S]*ARCANE_AI_REQUEST_ABORTED/u);
        assert.match(decodedGuide,/never invokes a handler or executes a tool/u);
        assert.match(decodedGuide,/packages no model weights/u);
        for(const value of [
            'ARCANE_AI_MODEL_AUTHORITY_REQUIRED',
            'ARCANE_AI_STORAGE_CAPACITY_INSUFFICIENT',
            'ARCANE_AI_PROVIDER_ROLE_MISMATCH',
            'ARCANE_AI_PROVIDER_PROGRESS_INVALID',
            'ARCANE_AI_MODEL_NOT_READY',
            'ARCANE_AI_PROVIDER_STATUS_INVALID',
            'ARCANE_AI_PROVIDER_OPERATION_UNAVAILABLE',
            'ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED',
            'ARCANE_AI_WEBASSEMBLY_UNAVAILABLE',
            'ARCANE_AI_MODEL_STORAGE_REQUIREMENT_UNKNOWN',
            'ARCANE_AI_STORAGE_ESTIMATE_INVALID',
            'ARCANE_AI_WEBGPU_EXECUTION_UNOBSERVED'
        ])assert.ok(decodedGuide.includes(value),value);
        assert.match(decodedGuide,/existing ModelController[\s\S]*does not reapply its loadPolicy[\s\S]*supplying security[\s\S]*throws TypeError/u);
        assert.match(decodedSpeechGuide,/arcane-os\/ai\/browser-speech/u);
        assert.match(decodedSpeechGuide,/Whisper speech-to-text[\s\S]*Kokoro text-to-speech/u);
        assert.match(decodedSpeechGuide,/arcane-ai-provider\/2/u);
        assert.match(decodedSpeechGuide,/Ordinary speech operation[\s\S]*complete functional path/u);
        assert.match(decodedSpeechGuide,/bare specifier remains unchanged[\s\S]*native import-map resolution/u);
        assert.match(decodedSpeechGuide,/complete nested messages[\s\S]*without a depth or content cap/u);
        assert.doesNotMatch(
            decodedSpeechGuide,
            /checks[.]byteLength|checks[.]sha256|identitySha256|completion manifest|artifactGraphAdmission/u
        );
        for(const name of [
            'BROWSER_WASM_RUNTIME_AUTHORITY',
            'createArcaneAI()',
            'createBrowserModelSource()',
            'createBrowserWasmLlmProvider()',
            'createDbopfsModelStore()'
        ])assert.match(decodedSdk,new RegExp(escapePattern(name),'u'),name);
        for(const page of manifest.pages){
            const html=await readFile(path.join(repositoryRoot,...page.output.split('/')),'utf8');
            const start=html.indexOf('<aside class="docs-sidebar reference-sidebar"');
            const end=html.indexOf('</aside>',start);
            assert.ok(start>=0&&end>start,page.output);
            assert.equal(
                (html.slice(start,end).match(/>Browser-WASM AI<\/a>/gu)??[]).length,
                1,
                page.output
            );
            assert.equal(
                (html.slice(start,end).match(/>Browser speech<\/a>/gu)??[]).length,
                1,
                page.output
            );
            assert.match(html,/class="repo-link" href="[^"]*">API<\/a>/u,page.output);
        }
        assert.equal(
            (sitemap.match(/<loc>https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/reference\/ai\/browser-wasm\/<\/loc>/gu)??[]).length,
            1
        );
        assert.equal(
            (sitemap.match(/<loc>https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/reference\/ai\/browser-speech\/<\/loc>/gu)??[]).length,
            1
        );
        assert.match(referenceCss,/@media \(max-width: 1280px\)[\s\S]*[.]reference-toc[\s\S]*display: none/u);
        assert.match(referenceCss,/@media \(max-width: 1200px\)[\s\S]*[.]site-header [.]nav-toggle[\s\S]*display: block/u);
        assert.match(referenceCss,/[.]table-wrap\[data-columns="5"\][\s\S]*84rem/u);
        assert.match(referenceCss,/word-break: normal/u);
        assert.match(guide,/<details class="reference-toc-compact">/u);
        assert.match(
            guide,
            /aria-label="Breadcrumb"[\s\S]*href="[.][.]\/">Normalized AI<\/a>[\s\S]*aria-current="page">Browser-WASM local AI/u
        );
        assert.match(
            speechGuide,
            /aria-label="Breadcrumb"[\s\S]*href="[.][.]\/">Normalized AI<\/a>[\s\S]*aria-current="page">Browser speech providers/u
        );
        for(const anchor of [
            'browserwasmruntimeauthority',
            'createarcaneai',
            'createbrowsermodelsource',
            'createbrowserwasmllmprovider',
            'createdbopfsmodelstore'
        ]){
            assert.match(guide,new RegExp(`<h2 id="${anchor}">`,'u'),anchor);
            assert.match(sdk,new RegExp(`<h3 id="${anchor}">`,'u'),anchor);
        }
    });

    await t.test('the landing and rendered documents keep detailed navigation on Pages',async()=>{
        const landing=await readSiteFile('reference/index.html');
        assert.doesNotMatch(
            landing,
            /href="https:\/\/github[.]com\/TheWizardNexus\/arcane-os-sdk\/(?:blob|tree)\/main\/docs\/reference/iu
        );
        for(const page of manifest.pages.filter(record=>record.kind==='markdown')){
            const html=await readFile(path.join(repositoryRoot,...page.output.split('/')),'utf8');
            assert.doesNotMatch(html,/href="(?!https?:)[^"]+[.]md(?:[?#][^"]*)?"/iu,page.output);
            assert.doesNotMatch(html,/href="javascript:/iu,page.output);
            assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/iu,page.output);
            assert.doesNotMatch(html,/reference-source-link/u,page.output);
            assert.doesNotMatch(
                html,
                /github[.]com\/TheWizardNexus\/(?:ARCANE-OS\/|arcane-os-sdk\/(?!(?:releases\/tag\/[0-9]+[.][0-9]+[.][0-9]+|actions\/runs\/[0-9]+)(?:["?#])))/iu,
                page.output
            );
            assert.doesNotMatch(html,/Developer Reference Maintenance SOP|repository-only|npm run model:ensure/iu,page.output);
            const ids=[...html.matchAll(/\bid="([^"]+)"/gu)].map(match=>match[1]);
            assert.equal(new Set(ids).size,ids.length,`${page.output} contains duplicate element ids.`);
            if(html.includes('<pre><code')){
                assert.match(html,/class="[^"]*\bcode-block\b[^"]*"/u,page.output);
                assert.match(html,/data-copy-button/u,page.output);
                assert.match(html,/data-copy-status/u,page.output);
            }
        }
    });

    await t.test('published inventories structurally match their canonical sources',async()=>{
        for(const inventory of manifest.inventories){
            const [source,published]=await Promise.all([
                readJson(path.join(repositoryRoot,...inventory.source.split('/'))),
                readJson(path.join(repositoryRoot,...inventory.output.split('/')))
            ]);
            assert.deepEqual(published,source,inventory.output);
        }
    });

    await t.test('rendered API catalogs retain every inventoried public name',async()=>{
        const [packageApi,runtimeModules,runtimeEntities,runtimeComponents,sdk,modules,entities,components]=await Promise.all([
            readJson(path.join(repositoryRoot,'docs','reference','inventory','package-api.json')),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-modules.json')),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-entities.json')),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-components.json')),
            readSiteFile('reference/sdk-api/index.html'),
            readSiteFile('reference/runtime-modules/index.html'),
            readSiteFile('reference/runtime-entities/index.html'),
            readSiteFile('reference/runtime-components/index.html')
        ]);
        for(const member of packageApi.members){
            assert.ok(sdk.includes(escapeHtmlSource(member.displayName)),member.displayName);
        }
        for(const artifact of runtimeModules.artifacts){
            assert.ok(modules.includes(escapeHtmlSource(path.basename(artifact.file))),artifact.file);
        }
        for(const module of runtimeEntities.modules){
            assert.ok(entities.includes(escapeHtmlSource(path.basename(module.file))),module.file);
        }
        for(const component of runtimeComponents.artifacts){
            assert.ok(components.includes(escapeHtmlSource(component.name)),component.name);
        }
        assert.match(components,/<code>setNavigation\(\)<\/code><br><code>setActiveRoute\(\)<\/code>/u);
        assert.doesNotMatch(components,/&lt;br\s*\/?&gt;/iu);
    });

    await t.test('folded protocol explanations remain available without executing source HTML',async()=>{
        const [events,protocols]=await Promise.all([
            readSiteFile('reference/event-manager/index.html'),
            readSiteFile('reference/protocols/index.html')
        ]);
        assert.match(events,/<details>/u);
        assert.match(events,/<summary>/u);
        assert.match(protocols,/<details>/u);
        assert.match(protocols,/<summary>/u);
    });

    await t.test('the shipped import-map command and physical browser contract are complete',async()=>{
        const [
            cli,protocols,eventManager,sdk,packageApi,runtimeRelease,browserRelease
        ]=await Promise.all([
            readSiteFile('reference/cli/index.html'),
            readSiteFile('reference/protocols/index.html'),
            readSiteFile('reference/event-manager/index.html'),
            readSiteFile('reference/sdk-api/index.html'),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','package-api.json')),
            readJson(path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json')),
            readJson(path.join(repositoryRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json'))
        ]);
        const decodedCli=decodeReferenceHtml(cli);
        const decodedProtocols=decodeReferenceHtml(protocols);
        const decodedEvents=decodeReferenceHtml(eventManager);
        const decodedSdk=decodeReferenceHtml(sdk);

        assert.match(cli,/<h2 id="arcane-import-map"><code>arcane import-map<\/code><\/h2>/u);
        assert.match(decodedCli,/arcane import-map \[--workspace <directory>\] \[--app <id>\]/u);
        assert.match(decodedCli,/apps\/<id>\/modules\/arcane[.]importmap[.]json/u);
        assert.match(decodedCli,/data-arcane-import-map/u);
        assert.match(decodedCli,/entryCount:Object[.]keys\(imports\)[.]length/u);
        assert.match(decodedCli,/documentPaths/u);
        assert.match(decodedCli,/documentCount:1/u);
        assert.match(decodedCli,/role:'document'/u);
        assert.match(decodedCli,/ARCANE_RUNTIME_PROJECTION[.]json/u);
        assert.match(decodedCli,/ARCANE_RUNTIME_PROJECTION_INVALID/u);
        assert.match(decodedCli,/private \/ARCANE_APP_RELEASE[.]json/u);
        assert.match(cli,/There is no supported <code>--dry-run<\/code> for <code>import-map<\/code>/u);
        assert.match(decodedCli,/no\s+watcher, polling, scheduled refresh, download, or self-update/u);
        for(const code of [
            'ARCANE_IMPORT_MAP_INVALID',
            'ARCANE_IMPORT_MAP_UNRESOLVED',
            'ARCANE_IMPORT_MAP_COLLISION',
            'ARCANE_IMPORT_MAP_CLEANUP_FAILED'
        ])assert.match(decodedCli,new RegExp(code,'u'));

        assert.match(protocols,/id="sdk-package-and-cli-protocols"/u);
        assert.match(protocols,/id="browser-runtime-delivery"/u);
        assert.match(protocols,/id="portable-ai-provider-runtime"/u);
        assert.match(decodedProtocols,/import ollama from 'arcane\/Ollama';/u);
        for(const release of [runtimeRelease,browserRelease]){
            const value=`${String(release.fileCount)} files`;
            assert.ok(decodedProtocols.includes(value),value);
        }
        assert.match(
            decodedProtocols,
            new RegExp(
                `${String(runtimeRelease.fileCount+browserRelease.fileCount)} entries in total[\\s\\S]*not an import-map entry count`,
                'u'
            )
        );
        assert.match(decodedProtocols,/arcane-os\/event-manager[\s\S]*[.]\/arcane\/sdk\/event-manager[.]mjs/u);
        assert.match(decodedProtocols,/arcane-os\/ai\/browser-wasm[\s\S]*[.]\/arcane\/sdk\/ai\/browser-wasm[.]mjs/u);
        assert.match(decodedProtocols,/arcane-os\/ai\/browser-speech[\s\S]*[.]\/arcane\/sdk\/ai\/browser-speech[.]mjs/u);
        assert.match(decodedProtocols,/event-pubsub[\s\S]*[.]\/arcane\/sdk\/dependencies\/event-pubsub\/index[.]js/u);
        assert.match(decodedProtocols,/[.]\/node_modules\/strong-type\/index[.]js[\s\S]*[.]\/arcane\/dependencies\/strong-type\/index[.]js/u);
        assert.match(decodedProtocols,/documentPaths[\s\S]*documentCount[\s\S]*role:"document"/u);
        assert.match(decodedProtocols,/ARCANE_RUNTIME_PROJECTION[.]json[\s\S]*arcane-app-runtime-projection/u);
        assert.match(decodedProtocols,/private \/ARCANE_APP_RELEASE[.]json/u);
        assert.match(decodedProtocols,/sdkInstallation[\s\S]*dependencyName[\s\S]*browserRuntimeManifest/u);
        assert.match(decodedProtocols,/npm:arcane-os@0[.]3[.]0/u);
        assert.match(decodedProtocols,/sdkVersion: 0[.]3[.]0/u);
        assert.match(decodedProtocols,/WebGPU[\s\S]*99,999 GPU layers[\s\S]*no CPU fallback/u);
        assert.match(decodedProtocols,/PersistentAIChatSession[\s\S]*persist:false/u);
        assert.match(decodedProtocols,/tool calls are structural result data only[\s\S]*never executes a handler/iu);
        assert.match(decodedProtocols,/sourceIdentities/u);
        assert.match(decodedProtocols,/bounded handled-error transaction/u);

        assert.match(decodedEvents,/arcane\/sdk\/event-manager[.]mjs/u);
        assert.match(decodedEvents,/arcane\/sdk\/dependencies\/event-pubsub\/index[.]js/u);
        assert.match(decodedSdk,/toolchain[.]importMap\(/u);
        assert.match(decodedSdk,/executeOperation\('import-map'/u);
        assert.match(decodedSdk,/validateWorkspace[\s\S]*allowMissingManagedImportMap=false/u);
        assert.match(decodedSdk,/sdkInstallation[\s\S]*canonicalPackageRoot[\s\S]*browserRuntimeManifest/u);
        assert.match(decodedSdk,/ARCANE_RUNTIME_PROJECTION[.]json[\s\S]*ARCANE_RUNTIME_PROJECTION_INVALID/u);
        assert.match(decodedSdk,/documentPaths[\s\S]*documentCount/u);
        assert.match(
            sdk,
            /There is no exported\s+<code>importMapApplication\(\)<\/code> or <code>generateImportMap\(\)<\/code> binding/u
        );
        assert.equal(packageApi.sdkVersion,packageDocument.version);
        assert.equal(packageApi.memberCount,202);
        assert.deepEqual(
            packageApi.members
                .filter(member=>member.primaryImport==='arcane-os/ai/browser-speech')
                .map(member=>member.name),
            [
                'BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL',
                'BROWSER_SPEECH_ARTIFACT_PROTOCOL',
                'createBrowserKokoroProvider',
                'createBrowserSpeechArtifactGraph',
                'createBrowserSpeechAuthority',
                'createBrowserWhisperProvider',
                'createDbopfsSpeechArtifactStore'
            ]
        );
        assert.equal(packageApi.members.filter(member=>
            member.primaryImport==='arcane-os/ai/browser-wasm'
            &&member.name==='adaptV1LlmProvider'
        ).length,1);
        assert.equal(packageApi.members.some(member=>[
            'importMapApplication','generateImportMap'
        ].includes(member.name)),false);
        assert.doesNotMatch(sdk,/id="importmapapplication"/u);
    });
});

test('generated runtime reference contracts are exhaustive and reader-first',async t=>{
    const [firstPlan,runtimeInventory,sourceContracts]=await Promise.all([
        createReferenceSite(),
        readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-modules.json')),
        extractRuntimeReferenceContracts({repositoryRoot})
    ]);
    const records=runtimeInventory.artifacts;
    const modulePages=firstPlan.manifest.pages.filter(page=>page.kind==='runtime-module');
    const pagesBySource=new Map(modulePages.map(page=>[page.source,page]));
    const sourceByName=new Map(sourceContracts.modules.map(contract=>[contract.name,contract]));
    const overlays=createReferenceModuleContractMap(records);

    await t.test('source extraction covers the runtime inventory',()=>{
        assert.deepEqual(sourceContracts.modules.map(module=>module.name),records.map(record=>record.name));
    });

    await t.test('curated overlays cover the runtime inventory',()=>{
        assert.deepEqual([...overlays.keys()],records.map(record=>record.name));
        for(const [name,overlay] of overlays){
            assert.match(overlay.classification,/^(?:public-first-party|vendor|host-internal|internal-worker)$/u,name);
            assert.notEqual(overlay.lifecycleSideEffects.trim(),'');
            assert.notEqual(overlay.paramsResults.trim(),'');
            assert.notEqual(overlay.capabilitiesCore.trim(),'');
        }
    });

    await t.test('every runtime artifact owns one complete local contract page',()=>{
        for(const record of records){
            const sourceContract=sourceByName.get(record.name);
            const overlay=overlays.get(record.name);
            const page=pagesBySource.get(record.file);
            assert.ok(sourceContract,record.name);
            assert.ok(overlay,record.name);
            assert.ok(page,record.file);
            assert.equal(page.output,`site/reference/runtime-modules/${runtimeModuleSlug(record.name)}/index.html`);
            assert.equal(page.route,`reference/runtime-modules/${runtimeModuleSlug(record.name)}/`);
            assert.equal(page.moduleClassification,overlay.classification);

            const html=firstPlan.expectedFiles.get(page.output).toString('utf8');
            const decoded=decodeReferenceHtml(html);
            for(const id of [
                'overview',
                'import-and-lifecycle',
                'exports-signatures-parameters-results',
                'parameters-and-results',
                'events-side-effects-and-errors',
                'availability-and-capabilities',
                'example',
                'related'
            ])assert.match(html,new RegExp(`\\bid="${id}"`,'u'),`${record.name}: ${id}`);
            const bindingRows=contractTableRows(html,'Exact module bindings');
            assert.equal(bindingRows.length,sourceContract.exports.length,`${record.name}: binding rows`);
            for(const [index,binding] of sourceContract.exports.entries()){
                assert.equal(bindingRows[index][0],binding.name,`${record.name}: binding ${index} name`);
                assert.equal(
                    bindingRows[index][2],
                    publicContractSyntax(bindingSignature(binding)),
                    `${record.name}: binding ${binding.name} signature`
                );
                assert.equal(
                    bindingRows[index][3],
                    publicContractSyntax(binding.parameters),
                    `${record.name}: binding ${binding.name} parameters`
                );
            }
            const callableRows=contractTableRows(html,'Reviewed callable surface');
            assert.equal(callableRows.length,sourceContract.reviewedCallables.length,`${record.name}: callable rows`);
            for(const [index,callable] of sourceContract.reviewedCallables.entries()){
                const publicName=callable.owner
                    ?`${callable.owner}.${callable.name}`
                    :callable.exportName??callable.name;
                assert.equal(callableRows[index][0],publicName,`${record.name}: callable ${index} name`);
                assert.equal(
                    callableRows[index][2],
                    publicContractSyntax(callable.rawSignature),
                    `${record.name}: callable ${publicName} signature`
                );
                assert.equal(
                    callableRows[index][3],
                    publicContractSyntax(callable.parameters),
                    `${record.name}: callable ${publicName} parameters`
                );
            }
            const expectedMemberRows=[
                ...expectedStructuralMemberRows(sourceContract),
                ...sourceContract.publicMembers.map(member=>[
                    `${member.owner}.${member.name}`,
                    publicContractSyntax(member.rawSignature??member.rawDeclaration),
                    publicContractSyntax(member.parameters)
                ])
            ];
            const memberRows=contractTableRows(html,'Exported class and object members');
            assert.equal(memberRows.length,expectedMemberRows.length,`${record.name}: member rows`);
            for(const [index,[name,signature,parameters]] of expectedMemberRows.entries()){
                assert.equal(memberRows[index][0],name,`${record.name}: member ${index} name`);
                assert.equal(memberRows[index][2],signature,`${record.name}: member ${name} signature`);
                assert.equal(memberRows[index][3],parameters,`${record.name}: member ${name} parameters`);
            }
            assert.deepEqual(
                contractListItems(html,'literal-custom-events','lifecycle-event-flow'),
                sourceContract.events.map(event=>event.name),
                `${record.name}: literal CustomEvent list`
            );
            assert.deepEqual(
                contractListItems(html,'direct-coded-failures','exported-error-subclasses'),
                sourceContract.directCodedFailures.map(failure=>failure.code),
                `${record.name}: coded failure list`
            );
            assert.deepEqual(
                contractListItems(html,'exported-error-subclasses','documented-failure-behavior'),
                sourceContract.errorSubclasses.map(error=>
                    `${error.name??error.exportNames.join('/')} extends ${error.base}`
                ),
                `${record.name}: Error subclass list`
            );
            for(const value of [
                record.name,
                record.availability,
                record.normalization,
                overlay.lifecycleSideEffects,
                overlay.paramsResults,
                overlay.capabilitiesCore,
                ...overlay.events,
                ...overlay.errors
            ])assert.ok(decoded.includes(value),`${record.name}: ${value}`);
            for(const binding of sourceContract.exports){
                assert.match(html,new RegExp(`<code>${escapePattern(binding.name)}</code>`,'u'),`${record.name}: ${binding.name}`);
            }
            for(const callable of sourceContract.reviewedCallables){
                const publicName=callable.owner
                    ?`${callable.owner}.${callable.name}`
                    :callable.exportName??callable.name;
                assert.ok(decoded.includes(publicName),`${record.name}: ${publicName}`);
            }
            for(const member of sourceContract.publicMembers){
                assert.ok(decoded.includes(`${member.owner}.${member.name}`),`${record.name}: ${member.owner}.${member.name}`);
            }
            for(const event of sourceContract.events){
                assert.ok(decoded.includes(event.name),`${record.name}: ${event.name}`);
            }
            for(const failure of sourceContract.directCodedFailures){
                assert.ok(decoded.includes(failure.code),`${record.name}: ${failure.code}`);
            }
            for(const errorClass of sourceContract.errorSubclasses){
                assert.ok(decoded.includes(`${errorClass.name} extends ${errorClass.base}`),`${record.name}: ${errorClass.name}`);
            }
            const contractStart=html.indexOf('<h2 id="exports-signatures-parameters-results">');
            const contractEnd=html.indexOf('<h3 id="parameters-and-results">',contractStart);
            assert.ok(contractStart>=0&&contractEnd>contractStart,record.name);
            assert.doesNotMatch(
                decodeReferenceHtml(html.slice(contractStart,contractEnd)),
                /#[A-Za-z_$][A-Za-z0-9_$]*/u,
                record.name
            );
            assert.doesNotMatch(
                decoded,
                /Validation evidence|current catalog does not|exact source path|Missing export|Object[.]keys|Runtime module loaded|structured member signatures and event\/error claims/iu,
                record.name
            );
        }
        const moduleHtml=name=>decodeReferenceHtml(
            firstPlan.expectedFiles.get(
                `site/reference/runtime-modules/${runtimeModuleSlug(name)}/index.html`
            ).toString('utf8')
        );
        const aiHtml=moduleHtml('AI.js');
        assert.match(aiHtml,/transitionAI\(\)[\s\S]*stops queued audio[\s\S]*unloads all three current roles[\s\S]*aggregate runtime status/u);
        assert.doesNotMatch(aiHtml,/logs exact outbound and inbound inference payloads/u);
        const providerRuntimeHtml=moduleHtml('AIProviderRuntime.js');
        assert.match(providerRuntimeHtml,/start\(\{startMuted=true,signal=null\}=\{\}\)[\s\S]*\{barrier,settled,cancel\}/u);
        const configuredHtml=moduleHtml('ConfiguredAIChatSession.js');
        assert.match(configuredHtml,/initialMessages[\s\S]*one unresolved ordered structural function-call tail[\s\S]*exactly one nonblank role=tool message for every pending ID/u);
        assert.match(configuredHtml,/Raw structural tool protocol remains only through its one active continuation[\s\S]*ordinary visible content/iu);
        const documentLibraryHtml=moduleHtml('DBOPFSDocumentLibrary.js');
        assert.match(documentLibraryHtml,/preserve-readable[\s\S]*partial failures and coverage/u);
        assert.match(documentLibraryHtml,/DBOPFS_DOCUMENT_INVALID[\s\S]*DBOPFS_DOCUMENT_INVALID_LIMIT[\s\S]*DBOPFS_DOCUMENT_ERROR/u);
    });

    await t.test('reader navigation contains no source detours or private signatures',()=>{
        const outputs=['site/reference/index.html',...firstPlan.manifest.pages.map(page=>page.output)];
        for(const output of outputs){
            const html=firstPlan.expectedFiles.get(output).toString('utf8');
            assert.doesNotMatch(html,/href="[^"]*[.]md(?:[?#][^"]*)?"/iu,output);
            assert.doesNotMatch(
                html,
                /github[.]com\/TheWizardNexus\/(?:ARCANE-OS\/|arcane-os-sdk\/(?!(?:releases\/tag\/[0-9]+[.][0-9]+[.][0-9]+|actions\/runs\/[0-9]+)(?:["?#])))/iu,
                output
            );
            assert.doesNotMatch(html,/reference-source-link|Canonical source|exact source path/iu,output);
            assert.doesNotMatch(
                html,
                /Developer Reference Maintenance SOP|repository-only|npm run model:ensure|during this import|pinned upstream|id="version-scope-and-provenance"/iu,
                output
            );
            for(const code of html.matchAll(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gu)){
                assert.doesNotMatch(
                    decodeReferenceHtml(code[1]),
                    /(?:https?:\/\/)?(?:127[.]0[.]0[.]1|localhost):11434/iu,
                    output
                );
            }
        }
    });

    await t.test('normalized AI is the primary path and AI.js stays default-only',()=>{
        const landing=firstPlan.expectedFiles.get('site/reference/index.html').toString('utf8');
        const guide=decodeReferenceHtml(firstPlan.expectedFiles.get('site/reference/ai/index.html').toString('utf8'));
        const aiModule=decodeReferenceHtml(firstPlan.expectedFiles.get('site/reference/runtime-modules/ai/index.html').toString('utf8'));
        const ollamaModule=decodeReferenceHtml(firstPlan.expectedFiles.get('site/reference/runtime-modules/ollama/index.html').toString('utf8'));
        assert.ok(landing.indexOf('href="ai/"')>=0);
        assert.ok(landing.indexOf('href="ai/"')<landing.indexOf('href="arcane-ollama/"'));
        assert.match(guide,/<strong>Application default[.]<\/strong> Start with normalized AI/iu);
        assert.match(guide,/globalThis[.]Arcane[.]ai/iu);
        assert.match(guide,/<code>AI[.]js<\/code> has one export: its default <code>AI<\/code> class/iu);
        assert.deepEqual(sourceByName.get('AI.js').exports.map(record=>record.name),['default']);
        assert.match(aiModule,/import AI from '\/arcane\/modules\/AI[.]js'/u);
        assert.doesNotMatch(aiModule,/import\s*\{[^}]*\bAI\b[^}]*\}\s*from/u);
        assert.match(aiModule,/ai-ready/u);
        assert.match(ollamaModule,/Advanced provider-specific surface/iu);
        assert.match(ollamaModule,/never authorizes a renderer to contact Ollama port 11434 directly/iu);
    });

    await t.test('the module index search is exact, bounded, and complete',()=>{
        assert.deepEqual(normalizeModuleSearch('  AI.js / Speech  '),['ai','js','speech']);
        assert.deepEqual(filterModuleSearchRecords(records),records);
        for(const [kind,count] of [
            ['esm',80],
            ['classic-script',3],
            ['worker',1],
            ['stylesheet',1],
            ['license',1]
        ])assert.equal(filterModuleSearchRecords(records,'',{kind}).length,count,kind);
        const ai=records.find(record=>record.name==='AI.js');
        assert.equal(moduleMatchesSearch(ai,'provider speech device'),true);
        assert.equal(moduleMatchesSearch(ai,'provider speech device',{kind:'worker'}),false);
        assert.deepEqual(
            filterModuleSearchRecords(records,'directory select').map(record=>record.name),
            ['DirectoryPicker.js']
        );
        assert.deepEqual(filterModuleSearchRecords(records,'[no regex execution]'),[]);
        const script=firstPlan.expectedFiles.get('site/reference/reference.js').toString('utf8');
        assert.match(script,/data-module-search-input/u);
        assert.match(script,/data-module-kind/u);
        assert.doesNotMatch(script,/innerHTML|\beval\s*\(|(?:fetch|XMLHttpRequest)\s*\(/u);
    });

    await t.test('Core publishes all 113 methods including owning-app extensions',()=>{
        const coreOutputs=firstPlan.manifest.pages
            .filter(page=>page.output.startsWith('site/reference/core/'))
            .map(page=>firstPlan.expectedFiles.get(page.output).toString('utf8'));
        const core=decodeReferenceHtml(coreOutputs.join('\n'));
        assert.match(core,/150 records: 113 callable methods, 35 namespaces, one <code>Arcane[.]Error<\/code> constructor, and one protocol value/iu);
        for(const member of [
            'Arcane.localAI.inspectIsolatedModel',
            'Arcane.localAI.runIsolatedQuestion',
            'Arcane.repository.kempo.snapshot',
            'Arcane.repository.kempo.begin',
            'Arcane.repository.kempo.score',
            'Arcane.repository.kempo.publish',
            'Arcane.repository.spellwire.snapshot'
        ])assert.ok(core.includes(member),member);
        const isolated=htmlCellText(firstPlan.expectedFiles.get(
            'site/reference/core/reference/arcane-api/ai-and-ollama/index.html'
        ).toString('utf8'));
        assert.match(isolated,/Kempo-only, ai[.]inference, admitted desktop Core/u);
        assert.match(isolated,/\{model, expectedModel, contextTokens\}/u);
        assert.match(isolated,/\{schemaVersion:1, model, defaults:\{systemPromptPresent:false,messageCount:0\}, admission\}/u);
        assert.match(isolated,/Client timeout is 45 seconds/u);
        assert.match(isolated,/request is exact \{model,prompt,systemPrompt,options,expectedModel,think[?]\}/u);
        assert.match(isolated,/\{schemaVersion:1,model,answer,startedAt,completedAt,elapsedMs,isolation\}/u);
        for(const phase of ['unload_before','verify_before','chat','unload_after','verify_after']){
            assert.ok(isolated.includes(phase),phase);
        }
        assert.match(isolated,/method is exclusive, Core-only/u);
        assert.match(isolated,/No Android projection/u);
        assert.match(isolated,/uses a 50-minute client timeout/u);
        const repositories=htmlCellText(firstPlan.expectedFiles.get(
            'site/reference/core/reference/arcane-api/applications-terminal-capabilities/index.html'
        ).toString('utf8'));
        assert.match(repositories,/Arcane[.]repository[.]kempo[.]snapshot[(]runId[?][)]/u);
        assert.match(repositories,/Arcane[.]repository[.]kempo[.]begin[(]\{runId,briefVersion\}[)]/u);
        assert.match(repositories,/Arcane[.]repository[.]kempo[.]score[(]\{runId,questionId,score,letterScores\}[)]/u);
        assert.match(repositories,/Arcane[.]repository[.]kempo[.]publish[(]\{document\}[)]/u);
        assert.match(repositories,/\{repositoryId,branch,remoteHead,identity,catalog,runs,validation\}/u);
        assert.match(repositories,/\{repositoryId,branch,remoteHead,commit,identity,pushed,verified:true,run\}/u);
        assert.match(repositories,/Requires repository[.]kempo[.]write, the matching bound application ID, admitted Core, and a 50-minute client timeout[.] Kempo mutations are exclusive[.]/u);
        assert.match(repositories,/Arcane[.]repository[.]spellwire[.]snapshot[(][)]/u);
        assert.match(repositories,/\{repositoryId:'spellwire',branch:'main',remoteHead,fetchedAt,files\}/u);
        assert.equal((repositories.match(/50-minute client timeout/gu)??[]).length,5);
        assert.match(repositories,/no Android projection/u);
        const namespaces=htmlCellText(firstPlan.expectedFiles.get(
            'site/reference/core/reference/arcane-api/namespaces/index.html'
        ).toString('utf8'));
        assert.match(namespaces,/exact app ID kempo-bound; snapshot requires repository[.]kempo[.]read, while the three exclusive mutations require repository[.]kempo[.]write/u);
        assert.match(namespaces,/exact app ID spellwire-bound, and requires repository[.]spellwire[.]read/u);
    });

    await t.test('all 37 capability policies and four capability-free methods are explicit',()=>{
        const capabilities=firstPlan.expectedFiles.get('site/reference/core/capabilities/index.html').toString('utf8');
        const records=[...capabilities.matchAll(
            /<h2 id="capability-[^"]+"><code>([^<]+)<\/code><\/h2><p><strong>Exact RPC method names:<\/strong> ([\s\S]*?)<\/p>/gu
        )];
        assert.deepEqual(records.map(match=>match[1]),expectedCapabilityStrings);
        const gatedMethods=records.flatMap(match=>
            [...match[2].matchAll(/<code>([^<]+)<\/code>/gu)].map(method=>method[1])
        );
        assert.equal(gatedMethods.length,102);
        assert.equal(new Set(gatedMethods).size,102);
        const freeSection=capabilities.match(
            /<h2 id="capability-free-rpc-methods">([\s\S]*?)<\/table>/u
        )?.[1]??'';
        assert.deepEqual(
            [...freeSection.matchAll(/<td><code>([^<]+)<\/code><\/td>/gu)].map(match=>match[1]),
            ['app.current','capabilities.list','system.ping','version.current']
        );
        const aiStart=capabilities.indexOf('<h2 id="capability-aiinference">');
        const aiEnd=capabilities.indexOf('<h2 id="capability-aimodelsmanage">',aiStart);
        const aiPolicy=decodeReferenceHtml(capabilities.slice(aiStart,aiEnd));
        assert.match(
            aiPolicy,
            /Android projects localai[.]status, ollama[.]chat, speech[.]status, speech[.]synthesize, and speech[.]transcribe only to exact application IDs boss and precrisis[.]/u
        );
        assert.match(aiPolicy,/correlated ollama[.]chunk event/u);
    });

    await t.test('every rendered JavaScript block and classic inline example parses',()=>{
        const examples=[];
        for(const page of firstPlan.manifest.pages){
            const html=firstPlan.expectedFiles.get(page.output).toString('utf8');
            let blockIndex=0;
            for(const block of html.matchAll(
                /<pre><code class="language-(?:javascript|js|mjs)">([\s\S]*?)<\/code><\/pre>/gu
            )){
                blockIndex+=1;
                examples.push([
                    `${page.output} JavaScript block ${blockIndex}`,
                    decodeReferenceHtml(block[1])
                ]);
            }
        }
        const renderedJavaScriptBlockCount=examples.length;
        assert.equal(renderedJavaScriptBlockCount,562);
        let javaScriptModuleExamples=0;
        let classicInlineExamples=0;
        for(const record of records){
            const page=pagesBySource.get(record.file);
            const html=firstPlan.expectedFiles.get(page.output).toString('utf8');
            const example=moduleExample(html);
            if(['esm','worker'].includes(record.kind)){
                assert.equal(example?.language,'javascript',record.name);
                javaScriptModuleExamples+=1;
            }else if(record.kind==='classic-script'){
                assert.equal(example?.language,'html',record.name);
                assert.ok(
                    example.source.includes(`<script src="/arcane/modules/${record.name}"></script>`),
                    record.name
                );
                const inline=[...example.source.matchAll(
                    /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu
                )].map(match=>match[1].trim()).filter(Boolean);
                assert.equal(inline.length,1,record.name);
                examples.push([`${record.name} inline script`,inline[0]]);
                classicInlineExamples+=1;
            }else if(record.kind==='stylesheet'){
                assert.equal(example?.language,'html',record.name);
            }else{
                assert.equal(example,null,record.name);
            }
        }
        assert.equal(javaScriptModuleExamples,75);
        assert.equal(classicInlineExamples,3);
        assert.equal(examples.length,565);
        assertModuleExamplesParse(examples);
    });
});

test('documentation describes the consumer source-to-portable-browser-package contract truthfully',async()=>{
    const [home,quickStart,external,hello,alias,native,reference,siteScript]=await Promise.all([
        readSiteFile('index.html'),
        readSiteFile('quick-start/index.html'),
        readSiteFile('guides/external-app/index.html'),
        readSiteFile('examples/index.html'),
        readSiteFile('examples/hello-world/index.html'),
        readSiteFile('guides/native-builds/index.html'),
        readSiteFile('reference/index.html'),
        readSiteFile('app.js')
    ]);
    const pagesOwnedHtml=await Promise.all(
        [...pagesNavigationHrefs.keys()].map(fileName=>readSiteFile(fileName))
    );
    const publishedSurface=[...pagesOwnedHtml,siteScript].join('\n');
    const combined=[publishedSurface,native,reference].join('\n');
    const decodedHello=decodeReferenceHtml(hello);

    assert.match(home,/0[.]1[.]1/u);
    assert.match(home,/published|npm/iu);
    assert.match(quickStart,/npx arcane-os@0[.]1[.]1 new/u);
    assert.match(quickStart,/Node[.]js 22[.]23[.]2/u);
    assert.match(external,/arcane-os@0[.]1[.]1/u);
    assert.match(external,/packaged HTML, CSS, and JavaScript/u);
    assert.match(hello,/npx arcane-os@0[.]3[.]1 new hello-world/u);
    assert.match(hello,/npm install/u);
    assert.match(hello,/npm install --global arcane-os@0[.]3[.]1/u);
    assert.match(hello,/--target browser/u);
    assert.match(hello,/What Arcane adds/u);
    assert.match(hello,/arcane\/[\s\S]*dependencies\/[\s\S]*sdk\//u);
    assert.match(hello,/dist\/hello-world\/[\s\S]*arcane\//u);
    assert.match(hello,/hello-world[.]css/u);
    assert.match(hello,/AppDataScope[.]js/u);
    assert.match(hello,/ThemeBootstrap[.]js/u);
    assert.match(hello,/npm run dev/u);
    assert.match(hello,/npm run package/u);
    assert.match(hello,/npm run verify/u);
    assert.match(hello,/npm run bundle/u);
    assert.match(hello,/npm run build/u);
    assert.match(hello,/npm run run/u);
    assert.match(hello,/portable browser package/u);
    assert.match(hello,/do not create or launch a standalone (?:native )?executable/u);
    assert.match(hello,/Standalone native execution is provider-supplied/u);
    assert.match(decodedHello,/No external AI model or adapter artifact downloads at import time/iu);
    assert.match(decodedHello,/Full SDK AI lifecycle/u);
    assert.match(decodedHello,/HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED/u);
    assert.match(decodedHello,/WebGPU-capable browser/u);
    assert.match(decodedHello,/2,000 characters/u);
    assert.match(decodedHello,/500 characters/u);
    assert.match(decodedHello,/8 MiB/u);
    assert.match(decodedHello,/back\/forward cache/u);
    assert.match(decodedHello,/1,998,371,424 bytes \(1[.]86 GiB\)/u);
    assert.match(decodedHello,/loadPolicy:'manual'/u);
    assert.match(decodedHello,/localOnly:true/u);
    assert.match(decodedHello,/Proposed tool calls/u);
    assert.match(decodedHello,/model-source request/u);
    assert.match(decodedHello,/same-origin Wllama\/WASM assets may still load/u);
    assert.match(decodedHello,/Any admitted DBOPFS cache remains; interrupted downloads are discarded/u);
    assert.match(decodedHello,/ARCANE_AI_[\s\S]*APP_DATA_/u);
    assert.doesNotMatch(
        decodedHello,
        /globalThis[.]Arcane|ArcaneApp-hello-world[.]exe|Build (?:the Windows )?executable|native folder|--target windows-x64|--arcane-root|node_modules\/arcane-os\/runtime\/arcane|source to executable|Windows x64 development build|Tool-call receipt|partial bytes were removed/iu
    );
    assert.doesNotMatch(
        publishedSurface,
        /not yet published|before (?:the SDK is )?published|after publication|pack:local|npm pack --ignore-scripts|[.]tgz|arcane-os@dev|0[.]1[.]0-dev(?:[.][0-9]+)?|Development SDK|current development checkout|SDK update (?:poll|polling)|repository-internal/iu
    );
    assert.doesNotMatch(
        publishedSurface,
        /href="(?:[.][.]\/)*(?:examples\/)?hello-world\/(?:[#?][^"]*)?"/u
    );
    assert.match(alias,/<a\b[^>]*href="[.][.]\/"[^>]*>/u);
    assert.match(
        hello,
        /Model downloaded, stored in app-scoped DBOPFS, and loaded locally/u
    );
    assert.match(native,/portable[\s\S]*Not directly runnable[\s\S]*Unsigned local test/u);
    assert.match(native,/Architecture-neutral APK/u);
    assert.match(reference,/<code>native-prepare<\/code>/u);
    assert.doesNotMatch(combined,/\\\r?$/mu);
});

test('site interaction is bounded, copyable, and accessibility-aware',async t=>{
    const [home,playground,styles,script]=await Promise.all([
        readSiteFile('index.html'),
        readSiteFile('playground/index.html'),
        readSiteFile('styles.css'),
        readSiteFile('app.js')
    ]);
    await t.test('homepage motion remains bounded and controllable',()=>{
        assert.match(home,/<canvas id="space-canvas" aria-hidden="true"><\/canvas>/u);
        assert.match(home,/data-motion-toggle aria-pressed="false"/u);
        assert.match(script,/Math[.]max\(45, Math[.]min\(120,/u);
        assert.match(script,/Math[.]min\(window[.]devicePixelRatio \|\| 1, 1[.]5\)/u);
        assert.match(script,/time - lastDraw >= 33/u);
        assert.match(script,/prefers-reduced-motion: reduce/u);
        assert.match(script,/IntersectionObserver/u);
        assert.match(script,/window[.]cancelAnimationFrame/u);
        assert.match(script,/const wideNavigation = window[.]matchMedia\("\(min-width: 761px\)"\)/u);
        assert.match(script,/const wideHero = window[.]matchMedia\("\(min-width: 981px\)"\)/u);
        assert.match(script,/if \(!wideHero[.]matches \|\| !finePointer[.]matches/u);
        assert.match(
            script,
            /const resetPointerOffset = \(\) => \{[\s\S]*--mouse-x", "0px"[\s\S]*--mouse-y", "0px"[\s\S]*--mouse-x-reverse", "0px"[\s\S]*--mouse-y-reverse", "0px"/u
        );
        assert.match(
            script,
            /wideHero[.]addEventListener\("change", \(event\) => \{\s*if \(!event[.]matches\) resetPointerOffset\(\)/u
        );
    });
    await t.test('all code blocks use the generic clipboard path',()=>{
        assert.match(script,/function setupCopyButtons\(\)/u);
        assert.match(script,/querySelectorAll\("\[data-copy-button\]"\)/u);
        assert.match(script,/navigator[.]clipboard/u);
        assert.match(script,/Copy failed[.] Select the text manually[.]/u);
    });
    await t.test('playground emits reviewed commands without executing them',()=>{
        assert.match(playground,/This playground changes text only/u);
        assert.match(playground,/Descriptor target fragment/u);
        assert.match(playground,/not a complete schema-2 descriptor/u);
        assert.match(script,/function setupPlayground\(\)/u);
        assert.match(script,/\^\[a-z\]\[a-z0-9\]\*\(\?:-\[a-z0-9\]\+\)\*\$/u);
        assert.match(script,/node [.][/\\]bin[/\\]arcane[.]mjs/u);
        assert.match(script,/Portable output is verified but cannot run/u);
        assert.match(script,/Portable output is a verified app-scoped directory/u);
        assert.match(script,/\["browser", targetName\][.]sort\(\)/u);
    });
    await t.test('scripts avoid injection and network requests',()=>{
        assert.doesNotMatch(script,/innerHTML/u);
        assert.doesNotMatch(script,/(?:fetch|XMLHttpRequest)\s*\(/u);
    });
    await t.test('styles cover docs, mobile, reduced motion, and forced colors',()=>{
        for(const selector of ['.doc-hero','.docs-layout','.code-block','.playground-shell','.route-grid']){
            assert.match(styles,new RegExp(escapePattern(selector),'u'));
        }
        assert.match(styles,/@media \(max-width: 520px\)/u);
        assert.match(styles,/@media \(prefers-reduced-motion: reduce\)/u);
        assert.match(styles,/@media \(forced-colors: active\)/u);
        assert.match(styles,/:focus-visible/u);
        assert.match(
            styles,
            /[.]hero-visual\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%;[^}]*margin:\s*0;[^}]*justify-self:\s*center;/u
        );
        assert.match(
            styles,
            /[.]hero-system\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*560px;/u
        );
        assert.match(
            styles,
            /[.]hero h1\s*\{[^}]*font-size:\s*clamp\(3rem,\s*5vw,\s*5rem\);/u
        );
        assert.match(
            styles,
            /[.]prose :not\(pre\) > code\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/u
        );
        const tabletStart=styles.indexOf('@media (max-width: 980px)');
        const mobileStart=styles.indexOf('@media (max-width: 760px)',tabletStart);
        const narrowStart=styles.indexOf('@media (max-width: 520px)',mobileStart);
        const documentationStart=styles.indexOf('@media (max-width: 1120px)',narrowStart);
        assert.ok(
            tabletStart>=0&&mobileStart>tabletStart&&narrowStart>mobileStart
            &&documentationStart>narrowStart
        );
        assert.match(
            styles.slice(tabletStart,mobileStart),
            /[.]hero\s*\{[^}]*grid-template-columns:\s*1fr;[\s\S]*[.]hero-visual\s*\{[^}]*width:\s*min\(560px, 100%\);/u
        );
        const mobileCss=styles.slice(mobileStart,narrowStart);
        const narrowCss=styles.slice(narrowStart,documentationStart);
        assert.match(mobileCss,/[.]nav-toggle\s*\{[^}]*display:\s*block;/u);
        assert.match(mobileCss,/[.]primary-navigation\s*\{[^}]*display:\s*none;/u);
        assert.match(mobileCss,/[.]primary-navigation[.]is-open\s*\{[^}]*display:\s*flex;/u);
        assert.match(mobileCss,/[.]hero-system\s*\{[^}]*width:\s*100%;/u);
        assert.match(narrowCss,/[.]hero-actions [.]button\s*\{[^}]*width:\s*100%;/u);
        assert.match(narrowCss,/[.]hero-visual\s*\{[^}]*overflow-x:\s*clip;/u);
        assert.match(narrowCss,/[.]hero-system\s*\{[^}]*width:\s*100%;[^}]*transform:\s*none;/u);
        assert.doesNotMatch(styles,/[.]hero-system\s*\{[^}]*(?:98vw|calc\(100vw - 8px\))/u);
    });
});

test('maintained Hello World example is a flat current-source greeting',async t=>{
    const requiredFiles=['AGENTS.md','App.js','README.md','index.html'];
    const entries=(await readdir(exampleRoot,{withFileTypes:true}))
        .map(entry=>entry.name)
        .sort();
    assert.deepEqual(entries,[...requiredFiles].sort());

    const [html,script,readme,tutorial]=await Promise.all([
        readFile(path.join(exampleRoot,'index.html'),'utf8'),
        readFile(path.join(exampleRoot,'App.js'),'utf8'),
        readFile(path.join(exampleRoot,'README.md'),'utf8'),
        readSiteFile('examples/index.html')
    ]);

    await t.test('loads current SDK source without app or package scaffolding',()=>{
        assert.match(html,/<meta name="arcane-app-id" content="hello-world">/u);
        assert.match(html,/href="\/runtime\/arcane\/css\/theme[.]css"/u);
        assert.match(html,/href="\/runtime\/arcane\/css\/primitives[.]css"/u);
        assert.match(html,/src="[.]\/App[.]js"/u);
        assert.match(html,/"arcane-os\/event-manager": "\/src\/event-manager[.]mjs"/u);
        assert.match(html,/"arcane\/ThemeBootstrap": "\/runtime\/arcane\/modules\/ThemeBootstrap[.]js"/u);
        assert.match(html,/"event-pubsub": "\/node_modules\/event-pubsub\/index[.]js"/u);
        assert.doesNotMatch(html,/chat[.]html|browser-wasm|browser-speech/iu);
        assert.doesNotMatch(html,/apps\/hello-world|arcane-packager|arcane[.]lock[.]json/u);
    });

    await t.test('keeps the example-owned behavior to one greeting and host label',()=>{
        assert.match(script,/import arcaneThemeReady from 'arcane\/ThemeBootstrap'/u);
        assert.match(script,/await arcaneThemeReady/u);
        assert.match(script,/Hello, Arcane World!/u);
        assert.match(script,/runtime[?][.]native/u);
        assert.match(script,/Running inside Arcane OS[.]/u);
        assert.match(script,/Running in a web browser[.]/u);
        assert.doesNotMatch(script,/chat|createBrowserWasmLlmProvider|configureBrowserSpeech/iu);
        assert.doesNotMatch(script,/addEventListener\(['"](?:click|submit)|innerHTML\s*=|insertAdjacentHTML/iu);
    });

    await t.test('documents the same flat source boundary',()=>{
        assert.match(readme,/smallest Arcane source example/u);
        assert.match(readme,/http:\/\/127[.]0[.]0[.]1:8444\/examples\/hello-world\//u);
        assert.match(readme,/prints a greeting/u);
        assert.match(tutorial,/Four maintained files/u);
        assert.match(tutorial,/There is no nested app workspace/u);
        assert.match(tutorial,/http:\/\/127[.]0[.]0[.]1:8444\/examples\/hello-world\//u);
        assert.match(tutorial,/themed greeting/u);
        assert.doesNotMatch(tutorial,/apps\/hello-world|arcane[.]lock[.]json|byte-identical/u);
    });
});

test('authored reference follows the selected package functional boundary',async()=>{
    const [overview,protocols,sdkApi,runtimeComponents,packageApi]=await Promise.all([
        readFile(path.join(repositoryRoot,'docs','reference','README.md'),'utf8'),
        readFile(path.join(repositoryRoot,'docs','reference','protocols.md'),'utf8'),
        readFile(path.join(repositoryRoot,'docs','reference','sdk-api.md'),'utf8'),
        readFile(path.join(repositoryRoot,'docs','reference','runtime-components.md'),'utf8'),
        readJson(path.join(repositoryRoot,'docs','reference','inventory','package-api.json'))
    ]);
    const packageDocument=await readJson(path.join(repositoryRoot,'package.json'));
    assert.ok(overview.includes(`arcane-os@${packageDocument.version}`));
    assert.match(overview,/arcane-os\/preference-store/u);
    assert.match(overview,/arcane-os\/speech-playback/u);
    assert.doesNotMatch(
        `${overview}\n${sdkApi}`,
        /ARCANE_RUNTIME_RELEASE|ARCANE_SDK_BROWSER_RELEASE|npm integrity|npm shasum|Trusted publication|SLSA provenance/u
    );
    assert.match(protocols,/optional trailing `security`/u);
    assert.match(protocols,/including `arcane\/sdk` and `arcane\/dependencies`/u);
    assert.match(runtimeComponents,/one capture generation and one operation id/u);
    assert.match(runtimeComponents,/stale request[\s\S]*newer press, status, operation id, or retry/u);
    assert.equal(packageApi.sdkVersion,packageDocument.version);
    const entrypoints=new Set(packageApi.members.map(member=>member.primaryImport));
    assert.equal(entrypoints.has('arcane-os/preference-store'),true);
    assert.equal(entrypoints.has('arcane-os/speech-playback'),true);
});

test('Pages workflow deploys one authenticated main static artifact',async t=>{
    const [workflow,packageDocument,readme,robots,sitemap]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','pages.yml'),'utf8'),
        readJson(path.join(repositoryRoot,'package.json')),
        readFile(path.join(repositoryRoot,'README.md'),'utf8'),
        readSiteFile('robots.txt'),
        readSiteFile('sitemap.xml')
    ]);
    await t.test('runs only for the explicitly selected canonical main source',()=>{
        assert.match(workflow,/permissions:\s*\{\}/u);
        assert.match(workflow,/contents:\s*read/u);
        assert.match(workflow,/pages:\s*write/u);
        assert.match(workflow,/id-token:\s*write/u);
        assert.match(workflow,/github[.]repository == 'TheWizardNexus\/arcane-os-sdk'/u);
        assert.match(workflow,/workflow_dispatch:/u);
        assert.match(workflow,/github[.]ref == 'refs\/heads\/main'/u);
        assert.doesNotMatch(workflow,/workflow_run:|\n\s+push:|npm (?:test|run)|build-reference-site/u);
    });
    await t.test('checks out and deploys the selected static artifact',()=>{
        assert.match(workflow,/actions\/checkout@v7/u);
        assert.match(workflow,/persist-credentials: false/u);
        assert.doesNotMatch(workflow,/actions\/workflows\/check[.]yml\/runs|checked_sha/u);
        assert.match(workflow,/actions\/configure-pages@v6/u);
        assert.match(workflow,/test -f site\/reference\/reference-manifest[.]json/u);
        assert.match(workflow,/test -f site\/reference\/sdk-api\/index[.]html/u);
        assert.match(workflow,/test -f site\/reference\/event-manager\/index[.]html/u);
        assert.match(workflow,/test -f site\/reference\/core\/arcane-api\/index[.]html/u);
        assert.match(workflow,/test -f site\/reference\/inventory\/package-api[.]json/u);
        assert.match(workflow,/actions\/upload-pages-artifact@v5/u);
        assert.match(workflow,/path: [.][/]site/u);
        assert.match(workflow,/actions\/deploy-pages@v5/u);
    });
    await t.test('publishes every canonical route outside the npm package',async()=>{
        assert.equal(packageDocument.homepage,canonicalRoot);
        assert.equal(packageDocument.files.some(entry=>entry.startsWith('site')),false);
        assert.match(robots,/Sitemap: https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/sitemap[.]xml/u);
        const locations=[...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(match=>match[1]).sort();
        assert.equal(locations.length,128);
        assert.equal(new Set(locations).size,128);
        assert.equal(locations.filter(url=>url===`${canonicalRoot}examples/`).length,1);
        assert.equal(locations.includes(`${canonicalRoot}examples/hello-world/`),false);
        assert.equal(
            locations.filter(url=>url===`${canonicalRoot}reference/ai/browser-wasm/`).length,
            1
        );
        assert.equal(
            locations.filter(url=>url===`${canonicalRoot}reference/ai/browser-speech/`).length,
            1
        );
        const pageRoutes=await loadPageRoutes();
        assert.equal(pageRoutes.size,128);
        const expected=[...pageRoutes.values()].map(route=>`${canonicalRoot}${route}`).sort();
        assert.deepEqual(locations,expected);
    });
    await t.test('README points to the canonical site and repository',()=>{
        assert.match(readme,/https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\//u);
        assert.doesNotMatch(readme,/https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/dev\//u);
        assert.match(readme,/main\/site\/assets\/arcane-os-sdk-readme-header[.]png/u);
        assert.match(readme,/https:\/\/github[.]com\/TheWizardNexus\/arcane-os-sdk/u);
    });
});
