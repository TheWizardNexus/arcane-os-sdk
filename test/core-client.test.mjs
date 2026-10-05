import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {arcaneEvents} from '../browser-runtime/event-manager.mjs';
import {createCoreClient,createCoreFacade,installCoreClient} from '../browser-runtime/core/client.mjs';
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
        assert.equal(error.technicalMessage,'Native bridge failed');
        assert.equal(error.stack,failure.stack);
        assert.equal(error.errors[0].message,'Complete host failure');
        return true;
    });
});
