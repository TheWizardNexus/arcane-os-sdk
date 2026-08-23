import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {
    appendFile,
    lstat,
    mkdir,
    readFile,
    readdir,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {
    NPM_RELEASE_KIND,
    NPM_RELEASE_NODE_VERSION,
    NPM_RELEASE_NPM_VERSION,
    NPM_RELEASE_SCHEMA_VERSION,
    verifyNpmReleaseArtifact
} from './npm-release-contract.mjs';

const execFileAsync=promisify(execFile);
const toolRoot=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(toolRoot,'..');
const canonicalRepository='https://github.com/TheWizardNexus/arcane-os-sdk';

function fail(message){
    throw new Error(`ARCANE_NPM_RELEASE_BUILD_FAILED: ${message}`);
}

function parseArguments(arguments_){
    let output=path.join(repositoryRoot,'dist','npm-release');
    let sourceSha=process.env.GITHUB_SHA??null;
    for(let index=0;index<arguments_.length;index+=1){
        const argument=arguments_[index];
        if(argument==='--output'){
            output=arguments_[++index]??'';
        }else if(argument==='--source-sha'){
            sourceSha=arguments_[++index]??'';
        }else{
            fail(`Unknown argument: ${argument}.`);
        }
    }
    if(output==='')fail('--output requires a directory.');
    return {output:path.resolve(output),sourceSha};
}

async function run(executable,arguments_,options={}){
    try{
        return await execFileAsync(executable,arguments_,{
            cwd:options.cwd??repositoryRoot,
            encoding:'utf8',
            env:options.env??process.env,
            maxBuffer:64*1024*1024,
            windowsHide:true
        });
    }catch(error){
        const diagnostics=`${error.stdout??''}\n${error.stderr??''}`.trim();
        fail(`${path.basename(executable)} ${arguments_.join(' ')} failed${diagnostics?`: ${diagnostics}`:''}`);
    }
}

async function git(arguments_){
    return (await run('git',arguments_)).stdout.trim();
}

async function sourceIdentity(requestedSha){
    const topLevel=path.resolve(await git(['rev-parse','--show-toplevel']));
    if(topLevel.toLowerCase()!==repositoryRoot.toLowerCase()){
        fail(`Build must run from the canonical checkout: ${repositoryRoot}.`);
    }
    const head=await git(['rev-parse','HEAD']);
    const commit=requestedSha??head;
    if(!/^[0-9a-f]{40}$/u.test(commit)){
        fail('Source SHA must be one lowercase 40-character Git SHA.');
    }
    if(commit!==head)fail(`Requested source SHA ${commit} does not equal checked-out HEAD ${head}.`);
    const status=await git(['status','--porcelain=v1','--untracked-files=all']);
    return {repository:canonicalRepository,commit,clean:status===''};
}

function npmCliPath(){
    const candidates=[
        process.env.npm_execpath,
        path.join(path.dirname(process.execPath),'node_modules','npm','bin','npm-cli.js'),
        path.resolve(path.dirname(process.execPath),'..','lib','node_modules','npm','bin','npm-cli.js')
    ].filter(candidate=>typeof candidate==='string'&&candidate!=='');
    return candidates;
}

async function resolveNpmCli(){
    for(const candidate of npmCliPath()){
        try{
            const info=await lstat(candidate);
            if(info.isFile())return path.resolve(candidate);
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
        }
    }
    fail('Unable to locate npm-cli.js in the selected Node.js distribution.');
}

async function assertToolchain(npmCli){
    if(process.versions.node!==NPM_RELEASE_NODE_VERSION){
        fail(`Build requires Node ${NPM_RELEASE_NODE_VERSION}; found ${process.versions.node}.`);
    }
    const npmVersion=(await run(process.execPath,[npmCli,'--version'])).stdout.trim();
    if(npmVersion!==NPM_RELEASE_NPM_VERSION){
        fail(`Build requires npm ${NPM_RELEASE_NPM_VERSION}; found ${npmVersion}.`);
    }
    return {node:process.versions.node,npm:npmVersion};
}

async function prepareOutput(output){
    const root=path.parse(output).root;
    if(output===root||output.toLowerCase()===repositoryRoot.toLowerCase()){
        fail('Release output must be a narrow directory, not a filesystem or repository root.');
    }
    await mkdir(output,{recursive:true});
    const info=await lstat(output);
    if(!info.isDirectory()||info.isSymbolicLink()){
        fail(`Release output is not a real directory: ${output}.`);
    }
    const entries=await readdir(output);
    if(entries.length!==0)fail(`Release output must be empty: ${output}.`);
}

function hash(bytes,algorithm,encoding='hex'){
    return createHash(algorithm).update(bytes).digest(encoding);
}

function normalizeInventory(report){
    if(!Array.isArray(report.files)||report.files.length<1){
        fail('npm pack did not report a package file inventory.');
    }
    const files=report.files.map(file=>{
        if(typeof file?.path!=='string'||!Number.isSafeInteger(file.size)||file.size<0){
            fail('npm pack reported an invalid package file entry.');
        }
        return {path:file.path,bytes:file.size};
    }).sort((left,right)=>left.path.localeCompare(right.path,'en'));
    const unpackedBytes=files.reduce((total,file)=>total+file.bytes,0);
    if(report.entryCount!==files.length||report.unpackedSize!==unpackedBytes){
        fail('npm pack inventory totals do not match its package report.');
    }
    return {entryCount:files.length,unpackedBytes,files};
}

async function appendOutputs(values){
    if(!process.env.GITHUB_OUTPUT)return;
    for(const [name,value] of Object.entries(values)){
        if(String(value).includes('\n')||String(value).includes('\r')){
            fail(`GitHub output ${name} contains a newline.`);
        }
    }
    await appendFile(
        process.env.GITHUB_OUTPUT,
        `${Object.entries(values).map(([name,value])=>`${name}=${value}`).join('\n')}\n`,
        'utf8'
    );
}

async function main(){
    const options=parseArguments(process.argv.slice(2));
    const source=await sourceIdentity(options.sourceSha);
    const npmCli=await resolveNpmCli();
    const toolchain=await assertToolchain(npmCli);
    const packageDocument=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
    if(packageDocument.name!=='arcane-os')fail('package.json must identify arcane-os.');
    const prerelease=packageDocument.version.includes('-');
    const expectedTag=prerelease?'dev':'latest';
    if(packageDocument.publishConfig?.tag!==expectedTag){
        fail(`${packageDocument.version} must publish through the npm ${expectedTag} tag.`);
    }
    await prepareOutput(options.output);

    const packed=await run(process.execPath,[
        npmCli,
        'pack',
        repositoryRoot,
        '--ignore-scripts',
        '--json',
        '--pack-destination',options.output
    ]);
    let reports;
    try{
        reports=JSON.parse(packed.stdout);
    }catch(error){
        fail(`npm pack returned malformed JSON: ${error.message}`);
    }
    if(!Array.isArray(reports)||reports.length!==1)fail('npm pack must produce exactly one artifact.');
    const report=reports[0];
    if(report.name!==packageDocument.name||report.version!==packageDocument.version){
        fail('npm pack identity does not match package.json.');
    }
    const expectedFilename=`arcane-os-${packageDocument.version}.tgz`;
    if(report.filename!==expectedFilename)fail(`npm pack filename must be ${expectedFilename}.`);
    const tarballPath=path.join(options.output,expectedFilename);
    const tarballInfo=await lstat(tarballPath,{bigint:true});
    if(!tarballInfo.isFile()||tarballInfo.isSymbolicLink()||tarballInfo.nlink!==1n){
        fail('npm pack output must be one regular single-link file.');
    }
    const tarballBytes=await readFile(tarballPath);
    const artifact={
        file:expectedFilename,
        bytes:tarballBytes.length,
        sha256:hash(tarballBytes,'sha256'),
        integrity:`sha512-${hash(tarballBytes,'sha512','base64')}`,
        shasum:hash(tarballBytes,'sha1')
    };
    if(report.size!==artifact.bytes||report.integrity!==artifact.integrity
        ||report.shasum!==artifact.shasum){
        fail('npm pack digest or size report does not match the exact tarball bytes.');
    }
    const manifest={
        schemaVersion:NPM_RELEASE_SCHEMA_VERSION,
        kind:NPM_RELEASE_KIND,
        name:packageDocument.name,
        version:packageDocument.version,
        source,
        artifact,
        package:normalizeInventory(report),
        toolchain
    };
    const stem=expectedFilename.slice(0,-'.tgz'.length);
    const manifestFilename=`${stem}.manifest.json`;
    const checksumFilename=`${expectedFilename}.sha256`;
    const metadataPath=path.join(options.output,manifestFilename);
    const checksumPath=path.join(options.output,checksumFilename);
    await writeFile(metadataPath,`${JSON.stringify(manifest,null,2)}\n`,{encoding:'utf8',flag:'wx'});
    await writeFile(checksumPath,`${artifact.sha256}  ${expectedFilename}\n`,{
        encoding:'utf8',
        flag:'wx'
    });
    await verifyNpmReleaseArtifact({
        metadataPath,
        tarballPath,
        requireCleanSource:process.env.CI==='true'
    });
    await appendOutputs({
        version:manifest.version,
        tarball:tarballPath,
        'tarball-filename':expectedFilename,
        manifest:metadataPath,
        'manifest-filename':manifestFilename,
        checksum:checksumPath,
        'checksum-filename':checksumFilename,
        sha256:artifact.sha256,
        integrity:artifact.integrity
    });
    process.stdout.write(`${JSON.stringify({
        version:manifest.version,
        tarball:tarballPath,
        manifest:metadataPath,
        checksum:checksumPath,
        sha256:artifact.sha256,
        integrity:artifact.integrity
    },null,2)}\n`);
}

await main();
