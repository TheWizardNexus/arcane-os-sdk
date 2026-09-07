import assert from 'node:assert/strict';
import test from '../src/testing.mjs';

import {sendResendMail} from '../src/mail-server.mjs';

const SECRET='re_synthetic_secret_value';
const REPORT={
    type:'report',
    to:['recipient@example.test'],
    subject:'Synthetic report',
    text:'Synthetic body.'
};

function response(value,{status=200,headers={}}={}){
    return new Response(JSON.stringify(value),{status,headers});
}

function options(overrides={}){
    return {
        apiKey:SECRET,
        appId:'mail-test',
        from:'sender@example.test',
        report:REPORT,
        reportKey:'synthetic-report-key-0001',
        requestIdFactory:()=> 'synthetic-request-0001',
        ...overrides
    };
}

test('one-shot send accepts once and returns the complete mutable result',async function(){
    let calls=0;
    const providerResponse={
        id:'provider id / 0001',
        detail:{apiKey:'ordinary response field',appKey:'ordinary application field'},
        messages:['Complete provider response','Second provider message']
    };
    const result=await sendResendMail(options({
        appId:'BOSS & TWiN / EU',
        from:'Sender Name <Sender+Reports@example.test>',
        fetchImpl:async function captureAttempt(url,request){
            calls+=1;
            assert.equal(url,'https://api.resend.com/emails');
            assert.equal(request.headers.Authorization,`Bearer ${SECRET}`);
            assert.equal(request.headers['Idempotency-Key'],'synthetic-report-key-0001');
            assert.deepEqual(JSON.parse(request.body),{
                from:'Sender Name <Sender+Reports@example.test>',
                to:['recipient@example.test'],
                subject:'Synthetic report',
                text:'Synthetic body.'
            });
            return response(providerResponse);
        }
    }));
    assert.equal(calls,1);
    assert.equal(result.provider,'resend');
    assert.equal(result.status,'accepted');
    assert.equal(result.classification,'accepted');
    assert.equal(result.requestId,'synthetic-request-0001');
    assert.equal(result.providerStatus,200);
    assert.equal(result.recipientCount,1);
    assert.equal(result.providerId,providerResponse.id);
    assert.deepEqual(result.providerResponse,providerResponse);
    assert.deepEqual(result.report,REPORT);
    assert.deepEqual(result.providerRequest,{
        from:'Sender Name <Sender+Reports@example.test>',
        to:['recipient@example.test'],
        subject:'Synthetic report',
        text:'Synthetic body.'
    });
    assert.equal(Object.isFrozen(result),false);
    assert.equal(JSON.stringify(result).includes(SECRET),false);
    assert.equal(JSON.stringify(result).includes('recipient@example.test'),true);
});

test('direct send preserves template fields and leaves recipient decisions to the provider',async function(){
    let calls=0;
    const report={
        from:'Report Sender <Sender@example.test>',
        to:[],
        template:{id:'receipt-template',variables:{customer:'Exact customer value'}},
        metadata:{apiKey:'ordinary report field',appKey:'ordinary application field'}
    };
    const reportKey='report 2026/09#1';
    const providerDetail={name:'validation_error',message:'The provider requires a recipient.'};
    const result=await sendResendMail(options({
        appId:undefined,
        from:undefined,
        report,
        reportKey,
        fetchImpl:async function rejectEmptyRecipients(_url,request){
            calls+=1;
            assert.equal(request.headers['Idempotency-Key'],reportKey);
            assert.deepEqual(JSON.parse(request.body),report);
            return response(providerDetail,{status:422});
        }
    }));
    assert.equal(calls,1);
    assert.equal(result.classification,'permanent');
    assert.equal(result.providerStatus,422);
    assert.equal(result.report,report);
    assert.deepEqual(result.providerRequest,report);
    assert.deepEqual(result.details,providerDetail);
});

test('pre-attempt cancellation makes no provider request',async function(){
    const controller=new AbortController();
    controller.abort(new Error('private caller reason'));
    let calls=0;
    await assert.rejects(sendResendMail(options({
        signal:controller.signal,
        fetchImpl:async()=>{calls+=1;return response({id:'unused'});}
    })),error=>error.code==='ARCANE_CANCELLED'
        &&error.cause?.message==='private caller reason');
    assert.equal(calls,0);
});

test('provider rejection classifications preserve complete provider detail',async function(){
    const retryable=await sendResendMail(options({
        fetchImpl:async()=>response(
            {name:'rate_limit_exceeded',message:'private provider detail'},
            {status:429,headers:{'retry-after':'2'}}
        )
    }));
    assert.equal(retryable.provider,'resend');
    assert.equal(retryable.status,'rejected');
    assert.equal(retryable.classification,'retryable');
    assert.equal(retryable.requestId,'synthetic-request-0001');
    assert.equal(retryable.providerStatus,429);
    assert.equal(retryable.code,'rate_limit_exceeded');
    assert.equal(retryable.retryAfterMs,2000);
    assert.equal(retryable.retryable,true);
    assert.equal(retryable.uncertain,false);
    assert.deepEqual(retryable.details,{
        name:'rate_limit_exceeded',
        message:'private provider detail'
    });
    const permanent=await sendResendMail(options({
        fetchImpl:async()=>response({name:'validation_error',message:'private'}, {status:400})
    }));
    assert.equal(permanent.classification,'permanent');
    assert.equal(permanent.retryable,false);
    assert.equal(JSON.stringify([retryable,permanent]).includes('private'),true);
    assert.equal(JSON.stringify([retryable,permanent]).includes(SECRET),false);

    for(const providerDetail of [
        ['first provider detail',{message:'second provider detail'}],
        'complete provider string',
        429,
        false,
        null
    ]){
        const result=await sendResendMail(options({
            fetchImpl:async function rejectWithCompleteValue(){
                return response(providerDetail,{status:422});
            }
        }));
        assert.equal(result.classification,'permanent');
        assert.deepEqual(result.details,providerDetail);
    }
    const providerText='First provider line\nSecond provider line: complete non-JSON response';
    const plainText=await sendResendMail(options({
        fetchImpl:async function rejectWithPlainText(){
            return new Response(providerText,{status:422});
        }
    }));
    assert.equal(plainText.classification,'permanent');
    assert.equal(plainText.details,providerText);
});

test('transport failure, in-flight abort, and a provider deadline remain ambiguous after one attempt',async function(){
    let calls=0;
    const transport=await sendResendMail(options({
        fetchImpl:async()=>{calls+=1;throw new Error('private network detail');}
    }));
    assert.equal(transport.classification,'ambiguous');
    assert.equal(transport.uncertain,true);
    assert.equal(transport.providerStatus,0);

    const controller=new AbortController();
    const pending=sendResendMail(options({
        signal:controller.signal,
        fetchImpl:function waitForAbort(url,request){
            calls+=1;
            controller.abort(new Error('private cancellation reason'));
            return Promise.reject(request.signal.reason);
        }
    }));
    const aborted=await pending;
    assert.equal(aborted.classification,'ambiguous');
    assert.equal(aborted.code,'resend_transport_uncertain');
    assert.equal(calls,2);

    let providerSignal;
    const expired=await sendResendMail(options({
        providerTimeoutMs:1,
        fetchImpl:function leaveProviderRequestPending(_url,request){
            calls+=1;
            providerSignal=request.signal;
            return new Promise(function waitForProvider(){});
        }
    }));
    assert.equal(expired.classification,'ambiguous');
    assert.equal(expired.code,'resend_timeout');
    assert.equal(expired.uncertain,true);
    assert.equal(providerSignal.aborted,true);
    assert.equal(calls,3);
    assert.equal(JSON.stringify([transport,aborted,expired]).includes('private'),true);
    assert.equal(JSON.stringify([transport,aborted,expired]).includes(SECRET),false);
});

test('a valid accepted response wins over a late abort',async function(){
    const controller=new AbortController();
    const result=await sendResendMail(options({
        signal:controller.signal,
        fetchImpl:async function acceptThenAbort(){
            const accepted=response({id:'provider-id-late-abort'});
            setImmediate(()=>controller.abort(new Error('late abort')));
            return accepted;
        }
    }));
    assert.equal(result.classification,'accepted');
    assert.equal(result.providerId,'provider-id-late-abort');
});
