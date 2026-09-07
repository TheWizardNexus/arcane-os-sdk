import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import Mail,{
    MAIL_OUTBOX_PROTOCOL,
    Mail as NamedMail,
    MailOutbox,
    MailTransportError,
    createMailOutbox,
    normalizeMailEndpoint,
    resolveMailConfig,
    sendMailReport,
    serializeMailReport
} from '../src/mail-api.mjs';
import * as mailApi from '../src/mail-api.mjs';

const PUBLIC_MAIL_EXPORTS=[
    'MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS',
    'MAIL_OUTBOX_PROTOCOL',
    'MAIL_OUTBOX_STATES',
    'MAIL_OUTBOX_TABLE',
    'Mail',
    'MailOutbox',
    'MailTransportError',
    'createMailOutbox',
    'default',
    'normalizeMailEndpoint',
    'resolveMailConfig',
    'sendMailReport',
    'serializeMailReport'
];

test('the portable Mail source entrypoint exposes one exact export contract',function mailApiExports(){
    assert.deepEqual(Object.keys(mailApi).sort(),[...PUBLIC_MAIL_EXPORTS].sort());
    assert.equal(Mail,NamedMail);
    assert.equal(typeof Mail,'function');
    assert.equal(typeof MailOutbox,'function');
    assert.equal(typeof MailTransportError,'function');
    assert.equal(typeof createMailOutbox,'function');
    assert.equal(typeof normalizeMailEndpoint,'function');
    assert.equal(typeof resolveMailConfig,'function');
    assert.equal(typeof sendMailReport,'function');
    assert.equal(typeof serializeMailReport,'function');
    assert.equal(MAIL_OUTBOX_PROTOCOL,'arcane-mail-outbox/1');
    const location=new URL('https://app.example.test:8443/reports/current');
    const config=resolveMailConfig({appName:'Any application name'},{location});
    assert.equal(config.appName,'Any application name');
    assert.equal(config.endpoint,'https://app.example.test:8443/v1/mail');
    assert.equal(resolveMailConfig({subscriptionKey:null},{location}).subscriptionKey,null);
    assert.equal(resolveMailConfig({subscriptionKey:''},{location}).subscriptionKey,'');
    assert.equal(
        resolveMailConfig({appName:'TWiN',endpoint:''},{location}).endpoint,
        ''
    );
    assert.equal(
        normalizeMailEndpoint('/v1/mail?account=TWiN',location.href),
        'https://app.example.test:8443/v1/mail?account=TWiN'
    );
    assert.equal(
        normalizeMailEndpoint('http://app.example.test/v1/mail'),
        'http://app.example.test/v1/mail'
    );
    for(const method of ['audit','deleteInvalid','quarantineInvalid','repairInvalid']){
        assert.equal(typeof MailOutbox.prototype[method],'function');
    }
    for(const method of [
        'auditOutbox',
        'deleteInvalidOutbox',
        'quarantineInvalidOutbox',
        'repairInvalidOutbox'
    ]){
        assert.equal(typeof Mail.prototype[method],'function');
    }
});
