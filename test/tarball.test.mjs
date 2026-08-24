import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
import {verifyNpmReleaseArtifact} from '../tools/npm-release-contract.mjs';
import {
    repositoryRoot,
    runCommand,
    runNode,
    parseLastJsonLine,
    temporaryDirectory
} from './helpers.mjs';

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
    timeout:300_000
},async t=>{
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
        assert.equal(packReport.version,'0.1.0-dev.4');
        packedVersion=packReport.version;
        assert.ok(packReport.files.some(file=>file.path==='bin/arcane.mjs'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/ARCANE_RUNTIME_RELEASE.json'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/arcane/modules/SpeechPlayback.js'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/arcane/modules/ArcaneNetworkPolicy.js'));
        assert.ok(packReport.files.some(file=>file.path==='runtime/arcane/security/arcane-network-policy.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-app.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-package.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-app-bundle.schema.json'));
        assert.ok(packReport.files.some(file=>file.path==='src/release-bundle.mjs'));
        assert.ok(packReport.files.some(file=>file.path==='src/templates/assets/app-icon.png'));
        assert.ok(packReport.files.some(file=>file.path==='NOTICE'));
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
        assert.equal(packageLock.packages['node_modules/arcane-os'].version,'0.1.0-dev.4');
        assert.match(packageLock.packages['node_modules/arcane-os'].resolved,/arcane-os-0\.1\.0-dev\.4\.tgz$/u);
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
