import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ERROR_CODES} from '../src/errors.mjs';
import {
    deleteMailCredential,
    getMailCredentialStatus,
    mailCredentialLocation,
    readMailCredential,
    readMailServerSettings,
    setMailCredential
} from '../src/mail-credentials.mjs';
import test from '../src/testing.mjs';
import {temporaryDirectory} from './helpers.mjs';

test('default JSON credential operations preserve unrelated settings and keep status secret-free',async function defaultCredential(context){
    const cwd=await temporaryDirectory(context);
    const filePath=path.join(cwd,'.arcane.env.json');
    const preserved={note:'Keep this complete text. 🐉',nested:{active:true}};
    await writeFile(filePath,JSON.stringify(preserved));
    const secret='re_synthetic_default_only';
    const result=await setMailCredential({cwd,secret});
    assert.deepEqual(result,{profile:'mail',provider:'resend',storage:'.arcane.env.json',exists:true});
    assert.equal(JSON.stringify(result).includes(secret),false);
    assert.equal(await readMailCredential({cwd}),secret);
    assert.equal(await readMailCredential({workspaceRoot:cwd,profile:'mail'}),secret);
    assert.deepEqual(await getMailCredentialStatus({cwd}),result);
    assert.deepEqual(JSON.parse(await readFile(filePath,'utf8')),{...preserved,RESEND_API_KEY:secret});
    assert.deepEqual(await deleteMailCredential({cwd}),{...result,exists:false});
    assert.equal(await readMailCredential({cwd}),null);
    assert.deepEqual(JSON.parse(await readFile(filePath,'utf8')),preserved);
});

test('named JSON profiles select exact names and never fall back to the default key',async function namedCredentials(context){
    const cwd=await temporaryDirectory(context);
    const profile='BOSS dragons.example / production';
    await setMailCredential({cwd,secret:'re_synthetic_default'});
    await setMailCredential({cwd,profile,secret:'re_synthetic_named'});
    assert.equal(await readMailCredential({cwd,profile}),'re_synthetic_named');
    assert.equal(await readMailCredential({cwd}),'re_synthetic_default');
    assert.equal(await readMailCredential({cwd,profile:'absent'}),null);
    assert.equal((await getMailCredentialStatus({cwd,profile:'absent'})).exists,false);
    await deleteMailCredential({cwd,profile});
    assert.equal(await readMailCredential({cwd,profile}),null);
    assert.equal(await readMailCredential({cwd}),'re_synthetic_default');
});

test('missing configuration stays absent through status and delete',async function absentConfiguration(context){
    const cwd=await temporaryDirectory(context);
    assert.equal(await readMailCredential({cwd}),null);
    assert.equal((await getMailCredentialStatus({cwd})).exists,false);
    assert.equal((await deleteMailCredential({cwd})).exists,false);
    await assert.rejects(readFile(path.join(cwd,'.arcane.env.json')),{code:'ENOENT'});
});

test('explicit invocation directory wins over the toolchain workspace',async function invocationDirectory(context){
    const cwd=await temporaryDirectory(context);
    const workspaceRoot=await temporaryDirectory(context);
    await setMailCredential({cwd,secret:'re_synthetic_invocation'});
    await setMailCredential({cwd:workspaceRoot,secret:'re_synthetic_workspace'});
    assert.equal(await readMailCredential({cwd,workspaceRoot}),'re_synthetic_invocation');
    assert.deepEqual(mailCredentialLocation({cwd,profile:'BOSS.prod'}),{
        filePath:path.join(cwd,'.arcane.env.json'),
        profile:'BOSS.prod',
        setting:'MAIL_PROFILES["BOSS.prod"].RESEND_API_KEY'
    });
});

test('malformed JSON errors identify the file without quoting credential content',async function malformedConfiguration(context){
    const cwd=await temporaryDirectory(context);
    const filePath=path.join(cwd,'.arcane.env.json');
    const content='{"RESEND_API_KEY":"re_synthetic_private", broken}';
    await writeFile(filePath,content);
    await assert.rejects(readMailCredential({cwd}),function inspectParseFailure(error){
        assert.equal(error.code,ERROR_CODES.usage);
        assert.equal(error.message.includes(filePath),true);
        assert.equal(String(error.stack).includes('re_synthetic_private'),false);
        assert.equal(error.cause,undefined);
        return true;
    });
    assert.equal(await readFile(filePath,'utf8'),content);
});

test('empty keys are absent and unusable settings name the affected field',async function configurationValues(context){
    const cwd=await temporaryDirectory(context);
    const filePath=path.join(cwd,'.arcane.env.json');
    await writeFile(filePath,JSON.stringify({RESEND_API_KEY:''}));
    assert.equal(await readMailCredential({cwd}),null);
    await writeFile(filePath,JSON.stringify({RESEND_API_KEY:{private:'re_synthetic_private'}}));
    await assert.rejects(readMailCredential({cwd}),function inspectSettingFailure(error){
        assert.equal(error.code,ERROR_CODES.usage);
        assert.match(error.message,/RESEND_API_KEY/u);
        assert.equal(error.message.includes('re_synthetic_private'),false);
        return true;
    });
});

test('cancellation before credential writes preserves the existing file',async function cancelledWrite(context){
    const cwd=await temporaryDirectory(context);
    const filePath=path.join(cwd,'.arcane.env.json');
    const content=JSON.stringify({RESEND_API_KEY:'re_synthetic_existing',note:'Preserve me.'});
    await writeFile(filePath,content);
    const controller=new AbortController();
    controller.abort();
    await assert.rejects(setMailCredential({cwd,secret:'re_synthetic_replacement',signal:controller.signal}),{
        code:ERROR_CODES.cancelled
    });
    assert.equal(await readFile(filePath,'utf8'),content);
});

test(
    'mail server reads the selected provider and shared PEM paths from one configuration',
    async function mailServerSettings(context) {
        const cwd = await temporaryDirectory(context);
        const keyPath = path.join(cwd, 'certificates', 'private-key.pem');
        const content = JSON.stringify(
            {
                RESEND_API_KEY: 're_synthetic_default',
                MAIL_PROFILES: {BOSS: {RESEND_API_KEY: 're_synthetic_boss'}},
                MAIL_TLS_CERT_PATH: 'certificates/fullchain.pem',
                MAIL_TLS_KEY_PATH: keyPath
            }
        );
        await writeFile(path.join(cwd, '.arcane.env.json'), content);
        const settings = await readMailServerSettings(
            {cwd, profile: 'BOSS'}
        );
        assert.deepEqual(
            settings,
            {
                apiKey: 're_synthetic_boss',
                certPath: path.join(cwd, 'certificates', 'fullchain.pem'),
                keyPath
            }
        );
        assert.equal(await readFile(path.join(cwd, '.arcane.env.json'), 'utf8'), content);
        assert.deepEqual(
            await readMailServerSettings(
                {cwd, profile: 'BOSS', readCredential: null}
            ),
            settings
        );
    }
);

test(
    'mail TLS configuration errors name the setting without exposing its value',
    async function invalidMailTlsSetting(context) {
        const cwd = await temporaryDirectory(context);
        await writeFile(
            path.join(cwd, '.arcane.env.json'),
            JSON.stringify(
                {RESEND_API_KEY: 're_synthetic_private', MAIL_TLS_CERT_PATH: {private: 'private-content'}}
            )
        );
        await assert.rejects(
            readMailServerSettings(
                {cwd}
            ),
            function inspectTlsSettingFailure(error) {
                assert.equal(error.code, ERROR_CODES.usage);
                assert.match(error.message, /MAIL_TLS_CERT_PATH/u);
                assert.equal(error.message.includes('re_synthetic_private'), false);
                assert.equal(error.message.includes('private-content'), false);
                return true;
            }
        );
    }
);
