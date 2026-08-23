import assert from 'node:assert/strict';
import {
    cp,
    mkdir,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';

import test from '../src/testing.mjs';
import {
    inspectArcaneRoot,
    installStagedRuntime,
    readSourceConfig
} from '../tools/sync-runtime.mjs';
import {validateRuntimeSource} from '../tools/runtime-source.mjs';
import {repositoryRoot,runCommand,temporaryDirectory} from './helpers.mjs';

async function writeJson(filePath,value){
    await mkdir(path.dirname(filePath),{recursive:true});
    await writeFile(filePath,`${JSON.stringify(value,null,2)}\n`,'utf8');
}

async function git(root,...arguments_){
    const result=await runCommand('git',arguments_,{cwd:root});
    assert.equal(result.code,0,result.stderr||result.stdout);
    return result.stdout.trim();
}

async function createArcaneFixture(t,config){
    const root=await temporaryDirectory(t,{prefix:'arcane-runtime-sync-source-'});
    await writeFile(path.join(root,'.gitignore'),'node_modules/\narcane/**/ignored.js\n','utf8');
    for(const directory of config.runtimeDirectories){
        const target=path.join(root,'arcane',directory,'fixture.txt');
        await mkdir(path.dirname(target),{recursive:true});
        await writeFile(target,`${directory}\n`,'utf8');
    }
    await cp(
        path.join(repositoryRoot,'runtime','strong-type'),
        path.join(root,'node_modules','strong-type'),
        {recursive:true}
    );
    await writeJson(path.join(root,'arcane-packager.json'),{
        schemaVersion:1,
        sharedPayloads:{
            'browser-runtime':[
                {
                    source:'arcane',
                    destination:'arcane',
                    include:config.runtimeDirectories,
                    exclude:[]
                },
                {
                    source:'node_modules/strong-type',
                    destination:'node_modules/strong-type',
                    include:config.strongTypeFiles,
                    exclude:[]
                }
            ]
        }
    });
    await writeJson(path.join(root,'package.json'),{name:'arcane-os',version:'0.8.12'});
    await writeJson(path.join(root,'package-lock.json'),{
        lockfileVersion:3,
        packages:{
            'node_modules/strong-type':{
                version:config.strongType.version,
                resolved:config.strongType.resolved,
                integrity:config.strongType.integrity
            }
        }
    });
    await writeJson(
        path.join(root,'machine_bundles','arcane-os-machine-bundle','package.json'),
        {name:'arcane-os-machine-bundle',version:'0.8.12'}
    );
    await writeJson(
        path.join(root,'machine_bundles','arcane-os-machine-bundle','arcane-bundle.json'),
        {version:'0.8.12'}
    );

    await git(root,'init','--initial-branch=main');
    await git(root,'config','user.name','Arcane SDK Test');
    await git(root,'config','user.email','arcane-sdk-test@example.invalid');
    await git(
        root,
        'add','--','.gitignore','arcane','arcane-packager.json','package.json','package-lock.json',
        'machine_bundles'
    );
    await git(root,'commit','-m','fixture source');
    const firstCommit=await git(root,'rev-parse','HEAD');
    await writeFile(path.join(root,'README.md'),'fixture\n','utf8');
    await git(root,'add','--','README.md');
    await git(root,'commit','-m','fixture head');
    const head=await git(root,'rev-parse','HEAD');
    await git(root,'remote','add','origin','git@github.com:TheWizardNexus/ARCANE-OS.git');
    await git(root,'update-ref','refs/remotes/origin/main',firstCommit);
    return {head,root};
}

test('runtime source configuration has one strict reviewed shape',async()=>{
    const sourcePath=path.join(repositoryRoot,'tools','runtime-source.json');
    const source=JSON.parse(await readFile(sourcePath,'utf8'));
    assert.equal(validateRuntimeSource(source),source);
    assert.deepEqual(await readSourceConfig(sourcePath),source);

    for(const mutate of [
        value=>{value.extra=true;},
        value=>{value.protocol='arcane/2';},
        value=>{value.runtimeDirectories.reverse();},
        value=>{value.strongType.resolved='https://example.invalid/strong-type.tgz';},
        value=>{value.strongType.files[0].sha256='not-a-digest';}
    ]){
        const changed=structuredClone(source);
        mutate(changed);
        assert.throws(()=>validateRuntimeSource(changed),/runtime-source[.]json is invalid/u);
    }
});

test('runtime sync authenticates the canonical clean source and dependency bytes',async t=>{
    const config=await readSourceConfig();
    const {head,root}=await createArcaneFixture(t,config);

    await assert.rejects(
        inspectArcaneRoot(root,config),
        /HEAD must equal the tracked origin\/main/u
    );
    await git(root,'update-ref','refs/remotes/origin/main',head);
    assert.equal((await inspectArcaneRoot(root,config)).commit,head);

    await git(root,'remote','set-url','origin','https://example.invalid/not-arcane.git');
    await assert.rejects(inspectArcaneRoot(root,config),/origin is not the canonical repository/u);
    await git(root,'remote','set-url','origin','git@github.com:TheWizardNexus/ARCANE-OS.git');

    const packagerPath=path.join(root,'arcane-packager.json');
    const packager=await readFile(packagerPath,'utf8');
    await writeFile(packagerPath,`${packager} `,'utf8');
    await assert.rejects(inspectArcaneRoot(root,config),/contains tracked changes/u);
    await writeFile(packagerPath,packager,'utf8');

    const ignoredPath=path.join(root,'arcane','modules','ignored.js');
    await writeFile(ignoredPath,'export const ignored=true;\n','utf8');
    await assert.rejects(inspectArcaneRoot(root,config),/contains untracked files/u);
    await rm(ignoredPath);

    const strongTypePath=path.join(root,'node_modules','strong-type','index.js');
    const strongTypeSource=path.join(repositoryRoot,'runtime','strong-type','index.js');
    await writeFile(strongTypePath,'export const tampered=true;\n','utf8');
    await assert.rejects(inspectArcaneRoot(root,config),/reviewed digest: index[.]js/u);
    await cp(strongTypeSource,strongTypePath,{force:true});
    assert.equal((await inspectArcaneRoot(root,config)).commit,head);
});

test('runtime installation rolls back every completed replacement when a later move fails',async t=>{
    const root=await temporaryDirectory(t,{prefix:'arcane-runtime-sync-rollback-'});
    const destinationRuntimeRoot=path.join(root,'runtime');
    const destinationSourceConfigPath=path.join(root,'runtime-source.json');
    const staging=path.join(root,'staging');
    await mkdir(path.join(destinationRuntimeRoot,'arcane'),{recursive:true});
    await mkdir(path.join(staging,'next-arcane'),{recursive:true});
    await mkdir(path.join(staging,'next-strong-type'),{recursive:true});
    await writeFile(path.join(destinationRuntimeRoot,'arcane','old.txt'),'old\n','utf8');
    await writeFile(path.join(staging,'next-arcane','new.txt'),'new\n','utf8');
    await writeFile(path.join(staging,'next-strong-type','new.txt'),'new\n','utf8');
    await writeFile(destinationSourceConfigPath,'old config\n','utf8');
    await writeFile(path.join(staging,'next-runtime-source.json'),'new config\n','utf8');

    await assert.rejects(installStagedRuntime(staging,{
        destinationRuntimeRoot,
        destinationSourceConfigPath
    }));
    assert.equal(await readFile(path.join(destinationRuntimeRoot,'arcane','old.txt'),'utf8'),'old\n');
    assert.equal(await readFile(path.join(staging,'next-arcane','new.txt'),'utf8'),'new\n');
    assert.equal(await readFile(destinationSourceConfigPath,'utf8'),'old config\n');
});
