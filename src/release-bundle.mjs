import {
    lstat,
    mkdir,
    readFile,
    readdir,
    realpath,
    rename,
    rm,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {validateAppDescriptor} from './app-descriptor.mjs';
import {SDK_NAME,SDK_VERSION} from './constants.mjs';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {RELEASE_MANIFEST_NAME,PACKAGER_VERSION,parseSemver} from './packager/core.mjs';

export const APP_BUNDLE_MANIFEST_NAME='ARCANE_APP_BUNDLE.json';
export const APP_BUNDLE_DESCRIPTOR_NAME='arcane-app.json';
export const APP_BUNDLE_RELEASE_PATH=`payload/${RELEASE_MANIFEST_NAME}`;
export const APP_BUNDLE_KIND='arcane-app-release-bundle';
export const APP_BUNDLE_FORMAT='ustar+gzip';
export const APP_BUNDLE_SCHEMA_VERSION=1;
export const APP_BUNDLE_EXTENSION='.arcane-app.tar.gz';
export const APP_BUNDLE_SUPPORTED_SDK_VERSIONS=[SDK_VERSION];

const TAR_BLOCK_SIZE=512;
const TAR_END_SIZE=TAR_BLOCK_SIZE*2;
const ARCHIVE_MODE=0o644;
const WINDOWS_RESERVED_PATTERN=
    /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:[.]|$)/iu;
const WINDOWS_UNSAFE_FILENAME_CHARACTER_PATTERN=/[<>"|?*]/u;
const CONTROL_PATHS=new Set([
    APP_BUNDLE_MANIFEST_NAME,
    APP_BUNDLE_DESCRIPTOR_NAME,
    APP_BUNDLE_RELEASE_PATH
]);

function fail(message,code='ARCANE_BUNDLE_INVALID',details){
    throw new ArcaneError(code,message,{details});
}

async function emit(onEvent,event){
    if(typeof onEvent==='function')await onEvent(event);
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

function isPlainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function copyJson(value){
    return JSON.parse(JSON.stringify(value));
}

function pathKey(value){
    return value.normalize('NFC').toLocaleLowerCase('en-US');
}

export function validateAppBundlePath(value,label='bundle path'){
    if(typeof value!=='string'||!value||value!==value.normalize('NFC')
        ||value.includes('\\')||value.startsWith('/')||/^[a-z]:/iu.test(value)
        ||/[\u0000-\u001f\u007f]/u.test(value)){
        fail(`Unsafe ${label}: ${String(value)}.`);
    }
    const segments=value.split('/');
    for(const segment of segments){
        if(!segment||segment==='.'||segment==='..'||segment.endsWith('.')||segment.endsWith(' ')
            ||segment.includes(':')||WINDOWS_UNSAFE_FILENAME_CHARACTER_PATTERN.test(segment)
            ||WINDOWS_RESERVED_PATTERN.test(segment)){
            fail(`Unsafe ${label}: ${value}.`);
        }
    }
    return segments.join('/');
}

function splitUstarPath(archivePath){
    const normalized=validateAppBundlePath(archivePath,'archive path');
    if(Buffer.byteLength(normalized,'utf8')<=100)return {name:normalized,prefix:''};
    const segments=normalized.split('/');
    for(let index=segments.length-1;index>0;index-=1){
        const prefix=segments.slice(0,index).join('/');
        const name=segments.slice(index).join('/');
        if(Buffer.byteLength(prefix,'utf8')<=155&&Buffer.byteLength(name,'utf8')<=100){
            return {name,prefix};
        }
    }
    fail(`Archive path cannot be represented by ustar: ${normalized}.`);
}

function writeTextField(header,offset,length,value,label){
    const encoded=Buffer.from(String(value),'utf8');
    if(encoded.length>length)fail(`${label} does not fit its ustar field.`);
    encoded.copy(header,offset);
}

function writeOctalField(header,offset,length,value,label,{trailingSpace=false}={}){
    if(!Number.isSafeInteger(value)||value<0)fail(`${label} must be a nonnegative integer.`);
    const terminal=trailingSpace?'\0 ':'\0';
    const digits=value.toString(8);
    const available=length-terminal.length;
    if(digits.length>available)fail(`${label} does not fit its ustar field.`);
    const rendered=`${digits.padStart(available,'0')}${terminal}`;
    header.write(rendered,offset,length,'ascii');
}

export function createCanonicalUstarHeader(archivePath,size){
    const {name,prefix}=splitUstarPath(archivePath);
    const header=Buffer.alloc(TAR_BLOCK_SIZE);
    writeTextField(header,0,100,name,'ustar name');
    writeOctalField(header,100,8,ARCHIVE_MODE,'ustar mode');
    writeOctalField(header,108,8,0,'ustar uid');
    writeOctalField(header,116,8,0,'ustar gid');
    writeOctalField(header,124,12,size,'ustar size');
    writeOctalField(header,136,12,0,'ustar mtime');
    header.fill(0x20,148,156);
    header[156]=0x30;
    header.write('ustar\0',257,6,'ascii');
    header.write('00',263,2,'ascii');
    writeTextField(header,265,32,'root','ustar owner');
    writeTextField(header,297,32,'root','ustar group');
    writeTextField(header,345,155,prefix,'ustar prefix');
    let checksum=0;
    for(const value of header)checksum+=value;
    writeOctalField(header,148,8,checksum,'ustar checksum',{trailingSpace:true});
    return header;
}

function tarEntry(archivePath,content){
    const header=createCanonicalUstarHeader(archivePath,content.length);
    const remainder=content.length%TAR_BLOCK_SIZE;
    const padding=remainder===0?Buffer.alloc(0):Buffer.alloc(TAR_BLOCK_SIZE-remainder);
    return Buffer.concat([header,content,padding]);
}

async function realDirectory(location,label){
    const requested=path.resolve(location);
    let info;
    try{info=await lstat(requested);}
    catch(error){
        if(error?.code==='ENOENT')fail(`${label} does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory())fail(`${label} must be a real directory.`);
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical);
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()){
        fail(`${label} must be a real directory.`);
    }
    return canonical;
}

async function listReleaseFiles(releaseRoot,{signal}={}){
    const files=[];
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            validateAppBundlePath(relative,'release path');
            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink())fail(`Release contains a symbolic link: ${relative}.`);
            if(info.isDirectory())await visit(absolute,relative);
            else if(info.isFile())files.push({path:relative,absolute});
            else fail(`Release contains a non-file entry: ${relative}.`);
        }
    }
    await visit(releaseRoot);
    return files.sort((left,right)=>compareText(left.path,right.path));
}

function readJsonContent(content,label){
    try{return JSON.parse(content.toString('utf8'));}
    catch(error){fail(`${label} is not valid JSON: ${error.message}.`);}
}

function validateReleaseManifest(value){
    if(!isPlainObject(value)||value.schemaVersion!==1||value.kind!=='arcane-app-release'
        ||value.packagerVersion!==PACKAGER_VERSION||!isPlainObject(value.app)
        ||typeof value.app.id!=='string'||typeof value.app.version!=='string'
        ||!Array.isArray(value.files)){
        fail(`${RELEASE_MANIFEST_NAME} is malformed.`);
    }
    parseSemver(value.app.version);
    const files=value.files.map((entry,index)=>validateAppBundlePath(
        entry,
        `${RELEASE_MANIFEST_NAME}.files[${index}]`
    )).sort(compareText);
    if(new Set(files.map(pathKey)).size!==files.length){
        fail(`${RELEASE_MANIFEST_NAME} contains duplicate files.`);
    }
    return {...copyJson(value),files};
}

function bundleManifest(descriptor,release,files){
    return {
        schemaVersion:APP_BUNDLE_SCHEMA_VERSION,
        kind:APP_BUNDLE_KIND,
        format:APP_BUNDLE_FORMAT,
        sdk:{name:SDK_NAME,version:SDK_VERSION},
        app:{id:descriptor.id,version:descriptor.version},
        descriptor:APP_BUNDLE_DESCRIPTOR_NAME,
        release:APP_BUNDLE_RELEASE_PATH,
        files:[...files]
    };
}

async function outputBoundary(outputPath,overwrite){
    if(typeof outputPath!=='string'||!outputPath.trim())fail('outputPath is required.');
    if(typeof overwrite!=='boolean')fail('overwrite must be a boolean.',ERROR_CODES.usage);
    const resolved=path.resolve(outputPath);
    await mkdir(path.dirname(resolved),{recursive:true});
    const parent=await realDirectory(path.dirname(resolved),'Bundle output directory');
    const selected=path.join(parent,path.basename(resolved));
    try{
        const info=await lstat(selected);
        if(info.isSymbolicLink()||!info.isFile())fail('Existing bundle output must be a real file.');
        if(!overwrite)fail(`Bundle output already exists: ${selected}.`,ERROR_CODES.usage);
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
    }
    return selected;
}

async function writeBundle(outputPath,content,{overwrite}){
    const temporary=`${outputPath}.staging-${process.pid}-${Date.now()}`;
    await writeFile(temporary,content,{flag:'wx'});
    try{
        if(overwrite)await rm(outputPath,{force:true});
        await rename(temporary,outputPath);
    }catch(error){
        await rm(temporary,{force:true}).catch(()=>{});
        throw error;
    }
}

export async function createAppReleaseBundle({
    releaseRoot,
    appDescriptor,
    outputPath,
    overwrite=false,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const canonicalReleaseRoot=await realDirectory(releaseRoot,'App release root');
    const files=await listReleaseFiles(canonicalReleaseRoot,{signal});
    const releaseFile=files.find(file=>pathKey(file.path)===pathKey(RELEASE_MANIFEST_NAME));
    if(!releaseFile)fail(`App release is missing ${RELEASE_MANIFEST_NAME}.`);
    const release=validateReleaseManifest(readJsonContent(
        await readFile(releaseFile.absolute),
        RELEASE_MANIFEST_NAME
    ));
    const descriptor=copyJson(validateAppDescriptor(copyJson(appDescriptor),{appId:release.app.id}));
    if(descriptor.version!==release.app.version){
        fail('App descriptor and release manifest versions differ.');
    }
    const payloadPaths=files.map(file=>`payload/${file.path}`);
    const manifest=bundleManifest(descriptor,release,payloadPaths);
    const entries=[
        tarEntry(APP_BUNDLE_MANIFEST_NAME,Buffer.from(`${JSON.stringify(manifest,null,2)}\n`,'utf8')),
        tarEntry(APP_BUNDLE_DESCRIPTOR_NAME,Buffer.from(`${JSON.stringify(descriptor,null,2)}\n`,'utf8'))
    ];
    for(const file of files){
        throwIfAborted(signal);
        entries.push(tarEntry(`payload/${file.path}`,await readFile(file.absolute)));
    }
    entries.push(Buffer.alloc(TAR_END_SIZE));
    const output=await outputBoundary(outputPath,overwrite);
    await writeBundle(output,gzipSync(Buffer.concat(entries),{mtime:0}),{overwrite});
    await emit(onEvent,{
        type:'bundle.completed',
        phase:'publish',
        status:'completed',
        bundlePath:output,
        files:[...manifest.files]
    });
    return {
        bundlePath:output,
        manifest:copyJson(manifest),
        descriptor:copyJson(descriptor),
        release:copyJson(release),
        files:[...manifest.files]
    };
}

function readStringField(header,offset,length){
    const end=header.indexOf(0,offset);
    const selectedEnd=end<0||end>offset+length?offset+length:end;
    return header.subarray(offset,selectedEnd).toString('utf8');
}

function readOctalField(header,offset,length,label){
    const text=header.subarray(offset,offset+length).toString('ascii').replace(/[\0 ]+$/u,'');
    if(!/^[0-7]+$/u.test(text))fail(`${label} is not a valid ustar octal field.`);
    const value=Number.parseInt(text,8);
    if(!Number.isSafeInteger(value))fail(`${label} exceeds the supported integer range.`);
    return value;
}

function readTarEntries(archive){
    const entries=new Map();
    let offset=0;
    while(offset+TAR_BLOCK_SIZE<=archive.length){
        const header=archive.subarray(offset,offset+TAR_BLOCK_SIZE);
        if(header.every(value=>value===0))break;
        if(readStringField(header,257,6)!=='ustar')fail('Bundle is not a ustar archive.');
        const expectedChecksum=readOctalField(header,148,8,'ustar checksum');
        const checksumHeader=Buffer.from(header);
        checksumHeader.fill(0x20,148,156);
        let actualChecksum=0;
        for(const value of checksumHeader)actualChecksum+=value;
        if(actualChecksum!==expectedChecksum)fail('Bundle contains a malformed ustar header.');
        if(header[156]!==0&&header[156]!==0x30)fail('Bundle contains a non-file archive entry.');
        const name=readStringField(header,0,100);
        const prefix=readStringField(header,345,155);
        const archivePath=validateAppBundlePath(prefix?`${prefix}/${name}`:name,'archive path');
        if(entries.has(pathKey(archivePath)))fail(`Bundle contains a duplicate path: ${archivePath}.`);
        const size=readOctalField(header,124,12,'ustar size');
        const contentStart=offset+TAR_BLOCK_SIZE;
        const contentEnd=contentStart+size;
        if(contentEnd>archive.length)fail(`Bundle entry is incomplete: ${archivePath}.`);
        entries.set(pathKey(archivePath),{
            path:archivePath,
            content:Buffer.from(archive.subarray(contentStart,contentEnd))
        });
        offset=contentStart+Math.ceil(size/TAR_BLOCK_SIZE)*TAR_BLOCK_SIZE;
    }
    return entries;
}

function requiredEntry(entries,entryPath){
    const entry=entries.get(pathKey(entryPath));
    if(!entry)fail(`Bundle is missing ${entryPath}.`);
    return entry;
}

export async function verifyAppReleaseBundle({bundlePath,signal,onEvent}={}){
    throwIfAborted(signal);
    if(typeof bundlePath!=='string'||!bundlePath.trim())fail('bundlePath is required.');
    const selected=path.resolve(bundlePath);
    const info=await lstat(selected);
    if(info.isSymbolicLink()||!info.isFile())fail('Bundle path must be a real file.');
    let archive;
    try{archive=gunzipSync(await readFile(selected));}
    catch(error){fail(`Bundle is not valid gzip data: ${error.message}.`);}
    const entries=readTarEntries(archive);
    const manifest=readJsonContent(
        requiredEntry(entries,APP_BUNDLE_MANIFEST_NAME).content,
        APP_BUNDLE_MANIFEST_NAME
    );
    if(!isPlainObject(manifest)||manifest.schemaVersion!==APP_BUNDLE_SCHEMA_VERSION
        ||manifest.kind!==APP_BUNDLE_KIND||manifest.format!==APP_BUNDLE_FORMAT
        ||manifest.sdk?.name!==SDK_NAME||manifest.sdk?.version!==SDK_VERSION
        ||manifest.descriptor!==APP_BUNDLE_DESCRIPTOR_NAME
        ||manifest.release!==APP_BUNDLE_RELEASE_PATH||!Array.isArray(manifest.files)){
        fail(`${APP_BUNDLE_MANIFEST_NAME} is malformed.`);
    }
    const descriptor=copyJson(validateAppDescriptor(readJsonContent(
        requiredEntry(entries,APP_BUNDLE_DESCRIPTOR_NAME).content,
        APP_BUNDLE_DESCRIPTOR_NAME
    ),{appId:manifest.app?.id}));
    const release=validateReleaseManifest(readJsonContent(
        requiredEntry(entries,APP_BUNDLE_RELEASE_PATH).content,
        APP_BUNDLE_RELEASE_PATH
    ));
    if(descriptor.id!==manifest.app.id||descriptor.version!==manifest.app.version
        ||release.app.id!==manifest.app.id||release.app.version!==manifest.app.version){
        fail('Bundle control records describe different applications.');
    }
    const declared=manifest.files.map((entry,index)=>validateAppBundlePath(
        entry,
        `${APP_BUNDLE_MANIFEST_NAME}.files[${index}]`
    )).sort(compareText);
    const actual=[...entries.values()]
        .map(entry=>entry.path)
        .filter(entry=>!CONTROL_PATHS.has(entry))
        .concat(APP_BUNDLE_RELEASE_PATH)
        .sort(compareText);
    if(JSON.stringify(declared)!==JSON.stringify(actual)){
        fail('Bundle payload inventory differs from its manifest.');
    }
    const releasePayload=declared
        .filter(entry=>entry!==APP_BUNDLE_RELEASE_PATH)
        .map(entry=>entry.slice('payload/'.length))
        .sort(compareText);
    if(JSON.stringify(releasePayload)!==JSON.stringify([...release.files].sort(compareText))){
        fail('Bundled release files differ from the release manifest.');
    }
    await emit(onEvent,{type:'bundle.inspected',bundlePath:selected,files:[...declared]});
    return {
        verified:true,
        bundlePath:selected,
        manifest:copyJson(manifest),
        descriptor:copyJson(descriptor),
        release:copyJson(release),
        files:[...declared],
        readFile(relativePath){
            const normalized=validateAppBundlePath(relativePath,'bundle file path');
            return Buffer.from(requiredEntry(entries,normalized).content);
        }
    };
}
