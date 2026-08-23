#!/usr/bin/env node

import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {
    ARCANE_REPOSITORY,
    EXPECTED_RUNTIME_DIRECTORIES,
    EXPECTED_STRONG_TYPE_FILES,
    readRuntimeSource
} from './runtime-source.mjs';

const execFile=promisify(execFileCallback);
const toolPath=fileURLToPath(import.meta.url);
const toolRoot=path.dirname(toolPath);
const packageRoot=path.dirname(toolRoot);
const runtimeRoot=path.join(packageRoot,'runtime');
const sourceConfigPath=path.join(toolRoot,'runtime-source.json');
const ARCANE_REMOTE_URLS=new Set([
    ARCANE_REPOSITORY,
    'git@github.com:TheWizardNexus/ARCANE-OS.git'
]);

function fail(message){throw new Error(`ARCANE_RUNTIME_SYNC_FAILED: ${message}`);}

function sameJson(left,right){return JSON.stringify(left)===JSON.stringify(right);}

async function sha256File(filePath){
    return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

async function runGit(root,args){
    const result=await execFile('git',['-C',root,...args],{
        encoding:'utf8',
        maxBuffer:8*1024*1024,
        windowsHide:true
    });
    return result.stdout.trim();
}

async function assertRealTree(directory,label){
    const info=await lstat(directory);
    if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} must be a real directory.`);
    const entries=await readdir(directory,{withFileTypes:true});
    for(const entry of entries){
        const absolute=path.join(directory,entry.name);
        const child=await lstat(absolute);
        if(child.isSymbolicLink())fail(`${label} contains a symbolic link or junction: ${entry.name}.`);
        if(child.isDirectory())await assertRealTree(absolute,`${label}/${entry.name}`);
        else if(!child.isFile())fail(`${label} contains a special entry: ${entry.name}.`);
    }
}

export async function readSourceConfig(filePath=sourceConfigPath){
    try{
        return await readRuntimeSource(filePath);
    }catch{
        fail('tools/runtime-source.json is invalid.');
    }
}

export async function inspectArcaneRoot(root,config){
    const canonical=await realpath(root);
    const rootInfo=await lstat(canonical);
    const gitInfo=await lstat(path.join(canonical,'.git'));
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()||gitInfo.isSymbolicLink()||!gitInfo.isDirectory()){
        fail('the Arcane source must be the canonical checkout, not a link or worktree.');
    }
    if(await runGit(canonical,['rev-parse','--abbrev-ref','HEAD'])!=='main'){
        fail('the Arcane source checkout must be on main.');
    }
    const remoteUrl=await runGit(canonical,['remote','get-url','origin']);
    if(!ARCANE_REMOTE_URLS.has(remoteUrl)){
        fail('the Arcane source origin is not the canonical repository.');
    }
    const commit=await runGit(canonical,['rev-parse','--verify','HEAD']);
    if(!/^[a-f0-9]{40}$/u.test(commit))fail('the Arcane source commit is invalid.');
    const trackingCommit=await runGit(canonical,['rev-parse','--verify','refs/remotes/origin/main']);
    if(commit!==trackingCommit){
        fail('the Arcane source HEAD must equal the tracked origin/main commit.');
    }
    const trackedSourcePaths=[
        'arcane',
        'arcane-packager.json',
        'package.json',
        'package-lock.json',
        'machine_bundles/arcane-os-machine-bundle/package.json',
        'machine_bundles/arcane-os-machine-bundle/arcane-bundle.json'
    ];
    try{
        await runGit(canonical,['diff','--quiet','HEAD','--',...trackedSourcePaths]);
        await runGit(canonical,['diff','--cached','--quiet','HEAD','--',...trackedSourcePaths]);
    }catch{
        fail('the Arcane runtime source contains tracked changes.');
    }
    const untracked=await runGit(canonical,['ls-files','--others','--','arcane']);
    const ignored=await runGit(canonical,[
        'ls-files','--others','--ignored','--exclude-standard','--','arcane'
    ]);
    if(untracked||ignored){
        fail('the Arcane runtime source contains untracked files.');
    }

    const machineBundleRoot=path.join(canonical,'machine_bundles','arcane-os-machine-bundle');
    const packageDocument=JSON.parse(await readFile(path.join(machineBundleRoot,'package.json'),'utf8'));
    const packageLock=JSON.parse(await readFile(path.join(canonical,'package-lock.json'),'utf8'));
    const bundleDocument=JSON.parse(await readFile(path.join(machineBundleRoot,'arcane-bundle.json'),'utf8'));
    const packager=JSON.parse(await readFile(path.join(canonical,'arcane-packager.json'),'utf8'));
    const expectedRoutes=[
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
    ];
    if(!sameJson(packager.sharedPayloads?.['browser-runtime'],expectedRoutes)){
        fail('the Arcane browser-runtime routes do not match tools/runtime-source.json.');
    }
    if(typeof packageDocument.version!=='string'
        ||!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(packageDocument.version)
        ||bundleDocument.version!==packageDocument.version){
        fail('the Arcane bundle version is invalid.');
    }
    const installedStrongType=JSON.parse(await readFile(
        path.join(canonical,'node_modules','strong-type','package.json'),
        'utf8'
    ));
    const lockedStrongType=packageLock.packages?.['node_modules/strong-type'];
    if(typeof installedStrongType.version!=='string'
        ||installedStrongType.version!==config.strongType.version
        ||lockedStrongType?.version!==config.strongType.version
        ||lockedStrongType.resolved!==config.strongType.resolved
        ||lockedStrongType.integrity!==config.strongType.integrity){
        fail('the installed strong-type package does not match the Arcane dependency lock identity.');
    }
    for(const pin of config.strongType.files){
        const installedPath=path.join(canonical,'node_modules','strong-type',pin.path);
        const info=await lstat(installedPath);
        if(info.isSymbolicLink()||!info.isFile()||await sha256File(installedPath)!==pin.sha256){
            fail(`the installed strong-type file does not match its reviewed digest: ${pin.path}.`);
        }
    }
    return {canonical,commit,bundleVersion:packageDocument.version};
}

async function stageRuntime(staging,source,config){
    const stagedArcane=path.join(staging,'next-arcane');
    const stagedStrongType=path.join(staging,'next-strong-type');
    await mkdir(stagedArcane,{recursive:true});
    await mkdir(stagedStrongType,{recursive:true});
    for(const directory of config.runtimeDirectories){
        const sourcePath=path.join(source.canonical,'arcane',directory);
        await assertRealTree(sourcePath,`arcane/${directory}`);
        await cp(sourcePath,path.join(stagedArcane,directory),{recursive:true,errorOnExist:true});
    }
    const strongTypeRoot=path.join(source.canonical,'node_modules','strong-type');
    await assertRealTree(strongTypeRoot,'node_modules/strong-type');
    for(const file of config.strongTypeFiles){
        const sourcePath=path.join(strongTypeRoot,file);
        const info=await lstat(sourcePath);
        if(info.isSymbolicLink()||!info.isFile())fail(`strong-type source is invalid: ${file}.`);
        await cp(sourcePath,path.join(stagedStrongType,file),{errorOnExist:true});
    }
    const nextConfig={
        ...config,
        commit:source.commit,
        bundleVersion:source.bundleVersion
    };
    await writeFile(path.join(staging,'next-runtime-source.json'),`${JSON.stringify(nextConfig,null,2)}\n`,'utf8');
}

export async function installStagedRuntime(staging,{
    destinationRuntimeRoot=runtimeRoot,
    destinationSourceConfigPath=sourceConfigPath
}={}){
    const operations=[
        {
            destination:path.join(destinationRuntimeRoot,'arcane'),
            next:path.join(staging,'next-arcane'),
            previous:path.join(staging,'previous-arcane')
        },
        {
            destination:path.join(destinationRuntimeRoot,'strong-type'),
            next:path.join(staging,'next-strong-type'),
            previous:path.join(staging,'previous-strong-type')
        },
        {
            destination:destinationSourceConfigPath,
            next:path.join(staging,'next-runtime-source.json'),
            previous:path.join(staging,'previous-runtime-source.json')
        }
    ];
    const moved=[];
    try{
        for(const operation of operations){
            await rename(operation.destination,operation.previous);
            operation.previousMoved=true;
            moved.push(operation);
            await rename(operation.next,operation.destination);
            operation.nextInstalled=true;
        }
    }catch(error){
        const rollbackErrors=[];
        for(const operation of moved.reverse()){
            try{
                if(operation.nextInstalled)await rename(operation.destination,operation.next);
                if(operation.previousMoved)await rename(operation.previous,operation.destination);
            }catch(rollbackError){
                rollbackErrors.push(rollbackError.message);
            }
        }
        if(rollbackErrors.length>0){
            const rollbackFailure=new Error(
                `ARCANE_RUNTIME_SYNC_FAILED: ${error.message}; rollback also failed: ${rollbackErrors.join('; ')}`
            );
            rollbackFailure.preserveStaging=true;
            throw rollbackFailure;
        }
        throw error;
    }
}

async function main(){
    if(process.argv.length!==4||process.argv[2]!=='--arcane-root'){
        process.stderr.write('Usage: node tools/sync-runtime.mjs --arcane-root <canonical-arcane-main-checkout>\n');
        process.exitCode=2;
        return;
    }
    const config=await readSourceConfig();
    const source=await inspectArcaneRoot(path.resolve(process.argv[3]),config);
    const staging=await mkdtemp(path.join(runtimeRoot,'.sync-runtime-'));
    let preserveStaging=false;
    try{
        await stageRuntime(staging,source,config);
        const confirmedSource=await inspectArcaneRoot(source.canonical,config);
        if(confirmedSource.commit!==source.commit
            ||confirmedSource.bundleVersion!==source.bundleVersion){
            fail('the Arcane source identity changed while the runtime was staged.');
        }
        await installStagedRuntime(staging);
    }catch(error){
        preserveStaging=error?.preserveStaging===true;
        throw error;
    }finally{
        if(!preserveStaging)await rm(staging,{recursive:true,force:true});
    }
    process.stdout.write(`Synchronized Arcane runtime from ${source.commit} (${source.bundleVersion}).\n`);
}

if(process.argv[1]&&path.resolve(process.argv[1])===toolPath){
    main().catch(error=>{
        process.stderr.write(`${error.message}\n`);
        process.exitCode=1;
    });
}
