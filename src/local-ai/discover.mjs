import {constants} from 'node:fs';
import {access,stat} from 'node:fs/promises';
import path from 'node:path';
import {throwIfAborted} from '../errors.mjs';
import {normalizeLocalAIConfig} from './config.mjs';
import {inspectLocalAIServer,localAIConnectionRefused,localAIServerURL} from './server.mjs';

async function pathExecutable(id,appRoot,signal){
    const filename=`${id==='llama.cpp'?'llama-server':'ollama'}${process.platform==='win32'?'.exe':''}`;
    for(const directory of (process.env.PATH??'').split(path.delimiter)){
        throwIfAborted(signal);
        if(!directory)continue;
        const candidate=path.resolve(appRoot??process.cwd(),directory.replace(/^"|"$/gu,''),filename);
        try{
            await access(candidate,process.platform==='win32'?constants.F_OK:constants.X_OK);
            if((await stat(candidate)).isFile())return candidate;
        }catch(error){
            if(!['ENOENT','ENOTDIR','EACCES','EPERM'].includes(error.code))throw error;
        }
    }
    return null;
}

/** Discover development availability without installing or starting a process. */
export async function discoverLocalAIRuntimes({config,appRoot,signal}={}){
    const selected=normalizeLocalAIConfig(config)?.runtimes??[];
    const outcomes=await Promise.allSettled(selected.map(async function discoverRuntime(requirement){
        throwIfAborted(signal);
        if(!['llama.cpp','ollama'].includes(requirement.id))return {missing:requirement};
        // A PATH executable or HTTP listener cannot establish its compiled
        // backend. An explicit distribution goes through its installer owner.
        if(requirement.id==='llama.cpp'&&requirement.backend&&requirement.backend!=='auto')return {missing:requirement};
        const configuration=config[requirement.id==='llama.cpp'?'llamaCpp':'ollama']??{};
        const url=localAIServerURL(requirement.id,configuration);
        const concreteVersion=requirement.version&&requirement.version!=='latest';
        let discovery;
        try{
            discovery=await inspectLocalAIServer({id:requirement.id,url,signal});
        }catch(error){
            throwIfAborted(signal);
            if(!localAIConnectionRefused(error))throw error;
        }
        if(discovery){
            const matches=!concreteVersion||(discovery.ready&&discovery.version?.replace(/^v/u,'')===requirement.version.replace(/^v/u,''));
            if(!matches)return {missing:requirement};
            // A response from an occupied endpoint is retained in full, even
            // while loading or failing. It never triggers a competing install
            // or process and is never presented as inference readiness.
            return {available:{
                id:requirement.id,version:discovery.version??'system',external:true,
                url,platform:process.platform,architecture:process.arch,
                ...(concreteVersion?{requestedVersion:requirement.version}:{}),discovery
            }};
        }
        if(concreteVersion)return {missing:requirement};
        const executable=await pathExecutable(requirement.id,appRoot,signal);
        if(!executable)return {missing:requirement};
        return {available:{
            id:requirement.id,version:'system',external:true,executable,root:path.dirname(executable),
            platform:process.platform,architecture:process.arch
        }};
    }));
    const failures=outcomes.filter(function failedDiscovery(outcome){return outcome.status==='rejected';});
    if(failures.length===1)throw failures[0].reason;
    if(failures.length>1)throw new AggregateError(failures.map(function discoveryFailure(outcome){return outcome.reason;}),'Local AI runtime discovery failed.');
    throwIfAborted(signal);
    const available=[];
    const missing=[];
    for(const outcome of outcomes){
        if(outcome.value.available)available.push(outcome.value.available);
        else missing.push(outcome.value.missing);
    }
    return {available,missing};
}
