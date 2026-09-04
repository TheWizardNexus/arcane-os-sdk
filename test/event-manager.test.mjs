import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    ARCANE_EVENT_AUTHORITY_BRAND,
    ARCANE_EVENT_AUTHORITY_PROTOCOL,
    ARCANE_EVENT_ERROR_CODES,
    ARCANE_EVENT_LISTENER_ERROR_EVENT,
    ARCANE_EVENT_OCCURRENCE_PROTOCOL,
    ARCANE_EVENT_SOURCE_DISPOSED_EVENT,
    ARCANE_EVENT_STACK_PROTOCOL,
    arcaneEvents,
    createArcaneEventSource,
    createEventManager,
    EventManager,
    isArcaneEventOccurrence,
    parseEventStack,
    PLAYBACK_RECORD_EVENT,
    projectArcaneDOMEvent,
    TIME_TRAVEL_SEEK_EVENT
} from '../src/event-manager.mjs';
import {createEventQueue} from '../src/event-queue.mjs';

function advancingClock(start='2026-08-24T02:00:00.000Z'){
    let milliseconds=Date.parse(start);
    return ()=>new Date(milliseconds++);
}

function installTestCustomEvent(){
    const existing=Object.getOwnPropertyDescriptor(globalThis,'CustomEvent');
    if(typeof globalThis.CustomEvent==='function')return function keepCustomEvent(){};
    class TestCustomEvent{
        constructor(type,{detail,bubbles=false,composed=false,cancelable=false}={}){
            this.type=type;
            this.detail=detail;
            this.bubbles=bubbles;
            this.composed=composed;
            this.cancelable=cancelable;
            this.defaultPrevented=false;
        }

        preventDefault(){
            if(this.cancelable)this.defaultPrevented=true;
        }
    }
    Object.defineProperty(globalThis,'CustomEvent',{
        value:TestCustomEvent,
        enumerable:false,
        configurable:true,
        writable:true
    });
    return function restoreCustomEvent(){
        if(existing)Object.defineProperty(globalThis,'CustomEvent',existing);
        else delete globalThis.CustomEvent;
    };
}

test('EventManager preserves synchronous event-pubsub behavior while recording is disabled',()=>{
    const manager=createEventManager({sessionId:'disabled-session'});
    const payload={identity:'preserved'};
    const delivered=[];
    const handler=value=>delivered.push(value);

    assert.ok(manager instanceof EventManager);
    assert.equal(manager.on('ready',handler),manager);
    assert.equal(manager.emit('ready',payload),manager);
    assert.equal(delivered[0],payload);
    assert.equal(manager.eventCount,0);
    assert.equal(manager.list.ready[0],handler);
    assert.equal(manager.off('ready',handler),manager);
    assert.equal(manager.reset(),manager);
});

test('time travel records timestamped causal event stacks and dispatch failures',()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'causal-session',
        clock:advancingClock(),
        now:(()=>{let value=10;return()=>value++;})()
    });
    const failure=new Error('subscriber failed');
    manager.on('parent',()=>manager.instrument('child',{ok:true},{
        source:'sdk',category:'operation',correlationId:'correlation-1'
    }));
    manager.on('failed',()=>{throw failure;});

    manager.instrument('parent',{password:'hidden',visible:'kept'},{source:'sdk'});
    assert.throws(()=>manager.emit('failed',{secretToken:'hidden'}),error=>error===failure);

    const [parent,child,failed]=manager.history;
    assert.equal(parent.protocol,ARCANE_EVENT_STACK_PROTOCOL);
    assert.equal(parent.sessionId,'causal-session');
    assert.equal(parent.sequence,1);
    assert.equal(parent.parentSequence,null);
    assert.equal(parent.depth,0);
    assert.equal(parent.source,'sdk');
    assert.equal(parent.payload[0].password,'hidden');
    assert.equal(parent.payload[0].visible,'kept');
    assert.equal(parent.status,'completed');
    assert.match(parent.timestamp,/^2026-08-24T02:00:00\.000Z$/u);
    assert.ok(parent.durationMs>=0);
    assert.match(parent.stack,/Arcane event source/u);

    assert.equal(child.sequence,2);
    assert.equal(child.parentSequence,1);
    assert.equal(child.depth,1);
    assert.equal(child.causationId,'causal-session:1');
    assert.equal(child.correlationId,'correlation-1');
    assert.equal(child.category,'operation');

    assert.equal(failed.sequence,3);
    assert.equal(failed.status,'failed');
    assert.equal(failed.error.$type,'error');
    assert.equal(failed.error.message,'subscriber failed');
    assert.equal(failed.payload[0].secretToken,'hidden');
    assert.equal(Object.isFrozen(failed),false);
    assert.equal(Object.isFrozen(failed.payload),false);
});

test('event stacks preserve cycles, export safely, and reject malformed imports',()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'export-session',
        clock:()=>new Date('2026-08-24T03:00:00.000Z'),
        now:()=>100
    });
    const cyclic={name:'root'};
    cyclic.self=cyclic;
    manager.emit('cyclic',cyclic);

    const text=manager.exportStack({space:0});
    const parsed=parseEventStack(text);
    assert.equal(parsed.protocol,ARCANE_EVENT_STACK_PROTOCOL);
    assert.equal(parsed.sessionId,'export-session');
    assert.equal(parsed.events.length,1);
    assert.equal(parsed.events[0].payload[0].self.$ref,'$[0]');
    assert.equal(Object.isFrozen(parsed),false);
    assert.equal(Object.isFrozen(parsed.events[0]),false);
    assert.throws(()=>parseEventStack('{'),/valid JSON/u);
    assert.throws(()=>parseEventStack({protocol:'wrong',events:[]}),/invalid/u);
    manager.emit('second');
    const reversed=JSON.parse(manager.exportStack({space:0}));
    reversed.events.reverse();
    assert.throws(()=>parseEventStack(reversed),/strictly increasing/u);
});

test('snapshots are pollution-safe and capture failures never suppress synchronous delivery',()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'snapshot-safety-session',
        clock:advancingClock('2026-08-24T03:30:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    const dangerous=JSON.parse(
        '{"__proto__":{"polluted":"proto"},"constructor":{"prototype":{"polluted":"ctor"}}}'
    );
    let delivered=null;
    manager.on('dangerous',value=>{delivered=value;});
    manager.emit('dangerous',dangerous);

    assert.equal(delivered,dangerous);
    assert.equal({}.polluted,undefined);
    assert.equal(Object.hasOwn(manager.history[0].payload[0],'__proto__'),true);
    assert.equal(manager.history[0].payload[0].__proto__.polluted,'proto');

    const snapshotFailure=new Error('proxy snapshot failed');
    const explosive=new Proxy({}, {
        ownKeys(){throw snapshotFailure;}
    });
    let explosiveDelivery=null;
    manager.on('explosive',value=>{explosiveDelivery=value;});
    assert.equal(manager.emit('explosive',explosive),manager);
    assert.equal(explosiveDelivery,explosive);
    assert.equal(manager.history[1].payload[0].$type,'snapshot-failed');
    assert.equal(manager.history[1].payload[0].message,'proxy snapshot failed');

    const listenerFailure=new Error('listener failure remains authoritative');
    manager.on('explosive-failure',value=>{
        assert.equal(value,explosive);
        throw listenerFailure;
    });
    assert.throws(()=>manager.emit('explosive-failure',explosive),error=>error===listenerFailure);
    assert.equal(manager.history[2].status,'failed');
    assert.equal(manager.history[2].payload[0].$type,'snapshot-failed');
    assert.equal(manager.history[2].error.message,'listener failure remains authoritative');

    const invalidDate=new Date(Number.NaN);
    let invalidDateDelivery=null;
    manager.on('invalid-date',value=>{invalidDateDelivery=value;});
    assert.equal(manager.emit('invalid-date',invalidDate),manager);
    assert.equal(invalidDateDelivery,invalidDate);
    assert.equal(manager.history[3].payload[0].$type,'snapshot-failed');
    assert.match(manager.history[3].payload[0].message,/Invalid time value/u);

    let accessorReads=0;
    const accessorSecret='special-object-accessor-secret';
    const unreadable=()=>{
        accessorReads+=1;
        return accessorSecret;
    };
    const date=new Date('2026-08-24T03:31:00.000Z');
    Object.defineProperty(date,'toISOString',{configurable:true,get:unreadable});
    const regexp=/arcane/giu;
    for(const property of ['source','flags']){
        Object.defineProperty(regexp,property,{configurable:true,get:unreadable});
    }
    const error=new Error();
    for(const property of ['name','message','stack']){
        Object.defineProperty(error,property,{configurable:true,get:unreadable});
    }
    const map=new Map([['safe','value']]);
    Object.defineProperty(map,'size',{configurable:true,get:unreadable});
    Object.defineProperty(map,Symbol.iterator,{configurable:true,get:unreadable});
    const set=new Set(['value']);
    Object.defineProperty(set,'size',{configurable:true,get:unreadable});
    Object.defineProperty(set,Symbol.iterator,{configurable:true,get:unreadable});
    const typedArray=new Uint8Array([1,2,3]);
    for(const property of ['length','buffer','constructor']){
        Object.defineProperty(typedArray,property,{configurable:true,get:unreadable});
    }
    const dataView=new DataView(new Uint8Array([4,5,6]).buffer);
    for(const property of ['buffer']){
        Object.defineProperty(dataView,property,{configurable:true,get:unreadable});
    }
    const callable=()=>{};
    Object.defineProperty(callable,'name',{configurable:true,get:unreadable});

    manager.emit('accessor-safe-special-objects',{
        date,regexp,error,map,set,typedArray,dataView,callable
    });
    const special=manager.history.at(-1).payload[0];
    assert.equal(accessorReads,4);
    assert.equal(special.date.value,'2026-08-24T03:31:00.000Z');
    assert.equal(special.regexp.source,'arcane');
    assert.equal(special.error.message,accessorSecret);
    assert.equal(special.error.stack,accessorSecret);
    assert.deepEqual(special.map.entries,[['safe','value']]);
    assert.deepEqual(special.set.values,['value']);
    assert.deepEqual(special.typedArray.values,[1,2,3]);
    assert.deepEqual(special.dataView.values,[4,5,6]);
    assert.equal(special.callable.name,accessorSecret);
    assert.equal(manager.exportStack({space:0}).includes(accessorSecret),true);

    const parsed=parseEventStack(manager.exportStack({space:0}));
    const importedDangerous=parsed.events[0].payload[0];
    assert.equal(Object.getPrototypeOf(importedDangerous),null);
    assert.equal(importedDangerous.__proto__.polluted,'proto');
    assert.equal({}.polluted,undefined);
});

test('recording preserves complete ordinary content including caller-authored fields',()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'privacy-session',
        clock:advancingClock('2026-08-24T03:40:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    manager.emit('private',{
        url:'https://arcane.test/path?token=visible-in-url',
        socket:'wss://arcane.test/session/socket-url-secret',
        inline:'data:text/plain,data-url-secret',
        key:'k',
        data:'typed text',
        detail:{value:'private detail'},
        apiKey:'api-secret',
        safe:'retained',
        error:new Error('failure at https://arcane.test/private')
    });
    const record=manager.history[0];
    assert.equal(typeof record.stack,'string');
    assert.equal(record.payload[0].url,'https://arcane.test/path?token=visible-in-url');
    assert.equal(record.payload[0].socket,'wss://arcane.test/session/socket-url-secret');
    assert.equal(record.payload[0].inline,'data:text/plain,data-url-secret');
    assert.equal(record.payload[0].key,'k');
    assert.equal(record.payload[0].data,'typed text');
    assert.deepEqual(record.payload[0].detail,{value:'private detail'});
    assert.equal(record.payload[0].apiKey,'api-secret');
    assert.equal(record.payload[0].safe,'retained');
    assert.equal(typeof record.payload[0].error.stack,'string');
    const exported=manager.exportStack({space:0});
    for(const content of [
        'visible-in-url','socket-url-secret','data-url-secret',
        'typed text','private detail'
    ]){
        assert.equal(exported.includes(content),true,`event stack omitted ${content}`);
    }
    assert.equal(exported.includes('api-secret'),true);

    const complete=createEventManager({
        timeTravel:true,
        sessionId:'complete-session',
        clock:advancingClock('2026-08-24T03:41:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    complete.emit('complete',[1,2,3,4],{
        nested:{deeper:{value:'retained'}},
        long:'1'.repeat(80)
    },'third payload entry');
    const captured=complete.history[0].payload;
    assert.deepEqual(captured[0],[1,2,3,4]);
    assert.equal(captured[1].nested.deeper.value,'retained');
    assert.equal(captured[1].long,'1'.repeat(80));
    assert.equal(captured[2],'third payload entry');
});

test('event stack export preserves complete special values and property names',()=>{
    const sharedPrefix='k'.repeat(64);
    const collisions={
        [`${sharedPrefix}-one`]:'first',
        [`${sharedPrefix}-two`]:'second',
        extra1:1,
        extra2:2,
        extra3:3,
        extra4:4,
        extra5:5
    };
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'complete-values-session',
        clock:advancingClock('2026-08-24T03:45:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    manager.emit('special-values',{
        date:new Date('2026-08-24T03:45:00.000Z'),
        big:BigInt(`9${'8'.repeat(200)}`),
        error:new Error('bounded diagnostic error'),
        typed:new Uint16Array([1,2,3,4,5,6,7]),
        collisions
    });

    const document=parseEventStack(manager.exportStack({space:0}));
    const captured=document.events[0].payload[0];
    assert.equal(captured.date.value,'2026-08-24T03:45:00.000Z');
    assert.equal(captured.big.value,`9${'8'.repeat(200)}`);
    assert.equal(captured.error.$type,'error');
    assert.equal(captured.typed.$type,'Uint16Array');
    assert.deepEqual(captured.typed.values,[1,2,3,4,5,6,7]);
    assert.equal(captured.collisions[`${sharedPrefix}-one`],'first');
    assert.equal(captured.collisions[`${sharedPrefix}-two`],'second');
});

test('event history remains complete and never disables live capture',()=>{
    const root={
        nodeType:9,
        location:{href:'https://arcane.test/complete-history'},
        title:'Complete history fixture',
        documentElement:null,
        addEventListener(){},
        removeEventListener(){},
        querySelectorAll(){return [];}
    };
    class Observer{
        static latest=null;
        constructor(){this.disconnected=false;Observer.latest=this;}
        observe(){}
        disconnect(){this.disconnected=true;}
    }
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'complete-history-session',
        clock:advancingClock('2026-08-24T03:50:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    const delivered=[];
    for(const type of ['one','two','three','four'])manager.on(type,()=>delivered.push(type));
    manager.emit('one');
    manager.emit('two');
    manager.emit('three');
    manager.emit('four');

    assert.deepEqual(delivered,['one','two','three','four']);
    assert.equal(manager.timeTravelEnabled,true);
    assert.equal(manager.eventCount,4);
    assert.deepEqual(manager.history.map(record=>record.type),['one','two','three','four']);

    const exported=manager.exportStack({space:0});
    assert.deepEqual(
        parseEventStack(exported).events.map(record=>record.type),
        ['one','two','three','four']
    );

    const instrumentation=manager.attachDOM(root,{
        MutationObserver:Observer,
        eventTypes:[],
        observeOpenShadowRoots:false
    });
    assert.equal(instrumentation.active,true);
    assert.equal(Observer.latest.disconnected,false);
    manager.disableTimeTravel();
    assert.equal(instrumentation.active,false);
    assert.equal(Observer.latest.disconnected,true);
});

test('event stack imports strictly validate document and record contracts',()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'strict-session',
        clock:advancingClock('2026-08-24T03:55:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    manager.instrument('strict',{ok:true},{source:'sdk',category:'audit'});
    const valid=JSON.parse(manager.exportStack({space:0}));
    assert.equal(parseEventStack(valid).events[0].type,'strict');

    const cases=[
        ['document extra field',document=>{document.extra=true;}],
        ['record extra field',document=>{document.events[0].extra=true;}],
        ['protocol',document=>{document.events[0].protocol='wrong';}],
        ['session',document=>{document.events[0].sessionId='wrong';}],
        ['id',document=>{document.events[0].id='wrong';}],
        ['parent',document=>{document.events[0].parentSequence=1;}],
        ['depth',document=>{document.events[0].depth=1;}],
        ['timestamp',document=>{document.events[0].timestamp='2026-08-24';}],
        ['monotonic timing',document=>{document.events[0].monotonicMs=-1;}],
        ['category',document=>{document.events[0].category=7;}],
        ['source',document=>{document.events[0].source='';}],
        ['type',document=>{document.events[0].type=7;}],
        ['status',document=>{document.events[0].status='unknown';}],
        ['payload',document=>{document.events[0].payload={};}],
        ['metadata',document=>{document.events[0].metadata=[];}],
        ['completion timing',document=>{
            document.events[0].completedAt='2026-08-24T03:54:59.000Z';
        }],
        ['completed error',document=>{document.events[0].error={message:'unexpected'};}],
        ['failed error',document=>{
            document.events[0].status='failed';
            document.events[0].error=null;
        }]
    ];
    for(const [name,mutate] of cases){
        const malformed=JSON.parse(JSON.stringify(valid));
        mutate(malformed);
        assert.throws(()=>parseEventStack(malformed),/invalid/u,name);
    }
});

test('seek and playback review or redispatch events without recursively recording them',async()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'playback-session',
        clock:advancingClock('2026-08-24T04:00:00.000Z'),
        now:(()=>{let value=0;return()=>value++;})()
    });
    const live=[];
    const reviewed=[];
    const seeks=[];
    manager.on('alpha',payload=>live.push(payload));
    manager.on('beta',payload=>live.push(payload));
    manager.on(PLAYBACK_RECORD_EVENT,record=>reviewed.push(record.type));
    manager.on(TIME_TRAVEL_SEEK_EVENT,event=>seeks.push(event.sequence));
    manager.emit('alpha',{value:1});
    manager.emit('beta',{value:2});
    const recordedCount=manager.eventCount;

    assert.equal(manager.seek(1).type,'alpha');
    assert.deepEqual(seeks,[1]);
    const review=await manager.playback({mode:'review',speed:0});
    assert.deepEqual(reviewed,['alpha','beta']);
    assert.equal(review.delivered,2);
    assert.equal(manager.eventCount,recordedCount);

    live.length=0;
    const redispatch=await manager.playback({mode:'events',speed:0});
    assert.deepEqual(live,[{value:1},{value:2}]);
    assert.equal(redispatch.delivered,2);
    assert.equal(manager.eventCount,recordedCount);
    assert.equal(manager.replaying,false);
});

test('playback honors an already-aborted signal and restores its lifecycle flag',async()=>{
    const manager=createEventManager({
        timeTravel:true,
        sessionId:'abort-session',
        clock:()=>new Date('2026-08-24T05:00:00.000Z')
    });
    manager.emit('one');
    const controller=new AbortController();
    controller.abort(new Error('stop playback'));
    await assert.rejects(manager.playback({signal:controller.signal}),/stop playback/u);
    assert.equal(manager.replaying,false);
});

test('SDK event queues mirror one normalized event through the central manager',async()=>{
    const delivered=[];
    const handler=event=>delivered.push(event);
    arcaneEvents.on('sdk.example',handler);
    try{
        const outer=createEventQueue(null);
        const inner=createEventQueue(event=>outer.send(event));
        const event={type:'sdk.example',message:'central instrumentation'};
        await inner.send(event);
        await outer.drain();
        assert.equal(delivered.length,1);
        assert.equal(delivered[0],event);
        assert.equal(Object.isFrozen(delivered[0]),false);
    }finally{
        arcaneEvents.off('sdk.example',handler);
    }
});

test('arcaneEvents is one mutable realm authority across duplicate module URLs',async()=>{
    const globalDescriptor=Object.getOwnPropertyDescriptor(globalThis,'arcaneEvents');
    const brandDescriptor=Object.getOwnPropertyDescriptor(
        arcaneEvents,
        ARCANE_EVENT_AUTHORITY_BRAND
    );
    assert.equal(globalDescriptor?.value,arcaneEvents);
    assert.equal(globalDescriptor?.enumerable,false);
    assert.equal(globalDescriptor?.writable,true);
    assert.equal(globalDescriptor?.configurable,true);
    assert.deepEqual(brandDescriptor,{
        value:ARCANE_EVENT_AUTHORITY_PROTOCOL,
        enumerable:true,
        writable:true,
        configurable:true
    });

    const duplicate=await import('../src/event-manager.mjs?duplicate-authority-contract');
    const packageRoot=await import('../src/index.mjs?event-authority-root-contract');
    assert.equal(duplicate.arcaneEvents,arcaneEvents);
    assert.equal(packageRoot.arcaneEvents,arcaneEvents);
    assert.equal(packageRoot.createArcaneEventSource,createArcaneEventSource);
    const occurrences=[];
    const unsubscribe=arcaneEvents.subscribe(
        'sdk.test.duplicate-authority',
        function observeDuplicateAuthority(occurrence){occurrences.push(occurrence);}
    );
    const source=duplicate.createArcaneEventSource(
        {},
        {
            source:'sdk.test.duplicate-authority',
            eventTypes:['sdk.test.duplicate-authority']
        }
    );
    try{
        const publication=source.dispatch(
            'sdk.test.duplicate-authority',
            {compatibility:true},
            {publicDetail:{visible:true}}
        );
        assert.equal(occurrences.length,1);
        assert.equal(occurrences[0],publication.occurrence);
        assert.equal(publication.occurrence.protocol,ARCANE_EVENT_OCCURRENCE_PROTOCOL);
        assert.match(publication.occurrence.occurrenceId,/^arcane-event-[0-9a-z]+$/u);
        assert.match(publication.occurrence.instanceId,/^arcane-source-[0-9a-z]+$/u);
        assert.equal(isArcaneEventOccurrence(publication.occurrence),true);
        assert.equal(duplicate.isArcaneEventOccurrence(publication.occurrence),true);
        assert.equal(Object.isFrozen(publication.occurrence),false);
        assert.equal(unsubscribe.dispose,unsubscribe);
    }finally{
        unsubscribe();
        source.dispose();
    }
});

test('source dispatch preserves canonical order and complete rich local compatibility',()=>{
    const type='sdk.test.source-privacy';
    const order=[];
    const central=[];
    const scoped=[];
    const host={kind:'host-record'};
    const thrown=new Error('owner-local only');
    const richCompatibility={host,thrown,secretMarker:'compatibility-only-marker'};
    const publicDetail={availability:{state:'ready'},count:1};
    const direct=[];
    const owner={};
    let sourceListenerThis=null;
    const source=createArcaneEventSource(owner,{
        source:'sdk.test.source-privacy',
        eventTypes:[type]
    });
    const unsubscribeCentralOne=arcaneEvents.subscribe(
        type,
        function observeCanonicalFirst(occurrence){
            order.push('central-one');
            central.push(occurrence);
        }
    );
    const unsubscribeCentralTwo=arcaneEvents.subscribe(
        type,
        function observeCanonicalSecond(){order.push('central-two');}
    );
    const unsubscribeSourceOne=source.on(type,function observeCompatibilityFirst(event){
        sourceListenerThis=this;
        order.push('source-one');
        scoped.push(event);
    });
    const unsubscribeSourceTwo=source.on(type,function observeCompatibilitySecond(){
        order.push('source-two');
    });
    function observeDirectPayload(value){direct.push(value);}
    arcaneEvents.on(type,observeDirectPayload);
    arcaneEvents.clearHistory();
    arcaneEvents.enableTimeTravel();
    try{
        const publication=source.dispatch(type,richCompatibility,{
            operationId:'operation-source-privacy',
            publicDetail
        });
        publicDetail.availability.state='changed-after-dispatch';

        assert.deepEqual(order,['central-one','central-two','source-one','source-two']);
        assert.equal(central[0],publication.occurrence);
        assert.equal(scoped[0].type,type);
        assert.equal(sourceListenerThis,owner);
        assert.equal(scoped[0].target,owner);
        assert.equal(scoped[0].currentTarget,owner);
        assert.notEqual(scoped[0].detail,richCompatibility);
        assert.equal(Object.isFrozen(scoped[0].detail),false);
        assert.equal(scoped[0].detail.host,host);
        assert.equal(scoped[0].detail.thrown,thrown);
        assert.equal(Object.isFrozen(host),false);
        assert.equal(publication.occurrence.detail.availability.state,'ready');
        assert.equal(Object.isFrozen(publication.occurrence.detail),false);
        assert.equal(Object.isFrozen(publication.occurrence.detail.availability),false);
        assert.equal(publication.occurrence.detail.secretMarker,'compatibility-only-marker');
        assert.equal(publication.occurrence.detail.thrown.message,'owner-local only');
        assert.equal(publication.occurrence.operationId,'operation-source-privacy');
        assert.deepEqual(direct,[]);
        assert.match(
            JSON.stringify(arcaneEvents.history),
            /compatibility-only-marker|owner-local only/u
        );
    }finally{
        arcaneEvents.disableTimeTravel();
        arcaneEvents.clearHistory();
        arcaneEvents.off(type,observeDirectPayload);
        unsubscribeCentralOne();
        unsubscribeCentralTwo();
        unsubscribeSourceOne();
        unsubscribeSourceTwo();
        source.dispose();
    }
});

test('source dispatch exposes a mutable compatibility detail copy',()=>{
    const type='sdk.test.source-mutable-compatibility';
    const detail={revision:7};
    const source=createArcaneEventSource({}, {
        source:'sdk.test.source-mutable-compatibility',
        eventTypes:[type]
    });
    let delivered=null;
    const unsubscribe=source.on(type,function observeMutableCompatibility(event){
        delivered=event.detail;
    });
    try{
        source.dispatch(type,detail,{publicDetail:{revision:detail.revision}});
        assert.notEqual(delivered,detail);
        assert.deepEqual(delivered,detail);
        assert.equal(Object.isFrozen(delivered),false);
    }finally{
        unsubscribe();
        source.dispose();
    }
});

test('one owner has one active source and may register again after disposal',()=>{
    const owner={};
    const type='sdk.test.source-owner-lifecycle';
    const first=createArcaneEventSource(owner,{
        source:'sdk.test.source-owner-lifecycle',
        eventTypes:[type]
    });
    const firstInstanceId=first.instanceId;
    try{
        assert.throws(
            function rejectSecondActiveSource(){
                createArcaneEventSource(owner,{
                    source:'sdk.test.source-owner-lifecycle-duplicate',
                    eventTypes:[type]
                });
            },
            function isActiveSourceCollision(error){
                return error?.code==='ARCANE_EVENT_SOURCE_ALREADY_REGISTERED';
            }
        );
    }finally{
        first.dispose();
    }

    const replacement=createArcaneEventSource(owner,{
        source:'sdk.test.source-owner-lifecycle',
        eventTypes:[type]
    });
    try{
        assert.notEqual(replacement.instanceId,firstInstanceId);
        const publication=replacement.dispatch(
            type,
            {generation:'replacement'},
            {publicDetail:{generation:'replacement'}}
        );
        assert.equal(publication.accepted,true);
        assert.equal(publication.occurrence.instanceId,replacement.instanceId);
    }finally{
        replacement.dispose();
    }
});

test('canonical cancellation and one-way DOM projection share one occurrence',()=>{
    const restoreCustomEvent=installTestCustomEvent();
    const cancelType='sdk.test.cancellation';
    const projectType='sdk.test.projection';
    const source=createArcaneEventSource({}, {
        source:'sdk.test.cancellation',
        eventTypes:[cancelType,projectType]
    });
    const delivered=[];
    const unsubscribeCancel=arcaneEvents.subscribe(
        cancelType,
        function cancelCanonicalOccurrence(occurrence){
            delivered.push('central-cancel');
            occurrence.preventDefault();
        }
    );
    const unsubscribeFollowing=arcaneEvents.subscribe(
        cancelType,
        function observeAfterCancellation(occurrence){
            delivered.push(`central-following:${String(occurrence.defaultPrevented)}`);
        }
    );
    const unsubscribeScoped=source.on(cancelType,function observeScopedCancellation(event){
        delivered.push(`source:${String(event.defaultPrevented)}`);
    });
    try{
        const cancelled=source.dispatch(
            cancelType,
            {message:'cancel me'},
            {publicDetail:{status:'requested'},cancelable:true}
        );
        assert.equal(cancelled.accepted,false);
        assert.equal(cancelled.occurrence.defaultPrevented,true);
        assert.deepEqual(delivered,[
            'central-cancel',
            'central-following:true',
            'source:true'
        ]);

        let projected=null;
        const target={
            dispatchEvent(event){
                projected=event;
                event.preventDefault();
                return false;
            }
        };
        const publication=source.dispatch(
            projectType,
            {message:'projected'},
            {
                operationId:'operation-projection',
                publicDetail:{status:'ready'},
                cancelable:true
            }
        );
        assert.equal(projectArcaneDOMEvent(target,publication.occurrence),false);
        assert.equal(publication.occurrence.defaultPrevented,true);
        assert.equal(projected.detail.message,'projected');
        assert.equal(projected.detail.occurrenceId,publication.occurrence.occurrenceId);
        assert.equal(projected.detail.arcaneSource,source.source);
        assert.equal(projected.detail.source,source.source);
        assert.equal(projected.detail.instanceId,source.instanceId);
        assert.equal(projected.detail.operationId,'operation-projection');
        assert.equal(Object.isFrozen(projected.detail),false);

        let skipped=0;
        assert.equal(projectArcaneDOMEvent({dispatchEvent(){skipped+=1;}},cancelled.occurrence),false);
        assert.equal(skipped,0);

        const collision=source.dispatch(
            projectType,
            {occurrenceId:'caller-owned-id'},
            {publicDetail:{},cancelable:false}
        );
        assert.throws(
            function rejectProjectionCollision(){
                projectArcaneDOMEvent(target,collision.occurrence);
            },
            function isProjectionCollision(error){
                return error?.code==='ARCANE_EVENT_DOM_DETAIL_COLLISION';
            }
        );

        const compatibilitySource=source.dispatch(
            projectType,
            {message:'source payload',source:'picker'},
            {publicDetail:{},cancelable:false}
        );
        const acceptingTarget={dispatchEvent(event){projected=event;return true;}};
        assert.equal(projectArcaneDOMEvent(acceptingTarget,compatibilitySource.occurrence),true);
        assert.equal(projected.detail.source,'picker');
        assert.equal(projected.detail.arcaneSource,source.source);
    }finally{
        unsubscribeCancel();
        unsubscribeFollowing();
        unsubscribeScoped();
        source.dispose();
        restoreCustomEvent();
    }
});

test('subscriptions abort, unsubscribe, reenter, and dispose without corrupting delivery',()=>{
    const type='sdk.test.subscription-lifecycle';
    const source=createArcaneEventSource({}, {
        source:'sdk.test.subscription-lifecycle',
        eventTypes:[type]
    });
    const calls=[];
    const alreadyAborted=new AbortController();
    alreadyAborted.abort();
    const absent=arcaneEvents.subscribe(
        type,
        function shouldNeverInstall(){calls.push('aborted');},
        {signal:alreadyAborted.signal}
    );
    assert.equal(absent.dispose,absent);

    let unsubscribeSelf;
    unsubscribeSelf=arcaneEvents.subscribe(type,function removeCurrentDuringDispatch(){
        calls.push('self');
        unsubscribeSelf();
    });
    const unsubscribeFollower=arcaneEvents.subscribe(type,function retainFollowingListener(){
        calls.push('follower');
    });
    let onceCalls=0;
    const unsubscribeOnce=arcaneEvents.subscribe(type,function reenterOnceListener(){
        onceCalls+=1;
        if(onceCalls===1)source.dispatch(type,{nested:true});
    },{once:true});
    const sourceAbort=new AbortController();
    source.on(type,function shouldBeRemovedByAbort(){calls.push('source-aborted');},{
        signal:sourceAbort.signal
    });
    sourceAbort.abort();
    try{
        source.dispatch(type,{outer:true});
        assert.deepEqual(calls,['self','follower','follower']);
        assert.equal(onceCalls,1);
        assert.equal(unsubscribeSelf(),false);
        assert.equal(unsubscribeSelf.dispose,unsubscribeSelf);

        arcaneEvents.off(type);
        arcaneEvents.reset();
        source.dispatch(type,{afterReset:true});
        assert.deepEqual(calls,['self','follower','follower','follower']);

        let reentrantDispose;
        source.on(
            ARCANE_EVENT_SOURCE_DISPOSED_EVENT,
            function disposeAgainFromFinalOccurrence(){reentrantDispose=source.dispose();}
        );
        assert.equal(source.dispose(),true);
        assert.equal(reentrantDispose,false);
        assert.equal(source.dispose(),false);
        assert.throws(
            function rejectDisposedDispatch(){source.dispatch(type,{});},
            function isDisposed(error){return error?.code==='ARCANE_EVENT_SOURCE_DISPOSED';}
        );
    }finally{
        absent();
        unsubscribeSelf();
        unsubscribeFollower();
        unsubscribeOnce();
        if(!source.disposed)source.dispose();
    }
});

test('EventTarget adapters deduplicate listeners and preserve declared cancellation',()=>{
    const centralType='sdk.test.event-target-adapter';
    const sourceType='sdk.test.source-event-target';
    const sourceOwner={kind:'source-event-target-owner'};
    const source=createArcaneEventSource(sourceOwner, {
        source:'sdk.test.source-event-target',
        eventTypes:[centralType,sourceType]
    });
    const centralSeen=[];
    function centralListener(occurrence){
        centralSeen.push(occurrence.defaultPrevented);
        occurrence.preventDefault();
    }
    arcaneEvents.addEventListener(centralType,centralListener);
    arcaneEvents.addEventListener(centralType,centralListener);
    arcaneEvents.addEventListener(centralType,centralListener,true);
    try{
        assert.doesNotThrow(function ignoreInvalidCentralListeners(){
            arcaneEvents.addEventListener(centralType,null);
            arcaneEvents.addEventListener(centralType,{});
            arcaneEvents.removeEventListener(centralType,null);
            arcaneEvents.removeEventListener(centralType,{});
        });
        assert.equal(
            source.dispatch(centralType,{}, {publicDetail:{},cancelable:true}).accepted,
            false
        );
        assert.deepEqual(centralSeen,[false,true]);
        arcaneEvents.removeEventListener(centralType,centralListener);
        assert.equal(
            source.dispatch(centralType,{}, {publicDetail:{},cancelable:true}).accepted,
            false
        );
        assert.deepEqual(centralSeen,[false,true,false]);

        let onceCalls=0;
        function onceListener(){onceCalls+=1;}
        arcaneEvents.addEventListener(centralType,onceListener,{once:true});
        source.dispatch(centralType,{}, {publicDetail:{},cancelable:true});
        arcaneEvents.addEventListener(centralType,onceListener,{once:true});
        source.dispatch(centralType,{}, {publicDetail:{},cancelable:true});
        assert.equal(onceCalls,2);

        assert.doesNotThrow(function ignoreInvalidSourceListeners(){
            source.addEventListener(sourceType,null);
            source.addEventListener(sourceType,7);
            source.removeEventListener(sourceType,null);
            source.removeEventListener(sourceType,7);
        });
        let sourceEvent=null;
        let sourceListenerThis=null;
        source.addEventListener(sourceType,function cancelSourceEvent(event){
            sourceListenerThis=this;
            sourceEvent=event;
            event.preventDefault();
        });
        const sourceInput={
            type:sourceType,
            detail:{value:42},
            cancelable:true,
            defaultPrevented:false,
            preventDefault(){this.defaultPrevented=true;}
        };
        assert.equal(source.dispatchEvent(sourceInput),false);
        assert.equal(sourceInput.defaultPrevented,true);
        assert.equal(sourceEvent.detail.value,42);
        assert.equal(sourceListenerThis,sourceOwner);
        assert.equal(sourceEvent.target,sourceOwner);
        assert.equal(sourceEvent.currentTarget,sourceOwner);
        assert.throws(
            function rejectUndeclaredSourceEvent(){
                source.dispatchEvent({type:'sdk.test.undeclared',detail:{}});
            },
            function isUndeclared(error){
                return error?.code==='ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED';
            }
        );
    }finally{
        arcaneEvents.removeEventListener(centralType,centralListener,true);
        source.dispose();
    }
});

test('listener failures are observational, complete, and nonrecursive',()=>{
    const type='sdk.test.listener-failure';
    const rawFailure=new Error('private listener failure');
    const recursiveFailure=new Error('listener-error observer failed');
    const order=[];
    const errorOccurrences=[];
    const ownerFailures=[];
    const reports=[];
    let failedOccurrenceId=null;
    const reportErrorDescriptor=Object.getOwnPropertyDescriptor(globalThis,'reportError');
    Object.defineProperty(globalThis,'reportError',{
        value:function captureReportedError(error){
            reports.push(error);
            order.push(error===rawFailure?'report-domain':'report-listener-error');
        },
        enumerable:false,
        configurable:true,
        writable:true
    });
    const source=createArcaneEventSource({}, {
        source:'sdk.test.listener-failure',
        eventTypes:[type],
        onListenerError(error,errorOccurrence){
            ownerFailures.push([error,errorOccurrence]);
            order.push('owner-callback');
        }
    });
    const unsubscribeFailure=arcaneEvents.subscribe(type,function failCanonicalListener(occurrence){
        failedOccurrenceId=occurrence.occurrenceId;
        order.push('domain-failure');
        throw rawFailure;
    });
    const unsubscribeFollowing=arcaneEvents.subscribe(type,function observeCommittedDomain(){
        order.push('domain-following');
    });
    const unsubscribeError=arcaneEvents.subscribe(
        ARCANE_EVENT_LISTENER_ERROR_EVENT,
        function observeListenerError(occurrence){
            errorOccurrences.push(occurrence);
            order.push('listener-error-occurrence');
        }
    );
    const unsubscribeRecursive=arcaneEvents.subscribe(
        ARCANE_EVENT_LISTENER_ERROR_EVENT,
        function failListenerErrorObserver(){throw recursiveFailure;}
    );
    try{
        const publication=source.dispatch(type,{privateValue:rawFailure},{
            operationId:'operation-listener-failure',
            publicDetail:{status:'committed'}
        });
        assert.equal(publication.accepted,true);
        assert.equal(errorOccurrences.length,1);
        assert.equal(ownerFailures.length,1);
        assert.equal(ownerFailures[0][0],rawFailure);
        assert.equal(ownerFailures[0][1],errorOccurrences[0]);
        assert.equal(errorOccurrences[0].type,ARCANE_EVENT_LISTENER_ERROR_EVENT);
        assert.equal(errorOccurrences[0].detail.code,'ARCANE_EVENT_LISTENER_CALLBACK_FAILED');
        assert.equal(errorOccurrences[0].detail.reason,'listener-threw');
        assert.equal(errorOccurrences[0].detail.eventType,type);
        assert.equal(errorOccurrences[0].detail.occurrenceId,failedOccurrenceId);
        assert.equal(errorOccurrences[0].detail.source,source.source);
        assert.equal(errorOccurrences[0].detail.instanceId,source.instanceId);
        assert.equal(errorOccurrences[0].detail.operationId,'operation-listener-failure');
        assert.equal(errorOccurrences[0].detail.error.message,'private listener failure');
        assert.equal(Object.isFrozen(errorOccurrences[0].detail),false);
        assert.match(JSON.stringify(errorOccurrences[0]),/private listener failure/u);
        assert.deepEqual(reports,[recursiveFailure,rawFailure]);
        assert.deepEqual(order,[
            'domain-failure',
            'listener-error-occurrence',
            'report-listener-error',
            'report-domain',
            'owner-callback',
            'domain-following'
        ]);
    }finally{
        unsubscribeFailure();
        unsubscribeFollowing();
        unsubscribeError();
        unsubscribeRecursive();
        source.dispose();
        if(reportErrorDescriptor){
            Object.defineProperty(globalThis,'reportError',reportErrorDescriptor);
        }else{
            delete globalThis.reportError;
        }
    }
});

test('canonical subscribe is exact typed and rejects a malformed wildcard name',()=>{
    assert.throws(
        function rejectCanonicalWildcard(){arcaneEvents.subscribe('*',function noWildcard(){});},
        function isInvalidSubscriptionType(error){
            return error?.code===ARCANE_EVENT_ERROR_CODES.ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID;
        }
    );
});
