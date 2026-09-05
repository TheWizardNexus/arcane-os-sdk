import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {arcaneLogging,readArcaneDeveloperMode} from 'arcane-os/logging';
import Errors from '../runtime/arcane/modules/Errors.js';
import {createSpeechWorkerClient} from '../browser-runtime/ai/speech-worker-client.mjs';
import {SPEECH_WORKER_PROTOCOL} from '../browser-runtime/ai/speech-worker-runtime.mjs';

function captureLoggingEnvironment(t,user){
    const originalProperties=new Map();
    for(const name of ['console','user','Worker']){
        originalProperties.set(name,Object.getOwnPropertyDescriptor(globalThis,name));
    }
    t.after(function restoreLoggingEnvironment(){
        for(const [name,descriptor] of originalProperties){
            if(descriptor){
                Object.defineProperty(globalThis,name,descriptor);
            }else{
                delete globalThis[name];
            }
        }
    });
    const calls=[];
    globalThis.console={
        info(...args){calls.push({method:'info',args});},
        warn(...args){calls.push({method:'warn',args});},
        error(...args){calls.push({method:'error',args});},
        trace(...args){calls.push({method:'trace',args});}
    };
    globalThis.user=user;
    return calls;
}

function speechWorkerTrace(calls,phase){
    return calls.find(function findSpeechWorkerPhase(call){
        return call.args[0]==='[Arcane speech worker]'&&call.args[1]?.phase===phase;
    })?.args[1];
}

test('developer diagnostics stay silent until the shared user is ready and enabled',function developerModeReadiness(t){
    const calls=captureLoggingEnvironment(t,undefined);
    for(const user of [undefined,{ready:false,developer:true},{ready:true,developer:false},{ready:true,developer:'true'}]){
        globalThis.user=user;
        assert.equal(arcaneLogging.enabled,false);
        arcaneLogging.log('complete log');
        arcaneLogging.info('complete info');
        arcaneLogging.debug('complete debug');
    }
    assert.deepEqual(calls,[]);
    assert.equal(readArcaneDeveloperMode({}),null);
    assert.equal(readArcaneDeveloperMode({user:{ready:false,developer:true}}),null);
    assert.equal(readArcaneDeveloperMode({user:{ready:true,developer:false}}),false);
});

test('one existing developer preference changes every diagnostic method immediately',function developerModeLiveToggle(t){
    const user={ready:true,developer:false};
    const calls=captureLoggingEnvironment(t,user);
    assert.equal(arcaneLogging,globalThis.arcaneLogging);
    assert.equal(arcaneLogging,globalThis[Symbol.for('arcane.logging')]);
    user.developer=true;
    assert.equal(arcaneLogging.enabled,true);
    arcaneLogging.log('log enabled');
    arcaneLogging.info('info enabled');
    arcaneLogging.debug('debug enabled');
    user.developer=false;
    assert.equal(arcaneLogging.enabled,false);
    arcaneLogging.log('log disabled');
    arcaneLogging.info('info disabled');
    arcaneLogging.debug('debug disabled');
    globalThis.user={ready:true,developer:true};
    arcaneLogging.debug('replacement user enabled');
    globalThis.user.ready=false;
    arcaneLogging.info('replacement user waiting');
    assert.deepEqual(calls,[
        {method:'info',args:['log enabled']},
        {method:'info',args:['info enabled']},
        {method:'info',args:['debug enabled']},
        {method:'info',args:['replacement user enabled']}
    ]);
});

test('diagnostic arguments retain complete text and original nested and cyclic values',function completeDiagnosticArguments(t){
    const calls=captureLoggingEnvironment(t,{ready:true,developer:true});
    const text='  Original speech text, punctuation!\nSecond line: café, 日本語.  \n'.repeat(2000);
    const nested={text,output:{paragraphs:[text,'  final line\n']}};
    nested.self=nested;
    const samples=new Float32Array([0,-0.5,0.25,1]);
    const failure=new Error('Complete original error',{cause:nested});
    failure.code='SYNTHETIC_DIAGNOSTIC_ERROR';
    const marker=Symbol('original marker');
    const callable=function originalDiagnosticCallable(){return nested;};
    const args=[text,nested,samples,failure,marker,callable,7n,undefined,null];
    arcaneLogging.debug(...args);
    assert.equal(calls.length,1);
    assert.equal(calls[0].method,'info');
    assert.equal(calls[0].args.length,args.length);
    for(const [index,value] of args.entries()){
        assert.equal(calls[0].args[index],value);
    }
    assert.equal(calls[0].args[1].self,nested);
    assert.equal(calls[0].args[3].code,'SYNTHETIC_DIAGNOSTIC_ERROR');
    assert.deepEqual(Array.from(samples),[0,-0.5,0.25,1]);
});

test('warnings errors and failure traces remain visible before user readiness and when developer mode is off',function failureDiagnosticsRemainVisible(t){
    const calls=captureLoggingEnvironment(t,undefined);
    const failure=new Error('Original failure');
    const detail={full:'  complete diagnostic\n'};
    arcaneLogging.warn('warning',detail);
    arcaneLogging.error('error',failure);
    globalThis.user={ready:true,developer:false};
    arcaneLogging.warn('disabled warning',detail);
    arcaneLogging.error('disabled error',failure);
    arcaneLogging.trace('failure trace',failure);
    assert.deepEqual(calls,[
        {method:'warn',args:['warning',detail]},
        {method:'error',args:['error',failure]},
        {method:'warn',args:['disabled warning',detail]},
        {method:'error',args:['disabled error',failure]},
        {method:'trace',args:['failure trace',failure]}
    ]);
});

test('unavailable or throwing consoles and preference getters cannot change the observed operation',function diagnosticFailureIsObservational(t){
    captureLoggingEnvironment(t,{ready:true,developer:true});
    const consoleFailure=new Error('Synthetic console failure');
    function throwConsoleFailure(){throw consoleFailure;}
    for(const consoleTarget of [undefined,{},
        {info:throwConsoleFailure,warn:throwConsoleFailure,error:throwConsoleFailure,trace:throwConsoleFailure},
        {get info(){throw consoleFailure;}}
    ]){
        globalThis.console=consoleTarget;
        for(const method of ['log','info','debug','warn','error','trace']){
            assert.doesNotThrow(function emitWithUnavailableConsole(){
                arcaneLogging[method]('complete value',{operation:'continues'});
            });
        }
    }
    globalThis.user={get ready(){throw new Error('Synthetic user readiness failure');}};
    assert.equal(arcaneLogging.enabled,false);
    assert.equal(readArcaneDeveloperMode(),false);
    globalThis.user={ready:true,get developer(){throw new Error('Synthetic preference failure');}};
    assert.equal(arcaneLogging.enabled,false);
    assert.equal(readArcaneDeveloperMode(),false);
});

test('Errors and console diagnostics use the same live developer preference reader',function errorsSharesDeveloperPreference(t){
    captureLoggingEnvironment(t,undefined);
    const target=new EventTarget();
    const storage={
        getItem(){return null;},
        setItem(){}
    };
    const errors=new Errors({target,storage,singleton:false});
    try{
        assert.equal(errors.logger,arcaneLogging);
        assert.equal(errors.isDeveloperMode(),readArcaneDeveloperMode(target));
        assert.equal(errors.isDeveloperMode(),null);
        target.user={ready:false,developer:true};
        assert.equal(errors.isDeveloperMode(),null);
        target.user.ready=true;
        globalThis.user=target.user;
        assert.equal(errors.isDeveloperMode(),true);
        assert.equal(arcaneLogging.enabled,true);
        target.user.developer=false;
        assert.equal(errors.isDeveloperMode(),false);
        assert.equal(arcaneLogging.enabled,false);
    }finally{
        errors.destroy();
    }
});

test('speech Worker diagnostics preserve transferred request content without changing the actual request or result',async function speechWorkerTransferDiagnostics(t){
    const calls=captureLoggingEnvironment(t,{ready:true,developer:true});
    let worker;
    globalThis.Worker=class DiagnosticSpeechWorker extends EventTarget{
        constructor(url,options){
            super();
            this.url=url;
            this.options=options;
            this.requests=[];
            this.terminated=false;
            worker=this;
        }
        postMessage(message,transfer=[]){
            this.requests.push({original:message,received:structuredClone(message,{transfer})});
        }
        terminate(){this.terminated=true;}
    };
    const client=createSpeechWorkerClient({role:'stt'});
    try{
        const audio=new Float32Array([0.125,-0.25,0.5,-1]);
        const originalBuffer=audio.buffer;
        const payload={input:{audio,text:'  original\ninput  ',voice:'user-selected-voice'},options:{speed:1.25}};
        const expected=structuredClone(payload);
        const operation=client.request('use',payload);
        const sent=worker.requests[0];
        assert.equal(sent.original.payload,payload);
        assert.deepEqual(sent.received.payload,expected);
        assert.throws(function readTransferredOriginalBuffer(){return new Float32Array(originalBuffer);},TypeError);
        const dispatch=speechWorkerTrace(calls,'request.dispatch');
        assert.deepEqual(dispatch.message,sent.received);
        assert.notEqual(dispatch.message.payload,payload);
        assert.deepEqual(Array.from(dispatch.message.payload.input.audio),[0.125,-0.25,0.5,-1]);
        const result={text:'  complete result\n',segments:[{text:'  complete result\n',start:0,end:2}]};
        const message={protocol:SPEECH_WORKER_PROTOCOL,id:sent.received.id,ok:true,result};
        worker.dispatchEvent(new MessageEvent('message',{data:message}));
        assert.equal(await operation,result);
        assert.equal(speechWorkerTrace(calls,'response').message,message);
        assert.equal(speechWorkerTrace(calls,'response').message.result,result);
    }finally{
        await client.terminate();
    }
    assert.equal(worker.terminated,true);
});

test('speech Worker transport error diagnostics retain the original Error and custom fields',async function speechWorkerErrorDiagnostics(t){
    const calls=captureLoggingEnvironment(t,{ready:true,developer:true});
    const failure=new Error('Complete synthetic transport error',{cause:{detail:'  original cause\n'}});
    failure.code='SYNTHETIC_TRANSPORT_FAILURE';
    failure.detail={complete:'  retained detail\n'};
    globalThis.Worker=class RejectingDiagnosticSpeechWorker extends EventTarget{
        postMessage(){throw failure;}
        terminate(){}
    };
    const client=createSpeechWorkerClient({role:'tts'});
    try{
        await assert.rejects(client.request('use',{input:{text:'  original speech\n',voice:'user-selected-voice'}}),function originalTransportError(error){
            assert.equal(error.cause,failure);
            return error.code==='ARCANE_AI_WORKER_MESSAGE_ERROR';
        });
        const diagnostic=speechWorkerTrace(calls,'request.error');
        assert.equal(diagnostic.error,failure);
        assert.equal(diagnostic.error.code,'SYNTHETIC_TRANSPORT_FAILURE');
        assert.equal(diagnostic.error.detail,failure.detail);
        assert.equal(diagnostic.error.cause,failure.cause);
    }finally{
        await client.terminate();
    }
});
