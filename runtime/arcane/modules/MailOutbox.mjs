export const MAIL_OUTBOX_PROTOCOL='arcane-mail-outbox/1';
export const MAIL_OUTBOX_TABLE='mail_outbox';
export const MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS=24*60*60*1000;
export const MAIL_OUTBOX_STATES=Object.freeze([
    'queued',
    'sending',
    'retry_wait',
    'accepted',
    'failed',
    'reconciliation_required'
]);

const STATE_SET=new Set(MAIL_OUTBOX_STATES);
const REPORT_KEY_PATTERN=/^[A-Za-z0-9._:-]{8,128}$/;
const SAFE_CODE_PATTERN=/^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_ID_PATTERN=/^[A-Za-z0-9._:-]{1,256}$/;
const TABLE_PATTERN=/^[a-z][a-z0-9_]{0,63}$/;
const FILE_SUFFIX='.mail-outbox.json';
const DEFAULT_MAX_RECORDS=512;
const DEFAULT_MAX_ATTEMPTS_PER_DRAIN=16;
const DEFAULT_MAX_REPORT_BYTES=786_432;
const MAX_RETRY_AFTER_SECONDS=24*60*60;

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function fail(message,code='MAIL_OUTBOX_INVALID',ErrorType=Error,cause){
    const options=cause===undefined?undefined:{cause};
    throw coded(new ErrorType(message,options),code);
}

function isPlainRecord(value){
    return Boolean(value)
        &&typeof value==='object'
        &&!Array.isArray(value)
        &&Object.getPrototypeOf(value)===Object.prototype;
}

function positiveInteger(value,label,defaultValue,maximum){
    const resolved=value===undefined?defaultValue:value;
    if(!Number.isSafeInteger(resolved)||resolved<1||resolved>maximum){
        fail(`${label} must be an integer from 1 through ${maximum}.`);
    }
    return resolved;
}

function timestamp(value,label,{nullable=false}={}){
    if(nullable&&value===null) return null;
    if(!Number.isSafeInteger(value)||value<0){
        fail(`${label} must be a nonnegative epoch-millisecond integer.`,'MAIL_OUTBOX_RECORD_INVALID');
    }
    return value;
}

function clockMilliseconds(clock){
    const value=clock();
    const milliseconds=value instanceof Date?value.getTime():Number(value);
    if(!Number.isSafeInteger(milliseconds)||milliseconds<0){
        fail('Mail outbox clock returned an invalid time.','MAIL_OUTBOX_CLOCK_INVALID');
    }
    return milliseconds;
}

function safeString(value,pattern){
    return typeof value==='string'&&pattern.test(value)?value:null;
}

function safeStatusCode(value){
    return Number.isSafeInteger(value)&&value>=100&&value<=599?value:null;
}

function retryAfterSeconds(value){
    if(value===undefined||value===null) return null;
    const seconds=Number(value);
    if(!Number.isSafeInteger(seconds)||seconds<0||seconds>MAX_RETRY_AFTER_SECONDS){
        return null;
    }
    return seconds;
}

function deepFreeze(value,seen=new Set()){
    if(value===null||(typeof value!=='object'&&typeof value!=='function')||seen.has(value)){
        return value;
    }
    seen.add(value);
    for(const key of Reflect.ownKeys(value)) deepFreeze(value[key],seen);
    return Object.freeze(value);
}

function parseSerializedReport(value){
    if(typeof value!=='string'||!value){
        fail('Mail outbox record contains no serialized report.','MAIL_OUTBOX_RECORD_INVALID');
    }
    let parsed;
    try{
        parsed=JSON.parse(value);
    }catch(error){
        fail(
            'Mail outbox record contains invalid serialized JSON.',
            'MAIL_OUTBOX_RECORD_INVALID',
            Error,
            error
        );
    }
    if(!isPlainRecord(parsed)){
        fail('Mail outbox serialized report must contain a JSON object.','MAIL_OUTBOX_RECORD_INVALID');
    }
    return parsed;
}

function serializeReport(report,maxReportBytes){
    if(!isPlainRecord(report)){
        fail('Mail outbox report must be a plain object.','MAIL_OUTBOX_REPORT_INVALID',TypeError);
    }
    let serialized;
    try{
        serialized=JSON.stringify(report);
    }catch(error){
        fail('Mail outbox report must be JSON serializable.','MAIL_OUTBOX_REPORT_INVALID',TypeError,error);
    }
    if(typeof serialized!=='string'||!serialized){
        fail('Mail outbox report must be JSON serializable.','MAIL_OUTBOX_REPORT_INVALID',TypeError);
    }
    if(new TextEncoder().encode(serialized).byteLength>maxReportBytes){
        fail(
            `Mail outbox report cannot exceed ${maxReportBytes} serialized bytes.`,
            'MAIL_OUTBOX_REPORT_TOO_LARGE',
            RangeError
        );
    }
    return serialized;
}

function reportKey(value){
    if(typeof value!=='string'||!REPORT_KEY_PATTERN.test(value)){
        fail(
            'Mail outbox reportKey must contain 8-128 safe characters.',
            'MAIL_OUTBOX_REPORT_KEY_INVALID',
            TypeError
        );
    }
    return value;
}

function recordFileName(value){
    return `${reportKey(value)}${FILE_SUFFIX}`;
}

function reportKeyFromFileName(value){
    if(typeof value!=='string'||!value.endsWith(FILE_SUFFIX)){
        fail('Mail outbox contains an invalid record filename.','MAIL_OUTBOX_RECORD_INVALID');
    }
    return reportKey(value.slice(0,-FILE_SUFFIX.length));
}

function normalizedFailure(value){
    if(value===null) return null;
    if(!isPlainRecord(value)){
        fail('Mail outbox failure record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
    }
    const code=safeString(value.code,SAFE_CODE_PATTERN);
    if(!code||typeof value.retryable!=='boolean'||typeof value.uncertain!=='boolean'){
        fail('Mail outbox failure record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
    }
    return Object.freeze({
        code,
        statusCode:safeStatusCode(value.statusCode),
        retryable:value.retryable,
        uncertain:value.uncertain,
        retryAfterSeconds:retryAfterSeconds(value.retryAfterSeconds)
    });
}

function normalizedResult(value){
    if(value===null) return null;
    if(!isPlainRecord(value)){
        fail('Mail outbox delivery result is invalid.','MAIL_OUTBOX_RECORD_INVALID');
    }
    const status=safeString(value.status,SAFE_CODE_PATTERN);
    if(!status){
        fail('Mail outbox delivery result is invalid.','MAIL_OUTBOX_RECORD_INVALID');
    }
    return Object.freeze({
        status,
        classification:safeString(value.classification,SAFE_CODE_PATTERN),
        requestId:safeString(value.requestId,SAFE_ID_PATTERN),
        providerId:safeString(value.providerId,SAFE_ID_PATTERN),
        providerStatus:safeString(value.providerStatus,SAFE_CODE_PATTERN),
        providerCode:safeString(value.providerCode,SAFE_CODE_PATTERN),
        statusCode:safeStatusCode(value.statusCode),
        retryAfterSeconds:retryAfterSeconds(value.retryAfterSeconds)
    });
}

function validateRecordState(record){
    const attempted=record.attempts>0
        &&record.firstAttemptAt!==null
        &&record.lastAttemptAt!==null;
    if(record.lastAttemptAt!==null&&record.updatedAt<record.lastAttemptAt){
        fail('Mail outbox record was updated before its last attempt.','MAIL_OUTBOX_RECORD_INVALID');
    }
    if(record.nextAttemptAt!==null&&(
        record.firstAttemptAt===null||record.nextAttemptAt<record.firstAttemptAt
    )){
        fail('Mail outbox record contains an invalid retry time.','MAIL_OUTBOX_RECORD_INVALID');
    }
    switch(record.state){
        case 'queued':
            if(record.attempts!==0
                ||record.firstAttemptAt!==null
                ||record.lastAttemptAt!==null
                ||record.nextAttemptAt!==null
                ||record.result!==null
                ||record.failure!==null){
                fail('Queued mail outbox record contains attempt state.','MAIL_OUTBOX_RECORD_INVALID');
            }
            return;
        case 'sending':
            if(!attempted
                ||record.nextAttemptAt!==null
                ||record.result!==null
                ||record.failure!==null){
                fail('Sending mail outbox record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
            }
            return;
        case 'retry_wait':
            if(!attempted
                ||record.nextAttemptAt===null
                ||record.failure?.retryable!==true){
                fail('Retrying mail outbox record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
            }
            return;
        case 'accepted':
            if(!attempted
                ||record.nextAttemptAt!==null
                ||record.failure!==null
                ||record.result?.status!=='accepted'
                ||!record.result.requestId
                ||!record.result.providerId){
                fail('Accepted mail outbox record lacks provider acceptance evidence.','MAIL_OUTBOX_RECORD_INVALID');
            }
            return;
        case 'failed':
            if(!attempted
                ||record.nextAttemptAt!==null
                ||record.failure===null
                ||record.failure.retryable
                ||record.failure.uncertain){
                fail('Failed mail outbox record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
            }
            return;
        case 'reconciliation_required':
            if(!attempted
                ||record.nextAttemptAt!==null
                ||record.failure?.retryable!==false
                ||record.failure.uncertain!==true){
                fail('Mail outbox reconciliation record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
            }
            return;
        default:
            fail('Mail outbox record contains an invalid state.','MAIL_OUTBOX_RECORD_INVALID');
    }
}

function normalizedRecord(value,expectedReportKey=null){
    if(!isPlainRecord(value)||value.protocol!==MAIL_OUTBOX_PROTOCOL){
        fail('Mail outbox record is invalid.','MAIL_OUTBOX_RECORD_INVALID');
    }
    const key=reportKey(value.reportKey);
    if(expectedReportKey!==null&&key!==expectedReportKey){
        fail('Mail outbox record identity does not match its filename.','MAIL_OUTBOX_RECORD_INVALID');
    }
    parseSerializedReport(value.serializedReport);
    if(!STATE_SET.has(value.state)){
        fail('Mail outbox record contains an invalid state.','MAIL_OUTBOX_RECORD_INVALID');
    }
    if(!Number.isSafeInteger(value.attempts)||value.attempts<0){
        fail('Mail outbox record contains an invalid attempt count.','MAIL_OUTBOX_RECORD_INVALID');
    }
    const record={
        protocol:MAIL_OUTBOX_PROTOCOL,
        reportKey:key,
        serializedReport:value.serializedReport,
        state:value.state,
        createdAt:timestamp(value.createdAt,'createdAt'),
        updatedAt:timestamp(value.updatedAt,'updatedAt'),
        firstAttemptAt:timestamp(value.firstAttemptAt,'firstAttemptAt',{nullable:true}),
        lastAttemptAt:timestamp(value.lastAttemptAt,'lastAttemptAt',{nullable:true}),
        nextAttemptAt:timestamp(value.nextAttemptAt,'nextAttemptAt',{nullable:true}),
        attempts:value.attempts,
        result:normalizedResult(value.result),
        failure:normalizedFailure(value.failure)
    };
    if(record.updatedAt<record.createdAt
        ||(record.firstAttemptAt!==null&&record.firstAttemptAt<record.createdAt)
        ||(record.lastAttemptAt!==null&&record.firstAttemptAt===null)
        ||(record.lastAttemptAt!==null&&record.lastAttemptAt<record.firstAttemptAt)){
        fail('Mail outbox record contains inconsistent timestamps.','MAIL_OUTBOX_RECORD_INVALID');
    }
    validateRecordState(record);
    return deepFreeze(record);
}

function updatedRecord(record,patch){
    return normalizedRecord({...record,...patch},record.reportKey);
}

function deliveryRequest(record,signal){
    const report=deepFreeze(parseSerializedReport(record.serializedReport));
    return Object.freeze({
        report,
        reportKey:record.reportKey,
        serializedReport:record.serializedReport,
        signal
    });
}

function deliveryResult(value){
    if(!isPlainRecord(value)){
        fail(
            'Mail delivery returned an invalid result.',
            'MAIL_OUTBOX_DELIVERY_RESULT_INVALID'
        );
    }
    const result=normalizedResult(value);
    if(!result.requestId){
        fail('Mail delivery result has no valid requestId.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
    }
    switch(result.status){
        case 'accepted':
            if(result.classification!==null&&result.classification!=='accepted'){
                fail('Accepted mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            if(!result.providerId){
                fail('Accepted mail delivery has no valid providerId.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return Object.freeze({kind:'accepted',result,failure:null});
        case 'delivery_uncertain':
            if(result.classification!==null&&result.classification!=='ambiguous'){
                fail('Uncertain mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return Object.freeze({
                kind:'retry',
                result,
                failure:Object.freeze({
                    code:result.providerCode||'MAIL_DELIVERY_UNCERTAIN',
                    statusCode:result.statusCode,
                    retryable:true,
                    uncertain:true,
                    retryAfterSeconds:result.retryAfterSeconds
                })
            });
        case 'retryable':
            if(result.classification!==null&&result.classification!=='retryable'){
                fail('Retryable mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return Object.freeze({
                kind:'retry',
                result,
                failure:Object.freeze({
                    code:result.providerCode||'MAIL_DELIVERY_RETRYABLE',
                    statusCode:result.statusCode,
                    retryable:true,
                    uncertain:false,
                    retryAfterSeconds:result.retryAfterSeconds
                })
            });
        case 'permanently_rejected':
        case 'partially_accepted':
            if(result.classification!==null&&result.classification!=='permanent'){
                fail('Rejected mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return Object.freeze({
                kind:'failed',
                result,
                failure:Object.freeze({
                    code:result.providerCode||(
                        result.status==='partially_accepted'
                            ?'MAIL_DELIVERY_PARTIALLY_ACCEPTED'
                            :'MAIL_DELIVERY_PERMANENTLY_REJECTED'
                    ),
                    statusCode:result.statusCode,
                    retryable:false,
                    uncertain:false,
                    retryAfterSeconds:null
                })
            });
        default:
            fail('Mail delivery returned an unsupported status.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
    }
}

function deliveryFailure(error){
    const classification=safeString(error?.classification,SAFE_CODE_PATTERN);
    const uncertain=error?.uncertain===true||classification==='ambiguous';
    const retryable=uncertain||error?.retryable===true||classification==='retryable';
    const milliseconds=Number(error?.retryAfterMs);
    const seconds=retryAfterSeconds(
        error?.retryAfterSeconds??(
            Number.isFinite(milliseconds)&&milliseconds>=0
                ?Math.ceil(milliseconds/1000)
                :null
        )
    );
    return Object.freeze({
        kind:retryable?'retry':'failed',
        result:null,
        failure:Object.freeze({
            code:safeString(error?.code,SAFE_CODE_PATTERN)||'MAIL_DELIVERY_FAILED',
            statusCode:safeStatusCode(error?.statusCode),
            retryable,
            uncertain,
            retryAfterSeconds:seconds
        })
    });
}

function abortError(signal){
    if(!signal?.aborted) return null;
    const error=new Error('Mail outbox operation was aborted.',{
        cause:signal.reason
    });
    error.name='AbortError';
    return coded(error,'MAIL_OUTBOX_ABORTED');
}

function throwIfAborted(signal){
    const error=abortError(signal);
    if(error) throw error;
}

function validateSignal(signal){
    if(signal===null||signal===undefined) return null;
    if(typeof signal!=='object'
        ||typeof signal.aborted!=='boolean'
        ||typeof signal.addEventListener!=='function'
        ||typeof signal.removeEventListener!=='function'){
        fail('Mail outbox signal must be an AbortSignal.','MAIL_OUTBOX_INVALID',TypeError);
    }
    return signal;
}

function drainReason(value){
    if(typeof value!=='string'||!/^[a-z][a-z0-9_-]{0,63}$/.test(value)){
        fail('Mail outbox drain reason is invalid.','MAIL_OUTBOX_INVALID',TypeError);
    }
    return value;
}

function terminalState(state){
    return state==='accepted'||state==='failed'||state==='reconciliation_required';
}

function summary(reason,online,records,attempted,invalidRecords,bounded){
    const counts={
        queued:0,
        sending:0,
        retry_wait:0,
        accepted:0,
        failed:0,
        reconciliation_required:0
    };
    for(const record of records) counts[record.state]+=1;
    return deepFreeze({
        reason,
        online,
        considered:records.length,
        attempted,
        invalidRecords,
        bounded,
        pending:counts.queued+counts.sending+counts.retry_wait,
        states:counts
    });
}

class MailOutbox{
    #clock;
    #deliver;
    #drainPromise=null;
    #enqueuePromise=null;
    #isOnline;
    #lastBackgroundError=null;
    #maxAttemptsPerDrain;
    #maxRecords;
    #maxReportBytes;
    #onlineHandler;
    #onlineTarget;
    #started=false;
    #storage;
    #table;

    constructor({
        storage,
        deliver,
        clock=Date.now,
        isOnline=function defaultOnlineStatus(){
            return globalThis.navigator?.onLine!==false;
        },
        onlineTarget=typeof globalThis.addEventListener==='function'?globalThis:null,
        maxAttemptsPerDrain=DEFAULT_MAX_ATTEMPTS_PER_DRAIN,
        maxRecords=DEFAULT_MAX_RECORDS,
        maxReportBytes=DEFAULT_MAX_REPORT_BYTES,
        table=MAIL_OUTBOX_TABLE
    }={}){
        if(!storage||typeof storage!=='object'){
            fail('Mail outbox storage is required.','MAIL_OUTBOX_STORAGE_UNAVAILABLE',TypeError);
        }
        for(const method of ['get','set','getAllKeys']){
            if(typeof storage[method]!=='function'){
                fail(
                    `Mail outbox storage must provide ${method}().`,
                    'MAIL_OUTBOX_STORAGE_UNAVAILABLE',
                    TypeError
                );
            }
        }
        if(typeof deliver!=='function'){
            fail('Mail outbox deliver must be a function.','MAIL_OUTBOX_INVALID',TypeError);
        }
        if(typeof clock!=='function'||typeof isOnline!=='function'){
            fail('Mail outbox clock and isOnline hooks must be functions.','MAIL_OUTBOX_INVALID',TypeError);
        }
        if(onlineTarget!==null&&(
            typeof onlineTarget?.addEventListener!=='function'
            ||typeof onlineTarget?.removeEventListener!=='function'
        )){
            fail('Mail outbox onlineTarget must be an EventTarget.','MAIL_OUTBOX_INVALID',TypeError);
        }
        if(typeof table!=='string'||!TABLE_PATTERN.test(table)){
            fail('Mail outbox table name is invalid.','MAIL_OUTBOX_INVALID',TypeError);
        }
        this.#storage=storage;
        this.#deliver=deliver;
        this.#clock=clock;
        this.#isOnline=isOnline;
        this.#onlineTarget=onlineTarget;
        this.#maxAttemptsPerDrain=positiveInteger(
            maxAttemptsPerDrain,
            'maxAttemptsPerDrain',
            DEFAULT_MAX_ATTEMPTS_PER_DRAIN,
            100
        );
        this.#maxRecords=positiveInteger(maxRecords,'maxRecords',DEFAULT_MAX_RECORDS,10_000);
        this.#maxReportBytes=positiveInteger(
            maxReportBytes,
            'maxReportBytes',
            DEFAULT_MAX_REPORT_BYTES,
            25*1024*1024
        );
        this.#table=table;
        this.#onlineHandler=this.#handleOnline.bind(this);
    }

    get started(){return this.#started;}
    get lastBackgroundError(){return this.#lastBackgroundError;}

    async #ready(){
        try{
            if(this.#storage.readyPromise&&typeof this.#storage.readyPromise.then==='function'){
                await this.#storage.readyPromise;
            }
        }catch(error){
            fail('Mail outbox storage failed to become ready.','MAIL_OUTBOX_STORAGE_UNAVAILABLE',Error,error);
        }
    }

    #time(){
        return clockMilliseconds(this.#clock);
    }

    #online(){
        try{
            return this.#isOnline()===true;
        }catch(error){
            this.#lastBackgroundError=coded(
                new Error('Mail outbox online status check failed.',{cause:error}),
                'MAIL_OUTBOX_ONLINE_CHECK_FAILED'
            );
            return false;
        }
    }

    async #read(key){
        let value;
        try{
            value=await this.#storage.get(this.#table,recordFileName(key),true);
        }catch(error){
            fail('Mail outbox could not read durable storage.','MAIL_OUTBOX_STORAGE_FAILED',Error,error);
        }
        return value===null||value===undefined?null:normalizedRecord(value,key);
    }

    async #write(record){
        const normalized=normalizedRecord(record,record.reportKey);
        try{
            await this.#storage.set(
                this.#table,
                recordFileName(normalized.reportKey),
                normalized
            );
        }catch(error){
            fail('Mail outbox could not write durable storage.','MAIL_OUTBOX_STORAGE_FAILED',Error,error);
        }
        return normalized;
    }

    async #keys(){
        let keys;
        try{
            keys=await this.#storage.getAllKeys(this.#table);
        }catch(error){
            fail('Mail outbox could not list durable storage.','MAIL_OUTBOX_STORAGE_FAILED',Error,error);
        }
        if(!Array.isArray(keys)){
            fail('Mail outbox storage returned an invalid key list.','MAIL_OUTBOX_STORAGE_FAILED');
        }
        if(keys.length>this.#maxRecords){
            fail(
                `Mail outbox exceeds its ${this.#maxRecords}-record bound.`,
                'MAIL_OUTBOX_CAPACITY_EXCEEDED',
                RangeError
            );
        }
        return [...keys];
    }

    async get(key){
        await this.#ready();
        return this.#read(reportKey(key));
    }

    async list(){
        await this.#ready();
        const keys=await this.#keys();
        const records=[];
        for(const fileName of keys){
            const key=reportKeyFromFileName(fileName);
            const record=await this.#read(key);
            if(record) records.push(record);
        }
        records.sort(function sortMailOutboxRecords(left,right){
            return left.createdAt-right.createdAt||left.reportKey.localeCompare(right.reportKey,'en');
        });
        return Object.freeze(records);
    }

    async #persistEnqueue({serializedReport,key,signal}){
        throwIfAborted(signal);
        await this.#ready();
        throwIfAborted(signal);
        const existing=await this.#read(key);
        if(existing){
            if(existing.serializedReport!==serializedReport){
                fail(
                    'Mail outbox reportKey is already bound to a different serialized report.',
                    'MAIL_OUTBOX_IDEMPOTENCY_CONFLICT'
                );
            }
            return existing;
        }
        const keys=await this.#keys();
        if(keys.length>=this.#maxRecords){
            fail(
                `Mail outbox cannot exceed ${this.#maxRecords} records.`,
                'MAIL_OUTBOX_CAPACITY_EXCEEDED',
                RangeError
            );
        }
        const now=this.#time();
        return this.#write({
            protocol:MAIL_OUTBOX_PROTOCOL,
            reportKey:key,
            serializedReport,
            state:'queued',
            createdAt:now,
            updatedAt:now,
            firstAttemptAt:null,
            lastAttemptAt:null,
            nextAttemptAt:null,
            attempts:0,
            result:null,
            failure:null
        });
    }

    async enqueue({report,reportKey:key}={}, {attempt=true,signal=null}={}){
        if(typeof attempt!=='boolean'){
            fail('Mail outbox attempt must be boolean.','MAIL_OUTBOX_INVALID',TypeError);
        }
        const resolvedSignal=validateSignal(signal);
        throwIfAborted(resolvedSignal);
        const normalizedKey=reportKey(key);
        const serializedReport=serializeReport(report,this.#maxReportBytes);
        const previous=this.#enqueuePromise;
        const operation=(previous??Promise.resolve()).catch(
            function ignorePriorEnqueueFailure(){}
        ).then(
            this.#persistEnqueue.bind(this,{
                serializedReport,
                key:normalizedKey,
                signal:resolvedSignal
            })
        );
        this.#enqueuePromise=operation;
        let persisted;
        try{
            persisted=await operation;
        }finally{
            if(this.#enqueuePromise===operation) this.#enqueuePromise=null;
        }
        if(!attempt||terminalState(persisted.state)) return persisted;
        const activeDrain=this.#drainPromise;
        await this.drain({reason:'enqueue',signal:resolvedSignal});
        let current=await this.#read(normalizedKey);
        if(activeDrain&&current?.state==='queued'){
            await this.drain({reason:'enqueue',signal:resolvedSignal});
            current=await this.#read(normalizedKey);
        }
        return current;
    }

    async #recoverSending(record,now){
        const expiresAt=record.firstAttemptAt+MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS;
        const failure=Object.freeze({
            code:'MAIL_OUTBOX_INTERRUPTED_ATTEMPT',
            statusCode:null,
            retryable:true,
            uncertain:true,
            retryAfterSeconds:null
        });
        if(now>=expiresAt){
            return this.#write(updatedRecord(record,{
                state:'reconciliation_required',
                updatedAt:Math.max(now,record.updatedAt),
                nextAttemptAt:null,
                failure
            }));
        }
        return this.#write(updatedRecord(record,{
            state:'retry_wait',
            updatedAt:Math.max(now,record.updatedAt),
            nextAttemptAt:now,
            failure
        }));
    }

    async #expireRetry(record,now){
        if(record.firstAttemptAt===null){
            fail('Retrying mail outbox record has no first attempt time.','MAIL_OUTBOX_RECORD_INVALID');
        }
        const expiresAt=record.firstAttemptAt+MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS;
        if(now<expiresAt) return record;
        const uncertain=record.failure?.uncertain===true;
        return this.#write(updatedRecord(record,{
            state:uncertain?'reconciliation_required':'failed',
            updatedAt:Math.max(now,record.updatedAt),
            nextAttemptAt:null,
            failure:Object.freeze({
                code:uncertain
                    ?'MAIL_OUTBOX_RECONCILIATION_REQUIRED'
                    :'MAIL_OUTBOX_RETRY_WINDOW_EXPIRED',
                statusCode:record.failure?.statusCode??null,
                retryable:false,
                uncertain,
                retryAfterSeconds:null
            })
        }));
    }

    async #recordRetry(record,outcome,now){
        const expiresAt=record.firstAttemptAt+MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS;
        const requestedAt=outcome.failure.retryAfterSeconds===null
            ?now
            :now+outcome.failure.retryAfterSeconds*1000;
        if(now>=expiresAt||requestedAt>=expiresAt){
            const uncertain=outcome.failure.uncertain;
            return this.#write(updatedRecord(record,{
                state:uncertain?'reconciliation_required':'failed',
                updatedAt:Math.max(now,record.updatedAt),
                nextAttemptAt:null,
                result:outcome.result,
                failure:Object.freeze({
                    ...outcome.failure,
                    code:uncertain
                        ?'MAIL_OUTBOX_RECONCILIATION_REQUIRED'
                        :'MAIL_OUTBOX_RETRY_WINDOW_EXPIRED',
                    retryable:false,
                    retryAfterSeconds:null
                })
            }));
        }
        return this.#write(updatedRecord(record,{
            state:'retry_wait',
            updatedAt:Math.max(now,record.updatedAt),
            nextAttemptAt:requestedAt,
            result:outcome.result,
            failure:outcome.failure
        }));
    }

    async #attempt(record,signal){
        throwIfAborted(signal);
        const startedAt=Math.max(this.#time(),record.updatedAt);
        const firstAttemptAt=record.firstAttemptAt??startedAt;
        if(startedAt>=firstAttemptAt+MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS){
            return this.#expireRetry(record,startedAt);
        }
        const sending=await this.#write(updatedRecord(record,{
            state:'sending',
            updatedAt:startedAt,
            firstAttemptAt,
            lastAttemptAt:startedAt,
            nextAttemptAt:null,
            attempts:record.attempts+1,
            result:null,
            failure:null
        }));
        let outcome;
        try{
            const value=await this.#deliver(deliveryRequest(sending,signal));
            outcome=deliveryResult(value);
        }catch(error){
            outcome=deliveryFailure(error);
        }
        const completedAt=Math.max(this.#time(),sending.updatedAt);
        if(outcome.kind==='accepted'){
            return this.#write(updatedRecord(sending,{
                state:'accepted',
                updatedAt:completedAt,
                nextAttemptAt:null,
                result:outcome.result,
                failure:null
            }));
        }
        if(outcome.kind==='retry'){
            return this.#recordRetry(sending,outcome,completedAt);
        }
        return this.#write(updatedRecord(sending,{
            state:'failed',
            updatedAt:completedAt,
            nextAttemptAt:null,
            result:outcome.result,
            failure:outcome.failure
        }));
    }

    async #performDrain({reason,signal}){
        await this.#ready();
        throwIfAborted(signal);
        const records=[];
        let invalidRecords=0;
        for(const fileName of await this.#keys()){
            try{
                const key=reportKeyFromFileName(fileName);
                const record=await this.#read(key);
                if(record) records.push(record);
            }catch(error){
                if(error?.code!=='MAIL_OUTBOX_RECORD_INVALID'
                    &&error?.code!=='MAIL_OUTBOX_REPORT_KEY_INVALID') throw error;
                invalidRecords+=1;
            }
        }
        records.sort(function sortMailOutboxDrain(left,right){
            return left.createdAt-right.createdAt||left.reportKey.localeCompare(right.reportKey,'en');
        });
        let attempted=0;
        let bounded=false;
        const online=this.#online();
        for(let index=0;index<records.length;index+=1){
            throwIfAborted(signal);
            let record=records[index];
            const now=Math.max(this.#time(),record.updatedAt);
            if(record.state==='sending'){
                record=await this.#recoverSending(record,now);
                records[index]=record;
            }
            if(record.state==='retry_wait'){
                record=await this.#expireRetry(record,now);
                records[index]=record;
            }
            if(terminalState(record.state)) continue;
            if(record.state==='retry_wait'&&record.nextAttemptAt!==null&&record.nextAttemptAt>now){
                continue;
            }
            if(!online||!this.#online()) continue;
            if(attempted>=this.#maxAttemptsPerDrain){
                bounded=true;
                break;
            }
            record=await this.#attempt(record,signal);
            records[index]=record;
            attempted+=1;
        }
        return summary(reason,online,records,attempted,invalidRecords,bounded);
    }

    async drain({reason='manual',signal=null}={}){
        const normalizedReason=drainReason(reason);
        const normalizedSignal=validateSignal(signal);
        if(this.#drainPromise) return this.#drainPromise;
        const operation=this.#performDrain({
            reason:normalizedReason,
            signal:normalizedSignal
        });
        this.#drainPromise=operation;
        try{
            return await operation;
        }finally{
            if(this.#drainPromise===operation) this.#drainPromise=null;
        }
    }

    async #handleOnline(){
        try{
            await this.drain({reason:'online'});
            this.#lastBackgroundError=null;
        }catch(error){
            this.#lastBackgroundError=error;
        }
    }

    async start({signal=null}={}){
        const normalizedSignal=validateSignal(signal);
        throwIfAborted(normalizedSignal);
        if(!this.#started){
            this.#onlineTarget?.addEventListener('online',this.#onlineHandler);
            this.#started=true;
        }
        return this.drain({reason:'startup',signal:normalizedSignal});
    }

    stop(){
        if(this.#started){
            this.#onlineTarget?.removeEventListener('online',this.#onlineHandler);
            this.#started=false;
        }
        return this;
    }
}

function createMailOutbox(options){
    return new MailOutbox(options);
}

export {MailOutbox,createMailOutbox};
export default MailOutbox;
