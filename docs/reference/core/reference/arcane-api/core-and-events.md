# Arcane API core and event guides

These guides cover the synchronous renderer snapshot and the four event
subscription and completion-observation methods. For individual event payloads,
see the [Arcane event catalog](../../arcane-events.md).

## Arcane.runtime.current()

### Overview

`Arcane.runtime.current()` synchronously describes the Arcane transport surface
detected for the current document. It performs no RPC and returns a frozen
snapshot immediately.

```javascript
const runtime = Arcane.runtime.current();
```
The result has this exact shape:

| Property | Type | Meaning |
| --- | --- | --- |
| `connected` | `boolean` | `true` when this document initialized a callable Arcane messaging transport. |
| `transport` | `string` | One of `webview2`, `webkitgtk`, `android-webview`, `development-http`, or `standalone`. |
| `native` | `boolean` | `true` for WebView2, WebKitGTK, and Android WebView hosts. |
| `managedLocalAI` | `boolean` | `true` only for the WebView2 and WebKitGTK desktop host classes that can mediate Arcane-managed local services. |

`connected` is a transport fact, not a health, authority, or readiness claim. It
does not mean Core answered a request, that the current application is admitted
for a method, or that a dependency is installed. Likewise, `managedLocalAI`
describes a host capability class; it does not report that Ollama, speech, or a
model is installed or healthy.

Use `Arcane.capabilities.list()` to inspect the bound application and admitted
methods, and use the relevant namespace status method for dependency state.

### Runtime snapshot

The method returns a frozen object. It does not return a `Promise`, does not
initialize a new request, and has no asynchronous rejection path.

The transport values mean:

| Value | Environment |
| --- | --- |
| `webview2` | Native Microsoft NT WebView2 host. |
| `webkitgtk` | Native Linux WebKitGTK host. |
| `android-webview` | Native Android WebView host. |
| `development-http` | Development HTTP bridge; not a native renderer host. |
| `standalone` | No callable Arcane host transport was selected. |

### Example

```javascript
const runtime = globalThis.Arcane?.runtime?.current?.();

if (!runtime) {
    throw new Error('The Arcane API is not loaded in this document.');
}

console.table(runtime);

if (!runtime.connected) {
    console.info('Open this application through an Arcane host to use native methods.');
} else if (runtime.native) {
    console.info(`Running through the native ${runtime.transport} transport.`);
} else {
    console.info(`Running through the ${runtime.transport} development transport.`);
}
```

## Arcane.events.on()

### Overview

`Arcane.events.on(eventName, listener)` subscribes to every future matching
event. It is synchronous and returns an unsubscribe function.

For a named event, the listener receives the event's data payload directly:

```javascript
const off = Arcane.events.on('terminal.output', function logTerminalOutput(data) {
    console.log(data.sessionId, data.stream, data.data);
});
```

The special event name `"*"` subscribes to all future events. Its listener
receives `{ event, data }`, not the named event's data alone:

```javascript
const off = Arcane.events.on('*', function logAnyArcaneEvent({event, data}) {
    console.debug(event, data);
});
```

Event names and payloads are defined in the
[Arcane event catalog](../../arcane-events.md).

### Parameters and return value

| Parameter | Type | Description |
| --- | --- | --- |
| `eventName` | `string` | A documented event name, or `"*"` for live wildcard observation. |
| `listener` | `function` | Called for each future matching event. |

The returned `unsubscribe()` function removes that listener. Retain it and call
it during component or document teardown. Repeating the call is harmless.

Passing a non-function `listener` throws a synchronous `TypeError`. An unknown
event name does not itself throw; it simply has no delivery unless the host later
emits that exact name.

### Delivery and failure behavior

`on()` is future-only. It does not replay ordinary events or an already observed
durable completion. Use `when()` when a late subscriber must observe
`transport.ready` or `core.ready`.

Listener exceptions are caught and logged. Delivery continues to the other
listeners, and the exception is not sent back to the native event producer.
Handle expected listener failures inside the callback when the application must
surface them.

### Example

```javascript
const events = globalThis.Arcane?.events;

if (!events?.on) {
    throw new Error('Arcane events are unavailable.');
}

const offOutput = events.on('terminal.output', function writeTerminalOutput(payload) {
    const write = payload.stream === 'stderr' ? console.error : console.log;
    write(`[${payload.sessionId}] ${payload.data}`);
});

const offAll = events.on('*', function logObservedArcaneEvent({event}) {
    console.debug('Observed Arcane event', event);
});

function cleanup() {
    offOutput();
    offAll();
}

globalThis.addEventListener('pagehide', cleanup, {once: true});
```

## Arcane.events.once()

### Overview

`Arcane.events.once(eventName, listener)` subscribes to the next future matching
event. The subscription removes itself before invoking the listener, so at most
one future delivery reaches that callback. It returns an unsubscribe function
that can cancel the subscription before the event occurs.

`once()` is future-only for every event, including `transport.ready` and
`core.ready`. It never replays a completion that occurred before registration.
Use `when()` for durable completion observation. Event names and payloads are in
the [Arcane event catalog](../../arcane-events.md).

### Parameters and return value

| Parameter | Type | Description |
| --- | --- | --- |
| `eventName` | `string` | The exact future event to observe. |
| `listener` | `function` | Called once with the named event's data payload. |

The result is an `unsubscribe()` function. Call it when the owner is disposed or
when the application no longer needs to wait.

The listener must be callable. Unlike `on()` and `when()`, the current `once()`
surface does not synchronously validate the original listener. A non-function
listener therefore fails inside guarded event delivery and is logged rather than
producing a useful registration-time `TypeError`. Treat a non-function listener
as invalid input and always pass a function.

Listener exceptions are otherwise isolated in the same way as `on()` listener
exceptions: they are logged and do not interrupt other event subscribers.

### Example

```javascript
const events = globalThis.Arcane?.events;

if (!events?.once) {
    throw new Error('Arcane events are unavailable.');
}

let timeout = null;
const cancelExitWait = events.once('terminal.exit', function reportNextTerminalExit(payload) {
    clearTimeout(timeout);
    console.log(
        `Session ${payload.sessionId} exited`,
        payload.exitCode,
        payload.signal
    );
});

timeout = setTimeout(function cancelTimedOutExitWait() {
    cancelExitWait();
    console.warn('Stopped waiting for the next terminal exit.');
}, 30_000);

globalThis.addEventListener('pagehide', function cleanupExitWait() {
    clearTimeout(timeout);
    cancelExitWait();
}, {once: true});
```

## Arcane.events.when()

### Overview

`Arcane.events.when(eventName, listener)` observes a designated durable
completion. Exactly two event names are durable:

| Event | Hosts | First payload |
| --- | --- | --- |
| `transport.ready` | Every initialized Arcane transport. | `{ protocol, transport }` identifies the selected wire protocol and transport. |
| `core.ready` | Core-backed Microsoft NT, Linux, and development HTTP hosts. | `{ pid, version, app, platform, elevated, simulation }` describes the ready Core process and its public host context. |

If the completion has not occurred, `when()` behaves as a one-time future
subscription. If it already occurred, `when()` queues the stored first payload
for asynchronous listener delivery. The callback never runs in the same call
stack as a late `when()` registration.

The first completion payload is snapshotted and recursively frozen before live
callbacks run. Repeated events with the same durable name do not replace the
stored value. Wildcard subscriptions can observe the original live completion,
but they do not receive historical replays triggered by `when()`.

See the [Arcane event catalog](../../arcane-events.md) for both completion
payloads and their limits.

### Parameters and return value

| Parameter | Type | Description |
| --- | --- | --- |
| `eventName` | `string` | The durable completion to observe: `transport.ready` or `core.ready`. |
| `listener` | `function` | Called once with the immutable first completion payload. |

The return value is an unsubscribe function. For a queued late replay, calling
it before the next microtask prevents callback delivery.

Passing an event other than `transport.ready` or `core.ready` throws a
synchronous `TypeError`. Passing a non-function listener for a valid durable
event also throws a synchronous `TypeError`.

`transport.ready` alone does not prove host health, application authority,
capability grants, publisher trust, or service readiness. Use the relevant API
for each of those facts.

### Example

```javascript
const events = globalThis.Arcane?.events;

if (!events?.when) {
    throw new Error('Arcane completion events are unavailable.');
}

const offTransport = events.when('transport.ready', function reportTransportReady(payload) {
    console.log('Transport selected', payload.protocol, payload.transport);
});

const offCore = events.when('core.ready', function reportCoreReady(payload) {
    console.log('Core ready', payload.version, payload.app, payload.platform);
});

globalThis.addEventListener('pagehide', function cleanupReadinessSubscriptions() {
    offTransport();
    offCore();
}, {once: true});
```

## Arcane.events.completed()

### Overview

`Arcane.events.completed(eventName)` synchronously reports whether this document
has already observed the first occurrence of a designated durable completion.
It returns `true` only for an observed `transport.ready` or `core.ready` event.

It returns `false` for a durable event that has not occurred, for an ordinary
event, and for an unknown name. It does not throw for an unknown name and does
not initiate transport or host work. Use `when()` to act when the completion is
available instead of polling this method.

The [Arcane event catalog](../../arcane-events.md) distinguishes durable
completions from future-only events.

### Parameters and return value

| Parameter | Type | Description |
| --- | --- | --- |
| `eventName` | `string` | The completion name to inspect. |

The return value is a synchronous `boolean`.

### Example

```javascript
const events = globalThis.Arcane?.events;

if (!events?.completed || !events?.when) {
    throw new Error('Arcane completion events are unavailable.');
}

if (events.completed('core.ready')) {
    console.log('Core readiness was already observed in this document.');
} else {
    const stopWaiting = events.when('core.ready', function reportCoreReady(payload) {
        console.log('Core became ready', payload.version);
    });

    globalThis.addEventListener('pagehide', stopWaiting, {once: true});
}
```
