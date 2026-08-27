import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {
    MailTransportError,
    sendMailReport,
    serializeMailReport,
} from '../runtime/arcane/modules/MailTransport.mjs';

const REPORT_KEY='mail-00000000-0000-4000-8000-000000000001.json';

function jsonResponse(body,{headers={},status=202}={}){
    return new Response(JSON.stringify(body),{
        status,
        headers:{'content-type':'application/json',...headers},
    });
}

function baseRequest(overrides={}){
    return {
        appName:'mail-test',
        endpoint:'http://127.0.0.1:8025/v1/mail',
        report:{subject:'Synthetic test',text:'No external delivery.',to:['test@example.com'],type:'report'},
        reportKey:REPORT_KEY,
        requestTimeout:5_000,
        ...overrides,
    };
}

test('MailTransport sends the immutable serialized body and exposes accepted provider identity',async function acceptedMailTransport(){
    const report=baseRequest().report;
    const serializedReport=serializeMailReport(report);
    let observed;
    const result=await sendMailReport(baseRequest({
        report,
        serializedReport,
        fetchImpl:async function captureMailRequest(url,options){
            observed={url,options};
            return jsonResponse({
                requestId:'00000000-0000-4000-8000-000000000002',
                status:'accepted',
                accepted:1,
                rejected:0,
                providerId:'00000000-0000-4000-8000-000000000003',
            });
        },
    }));

    assert.equal(observed.url,'http://127.0.0.1:8025/v1/mail');
    assert.equal(observed.options.body,serializedReport);
    assert.equal(observed.options.headers['Idempotency-Key'],REPORT_KEY);
    assert.equal(result.sent,true);
    assert.equal(result.uncertain,false);
    assert.equal(result.providerId,'00000000-0000-4000-8000-000000000003');
});

test('MailTransport rejects a changed report paired with an immutable serialized body',async function changedMailPayload(){
    const report=baseRequest().report;
    const serializedReport=serializeMailReport(report);
    await assert.rejects(
        sendMailReport(baseRequest({
            report:{...report,subject:'Changed'},
            serializedReport,
            fetchImpl:async function unreachableFetch(){
                throw new Error('fetch must not run');
            },
        })),
        /does not match its immutable serialized request body/u
    );
});

test('MailTransport distinguishes permanent and retryable idempotency conflicts',async function idempotencyConflicts(){
    await assert.rejects(
        sendMailReport(baseRequest({
            fetchImpl:async function changedPayloadConflict(){
                return jsonResponse({error:{code:'invalid_idempotent_request'}},{status:409});
            },
        })),
        function validatePermanentConflict(error){
            assert.ok(error instanceof MailTransportError);
            assert.equal(error.code,'invalid_idempotent_request');
            assert.equal(error.retryable,false);
            assert.equal(error.statusCode,409);
            return true;
        }
    );

    await assert.rejects(
        sendMailReport(baseRequest({
            fetchImpl:async function concurrentConflict(){
                return jsonResponse(
                    {error:{code:'concurrent_idempotent_requests'}},
                    {headers:{'retry-after':'2'},status:409}
                );
            },
        })),
        function validateRetryableConflict(error){
            assert.ok(error instanceof MailTransportError);
            assert.equal(error.code,'concurrent_idempotent_requests');
            assert.equal(error.retryable,true);
            assert.equal(error.retryAfterMs,2_000);
            return true;
        }
    );
});

test('MailTransport reports gateway ambiguity without claiming delivery',async function ambiguousGatewayResponse(){
    const result=await sendMailReport(baseRequest({
        fetchImpl:async function uncertainProviderAttempt(){
            return jsonResponse({
                requestId:'00000000-0000-4000-8000-000000000004',
                status:'delivery_uncertain',
                accepted:0,
                rejected:0,
                retryAfterMs:1_000,
            },{status:207});
        },
    }));
    assert.equal(result.sent,false);
    assert.equal(result.uncertain,true);
    assert.equal(result.status,'delivery_uncertain');
    assert.equal(result.retryAfterMs,1_000);
});

test('MailTransport converts an unconfirmed network failure into retryable ambiguity',async function networkAmbiguity(){
    await assert.rejects(
        sendMailReport(baseRequest({
            fetchImpl:async function failedNetwork(){
                throw new TypeError('synthetic network failure');
            },
        })),
        function validateNetworkFailure(error){
            assert.ok(error instanceof MailTransportError);
            assert.equal(error.code,'MAIL_NETWORK_ERROR');
            assert.equal(error.retryable,true);
            assert.equal(error.uncertain,true);
            assert.doesNotMatch(error.message,/synthetic/u);
            return true;
        }
    );
});
