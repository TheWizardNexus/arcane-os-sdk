import assert from 'node:assert/strict';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
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
    assert.equal(installed.code,0,[installed.stderr,installed.stdout].join('\n'));

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
import SpeechPlayback,{SPEECH_VOICE_ALIASES,SPEECH_VOICE_OPTIONS} from 'arcane-os/speech-playback';
import {MarkdownSpeech,stripSpeechFormatting} from 'arcane-os/speech-text';

test('installed public SDK entrypoints and runtime materialization are functional',async()=>{
    assert.equal(SDK_VERSION,${JSON.stringify(verified.version)});
    assert.equal(typeof createEventManager,'function');
    assert.ok(Array.isArray(listTargets()));
    assert.equal(typeof mail.Mail,'function');
    assert.equal(typeof PreferenceStore,'function');
    assert.equal(typeof SpeechPlayback,'function');
    assert.equal(typeof MarkdownSpeech,'function');
    assert.equal(stripSpeechFormatting('**Installed speech.**'),'Installed speech.');
    const speechVoiceValues=SPEECH_VOICE_OPTIONS.map(
        function speechVoiceValue(option){return option.value;}
    );
    assert.deepEqual(speechVoiceValues,[
        'alloy','ash','ballad','coral','echo',
        'fable','nova','onyx','sage','shimmer'
    ]);
    assert.deepEqual([...SPEECH_VOICE_ALIASES],speechVoiceValues);
    const speechStates=[];
    const speechAudio=new EventTarget();
    speechAudio.pause=function pauseSpeechAudio(){};
    speechAudio.removeAttribute=function removeSpeechAudioAttribute(){};
    speechAudio.load=function loadSpeechAudio(){};
    const speechPlayback=new SpeechPlayback({
        audio:speechAudio,
        onState:function recordSpeechPlaybackState(detail){
            speechStates.push(detail);
        }
    });
    speechPlayback.cancel();
    assert.equal(speechStates.at(-1)?.state,'idle');
    assert.equal(Object.isFrozen(speechStates.at(-1)),false);
    assert.equal(speechPlayback.destroy(),true);
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
    assert.equal(contractResult.code,0,[contractResult.stderr,contractResult.stdout].join('\n'));
    assert.match(contractResult.stdout,/Test Total : 1/u);
    assert.match(contractResult.stdout,/Passed :[^\r\n]*1/u);

    const importMapResult=await runNpm([
        'exec','--offline','--','arcane','import-map',
        '--workspace','.',
        '--app',appId,
        '--output','json'
    ],{cwd:consumerRoot,timeout:60_000});
    assert.equal(importMapResult.code,0,[importMapResult.stderr,importMapResult.stdout].join('\n'));
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
    assert.equal(cliResult.code,0,[cliResult.stderr,cliResult.stdout].join('\n'));
    assert.equal(cliResult.stdout.trim(),verified.version);

    // The same installed consumer can serve and package directly from npm.
    // Remove only this fixture's earlier materialized runtime and stale lock.
    await rm(path.join(consumerRoot,'arcane'),{recursive:true});
    await rm(path.join(consumerRoot,'arcane.lock.json'));
    await writeConsumerFile(consumerRoot,'arcane-packager.json',json({
        schemaVersion:1,appsRoot:'apps',distRoot:'dist',
        sharedPayloads:{'browser-runtime':[
            {
                source:'node_modules/arcane-os/runtime/arcane',destination:'arcane',
                include:['components','css','entities','img','modules'],exclude:[]
            },
            {
                source:'node_modules/arcane-os/browser-runtime',destination:'arcane/sdk',
                include:['.'],exclude:[]
            },
            {
                source:'node_modules/arcane-os/runtime/strong-type',
                destination:'arcane/dependencies/strong-type',include:['.'],exclude:[]
            },
            {
                source:'node_modules/arcane-os',destination:'licenses/arcane-os',
                include:['LICENSE','COMMERCIAL-LICENSE.md','NOTICE'],exclude:[]
            }
        ]}
    }));
    const rootAppId='release-smoke-root';
    const rootModule="import 'arcane/ThemeBootstrap';\nexport const testimony = '  Keep the complete root application content.  ';\n";
    const rootFiles=[
        ['arcane-package.json',json({
            schemaVersion:1,id:rootAppId,displayName:'Root Application Release Smoke',version:'0.1.0',
            entry:'index.html',strategy:'static',include:['app.css','index.html','modules'],
            exclude:[],shared:['browser-runtime'],pwa:{enabled:true}
        })],
        ['index.html','<!doctype html><html lang="en"><head>'
            +`<meta name="arcane-app-id" content="${rootAppId}"><base href="./">`
            +'<link rel="stylesheet" href="./node_modules/arcane-os/runtime/arcane/css/theme.css">'
            +'<link rel="stylesheet" href="./node_modules/arcane-os/runtime/arcane/css/primitives.css">'
            +'<link rel="stylesheet" href="./app.css">'
            +'</head><body><main>  Complete root application content.  </main>'
            +'<script type="module" src="./modules/App.js"></script></body></html>\n'],
        ['app.css','main { display: block; white-space: pre-wrap; }\n'],
        ['modules/App.js',rootModule]
    ];
    const installedOnlyContract=path.join(testRoot,'installed-package-only.test.mjs');
    await writeFile(installedOnlyContract,`import assert from 'node:assert/strict';
import {mkdir,readFile,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createToolchain,packageApp,resolveWorkspace,startDevServer,validateWorkspace} from 'arcane-os';
import test from 'arcane-os/testing';
import {parseModelDefinition} from 'arcane-os/model-definition';
import {hasConversationEntry} from 'arcane-os/chat-records';
import {normalizeConversationActionItems} from 'arcane-os/conversation-action-items';
import {formatConversationClosingReportText} from 'arcane-os/conversation-closing-report';

test('installed npm sources own maps, development serving and portable output',{timeout:120_000},async function installedPackageOnly(){
    const workspaceRoot=process.cwd();
    const appId=${JSON.stringify(appId)};
    const appRoot=path.join(workspaceRoot,'apps',appId);
    const installedRoot=path.join(workspaceRoot,'node_modules','arcane-os');
    const projection=path.join(workspaceRoot,'arcane');
    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    const version=${JSON.stringify(verified.version)};
    await assert.rejects(stat(projection),{code:'ENOENT'});
    await assert.rejects(stat(lockPath),{code:'ENOENT'});
    const resolved=await resolveWorkspace({workspaceRoot,appId});
    assert.equal(resolved.config.browserRuntimeLayout,'installed-v1');
    assert.equal(resolved.config.sdkPackageSource,'node_modules/arcane-os');
    assert.equal((await validateWorkspace({workspaceRoot,appId})).valid,true);
    for(const name of [
        'ai','ai-preference-tuple','ai-preference-runtime','ai-provider-runtime',
        'ai-runtime-state','model-definition','conversation-timebox',
        'conversation-action-items','conversation-closing-report','chat-records',
        'app-data-scope','core-local-model-catalog','dbopfs-document-library',
        'local-ai-readiness','ollama-model-identifier'
    ]){
        const resolvedModule=new URL(import.meta.resolve('arcane-os/'+name));
        assert.equal(resolvedModule.protocol,'file:');
        assert.ok(resolvedModule.pathname.includes('/runtime/arcane/modules/'),name);
    }
    // Pure shared modules execute in Node; browser-only AI is resolved above.
    const definition=parseModelDefinition(${JSON.stringify('FROM installed-fixture\n\nSYSTEM """\nComplete installed prompt.\n"""\n')});
    assert.equal(definition.system,'Complete installed prompt.');
    assert.equal(hasConversationEntry([{role:'user',content:'Complete conversation.'}]),true);
    assert.deepEqual(normalizeConversationActionItems([]),[]);
    assert.equal(typeof formatConversationClosingReportText,'function');

    const toolchain=createToolchain({workspaceRoot,appId});
    await writeFile(lockPath,JSON.stringify({sdk:{version:'0.0.1'}}));
    console.log('[installed-package] Legacy application import-map.');
    await toolchain.importMap();
    const mapPath=path.join(appRoot,'modules','arcane.importmap.json');
    const versionedMap=JSON.parse(await readFile(mapPath,'utf8'));
    assert.equal(versionedMap.imports['arcane/ThemeBootstrap'],
        './arcane/modules/ThemeBootstrap.js?arcaneVersion='+version);
    assert.equal(versionedMap.imports['arcane-os/model-definition'],
        './arcane/modules/ModelDefinition.js?arcaneVersion='+version);
    assert.equal(versionedMap.imports['arcane-os/mail'],
        './arcane/modules/MailApi.mjs?arcaneVersion='+version);
    assert.deepEqual(JSON.parse(await readFile(lockPath,'utf8')),{sdk:{version:'0.0.1'}});
    await rm(lockPath);
    assert.equal(await readFile(path.join(appRoot,'components','status.html'),'utf8'),${JSON.stringify(fragmentSource)});
    for(const filename of ['index.html','pages/review.html']){
        const page=await readFile(path.join(appRoot,filename),'utf8');
        assert.ok(page.includes('data-arcane-import-map'));
    }

    const descriptorPath=path.join(appRoot,'arcane-app.json');
    const packagePath=path.join(appRoot,'arcane-package.json');
    const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
    const manifest=JSON.parse(await readFile(packagePath,'utf8'));
    descriptor.package.pwa={enabled:true};
    manifest.pwa={enabled:true};
    await Promise.all([
        writeFile(descriptorPath,JSON.stringify(descriptor)),
        writeFile(packagePath,JSON.stringify(manifest))
    ]);
    console.log('[installed-package] Legacy PWA import-map.');
    await toolchain.importMap();
    const logicalPaths=[
        '/arcane/components/chat.html',
        '/arcane/modules/ThemeBootstrap.js',
        '/arcane/sdk/event-manager.mjs',
        '/arcane/sdk/ai/browser-speech.mjs',
        '/arcane/dependencies/strong-type/index.js',
        '/licenses/arcane-os/LICENSE'
    ];
    console.log('[installed-package] Legacy application serving.');
    const instance=await startDevServer({workspaceRoot,appId,http:true,host:'127.0.0.1',port:0});
    try{
        for(const logicalPath of logicalPaths){
            const response=await fetch(new URL(logicalPath,instance.origin));
            assert.equal(response.status,200,logicalPath);
            const content=await response.text();
            assert.notEqual(content,'',logicalPath);
            if(logicalPath==='/licenses/arcane-os/LICENSE'){
                assert.equal(content,await readFile(path.join(installedRoot,'LICENSE'),'utf8'));
            }
        }
        const response=await fetch(new URL('/arcane-offline.json',instance.origin));
        assert.equal(response.status,200);
        const offline=await response.json();
        assert.equal(offline.sdkVersion,version);
        for(const logicalPath of logicalPaths){assert.ok(offline.assets.includes(logicalPath),logicalPath);}
        assert.equal(offline.assets.some(function packageUrl(url){return url.includes('node_modules/');}),false);
    }finally{
        await instance.close();
    }
    console.log('[installed-package] Legacy application packaging.');
    const packaged=await packageApp({workspaceRoot,appId});
    for(const logicalPath of logicalPaths){
        assert.ok(packaged.files.includes(logicalPath.substring(1)),logicalPath);
    }
    assert.equal(packaged.files.some(function packagePath(file){
        return file.startsWith('node_modules/')||file.includes('/./');
    }),false);
    assert.equal(await readFile(path.join(packaged.outputRoot,'apps',appId,'components','status.html'),'utf8'),${JSON.stringify(fragmentSource)});
    const offline=JSON.parse(await readFile(path.join(packaged.outputRoot,'arcane-offline.json'),'utf8'));
    assert.equal(offline.sdkVersion,version);
    for(const logicalPath of logicalPaths){assert.ok(offline.assets.includes('.'+logicalPath),logicalPath);}
    await assert.rejects(stat(projection),{code:'ENOENT'});
    await assert.rejects(stat(lockPath),{code:'ENOENT'});

    // Reuse this installed tarball for a distinct standalone root application.
    const rootAppId=${JSON.stringify(rootAppId)};
    const rootConfigPath=path.join(workspaceRoot,'arcane-packager.json');
    const rootConfig=JSON.parse(await readFile(rootConfigPath,'utf8'));
    rootConfig.appsRoot='.';
    rootConfig.sharedPayloads['browser-runtime']=rootConfig.sharedPayloads['browser-runtime'].map(
        function directInstalledDestination(route){return {...route,destination:route.source};}
    );
    await writeFile(rootConfigPath,JSON.stringify(rootConfig),'utf8');
    const rootFiles=${JSON.stringify(rootFiles)};
    await Promise.all(rootFiles.map(async function writeRootFile([relative,content]){
        const filePath=path.join(workspaceRoot,...relative.split('/'));
        await mkdir(path.dirname(filePath),{recursive:true});
        await writeFile(filePath,content,'utf8');
    }));
    const rootToolchain=createToolchain({workspaceRoot,appId:rootAppId});
    console.log('[installed-package] Root application import-map.');
    await rootToolchain.importMap();
    const rootMap=JSON.parse(await readFile(path.join(workspaceRoot,'modules','arcane.importmap.json'),'utf8'));
    const rootTheme='./node_modules/arcane-os/runtime/arcane/modules/ThemeBootstrap.js';
    assert.equal(rootMap.imports['arcane/ThemeBootstrap'],rootTheme);
    assert.equal(rootMap.imports[rootTheme],rootTheme);
    assert.equal(rootMap.imports['arcane-os/event-manager'],'./node_modules/arcane-os/browser-runtime/event-manager.mjs');
    assert.equal(rootMap.imports['strong-type'],'./node_modules/arcane-os/runtime/strong-type/index.js');
    const rootWebManifest=JSON.parse(await readFile(path.join(workspaceRoot,'arcane.webmanifest'),'utf8'));
    assert.equal(rootWebManifest.id,'/apps/'+rootAppId+'/');
    assert.equal(rootWebManifest.start_url,'/index.html');
    assert.equal(rootWebManifest.scope,'/');
    for(const generated of ['arcane-pwa.mjs','arcane-sw.js','arcane-offline.json']){
        assert.equal((await stat(path.join(workspaceRoot,generated))).isFile(),true,generated);
    }
    const rootBootstrap=await readFile(path.join(workspaceRoot,'arcane-pwa.mjs'),'utf8');
    assert.ok(rootBootstrap.includes('"/node_modules/arcane-os/browser-runtime/pwa.mjs"'));
    console.log('[installed-package] Root application packaging.');
    const rootPackaged=await packageApp({workspaceRoot,appId:rootAppId});
    assert.ok(rootPackaged.files.includes('index.html'));
    for(const relative of [
        'runtime/arcane/modules/ThemeBootstrap.js','browser-runtime/event-manager.mjs',
        'runtime/strong-type/index.js','LICENSE'
    ]){
        const selected='node_modules/arcane-os/'+relative;
        assert.ok(rootPackaged.files.includes(selected),selected);
        assert.equal(await readFile(path.join(rootPackaged.outputRoot,selected),'utf8'),
            await readFile(path.join(installedRoot,relative),'utf8'),selected);
    }
    const rootPackagedManifest=JSON.parse(await readFile(path.join(rootPackaged.outputRoot,'arcane.webmanifest'),'utf8'));
    assert.equal(rootPackagedManifest.id,'./');
    assert.equal(rootPackagedManifest.scope,'./');
    assert.equal(await readFile(path.join(rootPackaged.outputRoot,'modules','App.js'),'utf8'),${JSON.stringify(rootModule)});
    await assert.rejects(stat(projection),{code:'ENOENT'});
    await assert.rejects(stat(lockPath),{code:'ENOENT'});
    console.log('[installed-package] Complete.');
});
`);
    const installedOnlyResult=await runNode([installedTestRunner,installedOnlyContract],{
        cwd:consumerRoot,timeout:150_000
    });
    assert.equal(installedOnlyResult.code,0,[installedOnlyResult.stderr,installedOnlyResult.stdout].join('\n'));
    assert.match(installedOnlyResult.stdout,/Test Total : 1/u);
    assert.match(installedOnlyResult.stdout,/Passed :[^\r\n]*1/u);
});
