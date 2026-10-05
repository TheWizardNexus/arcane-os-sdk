import assert from 'node:assert/strict';
import {lstat,mkdtemp,mkdir,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from '../src/testing.mjs';
import {repositoryRoot} from './helpers.mjs';
import {
    RELEASE_MANIFEST_NAME,
    discoverApps,
    inspectApp,
    packageApp,
    validateAppConfig,
    validateRootConfig,
    verifyApp
} from '../src/packager/core.mjs';

async function writeJson(filePath,value){
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function workspaceFixture(t,{security,appsRoot='apps',outputDirectory}={}){
    const workspaceRoot=await mkdtemp(path.join(os.tmpdir(),'arcane-packager-content-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const appRoot=appsRoot==='.'?workspaceRoot:path.join(workspaceRoot,'apps','complete-app');
    await Promise.all([
        mkdir(path.join(appRoot,'content'),{recursive:true}),
        mkdir(path.join(workspaceRoot,'runtime','modules'),{recursive:true})
    ]);
    await writeJson(path.join(workspaceRoot,'arcane-packager.json'),{
        schemaVersion:1,
        appsRoot,
        distRoot:'dist',
        sharedPayloads:{
            runtime:[{
                source:'runtime',
                destination:'arcane',
                include:['modules'],
                exclude:[]
            }]
        }
    });
    await writeJson(path.join(appRoot,'arcane-package.json'),{
        schemaVersion:1,
        id:'complete-app',
        displayName:'Complete App',
        version:'1.2.3',
        entry:'index.html',
        strategy:'static',
        ...(outputDirectory===undefined?{}:{outputDirectory}),
        ...(security===undefined?{}:{security}),
        include:['index.html','content'],
        exclude:[],
        shared:['runtime']
    });
    const html='<!doctype html>\n<title>Complete content</title>\n<p>  preserve spacing  </p>\n';
    const document='first line\nsecond line\nthird line with trailing space \n';
    const module='export const complete = `all shared content`;\n';
    await Promise.all([
        writeFile(path.join(appRoot,'index.html'),html),
        writeFile(path.join(appRoot,'content','document.txt'),document),
        writeFile(path.join(workspaceRoot,'runtime','modules','complete.js'),module)
    ]);
    return {workspaceRoot,appRoot,html,document,module};
}

async function nativeResourceFixture(t,appsRoot='.'){
    const fixtures=path.join(repositoryRoot,'.arcane','native-resource-fixtures');
    await mkdir(fixtures,{recursive:true});
    const workspaceRoot=await mkdtemp(path.join(fixtures,'package-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const appRoot=appsRoot==='.'?workspaceRoot:path.join(workspaceRoot,'apps','dragon-desk');
    const appPrefix=appsRoot==='.'?'':'apps/dragon-desk/';
    await Promise.all([
        mkdir(path.join(appRoot,'server','drafts'),{recursive:true}),
        mkdir(path.join(appRoot,'src'),{recursive:true}),
        mkdir(path.join(workspaceRoot,'runtime'),{recursive:true})
    ]);
    const config={schemaVersion:1,id:'dragon-desk',displayName:'Dragon Desk',version:'1.0.0',
        entry:'index.html',strategy:'static',include:['index.html','browser.mjs'],
        exclude:['server','src'],shared:['runtime'],outputDirectory:'public-site',
        nativeResources:{include:['server','src','package.json','browser.mjs'],exclude:['server/drafts','browser.mjs']}};
    const service="import {CORE_PROTOCOL} from 'arcane-os/core/contracts';\r\n"
        +"import {repository} from '../src/repository.mjs';\r\n"
        +"export const greeting = '  Dragon repository 🐉  ';\r\n";
    const document='<base href="./"><script type="importmap">{"imports":{"dragon":"./dragon.mjs"}}</script>'
        +'<script type="module" src="./dragon.mjs?arcaneVersion=keep"></script>\r\n<p>完整内容 </p>\r\n';
    const payload='First dragon\r\n  Second dragon with trailing space \r\n';
    const packageSource='{\n  "name": "dragon-service", "type": "module", "custom": "  retained  "\n}\n';
    await Promise.all([
        writeJson(path.join(workspaceRoot,'arcane-packager.json'),{schemaVersion:1,appsRoot,distRoot:'dist',
            sharedPayloads:{runtime:[{source:'runtime',destination:'arcane',include:['shared.mjs'],exclude:[]}]}}),
        writeJson(path.join(appRoot,'arcane-package.json'),config),
        writeFile(path.join(appRoot,'index.html'),`<!doctype html><base href="${appsRoot==='.'?'./':'../../'}">`
            +`<script type="module" src="./${appPrefix}browser.mjs"></script><p>Dragon desk</p>\n`),
        writeFile(path.join(appRoot,'browser.mjs'),'export const browserReady=true;\n'),
        writeFile(path.join(appRoot,'server','RepositoryService.mjs'),service),
        writeFile(path.join(appRoot,'server','reference.html'),document),
        writeFile(path.join(appRoot,'server','records.dragon'),payload),
        writeFile(path.join(appRoot,'server','drafts','scratch.txt'),'Unselected draft\n'),
        writeFile(path.join(appRoot,'src','repository.mjs'),'export const repository="complete repository";\n'),
        writeFile(path.join(appRoot,'package.json'),packageSource),
        writeFile(path.join(workspaceRoot,'runtime','shared.mjs'),'export const shared=true;\n')
    ]);
    return {workspaceRoot,appRoot,appPrefix,config,service,document,payload,packageSource};
}

test('native selection preserves complete resources and previously emitted browser output in both layouts',async t=>{
    for(const appsRoot of ['.','apps']){
        const fixture=await nativeResourceFixture(t,appsRoot);
        const request={workspaceRoot:fixture.workspaceRoot,appId:'dragon-desk'};
        const browser=await packageApp({...request,moduleFormat:'native'});
        const browserContent=new Map(await Promise.all([...browser.files,RELEASE_MANIFEST_NAME].map(async file=>[
            file,await readFile(path.join(browser.outputRoot,file),'utf8')
        ])));
        assert.equal(browser.output,'public-site');
        assert.equal(browser.files.some(file=>file.includes('/server/')||file.startsWith('server/')),false);
        const inspected=await inspectApp({...request,target:'portable'});
        assert.equal(inspected.output,'dist/.native/portable/dragon-desk');
        assert.equal(inspected.outputDirectory,inspected.output);
        assert.deepEqual(inspected.browserDocuments.map(document=>document.path),['index.html']);
        const native=await packageApp({...request,target:'portable',moduleFormat:'native'});
        assert.equal(native.output,inspected.output);
        for(const [file,content] of [
            ['server/RepositoryService.mjs',fixture.service],['server/reference.html',fixture.document],
            ['server/records.dragon',fixture.payload],['package.json',fixture.packageSource]
        ]){
            assert.equal(await readFile(path.join(native.outputRoot,fixture.appPrefix+file),'utf8'),content);
            assert.equal(await readFile(path.join(fixture.appRoot,file),'utf8'),content);
        }
        assert.ok(native.files.includes(fixture.appPrefix+'src/repository.mjs'));
        assert.ok(native.files.includes(fixture.appPrefix+'browser.mjs'));
        assert.equal(native.files.filter(file=>file===fixture.appPrefix+'browser.mjs').length,1);
        assert.equal(native.files.includes(fixture.appPrefix+'server/drafts/scratch.txt'),false);
        for(const [file,content] of browserContent){
            assert.equal(await readFile(path.join(browser.outputRoot,file),'utf8'),content);
        }
        const verified=await verifyApp({...request,outputDirectory:native.output});
        assert.deepEqual(verified.files,native.files);
    }
});

test('native target context preserves explicit output overrides and omitted or empty selection',async t=>{
    const fixture=await nativeResourceFixture(t);
    const request={workspaceRoot:fixture.workspaceRoot,appId:'dragon-desk',target:'portable'};
    assert.equal((await inspectApp({...request,outputDirectory:'selected-native'})).output,'selected-native');
    for(const nativeResources of [undefined,{include:[]}]){
        const config={...fixture.config};
        if(nativeResources===undefined)delete config.nativeResources;
        else config.nativeResources=nativeResources;
        await writeJson(path.join(fixture.appRoot,'arcane-package.json'),config);
        const inspected=await inspectApp(request);
        assert.equal(inspected.output,'public-site');
        assert.equal(inspected.files.includes('server/RepositoryService.mjs'),false);
    }
    await writeJson(path.join(fixture.appRoot,'arcane-package.json'),fixture.config);
    await assert.rejects(inspectApp({...request,outputDirectory:'server/output'}),/overlaps selected/u);
});

test('package adapters receive the actual target and effective PWA choice without transforming native resources',async t=>{
    const fixture=await nativeResourceFixture(t);
    await mkdir(path.join(fixture.appRoot,'scripts'));
    await writeFile(path.join(fixture.appRoot,'scripts','package.mjs'),
        "import {writeFile} from 'node:fs/promises';\nimport path from 'node:path';\n"
        +"export async function buildArcanePackage({copyBase,outputRoot,target,browserPwa}){\n"
        +"  await copyBase();\n  await writeFile(path.join(outputRoot,'adapter-context.json'),JSON.stringify({target,browserPwa}));\n}\n");
    await writeJson(path.join(fixture.appRoot,'arcane-package.json'),{
        ...fixture.config,strategy:'adapter',adapter:'scripts/package.mjs'
    });
    const request={workspaceRoot:fixture.workspaceRoot,appId:'dragon-desk'};
    const browser=await packageApp({...request,browserPwa:false});
    assert.deepEqual(JSON.parse(await readFile(path.join(browser.outputRoot,'adapter-context.json'),'utf8')),
        {target:'browser',browserPwa:false});
    const native=await packageApp({...request,target:'portable',browserPwa:true});
    assert.deepEqual(JSON.parse(await readFile(path.join(native.outputRoot,'adapter-context.json'),'utf8')),
        {target:'portable',browserPwa:false});
    assert.equal(await readFile(path.join(native.outputRoot,'server/RepositoryService.mjs'),'utf8'),fixture.service);
});

test('selected static package carries one release through entry, modules, Worker and CSS references',async t=>{
    const selected=await workspaceFixture(t);
    const sourceRoot=path.join(selected.workspaceRoot,'runtime','modules');
    const version='8.7.6';
    await writeJson(path.join(selected.workspaceRoot,'arcane.lock.json'),{sdk:{version}});
    const corpus='<base href="./"><script src="./original.js"></script>'
        +'<style>p{background:url(original.svg)}</style><p>Complete supplied HTML</p>';
    await writeFile(path.join(selected.appRoot,'content','document.html'),corpus);
    await writeFile(path.join(selected.appRoot,'index.html'),
        '<!doctype html><base href="../../"><script type="module" src="./arcane/modules/entry.js?v=6&arcaneVersion=old"></script>'
        +'<link rel="stylesheet" href="./arcane/modules/theme.css?theme=day#palette">'
        +'<p>./arcane/modules/entry.js?v=6</p>');
    await writeFile(path.join(sourceRoot,'entry.js'),
        "import './child.js?v=2&arcaneVersion=old';\nnew Worker(new URL('./worker.js?arcaneVersion=old',import.meta.url),{type:'module'});\n");
    await writeFile(path.join(sourceRoot,'child.js'),'export const content="keep all text";\n');
    await writeFile(path.join(sourceRoot,'worker.js'),"import './child.js?v=2&arcaneVersion=old';\n");
    await writeFile(path.join(sourceRoot,'theme.css'),'body{background:url(./icon.svg?color=blue&arcaneVersion=old#mark)}\n');
    await writeFile(path.join(sourceRoot,'icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
    await writeFile(path.join(selected.appRoot,'content','App.js'),"new Worker('./apps/complete-app/content/root-worker.js',{type:'module'});\n");
    await writeFile(path.join(selected.appRoot,'content','root-worker.js'),"import './worker-child.js';\n");
    await writeFile(path.join(selected.appRoot,'content','worker-child.js'),'export const workerReady=true;\n');
    const initialEntry=await readFile(path.join(selected.appRoot,'index.html'),'utf8');
    await writeFile(path.join(selected.appRoot,'index.html'),initialEntry
        +'<script type="module" src="./apps/complete-app/content/App.js"></script>');
    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    const entry=await readFile(path.join(packaged.outputRoot,'apps/complete-app/index.html'),'utf8');
    assert.ok(entry.includes('entry.js?v=6'),entry);
    assert.equal(entry.includes('arcaneVersion='),false);
    assert.ok(entry.includes('theme.css?theme=day#palette'));
    assert.ok(entry.includes('<p>./arcane/modules/entry.js?v=6</p>'));
    const module=await readFile(path.join(packaged.outputRoot,'arcane/modules/entry.js'),'utf8');
    assert.ok(module.includes('child.js?v=2'),module);
    assert.ok(module.includes('worker.js'));
    assert.equal(module.includes('arcaneVersion='),false);
    const worker=await readFile(path.join(packaged.outputRoot,'arcane/modules/worker.js'),'utf8');
    assert.ok(worker.includes('child.js?v=2'),worker);
    assert.equal(worker.includes('arcaneVersion='),false);
    const style=await readFile(path.join(packaged.outputRoot,'arcane/modules/theme.css'),'utf8');
    assert.ok(style.includes('icon.svg?color=blue#mark'));
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps/complete-app/content/document.html'),'utf8'),corpus);
    assert.ok((await readFile(path.join(packaged.outputRoot,'apps/complete-app/content/root-worker.js'),'utf8'))
        .includes('worker-child.js'));
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps/complete-app/content/document.txt'),'utf8'),selected.document);
});

test('packager materializes every selected app and shared file with complete content',async t=>{
    const selected=await workspaceFixture(t);
    assert.deepEqual(await discoverApps({workspaceRoot:selected.workspaceRoot}),['complete-app']);
    const inspected=await inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(inspected.files,[
        'apps/complete-app/content/document.txt',
        'apps/complete-app/index.html',
        'arcane/modules/complete.js',
        'index.html'
    ]);

    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(packaged.files,inspected.files);
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps/complete-app/index.html'),'utf8'),selected.html);
    assert.equal(await readFile(
        path.join(packaged.outputRoot,'apps','complete-app','content','document.txt'),
        'utf8'
    ),selected.document);
    assert.equal(await readFile(
        path.join(packaged.outputRoot,'arcane','modules','complete.js'),
        'utf8'
    ),selected.module);

    const release=JSON.parse(await readFile(
        path.join(packaged.outputRoot,RELEASE_MANIFEST_NAME),
        'utf8'
    ));
    assert.deepEqual(release.files,inspected.files);
    assert.equal(release.app.id,'complete-app');
    assert.equal(release.app.version,'1.2.3');
    assert.equal(release.app.entry,'index.html');
    assert.equal(release.app.start,'./apps/complete-app/index.html');
    const launcher=await readFile(path.join(packaged.outputRoot,'index.html'),'utf8');
    assert.ok(launcher.includes('url=./apps/complete-app/index.html'));
    assert.ok(launcher.includes('href="./apps/complete-app/index.html"'));

    const verified=await verifyApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.equal(verified.verified,true);
    assert.deepEqual(verified.files,inspected.files);
});

test('standalone root discovery selects the declared id and packages complete content without an apps prefix',async function standaloneRootPackage(t){
    const selected=await workspaceFixture(t,{appsRoot:'.'});
    const nestedAppRoot=path.join(selected.workspaceRoot,'apps','unrelated-app');
    await mkdir(nestedAppRoot,{recursive:true});
    await writeJson(path.join(nestedAppRoot,'arcane-package.json'),{id:'unrelated-app'});
    assert.deepEqual(await discoverApps({workspaceRoot:selected.workspaceRoot}),['complete-app']);
    await assert.rejects(
        inspectApp({workspaceRoot:selected.workspaceRoot,appId:'unrelated-app'}),
        /id must be a valid application id matching the selected application/u
    );
    const inspected=await inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(inspected.files,[
        'arcane/modules/complete.js','content/document.txt','index.html'
    ]);
    assert.equal(inspected.output,'dist/complete-app');
    assert.deepEqual(inspected.browserDocuments.map(function appDocument(document){
        return {path:document.path,packagePath:document.packagePath};
    }),[{path:'index.html',packagePath:'index.html'}]);
    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.equal(packaged.manifest.app.start,'./index.html');
    assert.deepEqual(packaged.files,inspected.files);
    assert.equal(await readFile(path.join(packaged.outputRoot,'index.html'),'utf8'),selected.html);
    assert.equal(await readFile(path.join(packaged.outputRoot,'content/document.txt'),'utf8'),selected.document);
    assert.equal(await readFile(path.join(packaged.outputRoot,'arcane/modules/complete.js'),'utf8'),selected.module);
    await assert.rejects(lstat(path.join(packaged.outputRoot,'apps')), {code:'ENOENT'});
    assert.equal(await readFile(path.join(selected.appRoot,'index.html'),'utf8'),selected.html);
    const verified=await verifyApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.equal(verified.verified,true);
    assert.deepEqual(verified.files,inspected.files);
});

test('standalone nested pages retain their bases and shared HTML stays outside app document discovery',async function standaloneNestedDocuments(t){
    const selected=await workspaceFixture(t,{appsRoot:'.'});
    const configPath=path.join(selected.appRoot,'arcane-package.json');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    config.entry='pages/review.html';
    config.include=['pages','modules','content'];
    await writeJson(configPath,config);
    await Promise.all([
        mkdir(path.join(selected.appRoot,'pages')),
        mkdir(path.join(selected.appRoot,'modules'))
    ]);
    const page='<!doctype html><base href="../">'
        +'<script type="module" src="./modules/App.js"></script>'
        +'<script type="module" src="./arcane/modules/complete.js"></script>'
        +'<p>  Complete nested page content  </p>\n';
    const fragment='<p>  Complete fragment without a document base  </p>\n';
    const sharedPage='<!doctype html><base href="./"><p>Shared content is not an app page.</p>\n';
    const appModule="import '../arcane/modules/complete.js';\n";
    await Promise.all([
        writeFile(path.join(selected.appRoot,'pages/review.html'),page),
        writeFile(path.join(selected.appRoot,'pages/other.htm'),page),
        writeFile(path.join(selected.appRoot,'content/fragment.html'),fragment),
        writeFile(path.join(selected.appRoot,'modules/App.js'),appModule),
        writeFile(path.join(selected.workspaceRoot,'runtime/modules/shared.html'),sharedPage)
    ]);
    const inspected=await inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(inspected.browserDocuments.map(function documentPath(document){
        return {path:document.path,packagePath:document.packagePath};
    }),[
        {path:'pages/review.html',packagePath:'pages/review.html'},
        {path:'pages/other.htm',packagePath:'pages/other.htm'}
    ]);
    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.equal(packaged.manifest.app.start,'./pages/review.html');
    const launcher=await readFile(path.join(packaged.outputRoot,'index.html'),'utf8');
    assert.ok(launcher.includes('url=./pages/review.html'));
    const mount=new URL('https://example.test/releases/standalone/');
    for(const relative of ['pages/review.html','pages/other.htm']){
        const content=await readFile(path.join(packaged.outputRoot,relative),'utf8');
        assert.ok(content.includes('<p>  Complete nested page content  </p>\n'));
        assert.equal(await readFile(path.join(selected.appRoot,relative),'utf8'),page);
        const base=new URL(content.match(/<base href="([^"]+)">/u)[1],new URL(relative,mount));
        assert.equal(base.href,mount.href);
        for(const match of content.matchAll(/src="([^"]+)"/gu)){
            const resource=new URL(match[1],base);
            assert.ok(packaged.files.includes(resource.pathname.slice(mount.pathname.length)));
        }
    }
    assert.equal(await readFile(path.join(selected.appRoot,'modules/App.js'),'utf8'),appModule);
    const packagedModule=await readFile(path.join(packaged.outputRoot,'modules/App.js'),'utf8');
    assert.equal(new URL(packagedModule.match(/import '([^']+)'/u)[1],new URL('modules/App.js',mount)).pathname,
        new URL('arcane/modules/complete.js',mount).pathname);
    assert.equal(await readFile(path.join(packaged.outputRoot,'content/fragment.html'),'utf8'),fragment);
    assert.equal(await readFile(path.join(packaged.outputRoot,'arcane/modules/shared.html'),'utf8'),sharedPage);
    assert.equal(await readFile(path.join(selected.appRoot,'index.html'),'utf8'),selected.html);
});

test('standalone app and shared routes report a real destination collision without replacing either source',async function standaloneDestinationCollision(t){
    const selected=await workspaceFixture(t,{appsRoot:'.'});
    const configPath=path.join(selected.appRoot,'arcane-package.json');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    config.include.push('arcane');
    await writeJson(configPath,config);
    await mkdir(path.join(selected.appRoot,'arcane/modules'),{recursive:true});
    const authored='export const authored = "complete app-owned content";\n';
    await writeFile(path.join(selected.appRoot,'arcane/modules/complete.js'),authored);
    await assert.rejects(
        packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'}),
        /Package destination collision: arcane\/modules\/complete\.js/u
    );
    assert.equal(await readFile(path.join(selected.appRoot,'arcane/modules/complete.js'),'utf8'),authored);
    assert.equal(await readFile(path.join(selected.workspaceRoot,'runtime/modules/complete.js'),'utf8'),selected.module);
});

test('shared directory roots preserve descendant routes, exclusions and complete content',async function sharedDirectoryRoots(t){
    const selected=await workspaceFixture(t);
    const configPath=path.join(selected.workspaceRoot,'arcane-packager.json');
    const config=JSON.parse(await readFile(configPath,'utf8'));
    const browserSource='node_modules/arcane-os/browser-runtime';
    const dependencySource='node_modules/arcane-os/runtime/strong-type';
    const rootSource='node_modules/arcane-os/package-notes';
    const browserRoot=path.join(selected.workspaceRoot,browserSource);
    const dependencyRoot=path.join(selected.workspaceRoot,dependencySource);
    const notesRoot=path.join(selected.workspaceRoot,rootSource);
    await Promise.all([
        mkdir(path.join(browserRoot,'ai','excluded'),{recursive:true}),
        mkdir(path.join(dependencyRoot,'types'),{recursive:true}),
        mkdir(notesRoot,{recursive:true})
    ]);
    const runtime='export const runtime = "  complete browser runtime  ";\n';
    const nested='export const provider = "all provider content";\n';
    const dependency='export const predicate = value => value;\n';
    const note='  Complete package note\nwith a trailing space \n';
    await Promise.all([
        writeFile(path.join(browserRoot,'entry.mjs'),runtime),
        writeFile(path.join(browserRoot,'ai','provider.mjs'),nested),
        writeFile(path.join(browserRoot,'ai','excluded','private.txt'),'explicitly excluded'),
        writeFile(path.join(browserRoot,'omit.txt'),'explicitly excluded'),
        writeFile(path.join(dependencyRoot,'types','predicate.js'),dependency),
        writeFile(path.join(notesRoot,'package-note.txt'),note)
    ]);
    config.sharedPayloads.runtime.push(
        {source:browserSource,destination:'arcane/sdk',include:['.'],exclude:['ai/excluded','omit.txt']},
        {source:dependencySource,destination:'arcane/dependencies/strong-type',include:['.'],exclude:[]},
        {source:rootSource,destination:'.',include:['.'],exclude:[]}
    );
    await writeJson(configPath,config);

    const inspected=await inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(inspected.files,[
        'apps/complete-app/content/document.txt',
        'apps/complete-app/index.html',
        'arcane/dependencies/strong-type/types/predicate.js',
        'arcane/modules/complete.js',
        'arcane/sdk/ai/provider.mjs',
        'arcane/sdk/entry.mjs',
        'index.html',
        'package-note.txt'
    ]);
    assert.equal(inspected.files.some(function containsRootMarker(file){return file.startsWith('./')||file.includes('/./');}),false);
    const packaged=await packageApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'});
    assert.deepEqual(packaged.files,inspected.files);
    for(const [relative,content] of [
        ['apps/complete-app/content/document.txt',selected.document],
        ['arcane/modules/complete.js',selected.module],
        ['arcane/sdk/entry.mjs',runtime],
        ['arcane/sdk/ai/provider.mjs',nested],
        ['arcane/dependencies/strong-type/types/predicate.js',dependency],
        ['package-note.txt',note]
    ]){
        assert.equal(await readFile(path.join(packaged.outputRoot,relative),'utf8'),content);
    }
    assert.equal(await readFile(path.join(browserRoot,'entry.mjs'),'utf8'),runtime);

    const rootConfig=validateRootConfig(config);
    const appConfig=JSON.parse(await readFile(path.join(selected.appRoot,'arcane-package.json'),'utf8'));
    assert.throws(function appRootSelectionRemainsUnsupported(){
        validateAppConfig({...appConfig,include:['.']},'complete-app',rootConfig);
    },/Unsafe .*include/u);
    assert.throws(function overlappingSharedRootSelection(){
        validateRootConfig({...config,sharedPayloads:{runtime:[{
            source:browserSource,destination:'arcane/sdk',include:['.','ai'],exclude:[]
        }]}});
    },/overlapping paths/u);
    config.sharedPayloads.runtime.push({
        source:browserSource,destination:'arcane/sdk',include:['entry.mjs'],exclude:[]
    });
    await writeJson(configPath,config);
    await assert.rejects(
        inspectApp({workspaceRoot:selected.workspaceRoot,appId:'complete-app'}),
        /Package destination collision: arcane\/sdk\/entry\.mjs/u
    );
});

test(
    'scaffold-style pages resolve app and SDK resources inside a package mounted below the origin root',
    async function packagedWorkspaceRoutes(context) {
        const selected = await workspaceFixture(context);
        const configPath = path.join(selected.appRoot, 'arcane-package.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.entry = 'pages/review.html';
        config.include = ['index.html', 'manifest.json', 'app.css', 'modules', 'pages', 'content'];
        await writeJson(configPath, config);
        await Promise.all(
            [
                mkdir(path.join(selected.appRoot, 'modules')),
                mkdir(path.join(selected.appRoot, 'pages'))
            ]
        );
        const source = '<!doctype html><html><head><base href="../../">'
            + '<link rel="manifest" href="./apps/complete-app/manifest.json">'
            + '<link rel="stylesheet" href="./apps/complete-app/app.css">'
            + '<script type="module" src="./arcane/modules/complete.js"></script>'
            + '</head><body><p>Preserve ./apps/complete-app/app.css in this text.</p>'
            + '<script type="module" src="./apps/complete-app/modules/App.js"></script>'
            + '</body></html>\n';
        const nestedSource = source.replace('<base href="../../">', '<base href="../../../">');
        const manifest = '{"name":"Complete App","start_url":"./index.html"}\n';
        await Promise.all(
            [
                writeFile(path.join(selected.appRoot, 'index.html'), source),
                writeFile(path.join(selected.appRoot, 'pages/review.html'), nestedSource),
                writeFile(path.join(selected.appRoot, 'manifest.json'), manifest),
                writeFile(path.join(selected.appRoot, 'app.css'), 'body { background: url(./content/icon.svg); }\n'),
                writeFile(path.join(selected.appRoot, 'content/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n'),
                writeFile(path.join(selected.appRoot, 'modules/App.js'), "import '../../../arcane/modules/complete.js';\n")
            ]
        );
        const inspected = await inspectApp(
            {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'}
        );
        assert.deepEqual(
            inspected.browserDocuments.map(
                function selectedDocumentPaths(document) {
                    return {path: document.path, packagePath: document.packagePath};
                }
            ),
            [
                {path: 'pages/review.html', packagePath: 'apps/complete-app/pages/review.html'},
                {path: 'index.html', packagePath: 'apps/complete-app/index.html'}
            ]
        );
        const packaged = await packageApp(
            {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'}
        );
        const mount = new URL('https://example.test/catalog/deep/portable-release/');
        assert.equal(packaged.manifest.app.entry, 'pages/review.html');
        assert.equal(
            new URL(packaged.manifest.app.start, mount).pathname,
            '/catalog/deep/portable-release/apps/complete-app/pages/review.html'
        );
        const launcher = await readFile(path.join(packaged.outputRoot, 'index.html'), 'utf8');
        assert.ok(launcher.includes('url=./apps/complete-app/pages/review.html'));
        for (const relative of ['apps/complete-app/index.html', 'apps/complete-app/pages/review.html']) {
            const page = await readFile(path.join(packaged.outputRoot, relative), 'utf8');
            const pageUrl = new URL(relative, mount);
            const base = new URL(page.match(/<base href="([^"]+)">/u)[1], pageUrl);
            assert.equal(base.href, mount.href);
            const resourceReferences = [...page.matchAll(/(?:src|href)="(\.\/(?:apps|arcane)\/[^"]+)"/gu)];
            assert.equal(resourceReferences.length, 4);
            for (const match of resourceReferences) {
                const target = new URL(match[1], base);
                assert.ok(target.pathname.startsWith(mount.pathname));
                assert.ok(packaged.files.includes(target.pathname.slice(mount.pathname.length)));
            }
            assert.ok(page.includes('<p>Preserve ./apps/complete-app/app.css in this text.</p>'));
        }
        const appModule = await readFile(
            path.join(packaged.outputRoot, 'apps/complete-app/modules/App.js'),
            'utf8'
        );
        const dependency = appModule.match(/import '([^']+)'/u)[1];
        assert.equal(
            new URL(dependency, new URL('apps/complete-app/modules/App.js', mount)).pathname,
            new URL('arcane/modules/complete.js', mount).pathname
        );
        const stylesheet = await readFile(
            path.join(packaged.outputRoot, 'apps/complete-app/app.css'),
            'utf8'
        );
        const image = stylesheet.match(/url\(([^)]+)\)/u)[1];
        assert.equal(
            new URL(image, new URL('apps/complete-app/app.css', mount)).pathname,
            new URL('apps/complete-app/content/icon.svg', mount).pathname
        );
        assert.equal(await readFile(path.join(selected.appRoot, 'index.html'), 'utf8'), source);
        assert.equal(await readFile(path.join(selected.appRoot, 'pages/review.html'), 'utf8'), nestedSource);
        assert.equal(await readFile(path.join(packaged.outputRoot, 'apps/complete-app/manifest.json'), 'utf8'), manifest);
    }
);

test('ordinary app packaging permits omitted security and preserves an explicit record',async t=>{
    const ordinary=await workspaceFixture(t);
    const ordinaryResult=await packageApp({
        workspaceRoot:ordinary.workspaceRoot,
        appId:'complete-app'
    });
    assert.equal(Object.hasOwn(ordinaryResult.manifest.app,'security'),false);

    const explicit=await workspaceFixture(t,{
        security:{connectOrigins:['https://example.test']}
    });
    const explicitResult=await packageApp({
        workspaceRoot:explicit.workspaceRoot,
        appId:'complete-app'
    });
    assert.deepEqual(explicitResult.manifest.app.security,{
        connectOrigins:['https://example.test']
    });
});

test('dry-run returns the complete structural inventory without creating release output',async t=>{
    const selected=await workspaceFixture(t);
    const result=await packageApp({
        workspaceRoot:selected.workspaceRoot,
        appId:'complete-app',
        dryRun:true
    });
    assert.equal(result.dryRun,true);
    assert.deepEqual(result.files,[
        'apps/complete-app/content/document.txt',
        'apps/complete-app/index.html',
        'arcane/modules/complete.js',
        'index.html'
    ]);
});

test(
    'app outputDirectory selects the final workspace directory without changing identity or package layout',
    async function selectedPackageDirectory(context) {
        for (const appsRoot of ['.', 'apps']) {
            const selected = await workspaceFixture(context, {appsRoot});
            const request = {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'};
            const defaultPackage = await packageApp(request);
            assert.equal(defaultPackage.output, 'dist/complete-app');
            assert.equal(defaultPackage.outputRoot, path.join(selected.workspaceRoot, 'dist', 'complete-app'));
            const defaultManifest = await readFile(
                path.join(defaultPackage.outputRoot, RELEASE_MANIFEST_NAME),
                'utf8'
            );
            const configPath = path.join(selected.appRoot, 'arcane-package.json');
            const config = JSON.parse(await readFile(configPath, 'utf8'));
            config.outputDirectory = 'ai';
            await writeJson(configPath, config);
            const outputRoot = path.join(selected.workspaceRoot, 'ai');
            const siblingPath = path.join(selected.workspaceRoot, 'ai-notes.txt');
            const sibling = '  Preserve the sibling and its complete notes.\n';
            await writeFile(siblingPath, sibling);

            const inspected = await inspectApp(request);
            assert.equal(inspected.output, 'ai');
            assert.deepEqual(inspected.files, defaultPackage.files);
            const dryRun = await packageApp({...request, dryRun: true});
            assert.equal(dryRun.output, 'ai');
            await assert.rejects(lstat(outputRoot), {code: 'ENOENT'});

            const first = await packageApp(request);
            assert.equal(first.output, 'ai');
            assert.equal(first.outputRoot, outputRoot);
            assert.deepEqual(first.manifest.app, defaultPackage.manifest.app);
            assert.deepEqual(first.files, defaultPackage.files);
            await assert.rejects(lstat(path.join(outputRoot, 'complete-app')), {code: 'ENOENT'});
            const entry = appsRoot === '.' ? 'index.html' : 'apps/complete-app/index.html';
            const document = appsRoot === '.' ? 'content/document.txt' : 'apps/complete-app/content/document.txt';
            assert.equal(await readFile(path.join(outputRoot, entry), 'utf8'), selected.html);
            const replacement = '  Updated complete document.\nSecond line and trailing space \n';
            await writeFile(path.join(selected.appRoot, 'content/document.txt'), replacement);
            const repeated = await packageApp(request);
            assert.equal(repeated.outputRoot, outputRoot);
            assert.deepEqual(repeated.files, first.files);
            assert.equal(await readFile(path.join(outputRoot, document), 'utf8'), replacement);
            const verified = await verifyApp(request);
            assert.equal(verified.outputRoot, outputRoot);
            assert.equal(verified.verified, true);
            assert.equal(await readFile(path.join(defaultPackage.outputRoot, RELEASE_MANIFEST_NAME), 'utf8'), defaultManifest);
            assert.equal(await readFile(siblingPath, 'utf8'), sibling);
            assert.equal(await readFile(path.join(selected.appRoot, 'index.html'), 'utf8'), selected.html);

            const completedManifest = await readFile(path.join(outputRoot, RELEASE_MANIFEST_NAME), 'utf8');
            await mkdir(path.join(selected.appRoot, 'scripts'), {recursive: true});
            await writeFile(
                path.join(selected.appRoot, 'scripts/fail-package.mjs'),
                'export async function buildArcanePackage({copyBase}) {\n'
                    + '    await copyBase();\n'
                    + '    throw new Error("Synthetic adapter failed after copying the stage.");\n'
                    + '}\n'
            );
            config.strategy = 'adapter';
            config.adapter = 'scripts/fail-package.mjs';
            await writeJson(configPath, config);
            await assert.rejects(
                packageApp(request),
                /Synthetic adapter failed after copying the stage\./u
            );
            assert.equal(await readFile(path.join(outputRoot, RELEASE_MANIFEST_NAME), 'utf8'), completedManifest);
            assert.equal(await readFile(path.join(outputRoot, document), 'utf8'), replacement);
            assert.equal(await readFile(siblingPath, 'utf8'), sibling);
            assert.equal(JSON.parse(await readFile(configPath, 'utf8')).version, '1.2.3');
            assert.deepEqual(
                (await readdir(selected.workspaceRoot)).filter(
                    function packageTransactionResidue(name) {
                        return name.startsWith('.complete-app-staging-') || name.startsWith('ai.backup-');
                    }
                ),
                []
            );
        }
    }
);

test(
    'a selected parent with an explicit output exclusion supports repeat packaging without copying its stage',
    async function excludedNestedPackageOutput(context) {
        const selected = await workspaceFixture(context, {appsRoot: '.', outputDirectory: 'content/ai'});
        const configPath = path.join(selected.appRoot, 'arcane-package.json');
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.exclude = ['content/ai'];
        await writeJson(configPath, config);
        const outputRoot = path.join(selected.workspaceRoot, 'content/ai');
        await mkdir(outputRoot);
        await writeFile(path.join(outputRoot, 'old-output.txt'), 'Previous selected output.\n');
        const request = {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'};
        const first = await packageApp(request);
        const second = await packageApp(request);
        assert.equal(second.outputRoot, outputRoot);
        assert.deepEqual(second.files, first.files);
        assert.ok(second.files.includes('content/document.txt'));
        assert.equal(
            second.files.some(
                function includesPackageTransaction(file) {
                    return file.startsWith('content/ai/') || file.includes('-staging-') || file.includes('.backup-');
                }
            ),
            false
        );
        assert.equal(await readFile(path.join(outputRoot, 'content/document.txt'), 'utf8'), selected.document);
        assert.equal(await readFile(path.join(selected.appRoot, 'content/document.txt'), 'utf8'), selected.document);
        await assert.rejects(lstat(path.join(outputRoot, 'old-output.txt')), {code: 'ENOENT'});
        assert.deepEqual((await readdir(path.dirname(outputRoot))).sort(), ['ai', 'document.txt']);
    }
);

test(
    'output conflicts preserve selected inputs and existing targets before staging or replacement',
    async function packageOutputConflicts(context) {
        for (const outputDirectory of [
            'content', 'content/new-output', 'runtime', 'runtime/modules/new-output',
            'arcane-package.json', 'blocked', 'blocked/ai'
        ]) {
            const selected = await workspaceFixture(context, {appsRoot: '.', outputDirectory});
            const blocked = '  Existing non-directory destination.\n';
            const blockedPath = path.join(selected.workspaceRoot, 'blocked');
            await writeFile(blockedPath, blocked);
            const configPath = path.join(selected.appRoot, 'arcane-package.json');
            const authoredConfig = await readFile(configPath, 'utf8');
            await assert.rejects(
                packageApp({workspaceRoot: selected.workspaceRoot, appId: 'complete-app'}),
                function selectedOutputConflict(error) {
                    return error?.code === 'ARCANE_PACKAGE_INVALID';
                },
                outputDirectory
            );
            assert.equal(await readFile(configPath, 'utf8'), authoredConfig);
            assert.equal(await readFile(path.join(selected.appRoot, 'index.html'), 'utf8'), selected.html);
            assert.equal(await readFile(path.join(selected.appRoot, 'content/document.txt'), 'utf8'), selected.document);
            assert.equal(await readFile(path.join(selected.workspaceRoot, 'runtime/modules/complete.js'), 'utf8'), selected.module);
            assert.equal(await readFile(blockedPath, 'utf8'), blocked);
            assert.deepEqual((await readdir(path.join(selected.appRoot, 'content'))).sort(), ['document.txt']);
            assert.deepEqual((await readdir(path.join(selected.workspaceRoot, 'runtime/modules'))).sort(), ['complete.js']);
            assert.equal(
                (await readdir(selected.workspaceRoot)).some(
                    function hasUnexpectedStage(name) {
                        return name.includes('-staging-') || name.includes('.backup-');
                    }
                ),
                false
            );
        }
    }
);

test(
    'an app-selected output cannot replace an unselected application or its source directory',
    async function neighboringApplicationOutput(context) {
        for (const outputDirectory of ['apps/neighbor-app', 'apps/neighbor-app/generated']) {
            const selected = await workspaceFixture(context);
            const request = {workspaceRoot: selected.workspaceRoot, appId: 'complete-app'};
            const previous = await packageApp(request);
            const previousManifest = await readFile(path.join(previous.outputRoot, RELEASE_MANIFEST_NAME), 'utf8');
            const configPath = path.join(selected.appRoot, 'arcane-package.json');
            const config = JSON.parse(await readFile(configPath, 'utf8'));
            const neighborRoot = path.join(selected.workspaceRoot, 'apps/neighbor-app');
            await mkdir(neighborRoot);
            const neighborConfig = `${JSON.stringify({...config, id: 'neighbor-app'}, null, 2)}\n`;
            const neighborPage = '<main>Keep this unselected application and all its content.</main>\n';
            await Promise.all([
                writeFile(path.join(neighborRoot, 'arcane-package.json'), neighborConfig),
                writeFile(path.join(neighborRoot, 'index.html'), neighborPage)
            ]);
            config.outputDirectory = outputDirectory;
            await writeJson(configPath, config);
            await assert.rejects(
                packageApp(request),
                function neighboringAppConflict(error) {
                    return error?.code === 'ARCANE_PACKAGE_INVALID';
                }
            );
            assert.equal(await readFile(path.join(neighborRoot, 'arcane-package.json'), 'utf8'), neighborConfig);
            assert.equal(await readFile(path.join(neighborRoot, 'index.html'), 'utf8'), neighborPage);
            assert.deepEqual((await readdir(neighborRoot)).sort(), ['arcane-package.json', 'index.html']);
            assert.equal(await readFile(path.join(previous.outputRoot, RELEASE_MANIFEST_NAME), 'utf8'), previousManifest);
            assert.equal(await readFile(path.join(previous.outputRoot, 'apps/complete-app/content/document.txt'), 'utf8'), selected.document);
            assert.equal(await readFile(path.join(selected.appRoot, 'content/document.txt'), 'utf8'), selected.document);
            assert.deepEqual((await readdir(path.join(selected.workspaceRoot, 'apps'))).sort(), ['complete-app', 'neighbor-app']);
        }
    }
);
