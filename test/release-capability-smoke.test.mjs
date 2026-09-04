import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {verifyNpmReleaseArtifact} from '../tools/npm-release-contract.mjs';
import {runCommand,runNode,temporaryDirectory} from './helpers.mjs';

function runNpm(arguments_,options){
    if(process.platform==='win32'){
        const npmCli=process.env.npm_execpath??path.join(
            path.dirname(process.execPath),
            'node_modules','npm','bin','npm-cli.js'
        );
        return runNode([npmCli,...arguments_],options);
    }
    return runCommand('npm',arguments_,options);
}

async function writeConsumerFile(consumerRoot,relative,content){
    const filePath=path.join(consumerRoot,...relative.split('/'));
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,content,'utf8');
    return filePath;
}

function json(value){
    return `${JSON.stringify(value,null,2)}\n`;
}

function browserDocument({appId,base,title}){
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="arcane-app-id" content="${appId}">
    <base href="${base}">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <link rel="stylesheet" href="./arcane/css/theme.css">
    <link rel="stylesheet" href="./arcane/css/primitives.css">
    <link rel="stylesheet" href="./apps/${appId}/app.css">
</head>
<body>
    <main>${title}</main>
    <script type="module" src="./apps/${appId}/modules/App.js"></script>
</body>
</html>
`;
}

test('the selected npm tarball installs and exposes the public SDK',{
    timeout:180_000
},async t=>{
    const tarballPath=process.env.ARCANE_SDK_NPM_RELEASE_TARBALL;
    if(!tarballPath)return;

    assert.equal(process.platform,process.env.ARCANE_SDK_EXPECTED_PLATFORM);
    assert.equal(process.arch,process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE);
    const verified=await verifyNpmReleaseArtifact({tarballPath});

    const temporary=await temporaryDirectory(t,{prefix:'arcane-release-smoke-'});
    const consumerRoot=path.join(temporary,'consumer');
    await mkdir(consumerRoot);
    await writeFile(path.join(consumerRoot,'package.json'),`${JSON.stringify({
        name:'arcane-release-capability-smoke',
        private:true,
        type:'module'
    },null,2)}\n`);

    const installed=await runNpm([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-exact',
        verified.tarballPath
    ],{cwd:consumerRoot,timeout:90_000});
    assert.equal(installed.code,0,installed.stderr);

    const installedRoot=path.join(consumerRoot,'node_modules','arcane-os');
    const installedPackage=JSON.parse(await readFile(
        path.join(installedRoot,'package.json'),
        'utf8'
    ));
    assert.equal(installedPackage.name,'arcane-os');
    assert.equal(installedPackage.version,verified.version);
    assert.equal(installedPackage.exports['./mail'],'./src/mail-api.mjs');
    assert.equal(installedPackage.exports['./testing'],'./src/testing.mjs');
    assert.equal(
        installedPackage.exports['./preference-store'],
        './runtime/arcane/modules/PreferenceStore.js'
    );
    assert.equal(
        installedPackage.exports['./speech-playback'],
        './runtime/arcane/modules/SpeechPlayback.js'
    );

    const appId='release-smoke-app';
    const appRoot=path.join(consumerRoot,'apps',appId);
    const include=['app.css','components','index.html','manifest.json','modules','pages'];
    await writeConsumerFile(consumerRoot,'arcane-packager.json',json({
        schemaVersion:1,
        appsRoot:'apps',
        distRoot:'dist',
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'arcane',
                    destination:'arcane',
                    include:['components','css','dependencies','entities','img','modules','sdk','security'],
                    exclude:[]
                },
                {
                    source:'node_modules/arcane-os',
                    destination:'licenses/arcane-os',
                    include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],
                    exclude:[]
                }
            ]
        }
    }));
    await writeConsumerFile(consumerRoot,`apps/${appId}/arcane-app.json`,json({
        schemaVersion:2,
        id:appId,
        displayName:'Release Smoke App',
        description:'Synthetic installed-package import-map coverage.',
        version:'0.1.0',
        publisher:{id:'arcane-sdk',name:'Arcane SDK'},
        package:{
            entry:'index.html',
            strategy:'static',
            include,
            exclude:[],
            shared:['browser-runtime']
        },
        native:{type:'app',icon:null,order:100,bundledApps:[]},
        requirements:{arcaneProtocol:'arcane/1',features:[]},
        targets:['browser']
    }));
    await writeConsumerFile(consumerRoot,`apps/${appId}/arcane-package.json`,json({
        schemaVersion:1,
        id:appId,
        displayName:'Release Smoke App',
        version:'0.1.0',
        entry:'index.html',
        strategy:'static',
        include,
        exclude:[],
        shared:['browser-runtime']
    }));
    await writeConsumerFile(
        consumerRoot,
        `apps/${appId}/index.html`,
        browserDocument({appId,base:'../../',title:'Release smoke entry'})
    );
    await writeConsumerFile(
        consumerRoot,
        `apps/${appId}/pages/review.html`,
        browserDocument({appId,base:'../../../',title:'Release smoke review'})
    );
    const fragmentSource='<section data-release-smoke-fragment>Preserved fragment</section>\n';
    const fragmentPath=await writeConsumerFile(
        consumerRoot,
        `apps/${appId}/components/status.html`,
        fragmentSource
    );
    await writeConsumerFile(
        consumerRoot,
        `apps/${appId}/modules/App.js`,
        "import ThemeBootstrap from 'arcane/ThemeBootstrap';\nvoid ThemeBootstrap;\n"
    );
    await writeConsumerFile(consumerRoot,`apps/${appId}/app.css`,'main { display: block; }\n');
    await writeConsumerFile(consumerRoot,`apps/${appId}/manifest.json`,json({
        name:'Release Smoke App',
        short_name:'Release Smoke',
        start_url:'./index.html',
        display:'standalone',
        icons:[]
    }));
    await writeConsumerFile(consumerRoot,'arcane.lock.json',json({
        schemaVersion:1,
        sdk:{name:'arcane-os',version:'0.3.1'},
        runtime:{root:'node_modules/arcane-os/runtime'},
        sdkBrowserRuntime:{root:'node_modules/arcane-os/browser-runtime'},
        protocols:{
            arcane:'arcane/1',
            cliEvents:'arcane-cli-events/1',
            targetAdapter:'arcane-target-adapter/1'
        }
    }));
    await writeConsumerFile(
        consumerRoot,
        '.arcane/preserved.txt',
        'preserve this workspace entry\n'
    );
    const testRoot=path.join(consumerRoot,'test');
    await mkdir(testRoot);
    const capabilityContract=path.join(testRoot,'installed-capability.test.mjs');
    await writeFile(capabilityContract,`import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {SDK_VERSION,createEventManager,listTargets,materializeInstalledSdkRuntime} from 'arcane-os';
import test from 'arcane-os/testing';
import * as browserSpeech from 'arcane-os/ai/browser-speech';
import * as browserWasm from 'arcane-os/ai/browser-wasm';
import * as mail from 'arcane-os/mail';
import PreferenceStore from 'arcane-os/preference-store';
import SpeechPlayback from 'arcane-os/speech-playback';

test('installed public SDK entrypoints and runtime materialization are functional',async()=>{
    assert.equal(SDK_VERSION,${JSON.stringify(verified.version)});
    assert.equal(typeof createEventManager,'function');
    assert.ok(Array.isArray(listTargets()));
    assert.equal(typeof mail.Mail,'function');
    assert.equal(typeof PreferenceStore,'function');
    assert.equal(typeof SpeechPlayback,'function');
    assert.equal(typeof browserSpeech.createBrowserWhisperProvider,'function');
    assert.equal(typeof browserSpeech.createBrowserKokoroProvider,'function');
    assert.equal(typeof browserWasm.createBrowserWasmLlmProvider,'function');
    assert.equal(typeof browserWasm.createArcaneAI,'function');
    const workspaceRoot=process.cwd();
    const materialized=await materializeInstalledSdkRuntime({workspaceRoot});
    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    const lock=JSON.parse(await readFile(lockPath,'utf8'));
    assert.equal(materialized.workspaceLock.path,lockPath);
    assert.deepEqual(materialized.workspaceLock.document,lock);
    assert.deepEqual(lock,{
        schemaVersion:1,
        sdk:{name:'arcane-os',version:${JSON.stringify(verified.version)}},
        runtime:{root:'node_modules/arcane-os/runtime'},
        sdkBrowserRuntime:{root:'node_modules/arcane-os/browser-runtime'},
        protocols:{
            arcane:'arcane/1',
            cliEvents:'arcane-cli-events/1',
            targetAdapter:'arcane-target-adapter/1'
        }
    });
    assert.equal(
        await readFile(path.join(workspaceRoot,'.arcane','preserved.txt'),'utf8'),
        'preserve this workspace entry\\n'
    );
});
`);

    const installedTestRunner=path.join(installedRoot,'bin','arcane-test.mjs');
    const contractResult=await runNode([installedTestRunner,capabilityContract],{
        cwd:consumerRoot,
        timeout:60_000
    });
    assert.equal(contractResult.code,0,contractResult.stderr);
    assert.match(contractResult.stdout,/Test Total : 1/u);
    assert.match(contractResult.stdout,/Passed :[^\r\n]*1/u);

    const importMapResult=await runNpm([
        'exec','--offline','--','arcane','import-map',
        '--workspace','.',
        '--app',appId,
        '--output','json'
    ],{cwd:consumerRoot,timeout:60_000});
    assert.equal(importMapResult.code,0,importMapResult.stderr||importMapResult.stdout);
    const entrySource=await readFile(path.join(appRoot,'index.html'),'utf8');
    const reviewSource=await readFile(path.join(appRoot,'pages','review.html'),'utf8');
    assert.match(entrySource,/<script type="importmap" data-arcane-import-map>/u);
    assert.match(reviewSource,/<script type="importmap" data-arcane-import-map>/u);
    assert.equal(await readFile(fragmentPath,'utf8'),fragmentSource);
    const managedMap=JSON.parse(await readFile(
        path.join(appRoot,'modules','arcane.importmap.json'),
        'utf8'
    ));
    assert.equal(typeof managedMap.imports['arcane/ThemeBootstrap'],'string');

    const cliResult=await runNpm(
        ['exec','--offline','--','arcane','--version'],
        {cwd:consumerRoot,timeout:30_000}
    );
    assert.equal(cliResult.code,0,cliResult.stderr);
    assert.equal(cliResult.stdout.trim(),verified.version);
});
