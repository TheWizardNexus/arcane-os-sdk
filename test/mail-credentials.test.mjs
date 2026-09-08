import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {ERROR_CODES} from '../src/errors.mjs';
import {
    deleteMailCredential,
    getMailCredentialStatus,
    mailCredentialLocation,
    readMailCredential,
    readMailConfiguration,
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
    assert.deepEqual(JSON.parse(await readFile(filePath,'utf8')),{...preserved,mail:{apiKey:secret}});
    assert.deepEqual(await deleteMailCredential({cwd}),{...result,exists:false});
    assert.equal(await readMailCredential({cwd}),null);
    assert.deepEqual(JSON.parse(await readFile(filePath,'utf8')),{...preserved,mail:{}});
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
        const settings = await readMailConfiguration(
            {cwd, profile: 'BOSS'}
        );
        assert.deepEqual(
            settings,
            {
                profile: 'BOSS',
                apiKey: 're_synthetic_boss',
                certPath: path.join(cwd, 'certificates', 'fullchain.pem'),
                keyPath
            }
        );
        assert.equal(await readFile(path.join(cwd, '.arcane.env.json'), 'utf8'), content);
        assert.deepEqual(
            await readMailConfiguration(
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
            readMailConfiguration(
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

test(
    'nested mail keys take precedence while exact legacy profiles remain readable',
    async function nestedAndLegacyMailKeys(context) {
        const cwd = await temporaryDirectory(context);
        const filePath = path.join(cwd, '.arcane.env.json');
        const profile = 'BOSS dragons.example / production';
        const settings = {
            RESEND_API_KEY: 're_synthetic_legacy_default',
            MAIL_PROFILES: {
                [profile]: {RESEND_API_KEY: 're_synthetic_legacy_named'},
                TWiN: {RESEND_API_KEY: 're_synthetic_legacy_twin'}
            },
            mail: {
                apiKey: 're_synthetic_nested_default',
                profiles: {
                    [profile]: {apiKey: 're_synthetic_nested_named'}
                }
            }
        };
        await writeFile(filePath, JSON.stringify(settings));
        assert.equal(
            await readMailCredential(
                {cwd}
            ),
            're_synthetic_nested_default'
        );
        assert.equal(
            await readMailCredential(
                {cwd, profile}
            ),
            're_synthetic_nested_named'
        );
        assert.equal(
            await readMailCredential(
                {cwd, profile: 'TWiN'}
            ),
            're_synthetic_legacy_twin'
        );
        assert.equal(
            await readMailCredential(
                {cwd, profile: 'absent'}
            ),
            null
        );

        for (const absentKey of ['', null]) {
            settings.mail.apiKey = absentKey;
            settings.mail.profiles[profile].apiKey = absentKey;
            await writeFile(filePath, JSON.stringify(settings));
            assert.equal(
                await readMailCredential(
                    {cwd}
                ),
                null
            );
            assert.equal(
                await readMailCredential(
                    {cwd, profile}
                ),
                null
            );
        }
    }
);

test(
    'key updates preserve existing storage and deletion removes both selected representations',
    async function preserveMailCredentialRepresentations(context) {
        const cwd = await temporaryDirectory(context);
        const filePath = path.join(cwd, '.arcane.env.json');
        const settings = {
            note: 'Keep the dragon parade invitation exactly as written. 🐉',
            RESEND_API_KEY: 're_synthetic_legacy_default',
            MAIL_PROFILES: {
                BOSS: {RESEND_API_KEY: 're_synthetic_legacy_boss', label: 'Keep BOSS.'},
                TWiN: {RESEND_API_KEY: 're_synthetic_legacy_twin'}
            },
            mail: {
                label: 'Keep mail.',
                profiles: {
                    BOSS: {apiKey: 're_synthetic_nested_boss', label: 'Keep nested BOSS.'},
                    TWiN: {label: 'Keep nested TWiN.'}
                }
            },
            unrelated: {apiKey: 'synthetic_unrelated_key'}
        };
        await writeFile(filePath, JSON.stringify(settings));
        await setMailCredential(
            {cwd, secret: 're_synthetic_updated_default'}
        );
        await setMailCredential(
            {cwd, profile: 'BOSS', secret: 're_synthetic_updated_boss'}
        );
        await setMailCredential(
            {cwd, profile: 'TWiN', secret: 're_synthetic_updated_twin'}
        );
        await setMailCredential(
            {cwd, profile: 'New app', secret: 're_synthetic_new_app'}
        );

        settings.RESEND_API_KEY = 're_synthetic_updated_default';
        settings.mail.profiles.BOSS.apiKey = 're_synthetic_updated_boss';
        settings.MAIL_PROFILES.TWiN.RESEND_API_KEY = 're_synthetic_updated_twin';
        settings.mail.profiles['New app'] = {apiKey: 're_synthetic_new_app'};
        assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), settings);

        await deleteMailCredential(
            {cwd, profile: 'BOSS'}
        );
        delete settings.mail.profiles.BOSS.apiKey;
        delete settings.MAIL_PROFILES.BOSS.RESEND_API_KEY;
        assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), settings);
        assert.equal(
            await readMailCredential(
                {cwd, profile: 'BOSS'}
            ),
            null
        );
        assert.equal(
            await readMailCredential(
                {cwd, profile: 'TWiN'}
            ),
            're_synthetic_updated_twin'
        );
        assert.equal(
            await readMailCredential(
                {cwd}
            ),
            're_synthetic_updated_default'
        );
    }
);

test(
    'mail configuration separates settings from secrets and resolves the configured profile and PEM paths',
    async function splitMailConfiguration(context) {
        const cwd = await temporaryDirectory(context);
        const configuration = {
            app: {name: 'Dragon dispatch'},
            mail: {
                profile: 'BOSS',
                host: '0.0.0.0',
                port: 5443,
                origins: ['https://dragons.example', 'https://postmaster.example'],
                certPath: 'certificates/fullchain.pem',
                keyPath: 'certificates/private-key.pem',
                from: 'dragons@example.com',
                appId: 'Dragon dispatch',
                recipientAllowlist: ['reader@example.com'],
                errorRecipients: ['postmaster@example.com'],
                bodyTimeoutMs: 30_000,
                providerTimeoutMs: 40_000,
                retryableDelayMs: 750
            }
        };
        const secrets = {
            RESEND_API_KEY: 're_synthetic_legacy',
            MAIL_TLS_CERT_PATH: 'old/fullchain.pem',
            MAIL_TLS_KEY_PATH: 'old/private-key.pem',
            mail: {
                apiKey: 're_synthetic_default',
                profiles: {BOSS: {apiKey: 're_synthetic_boss'}}
            }
        };
        const configurationText = JSON.stringify(configuration);
        const secretsText = JSON.stringify(secrets);
        await writeFile(path.join(cwd, 'arcane.config.json'), configurationText);
        await writeFile(path.join(cwd, '.arcane.env.json'), secretsText);

        const resolved = await readMailConfiguration(
            {cwd}
        );
        assert.deepEqual(
            resolved,
            {
                ...configuration.mail,
                apiKey: 're_synthetic_boss',
                certPath: path.join(cwd, 'certificates', 'fullchain.pem'),
                keyPath: path.join(cwd, 'certificates', 'private-key.pem')
            }
        );
        const defaultCredential = await readMailCredential(
            {cwd}
        );
        const defaultStatus = await getMailCredentialStatus(
            {cwd}
        );
        const explicitDefault = await readMailConfiguration(
            {cwd, profile: null}
        );
        assert.equal(defaultCredential, 're_synthetic_default');
        assert.equal(defaultStatus.profile, 'mail');
        assert.equal(explicitDefault.profile, 'mail');
        assert.equal(explicitDefault.apiKey, 're_synthetic_default');
        assert.equal(await readFile(path.join(cwd, 'arcane.config.json'), 'utf8'), configurationText);
        assert.equal(await readFile(path.join(cwd, '.arcane.env.json'), 'utf8'), secretsText);
    }
);

test(
    'absent mail files retain the default profile and missing credential',
    async function absentSplitMailConfiguration(context) {
        const cwd = await temporaryDirectory(context);
        const configuration = await readMailConfiguration(
            {cwd}
        );
        assert.deepEqual(
            configuration,
            {profile: 'mail', apiKey: null}
        );
        await assert.rejects(
            readFile(path.join(cwd, 'arcane.config.json')),
            {code: 'ENOENT'}
        );
        await assert.rejects(
            readFile(path.join(cwd, '.arcane.env.json')),
            {code: 'ENOENT'}
        );
    }
);
