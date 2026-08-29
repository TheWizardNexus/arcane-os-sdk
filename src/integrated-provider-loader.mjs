import {stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {runProcess} from './process.mjs';

export const INTEGRATED_TOOLCHAIN_PROTOCOL='arcane-integrated-toolchain/1';
export const ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH=[
    'tools',
    'integrated-development-provider.mjs'
];

function fail(message,code=ERROR_CODES.operationFailed,details){
    throw new ArcaneError(code,message,{details});
}

async function emit(onEvent,event){
    await onEvent?.(event);
}

async function selectedProvider(arcaneRoot){
    if(typeof arcaneRoot!=='string'||!arcaneRoot.trim()){
        fail('An explicit Arcane OS root is required for shared development.',ERROR_CODES.usage);
    }
    const toolchainRoot=path.resolve(arcaneRoot);
    let rootInfo;
    try{rootInfo=await stat(toolchainRoot);}
    catch(error){
        if(error?.code==='ENOENT'){
            fail(`The Arcane OS root does not exist: ${toolchainRoot}.`,ERROR_CODES.workspaceInvalid);
        }
        throw error;
    }
    if(!rootInfo.isDirectory()){
        fail('The Arcane OS root must be a directory.',ERROR_CODES.workspaceInvalid);
    }
    const providerPath=path.join(toolchainRoot,...ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH);
    let providerInfo;
    try{providerInfo=await stat(providerPath);}
    catch(error){
        if(error?.code==='ENOENT'){
            fail(
                `The Arcane OS checkout does not provide ${ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH.join('/')}.`,
                ERROR_CODES.prerequisiteMissing
            );
        }
        throw error;
    }
    if(!providerInfo.isFile())fail('The integrated provider must be a file.');
    return {toolchainRoot,providerPath};
}

async function importedProvider(providerPath){
    const namespace=await import(pathToFileURL(providerPath).href);
    const provider=namespace?.integratedDevelopmentProvider;
    if(!provider||typeof provider!=='object'
        ||typeof provider.describe!=='function'
        ||typeof provider.prepare!=='function'
        ||typeof provider.execute!=='function'){
        fail('The integrated provider must export integratedDevelopmentProvider.');
    }
    return provider;
}

export async function loadArcaneIntegratedProvider({
    arcaneRoot,
    signal,
    onEvent,
    run=runProcess
}={}){
    throwIfAborted(signal);
    if(typeof run!=='function'){
        fail('The integrated provider process runner must be a function.',ERROR_CODES.usage);
    }
    await emit(onEvent,{
        type:'integrated.provider.loading',
        message:'Loading the selected Arcane integrated development provider.'
    });
    const selected=await selectedProvider(arcaneRoot);
    const provider=await importedProvider(selected.providerPath);
    throwIfAborted(signal);
    await emit(onEvent,{
        type:'integrated.provider.loaded',
        message:'Loaded the selected Arcane integrated development provider.',
        data:{location:selected.providerPath}
    });

    return {
        protocol:provider.protocol??INTEGRATED_TOOLCHAIN_PROTOCOL,
        toolchainRoot:selected.toolchainRoot,
        describe(){
            return provider.describe();
        },
        execute(request={}){
            throwIfAborted(request.signal);
            return provider.execute({
                ...request,
                workspaceRoot:selected.toolchainRoot,
                run
            });
        }
    };
}
