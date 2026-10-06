# One application, one shared Core host

`arcane-os/core/host` provides a Node local-IPC owner for applications whose
native UI and separate MCP process use the same catalog, drafts, review queue,
and Git service. The application chooses one endpoint and one set of services.
The endpoint is a nonempty local pipe/socket path. The SDK connects to it,
optionally starts an explicit headless entry,
and keeps client disconnection separate from service shutdown.

This is an explicit same-application connection. It does not scan applications
or processes, share preference files, copy a catalog, retry requests, or retain
event history. Application methods and policy stay in the application services.
Use the [MCP server](mcp-stdio.md) for external MCP framing; local Core continues
to use the existing `arcane/1` protocol and Content-Length stream framing.

## Attach to an existing window-owned Core

`startCoreListener({runtime,endpoint,onError})` adds a local IPC listener to an
existing Core runtime. It resolves `{endpoint,closed,close}` after binding the
selected endpoint. It neither constructs nor starts a runtime or service. The
existing host retains its application, services, origin, profile, state location
and shutdown ownership.

```js
import {startCoreListener} from 'arcane-os/core/host';

// host is the application's existing startCoreHost/startCoreStdio handle.
const listener = await startCoreListener({runtime: host.runtime, endpoint: selectedEndpoint});
try {
    await host.closed;
} finally {
    await listener.close();
}
```

An external client uses `connectSharedCoreHost({endpoint: selectedEndpoint})`
with `start` omitted, invokes the application's existing methods through
`connection.client.invoke(method, parameters)`, and calls `connection.close()`
when finished. This connection uses the existing SDK framing, correlation and
current-runtime replay; it does not launch another Core or replay requests.
The listener does not implement or intercept `core.host.shutdown`.
`connection.shutdown()` therefore has no listener-owned shutdown operation;
without an application method of that name it returns the ordinary
`METHOD_NOT_ALLOWED` error. The window's host remains the shutdown owner.

Disconnect and `listener.close()` cancel only the affected connections'
request-lifetime work. Explicit listener close drains queued output and releases
the endpoint without closing the runtime or waiting for accepted service-lifetime
work; that work remains tracked by its service/runtime owner. When the runtime
itself begins shutdown, the listener rejects new requests and retains its endpoint
through runtime drain/disposal, then closes its connections automatically.
Observe both the host's `closed` and the listener's `closed` for their respective
completion or failure. `close()` is idempotent. Transport errors reach `onError`
(complete console diagnostics by default); terminal listener failures reject
`closed`. Bind failures reject startup with their actual native error and leave
the supplied runtime alive. A draining/closed runtime rejects attachment with
`CORE_CLOSING`.

Stdio and each IPC connection have independent request correlation and
cancellation. Handlers reached through stdio or this listener receive the
original client ID in `context.requestId`; `context.coreRequestId` exposes the
fresh internal ID used by runtime dispatch and protocol routing. Responses and
top-level event correlation return to their originating connection. The new listener leaves all event data,
including any authored `data.requestId`, and all parameters/results unchanged.
Its runtime-state snapshot retains the runtime's internal active IDs. Late events
from a retired request never attach to a later reuse of that client's ID.
Uncorrelated service events remain shared. See the
[runtime metadata contract](core-runtime.md#state-and-frames).

For a generated native entry, select
`native.launchContext.coreListener:{endpoint}` and omit `sharedHost`. This adds
the listener to the ordinary window/stdio runtime; closing the native window
still drains Core. The endpoint is explicit, with no inferred headless startup
or new default location. Its parent directory must already exist on platforms
that require one. Selecting both `coreListener` and `sharedHost` reports
`TypeError` because they select different runtime lifetimes. See
[native launch locations](core-native-packaging.md#launch-time-locations).

## Host entry

```js
import {runSharedCoreHost} from 'arcane-os/core/host';

const host = await runSharedCoreHost({
    endpoint: process.env.MOON_CORE_ENDPOINT,
    application: {id: 'moon-cheese-ledger'},
    version: '1.0.0',
    async configure(runtime, {signal}) {
        // Only the successful endpoint owner imports and constructs services.
        const {default: createLedger} = await import('./ledger.mjs');
        signal.throwIfAborted();
        runtime.registerService(createLedger());
    }
});
await host?.closed;
```

`startSharedCoreHost({endpoint,application,version,configure,getReplayEvents,
signal,onError})` binds the selected endpoint **before** calling `configure`.
The callback receives the existing runtime and the host's lifetime signal.
Register each service as it is constructed so its drain/disposal belongs to the
runtime even if a later factory fails. Put asynchronous service initialization
in `start`, as with ordinary Core composition. Factory imports can run
concurrently; requests wait for composition, then only their own service's
startup. Dispatcher readiness does not claim model or service readiness.

It resolves to `{runtime,endpoint,closed,close}`. `close()` rejects new work,
joins composition, closes the runtime, drains complete queued frames, and
closes its connections. It retains the endpoint claim through service cleanup
before stopping the listener, so a new launcher cannot start a second service
owner during an accepted save. Accepted service-lifetime requests finish
before service drain/disposal. A supplied signal begins this same shutdown;
the lazy factory receives cancellation and is joined before cleanup. Register
resources before rejecting after creation. Startup and shutdown errors remain
observable; `closed` rejects on host shutdown failure. `onError` observes
transport/background errors, with console diagnostics by default.

An endpoint already in use rejects with the native `EADDRINUSE` error and
`coreHostPhase:'listen'`, without invoking the factory.
`runSharedCoreHost(options)` adds the explicit headless startup handshake: a
losing launcher connects to the existing owner and confirms dispatcher response
without importing its own application service modules. It returns `null` in
that case. The winning launcher returns the same host object. It reports startup
success or the complete failure to a parent Node IPC channel when present and
never calls `process.exit()`.

## Connect, reuse, or start headlessly

```js
import {connectSharedCoreHost} from 'arcane-os/core/host';

const connection = await connectSharedCoreHost({
    endpoint: selectedEndpoint,
    start: {
        command: process.execPath,
        args: [selectedHostEntry],
        logFile: selectedDiagnosticLog
    }
});
const catalog = await connection.client.invoke('catalog.read', {});
// The UI or MCP process is finished. Shared services remain alive.
await connection.close();
```

`connectSharedCoreHost({endpoint,start,signal,onError})` first connects to the
selected endpoint. Only connection absence (`ENOENT` or `ECONNREFUSED`) selects
`start`; other errors propagate unchanged. Omit `start` for connect-only use.
The optional record is `{command,args=[],cwd,env,logFile}`. Its arguments and
environment are captured at acceptance. The selected entry must call
`runSharedCoreHost`. Parent directories for the endpoint and diagnostic file
must already exist. No shell, runtime installer, service manager, or automatic
request retry is involved.

Headless startup uses an independent child with ignored stdin and complete
stdout/stderr appended to the explicit diagnostic file. The child reports its
endpoint claim/composition result through its startup IPC channel; the launcher
then disconnects that channel and releases the child process reference. An
aborted connection/start wait rejects or closes the connecting client; it does
not kill a host that another connection may already use. The host may therefore
continue running after a launch wait is cancelled. Startup diagnostics and the
endpoint remain the actual outcome owners. No startup timeout is imposed by
this layer; supply a signal when the caller needs a bounded wait.

The result is `{client,endpoint,closed,close,shutdown}`. `client` is the existing
[Core client](core-client.md), with full invoke/cancellation/event behavior and
current-runtime replay enabled. A connected transport is not a ready model.
`close()` and `client.close()` cancel this connection's request-lifetime work
and disconnect it. They leave accepted service-lifetime work and the host
running. `closed` observes connection termination and rejects on a transport
error. A subsequent connection uses the still-running owner. Reconnection is
explicit; failed or uncertain requests are never resubmitted.

For an owning shared host, `await connection.shutdown(invokeOptions)` explicitly
invokes the host-owned `core.host.shutdown` operation. It drains the shared runtime, returns
`{state:'closed'}` after successful service cleanup, then closes the connection.
A drain failure returns the full Core error. Shutdown affects **all** clients
of that app endpoint and belongs to the application owner's explicit lifecycle,
not ordinary UI/MCP cleanup. The host reserves this one method; application
services should use their own namespaces. Cancelling the caller's invoke wait
after shutdown acceptance does not undo the shared shutdown.

## Correlation, events, and state

Each connection has its own request-ID space. The owning shared-host adapter
substitutes an internal Core request ID and restores the originating ID on responses and
the optional top-level event `requestId`. Existing `data.requestId` values that
carry that same Core correlation ID are restored too. `parameters`, returned results, schemas,
documents, and content remain complete and unchanged. A handler's
`context.requestId` is the Core-side correlation ID; put it in the event's
separate `requestId` field, not inside application content.

Responses and request-context events go to the originating connection in
order. Core supplies the top-level request correlation outside `data`, so two
clients may choose the same `streamId` without receiving each other's chunks.
Retired request frames are never routed to another connection. Ordinary
application/service events from the lifecycle context or `runtime.emit` are broadcast to
connected clients. Runtime state includes all active work and translates this
connection's IDs; other connections' active requests retain Core-side IDs.
`request.cancel` and `requests.cancelAll` affect only the sending connection's
requests. A disconnect performs the same scoped cancellation. The underlying
runtime continues to preserve service-lifetime acceptance.

Both listener forms handle `runtime.replay` by sending only that connection the
current `core.ready`, `core.state`, and `core.service.state` snapshot. Optional
synchronous `getReplayEvents()` on the owning shared host returns current
`{event,data}` records from their actual service owners. It is for current domain state, not historical chunks or
retired requests. Subscribe before requesting a domain snapshot when its live
events may change; applications own those domain methods and state.

## Native launch and platforms

The generated portable Core entry keeps ordinary stdio behavior unless its
selected launch context contains `sharedHost`. An application can opt in for
ordinary packaged executable launch with `native.launchContext:{sharedHost:{}}`
in its complete descriptor. The SDK supplies the app's platform state root,
workspace, endpoint and diagnostic log through `resolveNativeLaunchContext`.
The same public owner is available to external MCP:

```js
import {readCoreLaunchContext, connectSharedCoreHost} from 'arcane-os/core/host';

const context = await readCoreLaunchContext({
    appId: appDescriptor.id,
    defaults: appDescriptor.native.launchContext
});
const connection = await connectSharedCoreHost({
    endpoint: context.sharedHost.endpoint
});
// Invoke the application's actual services through connection.client.
// Disconnect this MCP client without shutting down the application's host.
await connection.close();
```

This example connects to a running native/headless host. The existing `start`
option can start the packaged Core entry explicitly when independent MCP-first
startup is needed; the entry applies those same packaged defaults. Pass the
same explicit `--arcane-launch-config` file to both entries for user-selected
locations. A caller that already owns a complete context can use the pure
`resolveNativeLaunchContext({appId,context})` directly instead of reading argv.
For MCP-first startup, prepare the returned `context.stateRoot` with Node's
`mkdir(context.stateRoot,{recursive:true})` before selecting `start`, because
the parent's startup diagnostic log opens before the headless child runs.
This uses the resolved directory directly, without duplicating platform path
rules. Pass `context.sharedHost.logFile` to that existing `start` record and
the same launch file to the packaged Core command. Custom endpoint/log parent
directories remain caller-selected.
See [launch-time locations](core-native-packaging.md#launch-time-locations) for
the exact platform defaults, precedence, location override and directory rules.
No app must reconstruct OS directory rules.

An explicit launch file can also select the existing full endpoint contract:

```json
{
  "sharedHost": {
    "endpoint": "APPLICATION-SELECTED-LOCAL-ENDPOINT",
    "logFile": "APPLICATION-SELECTED-DIAGNOSTIC-FILE"
  }
}
```

Both native UI and external MCP clients select the same endpoint. With this
option, the native Core child is a stdio-to-shared-Core bridge. It connects or
launches the same entry with `--arcane-core-headless`; the headless entry claims
the endpoint before importing services. Closing the native window ends its
bridge, while the independent Core host remains available. Service options and
the complete launch context retain their existing values. Shared mode remains
explicit: the new descriptor option selects defaults only for that application,
and the existing no-option stdio path is unchanged.

`startSharedCoreBridge({endpoint,start,input=process.stdin,
output=process.stdout,signal,onError})` is also public. It returns
`{endpoint,closed,close}` and forwards full framed requests, events, and
responses. EOF or bridge cancellation disconnects that client only. Terminal
stream errors settle pending writes and reject `closed`; output is neither
truncated nor replaced with a fabricated response.

On Windows use an app-selected named pipe such as
`\\.\pipe\moon-cheese-core`; on Linux/macOS use an app-selected Unix-domain
socket path in an existing writable directory. Select the same absolute Unix
path across UI and MCP launch contexts so differing working directories do not
select different endpoints. Node and the operating system
own their native endpoint requirements. A Unix socket left after an abnormal
host exit is reported as a connection/bind failure; the SDK does not delete an
existing endpoint to take ownership. The app owner can resolve that actual
stale endpoint after establishing its stopped lifecycle. Android requires its
host adaptation for local IPC and independent process ownership; application
services and `arcane/1` client semantics remain the shared boundary.

This source contract is distinct from a selected package/native artifact or
execution on a particular platform. Applications adopt it through the published
SDK and their corresponding native package build, not by copying this source.
