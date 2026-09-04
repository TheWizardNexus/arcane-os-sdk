export {
    default,
    default as Mail,
    resolveMailConfig
} from '../runtime/arcane/modules/Mail.js';
export {
    MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS,
    MAIL_OUTBOX_PROTOCOL,
    MAIL_OUTBOX_STATES,
    MAIL_OUTBOX_TABLE,
    MailOutbox,
    createMailOutbox
} from '../runtime/arcane/modules/MailOutbox.mjs';
export {
    MailTransportError,
    normalizeMailEndpoint,
    sendMailReport,
    serializeMailReport
} from '../runtime/arcane/modules/MailTransport.mjs';
