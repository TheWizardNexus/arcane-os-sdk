import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
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
    timeout:120_000
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
    const workspaceRoot=path.join(temporary,'external-app');
    const scaffolded=await runNode([
        path.join(repositoryRoot,'bin','arcane.mjs'),
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
});
