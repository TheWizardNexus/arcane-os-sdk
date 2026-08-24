import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    ARCANE_EVENT_STACK_PROTOCOL,
    arcaneEvents,
    createEventManager,
    EventManager,
    parseEventStack,
    PLAYBACK_RECORD_EVENT,
    TIME_TRAVEL_OVERFLOW_EVENT,
    TIME_TRAVEL_SEEK_EVENT
} from '../src/event-manager.mjs';
import {createEventQueue} from '../src/event-queue.mjs';

function advancingClock(start='2026-08-24T02:00:00.000Z'){
    let milliseconds=Date.parse(start);
    return ()=>new Date(milliseconds++);
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
        captureStacks:true,
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
    assert.equal(parent.payload[0].password,'[REDACTED]');
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
    assert.equal(failed.payload[0].secretToken,'[REDACTED]');
    assert.ok(Object.isFrozen(failed));
    assert.ok(Object.isFrozen(failed.payload));
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
    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.events[0]));
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
    for(const property of ['length','buffer','byteLength','byteOffset','constructor']){
        Object.defineProperty(typedArray,property,{configurable:true,get:unreadable});
    }
    const dataView=new DataView(new Uint8Array([4,5,6]).buffer);
    for(const property of ['buffer','byteLength','byteOffset']){
        Object.defineProperty(dataView,property,{configurable:true,get:unreadable});
    }
    const callable=()=>{};
    Object.defineProperty(callable,'name',{configurable:true,get:unreadable});

    manager.emit('accessor-safe-special-objects',{
        date,regexp,error,map,set,typedArray,dataView,callable
    });
    const special=manager.history.at(-1).payload[0];
    assert.equal(accessorReads,0);
    assert.equal(special.date.value,'2026-08-24T03:31:00.000Z');
    assert.equal(special.regexp.source,'arcane');
    assert.equal(special.error.message,'[UNREADABLE]');
    assert.deepEqual(special.map.entries,[['safe','value']]);
    assert.deepEqual(special.set.values,['value']);
    assert.deepEqual(special.typedArray.values,[1,2,3]);
    assert.deepEqual(special.dataView.values,[4,5,6]);
    assert.equal(special.callable.name,'[UNREADABLE]');
    assert.equal(manager.exportStack({space:0}).includes(accessorSecret),false);

    const parsed=parseEventStack(manager.exportStack({space:0}));
    const importedDangerous=parsed.events[0].payload[0];
    assert.equal(Object.getPrototypeOf(importedDangerous),null);
    assert.equal(importedDangerous.__proto__.polluted,'proto');
    assert.equal({}.polluted,undefined);
});

test('recording defaults protect stacks, URLs, keys, data, and detail while bounding snapshots',()=>{
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
    assert.equal(record.stack,null);
    assert.equal(record.payload[0].url,'[REDACTED URL]');
    assert.equal(record.payload[0].socket,'[REDACTED URL]');
    assert.equal(record.payload[0].inline,'[REDACTED URL]');
    assert.equal(record.payload[0].key,'[REDACTED]');
    assert.equal(record.payload[0].data,'[REDACTED]');
    assert.equal(record.payload[0].detail,'[REDACTED]');
    assert.equal(record.payload[0].apiKey,'[REDACTED]');
    assert.equal(record.payload[0].safe,'retained');
    assert.equal(record.payload[0].error.stack,null);
    const exported=manager.exportStack({space:0});
    for(const secret of [
        'visible-in-url','socket-url-secret','data-url-secret',
        'typed text','private detail','api-secret'
    ]){
        assert.equal(exported.includes(secret),false,`event stack leaked ${secret}`);
    }

    const bounded=createEventManager({
        timeTravel:true,
        sessionId:'bounded-session',
        maxSnapshotDepth:2,
        maxSnapshotEntries:2,
        maxSnapshotStringLength:64,
        clock:advancingClock('2026-08-24T03:41:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    bounded.emit('bounded',[1,2,3,4],{
        nested:{deeper:{value:'not retained'}},
        long:'1'.repeat(80)
    },'third payload entry');
    const captured=bounded.history[0].payload;
    assert.equal(captured[0].length,3);
    assert.equal(captured[0].at(-1).$type,'entries-truncated');
    assert.equal(captured[1].nested.$type,'depth-limit');
    assert.equal(captured[1].long,`${'1'.repeat(64)}…`);
    assert.equal(captured.at(-1).$type,'entries-truncated');
});

test('minimum snapshot string limit exports special values that import under the same limit',()=>{
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
        sessionId:'minimum-string-session',
        maxSnapshotEntries:6,
        maxSnapshotStringLength:64,
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

    const document=parseEventStack(manager.exportStack({space:0}),{
        maxSnapshotEntries:6,
        maxSnapshotStringLength:64
    });
    const captured=document.events[0].payload[0];
    assert.equal(captured.date.value,'2026-08-24T03:45:00.000Z');
    assert.equal(captured.big.value.length,65);
    assert.equal(captured.big.value.endsWith('…'),true);
    assert.equal(captured.error.$type,'error');
    assert.equal(captured.typed.$type,'Uint16Array');
    assert.ok(Object.hasOwn(captured.collisions,'$arcaneCollision:1'));
    assert.ok(Object.hasOwn(captured.collisions,'$arcaneTruncated'));
    assert.throws(
        ()=>createEventManager({maxSnapshotStringLength:63}),
        /at least 64/u
    );
    assert.throws(
        ()=>parseEventStack(manager.exportStack({space:0}),{
            maxSnapshotStringLength:63
        }),
        /at least 64/u
    );
});

test('history overflow is bounded, visible, disables capture, and never drops live delivery',()=>{
    const root={
        nodeType:9,
        location:{href:'https://arcane.test/private?token=not-retained'},
        title:'Overflow fixture',
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
        sessionId:'overflow-session',
        maxEvents:3,
        clock:advancingClock('2026-08-24T03:50:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})(),
        dom:{
            root,
            MutationObserver:Observer,
            eventTypes:[],
            observeOpenShadowRoots:false
        }
    });
    const delivered=[];
    for(const type of ['one','two','three','four'])manager.on(type,()=>delivered.push(type));
    manager.emit('one');
    manager.emit('two');
    manager.emit('three');
    manager.emit('four');

    assert.deepEqual(delivered,['one','two','three','four']);
    assert.equal(manager.overflowed,true);
    assert.equal(manager.timeTravelEnabled,false);
    assert.equal(manager.eventCount,4);
    assert.equal(manager.history.at(-1).type,TIME_TRAVEL_OVERFLOW_EVENT);
    assert.equal(manager.history.some(record=>['three','four'].includes(record.type)),false);
    assert.equal(manager.history.at(-1).payload[0].maxEvents,3);
    assert.equal(manager.history.at(-1).payload[0].retainedEvents,3);
    assert.equal(manager.domInstrumentation.active,false);
    assert.equal(Observer.latest.disconnected,true);
    assert.equal(
        manager.history.some(record=>record.type==='arcane.dom.observation.stopped'),
        false
    );
    assert.throws(()=>manager.enableTimeTravel(),/Clear the overflowed event history/u);

    const exported=manager.exportStack({space:0});
    assert.equal(parseEventStack(exported,{maxEvents:3}).events.length,4);
    assert.equal(parseEventStack(exported,{maxEvents:10}).events.length,4);
    const forgedEarly=JSON.parse(exported);
    forgedEarly.events=[forgedEarly.events.at(-1)];
    forgedEarly.events[0].sequence=1;
    forgedEarly.events[0].id='overflow-session:1';
    assert.throws(
        ()=>parseEventStack(forgedEarly,{maxEvents:3}),
        /overflow record is invalid/u
    );
    const nonterminal=JSON.parse(exported);
    const [overflow]=nonterminal.events.splice(-1,1);
    nonterminal.events.splice(1,0,overflow);
    nonterminal.events.forEach((record,index)=>{
        record.sequence=index+1;
        record.id=`overflow-session:${String(index+1)}`;
    });
    assert.throws(
        ()=>parseEventStack(nonterminal,{maxEvents:3}),
        /overflow history is invalid/u
    );

    const attachAtLimit=createEventManager({
        timeTravel:true,
        sessionId:'attach-at-limit-session',
        maxEvents:1,
        clock:advancingClock('2026-08-24T03:51:00.000Z'),
        now:(()=>{let value=1;return()=>value++;})()
    });
    attachAtLimit.emit('fills-history');
    const lateInstrumentation=attachAtLimit.attachDOM(root,{
        MutationObserver:Observer,
        eventTypes:[],
        observeOpenShadowRoots:false
    });
    assert.equal(attachAtLimit.overflowed,true);
    assert.equal(attachAtLimit.timeTravelEnabled,false);
    assert.equal(lateInstrumentation.active,false);
    assert.equal(Observer.latest.disconnected,true);
    assert.equal(attachAtLimit.history.at(-1).type,TIME_TRAVEL_OVERFLOW_EVENT);

    manager.clearHistory({newSession:false});
    assert.equal(manager.overflowed,false);
    assert.equal(manager.enableTimeTravel(),manager);
    assert.equal(manager.timeTravelEnabled,true);
    assert.equal(manager.domInstrumentation.active,true);
    manager.disableTimeTravel();
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
        assert.ok(Object.isFrozen(delivered[0]));
    }finally{
        arcaneEvents.off('sdk.example',handler);
    }
});
