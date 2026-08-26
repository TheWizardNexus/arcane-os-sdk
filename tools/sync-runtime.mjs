#!/usr/bin/env node

import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRuntimeSource} from './runtime-source.mjs';

const toolPath=fileURLToPath(import.meta.url);
const sourceConfigPath=path.join(path.dirname(toolPath),'runtime-source.json');

function retired(){
    const error=new Error(
        'ARCANE_RUNTIME_SYNC_RETIRED: runtime/arcane is canonical SDK source and cannot be overwritten from Arcane OS.'
    );
    error.code='ARCANE_RUNTIME_SYNC_RETIRED';
    throw error;
}

export async function readSourceConfig(filePath=sourceConfigPath){
    return readRuntimeSource(filePath);
}

export async function inspectArcaneRoot(){retired();}
export async function installStagedRuntime(){retired();}

async function main(){
    await readSourceConfig();
    retired();
}

if(process.argv[1]&&path.resolve(process.argv[1])===toolPath){
    main().catch(error=>{
        process.stderr.write(`${error.message}\n`);
        process.exitCode=1;
    });
}
