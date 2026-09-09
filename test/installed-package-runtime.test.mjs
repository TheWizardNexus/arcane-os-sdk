import assert from 'node:assert/strict';
import {mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {startDevServer} from '../src/dev-server.mjs';
import {
    generateImportMap,readApplicationTestImportMapContext,readWorkspaceAssetVersion
} from '../src/import-map.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {installedSdkRoutes} from '../src/sdk-runtime-layout.mjs';
import {resolveWorkspace,validateWorkspace} from '../src/workspace.mjs';
import {temporaryDirectory} from './helpers.mjs';

async function writeText(root,relative,content){
    const destination=path.join(root,...relative.split('/'));
    await mkdir(path.dirname(destination),{recursive:true});
    await writeFile(destination,content,'utf8');
}

async function writeJson(root,relative,value){
    await writeText(root,relative,`${JSON.stringify(value,null,2)}\n`);
}

async function installedWorkspace(context,dependencyName){
    const workspaceRoot=await temporaryDirectory(context,{prefix:'arcane-installed-runtime-'});
    const appId='installed-app';
    const packageSource=`node_modules/${dependencyName}`;
    const packageRoot=path.join(workspaceRoot,...packageSource.split('/'));
    const version='9.8.7';
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const manifest={
        schemaVersion:1,id:appId,displayName:'Installed Runtime App',version:'1.0.0',
        entry:'index.html',strategy:'static',include:['index.html','app.css','modules'],
        exclude:[],shared:['browser-runtime']
    };
    await Promise.all([
        writeJson(workspaceRoot,'package.json',{
            name:'installed-runtime-consumer',private:true,type:'module',
            dependencies:{[dependencyName]:dependencyName==='arcane-os'?version:`npm:arcane-os@${version}`}
        }),
        writeJson(workspaceRoot,'arcane-packager.json',{
            schemaVersion:1,appsRoot:'apps',distRoot:'dist',
            sharedPayloads:{'browser-runtime':installedSdkRoutes(packageSource)}
        }),
        writeJson(packageRoot,'package.json',{name:'arcane-os',version,type:'module'}),
        writeJson(appRoot,'arcane-package.json',manifest),
        writeText(appRoot,'index.html','<!doctype html><html lang="en"><head>'
            +`<meta name="arcane-app-id" content="${appId}"><base href="../../">`
            +'<link rel="stylesheet" href="./arcane/css/theme.css">'
            +'<link rel="stylesheet" href="./arcane/css/primitives.css">'
            +`<link rel="stylesheet" href="./apps/${appId}/app.css">`
            +'<script type="importmap" data-arcane-import-map>{"imports":{}}</script>'
            +'</head><body><main>Complete installed runtime content</main>'
            +`<script type="module" src="./apps/${appId}/modules/App.js"></script>`
            +'</body></html>\n'),
        writeText(appRoot,'app.css','main { display: block; }\n'),
        writeText(appRoot,'modules/App.js',"import 'arcane/ThemeBootstrap';\n")
    ]);
    const resources=new Map([
        ['runtime/arcane/components/panel.html','<section>  complete component  </section>\n'],
        ['runtime/arcane/css/theme.css',':root { --theme: initial; }\n'],
        ['runtime/arcane/css/primitives.css','button { font: inherit; }\n'],
        ['runtime/arcane/entities/Record.js','export default class Record {}\n'],
        ['runtime/arcane/img/icon.svg','<svg xmlns="http://www.w3.org/2000/svg"/>\n'],
        ['runtime/arcane/modules/ThemeBootstrap.js','export default function ThemeBootstrap() {}\n'],
        ['browser-runtime/event-manager.mjs','export const canonicalEvents = true;\n'],
        ['browser-runtime/ai/provider.mjs','export const provider = "complete provider content";\n'],
        ['browser-runtime/pwa.mjs','export function registerPwa() {}\n'],
        ['runtime/strong-type/index.js','export default function Is() {}\n'],
        ['runtime/strong-type/types/string.js','export const stringType = true;\n'],
        ['LICENSE','Complete synthetic SDK license\n'],
        ['COMMERCIAL-LICENSE.md','Complete synthetic commercial license\n'],
        ['NOTICE','Complete synthetic SDK notice\n']
    ]);
    await Promise.all([...resources].map(async function writeInstalledResource([relative,content]){
        await writeText(packageRoot,relative,content);
    }));
    return {workspaceRoot,appRoot,appId,packageRoot,packageSource,version,manifest,resources};
}

for(const dependencyName of ['arcane-os','arcane-sdk']){
    test(`installed-only ${dependencyName} supports source maps, serving, PWA and portable packages`,
        async function installedOnlyRuntime(context){
            const fixture=await installedWorkspace(context,dependencyName);
            const {workspaceRoot,appRoot,appId,version}=fixture;
            const rootProjection=path.join(workspaceRoot,'arcane');
            const lockPath=path.join(workspaceRoot,'arcane.lock.json');
            await assert.rejects(stat(rootProjection),{code:'ENOENT'});
            await assert.rejects(stat(lockPath),{code:'ENOENT'});
            const resolved=await resolveWorkspace({workspaceRoot,appId});
            assert.equal(resolved.config.browserRuntimeLayout,'installed-v1');
            assert.equal(resolved.config.sdkPackageSource,fixture.packageSource);
            const valid=await validateWorkspace({workspaceRoot,appId});
            assert.equal(valid.valid,true);
            assert.equal(valid.sdkInstallation.dependencyName,dependencyName);
            assert.equal(valid.sdkInstallation.packageVersion,version);

            const mapped=await generateImportMap({workspaceRoot,appId});
            const expected={
                'arcane/ThemeBootstrap':`./arcane/modules/ThemeBootstrap.js?arcaneVersion=${version}`,
                'arcane-os/event-manager':`./arcane/sdk/event-manager.mjs?arcaneVersion=${version}`,
                'strong-type':`./arcane/dependencies/strong-type/index.js?arcaneVersion=${version}`
            };
            for(const [specifier,target] of Object.entries(expected)){
                assert.equal(mapped.imports[specifier],target);
            }
            const testMap=await readApplicationTestImportMapContext({workspaceRoot,applicationRoot:appRoot});
            assert.equal(testMap.imports['arcane/ThemeBootstrap'],
                `./${fixture.packageSource}/runtime/arcane/modules/ThemeBootstrap.js?arcaneVersion=${version}`);
            assert.equal(testMap.imports['arcane-os/event-manager'],
                `./${fixture.packageSource}/browser-runtime/event-manager.mjs?arcaneVersion=${version}`);
            await writeJson(workspaceRoot,'arcane.lock.json',{sdk:{version:'0.0.1'}});
            assert.equal(await readWorkspaceAssetVersion(workspaceRoot),version);
            const remapped=await generateImportMap({workspaceRoot,appId});
            for(const [specifier,target] of Object.entries(expected)){
                assert.equal(remapped.imports[specifier],target);
            }
            assert.deepEqual(JSON.parse(await readFile(lockPath,'utf8')),{sdk:{version:'0.0.1'}});
            await rm(lockPath);

            await writeJson(appRoot,'arcane-package.json',{
                ...fixture.manifest,pwa:{enabled:true}
            });
            const pwaMap=await generateImportMap({workspaceRoot,appId});
            assert.equal(pwaMap.imports['strong-type'],'./arcane/dependencies/strong-type/index.js');
            const instance=await startDevServer({workspaceRoot,appId,http:true,host:'127.0.0.1',port:0});
            const logicalResources=[
                ['/arcane/components/panel.html','runtime/arcane/components/panel.html'],
                ['/arcane/modules/ThemeBootstrap.js','runtime/arcane/modules/ThemeBootstrap.js'],
                ['/arcane/sdk/event-manager.mjs','browser-runtime/event-manager.mjs'],
                ['/arcane/sdk/ai/provider.mjs','browser-runtime/ai/provider.mjs'],
                ['/arcane/dependencies/strong-type/index.js','runtime/strong-type/index.js'],
                ['/licenses/arcane-os/LICENSE','LICENSE']
            ];
            try{
                for(const [url,source] of logicalResources){
                    const response=await fetch(new URL(url,instance.origin));
                    assert.equal(response.status,200,url);
                    assert.equal(await response.text(),fixture.resources.get(source));
                }
                const offlineResponse=await fetch(new URL('/arcane-offline.json',instance.origin));
                assert.equal(offlineResponse.status,200);
                const offline=await offlineResponse.json();
                assert.equal(offline.sdkVersion,version);
                for(const [url] of logicalResources){assert.ok(offline.assets.includes(url),url);}
                assert.equal(offline.assets.some(function physicalPackageUrl(url){return url.includes('node_modules/');}),false);
            }finally{
                await instance.close();
            }

            const packaged=await packageApp({workspaceRoot,appId});
            for(const [url,source] of logicalResources){
                const relative=url.slice(1);
                assert.ok(packaged.files.includes(relative),relative);
                assert.equal(await readFile(path.join(packaged.outputRoot,relative),'utf8'),fixture.resources.get(source));
            }
            assert.ok(packaged.files.includes('arcane/dependencies/strong-type/types/string.js'));
            const packagedOffline=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane-offline.json'),'utf8'));
            assert.equal(packagedOffline.sdkVersion,version);
            assert.ok(packagedOffline.assets.includes('./arcane/sdk/ai/provider.mjs'));
            assert.equal(packaged.files.some(function physicalPackagePath(file){return file.startsWith('node_modules/')||file.includes('/./');}),false);
            await assert.rejects(stat(rootProjection),{code:'ENOENT'});
            await assert.rejects(stat(lockPath),{code:'ENOENT'});
        }
    );
}
