import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import Mail from '../runtime/arcane/modules/Mail.js';

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
            return callback({name,mode:'exclusive'});
        });
        const tail=current.catch(function ignoreMemoryLockFailure(){});
        this.tails.set(name,tail);
        return current.finally(()=>{
            if(this.tails.get(name)===tail) this.tails.delete(name);
        });
    }
}

class MemoryMailStorage{
    constructor({readyPromise=Promise.resolve()}={}){
        this.readyPromise=readyPromise;
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
        const saved=clone(value);
        this.table(tableName).set(fileName,saved);
        this.operations.push({operation:'set',tableName,fileName,value:saved});
        return clone(saved);
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
    constructor(){this.listeners=new Set();}

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
        requestId,
        providerId,
        statusCode:202
    };
}

function mailConfig(){
    return {
        appName:'mail-test',
        endpoint:'https://mail.invalid/v1/mail'
    };
}

test('Mail persists the exact mutable report before its first delivery attempt',async function durableBeforeAttempt(){
    const storage=new MemoryMailStorage();
    let now=1_000;
    let delivered=null;
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return now++;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:async function deliver(request){
            storage.operations.push({operation:'deliver'});
            const stored=await storage.get(
                'mail_outbox',
                `${request.reportKey}.mail-outbox.json`
            );
            delivered={request,stored};
            return accepted();
        }
    });

    const result=await mail.send(
        ['private-recipient@example.com'],
        'Private Subject',
        {marker:'synthetic-body-marker'},
        '',
        'report'
    );

    const deliveryIndex=storage.operations.findIndex(function findDelivery(operation){
        return operation.operation==='deliver';
    });
    const queuedIndex=storage.operations.findIndex(function findQueuedWrite(operation){
        return operation.operation==='set'&&operation.value?.state==='queued';
    });
    assert.ok(queuedIndex>=0&&queuedIndex<deliveryIndex);
    assert.equal(delivered.stored.state,'sending');
    assert.equal(delivered.stored.serializedReport,delivered.request.serializedReport);
    assert.deepEqual(JSON.parse(delivered.request.serializedReport),delivered.request.report);
    assert.equal(Object.isFrozen(delivered.request),false);
    assert.equal(Object.isFrozen(delivered.request.report),false);
    assert.equal(result.state,'accepted');
    assert.equal(result.sent,true);
    assert.equal(result.queued,false);
    assert.equal(result.serializedReport,delivered.request.serializedReport);
    assert.deepEqual(result.report,delivered.request.report);
    assert.equal(result.report.text.includes('synthetic-body-marker'),true);
    assert.equal(result.report.to[0],'private-recipient@example.com');
    assert.doesNotMatch(result.reportKey,/Private|Subject|recipient|example/i);
    assert.equal((await mail.getOutboxRecord(result.reportKey)).state,'accepted');
    mail.dispose();
});

test('Mail context enrichment is explicit opt-in',async function explicitContextEnrichment(){
    const previousLocation=globalThis.location;
    const hadLocation=Object.hasOwn(globalThis,'location');
    globalThis.location={pathname:'/synthetic/private/path'};
    let profileLoads=0;
    let defaultRequest=null;
    let enrichedRequest=null;
    const user={
        email:'synthetic-profile@example.com',
        language:'synthetic-language',
        phone:'synthetic-phone',
        username:'synthetic-user',
        async load(){profileLoads+=1;}
    };
    try{
        const defaultMail=new Mail(mailConfig(),{
            storage:new MemoryMailStorage(),
            user,
            clock:function clock(){return 1_100;},
            isOnline:function online(){return true;},
            onlineTarget:null,
            deliver:async function deliver(request){
                defaultRequest=request;
                return accepted('request-context-default','provider-context-default');
            }
        });
        await defaultMail.send(
            ['context@example.com'],
            'Context default',
            {kind:'synthetic'},
            '',
            'report'
        );
        defaultMail.dispose();
        assert.equal(profileLoads,0);
        for(const privateValue of [
            '/synthetic/private/path',
            'synthetic-profile@example.com',
            'synthetic-language',
            'synthetic-phone',
            'synthetic-user'
        ]){
            assert.equal(defaultRequest.serializedReport.includes(privateValue),false);
        }

        const enrichedMail=new Mail(mailConfig(),{
            storage:new MemoryMailStorage(),
            user,
            includeContext:true,
            clock:function clock(){return 1_200;},
            isOnline:function online(){return true;},
            onlineTarget:null,
            deliver:async function deliver(request){
                enrichedRequest=request;
                return accepted('request-context-opt-in','provider-context-opt-in');
            }
        });
        await enrichedMail.send(
            ['context@example.com'],
            'Context opt in',
            {kind:'synthetic'},
            '',
            'report'
        );
        enrichedMail.dispose();
        assert.equal(profileLoads,1);
        for(const contextValue of [
            '/synthetic/private/path',
            'synthetic-profile@example.com',
            'synthetic-language',
            'synthetic-phone',
            'synthetic-user'
        ]){
            assert.equal(enrichedRequest.serializedReport.includes(contextValue),true);
        }
    }finally{
        if(hadLocation) globalThis.location=previousLocation;
        else delete globalThis.location;
    }
});

test('Mail remains functional without Web Crypto by using local time and sequence identity',async function cryptoOptional(){
    const storage=new MemoryMailStorage();
    let deliveries=0;
    const mail=new Mail(mailConfig(),{
        storage,
        crypto:null,
        user:null,
        clock:function clock(){return 1_300;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:async function deliver(){
            deliveries+=1;
            return accepted();
        }
    });
    const result=await mail.send(
        ['crypto@example.com'],
        'Crypto optional',
        {kind:'synthetic'},
        '',
        'report'
    );
    assert.equal(deliveries,1);
    assert.equal(result.state,'accepted');
    assert.match(result.reportKey,/-mail$/u);
    assert.equal(storage.table('mail_outbox').size,1);
    mail.dispose();
});

test('Mail queues offline and drains through both manual and online lifecycle paths',async function offlineAndOnlineDrain(){
    const storage=new MemoryMailStorage();
    const onlineTarget=new OnlineTarget();
    let online=false;
    let deliveries=0;
    const committedStates=[];
    const deliveryEvents=[];
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 2_000+deliveries;},
        isOnline:function onlineStatus(){return online;},
        onlineTarget,
        deliver:async function deliver(){
            deliveries+=1;
            return accepted('request-online','provider-online');
        }
    });
    mail.events.addEventListener('mail-outbox-state',function collectCommittedState(event){
        if(!event.detail.reportKey) return;
        const stored=storage.table('mail_outbox').get(
            `${event.detail.reportKey}.mail-outbox.json`
        );
        committedStates.push({
            reportKey:event.detail.reportKey,
            state:event.detail.state,
            durableState:stored?.state
        });
    });
    mail.events.addEventListener('mail-outbox-delivery',function collectDeliveryEvent(event){
        deliveryEvents.push(event.detail);
    });

    const queued=await mail.send(
        ['offline@example.com'],
        'Offline report',
        {status:'waiting'},
        '',
        'report'
    );
    assert.equal(queued.state,'queued');
    assert.equal(queued.queued,true);
    assert.equal(deliveries,0);
    assert.equal(mail.started,true);
    assert.equal(onlineTarget.listeners.size,1);
    const offlineSummary=await mail.drain();
    assert.equal(offlineSummary.pending,1);
    assert.equal(deliveries,0);

    online=true;
    onlineTarget.dispatchOnline();
    await Promise.resolve();
    await mail.drain({reason:'manual'});
    assert.equal((await mail.getOutboxRecord(queued.reportKey)).state,'accepted');
    assert.equal(deliveries,1);
    assert.equal((await mail.listOutbox()).length,1);
    assert.deepEqual(
        committedStates
            .filter(function sameReport(entry){return entry.reportKey===queued.reportKey;})
            .map(function committedState(entry){return entry.state;}),
        ['queued','sending','accepted']
    );
    assert.equal(committedStates.every(function stateWasDurable(entry){
        return entry.state===entry.durableState;
    }),true);
    assert.equal(deliveryEvents.some(function acceptedDelivery(event){
        return event.reportKey===queued.reportKey&&event.outcome==='accepted';
    }),true);
    mail.stop();
    assert.equal(onlineTarget.listeners.size,0);
    mail.dispose();
});

test('error mail uses the same durable outbox path and preserves established formatting',async function durableErrorMail(){
    const storage=new MemoryMailStorage();
    let request=null;
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 3_000;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:async function deliver(value){
            request=value;
            return accepted('request-error','provider-error');
        }
    });

    const result=await mail.send(
        [],
        'Runtime error',
        {code:'SYNTHETIC_FAILURE'},
        'plain',
        'error'
    );
    const record=await mail.getOutboxRecord(result.reportKey);
    assert.equal(record.serializedReport,request.serializedReport);
    assert.equal(request.report.type,'error');
    assert.equal(request.report.subject,'Runtime error');
    assert.match(request.report.text,/^mail-test application error\n\n/u);
    assert.match(request.report.text,/SYNTHETIC_FAILURE/u);
    assert.equal(result.state,'accepted');
    mail.dispose();
});

test('Mail preserves exact subject, payload, and profile content',async function completeRuntimeContent(){
    const storage=new MemoryMailStorage();
    let request=null;
    const exactSubject='  Runtime\nsubject\u0000  ';
    const exactUser='  profile\nuser\u0000  ';
    const exactBody='  body\ncontent\u0000\u007f  ';
    const mail=new Mail(mailConfig(),{
        storage,
        includeContext:true,
        user:{
            email:'profile@example.com',
            language:'complete',
            phone:'complete',
            username:exactUser,
            async load(){}
        },
        clock:function clock(){return 3_250;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:async function deliver(value){
            request=value;
            return accepted('request-complete-content','provider-complete-content');
        }
    });
    const result=await mail.send(
        ['complete@example.com'],
        exactSubject,
        {body:exactBody},
        'plain',
        'report'
    );
    assert.equal(request.report.subject,`${exactSubject} - ${exactUser}`);
    const rendered=JSON.parse(request.report.text.split('\n\nPhone:')[0]);
    assert.equal(rendered.subject,exactSubject);
    assert.equal(rendered.source_user,exactUser);
    assert.equal(rendered.body,exactBody);
    assert.equal(result.report.subject,request.report.subject);
    assert.equal(Object.isFrozen(result),false);
    assert.equal(Object.isFrozen(result.report),false);
    mail.dispose();
});

test('configured HTTP transport takes precedence over a native bridge',async function preferConfiguredHttp(){
    const storage=new MemoryMailStorage();
    const previousArcane=globalThis.Arcane;
    const previousFetch=globalThis.fetch;
    let nativeCalls=0;
    let httpRequest=null;
    globalThis.Arcane={
        mail:{
            async send(){
                nativeCalls+=1;
                throw new Error('native bridge should not be selected');
            }
        }
    };
    globalThis.fetch=async function acceptSyntheticGatewayRequest(url,options){
        httpRequest={url,options};
        return new Response(JSON.stringify({
            requestId:'request-http-preferred',
            status:'accepted',
            accepted:1,
            rejected:0,
            providerId:'provider-http-preferred'
        }),{
            headers:{'content-type':'application/json'},
            status:202
        });
    };
    const mail=new Mail({
        appName:'mail-test',
        appKey:'synthetic-local-app-key',
        endpoint:'https://mail.invalid/v1/mail'
    },{
        storage,
        user:null,
        clock:function clock(){return 3_500;},
        isOnline:function online(){return true;},
        onlineTarget:null
    });
    try{
        const result=await mail.send(
            ['http@example.com'],
            'HTTP preferred',
            {kind:'synthetic'},
            '',
            'report'
        );
        assert.equal(result.state,'accepted');
        assert.equal(result.providerId,'provider-http-preferred');
        assert.equal(nativeCalls,0);
        assert.equal(httpRequest.url,'https://mail.invalid/v1/mail');
        assert.equal(
            httpRequest.options.headers['Idempotency-Key'],
            result.reportKey
        );
    }finally{
        mail.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
        globalThis.fetch=previousFetch;
    }
});

test('native bridge acceptance retains its exact authority without a fabricated provider id',async function nativeAcceptance(){
    const storage=new MemoryMailStorage();
    const previousArcane=globalThis.Arcane;
    globalThis.Arcane={
        mail:{
            async send(){
                return {
                    requestId:'request-native-accepted',
                    status:'accepted',
                    statusCode:202,
                    sent:true,
                    partial:false,
                    uncertain:false
                };
            }
        }
    };
    const mail=new Mail({appName:'mail-test',endpoint:''},{
        storage,
        user:null,
        clock:function clock(){return 3_600;},
        isOnline:function online(){return true;},
        onlineTarget:null
    });
    try{
        const result=await mail.send(
            ['native@example.com'],
            'Native accepted',
            {kind:'synthetic'},
            '',
            'report'
        );
        assert.equal(result.state,'accepted');
        assert.equal(result.providerId,null);
        assert.equal(result.acceptanceAuthority,'arcane-core-mail-send-v1');
        const record=await mail.getOutboxRecord(result.reportKey);
        assert.equal(record.result.providerId,null);
        assert.equal(record.result.acceptanceAuthority,'arcane-core-mail-send-v1');
    }finally{
        mail.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
    }
});

test('a malformed native result remains uncertain under the same report key',async function nativeAcceptanceValidation(){
    const storage=new MemoryMailStorage();
    const previousArcane=globalThis.Arcane;
    globalThis.Arcane={
        mail:{
            async send(){
                return {
                    requestId:'request-native-invalid',
                    status:'accepted',
                    statusCode:202,
                    sent:true,
                    partial:true,
                    uncertain:false
                };
            }
        }
    };
    const mail=new Mail({appName:'mail-test',endpoint:''},{
        storage,
        user:null,
        clock:function clock(){return 3_700;},
        isOnline:function online(){return true;},
        onlineTarget:null
    });
    try{
        const result=await mail.send(
            ['native@example.com'],
            'Native invalid',
            {kind:'synthetic'},
            '',
            'report'
        );
        assert.equal(result.state,'retry_wait');
        assert.equal(result.uncertain,true);
        const record=await mail.getOutboxRecord(result.reportKey);
        assert.equal(record.result,null);
        assert.equal(record.failure.code,'MAIL_NATIVE_RESULT_INVALID');
        assert.equal(record.failure.retryable,true);
        assert.equal(record.failure.uncertain,true);
    }finally{
        mail.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
    }
});

test('temporary native transport unavailability remains retryable',async function nativeTransportUnavailable(){
    const storage=new MemoryMailStorage();
    const previousArcane=globalThis.Arcane;
    globalThis.Arcane={
        mail:{
            async send(){
                const error=new Error('synthetic native transport unavailable');
                error.code='ARCANE_TRANSPORT_UNAVAILABLE';
                throw error;
            }
        }
    };
    const mail=new Mail({appName:'mail-test',endpoint:''},{
        storage,
        user:null,
        clock:function clock(){return 3_750;},
        isOnline:function online(){return true;},
        onlineTarget:null
    });
    try{
        const result=await mail.send(
            ['native@example.com'],
            'Native transport unavailable',
            {kind:'synthetic'},
            '',
            'report'
        );
        assert.equal(result.state,'retry_wait');
        assert.equal(result.uncertain,false);
        const record=await mail.getOutboxRecord(result.reportKey);
        assert.equal(record.failure.code,'ARCANE_TRANSPORT_UNAVAILABLE');
        assert.equal(record.failure.retryable,true);
        assert.equal(record.failure.uncertain,false);
    }finally{
        mail.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
    }
});

test('native timeout remains uncertain and retryable under the same report key',async function nativeUncertainFailure(){
    const storage=new MemoryMailStorage();
    const previousArcane=globalThis.Arcane;
    globalThis.Arcane={
        mail:{
            async send(){
                const error=new Error('synthetic native timeout');
                error.code='MAIL_SEND_TIMEOUT';
                error.status=504;
                throw error;
            }
        }
    };
    const mail=new Mail({appName:'mail-test',endpoint:''},{
        storage,
        user:null,
        clock:function clock(){return 3_800;},
        isOnline:function online(){return true;},
        onlineTarget:null
    });
    try{
        const result=await mail.send(
            ['native@example.com'],
            'Native uncertain',
            {kind:'synthetic'},
            '',
            'report'
        );
        assert.equal(result.state,'retry_wait');
        assert.equal(result.uncertain,true);
        const record=await mail.getOutboxRecord(result.reportKey);
        assert.equal(record.failure.code,'MAIL_SEND_TIMEOUT');
        assert.equal(record.failure.retryable,true);
        assert.equal(record.failure.uncertain,true);
        assert.equal(record.failure.statusCode,504);
    }finally{
        mail.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
    }
});

test('exact native acceptance remains authoritative across a dispose race',async function nativeAcceptanceAfterDispose(){
    const storage=new MemoryMailStorage();
    const previousArcane=globalThis.Arcane;
    let mail=null;
    globalThis.Arcane={
        mail:{
            async send(){
                mail.dispose();
                return {
                    requestId:'request-native-dispose',
                    status:'accepted',
                    statusCode:202,
                    sent:true,
                    partial:false,
                    uncertain:false
                };
            }
        }
    };
    mail=new Mail({appName:'mail-test',endpoint:''},{
        storage,
        user:null,
        clock:function clock(){return 3_900;},
        isOnline:function online(){return true;},
        onlineTarget:null
    });
    try{
        const result=await mail.send(
            ['native@example.com'],
            'Native accepted before dispose',
            {kind:'synthetic'},
            '',
            'report'
        );
        assert.equal(result.state,'accepted');
        assert.equal(result.acceptanceAuthority,'arcane-core-mail-send-v1');
        const records=[...storage.table('mail_outbox').values()];
        assert.equal(records.length,1);
        assert.equal(records[0].state,'accepted');
    }finally{
        if(mail&&!mail.disposed) mail.dispose();
        if(previousArcane===undefined) delete globalThis.Arcane;
        else globalThis.Arcane=previousArcane;
    }
});

test('Mail event detail is synchronous, observational, and complete',async function completeEventDetail(){
    const storage=new MemoryMailStorage();
    const details=[];
    const privateValues=[
        'private.person@example.com',
        'Private event subject',
        'synthetic-secret-body',
        'request-private-event',
        'provider-private-event',
        'C:\\private\\mail'
    ];
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 4_000;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:async function deliver(){
            return accepted('request-private-event','provider-private-event');
        }
    });
    for(const type of ['mail-outbox-state','mail-outbox-delivery','mail-outbox-drain']){
        mail.events.addEventListener(type,function collectMailEvent(event){
            details.push({type:event.type,detail:event.detail});
        });
    }

    await mail.send(
        ['private.person@example.com'],
        'Private event subject',
        {body:'synthetic-secret-body',path:'C:\\private\\mail'},
        '',
        'report'
    );
    assert.ok(details.some(function hasDeliveryEvent(event){
        return event.type==='mail-outbox-delivery'&&event.detail.outcome==='accepted';
    }));
    const serializedEvents=JSON.stringify(details);
    for(const value of privateValues) assert.equal(serializedEvents.includes(value),true);
    assert.equal(serializedEvents.includes('stack'),false);
    assert.equal(serializedEvents.includes('credential'),false);
    mail.dispose();
});

test('Mail start, stop, restart, and dispose own one online listener and event source',async function lifecycleTeardown(){
    const storage=new MemoryMailStorage();
    const onlineTarget=new OnlineTarget();
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 5_000;},
        isOnline:function online(){return false;},
        onlineTarget,
        deliver:async function deliver(){return accepted();}
    });

    await mail.start();
    await mail.start();
    assert.equal(mail.started,true);
    assert.equal(onlineTarget.listeners.size,1);
    mail.stop();
    assert.equal(mail.started,false);
    assert.equal(onlineTarget.listeners.size,0);
    await mail.start();
    assert.equal(onlineTarget.listeners.size,1);
    assert.equal(mail.dispose(),true);
    assert.equal(mail.dispose(),false);
    assert.equal(mail.events.disposed,true);
    assert.equal(onlineTarget.listeners.size,0);
    await assert.rejects(
        mail.listOutbox(),
        function disposedMail(error){return error?.code==='MAIL_DISPOSED';}
    );
});

test('window Mail singleton reconfigures only before use and recovers after disposal',async function windowSingletonRecovery(){
    const previousWindow=globalThis.window;
    const hadWindow=Object.hasOwn(globalThis,'window');
    globalThis.window={};
    try{
        const first=new Mail(mailConfig(),{
            storage:new MemoryMailStorage(),
            user:null,
            isOnline:function online(){return false;},
            onlineTarget:null,
            deliver:async function deliver(){return accepted();}
        });
        assert.equal(globalThis.window.mail,first);
        const reconfigured=new Mail({
            appName:'mail-reconfigured',
            endpoint:'https://mail.invalid/v1/mail'
        },{
            storage:new MemoryMailStorage(),
            user:null,
            isOnline:function online(){return false;},
            onlineTarget:null,
            deliver:async function deliver(){return accepted();}
        });
        assert.equal(reconfigured,first);
        assert.equal(first.appName,'mail-reconfigured');
        await first.start();
        assert.throws(
            function rejectLiveReconfiguration(){
                return new Mail(mailConfig(),{
                    storage:new MemoryMailStorage(),
                    user:null,
                    isOnline:function online(){return false;},
                    onlineTarget:null,
                    deliver:async function deliver(){return accepted();}
                });
            },
            function configurationLocked(error){return error?.code==='MAIL_CONFIGURATION_LOCKED';}
        );
        assert.equal(first.dispose(),true);
        assert.equal(globalThis.window.mail,null);

        const recovered=new Mail(mailConfig(),{
            storage:new MemoryMailStorage(),
            user:null,
            isOnline:function online(){return false;},
            onlineTarget:null,
            deliver:async function deliver(){return accepted();}
        });
        assert.notEqual(recovered,first);
        assert.equal(globalThis.window.mail,recovered);
        recovered.dispose();
    }finally{
        if(hadWindow) globalThis.window=previousWindow;
        else delete globalThis.window;
    }
});

test('window Mail singleton reports an incompatible owner',function windowSingletonConflict(){
    const previousWindow=globalThis.window;
    const hadWindow=Object.hasOwn(globalThis,'window');
    const foreignMail={external:true};
    globalThis.window={mail:foreignMail};
    try{
        assert.throws(
            function rejectForeignMailOwner(){
                return new Mail(mailConfig(),{
                    storage:new MemoryMailStorage(),
                    user:null,
                    isOnline:function online(){return false;},
                    onlineTarget:null,
                    deliver:async function deliver(){return accepted();}
                });
            },
            function singletonConflict(error){return error?.code==='MAIL_SINGLETON_CONFLICT';}
        );
        assert.equal(globalThis.window.mail,foreignMail);
    }finally{
        if(hadWindow) globalThis.window=previousWindow;
        else delete globalThis.window;
    }
});

test('a caller joining Mail start observes its own cancellation',async function joinedStartCancellation(){
    let releaseStorage;
    const storageReady=new Promise(function waitForStorage(resolve){
        releaseStorage=resolve;
    });
    const storage=new MemoryMailStorage({readyPromise:storageReady});
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 5_250;},
        isOnline:function online(){return false;},
        onlineTarget:null,
        deliver:async function deliver(){return accepted();}
    });
    const first=mail.start();
    const controller=new AbortController();
    const joined=mail.start({signal:controller.signal});
    controller.abort(new Error('synthetic joined start cancellation'));

    await assert.rejects(joined,function joinedStartAborted(error){
        return error?.name==='AbortError'&&error?.code==='MAIL_OUTBOX_ABORTED';
    });
    releaseStorage();
    await first;
    assert.equal(mail.started,true);
    mail.dispose();
});

test('Mail restart does not join the cancelled prior start generation',async function restartAfterCancelledStart(){
    let releaseStorage;
    const storageReady=new Promise(function waitForStorage(resolve){
        releaseStorage=resolve;
    });
    const storage=new MemoryMailStorage({readyPromise:storageReady});
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 5_400;},
        isOnline:function online(){return false;},
        onlineTarget:null,
        deliver:async function deliver(){return accepted();}
    });
    const first=mail.start();
    mail.stop();
    const firstCancelled=assert.rejects(first,function firstGenerationCancelled(error){
        return error?.name==='AbortError'&&error?.code==='MAIL_OUTBOX_ABORTED';
    });
    const restarted=mail.start();
    releaseStorage();

    await firstCancelled;
    await restarted;
    assert.equal(mail.started,true);
    mail.dispose();
});

test('Mail dispose aborts an in-flight owned send after preserving uncertain retry state',async function disposeInFlight(){
    const storage=new MemoryMailStorage();
    let observedSignal=null;
    let announceDelivery;
    const deliveryStarted=new Promise(function awaitDeliveryStart(resolve){
        announceDelivery=resolve;
    });
    const mail=new Mail(mailConfig(),{
        storage,
        user:null,
        clock:function clock(){return 5_500;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:function deliver(request){
            observedSignal=request.signal;
            announceDelivery();
            return new Promise(function waitForMailAbort(resolve,reject){
                request.signal.addEventListener('abort',function rejectAbortedDelivery(){
                    const error=new Error('synthetic delivery aborted');
                    error.name='AbortError';
                    reject(error);
                },{once:true});
            });
        }
    });
    const sendPromise=mail.send(
        ['abort@example.com'],
        'Abort in flight',
        {kind:'synthetic'},
        '',
        'report'
    );
    await deliveryStarted;
    assert.equal(observedSignal.aborted,false);
    assert.equal(mail.dispose(),true);
    assert.equal(observedSignal.aborted,true);
    await assert.rejects(sendPromise,function ownedSendAborted(error){
        return error?.name==='AbortError'&&error?.code==='MAIL_OUTBOX_ABORTED';
    });
    const records=[...storage.table('mail_outbox').values()];
    assert.equal(records.length,1);
    assert.equal(records[0].state,'retry_wait');
    assert.equal(records[0].failure.retryable,true);
    assert.equal(records[0].failure.uncertain,true);
});

test('Mail reports required storage and transport configuration failures',async function storageAndConfigFailures(){
    const invalidStorageMail=new Mail(mailConfig(),{
        storage:{},
        user:null,
        isOnline:function online(){return false;},
        onlineTarget:null,
        deliver:async function deliver(){return accepted();}
    });
    await assert.rejects(
        invalidStorageMail.start(),
        function missingStorageMethods(error){
            return error?.code==='MAIL_OUTBOX_STORAGE_UNAVAILABLE';
        }
    );
    invalidStorageMail.dispose();

    const unconfiguredMail=new Mail({appName:'mail-test',endpoint:''},{
        storage:new MemoryMailStorage(),
        user:null,
        isOnline:function online(){return false;},
        onlineTarget:null
    });
    await assert.rejects(
        unconfiguredMail.start(),
        function missingTransport(error){return error?.code==='MAIL_NOT_CONFIGURED';}
    );
    unconfiguredMail.dispose();

    const storage=new MemoryMailStorage();
    const optionalUserMail=new Mail(mailConfig(),{
        storage,
        user:{
            async load(){throw new Error('synthetic profile failure');}
        },
        clock:function clock(){return 6_000;},
        isOnline:function online(){return true;},
        onlineTarget:null,
        deliver:async function deliver(){
            return accepted('request-profile','provider-profile');
        }
    });
    const result=await optionalUserMail.send(
        ['profile@example.com'],
        'Profile fallback',
        {kind:'synthetic'},
        '',
        'report'
    );
    assert.equal(result.state,'accepted');
    optionalUserMail.dispose();
});
