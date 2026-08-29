import {spawn} from 'node:child_process';
import {appendFile,mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const toolRoot=path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot=path.resolve(toolRoot,'..');

function fail(message){
    throw new Error(`ARCANE_NPM_RELEASE_BUILD_FAILED: ${message}`);
}

function parseArguments(arguments_){
    let output=path.join(repositoryRoot,'dist','npm-release');
    for(let index=0;index<arguments_.length;index+=1){
        const argument=arguments_[index];
        if(argument==='--output')output=arguments_[++index]??'';
        else fail(`Unknown argument: ${argument}.`);
    }
    if(output==='')fail('--output requires a directory.');
    return {output:path.resolve(output)};
}

function runNpm(arguments_){
    const executable=process.platform==='win32'?'npm.cmd':'npm';
    return new Promise((resolve,reject)=>{
        const child=spawn(executable,arguments_,{
            cwd:repositoryRoot,
            env:process.env,
            stdio:['ignore','pipe','pipe'],
            windowsHide:true
        });
        const stdout=[];
        const stderr=[];
        child.stdout.on('data',chunk=>stdout.push(chunk));
        child.stderr.on('data',chunk=>stderr.push(chunk));
        child.once('error',reject);
        child.once('close',code=>{
            const output=Buffer.concat(stdout).toString('utf8');
            const diagnostics=Buffer.concat(stderr).toString('utf8').trim();
            if(code===0)resolve(output);
            else reject(new Error(`npm ${arguments_.join(' ')} failed${diagnostics?`: ${diagnostics}`:''}`));
        });
    });
}

async function appendOutputs(values){
    if(!process.env.GITHUB_OUTPUT)return;
    for(const [name,value] of Object.entries(values)){
        if(String(value).includes('\n')||String(value).includes('\r')){
            fail(`GitHub output ${name} contains a newline.`);
        }
    }
    await appendFile(
        process.env.GITHUB_OUTPUT,
        `${Object.entries(values).map(([name,value])=>`${name}=${value}`).join('\n')}\n`,
        'utf8'
    );
}

async function main(){
    const options=parseArguments(process.argv.slice(2));
    const packageDocument=JSON.parse(await readFile(path.join(repositoryRoot,'package.json'),'utf8'));
    if(packageDocument.name!=='arcane-os')fail('package.json must identify arcane-os.');
    const channel=packageDocument.version.includes('-')?'dev':'latest';
    if(packageDocument.publishConfig?.tag!==channel){
        fail(`${packageDocument.version} must publish through the npm ${channel} tag.`);
    }
    await mkdir(options.output,{recursive:true});

    let reports;
    try{
        reports=JSON.parse(await runNpm([
            'pack',repositoryRoot,'--ignore-scripts','--json','--pack-destination',options.output
        ]));
    }catch(error){
        fail(error.message);
    }
    const report=Array.isArray(reports)?reports.find(item=>item?.name===packageDocument.name):null;
    if(report?.version!==packageDocument.version||typeof report.filename!=='string'
        ||path.basename(report.filename)!==report.filename){
        fail('npm pack did not return the selected package version and tarball filename.');
    }
    const values={
        version:packageDocument.version,
        channel,
        tarball:path.join(options.output,report.filename),
        'tarball-filename':report.filename
    };
    await appendOutputs(values);
    process.stdout.write(`${JSON.stringify(values,null,2)}\n`);
}

await main();
