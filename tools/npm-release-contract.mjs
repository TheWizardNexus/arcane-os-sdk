import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {gunzip} from 'node:zlib';

const gunzipAsync=promisify(gunzip);
const PACKAGE_NAME='arcane-os';
const VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const ROOT_PACKAGE_FILES=new Set([
    'CHANGELOG.md','COMMERCIAL-LICENSE.md','LICENSE','NOTICE','README.md','package.json'
]);
const PACKAGE_PREFIXES=[
    'bin/','browser-runtime/','node_modules/event-pubsub/','node_modules/strong-type/',
    'runtime/','schemas/','src/'
];
const REQUIRED_PACKAGE_FILES=[
    'CHANGELOG.md','COMMERCIAL-LICENSE.md','LICENSE','NOTICE','README.md',
    'bin/arcane-test.mjs','bin/arcane.mjs','package.json','src/index.mjs','src/testing.mjs'
];

function fail(message){
    throw new Error(`ARCANE_NPM_RELEASE_INVALID: ${message}`);
}

function tarText(buffer,start,length){
    const field=buffer.subarray(start,start+length);
    const end=field.indexOf(0);
    return field.subarray(0,end===-1?field.length:end).toString('utf8').trim();
}

function tarInteger(buffer,start,length,label){
    const field=buffer.subarray(start,start+length);
    if((field[0]&0x80)!==0){
        let value=BigInt(field[0]&0x7f);
        for(let index=1;index<field.length;index+=1)value=(value<<8n)|BigInt(field[index]);
        if(value>BigInt(Number.MAX_SAFE_INTEGER))fail(`${label} cannot be represented by Node.js.`);
        return Number(value);
    }
    const source=field.toString('ascii').replace(/\0.*$/u,'').trim();
    if(source==='')return 0;
    if(!/^[0-7]+$/u.test(source))fail(`${label} is not valid tar framing.`);
    const value=Number.parseInt(source,8);
    if(!Number.isSafeInteger(value))fail(`${label} cannot be represented by Node.js.`);
    return value;
}

function paxFields(data){
    const fields={};
    let offset=0;
    while(offset<data.length){
        const space=data.indexOf(0x20,offset);
        if(space===-1)fail('Extended tar header is malformed.');
        const recordLength=Number.parseInt(data.subarray(offset,space).toString('ascii'),10);
        if(!Number.isSafeInteger(recordLength)||recordLength<1||offset+recordLength>data.length){
            fail('Extended tar header has invalid framing.');
        }
        const record=data.subarray(space+1,offset+recordLength-1).toString('utf8');
        const separator=record.indexOf('=');
        if(separator>0)fields[record.slice(0,separator)]=record.slice(separator+1);
        offset+=recordLength;
    }
    return fields;
}

function normalizedPackagePath(value){
    if(typeof value!=='string'||!value.startsWith('package/')||value.includes('\\')
        ||value.includes('\0')){
        fail(`Packed path is outside the npm package root: ${value}.`);
    }
    const relative=value.slice('package/'.length).replace(/\/$/u,'');
    const segments=relative.split('/');
    if(relative===''||segments.some(segment=>segment===''||segment==='.'||segment==='..')){
        fail(`Packed path is outside the npm package boundary: ${value}.`);
    }
    return relative;
}

function allowedPackagePath(relative){
    return ROOT_PACKAGE_FILES.has(relative)
        ||PACKAGE_PREFIXES.some(prefix=>relative.startsWith(prefix)||relative===prefix.slice(0,-1));
}

function parseTarArchive(archive){
    const files=[];
    const seen=new Set();
    let packageDocument=null;
    let extended={};
    let longPath=null;
    let offset=0;

    while(offset+512<=archive.length){
        const header=archive.subarray(offset,offset+512);
        if(header.every(value=>value===0))break;
        const storedName=tarText(header,0,100);
        const prefix=tarText(header,345,155);
        const type=String.fromCharCode(header[156]||0);
        const contentLength=tarInteger(header,124,12,'Tar entry length');
        const contentStart=offset+512;
        const contentEnd=contentStart+contentLength;
        if(contentEnd>archive.length)fail('Tar entry extends beyond the archive.');
        const content=archive.subarray(contentStart,contentEnd);
        offset=contentStart+(Math.ceil(contentLength/512)*512);

        if(type==='x'||type==='g'){
            extended={...extended,...paxFields(content)};
            continue;
        }
        if(type==='L'){
            longPath=content.toString('utf8').replace(/\0.*$/u,'');
            continue;
        }

        const headerPath=prefix===''?storedName:`${prefix}/${storedName}`;
        const packedPath=extended.path??longPath??headerPath;
        extended={};
        longPath=null;
        const relative=normalizedPackagePath(packedPath);
        if(!allowedPackagePath(relative)){
            fail(`Packed path is outside the published package boundary: ${relative}.`);
        }
        if(type==='5')continue;
        if(seen.has(relative))fail(`Packed path appears more than once: ${relative}.`);
        seen.add(relative);
        files.push(relative);
        if(relative==='package.json'){
            try{
                packageDocument=JSON.parse(content.toString('utf8'));
            }catch(error){
                fail(`Packed package.json is malformed: ${error.message}`);
            }
        }
    }

    for(const required of REQUIRED_PACKAGE_FILES){
        if(!seen.has(required))fail(`Required npm package file is missing: ${required}.`);
    }
    return {files,packageDocument};
}

export async function verifyNpmReleaseArtifact({tarballPath,expectedVersion=null}){
    if(typeof tarballPath!=='string'||tarballPath==='')fail('A release tarball path is required.');
    const resolvedTarball=path.resolve(tarballPath);
    let archive;
    try{
        archive=await gunzipAsync(await readFile(resolvedTarball));
    }catch(error){
        fail(`Release tarball cannot be read: ${error.message}`);
    }
    const {files,packageDocument}=parseTarArchive(archive);
    if(packageDocument===null||typeof packageDocument!=='object'||Array.isArray(packageDocument)){
        fail('Packed package.json must contain one JSON object.');
    }
    if(packageDocument.name!==PACKAGE_NAME)fail(`Packed package name must be ${PACKAGE_NAME}.`);
    if(typeof packageDocument.version!=='string'||!VERSION_PATTERN.test(packageDocument.version)){
        fail(`Packed package version is invalid: ${packageDocument.version}.`);
    }
    if(expectedVersion!==null&&packageDocument.version!==expectedVersion){
        fail(`Packed package version ${packageDocument.version} does not equal ${expectedVersion}.`);
    }
    return {version:packageDocument.version,packageDocument,paths:files,tarballPath:resolvedTarball};
}
