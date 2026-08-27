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
    Object.freeze({documentId:'example',document:liveDocument}),
    {
        operationId:'save-42',
        publicDetail:{documentId:'example'},
        cancelable:false
    }
);

projectArcaneDOMEvent(editorElement,publication.occurrence);
unsubscribe();
```

`dispatch()` synchronously delivers one immutable `arcane-event-occurrence/1`
to exact-type canonical subscribers, then an EventTarget-compatible view to the
source's own listeners. The occurrence contains `occurrenceId`, `type`, `source`,
`instanceId`, `operationId`, deeply frozen privacy-admitted `detail`,
`cancelable`, live `defaultPrevented`, and `preventDefault()`. The richer
compatibility detail remains local to the authority for source listeners and
optional DOM projection; it is not placed on the canonical bus or in time-travel
history.

Source listeners retain EventTarget compatibility: function listeners receive
the source owner as `this`, and the frozen compatibility view exposes that owner
as both `target` and `currentTarget`. Already-frozen compatibility detail retains
its identity. Other plain records and arrays are shallow-copied and frozen;
rich host objects remain local and are not recursively frozen.

Canonical delivery is observational. Every active listener runs in registration
order. A listener failure publishes one privacy-safe
`arcane.event.listener.error` occurrence and is reported through `reportError`
or `console.error`; it does not undo committed domain work or make
`dispatch()` throw. An optional source `onListenerError(error,errorOccurrence)`
callback receives the raw failure only at that owner-local boundary. Subscriber
promises are not awaited, so keep completion, backpressure, and asynchronous
failure in the SDK-owned queue or operation that owns them.

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
frozen outer detail object, preserves any compatibility `source` value, exposes
the canonical emitter as `arcaneSource`, propagates DOM cancellation back to the
occurrence, and never republishes the DOM event into the authority. It returns `false`
without dispatching when the occurrence is already canceled.

The authority also retains `on`, `once`, `off`, `reset`, `emit`, `instrument`,
and `forward` for legacy direct EventManager-style diagnostics. Those handlers
are separate from canonical `subscribe()` registrations; `off()` and `reset()`
cannot remove canonical or source-owned registrations. New SDK publishers must
use source handles. Authority-level `dispatchEvent()` exists only as a deprecated
EventTarget admission adapter for older `aiRuntimeEvents` callers.

## Enable a bounded, complete event stack

Time-travel recording is disabled by default. With the flag off, the manager is
only a pub/sub bus: it captures no history, source stack, or DOM activity.

```javascript
const events=createEventManager({
    timeTravel:true,
    maxEvents:10_000,
    dom:{
        root:document,
        captureInputValues:false
    }
});
```

It can also be enabled around a diagnostic session:

```javascript
arcaneEvents.enableTimeTravel({
    dom:{root:document,captureInputValues:false}
});

// Exercise the scenario.

arcaneEvents.disableTimeTravel();
const serialized=arcaneEvents.exportStack();
```

While enabled, every isolated-manager event receives an immutable
`arcane-event-stack/1` record containing the session and event ids, sequence,
UTC and monotonic timestamps, source/category, correlation and causation ids,
nested dispatch depth, a bounded payload snapshot, completion or failure
outcome, and dispatch duration. Source stacks are `null` by default; explicitly
set `captureStacks: true` only for a controlled local session. Stored strings,
collections, object entries, nesting, source stacks, and error stacks remain
bounded. The durable JSON shape is published as
`arcane-os/schemas/event-stack.json`.

The default event limit is 10,000 records. Recording retains the complete
session until that limit. On the next attempted record, it appends exactly one
`arcane.time-travel.overflow` marker, stops DOM observation, and disables
recording. It never silently evicts a prefix or presents a partial tail as a
complete session. Call `clearHistory()` before re-enabling recording. Tune
`maxEvents`, `maxSnapshotDepth`, `maxSnapshotEntries`, and
`maxSnapshotStringLength` for the diagnostic environment. The string limit has
a minimum of 64 characters so generated structural markers remain importable.
High-frequency
pointer, touch, drag, scroll, and wheel events can reach the limit quickly.
Arcane does not upload or persist a stack automatically.

## DOM observation

When a DOM root is attached while time travel is enabled, capture-phase
listeners record the standard keyboard, pointer, mouse, touch, form, focus,
clipboard, drag, selection, and scroll interaction set. A `MutationObserver`
records attribute, text, insertion, and removal mutations, including old values
where the platform exposes them. Open shadow roots present at startup or found
in inserted nodes are observed separately; composed events are deduplicated.

Input values, node markup/text, and text-bearing event details are excluded by
default. Password/autocomplete-password fields and elements beneath
`data-arcane-private` stay redacted even when ordinary value capture is enabled.
Keyboard text, composition/input `data`, arbitrary `detail`, and clipboard
contents are not retained by the safe defaults. Mutation `value`, `srcdoc`,
style, credential-like attributes, and every URL-bearing attribute are replaced
with markers; the observed document URL is never retained. Raw added/removed
node markup is replaced with a content-omitted marker unless
`captureNodeMarkup: true` is explicitly selected. Event payload keys that look
like credentials, tokens, cookies, passwords, secrets, or private keys are also
redacted before history or export.

`captureInputValues`, `captureEventDetails`, `captureNodeMarkup`, and
`captureStacks` are separate, explicit diagnostic choices. They remain bounded,
and private targets plus URL fields remain protected, but any enabled diagnostic
content may still be sensitive. Treat recordings as local evidence and review
them before sharing.

Mutation observation is an audit backstop, not proof of every renderer state
change. It cannot see closed shadow roots, cross-origin frames, external web
content, CSSOM/canvas drawing, most property-only writes, native/kernel activity,
or interactions that happened before instrumentation started. Use semantic
`instrument()` events at SDK-owned mutation boundaries when exact intent and
causation matter.

## Seek and playback

`seek(sequence)` moves the diagnostic review cursor and emits
`arcane.time-travel.seek`. It does not rewrite live DOM or application state.
The safe default playback mode emits each immutable record on
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

The managed Arcane browser runtime ships the authenticated focused entry and its
dependency closure. Its import map resolves `arcane-os/event-manager` exactly;
query, fragment, and subpath variants are not alternate authority identities.
