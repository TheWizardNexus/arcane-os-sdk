import {createHash} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const RUNTIME_MANIFEST_NAME='ARCANE_RUNTIME_RELEASE.json';
const SHA256_PATTERN=/^[a-f0-9]{64}$/;
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const MAX_VERIFIED_RUNTIME_FILE_BYTES=64*1024*1024;
const sdkRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const issuedReceipts=new WeakSet();

function fail(message,code='ARCANE_INTEGRITY_FAILED'){
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

async function emit(onEvent,event){
    if(typeof onEvent==='function')await onEvent(Object.freeze(event));
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

function immutableFileInventory(files){
    return Object.freeze(files.map(file=>Object.freeze({...file})));
}

function safeInventoryPath(value){
    if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')
        ||path.posix.isAbsolute(value)||path.posix.normalize(value)!==value
        ||value==='.'||value.startsWith('../')||value.includes('/../')){
        fail(`Runtime manifest contains an unsafe path: ${String(value)}.`);
    }
    return value;
}

function validateRelease(value){
    if(!value||typeof value!=='object'||Array.isArray(value))fail('Runtime manifest must be a JSON object.');
    const releaseKeys=['builder','contentSha256','fileCount','files','schemaVersion','sdkVersion','source','totalBytes'];
    if(Object.keys(value).sort(compareText).join('\0')!==releaseKeys.sort(compareText).join('\0')){
        fail('Runtime manifest contains missing or unsupported fields.');
    }
    if(value.schemaVersion!==1||value.builder!=='arcane-sdk-runtime-v1'){
        fail('Runtime manifest uses an unsupported schema or builder.');
    }
    if(value.sdkVersion!=='0.1.0-dev.3')fail('Runtime manifest sdkVersion is incompatible with this SDK.');
    if(!value.source||typeof value.source!=='object'
        ||Object.keys(value.source).sort(compareText).join('\0')!=='bundleVersion\0commit\0protocol\0repository'
        ||value.source.repository!=='https://github.com/TheWizardNexus/ARCANE-OS.git'
        ||typeof value.source.commit!=='string'||!/^[a-f0-9]{40}$/.test(value.source.commit)
        ||value.source.bundleVersion!=='0.8.12'||value.source.protocol!=='arcane/1'){
        fail('Runtime manifest source identity is invalid.');
    }
    if(!Array.isArray(value.files)||!Number.isSafeInteger(value.fileCount)
        ||value.fileCount!==value.files.length||!Number.isSafeInteger(value.totalBytes)
        ||value.totalBytes<0||!SHA256_PATTERN.test(value.contentSha256)){
        fail('Runtime manifest inventory summary is invalid.');
    }
    let previous='';
    let totalBytes=0;
    const seen=new Set();
    const files=value.files.map((entry,index)=>{
        if(!entry||typeof entry!=='object'||Array.isArray(entry)){
            fail(`Runtime manifest file ${index} is invalid.`);
        }
        if(Object.keys(entry).sort(compareText).join('\0')!=='bytes\0path\0sha256'){
            fail(`Runtime manifest file ${index} contains missing or unsupported fields.`);
        }
        const relative=safeInventoryPath(entry.path);
        if(relative===RUNTIME_MANIFEST_NAME||seen.has(relative)
            ||(previous&&compareText(previous,relative)>=0)){
            fail(`Runtime manifest inventory is not unique and sorted at ${relative}.`);
        }
        if(!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!SHA256_PATTERN.test(entry.sha256)){
            fail(`Runtime manifest metadata is invalid for ${relative}.`);
        }
        seen.add(relative);
        previous=relative;
        totalBytes+=entry.bytes;
        if(!Number.isSafeInteger(totalBytes))fail('Runtime manifest total byte count is too large.');
        return {path:relative,bytes:entry.bytes,sha256:entry.sha256};
    });
    if(totalBytes!==value.totalBytes)fail('Runtime manifest totalBytes does not match its inventory.');
    const aggregate=createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if(aggregate!==value.contentSha256)fail('Runtime manifest contentSha256 does not match its inventory.');
    return {...value,files};
}

async function readRelease(runtimeRoot){
    const manifestPath=path.join(runtimeRoot,RUNTIME_MANIFEST_NAME);
    let bytes;
    let manifestIdentity;
    try{
        const info=await lstat(manifestPath);
        if(info.isSymbolicLink()||!info.isFile())fail('SDK runtime manifest must be a real file.');
        const handle=await open(manifestPath,'r');
        try{
            const before=await handle.stat({bigint:true});
            bytes=await handle.readFile();
            const after=await handle.stat({bigint:true});
            if(!sameIdentity(before,after))fail('SDK runtime manifest changed while it was being read.');
            manifestIdentity=fileIdentity(after);
        }finally{
            await handle.close();
        }
    }catch(error){
        if(error?.code==='ENOENT')fail(`SDK runtime manifest is missing: ${manifestPath}.`);
        throw error;
    }
    let value;
    try{
        value=JSON.parse(bytes.toString('utf8'));
    }catch(error){
        fail(`SDK runtime manifest is not valid JSON: ${error.message}`);
    }
    return {
        release:validateRelease(value),
        manifestPath,
        manifestSha256:createHash('sha256').update(bytes).digest('hex'),
        manifestIdentity
    };
}

async function listRuntimeFiles(root,{signal}={}){
    const found=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            throwIfAborted(signal);
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            if(relative===RUNTIME_MANIFEST_NAME)continue;
            const absolute=path.join(directory,entry.name);
            const details=await lstat(absolute);
            if(details.isSymbolicLink())fail(`SDK runtime contains a symbolic link or junction: ${relative}.`);
            if(details.isDirectory())await visit(absolute,relative);
            else if(details.isFile())found.push(relative);
            else fail(`SDK runtime contains a non-file entry: ${relative}.`);
        }
    }
    await visit(root);
    return found.sort(compareText);
}

function sameIdentity(before,after){
    return before.dev===after.dev&&before.ino===after.ino&&before.size===after.size
        &&before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs
        &&before.nlink===after.nlink;
}

function fileIdentity(info){
    return Object.freeze({
        device:String(info.dev),
        inode:String(info.ino),
        bytes:Number(info.size),
        modifiedNanoseconds:String(info.mtimeNs),
        changedNanoseconds:String(info.ctimeNs),
        links:String(info.nlink)
    });
}

function identityMatches(info,identity){
    return String(info.dev)===identity.device
        &&String(info.ino)===identity.inode
        &&Number(info.size)===identity.bytes
        &&String(info.mtimeNs)===identity.modifiedNanoseconds
        &&String(info.ctimeNs)===identity.changedNanoseconds
        &&String(info.nlink)===identity.links;
}

async function assertRuntimeState({
    canonicalRoot,
    rootIdentity,
    manifestPath,
    manifestIdentity,
    identities,
    signal
}){
    throwIfAborted(signal);
    const rootBefore=await lstat(canonicalRoot,{bigint:true});
    if(rootBefore.isSymbolicLink()||!rootBefore.isDirectory()
        ||!identityMatches(rootBefore,rootIdentity)){
        fail('SDK runtime root changed after verification.');
    }

    const actualPaths=await listRuntimeFiles(canonicalRoot,{signal});
    const expectedPaths=identities.map(identity=>identity.path);
    if(JSON.stringify(actualPaths)!==JSON.stringify(expectedPaths)){
        fail('SDK runtime file inventory changed after verification.');
    }

    const manifestInfo=await lstat(manifestPath,{bigint:true});
    if(manifestInfo.isSymbolicLink()||!manifestInfo.isFile()
        ||!identityMatches(manifestInfo,manifestIdentity)){
        fail('SDK runtime manifest changed after verification.');
    }
    for(const identity of identities){
        throwIfAborted(signal);
        const filePath=path.resolve(canonicalRoot,...identity.path.split('/'));
        const relative=path.relative(canonicalRoot,filePath);
        if(relative.startsWith('..')||path.isAbsolute(relative)){
            fail(`Runtime receipt path escapes its root: ${identity.path}.`);
        }
        const info=await lstat(filePath,{bigint:true});
        if(info.isSymbolicLink()||!info.isFile()||!identityMatches(info,identity)){
            fail(`SDK runtime file changed after verification: ${identity.path}.`);
        }
    }

    const rootAfter=await lstat(canonicalRoot,{bigint:true});
    if(rootAfter.isSymbolicLink()||!rootAfter.isDirectory()
        ||!identityMatches(rootAfter,rootIdentity)
        ||!sameIdentity(rootBefore,rootAfter)){
        fail('SDK runtime root changed while its receipt was authenticated.');
    }
}

async function hashExactFile(filePath,expectedBytes,signal){
    throwIfAborted(signal);
    const handle=await open(filePath,'r');
    const hash=createHash('sha256');
    const buffer=Buffer.allocUnsafe(1024*1024);
    try{
        const before=await handle.stat({bigint:true});
        if(!before.isFile()||before.size!==BigInt(expectedBytes)){
            fail(`SDK runtime file size changed: ${filePath}.`);
        }
        while(true){
            throwIfAborted(signal);
            const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
            if(bytesRead===0)break;
            hash.update(buffer.subarray(0,bytesRead));
        }
        const after=await handle.stat({bigint:true});
        if(!sameIdentity(before,after))fail(`SDK runtime file changed while it was being verified: ${filePath}.`);
        return {sha256:hash.digest('hex'),identity:fileIdentity(after)};
    }finally{
        await handle.close();
    }
}

export function getSdkRoot(){
    return sdkRoot;
}

export async function loadRuntimeRelease({runtimeRoot=path.join(sdkRoot,'runtime')}={}){
    const resolved=path.resolve(runtimeRoot);
    return (await readRelease(resolved)).release;
}

export async function authenticateRuntimeReceipt(receipt,{
    runtimeRoot=path.join(sdkRoot,'runtime'),
    signal
}={}){
    if(!receipt||!issuedReceipts.has(receipt)){
        fail('Runtime verification receipt was not issued by this SDK process.');
    }
    throwIfAborted(signal);
    const requestedRoot=path.resolve(runtimeRoot);
    const requestedInfo=await lstat(requestedRoot,{bigint:true});
    if(requestedInfo.isSymbolicLink()||!requestedInfo.isDirectory()){
        fail('SDK runtime root must be a real directory.');
    }
    const canonicalRoot=await realpath(requestedRoot);
    if(receipt.canonicalLocation!==canonicalRoot){
        fail('Runtime verification receipt belongs to a different runtime location.');
    }
    await assertRuntimeState({
        canonicalRoot,
        rootIdentity:receipt.rootIdentity,
        manifestPath:receipt.manifestPath,
        manifestIdentity:receipt.manifestIdentity,
        identities:receipt.identities,
        signal
    });
    return receipt;
}

export async function readVerifiedRuntimeFile(receipt,{
    runtimeRoot=path.join(sdkRoot,'runtime'),
    relativePath,
    signal
}={}){
    if(!receipt||!issuedReceipts.has(receipt)){
        fail('Runtime verification receipt was not issued by this SDK process.');
    }
    throwIfAborted(signal);
    const normalized=safeInventoryPath(relativePath);
    const key=value=>process.platform==='win32'?value.toLowerCase():value;
    const file=receipt.files.find(candidate=>key(candidate.path)===key(normalized));
    if(!file)fail(`Path is not in the verified runtime inventory: ${normalized}.`);
    if(file.bytes>MAX_VERIFIED_RUNTIME_FILE_BYTES){
        fail(
            `Verified runtime file exceeds the ${MAX_VERIFIED_RUNTIME_FILE_BYTES}-byte development serving limit: ${file.path}.`
        );
    }
    const identity=receipt.identities.find(candidate=>key(candidate.path)===key(file.path));
    if(!identity)fail(`Verified runtime identity is missing for ${file.path}.`);

    const requestedRoot=path.resolve(runtimeRoot);
    const requestedInfo=await lstat(requestedRoot,{bigint:true});
    if(requestedInfo.isSymbolicLink()||!requestedInfo.isDirectory()){
        fail('SDK runtime root must be a real directory.');
    }
    const canonicalRoot=await realpath(requestedRoot);
    if(receipt.canonicalLocation!==canonicalRoot){
        fail('Runtime verification receipt belongs to a different runtime location.');
    }
    const rootInfo=await lstat(canonicalRoot,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()
        ||!identityMatches(rootInfo,receipt.rootIdentity)){
        fail('SDK runtime root changed after verification.');
    }
    const filePath=path.resolve(canonicalRoot,...file.path.split('/'));
    const relative=path.relative(canonicalRoot,filePath);
    if(relative.startsWith('..')||path.isAbsolute(relative)){
        fail(`Runtime receipt path escapes its root: ${file.path}.`);
    }
    const before=await lstat(filePath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()||!identityMatches(before,identity)){
        fail(`SDK runtime file changed after verification: ${file.path}.`);
    }
    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')fail(`SDK runtime file became a symbolic link: ${file.path}.`);
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!identityMatches(opened,identity)){
            fail(`SDK runtime file changed while it was being opened: ${file.path}.`);
        }
        const bytes=await handle.readFile();
        throwIfAborted(signal);
        const after=await handle.stat({bigint:true});
        if(!identityMatches(after,identity)||bytes.length!==file.bytes){
            fail(`SDK runtime file changed while it was being read: ${file.path}.`);
        }
        if(createHash('sha256').update(bytes).digest('hex')!==file.sha256){
            fail(`SDK runtime file hash changed: ${file.path}.`);
        }
        const current=await lstat(filePath,{bigint:true});
        if(current.isSymbolicLink()||!current.isFile()||!identityMatches(current,identity)){
            fail(`SDK runtime path changed while it was being read: ${file.path}.`);
        }
        const canonicalFile=await realpath(filePath);
        const canonicalRelative=path.relative(canonicalRoot,canonicalFile);
        if(canonicalRelative.startsWith('..')||path.isAbsolute(canonicalRelative)){
            fail(`SDK runtime path left its root: ${file.path}.`);
        }
        return bytes;
    }finally{
        await handle.close();
    }
}

export async function verifyRuntime({
    runtimeRoot=path.join(sdkRoot,'runtime'),
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const requestedRoot=path.resolve(runtimeRoot);
    let requestedInfo;
    try{requestedInfo=await lstat(requestedRoot,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')fail(`SDK runtime root does not exist: ${requestedRoot}.`);
        throw error;
    }
    if(requestedInfo.isSymbolicLink()||!requestedInfo.isDirectory())fail('SDK runtime root must be a real directory.');
    const canonicalRoot=await realpath(requestedRoot);
    const rootInfo=await lstat(canonicalRoot,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory())fail('SDK runtime root must be a real directory.');
    const rootIdentity=fileIdentity(rootInfo);
    const {release,manifestPath,manifestSha256,manifestIdentity}=await readRelease(canonicalRoot);
    await emit(onEvent,{type:'runtime.verify.started',fileCount:release.fileCount,totalBytes:release.totalBytes});
    const actualPaths=await listRuntimeFiles(canonicalRoot,{signal});
    const expectedPaths=release.files.map(file=>file.path);
    if(JSON.stringify(actualPaths)!==JSON.stringify(expectedPaths)){
        fail('SDK runtime file inventory does not match ARCANE_RUNTIME_RELEASE.json.');
    }
    const identities=[];
    let verifiedBytes=0;
    for(const [index,file] of release.files.entries()){
        throwIfAborted(signal);
        const absolute=path.resolve(canonicalRoot,...file.path.split('/'));
        const relative=path.relative(canonicalRoot,absolute);
        if(relative.startsWith('..')||path.isAbsolute(relative))fail(`Runtime file escapes its root: ${file.path}.`);
        const result=await hashExactFile(absolute,file.bytes,signal);
        if(result.sha256!==file.sha256)fail(`SDK runtime integrity check failed for ${file.path}.`);
        verifiedBytes+=file.bytes;
        identities.push({path:file.path,...result.identity});
        await emit(onEvent,{
            type:'runtime.verify.progress',
            current:index+1,
            total:release.fileCount,
            verifiedBytes,
            totalBytes:release.totalBytes,
            path:file.path
        });
    }
    const frozenIdentities=Object.freeze(identities.map(Object.freeze));
    await assertRuntimeState({
        canonicalRoot,
        rootIdentity,
        manifestPath,
        manifestIdentity,
        identities:frozenIdentities,
        signal
    });
    const receipt=Object.freeze({
        schemaVersion:1,
        kind:'arcane-sdk-runtime-verification',
        canonicalLocation:canonicalRoot,
        rootIdentity,
        manifestPath,
        manifestSha256,
        manifestIdentity,
        sdkVersion:release.sdkVersion,
        source:Object.freeze({...release.source}),
        files:immutableFileInventory(release.files),
        fileCount:release.fileCount,
        totalBytes:release.totalBytes,
        contentSha256:release.contentSha256,
        identities:frozenIdentities
    });
    issuedReceipts.add(receipt);
    await emit(onEvent,{
        type:'runtime.verify.completed',
        contentSha256:receipt.contentSha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes
    });
    return receipt;
}
