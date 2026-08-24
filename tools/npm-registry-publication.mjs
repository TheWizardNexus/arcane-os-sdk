import {execFileSync} from 'node:child_process';
import {accessSync,appendFileSync,constants,readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {verifyNpmReleaseArtifact} from './npm-release-contract.mjs';

const BOOTSTRAP=Object.freeze({
    version:'0.1.0-dev.5',
    integrity:'sha512-8cUo/Us9PthnPk5c4r9Td7dx6ERKALAUiVL4dprWh5fGf3jGm89uB4fVpXktLErWnw81r7aGmq8LXHLPEMrz7g==',
    shasum:'d65bf41e0c3f8d2220856bd02067cd7d2968136e'
});
const DEVELOPMENT_VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev(?:\.(0|[1-9][0-9]*))?$/u;
const STABLE_VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA1_PATTERN=/^[0-9a-f]{40}$/u;
const NOT_FOUND_PATTERN=/(?:E404|404 Not Found)/u;
const PACKAGE_NAME='arcane-os';
const REPOSITORY='TheWizardNexus/arcane-os-sdk';
const WORKFLOW_PATH='.github/workflows/publish-dev.yml';
const REPOSITORY_URL=`https://github.com/${REPOSITORY}`;
const SLSA_PREDICATE_TYPE='https://slsa.dev/provenance/v1';
const SLSA_STATEMENT_TYPE='https://in-toto.io/Statement/v1';
const SLSA_BUILD_TYPE='https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1';
const PUBLISH_PREDICATE_TYPE='https://github.com/npm/attestation/tree/main/specs/publish/v0.1';
const PUBLISH_STATEMENT_TYPE='https://in-toto.io/Statement/v0.1';

function fail(message){
    throw new Error(`ARCANE_NPM_PUBLICATION_BLOCKED: ${message}`);
}

function plainObject(value){
    return value!==null&&typeof value==='object'&&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function parseJson(output,label){
    if(typeof output!=='string'||output.trim()==='')fail(`${label} must be nonempty JSON text.`);
    try{
        return JSON.parse(output);
    }catch(error){
        fail(`${label} is malformed JSON: ${error.message}`);
    }
}

function parseNumericComponents(match,version){
    const parts=match.slice(1,4).map(value=>Number(value));
    if(parts.some(value=>!Number.isSafeInteger(value))){
        fail(`Version contains an unsafe numeric component: ${version}.`);
    }
    return parts;
}

export function parsePublicationVersion(version){
    if(typeof version!=='string')fail('Package version must be text.');
    const stable=STABLE_VERSION_PATTERN.exec(version);
    if(stable){
        return Object.freeze({version,channel:'latest',parts:Object.freeze(parseNumericComponents(stable,version))});
    }
    const development=DEVELOPMENT_VERSION_PATTERN.exec(version);
    if(development){
        const developmentNumber=development[4]===undefined?-1:Number(development[4]);
        if(!Number.isSafeInteger(developmentNumber)){
            fail(`Version contains an unsafe numeric component: ${version}.`);
        }
        return Object.freeze({
            version,
            channel:'dev',
            parts:Object.freeze([...parseNumericComponents(development,version),developmentNumber])
        });
    }
    fail(`Expected a numeric stable or -dev version, received ${version}.`);
}

export function parseDevelopmentVersion(version){
    const parsed=parsePublicationVersion(version);
    if(parsed.channel!=='dev')fail(`Expected a numeric -dev version, received ${version}.`);
    return parsed.parts;
}

export function comparePublicationVersions(left,right){
    const leftVersion=parsePublicationVersion(left);
    const rightVersion=parsePublicationVersion(right);
    for(let index=0;index<3;index+=1){
        const leftPart=leftVersion.parts[index];
        const rightPart=rightVersion.parts[index];
        if(leftPart!==rightPart)return leftPart<rightPart?-1:1;
    }
    if(leftVersion.channel!==rightVersion.channel)return leftVersion.channel==='dev'?-1:1;
    if(leftVersion.channel==='latest')return 0;
    return Math.sign(leftVersion.parts[3]-rightVersion.parts[3]);
}

export function compareDevelopmentVersions(left,right){
    parseDevelopmentVersion(left);
    parseDevelopmentVersion(right);
    return comparePublicationVersions(left,right);
}

function assertIntegrity(integrity,label){
    if(typeof integrity!=='string'||!integrity.startsWith('sha512-')){
        fail(`${label} must be an npm SHA-512 SRI value.`);
    }
    const digest=integrity.slice('sha512-'.length);
    const bytes=Buffer.from(digest,'base64');
    if(bytes.length!==64||bytes.toString('base64')!==digest){
        fail(`${label} must contain one canonical SHA-512 digest.`);
    }
}

function assertShasum(shasum,label){
    if(typeof shasum!=='string'||!SHA1_PATTERN.test(shasum)){
        fail(`${label} must be one lowercase npm SHA-1 shasum.`);
    }
}

export function parseRegistryVersions(output){
    const document=parseJson(output,'npm versions output');
    if(!Array.isArray(document))fail('npm versions output must be one JSON array.');
    const seen=new Set();
    for(const version of document){
        parsePublicationVersion(version);
        if(seen.has(version))fail(`npm versions output contains duplicate ${version}.`);
        seen.add(version);
    }
    return Object.freeze([...document]);
}

export function parseRegistryTags(output){
    const document=parseJson(output,'npm dist-tags output');
    if(!plainObject(document))fail('npm dist-tags output must be one JSON object.');
    const keys=Object.keys(document).sort();
    if(keys.length!==2||keys[0]!=='dev'||keys[1]!=='latest'){
        fail('npm must expose exactly the dev and latest dist-tags.');
    }
    for(const tag of keys){
        if(typeof document[tag]!=='string'||document[tag]===''){
            fail(`npm ${tag} dist-tag must identify one nonempty version.`);
        }
        parsePublicationVersion(document[tag]);
    }
    return Object.freeze({dev:document.dev,latest:document.latest});
}

export function parseRegistryDist(output,label='npm dist output'){
    if(output===null)return null;
    const document=parseJson(output,label);
    if(!plainObject(document))fail(`${label} must be one JSON object.`);
    const keys=Object.keys(document).sort();
    if(keys.length!==2||keys[0]!=='dist.integrity'||keys[1]!=='dist.shasum'){
        fail(`${label} must contain exactly dist.integrity and dist.shasum.`);
    }
    assertIntegrity(document['dist.integrity'],`${label} integrity`);
    assertShasum(document['dist.shasum'],`${label} shasum`);
    return Object.freeze({
        integrity:document['dist.integrity'],
        shasum:document['dist.shasum']
    });
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
    fail('An authorized maintainer must explicitly classify the package as standard or dual-use before publication.');
}

function maximumVersion(versions,channel){
    const matching=versions.filter(version=>parsePublicationVersion(version).channel===channel);
    return matching.reduce(
        (highest,version)=>highest===null||comparePublicationVersions(version,highest)>0?version:highest,
        null
    );
}

function exactDist(actual,expected,label){
    if(actual===null)fail(`${label} is missing from the registry.`);
    if(actual.integrity!==expected.integrity||actual.shasum!==expected.shasum){
        fail(`${label} has different immutable integrity or shasum bytes.`);
    }
}

export function evaluateRegistryPublication({
    version,
    expectedIntegrity,
    expectedShasum,
    versions,
    tags,
    candidateDist,
    bootstrapDist
}){
    const candidate=parsePublicationVersion(version);
    assertIntegrity(expectedIntegrity,'Expected integrity');
    assertShasum(expectedShasum,'Expected shasum');
    if(!Array.isArray(versions)||versions.some(value=>typeof value!=='string')){
        fail('Registry versions must be a parsed version array.');
    }
    if(!plainObject(tags)||Object.keys(tags).sort().join(',')!=='dev,latest'){
        fail('Registry tags must be the parsed dev/latest object.');
    }
    const listed=new Set(versions);
    if(listed.size!==versions.length)fail('Registry versions must be unique.');
    for(const listedVersion of versions)parsePublicationVersion(listedVersion);
    if(!listed.has(tags.dev)||!listed.has(tags.latest)){
        fail('Every npm dist-tag must identify a listed package version.');
    }

    const highestStable=maximumVersion(versions,'latest');
    const highestDevelopment=maximumVersion(versions,'dev');
    if(highestDevelopment===null||tags.dev!==highestDevelopment){
        fail(`The dev dist-tag must identify the highest published development version (${highestDevelopment??'<missing>'}).`);
    }
    if(highestStable===null){
        if(tags.latest!==BOOTSTRAP.version||tags.dev!==BOOTSTRAP.version||!listed.has(BOOTSTRAP.version)){
            fail('The no-stable registry state must match the recorded dev.5 bootstrap tags exactly.');
        }
        exactDist(bootstrapDist,BOOTSTRAP,`${PACKAGE_NAME}@${BOOTSTRAP.version} bootstrap`);
    }else if(tags.latest!==highestStable){
        fail(`The latest dist-tag must identify the highest published stable version (${highestStable}).`);
    }

    const selectedTag=candidate.channel;
    const preservedTag=selectedTag==='latest'?'dev':'latest';
    const preservedVersion=tags[preservedTag];
    const candidateListed=listed.has(version);
    if(candidateListed){
        if(candidateDist===null){
            return Object.freeze({
                state:'pending',needsPublish:false,channel:selectedTag,preservedTag,preservedVersion
            });
        }
        exactDist(candidateDist,{integrity:expectedIntegrity,shasum:expectedShasum},`${PACKAGE_NAME}@${version}`);
        if(tags[selectedTag]!==version){
            fail(`${PACKAGE_NAME}@${version} has matching bytes, but ${selectedTag} is ${tags[selectedTag]}.`);
        }
        return Object.freeze({
            state:'published',needsPublish:false,channel:selectedTag,preservedTag,preservedVersion
        });
    }
    if(candidateDist!==null){
        fail(`${PACKAGE_NAME}@${version} has dist metadata but is absent from the strict versions list.`);
    }
    const highestForChannel=selectedTag==='latest'?highestStable:highestDevelopment;
    if(highestForChannel!==null&&comparePublicationVersions(version,highestForChannel)<=0){
        fail(`Refusing to move ${selectedTag} backward from ${highestForChannel} to ${version}.`);
    }
    return Object.freeze({
        state:'publish',needsPublish:true,channel:selectedTag,preservedTag,preservedVersion
    });
}

export function executeNpmRead(arguments_,execute=execFileSync){
    const executable=process.platform==='win32'?(process.env.ComSpec??'cmd.exe'):'npm';
    const commandArguments=process.platform==='win32'
        ?['/d','/s','/c','npm',...arguments_]
        :arguments_;
    try{
        return execute(executable,commandArguments,{
            encoding:'utf8',
            stdio:['ignore','pipe','pipe']
        }).trim();
    }catch(error){
        const diagnostics=`${error.stdout??''}\n${error.stderr??''}`;
        if(error.status===1&&NOT_FOUND_PATTERN.test(diagnostics))return null;
        throw error;
    }
}

export function readRegistryPublicationState({
    version,
    expectedIntegrity,
    expectedShasum,
    read=executeNpmRead
}){
    const rawVersions=read(['view',PACKAGE_NAME,'versions','--json']);
    const rawTags=read(['view',PACKAGE_NAME,'dist-tags','--json']);
    if(rawVersions===null||rawTags===null)fail(`${PACKAGE_NAME} bootstrap package is absent.`);
    const versions=parseRegistryVersions(rawVersions);
    const tags=parseRegistryTags(rawTags);
    const candidateDist=parseRegistryDist(
        read(['view',`${PACKAGE_NAME}@${version}`,'dist.integrity','dist.shasum','--json']),
        `${PACKAGE_NAME}@${version} dist output`
    );
    let bootstrapDist=null;
    if(!versions.some(item=>parsePublicationVersion(item).channel==='latest')){
        bootstrapDist=version===BOOTSTRAP.version?candidateDist:parseRegistryDist(
            read([
                'view',`${PACKAGE_NAME}@${BOOTSTRAP.version}`,
                'dist.integrity','dist.shasum','--json'
            ]),
            `${PACKAGE_NAME}@${BOOTSTRAP.version} dist output`
        );
    }
    return evaluateRegistryPublication({
        version,expectedIntegrity,expectedShasum,versions,tags,candidateDist,bootstrapDist
    });
}

function decodeStatement(bundle,predicateType,statementType){
    const envelope=bundle?.dsseEnvelope;
    if(!plainObject(envelope)||envelope.payloadType!=='application/vnd.in-toto+json'
        ||typeof envelope.payload!=='string'){
        fail(`The ${predicateType} attestation lacks one DSSE in-toto payload.`);
    }
    const payload=Buffer.from(envelope.payload,'base64');
    if(envelope.payload===''||payload.length===0||payload.toString('base64')!==envelope.payload){
        fail(`The ${predicateType} attestation payload is not canonical base64.`);
    }
    let statement;
    try{
        statement=JSON.parse(payload.toString('utf8'));
    }catch(error){
        fail(`The ${predicateType} attestation payload is malformed: ${error.message}`);
    }
    if(!plainObject(statement)||statement._type!==statementType
        ||statement.predicateType!==predicateType||!plainObject(statement.predicate)){
        fail(`The ${predicateType} attestation is not the expected in-toto statement.`);
    }
    return statement;
}

function assertSubject(statement,version,integrity){
    if(!Array.isArray(statement.subject)||statement.subject.length!==1){
        fail('Each npm attestation must contain exactly one package subject.');
    }
    const subject=statement.subject[0];
    const expectedName=`pkg:npm/${PACKAGE_NAME}@${version}`;
    const sha512=Buffer.from(integrity.slice('sha512-'.length),'base64').toString('hex');
    if(!plainObject(subject)||subject.name!==expectedName||!plainObject(subject.digest)
        ||subject.digest.sha512!==sha512){
        fail('npm attestation subject does not match the exact package version and SHA-512 bytes.');
    }
}

function assertSlsaPredicate(predicate,sourceCommit){
    const buildDefinition=predicate.buildDefinition;
    const workflow=buildDefinition?.externalParameters?.workflow;
    const github=buildDefinition?.internalParameters?.github;
    const dependencies=buildDefinition?.resolvedDependencies;
    if(!plainObject(buildDefinition)||buildDefinition.buildType!==SLSA_BUILD_TYPE
        ||!plainObject(workflow)||workflow.repository!==REPOSITORY_URL
        ||workflow.path!==WORKFLOW_PATH||workflow.ref!=='refs/heads/main'){
        fail('SLSA provenance does not bind the trusted main publication workflow.');
    }
    if(!plainObject(github)||github.event_name!=='workflow_dispatch'){
        fail('SLSA provenance does not bind the workflow_dispatch publication event.');
    }
    if(typeof github.repository_id!=='string'||!/^[1-9][0-9]*$/u.test(github.repository_id)
        ||typeof github.repository_owner_id!=='string'
        ||!/^[1-9][0-9]*$/u.test(github.repository_owner_id)){
        fail('SLSA provenance lacks numeric GitHub repository identities.');
    }
    if(!Array.isArray(dependencies)||dependencies.length!==1
        ||dependencies[0]?.uri!==`git+${REPOSITORY_URL}@refs/heads/main`
        ||dependencies[0]?.digest?.gitCommit!==sourceCommit){
        fail('SLSA provenance does not bind the exact main source commit.');
    }
    const builderId=predicate.runDetails?.builder?.id;
    const invocationId=predicate.runDetails?.metadata?.invocationId;
    if(builderId!=='https://github.com/actions/runner/github-hosted'){
        fail('SLSA provenance was not produced by a GitHub-hosted runner.');
    }
    if(typeof invocationId!=='string'||!/^https:\/\/github\.com\/TheWizardNexus\/arcane-os-sdk\/actions\/runs\/[1-9][0-9]*\/attempts\/[1-9][0-9]*$/u.test(invocationId)){
        fail('SLSA provenance lacks the exact GitHub Actions invocation identity.');
    }
}

export function validateNpmProvenance({auditDocument,version,integrity,sourceCommit}){
    parsePublicationVersion(version);
    assertIntegrity(integrity,'Expected provenance integrity');
    if(typeof sourceCommit!=='string'||!/^[0-9a-f]{40}$/u.test(sourceCommit)){
        fail('Expected provenance source commit must be one lowercase 40-character Git SHA.');
    }
    if(!plainObject(auditDocument)||!Array.isArray(auditDocument.invalid)
        ||!Array.isArray(auditDocument.missing)||!Array.isArray(auditDocument.verified)){
        fail('npm audit signatures output must contain invalid, missing, and verified arrays.');
    }
    if(auditDocument.invalid.length!==0||auditDocument.missing.length!==0){
        fail('npm audit signatures reported invalid or missing package evidence.');
    }
    const matches=auditDocument.verified.filter(item=>item?.name===PACKAGE_NAME&&item?.version===version);
    if(matches.length!==1)fail('npm audit signatures must verify exactly one candidate package.');
    const record=matches[0];
    if(record.registry!=='https://registry.npmjs.org/'){
        fail('npm audit signatures must use the public npm registry.');
    }
    if(!plainObject(record.attestations)
        ||record.attestations.provenance?.predicateType!==SLSA_PREDICATE_TYPE
        ||!Array.isArray(record.attestationBundles)){
        fail('npm audit signatures did not include the candidate attestation bundles.');
    }
    const bundles=record.attestationBundles;
    const slsa=bundles.filter(item=>item?.predicateType===SLSA_PREDICATE_TYPE);
    const publish=bundles.filter(item=>item?.predicateType===PUBLISH_PREDICATE_TYPE);
    if(bundles.length!==2||slsa.length!==1||publish.length!==1){
        fail('npm must provide exactly one SLSA provenance and one npm publish attestation.');
    }
    const slsaStatement=decodeStatement(
        slsa[0].bundle,SLSA_PREDICATE_TYPE,SLSA_STATEMENT_TYPE
    );
    const publishStatement=decodeStatement(
        publish[0].bundle,PUBLISH_PREDICATE_TYPE,PUBLISH_STATEMENT_TYPE
    );
    assertSubject(slsaStatement,version,integrity);
    assertSubject(publishStatement,version,integrity);
    assertSlsaPredicate(slsaStatement.predicate,sourceCommit);
    const publishPredicate=publishStatement.predicate;
    if(publishPredicate.name!==PACKAGE_NAME||publishPredicate.version!==version
        ||publishPredicate.registry!=='https://registry.npmjs.org'){
        fail('npm publish attestation does not bind the exact public package identity.');
    }
    return Object.freeze({
        version,integrity,sourceCommit,
        slsaPredicateType:slsa[0].predicateType,
        publishPredicateType:publish[0].predicateType
    });
}

export function npmProvenanceAuditArguments(){
    return Object.freeze(['audit','signatures','--json','--include-attestations']);
}

function parseArguments(arguments_){
    const [command,...rest]=arguments_;
    const values={
        command,classification:null,metadata:null,packagePath:null,auditPath:null,
        preservedTag:null,preservedVersion:null,maxWaitMs:900_000
    };
    for(let index=0;index<rest.length;index+=1){
        const argument=rest[index];
        if(argument==='--classification')values.classification=rest[++index]??'';
        else if(argument==='--metadata')values.metadata=rest[++index]??'';
        else if(argument==='--package')values.packagePath=rest[++index]??'';
        else if(argument==='--audit')values.auditPath=rest[++index]??'';
        else if(argument==='--preserved-tag')values.preservedTag=rest[++index]??'';
        else if(argument==='--preserved-version')values.preservedVersion=rest[++index]??'';
        else if(argument==='--max-wait-ms')values.maxWaitMs=Number(rest[++index]??'');
        else fail(`Unknown argument: ${argument}.`);
    }
    if(!['policy','preflight','verify','provenance'].includes(command)){
        fail('Command must be policy, preflight, verify, or provenance.');
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
        classification:options.classification,packageDocument,disclosureExists
    });
    if(policy.mode==='staged'){
        fail('Dual-use publication must use npm stage publish followed by human 2FA promotion. This direct-publication workflow intentionally refuses that classification.');
    }
    process.stdout.write('Authorized maintainer classified this exact publication as standard.\n');
}

async function releaseIdentity(metadataPath){
    if(!metadataPath)fail('This command requires --metadata.');
    const verified=await verifyNpmReleaseArtifact({
        metadataPath:path.resolve(metadataPath),requireCleanSource:true
    });
    return {
        version:verified.manifest.version,
        expectedIntegrity:verified.manifest.artifact.integrity,
        expectedShasum:verified.manifest.artifact.shasum,
        sourceCommit:verified.manifest.source.commit
    };
}

async function runPreflight(options){
    const identity=await releaseIdentity(options.metadata);
    const decision=readRegistryPublicationState(identity);
    const outputPath=process.env.GITHUB_OUTPUT;
    if(!outputPath)fail('GITHUB_OUTPUT is required for publication preflight.');
    appendFileSync(outputPath,[
        `needs-publish=${decision.needsPublish}`,
        `channel=${decision.channel}`,
        `preserved-tag=${decision.preservedTag}`,
        `preserved-version=${decision.preservedVersion}`,
        ''
    ].join('\n'));
    process.stdout.write(
        decision.needsPublish
            ? `${PACKAGE_NAME}@${identity.version} requires trusted publication through ${decision.channel}.\n`
            : `${PACKAGE_NAME}@${identity.version} is published or awaiting registry scanning.\n`
    );
}

function assertPreserved(decision,options){
    if(!['dev','latest'].includes(options.preservedTag)||!options.preservedVersion){
        fail('verify requires --preserved-tag and --preserved-version.');
    }
    if(decision.preservedTag!==options.preservedTag
        ||decision.preservedVersion!==options.preservedVersion){
        fail(`The preserved ${options.preservedTag} dist-tag changed during publication.`);
    }
}

async function runVerification(options){
    const identity=await releaseIdentity(options.metadata);
    const started=Date.now();
    let delay=5_000;
    let lastState='pending';
    while(true){
        const decision=readRegistryPublicationState(identity);
        assertPreserved(decision,options);
        lastState=decision.state;
        if(decision.state==='published'){
            process.stdout.write(
                `npm exposes ${PACKAGE_NAME}@${identity.version} with exact integrity, shasum, ${decision.channel}, and preserved ${decision.preservedTag}.\n`
            );
            return;
        }
        const elapsed=Date.now()-started;
        if(elapsed>=options.maxWaitMs)break;
        const waitMilliseconds=Math.min(delay,options.maxWaitMs-elapsed);
        await new Promise(resolve=>setTimeout(resolve,waitMilliseconds));
        delay=Math.min(Math.ceil(delay*1.6),60_000);
    }
    fail(`npm publication remains ${lastState} after ${options.maxWaitMs} ms. Rerun is safe because matching immutable bytes are accepted and mismatches are rejected.`);
}

async function runProvenance(options){
    if(!options.auditPath)fail('provenance requires --audit.');
    const identity=await releaseIdentity(options.metadata);
    const auditDocument=parseJson(readFileSync(path.resolve(options.auditPath),'utf8'),'npm audit signatures output');
    validateNpmProvenance({
        auditDocument,
        version:identity.version,
        integrity:identity.expectedIntegrity,
        sourceCommit:identity.sourceCommit
    });
    process.stdout.write(`npm provenance binds ${PACKAGE_NAME}@${identity.version} to ${REPOSITORY}/${WORKFLOW_PATH} on main.\n`);
}

async function main(arguments_){
    const options=parseArguments(arguments_);
    if(options.command==='policy')runPolicy(options);
    else if(options.command==='preflight')await runPreflight(options);
    else if(options.command==='verify')await runVerification(options);
    else await runProvenance(options);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
    await main(process.argv.slice(2));
}
