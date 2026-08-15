import VanillaTest from 'vanilla-test';

export const DEFAULT_TEST_TIMEOUT_MS=30_000;

const MAX_TEST_TIMEOUT_MS=3_600_000;
const CLEANUP_TIMEOUT_MS=5_000;
const REPORT_TIMEOUT_MS=5_000;
const registrations=[];
let lifecycle='collecting';
let phaseSequence=0;

class TestTimeoutError extends Error{
    constructor(name,timeoutMs,{cleanup=false}={}){
        super(`${cleanup?'Cleanup for':'Test'} "${name}" exceeded ${String(timeoutMs)} ms.`);
        this.name='TestTimeoutError';
        this.code='ARCANE_TEST_TIMEOUT';
    }
}

class TestCancellationError extends Error{
    constructor(reason){
        super('The test run was cancelled.',{cause:reason});
        this.name='AbortError';
        this.code='ARCANE_TEST_CANCELLED';
    }
}

function assertName(name){
    if(typeof name!=='string'||name.trim()===''){
        throw new TypeError('A test name must be a nonempty string.');
    }
}

function testTimeout(options){
    const timeout=options.timeout??DEFAULT_TEST_TIMEOUT_MS;
    if(!Number.isSafeInteger(timeout)||timeout<1||timeout>MAX_TEST_TIMEOUT_MS){
        throw new TypeError(
            `Test timeout must be an integer from 1 through ${String(MAX_TEST_TIMEOUT_MS)} milliseconds.`
        );
    }
    return timeout;
}

function definition(name,optionsOrCallback,maybeCallback){
    assertName(name);
    const hasOptions=typeof optionsOrCallback!=='function';
    const options=hasOptions?optionsOrCallback:{};
    const callback=hasOptions?maybeCallback:optionsOrCallback;
    if(options===null||typeof options!=='object'||Array.isArray(options)){
        throw new TypeError('Test options must be an object.');
    }
    if(typeof callback!=='function'){
        throw new TypeError(`Test "${name}" requires a callback function.`);
    }
    return Object.freeze({name,timeoutMs:testTimeout(options),callback});
}

export function test(name,optionsOrCallback,maybeCallback){
    if(lifecycle!=='collecting'){
        throw new ReferenceError('Tests must be registered before the test run starts.');
    }
    registrations.push(definition(name,optionsOrCallback,maybeCallback));
}

export default test;

export function registeredTestCount(){
    return registrations.length;
}

function cancellationError(signal){
    return new TestCancellationError(signal?.reason);
}

function waitFor(promise,{timeoutMs,signal,timeoutError,onTimeout}={}){
    if(signal?.aborted){
        return Promise.reject(cancellationError(signal));
    }
    return new Promise((resolve,reject)=>{
        let settled=false;
        let timer=null;
        const finish=(callback,value)=>{
            if(settled)return;
            settled=true;
            clearTimeout(timer);
            signal?.removeEventListener('abort',abort);
            callback(value);
        };
        const abort=()=>finish(reject,cancellationError(signal));
        signal?.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>{
            const error=timeoutError();
            finish(reject,error);
            onTimeout?.(error);
        },timeoutMs);
        Promise.resolve(promise).then(
            value=>finish(resolve,value),
            error=>finish(reject,error)
        );
    });
}

function linkedController(parentSignal){
    const controller=new AbortController();
    const abort=()=>controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener('abort',abort,{once:true});
    if(parentSignal?.aborted)abort();
    return {
        controller,
        dispose:()=>parentSignal?.removeEventListener('abort',abort)
    };
}

function runState(parentSignal){
    const controller=new AbortController();
    let cancelled=false;
    let fatalError=null;
    const cancel=()=>{
        cancelled=true;
        if(!controller.signal.aborted){
            controller.abort(parentSignal?.reason);
        }
    };
    parentSignal?.addEventListener('abort',cancel,{once:true});
    if(parentSignal?.aborted)cancel();
    return {
        signal:controller.signal,
        get cancelled(){
            return cancelled;
        },
        get fatalError(){
            return fatalError;
        },
        markFatal(error){
            fatalError??=error;
            if(!controller.signal.aborted){
                controller.abort(fatalError);
            }
        },
        dispose:()=>parentSignal?.removeEventListener('abort',cancel)
    };
}

function displayName(path){
    return path.join(' > ');
}

function errorText(error){
    if(error instanceof Error){
        return error.stack??`${error.name}: ${error.message}`;
    }
    return String(error);
}

async function ownedPhase(onPhase,{kind,name,timeoutMs,cleanup=false},work){
    const id=`${kind}-${String(++phaseSequence)}`;
    await onPhase?.({id,kind,name,status:'started',timeoutMs});
    const started=performance.now();
    let value;
    let workError=null;
    try{
        value=await work();
    }catch(error){
        workError=error;
    }
    const elapsedMs=performance.now()-started;
    let phaseError=null;
    try{
        await onPhase?.({id,kind,name,status:'completed',timeoutMs,elapsedMs});
    }catch(error){
        phaseError=error;
    }
    if(elapsedMs>timeoutMs){
        const timeoutError=new TestTimeoutError(name,timeoutMs,{cleanup});
        if(workError!==null)timeoutError.cause=workError;
        throw timeoutError;
    }
    if(workError!==null)throw workError;
    if(phaseError!==null)throw phaseError;
    return value;
}

async function runCleanup(cleanup,context,name,signal,onPhase,index){
    return waitFor(
        ownedPhase(
            onPhase,
            {
                kind:'cleanup',
                name:`${name} cleanup ${String(index+1)}`,
                timeoutMs:CLEANUP_TIMEOUT_MS,
                cleanup:true
            },
            ()=>cleanup(context)
        ),
        {
            timeoutMs:CLEANUP_TIMEOUT_MS,
            signal,
            timeoutError:()=>new TestTimeoutError(name,CLEANUP_TIMEOUT_MS,{cleanup:true})
        }
    );
}

async function executeDefinition(current,path,outcomes,{parentSignal,state,onPhase}){
    if(state.cancelled)throw cancellationError(state.signal);
    if(state.fatalError)throw state.fatalError;
    if(parentSignal?.aborted)throw cancellationError(parentSignal);

    const outcome={name:displayName(path),ok:false,errors:[]};
    outcomes.push(outcome);

    const {controller,dispose}=linkedController(parentSignal);
    const cleanups=[];
    let accepting=true;
    let childChain=Promise.resolve();
    let childFailure=false;
    let childFatal=null;

    const context={
        get signal(){
            return controller.signal;
        },
        after(callback){
            if(!accepting){
                throw new ReferenceError(`Test "${outcome.name}" is no longer accepting cleanup hooks.`);
            }
            if(state.cancelled||state.fatalError||controller.signal.aborted){
                throw state.fatalError??cancellationError(controller.signal);
            }
            if(typeof callback!=='function'){
                throw new TypeError('t.after() requires a callback function.');
            }
            cleanups.push(callback);
        },
        test(name,optionsOrCallback,maybeCallback){
            if(!accepting){
                return Promise.reject(
                    new ReferenceError(`Test "${outcome.name}" is no longer accepting nested tests.`)
                );
            }
            if(state.cancelled||state.fatalError||controller.signal.aborted){
                return Promise.reject(state.fatalError??cancellationError(controller.signal));
            }
            const child=definition(name,optionsOrCallback,maybeCallback);
            const execution=childChain.then(()=>{
                if(state.cancelled)throw cancellationError(state.signal);
                if(state.fatalError)throw state.fatalError;
                if(controller.signal.aborted)throw cancellationError(controller.signal);
                if(childFatal)throw childFatal;
                return executeDefinition(
                    child,
                    [...path,child.name],
                    outcomes,
                    {parentSignal:controller.signal,state,onPhase}
                );
            });
            const result=execution.then(childOutcome=>{
                if(!childOutcome.ok)childFailure=true;
                return undefined;
            });
            childChain=result.catch(error=>{
                childFatal??=error;
            });
            return result;
        }
    };

    let bodyError=null;
    try{
        const body=ownedPhase(
            onPhase,
            {kind:'test',name:outcome.name,timeoutMs:current.timeoutMs},
            async()=>{
                if(state.cancelled)throw cancellationError(state.signal);
                if(state.fatalError)throw state.fatalError;
                if(controller.signal.aborted)throw cancellationError(controller.signal);
                let callbackError=null;
                try{
                    await current.callback(context);
                }catch(error){
                    callbackError=error;
                }finally{
                    // Once the callback settles it can no longer add work to the
                    // parent's owned child queue, even while existing children drain.
                    accepting=false;
                }
                await childChain;
                if(callbackError)throw callbackError;
                if(childFatal)throw childFatal;
            }
        );
        await waitFor(body,{
            timeoutMs:current.timeoutMs,
            signal:controller.signal,
            timeoutError:()=>new TestTimeoutError(outcome.name,current.timeoutMs),
            onTimeout:error=>{
                controller.abort(error);
                state.markFatal(error);
            }
        });
    }catch(error){
        bodyError=error;
        if(error?.code==='ARCANE_TEST_TIMEOUT')state.markFatal(error);
    }finally{
        accepting=false;
    }

    // The body wait can stop on a parent or child timeout before the body promise
    // settles. Drain only the framework-owned child chain (whose callbacks all
    // share the aborted signal) so every already-created outcome is final before
    // the report snapshot is rendered. Never await the potentially live body.
    await childChain;

    const cleanupErrors=[];
    // A timed-out or cancelled callback can still be executing JavaScript because
    // promises are not preemptible. Cleanup is therefore safe only after an
    // ordinarily settled body. The isolated file process is terminated after
    // reporting a fatal timeout, so skipped hooks and late work cannot overlap a
    // later test.
    if(!state.fatalError&&!state.cancelled){
        for(let index=0;index<cleanups.length;index+=1){
            if(state.cancelled)break;
            try{
                await runCleanup(
                    cleanups[index],
                    context,
                    outcome.name,
                    state.signal,
                    onPhase,
                    index
                );
            }catch(error){
                cleanupErrors.push(error);
                if(state.cancelled)break;
                if(error?.code==='ARCANE_TEST_TIMEOUT'){
                    state.markFatal(error);
                    break;
                }
            }
        }
    }
    dispose();

    if(state.cancelled){
        throw cancellationError(state.signal);
    }
    if(bodyError)outcome.errors.push(bodyError);
    if(childFailure){
        outcome.errors.push(new Error(`One or more nested tests failed in "${outcome.name}".`));
    }
    outcome.errors.push(...cleanupErrors);
    outcome.ok=outcome.errors.length===0;
    return outcome;
}

function uniqueDescriptions(outcomes){
    const occurrences=new Map();
    return outcomes.map(outcome=>{
        const count=(occurrences.get(outcome.name)??0)+1;
        occurrences.set(outcome.name,count);
        return count===1?outcome.name:`${outcome.name} [${String(count)}]`;
    });
}

export async function runRegisteredTests({signal,requireTests=true,onPhase}={}){
    if(lifecycle!=='collecting'){
        throw new ReferenceError('The registered test suite can run only once.');
    }
    if(onPhase!==undefined&&typeof onPhase!=='function'){
        throw new TypeError('onPhase must be a function when provided.');
    }
    lifecycle='running';
    const outcomes=[];
    const state=runState(signal);
    try{
        if(state.cancelled)throw cancellationError(state.signal);
        if(requireTests&&registrations.length===0){
            outcomes.push({
                name:'test module registers at least one test',
                ok:false,
                errors:[new Error('The test module did not register any tests.')]
            });
        }else{
            for(const current of registrations){
                if(state.cancelled)throw cancellationError(state.signal);
                if(state.fatalError)break;
                await executeDefinition(
                    current,
                    [current.name],
                    outcomes,
                    {parentSignal:state.signal,state,onPhase}
                );
            }
        }

        const result=await ownedPhase(
            onPhase,
            {kind:'report',name:'Vanilla Test report',timeoutMs:REPORT_TIMEOUT_MS},
            ()=>{
                const descriptions=uniqueDescriptions(outcomes);
                const runner=new VanillaTest();
                for(let index=0;index<outcomes.length;index+=1){
                    const outcome=outcomes[index];
                    if(!outcome.ok){
                        for(const error of outcome.errors){
                            console.error(`\n[${outcome.name}]\n${errorText(error)}`);
                        }
                    }
                    runner.expects(descriptions[index]);
                    if(outcome.ok){
                        runner.pass();
                    }else{
                        runner.fail();
                    }
                    runner.done();
                }
                return runner.report();
            }
        );
        lifecycle='reported';
        return result;
    }catch(error){
        lifecycle='failed';
        throw error;
    }finally{
        state.dispose();
    }
}
