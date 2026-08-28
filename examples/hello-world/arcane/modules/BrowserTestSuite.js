import {createArcaneEventSource} from 'arcane-os/event-manager';

const DEFAULT_MAX_TESTS=64;
const HARD_MAX_TESTS=256;
const DEFAULT_TIMEOUT_MS=5000;
const HARD_TIMEOUT_MS=60000;
const MAX_MESSAGE_CHARACTERS=1000;
const CONTROL_CHARACTERS=/[\u0000-\u001f\u007f]/;
const TEST_ID_PATTERN=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULT_STATUSES=new Set(['fail','pass','skip']);

export const BROWSER_TEST_SUITE_EVENT_TYPES=Object.freeze({
    runCompleted:'browser-test-suite-complete',
    runStarted:'browser-test-suite-start',
    testCompleted:'browser-test-result',
    testStarted:'browser-test-start'
});

export const BROWSER_TEST_SUITE_ERROR_CODES=Object.freeze({
    assertion:'BROWSER_TEST_ASSERTION',
    busy:'BROWSER_TEST_BUSY',
    callbackRejectedLegacy:'BROWSER_TEST_ERROR',
    clockInvalid:'BROWSER_TEST_INVALID_CLOCK',
    descriptorCaseCollision:'BROWSER_TEST_CASE_COLLISION',
    descriptorInvalid:'BROWSER_TEST_INVALID_DESCRIPTOR',
    disposed:'BROWSER_TEST_SUITE_DISPOSED',
    limitExceeded:'BROWSER_TEST_LIMIT',
    limitInvalid:'BROWSER_TEST_INVALID_LIMIT',
    optionsInvalid:'BROWSER_TEST_INVALID_OPTIONS',
    resultInvalid:'BROWSER_TEST_INVALID_RESULT',
    runAborted:'BROWSER_TEST_ABORTED',
    skipped:'BROWSER_TEST_SKIP',
    timedOut:'BROWSER_TEST_TIMEOUT'
});

export const BROWSER_TEST_SUITE_REASONS=Object.freeze({
    runAborted:'browser-test-run-aborted',
    runCompleted:'browser-test-run-completed',
    runFailed:'browser-test-run-failed',
    runStarted:'browser-test-run-started',
    runWithoutPassesCompleted:'browser-test-run-without-passes-completed',
    suiteDisposed:'browser-test-suite-disposed',
    testCallbackRejected:'browser-test-callback-rejected',
    testFailed:'browser-test-failed',
    testPassed:'browser-test-passed',
    testSkipped:'browser-test-skipped',
    testStarted:'browser-test-started',
    testTimedOut:'browser-test-timed-out'
});

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function fail(message,code,ErrorType=TypeError){
    throw coded(new ErrorType(message),code);
}

function knownKeys(value,allowed,label,code='BROWSER_TEST_INVALID_OPTIONS'){
    const unknown=Object.keys(value).find(key=>!allowed.has(key));
    if(unknown) fail(`${label} contains an unsupported field: ${unknown}.`,code);
}

function boundedInteger(value,label,{minimum,maximum}){
    if(!Number.isSafeInteger(value)||value<minimum||value>maximum){
        fail(`${label} must be an integer from ${minimum} through ${maximum}.`,'BROWSER_TEST_INVALID_LIMIT',RangeError);
    }
    return value;
}

function descriptorText(value,label,maximum){
    if(typeof value!=='string') fail(`${label} must be a string.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
    const normalized=value.trim();
    if(!normalized) fail(`${label} cannot be empty.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
    if(normalized.length>maximum) fail(`${label} exceeds ${maximum} characters.`,'BROWSER_TEST_INVALID_DESCRIPTOR',RangeError);
    if(CONTROL_CHARACTERS.test(normalized)) fail(`${label} cannot contain control characters.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
    if(normalized!==normalized.normalize('NFC')) fail(`${label} must use Unicode NFC normalization.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
    return normalized;
}

function resultMessage(value,fallback){
    if(value===undefined||value===null||value==='') return fallback;
    const message=String(value)
        .replace(/[\u0000-\u001f\u007f]+/g,' ')
        .trim();
    return (message||fallback).slice(0,MAX_MESSAGE_CHARACTERS);
}

function normalizeTests(value,{maxTests,timeoutMs}){
    if(!Array.isArray(value)) fail('tests must be an array.','BROWSER_TEST_INVALID_OPTIONS');
    if(value.length>maxTests) fail(`Test suite exceeds the ${maxTests}-test limit.`,'BROWSER_TEST_LIMIT',RangeError);
    const seen=new Set();
    return Object.freeze(value.map((item,index)=>{
        if(!isPlainRecord(item)) fail(`Test descriptor ${index+1} must be a plain object.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
        knownKeys(item,new Set(['id','name','run','timeoutMs']),`Test descriptor ${index+1}`,'BROWSER_TEST_INVALID_DESCRIPTOR');
        const id=descriptorText(item.id,`Test descriptor ${index+1} id`,128);
        if(!TEST_ID_PATTERN.test(id)) fail(`Test descriptor ${index+1} has an invalid id.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
        const key=id.toLowerCase();
        if(seen.has(key)) fail(`Test descriptors contain a case-colliding id: ${id}.`,'BROWSER_TEST_CASE_COLLISION');
        seen.add(key);
        if(typeof item.run!=='function') fail(`Test descriptor ${index+1} run must be a function.`,'BROWSER_TEST_INVALID_DESCRIPTOR');
        return Object.freeze({
            id,
            name:descriptorText(item.name,`Test descriptor ${index+1} name`,256),
            run:item.run,
            timeoutMs:boundedInteger(item.timeoutMs??timeoutMs,`Test descriptor ${index+1} timeoutMs`,{minimum:10,maximum:timeoutMs}),
        });
    }));
}

function defaultNow(){
    return globalThis.performance?.now?.()??Date.now();
}

function normalizeOptions(input){
    if(!isPlainRecord(input)) fail('Browser test suite options must be a plain object.','BROWSER_TEST_INVALID_OPTIONS');
    knownKeys(input,new Set(['maxTests','now','tests','timeoutMs']),'Browser test suite options');
    const maxTests=boundedInteger(input.maxTests??DEFAULT_MAX_TESTS,'maxTests',{minimum:1,maximum:HARD_MAX_TESTS});
    const timeoutMs=boundedInteger(input.timeoutMs??DEFAULT_TIMEOUT_MS,'timeoutMs',{minimum:10,maximum:HARD_TIMEOUT_MS});
    const now=input.now??defaultNow;
    if(typeof now!=='function') fail('now must be a function.','BROWSER_TEST_INVALID_OPTIONS');
    return Object.freeze({
        maxTests,
        now,
        tests:normalizeTests(input.tests??[],{maxTests,timeoutMs}),
        timeoutMs,
    });
}

function normalizeRunOptions(input){
    if(!isPlainRecord(input)) fail('Test run options must be a plain object.','BROWSER_TEST_INVALID_OPTIONS');
    knownKeys(input,new Set(['context','signal']),'Test run options');
    const signal=input.signal??null;
    if(signal!==null&&(
        typeof signal!=='object'
        ||typeof signal.aborted!=='boolean'
        ||typeof signal.addEventListener!=='function'
        ||typeof signal.removeEventListener!=='function'
    )) fail('signal must be an AbortSignal.','BROWSER_TEST_INVALID_OPTIONS');
    return Object.freeze({context:input.context,signal});
}

function elapsed(now,start){
    const end=Number(now());
    if(!Number.isFinite(end)) fail('now() must return a finite number.','BROWSER_TEST_INVALID_CLOCK');
    return Math.round(Math.max(0,end-start)*1000)/1000;
}

function startTime(now){
    const value=Number(now());
    if(!Number.isFinite(value)) fail('now() must return a finite number.','BROWSER_TEST_INVALID_CLOCK');
    return value;
}

function skipError(message){
    const error=coded(new Error(resultMessage(message,'Skipped by the check.')),'BROWSER_TEST_SKIP');
    error.name='BrowserTestSkip';
    return error;
}

function assertionError(message){
    const error=coded(new Error(resultMessage(message,'The browser check failed.')),'BROWSER_TEST_ASSERTION');
    error.name='BrowserTestAssertionError';
    return error;
}

function abortError(cause){
    const error=coded(
        new Error('The browser test run was aborted.'),
        BROWSER_TEST_SUITE_ERROR_CODES.runAborted
    );
    error.name='AbortError';
    error.reason=BROWSER_TEST_SUITE_REASONS.runAborted;
    if(cause!==undefined)error.cause=cause;
    return error;
}

function timeoutError(milliseconds){
    const error=coded(new Error(`The check exceeded ${milliseconds} milliseconds.`),'BROWSER_TEST_TIMEOUT');
    error.name='BrowserTestTimeoutError';
    error.reason=BROWSER_TEST_SUITE_REASONS.testTimedOut;
    return error;
}

function runWithTimeout(callback,{signal,timeoutMs}){
    if(signal?.aborted) return Promise.reject(abortError(signal.reason));
    const controller=new AbortController();
    return new Promise((resolve,reject)=>{
        let settled=false;
        const finish=(handler,value)=>{
            if(settled) return;
            settled=true;
            clearTimeout(timer);
            signal?.removeEventListener('abort',onAbort);
            handler(value);
        };
        const onAbort=()=>{
            controller.abort(signal.reason);
            finish(reject,abortError(signal.reason));
        };
        const timer=setTimeout(()=>{
            controller.abort();
            finish(reject,timeoutError(timeoutMs));
        },timeoutMs);
        signal?.addEventListener('abort',onAbort,{once:true});
        Promise.resolve()
            .then(()=>callback(controller.signal))
            .then(value=>finish(resolve,value),error=>finish(reject,error));
    });
}

function normalizedOutcome(value){
    if(value===undefined||value===true){
        return Object.freeze({status:'pass',message:'Passed.'});
    }
    if(value===false){
        return Object.freeze({status:'fail',message:'The check returned false.',code:'BROWSER_TEST_ASSERTION'});
    }
    if(!isPlainRecord(value)){
        return Object.freeze({status:'fail',message:'The check returned an invalid result.',code:'BROWSER_TEST_INVALID_RESULT'});
    }
    const unknown=Object.keys(value).find(key=>!new Set(['message','status']).has(key));
    if(unknown||!RESULT_STATUSES.has(value.status)){
        return Object.freeze({status:'fail',message:'The check returned an invalid result.',code:'BROWSER_TEST_INVALID_RESULT'});
    }
    const fallback=value.status==='pass'?'Passed.':value.status==='skip'?'Skipped.':'Failed.';
    return Object.freeze({status:value.status,message:resultMessage(value.message,fallback)});
}

function outcomeFromError(error){
    if(error?.code==='BROWSER_TEST_SKIP'){
        return Object.freeze({status:'skip',message:resultMessage(error.message,'Skipped.'),code:error.code});
    }
    if(error?.code===BROWSER_TEST_SUITE_ERROR_CODES.runAborted){
        return Object.freeze({status:'skip',message:resultMessage(error.message,'The run was aborted.'),code:error.code});
    }
    return Object.freeze({
        status:'fail',
        message:resultMessage(error?.message,'The check failed.'),
        code:typeof error?.code==='string'?error.code.slice(0,64):'BROWSER_TEST_ERROR',
        errorName:resultMessage(error?.name,'Error').slice(0,128),
    });
}

function resultRecord(test,outcome,durationMs){
    return Object.freeze({
        id:test.id,
        name:test.name,
        status:outcome.status,
        message:outcome.message,
        ...(outcome.code?{code:outcome.code}:{}),
        ...(outcome.errorName?{errorName:outcome.errorName}:{}),
        durationMs,
    });
}

function skippedResult(test,message,code='BROWSER_TEST_ABORTED'){
    return resultRecord(test,{status:'skip',message,code},0);
}

function browserTestResultReason(result){
    if(result.code===BROWSER_TEST_SUITE_ERROR_CODES.runAborted){
        return BROWSER_TEST_SUITE_REASONS.runAborted;
    }
    if(result.code===BROWSER_TEST_SUITE_ERROR_CODES.timedOut){
        return BROWSER_TEST_SUITE_REASONS.testTimedOut;
    }
    if(result.code===BROWSER_TEST_SUITE_ERROR_CODES.callbackRejectedLegacy){
        return BROWSER_TEST_SUITE_REASONS.testCallbackRejected;
    }
    if(result.status==='pass')return BROWSER_TEST_SUITE_REASONS.testPassed;
    if(result.status==='skip')return BROWSER_TEST_SUITE_REASONS.testSkipped;
    return BROWSER_TEST_SUITE_REASONS.testFailed;
}

function browserTestPublicDetail(type,detail){
    const result=detail?.result;
    const test=detail?.test;
    const testCount=Number.isSafeInteger(detail?.total)
        ?detail.total
        :Number.isSafeInteger(detail?.totals?.total)
            ?detail.totals.total
            :null;
    if(type===BROWSER_TEST_SUITE_EVENT_TYPES.runStarted){
        return Object.freeze({
            reason:BROWSER_TEST_SUITE_REASONS.runStarted,
            testCount
        });
    }
    if(type===BROWSER_TEST_SUITE_EVENT_TYPES.testStarted){
        return Object.freeze({
            reason:BROWSER_TEST_SUITE_REASONS.testStarted,
            testId:test.id,
            testIndex:detail.index,
            testCount
        });
    }
    if(type===BROWSER_TEST_SUITE_EVENT_TYPES.testCompleted){
        return Object.freeze({
            reason:browserTestResultReason(result),
            testId:result.id,
            testIndex:detail.index,
            testCount,
            status:result.status,
            ...(typeof result.code==='string'?{code:result.code}:{})
        });
    }
    const reason=detail.status==='aborted'
        ?BROWSER_TEST_SUITE_REASONS.runAborted
        :detail.status==='fail'
            ?BROWSER_TEST_SUITE_REASONS.runFailed
            :detail.status==='skip'
                ?BROWSER_TEST_SUITE_REASONS.runWithoutPassesCompleted
                :BROWSER_TEST_SUITE_REASONS.runCompleted;
    return Object.freeze({
        reason,
        status:detail.status,
        testCount,
        passedTestCount:detail.totals.pass,
        failedTestCount:detail.totals.fail,
        skippedTestCount:detail.totals.skip
    });
}

function disposedError(){
    const error=coded(
        new Error('The browser test suite has been disposed.'),
        BROWSER_TEST_SUITE_ERROR_CODES.disposed
    );
    error.reason=BROWSER_TEST_SUITE_REASONS.suiteDisposed;
    return error;
}

/**
 * Runs a fixed inventory of parent-supplied browser checks sequentially.
 *
 * Test callbacks are trusted executable code supplied by the parent. This
 * module never accepts source text, evaluates code, persists results, or
 * selects application policy. Per-test abort signals and timeout races bound
 * cooperative asynchronous orchestration; callbacks must still avoid blocking
 * the page and stop work they started after their abort signal fires.
 */
export default class BrowserTestSuite extends EventTarget{
    #activeRun=null;
    #disposed=false;
    #events;
    #now;
    #operationSequence=0;
    #running=false;
    #tests;

    constructor(options={}){
        super();
        const normalized=normalizeOptions(options);
        this.#now=normalized.now;
        this.#tests=normalized.tests;
        this.#events=createArcaneEventSource(this,{
            source:'browser-test-suite',
            eventTypes:Object.freeze(Object.values(BROWSER_TEST_SUITE_EVENT_TYPES))
        });
    }

    addEventListener(type,listener,options){return this.#events.addEventListener(type,listener,options);}
    removeEventListener(type,listener,options){return this.#events.removeEventListener(type,listener,options);}
    on(type,listener,options){return this.#events.on(type,listener,options);}
    dispatchEvent(value){return this.#events.dispatchEvent(value);}

    get running(){return this.#running;}

    list(){
        return Object.freeze(this.#tests.map(test=>Object.freeze({
            id:test.id,
            name:test.name,
            timeoutMs:test.timeoutMs,
        })));
    }

    #emit(type,detail,operationId){
        if(this.#disposed)return false;
        const compatibilityDetail=Object.freeze(detail);
        return this.#events.dispatch(type,compatibilityDetail,{
            operationId,
            publicDetail:browserTestPublicDetail(type,compatibilityDetail)
        });
    }

    async run(options={}){
        if(this.#disposed)throw disposedError();
        if(this.#running) fail('A browser test run is already active.','BROWSER_TEST_BUSY',Error);
        const settings=normalizeRunOptions(options);
        const suiteStart=startTime(this.#now);
        const controller=new AbortController();
        const operationId=`${this.#events.instanceId}:run:${(++this.#operationSequence).toString(36)}`;
        let removeAbortListener=null;
        function abortBrowserTestRun(){
            if(!controller.signal.aborted)controller.abort(settings.signal?.reason);
        }
        if(settings.signal){
            settings.signal.addEventListener('abort',abortBrowserTestRun,{once:true});
            removeAbortListener=function removeBrowserTestRunAbortListener(){
                settings.signal.removeEventListener('abort',abortBrowserTestRun);
            };
            if(settings.signal.aborted)abortBrowserTestRun();
        }
        const runRecord=Object.freeze({controller,operationId});
        this.#activeRun=runRecord;
        const results=[];
        let aborted=controller.signal.aborted;
        this.#running=true;
        try{
            this.#emit(
                BROWSER_TEST_SUITE_EVENT_TYPES.runStarted,
                {tests:this.list(),total:this.#tests.length},
                operationId
            );
            for(let index=0;index<this.#tests.length;index++){
                const descriptor=this.#tests[index];
                const testOperationId=`${operationId}:test:${(index+1).toString(36)}`;
                if(aborted||controller.signal.aborted){
                    aborted=true;
                    const result=skippedResult(descriptor,'Skipped because the browser test run was aborted.');
                    results.push(result);
                    this.#emit(
                        BROWSER_TEST_SUITE_EVENT_TYPES.testCompleted,
                        {index,result,total:this.#tests.length},
                        testOperationId
                    );
                    continue;
                }
                this.#emit(
                    BROWSER_TEST_SUITE_EVENT_TYPES.testStarted,
                    {
                        index,
                        test:Object.freeze({id:descriptor.id,name:descriptor.name,timeoutMs:descriptor.timeoutMs}),
                        total:this.#tests.length,
                    },
                    testOperationId
                );
                const testStart=startTime(this.#now);
                let outcome;
                try{
                    const value=await runWithTimeout(signal=>descriptor.run(Object.freeze({
                        assert(condition,message){if(!condition) throw assertionError(message);},
                        context:settings.context,
                        signal,
                        skip(message){throw skipError(message);},
                    })),{signal:controller.signal,timeoutMs:descriptor.timeoutMs});
                    outcome=normalizedOutcome(value);
                }catch(error){
                    outcome=outcomeFromError(error);
                    if(error?.code===BROWSER_TEST_SUITE_ERROR_CODES.runAborted) aborted=true;
                }
                const result=resultRecord(descriptor,outcome,elapsed(this.#now,testStart));
                results.push(result);
                this.#emit(
                    BROWSER_TEST_SUITE_EVENT_TYPES.testCompleted,
                    {index,result,total:this.#tests.length},
                    testOperationId
                );
            }
        }finally{
            this.#running=false;
            removeAbortListener?.();
            if(this.#activeRun===runRecord)this.#activeRun=null;
        }
        const totals=Object.freeze({
            total:results.length,
            pass:results.filter(result=>result.status==='pass').length,
            fail:results.filter(result=>result.status==='fail').length,
            skip:results.filter(result=>result.status==='skip').length,
        });
        const status=aborted?'aborted':totals.fail?'fail':totals.pass?'pass':'skip';
        const summary=Object.freeze({
            status,
            totals,
            durationMs:elapsed(this.#now,suiteStart),
            results:Object.freeze(results),
        });
        this.#emit(BROWSER_TEST_SUITE_EVENT_TYPES.runCompleted,summary,operationId);
        return summary;
    }

    dispose(){
        if(this.#disposed)return false;
        this.#disposed=true;
        if(this.#activeRun&&!this.#activeRun.controller.signal.aborted){
            this.#activeRun.controller.abort(disposedError());
        }
        this.#events.dispose();
        return true;
    }
    destroy(){return this.dispose();}
}

export {assertionError,skipError};
