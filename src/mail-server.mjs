import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import http from 'node:http';

export const RESEND_MAIL_SERVER_PROTOCOL='arcane-resend-mail-gateway/1';
export const RESEND_MAIL_PATH='/v1/mail';

const RESEND_EMAIL_ENDPOINT='https://api.resend.com/emails';
const APP_ID_PATTERN=/^[a-z0-9](?:[a-z0-9-]{0,62})$/u;
const EMAIL_PATTERN=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
const IDEMPOTENCY_KEY_PATTERN=/^[a-zA-Z0-9._:-]{8,128}$/u;
const PROVIDER_ID_PATTERN=/^[a-zA-Z0-9._:-]{1,256}$/u;
const PROVIDER_CODE_PATTERN=/^[a-z0-9_]{1,80}$/u;
const REQUEST_ID_PATTERN=/^[a-zA-Z0-9-]{8,128}$/u;
const JSON_CONTENT_TYPE_PATTERN=/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/iu;
const HEADER_NAME_PATTERN=/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu;
const MAIL_TYPES=new Set(['error','report','crisis_detected']);
const REPORT_KEYS=new Set(['html','subject','text','to','type']);
const PREFLIGHT_HEADERS=new Set([
    'content-type','idempotency-key','x-mail-app','x-mail-key'
]);
const PERMANENT_RATE_CODES=new Set(['daily_quota_exceeded','monthly_quota_exceeded']);
const RETRYABLE_PROVIDER_STATUSES=new Set([408,425,429,500,502,503,504]);
const DEFAULT_MAX_MESSAGE_BYTES=25*1024*1024;
const DEFAULT_MAX_REQUEST_BYTES=52*1024*1024;
const DEFAULT_MAX_PROVIDER_RESPONSE_BYTES=64*1024;
const DEFAULT_MAX_QUEUED_MESSAGE_BYTES=64*1024*1024;
const MAX_RETRY_AFTER_MS=24*60*60*1000;

class MailGatewayFault extends Error {
    constructor(code,{retryable=false,retryAfterMs=0,statusCode=400,uncertain=false}={}){
        super(code);
        this.name='MailGatewayFault';
        this.code=code;
        this.retryable=Boolean(retryable);
        this.retryAfterMs=boundedRetryAfter(retryAfterMs);
        this.statusCode=statusCode;
        this.uncertain=Boolean(uncertain);
    }
}

function configurationError(message){
    const error=new Error(message);
    error.code='ARCANE_MAIL_CONFIG_INVALID';
    return error;
}

function boundedInteger(value,fallback,{label,min,max}){
    const resolved=value===undefined?fallback:value;
    if(!Number.isSafeInteger(resolved)||resolved<min||resolved>max){
        throw configurationError(`${label} must be an integer between ${min} and ${max}.`);
    }
    return resolved;
}

function boundedRetryAfter(value){
    return Number.isSafeInteger(value)&&value>0
        ? Math.min(MAX_RETRY_AFTER_MS,value)
        : 0;
}

function validateSignal(signal){
    if(signal!==undefined&&!(signal instanceof AbortSignal)){
        throw new TypeError('Mail server signal must be an AbortSignal.');
    }
    return signal;
}

function validateApiKey(value){
    if(typeof value!=='string'||value.length<1||value.length>4096
        ||!/^[\x21-\x7e]+$/u.test(value)){
        throw configurationError('Resend API key must be a nonempty printable ASCII string.');
    }
    return value;
}

function validateAppId(value){
    if(typeof value!=='string'||!APP_ID_PATTERN.test(value)){
        throw configurationError('Mail application identity is invalid.');
    }
    return value;
}

function appKeyDigest(value){
    return createHash('sha256').update(value,'utf8').digest();
}

function normalizeCallerAuthentication(options){
    const allowUnauthenticatedCaller=options.allowUnauthenticatedCaller??false;
    if(typeof allowUnauthenticatedCaller!=='boolean'){
        throw configurationError('allowUnauthenticatedCaller must be a boolean.');
    }
    if(allowUnauthenticatedCaller){
        if(options.appKey!==undefined){
            throw configurationError(
                'appKey must be omitted when allowUnauthenticatedCaller is true.'
            );
        }
        return Object.freeze({
            appKeyDigest:null,
            callerAuthentication:'origin-app-id-only'
        });
    }
    if(typeof options.appKey!=='string'||options.appKey.length<16
        ||options.appKey.length>512||!/^[\x21-\x7e]+$/u.test(options.appKey)){
        throw configurationError(
            'appKey must contain 16-512 printable ASCII characters unless unauthenticated caller mode is explicitly enabled.'
        );
    }
    return Object.freeze({
        appKeyDigest:appKeyDigest(options.appKey),
        callerAuthentication:'app-key'
    });
}

function normalizedEmail(value,label){
    if(typeof value!=='string'){
        throw configurationError(`${label} must be an email address.`);
    }
    const normalized=value.trim().toLowerCase();
    if(normalized.length<3||normalized.length>254||!EMAIL_PATTERN.test(normalized)){
        throw configurationError(`${label} must be a valid email address.`);
    }
    return normalized;
}

function validateFrom(value){
    if(typeof value!=='string'||value!==value.trim()||value.length<3||value.length>320
        ||/[\u0000-\u001f\u007f]/u.test(value)){
        throw configurationError('Mail sender is invalid.');
    }
    if(EMAIL_PATTERN.test(value)){
        return value.toLowerCase();
    }
    const match=/^([^<>]{1,64}) <([^<>]+)>$/u.exec(value);
    if(!match||!match[1].trim()){
        throw configurationError('Mail sender must be an email address or Name <email> value.');
    }
    const address=normalizedEmail(match[2],'Mail sender');
    return `${match[1]} <${address}>`;
}

function normalizeEmailList(value,label,{allowEmpty=false}={}){
    if(!Array.isArray(value)||value.length>50||(!allowEmpty&&value.length===0)){
        throw configurationError(`${label} must contain ${allowEmpty?'zero to ':'one to '}50 addresses.`);
    }
    const result=[];
    const seen=new Set();
    for(const entry of value){
        const address=normalizedEmail(entry,label);
        if(seen.has(address)){
            throw configurationError(`${label} must not contain duplicate addresses.`);
        }
        seen.add(address);
        result.push(address);
    }
    return result;
}

function normalizeOrigin(value){
    if(typeof value!=='string'||!value.trim()){
        throw configurationError('Every allowed mail origin must be a URL origin.');
    }
    let url;
    try{
        url=new URL(value.trim());
    }catch{
        throw configurationError('Every allowed mail origin must be a valid URL origin.');
    }
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password
        ||url.pathname!=='/'||url.search||url.hash){
        throw configurationError('Every allowed mail origin must be an HTTP or HTTPS origin without credentials, path, query, or fragment.');
    }
    return url.origin;
}

function normalizeOrigins(value){
    if(!Array.isArray(value)||value.length===0||value.length>64){
        throw configurationError('allowedOrigins must contain one to 64 exact origins.');
    }
    const origins=[];
    const seen=new Set();
    for(const entry of value){
        const origin=normalizeOrigin(entry);
        if(seen.has(origin)){
            throw configurationError('allowedOrigins must not contain duplicate origins.');
        }
        seen.add(origin);
        origins.push(origin);
    }
    return new Set(origins);
}

function validateLoopbackHost(value){
    if(value!=='127.0.0.1'&&value!=='::1'){
        throw configurationError('Mail server host must be the numeric loopback address 127.0.0.1 or ::1.');
    }
    return value;
}

function normalizeConfiguration(options={}){
    if(!options||typeof options!=='object'||Array.isArray(options)){
        throw configurationError('Mail server options must be an object.');
    }
    const callerAuthentication=normalizeCallerAuthentication(options);
    const recipientAllowlist=normalizeEmailList(
        options.recipientAllowlist,
        'recipientAllowlist'
    );
    const errorRecipients=normalizeEmailList(
        options.errorRecipients??[],
        'errorRecipients',
        {allowEmpty:true}
    );
    const allowedRecipients=new Set(recipientAllowlist);
    if(errorRecipients.some(function errorRecipientIsNotAllowed(address){
        return !allowedRecipients.has(address);
    })){
        throw configurationError('Every error recipient must also be in recipientAllowlist.');
    }
    const maxMessageBytes=boundedInteger(
        options.maxMessageBytes,
        DEFAULT_MAX_MESSAGE_BYTES,
        {label:'maxMessageBytes',min:1,max:DEFAULT_MAX_MESSAGE_BYTES}
    );
    const maxRequestBytes=boundedInteger(
        options.maxRequestBytes,
        DEFAULT_MAX_REQUEST_BYTES,
        {label:'maxRequestBytes',min:256,max:64*1024*1024}
    );
    if(maxRequestBytes<maxMessageBytes+256){
        throw configurationError('maxRequestBytes must leave at least 256 bytes beyond maxMessageBytes.');
    }
    const fetchImpl=options.fetchImpl??globalThis.fetch;
    if(typeof fetchImpl!=='function'){
        throw configurationError('A fetch implementation is required for Resend delivery.');
    }
    if(options.onEvent!==undefined&&typeof options.onEvent!=='function'){
        throw configurationError('onEvent must be a function when supplied.');
    }
    if(options.requestIdFactory!==undefined&&typeof options.requestIdFactory!=='function'){
        throw configurationError('requestIdFactory must be a function when supplied.');
    }
    return Object.freeze({
        allowAnyRecipient:false,
        allowedOrigins:normalizeOrigins(options.allowedOrigins),
        allowedRecipients,
        apiKey:validateApiKey(options.apiKey),
        appKeyDigest:callerAuthentication.appKeyDigest,
        appId:validateAppId(options.appId),
        bodyQueueTimeoutMs:boundedInteger(
            options.bodyQueueTimeoutMs,
            5_000,
            {label:'bodyQueueTimeoutMs',min:1,max:60_000}
        ),
        bodyTimeoutMs:boundedInteger(
            options.bodyTimeoutMs,
            10_000,
            {label:'bodyTimeoutMs',min:100,max:120_000}
        ),
        errorRecipients,
        fetchImpl,
        from:validateFrom(options.from),
        host:validateLoopbackHost(options.host??'127.0.0.1'),
        callerAuthentication:callerAuthentication.callerAuthentication,
        maxConcurrentBodyReads:boundedInteger(
            options.maxConcurrentBodyReads,
            8,
            {label:'maxConcurrentBodyReads',min:1,max:64}
        ),
        maxConcurrentSends:boundedInteger(
            options.maxConcurrentSends,
            2,
            {label:'maxConcurrentSends',min:1,max:16}
        ),
        maxMessageBytes,
        maxProviderResponseBytes:boundedInteger(
            options.maxProviderResponseBytes,
            DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
            {label:'maxProviderResponseBytes',min:64,max:1024*1024}
        ),
        maxQueuedBodyReads:boundedInteger(
            options.maxQueuedBodyReads,
            64,
            {label:'maxQueuedBodyReads',min:0,max:1024}
        ),
        maxQueuedSends:boundedInteger(
            options.maxQueuedSends,
            32,
            {label:'maxQueuedSends',min:0,max:1024}
        ),
        maxQueuedMessageBytes:boundedInteger(
            options.maxQueuedMessageBytes,
            DEFAULT_MAX_QUEUED_MESSAGE_BYTES,
            {label:'maxQueuedMessageBytes',min:0,max:512*1024*1024}
        ),
        maxRequestBytes,
        onEvent:options.onEvent,
        observerDrainTimeoutMs:boundedInteger(
            options.observerDrainTimeoutMs,
            1_000,
            {label:'observerDrainTimeoutMs',min:1,max:10_000}
        ),
        port:boundedInteger(options.port,8025,{label:'port',min:0,max:65_535}),
        providerTimeoutMs:boundedInteger(
            options.providerTimeoutMs,
            120_000,
            {label:'providerTimeoutMs',min:100,max:600_000}
        ),
        requestIdFactory:options.requestIdFactory??randomUUID,
        retryableDelayMs:boundedInteger(
            options.retryableDelayMs,
            1_000,
            {label:'retryableDelayMs',min:1,max:60_000}
        ),
        sendQueueTimeoutMs:boundedInteger(
            options.sendQueueTimeoutMs,
            10_000,
            {label:'sendQueueTimeoutMs',min:1,max:120_000}
        ),
        signal:validateSignal(options.signal)
    });
}

function createRequestId(factory){
    try{
        const candidate=factory();
        if(typeof candidate==='string'&&REQUEST_ID_PATTERN.test(candidate)){
            return candidate;
        }
    }catch{
        // A diagnostic identifier must never prevent a bounded error response.
    }
    return randomUUID();
}

function isNumericLoopback(value){
    return value==='127.0.0.1'||value==='::1'||value==='::ffff:127.0.0.1';
}

function headerValues(request,name){
    const distinct=request.headersDistinct?.[name];
    if(Array.isArray(distinct)){
        return distinct.map(function stringifyDistinctHeader(value){return String(value);});
    }
    const values=[];
    for(let index=0;index<(request.rawHeaders?.length??0);index+=2){
        if(String(request.rawHeaders[index]).toLowerCase()===name){
            values.push(String(request.rawHeaders[index+1]??''));
        }
    }
    if(values.length>0){
        return values;
    }
    const fallback=request.headers?.[name];
    if(fallback===undefined){
        return [];
    }
    return Array.isArray(fallback)?fallback.map(String):[String(fallback)];
}

function singleHeader(request,name,{required=true}={}){
    const values=headerValues(request,name);
    if(values.length===0&&!required){
        return '';
    }
    if(values.length!==1||!values[0]){
        throw new MailGatewayFault('mail_invalid_headers',{statusCode:400});
    }
    return values[0];
}

function validateLoopbackRequest(request){
    if(!isNumericLoopback(request.socket?.remoteAddress)
        ||!isNumericLoopback(request.socket?.localAddress)){
        throw new MailGatewayFault('mail_loopback_required',{statusCode:421});
    }
    const rawHost=singleHeader(request,'host');
    let parsed;
    try{
        parsed=new URL(`http://${rawHost}`);
    }catch{
        throw new MailGatewayFault('mail_invalid_host',{statusCode:421});
    }
    const hostname=parsed.hostname.replace(/^\[|\]$/gu,'');
    const localPort=request.socket?.localPort;
    const statedPort=parsed.port?Number(parsed.port):80;
    const hostLiteral=hostname.includes(':')?`[${hostname}]`:hostname;
    const expectedAuthority=localPort===80?hostLiteral:`${hostLiteral}:${String(localPort)}`;
    if(parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash
        ||!isNumericLoopback(hostname)||!Number.isSafeInteger(localPort)
        ||statedPort!==localPort||rawHost!==expectedAuthority){
        throw new MailGatewayFault('mail_invalid_host',{statusCode:421});
    }
}

function allowedOrigin(request,configuration){
    const origin=singleHeader(request,'origin');
    if(!configuration.allowedOrigins.has(origin)){
        throw new MailGatewayFault('mail_origin_not_allowed',{statusCode:403});
    }
    return origin;
}

function authenticateLocalCaller(request,configuration){
    const values=headerValues(request,'x-mail-key');
    if(configuration.callerAuthentication==='origin-app-id-only'){
        if(values.length!==0){
            throw new MailGatewayFault('mail_app_key_unexpected',{statusCode:403});
        }
        return;
    }
    const candidate=values.length===1?values[0]:'';
    const candidateIsValid=candidate.length>=16&&candidate.length<=512
        &&/^[\x21-\x7e]+$/u.test(candidate);
    const digest=appKeyDigest(candidateIsValid?candidate:'');
    const authenticated=timingSafeEqual(configuration.appKeyDigest,digest);
    if(values.length!==1||!candidateIsValid||!authenticated){
        throw new MailGatewayFault('mail_app_key_invalid',{statusCode:401});
    }
}

function corsHeaders(origin,{allowPrivateNetwork=false}={}){
    if(!origin){
        return {};
    }
    return {
        'access-control-allow-headers':'Content-Type, Idempotency-Key, X-Mail-App, X-Mail-Key',
        'access-control-allow-methods':'POST, OPTIONS',
        'access-control-allow-origin':origin,
        'access-control-expose-headers':'Retry-After',
        'access-control-max-age':'600',
        ...(allowPrivateNetwork?{'access-control-allow-private-network':'true'}:{}),
        'vary':'Origin'
    };
}

function baseResponseHeaders(origin){
    return {
        'cache-control':'no-store',
        'content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        'cross-origin-resource-policy':'cross-origin',
        'referrer-policy':'no-referrer',
        'x-content-type-options':'nosniff',
        ...corsHeaders(origin)
    };
}

function writeJson(response,statusCode,value,{origin='',retryAfterMs=0}={}){
    if(response.destroyed||response.writableEnded){
        return false;
    }
    const body=JSON.stringify(value);
    const headers={
        ...baseResponseHeaders(origin),
        'content-length':String(Buffer.byteLength(body,'utf8')),
        'content-type':'application/json; charset=utf-8'
    };
    const boundedDelay=boundedRetryAfter(retryAfterMs);
    if(boundedDelay){
        headers['retry-after']=String(Math.max(1,Math.ceil(boundedDelay/1000)));
    }
    response.writeHead(statusCode,headers);
    response.end(body);
    return true;
}

function writePreflight(response,origin,{allowPrivateNetwork=false}={}){
    if(response.destroyed||response.writableEnded){
        return false;
    }
    response.writeHead(204,{
        ...baseResponseHeaders(origin),
        ...corsHeaders(origin,{allowPrivateNetwork}),
        'content-length':'0'
    });
    response.end();
    return true;
}

function writeFault(response,requestId,fault,origin=''){
    const retryAfterMs=boundedRetryAfter(fault.retryAfterMs);
    return writeJson(response,fault.statusCode,{
        requestId,
        error:{
            code:PROVIDER_CODE_PATTERN.test(fault.code)?fault.code:'mail_gateway_error',
            retryable:Boolean(fault.retryable),
            uncertain:Boolean(fault.uncertain),
            ...(retryAfterMs?{retryAfterMs}:{})
        }
    },{origin,retryAfterMs});
}

function normalizeFault(error){
    if(error instanceof MailGatewayFault){
        return error;
    }
    return new MailGatewayFault('mail_gateway_error',{statusCode:500});
}

function validatePreflight(request){
    if(singleHeader(request,'access-control-request-method')!=='POST'){
        throw new MailGatewayFault('mail_preflight_denied',{statusCode:403});
    }
    const rawHeaders=singleHeader(request,'access-control-request-headers');
    const requestedHeaders=rawHeaders.split(',').map(function normalizeRequestedHeader(value){
        return value.trim().toLowerCase();
    });
    if(requestedHeaders.length===0||requestedHeaders.some(function headerIsNotAllowed(value){
        return !value||!HEADER_NAME_PATTERN.test(value)||!PREFLIGHT_HEADERS.has(value);
    })){
        throw new MailGatewayFault('mail_preflight_denied',{statusCode:403});
    }
    const privateNetwork=singleHeader(
        request,
        'access-control-request-private-network',
        {required:false}
    );
    if(privateNetwork&&privateNetwork!=='true'){
        throw new MailGatewayFault('mail_preflight_denied',{statusCode:403});
    }
    return {allowPrivateNetwork:privateNetwork==='true'};
}

function createObserver(onEvent,drainTimeoutMs){
    const pending=new Set();
    function observe(event){
        if(!onEvent){
            return;
        }
        let result;
        try{
            result=onEvent(Object.freeze({...event}));
        }catch{
            return;
        }
        if(!result||typeof result.then!=='function'){
            return;
        }
        const task=Promise.resolve(result);
        pending.add(task);
        task.catch(function ignoreObserverFailure(){})
            .finally(function releaseObserverTask(){pending.delete(task);});
    }
    async function drain(){
        if(pending.size===0){
            return;
        }
        let timer;
        const timeout=new Promise(function boundObserverDrain(resolve){
            timer=setTimeout(resolve,drainTimeoutMs);
        });
        await Promise.race([Promise.allSettled([...pending]),timeout]);
        clearTimeout(timer);
        pending.clear();
    }
    return {drain,observe};
}

function createScheduler({concurrency,maxQueued,queueTimeoutMs,retryAfterMs,code,
    maxQueuedWeight=Number.MAX_SAFE_INTEGER,weightCode=code}){
    let active=0;
    let closed=false;
    let queuedWeight=0;
    const pending=[];
    const idleWaiters=[];

    function notifyIdle(){
        if(active!==0||pending.length!==0){
            return;
        }
        while(idleWaiters.length){
            idleWaiters.shift()();
        }
    }

    function cleanupItem(item){
        if(item.timeout){
            clearTimeout(item.timeout);
        }
        item.signal?.removeEventListener('abort',item.onAbort);
    }

    function releaseQueuedWeight(item){
        if(!item.queued){
            return;
        }
        item.queued=false;
        queuedWeight-=item.weight;
    }

    function removePending(item){
        const index=pending.indexOf(item);
        if(index>=0){
            pending.splice(index,1);
            releaseQueuedWeight(item);
            return true;
        }
        return false;
    }

    function rejectQueuedItem(item,fault){
        if(!removePending(item)){
            return;
        }
        cleanupItem(item);
        item.reject(fault);
        notifyIdle();
    }

    function dispatch(){
        while(!closed&&active<concurrency&&pending.length){
            const item=pending.shift();
            startItem(item);
        }
        notifyIdle();
    }

    async function executeItem(item){
        try{
            item.resolve(await item.work());
        }catch(error){
            item.reject(error);
        }finally{
            active-=1;
            dispatch();
        }
    }

    function startItem(item){
        releaseQueuedWeight(item);
        cleanupItem(item);
        if(item.signal?.aborted){
            item.reject(new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            }));
            dispatch();
            return;
        }
        active+=1;
        void executeItem(item);
    }

    function schedule(work,{signal,weight=0}={}){
        if(closed){
            return Promise.reject(new MailGatewayFault('mail_server_stopping',{
                retryable:true,
                retryAfterMs,
                statusCode:503
            }));
        }
        if(signal?.aborted){
            return Promise.reject(new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            }));
        }
        if(!Number.isSafeInteger(weight)||weight<0){
            return Promise.reject(new MailGatewayFault('mail_invalid_queue_weight',{
                statusCode:500
            }));
        }
        return new Promise(function createScheduledWork(resolve,reject){
            const item={
                onAbort:null,
                queued:false,
                reject,
                resolve,
                signal,
                timeout:null,
                weight,
                work
            };
            item.onAbort=function cancelQueuedWork(){
                rejectQueuedItem(item,new MailGatewayFault('mail_request_cancelled',{
                    retryable:true,
                    statusCode:408
                }));
            };
            if(active<concurrency){
                startItem(item);
                return;
            }
            if(pending.length>=maxQueued){
                reject(new MailGatewayFault(code,{
                    retryable:true,
                    retryAfterMs,
                    statusCode:503
                }));
                return;
            }
            if(weight>maxQueuedWeight||queuedWeight>maxQueuedWeight-weight){
                reject(new MailGatewayFault(weightCode,{
                    retryable:true,
                    retryAfterMs,
                    statusCode:503
                }));
                return;
            }
            item.queued=true;
            queuedWeight+=weight;
            pending.push(item);
            item.signal?.addEventListener('abort',item.onAbort,{once:true});
            if(item.signal?.aborted){
                item.onAbort();
                return;
            }
            item.timeout=setTimeout(function expireQueuedWork(){
                rejectQueuedItem(item,new MailGatewayFault(`${code}_timeout`,{
                    retryable:true,
                    retryAfterMs,
                    statusCode:503
                }));
            },queueTimeoutMs);
        });
    }

    function close(){
        if(closed){
            return;
        }
        closed=true;
        while(pending.length){
            const item=pending.shift();
            releaseQueuedWeight(item);
            cleanupItem(item);
            item.reject(new MailGatewayFault('mail_server_stopping',{
                retryable:true,
                retryAfterMs,
                statusCode:503
            }));
        }
        notifyIdle();
    }

    function idle(){
        if(active===0&&pending.length===0){
            return Promise.resolve();
        }
        return new Promise(function waitForSchedulerIdle(resolve){
            idleWaiters.push(resolve);
        });
    }

    return {close,idle,schedule};
}

function requestContentLength(request,maxRequestBytes){
    const raw=singleHeader(request,'content-length',{required:false});
    if(!raw){
        return null;
    }
    if(!/^\d+$/u.test(raw)){
        throw new MailGatewayFault('mail_invalid_content_length',{statusCode:400});
    }
    const length=Number(raw);
    if(!Number.isSafeInteger(length)){
        throw new MailGatewayFault('mail_invalid_content_length',{statusCode:400});
    }
    if(length>maxRequestBytes){
        throw new MailGatewayFault('mail_request_too_large',{statusCode:413});
    }
    return length;
}

function readRequestBody(request,{maxRequestBytes,timeoutMs,signal}){
    return new Promise(function collectRequestBody(resolve,reject){
        const chunks=[];
        let byteLength=0;
        let settled=false;
        const timer=setTimeout(function expireRequestBody(){
            finish(new MailGatewayFault('mail_body_timeout',{
                retryable:true,
                statusCode:408
            }));
            request.resume();
        },timeoutMs);

        function cleanup(){
            clearTimeout(timer);
            request.removeListener('data',onData);
            request.removeListener('end',onEnd);
            request.removeListener('error',onError);
            request.removeListener('aborted',onAborted);
            signal?.removeEventListener('abort',onSignalAbort);
        }

        function finish(error,value){
            if(settled){
                return;
            }
            settled=true;
            cleanup();
            if(error){
                reject(error);
            }else{
                resolve(value);
            }
        }

        function onData(chunk){
            const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
            byteLength+=bytes.length;
            if(byteLength>maxRequestBytes){
                finish(new MailGatewayFault('mail_request_too_large',{statusCode:413}));
                request.resume();
                return;
            }
            chunks.push(bytes);
        }

        function onEnd(){
            finish(null,Buffer.concat(chunks,byteLength).toString('utf8'));
        }

        function onError(){
            finish(new MailGatewayFault('mail_request_stream_failed',{
                retryable:true,
                statusCode:400
            }));
        }

        function onAborted(){
            finish(new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            }));
        }

        function onSignalAbort(){
            finish(new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            }));
            request.resume();
        }

        request.on('data',onData);
        request.once('end',onEnd);
        request.once('error',onError);
        request.once('aborted',onAborted);
        signal?.addEventListener('abort',onSignalAbort,{once:true});
        if(signal?.aborted){
            onSignalAbort();
        }
    });
}

function utf8Bytes(value){
    return Buffer.byteLength(value,'utf8');
}

function normalizedReportEmail(value){
    if(typeof value!=='string'){
        throw new MailGatewayFault('mail_invalid_recipient',{statusCode:422});
    }
    const address=value.trim().toLowerCase();
    if(address.length<3||address.length>254||!EMAIL_PATTERN.test(address)){
        throw new MailGatewayFault('mail_invalid_recipient',{statusCode:422});
    }
    return address;
}

function normalizeReportRecipients(report,configuration){
    if(!Array.isArray(report.to)||report.to.length>50){
        throw new MailGatewayFault('mail_invalid_recipients',{statusCode:422});
    }
    const recipients=[];
    const seen=new Set();
    for(const value of report.to){
        const address=normalizedReportEmail(value);
        if(seen.has(address)){
            throw new MailGatewayFault('mail_duplicate_recipient',{statusCode:422});
        }
        if(!configuration.allowAnyRecipient&&!configuration.allowedRecipients.has(address)){
            throw new MailGatewayFault('mail_recipient_not_allowed',{statusCode:403});
        }
        seen.add(address);
        recipients.push(address);
    }
    if(recipients.length===0&&report.type==='error'){
        recipients.push(...configuration.errorRecipients);
    }
    if(recipients.length===0){
        throw new MailGatewayFault('mail_recipients_required',{statusCode:422});
    }
    return recipients;
}

function normalizeReport(value,configuration){
    if(!value||typeof value!=='object'||Array.isArray(value)){
        throw new MailGatewayFault('mail_invalid_report',{statusCode:422});
    }
    const keys=Object.keys(value);
    if(keys.some(function reportKeyIsUnknown(key){return !REPORT_KEYS.has(key);})
        ||!Object.hasOwn(value,'subject')||!Object.hasOwn(value,'to')
        ||!Object.hasOwn(value,'type')){
        throw new MailGatewayFault('mail_invalid_report_shape',{statusCode:422});
    }
    if(typeof value.type!=='string'||!MAIL_TYPES.has(value.type)){
        throw new MailGatewayFault('mail_invalid_type',{statusCode:422});
    }
    if(typeof value.subject!=='string'||value.subject!==value.subject.trim()
        ||value.subject.length<1||value.subject.length>160
        ||/[\u0000-\u001f\u007f]/u.test(value.subject)){
        throw new MailGatewayFault('mail_invalid_subject',{statusCode:422});
    }
    const hasText=Object.hasOwn(value,'text');
    const hasHtml=Object.hasOwn(value,'html');
    if(!hasText&&!hasHtml||(hasText&&typeof value.text!=='string')
        ||(hasHtml&&typeof value.html!=='string')){
        throw new MailGatewayFault('mail_content_required',{statusCode:422});
    }
    const text=hasText?value.text:'';
    const html=hasHtml?value.html:'';
    if(!/\S/u.test(text)&&!/\S/u.test(html)){
        throw new MailGatewayFault('mail_content_required',{statusCode:422});
    }
    const unsupportedControl=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
    if(unsupportedControl.test(text)||unsupportedControl.test(html)){
        throw new MailGatewayFault('mail_unsupported_content',{statusCode:422});
    }
    const messageBytes=utf8Bytes(text)+utf8Bytes(html);
    if(messageBytes>configuration.maxMessageBytes){
        throw new MailGatewayFault('mail_message_too_large',{statusCode:413});
    }
    const recipients=normalizeReportRecipients(value,configuration);
    const providerBody={
        from:configuration.from,
        to:recipients,
        subject:value.subject,
        ...(hasText?{text:value.text}:{}),
        ...(hasHtml?{html:value.html}:{})
    };
    const serializedProviderBody=JSON.stringify(providerBody);
    if(utf8Bytes(serializedProviderBody)>configuration.maxRequestBytes){
        throw new MailGatewayFault('mail_request_too_large',{statusCode:413});
    }
    return {
        providerBody:serializedProviderBody,
        providerBodyBytes:utf8Bytes(serializedProviderBody),
        recipientCount:recipients.length
    };
}

function parseReport(serialized,configuration){
    let value;
    try{
        value=JSON.parse(serialized);
    }catch{
        throw new MailGatewayFault('mail_invalid_json',{statusCode:400});
    }
    return normalizeReport(value,configuration);
}

function parseRetryAfter(value,now=Date.now()){
    if(typeof value!=='string'||!value.trim()){
        return 0;
    }
    const trimmed=value.trim();
    if(/^\d+(?:\.\d+)?$/u.test(trimmed)){
        return boundedRetryAfter(Math.ceil(Number(trimmed)*1000));
    }
    const timestamp=Date.parse(trimmed);
    return Number.isFinite(timestamp)
        ? boundedRetryAfter(Math.max(0,timestamp-now))
        : 0;
}

function responseHeader(response,name){
    try{
        const value=response.headers?.get?.(name);
        return value===null||value===undefined?'':String(value);
    }catch{
        return '';
    }
}

function awaitAbortable(value,signal){
    return new Promise(function waitForAbortable(resolve,reject){
        let settled=false;
        function cleanup(){
            signal?.removeEventListener('abort',onAbort);
        }
        function settleResolved(result){
            if(settled)return;
            settled=true;
            cleanup();
            resolve(result);
        }
        function settleRejected(error){
            if(settled)return;
            settled=true;
            cleanup();
            reject(error);
        }
        function onAbort(){
            settleRejected(signal.reason??new Error('Operation cancelled.'));
        }
        signal?.addEventListener('abort',onAbort,{once:true});
        Promise.resolve(value).then(settleResolved,settleRejected);
        if(signal?.aborted){
            onAbort();
        }
    });
}

function ignoreCancellationFailure(){}

function cancelProviderBody(body){
    if(!body||typeof body.cancel!=='function'){
        return;
    }
    try{
        Promise.resolve(body.cancel()).catch(ignoreCancellationFailure);
    }catch{
        // Cancellation is best-effort after the response boundary is classified.
    }
}

function cancelProviderReader(reader){
    if(!reader||typeof reader.cancel!=='function'){
        return;
    }
    try{
        Promise.resolve(reader.cancel()).catch(ignoreCancellationFailure);
    }catch{
        // Cancellation is best-effort after the response boundary is classified.
    }
}

async function readProviderBody(response,maxBytes,signal){
    const declared=responseHeader(response,'content-length');
    if(declared){
        if(!/^\d+$/u.test(declared)||!Number.isSafeInteger(Number(declared))
            ||Number(declared)>maxBytes){
            cancelProviderBody(response.body);
            throw new MailGatewayFault('resend_response_too_large',{
                statusCode:502,
                uncertain:true
            });
        }
    }
    if(response.body===null||response.body===undefined){
        return '';
    }
    if(typeof response.body.getReader!=='function'){
        cancelProviderBody(response.body);
        throw new MailGatewayFault('resend_unreadable_response',{
            statusCode:502,
            uncertain:true
        });
    }
    const reader=response.body.getReader();
    const chunks=[];
    let byteLength=0;
    let fullyRead=false;
    try{
        while(true){
            const result=await awaitAbortable(reader.read(),signal);
            if(result.done){
                fullyRead=true;
                break;
            }
            if(!(result.value instanceof Uint8Array)){
                throw new MailGatewayFault('resend_unreadable_response',{
                    statusCode:502,
                    uncertain:true
                });
            }
            byteLength+=result.value.byteLength;
            if(byteLength>maxBytes){
                throw new MailGatewayFault('resend_response_too_large',{
                    statusCode:502,
                    uncertain:true
                });
            }
            chunks.push(Buffer.from(result.value));
        }
        return Buffer.concat(chunks,byteLength).toString('utf8');
    }finally{
        if(!fullyRead){
            cancelProviderReader(reader);
        }
        try{
            reader.releaseLock();
        }catch{
            // An untrusted stream implementation cannot replace the provider classification.
        }
    }
}

function parseProviderObject(text){
    if(!text){
        return null;
    }
    try{
        const value=JSON.parse(text);
        return value&&typeof value==='object'&&!Array.isArray(value)?value:null;
    }catch{
        return null;
    }
}

function providerCode(value,statusCode){
    const candidate=value?.name;
    if(typeof candidate==='string'&&PROVIDER_CODE_PATTERN.test(candidate)){
        return candidate;
    }
    return `resend_http_${String(statusCode)}`;
}

function providerRejection(statusCode,value,retryAfterMs,defaultRetryAfterMs){
    const code=providerCode(value,statusCode);
    const permanentRateLimit=PERMANENT_RATE_CODES.has(code);
    const retryable=code==='concurrent_idempotent_requests'
        ||(statusCode===409&&code!=='invalid_idempotent_request')
        ||(!permanentRateLimit&&code!=='invalid_idempotent_request'
            &&RETRYABLE_PROVIDER_STATUSES.has(statusCode));
    const resolvedDelay=retryable
        ? boundedRetryAfter(retryAfterMs||defaultRetryAfterMs)
        : 0;
    return {
        kind:'rejected',
        fault:new MailGatewayFault(code,{
            retryable,
            retryAfterMs:resolvedDelay,
            statusCode:retryable?(statusCode===429?429:503):422
        }),
        providerStatus:statusCode
    };
}

function ambiguousResult(code,retryAfterMs,providerStatus=0){
    return {
        code,
        kind:'ambiguous',
        providerStatus,
        retryAfterMs:boundedRetryAfter(retryAfterMs)
    };
}

async function performResendAttempt(configuration,delivery,idempotencyKey,signal,requestId,observe){
    const controller=new AbortController();
    let timedOut=false;
    function forwardAbort(){
        controller.abort(signal?.reason??new Error('Mail request cancelled.'));
    }
    signal?.addEventListener('abort',forwardAbort,{once:true});
    if(signal?.aborted){
        forwardAbort();
    }
    const timeout=setTimeout(function expireResendAttempt(){
        timedOut=true;
        controller.abort(new Error('Resend request timed out.'));
    },configuration.providerTimeoutMs);
    const startedAt=Date.now();
    observe({
        type:'mail.provider.started',
        appId:configuration.appId,
        requestId
    });
    let response;
    try{
        try{
            response=await awaitAbortable(configuration.fetchImpl(RESEND_EMAIL_ENDPOINT,{
                method:'POST',
                headers:{
                    'Authorization':`Bearer ${configuration.apiKey}`,
                    'Content-Type':'application/json',
                    'Idempotency-Key':idempotencyKey,
                    'User-Agent':'arcane-os-sdk-mail/1'
                },
                body:delivery.providerBody,
                redirect:'error',
                referrerPolicy:'no-referrer',
                signal:controller.signal
            }),controller.signal);
        }catch{
            return ambiguousResult(
                timedOut?'resend_timeout':'resend_transport_uncertain',
                configuration.retryableDelayMs
            );
        }
        const statusCode=Number(response?.status);
        if(!Number.isSafeInteger(statusCode)||statusCode<100||statusCode>599){
            return ambiguousResult('resend_invalid_response',configuration.retryableDelayMs);
        }
        let text='';
        try{
            text=await readProviderBody(
                response,
                configuration.maxProviderResponseBytes,
                controller.signal
            );
        }catch(error){
            if(statusCode>=200&&statusCode<300||controller.signal.aborted){
                return ambiguousResult(
                    error instanceof MailGatewayFault?error.code:'resend_transport_uncertain',
                    configuration.retryableDelayMs,
                    statusCode
                );
            }
            return providerRejection(
                statusCode,
                null,
                parseRetryAfter(responseHeader(response,'retry-after')),
                configuration.retryableDelayMs
            );
        }
        const value=parseProviderObject(text);
        if(statusCode>=200&&statusCode<300){
            if(!value||typeof value.id!=='string'||!PROVIDER_ID_PATTERN.test(value.id)){
                return ambiguousResult(
                    'resend_invalid_success_response',
                    configuration.retryableDelayMs,
                    statusCode
                );
            }
            return {
                kind:'accepted',
                providerId:value.id,
                providerStatus:statusCode
            };
        }
        return providerRejection(
            statusCode,
            value,
            parseRetryAfter(responseHeader(response,'retry-after')),
            configuration.retryableDelayMs
        );
    }finally{
        clearTimeout(timeout);
        signal?.removeEventListener('abort',forwardAbort);
        observe({
            type:'mail.provider.completed',
            appId:configuration.appId,
            durationMs:Math.max(0,Date.now()-startedAt),
            requestId,
            providerStatus:Number.isSafeInteger(Number(response?.status))?Number(response.status):0
        });
    }
}

function normalizeDirectSendOptions(options){
    if(!options||typeof options!=='object'||Array.isArray(options)){
        throw configurationError('Mail send options must be an object.');
    }
    if(typeof options.reportKey!=='string'||!IDEMPOTENCY_KEY_PATTERN.test(options.reportKey)){
        throw configurationError('reportKey must contain 8-128 safe identifier characters.');
    }
    const maxMessageBytes=boundedInteger(
        options.maxMessageBytes,
        DEFAULT_MAX_MESSAGE_BYTES,
        {label:'maxMessageBytes',min:1,max:DEFAULT_MAX_MESSAGE_BYTES}
    );
    const maxRequestBytes=boundedInteger(
        options.maxRequestBytes,
        DEFAULT_MAX_REQUEST_BYTES,
        {label:'maxRequestBytes',min:256,max:64*1024*1024}
    );
    if(maxRequestBytes<maxMessageBytes+256){
        throw configurationError('maxRequestBytes must leave at least 256 bytes beyond maxMessageBytes.');
    }
    const fetchImpl=options.fetchImpl??globalThis.fetch;
    if(typeof fetchImpl!=='function'){
        throw configurationError('A fetch implementation is required for Resend delivery.');
    }
    if(options.onEvent!==undefined&&typeof options.onEvent!=='function'){
        throw configurationError('onEvent must be a function when supplied.');
    }
    if(options.requestIdFactory!==undefined&&typeof options.requestIdFactory!=='function'){
        throw configurationError('requestIdFactory must be a function when supplied.');
    }
    return Object.freeze({
        allowAnyRecipient:true,
        allowedRecipients:null,
        apiKey:validateApiKey(options.apiKey),
        appId:validateAppId(options.appId),
        errorRecipients:[],
        fetchImpl,
        from:validateFrom(options.from),
        maxMessageBytes,
        maxProviderResponseBytes:boundedInteger(
            options.maxProviderResponseBytes,
            DEFAULT_MAX_PROVIDER_RESPONSE_BYTES,
            {label:'maxProviderResponseBytes',min:64,max:1024*1024}
        ),
        maxRequestBytes,
        observerDrainTimeoutMs:boundedInteger(
            options.observerDrainTimeoutMs,
            1_000,
            {label:'observerDrainTimeoutMs',min:1,max:10_000}
        ),
        providerTimeoutMs:boundedInteger(
            options.providerTimeoutMs,
            120_000,
            {label:'providerTimeoutMs',min:100,max:600_000}
        ),
        requestIdFactory:options.requestIdFactory??randomUUID,
        retryableDelayMs:boundedInteger(
            options.retryableDelayMs,
            1_000,
            {label:'retryableDelayMs',min:1,max:60_000}
        ),
        signal:validateSignal(options.signal),
        report:options.report,
        reportKey:options.reportKey,
        onEvent:options.onEvent
    });
}

function directSendResult(result,{recipientCount,requestId}){
    const common={
        provider:'resend',
        status:result.kind==='accepted'
            ?'accepted'
            :result.kind==='ambiguous'?'delivery_uncertain':'rejected',
        classification:result.kind==='rejected'
            ?result.fault.retryable?'retryable':'permanent'
            :result.kind,
        requestId,
        providerStatus:result.providerStatus,
        recipientCount
    };
    if(result.kind==='accepted'){
        return Object.freeze({...common,providerId:result.providerId});
    }
    if(result.kind==='ambiguous'){
        return Object.freeze({
            ...common,
            code:result.code,
            ...(result.retryAfterMs?{retryAfterMs:result.retryAfterMs}:{}),
            retryable:true,
            uncertain:true
        });
    }
    return Object.freeze({
        ...common,
        code:result.fault.code,
        ...(result.fault.retryAfterMs?{retryAfterMs:result.fault.retryAfterMs}:{}),
        retryable:result.fault.retryable,
        uncertain:false
    });
}

export async function sendResendMail(options={}){
    const configuration=normalizeDirectSendOptions(options);
    const delivery=normalizeReport(configuration.report,configuration);
    if(configuration.signal?.aborted){
        const error=new Error('Mail send cancelled before provider attempt.');
        error.code='ARCANE_CANCELLED';
        throw error;
    }
    const requestId=createRequestId(configuration.requestIdFactory);
    const observer=createObserver(
        configuration.onEvent,
        configuration.observerDrainTimeoutMs
    );
    try{
        const result=await performResendAttempt(
            configuration,
            delivery,
            configuration.reportKey,
            configuration.signal,
            requestId,
            observer.observe
        );
        return directSendResult(result,{
            recipientCount:delivery.recipientCount,
            requestId
        });
    }finally{
        await observer.drain();
    }
}

function sendProviderResult(response,result,{origin,requestId,recipientCount}){
    if(result.kind==='accepted'){
        return writeJson(response,202,{
            requestId,
            status:'accepted',
            accepted:recipientCount,
            rejected:0,
            providerId:result.providerId
        },{origin});
    }
    if(result.kind==='ambiguous'){
        return writeJson(response,207,{
            requestId,
            status:'delivery_uncertain',
            accepted:0,
            rejected:0,
            ...(result.retryAfterMs?{retryAfterMs:result.retryAfterMs}:{})
        },{origin,retryAfterMs:result.retryAfterMs});
    }
    return writeFault(response,requestId,result.fault,origin);
}

export function createResendMailRequestHandler(options={}){
    const configuration=normalizeConfiguration(options);
    const ownerController=new AbortController();
    const activeRequests=new Set();
    const observer=createObserver(
        configuration.onEvent,
        configuration.observerDrainTimeoutMs
    );
    const bodyScheduler=createScheduler({
        code:'mail_body_backpressure',
        concurrency:configuration.maxConcurrentBodyReads,
        maxQueued:configuration.maxQueuedBodyReads,
        queueTimeoutMs:configuration.bodyQueueTimeoutMs,
        retryAfterMs:250
    });
    const sendScheduler=createScheduler({
        code:'mail_send_backpressure',
        concurrency:configuration.maxConcurrentSends,
        maxQueued:configuration.maxQueuedSends,
        maxQueuedWeight:configuration.maxQueuedMessageBytes,
        queueTimeoutMs:configuration.sendQueueTimeoutMs,
        retryAfterMs:configuration.retryableDelayMs,
        weightCode:'mail_send_byte_backpressure'
    });
    let closePromise=null;

    function forwardOwnerAbort(){
        ownerController.abort(configuration.signal?.reason??new Error('Mail server cancelled.'));
    }
    configuration.signal?.addEventListener('abort',forwardOwnerAbort,{once:true});
    if(configuration.signal?.aborted){
        forwardOwnerAbort();
    }

    async function handleOwnedRequest(request,response){
        const requestId=createRequestId(configuration.requestIdFactory);
        const startedAt=Date.now();
        const requestController=new AbortController();
        let origin='';
        let providerAttempted=false;

        function abortFromOwner(){
            requestController.abort(ownerController.signal.reason);
        }
        function abortFromRequest(){
            requestController.abort(new Error('Mail client disconnected.'));
        }
        function abortFromResponseClose(){
            if(!response.writableEnded){
                abortFromRequest();
            }
        }
        function absorbResponseError(){
            abortFromRequest();
        }
        function releaseRequestListeners(){
            request.removeListener('aborted',abortFromRequest);
            request.removeListener('error',abortFromRequest);
        }
        function releaseResponseListeners(){
            response.removeListener('close',abortFromResponseClose);
            response.removeListener('error',absorbResponseError);
        }

        ownerController.signal.addEventListener('abort',abortFromOwner,{once:true});
        request.once('aborted',abortFromRequest);
        request.once('error',abortFromRequest);
        response.once('close',abortFromResponseClose);
        response.once('error',absorbResponseError);
        if(ownerController.signal.aborted){
            abortFromOwner();
        }
        observer.observe({
            type:'mail.request.received',
            appId:configuration.appId,
            requestId
        });

        try{
            validateLoopbackRequest(request);
            origin=allowedOrigin(request,configuration);
            if(request.url!==RESEND_MAIL_PATH){
                throw new MailGatewayFault('mail_route_not_found',{statusCode:404});
            }
            if(request.method==='OPTIONS'){
                const preflight=validatePreflight(request);
                writePreflight(response,origin,preflight);
                return;
            }
            if(request.method!=='POST'){
                throw new MailGatewayFault('mail_method_not_allowed',{statusCode:405});
            }
            if(singleHeader(request,'x-mail-app')!==configuration.appId){
                throw new MailGatewayFault('mail_app_not_allowed',{statusCode:403});
            }
            authenticateLocalCaller(request,configuration);
            const idempotencyKey=singleHeader(request,'idempotency-key');
            if(!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)){
                throw new MailGatewayFault('invalid_idempotency_key',{statusCode:400});
            }
            const contentType=singleHeader(request,'content-type');
            if(!JSON_CONTENT_TYPE_PATTERN.test(contentType)){
                throw new MailGatewayFault('mail_unsupported_content_type',{statusCode:415});
            }
            requestContentLength(request,configuration.maxRequestBytes);
            const serialized=await bodyScheduler.schedule(
                function readAdmittedMailBody(){
                    return readRequestBody(request,{
                        maxRequestBytes:configuration.maxRequestBytes,
                        signal:requestController.signal,
                        timeoutMs:configuration.bodyTimeoutMs
                    });
                },
                {signal:requestController.signal}
            );
            const delivery=parseReport(serialized,configuration);
            const result=await sendScheduler.schedule(
                function makeSingleResendAttempt(){
                    providerAttempted=true;
                    return performResendAttempt(
                        configuration,
                        delivery,
                        idempotencyKey,
                        requestController.signal,
                        requestId,
                        observer.observe
                    );
                },
                {
                    signal:requestController.signal,
                    weight:delivery.providerBodyBytes
                }
            );
            sendProviderResult(response,result,{
                origin,
                recipientCount:delivery.recipientCount,
                requestId
            });
            observer.observe({
                type:'mail.request.completed',
                appId:configuration.appId,
                classification:result.kind,
                durationMs:Math.max(0,Date.now()-startedAt),
                providerAttempted,
                requestId
            });
        }catch(error){
            const fault=normalizeFault(error);
            writeFault(response,requestId,fault,origin);
            if(!request.readableEnded&&!request.destroyed){
                request.resume();
            }
            observer.observe({
                type:'mail.request.completed',
                appId:configuration.appId,
                classification:fault.uncertain?'ambiguous':fault.retryable?'retryable':'permanent',
                durationMs:Math.max(0,Date.now()-startedAt),
                providerAttempted,
                requestId
            });
        }finally{
            ownerController.signal.removeEventListener('abort',abortFromOwner);
            if(request.readableEnded||request.destroyed){
                releaseRequestListeners();
            }else{
                request.once('end',releaseRequestListeners);
            }
            if(response.writableFinished||response.destroyed){
                releaseResponseListeners();
            }else{
                response.once('finish',releaseResponseListeners);
            }
        }
    }

    function handle(request,response){
        const operation=handleOwnedRequest(request,response);
        activeRequests.add(operation);
        operation.catch(function closeFailedRequest(){
            if(!response.destroyed){
                response.destroy();
            }
        }).finally(function releaseActiveRequest(){
            activeRequests.delete(operation);
        });
    }

    async function closeOwnedHandler(){
        configuration.signal?.removeEventListener('abort',forwardOwnerAbort);
        if(!ownerController.signal.aborted){
            ownerController.abort(new Error('Mail server closed.'));
        }
        bodyScheduler.close();
        sendScheduler.close();
        await Promise.all([
            bodyScheduler.idle(),
            sendScheduler.idle(),
            Promise.allSettled([...activeRequests])
        ]);
        await observer.drain();
    }

    function close(){
        if(!closePromise){
            closePromise=closeOwnedHandler();
        }
        return closePromise;
    }

    return Object.freeze({
        appId:configuration.appId,
        callerAuthentication:configuration.callerAuthentication,
        close,
        handle,
        path:RESEND_MAIL_PATH,
        protocol:RESEND_MAIL_SERVER_PROTOCOL
    });
}

function listen(server,{host,port}){
    return new Promise(function waitForMailListener(resolve,reject){
        function cleanup(){
            server.removeListener('error',onError);
            server.removeListener('listening',onListening);
        }
        function onError(error){
            cleanup();
            reject(error);
        }
        function onListening(){
            cleanup();
            resolve();
        }
        server.once('error',onError);
        server.once('listening',onListening);
        server.listen({exclusive:true,host,port});
    });
}

function closeHttpServer(server){
    return new Promise(function waitForHttpServerClose(resolve,reject){
        if(!server.listening){
            resolve();
            return;
        }
        server.close(function finishHttpServerClose(error){
            if(error){
                reject(error);
            }else{
                resolve();
            }
        });
        server.closeIdleConnections?.();
    });
}

export async function startResendMailServer(options={}){
    const configuration=normalizeConfiguration(options);
    if(configuration.signal?.aborted){
        throw configuration.signal.reason??new Error('Mail server start was cancelled.');
    }
    const requestHandler=createResendMailRequestHandler(options);
    const server=http.createServer({
        headersTimeout:5_000,
        keepAlive:true,
        maxHeaderSize:16_384,
        requestTimeout:configuration.bodyQueueTimeoutMs+configuration.bodyTimeoutMs+1_000
    },requestHandler.handle);
    server.keepAliveTimeout=5_000;
    server.maxConnections=configuration.maxConcurrentBodyReads
        +configuration.maxQueuedBodyReads
        +configuration.maxConcurrentSends
        +configuration.maxQueuedSends
        +16;
    server.maxHeadersCount=32;
    server.maxRequestsPerSocket=20;
    server.on('clientError',function rejectMalformedClient(error,socket){
        if(!socket.writable){
            return;
        }
        socket.end(
            'HTTP/1.1 400 Bad Request\r\n'
            +'Connection: close\r\n'
            +'Content-Length: 0\r\n'
            +'\r\n'
        );
    });

    try{
        await listen(server,{host:configuration.host,port:configuration.port});
    }catch(error){
        await requestHandler.close();
        throw error;
    }
    const address=server.address();
    if(!address||typeof address==='string'||!isNumericLoopback(address.address)){
        await Promise.allSettled([closeHttpServer(server),requestHandler.close()]);
        throw configurationError('Mail server did not bind to a numeric loopback address.');
    }
    const displayHost=address.address.includes(':')?`[${address.address}]`:address.address;
    const origin=`http://${displayHost}:${String(address.port)}`;
    let closePromise=null;
    let resolveLifecycle;
    let rejectLifecycle;
    const lifecycle=new Promise(function createMailLifecycle(resolve,reject){
        resolveLifecycle=resolve;
        rejectLifecycle=reject;
    });
    lifecycle.catch(function observeMailLifecycleFailure(){});

    async function closeOwnedServer(){
        configuration.signal?.removeEventListener('abort',closeFromSignal);
        const handlerClosing=requestHandler.close();
        try{
            await Promise.all([closeHttpServer(server),handlerClosing]);
            resolveLifecycle();
        }catch(error){
            rejectLifecycle(error);
            throw error;
        }
    }

    function close(){
        if(!closePromise){
            closePromise=closeOwnedServer();
        }
        return closePromise;
    }

    function closeFromSignal(){
        close().catch(function ignoreSignalCloseFailure(){});
    }

    function closeFromServerError(error){
        rejectLifecycle(error);
        close().catch(function observeOperationalCloseFailure(){});
    }

    server.once('close',function finishExternallyClosedServer(){
        if(!closePromise){
            closePromise=requestHandler.close().then(
                function resolveExternalClose(){resolveLifecycle();},
                function rejectExternalClose(error){rejectLifecycle(error);throw error;}
            );
            closePromise.catch(function observeExternalCloseFailure(){});
        }
    });
    server.on('error',closeFromServerError);
    configuration.signal?.addEventListener('abort',closeFromSignal,{once:true});
    if(configuration.signal?.aborted){
        closeFromSignal();
    }

    return Object.freeze({
        appId:configuration.appId,
        callerAuthentication:configuration.callerAuthentication,
        close,
        closed:lifecycle,
        host:address.address,
        lifecycle,
        mode:'mail',
        origin,
        path:RESEND_MAIL_PATH,
        port:address.port,
        protocol:RESEND_MAIL_SERVER_PROTOCOL,
        server,
        target:'mail',
        url:`${origin}${RESEND_MAIL_PATH}`
    });
}
