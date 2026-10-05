# Shared WebSocket clients

`arcane-os/websocket-client` exposes the published `ws-share` constructor as
both `default` and `WS`. Node also exports the same `WS` binding from
`arcane-os`. Browser modules use the focused entry through the generated SDK
import map. These entries reuse the upstream implementation rather than
creating another pool or event bus.

```javascript
import WS from 'arcane-os/websocket-client';

const airlock=new WS('wss://moon.example/airlock',['moon-control']);
const oxygenPanel=new WS('wss://moon.example/airlock',['moon-control']);
console.log(airlock===oxygenPanel); // true while connecting or open

function showAirlockMessage(event){
    console.log(event.data);
}
airlock.addEventListener('message',showAirlockMessage);

// When this panel goes away, release only its listener.
function disposePanel(){
    airlock.removeEventListener('message',showAirlockMessage);
}
```

Replace the example URL with your application's WebSocket endpoint. The exact
URI string and ordered protocol list select a shared connection. Repeated
construction reuses a connecting or open socket. A closing or closed socket
gets a new physical connection and a new ID; the predecessor's eventual close
cannot remove its replacement.

The returned object is the native `WebSocket`, with its native `send`,
`close`, `binaryType`, properties and per-socket events. Complete messages pass
through unchanged. Upstream `on`/`off` and `addListener`/`removeListener`
aliases retain native listener semantics, rather than Node EventEmitter
semantics. Importing the SDK entry starts no connection and does not replace
`globalThis.WebSocket`.

## Observe all managed connections

`await WS.observe()` returns one lazy `event-pubsub` observer per loaded
implementation. Repeated or concurrent calls return that same observer.
Enabling observation opens no socket. Register handlers after the await, then
read `WS.getConnections()` synchronously without another await between them.

```javascript
import {WS} from 'arcane-os/websocket-client';

const events=await WS.observe();
const liveConnections=new Map();

function trackConnection(type,connection){
    if(type==='close')liveConnections.delete(connection.id);
    else liveConnections.set(connection.id,connection);
    console.log(type,connection.id,connection.url,connection.readyState);
}

events.on('*',trackConnection);
for(const connection of WS.getConnections()){
    liveConnections.set(connection.id,connection);
}

function disposeConnectionPanel(){
    events.off('*',trackConnection);
}
```

The typed events `created`, `open`, `error` and `close` each receive one record.
The wildcard handler receives `(type,record)`. Each record contains:

| Field | Meaning |
| --- | --- |
| `id` | Numeric physical-connection identity within this loaded implementation. |
| `socket` | The exact native socket. |
| `url` | The native socket's URL. |
| `protocols` | A fresh copy of the requested, normalized protocol list. |
| `readyState` | Native state when the record is produced. |
| `event` | Original native event; `created` has `undefined`. |

`WS.getConnections()` returns fresh records with the first five fields. It
includes tracked sockets until their native close event, including a closing
predecessor after its replacement exists. Records are snapshots; the `socket`
remains live. Read a new snapshot when current state is needed.

`created` is queued in a microtask only when observation was enabled at
construction. Reusing a connection emits no second `created` event. A snapshot
can include a connection before its queued `created` notification arrives, so
reconcile by `id` rather than appending duplicates. Native close removes the
connection and its internal lifecycle listeners before global close handlers
run. Applications may still use native socket listeners alongside the global
observer; there is no second per-socket event bus.

## Ownership and lifetime

Every caller shares the same socket, including changes to `binaryType`, a
property handler, or a call to `close()`. A component that only owns a listener
removes that exact listener. The application decides when the shared socket
should close; construction does not acquire an independent reference-counted
lifetime. Remove only your own observer handlers instead of resetting the
shared observer. Observe asynchronous handler failures at their owning caller.

All modules that should share connections use the same SDK module URL in
their realm. Separate package copies, browser realms, Workers, processes, and
upstream classic-script versus ESM loads have separate pools. The observer
reports actual native lifecycle events; it provides no closed-event history
or delivery after the realm/process ends. It adds no automatic reconnect,
heartbeat, message envelope, storage, or application routing.

## Runtime and package delivery

The SDK's Node baseline supplies native `WebSocket`; browsers need their native
WebSocket capability. The focused entry is portable JavaScript, with the host
owning networking and native errors. Browser Workers need module resolution
provided by their host because document import maps do not apply to Workers.

The SDK selects `ws-share@3.1.0` and `event-pubsub@6.1.1`. npm resolves the
latter's `strong-type@2.0.0`, while the SDK's own direct `strong-type@2.0.1`
remains unchanged. The canonical browser projection generator copies the
installed public runtime files unchanged. Managed maps resolve the shared
constructor and event package to one URL each, and a dependency scope selects
the event package's own strong-type version. Physical, direct-installed,
packaged-document and managed test maps preserve that scope. Applications
regenerate their managed maps/runtime through the ordinary public SDK flow;
they do not copy the upstream implementation into application source.

`acceptWebSocket` remains the separate Node server-side API at
`arcane-os/websocket`. It owns accepted server connections, not this client
pool. Existing native clients and server Upgrade handling remain available.

Upstream details: [ws-share 3.1.0 release](https://github.com/RIAEvangelist/ws-share/releases/tag/3.1.0)
and [observer documentation](https://riaevangelist.github.io/ws-share/#observe).
