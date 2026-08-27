export const DEFAULT_MAIL_REQUEST_TIMEOUT_MS=590_000;
export const MAX_MAIL_RESPONSE_BYTES=65_536;

const REPORT_KEY_PATTERN=/^[a-zA-Z0-9._:-]{8,128}$/;
const REQUEST_ID_PATTERN=/^[a-zA-Z0-9-]{8,128}$/;
const PROVIDER_ID_PATTERN=/^[a-zA-Z0-9._:-]{1,256}$/;
const ERROR_CODE_PATTERN=/^[a-zA-Z0-9._:-]{1,80}$/;
const RETRYABLE_STATUS_CODES=new Set([408,425,429,500,502,503,504]);
const NON_RETRYABLE_RATE_CODES=new Set(['daily_quota_exceeded','monthly_quota_exceeded']);
const RESPONSE_CONTRACT=Object.freeze({
    accepted:202,
    delivery_uncertain:207,
    partially_accepted:207,
});

export class MailTransportError extends Error {
    constructor(message,{cause,code='MAIL_TRANSPORT_ERROR',retryable=false,
        retryAfterMs=0,statusCode=0,uncertain=false}={}){
        super(message,{cause});
        this.name='MailTransportError';
        this.code=code;
        this.retryable=Boolean(retryable);
        this.retryAfterMs=Number.isSafeInteger(retryAfterMs)&&retryAfterMs>0
            ? retryAfterMs
            : 0;
        this.statusCode=Number.isSafeInteger(statusCode)?statusCode:0;
        this.uncertain=Boolean(uncertain);
    }
}

export function normalizeMailEndpoint(endpoint,base=globalThis.location?.href){
    if(typeof endpoint!=='string'||!endpoint.trim()){
        throw new Error('Mail endpoint is required');
    }
    let url;
    try{
        url=new URL(endpoint,base);
    }catch{
        throw new Error('Mail endpoint is invalid');
    }
    const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase());
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback)){
        throw new Error('Mail endpoint must use HTTPS or loopback HTTP');
    }
    if(url.username||url.password||url.search||url.hash){
        throw new Error('Mail endpoint must not contain credentials, a query, or a fragment');
    }
    return url.href;
}

export function serializeMailReport(report){
    if(!report||typeof report!=='object'||Array.isArray(report)){
        throw new Error('Mail report must be a JSON object');
    }
    try{
        const serialized=JSON.stringify(report);
        if(!serialized){
            throw new Error();
        }
        return serialized;
    }catch{
        throw new Error('Mail report must be JSON serializable');
    }
}

function validateSerializedReport(serializedReport){
    if(typeof serializedReport!=='string'||!serializedReport){
        throw new Error('Serialized mail report is required');
    }
    let parsed;
    try{
        parsed=JSON.parse(serializedReport);
    }catch{
        throw new Error('Serialized mail report must contain valid JSON');
    }
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)){
        throw new Error('Serialized mail report must contain a JSON object');
    }
    return serializedReport;
}

function parseJsonObject(value){
    try{
        const parsed=JSON.parse(value);
        return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;
    }catch{
        return null;
    }
}

function parseRetryAfter(value,now=Date.now()){
    if(typeof value!=='string'||!value.trim()){
        return 0;
    }
    const trimmed=value.trim();
    if(/^\d+(?:\.\d+)?$/u.test(trimmed)){
        return Math.min(86_400_000,Math.max(0,Math.ceil(Number(trimmed)*1000)));
    }
    const timestamp=Date.parse(trimmed);
    return Number.isFinite(timestamp)
        ? Math.min(86_400_000,Math.max(0,timestamp-now))
        : 0;
}

function invalidSuccessResponse(response){
    return new MailTransportError('Mail server returned an invalid success response',{
        code:'MAIL_INVALID_RESPONSE',statusCode:response.status,uncertain:true,
    });
}

function parseDeliveryResponse(response,responseText){
    const body=parseJsonObject(responseText);
    if(!body
        || typeof body.requestId!=='string'||!REQUEST_ID_PATTERN.test(body.requestId)
        || !Object.hasOwn(RESPONSE_CONTRACT,body.status)
        || RESPONSE_CONTRACT[body.status]!==response.status) {
        throw invalidSuccessResponse(response);
    }
    for(const field of ['accepted','rejected']){
        if(body[field]!==undefined
            && (!Number.isSafeInteger(body[field])||body[field]<0)) {
            throw invalidSuccessResponse(response);
        }
    }
    if(body.providerId!==undefined
        && (typeof body.providerId!=='string'||!PROVIDER_ID_PATTERN.test(body.providerId))){
        throw invalidSuccessResponse(response);
    }

    return {
        requestId:body.requestId,
        sent:body.status==='accepted',
        partial:body.status==='partially_accepted',
        uncertain:body.status==='delivery_uncertain',
        status:body.status,
        statusCode:response.status,
        ...(body.providerId?{providerId:body.providerId}:{}),
        retryAfterMs:Number.isSafeInteger(body.retryAfterMs)&&body.retryAfterMs>0
            ? body.retryAfterMs
            : parseRetryAfter(response.headers?.get?.('retry-after')),
    };
}

function parseRejection(response,responseText){
    const body=parseJsonObject(responseText);
    const source=body?.error&&typeof body.error==='object'&&!Array.isArray(body.error)
        ? body.error
        : body;
    const rawCode=source?.code;
    const code=typeof rawCode==='string'&&ERROR_CODE_PATTERN.test(rawCode)
        ? rawCode
        : `MAIL_HTTP_${String(response.status)}`;
    let retryable=typeof source?.retryable==='boolean'
        ? source.retryable
        : RETRYABLE_STATUS_CODES.has(response.status);
    if(code==='invalid_idempotent_request'||NON_RETRYABLE_RATE_CODES.has(code)){
        retryable=false;
    }else if(code==='concurrent_idempotent_requests'){
        retryable=true;
    }
    const uncertain=typeof source?.uncertain==='boolean'?source.uncertain:false;
    const bodyRetryAfter=Number.isSafeInteger(source?.retryAfterMs)&&source.retryAfterMs>0
        ? source.retryAfterMs
        : 0;
    return new MailTransportError(`Mail server rejected the request (${response.status})`,{
        code,
        retryable,
        retryAfterMs:bodyRetryAfter||parseRetryAfter(response.headers?.get?.('retry-after')),
        statusCode:response.status,
        uncertain,
    });
}

async function readBoundedResponseText(response){
    const declaredLength=response.headers?.get?.('content-length');
    if(declaredLength!==null&&declaredLength!==undefined&&declaredLength!==''){
        const parsedLength=Number(declaredLength);
        if(!Number.isSafeInteger(parsedLength)||parsedLength<0||parsedLength>MAX_MAIL_RESPONSE_BYTES){
            throw new MailTransportError(
                `Mail server response cannot exceed ${MAX_MAIL_RESPONSE_BYTES.toLocaleString('en-US')} bytes`,
                {code:'MAIL_RESPONSE_TOO_LARGE',statusCode:response.status,uncertain:true}
            );
        }
    }

    if(!response.body||typeof response.body.getReader!=='function'){
        if(typeof response.text!=='function'){
            throw new MailTransportError('Mail server returned an unreadable response',{
                code:'MAIL_UNREADABLE_RESPONSE',statusCode:response.status,uncertain:true,
            });
        }
        const text=await response.text();
        if(new TextEncoder().encode(text).byteLength>MAX_MAIL_RESPONSE_BYTES){
            throw new MailTransportError(
                `Mail server response cannot exceed ${MAX_MAIL_RESPONSE_BYTES.toLocaleString('en-US')} bytes`,
                {code:'MAIL_RESPONSE_TOO_LARGE',statusCode:response.status,uncertain:true}
            );
        }
        return text;
    }

    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let byteLength=0;
    let text='';
    try{
        while(true){
            const { done,value }=await reader.read();
            if(done) break;
            if(!(value instanceof Uint8Array)){
                throw new MailTransportError('Mail server returned an unreadable response',{
                    code:'MAIL_UNREADABLE_RESPONSE',statusCode:response.status,uncertain:true,
                });
            }
            byteLength+=value.byteLength;
            if(byteLength>MAX_MAIL_RESPONSE_BYTES){
                await reader.cancel().catch(function ignoreReaderCancellation(){});
                throw new MailTransportError(
                    `Mail server response cannot exceed ${MAX_MAIL_RESPONSE_BYTES.toLocaleString('en-US')} bytes`,
                    {code:'MAIL_RESPONSE_TOO_LARGE',statusCode:response.status,uncertain:true}
                );
            }
            text+=decoder.decode(value,{stream:true});
        }
        text+=decoder.decode();
        return text;
    }finally{
        reader.releaseLock();
    }
}

function requestBodyFrom({report,serializedReport}){
    if(serializedReport===undefined){
        return serializeMailReport(report);
    }
    const validated=validateSerializedReport(serializedReport);
    if(report!==undefined&&serializeMailReport(report)!==validated){
        throw new Error('Mail report does not match its immutable serialized request body');
    }
    return validated;
}

export async function sendMailReport({
    appKey,
    appName,
    endpoint,
    fetchImpl=globalThis.fetch,
    report,
    reportKey,
    requestTimeout=DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
    serializedReport,
    signal,
}){
    if(typeof fetchImpl!=='function'){
        throw new MailTransportError('Mail transport is unavailable',{code:'MAIL_UNAVAILABLE'});
    }
    const resolvedEndpoint=normalizeMailEndpoint(endpoint);
    if(typeof appName!=='string'||!/^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(appName)){
        throw new Error('Mail application identity is invalid');
    }
    if(typeof reportKey!=='string'||!REPORT_KEY_PATTERN.test(reportKey)){
        throw new Error('Mail report key must contain 8-128 safe characters');
    }
    if(!Number.isSafeInteger(requestTimeout)||requestTimeout<1_000||requestTimeout>600_000){
        throw new Error('Mail request timeout must be an integer between 1000 and 600000 milliseconds');
    }
    if(appKey!==undefined&&appKey!==null&&typeof appKey!=='string'){
        throw new Error('Mail application key must be a string');
    }
    if(signal!==undefined&&!(signal instanceof AbortSignal)){
        throw new TypeError('Mail signal must be an AbortSignal');
    }
    const requestBody=requestBodyFrom({report,serializedReport});

    const headers={
        'Content-Type':'application/json',
        'Idempotency-Key':reportKey,
        'X-Mail-App':appName,
    };
    if(typeof appKey==='string'&&appKey){
        headers['X-Mail-Key']=appKey;
    }

    const controller=new AbortController();
    let timedOut=false;
    const forwardAbort=function forwardMailAbort(){
        controller.abort(signal.reason??new Error('Mail request was cancelled'));
    };
    signal?.addEventListener('abort',forwardAbort,{once:true});
    if(signal?.aborted){
        forwardAbort();
    }
    const timeout=setTimeout(
        function abortTimedOutMail(){
            timedOut=true;
            controller.abort(new Error('Mail request timed out'));
        },
        requestTimeout
    );

    try{
        let response;
        try{
            response=await fetchImpl(
                resolvedEndpoint,
                {
                    method:'POST',
                    headers,
                    body:requestBody,
                    credentials:'same-origin',
                    redirect:'error',
                    referrerPolicy:'no-referrer',
                    signal:controller.signal,
                }
            );
        }catch(error){
            const cancelled=signal?.aborted&&!timedOut;
            throw new MailTransportError(
                cancelled?'Mail request was cancelled':timedOut?'Mail request timed out':'Mail server could not be reached',
                {
                    cause:error,
                    code:cancelled?'MAIL_CANCELLED':timedOut?'MAIL_TIMEOUT':'MAIL_NETWORK_ERROR',
                    retryable:true,
                    uncertain:true,
                }
            );
        }

        const responseText=await readBoundedResponseText(response);
        if(!response.ok){
            throw parseRejection(response,responseText);
        }
        return parseDeliveryResponse(response,responseText);
    }finally{
        clearTimeout(timeout);
        signal?.removeEventListener('abort',forwardAbort);
    }
}
