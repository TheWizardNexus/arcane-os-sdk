#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {
    lstat,
    open,
    readFile,
    readdir,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRuntimeSource} from './runtime-source.mjs';

const toolRoot=path.dirname(fileURLToPath(import.meta.url));
const packageRoot=path.dirname(toolRoot);
const runtimeRoot=path.join(packageRoot,'runtime');
const manifestPath=path.join(runtimeRoot,'ARCANE_RUNTIME_RELEASE.json');
const manifestName=path.basename(manifestPath);
const sourceConfigPath=path.join(toolRoot,'runtime-source.json');
const mode=process.argv[2]??'--verify';

async function runtimeSource(){
    try{
        return await readRuntimeSource(sourceConfigPath);
    }catch{
        throw new Error('tools/runtime-source.json is invalid.');
    }
}

async function sha256File(filePath){
    const hash=createHash('sha256');
    const handle=await open(filePath,'r');
    const buffer=Buffer.allocUnsafe(1024*1024);

    try{
        while(true){
            const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
            if(bytesRead===0){
                break;
            }
            hash.update(buffer.subarray(0,bytesRead));
        }
    }finally{
        await handle.close();
    }

    return hash.digest('hex');
}

async function inventory(){
    const files=[];

    async function visit(directory,relativeRoot=''){
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>left.name.localeCompare(right.name,'en'));

        for(const entry of entries){
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            if(relative===manifestName){
                continue;
            }

            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink()){
                throw new Error(`Runtime contains a symbolic link or junction: ${relative}`);
            }
            if(info.isDirectory()){
                await visit(absolute,relative);
            }else if(info.isFile()){
                files.push({path:relative,bytes:info.size,sha256:await sha256File(absolute)});
            }else{
                throw new Error(`Runtime contains a special entry: ${relative}`);
            }
        }
    }

    await visit(runtimeRoot);
    files.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0);
    return files;
}

async function buildManifest(){
    const packageJson=JSON.parse(await readFile(path.join(packageRoot,'package.json'),'utf8'));
    const upstream=await runtimeSource();
    const files=await inventory();
    return {
        schemaVersion:1,
        builder:'arcane-sdk-runtime-v1',
        sdkVersion:packageJson.version,
        source:{
            repository:upstream.repository,
            commit:upstream.commit,
            bundleVersion:upstream.bundleVersion,
            protocol:upstream.protocol
        },
        fileCount:files.length,
        totalBytes:files.reduce((total,file)=>total+file.bytes,0),
        contentSha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),
        files
    };
}

if(!['--write','--verify'].includes(mode)||process.argv.length>3){
    console.error('Usage: node tools/runtime-manifest.mjs [--write|--verify]');
    process.exitCode=2;
}else{
    try{
        const actual=await buildManifest();
        if(mode==='--write'){
            await writeFile(manifestPath,`${JSON.stringify(actual,null,2)}\n`,'utf8');
            console.log(`Wrote ${manifestPath} (${actual.fileCount} files, ${actual.totalBytes} bytes).`);
        }else{
            const expected=JSON.parse(await readFile(manifestPath,'utf8'));
            if(JSON.stringify(expected)!==JSON.stringify(actual)){
                throw new Error('ARCANE_RUNTIME_RELEASE.json does not match the installed runtime bytes.');
            }
            console.log(`Verified Arcane runtime ${actual.contentSha256} (${actual.fileCount} files).`);
        }
    }catch(error){
        console.error(error.message);
        process.exitCode=1;
    }
}
