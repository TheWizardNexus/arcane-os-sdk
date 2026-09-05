import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {SDK_VERSION} from '../src/constants.mjs';
import {
    buildImportMap,
    createApplicationTestImportMapContext,
    generateImportMap,
    readWorkspaceAssetVersion,
    rewriteAssetReferences,
    scanModuleImports,
    versionAssetUrl
} from '../src/import-map.mjs';
import {temporaryDirectory} from './helpers.mjs';

test('asset URLs preserve raw parameters, fragments and relative spelling',function completeAssetUrls(){
    assert.equal(versionAssetUrl('./module.js?v=4&mode=a%20b#entry','2.3.4'),
        './module.js?v=4&mode=a%20b&arcaneVersion=2.3.4#entry');
    assert.equal(versionAssetUrl('../module.js?flag&arcaneVersion=old&&mode=a+b#entry','2.3.4'),
        '../module.js?flag&arcaneVersion=2.3.4&&mode=a+b#entry');
    assert.equal(versionAssetUrl('/module.js?%61rcaneVersion=old&flag=','2.3.4'),
        '/module.js?%61rcaneVersion=2.3.4&flag=');
    assert.equal(versionAssetUrl('module.js?flag&','2.3.4'),
        'module.js?flag&arcaneVersion=2.3.4');
    for(const reference of ['https://example.test/a.js','//example.test/a.js','data:text/javascript,0','blob:example','#symbol','?mode=1']){
        assert.equal(versionAssetUrl(reference,'2.3.4'),reference);
    }
    assert.equal(versionAssetUrl('./entry.js'),`./entry.js?arcaneVersion=${SDK_VERSION}`);
});

test('module resources change at literal syntax without rewriting text, data or external URLs',function moduleResourceSyntax(){
    const source=[
        "import Main from './main.js?v=4#module';",
        "export {helper} from '../helper.mjs';",
        "await import('./dynamic.js');",
        "import AI from 'arcane/AI';",
        "const resource = new URL('./worker.mjs', import.meta.url);",
        "const nested = new URL(role === 'stt' ? './stt-worker.mjs' : './tts-worker.mjs', import.meta.url);",
        "nested.searchParams.set('arcaneSpeechWorkerMode', 'artifact-module-worker');",
        "new Worker('./classic.js');",
        "new SharedWorker('./shared.js');",
        "importScripts('./first.js', './second.js');",
        "fetch('./theme.css', {cache:'default', method:'GET'});",
        "fetch('./document.html', {method:'POST', body:document});",
        "fetch('./document.html', {body});",
        "fetch('./data.json');",
        "new URL('./document.json', import.meta.url);",
        "new URL('./document.html', import.meta.url);",
        "new URL('./remote.js', 'https://example.test/');",
        "import('https://example.test/remote.js');",
        "const text = \"import('./not-code.js')\";",
        "// import('./comment.js')",
        "const template = `import('./template.js')`;",
        "await import(selected);"
    ].join('\n');
    const transformed=rewriteAssetReferences(source,{filePath:'entry.mjs',version:'2.3.4'});
    assert.ok(transformed.includes("'./main.js?v=4&arcaneVersion=2.3.4#module'"));
    for(const name of ['../helper.mjs','./dynamic.js','./worker.mjs','./stt-worker.mjs','./tts-worker.mjs','./classic.js','./shared.js','./first.js','./second.js','./theme.css']){
        assert.ok(transformed.includes(`'${name}?arcaneVersion=2.3.4'`),name);
    }
    for(const line of source.split('\n').slice(11))assert.ok(transformed.includes(line),line);
    assert.ok(transformed.includes("role === 'stt'"));
    assert.ok(transformed.includes("nested.searchParams.set('arcaneSpeechWorkerMode', 'artifact-module-worker');"));
    assert.ok(transformed.includes("import AI from 'arcane/AI';"));
    assert.equal(rewriteAssetReferences(transformed,{filePath:'entry.mjs',version:'2.3.4'}),transformed);
});

test('escaped JavaScript URL spellings survive version replacement',function escapedReferenceSyntax(){
    const source=String.raw`import './module.js?v=4\u0026arcaneVersion=old\u0026mode=a%20b#part';`;
    const expected=String.raw`import './module.js?v=4\u0026arcaneVersion=2.3.4\u0026mode=a%20b#part';`;
    assert.equal(rewriteAssetReferences(source,{filePath:'entry.js',version:'2.3.4'}),expected);
});

test('HTML changes active resources while retaining templates, payload scripts and encoded attributes',function activeHtmlResources(){
    const source=[
        '<base href="../../">',
        '<!-- <script src="./comment.js"></script> -->',
        '<template><script src="./template.js"></script><img src="./template.png"></template>',
        '<script type="application/json">{"content":"import(\'./payload.js\')"}</script>',
        '<script type="module" src="./entry.js?mode=a&amp;arcaneVersion=old&amp;v=4#entry"></script>',
        '<link rel="stylesheet" href="./theme.css?v=4&amp;mode=a%20b">',
        '<html-import href="./component.html?v=13"></html-import>',
        '<img src="./image.png" srcset="./small.png 1x, ./large.png 2x">',
        '<div style="background:url(&quot;./image.png?mode=a&amp;v=4&quot;)">kept</div>',
        '<a href="./document.html">document</a>',
        '<script type="module">await import("./inline.js"); const data="./document.html";</script>'
    ].join('\n');
    const references=[];
    const transformed=rewriteAssetReferences(source,{
        filePath:'index.html',version:'2.3.4',
        onReference:function recordReference(reference){references.push(reference);}
    });
    for(const line of source.split('\n').slice(1,4))assert.ok(transformed.includes(line));
    assert.ok(transformed.includes('./entry.js?mode=a&amp;arcaneVersion=2.3.4&amp;v=4#entry'));
    assert.ok(transformed.includes('./theme.css?v=4&amp;mode=a%20b&amp;arcaneVersion=2.3.4'));
    assert.ok(transformed.includes('./component.html?v=13&amp;arcaneVersion=2.3.4'));
    assert.ok(transformed.includes('url(&quot;./image.png?mode=a&amp;v=4&amp;arcaneVersion=2.3.4&quot;)'));
    assert.ok(transformed.includes('<a href="./document.html">document</a>'));
    assert.ok(transformed.includes('await import("./inline.js?arcaneVersion=2.3.4")'));
    assert.ok(references.some(function hasOriginalScript(item){
        return item.url==='./entry.js?mode=a&arcaneVersion=old&v=4#entry'
            &&item.kind==='script'&&item.baseHref==='../../';
    }));
    assert.ok(references.every(function usesDocumentBase(item){return item.baseHref==='../../';}));
    assert.equal(rewriteAssetReferences(transformed,{filePath:'index.html',version:'2.3.4'}),transformed);
});

test('import maps update only exact target URLs and preserve prefix mappings and other JSON',function importMapTargets(){
    const source='<script type="importmap">{ "imports": { "entry": "./entry.js?arcaneVersion=old", "pkg/": "./pkg/" }, "scopes": { "./scope/": { "helper": "./helper.mjs" } }, "data": { "content": "./payload.js" } }</script>';
    const transformed=rewriteAssetReferences(source,{filePath:'index.html',version:'2.3.4'});
    assert.equal(transformed,'<script type="importmap">{ "imports": { "entry": "./entry.js?arcaneVersion=2.3.4", "pkg/": "./pkg/" }, "scopes": { "./scope/": { "helper": "./helper.mjs?arcaneVersion=2.3.4" } }, "data": { "content": "./payload.js" } }</script>');
});

test('CSS preserves comments and text while versioning imported sheets and resource URLs',function cssResourceSyntax(){
    const source=[
        '/* url(./comment.png) */',
        '@import "./layout.css?v=2";',
        '@import url(./palette.css);',
        '.card {background:url("./card.png?mode=a#part");content:"url(./text.png)";}',
        '.icon {mask:url(#symbol);background:url(data:image/svg+xml,example);}'
    ].join('\n');
    const transformed=rewriteAssetReferences(source,{filePath:'theme.css',version:'2.3.4'});
    assert.ok(transformed.includes('@import "./layout.css?v=2&arcaneVersion=2.3.4"'));
    assert.ok(transformed.includes('url(./palette.css?arcaneVersion=2.3.4)'));
    assert.ok(transformed.includes('url("./card.png?mode=a&arcaneVersion=2.3.4#part")'));
    assert.ok(transformed.includes('/* url(./comment.png) */'));
    assert.ok(transformed.includes('content:"url(./text.png)"'));
    assert.ok(transformed.includes('mask:url(#symbol);background:url(data:image/svg+xml,example)'));
});

test('reference reporting includes current URLs and separates data fetches from module edges',function unchangedResourceReporting(){
    const source="import './ready.js?arcaneVersion=2.3.4'; fetch('./theme.css'); fetch('./fragment.html');";
    const references=[];
    rewriteAssetReferences(source,{
        filePath:'entry.js',version:'2.3.4',
        onReference:function recordReference(reference){references.push(reference);}
    });
    assert.deepEqual(references,[
        {url:'./ready.js?arcaneVersion=2.3.4',kind:'import',baseHref:null},
        {url:'./theme.css',kind:'fetch',baseHref:null,baseKind:'document'}
    ]);
    const data='{"content":"import(\'./data.js\')"}';
    assert.equal(rewriteAssetReferences(data,{filePath:'document.json',version:'2.3.4'}),data);
});

test('resource reporting distinguishes document-relative addresses from module URLs',function resourceBaseKinds(){
    const source=[
        "import './dependency.js';",
        "new Worker('./worker.js');",
        "new SharedWorker('./shared.js');",
        "fetch('./theme.css');",
        "new URL('./module-worker.js', import.meta.url);",
        "new URL('./document-worker.js', document.baseURI);",
        "importScripts('./worker-dependency.js');",
        "new URL(role === '?' ? './first.js' : './second.js', import.meta.url);"
    ].join('\n');
    const references=[];
    const transformed=rewriteAssetReferences(source,{
        filePath:'entry.js',version:'2.3.4',
        onReference:function recordReference(reference){references.push(reference);}
    });
    assert.deepEqual(references.filter(function usesDocumentBase(item){return item.baseKind==='document';}).map(function referenceUrl(item){return item.url;}),[
        './worker.js','./shared.js','./theme.css','./document-worker.js'
    ]);
    assert.ok(references.filter(function usesModuleBase(item){return !item.baseKind;}).some(function hasModuleWorker(item){return item.url==='./module-worker.js';}));
    assert.ok(transformed.includes("role === '?' ? './first.js?arcaneVersion=2.3.4' : './second.js?arcaneVersion=2.3.4'"));
    const htmlReferences=[];
    rewriteAssetReferences('<base href="../../"><link rel="modulepreload" href="./module.js"><link rel="preload" as="style" href="./theme.css"><link rel="preload" as="script" href="./classic.js"><iframe src="./frame.html"></iframe><script>new Worker("./worker.js")</script>',{
        filePath:'index.html',version:'2.3.4',
        onReference:function recordHtmlReference(reference){htmlReferences.push(reference);}
    });
    assert.deepEqual(htmlReferences.map(function resourceKind(item){return item.kind;}),[
        'script','style','script','document','script'
    ]);
    assert.deepEqual(htmlReferences.at(-1),{url:'./worker.js',kind:'script',baseHref:'../../',baseKind:'document'});
});

test('remote document bases and inactive script data are unchanged',function nonlocalHtmlResources(){
    const remote='<base href="https://example.test/"><script src="./script.js"></script><style>@import "./theme.css";</style>';
    assert.equal(rewriteAssetReferences(remote,{filePath:'index.html',version:'2.3.4'}),remote);
    const data='<script type="application/json" src="./payload.js">{"content":"./payload.js"}</script>';
    assert.equal(rewriteAssetReferences(data,{filePath:'index.html',version:'2.3.4'}),data);
});

test('generated URL keys share the package-selected module targets',async function inventoryModuleIdentity(){
    const result=await buildImportMap({
        files:['modules/State.js','modules/nested/helper.mjs','css/theme.css'],
        version:'2.3.4'
    });
    assert.deepEqual(result.imports,{
        './arcane/modules/State.js':'./arcane/modules/State.js?arcaneVersion=2.3.4',
        './arcane/modules/State.js?arcaneVersion=2.3.4':'./arcane/modules/State.js?arcaneVersion=2.3.4',
        './arcane/modules/nested/helper.mjs':'./arcane/modules/nested/helper.mjs?arcaneVersion=2.3.4',
        './arcane/modules/nested/helper.mjs?arcaneVersion=2.3.4':'./arcane/modules/nested/helper.mjs?arcaneVersion=2.3.4',
        'arcane/State':'./arcane/modules/State.js?arcaneVersion=2.3.4'
    });
});

test('versioned module imports retain generated URL redirects from document and module bases',async function versionedUrlAliasResolution(){
    const version='2.3.4';
    const base='https://example.test/';
    const result=await buildImportMap({files:['modules/DBOPFS.js','dependencies/strong-type/index.js'],version});
    const imports=new Map(Object.entries(result.imports).map(function normalizedEntry([specifier,target]){
        return [new URL(specifier,base).href,new URL(target,base).href];
    }));
    for(const [specifier,importer] of [
        ['./node_modules/strong-type/index.js',base],
        ['../../node_modules/strong-type/index.js',`${base}arcane/modules/DBOPFS.js`],
        ['/node_modules/strong-type/index.js',`${base}apps/fixture/entry.js`]
    ]){
        const source=`import Is from ${JSON.stringify(specifier)};`;
        const transformed=rewriteAssetReferences(source,{filePath:'entry.js',version});
        const rewritten=scanModuleImports(transformed,{importer:'entry.js'}).imports[0].specifier;
        const target=`${base}arcane/dependencies/strong-type/index.js?arcaneVersion=${version}`;
        assert.equal(imports.get(new URL(rewritten,importer).href),target);
        assert.equal(imports.get(new URL(specifier,importer).href),target);
    }
    for(const [specifier,target] of Object.entries(result.imports)){
        if(specifier.startsWith('./'))assert.equal(result.imports[versionAssetUrl(specifier,version)],target);
    }
});

test('authored URL redirects and exact scopes retain versioned aliases without replacing authored entries',function authoredUrlAliases(){
    const map={
        imports:{
            './alias.js':'./actual.js?mode=a%20b#part',
            '../helper.mjs?mode=a+b#part':'./helper.mjs',
            '/remote.js':'https://example.test/remote.js',
            '/unavailable.js':null,
            './directory-alias.js':'./directory/',
            'https://example.test/absolute.js':'./absolute-target.js',
            '//example.test/network.js':'./network-target.js',
            './pkg/':'./packages/',
            'bare':'./bare.js',
            './chosen.js':'./default.js',
            './chosen.js?arcaneVersion=2.3.4':'./selected.js'
        },
        scopes:{
            './scope/':{'./alias.js':'./scoped.js','./pkg/':'./scoped-package/'},
            './entry.js':{'./alias.js':'./exact-scoped.js'},
            'entry-without-dot.js':{'./alias.js':'./relative-scoped.js'},
            'https://example.test/absolute-entry.js':{'./alias.js':'./absolute-scoped.js'}
        },
        data:{content:'./payload.js'}
    };
    const source=`<script type="importmap">${JSON.stringify(map)}</script>`;
    const transformed=rewriteAssetReferences(source,{filePath:'index.html',version:'2.3.4'});
    const actual=JSON.parse(transformed.slice(transformed.indexOf('>')+1,transformed.lastIndexOf('</script>')));
    for(const key of ['./alias.js','../helper.mjs?mode=a+b#part','/remote.js','/unavailable.js']){
        const target=versionAssetUrl(map.imports[key],'2.3.4');
        assert.equal(actual.imports[key],target);
        assert.equal(actual.imports[versionAssetUrl(key,'2.3.4')],target);
    }
    assert.equal(actual.imports['./chosen.js?arcaneVersion=2.3.4'],'./selected.js?arcaneVersion=2.3.4');
    assert.equal(actual.imports['bare?arcaneVersion=2.3.4'],undefined);
    assert.equal(actual.imports['./pkg/'],'./packages/');
    assert.equal(actual.imports['./pkg/?arcaneVersion=2.3.4'],undefined);
    assert.equal(actual.imports['./directory-alias.js?arcaneVersion=2.3.4'],'./directory/');
    assert.equal(actual.imports['https://example.test/absolute.js?arcaneVersion=2.3.4'],'./absolute-target.js?arcaneVersion=2.3.4');
    assert.equal(actual.imports['//example.test/network.js?arcaneVersion=2.3.4'],'./network-target.js?arcaneVersion=2.3.4');
    assert.deepEqual(actual.data,map.data);
    assert.equal(actual.scopes['./scope/']['./alias.js?arcaneVersion=2.3.4'],'./scoped.js?arcaneVersion=2.3.4');
    assert.equal(actual.scopes['./scope/']['./pkg/'],'./scoped-package/');
    assert.equal(actual.scopes['./scope/?arcaneVersion=2.3.4'],undefined);
    assert.deepEqual(actual.scopes['./entry.js?arcaneVersion=2.3.4'],actual.scopes['./entry.js']);
    assert.equal(actual.scopes['./entry.js']['./alias.js?arcaneVersion=2.3.4'],'./exact-scoped.js?arcaneVersion=2.3.4');
    assert.deepEqual(actual.scopes['entry-without-dot.js?arcaneVersion=2.3.4'],actual.scopes['entry-without-dot.js']);
    assert.deepEqual(actual.scopes['https://example.test/absolute-entry.js?arcaneVersion=2.3.4'],actual.scopes['https://example.test/absolute-entry.js']);
    assert.equal(rewriteAssetReferences(transformed,{filePath:'index.html',version:'2.3.4'}),transformed);
});

test('authored normalized aliases and scopes take priority over generated companions',function normalizedAuthoredPriority(){
    const map={
        imports:{
            './alias.js?arcaneVersion=2.3.4':'./selected.js',
            '/alias.js':'./default.js',
            './other.js':'./other-default.js',
            './nested/../other.js?arcaneVersion=2.3.4':'./other-selected.js'
        },
        scopes:{
            './entry.js?arcaneVersion=2.3.4':{chosen:'./selected.js'},
            '/entry.js':{chosen:'./default.js'}
        }
    };
    const source=`<script type="importmap">${JSON.stringify(map)}</script>`;
    const transformed=rewriteAssetReferences(source,{filePath:'index.html',version:'2.3.4'});
    const actual=JSON.parse(transformed.slice(transformed.indexOf('>')+1,transformed.lastIndexOf('</script>')));
    const base='https://example.test/';
    const imports=new Map(Object.entries(actual.imports).map(function normalizedImport([key,value]){
        return [new URL(key,base).href,new URL(value,base).href];
    }));
    assert.equal(imports.get(`${base}alias.js?arcaneVersion=2.3.4`),`${base}selected.js?arcaneVersion=2.3.4`);
    assert.equal(imports.get(`${base}other.js?arcaneVersion=2.3.4`),`${base}other-selected.js?arcaneVersion=2.3.4`);
    const scopes=new Map(Object.entries(actual.scopes).map(function normalizedScope([key,value]){
        return [new URL(key,base).href,value];
    }));
    assert.equal(scopes.get(`${base}entry.js?arcaneVersion=2.3.4`).chosen,'./selected.js?arcaneVersion=2.3.4');
    assert.equal(rewriteAssetReferences(transformed,{filePath:'index.html',version:'2.3.4'}),transformed);
});

test('workspace version drives generated document and map while test paths retain URL queries',async function workspaceVersionProjection(t){
    const workspace=await temporaryDirectory(t);
    assert.equal(await readWorkspaceAssetVersion(workspace),SDK_VERSION);
    await writeFile(path.join(workspace,'arcane.lock.json'),JSON.stringify({sdk:{version:'2.3.4'}}),'utf8');
    await mkdir(path.join(workspace,'arcane','modules'),{recursive:true});
    await writeFile(path.join(workspace,'arcane','modules','State.js'),'export const state=true;','utf8');
    const appRoot=path.join(workspace,'apps','fixture');
    await mkdir(appRoot,{recursive:true});
    await writeFile(path.join(appRoot,'index.html'),'<base href="../../"><script type="module" src="./apps/fixture/entry.js?v=4"></script>','utf8');
    const generated=await generateImportMap({workspaceRoot:workspace,appId:'fixture'});
    assert.equal(generated.imports['arcane/State'],'./arcane/modules/State.js?arcaneVersion=2.3.4');
    assert.ok((await readFile(path.join(appRoot,'index.html'),'utf8')).includes('./apps/fixture/entry.js?v=4&amp;arcaneVersion=2.3.4'));
    const target='./arcane/modules/State.js?v=4&arcaneVersion=2.3.4#part';
    const context=await createApplicationTestImportMapContext({applicationRoot:workspace,imports:{fixture:target}});
    assert.equal(context.imports.fixture,target);
});
