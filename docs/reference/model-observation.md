# Existing model observation

Model observation reads the existing renderer and Core owners selected by the
application. It exposes their current lifecycle, progress, retained errors and
actual operation identities to an explicitly selected developer observer.
Model loading, inference, selection, cancellation and saved application state
remain with those owners. Observation creates no model, accessor or Core runtime.

## Compose the existing Core

```js
import {createModelObservationService} from 'arcane-os/core/model-observation';

const observation = createModelObservationService({
    runtime: host.runtime,
    localAI: existingLocalAIService,
    image: existingImageService,
    decisions: existingDecisionService
});
host.runtime.registerService(observation);
```

`host` and the three services in this example are the application's existing
instances. `localAI`, `image` and `decisions` are optional and default to `null`.
Supply their actual service definitions, including `current()` and `methods`.
The constructor neither looks up nor starts a service. Registration can follow
`startCoreHost()` on its returned runtime, before opening an additional listener;
it requires no model readiness barrier.

The service is named `model-observation` and exposes `current()`, `dispose()` and
the fixed Core methods below. `dispose()` retires only its observation requests
and subscriptions. The host continues to own the Core and model services.

An external local caller can connect through the explicitly selected
[`startCoreListener`](core-shared-host.md) endpoint on that same runtime.
For a packaged window, `native.launchContext.coreListener: {endpoint}` selects
that same-runtime listener. Before binding it, the generated Core entry registers
`model-observation` with the actual existing `services` definitions that expose
`localai.status`, `image.status` and `decisions.status`; absent owners are `null`.
The observer reuses those model-service owners and creates no accessor or model.
The application supplies its renderer attachment separately.
The observation module does not discover endpoints, launch a host, reconnect,
change a profile, or create a second runtime. Native DOM inspection and actions
retain their separate [app-control contract](native-app-control.md).

## Attach existing renderer owners

SDK 0.86.1 adds the public `arcane-os/ai/model-observation` export to normal
generated browser import maps. Development applications keep `arcane-os` on
`latest`; after updating through their existing dependency workflow, run
`arcane import-map` before building or serving. The mapping uses the same
published browser module and changes no observation runtime behavior. Regenerate
through the public command rather than editing map entries by hand.

```js
import * as aiRuntimeState from 'arcane-os/ai-runtime-state';
import {attachModelObservation} from 'arcane-os/ai/model-observation';

const attachment = attachModelObservation({
    client: existingCoreClient,
    aiRuntimeState,
    imageRuntime: existingImageAccessor,
    decisionModel: existingBrowserDecisionModel,
    modelController: existingModelController,
    signal: pageLifetime.signal,
    onError: function reportObservationFailure(error) {
        developerDiagnostics.report(error);
    }
});
await attachment.ready;
```

Each optional owner defaults to `null`. Pass the instances already used by the
application. Creating another image accessor would describe that new accessor's
requests rather than the existing work. The supported owner methods are:

| Input | Read | Subscribe |
|---|---|---|
| `aiRuntimeState` | `getAIRuntimeState()` | `subscribeAIRuntimeState()` |
| `imageRuntime` | `current()` | `subscribe()` |
| `decisionModel` | `status()` | `subscribe()` |
| `modelController` | `status()` | `on('statechange')`, `on('progress')` |

The attachment returns `{ready, closed, current, close}`. `ready` resolves with
`{attachmentRequestId, coreRequestId}` after Core acknowledges the attachment.
`current()` returns the latest complete renderer snapshot read by this
attachment, or `null` when it was cancelled before reading. Subscriptions begin
after acknowledgement; the attachment then reads and publishes current state
again to cover changes during that handshake.

Caller abort, `pagehide`, retirement of the exact installed Core client,
transport failure, or `close()` removes the observation subscriptions and
cancels only this attachment's observation RPCs. A supplied client remains
caller-owned. The attachment never follows a replacement client or automatically
reattaches. Native document retirement also cancels its long-lived Core request.
Core then removes the renderer record; late publication to that retired
attachment fails honestly. Detachment does not unload or cancel a model.

`close()` returns `closed`, which settles after the attachment's observation
RPC promises settle locally. It does not claim that a remote model or host has
closed. Transport and observation errors remain available through `onError`
and the rejected public promises. With `onError` omitted they reach the developer
console. Normal cancellation, including cancellation initiated by the existing
client or native document owner, closes observation without a model error. When
cancellation precedes acknowledgement, `ready` rejects with the cancellation
while `closed` resolves after the observation RPCs settle.

## Read or subscribe from an existing client

```js
import {subscribeModelObservation} from 'arcane-os/ai/model-observation';

const current = await client.invoke('model.observation.current', {}, {signal});
const observation = subscribeModelObservation({
    client,
    signal,
    onState: function showRetainedOwners(snapshot) {
        developerDiagnostics.show(snapshot);
    },
    onDiagnostic: function showModelFailure(record) {
        developerDiagnostics.report(record);
    },
    onError: function showObservationFailure(error) {
        developerDiagnostics.report(error);
    }
});
await observation.ready;
```

`onState` is required. The returned `{ready, closed, current, close}` has the same
observation-only lifecycle as the renderer attachment. `ready` resolves with
the first current-state replay; `current()` holds the latest complete snapshot,
initially `null`. `onDiagnostic` explicitly selects live correlated Core model
failure frames. Omitting it requests state observation only. Callback failures
close that observation and reach `onError`; callback promises remain
caller-owned and may await `close()` without becoming its completion barrier.

Every snapshot is:

```js
{
    core: existingCoreRuntime.current(),
    native: {localAI, image, decisions},
    renderers: [{attachmentRequestId, coreRequestId, owners: {
        aiRuntimeState, imageRuntime, decisionModel, modelController
    }}]
}
```

The values represent complete supplied-owner snapshots. Absent optional owners
are `null`; absent renderer attachments produce an empty array. Core state also
contains its real active observation requests, identified by their actual
methods, alongside other active requests. Observation does not relabel them as
model work. Snapshots are current observations of independent owners, rather
than an atomic transaction across all owners.

## Fixed transport and correlation

| Method/event | Contract |
|---|---|
| `model.observation.current` | Empty parameters; returns the current snapshot without model refresh or readiness waits. |
| `model.observation.watch` | `{diagnostics:false}` by default; remains pending until cancellation. |
| `model.observation.state` | Targeted watch event `{watchRequestId,snapshot}`; the first event acknowledges the watch and replays current state. |
| `model.observation.error` | Targeted diagnostic `{watchRequestId,source:'core',method,frame}` preserving the complete original failed response frame. |
| `model.observation.renderer.attach` | `{snapshot}`; remains pending to own the renderer publication lifetime. |
| `model.observation.renderer.attached` | Targeted acknowledgement `{attachmentRequestId,coreRequestId}`. |
| `model.observation.renderer.publish` | `{attachmentRequestId,coreRequestId,snapshot}`; replaces that attachment's current snapshot and returns both attachment identities. |

Both helpers register listeners before invoking. Existing
[`client.invoke`](core-client.md) supplies `onRequest({requestId})` before send;
long-lived observation requests use `timeoutMs:0`. Their acknowledgement is a
targeted request event, while the invocation promise remains pending.

`attachmentRequestId` and `watchRequestId` are the actual client-visible Core
request identities supplied by service context `clientRequestId`.
`coreRequestId` is the actual internal Core frame identity;
renderer attachments are keyed by that value so clients with identical local
request IDs cannot collide. The renderer echoes both values when publishing.
`snapshot.core.activeRequests[].id` and diagnostic `frame.id` use internal Core
identities. They can differ from client-visible IDs under connection routing.
None of these observation/transport IDs is a model-operation ID.

Core supplies both metadata fields for direct runtime calls, stdio connections,
`startCoreListener()` connections and the existing `startSharedCoreHost()` path.
Each connection preserves the original incoming request ID as `clientRequestId`
independently of its established `requestId` mapping. Direct calls use the
incoming frame ID for both identities. Observation requires these actual
context fields; it does not infer them from `requestId` or rewrite event
payloads to manufacture correlation.

The exact `methods` keys on the supplied native service definitions select the
Core operations whose live failures can be observed. The observer tracks their
actual active request IDs while a watch exists. Core publishes request removal
before emitting its response; the observer retains that correlation until the
response arrives, then removes it. Removing the final watcher releases frame
observation and remaining transient correlation. It retains no failure history.

## Evidence and lifecycle limits

- AIRuntimeState exposes its existing llm/stt/tts records, including the reported
  operation ID. Its retained errors contain only code/message. Concurrent role
  work is not a complete request enumeration in this snapshot.
- The existing image accessor exposes its own active method, stream ID, status
  and progress records. Its retained error is preserved; that error has no
  reliable explicit stream association. Constructor-only diagnostic callbacks
  cannot be retroactively attached through this API.
- Browser and native decision snapshots retain their existing errors and active
  request counts. A count does not supply missing per-evaluation IDs.
- ModelController status exposes its existing state/progress and code/message
  error. Its load/unload event IDs are not retained by `status()`, and are not
  presented as inference IDs or reconstructed history here.
- Core supplies its real active request identities and complete live failed
  response frames. A watch cannot recover responses that settled before it
  observed them. Retained owner errors remain available in current snapshots.

Renderer `Error` values in owner error fields use the existing Core error
serializer at the JSON boundary; other owner fields remain unchanged. A value
the selected transport cannot encode fails through the observation error path
rather than being replaced with shortened or invented content. Observation
does not alter model inputs, outputs, prompts or their persistence policy.

The shared JavaScript contract is portable wherever the existing Core client
and supplied owners are available. Endpoint and native-host availability belong
to their documented adapters. Developer observation remains separate from
ordinary user status, app-owned stage/avatar association and actual model
execution verification. This capability does not establish that an inference
failure has been corrected.
