import {Worker} from 'node:worker_threads';
import Is from 'strong-type';
import {createArcaneEventSource} from '../event-manager.mjs';
import {createEventQueue} from '../event-queue.mjs';

const is=new Is(false);

function failure(code,message,cause){
    const error=new Error(message,{cause});
    error.code=code;
    return error;
}

function cancelled(reason){
    const error=failure('ARCANE_CANCELLED','The ONNX operation was cancelled.',reason);
    error.name='AbortError';
    return error;
}

function describeError(error){
    if(!(error instanceof Error))return {name:'Error',message:String(error),cause:error};
    const result={...error,name:error.name,message:error.message,stack:error.stack};
    if(error.cause!==undefined)result.cause=error.cause instanceof Error?describeError(error.cause):error.cause;
    if(error instanceof AggregateError)result.errors=error.errors.map(describeError);
    return result;
}

function restoreError(record){
    return Object.assign(new Error(record.message,{cause:record.cause}),record);
}

function reportBackgroundError(error){
    if(is.function(globalThis.reportError))globalThis.reportError(error);
    else console.error(error);
}

function waitForRelease(task,signal){
    if(!signal)return task;
    if(signal.aborted)return Promise.reject(cancelled(signal.reason));
    return new Promise(function joinRelease(resolve,reject){
        function abort(){reject(cancelled(signal.reason));}
        function complete(result){signal.removeEventListener('abort',abort);resolve(result);}
        function failed(error){signal.removeEventListener('abort',abort);reject(error);}
        signal.addEventListener('abort',abort,{once:true});
        void task.then(complete,failed);
    });
}

export function createONNXRuntime({modulePath,onEvent,signal}={}){
    const owner={};
    const events=createArcaneEventSource(owner,{source:'local-ai.onnx',eventTypes:['onnx.state']});
    const diagnosticFailures=[];
    const diagnostics=createEventQueue(deliverDiagnostic,{onFailure:reportBackgroundError});
    const sessions=new Map();
    let nextRequestId=0;
    let closing=false;
    let closed=false;
    let closeTask;

    async function deliverDiagnostic(event){
        if(is.function(onEvent)){
            try{await onEvent(event);return;}
            catch(error){diagnosticFailures.push(error);reportBackgroundError(error);}
        }
        if(event.type==='local-ai.onnx.stdout'||event.type==='local-ai.onnx.stderr'){
            process.stderr.write(event.message);
        }
    }

    function captureOutput(entry,stream,type){
        const ended=new Promise(function outputEnded(resolve){
            stream.once('end',resolve);
            stream.once('close',resolve);
            stream.once('error',resolve);
        });
        stream.setEncoding('utf8');
        stream.on('data',function workerOutput(content){
            stream.pause();
            void diagnostics.enqueue({type,message:content,data:{id:entry.state.id}}).then(
                function outputDelivered(){stream.resume();},
                function outputDeliveryFailed(error){
                    diagnosticFailures.push(error);
                    reportBackgroundError(error);
                    process.stderr.write(content);
                    stream.resume();
                }
            );
        });
        stream.on('error',function workerOutputError(error){
            diagnosticFailures.push(error);
            reportBackgroundError(error);
        });
        return ended;
    }

    function current(){
        return {sessions:[...sessions.values()].map(function sessionState(entry){
            return structuredClone(entry.state);
        }),closed};
    }

    function publish(entry){
        const state=current();
        events.dispatch('onnx.state',state);
        diagnostics.enqueue({
            type:'local-ai.onnx.state',
            message:entry?`ONNX session ${entry.state.id} is ${entry.state.state}.`:'The ONNX runtime is closed.',
            data:entry?structuredClone(entry.state):state
        });
    }

    function setState(entry,state,loaded,error=null){
        entry.state={...entry.state,state,loaded,error:error?describeError(error):null};
        publish(entry);
    }

    function subscribe(listener){
        if(!is.function(listener))throw new TypeError('An ONNX state listener must be a function.');
        if(closed){
            listener(current());
            return function unsubscribeClosedRuntime(){};
        }
        const unsubscribe=events.on('onnx.state',function deliverState(event){listener(event.detail);});
        try{listener(current());}
        catch(error){unsubscribe();throw error;}
        return unsubscribe;
    }

    function assertOpen(operationSignal){
        if(operationSignal?.aborted)throw cancelled(operationSignal.reason);
        if(closing||closed)throw failure('LOCAL_AI_RUNTIME_CLOSED','The ONNX runtime is closing or closed.');
    }

    function settle(entry,operation,error,result){
        if(operation.settled)return;
        operation.settled=true;
        operation.signal?.removeEventListener('abort',operation.cancel);
        if(entry.active===operation)entry.active=null;
        if(error)operation.reject(error);
        else operation.resolve(result);
    }

    function rejectOperations(entry,error){
        if(entry.active)settle(entry,entry.active,error);
        for(const operation of entry.queue.splice(0))settle(entry,operation,error);
    }

    function observeStop(entry,reason,failed=false){
        void stopSession(entry,reason,failed).catch(reportBackgroundError);
    }

    function stopSession(entry,reason,failed=false){
        if(entry.stopTask)return entry.stopTask;
        if(entry.exited)return Promise.resolve(structuredClone(entry.state));
        const active=Boolean(entry.active);
        const worker=entry.worker;
        entry.stopping=true;
        if(failed)entry.terminalError??=reason;
        entry.stopTask=Promise.resolve().then(async function releaseSession(){
            if(active||failed||entry.terminalError){
                entry.terminationRequested=true;
                await worker.terminate();
            }else{
                try{worker.postMessage({operation:'unload',requestId:++nextRequestId});}
                catch(error){
                    entry.releaseError=error;
                    entry.terminationRequested=true;
                    await worker.terminate();
                }
            }
            await entry.exit;
            await Promise.all(entry.outputTasks);
            if(entry.releaseError)throw entry.releaseError;
            return structuredClone(entry.state);
        });
        // A native call has no AbortSignal. Stop delivery immediately, retain
        // unloading state, and join actual worker exit before reporting release.
        rejectOperations(entry,reason);
        setState(entry,entry.terminalError?'error':'unloading',entry.state.loaded,entry.terminalError);
        return entry.stopTask;
    }

    function dispatchNext(entry){
        if(closing||entry.stopping||entry.exited||entry.active)return;
        const operation=entry.queue.shift();
        if(!operation)return;
        if(operation.signal?.aborted){
            settle(entry,operation,cancelled(operation.signal.reason));
            dispatchNext(entry);
            return;
        }
        entry.active=operation;
        try{
            entry.worker.postMessage({requestId:operation.requestId,operation:operation.kind,...operation.payload});
        }catch(error){
            if(operation.kind==='load')observeStop(entry,error,true);
            else{
                settle(entry,operation,error);
                setState(entry,'error',entry.state.loaded,error);
                dispatchNext(entry);
            }
        }
    }

    function enqueue(entry,kind,payload,operationSignal,deferred=false){
        return new Promise(function queueOperation(resolve,reject){
            const operation={kind,payload,signal:operationSignal,requestId:++nextRequestId,resolve,reject,settled:false,cancel};
            function cancel(){
                if(operation.settled)return;
                const error=cancelled(operationSignal.reason);
                if(entry.active===operation||kind==='load')observeStop(entry,error);
                else{
                    const index=entry.queue.indexOf(operation);
                    if(index>=0)entry.queue.splice(index,1);
                    settle(entry,operation,error);
                }
            }
            entry.queue.push(operation);
            operationSignal?.addEventListener('abort',cancel,{once:true});
            if(operationSignal?.aborted)cancel();
            if(!deferred)dispatchNext(entry);
        });
    }

    function receiveResult(entry,message){
        if(message.operation==='unload'){
            if(message.error)entry.releaseError=restoreError(message.error);
            return;
        }
        if(closing||entry.stopping||entry.exited)return;
        const operation=entry.active;
        if(!operation||operation.requestId!==message.requestId)return;
        if(operation.signal?.aborted){operation.cancel();return;}
        if(message.error){
            const error=restoreError(message.error);
            if(operation.kind==='load')observeStop(entry,error,true);
            else{
                settle(entry,operation,error);
                setState(entry,'error',true,error);
                dispatchNext(entry);
            }
            return;
        }
        if(operation.kind==='load'){
            entry.state={...entry.state,...message.result};
            setState(entry,'ready',true);
        }else if(entry.state.state==='error')setState(entry,'ready',true);
        if(closing||entry.stopping||operation.settled)return;
        settle(entry,operation,null,operation.kind==='load'?structuredClone(entry.state):message.result);
        dispatchNext(entry);
    }

    function workerExited(entry,code){
        entry.exited=true;
        entry.worker=null;
        if(!entry.stopping||(!entry.terminationRequested&&code!==0)){
            entry.terminalError??=failure('LOCAL_AI_WORKER_EXITED',`The ONNX worker exited unexpectedly with code ${code}.`);
            rejectOperations(entry,entry.terminalError);
        }
        const error=entry.releaseError??entry.terminalError;
        try{setState(entry,error?'error':'unloaded',false,error);}
        finally{entry.resolveExit(code);}
    }

    async function load({id,model,sessionOptions,signal:operationSignal}={}){
        assertOpen(operationSignal);
        if(!is.string(id)||!is.string(model))throw new TypeError('ONNX load requires a session id and model path.');
        const previous=sessions.get(id);
        if(previous?.stopTask){
            try{await waitForRelease(previous.stopTask,operationSignal);}
            catch(error){
                // The previous operation retains its release failure. A new
                // explicit load can proceed once its worker has actually exited.
                if(operationSignal?.aborted||!previous.exited)throw error;
            }
        }
        assertOpen(operationSignal);
        if(sessions.get(id)!==previous){
            throw failure('LOCAL_AI_SESSION_EXISTS',`ONNX session ${String(id)} was loaded by another request.`);
        }
        if(previous&&!previous.exited){
            throw failure('LOCAL_AI_SESSION_EXISTS',`ONNX session ${String(id)} already exists. Unload it before loading a replacement.`);
        }
        const entry={
            state:{id,model,state:'loading',loaded:false,error:null,inputNames:[],outputNames:[],inputMetadata:[],outputMetadata:[]},
            worker:null,active:null,queue:[],stopping:false,exited:false,stopTask:null,terminalError:null,releaseError:null,terminationRequested:false,outputTasks:[]
        };
        entry.exit=new Promise(function workerExit(resolve){entry.resolveExit=resolve;});
        sessions.set(id,entry);
        try{
            entry.worker=new Worker(new URL('./onnx-worker.mjs',import.meta.url),{
                workerData:{modulePath},stdout:true,stderr:true
            });
            entry.outputTasks.push(
                captureOutput(entry,entry.worker.stdout,'local-ai.onnx.stdout'),
                captureOutput(entry,entry.worker.stderr,'local-ai.onnx.stderr')
            );
            entry.worker.on('message',function workerMessage(message){receiveResult(entry,message);});
            entry.worker.on('messageerror',function workerMessageError(error){observeStop(entry,error,true);});
            entry.worker.on('error',function workerError(error){
                entry.terminalError=error;
                entry.stopping=true;
                rejectOperations(entry,error);
                setState(entry,'error',entry.state.loaded,error);
            });
            entry.worker.once('exit',function workerExit(code){workerExited(entry,code);});
        }catch(error){
            entry.exited=true;
            setState(entry,'error',false,error);
            entry.resolveExit(null);
            throw error;
        }
        // Queue load before publishing readiness so a synchronous subscriber
        // can enqueue inference or request release without racing ownership.
        const task=enqueue(entry,'load',{model,sessionOptions},operationSignal,true);
        publish(entry);
        dispatchNext(entry);
        return task;
    }

    async function run({id,feeds,fetches,runOptions,signal:operationSignal}={}){
        assertOpen(operationSignal);
        const entry=sessions.get(id);
        if(!entry||entry.exited||entry.stopping){
            throw failure('LOCAL_AI_SESSION_UNAVAILABLE',`ONNX session ${String(id)} is not loaded or loading.`);
        }
        return enqueue(entry,'run',{feeds,fetches,runOptions},operationSignal);
    }

    async function unload({id,signal:operationSignal}={}){
        if(operationSignal?.aborted)throw cancelled(operationSignal.reason);
        const entry=sessions.get(id);
        if(!entry)throw failure('LOCAL_AI_SESSION_UNAVAILABLE',`ONNX session ${String(id)} does not exist.`);
        const result=await stopSession(entry,failure('LOCAL_AI_SESSION_UNLOADED',`ONNX session ${String(id)} is unloading.`));
        if(operationSignal?.aborted)throw cancelled(operationSignal.reason);
        return result;
    }

    function close(){
        if(closeTask)return closeTask;
        closing=true;
        signal?.removeEventListener('abort',lifetimeAborted);
        closeTask=Promise.resolve().then(async function closeRuntime(){
            const results=await Promise.allSettled([...sessions.values()].map(function releaseEntry(entry){
                return stopSession(entry,failure('LOCAL_AI_RUNTIME_CLOSED','The ONNX runtime is closing.'));
            }));
            await Promise.all([...sessions.values()].filter(function exited(entry){return entry.exited;})
                .flatMap(function outputs(entry){return entry.outputTasks;}));
            const failures=results.filter(function rejected(result){return result.status==='rejected';})
                .map(function rejection(result){return result.reason;});
            closed=[...sessions.values()].every(function exited(entry){return entry.exited;});
            if(closed)publish();
            try{await diagnostics.drain();}
            catch(error){failures.push(error);}
            failures.push(...diagnosticFailures);
            if(closed)events.dispose();
            if(failures.length)throw new AggregateError(failures,'The ONNX runtime closed with errors.');
            return current();
        });
        return closeTask;
    }

    function lifetimeAborted(){void close().catch(reportBackgroundError);}

    signal?.addEventListener('abort',lifetimeAborted,{once:true});
    if(signal?.aborted)lifetimeAborted();
    return {load,run,unload,current,subscribe,close};
}
