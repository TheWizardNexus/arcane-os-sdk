# Mail gateway and durable outbox

Arcane Mail is a pure-JavaScript SDK path. It does not use WebAssembly: mail is
network and durable-state work. The Resend credential belongs in the Node
gateway and is never included in browser or WebAssembly state.

## Ownership and availability

| Surface | Runtime | Responsibility |
| --- | --- | --- |
| `Mail.js` | Browser or native WebView | Validates and formats reports, persists each exact outbound request in DBOPFS, and owns retry/drain lifecycle. |
| `MailOutbox.mjs` | Browser or compatible injected storage | Stores exact requests in the `mail_outbox` DBOPFS table before delivery and normalizes terminal, retry, and reconciliation states. |
| `MailTransport.mjs` | Browser, WebView, or compatible Fetch host | Sends one already-persisted request to the configured Arcane gateway with the stable report key as its idempotency key. |
| `arcane mail send` | Node on the local machine | Reads one complete provider-neutral report from redirected stdin and performs one explicit Resend attempt with a caller-owned idempotency key. |
| `arcane mail serve` | Node on the configured host | Owns caller verification, protects the provider credential, applies explicitly configured recipient and origin settings, and makes one server-side Resend request. |
| `arcane mail key ...` | Node on Windows, Linux, or macOS | Stores, inspects, or deletes a Resend API key in the selected `.arcane.env.json`. |

The browser never receives the Resend API key. The gateway never writes that
key to source, argv, logs, events, fixtures, browser storage, or its public
lifecycle result. The CLI and gateway use the same Node filesystem and network
interfaces on Windows, Linux, and macOS. An Android host supplies a compatible
Node runtime and an accessible configuration directory; the mail implementation
contains no Windows credential process or platform-specific path convention.

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
  and `sendMailReport`.

This entrypoint contains only the portable browser/WebView runtime, outbox, and
transport contract. It does not import the Node HTTP gateway or its filesystem
credential adapter. Programmatic developer tooling reaches those
host-owned operations through the existing `createToolchain().mail(...)`
boundary; ordinary operators use `arcane mail send`, `arcane mail serve`, and
`arcane mail key ...`. This keeps Node credential and server authority out of a
browser import while preserving one shared CLI/toolchain implementation.

## Provider and subscription credentials

Arcane Mail deliberately separates two credentials:

- The **Resend API key** is provider authority. The Node process reads it from
  `.arcane.env.json`. `arcane mail key set [profile]` can store it there through hidden
  input; `mail send` and `mail serve` read the selected profile inside that process.
- The **subscription key** is the application user's subscription credential.
  When present, the browser sends it as `Authorization: Bearer <subscriptionKey>`,
  with the exact application name in `X-Mail-App`. The application name identifies the
  subscription account to verify; it is a separate field from the key and the
  report content.

Do not put either secret on the command line. Command-line arguments may be
recorded by the operating system or shell history. The credential-store
command uses hidden terminal input or explicitly selected redirected input;
subscription credentials are supplied through runtime configuration.

Subscription credentials stay in runtime configuration or the canonical User
entity. They are not added to reports, outbox records, delivery events, or
provider payloads. Supply credentials at runtime; do not hardcode them in
shipped source or fixtures.

## Configure the browser runtime

Configure Mail before its durable lifecycle starts:

```javascript
globalThis.arcane = globalThis.arcane || {};
globalThis.arcane.config = globalThis.arcane.config || {};
globalThis.arcane.config.mail = {
    appName: 'My application'
};
```

`appName` is an arbitrary nonempty string, preserved as supplied. `BOSS` and
`TWiN` are examples, not an enum or an admission list. When `appName` is omitted,
Mail reads the page's `arcane-app-id` metadata without changing its value.

On an HTTP or HTTPS page, the default endpoint is `/v1/mail` on the current
origin, including its port. Mail does not infer a base domain, select a mail
subdomain, or treat loopback addresses specially. An explicit `endpoint` may
select a shared server on another domain. The transport resolves it through
the URL parser and accepts HTTP or HTTPS; relative URLs and query strings are
supported. The gateway routes by pathname. Its configured CORS origins must
include a caller on another origin.

An explicit `endpoint: ''` disables HTTP delivery and selects the existing
native `Arcane.mail.send` fallback when available. Pages with a non-HTTP origin
also have no default HTTP endpoint. Configured HTTP delivery takes precedence
over an available native bridge.

An explicit nonempty string `subscriptionKey` supplies the HTTP credential.
When it is omitted, Mail resolves the current canonical User entity at the actual HTTP delivery,
waits for its existing `load()` operation, and reads `subscription_key`.
An injected `options.user` retains precedence, including an explicit `null`.
Mail does not retain a separate User instance, so later deliveries observe a
replacement canonical User. This adds no page-startup wait, polling, new
credential storage, or migration of saved data.

An absent key, `null`, or an empty string omits the Authorization header; the
transport does not block initial setup because a key is missing. Explicit
`subscriptionKey: null` or `subscriptionKey: ''` also skips User lookup.
A supplied value of another type is rejected. A gateway with subscription
verification configured owns rejection of requests without a usable key,
subject to its [automatic same-IP exception](#automatic-same-ip-exception).

For a caller-owned key and shared endpoint:

```javascript
globalThis.arcane.config.mail = {
    appName: 'Another application',
    subscriptionKey: currentSubscriptionKey,
    endpoint: 'https://mail.example.test/v1/mail'
};
```

The ordinary browser transport has no automatic request deadline and reads the
complete gateway response. A caller may explicitly supply a positive
`requestTimeout` when its own lifecycle requires a deadline; cancellation then
remains an uncertain delivery outcome because the provider may already have
accepted the request.

## Durable send semantics

`Mail.send(to, subject, payload, messageStyle, messageType)` preserves the
existing signature. `messageType` is `error`, `report`, or `crisis_detected`.
Report and crisis mail require at least one recipient; error mail may use the
gateway's configured fallback recipients.

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
recipient scope, retention, and disclosure. Without that option, Mail adds no
path/profile fields to the report. HTTP subscription lookup may still load
the User at delivery without copying profile fields into the report. The
generated `source_at` timestamp, caller-supplied payload, subject, type, and recipients
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

Start `mail.start()` during application startup so pre-existing records are
scanned even when the application does not send a new report. Observe its
completion or error without holding page rendering behind the drain. The first
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
| `accepted` | The selected transport returned `accepted` with a valid request id. A provider id or acceptance authority may be preserved as optional transport metadata, but neither is required by the outbox. This is API acceptance, not an inbox-delivery claim. |
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
available at that transition. It never includes the Resend API key or
subscription key. Listener exceptions are observational and cannot change a
committed mail operation result.

Provider IDs, provider codes, and nonempty failure codes retain their complete
string values through delivery, persistence, and retrieval. They have no SDK
character grammar. Missing values retain the existing fallback behavior.
Request IDs and outbox filenames retain their existing contracts.

When both an explicit endpoint and native `Arcane.mail.send` exist, Mail uses
the configured HTTP endpoint so the authenticated SDK gateway can return its
complete provider result. The native bridge remains a fallback when no endpoint
is configured; an accepted Core result keeps its native acceptance-authority
metadata without an SDK allowlist. A malformed or unreadable native response
is retained as an uncertain same-key retry, while temporary native transport
unavailability is a non-ambiguous retryable failure. Once a valid accepted
result has returned, a racing lifecycle cancellation cannot erase that
committed acceptance result.

## Operate the CLI and gateway

### Mail CLI parameters

`mail serve` starts the shared mail server. `mail send` makes one direct Resend
request. `mail key set|status|delete` manages the provider credential.

| Parameter | Command | What it does | When omitted |
| --- | --- | --- | --- |
| `--app <label>` | `mail serve` | Supplies a fallback application label for server events. An incoming `X-Mail-App` supplies the request's label. This option does not choose a Stripe account or limit which apps may send mail. | Uses `mail.appId` when configured; otherwise adds no fallback label. |
| `--from <sender>` | `mail serve`, `mail send` | Overrides the sender, for example `"Dragon Dispatch <dispatch@example.com>"`. On the server, the override applies to every report. Resend must accept that sender. | Uses `mail.from` when configured, then the report's `from` or provider template default. |
| `--report-stdin` | `mail send` | Reads one complete UTF-8 report JSON object from redirected standard input, including recipients, subject, body, and other provider fields. | Required; the command reports a usage error. |
| `--report-key <id>` | `mail send` | Identifies one intended email and is forwarded unchanged as Resend's `Idempotency-Key`. Use a new value for a new email; reuse the value and unchanged report for an intentional retry. It is not a credential. | Required; the command reports a usage error. |
| `--host <address>` | `mail serve` | Selects the listener bind address. `0.0.0.0` accepts connections through all IPv4 interfaces. | Uses `mail.host`, then `0.0.0.0`. |
| `--port <number>` | `mail serve` | Selects the HTTPS listener port. Explicit `0` asks the operating system for an available port. | Uses `mail.port`, then `4433`. |
| `--origin <origin>` | `mail serve` | Replaces the configured CORS origins with one exact browser origin, including scheme and any nondefault port. Use the JSON `origins` array for multiple origins; repeated flags keep only the last value. | Uses `mail.origins`; an absent or empty list uses the current request authority. Requests without an `Origin` header continue normally. |
| `--allow-to <addresses>` | `mail serve` | Replaces the recipient allowlist with a comma-separated list. Applies to `to`, `cc`, and `bcc`, and supplies error-report fallback recipients unless `mail.errorRecipients` is configured separately. | Uses `mail.recipientAllowlist`; an absent or empty list leaves recipients unrestricted. |
| `--request-timeout <ms>` | `mail serve`, `mail send` | Sets the deadline for one Resend request, in milliseconds. A timeout after sending begins leaves delivery uncertain; it does not schedule a retry. | Uses `mail.providerTimeoutMs`; absent or null adds no provider deadline. |
| `--profile <name>` | `mail serve`, `mail send` | Selects an alternate saved Resend credential for this invocation. One listener uses that selected provider key for all callers. | Uses `mail.profile` if configured, otherwise the normal `mail.apiKey`. The single-key setup needs no profile setting. |
| `[profile]` | `mail key set\|status\|delete` | Optional positional name of the credential to manage; it is not a flag. | Manages the normal `mail.apiKey`, independently of `mail.profile`. |
| `--secret-stdin` | `mail key set` | Reads the Resend API key from deliberately redirected standard input instead of the hidden terminal prompt. | Prompts with hidden input. Machine-output mode requires redirected input. |
| `--output human\|json\|ndjson` | All mail commands | Selects readable console output, one JSON result, or newline-delimited JSON events. | Uses `human`. |
| `--help` | CLI | Displays CLI help instead of running the mail operation. | Runs the requested operation. |
| `--version` | CLI | Displays the SDK version instead of running the mail operation. | Runs the requested operation. |

There is no `--report` flag. `--report-stdin` supplies the message;
`--report-key` identifies that same message across attempts. Browser `Mail.send()`
generates and retains its report key automatically.

Mail reads configuration from the directory in which the command runs;
`--workspace` does not relocate these mail files. Mail HTTPS uses `mail.certPath`
and `mail.keyPath` in JSON. The `--cert`, `--key`, `--https`, and `--http-port`
flags belong to browser `dev`/`run`, and `--http` belongs to `dev`.

### Mail configuration

Keep app-supplied SDK settings under named capability members, starting with
`mail`. Put the nonsecret mail settings in `arcane.config.json` in the directory
from which the command runs:

```json
{
  "mail": {
    "host": "0.0.0.0",
    "port": 4433,
    "origins": [
      "https://dragons.example",
      "https://www.dragons.example"
    ],
    "certPath": "certificates/fullchain.pem",
    "keyPath": "certificates/private-key.pem"
  }
}
```

Put the Resend provider key in the separate `.arcane.env.json`:

```json
{
  "mail": {
    "apiKey": ""
  }
}
```

The SDK repository ignores `.arcane.env.json`. Keep the same entry in a consuming
project's `.gitignore`. `arcane.config.json` contains settings suitable for source
control; its certificate fields contain file paths, never PEM contents or provider
keys. Both files are read directly as JSON without copying values into
`process.env`. Other top-level capability members remain untouched. The portable
browser `arcane-os/mail` import does not read these Node-side files.

The supported `arcane.config.json.mail` fields are:

| Field | Type | Purpose and default |
| --- | --- | --- |
| `host` | string | Listener bind address; defaults to `0.0.0.0`. |
| `port` | integer | Listener port; defaults to `4433`. Explicit `0` selects an available port. |
| `origins` | string array | Exact allowed browser origins. An absent or empty list uses the current request authority as described below. |
| `profile` | string | Resend credential profile for send/serve; defaults to `mail`. |
| `from` | string | Optional shared sender override. Omit it to retain each report's sender or provider template default. |
| `appId` | string | Optional server event label; does not restrict incoming application names. |
| `recipientAllowlist` | string array | Optional allowed recipients; absent or empty means unrestricted recipients. |
| `errorRecipients` | string array | Error-report fallback recipients; defaults to the effective recipient allowlist. An explicit empty array supplies no fallback. |
| `bodyTimeoutMs` | integer or null | Optional request-body deadline in milliseconds; absent or null adds no deadline. |
| `providerTimeoutMs` | integer or null | Optional provider deadline in milliseconds; absent or null adds no deadline. |
| `retryableDelayMs` | positive integer | Retry guidance in a retryable result; defaults to `1000`. It does not schedule a retry. |
| `certPath` | string | PEM certificate-chain file path, required for gateway HTTPS. |
| `keyPath` | string | PEM private-key file path, required for gateway HTTPS. |

Resend is the supported provider; no provider selector is needed. Keep callbacks,
injected providers, `fetchImpl`, `onEvent`, `requestIdFactory`,
`verifySubscription`, and `AbortSignal` values in programmatic options. They are
runtime inputs, not JSON settings. Reports and their idempotency keys remain
inputs to each send operation.

The single-key configuration above needs no `profile` or `profiles` member.
Omitting the selection uses `.arcane.env.json.mail.apiKey`; multiple apps and
domains can share that provider key.

For callers that already select an alternate credential, named-profile support
remains available: `--profile <name>` or `mail.profile` selects
`.arcane.env.json.mail.profiles[name].apiKey`. An absent named profile does not
fall back to the default key. Selection happens once when send or serve starts;
it does not map incoming apps or domains to different provider accounts.
The profile selects Resend provider credentials, separately from the incoming
application name and subscriber key. Existing top-level `RESEND_API_KEY` and
`MAIL_PROFILES[profile].RESEND_API_KEY` remain supported. A nested selected
`apiKey` takes precedence when the property exists, including null or an empty
string, which means the selected key is absent. Only an absent nested key
property permits fallback to the corresponding legacy key.

Programmatic operations resolve both files from `options.cwd`, then
`options.workspaceRoot`, then `process.cwd()`, choosing the first supplied
directory. The CLI uses its invocation directory. There is no upward directory
search or dependency on a Windows installation directory or temporary-directory
environment variable. Missing files are optional configuration sources; send and
serve still report their missing required values before attempting delivery or
binding. Malformed or unreadable files produce an error.

Configuration precedence is explicit:

1. A CLI/API option overrides its file setting when its value is not `undefined`.
   An explicit null retains the option's existing meaning; it does not select
   the file value again.
2. `arcane.config.json.mail` supplies nonsecret settings absent from those options.
3. Legacy `.arcane.env.json` root `MAIL_TLS_CERT_PATH` and `MAIL_TLS_KEY_PATH`
   supply certificate paths absent from the selected options and config member.
4. Remaining settings use the defaults above.

The existing programmatic aliases `origin`, `allowTo`, `errorTo`, and
`requestTimeout` take precedence over their corresponding canonical options
`origins`, `recipientAllowlist`, `errorRecipients`, and `providerTimeoutMs` when
both are supplied. The CLI continues to expose `--origin`, `--allow-to`, and
`--request-timeout`. `origin` accepts a string or an array; the recipient aliases
accept address arrays or comma-separated strings. Lists replace the lower-priority
list completely. The configuration reader does not concatenate or deduplicate
lists, rewrite case, or automatically add local addresses.

Use the JSON `origins` array for multiple origins. Repeating the current
`--origin` option keeps only its last value; there is no `--origins` CLI option.
The CLI leaves omitted host, port, and send/serve profile options unset until
configuration resolves, so its defaults do not mask file settings.

Keep the configuration in the deployment directory even when the SDK is nested
below it:

```text
my-site/
├── arcane.config.json
├── .arcane.env.json
└── arcane-os-sdk/
    └── bin/arcane.mjs
```

Run from `my-site`, for example:

```sh
node ./arcane-os-sdk/bin/arcane.mjs mail serve
```

The SDK directory does not choose the configuration location. When upgrading
from SDK 0.22.1 or earlier, rename the existing `.env.json` to
`.arcane.env.json` in the invocation directory, preserving its contents.
The secret loader reads only `.arcane.env.json`; it does not read the old filename.
Existing root key, profile, and TLS fields can remain in that file. Adopting the
capability members does not perform an automatic rewrite or migration.

The existing key commands manage the same file:

```text
arcane mail key set
arcane mail key status
arcane mail key delete
```

`key set` prompts with hidden input. `--secret-stdin` is the explicit
non-interactive alternative and rejects a TTY. Each command accepts an optional
profile argument, defaulting to `mail` independently of `arcane.config.json.mail.profile`.
Set and delete preserve other JSON settings and profiles; status reports
existence without returning the key. A new credential is written to the nested
mail member. An existing legacy credential is updated at its existing location
unless the selected nested key property exists, in which case set updates that
nested property. Delete removes both representations of only the selected key,
so an older key cannot reappear through fallback. Other settings and profile
containers remain intact.
Results identify `storage: '.arcane.env.json'`. An already-absent deletion succeeds
with `exists: false`.

Existing Windows Credential Manager records remain untouched. The JSON path
does not read, migrate, or delete those records; populate the selected JSON
setting to use it. Missing files or missing/empty provider settings produce an
actionable startup/send error naming the file and exact setting. Unreadable or
invalid JSON is reported without including credential content in the error.

Perform one provider attempt directly from the SDK CLI:

```text
arcane mail send --from "Arcane <verified@example.com>" --report-key <stable-id> --report-stdin
```

The redirected UTF-8 JSON object is read completely. Its fields and values
are retained; the Resend adapter removes the SDK's `type` routing field,
uses `from` when configured (otherwise the report or provider template supplies
the sender). Direct sending supplies no fallback recipients. Resend evaluates
its own required provider fields. Message
content is not accepted in argv. Programmatic results and observer events
preserve the complete report, provider request, provider response, and error detail while
never exposing either credential.

The caller must create and retain a nonempty `--report-key` before the
attempt. It is the Resend idempotency key and may be reused only with the same
serialized report content for an intentional retry or reconciliation. The
CLI performs exactly one attempt and never retries automatically. Exit zero
requires a successful Resend response containing a nonempty string provider id; that is
provider acceptance, not an inbox-delivery claim. Timeout, connection loss, or
cancellation after the provider attempt begins is returned as an ambiguous
nonzero outcome because the provider may already have accepted the request.
Cancellation before the attempt exits 130 without sending.
For both CLI mail operations, `--request-timeout` accepts 1 through 2147483647
milliseconds, the Node timer range. The same range applies to configured body
and provider deadlines. When no provider timeout is selected in options or
configuration, the SDK adds no provider deadline.

`mail send` consumes the selected profile, sender, provider timeout, and retry
guidance from the same configuration. It does not require gateway TLS paths.
Send and serve read each required JSON file once, concurrently when both are
needed, before consuming their settings. An injected `readCredential` remains
the credential owner and reads once. With that injection, send reads only
`arcane.config.json`; serve also reads `.arcane.env.json` for legacy TLS paths
without interpreting its unused file credential.

Start the gateway:

```text
npm exec -- arcane mail serve
```

The default listener is `0.0.0.0:4433`; `mail.host` and `mail.port` select its
configured bind address and port, and explicit `--host` / `--port` override them.
The server can serve callers from multiple domains on the same machine.
Configure the caller's endpoint to reach that listener.

`mail serve` uses HTTPS with HTTP/2 on that selected port. The published
`node-http-server` PEM API owns TLS and negotiates HTTP/2 or HTTP/1.1 on the
same listener. It creates no additional plain-HTTP listener. The returned URL
uses `https://`; `0.0.0.0` is the bind address, so callers use the deployed
domain, for example `https://mail.example.com:4433/v1/mail`.

Set `arcane.config.json.mail.certPath` to the PEM certificate chain and
`mail.keyPath` to its PEM private-key file. These settings belong to the listener
and apply regardless of the selected provider profile. The legacy root
`MAIL_TLS_CERT_PATH` and `MAIL_TLS_KEY_PATH` fields in `.arcane.env.json` remain
fallbacks. Relative certificate paths resolve from the selected configuration
directory, including explicit programmatic path options; absolute paths are also accepted.
The certificate must cover the hostname callers use. One certificate may
cover multiple names; the gateway does not require one certificate per calling
application. Keep private-key files outside tracked source, such as in the
already-ignored `.arcane/` directory or an existing host certificate directory.

Startup reads each JSON file once, reports missing TLS settings before
binding, and lets the TLS owner report unreadable or unusable PEM files. It
does not generate certificates, modify system trust, or add a renewal watcher.
No JSON configuration file is reread for an incoming HTTP request.
Restart the gateway after the configured certificate files are renewed.
The same Node file and TLS APIs are used on Windows, Linux, and macOS; Android
requires a compatible Node host and accessible configuration and certificate
paths. These platform contracts are separate from actual platform execution.

The public `createToolchain().mail({action: 'serve', ...options})` operation
uses the same settings with explicit options taking precedence. Internally,
`startResendMailServer` accepts
`certPath` and `keyPath` and retains its existing HTTP behavior when neither
is supplied. That internal function is not an npm package export.

If the selected port is occupied, startup reports
`Mail port <port> is already taken, possibly by another mail server.`
The CLI exits with status 1. Programmatic callers receive the same message,
with native `EADDRINUSE` metadata and the original error retained as `cause`.
The existing listener remains running; this launch does not retry or select
another port.

`--app` is an optional server event label and does not restrict incoming
application names. `--from` and `mail.from` are optional shared sender overrides;
omit both to preserve each report's sender or its provider template's default.
`mail.origins` supplies an array of exact allowed caller origins. An explicit
`--origin` replaces that array; the programmatic `origin` alias also accepts an
array. With no origins configured, the gateway accepts an Origin matching its request
authority (`:authority` for HTTP/2, `Host` for HTTP/1.1) using HTTP or HTTPS.
An Origin outside the configured list or current-authority default receives
`403 mail_origin_not_allowed`. Origin strings are compared exactly: include the
scheme and any nondefault port, with no path or trailing slash. There are no
wildcards, subdomain expansion, normalization, or loopback exceptions.
Requests without an `Origin` header continue normally. This is a declared-origin
CORS list, not a client-IP or connecting-machine allowlist; ordinary
server-to-server requests commonly omit Origin.
Cross-origin preflight permits `Content-Type`, `Idempotency-Key`, `X-Mail-App`,
and `Authorization`.

`mail.recipientAllowlist` or explicit `--allow-to` limits recipients when
configured. An absent or empty effective list imposes no recipient allowlist.
When configured, the list applies to
every recipient in the resolved `to`, `cc`, and `bcc` fields, whether supplied
as a string or an array. Sender, recipient, subject, and body
values are not trimmed, lowercased, or filtered by an SDK email grammar at
the gateway. Error reports with an empty `to` array use configured fallback
recipients; other report content is preserved.

## Configure subscription verification

Subscription verification is disabled during initial setup when
`verifySubscription` is omitted. The server reports
`callerAuthentication: 'none'` and can perform mail delivery without a
subscription key. Starting the ordinary CLI gateway uses this mode. This does
not claim that a subscription was checked.

### Automatic same-IP exception

The gateway automatically skips subscription verification when the incoming
connection's nonempty `request.socket.remoteAddress` equals
`request.socket.localAddress`. This also applies when a verifier is configured
and the request has no subscription key or supplies an invalid one. The
verification callback is not called for that request.

No `.arcane.env.json` setting or domain allowlist is needed. The comparison uses
the actual source and destination IP addresses exposed by Node's request socket
for HTTP/1.1 and HTTP/2. It adds no DNS lookup, configuration read, cache, or
interface scan. `Origin`, `Host`, `Forwarded`, and `X-Forwarded-For` do not
establish the connection's IP equality.

| Caller connection | Subscription behavior with a verifier configured |
| --- | --- |
| The verification service connects to mail using the same source and destination IP | Skips subscription checking, allowing its service-generated emails without a subscriber key. |
| A local development request has equal source and destination IPs, including an ordinary loopback connection | Uses the same automatic exception. There is no special loopback rule. |
| Another machine on the same intranet connects from a different IP | Uses the configured subscription verifier. Sharing a network or subnet supplies no exception. |
| Two services on one machine connect through different interface IPs | Uses the configured subscription verifier when the actual addresses differ. Machine identity alone supplies no exception. |
| The request has no usable socket source address | Uses the configured subscription verifier; absent addresses do not count as equal. |

The exception skips only subscription checking. Existing CORS, route, method,
idempotency-key, report, recipient, and provider handling still apply. The gateway
continues to require its Resend provider credential and reports acceptance only
after the provider accepts the email.

### Verification callback contract

The hosting process enables verification by supplying the programmatic
`verifySubscription` function through
`createToolchain().mail({action:'serve', verifySubscription, ...options})`.
The server then reports `callerAuthentication: 'subscription'`, identifying the
configured mode while retaining the same-IP exception above. The callback
contract is:

```javascript
verifySubscription({appName, subscriptionKey, signal})
```

It may return a promise. Return exactly `true` for a valid subscription;
return `false` for an invalid one, and throw when the verifier service fails.
The gateway also treats any other returned value as invalid. `appName` is the
exact incoming `X-Mail-App` value, `subscriptionKey` is the incoming Bearer
key, and `signal` follows the request lifecycle. These control fields stay
separate from the mail report and Resend payload. The verifier runs for each
POST request outside the same-IP exception before any provider attempt; results
are not cached.

`X-Mail-App` identifies the originating app so the verifier can select that
app's subscription account, such as the appropriate Stripe account for `BOSS`
or `TWiN`. It is separate from the gateway's optional `--app` event label.
The missing-header and Bearer errors below apply only when `verifySubscription`
is configured and the same-IP exception does not apply. Ordinary `mail serve`
does not require either header.

| Configured-verifier outcome | Gateway response |
| --- | --- |
| Missing or empty `X-Mail-App` | `400 mail_invalid_headers` |
| Missing or malformed Bearer credential | `401 mail_subscription_required` |
| Callback returns anything except `true` | `401 mail_subscription_invalid` |
| Callback throws | `503 mail_subscription_verification_failed`, retryable with the configured `retryableDelayMs` |
| Request cancelled while verifying | `408 mail_request_cancelled`, with no provider attempt |

The `401` responses include `WWW-Authenticate: Bearer`. A successful callback
permits the existing mail-delivery path; it is not itself a mail-acceptance
result. The SDK supplies no default verification URL or built-in Stripe
endpoint adapter. Connecting the actual subscription endpoint is a separate
hosting integration.

The gateway uses Node's native header representations. HTTP/1.1 uses
`headersDistinct`, retaining its repeated-field detection. HTTP/2 uses the
compatibility request's `headers` object; Node owns duplicate joining or
discarding for each field. The SDK does not split a native header value again.

CLI startup output says `Subscription verification: disabled` or
`Subscription verification: configured`. Structured `server.ready` output
includes the corresponding `callerAuthentication` value.

## Error reports and retries

An incoming report with `type: 'error'` is an email supplied by its caller.
The gateway's `errorRecipients` setting only supplies fallback recipients for
that report when its `to` array is empty. A gateway or provider failure returns
an HTTP error and diagnostic events; it does not generate another error email.
Gateway event-handler failures are written to the console. Each POST and each
direct CLI send performs at most one provider attempt, with no automatic server retry.

The browser outbox retains the same report and key after a retryable delivery
failure. Each drain attempts each eligible record once; a later startup,
connectivity event, or explicit drain can retry it. Browser `Errors` notification
failure retains the same pending occurrence and logs a warning without scheduling
itself again.

A separate browser callback path can feed back into error reporting: a mail-event
subscriber that repeatedly throws can reach global error capture, create another
error report, and trigger another mail event. Subscriber failures cannot change
an already committed mail result, though global capture can report them as new
errors. This is a source-level possibility, not evidence of a deployed loop.

For a verification service's own emails sent through the same IP, the gateway
skips its subscription callback and proceeds to provider delivery. That removes
the circular dependency `mail -> verify subscription -> send mail -> verify
subscription` for this connection path. Connections from a different IP still
use the configured callback, whose owning service must preserve a verification
path that can return without recursively depending on another verification.
The exception does not change the separate browser event-subscriber behavior
described above.

## Gateway request lifecycle

The gateway uses the published `node-http-server` instance lifecycle. Its raw
request hook hands the original request and response directly to the mail
handler before body parsing or static routing. Socket inactivity timeout remains
disabled; caller-selected mail deadlines, cancellation, and complete responses
remain owned by the mail handler.

The gateway handles POST requests to `/v1/mail` and the corresponding OPTIONS
preflight. JSON parsing owns request readability; the gateway does not reject
a parseable body because of its Content-Type spelling. One nonempty
`Idempotency-Key` is forwarded unchanged to the fixed Resend endpoint. The
browser and gateway preserve complete request and response content without
body-size gates. With no event observer, the gateway does not construct event
payloads or parse a second provider-request representation for observation.

Requests whose path does not match `/v1/mail` receive `303 See Other` with an
empty body and `Location: https://<current-hostname>/404.html`. The destination
uses the request's HTTP/2 authority or HTTP/1.1 Host hostname, omits the API port,
and replaces the requested path and query. For example:

| Unmatched request URL | Redirect destination |
| --- | --- |
| `https://mail.thewizardnexus.com:4433/` | `https://mail.thewizardnexus.com/404.html` |
| `https://mail.precrisis.ai:4433/missing?example=1` | `https://mail.precrisis.ai/404.html` |

The HTTPS website on the current hostname owns that page. The mail listener
only returns the redirect. Requests to `/v1/mail`, including its query-bearing
form, retain the existing CORS policy, OPTIONS preflight, method handling, and
structured API errors. For example, `GET /v1/mail` still receives `405`.
Subscription verification and its automatic same-IP exception remain unchanged.

The gateway returns `202` only after Resend returns a nonempty string provider id.
Transport loss, an explicit caller-selected timeout, an invalid success body,
or an unreadable provider response returns an explicit uncertain result and never claims
delivery. Rate limits, concurrent idempotency requests, permanent validation
failures, and provider failures are mapped to structured retryable/permanent
results with the complete available provider response or error detail.

## Operational verification

The focused SDK tests use synthetic keys, addresses, responses, storage,
and local HTTP requests. They do not contact Resend or send email. A live
acceptance send is a separate operational boundary: use a disposable message,
the selected recipient configuration and credential profile, then verify both the
gateway's provider-acceptance id and the intended inbox outcome.
