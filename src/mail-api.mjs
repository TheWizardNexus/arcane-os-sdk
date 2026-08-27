export {
    default,
    default as Mail,
    resolveMailConfig
} from '../runtime/arcane/modules/Mail.js';
export {
    MAIL_OUTBOX_ACCEPTANCE_AUTHORITIES,
    MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS,
    MAIL_OUTBOX_PROTOCOL,
    MAIL_OUTBOX_STATES,
    MAIL_OUTBOX_TABLE,
    MailOutbox,
    createMailOutbox
} from '../runtime/arcane/modules/MailOutbox.mjs';
export {
    DEFAULT_MAIL_REQUEST_TIMEOUT_MS,
    MAX_MAIL_RESPONSE_BYTES,
    MailTransportError,
    normalizeMailEndpoint,
    sendMailReport,
    serializeMailReport
} from '../runtime/arcane/modules/MailTransport.mjs';
