import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ERROR_CODES} from '../src/errors.mjs';
import {
    RESEND_CREDENTIAL_TARGET_PREFIX,
    deleteMailCredential,
    getMailCredentialStatus,
    mailCredentialTarget,
    readMailCredential,
    setMailCredential,
    validateMailCredentialProfile
} from '../src/mail-credentials.mjs';
import {test} from '../src/testing.mjs';

const WINDOWS_OPTIONS=Object.freeze({
    platform:'win32',
    systemRoot:'C:\\Windows',
    temporaryDirectory:'C:\\Users\\arcane-test\\AppData\\Local\\Temp'
});

function syntheticSecret(){
    return `re_test_${randomBytes(24).toString('hex')}`;
}

function snapshotInvocation(invocation){
    return {
        executable:invocation.executable,
        args:[...invocation.args],
        spawnOptions:{
            ...invocation.spawnOptions,
            env:{...invocation.spawnOptions.env},
            stdio:[...invocation.spawnOptions.stdio]
        },
        stdin:invocation.stdin,
        timeoutMs:invocation.timeoutMs
    };
}

function createRunner(response,calls=[]){
    async function runCredentialProcess(invocation){
        const snapshot=snapshotInvocation(invocation);
        calls.push(snapshot);
        const request=JSON.parse(snapshot.stdin);
        const value=typeof response==='function'?await response(request):response;
        return Buffer.from(JSON.stringify(value),'utf8');
    }
    return {calls,runner:runCredentialProcess};
}

function assertSecretAbsent(secret,value){
    assert.equal(JSON.stringify(value).includes(secret),false);
}

function assertStableError(error,code,secret){
    assert.equal(error.code,code);
    assert.equal(error.cause,undefined);
    assert.equal(String(error.stack??error).includes(secret),false);
    assertSecretAbsent(secret,{
        name:error.name,
        code:error.code,
        message:error.message,
        details:error.details
    });
}

test('mail credential profiles produce the fixed Resend target namespace',function profileTarget(){
    assert.equal(RESEND_CREDENTIAL_TARGET_PREFIX,'ArcaneOSSDK/mail/resend/');
    assert.equal(validateMailCredentialProfile('default'),'default');
    assert.equal(validateMailCredentialProfile('production.us_1'),'production.us_1');
    assert.equal(mailCredentialTarget('default'),'ArcaneOSSDK/mail/resend/default');

    for(const profile of ['', 'Default', '.default', 'default.', 'mail/resend', 'a'.repeat(65)]){
        assert.throws(
            function invalidProfile(){
                validateMailCredentialProfile(profile);
            },
            function isUsageError(error){
                return error.code===ERROR_CODES.usage;
            }
        );
    }
});

test('setMailCredential places the key only in bounded child stdin',async function setCredential(){
    const secret=syntheticSecret();
    const harness=createRunner({ok:true,configured:true});
    const result=await setMailCredential({
        profile:'default',
        secret,
        ...WINDOWS_OPTIONS,
        runner:harness.runner
    });

    assert.deepEqual(result,{
        profile:'default',
        provider:'resend',
        storage:'windows-credential-manager',
        exists:true
    });
    assert.equal(harness.calls.length,1);
    const invocation=harness.calls[0];
    const request=JSON.parse(invocation.stdin);
    assert.equal(request.operation,'set');
    assert.equal(request.target,'ArcaneOSSDK/mail/resend/default');
    assert.equal(Buffer.from(request.secret,'base64').toString('utf8'),secret);
    assert.equal(invocation.stdin.includes(secret),false);
    assert.deepEqual(invocation.spawnOptions.env,{
        SystemRoot:'C:\\Windows',
        WINDIR:'C:\\Windows',
        TEMP:'C:\\Users\\arcane-test\\AppData\\Local\\Temp',
        TMP:'C:\\Users\\arcane-test\\AppData\\Local\\Temp'
    });
    assert.equal(invocation.spawnOptions.shell,false);
    assert.equal(invocation.spawnOptions.windowsHide,true);
    assert.deepEqual(invocation.spawnOptions.stdio,['pipe','pipe','pipe']);
    assertSecretAbsent(secret,{
        executable:invocation.executable,
        args:invocation.args,
        spawnOptions:invocation.spawnOptions,
        result
    });
});

test('readMailCredential returns a key only to its direct caller',async function readCredential(){
    const secret=syntheticSecret();
    const harness=createRunner(function readResponse(request){
        assert.equal(request.operation,'read');
        assert.equal(Object.hasOwn(request,'secret'),false);
        return {
            ok:true,
            found:true,
            secret:Buffer.from(secret,'utf8').toString('base64')
        };
    });
    const value=await readMailCredential({
        profile:'default',
        ...WINDOWS_OPTIONS,
        runner:harness.runner
    });

    assert.equal(value,secret);
    assert.equal(harness.calls.length,1);
    assertSecretAbsent(secret,{
        executable:harness.calls[0].executable,
        args:harness.calls[0].args,
        spawnOptions:harness.calls[0].spawnOptions,
        stdin:harness.calls[0].stdin
    });

    const missing=createRunner({ok:true,found:false});
    assert.equal(await readMailCredential({
        profile:'default',
        ...WINDOWS_OPTIONS,
        runner:missing.runner
    }),null);
});

test('status and delete expose only sanitized credential records',async function statusAndDelete(){
    const status=createRunner({ok:true,configured:true});
    assert.deepEqual(await getMailCredentialStatus({
        profile:'production',
        ...WINDOWS_OPTIONS,
        runner:status.runner
    }),{
        profile:'production',
        provider:'resend',
        storage:'windows-credential-manager',
        exists:true
    });

    const remove=createRunner({ok:true,deleted:true,configured:false});
    assert.deepEqual(await deleteMailCredential({
        profile:'production',
        ...WINDOWS_OPTIONS,
        runner:remove.runner
    }),{
        profile:'production',
        provider:'resend',
        storage:'windows-credential-manager',
        exists:false
    });
});

test('credential storage fails closed before invoking a runner off Windows',async function nonWindows(){
    let invoked=false;
    async function unexpectedRunner(){
        invoked=true;
        return Buffer.from('{}','utf8');
    }
    await assert.rejects(
        getMailCredentialStatus({
            profile:'default',
            platform:'linux',
            systemRoot:'/',
            runner:unexpectedRunner
        }),
        function isUnavailable(error){
            return error.code===ERROR_CODES.targetUnavailable;
        }
    );
    assert.equal(invoked,false);
});

test('credential cancellation never exposes its reason or invokes the runner',async function cancelled(){
    const secret=syntheticSecret();
    const controller=new AbortController();
    controller.abort(secret);
    let invoked=false;
    async function unexpectedRunner(){
        invoked=true;
        return Buffer.from('{}','utf8');
    }
    let caught;
    try{
        await getMailCredentialStatus({
            profile:'default',
            ...WINDOWS_OPTIONS,
            runner:unexpectedRunner,
            signal:controller.signal
        });
    }catch(error){
        caught=error;
    }
    assertStableError(caught,ERROR_CODES.cancelled,secret);
    assert.equal(invoked,false);
});

test('credential operation errors discard runner details',async function sanitizedFailure(){
    const secret=syntheticSecret();
    async function failingRunner(){
        const error=new Error(`Synthetic child failure included ${secret}`);
        error.code=ERROR_CODES.usage;
        throw error;
    }
    let caught;
    try{
        await setMailCredential({
            profile:'default',
            secret,
            ...WINDOWS_OPTIONS,
            runner:failingRunner
        });
    }catch(error){
        caught=error;
    }
    assertStableError(caught,ERROR_CODES.operationFailed,secret);
});

test('credential input and output limits fail before exposing data',async function boundedData(){
    let invoked=false;
    async function unexpectedRunner(){
        invoked=true;
        return Buffer.from('{}','utf8');
    }
    await assert.rejects(
        setMailCredential({
            profile:'default',
            secret:'x'.repeat(2_561),
            ...WINDOWS_OPTIONS,
            runner:unexpectedRunner
        }),
        function isUsageError(error){
            return error.code===ERROR_CODES.usage;
        }
    );
    assert.equal(invoked,false);

    const oversized=createRunner({ok:true,padding:'x'.repeat(8_193)});
    await assert.rejects(
        getMailCredentialStatus({
            profile:'default',
            ...WINDOWS_OPTIONS,
            runner:oversized.runner
        }),
        function isOperationError(error){
            return error.code===ERROR_CODES.operationFailed;
        }
    );
});
