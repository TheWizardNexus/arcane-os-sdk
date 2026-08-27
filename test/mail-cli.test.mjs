import assert from 'node:assert/strict';
import {Readable,Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {runCli} from '../src/cli/main.mjs';
import {executeMailCommand} from '../src/mail.mjs';

function memoryStream(){
    let value='';
    return {
        stream:new Writable({
            write(chunk,_encoding,callback){
                value+=chunk.toString();
                callback();
            }
        }),
        read:function readMemoryStream(){return value;}
    };
}

function parseNdjson(value){
    return value.trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse);
}

test('mail key set reads a synthetic key only from explicit stdin and never reports it',async function mailKeySet(){
    const secret='re_test_cli_only_000000000000000000000001';
    const stdout=memoryStream();
    const stderr=memoryStream();
    let observedSecret='';
    const exitCode=await runCli([
        'mail','key','set','arcane-dev','--secret-stdin','--output','ndjson'
    ],{
        stdin:Readable.from([`${secret}\n`]),
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeMailKeySet(command,options){
            assert.equal(command,'mail');
            assert.equal(options.action,'key-set');
            assert.equal(options.profile,'arcane-dev');
            assert.equal(options.secretStdin,true);
            assert.equal(typeof options.readSecret,'function');
            observedSecret=await options.readSecret();
            return {
                profile:options.profile,
                provider:'resend',
                storage:'windows-credential-manager',
                exists:true
            };
        }
    });

    assert.equal(exitCode,0,stderr.read());
    assert.equal(observedSecret,secret);
    assert.equal(stdout.read().includes(secret),false);
    assert.equal(stderr.read().includes(secret),false);
    const events=parseNdjson(stdout.read());
    assert.equal(events.at(-1).data.result.profile,'arcane-dev');
    assert.equal(events.at(-1).data.result.exists,true);
});

test('mail key set rejects --secret-stdin on a TTY before reading',async function ttySecretStdin(){
    const secret='re_test_tty_must_never_echo_000000000000000001';
    const stdin=Readable.from([`${secret}\n`]);
    const stdout=memoryStream();
    const stderr=memoryStream();
    let resumed=false;
    const resume=stdin.resume.bind(stdin);
    stdin.isTTY=true;
    stdin.resume=function observeUnexpectedSecretRead(){
        resumed=true;
        return resume();
    };

    const exitCode=await runCli([
        'mail','key','set','arcane-dev','--secret-stdin','--output','ndjson'
    ],{
        stdin,
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function attemptTtyMailKeySet(command,options){
            assert.equal(command,'mail');
            await options.readSecret();
        }
    });

    assert.equal(exitCode,1);
    assert.equal(resumed,false);
    assert.equal(stdout.read().includes(secret),false);
    assert.equal(stderr.read().includes(secret),false);
    const events=parseNdjson(stdout.read());
    assert.match(events.at(-1).data.error.message,/requires redirected or piped input/u);
});

test('mail CLI never reports accidental positional or unknown-option secrets',async function argvPrivacy(){
    const secret='re_test_argv_must_never_be_reported_0000000000001';
    const cases=[
        ['mail','key','set','arcane-dev',secret,'--output','ndjson'],
        ['mail','key','set','arcane-dev',`--secret=${secret}`,'--output','ndjson']
    ];

    for(const argv of cases){
        const stdout=memoryStream();
        const stderr=memoryStream();
        let executed=false;
        const exitCode=await runCli(argv,{
            stdout:stdout.stream,
            stderr:stderr.stream,
            execute:async function rejectUnexpectedMailExecution(){executed=true;}
        });

        assert.equal(exitCode,1);
        assert.equal(executed,false);
        assert.equal(stdout.read().includes(secret),false);
        assert.equal(stderr.read().includes(secret),false);
        const events=parseNdjson(stdout.read());
        assert.equal(events[0].type,'operation.accepted');
        assert.equal(Object.hasOwn(events[0],'data'),false);
        assert.equal(events.at(-1).type,'operation.failed');
    }
});

test('mail key status dispatches a sanitized profile operation',async function mailKeyStatus(){
    const stdout=memoryStream();
    const stderr=memoryStream();
    let invocation;
    const exitCode=await runCli([
        'mail','key','status','arcane-dev','--output','ndjson'
    ],{
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeMailKeyStatus(command,options){
            invocation={command,options};
            return {
                profile:options.profile,
                provider:'resend',
                storage:'windows-credential-manager',
                exists:false
            };
        }
    });

    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocation.command,'mail');
    assert.equal(invocation.options.action,'key-status');
    assert.equal(invocation.options.profile,'arcane-dev');
    assert.equal(Object.hasOwn(invocation.options,'readSecret'),false);
});

test('mail serve admits exact loopback gateway options and reports its lifecycle',async function mailServe(){
    const appKey='synthetic-mail-gateway-app-key-0001';
    const stdout=memoryStream();
    const stderr=memoryStream();
    let invocation;
    const exitCode=await runCli([
        'mail','serve',
        '--profile','arcane-dev',
        '--from','sender@example.com',
        '--app','mail-test',
        '--origin','http://127.0.0.1:8000',
        '--allow-to','first@example.com,second@example.com',
        '--app-key-stdin',
        '--port','8123',
        '--request-timeout','45000',
        '--output','ndjson'
    ],{
        stdin:Readable.from([`${appKey}\n`]),
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeMailServe(command,options){
            invocation={command,options};
            assert.equal(await options.readAppKey(),appKey);
            return {
                target:'mail',
                mode:'mail',
                appId:options.appId,
                host:'127.0.0.1',
                port:8123,
                url:'http://127.0.0.1:8123/v1/mail',
                lifecycle:Promise.resolve(),
                close:async function closeMailServer(){}
            };
        }
    });

    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocation.command,'mail');
    assert.equal(invocation.options.action,'serve');
    assert.equal(invocation.options.profile,'arcane-dev');
    assert.equal(invocation.options.appId,'mail-test');
    assert.equal(invocation.options.origin,'http://127.0.0.1:8000');
    assert.equal(invocation.options.allowTo,'first@example.com,second@example.com');
    assert.equal(invocation.options.appKeyStdin,true);
    assert.equal(invocation.options.port,8123);
    assert.equal(invocation.options.requestTimeout,45_000);
    const events=parseNdjson(stdout.read());
    assert.equal(events.some(function isReady(event){return event.type==='server.ready';}),true);
    assert.equal(events.at(-1).data.result.target,'mail');
});

test('mail serve fails before execution when a required boundary is missing',async function invalidMailServe(){
    const stdout=memoryStream();
    let executed=false;
    const exitCode=await runCli([
        'mail','serve','--profile','arcane-dev','--from','sender@example.com',
        '--app','mail-test','--origin','http://127.0.0.1:8000','--output','ndjson'
    ],{
        stdout:stdout.stream,
        stderr:memoryStream().stream,
        execute:async function unexpectedMailExecution(){executed=true;}
    });
    assert.equal(exitCode,1);
    assert.equal(executed,false);
    assert.match(parseNdjson(stdout.read()).at(-1).data.error.message,/--allow-to/u);
});

test('mail command controller keeps credential values inside the selected operation',async function mailControllerCredentials(){
    const secret='re_test_controller_only_00000000000000000001';
    let storedSecret='';
    const result=await executeMailCommand({
        action:'key-set',
        profile:'arcane-dev',
        readSecret:async function readSyntheticSecret(){return secret;},
        setCredential:async function storeSyntheticSecret(options){
            storedSecret=options.secret;
            return {
                profile:options.profile,
                provider:'resend',
                storage:'windows-credential-manager',
                exists:true
            };
        }
    });
    assert.equal(storedSecret,secret);
    assert.equal(JSON.stringify(result).includes(secret),false);
    assert.equal(result.exists,true);
});

test('mail command controller binds a credential profile to one loopback server configuration',async function mailControllerServe(){
    const secret='re_test_server_only_0000000000000000000001';
    const appKey='synthetic-mail-gateway-app-key-0002';
    let observed;
    const result=await executeMailCommand({
        action:'serve',
        profile:'arcane-dev',
        appId:'mail-test',
        from:'sender@example.com',
        origin:'http://127.0.0.1:8000',
        allowTo:'first@example.com,second@example.com',
        host:'127.0.0.1',
        port:8025,
        requestTimeout:45_000,
        readCredential:async function readSyntheticCredential(){return secret;},
        readAppKey:async function readSyntheticAppKey(){return appKey;},
        startServer:async function startSyntheticMailServer(options){
            observed=options;
            return {
                target:'mail',
                mode:'mail',
                appId:options.appId,
                host:options.host,
                port:options.port,
                url:'http://127.0.0.1:8025/v1/mail',
                lifecycle:Promise.resolve(),
                close:async function closeSyntheticMailServer(){}
            };
        }
    });
    assert.equal(observed.apiKey,secret);
    assert.equal(observed.appKey,appKey);
    assert.deepEqual(observed.allowedOrigins,['http://127.0.0.1:8000']);
    assert.deepEqual(observed.recipientAllowlist,['first@example.com','second@example.com']);
    assert.deepEqual(observed.errorRecipients,observed.recipientAllowlist);
    assert.equal(observed.providerTimeoutMs,45_000);
    assert.equal(JSON.stringify(result).includes(secret),false);
});
