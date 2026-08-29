export const MAIL_OUTBOX_PROTOCOL='arcane-mail-outbox/1';
export const MAIL_OUTBOX_TABLE='mail_outbox';
export const MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS=24*60*60*1000;
export const MAIL_OUTBOX_STATES=[
    'queued',
    'sending',
    'retry_wait',
    'accepted',
    'failed',
    'reconciliation_required'
];
const STATE_SET=new Set(MAIL_OUTBOX_STATES);
const REPORT_KEY_PATTERN=/^[A-Za-z0-9._:-]+$/;
const SAFE_CODE_PATTERN=/^[A-Za-z0-9._:-]+$/;
const SAFE_ID_PATTERN=/^[A-Za-z0-9._:-]+$/;
const TABLE_PATTERN=/^[a-z][a-z0-9_]*$/;
const FILE_SUFFIX='.mail-outbox.json';
const QUARANTINE_PROTOCOL='arcane-mail-outbox-quarantine/1';
const QUARANTINE_TABLE='mail_outbox_quarantine';
const STRUCTURAL_RECORD_ERROR_CODES=new Set([
    'MAIL_OUTBOX_RECORD_INVALID',
    'MAIL_OUTBOX_REPORT_KEY_INVALID'
]);

function coded(error,code){
    if(!error.code) error.code=code;
    return error;
}

function reportMailOutboxObserverError(error){
    try{
        if(typeof globalThis.reportError==='function'){
            globalThis.reportError(error);
            return;
        }
    }catch{}
    try{globalThis.console?.error?.(error);}catch{}
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
    if(!Number.isSafeInteger(seconds)||seconds<0){
        return null;
    }
    return seconds;
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

function serializeReport(report){
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
    return serialized;
}

function quarantineSnapshot(value){
    try{
        const serialized=JSON.stringify(value);
        if(typeof serialized==='string')return serialized;
    }catch{}
    return null;
}

function reportKey(value){
    if(typeof value!=='string'||!REPORT_KEY_PATTERN.test(value)){
        fail(
            'Mail outbox reportKey must contain safe characters.',
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

function invalidRecordMetadata(fileName,error){
    let repairable=false;
    try{
        reportKeyFromFileName(fileName);
        repairable=true;
    }catch{}
    return {
        fileName:typeof fileName==='string'?fileName:'',
        code:safeString(error?.code,SAFE_CODE_PATTERN)||'MAIL_OUTBOX_RECORD_UNREADABLE',
        repairable
    };
}

function structuralRecordError(error){
    return STRUCTURAL_RECORD_ERROR_CODES.has(error?.code);
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
    return {
        ...value,
        code,
        statusCode:safeStatusCode(value.statusCode),
        retryable:value.retryable,
        uncertain:value.uncertain,
        retryAfterSeconds:retryAfterSeconds(value.retryAfterSeconds)
    };
}

function normalizedResult(value,{invalidCode='MAIL_OUTBOX_RECORD_INVALID'}={}){
    if(value===null) return null;
    if(!isPlainRecord(value)){
        fail('Mail outbox delivery result is invalid.',invalidCode);
    }
    const status=safeString(value.status,SAFE_CODE_PATTERN);
    if(!status){
        fail('Mail outbox delivery result is invalid.',invalidCode);
    }
    const acceptanceAuthority=safeString(value.acceptanceAuthority,SAFE_CODE_PATTERN);
    if(value.acceptanceAuthority!==null
        &&value.acceptanceAuthority!==undefined
        &&acceptanceAuthority===null){
        fail('Mail outbox delivery result has a malformed acceptance authority.',invalidCode);
    }
    return {
        ...value,
        status,
        classification:safeString(value.classification,SAFE_CODE_PATTERN),
        acceptanceAuthority,
        requestId:safeString(value.requestId,SAFE_ID_PATTERN),
        providerId:safeString(value.providerId,SAFE_ID_PATTERN),
        providerStatus:typeof value.providerStatus==='string'
            ||Number.isSafeInteger(value.providerStatus)
            ?value.providerStatus
            :null,
        providerCode:safeString(value.providerCode,SAFE_CODE_PATTERN),
        statusCode:safeStatusCode(value.statusCode),
        retryAfterSeconds:retryAfterSeconds(value.retryAfterSeconds)
    };
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
    if(record.result?.acceptanceAuthority!=null&&record.state!=='accepted'){
        fail('Mail outbox record contains an invalid acceptance authority.','MAIL_OUTBOX_RECORD_INVALID');
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
                ||!record.result.requestId){
                fail('Accepted mail outbox record lacks a request identifier.','MAIL_OUTBOX_RECORD_INVALID');
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
    return record;
}

function updatedRecord(record,patch){
    return normalizedRecord({...record,...patch},record.reportKey);
}

function deliveryRequest(record,signal){
    const report=parseSerializedReport(record.serializedReport);
    return {
        report,
        reportKey:record.reportKey,
        serializedReport:record.serializedReport,
        signal
    };
}

function deliveryResult(value){
    if(!isPlainRecord(value)){
        fail(
            'Mail delivery returned an invalid result.',
            'MAIL_OUTBOX_DELIVERY_RESULT_INVALID'
        );
    }
    const result=normalizedResult(value,{invalidCode:'MAIL_OUTBOX_DELIVERY_RESULT_INVALID'});
    if(!result.requestId){
        fail('Mail delivery result has no valid requestId.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
    }
    if(result.acceptanceAuthority!==null&&result.status!=='accepted'){
        fail('Mail delivery result has an invalid acceptance authority.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
    }
    switch(result.status){
        case 'accepted':
            if(result.classification!==null&&result.classification!=='accepted'){
                fail('Accepted mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return {kind:'accepted',result,failure:null};
        case 'delivery_uncertain':
            if(result.classification!==null&&result.classification!=='ambiguous'){
                fail('Uncertain mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return {
                kind:'retry',
                result,
                failure:{
                    ...result,
                    code:result.providerCode||'MAIL_DELIVERY_UNCERTAIN',
                    statusCode:result.statusCode,
                    retryable:true,
                    uncertain:true,
                    retryAfterSeconds:result.retryAfterSeconds
                }
            };
        case 'retryable':
            if(result.classification!==null&&result.classification!=='retryable'){
                fail('Retryable mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return {
                kind:'retry',
                result,
                failure:{
                    ...result,
                    code:result.providerCode||'MAIL_DELIVERY_RETRYABLE',
                    statusCode:result.statusCode,
                    retryable:true,
                    uncertain:false,
                    retryAfterSeconds:result.retryAfterSeconds
                }
            };
        case 'permanently_rejected':
        case 'partially_accepted':
            if(result.classification!==null&&result.classification!=='permanent'){
                fail('Rejected mail delivery has an invalid classification.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
            }
            return {
                kind:'failed',
                result,
                failure:{
                    ...result,
                    code:result.providerCode||(
                        result.status==='partially_accepted'
                            ?'MAIL_DELIVERY_PARTIALLY_ACCEPTED'
                            :'MAIL_DELIVERY_PERMANENTLY_REJECTED'
                    ),
                    statusCode:result.statusCode,
                    retryable:false,
                    uncertain:false,
                    retryAfterSeconds:null
                }
            };
        default:
            fail('Mail delivery returned an unsupported status.','MAIL_OUTBOX_DELIVERY_RESULT_INVALID');
    }
}

function deliveryFailure(error){
    const classification=safeString(error?.classification,SAFE_CODE_PATTERN);
    const cancelled=error?.name==='AbortError'
        ||error?.code==='MAIL_OUTBOX_ABORTED'
        ||error?.code==='MAIL_CANCELLED';
    const uncertain=cancelled||error?.uncertain===true||classification==='ambiguous';
    const retryable=uncertain||error?.retryable===true||classification==='retryable';
    const milliseconds=Number(error?.retryAfterMs);
    const seconds=retryAfterSeconds(
        error?.retryAfterSeconds??(
            Number.isFinite(milliseconds)&&milliseconds>=0
                ?Math.ceil(milliseconds/1000)
                :null
        )
    );
    const errorRecord=error&&typeof error==='object'&&!Array.isArray(error)
        ?{...error}
        :{};
    return {
        kind:retryable?'retry':'failed',
        result:null,
        failure:{
            ...errorRecord,
            name:typeof error?.name==='string'?error.name:'Error',
            message:typeof error?.message==='string'?error.message:String(error??''),
            ...(typeof error?.stack==='string'?{stack:error.stack}:{}),
            code:safeString(error?.code,SAFE_CODE_PATTERN)||'MAIL_DELIVERY_FAILED',
            statusCode:safeStatusCode(error?.statusCode),
            retryable,
            uncertain,
            retryAfterSeconds:seconds
        }
    };
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

function abortedDeliveryError(error,signal){
    if(!signal?.aborted
        &&error?.name!=='AbortError'
        &&error?.code!=='MAIL_OUTBOX_ABORTED'
        &&error?.code!=='MAIL_CANCELLED') return null;
    return abortError(signal)??coded(
        new Error('Mail outbox delivery was aborted.',{cause:error}),
        'MAIL_OUTBOX_ABORTED'
    );
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

function waitForOutboxOperation(operation,signal){
    const normalizedSignal=validateSignal(signal);
    throwIfAborted(normalizedSignal);
    if(!normalizedSignal) return operation;
    return new Promise(function observeOutboxCallerAbort(resolve,reject){
        let settled=false;
        function finish(callback,value){
            if(settled) return;
            settled=true;
            normalizedSignal.removeEventListener('abort',handleAbort);
            callback(value);
        }
        function handleAbort(){
            try{
                throwIfAborted(normalizedSignal);
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

function drainReason(value){
    if(typeof value!=='string'||!/^[a-z][a-z0-9_-]*$/.test(value)){
        fail('Mail outbox drain reason is invalid.','MAIL_OUTBOX_INVALID',TypeError);
    }
    return value;
}

function terminalState(state){
    return state==='accepted'||state==='failed'||state==='reconciliation_required';
}

function summary(reason,online,records,attempted,invalidRecords){
    const counts={
        queued:0,
        sending:0,
        retry_wait:0,
        accepted:0,
        failed:0,
        reconciliation_required:0
    };
    for(const record of records) counts[record.state]+=1;
    return {
        reason,
        online,
        records:[...records],
        considered:records.length,
        attempted,
        invalidRecords:[...invalidRecords],
        invalidRecordCount:invalidRecords.length,
        pending:counts.queued+counts.sending+counts.retry_wait,
        states:counts
    };
}

class MailOutbox{
    #clock;
    #deliver;
    #drainLockName;
    #drainPromise=null;
    #enqueuePromise=null;
    #isOnline;
    #invalidRecords=[];
    #lastBackgroundError=null;
    #lockManager;
    #lockName;
    #onlineHandler;
    #onlineController=null;
    #onlineTarget;
    #onRecordCommitted;
    #quarantineTable;
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
        lockManager=undefined,
        onlineTarget=typeof globalThis.addEventListener==='function'?globalThis:null,
        onRecordCommitted=null,
        quarantineTable=QUARANTINE_TABLE,
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
        const resolvedLockManager=lockManager
            ??storage.lockManager
            ??globalThis.navigator?.locks;
        if(!resolvedLockManager||typeof resolvedLockManager.request!=='function'){
            fail(
                'Mail outbox requires a Web Locks compatible lock manager.',
                'MAIL_OUTBOX_LOCK_UNAVAILABLE',
                TypeError
            );
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
        if(onRecordCommitted!==null&&typeof onRecordCommitted!=='function'){
            fail(
                'Mail outbox onRecordCommitted must be a function.',
                'MAIL_OUTBOX_INVALID',
                TypeError
            );
        }
        if(typeof table!=='string'||!TABLE_PATTERN.test(table)){
            fail('Mail outbox table name is invalid.','MAIL_OUTBOX_INVALID',TypeError);
        }
        if(typeof quarantineTable!=='string'||!TABLE_PATTERN.test(quarantineTable)
            ||quarantineTable===table){
            fail('Mail outbox quarantine table name is invalid.','MAIL_OUTBOX_INVALID',TypeError);
        }
        this.#storage=storage;
        this.#deliver=deliver;
        this.#clock=clock;
        this.#isOnline=isOnline;
        this.#lockManager=resolvedLockManager;
        this.#onlineTarget=onlineTarget;
        this.#onRecordCommitted=onRecordCommitted;
        this.#quarantineTable=quarantineTable;
        this.#table=table;
        this.#lockName=`arcane-mail-outbox:${encodeURIComponent(table)}`;
        this.#drainLockName=`${this.#lockName}:drain`;
        this.#onlineHandler=this.#handleOnline.bind(this);
    }

    get started(){return this.#started;}
    get invalidRecords(){return this.#invalidRecords;}
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

    #notifyRecordCommitted(record){
        if(!this.#onRecordCommitted) return;
        try{
            const result=this.#onRecordCommitted(record);
            if(result&&typeof result.then==='function'){
                result.catch(reportMailOutboxObserverError);
            }
        }catch(error){
            reportMailOutboxObserverError(error);
        }
    }

    async #withExclusiveLock(lockName,operation,signal=null){
        let acquired=false;
        const options=signal
            ?{mode:'exclusive',signal}
            :{mode:'exclusive'};
        try{
            return await this.#lockManager.request(
                lockName,
                options,
                async function runMailOutboxTableMutation(lock){
                    if(!lock||lock.mode!=='exclusive'){
                        fail(
                            'Mail outbox could not acquire its exclusive table lock.',
                            'MAIL_OUTBOX_LOCK_UNAVAILABLE'
                        );
                    }
                    acquired=true;
                    return operation();
                }
            );
        }catch(error){
            if(!acquired&&signal?.aborted) throwIfAborted(signal);
            if(acquired||error?.code==='MAIL_OUTBOX_LOCK_UNAVAILABLE') throw error;
            fail(
                'Mail outbox table lock failed.',
                'MAIL_OUTBOX_LOCK_FAILED',
                Error,
                error
            );
        }
    }

    #withTableMutation(operation){
        return this.#withExclusiveLock(this.#lockName,operation);
    }

    #withDrainAuthority(operation,signal){
        return this.#withExclusiveLock(this.#drainLockName,operation,signal);
    }

    async #readRawFile(fileName){
        try{
            return await this.#storage.get(this.#table,fileName,true);
        }catch(error){
            fail('Mail outbox could not read durable storage.','MAIL_OUTBOX_STORAGE_FAILED',Error,error);
        }
    }

    async #read(key){
        const value=await this.#readRawFile(recordFileName(key));
        return value===null||value===undefined?null:normalizedRecord(value,key);
    }

    async #commitNormalizedRecord(normalized){
        try{
            await this.#storage.set(
                this.#table,
                recordFileName(normalized.reportKey),
                normalized
            );
        }catch(error){
            fail('Mail outbox could not write durable storage.','MAIL_OUTBOX_STORAGE_FAILED',Error,error);
        }
        this.#notifyRecordCommitted(normalized);
        return normalized;
    }

    async #write(record){
        const normalized=normalizedRecord(record,record.reportKey);
        return this.#withTableMutation(
            this.#commitNormalizedRecord.bind(this,normalized)
        );
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
        return [...keys];
    }

    async #inventory(){
        const keys=await this.#keys();
        const records=[];
        const invalidRecords=[];
        for(const fileName of keys){
            try{
                const key=reportKeyFromFileName(fileName);
                const value=await this.#readRawFile(fileName);
                records.push(normalizedRecord(value,key));
            }catch(error){
                if(!structuralRecordError(error)) throw error;
                invalidRecords.push(invalidRecordMetadata(fileName,error));
            }
        }
        records.sort(function sortMailOutboxRecords(left,right){
            return left.createdAt-right.createdAt||left.reportKey.localeCompare(right.reportKey,'en');
        });
        const inventory={
            records,
            invalidRecords,
            totalFiles:keys.length,
            scannedFiles:keys.length
        };
        this.#invalidRecords=inventory.invalidRecords;
        return inventory;
    }

    #assertInvalidTarget(fileName,inventory){
        if(typeof fileName!=='string'||!fileName){
            fail('Mail outbox invalid-record filename is required.','MAIL_OUTBOX_INVALID',TypeError);
        }
        const target=inventory.invalidRecords.find(
            function findInvalidRecord(record){return record.fileName===fileName;}
        );
        if(!target){
            fail(
                'Mail outbox invalid record was not found in the inventory.',
                'MAIL_OUTBOX_INVALID_RECORD_NOT_FOUND'
            );
        }
        return target;
    }

    async #inspectInvalidFile(fileName){
        const keys=await this.#keys();
        if(!keys.includes(fileName)){
            fail(
                'Mail outbox invalid record no longer exists.',
                'MAIL_OUTBOX_INVALID_RECORD_NOT_FOUND'
            );
        }
        const value=await this.#readRawFile(fileName);
        try{
            const key=reportKeyFromFileName(fileName);
            normalizedRecord(value,key);
        }catch(error){
            if(!structuralRecordError(error)) throw error;
            return {
                metadata:invalidRecordMetadata(fileName,error),
                value
            };
        }
        fail(
            'Mail outbox invalid record changed before maintenance.',
            'MAIL_OUTBOX_INVALID_RECORD_CHANGED'
        );
    }

    #assertDeleteAvailable(){
        if(typeof this.#storage.delete!=='function'){
            fail(
                'Mail outbox storage does not support invalid-record deletion.',
                'MAIL_OUTBOX_DELETE_UNAVAILABLE'
            );
        }
    }

    async #deleteInvalidFile(fileName){
        this.#assertDeleteAvailable();
        try{
            await this.#storage.delete(this.#table,fileName);
        }catch(error){
            fail(
                'Mail outbox could not delete an invalid durable record.',
                'MAIL_OUTBOX_STORAGE_FAILED',
                Error,
                error
            );
        }
    }

    async #deleteConfirmedInvalid(target){
        const current=await this.#inspectInvalidFile(target.fileName);
        await this.#deleteInvalidFile(current.metadata.fileName);
        await this.#inventory();
        return {...current.metadata,deleted:true};
    }

    async #repairConfirmedInvalid(target,replacement){
        const current=await this.#inspectInvalidFile(target.fileName);
        if(!current.metadata.repairable){
            fail(
                'Mail outbox invalid filename cannot be repaired in place.',
                'MAIL_OUTBOX_INVALID_RECORD_NOT_REPAIRABLE'
            );
        }
        const key=reportKeyFromFileName(current.metadata.fileName);
        const repaired=normalizedRecord(replacement,key);
        const committed=await this.#commitNormalizedRecord(repaired);
        await this.#inventory();
        return committed;
    }

    async #quarantineConfirmedInvalid(target){
        const current=await this.#inspectInvalidFile(target.fileName);
        const snapshot=quarantineSnapshot(current.value);
        if(snapshot===null){
            fail(
                'Mail outbox cannot capture the invalid record for quarantine.',
                'MAIL_OUTBOX_QUARANTINE_SNAPSHOT_UNAVAILABLE'
            );
        }
        const entry={
            protocol:QUARANTINE_PROTOCOL,
            sourceTable:this.#table,
            sourceFileName:current.metadata.fileName,
            quarantinedAt:this.#time(),
            reasonCode:current.metadata.code,
            serializedValue:snapshot
        };
        try{
            await this.#storage.set(
                this.#quarantineTable,
                current.metadata.fileName,
                entry
            );
        }catch(error){
            fail(
                'Mail outbox could not quarantine an invalid durable record.',
                'MAIL_OUTBOX_STORAGE_FAILED',
                Error,
                error
            );
        }
        await this.#deleteInvalidFile(current.metadata.fileName);
        return {...current.metadata,quarantined:true};
    }

    async get(key){
        await this.#ready();
        return this.#read(reportKey(key));
    }

    async list(){
        await this.#ready();
        return (await this.#inventory()).records;
    }

    async audit(){
        await this.#ready();
        return this.#inventory();
    }

    async deleteInvalid(fileName){
        await this.#ready();
        const inventory=await this.#inventory();
        const target=this.#assertInvalidTarget(fileName,inventory);
        return this.#withTableMutation(
            this.#deleteConfirmedInvalid.bind(this,target)
        );
    }

    async repairInvalid(fileName,replacement){
        await this.#ready();
        const inventory=await this.#inventory();
        const target=this.#assertInvalidTarget(fileName,inventory);
        if(!target.repairable){
            fail(
                'Mail outbox invalid filename cannot be repaired in place.',
                'MAIL_OUTBOX_INVALID_RECORD_NOT_REPAIRABLE'
            );
        }
        return this.#withTableMutation(
            this.#repairConfirmedInvalid.bind(this,target,replacement)
        );
    }

    async quarantineInvalid(){
        await this.#ready();
        this.#assertDeleteAvailable();
        const inventory=await this.#inventory();
        const targets=inventory.invalidRecords;
        const quarantined=[];
        for(const target of targets){
            const result=await this.#withTableMutation(
                this.#quarantineConfirmedInvalid.bind(this,target)
            );
            quarantined.push(result);
        }
        const remaining=await this.#inventory();
        return {
            quarantined,
            remainingInvalidRecords:remaining.invalidRecords.length
        };
    }

    async #persistEnqueueLocked({serializedReport,key,signal}){
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
        await this.#inventory();
        const now=this.#time();
        const queued=normalizedRecord({
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
        },key);
        return this.#commitNormalizedRecord(queued);
    }

    async #persistEnqueue(request){
        throwIfAborted(request.signal);
        await this.#ready();
        throwIfAborted(request.signal);
        return this.#withTableMutation(
            this.#persistEnqueueLocked.bind(this,request)
        );
    }

    async enqueue({report,reportKey:key}={}, {attempt=true,signal=null}={}){
        if(typeof attempt!=='boolean'){
            fail('Mail outbox attempt must be boolean.','MAIL_OUTBOX_INVALID',TypeError);
        }
        const resolvedSignal=validateSignal(signal);
        throwIfAborted(resolvedSignal);
        const normalizedKey=reportKey(key);
        const serializedReport=serializeReport(report);
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
        const failure={
            code:'MAIL_OUTBOX_INTERRUPTED_ATTEMPT',
            statusCode:null,
            retryable:true,
            uncertain:true,
            retryAfterSeconds:null
        };
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
            failure:{
                code:uncertain
                    ?'MAIL_OUTBOX_RECONCILIATION_REQUIRED'
                    :'MAIL_OUTBOX_RETRY_WINDOW_EXPIRED',
                statusCode:record.failure?.statusCode??null,
                retryable:false,
                uncertain,
                retryAfterSeconds:null
            }
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
                failure:{
                    ...outcome.failure,
                    code:uncertain
                        ?'MAIL_OUTBOX_RECONCILIATION_REQUIRED'
                        :'MAIL_OUTBOX_RETRY_WINDOW_EXPIRED',
                    retryable:false,
                    retryAfterSeconds:null
                }
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
        if(signal?.aborted){
            await this.#write(updatedRecord(record,{
                updatedAt:Math.max(this.#time(),sending.updatedAt)
            }));
            throwIfAborted(signal);
        }
        let outcome;
        let deliveryError=null;
        try{
            const value=await this.#deliver(deliveryRequest(sending,signal));
            outcome=deliveryResult(value);
        }catch(error){
            deliveryError=error;
            outcome=deliveryFailure(error);
        }
        const completedAt=Math.max(this.#time(),sending.updatedAt);
        let committed;
        if(outcome.kind==='accepted'){
            committed=await this.#write(updatedRecord(sending,{
                state:'accepted',
                updatedAt:completedAt,
                nextAttemptAt:null,
                result:outcome.result,
                failure:null
            }));
        }else if(outcome.kind==='retry'){
            committed=await this.#recordRetry(sending,outcome,completedAt);
        }else{
            committed=await this.#write(updatedRecord(sending,{
                state:'failed',
                updatedAt:completedAt,
                nextAttemptAt:null,
                result:outcome.result,
                failure:outcome.failure
            }));
        }
        const cancellation=deliveryError
            ?abortedDeliveryError(deliveryError,signal)
            :null;
        if(cancellation) throw cancellation;
        return committed;
    }

    async #performDrain({reason,signal}){
        await this.#ready();
        throwIfAborted(signal);
        const inventory=await this.#inventory();
        const records=[...inventory.records];
        const invalidRecords=inventory.invalidRecords;
        let attempted=0;
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
            record=await this.#attempt(record,signal);
            records[index]=record;
            attempted+=1;
        }
        return summary(reason,online,records,attempted,invalidRecords);
    }

    async drain({reason='manual',signal=null}={}){
        const normalizedReason=drainReason(reason);
        const normalizedSignal=validateSignal(signal);
        throwIfAborted(normalizedSignal);
        if(this.#drainPromise){
            return waitForOutboxOperation(this.#drainPromise,normalizedSignal);
        }
        const operation=this.#withDrainAuthority(
            this.#performDrain.bind(this,{
                reason:normalizedReason,
                signal:normalizedSignal
            }),
            normalizedSignal
        );
        this.#drainPromise=operation;
        try{
            return await operation;
        }finally{
            if(this.#drainPromise===operation) this.#drainPromise=null;
        }
    }

    async #handleOnline(){
        if(this.#onlineController) return;
        const controller=new AbortController();
        this.#onlineController=controller;
        try{
            await this.drain({reason:'online',signal:controller.signal});
            this.#lastBackgroundError=null;
        }catch(error){
            if(error?.name!=='AbortError'&&error?.code!=='MAIL_OUTBOX_ABORTED'){
                this.#lastBackgroundError=error;
            }
        }finally{
            if(this.#onlineController===controller) this.#onlineController=null;
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
        this.#onlineController?.abort(new Error('Mail outbox online drain was stopped.'));
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
