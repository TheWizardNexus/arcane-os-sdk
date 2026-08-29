# EventManager and time-travel diagnostics

`arcaneEvents` gives Arcane SDK publishers one canonical synchronous event
authority per JavaScript realm. `EventManager` remains the constructor for an
isolated strict pub/sub bus and optional bounded diagnostic timeline. Use source
handles for SDK semantic events; use isolated managers for local diagnostics,
DOM capture, export, and review.

The API is capability-first:

- ordinary pub/sub works in Node and browser JavaScript;
- duplicate module URLs reuse the same branded `globalThis.arcaneEvents` value;
- canonical occurrences expose only deeply frozen privacy-admitted public detail;
- rich compatibility detail remains local to source listeners and DOM projection;
- recording creates immutable, normalized `arcane-event-stack/1` records;
- browser DOM capture is opt-in and privacy-preserving by default;
- review playback is safe by default; live event redispatch is explicitly effectful;
- no event stack is uploaded, persisted, bridged to Core, or sent to a cloud service
  automatically.

All 32 JavaScript exports are available from both `arcane-os` and
`arcane-os/event-manager`. The bindings are identical, so choose the focused
subpath when event instrumentation is the only SDK capability you need. Node
can resolve either package entrypoint. The generated browser map intentionally
exposes only the focused `arcane-os/event-manager` entry, not the Node package
root.

## Quick start

```javascript
import {
    arcaneEvents,
    createArcaneEventSource,
    createEventManager,
    projectArcaneDOMEvent,
    PLAYBACK_RECORD_EVENT
} from 'arcane-os/event-manager';

const events=createArcaneEventSource(editorController,{
    source:'app.editor',
    eventTypes:['document.save.completed']
});

const unsubscribe=arcaneEvents.subscribe('document.save.completed',occurrence=>{
    console.info('Saved',occurrence.detail.documentId);
});

const publication=events.dispatch(
    'document.save.completed',
    Object.freeze({documentId:'example',document:liveDocument}),
    {operationId:'save-42',publicDetail:{documentId:'example'}}
);
projectArcaneDOMEvent(editorElement,publication.occurrence);
unsubscribe();

const diagnostics=createEventManager({timeTravel:true});
const stack=diagnostics.exportStack();
diagnostics.on(PLAYBACK_RECORD_EVENT,record=>console.info(record.type));
await diagnostics.playback({stack,mode:'review',speed:0});
```

Recording is disabled by default. Keep isolated diagnostic sessions bounded,
export intentionally, then call `clearHistory()`.

## Availability and normalization

| Capability | Node | Browser renderer | Native/Core host | Remote or cloud | Normalization |
| --- | --- | --- | --- | --- | --- |
| Canonical per-realm authority and source occurrences | Yes | Yes, per window or worker realm | Only when the SDK module runs in that JavaScript realm | No automatic transport | `arcane-event-authority/1`, `arcane-event-source/1`, and `arcane-event-occurrence/1` |
| Pub/sub, semantic instrumentation, parse/export, seek, playback | Yes | Yes, through a bundler or the managed Arcane import map | Only when the SDK module runs in that JavaScript host | No automatic transport | Same synchronous API; optional immutable JSON-like snapshots |
| DOM selectors and target descriptions | With DOM-like values or a test shim | Yes | No native UI observation | No | Stable diagnostic descriptors |
| DOM interaction and mutation capture | No native DOM | Yes | No | No | DOM activity becomes semantic event-stack records |
| Event-stack schema | Yes | Yes | Data contract only | Can be transported explicitly by the developer | `arcane-event-stack/1` |

In an external or physical-v1 integrated workspace, the managed browser map
resolves `arcane-os/event-manager` to
`./arcane/sdk/event-manager.mjs` and its private bare dependency
`event-pubsub` to
`./arcane/sdk/dependencies/event-pubsub/index.js`. The canonical
integrated-legacy workspace retains its older physical routes instead. The
selected Arcane browser runtime does not inject this SDK-authored module into
Shell, Provisioner, Core, or built-in apps. There is no transparent fallback to
the Node package root, `arcane/1`, HTTP, WebSocket, Ollama, or a cloud event
service.

## Export summary

| Export | Kind | Primary capability |
| --- | --- | --- |
| `ARCANE_EVENT_STACK_PROTOCOL` | String constant | Identify the durable stack format |
| `ARCANE_EVENT_AUTHORITY_PROTOCOL` | String constant | Identify singleton authority compatibility |
| `ARCANE_EVENT_OCCURRENCE_PROTOCOL` | String constant | Identify canonical occurrences |
| `ARCANE_EVENT_SOURCE_PROTOCOL` | String constant | Identify source handles |
| `ARCANE_EVENT_AUTHORITY_BRAND` | Global symbol | Inspect the authority brand descriptor |
| `ARCANE_EVENT_AUTHORITY_KIND` | String constant | Identify an authority descriptor |
| `ARCANE_EVENT_SOURCE_KIND` | String constant | Identify a source descriptor |
| `ARCANE_EVENT_LISTENER_ERROR_EVENT` | String constant | Observe privacy-safe listener failures |
| `ARCANE_EVENT_SOURCE_DISPOSED_EVENT` | String constant | Observe a source's final occurrence |
| `ARCANE_EVENT_ERROR_CODES` | Frozen object | Match stable authority error codes |
| `TIME_TRAVEL_SEEK_EVENT` | String constant | Observe review-cursor movement |
| `PLAYBACK_STARTED_EVENT` | String constant | Observe playback startup |
| `PLAYBACK_RECORD_EVENT` | String constant | Receive safe review records |
| `PLAYBACK_COMPLETED_EVENT` | String constant | Observe successful completion |
| `PLAYBACK_CANCELLED_EVENT` | String constant | Observe cancellation |
| `PLAYBACK_FAILED_EVENT` | String constant | Observe playback failure |
| `TIME_TRAVEL_OVERFLOW_EVENT` | String constant | Identify the terminal retention marker |
| `DOM_INTERACTION_EVENT` | String constant | Identify normalized DOM interactions |
| `DOM_MUTATION_EVENT` | String constant | Identify normalized DOM mutations |
| `DOM_OBSERVATION_STARTED_EVENT` | String constant | Identify DOM-capture startup |
| `DOM_OBSERVATION_STOPPED_EVENT` | String constant | Identify DOM-capture shutdown |
| `DEFAULT_DOM_EVENT_TYPES` | Frozen string array | Use Arcane's default DOM capture set |
| `domSelector()` | Function | Build a diagnostic DOM locator |
| `describeDOMTarget()` | Function | Normalize a DOM event target |
| `createDOMInstrumentation()` | Function | Attach interaction and mutation capture |
| `parseEventStack()` | Function | Strictly import and freeze a stack |
| `EventManager` | Class | Create an isolated bus and timeline |
| `createEventManager()` | Function | Create an `EventManager` |
| `arcaneEvents` | Branded `EventManager` authority | Observe canonical SDK events in this realm |
| `createArcaneEventSource()` | Function | Register one declared semantic source per owner |
| `projectArcaneDOMEvent()` | Function | Project one occurrence to one `CustomEvent` |
| `isArcaneEventOccurrence()` | Function | Recognize authority-created occurrences and views |

## `EventManager`

### Overview

Creates an isolated synchronous `event-pubsub` bus. Time-travel recording,
snapshot capture, retention, DOM observation, import/export, cursor movement, and
playback are layered around that bus.

### Constructor

```javascript
new EventManager({
    timeTravel=false,
    dom=null,
    captureStacks=false,
    redactSensitive=true,
    maxEvents=10_000,
    maxSnapshotDepth=50,
    maxSnapshotEntries=1_000,
    maxSnapshotStringLength=10_000,
    clock=()=>new Date(),
    now=performance.now-or-Date.now,
    sessionId=randomUUID-or-local-id
}={})
```

`dom` may be a root directly or an options object containing `root`. Source and
error stacks are omitted unless `captureStacks` is true. Redaction, depth, entry,
string, and retention bounds are applied before records enter history.
`maxSnapshotStringLength` defaults to 10,000 and must be a safe integer of at
least 64; the other numeric retention limits must be positive safe integers.

### Properties

| Property | Value |
| --- | --- |
| `list` | Underlying subscriber registry from `event-pubsub` |
| `sessionId` | Current non-empty session identifier, at most 256 characters |
| `timeTravelEnabled` | Whether new string-typed events are being recorded |
| `replaying` | Whether playback is active |
| `cursor` | Current sequence selected or delivered; `0` means before the first event |
| `eventCount` | Retained record count, including an overflow marker |
| `maxEvents` | Configured ordinary-record limit |
| `overflowed` | Whether retention ended with an overflow marker |
| `history` | Frozen array copy of immutable records |
| `domInstrumentation` | Attached DOM controller or `null` |

### Methods

#### `on(type, handler, once=false)`

Registers a synchronous handler and returns the manager.

#### `once(type, handler)`

Registers a synchronous one-shot handler and returns the manager.

#### `off(type='*', handler='*')`

Removes matching subscriptions and returns the manager.

#### `reset()`

Clears subscriptions and returns the manager. It does not clear recorded history.

#### `emit(type, ...payload)`

Synchronously delivers arbitrary payload arguments. String event types are
recorded while time travel is enabled. Non-string types are delivered without a
record. Subscriber exceptions are recorded as a failed dispatch and rethrown.
Subscriber promises are not awaited.

```javascript
events.on('ready',(documentId,revision)=>console.info(documentId,revision));
events.emit('ready','document-7',3);
```

#### `instrument(type, payload, metadata={})`

Delivers one semantic payload and records optional `source`, `category`,
`correlationId`, and `causationId` metadata.

```javascript
events.instrument('sync.completed',{count:12},{
    source:'app:library',
    category:'operation',
    correlationId:'sync-9'
});
```

#### `forward(event, metadata={})`

Requires a non-array object with a string `type`, then instruments that object as
the event's single payload. SDK operation queues use this shape to mirror their
already-normalized events through `arcaneEvents` once.

#### `enableTimeTravel({dom}={})`

Enables recording and optionally attaches DOM capture. An overflowed manager must
be cleared before it can be enabled again.

#### `disableTimeTravel()`

Stops attached DOM capture, records its stopped lifecycle boundary, disables
recording, and returns the manager.

#### `attachDOM(root=globalThis.document, options={})`

Stops and replaces the current DOM controller. The new controller starts
immediately when recording is enabled. Returns the controller.

Attaching at the exact retention limit causes the DOM-start event to trigger the
normal terminal overflow path. In that case the returned controller is inactive,
`timeTravelEnabled` is false, `overflowed` is true, and the final retained record
is the overflow marker. No stopped lifecycle record is appended after it.

#### `detachDOM()`

Stops DOM capture, clears the controller, and returns the manager.

#### `clearHistory({newSession=true}={})`

Clears history, sequence, cursor, and overflow state. By default it creates a new
session identifier; pass `newSession:false` to retain the existing identifier.
History cannot be cleared during synchronous dispatch or playback.

#### `getEventStack({fromSequence=1, toSequence=Number.MAX_SAFE_INTEGER, type=null}={})`

Returns a frozen array of records within the inclusive sequence range, optionally
restricted to one exact event type.

#### `exportStack({space=2}={})`

Returns a JSON document with the current session and retained history. `space`
must be a safe integer from 0 through 10. Export does not write a file, persist,
upload, or transmit anything.

#### `seek(sequence)`

Moves the review cursor to `0` or an existing sequence, emits
`TIME_TRAVEL_SEEK_EVENT`, and returns the selected record or `null` for zero.
Seeking never rewrites DOM, storage, native state, processes, or network state.

#### `playback(options={})`

```javascript
await events.playback({
    stack:null,
    fromSequence:1,
    toSequence:Number.MAX_SAFE_INTEGER,
    speed:0,
    mode:'review',
    signal,
    onRecord
});
```

Only one playback may run at a time. `stack:null` uses current history; a string
or object is passed through `parseEventStack()`. Recording is suppressed during
playback.

| Mode | Behavior | Safety |
| --- | --- | --- |
| `review` | Emits every immutable record as `PLAYBACK_RECORD_EVENT` | Default; intended for debugger and timeline UIs |
| `events` | Redispatches `record.type` with the normalized payload arguments | Effectful; use only in an isolated harness |
| `none` | Emits no per-record bus event; only invokes `onRecord` | Useful for controlled analysis |

`speed:0` delivers immediately. A positive speed preserves recorded monotonic
delays, divided by the multiplier. `onRecord(record)` may be async and is awaited.
An `AbortSignal` cancels waiting or delivery; playback emits exactly one terminal
completed, cancelled, or failed lifecycle event, rejects on cancellation/failure,
and restores `replaying` in all cases.

### Availability and normalization

The class is host-neutral JavaScript in Node and browser module graphs. DOM capture
requires a browser-compatible root. Event values are delivered to live subscribers
unchanged; only the optional historical copy is normalized.

### Example

```javascript
import {EventManager} from 'arcane-os/event-manager';

const events=new EventManager({timeTravel:true,maxEvents:500});
events.emit('workspace.opened',{workspaceId:'local-demo'});
console.info(events.history[0].status); // "completed"
events.clearHistory();
```

## `createEventManager()`

### Overview

Convenience factory equivalent to `new EventManager(options)`.

### Signature

```javascript
createEventManager(options)
```

### Availability and normalization

Node and browser JavaScript; identical behavior to the constructor.

### Example

```javascript
import {createEventManager} from 'arcane-os/event-manager';
const events=createEventManager({timeTravel:true,maxEvents:1_000});
```

## `arcaneEvents`

### Overview

The SDK's canonical per-realm event authority. Module evaluation first inspects
the own descriptor of `globalThis.arcaneEvents`. If absent, it constructs,
brands, and installs one authority as a non-enumerable, non-writable,
non-configurable data property. A duplicate module URL validates and reuses that
exact object without constructing a transient second bus. Accessor collisions,
unbranded values, malformed descriptors, incompatible protocols, and incomplete
APIs fail closed with stable `ARCANE_EVENT_AUTHORITY_*` codes.

### Value

```javascript
globalThis.arcaneEvents === arcaneEvents
arcaneEvents.protocol === 'arcane-event-authority/1'
arcaneEvents[ARCANE_EVENT_AUTHORITY_BRAND] === 'arcane-event-authority/1'
```

### Availability and normalization

Exactly one authority per JavaScript realm. A window, worker, frame, Node realm,
or process has its own boundary. Nothing automatically transports occurrences
to another realm, Core, a native host, or a remote service.

`subscribe(type,handler,{once=false,signal}={})` observes one exact canonical
event type. `handler` is a function or EventListener object and receives the
canonical occurrence as its sole argument. The returned idempotent unsubscribe
has `unsubscribe.dispose === unsubscribe`. An already-aborted signal installs
nothing; later abort marks the listener inactive synchronously and removes it
without corrupting an in-progress dispatch. `'*'` is not a canonical subscription
type.

`createSource(owner,{source,eventTypes,onListenerError?})` is the authority
method used by the exported
`createArcaneEventSource(owner,{source,eventTypes,onListenerError?})` wrapper.
Both return the same frozen singleton-backed source handle; neither constructs
an EventManager, EventTarget, or component-local bus.

`addEventListener()` and `removeEventListener()` expose EventTarget-shaped
canonical registration, including function/EventListener-object callbacks,
type/listener/capture deduplication, `once`, and `signal`. They return
`undefined`. Authority-level `dispatchEvent()` is a deprecated admission adapter
for older `aiRuntimeEvents` callers. It accepts an Event-like value with a valid
type and data `detail`, creates one new occurrence from source
`event-target-compatibility`, preserves preexisting and observer cancellation,
and never uses raw `EventManager.emit()` as a parallel path.

The inherited `on`, `once`, `off`, `reset`, `emit`, `instrument`, and `forward`
surface is retained for legacy direct diagnostics. Its registrations are
separate: source dispatch does not re-emit raw compatibility detail to legacy
listeners, and legacy `off()`/`reset()` cannot remove canonical or source-owned
registrations. New SDK publishers use `createArcaneEventSource()`.

### Example

```javascript
import {arcaneEvents} from 'arcane-os/event-manager';

const unsubscribe=arcaneEvents.subscribe('sdk.operation.completed',occurrence=>{
    console.info(occurrence.occurrenceId,occurrence.detail);
});
unsubscribe();
```

## `createArcaneEventSource()`

### Overview

Registers one active semantic source for a non-null object or function owner.
The options object has only `source`, `eventTypes`, and optional
`onListenerError`. Source and event names are trimmed lowercase identifiers of
at most 128 characters matching
`^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`. `eventTypes` contains 1 through 256 unique
declared types. A second active source for the same owner fails closed.

### Signature and result

```text
createArcaneEventSource(owner, options)
```

```javascript
const source=createArcaneEventSource(owner,{
    source:'sdk.document-store',
    eventTypes:['document.saved'],
    onListenerError(error,errorOccurrence){
        reportOwnerLocalFailure(error,errorOccurrence?.occurrenceId??null);
    }
});
```

The returned handle and its descriptor are frozen. The descriptor identifies
`arcane-event-source/1`, the stable source name, an authority-sequenced opaque
`arcane-source-<base36>` instance id, and the declared event types plus the final
`arcane.event.source.disposed` event. IDs are unique only during one authority's
lifetime in one realm.

The authority descriptor is exactly
`{kind:'arcane-event-authority',protocol:'arcane-event-authority/1',realm:'current'}`.
The source descriptor is exactly
`{kind:'arcane-event-source',protocol:'arcane-event-source/1',source,instanceId,
eventTypes}`; `eventTypes` is frozen and includes the declared types followed by
`arcane.event.source.disposed`.

### Dispatch

```javascript
const {occurrence,accepted}=source.dispatch(
    'document.saved',
    Object.freeze({document:liveDocument,documentId:'document-7'}),
    {
        operationId:'save-42',
        publicDetail:{documentId:'document-7'},
        cancelable:true
    }
);
```

`dispatch()` is synchronous. Exact canonical subscribers run first in
registration order, followed by this source's exact `on()`/EventListener
registrations in registration order. Source listeners receive one frozen
EventTarget-compatible view whose `detail` is the locally held compatibility
detail, whose `target` and `currentTarget` are the source owner, and whose
cancellation state is shared with the occurrence. Function listeners also
receive that owner as `this`. The public
occurrence contains:

```javascript
{
    protocol:'arcane-event-occurrence/1',
    occurrenceId:'arcane-event-<base36>',
    type,
    source,
    instanceId,
    operationId,       // string or null
    detail,            // defensive, privacy-admitted, deeply frozen snapshot
    cancelable,
    get defaultPrevented(),
    preventDefault()
}
```

The frozen result is `{occurrence,accepted:!occurrence.defaultPrevented}`.
Cancellation does not roll back domain work automatically. All active listeners
run even when one prevents default or throws. Listener exceptions create one
nonrecursive, privacy-safe `arcane.event.listener.error` occurrence and are
reported through `reportError` or `console.error`; committed source dispatch does
not throw because an observer failed. `onListenerError(error,errorOccurrence)`
is invoked synchronously only at the source-owner boundary after canonical error
publication and platform reporting. Its second argument is the canonical
listener-error occurrence, or `null` only if that secondary publication could
not be constructed. If the callback throws, its failure is reported directly
without another listener-error occurrence. The listener-error public detail is
exactly `{code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',reason:'listener-threw',
eventType,occurrenceId,source,instanceId,operationId}`.

Canonical publication never awaits a listener return value and exposes no
Promise-returning publication API. Domain promises and `createEventQueue()` own
asynchronous work, ordered callback backpressure, and async failure. Synchronous
source generation, occurrence creation, sticky state commits, subscription
installation, and cancellation admission stay on the authority call stack.

`on(type,handler,{once=false,signal}={})` and `subscribe()` on the source are
aliases returning an idempotent disposable unsubscribe. `once()` is the
one-delivery form. `addEventListener()`/`removeEventListener()` use EventTarget
deduplication, ignore null or non-listener callbacks, and return `undefined`.
The stricter `on()`/`subscribe()` APIs reject invalid handlers.
`dispatchEvent(event)` is a compatibility
adapter that accepts only a declared type, preserves cancellation, and publishes
a new canonical occurrence rather than the raw input.

`dispose()` is idempotent: the first call publishes the final noncancelable
`arcane.event.source.disposed` occurrence, removes source-owned registrations,
and returns `true`; reentrant or later calls return `false`. Dispatch or new
registration after disposal fails with `ARCANE_EVENT_SOURCE_DISPOSED`. The owner
may register a new source after disposal. Its compatibility detail is
`{source,instanceId,reason:'source-disposed'}` and its public detail is
`{reason:'source-disposed'}`. `destroy()` aliases `dispose()`.

Already-frozen compatibility detail retains its identity. Other rich
compatibility detail is shallow-copied and frozen when it is a plain record or
array; host objects such as DOM nodes, `File`, or `Error` remain local and are
not recursively frozen. Compatibility detail never enters canonical
EventPubSub/time-travel payloads. Only privacy-admitted `publicDetail` enters the
occurrence and optional diagnostics.

### Availability and normalization

**Node and browser/bundler, within the current JavaScript realm.** This wrapper
reuses `globalThis.arcaneEvents`; it creates no second bus or asynchronous work
owner. Admission, publication, cancellation, and teardown remain synchronous.

### Example

```javascript
import {createArcaneEventSource} from 'arcane-os/event-manager';

const source=createArcaneEventSource({}, {
    source:'sdk.example',
    eventTypes:['sdk.example.completed']
});
source.dispatch('sdk.example.completed',{}, {publicDetail:{status:'completed'}});
source.dispose();
```

## `projectArcaneDOMEvent()`

### Overview

Projects one authority-created occurrence to one `CustomEvent`. This is a
one-way compatibility boundary; DOM dispatch never republishes into
`arcaneEvents`.

### Signature and result

```text
projectArcaneDOMEvent(target, occurrence, options)
```

```javascript
projectArcaneDOMEvent(target,occurrence,{
    type=occurrence.type,
    bubbles=false,
    composed=false,
    cancelable=occurrence.cancelable
}={})
```

The authority retrieves the centrally held compatibility detail, creates a
frozen outer projection detail, and additively supplies `occurrenceId`, `source`,
`arcaneSource`, `instanceId`, and `operationId`. `arcaneSource` is always the
canonical emitter identity. A caller-owned compatibility `source` value is
preserved; when absent, `source` is added as an alias of `arcaneSource`. A
conflicting caller-owned reserved metadata value fails
with `ARCANE_EVENT_DOM_DETAIL_COLLISION`. If the occurrence is already canceled,
the function skips DOM dispatch and returns `false`. Otherwise it dispatches
exactly one event, propagates DOM cancellation to a cancelable occurrence, and
returns the combined acceptance result.

### Availability and normalization

**Browser DOM or a DOM-compatible host with `CustomEvent` and
`dispatchEvent`.** Only an occurrence created by this realm's authority is
accepted. Projection is synchronous and one-way and creates no listener state.

### Example

```javascript
import {projectArcaneDOMEvent} from 'arcane-os/event-manager';

projectArcaneDOMEvent(button,publication.occurrence,{bubbles:true});
```

## `isArcaneEventOccurrence()`

### Overview

Returns `true` only for a canonical occurrence or source compatibility view
created by the current realm's authority. It does not authenticate hostile
same-realm code; the brand and protocol are compatibility boundaries.

### Signature and result

```text
isArcaneEventOccurrence(value)
```

Returns a boolean; a structurally similar foreign value returns `false`.

### Availability and normalization

**Node and browser/bundler, within the current JavaScript realm.** Recognition
is synchronous and identity-based, with no parsing, cloning, or transport.

### Example

```javascript
import {isArcaneEventOccurrence} from 'arcane-os/event-manager';

console.log(isArcaneEventOccurrence(publication.occurrence));
```

## `ARCANE_EVENT_AUTHORITY_BRAND`

### Overview

Global registry symbol that brands the one compatible authority in a realm.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_BRAND
```

Its exact value is `Symbol.for('arcane-os.arcane-events-authority')`.

### Availability and normalization

**Node and browser/bundler.** The brand property is an immutable,
non-enumerable compatibility marker, not cross-realm transport or authenticity.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_BRAND,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents[ARCANE_EVENT_AUTHORITY_BRAND]);
```

## `ARCANE_EVENT_AUTHORITY_KIND`

### Overview

Stable kind discriminator for the frozen authority descriptor.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_KIND
```

Its exact value is `arcane-event-authority`.

### Availability and normalization

**Node and browser/bundler.** Reading it creates no authority or listener.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_KIND,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents.descriptor.kind===ARCANE_EVENT_AUTHORITY_KIND);
```

## `ARCANE_EVENT_AUTHORITY_PROTOCOL`

### Overview

Stable protocol discriminator for compatible per-realm authorities.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_PROTOCOL
```

Its exact value is `arcane-event-authority/1`.

### Availability and normalization

**Node and browser/bundler.** An incompatible installed protocol fails closed
and is never replaced or wrapped.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_PROTOCOL,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents.protocol===ARCANE_EVENT_AUTHORITY_PROTOCOL);
```

## `ARCANE_EVENT_ERROR_CODES`

### Overview

Frozen registry of every stable event-authority failure code.

### Value and import

```text
const ARCANE_EVENT_ERROR_CODES
```

Every key maps to its identical string value; thrown authority failures expose
the matching value as `error.code`.

### Availability and normalization

**Node and browser/bundler.** The registry has no mutable registration surface
or vague fallback code.

### Example

```javascript
import {ARCANE_EVENT_ERROR_CODES} from 'arcane-os/event-manager';
console.log(ARCANE_EVENT_ERROR_CODES.ARCANE_EVENT_SOURCE_DISPOSED);
```

## `ARCANE_EVENT_LISTENER_ERROR_EVENT`

### Overview

Canonical observational event emitted when an event listener throws.

### Value and import

```text
const ARCANE_EVENT_LISTENER_ERROR_EVENT
```

Its exact value is `arcane.event.listener.error`.

### Availability and normalization

**Node and browser/bundler.** Its frozen public detail carries the exact failure
code and source occurrence identifiers, never the raw error. Its shape is
exactly `{code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',reason:'listener-threw',
eventType,occurrenceId,source,instanceId,operationId}`. Publication is
synchronous and nonrecursive.

### Example

```javascript
import {ARCANE_EVENT_LISTENER_ERROR_EVENT,arcaneEvents} from 'arcane-os/event-manager';
const unsubscribe=arcaneEvents.subscribe(ARCANE_EVENT_LISTENER_ERROR_EVENT,console.log);
```

## `ARCANE_EVENT_OCCURRENCE_PROTOCOL`

### Overview

Stable protocol discriminator for immutable canonical occurrences.

### Value and import

```text
const ARCANE_EVENT_OCCURRENCE_PROTOCOL
```

Its exact value is `arcane-event-occurrence/1`.

### Availability and normalization

**Node and browser/bundler.** Occurrences are realm-owned identity values with
deeply frozen public detail and synchronous cancellation state.

### Example

```javascript
import {ARCANE_EVENT_OCCURRENCE_PROTOCOL} from 'arcane-os/event-manager';
console.log(publication.occurrence.protocol===ARCANE_EVENT_OCCURRENCE_PROTOCOL);
```

## `ARCANE_EVENT_SOURCE_DISPOSED_EVENT`

### Overview

Final noncancelable occurrence published during a source's first disposal.

### Value and import

```text
const ARCANE_EVENT_SOURCE_DISPOSED_EVENT
```

Its exact value is `arcane.event.source.disposed`.

### Availability and normalization

**Node and browser/bundler.** Public detail is exactly
`{reason:'source-disposed'}`. Delivery precedes source-listener cleanup;
reentrant or later disposal publishes nothing and returns `false`.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_DISPOSED_EVENT} from 'arcane-os/event-manager';
source.once(ARCANE_EVENT_SOURCE_DISPOSED_EVENT,console.log);
source.dispose();
```

## `ARCANE_EVENT_SOURCE_KIND`

### Overview

Stable kind discriminator for frozen source descriptors.

### Value and import

```text
const ARCANE_EVENT_SOURCE_KIND
```

Its exact value is `arcane-event-source`.

### Availability and normalization

**Node and browser/bundler.** Reading it does not register or dispose a source.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_KIND} from 'arcane-os/event-manager';
console.log(source.descriptor.kind===ARCANE_EVENT_SOURCE_KIND);
```

## `ARCANE_EVENT_SOURCE_PROTOCOL`

### Overview

Stable protocol discriminator for frozen source handles and descriptors.

### Value and import

```text
const ARCANE_EVENT_SOURCE_PROTOCOL
```

Its exact value is `arcane-event-source/1`.

### Availability and normalization

**Node and browser/bundler.** One handle belongs to one active owner in one
realm and declares every publishable type before use.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_PROTOCOL} from 'arcane-os/event-manager';
console.log(source.protocol===ARCANE_EVENT_SOURCE_PROTOCOL);
```

## `parseEventStack()`

### Overview

Strictly imports a JSON string or data object, rejects ambiguous or malformed
structures, returns null-prototype normalized data objects, and deeply freezes the
result. Validation includes exact document/record keys, canonical timestamps,
session and record identity, status-dependent completion fields, bounded nested
values, increasing sequences, causal parent consistency, and overflow placement.

### Signature

```javascript
parseEventStack(source, {
    maxEvents=10_000,
    maxSnapshotDepth=50,
    maxSnapshotEntries=1_000,
    maxSnapshotStringLength=10_000
}={})
```

All import limits must be positive safe integers, except that
`maxSnapshotStringLength` has the additional minimum of 64. A valid overflowed
stack may contain `maxEvents + 1` records only when its final record is the sole
overflow marker.

The parser binds every imported record to its enclosing document: protocol and
session must match, ids must equal `${sessionId}:${sequence}`, sequences and timing
must be valid, status must agree with completion/error fields, and parent,
depth, and causation data must form a valid earlier-record relationship. Unknown
keys, missing keys, sparse arrays, forged identities, incomplete records, and
nonterminal or forged overflow markers are rejected instead of repaired.

### Availability and normalization

Pure host-neutral JavaScript. It performs no I/O and does not revive tagged values
into executable JavaScript types.

### Example

```javascript
import {parseEventStack} from 'arcane-os/event-manager';

const document=parseEventStack(receivedText,{maxEvents:2_000});
for(const record of document.events)console.info(record.sequence,record.type);
```

## `createDOMInstrumentation()`

### Overview

Creates a frozen, opt-in browser controller that records capture-phase DOM
interactions and `MutationObserver` changes through an event manager. It observes
the supplied root and, by default, open shadow roots already present or later
inserted.

### Signature

```javascript
createDOMInstrumentation({
    eventManager,
    root=globalThis.document,
    eventTypes=DEFAULT_DOM_EVENT_TYPES,
    MutationObserver=globalThis.MutationObserver,
    captureEventDetails=false,
    captureInputValues=false,
    captureNodeMarkup=false,
    captureMutations=true,
    maxValueLength=10_000,
    maxSerializedNodeLength=100_000,
    observeOpenShadowRoots=true
}={})
```

The returned controller exposes `root`, `start()`, `stop({emitLifecycle=true}={})`,
`active`, and `observedRootCount`. Start and stop are idempotent. Startup rolls
back partially attached listeners on failure; shutdown retries listener/observer
cleanup and surfaces any remaining failure.

### Privacy

Input values, detailed text-entry fields, and inserted/removed node markup are all
off by default. Password controls, password autocomplete fields, and any element
under `data-arcane-private` remain redacted even when optional capture is enabled.
Sensitive attributes and URLs are redacted. Document URLs are represented only as
`[REDACTED URL]`; event strings and node content are bounded.

DOM capture is not complete application-state capture. It cannot observe closed
shadow roots, cross-origin frames, CSSOM/canvas rendering, most property-only
writes, native/kernel actions, external content, or activity before startup.

### Availability and normalization

Browser/DOM renderer only, or a compatible test shim. Records use the same
host-neutral event-stack format as semantic events.

### Example

```javascript
import {createEventManager} from 'arcane-os/event-manager';

const events=createEventManager({timeTravel:true,maxEvents:2_000});
const dom=events.attachDOM(document,{
    captureEventDetails:false,
    captureInputValues:false,
    captureNodeMarkup:false
});

// Exercise a bounded scenario.
dom.stop();
const text=events.exportStack();
events.clearHistory();
```

## `domSelector()`

### Overview

Builds a diagnostic selector from ids, `data-arcane-id`, `data-testid`, tag names,
and sibling positions. `:document` and `:shadow-root` identify roots; ` >>> ` marks
an open-shadow boundary and is not a standard `querySelector()` combinator.

### Signature

```javascript
domSelector(target, root)
```

### Availability and normalization

Browser DOM or DOM-like test values. Returns a string or `null`.

### Example

```javascript
import {domSelector} from 'arcane-os/event-manager';
console.info(domSelector(button,document));
```

## `describeDOMTarget()`

### Overview

Returns a frozen descriptor for a document, shadow root, text node, element,
global object, or generic event target. Element descriptors include selector, tag,
id, role, name, type, and private-state metadata.

### Signature

```javascript
describeDOMTarget(target, root)
```

### Availability and normalization

Browser DOM or DOM-like test values. Returns a frozen descriptor or `null`.

### Example

```javascript
import {describeDOMTarget} from 'arcane-os/event-manager';
console.info(describeDOMTarget(document.activeElement,document));
```

## `DEFAULT_DOM_EVENT_TYPES`

### Overview

A frozen array of 44 keyboard, composition, pointer, mouse, touch, form, focus,
clipboard, drag, selection, scroll, and wheel event names used by default DOM
instrumentation.

### Value

```javascript
const DEFAULT_DOM_EVENT_TYPES = Object.freeze([/* 44 event names */])
```

### Availability and normalization

Importable in Node and browsers; operational only with DOM event targets.

### Example

```javascript
import {DEFAULT_DOM_EVENT_TYPES} from 'arcane-os/event-manager';
const eventTypes=DEFAULT_DOM_EVENT_TYPES.filter(type=>type!=='pointermove');
```

## `ARCANE_EVENT_STACK_PROTOCOL`

### Overview

Identifies the immutable event-stack JSON contract.

### Value

```javascript
ARCANE_EVENT_STACK_PROTOCOL === 'arcane-event-stack/1'
```

### Availability and normalization

All JavaScript hosts; exact string, never negotiated or silently upgraded.

### Example

```javascript
if(document.protocol!==ARCANE_EVENT_STACK_PROTOCOL)throw new Error('Unsupported stack');
```

## `TIME_TRAVEL_SEEK_EVENT`

### Overview

Names the cursor event. Its payload is `{sessionId,sequence,record}`. The event is
delivered synchronously but is not added to the diagnostic history.

### Value

```javascript
TIME_TRAVEL_SEEK_EVENT === 'arcane.time-travel.seek'
```

### Availability and normalization

Node and browser event managers; normalized payload, no state restoration.

### Example

```javascript
events.on(TIME_TRAVEL_SEEK_EVENT,({sequence})=>timeline.select(sequence));
events.seek(0);
```

## `PLAYBACK_STARTED_EVENT`

### Overview

Names the lifecycle event emitted with
`{sessionId,count,fromSequence,toSequence,speed,mode}` before playback delivery.

### Value

```javascript
PLAYBACK_STARTED_EVENT === 'arcane.time-travel.playback.started'
```

### Availability and normalization

Node and browser event managers; synchronous lifecycle notification.

### Example

```javascript
events.on(PLAYBACK_STARTED_EVENT,({count})=>console.info(`Reviewing ${count}`));
```

## `PLAYBACK_RECORD_EVENT`

### Overview

Names the per-record event used by safe `mode:'review'` playback. Its only payload
is the immutable record.

### Value

```javascript
PLAYBACK_RECORD_EVENT === 'arcane.time-travel.playback.record'
```

### Availability and normalization

Node and browser event managers; the payload remains a normalized record.

### Example

```javascript
events.on(PLAYBACK_RECORD_EVENT,record=>timeline.append(record));
await events.playback({mode:'review'});
```

## `PLAYBACK_COMPLETED_EVENT`

### Overview

Names the successful terminal event. Payload:
`{sessionId,delivered,cursor,completed:true}`.

### Value

```javascript
PLAYBACK_COMPLETED_EVENT === 'arcane.time-travel.playback.completed'
```

### Availability and normalization

Node and browser event managers; immutable result payload.

### Example

```javascript
events.once(PLAYBACK_COMPLETED_EVENT,result=>console.info(result.delivered));
```

## `PLAYBACK_CANCELLED_EVENT`

### Overview

Names the cancelled terminal event. Payload:
`{sessionId,delivered,cursor,completed:false,error}`. Playback still rejects with
the original cancellation reason.

### Value

```javascript
PLAYBACK_CANCELLED_EVENT === 'arcane.time-travel.playback.cancelled'
```

### Availability and normalization

Node and browser event managers; immutable error snapshot in the event payload.

### Example

```javascript
events.once(PLAYBACK_CANCELLED_EVENT,({delivered})=>console.info(delivered));
controller.abort('review closed');
```

## `PLAYBACK_FAILED_EVENT`

### Overview

Names the failed terminal event. It uses the same failed result shape as
cancelled playback, and the original failure rejects `playback()`.

### Value

```javascript
PLAYBACK_FAILED_EVENT === 'arcane.time-travel.playback.failed'
```

### Availability and normalization

Node and browser event managers; immutable error snapshot in the event payload.

### Example

```javascript
events.once(PLAYBACK_FAILED_EVENT,({error})=>console.error(error.message));
```

## `TIME_TRAVEL_OVERFLOW_EVENT`

### Overview

Identifies the final retention marker added when another recordable string event
arrives after `maxEvents` ordinary records have been retained. The marker has
`source:'event-manager'`, `category:'overflow'`, no parent, completed status, and
payload `[{maxEvents,retainedEvents}]`.

The marker becomes record `maxEvents + 1`; recording is disabled, DOM observation
is stopped without adding another lifecycle record, and the triggering application
event is still delivered live but is not recorded. The marker is written to
history; it is not separately emitted to live subscribers at overflow time.
Exactly `maxEvents` ordinary records plus this one terminal marker are retained.
`enableTimeTravel()` rejects until `clearHistory()` removes the marker and resets
the overflow state.

### Value

```javascript
TIME_TRAVEL_OVERFLOW_EVENT === 'arcane.time-travel.overflow'
```

### Availability and normalization

Node and browser event managers; deterministic terminal record in
`arcane-event-stack/1`.

### Example

```javascript
if(events.overflowed){
    persistLocallyForReview(events.exportStack());
    events.clearHistory();
    events.enableTimeTravel();
}
```

## `DOM_INTERACTION_EVENT`

### Overview

Identifies captured DOM interactions. Payload includes the DOM event type,
normalized target and composed path, event flags, bounded/redacted optional
details, and an optional captured value.

### Value

```javascript
DOM_INTERACTION_EVENT === 'arcane.dom.interaction'
```

### Availability and normalization

Produced only by browser/DOM instrumentation; stored as a host-neutral record.

### Example

```javascript
const clicks=events.getEventStack({type:DOM_INTERACTION_EVENT});
```

## `DOM_MUTATION_EVENT`

### Overview

Identifies normalized attribute, character-data, and child-list mutations. A
mutation captured immediately after an interaction may carry that interaction's
record id as its causation id.

### Value

```javascript
DOM_MUTATION_EVENT === 'arcane.dom.mutation'
```

### Availability and normalization

Produced only by browser `MutationObserver`; stored as a host-neutral record.

### Example

```javascript
for(const record of events.getEventStack({type:DOM_MUTATION_EVENT})){
    console.info(record.payload[0].mutationType);
}
```

## `DOM_OBSERVATION_STARTED_EVENT`

### Overview

Identifies successful DOM capture startup. Payload describes the redacted root,
event types, and capture flags.

### Value

```javascript
DOM_OBSERVATION_STARTED_EVENT === 'arcane.dom.observation.started'
```

### Availability and normalization

Browser/DOM instrumentation lifecycle record.

### Example

```javascript
events.once(DOM_OBSERVATION_STARTED_EVENT,details=>console.info(details.eventTypes.length));
```

## `DOM_OBSERVATION_STOPPED_EVENT`

### Overview

Identifies normal DOM capture shutdown. Payload is `{root}`. Overflow cleanup uses
`emitLifecycle:false`, so the overflow marker remains the final retained record.

### Value

```javascript
DOM_OBSERVATION_STOPPED_EVENT === 'arcane.dom.observation.stopped'
```

### Availability and normalization

Browser/DOM instrumentation lifecycle record.

### Example

```javascript
events.once(DOM_OBSERVATION_STOPPED_EVENT,()=>console.info('DOM capture stopped'));
events.disableTimeTravel();
```

## Event-stack document and record shapes

`exportStack()` and `parseEventStack()` use this document shape:

```javascript
{
    protocol:'arcane-event-stack/1',
    sessionId:'diagnostic-session',
    createdAt:'2026-08-24T03:00:00.000Z',
    events:[/* immutable records */]
}
```

Every record has exactly these fields:

```javascript
{
    protocol,
    sessionId,
    id,                 // `${sessionId}:${sequence}`
    sequence,           // positive, strictly increasing safe integer
    timestamp,          // canonical UTC ISO timestamp
    monotonicMs,        // finite, non-negative number
    type,
    source,
    category,           // string or null
    correlationId,      // string or null
    causationId,        // string or null
    parentSequence,     // positive sequence or null
    depth,              // nested synchronous dispatch depth
    stack,              // bounded string or null
    payload,            // normalized array of delivered arguments
    metadata,           // normalized object
    status,             // 'dispatching', 'completed', or 'failed'
    completedAt,        // canonical timestamp or null
    durationMs,         // non-negative number or null
    error               // normalized error or null
}
```

Nested synchronous dispatch records its parent sequence and depth and derives a
causation id when one is not supplied. A record initially appears as `dispatching`
and is replaced with a completed or failed immutable record when synchronous
delivery finishes.

Snapshot normalization never evaluates accessor properties, including own
properties that attempt to shadow the built-in behavior of dates, regular
expressions, errors, maps, sets, typed arrays, data views, or functions. It
preserves cycles as `$ref`, applies tagged forms for non-finite numbers, bigint,
symbols, functions, dates, regular expressions, errors, maps, sets, typed arrays,
array buffers, truncation, unreadable values, and capture failures, and returns
null-prototype objects. BigInt decimal text is bounded by
`maxSnapshotStringLength`, just like other generated strings.

The minimum 64-character budget is sufficient for the SDK's generated tags and
bookkeeping. When bounded property names collide, later names use an
`$arcaneCollision:<index>` key; omitted object entries use `$arcaneTruncated`, and
bounded collections use their corresponding truncation metadata. These special,
collision, and truncation forms round-trip through `exportStack()` and
`parseEventStack()` under the same limits. Tagged values are evidence, not
executable values, and are not revived by playback.

Safe capture is subordinate to live delivery. Snapshot accessors are represented
as unreadable rather than invoked, and a proxy trap, invalid special value, or
other snapshot failure becomes a bounded `snapshot-failed` value when possible.
If diagnostic capture itself cannot construct a record, the live synchronous
event is still delivered. A subscriber failure remains authoritative and is
re-thrown after the SDK makes a best effort to finalize its failed record.

With the defaults `redactSensitive:true` and `captureStacks:false`, source and
error stacks are suppressed; credential-like keys and the private event fields
`key`, `data`, and `detail` become `[REDACTED]`; and URL-like strings using
`blob:`, `data:`, `file:`, `ftp:`, `ftps:`, `http:`, `https:`, `ws:`, or `wss:`
become `[REDACTED URL]`. Redaction happens before history or export. Disabling it
is an explicit diagnostic-risk decision, not a transport requirement.

<details>
<summary>Protocol and schema details</summary>

The durable protocol is exactly `arcane-event-stack/1`. It is independent of the
Core `arcane/1` host protocol and the CLI event-stream protocol. Import the schema
from `arcane-os/schemas/event-stack.json`; it uses JSON Schema draft 2020-12.

```javascript
import schema from 'arcane-os/schemas/event-stack.json' with {type:'json'};
```

Protocol versions are not negotiated or normalized automatically. A remote tool
must explicitly transport the JSON, preserve it as untrusted input, and call
`parseEventStack()` under suitable bounds before use. Playback does not resend
native RPC, repeat provisioning, synthesize trusted browser input, or restore a
kernel/application snapshot.

</details>

## Errors and recovery

| Operation | Error | Recovery |
| --- | --- | --- |
| `globalThis.arcaneEvents` is an accessor | `ARCANE_EVENT_AUTHORITY_ACCESSOR_COLLISION` | Remove the incompatible realm bootstrap before importing the SDK |
| Authority value is unbranded | `ARCANE_EVENT_AUTHORITY_VALUE_COLLISION` | Install no competing global value |
| Global, brand, or protocol descriptor flags differ | `ARCANE_EVENT_AUTHORITY_DESCRIPTOR_MISMATCH` | Use the exact non-enumerable/non-writable/non-configurable authority and brand contract |
| Authority brand/protocol differs | `ARCANE_EVENT_AUTHORITY_PROTOCOL_MISMATCH` | Load a compatible SDK authority protocol |
| Required authority method is absent, non-callable, or an accessor | `ARCANE_EVENT_AUTHORITY_API_MISMATCH` | Remove the incompatible authority; accessors are never evaluated for admission |
| Authority cannot be installed | `ARCANE_EVENT_AUTHORITY_INSTALL_FAILED` | Make the realm global extensible before first import |
| Source owner/options/name/event types/callback invalid | `ARCANE_EVENT_SOURCE_INVALID` | Use one owner, exact data options, valid names, and 1–256 unique declared types |
| Owner already has an active source | `ARCANE_EVENT_SOURCE_ALREADY_REGISTERED` | Reuse or dispose the current handle |
| Source is disposing or disposed | `ARCANE_EVENT_SOURCE_DISPOSED` | Stop publishing or create a new source after disposal completes |
| Source publishes/listens to an undeclared type | `ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED` | Add the exact type to `eventTypes` before source creation |
| Occurrence/options invalid | `ARCANE_EVENT_OCCURRENCE_INVALID` | Use the authority-created occurrence and documented dispatch options |
| Realm occurrence sequence exhausted | `ARCANE_EVENT_OCCURRENCE_SEQUENCE_EXHAUSTED` | Start a new JavaScript realm |
| Realm source sequence exhausted | `ARCANE_EVENT_SOURCE_SEQUENCE_EXHAUSTED` | Start a new JavaScript realm |
| Compatibility detail cannot be safely admitted | `ARCANE_EVENT_COMPATIBILITY_DETAIL_INVALID` | Use a host object directly or a plain/array value with data properties only |
| Canonical listener throws | `ARCANE_EVENT_LISTENER_CALLBACK_FAILED` in a listener-error occurrence | Fix the observer; committed domain dispatch remains successful |
| Subscription type invalid | `ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID` | Use a nonempty trimmed name matching the authority event-name grammar; canonical wildcard subscription is not admitted |
| Subscription handler invalid | `ARCANE_EVENT_SUBSCRIPTION_HANDLER_INVALID` | Use a function or EventListener object |
| Subscription options invalid | `ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID` | Use a data-only `{once?,signal?}` record with a boolean `once` value |
| Subscription signal invalid | `ARCANE_EVENT_SUBSCRIPTION_SIGNAL_INVALID` | Pass an AbortSignal-compatible value or omit `signal` |
| EventTarget adapter input lacks a valid type or data detail | `ARCANE_EVENT_DISPATCH_EVENT_INVALID` | Pass an Event or an Event-like data object; do not use accessors |
| DOM target invalid | `ARCANE_EVENT_DOM_TARGET_INVALID` | Supply a target with `dispatchEvent` in a realm with `CustomEvent` support |
| DOM options invalid | `ARCANE_EVENT_DOM_OPTIONS_INVALID` | Use only `type`, `bubbles`, `composed`, and `cancelable`, with boolean flags |
| DOM detail conflicts with authority identifiers | `ARCANE_EVENT_DOM_DETAIL_COLLISION` | Remove conflicting `occurrenceId`, `arcaneSource`, `instanceId`, or `operationId` fields; compatibility `source` is preserved |
| Constructor flags, clocks, or session id invalid | `TypeError` | Correct types; keep session id non-empty and at most 256 characters |
| Constructor/import retention or snapshot limits invalid | `RangeError` | Use positive safe integers and keep `maxSnapshotStringLength` at least 64 |
| Clock returns invalid timestamp or monotonic value | `TypeError` | Supply a valid UTC-compatible clock and finite non-negative monotonic clock |
| Metadata is not an object; forwarded event is invalid | `TypeError` | Pass an object and a string event type |
| Subscriber throws | Original error is rethrown | Treat synchronous handlers as part of the publisher's failure boundary |
| History overflows | No exception in normal overflow; recording disables | Export, `clearHistory()`, then enable a new bounded session |
| Re-enable before clearing overflow | `Error` | Clear history first |
| Clear during dispatch/playback | `Error` | Wait for the active operation to finish |
| Stack JSON/shape/order/identity/timing/causality/overflow invalid | `TypeError` | Reject unknown, incomplete, or forged input; do not partially use it |
| Import exceeds configured bounds | `RangeError` or invalid-stack `TypeError` | Raise explicit bounds only for a trusted operational need |
| Stack range or playback mode/callback invalid | `TypeError` | Correct the options |
| Export indentation, seek position, or playback speed invalid | `RangeError` | Use documented ranges |
| Playback already active | `Error` | Await or cancel the current playback |
| Playback aborts or a callback/subscriber fails | Promise rejects after terminal lifecycle event | Handle rejection and inspect the immutable terminal error snapshot |
| DOM manager/root/options invalid or MutationObserver unavailable | `TypeError`/`RangeError` | Correct capability/options or set `captureMutations:false` |

## Behavioral tests

The executable contract is covered by:

- `test/event-manager.test.mjs`: synchronous bus compatibility, causal recording,
  pollution-safe and accessor-safe snapshots, safe capture failures, redaction and
  stack-suppression defaults, minimum-budget BigInt/collision/truncation round
  trips, strict forged-import rejection, cursor behavior, review and event
  playback, cancellation, bounded overflow, attach-at-limit cleanup, recovery,
  central queue mirroring, singleton descriptor/collision admission, duplicate
  module reuse, source order/privacy/lifecycle, dispatch-safe unsubscribe,
  EventTarget adapters, one-way DOM projection, and observational listener
  failures;
- `test/dom-event-instrumentation.test.mjs`: browser interaction/mutation capture,
  open-shadow observation, privacy defaults, lifecycle, and cleanup;
- `test/contracts.test.mjs`: published schema and package-export stability;
- `test/reference-completeness.test.mjs`: public export and MDN-reference coverage.

The overflow tests assert the boundary itself: exactly `maxEvents` ordinary
records, one final terminal marker, uninterrupted live delivery, inactive DOM
capture without a trailing stopped marker, blocked re-enable until clear, and a
strictly importable bounded export.

Run the behavioral suite through the repository's normal gate:

```shell
npm run check
```
