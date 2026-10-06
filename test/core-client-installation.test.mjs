import assert from 'node:assert/strict';
import {createContext,runInContext} from 'node:vm';
import test from '../src/testing.mjs';
import {createCoreClassicSource} from '../src/core-classic-source.mjs';
import {getInstalledCoreClient,installCoreClient,subscribeCoreClient} from '../browser-runtime/core/client.mjs';
import {CoreError} from '../browser-runtime/core/contracts.mjs';

function transport(){
    return {name:'fixture',send(){}};
}

test('installation observers replay exact current ownership and retire once after globals restore',function installationLifecycle(t){
    const previousFacade={application:'Lunar sandwich ledger'};
    function previousReceive(){}
    function previousFailure(){}
    const global={console,Arcane:previousFacade,__arcaneReceive:previousReceive,__arcaneTransportFailed:previousFailure};
    const snapshots=[];
    const observed=[];
    const stop=subscribeCoreClient(function installedChanged(snapshot){
        snapshots.push(snapshot);
        observed.push({current:getInstalledCoreClient(global),connected:(snapshot.client??snapshot.previousClient)?.runtime.current().connected,
            facade:global.Arcane,receive:global.__arcaneReceive,failure:global.__arcaneTransportFailed});
    },{global});
    t.after(stop);
    assert.deepEqual(snapshots,[{client:null,previousClient:null,reason:'current',error:null}]);
    const client=installCoreClient(global,{transport:transport()});
    t.after(function closeClient(){client.close();});
    assert.equal(snapshots[1].client,client);
    assert.equal(snapshots[1].previousClient,null);
    assert.equal(observed[1].current,client);
    assert.equal(observed[1].connected,true);
    assert.equal(installCoreClient(global),client);
    assert.equal(snapshots.length,2);
    let current;
    const stopCurrent=subscribeCoreClient(function captureCurrent(snapshot){current=snapshot;},{global});
    assert.equal(current.client,client);
    assert.equal(current.reason,'current');
    stopCurrent();
    assert.equal(client.close(),true);
    assert.equal(snapshots[2].previousClient,client);
    assert.equal(snapshots[2].client,null);
    assert.equal(snapshots[2].error,null);
    assert.equal(observed[2].current,null);
    assert.equal(observed[2].connected,false);
    assert.equal(observed[2].facade,previousFacade);
    assert.equal(observed[2].receive,previousReceive);
    assert.equal(observed[2].failure,previousFailure);
    assert.equal(client.close(),false);
    assert.equal(snapshots.length,3);
    assert.equal(stop(),true);
    assert.equal(stop(),false);
});

test('installation observation is optional and preserves standalone capabilities',function standaloneInstallation(t){
    const global={console};
    const snapshots=[];
    const controller=new AbortController();
    const stop=subscribeCoreClient(function capture(snapshot){snapshots.push(snapshot);},{global,emitCurrent:false,signal:controller.signal});
    t.after(stop);
    assert.deepEqual(snapshots,[]);
    const client=installCoreClient(global);
    t.after(function closeClient(){client.close();});
    assert.equal(snapshots[0].reason,'installed');
    assert.equal(snapshots[0].client,client);
    assert.deepEqual(client.runtime.current(),{connected:false,transport:'standalone',native:false,managedLocalAI:false});
    controller.abort();
    client.close();
    assert.equal(snapshots.length,1);
    assert.equal(stop(),false);
    const untouched={console};
    const keys=Reflect.ownKeys(untouched);
    const alreadyAborted=subscribeCoreClient(function neverObserve(){assert.fail('An aborted observer must not run.');},{global:untouched,signal:controller.signal});
    assert.equal(alreadyAborted(),false);
    assert.deepEqual(Reflect.ownKeys(untouched),keys);
    assert.equal(getInstalledCoreClient(untouched),null);
});

test('transport retirement retains the actual failure and a reentrant replacement',function replacementDuringFailure(t){
    const global={console};
    const snapshots=[];
    const stop=subscribeCoreClient(function capture(snapshot){snapshots.push(snapshot);},{global,emitCurrent:false});
    t.after(stop);
    let replacement;
    const failure=new CoreError({code:'MOON_ENGINE_STOPPED',message:'Complete\n engine failure',details:{complete:'  all diagnostics  '}});
    const client=installCoreClient(global,{transport:transport(),onError(error){
        assert.equal(error,failure);
        assert.equal(getInstalledCoreClient(global),null);
        replacement=installCoreClient(global,{transport:transport()});
    }});
    t.after(function closeClients(){client.close();replacement?.close();});
    assert.equal(client.failTransport(failure),true);
    const retired=snapshots.at(-1);
    assert.equal(retired.reason,'transport-failed');
    assert.equal(retired.client,replacement);
    assert.equal(retired.previousClient,client);
    assert.equal(retired.error,failure);
    assert.equal(getInstalledCoreClient(global),replacement);
    assert.equal(global.__arcaneReceive,replacement.receive);
    assert.equal(client.failTransport(failure),false);
    assert.equal(client.close(),false);
    assert.equal(snapshots.filter(function failed(snapshot){return snapshot.reason==='transport-failed';}).length,1);
});

test('a replacement installed by the closed listener retains its globals',function replacementDuringNotification(t){
    const global={console};
    let replacement;
    const stop=subscribeCoreClient(function replaceClosed(snapshot){
        if(snapshot.reason==='closed'&&!replacement){
            replacement=installCoreClient(global,{transport:transport()});
        }
    },{global});
    const client=installCoreClient(global,{transport:transport()});
    t.after(function cleanup(){stop();client.close();replacement?.close();});
    client.close();
    assert.ok(replacement);
    assert.equal(getInstalledCoreClient(global),replacement);
    assert.equal(global.__arcaneReceive,replacement.receive);
});

test('synchronous connection failure never announces the retired installation as installed',function failedInstallation(t){
    const global={console};
    const snapshots=[];
    const errors=[];
    const failure=new CoreError({code:'MOON_REPLAY_FAILED',message:'The host exited during replay.'});
    const stop=subscribeCoreClient(function capture(snapshot){snapshots.push(snapshot);},{global,emitCurrent:false});
    t.after(stop);
    const client=installCoreClient(global,{replayRuntimeState:true,onError(error){errors.push(error);},transport:{name:'fixture',send(){
        global.__arcaneTransportFailed(failure);
    }}});
    t.after(function closeClient(){client.close();});
    assert.equal(getInstalledCoreClient(global),null);
    assert.equal(snapshots.length,1);
    assert.equal(snapshots[0].reason,'transport-failed');
    assert.equal(snapshots[0].client,null);
    assert.equal(snapshots[0].previousClient,client);
    assert.equal(snapshots[0].error,failure);
    assert.deepEqual(errors,[failure]);
});

test('ESM observation replays a classic client installed before the shared event owner exists',async function earlyClassicInstallation(t){
    const document=new EventTarget();
    document.readyState='loading';
    const context=createContext({console,document,setTimeout,clearTimeout,arcaneAndroid:{postMessage(){}}});
    const source=await createCoreClassicSource({eventOwnerModuleURL:'/sdk/event-manager.mjs'});
    runInContext(source,context);
    const global=runInContext('globalThis',context);
    assert.equal(global.arcaneEvents,undefined);
    const client=getInstalledCoreClient(global);
    assert.ok(client);
    t.after(function closeClient(){client.close();});
    const snapshots=[];
    const stop=subscribeCoreClient(function capture(snapshot){snapshots.push(snapshot);},{global});
    t.after(stop);
    assert.equal(snapshots[0].reason,'current');
    assert.equal(snapshots[0].client,client);
    assert.equal(installCoreClient(global),client);
    client.close();
    assert.equal(snapshots[1].reason,'closed');
    assert.equal(snapshots[1].client,null);
    assert.equal(snapshots[1].previousClient,client);
    let retiredCurrent;
    const stopRetired=subscribeCoreClient(function afterRetirement(snapshot){retiredCurrent=snapshot;},{global});
    assert.deepEqual(retiredCurrent,{client:null,previousClient:null,reason:'current',error:null});
    stopRetired();
});
