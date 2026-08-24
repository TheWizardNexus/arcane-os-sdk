import {lstat,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {verifyRuntime} from './runtime.mjs';
import {verifySdkBrowserRuntime} from './sdk-browser-runtime.mjs';
import {materializeWorkspaceRuntime} from './workspace-runtime.mjs';
import {generateImportMap} from './import-map.mjs';
import {withWorkspaceOperationLock} from './workspace-operation-lock.mjs';
import {SDK_NAME,SDK_VERSION,workspaceTemplate} from './templates/workspace-template.mjs';
import {inspectWorkspaceProfile} from './workspace.mjs';
import {parseSemver} from './packager/core.mjs';

const APP_ID_PATTERN=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const DISPLAY_CONTROL_PATTERN=/[\x00-\x1f\x7f]/;
const LOCAL_TARBALL_PATTERN=/^file:.+\.tgz$/iu;

function fail(message,code='ARCANE_WORKSPACE_INVALID'){
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

function validateInputs(appId,displayName){
    if(typeof appId!=='string'||!APP_ID_PATTERN.test(appId)){
        fail(`Invalid app id: ${String(appId)}. Use lowercase words separated by hyphens.`,'ARCANE_USAGE');
    }
    if(displayName!==undefined&&(typeof displayName!=='string'||displayName!==displayName.trim()
        ||!displayName||displayName.length>160||DISPLAY_CONTROL_PATTERN.test(displayName)
        ||/[<>]/.test(displayName))){
        fail('displayName must be plain trimmed text no longer than 160 characters.','ARCANE_USAGE');
    }
}

function validateScaffoldTarget(target){
    const targets=['browser','portable','windows-x64','linux-x64','linux-arm64','android-arm64'];
    if(!targets.includes(target)){
        fail(`Invalid scaffold target: ${String(target)}. Expected one of ${targets.join(', ')}.`,'ARCANE_USAGE');
    }
}

async function scaffoldIcon(target){
    return target!=='browser'
        ?readFile(new URL('./templates/assets/app-icon.png',import.meta.url))
        :undefined;
}

async function assertCreateTarget(targetPath){
    try{
        const info=await lstat(targetPath);
        if(info.isSymbolicLink()||!info.isDirectory())fail(`Scaffold target must be a real directory: ${targetPath}.`);
        const entries=await readdir(targetPath);
        if(entries.length)fail(`Scaffold target is not empty: ${targetPath}. Refusing to overwrite it.`);
    }catch(error){
        if(error?.code!=='ENOENT')throw error;
        let ancestor=path.dirname(targetPath);
        while(true){
            try{
                const info=await lstat(ancestor);
                if(info.isSymbolicLink()||!info.isDirectory()){
                    fail(`Scaffold target has a linked or non-directory ancestor: ${ancestor}.`);
                }
                break;
            }catch(ancestorError){
                if(ancestorError?.code!=='ENOENT')throw ancestorError;
                const parent=path.dirname(ancestor);
                if(parent===ancestor)throw ancestorError;
                ancestor=parent;
            }
        }
        await mkdir(targetPath,{recursive:true});
        const info=await lstat(targetPath);
        if(info.isSymbolicLink()||!info.isDirectory())fail(`Scaffold target must be a real directory: ${targetPath}.`);
    }
}

async function assertInitTarget(workspaceRoot){
    let info;
    try{
        info=await lstat(workspaceRoot);
    }catch(error){
        if(error?.code==='ENOENT')fail(`Workspace does not exist: ${workspaceRoot}.`);
        throw error;
    }
    if(info.isSymbolicLink()||!info.isDirectory())fail(`Workspace must be a real directory: ${workspaceRoot}.`);
}

async function existingWorkspaceProfile(workspaceRoot){
    const configPath=path.join(workspaceRoot,'arcane-packager.json');
    try{
        const info=await lstat(configPath);
        if(info.isSymbolicLink()||!info.isFile()){
            fail('arcane-packager.json must be a real file when present.');
        }
    }catch(error){
        if(error?.code==='ENOENT')return null;
        throw error;
    }
    return inspectWorkspaceProfile(workspaceRoot);
}

async function integratedCoreVersion(workspaceRoot){
    const manifestPath=path.join(
        workspaceRoot,
        'machine_bundles',
        'arcane-os-machine-bundle',
        'package.json'
    );
    let manifest;
    try{
        const info=await lstat(manifestPath);
        if(info.isSymbolicLink()||!info.isFile())fail('The integrated Arcane machine package must be a real file.');
        manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    }catch(error){
        if(error?.code==='ENOENT'){
            fail('The integrated Arcane workspace is missing its machine-bundle package identity.');
        }
        if(error instanceof SyntaxError)fail(`The integrated Arcane machine package is not valid JSON: ${error.message}`);
        throw error;
    }
    if(manifest?.name!=='arcane-os-machine-bundle'){
        fail('The integrated Arcane machine package identity is invalid.');
    }
    parseSemver(manifest.version);
    return manifest.version;
}

async function assertNoLinkedAncestors(workspaceRoot,relative){
    const segments=relative.split('/');
    let current=workspaceRoot;
    for(const segment of segments.slice(0,-1)){
        current=path.join(current,segment);
        try{
            const info=await lstat(current);
            if(info.isSymbolicLink()||!info.isDirectory()){
                fail(`Refusing to traverse a linked or non-directory ancestor: ${path.relative(workspaceRoot,current).replaceAll('\\','/')}.`);
            }
        }catch(error){
            if(error?.code==='ENOENT')return;
            throw error;
        }
    }
}

function isSupportedSdkDeclaration(value){
    return value===SDK_VERSION||(typeof value==='string'&&LOCAL_TARBALL_PATTERN.test(value)
        &&!DISPLAY_CONTROL_PATTERN.test(value));
}

async function prepareExistingPackage(workspaceRoot,files){
    const packagePath=path.join(workspaceRoot,'package.json');
    let source;
    try{source=await readFile(packagePath,'utf8');}
    catch(error){
        if(error?.code==='ENOENT')return Object.freeze({exists:false,updated:false});
        throw error;
    }
    let existing;
    try{existing=JSON.parse(source);}
    catch(error){fail(`Existing package.json is not valid JSON: ${error.message}.`);}
    if(!existing||typeof existing!=='object'||Array.isArray(existing))fail('Existing package.json must be a JSON object.');
    const generated=JSON.parse(files.get('package.json'));
    const conflicts=[];
    if(existing.private!==undefined&&existing.private!==true)conflicts.push('private must be true');
    if(existing.type!==undefined&&existing.type!=='module')conflicts.push('type must be "module"');
    const declared=existing.devDependencies?.[SDK_NAME]??existing.dependencies?.[SDK_NAME];
    if(declared!==undefined&&!isSupportedSdkDeclaration(declared)){
        conflicts.push(`${SDK_NAME} must be ${SDK_VERSION} or a local file: tarball`);
    }
    const appSelectionScripts=new Set(['build','run']);
    for(const [name,command] of Object.entries(generated.scripts)){
        if(appSelectionScripts.has(name))continue;
        if(existing.scripts?.[name]!==undefined&&existing.scripts[name]!==command){
            conflicts.push(`scripts.${name} must be "${command}"`);
        }
    }
    if(conflicts.length){
        fail(`Existing package.json conflicts with Arcane setup; no values were overwritten. Resolve: ${conflicts.join('; ')}.`);
    }
    const merged={
        ...existing,
        private:true,
        type:'module',
        scripts:{...generated.scripts,...(existing.scripts||{})},
        devDependencies:{...(existing.devDependencies||{}),[SDK_NAME]:declared??SDK_VERSION},
        engines:{...generated.engines,...(existing.engines||{})}
    };
    if(existing.dependencies?.[SDK_NAME]!==undefined){
        merged.dependencies={...existing.dependencies};
        delete merged.dependencies[SDK_NAME];
        if(Object.keys(merged.dependencies).length===0)delete merged.dependencies;
    }
    if(JSON.stringify(existing)===JSON.stringify(merged)){
        return Object.freeze({exists:true,updated:false});
    }
    return Object.freeze({
        exists:true,
        updated:true,
        packagePath,
        source,
        content:`${JSON.stringify(merged,null,2)}\n`
    });
}

async function applyPackageMerge(workspaceRoot,plan,{signal,onEvent}){
    if(!plan.updated)return false;
    throwIfAborted(signal);
    await assertNoLinkedAncestors(workspaceRoot,'package.json');
    const packageInfo=await lstat(plan.packagePath);
    if(packageInfo.isSymbolicLink()||!packageInfo.isFile())fail('Existing package.json must be a real file.');
    if(await readFile(plan.packagePath,'utf8')!==plan.source){
        fail('Existing package.json changed after Arcane preflight; no values were overwritten. Retry arcane init.');
    }
    await writeFile(plan.packagePath,plan.content,'utf8');
    await emit(onEvent,{type:'scaffold.file.merged',path:'package.json'});
    return true;
}

async function writeMissingFiles(workspaceRoot,files,{signal,onEvent}){
    const createdFiles=[];
    const skippedFiles=[];
    const entries=[];
    for(const [relative,content] of files){
        throwIfAborted(signal);
        const destination=path.resolve(workspaceRoot,...relative.split('/'));
        const boundary=path.relative(workspaceRoot,destination);
        if(boundary.startsWith('..')||path.isAbsolute(boundary))fail(`Template path escapes the workspace: ${relative}.`);
        await assertNoLinkedAncestors(workspaceRoot,relative);
        let exists=false;
        try{
            const info=await lstat(destination);
            if(info.isSymbolicLink())fail(`Refusing to write through a symbolic link: ${relative}.`);
            if(!info.isFile())fail(`Template file path is occupied by a non-file entry: ${relative}.`);
            exists=true;
        }catch(error){
            if(error?.code!=='ENOENT')throw error;
        }
        entries.push({relative,content,destination,exists});
    }
    for(const {relative,content,destination,exists} of entries){
        throwIfAborted(signal);
        if(exists){
            skippedFiles.push(relative);
            await emit(onEvent,{type:'scaffold.file.skipped',path:relative});
            continue;
        }
        await mkdir(path.dirname(destination),{recursive:true});
        await assertNoLinkedAncestors(workspaceRoot,relative);
        await writeFile(destination,content,{encoding:'utf8',flag:'wx'});
        createdFiles.push(relative);
        await emit(onEvent,{type:'scaffold.file.created',path:relative});
    }
    return {createdFiles,skippedFiles};
}

async function assertExistingLockAdmission(workspaceRoot,files){
    const expected=files.get('arcane.lock.json');
    if(typeof expected!=='string')return;
    const lockPath=path.join(workspaceRoot,'arcane.lock.json');
    let info;
    try{
        info=await lstat(lockPath);
    }catch(error){
        if(error?.code==='ENOENT')return;
        throw error;
    }
    if(info.isSymbolicLink()||!info.isFile()){
        fail('Existing arcane.lock.json must be a real file.');
    }
    if(await readFile(lockPath,'utf8')!==expected){
        fail(
            'Existing arcane.lock.json does not match the authenticated SDK runtime '
            +'admission. Remove or reconcile it before running arcane init; Arcane never '
            +'overwrites a lock implicitly.'
        );
    }
}

async function runGitInit(workspaceRoot,signal,onEvent){
    throwIfAborted(signal);
    await emit(onEvent,{type:'scaffold.git.started',command:'git init -b main'});
    return new Promise((resolve,reject)=>{
        throwIfAborted(signal);
        const child=spawn('git',['init','-b','main'],{
            cwd:workspaceRoot,
            shell:false,
            stdio:['ignore','pipe','pipe'],
            windowsHide:true
        });
        let stderr='';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data',chunk=>{stderr+=chunk;});
        const abort=()=>child.kill();
        signal?.addEventListener('abort',abort,{once:true});
        child.once('error',error=>{
            signal?.removeEventListener('abort',abort);
            reject(error);
        });
        child.once('close',code=>{
            signal?.removeEventListener('abort',abort);
            if(signal?.aborted){
                try{throwIfAborted(signal);}catch(error){reject(error);}
                return;
            }
            if(code!==0){
                const error=new Error(`git init failed with exit code ${code}: ${stderr.trim()}`);
                error.code='ARCANE_OPERATION_FAILED';
                reject(error);
                return;
            }
            void emit(onEvent,{type:'scaffold.git.completed'}).then(resolve,reject);
        });
    });
}

export async function createWorkspace({
    targetPath,
    appId,
    displayName,
    target='browser',
    initializeGit=false,
    signal,
    onEvent
}){
    validateInputs(appId,displayName);
    validateScaffoldTarget(target);
    if(typeof targetPath!=='string'||!targetPath.trim())fail('targetPath is required.','ARCANE_USAGE');
    if(typeof initializeGit!=='boolean')fail('initializeGit must be a boolean.','ARCANE_USAGE');
    throwIfAborted(signal);
    const workspaceRoot=path.resolve(targetPath);
    await emit(onEvent,{type:'scaffold.started',mode:'create',workspaceRoot,appId,target});
    await assertCreateTarget(workspaceRoot);
    const receipt=await withWorkspaceOperationLock({
        workspaceRoot,
        operation:'scaffold-create',
        signal,
        onEvent
    },async workspaceOperationLease=>{
    const runtimeReceipt=await verifyRuntime({signal,onEvent});
    const sdkBrowserRuntimeReceipt=await verifySdkBrowserRuntime({signal,onEvent});
    const template=workspaceTemplate({
        appId,
        displayName,
        runtimeRelease:runtimeReceipt,
        sdkBrowserRuntimeRelease:sdkBrowserRuntimeReceipt,
        target,
        appIcon:await scaffoldIcon(target)
    });
    const result=await writeMissingFiles(workspaceRoot,template.files,{signal,onEvent});
    const workspaceRuntimeReceipt=await materializeWorkspaceRuntime({
        workspaceRoot,
        runtimeRoot:runtimeReceipt.canonicalLocation,
        runtimeReceipt,
        browserRuntimeRoot:sdkBrowserRuntimeReceipt.canonicalLocation,
        sdkBrowserRuntimeReceipt,
        signal,
        onEvent
    });
    const importMap=await generateImportMap({
        workspaceRoot,
        appId,
        appRoot:path.join(workspaceRoot,'apps',appId),
        workspaceRuntimeReceipt,
        workspaceOperationLease,
        signal,
        onEvent
    });
    if(initializeGit)await runGitInit(workspaceRoot,signal,onEvent);
    const receipt={
        workspaceRoot,
        appId,
        displayName:template.name,
        target,
        ...result,
        workspaceRuntime:workspaceRuntimeReceipt,
        importMap,
        gitInitialized:Boolean(initializeGit)
    };
    return receipt;
    });
    await emit(onEvent,{type:'scaffold.completed',...receipt});
    return receipt;
}

export async function initWorkspace({
    workspaceRoot=process.cwd(),
    appId,
    displayName,
    target='browser',
    signal,
    onEvent
}){
    validateInputs(appId,displayName);
    validateScaffoldTarget(target);
    throwIfAborted(signal);
    const resolvedRoot=path.resolve(workspaceRoot);
    await emit(onEvent,{type:'scaffold.started',mode:'init',workspaceRoot:resolvedRoot,appId,target});
    await assertInitTarget(resolvedRoot);
    const receipt=await withWorkspaceOperationLock({
        workspaceRoot:resolvedRoot,
        operation:'scaffold-init',
        signal,
        onEvent
    },async workspaceOperationLease=>{
    const profile=await existingWorkspaceProfile(resolvedRoot);
    const workspaceMode=profile?.workspaceMode??'external';
    const legacyIntegrated=workspaceMode==='integrated'
        &&profile.config.browserRuntimeLayout==='integrated-legacy';
    const runtimeReceipt=workspaceMode==='external'
        ?await verifyRuntime({signal,onEvent})
        :null;
    const sdkBrowserRuntimeReceipt=workspaceMode==='external'
        ?await verifySdkBrowserRuntime({signal,onEvent})
        :null;
    const template=workspaceMode==='integrated'
        ?workspaceTemplate({
            appId,
            displayName,
            appOnly:true,
            namedImports:!legacyIntegrated,
            minimumCoreVersion:await integratedCoreVersion(resolvedRoot),
            target,
            appIcon:await scaffoldIcon(target)
        })
        :workspaceTemplate({
            appId,
            displayName,
            runtimeRelease:runtimeReceipt,
            sdkBrowserRuntimeRelease:sdkBrowserRuntimeReceipt,
            target,
            appIcon:await scaffoldIcon(target)
        });
    const packagePlan=workspaceMode==='integrated'
        ?Object.freeze({exists:true,updated:false})
        :await prepareExistingPackage(resolvedRoot,template.files);
    if(workspaceMode==='external'){
        await assertExistingLockAdmission(resolvedRoot,template.files);
    }
    const result=await writeMissingFiles(resolvedRoot,template.files,{signal,onEvent});
    const packageUpdated=await applyPackageMerge(resolvedRoot,packagePlan,{signal,onEvent});
    const workspaceRuntimeReceipt=workspaceMode==='external'
        ?await materializeWorkspaceRuntime({
            workspaceRoot:resolvedRoot,
            runtimeRoot:runtimeReceipt.canonicalLocation,
            runtimeReceipt,
            browserRuntimeRoot:sdkBrowserRuntimeReceipt.canonicalLocation,
            sdkBrowserRuntimeReceipt,
            signal,
            onEvent
        })
        :null;
    const importMap=legacyIntegrated
        ?Object.freeze({
            appId,
            skipped:true,
            compatibility:'integrated-legacy',
            reason:'The canonical integrated Arcane OS root retains its physical two-route browser runtime.'
        })
        :await generateImportMap({
            workspaceRoot:resolvedRoot,
            appId,
            appRoot:path.join(resolvedRoot,'apps',appId),
            workspaceRuntimeReceipt,
            workspaceOperationLease,
            signal,
            onEvent
        });
    if(legacyIntegrated){
        await emit(onEvent,{type:'import-map.compatibility.skipped',...importMap});
    }
    const receipt={
        workspaceRoot:resolvedRoot,
        workspaceMode,
        appId,
        displayName:template.name,
        target,
        ...result,
        packageUpdated,
        workspaceRuntime:workspaceRuntimeReceipt,
        importMap,
        gitInitialized:false
    };
    return receipt;
    });
    await emit(onEvent,{type:'scaffold.completed',...receipt});
    return receipt;
}
