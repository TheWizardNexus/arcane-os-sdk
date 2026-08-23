import {createHash} from 'node:crypto';
import {lstat,readFile} from 'node:fs/promises';
import path from 'node:path';

export const NPM_RELEASE_SCHEMA_VERSION=1;
export const NPM_RELEASE_KIND='arcane-sdk-npm-release';
export const NPM_RELEASE_MAX_TARBALL_BYTES=256*1024*1024;
export const NPM_RELEASE_NODE_VERSION='26.7.0';
export const NPM_RELEASE_NPM_VERSION='11.19.0';

const CANONICAL_REPOSITORY='https://github.com/TheWizardNexus/arcane-os-sdk';
const SHA1_PATTERN=/^[0-9a-f]{40}$/u;
const SHA256_PATTERN=/^[0-9a-f]{64}$/u;
const VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const REQUIRED_PACKAGE_FILES=Object.freeze([
    'LICENSE',
    'NOTICE',
    'bin/arcane-test.mjs',
    'bin/arcane.mjs',
    'package.json',
    'src/testing.mjs'
]);

function fail(message){
    throw new Error(`ARCANE_NPM_RELEASE_INVALID: ${message}`);
}

function isPlainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function exactKeys(value,expected,label){
    if(!isPlainObject(value))fail(`${label} must be a plain object.`);
    const keys=Object.keys(value);
    if(keys.length!==expected.length||keys.some((key,index)=>key!==expected[index])){
        fail(`${label} must contain exactly these ordered fields: ${expected.join(', ')}.`);
    }
}

function positiveInteger(value,label){
    if(!Number.isSafeInteger(value)||value<1)fail(`${label} must be a positive safe integer.`);
}

function nonnegativeInteger(value,label){
    if(!Number.isSafeInteger(value)||value<0)fail(`${label} must be a nonnegative safe integer.`);
}

function portablePackagePath(value){
    if(typeof value!=='string'||value===''||value.includes('\\')||value.startsWith('/')
        ||value.endsWith('/')||value.includes('\0'))return false;
    const segments=value.split('/');
    return segments.every(segment=>segment!==''&&segment!=='.'&&segment!=='..');
}

function canonicalJson(value){
    return `${JSON.stringify(value,null,2)}\n`;
}

function canonicalBase64(value){
    if(typeof value!=='string'||value==='')return false;
    const bytes=Buffer.from(value,'base64');
    return bytes.length===64&&bytes.toString('base64')===value;
}

function validateManifest(manifest){
    exactKeys(
        manifest,
        ['schemaVersion','kind','name','version','source','artifact','package','toolchain'],
        'Release manifest'
    );
    if(manifest.schemaVersion!==NPM_RELEASE_SCHEMA_VERSION){
        fail(`Unsupported schema version: ${manifest.schemaVersion}.`);
    }
    if(manifest.kind!==NPM_RELEASE_KIND||manifest.name!=='arcane-os'){
        fail('Release manifest identity is not the Arcane OS SDK npm artifact.');
    }
    if(typeof manifest.version!=='string'||!VERSION_PATTERN.test(manifest.version)){
        fail(`Invalid package version: ${manifest.version}.`);
    }

    exactKeys(manifest.source,['repository','commit','clean'],'Release source');
    if(manifest.source.repository!==CANONICAL_REPOSITORY){
        fail(`Unexpected source repository: ${manifest.source.repository}.`);
    }
    if(typeof manifest.source.commit!=='string'||!/^[0-9a-f]{40}$/u.test(manifest.source.commit)){
        fail('Release source commit must be one lowercase 40-character Git SHA.');
    }
    if(typeof manifest.source.clean!=='boolean')fail('Release source clean must be boolean.');

    exactKeys(
        manifest.artifact,
        ['file','bytes','sha256','integrity','shasum'],
        'Release artifact'
    );
    const expectedFilename=`arcane-os-${manifest.version}.tgz`;
    if(manifest.artifact.file!==expectedFilename){
        fail(`Release artifact filename must be ${expectedFilename}.`);
    }
    positiveInteger(manifest.artifact.bytes,'Release artifact bytes');
    if(manifest.artifact.bytes>NPM_RELEASE_MAX_TARBALL_BYTES){
        fail(`Release artifact exceeds ${NPM_RELEASE_MAX_TARBALL_BYTES} bytes.`);
    }
    if(typeof manifest.artifact.sha256!=='string'||!SHA256_PATTERN.test(manifest.artifact.sha256)){
        fail('Release artifact SHA-256 is invalid.');
    }
    if(typeof manifest.artifact.shasum!=='string'||!SHA1_PATTERN.test(manifest.artifact.shasum)){
        fail('Release artifact npm shasum is invalid.');
    }
    if(typeof manifest.artifact.integrity!=='string'
        ||!manifest.artifact.integrity.startsWith('sha512-')
        ||!canonicalBase64(manifest.artifact.integrity.slice('sha512-'.length))){
        fail('Release artifact npm SHA-512 integrity is invalid.');
    }

    exactKeys(
        manifest.package,
        ['entryCount','unpackedBytes','files'],
        'Packed package inventory'
    );
    positiveInteger(manifest.package.entryCount,'Packed package entry count');
    positiveInteger(manifest.package.unpackedBytes,'Packed package unpacked bytes');
    if(!Array.isArray(manifest.package.files)
        ||manifest.package.files.length!==manifest.package.entryCount){
        fail('Packed package files must match the declared entry count.');
    }
    const seen=new Set();
    let previous='';
    let totalBytes=0;
    for(const [index,file] of manifest.package.files.entries()){
        exactKeys(file,['path','bytes'],`Packed package file ${index}`);
        if(!portablePackagePath(file.path))fail(`Unsafe packed package path: ${file.path}.`);
        if(seen.has(file.path))fail(`Duplicate packed package path: ${file.path}.`);
        if(previous!==''&&previous.localeCompare(file.path,'en')>=0){
            fail('Packed package file inventory must be strictly sorted.');
        }
        nonnegativeInteger(file.bytes,`Packed package file bytes for ${file.path}`);
        if(file.path.startsWith('.github/')||file.path.startsWith('test/')){
            fail(`Private repository path leaked into the npm package: ${file.path}.`);
        }
        seen.add(file.path);
        previous=file.path;
        totalBytes+=file.bytes;
    }
    if(totalBytes!==manifest.package.unpackedBytes){
        fail('Packed package file sizes do not equal the declared unpacked byte count.');
    }
    for(const required of REQUIRED_PACKAGE_FILES){
        if(!seen.has(required))fail(`Required npm package file is missing: ${required}.`);
    }

    exactKeys(manifest.toolchain,['node','npm'],'Release toolchain');
    if(manifest.toolchain.node!==NPM_RELEASE_NODE_VERSION
        ||manifest.toolchain.npm!==NPM_RELEASE_NPM_VERSION){
        fail(
            `Release toolchain must be Node ${NPM_RELEASE_NODE_VERSION} `+
            `with npm ${NPM_RELEASE_NPM_VERSION}.`
        );
    }
    return manifest;
}

export function parseNpmReleaseManifest(bytes){
    const source=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);
    if(source.length<2||source.length>4*1024*1024){
        fail('Release manifest must be between 2 bytes and 4 MiB.');
    }
    let manifest;
    try{
        manifest=JSON.parse(source.toString('utf8'));
    }catch(error){
        fail(`Release manifest is not valid JSON: ${error.message}`);
    }
    validateManifest(manifest);
    if(!source.equals(Buffer.from(canonicalJson(manifest)))){
        fail('Release manifest JSON is not canonical.');
    }
    return Object.freeze(manifest);
}

async function readStableRegularFile(filePath,{maximumBytes,label}){
    const before=await lstat(filePath,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n){
        fail(`${label} must be one regular single-link file.`);
    }
    if(before.size<1n||before.size>BigInt(maximumBytes)){
        fail(`${label} has an unsupported byte length: ${before.size}.`);
    }
    const bytes=await readFile(filePath);
    const after=await lstat(filePath,{bigint:true});
    if(after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size
        ||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs
        ||after.nlink!==1n||bytes.length!==Number(before.size)){
        fail(`${label} changed while it was read.`);
    }
    return bytes;
}

function digest(bytes,algorithm,encoding='hex'){
    return createHash(algorithm).update(bytes).digest(encoding);
}

export async function verifyNpmReleaseArtifact({metadataPath,tarballPath,requireCleanSource=false}){
    const resolvedMetadata=path.resolve(metadataPath);
    const manifest=parseNpmReleaseManifest(await readStableRegularFile(resolvedMetadata,{
        maximumBytes:4*1024*1024,
        label:'npm release manifest'
    }));
    if(requireCleanSource&&!manifest.source.clean){
        fail('Release artifact was not built from a clean source checkout.');
    }
    const resolvedTarball=path.resolve(
        tarballPath??path.join(path.dirname(resolvedMetadata),manifest.artifact.file)
    );
    if(path.basename(resolvedTarball)!==manifest.artifact.file){
        fail('Release tarball filename does not match its manifest.');
    }
    const bytes=await readStableRegularFile(resolvedTarball,{
        maximumBytes:NPM_RELEASE_MAX_TARBALL_BYTES,
        label:'npm release tarball'
    });
    const actual={
        bytes:bytes.length,
        sha256:digest(bytes,'sha256'),
        integrity:`sha512-${digest(bytes,'sha512','base64')}`,
        shasum:digest(bytes,'sha1')
    };
    for(const [field,value] of Object.entries(actual)){
        if(value!==manifest.artifact[field]){
            fail(`Release tarball ${field} does not match its manifest.`);
        }
    }
    const checksumPath=`${resolvedTarball}.sha256`;
    const checksumBytes=await readStableRegularFile(checksumPath,{
        maximumBytes:256,
        label:'npm release checksum'
    });
    const expectedChecksum=`${manifest.artifact.sha256}  ${manifest.artifact.file}\n`;
    if(!checksumBytes.equals(Buffer.from(expectedChecksum))){
        fail('Release tarball checksum sidecar does not match its manifest.');
    }
    return Object.freeze({manifest,tarballPath:resolvedTarball,checksumPath});
}
