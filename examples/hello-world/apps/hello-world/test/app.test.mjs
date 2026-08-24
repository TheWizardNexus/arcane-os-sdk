import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {registerHooks} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'arcane-os/testing';

const appRoot=new URL('../',import.meta.url);
async function runtimeRoot(){
    const physical=new URL('../../../arcane/',import.meta.url);
    await stat(new URL('modules/AppDataScope.js',physical));
    return physical;
}

function interactiveElement({textContent=''}={}){
    const listeners=new Map();
    return {
        textContent,
        addEventListener(type,listener){ listeners.set(type,listener); },
        async trigger(type){
            assert.equal(listeners.has(type),true,`Missing ${type} listener.`);
            return listeners.get(type)();
        }
    };
}

function browserHarness(){
    const elements=new Map([
        ['#app-action',interactiveElement()],
        ['#app-status',interactiveElement({textContent:'Ready to say hello.'})]
    ]);
    const values=new Map();
    const storage={
        getItem(key){ return values.has(key)?values.get(key):null; },
        setItem(key,value){ values.set(key,String(value)); },
        removeItem(key){ values.delete(key); }
    };
    const dataset={arcaneAppId:'hello-world'};
    const properties=new Map();
    const root={
        dataset,
        style:{
            fontSize:'',
            setProperty(name,value){ properties.set(name,value); },
            removeProperty(name){ properties.delete(name); }
        },
        removeAttribute(name){
            if(!name.startsWith('data-')) return;
            const key=name.slice(5).replace(/-([a-z])/gu,(_match,letter)=>letter.toUpperCase());
            delete dataset[key];
        }
    };
    const documentObject={
        documentElement:root,
        querySelector(selector){
            if(selector==='meta[name="arcane-app-id"]'){
                return {getAttribute:name=>name==='content'?'hello-world':null};
            }
            return elements.get(selector)??null;
        }
    };
    return {documentObject,elements,storage,values};
}

function installGlobals({documentObject,storage}){
    const names=[
        'document',
        'localStorage',
        'Arcane',
        'arcaneThemeReady',
        'arcaneThemeAppearanceListener'
    ];
    const previous=new Map(names.map(name=>[
        name,
        Object.getOwnPropertyDescriptor(globalThis,name)
    ]));
    for(const name of names) delete globalThis[name];
    Object.defineProperty(globalThis,'document',{value:documentObject,writable:true,configurable:true});
    Object.defineProperty(globalThis,'localStorage',{value:storage,writable:true,configurable:true});
    return function restoreGlobals(){
        for(const name of names){
            const descriptor=previous.get(name);
            if(descriptor) Object.defineProperty(globalThis,name,descriptor);
            else delete globalThis[name];
        }
    };
}

async function runApplication(callback){
    const temporaryRoot=await mkdtemp(path.join(tmpdir(),'arcane-hello-world-test-'));
    const appModules=path.join(temporaryRoot,'apps','hello-world','modules');
    const arcaneRoot=await runtimeRoot();
    await Promise.all([
        cp(fileURLToPath(new URL('modules/',appRoot)),appModules,{recursive:true}),
        cp(fileURLToPath(new URL('modules/',arcaneRoot)),path.join(temporaryRoot,'arcane','modules'),{recursive:true}),
        cp(fileURLToPath(new URL('entities/',arcaneRoot)),path.join(temporaryRoot,'arcane','entities'),{recursive:true})
    ]);
    const appPath=path.join(appModules,'App.js');
    const namedTargets=new Map([
        [
            'arcane/ThemeBootstrap',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','ThemeBootstrap.js')).href
        ],
        [
            'arcane/AppDataScope',
            pathToFileURL(path.join(temporaryRoot,'arcane','modules','AppDataScope.js')).href
        ]
    ]);
    const moduleHooks=registerHooks({
        resolve(specifier,context,nextResolve){
            const target=namedTargets.get(specifier);
            return target?{url:target,shortCircuit:true}:nextResolve(specifier,context);
        }
    });

    const browser=browserHarness();
    const restoreGlobals=installGlobals(browser);
    try{
        await import(pathToFileURL(appPath).href);
        await new Promise(resolve=>setTimeout(resolve,0));
        return await callback(browser);
    }finally{
        restoreGlobals();
        moduleHooks.deregister();
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

test('application shell installs its managed import map before every module',async function verifyImportMapOrder(){
    const [source,mapSource]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/arcane.importmap.json',appRoot),'utf8')
    ]);
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/hello-world/hello-world.css');
    const base=source.indexOf('<base href="../../">');
    const importMap=source.indexOf('data-arcane-import-map');
    const appModule=source.indexOf('<script type="module"');
    const managed=source.match(
        /<script type="importmap" data-arcane-import-map>\s*([\s\S]*?)\s*<\/script>/u
    );

    assert.match(source,/<meta name="arcane-app-id" content="hello-world">/u);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(base>=0&&importMap>base&&appModule>importMap);
    assert.ok(managed);
    assert.deepEqual(Object.keys(JSON.parse(mapSource)),['imports']);
    assert.deepEqual(JSON.parse(managed[1]),JSON.parse(mapSource));
    assert.equal(`${managed[1].trim()}\n`,mapSource);
    assert.doesNotMatch(source,/ThemeBootstrap[.]js[?]/u);
});

test('application package is browser-only and matches its directory',async function verifyPackageIdentity(){
    const [manifest,descriptor]=await Promise.all([
        readFile(new URL('arcane-package.json',appRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-app.json',appRoot),'utf8').then(JSON.parse)
    ]);
    assert.equal(manifest.id,'hello-world');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
    assert.equal(manifest.include.includes('img/icon.png'),false);
    assert.deepEqual(descriptor.targets,['browser']);
    assert.deepEqual(descriptor.permissions,{capabilities:[],methods:[]});
    assert.equal(descriptor.native.icon,null);
});

test('workspace exposes the browser release workflow and physical runtime route',async function verifyWorkspaceWorkflow(){
    const workspaceRoot=new URL('../../../',import.meta.url);
    const [packageJson,packager,readme]=await Promise.all([
        readFile(new URL('package.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-packager.json',workspaceRoot),'utf8').then(JSON.parse),
        readFile(new URL('README.md',workspaceRoot),'utf8')
    ]);
    assert.deepEqual(
        Object.fromEntries([
            'import-map',
            'package',
            'verify',
            'bundle',
            'build',
            'run'
        ].map(name=>[name,packageJson.scripts[name]])),
        {
            'import-map':'arcane import-map',
            package:'arcane package',
            verify:'arcane verify',
            bundle:'arcane bundle',
            build:'arcane build --target browser',
            run:'arcane run --target browser'
        }
    );
    const runtimeRoutes=packager.sharedPayloads['browser-runtime'];
    assert.deepEqual(runtimeRoutes[0],{
        source:'arcane',
        destination:'arcane',
        include:['components','css','dependencies','entities','img','modules','sdk','security'],
        exclude:[]
    });
    assert.equal(
        runtimeRoutes.some(route=>route.destination==='node_modules/strong-type'),
        false
    );
    assert.match(readme,/npm run package[\s\S]*npm run verify[\s\S]*npm run bundle[\s\S]*npm run run/u);
    assert.match(readme,/apps\/hello-world\/modules\/arcane[.]importmap[.]json/u);
    assert.match(readme,/does not create a standalone native executable/u);
});

test('application demonstrates query-free named Arcane imports',async function verifyNamedImports(){
    const [html,script]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8')
    ]);
    assert.match(html,/Hello, Arcane World!/u);
    assert.match(html,/>Say hello<\/button>/u);
    assert.match(html,/Named browser imports/u);
    assert.match(html,/Same files in dev and dist/u);
    assert.match(script,/from 'arcane\/ThemeBootstrap'/u);
    assert.match(script,/from 'arcane\/AppDataScope'/u);
    assert.doesNotMatch(script,/ThemeBootstrap[.]js|AppDataScope[.]js|DirectoryPicker|native/u);
    assert.match(script,/resolveApplicationId\(\)/u);
    assert.match(script,/resolveApplicationLocalStorageKey\('hello-count',\{applicationId:appId\}\)/u);
    assert.match(script,/function sayHello\(\)/u);
    assert.match(script,/Hello from Arcane OS!/u);
});

test('browser mode persists an app-scoped greeting',async function verifyBrowserBehavior(){
    await runApplication(async({elements,values})=>{
        const action=elements.get('#app-action');
        const status=elements.get('#app-status');

        await action.trigger('click');
        await action.trigger('click');
        assert.equal(values.get('arcane.apps.hello-world:hello-count'),'2');
        assert.equal(status.textContent,'Hello from Arcane OS! Greeting 2.');
    });
});
