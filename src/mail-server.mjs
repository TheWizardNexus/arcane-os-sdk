import Is from 'strong-type';
import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {Server} from 'node-http-server';

const is = new Is(false);

export const RESEND_MAIL_SERVER_PROTOCOL='arcane-resend-mail-gateway/1';
export const RESEND_MAIL_PATH='/v1/mail';

const RESEND_EMAIL_ENDPOINT='https://api.resend.com/emails';
const REQUEST_ID_PATTERN=/^[a-zA-Z0-9-]+$/u;
const PERMANENT_RATE_CODES=new Set(['daily_quota_exceeded','monthly_quota_exceeded']);
const RETRYABLE_PROVIDER_STATUSES=new Set([408,425,429,500,502,503,504]);
const MAX_NODE_TIMER_DELAY_MS=2_147_483_647;

class MailGatewayFault extends Error {
    constructor(code,{details=null,retryable=false,retryAfterMs=0,statusCode=400,uncertain=false}={}){
        super(code);
        this.name='MailGatewayFault';
        this.code=code;
        this.details=details;
        this.retryable=Boolean(retryable);
        this.retryAfterMs=retryDelayOrZero(retryAfterMs);
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
    if(!error||!is.object(error)){
        return {message:String(error??''),name:'Error'};
    }
    return {
        ...error,
        ...(is.string(error.code)?{code:error.code}:{}),
        message:is.string(error.message)?error.message:String(error),
        name:is.string(error.name)?error.name:'Error',
        ...(is.string(error.stack)?{stack:error.stack}:{}),
        ...(error.cause===undefined?{}:{
            cause:error.cause instanceof Error?completeErrorDetails(error.cause):error.cause
        }),
        ...(error instanceof AggregateError?{errors:error.errors.map(completeErrorDetails)}:{})
    };
}

function reportMailError(message,error){
    console.error(message,inspect(error,{
        depth:null,
        maxArrayLength:null,
        maxStringLength:null
    }));
}

function readRetryDelayMs(retryDelayMs=1_000){
    if(!is.safeInteger(retryDelayMs)||retryDelayMs<1){
        throw configurationError('retryableDelayMs must be a positive integer.');
    }
    return retryDelayMs;
}

function optionalTimeoutMs(value,label){
    if(value===undefined||value===null) return null;
    if(!is.safeInteger(value)||value<1||value>MAX_NODE_TIMER_DELAY_MS){
        throw configurationError(
            `${label} must be an integer from 1 through ${MAX_NODE_TIMER_DELAY_MS} `
            +'milliseconds, the Node timer range.'
        );
    }
    return value;
}

function retryDelayOrZero(value){
    return is.safeInteger(value)&&value>0?value:0;
}

function resolveMailServerConfiguration(options={}){
    if(!options||!is.object(options)||is.array(options)){
        throw configurationError('Mail server options must be an object.');
    }
    const recipientAllowlist=options.recipientAllowlist??[];
    const errorRecipients=options.errorRecipients??[];
    const allowedRecipients=new Set(recipientAllowlist);
    const fetchImpl=options.fetchImpl??globalThis.fetch;
    if(!is.function(fetchImpl)){
        throw configurationError('A fetch implementation is required for Resend delivery.');
    }
    if(options.onEvent!==undefined&&!is.function(options.onEvent)){
        throw configurationError('onEvent must be a function when supplied.');
    }
    if(options.requestIdFactory!==undefined&&!is.function(options.requestIdFactory)){
        throw configurationError('requestIdFactory must be a function when supplied.');
    }
    if(options.verifySubscription!==undefined&&!is.function(options.verifySubscription)){
        throw configurationError('verifySubscription must be a function when supplied.');
    }
    return {
        allowAnyRecipient:recipientAllowlist.length===0,
        allowedOrigins:new Set(options.allowedOrigins??[]),
        allowedRecipients,
        apiKey:options.apiKey,
        appId:options.appId,
        bodyTimeoutMs:optionalTimeoutMs(options.bodyTimeoutMs,'bodyTimeoutMs'),
        errorRecipients,
        fetchImpl,
        from:options.from,
        host:options.host??'0.0.0.0',
        callerAuthentication:options.verifySubscription?'subscription':'none',
        onEvent:options.onEvent,
        port:options.port??8025,
        providerTimeoutMs:optionalTimeoutMs(options.providerTimeoutMs,'providerTimeoutMs'),
        requestIdFactory:options.requestIdFactory??randomUUID,
        retryableDelayMs:readRetryDelayMs(options.retryableDelayMs),
        signal:options.signal,
        verifySubscription:options.verifySubscription
    };
}

function createRequestId(factory){
    try{
        const candidate=factory();
        if(is.string(candidate)&&REQUEST_ID_PATTERN.test(candidate)){
            return candidate;
        }
    }catch{
        // A diagnostic identifier must never prevent an error response.
    }
    return randomUUID();
}

function readRequestHeader(request, headerName) {
    const distinctHeaders = request.headersDistinct;
    if (distinctHeaders) {
        const headerValues = distinctHeaders[headerName] ?? [];
        return headerValues.length === 1 ? headerValues[0] : undefined;
    }
    // HTTP/2 owns header normalization and does not expose headersDistinct.
    return request.headers[headerName];
}

function requireRequestHeader(request, headerName) {
    const headerValue = readRequestHeader(request, headerName);
    if (!headerValue) {
        throw new MailGatewayFault(
            'mail_invalid_headers',
            {statusCode: 400}
        );
    }
    return headerValue;
}

async function verifyMailSubscription(request,configuration,signal){
    const appName=requireRequestHeader(request,'x-mail-app');
    const authorization = readRequestHeader(request, 'authorization');
    const subscriptionKey = authorization
        ? /^Bearer (.+)$/iu.exec(authorization)?.[1]
        : undefined;
    if(!subscriptionKey){
        throw new MailGatewayFault('mail_subscription_required',{statusCode:401});
    }
    let verified;
    try{
        signal.throwIfAborted();
        verified=await waitForResultOrAbort(configuration.verifySubscription({
            appName,
            subscriptionKey,
            signal
        }),signal);
    }catch(error){
        if(signal.aborted){
            throw new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            });
        }
        throw new MailGatewayFault('mail_subscription_verification_failed',{
            details:completeErrorDetails(error),
            retryable:true,
            retryAfterMs:configuration.retryableDelayMs,
            statusCode:503
        });
    }
    if(verified!==true){
        throw new MailGatewayFault('mail_subscription_invalid',{statusCode:401});
    }
    return appName;
}

function createCorsResponseHeaders(origin){
    if(!origin){
        return {};
    }
    return {
        'access-control-allow-headers':'Content-Type, Idempotency-Key, X-Mail-App, Authorization',
        'access-control-allow-methods':'POST, OPTIONS',
        'access-control-allow-origin':origin,
        'access-control-expose-headers':'Retry-After',
        'access-control-max-age':'600',
        'vary':'Origin'
    };
}

function sendJsonResponse(response,statusCode,value,{origin='',retryAfterMs=0}={}){
    if(response.destroyed||response.writableEnded){
        return false;
    }
    const body=JSON.stringify(value);
    const headers={
        ...createCorsResponseHeaders(origin),
        'content-type':'application/json; charset=utf-8'
    };
    if(statusCode===401)headers['www-authenticate']='Bearer';
    if(retryAfterMs){
        headers['retry-after']=String(Math.ceil(retryAfterMs/1000));
    }
    response.writeHead(statusCode,headers);
    response.end(body);
    return true;
}

function sendCorsPreflightResponse(response,origin){
    if(response.destroyed||response.writableEnded){
        return false;
    }
    response.writeHead(204,createCorsResponseHeaders(origin));
    response.end();
    return true;
}

function sendMailFailureResponse(response,requestId,fault,origin=''){
    const retryAfterMs=fault.retryAfterMs;
    return sendJsonResponse(response,fault.statusCode,{
        requestId,
        error:{
            code:fault.code,
            message:fault.message,
            details:fault.details,
            retryable:Boolean(fault.retryable),
            uncertain:Boolean(fault.uncertain),
            ...(retryAfterMs?{retryAfterMs}:{})
        }
    },{origin,retryAfterMs});
}

function mailFaultFromError(error){
    if(error instanceof MailGatewayFault){
        return error;
    }
    return new MailGatewayFault('mail_gateway_error',{
        details:completeErrorDetails(error),
        statusCode:500
    });
}

function createMailEventObserver(onEvent){
    const pendingObserverTasks=new Set();
    function reportObserverFailure(error){
        reportMailError('Mail event observer failed.',error);
    }
    function observe(event){
        let observerResult;
        try{
            observerResult=onEvent(event);
        }catch(error){
            reportObserverFailure(error);
            return;
        }
        if(!observerResult||!is.function(observerResult.then)){
            return;
        }
        const observerTask=Promise.resolve(observerResult);
        pendingObserverTasks.add(observerTask);
        observerTask.catch(reportObserverFailure)
            .finally(function releaseObserverTask(){pendingObserverTasks.delete(observerTask);});
    }
    async function drainObserverTasks(){
        await Promise.allSettled([...pendingObserverTasks]);
    }
    return {drain:drainObserverTasks,observe};
}

function readRequestBodyText(request,{timeoutMs,signal}){
    return new Promise(function collectRequestBodyText(resolve,reject){
        const bodyChunks=[];
        let bodyReadSettled=false;
        const bodyTimeout=timeoutMs==null
            ?null
            :setTimeout(function expireRequestBody(){
                settleBodyRead(new MailGatewayFault('mail_body_timeout',{
                    retryable:true,
                    statusCode:408
                }));
                request.resume();
            },timeoutMs);

        function releaseBodyReadResources(){
            if(bodyTimeout!==null) clearTimeout(bodyTimeout);
            request.removeListener('data',collectBodyChunk);
            request.removeListener('end',completeBodyRead);
            request.removeListener('error',rejectFailedBodyRead);
            request.removeListener('aborted',rejectAbortedBodyRead);
            signal?.removeEventListener('abort',cancelBodyReadFromSignal);
        }

        function settleBodyRead(error,value){
            if(bodyReadSettled){
                return;
            }
            bodyReadSettled=true;
            releaseBodyReadResources();
            if(error){
                reject(error);
            }else{
                resolve(value);
            }
        }

        function collectBodyChunk(chunk){
            const bodyChunk=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
            bodyChunks.push(bodyChunk);
        }

        function completeBodyRead(){
            settleBodyRead(null,Buffer.concat(bodyChunks).toString('utf8'));
        }

        function rejectFailedBodyRead(error){
            settleBodyRead(new MailGatewayFault('mail_request_stream_failed',{
                details:completeErrorDetails(error),
                retryable:true,
                statusCode:400
            }));
        }

        function rejectAbortedBodyRead(){
            settleBodyRead(new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            }));
        }

        function cancelBodyReadFromSignal(){
            settleBodyRead(new MailGatewayFault('mail_request_cancelled',{
                retryable:true,
                statusCode:408
            }));
            request.resume();
        }

        request.on('data',collectBodyChunk);
        request.once('end',completeBodyRead);
        request.once('error',rejectFailedBodyRead);
        request.once('aborted',rejectAbortedBodyRead);
        signal?.addEventListener('abort',cancelBodyReadFromSignal,{once:true});
        if(signal?.aborted){
            cancelBodyReadFromSignal();
        }
    });
}

function resolveReportRecipients(report,configuration){
    const recipients=is.array(report.to)&&report.to.length===0&&report.type==='error'
        ?configuration.errorRecipients
        :report.to;
    if(!configuration.allowAnyRecipient){
        for(const recipientGroup of [recipients,report.cc,report.bcc]){
            if(recipientGroup===undefined)continue;
            for(const recipient of is.array(recipientGroup)?recipientGroup:[recipientGroup]){
                if(configuration.allowedRecipients.has(recipient))continue;
                throw new MailGatewayFault('mail_recipient_not_allowed',{statusCode:403});
            }
        }
    }
    return recipients;
}

function prepareProviderDelivery(report,configuration){
    if(!report||!is.object(report)||is.array(report)){
        throw new MailGatewayFault('mail_invalid_report',{statusCode:422});
    }
    const recipients=resolveReportRecipients(report,configuration);
    const providerRequest={...report,to:recipients};
    delete providerRequest.type;
    if(configuration.from!==undefined)providerRequest.from=configuration.from;
    return {
        report,
        serializedProviderRequest:JSON.stringify(providerRequest),
        recipientCount:is.array(recipients)?recipients.length:recipients?1:0
    };
}

function parseMailRequest(requestText,configuration){
    let report;
    try{
        report=JSON.parse(requestText);
    }catch{
        throw new MailGatewayFault('mail_invalid_json',{statusCode:400});
    }
    return prepareProviderDelivery(report,configuration);
}

function parseRetryAfterMilliseconds(value,now=Date.now()){
    if(!is.string(value)){
        return 0;
    }
    const retryAfterValue=value.trim();
    if(!retryAfterValue)return 0;
    if(/^\d+(?:\.\d+)?$/u.test(retryAfterValue)){
        return retryDelayOrZero(Math.ceil(Number(retryAfterValue)*1000));
    }
    const timestamp=Date.parse(retryAfterValue);
    return is.finite(timestamp)
        ? retryDelayOrZero(Math.max(0,timestamp-now))
        : 0;
}

function waitForResultOrAbort(value,signal){
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
    if(!body||!is.function(body.cancel)){
        return;
    }
    try{
        Promise.resolve(body.cancel()).catch(ignoreCancellationFailure);
    }catch{
        // Cancellation is best-effort after the response boundary is classified.
    }
}

function cancelProviderReader(reader){
    if(!reader||!is.function(reader.cancel)){
        return;
    }
    try{
        Promise.resolve(reader.cancel()).catch(ignoreCancellationFailure);
    }catch{
        // Cancellation is best-effort after the response boundary is classified.
    }
}

async function readProviderResponseText(response,signal){
    if(response.body===null||response.body===undefined){
        return '';
    }
    if(!is.function(response.body.getReader)){
        cancelProviderBody(response.body);
        throw new MailGatewayFault('resend_unreadable_response',{
            statusCode:502,
            uncertain:true
        });
    }
    const reader=response.body.getReader();
    const decoder=new TextDecoder();
    let providerResponseText='';
    let fullyRead=false;
    try{
        while(true){
            const result=await waitForResultOrAbort(reader.read(),signal);
            if(result.done){
                fullyRead=true;
                break;
            }
            providerResponseText+=decoder.decode(result.value,{stream:true});
        }
        return providerResponseText+decoder.decode();
    }catch(error){
        throw new MailGatewayFault('resend_unreadable_response',{
            details:{
                error:completeErrorDetails(error),
                responseText:providerResponseText+decoder.decode(),
                responseComplete:false
            },
            statusCode:502,
            uncertain:true
        });
    }finally{
        if(!fullyRead){
            cancelProviderReader(reader);
        }
        try{
            reader.releaseLock();
        }catch{
            // Stream cleanup cannot replace the provider outcome.
        }
    }
}

function parseProviderResponse(providerResponseText){
    try{
        return JSON.parse(providerResponseText);
    }catch{
        return providerResponseText;
    }
}

function resolveProviderErrorCode(providerResponse,statusCode){
    if(is.string(providerResponse?.name)&&providerResponse.name){
        return providerResponse.name;
    }
    return `resend_http_${String(statusCode)}`;
}

function classifyProviderRejection(statusCode,value,retryAfterMs,defaultRetryAfterMs){
    const code=resolveProviderErrorCode(value,statusCode);
    const permanentRateLimit=PERMANENT_RATE_CODES.has(code);
    const retryable=code==='concurrent_idempotent_requests'
        ||(statusCode===409&&code!=='invalid_idempotent_request')
        ||(!permanentRateLimit&&code!=='invalid_idempotent_request'
            &&RETRYABLE_PROVIDER_STATUSES.has(statusCode));
    const resolvedDelay=retryable
        ? retryAfterMs||defaultRetryAfterMs
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

function createUncertainProviderResult(code,retryAfterMs,providerStatus=0,details=null){
    return {
        code,
        details,
        kind:'ambiguous',
        providerStatus,
        retryAfterMs:retryDelayOrZero(retryAfterMs)
    };
}

async function attemptResendDelivery(configuration,delivery,idempotencyKey,signal,requestId,observe,appId=configuration.appId){
    const controller=new AbortController();
    let outcome=null;
    let timedOut=false;
    function recordAttemptOutcome(result){
        outcome=result;
        return result;
    }
    function abortProviderRequest(){
        controller.abort(signal?.reason??new Error('Mail request cancelled.'));
    }
    signal?.addEventListener('abort',abortProviderRequest,{once:true});
    if(signal?.aborted){
        abortProviderRequest();
    }
    const timeout=configuration.providerTimeoutMs==null
        ?null
        :setTimeout(function abortTimedOutProviderRequest(){
            timedOut=true;
            controller.abort(new Error('Resend request timed out.'));
        },configuration.providerTimeoutMs);
    const startedAt=configuration.onEvent?Date.now():0;
    if(configuration.onEvent)observe({
        type:'mail.provider.started',
        appId,
        idempotencyKey,
        providerRequest:JSON.parse(delivery.serializedProviderRequest),
        report:delivery.report,
        requestId
    });
    let response;
    try{
        try{
            response=await waitForResultOrAbort(configuration.fetchImpl(RESEND_EMAIL_ENDPOINT,{
                method:'POST',
                headers:{
                    'Authorization':`Bearer ${configuration.apiKey}`,
                    'Content-Type':'application/json',
                    'Idempotency-Key':idempotencyKey,
                    'User-Agent':'arcane-os-sdk-mail/1'
                },
                body:delivery.serializedProviderRequest,
                redirect:'error',
                signal:controller.signal
            }),controller.signal);
        }catch(error){
            return recordAttemptOutcome(createUncertainProviderResult(
                timedOut?'resend_timeout':'resend_transport_uncertain',
                configuration.retryableDelayMs,
                0,
                completeErrorDetails(error)
            ));
        }
        const statusCode=Number(response?.status);
        if(!is.safeInteger(statusCode)||statusCode<100||statusCode>599){
            return recordAttemptOutcome(createUncertainProviderResult(
                'resend_invalid_response',
                configuration.retryableDelayMs,
                0,
                {status:response?.status??null}
            ));
        }
        let providerResponseText='';
        try{
            providerResponseText=await readProviderResponseText(response,controller.signal);
        }catch(error){
            if(statusCode>=200&&statusCode<300||controller.signal.aborted){
                return recordAttemptOutcome(createUncertainProviderResult(
                    error instanceof MailGatewayFault?error.code:'resend_transport_uncertain',
                    configuration.retryableDelayMs,
                    statusCode,
                    completeErrorDetails(error)
                ));
            }
            return recordAttemptOutcome(classifyProviderRejection(
                statusCode,
                completeErrorDetails(error),
                parseRetryAfterMilliseconds(response.headers.get('retry-after')),
                configuration.retryableDelayMs
            ));
        }
        const providerResponse=parseProviderResponse(providerResponseText);
        if(statusCode>=200&&statusCode<300){
            if(!is.string(providerResponse?.id)||!providerResponse.id){
                return recordAttemptOutcome(createUncertainProviderResult(
                    'resend_invalid_success_response',
                    configuration.retryableDelayMs,
                    statusCode,
                    providerResponse
                ));
            }
            return recordAttemptOutcome({
                kind:'accepted',
                providerId:providerResponse.id,
                providerResponse,
                providerStatus:statusCode
            });
        }
        return recordAttemptOutcome(classifyProviderRejection(
            statusCode,
            providerResponse,
            parseRetryAfterMilliseconds(response.headers.get('retry-after')),
            configuration.retryableDelayMs
        ));
    }finally{
        if(timeout!==null) clearTimeout(timeout);
        signal?.removeEventListener('abort',abortProviderRequest);
        if(configuration.onEvent)observe({
            type:'mail.provider.completed',
            appId,
            idempotencyKey,
            outcome,
            providerRequest:JSON.parse(delivery.serializedProviderRequest),
            report:delivery.report,
            durationMs:Math.max(0,Date.now()-startedAt),
            requestId,
            providerStatus:is.safeInteger(Number(response?.status))?Number(response.status):0
        });
    }
}

function resolveDirectSendConfiguration(options){
    if(!options||!is.object(options)||is.array(options)){
        throw configurationError('Mail send options must be an object.');
    }
    if(!is.string(options.reportKey)||!options.reportKey){
        throw configurationError('reportKey is required to identify the mail attempt.');
    }
    const fetchImpl=options.fetchImpl??globalThis.fetch;
    if(!is.function(fetchImpl)){
        throw configurationError('A fetch implementation is required for Resend delivery.');
    }
    if(options.onEvent!==undefined&&!is.function(options.onEvent)){
        throw configurationError('onEvent must be a function when supplied.');
    }
    if(options.requestIdFactory!==undefined&&!is.function(options.requestIdFactory)){
        throw configurationError('requestIdFactory must be a function when supplied.');
    }
    return {
        allowAnyRecipient:true,
        allowedRecipients:null,
        apiKey:options.apiKey,
        appId:options.appId,
        errorRecipients:[],
        fetchImpl,
        from:options.from,
        providerTimeoutMs:optionalTimeoutMs(options.providerTimeoutMs,'providerTimeoutMs'),
        requestIdFactory:options.requestIdFactory??randomUUID,
        retryableDelayMs:readRetryDelayMs(options.retryableDelayMs),
        signal:options.signal,
        report:options.report,
        reportKey:options.reportKey,
        onEvent:options.onEvent
    };
}

function createDirectSendResult(result,{delivery,requestId}){
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
        providerRequest:JSON.parse(delivery.serializedProviderRequest),
        report:delivery.report,
        recipientCount:delivery.recipientCount
    };
    if(result.kind==='accepted'){
        return common;
    }
    if(result.kind==='ambiguous'){
        return {
            ...common,
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
    const configuration=resolveDirectSendConfiguration(options);
    if(configuration.signal?.aborted){
        const error=new Error('Mail send cancelled before provider attempt.',{
            cause:configuration.signal.reason
        });
        error.code='ARCANE_CANCELLED';
        throw error;
    }
    const delivery=prepareProviderDelivery(configuration.report,configuration);
    const requestId=createRequestId(configuration.requestIdFactory);
    const observer=configuration.onEvent?createMailEventObserver(configuration.onEvent):null;
    try{
        const result=await attemptResendDelivery(
            configuration,
            delivery,
            configuration.reportKey,
            configuration.signal,
            requestId,
            observer?.observe
        );
        return createDirectSendResult(result,{
            delivery,
            requestId
        });
    }finally{
        if(observer)await observer.drain();
    }
}

function writeProviderDeliveryResponse(response,result,{origin,requestId,recipientCount}){
    if(result.kind==='accepted'){
        return sendJsonResponse(response,202,{
            requestId,
            status:'accepted',
            accepted:recipientCount,
            rejected:0,
            providerId:result.providerId,
            providerResponse:result.providerResponse
        },{origin});
    }
    if(result.kind==='ambiguous'){
        return sendJsonResponse(response,207,{
            requestId,
            status:'delivery_uncertain',
            accepted:0,
            rejected:0,
            details:result.details,
            ...(result.retryAfterMs?{retryAfterMs:result.retryAfterMs}:{})
        },{origin,retryAfterMs:result.retryAfterMs});
    }
    return sendMailFailureResponse(response,requestId,result.fault,origin);
}

export function createResendMailRequestHandler(options={}){
    return createConfiguredMailHandler(resolveMailServerConfiguration(options));
}

function createConfiguredMailHandler(configuration){
    const ownerController=new AbortController();
    const activeRequests=new Set();
    const observer=configuration.onEvent?createMailEventObserver(configuration.onEvent):null;
    let closePromise=null;

    function abortHandlerFromOwner(){
        ownerController.abort(configuration.signal?.reason??new Error('Mail server cancelled.'));
    }
    configuration.signal?.addEventListener('abort',abortHandlerFromOwner,{once:true});
    if(configuration.signal?.aborted){
        abortHandlerFromOwner();
    }

    async function handleMailRequest(request,response){
        const requestId=createRequestId(configuration.requestIdFactory);
        let appId=request.headers['x-mail-app']??configuration.appId;
        const startedAt=configuration.onEvent?Date.now():0;
        const requestController=new AbortController();
        let delivery=null;
        let idempotencyKey=null;
        let origin='';
        let providerAttempted=false;
        let result=null;

        function abortRequestFromHandler(){
            requestController.abort(ownerController.signal.reason);
        }
        function abortDisconnectedRequest(){
            requestController.abort(new Error('Mail client disconnected.'));
        }
        function abortRequestOnPrematureResponseClose(){
            if(!response.writableEnded){
                abortDisconnectedRequest();
            }
        }
        function releaseRequestListeners(){
            request.removeListener('aborted',abortDisconnectedRequest);
            request.removeListener('error',abortDisconnectedRequest);
        }
        function releaseResponseListeners(){
            response.removeListener('close',abortRequestOnPrematureResponseClose);
            response.removeListener('error',abortDisconnectedRequest);
        }

        ownerController.signal.addEventListener('abort',abortRequestFromHandler,{once:true});
        request.once('aborted',abortDisconnectedRequest);
        request.once('error',abortDisconnectedRequest);
        response.once('close',abortRequestOnPrematureResponseClose);
        response.once('error',abortDisconnectedRequest);
        if(ownerController.signal.aborted){
            abortRequestFromHandler();
        }
        if(configuration.onEvent)observer.observe({
            type:'mail.request.received',
            appId,
            requestId
        });

        try{
            if(request.url!==RESEND_MAIL_PATH&&!request.url?.startsWith(`${RESEND_MAIL_PATH}?`)){
                throw new MailGatewayFault('mail_route_not_found',{statusCode:404});
            }
            const requestOrigin=request.headers.origin;
            if(requestOrigin){
                const requestAuthority = request.authority || request.headers.host;
                const originAllowed=configuration.allowedOrigins.size>0
                    ?configuration.allowedOrigins.has(requestOrigin)
                    :requestOrigin===`https://${requestAuthority}`
                        ||requestOrigin===`http://${requestAuthority}`;
                if(!originAllowed){
                    throw new MailGatewayFault('mail_origin_not_allowed',{statusCode:403});
                }
                origin=requestOrigin;
            }
            if(request.method==='OPTIONS'){
                sendCorsPreflightResponse(response,origin);
                return;
            }
            if(request.method!=='POST'){
                throw new MailGatewayFault('mail_method_not_allowed',{statusCode:405});
            }
            if(configuration.verifySubscription){
                appId=await verifyMailSubscription(request,configuration,requestController.signal);
            }
            idempotencyKey=requireRequestHeader(request,'idempotency-key');
            const requestText=await readRequestBodyText(request,{
                signal:requestController.signal,
                timeoutMs:configuration.bodyTimeoutMs
            });
            delivery=parseMailRequest(requestText,configuration);
            providerAttempted=true;
            result=await attemptResendDelivery(
                configuration,
                delivery,
                idempotencyKey,
                requestController.signal,
                requestId,
                observer?.observe,
                appId
            );
            writeProviderDeliveryResponse(response,result,{
                origin,
                recipientCount:delivery.recipientCount,
                requestId
            });
            if(configuration.onEvent)observer.observe({
                type:'mail.request.completed',
                appId,
                classification:result.kind,
                delivery,
                durationMs:Math.max(0,Date.now()-startedAt),
                idempotencyKey,
                providerAttempted,
                result,
                requestId
            });
        }catch(error){
            const fault=mailFaultFromError(error);
            sendMailFailureResponse(response,requestId,fault,origin);
            if(!request.readableEnded&&!request.destroyed){
                request.resume();
            }
            if(configuration.onEvent)observer.observe({
                type:'mail.request.completed',
                appId,
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
            ownerController.signal.removeEventListener('abort',abortRequestFromHandler);
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

    function dispatchMailRequest(request,response){
        const operation=handleMailRequest(request,response);
        activeRequests.add(operation);
        operation.catch(function closeResponseAfterHandlerFailure(error){
            reportMailError('Mail request handler failed.',error);
            if(!response.destroyed){
                response.destroy(error);
            }
        }).finally(function releaseActiveRequest(){
            activeRequests.delete(operation);
        });
    }

    async function closeMailRequestHandler(){
        configuration.signal?.removeEventListener('abort',abortHandlerFromOwner);
        if(!ownerController.signal.aborted){
            ownerController.abort(new Error('Mail server closed.'));
        }
        await Promise.allSettled([...activeRequests]);
        if(observer)await observer.drain();
    }

    function close(){
        if(!closePromise){
            closePromise=closeMailRequestHandler();
        }
        return closePromise;
    }

    return {
        appId:configuration.appId,
        callerAuthentication:configuration.callerAuthentication,
        close,
        handle:dispatchMailRequest,
        path:RESEND_MAIL_PATH,
        protocol:RESEND_MAIL_SERVER_PROTOCOL
    };
}

function listenForMailRequests(mailServer){
    return new Promise(function waitForMailListener(resolve,reject){
        function onError(error){
            reject(error);
        }
        mailServer.deploy(function onListening(instance,server){
            server.removeListener('error',onError);
            resolve(server);
        });
        const listener = mailServer.secureServer ?? mailServer.server;
        listener.once('error', onError);
    });
}

export async function startResendMailServer(options={}){
    const configuration=resolveMailServerConfiguration(options);
    if(configuration.signal?.aborted){
        throw configuration.signal.reason??new Error('Mail server start was cancelled.');
    }
    if ((options.certPath === undefined) !== (options.keyPath === undefined)) {
        throw configurationError('Mail HTTPS requires both certPath and keyPath when either is supplied.');
    }
    const httpsSelected = options.certPath !== undefined;
    const mailServer = new Server(
        {
            host: configuration.host,
            port: configuration.port,
            server: {timeout: 0},
            https: httpsSelected ? {
                certificate: options.certPath,
                privateKey: options.keyPath,
                port: configuration.port,
                only: true,
                http2: true
            } : {}
        }
    );
    const requestHandler=createConfiguredMailHandler(configuration);
    mailServer.onRawRequest=function routeRawMailRequest(request,response){
        requestHandler.handle(request,response);
        return true;
    };

    let server;
    try{
        server=await listenForMailRequests(mailServer);
    }catch(error){
        await Promise.allSettled([mailServer.close(),requestHandler.close()]);
        if (error?.code === 'EADDRINUSE') {
            throw Object.assign(
                new Error(
                    `Mail port ${configuration.port} is already taken, possibly by another mail server.`,
                    {cause:error}
                ),
                error
            );
        }
        throw error;
    }
    const address=server.address();
    if(!address||is.string(address)){
        await Promise.allSettled([mailServer.close(),requestHandler.close()]);
        throw configurationError('Mail server has no TCP listener address.');
    }
    const displayHost=address.address.includes(':')?`[${address.address}]`:address.address;
    const origin = `${httpsSelected ? 'https' : 'http'}://${displayHost}:${String(address.port)}`;
    let closePromise=null;
    let resolveLifecycle;
    let rejectLifecycle;
    const lifecycle=new Promise(function createMailLifecycle(resolve,reject){
        resolveLifecycle=resolve;
        rejectLifecycle=reject;
    });
    lifecycle.catch(function observeMailLifecycleFailure(){});

    async function closeMailServer(){
        configuration.signal?.removeEventListener('abort',closeServerOnAbort);
        const handlerClosing=requestHandler.close();
        try{
            await Promise.all([mailServer.close(),handlerClosing]);
            resolveLifecycle();
        }catch(error){
            rejectLifecycle(error);
            throw error;
        }
    }

    function close(){
        if(!closePromise){
            closePromise=closeMailServer();
        }
        return closePromise;
    }

    function closeServerOnAbort(){
        close().catch(function ignoreSignalCloseFailure(){});
    }

    function closeServerAfterError(error){
        rejectLifecycle(error);
        close().catch(function observeOperationalCloseFailure(){});
    }

    server.once('close',function finishMailServerAfterExternalClose(){
        if(!closePromise){
            closePromise=requestHandler.close().then(
                function resolveExternalClose(){resolveLifecycle();},
                function rejectExternalClose(error){rejectLifecycle(error);throw error;}
            );
            closePromise.catch(function observeExternalCloseFailure(){});
        }
    });
    server.on('error',closeServerAfterError);
    configuration.signal?.addEventListener('abort',closeServerOnAbort,{once:true});
    if(configuration.signal?.aborted){
        closeServerOnAbort();
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
