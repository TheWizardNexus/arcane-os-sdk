import assert from 'node:assert/strict';
import path from 'node:path';
import {writeFile} from 'node:fs/promises';
import {Readable,Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {runCli} from '../src/cli/main.mjs';
import {executeMailCommand} from '../src/mail.mjs';
import {executeOperation} from '../src/toolchain.mjs';
import {temporaryDirectory} from './helpers.mjs';

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

async function syntheticMailServerSettings() {
    return {
        apiKey: 're_synthetic',
        certPath: path.resolve('synthetic-mail-certificate.pem'),
        keyPath: path.resolve('synthetic-mail-private-key.pem')
    };
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
                storage:'.env.json',
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

test('mail serve defaults to all interfaces without reading an app key',async function mailServeDefaults(){
    const stdin=Readable.from([]);
    const stdout=memoryStream();
    const stderr=memoryStream();
    let resumed=false;
    const resume=stdin.resume.bind(stdin);
    stdin.isTTY=true;
    stdin.resume=function observeUnexpectedMailInput(){
        resumed=true;
        return resume();
    };

    const exitCode=await runCli([
        'mail','serve',
        '--output','ndjson'
    ],{
        cwd:path.resolve('synthetic-mail-workspace'),
        stdin,
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function startMailWithoutInput(command,options){
            assert.equal(command,'mail');
            assert.equal(options.profile,'mail');
            assert.equal(options.cwd,path.resolve('synthetic-mail-workspace'));
            assert.equal(options.host,'0.0.0.0');
            assert.equal(options.port,8025);
            assert.equal(options.appId,undefined);
            assert.equal(options.from,undefined);
            assert.equal(options.origin,undefined);
            assert.equal(Object.hasOwn(options,'readAppKey'),false);
            return {
                target:'mail',
                mode:'mail',
                host:options.host,
                port:options.port,
                url:'https://0.0.0.0:8025/v1/mail',
                callerAuthentication:'none',
                lifecycle:Promise.resolve(),
                close:async function closeMailServer(){}
            };
        }
    });

    assert.equal(exitCode,0,stderr.read());
    assert.equal(resumed,false);
    assert.equal(stderr.read(),'');
    const ready=parseNdjson(stdout.read()).find(function serverReady(event){
        return event.type==='server.ready';
    });
    assert.equal(ready.data.callerAuthentication,'none');
});

test('mail key status dispatches a sanitized profile operation',async function mailKeyStatus(){
    const stdout=memoryStream();
    const stderr=memoryStream();
    let invocation;
    const exitCode=await runCli([
        'mail','key','status','--output','ndjson'
    ],{
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeMailKeyStatus(command,options){
            invocation={command,options};
            return {
                profile:options.profile,
                provider:'resend',
                storage:'.env.json',
                exists:false
            };
        }
    });

    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocation.command,'mail');
    assert.equal(invocation.options.action,'key-status');
    assert.equal(invocation.options.profile,'mail');
    assert.equal(Object.hasOwn(invocation.options,'readSecret'),false);
});

test('headless toolchain dispatches the mail operation without exposing credentials',async function toolchainMail(){
    const result=await executeOperation('mail',{
        action:'key-status',
        profile:'arcane-dev',
        getCredentialStatus:async function readSyntheticCredentialStatus(options){
            return {
                profile:options.profile,
                provider:'resend',
                storage:'.env.json',
                exists:true
            };
        }
    });

    assert.deepEqual(result,{
        profile:'arcane-dev',
        provider:'resend',
        storage:'.env.json',
        exists:true
    });
});

test('mail serve preserves an explicit host, CORS origin, and diagnostic app label',async function mailServe(){
    const stdout=memoryStream();
    const stderr=memoryStream();
    let invocation;
    const exitCode=await runCli([
        'mail','serve',
        '--profile','arcane-dev',
        '--from','sender@example.com',
        '--app','mail-test',
        '--origin','https://boss.example.com',
        '--host','192.0.2.10',
        '--port','8123',
        '--output','ndjson'
    ],{
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeMailServe(command,options){
            invocation={command,options};
            return {
                target:'mail',
                mode:'mail',
                appId:options.appId,
                host:options.host,
                port:8123,
                url:'https://192.0.2.10:8123/v1/mail',
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
    assert.equal(invocation.options.origin,'https://boss.example.com');
    assert.equal(invocation.options.host,'192.0.2.10');
    assert.equal(invocation.options.allowTo,undefined);
    assert.equal(Object.hasOwn(invocation.options,'readAppKey'),false);
    assert.equal(invocation.options.port,8123);
    assert.equal(invocation.options.requestTimeout,undefined);
    const events=parseNdjson(stdout.read());
    assert.equal(events.some(function isReady(event){return event.type==='server.ready';}),true);
    assert.equal(events.at(-1).data.result.target,'mail');
});

test('mail serve reports the missing JSON setting before opening its listener',async function missingMailKey(){
    const stdout=memoryStream();
    let started=false;
    const exitCode=await runCli([
        'mail','serve','--from','sender@example.com',
        '--app','mail-test','--output','ndjson'
    ],{
        stdout:stdout.stream,
        stderr:memoryStream().stream,
        execute:async function executeMailWithMissingKey(_command,options){
            return executeMailCommand({
                ...options,
                readCredential:async function missingCredential(){return null;},
                readServerSettings:syntheticMailServerSettings,
                startServer:async function unexpectedListener(){started=true;}
            });
        }
    });
    assert.equal(exitCode,1);
    assert.equal(started,false);
    assert.match(parseNdjson(stdout.read()).at(-1).data.error.message,/Missing RESEND_API_KEY in .*\.env\.json/u);
});

test('mail rejects a request timeout outside the Node timer range before execution',async function invalidMailTimeout(){
    const stdout=memoryStream();
    let executed=false;
    const exitCode=await runCli([
        'mail','send',
        '--profile','arcane-dev',
        '--from','sender@example.com',
        '--report-key','synthetic-cli-report-key-timeout',
        '--report-stdin',
        '--request-timeout','2147483648',
        '--output','ndjson'
    ],{
        stdin:Readable.from(['{}']),
        stdout:stdout.stream,
        stderr:memoryStream().stream,
        execute:async function unexpectedMailExecution(){executed=true;}
    });
    assert.equal(exitCode,1);
    assert.equal(executed,false);
    assert.match(parseNdjson(stdout.read()).at(-1).data.error.message,/Node timer range/u);
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
                storage:'.env.json',
                exists:true
            };
        }
    });
    assert.equal(storedSecret,secret);
    assert.equal(JSON.stringify(result).includes(secret),false);
    assert.equal(result.exists,true);
});

test('mail command controller binds a provider profile and preserves explicit recipient configuration',async function mailControllerServe(){
    const secret='re_test_server_only_0000000000000000000001';
    const verifySubscription=async function verifyConfiguredSubscription(){return true;};
    let observed;
    const result=await executeMailCommand({
        action:'serve',
        profile:'arcane-dev',
        appId:'mail-test',
        from:'sender@example.com',
        origin:'https://boss.example.com',
        allowTo:'First@example.com, First@example.com',
        host:'192.0.2.10',
        port:8025,
        requestTimeout:45_000,
        verifySubscription,
        readCredential:async function readSyntheticCredential(){return secret;},
        readServerSettings:syntheticMailServerSettings,
        startServer:async function startSyntheticMailServer(options){
            observed=options;
            return {
                target:'mail',
                mode:'mail',
                appId:options.appId,
                host:options.host,
                port:options.port,
                url:'https://192.0.2.10:8025/v1/mail',
                lifecycle:Promise.resolve(),
                close:async function closeSyntheticMailServer(){}
            };
        }
    });
    assert.equal(observed.apiKey,secret);
    assert.equal(Object.hasOwn(observed,'appKey'),false);
    assert.deepEqual(observed.allowedOrigins,['https://boss.example.com']);
    assert.deepEqual(observed.recipientAllowlist,['First@example.com',' First@example.com']);
    assert.deepEqual(observed.errorRecipients,observed.recipientAllowlist);
    assert.equal(observed.providerTimeoutMs,45_000);
    assert.equal(observed.verifySubscription,verifySubscription);
    assert.equal(observed.certPath,path.resolve('synthetic-mail-certificate.pem'));
    assert.equal(observed.keyPath,path.resolve('synthetic-mail-private-key.pem'));
    assert.equal(JSON.stringify(result).includes(secret),false);
});

test('mail command controller treats an explicit empty recipient list as unrestricted',async function unrestrictedMailControllerServe(){
    let observed;
    await executeMailCommand({
        action:'serve',
        profile:'arcane-dev',
        from:'sender@example.com',
        allowTo:[],
        errorTo:[],
        readCredential:async function readSyntheticCredential(){return 're_synthetic';},
        readServerSettings:syntheticMailServerSettings,
        startServer:async function startSyntheticMailServer(options){
            observed=options;
            return {target:'mail'};
        }
    });
    assert.deepEqual(observed.recipientAllowlist,[]);
    assert.deepEqual(observed.errorRecipients,[]);
    assert.deepEqual(observed.allowedOrigins,[]);
    assert.equal(observed.host,'0.0.0.0');
});

test(
    'mail serve reports both missing TLS settings without binding or exposing the provider key',
    async function missingMailTlsSettings() {
        const secret = 're_synthetic_private';
        let started = false;
        await assert.rejects(
            executeMailCommand(
                {
                    action: 'serve',
                    cwd: path.resolve('synthetic-mail-workspace'),
                    readServerSettings: async function readSettingsWithoutCertificates() {
                        return {apiKey: secret};
                    },
                    startServer: async function unexpectedListener() {
                        started = true;
                    }
                }
            ),
            function inspectMissingTlsSettings(error) {
                assert.equal(error.code, 'ARCANE_PREREQUISITE_MISSING');
                assert.match(error.message, /Missing MAIL_TLS_CERT_PATH, MAIL_TLS_KEY_PATH in .*\.env\.json/u);
                assert.equal(error.message.includes(secret), false);
                return true;
            }
        );
        assert.equal(started, false);
    }
);

test(
    'an injected mail credential remains the credential owner while JSON supplies TLS paths',
    async function injectedCredentialWithJsonTls(context) {
        const cwd = await temporaryDirectory(context);
        await writeFile(
            path.join(cwd, '.env.json'),
            JSON.stringify(
                {
                    RESEND_API_KEY: {unused: 'not-a-provider-key'},
                    MAIL_TLS_CERT_PATH: 'fullchain.pem',
                    MAIL_TLS_KEY_PATH: 'private-key.pem'
                }
            )
        );
        let credentialReads = 0;
        let started;
        await executeMailCommand(
            {
                action: 'serve',
                cwd,
                readCredential: async function readInjectedMailCredential() {
                    credentialReads += 1;
                    return 're_synthetic_injected';
                },
                startServer: async function captureJsonConfiguredMail(options) {
                    started = options;
                    return {target: 'mail'};
                }
            }
        );
        assert.equal(credentialReads, 1);
        assert.equal(started.apiKey, 're_synthetic_injected');
        assert.equal(started.certPath, path.join(cwd, 'fullchain.pem'));
        assert.equal(started.keyPath, path.join(cwd, 'private-key.pem'));
    }
);

test(
    'cancellation during mail settings stops the next credential operation',
    async function cancelledMailSettings() {
        const controller = new AbortController();
        let credentialReads = 0;
        await assert.rejects(
            executeMailCommand(
                {
                    action: 'serve',
                    signal: controller.signal,
                    readServerSettings: async function cancelSettingsRead() {
                        controller.abort();
                        return syntheticMailServerSettings();
                    },
                    readCredential: async function unexpectedCredentialRead() {
                        credentialReads += 1;
                        return 're_synthetic';
                    }
                }
            ),
            {code: 'ARCANE_CANCELLED'}
        );
        assert.equal(credentialReads, 0);
    }
);

test('mail send reads one complete report from stdin and returns complete acceptance detail',async function mailSend(){
    const report={
        subject:'Synthetic CLI acceptance',
        text:'complete synthetic message body',
        to:['recipient@example.com'],
        type:'report'
    };
    const stdout=memoryStream();
    const stderr=memoryStream();
    let invocation;
    const exitCode=await runCli([
        'mail','send',
        '--profile','arcane-dev',
        '--from','sender@example.com',
        '--report-key','synthetic-cli-report-key-0001',
        '--report-stdin',
        '--output','ndjson'
    ],{
        stdin:Readable.from([JSON.stringify(report)]),
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function executeMailSend(command,options){
            invocation={command,options};
            assert.deepEqual(await options.readReport(),report);
            return {
                provider:'resend',
                status:'accepted',
                classification:'accepted',
                requestId:'synthetic-request-0001',
                providerId:'synthetic-provider-0001',
                providerStatus:200,
                recipientCount:1,
                report,
                providerRequest:{...report,from:'sender@example.com'},
                providerResponse:{id:'synthetic-provider-0001'}
            };
        }
    });

    assert.equal(exitCode,0,stderr.read());
    assert.equal(invocation.command,'mail');
    assert.equal(invocation.options.action,'send');
    assert.equal(invocation.options.profile,'arcane-dev');
    assert.equal(invocation.options.from,'sender@example.com');
    assert.equal(invocation.options.reportKey,'synthetic-cli-report-key-0001');
    assert.equal(invocation.options.reportStdin,true);
    assert.equal(invocation.options.requestTimeout,undefined);
    assert.equal(stdout.read().includes(report.text),true);
    assert.equal(stdout.read().includes(report.to[0]),true);
    const events=parseNdjson(stdout.read());
    assert.equal(events[0].type,'operation.accepted');
    assert.equal(events.at(-1).data.result.status,'accepted');
    assert.equal(events.at(-1).data.result.recipientCount,1);
});

test('mail send rejects TTY report input before attaching or resuming stdin',async function ttyMailReport(){
    const privateBody='synthetic body must never be reported';
    const stdin=Readable.from([JSON.stringify({
        subject:'Synthetic',text:privateBody,to:['recipient@example.com'],type:'report'
    })]);
    const stdout=memoryStream();
    const stderr=memoryStream();
    let resumed=false;
    const resume=stdin.resume.bind(stdin);
    stdin.isTTY=true;
    stdin.resume=function observeUnexpectedReportRead(){
        resumed=true;
        return resume();
    };
    const exitCode=await runCli([
        'mail','send','--profile','arcane-dev','--from','sender@example.com',
        '--report-key','synthetic-cli-report-key-0002','--report-stdin','--output','ndjson'
    ],{
        stdin,
        stdout:stdout.stream,
        stderr:stderr.stream,
        execute:async function attemptTtyMailSend(_command,options){
            await options.readReport();
        }
    });

    assert.equal(exitCode,1);
    assert.equal(resumed,false);
    assert.equal(stdout.read().includes(privateBody),false);
    assert.equal(stderr.read().includes(privateBody),false);
    assert.match(parseNdjson(stdout.read()).at(-1).data.error.message,/requires redirected/u);
});

test('mail send rejects malformed report input before credential access',async function malformedMailReport(){
    let credentialReads=0;
    await assert.rejects(
        executeMailCommand({
            action:'send',
            profile:'arcane-dev',
            from:'sender@example.com',
            reportKey:'synthetic-cli-report-key-0003',
            readReport:async function rejectMalformedReport(){
                throw new Error('synthetic malformed report');
            },
            readCredential:async function unexpectedCredentialRead(){
                credentialReads+=1;
                return 're_synthetic';
            }
        }),
        /synthetic malformed report/u
    );
    assert.equal(credentialReads,0);
});

test('mail send controller keeps provider credentials separate and preserves complete payload fields',async function mailSendController(){
    const secret='re_test_send_controller_only_00000000000001';
    const report={
        subject:'Synthetic controller acceptance',
        text:'private synthetic controller body',
        to:['recipient@example.com'],
        type:'report',
        metadata:{apiKey:'ordinary report field',appKey:'ordinary application field'}
    };
    let sends=0;
    let observed;
    const result=await executeMailCommand({
        action:'send',
        profile:'arcane-dev',
        from:'sender@example.com',
        reportKey:'synthetic-cli-report-key-0004',
        requestTimeout:45_000,
        readReport:async function readSyntheticReport(){return report;},
        readCredential:async function readSyntheticCredential(){return secret;},
        sendMail:async function sendSyntheticMail(options){
            sends+=1;
            observed=options;
            return {
                provider:'resend',
                status:'accepted',
                classification:'accepted',
                requestId:'synthetic-request-0004',
                providerId:'synthetic-provider-0004',
                providerStatus:200,
                recipientCount:1,
                report,
                providerRequest:{...report,from:'sender@example.com'},
                providerResponse:{
                    id:'synthetic-provider-0004',
                    metadata:{apiKey:'ordinary provider field',appKey:'ordinary provider app field'}
                }
            };
        }
    });

    assert.equal(sends,1);
    assert.equal(observed.apiKey,secret);
    assert.equal(observed.appId,'arcane-cli');
    assert.equal(observed.reportKey,'synthetic-cli-report-key-0004');
    assert.deepEqual(observed.report,report);
    assert.equal(JSON.stringify(result).includes(secret),false);
    assert.equal(result.report,report);
    assert.deepEqual(result.providerResponse.metadata,{
        apiKey:'ordinary provider field',
        appKey:'ordinary provider app field'
    });
    assert.equal(JSON.stringify(result).includes(report.text),true);
    assert.equal(JSON.stringify(result).includes(report.to[0]),true);
    assert.equal(result.status,'accepted');
});

test('mail send controller preserves complete ambiguous outcome detail without credentials',async function ambiguousMailSend(){
    const privateBody='private synthetic ambiguous body';
    const secret='re_test_ambiguous_controller_only_0000000001';
    await assert.rejects(
        executeOperation('mail',{
            action:'send',
            profile:'arcane-dev',
            from:'sender@example.com',
            reportKey:'synthetic-cli-report-key-0005',
            requestTimeout:45_000,
            readReport:async function readAmbiguousReport(){
                return {
                    subject:'Synthetic ambiguous request',
                    text:privateBody,
                    to:['recipient@example.com'],
                    type:'report'
                };
            },
            readCredential:async function readAmbiguousCredential(){return secret;},
            sendMail:async function returnAmbiguousResult(options){
                return {
                    provider:'resend',
                    status:'delivery_uncertain',
                    classification:'ambiguous',
                    requestId:'synthetic-request-0005',
                    providerStatus:0,
                    recipientCount:1,
                    retryAfterMs:1000,
                    retryable:true,
                    uncertain:true,
                    code:'resend_transport_uncertain',
                    report:options.report,
                    providerRequest:{...options.report,from:options.from},
                    providerResponse:{
                        message:'complete synthetic provider response',
                        metadata:{apiKey:'ordinary failure field',appKey:'ordinary application field'}
                    }
                };
            }
        }),
        function isCompleteAmbiguousError(error){
            const serialized=JSON.stringify({message:error.message,details:error.details});
            return error.code==='ARCANE_OPERATION_FAILED'
                &&error.details?.classification==='ambiguous'
                &&error.details?.uncertain===true
                &&!serialized.includes(secret)
                &&error.details.providerResponse.metadata.apiKey==='ordinary failure field'
                &&error.details.providerResponse.metadata.appKey==='ordinary application field'
                &&serialized.includes(privateBody)
                &&serialized.includes('recipient@example.com')
                &&serialized.includes('complete synthetic provider response');
        }
    );
});
