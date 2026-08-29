import {lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const TESTING_SPECIFIER='arcane-os/testing';
const TESTING_URL=new URL('./testing.mjs',import.meta.url).href;
const RUNTIME_STRONG_TYPE_SPECIFIER='../../node_modules/strong-type/index.js';
const RUNTIME_ARCANE_URL=new URL('../runtime/arcane/',import.meta.url).href;
const STRONG_TYPE_URL=new URL('../runtime/strong-type/index.js',import.meta.url).href;
const MANAGED_IMPORT_MAP_PROTOCOL='arcane-test-import-map/1';
const MANAGED_IMPORT_MAP_BOUNDARIES=new Set(['source','dist','test']);

let managedImports=null;
let managedUrlImports=null;

function loaderFailure(message,code='ARCANE_IMPORT_MAP_INVALID'){
    const error=new Error(message);
    error.code=code;
    throw error;
}

function urlLikeSpecifier(specifier){
    return specifier.startsWith('./')||specifier.startsWith('../')
        ||specifier.startsWith('/')||/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier);
}

function safeManagedTarget(target){
    return typeof target==='string'
        &&target.startsWith('./')
        &&target.length>2
        &&!/[\\%?#\u0000-\u001f\u007f]/u.test(target)
        &&target.slice(2).split('/').every(
            segment=>segment!==''&&segment!=='.'&&segment!=='..'
        );
}

function samePath(left,right){
    const a=path.resolve(left);
    const b=path.resolve(right);
    return process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
}

function pathInside(root,candidate){
    const relative=path.relative(root,candidate);
    return relative===''||(!path.isAbsolute(relative)&&relative!=='..'
        &&!relative.startsWith(`..${path.sep}`));
}

function physicalDirectory(baseURL){
    let parsed;
    try{parsed=new URL(baseURL);}
    catch{loaderFailure('Managed test import-map base URL is invalid.');}
    if(parsed.protocol!=='file:'||parsed.username||parsed.password||parsed.search||parsed.hash
        ||!parsed.pathname.endsWith('/')){
        loaderFailure('Managed test import-map base URL must select one application directory.');
    }
    const root=fileURLToPath(parsed);
    let info;
    let canonical;
    try{
        info=lstatSync(root);
        canonical=realpathSync(root);
    }catch(error){
        loaderFailure(`Managed test import-map application directory is unavailable: ${error.message}`);
    }
    if(info.isSymbolicLink()||!info.isDirectory()||!samePath(root,canonical)){
        loaderFailure('Managed test import-map base must be one real application directory.');
    }
    return {url:parsed,root:canonical};
}

function physicalManagedTarget(target,specifier,boundary,boundaryName){
    const relative=target.slice(2);
    if(boundaryName==='source'&&/^(?:dist|test)\//u.test(relative)){
        loaderFailure(
            `Managed source import-map target selects a different application boundary: ${specifier}.`,
            'ARCANE_IMPORT_MAP_UNRESOLVED'
        );
    }
    let targetURL;
    try{targetURL=new URL(target,boundary.url);}
    catch{loaderFailure(`Managed test import-map target is invalid: ${specifier}.`);}
    if(targetURL.protocol!=='file:'||targetURL.username||targetURL.password
        ||targetURL.search||targetURL.hash){
        loaderFailure(`Managed test import-map target is invalid: ${specifier}.`);
    }
    const targetPath=fileURLToPath(targetURL);
    let info;
    let canonical;
    try{
        info=lstatSync(targetPath);
        canonical=realpathSync(targetPath);
    }catch(error){
        loaderFailure(
            `Managed test import-map target is unavailable for ${specifier}: ${error.message}`,
            'ARCANE_IMPORT_MAP_UNRESOLVED'
        );
    }
    if(info.isSymbolicLink()||!info.isFile()||!samePath(targetPath,canonical)
        ||!pathInside(boundary.root,canonical)){
        loaderFailure(
            `Managed test import-map target leaves its selected application directory: ${specifier}.`,
            'ARCANE_IMPORT_MAP_UNRESOLVED'
        );
    }
    return targetURL.href;
}

export function initialize({managedImportMap}={}){
    if(managedImportMap==null){
        managedImports=null;
        managedUrlImports=null;
        return;
    }
    const imports=managedImportMap.imports;
    if(managedImportMap.protocol!==MANAGED_IMPORT_MAP_PROTOCOL
        ||!MANAGED_IMPORT_MAP_BOUNDARIES.has(managedImportMap.boundary)
        ||imports===null||typeof imports!=='object'||Array.isArray(imports)){
        loaderFailure('Managed test import-map loader data is malformed.');
    }
    const boundary=physicalDirectory(managedImportMap.baseURL);
    const exact=new Map();
    const urls=new Map();
    for(const [specifier,target] of Object.entries(imports)){
        if(typeof specifier!=='string'||specifier===''||!safeManagedTarget(target)){
            loaderFailure(`Managed test import-map entry is invalid: ${String(specifier)}.`);
        }
        const targetURL=physicalManagedTarget(
            target,
            specifier,
            boundary,
            managedImportMap.boundary
        );
        exact.set(specifier,targetURL);
        if(urlLikeSpecifier(specifier)){
            let keyURL;
            try{keyURL=new URL(specifier,boundary.url).href;}
            catch{loaderFailure(`Managed test import-map URL key is invalid: ${specifier}.`);}
            if(urls.has(keyURL)&&urls.get(keyURL)!==targetURL){
                loaderFailure(`Managed test import-map URL keys collide: ${specifier}.`);
            }
            urls.set(keyURL,targetURL);
        }
    }
    managedImports=exact;
    managedUrlImports=urls;
}

function managedResolution(specifier,context){
    if(managedImports===null)return null;
    if(managedImports.has(specifier))return managedImports.get(specifier);
    if(urlLikeSpecifier(specifier)&&typeof context.parentURL==='string'){
        let requested;
        try{requested=new URL(specifier,context.parentURL).href;}
        catch{requested=null;}
        if(requested!==null&&managedUrlImports.has(requested)){
            return managedUrlImports.get(requested);
        }
    }
    if(specifier.startsWith('arcane/')||specifier.startsWith('#arcane/')){
        loaderFailure(
            `Managed test import map does not expose ${specifier}.`,
            'ARCANE_IMPORT_MAP_UNRESOLVED'
        );
    }
    return null;
}

export function resolve(specifier,context,nextResolve){
    if(specifier===TESTING_SPECIFIER){
        return {url:TESTING_URL,shortCircuit:true};
    }
    const managed=managedResolution(specifier,context);
    if(managed!==null)return {url:managed,shortCircuit:true};
    if(specifier===RUNTIME_STRONG_TYPE_SPECIFIER
        &&context.parentURL?.startsWith(RUNTIME_ARCANE_URL)){
        return {url:STRONG_TYPE_URL,shortCircuit:true};
    }
    return nextResolve(specifier,context);
}
