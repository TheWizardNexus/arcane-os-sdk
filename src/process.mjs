import Is from 'strong-type';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {ArcaneError,ERROR_CODES,throwIfAborted} from './errors.mjs';
import {createEventQueue} from './event-queue.mjs';
import {windowsGitEnvironment} from './windows-git-executable.mjs';

const is = new Is(false);

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

function appendOutput(current,text){
    return current+text;
}

async function emitLines(events,type,text){
    for(const line of text.split(/\r?\n/u)){
        if(line){
            await events.send({type,message:line,data:{line}});
        }
    }
}

function outputSelected(option,stream){
    return is.boolean(option)?option:option?.[stream]??true;
}

function outputEncodingSelected(option,stream){
    const selected=option!==null&&is.object(option)?option[stream]:option;
    const encoding=selected===undefined?'utf8':selected;
    if(encoding!=='utf8'&&encoding!==null){
        throw new TypeError(`The ${stream} outputEncoding must be 'utf8' or null.`);
    }
    return encoding;
}

function deliverChunk(stream,events,type,chunk,{onOutput,emitOutput,onFailure}){
    stream.pause();
    return (async function deliverOutput(){
        try{
            if(onOutput)await onOutput({stream:type==='process.stdout'?'stdout':'stderr',chunk});
        }catch(error){
            onFailure(error);
        }
        if(emitOutput)await emitLines(events,type,chunk);
    })().catch(()=>{
        // The event queue separately owns and propagates observer failures.
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
    return is.integer(child?.pid)&&child.pid>0;
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
    onOutput,
    captureOutput=true,
    emitOutputEvents=true,
    outputEncoding='utf8',
    heartbeatMs=5000,
    terminationGraceMs=DEFAULT_TERMINATION_GRACE_MS,
    allowNonzero=false,
    input,
    cancellationMode='terminate-tree'
}={}){
    throwIfAborted(signal);
    if(onOutput!==undefined&&!is.function(onOutput)){
        throw new TypeError('onOutput must be a function.');
    }
    const outputEncodings={
        stdout:outputEncodingSelected(outputEncoding,'stdout'),
        stderr:outputEncodingSelected(outputEncoding,'stderr')
    };
    for(const stream of ['stdout','stderr']){
        if(outputEncodings[stream]===null&&(!onOutput
            ||outputSelected(captureOutput,stream)!==false
            ||outputSelected(emitOutputEvents,stream)!==false)){
            throw new TypeError(`Raw ${stream} requires onOutput, captureOutput:false and emitOutputEvents:false for that stream.`);
        }
    }
    if(!onOutput&&(!outputSelected(captureOutput,'stdout')||!outputSelected(captureOutput,'stderr'))){
        throw new TypeError('Uncaptured process output requires an onOutput consumer.');
    }
    if(!is.array(args)||args.some(argument=>!is.string(argument))){
        throw new ArcaneError(ERROR_CODES.usage,'Process arguments must be a fixed array of strings.');
    }
    if(cancellationMode!=='terminate-tree'&&cancellationMode!=='close-input'){
        throw new ArcaneError(ERROR_CODES.usage,'Unknown process cancellation mode.');
    }
    if(!is.integer(terminationGraceMs)||terminationGraceMs<100||terminationGraceMs>30_000){
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

    let childEnvironment=env?{...process.env,...env}:process.env;
    if(process.platform==='win32'&&command==='git'){
        try{
            childEnvironment=await windowsGitEnvironment(childEnvironment,{
                run:runProcess,signal,
                onEvent:function discoveryEvent(event){
                    return events.send({
                        ...event,type:event.type.replace(/^process\./u,'process.git.discovery.')
                    });
                }
            });
        }catch(error){
            throwIfAborted(signal);
            if(events.error)throw events.error;
            await events.send({
                type:'process.git.discovery.unavailable',
                message:'Registered Git discovery was unavailable; using the existing command environment.',
                data:{error}
            });
        }
        throwIfAborted(signal);
    }

    return new Promise((resolve,reject)=>{
        let stdout=outputEncodings.stdout!==null&&outputSelected(captureOutput,'stdout')?'':null;
        let stderr=outputEncodings.stderr!==null&&outputSelected(captureOutput,'stderr')?'':null;
        let childClosed=false;
        let closedResult=null;
        let settlementStarted=false;
        let cancellationRequested=false;
        let cancellationError=null;
        let terminationRequested=false;
        let escalation=null;
        let spawnError=null;
        let inputError=null;
        let inputIterator=null;
        let inputPump=null;
        let inputReturn=null;
        let inputDone=false;
        const outputErrors=[];
        let child;
        let heartbeat=null;
        const deliveries=new Set();

        const ownDelivery=(stream,type,chunk)=>{
            const name=type==='process.stdout'?'stdout':'stderr';
            const delivery=deliverChunk(stream,events,type,chunk,{
                onOutput,
                emitOutput:outputEncodings[name]!==null&&outputSelected(emitOutputEvents,name),
                onFailure:function outputFailed(error){
                    // Preserve complete failed callback input even when the
                    // caller elected not to retain successful protocol output.
                    outputErrors.push(new ArcaneError(ERROR_CODES.operationFailed,
                        `The ${name} output callback failed.`,{cause:error,details:{stream:name,chunk}}));
                    stopTree();
                }
            });
            deliveries.add(delivery);
            void delivery.then(()=>deliveries.delete(delivery));
        };

        const drainDeliveries=async()=>{
            while(deliveries.size>0){
                await Promise.all([...deliveries]);
            }
        };

        function stopInput(){
            if(inputIterator&&!inputDone&&!inputReturn){
                inputReturn=Promise.resolve().then(async function returnInput(){
                    await inputIterator.return?.();
                }).catch(function inputReturnFailed(error){
                    inputError=inputError&&inputError!==error
                        ?new AggregateError([inputError,error],'Process input and its cleanup failed.'):error;
                });
            }
            child?.stdin.end();
        }

        async function drainInput(){
            stopInput();
            // AsyncIterable producers own cancellation of an outstanding next().
            // Their return() must cooperate so owned cleanup can really finish.
            await inputPump;
            await inputReturn;
        }

        const finish=(callback,value)=>{
            if(settlementStarted){
                return;
            }
            settlementStarted=true;
            clearInterval(heartbeat);
            clearTimeout(escalation);
            signal?.removeEventListener('abort',abort);
            void (async()=>{
                await drainInput();
                let callbackFailure=null;
                try{
                    await events.drain();
                }catch(error){
                    callbackFailure=error;
                }
                if((cancellationMode==='close-input'&&closedResult)||inputIterator||onOutput){
                    const failures=[...new Set([
                        callback===reject?value:null,
                        callbackFailure,inputError,cancellationError,spawnError,...outputErrors
                    ].filter(error=>error!==null))];
                    if(failures.length>0){
                        const primary=failures[0];
                        // Owned cancellation/exit errors already carry this exact
                        // result. Other errors retain their identity and cause in
                        // the complete failure record instead of being rewritten.
                        if(failures.length===1&&primary?.details===closedResult){
                            reject(primary);
                            return;
                        }
                        const failure=new ArcaneError(
                            primary?.code??ERROR_CODES.operationFailed,
                            primary?.message??`Could not complete ${command}.`,
                            {cause:primary,details:closedResult,exitCode:primary?.exitCode}
                        );
                        failure.errors=failures;
                        reject(failure);
                        return;
                    }
                }
                if(callbackFailure){
                    reject(callbackFailure);
                    return;
                }
                callback(value);
            })().catch(reject);
        };

        const stopTree=()=>{
            if(terminationRequested||settlementStarted||childClosed){
                return;
            }
            terminationRequested=true;
            stopInput();
            if(cancellationMode==='close-input'){
                // The selected host owns shutdown after EOF. Keep observing its
                // complete output and exit; accepted durable work may outlive UI.
                return;
            }
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
            if(cancellationRequested||settlementStarted||childClosed){
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
                message:cancellationMode==='close-input'
                    ?`Closing ${command} input and waiting for its owned shutdown.`
                    :`Stopping ${command} and its child processes.`,
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
                env:childEnvironment,
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

        // Text streams retain split UTF-8 sequences and flush at EOF. Explicit
        // raw streams bypass decoding and deliver native Buffers only to onOutput.
        if(outputEncodings.stdout!==null)child.stdout.setEncoding(outputEncodings.stdout);
        if(outputEncodings.stderr!==null)child.stderr.setEncoding(outputEncodings.stderr);
        child.stdout.on('data',chunk=>{
            if(stdout!==null)stdout=appendOutput(stdout,chunk);
            ownDelivery(child.stdout,'process.stdout',chunk);
        });
        child.stderr.on('data',chunk=>{
            if(stderr!==null)stderr=appendOutput(stderr,chunk);
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
            // The child lifetime has ended even while its output/event callbacks
            // are still draining. A later abort cannot cancel that completed work.
            childClosed=true;
            signal?.removeEventListener('abort',abort);
            clearInterval(heartbeat);
            void (async()=>{
                await drainInput();
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
                closedResult=result;
                if(terminationRequested){
                    // The direct child has exited. Make one final tree-wide attempt so
                    // a descendant that ignored the graceful request cannot outlive it.
                    if(cancellationMode!=='close-input')terminateProcessTree(child,{force:true});
                    if(cancellationRequested){
                        await events.enqueue({
                            type:'process.cancelled',
                            message:`${command} stopped after cancellation.`,
                            data:{command,code:result.code,signal:terminationSignal}
                        });
                    }
                    if(cancellationError)cancellationError.details=result;
                    finish(reject,events.error??inputError??outputErrors[0]??cancellationError??new ArcaneError(
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
                if(inputError){
                    finish(reject,new ArcaneError(ERROR_CODES.operationFailed,
                        `Could not write ${command} input: ${inputError.message}`,
                        {cause:inputError,details:result}));
                    return;
                }
                if(outputErrors.length){
                    finish(reject,outputErrors[0]);
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
                        `${command} exited with code ${String(result.code)}${stderr?`: ${stderr}`:''}`,
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

        if(input&&is.function(input[Symbol.asyncIterator])){
            child.stdin.on('error',error=>{inputError=error;stopTree();});
            inputPump=(async function pumpInput(){
                try{
                    inputIterator=input[Symbol.asyncIterator]();
                    while(!terminationRequested&&!childClosed){
                        const next=await inputIterator.next();
                        if(next.done){inputDone=true;break;}
                        if(terminationRequested||childClosed)break;
                        await new Promise(function writeChunk(resolve,reject){
                            child.stdin.write(next.value,function written(error){
                                if(error)reject(error);
                                else resolve();
                            });
                        });
                    }
                    child.stdin.end();
                }catch(error){
                    inputError=inputError&&inputError!==error
                        ?new AggregateError([inputError,error],'Process input failed.'):error;
                    stopTree();
                }
            })();
        }else if(cancellationMode==='close-input'){
            child.stdin.on('error',error=>{inputError=error;stopTree();});
            if(input!==undefined&&!terminationRequested)child.stdin.write(input);
        }else if(input!==undefined){
            child.stdin.end(input);
        }else{
            child.stdin.end();
        }
    });
}
