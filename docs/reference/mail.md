# Mail gateway and durable outbox

Arcane Mail is a pure-JavaScript SDK path. It does not use WebAssembly: mail is
network and durable-state work, while the Resend credential belongs in the
local Node gateway rather than in browser or WebAssembly state.

## Ownership and availability

| Surface | Runtime | Responsibility |
| --- | --- | --- |
| `Mail.js` | Browser or native WebView | Validates and formats reports, persists each exact outbound request in DBOPFS, and owns retry/drain lifecycle. |
| `MailOutbox.mjs` | Browser or compatible injected storage | Stores exact requests in the `mail_outbox` DBOPFS table before delivery and normalizes terminal, retry, and reconciliation states. |
| `MailTransport.mjs` | Browser, WebView, or compatible Fetch host | Sends one already-persisted request to the configured Arcane gateway with the stable report key as its idempotency key. |
| `arcane mail send` | Node on the local machine | Reads one complete provider-neutral report from redirected stdin and performs one explicit Resend attempt with a caller-owned idempotency key. |
| `arcane mail serve` | Node on the local machine | Authenticates the local caller, protects the provider credential, applies any explicitly configured recipient policy, and makes the single server-side Resend request. |
| `arcane mail key ...` | Node on Windows | Stores, inspects, or deletes a Resend API key in Windows Credential Manager. |

The browser never receives the Resend API key. The gateway never writes that
key to source, argv, logs, events, fixtures, browser storage, or its public
lifecycle result. Non-Windows hosts report credential operations as unavailable;
there is no plaintext fallback.

## Public npm import

The portable programmatic contract is one subpath:

```javascript
import Mail,{
    MailOutbox,
    createMailOutbox,
    sendMailReport
} from 'arcane-os/mail';
```

`arcane-os/mail` projects `src/mail-api.mjs` and has these exact exports:

- default and named `Mail`, plus `resolveMailConfig`;
- `MailOutbox`, `createMailOutbox`, `MAIL_OUTBOX_PROTOCOL`,
  `MAIL_OUTBOX_TABLE`, `MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS`, and
  `MAIL_OUTBOX_STATES`; and
- `MailTransportError`, `normalizeMailEndpoint`, `serializeMailReport`,
  `sendMailReport`, and `DEFAULT_MAIL_REQUEST_TIMEOUT_MS`.

`DEFAULT_MAIL_REQUEST_TIMEOUT_MS` is `null`; it means the ordinary transport
adds no default deadline.

This entrypoint contains only the portable browser/WebView runtime, outbox, and
transport contract. It does not import the Node HTTP gateway or Windows
Credential Manager adapter. Programmatic developer tooling reaches those
host-owned operations through the existing `createToolchain().mail(...)`
boundary; ordinary operators use `arcane mail send`, `arcane mail serve`, and
`arcane mail key ...`. This keeps Node credential and server authority out of a
browser import while preserving one shared CLI/toolchain implementation.

## Two separate credential boundaries

Arcane Mail deliberately separates two credentials:

- The **Resend API key** is provider authority. `arcane mail key set <profile>`
  stores it in Windows Credential Manager. `mail send --profile <profile>` and
  `mail serve --profile <profile>` read it only inside the owning Node process.
- The **mail app key** authenticates one browser/application caller to the
  loopback gateway. It is supplied to `mail serve` through hidden terminal
  input, or through redirected input with `--app-key-stdin`, and must match the
  browser's `arcane.config.mail.appKey`. It is a nonempty printable ASCII
  bearer-like local authentication value, never the Resend API key.

Do not put either secret on the command line. Command-line arguments may be
recorded by the operating system or shell history. Structured CLI output
requires the matching explicit redirected-input flag and rejects TTY input so
the terminal cannot echo a secret.

The mail app key is not confidential from scripts executing in the same page:
same-runtime script or XSS can read browser configuration and issue the same
request. Inject it at runtime, never hardcode it in shipped assets, protect the
page's script boundary, restrict the exact gateway destination, and rotate it
when page or process trust is lost. It protects the loopback server from
unadmitted local callers; it is not provider authority or a replacement for
browser application security.

## Configure the browser runtime

One application declares an exact app id, gateway endpoint, and local app key:

```javascript
globalThis.arcane = globalThis.arcane || {};
globalThis.arcane.config = globalThis.arcane.config || {};
globalThis.arcane.config.mail = {
    appName: 'arcane-dev',
    appKey: localMailAppKey,
    endpoint: 'http://127.0.0.1:8025/v1/mail'
};
```

The transport endpoint must be HTTPS or loopback HTTP at `localhost`,
`127.0.0.1`, or `[::1]`. The SDK CLI gateway itself binds numeric loopback only. An
explicit HTTPS endpoint receives the app key as `X-Mail-Key`, so its ownership
and trust must be verified before configuration. A hosted default is derived
only when the page declares an admitted Arcane mail base domain; otherwise
configuration fails rather than selecting an arbitrary remote host.

The ordinary browser transport has no automatic request deadline and reads the
complete gateway response. A caller may explicitly supply a positive
`requestTimeout` when its own lifecycle requires a deadline; cancellation then
remains an uncertain delivery outcome because the provider may already have
accepted the request.

## Durable send semantics

`Mail.send(to, subject, payload, messageStyle, messageType)` preserves the
existing signature. `messageType` is `error`, `report`, or `crisis_detected`.
Report and crisis mail require at least one recipient; error mail may use the
gateway's configured allowlisted fallback recipients.

In a browser, the module owns the one `window.mail` singleton. An explicit
`new Mail(config, options)` may configure that owned singleton only before its
durable lifecycle or outbox has begun; later reconfiguration fails with
`MAIL_CONFIGURATION_LOCKED`. `dispose()` clears the global registration only
when that exact instance owns it, so a later construction creates a fresh
instance instead of returning stale disposed state. A truthy `window.mail`
owned by another implementation reports `MAIL_SINGLETON_CONFLICT`; the SDK
never replaces another implementation's singleton.

Runtime context enrichment is off by default. With the explicit constructor
option `{includeContext:true}`, every message also captures
`location.pathname` as `source_path`; report and crisis messages load the
current User entity and add its `username`, `email`, `language`, and `phone`
values to the locally rendered content. Those fields are then stored and sent
unencrypted as part of the message, so the application owns consent, purpose,
recipient scope, retention, and disclosure. Without that option, Mail neither
loads the User profile nor adds the path/profile fields. The generated
`source_at` timestamp, caller-supplied payload, subject, type, and recipients
remain part of the requested report in either mode.

The public `Mail` integration requires its compatible DBOPFS adapter. Before the
first delivery attempt, it serializes the exact provider-neutral report and
commits it to DBOPFS table `mail_outbox`. A generated report key
contains only time/process identity and never includes the subject or an email
address. Mail uses `randomUUID()` when available and otherwise uses a local
time/sequence identity without blocking ordinary delivery. Delivery receives
the complete stored serialized content and the same report key on every retry.

`MailTransport.mjs` is also a lower-level public transport and does not persist
raw caller requests by itself. A directly constructed `MailOutbox` can accept
another injected storage adapter plus a Web Locks compatible `lockManager`;
durable claims then belong to that adapter's implemented `get`, `set`,
`getAllKeys`, and shared-lock semantics rather than to DBOPFS. The browser
default uses `navigator.locks`; when that cross-context authority is absent,
the outbox reports `MAIL_OUTBOX_LOCK_UNAVAILABLE` and does not start the drain.

Call `await mail.start()` during application startup so pre-existing records
are scanned even when the application does not send a new report. The first
`send()` also starts the lifecycle if needed.

| Mail method/property | Contract |
| --- | --- |
| `start({signal})` | Idempotently scans/drains startup work and installs one owned online listener. |
| `send(to, subject, payload, style, type)` | Formats, persists, then conditionally attempts one new report and returns the complete mutable durable record, report, delivery result, and convenience state fields. |
| `drain({reason, signal})` | Runs or joins one FIFO drain across the complete current inventory. |
| `listOutbox()` / `getOutboxRecord(reportKey)` | Returns valid durable records, including complete serialized report content. Invalid files do not hide valid records. |
| `auditOutbox()` / `invalidOutboxRecords` | Returns the complete valid inventory and filename/code/repairability metadata for every invalid file. |
| `repairInvalidOutbox(fileName, record)` | Replaces one invalid, correctly named file only after the replacement passes the full record contract. |
| `deleteInvalidOutbox(fileName)` | Explicitly deletes one invalid file after current inventory confirmation; it requires a storage adapter with `delete`. |
| `quarantineInvalidOutbox()` | Moves every confirmed invalid file in the current inventory into `mail_outbox_quarantine`; it retains the complete JSON-serializable source value before deleting each original. |
| `stop()` | Removes the online listener and aborts in-flight work owned by this Mail instance; persisted requests and uncertain attempt state remain available for a later restart. |
| `dispose()` | Idempotently stops lifecycle and releases the singleton event source. |
| `events` | Event-source handle for `mail-outbox-state`, `mail-outbox-delivery`, and `mail-outbox-drain`; details contain the complete mutable record, result, failure, inventory, and report content available at that transition. |

The returned durable record has one of these states:

| State | Meaning |
| --- | --- |
| `queued` | Persisted, but no attempt was made, normally because the device is offline. |
| `sending` | An attempt was durably recorded before calling the transport. An interrupted instance recovers this state on the next drain. |
| `retry_wait` | A retryable or uncertain result is retained inside Resend's 24-hour idempotency window. |
| `accepted` | Direct gateway delivery returned both its request id and a Resend provider id, or the exact native `mail-send-v1` bridge returned accepted under named `arcane-core-mail-send-v1` authority without fabricating a provider id. This is API acceptance, not an inbox-delivery claim. |
| `failed` | A permanent failure or expired non-ambiguous retry cannot be retried automatically. |
| `reconciliation_required` | An ambiguous attempt reached the end of the idempotency window. Automatic retry stops to avoid a duplicate send. |

The outbox owns one FIFO drain per instance and processes the complete current
inventory. A shared Web Lock extends that single-drain authority across
MailOutbox instances and browser contexts for the same origin and table.
Startup, the browser's `online` event, and explicit calls can trigger a drain;
there are no polling/retry timers. A future-due `retry_wait` record requires a
later startup, connectivity transition, or host-owned manual drain. Every
successful durable write publishes its complete record transition, including
transitions produced by startup, manual, and online drains.
`dispose()` aborts owned in-flight work, removes the online listener, and
releases the singleton-event registration. A provider attempt interrupted after
it began is retained as an uncertain same-key retry rather than being discarded.
Cancellation that arrives while the durable `sending` transition is being
written restores the prior non-attempted state before returning and never calls
the transport. A restart after `stop()` waits for the cancelled start generation
to settle, then begins a distinct lifecycle generation.

Each durable record contains the exact complete serialized message and the
public list/get APIs return that content. Never place credentials in a report.
Protect the application's OPFS origin and any code allowed to inspect it. The
outbox applies no record-count ceiling and exposes no implicit
retention/deletion policy; the owning application explicitly removes terminal
DBOPFS records when its own lifecycle requires that operation.

Malformed or unreadable files are reported through `audit()` /
`invalidRecords` on `MailOutbox` and the Mail proxies above, and skipped without
aborting valid listing or draining. Inventory and quarantine process every
physical file in the current inventory in one operation. Quarantine remains
local and contains the complete serialized
source value; protect and retain that table according to the application's own
data policy. Transient storage read failures propagate as
`MAIL_OUTBOX_STORAGE_FAILED` and never authorize destructive maintenance. Each
maintenance target is revalidated and serialized against record writes through
one origin-wide exclusive table lock; a file that became valid in another
MailOutbox instance or browser context is preserved, and quarantine refuses
deletion when it cannot capture the complete source value. Same-key exact
serialized-content comparison executes under that table lock before a queued
record is committed.
Injected adapters that can share a table must share the same Web Locks
compatible manager and must not mutate MailOutbox-owned records behind that
boundary.

Mail publishes complete semantic events through the SDK singleton event
authority. Public detail includes the full mutable durable record, serialized
report, result or failure, provider details, and complete drain inventory
available at that transition. It never includes the Resend API key or mail app
key. Listener exceptions are observational and cannot change a committed mail
operation result.

When both an explicit endpoint and native `Arcane.mail.send` exist, Mail uses
the configured HTTP endpoint so the authenticated SDK gateway can return its
provider acceptance id. The native bridge remains a fallback when no endpoint
is configured; its exact Core result is recorded with the named acceptance
authority above. A malformed or unreadable native response is retained as an
uncertain same-key retry, while temporary native transport unavailability is a
non-ambiguous retryable failure. Once a valid accepted result has returned, a
racing lifecycle cancellation cannot erase that authoritative acceptance.

## Operate the CLI and local gateway

Store one Resend key under a local profile:

```text
arcane mail key set arcane-dev
arcane mail key status arcane-dev
arcane mail key delete arcane-dev
```

`key set` prompts with hidden input. `--secret-stdin` is the explicit
non-interactive alternative and rejects a TTY.

Perform one provider attempt directly from the SDK CLI:

```text
arcane mail send --profile arcane-dev --from "Arcane <verified@example.com>" --report-key <stable-id> --report-stdin
```

The redirected UTF-8 JSON input is read completely. A report requires `type`,
`to`, `subject`, and at least one of `text` or `html`; additional
JSON-compatible provider fields are preserved. Direct CLI sends require at
least one explicit recipient, including for `error` reports. Message content is
not accepted in argv. Programmatic results and observer events preserve the
complete report, provider request, provider response, and error detail while
never exposing either credential.

The caller must create and retain a safe-character `--report-key` before the
attempt. It is the Resend idempotency key and may be reused only with the same
serialized report content for an intentional retry or reconciliation. The
CLI performs exactly one attempt and never retries automatically. Exit zero
requires a successful Resend response containing a valid provider id; that is
provider acceptance, not an inbox-delivery claim. Timeout, connection loss, or
cancellation after the provider attempt begins is returned as an ambiguous
nonzero outcome because the provider may already have accepted the request.
Cancellation before the attempt exits 130 without sending.
For both CLI mail operations, `--request-timeout` accepts 1 through 2147483647
milliseconds, the Node timer range. When omitted, the SDK adds no provider
deadline.

Start the authenticated gateway:

```text
arcane mail serve --profile arcane-dev --from "Arcane <verified@example.com>" --app arcane-dev --origin http://127.0.0.1:8000 --allow-to recipient@example.com
```

Human output prompts for the separate mail app key with hidden input.
Non-interactive structured output requires `--app-key-stdin` and redirected
stdin. The server binds numeric loopback only; the default is
`127.0.0.1:8025/v1/mail`.

The gateway protects the provider credential by requiring:

- its exact numeric-loopback `Host` authority and `/v1/mail` route;
- an exact configured `Origin`, app id, and constant-time app-key match;
- complete JSON requests with at least one recipient, or configured fallback
  recipients for an `error` report;
- an optional explicit recipient allowlist when one is configured; and
- one fixed Resend endpoint with the stable Arcane report key forwarded as
  `Idempotency-Key`.

The gateway returns `202` only after Resend returns a valid provider id.
Transport loss, an explicit caller-selected timeout, an invalid success body,
or an unreadable provider response returns an explicit uncertain result and never claims
delivery. Rate limits, concurrent idempotency requests, permanent validation
failures, and provider failures are mapped to structured retryable/permanent
results with the complete available provider response or error detail.

## Operational verification

The focused SDK tests use only synthetic keys, addresses, responses, storage,
and loopback requests. They do not contact Resend or send email. A live
acceptance send is a separate operational boundary: use a disposable message,
the real allowlist, and the selected credential profile, then verify both the
gateway's provider-acceptance id and the intended inbox outcome.
