#!/usr/bin/env node

const CHECK_WORKFLOW_PATH='.github/workflows/check.yml';
const VERSION_PATTERN=/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-dev(?:\.(0|[1-9][0-9]*))?)?$/u;

function fail(message){
    throw new Error(`ARCANE_SELECTED_CHECK_INVALID: ${message}`);
}

function parseArguments(arguments_){
    const values={artifactId:'',runId:'',version:''};
    for(let index=0;index<arguments_.length;index+=1){
        const argument=arguments_[index];
        if(argument==='--artifact-id')values.artifactId=arguments_[++index]??'';
        else if(argument==='--run-id')values.runId=arguments_[++index]??'';
        else if(argument==='--version')values.version=arguments_[++index]??'';
        else fail(`Unknown argument: ${argument}.`);
    }
    for(const [name,value] of [['run id',values.runId],['artifact id',values.artifactId]]){
        if(!/^[1-9][0-9]*$/u.test(value))fail(`${name} must be a positive GitHub identifier.`);
    }
    if(!VERSION_PATTERN.test(values.version)){
        fail('version must be a numeric stable or -dev Arcane SDK version.');
    }
    return values;
}

function requiredEnvironment(name){
    const value=process.env[name];
    if(typeof value!=='string'||value==='')fail(`${name} is required.`);
    return value;
}

function workflowPath(value){
    if(typeof value!=='string')return '';
    return value.split('@',1)[0];
}

async function requestJson(apiUrl,repository,token,relativePath){
    const response=await fetch(`${apiUrl}/repos/${repository}${relativePath}`,{
        headers:{
            Accept:'application/vnd.github+json',
            Authorization:`Bearer ${token}`,
            'User-Agent':'arcane-os-sdk-selected-release-check',
            'X-GitHub-Api-Version':'2022-11-28'
        }
    });
    const body=await response.text();
    if(!response.ok){
        fail(`GitHub API ${relativePath} returned ${response.status} ${response.statusText}: ${body}`);
    }
    try{
        return JSON.parse(body);
    }catch(error){
        fail(`GitHub API ${relativePath} returned malformed JSON: ${error.message}`);
    }
}

async function main(){
    const options=parseArguments(process.argv.slice(2));
    const apiUrl=requiredEnvironment('GITHUB_API_URL').replace(/\/$/u,'');
    const repository=requiredEnvironment('GITHUB_REPOSITORY');
    const expectedHead=requiredEnvironment('GITHUB_SHA');
    const token=requiredEnvironment('GITHUB_TOKEN');
    const run=await requestJson(
        apiUrl,
        repository,
        token,
        `/actions/runs/${options.runId}`
    );

    if(run.repository?.full_name!==repository||run.head_repository?.full_name!==repository){
        fail(`Check run ${options.runId} does not belong to ${repository}.`);
    }
    if(workflowPath(run.path)!==CHECK_WORKFLOW_PATH){
        fail(`Run ${options.runId} did not execute ${CHECK_WORKFLOW_PATH}.`);
    }
    if(run.event!=='workflow_dispatch'){
        fail(`Check run ${options.runId} was not explicitly dispatched.`);
    }
    if(run.head_branch!=='main'){
        fail(`Check run ${options.runId} did not run on main.`);
    }
    if(run.head_sha!==expectedHead){
        fail(`Check run ${options.runId} selected ${run.head_sha}, but publication selected ${expectedHead}.`);
    }
    if(run.status!=='completed'||run.conclusion!=='success'){
        fail(`Check run ${options.runId} must be completed successfully; received ${run.status}/${run.conclusion}.`);
    }

    const artifactDocument=await requestJson(
        apiUrl,
        repository,
        token,
        `/actions/runs/${options.runId}/artifacts?per_page=100`
    );
    const artifacts=Array.isArray(artifactDocument?.artifacts)
        ?artifactDocument.artifacts
        :[];
    const artifact=artifacts.find(candidate=>String(candidate?.id)===options.artifactId);
    if(!artifact)fail(`Artifact ${options.artifactId} does not belong to Check run ${options.runId}.`);
    const expectedName=`arcane-sdk-npm-${options.version}`;
    if(artifact.name!==expectedName){
        fail(`Artifact ${options.artifactId} is ${artifact.name}, not ${expectedName}.`);
    }
    if(artifact.expired===true)fail(`Artifact ${options.artifactId} has expired.`);
    if(String(artifact.workflow_run?.id??'')!==options.runId
        ||artifact.workflow_run?.head_branch!=='main'
        ||artifact.workflow_run?.head_sha!==expectedHead){
        fail(`Artifact ${options.artifactId} is not bound to the selected main revision.`);
    }

    process.stdout.write(
        `Check run ${options.runId} succeeded at ${expectedHead} with artifact ${options.artifactId} for arcane-os ${options.version}.\n`
    );
}

main().catch(error=>{
    process.stderr.write(`${error.message}\n`);
    process.exitCode=1;
});
