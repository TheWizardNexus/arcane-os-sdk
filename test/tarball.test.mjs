import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import test from '../src/testing.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {SDK_VERSION} from '../src/constants.mjs';
import {loadSdkBrowserRuntimeRelease} from '../src/sdk-browser-runtime.mjs';
import {verifyNpmReleaseArtifact} from '../tools/npm-release-contract.mjs';
import {
    repositoryRoot,
    runCommand,
    runNode,
    parseLastJsonLine,
    temporaryDirectory
} from './helpers.mjs';

const SDK_BROWSER_RUNTIME_RELEASE=await loadSdkBrowserRuntimeRelease();
const SDK_BROWSER_RUNTIME_FILES=Object.freeze(
    SDK_BROWSER_RUNTIME_RELEASE.files.map(file=>file.path)
);
const SDK_BROWSER_RUNTIME_PACKAGE_FILES=Object.freeze([
    'ARCANE_SDK_BROWSER_RELEASE.json',
    ...SDK_BROWSER_RUNTIME_FILES
].map(file=>`browser-runtime/${file}`).sort());
const AUTHORITATIVE_BROWSER_AI_CONTRACT=
    process.env.ARCANE_BROWSER_AI_RUNTIME_CONTRACT==='1';
const DEBUG_BROWSER_AI_CONTRACT=
    process.env.ARCANE_BROWSER_AI_DEBUG_CONTRACT==='1';
const BROWSER_AI_CONTRACT_ENABLED=
    AUTHORITATIVE_BROWSER_AI_CONTRACT||DEBUG_BROWSER_AI_CONTRACT;
const DEBUG_MODEL_PATH_PRESENT=Object.hasOwn(
    process.env,
    'ARCANE_BROWSER_AI_DEBUG_MODEL_PATH'
);
const FORBIDDEN_PACKED_ASSET_EXTENSION=
    /\.(?:gguf|ggml|safetensors|onnx|ort|tflite|mlmodel|pb|pt|pth|bin|data|exe|dll|so|dylib|node|a|lib|wav|flac|mp3|ogg|opus)$/iu;
const PACKED_WASM_ALLOWLIST=Object.freeze(
    SDK_BROWSER_RUNTIME_FILES
        .filter(file=>file.toLowerCase().endsWith('.wasm'))
        .map(file=>`browser-runtime/${file}`)
        .sort()
);

async function realFileInventory(root,relativeRoot=''){
    const files=[];
    const entries=await readdir(path.join(root,...relativeRoot.split('/').filter(Boolean)),{
        withFileTypes:true
    });
    entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0);
    for(const entry of entries){
        assert.equal(entry.isSymbolicLink(),false,`Installed browser runtime links ${entry.name}.`);
        const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
        if(entry.isDirectory())files.push(...await realFileInventory(root,relative));
        else{
            assert.equal(entry.isFile(),true,`Installed browser runtime contains ${relative}.`);
            files.push(relative);
        }
    }
    return files.sort();
}

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

test('packed npm artifact installs and drives an external repository end to end',{
    timeout:BROWSER_AI_CONTRACT_ENABLED?3_600_000:600_000
},async t=>{
    assert.equal(
        AUTHORITATIVE_BROWSER_AI_CONTRACT&&DEBUG_BROWSER_AI_CONTRACT,
        false,
        'Authoritative and disposable-debug browser-AI modes are mutually exclusive.'
    );
    if(AUTHORITATIVE_BROWSER_AI_CONTRACT){
        assert.equal(
            DEBUG_MODEL_PATH_PRESENT,
            false,
            'Authoritative Granite validation rejects the disposable debug model environment.'
        );
    }
    if(DEBUG_BROWSER_AI_CONTRACT){
        assert.equal(
            DEBUG_MODEL_PATH_PRESENT,
            true,
            'Disposable-debug validation requires ARCANE_BROWSER_AI_DEBUG_MODEL_PATH.'
        );
    }
    const temporary=await temporaryDirectory(t,{prefix:'arcane-tarball-'});
    const releaseMetadataPath=process.env.ARCANE_SDK_NPM_RELEASE_METADATA;
    let tarballPath;
    let releaseVerification;
    let packedVersion;
    let harnessRoot;
    let workspaceRoot;
    let appRoot;
    let installedCli;
    const exactArtifactRequired=process.env.ARCANE_SDK_EXACT_ARTIFACT_REQUIRED==='true';

    if(exactArtifactRequired){
        assert.ok(releaseMetadataPath,'The exact-artifact matrix requires producer metadata.');
        assert.ok(process.env.ARCANE_SDK_EXPECTED_PLATFORM,'The exact-artifact matrix requires a platform identity.');
        assert.ok(process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE,'The exact-artifact matrix requires an architecture identity.');
    }

    if(process.env.CI==='true'&&!releaseMetadataPath){
        await t.test('defers release packing to the single CI producer',()=>{
            assert.equal(releaseMetadataPath,undefined);
        });
        return;
    }

    await t.test('packs the public SDK artifact with required runtime files',async()=>{
        let packReport;
        if(releaseMetadataPath){
            releaseVerification=await verifyNpmReleaseArtifact({
                metadataPath:releaseMetadataPath,
                requireCleanSource:process.env.CI==='true'
            });
            const {manifest}=releaseVerification;
            tarballPath=releaseVerification.tarballPath;
            packReport={
                name:manifest.name,
                version:manifest.version,
                filename:manifest.artifact.file,
                files:manifest.package.files.map(file=>({path:file.path,size:file.bytes}))
            };
            if(process.env.GITHUB_SHA){
                assert.equal(manifest.source.commit,process.env.GITHUB_SHA);
            }
            if(process.env.ARCANE_SDK_EXPECTED_PLATFORM){
                assert.equal(process.platform,process.env.ARCANE_SDK_EXPECTED_PLATFORM);
            }
            if(process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE){
                assert.equal(process.arch,process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE);
            }
        }else{
            const packed=await runNpm(
                [
                    'pack',
                    '--ignore-scripts',
                    '--dry-run=false',
                    '--json',
                    '--pack-destination',temporary
                ],
                {cwd:repositoryRoot,timeout:60_000}
            );
            assert.equal(packed.code,0,packed.stderr);
            [packReport]=JSON.parse(packed.stdout);
            tarballPath=path.join(temporary,packReport.filename);
        }
        assert.equal(packReport.name,'arcane-os');
        assert.equal(packReport.version,SDK_VERSION);
        packedVersion=packReport.version;
        assert.ok(packReport.files.some(file=>file.path==='bin/arcane.mjs'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/ARCANE_RUNTIME_RELEASE.json'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/arcane/modules/SpeechPlayback.js'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/arcane/modules/ArcaneNetworkPolicy.js'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/arcane/security/arcane-network-policy.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-app.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-package.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-app-bundle.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/event-stack.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='src/event-manager.mjs'));
        assert.ok(packReport.files.some(file=>
            file.path==='browser-runtime/ai/ARCANE_AI_BROWSER_SPEECH_COMPONENTS.json'
        ));
        assert.ok(packReport.files.some(file=>file.path==='node_modules/event-pubsub/index.js'));
        assert.ok(packReport.files.some(file=>file.path==='node_modules/event-pubsub/package.json'));
        assert.ok(packReport.files.some(file=>file.path==='node_modules/event-pubsub/licence'));
        assert.ok(packReport.files.some(file=>file.path==='node_modules/strong-type/index.js'));
        assert.ok(packReport.files.some(file=>file.path==='node_modules/strong-type/package.json'));
        assert.ok(packReport.files.some(file=>file.path==='node_modules/strong-type/licence'));
        assert.ok(packReport.files.some(file=>file.path==='src/release-bundle.mjs'));
        assert.ok(packReport.files.some(file=>file.path==='src/templates/assets/app-icon.png'));
        assert.ok(packReport.files.some(file=>file.path==='NOTICE'));
        const packedPaths=packReport.files.map(file=>file.path);
        assert.deepEqual(
            packedPaths.filter(file=>FORBIDDEN_PACKED_ASSET_EXTENSION.test(file)),
            [],
            'The npm artifact contains model, native, or speech payload bytes.'
        );
        assert.deepEqual(
            packedPaths.filter(file=>file.toLowerCase().endsWith('.wasm')).sort(),
            PACKED_WASM_ALLOWLIST,
            'The npm artifact contains an unadmitted WASM asset.'
        );
        assert.deepEqual(
            packedPaths
                .filter(file=>file.startsWith('browser-runtime/'))
                .sort(),
            SDK_BROWSER_RUNTIME_PACKAGE_FILES
        );
        assert.ok(packReport.files.every(file=>!file.path.startsWith('test/')));
        assert.ok(packReport.files.every(file=>!file.path.startsWith('.github/')));
    });

    await t.test('installs the tarball into a clean harness and scaffolds an external app',async()=>{
        harnessRoot=path.join(temporary,'packed-sdk-harness');
        await mkdir(harnessRoot);
        await writeFile(path.join(harnessRoot,'package.json'),`${JSON.stringify({
            name:'packed-sdk-harness',
            private:true,
            type:'module',
            dependencies:{'strong-type':'2.0.1'},
            devDependencies:{'arcane-os':`file:${tarballPath}`}
        },null,2)}\n`);
        const harnessInstalled=await runNpm(
            ['install','--ignore-scripts','--dry-run=false','--no-audit','--no-fund'],
            {cwd:harnessRoot,timeout:60_000}
        );
        assert.equal(harnessInstalled.code,0,harnessInstalled.stderr);
        const packedCli=path.join(harnessRoot,'node_modules','arcane-os','bin','arcane.mjs');
        workspaceRoot=path.join(temporary,'external-app');
        const scaffolded=await runNode([
            packedCli,
            'new',
            'external-app',
            '--path',workspaceRoot,
            '--target','portable',
            '--output','json'
        ],{cwd:temporary});
        assert.equal(scaffolded.code,0,scaffolded.stderr);
    });

    await t.test('authenticates the exact installed SDK browser runtime closure',async()=>{
        const installedPackageRoot=path.join(harnessRoot,'node_modules','arcane-os');
        const browserRuntimeRoot=path.join(installedPackageRoot,'browser-runtime');
        assert.deepEqual(
            (await realFileInventory(browserRuntimeRoot)).map(file=>`browser-runtime/${file}`),
            SDK_BROWSER_RUNTIME_PACKAGE_FILES
        );
        const manifestBytes=await readFile(
            path.join(browserRuntimeRoot,'ARCANE_SDK_BROWSER_RELEASE.json')
        );
        const manifest=JSON.parse(manifestBytes.toString('utf8'));
        assert.equal(manifest.schemaVersion,1);
        assert.equal(manifest.builder,'arcane-sdk-browser-runtime-v1');
        assert.equal(manifest.sdkVersion,SDK_VERSION);
        assert.equal(manifest.fileCount,SDK_BROWSER_RUNTIME_FILES.length);
        assert.deepEqual(manifest.files.map(file=>file.path),SDK_BROWSER_RUNTIME_FILES);
        assert.deepEqual(manifest.source,{
            authority:'arcane-os-sdk',
            repository:'https://github.com/TheWizardNexus/arcane-os-sdk.git',
            protocol:'arcane-sdk-browser-runtime/1',
            browserEntry:'arcane-os/event-manager',
            dependencies:[
                {
                    name:'event-pubsub',
                    version:'6.1.0',
                    resolved:'https://registry.npmjs.org/event-pubsub/-/event-pubsub-6.1.0.tgz',
                    integrity:'sha512-FEMlhTxwqGM0hztTixG6FhVFXqp7Eq1ltk5mSreK6Mhy3xWWpLAzEUR6OMvMdNqT3jgSxA8JDhnhyAG3X4Xy7Q=='
                },
                {
                    name:'strong-type',
                    version:'2.0.0',
                    resolved:'https://registry.npmjs.org/strong-type/-/strong-type-2.0.0.tgz',
                    integrity:'sha512-HHrY9qYC7yn+5mlewiI3k9RQM9gZqGQsqbomZcd10Ks0h4RlX01nnkWbCe4AsVPCI6KaFvpkWm1nHMD+Ykup6g=='
                },
                {
                    name:'@wllama/wllama',
                    version:'3.6.0',
                    resolved:'https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz',
                    integrity:'sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w=='
                }
            ]
        });
        const aiComponents=JSON.parse(await readFile(
            path.join(browserRuntimeRoot,'ai','ARCANE_AI_BROWSER_WASM_COMPONENTS.json'),
            'utf8'
        ));
        assert.equal(aiComponents.packageExport,'arcane-os/ai/browser-wasm');
        assert.equal(aiComponents.runtimePolicy.modelWeightsPacked,false);
        assert.equal(aiComponents.runtimePolicy.remoteModelHelpers,false);
        assert.equal(aiComponents.runtimePolicy.toolCalls,'structural-only-never-executed');
        const aiComponentFiles=new Map(aiComponents.components.flatMap(component=>
            component.files.map(file=>[file.path,file])
        ));
        const speechComponents=JSON.parse(await readFile(
            path.join(browserRuntimeRoot,'ai','ARCANE_AI_BROWSER_SPEECH_COMPONENTS.json'),
            'utf8'
        ));
        assert.equal(speechComponents.packageExport,'arcane-os/ai/browser-speech');
        assert.equal(
            speechComponents.closureStatus,
            'browser-speech-runtime-composite-license-notice-and-corresponding-source-closure-incomplete'
        );
        assert.equal(
            speechComponents.publicationStatus,
            'browser-speech-public-operational-runtime-graphs-blocked-by-composite-legal-evidence'
        );
        assert.equal(speechComponents.runtimeBytesPacked,false);
        assert.equal(speechComponents.modelWeightsPacked,false);
        assert.equal(speechComponents.voiceBytesPacked,false);
        assert.equal(speechComponents.materializedLegalCorpus,false);
        assert.ok(speechComponents.components.every(component=>
            typeof component.name==='string'&&typeof component.version==='string'
        ));
        assert.ok(speechComponents.components.flatMap(component=>
            component.selectedArtifacts??[]
        ).every(file=>
            Number.isSafeInteger(file.bytes)
            &&/^[a-f0-9]{64}$/u.test(file.sha256)
        ));
        assert.ok(speechComponents.legalEvidence.every(evidence=>
            Number.isSafeInteger(evidence.bytes)
            &&/^[a-f0-9]{64}$/u.test(evidence.sha256)
        ));
        for(const file of manifest.files){
            const snapshot=await readFile(path.join(browserRuntimeRoot,...file.path.split('/')));
            assert.equal(snapshot.length,file.bytes,`${file.path} byte length drifted.`);
            assert.equal(
                createHash('sha256').update(snapshot).digest('hex'),
                file.sha256,
                `${file.path} digest drifted.`
            );
            if(file.sourcePath.startsWith('node_modules/@wllama/wllama/')
                ||file.provenance==='deterministic-derived-vendor'){
                const componentFile=aiComponentFiles.get(file.path);
                assert.ok(componentFile,`${file.path} lacks component authority.`);
                assert.equal(componentFile.bytes,file.bytes);
                assert.equal(componentFile.sha256,file.sha256);
                continue;
            }
            const source=await readFile(path.join(installedPackageRoot,...file.sourcePath.split('/')));
            assert.deepEqual(snapshot,source,`${file.path} diverged from ${file.sourcePath}.`);
        }
        const wasmBytes=await readFile(path.join(browserRuntimeRoot,'ai','wllama','wllama.wasm'));
        assert.deepEqual([...wasmBytes.subarray(0,4)],[0x00,0x61,0x73,0x6d]);

        const browserRuntimeApi=await import(pathToFileURL(path.join(
            installedPackageRoot,'src','sdk-browser-runtime.mjs'
        )).href);
        const receipt=await browserRuntimeApi.verifySdkBrowserRuntime({browserRuntimeRoot});
        await browserRuntimeApi.authenticateSdkBrowserRuntimeReceipt(receipt,{browserRuntimeRoot});
        assert.equal(receipt.kind,'arcane-sdk-browser-runtime-verification');
        assert.equal(receipt.sdkVersion,SDK_VERSION);
        assert.equal(receipt.fileCount,SDK_BROWSER_RUNTIME_FILES.length);
        assert.equal(receipt.contentSha256,manifest.contentSha256);
        assert.deepEqual(receipt.source,manifest.source);
        assert.deepEqual(receipt.files,manifest.files);
        const generatedLock=JSON.parse(await readFile(
            path.join(workspaceRoot,'arcane.lock.json'),
            'utf8'
        ));
        assert.deepEqual(generatedLock.sdkBrowserRuntime,{
            manifest:'node_modules/arcane-os/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json',
            manifestSha256:createHash('sha256').update(manifestBytes).digest('hex'),
            contentSha256:manifest.contentSha256,
            builder:manifest.builder,
            sdkVersion:manifest.sdkVersion,
            source:manifest.source
        });
    });

    await t.test('isolates bundled event dependencies and imports installed event contracts',async()=>{
        const cleanInstalled=await runNpm(
            ['ci','--offline','--ignore-scripts','--dry-run=false','--no-audit','--no-fund'],
            {cwd:harnessRoot,timeout:60_000}
        );
        assert.equal(cleanInstalled.code,0,cleanInstalled.stderr);
        const installedPackageRoot=path.join(harnessRoot,'node_modules','arcane-os');
        const consumerStrongType=JSON.parse(await readFile(
            path.join(harnessRoot,'node_modules','strong-type','package.json'),
            'utf8'
        ));
        const bundledEventPubSub=JSON.parse(await readFile(
            path.join(installedPackageRoot,'node_modules','event-pubsub','package.json'),
            'utf8'
        ));
        const bundledStrongType=JSON.parse(await readFile(
            path.join(installedPackageRoot,'node_modules','strong-type','package.json'),
            'utf8'
        ));
        assert.equal(consumerStrongType.version,'2.0.1');
        assert.equal(bundledEventPubSub.version,'6.1.0');
        assert.equal(bundledEventPubSub.dependencies['strong-type'],'2.0.0');
        assert.equal(bundledStrongType.version,'2.0.0');

        const imported=await runNode([
            '--input-type=module',
            '--eval',
            `const eventManager=await import('arcane-os/event-manager');
const eventStackSchema=await import('arcane-os/schemas/event-stack.json',{with:{type:'json'}});
const manager=eventManager.createEventManager({timeTravel:true,sessionId:'packed-artifact'});
let observed=null;
manager.once('packed.artifact.proof',value=>{observed=value;});
manager.emit('packed.artifact.proof',42);
process.stdout.write(JSON.stringify({
    protocol:eventManager.ARCANE_EVENT_STACK_PROTOCOL,
    schemaProtocol:eventStackSchema.default.properties.protocol.const,
    observed,
    eventCount:manager.eventCount,
    eventType:manager.history[0]?.type
}));`
        ],{cwd:harnessRoot,timeout:60_000});
        assert.equal(imported.code,0,imported.stderr);
        assert.deepEqual(JSON.parse(imported.stdout),{
            protocol:'arcane-event-stack/1',
            schemaProtocol:'arcane-event-stack/1',
            observed:42,
            eventCount:1,
            eventType:'packed.artifact.proof'
        });
    });

    await t.test('records an exact tarball install that survives a clean npm ci',async()=>{
        const installed=await runNpm(
            [
                'install',
                '--ignore-scripts',
                '--dry-run=false',
                '--no-audit',
                '--no-fund',
                '--save-dev',
                '--save-exact',
                tarballPath
            ],
            {cwd:workspaceRoot,timeout:60_000}
        );
        assert.equal(installed.code,0,installed.stderr);
        const packageDocument=JSON.parse(await readFile(path.join(workspaceRoot,'package.json'),'utf8'));
        assert.match(packageDocument.devDependencies['arcane-os'],/^file:.+\.tgz$/u);
        const packageLock=JSON.parse(await readFile(path.join(workspaceRoot,'package-lock.json'),'utf8'));
        assert.equal(packageLock.packages['node_modules/arcane-os'].version,SDK_VERSION);
        assert.ok(packageLock.packages['node_modules/arcane-os'].resolved.endsWith(`arcane-os-${SDK_VERSION}.tgz`));
        assert.match(packageLock.packages['node_modules/arcane-os'].integrity,/^sha512-/u);

        const cleanInstalled=await runNpm(
            ['ci','--offline','--ignore-scripts','--dry-run=false','--no-audit','--no-fund'],
            {cwd:workspaceRoot,timeout:60_000}
        );
        assert.equal(cleanInstalled.code,0,cleanInstalled.stderr);
    });

    await t.test('scaffolds portable metadata and the installed template icon',async()=>{
        appRoot=path.join(workspaceRoot,'apps','external-app');
        const descriptorPath=path.join(appRoot,'arcane-app.json');
        const descriptor=JSON.parse(await readFile(descriptorPath,'utf8'));
        const generatedIcon=await readFile(path.join(appRoot,'img','icon.png'));
        const installedTemplateIcon=await readFile(path.join(
            workspaceRoot,
            'node_modules','arcane-os','src','templates','assets','app-icon.png'
        ));
        assert.deepEqual(generatedIcon,installedTemplateIcon);
        assert.deepEqual(descriptor.targets,['browser','portable']);
        assert.equal(descriptor.native.icon,'img/icon.png');
        assert.ok(descriptor.package.include.includes('img/icon.png'));
        descriptor.version='0.1.0+external.1';
        await writeFile(descriptorPath,`${JSON.stringify(descriptor,null,2)}\n`);
        await writeFile(
            path.join(appRoot,'arcane-package.json'),
            `${JSON.stringify(projectPackageManifest(descriptor),null,2)}\n`
        );
    });

    await t.test('exposes the target adapter through both executable names',async()=>{
        for(const executable of ['arcane','arcane-os']){
            const invoked=await runNpm(
                ['exec','--offline','--',executable,'targets','--output','json'],
                {cwd:workspaceRoot,timeout:60_000}
            );
            assert.equal(invoked.code,0,invoked.stderr);
            assert.equal(parseLastJsonLine(invoked.stdout).result.protocol,'arcane-target-adapter/1');
        }
    });

    await t.test('runs the installed Arcane Vanilla Test lifecycle through npm-local CLI',async()=>{
        const installedRunner=path.join(
            workspaceRoot,'node_modules','arcane-os','bin','arcane-test.mjs'
        );
        const lifecycleTest=path.join(workspaceRoot,'packed-lifecycle.test.mjs');
        await writeFile(lifecycleTest,`import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {promisify} from 'node:util';
import test from 'arcane-os/testing';

const execute=promisify(execFile);
const npmCli=process.env.npm_execpath??path.join(
    path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'
);
async function npmExec(arguments_){
    const command=process.platform==='win32'?process.execPath:'npm';
    const args=process.platform==='win32'?[npmCli,...arguments_]:arguments_;
    try{
        const result=await execute(command,args,{
            cwd:process.cwd(),encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true
        });
        return {code:0,...result};
    }catch(error){
        return {code:error.code,stdout:error.stdout??'',stderr:error.stderr??''};
    }
}

test('installed SDK lifecycle exercises its project-local Arcane CLI',async t=>{
    await t.test('runs on the required native host',()=>{
        assert.equal(process.platform,${JSON.stringify(process.env.ARCANE_SDK_EXPECTED_PLATFORM??process.platform)});
        assert.equal(process.arch,${JSON.stringify(process.env.ARCANE_SDK_EXPECTED_ARCHITECTURE??process.arch)});
    });
    await t.test('reports the packed SDK version',async()=>{
        const result=await npmExec(['exec','--offline','--','arcane','version','--output','json']);
        assert.equal(result.code,0,result.stderr);
        const report=JSON.parse(result.stdout.trim().split(/\\r?\\n/u).at(-1));
        assert.equal(report.ok,true);
        assert.equal(report.command,'version');
        assert.equal(report.result,${JSON.stringify(packedVersion)});
    });
    await t.test('rejects invalid CLI input with the shared status contract',async()=>{
        const result=await npmExec([
            'exec','--offline','--','arcane','definitely-invalid','--output','json'
        ]);
        assert.equal(result.code,1);
        const report=JSON.parse(result.stdout.trim().split(/\\r?\\n/u).at(-1));
        assert.equal(report.ok,false);
        assert.equal(report.error.code,'ARCANE_USAGE');
    });
});
`,'utf8');
        const lifecycle=await runNode([installedRunner,lifecycleTest],{
            cwd:workspaceRoot,
            timeout:120_000
        });
        assert.equal(lifecycle.code,0,`${lifecycle.stdout}\n${lifecycle.stderr}`);
        assert.match(lifecycle.stdout,/Result\s*:\s*.*PASSED/u);
    });

    await t.test('checks the external app through its generated package script',async()=>{
        const scriptedCheck=await runNpm(
            ['run','check','--','--output','json'],
            {cwd:workspaceRoot,timeout:60_000}
        );
        assert.equal(scriptedCheck.code,0,`${scriptedCheck.stdout}\n${scriptedCheck.stderr.slice(-2000)}`);
        assert.equal(parseLastJsonLine(scriptedCheck.stdout).result.ok,true);
    });

    await t.test('checks the external app through the installed CLI',async()=>{
        installedCli=path.join(
            workspaceRoot,
            'node_modules','arcane-os','bin','arcane.mjs'
        );
        const checked=await runNode([
            installedCli,
            'check',
            '--workspace',workspaceRoot,
            '--output','json'
        ],{cwd:workspaceRoot,timeout:60_000});
        assert.equal(checked.code,0,`${checked.stdout}\n${checked.stderr.slice(-2000)}`);
        assert.equal(JSON.parse(checked.stdout).result.ok,true);
    });

    await t.test('packages the external app with SDK license materials',async()=>{
        const packaged=await runNode([
            installedCli,
            'package',
            '--workspace',workspaceRoot,
            '--output','json'
        ],{cwd:workspaceRoot,timeout:60_000});
        assert.equal(packaged.code,0,packaged.stderr);
        const release=JSON.parse(packaged.stdout).result.release;
        assert.equal(release.app,'external-app');
        assert.match(release.contentSha256,/^[0-9a-f]{64}$/);

        for(const licenseFile of ['LICENSE','COMMERCIAL-LICENSE.md','NOTICE']){
            assert.equal(
                await readFile(path.join(workspaceRoot,'dist','external-app','licenses','arcane-os',licenseFile),'utf8'),
                await readFile(path.join(workspaceRoot,'node_modules','arcane-os',licenseFile),'utf8')
            );
        }
    });

    await t.test('verifies the external app package with the installed CLI',async()=>{
        const verified=await runNode([
            installedCli,
            'verify',
            '--workspace',workspaceRoot,
            '--output','json'
        ],{cwd:workspaceRoot,timeout:60_000});
        assert.equal(verified.code,0,verified.stderr);
        assert.equal(JSON.parse(verified.stdout).result.release.verified,true);
    });

    await t.test('creates and verifies a deterministic external release bundle with the installed CLI',async()=>{
        const artifactPath=path.join(workspaceRoot,'release','external-app.arcane-app.tar.gz');
        const bundled=await runNode([
            installedCli,
            'bundle',
            '--workspace',workspaceRoot,
            '--artifact',artifactPath,
            '--output','json'
        ],{cwd:workspaceRoot,timeout:60_000});
        assert.equal(bundled.code,0,`${bundled.stdout}\n${bundled.stderr}`);
        const bundleResult=JSON.parse(bundled.stdout).result.bundle;
        assert.match(bundleResult.bundleSha256,/^[0-9a-f]{64}$/u);
        assert.equal(bundleResult.artifactReceipt.kind,'arcane-app-release-bundle-artifact');

        const verified=await runNode([
            installedCli,
            'verify-bundle',artifactPath,
            '--output','json'
        ],{cwd:workspaceRoot,timeout:60_000});
        assert.equal(verified.code,0,`${verified.stdout}\n${verified.stderr}`);
        const verification=JSON.parse(verified.stdout).result;
        assert.equal(verification.verified,true);
        assert.equal(verification.bundleSha256,bundleResult.bundleSha256);
    });

    await t.test('enforces the portable provider host contract',async()=>{
        const arcaneRoot=path.join(temporary,'synthetic-arcane');
        const providerPath=path.join(
            arcaneRoot,'machine_bundles','arcane-os-machine-bundle','tools','portable-native-provider.mjs'
        );
        await mkdir(path.dirname(providerPath),{recursive:true});
        await writeFile(providerPath,`import {mkdir,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
const toolchains=new WeakSet();
const artifacts=new WeakSet();
const provider={
  protocol:'arcane-native-builder/1',
  async describe(){return {protocol:'arcane-native-builder/1',targets:['portable']};},
  async doctor(){return {ready:true};},
  async prepare({toolchainRoot}){
    const receipt=Object.freeze({
      kind:'packed-test-toolchain',version:'0.8.12',protocolVersion:'arcane/1',
      features:Object.freeze([]),supportedCapabilities:Object.freeze([]),supportedMethods:Object.freeze([]),
      canonicalLocation:await realpath(toolchainRoot),contentSha256:'a'.repeat(64)
    });
    toolchains.add(receipt);
    return receipt;
  },
  async authenticateToolchainReceipt(receipt){
    if(!toolchains.has(receipt))throw new Error('foreign toolchain receipt');
    return receipt;
  },
  async build({toolchainReceipt,appDescriptor,appReleaseReceipt,readAppReleaseFile,outputRoot,targetRequest}){
    if(!toolchains.has(toolchainReceipt))throw new Error('foreign toolchain receipt');
    const selected=appReleaseReceipt.files.find(file=>file.path.endsWith('/index.html'))??appReleaseReceipt.files[0];
    const bytes=await readAppReleaseFile(selected.path);
    const artifactRoot=path.join(outputRoot,appDescriptor.id);
    await mkdir(artifactRoot,{recursive:true});
    await writeFile(path.join(artifactRoot,'PACKED_SDK_NATIVE_PROOF.txt'),bytes);
    const artifactReceipt=Object.freeze({
      kind:'packed-sdk-native-artifact',artifactRoot,sourcePath:selected.path,bytes:bytes.length,
      platform:targetRequest.platform,architecture:targetRequest.architecture
    });
    artifacts.add(artifactReceipt);
    return {artifactReceipt};
  },
  async verify({artifactReceipt}){
    if(!artifacts.has(artifactReceipt))throw new Error('foreign artifact receipt');
    return {verified:true,artifactReceipt};
  },
  async run(){throw new Error('portable target is not runnable');}
};
export const arcaneNativeBuilderProvider=Object.freeze(provider);
export default arcaneNativeBuilderProvider;
`,'utf8');
        const nativeBuilt=await runNode([
            installedCli,'build','--target','portable','--workspace',workspaceRoot,
            '--arcane-root',arcaneRoot,'--output','json'
        ],{cwd:workspaceRoot,timeout:60_000});
        if(process.platform==='darwin'){
            assert.equal(nativeBuilt.code,1,`${nativeBuilt.stdout}\n${nativeBuilt.stderr}`);
            const nativeFailure=JSON.parse(nativeBuilt.stdout);
            assert.equal(nativeFailure.error.code,'ARCANE_TARGET_UNAVAILABLE');
            assert.equal(
                nativeFailure.error.message,
                `The portable native provider does not support ${process.platform}/${process.arch}.`
            );
            return;
        }
        assert.equal(nativeBuilt.code,0,`${nativeBuilt.stdout}\n${nativeBuilt.stderr}`);
        const nativeResult=JSON.parse(nativeBuilt.stdout).result;
        assert.equal(nativeResult.artifactReceipt.kind,'packed-sdk-native-artifact');
        assert.ok(nativeResult.artifactReceipt.bytes>0);
        assert.equal(
            nativeResult.artifactReceipt.platform,
            process.platform==='win32'?'windows':process.platform
        );
        assert.equal(nativeResult.artifactReceipt.architecture,process.arch);
        assert.equal(
            await readFile(path.join(
                workspaceRoot,'build','portable','external-app','PACKED_SDK_NATIVE_PROOF.txt'
            ),'utf8'),
            await readFile(path.join(workspaceRoot,'apps','external-app','index.html'),'utf8')
        );
    });

    if(BROWSER_AI_CONTRACT_ENABLED){
        await t.test('executes real browser-WASM inference once from the installed tarball',{
            timeout:3_600_000
        },async()=>{
            const contractSource=path.join(repositoryRoot,'test','browser-ai-runtime.contract.mjs');
            const contractPath=path.join(workspaceRoot,'browser-ai-runtime.contract.test.mjs');
            await copyFile(contractSource,contractPath);
            assert.deepEqual(await readFile(contractPath),await readFile(contractSource));
            const installedRunner=path.join(
                workspaceRoot,'node_modules','arcane-os','bin','arcane-test.mjs'
            );
            const contractEnvironment={...process.env};
            delete contractEnvironment.ARCANE_BROWSER_AI_RUNTIME_CONTRACT_INSTALLED;
            delete contractEnvironment.ARCANE_BROWSER_AI_DEBUG_CONTRACT_INSTALLED;
            if(AUTHORITATIVE_BROWSER_AI_CONTRACT){
                contractEnvironment.ARCANE_BROWSER_AI_RUNTIME_CONTRACT_INSTALLED='1';
            }else{
                contractEnvironment.ARCANE_BROWSER_AI_DEBUG_CONTRACT_INSTALLED='1';
            }
            const browserContract=await runNode([installedRunner,contractPath],{
                cwd:workspaceRoot,
                timeout:3_500_000,
                env:contractEnvironment
            });
            assert.equal(browserContract.code,0,browserContract.stderr||browserContract.stdout);
            assert.match(browserContract.stdout,/Test Total : 1/u);
            assert.match(browserContract.stdout,/Passed :[^\r\n]*1/u);
        });
    }

    await t.test('executes the named-import graph in real Chrome through the installed tarball runner',{
        // The installed contract owns 270s, its process owns 300s, and this wrapper owns teardown/reporting.
        timeout:330_000
    },async()=>{
        const contractSource=path.join(repositoryRoot,'test','browser-import-map.contract.mjs');
        const contractPath=path.join(workspaceRoot,'browser-import-map.contract.test.mjs');
        await copyFile(contractSource,contractPath);
        assert.deepEqual(await readFile(contractPath),await readFile(contractSource));
        const installedRunner=path.join(
            workspaceRoot,'node_modules','arcane-os','bin','arcane-test.mjs'
        );
        const browserContract=await runNode([installedRunner,contractPath],{
            cwd:workspaceRoot,
            timeout:300_000,
            env:process.env
        });
        assert.equal(browserContract.code,0,browserContract.stderr||browserContract.stdout);
        assert.match(browserContract.stdout,/Test Total : 1/u);
        assert.match(browserContract.stdout,/Passed :[^\r\n]*1/u);
    });

    if(releaseVerification){
        await t.test('leaves the exact npm release tarball bytes unchanged',async()=>{
            const after=await verifyNpmReleaseArtifact({
                metadataPath:releaseMetadataPath,
                tarballPath:releaseVerification.tarballPath,
                requireCleanSource:process.env.CI==='true'
            });
            assert.equal(after.manifest.artifact.sha256,releaseVerification.manifest.artifact.sha256);
        });
    }
});
