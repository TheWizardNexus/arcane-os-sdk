import {createHash,randomUUID} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {
    lstat,
    mkdir,
    open,
    readdir,
    realpath,
    rename,
    rm
} from 'node:fs/promises';
import path from 'node:path';
import {
    authenticateRuntimeReceipt,
    getSdkRoot,
    readVerifiedRuntimeFile
} from './runtime.mjs';
import {
    authenticateSdkBrowserRuntimeReceipt,
    getSdkBrowserRuntimeRoot,
    readVerifiedSdkBrowserRuntimeFile
} from './sdk-browser-runtime.mjs';

const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const CREATE_NEW_NO_FOLLOW=FS_CONSTANTS.O_CREAT|FS_CONSTANTS.O_EXCL
    |FS_CONSTANTS.O_WRONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const MAX_VERIFIED_WORKSPACE_RUNTIME_FILE_BYTES=64*1024*1024;
const MAX_WORKSPACE_RUNTIME_RECEIPT_BYTES=4*1024*1024;
const STAGING_PREFIX='.arcane-runtime-stage-';
const BACKUP_PREFIX='.arcane-runtime-backup-';
const MATERIALIZATION_RECEIPT_DIRECTORY='.arcane';
const MATERIALIZATION_RECEIPT_NAME='installed-sdk-runtime.json';
const RECEIPT_STAGING_PREFIX='.installed-sdk-runtime-stage-';
const RECEIPT_BACKUP_PREFIX='.installed-sdk-runtime-backup-';
const MATERIALIZATION_RECEIPT_KIND='arcane-installed-sdk-runtime-projection';
const MATERIALIZATION_RECEIPT_PATH=
    `${MATERIALIZATION_RECEIPT_DIRECTORY}/${MATERIALIZATION_RECEIPT_NAME}`;
const SHA256_PATTERN=/^[a-f0-9]{64}$/u;
const UUID_PATTERN=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const issuedReceipts=new WeakSet();

function fail(message,code='ARCANE_WORKSPACE_RUNTIME_INTEGRITY_FAILED'){
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

function isRecord(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function exactKeys(value,keys){
    return isRecord(value)
        &&Object.keys(value).sort(compareText).join('\0')===[...keys].sort(compareText).join('\0');
}

function canonicalJson(value){
    return `${JSON.stringify(value,null,2)}\n`;
}

function deepFreeze(value){
    if(!value||typeof value!=='object'||Object.isFrozen(value))return value;
    for(const child of Object.values(value))deepFreeze(child);
    return Object.freeze(value);
}

function inventoryContentSha256(files){
    return createHash('sha256').update(JSON.stringify(files.map(file=>({
        path:file.path,
        bytes:file.bytes,
        sha256:file.sha256
    })))).digest('hex');
}

function safeRelativePath(value){
    if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')
        ||path.posix.isAbsolute(value)||path.posix.normalize(value)!==value
        ||value==='.'||value.startsWith('../')||value.includes('/../')){
        fail(`Workspace runtime contains an unsafe path: ${String(value)}.`);
    }
    return value;
}

function portableKey(value){
    const normalized=value.normalize('NFC');
    return process.platform==='win32'?normalized.toLowerCase():normalized;
}

function resolveContained(root,relativePath){
    const safe=safeRelativePath(relativePath);
    const absolute=path.resolve(root,...safe.split('/'));
    const relative=path.relative(root,absolute);
    if(relative.startsWith('..')||path.isAbsolute(relative)){
        fail(`Workspace runtime path escapes its root: ${safe}.`);
    }
    return absolute;
}

function projectSourcePath(sourcePath){
    const safe=safeRelativePath(sourcePath);
    if(safe.startsWith('arcane/'))return safe.slice('arcane/'.length);
    if(safe.startsWith('strong-type/')){
        return `dependencies/strong-type/${safe.slice('strong-type/'.length)}`;
    }
    fail(`SDK runtime path cannot be projected into a workspace: ${safe}.`);
}

function projectRuntimeFiles(runtimeReceipt,sdkBrowserRuntimeReceipt){
    if(!runtimeReceipt||!Array.isArray(runtimeReceipt.files)){
        fail('An authenticated SDK runtime receipt is required for workspace projection.');
    }
    if(!sdkBrowserRuntimeReceipt||!Array.isArray(sdkBrowserRuntimeReceipt.files)){
        fail('An authenticated SDK browser runtime receipt is required for workspace projection.');
    }
    const seen=new Map();
    const files=[];
    const add=(sourceFile,projectedPath,authority)=>{
        const key=portableKey(projectedPath);
        const collision=seen.get(key);
        if(collision){
            fail(
                `SDK runtime paths collide in the workspace projection: ${collision} and ${projectedPath}.`
            );
        }
        seen.set(key,projectedPath);
        files.push({
            path:projectedPath,
            sourcePath:sourceFile.path,
            authority,
            bytes:sourceFile.bytes,
            sha256:sourceFile.sha256
        });
    };
    for(const sourceFile of runtimeReceipt.files){
        add(sourceFile,projectSourcePath(sourceFile.path),'arcane-runtime');
    }
    for(const sourceFile of sdkBrowserRuntimeReceipt.files){
        add(sourceFile,`sdk/${safeRelativePath(sourceFile.path)}`,'sdk-browser-runtime');
    }
    files.sort((left,right)=>compareText(left.path,right.path));
    return files;
}

function projectedDirectories(files){
    const directories=new Set();
    for(const file of files){
        const parts=file.path.split('/');
        parts.pop();
        let current='';
        for(const part of parts){
            current=current?`${current}/${part}`:part;
            directories.add(current);
        }
    }
    return [...directories].sort(compareText);
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

function locationIdentityMatches(info,identity){
    return String(info.dev)===identity.device&&String(info.ino)===identity.inode;
}

function locationIdentity(identity){
    return Object.freeze({device:identity.device,inode:identity.inode});
}

function assertPersistentIdentity(value,label,{locationOnly=false}={}){
    const keys=locationOnly
        ?['device','inode']
        :['device','inode','bytes','modifiedNanoseconds','changedNanoseconds','links'];
    if(!exactKeys(value,keys)
        ||!keys.filter(key=>key!=='bytes')
            .every(key=>typeof value[key]==='string'&&/^[0-9]+$/u.test(value[key]))
        ||(!locationOnly&&(!Number.isSafeInteger(value.bytes)||value.bytes<0))){
        fail(`Installed SDK runtime receipt ${label} is invalid.`,
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
}

function assertPersistentSourceReceipt(value,label,{browser=false}={}){
    const keys=[
        'canonicalLocation','rootIdentity','manifestPath','manifestSha256',
        'manifestIdentity','sdkVersion','contentSha256','fileCount','totalBytes'
    ];
    if(browser)keys.push('builder');
    if(!exactKeys(value,keys)
        ||typeof value.canonicalLocation!=='string'||!path.isAbsolute(value.canonicalLocation)
        ||typeof value.manifestPath!=='string'||!path.isAbsolute(value.manifestPath)
        ||!SHA256_PATTERN.test(value.manifestSha256)
        ||typeof value.sdkVersion!=='string'||!value.sdkVersion
        ||!SHA256_PATTERN.test(value.contentSha256)
        ||!Number.isSafeInteger(value.fileCount)||value.fileCount<1
        ||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<1
        ||(browser&&(typeof value.builder!=='string'||!value.builder))){
        fail(`Installed SDK runtime receipt ${label} is invalid.`,
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    assertPersistentIdentity(value.rootIdentity,`${label} root identity`);
    assertPersistentIdentity(value.manifestIdentity,`${label} manifest identity`);
}

function validatePersistentMaterializationReceipt(document){
    if(!exactKeys(document,[
        'schemaVersion','kind','generation','workspace','receiptPath',
        'installedPackage','runtimeReceipt','sdkBrowserRuntimeReceipt','projection'
    ])||document.schemaVersion!==1||document.kind!==MATERIALIZATION_RECEIPT_KIND
        ||!UUID_PATTERN.test(document.generation)
        ||document.receiptPath!==MATERIALIZATION_RECEIPT_PATH){
        fail('Installed SDK runtime receipt envelope is invalid.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    if(!exactKeys(document.workspace,['canonicalLocation','identity'])
        ||typeof document.workspace.canonicalLocation!=='string'
        ||!path.isAbsolute(document.workspace.canonicalLocation)){
        fail('Installed SDK runtime receipt workspace is invalid.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    assertPersistentIdentity(document.workspace.identity,'workspace identity',{locationOnly:true});
    const installed=document.installedPackage;
    if(!exactKeys(installed,[
        'dependencyName','dependencyGroup','specifier','packageSource','canonicalLocation',
        'rootIdentity','packageName','packageVersion'
    ])||![
        installed.dependencyName,installed.dependencyGroup,installed.specifier,
        installed.packageSource,installed.canonicalLocation,installed.packageName,
        installed.packageVersion
    ].every(value=>typeof value==='string'&&value)
        ||!path.isAbsolute(installed.canonicalLocation)){
        fail('Installed SDK runtime receipt package identity is invalid.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    safeRelativePath(installed.packageSource);
    assertPersistentIdentity(installed.rootIdentity,'installed package root identity');
    assertPersistentSourceReceipt(document.runtimeReceipt,'runtime source receipt');
    assertPersistentSourceReceipt(
        document.sdkBrowserRuntimeReceipt,
        'browser runtime source receipt',
        {browser:true}
    );
    if(document.runtimeReceipt.sdkVersion!==installed.packageVersion
        ||document.sdkBrowserRuntimeReceipt.sdkVersion!==installed.packageVersion
        ||path.resolve(installed.canonicalLocation,'runtime')
            !==path.resolve(document.runtimeReceipt.canonicalLocation)
        ||path.resolve(installed.canonicalLocation,'browser-runtime')
            !==path.resolve(document.sdkBrowserRuntimeReceipt.canonicalLocation)){
        fail('Installed SDK runtime receipt source binding is inconsistent.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    const projection=document.projection;
    if(!exactKeys(projection,[
        'relativePath','fileCount','totalBytes','contentSha256','files'
    ])||projection.relativePath!=='arcane'||!Array.isArray(projection.files)
        ||!Number.isSafeInteger(projection.fileCount)||projection.fileCount<1
        ||!Number.isSafeInteger(projection.totalBytes)||projection.totalBytes<1
        ||!SHA256_PATTERN.test(projection.contentSha256)
        ||projection.fileCount!==projection.files.length){
        fail('Installed SDK runtime receipt projection is invalid.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    const seen=new Set();
    let totalBytes=0;
    let previous='';
    for(const [index,file] of projection.files.entries()){
        if(!exactKeys(file,['path','sourcePath','authority','bytes','sha256'])
            ||!['arcane-runtime','sdk-browser-runtime'].includes(file.authority)
            ||!Number.isSafeInteger(file.bytes)||file.bytes<0
            ||!SHA256_PATTERN.test(file.sha256)){
            fail(`Installed SDK runtime receipt projection file ${String(index)} is invalid.`,
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        const projectedPath=safeRelativePath(file.path);
        safeRelativePath(file.sourcePath);
        const key=portableKey(projectedPath);
        if(seen.has(key)||(index>0&&compareText(previous,projectedPath)>=0)){
            fail('Installed SDK runtime receipt projection inventory is not unique and sorted.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        seen.add(key);
        previous=projectedPath;
        totalBytes+=file.bytes;
        if(!Number.isSafeInteger(totalBytes)){
            fail('Installed SDK runtime receipt projection byte total is invalid.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
    }
    if(totalBytes!==projection.totalBytes
        ||inventoryContentSha256(projection.files)!==projection.contentSha256){
        fail('Installed SDK runtime receipt projection inventory digest is invalid.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    return document;
}

function persistentSourceReceipt(receipt,{browser=false}={}){
    const result={
        canonicalLocation:receipt.canonicalLocation,
        rootIdentity:receipt.rootIdentity,
        manifestPath:receipt.manifestPath,
        manifestSha256:receipt.manifestSha256,
        manifestIdentity:receipt.manifestIdentity,
        sdkVersion:receipt.sdkVersion,
        contentSha256:receipt.contentSha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes
    };
    if(browser)result.builder=receipt.builder;
    return result;
}

async function createPersistentMaterializationReceipt({
    generation,
    workspace,
    installedSdkAuthority,
    runtimeReceipt,
    sdkBrowserRuntimeReceipt,
    expectedFiles
}){
    const {declaration,installation}=installedSdkAuthority??{};
    if(!declaration||!installation){
        fail('Installed SDK authority is required for a persistent workspace projection receipt.');
    }
    const packageInfo=await lstat(installation.canonicalPackageRoot,{bigint:true});
    if(packageInfo.isSymbolicLink()||!packageInfo.isDirectory()){
        fail('Installed SDK package root must remain a real directory.');
    }
    const canonicalPackageRoot=await realpath(installation.canonicalPackageRoot);
    if(canonicalPackageRoot!==installation.canonicalPackageRoot){
        fail('Installed SDK package root changed while materialization was active.');
    }
    if(runtimeReceipt.sdkVersion!==installation.packageVersion
        ||sdkBrowserRuntimeReceipt.sdkVersion!==installation.packageVersion){
        fail('Installed SDK package and source receipt versions do not match.');
    }
    const files=expectedFiles.map(file=>({
        path:file.path,
        sourcePath:file.sourcePath,
        authority:file.authority,
        bytes:file.bytes,
        sha256:file.sha256
    }));
    const document={
        schemaVersion:1,
        kind:MATERIALIZATION_RECEIPT_KIND,
        generation,
        workspace:{
            canonicalLocation:workspace.canonicalRoot,
            identity:locationIdentity(workspace.identity)
        },
        receiptPath:MATERIALIZATION_RECEIPT_PATH,
        installedPackage:{
            dependencyName:declaration.dependencyName,
            dependencyGroup:declaration.dependencyGroup,
            specifier:declaration.specifier,
            packageSource:declaration.packageSource,
            canonicalLocation:canonicalPackageRoot,
            rootIdentity:fileIdentity(packageInfo),
            packageName:installation.packageName,
            packageVersion:installation.packageVersion
        },
        runtimeReceipt:persistentSourceReceipt(runtimeReceipt),
        sdkBrowserRuntimeReceipt:persistentSourceReceipt(
            sdkBrowserRuntimeReceipt,
            {browser:true}
        ),
        projection:{
            relativePath:'arcane',
            fileCount:files.length,
            totalBytes:files.reduce((total,file)=>total+file.bytes,0),
            contentSha256:inventoryContentSha256(files),
            files
        }
    };
    validatePersistentMaterializationReceipt(document);
    return deepFreeze(document);
}

async function workspaceLocation(workspaceRoot){
    const requestedRoot=path.resolve(workspaceRoot);
    let info;
    try{info=await lstat(requestedRoot,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')fail(`Workspace root does not exist: ${requestedRoot}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail('Workspace root must be a real directory.');
    }
    const canonicalRoot=await realpath(requestedRoot);
    const canonicalInfo=await lstat(canonicalRoot,{bigint:true});
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()
        ||!sameIdentity(info,canonicalInfo)){
        fail('Workspace root changed while its location was being resolved.');
    }
    return {
        canonicalRoot,
        identity:fileIdentity(canonicalInfo)
    };
}

async function assertRealDirectoryLocation(directory,identity,label){
    let before;
    try{before=await lstat(directory,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} is missing.`);
        throw error;
    }
    if(before.isSymbolicLink()||!before.isDirectory()
        ||!locationIdentityMatches(before,identity)){
        fail(`${label} changed while workspace runtime materialization was active.`);
    }
    const canonical=await realpath(directory);
    if(canonical!==directory){
        fail(`${label} became a symbolic link or junction.`);
    }
    const after=await lstat(directory,{bigint:true});
    if(after.isSymbolicLink()||!after.isDirectory()
        ||!locationIdentityMatches(after,identity)
        ||!locationIdentityMatches(before,fileIdentity(after))){
        fail(`${label} changed while its location was being authenticated.`);
    }
}

async function inspectTree(root,{signal}={}){
    throwIfAborted(signal);
    const rootInfo=await lstat(root,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail('Workspace arcane runtime root must be a real directory.');
    }
    const files=[];
    const directories=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            throwIfAborted(signal);
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            safeRelativePath(relative);
            const absolute=path.join(directory,entry.name);
            const details=await lstat(absolute,{bigint:true});
            if(details.isSymbolicLink()){
                fail(`Workspace arcane runtime contains a symbolic link or junction: ${relative}.`);
            }
            if(details.isDirectory()){
                directories.push({path:relative,identity:fileIdentity(details)});
                await visit(absolute,relative);
            }else if(details.isFile()){
                files.push(relative);
            }else{
                fail(`Workspace arcane runtime contains a non-file entry: ${relative}.`);
            }
        }
    }
    await visit(root);
    files.sort(compareText);
    directories.sort((left,right)=>compareText(left.path,right.path));
    return {rootIdentity:fileIdentity(rootInfo),files,directories};
}

async function hashExactFile(filePath,expectedBytes,signal){
    throwIfAborted(signal);
    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')fail(`Workspace runtime file became a symbolic link: ${filePath}.`);
        throw error;
    }
    const hash=createHash('sha256');
    const buffer=Buffer.allocUnsafe(1024*1024);
    try{
        const before=await handle.stat({bigint:true});
        if(!before.isFile()||before.size!==BigInt(expectedBytes)){
            fail(`Workspace runtime file size is invalid: ${filePath}.`);
        }
        while(true){
            throwIfAborted(signal);
            const {bytesRead}=await handle.read(buffer,0,buffer.length,null);
            if(bytesRead===0)break;
            hash.update(buffer.subarray(0,bytesRead));
        }
        const after=await handle.stat({bigint:true});
        if(!sameIdentity(before,after)){
            fail(`Workspace runtime file changed while it was being verified: ${filePath}.`);
        }
        return {sha256:hash.digest('hex'),identity:fileIdentity(after)};
    }finally{
        await handle.close();
    }
}

async function assertIdentityAt(root,entry,{directory}){
    const absolute=resolveContained(root,entry.path);
    const info=await lstat(absolute,{bigint:true});
    if(info.isSymbolicLink()
        ||(directory?!info.isDirectory():!info.isFile())
        ||!identityMatches(info,entry)){
        fail(`Workspace runtime ${directory?'directory':'file'} changed after verification: ${entry.path}.`);
    }
}

async function verifyProjectedTree(root,expectedFiles,{signal,onProgress}={}){
    const expectedPaths=expectedFiles.map(file=>file.path);
    const expectedDirectoryPaths=projectedDirectories(expectedFiles);
    const before=await inspectTree(root,{signal});
    if(JSON.stringify(before.files)!==JSON.stringify(expectedPaths)){
        fail('Workspace arcane runtime file inventory does not match the authenticated SDK runtime.');
    }
    if(JSON.stringify(before.directories.map(entry=>entry.path))
        !==JSON.stringify(expectedDirectoryPaths)){
        fail('Workspace arcane runtime directory inventory does not match the authenticated SDK runtime.');
    }

    const identities=[];
    let verifiedBytes=0;
    for(const [index,file] of expectedFiles.entries()){
        throwIfAborted(signal);
        const absolute=resolveContained(root,file.path);
        const result=await hashExactFile(absolute,file.bytes,signal);
        if(result.sha256!==file.sha256){
            fail(`Workspace runtime integrity check failed for ${file.path}.`);
        }
        verifiedBytes+=file.bytes;
        identities.push({path:file.path,...result.identity});
        if(onProgress){
            await onProgress({
                current:index+1,
                total:expectedFiles.length,
                verifiedBytes,
                totalBytes:expectedFiles.reduce((total,entry)=>total+entry.bytes,0),
                path:file.path
            });
        }
    }

    const rootAfter=await lstat(root,{bigint:true});
    if(rootAfter.isSymbolicLink()||!rootAfter.isDirectory()
        ||!identityMatches(rootAfter,before.rootIdentity)){
        fail('Workspace arcane runtime root changed while it was being verified.');
    }
    for(const directory of before.directories){
        throwIfAborted(signal);
        await assertIdentityAt(root,{path:directory.path,...directory.identity},{directory:true});
    }
    for(const identity of identities){
        throwIfAborted(signal);
        await assertIdentityAt(root,identity,{directory:false});
    }
    return {
        rootIdentity:before.rootIdentity,
        directoryIdentities:before.directories.map(entry=>Object.freeze({
            path:entry.path,
            ...entry.identity
        })),
        identities:identities.map(Object.freeze)
    };
}

async function assertRequestedWorkspace(receipt,workspaceRoot){
    const requested=await workspaceLocation(workspaceRoot);
    if(requested.canonicalRoot!==receipt.canonicalWorkspaceLocation
        ||!locationIdentityMatches(
            {
                dev:BigInt(requested.identity.device),
                ino:BigInt(requested.identity.inode)
            },
            receipt.workspaceIdentity
        )){
        fail('Workspace runtime receipt belongs to a different workspace location.');
    }
    const expectedRoot=path.join(requested.canonicalRoot,'arcane');
    const canonicalRoot=await realpath(expectedRoot);
    if(canonicalRoot!==receipt.canonicalLocation||canonicalRoot!==expectedRoot){
        fail('Workspace runtime receipt belongs to a different arcane runtime location.');
    }
    return {workspace:requested,root:canonicalRoot};
}

async function assertWorkspaceRuntimeState(receipt,{workspaceRoot,signal}){
    throwIfAborted(signal);
    const {root}=await assertRequestedWorkspace(receipt,workspaceRoot);
    const actual=await inspectTree(root,{signal});
    if(!identityMatches(
        {
            dev:BigInt(actual.rootIdentity.device),
            ino:BigInt(actual.rootIdentity.inode),
            size:BigInt(actual.rootIdentity.bytes),
            mtimeNs:BigInt(actual.rootIdentity.modifiedNanoseconds),
            ctimeNs:BigInt(actual.rootIdentity.changedNanoseconds),
            nlink:BigInt(actual.rootIdentity.links)
        },
        receipt.rootIdentity
    )){
        fail('Workspace arcane runtime root changed after verification.');
    }
    const actualPaths=actual.files;
    const expectedPaths=receipt.files.map(file=>file.path);
    if(JSON.stringify(actualPaths)!==JSON.stringify(expectedPaths)){
        fail('Workspace arcane runtime file inventory changed after verification.');
    }
    const actualDirectories=actual.directories.map(entry=>entry.path);
    const expectedDirectories=receipt.directoryIdentities.map(entry=>entry.path);
    if(JSON.stringify(actualDirectories)!==JSON.stringify(expectedDirectories)){
        fail('Workspace arcane runtime directory inventory changed after verification.');
    }
    for(const directory of receipt.directoryIdentities){
        throwIfAborted(signal);
        await assertIdentityAt(root,directory,{directory:true});
    }
    for(const identity of receipt.identities){
        throwIfAborted(signal);
        await assertIdentityAt(root,identity,{directory:false});
    }
    return receipt;
}

async function writeNewFile(filePath,bytes){
    let handle;
    try{
        handle=await open(filePath,CREATE_NEW_NO_FOLLOW,0o644);
    }catch(error){
        if(error?.code==='ELOOP')fail(`Workspace runtime staging path became a symbolic link: ${filePath}.`);
        throw error;
    }
    try{
        await handle.writeFile(bytes);
        await handle.sync();
    }finally{
        await handle.close();
    }
}

async function readPersistentMaterializationReceipt(receiptPath,{signal}={}){
    throwIfAborted(signal);
    let handle;
    try{
        handle=await open(receiptPath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP'){
            fail('Installed SDK runtime receipt must not be a symbolic link.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        throw error;
    }
    try{
        const before=await handle.stat({bigint:true});
        if(!before.isFile()||before.size>BigInt(MAX_WORKSPACE_RUNTIME_RECEIPT_BYTES)){
            fail('Installed SDK runtime receipt is not a bounded regular file.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        const bytes=await handle.readFile();
        throwIfAborted(signal);
        const after=await handle.stat({bigint:true});
        if(!sameIdentity(before,after)){
            fail('Installed SDK runtime receipt changed while it was being read.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        let document;
        try{document=JSON.parse(bytes.toString('utf8'));}
        catch(error){
            fail(`Installed SDK runtime receipt is not valid JSON: ${error.message}`,
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        validatePersistentMaterializationReceipt(document);
        if(!bytes.equals(Buffer.from(canonicalJson(document)))){
            fail('Installed SDK runtime receipt bytes are not canonical.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        const named=await lstat(receiptPath,{bigint:true});
        if(named.isSymbolicLink()||!named.isFile()||!sameIdentity(named,after)){
            fail('Installed SDK runtime receipt path changed while it was being read.',
                'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
        }
        return Object.freeze({
            document:deepFreeze(document),
            identity:fileIdentity(after)
        });
    }finally{
        await handle.close();
    }
}

async function assertOwnedFileLocation(filePath,identity,label){
    const info=await lstat(filePath,{bigint:true});
    if(info.isSymbolicLink()||!info.isFile()||!locationIdentityMatches(info,identity)){
        fail(`${label} changed while workspace runtime materialization was active.`);
    }
}

async function removeOwnedFile(filePath,identity,label){
    await assertOwnedFileLocation(filePath,identity,label);
    await rm(filePath,{force:true});
    try{
        await lstat(filePath,{bigint:true});
        fail(`${label} remained after cleanup.`);
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
}

async function materializationMetadataLocation(workspace){
    const metadataRoot=path.join(workspace.canonicalRoot,MATERIALIZATION_RECEIPT_DIRECTORY);
    let info;
    try{info=await lstat(metadataRoot,{bigint:true});}
    catch(error){
        if(error?.code!=='ENOENT')throw error;
        await mkdir(metadataRoot,{mode:0o700});
        info=await lstat(metadataRoot,{bigint:true});
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail('Workspace materialization metadata root must be a real directory.');
    }
    const canonical=await realpath(metadataRoot);
    if(canonical!==metadataRoot){
        fail('Workspace materialization metadata root must not resolve through another path.');
    }
    return Object.freeze({root:metadataRoot,identity:fileIdentity(info)});
}

async function optionalPathIdentity(target){
    try{return fileIdentity(await lstat(target,{bigint:true}));}
    catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
}

async function cleanupOwnedTree(ownedRoot,workspace,ownedIdentity,{prefix,label}){
    const ownedParent=path.dirname(ownedRoot);
    const ownedName=path.basename(ownedRoot);
    if(ownedParent!==workspace.canonicalRoot||!ownedName.startsWith(prefix)){
        fail(
            `Refusing to clean an unowned workspace runtime ${label} path: ${ownedRoot} `
            +`(parent ${ownedParent}; expected ${workspace.canonicalRoot}).`
        );
    }
    await assertRealDirectoryLocation(
        workspace.canonicalRoot,
        workspace.identity,
        'Workspace root'
    );
    let ownedInfo;
    try{ownedInfo=await lstat(ownedRoot,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT')return;
        throw error;
    }
    if(ownedInfo.isSymbolicLink()||!ownedInfo.isDirectory()
        ||!locationIdentityMatches(ownedInfo,ownedIdentity)){
        fail(`Refusing to clean a workspace runtime ${label} path whose identity changed.`);
    }
    await assertRealDirectoryLocation(
        ownedRoot,
        ownedIdentity,
        `Workspace runtime ${label} directory`
    );
    try{await inspectTree(ownedRoot);}
    catch(error){
        fail(`Refusing to clean an unauthenticated workspace runtime ${label} tree: ${error.message}`);
    }
    await assertRealDirectoryLocation(
        workspace.canonicalRoot,
        workspace.identity,
        'Workspace root'
    );
    await assertRealDirectoryLocation(
        ownedRoot,
        ownedIdentity,
        `Workspace runtime ${label} directory`
    );
    await rm(ownedRoot,{recursive:true,force:true});
    try{
        await lstat(ownedRoot,{bigint:true});
        fail(`Workspace runtime ${label} path remained after cleanup.`);
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
    await assertRealDirectoryLocation(
        workspace.canonicalRoot,
        workspace.identity,
        'Workspace root'
    );
}

async function cleanupStaging(stagingRoot,workspace,stagingIdentity){
    return cleanupOwnedTree(stagingRoot,workspace,stagingIdentity,{
        prefix:STAGING_PREFIX,
        label:'staging'
    });
}

export async function verifyWorkspaceRuntime({
    workspaceRoot,
    runtimeRoot=path.join(getSdkRoot(),'runtime'),
    runtimeReceipt,
    browserRuntimeRoot=getSdkBrowserRuntimeRoot(),
    sdkBrowserRuntimeReceipt,
    signal,
    onEvent
}={}){
    if(!workspaceRoot)fail('workspaceRoot is required to verify a workspace runtime.');
    await authenticateRuntimeReceipt(runtimeReceipt,{runtimeRoot,signal});
    await authenticateSdkBrowserRuntimeReceipt(sdkBrowserRuntimeReceipt,{
        browserRuntimeRoot,
        signal
    });
    const expectedFiles=projectRuntimeFiles(runtimeReceipt,sdkBrowserRuntimeReceipt);
    const workspace=await workspaceLocation(workspaceRoot);
    const projectedRoot=path.join(workspace.canonicalRoot,'arcane');
    let rootInfo;
    try{rootInfo=await lstat(projectedRoot,{bigint:true});}
    catch(error){
        if(error?.code==='ENOENT'){
            fail(`Workspace arcane runtime is missing: ${projectedRoot}.`);
        }
        throw error;
    }
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail('Workspace arcane runtime root must be a real directory.');
    }
    const canonicalRoot=await realpath(projectedRoot);
    if(canonicalRoot!==projectedRoot){
        fail('Workspace arcane runtime root must not resolve outside its direct workspace location.');
    }

    const totalBytes=expectedFiles.reduce((total,file)=>total+file.bytes,0);
    await emit(onEvent,{
        type:'workspace.runtime.verify.started',
        fileCount:expectedFiles.length,
        totalBytes
    });
    const verified=await verifyProjectedTree(canonicalRoot,expectedFiles,{
        signal,
        onProgress:event=>emit(onEvent,{type:'workspace.runtime.verify.progress',...event})
    });
    const inventory=expectedFiles.map(file=>Object.freeze({...file}));
    const contentInventory=expectedFiles.map(file=>({
        path:file.path,
        bytes:file.bytes,
        sha256:file.sha256
    }));
    const receipt=Object.freeze({
        schemaVersion:1,
        kind:'arcane-workspace-runtime-verification',
        canonicalWorkspaceLocation:workspace.canonicalRoot,
        workspaceIdentity:workspace.identity,
        canonicalLocation:canonicalRoot,
        rootIdentity:verified.rootIdentity,
        sourceRuntimeLocation:runtimeReceipt.canonicalLocation,
        sourceManifestSha256:runtimeReceipt.manifestSha256,
        sourceContentSha256:runtimeReceipt.contentSha256,
        sourceBrowserRuntimeLocation:sdkBrowserRuntimeReceipt.canonicalLocation,
        sourceBrowserManifestSha256:sdkBrowserRuntimeReceipt.manifestSha256,
        sourceBrowserContentSha256:sdkBrowserRuntimeReceipt.contentSha256,
        sdkVersion:runtimeReceipt.sdkVersion,
        sources:Object.freeze({
            arcane:Object.freeze({
                authority:'arcane-os-sdk',
                location:runtimeReceipt.canonicalLocation,
                manifestSha256:runtimeReceipt.manifestSha256,
                contentSha256:runtimeReceipt.contentSha256,
                source:runtimeReceipt.source
            }),
            sdkBrowser:Object.freeze({
                authority:'arcane-os-sdk',
                location:sdkBrowserRuntimeReceipt.canonicalLocation,
                manifestSha256:sdkBrowserRuntimeReceipt.manifestSha256,
                contentSha256:sdkBrowserRuntimeReceipt.contentSha256,
                source:sdkBrowserRuntimeReceipt.source
            })
        }),
        files:Object.freeze(inventory),
        fileCount:inventory.length,
        totalBytes,
        contentSha256:createHash('sha256')
            .update(JSON.stringify(contentInventory))
            .digest('hex'),
        directoryIdentities:Object.freeze(verified.directoryIdentities),
        identities:Object.freeze(verified.identities)
    });
    issuedReceipts.add(receipt);
    await emit(onEvent,{
        type:'workspace.runtime.verify.completed',
        sourceContentSha256:receipt.sourceContentSha256,
        sourceBrowserContentSha256:receipt.sourceBrowserContentSha256,
        contentSha256:receipt.contentSha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes
    });
    return receipt;
}

function attachMaterialization(receipt,{
    status,
    persistentReceipt,
    receiptPath,
    cleanupWarnings=[]
}){
    const result=Object.freeze({
        ...receipt,
        materialization:Object.freeze({
            status,
            generation:persistentReceipt.generation,
            receiptPath,
            persistentReceipt,
            cleanupWarnings:Object.freeze([...cleanupWarnings])
        })
    });
    issuedReceipts.add(result);
    return result;
}

async function inspectInstalledMaterialization({
    workspace,
    destinationRoot,
    receiptPath,
    desiredReceipt,
    signal
}){
    const destinationIdentity=await optionalPathIdentity(destinationRoot);
    const receiptIdentity=await optionalPathIdentity(receiptPath);
    if(!destinationIdentity&&!receiptIdentity)return Object.freeze({kind:'absent'});
    if(!destinationIdentity){
        fail('Installed SDK runtime receipt exists without its workspace projection.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    const destinationInfo=await lstat(destinationRoot,{bigint:true});
    if(destinationInfo.isSymbolicLink()||!destinationInfo.isDirectory()){
        fail('Existing workspace arcane runtime path must be a real directory.');
    }
    const canonicalDestination=await realpath(destinationRoot);
    if(canonicalDestination!==destinationRoot){
        fail('Existing workspace arcane runtime path must not resolve through another path.');
    }
    if(!receiptIdentity){
        await inspectTree(destinationRoot,{signal});
        return Object.freeze({
            kind:'legacy',
            destinationIdentity:fileIdentity(destinationInfo)
        });
    }
    const recorded=await readPersistentMaterializationReceipt(receiptPath,{signal});
    if(recorded.document.workspace.canonicalLocation!==workspace.canonicalRoot
        ||recorded.document.workspace.identity.device!==workspace.identity.device
        ||recorded.document.workspace.identity.inode!==workspace.identity.inode){
        fail('Installed SDK runtime receipt belongs to a different workspace.',
            'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
    }
    if(canonicalJson(recorded.document)===canonicalJson(desiredReceipt)){
        return Object.freeze({
            kind:'current',
            document:recorded.document,
            destinationIdentity:fileIdentity(destinationInfo),
            receiptIdentity:recorded.identity
        });
    }
    await verifyProjectedTree(
        destinationRoot,
        recorded.document.projection.files,
        {signal}
    );
    return Object.freeze({
        kind:'stale',
        document:recorded.document,
        destinationIdentity:fileIdentity(destinationInfo),
        receiptIdentity:recorded.identity
    });
}

async function rollbackInstalledReplacement(state){
    const errors=[];
    const attempt=async operation=>{
        try{await operation();}
        catch(error){errors.push(error);}
    };
    if(state.newReceiptMoved){
        await attempt(()=>rename(state.receiptPath,state.receiptStagingPath));
    }
    if(state.newRootMoved){
        await attempt(()=>rename(state.destinationRoot,state.stagingRoot));
    }
    if(state.oldReceiptMoved){
        await attempt(()=>rename(state.receiptBackupPath,state.receiptPath));
    }
    if(state.oldRootMoved){
        await attempt(()=>rename(state.backupRoot,state.destinationRoot));
    }
    if(errors.length){
        throw new AggregateError(
            errors,
            'Installed SDK runtime replacement failed and its prior projection could not be fully restored.'
        );
    }
    state.newReceiptMoved=false;
    state.newRootMoved=false;
    state.oldReceiptMoved=false;
    state.oldRootMoved=false;
}

async function materializeInstalledWorkspaceRuntime({
    workspaceRoot,
    runtimeRoot,
    runtimeReceipt,
    browserRuntimeRoot,
    sdkBrowserRuntimeReceipt,
    installedSdkAuthority,
    signal,
    onEvent
}){
    const expectedFiles=projectRuntimeFiles(runtimeReceipt,sdkBrowserRuntimeReceipt);
    const workspace=await workspaceLocation(workspaceRoot);
    const metadata=await materializationMetadataLocation(workspace);
    const destinationRoot=path.join(workspace.canonicalRoot,'arcane');
    const receiptPath=path.join(metadata.root,MATERIALIZATION_RECEIPT_NAME);
    const generation=randomUUID();
    let desiredReceipt=await createPersistentMaterializationReceipt({
        generation,
        workspace,
        installedSdkAuthority,
        runtimeReceipt,
        sdkBrowserRuntimeReceipt,
        expectedFiles
    });
    let existingReceipt=null;
    try{
        existingReceipt=(await readPersistentMaterializationReceipt(receiptPath,{signal})).document;
        desiredReceipt=await createPersistentMaterializationReceipt({
            generation:existingReceipt.generation,
            workspace,
            installedSdkAuthority,
            runtimeReceipt,
            sdkBrowserRuntimeReceipt,
            expectedFiles
        });
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
    const existing=await inspectInstalledMaterialization({
        workspace,
        destinationRoot,
        receiptPath,
        desiredReceipt,
        signal
    });
    if(existing.kind==='current'){
        const verified=await verifyWorkspaceRuntime({
            workspaceRoot,
            runtimeRoot,
            runtimeReceipt,
            browserRuntimeRoot,
            sdkBrowserRuntimeReceipt,
            signal,
            onEvent
        });
        const result=attachMaterialization(verified,{
            status:'reused',
            persistentReceipt:existing.document,
            receiptPath
        });
        await emit(onEvent,{
            type:'workspace.runtime.materialize.reused',
            status:'reused',
            generation:existing.document.generation,
            receiptPath
        });
        return result;
    }

    desiredReceipt=await createPersistentMaterializationReceipt({
        generation,
        workspace,
        installedSdkAuthority,
        runtimeReceipt,
        sdkBrowserRuntimeReceipt,
        expectedFiles
    });
    const operationSuffix=`${String(process.pid)}-${generation}`;
    const stagingRoot=path.join(workspace.canonicalRoot,`${STAGING_PREFIX}${operationSuffix}`);
    const backupRoot=path.join(workspace.canonicalRoot,`${BACKUP_PREFIX}${operationSuffix}`);
    const receiptStagingPath=path.join(
        metadata.root,
        `${RECEIPT_STAGING_PREFIX}${operationSuffix}.json`
    );
    const receiptBackupPath=path.join(
        metadata.root,
        `${RECEIPT_BACKUP_PREFIX}${operationSuffix}.json`
    );
    await mkdir(stagingRoot,{mode:0o700});
    const stagingInfo=await lstat(stagingRoot,{bigint:true});
    if(stagingInfo.isSymbolicLink()||!stagingInfo.isDirectory()){
        fail('Workspace runtime staging path must be a real directory.');
    }
    const stagingIdentity=fileIdentity(stagingInfo);
    const transaction={
        destinationRoot,
        stagingRoot,
        backupRoot,
        receiptPath,
        receiptStagingPath,
        receiptBackupPath,
        newReceiptMoved:false,
        newRootMoved:false,
        oldReceiptMoved:false,
        oldRootMoved:false
    };
    let stagingCleaned=false;
    let receiptStagingIdentity;
    let uncertainCommit=false;
    try{
        const totalBytes=expectedFiles.reduce((total,file)=>total+file.bytes,0);
        const bufferedEvents=[{
            type:'workspace.runtime.materialize.started',
            status:existing.kind==='absent'?'created':'refreshed',
            generation,
            fileCount:expectedFiles.length,
            totalBytes
        }];
        let writtenBytes=0;
        for(const [index,file] of expectedFiles.entries()){
            throwIfAborted(signal);
            const bytes=file.authority==='sdk-browser-runtime'
                ?await readVerifiedSdkBrowserRuntimeFile(sdkBrowserRuntimeReceipt,{
                    browserRuntimeRoot,
                    relativePath:file.sourcePath,
                    signal
                })
                :await readVerifiedRuntimeFile(runtimeReceipt,{
                    runtimeRoot,
                    relativePath:file.sourcePath,
                    signal
                });
            const destination=resolveContained(stagingRoot,file.path);
            await mkdir(path.dirname(destination),{recursive:true,mode:0o755});
            await writeNewFile(destination,bytes);
            writtenBytes+=bytes.length;
            bufferedEvents.push({
                type:'workspace.runtime.materialize.progress',
                current:index+1,
                total:expectedFiles.length,
                writtenBytes,
                totalBytes,
                path:file.path
            });
        }
        await verifyProjectedTree(stagingRoot,expectedFiles,{signal});
        await writeNewFile(receiptStagingPath,Buffer.from(canonicalJson(desiredReceipt)));
        const receiptStagingInfo=await lstat(receiptStagingPath,{bigint:true});
        if(receiptStagingInfo.isSymbolicLink()||!receiptStagingInfo.isFile()){
            fail('Workspace runtime staged receipt must be a real file.');
        }
        receiptStagingIdentity=fileIdentity(receiptStagingInfo);
        await readPersistentMaterializationReceipt(receiptStagingPath,{signal});

        for(const event of bufferedEvents)await emit(onEvent,event);
        throwIfAborted(signal);
        await assertRealDirectoryLocation(
            workspace.canonicalRoot,
            workspace.identity,
            'Workspace root'
        );
        await assertRealDirectoryLocation(
            metadata.root,
            metadata.identity,
            'Workspace materialization metadata root'
        );
        await assertRealDirectoryLocation(
            stagingRoot,
            stagingIdentity,
            'Workspace runtime staging directory'
        );
        await assertOwnedFileLocation(
            receiptStagingPath,
            receiptStagingIdentity,
            'Workspace runtime staged receipt'
        );
        await verifyProjectedTree(stagingRoot,expectedFiles,{signal});
        if(existing.destinationIdentity){
            await assertRealDirectoryLocation(
                destinationRoot,
                existing.destinationIdentity,
                'Existing workspace runtime projection'
            );
        }
        if(existing.receiptIdentity){
            await assertOwnedFileLocation(
                receiptPath,
                existing.receiptIdentity,
                'Existing workspace runtime receipt'
            );
        }
        throwIfAborted(signal);

        try{
            if(existing.destinationIdentity){
                await rename(destinationRoot,backupRoot);
                transaction.oldRootMoved=true;
            }
            if(existing.receiptIdentity){
                await rename(receiptPath,receiptBackupPath);
                transaction.oldReceiptMoved=true;
            }
            await rename(stagingRoot,destinationRoot);
            transaction.newRootMoved=true;
            await rename(receiptStagingPath,receiptPath);
            transaction.newReceiptMoved=true;
        }catch(commitError){
            try{await rollbackInstalledReplacement(transaction);}
            catch(rollbackError){
                uncertainCommit=true;
                throw new AggregateError(
                    [commitError,rollbackError],
                    'Installed SDK runtime replacement and rollback both failed.',
                    {cause:commitError}
                );
            }
            throw commitError;
        }

        let committedPersistent;
        let verified;
        try{
            committedPersistent=(await readPersistentMaterializationReceipt(receiptPath)).document;
            if(canonicalJson(committedPersistent)!==canonicalJson(desiredReceipt)){
                fail('Committed installed SDK runtime receipt does not match the staged generation.',
                    'ARCANE_WORKSPACE_RUNTIME_RECEIPT_INVALID');
            }
            verified=await verifyWorkspaceRuntime({
                workspaceRoot,
                runtimeRoot,
                runtimeReceipt,
                browserRuntimeRoot,
                sdkBrowserRuntimeReceipt
            });
        }catch(verificationError){
            try{await rollbackInstalledReplacement(transaction);}
            catch(rollbackError){
                uncertainCommit=true;
                throw new AggregateError(
                    [verificationError,rollbackError],
                    'Installed SDK runtime verification and rollback both failed.',
                    {cause:verificationError}
                );
            }
            throw verificationError;
        }

        const cleanupWarnings=[];
        if(existing.destinationIdentity){
            try{
                await cleanupOwnedTree(backupRoot,workspace,existing.destinationIdentity,{
                    prefix:BACKUP_PREFIX,
                    label:'backup'
                });
                transaction.oldRootMoved=false;
            }catch(error){cleanupWarnings.push(String(error?.message??error));}
        }
        if(existing.receiptIdentity){
            try{
                await removeOwnedFile(
                    receiptBackupPath,
                    existing.receiptIdentity,
                    'Workspace runtime receipt backup'
                );
                transaction.oldReceiptMoved=false;
            }catch(error){cleanupWarnings.push(String(error?.message??error));}
        }
        transaction.newRootMoved=false;
        transaction.newReceiptMoved=false;
        stagingCleaned=true;
        const status=existing.kind==='absent'?'created':'refreshed';
        const result=attachMaterialization(verified,{
            status,
            persistentReceipt:committedPersistent,
            receiptPath,
            cleanupWarnings
        });
        await emit(onEvent,{
            type:'workspace.runtime.materialize.completed',
            status,
            generation,
            receiptPath,
            contentSha256:result.contentSha256,
            sourceContentSha256:result.sourceContentSha256,
            sourceBrowserContentSha256:result.sourceBrowserContentSha256,
            fileCount:result.fileCount,
            totalBytes:result.totalBytes,
            cleanupWarnings:Object.freeze([...cleanupWarnings])
        });
        return result;
    }finally{
        if(!uncertainCommit&&!stagingCleaned){
            await cleanupStaging(stagingRoot,workspace,stagingIdentity);
            if(receiptStagingIdentity){
                try{
                    await removeOwnedFile(
                        receiptStagingPath,
                        receiptStagingIdentity,
                        'Workspace runtime staged receipt'
                    );
                }catch(error){
                    if(error?.code!=='ENOENT')throw error;
                }
            }
        }
    }
}

export async function materializeWorkspaceRuntime({
    workspaceRoot,
    runtimeRoot=path.join(getSdkRoot(),'runtime'),
    runtimeReceipt,
    browserRuntimeRoot=getSdkBrowserRuntimeRoot(),
    sdkBrowserRuntimeReceipt,
    installedSdkAuthority,
    signal,
    onEvent
}={}){
    if(!workspaceRoot)fail('workspaceRoot is required to materialize a workspace runtime.');
    await authenticateRuntimeReceipt(runtimeReceipt,{runtimeRoot,signal});
    await authenticateSdkBrowserRuntimeReceipt(sdkBrowserRuntimeReceipt,{
        browserRuntimeRoot,
        signal
    });
    if(installedSdkAuthority){
        return materializeInstalledWorkspaceRuntime({
            workspaceRoot,
            runtimeRoot,
            runtimeReceipt,
            browserRuntimeRoot,
            sdkBrowserRuntimeReceipt,
            installedSdkAuthority,
            signal,
            onEvent
        });
    }
    const expectedFiles=projectRuntimeFiles(runtimeReceipt,sdkBrowserRuntimeReceipt);
    const workspace=await workspaceLocation(workspaceRoot);
    const destinationRoot=path.join(workspace.canonicalRoot,'arcane');
    try{
        const existing=await lstat(destinationRoot,{bigint:true});
        if(existing.isSymbolicLink()||!existing.isDirectory()){
            fail('Existing workspace arcane runtime path must be a real directory.');
        }
        await emit(onEvent,{type:'workspace.runtime.materialize.reused'});
        return verifyWorkspaceRuntime({
            workspaceRoot,
            runtimeRoot,
            runtimeReceipt,
            browserRuntimeRoot,
            sdkBrowserRuntimeReceipt,
            signal,
            onEvent
        });
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }

    const stagingRoot=path.join(
        workspace.canonicalRoot,
        `${STAGING_PREFIX}${String(process.pid)}-${randomUUID()}`
    );
    await mkdir(stagingRoot,{mode:0o700});
    const stagingInfo=await lstat(stagingRoot,{bigint:true});
    if(stagingInfo.isSymbolicLink()||!stagingInfo.isDirectory()){
        fail('Workspace runtime staging path must be a real directory.');
    }
    const stagingIdentity=fileIdentity(stagingInfo);
    await assertRealDirectoryLocation(
        workspace.canonicalRoot,
        workspace.identity,
        'Workspace root'
    );
    await assertRealDirectoryLocation(
        stagingRoot,
        stagingIdentity,
        'Workspace runtime staging directory'
    );
    const bufferedEvents=[];
    let stagingCleaned=false;
    try{
        const totalBytes=expectedFiles.reduce((total,file)=>total+file.bytes,0);
        bufferedEvents.push({
            type:'workspace.runtime.materialize.started',
            fileCount:expectedFiles.length,
            totalBytes
        });
        let writtenBytes=0;
        for(const [index,file] of expectedFiles.entries()){
            throwIfAborted(signal);
            const bytes=file.authority==='sdk-browser-runtime'
                ?await readVerifiedSdkBrowserRuntimeFile(sdkBrowserRuntimeReceipt,{
                    browserRuntimeRoot,
                    relativePath:file.sourcePath,
                    signal
                })
                :await readVerifiedRuntimeFile(runtimeReceipt,{
                    runtimeRoot,
                    relativePath:file.sourcePath,
                    signal
                });
            const destination=resolveContained(stagingRoot,file.path);
            await mkdir(path.dirname(destination),{recursive:true,mode:0o755});
            await writeNewFile(destination,bytes);
            writtenBytes+=bytes.length;
            bufferedEvents.push({
                type:'workspace.runtime.materialize.progress',
                current:index+1,
                total:expectedFiles.length,
                writtenBytes,
                totalBytes,
                path:file.path
            });
        }
        await verifyProjectedTree(stagingRoot,expectedFiles,{signal});

        // Materialization callbacks are held until every staged byte authenticates.
        // They can still veto the commit, but no callback runs between staged writes.
        for(const event of bufferedEvents)await emit(onEvent,event);
        throwIfAborted(signal);
        await assertRealDirectoryLocation(
            workspace.canonicalRoot,
            workspace.identity,
            'Workspace root'
        );
        await assertRealDirectoryLocation(
            stagingRoot,
            stagingIdentity,
            'Workspace runtime staging directory'
        );
        await verifyProjectedTree(stagingRoot,expectedFiles,{signal});
        await assertRealDirectoryLocation(
            workspace.canonicalRoot,
            workspace.identity,
            'Workspace root'
        );
        await assertRealDirectoryLocation(
            stagingRoot,
            stagingIdentity,
            'Workspace runtime staging directory'
        );

        throwIfAborted(signal);
        try{
            await rename(stagingRoot,destinationRoot);
        }catch(error){
            let destinationExists=false;
            try{
                const existing=await lstat(destinationRoot,{bigint:true});
                destinationExists=existing.isDirectory()&&!existing.isSymbolicLink();
            }catch(inspectError){
                if(inspectError?.code!=='ENOENT')throw inspectError;
            }
            if(!destinationExists)throw error;
            await cleanupStaging(stagingRoot,workspace,stagingIdentity);
            stagingCleaned=true;
            await emit(onEvent,{type:'workspace.runtime.materialize.reused'});
            return await verifyWorkspaceRuntime({
                workspaceRoot,
                runtimeRoot,
                runtimeReceipt,
                browserRuntimeRoot,
                sdkBrowserRuntimeReceipt,
                signal,
                onEvent
            });
        }
        await cleanupStaging(stagingRoot,workspace,stagingIdentity);
        stagingCleaned=true;
        const receipt=await verifyWorkspaceRuntime({
            workspaceRoot,
            runtimeRoot,
            runtimeReceipt,
            browserRuntimeRoot,
            sdkBrowserRuntimeReceipt,
            signal,
            onEvent
        });
        await emit(onEvent,{
            type:'workspace.runtime.materialize.completed',
            contentSha256:receipt.contentSha256,
            sourceContentSha256:receipt.sourceContentSha256,
            sourceBrowserContentSha256:receipt.sourceBrowserContentSha256,
            fileCount:receipt.fileCount,
            totalBytes:receipt.totalBytes
        });
        return receipt;
    }finally{
        if(!stagingCleaned)await cleanupStaging(stagingRoot,workspace,stagingIdentity);
    }
}

export async function authenticateWorkspaceRuntimeReceipt(receipt,{
    workspaceRoot,
    signal
}={}){
    if(!receipt||!issuedReceipts.has(receipt)){
        fail('Workspace runtime verification receipt was not issued by this SDK process.');
    }
    if(!workspaceRoot)fail('workspaceRoot is required to authenticate a workspace runtime receipt.');
    return assertWorkspaceRuntimeState(receipt,{workspaceRoot,signal});
}

export async function readVerifiedWorkspaceRuntimeFile(receipt,{
    workspaceRoot,
    relativePath,
    signal
}={}){
    if(!receipt||!issuedReceipts.has(receipt)){
        fail('Workspace runtime verification receipt was not issued by this SDK process.');
    }
    if(!workspaceRoot)fail('workspaceRoot is required to read a verified workspace runtime file.');
    throwIfAborted(signal);
    const normalized=safeRelativePath(relativePath);
    const file=receipt.files.find(candidate=>portableKey(candidate.path)===portableKey(normalized));
    if(!file)fail(`Path is not in the verified workspace runtime inventory: ${normalized}.`);
    if(file.bytes>MAX_VERIFIED_WORKSPACE_RUNTIME_FILE_BYTES){
        fail(
            `Verified workspace runtime file exceeds the ${MAX_VERIFIED_WORKSPACE_RUNTIME_FILE_BYTES}-byte serving limit: ${file.path}.`
        );
    }
    const identity=receipt.identities.find(
        candidate=>portableKey(candidate.path)===portableKey(file.path)
    );
    if(!identity)fail(`Verified workspace runtime identity is missing for ${file.path}.`);

    const {root}=await assertRequestedWorkspace(receipt,workspaceRoot);
    const rootInfo=await lstat(root,{bigint:true});
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()
        ||!identityMatches(rootInfo,receipt.rootIdentity)){
        fail('Workspace arcane runtime root changed after verification.');
    }
    const ancestors=[];
    let current='';
    for(const part of file.path.split('/').slice(0,-1)){
        current=current?`${current}/${part}`:part;
        ancestors.push(current);
    }
    for(const ancestor of ancestors){
        const directory=receipt.directoryIdentities.find(entry=>entry.path===ancestor);
        if(!directory)fail(`Verified workspace runtime directory identity is missing for ${ancestor}.`);
        await assertIdentityAt(root,directory,{directory:true});
    }
    await assertIdentityAt(root,identity,{directory:false});

    const filePath=resolveContained(root,file.path);
    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')fail(`Workspace runtime file became a symbolic link: ${file.path}.`);
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!identityMatches(opened,identity)){
            fail(`Workspace runtime file changed while it was being opened: ${file.path}.`);
        }
        const bytes=await handle.readFile();
        throwIfAborted(signal);
        const after=await handle.stat({bigint:true});
        if(!identityMatches(after,identity)||bytes.length!==file.bytes){
            fail(`Workspace runtime file changed while it was being read: ${file.path}.`);
        }
        if(createHash('sha256').update(bytes).digest('hex')!==file.sha256){
            fail(`Workspace runtime file hash changed: ${file.path}.`);
        }
        await assertIdentityAt(root,identity,{directory:false});
        for(const ancestor of ancestors){
            const directory=receipt.directoryIdentities.find(entry=>entry.path===ancestor);
            await assertIdentityAt(root,directory,{directory:true});
        }
        const canonicalFile=await realpath(filePath);
        const canonicalRelative=path.relative(root,canonicalFile);
        if(canonicalRelative.startsWith('..')||path.isAbsolute(canonicalRelative)){
            fail(`Workspace runtime path left its root: ${file.path}.`);
        }
        return bytes;
    }finally{
        await handle.close();
    }
}
