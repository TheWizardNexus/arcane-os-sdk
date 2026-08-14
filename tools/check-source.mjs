#!/usr/bin/env node

import {lstat, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SCRIPT_ROOT=path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT=path.resolve(SCRIPT_ROOT,'..');
const IGNORED_DIRECTORIES=new Set([
    '.arcane',
    '.git',
    '.sync',
    'coverage',
    'dist',
    'node_modules'
]);
const FORBIDDEN_SOURCE_EXTENSIONS=new Set(['.ts','.tsx']);
const FORBIDDEN_NATIVE_EXTENSIONS=new Set([
    '.aab',
    '.apk',
    '.appimage',
    '.appx',
    '.appxbundle',
    '.deb',
    '.dll',
    '.dmg',
    '.dylib',
    '.exe',
    '.msi',
    '.msix',
    '.node',
    '.pkg',
    '.rpm',
    '.so'
]);
const FORBIDDEN_TOOLCHAIN_PACKAGES=new Set(['ts-node','tsx','typescript']);
const REQUIRED_RUNTIME_ATTRIBUTE='runtime/** -text -whitespace';

function fail(message){
    throw new Error(message);
}

function toPosix(relativePath){
    return relativePath.split(path.sep).join('/');
}

async function collectFiles(directory,relativeDirectory=''){
    const files=[];
    const entries=await readdir(directory,{withFileTypes:true});
    entries.sort((left,right)=>left.name.localeCompare(right.name,'en'));

    for(const entry of entries){
        const relativePath=path.join(relativeDirectory,entry.name);
        const absolutePath=path.join(directory,entry.name);

        if(entry.isDirectory()){
            if(!IGNORED_DIRECTORIES.has(entry.name)){
                files.push(...await collectFiles(absolutePath,relativePath));
            }
            continue;
        }

        if(entry.isSymbolicLink()){
            fail(`Repository source must not contain symbolic links: ${toPosix(relativePath)}`);
        }

        if(entry.isFile()){
            files.push(toPosix(relativePath));
        }
    }

    return files;
}

function assertPackageMetadata(packageDocument){
    if(packageDocument.name!=='arcane-os'){
        fail('package.json name must be exactly "arcane-os".');
    }
    if(packageDocument.type!=='module'){
        fail('package.json type must be "module".');
    }
    if(typeof packageDocument.version!=='string'||!/^[0-9]+\.[0-9]+\.[0-9]+-dev(?:\.[0-9A-Za-z-]+)*$/.test(packageDocument.version)){
        fail('Development package version must be a SemVer version containing the -dev prerelease identifier.');
    }
    if(packageDocument.license!=='AGPL-3.0-only'){
        fail('package.json license must be AGPL-3.0-only.');
    }
    if(packageDocument.bin?.arcane!=='./bin/arcane.mjs'
        ||packageDocument.bin?.['arcane-os']!=='./bin/arcane.mjs'){
        fail('package.json must expose ./bin/arcane.mjs as both arcane and arcane-os.');
    }
    if(packageDocument.engines?.node!=='>=22.14.0'){
        fail('package.json must require Node.js >=22.14.0.');
    }
    if(packageDocument.publishConfig?.access!=='public'
        ||packageDocument.publishConfig?.registry!=='https://registry.npmjs.org/'
        ||packageDocument.publishConfig?.tag!=='dev'){
        fail('package.json publishConfig must use the public npm registry and the dev tag.');
    }

    const requiredPublishedPaths=['bin/','src/','runtime/','schemas/'];
    if(!Array.isArray(packageDocument.files)
        ||requiredPublishedPaths.some(required=>!packageDocument.files.includes(required))){
        fail('package.json files must include bin/, src/, runtime/, and schemas/.');
    }

    const requiredExports=[
        '.',
        './toolchain',
        './events',
        './targets',
        './packager',
        './runtime/manifest',
        './schemas/arcane-app.json',
        './schemas/arcane-package.json',
        './schemas/arcane-lock.json',
        './schemas/cli-event.json',
        './schemas/target-adapter.json',
        './package.json'
    ];
    if(!packageDocument.exports
        ||requiredExports.some(required=>typeof packageDocument.exports[required]!=='string')){
        fail('package.json is missing one or more required SDK exports.');
    }

    const dependencyGroups=[
        packageDocument.dependencies,
        packageDocument.devDependencies,
        packageDocument.optionalDependencies,
        packageDocument.peerDependencies
    ];
    for(const dependencies of dependencyGroups){
        for(const dependencyName of Object.keys(dependencies??{})){
            if(FORBIDDEN_TOOLCHAIN_PACKAGES.has(dependencyName)){
                fail(`TypeScript toolchain dependency is not allowed: ${dependencyName}`);
            }
        }
    }

    for(const [scriptName,script] of Object.entries(packageDocument.scripts??{})){
        if(typeof script==='string'&&/(?:^|[\s;&|])(?:npx\s+)?(?:tsc|ts-node|tsx)(?:[\s;&|]|$)/i.test(script)){
            fail(`TypeScript toolchain command is not allowed in script ${scriptName}.`);
        }
    }
}

async function assertRuntimeGitAttributes(){
    const attributesPath=path.join(REPOSITORY_ROOT,'.gitattributes');
    const attributeLines=(await readFile(attributesPath,'utf8'))
        .split(/\r?\n/u)
        .map(line=>line.trim())
        .filter(Boolean);

    if(attributeLines.at(-1)!==REQUIRED_RUNTIME_ATTRIBUTE){
        fail(`${REQUIRED_RUNTIME_ATTRIBUTE} must be the final .gitattributes rule so pinned runtime bytes are never normalized.`);
    }
}

async function main(){
    const packagePath=path.join(REPOSITORY_ROOT,'package.json');
    const packageDocument=JSON.parse(await readFile(packagePath,'utf8'));
    assertPackageMetadata(packageDocument);
    await assertRuntimeGitAttributes();

    const binPath=path.resolve(REPOSITORY_ROOT,packageDocument.bin.arcane);
    const relativeBinPath=path.relative(REPOSITORY_ROOT,binPath);
    if(relativeBinPath.startsWith('..')||path.isAbsolute(relativeBinPath)){
        fail('The arcane executable must stay inside the repository.');
    }
    const binStat=await lstat(binPath);
    if(!binStat.isFile()){
        fail('The arcane executable must be a regular file.');
    }
    const binSource=await readFile(binPath,'utf8');
    if(!binSource.startsWith('#!/usr/bin/env node\n')){
        fail('bin/arcane.mjs must begin with #!/usr/bin/env node and an LF newline.');
    }

    const files=await collectFiles(REPOSITORY_ROOT);
    const violations=[];
    for(const file of files){
        const extension=path.posix.extname(file).toLowerCase();
        if(FORBIDDEN_SOURCE_EXTENSIONS.has(extension)){
            violations.push(`${file} uses forbidden TypeScript source`);
        }
        if(FORBIDDEN_NATIVE_EXTENSIONS.has(extension)){
            violations.push(`${file} is a generated native artifact`);
        }
    }

    if(violations.length>0){
        fail(`Source policy violations:\n- ${violations.join('\n- ')}`);
    }

    process.stdout.write(`Source policy passed for ${files.length} files.\n`);
}

main().catch(error=>{
    process.stderr.write(`Source policy failed: ${error.message}\n`);
    process.exitCode=1;
});
