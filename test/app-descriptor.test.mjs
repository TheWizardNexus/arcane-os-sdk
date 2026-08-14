import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
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

test('native descriptors require an included raster icon and exact origin policy',()=>{
    assert.throws(
        ()=>validateAppDescriptor(descriptor({native:{type:'app',icon:null,order:100,bundledApps:[]}})),
        /icon is required/u
    );
    assert.throws(
        ()=>validateAppDescriptor(descriptor({
            native:{type:'app',icon:'img/icon.svg',order:100,bundledApps:[]},
            package:{...descriptor().package,include:['img/icon.svg','index.html','manifest.json','modules']}
        })),
        /safe raster/u
    );
    assert.throws(
        ()=>validateAppDescriptor(descriptor({
            security:{connectOrigins:['http://example.com'],frameOrigins:[],mediaOrigins:[]}
        })),
        /numeric loopback/u
    );
    assert.throws(
        ()=>validateAppDescriptor(descriptor({
            security:{connectOrigins:[],frameOrigins:['https://example.com'],mediaOrigins:[]}
        })),
        /web\.embed/u
    );
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

test('legacy package-only apps remain browser-only without invented publisher attribution',async t=>{
    const workspaceRoot=await temporaryDirectory(t);
    const appRoot=path.join(workspaceRoot,'apps','legacy-app');
    await mkdir(appRoot,{recursive:true});
    const manifest={
        schemaVersion:1,
        id:'legacy-app',
        displayName:'Legacy App',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        include:['index.html'],
        exclude:[],
        shared:['browser-runtime']
    };
    const loaded=await loadAppDescriptor({workspaceRoot,appRoot,appId:'legacy-app',packageManifest:manifest});
    assert.equal(loaded.source,'legacy-package');
    assert.deepEqual(loaded.descriptor.targets,['browser']);
    assert.equal(loaded.descriptor.publisher.id,'publisher-undeclared');
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
