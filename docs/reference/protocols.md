# Protocol and host architecture

This is the deep reference behind the compact availability notes elsewhere.
Application developers normally call one documented API and do not choose a
wire protocol directly.

## Layer map

```text
application code
  |-- Node SDK API ---------------- arcane-cli-events/1 + SDK receipts
  |-- EventManager ---------------- synchronous bus + arcane-event-stack/1
  |
  `-- renderer ESM / globalThis.Arcane
        |-- standalone browser ----- standard Web APIs / allowed HTTPS
        |-- development host ------- development HTTP bridge
        |-- Microsoft NT native ---- WebView2 host bridge
        |-- Linux native ----------- WebKitGTK host bridge
        `-- Android native --------- Android WebView message bridge
                                      |
                                      `-- Arcane Core/provider boundary
                                            |-- platform services
                                            |-- ArcaneOllama loopback service
                                            `-- explicitly selected cloud APIs
```

Each downward boundary can add authority and platform capability. None can be
inferred merely from a function existing in shared JavaScript.

## SDK package and CLI protocols

The npm package API is ordinary Node.js ESM. The CLI and programmatic toolchain
share one headless operation implementation. Long-running operations accept
before blocking work, own their task, stream structured events with bounded
backpressure, emit progress or heartbeats, support cancellation where the
underlying operation can do so safely, and surface failure through rejection or
a nonzero CLI status.

Machine output uses `arcane-cli-events/1`. Native planning and providers use:

- `arcane-target-adapter/1` for target adapters;
- `arcane-native-build-plan/1` for immutable native plans;
- `arcane-native-builder/1` for injected native builders;
- `arcane-integrated-toolchain/1` for the fixed integrated shared/Core provider.

These protocols normalize orchestration and evidence. They do not normalize a
Windows EXE, Linux DEB, Android APK, and portable directory into the same
artifact kind.

## Central events and time-travel data

`arcane-os/event-manager` is host-neutral JavaScript. Its live event path is
synchronous, in-process `event-pubsub`; it does not select WebView2,
WebKitGTK, Android, HTTP, Core, or a kernel boundary. Optional history uses the
strict `arcane-event-stack/1` data format. That protocol names an immutable
diagnostic document, not a network channel and not the `arcane/1` Core RPC
protocol.

Live listeners receive the original arguments. Recording separately snapshots
payloads and metadata with explicit depth, entry, string, and history limits;
redaction is enabled by default. Exported stacks can be moved between Node and
browser hosts because `parseEventStack()` validates and canonicalizes the data
before playback. Review mode emits immutable records, events mode deliberately
re-emits recorded event types, and neither mode restores external host side
effects or DOM state.

<details>
<summary>Event-stack identity, overflow, and trust boundary</summary>

Each document carries `protocol`, `sessionId`, `createdAt`, and ordered
`events`. Each record repeats the protocol/session and carries sequence,
timing, nesting/causation, source/category, payload, metadata, status, and
failure evidence. At `maxEvents`, the manager appends one terminal
`arcane.time-travel.overflow` marker, disables recording, and stops DOM
observation; this explicit marker is why a valid overflow document may contain
`maxEvents + 1` records. Import is strict, rejects extra or unsafe structure,
and grants no Core capability, app admission, or provider authority.

</details>

See [EventManager and time-travel review](event-manager.md) for the callable
surface, DOM privacy defaults, playback modes, and recovery behavior.

## Browser runtime delivery

External and integrated workspaces keep the same application URLs. Runtime ESM
is served beneath `/arcane`, the vendored dependency beneath
`/node_modules/strong-type`, and license material beneath
`/licenses/arcane-os`. A browser import such as:

```javascript
import ollama from '/arcane/modules/Ollama.js';
```

uses browser ESM in every renderer. The imported module can be pure browser
logic, standard-Web-API logic, or a client of `globalThis.Arcane`. Import
transport and host RPC are separate layers.

## Arcane application protocol

`globalThis.Arcane.protocol` is `arcane/1`. The shared API wraps transport
selection, request ids, JSON-safe values, promise settlement, `Arcane.Error`,
and renderer events. The current transport snapshot is synchronous:

```javascript
const {connected, transport, native, managedLocalAI} =
    globalThis.Arcane.runtime.current();
```

Transport values are `webview2`, `webkitgtk`, `android-webview`,
`development-http`, and `standalone`. `connected` means a callable transport
was initialized. It does not prove that Core answered, the method is admitted,
or a dependency is ready.

## Native host transports

### Microsoft NT / WebView2

The renderer uses the WebView2 host messaging surface. The host binds one app
identity and native policy to the session before Core dispatch. Microsoft NT
can expose managed-service and privileged platform operations that do not exist
in an ordinary browser.

### Linux / WebKitGTK

The renderer uses the WebKitGTK host bridge with the same application-facing
`Arcane` protocol. Linux can implement the same normalized methods through
different host code. Some administrator-owned service settings intentionally
return unsupported/manual guidance rather than imitating Microsoft NT mutation.

### Android / Android WebView

Android injects a main-frame, origin-bound bridge for the packaged application.
Its generated registry binds application identity, package version, entry,
grants, and method policy. Android exposes a narrower surface, including an
admitted user-managed local-AI chat projection where configured. Desktop model
management is not projected merely because a user-managed Ollama listener is
reachable.

### macOS

No macOS target, native bridge, Core host, artifact, or run contract is exposed
by this SDK version. A browser may still run browser-only application code, but
that does not create a native Arcane host or satisfy a native capability.

## Development and remote HTTP transport

The development HTTP bridge makes the same application-facing request shape
available without pretending the browser is a native host. It is a development
transport, not a production isolation or authority boundary. A remotely
operated client can use an expressly configured web transport only when the
host, origin, application identity, and policy admit it; Arcane does not silently
swap native calls to arbitrary remote HTTP endpoints.

When transport changes while the public method remains the same, request
settlement and public errors stay normalized. Host-specific availability and
result detail remain documented by the method.

## Core dispatch and capability admission

The host binds the caller's application identity. Core checks the exact method,
required capability, allowed application type/id, privilege, mutation
exclusivity, request bounds, and relevant package policy. Renderer-supplied app
ids or grants never replace that bound identity.

`Arcane.capabilities.list()` is the Core-side application preflight. It reports
current grants and admitted methods but does not reserve authority for a later
call. Each call is checked again.

## Arcane Ollama protocol path

The safe application path is:

```text
renderer Ollama.js or Arcane.ollama
  -> arcane/1 host request
  -> Core capability and package-policy admission
  -> managed ArcaneOllama loopback service
  -> bounded Ollama HTTP operation
```

Applications never connect directly to `localhost:11434`. Core owns loopback
endpoint selection, method admission, request/response limits, stream ids,
chunk events, model-policy checks, native resource admission, and managed
mutation workflows.

Direct Ollama methods preserve the bounded provider-native success envelope.
Arcane normalizes the outer promise/error and stream lifecycle. `chatText`,
`generateText`, and `readiness` are helper-level normalizers.

## Explicit cloud provider path

`/arcane/modules/AI.js` can use an explicitly selected and configured cloud
profile over HTTPS. That path is not Core transport fallback. The module adapts
the selected provider into its high-level application behavior, while provider
diagnostics and optional fields can remain provider-specific. Native policy and
network policy still govern a native renderer's outbound access.

Local failure never authorizes cloud disclosure. The user or owning application
must select and configure the cloud provider explicitly.

## Events, streaming, and cancellation

Renderer-visible Core events are listed in
[the Arcane event reference](core/arcane-events.md). Durable
`transport.ready` and `core.ready` completions can be observed after the fact
with `Arcane.events.when()`. Ordinary progress, stream, terminal, and appearance
events are future-only.

Ollama streaming correlates chunks to the originating request. A renderer
abort or timeout can stop observation without proving that a non-cooperative
host mutation stopped. Method guides state whether Core cooperatively cancels,
whether partial provider state can remain, and which status call must be
refreshed before retry.

## Cross-kernel normalization boundary

The common contract ends where platform truth must remain different:

- API names, promise/error behavior, admission, request bounds, and public
  operation events are normalized;
- host availability, privilege model, installation/service mechanism, native
  artifact kind, and some diagnostic/result fields remain platform-specific;
- unsupported platforms fail or return a documented unsupported state; they do
  not run an unrelated browser implementation as a substitute;
- this SDK version admits a selected checkout and Core only after the current
  native plan's exact protocol, version, feature, capability, method, provider,
  and identity-bound receipt checks all pass;
- that current-build admission does not promise that a future SDK will accept
  this Core or that this SDK will accept a future Core.

## Receipt and generation boundaries

SDK runtime, app releases, bundles, native plans, providers, and artifacts use
identity-bound receipts. A receipt binds the exact location, filesystem
identity, bytes/inventory hashes, policy, toolchain, platform/architecture,
signer/trust result where applicable, and generation. Mutation invalidates the
receipt before bytes or authority change.

Process-local receipts do not authorize reuse across Shell, Core, providers, or
other processes. Cross-process reuse requires an authenticated shared host or
broker with retained handles and peer-process/generation binding.
