import {createHash} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,readdir,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SDK_VERSION} from './constants.mjs';

const MANIFEST_NAME='ARCANE_SDK_BROWSER_RELEASE.json';
const BUILDER='arcane-sdk-browser-runtime-v1';
const PROTOCOL='arcane-sdk-browser-runtime/1';
export const SDK_BROWSER_RUNTIME_MANIFEST_SHA256=
    '7ccba55d470bba1813c90106718c1f78be40c3cdc6e5f05a7f6963d79c8bd7a1';
export const SDK_BROWSER_RUNTIME_CONTENT_SHA256=
    '7094080260359caf25ac748d4b80ce96a1ba88c07f24e68b3d3c326a8fef1df7';
const REPOSITORY='https://github.com/TheWizardNexus/arcane-os-sdk.git';
const SHA256_PATTERN=/^[a-f0-9]{64}$/u;
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const MAX_VERIFIED_FILE_BYTES=64*1024*1024;
const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const defaultRoot=path.join(packageRoot,'browser-runtime');
const issuedReceipts=new WeakSet();
const expectedAiComponents=Object.freeze({
    schemaVersion:1,
    kind:'arcane-ai-browser-wasm-components',
    protocol:'arcane-ai-browser-wasm/2',
    packageExport:'arcane-os/ai/browser-wasm',
    browserEntry:'ai/browser-wasm.mjs',
    runtimePolicy:{
        modelAuthorities:'fieldwise-security-default-false-with-optional-byteLength-and-sha256-checks',
        modelWeightsPacked:false,
        remoteModelHelpers:false,
        compatibilityRuntime:false,
        webgpuAdmission:'adapter-plus-full-offload-plus-buffer-queue-and-settled-fence-evidence',
        cpuFallback:false,
        cancellation:'abortSignal-plus-llama-cancel-acknowledgement',
        cleanup:'worker-termination-only-no-native-unload-claim',
        toolCalls:'structural-only-never-executed'
    },
    components:[
        {
            name:'@wllama/wllama',
            version:'3.6.0',
            licenseSpdx:'MIT',
            sourceRepository:'https://github.com/ngxson/wllama.git',
            sourceRevision:'f16050d8d51a00602c6a2a6b8ac9c09f490eea7f',
            npm:{
                resolved:'https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz',
                integrity:'sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w==',
                tarballBytes:5671369,
                tarballSha256:'137c35ceccb4911a9b0ce9b427889f75991654ec6a6d1dd8fabd879b14b07a1b'
            },
            files:[
                {
                    role:'runtime-module',
                    path:'ai/wllama/index.mjs',
                    sourcePath:'browser-runtime/ai/wllama/index.mjs',
                    bytes:389765,
                    sha256:'ae9a6ba2aa8687785ed651e28ef92573b409d5e6d3470bfd53340225287908b8',
                    projection:{
                        protocol:'arcane-wllama-webgpu-evidence/1',
                        inputPath:'node_modules/@wllama/wllama/esm/index.js',
                        inputBytes:373519,
                        inputSha256:'4637e42d636010493a9b274fbbe70bfd8120365da726b1d9e589d85ca84a00d6',
                        wasmModified:false
                    }
                },
                {
                    role:'runtime-wasm',
                    path:'ai/wllama/wllama.wasm',
                    sourcePath:'node_modules/@wllama/wllama/esm/wasm/wllama.wasm',
                    bytes:8524865,
                    sha256:'95c6ff9ef2a03ff2c63bc91db132f0126a0bd0456b272cd8ae2e0f592fb059f6'
                },
                {
                    role:'license',
                    path:'ai/wllama/LICENCE',
                    sourcePath:'node_modules/@wllama/wllama/LICENCE',
                    bytes:1071,
                    sha256:'5866e3bd7e3cbd3f7c8bea6efd8a1e7fa7cc8de68c30f428aff7c6584a0fb720'
                }
            ]
        },
        {
            name:'llama.cpp',
            version:'b10454',
            licenseSpdx:'MIT',
            sourceRepository:'https://github.com/ggerganov/llama.cpp.git',
            sourceRevision:'4df29be4f4c3673f428170fda944a5b19f743bb8',
            embeddedBy:'@wllama/wllama@3.6.0',
            files:[
                {
                    role:'license',
                    path:'ai/wllama/llama.cpp-LICENSE',
                    sourceUrl:'https://raw.githubusercontent.com/ggerganov/llama.cpp/4df29be4f4c3673f428170fda944a5b19f743bb8/LICENSE',
                    bytes:1078,
                    sha256:'94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d'
                }
            ]
        }
    ]
});

const expectedFiles=Object.freeze([
    ['ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json','browser-runtime/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json','sdk-source-identity'],
    ['ai/browser-wasm-llm-provider.mjs','browser-runtime/ai/browser-wasm-llm-provider.mjs','sdk-source-identity'],
    ['ai/browser-wasm.mjs','browser-runtime/ai/browser-wasm.mjs','sdk-source-identity'],
    ['ai/browser-wllama-runtime.mjs','browser-runtime/ai/browser-wllama-runtime.mjs','sdk-source-identity'],
    ['ai/internal/sha256.mjs','browser-runtime/ai/internal/sha256.mjs','sdk-source-identity'],
    ['ai/model-controller.mjs','browser-runtime/ai/model-controller.mjs','sdk-source-identity'],
    ['ai/wllama/LICENCE','node_modules/@wllama/wllama/LICENCE','vendor-package-identity'],
    ['ai/wllama/index.mjs','browser-runtime/ai/wllama/index.mjs','deterministic-derived-vendor'],
    ['ai/wllama/llama.cpp-LICENSE','browser-runtime/ai/wllama/llama.cpp-LICENSE','vendor-source-identity'],
    ['ai/wllama/wllama.wasm','node_modules/@wllama/wllama/esm/wasm/wllama.wasm','vendor-package-identity'],
    ['dependencies/event-pubsub/index.js','node_modules/event-pubsub/index.js','vendor-package-identity'],
    ['dependencies/event-pubsub/licence','node_modules/event-pubsub/licence','vendor-package-identity'],
    ['dependencies/event-pubsub/package.json','node_modules/event-pubsub/package.json','vendor-package-identity'],
    ['dependencies/strong-type/index.js','node_modules/strong-type/index.js','vendor-package-identity'],
    ['dependencies/strong-type/licence','node_modules/strong-type/licence','vendor-package-identity'],
    ['dependencies/strong-type/package.json','node_modules/strong-type/package.json','vendor-package-identity'],
    ['dom-event-instrumentation.mjs','src/dom-event-instrumentation.mjs','sdk-source-identity'],
    ['event-manager.mjs','src/event-manager.mjs','sdk-source-identity']
].map(([filePath,sourcePath,provenance])=>Object.freeze({
    path:filePath,sourcePath,provenance
})));

const expectedDirectories=Object.freeze([...new Set(expectedFiles.flatMap(file=>{
    const segments=file.path.split('/');
    return segments.slice(0,-1).map((_,index)=>segments.slice(0,index+1).join('/'));
}))].sort(compareText));

function fail(message,code='ARCANE_SDK_BROWSER_INTEGRITY_FAILED'){
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

function exactKeys(value,keys){
    return Object.keys(value).sort(compareText).join('\0')===[...keys].sort(compareText).join('\0');
}

function safeInventoryPath(value,label='manifest'){
    if(typeof value!=='string'||!value||value.includes('\\')||value.includes('\0')
        ||value.normalize('NFC')!==value||path.posix.isAbsolute(value)
        ||path.posix.normalize(value)!==value||value==='.'||value.startsWith('../')
        ||value.includes('/../')){
        fail(`SDK browser runtime ${label} contains an unsafe path: ${String(value)}.`);
    }
    return value;
}

function collisionKey(value){
    return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function immutableInventory(files){
    return Object.freeze(files.map(file=>Object.freeze({...file})));
}

function validateAiComponents(bytes,releaseFiles){
    let receipt;
    try{receipt=JSON.parse(bytes.toString('utf8'));}
    catch(error){fail(`Arcane AI browser WASM component receipt is invalid JSON: ${error.message}`);}
    if(JSON.stringify(receipt)!==JSON.stringify(expectedAiComponents)){
        fail('Arcane AI browser WASM component authority is invalid.');
    }
    for(const component of receipt.components){
        for(const file of component.files){
            const declared=releaseFiles.find(candidate=>candidate.path===file.path);
            if(!declared||declared.bytes!==file.bytes||declared.sha256!==file.sha256
                ||('sourcePath' in file&&declared.sourcePath!==file.sourcePath)){
                fail(`Arcane AI browser WASM component projection drifted for ${file.path}.`);
            }
        }
    }
}

function requiresInstalledPackageSource(file){
    return !file.sourcePath.startsWith('node_modules/@wllama/wllama/');
}

function validateSource(source){
    if(!source||typeof source!=='object'||Array.isArray(source)
        ||!exactKeys(source,['authority','browserEntry','dependencies','protocol','repository'])
        ||source.authority!=='arcane-os-sdk'||source.browserEntry!=='arcane-os/event-manager'
        ||source.protocol!==PROTOCOL
        ||source.repository!==REPOSITORY||!Array.isArray(source.dependencies)
        ||source.dependencies.length!==3){
        fail('SDK browser runtime manifest source authority is invalid.');
    }
    const expectedDependencies=[
        {
            name:'event-pubsub',
            version:'6.1.0',
            resolved:'https://registry.npmjs.org/event-pubsub/-/event-pubsub-6.1.0.tgz',
            integrity:'sha512-FEMlhTxwqGM0hztTixG6FhVFXqp7Eq1ltk5mSreK6Mhy3xWWpLAzEUR6OMvMdNqT3jgSxA8JDhnhyAG3X4Xy7Q=='
        },
        {
            name:'strong-type',
            version:'2.0.0',
            resolved:'https://registry.npmjs.org/strong-type/-/strong-type-2.0.0.tgz',
            integrity:'sha512-HHrY9qYC7yn+5mlewiI3k9RQM9gZqGQsqbomZcd10Ks0h4RlX01nnkWbCe4AsVPCI6KaFvpkWm1nHMD+Ykup6g=='
        },
        {
            name:'@wllama/wllama',
            version:'3.6.0',
            resolved:'https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz',
            integrity:'sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w=='
        }
    ];
    for(const [index,expected] of expectedDependencies.entries()){
        const actual=source.dependencies[index];
        if(!actual||typeof actual!=='object'||Array.isArray(actual)
            ||!exactKeys(actual,['integrity','name','resolved','version'])
            ||actual.name!==expected.name||actual.version!==expected.version
            ||actual.resolved!==expected.resolved||actual.integrity!==expected.integrity){
            fail('SDK browser runtime manifest dependency identity is invalid.');
        }
    }
    return Object.freeze({
        ...source,
        dependencies:Object.freeze(source.dependencies.map(item=>Object.freeze({...item})))
    });
}

function validateRelease(value){
    if(!value||typeof value!=='object'||Array.isArray(value)){
        fail('SDK browser runtime manifest must be a JSON object.');
    }
    if(!exactKeys(value,[
        'builder','contentSha256','fileCount','files','schemaVersion','sdkVersion','source','totalBytes'
    ])){
        fail('SDK browser runtime manifest contains missing or unsupported fields.');
    }
    if(value.schemaVersion!==1||value.builder!==BUILDER){
        fail('SDK browser runtime manifest uses an unsupported schema or builder.');
    }
    if(value.sdkVersion!==SDK_VERSION){
        fail('SDK browser runtime manifest sdkVersion is incompatible with this SDK.');
    }
    const source=validateSource(value.source);
    if(!Array.isArray(value.files)||!Number.isSafeInteger(value.fileCount)
        ||value.fileCount!==value.files.length||value.fileCount!==expectedFiles.length
        ||!Number.isSafeInteger(value.totalBytes)||value.totalBytes<0
        ||!SHA256_PATTERN.test(value.contentSha256)){
        fail('SDK browser runtime manifest inventory summary is invalid.');
    }
    let previous='';
    let totalBytes=0;
    const collisionKeys=new Set();
    const files=value.files.map((entry,index)=>{
        if(!entry||typeof entry!=='object'||Array.isArray(entry)
            ||!exactKeys(entry,['bytes','path','provenance','sha256','sourcePath'])){
            fail(`SDK browser runtime manifest file ${index} is invalid.`);
        }
        const relative=safeInventoryPath(entry.path);
        const sourcePath=safeInventoryPath(entry.sourcePath,'source inventory');
        const expected=expectedFiles[index];
        const key=collisionKey(relative);
        if(relative===MANIFEST_NAME||collisionKeys.has(key)
            ||(previous&&compareText(previous,relative)>=0)
            ||relative!==expected.path||sourcePath!==expected.sourcePath
            ||entry.provenance!==expected.provenance){
            fail(`SDK browser runtime manifest inventory is invalid at ${relative}.`);
        }
        if(!Number.isSafeInteger(entry.bytes)||entry.bytes<0||!SHA256_PATTERN.test(entry.sha256)){
            fail(`SDK browser runtime manifest metadata is invalid for ${relative}.`);
        }
        collisionKeys.add(key);
        previous=relative;
        totalBytes+=entry.bytes;
        if(!Number.isSafeInteger(totalBytes)){
            fail('SDK browser runtime manifest total byte count is too large.');
        }
        return {
            path:relative,
            sourcePath,
            provenance:entry.provenance,
            bytes:entry.bytes,
            sha256:entry.sha256
        };
    });
    if(totalBytes!==value.totalBytes){
        fail('SDK browser runtime manifest totalBytes does not match its inventory.');
    }
    const aggregate=createHash('sha256').update(JSON.stringify(files)).digest('hex');
    if(aggregate!==value.contentSha256){
        fail('SDK browser runtime manifest contentSha256 does not match its inventory.');
    }
    if(value.contentSha256!==SDK_BROWSER_RUNTIME_CONTENT_SHA256){
        fail('SDK browser runtime manifest does not match the trusted SDK browser closure.');
    }
    return Object.freeze({...value,source,files:immutableInventory(files)});
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
    return String(info.dev)===identity.device&&String(info.ino)===identity.inode
        &&Number(info.size)===identity.bytes
        &&String(info.mtimeNs)===identity.modifiedNanoseconds
        &&String(info.ctimeNs)===identity.changedNanoseconds
        &&String(info.nlink)===identity.links;
}

function containedPath(root,relative,label='file'){
    const absolute=path.resolve(root,...safeInventoryPath(relative).split('/'));
    const fromRoot=path.relative(root,absolute);
    if(fromRoot.startsWith('..')||path.isAbsolute(fromRoot)){
        fail(`SDK browser runtime ${label} escapes its root: ${relative}.`);
    }
    return absolute;
}

async function assertCanonicalPath(root,filePath,relative){
    const canonical=await realpath(filePath);
    const fromRoot=path.relative(root,canonical);
    if(fromRoot.startsWith('..')||path.isAbsolute(fromRoot)){
        fail(`SDK browser runtime path left its root: ${relative}.`);
    }
}

async function scanTree(root,{signal}={}){
    const files=[];
    const directories=[];
    const expectedDirectorySet=new Set(expectedDirectories);
    async function visit(directory,relativeRoot=''){
        throwIfAborted(signal);
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            throwIfAborted(signal);
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            if(relative===MANIFEST_NAME)continue;
            safeInventoryPath(relative,'tree');
            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute,{bigint:true});
            if(info.isSymbolicLink()){
                fail(`SDK browser runtime contains a symbolic link or junction: ${relative}.`);
            }
            if(info.isDirectory()){
                if(!expectedDirectorySet.has(relative)){
                    fail(`SDK browser runtime contains an unexpected directory: ${relative}.`);
                }
                await assertCanonicalPath(root,absolute,relative);
                directories.push(Object.freeze({path:relative,...fileIdentity(info)}));
                await visit(absolute,relative);
            }else if(info.isFile()){
                files.push(relative);
            }else{
                fail(`SDK browser runtime contains a non-file entry: ${relative}.`);
            }
        }
    }
    await visit(root);
    files.sort(compareText);
    directories.sort((left,right)=>compareText(left.path,right.path));
    if(JSON.stringify(directories.map(item=>item.path))!==JSON.stringify(expectedDirectories)){
        fail('SDK browser runtime directory inventory is incomplete.');
    }
    return {files,directories:Object.freeze(directories)};
}

async function openVerified(filePath,{expectedBytes,expectedIdentity,root,relative,signal}={}){
    throwIfAborted(signal);
    const before=await lstat(filePath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()
        ||(expectedIdentity&&!identityMatches(before,expectedIdentity))
        ||(expectedBytes!==undefined&&before.size!==BigInt(expectedBytes))){
        fail(`SDK browser runtime file changed: ${relative}.`);
    }
    await assertCanonicalPath(root,filePath,relative);
    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP'){
            fail(`SDK browser runtime file became a symbolic link: ${relative}.`);
        }
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!sameIdentity(before,opened)
            ||(expectedIdentity&&!identityMatches(opened,expectedIdentity))){
            fail(`SDK browser runtime file changed while it was being opened: ${relative}.`);
        }
        if(opened.size>BigInt(MAX_VERIFIED_FILE_BYTES)){
            fail(`SDK browser runtime file exceeds the verification limit: ${relative}.`);
        }
        const bytes=await handle.readFile();
        throwIfAborted(signal);
        const after=await handle.stat({bigint:true});
        if(!sameIdentity(opened,after)||bytes.length!==Number(after.size)){
            fail(`SDK browser runtime file changed while it was being read: ${relative}.`);
        }
        const current=await lstat(filePath,{bigint:true});
        if(current.isSymbolicLink()||!current.isFile()||!sameIdentity(after,current)){
            fail(`SDK browser runtime path changed while it was being read: ${relative}.`);
        }
        await assertCanonicalPath(root,filePath,relative);
        return {bytes,identity:fileIdentity(after)};
    }finally{
        await handle.close();
    }
}

async function readRelease(root,signal){
    const manifestPath=path.join(root,MANIFEST_NAME);
    let result;
    try{
        result=await openVerified(manifestPath,{root,relative:MANIFEST_NAME,signal});
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`SDK browser runtime manifest is missing: ${manifestPath}.`);
        }
        throw error;
    }
    let value;
    try{
        value=JSON.parse(result.bytes.toString('utf8'));
    }catch(error){
        fail(`SDK browser runtime manifest is not valid JSON: ${error.message}`);
    }
    return {
        release:validateRelease(value),
        manifestPath,
        manifestSha256:createHash('sha256').update(result.bytes).digest('hex'),
        manifestIdentity:result.identity
    };
}

async function verifiedRoot(browserRuntimeRoot){
    const requested=path.resolve(browserRuntimeRoot);
    let info;
    try{
        info=await lstat(requested,{bigint:true});
    }catch(error){
        if(error?.code==='ENOENT')fail(`SDK browser runtime root does not exist: ${requested}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory()){
        fail('SDK browser runtime root must be a real directory.');
    }
    const canonical=await realpath(requested);
    const canonicalInfo=await lstat(canonical,{bigint:true});
    if(canonicalInfo.isSymbolicLink()||!canonicalInfo.isDirectory()){
        fail('SDK browser runtime root must be a real directory.');
    }
    return {canonical,identity:fileIdentity(canonicalInfo)};
}

function directoryIdentityMatches(actual,expected){
    return actual.path===expected.path&&actual.device===expected.device
        &&actual.inode===expected.inode&&actual.bytes===expected.bytes
        &&actual.modifiedNanoseconds===expected.modifiedNanoseconds
        &&actual.changedNanoseconds===expected.changedNanoseconds
        &&actual.links===expected.links;
}

async function assertReceiptState(receipt,signal){
    throwIfAborted(signal);
    const rootBefore=await lstat(receipt.canonicalLocation,{bigint:true});
    if(rootBefore.isSymbolicLink()||!rootBefore.isDirectory()
        ||!identityMatches(rootBefore,receipt.rootIdentity)){
        fail('SDK browser runtime root changed after verification.');
    }
    const scanned=await scanTree(receipt.canonicalLocation,{signal});
    if(JSON.stringify(scanned.files)!==JSON.stringify(receipt.files.map(file=>file.path))
        ||scanned.directories.length!==receipt.directories.length
        ||scanned.directories.some((item,index)=>!directoryIdentityMatches(item,receipt.directories[index]))){
        fail('SDK browser runtime inventory changed after verification.');
    }
    const manifestInfo=await lstat(receipt.manifestPath,{bigint:true});
    if(manifestInfo.isSymbolicLink()||!manifestInfo.isFile()
        ||!identityMatches(manifestInfo,receipt.manifestIdentity)){
        fail('SDK browser runtime manifest changed after verification.');
    }
    for(const identity of receipt.identities){
        throwIfAborted(signal);
        const absolute=containedPath(receipt.canonicalLocation,identity.path);
        const info=await lstat(absolute,{bigint:true});
        if(info.isSymbolicLink()||!info.isFile()||!identityMatches(info,identity)){
            fail(`SDK browser runtime file changed after verification: ${identity.path}.`);
        }
        await assertCanonicalPath(receipt.canonicalLocation,absolute,identity.path);
    }
    const sourceRoot=path.dirname(receipt.canonicalLocation);
    for(const identity of receipt.sourceIdentities){
        throwIfAborted(signal);
        const file=receipt.files.find(candidate=>candidate.sourcePath===identity.path);
        if(!file)fail(`SDK browser source identity is not declared: ${identity.path}.`);
        const result=await openVerified(containedPath(sourceRoot,identity.path,'source file'),{
            expectedBytes:file.bytes,
            expectedIdentity:identity,
            root:sourceRoot,
            relative:identity.path,
            signal
        });
        if(createHash('sha256').update(result.bytes).digest('hex')!==file.sha256){
            fail(`SDK browser runtime package source changed after verification: ${identity.path}.`);
        }
    }
    const rootAfter=await lstat(receipt.canonicalLocation,{bigint:true});
    if(rootAfter.isSymbolicLink()||!rootAfter.isDirectory()
        ||!identityMatches(rootAfter,receipt.rootIdentity)||!sameIdentity(rootBefore,rootAfter)){
        fail('SDK browser runtime root changed while its receipt was authenticated.');
    }
}

export function getSdkBrowserRuntimeRoot(){
    return defaultRoot;
}

export async function loadSdkBrowserRuntimeRelease({browserRuntimeRoot=defaultRoot,signal}={}){
    throwIfAborted(signal);
    const {canonical}=await verifiedRoot(browserRuntimeRoot);
    return (await readRelease(canonical,signal)).release;
}

export async function authenticateSdkBrowserRuntimeReceipt(receipt,{
    browserRuntimeRoot=defaultRoot,
    signal
}={}){
    if(!receipt||!issuedReceipts.has(receipt)){
        fail('SDK browser runtime receipt was not issued by this SDK process.');
    }
    const {canonical}=await verifiedRoot(browserRuntimeRoot);
    if(receipt.canonicalLocation!==canonical){
        fail('SDK browser runtime receipt belongs to a different location.');
    }
    await assertReceiptState(receipt,signal);
    return receipt;
}

export async function readVerifiedSdkBrowserRuntimeFile(receipt,{
    browserRuntimeRoot=defaultRoot,
    relativePath,
    signal
}={}){
    if(!receipt||!issuedReceipts.has(receipt)){
        fail('SDK browser runtime receipt was not issued by this SDK process.');
    }
    throwIfAborted(signal);
    const normalized=safeInventoryPath(relativePath);
    const key=value=>process.platform==='win32'?collisionKey(value):value;
    const file=receipt.files.find(candidate=>key(candidate.path)===key(normalized));
    if(!file)fail(`Path is not in the verified SDK browser runtime inventory: ${normalized}.`);
    const identity=receipt.identities.find(candidate=>key(candidate.path)===key(file.path));
    if(!identity)fail(`Verified SDK browser runtime identity is missing for ${file.path}.`);
    const {canonical}=await verifiedRoot(browserRuntimeRoot);
    if(receipt.canonicalLocation!==canonical){
        fail('SDK browser runtime receipt belongs to a different location.');
    }
    const rootInfo=await lstat(canonical,{bigint:true});
    if(!identityMatches(rootInfo,receipt.rootIdentity)){
        fail('SDK browser runtime root changed after verification.');
    }
    for(const directory of receipt.directories){
        if(file.path.startsWith(`${directory.path}/`)){
            const info=await lstat(containedPath(canonical,directory.path),{bigint:true});
            if(info.isSymbolicLink()||!info.isDirectory()||!identityMatches(info,directory)){
                fail(`SDK browser runtime directory changed after verification: ${directory.path}.`);
            }
        }
    }
    const filePath=containedPath(canonical,file.path);
    const result=await openVerified(filePath,{
        expectedBytes:file.bytes,
        expectedIdentity:identity,
        root:canonical,
        relative:file.path,
        signal
    });
    if(createHash('sha256').update(result.bytes).digest('hex')!==file.sha256){
        fail(`SDK browser runtime file hash changed: ${file.path}.`);
    }
    return result.bytes;
}

export async function verifySdkBrowserRuntime({
    browserRuntimeRoot=defaultRoot,
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    const {canonical,identity:rootIdentity}=await verifiedRoot(browserRuntimeRoot);
    const {release,manifestPath,manifestSha256,manifestIdentity}=await readRelease(canonical,signal);
    if(manifestSha256!==SDK_BROWSER_RUNTIME_MANIFEST_SHA256){
        fail('SDK browser runtime manifest bytes do not match the trusted SDK release.');
    }
    await emit(onEvent,{
        type:'sdk-browser-runtime.verify.started',
        fileCount:release.fileCount,
        totalBytes:release.totalBytes
    });
    const scanned=await scanTree(canonical,{signal});
    if(JSON.stringify(scanned.files)!==JSON.stringify(release.files.map(file=>file.path))){
        fail('SDK browser runtime file inventory does not match ARCANE_SDK_BROWSER_RELEASE.json.');
    }
    const identities=[];
    const sourceIdentities=[];
    const sourceRoot=path.dirname(canonical);
    let aiComponentsBytes;
    let verifiedBytes=0;
    for(const [index,file] of release.files.entries()){
        throwIfAborted(signal);
        const absolute=containedPath(canonical,file.path);
        const result=await openVerified(absolute,{
            expectedBytes:file.bytes,
            root:canonical,
            relative:file.path,
            signal
        });
        if(createHash('sha256').update(result.bytes).digest('hex')!==file.sha256){
            fail(`SDK browser runtime integrity check failed for ${file.path}.`);
        }
        if(file.path==='ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json'){
            aiComponentsBytes=result.bytes;
        }
        if(requiresInstalledPackageSource(file)){
            const sourceResult=await openVerified(
                containedPath(sourceRoot,file.sourcePath,'source file'),
                {
                    expectedBytes:file.bytes,
                    root:sourceRoot,
                    relative:file.sourcePath,
                    signal
                }
            );
            if(!result.bytes.equals(sourceResult.bytes)){
                fail(
                    `SDK browser runtime file does not match its declared package source: `
                    +`${file.path} (${file.sourcePath}).`
                );
            }
            sourceIdentities.push(Object.freeze({path:file.sourcePath,...sourceResult.identity}));
        }
        identities.push(Object.freeze({path:file.path,...result.identity}));
        verifiedBytes+=file.bytes;
        await emit(onEvent,{
            type:'sdk-browser-runtime.verify.progress',
            current:index+1,
            total:release.fileCount,
            verifiedBytes,
            totalBytes:release.totalBytes,
            path:file.path
        });
    }
    if(!aiComponentsBytes){
        fail('Arcane AI browser WASM component receipt is missing.');
    }
    validateAiComponents(aiComponentsBytes,release.files);
    const receipt=Object.freeze({
        schemaVersion:1,
        kind:'arcane-sdk-browser-runtime-verification',
        canonicalLocation:canonical,
        rootIdentity,
        manifestPath,
        manifestSha256,
        manifestIdentity,
        builder:release.builder,
        sdkVersion:release.sdkVersion,
        source:release.source,
        files:release.files,
        fileCount:release.fileCount,
        totalBytes:release.totalBytes,
        contentSha256:release.contentSha256,
        identities:Object.freeze(identities),
        sourceIdentities:Object.freeze(sourceIdentities),
        directories:scanned.directories
    });
    issuedReceipts.add(receipt);
    await assertReceiptState(receipt,signal);
    await emit(onEvent,{
        type:'sdk-browser-runtime.verify.completed',
        contentSha256:receipt.contentSha256,
        fileCount:receipt.fileCount,
        totalBytes:receipt.totalBytes
    });
    return receipt;
}
