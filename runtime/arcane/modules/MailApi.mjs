export {
    default,
    default as Mail,
    resolveMailConfig
} from './Mail.js';
export {
    MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS,
    MAIL_OUTBOX_PROTOCOL,
    MAIL_OUTBOX_STATES,
    MAIL_OUTBOX_TABLE,
    MailOutbox,
    createMailOutbox
} from './MailOutbox.mjs';
export {
    MailTransportError,
    normalizeMailEndpoint,
    sendMailReport,
    serializeMailReport
} from './MailTransport.mjs';
