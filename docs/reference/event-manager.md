# EventManager and time-travel diagnostics

`EventManager` gives Arcane applications one synchronous event bus and an optional,
bounded diagnostic timeline. Use it to observe SDK operation events, add semantic
application events, capture browser interactions, export evidence, and review a
recording without implying that Arcane has restored live state.

The API is capability-first:

- ordinary pub/sub works in Node and browser JavaScript;
- recording creates immutable, normalized `arcane-event-stack/1` records;
- browser DOM capture is opt-in and privacy-preserving by default;
- review playback is safe by default; live event redispatch is explicitly effectful;
- no event stack is uploaded, persisted, bridged to Core, or sent to a cloud service
  automatically.

All 20 JavaScript exports are available from both `arcane-os` and
`arcane-os/event-manager`. The bindings are identical, so choose the focused
subpath when event instrumentation is the only SDK capability you need.

## Quick start

```javascript
import {
    arcaneEvents,
    PLAYBACK_RECORD_EVENT
} from 'arcane-os/event-manager';

arcaneEvents.on('document.save.completed',event=>{
    console.info('Saved',event.documentId);
});

arcaneEvents.enableTimeTravel();
try{
    arcaneEvents.instrument(
        'document.save.completed',
        {documentId:'example'},
        {source:'app:editor',category:'operation',correlationId:'save-42'}
    );
}finally{
    arcaneEvents.disableTimeTravel();
}

const stack=arcaneEvents.exportStack();
arcaneEvents.on(PLAYBACK_RECORD_EVENT,record=>console.info(record.type));
await arcaneEvents.playback({stack,mode:'review',speed:0});
```

Recording is disabled on `arcaneEvents` by default. Keep diagnostic sessions
bounded, export intentionally, then call `clearHistory()`.

## Availability and normalization

| Capability | Node | Browser renderer | Native/Core host | Remote or cloud | Normalization |
| --- | --- | --- | --- | --- | --- |
| Pub/sub, semantic instrumentation, parse/export, seek, playback | Yes | Yes, through a bundler or import map | Only when the SDK module runs in that JavaScript host | No automatic transport | Same synchronous API; optional immutable JSON-like snapshots |
| DOM selectors and target descriptions | With DOM-like values or a test shim | Yes | No native UI observation | No | Stable diagnostic descriptors |
| DOM interaction and mutation capture | No native DOM | Yes | No | No | DOM activity becomes semantic event-stack records |
| Event-stack schema | Yes | Yes | Data contract only | Can be transported explicitly by the developer | `arcane-event-stack/1` |

An unbundled browser must serve and map `arcane-os` and `event-pubsub`. The
hash-pinned Arcane browser runtime does not automatically inject this SDK-authored
module into Shell, Provisioner, Core, or built-in apps. There is no transparent
fallback to `arcane/1`, HTTP, WebSocket, Ollama, or a cloud event service.

## Export summary

| Export | Kind | Primary capability |
| --- | --- | --- |
| `ARCANE_EVENT_STACK_PROTOCOL` | String constant | Identify the durable stack format |
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
| `arcaneEvents` | `EventManager` singleton | Observe shared SDK events |

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
    stack=null,
    fromSequence=1,
    toSequence=Number.MAX_SAFE_INTEGER,
    speed=0,
    mode='review',
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

The SDK-wide `EventManager` singleton. Recording is off by default. SDK operation
queues forward each normalized event object through this manager before their
awaited callback; nested queues deduplicate the same object identity.

### Value

```javascript
const arcaneEvents = new EventManager()
```

### Availability and normalization

One singleton per resolved SDK module graph in Node or a browser bundle. It is not
a cross-process, cross-frame, Core, native, or cloud singleton.

### Example

```javascript
import {arcaneEvents} from 'arcane-os';
arcaneEvents.on('sdk.operation.completed',event=>console.info(event));
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

All import limits must be positive safe integers. A valid overflowed stack may
contain `maxEvents + 1` records only when its final record is the sole overflow
marker.

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

Snapshot normalization never evaluates accessor properties. It preserves cycles
as `$ref`, applies tagged forms for non-finite numbers, bigint, symbols, functions,
dates, regular expressions, errors, maps, sets, typed arrays, array buffers,
truncation, unreadable values, and capture failures, and returns null-prototype
objects. Tagged values are evidence, not executable values, and are not revived by
playback.

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
| Constructor flags, clocks, or session id invalid | `TypeError` | Correct types; keep session id non-empty and at most 256 characters |
| Constructor/import retention or snapshot limits invalid | `RangeError` | Use positive safe integers |
| Clock returns invalid timestamp or monotonic value | `TypeError` | Supply a valid UTC-compatible clock and finite non-negative monotonic clock |
| Metadata is not an object; forwarded event is invalid | `TypeError` | Pass an object and a string event type |
| Subscriber throws | Original error is rethrown | Treat synchronous handlers as part of the publisher's failure boundary |
| History overflows | No exception in normal overflow; recording disables | Export, `clearHistory()`, then enable a new bounded session |
| Re-enable before clearing overflow | `Error` | Clear history first |
| Clear during dispatch/playback | `Error` | Wait for the active operation to finish |
| Stack JSON/shape/order/causality invalid | `TypeError` | Reject the input; do not partially use it |
| Import exceeds configured bounds | `RangeError` or invalid-stack `TypeError` | Raise explicit bounds only for a trusted operational need |
| Stack range or playback mode/callback invalid | `TypeError` | Correct the options |
| Export indentation, seek position, or playback speed invalid | `RangeError` | Use documented ranges |
| Playback already active | `Error` | Await or cancel the current playback |
| Playback aborts or a callback/subscriber fails | Promise rejects after terminal lifecycle event | Handle rejection and inspect the immutable terminal error snapshot |
| DOM manager/root/options invalid or MutationObserver unavailable | `TypeError`/`RangeError` | Correct capability/options or set `captureMutations:false` |

## Behavioral tests

The executable contract belongs in:

- `test/event-manager.test.mjs`: synchronous bus compatibility, causal recording,
  redaction and immutable snapshots, strict export/import, cursor behavior,
  review and event playback, cancellation, and central queue mirroring;
- `test/dom-event-instrumentation.test.mjs`: browser interaction/mutation capture,
  open-shadow observation, privacy defaults, lifecycle, and cleanup;
- `test/contracts.test.mjs`: published schema and package-export stability;
- `test/reference-completeness.test.mjs`: public export and MDN-reference coverage.

The retention behavior must additionally assert the boundary itself: retain exactly
`maxEvents` ordinary records, append one final overflow marker on the next
recordable event, deliver that triggering event without recording it, stop DOM
capture without a trailing lifecycle record, reject re-enabling before
`clearHistory()`, and accept the bounded exported stack through
`parseEventStack()`. This protects overflow semantics as behavior rather than only
as documentation.

Run the behavioral suite through the repository's normal gate:

```shell
npm run check
```
