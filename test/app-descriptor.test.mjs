import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {
    loadAppDescriptor,
    projectNativeDescriptor,
    projectPackageManifest,
    validateAppDescriptor
} from '../src/app-descriptor.mjs';
import {temporaryDirectory} from './helpers.mjs';

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
