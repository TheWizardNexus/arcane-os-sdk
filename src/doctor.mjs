import path from 'node:path';
import {access} from 'node:fs/promises';
import {verifyRuntime} from './runtime.mjs';
import {validateWorkspace} from './workspace.mjs';
import {runProcess} from './process.mjs';
import {ARCANE_PROTOCOL,SDK_VERSION} from './constants.mjs';
import {ERROR_CODES,ArcaneError,throwIfAborted} from './errors.mjs';

const MINIMUM_NODE=[22,14,0];
const WINDOWS_SERVICE_NAME='ArcaneOllama';
const WINDOWS_SERVICE_HOST='C:\\Program Files\\Ollama\\ArcaneOllamaService.exe';
const WINDOWS_SERVICE_COMMAND=`"${WINDOWS_SERVICE_HOST}"`;
const OLLAMA_ENDPOINT='http://127.0.0.1:11434';

function parseVersion(value){
    const match=String(value??'').match(/(\d+)\.(\d+)\.(\d+)/u);
    return match?match.slice(1).map(Number):null;
}

function versionAtLeast(actual,minimum){
    if(!actual){
        return false;
    }
    for(let index=0;index<minimum.length;index+=1){
        if((actual[index]??0)!==minimum[index]){
            return (actual[index]??0)>minimum[index];
        }
    }
    return true;
}

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

async function commandCheck(id,command,args,{signal,onEvent,minimum,run=runProcess}={}){
    try{
        const result=await run(command,args,{signal,onEvent});
        const version=(result.stdout||result.stderr).trim();
        const supported=!minimum||versionAtLeast(parseVersion(version),minimum);
        return check(
            id,
            supported?'pass':'fail',
            supported?`${id} is available (${version}).`:`${id} ${version} is older than the supported minimum.`,
            {details:{version,minimum:minimum?.join('.')??null}}
        );
    }catch(error){
        return check(id,'fail',`${id} is unavailable: ${error.message}`,{
            details:{code:error.code??ERROR_CODES.prerequisiteMissing}
        });
    }
}

function parseServiceCommand(configOutput){
    const line=String(configOutput).split(/\r?\n/u)
        .find(value=>value.includes('BINARY_PATH_NAME'));
    if(!line){
        return {raw:null,binaryPath:null,arguments:null,argumentFree:false,exact:false};
    }
    const raw=line.slice(line.indexOf(':')+1).trim();
    const quoted=raw.match(/^"([^"]+)"(?:\s+(.+))?$/u);
    const unquoted=quoted?null:raw.match(/^(\S+?\.exe)(?:\s+(.+))?$/iu);
    const executable=quoted?.[1]??unquoted?.[1]??null;
    const argumentsText=quoted?.[2]??unquoted?.[2]??null;
    const binaryPath=executable?path.win32.normalize(executable):null;
    const argumentFree=Boolean(binaryPath)&&argumentsText===null;
    return {
        raw,
        binaryPath,
        arguments:argumentsText,
        argumentFree,
        exact:argumentFree&&raw.toLowerCase()===WINDOWS_SERVICE_COMMAND.toLowerCase()
    };
}

function serviceDefinition(configOutput,sidOutput){
    const text=String(configOutput);
    const command=parseServiceCommand(text);
    const ownProcess=/TYPE\s*:\s*10\s+WIN32_OWN_PROCESS/iu.test(text);
    const automatic=/START_TYPE\s*:\s*2\s+AUTO_START/iu.test(text);
    const localService=/SERVICE_START_NAME\s*:\s*(?:NT AUTHORITY\\)?LocalService\s*$/imu.test(text);
    const dependenciesLine=text.split(/\r?\n/u)
        .find(line=>/DEPENDENCIES\s*:/iu.test(line));
    const dependencies=dependenciesLine
        ?dependenciesLine.slice(dependenciesLine.indexOf(':')+1).trim()
        :null;
    const noUnexpectedDependencies=dependencies==='';
    const unrestrictedSid=/SERVICE_SID_TYPE\s*:\s*UNRESTRICTED/iu.test(String(sidOutput));
    return {
        binaryPath:command.binaryPath,
        command:command.raw,
        commandArguments:command.arguments,
        argumentFree:command.argumentFree,
        exactCommand:command.exact,
        ownProcess,
        automatic,
        localService,
        noUnexpectedDependencies,
        dependencies,
        unrestrictedSid
    };
}

function parseProbe(text){
    let value;
    try{
        value=JSON.parse(String(text).trim());
    }catch{
        return null;
    }
    if(!value||typeof value!=='object'||Array.isArray(value)
        ||Object.getPrototypeOf(value)!==Object.prototype
        ||JSON.stringify(Object.keys(value).sort())!==JSON.stringify(['endpoint','ready','service'])
        ||value.service!==WINDOWS_SERVICE_NAME
        ||value.ready!==true
        ||value.endpoint!==OLLAMA_ENDPOINT){
        return null;
    }
    return Object.freeze({
        service:WINDOWS_SERVICE_NAME,
        ready:true,
        endpoint:OLLAMA_ENDPOINT
    });
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

    const configured=await run('sc.exe',['qc',WINDOWS_SERVICE_NAME],{
        signal,onEvent,allowNonzero:true
    });
    const sid=await run('sc.exe',['qsidtype',WINDOWS_SERVICE_NAME],{
        signal,onEvent,allowNonzero:true
    });
    const definition=serviceDefinition(configured.stdout,sid.stdout);
    const binaryPath=definition.binaryPath;
    const expectedPath=path.win32.normalize(WINDOWS_SERVICE_HOST);
    const registrationVerified=Boolean(configured.code===0
        &&sid.code===0
        &&binaryPath?.toLowerCase()===expectedPath.toLowerCase()
        &&definition.exactCommand
        &&definition.ownProcess
        &&definition.automatic
        &&definition.localService
        &&definition.noUnexpectedDependencies
        &&definition.unrestrictedSid);
    const running=/STATE\s*:\s*\d+\s+RUNNING/iu.test(queried.stdout);
    let probe=null;
    let probeExitCode=null;

    if(registrationVerified&&await fileExists(WINDOWS_SERVICE_HOST)){
        const probed=await run(WINDOWS_SERVICE_HOST,['--probe'],{
            signal,onEvent,allowNonzero:true
        });
        probeExitCode=probed.code;
        probe=parseProbe(probed.stdout);
    }

    const probeVerified=probeExitCode===0&&probe!==null;
    const ready=running&&registrationVerified&&probeVerified;
    return check(
        'arcane-ollama',
        ready?'pass':'warning',
        ready
            ?`${WINDOWS_SERVICE_NAME} is registered and its managed wrapper reports ready.`
            :`${WINDOWS_SERVICE_NAME} is present but did not satisfy every managed-service readiness check.`,
        {
            required:false,
            details:{
                service:WINDOWS_SERVICE_NAME,
                running,
                registrationVerified,
                binaryPath,
                serviceDefinition:definition,
                probeExitCode,
                probeVerified,
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
    const nodeSupported=versionAtLeast(parseVersion(nodeVersion),MINIMUM_NODE);
    checks.push(check(
        'node',
        nodeSupported?'pass':'fail',
        nodeSupported
            ?`Node.js ${nodeVersion} satisfies the SDK minimum.`
            :`Node.js ${nodeVersion} does not satisfy the SDK minimum ${MINIMUM_NODE.join('.')}.`,
        {details:{version:nodeVersion,minimum:MINIMUM_NODE.join('.')}}
    ));

    checks.push(await commandCheck('npm','npm',['--version'],{signal,onEvent,run}));
    checks.push(await commandCheck('git','git',['--version'],{signal,onEvent,run}));

    try{
        const receipt=await verifyRuntime({signal,onEvent});
        checks.push(check('sdk-runtime','pass','The packaged Arcane runtime inventory is verified.',{
            details:{sdkVersion:SDK_VERSION,contentSha256:receipt.contentSha256}
        }));
    }catch(error){
        checks.push(check('sdk-runtime','fail',`The packaged Arcane runtime failed verification: ${error.message}`));
    }

    const resolvedWorkspace=path.resolve(workspaceRoot??process.cwd());
    if(await exists(path.join(resolvedWorkspace,'arcane-packager.json'))){
        try{
            const result=await validateWorkspace({
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
    }else{
        checks.push(check(
            'workspace',
            'skipped',
            'No arcane-packager.json was found at the selected workspace.',
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
