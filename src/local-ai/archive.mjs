import {createReadStream} from 'node:fs';
import {mkdir,open,unlink} from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createZstdDecompress} from 'node:zlib';
import {throwIfAborted} from '../errors.mjs';
import {runProcess} from '../process.mjs';

export async function extractLocalAIArchive({archive,directory,signal,onEvent}){
    throwIfAborted(signal);
    await mkdir(directory,{recursive:true});
    const expanded=archive.toLowerCase().endsWith('.zst')?`${archive}.tar`:null;
    let expandedOwned=false;
    let failure;
    try{
        if(expanded){
            const handle=await open(expanded,'wx');
            expandedOwned=true;
            await pipeline(
                createReadStream(archive),
                createZstdDecompress(),
                handle.createWriteStream(),
                {signal}
            );
        }
        throwIfAborted(signal);
        // The host's archive utility preserves upstream directories, executable
        // modes and library links, including archives for a different target.
        if(archive.toLowerCase().endsWith('.zip')&&process.platform==='linux'){
            // GNU tar does not read ZIP. Use the host's unzip utility for a
            // Windows target selected on Linux; a missing utility is reported.
            await runProcess('unzip',['-q',archive,'-d',path.resolve(directory)],{signal,onEvent});
        }else{
            await runProcess(process.platform==='win32'?'tar.exe':'tar',[
                '-xf',expanded??archive,'-C',path.resolve(directory)
            ],{signal,onEvent});
        }
    }catch(error){
        failure=error;
    }finally{
        if(expandedOwned){
            try{
                await unlink(expanded);
            }catch(error){
                if(error.code!=='ENOENT'){
                    failure=failure?new AggregateError([failure,error],'Local AI archive extraction and temporary-file cleanup failed.'):error;
                }
            }
        }
    }
    if(failure)throw failure;
}
