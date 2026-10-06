# Application Core services during source development

`developApplication()` can compose an application's Core services without
selecting, installing or loading a local AI engine. It uses the existing SDK
source server and one app-scoped Core dispatcher; the app owns its service
implementations and the explicit actions that start native work.

## Select services

The ordinary `arcane dev` command reads `native.services` from the selected
application descriptor:

```json
{
    "native": {
        "services": [
            {"module": "bridge/moon-cheese.mjs", "options": {"shelf": "Lunar cheddar"}}
        ]
    }
}
```

This is the `native` portion of the application's existing descriptor, not a
complete descriptor. Module paths resolve from the selected app root. Each
module exports its factory as default, using the same native packaging contract:

```javascript
export default function createMoonCheese(options, context) {
    return {
        name: 'moon-cheese',
        methods: {
            'moon-cheese.current': function current() {
                return {shelf: options.shelf, message: 'The Moon is ready for cheese.'};
            }
        }
    };
}
```

The factory receives `(options, context)` without changing authored options.
Context supplies `appRoot`, the operation `signal`, and `onEvent`; a programmatic
call's explicit `context` fields take precedence, matching the native
launch-context convention. A factory may return a service promise. Service
definitions retain the Core `name`, `methods`, `start`, `drain` and `dispose`
contract. Services start independently after composition; a method waits only
for its own service's startup. A process such as Codex starts only when the
application service's explicit connect method requests it, not because the
development listener opened.

Programmatic composition uses:

```javascript
import {developApplication} from 'arcane-os';

const development = await developApplication({
    workspaceRoot: process.cwd(),
    serviceModules: [{module: 'bridge/moon-cheese.mjs', options: {shelf: 'Lunar cheddar'}}],
    context: {stateRoot: './selected-app-state'}
});
// Application work proceeds. Its owner later calls await development.close().
```

`serviceModules` replaces the descriptor's module list when supplied, including
an explicitly empty array. `services` adds already-constructed Core service
definitions. Both can coexist with configured native local-AI services inside
one dispatcher. No services and no selected local AI preserves ordinary static
source serving. The result adds `core` when composition is selected and retains
the existing `localAI` result when local AI is selected.

## Connect the page without blocking rendering

Load `/arcane-core.js` as an independent module. It immediately exports `client`
after synchronous installation, without awaiting SSE connection or Core/service
readiness. The existing `/arcane-local-ai.js` URL remains an alias for the same
bootstrap behavior. Managed import maps resolve its public Core-client import.

```javascript
import {client} from '/arcane-core.js';

client.events.when('core.ready', function dispatcherReady() {
    client.invoke('moon-cheese.current').then(
        function showCheese(result) { console.log(result); },
        function reportCheeseFailure(error) { console.error(error); }
    );
});
```

The SDK does not inject a script or hold the page's first render. Existing native
clients remain installed; a disconnected standalone client can be replaced by
this explicitly selected development connection. `core.ready` establishes
dispatcher readiness, not a connected application process or loaded model.
Application status methods remain the owner of application state and pending
requests. Generic replay supplies current Core/service lifecycle, not historical
responses, a repository catalog or an application's operation journal.

A page module that loads independently of the bootstrap can use
`subscribeCoreClient()` from `arcane-os/core/client`. It immediately replays the
installed client (or `null`), then reports installation, close and terminal
transport failure. This lets rendering proceed before the connection exists.
Installation alone is not service readiness; observe the returned client's
runtime and service events. Retire subscriptions with the page's owning lifetime.

The development transport uses `/events` for ordered SSE frames and `/rpc` for
JSON requests. The shared Core client owns correlation, timeout and cancellation.
Responses and correlated streaming events return to their originating document.
Uncorrelated service lifecycle events reach connected documents. The payload
is passed unchanged to the service; the adapter adds no application policy.
Connection and complete parsing/transport errors reach the client's existing
failure/diagnostic boundary. Reopening a page creates a new document connection,
not a second service runtime.

## Direct composition

`createDevelopmentCore()` is exported from `arcane-os` and
`arcane-os/core/development`. It accepts
`{appRoot=process.cwd(), application, version, services=[], serviceModules=[],
context={}, getReplayEvents, signal, onEvent}` and returns synchronously:

- `ready`: the runtime after service modules are composed and dispatcher startup
  is accepted; individual services may still be starting or may fail separately;
- `handler(request,response)`: an asynchronous boolean indicating whether an SDK
  Core route was consumed;
- `current()`: `{state,error,core}`, with complete Core service/lifecycle state;
- `close()`: one idempotent shutdown promise.

Use `startDevServer({..., core})` to give that server the handler and shutdown
owner. A failed server start remains the caller's cleanup responsibility for
direct composition; `developApplication()` performs this cleanup itself.
`getReplayEvents()` optionally returns complete current `{event,data}` snapshots
for service-specific replay. It neither stores history nor replaces application
status methods. Existing local-AI composition uses it for its established model,
image and speech snapshots.

## Cancellation and shutdown

A document disconnect or its `requests.cancelAll` cancels only its own
request-lifetime operations. Another document's work remains active. An accepted
`lifetime:'service'` operation survives renderer cancellation; the service owns
its durable completion. A disconnected document receives no later response,
and reconnecting does not automatically repeat the operation.

Closing the development owner stops new Core requests, cancels request-lifetime
work, waits for accepted service work, drains and disposes services, and joins
queued SSE writes before ending remaining connections. Failures remain complete
and observable. The SDK claims no completion for a service that ignores its
cancellation or never settles. It never kills the application process merely
because one page disconnects.

This is one development-server process on Windows, Linux or macOS. It is not a
cross-process host discovery/start-or-reuse service, nor control of existing
Codex desktop tasks. Android requires its separate host adaptation. See
[Core runtime](core-runtime.md) and [Core client](core-client.md) for the underlying
public contracts.
