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
    const result=await sendResendMail(options({
        fetchImpl:async function captureAttempt(url,request){
            calls+=1;
            assert.equal(url,'https://api.resend.com/emails');
            assert.equal(request.headers.Authorization,`Bearer ${SECRET}`);
            assert.equal(request.headers['Idempotency-Key'],'synthetic-report-key-0001');
            assert.deepEqual(JSON.parse(request.body),{
                from:'sender@example.test',
                to:['recipient@example.test'],
                subject:'Synthetic report',
                text:'Synthetic body.'
            });
            return response({id:'provider-id-0001'});
        }
    }));
    assert.equal(calls,1);
    assert.equal(result.provider,'resend');
    assert.equal(result.status,'accepted');
    assert.equal(result.classification,'accepted');
    assert.equal(result.requestId,'synthetic-request-0001');
    assert.equal(result.providerStatus,200);
    assert.equal(result.recipientCount,1);
    assert.equal(result.providerId,'provider-id-0001');
    assert.deepEqual(result.providerResponse,{id:'provider-id-0001'});
    assert.deepEqual(result.report,REPORT);
    assert.deepEqual(result.providerRequest,{
        from:'sender@example.test',
        to:['recipient@example.test'],
        subject:'Synthetic report',
        text:'Synthetic body.'
    });
    assert.equal(Object.isFrozen(result),false);
    assert.equal(JSON.stringify(result).includes(SECRET),false);
    assert.equal(JSON.stringify(result).includes('recipient@example.test'),true);
});

test('direct send requires explicit recipients and a safe caller key before fetch',async function(){
    let calls=0;
    const fetchImpl=async()=>{calls+=1;return response({id:'unused'});};
    await assert.rejects(sendResendMail(options({
        fetchImpl,report:{...REPORT,to:[]}
    })),/mail_recipients_required/u);
    await assert.rejects(sendResendMail(options({
        fetchImpl,reportKey:'unsafe key'
    })),/reportKey/u);
    assert.equal(calls,0);
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
});

test('transport failure and in-flight abort are ambiguous after one attempt',async function(){
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
    assert.equal(JSON.stringify([transport,aborted]).includes('private'),true);
    assert.equal(JSON.stringify([transport,aborted]).includes(SECRET),false);
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
