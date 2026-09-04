import {lstat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {validateNativeBuilder} from './native-plan.mjs';

const PROVIDER_ROOT=['machine_bundles','arcane-os-machine-bundle','tools'];

function providerPath(fileName){
    return [...PROVIDER_ROOT,fileName];
}

const linuxProviderPath=providerPath('linux-native-provider.mjs');
const FIXED_NATIVE_PROVIDER_PATHS={
    portable:providerPath('portable-native-provider.mjs'),
    'windows-x64':providerPath('windows-native-provider.mjs'),
    'linux-x64':linuxProviderPath,
    'linux-arm64':linuxProviderPath,
    'android-arm64':providerPath('android-native-provider.mjs')
};

export const ARCANE_NATIVE_PROVIDER_PATHS={
    portable:[...FIXED_NATIVE_PROVIDER_PATHS.portable],
    'windows-x64':[...FIXED_NATIVE_PROVIDER_PATHS['windows-x64']],
    'linux-x64':[...FIXED_NATIVE_PROVIDER_PATHS['linux-x64']],
    'linux-arm64':[...FIXED_NATIVE_PROVIDER_PATHS['linux-arm64']],
    'android-arm64':[...FIXED_NATIVE_PROVIDER_PATHS['android-arm64']]
};

function fail(message,details){
    throw new ArcaneError(ERROR_CODES.targetUnavailable,message,{details});
}

function importProviderModule(specifier){
    return import(specifier);
}

function insideRoot(root,candidate){
    const relative=path.relative(root,candidate);
    return relative===''||Boolean(
        relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)
    );
}

async function resolveProviderLocation({
    arcaneRoot,
    target,
    inspect=lstat,
    canonicalize=realpath
}={}){
    const relativeProviderPath=FIXED_NATIVE_PROVIDER_PATHS[target];
    if(!relativeProviderPath){
        fail(`No Arcane native provider is registered for target ${String(target)}.`,{
            target,
            supportedTargets:Object.keys(FIXED_NATIVE_PROVIDER_PATHS)
        });
    }
    if(typeof arcaneRoot!=='string'||!arcaneRoot.trim()){
        fail(`The ${target} native provider requires an Arcane OS checkout root.`);
    }
    if(typeof inspect!=='function'||typeof canonicalize!=='function'){
        fail('The Arcane native provider loader dependencies are invalid.');
    }
    const requestedRoot=path.resolve(arcaneRoot);
    let rootInfo;
    try{rootInfo=await inspect(requestedRoot);}
    catch(error){
        if(error?.code==='ENOENT')fail('The selected Arcane OS checkout does not exist.',{
            arcaneRoot:requestedRoot
        });
        throw error;
    }
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        fail('The Arcane OS checkout root must be a real directory.',{arcaneRoot:requestedRoot});
    }
    const canonicalRoot=await canonicalize(requestedRoot);
    let current=canonicalRoot;
    for(const [index,segment] of relativeProviderPath.entries()){
        current=path.join(current,segment);
        let info;
        try{info=await inspect(current);}
        catch(error){
            if(error?.code==='ENOENT')fail('The selected Arcane native provider does not exist.',{
                providerPath:current
            });
            throw error;
        }
        if(info.isSymbolicLink()){
            fail('The Arcane native provider path must not contain links or junctions.',{
                providerPath:current
            });
        }
        const last=index===relativeProviderPath.length-1;
        if(last?!info.isFile():!info.isDirectory()){
            fail('The Arcane native provider path contains a non-file entry.',{
                providerPath:current
            });
        }
    }
    const canonicalProvider=await canonicalize(current);
    if(!insideRoot(canonicalRoot,canonicalProvider)){
        fail('The Arcane native provider resolves outside its checkout.',{
            providerPath:canonicalProvider
        });
    }
    return {canonicalRoot,providerPath:canonicalProvider};
}

export async function loadArcaneNativeProvider(options={}){
    if(options===null||typeof options!=='object'||Array.isArray(options)){
        fail('Arcane native provider options must be an object.');
    }
    const {
        arcaneRoot,
        target,
        inspect=lstat,
        canonicalize=realpath,
        importModule=importProviderModule,
        signal,
        onEvent
    }=options;
    throwIfAborted(signal);
    if(typeof importModule!=='function')fail('The Arcane native provider importer is invalid.');
    await onEvent?.({
        type:'native.provider.load.started',
        target,
        message:`Loading the Arcane ${String(target)} provider.`
    });
    const location=await resolveProviderLocation({arcaneRoot,target,inspect,canonicalize});
    throwIfAborted(signal);
    let namespace;
    try{
        namespace=await importModule(pathToFileURL(location.providerPath).href);
    }catch(error){
        if(error instanceof ArcaneError)throw error;
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `The Arcane ${target} provider could not be loaded: ${error.message}`,
            {cause:error,details:{providerPath:location.providerPath}}
        );
    }
    const nativeBuilder=validateNativeBuilder(
        namespace?.arcaneNativeBuilderProvider??namespace?.default
    );
    throwIfAborted(signal);
    const pairing={
        arcaneRoot:location.canonicalRoot,
        toolchainRoot:location.canonicalRoot,
        providerPath:location.providerPath,
        nativeBuilder
    };
    await onEvent?.({
        type:'native.provider.load.completed',
        target,
        message:`The Arcane ${String(target)} provider is ready.`
    });
    return pairing;
}
