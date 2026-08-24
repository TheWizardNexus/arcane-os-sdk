# Arcane API applications, terminal, and capabilities guides

The terminal methods are available only to the application whose bound id is
`terminal`, with the `terminal.execute` grant, through an admitted Core or
Android host. Other applications do not receive this process-control authority
by default.

Before presenting terminal UI, feature-detect `Arcane.terminal`, then confirm
the application, grant, and exact method admission with
`Arcane.capabilities.list()`:

```javascript
const terminal = globalThis.Arcane?.terminal;
const access = await globalThis.Arcane?.capabilities?.list?.();

const terminalAvailable = Boolean(
    terminal?.start
    && access?.app?.id === 'terminal'
    && access.grants.includes('terminal.execute')
    && access.methods.includes('terminal.start')
);
```
Rejected calls use `Arcane.Error`. Its `code`, `message`, and `resolution`
properties are the stable application-facing recovery fields.

## Arcane.app.current()

### Overview

`Arcane.app.current()` identifies the application to which the native bridge
session is bound. The host, not renderer input, selects this identity. Use it
for display and correlation; app-scoped storage and authority are already bound
by the host and cannot be changed by passing another id.

The method takes no parameters, is a repeatable read, requires no capability,
and is admitted on Core and Android hosts. It has no side effect and emits no
event.

### Result

The exact result has these eight properties:

| Property | Contract |
| --- | --- |
| `id` | Canonical lower-case application id, at most 64 characters. |
| `displayName` | Host-bound display name. |
| `type` | `"app"`, `"shell"`, or `"provisioner"`. |
| `entry` | Safe relative entry path, or `null`. |
| `version` | The bound application's semantic version. Shell and Provisioner use the OS bundle version; packaged apps own their version. |
| `securityMode` | `"publisher-verified"`, `"unsigned-local-test"`, or `"unverified"`. |
| `publisherTrustSource` | Publisher evidence for a publisher-verified host, otherwise `null`. |
| `revocationStatus` | Revocation evidence for a publisher-verified host, otherwise `null`. |

Android returns the immutable Shell or application-APK descriptor with
`securityMode: "unverified"` and both publisher evidence fields set to `null`.
That describes the current Android distribution; it is not a publisher-trust
claim.

### Errors and recovery

`ARCANE_TRANSPORT_UNAVAILABLE` means the page is not running through an Arcane
host. `METHOD_CONTRACT_OUTPUT_INVALID` means the host supplied an invalid
identity; stop and repair or reinstall the matching host/package rather than
guessing an application id.

### Example

```javascript
const currentApp = await Arcane.app.current();

console.log(currentApp.displayName, currentApp.version);
console.log(currentApp.id, currentApp.type, currentApp.securityMode);
```

## Arcane.applications.list()

### Overview

`Arcane.applications.list()` reads the installed, launchable application
catalog. It is available only to the bound `shell` or `terminal` application
with the `applications.read` grant on Core or Android. It performs a verified
catalog read and emits no event.

The result is a catalog wrapper, not a bare array. At most 256 unique
applications are returned, ordered by ascending `order`, then by display name
and id on Core. Android validates its generated order before returning it.

### Result

```javascript
const catalog = {
    verified: true,
    securityMode: 'unsigned-local-test',
    publisherTrustSource: null,
    revocationStatus: null,
    applications: [
        {
            id: 'files',
            displayName: 'Files',
            description: 'Browse app-owned files.',
            iconUrl: '/apps/files/icon.png',
            version: '1.0.0',
            order: 10,
            verified: true
        }
    ]
};
```

Each record has exactly `id`, `displayName`, `description`, `iconUrl`,
`version`, `order`, and `verified`. Nullable metadata is returned as `null`.
Every record's `verified` value equals the wrapper value. Publisher-verified
Core catalogs include bounded trust source and revocation evidence;
unsigned-development catalogs use `null` evidence. A non-debug Android package
can report `verified: false`, `securityMode: "unverified"`, and null evidence;
do not turn that development fact into a trust claim.

### Errors and recovery

`METHOD_NOT_ALLOWED` or `ANDROID_CAPABILITY_DENIED` means the app identity or
grant is not admitted. Catalog or package failures use
`APPLICATION_ADAPTER_UNAVAILABLE`, `APPLICATION_CATALOG_UNAVAILABLE`,
`APPLICATION_CATALOG_UNVERIFIED`, or `APPLICATION_CATALOG_INVALID`. Treat those
as installation-integrity failures and offer repair; do not display or launch a
partially accepted catalog.

### Example

```javascript
const catalog = await Arcane.applications.list();

if (!catalog.verified) {
    console.warn('The host did not verify this development catalog.');
}

for (const application of catalog.applications) {
    console.log(application.id, application.displayName, application.version);
}
```

## Arcane.applications.launch()

### Overview

`Arcane.applications.launch(id)` asks the host to dispatch one installed
application from the catalog returned by `applications.list()`. It is a
non-idempotent application-dispatch operation. The method is available only to
the bound `shell` or `terminal` application with `applications.launch` on Core
or Android.

Pass the unchanged canonical id from the current catalog. It must be a
lower-case hyphenated application id no longer than 64 characters; reserved
host identities such as Shell and Provisioner are not application launch
targets. Android additionally requires the generated APK to be installed and
launchable.

### Result and lifecycle

The exact result is `{ id, accepted: true }`. `accepted` means the host accepted
the dispatch request. It does not prove that the target rendered successfully,
became ready, or remained open. There is no portable public launch-completion
event, so do not wait for one or retry automatically after an ambiguous
transport failure.

### Errors and recovery

Use the current catalog again after `APPLICATION_NOT_FOUND`. Wait for an active
installation or application shutdown after `APPLICATION_INSTALL_BUSY` or
`APPLICATIONS_BUSY`. `INVALID_APPLICATION_ID` and
`INVALID_APPLICATION_REQUEST` indicate caller input. Adapter or dispatch
failures use `APPLICATION_ADAPTER_UNAVAILABLE`,
`APPLICATION_LAUNCH_FAILED`, or `APPLICATION_LAUNCH_REJECTED`; repair the host
if a catalog-listed application repeatedly fails.

### Example

```javascript
document.querySelector('#launch-files')?.addEventListener(
    'click',
    async function handleApplicationLaunch() {
        const catalog = await Arcane.applications.list();
        const filesApp = catalog.applications.find(function findFilesApp(application) {
            return application.id === 'files';
        });
        if (!filesApp) return;

        const launch = await Arcane.applications.launch(filesApp.id);
        console.log('Dispatch accepted', launch.id, launch.accepted);
    }
);
```

## Arcane.external.open()

### Overview

`Arcane.external.open(uri)` hands one validated `mailto:` URI to the operating
system's registered handler. It requires the `external.open` grant and an
admitted Core or Android host. The call is non-idempotent, emits no Arcane
event, and simulation rejects it instead of pretending to open another app.

The URI may be at most 4096 printable ASCII characters. It must have no leading
or trailing whitespace, raw spaces, fragment, backslash, malformed percent
escape, or raw or percent-encoded control character. Only `mailto:` is
accepted; percent-encode query values with `encodeURIComponent()`.

### Result and side effect

The exact result is `{ opened: true, uri }`, with the scheme canonicalized to
lower-case `mailto:`. `opened: true` means only that the host accepted the
operating-system handoff. It does not prove that a composer appeared or that a
message was sent. On Microsoft NT the host uses the system URI handler; Linux
requires `xdg-open`; Android launches an admitted intent handler.

### Errors and recovery

`EXTERNAL_SCHEME_NOT_ALLOWED` means the URI is not `mailto:`.
`EXTERNAL_OPEN_INVALID` identifies malformed input. `EXTERNAL_OPEN_SIMULATED`
and `EXTERNAL_OPEN_UNSUPPORTED` require a real host with a configured handler.
`EXTERNAL_OPEN_FAILED` means the OS did not accept the handoff. Do not retry
blindly after a timeout because the first handoff may already have occurred.

### Example

```javascript
document.querySelector('#open-support-email')?.addEventListener(
    'click',
    async function handleSupportEmailRequest() {
        const subject = encodeURIComponent('Arcane support request');
        const uri = `mailto:support@example.com?subject=${subject}`;
        const result = await Arcane.external.open(uri);
        console.log('Operating-system handoff accepted', result.opened);
    }
);
```

## Arcane.mail.send()

### Overview

`Arcane.mail.send({report, reportKey})` sends one bounded report to the fixed
local Arcane mail gateway. It is admitted only to explicitly approved reporting
applications with `mail.send` on Microsoft NT or Linux Core. Android does not
project it, and simulation fails explicitly. Core performs no automatic retry.

`reportKey` is the caller's idempotency key: 8–128 characters from letters,
numbers, period, underscore, colon, and hyphen. Reuse the same key only when
retrying the same logical report after an uncertain local-gateway outcome.

### Input

`report` is an exact object with required `type`, `subject`, and `to`, plus
optional `text` and `html`; unknown fields are rejected. `type` is
`"crisis_detected"`, `"error"`, or `"report"`. The trimmed subject is 1–160
characters without controls. `to` contains at most 50 email-shaped addresses,
each at most 254 characters; it may be empty only for an `error` report. At
least one of `text` or `html` must contain non-whitespace content. The serialized
report may not exceed 786,432 UTF-8 bytes.

### Result

The exact result is
`{requestId, status, statusCode, sent, partial, uncertain}`. The combinations
are fixed:

| `status` | `statusCode` | Flags |
| --- | --- | --- |
| `accepted` | `202` | `sent: true`, `partial: false`, `uncertain: false` |
| `partially_accepted` | `207` | `sent: false`, `partial: true`, `uncertain: false` |
| `delivery_uncertain` | `207` | `sent: false`, `partial: false`, `uncertain: true` |

These are gateway acceptance states, not proof that every downstream recipient
received a message. The method has a 450-second bridge timeout around a
440-second absolute gateway deadline and emits no dedicated mail event.

### Errors and recovery

Malformed input is `METHOD_CONTRACT_INPUT_INVALID`. Simulation uses
`MAIL_SEND_SIMULATION_UNAVAILABLE`. Gateway connection, redirect, oversized or
invalid response, rejection, and timeout failures use the corresponding
`MAIL_GATEWAY_*`, `MAIL_SEND_REJECTED`, or `MAIL_SEND_TIMEOUT` code. Follow the
error's `resolution`; when a retry is appropriate, keep the same report and
`reportKey` so the gateway can deduplicate it. Never log report bodies or keys
that correlate sensitive reports.

### Example

```javascript
document.querySelector('#confirm-report-send')?.addEventListener(
    'click',
    async function handleConfirmedReportSend() {
        const request = {
            reportKey: `report:${crypto.randomUUID()}`,
            report: {
                type: 'report',
                subject: 'Synthetic development report',
                to: ['developer@example.com'],
                text: 'This is synthetic test content.'
            }
        };
        const result = await Arcane.mail.send(request);
        console.log(result.requestId, result.status, result.statusCode);
    }
);
```

## Arcane.capabilities.list()

### Overview

`Arcane.capabilities.list()` returns the effective authority of the current
Core-bound application session. It takes no parameters, requires no capability,
has no side effect, and emits no event. Use it to disable unavailable controls;
it does not grant authority or make a later mutation safe without its own
preconditions.

The direct method is Core-only in the current projection. Android callers with
`system.read` obtain the same nested capability snapshot from
`Arcane.platform.status().capabilities`; a direct Android
`capabilities.list` request is unsupported.

### Result

The exact result is `{ app, grants, methods }`. `app` is the same eight-field
descriptor returned by `Arcane.app.current()`. `grants` is the sorted list of
capability strings bound to the app. `methods` is the sorted list of exact RPC
method names admitted after capability, app-type, and app-id policy checks.

RPC names can differ from public JavaScript member names: for example,
`Arcane.applications.list()` is admitted as `"apps.list"`. Test the matching RPC
name and feature-detect the JavaScript member before enabling a control.

### Errors and recovery

`ARCANE_TRANSPORT_UNAVAILABLE` means there is no host. An Android call rejects
with `ANDROID_CAPABILITY_UNSUPPORTED`; use the platform-status snapshot there.
An unexpected or missing method in a Core result indicates a policy/package
mismatch—refresh the app after repair rather than treating a grant string alone
as permission.

### Example

```javascript
const access = await Arcane.capabilities.list();
const canLaunch = Boolean(
    Arcane.applications?.launch
    && access.grants.includes('applications.launch')
    && access.methods.includes('apps.launch')
);

console.log(access.app.id, canLaunch);
```

## Arcane.terminal.start()

### Overview

`Arcane.terminal.start(options?)` starts one native terminal session owned by
the bound Arcane Terminal application. It is a high-risk, non-idempotent process
start. The host admits no more than eight concurrent sessions.

The method is available only when `terminal.start` is projected, the application
id is `terminal`, the `terminal.execute` grant is present, and `terminal.start`
appears in the admitted method list. A browser preview cannot start an operating
system process.

Subscribe to terminal events before calling `start()`. The host begins
forwarding process streams as part of startup, so an early output event may
arrive before application code receives the resolved session object. Buffer
events by `sessionId` until the start result identifies the desired session.

### Options

The optional `options` object has four normalized fields:

| Field | Type | Default | Contract |
| --- | --- | --- | --- |
| `shell` | `string` | `"auto"` | One of `auto`, `powershell`, `cmd`, `bash`, or `sh`, subject to host availability; at most 16 characters. |
| `cwd` | `string` | `""` | Existing accessible working directory, or the host default when empty; at most 4096 characters and subject to the host sandbox. |
| `columns` | safe integer | `120` | From 20 through 500. |
| `rows` | safe integer | `32` | From 5 through 200. |

The JavaScript wrapper sends only these four fields and converts the supplied
values to their documented string or number forms. Values outside the checked
bounds are rejected; do not rely on host clamping.

### Resolved session

The method resolves to:

```javascript
const session = {
    id: 'term-example',
    shell: 'powershell',
    cwd: '<resolved working directory>',
    title: 'PowerShell',
    columns: 120,
    rows: 32,
    createdAt: '2026-08-15T12:00:00.000Z'
};
```

| Property | Type | Description |
| --- | --- | --- |
| `id` | `string` | Opaque session identifier matching the Arcane session-id contract and no longer than 128 characters. |
| `shell` | `string` | Resolved shell selected by the host. |
| `cwd` | `string` | Resolved working directory. |
| `title` | `string` | Host-provided display title, at most 80 characters. |
| `columns` | `number` | Accepted column count. |
| `rows` | `number` | Accepted row count. |
| `createdAt` | `string` | Host creation timestamp. |

### Events

After startup, observe these future-only events:

- `terminal.output` carries `{ sessionId, stream, data }` for stdout and stderr
  chunks. Chunks are not lines and may contain terminal control sequences.
- `terminal.exit` carries `{ sessionId, exitCode, signal }` after the process
  exits and the host retires the session.
- `terminal.error` carries `{ sessionId, message }` for asynchronous host stream
  failures. The Android provider also uses it when a session exceeds its output
  limit.

Store every returned unsubscribe function and call it during teardown. The
[Arcane event catalog](../../arcane-events.md) defines the complete event
payloads.

### Platform differences

On Microsoft NT Core hosts, `auto` resolves to PowerShell. `powershell`, `cmd`,
and an installed `bash` are selectable; `sh` is unavailable. On Linux Core
hosts, `auto` resolves to Bash, `sh` selects `/bin/sh`, `powershell` requires an
installed `pwsh`, and `cmd` is unavailable.

On Android, only `auto` and `sh` are accepted and both resolve to the
application-sandbox `/system/bin/sh`. The working directory must stay inside the
application's private files area. Android runs the process as the ordinary
Arcane Terminal app identity and stops a session after one MiB of emitted
output.

### Errors and recovery

| Code | Meaning and recovery |
| --- | --- |
| `METHOD_NOT_ALLOWED` | The bound application or grant is wrong. Open the admitted Arcane Terminal application; do not retry from another app. |
| `ARCANE_TRANSPORT_UNAVAILABLE` | Open Arcane Terminal through an installed or development Arcane host. |
| `METHOD_CONTRACT_INPUT_INVALID` or `TERMINAL_REQUEST_INVALID` | Use only the documented fields, value types, and bounds. |
| `TERMINAL_SESSION_LIMIT` | Close an existing session before retrying. |
| `TERMINAL_SHELL_INVALID` | Use one of the five documented shell names. |
| `TERMINAL_SHELL_UNAVAILABLE` | Select a shell supported and installed on the active platform. |
| `TERMINAL_CWD_INVALID` | Choose an existing accessible directory allowed by the current host sandbox. |
| `TERMINAL_START_FAILED` | Verify that the resolved shell executable is installed and can start, then retry. |

### Example

This complete example subscribes before startup, buffers early output, uses the
session methods, requests closure, observes process exit, and releases every
listener.

```javascript
const arcane = globalThis.Arcane;
const terminal = arcane?.terminal;
const events = arcane?.events;

if (!terminal?.start || !events?.on || !arcane?.capabilities?.list) {
    throw new Error('Open Arcane Terminal through an admitted Arcane host.');
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

const bufferedOutput = new Map();
const observedExits = new Map();
const exitWaiters = new Map();
const maxBufferedChunksPerSession = 128;
let session = null;
let activeSessionId = null;

function render({stream, data}) {
    const write = stream === 'stderr' ? console.error : console.log;
    write(data);
}

const offOutput = events.on('terminal.output', function handleTerminalOutput(payload) {
    if (payload.sessionId === activeSessionId) {
        render(payload);
        return;
    }
    const pending = bufferedOutput.get(payload.sessionId) ?? [];
    pending.push(payload);
    // Bound pre-identification buffering; surface truncation in a real UI.
    if (pending.length > maxBufferedChunksPerSession) {
        pending.shift();
    }
    bufferedOutput.set(payload.sessionId, pending);
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

    for (const payload of bufferedOutput.get(session.id) ?? []) {
        render(payload);
    }
    bufferedOutput.delete(session.id);

    await terminal.resize(session.id, 100, 30);

    const {sessions} = await terminal.list();
    console.log('Owned sessions', sessions);

    const lineEnding = ['powershell', 'cmd'].includes(session.shell)
        ? '\r\n'
        : '\n';
    const writeResult = await terminal.write(
        session.id,
        `echo Arcane terminal ready${lineEnding}`
    );
    console.log('Accepted input bytes', writeResult.bytes);

    const exitPromise = waitForExit(session.id);
    const closeResult = await terminal.close(session.id);
    console.log('Close request accepted', closeResult.accepted);

    const exit = await exitPromise;
    console.log('Process exit', exit.exitCode, exit.signal);
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

## Arcane.terminal.list()

### Overview

`Arcane.terminal.list()` returns the current terminal sessions owned by the
bound application. It is a repeatable read, takes no parameters, and does not
list sessions owned by another application or user boundary.

The resolved value is a wrapper object, not the session array itself:

```javascript
const {sessions} = await Arcane.terminal.list();
```

At most eight entries are returned. A host may remove an exited or closed
session promptly, so use terminal events for lifecycle observation rather than
using repeated list calls as a substitute for event delivery.

### Session inventory

The exact resolved shape is:

```javascript
const result = {
    sessions: [
        {
            id: 'term-example',
            shell: 'powershell',
            cwd: '<resolved working directory>',
            columns: 120,
            rows: 32,
            createdAt: '2026-08-15T12:00:00.000Z',
            state: 'running'
        }
    ]
};
```

| Property | Type | Description |
| --- | --- | --- |
| `id` | `string` | Opaque app-owned session id. |
| `shell` | `string` | Resolved shell name. |
| `cwd` | `string` | Resolved working directory. |
| `columns` | `number` | Current bounded column count. |
| `rows` | `number` | Current bounded row count. |
| `createdAt` | `string` | Host creation timestamp. |
| `state` | `string` | Current host-reported state while the session remains in the inventory: `starting`, `running`, `exited`, or `closed`. |

`list()` deliberately does not return the `title` property included in the
`start()` result.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the application is not admitted for
`terminal.execute`. `ARCANE_TRANSPORT_UNAVAILABLE` means no callable host is
connected. A host result that violates the exact wrapper or session shape is
rejected as `METHOD_CONTRACT_OUTPUT_INVALID`; treat that as a host/package
integrity failure rather than trying to reinterpret the result.

### Example

```javascript
const terminal = globalThis.Arcane?.terminal;

if (!terminal?.list) {
    throw new Error('Terminal session inventory is unavailable.');
}

try {
    const {sessions} = await terminal.list();

    for (const session of sessions) {
        console.log(
            session.id,
            session.shell,
            session.state,
            `${session.columns}x${session.rows}`,
            session.cwd
        );
    }
} catch (error) {
    if (error instanceof Arcane.Error) {
        console.error(error.code, error.message, error.resolution);
    } else {
        throw error;
    }
}
```

## Arcane.terminal.write()

### Overview

`Arcane.terminal.write(sessionId, data)` writes one nonempty UTF-8 input chunk
to a running app-owned session. The method is non-idempotent: after an ambiguous
timeout or transport failure, do not retry blindly because the first input may
already have reached the process.

The method does not append a line ending. Use `"\r\n"` for PowerShell or
Command Prompt and `"\n"` for POSIX shells when the target shell should submit
a command. It also does not return process output or command completion;
subscribe to `terminal.output` and `terminal.exit` before writing.

Output events contain stream chunks, not lines. Preserve per-session arrival
order and expect a chunk to contain partial text, multiple lines, or terminal
control sequences.

### Input

| Parameter | Type | Contract |
| --- | --- | --- |
| `sessionId` | `string` | Opaque id returned by `start()` or `list()`, from 1 through 128 characters and matching the Arcane session-id pattern. |
| `data` | `string` | Nonempty UTF-8 input from 1 through 65,536 bytes. |

The JavaScript wrapper converts `sessionId` and `data` to strings. An empty value
is still invalid, and the limit is measured in UTF-8 bytes rather than JavaScript
characters.

### Acceptance result

The method resolves to:

```javascript
const result = {
    sessionId: 'term-example',
    accepted: true,
    bytes: 21
};
```

`bytes` is the accepted UTF-8 byte count, from 1 through 65,536. `accepted`
means the host accepted the input for the session; it does not mean the shell
finished a command.

### Errors and recovery

| Code | Meaning and recovery |
| --- | --- |
| `METHOD_CONTRACT_INPUT_INVALID` or `TERMINAL_DATA_INVALID` | Send a nonempty chunk no larger than 64 KiB. Split larger input deliberately. |
| `TERMINAL_SESSION_INVALID` | Use an unchanged id returned by the API. |
| `TERMINAL_SESSION_NOT_FOUND` | The session has exited or was closed. Refresh with `list()` or start another session. |
| `TERMINAL_INPUT_CLOSED` | The process no longer accepts stdin. Start a new session instead of retrying. |
| `METHOD_NOT_ALLOWED` | The current application lacks terminal admission. |

### Example

```javascript
const terminal = globalThis.Arcane?.terminal;
const events = globalThis.Arcane?.events;

if (!terminal?.write || !terminal?.list || !events?.on) {
    throw new Error('Native terminal input is unavailable.');
}

const {sessions} = await terminal.list();
const session = sessions[0];

if (!session) {
    throw new Error('Start a terminal session before writing input.');
}

const offOutput = events.on('terminal.output', function handleTerminalOutput(payload) {
    if (payload.sessionId === session.id) {
        console.log(payload.stream, payload.data);
    }
});

try {
    const lineEnding = ['powershell', 'cmd'].includes(session.shell)
        ? '\r\n'
        : '\n';
    const result = await terminal.write(
        session.id,
        `echo Input was accepted${lineEnding}`
    );
    console.log(`Accepted ${result.bytes} UTF-8 bytes.`);
} catch (error) {
    if (error instanceof Arcane.Error) {
        console.error(error.code, error.message, error.resolution);
    } else {
        throw error;
    }
} finally {
    offOutput();
}
```

## Arcane.terminal.resize()

### Overview

`Arcane.terminal.resize(sessionId, columns, rows)` updates the bounded dimensions
recorded for a running app-owned session. The current host contract reports this
as an emulated resize. It updates Arcane's terminal-session dimensions but does
not promise a native pseudoterminal resize or emit a resize event.

### Dimensions

| Parameter | Type | Contract |
| --- | --- | --- |
| `sessionId` | `string` | Opaque id returned by `start()` or `list()`, no longer than 128 characters. |
| `columns` | safe integer | From 20 through 500. |
| `rows` | safe integer | From 5 through 200. |

The wrapper converts both dimensions with `Number()`. Fractions, non-finite
values, and out-of-range values do not satisfy the checked method contract.

### Acceptance result

The method resolves to this exact object:

```javascript
const result = {
    sessionId: 'term-example',
    columns: 100,
    rows: 30,
    accepted: true,
    emulated: true
};
```

The returned dimensions are the accepted values. `emulated: true` distinguishes
this session metadata update from a guarantee that the operating system resized
a native pseudoterminal.

### Errors and recovery

Invalid dimensions are rejected as `METHOD_CONTRACT_INPUT_INVALID`. An invalid
or retired id produces `TERMINAL_SESSION_INVALID` or
`TERMINAL_SESSION_NOT_FOUND`. Use `list()` to refresh current app-owned sessions;
do not reuse an id after exit.

### Example

```javascript
const terminal = globalThis.Arcane?.terminal;

if (!terminal?.resize || !terminal?.list) {
    throw new Error('Terminal resize is unavailable.');
}

const {sessions} = await terminal.list();
const session = sessions[0];

if (!session) {
    throw new Error('Start a terminal session before resizing it.');
}

try {
    const result = await terminal.resize(session.id, 100, 30);
    console.log(
        `Recorded ${result.columns}x${result.rows}`,
        `emulated=${result.emulated}`
    );
} catch (error) {
    if (error instanceof Arcane.Error) {
        console.error(error.code, error.message, error.resolution);
    } else {
        throw error;
    }
}
```

## Arcane.terminal.signal()

### Overview

`Arcane.terminal.signal(sessionId, signal = "interrupt")` sends one supported
control request to a running app-owned session. It is non-idempotent process
control. Subscribe to `terminal.exit` before signaling when the application
needs to observe whether the process exits.

### Signal request

| Parameter | Type | Default | Contract |
| --- | --- | --- | --- |
| `sessionId` | `string` | None | Opaque id returned by `start()` or `list()`, no longer than 128 characters. |
| `signal` | `string` | `"interrupt"` | Either `interrupt` or `terminate`; no other signal name is supported. |

On desktop Core hosts, `interrupt` maps to the host's `SIGINT` process-control
request and `terminate` maps to `SIGTERM`. Android applies the supported request
through its sandbox process-destruction boundary; applications must not depend
on Unix signal details there.

### Acceptance result

The method resolves to:

```javascript
const result = {
    sessionId: 'term-example',
    signal: 'interrupt',
    accepted: true
};
```

`accepted` is a boolean and may be `false`. A true value means the host accepted
the control request, not that the process exited or used a particular exit code.
Observe `terminal.exit` for the final outcome.

### Errors and recovery

| Code | Meaning and recovery |
| --- | --- |
| `METHOD_CONTRACT_INPUT_INVALID` or `TERMINAL_SIGNAL_INVALID` | Use only `interrupt` or `terminate`. |
| `TERMINAL_SESSION_INVALID` | Use an unchanged API-returned session id. |
| `TERMINAL_SESSION_NOT_FOUND` | The process is no longer running; refresh with `list()` or start another session. |
| `METHOD_NOT_ALLOWED` | The current application lacks `terminal.execute` admission. |

Do not retry a signal automatically after an ambiguous transport failure; the
first request may already have affected the process.

### Example

```javascript
const terminal = globalThis.Arcane?.terminal;
const events = globalThis.Arcane?.events;

if (!terminal?.signal || !terminal?.list || !events?.on) {
    throw new Error('Terminal process control is unavailable.');
}

const {sessions} = await terminal.list();
const session = sessions[0];

if (!session) {
    throw new Error('Start a terminal session before signaling it.');
}

let offExit = function ignoreExitUnsubscribe() {};

const exited = new Promise(function waitForTerminalExit(resolve) {
    offExit = events.on('terminal.exit', function handleTerminalExit(payload) {
        if (payload.sessionId === session.id) {
            offExit();
            resolve(payload);
        }
    });
});

try {
    const result = await terminal.signal(session.id, 'interrupt');
    console.log('Interrupt request accepted', result.accepted);

    if (result.accepted) {
        const exit = await Promise.race([
            exited,
            new Promise(function waitForExitTimeout(resolve) {
                setTimeout(function resolveExitTimeout() {
                    resolve(null);
                }, 2000);
            })
        ]);
        console.log(exit ? 'Session exited' : 'Session remains available');
    }
} catch (error) {
    if (error instanceof Arcane.Error) {
        console.error(error.code, error.message, error.resolution);
    } else {
        throw error;
    }
} finally {
    offExit();
}
```

## Arcane.terminal.close()

### Overview

`Arcane.terminal.close(sessionId)` asks the host to close one app-owned terminal
session. It is non-idempotent process control. The host may close input and then
terminate the process according to its platform policy.

The resolved result acknowledges the close request; it is not the process exit
record. Subscribe to `terminal.exit` before calling `close()` and use that event
as the final lifecycle observation. Calling `close()` again after the host
retires the session can reject with `TERMINAL_SESSION_NOT_FOUND`.

### Session identifier

| Parameter | Type | Contract |
| --- | --- | --- |
| `sessionId` | `string` | Opaque id returned by `start()` or `list()`, from 1 through 128 characters and matching the session-id contract. |

### Acceptance result

The method resolves to:

```javascript
const result = {
    sessionId: 'term-example',
    accepted: true
};
```

`accepted: true` means that the host accepted the close request. It does not
mean the process has exited, that an exit code is already available, or that all
earlier output chunks have been rendered.

### Errors and recovery

`TERMINAL_SESSION_INVALID` means the identifier does not satisfy the public
session-id contract. `TERMINAL_SESSION_NOT_FOUND` means the session has already
exited or been retired. Treat the latter as stale local state and refresh the
owned inventory instead of repeatedly closing the same id.

`METHOD_NOT_ALLOWED` and `ARCANE_TRANSPORT_UNAVAILABLE` indicate an availability
or host problem, not a session problem. Reopen the admitted Arcane Terminal host
rather than retrying the close call in a browser preview.

### Example

```javascript
const terminal = globalThis.Arcane?.terminal;
const events = globalThis.Arcane?.events;

if (!terminal?.close || !terminal?.list || !events?.on) {
    throw new Error('Terminal session closure is unavailable.');
}

const {sessions} = await terminal.list();
const session = sessions[0];

if (!session) {
    throw new Error('Start a terminal session before closing it.');
}

let offExit = function ignoreExitUnsubscribe() {};

const exited = new Promise(function waitForTerminalExit(resolve) {
    offExit = events.on('terminal.exit', function handleTerminalExit(payload) {
        if (payload.sessionId === session.id) {
            offExit();
            resolve(payload);
        }
    });
});

try {
    const result = await terminal.close(session.id);
    console.log('Close request accepted', result.accepted);

    const exit = await Promise.race([
        exited,
        new Promise(function waitForExitTimeout(_resolve, reject) {
            setTimeout(function rejectExitTimeout() {
                reject(new Error('Timed out waiting for terminal.exit.'));
            }, 5000);
        })
    ]);
    console.log('Process exited', exit.exitCode, exit.signal);
} catch (error) {
    if (error instanceof Arcane.Error) {
        console.error(error.code, error.message, error.resolution);
    } else {
        console.error(error);
    }
} finally {
    offExit();
}
```
