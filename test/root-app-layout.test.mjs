import assert from 'node:assert/strict';
import {mkdir,readFile,stat,unlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {inspectApp,packageApp,validateRootConfig} from '../src/packager/core.mjs';
import {installedSdkRoutes} from '../src/sdk-runtime-layout.mjs';
import {createToolchain} from '../src/toolchain.mjs';
import {temporaryDirectory} from './helpers.mjs';

async function writeText(root,relative,content){
    const filePath=path.join(root,...relative.split('/'));
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,content,'utf8');
}

async function writeJson(root,relative,value){
    await writeText(root,relative,`${JSON.stringify(value,null,2)}\n`);
}

async function rootFixture(context,dependencyName,{manifestId}={}){
    const workspaceRoot=await temporaryDirectory(context,{prefix:'arcane-root-layout-'});
    const appId='root-app';
    const packageSource=`node_modules/${dependencyName}`;
    const packageRoot=path.join(workspaceRoot,...packageSource.split('/'));
    const sdkVersion='9.8.7';
    const manifest={
        schemaVersion:1,id:appId,displayName:'The Root Vegetable Tribunal',version:'1.2.3',
        entry:'pages/review.html',strategy:'static',
        include:['index.html','app.css','modules','pages','content'],exclude:[],shared:['browser-runtime'],
        pwa:{enabled:true,manifest:manifestId===undefined?{}:{id:manifestId}}
    };
    function page(base){
        return '<!doctype html><html lang="en"><head>'
            +`<meta name="arcane-app-id" content="${appId}"><base href="${base}">`
            +`<link rel="stylesheet" href="./${packageSource}/runtime/arcane/css/theme.css">`
            +`<link rel="stylesheet" href="./${packageSource}/runtime/arcane/css/primitives.css">`
            +'<link rel="stylesheet" href="./app.css">'
            +'<script type="importmap" data-arcane-import-map>{"imports":{}}</script>'
            +'</head><body><main>  The turnips retain every word.  </main>'
            +'<script type="module" src="./modules/App.js"></script></body></html>\n';
    }
    const fragment='<section>  Complete retained fragment\nwith trailing space \n</section>\n';
    const module="import 'arcane-os/modules/ThemeBootstrap.js';\nexport const verdict = '  Keep the complete testimony.  ';\n";
    await Promise.all([
        writeJson(workspaceRoot,'package.json',{
            name:'root-app-consumer',private:true,type:'module',
            dependencies:{[dependencyName]:dependencyName==='arcane-os'?sdkVersion:`npm:arcane-os@${sdkVersion}`}
        }),
        writeJson(workspaceRoot,'arcane-packager.json',{
            schemaVersion:1,appsRoot:'.',distRoot:'dist',
            sharedPayloads:{'browser-runtime':installedSdkRoutes(packageSource,{direct:true})}
        }),
        writeJson(workspaceRoot,'arcane-package.json',manifest),
        writeJson(packageRoot,'package.json',{name:'arcane-os',version:sdkVersion,type:'module'}),
        writeText(workspaceRoot,'index.html',page('./')),
        writeText(workspaceRoot,'pages/review.html',page('../')),
        writeText(workspaceRoot,'pages/other.htm',page('../')),
        writeText(workspaceRoot,'content/fragment.html',fragment),
        writeText(workspaceRoot,'modules/App.js',module),
        writeText(workspaceRoot,'app.css','main { display: block; white-space: pre-wrap; }\n')
    ]);
    const resources=new Map([
        ['runtime/arcane/components/panel.html','<section>  Complete shared panel  </section>\n'],
        ['runtime/arcane/css/theme.css',':root { --theme: initial; }\n'],
        ['runtime/arcane/css/primitives.css','button { font: inherit; }\n'],
        ['runtime/arcane/entities/Record.js','export default class Record {}\n'],
        ['runtime/arcane/img/icon.svg','<svg xmlns="http://www.w3.org/2000/svg"/>\n'],
        ['runtime/arcane/modules/ThemeBootstrap.js','export default function ThemeBootstrap() {}\n'],
        ['browser-runtime/event-manager.mjs','export const canonicalEvents = true;\n'],
        ['browser-runtime/pwa.mjs','export function registerPwa() {}\nexport function mountPwaInstallPrompt() {}\n'],
        ['browser-runtime/ai/provider.mjs','export const provider = "Complete provider text";\n'],
        ['runtime/strong-type/index.js','export default function Is() {}\n'],
        ['runtime/strong-type/types/string.js','export const stringType = true;\n'],
        ['LICENSE','Complete synthetic SDK license\n'],
        ['COMMERCIAL-LICENSE.md','Complete synthetic commercial license\n'],
        ['NOTICE','Complete synthetic SDK notice\n']
    ]);
    await Promise.all([...resources].map(async function writeInstalledFile([relative,content]){
        await writeText(packageRoot,relative,content);
    }));
    const rootConfig=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-packager.json'),'utf8'));
    assert.equal(validateRootConfig(rootConfig).appsRoot,'.');
    return {workspaceRoot,appId,packageSource,packageRoot,sdkVersion,manifest,fragment,module,resources};
}

for(const dependencyName of ['arcane-os','arcane-sdk']){
    test(`root ${dependencyName} import-map emits direct static PWA files at the application root`,async function rootStaticPwa(context){
        const manifestId=dependencyName==='arcane-sdk'?'/retained-installation/':undefined;
        const fixture=await rootFixture(context,dependencyName,{manifestId});
        const {workspaceRoot,appId,packageSource}=fixture;
        const toolchain=createToolchain({workspaceRoot,appId});
        const themeUrl=`./${packageSource}/runtime/arcane/modules/ThemeBootstrap.js`;
        await writeJson(workspaceRoot,'arcane-package.json',{
            ...fixture.manifest,pwa:{...fixture.manifest.pwa,enabled:false}
        });
        const ordinary=await toolchain.importMap({});
        for(const specifier of ['arcane-os/modules/ThemeBootstrap.js',themeUrl]){
            assert.equal(ordinary.importMap.imports[specifier],themeUrl,specifier);
        }
        assert.equal(Object.keys(ordinary.importMap.imports).some(function obsoleteRootSpecifier(specifier){
            return specifier.startsWith('arcane/')||specifier.startsWith('./arcane/');
        }),false);
        assert.equal(ordinary.importMap.imports['arcane-os/entities/Record.js'],
            `./${packageSource}/runtime/arcane/entities/Record.js`);
        await writeJson(workspaceRoot,'arcane-package.json',fixture.manifest);
        const result=await toolchain.importMap({});
        assert.equal(result.importMap.committed,true);
        for(const specifier of ['arcane-os/modules/ThemeBootstrap.js',themeUrl]){
            assert.equal(result.importMap.imports[specifier],themeUrl,specifier);
        }
        assert.equal(Object.keys(result.importMap.imports).some(function obsoleteRootSpecifier(specifier){
            return specifier.startsWith('arcane/')||specifier.startsWith('./arcane/');
        }),false);
        assert.equal(result.importMap.imports['arcane-os/entities/Record.js'],
            `./${packageSource}/runtime/arcane/entities/Record.js`);
        assert.equal(result.importMap.imports['arcane-os/event-manager'],
            `./${packageSource}/browser-runtime/event-manager.mjs`);
        assert.equal(result.importMap.imports['strong-type'],
            `./${packageSource}/runtime/strong-type/index.js`);
        const manifest=JSON.parse(await readFile(path.join(workspaceRoot,'arcane.webmanifest'),'utf8'));
        assert.equal(manifest.id,manifestId??'/apps/root-app/');
        assert.equal(manifest.scope,'/');
        assert.equal(manifest.start_url,'/pages/review.html');
        const offline=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-offline.json'),'utf8'));
        assert.equal(offline.appId,appId);
        assert.equal(offline.sdkVersion,fixture.sdkVersion);
        assert.equal(offline.mode,'development');
        assert.equal(offline.revision,'development');
        assert.deepEqual(offline.navigationAliases,{});
        for(const resource of fixture.resources.keys())assert.ok(offline.assets.includes(`/${packageSource}/${resource}`));
        assert.ok(offline.assets.includes('/modules/arcane.importmap.json'));
        assert.ok(offline.assets.includes('/content/fragment.html'));
        assert.equal(offline.assets.includes(`/${packageSource}/package.json`),false);
        await assert.rejects(stat(path.join(workspaceRoot,'apps')),{code:'ENOENT'});
        assert.equal(offline.assets.some(function nestedAppAsset(asset){return asset.startsWith('/apps/');}),false);
        const bootstrap=await readFile(path.join(workspaceRoot,'arcane-pwa.mjs'),'utf8');
        assert.ok(bootstrap.includes(`"/${packageSource}/browser-runtime/pwa.mjs"`));
        await toolchain.importMap({});
        for(const document of ['index.html','pages/review.html','pages/other.htm']){
            const content=await readFile(path.join(workspaceRoot,document),'utf8');
            assert.equal([...content.matchAll(/data-arcane-pwa/gu)].length,1);
            assert.ok(content.includes('href="/arcane.webmanifest"'));
            assert.ok(content.includes('<main>  The turnips retain every word.  </main>'));
        }
        assert.equal(await readFile(path.join(workspaceRoot,'content/fragment.html'),'utf8'),fixture.fragment);
        assert.equal(await readFile(path.join(workspaceRoot,'modules/App.js'),'utf8'),fixture.module);
        await assert.rejects(stat(path.join(workspaceRoot,'arcane')),{code:'ENOENT'});
        await assert.rejects(stat(path.join(workspaceRoot,'arcane.lock.json')),{code:'ENOENT'});
        const packaged=await packageApp({workspaceRoot,appId});
        const packagedMap=JSON.parse(await readFile(path.join(packaged.outputRoot,'modules/arcane.importmap.json'),'utf8'));
        assert.equal(packagedMap.imports['arcane-os/modules/ThemeBootstrap.js'],themeUrl);
        assert.equal(Object.keys(packagedMap.imports).some(function obsoletePackagedSpecifier(specifier){
            return specifier.startsWith('arcane/')||specifier.startsWith('./arcane/');
        }),false);
        const packagedManifest=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane.webmanifest'),'utf8'));
        assert.equal(packagedManifest.id,manifestId??'./');
        assert.equal(packagedManifest.scope,'./');
        assert.equal(packaged.manifest.app.start,'./pages/review.html');
        assert.equal(packaged.manifest.app.rootDocument,'./index.html');
        const packagedBootstrap=await readFile(path.join(packaged.outputRoot,'arcane-pwa.mjs'),'utf8');
        assert.ok(packagedBootstrap.includes(`"./${packageSource}/browser-runtime/pwa.mjs"`));
        for(const [resource,content] of fixture.resources){
            assert.equal(await readFile(path.join(packaged.outputRoot,packageSource,resource),'utf8'),content);
        }
        const packagedOffline=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane-offline.json'),'utf8'));
        assert.deepEqual(packagedOffline.navigationAliases,{});
        assert.equal(packaged.files.some(function nestedAppFile(file){return file.startsWith('apps/');}),false);
        await assert.rejects(stat(path.join(packaged.outputRoot,'apps')),{code:'ENOENT'});
        assert.equal(await readFile(path.join(packaged.outputRoot,'content/fragment.html'),'utf8'),fixture.fragment);
        assert.equal(packaged.files.includes(`${packageSource}/package.json`),false);
    });
}

for(const dependencyName of ['arcane-os','arcane-sdk']){
    test(`root ${dependencyName} preserves its identity without nested generated output`,async function rootOnlyOutput(context){
        const manifestId=dependencyName==='arcane-sdk'?'/retained-installation/':undefined;
        const fixture=await rootFixture(context,dependencyName,{manifestId});
        const {workspaceRoot,appId,packageSource}=fixture;
        const toolchain=createToolchain({workspaceRoot,appId});
        await toolchain.importMap({});
        await assert.rejects(stat(path.join(workspaceRoot,'apps')),{code:'ENOENT'});
        const manifest=JSON.parse(await readFile(path.join(workspaceRoot,'arcane.webmanifest'),'utf8'));
        assert.equal(manifest.id,manifestId??'/apps/root-app/');
        assert.equal(manifest.scope,'/');
        assert.equal(manifest.start_url,'/pages/review.html');
        const offline=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-offline.json'),'utf8'));
        assert.equal(offline.appId,appId);
        assert.deepEqual(offline.navigationAliases,{});
        assert.equal(offline.assets.some(function nestedAppAsset(asset){return asset.startsWith('/apps/');}),false);
        assert.ok(offline.assets.includes(`/${packageSource}/browser-runtime/pwa.mjs`));
        for(const relative of ['arcane-pwa.mjs','arcane-sw.js','arcane-offline.json','arcane.webmanifest']){
            assert.equal((await stat(path.join(workspaceRoot,relative))).isFile(),true,relative);
        }
        const sentinelPath='apps/root-app/retained-note.txt';
        const sentinel='  Unselected authored content stays in place.\nSecond line.  ';
        await writeText(workspaceRoot,sentinelPath,sentinel);
        await toolchain.importMap({});
        assert.equal(await readFile(path.join(workspaceRoot,sentinelPath),'utf8'),sentinel);
        const inspected=await inspectApp({workspaceRoot,appId});
        const dryRun=await packageApp({workspaceRoot,appId,dryRun:true});
        for(const inventory of [inspected.files,dryRun.files]){
            assert.equal(inventory.some(function nestedAppFile(file){return file.startsWith('apps/');}),false);
        }
        await assert.rejects(stat(path.join(workspaceRoot,'dist')),{code:'ENOENT'});
        const packaged=await packageApp({workspaceRoot,appId});
        assert.deepEqual(packaged.files,dryRun.files);
        assert.equal(packaged.files.some(function nestedAppFile(file){return file.startsWith('apps/');}),false);
        await assert.rejects(stat(path.join(packaged.outputRoot,'apps')),{code:'ENOENT'});
        const packagedManifest=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane.webmanifest'),'utf8'));
        assert.equal(packagedManifest.id,manifestId??'./');
        assert.equal(packagedManifest.scope,'./');
        assert.equal(packaged.manifest.app.id,appId);
        assert.equal(packaged.manifest.app.start,'./pages/review.html');
        const packagedOffline=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane-offline.json'),'utf8'));
        assert.deepEqual(packagedOffline.navigationAliases,{});
        assert.equal(packagedOffline.assets.some(function nestedAppAsset(asset){return asset.startsWith('./apps/');}),false);
        for(const document of ['index.html','pages/review.html','pages/other.htm']){
            const content=await readFile(path.join(workspaceRoot,document),'utf8');
            assert.ok(content.includes(`<meta name="arcane-app-id" content="${appId}">`));
            assert.ok(content.includes('<main>  The turnips retain every word.  </main>'));
        }
        assert.equal(await readFile(path.join(workspaceRoot,'content/fragment.html'),'utf8'),fixture.fragment);
        assert.equal(await readFile(path.join(workspaceRoot,sentinelPath),'utf8'),sentinel);
    });
}

test('root output preserves explicitly selected authored resources',async function authoredRootOnlyOutput(context){
    const fixture=await rootFixture(context,'arcane-os');
    const {workspaceRoot,appId}=fixture;
    const authored=new Map([
        ['apps/root-app/index.html','<!doctype html><p>  The original old-path page remains authored.  </p>\n'],
        ['apps/root-app/arcane-sw.js','self.addEventListener("fetch", function authoredFetch() {});\n'],
        ['apps/root-app/arcane-offline.json','{"note":"  Authored inventory, not generated output.  "}\n']
    ]);
    for(const [relative,content] of authored)await writeText(workspaceRoot,relative,content);
    await writeJson(workspaceRoot,'arcane-package.json',{
        ...fixture.manifest,include:[...fixture.manifest.include,...authored.keys()]
    });
    await createToolchain({workspaceRoot,appId}).importMap({});
    const inspected=await inspectApp({workspaceRoot,appId});
    const dryRun=await packageApp({workspaceRoot,appId,dryRun:true});
    const packaged=await packageApp({workspaceRoot,appId});
    assert.deepEqual(packaged.files,dryRun.files);
    for(const [relative,content] of authored){
        assert.ok(inspected.files.includes(relative),relative);
        assert.ok(packaged.files.includes(relative),relative);
        assert.equal(await readFile(path.join(workspaceRoot,relative),'utf8'),content);
        const packagedContent=await readFile(path.join(packaged.outputRoot,relative),'utf8');
        if(relative==='apps/root-app/index.html'){
            assert.ok(packagedContent.startsWith(content));
            assert.ok(packagedContent.includes('<link rel="manifest" href="../../arcane.webmanifest">'));
            assert.ok(packagedContent.includes('async data-arcane-pwa src="../../arcane-pwa.mjs"'));
        }else assert.equal(packagedContent,content);
    }
    const offline=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-offline.json'),'utf8'));
    assert.deepEqual(offline.navigationAliases,{});
    for(const relative of authored.keys())assert.ok(offline.assets.includes(`/${relative}`),relative);
});

for (const rootSelection of ['outside include', 'excluded', 'offline excluded', 'absent']) {
    test(
        `root navigation distinguishes ${rootSelection} host content from the selected application`,
        async function authoredHostRootSelection(context) {
            const fixture = await rootFixture(context, 'arcane-os');
            const {workspaceRoot, appId} = fixture;
            const landing = '<!doctype html><html lang="en"><head>'
                + '<script src="./landing.js?arcaneVersion=authored"></script>'
                + '</head><body>  The turnip shop stays at its own address.  </body></html>\n';
            const manifest = {...fixture.manifest, documents: []};
            if (rootSelection === 'outside include' || rootSelection === 'absent') {
                manifest.include = manifest.include.filter(
                    function retainApplicationResource(relative) {
                        return relative !== 'index.html';
                    }
                );
            } else if (rootSelection === 'excluded') {
                manifest.exclude = ['index.html'];
            } else {
                manifest.pwa = {...manifest.pwa, offline: {exclude: ['index.html']}};
            }
            if (rootSelection === 'absent') {
                await unlink(path.join(workspaceRoot, 'index.html'));
            } else {
                await writeText(workspaceRoot, 'index.html', landing);
                await writeText(workspaceRoot, 'landing.js', 'export const publicLanding = true;\n');
            }
            await writeJson(workspaceRoot, 'arcane-package.json', manifest);
            const toolchain = createToolchain(
                {workspaceRoot, appId}
            );
            await toolchain.importMap({});
            const sourceOffline = JSON.parse(
                await readFile(path.join(workspaceRoot, 'arcane-offline.json'), 'utf8')
            );
            assert.deepEqual(
                sourceOffline.navigationAliases,
                rootSelection === 'absent' ? {'/': '/pages/review.html'} : {}
            );
            assert.equal(sourceOffline.assets.includes('/index.html'), false);
            assert.equal(
                sourceOffline.assets.some(
                    function landingAsset(asset) {
                        return asset.includes('landing.js');
                    }
                ),
                false
            );
            if (rootSelection !== 'absent') {
                assert.equal(await readFile(path.join(workspaceRoot, 'index.html'), 'utf8'), landing);
            }
            const packaged = await packageApp(
                {workspaceRoot, appId}
            );
            const packagedOffline = JSON.parse(
                await readFile(path.join(packaged.outputRoot, 'arcane-offline.json'), 'utf8')
            );
            const packagedIndex = await readFile(path.join(packaged.outputRoot, 'index.html'), 'utf8');
            if (rootSelection === 'offline excluded') {
                assert.equal(packagedIndex, landing);
                assert.equal(packaged.manifest.app.rootDocument, './index.html');
                assert.deepEqual(packagedOffline.navigationAliases, {});
                assert.equal(packagedOffline.assets.includes('./index.html'), false);
            } else {
                assert.notEqual(packagedIndex, landing);
                assert.ok(packagedIndex.includes('pages/review.html'));
                assert.equal(Object.hasOwn(packaged.manifest.app, 'rootDocument'), false);
                assert.deepEqual(packagedOffline.navigationAliases, {'./': './pages/review.html'});
            }
            assert.equal(packaged.manifest.app.start, './pages/review.html');
            assert.equal(packaged.manifest.app.id, appId);
            assert.equal(
                packagedOffline.assets.some(
                    function packagedLandingAsset(asset) {
                        return asset.includes('landing.js');
                    }
                ),
                false
            );
        }
    );
}

test('root-only output also omits navigation when PWA is disabled',async function nonPwaRootOnlyOutput(context){
    const fixture=await rootFixture(context,'arcane-os');
    const {workspaceRoot,appId}=fixture;
    await writeJson(workspaceRoot,'arcane-package.json',{
        ...fixture.manifest,pwa:{enabled:false}
    });
    await createToolchain({workspaceRoot,appId}).importMap({});
    await assert.rejects(stat(path.join(workspaceRoot,'apps')),{code:'ENOENT'});
    await assert.rejects(stat(path.join(workspaceRoot,'arcane.webmanifest')),{code:'ENOENT'});
    const inspected=await inspectApp({workspaceRoot,appId});
    const dryRun=await packageApp({workspaceRoot,appId,dryRun:true});
    const packaged=await packageApp({workspaceRoot,appId});
    assert.deepEqual(dryRun.files,inspected.files);
    assert.deepEqual(packaged.files,inspected.files);
    assert.equal(packaged.files.some(function nestedAppFile(file){return file.startsWith('apps/');}),false);
    assert.equal(packaged.manifest.app.start,'./pages/review.html');
    await assert.rejects(stat(path.join(packaged.outputRoot,'apps')),{code:'ENOENT'});
});

for(const dependencyName of ['arcane-os','arcane-sdk']){
    test(`root ${dependencyName} retires only marked source PWA references by default`,async function markedSourcePwaRetirement(context){
        const fixture=await rootFixture(context,dependencyName);
        const {workspaceRoot,appId}=fixture;
        const toolchain=createToolchain({workspaceRoot,appId});
        await toolchain.importMap({});
        const names=['arcane.webmanifest','arcane-offline.json','arcane-sw.js','arcane-pwa.mjs'];
        const retainedFiles=new Map();
        for(const name of names)retainedFiles.set(name,await readFile(path.join(workspaceRoot,name),'utf8'));
        // Source files with these names may be authored; disabling PWA alone never deletes them.
        const authoredManifest='{ "name": "A complete authored replacement" }\n';
        await writeText(workspaceRoot,'arcane.webmanifest',authoredManifest);
        retainedFiles.set('arcane.webmanifest',authoredManifest);
        const unmarked='<link rel="manifest" href="/arcane.webmanifest" data-author="retained">';
        const ordinaryScript='<script type="module" src="./modules/App.js"></script>';
        const rootBefore=await readFile(path.join(workspaceRoot,'index.html'),'utf8');
        await writeText(workspaceRoot,'index.html',rootBefore.replace('</head>',`${unmarked}</head>`));
        await writeJson(workspaceRoot,'arcane-package.json',{
            ...fixture.manifest,pwa:{enabled:false}
        });
        await toolchain.importMap({});
        const after=new Map();
        for(const document of ['index.html','pages/review.html','pages/other.htm']){
            const content=await readFile(path.join(workspaceRoot,document),'utf8');
            assert.equal(content.includes('data-arcane-pwa'),false,document);
            assert.equal(content.includes('data-arcane-manifest'),false,document);
            assert.ok(content.includes(ordinaryScript),document);
            assert.ok(content.includes('<main>  The turnips retain every word.  </main>'),document);
            after.set(document,content);
        }
        assert.ok(after.get('index.html').includes(unmarked));
        await toolchain.importMap({});
        for(const [document,content] of after)assert.equal(await readFile(path.join(workspaceRoot,document),'utf8'),content);
        for(const [name,content] of retainedFiles)assert.equal(await readFile(path.join(workspaceRoot,name),'utf8'),content);
        assert.equal(await readFile(path.join(workspaceRoot,'content/fragment.html'),'utf8'),fixture.fragment);
    });

    test(`root ${dependencyName} explicitly retires confirmed prior generated PWA output and can re-enable it`,async function confirmedSourcePwaRetirement(context){
        const fixture=await rootFixture(context,dependencyName);
        const {workspaceRoot,appId}=fixture;
        const toolchain=createToolchain({workspaceRoot,appId});
        const names=['arcane.webmanifest','arcane-offline.json','arcane-sw.js','arcane-pwa.mjs'];
        await toolchain.importMap({});
        const documents=['index.html','pages/review.html','pages/other.htm'];
        for(const document of documents){
            // Older SDK source generation did not mark its manifest link.
            const content=(await readFile(path.join(workspaceRoot,document),'utf8')).replace(' data-arcane-manifest','');
            await writeText(workspaceRoot,document,content);
        }
        const authoredManifest='{ "name": "The separate authored application manifest" }\n';
        await writeText(workspaceRoot,'manifest.json',authoredManifest);
        await writeJson(workspaceRoot,'arcane-package.json',{
            ...fixture.manifest,pwa:{enabled:false}
        });
        const events=[];
        await toolchain.importMap({retireGeneratedPwa:true,onEvent:event=>events.push(event)});
        assert.deepEqual(events.find(event=>event.type==='import-map.root-files.completed').retiredPwa,names);
        for(const name of names)await assert.rejects(stat(path.join(workspaceRoot,name)),{code:'ENOENT'});
        const after=new Map();
        for(const document of documents){
            const content=await readFile(path.join(workspaceRoot,document),'utf8');
            assert.equal(content.includes('rel="manifest"'),false,document);
            assert.equal(content.includes('data-arcane-pwa'),false,document);
            assert.ok(content.includes('<main>  The turnips retain every word.  </main>'),document);
            assert.ok(content.includes('data-arcane-import-map'),document);
            after.set(document,content);
        }
        await toolchain.importMap({retireGeneratedPwa:true});
        for(const [document,content] of after)assert.equal(await readFile(path.join(workspaceRoot,document),'utf8'),content);
        assert.equal(await readFile(path.join(workspaceRoot,'manifest.json'),'utf8'),authoredManifest);
        assert.equal(await readFile(path.join(workspaceRoot,'content/fragment.html'),'utf8'),fixture.fragment);
        assert.equal(await readFile(path.join(workspaceRoot,'modules/App.js'),'utf8'),fixture.module);
        for(const [relative,content] of fixture.resources)assert.equal(await readFile(path.join(fixture.packageRoot,relative),'utf8'),content);

        await writeJson(workspaceRoot,'arcane-package.json',fixture.manifest);
        // A retained operation option cannot retire output while the descriptor enables PWA.
        await toolchain.importMap({retireGeneratedPwa:true});
        for(const name of names)assert.ok((await stat(path.join(workspaceRoot,name))).isFile());
        for(const document of documents){
            const content=await readFile(path.join(workspaceRoot,document),'utf8');
            assert.ok(content.includes('href="/arcane.webmanifest" data-arcane-manifest'),document);
            assert.equal([...content.matchAll(/data-arcane-pwa/gu)].length,1,document);
        }
    });
}

test('source retirement requires disabled configuration and preserves unselected pages',async function selectedSourcePwaRetirement(context){
    const fixture=await rootFixture(context,'arcane-os');
    const {workspaceRoot,appId}=fixture;
    const toolchain=createToolchain({workspaceRoot,appId});
    await toolchain.importMap({});
    const documents=['index.html','pages/review.html','pages/other.htm'];
    const originals=new Map();
    for(const document of documents)originals.set(document,await readFile(path.join(workspaceRoot,document),'utf8'));
    const {pwa,...withoutPwa}=fixture.manifest;
    await writeJson(workspaceRoot,'arcane-package.json',withoutPwa);
    await toolchain.importMap({retireGeneratedPwa:true});
    for(const [document,content] of originals)assert.equal(await readFile(path.join(workspaceRoot,document),'utf8'),content);
    for(const name of ['arcane.webmanifest','arcane-offline.json','arcane-sw.js','arcane-pwa.mjs']){
        assert.ok((await stat(path.join(workspaceRoot,name))).isFile());
    }
    await writeJson(workspaceRoot,'arcane-package.json',{
        ...fixture.manifest,documents:['pages/review.html'],pwa:{enabled:false}
    });
    await toolchain.importMap({});
    const selected=await readFile(path.join(workspaceRoot,'pages/review.html'),'utf8');
    assert.equal(selected.includes('data-arcane-pwa'),false);
    assert.equal(selected.includes('data-arcane-manifest'),false);
    for(const document of ['index.html','pages/other.htm']){
        assert.equal(await readFile(path.join(workspaceRoot,document),'utf8'),originals.get(document));
    }
});

test('nested direct-installed apps retain established aliases alongside package paths',async function nestedDirectAliases(context){
    const fixture=await rootFixture(context,'arcane-os');
    const {workspaceRoot,packageSource,sdkVersion}=fixture;
    const appId='nested-app';
    const config=JSON.parse(await readFile(path.join(workspaceRoot,'arcane-packager.json'),'utf8'));
    const html=(await readFile(path.join(workspaceRoot,'index.html'),'utf8'))
        .replace('content="root-app"',`content="${appId}"`)
        .replace('<base href="./">','<base href="../../">')
        .replace('href="./app.css"',`href="./apps/${appId}/app.css"`)
        .replace('src="./modules/App.js"',`src="./apps/${appId}/modules/App.js"`);
    await Promise.all([
        writeJson(workspaceRoot,'arcane-packager.json',{...config,appsRoot:'apps'}),
        writeJson(workspaceRoot,`apps/${appId}/arcane-package.json`,{
            ...fixture.manifest,id:appId,entry:'index.html',include:['index.html','app.css','modules'],pwa:{enabled:false}
        }),
        writeText(workspaceRoot,`apps/${appId}/index.html`,html),
        writeText(workspaceRoot,`apps/${appId}/app.css`,'main { white-space: pre-wrap; }\n'),
        writeText(workspaceRoot,`apps/${appId}/modules/App.js`,"import 'arcane/ThemeBootstrap';\n")
    ]);
    const result=await createToolchain({workspaceRoot,appId}).importMap({});
    const themeUrl=`./${packageSource}/runtime/arcane/modules/ThemeBootstrap.js`;
    for(const specifier of [
        'arcane/ThemeBootstrap','./arcane/modules/ThemeBootstrap.js',
        'arcane-os/modules/ThemeBootstrap.js',themeUrl
    ]){
        assert.equal(result.importMap.imports[specifier],themeUrl,specifier);
    }
});
