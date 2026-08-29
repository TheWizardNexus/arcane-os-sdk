# Canonical SDK events and time-travel review

`arcaneEvents` is the canonical synchronous SDK event authority. The module
installs or reuses exactly one branded authority at `globalThis.arcaneEvents` in
each JavaScript realm, even when the same source is loaded through duplicate
module URLs. It is not a cross-frame, worker, process, native-host, or cloud bus.

`EventManager` remains the isolated diagnostics API. `new EventManager()` and
`createEventManager()` each create an independent `event-pubsub` bus whose
`on()`, `emit()`, and `instrument()` handlers are strict: a synchronous listener
failure propagates to that publisher. Use `arcaneEvents.subscribe()` and
`createArcaneEventSource()` for canonical SDK semantic events instead.

The installed global is an own, non-enumerable, non-writable, non-configurable
data property. Its authority brand is
`Symbol.for('arcane-os.arcane-events-authority')`, and both the brand value and
public `protocol` are exactly `arcane-event-authority/1`. A later import reuses
the object only when its property, brand, protocol, and required callable API
descriptors are compatible. An inherited value, accessor, unbranded value,
mutable descriptor, incompatible protocol, incomplete API, or failed install is
rejected; the SDK never replaces or wraps a competing global.

Import the dedicated host-neutral entry point:

```javascript
import {
    arcaneEvents,
    createArcaneEventSource,
    createEventManager,
    projectArcaneDOMEvent,
    PLAYBACK_RECORD_EVENT
} from 'arcane-os/event-manager';
```

An SDK publisher owns one source handle for its lifetime and declares every
semantic event type up front:

```javascript
const controller={};
const events=createArcaneEventSource(controller,{
    source:'app.editor',
    eventTypes:['document.save.completed']
});

const unsubscribe=arcaneEvents.subscribe('document.save.completed',occurrence=>{
    console.info('Saved',occurrence.detail.documentId);
});

const publication=events.dispatch(
    'document.save.completed',
    {documentId:'example',document:liveDocument},
    {
        operationId:'save-42',
        publicDetail:{documentId:'example'},
        cancelable:false
    }
);

projectArcaneDOMEvent(editorElement,publication.occurrence);
unsubscribe();
```

`createArcaneEventSource(owner,options)` is the public wrapper for
`arcaneEvents.createSource(owner,options)`. `options` is the closed record
`{source,eventTypes,onListenerError?}`. Each non-null object or function owner
may have one active source, and the returned handle exposes
`{protocol,descriptor,source,instanceId,eventTypes,disposed,subscribe,on,once,
addEventListener,removeEventListener,dispatch,dispatchEvent,dispose,destroy}`.

`dispatch()` synchronously delivers one mutable `arcane-event-occurrence/1`
to exact-type canonical subscribers, then an EventTarget-compatible view to the
source's own listeners. The occurrence contains `occurrenceId`, `type`, `source`,
`instanceId`, `operationId`, a complete plain-data snapshot in `detail`,
`cancelable`, live `defaultPrevented`, and `preventDefault()`. The richer
compatibility detail remains local to the authority for source listeners and
optional DOM projection; it is not placed on the canonical bus or in time-travel
history.

Source listeners retain EventTarget compatibility: function listeners receive
the source owner as `this`, and the compatibility view exposes that owner as
both `target` and `currentTarget`. Plain records and arrays are shallow-copied;
rich host objects remain local and are not recursively copied.
EventTarget-shaped `addEventListener()` and `removeEventListener()` preserve
native no-op handling for null or non-listener callbacks; strict `subscribe()`
and `on()` still reject an invalid handler.

Canonical delivery is observational. Every active listener runs in registration
order. A listener failure publishes one complete
`arcane.event.listener.error` occurrence and is reported through `reportError`
or `console.error`; it does not undo committed domain work or make
`dispatch()` throw. An optional source `onListenerError(error,errorOccurrence)`
callback receives the raw failure and its canonical listener-error occurrence
only at that owner-local boundary; `errorOccurrence` is `null` only when the
secondary error occurrence itself could not be constructed. Subscriber
promises are not awaited, so keep completion, backpressure, and asynchronous
failure in the SDK-owned queue or operation that owns them. There is no second
Promise-returning publication bus: `dispatch()`, cancellation handling, sticky
state commits, and listener installation remain synchronous. Owned promises and
`createEventQueue()` own asynchronous work, ordering, failure, and backpressure;
an `AbortSignal` removes a subscription but does not claim that already-started
provider, host, or queue work stopped.

`arcaneEvents.subscribe(type,handler,{once=false,signal}={})` returns an
idempotent unsubscribe function whose `.dispose` property is the same function.
An already-aborted signal installs nothing, and abort removes the registration
deterministically. Source `on()` follows the same lifecycle. EventTarget-shaped
`addEventListener()`/`removeEventListener()` calls deduplicate by
type/listener/capture. Calling a source's idempotent `dispose()` emits its final
`arcane.event.source.disposed` occurrence, removes its registrations, and frees
the owner to register a later source.

Cancellation is synchronous and observational. For a cancelable occurrence,
canonical or source listeners may call `preventDefault()`; `dispatch()` then
returns `{occurrence,accepted:false}`. Callers decide whether cancellation gates
their domain operation. `projectArcaneDOMEvent()` is a one-way compatibility
projection: it creates one `CustomEvent`, adds the canonical identifiers to a
mutable outer detail object, preserves any compatibility `source` value, exposes
the canonical emitter as `arcaneSource`, propagates DOM cancellation back to the
occurrence, and never republishes the DOM event into the authority. It returns `false`
without dispatching when the occurrence is already canceled.

The authority also retains `on`, `once`, `off`, `reset`, `emit`, `instrument`,
and `forward` for legacy direct EventManager-style diagnostics. Those handlers
are separate from canonical `subscribe()` registrations; `off()` and `reset()`
cannot remove canonical or source-owned registrations. New SDK publishers must
use source handles. Authority-level `dispatchEvent()` exists only as a deprecated
EventTarget compatibility adapter for older `aiRuntimeEvents` callers.

`aiRuntimeEvents` is itself deprecated. It is a state-free
EventTarget-compatible view over the `AIRuntimeState` source registered with
this authority; it has no listener registry, `EventTarget`, or lifecycle state
of its own. New consumers use the focused AIRuntimeState subscription helpers
or `arcaneEvents.subscribe()`.

## Stable authority failures

`ARCANE_EVENT_ERROR_CODES` maps every key below to the identical
string value. Thrown authority errors expose that value as `error.code`:

```text
ARCANE_EVENT_AUTHORITY_ACCESSOR_COLLISION
ARCANE_EVENT_AUTHORITY_VALUE_COLLISION
ARCANE_EVENT_AUTHORITY_DESCRIPTOR_MISMATCH
ARCANE_EVENT_AUTHORITY_PROTOCOL_MISMATCH
ARCANE_EVENT_AUTHORITY_API_MISMATCH
ARCANE_EVENT_AUTHORITY_INSTALL_FAILED
ARCANE_EVENT_SOURCE_INVALID
ARCANE_EVENT_SOURCE_ALREADY_REGISTERED
ARCANE_EVENT_SOURCE_DISPOSED
ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED
ARCANE_EVENT_COMPATIBILITY_DETAIL_INVALID
ARCANE_EVENT_OCCURRENCE_INVALID
ARCANE_EVENT_OCCURRENCE_SEQUENCE_EXHAUSTED
ARCANE_EVENT_SOURCE_SEQUENCE_EXHAUSTED
ARCANE_EVENT_LISTENER_CALLBACK_FAILED
ARCANE_EVENT_DOM_DETAIL_COLLISION
ARCANE_EVENT_DOM_TARGET_INVALID
ARCANE_EVENT_DOM_OPTIONS_INVALID
ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID
ARCANE_EVENT_SUBSCRIPTION_HANDLER_INVALID
ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID
ARCANE_EVENT_SUBSCRIPTION_SIGNAL_INVALID
ARCANE_EVENT_DISPATCH_EVENT_INVALID
```

Listener callback failure is observational: it appears as
`ARCANE_EVENT_LISTENER_CALLBACK_FAILED` inside the
`arcane.event.listener.error` occurrence. Its complete public detail is
`{code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',reason:'listener-threw',
eventType,occurrenceId,source,instanceId,operationId,error}`. Source disposal publishes
`arcane.event.source.disposed` with public detail
`{reason:'source-disposed'}` rather than throwing from committed source dispatch.

## Enable a complete event stack

Time-travel recording is disabled by default. With the flag off, the manager is
only a pub/sub bus: it captures no history, source stack, or DOM activity.

```javascript
const events=createEventManager({
    timeTravel:true,
    dom:{root:document}
});
```

It can also be enabled around a diagnostic session:

```javascript
arcaneEvents.enableTimeTravel({
    dom:{root:document}
});

// Exercise the scenario.

arcaneEvents.disableTimeTravel();
const serialized=arcaneEvents.exportStack();
```

While enabled, every isolated-manager event receives a mutable
`arcane-event-stack/1` record containing the session and event ids, sequence,
UTC and monotonic timestamps, source/category, correlation and causation ids,
nested dispatch depth, a complete payload snapshot, completion or failure
outcome, and dispatch duration. Recording preserves complete strings, URLs,
public details, collections, object entries, nesting, and available source or
error stack text. It performs no implicit redaction. Do not place credentials
or secrets in event payloads or metadata. The durable JSON shape is published
as `arcane-os/schemas/event-stack.json`.

Recording retains the complete session until the caller clears history or
disables recording. It never truncates, clips, tails, elides, or rotates event
content. Arcane does not upload or persist a stack automatically.

## DOM observation

When a DOM root is attached while time travel is enabled, capture-phase
listeners record the standard keyboard, pointer, mouse, touch, form, focus,
clipboard, drag, selection, and scroll interaction set. A `MutationObserver`
records attribute, text, insertion, and removal mutations, including old values
where the platform exposes them. Open shadow roots present at startup or found
in inserted nodes are observed separately; composed events are deduplicated.

DOM instrumentation preserves complete input values, node markup and text,
selectors, document and attribute URLs, keyboard/composition/input fields, and
object-valued event details. It does not trim, clip, tail, redact, or otherwise
shorten those values. This can include sensitive page content, so attach the
diagnostic only when that complete capture is intended, never place credentials
in the observed page or event payloads, and review recordings before sharing.
`captureMutations:false` disables mutation observation, and
`observeOpenShadowRoots:false` leaves open shadow roots outside the observer;
interaction events remain complete.

Mutation observation is an audit backstop, not proof of every renderer state
change. It cannot see closed shadow roots, cross-origin frames, external web
content, CSSOM/canvas drawing, most property-only writes, native/kernel activity,
or interactions that happened before instrumentation started. Use semantic
`instrument()` events at SDK-owned mutation boundaries when exact intent and
causation matter.

## Seek and playback

`seek(sequence)` moves the diagnostic review cursor and emits
`arcane.time-travel.seek`. It does not rewrite live DOM or application state.
The default playback mode emits each complete record on
`arcane.time-travel.playback.record` for a debugger or review UI:

```javascript
events.on(PLAYBACK_RECORD_EVENT,record=>reviewTimeline(record));
await events.playback({stack:serialized,mode:'review',speed:2});
```

`speed: 0` plays immediately; a positive value preserves monotonic recorded
delays at that multiplier. Playback supports `AbortSignal` and emits an explicit
completed, cancelled, or failed terminal event. Recording is suppressed during
playback so replay cannot recursively add itself to the stack.

`mode: 'events'` redispatches recorded event payloads to live subscribers. That
mode can execute application effects and is only appropriate inside an isolated
diagnostic harness with effectful subscribers replaced. The SDK does not
synthesize trusted browser input, restore a prior DOM snapshot, resend native
RPC, repeat provisioning, launch processes, write storage, or repeat network or
other privileged effects.

## Browser delivery boundary

The package entry point works directly in Node and through browser bundlers.
The npm artifact bundles the exact `event-pubsub` and `strong-type` pair because
`event-pubsub@6.1.0` uses a sibling-relative runtime import. Unbundled browser
use must preserve that physical sibling layout and provide import-map entries
for the public SDK entry and `event-pubsub`.

The managed Arcane browser runtime ships the focused entry and its
dependency closure. Its import map resolves `arcane-os/event-manager` exactly;
query, fragment, and subpath variants are not alternate authority identities.
