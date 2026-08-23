import {createHash,randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {constants as FS_CONSTANTS} from 'node:fs';
import {
    link,
    lstat,
    mkdir,
    open,
    realpath,
    rm
} from 'node:fs/promises';
import path from 'node:path';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createDeflateRaw,createGunzip} from 'node:zlib';

import {appDescriptorSha256,projectPackageManifest,validateAppDescriptor} from './app-descriptor.mjs';
import {SDK_NAME,SDK_VERSION} from './constants.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {
    authenticateAppReleaseAuthority,
    RELEASE_MANIFEST_NAME,
    PACKAGER_VERSION,
    parseSemver
} from './packager/core.mjs';

export const APP_BUNDLE_MANIFEST_NAME='ARCANE_APP_BUNDLE.json';
export const APP_BUNDLE_DESCRIPTOR_NAME='arcane-app.json';
export const APP_BUNDLE_RELEASE_PATH=`payload/${RELEASE_MANIFEST_NAME}`;
export const APP_BUNDLE_KIND='arcane-app-release-bundle';
export const APP_BUNDLE_FORMAT='ustar+gzip';
export const APP_BUNDLE_SCHEMA_VERSION=1;
export const APP_BUNDLE_EXTENSION='.arcane-app.tar.gz';
export const APP_BUNDLE_SUPPORTED_SDK_VERSIONS=Object.freeze([SDK_VERSION]);

export const APP_BUNDLE_LIMITS=Object.freeze({
    maxCompressedBytes:512*1024*1024,
    maxExpandedBytes:1024*1024*1024,
    maxEntries:16384,
    maxPayloadFiles:16381,
    maxEntryBytes:512*1024*1024,
    maxControlBytes:4*1024*1024,
    maxPathBytes:256,
    maxExpansionRatio:200,
    expansionSlackBytes:16*1024*1024
});

const TAR_BLOCK_BYTES=512;
const TAR_END_BYTES=TAR_BLOCK_BYTES*2;
const ARCHIVE_MODE=0o644;
const GZIP_HEADER=Buffer.from([0x1f,0x8b,0x08,0x00,0x00,0x00,0x00,0x00,0x02,0x03]);
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const SHA256_PATTERN=/^[0-9a-f]{64}$/u;
const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const WINDOWS_RESERVED_PATTERN=
    /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[.]|$)/iu;
const WINDOWS_UNSAFE_FILENAME_CHARACTER_PATTERN=/[<>"|?*]/u;
const PORTABLE_RESERVED_FILENAME_PATTERN=WINDOWS_RESERVED_PATTERN;
const CONTROL_PATHS=new Set([
    APP_BUNDLE_MANIFEST_NAME,
    APP_BUNDLE_DESCRIPTOR_NAME,
    APP_BUNDLE_RELEASE_PATH
]);
const textDecoder=new TextDecoder('utf-8',{fatal:true});

function fail(message,code=ERROR_CODES.integrityFailed,details){
    throw new ArcaneError(code,message,{details});
}

function appendErrorWarning(error,warning){
    try{
        error.message=`${String(error?.message??error)} ${warning}`;
    }catch{}
}

async function emit(onEvent,event){
    await onEvent?.(Object.freeze(event));
}

function sha256(value){
    return createHash('sha256').update(value).digest('hex');
}

function canonicalJsonBytes(value){
    return Buffer.from(`${JSON.stringify(value,null,2)}\n`,'utf8');
}

function compareText(left,right){
    return Buffer.compare(Buffer.from(String(left),'utf8'),Buffer.from(String(right),'utf8'));
}

function isPlainObject(value){
    if(value===null||typeof value!=='object'||Array.isArray(value))return false;
    const prototype=Object.getPrototypeOf(value);
    return prototype===Object.prototype||prototype===null;
}

function assertExactKeys(value,keys,label){
    if(!isPlainObject(value))fail(`${label} must be a JSON object.`);
    const actual=Object.keys(value);
    if(JSON.stringify(actual)!==JSON.stringify(keys)){
        fail(`${label} must contain exactly these keys in canonical order: ${keys.join(', ')}.`);
    }
}

function assertInteger(value,{minimum=0,maximum=Number.MAX_SAFE_INTEGER,label}){
    if(!Number.isSafeInteger(value)||value<minimum||value>maximum){
        fail(`${label} must be an integer from ${minimum} through ${maximum}.`);
    }
}

function assertSha256(value,label){
    if(typeof value!=='string'||!SHA256_PATTERN.test(value)){
        fail(`${label} must be a lowercase SHA-256 digest.`);
    }
}

function pathKey(value){
    return value.normalize('NFC').toLowerCase();
}

function registerPortablePathTopology(topology,filePath,label){
    const segments=filePath.split('/');
    let prefix='';
    for(let index=0;index<segments.length;index+=1){
        prefix=prefix?`${prefix}/${segments[index]}`:segments[index];
        const key=pathKey(prefix);
        const kind=index===segments.length-1?'file':'directory';
        const existingKind=topology.kinds.get(key);
        if(existingKind&&existingKind!==kind){
            fail(`${label} uses ${prefix} as both a file and a directory.`);
        }
        const spelling=topology.spellings.get(key);
        if(spelling!==undefined&&spelling!==prefix){
            fail(`${label} has a case-colliding path prefix: ${spelling} and ${prefix}.`);
        }
        if(existingKind==='file'&&kind==='file'){
            fail(`${label} has a duplicate path: ${prefix}.`);
        }
        topology.kinds.set(key,kind);
        topology.spellings.set(key,prefix);
    }
}

function validatePortablePathTopology(filePaths,label){
    const topology={kinds:new Map(),spellings:new Map()};
    for(const filePath of filePaths)registerPortablePathTopology(topology,filePath,label);
}

export function validateAppBundlePath(value,label='bundle path'){
    if(typeof value!=='string'||!value||value!==value.normalize('NFC')){
        fail(`${label} must be a nonempty NFC-normalized string.`);
    }
    const bytes=Buffer.byteLength(value,'utf8');
    if(bytes>APP_BUNDLE_LIMITS.maxPathBytes){
        fail(`${label} exceeds the ${APP_BUNDLE_LIMITS.maxPathBytes}-byte USTAR limit.`);
    }
    if(value.startsWith('/')||value.startsWith('\\')||value.includes('\\')
        ||value.includes(':')||/[\u0000-\u001f\u007f]/u.test(value)){
        fail(`${label} is not a canonical relative archive path.`);
    }
    const segments=value.split('/');
    if(segments.some(segment=>!segment||segment==='.'||segment==='..'
        ||WINDOWS_UNSAFE_FILENAME_CHARACTER_PATTERN.test(segment)
        ||/[. ]$/u.test(segment)||WINDOWS_RESERVED_PATTERN.test(segment))){
        fail(`${label} contains an unsafe path segment.`);
    }
    return value;
}

function splitUstarPath(value){
    validateAppBundlePath(value,'USTAR entry path');
    const complete=Buffer.from(value,'utf8');
    if(complete.length<=100){
        return {name:complete,prefix:Buffer.alloc(0)};
    }
    for(let index=value.length-1;index>0;index-=1){
        if(value[index]!=='/')continue;
        const prefix=Buffer.from(value.slice(0,index),'utf8');
        const name=Buffer.from(value.slice(index+1),'utf8');
        if(prefix.length<=155&&name.length>0&&name.length<=100){
            return {name,prefix};
        }
    }
    fail(`USTAR entry path cannot be represented without an extension header: ${value}.`);
}

function writeOctal(header,offset,length,value){
    if(!Number.isSafeInteger(value)||value<0)fail('USTAR numeric fields must be nonnegative integers.');
    const octal=value.toString(8);
    if(octal.length>length-1)fail('USTAR numeric field overflowed its canonical octal field.');
    header.write(`${octal.padStart(length-1,'0')}\0`,offset,length,'ascii');
}

export function createCanonicalUstarHeader(entryPath,size){
    assertInteger(size,{minimum:0,maximum:APP_BUNDLE_LIMITS.maxEntryBytes,label:'USTAR entry size'});
    const {name,prefix}=splitUstarPath(entryPath);
    const header=Buffer.alloc(TAR_BLOCK_BYTES,0);
    name.copy(header,0);
    writeOctal(header,100,8,ARCHIVE_MODE);
    writeOctal(header,108,8,0);
    writeOctal(header,116,8,0);
    writeOctal(header,124,12,size);
    writeOctal(header,136,12,0);
    header.fill(0x20,148,156);
    header[156]=0x30;
    header.write('ustar\0',257,6,'ascii');
    header.write('00',263,2,'ascii');
    prefix.copy(header,345);
    const checksum=header.reduce((total,byte)=>total+byte,0);
    const checksumText=checksum.toString(8).padStart(6,'0');
    if(checksumText.length!==6)fail('USTAR header checksum overflowed its canonical field.');
    header.write(`${checksumText}\0 `,148,8,'ascii');
    return header;
}

function decodeUstarField(field,label){
    const zero=field.indexOf(0);
    const end=zero===-1?field.length:zero;
    if(zero!==-1&&field.subarray(zero).some(byte=>byte!==0)){
        fail(`${label} contains nonzero bytes after its terminator.`);
    }
    try{
        return textDecoder.decode(field.subarray(0,end));
    }catch(error){
        fail(`${label} is not canonical UTF-8.`,ERROR_CODES.integrityFailed,{cause:error.message});
    }
}

function parseCanonicalOctal(field,label){
    const text=field.toString('ascii');
    if(!/^[0-7]+\0$/u.test(text))fail(`${label} is not canonical NUL-terminated octal.`);
    const value=Number.parseInt(text.slice(0,-1),8);
    if(!Number.isSafeInteger(value))fail(`${label} exceeds the safe integer range.`);
    return value;
}

function parseCanonicalUstarHeader(header){
    if(header.length!==TAR_BLOCK_BYTES)fail('USTAR header is incomplete.');
    const name=decodeUstarField(header.subarray(0,100),'USTAR name');
    const prefix=decodeUstarField(header.subarray(345,500),'USTAR prefix');
    const entryPath=prefix?`${prefix}/${name}`:name;
    const size=parseCanonicalOctal(header.subarray(124,136),'USTAR size');
    const canonical=createCanonicalUstarHeader(entryPath,size);
    if(!header.equals(canonical)){
        fail(`USTAR header is not the canonical regular-file header for ${entryPath}.`);
    }
    return {path:entryPath,size};
}

function crcTable(){
    const table=new Uint32Array(256);
    for(let index=0;index<256;index+=1){
        let value=index;
        for(let bit=0;bit<8;bit+=1){
            value=(value&1)?(0xedb88320^(value>>>1)):(value>>>1);
        }
        table[index]=value>>>0;
    }
    return table;
}

const CRC32_TABLE=crcTable();

function updateCrc32(current,bytes){
    let value=current;
    for(const byte of bytes){
        value=CRC32_TABLE[(value^byte)&0xff]^(value>>>8);
    }
    return value>>>0;
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

function identitiesEqual(left,right){
    return left.device===right.device
        &&left.inode===right.inode
        &&left.bytes===right.bytes
        &&left.modifiedNanoseconds===right.modifiedNanoseconds
        &&left.changedNanoseconds===right.changedNanoseconds
        &&left.links===right.links;
}

function fileObjectMatches(info,identity){
    return String(info.dev)===identity.device&&String(info.ino)===identity.inode;
}

function isInside(parent,candidate){
    const relative=path.relative(parent,candidate);
    return relative===''||(!relative.startsWith('..')&&!path.isAbsolute(relative));
}

async function openStableFile(filePath,label,{maximum=APP_BUNDLE_LIMITS.maxEntryBytes}={}){
    const before=await lstat(filePath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()){
        fail(`${label} must be a regular file, not a link or special entry.`);
    }
    if(before.nlink!==1n){
        fail(`${label} must have exactly one filesystem link.`,ERROR_CODES.policyDenied);
    }
    if(Number(before.size)>maximum)fail(`${label} exceeds its ${maximum}-byte limit.`,ERROR_CODES.policyDenied);
    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')fail(`${label} became a symbolic link.`);
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||opened.nlink!==1n||!identityMatches(opened,fileIdentity(before))){
            fail(`${label} changed while it was opened.`);
        }
        return {handle,identity:fileIdentity(opened)};
    }catch(error){
        await handle.close().catch(()=>{});
        throw error;
    }
}

async function readExactOpenedBytes(opened,label,{signal}={}){
    const bytes=Buffer.alloc(opened.identity.bytes);
    let position=0;
    while(position<bytes.length){
        throwIfAborted(signal);
        const result=await opened.handle.read(bytes,position,bytes.length-position,position);
        if(result.bytesRead===0)fail(`${label} ended before its recorded byte length.`);
        position+=result.bytesRead;
    }
    const probe=Buffer.alloc(1);
    const extra=await opened.handle.read(probe,0,1,opened.identity.bytes);
    if(extra.bytesRead!==0)fail(`${label} grew beyond its recorded byte length.`);
    throwIfAborted(signal);
    const after=await opened.handle.stat({bigint:true});
    if(after.nlink!==1n||!identityMatches(after,opened.identity)){
        fail(`${label} changed while it was read.`);
    }
    return bytes;
}

async function readStableControlFile(filePath,label,{signal}={}){
    throwIfAborted(signal);
    const opened=await openStableFile(filePath,label,{maximum:APP_BUNDLE_LIMITS.maxControlBytes});
    try{
        const bytes=await readExactOpenedBytes(opened,label,{signal});
        const current=await lstat(filePath,{bigint:true});
        if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1n
            ||!identityMatches(current,opened.identity)){
            fail(`${label} path changed while it was read.`);
        }
        return bytes;
    }finally{
        await opened.handle.close();
    }
}

async function* verifiedFileChunks(root,identity,{signal}={}){
    throwIfAborted(signal);
    const filePath=path.join(root,...identity.path.split('/'));
    const opened=await openStableFile(filePath,`release payload ${identity.path}`);
    try{
        const canonicalFile=await realpath(filePath);
        if(!isInside(root,canonicalFile))fail(`Release payload escaped its root: ${identity.path}.`);
        if(opened.identity.bytes!==identity.bytes){
            fail(`Release payload size changed: ${identity.path}.`);
        }
        const digest=createHash('sha256');
        let position=0;
        const buffer=Buffer.allocUnsafe(64*1024);
        while(position<identity.bytes){
            throwIfAborted(signal);
            const requested=Math.min(buffer.length,identity.bytes-position);
            const {bytesRead}=await opened.handle.read(buffer,0,requested,position);
            if(bytesRead===0)fail(`Release payload ended early: ${identity.path}.`);
            const chunk=Buffer.from(buffer.subarray(0,bytesRead));
            digest.update(chunk);
            position+=bytesRead;
            yield chunk;
        }
        const probe=Buffer.alloc(1);
        const extra=await opened.handle.read(probe,0,1,identity.bytes);
        if(extra.bytesRead!==0)fail(`Release payload grew while it was bundled: ${identity.path}.`);
        const after=await opened.handle.stat({bigint:true});
        if(after.nlink!==1n||!identityMatches(after,opened.identity)
            ||digest.digest('hex')!==identity.sha256){
            fail(`Release payload changed while it was bundled: ${identity.path}.`);
        }
        const current=await lstat(filePath,{bigint:true});
        if(current.isSymbolicLink()||!current.isFile()||!identityMatches(current,opened.identity)){
            fail(`Release payload path changed while it was bundled: ${identity.path}.`);
        }
    }finally{
        await opened.handle.close();
    }
}

function validateReleaseInventory(receipt){
    if(!Array.isArray(receipt.files)||receipt.files.length<1
        ||receipt.files.length>APP_BUNDLE_LIMITS.maxPayloadFiles){
        fail(`Verified release inventory must contain 1 through ${APP_BUNDLE_LIMITS.maxPayloadFiles} files.`);
    }
    const keys=new Set();
    let totalBytes=0;
    let previous=null;
    const files=receipt.files.map((file,index)=>{
        assertExactKeys(file,['path','bytes','sha256'],`release file ${index}`);
        const relativePath=validateAppBundlePath(file.path,`release file ${index} path`);
        if(pathKey(relativePath)===pathKey(RELEASE_MANIFEST_NAME)){
            fail(`Release inventory must not contain ${RELEASE_MANIFEST_NAME}.`);
        }
        const key=pathKey(relativePath);
        if(keys.has(key))fail(`Release inventory has a duplicate or case-colliding path: ${relativePath}.`);
        keys.add(key);
        if(previous!==null&&compareText(previous,relativePath)>=0){
            fail('Release inventory must use strict canonical path order.');
        }
        previous=relativePath;
        assertInteger(file.bytes,{
            minimum:0,
            maximum:APP_BUNDLE_LIMITS.maxEntryBytes,
            label:`release file ${relativePath} bytes`
        });
        assertSha256(file.sha256,`release file ${relativePath} sha256`);
        totalBytes+=file.bytes;
        if(!Number.isSafeInteger(totalBytes)||totalBytes>APP_BUNDLE_LIMITS.maxExpandedBytes){
            fail('Release payload exceeds the expanded archive limit.',ERROR_CODES.policyDenied);
        }
        return Object.freeze({path:relativePath,bytes:file.bytes,sha256:file.sha256});
    });
    validatePortablePathTopology(files.map(file=>file.path),'Release inventory');
    if(totalBytes<1){
        fail('Verified release payload must contain at least one byte.',ERROR_CODES.policyDenied);
    }
    if(receipt.fileCount!==files.length||receipt.totalBytes!==totalBytes
        ||receipt.contentSha256!==sha256(JSON.stringify(files))){
        fail('Verified release receipt inventory totals are inconsistent.');
    }
    return Object.freeze(files);
}

function expectedReleaseApp(descriptor){
    return Object.freeze({
        id:descriptor.id,
        displayName:descriptor.displayName,
        version:descriptor.version,
        entry:descriptor.package.entry,
        start:`./apps/${descriptor.id}/${descriptor.package.entry}`,
        security:descriptor.security,
        localAIModelPolicy:descriptor.package.localAIModelPolicy
            ??Object.freeze({verified_only:true,models:Object.freeze([])})
    });
}

function releaseDocumentFromReceipt(receipt,descriptor,files){
    const expectedApp=expectedReleaseApp(descriptor);
    if(receipt.builder!==PACKAGER_VERSION
        ||JSON.stringify(receipt.app)!==JSON.stringify(expectedApp)
        ||!SHA256_PATTERN.test(receipt.policySha256??'')){
        fail('Verified release receipt is not bound to the authored schema-2 descriptor.');
    }
    return Object.freeze({
        schemaVersion:1,
        builder:receipt.builder,
        app:expectedApp,
        policySha256:receipt.policySha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes,
        contentSha256:receipt.contentSha256,
        files
    });
}

function createBundleManifest({descriptor,descriptorBytes,descriptorSha256,release,releaseBytes}){
    const packageSha256=sha256(JSON.stringify(projectPackageManifest(descriptor)));
    return Object.freeze({
        schemaVersion:APP_BUNDLE_SCHEMA_VERSION,
        kind:APP_BUNDLE_KIND,
        format:APP_BUNDLE_FORMAT,
        sdk:Object.freeze({name:SDK_NAME,version:SDK_VERSION}),
        app:Object.freeze({id:descriptor.id,version:descriptor.version}),
        descriptor:Object.freeze({
            path:APP_BUNDLE_DESCRIPTOR_NAME,
            schemaVersion:descriptor.schemaVersion,
            canonicalSha256:descriptorSha256,
            packageSha256,
            fileSha256:sha256(descriptorBytes),
            bytes:descriptorBytes.length
        }),
        release:Object.freeze({
            path:APP_BUNDLE_RELEASE_PATH,
            schemaVersion:release.schemaVersion,
            builder:release.builder,
            policySha256:release.policySha256,
            manifestSha256:sha256(releaseBytes),
            contentSha256:release.contentSha256,
            fileCount:release.fileCount,
            totalBytes:release.totalBytes
        }),
        payload:Object.freeze({
            root:'payload',
            fileCount:release.fileCount,
            totalBytes:release.totalBytes,
            files:release.files
        })
    });
}

class ArchiveFileWriter{
    constructor(handle){
        this.handle=handle;
        this.digest=createHash('sha256');
        this.bytes=0;
    }

    async write(chunk){
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        let offset=0;
        while(offset<bytes.length){
            const result=await this.handle.write(bytes,offset,bytes.length-offset,null);
            if(result.bytesWritten===0)fail('Archive output stopped accepting bytes.');
            offset+=result.bytesWritten;
        }
        this.digest.update(bytes);
        this.bytes+=bytes.length;
        if(this.bytes>APP_BUNDLE_LIMITS.maxCompressedBytes){
            fail('Compressed bundle exceeds its 512 MiB limit.',ERROR_CODES.policyDenied);
        }
    }

    result(){
        return {bytes:this.bytes,sha256:this.digest.digest('hex')};
    }
}

class Crc32Transform extends Transform{
    constructor(){
        super();
        this.crc=0xffffffff;
        this.bytes=0;
    }

    _transform(chunk,_encoding,callback){
        this.crc=updateCrc32(this.crc,chunk);
        this.bytes=(this.bytes+chunk.length)>>>0;
        callback(null,chunk);
    }

    trailer(){
        const trailer=Buffer.alloc(8);
        trailer.writeUInt32LE((this.crc^0xffffffff)>>>0,0);
        trailer.writeUInt32LE(this.bytes>>>0,4);
        return trailer;
    }
}

async function* tarChunks(entries,{releaseRoot,signal,onEvent}={}){
    for(let index=0;index<entries.length;index+=1){
        throwIfAborted(signal);
        const entry=entries[index];
        yield createCanonicalUstarHeader(entry.path,entry.bytes);
        if(entry.buffer){
            yield entry.buffer;
        }else{
            yield* verifiedFileChunks(releaseRoot,entry.identity,{signal});
        }
        const padding=(TAR_BLOCK_BYTES-(entry.bytes%TAR_BLOCK_BYTES))%TAR_BLOCK_BYTES;
        if(padding)yield Buffer.alloc(padding);
        await emit(onEvent,{
            type:'bundle.entry.written',
            path:entry.path,
            bytes:entry.bytes,
            index:index+1,
            entryCount:entries.length
        });
    }
    yield Buffer.alloc(TAR_END_BYTES);
}

async function writeDeterministicGzip(fileHandle,entries,options){
    const writer=new ArchiveFileWriter(fileHandle);
    await writer.write(GZIP_HEADER);
    const crc=new Crc32Transform();
    const deflate=createDeflateRaw({level:9});
    const sink=new Writable({
        write(chunk,_encoding,callback){
            writer.write(chunk).then(()=>callback(),callback);
        }
    });
    await pipeline(Readable.from(tarChunks(entries,options)),crc,deflate,sink);
    await writer.write(crc.trailer());
    return Object.freeze(writer.result());
}

function validateOutputFilename(outputPath){
    const filename=path.basename(outputPath);
    if(!filename.toLowerCase().endsWith(APP_BUNDLE_EXTENSION)){
        fail(`Bundle output must end in ${APP_BUNDLE_EXTENSION}.`,ERROR_CODES.usage);
    }
    if(filename!==filename.normalize('NFC')||filename.length>255
        ||Buffer.byteLength(filename,'utf8')>255||/[. ]$/u.test(filename)
        ||/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(filename)
        ||PORTABLE_RESERVED_FILENAME_PATTERN.test(filename)){
        fail('Bundle output filename must be one portable direct filename.',ERROR_CODES.policyDenied);
    }
}

async function acquireArtifactLock(outputPath,{onEvent}={}){
    const lockPath=`${outputPath}.lock`;
    const nonce=randomBytes(16).toString('hex');
    let handle;
    let lockIdentity;
    let documentBytes;
    let created=false;
    try{
        handle=await open(lockPath,'wx',0o600);
        created=true;
        const acquiredAtUtc=new Date().toISOString();
        const expiresAtUtc=new Date(Date.now()+2*60*60*1000).toISOString();
        documentBytes=Buffer.from(`${JSON.stringify({
            owner:`arcane-os:${process.pid}`,
            nonce,
            artifactPath:outputPath,
            acquiredAtUtc,
            ttlSeconds:7200,
            expiresAtUtc,
            releaseProcedure:'The owning Arcane bundle operation removes this lock after success or failure.',
            staleRecoveryProcedure:'After expiresAtUtc, confirm the recorded process is absent and preserve any adjacent temporary artifact before removing this lock.'
        },null,2)}\n`,'utf8');
        await handle.writeFile(documentBytes);
        await handle.sync();
        await emit(onEvent,Object.freeze({type:'bundle.lock.written',lockPath,nonce}));
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||opened.nlink!==1n||Number(opened.size)!==documentBytes.length){
            fail('Artifact lock changed while it was acquired.',ERROR_CODES.policyDenied);
        }
        lockIdentity=fileIdentity(opened);
        const current=await lstat(lockPath,{bigint:true});
        if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1n
            ||!identityMatches(current,lockIdentity)){
            fail('Artifact lock path changed while it was acquired.',ERROR_CODES.policyDenied);
        }
        await handle.close();
        handle=null;
    }catch(error){
        if(handle){
            lockIdentity=await handle.stat({bigint:true}).then(fileIdentity,()=>lockIdentity);
            await handle.close().catch(()=>{});
            handle=null;
        }
        if(lockIdentity){
            try{
                const current=await lstat(lockPath,{bigint:true});
                if(current.isFile()&&!current.isSymbolicLink()
                    &&identityMatches(current,lockIdentity)){
                    await rm(lockPath);
                }else{
                    appendErrorWarning(
                        error,
                        `Partial artifact lock was preserved at ${lockPath}; its identity changed before cleanup.`
                    );
                }
            }catch(cleanupError){
                if(cleanupError?.code!=='ENOENT'){
                    appendErrorWarning(error,`Lock acquisition cleanup warning: ${cleanupError.message}`);
                }
            }
        }else if(created){
            appendErrorWarning(
                error,
                `Partial artifact lock was preserved at ${lockPath} because its FileHandle identity was unavailable; inspect its nonce and owner before recovery.`
            );
        }
        if(error?.code==='EEXIST'){
            fail(`Another bundle operation owns ${lockPath}. Inspect it before stale-lock recovery.`,ERROR_CODES.policyDenied);
        }
        throw error;
    }
    let released=false;
    return async()=>{
        if(released)return null;
        released=true;
        try{
            const current=await lstat(lockPath,{bigint:true});
            if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1n
                ||!identityMatches(current,lockIdentity)){
                throw new Error('Artifact lock path no longer belongs to this operation.');
            }
            const opened=await openStableFile(lockPath,'artifact operation lock',{
                maximum:APP_BUNDLE_LIMITS.maxControlBytes
            });
            try{
                if(!identitiesEqual(opened.identity,lockIdentity)){
                    throw new Error('Artifact lock identity no longer belongs to this operation.');
                }
                const currentBytes=await readExactOpenedBytes(opened,'artifact operation lock');
                if(!currentBytes.equals(documentBytes)){
                    throw new Error('Artifact lock nonce or contents changed before release.');
                }
            }finally{
                await opened.handle.close().catch(()=>{});
            }
            const beforeRemove=await lstat(lockPath,{bigint:true});
            if(!identityMatches(beforeRemove,lockIdentity)){
                throw new Error('Artifact lock changed immediately before release.');
            }
            await rm(lockPath);
            return null;
        }catch(error){
            return Object.freeze({
                scope:'artifact-lock',
                path:lockPath,
                message:String(error?.message??error),
                recovery:'Inspect the lock owner and nonce before removing or replacing the lease.'
            });
        }
    };
}

async function inspectOutput(outputPath,{overwrite}){
    try{
        const info=await lstat(outputPath,{bigint:true});
        if(info.isSymbolicLink()||!info.isFile()||info.nlink!==1n){
            fail('Bundle output collision is not a replaceable regular file.',ERROR_CODES.policyDenied);
        }
        if(!overwrite){
            fail('Bundle output already exists; pass overwrite: true or --overwrite to replace it.',ERROR_CODES.policyDenied);
        }
        const opened=await openStableFile(outputPath,'existing bundle output',{
            maximum:APP_BUNDLE_LIMITS.maxCompressedBytes
        });
        if(!identitiesEqual(opened.identity,fileIdentity(info))){
            await opened.handle.close().catch(()=>{});
            fail('Bundle output changed while its overwrite anchor was opened.',ERROR_CODES.policyDenied);
        }
        return opened;
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
}

async function assertSingleLinkStaging(temporary,temporaryIdentity){
    const staged=await lstat(temporary,{bigint:true});
    if(staged.isSymbolicLink()||!staged.isFile()||staged.nlink!==1n
        ||!identityMatches(staged,temporaryIdentity)){
        fail('Verified bundle staging changed before atomic promotion.',ERROR_CODES.policyDenied);
    }
}

async function assertLinkedStagingPair(temporary,outputPath,temporaryIdentity,anchorHandle){
    const [staged,output,anchored]=await Promise.all([
        lstat(temporary,{bigint:true}),
        lstat(outputPath,{bigint:true}),
        anchorHandle.stat({bigint:true})
    ]);
    const stagedIdentity=fileIdentity(staged);
    if(staged.isSymbolicLink()||output.isSymbolicLink()
        ||!staged.isFile()||!output.isFile()||!anchored.isFile()
        ||staged.nlink!==2n||output.nlink!==2n
        ||anchored.nlink!==2n
        ||!identityMatches(output,stagedIdentity)
        ||!identityMatches(anchored,stagedIdentity)
        ||!fileObjectMatches(staged,temporaryIdentity)
        ||!fileObjectMatches(output,temporaryIdentity)
        ||Number(staged.size)!==temporaryIdentity.bytes
        ||Number(output.size)!==temporaryIdentity.bytes
        ||String(staged.mtimeNs)!==temporaryIdentity.modifiedNanoseconds
        ||String(output.mtimeNs)!==temporaryIdentity.modifiedNanoseconds){
        fail('Bundle output and staging links did not retain the verified staging object.');
    }
    return stagedIdentity;
}

async function anchoredSinglePathIdentity(filePath,handle,priorIdentity,label){
    const [current,anchored]=await Promise.all([
        lstat(filePath,{bigint:true}),
        handle.stat({bigint:true})
    ]);
    const currentIdentity=fileIdentity(current);
    if(current.isSymbolicLink()||!current.isFile()||current.nlink!==1n
        ||!anchored.isFile()||anchored.nlink!==1n
        ||!identityMatches(anchored,currentIdentity)
        ||(priorIdentity&&(priorIdentity.links==='1'
            ?!identityMatches(current,priorIdentity)
            :(!fileObjectMatches(current,priorIdentity)
                ||Number(current.size)!==priorIdentity.bytes
                ||String(current.mtimeNs)!==priorIdentity.modifiedNanoseconds)))){
        fail(`${label} did not retain its anchored single-link identity.`);
    }
    return currentIdentity;
}

async function anchoredLinkPairIdentity(firstPath,secondPath,handle,priorIdentity,label){
    const [first,second,anchored]=await Promise.all([
        lstat(firstPath,{bigint:true}),
        lstat(secondPath,{bigint:true}),
        handle.stat({bigint:true})
    ]);
    const linkedIdentity=fileIdentity(first);
    if(first.isSymbolicLink()||second.isSymbolicLink()
        ||!first.isFile()||!second.isFile()||!anchored.isFile()
        ||first.nlink!==2n||second.nlink!==2n||anchored.nlink!==2n
        ||!identityMatches(second,linkedIdentity)
        ||!identityMatches(anchored,linkedIdentity)
        ||(priorIdentity.links==='2'
            ?!identityMatches(first,priorIdentity)
            :(!fileObjectMatches(first,priorIdentity)
                ||Number(first.size)!==priorIdentity.bytes
                ||String(first.mtimeNs)!==priorIdentity.modifiedNanoseconds))){
        fail(`${label} did not retain its anchored two-link identity.`);
    }
    return linkedIdentity;
}

function changedStagingCleanupIssue(temporary,message){
    return Object.freeze({
        scope:'artifact-staging',
        path:temporary,
        message,
        recovery:'Inspect the preserved staging path and remove it only after confirming its owner.'
    });
}

function anchoredCleanupResult({issue=null,retryIdentity=null}={}){
    return Object.freeze({issue,retryIdentity});
}

async function cleanupAnchoredTemporary(temporary,handle,expectedIdentity){
    try{
        const anchored=await handle.stat({bigint:true});
        let current;
        try{
            current=await lstat(temporary,{bigint:true});
        }catch(error){
            if(error?.code==='ENOENT')return anchoredCleanupResult();
            throw error;
        }
        if(!anchored.isFile()||anchored.nlink!==1n
            ||current.isSymbolicLink()||!current.isFile()||current.nlink!==1n
            ||!identityMatches(current,fileIdentity(anchored))
            ||(expectedIdentity&&!identityMatches(current,expectedIdentity))){
            return anchoredCleanupResult({
                issue:changedStagingCleanupIssue(
                    temporary,
                    `Preserved changed staging path ${temporary}; it is not the exact file object held by the creation handle.`
                )
            });
        }
        const anchoredIdentity=fileIdentity(anchored);
        try{
            await rm(temporary);
        }catch(error){
            if(['EACCES','EBUSY','EPERM'].includes(error?.code)){
                return anchoredCleanupResult({retryIdentity:anchoredIdentity});
            }
            throw error;
        }
        try{
            await lstat(temporary,{bigint:true});
            return anchoredCleanupResult({
                issue:changedStagingCleanupIssue(
                    temporary,
                    `A staging path reappeared after anchored cleanup at ${temporary}.`
                )
            });
        }catch(error){
            if(error?.code==='ENOENT')return anchoredCleanupResult();
            throw error;
        }
    }catch(error){
        return anchoredCleanupResult({
            issue:changedStagingCleanupIssue(
                temporary,
                `Anchored staging cleanup warning for ${temporary}: ${String(error?.message??error)}`
            )
        });
    }
}

async function cleanupOwnedTemporary(temporary,temporaryIdentity){
    try{
        const current=await lstat(temporary,{bigint:true});
        if(!temporaryIdentity||current.isSymbolicLink()||!current.isFile()
            ||current.nlink!==1n||!identityMatches(current,temporaryIdentity)){
            return changedStagingCleanupIssue(
                temporary,
                `Preserved changed staging path ${temporary}; its complete no-follow single-link identity is not owned by this operation.`
            );
        }
        await rm(temporary);
        try{
            await lstat(temporary,{bigint:true});
            return changedStagingCleanupIssue(
                temporary,
                `A staging path reappeared after exact-identity cleanup at ${temporary}.`
            );
        }catch(error){
            if(error?.code==='ENOENT')return null;
            throw error;
        }
    }catch(error){
        if(error?.code==='ENOENT')return null;
        return changedStagingCleanupIssue(
            temporary,
            `Staging cleanup warning for ${temporary}: ${String(error?.message??error)}`
        );
    }
}

async function promoteArtifact(temporary,outputPath,{
    existingOutput,
    stagingState,
    anchorHandle,
    onEvent
}){
    await assertSingleLinkStaging(temporary,stagingState.identity);
    if(!existingOutput){
        let promoted=false;
        try{
            await emit(onEvent,{
                type:'bundle.archive.output-vacated',
                outputPath,
                replaced:false
            });
            await assertSingleLinkStaging(temporary,stagingState.identity);
            await link(temporary,outputPath);
            promoted=true;
            stagingState.identity=await assertLinkedStagingPair(
                temporary,
                outputPath,
                stagingState.identity,
                anchorHandle
            );
            await rm(temporary);
            stagingState.identity=await anchoredSinglePathIdentity(
                outputPath,
                anchorHandle,
                stagingState.identity,
                'Bundle output'
            );
            return Object.freeze({
                outputPath,
                backupPath:null,
                backupIdentity:null,
                promotedIdentity:stagingState.identity,
                promoted,
                replaced:false,
                stagingPath:temporary,
                stagingState
            });
        }catch(error){
            const failure=error?.code==='EEXIST'
                ?new ArcaneError(
                    ERROR_CODES.policyDenied,
                    'Bundle output appeared before create-only promotion; no file was overwritten.',
                    {cause:error}
                )
                :error;
            if(promoted){
                const rollbackIssues=await rollbackPromotion({
                    outputPath,
                    backupPath:null,
                    backupIdentity:null,
                    promotedIdentity:stagingState.identity,
                    promoted,
                    stagingPath:temporary,
                    stagingState
                },{promotedHandle:anchorHandle});
                if(rollbackIssues.length){
                    appendErrorWarning(failure,`Rollback warning: ${rollbackIssues.join('; ')}`);
                }
            }
            throw failure;
        }
    }
    const existingIdentity=existingOutput.identity;
    const backup=`${outputPath}.backup-${process.pid}-${randomBytes(6).toString('hex')}`;
    let backupLinked=false;
    let outputVacated=false;
    let promoted=false;
    let backupIdentity=null;
    try{
        const beforeBackup=await anchoredSinglePathIdentity(
            outputPath,
            existingOutput.handle,
            existingIdentity,
            'Existing bundle output'
        );
        if(!identitiesEqual(beforeBackup,existingIdentity)){
            fail('Bundle output changed before atomic promotion; no file was overwritten.',ERROR_CODES.policyDenied);
        }
        await link(outputPath,backup);
        backupLinked=true;
        existingOutput.identity=await anchoredLinkPairIdentity(
            outputPath,
            backup,
            existingOutput.handle,
            existingOutput.identity,
            'Bundle output backup'
        );
        await emit(onEvent,{
            type:'bundle.archive.backup-linked',
            outputPath,
            backupPath:backup
        });
        existingOutput.identity=await anchoredLinkPairIdentity(
            outputPath,
            backup,
            existingOutput.handle,
            existingOutput.identity,
            'Bundle output backup'
        );
        await rm(outputPath);
        outputVacated=true;
        existingOutput.identity=await anchoredSinglePathIdentity(
            backup,
            existingOutput.handle,
            existingOutput.identity,
            'Vacated bundle output backup'
        );
        backupIdentity=existingOutput.identity;
        await emit(onEvent,{
            type:'bundle.archive.output-vacated',
            outputPath,
            backupPath:backup,
            replaced:true
        });
        const stagedAfterEvent=await anchoredSinglePathIdentity(
            temporary,
            anchorHandle,
            stagingState.identity,
            'Verified bundle staging'
        );
        if(!identitiesEqual(stagedAfterEvent,stagingState.identity)){
            fail('Verified bundle staging changed before overwrite promotion.',ERROR_CODES.policyDenied);
        }
        const backupAfterEvent=await anchoredSinglePathIdentity(
            backup,
            existingOutput.handle,
            backupIdentity,
            'Preserved bundle backup'
        );
        if(!identitiesEqual(backupAfterEvent,backupIdentity)){
            fail('Preserved bundle backup changed before overwrite promotion.',ERROR_CODES.policyDenied);
        }
        await link(temporary,outputPath);
        promoted=true;
        stagingState.identity=await assertLinkedStagingPair(
            temporary,
            outputPath,
            stagingState.identity,
            anchorHandle
        );
        await rm(temporary);
        stagingState.identity=await anchoredSinglePathIdentity(
            outputPath,
            anchorHandle,
            stagingState.identity,
            'Bundle output'
        );
        return Object.freeze({
            outputPath,
            backupPath:backup,
            backupIdentity,
            promotedIdentity:stagingState.identity,
            promoted,
            replaced:true,
            stagingPath:temporary,
            stagingState
        });
    }catch(error){
        const failure=error?.code==='EEXIST'
            ?new ArcaneError(
                ERROR_CODES.policyDenied,
                'A path collision blocked create-only bundle promotion; no path was overwritten.',
                {cause:error}
            )
            :error;
        if(outputVacated||promoted){
            const rollbackIssues=await rollbackPromotion({
                outputPath,
                backupPath:backupLinked?backup:null,
                backupIdentity,
                promotedIdentity:stagingState.identity,
                promoted,
                stagingPath:temporary,
                stagingState
            },{
                promotedHandle:anchorHandle,
                backupHandle:existingOutput.handle
            });
            if(rollbackIssues.length){
                appendErrorWarning(failure,`Rollback warning: ${rollbackIssues.join('; ')}`);
            }
        }else if(backupLinked){
            const cleanupIssues=await removeUncommittedBackupLink({
                outputPath,
                backupPath:backup,
                existingOutput
            });
            if(cleanupIssues.length){
                appendErrorWarning(failure,`Backup cleanup warning: ${cleanupIssues.join('; ')}`);
            }
        }
        throw failure;
    }
}

async function removeUncommittedBackupLink({outputPath,backupPath,existingOutput}){
    const issues=[];
    try{
        existingOutput.identity=await anchoredLinkPairIdentity(
            outputPath,
            backupPath,
            existingOutput.handle,
            existingOutput.identity,
            'Uncommitted bundle backup'
        );
        await rm(backupPath);
        existingOutput.identity=await anchoredSinglePathIdentity(
            outputPath,
            existingOutput.handle,
            existingOutput.identity,
            'Existing output after backup cleanup'
        );
    }catch(error){
        issues.push(`preserve uncommitted backup ${backupPath}: ${error.message}`);
    }
    return issues;
}

async function stableFileDigest(filePath,label,{signal}={}){
    const opened=await openStableFile(filePath,label,{
        maximum:APP_BUNDLE_LIMITS.maxCompressedBytes
    });
    try{
        const digest=createHash('sha256');
        const buffer=Buffer.allocUnsafe(64*1024);
        let position=0;
        while(position<opened.identity.bytes){
            throwIfAborted(signal);
            const requested=Math.min(buffer.length,opened.identity.bytes-position);
            const result=await opened.handle.read(buffer,0,requested,position);
            if(result.bytesRead===0)fail(`${label} ended before its recorded byte length.`);
            digest.update(buffer.subarray(0,result.bytesRead));
            position+=result.bytesRead;
        }
        const probe=Buffer.alloc(1);
        const extra=await opened.handle.read(probe,0,1,opened.identity.bytes);
        if(extra.bytesRead!==0)fail(`${label} grew beyond its recorded byte length.`);
        const canonicalPath=await realpath(filePath);
        const after=await opened.handle.stat({bigint:true});
        const current=await lstat(filePath,{bigint:true});
        const canonical=await lstat(canonicalPath,{bigint:true});
        if(after.nlink!==1n||current.nlink!==1n||canonical.nlink!==1n
            ||current.isSymbolicLink()||canonical.isSymbolicLink()
            ||!current.isFile()||!identityMatches(after,opened.identity)
            ||!canonical.isFile()||!identityMatches(current,opened.identity)
            ||!identityMatches(canonical,opened.identity)){
            fail(`${label} changed while its promoted identity was verified.`);
        }
        return Object.freeze({
            path:canonicalPath,
            bytes:opened.identity.bytes,
            sha256:digest.digest('hex'),
            identity:opened.identity
        });
    }finally{
        await opened.handle.close().catch(()=>{});
    }
}

async function rollbackPromotion(transaction,{promotedHandle,backupHandle}={}){
    const issues=[];
    let outputAbsent=false;
    let recoverableBackupIdentity=null;
    if(transaction.backupPath){
        if(!transaction.backupIdentity||!backupHandle){
            issues.push(`preserve ${transaction.backupPath}; backup identity is unavailable before restore`);
            issues.push(`preserve promoted output path ${transaction.outputPath}; prior backup is not recoverable`);
            return issues;
        }
        try{
            recoverableBackupIdentity=await anchoredSinglePathIdentity(
                transaction.backupPath,
                backupHandle,
                transaction.backupIdentity,
                'Preserved bundle backup'
            );
            if(!identitiesEqual(recoverableBackupIdentity,transaction.backupIdentity)){
                throw new Error('Preserved bundle backup identity changed before restore.');
            }
        }catch(error){
            if(error?.code==='ENOENT'){
                issues.push(`preserved backup disappeared before restore: ${transaction.backupPath}`);
            }else{
                issues.push(`preserve ${transaction.backupPath}; backup identity changed before restore: ${error.message}`);
            }
            issues.push(`preserve promoted output path ${transaction.outputPath}; prior backup is not recoverable`);
            return issues;
        }
    }
    try{
        const output=await lstat(transaction.outputPath,{bigint:true});
        let anchored;
        if(promotedHandle){
            try{
                anchored=await promotedHandle.stat({bigint:true});
            }catch(error){
                issues.push(`preserve changed output path ${transaction.outputPath}; promoted handle identity is unavailable: ${error.message}`);
            }
        }
        if(!transaction.promoted||!transaction.promotedIdentity
            ||output.isSymbolicLink()||!output.isFile()
            ||!identityMatches(output,transaction.promotedIdentity)
            ||(promotedHandle&&(!anchored||!anchored.isFile()
                ||!identityMatches(anchored,transaction.promotedIdentity)))){
            issues.push(`preserve changed output path ${transaction.outputPath}; identity is not owned by this operation`);
        }else{
            await rm(transaction.outputPath);
            outputAbsent=true;
            if(transaction.stagingPath&&transaction.stagingState&&promotedHandle){
                try{
                    transaction.stagingState.identity=await anchoredSinglePathIdentity(
                        transaction.stagingPath,
                        promotedHandle,
                        transaction.promotedIdentity,
                        'Rolled-back bundle staging'
                    );
                }catch(error){
                    if(error?.code!=='ENOENT'){
                        issues.push(`refresh rolled-back staging identity: ${error.message}`);
                    }
                }
            }
        }
    }catch(error){
        if(error?.code==='ENOENT')outputAbsent=true;
        else issues.push(`inspect or remove failed output: ${error.message}`);
    }
    if(transaction.backupPath){
        try{
            const backupIdentity=await anchoredSinglePathIdentity(
                transaction.backupPath,
                backupHandle,
                recoverableBackupIdentity,
                'Preserved bundle backup'
            );
            if(!identitiesEqual(backupIdentity,recoverableBackupIdentity)){
                issues.push(`preserve ${transaction.backupPath}; backup identity changed before restore`);
                return issues;
            }
            if(!outputAbsent){
                issues.push(`preserve ${transaction.backupPath}; output path is occupied by an unowned identity`);
                return issues;
            }
            await link(transaction.backupPath,transaction.outputPath);
            const linkedIdentity=await anchoredLinkPairIdentity(
                transaction.outputPath,
                transaction.backupPath,
                backupHandle,
                transaction.backupIdentity,
                'Create-only bundle restore'
            );
            await rm(transaction.backupPath);
            await anchoredSinglePathIdentity(
                transaction.outputPath,
                backupHandle,
                linkedIdentity,
                'Restored bundle output'
            );
        }catch(error){
            if(error?.code==='EEXIST'){
                issues.push(`preserve ${transaction.backupPath}; create-only restore found an occupied output path`);
            }else if(error?.code!=='ENOENT'){
                issues.push(`restore ${transaction.backupPath}: ${error.message}`);
            }
            else issues.push(`preserved backup disappeared before restore: ${transaction.backupPath}`);
        }
    }
    return issues;
}

async function finalizePromotion(transaction,{backupHandle}={}){
    if(!transaction.backupPath)return null;
    try{
        if(!transaction.backupIdentity||!backupHandle){
            throw new Error('Preserved artifact backup identity changed before cleanup.');
        }
        const backupIdentity=await anchoredSinglePathIdentity(
            transaction.backupPath,
            backupHandle,
            transaction.backupIdentity,
            'Preserved artifact backup'
        );
        if(!identitiesEqual(backupIdentity,transaction.backupIdentity)){
            throw new Error('Preserved artifact backup identity changed before cleanup.');
        }
        await rm(transaction.backupPath);
        return null;
    }catch(error){
        return Object.freeze({
            scope:'artifact-backup',
            path:transaction.backupPath,
            message:String(error?.message??error),
            recovery:'The verified output is committed; inspect and remove this preserved prior artifact.'
        });
    }
}

async function resolveOutputTarget(requested,releaseRoot){
    const requestedParent=path.dirname(requested);
    const missing=[];
    let existing=requestedParent;
    for(;;){
        try{
            const info=await lstat(existing);
            if(info.isSymbolicLink()||!info.isDirectory()){
                fail('Bundle output parent must resolve through regular directories.',ERROR_CODES.policyDenied);
            }
            break;
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
            const parent=path.dirname(existing);
            if(parent===existing)throw error;
            missing.unshift(path.basename(existing));
            existing=parent;
        }
    }
    const canonicalExisting=await realpath(existing);
    const candidateParent=path.join(canonicalExisting,...missing);
    if(isInside(releaseRoot,candidateParent)){
        fail('Bundle output cannot be inside the authenticated release root.',ERROR_CODES.policyDenied);
    }
    await mkdir(candidateParent,{recursive:true});
    const canonicalParent=await realpath(candidateParent);
    if(isInside(releaseRoot,canonicalParent)){
        fail('Bundle output parent resolved inside the authenticated release root.',ERROR_CODES.policyDenied);
    }
    return path.join(canonicalParent,path.basename(requested));
}

function parseCanonicalJson(bytes,label){
    let text;
    try{
        text=textDecoder.decode(bytes);
    }catch(error){
        fail(`${label} is not UTF-8 JSON.`,ERROR_CODES.integrityFailed,{cause:error.message});
    }
    let value;
    try{
        value=JSON.parse(text);
    }catch(error){
        fail(`${label} is not valid JSON.`,ERROR_CODES.integrityFailed,{cause:error.message});
    }
    if(!bytes.equals(canonicalJsonBytes(value))){
        fail(`${label} is not canonical two-space JSON with one trailing LF.`);
    }
    return value;
}

class StrictTarParser{
    constructor(compressedBytes){
        this.compressedBytes=compressedBytes;
        this.expansionLimit=Math.min(
            APP_BUNDLE_LIMITS.maxExpandedBytes,
            compressedBytes*APP_BUNDLE_LIMITS.maxExpansionRatio
                +APP_BUNDLE_LIMITS.expansionSlackBytes
        );
        this.totalExpanded=0;
        this.header=Buffer.alloc(TAR_BLOCK_BYTES);
        this.headerBytes=0;
        this.state='header';
        this.zeroBlocks=0;
        this.entries=[];
        this.pathTopology={kinds:new Map(),spellings:new Map()};
        this.current=null;
        this.remaining=0;
        this.padding=0;
        this.ended=false;
    }

    consume(chunk){
        this.totalExpanded+=chunk.length;
        if(this.totalExpanded>this.expansionLimit){
            fail('Bundle expansion exceeds its absolute or ratio ceiling.',ERROR_CODES.policyDenied);
        }
        let offset=0;
        while(offset<chunk.length){
            if(this.ended)fail('USTAR archive contains bytes after its two terminal zero blocks.');
            if(this.state==='header'){
                const count=Math.min(TAR_BLOCK_BYTES-this.headerBytes,chunk.length-offset);
                chunk.copy(this.header,this.headerBytes,offset,offset+count);
                this.headerBytes+=count;
                offset+=count;
                if(this.headerBytes===TAR_BLOCK_BYTES)this.finishHeader();
                continue;
            }
            if(this.state==='data'){
                const count=Math.min(this.remaining,chunk.length-offset);
                const piece=chunk.subarray(offset,offset+count);
                this.current.digest.update(piece);
                if(this.current.chunks){
                    this.current.chunks.push(Buffer.from(piece));
                    this.current.controlBytes+=piece.length;
                    if(this.current.controlBytes>APP_BUNDLE_LIMITS.maxControlBytes){
                        fail(`${this.current.path} exceeds the control-document limit.`,ERROR_CODES.policyDenied);
                    }
                }
                this.remaining-=count;
                offset+=count;
                if(this.remaining===0)this.finishEntry();
                continue;
            }
            if(this.state==='padding'){
                const count=Math.min(this.padding,chunk.length-offset);
                if(chunk.subarray(offset,offset+count).some(byte=>byte!==0)){
                    fail(`USTAR padding is nonzero after ${this.current?.path??'an entry'}.`);
                }
                this.padding-=count;
                offset+=count;
                if(this.padding===0){
                    this.current=null;
                    this.state='header';
                }
            }
        }
    }

    finishHeader(){
        const header=Buffer.from(this.header);
        this.header.fill(0);
        this.headerBytes=0;
        if(header.every(byte=>byte===0)){
            this.zeroBlocks+=1;
            if(this.zeroBlocks===2){
                this.ended=true;
                return;
            }
            this.state='header';
            return;
        }
        if(this.zeroBlocks!==0)fail('USTAR archive resumed after its first terminal zero block.');
        if(this.entries.length>=APP_BUNDLE_LIMITS.maxEntries){
            fail('USTAR archive exceeds its entry-count limit.',ERROR_CODES.policyDenied);
        }
        const parsed=parseCanonicalUstarHeader(header);
        const expectedControl=[
            APP_BUNDLE_MANIFEST_NAME,
            APP_BUNDLE_DESCRIPTOR_NAME,
            APP_BUNDLE_RELEASE_PATH
        ][this.entries.length];
        if(expectedControl&&parsed.path!==expectedControl){
            fail(`USTAR entry ${this.entries.length+1} must be ${expectedControl}.`);
        }
        if(this.entries.length>=3&&!parsed.path.startsWith('payload/')){
            fail('Every non-control USTAR entry must be beneath payload/.');
        }
        registerPortablePathTopology(this.pathTopology,parsed.path,'USTAR archive topology');
        this.current={
            path:parsed.path,
            size:parsed.size,
            digest:createHash('sha256'),
            chunks:CONTROL_PATHS.has(parsed.path)?[]:null,
            controlBytes:0
        };
        this.remaining=parsed.size;
        this.padding=(TAR_BLOCK_BYTES-(parsed.size%TAR_BLOCK_BYTES))%TAR_BLOCK_BYTES;
        this.state='data';
        if(this.remaining===0)this.finishEntry();
    }

    finishEntry(){
        const entry=Object.freeze({
            path:this.current.path,
            bytes:this.current.size,
            sha256:this.current.digest.digest('hex'),
            ...(this.current.chunks?{buffer:Buffer.concat(this.current.chunks)}:{})
        });
        this.entries.push(entry);
        if(this.padding===0){
            this.current=null;
            this.state='header';
        }else{
            this.state='padding';
        }
    }

    finish(){
        if(!this.ended||this.zeroBlocks!==2||this.headerBytes!==0
            ||this.state!=='header'||this.current!==null){
            fail('USTAR archive ended before its exact two-block terminator.');
        }
        return Object.freeze({
            entries:Object.freeze(this.entries),
            expandedBytes:this.totalExpanded
        });
    }
}

class DeterministicGzipDigest{
    constructor(){
        this.digest=createHash('sha256');
        this.digest.update(GZIP_HEADER);
        this.compressedBytes=GZIP_HEADER.length;
        this.crc=0xffffffff;
        this.expandedBytes=0;
        this.deflate=createDeflateRaw({level:9});
        this.deflate.on('data',chunk=>{
            this.digest.update(chunk);
            this.compressedBytes+=chunk.length;
        });
    }

    async write(chunk){
        this.crc=updateCrc32(this.crc,chunk);
        this.expandedBytes=(this.expandedBytes+chunk.length)>>>0;
        if(!this.deflate.write(chunk))await once(this.deflate,'drain');
    }

    async finish(){
        const completed=new Promise((resolve,reject)=>{
            this.deflate.once('end',resolve);
            this.deflate.once('error',reject);
        });
        this.deflate.end();
        await completed;
        const trailer=Buffer.alloc(8);
        trailer.writeUInt32LE((this.crc^0xffffffff)>>>0,0);
        trailer.writeUInt32LE(this.expandedBytes>>>0,4);
        this.digest.update(trailer);
        this.compressedBytes+=trailer.length;
        return Object.freeze({
            sha256:this.digest.digest('hex'),
            compressedBytes:this.compressedBytes
        });
    }

    destroy(){
        this.deflate.destroy();
    }
}

function validateFileRecord(file,label){
    assertExactKeys(file,['path','bytes','sha256'],label);
    validateAppBundlePath(file.path,`${label}.path`);
    assertInteger(file.bytes,{
        minimum:0,
        maximum:APP_BUNDLE_LIMITS.maxEntryBytes,
        label:`${label}.bytes`
    });
    assertSha256(file.sha256,`${label}.sha256`);
    return Object.freeze({path:file.path,bytes:file.bytes,sha256:file.sha256});
}

function validateBundleManifest(value){
    assertExactKeys(value,[
        'schemaVersion','kind','format','sdk','app','descriptor','release','payload'
    ],APP_BUNDLE_MANIFEST_NAME);
    if(value.schemaVersion!==APP_BUNDLE_SCHEMA_VERSION||value.kind!==APP_BUNDLE_KIND
        ||value.format!==APP_BUNDLE_FORMAT){
        fail('Bundle manifest protocol discriminator is unsupported.');
    }
    assertExactKeys(value.sdk,['name','version'],'bundle.sdk');
    if(value.sdk.name!==SDK_NAME)fail(`bundle.sdk.name must be ${SDK_NAME}.`);
    parseSemver(value.sdk.version);
    if(!APP_BUNDLE_SUPPORTED_SDK_VERSIONS.includes(value.sdk.version)){
        fail(
            `bundle.sdk.version ${value.sdk.version} is structurally known but not compatible with this Arcane SDK generation.`,
            ERROR_CODES.policyDenied
        );
    }
    assertExactKeys(value.app,['id','version'],'bundle.app');
    if(typeof value.app.id!=='string'||!APP_ID_PATTERN.test(value.app.id))fail('bundle.app.id is invalid.');
    parseSemver(value.app.version);
    assertExactKeys(value.descriptor,[
        'path','schemaVersion','canonicalSha256','packageSha256','fileSha256','bytes'
    ],'bundle.descriptor');
    if(value.descriptor.path!==APP_BUNDLE_DESCRIPTOR_NAME||value.descriptor.schemaVersion!==2){
        fail('bundle.descriptor must identify the authored schema-2 descriptor.');
    }
    for(const field of ['canonicalSha256','packageSha256','fileSha256']){
        assertSha256(value.descriptor[field],`bundle.descriptor.${field}`);
    }
    assertInteger(value.descriptor.bytes,{
        minimum:1,
        maximum:APP_BUNDLE_LIMITS.maxControlBytes,
        label:'bundle.descriptor.bytes'
    });
    assertExactKeys(value.release,[
        'path','schemaVersion','builder','policySha256','manifestSha256',
        'contentSha256','fileCount','totalBytes'
    ],'bundle.release');
    if(value.release.path!==APP_BUNDLE_RELEASE_PATH||value.release.schemaVersion!==1
        ||value.release.builder!==PACKAGER_VERSION){
        fail('bundle.release identifies an unsupported app release contract.');
    }
    for(const field of ['policySha256','manifestSha256','contentSha256']){
        assertSha256(value.release[field],`bundle.release.${field}`);
    }
    assertInteger(value.release.fileCount,{
        minimum:1,
        maximum:APP_BUNDLE_LIMITS.maxPayloadFiles,
        label:'bundle.release.fileCount'
    });
    assertInteger(value.release.totalBytes,{
        minimum:1,
        maximum:APP_BUNDLE_LIMITS.maxExpandedBytes,
        label:'bundle.release.totalBytes'
    });
    assertExactKeys(value.payload,['root','fileCount','totalBytes','files'],'bundle.payload');
    if(value.payload.root!=='payload'||!Array.isArray(value.payload.files)){
        fail('bundle.payload must contain one exact payload inventory.');
    }
    if(value.payload.files.length<1||value.payload.files.length>APP_BUNDLE_LIMITS.maxPayloadFiles){
        fail('bundle.payload.files exceeds its cardinality contract.');
    }
    const keys=new Set();
    let totalBytes=0;
    let previous=null;
    const files=value.payload.files.map((file,index)=>{
        const record=validateFileRecord(file,`bundle.payload.files[${index}]`);
        if(pathKey(record.path)===pathKey(RELEASE_MANIFEST_NAME)){
            fail(`bundle.payload.files must not contain ${RELEASE_MANIFEST_NAME}.`);
        }
        const key=pathKey(record.path);
        if(keys.has(key))fail(`Bundle payload has a duplicate or case-colliding path: ${record.path}.`);
        keys.add(key);
        if(previous!==null&&compareText(previous,record.path)>=0){
            fail('Bundle payload inventory must use strict canonical path order.');
        }
        previous=record.path;
        totalBytes+=record.bytes;
        if(!Number.isSafeInteger(totalBytes)||totalBytes>APP_BUNDLE_LIMITS.maxExpandedBytes){
            fail('Bundle payload exceeds its expanded byte ceiling.',ERROR_CODES.policyDenied);
        }
        return record;
    });
    validatePortablePathTopology([
        APP_BUNDLE_MANIFEST_NAME,
        APP_BUNDLE_DESCRIPTOR_NAME,
        APP_BUNDLE_RELEASE_PATH,
        ...files.map(file=>`payload/${file.path}`)
    ],'Bundle archive topology');
    if(value.payload.fileCount!==files.length||value.payload.totalBytes!==totalBytes
        ||value.release.fileCount!==files.length||value.release.totalBytes!==totalBytes){
        fail('Bundle payload and release totals do not match their inventory.');
    }
    return {manifest:value,files:Object.freeze(files)};
}

function validateEmbeddedRelease(value,descriptor,files,bundle){
    assertExactKeys(value,[
        'schemaVersion','builder','app','policySha256','fileCount','totalBytes','contentSha256','files'
    ],RELEASE_MANIFEST_NAME);
    if(value.schemaVersion!==1||value.builder!==PACKAGER_VERSION){
        fail('Embedded release manifest protocol is unsupported.');
    }
    assertExactKeys(value.app,[
        'id','displayName','version','entry','start','security','localAIModelPolicy'
    ],'embedded release app');
    const expectedApp=expectedReleaseApp(descriptor);
    if(JSON.stringify(value.app)!==JSON.stringify(expectedApp)){
        fail('Embedded release app does not match the authored descriptor.');
    }
    const releaseFiles=Array.isArray(value.files)
        ?value.files.map((file,index)=>validateFileRecord(file,`release.files[${index}]`))
        :null;
    if(!releaseFiles||JSON.stringify(releaseFiles)!==JSON.stringify(files)){
        fail('Embedded release inventory does not match the bundle payload inventory.');
    }
    const totalBytes=files.reduce((total,file)=>total+file.bytes,0);
    const contentSha256=sha256(JSON.stringify(files));
    assertSha256(value.policySha256,'release.policySha256');
    if(value.fileCount!==files.length||value.totalBytes!==totalBytes
        ||value.contentSha256!==contentSha256){
        fail('Embedded release inventory totals or content digest are invalid.');
    }
    if(bundle.release.builder!==value.builder
        ||bundle.release.policySha256!==value.policySha256
        ||bundle.release.contentSha256!==value.contentSha256
        ||bundle.release.fileCount!==value.fileCount
        ||bundle.release.totalBytes!==value.totalBytes){
        fail('Bundle release binding does not match the embedded release manifest.');
    }
    return value;
}

function validateParsedBundle(parsed,{
    bundleSha256,
    compressedBytes,
    bundlePath,
    artifactIdentity
}){
    const entries=parsed.entries;
    if(entries.length<4)fail('Bundle must contain three control documents and at least one payload file.');
    const [bundleEntry,descriptorEntry,releaseEntry]=entries;
    const {manifest,files}=validateBundleManifest(
        parseCanonicalJson(bundleEntry.buffer,APP_BUNDLE_MANIFEST_NAME)
    );
    const expectedPaths=[
        APP_BUNDLE_MANIFEST_NAME,
        APP_BUNDLE_DESCRIPTOR_NAME,
        APP_BUNDLE_RELEASE_PATH,
        ...files.map(file=>`payload/${file.path}`)
    ];
    if(JSON.stringify(entries.map(entry=>entry.path))!==JSON.stringify(expectedPaths)){
        fail('Bundle USTAR topology or entry order does not match the manifest.');
    }
    const descriptorDocument=parseCanonicalJson(descriptorEntry.buffer,APP_BUNDLE_DESCRIPTOR_NAME);
    const descriptor=validateAppDescriptor(descriptorDocument,{appId:manifest.app.id});
    if(!descriptorEntry.buffer.equals(canonicalJsonBytes(descriptor))
        ||descriptor.version!==manifest.app.version
        ||descriptor.schemaVersion!==manifest.descriptor.schemaVersion
        ||descriptorEntry.bytes!==manifest.descriptor.bytes
        ||descriptorEntry.sha256!==manifest.descriptor.fileSha256
        ||appDescriptorSha256(descriptor)!==manifest.descriptor.canonicalSha256
        ||sha256(JSON.stringify(projectPackageManifest(descriptor)))!==manifest.descriptor.packageSha256){
        fail('Authored descriptor binding does not match the bundle manifest.');
    }
    const releaseDocument=parseCanonicalJson(releaseEntry.buffer,RELEASE_MANIFEST_NAME);
    validateEmbeddedRelease(releaseDocument,descriptor,files,manifest);
    if(releaseEntry.sha256!==manifest.release.manifestSha256){
        fail('Embedded release manifest digest does not match the bundle manifest.');
    }
    for(let index=0;index<files.length;index+=1){
        const entry=entries[index+3];
        const file=files[index];
        if(entry.bytes!==file.bytes||entry.sha256!==file.sha256){
            fail(`Payload entry does not match its release identity: ${file.path}.`);
        }
    }
    const consistency=Object.freeze({
        artifact:Object.freeze({sha256:bundleSha256,bytes:compressedBytes}),
        descriptor:Object.freeze({
            canonicalSha256:manifest.descriptor.canonicalSha256,
            fileSha256:manifest.descriptor.fileSha256,
            packageSha256:manifest.descriptor.packageSha256,
            bytes:manifest.descriptor.bytes
        }),
        release:Object.freeze({
            manifestSha256:manifest.release.manifestSha256,
            policySha256:manifest.release.policySha256,
            contentSha256:manifest.release.contentSha256,
            fileCount:manifest.release.fileCount,
            totalBytes:manifest.release.totalBytes
        })
    });
    return Object.freeze({
        schemaVersion:APP_BUNDLE_SCHEMA_VERSION,
        kind:'arcane-app-release-bundle-verification',
        verified:true,
        arcaneCompatible:true,
        bundlePath,
        bundleSha256,
        compressedBytes,
        artifactIdentity,
        expandedBytes:parsed.expandedBytes,
        entryCount:entries.length,
        sdk:Object.freeze({...manifest.sdk}),
        app:Object.freeze({...manifest.app}),
        descriptorSha256:manifest.descriptor.canonicalSha256,
        descriptorFileSha256:manifest.descriptor.fileSha256,
        descriptorBytes:manifest.descriptor.bytes,
        packageSha256:manifest.descriptor.packageSha256,
        releaseManifestSha256:manifest.release.manifestSha256,
        releasePolicySha256:manifest.release.policySha256,
        releaseContentSha256:manifest.release.contentSha256,
        fileCount:manifest.release.fileCount,
        totalBytes:manifest.release.totalBytes,
        consistency
    });
}

export async function verifyAppReleaseBundle({bundlePath,signal,onEvent}={}){
    throwIfAborted(signal);
    if(typeof bundlePath!=='string'||!bundlePath.trim()){
        fail('bundlePath is required to verify an app release bundle.',ERROR_CODES.usage);
    }
    const requested=path.resolve(bundlePath);
    await emit(onEvent,{type:'bundle.verify.started',bundlePath:requested});
    const opened=await openStableFile(requested,'app release bundle',{
        maximum:APP_BUNDLE_LIMITS.maxCompressedBytes
    });
    let recompressed;
    try{
        const canonicalRequested=await realpath(requested);
        const canonicalInfo=await lstat(canonicalRequested,{bigint:true});
        if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isFile()||canonicalInfo.nlink!==1n
            ||!identityMatches(canonicalInfo,opened.identity)){
            fail('App release bundle canonical path did not bind to its opened identity.');
        }
        await emit(onEvent,{
            type:'bundle.verify.opened',
            bundlePath:canonicalRequested,
            compressedBytes:opened.identity.bytes
        });
        if(opened.identity.bytes<GZIP_HEADER.length+8){
            fail('App release bundle is too short to be canonical gzip.');
        }
        const header=Buffer.alloc(GZIP_HEADER.length);
        const first=await opened.handle.read(header,0,header.length,0);
        if(first.bytesRead!==header.length||!header.equals(GZIP_HEADER)){
            fail('Bundle gzip header is not the deterministic Arcane header.');
        }
        const parser=new StrictTarParser(opened.identity.bytes);
        recompressed=new DeterministicGzipDigest();
        const actualDigest=createHash('sha256');
        let actualBytes=0;
        const actual=new Transform({
            transform(chunk,_encoding,callback){
                try{
                    actualBytes+=chunk.length;
                    if(actualBytes>opened.identity.bytes
                        ||actualBytes>APP_BUNDLE_LIMITS.maxCompressedBytes){
                        fail('Bundle compressed stream exceeded its recorded byte ceiling.',ERROR_CODES.policyDenied);
                    }
                    actualDigest.update(chunk);
                    callback(null,chunk);
                }catch(error){
                    callback(error);
                }
            }
        });
        const gunzip=createGunzip();
        const consume=new Writable({
            write(chunk,_encoding,callback){
                try{
                    throwIfAborted(signal);
                    parser.consume(chunk);
                    recompressed.write(chunk).then(()=>callback(),callback);
                }catch(error){
                    callback(error);
                }
            }
        });
        await pipeline(
            opened.handle.createReadStream({
                autoClose:false,
                start:0,
                end:opened.identity.bytes-1
            }),
            actual,
            gunzip,
            consume,
            {signal}
        );
        const parsed=parser.finish();
        const deterministic=await recompressed.finish();
        const bundleSha256=actualDigest.digest('hex');
        const probe=Buffer.alloc(1);
        const extra=await opened.handle.read(probe,0,1,opened.identity.bytes);
        if(extra.bytesRead!==0)fail('App release bundle grew while it was verified.');
        if(actualBytes!==opened.identity.bytes
            ||deterministic.compressedBytes!==actualBytes
            ||deterministic.sha256!==bundleSha256){
            fail('Bundle gzip member is not the exact deterministic Arcane encoding.');
        }
        const canonicalCurrent=await realpath(requested);
        const after=await opened.handle.stat({bigint:true});
        const current=await lstat(requested,{bigint:true});
        const canonicalAfter=await lstat(canonicalRequested,{bigint:true});
        if(after.nlink!==1n||current.nlink!==1n||canonicalAfter.nlink!==1n
            ||!identityMatches(after,opened.identity)||current.isSymbolicLink()
            ||canonicalAfter.isSymbolicLink()||!current.isFile()||!canonicalAfter.isFile()
            ||!identityMatches(current,opened.identity)
            ||!identityMatches(canonicalAfter,opened.identity)
            ||canonicalCurrent!==canonicalRequested){
            fail('App release bundle changed while it was verified.');
        }
        const receipt=validateParsedBundle(parsed,{
            bundleSha256,
            compressedBytes:actualBytes,
            bundlePath:canonicalRequested,
            artifactIdentity:opened.identity
        });
        await emit(onEvent,{
            type:'bundle.verify.completed',
            bundlePath:receipt.bundlePath,
            bundleSha256:receipt.bundleSha256,
            entryCount:receipt.entryCount
        });
        return receipt;
    }catch(error){
        recompressed?.destroy();
        if(error?.name==='AbortError'||signal?.aborted)throwIfAborted(signal);
        throw error;
    }finally{
        await opened.handle.close().catch(()=>{});
    }
}

export async function createAppReleaseBundle({
    receipt,
    releaseRoot,
    outputPath,
    overwrite=false,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    if(typeof overwrite!=='boolean'){
        fail('overwrite must be a literal boolean.',ERROR_CODES.usage);
    }
    if(typeof releaseRoot!=='string'||!releaseRoot.trim()){
        fail('releaseRoot is required to create an app release bundle.',ERROR_CODES.usage);
    }
    if(typeof outputPath!=='string'||!outputPath.trim()){
        fail('outputPath is required to create an app release bundle.',ERROR_CODES.usage);
    }
    const requestedOutput=path.resolve(outputPath);
    validateOutputFilename(requestedOutput);
    const authority=await authenticateAppReleaseAuthority(receipt,{releaseRoot,signal});
    const canonicalReleaseRoot=await realpath(path.resolve(releaseRoot));
    const descriptor=validateAppDescriptor(authority.descriptor,{appId:receipt.app?.id});
    if(authority.source!=='authored'||descriptor.schemaVersion!==2
        ||authority.descriptorSha256!==appDescriptorSha256(descriptor)){
        fail('Bundle creation requires one authenticated authored schema-2 descriptor.');
    }
    const files=validateReleaseInventory(receipt);
    const release=releaseDocumentFromReceipt(receipt,descriptor,files);
    const releaseBytes=canonicalJsonBytes(release);
    const sourceReleaseBytes=await readStableControlFile(
        path.join(canonicalReleaseRoot,RELEASE_MANIFEST_NAME),
        RELEASE_MANIFEST_NAME,
        {signal}
    );
    if(!sourceReleaseBytes.equals(releaseBytes)){
        fail('Authenticated release manifest bytes are not the canonical receipt projection.');
    }
    const descriptorBytes=canonicalJsonBytes(descriptor);
    if(descriptorBytes.length>APP_BUNDLE_LIMITS.maxControlBytes){
        fail('Authored app descriptor exceeds the control-document limit.',ERROR_CODES.policyDenied);
    }
    const manifest=createBundleManifest({
        descriptor,
        descriptorBytes,
        descriptorSha256:authority.descriptorSha256,
        release,
        releaseBytes
    });
    const manifestBytes=canonicalJsonBytes(manifest);
    if(manifestBytes.length>APP_BUNDLE_LIMITS.maxControlBytes){
        fail('Bundle manifest exceeds the control-document limit.',ERROR_CODES.policyDenied);
    }
    const entries=[
        {path:APP_BUNDLE_MANIFEST_NAME,bytes:manifestBytes.length,buffer:manifestBytes},
        {path:APP_BUNDLE_DESCRIPTOR_NAME,bytes:descriptorBytes.length,buffer:descriptorBytes},
        {path:APP_BUNDLE_RELEASE_PATH,bytes:releaseBytes.length,buffer:releaseBytes},
        ...files.map(identity=>({
            path:validateAppBundlePath(`payload/${identity.path}`,'bundle payload archive path'),
            bytes:identity.bytes,
            identity
        }))
    ];
    validatePortablePathTopology(entries.map(entry=>entry.path),'Bundle archive topology');
    if(entries.length>APP_BUNDLE_LIMITS.maxEntries){
        fail('Bundle exceeds the archive entry-count limit.',ERROR_CODES.policyDenied);
    }
    const output=await resolveOutputTarget(requestedOutput,canonicalReleaseRoot);
    const token=`${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`;
    const temporary=path.join(path.dirname(output),`.${path.basename(output)}.${token}.tmp`);
    const releaseLock=await acquireArtifactLock(output,{onEvent});
    let handle;
    let existingOutput;
    let temporaryIdentity;
    let stagingState;
    let committed=false;
    let promotion;
    let result;
    let operationError;
    const cleanupIssues=[];
    try{
        existingOutput=await inspectOutput(output,{overwrite});
        await emit(onEvent,{
            type:'bundle.archive.started',
            outputPath:output,
            appId:descriptor.id,
            version:descriptor.version,
            entryCount:entries.length
        });
        handle=await open(temporary,'wx',0o600);
        const createdTemporary=await handle.stat({bigint:true});
        if(!createdTemporary.isFile()||createdTemporary.nlink!==1n){
            fail('New bundle staging is not an owned single-link regular file.',ERROR_CODES.policyDenied);
        }
        const encoded=await writeDeterministicGzip(handle,entries,{
            releaseRoot:canonicalReleaseRoot,
            signal,
            onEvent
        });
        await handle.chmod(ARCHIVE_MODE);
        await handle.sync();
        throwIfAborted(signal);
        await authenticateAppReleaseAuthority(receipt,{releaseRoot:canonicalReleaseRoot,signal});
        const verified=await verifyAppReleaseBundle({bundlePath:temporary,signal});
        if(verified.bundleSha256!==encoded.sha256||verified.compressedBytes!==encoded.bytes){
            fail('New bundle verification did not reproduce its encoded identity.');
        }
        const temporaryInfo=await lstat(temporary,{bigint:true});
        if(temporaryInfo.isSymbolicLink()||!temporaryInfo.isFile()||temporaryInfo.nlink!==1n){
            fail('Verified bundle staging is not a regular file.',ERROR_CODES.policyDenied);
        }
        temporaryIdentity=fileIdentity(temporaryInfo);
        const anchoredTemporary=await handle.stat({bigint:true});
        if(!anchoredTemporary.isFile()||anchoredTemporary.nlink!==1n
            ||!identityMatches(anchoredTemporary,temporaryIdentity)){
            fail('Verified bundle staging is not the originally created file object.',ERROR_CODES.policyDenied);
        }
        if(!identitiesEqual(temporaryIdentity,verified.artifactIdentity)){
            fail('Verified bundle staging changed after independent verification.');
        }
        stagingState={identity:temporaryIdentity};
        await emit(onEvent,{
            type:'bundle.archive.verified',
            bundleSha256:verified.bundleSha256,
            compressedBytes:verified.compressedBytes
        });
        throwIfAborted(signal);
        promotion=await promoteArtifact(temporary,output,{
            existingOutput,
            stagingState,
            anchorHandle:handle,
            onEvent
        });
        await emit(onEvent,{
            type:'bundle.archive.promoted',
            bundlePath:output,
            bundleSha256:verified.bundleSha256
        });
        const promoted=await stableFileDigest(output,'promoted app release bundle',{signal});
        if(promoted.sha256!==verified.bundleSha256
            ||promoted.bytes!==verified.compressedBytes){
            fail('Promoted bundle identity does not match the independently verified staging bytes.');
        }
        const anchoredPromoted=await handle.stat({bigint:true});
        if(!anchoredPromoted.isFile()||anchoredPromoted.nlink!==1n
            ||!identityMatches(anchoredPromoted,promoted.identity)){
            fail('Promoted bundle digest was not read from the anchored staging object.');
        }
        const artifactReceipt=Object.freeze({
            ...verified,
            kind:'arcane-app-release-bundle-artifact',
            bundlePath:promoted.path,
            artifactIdentity:promoted.identity
        });
        await handle.close();
        handle=null;
        committed=true;
        const backupCleanup=await finalizePromotion(promotion,{
            backupHandle:existingOutput?.handle
        });
        if(backupCleanup)cleanupIssues.push(backupCleanup);
        let eventDelivery;
        try{
            await emit(onEvent,{
                type:'bundle.committed',
                phase:'publish',
                status:'completed',
                bundlePath:artifactReceipt.bundlePath,
                bundleSha256:artifactReceipt.bundleSha256
            });
        }catch(error){
            eventDelivery=Object.freeze({
                status:'degraded',
                errorCode:'ARCANE_EVENT_DELIVERY_FAILED',
                message:String(error?.message??error)
            });
        }
        result={
            app:descriptor.id,
            version:descriptor.version,
            outputPath:artifactReceipt.bundlePath,
            bundleSha256:artifactReceipt.bundleSha256,
            compressedBytes:artifactReceipt.compressedBytes,
            entryCount:artifactReceipt.entryCount,
            artifactReceipt,
            ...(eventDelivery?{eventDelivery}:{})
        };
    }catch(error){
        operationError=error;
        if(promotion&&!committed){
            const rollbackIssues=await rollbackPromotion(promotion,{
                promotedHandle:handle,
                backupHandle:existingOutput?.handle
            });
            if(rollbackIssues.length){
                appendErrorWarning(error,`Rollback warning: ${rollbackIssues.join('; ')}`);
            }
        }
    }finally{
        let stagingCleanupHandled=false;
        let retryStagingIdentity=null;
        if(!committed&&handle){
            const stagingCleanup=await cleanupAnchoredTemporary(
                temporary,
                handle,
                stagingState?.identity??temporaryIdentity
            );
            if(stagingCleanup.issue)cleanupIssues.push(stagingCleanup.issue);
            retryStagingIdentity=stagingCleanup.retryIdentity;
            stagingCleanupHandled=true;
        }
        if(handle){
            try{
                await handle.close();
            }catch(error){
                cleanupIssues.push(changedStagingCleanupIssue(
                    temporary,
                    `Staging creation handle close warning for ${temporary}: ${String(error?.message??error)}`
                ));
            }
            handle=null;
        }
        if(!committed&&(!stagingCleanupHandled||retryStagingIdentity)){
            const stagingCleanup=await cleanupOwnedTemporary(
                temporary,
                retryStagingIdentity??stagingState?.identity??temporaryIdentity
            );
            if(stagingCleanup)cleanupIssues.push(stagingCleanup);
        }
        if(existingOutput?.handle){
            try{
                await existingOutput.handle.close();
            }catch(error){
                cleanupIssues.push(Object.freeze({
                    scope:'artifact-backup-handle',
                    path:promotion?.backupPath??output,
                    message:`Prior-output anchor close warning: ${String(error?.message??error)}`,
                    recovery:'Inspect the preserved prior-output path before removing it.'
                }));
            }
            existingOutput.handle=null;
        }
        const lockCleanup=await releaseLock();
        if(lockCleanup)cleanupIssues.push(lockCleanup);
    }
    if(operationError){
        if(cleanupIssues.length){
            appendErrorWarning(
                operationError,
                `Cleanup warning: ${cleanupIssues.map(issue=>issue.message).join('; ')}`
            );
        }
        throw operationError;
    }
    if(cleanupIssues.length){
        result.cleanup=Object.freeze({
            status:'degraded',
            issues:Object.freeze(cleanupIssues)
        });
    }
    return Object.freeze(result);
}
