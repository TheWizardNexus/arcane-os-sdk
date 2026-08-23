import {execFileSync} from 'node:child_process';
import {accessSync,appendFileSync,constants,readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {verifyNpmReleaseArtifact} from './npm-release-contract.mjs';

const DEVELOPMENT_VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev(?:\.(0|[1-9][0-9]*))?$/u;
const NOT_FOUND_PATTERN=/(?:E404|404 Not Found)/u;
const PACKAGE_NAME='arcane-os';

function fail(message){
    throw new Error(`ARCANE_NPM_PUBLICATION_BLOCKED: ${message}`);
}

function plainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

export function parseDevelopmentVersion(version){
    const match=DEVELOPMENT_VERSION_PATTERN.exec(version);
    if(!match)fail(`Expected a numeric -dev version, received ${version}.`);
    const parts=[
        ...match.slice(1,4).map(value=>Number(value)),
        match[4]===undefined?-1:Number(match[4])
    ];
    if(parts.some(value=>!Number.isSafeInteger(value))){
        fail(`Development version contains an unsafe numeric component: ${version}.`);
    }
    return Object.freeze(parts);
}

export function compareDevelopmentVersions(left,right){
    const leftParts=parseDevelopmentVersion(left);
    const rightParts=parseDevelopmentVersion(right);
    for(let index=0;index<leftParts.length;index+=1){
        if(leftParts[index]!==rightParts[index])return Math.sign(leftParts[index]-rightParts[index]);
    }
    return 0;
}

export function validateContentClassification({classification,packageDocument,disclosureExists}){
    if(!plainObject(packageDocument))fail('package.json must contain one JSON object.');
    const declaredClass=packageDocument.contentPolicy?.class??null;
    if(classification==='standard'){
        if(declaredClass!==null){
            fail(`The standard classification conflicts with package contentPolicy.class=${declaredClass}.`);
        }
        return Object.freeze({classification,mode:'direct'});
    }
    if(classification==='dual-use'){
        if(declaredClass!=='dual-use'){
            fail('Dual-use publication requires package.json contentPolicy.class=dual-use.');
        }
        if(!packageDocument.files?.includes('DISCLOSURE')||!disclosureExists){
            fail('Dual-use publication requires a root DISCLOSURE file in the packed files list.');
        }
        return Object.freeze({classification,mode:'staged'});
    }
    fail(
        'An authorized maintainer must explicitly classify the package as standard or dual-use '+
        'before publication.'
    );
}

export function evaluateDirectPublication({version,expectedIntegrity,actualIntegrity,tags}){
    parseDevelopmentVersion(version);
    if(typeof expectedIntegrity!=='string'||!expectedIntegrity.startsWith('sha512-')){
        fail('Expected integrity must be an npm SHA-512 SRI value.');
    }
    if(!plainObject(tags))fail('npm dist-tags must be one object.');
    if(typeof tags.latest==='string'&&tags.latest!==''){
        fail(`The prerelease package unexpectedly has a latest tag at ${tags.latest}.`);
    }
    const unexpectedTags=Object.keys(tags).filter(tag=>tag!=='dev');
    if(unexpectedTags.length>0){
        fail(`The prerelease package must expose only the dev dist-tag; found ${unexpectedTags.join(', ')}.`);
    }
    if(Object.hasOwn(tags,'dev')&&(typeof tags.dev!=='string'||tags.dev==='')){
        fail('The dev dist-tag must identify one nonempty version.');
    }
    const developmentTag=typeof tags.dev==='string'&&tags.dev!==''?tags.dev:null;
    if(developmentTag!==null&&developmentTag!==version){
        const ordering=compareDevelopmentVersions(developmentTag,version);
        if(ordering>0){
            fail(`Refusing to move dev backward from ${developmentTag} to ${version}.`);
        }
    }
    if(actualIntegrity===null){
        return Object.freeze({
            state:developmentTag===version?'pending':'publish',
            needsPublish:developmentTag!==version
        });
    }
    if(actualIntegrity!==expectedIntegrity){
        fail(`${PACKAGE_NAME}@${version} exists with different immutable bytes.`);
    }
    if(developmentTag!==version){
        fail(`${PACKAGE_NAME}@${version} has the expected bytes, but dev is ${developmentTag??'<missing>'}.`);
    }
    return Object.freeze({state:'published',needsPublish:false});
}

export function executeNpmRead(arguments_,execute=execFileSync){
    try{
        return execute('npm',arguments_,{
            encoding:'utf8',
            stdio:['ignore','pipe','pipe']
        }).trim();
    }catch(error){
        const diagnostics=`${error.stdout??''}\n${error.stderr??''}`;
        if(error.status===1&&NOT_FOUND_PATTERN.test(diagnostics))return null;
        throw error;
    }
}

export function parseDistTags(output){
    if(typeof output!=='string')fail('npm dist-tag output must be text.');
    const tags={};
    for(const line of output.split(/\r?\n/u)){
        if(line==='')continue;
        const match=/^([A-Za-z0-9._-]+): (\S+)$/u.exec(line);
        if(!match)fail(`npm returned an invalid dist-tag line: ${line}.`);
        if(Object.hasOwn(tags,match[1]))fail(`npm returned duplicate dist-tag ${match[1]}.`);
        tags[match[1]]=match[2];
    }
    return Object.freeze(tags);
}

export function readRegistryPublicationState({
    version,
    expectedIntegrity,
    read=executeNpmRead
}){
    const actualIntegrity=read(['view',`${PACKAGE_NAME}@${version}`,'dist.integrity']);
    const rawTags=read(['dist-tag','ls',PACKAGE_NAME]);
    const tags=parseDistTags(rawTags??'');
    return evaluateDirectPublication({version,expectedIntegrity,actualIntegrity,tags});
}

function parseArguments(arguments_){
    const [command,...rest]=arguments_;
    const values={command,classification:null,metadata:null,packagePath:null,maxWaitMs:900_000};
    for(let index=0;index<rest.length;index+=1){
        const argument=rest[index];
        if(argument==='--classification')values.classification=rest[++index]??'';
        else if(argument==='--metadata')values.metadata=rest[++index]??'';
        else if(argument==='--package')values.packagePath=rest[++index]??'';
        else if(argument==='--max-wait-ms')values.maxWaitMs=Number(rest[++index]??'');
        else fail(`Unknown argument: ${argument}.`);
    }
    if(!['policy','preflight','verify'].includes(command)){
        fail('Command must be policy, preflight, or verify.');
    }
    if(!Number.isSafeInteger(values.maxWaitMs)||values.maxWaitMs<0||values.maxWaitMs>1_200_000){
        fail('--max-wait-ms must be an integer from 0 through 1200000.');
    }
    return values;
}

function runPolicy(options){
    if(!options.packagePath)fail('policy requires --package.');
    const packagePath=path.resolve(options.packagePath);
    const packageDocument=JSON.parse(readFileSync(packagePath,'utf8'));
    const disclosurePath=path.join(path.dirname(packagePath),'DISCLOSURE');
    let disclosureExists=true;
    try{
        accessSync(disclosurePath,constants.R_OK);
    }catch{
        disclosureExists=false;
    }
    const policy=validateContentClassification({
        classification:options.classification,
        packageDocument,
        disclosureExists
    });
    if(policy.mode==='staged'){
        fail(
            'Dual-use publication must use npm stage publish followed by human 2FA promotion. '+
            'This direct-publication workflow intentionally refuses that classification.'
        );
    }
    process.stdout.write('Authorized maintainer classified this exact publication as standard.\n');
}

async function releaseIdentity(metadataPath){
    if(!metadataPath)fail('This command requires --metadata.');
    const verified=await verifyNpmReleaseArtifact({
        metadataPath:path.resolve(metadataPath),
        requireCleanSource:true
    });
    return {
        version:verified.manifest.version,
        expectedIntegrity:verified.manifest.artifact.integrity
    };
}

async function runPreflight(options){
    const identity=await releaseIdentity(options.metadata);
    const decision=readRegistryPublicationState(identity);
    const outputPath=process.env.GITHUB_OUTPUT;
    if(!outputPath)fail('GITHUB_OUTPUT is required for publication preflight.');
    appendFileSync(outputPath,`needs-publish=${decision.needsPublish}\n`);
    process.stdout.write(
        decision.needsPublish
            ? `${PACKAGE_NAME}@${identity.version} requires trusted publication.\n`
            : `${PACKAGE_NAME}@${identity.version} is published or awaiting registry scanning.\n`
    );
}

async function runVerification(options){
    const identity=await releaseIdentity(options.metadata);
    const started=Date.now();
    let delay=5_000;
    let lastState='pending';
    while(true){
        const decision=readRegistryPublicationState(identity);
        lastState=decision.state;
        if(decision.state==='published'){
            process.stdout.write(
                `npm exposes ${PACKAGE_NAME}@${identity.version} with the tested integrity and dev tag.\n`
            );
            return;
        }
        const elapsed=Date.now()-started;
        if(elapsed>=options.maxWaitMs)break;
        const waitMilliseconds=Math.min(delay,options.maxWaitMs-elapsed);
        await new Promise(resolve=>setTimeout(resolve,waitMilliseconds));
        delay=Math.min(Math.ceil(delay*1.6),60_000);
    }
    fail(
        `npm publication remains ${lastState} after ${options.maxWaitMs} ms. `+
        'The package may still be scanning or awaiting manual review; rerun is safe because '+
        'matching immutable bytes are accepted and mismatches are rejected.'
    );
}

async function main(arguments_){
    const options=parseArguments(arguments_);
    if(options.command==='policy')runPolicy(options);
    else if(options.command==='preflight')await runPreflight(options);
    else await runVerification(options);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    await main(process.argv.slice(2));
}
