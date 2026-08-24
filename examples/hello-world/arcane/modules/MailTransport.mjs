export const DEFAULT_MAIL_REQUEST_TIMEOUT_MS=590_000;
export const MAX_MAIL_RESPONSE_BYTES=65_536;

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

const REPORT_KEY_PATTERN=/^[a-zA-Z0-9._:-]{8,128}$/;
const REQUEST_ID_PATTERN=/^[a-zA-Z0-9-]{8,128}$/;
const RESPONSE_CONTRACT=Object.freeze({
    accepted:202,
    delivery_uncertain:207,
    partially_accepted:207,
});

function serializeReport(report){
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

function parseDeliveryResponse(response,responseText){
    let body;
    try{
        body=JSON.parse(responseText);
    }catch{
        throw new Error('Mail server returned an invalid success response');
    }
    if(!body||typeof body!=='object'||Array.isArray(body)
        || typeof body.requestId!=='string'||!REQUEST_ID_PATTERN.test(body.requestId)
        || !Object.hasOwn(RESPONSE_CONTRACT,body.status)
        || RESPONSE_CONTRACT[body.status]!==response.status) {
        throw new Error('Mail server returned an invalid success response');
    }
    for(const field of ['accepted','rejected']){
        if(body[field]!==undefined
            && (!Number.isSafeInteger(body[field])||body[field]<0)) {
            throw new Error('Mail server returned an invalid success response');
        }
    }

    return {
        requestId:body.requestId,
        sent:body.status==='accepted',
        partial:body.status==='partially_accepted',
        uncertain:body.status==='delivery_uncertain',
        status:body.status,
        statusCode:response.status,
    };
}

async function readBoundedResponseText(response){
    const declaredLength=response.headers?.get?.('content-length');
    if(declaredLength!==null&&declaredLength!==undefined&&declaredLength!==''){
        const parsedLength=Number(declaredLength);
        if(!Number.isSafeInteger(parsedLength)||parsedLength<0||parsedLength>MAX_MAIL_RESPONSE_BYTES){
            throw new Error(`Mail server response cannot exceed ${MAX_MAIL_RESPONSE_BYTES.toLocaleString('en-US')} bytes`);
        }
    }

    if(!response.body||typeof response.body.getReader!=='function'){
        throw new Error('Mail server returned an unreadable success response');
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
                throw new Error('Mail server returned an unreadable success response');
            }
            byteLength+=value.byteLength;
            if(byteLength>MAX_MAIL_RESPONSE_BYTES){
                await reader.cancel().catch(() => {});
                throw new Error(`Mail server response cannot exceed ${MAX_MAIL_RESPONSE_BYTES.toLocaleString('en-US')} bytes`);
            }
            text+=decoder.decode(value,{stream:true});
        }
        text+=decoder.decode();
        return text;
    }finally{
        reader.releaseLock();
    }
}

export async function sendMailReport({
    appKey,
    appName,
    endpoint,
    fetchImpl=globalThis.fetch,
    report,
    reportKey,
    requestTimeout=DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
}){
    if(typeof fetchImpl!=='function'){
        throw new Error('Mail transport is unavailable');
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
    const requestBody=serializeReport(report);

    const headers={
        'Content-Type':'application/json',
        'Idempotency-Key':reportKey,
        'X-Mail-App':appName,
    };
    if(typeof appKey==='string'&&appKey){
        headers['X-Mail-Key']=appKey;
    }

    const controller=new AbortController();
    const timeout=setTimeout(
        () => controller.abort(new Error('Mail request timed out')),
        requestTimeout
    );

    try{
        const response=await fetchImpl(
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

        if(!response.ok){
            throw new Error(`Mail server rejected the request (${response.status})`);
        }

        const responseText=await readBoundedResponseText(response);
        return parseDeliveryResponse(response,responseText);
    }finally{
        clearTimeout(timeout);
    }
}
