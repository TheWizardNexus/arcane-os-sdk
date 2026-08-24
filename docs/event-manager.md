# Central event instrumentation and time-travel review

`EventManager` is the preferred event instrumentation surface for new Arcane
SDK code. It composes `event-pubsub` for synchronous delivery and adds Arcane's
optional diagnostic record around that bus. Existing SDK operation queues mirror
their normalized events through the shared `arcaneEvents` manager exactly once
without replacing their awaited callback, backpressure, cancellation, or failure
semantics.

Import the dedicated host-neutral entry point:

```javascript
import {
    arcaneEvents,
    createEventManager,
    PLAYBACK_RECORD_EVENT
} from 'arcane-os/event-manager';
```

Prefer one manager for an application or process boundary. Publish semantic
events through `instrument()` when source and correlation metadata are known:

```javascript
arcaneEvents.on('document.save.completed',event=>{
    console.info('Saved',event.documentId);
});

arcaneEvents.instrument(
    'document.save.completed',
    {documentId:'example'},
    {
        source:'app:example',
        category:'operation',
        correlationId:'save-42'
    }
);
```

`on`, `once`, `off`, `emit`, `reset`, and `list` retain the synchronous
`event-pubsub` contract. Synchronous subscriber exceptions propagate to the
publisher. Subscriber promises are not awaited, so use the SDK's owned event
queues for work whose completion, failure, or cancellation depends on an
asynchronous callback.

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

While enabled, every manager event receives an immutable
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

The current `0.1.0-dev.4` hash-pinned Arcane browser runtime does not yet
bootstrap or package this SDK-authored module. Built-in Shell, Provisioner, and
native Arcane application instrumentation therefore belongs in the downstream
Arcane OS integration work; this SDK release does not claim automatic coverage
inside those surfaces.
