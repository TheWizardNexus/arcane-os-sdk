# Arcane API namespace guides

These namespace guides explain how related Arcane API members work together.
The individual method guides provide the exact parameters, resolved values,
errors, and focused examples for each call.

## Arcane.events

### Overview

`Arcane.events` is the application-facing event hub for messages delivered by
the bound Arcane host. It provides four synchronous subscription and observation
methods:

| Member | Use |
| --- | --- |
| `Arcane.events.on(eventName, listener)` | Observe every future matching event until unsubscribed. |
| `Arcane.events.once(eventName, listener)` | Observe the next future matching event, then unsubscribe automatically. |
| `Arcane.events.when(eventName, listener)` | Observe a designated durable completion, including an asynchronous replay when it already occurred. |
| `Arcane.events.completed(eventName)` | Check whether a designated durable completion has already been observed. |

Use a named subscription when the application knows the event it needs. A named
listener receives that event's data payload directly. A wildcard subscription
uses the event name `"*"` and receives an envelope shaped as
`{ event, data }`. Wildcard delivery is useful for bounded diagnostics, but it
should not replace named subscriptions in application logic. Some event
payloads can contain credentials or other sensitive values, so do not log
wildcard `data` indiscriminately.

See the [Arcane event catalog](../../arcane-events.md) for event names, triggers,
payloads, and host-specific availability.

### Delivery and replay model

Ordinary events are live and future-only. They are not retained for a late
subscriber. This includes progress, terminal streams, terminal exits, and
appearance changes. `on()` and `once()` never replay an earlier ordinary event.

Only `transport.ready` and `core.ready` are designated durable completions. The
first payload for each completion is snapshotted and frozen before listeners
run. Later occurrences do not replace it. `when()` delivers a future first
completion like a one-time subscription, or queues the stored first payload for
asynchronous delivery when the completion already occurred.

`transport.ready` means that the document selected a callable Arcane transport.
It does not prove that Core is healthy, that a method is admitted, or that a
capability is granted. `core.ready` reports the host's readiness event; use the
method-specific capability and status APIs for authorization and service state.

### Listener safety and cleanup

Every subscription method returns an unsubscribe function. Retain it and call it
when the component, view, or document no longer owns the listener. Calling an
unsubscribe function again is harmless.

Listener exceptions are caught and logged so one listener cannot stop delivery
to the remaining listeners. Handle expected failures inside the listener when
the application needs to surface or recover from them; an exception thrown by a
listener is not reported to the event producer.

### Example

```javascript
const events = globalThis.Arcane?.events;

if (!events?.on) {
    throw new Error('Arcane event delivery is unavailable in this document.');
}

const unsubscribe = [
    events.on('operation.progress', function reportOperationProgress(data) {
        console.log('Operation progress', data.progress, data.message);
    }),
    events.on('*', function reportObservedEvent({event}) {
        console.debug('Arcane event', event);
    })
];

function stopObserving() {
    for (const off of unsubscribe.splice(0)) {
        off();
    }
}

globalThis.addEventListener('pagehide', stopObserving, {once: true});
```
## Arcane.terminal

### Overview

`Arcane.terminal` owns a bounded native terminal-session lifecycle. It can start
and enumerate app-owned sessions, write input, update dimensions, send a
supported control signal, and request closure. Process output and final exit
state arrive through `Arcane.events`; they are not returned by `write()`,
`signal()`, or `close()`.

Terminal access is deliberately narrow. The bound application must have the
exact id `terminal`, must be granted `terminal.execute`, and must run through an
admitted Core or Android host. Other applications do not receive terminal access
by default, and a standalone browser preview is not a native terminal host.

### Availability and capability check

Feature detection answers whether the JavaScript surface was projected into the
document. `Arcane.capabilities.list()` confirms the bound application identity,
grants, and exact admitted RPC methods. Check both before presenting a terminal
workflow.

The complete namespace contains these methods:

| Member | Purpose |
| --- | --- |
| `Arcane.terminal.start(options?)` | Start one native session. |
| `Arcane.terminal.list()` | Return the wrapper containing current app-owned sessions. |
| `Arcane.terminal.write(sessionId, data)` | Write one nonempty UTF-8 input chunk. |
| `Arcane.terminal.resize(sessionId, columns, rows)` | Update the session's bounded dimensions. |
| `Arcane.terminal.signal(sessionId, signal?)` | Request `interrupt` or `terminate`. |
| `Arcane.terminal.close(sessionId)` | Request session closure. |

The host admits at most eight concurrent sessions for the application. Session
identifiers are opaque strings returned by `start()` or `list()`; do not invent,
parse, or persist them as durable identities.

### Session lifecycle

Subscribe to terminal events before calling `start()`. A newly spawned process
may produce output immediately, and the output forwarding path is active before
the start response reaches application code. Buffer early events by `sessionId`
until the returned session identifies the process of interest.

The normal lifecycle is:

1. Confirm the feature, application id, grant, and admitted methods.
2. Subscribe to `terminal.output`, `terminal.exit`, and `terminal.error`.
3. Call `start()` and retain the returned session object.
4. Use `write()`, `resize()`, and, when necessary, `signal()`.
5. Call `close()` when the application is finished with the session.
6. Treat `terminal.exit` as the process-completion observation.
7. Unsubscribe every listener during teardown.

An accepted write, signal, or close request is not command completion or process
exit. In particular, `close()` resolves when the host accepts the close request;
observe `terminal.exit` for the final process outcome.

### Shared values

`start()` resolves to this exact session shape:

| Property | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Opaque session identifier, at most 128 characters. |
| `shell` | `string` | Resolved shell name. |
| `cwd` | `string` | Resolved working directory. |
| `title` | `string` | Host-provided display title. |
| `columns` | `number` | Accepted column count, from 20 through 500. |
| `rows` | `number` | Accepted row count, from 5 through 200. |
| `createdAt` | `string` | Host timestamp for session creation. |

`list()` resolves to `{ sessions }`, not directly to an array. Each list entry
contains `id`, `shell`, `cwd`, `columns`, `rows`, `createdAt`, and `state`.
Supported state values are `starting`, `running`, `exited`, and `closed`, though a
host may remove a completed session from the current inventory promptly.

### Terminal events

Terminal events are ordinary, future-only events:

| Event | Trigger | Data payload |
| --- | --- | --- |
| `terminal.output` | The host reads a stdout or stderr chunk. | `{ sessionId, stream, data }`, where `stream` is `"stdout"` or `"stderr"` and `data` is a string. |
| `terminal.exit` | The process exits and the host retires the session. | `{ sessionId, exitCode, signal }`; `exitCode` or `signal` may be `null`. |
| `terminal.error` | A host reports an asynchronous stream/session error. | `{ sessionId, message }`; currently used by the Android provider for output-limit and stream-read failures. |

Output payloads are chunks, not lines. A chunk may contain part of a line,
several lines, or terminal control sequences. Preserve arrival order per session
and use a terminal-aware renderer when displaying native output.

### Platform behavior

On Microsoft NT Core hosts, `auto` resolves to PowerShell. PowerShell, Command
Prompt, and an installed Bash are selectable; POSIX `sh` is unavailable. On
Linux Core hosts, `auto` resolves to Bash, `sh` selects `/bin/sh`, PowerShell
requires an installed `pwsh`, and Command Prompt is unavailable.

On Android, terminal execution is confined to the Arcane Terminal application's
ordinary app identity and private files area. Only `auto` and `sh` are accepted,
and both resolve to the application-sandbox `/system/bin/sh`. Android stops a
session after one MiB of emitted output and reports the condition through
`terminal.error`.

### Errors and recovery

Rejected operations use `Arcane.Error`. Read `code`, `message`, and `resolution`
instead of matching the message text. Common terminal failures include:

| Code | Recovery |
| --- | --- |
| `METHOD_NOT_ALLOWED` | Open Arcane Terminal through an admitted host; another app cannot self-grant `terminal.execute`. |
| `ARCANE_TRANSPORT_UNAVAILABLE` | Open the application through the installed Arcane host or its development launcher. |
| `METHOD_CONTRACT_INPUT_INVALID` or `TERMINAL_REQUEST_INVALID` | Send only the documented values and bounds. |
| `TERMINAL_SESSION_LIMIT` | Close an existing session before starting another. |
| `TERMINAL_SHELL_INVALID` or `TERMINAL_SHELL_UNAVAILABLE` | Select a supported shell for the active platform. |
| `TERMINAL_CWD_INVALID` | Choose an existing accessible directory allowed by the host sandbox. |
| `TERMINAL_START_FAILED` | Verify that the selected shell is installed and available. |
| `TERMINAL_SESSION_INVALID` or `TERMINAL_SESSION_NOT_FOUND` | Refresh with `list()` or start a new session; do not reuse a retired id. |
| `TERMINAL_DATA_INVALID` or `TERMINAL_INPUT_CLOSED` | Send a nonempty chunk no larger than 64 KiB to a running session. |
| `TERMINAL_SIGNAL_INVALID` | Use only `interrupt` or `terminate`. |

### Example

```javascript
const arcane = globalThis.Arcane;
const terminal = arcane?.terminal;
const events = arcane?.events;

if (!terminal?.start || !events?.on || !arcane?.capabilities?.list) {
    throw new Error('Open Arcane Terminal from an admitted Arcane host.');
}

const access = await arcane.capabilities.list();
const requiredMethods = [
    'terminal.start',
    'terminal.list',
    'terminal.write',
    'terminal.resize',
    'terminal.close'
];

if (
    access.app?.id !== 'terminal'
    || !access.grants.includes('terminal.execute')
    || !requiredMethods.every(function isRequiredTerminalMethodAdmitted(method) {
        return access.methods.includes(method);
    })
) {
    throw new Error('This application is not admitted for terminal execution.');
}

const earlyOutput = new Map();
const observedExits = new Map();
const exitWaiters = new Map();
const maxBufferedChunksPerSession = 128;
let activeSessionId = null;
let session = null;

function displayOutput({stream, data}) {
    const write = stream === 'stderr' ? console.error : console.log;
    write(data);
}

const offOutput = events.on('terminal.output', function handleTerminalOutput(payload) {
    if (payload.sessionId === activeSessionId) {
        displayOutput(payload);
        return;
    }
    const chunks = earlyOutput.get(payload.sessionId) ?? [];
    chunks.push(payload);
    // Bound pre-identification buffering; surface truncation in a real UI.
    if (chunks.length > maxBufferedChunksPerSession) {
        chunks.shift();
    }
    earlyOutput.set(payload.sessionId, chunks);
});

const offExit = events.on('terminal.exit', function handleTerminalExit(payload) {
    observedExits.set(payload.sessionId, payload);
    const waiter = exitWaiters.get(payload.sessionId);
    if (waiter) {
        clearTimeout(waiter.timer);
        exitWaiters.delete(payload.sessionId);
        waiter.resolve(payload);
    }
});

const offError = events.on('terminal.error', function handleTerminalError(payload) {
    console.error(`Terminal ${payload.sessionId}: ${payload.message}`);
});

function waitForExit(sessionId, timeoutMs = 5000) {
    if (observedExits.has(sessionId)) {
        return Promise.resolve(observedExits.get(sessionId));
    }
    return new Promise(function createExitWait(resolve, reject) {
        const timer = setTimeout(function rejectTimedOutExitWait() {
            exitWaiters.delete(sessionId);
            reject(new Error(`Timed out waiting for ${sessionId} to exit.`));
        }, timeoutMs);
        exitWaiters.set(sessionId, {resolve, timer});
    });
}

try {
    session = await terminal.start({
        shell: 'auto',
        cwd: '',
        columns: 120,
        rows: 32
    });
    activeSessionId = session.id;

    for (const payload of earlyOutput.get(session.id) ?? []) {
        displayOutput(payload);
    }
    earlyOutput.delete(session.id);

    await terminal.resize(session.id, 100, 30);
    const {sessions} = await terminal.list();
    console.log('Owned sessions', sessions);

    const lineEnding = ['powershell', 'cmd'].includes(session.shell)
        ? '\r\n'
        : '\n';
    await terminal.write(
        session.id,
        `echo Arcane terminal ready${lineEnding}`
    );

    const exitPromise = waitForExit(session.id);
    const closeResult = await terminal.close(session.id);
    console.log('Close request accepted', closeResult.accepted);

    const exit = await exitPromise;
    console.log('Process exited', exit.exitCode, exit.signal);
} catch (error) {
    if (error instanceof arcane.Error) {
        console.error(error.code, error.message, error.resolution);
    } else {
        throw error;
    }
} finally {
    if (session && !observedExits.has(session.id)) {
        await terminal.close(session.id).catch(function ignoreTerminalCloseFailure() {});
    }
    offOutput();
    offExit();
    offError();
    for (const waiter of exitWaiters.values()) {
        clearTimeout(waiter.timer);
    }
    exitWaiters.clear();
}
```

## Arcane.protocol

### Overview

`Arcane.protocol` is the immutable wire-protocol identifier used by the current
renderer bridge. Its value is currently the string `"arcane/1"`. It identifies
the message format; it does not establish connection health, host trust,
application admission, or feature availability.

### When to use

Use this value in diagnostics or compatibility checks that need to distinguish
the Arcane message contract. Do not use it as a capability or security decision.

### Example

```javascript
const protocol = globalThis.Arcane?.protocol;

if (protocol !== 'arcane/1') {
    throw new Error('This document does not expose the expected Arcane protocol.');
}
```

## Arcane.Error

### Overview

`Arcane.Error` is the normalized error constructor used for rejected native API
requests. Instances always provide `code` and `message`; `resolution`,
`diagnosticId`, `technicalMessage`, `hresult`, `causeName`, and other bounded
diagnostic fields are present when the host supplied them. Native request
failures reject with this type, while synchronous JavaScript argument checks can
throw `TypeError` before a request is sent.

### Error handling

Branch on `code`, retain `diagnosticId` for support, and show `resolution` when
available. Do not match changing message prose or log sensitive request or result
data merely because an error object contains technical context.

### Example

```javascript
try {
    await globalThis.Arcane.system.ping();
} catch (error) {
    if (error instanceof globalThis.Arcane.Error) {
        console.error(error.code, error.resolution ?? error.message);
    } else {
        throw error;
    }
}
```

## Arcane.runtime

### Overview

`Arcane.runtime` owns renderer-local transport inspection. Its snapshot is
synchronous and frozen, and obtaining it sends no RPC. Transport connection,
native-host class, and managed-local-AI host class are descriptive facts rather
than health, admission, or trust claims.

### When to use

Use this namespace to adapt presentation to standalone, development HTTP,
WebView2, WebKitGTK, or Android WebView environments. Use
`Arcane.capabilities.list()` and method-specific status calls for authority and
service readiness.

### Example

```javascript
const runtime = globalThis.Arcane?.runtime?.current?.();

if (runtime) {
    console.log(runtime.transport, runtime.connected, runtime.native);
}
```

## Arcane.ai

### Overview

`Arcane.ai` is the provider-neutral surface for model inventory, effective AI
profile, chat, provider settings, and account-visible provider models. It keeps
application code above raw provider protocols. Request and result objects use
the checked contracts linked from the canonical method pages.

### Availability and security

Inference requires `ai.inference`. Raw local inventory is restricted to
Settings, Shell, and Terminal with `ai.models.read`; provider settings and model
discovery are Settings-only with `ai.settings.manage`. Credentials stay inside
the native settings boundary and must not be logged or copied into prompts.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canChat = access.methods.includes('ai.chat');

console.log('Provider-neutral chat admitted:', canChat);
```

## Arcane.environment

### Overview

`Arcane.environment` manages the Vault application's authorized environment
profile. It separates listing, protected reads, writes, and deletion, and marks
known sensitive names as protected by default when `set()` is called without an
explicit protection choice.

### Availability and security

The namespace is restricted to app id `vault` on Core or Android hosts.
Listing requires `environment.read`, protected reads require
`environment.protected.read`, and mutations require `environment.write` and an
exclusive mutation boundary. Never print protected values in examples or logs.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canListEnvironmentNames = access.methods.includes('environment.list');

console.log('Environment inventory admitted:', canListEnvironmentNames);
```

## Arcane.mail

### Overview

`Arcane.mail` sends one bounded, already-prepared report through the native mail
gateway. It does not provide an interactive composer and a successful result
must be interpreted using its sent, partial, uncertain, and status fields rather
than as a blanket delivery guarantee.

### Availability and security

`mail.send` requires the `mail.send` capability, is limited to explicitly
admitted report applications, and is currently Core-hosted rather than
Android-hosted. Treat recipients and report content as sensitive and use a
stable report key to avoid ambiguous duplicates.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canSendReports = access.methods.includes('mail.send');

console.log('Native report delivery admitted:', canSendReports);
```

## Arcane.speech

### Overview

`Arcane.speech` exposes independent local speech status, synthesis, and
transcription through the native host. The status result keeps Kokoro and
Whisper readiness separate; successful readiness for one role does not imply
readiness for the other.

### Availability and security

All speech methods require `ai.inference`. Desktop Core uses its admitted fixed
local services; admitted Android applications use bounded native providers.
Transcription accepts only the documented bounded canonical audio envelope, and
applications should not retain microphone audio without an explicit need.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadSpeechStatus = access.methods.includes('speech.status');

console.log('Speech status admitted:', canReadSpeechStatus);
```

## Arcane.localAI

### Overview

`Arcane.localAI` is the policy-filtered local-AI control surface. It covers
readiness, Provisioner reconciliation, admitted service recovery, verified
parallel-request configuration, and an application-owned isolated-model
inspection and question lifecycle. Application selectors should use its
admitted catalog rather than raw Ollama inventory.

### Availability and security

Status requires `ai.inference`; lifecycle methods add app-id, app-type,
privilege, host, and exclusive-mutation restrictions. Parallel-request mutation
is Core-only, privileged, requires `ai.runtime.manage`, and is admitted only to
the owning application. Isolated operations are restricted to their owning
application. Long operations can emit `operation.*`; isolated questions correlate
`localai.isolated.phase` by `operationId`.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canInspectLocalAI = access.methods.includes('localai.status');

console.log('Policy-filtered local AI status admitted:', canInspectLocalAI);
```

## Arcane.ollama

### Overview

`Arcane.ollama` exposes admitted Ollama inference, raw diagnostic inventory,
managed selection and settings, and policy-controlled model management. Raw
provider inventory is not an application's model-admission catalog. Streaming
calls can deliver correlated `ollama.chunk` events or an `onChunk` callback.

### Availability and security

Inference requires `ai.inference`; diagnostic inventory requires
`ai.models.read` and is limited to Settings, Shell, and Terminal. Mutations use
`ai.models.manage` or Settings-only `ai.settings.manage`, frequently behind an
exclusive mutation boundary. Android user-managed loopback admission exposes
chat only and does not grant managed model lifecycle authority.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canUseOllamaChat = access.methods.includes('ollama.chat');

console.log('Native Ollama chat admitted:', canUseOllamaChat);
```

## Arcane.app

### Overview

`Arcane.app` reads the immutable application identity bound to the current host
session. The descriptor includes the app-owned id, display name, type, entry,
version, and bounded trust-status fields. It is session evidence, not a
caller-supplied identity.

### Availability and security

`app.current` is a capability-free provider read on Core and Android. An
Android app reports its independently packaged version and currently reports
unverified publisher status; the OS bundle version remains separate.

### Example

```javascript
const app = await globalThis.Arcane.app.current();

console.log(app.id, app.displayName, app.version);
```

## Arcane.applications

### Overview

`Arcane.applications` provides the application catalog visible to the bound
Shell or Terminal session and requests launch by canonical application id.
Catalog visibility and launchability are host-policy decisions; applications
cannot register or launch arbitrary executables through this namespace.

### Availability and security

Listing requires `applications.read`; launching requires
`applications.launch`. Both are restricted to Shell or Terminal on Core and
Android. Android launch resolves only a generated package installed for the
selected catalog entry.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canListApplications = access.methods.includes('apps.list');

console.log('Application catalog admitted:', canListApplications);
```

## Arcane.external

### Overview

`Arcane.external` requests a policy-validated operating-system handoff for an
external URI. The current public contract accepts only a tightly validated
`mailto:` URI. An `opened` result means the operating system accepted the
handoff, not that a composer opened or a message was sent.

### Availability and security

`external.open` requires the `external.open` capability on Core or Android.
The host rejects whitespace, fragments, backslashes, malformed escapes,
encoded controls, and unsupported schemes before any handoff.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canRequestExternalOpen = access.methods.includes('external.open');

console.log('External URI handoff admitted:', canRequestExternalOpen);
```

## Arcane.repository

### Overview

`Arcane.repository` is the parent for application-owned repository services.
The shared bridge projects fixed, package-owned workflows, while each owning
application reference defines the exact data and mutation contract.

### Availability and security

Every child method is restricted by its application id and a repository-specific
read or write capability. Repository identities, branches, paths, and mutation
rules are fixed by native policy; callers cannot supply credentials, remotes, or
an arbitrary checkout.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const repositoryMethods = access.methods.filter(
    function selectRepositoryMethod(method) {
        return method.startsWith('repository.');
    }
);

console.log('Admitted repository methods:', repositoryMethods);
```

## Arcane.capabilities

### Overview

`Arcane.capabilities` returns the bound application descriptor, sorted grants,
and exact method allowlist for the current session. This is the authoritative
application-side preflight for method admission; checking that a JavaScript
function exists is not enough because the shared surface is projected broadly.

### Availability and security

`capabilities.list` is a read-only bridge method. Its result describes current
admission but does not grant authority, prove dependency readiness, or replace
method-specific status and error handling. The direct method is Core-only;
Android callers with `system.read` use
`Arcane.platform.status().capabilities` for the same nested snapshot.

### Example

```javascript
const {app, grants, methods} = await globalThis.Arcane.capabilities.list();

console.log(app.id, grants.length, methods.length);
```

## Arcane.platform

### Overview

`Arcane.platform` returns bounded host platform, renderer, permission,
capability, and execution-evidence status. It distinguishes actual host platform
from simulated effective platform and keeps presentation labels separate from
authorization.

### Availability and security

`platform.status` requires `system.read` and is available on admitted Core and
Android hosts. Treat the result as status evidence, never as a substitute for a
capability check or a publisher, update, or release attestation.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadPlatform = access.methods.includes('platform.status');

console.log('Platform evidence admitted:', canReadPlatform);
```

## Arcane.permissions

### Overview

`Arcane.permissions` reports effective elevation and permission status exposed
by the native host. It helps explain whether an operation may require operating-
system authorization, but it does not itself approve or perform that operation.

### Availability and security

`permissions.status` requires `system.read`. Permission status can change, and
every privileged method still rechecks its own policy and operating-system
boundary when invoked.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadPermissions = access.methods.includes('permissions.status');

console.log('Permission status admitted:', canReadPermissions);
```

## Arcane.version

### Overview

`Arcane.version` separates the Arcane OS bundle or host version from
installation status. `current()` is the session's OS version even when an
application owns a different package version; `installation()` is an alias-like
read of the installation-status method.

### Availability and security

`version.current` is capability-free on Core and Android.
`version.installation` requires `installation.read` and may not be admitted to
the same applications. Neither result proves signing, update continuity, or
release-candidate acceptance.

### Example

```javascript
const version = await globalThis.Arcane.version.current();

console.log('Arcane OS host version:', version);
```

## Arcane.machine

### Overview

`Arcane.machine` exposes the Provisioner's bounded machine readiness and status
view. It is intended for planning and reconciliation, not general application
fingerprinting or unrestricted hardware inspection.

### Availability and security

`machine.status` requires `provisioning.manage` and the `provisioner` app type.
Other applications cannot gain this authority by calling the shared JavaScript
function directly.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadMachineStatus = access.methods.includes('machine.status');

console.log('Machine readiness admitted:', canReadMachineStatus);
```

## Arcane.user

### Overview

`Arcane.user` reads the privacy-minimized identity bound to the current host
session. Desktop Core can return a host-account identity; Android returns an
anonymous local-session identity with null account identifiers.

### Availability and security

`user.current` takes no parameters, requires `identity.read`, and is available
on Core and Android. Use only fields returned by the host and do not infer a
cross-device or durable person identity from the record.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadIdentity = access.methods.includes('user.current');

console.log('Bound identity read admitted:', canReadIdentity);
```

## Arcane.requirements

### Overview

`Arcane.requirements` reads the installation requirement inventory and lets the
Provisioner ensure selected requirements. Omitting the requirement-id array
selects only requirements marked required; `null` and an empty array have the
same default. The interruption option is exactly `"deny"` or `"allow"` and
defaults to `"deny"`.

### Availability and security

Listing requires `requirements.read`. Ensuring requires
`provisioning.manage`, the `provisioner` app type, privilege, and an exclusive
mutation boundary. `"allow"` does not bypass native process-identity and port
proof before an existing user process can be interrupted.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canListRequirements = access.methods.includes('requirements.list');

console.log('Requirement inventory admitted:', canListRequirements);
```

## Arcane.installation

### Overview

`Arcane.installation` reports installation status, lets the Provisioner ensure
the required installed state, and can request the globally installed Microsoft
NT uninstaller. Ensuring and opening the uninstaller are distinct operations;
the latter does not uninstall through checkout-local code.

### Availability and security

Status requires `installation.read`. Ensure and uninstaller access require
`provisioning.manage` and the `provisioner` app type; ensure is privileged and
exclusive. A returned `opened` value means process creation was accepted, not
that confirmation or uninstall completed.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadInstallation = access.methods.includes('installation.status');

console.log('Installation status admitted:', canReadInstallation);
```

## Arcane.users

### Overview

`Arcane.users` owns the Provisioner's bounded account inventory, validation,
creation, activation, temporary-password flow, and shell verification or
restoration. Usernames are explicit inputs; password application is separate
from password reset so the application can control disclosure and confirmation.

### Availability and security

Every method requires `users.manage` and the `provisioner` app type. Account and
shell mutations add privilege or exclusive-mutation controls as declared by
policy. Temporary passwords are sensitive: never log, persist, or place them in
diagnostic examples.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canValidateUsers = access.methods.includes('users.validate');

console.log('User validation admitted:', canValidateUsers);
```

## Arcane.system

### Overview

`Arcane.system` groups bounded operating-system session lock, bridge ping,
allowed metrics, and Settings-owned verification-failure policy. Ping proves
only that the host admitted and answered one request; it is not a health,
privilege, trust, or release-readiness result.

### Availability and security

Ping is capability-free on Core and Android. Metrics require
`system.metrics.read`; lock requires `session.control` and the Shell app type.
Failure-policy reads and writes are Settings-only through preference
capabilities, and writes are exclusive.

### Example

```javascript
const result = await globalThis.Arcane.system.ping();

console.log('Host answered:', result.ok);
```

## Arcane.network

### Overview

`Arcane.network` exposes a privacy-bounded connectivity snapshot containing only
`online` and `interfaceCount`. It counts interfaces with at least one
non-loopback address and returns no interface name or address.

### Availability and security

`network.status` requires `network.status.read` on Core or Android. `online`
does not prove Internet access, DNS, route, captive-portal, or service
reachability; probe the specific admitted service when that distinction matters.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadNetworkStatus = access.methods.includes('network.status');

console.log('Privacy-bounded network status admitted:', canReadNetworkStatus);
```

## Arcane.firewall

### Overview

`Arcane.firewall` exposes Firewall-app-only policy status, bounded audit, and
explicitly confirmed lifecycle operations for Arcane-owned development
simulation state. Mutation requests must carry the current positive policy and
machine-state generations; stale expectations fail instead of silently applying
to a different state.

### Availability and security

Reads require `firewall.read`; mutations require `firewall.manage`, the
`firewall` app id, Core, privilege, and an exclusive mutation boundary. Audit
`limit` defaults to 100 and must be an integer from 1 through 200. Current live
machine-wide mutation is unsupported; simulation must remain labeled.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadFirewallStatus = access.methods.includes('firewall.status');

console.log('Firewall review admitted:', canReadFirewallStatus);
```

## Arcane.filesystem

### Overview

`Arcane.filesystem` owns native directory selection. It returns a host-reviewed
selection rather than granting arbitrary path traversal or a general-purpose
filesystem API. The optional picker argument must be a non-array object.

### Availability and security

Directory selection requires `filesystem.directory.select`. The native picker,
host sandbox, and application policy remain authoritative for what can be
selected and what later operations may do with the returned path.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canSelectDirectory = access.methods.includes('filesystem.directory.select');

console.log('Directory picker admitted:', canSelectDirectory);
```

## Arcane.storage

### Overview

`Arcane.storage` is app-scoped native key/value storage. It supports inventory,
read, write, and delete without exposing another application's namespace.
Values must satisfy the method's bounded JSON-compatible contract.

### Availability and security

Listing and get require `storage.read`; set and delete require `storage.write`.
Storage admission is not permission to store credentials, protected health
information, or other sensitive data without the owning application's explicit
data policy.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canListStorage = access.methods.includes('storage.list');

console.log('App storage inventory admitted:', canListStorage);
```

## Arcane.preferences

### Overview

`Arcane.preferences` stores app-scoped user preferences. It supports individual
reads and writes plus an atomic `setMany()` batch; the batch accepts a plain
object with one through 32 entries and changes nothing when any entry is invalid.

### Availability and security

Reads require `preferences.read`; mutations require `preferences.write`.
Preferences are for bounded settings, not secrets or large application records.
Synchronous wrapper validation can throw `TypeError` before `setMany()` sends an
RPC.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadPreferences = access.methods.includes('preferences.list');

console.log('Preference inventory admitted:', canReadPreferences);
```

## Arcane.appearance

### Overview

`Arcane.appearance` reads and applies the native appearance contract. Host
appearance changes can also arrive as the future-only `appearance.changed`
event; application code should use the returned and event payload fields rather
than infer theme state from operating-system internals.

### Availability and security

Current-state reads require `appearance.read`; applying values requires
`appearance.write`. The host validates the bounded appearance object. A method
result or event is presentation state and must never grant authority.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadAppearance = access.methods.includes('appearance.current');

console.log('Native appearance read admitted:', canReadAppearance);
```

## Arcane.session

### Overview

`Arcane.session` owns the current operating-system session lifecycle. Its logout
request is not an Arcane-only application exit and can end the user's host
session, so it belongs behind a clear, separate confirmation journey.

### Availability and security

`session.logout` requires `session.control`, the Shell app type, and an
exclusive mutation boundary. Feature detection is safe; this guide deliberately
does not invoke logout in its example.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canRequestLogout = access.methods.includes('session.logout');

console.log('Operating-system logout admitted:', canRequestLogout);
```

## Arcane.provisioning

### Overview

`Arcane.provisioning` creates a non-applying plan for one username or an array of
usernames. Planning separates validation and review from privileged user,
requirement, and installation mutations.

### Availability and security

`provisioning.plan` requires `provisioning.manage` and the `provisioner` app
type. A returned plan is evidence for review, not proof that any account or
machine change occurred.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canPlanProvisioning = access.methods.includes('provisioning.plan');

console.log('Provisioning plan admitted:', canPlanProvisioning);
```

## Arcane.diagnostics

### Overview

`Arcane.diagnostics` reads a bounded recent-error summary and retrieves one
structured diagnostic by id. Diagnostic ids are opaque correlation values; they
are not filesystem paths or authorization tokens.

### Availability and security

Both methods require `diagnostics.read`. Diagnostic records can contain
technical context, so applications should minimize display and retention and
must not assume the capability permits exposing them to another user or service.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canReadDiagnostics = access.methods.includes('diagnostics.recent');

console.log('Recent diagnostics admitted:', canReadDiagnostics);
```

## Arcane.development

### Overview

`Arcane.development` supports approved-workspace inspection, bounded source
context, allowlisted setup tasks, and installation of the supported Node.js
development runtime. It is a development tool surface, not arbitrary command
execution.

### Availability and security

Inspect and context require `development.read`; setup and Node installation
require `development.manage` and the `developer` app id. Setup is exclusive;
Node installation is additionally privileged. Roots and task ids remain subject
to native allowlists and path validation.

### Example

```javascript
const access = await globalThis.Arcane.capabilities.list();
const canInspectWorkspace = access.methods.includes('development.inspect');

console.log('Development workspace inspection admitted:', canInspectWorkspace);
```
