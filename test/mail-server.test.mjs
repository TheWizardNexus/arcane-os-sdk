import assert from 'node:assert/strict';
import http from 'node:http';
import test from '../src/testing.mjs';
import {
    createResendMailRequestHandler,
    RESEND_MAIL_PATH,
    RESEND_MAIL_SERVER_PROTOCOL,
    startResendMailServer
} from '../src/mail-server.mjs';
import {sendMailReport} from '../runtime/arcane/modules/MailTransport.mjs';

const API_KEY='re_synthetic_gateway_secret';
const APP_KEY='synthetic-local-caller-key-0001';
const APP_ID='mail-test-app';
const ALLOWED_ORIGIN='https://app.example.test';
const ALLOWED_RECIPIENT='recipient@example.test';
const ERROR_RECIPIENT='errors@example.test';
const FROM='Arcane Mail <sender@example.test>';
const ACCEPTED_PROVIDER_ID='49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';

function validReport(overrides={}){
    return {
        subject:'Synthetic mail report',
        text:'Synthetic message body.',
        to:[ALLOWED_RECIPIENT],
        type:'report',
        ...overrides
    };
}

function jsonResponse(value,{headers={},status=200}={}){
    return new Response(JSON.stringify(value),{
        headers:{'content-type':'application/json',...headers},
        status
    });
}

function defaultFetch(){
    return Promise.resolve(jsonResponse({id:ACCEPTED_PROVIDER_ID}));
}

function gatewayOptions(overrides={}){
    return {
        allowedOrigins:[ALLOWED_ORIGIN],
        apiKey:API_KEY,
        appKey:APP_KEY,
        appId:APP_ID,
        errorRecipients:[ERROR_RECIPIENT],
        fetchImpl:defaultFetch,
        from:FROM,
        port:0,
        recipientAllowlist:[ALLOWED_RECIPIENT,ERROR_RECIPIENT],
        ...overrides
    };
}

async function startGateway(t,overrides={}){
    const instance=await startResendMailServer(gatewayOptions(overrides));
    t.after(function closeMailGateway(){
        return instance.close();
    });
    return instance;
}

async function requestMail(instance,{
    body=validReport(),
    callerKey=APP_KEY,
    headers={},
    method='POST',
    origin=ALLOWED_ORIGIN,
    path=RESEND_MAIL_PATH,
    reportKey='synthetic-report-key-0001',
    signal
}={}){
    const requestHeaders={...headers};
    if(origin!==null){
        requestHeaders.Origin=origin;
    }
    if(method==='POST'){
        if(!Object.hasOwn(requestHeaders,'Content-Type')){
            requestHeaders['Content-Type']='application/json';
        }
        if(!Object.hasOwn(requestHeaders,'Idempotency-Key')){
            requestHeaders['Idempotency-Key']=reportKey;
        }
        if(!Object.hasOwn(requestHeaders,'X-Mail-App')){
            requestHeaders['X-Mail-App']=APP_ID;
        }
        if(callerKey!==null&&!Object.hasOwn(requestHeaders,'X-Mail-Key')){
            requestHeaders['X-Mail-Key']=callerKey;
        }
    }
    const response=await fetch(`${instance.origin}${path}`,{
        body:method==='POST'?(typeof body==='string'?body:JSON.stringify(body)):undefined,
        headers:requestHeaders,
        method,
        redirect:'manual',
        signal
    });
    const text=await response.text();
    let parsed=null;
    if(text){
        parsed=JSON.parse(text);
    }
    return {body:parsed,response,text};
}

function rawRequest(instance,{
    body='',
    headers={},
    method='POST',
    path=RESEND_MAIL_PATH
}={}){
    return new Promise(function performRawRequest(resolve,reject){
        const request=http.request({
            headers,
            hostname:instance.host,
            method,
            path,
            port:instance.port
        },function collectRawResponse(response){
            const chunks=[];
            response.on('data',function collectRawChunk(chunk){chunks.push(Buffer.from(chunk));});
            response.once('end',function finishRawResponse(){
                const text=Buffer.concat(chunks).toString('utf8');
                resolve({
                    body:text?JSON.parse(text):null,
                    headers:response.headers,
                    statusCode:response.statusCode,
                    text
                });
            });
        });
        request.once('error',reject);
        request.end(body);
    });
}

function deferred(){
    let resolve;
    let reject;
    const promise=new Promise(function createDeferredPromise(resolvePromise,rejectPromise){
        resolve=resolvePromise;
        reject=rejectPromise;
    });
    return {promise,reject,resolve};
}

async function within(promise,timeoutMs=1_000){
    let timer;
    const timeout=new Promise(function createBoundedWait(resolve,reject){
        timer=setTimeout(function rejectBoundedWait(){
            reject(new Error('Synthetic gateway operation exceeded its time bound.'));
        },timeoutMs);
    });
    try{
        return await Promise.race([promise,timeout]);
    }finally{
        clearTimeout(timer);
    }
}

test('mail gateway rejects unsafe configuration before binding',function testUnsafeConfiguration(){
    const invalidOptions=[
        {host:'localhost'},
        {host:'0.0.0.0'},
        {allowedOrigins:['https://app.example.test/path']},
        {allowedOrigins:[]},
        {appKey:undefined},
        {appKey:'too-short'},
        {allowUnauthenticatedCaller:true},
        {appId:'Invalid App'},
        {from:'sender@example.test\r\nBcc: attacker@example.test'},
        {recipientAllowlist:[]},
        {errorRecipients:['outside@example.test']},
        {maxMessageBytes:1024,maxRequestBytes:1024}
    ];
    for(const overrides of invalidOptions){
        assert.throws(
            function createInvalidMailHandler(){
                createResendMailRequestHandler(gatewayOptions(overrides));
            },
            function isConfigurationError(error){
                return error?.code==='ARCANE_MAIL_CONFIG_INVALID';
            }
        );
    }
});

test('mail gateway exposes an exact, credential-free lifecycle contract',async function testLifecycleContract(t){
    const instance=await startGateway(t);
    assert.equal(instance.protocol,RESEND_MAIL_SERVER_PROTOCOL);
    assert.equal(instance.path,RESEND_MAIL_PATH);
    assert.equal(instance.mode,'mail');
    assert.equal(instance.target,'mail');
    assert.equal(instance.appId,APP_ID);
    assert.equal(instance.callerAuthentication,'app-key');
    assert.equal(instance.url,`${instance.origin}${RESEND_MAIL_PATH}`);
    assert.equal(instance.host,'127.0.0.1');
    assert.equal(instance.closed,instance.lifecycle);
    for(const secretProperty of ['apiKey','appKey','from','recipientAllowlist','allowedOrigins']){
        assert.equal(Object.hasOwn(instance,secretProperty),false);
    }
    const firstClose=instance.close();
    const secondClose=instance.close();
    assert.equal(firstClose,secondClose);
    await firstClose;
    await instance.lifecycle;
});

test('mail gateway authenticates local callers with a separate app key',async function testCallerAuthentication(t){
    let authenticatedProviderCalls=0;
    const authenticated=await startGateway(t,{
        fetchImpl:function countAuthenticatedProviderCall(){
            authenticatedProviderCalls+=1;
            return defaultFetch();
        }
    });
    const missing=await requestMail(authenticated,{
        callerKey:null,
        reportKey:'missing-caller-key-0001'
    });
    assert.equal(missing.response.status,401);
    assert.equal(missing.body.error.code,'mail_app_key_invalid');
    const mismatch=await requestMail(authenticated,{
        callerKey:'synthetic-wrong-caller-key-0002',
        reportKey:'wrong-caller-key-0002'
    });
    assert.equal(mismatch.response.status,401);
    assert.equal(mismatch.body.error.code,'mail_app_key_invalid');
    const accepted=await requestMail(authenticated,{
        reportKey:'valid-caller-key-0003'
    });
    assert.equal(accepted.response.status,202);
    assert.equal(authenticatedProviderCalls,1);

    let unauthenticatedProviderCalls=0;
    const explicitlyUnauthenticated=await startGateway(t,{
        allowUnauthenticatedCaller:true,
        appKey:undefined,
        fetchImpl:function countExplicitNoKeyProviderCall(){
            unauthenticatedProviderCalls+=1;
            return defaultFetch();
        }
    });
    assert.equal(
        explicitlyUnauthenticated.callerAuthentication,
        'origin-app-id-only'
    );
    const noKeyAccepted=await requestMail(explicitlyUnauthenticated,{
        callerKey:null,
        reportKey:'explicit-no-key-mode-0001'
    });
    assert.equal(noKeyAccepted.response.status,202);
    const unexpectedKey=await requestMail(explicitlyUnauthenticated,{
        reportKey:'unexpected-key-no-key-mode-0002'
    });
    assert.equal(unexpectedKey.response.status,403);
    assert.equal(unexpectedKey.body.error.code,'mail_app_key_unexpected');
    assert.equal(unauthenticatedProviderCalls,1);
});

test('mail gateway answers only an exact allowed CORS preflight',async function testCorsPreflight(t){
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function countUnexpectedProviderCall(){
            providerCalls+=1;
            return defaultFetch();
        }
    });
    const accepted=await fetch(instance.url,{
        headers:{
            'Access-Control-Request-Headers':'content-type, idempotency-key, x-mail-app, x-mail-key',
            'Access-Control-Request-Method':'POST',
            'Access-Control-Request-Private-Network':'true',
            'Origin':ALLOWED_ORIGIN
        },
        method:'OPTIONS'
    });
    assert.equal(accepted.status,204);
    assert.equal(accepted.headers.get('access-control-allow-origin'),ALLOWED_ORIGIN);
    assert.equal(accepted.headers.get('access-control-allow-methods'),'POST, OPTIONS');
    assert.equal(
        accepted.headers.get('access-control-allow-headers'),
        'Content-Type, Idempotency-Key, X-Mail-App, X-Mail-Key'
    );
    assert.equal(accepted.headers.get('access-control-allow-private-network'),'true');
    assert.equal(accepted.headers.get('access-control-allow-credentials'),null);

    const extraHeader=await fetch(instance.url,{
        headers:{
            'Access-Control-Request-Headers':'content-type, authorization',
            'Access-Control-Request-Method':'POST',
            'Origin':ALLOWED_ORIGIN
        },
        method:'OPTIONS'
    });
    assert.equal(extraHeader.status,403);

    const deniedOrigin=await fetch(instance.url,{
        headers:{
            'Access-Control-Request-Headers':'content-type, idempotency-key, x-mail-app, x-mail-key',
            'Access-Control-Request-Method':'POST',
            'Origin':'https://attacker.example.test'
        },
        method:'OPTIONS'
    });
    assert.equal(deniedOrigin.status,403);
    assert.equal(deniedOrigin.headers.get('access-control-allow-origin'),null);
    assert.equal(providerCalls,0);
});

test('mail gateway accepts only a Resend response containing an email id',async function testAcceptedResendResponse(t){
    const calls=[];
    const events=[];
    const providerKey='accepted-idempotency-key-0001';
    const secretBody='Synthetic private body value.';
    const instance=await startGateway(t,{
        fetchImpl:function captureResendRequest(url,options){
            calls.push({url,options});
            return Promise.resolve(jsonResponse({id:ACCEPTED_PROVIDER_ID}));
        },
        onEvent:function captureSafeMailEvent(event){events.push(event);}
    });
    const result=await requestMail(instance,{
        body:validReport({text:secretBody}),
        reportKey:providerKey
    });
    assert.equal(result.response.status,202);
    assert.deepEqual(result.body,{
        requestId:result.body.requestId,
        status:'accepted',
        accepted:1,
        rejected:0,
        providerId:ACCEPTED_PROVIDER_ID
    });
    assert.equal(Object.hasOwn(result.body,'delivered'),false);
    assert.match(result.body.requestId,/^[a-zA-Z0-9-]{8,128}$/u);
    assert.equal(result.response.headers.get('access-control-allow-origin'),ALLOWED_ORIGIN);
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,'https://api.resend.com/emails');
    assert.equal(calls[0].options.method,'POST');
    assert.equal(calls[0].options.headers.Authorization,`Bearer ${API_KEY}`);
    assert.equal(calls[0].options.headers['Idempotency-Key'],providerKey);
    assert.deepEqual(JSON.parse(calls[0].options.body),{
        from:FROM,
        to:[ALLOWED_RECIPIENT],
        subject:'Synthetic mail report',
        text:secretBody
    });
    const eventText=JSON.stringify(events);
    for(const forbiddenValue of [
        API_KEY,
        APP_KEY,
        providerKey,
        secretBody,
        FROM,
        ALLOWED_RECIPIENT,
        ACCEPTED_PROVIDER_ID
    ]){
        assert.equal(eventText.includes(forbiddenValue),false);
    }
});

test('MailTransport reaches the loopback gateway with one stable provider attempt',async function testTransportGatewayIntegration(t){
    const providerCalls=[];
    const report=validReport({text:'Synthetic transport integration body.'});
    const reportKey='transport-integration-key-0001';
    const instance=await startGateway(t,{
        fetchImpl:async function captureIntegratedProviderAttempt(url,options){
            providerCalls.push({url,options});
            return jsonResponse({id:ACCEPTED_PROVIDER_ID});
        }
    });
    const result=await sendMailReport({
        appKey:APP_KEY,
        appName:APP_ID,
        endpoint:instance.url,
        fetchImpl:async function addSyntheticBrowserOrigin(url,options){
            return fetch(url,{
                ...options,
                headers:{...options.headers,Origin:ALLOWED_ORIGIN}
            });
        },
        report,
        reportKey,
        requestTimeout:5_000
    });

    assert.equal(result.sent,true);
    assert.equal(result.status,'accepted');
    assert.equal(result.providerId,ACCEPTED_PROVIDER_ID);
    assert.equal(providerCalls.length,1);
    assert.equal(providerCalls[0].url,'https://api.resend.com/emails');
    assert.equal(providerCalls[0].options.headers['Idempotency-Key'],reportKey);
    assert.deepEqual(JSON.parse(providerCalls[0].options.body),{
        from:FROM,
        to:[ALLOWED_RECIPIENT],
        subject:report.subject,
        text:report.text
    });
});

test('error reports use only configured allowlisted fallback recipients',async function testErrorFallback(t){
    const calls=[];
    const instance=await startGateway(t,{
        fetchImpl:function captureErrorReport(url,options){
            calls.push({url,options});
            return Promise.resolve(jsonResponse({id:ACCEPTED_PROVIDER_ID}));
        }
    });
    const result=await requestMail(instance,{
        body:validReport({to:[],type:'error'}),
        reportKey:'synthetic-error-key-0001'
    });
    assert.equal(result.response.status,202);
    assert.equal(result.body.accepted,1);
    assert.deepEqual(JSON.parse(calls[0].options.body).to,[ERROR_RECIPIENT]);
});

test('request validation rejects before any provider attempt',async function testRequestValidation(t){
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function countProviderAttempts(){
            providerCalls+=1;
            return defaultFetch();
        },
        maxMessageBytes:32
    });
    const cases=[
        {
            expectedCode:'mail_origin_not_allowed',
            expectedStatus:403,
            options:{origin:'https://attacker.example.test'}
        },
        {
            expectedCode:'mail_app_not_allowed',
            expectedStatus:403,
            options:{headers:{'X-Mail-App':'another-app'}}
        },
        {
            expectedCode:'invalid_idempotency_key',
            expectedStatus:400,
            options:{reportKey:'short'}
        },
        {
            expectedCode:'mail_unsupported_content_type',
            expectedStatus:415,
            options:{headers:{'Content-Type':'text/plain'}}
        },
        {
            expectedCode:'mail_invalid_report_shape',
            expectedStatus:422,
            options:{body:{...validReport(),extra:true}}
        },
        {
            expectedCode:'mail_recipient_not_allowed',
            expectedStatus:403,
            options:{body:validReport({to:['outside@example.test']})}
        },
        {
            expectedCode:'mail_invalid_subject',
            expectedStatus:422,
            options:{body:validReport({subject:'bad\nsubject'})}
        },
        {
            expectedCode:'mail_invalid_type',
            expectedStatus:422,
            options:{body:validReport({type:'unknown'})}
        },
        {
            expectedCode:'mail_content_required',
            expectedStatus:422,
            options:{body:validReport({text:''})}
        },
        {
            expectedCode:'mail_content_required',
            expectedStatus:422,
            options:{body:validReport({text:'   \n\t'})}
        },
        {
            expectedCode:'mail_unsupported_content',
            expectedStatus:422,
            options:{body:validReport({text:'invalid\u0000content'})}
        },
        {
            expectedCode:'mail_message_too_large',
            expectedStatus:413,
            options:{body:validReport({text:'x'.repeat(33)})}
        },
        {
            expectedCode:'mail_invalid_json',
            expectedStatus:400,
            options:{body:'{not json'}
        }
    ];
    for(const entry of cases){
        const result=await requestMail(instance,entry.options);
        assert.equal(result.response.status,entry.expectedStatus,entry.expectedCode);
        assert.equal(result.body.error.code,entry.expectedCode);
        assert.equal(result.body.error.retryable,false);
        assert.equal(result.body.error.uncertain,false);
    }
    const missingOrigin=await requestMail(instance,{origin:null});
    assert.equal(missingOrigin.response.status,400);
    assert.equal(missingOrigin.body.error.code,'mail_invalid_headers');

    const missingRoute=await requestMail(instance,{path:'/not-mail'});
    assert.equal(missingRoute.response.status,404);
    assert.equal(missingRoute.body.error.code,'mail_route_not_found');

    const getRequest=await requestMail(instance,{method:'GET'});
    assert.equal(getRequest.response.status,405);
    assert.equal(getRequest.body.error.code,'mail_method_not_allowed');
    assert.equal(providerCalls,0);
});

test('numeric loopback Host admission rejects DNS-rebinding targets',async function testHostAdmission(t){
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function countProviderAttempts(){
            providerCalls+=1;
            return defaultFetch();
        }
    });
    const serialized=JSON.stringify(validReport());
    const result=await rawRequest(instance,{
        body:serialized,
        headers:{
            'Content-Length':String(Buffer.byteLength(serialized)),
            'Content-Type':'application/json',
            'Host':`attacker.invalid:${String(instance.port)}`,
            'Idempotency-Key':'host-admission-key-0001',
            'Origin':ALLOWED_ORIGIN,
            'X-Mail-App':APP_ID,
            'X-Mail-Key':APP_KEY
        }
    });
    assert.equal(result.statusCode,421);
    assert.equal(result.body.error.code,'mail_invalid_host');
    assert.equal(providerCalls,0);
});

test('provider rejections map to explicit retryable and permanent errors',async function testProviderRejectionMappings(t){
    const responses=[
        jsonResponse(
            {name:'rate_limit_exceeded',message:'not returned'},
            {headers:{'retry-after':'2'},status:429}
        ),
        jsonResponse({name:'concurrent_idempotent_requests'}, {status:409}),
        jsonResponse({name:'invalid_idempotent_request'}, {status:409}),
        jsonResponse({name:'validation_error'}, {status:400}),
        jsonResponse({name:'application_error'}, {status:500}),
        jsonResponse({name:'daily_quota_exceeded'}, {status:429}),
        new Response('',{status:409})
    ];
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function returnNextProviderResponse(){
            providerCalls+=1;
            return Promise.resolve(responses.shift());
        }
    });
    const expected=[
        {code:'rate_limit_exceeded',retryable:true,status:429,retryAfterMs:2_000},
        {code:'concurrent_idempotent_requests',retryable:true,status:503,retryAfterMs:1_000},
        {code:'invalid_idempotent_request',retryable:false,status:422,retryAfterMs:0},
        {code:'validation_error',retryable:false,status:422,retryAfterMs:0},
        {code:'application_error',retryable:true,status:503,retryAfterMs:1_000},
        {code:'daily_quota_exceeded',retryable:false,status:422,retryAfterMs:0},
        {code:'resend_http_409',retryable:true,status:503,retryAfterMs:1_000}
    ];
    for(let index=0;index<expected.length;index+=1){
        const result=await requestMail(instance,{
            reportKey:`provider-mapping-key-${String(index).padStart(4,'0')}`
        });
        const expectation=expected[index];
        assert.equal(result.response.status,expectation.status);
        assert.equal(result.body.error.code,expectation.code);
        assert.equal(result.body.error.retryable,expectation.retryable);
        assert.equal(result.body.error.uncertain,false);
        assert.equal(result.body.error.retryAfterMs??0,expectation.retryAfterMs);
        assert.equal(Object.hasOwn(result.body.error,'message'),false);
    }
    assert.equal(providerCalls,expected.length);
});

test('ambiguous provider outcomes never claim acceptance or delivery',async function testAmbiguousMappings(t){
    const responses=[
        new Error('synthetic transport failure'),
        jsonResponse({}),
        new Response('{invalid json',{status:200}),
        new Response(JSON.stringify({id:ACCEPTED_PROVIDER_ID}),{
            headers:{'content-length':'1024'},
            status:200
        })
    ];
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function returnAmbiguousProviderOutcome(){
            providerCalls+=1;
            const next=responses.shift();
            if(next instanceof Error){
                return Promise.reject(next);
            }
            return Promise.resolve(next);
        },
        maxProviderResponseBytes:64
    });
    for(let index=0;index<4;index+=1){
        const result=await requestMail(instance,{
            reportKey:`ambiguous-result-key-${String(index).padStart(4,'0')}`
        });
        assert.equal(result.response.status,207);
        assert.deepEqual(result.body,{
            requestId:result.body.requestId,
            status:'delivery_uncertain',
            accepted:0,
            rejected:0,
            retryAfterMs:1_000
        });
        assert.equal(Object.hasOwn(result.body,'providerId'),false);
        assert.equal(Object.hasOwn(result.body,'delivered'),false);
    }
    assert.equal(providerCalls,4);
});

test('provider response reads fail closed and cancellation never blocks',async function testProviderReadBoundaries(t){
    let fallbackTextCalled=false;
    let bodyCancelCalled=false;
    let readerCancelCalled=false;
    const responses=[
        {
            body:{},
            headers:{get:function absentHeader(){return null;}},
            status:200,
            text:function forbiddenUnboundedFallback(){
                fallbackTextCalled=true;
                return Promise.resolve(JSON.stringify({id:ACCEPTED_PROVIDER_ID}));
            }
        },
        {
            body:{
                cancel:function cancelDeclaredOversizeBody(){
                    bodyCancelCalled=true;
                    return new Promise(function neverSettleBodyCancellation(){});
                }
            },
            headers:{
                get:function declaredOversizeHeader(name){
                    return name==='content-length'?'65':null;
                }
            },
            status:200
        },
        {
            body:{
                getReader:function createOversizeReader(){
                    return {
                        cancel:function cancelOversizeReader(){
                            readerCancelCalled=true;
                            return new Promise(function neverSettleReaderCancellation(){});
                        },
                        read:function readOversizeChunk(){
                            return Promise.resolve({
                                done:false,
                                value:new Uint8Array(65)
                            });
                        },
                        releaseLock:function releaseSyntheticReader(){}
                    };
                }
            },
            headers:{get:function absentStreamHeader(){return null;}},
            status:200
        }
    ];
    const instance=await startGateway(t,{
        fetchImpl:function returnSyntheticProviderBody(){
            return Promise.resolve(responses.shift());
        },
        maxProviderResponseBytes:64
    });
    for(let index=0;index<3;index+=1){
        const result=await within(requestMail(instance,{
            reportKey:`provider-read-boundary-${String(index).padStart(4,'0')}`
        }));
        assert.equal(result.response.status,207);
        assert.equal(result.body.status,'delivery_uncertain');
    }
    assert.equal(fallbackTextCalled,false);
    assert.equal(bodyCancelCalled,true);
    assert.equal(readerCancelCalled,true);
});

test('provider timeout cancels the one attempt and returns an ambiguous result',async function testProviderTimeout(t){
    let providerCalls=0;
    let providerAborted=false;
    const instance=await startGateway(t,{
        fetchImpl:function waitForProviderCancellation(url,options){
            providerCalls+=1;
            return new Promise(function waitForAbort(resolve,reject){
                options.signal.addEventListener('abort',function rejectOnAbort(){
                    providerAborted=true;
                    reject(options.signal.reason);
                },{once:true});
            });
        },
        providerTimeoutMs:100
    });
    const result=await requestMail(instance,{reportKey:'provider-timeout-key-0001'});
    assert.equal(result.response.status,207);
    assert.equal(result.body.status,'delivery_uncertain');
    assert.equal(providerCalls,1);
    assert.equal(providerAborted,true);
});

test('bounded send concurrency rejects excess work without a provider attempt',async function testSendBackpressure(t){
    const entered=deferred();
    const release=deferred();
    let providerCalls=0;
    const instance=await startResendMailServer(gatewayOptions({
        fetchImpl:function holdFirstProviderAttempt(url,options){
            providerCalls+=1;
            entered.resolve();
            return new Promise(function waitForRelease(resolve,reject){
                function finishAccepted(){
                    options.signal.removeEventListener('abort',finishAborted);
                    resolve(jsonResponse({id:ACCEPTED_PROVIDER_ID}));
                }
                function finishAborted(){
                    reject(options.signal.reason);
                }
                options.signal.addEventListener('abort',finishAborted,{once:true});
                release.promise.then(finishAccepted,reject);
            });
        },
        maxConcurrentSends:1,
        maxQueuedSends:0
    }));
    t.after(async function releaseAndCloseGateway(){
        release.resolve();
        await instance.close();
    });
    const first=requestMail(instance,{reportKey:'backpressure-first-key-0001'});
    await entered.promise;
    const second=await requestMail(instance,{reportKey:'backpressure-second-key-0002'});
    assert.equal(second.response.status,503);
    assert.equal(second.body.error.code,'mail_send_backpressure');
    assert.equal(second.body.error.retryable,true);
    assert.equal(second.body.error.uncertain,false);
    assert.equal(providerCalls,1);
    release.resolve();
    const accepted=await first;
    assert.equal(accepted.response.status,202);
});

test('queued message bytes are bounded and released on dequeue and cancellation',async function testQueuedByteBackpressure(t){
    const entered=[deferred(),deferred(),deferred()];
    const releases=[deferred(),deferred(),deferred()];
    const cancelledCompletion=deferred();
    let awaitCancelledCompletion=false;
    let providerCalls=0;
    const report=validReport({text:'Synthetic queued byte budget body.'});
    const queuedBodyBytes=Buffer.byteLength(JSON.stringify({
        from:FROM,
        to:[ALLOWED_RECIPIENT],
        subject:report.subject,
        text:report.text
    }));
    const instance=await startResendMailServer(gatewayOptions({
        fetchImpl:function holdSyntheticProviderAttempt(url,options){
            const index=providerCalls;
            providerCalls+=1;
            entered[index].resolve();
            return new Promise(function waitForSyntheticRelease(resolve,reject){
                function finishAccepted(){
                    options.signal.removeEventListener('abort',finishAborted);
                    resolve(jsonResponse({id:ACCEPTED_PROVIDER_ID}));
                }
                function finishAborted(){
                    reject(options.signal.reason);
                }
                options.signal.addEventListener('abort',finishAborted,{once:true});
                releases[index].promise.then(finishAccepted,reject);
            });
        },
        maxConcurrentSends:1,
        maxQueuedMessageBytes:queuedBodyBytes,
        maxQueuedSends:2,
        onEvent:function observeCancelledQueuedRequest(event){
            if(awaitCancelledCompletion&&event.type==='mail.request.completed'
                &&event.providerAttempted===false){
                cancelledCompletion.resolve();
            }
        }
    }));
    t.after(async function releaseAndCloseByteBoundGateway(){
        for(const release of releases){release.resolve();}
        await instance.close();
    });

    const first=requestMail(instance,{
        body:report,
        reportKey:'byte-budget-first-key-0001'
    });
    await entered[0].promise;
    const second=requestMail(instance,{
        body:report,
        reportKey:'byte-budget-second-key-0002'
    });
    await new Promise(function admitSecondQueueItem(resolve){setImmediate(resolve);});
    const third=await requestMail(instance,{
        body:report,
        reportKey:'byte-budget-third-key-0003'
    });
    assert.equal(third.response.status,503);
    assert.equal(third.body.error.code,'mail_send_byte_backpressure');
    assert.equal(providerCalls,1);

    releases[0].resolve();
    await entered[1].promise;
    assert.equal((await first).response.status,202);

    const fourthController=new AbortController();
    const fourth=requestMail(instance,{
        body:report,
        reportKey:'byte-budget-fourth-key-0004',
        signal:fourthController.signal
    }).catch(function absorbCancelledClientRequest(){return null;});
    await new Promise(function admitFourthQueueItem(resolve){setImmediate(resolve);});
    const fifth=await requestMail(instance,{
        body:report,
        reportKey:'byte-budget-fifth-key-0005'
    });
    assert.equal(fifth.response.status,503);
    assert.equal(fifth.body.error.code,'mail_send_byte_backpressure');
    awaitCancelledCompletion=true;
    fourthController.abort(new Error('Synthetic queued request cancellation.'));
    await fourth;
    await within(cancelledCompletion.promise);

    const sixth=requestMail(instance,{
        body:report,
        reportKey:'byte-budget-sixth-key-0006'
    });
    await new Promise(function admitSixthQueueItem(resolve){setImmediate(resolve);});
    releases[1].resolve();
    await entered[2].promise;
    assert.equal((await second).response.status,202);
    releases[2].resolve();
    assert.equal((await sixth).response.status,202);
    assert.equal(providerCalls,3);
});

test('declared request and provider response sizes are bounded',async function testByteBounds(t){
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function countProviderAttempts(){
            providerCalls+=1;
            return defaultFetch();
        },
        maxMessageBytes:1,
        maxRequestBytes:257
    });
    const serialized=JSON.stringify(validReport({text:'x'.repeat(300)}));
    const result=await rawRequest(instance,{
        body:serialized,
        headers:{
            'Content-Length':String(Buffer.byteLength(serialized)),
            'Content-Type':'application/json',
            'Host':`127.0.0.1:${String(instance.port)}`,
            'Idempotency-Key':'request-size-key-0001',
            'Origin':ALLOWED_ORIGIN,
            'X-Mail-App':APP_ID,
            'X-Mail-Key':APP_KEY
        }
    });
    assert.equal(result.statusCode,413);
    assert.equal(result.body.error.code,'mail_request_too_large');
    assert.equal(providerCalls,0);
});

test('closing the gateway aborts active provider work and drains lifecycle',async function testCancellationAndDrain(t){
    const entered=deferred();
    const providerAborted=deferred();
    const instance=await startResendMailServer(gatewayOptions({
        fetchImpl:function holdProviderUntilClose(url,options){
            entered.resolve();
            return new Promise(function waitForClose(resolve,reject){
                options.signal.addEventListener('abort',function rejectClosedProvider(){
                    providerAborted.resolve();
                    reject(options.signal.reason);
                },{once:true});
            });
        }
    }));
    t.after(function ensureGatewayClosed(){return instance.close();});
    const request=requestMail(instance,{reportKey:'close-cancellation-key-0001'});
    await entered.promise;
    const firstClose=instance.close();
    const secondClose=instance.close();
    assert.equal(firstClose,secondClose);
    await providerAborted.promise;
    const result=await request;
    assert.equal(result.response.status,207);
    assert.equal(result.body.status,'delivery_uncertain');
    await firstClose;
    await instance.lifecycle;
});
