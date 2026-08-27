import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import Mail,{
    MAIL_OUTBOX_ACCEPTANCE_AUTHORITIES,
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

const PUBLIC_MAIL_EXPORTS=Object.freeze([
    'DEFAULT_MAIL_REQUEST_TIMEOUT_MS',
    'MAIL_OUTBOX_ACCEPTANCE_AUTHORITIES',
    'MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS',
    'MAIL_OUTBOX_PROTOCOL',
    'MAIL_OUTBOX_STATES',
    'MAIL_OUTBOX_TABLE',
    'MAX_MAIL_RESPONSE_BYTES',
    'Mail',
    'MailOutbox',
    'MailTransportError',
    'createMailOutbox',
    'default',
    'normalizeMailEndpoint',
    'resolveMailConfig',
    'sendMailReport',
    'serializeMailReport'
]);

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
    assert.deepEqual(MAIL_OUTBOX_ACCEPTANCE_AUTHORITIES,['arcane-core-mail-send-v1']);
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
