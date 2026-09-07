import Is from 'strong-type';
const is=new Is(false);

import {createArcaneEventSource} from 'arcane-os/event-manager';
import MailOutbox from './MailOutbox.mjs';
import {
    sendMailReport,
} from './MailTransport.mjs';

const MAIL_TYPES=new Set(['error','report','crisis_detected']);
const MAIL_OUTBOX_EVENTS=[
    'mail-outbox-state',
    'mail-outbox-delivery',
    'mail-outbox-drain'
];
const PENDING_OUTBOX_STATES=new Set(['queued','sending','retry_wait']);
const NATIVE_MAIL_RESPONSE_STATUS_CODES={
    accepted:202,
    delivery_uncertain:207,
    partially_accepted:207
};
const NATIVE_MAIL_REQUEST_ID_PATTERN=/^[A-Za-z0-9-]+$/;
const NATIVE_MAIL_UNCERTAIN_ERROR_CODES=new Set([
    'ARCANE_REQUEST_TIMEOUT',
    'MAIL_GATEWAY_RESPONSE_INVALID',
    'MAIL_GATEWAY_UNAVAILABLE',
    'MAIL_NATIVE_RESULT_INVALID',
    'MAIL_SEND_TIMEOUT',
    'NATIVE_BRIDGE_ACK_TIMEOUT'
]);
const NATIVE_MAIL_RETRYABLE_ERROR_CODES=new Set([
    'ARCANE_BRIDGE_CALL_FAILED',
    'ARCANE_TRANSPORT_UNAVAILABLE'
]);
const EMAIL_PATTERN=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function codedError(message,code,ErrorType=Error){
    const error=new ErrorType(message);
    error.code=code;
    return error;
}

function validateMailSignal(signal){
    if(signal===null||signal===undefined) return null;
    if(!is.object(signal)
        ||!is.boolean(signal.aborted)
        ||!is.function(signal.addEventListener)
        ||!is.function(signal.removeEventListener)){
        throw new TypeError('Mail signal must be an AbortSignal');
    }
    return signal;
}

function throwIfMailAborted(signal){
    if(!signal?.aborted) return;
    const error=codedError('Mail operation was aborted.','MAIL_OUTBOX_ABORTED');
    error.name='AbortError';
    if(signal.reason!==undefined) error.cause=signal.reason;
    throw error;
}

function linkedMailSignal(primary,secondary){
    const signals=[];
    for(const candidate of [primary,secondary]){
        const signal=validateMailSignal(candidate);
        if(signal&&!signals.includes(signal)) signals.push(signal);
    }
    if(signals.length===0){
        return {signal:null,dispose:function disposeEmptyMailSignal(){}};
    }
    if(signals.length===1){
        return {signal:signals[0],dispose:function disposeSingleMailSignal(){}};
    }
    const controller=new AbortController();
    const listeners=[];
    for(const signal of signals){
        const listener=function forwardLinkedMailAbort(){
            if(!controller.signal.aborted) controller.abort(signal.reason);
        };
        listeners.push({signal,listener});
        if(signal.aborted) listener();
        else signal.addEventListener('abort',listener,{once:true});
    }
    return {
        signal:controller.signal,
        dispose:function disposeLinkedMailSignal(){
            for(const entry of listeners){
                entry.signal.removeEventListener('abort',entry.listener);
            }
        }
    };
}

function waitForMailOperation(operation,signal){
    const normalizedSignal=validateMailSignal(signal);
    throwIfMailAborted(normalizedSignal);
    if(!normalizedSignal) return operation;
    return new Promise(function observeMailCallerAbort(resolve,reject){
        let settled=false;
        function finish(callback,value){
            if(settled) return;
            settled=true;
            normalizedSignal.removeEventListener('abort',handleAbort);
            callback(value);
        }
        function handleAbort(){
            try{
                throwIfMailAborted(normalizedSignal);
            }catch(error){
                finish(reject,error);
            }
        }
        normalizedSignal.addEventListener('abort',handleAbort,{once:true});
        Promise.resolve(operation).then(
            finish.bind(null,resolve),
            finish.bind(null,reject)
        );
        if(normalizedSignal.aborted) handleAbort();
    });
}

function exactNativeMailResult(value){
    if(!value||!is.object(value)||is.array(value)
        ||!is.string(value.requestId)
        ||!NATIVE_MAIL_REQUEST_ID_PATTERN.test(value.requestId)
        ||!Object.hasOwn(NATIVE_MAIL_RESPONSE_STATUS_CODES,value.status)
        ||value.statusCode!==NATIVE_MAIL_RESPONSE_STATUS_CODES[value.status]
        ||!is.boolean(value.sent)
        ||!is.boolean(value.partial)
        ||!is.boolean(value.uncertain)
        ||value.sent!==(value.status==='accepted')
        ||value.partial!==(value.status==='partially_accepted')
        ||value.uncertain!==(value.status==='delivery_uncertain')){
        throw codedError(
            'Native Arcane mail returned an invalid result.',
            'MAIL_NATIVE_RESULT_INVALID'
        );
    }
    if(value.status!=='accepted') return value;
    return {
        ...value,
        acceptanceAuthority:'arcane-core-mail-send-v1'
    };
}

function normalizedNativeMailError(error){
    const uncertain=NATIVE_MAIL_UNCERTAIN_ERROR_CODES.has(error?.code);
    const retryable=uncertain||NATIVE_MAIL_RETRYABLE_ERROR_CODES.has(error?.code);
    if(!retryable) return error;
    const normalized=new Error(
        is.string(error?.message)&&error.message
            ?error.message
            :uncertain
                ?'Native Arcane mail delivery has an uncertain outcome.'
                :'Native Arcane mail transport is temporarily unavailable.',
        {cause:error}
    );
    Object.assign(normalized,error);
    normalized.code=error?.code;
    normalized.retryable=true;
    normalized.uncertain=uncertain;
    const statusCode=Number(error?.statusCode??error?.status);
    if(is.safeInteger(statusCode)&&statusCode>=100&&statusCode<=599){
        normalized.statusCode=statusCode;
    }
    return normalized;
}

async function loadRequiredMailStorage(){
    try{
        await import('./DBOPFS.js');
    }catch{
        throw codedError(
            'Mail outbox storage is unavailable.',
            'MAIL_OUTBOX_STORAGE_UNAVAILABLE'
        );
    }
    const storage=globalThis.dbopfs;
    if(!storage||!is.object(storage)){
        throw codedError(
            'Mail outbox storage is unavailable.',
            'MAIL_OUTBOX_STORAGE_UNAVAILABLE'
        );
    }
    return storage;
}

async function resolveMailUserEntity(injectedUser){
    if(injectedUser!==undefined) return injectedUser;
    if(globalThis.window?.user) return globalThis.window.user;
    const {default:UserEntity}=await import('../entities/User.js');
    return new UserEntity();
}

function declaredApplicationId(document=globalThis.document){
    const appName=document?.querySelector?.('meta[name="arcane-app-id"]')?.content;
    return is.string(appName)?appName:'';
}

function defaultMailEndpoint(location=globalThis.location){
    if(!location||!['http:','https:'].includes(location.protocol)){
        return '';
    }
    return new URL('/v1/mail',location.origin).href;
}

export function resolveMailConfig(
    config=globalThis.arcane?.config?.mail||{},
    {document=globalThis.document,location=globalThis.location}={}
){
    const supplied=config&&is.object(config)&&!is.array(config)?config:{};
    const appName=is.string(supplied.appName)
        ? supplied.appName
        : declaredApplicationId(document);
    return {
        appName,
        subscriptionKey:supplied.subscriptionKey,
        endpoint:is.string(supplied.endpoint)
            ? supplied.endpoint
            : defaultMailEndpoint(location),
        requestTimeout:is.finite(supplied.requestTimeout)
            ? supplied.requestTimeout
            : null,
    };
}

function escapeHtml(value){
    return String(value)
        .replaceAll('&','&amp;')
        .replaceAll('<','&lt;')
        .replaceAll('>','&gt;')
        .replaceAll('"','&quot;')
        .replaceAll("'",'&#39;');
}

function clonePayload(value){
    if(is.function(globalThis.structuredClone)){
        return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}

function serializePayload(value){
    try{
        return JSON.stringify(value,null,2);
    }catch(error){
        const failure=codedError(
            'Mail payload must be completely JSON serializable.',
            'MAIL_PAYLOAD_NOT_SERIALIZABLE',
            TypeError
        );
        failure.cause=error;
        throw failure;
    }
}

let reportNonceSequence=0;

function randomReportNonce(cryptoProvider){
    if(is.function(cryptoProvider?.randomUUID)){
        try{
            const value=cryptoProvider.randomUUID();
            if(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)){
                return value;
            }
        }catch{}
    }
    reportNonceSequence+=1;
    return `${Date.now().toString(36)}-${reportNonceSequence.toString(36)}`;
}

function createReportKey(timestamp,cryptoProvider){
    return `${timestamp.toString(36)}-${randomReportNonce(cryptoProvider)}-mail`;
}

function normalizeRecipients(values){
    if(!is.array(values)){
        throw new TypeError('Mail recipients must be an array');
    }
    const recipients=[];
    for(const value of values){
        if(!is.string(value)){
            throw new TypeError('Every mail recipient must be an email address');
        }
        const address=value.trim().toLowerCase();
        if(address.length>254||!EMAIL_PATTERN.test(address)){
            throw new TypeError('Mail contains an invalid recipient address');
        }
        recipients.push(address);
    }
    return recipients;
}

function profileValue(user,key){
    try{
        const value=user?.[key];
        return is.string(value)?value:'';
    }catch{
        return '';
    }
}

function normalizedDeliveryResult(value){
    if(!value||!is.object(value)||is.array(value)) return value;
    let status=is.string(value.status)?value.status:'';
    if(!status&&value.sent===true) status='accepted';
    let classification=is.string(value.classification)?value.classification:'';
    if(!classification){
        classification={
            accepted:'accepted',
            delivery_uncertain:'ambiguous',
            retryable:'retryable',
            partially_accepted:'permanent',
            permanently_rejected:'permanent'
        }[status]||'';
    }
    const retryAfterMilliseconds=Number(value.retryAfterMs);
    const retryAfterSeconds=is.safeInteger(value.retryAfterSeconds)
        ? value.retryAfterSeconds
        : is.finite(retryAfterMilliseconds)&&retryAfterMilliseconds>0
            ? Math.ceil(retryAfterMilliseconds/1000)
            : null;
    return {
        ...value,
        ...(status?{status}:{}),
        ...(classification?{classification}:{}),
        retryAfterSeconds,
    };
}

function publicSendResult(record){
    return {
        ...record,
        ...(record.result||{}),
        report:JSON.parse(record.serializedReport),
        reportKey:record.reportKey,
        state:record.state,
        status:record.result?.status||record.state,
        queued:PENDING_OUTBOX_STATES.has(record.state),
        sent:record.state==='accepted',
        uncertain:record.failure?.uncertain===true,
        attempts:record.attempts,
    };
}

function safeDrainDetail(summary){
    return {
        ...summary,
        records:[...summary.records],
        invalidRecords:[...summary.invalidRecords],
        states:{...summary.states}
    };
}

function normalizeMailOptions(options){
    if(!options||!is.object(options)||is.array(options)){
        throw new TypeError('Mail options must be an object');
    }
    const deliver=options.deliver;
    const clock=options.clock??Date.now;
    const isOnline=options.isOnline??function defaultMailOnlineStatus(){
        return globalThis.navigator?.onLine!==false;
    };
    const onlineTarget=options.onlineTarget===undefined
        ?is.function(globalThis.addEventListener)?globalThis:null
        :options.onlineTarget;
    const includeContext=options.includeContext??false;
    const cryptoProvider=Object.hasOwn(options,'crypto')
        ?options.crypto
        :globalThis.crypto;
    if(deliver!==undefined&&!is.function(deliver)){
        throw new TypeError('Mail deliver must be a function');
    }
    if(!is.function(clock)||!is.function(isOnline)){
        throw new TypeError('Mail clock and isOnline hooks must be functions');
    }
    if(onlineTarget!==null&&(
        !is.function(onlineTarget?.addEventListener)
        ||!is.function(onlineTarget?.removeEventListener)
    )){
        throw new TypeError('Mail onlineTarget must be an EventTarget');
    }
    if(!is.boolean(includeContext)){
        throw new TypeError('Mail includeContext must be boolean');
    }
    if(cryptoProvider!==null&&cryptoProvider!==undefined
        &&!is.object(cryptoProvider)){
        throw new TypeError('Mail crypto must be a Web Crypto provider');
    }
    return {
        clock,
        cryptoProvider,
        deliver,
        includeContext,
        isOnline,
        onlineTarget,
        outboxOptions:{
            ...(options.lockManager===undefined?{}:{lockManager:options.lockManager}),
        },
        storage:options.storage,
        storageInjected:Object.hasOwn(options,'storage'),
        user:Object.hasOwn(options,'user')?options.user:undefined
    };
}

class Mail {
    #backgroundController=null;
    #backgroundDrain=null;
    #backgroundError=null;
    #clock;
    #cryptoProvider;
    #deliver;
    #disposed=false;
    #events;
    #includeContext=false;
    #isOnline;
    #lifecycleController=new AbortController();
    #lifecycleRevision=0;
    #onlineHandler;
    #onlineTarget;
    #outbox=null;
    #outboxOptions;
    #outboxPromise=null;
    #startPromise=null;
    #startRevision=null;
    #startSummary=null;
    #started=false;
    #storage;
    #storageInjected;
    #user;

    constructor(config=globalThis.arcane?.config?.mail||{},options={}) {
        const resolved=resolveMailConfig(config);
        const normalizedOptions=normalizeMailOptions(options);
        const existing=globalThis.window?.mail;
        if(existing instanceof Mail){
            if(!existing.disposed){
                if(arguments.length>0){
                    existing.#applyConfiguration(resolved,normalizedOptions,{reconfigure:true});
                }
                return existing;
            }
            if(globalThis.window.mail===existing) globalThis.window.mail=null;
        }else if(existing){
            throw codedError(
                'window.mail is already owned by an incompatible implementation.',
                'MAIL_SINGLETON_CONFLICT'
            );
        }

        this.#applyConfiguration(resolved,normalizedOptions);
        this.#onlineHandler=this.#handleOnline.bind(this);
        this.#events=createArcaneEventSource(this,{
            source:'mail-outbox',
            eventTypes:MAIL_OUTBOX_EVENTS
        });
        if(globalThis.window&&!globalThis.window.mail) globalThis.window.mail=this;
    }

    #applyConfiguration(resolved,options,{reconfigure=false}={}){
        if(reconfigure&&(this.#started||this.#startPromise||this.#outbox||this.#outboxPromise)){
            throw codedError(
                'Mail configuration is locked after its durable lifecycle begins.',
                'MAIL_CONFIGURATION_LOCKED'
            );
        }
        this.appName=resolved.appName;
        this.subscriptionKey=resolved.subscriptionKey;
        this.endpoint=resolved.endpoint;
        this.requestTimeout=resolved.requestTimeout;
        this.#storageInjected=options.storageInjected;
        this.#storage=options.storage;
        this.#deliver=options.deliver;
        this.#clock=options.clock;
        this.#cryptoProvider=options.cryptoProvider;
        this.#includeContext=options.includeContext;
        this.#isOnline=options.isOnline;
        this.#onlineTarget=options.onlineTarget;
        this.#outboxOptions=options.outboxOptions;
        this.#user=options.user;
    }

    get started(){return this.#started;}
    get disposed(){return this.#disposed;}
    get events(){return this.#events;}
    get invalidOutboxRecords(){
        return this.#outbox?.invalidRecords??[];
    }
    get lastBackgroundError(){return this.#backgroundError;}

    #assertActive(){
        if(this.#disposed){
            throw codedError('Mail has been disposed.','MAIL_DISPOSED');
        }
    }

    #assertConfigured(){
        const hasTransport=this.#deliver!==undefined
            ||is.function(globalThis.Arcane?.mail?.send)
            ||Boolean(this.endpoint);
        if(!this.appName||!hasTransport){
            throw codedError('Mail transport is not configured.','MAIL_NOT_CONFIGURED');
        }
    }

    #activeLifecycleSignal(){
        if(this.#lifecycleController.signal.aborted){
            this.#lifecycleController=new AbortController();
        }
        return this.#lifecycleController.signal;
    }

    #time(){
        const value=this.#clock();
        const milliseconds=value instanceof Date?value.getTime():Number(value);
        if(!is.safeInteger(milliseconds)||milliseconds<0
            ||is.NaN(new Date(milliseconds).getTime())){
            throw codedError('Mail clock returned an invalid time.','MAIL_CLOCK_INVALID');
        }
        return milliseconds;
    }

    #publish(type,detail,operationId=null){
        if(this.#disposed||this.#events.disposed) return;
        try{
            this.#events.dispatch(type,detail,{operationId,publicDetail:detail});
        }catch{}
    }

    #publishState(detail,operationId=null){
        this.#publish('mail-outbox-state',{...detail},operationId);
    }

    #publishRecord(record){
        const stateDetail={
            ...record,
            pending:PENDING_OUTBOX_STATES.has(record.state)
        };
        this.#publish('mail-outbox-state',stateDetail,record.reportKey);
        if(record.attempts<1||record.state==='queued'||record.state==='sending') return;
        const outcome={
            accepted:'accepted',
            retry_wait:'retry',
            failed:'failed',
            reconciliation_required:'reconciliation_required'
        }[record.state];
        if(!outcome) return;
        this.#publish('mail-outbox-delivery',{
            ...record,
            outcome,
            uncertain:record.failure?.uncertain===true
        },record.reportKey);
    }

    #handleOutboxRecord(record){
        this.#publishRecord(record);
    }

    async #transportDelivery(request){
        if(this.#deliver) return this.#deliver(request);
        if(this.endpoint){
            throwIfMailAborted(request.signal);
            let subscriptionKey=this.subscriptionKey;
            if(subscriptionKey===undefined){
                const user=await resolveMailUserEntity(this.#user);
                throwIfMailAborted(request.signal);
                if(is.function(user?.load)){
                    await waitForMailOperation(user.load(),request.signal);
                }
                subscriptionKey=user?.subscription_key;
            }
            throwIfMailAborted(request.signal);
            return sendMailReport({
                subscriptionKey,
                appName:this.appName,
                endpoint:this.endpoint,
                report:request.report,
                reportKey:request.reportKey,
                requestTimeout:this.requestTimeout,
                serializedReport:request.serializedReport,
                ...(request.signal?{signal:request.signal}:{})
            });
        }
        try{
            const result=await globalThis.Arcane.mail.send({
                report:request.report,
                reportKey:request.reportKey
            });
            return exactNativeMailResult(result);
        }catch(error){
            throw normalizedNativeMailError(error);
        }
    }

    async #deliverOutboxRecord(request){
        return normalizedDeliveryResult(await this.#transportDelivery(request));
    }

    async #createOutbox(){
        let storage=this.#storage;
        if(!this.#storageInjected) storage=await loadRequiredMailStorage();
        const outbox=new MailOutbox({
            storage,
            deliver:this.#deliverOutboxRecord.bind(this),
            clock:this.#clock,
            isOnline:this.#isOnline,
            onRecordCommitted:this.#handleOutboxRecord.bind(this),
            onlineTarget:null,
            ...this.#outboxOptions
        });
        this.#outbox=outbox;
        return outbox;
    }

    async #getOutbox(){
        this.#assertActive();
        if(this.#outbox) return this.#outbox;
        if(!this.#outboxPromise) this.#outboxPromise=this.#createOutbox();
        try{
            return await this.#outboxPromise;
        }catch(error){
            this.#outboxPromise=null;
            throw error;
        }
    }

    async #performStart(revision,signal){
        const outbox=await this.#getOutbox();
        let summary;
        try{
            summary=await outbox.start({signal});
        }catch(error){
            outbox.stop();
            throw error;
        }
        if(this.#disposed||revision!==this.#lifecycleRevision){
            outbox.stop();
            throw codedError('Mail start was cancelled.','MAIL_START_CANCELLED');
        }
        this.#onlineTarget?.addEventListener('online',this.#onlineHandler);
        this.#started=true;
        this.#startSummary=summary;
        this.#publish('mail-outbox-drain',safeDrainDetail(summary));
        this.#publishState({lifecycle:'started',started:true});
        return summary;
    }

    async #handleOnline(){
        if(!this.#started||this.#disposed||this.#backgroundDrain) return;
        const controller=new AbortController();
        this.#backgroundController=controller;
        const operation=this.drain({reason:'online',signal:controller.signal});
        this.#backgroundDrain=operation;
        try{
            await operation;
            this.#backgroundError=null;
        }catch(error){
            if(error?.name!=='AbortError'&&error?.code!=='MAIL_OUTBOX_ABORTED'){
                this.#backgroundError=error;
                this.#publishState({lifecycle:'background-drain-failed',started:this.#started});
            }
        }finally{
            if(this.#backgroundDrain===operation) this.#backgroundDrain=null;
            if(this.#backgroundController===controller) this.#backgroundController=null;
        }
    }

    async #optionalProfile(){
        const fallback={email:'',language:'',phone:'',username:''};
        try{
            const user=await resolveMailUserEntity(this.#user);
            if(!user) return fallback;
            try{
                await user.load?.();
            }catch{
                return fallback;
            }
            return {
                email:profileValue(user,'email'),
                language:profileValue(user,'language'),
                phone:profileValue(user,'phone'),
                username:profileValue(user,'username')
            };
        }catch{
            return fallback;
        }
    }

    async start({signal=null}={}){
        this.#assertActive();
        this.#assertConfigured();
        const callerSignal=validateMailSignal(signal);
        throwIfMailAborted(callerSignal);
        if(this.#started) return this.#startSummary;
        const revision=this.#lifecycleRevision;
        if(this.#startPromise&&this.#startRevision===revision){
            return waitForMailOperation(this.#startPromise,callerSignal);
        }
        const previous=this.#startPromise;
        const linked=linkedMailSignal(this.#activeLifecycleSignal(),callerSignal);
        const operation=(previous
            ?previous.catch(function ignoreCancelledStartGeneration(){})
            :Promise.resolve()
        ).then(this.#performStart.bind(this,revision,linked.signal));
        this.#startPromise=operation;
        this.#startRevision=revision;
        try{
            return await operation;
        }finally{
            linked.dispose();
            if(this.#startPromise===operation){
                this.#startPromise=null;
                this.#startRevision=null;
            }
        }
    }

    async drain({reason='manual',signal=null}={}){
        this.#assertActive();
        this.#assertConfigured();
        const linked=linkedMailSignal(this.#activeLifecycleSignal(),signal);
        try{
            const outbox=await this.#getOutbox();
            const summary=await outbox.drain({reason,signal:linked.signal});
            this.#publish('mail-outbox-drain',safeDrainDetail(summary));
            return summary;
        }finally{
            linked.dispose();
        }
    }

    async listOutbox(){
        return (await this.#getOutbox()).list();
    }

    async auditOutbox(){
        return (await this.#getOutbox()).audit();
    }

    async getOutboxRecord(reportKey){
        return (await this.#getOutbox()).get(reportKey);
    }

    async deleteInvalidOutbox(fileName){
        return (await this.#getOutbox()).deleteInvalid(fileName);
    }

    async repairInvalidOutbox(fileName,replacement){
        return (await this.#getOutbox()).repairInvalid(fileName,replacement);
    }

    async quarantineInvalidOutbox(){
        return (await this.#getOutbox()).quarantineInvalid();
    }

    stop(){
        if(this.#disposed) return this;
        this.#lifecycleRevision+=1;
        this.#lifecycleController.abort(
            codedError('Mail lifecycle was stopped.','MAIL_LIFECYCLE_STOPPED')
        );
        this.#backgroundController?.abort(
            codedError('Mail background drain was stopped.','MAIL_BACKGROUND_DRAIN_STOPPED')
        );
        this.#outbox?.stop();
        if(this.#started){
            this.#onlineTarget?.removeEventListener('online',this.#onlineHandler);
            this.#started=false;
            this.#startSummary=null;
            this.#publishState({lifecycle:'stopped',started:false});
        }
        return this;
    }

    dispose(){
        if(this.#disposed) return false;
        this.stop();
        this.#disposed=true;
        this.#events.dispose();
        try{
            if(globalThis.window?.mail===this) globalThis.window.mail=null;
        }catch{}
        return true;
    }

    async send(to=[], subject='', payload={}, messageStyle='', messageType='') {
        this.#assertActive();
        if(!is.string(subject)){
            throw new TypeError('Mail subject must be a string');
        }
        const normalizedSubject=subject;
        if(!payload||!is.object(payload)||is.array(payload)){
            throw new TypeError('Mail payload must be an object');
        }
        if(!is.string(messageStyle)){
            throw new TypeError('Mail message style must be a string');
        }
        if(!is.array(to)){
            throw new TypeError('Mail recipients must be an array');
        }
        if(!is.string(messageType)||!MAIL_TYPES.has(messageType)){
            throw new TypeError('Mail type must be error, report, or crisis_detected');
        }

        this.#assertConfigured();
        const recipients=normalizeRecipients(to);
        if(messageType!=='error'&&recipients.length===0){
            throw new TypeError('Report and crisis mail require at least one recipient');
        }

        await this.start();
        this.#assertActive();
        const signal=this.#lifecycleController.signal;
        throwIfMailAborted(signal);
        const outbox=await this.#getOutbox();
        const timestamp=this.#time();
        const reportKey=createReportKey(timestamp,this.#cryptoProvider);
        const reportPayload={
            ...clonePayload(payload),
            source_at:new Date(timestamp).toISOString(),
            ...(this.#includeContext
                ?{source_path:globalThis.location?.pathname||''}
                :{}),
            subject:normalizedSubject,
            type:messageType,
        };

        if(messageType==='error'){
            reportPayload.report={
                subject:normalizedSubject,
                text:`${this.appName} application error\n\n${serializePayload(reportPayload)}`,
                to:recipients,
                type:messageType,
            };
            const record=await outbox.enqueue(
                {report:reportPayload.report,reportKey},
                {signal}
            );
            return publicSendResult(record);
        }

        const profile=this.#includeContext
            ?await this.#optionalProfile()
            :{email:'',language:'',phone:'',username:''};
        const wantsHtml=/\bhtml\b/i.test(messageStyle);
        if(this.#includeContext){
            Object.assign(reportPayload,{
                email:profile.email,
                language:profile.language,
                phone:profile.phone,
                source_user:profile.username || 'username not specified',
            });
        }

        // Email formatting stays local and deterministic. The supplied style
        // is presentation intent only; it is never sent to an AI provider and
        // untrusted report values are escaped before entering HTML.
        const serialized=serializePayload(reportPayload);
        const generatedMessage=wantsHtml
            ? `<pre>${escapeHtml(serialized)}</pre>`
            : serialized;

        const sourceUser=String(reportPayload.source_user||'');
        const subjectSuffix=sourceUser?` - ${sourceUser}`:'';
        const deliverySubject=`${normalizedSubject}${subjectSuffix}`;

        reportPayload.report = {
            subject:deliverySubject,
            to:recipients,
            type:messageType,
        };
        if(wantsHtml){
            reportPayload.report.html=this.#includeContext?`${generatedMessage}
<hr>
<p>Phone: ${escapeHtml(profile.phone || 'not provided')}<br>Email: ${escapeHtml(profile.email || 'not provided')}</p>`
                :generatedMessage;
        }else{
            reportPayload.report.text=this.#includeContext?`${generatedMessage}

Phone: ${profile.phone || 'not provided'}
Email: ${profile.email || 'not provided'}`
                :generatedMessage;
        }

        throwIfMailAborted(signal);
        const record=await outbox.enqueue(
            {report:reportPayload.report,reportKey},
            {signal}
        );
        return publicSendResult(record);
    }
}

if(globalThis.window) new Mail();

export default Mail;
