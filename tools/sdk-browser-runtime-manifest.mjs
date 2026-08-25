#!/usr/bin/env node

import {createHash} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,readdir,realpath,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SDK_VERSION} from '../src/constants.mjs';
import {
    WLLAMA_PROJECTED_BYTES,
    WLLAMA_PROJECTED_SHA256,
    WLLAMA_UPSTREAM_AUTHORITY,
    WLLAMA_WEBGPU_EVIDENCE_PROTOCOL,
    projectWllamaWebgpuRuntime,
} from './project-wllama-webgpu-runtime.mjs';

const MANIFEST_NAME='ARCANE_SDK_BROWSER_RELEASE.json';
const BUILDER='arcane-sdk-browser-runtime-v1';
const PROTOCOL='arcane-sdk-browser-runtime/1';
const REPOSITORY='https://github.com/TheWizardNexus/arcane-os-sdk.git';
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const toolRoot=path.dirname(fileURLToPath(import.meta.url));
const packageRoot=path.dirname(toolRoot);
const browserRuntimeRoot=path.join(packageRoot,'browser-runtime');
const manifestPath=path.join(browserRuntimeRoot,MANIFEST_NAME);
const mode=process.argv[2]??'--verify';
const dependencyIdentities=Object.freeze([
    Object.freeze({
        name:'event-pubsub',
        version:'6.1.0',
        resolved:'https://registry.npmjs.org/event-pubsub/-/event-pubsub-6.1.0.tgz',
        integrity:'sha512-FEMlhTxwqGM0hztTixG6FhVFXqp7Eq1ltk5mSreK6Mhy3xWWpLAzEUR6OMvMdNqT3jgSxA8JDhnhyAG3X4Xy7Q=='
    }),
    Object.freeze({
        name:'strong-type',
        version:'2.0.0',
        resolved:'https://registry.npmjs.org/strong-type/-/strong-type-2.0.0.tgz',
        integrity:'sha512-HHrY9qYC7yn+5mlewiI3k9RQM9gZqGQsqbomZcd10Ks0h4RlX01nnkWbCe4AsVPCI6KaFvpkWm1nHMD+Ykup6g=='
    }),
    Object.freeze({
        name:'@wllama/wllama',
        version:'3.6.0',
        resolved:'https://registry.npmjs.org/@wllama/wllama/-/wllama-3.6.0.tgz',
        integrity:'sha512-NN3ZBXqaaUwGXTQubkNvsCaLPjN2XVa0bVS40OYCE8zquYmRc2W3oHYEgwvuSWWDB8aUqTLyMioySCXNkcnD1w=='
    })
]);
const expectedAiComponents=Object.freeze({
    schemaVersion:1,
    kind:'arcane-ai-browser-wasm-components',
    protocol:'arcane-ai-browser-wasm/2',
    packageExport:'arcane-os/ai/browser-wasm',
    browserEntry:'ai/browser-wasm.mjs',
    runtimePolicy:{
        modelAuthorities:'caller-supplied-exact-bytes-and-sha256',
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
                    bytes:WLLAMA_PROJECTED_BYTES,
                    sha256:WLLAMA_PROJECTED_SHA256,
                    projection:{
                        protocol:WLLAMA_WEBGPU_EVIDENCE_PROTOCOL,
                        inputPath:'node_modules/@wllama/wllama/esm/index.js',
                        inputBytes:WLLAMA_UPSTREAM_AUTHORITY.bytes,
                        inputSha256:WLLAMA_UPSTREAM_AUTHORITY.sha256,
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

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

function sameIdentity(before,after){
    return before.dev===after.dev&&before.ino===after.ino&&before.size===after.size
        &&before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs
        &&before.nlink===after.nlink;
}

async function readRealFile(filePath,label){
    const before=await lstat(filePath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()){
        throw new Error(`${label} must be a real file: ${filePath}`);
    }
    let handle;
    try{
        handle=await open(filePath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')throw new Error(`${label} became a symbolic link: ${filePath}`);
        throw error;
    }
    try{
        const opened=await handle.stat({bigint:true});
        if(!opened.isFile()||!sameIdentity(before,opened)){
            throw new Error(`${label} changed while it was opened: ${filePath}`);
        }
        const bytes=await handle.readFile();
        const after=await handle.stat({bigint:true});
        const current=await lstat(filePath,{bigint:true});
        if(!sameIdentity(opened,after)||current.isSymbolicLink()||!current.isFile()
            ||!sameIdentity(after,current)||bytes.length!==Number(after.size)){
            throw new Error(`${label} changed while it was read: ${filePath}`);
        }
        return bytes;
    }finally{
        await handle.close();
    }
}

async function assertRealDirectory(directory,label){
    const info=await lstat(directory,{bigint:true});
    if(info.isSymbolicLink()||!info.isDirectory()){
        throw new Error(`${label} must be a real directory: ${directory}`);
    }
    return realpath(directory);
}

async function snapshotInventory(){
    const files=[];
    const directories=[];
    async function visit(directory,relativeRoot=''){
        const entries=await readdir(directory,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            if(relative===MANIFEST_NAME)continue;
            const absolute=path.join(directory,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink()){
                throw new Error(`SDK browser runtime contains a symbolic link or junction: ${relative}`);
            }
            if(info.isDirectory()){
                directories.push(relative);
                await visit(absolute,relative);
            }else if(info.isFile()){
                files.push(relative);
            }else{
                throw new Error(`SDK browser runtime contains a special entry: ${relative}`);
            }
        }
    }
    await visit(browserRuntimeRoot);
    files.sort(compareText);
    directories.sort(compareText);
    const expectedFilePaths=expectedFiles.map(file=>file.path);
    if(JSON.stringify(files)!==JSON.stringify(expectedFilePaths)
        ||JSON.stringify(directories)!==JSON.stringify(expectedDirectories)){
        const missing=[...expectedFilePaths,...expectedDirectories]
            .filter(entry=>!files.includes(entry)&&!directories.includes(entry));
        const extra=[...files,...directories]
            .filter(entry=>!expectedFilePaths.includes(entry)&&!expectedDirectories.includes(entry));
        throw new Error(
            `SDK browser runtime inventory drifted; missing=${JSON.stringify(missing)}, `
            +`extra=${JSON.stringify(extra)}.`
        );
    }
}

function parseJson(bytes,label){
    try{return JSON.parse(bytes.toString('utf8'));}
    catch(error){throw new Error(`${label} is not valid JSON: ${error.message}`);}
}

function validateAiComponents(sourceBytes){
    const receipt=parseJson(
        sourceBytes.get('browser-runtime/ai/ARCANE_AI_BROWSER_WASM_COMPONENTS.json'),
        'Arcane AI browser WASM component receipt'
    );
    if(JSON.stringify(receipt)!==JSON.stringify(expectedAiComponents)){
        throw new Error('Arcane AI browser WASM component authority is invalid.');
    }
    for(const component of receipt.components){
        for(const file of component.files){
            const declared=expectedFiles.find(candidate=>candidate.path===file.path);
            const bytes=declared&&sourceBytes.get(declared.sourcePath);
            if(!bytes||bytes.length!==file.bytes
                ||createHash('sha256').update(bytes).digest('hex')!==file.sha256){
                throw new Error(`Arcane AI browser WASM component bytes drifted for ${file.path}.`);
            }
        }
    }
}

async function sourceBytesByPath(){
    const packageDocument=parseJson(
        await readRealFile(path.join(packageRoot,'package.json'),'SDK package manifest'),
        'SDK package manifest'
    );
    if(packageDocument.name!=='arcane-os'||packageDocument.version!==SDK_VERSION){
        throw new Error('SDK browser runtime package identity does not match this SDK.');
    }
    const lockDocument=parseJson(
        await readRealFile(path.join(packageRoot,'package-lock.json'),'SDK package lock'),
        'SDK package lock'
    );
    for(const dependency of dependencyIdentities){
        const locked=lockDocument.packages?.[`node_modules/${dependency.name}`];
        if(!locked||locked.version!==dependency.version||locked.resolved!==dependency.resolved
            ||locked.integrity!==dependency.integrity){
            throw new Error(`SDK browser dependency lock identity drifted for ${dependency.name}.`);
        }
    }

    const nodeModulesRoot=await assertRealDirectory(path.join(packageRoot,'node_modules'),'node_modules');
    const eventRoot=await assertRealDirectory(
        path.join(packageRoot,'node_modules','event-pubsub'),
        'event-pubsub@6.1.0 source'
    );
    const strongRoot=await assertRealDirectory(
        path.join(packageRoot,'node_modules','strong-type'),
        'strong-type@2.0.0 source'
    );
    const wllamaScopeRoot=await assertRealDirectory(
        path.join(packageRoot,'node_modules','@wllama'),
        '@wllama package scope'
    );
    const wllamaRoot=await assertRealDirectory(
        path.join(packageRoot,'node_modules','@wllama','wllama'),
        '@wllama/wllama@3.6.0 source'
    );
    if(path.dirname(eventRoot)!==nodeModulesRoot||path.dirname(strongRoot)!==nodeModulesRoot
        ||path.dirname(wllamaScopeRoot)!==nodeModulesRoot||path.dirname(wllamaRoot)!==wllamaScopeRoot){
        throw new Error('SDK browser dependencies must be physical packages beneath node_modules.');
    }

    const sourceBytes=new Map();
    for(const file of expectedFiles){
        sourceBytes.set(file.sourcePath,await readRealFile(
            path.join(packageRoot,...file.sourcePath.split('/')),
            `SDK browser source ${file.sourcePath}`
        ));
    }
    const eventPackage=parseJson(
        sourceBytes.get('node_modules/event-pubsub/package.json'),
        'event-pubsub package manifest'
    );
    const strongPackage=parseJson(
        sourceBytes.get('node_modules/strong-type/package.json'),
        'strong-type package manifest'
    );
    const wllamaPackage=parseJson(
        await readRealFile(path.join(wllamaRoot,'package.json'),'@wllama/wllama package manifest'),
        '@wllama/wllama package manifest'
    );
    if(eventPackage.name!=='event-pubsub'||eventPackage.version!=='6.1.0'
        ||eventPackage.dependencies?.['strong-type']!=='2.0.0'
        ||strongPackage.name!=='strong-type'||strongPackage.version!=='2.0.0'
        ||wllamaPackage.name!=='@wllama/wllama'||wllamaPackage.version!=='3.6.0'
        ||wllamaPackage.license!=='MIT'){
        throw new Error('SDK browser dependency package identity is invalid.');
    }
    const upstreamWllama=await readRealFile(
        path.join(wllamaRoot,'esm','index.js'),
        '@wllama/wllama authenticated ESM source'
    );
    if(upstreamWllama.length!==WLLAMA_UPSTREAM_AUTHORITY.bytes
        ||createHash('sha256').update(upstreamWllama).digest('hex')
            !==WLLAMA_UPSTREAM_AUTHORITY.sha256){
        throw new Error('Authenticated Wllama ESM source identity drifted.');
    }
    const projectedWllama=projectWllamaWebgpuRuntime(upstreamWllama);
    const projectedSnapshot=sourceBytes.get('browser-runtime/ai/wllama/index.mjs');
    if(!projectedSnapshot||!projectedSnapshot.equals(projectedWllama)){
        throw new Error('Packaged Wllama ESM is not the deterministic authenticated projection.');
    }
    validateAiComponents(sourceBytes);
    const eventManagerText=sourceBytes.get('src/event-manager.mjs').toString('utf8');
    const eventPubSubText=sourceBytes.get('node_modules/event-pubsub/index.js').toString('utf8');
    if(!eventManagerText.includes("from 'event-pubsub'")
        ||!eventManagerText.includes("from './dom-event-instrumentation.mjs'")
        ||!eventPubSubText.includes("from '../strong-type/index.js'")){
        throw new Error('SDK browser entry dependency graph is not the expected browser-safe closure.');
    }
    return sourceBytes;
}

async function buildManifest(){
    await snapshotInventory();
    const sourceBytes=await sourceBytesByPath();
    const files=[];
    for(const file of expectedFiles){
        const snapshot=await readRealFile(
            path.join(browserRuntimeRoot,...file.path.split('/')),
            `SDK browser runtime snapshot ${file.path}`
        );
        const source=sourceBytes.get(file.sourcePath);
        if(!source||!snapshot.equals(source)){
            throw new Error(
                `SDK browser runtime snapshot ${file.path} does not exactly match ${file.sourcePath}`
            );
        }
        files.push({
            path:file.path,
            sourcePath:file.sourcePath,
            provenance:file.provenance,
            bytes:snapshot.length,
            sha256:createHash('sha256').update(snapshot).digest('hex')
        });
    }
    return {
        schemaVersion:1,
        builder:BUILDER,
        sdkVersion:SDK_VERSION,
        source:{
            authority:'arcane-os-sdk',
            repository:REPOSITORY,
            protocol:PROTOCOL,
            browserEntry:'arcane-os/event-manager',
            dependencies:dependencyIdentities
        },
        fileCount:files.length,
        totalBytes:files.reduce((total,file)=>total+file.bytes,0),
        contentSha256:createHash('sha256').update(JSON.stringify(files)).digest('hex'),
        files
    };
}

if(!['--write','--verify'].includes(mode)||process.argv.length>3){
    console.error('Usage: node tools/sdk-browser-runtime-manifest.mjs [--write|--verify]');
    process.exitCode=2;
}else{
    try{
        const actual=await buildManifest();
        if(mode==='--write'){
            try{
                const existing=await lstat(manifestPath);
                if(existing.isSymbolicLink()||!existing.isFile()){
                    throw new Error('SDK browser runtime manifest destination must be a real file.');
                }
            }catch(error){
                if(error?.code!=='ENOENT')throw error;
            }
            await writeFile(manifestPath,`${JSON.stringify(actual,null,2)}\n`,'utf8');
            console.log(
                `Wrote ${manifestPath} (${actual.fileCount} files, ${actual.totalBytes} bytes).`
            );
        }else{
            const expected=parseJson(
                await readRealFile(manifestPath,'SDK browser runtime manifest'),
                'SDK browser runtime manifest'
            );
            if(JSON.stringify(expected)!==JSON.stringify(actual)){
                throw new Error(
                    'ARCANE_SDK_BROWSER_RELEASE.json does not match the authenticated browser closure.'
                );
            }
            console.log(
                `Verified SDK browser runtime ${actual.contentSha256} (${actual.fileCount} files).`
            );
        }
    }catch(error){
        console.error(error.message);
        process.exitCode=1;
    }
}
