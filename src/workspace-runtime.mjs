import Is from 'strong-type';
import {randomUUID} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {SDK_VERSION} from './constants.mjs';
import {rewriteAssetReferences} from './import-map.mjs';
import {getSdkRoot} from './runtime.mjs';
import {getSdkBrowserRuntimeRoot} from './sdk-browser-runtime.mjs';

const is = new Is(false);

const STAGING_PREFIX='.arcane-runtime-content-staging-';
const BACKUP_PREFIX='.arcane-runtime-content-backup-';

function fail(message,code='ARCANE_WORKSPACE_RUNTIME_INVALID'){
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
    if(is.function(onEvent))await onEvent(event);
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
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

async function copyCompleteEntry(source,destination,label,signal){
    throwIfAborted(signal);
    const info=await lstat(source);
    if(info.isSymbolicLink())fail(`${label} must not contain a symbolic link or junction.`);
    if(info.isFile()){
        if(/\.(?:m?js|html?|css)$/iu.test(source)){
            const original=await readFile(source,'utf8');
            const content=rewriteAssetReferences(original,{filePath:source,version:null});
            await writeFile(destination,content,'utf8');
        }else{
            await copyFile(source,destination);
        }
        return;
    }
    if(!info.isDirectory())fail(`${label} contains a non-file entry.`);
    await mkdir(destination,{recursive:true});
    const entries=await readdir(source,{withFileTypes:true});
    entries.sort((left,right)=>compareText(left.name,right.name));
    for(const entry of entries){
        throwIfAborted(signal);
        await copyCompleteEntry(
            path.join(source,entry.name),
            path.join(destination,entry.name),
            `${label}/${entry.name}`,
            signal
        );
    }
}

async function removeTemporaryTree(location){
    await rm(location,{recursive:true,force:true}).catch(()=>{});
}

async function materializeBrowserDecisions(destination, signal, onEvent) {
    const transformers = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/';
    const onnx = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/';
    const files = [
        {name: 'transformers.min.js', url: `${transformers}dist/transformers.min.js`},
        {name: 'ort-wasm-simd-threaded.asyncify.mjs', url: `${onnx}dist/ort-wasm-simd-threaded.asyncify.mjs`},
        {name: 'ort-wasm-simd-threaded.asyncify.wasm', url: `${onnx}dist/ort-wasm-simd-threaded.asyncify.wasm`},
        {name: 'TRANSFORMERS-LICENSE', url: `${transformers}LICENSE`},
        {name: 'ONNX-RUNTIME-LICENSE', url: `${onnx}LICENSE`}
    ];
    const controller = new AbortController();
    function cancelDistribution() {
        controller.abort(signal.reason);
    }
    signal?.addEventListener('abort', cancelDistribution, {once: true});
    if (signal?.aborted) cancelDistribution();
    let completed = 0;
    try {
        throwIfAborted(controller.signal);
        await emit(
            onEvent,
            {type: 'workspace.decisions.started', completed, total: files.length}
        );
        throwIfAborted(controller.signal);
        await mkdir(destination, {recursive: true});
        async function acquireDistributionFile(file) {
            try {
                throwIfAborted(controller.signal);
                const response = await fetch(file.url, {signal: controller.signal});
                const content = new Uint8Array(await response.arrayBuffer());
                if (!response.ok) {
                    const error = new Error(`Browser decision distribution returned HTTP ${response.status} ${response.statusText}.`);
                    error.code = 'ARCANE_DECISION_DISTRIBUTION_DOWNLOAD_FAILED';
                    error.response = {
                        url: response.url,
                        status: response.status,
                        statusText: response.statusText,
                        headers: [...response.headers],
                        content
                    };
                    throw error;
                }
                throwIfAborted(controller.signal);
                // Upstream distribution content is opaque, including its own
                // imports and license text. No SDK source rewriting applies.
                await writeFile(path.join(destination, file.name), content);
                throwIfAborted(controller.signal);
                completed += 1;
                await emit(
                    onEvent,
                    {type: 'workspace.decisions.progress', file: file.name, url: file.url, completed, total: files.length}
                );
            } catch (error) {
                controller.abort(error);
                throw error;
            }
        }
        // One fixed distribution, acquired once for the selected projection;
        // no model/app/architecture multiplier or installation script.
        const outcomes = await Promise.allSettled(files.map(acquireDistributionFile));
        const failures = new Set();
        for (const outcome of outcomes) {
            if (outcome.status === 'rejected') failures.add(outcome.reason);
        }
        if (failures.size === 1) throw [...failures][0];
        if (failures.size > 1) {
            throw new AggregateError([...failures], 'Browser decision distribution acquisition failed.');
        }
        throwIfAborted(controller.signal);
    } finally {
        signal?.removeEventListener('abort', cancelDistribution);
    }
    return {
        transformersVersion: '4.3.0',
        onnxRuntimeVersion: '1.31.0-dev.20260914-8d85527a0',
        files: files.map(function distributionFilename(file) { return file.name; })
    };
}

export async function materializeWorkspaceRuntimeContent({
    workspaceRoot,
    runtimeRoot=path.join(getSdkRoot(),'runtime'),
    browserRuntimeRoot=getSdkBrowserRuntimeRoot(),
    sdkVersion=SDK_VERSION,
    browserDecisions=false,
    signal,
    onEvent
}={}){
    if(!workspaceRoot)fail('workspaceRoot is required to materialize a workspace runtime.');
    if(!is.boolean(browserDecisions))throw new TypeError('browserDecisions must be a boolean.');
    throwIfAborted(signal);
    const workspace=await realDirectory(workspaceRoot,'Workspace root');
    const runtime=await realDirectory(runtimeRoot,'SDK runtime root');
    const browserRuntime=await realDirectory(browserRuntimeRoot,'SDK browser runtime root');
    const runtimeArcane=await realDirectory(path.join(runtime,'arcane'),'SDK Arcane runtime');
    const runtimeStrongType=await realDirectory(
        path.join(runtime,'strong-type'),
        'SDK strong-type runtime'
    );
    const destinationRoot=path.join(workspace,'arcane');
    const token=randomUUID();
    const stagingRoot=path.join(workspace,`${STAGING_PREFIX}${token}`);
    const backupRoot=path.join(workspace,`${BACKUP_PREFIX}${token}`);
    let backedUp=false;
    let promoted=false;
    let decisionDistribution;

    await mkdir(stagingRoot);
    try{
        await copyCompleteEntry(runtimeArcane,stagingRoot,'SDK Arcane runtime',signal);
        await mkdir(path.join(stagingRoot,'dependencies'),{recursive:true});
        await copyCompleteEntry(
            runtimeStrongType,
            path.join(stagingRoot,'dependencies','strong-type'),
            'SDK strong-type runtime',
            signal
        );
        const sdkDestination=path.join(stagingRoot,'sdk');
        await mkdir(sdkDestination,{recursive:true});
        const browserEntries=await readdir(browserRuntime,{withFileTypes:true});
        browserEntries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of browserEntries){
            throwIfAborted(signal);
            await copyCompleteEntry(
                path.join(browserRuntime,entry.name),
                path.join(sdkDestination,entry.name),
                `SDK browser runtime/${entry.name}`,
                signal
            );
        }

        if (browserDecisions) {
            decisionDistribution = await materializeBrowserDecisions(
                path.join(sdkDestination, 'ai', 'decisions-runtime'),
                signal,
                onEvent
            );
        }

        throwIfAborted(signal);
        try{
            const existing=await lstat(destinationRoot);
            if(existing.isSymbolicLink()||!existing.isDirectory()){
                fail('Workspace Arcane runtime destination must be a real directory when present.');
            }
            await rename(destinationRoot,backupRoot);
            backedUp=true;
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
        }

        await rename(stagingRoot,destinationRoot);
        promoted=true;
        await emit(onEvent,{
            type:'workspace.runtime.materialized',
            workspaceRoot:workspace,
            runtimeRoot:destinationRoot
        });
        if(backedUp){
            await rm(backupRoot,{recursive:true});
            backedUp=false;
        }
        return {
            kind:'arcane-workspace-runtime-content',
            workspaceRoot:workspace,
            runtimeRoot:destinationRoot,
            ...(decisionDistribution ? {
                browserDecisions: {
                    ...decisionDistribution,
                    directory: path.join(destinationRoot, 'sdk', 'ai', 'decisions-runtime')
                }
            } : {})
        };
    }catch(error){
        if(promoted)await removeTemporaryTree(destinationRoot);
        if(backedUp){
            try{await rename(backupRoot,destinationRoot);}
            catch(rollbackError){
                throw new AggregateError(
                    [error,rollbackError],
                    'Workspace runtime materialization and rollback both failed.',
                    {cause:error}
                );
            }
        }
        throw error;
    }finally{
        await removeTemporaryTree(stagingRoot);
        if(!backedUp||promoted)await removeTemporaryTree(backupRoot);
    }
}
