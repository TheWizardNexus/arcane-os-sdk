import assert from 'node:assert/strict';
import {createContext,runInContext} from 'node:vm';
import test from '../src/testing.mjs';
import {createCoreClassicSource} from '../src/core-classic-source.mjs';
import {arcaneEvents} from '../browser-runtime/event-manager.mjs';
import {createCoreClient,createCoreFacade,getInstalledCoreClient,installCoreClient} from '../browser-runtime/core/client.mjs';
import {CORE_PROTOCOL,CoreError,serializeCoreError} from '../browser-runtime/core/contracts.mjs';

function fixture(t,options={}){
    const frames=[];
    const errors=[];
    let receiver;
    const global={console:{error:(...values)=>errors.push(values)}};
    const transport={name:'fixture',send:frame=>frames.push(frame),subscribe(listener){receiver=listener;return ()=>{receiver=null;};}};
    const client=createCoreClient({global,transport,onError:error=>errors.push(error),...options});
    t.after(()=>client.close());
    return {client,frames,errors,receive:frame=>receiver(frame),global};
}

test('Core RPC preserves complete payloads, results and correlation without method policy',async t=>{
    const {client,frames,receive}=fixture(t);
    const parameters={document:'  The moon ate my expense report.\n\t🌙\u0000  ',value:false,nested:{empty:'',zero:0}};
    const result={document:parameters.document,rows:[null,false,0,''],extra:{keep:true}};
    const operation=client.invoke('application.lunar.receipt',parameters);
    const request=frames[0];
    assert.equal(request.protocol,CORE_PROTOCOL);
    assert.equal(request.parameters,parameters);
    assert.equal(request.method,'application.lunar.receipt');
    receive(JSON.stringify({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result}));
    assert.deepEqual(await operation,result);
    assert.equal(client.receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:'late'}),false);
});

test('Core errors retain complete native diagnostics and ordinary Error fields',async t=>{
    const {client,frames,receive}=fixture(t);
    const nativeError={code:'LUNAR_RECEIPT_REJECTED',message:'Complete\n native message',diagnosticId:'moon-7',stack:'complete\nstack',details:{document:'entire document'},hresult:'0x80004005'};
    const operation=client.invoke('application.lunar.receipt',{});
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:false,error:nativeError});
    await assert.rejects(operation,error=>{
        assert.equal(error instanceof CoreError,true);
        for(const [key,value] of Object.entries(nativeError))assert.deepEqual(error[key],value);
        return true;
    });
    const cause=new Error('complete cause');
    const error=new Error('complete failure',{cause});
    error.details={unchanged:'full diagnostic'};
    const record=serializeCoreError(error);
    assert.equal(record.message,error.message);
    assert.equal(record.stack,error.stack);
    assert.equal(record.cause.message,cause.message);
    assert.equal(record.details,error.details);
    const aggregate=new AggregateError([error,new Error('Second complete error'),{complete:'plain error record'}],'All failures');
    const aggregateRecord=serializeCoreError(aggregate);
    assert.equal(aggregateRecord.errors.length,3);
    assert.equal(aggregateRecord.errors[0].cause.message,'complete cause');
    assert.equal(aggregateRecord.errors[1].message,'Second complete error');
    assert.deepEqual(aggregateRecord.errors[2],{complete:'plain error record'});
    assert.deepEqual(new CoreError(aggregate).errors,aggregate.errors);
});

test('Core cancellation sends the existing control frame and ignores late completion',async t=>{
    const {client,frames,receive}=fixture(t);
    const controller=new AbortController();
    const operation=client.invoke('application.wait',{}, {signal:controller.signal});
    const id=frames[0].id;
    controller.abort();
    await assert.rejects(operation,error=>error.code==='ARCANE_REQUEST_ABORTED');
    assert.deepEqual(frames[1],{protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:id});
    assert.equal(receive({protocol:CORE_PROTOCOL,type:'response',id,ok:true,result:'late'}),false);
    const other=client.invoke('application.wait',{});
    client.cancelAll();
    await assert.rejects(other,error=>error.code==='ARCANE_REQUEST_ABORTED');
    assert.deepEqual(frames.at(-1),{protocol:CORE_PROTOCOL,type:'control',control:'requests.cancelAll'});
});

test('Ollama resident inspection forwards cancellation options and preserves no-argument callers',async function ollamaInspectionCancellation(t){
    const {client,frames,receive}=fixture(t);
    const ollama=createCoreFacade(client).ollama;
    const controller=new AbortController();
    const pending=ollama.running({signal:controller.signal});
    const request=frames[0];
    assert.equal(request.method,'ollama.running');
    assert.deepEqual(request.parameters,{});
    controller.abort();
    await assert.rejects(pending,{code:'ARCANE_REQUEST_ABORTED'});
    assert.deepEqual(frames[1],{protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:request.id});
    const ordinary=ollama.running();
    const current=frames.at(-1);
    const result={models:[{model:'moon-raccoon:latest'}]};
    receive({protocol:CORE_PROTOCOL,type:'response',id:current.id,ok:true,result});
    assert.deepEqual(await ordinary,result);
});

test('Core request observer exposes the real ID before send without changing the payload',async t=>{
    let observed;
    let receive;
    const frames=[];
    const transport={name:'fixture',subscribe(listener){receive=listener;},send(frame){
        frames.push(frame);
        assert.equal(observed,frame.id);
    }};
    const {client}=fixture(t,{transport});
    const facade=createCoreFacade(client);
    const payload={audioBase64:'YWJj',model:'whisper-small',complete:'  keep\nall  '};
    const operation=facade.speech.transcribe(payload,{onRequest({requestId}){observed=requestId;}});
    assert.equal(frames[0].parameters,payload);
    receive({protocol:CORE_PROTOCOL,type:'response',id:observed,ok:true,result:{text:'Complete transcript'}});
    assert.deepEqual(await operation,{text:'Complete transcript'});
    const observerFailure=new Error('Observer rejected before dispatch.');
    observerFailure.code='OBSERVER_FAILED';
    await assert.rejects(client.invoke('speech.transcribe',payload,{onRequest(){throw observerFailure;}}),{
        code:'OBSERVER_FAILED'
    });
    assert.equal(frames.length,1);
    const controller=new AbortController();
    controller.abort();
    await assert.rejects(facade.speech.transcribe(payload,{
        signal:controller.signal,onRequest(){assert.fail('Pre-aborted request must not be observed.');}
    }),{code:'ARCANE_REQUEST_ABORTED'});
    assert.equal(frames.length,1);
});

test('Core current ready state is synchronous and replays once with unsubscribe',async t=>{
    const {client,receive}=fixture(t);
    const ready={service:'dispatcher',nested:{complete:'state'}};
    receive({protocol:CORE_PROTOCOL,type:'event',event:'core.ready',data:ready});
    assert.equal(client.events.completed('transport.ready'),true);
    assert.equal(client.events.completed('core.ready'),true);
    assert.equal(client.runtime.current().connected,true);
    const values=[];
    client.events.when('core.ready',value=>values.push(value));
    const unsubscribe=client.events.when('core.ready',()=>assert.fail('cancelled replay'));
    unsubscribe();
    await Promise.resolve();
    receive({protocol:CORE_PROTOCOL,type:'event',event:'core.ready',data:{service:'duplicate'}});
    assert.deepEqual(values,[ready]);
    assert.equal(values[0],ready);
    assert.equal(Object.isFrozen(ready),false);
});

test(
    'window theme facade preserves presentation, partial results and request cancellation',
    async function windowTheme(t){
        const {client,frames,receive}=fixture(t);
        const facade=createCoreFacade(client);
        const presentation={backgroundColor:{red:17.5,green:34,blue:51,alpha:0.999},textColor:null};
        const operation=facade.window.setTheme(presentation);
        assert.equal(frames[0].method,'window.setTheme');
        assert.equal(frames[0].parameters,presentation);
        const result={platform:'windows',supported:true,applied:{textColor:null},unsupported:['backgroundColor']};
        receive(
            {protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result}
        );
        assert.equal(await operation,result);
        const controller=new AbortController();
        const cancelled=facade.window.setTheme(
            presentation,
            {signal:controller.signal}
        );
        const request=frames[1];
        controller.abort();
        await assert.rejects(
            cancelled,
            {code:'ARCANE_REQUEST_ABORTED'}
        );
        assert.deepEqual(
            frames[2],
            {protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:request.id}
        );
        const late=receive(
            {protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result}
        );
        assert.equal(late,false);
        const before=frames.length;
        const preAborted=facade.window.setTheme(
            presentation,
            {signal:controller.signal}
        );
        await assert.rejects(
            preAborted,
            {code:'ARCANE_REQUEST_ABORTED'}
        );
        assert.equal(frames.length,before);
        const failed=facade.window.setTheme(
            {textColor:null},
            null
        );
        const error={code:'ARCANE_WINDOW_THEME_FAILED',message:'Complete native failure',nativeCode:7,
            details:{applied:{backgroundColor:{red:18,green:34,blue:51,alpha:1}},unsupported:['textColor']}};
        receive(
            {protocol:CORE_PROTOCOL,type:'response',id:frames.at(-1).id,ok:false,error}
        );
        await assert.rejects(
            failed,
            function completeNativeError(value){
                for(const [key,item] of Object.entries(error))assert.deepEqual(value[key],item);
                return true;
            }
        );
    }
);

test('window state facade preserves actual results, complete errors and cancellation',async function windowState(t){
    const {client,frames,receive}=fixture(t);
    const window=createCoreFacade(client).window;
    const reading=window.state();
    assert.equal(frames[0].method,'window.state');
    assert.deepEqual(frames[0].parameters,{});
    const minimized={platform:'windows',supported:true,state:'minimized'};
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result:minimized});
    assert.equal(await reading,minimized);
    for(const state of ['normal','maximized','fullscreen']){
        const selection={state,complete:'  Moon observatory\r\n🧀  '};
        const pending=window.setState(selection);
        const request=frames.at(-1);
        assert.equal(request.method,'window.setState');
        assert.equal(request.parameters,selection);
        const actual={platform:'windows',supported:true,state};
        receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:actual});
        assert.equal(await pending,actual);
    }
    const controller=new AbortController();
    const cancelled=window.setState({state:'normal'},{signal:controller.signal});
    const request=frames.at(-1);
    controller.abort();
    await assert.rejects(cancelled,{code:'ARCANE_REQUEST_ABORTED'});
    assert.deepEqual(frames.at(-1),{protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:request.id});
    assert.equal(receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:minimized}),false);
    const before=frames.length;
    await assert.rejects(window.state({signal:controller.signal}),{code:'ARCANE_REQUEST_ABORTED'});
    await assert.rejects(window.setState({state:'fullscreen'},{signal:controller.signal}),{code:'ARCANE_REQUEST_ABORTED'});
    assert.equal(frames.length,before);
    const failed=window.setState({state:'fullscreen'});
    const error={code:'ARCANE_WINDOW_STATE_FAILED',message:'Complete native failure\n🧀',
        details:{requested:{state:'fullscreen'},previous:minimized,actual:{platform:'windows',supported:true,state:'normal'}},
        cause:{name:'NativeError',message:'Complete original cause',stack:'entire\nstack'}};
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames.at(-1).id,ok:false,error});
    await assert.rejects(failed,function completeStateError(value){
        for(const [key,item] of Object.entries(error))assert.deepEqual(value[key],item);
        return true;
    });
    const unsupported=window.state();
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames.at(-1).id,ok:false,
        error:{code:'METHOD_NOT_ALLOWED',message:'This host has no window.state method.'}});
    await assert.rejects(unsupported,{code:'METHOD_NOT_ALLOWED'});
});

test('cancellation owns completion before a transport can reply to its control',async t=>{
    let receive;
    let requestId;
    const transport={name:'fixture',subscribe(listener){receive=listener;},send(frame){
        if(frame.type==='request')requestId=frame.id;
        else receive({protocol:CORE_PROTOCOL,type:'response',id:requestId,ok:true,result:'late response during cancellation'});
    }};
    const {client}=fixture(t,{transport});
    const controller=new AbortController();
    const operation=client.invoke('application.wait',{}, {signal:controller.signal});
    controller.abort();
    await assert.rejects(operation,error=>error.code==='ARCANE_REQUEST_ABORTED');
    const another=client.invoke('application.wait');
    client.cancelAll();
    await assert.rejects(another,error=>error.code==='ARCANE_REQUEST_ABORTED');
});

test('failed transport subscription leaves the client disconnected and retryable',async t=>{
    let attempts=0;
    const transport={name:'fixture',send(){},subscribe(){
        attempts+=1;
        if(attempts===1)throw new Error('The host is still attaching.');
    }};
    const {client,errors}=fixture(t,{transport});
    assert.equal(errors[0].message,'The host is still attaching.');
    assert.equal(client.runtime.current().connected,false);
    assert.equal(client.events.completed('transport.ready'),false);
    client.connect();
    assert.equal(client.runtime.current().connected,true);
    assert.equal(attempts,2);
});

test('a supplied transport becomes ready only after it provides send',async function suppliedTransport(t){
    let subscriptions=0;
    const transport={name:'fixture',subscribe(){subscriptions+=1;}};
    const {client,errors}=fixture(t,{transport});
    assert.equal(errors[0].code,'ARCANE_TRANSPORT_INVALID');
    assert.equal(client.runtime.current().connected,false);
    assert.equal(client.events.completed('transport.ready'),false);
    assert.equal(subscriptions,0);
    await assert.rejects(client.invoke('application.wait'),function invalidTransport(error){
        return error.code==='ARCANE_TRANSPORT_INVALID';
    });
    transport.send=function send(){};
    client.connect();
    assert.equal(client.runtime.current().connected,true);
    assert.equal(client.events.completed('transport.ready'),true);
    assert.equal(subscriptions,1);
});

for(const completion of ['response','cancel','timeout']){
    test(`late transport rejection is reported after request ${completion}`,async function lateSendFailure(t){
        let rejectSend;
        let request;
        const sent=new Promise(function pendingSend(resolve,reject){rejectSend=reject;});
        const transport={name:'fixture',send(frame){
            if(frame.type==='request'){
                request=frame;
                return sent;
            }
        }};
        const {client,errors}=fixture(t,{transport});
        const controller=new AbortController();
        const operation=client.invoke('application.wait',{}, {
            signal:controller.signal,timeoutMs:completion==='timeout'?1:0
        });
        if(completion==='response'){
            client.receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:'Complete result'});
            assert.equal(await operation,'Complete result');
        }else{
            if(completion==='cancel')controller.abort();
            await assert.rejects(operation,function settledRequest(error){
                return error.code===(completion==='cancel'?'ARCANE_REQUEST_ABORTED':'ARCANE_REQUEST_TIMEOUT');
            });
        }
        const failure=new Error('Complete late transport failure');
        failure.code='MOON_TRANSPORT_LATE_FAILURE';
        failure.details={complete:'  Late native diagnostic\n🌙  '};
        rejectSend(failure);
        await Promise.resolve();
        assert.equal(errors.length,1);
        for(const key of Object.getOwnPropertyNames(failure))assert.equal(errors[0][key],failure[key]);
    });
}

test('synchronous send failure after a response is reported without replacing the result',async function synchronousLateFailure(t){
    let client;
    const failure=new Error('The bridge failed after delivering its response.');
    const transport={name:'fixture',send(frame){
        client.receive({protocol:CORE_PROTOCOL,type:'response',id:frame.id,ok:true,result:'Accepted result'});
        throw failure;
    }};
    const state=fixture(t,{transport});
    client=state.client;
    assert.equal(await client.invoke('application.finish'),'Accepted result');
    assert.equal(state.errors.length,1);
    assert.equal(state.errors[0].message,failure.message);
    assert.equal(state.errors[0].stack,failure.stack);
});

test('closing rejects reentrant requests and stops synchronous control events',async t=>{
    let receive;
    let client;
    let reentrant;
    const delivered=[];
    const transport={name:'fixture',subscribe(listener){receive=listener;},send(frame){
        if(frame.type!=='control')return;
        receive({protocol:CORE_PROTOCOL,type:'event',event:'application.closing',data:{complete:'event'}});
        reentrant=client.invoke('application.reentrant');
    }};
    ({client}=fixture(t,{transport}));
    client.events.on('application.closing',event=>delivered.push(event));
    const operation=client.invoke('application.wait');
    client.close();
    await assert.rejects(operation,error=>error.code==='ARCANE_REQUEST_ABORTED');
    await assert.rejects(reentrant,error=>error.code==='ARCANE_CLIENT_CLOSED');
    assert.deepEqual(delivered,[]);
    assert.equal(client.runtime.current().connected,false);
    assert.equal(client.close(),false);
});

test('classic event-owner handoff retains subscriptions, chunks and final response order',async t=>{
    let connectOwner;
    const eventOwnerReady=new Promise(resolve=>{connectOwner=resolve;});
    const {client,frames,receive}=fixture(t,{eventOwner:null,eventOwnerReady});
    const facade=createCoreFacade(client);
    const order=[];
    const operation=facade.ollama.generate({prompt:'Complete moon poem'},chunk=>order.push(chunk))
        .then(result=>{order.push(result);return result;});
    const request=frames[0];
    const first='The first complete chunk\n';
    receive({protocol:CORE_PROTOCOL,type:'event',event:'ollama.chunk',data:{streamId:request.parameters.streamId,chunk:first}});
    receive({protocol:CORE_PROTOCOL,type:'event',event:'ollama.chunk',data:{streamId:request.parameters.streamId,chunk:'Second 🌙'}});
    receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:'Finished'});
    await Promise.resolve();
    assert.deepEqual(order,[]);
    connectOwner(arcaneEvents);
    assert.equal(await operation,'Finished');
    assert.deepEqual(order,[first,'Second 🌙','Finished']);
});

test('classic handoff appends reentrant frames and subscriptions after queued response delivery',async function reentrantHandoff(t){
    let connectOwner;
    const eventOwnerReady=new Promise(function pendingOwner(resolve){connectOwner=resolve;});
    const {client,frames,receive}=fixture(t,{eventOwner:null,eventOwnerReady});
    const order=[];
    let lateResponseAccepted;
    client.events.on('application.frame',function receivedFrame(value){
        order.push(value);
        if(value==='first'){
            client.events.on('application.reentrant',function reentrantFrame(data){
                order.push(data);
                lateResponseAccepted=receive({
                    protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result:'Late response'
                });
            });
            receive({protocol:CORE_PROTOCOL,type:'event',event:'application.reentrant',data:'reentrant'});
        }
    });
    const operation=client.invoke('application.ordered').then(function completed(result){
        order.push(result);
        return result;
    });
    receive({protocol:CORE_PROTOCOL,type:'event',event:'application.frame',data:'first'});
    receive({protocol:CORE_PROTOCOL,type:'event',event:'application.frame',data:'second'});
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result:'Finished'});
    assert.deepEqual(order,[]);
    connectOwner(arcaneEvents);
    assert.equal(await operation,'Finished');
    assert.deepEqual(order,['first','second','reentrant','Finished']);
    assert.equal(lateResponseAccepted,false);
});

test('facade routes native data operations without trimming supplied content',async t=>{
    const {client,frames,receive}=fixture(t);
    const facade=createCoreFacade(client);
    const key='  draft.key  ';
    const value={text:'  Complete\n document  '};
    const save=facade.storage.set(key,value);
    assert.deepEqual(frames[0].parameters,{key,value});
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result:{key,value}});
    assert.deepEqual(await save,{key,value});
});

test('speech activation forwards complete selection, results and request correlation',async function speechActivationFrames(t){
    const {client,frames,receive}=fixture(t);
    const speech=createCoreFacade(client).speech;
    const paths={model:'onnx/model.onnx',tokenizer:'tokenizer.json',tokenizerConfig:'tokenizer_config.json',voices:{af_heart:'voices/af_heart.bin'}};
    const selections=[
        {role:'tts',assetProjectionId:'prepared-moon',resourcePaths:paths,executionTarget:null,extra:{complete:'  Every line.\r\n月  '}},
        {role:'tts',assetProjectionId:'prepared-moon',resourcePaths:paths}
    ];
    for(const parameters of selections){
        let observed;
        const operation=speech.load(parameters,{onRequest({requestId}){observed=requestId;}});
        const request=frames.at(-1);
        assert.equal(request.method,'speech.load');
        assert.equal(request.parameters,parameters);
        assert.equal(observed,request.id);
        const result={modelId:'kokoro',state:'ready',loaded:true,execution:{requestedTarget:parameters.executionTarget},detail:{complete:'Full engine result'}};
        receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result});
        assert.equal(await operation,result);
    }
    assert.equal(Object.hasOwn(frames[1].parameters,'executionTarget'),false);
    const parameters={role:'tts'};
    let observed;
    const unloading=speech.unload(parameters,{onRequest({requestId}){observed=requestId;}});
    const request=frames.at(-1);
    assert.equal(request.method,'speech.unload');
    assert.equal(request.parameters,parameters);
    assert.equal(observed,request.id);
    const failure={code:'KOKORO_RELEASE_FAILED',message:'Complete cleanup failure\nsecond line',stack:'Full\nstack',cause:{message:'Native exit failed',detail:{complete:true}},errors:[{message:'Helper failed'},{message:'ONNX release failed'}],execution:{attempts:[{provider:'dml',error:{complete:'Full failure'}}]}};
    receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:false,error:failure});
    await assert.rejects(unloading,function completeFailure(error){
        for(const [name,value] of Object.entries(failure))assert.deepEqual(error[name],value);
        return true;
    });
});

test('speech activation cancellation uses its own request and keeps the connection usable',async function speechActivationCancellation(t){
    const {client,frames,receive}=fixture(t);
    const speech=createCoreFacade(client).speech;
    for(const method of ['load','unload']){
        const controller=new AbortController();
        const parameters={role:'tts',assetProjectionId:'prepared-moon'};
        const operation=speech[method](parameters,{signal:controller.signal});
        const request=frames.at(-1);
        controller.abort();
        await assert.rejects(operation,{name:'AbortError',code:'ARCANE_REQUEST_ABORTED',method:`speech.${method}`});
        assert.deepEqual(frames.at(-1),{protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:request.id});
        assert.equal(receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:'late'}),false);
        const count=frames.length;
        await assert.rejects(speech[method](parameters,{signal:controller.signal}),{code:'ARCANE_REQUEST_ABORTED'});
        assert.equal(frames.length,count);
    }
    const current=speech.status();
    const request=frames.at(-1);
    const result={roles:{stt:{state:'ready',loaded:true},tts:{state:'unloaded',loaded:false}}};
    receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result});
    assert.equal(await current,result);
});

test('speech synthesis cancellation preserves its payload and leaves other requests active',async function speechCancellation(t){
    const {client,frames,receive}=fixture(t);
    const facade=createCoreFacade(client);
    const controller=new AbortController();
    const parameters={input:'  The moon requests an encore.\n\t🌙\u0000  ',model:'kokoro',voice:'alloy',responseFormat:'opus',speed:1,extra:{complete:true}};
    const preparation={speechInputPrepared:true};
    const operation=facade.speech.synthesize(parameters,{signal:controller.signal},preparation);
    const request=frames[0];
    const other=facade.speech.synthesize({input:'The second moon keeps singing.'});
    assert.equal(request.method,'speech.synthesize');
    assert.equal(request.parameters,parameters);
    controller.abort();
    await assert.rejects(operation,{name:'AbortError',code:'ARCANE_REQUEST_ABORTED',method:'speech.synthesize'});
    assert.deepEqual(frames[2],{protocol:CORE_PROTOCOL,type:'control',control:'request.cancel',requestId:request.id});
    assert.equal(receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:'late audio'}),false);
    const result={audioBase64:'Q29tcGxldGUgYXVkaW8=',contentType:'audio/ogg',details:{complete:'result'}};
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames[1].id,ok:true,result});
    assert.equal(await other,result);
    assert.deepEqual(preparation,{speechInputPrepared:true});
    assert.equal(frames.length,3);
});

test('speech synthesis accepts absent options and sends no pre-aborted request',async function speechOptionalSignal(t){
    const {client,frames,receive}=fixture(t);
    const facade=createCoreFacade(client);
    const controller=new AbortController();
    controller.abort();
    await assert.rejects(facade.speech.synthesize({input:'Unsent moon song.'},{signal:controller.signal}),{
        name:'AbortError',code:'ARCANE_REQUEST_ABORTED'
    });
    assert.deepEqual(frames,[]);
    for(const options of [undefined,null,{}]){
        const operation=facade.speech.synthesize(undefined,options);
        const request=frames.at(-1);
        assert.equal(request.method,'speech.synthesize');
        assert.deepEqual(request.parameters,{});
        receive({protocol:CORE_PROTOCOL,type:'response',id:request.id,ok:true,result:{complete:true}});
        assert.deepEqual(await operation,{complete:true});
    }
    assert.equal(frames.length,3);
});

test('installed WebKit facade preserves early frames, acknowledgement and cleanup',async t=>{
    const global={console,arcaneEvents};
    const sent=[];
    global.__arcaneWebKitPostMessage=function sendWebKit(token,serialized){
        const frame=JSON.parse(serialized);
        sent.push(frame);
        global.__arcaneWebKitAcknowledge(token,{accepted:true});
        if(frame.type==='request')global.__arcaneReceive({protocol:CORE_PROTOCOL,type:'response',id:frame.id,ok:true,result:{ok:true}});
        return true;
    };
    const client=installCoreClient(global);
    t.after(()=>client.close());
    assert.equal(global.Arcane.runtime.current().transport,'webkitgtk');
    global.__arcaneReceive({protocol:CORE_PROTOCOL,type:'event',event:'core.ready',data:{ready:true}});
    assert.equal(global.Arcane.events.completed('core.ready'),true);
    assert.deepEqual(await global.Arcane.system.ping(),{ok:true});
    assert.equal(sent[0].method,'system.ping');
    assert.equal(installCoreClient(global),client);
    client.close();
    assert.equal(global.Arcane,undefined);
    assert.equal(global.__arcaneReceive,undefined);
    assert.equal(global.__arcaneWebKitAcknowledge,undefined);
    assert.equal(global.__arcaneTransportFailed,undefined);
});

test('terminal transport failure preserves one complete error and releases pending ownership',async function terminalFailure(t){
    const frames=[];
    const listeners=new Map();
    const errors=[];
    let unsubscribed=0;
    let receive;
    const global={console,addEventListener(name,listener){listeners.set(name,listener);},
        removeEventListener(name,listener){if(listeners.get(name)===listener)listeners.delete(name);}};
    const transport={name:'fixture',send(frame){frames.push(frame);},subscribe(listener){
        receive=listener;
        return function unsubscribe(){unsubscribed+=1;};
    }};
    const client=createCoreClient({global,transport,onError:error=>errors.push(error)});
    t.after(()=>client.close());
    const controller=new AbortController();
    const first=client.invoke('application.first',{}, {signal:controller.signal});
    const second=client.invoke('application.second');
    const cause=new Error('Complete native pipe cause\n🌙');
    const failure=new CoreError({code:'CORE_PROCESS_PIPE_FAILED',message:'Complete native process failure',
        cause,details:{stderr:'  Every native diagnostic\n\u0000🌙  '},exitCode:7});
    assert.equal(client.failTransport(failure),true);
    await assert.rejects(first,error=>error===failure);
    await assert.rejects(second,error=>error===failure);
    assert.deepEqual(errors,[failure]);
    assert.equal(errors[0].cause,cause);
    assert.equal(errors[0].details,failure.details);
    assert.equal(client.runtime.current().connected,false);
    assert.equal(unsubscribed,1);
    assert.equal(listeners.size,0);
    controller.abort();
    assert.equal(frames.length,2);
    assert.equal(receive({protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result:'late'}),false);
    await assert.rejects(client.invoke('application.afterFailure'),error=>error===failure);
    assert.throws(()=>client.connect(),error=>error===failure);
    assert.equal(client.failTransport(new Error('Duplicate host notification')),false);
    assert.equal(client.close(),false);
    assert.deepEqual(errors,[failure]);
});

test('installed native failure settles WebKit acknowledgements and restores prior globals once',async function failedWebKit(t){
    const previousFacade={application:'Existing global'};
    function previousReceive(){}
    function previousAcknowledge(){}
    function previousFailure(){}
    const global={console,Arcane:previousFacade,__arcaneReceive:previousReceive,
        __arcaneWebKitAcknowledge:previousAcknowledge,__arcaneTransportFailed:previousFailure};
    const frames=[];
    global.__arcaneWebKitPostMessage=function send(token,serialized){frames.push({token,frame:JSON.parse(serialized)});return true;};
    const errors=[];
    const client=installCoreClient(global,{onError(error){
        assert.equal(getInstalledCoreClient(global),null);
        errors.push(error);
    }});
    t.after(()=>client.close());
    assert.equal(getInstalledCoreClient(global),client);
    const acknowledge=global.__arcaneWebKitAcknowledge;
    const notifyFailure=global.__arcaneTransportFailed;
    const cause=new Error('Complete original native cause');
    const failure=new Error('Complete host failure\n🌙',{cause});
    Object.assign(failure,{code:'CORE_HOST_EXITED',exitCode:23,details:{stderr:'  Complete stderr\n  '}});
    const operation=client.invoke('application.pending');
    const acknowledgement=client.connect().send({protocol:CORE_PROTOCOL,type:'control',control:'runtime.replay'});
    const results=Promise.allSettled([operation,acknowledgement]);
    assert.equal(notifyFailure(failure),true);
    const settled=await results;
    assert.equal(errors.length,1);
    assert.equal(errors[0] instanceof CoreError,true);
    for(const key of Object.getOwnPropertyNames(failure))assert.equal(errors[0][key],failure[key]);
    for(const result of settled){assert.equal(result.status,'rejected');assert.equal(result.reason,errors[0]);}
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(global.Arcane,previousFacade);
    assert.equal(global.__arcaneReceive,previousReceive);
    assert.equal(global.__arcaneWebKitAcknowledge,previousAcknowledge);
    assert.equal(global.__arcaneTransportFailed,previousFailure);
    for(const frame of frames)assert.equal(acknowledge(frame.token,{accepted:true}),false);
    assert.equal(notifyFailure(failure),false);
    await Promise.resolve();
    assert.equal(errors.length,1);
});

test('the installed accessor only observes SDK ownership and leaves foreign replacements intact',function installedOwnership(t){
    const key=Symbol.for('arcane-os.core.client');
    const foreign={application:'Not an SDK client'};
    const global={console,Arcane:foreign,[key]:foreign};
    const originalKeys=Reflect.ownKeys(global);
    assert.equal(getInstalledCoreClient(global),null);
    assert.deepEqual(Reflect.ownKeys(global),originalKeys);
    assert.equal(global.Arcane,foreign);
    assert.equal(global[key],foreign);
    delete global[key];
    const client=installCoreClient(global,{transport:{name:'fixture',send(){}}});
    t.after(()=>client.close());
    assert.equal(getInstalledCoreClient(global),client);
    function replacementReceive(){}
    function replacementFailure(){}
    global[key]=foreign;
    global.Arcane=foreign;
    global.__arcaneReceive=replacementReceive;
    global.__arcaneTransportFailed=replacementFailure;
    client.close();
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(global[key],foreign);
    assert.equal(global.Arcane,foreign);
    assert.equal(global.__arcaneReceive,replacementReceive);
    assert.equal(global.__arcaneTransportFailed,replacementFailure);
});

test('the ESM accessor returns the exact classic-installed client without another connection',async function classicIdentity(t){
    const context=createContext({console,arcaneEvents,setTimeout,clearTimeout,
        arcaneAndroid:{postMessage(){assert.fail('No request or replay was selected.');}}});
    const source=await createCoreClassicSource({eventOwnerModuleURL:'/sdk/event-manager.mjs'});
    runInContext(source,context);
    const global=runInContext('globalThis',context);
    const client=getInstalledCoreClient(global);
    assert.ok(client);
    t.after(()=>client.close());
    assert.equal(client,global[Symbol.for('arcane-os.core.client')]);
    assert.equal(installCoreClient(global),client);
    client.close();
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(global.__arcaneTransportFailed,undefined);
});

test('ordinary close restores the prior facade and native callbacks',function ordinaryInstalledClose(t){
    const facade={application:'Moon filing cabinet'};
    function receive(){}
    function failed(){}
    const global={console,Arcane:facade,__arcaneReceive:receive,__arcaneTransportFailed:failed};
    const client=installCoreClient(global,{transport:{name:'fixture',send(){}}});
    t.after(()=>client.close());
    assert.equal(client.close(),true);
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(global.Arcane,facade);
    assert.equal(global.__arcaneReceive,receive);
    assert.equal(global.__arcaneTransportFailed,failed);
});

test('terminal failure settles requests before a pending classic event-owner handoff',async function failedEarlyHandoff(t){
    let resolveOwner;
    const eventOwnerReady=new Promise(resolve=>{resolveOwner=resolve;});
    const {client,frames,receive}=fixture(t,{eventOwner:null,eventOwnerReady});
    client.events.on('application.queued',()=>assert.fail('A failed client must not replay queued events.'));
    const operation=client.invoke('application.pendingOwner');
    receive({protocol:CORE_PROTOCOL,type:'event',event:'application.queued',data:{complete:'Queued data'}});
    receive({protocol:CORE_PROTOCOL,type:'response',id:frames[0].id,ok:true,result:'Queued completion'});
    const failure=new CoreError({code:'CORE_PROCESS_EXITED',message:'Complete startup failure'});
    client.failTransport(failure);
    await assert.rejects(operation,error=>error===failure);
    resolveOwner({createSource(){assert.fail('A failed client must not attach another event source.');}});
    await client.eventsReady;
    assert.equal(client.events.completed('transport.ready'),false);
});

test('runtime replay is opt-in, follows transport registration and is sent once without awaiting',async function runtimeReplay(t){
    const order=[];
    const errors=[];
    let receive;
    let rejectReplay;
    const replay=new Promise(function replayDelivery(resolve,reject){rejectReplay=reject;});
    const transport={name:'fixture',subscribe(listener){receive=listener;order.push('subscribed');},send(frame){
        assert.equal(client.events.completed('transport.ready'),true);
        order.push(frame);
        receive({protocol:CORE_PROTOCOL,type:'event',event:'core.ready',data:{state:'ready'}});
        return replay;
    }};
    const client=createCoreClient({transport,autoConnect:false,replayRuntimeState:true,onError:error=>errors.push(error)});
    t.after(()=>client.close());
    client.connect();
    assert.deepEqual(order,['subscribed',{protocol:CORE_PROTOCOL,type:'control',control:'runtime.replay'}]);
    assert.equal(client.events.completed('transport.ready'),true);
    assert.equal(client.events.completed('core.ready'),true);
    assert.equal(client.connect(),transport);
    assert.equal(order.length,2);
    const failure=new CoreError({code:'CORE_REPLAY_DELIVERY_FAILED',message:'Complete replay failure'});
    rejectReplay(failure);
    await Promise.resolve();
    assert.deepEqual(errors,[failure]);
    const ordinary=fixture(t);
    assert.deepEqual(ordinary.frames,[]);
});

test('a synchronous replay failure closes the installed client without a second error report',async function synchronousReplayFailure(t){
    const errors=[];
    const failure=new CoreError({code:'CORE_PROCESS_EXITED',message:'The process exited during replay.',exitCode:9});
    const global={console};
    let sends=0;
    let unsubscribed=0;
    const transport={name:'fixture',subscribe(){return ()=>{unsubscribed+=1;};},send(frame){
        sends+=1;
        assert.equal(frame.control,'runtime.replay');
        global.__arcaneTransportFailed(failure);
    }};
    const client=installCoreClient(global,{transport,replayRuntimeState:true,onError:error=>errors.push(error)});
    t.after(()=>client.close());
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(client.runtime.current().connected,false);
    assert.equal(unsubscribed,1);
    assert.deepEqual(errors,[failure]);
    await assert.rejects(client.invoke('application.afterReplay'),error=>error===failure);
    assert.equal(sends,1);
});

test('failure during transport subscription releases its subsequently returned cleanup',function subscriptionFailure(t){
    const global={console};
    const errors=[];
    const failure=new CoreError({code:'CORE_PROCESS_EXITED',message:'The host exited while attaching.'});
    let unsubscribed=0;
    const transport={name:'fixture',send(){assert.fail('A failed subscription cannot send.');},subscribe(){
        global.__arcaneTransportFailed(failure);
        return function unsubscribe(){unsubscribed+=1;};
    }};
    const client=installCoreClient(global,{transport,replayRuntimeState:true,onError:error=>errors.push(error)});
    t.after(()=>client.close());
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(client.runtime.current().connected,false);
    assert.equal(unsubscribed,1);
    assert.deepEqual(errors,[failure]);
});

test('ordinary browser has no implicit HTTP transport',async t=>{
    let calls=0;
    const global={fetch(){calls+=1;},console};
    const client=createCoreClient({global});
    t.after(()=>client.close());
    assert.deepEqual(client.runtime.current(),{connected:false,transport:'standalone',native:false,managedLocalAI:false});
    await assert.rejects(client.invoke('system.ping'),error=>error.code==='ARCANE_TRANSPORT_UNAVAILABLE');
    assert.equal(calls,0);
});

test('native transport failures retain nested error diagnostics',async t=>{
    const failure=new AggregateError([new Error('Complete host failure')],'Native bridge failed');
    const global={console,chrome:{webview:{
        hostObjects:{arcaneBridge:{Send(){throw failure;}}},
        addEventListener(){},removeEventListener(){}
    }}};
    const client=createCoreClient({global});
    t.after(()=>client.close());
    await assert.rejects(client.invoke('system.ping'),error=>{
        assert.equal(error.code,'ARCANE_BRIDGE_CALL_FAILED');
        assert.equal(error.message,failure.message);
        assert.equal(error.technicalMessage,'Native bridge failed');
        assert.equal(error.stack,failure.stack);
        assert.equal(error.errors[0].message,'Complete host failure');
        return true;
    });
});

function webKitDocumentFixture(t, options = {}) {
    const records = [];
    const waiting = [];
    const readers = [];
    const listeners = new Map();
    const errors = [];
    const global = {
        console,
        addEventListener(name, listener) { listeners.set(name, listener); },
        removeEventListener(name, listener) {
            if (listeners.get(name) === listener) listeners.delete(name);
        },
        webkit: {messageHandlers: {arcane: {postMessage(record) {
            records.push(record);
            return new Promise(
                function awaitNativeAcceptance(resolve) {
                    const delivery = {record, accept() { resolve({accepted: true}); }};
                    if (readers.length) readers.shift()(delivery);
                    else waiting.push(delivery);
                }
            );
        }}}}
    };
    const client = installCoreClient(
        global, {webKitDocumentLifecycle: true, onError(error) { errors.push(error); }, ...options}
    );
    t.after(
        function releaseDocumentFixture() {
            client.close();
            for (const delivery of waiting) delivery.accept();
        }
    );
    function next() {
        if (waiting.length) return Promise.resolve(waiting.shift());
        return new Promise(function awaitDelivery(resolve) { readers.push(resolve); });
    }
    function hide() { listeners.get('pagehide')({persisted: true}); }
    function restore() { listeners.get('pageshow')({persisted: true}); }
    return {client, global, records, errors, next, hide, restore};
}

test('WebKit retirement during native attachment cannot send a queued request into restoration', async function pendingDocument(t) {
    const {client, global, records, next, hide, restore} = webKitDocumentFixture(t);
    const initial = await next();
    const oldActivation = initial.record.activation;
    assert.equal(global.__arcaneWebKitDocumentCurrent(oldActivation), true);
    const pending = client.invoke('application.moon.wait');
    const cancelled = assert.rejects(pending, {name: 'AbortError', code: 'ARCANE_REQUEST_ABORTED'});
    hide();
    const retirement = await next();
    assert.equal(retirement.record.type, 'retire');
    assert.equal(retirement.record.activation, oldActivation);
    assert.deepEqual(JSON.parse(retirement.record.json), {protocol: CORE_PROTOCOL, type: 'control', control: 'requests.cancelAll'});
    assert.equal(global.__arcaneWebKitDocumentCurrent(oldActivation), false);
    initial.accept();
    retirement.accept();
    await cancelled;
    restore();
    const restored = await next();
    const activation = restored.record.activation;
    assert.equal(restored.record.type, 'activate');
    assert.notEqual(activation, oldActivation);
    restored.accept();
    const replay = await next();
    assert.deepEqual(JSON.parse(replay.record.json), {protocol: CORE_PROTOCOL, type: 'control', control: 'runtime.replay'});
    replay.accept();
    assert.equal(records.some(function isRetiredRequest(record) {
        return record.type === 'frame' && JSON.parse(record.json).type === 'request';
    }), false);
    assert.equal(global.__arcaneTransportFailed({message: 'Retired process delivery'}, oldActivation), false);
    assert.equal(getInstalledCoreClient(global), client);
    const parameters = {document: '  The moon demands its entire receipt.\n\t🌙\u0000  '};
    const operation = client.invoke('application.moon.receipt', parameters);
    const delivery = await next();
    assert.equal(delivery.record.activation, activation);
    const request = JSON.parse(delivery.record.json);
    assert.deepEqual(request.parameters, parameters);
    delivery.accept();
    const response = {protocol: CORE_PROTOCOL, type: 'response', id: request.id, ok: true, result: parameters};
    assert.equal(global.__arcaneReceive(JSON.stringify(response), oldActivation), false);
    assert.equal(global.__arcaneReceive(JSON.stringify(response), activation), true);
    assert.deepEqual(await operation, parameters);
});

test('WebKit cancellation during attachment never submits the cancelled save', async function cancelledBeforeAttachment(t) {
    const {client, records, next} = webKitDocumentFixture(t);
    const initial = await next();
    const controller = new AbortController();
    const save = client.invoke(
        'application.moon.save', {document: 'This receipt was cancelled before sending.'}, {signal: controller.signal}
    );
    const cancelled = assert.rejects(save, {name: 'AbortError', code: 'ARCANE_REQUEST_ABORTED'});
    controller.abort();
    initial.accept();
    await cancelled;
    const cancellation = await next();
    const control = JSON.parse(cancellation.record.json);
    assert.equal(control.control, 'request.cancel');
    cancellation.accept();
    assert.equal(records.some(function isCancelledSave(record) {
        return record.type === 'frame' && JSON.parse(record.json).type === 'request';
    }), false);
});

test('WebKit restoration keeps registrations and ends old renderer waits before deferred event attachment', async function restoredListeners(t) {
    let attach;
    const eventOwnerReady = new Promise(function awaitOwner(resolve) { attach = resolve; });
    const {client, global, next, hide, restore} = webKitDocumentFixture(
        t, {eventOwner: null, eventOwnerReady}
    );
    const initial = await next();
    const oldActivation = initial.record.activation;
    initial.accept();
    const values = [];
    client.events.on('service.state', function serviceState(value) { values.push(value); });
    const save = client.invoke('application.moon.save', {document: 'Complete saved receipt'});
    const cancelled = assert.rejects(save, {name: 'AbortError', code: 'ARCANE_REQUEST_ABORTED'});
    const delivery = await next();
    const request = JSON.parse(delivery.record.json);
    delivery.accept();
    global.__arcaneReceive({protocol: CORE_PROTOCOL, type: 'event', event: 'service.state', data: 'retired state'}, oldActivation);
    global.__arcaneReceive({protocol: CORE_PROTOCOL, type: 'event', event: 'core.ready', data: 'retired ready'}, oldActivation);
    const ready = [];
    client.events.when('core.ready', function readyState(value) { ready.push(value); });
    global.__arcaneReceive({protocol: CORE_PROTOCOL, type: 'response', id: request.id, ok: true, result: 'retired response'}, oldActivation);
    hide();
    const retirement = await next();
    retirement.accept();
    await cancelled;
    restore();
    const restored = await next();
    const activation = restored.record.activation;
    restored.accept();
    const replay = await next();
    replay.accept();
    assert.equal(global.__arcaneReceive({protocol: CORE_PROTOCOL, type: 'response', id: request.id, ok: true, result: 'late save result'}, oldActivation), false);
    global.__arcaneReceive({protocol: CORE_PROTOCOL, type: 'event', event: 'service.state', data: 'current state'}, activation);
    global.__arcaneReceive({protocol: CORE_PROTOCOL, type: 'event', event: 'core.ready', data: 'current ready'}, activation);
    attach(arcaneEvents);
    await client.eventsReady;
    assert.deepEqual(values, ['current state']);
    assert.deepEqual(ready, ['current ready']);
    assert.equal(client.events.completed('core.ready'), true);
});

for(const adapter of ['webview2','android-webview']){
    test(`${adapter} preserves original native error fields and supplies missing bridge context`,async function nativeErrorFields(t){
        const failure=new Error('Complete native message\nThe moon rejected the receipt.',{
            cause:new Error('Complete native cause')
        });
        Object.assign(failure,{
            name:'MoonNativeError',code:'MOON_RECEIPT_REJECTED',
            technicalMessage:'Complete native technical message',causeName:'MoonNativeCause',
            diagnosticId:'moon-native-7',details:{content:'  Complete document\n🌙  '}
        });
        const global={console};
        if(adapter==='webview2'){
            global.chrome={webview:{
                hostObjects:{arcaneBridge:{Send(){throw failure;}}},
                addEventListener(){},removeEventListener(){}
            }};
        }else{
            global.arcaneAndroid={postMessage(){throw failure;}};
        }
        const client=createCoreClient({global});
        t.after(function closeClient(){client.close();});
        await assert.rejects(client.invoke('system.ping'),function originalNativeError(error){
            const expected=serializeCoreError(failure);
            for(const [key,value] of Object.entries(expected))assert.deepEqual(error[key],value);
            assert.equal(error.method,'system.ping');
            assert.equal(error.transport,adapter);
            return true;
        });
        failure.method='native.receipt';
        failure.transport='native-owned-transport';
        await assert.rejects(client.invoke('system.ping'),function nativeContext(error){
            const expected=serializeCoreError(failure);
            for(const [key,value] of Object.entries(expected))assert.deepEqual(error[key],value);
            return true;
        });
    });
}
