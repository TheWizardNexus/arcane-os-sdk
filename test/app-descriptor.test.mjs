import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {
    loadAppDescriptor,
    projectNativeDescriptor,
    projectPackageManifest,
    validateAppDescriptor
} from '../src/app-descriptor.mjs';
import {repositoryRoot,temporaryDirectory} from './helpers.mjs';

function descriptor(overrides={}){
    return {
        schemaVersion:2,
        id:'sample-app',
        displayName:'Sample App',
        description:'A sample Arcane application.',
        version:'1.2.3',
        publisher:{id:'sample-publisher',name:'Sample Publisher'},
        package:{
            entry:'index.html',
            strategy:'static',
            include:['img/icon.png','index.html','manifest.json','modules'],
            exclude:[],
            shared:['browser-runtime']
        },
        permissions:{
            capabilities:['appearance.read'],
            methods:['users.resetPassword']
        },
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        native:{type:'app',icon:'img/icon.png',order:100,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',minimumCoreVersion:'0.8.10',features:[]},
        targets:['windows-x64'],
        ...overrides
    };
}

test('native service selection preserves complete options without loading app modules',()=>{
    const authored=descriptor();
    const services=[
        {module:'server/repository-service.mjs',options:{label:'  Moon cheese 🧀\r\nAll of it.  ',nested:[null,false,0]}},
        {module:'server/second-service.mjs',options:null}
    ];
    authored.native.services=services;
    const normalized=validateAppDescriptor(authored);
    assert.deepEqual(normalized.native.services,services);
    assert.equal(normalized.native.services[0].options,services[0].options);
    assert.deepEqual(projectNativeDescriptor(authored).services,services);
    assert.equal(Object.hasOwn(projectPackageManifest(authored),'services'),false);
    assert.equal(Object.hasOwn(validateAppDescriptor(descriptor()).native,'services'),false);
});

test('native launch defaults retain complete authored records and remain opt-in',function nativeLaunchDefaults(){
    const launchContext={
        sharedHost:{},workspaceRoot:'../selected workspace',
        content:'  Every line.\r\n月 🧀  ',unknown:{values:[null,false,0,'']},
        ['__proto__']:{content:'An ordinary authored field.'}
    };
    const authored=descriptor();
    authored.native.launchContext=launchContext;
    assert.deepEqual(validateAppDescriptor(authored).native.launchContext,launchContext);
    assert.deepEqual(projectNativeDescriptor(authored).launchContext,launchContext);
    assert.equal(Object.hasOwn(projectPackageManifest(authored),'launchContext'),false);
    assert.equal(Object.hasOwn(validateAppDescriptor(descriptor()).native,'launchContext'),false);
    for(const value of [null,[],false,'launch.json']){
        authored.native.launchContext=value;
        assert.throws(function malformedLaunchDefaults(){validateAppDescriptor(authored);},{code:'ARCANE_APP_DESCRIPTOR_INVALID'});
    }
});

test('native window configuration preserves explicit choices and omitted defaults',function nativeWindowChoices(){
    for(const window of [undefined,{}, {width:1280,height:800,resizable:true}, {width:640}, {resizable:false},
        {state:'normal'}, {state:'maximized'}, {width:1280,height:800,resizable:false,state:'fullscreen'}]){
        const authored=descriptor();
        if(window!==undefined)authored.native.window=window;
        const original=structuredClone(authored);
        assert.deepEqual(validateAppDescriptor(authored).native.window,window);
        assert.deepEqual(projectNativeDescriptor(authored).window,window);
        assert.equal(Object.hasOwn(validateAppDescriptor(authored).native,'window'),window!==undefined);
        assert.equal(Object.hasOwn(projectNativeDescriptor(authored),'window'),window!==undefined);
        assert.equal(Object.hasOwn(projectPackageManifest(authored),'window'),false);
        assert.deepEqual(authored,original);
    }
});

test('native window configuration reports malformed public fields',function nativeWindowErrors(){
    for(const window of [null,[],{width:0},{width:-1},{width:1.5},{width:'1280'},{height:NaN},{height:Infinity},{resizable:1},{resizable:'true'},{left:50},
        {state:null},{state:false},{state:'Normal'},{state:'minimized'},{state:' full screen '}]){
        const authored=descriptor();
        authored.native.window=window;
        assert.throws(function validateWindow(){
            validateAppDescriptor(authored);
        },{code:'ARCANE_APP_DESCRIPTOR_INVALID'});
    }
});

test('native window selection survives registry descriptor synthesis',async function nativeWindowRegistry(t){
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','sample-app');
    await mkdir(appRoot,{recursive:true});
    const authored=descriptor();
    authored.native.window={width:1280,height:800,resizable:true,state:'maximized'};
    authored.native.launchContext={sharedHost:{},options:{complete:'  Moon cheese 🧀\r\n  '}};
    const registryRoot=path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle');
    await mkdir(registryRoot,{recursive:true});
    await writeFile(path.join(registryRoot,'arcane-apps.json'),JSON.stringify({
        apps:{'sample-app':projectNativeDescriptor(authored)}
    }));
    const loaded=await loadAppDescriptor({
        workspaceRoot,appRoot,appId:'sample-app',packageManifest:projectPackageManifest(authored)
    });
    assert.equal(loaded.source,'registry-projection');
    assert.deepEqual(loaded.descriptor.native.window,authored.native.window);
    assert.deepEqual(loaded.descriptor.native.launchContext,authored.native.launchContext);
});

test('canonical descriptor projects exact browser and native compatibility inputs',()=>{
    const value=validateAppDescriptor(descriptor(),{appId:'sample-app'});
    assert.deepEqual(projectPackageManifest(value),{
        schemaVersion:1,
        id:'sample-app',
        displayName:'Sample App',
        version:'1.2.3',
        entry:'index.html',
        strategy:'static',
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        include:['img/icon.png','index.html','manifest.json','modules'],
        exclude:[],
        shared:['browser-runtime']
    });
    assert.deepEqual(projectNativeDescriptor(value),{
        displayName:'Sample App',
        description:'A sample Arcane application.',
        icon:'img/icon.png',
        order:100,
        type:'app',
        source:'apps/sample-app',
        entry:'index.html',
        capabilities:['appearance.read'],
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        include:['img/icon.png','index.html','manifest.json','modules']
    });
    assert.deepEqual(value.targets,['windows-x64']);
});

test('native resource projection preserves omission, empty selection and app-owned paths',async t=>{
    const fixtures=path.join(repositoryRoot,'.arcane','native-resource-fixtures');
    await mkdir(fixtures,{recursive:true});
    const workspaceRoot=await mkdtemp(path.join(fixtures,'descriptor-'));
    t.after(()=>rm(workspaceRoot,{recursive:true,force:true}));
    const appRoot=path.join(workspaceRoot,'apps','sample-app');
    await mkdir(appRoot,{recursive:true});
    for(const nativeResources of [undefined,{include:[]},{include:['server','src','package.json'],exclude:['src/browser']}]){
        const authored=descriptor();
        if(nativeResources!==undefined)authored.package.nativeResources=nativeResources;
        const original=structuredClone(authored);
        const normalized=nativeResources===undefined?undefined:{exclude:[],...nativeResources};
        const value=validateAppDescriptor(authored);
        const manifest=projectPackageManifest(authored);
        assert.deepEqual(value.package.nativeResources,normalized);
        assert.deepEqual(manifest.nativeResources,normalized);
        assert.equal(Object.hasOwn(manifest,'nativeResources'),nativeResources!==undefined);
        assert.deepEqual(manifest.include,original.package.include);
        assert.deepEqual(projectNativeDescriptor(authored).include,original.package.include);
        assert.equal(Object.hasOwn(projectNativeDescriptor(authored),'nativeResources'),false);
        assert.deepEqual(authored,original);
        const synthesized=await loadAppDescriptor({workspaceRoot,appRoot,appId:'sample-app',packageManifest:manifest});
        assert.equal(synthesized.source,'package-projection');
        assert.deepEqual(synthesized.descriptor.package.nativeResources,normalized);
        await writeFile(path.join(appRoot,'arcane-app.json'),JSON.stringify(authored));
        const loaded=await loadAppDescriptor({workspaceRoot,appRoot,appId:'sample-app',packageManifest:manifest});
        assert.equal(loaded.source,'authored');
        assert.deepEqual(loaded.descriptor.package.nativeResources,normalized);
        await rm(path.join(appRoot,'arcane-app.json'));
    }
});

test('document selectors preserve authored omission, empty selection, and page paths through projection',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','sample-app');
    await mkdir(appRoot,{recursive:true});
    for(const documents of [undefined,[],['modules/review.HTM']]){
        const authored=descriptor();
        if(documents!==undefined)authored.package.documents=[...documents];
        const original=structuredClone(authored);
        const value=validateAppDescriptor(authored);
        const manifest=projectPackageManifest(authored);
        assert.equal(Object.hasOwn(value.package,'documents'),documents!==undefined);
        assert.equal(Object.hasOwn(manifest,'documents'),documents!==undefined);
        assert.deepEqual(value.package.documents,documents);
        assert.deepEqual(manifest.documents,documents);
        assert.deepEqual(authored,original);
        assert.equal(Object.hasOwn(projectNativeDescriptor(authored),'documents'),false);
        await writeFile(path.join(appRoot,'arcane-app.json'),`${JSON.stringify(authored,null,2)}\n`);
        const loaded=await loadAppDescriptor({
            workspaceRoot,appRoot,appId:'sample-app',packageManifest:manifest
        });
        assert.equal(loaded.source,'authored');
        assert.deepEqual(loaded.descriptor.package.documents,documents);
        assert.deepEqual(projectPackageManifest(loaded.descriptor),manifest);
    }
});

test('package-only descriptor synthesis retains an explicit document selector',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','sample-app');
    await mkdir(appRoot,{recursive:true});
    for(const documents of [undefined,[],['modules/review.html']]){
        const manifest=projectPackageManifest(descriptor());
        if(documents!==undefined)manifest.documents=[...documents];
        const loaded=await loadAppDescriptor({
            workspaceRoot,appRoot,appId:'sample-app',packageManifest:manifest
        });
        assert.equal(loaded.source,'package-projection');
        assert.equal(Object.hasOwn(loaded.descriptor.package,'documents'),documents!==undefined);
        assert.deepEqual(loaded.descriptor.package.documents,documents);
        assert.deepEqual(projectPackageManifest(loaded.descriptor).documents,documents);
    }
});

test('ordinary browser descriptors normalize omitted capability and origin declarations',()=>{
    const browser=descriptor({
        native:{type:'app',icon:null,order:100,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',features:[]},
        targets:['browser']
    });
    Reflect.deleteProperty(browser,'permissions');
    Reflect.deleteProperty(browser,'security');
    const value=validateAppDescriptor(browser,{appId:'sample-app'});
    assert.deepEqual(value.permissions,{capabilities:[],methods:[]});
    assert.deepEqual(value.security,{connectOrigins:[],frameOrigins:[],mediaOrigins:[]});
    assert.equal(Object.hasOwn(value.requirements,'minimumCoreVersion'),false);
    assert.equal(Object.hasOwn(projectPackageManifest(browser),'security'),false);

    const native=descriptor({requirements:{arcaneProtocol:'arcane/1',features:[]}});
    assert.throws(
        ()=>validateAppDescriptor(native),
        /minimumCoreVersion is required for non-browser targets/u
    );
});

test('native descriptors require an included icon and preserve explicit origin declarations',()=>{
    assert.throws(
        ()=>validateAppDescriptor(descriptor({native:{type:'app',icon:null,order:100,bundledApps:[]}})),
        /icon is required/u
    );
    const svg=validateAppDescriptor(descriptor({
        native:{type:'app',icon:'img/icon.svg',order:100,bundledApps:[]},
        package:{...descriptor().package,include:['img/icon.svg','index.html','manifest.json','modules']},
        security:{connectOrigins:['http://example.com'],frameOrigins:['https://example.com'],mediaOrigins:[]}
    }));
    assert.equal(svg.native.icon,'img/icon.svg');
    assert.deepEqual(svg.security.connectOrigins,['http://example.com']);
    assert.deepEqual(svg.security.frameOrigins,['https://example.com']);
});

test('browser compatibility accepts the reviewed https scheme frame policy only for browser',()=>{
    const browser=descriptor({
        id:'browser',
        permissions:{capabilities:['web.embed'],methods:[]},
        native:{type:'app',icon:'img/icon.png',order:100,bundledApps:[]},
        security:{connectOrigins:[],frameOrigins:['https:'],mediaOrigins:[]},
        targets:['browser']
    });
    assert.deepEqual(validateAppDescriptor(browser).security.frameOrigins,['https:']);
    assert.throws(()=>projectNativeDescriptor(browser),/browser-only descriptor/u);
    assert.throws(
        ()=>validateAppDescriptor({...browser,id:'not-browser'}),
        /not a valid URL origin/u
    );
});

test('package-only projections remain browser-only without invented publisher attribution',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','projected-app');
    await mkdir(appRoot,{recursive:true});
    const manifest={
        schemaVersion:1,
        id:'projected-app',
        displayName:'Projected App',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        include:['index.html'],
        exclude:[],
        shared:['browser-runtime']
    };
    const loaded=await loadAppDescriptor({workspaceRoot,appRoot,appId:'projected-app',packageManifest:manifest});
    assert.equal(loaded.source,'package-projection');
    assert.deepEqual(loaded.descriptor.targets,['browser']);
    assert.equal(loaded.descriptor.publisher.id,'publisher-undeclared');
});

test('registry projections expose every implemented native development target',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','registry-native');
    await mkdir(appRoot,{recursive:true});
    const manifest={
        schemaVersion:1,
        id:'registry-native',
        displayName:'Registry Native',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        include:['img/icon.png','index.html'],
        exclude:[],
        shared:['browser-runtime']
    };
    await mkdir(path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle'),{recursive:true});
    await writeFile(path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle','arcane-apps.json'),JSON.stringify({
        apps:{
            'registry-native':{
                description:'A registry-projected native Arcane application.',
                icon:'img/icon.png',
                order:100,
                type:'app',
                capabilities:[],
                security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]}
            }
        }
    }));
    const loaded=await loadAppDescriptor({workspaceRoot,appRoot,appId:'registry-native',packageManifest:manifest});
    assert.equal(loaded.source,'registry-projection');
    assert.deepEqual(loaded.descriptor.targets,[
        'android-arm64','browser','linux-arm64','linux-x64','portable','windows-x64'
    ]);
});

test('package-projection security remains authoritative without a registry admission gate',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','registry-native');
    await mkdir(appRoot,{recursive:true});
    const manifest={
        schemaVersion:1,
        id:'registry-native',
        displayName:'Registry Native',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        security:{connectOrigins:[],frameOrigins:[],mediaOrigins:[]},
        include:['index.html'],
        exclude:[],
        shared:['browser-runtime']
    };
    await mkdir(path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle'),{recursive:true});
    await writeFile(path.join(workspaceRoot,'machine_bundles','arcane-os-machine-bundle','arcane-apps.json'),JSON.stringify({
        apps:{
            'registry-native':{
                description:'A registry-projected native Arcane application.',
                icon:null,
                order:100,
                type:'app',
                capabilities:[],
                security:{
                    connectOrigins:['https://native.example.com'],
                    frameOrigins:[],
                    mediaOrigins:[]
                }
            }
        }
    }));
    const loaded=await loadAppDescriptor({workspaceRoot,appRoot,appId:'registry-native',packageManifest:manifest});
    assert.deepEqual(loaded.descriptor.security,manifest.security);
});

test('authored descriptor must project exactly to the compatibility package manifest',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','sample-app');
    await mkdir(appRoot,{recursive:true});
    const authored=descriptor({targets:['browser']});
    await writeFile(path.join(appRoot,'arcane-app.json'),`${JSON.stringify(authored,null,2)}\n`);
    const manifest=projectPackageManifest(authored);
    manifest.version='9.9.9';
    await assert.rejects(
        loadAppDescriptor({workspaceRoot,appRoot,appId:'sample-app',packageManifest:manifest}),
        /does not project exactly/u
    );
});
