import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {validateNativeBuilder} from './native-plan.mjs';

export const ARCANE_PORTABLE_PROVIDER_PATH=Object.freeze([
    'machine_bundles',
    'arcane-os-machine-bundle',
    'tools',
    'portable-native-provider.mjs'
]);

function fail(message,details){
    throw new ArcaneError(ERROR_CODES.targetUnavailable,message,{details});
}

function samePath(left,right){
    const normalize=value=>process.platform==='win32'
        ?path.normalize(value).toLowerCase()
        :path.normalize(value);
    return normalize(left)===normalize(right);
}

async function regularFile(filePath,inspect){
    try{
        const info=await inspect(filePath);
        return info.isFile()&&!info.isSymbolicLink();
    }catch(error){
        if(error?.code==='ENOENT')return false;
        throw error;
    }
}

export async function loadArcanePortableProvider({
    arcaneRoot,
    inspect=lstat,
    canonicalize=realpath,
    importModule=specifier=>import(specifier),
    signal,
    onEvent
}={}){
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({
        type:'native.provider.load.started',
        message:'Loading the explicitly selected Arcane portable provider.'
    }));
    if(typeof arcaneRoot!=='string'||!arcaneRoot.trim()){
        fail('The portable native provider requires an explicit Arcane OS checkout root.');
    }
    const requestedRoot=path.resolve(arcaneRoot);
    let canonicalRoot;
    try{
        const info=await inspect(requestedRoot);
        if(info.isSymbolicLink()||!info.isDirectory()){
            fail('The Arcane OS checkout root must be a real directory.',{arcaneRoot:requestedRoot});
        }
        canonicalRoot=await canonicalize(requestedRoot);
    }catch(error){
        if(error instanceof ArcaneError)throw error;
        if(error?.code==='ENOENT'){
            fail('The selected Arcane OS checkout root does not exist.',{arcaneRoot:requestedRoot});
        }
        throw error;
    }

    const requestedProvider=path.join(canonicalRoot,...ARCANE_PORTABLE_PROVIDER_PATH);
    if(!await regularFile(requestedProvider,inspect)){
        fail('The selected Arcane OS checkout does not contain the portable native provider.',{
            arcaneRoot:canonicalRoot,
            providerPath:requestedProvider
        });
    }
    const providerPath=await canonicalize(requestedProvider);
    if(!samePath(providerPath,requestedProvider)){
        fail('The Arcane portable provider path must not resolve through a linked location.',{
            providerPath:requestedProvider
        });
    }

    let namespace;
    try{
        namespace=await importModule(pathToFileURL(providerPath).href);
    }catch(error){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `The Arcane portable provider could not be loaded: ${error.message}`,
            {cause:error,details:{providerPath}}
        );
    }
    const nativeBuilder=validateNativeBuilder(
        namespace?.arcaneNativeBuilderProvider??namespace?.default
    );
    throwIfAborted(signal);
    await onEvent?.(Object.freeze({
        type:'native.provider.load.completed',
        message:'The Arcane portable provider is paired for this process.'
    }));
    return Object.freeze({
        arcaneRoot:canonicalRoot,
        toolchainRoot:canonicalRoot,
        providerPath,
        nativeBuilder
    });
}
