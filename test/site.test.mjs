import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {projectPackageManifest,validateAppDescriptor} from '../src/app-descriptor.mjs';
import {buildImportMap} from '../src/import-map.mjs';
import test from '../src/testing.mjs';
import {
    createReferenceSite,
    publicContractSyntax,
    runtimeModuleSlug,
    verifyReferenceSite
} from '../tools/build-reference-site.mjs';
import {extractRuntimeReferenceContracts} from '../tools/reference-contract-extractor.mjs';
import {
    behaviorExampleEvidence,
    createReferenceModuleContractMap
} from '../tools/reference-module-contracts.mjs';
import {
    filterModuleSearchRecords,
    moduleMatchesSearch,
    normalizeModuleSearch
} from '../site/reference/reference.js';
import {repositoryRoot} from './helpers.mjs';
import '../examples/hello-world/apps/hello-world/test/app.test.mjs';

const siteRoot=path.join(repositoryRoot,'site');
const exampleRoot=path.join(repositoryRoot,'examples','hello-world');
const canonicalRoot='https://thewizardnexus.github.io/arcane-os-sdk/';
const runtimeContractSummary=Object.freeze({
    artifactCount:80,
    esmModuleCount:74,
    esmExportCount:282,
    exportForms:Object.freeze({
        function:148,
        variable:54,
        class:10,
        alias:25,
        're-export':4,
        default:41
    }),
    reviewedCallableCount:124,
    reviewedModuleCount:51,
    literalCustomEventCount:11,
    directCodedFailureCount:34,
    exportedErrorSubclassCount:3,
    publicMemberCount:407
});
const behaviorEvidenceCommit='567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e';
const expectedBehaviorEvidence=Object.freeze({
    'AI.js':['6090c5a563c66f972267fec30184c85fbf3ec7de','test/ai.test.mjs','7593bb20967881622d5634829f2e6f05511659cc'],
    'AnsiText.js':['097512451032ffbbceecdc3b02e3af6453e89e90','test/terminal.test.mjs','26fec62b4819635a279922c2e297130748400c4c'],
    'AppDataScope.js':['9943961bd8c4cf93655eece17f14b29ea817357a','test/dbls-app-isolation.test.mjs','583d396c16c5209c8fdaaea3744931816b814e99'],
    'CalculatorEngine.js':['4434d5ad287f94136c054e4cc1b2423387331c06','test/utility-apps.test.mjs','2ddee94c58e751b0e6bec58955431d7994628757'],
    'ConfiguredAIChatSession.js':['21d48eb2af74494b9ee14fca889e571d184d535a','test/configured-ai-chat-session.test.mjs','28f29b2ca5e62aa76952d61adf570155f31a906c'],
    'DirectoryPicker.js':['506e54471d775404de55b3166b79a466af64d646','test/directory-picker.test.mjs','27230080a0d589212de442a17849233cdb80eb0c'],
    'IsolatedModelQuestionRunner.js':['94c6df9e7661b507a495223facb31cd0d3ac7ede','test/isolated-model-question-runner.test.mjs','e94dd4b80b492ce5ff12ae83818915c5c44c298d'],
    'Ollama.js':['fcfd7942e9c706088b23be44180427774763d92a','test/ollama.test.mjs','35187394154e95c883432c203bc79aa8c2a13367'],
    'SpeechPlayback.js':['20d4935deeb97d1be4221f5859897fafd6bb6449','test/speech-playback.test.mjs','6f7307973f35b50ffbc6d5109ab3f558a202a45f'],
    'TerminalClient.js':['35d9c6502979331538d69c63f96b73b792ce014c','test/terminal.test.mjs','26fec62b4819635a279922c2e297130748400c4c'],
    'ThemeBootstrap.js':['9a0fb2d9729141175b835f7c95a208a650c66d2e','test/theme-manager-system-appearance.test.mjs','53a5cc666c6c6db4f5e11b77e5975723946e10c7']
});
const expectedCapabilityStrings=Object.freeze([
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
]);
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

function pngDimensions(buffer){
    assert.equal(buffer.subarray(1,4).toString('ascii'),'PNG');
    return {width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20)};
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

function referencePlanHash(plan){
    const hash=createHash('sha256');
    const outputs=[...plan.expectedFiles].sort(([left],[right])=>left.localeCompare(right,'en'));
    for(const [output,bytes] of outputs){
        hash.update(output);
        hash.update('\0');
        hash.update(bytes);
        hash.update('\0');
    }
    return hash.digest('hex');
}

function gitBlobOid(bytes){
    return createHash('sha1')
        .update(`blob ${String(bytes.byteLength)}\0`)
        .update(bytes)
        .digest('hex');
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
    assert.equal(canonicalPageRoutes.size,121);
    assert.equal(compatibilityPageRoutes.size,1);
    assert.equal(pageRoutes.size,122);
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
    await verifyReferenceSite();
    const manifest=await loadReferenceManifest();
    assert.equal(manifest.schema,'arcane-reference-site/1');
    assert.deepEqual(manifest.versions,{
        sdk:'0.1.1',
        runtime:'0.8.12',
        protocol:'arcane/1'
    });
    assert.deepEqual(manifest.counts,{
        markdownPages:25,
        collectionPages:2,
        generatedPages:82,
        runtimeModulePages:80,
        htmlPages:109,
        inventories:4
    });
    assert.equal(manifest.pages.filter(page=>page.kind==='markdown').length,25);
    assert.equal(manifest.pages.filter(page=>page.kind==='collection').length,2);
    assert.equal(manifest.pages.filter(page=>page.kind==='runtime-module').length,80);
    assert.equal(manifest.pages.filter(page=>page.kind==='generated').length,2);
    assert.equal(new Set(manifest.pages.map(page=>page.source)).size,109);
    assert.equal(new Set(manifest.pages.map(page=>page.output)).size,109);
    assert.equal(new Set(manifest.pages.map(page=>page.route)).size,109);
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

    await t.test('browser-WASM AI is complete, subordinate to normalized AI, and directly discoverable',async()=>{
        const [landing,guide,normalized,sdk,referenceCss,sitemap]=await Promise.all([
            readSiteFile('reference/index.html'),
            readSiteFile('reference/ai/browser-wasm/index.html'),
            readSiteFile('reference/ai/index.html'),
            readSiteFile('reference/sdk-api/index.html'),
            readSiteFile('reference/reference.css'),
            readSiteFile('sitemap.xml')
        ]);
        const decodedGuide=decodeReferenceHtml(guide);
        const decodedNormalized=decodeReferenceHtml(normalized);
        const decodedSdk=decodeReferenceHtml(sdk);
        assert.match(landing,/href="sdk-api\/">API<\/a>/u);
        assert.match(landing,/href="ai\/browser-wasm\/">Browser-WASM AI<\/a>/u);
        assert.match(landing,/<strong>163<\/strong>[\s\S]*12 JavaScript package entrypoints/u);
        assert.match(normalized,/Application default[.][\s\S]*browser-wasm-local-text-inference/u);
        assert.match(decodedNormalized,/arcane-os\/ai\/browser-wasm/u);
        assert.match(decodedNormalized,/\{id, url, bytes\?, sha256\?\}/u);
        assert.match(decodedGuide,/arcane-ai-browser-wasm\/2/u);
        assert.match(decodedGuide,/@wllama\/wllama[\s\S]*3[.]6[.]0/u);
        assert.match(decodedGuide,/arcane[.]ai[.]browser-wasm[.]model[.]v3/u);
        assert.match(decodedGuide,/SDK default is secure:false/u);
        assert.match(decodedGuide,/observed byte length/u);
        assert.match(decodedGuide,/load\(\{offline:true\}\)[\s\S]*ARCANE_AI_MODEL_OFFLINE_MISS/u);
        assert.match(decodedGuide,/AbortSignal[\s\S]*ARCANE_AI_REQUEST_ABORTED/u);
        assert.match(decodedGuide,/never invokes a handler or executes a tool/u);
        assert.match(decodedGuide,/packages no model weights/u);
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
            assert.match(html,/class="repo-link" href="[^"]*">API<\/a>/u,page.output);
        }
        assert.equal(
            (sitemap.match(/<loc>https:\/\/thewizardnexus[.]github[.]io\/arcane-os-sdk\/reference\/ai\/browser-wasm\/<\/loc>/gu)??[]).length,
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
            assert.doesNotMatch(html,/github[.]com\/TheWizardNexus\/(?:arcane-os-sdk|ARCANE-OS)/iu,page.output);
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

    await t.test('published inventories are byte-identical to their canonical sources',async()=>{
        for(const inventory of manifest.inventories){
            const [source,published]=await Promise.all([
                readFile(path.join(repositoryRoot,...inventory.source.split('/'))),
                readFile(path.join(repositoryRoot,...inventory.output.split('/')))
            ]);
            assert.equal(published.equals(source),true,inventory.output);
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
        const [cli,protocols,eventManager,sdk,packageApi]=await Promise.all([
            readSiteFile('reference/cli/index.html'),
            readSiteFile('reference/protocols/index.html'),
            readSiteFile('reference/event-manager/index.html'),
            readSiteFile('reference/sdk-api/index.html'),
            readJson(path.join(repositoryRoot,'docs','reference','inventory','package-api.json'))
        ]);
        const decodedCli=decodeReferenceHtml(cli);
        const decodedProtocols=decodeReferenceHtml(protocols);
        const decodedEvents=decodeReferenceHtml(eventManager);
        const decodedSdk=decodeReferenceHtml(sdk);

        assert.match(cli,/<h2 id="arcane-import-map"><code>arcane import-map<\/code><\/h2>/u);
        assert.match(decodedCli,/arcane import-map \[--workspace <directory>\] \[--app <id>\]/u);
        assert.match(decodedCli,/apps\/<id>\/modules\/arcane[.]importmap[.]json/u);
        assert.match(decodedCli,/data-arcane-import-map/u);
        assert.match(decodedCli,/entryCount:86/u);
        assert.match(decodedCli,/integrated-legacy/u);
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
        assert.match(decodedProtocols,/import ollama from 'arcane\/Ollama';/u);
        assert.match(decodedProtocols,/exactly 86 entries/u);
        assert.match(protocols,/73 named\s+<code>arcane\/[*]<\/code> modules/u);
        assert.match(protocols,/nine <code>arcane\/entities\/[*]<\/code> modules/u);
        assert.match(decodedProtocols,/arcane-os\/event-manager[\s\S]*[.]\/arcane\/sdk\/event-manager[.]mjs/u);
        assert.match(decodedProtocols,/arcane-os\/ai\/browser-wasm[\s\S]*[.]\/arcane\/sdk\/ai\/browser-wasm[.]mjs/u);
        assert.match(decodedProtocols,/event-pubsub[\s\S]*[.]\/arcane\/sdk\/dependencies\/event-pubsub\/index[.]js/u);
        assert.match(decodedProtocols,/[.]\/node_modules\/strong-type\/index[.]js[\s\S]*[.]\/arcane\/dependencies\/strong-type\/index[.]js/u);
        assert.match(decodedProtocols,/173 files in all/u);
        assert.match(decodedProtocols,/manifestSha256: 33396b3d35322b784929270e7ca0a2a8b31d899c6e77bcb227edc95b37d0ae7d/u);
        assert.match(decodedProtocols,/contentSha256: 5e03f45a732db51cb5a2b2193cc79ecda34501d07a9b2e82e794e5fa37d55d00/u);
        assert.match(decodedProtocols,/sourceIdentities/u);
        assert.match(decodedProtocols,/bounded handled-error transaction/u);

        assert.match(decodedEvents,/arcane\/sdk\/event-manager[.]mjs/u);
        assert.match(decodedEvents,/arcane\/sdk\/dependencies\/event-pubsub\/index[.]js/u);
        assert.match(decodedSdk,/toolchain[.]importMap\(/u);
        assert.match(decodedSdk,/executeOperation\('import-map'/u);
        assert.match(
            sdk,
            /There is no exported\s+<code>importMapApplication\(\)<\/code> or <code>generateImportMap\(\)<\/code> binding/u
        );
        assert.equal(packageApi.sdkVersion,'0.2.0');
        assert.equal(packageApi.memberCount,163);
        assert.equal(packageApi.members.some(member=>[
            'importMapApplication','generateImportMap'
        ].includes(member.name)),false);
        assert.doesNotMatch(sdk,/id="importmapapplication"/u);
    });
});

test('generated runtime reference contracts are exhaustive and reader-first',async t=>{
    const [firstPlan,secondPlan,runtimeInventory,sourceContracts]=await Promise.all([
        createReferenceSite(),
        createReferenceSite(),
        readJson(path.join(repositoryRoot,'docs','reference','inventory','runtime-modules.json')),
        extractRuntimeReferenceContracts({repositoryRoot})
    ]);
    const records=runtimeInventory.artifacts;
    const modulePages=firstPlan.manifest.pages.filter(page=>page.kind==='runtime-module');
    const pagesBySource=new Map(modulePages.map(page=>[page.source,page]));
    const sourceByName=new Map(sourceContracts.modules.map(contract=>[contract.name,contract]));
    const overlays=createReferenceModuleContractMap(records);

    await t.test('repeated plans and source extraction have the exact stable census',()=>{
        const verified=spawnSync(
            process.execPath,
            [
                '--experimental-vm-modules',
                path.join(repositoryRoot,'tools','reference-contract-extractor.mjs'),
                '--verify-runtime'
            ],
            {
                cwd:repositoryRoot,
                encoding:'utf8',
                maxBuffer:16*1024*1024,
                timeout:30_000,
                windowsHide:true
            }
        );
        assert.equal(verified.status,0,verified.stderr||verified.error?.message);
        const verifiedSummary=JSON.parse(verified.stdout);
        assert.equal(verifiedSummary.schemaVersion,1);
        assert.match(verifiedSummary.hash,/^[0-9a-f]{64}$/u);
        assert.deepEqual(
            Object.fromEntries(Object.entries(verifiedSummary).filter(
                ([key])=>!['schemaVersion','hash'].includes(key)
            )),
            runtimeContractSummary
        );
        assert.equal(referencePlanHash(firstPlan),referencePlanHash(secondPlan));
        assert.deepEqual(firstPlan.manifest,secondPlan.manifest);
        assert.deepEqual(sourceContracts.summary,runtimeContractSummary);
        assert.deepEqual(firstPlan.manifest.runtimeContracts.summary,runtimeContractSummary);
        assert.equal(firstPlan.manifest.runtimeContracts.hash,sourceContracts.hash);
        assert.match(sourceContracts.hash,/^[0-9a-f]{64}$/u);
        assert.equal(sourceContracts.modules.length,80);
        assert.deepEqual(sourceContracts.modules.map(module=>module.name),records.map(record=>record.name));
        assert.deepEqual(records.reduce((counts,record)=>{
            counts[record.kind]=(counts[record.kind]??0)+1;
            return counts;
        },{}),{
            esm:74,
            worker:1,
            'classic-script':3,
            license:1,
            stylesheet:1
        });
    });

    await t.test('curated overlays and behavior evidence have exact inventory parity',async()=>{
        assert.equal(overlays.size,80);
        assert.deepEqual([...overlays.keys()],records.map(record=>record.name));
        assert.equal([...overlays.values()].filter(record=>record.classification==='public-first-party').length,73);
        assert.equal([...overlays.values()].filter(record=>record.classification==='vendor').length,5);
        assert.equal([...overlays.values()].filter(record=>record.classification==='host-internal').length,1);
        assert.equal([...overlays.values()].filter(record=>record.classification==='internal-worker').length,1);
        assert.deepEqual(
            Object.keys(behaviorExampleEvidence).sort(),
            Object.keys(expectedBehaviorEvidence).sort()
        );
        for(const [name,[sourceBlob,testPath,testBlob]] of Object.entries(expectedBehaviorEvidence)){
            assert.deepEqual(behaviorExampleEvidence[name],{
                repository:'TheWizardNexus/ARCANE-OS',
                commit:behaviorEvidenceCommit,
                sourceBlob,
                testPath,
                testBlob
            });
            assert.equal(
                gitBlobOid(await readFile(path.join(repositoryRoot,'runtime','arcane','modules',name))),
                sourceBlob,
                `${name}: pinned source blob`
            );
        }
    });

    await t.test('every runtime artifact owns one complete local contract page',()=>{
        assert.equal(modulePages.length,80);
        assert.equal(pagesBySource.size,80);
        assert.equal(modulePages.filter(page=>Object.hasOwn(page,'behaviorEvidence')).length,11);
        const totals={
            exports:0,
            reviewedCallables:0,
            publicMembers:0,
            literalCustomEvents:0,
            directCodedFailures:0,
            exportedErrorSubclasses:0
        };
        let renderedBehaviorExamples=0;
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
            assert.deepEqual(page.contractCounts,{
                exports:sourceContract.exports.length,
                reviewedCallables:sourceContract.reviewedCallables.length,
                publicMembers:sourceContract.publicMembers.length,
                literalCustomEvents:sourceContract.events.length,
                directCodedFailures:sourceContract.directCodedFailures.length,
                exportedErrorSubclasses:sourceContract.errorSubclasses.length
            });
            for(const key of Object.keys(totals))totals[key]+=page.contractCounts[key];

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

            const expectedEvidence=expectedBehaviorEvidence[record.name];
            if(expectedEvidence){
                renderedBehaviorExamples+=1;
                assert.deepEqual(page.behaviorEvidence,{
                    source:{
                        repository:'TheWizardNexus/ARCANE-OS',
                        commit:behaviorEvidenceCommit,
                        path:record.file.replace(/^runtime\//u,''),
                        blob:expectedEvidence[0],
                        sha256:page.sourceSha256
                    },
                    test:{
                        repository:'TheWizardNexus/ARCANE-OS',
                        commit:behaviorEvidenceCommit,
                        path:expectedEvidence[1],
                        blob:expectedEvidence[2]
                    }
                });
                assert.match(html,/<h2 id="example">Behavior example<\/h2>/u,record.name);
            }else{
                assert.equal(Object.hasOwn(page,'behaviorEvidence'),false,record.name);
                assert.doesNotMatch(html,/<h2 id="example">Behavior example<\/h2>/u,record.name);
            }
        }
        assert.deepEqual(totals,{
            exports:282,
            reviewedCallables:124,
            publicMembers:407,
            literalCustomEvents:11,
            directCodedFailures:34,
            exportedErrorSubclasses:3
        });
        assert.equal(renderedBehaviorExamples,11);
    });

    await t.test('reader navigation contains no source detours or private signatures',()=>{
        const outputs=['site/reference/index.html',...firstPlan.manifest.pages.map(page=>page.output)];
        for(const output of outputs){
            const html=firstPlan.expectedFiles.get(output).toString('utf8');
            assert.doesNotMatch(html,/href="[^"]*[.]md(?:[?#][^"]*)?"/iu,output);
            assert.doesNotMatch(html,/github[.]com\/TheWizardNexus\/(?:arcane-os-sdk|ARCANE-OS)/iu,output);
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
            ['esm',74],
            ['classic-script',3],
            ['worker',1],
            ['stylesheet',1],
            ['license',1]
        ])assert.equal(filterModuleSearchRecords(records,'',{kind}).length,count,kind);
        const ai=records.find(record=>record.name==='AI.js');
        assert.equal(moduleMatchesSearch(ai,'provider speech cloud'),true);
        assert.equal(moduleMatchesSearch(ai,'provider speech cloud',{kind:'worker'}),false);
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
    assert.match(hello,/npx arcane-os@0[.]1[.]1 new hello-world/u);
    assert.match(hello,/npm install/u);
    assert.match(hello,/npm install --global arcane-os@0[.]1[.]1/u);
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
    assert.match(decodedHello,/No model weights ship[\s\S]*no model download starts/iu);
    assert.match(decodedHello,/1,998,371,424 bytes \(1[.]86 GiB\)/u);
    assert.match(decodedHello,/loadPolicy:'manual'/u);
    assert.match(decodedHello,/localOnly:true/u);
    assert.match(decodedHello,/Proposed tool calls/u);
    assert.match(decodedHello,/model-source request/u);
    assert.match(decodedHello,/same-origin Wllama\/WASM assets may still load/u);
    assert.match(decodedHello,/Any verified cache remains; an interrupted model download is discarded/u);
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
        /Model downloaded, SHA-256 verified, admitted to app-scoped DBOPFS, and loaded locally/u
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

test('maintained Hello World example matches current SDK contracts',async t=>{
    const appRoot=path.join(exampleRoot,'apps','hello-world');
    const requiredFiles=[
        '.gitattributes',
        '.gitignore',
        'AGENTS.md',
        'README.md',
        'package.json',
        'package-lock.json',
        'arcane-packager.json',
        'arcane.lock.json',
        '.github/workflows/check.yml',
        'apps/hello-world/arcane-app.json',
        'apps/hello-world/arcane-package.json',
        'apps/hello-world/manifest.json',
        'apps/hello-world/index.html',
        'apps/hello-world/hello-world.css',
        'apps/hello-world/modules/App.js',
        'apps/hello-world/modules/arcane.importmap.json',
        'apps/hello-world/test/app.test.mjs',
        'apps/hello-world/img/icon.png'
    ];
    for(const relative of requiredFiles){
        assert.equal((await stat(path.join(exampleRoot,...relative.split('/')))).isFile(),true,relative);
    }

    const [rootPackage,examplePackage,packageLock,lock,runtimeRelease,browserRelease,authoredDescriptor,packageManifest,packager]=await Promise.all([
        readJson(path.join(repositoryRoot,'package.json')),
        readJson(path.join(exampleRoot,'package.json')),
        readJson(path.join(exampleRoot,'package-lock.json')),
        readJson(path.join(exampleRoot,'arcane.lock.json')),
        readJson(path.join(repositoryRoot,'runtime','ARCANE_RUNTIME_RELEASE.json')),
        readJson(path.join(repositoryRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json')),
        readJson(path.join(appRoot,'arcane-app.json')),
        readJson(path.join(appRoot,'arcane-package.json')),
        readJson(path.join(exampleRoot,'arcane-packager.json'))
    ]);
    await t.test('pins the current npm and runtime identities',()=>{
        assert.equal(rootPackage.version,'0.1.2');
        assert.equal(examplePackage.devDependencies['arcane-os'],'0.1.2');
        assert.equal(examplePackage.engines.node,'>=22.23.2');
        assert.equal(packageLock.lockfileVersion,3);
        assert.equal(packageLock.requires,true);
        assert.equal(packageLock.packages[''].devDependencies['arcane-os'],'0.1.2');
        assert.equal(packageLock.packages[''].engines.node,'>=22.23.2');
        const installedSdk=packageLock.packages['node_modules/arcane-os'];
        assert.deepEqual(
            {
                version:installedSdk.version,
                resolved:installedSdk.resolved,
                integrity:installedSdk.integrity,
                dev:installedSdk.dev,
                license:installedSdk.license,
                node:installedSdk.engines.node
            },
            {
                version:'0.1.2',
                resolved:'https://registry.npmjs.org/arcane-os/-/arcane-os-0.1.2.tgz',
                integrity:'sha512-fzVbd01xwFVCHTN6k8x/xPK8xtPy5yCtSkzFLmr1jNVTUBHzmnubLK8a5pWSGH7IhsWce+/AFHOu/TnWSKwDsQ==',
                dev:true,
                license:'AGPL-3.0-only',
                node:'>=22.23.2'
            }
        );
        assert.equal(lock.sdk.version,'0.1.2');
        assert.equal(lock.runtime.contentSha256,runtimeRelease.contentSha256);
        assert.equal(lock.runtime.upstreamCommit,runtimeRelease.source.legacyProjection.commit);
        assert.equal(lock.protocols.arcane,runtimeRelease.source.protocol);
    });
    await t.test('maps and inventories the documented Arcane runtime exactly',async()=>{
        const runtimePayload=packager.sharedPayloads['browser-runtime']
            .find(payload=>payload.destination==='arcane');
        assert.deepEqual(runtimePayload,{
            source:'arcane',
            destination:'arcane',
            include:['components','css','dependencies','entities','img','modules','sdk','security'],
            exclude:[]
        });

        const expectedRecords=[
            ...runtimeRelease.files.map(file=>({
                ...file,
                path:file.path.startsWith('arcane/')
                    ?file.path.slice('arcane/'.length)
                    :`dependencies/${file.path}`
            })),
            ...browserRelease.files.map(file=>({...file,path:`sdk/${file.path}`}))
        ].sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
        const expectedPaths=expectedRecords.map(file=>file.path);
        const physicalPaths=[];
        async function visit(directory,relativeRoot=''){
            for(const entry of await readdir(directory,{withFileTypes:true})){
                const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
                const absolute=path.join(directory,entry.name);
                const info=await lstat(absolute);
                assert.equal(info.isSymbolicLink(),false,relative);
                if(info.isDirectory())await visit(absolute,relative);
                else{
                    assert.equal(info.isFile(),true,relative);
                    physicalPaths.push(relative);
                }
            }
        }
        await visit(path.join(exampleRoot,'arcane'));
        physicalPaths.sort();
        assert.equal(physicalPaths.length,185);
        assert.deepEqual(physicalPaths,expectedPaths);
        for(const file of expectedRecords){
            const bytes=await readFile(path.join(exampleRoot,'arcane',...file.path.split('/')));
            assert.equal(bytes.length,file.bytes,file.path);
            assert.equal(
                createHash('sha256').update(bytes).digest('hex'),
                file.sha256,
                file.path
            );
        }

        const artifact=await readFile(
            path.join(appRoot,'modules','arcane.importmap.json'),
            'utf8'
        );
        const importMap=JSON.parse(artifact);
        assert.deepEqual(Object.keys(importMap),['imports']);
        assert.equal(Object.keys(importMap.imports).length,91);
        assert.equal(
            importMap.imports['arcane-os/ai/browser-wasm'],
            './arcane/sdk/ai/browser-wasm.mjs'
        );
        assert.equal(
            importMap.imports['arcane-os/ai/browser-speech'],
            './arcane/sdk/ai/browser-speech.mjs'
        );
        const generated=await buildImportMap({
            files:expectedPaths,
            readFile:relative=>readFile(path.join(
                exampleRoot,'arcane',...relative.split('/')
            ))
        });
        assert.equal(generated.entryCount,91);
        assert.deepEqual(importMap.imports,generated.imports);
        const expectedPathSet=new Set(expectedPaths);
        for(const [specifier,target] of Object.entries(importMap.imports)){
            assert.match(target,/^[.]\/arcane\//u,specifier);
            assert.equal(
                expectedPathSet.has(target.slice('./arcane/'.length)),
                true,
                `${specifier} targets missing ${target}.`
            );
        }
        const entry=await readFile(path.join(appRoot,'index.html'),'utf8');
        const inline=entry.match(
            /<script type="importmap" data-arcane-import-map>\r?\n([\s\S]*?)<\/script>/u
        );
        assert.ok(inline);
        assert.equal(inline[1],artifact);

        const browserManifestBytes=await readFile(
            path.join(repositoryRoot,'browser-runtime','ARCANE_SDK_BROWSER_RELEASE.json')
        );
        assert.deepEqual(lock.sdkBrowserRuntime,{
            manifest:'node_modules/arcane-os/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json',
            manifestSha256:createHash('sha256').update(browserManifestBytes).digest('hex'),
            contentSha256:browserRelease.contentSha256,
            builder:browserRelease.builder,
            sdkVersion:browserRelease.sdkVersion,
            source:browserRelease.source
        });
    });
    await t.test('descriptor validates and projects exactly',()=>{
        const descriptor=validateAppDescriptor(authoredDescriptor,{appId:'hello-world'});
        assert.deepEqual(projectPackageManifest(descriptor),packageManifest);
        assert.deepEqual(descriptor.permissions,{
            capabilities:[],
            methods:[]
        });
        assert.deepEqual(descriptor.targets,['browser']);
    });
    await t.test('icon is the maintained scaffold asset',async()=>{
        const [exampleIcon,templateIcon]=await Promise.all([
            readFile(path.join(appRoot,'img','icon.png')),
            readFile(path.join(repositoryRoot,'src','templates','assets','app-icon.png'))
        ]);
        assert.equal(createHash('sha256').update(exampleIcon).digest('hex'),createHash('sha256').update(templateIcon).digest('hex'));
    });
    await t.test('source uses the generated map before named app behavior',async()=>{
        const [html,style,script,readme,workflow,tutorial,compatibilityAlias]=await Promise.all([
            readFile(path.join(appRoot,'index.html'),'utf8'),
            readFile(path.join(appRoot,'hello-world.css'),'utf8'),
            readFile(path.join(appRoot,'modules','App.js'),'utf8'),
            readFile(path.join(exampleRoot,'README.md'),'utf8'),
            readFile(path.join(exampleRoot,'.github','workflows','check.yml'),'utf8'),
            readSiteFile('examples/index.html'),
            readSiteFile('examples/hello-world/index.html')
        ]);
        const base=html.indexOf('<base href="../../">');
        const managedMap=html.indexOf('<script type="importmap" data-arcane-import-map>');
        const theme=html.indexOf('./arcane/css/theme.css');
        const primitives=html.indexOf('./arcane/css/primitives.css');
        const appStyle=html.indexOf('./apps/hello-world/hello-world.css');
        const appModule=html.indexOf('./apps/hello-world/modules/App.js');
        assert.ok(
            base>=0&&managedMap>base&&theme>managedMap&&primitives>theme
            &&appStyle>primitives&&appModule>appStyle
        );
        const htmlRuntimeReferences=[...html.matchAll(
            /(?:href|src)="[.]\/(arcane\/[^"?]+)(?:[?][^"]*)?"/gu
        )].map(match=>match[1]).sort();
        const scriptRuntimeImports=[...script.matchAll(
            /from\s+['"](arcane(?:-os)?\/[^'"]+)['"]/gu
        )].map(match=>match[1]).sort();
        assert.deepEqual(htmlRuntimeReferences,[
            'arcane/css/primitives.css',
            'arcane/css/theme.css'
        ]);
        assert.deepEqual(scriptRuntimeImports,[
            'arcane-os/ai/browser-wasm',
            'arcane/AppDataScope',
            'arcane/DBOPFS',
            'arcane/ThemeBootstrap'
        ]);
        assert.match(script,/function sayHello\(\)/u);
        assert.match(script,/Hello from Arcane OS!/u);
        assert.match(script,/resolveApplicationId\(\)/u);
        assert.match(script,/resolveApplicationLocalStorageKey\('hello-count',\{applicationId:appId\}\)/u);
        for(const modelAuthority of [
            "id:'ibm-granite-4.1-3b-q4-k-s'",
            "url:'https://huggingface.co/ibm-granite/granite-4.1-3b-GGUF/resolve/ab4701481089b58a082ef63cc1cee738887293ff/granite-4.1-3b-Q4_K_S.gguf'",
            'bytes:1_998_371_424',
            "sha256:'ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a'"
        ])assert.equal(script.includes(modelAuthority),true,modelAuthority);
        assert.match(html,/No model weights ship[\s\S]*no model download starts/iu);
        assert.match(html,/1,998,371,424 bytes \(1[.]86 GiB\)/u);
        assert.match(html,/Proposed tool calls/u);
        assert.match(script,/new DBOPFS\(\{applicationId:appId\}\)/u);
        assert.match(script,/await dbopfs[.]readyPromise/u);
        assert.match(script,/dbopfs[.]applicationId!==appId/u);
        assert.match(script,/createArcaneAI\(\{[\s\S]*provider,[\s\S]*loadPolicy:'manual',[\s\S]*security:\{secure:true\}[\s\S]*\}\)/u);
        assert.match(script,/renderProgress\(event[.]detail[?][.]progress\)/u);
        assert.match(script,/local[.]load\(\{signal:controller[.]signal,offline\}\)/u);
        assert.match(script,/local[.]streamRequest\(\{[\s\S]*localOnly:true,[\s\S]*signal:controller[.]signal,[\s\S]*tools:\[SHOW_GREETING_TOOL\]/u);
        assert.match(script,/activeController[?][.]abort\('Cancelled by the application user[.]'\)/u);
        assert.match(script,/await local[.]unload\(\)/u);
        assert.match(script,/activeController[?][.]abort\('The page is closing[.]'\)[\s\S]*[.]then\(value=>value[.]dispose\(\)\)/u);
        assert.match(script,/Any verified cache remains; an interrupted model download is discarded/u);
        assert.match(script,/without a model-source request/u);
        assert.match(script,/same-origin Wllama\/WASM assets may still load/u);
        assert.doesNotMatch(
            script,
            /(?:[.][.]\/)+arcane\/|DirectoryPicker|globalThis[.]Arcane|toolHandlers|executeTools|keepCache|Date[.]now|SDK update|partial bytes were removed/iu
        );
        const renderedTutorial=decodeReferenceHtml(tutorial);
        const renderedAlias=decodeReferenceHtml(compatibilityAlias);
        for(const source of [html,style,script]){
            assert.equal(renderedTutorial.includes(source.trim()),true);
            assert.equal(renderedAlias.includes(source.trim()),false);
        }
        assert.match(readme,/npx arcane-os@0[.]1[.]2 new[\s\S]*npm install/u);
        assert.match(readme,/generated project pins `arcane-os` exactly[\s\S]*project-local CLI/u);
        assert.match(readme,/npm install --global arcane-os@0[.]1[.]2/u);
        assert.match(readme,/## Source shape[\s\S]*same physical runtime paths[\s\S]*arcane[.]importmap[.]json/u);
        assert.match(
            readme,
            /[.]\/node_modules\/strong-type\/index[.]js[\s\S]*[.]\/arcane\/dependencies\/strong-type\/index[.]js/u
        );
        assert.match(readme,/authenticated `arcane\/` projection contains 173 files/u);
        assert.match(readme,/generated map\s+contains 86 entries/u);
        assert.match(readme,/`load\(\{offline:true\}\)`\s+makes no model-source request/u);
        assert.match(readme,/ARCANE_AI_[*][\s\S]*APP_DATA_[*]/u);
        assert.match(
            readme,
            /initial Hugging Face origin[\s\S]*provider-controlled HTTPS redirect[\s\S]*without pinning an unstable[\s\S]*regional CDN hostname/u
        );
        assert.match(readme,/dist\/hello-world\/[\s\S]*arcane\//u);
        assert.match(readme,/arcane\/AppDataScope/u);
        assert.match(readme,/arcane\/ThemeBootstrap/u);
        assert.match(readme,/arcane-os\/event-manager/u);
        assert.match(readme,/npm run dev/u);
        assert.match(readme,/npm run package/u);
        assert.match(readme,/npm run build/u);
        assert.match(readme,/does not create a\s+standalone native executable/u);
        assert.doesNotMatch(readme,/build\/windows-x64\/hello-world\/ArcaneApp-hello-world[.]exe/u);
        assert.doesNotMatch(
            readme,
            /not yet published|after publication|pack:local|[.]tgz|0[.]1[.]0-dev|exactly 152|CI shape|--arcane-root|source sync|Arcane Ollama|prebuilt Arcane Core/iu
        );
        assert.match(workflow,/npm ci --ignore-scripts/u);
    });
});

test('Pages assets retain exact brand identities',async t=>{
    const [header,sigil]=await Promise.all([
        readSiteFile('assets/arcane-os-sdk-readme-header.png',null),
        readSiteFile('assets/arcane-sigil-512.png',null)
    ]);
    await t.test('retains the reviewed dimensions',()=>{
        assert.deepEqual(pngDimensions(header),{width:2172,height:724});
        assert.deepEqual(pngDimensions(sigil),{width:512,height:512});
    });
    await t.test('retains the reviewed bytes',()=>{
        assert.equal(createHash('sha256').update(header).digest('hex').toUpperCase(),'4DC9AD6FCAA572B3789BDD0FB5847D399840FBDEB46CD54B717478AE46685D47');
        assert.equal(createHash('sha256').update(sigil).digest('hex').toUpperCase(),'6CBB0C89168713E5DF9FAB9E0A51628A40D13F449498DB7832A800A5E425D48D');
    });
});

test('Pages workflow deploys one authenticated main static artifact',async t=>{
    const [workflow,packageDocument,readme,robots,sitemap]=await Promise.all([
        readFile(path.join(repositoryRoot,'.github','workflows','pages.yml'),'utf8'),
        readJson(path.join(repositoryRoot,'package.json')),
        readFile(path.join(repositoryRoot,'README.md'),'utf8'),
        readSiteFile('robots.txt'),
        readSiteFile('sitemap.xml')
    ]);
    await t.test('uses least privilege and one successful canonical main check',()=>{
        assert.match(workflow,/permissions:\s*\{\}/u);
        assert.match(workflow,/actions:\s*read/u);
        assert.match(workflow,/contents:\s*read/u);
        assert.match(workflow,/pages:\s*write/u);
        assert.match(workflow,/id-token:\s*write/u);
        assert.match(workflow,/github[.]repository == 'TheWizardNexus\/arcane-os-sdk'/u);
        assert.match(workflow,/workflow_run[.]event == 'push'/u);
        assert.match(workflow,/workflow_run[.]conclusion == 'success'/u);
        assert.match(workflow,/head_branch == 'main'/u);
    });
    await t.test('checks out, authenticates, and deploys the resolved revision',()=>{
        assert.match(workflow,/actions\/workflows\/check[.]yml\/runs/u);
        assert.match(workflow,/-f branch=main/u);
        assert.match(workflow,/actions\/checkout@v7[\s\S]*ref: \$\{\{ steps[.]check[.]outputs[.]checked_sha \}\}/u);
        assert.match(workflow,/git rev-parse HEAD/u);
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
        assert.equal(locations.length,121);
        assert.equal(new Set(locations).size,121);
        assert.equal(locations.filter(url=>url===`${canonicalRoot}examples/`).length,1);
        assert.equal(locations.includes(`${canonicalRoot}examples/hello-world/`),false);
        assert.equal(
            locations.filter(url=>url===`${canonicalRoot}reference/ai/browser-wasm/`).length,
            1
        );
        const pageRoutes=await loadPageRoutes();
        assert.equal(pageRoutes.size,121);
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
