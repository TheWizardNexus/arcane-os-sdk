# EventManager and time-travel diagnostics

`arcaneEvents` gives Arcane SDK publishers one canonical synchronous event
authority per JavaScript realm. `EventManager` remains the constructor for an
isolated strict pub/sub bus and optional complete diagnostic timeline. Use source
handles for SDK semantic events; use isolated managers for local diagnostics,
DOM capture, export, and review.

The API is capability-first:

- ordinary pub/sub works in Node and browser JavaScript;
- duplicate module URLs reuse a `globalThis.arcaneEvents` value with the current
  protocol and required callable API;
- canonical occurrences expose complete mutable normalized detail;
- source listeners receive a shallow copy of caller detail while occurrences and
  diagnostic history receive a normalized copy;
- recording creates mutable, normalized `arcane-event-stack/1` records;
- browser DOM capture is opt-in and preserves readable observed content;
- review playback is safe by default; live event redispatch is explicitly effectful;
- no event stack is uploaded, persisted, bridged to Core, or sent to a cloud service
  automatically.

All 31 JavaScript exports are available from both `arcane-os` and
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
    {documentId:'example',document:liveDocument},
    {operationId:'save-42',publicDetail:{documentId:'example'}}
);
projectArcaneDOMEvent(editorElement,publication.occurrence);
unsubscribe();

const diagnostics=createEventManager({timeTravel:true});
const stack=diagnostics.exportStack();
diagnostics.on(PLAYBACK_RECORD_EVENT,record=>console.info(record.type));
await diagnostics.playback({stack,mode:'review',speed:0});
```

Recording is disabled by default. Export intentionally, then call
`clearHistory()` when the retained history is no longer needed.

## Availability and normalization

| Capability | Node | Browser renderer | Native/Core host | Remote or cloud | Normalization |
| --- | --- | --- | --- | --- | --- |
| Canonical per-realm authority and source occurrences | Yes | Yes, per window or worker realm | Only when the SDK module runs in that JavaScript realm | No automatic transport | `arcane-event-authority/1`, `arcane-event-source/1`, and `arcane-event-occurrence/1` |
| Pub/sub, semantic instrumentation, parse/export, seek, playback | Yes | Yes, through a bundler or the managed Arcane import map | Only when the SDK module runs in that JavaScript host | No automatic transport | Same synchronous API; optional complete JSON-like snapshots |
| DOM selectors and target descriptions | With DOM-like values or a test shim | Yes | No native UI observation | No | Stable diagnostic descriptors |
| DOM interaction and mutation capture | No native DOM | Yes | No | No | DOM activity becomes semantic event-stack records |
| Event-stack schema | Yes | Yes | Data contract only | Can be transported explicitly by the developer | `arcane-event-stack/1` |

In an external or integrated workspace, the managed browser map
resolves `arcane-os/event-manager` to
`./arcane/sdk/event-manager.mjs` and its private bare dependency
`event-pubsub` to
`./arcane/sdk/dependencies/event-pubsub/index.js`. The selected Arcane browser
runtime does not inject this SDK-authored module into
Shell, Provisioner, Core, or built-in apps. There is no transparent fallback to
the Node package root, `arcane/1`, HTTP, WebSocket, Ollama, or a cloud event
service.

## Export summary

| Export | Kind | Primary capability |
| --- | --- | --- |
| `ARCANE_EVENT_STACK_PROTOCOL` | String constant | Identify the durable stack format |
| `ARCANE_EVENT_AUTHORITY_PROTOCOL` | String constant | Identify the singleton authority protocol |
| `ARCANE_EVENT_OCCURRENCE_PROTOCOL` | String constant | Identify canonical occurrences |
| `ARCANE_EVENT_SOURCE_PROTOCOL` | String constant | Identify source handles |
| `ARCANE_EVENT_AUTHORITY_BRAND` | Global symbol | Inspect the authority brand descriptor |
| `ARCANE_EVENT_AUTHORITY_KIND` | String constant | Identify an authority descriptor |
| `ARCANE_EVENT_SOURCE_KIND` | String constant | Identify a source descriptor |
| `ARCANE_EVENT_LISTENER_ERROR_EVENT` | String constant | Observe listener failures |
| `ARCANE_EVENT_SOURCE_DISPOSED_EVENT` | String constant | Observe a source's final occurrence |
| `ARCANE_EVENT_ERROR_CODES` | Object | Match authority error codes |
| `TIME_TRAVEL_SEEK_EVENT` | String constant | Observe review-cursor movement |
| `PLAYBACK_STARTED_EVENT` | String constant | Observe playback startup |
| `PLAYBACK_RECORD_EVENT` | String constant | Receive safe review records |
| `PLAYBACK_COMPLETED_EVENT` | String constant | Observe successful completion |
| `PLAYBACK_CANCELLED_EVENT` | String constant | Observe cancellation |
| `PLAYBACK_FAILED_EVENT` | String constant | Observe playback failure |
| `DOM_INTERACTION_EVENT` | String constant | Identify normalized DOM interactions |
| `DOM_MUTATION_EVENT` | String constant | Identify normalized DOM mutations |
| `DOM_OBSERVATION_STARTED_EVENT` | String constant | Identify DOM-capture startup |
| `DOM_OBSERVATION_STOPPED_EVENT` | String constant | Identify DOM-capture shutdown |
| `DEFAULT_DOM_EVENT_TYPES` | String array | Use Arcane's default DOM capture set |
| `domSelector()` | Function | Build a diagnostic DOM locator |
| `describeDOMTarget()` | Function | Normalize a DOM event target |
| `createDOMInstrumentation()` | Function | Attach interaction and mutation capture |
| `parseEventStack()` | Function | Strictly import and normalize a stack |
| `EventManager` | Class | Create an isolated bus and timeline |
| `createEventManager()` | Function | Create an `EventManager` |
| `arcaneEvents` | Branded `EventManager` authority | Observe canonical SDK events in this realm |
| `createArcaneEventSource()` | Function | Register one declared semantic source per owner |
| `projectArcaneDOMEvent()` | Function | Project one occurrence to one `CustomEvent` |
| `isArcaneEventOccurrence()` | Function | Recognize authority-created occurrences and views |

## `EventManager`

### Overview

Creates an isolated synchronous `event-pubsub` bus. Time-travel recording,
snapshot capture, DOM observation, import/export, cursor movement, and
playback are layered around that bus.

### Constructor

```javascript
new EventManager({
    timeTravel=false,
    dom=null,
    clock=()=>new Date(),
    now=performance.now-or-Date.now,
    sessionId=randomUUID-or-local-id
}={})
```

`dom` may be a root directly or an options object containing `root`. Every
recorded string event attempts to capture its source stack. Snapshot
normalization retains complete readable values and represents cycles, special
values, and capture failures without applying content or retention limits.

### Properties

| Property | Value |
| --- | --- |
| `list` | Underlying subscriber registry from `event-pubsub` |
| `sessionId` | Current non-empty session identifier |
| `timeTravelEnabled` | Whether new string-typed events are being recorded |
| `replaying` | Whether playback is active |
| `cursor` | Current sequence selected or delivered; `0` means before the first event |
| `eventCount` | Current retained record count |
| `history` | New array containing the current mutable record objects |
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

Enables recording and optionally attaches DOM capture.

#### `disableTimeTravel()`

Stops attached DOM capture, records its stopped lifecycle boundary, disables
recording, and returns the manager.

#### `attachDOM(root=globalThis.document, options={})`

Stops and replaces the current DOM controller. The new controller starts
immediately when recording is enabled. Returns the controller.

#### `detachDOM()`

Stops DOM capture, clears the controller, and returns the manager.

#### `clearHistory({newSession=true}={})`

Clears history, sequence, cursor, and active-dispatch state. By default it creates a new
session identifier; pass `newSession:false` to retain the existing identifier.
History cannot be cleared during synchronous dispatch or playback.

#### `getEventStack({fromSequence=1, toSequence=Number.MAX_SAFE_INTEGER, type=null}={})`

Returns a new mutable array of current record objects within the inclusive sequence range, optionally
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
| `review` | Emits every normalized record as `PLAYBACK_RECORD_EVENT` | Default; intended for debugger and timeline UIs |
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

const events=new EventManager({timeTravel:true});
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
const events=createEventManager({timeTravel:true});
```

## `arcaneEvents`

### Overview

The SDK's canonical per-realm event authority. Module evaluation reads
`globalThis.arcaneEvents` and reuses it when it exposes the current protocol and
required API. Otherwise it constructs and installs a new authority as a
non-enumerable, writable, configurable data property. Installation failure uses
the stable `ARCANE_EVENT_AUTHORITY_INSTALL_FAILED` code.

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
Both return the same mutable singleton-backed source handle; neither constructs
an EventManager, EventTarget, or component-local bus.

`addEventListener()` and `removeEventListener()` expose EventTarget-shaped
canonical registration, including function/EventListener-object callbacks,
type/listener/capture deduplication, `once`, and `signal`. They return
`undefined`.

The inherited `on`, `once`, `off`, `reset`, `emit`, `instrument`, and `forward`
surface supports direct diagnostics. Its registrations are separate: source
dispatch does not re-emit raw source-local detail to direct listeners, and
direct `off()`/`reset()` cannot remove canonical or source-owned
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
`onListenerError`. Source and event names must already be trimmed lowercase
identifiers matching `^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$`. `eventTypes` must be
a nonempty array of unique declared types. A second active source for the same
owner fails closed.

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

The returned handle and its descriptor are mutable. The descriptor identifies
`arcane-event-source/1`, the stable source name, an authority-sequenced opaque
`arcane-source-<base36>` instance id, and the declared event types plus the final
`arcane.event.source.disposed` event. IDs are unique only during one authority's
lifetime in one realm.

The authority descriptor is exactly
`{kind:'arcane-event-authority',protocol:'arcane-event-authority/1',realm:'current'}`.
The source descriptor is exactly
`{kind:'arcane-event-source',protocol:'arcane-event-source/1',source,instanceId,
eventTypes}`; `eventTypes` is mutable and includes the declared types followed by
`arcane.event.source.disposed`.

### Dispatch

```javascript
const {occurrence,accepted}=source.dispatch(
    'document.saved',
    {document:liveDocument,documentId:'document-7'},
    {
        operationId:'save-42',
        publicDetail:{documentId:'document-7'},
        cancelable:true
    }
);
```

`dispatch()` is synchronous. Exact canonical subscribers run first in
registration order, followed by this source's exact `on()`/EventListener
registrations in registration order. Source listeners receive one mutable
EventTarget-shaped view whose `detail` is the locally held source detail, whose
`target` and `currentTarget` are the source owner, and whose
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
    detail,            // complete normalized snapshot of source/public detail
    cancelable,
    get defaultPrevented(),
    preventDefault()
}
```

The mutable result is `{occurrence,accepted:!occurrence.defaultPrevented}`.
Cancellation does not roll back domain work automatically. All active listeners
run even when one prevents default or throws. Listener exceptions create one
nonrecursive `arcane.event.listener.error` occurrence and are
reported through `reportError` or `console.error`; committed source dispatch does
not throw because an observer failed. `onListenerError(error,errorOccurrence)`
is invoked synchronously only at the source-owner boundary after canonical error
publication and platform reporting. Its second argument is the canonical
listener-error occurrence, or `null` only if that secondary publication could
not be constructed. If the callback throws, its failure is reported directly
without another listener-error occurrence. The listener-error public detail is
the complete normalized snapshot of
`{code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',reason:'listener-threw',
eventType,occurrenceId,source,instanceId,operationId,error}`; the owner callback
also receives the original error object as its first argument.

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
`dispatchEvent(event)` is an EventTarget adapter that accepts only a declared
type, preserves cancellation, and publishes
a new canonical occurrence rather than the raw input.

`dispose()` is idempotent: the first call publishes the final noncancelable
`arcane.event.source.disposed` occurrence, removes source-owned registrations,
and returns `true`; reentrant or later calls return `false`. Dispatch or new
registration after disposal fails with `ARCANE_EVENT_SOURCE_DISPOSED`. The owner
may register a new source after disposal. Its source-local detail is
`{source,instanceId,reason:'source-disposed'}` and its public detail is
`{reason:'source-disposed'}`. `destroy()` aliases `dispose()`.

Array source detail is shallow-copied. Plain records, including
null-prototype records, are shallow-copied with their enumerable state preserved;
property reads that throw are represented as snapshot failures. Other host
objects such as DOM nodes, `File`, or `Error` remain local by identity in the
source event view. Canonical detail is a complete normalized snapshot: when
`publicDetail` is omitted it uses source detail, when both values are
records it merges them with `publicDetail` winning duplicate keys, and otherwise
it stores both under `{compatibility,publicDetail}`. Canonical detail is also what
enters optional EventManager history.

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
one-way DOM adapter; DOM dispatch never republishes into
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

The authority retrieves the centrally held source detail, creates a
mutable outer projection detail, and additively supplies `occurrenceId`, `source`,
`arcaneSource`, `instanceId`, and `operationId`. `arcaneSource` is always the
canonical emitter identity. A caller-owned source-detail `source` value is
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

Returns `true` only for a canonical occurrence or source event view
created by the current realm's authority. It does not authenticate hostile
same-realm code; the brand and protocol are realm-local protocol markers.

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

Global registry symbol used as a protocol marker on a created authority.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_BRAND
```

Its exact value is `Symbol.for('arcane-os.arcane-events-authority')`.

### Availability and normalization

**Node and browser/bundler.** A created authority receives this ordinary
enumerable, writable, configurable symbol property. It is a realm-local protocol
marker, not transport or authenticity.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_BRAND,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents[ARCANE_EVENT_AUTHORITY_BRAND]);
```

## `ARCANE_EVENT_AUTHORITY_KIND`

### Overview

Stable kind discriminator for the authority descriptor.

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

**Node and browser/bundler.** A global value with this protocol and all required
authority methods is reused. Other values are replaced when the global property
can be defined; otherwise installation fails with
`ARCANE_EVENT_AUTHORITY_INSTALL_FAILED`.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_PROTOCOL,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents.protocol===ARCANE_EVENT_AUTHORITY_PROTOCOL);
```

## `ARCANE_EVENT_ERROR_CODES`

### Overview

Mutable registry of event-authority failure-code names.

### Value and import

```text
const ARCANE_EVENT_ERROR_CODES
```

Every key maps to its identical string value; thrown authority failures expose
the matching value as `error.code`.

### Availability and normalization

**Node and browser/bundler.** The object is an exported code lookup, not a
registration surface. Every current key maps to its identical string value.

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

**Node and browser/bundler.** Its mutable public detail carries the exact failure
code, source occurrence identifiers, and a complete normalized error snapshot.
Its shape is
`{code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',reason:'listener-threw',
eventType,occurrenceId,source,instanceId,operationId,error}`. Publication is
synchronous and nonrecursive.

### Example

```javascript
import {ARCANE_EVENT_LISTENER_ERROR_EVENT,arcaneEvents} from 'arcane-os/event-manager';
const unsubscribe=arcaneEvents.subscribe(ARCANE_EVENT_LISTENER_ERROR_EVENT,console.log);
```

## `ARCANE_EVENT_OCCURRENCE_PROTOCOL`

### Overview

Stable protocol discriminator for canonical occurrences.

### Value and import

```text
const ARCANE_EVENT_OCCURRENCE_PROTOCOL
```

Its exact value is `arcane-event-occurrence/1`.

### Availability and normalization

**Node and browser/bundler.** Occurrences are mutable realm-owned identity values
with complete normalized public detail and synchronous cancellation state.

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

**Node and browser/bundler.** Canonical detail is the normalized merged value
`{source,instanceId,reason:'source-disposed'}`. Delivery precedes source-listener cleanup;
reentrant or later disposal publishes nothing and returns `false`.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_DISPOSED_EVENT} from 'arcane-os/event-manager';
source.once(ARCANE_EVENT_SOURCE_DISPOSED_EVENT,console.log);
source.dispose();
```

## `ARCANE_EVENT_SOURCE_KIND`

### Overview

Stable kind discriminator for source descriptors.

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

Stable protocol discriminator for source handles and descriptors.

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
structures, and returns mutable null-prototype normalized data objects. Validation
includes exact document/record keys, canonical timestamps, session and record
identity, status-dependent completion fields, complete nested values, increasing
sequences, and causal parent consistency.

### Signature

```javascript
parseEventStack(source)
```

The parser binds every imported record to its enclosing document: protocol and
session must match, ids must equal `${sessionId}:${sequence}`, sequences and timing
must be valid, status must agree with completion/error fields, and parent,
depth, and causation data must form a valid earlier-record relationship. Unknown
keys, missing keys, sparse arrays, forged identities, and incomplete records are
rejected instead of repaired.

### Availability and normalization

Pure host-neutral JavaScript. It performs no I/O and does not revive tagged values
into executable JavaScript types.

### Example

```javascript
import {parseEventStack} from 'arcane-os/event-manager';

const document=parseEventStack(receivedText);
for(const record of document.events)console.info(record.sequence,record.type);
```

## `createDOMInstrumentation()`

### Overview

Creates a mutable, opt-in browser controller that records capture-phase DOM
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
    captureMutations=true,
    observeOpenShadowRoots=true
}={})
```

The returned controller exposes `root`, `start()`, `stop({emitLifecycle=true}={})`,
`active`, `cleanupPending`, and `observedRootCount`. Start and stop are idempotent.
Startup rolls back partially attached listeners on failure; shutdown retries
listener/observer cleanup and exposes a pending cleanup state when a resource
still cannot be removed.

### Captured content

Interaction records include readable event fields, target values (including file
lists), target and composed-path descriptors, and event flags. Mutation records
include complete attribute values, character data, and added or removed node
content. Document root descriptions include the current URL and title. The
instrumentation preserves those values completely.

DOM capture is not complete application-state capture. It cannot observe closed
shadow roots, cross-origin frames, CSSOM/canvas rendering, most property-only
writes, native/kernel actions, external content, or activity before startup.

### Availability and normalization

Browser/DOM renderer only, or a compatible test shim. Records use the same
host-neutral event-stack format as semantic events.

### Example

```javascript
import {createEventManager} from 'arcane-os/event-manager';

const events=createEventManager({timeTravel:true});
const dom=events.attachDOM(document);

// Exercise the scenario.
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

Returns a mutable descriptor for a document, shadow root, text node, element,
global object, or generic event target. Element descriptors include selector, tag,
id, role, name, type, and complete markup or text content. Text-node descriptors
include their complete text content.

### Signature

```javascript
describeDOMTarget(target, root)
```

### Availability and normalization

Browser DOM or DOM-like test values. Returns a mutable descriptor or `null`.

### Example

```javascript
import {describeDOMTarget} from 'arcane-os/event-manager';
console.info(describeDOMTarget(document.activeElement,document));
```

## `DEFAULT_DOM_EVENT_TYPES`

### Overview

A mutable array of 44 keyboard, composition, pointer, mouse, touch, form, focus,
clipboard, drag, selection, scroll, and wheel event names used by default DOM
instrumentation.

### Value

```javascript
const DEFAULT_DOM_EVENT_TYPES = [/* 44 event names */]
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

Identifies the versioned event-stack JSON contract.

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

Names the per-record event used by `mode:'review'` playback. Its only payload is
the mutable normalized record.

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

Node and browser event managers; mutable result payload.

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

Node and browser event managers; mutable normalized error snapshot in the event payload.

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

Node and browser event managers; mutable normalized error snapshot in the event payload.

### Example

```javascript
events.once(PLAYBACK_FAILED_EVENT,({error})=>console.error(error.message));
```

## `DOM_INTERACTION_EVENT`

### Overview

Identifies captured DOM interactions. Payload includes the DOM event type,
normalized target and composed path, event flags, readable event details, and a
captured target value when one is available.

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

Identifies successful DOM capture startup. Payload is
`{root,eventTypes,captureMutations,observeOpenShadowRoots}`.

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

Identifies normal DOM capture shutdown. Payload is `{root}`.

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
    events:[/* mutable normalized records */]
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
    stack,              // complete captured string or null
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
and is replaced with a completed or failed mutable record when synchronous
delivery finishes.

Snapshot normalization preserves complete content. It reads enumerable own
properties, represents a property read that throws as `snapshot-failed`,
preserves cycles as `$ref`, and applies tagged forms for non-finite numbers,
bigint, symbols, functions, dates, regular expressions, errors, maps, sets, typed
arrays, and array buffers. The resulting record objects are mutable. Tagged
values are diagnostic data, not executable values, and playback does not revive
them.

Capture remains subordinate to live delivery. A proxy trap, invalid special
value, or other snapshot failure becomes a `snapshot-failed` value when possible.
If diagnostic capture itself cannot construct a record, the live synchronous
event is still delivered. A subscriber failure remains authoritative and is
re-thrown after the SDK makes a best effort to finalize its failed record.

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
`parseEventStack()` before use. Playback does not resend
native RPC, repeat provisioning, synthesize trusted browser input, or restore a
kernel/application snapshot.

</details>

## Errors and recovery

| Operation | Error | Recovery |
| --- | --- | --- |
| Authority cannot be installed | `ARCANE_EVENT_AUTHORITY_INSTALL_FAILED` | Make the realm global extensible before first import |
| Source owner/options/name/event types/callback invalid | `ARCANE_EVENT_SOURCE_INVALID` | Use one owner, exact data options, valid names, and a nonempty unique list of declared types |
| Owner already has an active source | `ARCANE_EVENT_SOURCE_ALREADY_REGISTERED` | Reuse or dispose the current handle |
| Source is disposing or disposed | `ARCANE_EVENT_SOURCE_DISPOSED` | Stop publishing or create a new source after disposal completes |
| Source publishes/listens to an undeclared type | `ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED` | Add the exact type to `eventTypes` before source creation |
| Occurrence/options invalid | `ARCANE_EVENT_OCCURRENCE_INVALID` | Use the authority-created occurrence and documented dispatch options |
| Realm occurrence sequence exhausted | `ARCANE_EVENT_OCCURRENCE_SEQUENCE_EXHAUSTED` | Start a new JavaScript realm |
| Realm source sequence exhausted | `ARCANE_EVENT_SOURCE_SEQUENCE_EXHAUSTED` | Start a new JavaScript realm |
| Canonical listener throws | `ARCANE_EVENT_LISTENER_CALLBACK_FAILED` in a listener-error occurrence | Fix the observer; committed domain dispatch remains successful |
| Subscription type invalid | `ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID` | Use a nonempty trimmed name matching the authority event-name grammar; canonical wildcard subscription is not admitted |
| Subscription handler invalid | `ARCANE_EVENT_SUBSCRIPTION_HANDLER_INVALID` | Use a function or EventListener object |
| Subscription options invalid | `ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID` | Use a data-only `{once?,signal?}` record with a boolean `once` value |
| Subscription signal invalid | `ARCANE_EVENT_SUBSCRIPTION_SIGNAL_INVALID` | Pass an AbortSignal-compatible value or omit `signal` |
| EventTarget adapter input lacks a valid type or data detail | `ARCANE_EVENT_DISPATCH_EVENT_INVALID` | Pass an Event or an Event-like data object; do not use accessors |
| DOM target invalid | `ARCANE_EVENT_DOM_TARGET_INVALID` | Supply a target with `dispatchEvent` in a realm with `CustomEvent` support |
| DOM options invalid | `ARCANE_EVENT_DOM_OPTIONS_INVALID` | Use only `type`, `bubbles`, `composed`, and `cancelable`, with boolean flags |
| DOM detail conflicts with authority identifiers | `ARCANE_EVENT_DOM_DETAIL_COLLISION` | Remove conflicting `occurrenceId`, `arcaneSource`, `instanceId`, or `operationId` fields; a source-detail `source` is preserved |
| Constructor flags, clocks, or session id invalid | `TypeError` | Correct types and keep session id non-empty |
| Clock returns invalid timestamp or monotonic value | `TypeError` | Supply a valid UTC-compatible clock and finite non-negative monotonic clock |
| Metadata is not an object; forwarded event is invalid | `TypeError` | Pass an object and a string event type |
| Subscriber throws | Original error is rethrown | Treat synchronous handlers as part of the publisher's failure boundary |
| Clear during dispatch/playback | `Error` | Wait for the active operation to finish |
| Stack JSON/shape/order/identity/timing/causality invalid | `TypeError` | Reject unknown, incomplete, or forged input; do not partially use it |
| Stack range or playback mode/callback invalid | `TypeError` | Correct the options |
| Export indentation, seek position, or playback speed invalid | `RangeError` | Use documented ranges |
| Playback already active | `Error` | Await or cancel the current playback |
| Playback aborts or a callback/subscriber fails | Promise rejects after terminal lifecycle event | Handle rejection and inspect the mutable normalized terminal error snapshot |
| DOM manager/root/options invalid or MutationObserver unavailable | `TypeError` | Correct capability/options or set `captureMutations:false` |

## Behavioral tests

The executable contract is covered by:

- `test/event-manager.test.mjs`: synchronous bus behavior, causal recording,
  complete snapshots, safe capture failures, special-value normalization,
  strict forged-import rejection, cursor behavior, review and event playback,
  cancellation, central queue mirroring, mutable authority reuse, complete rich
  source detail, source order/lifecycle, dispatch-safe unsubscribe,
  EventTarget adapters, one-way DOM projection, and observational listener
  failures;
- `test/dom-event-instrumentation.test.mjs`: browser interaction/mutation capture,
  open-shadow observation, complete content, lifecycle, and cleanup;
- `test/contracts.test.mjs`: published schema and package-export stability;
- `test/reference-completeness.test.mjs`: public export and MDN-reference coverage.

Run the behavioral suite through the repository's normal gate:

```shell
npm run check
```
