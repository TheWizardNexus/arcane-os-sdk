import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError,ERROR_CODES,errorRecord,normalizeError,throwIfAborted} from '../errors.mjs';
import {createEventQueue} from '../event-queue.mjs';
import {runProcess} from '../process.mjs';

const is=new Is(false);

export function localAIConnectionRefused(error){
    if(error?.code==='ECONNREFUSED'||error?.cause?.code==='ECONNREFUSED')return true;
    const failures=error?.errors??error?.cause?.errors;
    return is.array(failures)&&failures.length>0&&failures.every(localAIConnectionRefused);
}

function localHostname(hostname){
    return hostname==='localhost'||hostname==='127.0.0.1'||hostname==='[::1]'||hostname==='::1';
}

export function localAIServerURL(id,configuration={}){
    return configuration.url??(id==='llama.cpp'?'http://127.0.0.1:8080':'http://127.0.0.1:11434');
}

export async function inspectLocalAIServer({id,url,signal}){
    throwIfAborted(signal);
    const endpoint=new URL(id==='llama.cpp'?'/health':'/api/version',url);
    const response=await fetch(endpoint,{signal});
    const content=await response.text();
    throwIfAborted(signal);
    let result=null;
    try{
        result=JSON.parse(content);
    }catch(error){
        if(!(error instanceof SyntaxError))throw error;
    }
    const ready=response.ok&&(id==='llama.cpp'?result?.status==='ok':is.string(result?.version)&&Boolean(result.version));
    return {url,status:response.status,ready,version:id==='ollama'&&is.string(result?.version)?result.version:undefined,content,result};
}

async function probeServer(id,url,signal){
    const observed=await inspectLocalAIServer({id,url,signal});
    if(!observed.ready){
        if(id==='llama.cpp'&&observed.status===503&&observed.result?.error?.message==='Loading model'){
            throw new ArcaneError('LOCAL_AI_LOADING','llama.cpp is loading its model.',{details:observed});
        }
        throw new ArcaneError(ERROR_CODES.operationFailed,`${id} readiness returned HTTP ${observed.status}: ${observed.content}`,{details:observed});
    }
    return observed;
}

export function createLocalAIServer({id,configuration={},runtime,appRoot,signal,onEvent,onState}={}){
    if(!['llama.cpp','ollama'].includes(id)){
        throw new ArcaneError(ERROR_CODES.usage,`Unsupported local AI server: ${String(id)}.`);
    }
    const url=localAIServerURL(id,configuration);
    const endpoint=new URL(url);
    const controller=new AbortController();
    const operationSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const events=createEventQueue(onEvent,{onFailure:fail});
    let current={id,url,state:'starting',available:false,owned:false};
    let owned=false;
    let processTask=null;
    let processObservation=null;
    let startupTask=null;
    let closeTask=null;
    let closing=false;
    let settled=false;
    let readinessStarted=false;
    let readinessTask=null;
    let terminalFailure=null;
    let resolveReady;
    let rejectReady;
    const output={stdout:'',stderr:''};
    const ready=new Promise(function createReadiness(resolve,reject){
        resolveReady=resolve;
        rejectReady=reject;
    });
    // Readiness remains returned to the caller; this observer prevents a
    // background start from creating an unhandled rejection before it is used.
    void ready.catch(function observeReadinessFailure(){return undefined;});

    async function publishState(state,error){
        current={id,url,state,available:state==='ready',owned,...(error?{error:errorRecord(error)}:{})};
        await onState?.(current);
        await events.send({
            type:`local-ai.server.${state}`,
            message:error?`${id}: ${error.message}`:`${id} is ${state}.`,
            data:{...current,...(error?{error}:{})}
        });
    }

    function settleReady(error){
        if(settled)return;
        settled=true;
        if(error)rejectReady(error);
        else resolveReady(current);
    }

    async function fail(error){
        const failure=normalizeError(error);
        terminalFailure??=failure;
        controller.abort(failure);
        settleReady(failure);
        try{
            const state=closing?'stopped':failure.code==='LOCAL_AI_LOADING'?'loading':'error';
            await publishState(state,state==='error'?failure:undefined);
        }catch(observerError){
            // Keep the callback failure visible on the returned observation;
            // the operation's original failure remains on the ready Promise.
            current={...current,available:false,error:errorRecord(observerError)};
            throw observerError;
        }
    }

    async function confirmReadiness(){
        await probeServer(id,url,operationSignal);
        throwIfAborted(operationSignal);
        await publishState('ready');
        throwIfAborted(operationSignal);
        settleReady();
    }

    async function forwardProcessEvent(event){
        await events.send(event);
        if(readinessStarted||closing||operationSignal.aborted)return;
        if(event.type==='process.stdout')output.stdout+=event.data?.line??event.message;
        else if(event.type==='process.stderr')output.stderr+=event.data?.line??event.message;
        else return;
        const text=event.type==='process.stdout'?output.stdout:output.stderr;
        // llama.cpp b11146 and b6000 emit these after HTTP/model readiness;
        // Ollama emits its listener announcement before serving queued requests.
        const announced=id==='llama.cpp'?/\b(?:llama_server:\s*listening on |main:\s*server is listening on )/u.test(text):/Listening on /u.test(text);
        if(!announced)return;
        readinessStarted=true;
        // Do not hold the process-output callback while the health response
        // waits for upstream startup; stdout/stderr must continue draining.
        readinessTask=confirmReadiness().catch(fail);
        void readinessTask.catch(function observeReadinessCallbackFailure(){return undefined;});
    }

    async function start(){
        await publishState('starting');
        throwIfAborted(operationSignal);
        let existing=false;
        try{
            // Discovery may precede another runtime's installation. Read the
            // endpoint at this actual launch boundary rather than presenting
            // that earlier installation-selection snapshot as current health.
            const observed=await probeServer(id,url,operationSignal);
            if(runtime?.requestedVersion&&runtime.requestedVersion!=='latest'){
                const requested=runtime.requestedVersion.replace(/^v/u,'');
                if(!is.string(observed.version)||observed.version.replace(/^v/u,'')!==requested){
                    throw new ArcaneError(ERROR_CODES.operationFailed,`The running ${id} service does not establish the requested version ${runtime.requestedVersion}. Select an available listener for that installed runtime.`,{details:observed});
                }
            }
            existing=true;
        }catch(error){
            throwIfAborted(operationSignal);
            // An HTTP error is an existing service's state. Only a refused
            // connection allows starting the selected local executable.
            if(!localAIConnectionRefused(error))throw error;
            if(!localHostname(endpoint.hostname))throw error;
        }
        if(existing){
            await publishState('ready');
            throwIfAborted(operationSignal);
            settleReady();
            return;
        }
        if(!runtime?.executable){
            throw new ArcaneError(ERROR_CODES.prerequisiteMissing,`No installed ${id} executable was supplied.`);
        }
        if(endpoint.protocol!=='http:'){
            throw new ArcaneError(ERROR_CODES.usage,`${id} managed startup requires its direct HTTP listener URL.`);
        }
        if(!is.string(appRoot)||!appRoot){
            throw new ArcaneError(ERROR_CODES.usage,`${id} managed startup needs its application root.`);
        }
        const args=configuration.args??[];
        if(!is.array(args)||args.some(function nonStringArgument(argument){
            return !is.string(argument);
        })){
            throw new ArcaneError(ERROR_CODES.usage,`${id} arguments must be an array of strings.`);
        }
        const modelsDirectory=path.resolve(appRoot,configuration.modelsDirectory??path.join('.arcane','models',id));
        await mkdir(modelsDirectory,{recursive:true});
        throwIfAborted(operationSignal);
        const host=endpoint.hostname.replace(/^\[|\]$/gu,'');
        const port=endpoint.port||'80';
        const arguments_=id==='ollama'?['serve',...args]:[
            '--host',host,'--port',port,'--jinja',
            ...(configuration.model?['--model',path.resolve(appRoot,configuration.model)]:['--models-dir',modelsDirectory]),
            ...args
        ];
        const env=id==='ollama'?{OLLAMA_HOST:endpoint.origin,OLLAMA_MODELS:modelsDirectory}:undefined;
        owned=true;
        await publishState('starting');
        throwIfAborted(operationSignal);
        processTask=runProcess(runtime.executable,arguments_,{
            cwd:path.dirname(runtime.executable),env,signal:operationSignal,onEvent:forwardProcessEvent
        });
        processObservation=processTask.then(async function localServerExited(result){
            if(terminalFailure)return;
            if(closing||operationSignal.aborted){
                settleReady(new ArcaneError(ERROR_CODES.cancelled,`${id} startup was cancelled.`,{exitCode:130}));
                await publishState('stopped');
                return;
            }
            await fail(new ArcaneError(ERROR_CODES.operationFailed,`${id} stopped with exit code ${result.code}.`,{details:result}));
        },async function localServerFailed(error){
            if(terminalFailure)return;
            if(closing||(signal?.aborted&&!events.error)){
                settleReady(normalizeError(error));
                await publishState('stopped');
                return;
            }
            await fail(error);
        });
        void processObservation.catch(function observeProcessCallbackFailure(error){
            current={...current,state:'error',available:false,error:errorRecord(error)};
            settleReady(error);
        });
    }

    async function finishClose(){
        closing=true;
        operationSignal.removeEventListener('abort',observeLifetimeAbort);
        controller.abort(new ArcaneError(ERROR_CODES.cancelled,`${id} was stopped by its owner.`,{exitCode:130}));
        const startup=await Promise.allSettled([startupTask]);
        const tasks=[processObservation,readinessTask].filter(function activeTask(task){return task!==null;});
        const outcomes=await Promise.allSettled(tasks);
        settleReady(new ArcaneError(ERROR_CODES.cancelled,`${id} startup was cancelled.`,{exitCode:130}));
        await publishState('stopped');
        await events.drain();
        const failures=[...startup,...outcomes].filter(function failedTask(outcome){return outcome.status==='rejected';});
        if(failures.length===1)throw failures[0].reason;
        if(failures.length>1)throw new AggregateError(failures.map(function taskFailure(outcome){return outcome.reason;}),`${id} shutdown observers failed.`);
    }

    function close(){
        closeTask??=finishClose();
        return closeTask;
    }

    function observeLifetimeAbort(){
        if(closing||terminalFailure)return;
        void close().catch(function observeAbortShutdownFailure(error){
            current={...current,state:'error',available:false,error:errorRecord(error)};
            settleReady(error);
        });
    }

    startupTask=start().catch(fail);
    void startupTask.catch(function observeStartupCallbackFailure(error){
        current={...current,state:'error',available:false,error:errorRecord(error)};
        settleReady(error);
    });
    operationSignal.addEventListener('abort',observeLifetimeAbort,{once:true});
    if(operationSignal.aborted)observeLifetimeAbort();

    return {ready,url,close,get owned(){return owned;},get current(){return current;}};
}
