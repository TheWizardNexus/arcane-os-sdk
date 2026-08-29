import path from 'node:path';
import {createReporter} from '../events.mjs';
import {executeOperation} from '../toolchain.mjs';
import {ArcaneError,ERROR_CODES,normalizeError} from '../errors.mjs';
import {CLI_NAME,SDK_NAME,SDK_VERSION,OUTPUT_MODES} from '../constants.mjs';
import {loadArcaneNativeProvider} from '../native-provider-loader.mjs';
import {APP_BUNDLE_EXTENSION} from '../release-bundle.mjs';

const VALUE_OPTIONS=new Set([
    'path',
    'display-name',
    'workspace',
    'app',
    'sdk-runtime-source',
    'arcane-root',
    'host',
    'port',
    'target',
    'format',
    'signing',
    'output-root',
    'scope',
    'test-file',
    'artifact',
    'profile',
    'from',
    'origin',
    'allow-to',
    'report-key',
    'request-timeout',
    'output'
]);
const FLAG_OPTIONS=new Set([
    'git',
    'skip-tests',
    'dry-run',
    'require-local-ai',
    'overwrite',
    'secret-stdin',
    'app-key-stdin',
    'report-stdin',
    'help',
    'version'
]);
const REPORTABLE_COMMANDS=new Set([
    'build','bundle','check','dev','doctor','help','import-map','init','mail',
    'native-doctor','native-prepare','new','package','repo','run','targets','test',
    'update-check','upgrade','verify','verify-bundle','version'
]);
const MAX_NODE_TIMER_DELAY_MS=2_147_483_647;

export const HELP_TEXT=`Arcane OS application SDK ${SDK_VERSION}

Usage:
  ${CLI_NAME} new <id> [--path <directory>] [--display-name <name>] [--target <target>] [--git]
  ${CLI_NAME} init [id] [--workspace <directory>] [--display-name <name>] [--target <target>]
  ${CLI_NAME} upgrade [--workspace <directory>] [--app <id>]
  ${CLI_NAME} doctor [--workspace <directory>] [--arcane-root <directory>]
  ${CLI_NAME} import-map [--workspace <directory>] [--app <id>]
  ${CLI_NAME} dev [--app <id>] [--host 127.0.0.1] [--port 8000] [--sdk-runtime-source <sdk-root>]
  ${CLI_NAME} test [--app <id>] [--scope app]
  ${CLI_NAME} test --scope shared --test-file <repo-relative.test.mjs>
  ${CLI_NAME} check [--app <id>] [--scope app] [--skip-tests]
  ${CLI_NAME} check --scope shared
  ${CLI_NAME} package [--app <id>] [--dry-run]
  ${CLI_NAME} verify [--app <id>]
  ${CLI_NAME} bundle [--app <id>] [--artifact <file>${APP_BUNDLE_EXTENSION}] [--overwrite]
  ${CLI_NAME} verify-bundle <file${APP_BUNDLE_EXTENSION}>
  ${CLI_NAME} native-doctor --target <native-target> --arcane-root <directory>
  ${CLI_NAME} native-prepare --target <native-target> --arcane-root <directory>
  ${CLI_NAME} build --target <target> [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
  ${CLI_NAME} run [--target <target>] [--app <id>] [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
  ${CLI_NAME} update-check
  ${CLI_NAME} targets
  ${CLI_NAME} repo status|pull|push
  ${CLI_NAME} mail key set <profile> [--secret-stdin]
  ${CLI_NAME} mail key status <profile>
  ${CLI_NAME} mail key delete <profile>
  ${CLI_NAME} mail send --profile <profile> --from <address> --report-key <id> --report-stdin [--request-timeout <ms>]
  ${CLI_NAME} mail serve --profile <profile> --from <address> --app <id> --origin <origin> [--allow-to <addresses>] [--app-key-stdin] [--host 127.0.0.1] [--port 8025] [--request-timeout <ms>]

Development:
  --sdk-runtime-source <sdk-root>  Dev-only live SDK checkout; omitted preserves the workspace runtime mode.

Global:
  --workspace <directory>       Select an external or integrated Arcane workspace.
  --output human|json|ndjson    Select output framing (default: human).
  --help                        Show this help.
  --version                     Show the SDK version.

The npm package is ${SDK_NAME}. Both the ${CLI_NAME} and arcane-os executables
invoke this same headless toolchain. Every native operation requires one explicit
--arcane-root. Available providers build portable directories, Windows x64 EXE
bundles, Linux x64 or ARM64 DEBs, and development-signed Android APKs.`;

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
        usage('Invalid --output value. Expected human, json, or ndjson.');
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
                usage('Unknown command-line option.');
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

function readRequestTimeout(value){
    if(value===undefined)return undefined;
    if(!/^\d+$/u.test(value)){
        usage(`Invalid request timeout: ${value}.`);
    }
    const timeout=Number(value);
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_NODE_TIMER_DELAY_MS){
        usage(
            `Mail request timeout must be an integer from 1 through ${MAX_NODE_TIMER_DELAY_MS} `
            +'milliseconds, the Node timer range.'
        );
    }
    return timeout;
}

function normalizedSecret(value){
    const secret=String(value??'').trim();
    if(!secret){
        usage('Mail credential input must not be empty.');
    }
    return secret;
}

function readPipedMailSecret(input,signal){
    return new Promise((resolve,reject)=>{
        const chunks=[];
        let settled=false;

        const cleanup=function cleanupMailSecretRead(){
            input.removeListener('data',onData);
            input.removeListener('end',onEnd);
            input.removeListener('error',onError);
            signal?.removeEventListener('abort',onAbort);
        };
        const finish=function finishMailSecretRead(callback,value){
            if(settled)return;
            settled=true;
            cleanup();
            callback(value);
        };
        const onData=function collectMailSecretChunk(chunk){
            chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
        };
        const onEnd=function finishPipedMailSecret(){
            try{
                finish(resolve,normalizedSecret(Buffer.concat(chunks).toString('utf8')));
            }catch(error){
                finish(reject,error);
            }
        };
        const onError=function failPipedMailSecret(error){
            finish(reject,new ArcaneError(
                ERROR_CODES.operationFailed,
                'Unable to read the mail credential from standard input.',
                {cause:error}
            ));
        };
        const onAbort=function cancelPipedMailSecret(){
            finish(reject,new ArcaneError(
                ERROR_CODES.cancelled,
                'Mail credential entry was cancelled.',
                {cause:signal?.reason,exitCode:130}
            ));
        };

        input.on('data',onData);
        input.once('end',onEnd);
        input.once('error',onError);
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted){
            onAbort();
        }else{
            input.resume?.();
        }
    });
}

function readMaskedMailSecret(input,output,signal,label,stdinOption){
    if(!input?.isTTY||typeof input.setRawMode!=='function'||typeof output?.write!=='function'){
        usage(`Interactive mail credential entry requires a terminal; use ${stdinOption} for piped input.`);
    }
    return new Promise((resolve,reject)=>{
        let secret='';
        let settled=false;
        const priorRaw=Boolean(input.isRaw);

        const cleanup=function cleanupMaskedMailSecret(){
            input.removeListener('data',onData);
            signal?.removeEventListener('abort',onAbort);
            input.setRawMode(priorRaw);
            if(!priorRaw)input.pause?.();
        };
        const finish=function finishMaskedMailSecret(callback,value){
            if(settled)return;
            settled=true;
            cleanup();
            output.write('\n');
            callback(value);
        };
        const onAbort=function cancelMaskedMailSecret(){
            finish(reject,new ArcaneError(
                ERROR_CODES.cancelled,
                'Mail credential entry was cancelled.',
                {cause:signal?.reason,exitCode:130}
            ));
        };
        const onData=function collectMaskedMailSecret(chunk){
            for(const character of String(chunk)){
                if(character==='\u0003'){
                    onAbort();
                    return;
                }
                if(character==='\r'||character==='\n'){
                    try{
                        finish(resolve,normalizedSecret(secret));
                    }catch(error){
                        finish(reject,error);
                    }
                    return;
                }
                if(character==='\b'||character==='\u007f'){
                    secret=Array.from(secret).slice(0,-1).join('');
                    continue;
                }
                if(character>=' '&&character!=='\u007f'){
                    secret+=character;
                }
            }
        };

        output.write(`${label} (input hidden): `);
        input.setRawMode(true);
        input.on('data',onData);
        signal?.addEventListener('abort',onAbort,{once:true});
        input.resume();
        if(signal?.aborted)onAbort();
    });
}

export function readMailSecretInput({input=process.stdin,output=process.stderr,
    secretStdin=false,signal,label='Resend API key',stdinOption='--secret-stdin'}={}){
    if(secretStdin&&input?.isTTY){
        usage(`${stdinOption} requires redirected or piped input; omit it for hidden interactive entry.`);
    }
    return secretStdin
        ? readPipedMailSecret(input,signal)
        : readMaskedMailSecret(input,output,signal,label,stdinOption);
}

function readPipedMailReport(input,signal){
    return new Promise((resolve,reject)=>{
        const chunks=[];
        let settled=false;

        const cleanup=function cleanupMailReportRead(){
            input.removeListener('data',onData);
            input.removeListener('end',onEnd);
            input.removeListener('error',onError);
            signal?.removeEventListener('abort',onAbort);
        };
        const finish=function finishMailReportRead(callback,value){
            if(settled)return;
            settled=true;
            cleanup();
            callback(value);
        };
        const onData=function collectMailReportChunk(chunk){
            chunks.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));
        };
        const onEnd=function finishPipedMailReport(){
            try{
                const serialized=Buffer.concat(chunks).toString('utf8');
                let report;
                try{
                    report=JSON.parse(serialized);
                }catch{
                    usage('Mail report input must be one valid JSON object.');
                }
                if(!report||typeof report!=='object'||Array.isArray(report)){
                    usage('Mail report input must be one valid JSON object.');
                }
                finish(resolve,report);
            }catch(error){
                finish(reject,error);
            }
        };
        const onError=function failPipedMailReport(error){
            finish(reject,new ArcaneError(
                ERROR_CODES.operationFailed,
                'Unable to read the mail report from standard input.',
                {cause:error}
            ));
        };
        const onAbort=function cancelPipedMailReport(){
            finish(reject,new ArcaneError(
                ERROR_CODES.cancelled,
                'Mail report input was cancelled.',
                {cause:signal?.reason,exitCode:130}
            ));
        };

        input.on('data',onData);
        input.once('end',onEnd);
        input.once('error',onError);
        signal?.addEventListener('abort',onAbort,{once:true});
        if(signal?.aborted){
            onAbort();
        }else{
            input.resume?.();
        }
    });
}

export function readMailReportInput({input=process.stdin,reportStdin=false,signal}={}){
    if(!reportStdin){
        usage('mail send requires --report-stdin.');
    }
    if(input?.isTTY){
        usage('--report-stdin requires redirected or piped input.');
    }
    return readPipedMailReport(input,signal);
}

function readScope(value){
    const scope=value??'app';
    if(!['app','shared'].includes(scope)){
        usage(`Invalid --scope value: ${String(scope)}. Expected app or shared.`);
    }
    return scope;
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
        usage(`Unexpected argument for ${command}.`);
    }
}

function operationOptions(command,parsed,cwd){
    const {values,flags}=parsed;
    const positionals=parsed.positionals.slice(1);
    const workspaceRoot=path.resolve(cwd,values.workspace??'.');
    const scope=readScope(values.scope);
    const common={workspaceRoot,appId:values.app,scope};
    if(scope==='shared'&&!['test','check'].includes(command)){
        usage(
            `--scope shared is not supported by ${reportableCommand(command)}; `
            +'shared development cannot package or build app output.'
        );
    }
    if(values['test-file']!==undefined&&command!=='test'){
        usage('--test-file is supported only by test --scope shared.');
    }
    if(values.artifact!==undefined&&!['bundle','verify-bundle'].includes(command)){
        usage('--artifact is supported only by bundle and verify-bundle.');
    }
    if(values['sdk-runtime-source']!==undefined&&command!=='dev'){
        usage('--sdk-runtime-source is supported only by dev.');
    }
    if(flags.has('overwrite')&&command!=='bundle'){
        usage('--overwrite is supported only by bundle.');
    }
    if(flags.has('skip-tests')&&command!=='check'){
        usage('--skip-tests is supported only by check.');
    }
    const mailOnlyOptions=['profile','from','origin','allow-to','report-key','request-timeout'];
    if(command!=='mail'&&mailOnlyOptions.some(name=>values[name]!==undefined)){
        usage(`Mail options are supported only by the mail command.`);
    }
    if(command!=='mail'&&flags.has('secret-stdin')){
        usage('--secret-stdin is supported only by mail key set.');
    }
    if(command!=='mail'&&flags.has('app-key-stdin')){
        usage('--app-key-stdin is supported only by mail serve.');
    }
    if(command!=='mail'&&flags.has('report-stdin')){
        usage('--report-stdin is supported only by mail send.');
    }

    if(command==='new'){
        const appId=positionals[0];
        if(!appId)usage('new requires an application id.');
        noExtraPositionals(command,positionals,1);
        return {
            targetPath:path.resolve(cwd,values.path??appId),
            appId,
            displayName:values['display-name'],
            target:values.target??'browser',
            initializeGit:flags.has('git')
        };
    }
    if(command==='init'){
        noExtraPositionals(command,positionals,1);
        return {
            workspaceRoot,
            appId:positionals[0]??values.app??inferredAppId(workspaceRoot),
            displayName:values['display-name'],
            target:values.target??'browser'
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
    if(command==='import-map'){
        noExtraPositionals(command,positionals);
        return common;
    }
    if(command==='upgrade'){
        noExtraPositionals(command,positionals);
        return common;
    }
    if(command==='dev'){
        noExtraPositionals(command,positionals);
        return {
            ...common,
            host:values.host??'127.0.0.1',
            port:readPort(values.port,8000),
            ...(values['sdk-runtime-source']===undefined?{}:{
                sdkRuntimeSourceRoot:path.resolve(cwd,values['sdk-runtime-source'])
            })
        };
    }
    if(command==='test'){
        noExtraPositionals(command,positionals);
        if(scope==='shared'){
            if(values.app)usage('test --scope shared does not accept --app.');
            if(!values['test-file']){
                usage('test --scope shared requires --test-file <repo-relative.test.mjs>.');
            }
        }else if(values['test-file']){
            usage('--test-file requires test --scope shared.');
        }
        return {...common,scope,testFile:values['test-file']};
    }
    if(command==='check'){
        noExtraPositionals(command,positionals);
        if(scope==='shared'){
            if(values.app)usage('check --scope shared does not accept --app.');
            if(flags.has('skip-tests'))usage('check --scope shared does not accept --skip-tests.');
        }
        return {...common,scope,skipTests:flags.has('skip-tests')};
    }
    if(command==='package'){
        noExtraPositionals(command,positionals);
        return {...common,dryRun:flags.has('dry-run')};
    }
    if(command==='verify'){
        noExtraPositionals(command,positionals);
        return common;
    }
    if(command==='bundle'){
        noExtraPositionals(command,positionals);
        return {
            ...common,
            artifactPath:values.artifact?path.resolve(cwd,values.artifact):undefined,
            overwrite:flags.has('overwrite')
        };
    }
    if(command==='verify-bundle'){
        noExtraPositionals(command,positionals,1);
        if(values.app)usage('verify-bundle does not accept --app.');
        if(flags.has('overwrite'))usage('verify-bundle does not accept --overwrite.');
        if(values.artifact&&positionals[0]){
            usage('verify-bundle accepts either one file argument or --artifact, not both.');
        }
        const artifact=values.artifact??positionals[0];
        if(!artifact)usage('verify-bundle requires one bundle file.');
        return {artifactPath:path.resolve(cwd,artifact)};
    }
    if(command==='build'){
        noExtraPositionals(command,positionals);
        if(!values.target)usage('build requires --target <target>.');
        return {
            ...common,
            target:values.target,
            arcaneRoot:values['arcane-root']?path.resolve(cwd,values['arcane-root']):undefined,
            outputRoot:values['output-root']?path.resolve(cwd,values['output-root']):undefined,
            format:values.format,
            signing:values.signing,
            dryRun:flags.has('dry-run')
        };
    }
    if(command==='native-doctor'||command==='native-prepare'){
        noExtraPositionals(command,positionals);
        if(!values.target)usage(`${command} requires --target <native-target>.`);
        return {
            target:values.target,
            arcaneRoot:values['arcane-root']?path.resolve(cwd,values['arcane-root']):undefined,
            format:values.format,
            signing:values.signing
        };
    }
    if(command==='run'){
        noExtraPositionals(command,positionals);
        return {
            ...common,
            target:values.target??'browser',
            arcaneRoot:values['arcane-root']?path.resolve(cwd,values['arcane-root']):undefined,
            outputRoot:values['output-root']?path.resolve(cwd,values['output-root']):undefined,
            format:values.format,
            signing:values.signing,
            host:values.host??'127.0.0.1',
            port:readPort(values.port,8000)
        };
    }
    if(command==='targets'){
        noExtraPositionals(command,positionals);
        return {};
    }
    if(command==='update-check'){
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
    if(command==='mail'){
        const area=positionals[0];
        if(area==='key'){
            noExtraPositionals(command,positionals,3);
            const action=positionals[1];
            const profile=positionals[2];
            if(!['set','status','delete'].includes(action)||!profile){
                usage('mail key requires set, status, or delete followed by one profile id.');
            }
            if(values.profile!==undefined||values.from!==undefined||values.app!==undefined
                ||values.origin!==undefined
                ||values['allow-to']!==undefined||values.host!==undefined||values.port!==undefined
                ||values['report-key']!==undefined||values['request-timeout']!==undefined){
                usage('mail key accepts only its profile argument and optional --secret-stdin for set.');
            }
            if(flags.has('secret-stdin')&&action!=='set'){
                usage('--secret-stdin is supported only by mail key set.');
            }
            if(flags.has('app-key-stdin')){
                usage('--app-key-stdin is supported only by mail serve.');
            }
            if(flags.has('report-stdin')){
                usage('--report-stdin is supported only by mail send.');
            }
            return {
                action:`key-${action}`,
                profile,
                secretStdin:flags.has('secret-stdin'),
            };
        }
        if(area==='serve'){
            noExtraPositionals(command,positionals,1);
            if(flags.has('secret-stdin')){
                usage('--secret-stdin is not supported by mail serve.');
            }
            if(flags.has('report-stdin')||values['report-key']!==undefined){
                usage('--report-stdin and --report-key are supported only by mail send.');
            }
            for(const [name,value]of Object.entries({
                profile:values.profile,
                from:values.from,
                app:values.app,
                origin:values.origin
            })){
                if(!value)usage(`mail serve requires --${name} <value>.`);
            }
            return {
                action:'serve',
                profile:values.profile,
                from:values.from,
                appId:values.app,
                origin:values.origin,
                allowTo:values['allow-to'],
                appKeyStdin:flags.has('app-key-stdin'),
                host:values.host??'127.0.0.1',
                port:readPort(values.port,8025),
                requestTimeout:readRequestTimeout(values['request-timeout']),
            };
        }
        if(area==='send'){
            noExtraPositionals(command,positionals,1);
            if(flags.has('secret-stdin')||flags.has('app-key-stdin')){
                usage('mail send accepts report input only through --report-stdin.');
            }
            if(values.app!==undefined||values.origin!==undefined
                ||values['allow-to']!==undefined||values.host!==undefined
                ||values.port!==undefined){
                usage('mail send does not accept gateway server options.');
            }
            for(const [name,value]of Object.entries({
                profile:values.profile,
                from:values.from,
                'report-key':values['report-key'],
            })){
                if(!value)usage(`mail send requires --${name} <value>.`);
            }
            if(!flags.has('report-stdin')){
                usage('mail send requires --report-stdin.');
            }
            return {
                action:'send',
                profile:values.profile,
                from:values.from,
                reportKey:values['report-key'],
                reportStdin:true,
                requestTimeout:readRequestTimeout(values['request-timeout']),
            };
        }
        usage('mail requires key set|status|delete <profile>, send, or serve.');
    }
    usage(`Unknown command. Run ${CLI_NAME} --help for usage.`);
}

const NATIVE_REQUESTS={
    'windows-x64':{
        platform:'windows',architecture:'x64',defaultFormat:'exe',formats:new Set(['exe']),
        defaultSigning:'unsigned-local-test',defaultProfileId:null,
        signingModes:new Set(['unsigned-local-test'])
    },
    'linux-x64':{
        platform:'linux',architecture:'x64',defaultFormat:'deb',formats:new Set(['deb']),
        defaultSigning:'unsigned-local-test',defaultProfileId:null,
        signingModes:new Set(['unsigned-local-test'])
    },
    'linux-arm64':{
        platform:'linux',architecture:'arm64',defaultFormat:'deb',formats:new Set(['deb']),
        defaultSigning:'unsigned-local-test',defaultProfileId:null,
        signingModes:new Set(['unsigned-local-test'])
    },
    'android-arm64':{
        platform:'android',architecture:'arm64',defaultFormat:'apk',formats:new Set(['apk']),
        defaultSigning:'development',defaultProfileId:'arcane-android-development-v1',
        signingModes:new Set(['development'])
    }
};

function portableRequestDefinition(){
    const platform=process.platform==='win32'?'windows':process.platform;
    const architecture=process.arch==='x64'?'x64':process.arch==='arm64'?'arm64':process.arch;
    if(!['windows','linux'].includes(platform)||!['x64','arm64'].includes(architecture)){
        throw new ArcaneError(
            ERROR_CODES.targetUnavailable,
            `The portable native provider does not support ${process.platform}/${process.arch}.`
        );
    }
    return {
        platform,
        architecture,
        defaultFormat:'portable',
        formats:new Set(['portable']),
        defaultSigning:'unsigned-local-test',
        defaultProfileId:null,
        signingModes:new Set(['unsigned-local-test'])
    };
}

export function createNativeTargetRequest({target,format,signing}={}){
    const definition=target==='portable'?portableRequestDefinition():NATIVE_REQUESTS[target];
    if(!definition){
        usage(`Target ${String(target)} is not a registered native target.`);
    }
    const selectedFormat=format??definition.defaultFormat;
    if(!definition.formats.has(selectedFormat)){
        usage(
            `Target ${target} does not support --format ${String(selectedFormat)}. `
            +`Expected ${[...definition.formats].join(', ')}.`
        );
    }
    const signingMode=signing??definition.defaultSigning;
    if(!definition.signingModes.has(signingMode)){
        usage(
            `Target ${target} does not support --signing ${String(signingMode)}. `
            +`Expected ${[...definition.signingModes].join(', ')}.`
        );
    }
    return {
        target,
        platform:definition.platform,
        architecture:definition.architecture,
        format:selectedFormat,
        signing:{mode:signingMode,profileId:definition.defaultProfileId}
    };
}

async function pairNativeProvider(command,options,loadProvider,{signal,onEvent}={}){
    const nativeOperation=(['build','run'].includes(command)&&options.target!=='browser')
        ||command==='native-doctor'
        ||command==='native-prepare';
    if(!nativeOperation)return options;
    if(options.target==='browser'){
        usage(`${command} requires one native target.`);
    }
    const targetRequest=createNativeTargetRequest(options);
    if(!options.arcaneRoot){
        usage(`${command} for target ${options.target} requires --arcane-root <directory>.`);
    }
    const loaded=await loadProvider({
        arcaneRoot:options.arcaneRoot,
        target:options.target,
        signal,
        onEvent
    });
    return {
        ...options,
        nativeBuilder:loaded.nativeBuilder,
        toolchainRoot:loaded.toolchainRoot,
        targetRequest
    };
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

function reportableCommand(command){
    return REPORTABLE_COMMANDS.has(command)?command:'unknown';
}

function serverSummary(result){
    return {
        target:result.target??'browser',
        mode:result.mode,
        appId:result.appId,
        host:result.host,
        port:result.port,
        url:result.url,
        ...(result.callerAuthentication
            ?{callerAuthentication:result.callerAuthentication}
            :{}),
        ...(result.runtimeMode?{runtimeMode:result.runtimeMode}:{}),
        ...(result.runtime?{runtime:result.runtime}:{}),
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
    stdin=process.stdin,
    stdout=process.stdout,
    stderr=process.stderr,
    execute=executeOperation,
    loadNativeProvider=loadArcaneNativeProvider,
    controller=new AbortController()
}={}){
    let reporter;
    let command='help';
    const onSignal=()=>controller.abort(new Error('Interrupted'));
    try{
        const extracted=extractOutput([...argv]);
        command=commandFromArgs(extracted.remaining);
        reporter=createReporter({
            command:reportableCommand(command),
            output:extracted.output,
            stdout,
            stderr
        });
        reporter.accept();
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

        const operation=operationOptions(command,parsed,cwd);
        if(command==='mail'&&operation.action==='key-set'){
            operation.readSecret=function readMailCredentialForOperation(){
                if(reporter.output!=='human'&&!operation.secretStdin){
                    usage('Structured output requires mail key set --secret-stdin.');
                }
                return readMailSecretInput({
                    input:stdin,
                    output:stderr,
                    secretStdin:operation.secretStdin,
                    signal:controller.signal,
                });
            };
        }
        if(command==='mail'&&operation.action==='serve'){
            operation.readAppKey=function readMailGatewayAppKeyForOperation(){
                if(reporter.output!=='human'&&!operation.appKeyStdin){
                    usage('Structured output requires mail serve --app-key-stdin.');
                }
                return readMailSecretInput({
                    input:stdin,
                    output:stderr,
                    secretStdin:operation.appKeyStdin,
                    signal:controller.signal,
                    label:'Mail gateway app key',
                    stdinOption:'--app-key-stdin',
                });
            };
        }
        if(command==='mail'&&operation.action==='send'){
            operation.readReport=function readMailReportForOperation(){
                return readMailReportInput({
                    input:stdin,
                    reportStdin:operation.reportStdin,
                    signal:controller.signal,
                });
            };
        }
        const options=await pairNativeProvider(
            command,
            operation,
            loadNativeProvider,
            {signal:controller.signal,onEvent:event=>reporter.forward(event)}
        );
        const result=await execute(command,{
            ...options,
            signal:controller.signal,
            onEvent:event=>reporter.forward(event)
        });
        const finalResult=(command==='dev'||(command==='run'&&(options.target??'browser')==='browser')
            ||(command==='mail'&&options.action==='serve'))
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
