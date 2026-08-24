import assert from 'node:assert/strict';
import {cp,mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import test from 'arcane-os/testing';

const appRoot=new URL('../',import.meta.url);
const runtimeCandidates=[
    new URL('../../../node_modules/arcane-os/runtime/arcane/',import.meta.url),
    new URL('../../../../../runtime/arcane/',import.meta.url)
];

async function runtimeRoot(){
    for(const candidate of runtimeCandidates){
        try{
            await stat(new URL('modules/AppDataScope.js',candidate));
            return candidate;
        }catch{
            // Try the installed SDK and maintained repository layouts in order.
        }
    }
    throw new Error('The Arcane runtime is unavailable to the Hello World test.');
}

function interactiveElement({textContent='',disabled=false}={}){
    const listeners=new Map();
    return {
        textContent,
        disabled,
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
        ['#native-action',interactiveElement({disabled:true})],
        ['#app-status',interactiveElement({textContent:'Ready to say hello.'})],
        ['#app-environment',interactiveElement({textContent:'Loading the Arcane web runtime.'})]
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

function installGlobals({documentObject,storage},arcane){
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
    if(arcane){
        Object.defineProperty(globalThis,'Arcane',{value:arcane,writable:true,configurable:true});
    }
    return function restoreGlobals(){
        for(const name of names){
            const descriptor=previous.get(name);
            if(descriptor) Object.defineProperty(globalThis,name,descriptor);
            else delete globalThis[name];
        }
    };
}

async function runApplication(arcane,callback){
    const temporaryRoot=await mkdtemp(path.join(tmpdir(),'arcane-hello-world-test-'));
    const appModules=path.join(temporaryRoot,'apps','hello-world','modules');
    const arcaneRoot=await runtimeRoot();
    await Promise.all([
        cp(fileURLToPath(new URL('modules/',appRoot)),appModules,{recursive:true}),
        cp(fileURLToPath(new URL('modules/',arcaneRoot)),path.join(temporaryRoot,'arcane','modules'),{recursive:true}),
        cp(fileURLToPath(new URL('entities/',arcaneRoot)),path.join(temporaryRoot,'arcane','entities'),{recursive:true})
    ]);
    const browser=browserHarness();
    const restoreGlobals=installGlobals(browser,arcane);
    try{
        await import(pathToFileURL(path.join(appModules,'App.js')).href);
        await new Promise(resolve=>setTimeout(resolve,0));
        return await callback(browser);
    }finally{
        restoreGlobals();
        await rm(temporaryRoot,{recursive:true,force:true});
    }
}

function nativeArcaneHarness(applicationId='hello-world'){
    const state={
        applicationCalls:0,
        preferenceReads:[],
        preferenceWrites:[],
        selection:{cancelled:true,path:null},
        selectionError:null,
        selectionRequests:[]
    };
    const arcane={
        runtime:{current:()=>({native:true,transport:'webview2'})},
        app:{
            async current(){
                state.applicationCalls+=1;
                return {
                    id:applicationId,
                    displayName:'Arcane Hello World',
                    version:'0.1.0'
                };
            }
        },
        preferences:{
            async get(key){
                state.preferenceReads.push(key);
                return {found:false,value:null};
            },
            async set(key,value){
                state.preferenceWrites.push({method:'set',key,value});
                return {key,value};
            },
            async delete(key){
                state.preferenceWrites.push({method:'delete',key});
                return {key,deleted:true};
            }
        },
        filesystem:{
            async selectDirectory(options){
                state.selectionRequests.push(options);
                if(state.selectionError) throw state.selectionError;
                return state.selection;
            }
        }
    };
    return {arcane,state};
}

test('application shell uses the shared Arcane theme in order',async function verifyThemeOrder(){
    const source=await readFile(new URL('index.html',appRoot),'utf8');
    const theme=source.indexOf('./arcane/css/theme.css');
    const primitives=source.indexOf('./arcane/css/primitives.css');
    const appStyle=source.indexOf('./apps/hello-world/hello-world.css');
    const bootstrap=source.indexOf('./arcane/modules/ThemeBootstrap.js');
    const appModule=source.indexOf('./apps/hello-world/modules/App.js');

    assert.match(source,/<base href="\.\.\/\.\.\/">/u);
    assert.match(source,/<meta name="arcane-app-id" content="hello-world">/u);
    assert.ok(theme>=0&&primitives>theme&&appStyle>primitives);
    assert.ok(bootstrap>appStyle&&appModule>bootstrap);
});

test('application package identity matches its directory',async function verifyPackageIdentity(){
    const [manifest,descriptor]=await Promise.all([
        readFile(new URL('arcane-package.json',appRoot),'utf8').then(JSON.parse),
        readFile(new URL('arcane-app.json',appRoot),'utf8').then(JSON.parse)
    ]);
    assert.equal(manifest.id,'hello-world');
    assert.equal(manifest.strategy,'static');
    assert.deepEqual(manifest.shared,['browser-runtime']);
    assert.deepEqual(descriptor.permissions,{
        capabilities:['filesystem.directory.select','preferences.read'],
        methods:['app.current','filesystem.directory.select','preferences.get']
    });
});

test('application demonstrates shared browser and executable Arcane surfaces',async function verifyArcaneSurfaces(){
    const [html,script]=await Promise.all([
        readFile(new URL('index.html',appRoot),'utf8'),
        readFile(new URL('modules/App.js',appRoot),'utf8')
    ]);
    assert.match(html,/Hello, Arcane World!/u);
    assert.match(html,/>Say hello<\/button>/u);
    assert.match(html,/id="native-action"[\s\S]*disabled/u);
    assert.match(html,/Works in the browser/u);
    assert.match(html,/Executable feature/u);
    assert.match(html,/>Choose a folder<\/button>/u);
    assert.match(script,/\.\.\/\.\.\/\.\.\/arcane\/modules\/ThemeBootstrap[.]js[?]v=1/u);
    assert.match(script,/\.\.\/\.\.\/\.\.\/arcane\/modules\/AppDataScope[.]js[?]v=1/u);
    assert.match(script,/\.\.\/\.\.\/\.\.\/arcane\/modules\/DirectoryPicker[.]js[?]v=1/u);
    assert.match(script,/resolveApplicationId\(\)/u);
    assert.match(script,/resolveApplicationLocalStorageKey\('hello-count',\{applicationId:appId\}\)/u);
    assert.match(script,/globalThis[.]Arcane[?][.]runtime[?][.]current[?][.]\(\)/u);
    assert.match(script,/globalThis[.]Arcane[.]app[.]current\(\)/u);
    assert.match(script,/directoryPicker[.]select\(/u);
    assert.match(script,/function sayHello\(\)/u);
    assert.match(script,/Hello from Arcane OS!/u);
});

test('browser mode persists one app-scoped greeting and disables native work',async function verifyBrowserBehavior(){
    await runApplication(null,async({elements,values})=>{
        const action=elements.get('#app-action');
        const nativeAction=elements.get('#native-action');
        const status=elements.get('#app-status');
        const environment=elements.get('#app-environment');

        assert.equal(
            environment.textContent,
            'Browser mode · hello-world · Arcane theme and app-scoped storage'
        );
        assert.equal(nativeAction.disabled,true);
        await action.trigger('click');
        await action.trigger('click');
        assert.equal(values.get('arcane.apps.hello-world:hello-count'),'2');
        assert.equal(status.textContent,'Hello from Arcane OS! Greeting 2.');
    });
});

test('executable mode verifies identity, reads theme, and owns folder selection',async function verifyNativeBehavior(){
    const native=nativeArcaneHarness();
    await runApplication(native.arcane,async({elements})=>{
        const nativeAction=elements.get('#native-action');
        const status=elements.get('#app-status');
        const environment=elements.get('#app-environment');

        assert.equal(native.state.applicationCalls,2);
        assert.equal(native.state.preferenceReads.length,6);
        assert.deepEqual(native.state.preferenceWrites,[]);
        assert.equal(
            environment.textContent,
            'Executable mode · Arcane Hello World 0.1.0 · webview2'
        );
        assert.equal(nativeAction.disabled,false);

        await nativeAction.trigger('click');
        assert.equal(status.textContent,'Folder selection canceled.');
        assert.equal(nativeAction.disabled,false);

        native.state.selection={cancelled:false,path:'C:\\Arcane'};
        await nativeAction.trigger('click');
        assert.equal(status.textContent,'Arcane selected C:\\Arcane');
        assert.deepEqual(native.state.selectionRequests.at(-1),{
            title:'Choose a folder for Arcane Hello World'
        });

        native.state.selectionError=new Error('The native folder selector failed.');
        await nativeAction.trigger('click');
        assert.equal(status.textContent,'The native folder selector failed.');
        assert.equal(nativeAction.disabled,false);
    });

    const mismatched=nativeArcaneHarness('another-app');
    await assert.rejects(
        runApplication(mismatched.arcane,async()=>{}),
        error=>error?.code==='APP_DATA_SCOPE_MISMATCH'
    );
});
