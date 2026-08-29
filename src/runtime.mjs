import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SDK_VERSION} from './constants.mjs';

const sdkRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function fail(message,code='ARCANE_RUNTIME_INVALID'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function throwIfAborted(signal){
    if(!signal?.aborted)return;
    const error=signal.reason instanceof Error?signal.reason:new Error('Operation cancelled.');
    error.code=error.code||'ARCANE_CANCELLED';
    throw error;
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

function safeRelativePath(value){
    if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')
        ||path.posix.isAbsolute(value)||path.posix.normalize(value)!==value
        ||value==='.'||value.startsWith('../')||value.includes('/../')){
        fail(`SDK runtime contains an unsafe relative path: ${String(value)}.`);
    }
    return value;
}

function resolveContained(root,relativePath){
    const normalized=safeRelativePath(relativePath);
    const resolved=path.resolve(root,...normalized.split('/'));
    const fromRoot=path.relative(root,resolved);
    if(fromRoot.startsWith('..')||path.isAbsolute(fromRoot)){
        fail(`SDK runtime path escapes its root: ${normalized}.`);
    }
    return resolved;
}

async function runtimeLocation(runtimeRoot){
    const requested=path.resolve(runtimeRoot);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`SDK runtime root does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail('SDK runtime root must be a real directory.');
    }
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical);
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()){
        fail('SDK runtime root must be a real directory.');
    }
    return canonical;
}

async function containedFile(root,relativePath){
    const normalized=safeRelativePath(relativePath);
    const filePath=resolveContained(root,normalized);
    let info;
    try{info=await lstat(filePath);}
    catch(error){
        if(error?.code==='ENOENT')fail(`SDK runtime file does not exist: ${normalized}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isFile()){
        fail(`SDK runtime path is not a real file: ${normalized}.`);
    }
    const canonicalFile=await realpath(filePath);
    const fromRoot=path.relative(root,canonicalFile);
    if(fromRoot.startsWith('..')||path.isAbsolute(fromRoot)){
        fail(`SDK runtime path escapes its root: ${normalized}.`);
    }
    return canonicalFile;
}

export function getSdkRoot(){
    return sdkRoot;
}

export async function listRuntimeFiles({
    runtimeRoot=path.join(sdkRoot,'runtime'),
    signal
}={}){
    throwIfAborted(signal);
    const root=await runtimeLocation(runtimeRoot);
    const files=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            throwIfAborted(signal);
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            safeRelativePath(relative);
            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink()){
                fail(`SDK runtime contains a symbolic link or junction: ${relative}.`);
            }
            if(info.isDirectory())await visit(absolute,relative);
            else if(info.isFile())files.push(relative);
            else fail(`SDK runtime contains a non-file entry: ${relative}.`);
        }
    }
    await visit(root);
    return files.sort(compareText);
}

export async function readRuntimeFile({
    runtimeRoot=path.join(sdkRoot,'runtime'),
    relativePath,
    signal
}={}){
    throwIfAborted(signal);
    const root=await runtimeLocation(runtimeRoot);
    const filePath=await containedFile(root,relativePath);
    const content=await readFile(filePath);
    throwIfAborted(signal);
    return content;
}

export async function loadRuntimeRelease({
    runtimeRoot=path.join(sdkRoot,'runtime'),
    signal
}={}){
    const root=await runtimeLocation(runtimeRoot);
    const files=await listRuntimeFiles({runtimeRoot:root,signal});
    return {
        sdkVersion:SDK_VERSION,
        runtimeRoot:root,
        files
    };
}
