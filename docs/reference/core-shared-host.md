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

`await connection.shutdown(invokeOptions)` explicitly invokes the host-owned
`core.host.shutdown` operation. It drains the shared runtime, returns
`{state:'closed'}` after successful service cleanup, then closes the connection.
A drain failure returns the full Core error. Shutdown affects **all** clients
of that app endpoint and belongs to the application owner's explicit lifecycle,
not ordinary UI/MCP cleanup. The host reserves this one method; application
services should use their own namespaces. Cancelling the caller's invoke wait
after shutdown acceptance does not undo the shared shutdown.

## Correlation, events, and state

Each connection has its own request-ID space. The transport substitutes an
internal Core request ID and restores the originating ID on responses and
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

`runtime.replay` sends only that connection the current `core.ready`,
`core.state`, and `core.service.state` snapshot. Optional synchronous
`getReplayEvents()` returns current `{event,data}` records from their actual
service owners. It is for current domain state, not historical chunks or
retired requests. Subscribe before requesting a domain snapshot when its live
events may change; applications own those domain methods and state.

## Native launch and platforms

The generated portable Core entry keeps ordinary stdio behavior unless the
explicit launch context contains:

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
the complete launch context retain their existing values. There is no implicit
shared mode or new application descriptor field.

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
