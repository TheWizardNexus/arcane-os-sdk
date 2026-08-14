import {createHash} from 'node:crypto';
import {constants as FS_CONSTANTS} from 'node:fs';
import {lstat,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {runProcess} from './process.mjs';

export const INTEGRATED_TOOLCHAIN_PROTOCOL='arcane-integrated-toolchain/1';
export const ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH=Object.freeze([
    'tools',
    'integrated-development-provider.mjs'
]);

const PROVIDER_STATE=Symbol.for('arcane-os-sdk.integrated-provider-state.v1');
const PROVIDER_RESTART_CODE='ARCANE_INTEGRATED_PROVIDER_RESTART_REQUIRED';
const MAX_PROVIDER_BYTES=512*1024;
const READ_ONLY_NO_FOLLOW=FS_CONSTANTS.O_RDONLY|(FS_CONSTANTS.O_NOFOLLOW??0);
const REQUIRED_OPERATIONS=Object.freeze(['development-check','focused-test']);
const SAFE_NODE_IMPORT=/^import\s+(?:(?:[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*|\{[\w$\s,]+\})\s+from\s+)?(['"])(node:[a-z0-9_./-]+)\1;$/u;

if(!globalThis[PROVIDER_STATE]){
    Object.defineProperty(globalThis,PROVIDER_STATE,{
        value:{records:new Map()},
        configurable:false,
        enumerable:false,
        writable:false
    });
}

const providerRecords=globalThis[PROVIDER_STATE].records;

function fail(message,code=ERROR_CODES.integrityFailed,details){
    throw new ArcaneError(code,message,{details});
}

function pathKey(value){
    const normalized=path.normalize(path.resolve(value));
    return process.platform==='win32'?normalized.toLowerCase():normalized;
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

function restartRequired(message,details){
    fail(message,PROVIDER_RESTART_CODE,details);
}

async function emit(onEvent,event){
    await onEvent?.(Object.freeze(event));
}

async function assertUnlinkedDirectoryAncestors(location){
    const resolved=path.resolve(location);
    const parsed=path.parse(resolved);
    const relative=resolved.slice(parsed.root.length);
    let current=parsed.root;
    const components=relative.split(path.sep).filter(Boolean);
    for(let index=0;index<components.length-1;index+=1){
        current=path.join(current,components[index]);
        const info=await lstat(current);
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail(
                'The Arcane OS root must not use a linked or non-directory ancestor.',
                ERROR_CODES.policyDenied,
                {arcaneRoot:resolved,ancestor:current}
            );
        }
    }
}

async function canonicalProviderRoot(arcaneRoot){
    if(typeof arcaneRoot!=='string'||!arcaneRoot.trim()){
        fail('An explicit Arcane OS root is required for shared development.',ERROR_CODES.usage);
    }
    const requested=path.resolve(arcaneRoot);
    let rootInfo;
    try{
        rootInfo=await lstat(requested);
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(`The Arcane OS root does not exist: ${requested}.`,ERROR_CODES.workspaceInvalid);
        }
        throw error;
    }
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail('The Arcane OS root must be a real directory.',ERROR_CODES.policyDenied);
    }
    await assertUnlinkedDirectoryAncestors(requested);
    const canonicalRoot=await realpath(requested);
    const toolsRoot=path.join(canonicalRoot,'tools');
    const toolsInfo=await lstat(toolsRoot);
    if(toolsInfo.isSymbolicLink()||!toolsInfo.isDirectory()){
        fail('The Arcane OS tools root must be a real directory.',ERROR_CODES.policyDenied);
    }
    return canonicalRoot;
}

function assertSingleModulePolicy(source){
    for(const [index,line] of source.split(/\r?\n/u).entries()){
        if(!/\b(?:from|import|require)\b/u.test(line))continue;
        if(!SAFE_NODE_IMPORT.test(line.trim())){
            fail(
                `The integrated provider may contain only one-line static Node built-in imports (line ${index+1}).`
            );
        }
    }
}

function waitForProviderInitialization(promise,signal){
    throwIfAborted(signal);
    if(!signal)return promise;
    return new Promise(function observeInitialization(resolve,reject){
        let settled=false;
        function cleanup(){
            signal.removeEventListener('abort',abortObservation);
        }
        function settle(callback,value){
            if(settled)return;
            settled=true;
            cleanup();
            callback(value);
        }
        function abortObservation(){
            try{
                throwIfAborted(signal);
            }catch(error){
                settle(reject,error);
            }
        }
        signal.addEventListener('abort',abortObservation,{once:true});
        promise.then(
            value=>settle(resolve,value),
            error=>settle(reject,error)
        );
        if(signal.aborted)abortObservation();
    });
}

async function readGeneration(canonicalRoot){
    const providerPath=path.join(canonicalRoot,...ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH);
    let before;
    try{
        before=await lstat(providerPath,{bigint:true});
    }catch(error){
        if(error?.code==='ENOENT'){
            fail(
                `The Arcane OS checkout does not provide ${ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH.join('/')}.`,
                ERROR_CODES.prerequisiteMissing
            );
        }
        throw error;
    }
    if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1n){
        fail('The integrated provider must be a single-link regular file.',ERROR_CODES.policyDenied);
    }
    if(before.size<1n||before.size>BigInt(MAX_PROVIDER_BYTES)){
        fail(`The integrated provider must contain 1 through ${MAX_PROVIDER_BYTES} bytes.`);
    }

    let handle;
    try{
        handle=await open(providerPath,READ_ONLY_NO_FOLLOW);
    }catch(error){
        if(error?.code==='ELOOP')fail('The integrated provider became a symbolic link.');
        throw error;
    }
    let bytes;
    let openedIdentity;
    try{
        const opened=await handle.stat({bigint:true});
        const beforeIdentity=fileIdentity(before);
        if(!opened.isFile()||!identityMatches(opened,beforeIdentity)){
            fail('The integrated provider changed while it was opened.');
        }
        openedIdentity=fileIdentity(opened);
        bytes=await handle.readFile();
        const after=await handle.stat({bigint:true});
        if(!identityMatches(after,openedIdentity)){
            fail('The integrated provider changed while it was read.');
        }
    }finally{
        await handle.close().catch(()=>{});
    }
    const pathAfter=await lstat(providerPath,{bigint:true});
    if(pathAfter.isSymbolicLink()||!identityMatches(pathAfter,openedIdentity)){
        fail('The integrated provider path changed after it was read.');
    }
    const source=bytes.toString('utf8');
    assertSingleModulePolicy(source);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    return Object.freeze({
        canonicalRoot,
        providerPath,
        bytes:bytes.length,
        sha256,
        identity:openedIdentity,
        source
    });
}

async function authenticateGenerationIdentity(generation){
    const before=await lstat(generation.providerPath,{bigint:true});
    if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1n
        ||!identityMatches(before,generation.identity)){
        fail('The integrated provider filesystem identity changed.');
    }
    const canonical=await realpath(generation.providerPath);
    if(pathKey(canonical)!==pathKey(generation.providerPath)){
        fail('The integrated provider path began traversing a link.');
    }
    const after=await lstat(generation.providerPath,{bigint:true});
    if(after.isSymbolicLink()||!identityMatches(after,generation.identity)){
        fail('The integrated provider filesystem identity changed during authentication.');
    }
    return generation;
}

function describedOperationIds(description){
    const operations=description?.operations;
    if(Array.isArray(operations)){
        return operations.map(operation=>typeof operation==='string'?operation:operation?.id).sort();
    }
    if(operations&&typeof operations==='object'){
        return Object.keys(operations).sort();
    }
    return [];
}

async function validateProvider(moduleNamespace){
    const provider=moduleNamespace?.integratedDevelopmentProvider;
    if(!provider||typeof provider!=='object'||provider.protocol!==INTEGRATED_TOOLCHAIN_PROTOCOL
        ||typeof provider.describe!=='function'||typeof provider.prepare!=='function'
        ||typeof provider.execute!=='function'){
        fail(`The integrated provider must export integratedDevelopmentProvider for ${INTEGRATED_TOOLCHAIN_PROTOCOL}.`);
    }
    const description=await provider.describe();
    if(description?.protocol!==INTEGRATED_TOOLCHAIN_PROTOCOL
        ||JSON.stringify(describedOperationIds(description))!==JSON.stringify(REQUIRED_OPERATIONS)){
        fail('The integrated provider must declare only focused-test and development-check.');
    }
    return provider;
}

function publicGeneration(generation){
    return Object.freeze({
        kind:'arcane-integrated-provider-generation',
        protocol:INTEGRATED_TOOLCHAIN_PROTOCOL,
        canonicalLocation:generation.providerPath,
        contentSha256:generation.sha256,
        bytes:generation.bytes,
        identity:generation.identity,
        moduleCount:1
    });
}

async function importProvider(generation){
    const encoded=Buffer.from(generation.source,'utf8').toString('base64');
    const namespace=await import(`data:text/javascript;base64,${encoded}#${generation.sha256}`);
    return validateProvider(namespace);
}

async function authenticateRecord(record){
    if(record.poisoned){
        restartRequired('The integrated provider generation changed; start a new Arcane CLI process.');
    }
    try{
        await authenticateGenerationIdentity(record.generation);
    }catch(error){
        record.poisoned=true;
        record.state='poisoned';
        restartRequired(
            'The integrated provider generation became unavailable; start a new Arcane CLI process.',
            {causeCode:error?.code??null}
        );
    }
    return record;
}

async function initializeProviderRecord(record){
    record.state='loading';
    try{
        const canonicalRoot=await canonicalProviderRoot(record.requestedRoot);
        const generation=await readGeneration(canonicalRoot);
        record.canonicalRoot=canonicalRoot;
        record.generation=generation;
        record.importAttempted=true;
        const provider=await importProvider(generation);
        try{
            await authenticateGenerationIdentity(generation);
        }catch(error){
            record.poisoned=true;
            record.state='poisoned';
            restartRequired(
                'The integrated provider generation became unavailable while it was imported; start a new Arcane CLI process.',
                {causeCode:error?.code??null}
            );
        }
        record.provider=provider;
        record.state='ready';
        return record;
    }catch(error){
        if(!record.importAttempted){
            record.state='invalid';
            if(providerRecords.get(record.key)===record)providerRecords.delete(record.key);
        }else if(record.state!=='poisoned'){
            record.poisoned=true;
            record.state='poisoned';
        }
        throw error;
    }
}

function createProviderReservation({key,requestedRoot}){
    const record={
        key,
        requestedRoot,
        canonicalRoot:null,
        generation:null,
        provider:null,
        importAttempted:false,
        poisoned:false,
        state:'reserved',
        promise:null
    };
    record.promise=Promise.resolve().then(()=>initializeProviderRecord(record));
    record.promise.catch(()=>{});
    return record;
}

async function observeProviderRecord({record,stateAtInvocation,signal,onEvent,run}){
    await emit(onEvent,{
        type:'integrated.provider.loading',
        message:'Loading the fixed Arcane integrated development provider.'
    });
    if(stateAtInvocation==='poisoned'){
        restartRequired('The integrated provider generation changed; start a new Arcane CLI process.');
    }
    const ready=await waitForProviderInitialization(record.promise,signal);
    throwIfAborted(signal);
    await authenticateRecord(ready);
    const generation=publicGeneration(ready.generation);
    await emit(onEvent,{
        type:'integrated.provider.verified',
        message:'Verified the Arcane integrated development provider generation.',
        data:{contentSha256:generation.contentSha256,moduleCount:1}
    });

    async function describe(){
        await authenticateRecord(ready);
        const description=await ready.provider.describe();
        await authenticateRecord(ready);
        return description;
    }

    async function execute(request={}){
        throwIfAborted(request.signal);
        if(!REQUIRED_OPERATIONS.includes(request.operation)){
            fail(`Unsupported integrated operation: ${String(request.operation)}.`,ERROR_CODES.usage);
        }
        await authenticateRecord(ready);
        let result;
        let operationError;
        try{
            result=await ready.provider.execute({
                operation:request.operation,
                workspaceRoot:ready.canonicalRoot,
                ...(request.testFile===undefined?{}:{testFile:request.testFile}),
                signal:request.signal,
                onEvent:request.onEvent,
                run
            });
        }catch(error){
            operationError=error;
        }
        await authenticateRecord(ready);
        if(operationError)throw operationError;
        return result;
    }

    return Object.freeze({
        protocol:INTEGRATED_TOOLCHAIN_PROTOCOL,
        toolchainRoot:ready.canonicalRoot,
        providerGeneration:generation,
        describe,
        execute
    });
}

export function loadArcaneIntegratedProvider({
    arcaneRoot,
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    if(typeof run!=='function')fail('The integrated provider process runner must be a function.',ERROR_CODES.usage);
    if(typeof arcaneRoot!=='string'||!arcaneRoot.trim()){
        fail('An explicit Arcane OS root is required for shared development.',ERROR_CODES.usage);
    }
    const requestedRoot=path.resolve(arcaneRoot);
    const key=pathKey(requestedRoot);
    let record=providerRecords.get(key);
    const stateAtInvocation=record?.state??'created';
    if(!record){
        record=createProviderReservation({key,requestedRoot});
        providerRecords.set(key,record);
    }
    return observeProviderRecord({
        record,
        stateAtInvocation,
        signal,
        onEvent,
        run
    });
}
