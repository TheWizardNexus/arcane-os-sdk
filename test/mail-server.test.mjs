import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import test from '../src/testing.mjs';
import {temporaryDirectory, useSyntheticTls, writeSyntheticTlsFiles} from './helpers.mjs';
import {
    createResendMailRequestHandler,
    RESEND_MAIL_PATH,
    RESEND_MAIL_SERVER_PROTOCOL,
    startResendMailServer
} from '../src/mail-server.mjs';
import {sendMailReport} from '../runtime/arcane/modules/MailTransport.mjs';

const API_KEY='re_synthetic_gateway_secret';
const SUBSCRIPTION_KEY='synthetic-subscription-key-0001';
const APP_ID='BOSS & TWiN / EU';
const ALLOWED_ORIGIN='https://app.example.test';
const ALLOWED_RECIPIENT='recipient@example.test';
const ERROR_RECIPIENT='errors@example.test';
const FROM='Arcane Mail <sender@example.test>';
const ACCEPTED_PROVIDER_ID='provider id / 49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';

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
        appId:APP_ID,
        errorRecipients:[ERROR_RECIPIENT],
        fetchImpl:defaultFetch,
        from:FROM,
        host:'127.0.0.1',
        port:0,
        recipientAllowlist:[ALLOWED_RECIPIENT,ERROR_RECIPIENT],
        verifySubscription:async function verifySyntheticSubscription({appName,subscriptionKey,signal}){
            assert.equal(signal instanceof AbortSignal,true);
            return appName===APP_ID&&subscriptionKey===SUBSCRIPTION_KEY;
        },
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
    subscriptionKey=SUBSCRIPTION_KEY,
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
        if(subscriptionKey!==null&&!Object.hasOwn(requestHeaders,'Authorization')){
            requestHeaders.Authorization=`Bearer ${subscriptionKey}`;
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

function requestHttp2Mail(client, headers, body = '') {
    return new Promise(
        function collectHttp2MailResponse(resolve, reject) {
            const request = client.request(headers);
            const chunks = [];
            let responseHeaders;
            client.once('error', reject);
            request.once('error', reject);
            request.once(
                'response',
                function captureHttp2MailHeaders(receivedHeaders) {
                    responseHeaders = receivedHeaders;
                }
            );
            request.on(
                'data',
                function collectHttp2MailChunk(chunk) {
                    chunks.push(chunk);
                }
            );
            request.once(
                'end',
                function completeHttp2MailResponse() {
                    client.removeListener('error', reject);
                    try {
                        const text = Buffer.concat(chunks).toString('utf8');
                        resolve(
                            {
                                body: text ? JSON.parse(text) : null,
                                headers: responseHeaders,
                                statusCode: responseHeaders[':status']
                            }
                        );
                    } catch (error) {
                        reject(error);
                    }
                }
            );
            request.end(body);
        }
    );
}

async function settleSoon(promise,timeoutMs=1_000){
    let timer;
    const timeout=new Promise(function createSyntheticDeadline(resolve,reject){
        timer=setTimeout(function rejectSyntheticDeadline(){
            reject(new Error('Synthetic gateway operation did not settle in time.'));
        },timeoutMs);
    });
    try{
        return await Promise.race([promise,timeout]);
    }finally{
        clearTimeout(timer);
    }
}

test('mail gateway rejects deadlines outside the Node timer range before binding',function testTimerConfiguration(){
    const invalidOptions=[
        {bodyTimeoutMs:2_147_483_648},
        {providerTimeoutMs:2_147_483_648}
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
    assert.equal(instance.callerAuthentication,'subscription');
    assert.equal(instance.url,`${instance.origin}${RESEND_MAIL_PATH}`);
    assert.equal(instance.host,'127.0.0.1');
    assert.equal(new URL(instance.origin).protocol, 'http:');
    assert.equal(instance.server.timeout,0);
    assert.equal(instance.closed,instance.lifecycle);
    for(const secretProperty of ['apiKey','subscriptionKey','from','recipientAllowlist','allowedOrigins']){
        assert.equal(Object.hasOwn(instance,secretProperty),false);
    }
    const firstClose=instance.close();
    const secondClose=instance.close();
    assert.equal(firstClose,secondClose);
    await firstClose;
    await instance.lifecycle;
});

test(
    'mail HTTPS requires the complete selected PEM path pair before binding',
    async function testMailTlsPathPair() {
        for (const paths of [{certPath: 'synthetic-cert.pem'}, {keyPath: 'synthetic-key.pem'}]) {
            await assert.rejects(
                startResendMailServer(
                    gatewayOptions(paths)
                ),
                function isMissingMailTlsPath(error) {
                    return error?.code === 'ARCANE_MAIL_CONFIG_INVALID'
                        && error.message.includes('both certPath and keyPath');
                }
            );
        }
    }
);

test(
    'mail delegates HTTPS with HTTP1 fallback and surfaces the selected listener bind failure',
    async function testMailTlsListenerSelection(t) {
        const fixture = useSyntheticTls(t);
        const directory = await temporaryDirectory(t);
        const paths = await writeSyntheticTlsFiles(directory);
        const instance = await startGateway(t, paths);
        // The fixture covers TLS option delegation and listener ownership, not a handshake.
        assert.equal(fixture.options.length, 1);
        assert.equal(fixture.options[0].allowHTTP1, true);
        assert.equal(fixture.options[0].cert.toString(), 'Synthetic certificate input; not a certificate.');
        assert.equal(fixture.options[0].key.toString(), 'Synthetic key input; not a private key.');
        assert.equal(instance.origin, `https://127.0.0.1:${instance.port}`);
        assert.equal(instance.url, `${instance.origin}${RESEND_MAIL_PATH}`);
        assert.equal(instance.server.listening, true);
        assert.equal(Object.hasOwn(instance, 'certPath'), false);
        assert.equal(Object.hasOwn(instance, 'keyPath'), false);

        await assert.rejects(
            startResendMailServer(
                gatewayOptions(
                    {...paths, port: instance.port}
                )
            ),
            function isOccupiedMailTlsPort(error) {
                return error?.code === 'EADDRINUSE'
                    && error.cause?.code === 'EADDRINUSE'
                    && error.message.includes(String(instance.port));
            }
        );
        const accepted = await rawRequest(
            instance,
            {
                body: JSON.stringify(validReport()),
                headers: {
                    'Content-Type': 'application/json',
                    'Idempotency-Key': 'synthetic-tls-listener-report',
                    'Origin': ALLOWED_ORIGIN,
                    'X-Mail-App': APP_ID,
                    'Authorization': `Bearer ${SUBSCRIPTION_KEY}`
                }
            }
        );
        assert.equal(accepted.statusCode, 202);
        assert.equal(accepted.body.providerId, ACCEPTED_PROVIDER_ID);
        await instance.close();
        await instance.lifecycle;
    }
);

test(
    'native HTTP2 mail headers preserve authority CORS, subscription and complete provider content',
    async function testHttp2MailRequestContract(t) {
        const providerCalls = [];
        const requestProtocols = [];
        const handler = createResendMailRequestHandler(
            gatewayOptions(
                {
                    allowedOrigins: [],
                    fetchImpl: function captureHttp2ProviderRequest(url, options) {
                        providerCalls.push(
                            {url, options}
                        );
                        return defaultFetch();
                    }
                }
            )
        );
        // Native cleartext HTTP/2 isolates the request contract from TLS negotiation.
        const server = http2.createServer(
            function dispatchNativeHttp2Mail(request, response) {
                requestProtocols.push(
                    {
                        authority: request.authority,
                        headersDistinct: request.headersDistinct,
                        httpVersionMajor: request.httpVersionMajor
                    }
                );
                handler.handle(request, response);
            }
        );
        let client;
        t.after(
            async function closeNativeHttp2MailFixture() {
                client?.destroy();
                await handler.close();
                await new Promise(
                    function closeNativeMailServer(resolve, reject) {
                        server.close(
                            function nativeMailServerClosed(error) {
                                if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                                    reject(error);
                                    return;
                                }
                                resolve();
                            }
                        );
                    }
                );
            }
        );
        await new Promise(
            function listenForNativeHttp2Mail(resolve, reject) {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', resolve);
            }
        );
        client = http2.connect(`http://127.0.0.1:${server.address().port}`);
        const authority = 'mail.example.test:8025';
        const origin = `https://${authority}`;
        const headers = {
            ':authority': authority,
            ':method': 'POST',
            ':path': RESEND_MAIL_PATH,
            'authorization': `Bearer ${SUBSCRIPTION_KEY}`,
            'content-type': 'application/json',
            'idempotency-key': 'one exact, comma-containing report key',
            'origin': origin,
            'x-mail-app': APP_ID
        };
        const report = validReport(
            {text: '  Exact HTTP/2 content.\nSecond line stays intact.  '}
        );
        const accepted = await requestHttp2Mail(
            client,
            headers,
            JSON.stringify(report)
        );
        assert.equal(accepted.statusCode, 202);
        assert.equal(accepted.headers['access-control-allow-origin'], origin);
        assert.equal(accepted.body.providerId, ACCEPTED_PROVIDER_ID);
        assert.deepEqual(
            requestProtocols[0],
            {authority, headersDistinct: undefined, httpVersionMajor: 2}
        );
        assert.equal(providerCalls.length, 1);
        assert.equal(providerCalls[0].options.headers['Idempotency-Key'], headers['idempotency-key']);
        assert.deepEqual(
            JSON.parse(providerCalls[0].options.body),
            {from: FROM, to: report.to, subject: report.subject, text: report.text}
        );

        const preflight = await requestHttp2Mail(
            client,
            {':authority': authority, ':method': 'OPTIONS', ':path': RESEND_MAIL_PATH, origin}
        );
        assert.equal(preflight.statusCode, 204);
        assert.equal(preflight.headers['access-control-allow-origin'], origin);
        const missingKey = await requestHttp2Mail(
            client,
            {...headers, 'idempotency-key': ''},
            JSON.stringify(report)
        );
        assert.equal(missingKey.statusCode, 400);
        assert.equal(missingKey.body.error.code, 'mail_invalid_headers');
        const missingSubscription = await requestHttp2Mail(
            client,
            {...headers, authorization: ''},
            JSON.stringify(report)
        );
        assert.equal(missingSubscription.statusCode, 401);
        assert.equal(missingSubscription.body.error.code, 'mail_subscription_required');
        const unrelatedOrigin = await requestHttp2Mail(
            client,
            {...headers, origin: ALLOWED_ORIGIN},
            JSON.stringify(report)
        );
        assert.equal(unrelatedOrigin.statusCode, 403);
        assert.equal(unrelatedOrigin.body.error.code, 'mail_origin_not_allowed');
        assert.equal(providerCalls.length, 1);
    }
);

test('mail gateway verifies the exact incoming application and bearer subscription key',async function testCallerAuthentication(t){
    let authenticatedProviderCalls=0;
    const authenticated=await startGateway(t,{
        appId:'Server diagnostic label / any application',
        fetchImpl:function countAuthenticatedProviderCall(){
            authenticatedProviderCalls+=1;
            return defaultFetch();
        }
    });
    const missing=await requestMail(authenticated,{
        subscriptionKey:null,
        reportKey:'missing-subscription-key-0001'
    });
    assert.equal(missing.response.status,401);
    assert.equal(missing.body.error.code,'mail_subscription_required');
    const mismatch=await requestMail(authenticated,{
        subscriptionKey:'synthetic-wrong-subscription-key-0002',
        reportKey:'wrong-subscription-key-0002'
    });
    assert.equal(mismatch.response.status,401);
    assert.equal(mismatch.body.error.code,'mail_subscription_invalid');
    const otherApplication=await requestMail(authenticated,{
        headers:{'X-Mail-App':'Another application / exact name'},
        reportKey:'other-application-key-0001'
    });
    assert.equal(otherApplication.response.status,401);
    assert.equal(otherApplication.body.error.code,'mail_subscription_invalid');
    const missingApplication=await requestMail(authenticated,{
        headers:{'X-Mail-App':''},
        reportKey:'missing-application-key-0001'
    });
    assert.equal(missingApplication.response.status,400);
    assert.equal(missingApplication.body.error.code,'mail_invalid_headers');
    const malformedAuthorization=await requestMail(authenticated,{
        headers:{Authorization:'Basic synthetic-value'},
        reportKey:'malformed-authorization-key-0001'
    });
    assert.equal(malformedAuthorization.response.status,401);
    assert.equal(malformedAuthorization.body.error.code,'mail_subscription_required');
    const accepted=await requestMail(authenticated,{
        reportKey:'valid-subscription-key-0003'
    });
    assert.equal(accepted.response.status,202);
    assert.equal(authenticatedProviderCalls,1);

    const shortCredential=await startGateway(t,{
        verifySubscription:async function verifyShortSubscription({appName,subscriptionKey}){
            return appName===APP_ID&&subscriptionKey==='x';
        }
    });
    const shortCredentialAccepted=await requestMail(shortCredential,{
        subscriptionKey:'x',
        reportKey:'short-subscription-key'
    });
    assert.equal(shortCredentialAccepted.response.status,202);

    const unavailableVerifier=await startGateway(t,{
        verifySubscription:async function rejectUnavailableVerification(){
            throw new Error('Synthetic subscription service failure');
        },
        fetchImpl:function countProviderCallAfterVerificationFailure(){
            authenticatedProviderCalls+=1;
            return defaultFetch();
        }
    });
    const unavailable=await requestMail(unavailableVerifier,{
        reportKey:'unavailable-subscription-service'
    });
    assert.equal(unavailable.response.status,503);
    assert.equal(unavailable.body.error.code,'mail_subscription_verification_failed');
    assert.equal(unavailable.body.error.retryable,true);
    assert.equal(unavailable.body.error.retryAfterMs,1_000);
    assert.equal(authenticatedProviderCalls,1);

    const nonBooleanVerifier=await startGateway(t,{
        verifySubscription:async function returnNonBooleanVerification(){return {active:true};},
        fetchImpl:function countProviderCallWithoutVerifiedSubscription(){
            authenticatedProviderCalls+=1;
            return defaultFetch();
        }
    });
    const nonBoolean=await requestMail(nonBooleanVerifier,{
        reportKey:'non-boolean-subscription-result'
    });
    assert.equal(nonBoolean.response.status,401);
    assert.equal(nonBoolean.body.error.code,'mail_subscription_invalid');
    assert.equal(authenticatedProviderCalls,1);

    let unauthenticatedProviderCalls=0;
    const unconfiguredGateway=await startGateway(t,{
        verifySubscription:undefined,
        fetchImpl:function countExplicitNoKeyProviderCall(){
            unauthenticatedProviderCalls+=1;
            return defaultFetch();
        }
    });
    assert.equal(
        unconfiguredGateway.callerAuthentication,
        'none'
    );
    const noKeyAccepted=await requestMail(unconfiguredGateway,{
        subscriptionKey:null,
        headers:{'X-Mail-App':''},
        reportKey:'unconfigured-verifier-no-key-0001'
    });
    assert.equal(noKeyAccepted.response.status,202);
    const suppliedKey=await requestMail(unconfiguredGateway,{
        reportKey:'unconfigured-verifier-supplied-key-0002'
    });
    assert.equal(suppliedKey.response.status,202);
    assert.equal(unauthenticatedProviderCalls,2);
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
            'Access-Control-Request-Headers':'content-type, idempotency-key, x-mail-app, authorization',
            'Access-Control-Request-Method':'POST',
            'Origin':ALLOWED_ORIGIN
        },
        method:'OPTIONS'
    });
    assert.equal(accepted.status,204);
    assert.equal(accepted.headers.get('access-control-allow-origin'),ALLOWED_ORIGIN);
    assert.equal(accepted.headers.get('access-control-allow-methods'),'POST, OPTIONS');
    assert.equal(
        accepted.headers.get('access-control-allow-headers'),
        'Content-Type, Idempotency-Key, X-Mail-App, Authorization'
    );
    assert.equal(accepted.headers.get('access-control-allow-credentials'),null);

    const bearerPreflight=await fetch(instance.url,{
        headers:{
            'Access-Control-Request-Headers':'content-type, authorization',
            'Access-Control-Request-Method':'POST',
            'Origin':ALLOWED_ORIGIN
        },
        method:'OPTIONS'
    });
    assert.equal(bearerPreflight.status,204);

    const deniedOrigin=await fetch(instance.url,{
        headers:{
            'Access-Control-Request-Headers':'content-type, idempotency-key, x-mail-app, authorization',
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
        onEvent:function captureCompleteMailEvent(event){events.push(event);}
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
        providerId:ACCEPTED_PROVIDER_ID,
        providerResponse:{id:ACCEPTED_PROVIDER_ID}
    });
    assert.equal(Object.hasOwn(result.body,'delivered'),false);
    assert.match(result.body.requestId,/^[a-zA-Z0-9-]+$/u);
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
    for(const forbiddenValue of [API_KEY,SUBSCRIPTION_KEY]){
        assert.equal(eventText.includes(forbiddenValue),false);
    }
    for(const completeValue of [
        providerKey,
        secretBody,
        FROM,
        ALLOWED_RECIPIENT,
        ACCEPTED_PROVIDER_ID
    ]){
        assert.equal(eventText.includes(completeValue),true);
    }
});

test('MailTransport reaches the configured gateway with one stable provider attempt',async function testTransportGatewayIntegration(t){
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
        subscriptionKey:SUBSCRIPTION_KEY,
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

test('ordinary gateway delivery needs no recipient allowlist and preserves recipient order',async function testFunctionalRecipientDefault(t){
    let providerReport=null;
    const instance=await startGateway(t,{
        errorRecipients:[],
        fetchImpl:function captureFunctionalRecipientRequest(url,options){
            providerReport=JSON.parse(options.body);
            return Promise.resolve(jsonResponse({id:ACCEPTED_PROVIDER_ID}));
        },
        recipientAllowlist:undefined
    });
    const recipients=['outside@example.test','outside@example.test','second@example.test'];
    const result=await requestMail(instance,{
        body:validReport({to:recipients}),
        reportKey:'functional-recipient-default-key'
    });
    assert.equal(result.response.status,202);
    assert.deepEqual(providerReport.to,recipients);
});

test('mail gateway preserves explicit origin and recipient decisions and rejects unreadable JSON',async function testRequestValidation(t){
    let providerCalls=0;
    const instance=await startGateway(t,{
        fetchImpl:function countProviderAttempts(){
            providerCalls+=1;
            return defaultFetch();
        }
    });
    const cases=[
        {
            expectedCode:'mail_origin_not_allowed',
            expectedStatus:403,
            options:{origin:'https://attacker.example.test'}
        },
        {
            expectedCode:'mail_recipient_not_allowed',
            expectedStatus:403,
            options:{body:validReport({to:['outside@example.test']})}
        },
        {
            expectedCode:'mail_recipient_not_allowed',
            expectedStatus:403,
            options:{body:validReport({cc:'outside@example.test'})}
        },
        {
            expectedCode:'mail_recipient_not_allowed',
            expectedStatus:403,
            options:{body:validReport({bcc:[ALLOWED_RECIPIENT,'outside@example.test']})}
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
    const missingRoute=await requestMail(instance,{path:'/not-mail'});
    assert.equal(missingRoute.response.status,404);
    assert.equal(missingRoute.body.error.code,'mail_route_not_found');

    const getRequest=await requestMail(instance,{method:'GET'});
    assert.equal(getRequest.response.status,405);
    assert.equal(getRequest.body.error.code,'mail_method_not_allowed');
    assert.equal(providerCalls,0);
});

test('mail gateway preserves complete subject and body content for the provider',async function testCompleteProviderContent(t){
    let providerReport=null;
    let providerKey=null;
    const instance=await startGateway(t,{
        fetchImpl:async function captureCompleteProviderContent(_url,options){
            providerReport=JSON.parse(options.body);
            providerKey=options.headers['Idempotency-Key'];
            return defaultFetch();
        }
    });
    const report=validReport({
        cc:ALLOWED_RECIPIENT,
        bcc:[ERROR_RECIPIENT,ALLOWED_RECIPIENT],
        subject:'  exact subject\nwith control \u0000 content  ',
        text:'   \n\t\u0000complete body\u007f  '
    });
    const result=await requestMail(instance,{
        body:report,
        headers:{'Content-Type':'text/plain'},
        path:`${RESEND_MAIL_PATH}?source=complete-content`,
        reportKey:'complete provider/content #1'
    });
    assert.equal(result.response.status,202);
    assert.equal(result.body.accepted,1);
    assert.equal(providerReport.cc,report.cc);
    assert.deepEqual(providerReport.bcc,report.bcc);
    assert.equal(providerReport.subject,report.subject);
    assert.equal(providerReport.text,report.text);
    assert.equal(providerKey,'complete provider/content #1');

    const templateReport={
        to:[ALLOWED_RECIPIENT],
        template:{id:'template-v2',variables:{name:'Exact recipient name'}},
        metadata:{apiKey:'ordinary report field',appKey:'ordinary application field'}
    };
    const templateResult=await requestMail(instance,{
        body:templateReport,
        reportKey:'template provider/content #2'
    });
    assert.equal(templateResult.response.status,202);
    assert.deepEqual(providerReport,{...templateReport,from:FROM});
});

test('mail CORS defaults to the current request authority without a special host policy',async function testCurrentAuthorityCors(t){
    let providerCalls=0;
    const instance=await startGateway(t,{
        allowedOrigins:undefined,
        fetchImpl:function countProviderAttempts(){
            providerCalls+=1;
            return defaultFetch();
        }
    });
    const serialized=JSON.stringify(validReport());
    for(const origin of ['https://mail.example.test','http://mail.example.test']){
        const result=await rawRequest(instance,{
            body:serialized,
            headers:{
                'Content-Type':'application/json',
                'Host':'mail.example.test',
                'Idempotency-Key':`current-authority ${origin}`,
                'Origin':origin,
                'X-Mail-App':APP_ID,
                'Authorization':`Bearer ${SUBSCRIPTION_KEY}`
            }
        });
        assert.equal(result.statusCode,202);
        assert.equal(result.headers['access-control-allow-origin'],origin);
    }
    const denied=await requestMail(instance,{origin:ALLOWED_ORIGIN});
    assert.equal(denied.response.status,403);
    assert.equal(denied.body.error.code,'mail_origin_not_allowed');
    const noOrigin=await requestMail(instance,{origin:null});
    assert.equal(noOrigin.response.status,202);
    assert.equal(providerCalls,3);
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
        new Response('',{status:409}),
        jsonResponse(['first detail',{message:'second detail'}],{status:422}),
        jsonResponse(false,{status:422}),
        jsonResponse(null,{status:422}),
        new Response('First provider line\nComplete second provider line',{status:422}),
        jsonResponse({name:'Provider Error / exact name',detail:{apiKey:'ordinary field'}},{status:400})
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
        {code:'resend_http_409',retryable:true,status:503,retryAfterMs:1_000,details:''},
        {code:'resend_http_422',retryable:false,status:422,retryAfterMs:0,details:['first detail',{message:'second detail'}]},
        {code:'resend_http_422',retryable:false,status:422,retryAfterMs:0,details:false},
        {code:'resend_http_422',retryable:false,status:422,retryAfterMs:0,details:null},
        {code:'resend_http_422',retryable:false,status:422,retryAfterMs:0,details:'First provider line\nComplete second provider line'},
        {code:'Provider Error / exact name',retryable:false,status:422,retryAfterMs:0,details:{name:'Provider Error / exact name',detail:{apiKey:'ordinary field'}}}
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
        assert.equal(typeof result.body.error.message,'string');
        if(Object.hasOwn(expectation,'details')){
            assert.deepEqual(result.body.error.details,expectation.details);
        }
        if(index===0){
            assert.equal(result.body.error.details.message,'not returned');
        }
    }
    assert.equal(providerCalls,expected.length);
});

test('ambiguous provider outcomes never claim acceptance or delivery',async function testAmbiguousMappings(t){
    const responses=[
        new Error('synthetic transport failure'),
        jsonResponse({}),
        new Response('{invalid json',{status:200}),
        jsonResponse(['complete array',{message:'complete nested value'}]),
        jsonResponse(false),
        jsonResponse(null)
    ];
    const expectedDetails=[
        undefined,
        {},
        '{invalid json',
        ['complete array',{message:'complete nested value'}],
        false,
        null
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
        }
    });
    for(let index=0;index<expectedDetails.length;index+=1){
        const result=await requestMail(instance,{
            reportKey:`ambiguous-result-key-${String(index).padStart(4,'0')}`
        });
        assert.equal(result.response.status,207);
        assert.equal(result.body.requestId.length>0,true);
        assert.equal(result.body.status,'delivery_uncertain');
        assert.equal(result.body.accepted,0);
        assert.equal(result.body.rejected,0);
        assert.equal(result.body.retryAfterMs,1_000);
        assert.equal(Object.hasOwn(result.body,'details'),true);
        assert.equal(Object.hasOwn(result.body,'providerId'),false);
        assert.equal(Object.hasOwn(result.body,'delivered'),false);
        if(index>0){
            assert.deepEqual(result.body.details,expectedDetails[index]);
        }
    }
    assert.equal(providerCalls,expectedDetails.length);
});

test('provider response reads reject unreadable streams and cancellation never blocks',async function testProviderReadBoundaries(t){
    let fallbackTextCalled=false;
    let bodyCancelCalled=false;
    let readerCancelCalled=false;
    const responses=[
        {
            body:{},
            headers:{get:function absentHeader(){return null;}},
            status:200,
            text:function forbiddenFallbackRead(){
                fallbackTextCalled=true;
                return Promise.resolve(JSON.stringify({id:ACCEPTED_PROVIDER_ID}));
            }
        },
        {
            body:{
                cancel:function cancelUnreadableBody(){
                    bodyCancelCalled=true;
                    return new Promise(function neverSettleBodyCancellation(){});
                }
            },
            headers:{get:function absentUnreadableBodyHeader(){return null;}},
            status:200
        },
        {
            body:{
                getReader:function createMalformedReader(){
                    return {
                        cancel:function cancelMalformedReader(){
                            readerCancelCalled=true;
                            return new Promise(function neverSettleReaderCancellation(){});
                        },
                        read:function readMalformedChunk(){
                            return Promise.resolve({
                                done:false,
                                value:'not-a-provider-chunk'
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
        }
    });
    for(let index=0;index<3;index+=1){
        const result=await settleSoon(requestMail(instance,{
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

test('concurrent sends preserve every complete request without SDK count limits',async function testConcurrentCompleteSends(t){
    const entered=[deferred(),deferred(),deferred()];
    const releases=[deferred(),deferred(),deferred()];
    const providerReports=[];
    let providerCalls=0;
    const completeText='Synthetic complete concurrent content.\n'.repeat(4_096);
    const instance=await startResendMailServer(gatewayOptions({
        fetchImpl:function holdSyntheticProviderAttempt(url,options){
            const index=providerCalls;
            providerCalls+=1;
            providerReports.push(JSON.parse(options.body));
            entered[index].resolve();
            return new Promise(function waitForSyntheticRelease(resolve,reject){
                function finishAccepted(){
                    options.signal.removeEventListener('abort',finishAborted);
                    resolve(jsonResponse({id:`${ACCEPTED_PROVIDER_ID}-${String(index)}`}));
                }
                function finishAborted(){
                    reject(options.signal.reason);
                }
                options.signal.addEventListener('abort',finishAborted,{once:true});
                releases[index].promise.then(finishAccepted,reject);
            });
        }
    }));
    t.after(async function releaseAndCloseConcurrentGateway(){
        for(const release of releases){release.resolve();}
        await instance.close();
    });

    const requests=[0,1,2].map(function createConcurrentRequest(index){
        return requestMail(instance,{
            body:validReport({text:`${completeText}${String(index)}`}),
            reportKey:`concurrent-complete-key-${String(index)}`
        });
    });
    await Promise.all(entered.map(function waitForProvider(entry){return entry.promise;}));
    assert.equal(providerCalls,3);
    for(const release of releases){release.resolve();}
    const results=await Promise.all(requests);
    assert.deepEqual(results.map(function responseStatus(entry){return entry.response.status;}),[202,202,202]);
    assert.deepEqual(
        providerReports.map(function completeProviderText(entry){return entry.text;}),
        [0,1,2].map(function expectedCompleteText(index){return `${completeText}${String(index)}`;})
    );
});

test('complete long request and provider response bodies are accepted',async function testCompleteLongBodies(t){
    const requestText='Synthetic complete request content.\n'.repeat(16_384);
    const providerDetail='Synthetic complete provider response content.\n'.repeat(16_384);
    let providerReport=null;
    const instance=await startGateway(t,{
        fetchImpl:function returnCompleteProviderResponse(url,options){
            providerReport=JSON.parse(options.body);
            return jsonResponse({detail:providerDetail,id:ACCEPTED_PROVIDER_ID});
        }
    });
    const result=await requestMail(instance,{
        body:validReport({
            metadata:{complete:'Synthetic provider-neutral extension.'},
            text:requestText
        }),
        reportKey:'complete-long-content-key-0001'
    });
    assert.equal(result.response.status,202);
    assert.equal(result.body.status,'accepted');
    assert.equal(result.body.providerId,ACCEPTED_PROVIDER_ID);
    assert.equal(result.body.providerResponse.detail,providerDetail);
    assert.equal(providerReport.text,requestText);
    assert.deepEqual(providerReport.metadata,{complete:'Synthetic provider-neutral extension.'});
});

test('closing the gateway cancels subscription verification before a provider attempt',async function testVerificationCancellation(t){
    const entered=deferred();
    const verifierAborted=deferred();
    let providerCalls=0;
    const instance=await startResendMailServer(gatewayOptions({
        verifySubscription:function waitForVerificationCancellation({signal}){
            entered.resolve();
            return new Promise(function holdVerification(resolve,reject){
                signal.addEventListener('abort',function rejectCancelledVerification(){
                    verifierAborted.resolve();
                    reject(signal.reason);
                },{once:true});
            });
        },
        fetchImpl:function countProviderAttemptBeforeVerification(){
            providerCalls+=1;
            return defaultFetch();
        }
    }));
    t.after(function ensureVerificationGatewayClosed(){return instance.close();});
    const request=requestMail(instance,{reportKey:'verification-cancellation-key-0001'});
    await entered.promise;
    const closing=instance.close();
    await verifierAborted.promise;
    const result=await request;
    assert.equal(result.response.status,408);
    assert.equal(result.body.error.code,'mail_request_cancelled');
    assert.equal(providerCalls,0);
    await closing;
    await instance.lifecycle;
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
