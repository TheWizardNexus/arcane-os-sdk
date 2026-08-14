import {execFile} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const repositoryRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const cliPath=path.join(repositoryRoot,'bin','arcane.mjs');

export async function temporaryDirectory(t,{prefix='arcane-sdk-test-'}={}){
    const directory=await mkdtemp(path.join(tmpdir(),prefix));
    t.after(()=>rm(directory,{recursive:true,force:true}));
    return directory;
}

export function runCommand(command,arguments_,{
    cwd=repositoryRoot,
    env={},
    timeout=30_000
}={}){
    return new Promise(resolve=>{
        execFile(
            command,
            arguments_,
            {
                cwd,
                env:{...process.env,...env},
                encoding:'utf8',
                maxBuffer:16*1024*1024,
                timeout,
                windowsHide:true
            },
            (error,stdout,stderr)=>resolve({
                code:error?.code==='ETIMEDOUT'?null:error?.code??0,
                signal:error?.signal??null,
                timedOut:error?.code==='ETIMEDOUT',
                stdout,
                stderr,
                error
            })
        );
    });
}

export function runNode(arguments_,options){
    return runCommand(process.execPath,arguments_,options);
}

export function runCli(arguments_,options){
    return runNode([cliPath,...arguments_],options);
}

export function parseNdjson(source){
    return source.split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
}

export function parseLastJsonLine(source){
    for(const line of source.split(/\r?\n/).reverse()){
        if(!line.trim())continue;
        try{return JSON.parse(line);}
        catch{}
    }
    throw new Error(`Command output did not end with a JSON document: ${source.slice(-1000)}`);
}
