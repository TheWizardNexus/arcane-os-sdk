import assert from 'node:assert/strict';
import {mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import test from '../src/testing.mjs';
import {rootAppNavigation} from '../src/app-layout.mjs';
import {packageApp} from '../src/packager/core.mjs';
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
    const module="import 'arcane/ThemeBootstrap';\nexport const verdict = '  Keep the complete testimony.  ';\n";
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
    return {workspaceRoot,appId,packageSource,packageRoot,sdkVersion,manifest,fragment,module,resources};
}

function redirectedLocation(content,source){
    const incoming=new URL(source);
    let result;
    runInNewContext(content.match(/<script>([\s\S]*?)<\/script>/u)[1],{
        URL,
        location:{
            href:incoming.href,search:incoming.search,hash:incoming.hash,
            replace(value){result=value;}
        }
    });
    return result;
}

for(const dependencyName of ['arcane-os','arcane-sdk']){
    test(`root ${dependencyName} import-map emits direct static PWA files and portable navigation`,async function rootStaticPwa(context){
        const manifestId=dependencyName==='arcane-sdk'?'/retained-installation/':undefined;
        const fixture=await rootFixture(context,dependencyName,{manifestId});
        const {workspaceRoot,appId,packageSource}=fixture;
        const toolchain=createToolchain({workspaceRoot,appId});
        const themeUrl=`./${packageSource}/runtime/arcane/modules/ThemeBootstrap.js`;
        await writeJson(workspaceRoot,'arcane-package.json',{
            ...fixture.manifest,pwa:{...fixture.manifest.pwa,enabled:false}
        });
        const versioned=await toolchain.importMap({});
        const versionedTheme=`${themeUrl}?arcaneVersion=${fixture.sdkVersion}`;
        for(const specifier of ['arcane/ThemeBootstrap',themeUrl,versionedTheme]){
            assert.equal(versioned.importMap.imports[specifier],versionedTheme,specifier);
        }
        await writeJson(workspaceRoot,'arcane-package.json',fixture.manifest);
        const result=await toolchain.importMap({});
        assert.equal(result.importMap.committed,true);
        for(const specifier of ['arcane/ThemeBootstrap',themeUrl]){
            assert.equal(result.importMap.imports[specifier],themeUrl,specifier);
        }
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
        assert.equal(offline.navigationAliases['/apps/root-app/'],'/pages/review.html');
        assert.equal(offline.navigationAliases['/apps/root-app/index.html'],'/pages/review.html');
        for(const resource of fixture.resources.keys())assert.ok(offline.assets.includes(`/${packageSource}/${resource}`));
        assert.ok(offline.assets.includes('/modules/arcane.importmap.json'));
        assert.ok(offline.assets.includes('/content/fragment.html'));
        assert.equal(offline.assets.includes(`/${packageSource}/package.json`),false);
        const legacyAppPath=`apps/${appId}`;
        const legacyOffline=JSON.parse(await readFile(path.join(workspaceRoot,legacyAppPath,'arcane-offline.json'),'utf8'));
        assert.equal(legacyOffline.appId,appId);
        assert.equal(legacyOffline.appVersion,offline.appVersion);
        assert.equal(legacyOffline.revision,offline.revision);
        assert.deepEqual(legacyOffline.navigationAliases,offline.navigationAliases);
        for(const asset of offline.assets)assert.ok(legacyOffline.assets.includes(asset),asset);
        assert.ok(legacyOffline.assets.includes('./arcane-offline.json'));
        const legacyWorker=await readFile(path.join(workspaceRoot,legacyAppPath,'arcane-sw.js'),'utf8');
        assert.ok(legacyWorker.includes(`"/${packageSource}/browser-runtime/pwa.mjs"`));
        assert.ok(legacyWorker.includes('self.addEventListener(\'fetch\', onFetch)'));
        const bootstrap=await readFile(path.join(workspaceRoot,'arcane-pwa.mjs'),'utf8');
        assert.ok(bootstrap.includes(`"/${packageSource}/browser-runtime/pwa.mjs"`));
        const navigation=rootAppNavigation(appId,fixture.manifest.entry,['pages/review.html','index.html','pages/other.htm']);
        for(const redirect of navigation){
            const content=await readFile(path.join(workspaceRoot,redirect.path),'utf8');
            assert.equal(content,redirect.content);
            const incoming=`https://example.test/${redirect.path}?view=complete#last-turn`;
            assert.equal(redirectedLocation(content,incoming),`https://example.test${redirect.target}?view=complete#last-turn`);
        }
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
        const packagedManifest=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane.webmanifest'),'utf8'));
        assert.equal(packagedManifest.id,manifestId??'./');
        assert.equal(packagedManifest.scope,'./');
        assert.equal(packaged.manifest.app.start,'./pages/review.html');
        const packagedBootstrap=await readFile(path.join(packaged.outputRoot,'arcane-pwa.mjs'),'utf8');
        assert.ok(packagedBootstrap.includes(`"./${packageSource}/browser-runtime/pwa.mjs"`));
        for(const [resource,content] of fixture.resources){
            assert.equal(await readFile(path.join(packaged.outputRoot,packageSource,resource),'utf8'),content);
        }
        const packagedOffline=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane-offline.json'),'utf8'));
        assert.equal(packagedOffline.navigationAliases['./apps/root-app/'],'./pages/review.html');
        const packagedLegacyOffline=JSON.parse(await readFile(path.join(packaged.outputRoot,legacyAppPath,'arcane-offline.json'),'utf8'));
        assert.equal(packagedLegacyOffline.appId,appId);
        assert.equal(packagedLegacyOffline.appVersion,packagedOffline.appVersion);
        assert.equal(packagedLegacyOffline.revision,packagedOffline.revision);
        assert.ok(packaged.files.includes(`${legacyAppPath}/arcane-sw.js`));
        assert.ok(packaged.files.includes(`${legacyAppPath}/arcane-offline.json`));
        assert.ok(packagedLegacyOffline.assets.includes(`../../${packageSource}/browser-runtime/pwa.mjs`));
        assert.ok(packagedLegacyOffline.assets.includes('./arcane-offline.json'));
        const packageBase='https://example.test/releases/root/';
        const legacyScope=new URL(`${legacyAppPath}/`,packageBase);
        const legacyAssets=new Set(packagedLegacyOffline.assets.map(asset=>new URL(asset,legacyScope).href));
        for(const asset of packagedOffline.assets){
            assert.ok(legacyAssets.has(new URL(asset,packageBase).href),asset);
        }
        const legacyAliases=new Map(Object.entries(packagedLegacyOffline.navigationAliases).map(([from,to])=>[
            new URL(from,legacyScope).href,new URL(to,legacyScope).href
        ]));
        for(const [from,to] of Object.entries(packagedOffline.navigationAliases)){
            assert.equal(legacyAliases.get(new URL(from,packageBase).href),new URL(to,packageBase).href,from);
        }
        const packagedLegacyWorker=await readFile(path.join(packaged.outputRoot,legacyAppPath,'arcane-sw.js'),'utf8');
        assert.ok(packagedLegacyWorker.includes(`"../../${packageSource}/browser-runtime/pwa.mjs"`));
        assert.ok(packagedLegacyWorker.includes('self.addEventListener(\'fetch\', onFetch)'));
        for(const redirect of navigation){
            const content=await readFile(path.join(packaged.outputRoot,redirect.path),'utf8');
            assert.equal(redirectedLocation(content,`https://example.test/releases/root/${redirect.path}?view=all#last-turn`),
                `https://example.test/releases/root${redirect.target}?view=all#last-turn`);
        }
        assert.equal(await readFile(path.join(packaged.outputRoot,'content/fragment.html'),'utf8'),fixture.fragment);
        assert.equal(packaged.files.includes(`${packageSource}/package.json`),false);
    });
}

test('root navigation generation preserves an existing authored old app path',async function retainedRootNavigation(context){
    const fixture=await rootFixture(context,'arcane-os');
    const relative='apps/root-app/index.html';
    const authored='<!doctype html><p>  This old app page is still owned by its author.  </p>\n';
    await writeText(fixture.workspaceRoot,relative,authored);
    const toolchain=createToolchain({workspaceRoot:fixture.workspaceRoot,appId:fixture.appId});
    await assert.rejects(toolchain.importMap({}),/Root application navigation would replace authored content/u);
    assert.equal(await readFile(path.join(fixture.workspaceRoot,relative),'utf8'),authored);
});
