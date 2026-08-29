import {spawn} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

import {verifyNpmReleaseArtifact} from './npm-release-contract.mjs';

const DEVELOPMENT_VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev(?:\.(0|[1-9][0-9]*))?$/u;
const STABLE_VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const NOT_FOUND_PATTERN=/(?:E404|404 Not Found)/u;
const PACKAGE_NAME='arcane-os';

function fail(message){
    throw new Error(`ARCANE_NPM_PUBLICATION_BLOCKED: ${message}`);
}

function plainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function parseJson(output,label){
    if(typeof output!=='string'||output.trim()==='')fail(`${label} must be nonempty JSON text.`);
    try{
        return JSON.parse(output);
    }catch(error){
        fail(`${label} is malformed JSON: ${error.message}`);
    }
}

function numericParts(match,version){
    const parts=match.slice(1,4).map(value=>Number(value));
    if(parts.some(value=>!Number.isSafeInteger(value))){
        fail(`Version contains an unsupported numeric component: ${version}.`);
    }
    return parts;
}

export function parsePublicationVersion(version){
    if(typeof version!=='string')fail('Package version must be text.');
    const stable=STABLE_VERSION_PATTERN.exec(version);
    if(stable)return {version,channel:'latest',parts:numericParts(stable,version)};
    const development=DEVELOPMENT_VERSION_PATTERN.exec(version);
    if(development){
        const sequence=development[4]===undefined?-1:Number(development[4]);
        if(!Number.isSafeInteger(sequence)){
            fail(`Version contains an unsupported numeric component: ${version}.`);
        }
        return {version,channel:'dev',parts:[...numericParts(development,version),sequence]};
    }
    fail(`Expected a numeric stable or -dev version, received ${version}.`);
}

export function parseRegistryVersions(output){
    const document=parseJson(output,'npm versions output');
    const versions=typeof document==='string'?[document]:document;
    if(!Array.isArray(versions)||versions.some(version=>typeof version!=='string')){
        fail('npm versions output must be a version or version array.');
    }
    for(const version of versions)parsePublicationVersion(version);
    return versions;
}

export function parseRegistryTags(output){
    const document=parseJson(output,'npm dist-tags output');
    if(!plainObject(document))fail('npm dist-tags output must be one JSON object.');
    for(const [tag,version] of Object.entries(document)){
        if(typeof version!=='string'||version==='')fail(`npm ${tag} dist-tag must identify a version.`);
    }
    return document;
}

export function evaluateRegistryPublication({version,channel,versions,tags}){
    const candidate=parsePublicationVersion(version);
    const selectedChannel=channel??candidate.channel;
    if(selectedChannel!==candidate.channel){
        fail(`${version} belongs to the npm ${candidate.channel} channel, not ${selectedChannel}.`);
    }
    if(!Array.isArray(versions)||versions.some(item=>typeof item!=='string')){
        fail('Registry versions must be a parsed version array.');
    }
    if(!plainObject(tags))fail('Registry tags must be a parsed object.');
    const listed=versions.includes(version);
    if(!listed)return {state:'publish',needsPublish:true,channel:selectedChannel};
    if(tags[selectedChannel]===version){
        return {state:'published',needsPublish:false,channel:selectedChannel};
    }
    return {state:'pending',needsPublish:false,channel:selectedChannel};
}

export function executeNpmRead(arguments_){
    const executable=process.platform==='win32'?'npm.cmd':'npm';
    return new Promise((resolve,reject)=>{
        const child=spawn(executable,arguments_,{
            encoding:'utf8',
            stdio:['ignore','pipe','pipe'],
            windowsHide:true
        });
        const stdout=[];
        const stderr=[];
        child.stdout.on('data',chunk=>stdout.push(chunk));
        child.stderr.on('data',chunk=>stderr.push(chunk));
        child.once('error',reject);
        child.once('close',code=>{
            const output=Buffer.concat(stdout).toString('utf8').trim();
            const diagnostics=Buffer.concat(stderr).toString('utf8');
            if(code===0)resolve(output);
            else if(code===1&&NOT_FOUND_PATTERN.test(diagnostics))resolve(null);
            else reject(new Error(diagnostics.trim()||`npm exited with code ${code}.`));
        });
    });
}

export async function readRegistryPublicationState({version,channel,read=executeNpmRead}){
    const rawVersions=await read(['view',PACKAGE_NAME,'versions','--json']);
    const rawTags=await read(['view',PACKAGE_NAME,'dist-tags','--json']);
    const versions=rawVersions===null?[]:parseRegistryVersions(rawVersions);
    const tags=rawTags===null?{}:parseRegistryTags(rawTags);
    return evaluateRegistryPublication({version,channel,versions,tags});
}

function parseArguments(arguments_){
    const [command,...rest]=arguments_;
    const values={command,tarball:null,version:null,channel:null,maxWaitMs:900_000};
    for(let index=0;index<rest.length;index+=1){
        const argument=rest[index];
        if(argument==='--tarball')values.tarball=rest[++index]??'';
        else if(argument==='--version')values.version=rest[++index]??'';
        else if(argument==='--channel')values.channel=rest[++index]??'';
        else if(argument==='--max-wait-ms')values.maxWaitMs=Number(rest[++index]??'');
        else fail(`Unknown argument: ${argument}.`);
    }
    if(!['preflight','verify'].includes(command))fail('Command must be preflight or verify.');
    if(!Number.isSafeInteger(values.maxWaitMs)||values.maxWaitMs<0){
        fail('--max-wait-ms must be a nonnegative integer.');
    }
    return values;
}

async function appendOutputs(values){
    const outputPath=process.env.GITHUB_OUTPUT;
    if(!outputPath)fail('GITHUB_OUTPUT is required for publication preflight.');
    await appendFile(
        outputPath,
        `${Object.entries(values).map(([name,value])=>`${name}=${value}`).join('\n')}\n`,
        'utf8'
    );
}

async function runPreflight(options){
    if(!options.tarball)fail('preflight requires --tarball.');
    const artifact=await verifyNpmReleaseArtifact({tarballPath:options.tarball});
    const candidate=parsePublicationVersion(artifact.version);
    const decision=await readRegistryPublicationState({
        version:artifact.version,
        channel:candidate.channel
    });
    await appendOutputs({'needs-publish':decision.needsPublish,channel:decision.channel});
    process.stdout.write(
        decision.needsPublish
            ? `${PACKAGE_NAME}@${artifact.version} is ready to publish through ${decision.channel}.\n`
            : `${PACKAGE_NAME}@${artifact.version} is already present or becoming visible.\n`
    );
}

async function runVerification(options){
    if(!options.version)fail('verify requires --version.');
    if(!['latest','dev'].includes(options.channel))fail('verify requires --channel latest or dev.');
    const parsed=parsePublicationVersion(options.version);
    if(parsed.channel!==options.channel){
        fail(`${options.version} belongs to the npm ${parsed.channel} channel, not ${options.channel}.`);
    }
    const started=Date.now();
    let delay=5_000;
    let lastState='pending';
    while(true){
        const decision=await readRegistryPublicationState({
            version:options.version,
            channel:options.channel
        });
        lastState=decision.state;
        if(decision.state==='published'){
            process.stdout.write(
                `npm exposes ${PACKAGE_NAME}@${options.version} through ${options.channel}.\n`
            );
            return;
        }
        const elapsed=Date.now()-started;
        if(elapsed>=options.maxWaitMs)break;
        const waitMilliseconds=Math.min(delay,options.maxWaitMs-elapsed);
        await new Promise(resolve=>setTimeout(resolve,waitMilliseconds));
        delay=Math.min(Math.ceil(delay*1.6),60_000);
    }
    fail(`npm publication remains ${lastState} after ${options.maxWaitMs} ms.`);
}

async function main(arguments_){
    const options=parseArguments(arguments_);
    if(options.command==='preflight')await runPreflight(options);
    else await runVerification(options);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    await main(process.argv.slice(2));
}
