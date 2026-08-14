import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {projectPackageManifest} from '../src/app-descriptor.mjs';
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
    timeout:180_000
},async t=>{
    const temporary=await temporaryDirectory(t,{prefix:'arcane-tarball-'});
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
    const packReport=JSON.parse(packed.stdout)[0];
    assert.equal(packReport.name,'arcane-os');
    assert.equal(packReport.version,'0.1.0-dev.1');
    assert.ok(packReport.files.some(file=>file.path==='bin/arcane.mjs'));
    assert.ok(packReport.files.some(file=>file.path==='runtime/ARCANE_RUNTIME_RELEASE.json'));
    assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-app.schema.json'));
    assert.ok(packReport.files.some(file=>file.path==='schemas/arcane-package.schema.json'));
    assert.ok(packReport.files.some(file=>file.path==='src/templates/assets/app-icon.png'));
    assert.ok(packReport.files.some(file=>file.path==='NOTICE'));
    assert.ok(packReport.files.every(file=>!file.path.startsWith('test/')));
    assert.ok(packReport.files.every(file=>!file.path.startsWith('.github/')));

    const tarballPath=path.join(temporary,packReport.filename);
    const harnessRoot=path.join(temporary,'packed-sdk-harness');
    await mkdir(harnessRoot);
    await writeFile(path.join(harnessRoot,'package.json'),`${JSON.stringify({
        name:'packed-sdk-harness',
        private:true,
        type:'module',
        devDependencies:{'arcane-os':`file:${tarballPath}`}
    },null,2)}\n`);
    const harnessInstalled=await runNpm(
        ['install','--ignore-scripts','--no-audit','--no-fund'],
        {cwd:harnessRoot,timeout:60_000}
    );
    assert.equal(harnessInstalled.code,0,harnessInstalled.stderr);
    const packedCli=path.join(harnessRoot,'node_modules','arcane-os','bin','arcane.mjs');
    const workspaceRoot=path.join(temporary,'external-app');
    const scaffolded=await runNode([
        packedCli,
        'new',
        'external-app',
        '--path',workspaceRoot,
        '--target','portable',
        '--output','json'
    ],{cwd:temporary});
    assert.equal(scaffolded.code,0,scaffolded.stderr);

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
    assert.equal(packageLock.packages['node_modules/arcane-os'].version,'0.1.0-dev.1');
    assert.match(packageLock.packages['node_modules/arcane-os'].resolved,/arcane-os-0\.1\.0-dev\.1\.tgz$/u);
    assert.match(packageLock.packages['node_modules/arcane-os'].integrity,/^sha512-/u);

    const cleanInstalled=await runNpm(
        ['ci','--ignore-scripts','--no-audit','--no-fund'],
        {cwd:workspaceRoot,timeout:60_000}
    );
    assert.equal(cleanInstalled.code,0,cleanInstalled.stderr);

    const appRoot=path.join(workspaceRoot,'apps','external-app');
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

    for(const executable of ['arcane','arcane-os']){
        const invoked=await runNpm(
            ['exec','--',executable,'targets','--output','json'],
            {cwd:workspaceRoot,timeout:60_000}
        );
        assert.equal(invoked.code,0,invoked.stderr);
        assert.equal(parseLastJsonLine(invoked.stdout).result.protocol,'arcane-target-adapter/1');
    }

    const scriptedCheck=await runNpm(
        ['run','check','--','--output','json'],
        {cwd:workspaceRoot,timeout:60_000}
    );
    assert.equal(scriptedCheck.code,0,`${scriptedCheck.stdout}\n${scriptedCheck.stderr.slice(-2000)}`);
    assert.equal(parseLastJsonLine(scriptedCheck.stdout).result.ok,true);

    const installedCli=path.join(
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

    const verified=await runNode([
        installedCli,
        'verify',
        '--workspace',workspaceRoot,
        '--output','json'
    ],{cwd:workspaceRoot,timeout:60_000});
    assert.equal(verified.code,0,verified.stderr);
    assert.equal(JSON.parse(verified.stdout).result.release.verified,true);

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
  async build({toolchainReceipt,appDescriptor,appReleaseReceipt,readAppReleaseFile,outputRoot}){
    if(!toolchains.has(toolchainReceipt))throw new Error('foreign toolchain receipt');
    const selected=appReleaseReceipt.files.find(file=>file.path.endsWith('/index.html'))??appReleaseReceipt.files[0];
    const bytes=await readAppReleaseFile(selected.path);
    const artifactRoot=path.join(outputRoot,appDescriptor.id);
    await mkdir(artifactRoot,{recursive:true});
    await writeFile(path.join(artifactRoot,'PACKED_SDK_NATIVE_PROOF.txt'),bytes);
    const artifactReceipt=Object.freeze({kind:'packed-sdk-native-artifact',artifactRoot,sourcePath:selected.path,bytes:bytes.length});
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
    assert.equal(nativeBuilt.code,0,`${nativeBuilt.stdout}\n${nativeBuilt.stderr}`);
    const nativeResult=JSON.parse(nativeBuilt.stdout).result;
    assert.equal(nativeResult.artifactReceipt.kind,'packed-sdk-native-artifact');
    assert.ok(nativeResult.artifactReceipt.bytes>0);
    assert.equal(
        await readFile(path.join(
            workspaceRoot,'build','portable','external-app','PACKED_SDK_NATIVE_PROOF.txt'
        ),'utf8'),
        await readFile(path.join(workspaceRoot,'apps','external-app','index.html'),'utf8')
    );
});
