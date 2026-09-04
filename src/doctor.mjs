import path from 'node:path';
import {access,lstat,readdir,realpath} from 'node:fs/promises';
import {loadRuntimeRelease} from './runtime.mjs';
import {loadSdkBrowserRuntimeRelease} from './sdk-browser-runtime.mjs';
import {validateWorkspace} from './workspace.mjs';
import {runProcess} from './process.mjs';
import {ARCANE_PROTOCOL,SDK_VERSION} from './constants.mjs';
import {ERROR_CODES,ArcaneError,throwIfAborted} from './errors.mjs';

const WINDOWS_SERVICE_NAME='ArcaneOllama';
const WINDOWS_SERVICE_HOST='C:\\Program Files\\Ollama\\ArcaneOllamaService.exe';

async function exists(filePath){
    try{
        await access(filePath);
        return true;
    }catch{
        return false;
    }
}

function check(id,status,message,{required=true,details}={}){
    return {id,status,message,required,...(details===undefined?{}:{details})};
}

async function commandCheck(id,command,args,{signal,onEvent,run=runProcess}={}){
    try{
        const result=await run(command,args,{signal,onEvent});
        const version=(result.stdout||result.stderr).trim();
        return check(
            id,
            'pass',
            `${id} is available (${version}).`,
            {details:{version}}
        );
    }catch(error){
        return check(id,'fail',`${id} is unavailable: ${error.message}`,{
            details:{code:error.code??ERROR_CODES.prerequisiteMissing}
        });
    }
}

function parseProbe(text){
    let value;
    try{
        value=JSON.parse(String(text));
    }catch{
        return null;
    }
    if(!value||typeof value!=='object'||Array.isArray(value)
        ||Object.getPrototypeOf(value)!==Object.prototype||typeof value.ready!=='boolean'){
        return null;
    }
    return {...value};
}

function compareText(left,right){
    const a=String(left);
    const b=String(right);
    return a<b?-1:a>b?1:0;
}

async function listPhysicalFiles(directory,label){
    const requested=path.resolve(directory);
    const rootInfo=await lstat(requested);
    if(rootInfo.isSymbolicLink()||!rootInfo.isDirectory()){
        throw new Error(`${label} must be a real directory.`);
    }
    const canonical=await realpath(requested);
    const files=[];
    async function visit(current,relativeRoot=''){
        const entries=await readdir(current,{withFileTypes:true});
        entries.sort((left,right)=>compareText(left.name,right.name));
        for(const entry of entries){
            const relative=relativeRoot?`${relativeRoot}/${entry.name}`:entry.name;
            const absolute=path.join(current,entry.name);
            const info=await lstat(absolute);
            if(info.isSymbolicLink())throw new Error(`${label} contains a symbolic link: ${relative}.`);
            if(info.isDirectory())await visit(absolute,relative);
            else if(info.isFile())files.push(relative);
            else throw new Error(`${label} contains a non-file entry: ${relative}.`);
        }
    }
    await visit(canonical);
    return files.sort(compareText);
}

function expectedWorkspaceRuntimeFiles(runtimeFiles,browserFiles){
    return [
        ...runtimeFiles.map(relative=>relative.startsWith('arcane/')
            ?relative.slice('arcane/'.length)
            :`dependencies/strong-type/${relative.slice('strong-type/'.length)}`),
        ...browserFiles.map(relative=>`sdk/${relative}`)
    ].sort(compareText);
}

async function assessWindowsOllama({
    signal,
    onEvent,
    run=runProcess,
    fileExists=exists
}={}){
    const queried=await run('sc.exe',['query',WINDOWS_SERVICE_NAME],{
        signal,onEvent,allowNonzero:true
    });
    if(queried.code!==0){
        return check('arcane-ollama','missing',`${WINDOWS_SERVICE_NAME} is not installed.`,{
            required:false,
            details:{service:WINDOWS_SERVICE_NAME}
        });
    }

    const running=/STATE\s*:\s*\d+\s+RUNNING/iu.test(queried.stdout);
    let probe=null;
    let probeExitCode=null;
    const probeAvailable=await fileExists(WINDOWS_SERVICE_HOST);

    if(probeAvailable){
        const probed=await run(WINDOWS_SERVICE_HOST,['--probe'],{
            signal,onEvent,allowNonzero:true
        });
        probeExitCode=probed.code;
        probe=parseProbe(probed.stdout);
    }

    const probeReady=probe===null?null:probeExitCode===0&&probe.ready===true;
    const ready=running&&(probeReady??true);
    return check(
        'arcane-ollama',
        ready?'pass':'warning',
        ready
            ?`${WINDOWS_SERVICE_NAME} is running${probeReady===true?' and reports ready':''}.`
            :`${WINDOWS_SERVICE_NAME} is present but is not ready.`,
        {
            required:false,
            details:{
                service:WINDOWS_SERVICE_NAME,
                running,
                probeAvailable,
                probeExitCode,
                probeReady,
                probe
            }
        }
    );
}

export async function assessArcaneOllama({
    signal,
    onEvent,
    platform=process.platform,
    run=runProcess,
    fileExists=exists
}={}){
    throwIfAborted(signal);
    if(platform==='win32'){
        return assessWindowsOllama({signal,onEvent,run,fileExists});
    }
    return check(
        'arcane-ollama',
        'unsupported',
        'Managed ArcaneOllama service inspection is not implemented on this host.',
        {required:false,details:{platform}}
    );
}

export async function runDoctor({
    workspaceRoot,
    appId,
    arcaneRoot,
    requireLocalAI=false,
    signal,
    onEvent,
    platform=process.platform,
    run=runProcess
}={}){
    throwIfAborted(signal);
    const checks=[];
    const nodeVersion=process.versions.node;
    checks.push(check(
        'node',
        'pass',
        `Node.js ${nodeVersion} is available.`,
        {details:{version:nodeVersion}}
    ));

    checks.push(await commandCheck('npm','npm',['--version'],{signal,onEvent,run}));
    checks.push(await commandCheck('git','git',['--version'],{signal,onEvent,run}));

    try{
        const [runtimeRelease,browserRelease]=await Promise.all([
            loadRuntimeRelease({signal}),
            loadSdkBrowserRuntimeRelease({signal})
        ]);
        checks.push(check('sdk-runtime','pass','The packaged Arcane runtime files are available.',{
            details:{
                sdkVersion:SDK_VERSION,
                runtimeRoot:runtimeRelease.runtimeRoot,
                browserRuntimeRoot:browserRelease.browserRuntimeRoot,
                runtimeFiles:runtimeRelease.files,
                browserRuntimeFiles:browserRelease.files
            }
        }));
    }catch(error){
        checks.push(check('sdk-runtime','fail',`The packaged Arcane runtime could not be read: ${error.message}`));
    }

    const resolvedWorkspace=path.resolve(workspaceRoot??process.cwd());
    if(await exists(path.join(resolvedWorkspace,'arcane-packager.json'))){
        let result=null;
        try{
            result=await validateWorkspace({
                workspaceRoot:resolvedWorkspace,
                appId,
                signal,
                onEvent
            });
            checks.push(check('workspace','pass',`The ${result.workspaceMode} Arcane app workspace is valid.`,{
                details:{workspaceRoot:result.workspaceRoot,appId:result.appId,workspaceMode:result.workspaceMode}
            }));
        }catch(error){
            checks.push(check('workspace','fail',`The Arcane app workspace is invalid: ${error.message}`));
        }
        if(result===null){
            checks.push(check(
                'workspace-runtime',
                'skipped',
                'The physical workspace runtime was not checked because workspace validation failed.',
                {required:false,details:{workspaceRoot:resolvedWorkspace}}
            ));
        }else if(result.workspaceMode==='external'){
            try{
                const {runtimeRoot,browserRuntimeRoot}=result.sdkInstallation;
                const [runtimeRelease,browserRelease]=await Promise.all([
                    loadRuntimeRelease({runtimeRoot,signal}),
                    loadSdkBrowserRuntimeRelease({browserRuntimeRoot,signal})
                ]);
                const files=await listPhysicalFiles(
                    path.join(result.workspaceRoot,'arcane'),
                    'Workspace Arcane runtime'
                );
                const expected=expectedWorkspaceRuntimeFiles(
                    runtimeRelease.files,
                    browserRelease.files
                );
                const present=new Set(files);
                const missing=expected.filter(file=>!present.has(file));
                if(missing.length){
                    throw new Error(`Workspace Arcane runtime is missing required SDK files: ${missing.join(', ')}`);
                }
                checks.push(check(
                    'workspace-runtime',
                    'pass',
                    'The composed physical Arcane and SDK browser runtime is present.',
                    {details:{
                        layout:'external',
                        files
                    }}
                ));
            }catch(error){
                checks.push(check(
                    'workspace-runtime',
                    'fail',
                    `The composed physical workspace runtime could not be read: ${error.message}`
                ));
            }
        }else if(result.workspaceMode==='integrated'){
            const layout=result.config.browserRuntimeLayout;
            checks.push(check(
                'workspace-runtime',
                'pass',
                'The integrated physical browser-runtime routes are valid.',
                {details:{layout}}
            ));
        }
    }else{
        checks.push(check(
            'workspace',
            'skipped',
            'No arcane-packager.json was found at the selected workspace.',
            {required:false,details:{workspaceRoot:resolvedWorkspace}}
        ));
        checks.push(check(
            'workspace-runtime',
            'skipped',
            'No workspace runtime was selected for verification.',
            {required:false,details:{workspaceRoot:resolvedWorkspace}}
        ));
    }

    if(arcaneRoot){
        const resolvedArcaneRoot=path.resolve(arcaneRoot);
        const lifecycle=path.join(resolvedArcaneRoot,'docs','development-lifecycle.md');
        const recognized=await exists(lifecycle);
        checks.push(check(
            'arcane-source',
            recognized?'pass':'warning',
            recognized
                ?'The optional Arcane OS source checkout was found.'
                :'The selected Arcane OS source checkout was not recognized.',
            {required:false,details:{arcaneRoot:resolvedArcaneRoot}}
        ));
    }

    const ollama=await assessArcaneOllama({signal,onEvent,platform,run});
    if(requireLocalAI){
        ollama.required=true;
        if(ollama.status!=='pass'){
            ollama.status='fail';
        }
    }
    checks.push(ollama);

    const failed=checks.filter(item=>item.required&&item.status==='fail');
    return {
        schemaVersion:1,
        sdkVersion:SDK_VERSION,
        arcaneProtocol:ARCANE_PROTOCOL,
        platform,
        ok:failed.length===0,
        checks
    };
}
