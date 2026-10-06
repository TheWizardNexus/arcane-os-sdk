# Native Core runtime

The SDK owns the reusable native dispatcher and framed stdio transport.
The composing application or native host supplies its identity, version and
services. Product prompts, model selections, filesystem locations, host
privileges and application policy remain with that owner.

```js
import {createCoreRuntime} from 'arcane-os/core/runtime';
import {startCoreStdio} from 'arcane-os/core/stdio';
import catalogStore from './catalog-store.mjs';

const runtime = createCoreRuntime({
    application: {id: 'moon-cheese-catalog', name: 'Moon Cheese Catalog'},
    version: '1.0.0',
    services: [{
        name: 'catalog',
        methods: {
            'catalog.save': {
                lifetime: 'service',
                async handle(record) {
                    // catalogStore is supplied by this application's native owner.
                    return catalogStore.save(record);
                }
            }
        },
        async drain() {
            await catalogStore.flush();
        },
        async dispose() {
            await catalogStore.close();
        }
    }]
});

const transport = startCoreStdio({runtime});
await transport.closed;
```

The example's store is an application dependency, not an SDK-created database.
The runtime passes each request's `parameters` to its registered handler
unchanged. It preserves complete results and diagnostic errors; it neither
selects product data nor supplies replacement results.

## Registration and startup

`createCoreRuntime({application, version, services})` creates a dispatcher.
Supply the application's real descriptor and host release version. The built-in
`app.current` and `version.current` methods return those values; `system.ping`
returns `{ok:true}`. A ping establishes dispatcher responsiveness, not model,
service or application readiness.

`runtime.registerService({name, methods, start, drain, dispose})` registers one
native service. Method names are complete RPC names, such as `catalog.save`.
A method is either a handler function or `{handle, lifetime}`. A handler function
has request lifetime by default. Duplicate service or method names, including
the three built-in methods, are reported rather than replacing another owner.
Registration is a native composition API, not a browser command.

Registration returns `{ready, current}`. Reading `ready` starts that service and
returns its shared startup promise; `current()` exposes its state and actual
error. `runtime.start()` starts all registered services independently and returns
the current dispatcher state without waiting for them. A service registered
after startup starts independently as well. A method waits only for its own
service's startup before invoking its handler. State errors use the shared
complete diagnostic serialization; the startup promise retains its original
rejection value.

Each lifecycle hook receives `{application, service, emit, getService}`. Each request handler
receives `(parameters, {application, service, emit, getService, requestId, signal})`, with
`this` bound to its service definition. A hook or handler may publish a complete
service-owned event through `emit(event, data)`.

### Native service composition

`await runtime.getService(name)` and `await context.getService(name)` return the
actual registered service definition after that service's shared startup
promise. A lookup can start its selected dependency before `runtime.start()`;
it waits for that dependency alone, with no renderer, transport request or
all-service readiness barrier. Concurrent lookups reuse the same startup and
return the same object. Applications keep their service dependencies acyclic.

Use the returned service's documented native members, such as
[`getONNXRuntime()`](local-ai.md#native-service-owners), for same-process
composition. RPC handlers remain owned by the dispatcher; calling entries in
`service.methods` directly does not supply request tracking or cancellation.
No service lookup is exposed over the browser protocol.

An unregistered name rejects with `CORE_SERVICE_UNAVAILABLE`. Startup failure
rejects with the original error. New lookups reject with `CORE_CLOSING` once
shutdown begins; an already accepted lookup still settles with its startup.
Lookup provides readiness, not a lifetime lease or ownership transfer. Retain
each acquired native owner according to its own documented cleanup contract,
and use that retained handle during disposal rather than requesting a new one.
Independent services still dispose concurrently.

## State and frames

`runtime.current()` returns dispatcher state, application, version, per-service
state/errors and active request identities, methods and lifetimes.
`runtime.subscribe(listener, {emitCurrent:true, signal})` immediately replays the
current state and then observes changes through the canonical SDK event owner.
It returns an unsubscribe function. `runtime.onFrame(listener, {signal})`
observes outgoing protocol frames and also returns an unsubscribe function.
Attach transport listeners before starting the runtime to observe initial frames.

The shared `arcane-os/core/contracts` module owns `CORE_PROTOCOL` (`arcane/1`),
`CoreError` and `serializeCoreError`. Requests are:

```js
{
    protocol: 'arcane/1',
    type: 'request',
    id: 'request-1',
    method: 'catalog.save',
    parameters: {name: 'Lunar cheddar', notes: 'Keep the complete supplied text.'}
}
```

`await runtime.handle(frame)` returns and emits the correlated response:
`{protocol, type:'response', id, ok:true, result, time}` or
`{protocol, type:'response', id, ok:false, error, time}`. Framing and method
availability errors remain observable; unavailable services are not replaced
with browser behavior.

A request with no registered handler retains code `METHOD_NOT_ALLOWED` and
adds the exact `method`, its first dotted `namespace`, and a `reason`.
`core-namespace-unavailable` means the dispatcher has neither a service with
that name nor any registered method in that namespace. Otherwise the reason is
`core-method-unavailable`; the built-in `system`, `app`, and `version`
namespaces also count as present. This is a dispatch lookup result before any
handler or permission decision, not a capability-discovery call. A read-only
or partially registered service therefore never appears wholly absent.
Handler/startup/permission errors remain unchanged and acquire none of these
lookup markers. Generic or older `METHOD_NOT_ALLOWED` errors do not establish
namespace absence. An optional browser adapter may recognize the exact absent
namespace and method according to its own documented contract; the dispatcher
does not select or create another implementation.

Events have `{protocol, type:'event', event, data, time}`:

- `core.ready`: the dispatcher is connected; service/model readiness is separate.
- `core.state`: the current complete runtime state.
- `core.service.state`: a service's name, state and serialized error when present.
- `core.error`: a lifecycle or transport diagnostic.

A newly connected document may send
`{protocol:'arcane/1', type:'control', control:'runtime.replay'}`. The runtime
publishes one current snapshot: `core.ready` only when the dispatcher is ready,
then `core.state`, followed by `core.service.state` for every registered service.
Complete service errors and active request state are retained. Replay does not
start or restart services, dispatch a request, poll readiness or create a second
lifecycle owner. The runtime completes that snapshot before publishing lifecycle
changes triggered reentrantly by its listeners. A draining runtime reports its
draining state rather than announcing readiness.

Service states are `registered`, `starting`, `ready`, `failed`, `draining` and
`closed`. Dispatcher states are `created`, `ready`, `draining` and `closed`.
Complete diagnostics belong in the host's developer-facing error handling, not
in ordinary chat history or a fabricated conversation turn.

## Cancellation and shutdown

The `request.cancel` control names `requestId`; `requests.cancelAll` applies to
active request-lifetime operations. Cancellation is cooperative. The handler's
signal is aborted. An otherwise successful cancelled operation returns
`REQUEST_ABORTED` after its owned work settles; a handler's own rejection remains
the actual reported error. If startup is still pending, cancellation is checked before
the handler runs. A service that does not finish or respond to cancellation is
still unfinished; the SDK does not report a forced timeout as successful cleanup.

Use `lifetime:'service'` for accepted work, such as a save, that must survive a
renderer cancellation or disconnect. The dispatcher does not abort these
operations through request cancellation controls or its own shutdown. The
service still owns its persistence, queueing and failure semantics. A composing
host or native service can abort its own lifetime signal during shutdown;
in-flight native inference can therefore be cancelled even when the dispatcher
retains a service-lifetime response. Service lifetime does not promise survival
of native host shutdown.

`runtime.close()` is idempotent and retains the same completion promise. It stops
accepting new requests, cancels request-lifetime operations, waits for accepted
responses, then drains and disposes services. Independent services close
concurrently; each service's startup, drain and dispose remain ordered.
Shutdown errors remain complete and reject the close promise. A failed drain
does not prevent the service's dispose hook from running.

The final closed state is published before event subscriptions are released.
`current()` remains available afterward; the disposed runtime is not restarted.
The host must observe completion before terminating Core. The SDK does not call
`process.exit()`, kill a host or claim durability after an operating-system crash
or a host-forced termination.

## Stdio transport

`startCoreStdio({runtime, input, output, onError})` attaches a runtime and starts
it. Streams default to `process.stdin` and `process.stdout`; diagnostics default
to `console.error`, leaving stdout for protocol frames. It returns
`{runtime, closed, close}`. Observe `closed` for final completion or failure.

Frames use the existing `Content-Length` header followed by UTF-8 JSON. Length
is transport-local framing only. `encodeCoreFrame(frame)` and
`createCoreFrameDecoder(onFrame)` are also exported for host adapters. The
decoder accepts fragmented or multiple frames through `push(chunk)`;
`finish()` reports an incomplete final frame rather than dropping it.

Requests dispatch concurrently. Outgoing frames preserve their queued order and
wait for each writable-stream callback. Input EOF starts runtime shutdown, waits
for accepted service work and queued output, and resolves `closed` afterward.
An input stream closed without its normal EOF event also initiates this drain;
an already ended or destroyed input is handled when attached. Transport failures
reach `onError` and reject `closed`. The transport detaches
its listeners and pauses its input; it does not end caller-owned output streams
or take ownership of the host process.

## Platform and delivery boundary

These modules use portable Node and JavaScript facilities for Windows, Linux
and macOS native hosts. Android requires its native transport/host adaptation;
the module is not a Node runtime embedded inside a WebView. Browser callers use
the separate [Core client](core-client.md).

The dispatcher/transport sources are one part of Core extraction. They do not
by themselves replace existing native host bundles, platform adapters, provider
loading, packaging or OS composition. Those owners must adopt the selected
published SDK boundary and preserve their real shutdown and service lifecycles.
