import {spawn} from 'node:child_process';
import path from 'node:path';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {createEventQueue} from './event-queue.mjs';

const MAX_CAPTURE_BYTES=4*1024*1024;
const DEFAULT_TERMINATION_GRACE_MS=1500;

export function platformCommand(command,platform=process.platform){
    if(platform==='win32'&&(command==='npm'||command==='npx')){
        return process.execPath;
    }
    return command;
}

function platformArguments(command,args,platform=process.platform){
    if(platform!=='win32'||(command!=='npm'&&command!=='npx')){
        return args;
    }
    const cliName=command==='npm'?'npm-cli.js':'npx-cli.js';
    const environmentCli=command==='npm'&&process.env.npm_execpath?.endsWith(cliName)
        ?process.env.npm_execpath
        :null;
    const cliPath=environmentCli??path.join(
        path.dirname(process.execPath),
        'node_modules',
        'npm',
        'bin',
        cliName
    );
    return [cliPath,...args];
}

function appendBounded(current,chunk){
    const next=current+chunk.toString('utf8');
    if(Buffer.byteLength(next,'utf8')<=MAX_CAPTURE_BYTES){
        return next;
    }
    return next.slice(next.length-MAX_CAPTURE_BYTES);
}

async function emitLines(events,type,text){
    for(const line of text.split(/\r?\n/u)){
        if(line){
            await events.send({type,message:line,data:{line}});
        }
    }
}

function deliverChunk(stream,events,type,chunk){
    stream.pause();
    return emitLines(events,type,chunk.toString('utf8')).catch(()=>{
        // The queue owns and propagates the first callback failure.
    }).finally(()=>{
        if(!stream.destroyed){
            stream.resume();
        }
    });
}

function childIsRunning(child){
    return Boolean(child?.pid)&&child.exitCode===null&&child.signalCode===null;
}

function childHasPid(child){
    return Number.isInteger(child?.pid)&&child.pid>0;
}

function terminateWindowsTree(child,{force=false}={}){
    if(!childHasPid(child)){
        return;
    }
    const arguments_=['/PID',String(child.pid),'/T',...(force?['/F']:[])];
    let killer;
    try{
        killer=spawn('taskkill.exe',arguments_,{
            shell:false,
            windowsHide:true,
            stdio:'ignore'
        });
    }catch{
        if(force){
            child.kill('SIGKILL');
        }
        return;
    }
    killer.once('error',()=>{
        if(force&&childIsRunning(child)){
            child.kill('SIGKILL');
        }
    });
    killer.once('close',code=>{
        if(force&&code!==0&&childIsRunning(child)){
            child.kill('SIGKILL');
        }
    });
    killer.unref();
}

function terminateUnixTree(child,signal){
    if(!childHasPid(child)){
        return;
    }
    try{
        process.kill(-child.pid,signal);
    }catch(error){
        if(error?.code!=='ESRCH'&&childIsRunning(child)){
            child.kill(signal);
        }
    }
}

function terminateProcessTree(child,{force=false,platform=process.platform}={}){
    if(platform==='win32'){
        terminateWindowsTree(child,{force});
    }else{
        terminateUnixTree(child,force?'SIGKILL':'SIGTERM');
    }
}

export async function runProcess(command,args=[],{
    cwd,
    env,
    signal,
    onEvent,
    heartbeatMs=5000,
    terminationGraceMs=DEFAULT_TERMINATION_GRACE_MS,
    allowNonzero=false,
    input
}={}){
    throwIfAborted(signal);
    if(!Array.isArray(args)||args.some(argument=>typeof argument!=='string')){
        throw new ArcaneError(ERROR_CODES.usage,'Process arguments must be a fixed array of strings.');
    }
    if(!Number.isInteger(terminationGraceMs)||terminationGraceMs<100||terminationGraceMs>30_000){
        throw new ArcaneError(
            ERROR_CODES.usage,
            'terminationGraceMs must be an integer from 100 through 30000.'
        );
    }

    const executable=platformCommand(command);
    const executableArgs=platformArguments(command,args);
    let stopForEventFailure=()=>{};
    const events=createEventQueue(onEvent,{
        onFailure:error=>stopForEventFailure(error)
    });
    await events.send({
        type:'process.starting',
        message:`Starting ${command}.`,
        data:{command,args,cwd:cwd??process.cwd()}
    });
    throwIfAborted(signal);

    return new Promise((resolve,reject)=>{
        let stdout='';
        let stderr='';
        let settlementStarted=false;
        let cancellationRequested=false;
        let cancellationError=null;
        let terminationRequested=false;
        let escalation=null;
        let spawnError=null;
        let child;
        let heartbeat=null;
        const deliveries=new Set();

        const ownDelivery=(stream,type,chunk)=>{
            const delivery=deliverChunk(stream,events,type,chunk);
            deliveries.add(delivery);
            void delivery.then(()=>deliveries.delete(delivery));
        };

        const drainDeliveries=async()=>{
            while(deliveries.size>0){
                await Promise.all([...deliveries]);
            }
        };

        const finish=(callback,value)=>{
            if(settlementStarted){
                return;
            }
            settlementStarted=true;
            clearInterval(heartbeat);
            clearTimeout(escalation);
            signal?.removeEventListener('abort',abort);
            void (async()=>{
                try{
                    await events.drain();
                }catch(callbackFailure){
                    reject(callbackFailure);
                    return;
                }
                callback(value);
            })().catch(reject);
        };

        const stopTree=()=>{
            if(terminationRequested||settlementStarted){
                return;
            }
            terminationRequested=true;
            terminateProcessTree(child);
            escalation=setTimeout(()=>{
                if(childIsRunning(child)){
                    void events.enqueue({
                        type:'process.cancellation.escalated',
                        message:`Forcing ${command} and its child processes to stop.`,
                        data:{command,pid:child.pid}
                    });
                    terminateProcessTree(child,{force:true});
                }
            },terminationGraceMs);
            escalation.unref?.();
        };

        const abort=()=>{
            if(cancellationRequested||settlementStarted){
                return;
            }
            cancellationRequested=true;
            cancellationError=new ArcaneError(
                ERROR_CODES.cancelled,
                `Cancelled ${command}.`,
                {cause:signal?.reason,exitCode:130}
            );
            void events.enqueue({
                type:'process.cancellation.requested',
                message:`Stopping ${command} and its child processes.`,
                data:{command,pid:child?.pid??null}
            });
            stopTree();
        };

        stopForEventFailure=stopTree;

        heartbeat=setInterval(()=>{
            void events.enqueue(
                {
                    type:'process.heartbeat',
                    message:`${command} is still running.`,
                    data:{command,pid:child?.pid??null}
                },
                {coalesce:'process.heartbeat'}
            );
        },Math.max(1000,heartbeatMs));
        heartbeat.unref?.();

        try{
            child=spawn(executable,executableArgs,{
                cwd,
                env:env?{...process.env,...env}:process.env,
                shell:false,
                detached:process.platform!=='win32',
                windowsHide:true,
                stdio:['pipe','pipe','pipe']
            });
        }catch(error){
            finish(reject,new ArcaneError(
                ERROR_CODES.prerequisiteMissing,
                `Could not start ${command}: ${error.message}`,
                {cause:error}
            ));
            return;
        }

        child.stdout.on('data',chunk=>{
            stdout=appendBounded(stdout,chunk);
            ownDelivery(child.stdout,'process.stdout',chunk);
        });
        child.stderr.on('data',chunk=>{
            stderr=appendBounded(stderr,chunk);
            ownDelivery(child.stderr,'process.stderr',chunk);
        });
        child.on('error',error=>{
            spawnError=error;
            if(!child.pid){
                finish(reject,new ArcaneError(
                    ERROR_CODES.prerequisiteMissing,
                    `Could not run ${command}: ${error.message}`,
                    {cause:error}
                ));
            }
        });
        child.on('close',(code,terminationSignal)=>{
            clearInterval(heartbeat);
            void (async()=>{
                await drainDeliveries();
                if(settlementStarted)return;
                const result={
                    command,
                    args:[...args],
                    cwd:cwd??process.cwd(),
                    code:code??1,
                    signal:terminationSignal,
                    stdout,
                    stderr
                };
                if(terminationRequested){
                    // The direct child has exited. Make one final tree-wide attempt so
                    // a descendant that ignored the graceful request cannot outlive it.
                    terminateProcessTree(child,{force:true});
                    if(cancellationRequested){
                        await events.enqueue({
                            type:'process.cancelled',
                            message:`${command} stopped after cancellation.`,
                            data:{command,code:result.code,signal:terminationSignal}
                        });
                    }
                    finish(reject,events.error??cancellationError??new ArcaneError(
                        ERROR_CODES.operationFailed,
                        `Stopped ${command} after its event callback failed.`
                    ));
                    return;
                }
                if(spawnError){
                    finish(reject,new ArcaneError(
                        ERROR_CODES.prerequisiteMissing,
                        `Could not run ${command}: ${spawnError.message}`,
                        {cause:spawnError}
                    ));
                    return;
                }
                await events.enqueue({
                    type:'process.completed',
                    message:`${command} exited with code ${String(result.code)}.`,
                    data:{command,code:result.code,signal:terminationSignal}
                });
                if(result.code!==0&&!allowNonzero){
                    finish(reject,new ArcaneError(
                        ERROR_CODES.operationFailed,
                        `${command} exited with code ${String(result.code)}${stderr.trim()?`: ${stderr.trim()}`:''}`,
                        {details:result}
                    ));
                    return;
                }
                finish(resolve,result);
            })().catch(error=>finish(reject,error));
        });

        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted){
            abort();
        }

        if(input!==undefined){
            child.stdin.end(input);
        }else{
            child.stdin.end();
        }
    });
}
