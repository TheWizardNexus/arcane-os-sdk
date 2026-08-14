import path from 'node:path';
import {createReporter} from '../events.mjs';
import {executeOperation} from '../toolchain.mjs';
import {ArcaneError,ERROR_CODES,normalizeError} from '../errors.mjs';
import {CLI_NAME,SDK_NAME,SDK_VERSION,OUTPUT_MODES} from '../constants.mjs';

const VALUE_OPTIONS=new Set([
    'path',
    'display-name',
    'workspace',
    'app',
    'arcane-root',
    'host',
    'port',
    'target',
    'format',
    'signing',
    'output'
]);
const FLAG_OPTIONS=new Set([
    'git',
    'skip-tests',
    'dry-run',
    'require-local-ai',
    'help',
    'version'
]);

export const HELP_TEXT=`Arcane OS application SDK ${SDK_VERSION}

Usage:
  ${CLI_NAME} new <id> [--path <directory>] [--display-name <name>] [--git]
  ${CLI_NAME} init [id] [--workspace <directory>] [--display-name <name>]
  ${CLI_NAME} doctor [--workspace <directory>] [--arcane-root <directory>]
  ${CLI_NAME} dev [--app <id>] [--host 127.0.0.1] [--port 8000]
  ${CLI_NAME} test [--app <id>]
  ${CLI_NAME} check [--app <id>] [--skip-tests]
  ${CLI_NAME} package [--app <id>] [--dry-run]
  ${CLI_NAME} verify [--app <id>]
  ${CLI_NAME} build --target <target> [--format <format>] [--signing <mode>]
  ${CLI_NAME} run [--target browser] [--app <id>]
  ${CLI_NAME} targets
  ${CLI_NAME} repo status|pull|push

Global:
  --workspace <directory>       Select an external or integrated Arcane workspace.
  --output human|json|ndjson    Select output framing (default: human).
  --help                        Show this help.
  --version                     Show the SDK version.

The npm package is ${SDK_NAME}. Both the ${CLI_NAME} and arcane-os executables
invoke this same headless toolchain.`;

function usage(message){
    throw new ArcaneError(ERROR_CODES.usage,message);
}

function normalizeOptionName(value){
    if(value==='-h')return 'help';
    if(value==='-v')return 'version';
    return value.startsWith('--')?value.slice(2):value;
}

function extractOutput(argv){
    const remaining=[];
    let output='human';
    for(let index=0;index<argv.length;index+=1){
        const argument=argv[index];
        if(argument==='--output'){
            output=argv[index+1];
            index+=1;
            continue;
        }
        if(argument.startsWith('--output=')){
            output=argument.slice('--output='.length);
            continue;
        }
        remaining.push(argument);
    }
    if(!OUTPUT_MODES.includes(output)){
        usage(`Invalid --output value: ${String(output)}. Expected human, json, or ndjson.`);
    }
    return {output,remaining};
}

export function parseCliArguments(argv){
    const values={};
    const flags=new Set();
    const positionals=[];
    for(let index=0;index<argv.length;index+=1){
        const argument=argv[index];
        if(argument==='--'){
            positionals.push(...argv.slice(index+1));
            break;
        }
        if(argument.startsWith('-')){
            const equal=argument.indexOf('=');
            const rawName=equal===-1?argument:argument.slice(0,equal);
            const name=normalizeOptionName(rawName);
            if(FLAG_OPTIONS.has(name)){
                if(equal!==-1){
                    usage(`Option --${name} does not accept a value.`);
                }
                flags.add(name);
                continue;
            }
            if(!VALUE_OPTIONS.has(name)){
                usage(`Unknown option: ${argument}.`);
            }
            const value=equal===-1?argv[++index]:argument.slice(equal+1);
            if(value===undefined||value===''||(equal===-1&&value.startsWith('-'))){
                usage(`Option --${name} requires a value.`);
            }
            values[name]=value;
            continue;
        }
        positionals.push(argument);
    }
    return {values,flags,positionals};
}

function readPort(value,defaultValue){
    if(value===undefined){
        return defaultValue;
    }
    if(!/^\d+$/u.test(value)){
        usage(`Invalid port: ${value}.`);
    }
    const port=Number(value);
    if(!Number.isSafeInteger(port)||port<0||port>65535){
        usage(`Invalid port: ${value}.`);
    }
    return port;
}

function inferredAppId(workspaceRoot){
    const id=path.basename(workspaceRoot)
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu,'-')
        .replace(/^-+|-+$/gu,'');
    return id||'arcane-app';
}

function noExtraPositionals(command,positionals,expected=0){
    if(positionals.length>expected){
        usage(`Unexpected argument for ${command}: ${positionals[expected]}.`);
    }
}

function operationOptions(command,parsed,cwd){
    const {values,flags}=parsed;
    const positionals=parsed.positionals.slice(1);
    const workspaceRoot=path.resolve(cwd,values.workspace??'.');
    const common={workspaceRoot,appId:values.app};

    if(command==='new'){
        const appId=positionals[0];
        if(!appId)usage('new requires an application id.');
        noExtraPositionals(command,positionals,1);
        return {
            targetPath:path.resolve(cwd,values.path??appId),
            appId,
            displayName:values['display-name'],
            initializeGit:flags.has('git')
        };
    }
    if(command==='init'){
        noExtraPositionals(command,positionals,1);
        return {
            workspaceRoot,
            appId:positionals[0]??values.app??inferredAppId(workspaceRoot),
            displayName:values['display-name']
        };
    }
    if(command==='doctor'){
        noExtraPositionals(command,positionals);
        return {
            ...common,
            arcaneRoot:values['arcane-root']?path.resolve(cwd,values['arcane-root']):undefined,
            requireLocalAI:flags.has('require-local-ai')
        };
    }
    if(command==='dev'){
        noExtraPositionals(command,positionals);
        return {
            ...common,
            host:values.host??'127.0.0.1',
            port:readPort(values.port,8000)
        };
    }
    if(command==='test'){
        noExtraPositionals(command,positionals);
        return common;
    }
    if(command==='check'){
        noExtraPositionals(command,positionals);
        return {...common,skipTests:flags.has('skip-tests')};
    }
    if(command==='package'){
        noExtraPositionals(command,positionals);
        return {...common,dryRun:flags.has('dry-run')};
    }
    if(command==='verify'){
        noExtraPositionals(command,positionals);
        return common;
    }
    if(command==='build'){
        noExtraPositionals(command,positionals);
        if(!values.target)usage('build requires --target <target>.');
        return {
            ...common,
            target:values.target,
            format:values.format,
            signing:values.signing,
            dryRun:flags.has('dry-run')
        };
    }
    if(command==='run'){
        noExtraPositionals(command,positionals);
        return {
            ...common,
            target:values.target??'browser',
            host:values.host??'127.0.0.1',
            port:readPort(values.port,8000)
        };
    }
    if(command==='targets'){
        noExtraPositionals(command,positionals);
        return {};
    }
    if(command==='repo'){
        noExtraPositionals(command,positionals,1);
        const action=positionals[0];
        if(!['status','pull','push'].includes(action)){
            usage('repo requires exactly one action: status, pull, or push.');
        }
        return {...common,action};
    }
    usage(`Unknown command: ${command}. Run ${CLI_NAME} --help for usage.`);
}

function commandFromArgs(args){
    if(args.includes('--help')||args.includes('-h'))return 'help';
    if(args.includes('--version')||args.includes('-v'))return 'version';
    for(let index=0;index<args.length;index+=1){
        const argument=args[index];
        if(!argument.startsWith('-')){
            return argument;
        }
        const equal=argument.indexOf('=');
        const name=normalizeOptionName(equal===-1?argument:argument.slice(0,equal));
        if(equal===-1&&VALUE_OPTIONS.has(name)){
            index+=1;
        }
    }
    return 'help';
}

function serverSummary(result){
    return {
        target:result.target??'browser',
        mode:result.mode,
        appId:result.appId,
        host:result.host,
        port:result.port,
        url:result.url,
        ...(result.verified?{verified:result.verified}:{})
    };
}

async function waitForServer(result,signal,reporter){
    reporter.emit('server.ready',serverSummary(result),`Development server ready at ${result.url}`);
    if(result.lifecycle&&typeof result.lifecycle.then==='function'){
        const abort=()=>{
            void Promise.resolve().then(()=>result.close?.()).catch(()=>{});
        };
        signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){
            abort();
        }
        try{
            await result.lifecycle;
        }finally{
            signal.removeEventListener('abort',abort);
        }
    }else{
        await new Promise((resolve,reject)=>{
            let settled=false;
            const done=()=>{
                if(settled)return;
                settled=true;
                signal.removeEventListener('abort',abort);
                resolve();
            };
            const abort=()=>{
                Promise.resolve(result.close?.()).then(done,reject);
            };
            signal.addEventListener('abort',abort,{once:true});
            result.server?.once?.('close',done);
            if(signal.aborted)abort();
        });
    }
    if(signal.aborted){
        throw new ArcaneError(ERROR_CODES.cancelled,'The Arcane server was stopped.',{
            cause:signal.reason,
            exitCode:130
        });
    }
    return serverSummary(result);
}

export async function runCli(argv=process.argv.slice(2),{
    cwd=process.cwd(),
    stdout=process.stdout,
    stderr=process.stderr,
    execute=executeOperation,
    controller=new AbortController()
}={}){
    let reporter;
    let command='help';
    const onSignal=()=>controller.abort(new Error('Interrupted'));
    try{
        const extracted=extractOutput([...argv]);
        command=commandFromArgs(extracted.remaining);
        reporter=createReporter({command,output:extracted.output,stdout,stderr});
        reporter.accept({argv:extracted.remaining});
        process.once('SIGINT',onSignal);
        process.once('SIGTERM',onSignal);

        const parsed=parseCliArguments(extracted.remaining);
        if(command==='help'||parsed.flags.has('help')){
            reporter.complete(HELP_TEXT);
            return 0;
        }
        if(command==='version'||parsed.flags.has('version')){
            reporter.complete(SDK_VERSION);
            return 0;
        }

        const options=operationOptions(command,parsed,cwd);
        const result=await execute(command,{
            ...options,
            signal:controller.signal,
            onEvent:event=>reporter.forward(event)
        });
        const finalResult=(command==='dev'||(command==='run'&&(options.target??'browser')==='browser'))
            ?await waitForServer(result,controller.signal,reporter)
            :result;
        reporter.complete(finalResult);
        return 0;
    }catch(error){
        const normalized=normalizeError(error);
        if(!reporter){
            stderr.write(`${normalized.code}: ${normalized.message}\n`);
        }else{
            if(!reporter.accepted){
                reporter.accept();
            }
            reporter.reject(normalized);
        }
        return normalized.exitCode;
    }finally{
        process.removeListener('SIGINT',onSignal);
        process.removeListener('SIGTERM',onSignal);
    }
}
