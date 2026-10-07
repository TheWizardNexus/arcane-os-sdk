# Core browser client

`arcane-os/core/client` is the browser-safe `arcane/1` RPC owner. It exports
`createCoreClient`, `createCoreFacade`, `installCoreClient`,
`getInstalledCoreClient` and `subscribeCoreClient`.
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

### Observe installation and retirement

```js
import {subscribeCoreClient} from 'arcane-os/core/client';

const lifetime=new AbortController();
const stop=subscribeCoreClient(function useCurrentClient({client,reason,error}){
    console.log('Moon-base connection owner:',client,reason);
    if(error)console.error('Core transport failed:',error);
},{signal:lifetime.signal});
// Call stop() or lifetime.abort() when this observer's owner ends its lifetime.
```

`subscribeCoreClient(listener, {global=globalThis, emitCurrent=true, signal}={})`
observes the exact SDK-installed client for that global without installing or
connecting one. By default it synchronously replays
`{client, previousClient:null, reason:'current', error:null}` after subscribing.
`client` is the same live object returned by `getInstalledCoreClient`, or `null`.
Set `emitCurrent:false` to observe only subsequent changes. The returned
unsubscribe function is idempotent; aborting `signal` removes the subscription.
A pre-aborted signal registers nothing and emits no replay.

Later notifications use the same fields. `reason:'installed'` follows the
connection attempt while that installation is still live, with
`previousClient:null` and `error:null`. Installation does not imply a connected
transport: a standalone client retains its ordinary disconnected capabilities.
Repeated installation returns the existing client without another notification.
`reason:'closed'` and `reason:'transport-failed'` identify the retired client in
`previousClient`; a transport failure retains its complete actual `CoreError`
in `error`, while ordinary close uses `null`.

Retirement releases and restores owned globals before notifying, once per
installation. `client` is read again after cleanup, so a replacement installed
reentrantly during cleanup or error reporting remains the current client.
Notifications do not restore or close that replacement. A listener may also
install a replacement after observing retirement; its installation produces
the normal next notification. Reentrant changes queue until the current
notification finishes reaching its observers. Each notification retains the
exact client and error references captured for that transition, so observers
receive retirement before a replacement installed by another observer. Global
installation changes remain synchronous; reading the accessor inside a callback
may therefore show a newer client than that callback's transition snapshot.

The existing shared SDK event owner delivers changes without polling or a
second event bus. Classic host injection may install synchronously before that
event owner is available. The first ESM subscriber attaches the shared event
source lazily and reads the exact classic-installed client from the live
installation. Source-scoped delivery preserves the client and error references;
it does not use the event owner's global diagnostic snapshots. No historical
installation record is retained for replay.

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

`client.invoke(method, parameters, {signal, timeoutMs, onRequest})` returns the actual
response result or rejects with `CoreError`. Parameters, result fields and
event data retain their complete supplied content. JSON encoding belongs only
to transports that require it; values crossing those transports must be
JSON-compatible. There is no client method allowlist or content limit.
The default request timeout is ten minutes; `timeoutMs:0` disables that timer.

`Arcane.ollama.running({signal, timeoutMs, onRequest}={})` forwards these request
options to the existing Core invocation without putting them in the Ollama
payload. It returns the complete resident-model snapshot; aborting its signal
cancels that inspection through the same request control path. Existing
`Arcane.ollama.running()` calls remain supported.

The compatibility facade retains its operation-specific timeouts and streaming
callbacks. Streaming IDs and isolated-operation IDs are separate protocol
correlation fields alongside the supplied request fields.

The optional `onRequest({requestId})` observer runs synchronously after the
client owns the request and before transport dispatch. It exposes the actual
Core correlation ID without adding fields to the supplied payload. A
pre-aborted request never calls the observer. A synchronous observer failure
rejects the request before sending; a returned promise is observed for errors
without delaying dispatch. If the observer cancels or closes the request,
the client does not subsequently send it.

`Arcane.speech.synthesize(request, {signal})` forwards the optional cancellation
signal through the same request lifetime. Existing one-argument calls retain
the 180,000 ms timeout and pass the complete request unchanged. A pre-aborted
signal sends no synthesis request; an in-flight abort sends `request.cancel`
and suppresses late responses. Actual synthesis interruption depends on the
registered speech service and its engine; the facade supplies no speech engine.
`AI.fetchTTS(payload, signal)` carries its caller-owned signal into this native
call and normalizes cancellation to `AbortError` with
`ARCANE_AI_REQUEST_ABORTED`, preserving the original error as its cause.

`Arcane.speech.transcribe(request, {signal, onRequest})` forwards cancellation through the
same request lifetime and retains its 180,000 ms timeout and complete request.
`AI.fetchSTT(audio, signal)` carries that signal into the native call. A
pre-aborted signal sends no transcription request; an in-flight abort sends
`request.cancel` and suppresses late responses. The registered transcription
service owns interruption and release of its actual engine operation.
Its optional request observer uses the same pre-dispatch correlation contract.

## Current-window state

`Arcane.window.state({signal}?)` reads the native window hosting the calling
document. `Arcane.window.setState({state}, {signal}?)` selects `normal`,
`maximized`, or `fullscreen` for that same window. Both use the existing
request lifetime and return `{platform:'windows', supported:true, state}`.
The observed `state` can also be `minimized`; minimize remains a native window
control rather than a selectable state in this operation.

```js
async function selectObservatoryWindow(state) {
    const result=await Arcane.window.setState({state});
    console.log('Observatory window state:',result.state);
}
```

Call this operation when the application's own setting or user action selects
a state. Initial state belongs to the descriptor's optional
[`native.window.state`](core-native-packaging.md#initial-native-window-size)
field. Saved Settings, their loading and the choice to persist a state remain
application-owned; the SDK adds no saved-state store or page-startup barrier.

The Windows host uses ordinary native normal/maximized states. Fullscreen
removes the window frame and occupies the selected monitor's full bounds,
including its taskbar area. It retains the preceding normal bounds and frame
controls for restoration. Selecting normal restores them; selecting maximized
restores them before maximizing. This is native window fullscreen, separate
from the browser Fullscreen API. It does not select TopMost, request foreground
activation, change the profile/origin or restart Core. A minimized fullscreen
window reports `minimized` until restored or another state is selected.

Visible transitions use a temporary native callback confined to this window's
UI thread and synchronous operation. It prevents activation of this window and
focus assignment to it or its descendants, then releases the callback. Other
windows and ordinary input remain untouched. Hidden initial configuration and
already-selected states allocate no callback; the application's ordinary first
show keeps its existing startup behavior. State reads observe the native
minimized/maximized state, rather than merely echoing the requested selection.

Malformed selections reject with `INVALID_ARGUMENT`; native operation failures
reject with `ARCANE_WINDOW_STATE_FAILED`. Complete native error/cause fields
remain available, with `details.requested`, `details.previous` and
`details.actual` describing the attempted selection and observed state. A
partial native change is observable rather than rolled back. Cancellation
suppresses late responses and does not undo a change the host already applied.
If native callback cleanup fails, it stops preventing activation immediately,
its handle remains owned, and the failure is returned. Simultaneous mutation and
cleanup failures retain both original errors. The owning window makes another
cleanup attempt during its normal close and reports any remaining failure.
State changes survive document navigation, while each response remains
correlated to its originating document. There is no state-change event in this
contract; `state()` reads the current native state when requested.

These methods require the matching Windows host executable. The current macOS,
Linux and Android hosts have no implementation of these operations; their
actual unavailable-method errors remain observable. Ordinary browsers have no
native window transport. The facade supplies no browser or other-host fallback,
and importing it does not add support to an older native executable.

## Current-window theme

`Arcane.window.setTheme(presentation, {signal}?)` changes only the window
hosting the calling document. It uses the existing `window.setTheme` request
and response correlation; it neither calls `appearance.apply` nor changes the
operating-system user's appearance. The complete presentation object reaches
the host unchanged.

Each optional `backgroundColor` and `textColor` is either `null` to restore the
platform default or `{red, green, blue, alpha}`. All four channels are numbers:
finite sRGB red/green/blue from 0 through 255 and alpha from 0 through 1.
Omitting a field leaves its current value unchanged. There is no scheme field.

```js
const host=globalThis.Arcane;
if(host?.runtime?.current().native&&host.window?.setTheme){
    host.window.setTheme(
        {
            backgroundColor:{red:29,green:22,blue:19,alpha:1},
            textColor:{red:248,green:239,blue:229,alpha:1}
        }
    ).then(
        function reportWindowColors(result){
            console.log('Moon observatory window colors:',result);
        }
    ).catch(
        function reportWindowFailure(error){
            console.error('Window color update failed.',error);
        }
    );
}
// Page rendering continues independently of the host request.
```

The result is `{platform, supported, applied, unsupported}`. `applied` contains
only requested fields the platform accepted in this call, including `null`
for an accepted default reset. `unsupported` lists requested fields the adapter
cannot apply. `supported` is true when at least one field was applied. These
are accepted settings, not measured pixels, and the operation is not atomic.
Malformed arguments reject with `INVALID_ARGUMENT`; native API failures reject
with `ARCANE_WINDOW_THEME_FAILED`, preserving the native error and
`details.applied`/`details.unsupported` for earlier results in this call.

The Windows host maps background/text to DWM caption/text attributes supported
on Windows 11 build 22000 and later, retaining normal system window controls.
It rounds RGB channels to the nearest integer, with midpoint values rounded
up, and returns those actual accepted values. Translucent colors remain
unsupported without changing the existing field. Older Windows reports those
fields unsupported. This contract makes no promise about caption-button colors.
The current macOS and Linux hosts have no implementation of this method;
their ordinary unavailable-method response remains observable. A new facade
alone does not add the operation to an older native executable. Use the
matching published host artifact for the selected SDK version.

Cancellation uses the normal request lifetime and suppresses late responses;
it does not roll back a setting the host already accepted. Window settings
survive document navigation until a subsequent document changes them or the
window closes. Responses belong to their originating document.

The shared [ThemeBootstrap](runtime-modules.md#themebootstrapjs) automatically
forwards the app's computed `--background` and `--text-color` in native hosts.
Applications using that owner need no duplicate theme listener. Ordinary
browsers keep their CSS presentation without making a native request.

## Native desktop notifications

`Arcane.notifications` uses the existing Core request transport to the actual
application window's native host. The Windows adapter is source implementation;
selected native build and actual OS delivery verification remain pending. A
matching published host is required for delivery. The portable facade is the
same on Windows, Linux and macOS, with Android requiring a host adapter; other
unimplemented hosts and direct shared-Core listener connections are unavailable.
Those listener connections bypass the window bridge. There is no browser
`Notification`, audio or simulated delivery substitute.

| Method | Parameters | Result |
| --- | --- | --- |
| `status(options?)` | Request options only | Actual native `supported`, `available` and `permissionDisabled`, with the host's reason/error when present |
| `show(request, options?)` | `{id,title,body,data}` | Complete notification record for the actual submission outcome |
| `state(selection = {}, options?)` | Optional `{id}` selects one owned ID; omission selects all retained records | `{revision,notifications:[complete records]}` |
| `close(selection, options?)` | `{id}` | Complete record after the exact owned notice's removal operation |

Every method accepts the standard `invoke` options `signal`, `timeoutMs` and
`onRequest({requestId})`. Requests, title/body strings and opaque JSON-compatible
`data` pass through unchanged. The application owns recipients, triggers, text,
deduplication and navigation. The OS controls presentation; preserving the
complete request does not establish that every character was visibly displayed.

`status()` changes no OS permissions or preferences. Only the exact Core error
`METHOD_NOT_ALLOWED` with `reason:'core-namespace-unavailable'` becomes
`{supported:false,available:false,permissionDisabled:null,
reason:'host-notifications-unavailable',error}`; `error` is the original complete
error and no platform is invented. All other invocation rejections propagate
unchanged. The native adapter can return an unavailable result with the complete
OS initialization or settings error. `permissionDisabled:null` means the permission state is
unknown. Use this status operation to discover the window adapter; Core's
service capability list does not describe host-intercepted notification methods.
Native `supported:null` means initialization could not establish OS support;
`available:false` retains its actual reason and complete error when supplied.

A retained record contains `{id,title,body,data,state,revision}` and the actual
timestamps, reasons and complete errors supplied by its owner. `submitted` means
the native `Show` call returned. It does not establish visible display or human
receipt. Later activation, dismissal and failure remain observable and retained.
A dismissal due to timeout does not establish removal from Notification Center.
Use `close({id})` for explicit OS removal. Closing retains the record; showing
the same caller ID again during this host lifetime rejects with its existing
record instead of resending or replacing it.
The top-level `event` names the latest observation, while `events` retains the
complete ordered history. An activation racing successful removal can report
`event:'activated'` with `state:'closed'`; the application owns action routing.

The live `notifications.state` event carries one complete updated record. It is
future-only. Subscribe before requesting the snapshot, then merge records by
their revisions so a delayed snapshot cannot overwrite a newer event:

```js
const records = new Map();
function receiveNotification(record) {
    const previous = records.get(record.id);
    if (!previous || record.revision >= previous.revision) records.set(record.id, record);
}
const stop = Arcane.events.on('notifications.state', receiveNotification);
try {
    const snapshot = await Arcane.notifications.state();
    for (const record of snapshot.notifications) receiveNotification(record);
} catch (error) {
    stop();
    throw error;
}
// Call stop() when this observation ends; it does not remove native notices.
```

When the installed Core client changes, detach the old event listener and ignore
its outstanding snapshot response. Recreate the records map for the new
client/host lifetime so an earlier host's revisions cannot suppress its records.
Subscribe and read the new client's snapshot
through [installation observation](#observe-installation-and-retirement).
Accepted notices and their records survive renderer navigation within the same
native host. There is no persisted cross-process recovery or cold-process
activation contract.

Windows reuses an SDK-created native identity and shortcut for the existing
WebView profile across launches, preserving that profile's OS notification
preferences. Its owned `AppUserModelId` registration stores the application's
display name, icon and live activator identity without changing notification
preferences or registering a cold-start launch command.
The SDK persists registration metadata only; its notification text
and data records remain in host memory. OS notification retention remains
platform-owned.
Distinct profiles have independent notification settings. One live notifier
owns a profile's COM activation registration; a second simultaneous host using
that profile reports `available:false` with
`reason:'notification-owner-already-running'` and may retry explicitly later.
Shutdown releases live COM ownership and owned notices while preserving the
identity registration for a later launch.

Cancellation observed before submission prevents that pending show from
submitting. After submission, request cancellation or renderer retirement cannot
reverse human interaction and does not remove the accepted notice; `close` is
explicit. Host shutdown drains owned operations, removes owned notices and
detaches callbacks, surfacing complete cleanup errors.

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

## Optional WebKit document lifetime

`webKitDocumentLifecycle:true` on `createCoreClient`, `installCoreClient` or
`createCoreClassicSource` selects document lifetime handling for the native
WebKit `arcane` handler with replies. It defaults to `false`; existing WebKit
plain-JSON and alternate acknowledgement transports, WebView2, Android,
development HTTP and supplied transports keep their existing behavior. The
selected host must implement this contract and the existing `runtime.replay`
control. Install the classic source at document start in the page's world.

The client owns a fresh activation for the current JavaScript realm and each
restoration from the browser's page cache. WithReply receives these transport
records; the Core JSON string remains unchanged in its separate `json` field:

| Record | Meaning |
| --- | --- |
| `{type:'activate', activation}` | Attach this activation before sending its Core frames. |
| `{type:'frame', activation, json}` | Send the complete serialized Core request or control. |
| `{type:'retire', activation, json}` | Retire this activation; `json` is the existing `requests.cancelAll` control. |

Reply with `{accepted:true}` or `{accepted:false,error}` on the initiating
WithReply promise. Frame and retirement acceptance follows the actual complete
process write. Queue admission alone is insufficient. Activation acceptance
follows the host's current-realm probe and any required prior-owner cancellation.
Only this activation's outgoing frames wait for attachment; page rendering,
facade installation and independent Core startup remain concurrent.
An aborted, timed-out or otherwise cancelled request awaiting attachment is
never submitted afterward; its existing cancellation control remains observable.

The host calls `__arcaneWebKitDocumentCurrent(activation)` in the current main
document's page world to probe a candidate. A token or native frame descriptor
alone does not identify the active document. Serialize candidate probes and
Core ingress ownership changes: finish each candidate's probe before processing
the next announcement, and leave the current owner unchanged when a probe is
false. Announcement arrival order cannot establish document order. A true
probe establishes the realm at that execution instant; every later delivery
still checks its target at execution time.

Before accepting a replacement activation, write the existing
`requests.cancelAll` control for the prior ingress owner. Do not wait for a
retirement announcement that a destroyed document may never send. Write a
retirement record's JSON only while that activation still owns ingress;
reject a late retirement without cancelling the replacement's requests.
Record request-ID-to-origin-activation correlation before submitting each
request to Core. Responses retain that origin. Existing generic service events
remain broadcasts to the current activation; no request association is added.
Complete native diagnostics retain frames received while no document is active;
restoration uses current-state replay rather than historical event delivery.

Deliver through `__arcaneReceive(json, activation)` and
`__arcaneTransportFailed(error, activation)`, passing payloads as native
JavaScript call arguments. Both return `false` for a retired or different
activation. Receive also returns `false` for an unrecognized frame or a
response with no pending request; `true` means the client accepted delivery,
which may still await its shared event owner. Failure returns `true` when it
ends that active installation. Preserve actual evaluation failures through the
native diagnostic owner; a `false` result is not a JavaScript exception.
`client.acceptsNativeDelivery(activation)` exposes the same synchronous lifetime
predicate. It accepts any activation while a client using an ordinary transport
is live. Direct owner calls to `client.failTransport(error)` retain their
existing terminal-failure semantics.

Page hide synchronously retires the activation even with no pending requests.
It clears completed ready state and rejects every pending renderer promise with
the existing `ARCANE_REQUEST_ABORTED`/`AbortError`. This ends the page's wait;
the runtime's cancellation skips service-lifetime work, so an accepted save
continues and participates in graceful drain. Its eventual response stays with
the retired activation and cannot settle a restored page's request. The client
does not claim that cancellation rolled back persistence.

Persisted page restoration creates a fresh activation and sends exactly one
`runtime.replay` after native attachment. Initial attachment sends that replay
only when `replayRuntimeState:true`. Application subscriptions survive page
hide and restoration, including registrations awaiting the shared event owner
and ready listeners awaiting their replay microtask. Queued deliveries from a
retired activation are no longer applicable to those subscriptions. Replay
supplies current Core/service state, not prior responses or request promises.
Closing the client retires once, removes lifecycle listeners and restores its
owned callbacks. It does not close the process or control application shutdown.

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
