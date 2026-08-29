import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import http from 'node:http';

export const RESEND_MAIL_SERVER_PROTOCOL='arcane-resend-mail-gateway/1';
export const RESEND_MAIL_PATH='/v1/mail';

const RESEND_EMAIL_ENDPOINT='https://api.resend.com/emails';
const APP_ID_PATTERN=/^[a-z0-9](?:[a-z0-9-]{0,62})$/u;
const EMAIL_PATTERN=/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;
const IDEMPOTENCY_KEY_PATTERN=/^[a-zA-Z0-9._:-]+$/u;
const PROVIDER_ID_PATTERN=/^[a-zA-Z0-9._:-]+$/u;
const PROVIDER_CODE_PATTERN=/^[a-z0-9_]+$/u;
const REQUEST_ID_PATTERN=/^[a-zA-Z0-9-]+$/u;
const JSON_CONTENT_TYPE_PATTERN=/^application\/json(?:\s*;\s*charset\s*=\s*"?utf-8"?)?$/iu;
const HEADER_NAME_PATTERN=/^[!#$%&'*+.^_`|~0-9a-z-]+$/iu;
const MAIL_TYPES=new Set(['error','report','crisis_detected']);
const PREFLIGHT_HEADERS=new Set([
    'content-type','idempotency-key','x-mail-app','x-mail-key'
]);
const PERMANENT_RATE_CODES=new Set(['daily_quota_exceeded','monthly_quota_exceeded']);
const RETRYABLE_PROVIDER_STATUSES=new Set([408,425,429,500,502,503,504]);

class MailGatewayFault extends Error {
    constructor(code,{details=null,retryable=false,retryAfterMs=0,statusCode=400,uncertain=false}={}){
        super(code);
        this.name='MailGatewayFault';
        this.code=code;
        this.details=details;
        this.retryable=Boolean(retryable);
        this.retryAfterMs=normalizeRetryAfter(retryAfterMs);
        this.statusCode=statusCode;
        this.uncertain=Boolean(uncertain);
    }
}

function configurationError(message){
    const error=new Error(message);
    error.code='ARCANE_MAIL_CONFIG_INVALID';
    return error;
}

function completeErrorDetails(error){
    if(!error||typeof error!=='object'){
        return {message:String(error??''),name:'Error'};
    }
    return {
        ...error,
        ...(typeof error.code==='string'?{code:error.code}:{}),
        message:typeof error.message==='string'?error.message:String(error),
        name:typeof error.name==='string'?error.name:'Error',
        ...(typeof error.stack==='string'?{stack:error.stack}:{})
    };
}

function positiveInteger(value,fallback,{label,allowZero=false}={}){
    const resolved=value===undefined?fallback:value;
    const minimum=allowZero?0:1;
    if(!Number.isSafeInteger(resolved)||resolved<minimum){
        throw configurationError(`${label} must be ${allowZero?'a nonnegative':'a positive'} integer.`);
    }
    return resolved;
}

function optionalPositiveInteger(value,label){
    if(value===undefined||value===null) return null;
    return positiveInteger(value,null,{label});
}

function normalizeRetryAfter(value){
    return Number.isSafeInteger(value)&&value>0?value:0;
}

function portNumber(value,fallback){
    const resolved=value===undefined?fallback:value;
    if(!Number.isSafeInteger(resolved)||resolved<0||resolved>65_535){
        throw configurationError('port must be an integer between 0 and 65535.');
    }
    return resolved;
}

function validateSignal(signal){
    if(signal!==undefined&&!(signal instanceof AbortSignal)){
        throw new TypeError('Mail server signal must be an AbortSignal.');
    }
    return signal;
}

function validateApiKey(value){
    if(typeof value!=='string'||value.length<1||!/^[\x21-\x7e]+$/u.test(value)){
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
        return {
            appKeyDigest:null,
            callerAuthentication:'origin-app-id-only'
        };
    }
    if(typeof options.appKey!=='string'||!/^[\x21-\x7e]+$/u.test(options.appKey)){
        throw configurationError(
            'appKey must be a nonempty printable ASCII string unless unauthenticated caller mode is explicitly enabled.'
        );
    }
    return {
        appKeyDigest:appKeyDigest(options.appKey),
        callerAuthentication:'app-key'
    };
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
    if(!Array.isArray(value)||(!allowEmpty&&value.length===0)){
        throw configurationError(`${label} must contain ${allowEmpty?'zero or more':'one or more'} addresses.`);
    }
    const result=[];
    for(const entry of value){
        const address=normalizedEmail(entry,label);
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
    if(!Array.isArray(value)||value.length===0){
        throw configurationError('allowedOrigins must contain one or more exact origins.');
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
        options.recipientAllowlist??[],
        'recipientAllowlist',
        {allowEmpty:true}
    );
    const errorRecipients=normalizeEmailList(
        options.errorRecipients??[],
        'errorRecipients',
        {allowEmpty:true}
    );
    const allowedRecipients=new Set(recipientAllowlist);
    if(recipientAllowlist.length>0&&errorRecipients.some(function errorRecipientIsNotAllowed(address){
        return !allowedRecipients.has(address);
    })){
        throw configurationError('Every error recipient must also be in recipientAllowlist.');
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
    return {
        allowAnyRecipient:recipientAllowlist.length===0,
        allowedOrigins:normalizeOrigins(options.allowedOrigins),
        allowedRecipients,
        apiKey:validateApiKey(options.apiKey),
        appKeyDigest:callerAuthentication.appKeyDigest,
        appId:validateAppId(options.appId),
        bodyTimeoutMs:optionalPositiveInteger(options.bodyTimeoutMs,'bodyTimeoutMs'),
        errorRecipients,
        fetchImpl,
        from:validateFrom(options.from),
        host:validateLoopbackHost(options.host??'127.0.0.1'),
        callerAuthentication:callerAuthentication.callerAuthentication,
        onEvent:options.onEvent,
        port:portNumber(options.port,8025),
        providerTimeoutMs:optionalPositiveInteger(options.providerTimeoutMs,'providerTimeoutMs'),
        requestIdFactory:options.requestIdFactory??randomUUID,
        retryableDelayMs:positiveInteger(
            options.retryableDelayMs,
            1_000,
            {label:'retryableDelayMs'}
        ),
        signal:validateSignal(options.signal)
    };
}

function createRequestId(factory){
    try{
        const candidate=factory();
        if(typeof candidate==='string'&&REQUEST_ID_PATTERN.test(candidate)){
            return candidate;
        }
    }catch{
        // A diagnostic identifier must never prevent an error response.
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
    const candidateIsValid=/^[\x21-\x7e]+$/u.test(candidate);
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
    return corsHeaders(origin);
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
    const delay=normalizeRetryAfter(retryAfterMs);
    if(delay){
        headers['retry-after']=String(Math.max(1,Math.ceil(delay/1000)));
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
    const retryAfterMs=normalizeRetryAfter(fault.retryAfterMs);
    return writeJson(response,fault.statusCode,{
        requestId,
        error:{
            code:PROVIDER_CODE_PATTERN.test(fault.code)?fault.code:'mail_gateway_error',
            message:fault.message,
            details:fault.details,
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
    return new MailGatewayFault('mail_gateway_error',{
        details:completeErrorDetails(error),
        statusCode:500
    });
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

function createObserver(onEvent){
    const pending=new Set();
    function observe(event){
        if(!onEvent){
            return;
        }
        let result;
        try{
            result=onEvent({...event});
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
        await Promise.allSettled([...pending]);
    }
    return {drain,observe};
}

function readRequestBody(request,{timeoutMs,signal}){
    return new Promise(function collectRequestBody(resolve,reject){
        const chunks=[];
        let settled=false;
        const timer=timeoutMs==null
            ?null
            :setTimeout(function expireRequestBody(){
                finish(new MailGatewayFault('mail_body_timeout',{
                    retryable:true,
                    statusCode:408
                }));
                request.resume();
            },timeoutMs);

        function cleanup(){
            if(timer!==null) clearTimeout(timer);
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
            chunks.push(bytes);
        }

        function onEnd(){
            finish(null,Buffer.concat(chunks).toString('utf8'));
        }

        function onError(error){
            finish(new MailGatewayFault('mail_request_stream_failed',{
                details:completeErrorDetails(error),
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
    if(!Array.isArray(report.to)){
        throw new MailGatewayFault('mail_invalid_recipients',{statusCode:422});
    }
    const recipients=[];
    for(const value of report.to){
        const address=normalizedReportEmail(value);
        if(!configuration.allowAnyRecipient&&!configuration.allowedRecipients.has(address)){
            throw new MailGatewayFault('mail_recipient_not_allowed',{statusCode:403});
        }
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
    if(!Object.hasOwn(value,'subject')||!Object.hasOwn(value,'to')
        ||!Object.hasOwn(value,'type')){
        throw new MailGatewayFault('mail_invalid_report_shape',{statusCode:422});
    }
    if(typeof value.type!=='string'||!MAIL_TYPES.has(value.type)){
        throw new MailGatewayFault('mail_invalid_type',{statusCode:422});
    }
    if(typeof value.subject!=='string'){
        throw new MailGatewayFault('mail_invalid_subject',{statusCode:422});
    }
    const hasText=Object.hasOwn(value,'text');
    const hasHtml=Object.hasOwn(value,'html');
    if(!hasText&&!hasHtml||(hasText&&typeof value.text!=='string')
        ||(hasHtml&&typeof value.html!=='string')){
        throw new MailGatewayFault('mail_content_required',{statusCode:422});
    }
    const recipients=normalizeReportRecipients(value,configuration);
    const providerFields={...value};
    delete providerFields.type;
    const providerBody={
        ...providerFields,
        from:configuration.from,
        to:recipients,
        subject:value.subject,
        ...(hasText?{text:value.text}:{}),
        ...(hasHtml?{html:value.html}:{})
    };
    const serializedProviderBody=JSON.stringify(providerBody);
    return {
        report:{...value},
        providerBody:serializedProviderBody,
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
        return normalizeRetryAfter(Math.ceil(Number(trimmed)*1000));
    }
    const timestamp=Date.parse(trimmed);
    return Number.isFinite(timestamp)
        ? normalizeRetryAfter(Math.max(0,timestamp-now))
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

async function readProviderBody(response,signal){
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
    const decoder=new TextDecoder();
    let text='';
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
            text+=decoder.decode(result.value,{stream:true});
        }
        return text+decoder.decode();
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
        ? normalizeRetryAfter(retryAfterMs||defaultRetryAfterMs)
        : 0;
    return {
        kind:'rejected',
        fault:new MailGatewayFault(code,{
            details:value,
            retryable,
            retryAfterMs:resolvedDelay,
            statusCode:retryable?(statusCode===429?429:503):422
        }),
        providerStatus:statusCode
    };
}

function ambiguousResult(code,retryAfterMs,providerStatus=0,details=null){
    return {
        code,
        details,
        kind:'ambiguous',
        providerStatus,
        retryAfterMs:normalizeRetryAfter(retryAfterMs)
    };
}

async function performResendAttempt(configuration,delivery,idempotencyKey,signal,requestId,observe){
    const controller=new AbortController();
    let outcome=null;
    let timedOut=false;
    function completeAttempt(result){
        outcome=result;
        return result;
    }
    function forwardAbort(){
        controller.abort(signal?.reason??new Error('Mail request cancelled.'));
    }
    signal?.addEventListener('abort',forwardAbort,{once:true});
    if(signal?.aborted){
        forwardAbort();
    }
    const timeout=configuration.providerTimeoutMs==null
        ?null
        :setTimeout(function expireResendAttempt(){
            timedOut=true;
            controller.abort(new Error('Resend request timed out.'));
        },configuration.providerTimeoutMs);
    const startedAt=Date.now();
    observe({
        type:'mail.provider.started',
        appId:configuration.appId,
        idempotencyKey,
        providerRequest:JSON.parse(delivery.providerBody),
        report:delivery.report,
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
        }catch(error){
            return completeAttempt(ambiguousResult(
                timedOut?'resend_timeout':'resend_transport_uncertain',
                configuration.retryableDelayMs,
                0,
                completeErrorDetails(error)
            ));
        }
        const statusCode=Number(response?.status);
        if(!Number.isSafeInteger(statusCode)||statusCode<100||statusCode>599){
            return completeAttempt(ambiguousResult(
                'resend_invalid_response',
                configuration.retryableDelayMs,
                0,
                {status:response?.status??null}
            ));
        }
        let text='';
        try{
            text=await readProviderBody(response,controller.signal);
        }catch(error){
            if(statusCode>=200&&statusCode<300||controller.signal.aborted){
                return completeAttempt(ambiguousResult(
                    error instanceof MailGatewayFault?error.code:'resend_transport_uncertain',
                    configuration.retryableDelayMs,
                    statusCode,
                    completeErrorDetails(error)
                ));
            }
            return completeAttempt(providerRejection(
                statusCode,
                null,
                parseRetryAfter(responseHeader(response,'retry-after')),
                configuration.retryableDelayMs
            ));
        }
        const value=parseProviderObject(text);
        if(statusCode>=200&&statusCode<300){
            if(!value||typeof value.id!=='string'||!PROVIDER_ID_PATTERN.test(value.id)){
                return completeAttempt(ambiguousResult(
                    'resend_invalid_success_response',
                    configuration.retryableDelayMs,
                    statusCode,
                    value??text
                ));
            }
            return completeAttempt({
                kind:'accepted',
                providerId:value.id,
                providerResponse:value,
                providerStatus:statusCode
            });
        }
        return completeAttempt(providerRejection(
            statusCode,
            value,
            parseRetryAfter(responseHeader(response,'retry-after')),
            configuration.retryableDelayMs
        ));
    }finally{
        if(timeout!==null) clearTimeout(timeout);
        signal?.removeEventListener('abort',forwardAbort);
        observe({
            type:'mail.provider.completed',
            appId:configuration.appId,
            idempotencyKey,
            outcome,
            providerRequest:JSON.parse(delivery.providerBody),
            report:delivery.report,
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
        throw configurationError('reportKey must contain safe identifier characters.');
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
    return {
        allowAnyRecipient:true,
        allowedRecipients:null,
        apiKey:validateApiKey(options.apiKey),
        appId:validateAppId(options.appId),
        errorRecipients:[],
        fetchImpl,
        from:validateFrom(options.from),
        providerTimeoutMs:optionalPositiveInteger(options.providerTimeoutMs,'providerTimeoutMs'),
        requestIdFactory:options.requestIdFactory??randomUUID,
        retryableDelayMs:positiveInteger(
            options.retryableDelayMs,
            1_000,
            {label:'retryableDelayMs'}
        ),
        signal:validateSignal(options.signal),
        report:options.report,
        reportKey:options.reportKey,
        onEvent:options.onEvent
    };
}

function directSendResult(result,{delivery,requestId}){
    const common={
        ...result,
        provider:'resend',
        status:result.kind==='accepted'
            ?'accepted'
            :result.kind==='ambiguous'?'delivery_uncertain':'rejected',
        classification:result.kind==='rejected'
            ?result.fault.retryable?'retryable':'permanent'
            :result.kind,
        requestId,
        providerStatus:result.providerStatus,
        providerRequest:JSON.parse(delivery.providerBody),
        report:delivery.report,
        recipientCount:delivery.recipientCount
    };
    if(result.kind==='accepted'){
        return {...common,providerId:result.providerId};
    }
    if(result.kind==='ambiguous'){
        return {
            ...common,
            code:result.code,
            details:result.details,
            ...(result.retryAfterMs?{retryAfterMs:result.retryAfterMs}:{}),
            retryable:true,
            uncertain:true
        };
    }
    return {
        ...common,
        code:result.fault.code,
        details:result.fault.details,
        message:result.fault.message,
        ...(result.fault.retryAfterMs?{retryAfterMs:result.fault.retryAfterMs}:{}),
        retryable:result.fault.retryable,
        uncertain:false
    };
}

export async function sendResendMail(options={}){
    const configuration=normalizeDirectSendOptions(options);
    const delivery=normalizeReport(configuration.report,configuration);
    if(configuration.signal?.aborted){
        const error=new Error('Mail send cancelled before provider attempt.',{
            cause:configuration.signal.reason
        });
        error.code='ARCANE_CANCELLED';
        throw error;
    }
    const requestId=createRequestId(configuration.requestIdFactory);
    const observer=createObserver(configuration.onEvent);
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
            delivery,
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
            providerId:result.providerId,
            providerResponse:result.providerResponse
        },{origin});
    }
    if(result.kind==='ambiguous'){
        return writeJson(response,207,{
            requestId,
            status:'delivery_uncertain',
            accepted:0,
            rejected:0,
            details:result.details,
            ...(result.retryAfterMs?{retryAfterMs:result.retryAfterMs}:{})
        },{origin,retryAfterMs:result.retryAfterMs});
    }
    return writeFault(response,requestId,result.fault,origin);
}

export function createResendMailRequestHandler(options={}){
    const configuration=normalizeConfiguration(options);
    const ownerController=new AbortController();
    const activeRequests=new Set();
    const observer=createObserver(configuration.onEvent);
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
        let delivery=null;
        let idempotencyKey=null;
        let origin='';
        let providerAttempted=false;
        let result=null;
        let serialized=null;

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
            idempotencyKey=singleHeader(request,'idempotency-key');
            if(!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)){
                throw new MailGatewayFault('invalid_idempotency_key',{statusCode:400});
            }
            const contentType=singleHeader(request,'content-type');
            if(!JSON_CONTENT_TYPE_PATTERN.test(contentType)){
                throw new MailGatewayFault('mail_unsupported_content_type',{statusCode:415});
            }
            serialized=await readRequestBody(request,{
                signal:requestController.signal,
                timeoutMs:configuration.bodyTimeoutMs
            });
            delivery=parseReport(serialized,configuration);
            providerAttempted=true;
            result=await performResendAttempt(
                configuration,
                delivery,
                idempotencyKey,
                requestController.signal,
                requestId,
                observer.observe
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
                delivery,
                durationMs:Math.max(0,Date.now()-startedAt),
                idempotencyKey,
                providerAttempted,
                result,
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
                delivery,
                durationMs:Math.max(0,Date.now()-startedAt),
                fault:{
                    code:fault.code,
                    details:fault.details,
                    message:fault.message,
                    retryAfterMs:fault.retryAfterMs,
                    retryable:fault.retryable,
                    statusCode:fault.statusCode,
                    uncertain:fault.uncertain
                },
                idempotencyKey,
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
        await Promise.allSettled([...activeRequests]);
        await observer.drain();
    }

    function close(){
        if(!closePromise){
            closePromise=closeOwnedHandler();
        }
        return closePromise;
    }

    return {
        appId:configuration.appId,
        callerAuthentication:configuration.callerAuthentication,
        close,
        handle,
        path:RESEND_MAIL_PATH,
        protocol:RESEND_MAIL_SERVER_PROTOCOL
    };
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
    const server=http.createServer(requestHandler.handle);
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

    return {
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
    };
}
