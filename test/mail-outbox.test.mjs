import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS,
    MAIL_OUTBOX_PROTOCOL,
    MailOutbox
} from '../runtime/arcane/modules/MailOutbox.mjs';

function clone(value){
    return value===undefined?undefined:JSON.parse(JSON.stringify(value));
}

class MemoryOutboxStorage{
    constructor(){
        this.readyPromise=Promise.resolve();
        this.tables=new Map();
        this.operations=[];
    }

    table(name){
        if(!this.tables.has(name)) this.tables.set(name,new Map());
        return this.tables.get(name);
    }

    async get(tableName,fileName){
        const value=this.table(tableName).get(fileName);
        this.operations.push({operation:'get',tableName,fileName});
        return value===undefined?null:clone(value);
    }

    async set(tableName,fileName,value){
        this.table(tableName).set(fileName,clone(value));
        this.operations.push({operation:'set',tableName,fileName,value:clone(value)});
        return clone(value);
    }

    async getAllKeys(tableName){
        this.operations.push({operation:'getAllKeys',tableName});
        return [...this.table(tableName).keys()];
    }
}

class OnlineTarget{
    constructor(){
        this.listeners=new Set();
    }

    addEventListener(type,listener){
        if(type==='online') this.listeners.add(listener);
    }

    removeEventListener(type,listener){
        if(type==='online') this.listeners.delete(listener);
    }

    dispatchOnline(){
        for(const listener of this.listeners) listener({type:'online'});
    }
}

function accepted(requestId='request-accepted',providerId='provider-accepted'){
    return {
        status:'accepted',
        classification:'accepted',
        requestId,
        providerId,
        statusCode:202
    };
}

test('enqueue durably writes the immutable body before the first delivery attempt',async function persistBeforeDelivery(){
    const storage=new MemoryOutboxStorage();
    const observed=[];
    const signal={
        aborted:false,
        addEventListener:function addEventListener(){},
        removeEventListener:function removeEventListener(){}
    };
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1000;},
        deliver:async function deliver(request){
            const stored=await storage.get('mail_outbox',`${request.reportKey}.mail-outbox.json`);
            observed.push({request,stored});
            return accepted();
        }
    });
    const report={type:'report',subject:'Durable',to:['person@example.com'],text:'hello'};
    const record=await outbox.enqueue(
        {report,reportKey:'report-durable-1'},
        {signal}
    );

    assert.equal(observed.length,1);
    assert.equal(observed[0].stored.state,'sending');
    assert.equal(observed[0].stored.serializedReport,JSON.stringify(report));
    assert.equal(observed[0].request.serializedReport,JSON.stringify(report));
    assert.equal(Object.isFrozen(observed[0].request),true);
    assert.equal(Object.isFrozen(observed[0].request.report),true);
    assert.equal(Object.isFrozen(signal),false);
    assert.equal(record.state,'accepted');
    assert.equal(record.result.providerId,'provider-accepted');
    assert.equal(record.protocol,MAIL_OUTBOX_PROTOCOL);
});

test('accepted state requires both gateway and provider acceptance identifiers',async function acceptanceEvidence(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1500;},
        deliver:async function deliver(){
            return {status:'accepted',requestId:'request-without-provider',statusCode:202};
        }
    });
    const record=await outbox.enqueue({
        report:{type:'report',subject:'Evidence',to:['person@example.com'],text:'hello'},
        reportKey:'report-evidence-1'
    });

    assert.equal(record.state,'failed');
    assert.equal(record.result,null);
    assert.equal(record.failure.code,'MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
});

test('offline enqueue remains queued and the owned online listener drains it',async function onlineDrain(){
    const storage=new MemoryOutboxStorage();
    const target=new OnlineTarget();
    let online=false;
    let deliveries=0;
    const outbox=new MailOutbox({
        storage,
        onlineTarget:target,
        isOnline:function onlineStatus(){return online;},
        clock:function clock(){return 2000;},
        deliver:async function deliver(){
            deliveries+=1;
            return accepted();
        }
    });
    await outbox.start();
    const queued=await outbox.enqueue({
        report:{type:'error',subject:'Offline',to:[],text:'offline'},
        reportKey:'report-offline-1'
    });
    assert.equal(queued.state,'queued');
    assert.equal(deliveries,0);

    online=true;
    target.dispatchOnline();
    await outbox.drain({reason:'manual'});
    assert.equal((await outbox.get('report-offline-1')).state,'accepted');
    assert.equal(deliveries,1);
    outbox.stop();
    assert.equal(target.listeners.size,0);
});

test('offline drain still recovers a later interrupted sending record',async function offlineRecoveryScan(){
    const storage=new MemoryOutboxStorage();
    let now=100;
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return now;},
        deliver:async function deliver(){return accepted();}
    });
    await outbox.enqueue(
        {report:{type:'report',subject:'Queued',to:[],text:'queued'},reportKey:'report-offline-a'},
        {attempt:false}
    );
    await storage.set('mail_outbox','report-offline-z.mail-outbox.json',{
        protocol:MAIL_OUTBOX_PROTOCOL,
        reportKey:'report-offline-z',
        serializedReport:JSON.stringify({type:'report',subject:'Interrupted',to:[],text:'sending'}),
        state:'sending',
        createdAt:200,
        updatedAt:200,
        firstAttemptAt:200,
        lastAttemptAt:200,
        nextAttemptAt:null,
        attempts:1,
        result:null,
        failure:null
    });

    now=300;
    const result=await outbox.drain();
    assert.equal(result.states.queued,1);
    assert.equal(result.states.retry_wait,1);
    assert.equal((await outbox.get('report-offline-z')).failure.uncertain,true);
});

test('drain is FIFO and bounds provider attempts',async function boundedFifo(){
    const storage=new MemoryOutboxStorage();
    let now=3000;
    let online=false;
    const delivered=[];
    const outbox=new MailOutbox({
        storage,
        maxAttemptsPerDrain:2,
        isOnline:function onlineStatus(){return online;},
        clock:function clock(){return now;},
        deliver:async function deliver(request){
            delivered.push(request.reportKey);
            return accepted(`request-${request.reportKey}`,`provider-${request.reportKey}`);
        }
    });
    for(const key of ['report-fifo-1','report-fifo-2','report-fifo-3']){
        await outbox.enqueue(
            {report:{type:'report',subject:key,to:['person@example.com'],text:key},reportKey:key},
            {attempt:false}
        );
        now+=1;
    }
    online=true;
    const first=await outbox.drain();
    assert.deepEqual(delivered,['report-fifo-1','report-fifo-2']);
    assert.equal(first.attempted,2);
    assert.equal(first.bounded,true);
    assert.equal(first.pending,1);

    const second=await outbox.drain();
    assert.deepEqual(delivered,['report-fifo-1','report-fifo-2','report-fifo-3']);
    assert.equal(second.pending,0);
});

test('uncertain delivery retries the exact key and body inside the Resend window',async function stableRetry(){
    const storage=new MemoryOutboxStorage();
    let now=4000;
    const requests=[];
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return now;},
        deliver:async function deliver(request){
            requests.push({
                reportKey:request.reportKey,
                serializedReport:request.serializedReport
            });
            if(requests.length===1){
                return {
                    status:'delivery_uncertain',
                    classification:'ambiguous',
                    requestId:'request-uncertain',
                    statusCode:207
                };
            }
            return accepted('request-replayed','provider-replayed');
        }
    });
    const report={type:'report',subject:'Retry',to:['person@example.com'],text:'same body'};
    const retrying=await outbox.enqueue({report,reportKey:'report-retry-1'});
    assert.equal(retrying.state,'retry_wait');
    assert.equal(retrying.failure.uncertain,true);

    now+=1000;
    const completed=await outbox.drain();
    assert.equal(completed.states.accepted,1);
    assert.deepEqual(requests,[requests[0],requests[0]]);
});

test('ambiguous delivery beyond 24 hours requires reconciliation without another attempt',async function ambiguityExpiry(){
    const storage=new MemoryOutboxStorage();
    let now=5000;
    let attempts=0;
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return now;},
        deliver:async function deliver(){
            attempts+=1;
            return {
                status:'delivery_uncertain',
                classification:'ambiguous',
                requestId:'request-ambiguous',
                statusCode:207
            };
        }
    });
    const first=await outbox.enqueue({
        report:{type:'report',subject:'Ambiguous',to:['person@example.com'],text:'body'},
        reportKey:'report-ambiguous-1'
    });
    assert.equal(first.state,'retry_wait');
    now=first.firstAttemptAt+MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS;

    const summary=await outbox.drain();
    const expired=await outbox.get('report-ambiguous-1');
    assert.equal(attempts,1);
    assert.equal(summary.states.reconciliation_required,1);
    assert.equal(expired.state,'reconciliation_required');
    assert.equal(expired.failure.code,'MAIL_OUTBOX_RECONCILIATION_REQUIRED');
});

test('only explicit retryable or uncertain thrown failures enter retry_wait',async function explicitRetryClassification(t){
    await t.test('explicit retryable error is retained',async function retryableError(){
        const storage=new MemoryOutboxStorage();
        const outbox=new MailOutbox({
            storage,
            isOnline:function online(){return true;},
            clock:function clock(){return 6000;},
            deliver:async function deliver(){
                const error=new Error('safe synthetic failure');
                error.code='MAIL_GATEWAY_BACKPRESSURE';
                error.retryable=true;
                error.retryAfterSeconds=3;
                throw error;
            }
        });
        const record=await outbox.enqueue({
            report:{type:'report',subject:'Retryable',to:['person@example.com'],text:'body'},
            reportKey:'report-explicit-retry'
        });
        assert.equal(record.state,'retry_wait');
        assert.equal(record.failure.retryable,true);
        assert.equal(record.failure.uncertain,false);
        assert.equal(record.nextAttemptAt,9000);
    });

    await t.test('unclassified error fails closed',async function unclassifiedError(){
        const storage=new MemoryOutboxStorage();
        const outbox=new MailOutbox({
            storage,
            isOnline:function online(){return true;},
            clock:function clock(){return 7000;},
            deliver:async function deliver(){
                throw new Error('unclassified');
            }
        });
        const record=await outbox.enqueue({
            report:{type:'report',subject:'Permanent',to:['person@example.com'],text:'body'},
            reportKey:'report-unclassified-1'
        });
        assert.equal(record.state,'failed');
        assert.equal(record.failure.retryable,false);
        assert.equal(record.failure.uncertain,false);
    });
});

test('one reportKey cannot be rebound to different serialized bytes',async function idempotencyConflict(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 8000;},
        deliver:async function deliver(){return accepted();}
    });
    await outbox.enqueue(
        {report:{type:'report',subject:'One',to:['person@example.com'],text:'one'},reportKey:'report-conflict-1'},
        {attempt:false}
    );
    await assert.rejects(
        outbox.enqueue(
            {report:{type:'report',subject:'Two',to:['person@example.com'],text:'two'},reportKey:'report-conflict-1'},
            {attempt:false}
        ),
        function hasConflictCode(error){
            return error.code==='MAIL_OUTBOX_IDEMPOTENCY_CONFLICT';
        }
    );
});

test('concurrent enqueue calls cannot race a reportKey onto different bytes',async function concurrentIdempotencyConflict(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 8500;},
        deliver:async function deliver(){return accepted();}
    });
    const first=outbox.enqueue(
        {report:{type:'report',subject:'First',to:[],text:'first'},reportKey:'report-concurrent-key'},
        {attempt:false}
    );
    const second=outbox.enqueue(
        {report:{type:'report',subject:'Second',to:[],text:'second'},reportKey:'report-concurrent-key'},
        {attempt:false}
    );
    const results=await Promise.allSettled([first,second]);

    assert.equal(results[0].status,'fulfilled');
    assert.equal(results[1].status,'rejected');
    assert.equal(results[1].reason.code,'MAIL_OUTBOX_IDEMPOTENCY_CONFLICT');
    assert.equal((await outbox.get('report-concurrent-key')).serializedReport,JSON.stringify({
        type:'report',subject:'First',to:[],text:'first'
    }));
});

test('concurrent manual drains share one provider attempt',async function oneActiveDrain(){
    const storage=new MemoryOutboxStorage();
    let release;
    const deliveryGate=new Promise(function waitForRelease(resolve){release=resolve;});
    let attempts=0;
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 9000;},
        deliver:async function deliver(){
            attempts+=1;
            await deliveryGate;
            return accepted();
        }
    });
    await outbox.enqueue(
        {report:{type:'report',subject:'Concurrent',to:['person@example.com'],text:'body'},reportKey:'report-concurrent-1'},
        {attempt:false}
    );
    const first=outbox.drain();
    const second=outbox.drain();
    release();
    await Promise.all([first,second]);
    assert.equal(attempts,1);
});
