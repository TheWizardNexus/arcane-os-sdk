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

class MemoryLockManager{
    constructor(){this.tails=new Map();}

    request(name,options,callback){
        if(options?.mode!=='exclusive'||typeof callback!=='function'){
            throw new TypeError('Memory lock requests must be exclusive callbacks');
        }
        const previous=this.tails.get(name)??Promise.resolve();
        const current=previous.then(function runMemoryLock(){
            return callback(Object.freeze({name,mode:'exclusive'}));
        });
        const tail=current.catch(function ignoreMemoryLockFailure(){});
        this.tails.set(name,tail);
        return current.finally(()=>{
            if(this.tails.get(name)===tail) this.tails.delete(name);
        });
    }
}

class MemoryOutboxStorage{
    constructor(){
        this.readyPromise=Promise.resolve();
        this.lockManager=new MemoryLockManager();
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

    async delete(tableName,fileName){
        const deleted=this.table(tableName).delete(fileName);
        this.operations.push({operation:'delete',tableName,fileName});
        return deleted;
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

test('MailOutbox fails closed without a Web Locks compatible manager',function lockManagerRequired(){
    assert.throws(
        function constructWithoutLockManager(){
            return new MailOutbox({
                storage:new MemoryOutboxStorage(),
                lockManager:{},
                deliver:async function deliver(){return accepted();}
            });
        },
        function lockUnavailable(error){return error?.code==='MAIL_OUTBOX_LOCK_UNAVAILABLE';}
    );
});

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

test('an accepted delivery result outranks a late caller cancellation',async function acceptedAfterCancellation(){
    const storage=new MemoryOutboxStorage();
    const controller=new AbortController();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1400;},
        deliver:async function deliver(){
            controller.abort(new Error('synthetic late cancellation'));
            return accepted('request-late-cancel','provider-late-cancel');
        }
    });
    const record=await outbox.enqueue({
        report:{type:'report',subject:'Accepted first',to:['person@example.com'],text:'hello'},
        reportKey:'report-accepted-late-cancel'
    },{signal:controller.signal});

    assert.equal(record.state,'accepted');
    assert.equal(record.result.providerId,'provider-late-cancel');
    assert.equal(record.failure,null);
});

test('cancellation during the sending write restores the non-attempted state',async function cancelledSendingWrite(){
    const storage=new MemoryOutboxStorage();
    const controller=new AbortController();
    const write=storage.set.bind(storage);
    let deliveries=0;
    storage.set=async function abortDuringSendingWrite(tableName,fileName,value){
        const saved=await write(tableName,fileName,value);
        if(value.state==='sending'){
            controller.abort(new Error('synthetic cancellation during durable write'));
        }
        return saved;
    };
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1450;},
        deliver:async function deliver(){
            deliveries+=1;
            return accepted();
        }
    });

    await assert.rejects(
        outbox.enqueue({
            report:{type:'report',subject:'Cancelled before attempt',to:['person@example.com'],text:'hello'},
            reportKey:'report-cancelled-before-attempt'
        },{signal:controller.signal}),
        function cancelledBeforeAttempt(error){
            return error?.name==='AbortError'&&error?.code==='MAIL_OUTBOX_ABORTED';
        }
    );
    const record=await outbox.get('report-cancelled-before-attempt');
    assert.equal(deliveries,0);
    assert.equal(record.state,'queued');
    assert.equal(record.attempts,0);
    assert.equal(record.firstAttemptAt,null);
    assert.equal(record.lastAttemptAt,null);
});

test('ordinary accepted state requires both gateway and provider acceptance identifiers',async function acceptanceEvidence(){
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

test('accepted state admits the exact Arcane Core mail contract without fabricating a provider id',async function nativeAcceptanceEvidence(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1600;},
        deliver:async function deliver(){
            return {
                status:'accepted',
                classification:'accepted',
                acceptanceAuthority:'arcane-core-mail-send-v1',
                requestId:'request-native-core',
                statusCode:202
            };
        }
    });
    const record=await outbox.enqueue({
        report:{type:'report',subject:'Native evidence',to:[],text:'hello'},
        reportKey:'report-native-evidence-1'
    });

    assert.equal(record.state,'accepted');
    assert.equal(record.result.providerId,null);
    assert.equal(record.result.acceptanceAuthority,'arcane-core-mail-send-v1');
});

test('accepted state rejects an unrecognized acceptance authority',async function rejectAcceptanceAuthority(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1700;},
        deliver:async function deliver(){
            return {
                status:'accepted',
                classification:'accepted',
                acceptanceAuthority:'untrusted-authority',
                requestId:'request-untrusted-authority',
                statusCode:202
            };
        }
    });
    const record=await outbox.enqueue({
        report:{type:'report',subject:'Untrusted evidence',to:[],text:'hello'},
        reportKey:'report-untrusted-evidence-1'
    });

    assert.equal(record.state,'failed');
    assert.equal(record.failure.code,'MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
});

test('accepted provider evidence rejects malformed acceptance authority metadata',async function rejectMalformedAcceptanceAuthority(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 1800;},
        deliver:async function deliver(){
            return {
                status:'accepted',
                classification:'accepted',
                acceptanceAuthority:'malformed authority',
                requestId:'request-malformed-authority',
                providerId:'provider-malformed-authority',
                statusCode:202
            };
        }
    });
    const record=await outbox.enqueue({
        report:{type:'report',subject:'Malformed authority',to:[],text:'hello'},
        reportKey:'report-malformed-authority-1'
    });

    assert.equal(record.state,'failed');
    assert.equal(record.failure.code,'MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
});

test('invalid durable files do not hide valid records or consume logical capacity',async function invalidRecordInventory(){
    const storage=new MemoryOutboxStorage();
    storage.table('mail_outbox').set('broken-record.mail-outbox.json',{broken:true});
    const outbox=new MailOutbox({
        storage,
        maxRecords:1,
        isOnline:function online(){return false;},
        clock:function clock(){return 1900;},
        deliver:async function deliver(){return accepted();}
    });

    assert.deepEqual(await outbox.list(),[]);
    assert.equal(outbox.invalidRecords.length,1);
    assert.equal(outbox.invalidRecords[0].fileName,'broken-record.mail-outbox.json');
    assert.equal(outbox.invalidRecords[0].repairable,true);

    const queued=await outbox.enqueue({
        report:{type:'report',subject:'Valid beside invalid',to:[],text:'hello'},
        reportKey:'report-valid-beside-invalid'
    },{attempt:false});
    assert.equal(queued.state,'queued');
    const audit=await outbox.audit();
    assert.equal(audit.records.length,1);
    assert.equal(audit.invalidRecords.length,1);
    assert.equal(audit.totalFiles,2);
    assert.equal(audit.truncated,false);

    const quarantine=await outbox.quarantineInvalid({limit:1});
    assert.equal(quarantine.quarantined.length,1);
    assert.equal(quarantine.remainingInvalidRecords,0);
    assert.equal(storage.table('mail_outbox').has('broken-record.mail-outbox.json'),false);
    const retained=storage.table('mail_outbox_quarantine').get('broken-record.mail-outbox.json');
    assert.equal(retained.protocol,'arcane-mail-outbox-quarantine/1');
    assert.equal(retained.reasonCode,'MAIL_OUTBOX_RECORD_INVALID');
});

test('invalid durable records have explicit repair and delete paths',async function invalidRecordMaintenance(){
    const storage=new MemoryOutboxStorage();
    storage.table('mail_outbox').set('report-repair-record.mail-outbox.json',{broken:true});
    storage.table('mail_outbox').set('invalid-file-name.json',{broken:true});
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 1950;},
        deliver:async function deliver(){return accepted();}
    });
    const replacement={
        protocol:MAIL_OUTBOX_PROTOCOL,
        reportKey:'report-repair-record',
        serializedReport:JSON.stringify({type:'report',subject:'Repaired',to:[],text:'hello'}),
        state:'queued',
        createdAt:1950,
        updatedAt:1950,
        firstAttemptAt:null,
        lastAttemptAt:null,
        nextAttemptAt:null,
        attempts:0,
        result:null,
        failure:null
    };

    const repaired=await outbox.repairInvalid(
        'report-repair-record.mail-outbox.json',
        replacement
    );
    assert.equal(repaired.state,'queued');
    assert.equal((await outbox.get('report-repair-record')).state,'queued');
    const deleted=await outbox.deleteInvalid('invalid-file-name.json');
    assert.equal(deleted.deleted,true);
    assert.equal(storage.table('mail_outbox').has('invalid-file-name.json'),false);
    assert.equal((await outbox.audit()).invalidRecords.length,0);
});

test('storage read failures propagate and never authorize destructive maintenance',async function storageReadFailure(){
    const storage=new MemoryOutboxStorage();
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 1960;},
        deliver:async function deliver(){return accepted();}
    });
    await outbox.enqueue({
        report:{type:'report',subject:'Transient read',to:[],text:'hello'},
        reportKey:'report-transient-read'
    },{attempt:false});
    const originalGet=storage.get.bind(storage);
    storage.get=async function failRecordRead(tableName,fileName){
        if(tableName==='mail_outbox'&&fileName==='report-transient-read.mail-outbox.json'){
            throw new Error('synthetic transient storage failure');
        }
        return originalGet(tableName,fileName);
    };

    await assert.rejects(
        outbox.audit(),
        function storageFailure(error){return error?.code==='MAIL_OUTBOX_STORAGE_FAILED';}
    );
    await assert.rejects(
        outbox.deleteInvalid('report-transient-read.mail-outbox.json'),
        function deletionNotAuthorized(error){return error?.code==='MAIL_OUTBOX_STORAGE_FAILED';}
    );
    assert.equal(
        storage.table('mail_outbox').has('report-transient-read.mail-outbox.json'),
        true
    );
});

test('quarantine retains the source when no bounded snapshot can be captured',async function quarantineSnapshotRequired(){
    const storage=new MemoryOutboxStorage();
    storage.table('mail_outbox').set('oversized-invalid.mail-outbox.json','x'.repeat(128));
    const outbox=new MailOutbox({
        storage,
        maxReportBytes:64,
        isOnline:function online(){return false;},
        clock:function clock(){return 1970;},
        deliver:async function deliver(){return accepted();}
    });

    await assert.rejects(
        outbox.quarantineInvalid({limit:1}),
        function snapshotRequired(error){
            return error?.code==='MAIL_OUTBOX_QUARANTINE_SNAPSHOT_UNAVAILABLE';
        }
    );
    assert.equal(storage.table('mail_outbox').has('oversized-invalid.mail-outbox.json'),true);
    assert.equal(
        storage.table('mail_outbox_quarantine').has('oversized-invalid.mail-outbox.json'),
        false
    );
});

test('quarantine propagates a revalidation read failure without deleting the source',async function quarantineReadFailure(){
    const storage=new MemoryOutboxStorage();
    const fileName='report-quarantine-read.mail-outbox.json';
    storage.table('mail_outbox').set(fileName,{broken:true});
    const originalGet=storage.get.bind(storage);
    let reads=0;
    storage.get=async function failRevalidationRead(tableName,requestedFileName){
        if(tableName==='mail_outbox'&&requestedFileName===fileName){
            reads+=1;
            if(reads===2) throw new Error('synthetic quarantine revalidation failure');
        }
        return originalGet(tableName,requestedFileName);
    };
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 1971;},
        deliver:async function deliver(){return accepted();}
    });

    await assert.rejects(
        outbox.quarantineInvalid({limit:1}),
        function storageFailure(error){return error?.code==='MAIL_OUTBOX_STORAGE_FAILED';}
    );
    assert.equal(storage.table('mail_outbox').has(fileName),true);
    assert.equal(storage.table('mail_outbox_quarantine').has(fileName),false);
});

test('shared-table maintenance cannot delete a record repaired by another instance',async function serializedMaintenance(){
    const storage=new MemoryOutboxStorage();
    const fileName='report-race-repair.mail-outbox.json';
    storage.table('mail_outbox').set(fileName,{broken:true});
    let releaseRepairWrite;
    let observeRepairWrite;
    let observeConcurrentRead;
    const repairWriteStarted=new Promise(function waitForRepairWrite(resolve){
        observeRepairWrite=resolve;
    });
    const concurrentReadObserved=new Promise(function waitForConcurrentRead(resolve){
        observeConcurrentRead=resolve;
    });
    const originalGet=storage.get.bind(storage);
    const originalSet=storage.set.bind(storage);
    let repairWritePending=false;
    storage.get=async function observeRecordRead(tableName,requestedFileName){
        if(repairWritePending&&tableName==='mail_outbox'&&requestedFileName===fileName){
            observeConcurrentRead();
        }
        return originalGet(tableName,requestedFileName);
    };
    storage.set=async function pauseRepairWrite(tableName,requestedFileName,value){
        if(tableName==='mail_outbox'&&requestedFileName===fileName&&value?.protocol===MAIL_OUTBOX_PROTOCOL){
            repairWritePending=true;
            observeRepairWrite();
            await new Promise(function waitForRelease(resolve){releaseRepairWrite=resolve;});
            repairWritePending=false;
        }
        return originalSet(tableName,requestedFileName,value);
    };
    const repairOutbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 1972;},
        deliver:async function deliver(){return accepted();}
    });
    const deleteOutbox=new MailOutbox({
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 1973;},
        deliver:async function deliver(){return accepted();}
    });
    const replacement={
        protocol:MAIL_OUTBOX_PROTOCOL,
        reportKey:'report-race-repair',
        serializedReport:JSON.stringify({type:'report',subject:'Repair race',to:[],text:'hello'}),
        state:'queued',
        createdAt:1972,
        updatedAt:1972,
        firstAttemptAt:null,
        lastAttemptAt:null,
        nextAttemptAt:null,
        attempts:0,
        result:null,
        failure:null
    };

    const repair=repairOutbox.repairInvalid(fileName,replacement);
    await repairWriteStarted;
    const deletion=deleteOutbox.deleteInvalid(fileName);
    await concurrentReadObserved;
    releaseRepairWrite();
    await repair;
    await assert.rejects(
        deletion,
        function changedRecordPreserved(error){
            return error?.code==='MAIL_OUTBOX_INVALID_RECORD_CHANGED';
        }
    );
    assert.equal((await repairOutbox.get('report-race-repair')).state,'queued');
});

test('enqueue requires maintenance before it would exceed the bounded inventory scan',async function boundedInventoryMaintenance(){
    const storage=new MemoryOutboxStorage();
    storage.table('mail_outbox').set('broken-record-one.mail-outbox.json',{broken:true});
    storage.table('mail_outbox').set('broken-record-two.mail-outbox.json',{broken:true});
    const outbox=new MailOutbox({
        storage,
        maxInvalidRecords:1,
        maxRecords:1,
        isOnline:function online(){return false;},
        clock:function clock(){return 1975;},
        deliver:async function deliver(){return accepted();}
    });
    const request={
        report:{type:'report',subject:'Bounded inventory',to:[],text:'hello'},
        reportKey:'report-bounded-inventory'
    };

    await assert.rejects(
        outbox.enqueue(request,{attempt:false}),
        function maintenanceRequired(error){
            return error?.code==='MAIL_OUTBOX_MAINTENANCE_REQUIRED';
        }
    );
    const quarantined=await outbox.quarantineInvalid({limit:1});
    assert.equal(quarantined.quarantined.length,1);
    assert.equal(quarantined.remainingInvalidRecords,1);

    const queued=await outbox.enqueue(request,{attempt:false});
    assert.equal(queued.state,'queued');
    const audit=await outbox.audit();
    assert.equal(audit.truncated,false);
    assert.equal(audit.records.length,1);
    assert.equal(audit.invalidRecords.length,1);
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

test('shared-table instances cannot race a reportKey onto different bytes',async function sharedIdempotencyConflict(){
    const storage=new MemoryOutboxStorage();
    const options={
        storage,
        isOnline:function online(){return false;},
        clock:function clock(){return 8750;},
        deliver:async function deliver(){return accepted();}
    };
    const firstOutbox=new MailOutbox(options);
    const secondOutbox=new MailOutbox(options);
    const first=firstOutbox.enqueue(
        {report:{type:'report',subject:'First shared',to:[],text:'first'},reportKey:'report-shared-key'},
        {attempt:false}
    );
    const second=secondOutbox.enqueue(
        {report:{type:'report',subject:'Second shared',to:[],text:'second'},reportKey:'report-shared-key'},
        {attempt:false}
    );
    const results=await Promise.allSettled([first,second]);

    assert.equal(results[0].status,'fulfilled');
    assert.equal(results[1].status,'rejected');
    assert.equal(results[1].reason.code,'MAIL_OUTBOX_IDEMPOTENCY_CONFLICT');
    assert.equal((await secondOutbox.get('report-shared-key')).serializedReport,JSON.stringify({
        type:'report',subject:'First shared',to:[],text:'first'
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

test('shared-table instances hold one origin-wide provider drain',async function sharedDrainAuthority(){
    const storage=new MemoryOutboxStorage();
    let announceDelivery;
    let releaseDelivery;
    const deliveryStarted=new Promise(function waitForDelivery(resolve){
        announceDelivery=resolve;
    });
    const deliveryGate=new Promise(function waitForRelease(resolve){
        releaseDelivery=resolve;
    });
    let attempts=0;
    const options={
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 9250;},
        deliver:async function deliver(){
            attempts+=1;
            announceDelivery();
            await deliveryGate;
            return accepted('request-shared-drain','provider-shared-drain');
        }
    };
    const firstOutbox=new MailOutbox(options);
    const secondOutbox=new MailOutbox(options);
    await firstOutbox.enqueue(
        {report:{type:'report',subject:'Shared drain',to:[],text:'body'},reportKey:'report-shared-drain'},
        {attempt:false}
    );

    const first=firstOutbox.drain();
    await deliveryStarted;
    const second=secondOutbox.drain();
    await Promise.resolve();
    releaseDelivery();
    const summaries=await Promise.all([first,second]);

    assert.equal(attempts,1);
    assert.equal(summaries[0].attempted,1);
    assert.equal(summaries[1].attempted,0);
    assert.equal((await secondOutbox.get('report-shared-drain')).state,'accepted');
});

test('a caller joining an active drain observes its own cancellation',async function joinedDrainCancellation(){
    const storage=new MemoryOutboxStorage();
    let announceDelivery;
    let releaseDelivery;
    const deliveryStarted=new Promise(function waitForDelivery(resolve){
        announceDelivery=resolve;
    });
    const deliveryGate=new Promise(function waitForRelease(resolve){
        releaseDelivery=resolve;
    });
    const outbox=new MailOutbox({
        storage,
        isOnline:function online(){return true;},
        clock:function clock(){return 9500;},
        deliver:async function deliver(){
            announceDelivery();
            await deliveryGate;
            return accepted('request-joined-drain','provider-joined-drain');
        }
    });
    await outbox.enqueue(
        {report:{type:'report',subject:'Joined drain',to:['person@example.com'],text:'body'},reportKey:'report-joined-drain'},
        {attempt:false}
    );
    const first=outbox.drain();
    await deliveryStarted;
    const controller=new AbortController();
    const joined=outbox.drain({signal:controller.signal});
    controller.abort(new Error('synthetic joined caller cancellation'));

    await assert.rejects(joined,function joinedCallerAborted(error){
        return error?.name==='AbortError'&&error?.code==='MAIL_OUTBOX_ABORTED';
    });
    releaseDelivery();
    await first;
    assert.equal((await outbox.get('report-joined-drain')).state,'accepted');
});
