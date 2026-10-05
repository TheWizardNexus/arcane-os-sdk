# Core browser client

`arcane-os/core/client` is the browser-safe `arcane/1` RPC owner. It exports
`createCoreClient`, `createCoreFacade`, `installCoreClient` and
`getInstalledCoreClient`.
`arcane-os/core/contracts` exports `CORE_PROTOCOL`, `CORE_READY_EVENTS`,
`CORE_FRAME_CONTRACTS`, `CORE_METHOD_CONTRACTS`, `CoreError` and
`serializeCoreError`. Contracts describe transport and existing method shapes;
they do not select application policy or decide which services are installed.

## Native connection and explicit adapters

```js
import {installCoreClient} from 'arcane-os/core/client';

const client=installCoreClient();
const stop=client.events.when('core.ready',state=>{
    console.log('The moon-base dispatcher is connected.',state);
});
```

Installation immediately supplies `globalThis.Arcane`, `__arcaneReceive`,
synchronous `Arcane.runtime.current()` and `Arcane.events.completed(name)`.
Repeated installation returns the same client. Existing namespace method names
remain available through this facade; their implementations and availability
belong to the selected host. No repository, app list, model selection or service
implementation is installed by importing this client.

An application using a host-installed client can read it without installing or
replacing anything:

```js
import {getInstalledCoreClient} from 'arcane-os/core/client';

const client=getInstalledCoreClient();
// null means this global has no live SDK-installed client.
```

`getInstalledCoreClient(global=globalThis)` returns the exact live SDK-installed
client, including one installed by classic document-created injection. It does
not connect, install a client or replace an existing `Arcane` object. Applications
need not inspect private installation fields. It returns `null` after that
installation closes or fails. A
foreign application's `Arcane` object is not evidence of an SDK installation.

The native adapters select WebView2, WebKitGTK or Android WebView. Ordinary
browsers remain `standalone`; they do not probe a local server. Development
HTTP is selected only by the existing explicit `__ARCANE_DEV_HTTP__` flag.
Native process startup and shutdown belong to the native host/runtime, not
this browser module.

For a separately owned transport, use `createCoreClient({transport})` with
`transport.name`, `send(frame)`, and an optional `subscribe(receive)` returning
an unsubscribe function. Alternatively deliver responses/events through
`client.receive(frame)`. An adapter may return a promise from `send`; rejection
rejects the associated pending request. If cancellation, timeout or a response
has already settled it, `onError` observes the later send failure. A transport
without callable `send(frame)` remains disconnected and reports
`ARCANE_TRANSPORT_INVALID`; it does not announce `transport.ready`.
`autoConnect:false` defers connection until `connect()` or the first invocation.

`replayRuntimeState:true` sends one `runtime.replay` control after the transport's
receive listener and `transport.ready` are established. The default is `false`,
preserving existing hosts. The send is observed without delaying page startup;
delivery errors reach `onError`. A host supporting this control supplies its
current dispatcher and service state for a newly connected document, without
restarting services. Repeated `connect()` calls on the same connection do not
send another replay. See [runtime replay](core-runtime.md#state-and-frames).

`client.invoke(method, parameters, {signal, timeoutMs})` returns the actual
response result or rejects with `CoreError`. Parameters, result fields and
event data retain their complete supplied content. JSON encoding belongs only
to transports that require it; values crossing those transports must be
JSON-compatible. There is no client method allowlist or content limit.
The default request timeout is ten minutes; `timeoutMs:0` disables that timer.
The compatibility facade retains its operation-specific timeouts and streaming
callbacks. Streaming IDs and isolated-operation IDs are separate protocol
correlation fields alongside the supplied request fields.

## Events and request lifetime

`events.on(name, listener)`, `once(name, listener)` and
`when(name, listener)` return unsubscribe functions. Named listeners receive
the original `data`; `on('*', listener)` receives `{event, data}`. The shared
SDK event owner provides delivery, with one source per client and no competing
event bus. `when` replays the first authoritative `transport.ready` or
`core.ready` state once, on a microtask. `completed` is synchronous.

Transport connection, Core dispatcher readiness, application-service state,
repository synchronization and model readiness are different states.
`core.ready` does not claim that a model is loaded or an app repository synced.
Other service events pass through normally; this client does not fabricate
service readiness.

Abort/timeout sends `request.cancel`; `cancelAll()` and page hide send
`requests.cancelAll` for pending renderer requests. Late responses cannot
resolve a cancelled request. These controls do not promise to roll back an
accepted mutation. Accepted saves, operation journals and graceful drain belong
to the service/runtime owner. `client.close()` releases its subscriptions,
native callbacks, timers and pending renderer requests; it does not kill Core.
Call `stop()` to remove an individual subscription and `client.close()` when
the client owner ends its lifetime.

For an actual terminal child-process or transport failure, the host calls
`client.failTransport(error)`. Installed clients also own the native callback
`globalThis.__arcaneTransportFailed(error)`. This boundary rejects pending RPCs
and WebKit acknowledgements with the complete actual `CoreError`, reports that
failure once, releases callbacks/subscriptions/timers and rejects future
invocations with the same failure. It sends no cancellation frames to a failed
transport and does not invent response identifiers or results. A normal close
still uses cancellation rather than reporting a transport failure.

Closing or failing an installation restores its previous `Arcane` object and
native callbacks only when those globals still belong to that installation.
Another owner's later replacements remain unchanged. The read-only accessor
returns `null` before the installed failure is reported to `onError`.

Errors retain complete native fields, including diagnostics and stack/cause
information. WebView2 and Android bridge failures retain native error codes,
messages and diagnostic fields; the request method and transport are added
where the native error does not already supply them. Errors without a native
code receive the adapter's bridge-call failure code. Keep those details in
developer diagnostics, rather than ordinary
product status surfaces. The optional `onError(error)` callback observes
transport/event-owner failures outside individual request promises.

## Classic native-host injection

```js
import {createCoreClassicSource} from 'arcane-os/core/classic-source';

const source=await createCoreClassicSource({
    eventOwnerModuleURL:'/arcane/sdk/event-manager.mjs',
    replayRuntimeState:true
});
// Supply source to the native host's existing classic-script injection owner.
```

This Node-only source generator reads the canonical client and contracts in the
installed SDK. It emits the same implementation as a classic script, without
copying another client or adding a bundler. The caller supplies the actual
served SDK event-manager URL; the example URL must match its selected layout.
That module and its existing managed import map must be included by packaging.
Select `replayRuntimeState:true` only when composing a host with the current
runtime replay control; omitting it preserves the existing no-replay default.

The generated facade, native receive callback and current-state methods install
synchronously. When the shared event owner already exists, it is reused
immediately. Document-created injection can precede the page's import map, so
only its event-owner module import waits until document parsing completes.
Page rendering and RPC setup continue independently. Complete early event
frames, subscription operations and response deliveries remain ordered until
the event owner connects. Work received reentrantly during that handoff joins
the end of the existing queue, including new subscriptions and response frames.
Final response completion follows earlier event
delivery, preserving streaming callbacks before their completion cleanup.
`client.eventsReady` observes that connection; failures are also reported
through `onError` and reject pending requests.

The SDK's [portable native provider](core-native-packaging.md) assembles the
Core runtime and selected app services without a native-provider checkout.
It does not distribute a Core executable or change OS callers. Executable
platform hosts and their cutover remain separately owned work.
