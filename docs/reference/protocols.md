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

Managed browser imports have three supported control-plane entrypoints. The CLI
uses `arcane import-map`; Node callers use
`executeOperation('import-map', options)` or
`createToolchain(defaults).importMap(options)`. These are three routes to the
same app-scoped operation, not three import-map formats. There is no exported
`importMapApplication()` function, `generateImportMap()` function, or
`arcane-os/import-map` package subpath.

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

External and modern integrated workspaces keep the same application URLs and a
browser-standard import map. Each selected app owns
`apps/<id>/modules/arcane.importmap.json`; the exact canonical JSON is also
embedded in its HTML entry as a managed `<script type="importmap"
data-arcane-import-map>`. The map follows `<base>` and precedes module scripts,
classic scripts, and module preloads, so application code can use stable named
imports such as:

```javascript
import ollama from 'arcane/Ollama';
```

The authenticated physical-v1 tree lives entirely beneath `arcane/`. It
contains 155 pinned Arcane runtime files plus 18 SDK browser-runtime files:
173 files in all. Runtime `strong-type` 1.1 stays under
`arcane/dependencies/strong-type/`; the focused SDK event surface lives under
`arcane/sdk/`, with `event-pubsub` 6.1 and its sibling `strong-type` 2.0 under
`arcane/sdk/dependencies/`. This URL-key separation prevents the runtime and SDK
dependency versions from aliasing one another. Development serves the selected
app plus that authenticated tree. Packaging copies the same map, app entry, and
physical bytes into `dist/<id>`; targets never resolve through the consumer
workspace's root `node_modules/`.

In SDK `0.1.1`, the generated map has exactly 86 entries: 73 named
`arcane/*` modules, nine `arcane/entities/*` modules, and these four focused or
compatibility mappings:

| Browser specifier | Physical target |
| --- | --- |
| `arcane-os/event-manager` | `./arcane/sdk/event-manager.mjs` |
| `arcane-os/ai/browser-wasm` | `./arcane/sdk/ai/browser-wasm.mjs` |
| `event-pubsub` | `./arcane/sdk/dependencies/event-pubsub/index.js` |
| `./node_modules/strong-type/index.js` | `./arcane/dependencies/strong-type/index.js` |

There is no `arcane-os` package-root mapping, bare `strong-type` mapping, or
catch-all `arcane/` prefix. Host-internal `CaseEvidenceIndexer.js` is explicitly
excluded; classic scripts, workers, stylesheets, and other non-ESM assets use
their documented URL or host loading contract rather than invented package
bindings.

The imported module can be pure browser logic, standard-Web-API logic, or a
client of `globalThis.Arcane`. Import-map resolution is not a new Arcane wire
protocol, Core capability, network authority, or provider fallback. Import
transport and host RPC remain separate layers.

The canonical integrated-legacy Arcane OS root is the documented exception. It
retains its physical `/arcane` and `/node_modules/strong-type` routes, returns
an `integrated-legacy` skip receipt, and does not create the managed map pair.

<details>
<summary>Refresh lifecycle and two-file commit behavior</summary>

Scaffolding (`new` and `init`) creates the map. `dev` refreshes once before
binding. Non-dry-run `package`, browser `build`, and paired native packaging
refresh before collecting source. `test`, `check`, `verify`, `bundle`, and
browser `run` do not refresh. Dry-run packaging/build validates an existing map
without rewriting it, and `import-map` itself has no supported dry-run.

Generation stages the artifact and HTML entry beside their destinations,
checks directory and file identity under the workspace-operation lock, and
uses backups to restore the prior pair after a handled pre-commit failure.
Success reports `committed: true` and SHA-256/byte-length records for both
files. Cleanup failures after commit remain warnings on the valid receipt;
packaging rejects them rather than publishing ambiguous state. This is a
bounded handled-error transaction, not a claim of one filesystem-atomic rename
for both files and not a durable crash journal.

No app watches, polls, downloads, or self-updates this map. An active operation's
heartbeat is event telemetry only and never regenerates browser state.

</details>

<details>
<summary>SDK browser-runtime admission and exact receipt fields</summary>

`arcane.lock.json.sdkBrowserRuntime` persists the trusted manifest path,
`manifestSha256`, `contentSha256`, `builder`, `sdkVersion`, and `source` record.
For SDK `0.1.1` those identities are:

```text
manifest: node_modules/arcane-os/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json
manifestSha256: 33396b3d35322b784929270e7ca0a2a8b31d899c6e77bcb227edc95b37d0ae7d
contentSha256: 5e03f45a732db51cb5a2b2193cc79ecda34501d07a9b2e82e794e5fa37d55d00
builder: arcane-sdk-browser-runtime-v1
sdkVersion: 0.1.1
source.protocol: arcane-sdk-browser-runtime/1
source.browserEntry: arcane-os/event-manager
```

The `source` record also binds the `arcane-os-sdk` authority/repository and the
exact `event-pubsub` 6.1.0 and `strong-type` 2.0.0 package identities. Before a
workspace tree is admitted, the same-process verifier returns
`schemaVersion`, `kind`, `canonicalLocation`, `rootIdentity`, `manifestPath`,
`manifestSha256`, `manifestIdentity`, `builder`, `sdkVersion`, `source`,
`files`, `fileCount`, `totalBytes`, `contentSha256`, `identities`,
`sourceIdentities`, and `directories`. Those object-identity-bound verifier
receipts are authority inside the issuing process; reconstructing the same JSON
does not recreate authority.

</details>

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

`arcane/AI` can use an explicitly selected and configured cloud
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

SDK runtime, app releases, import-map artifact/entry pairs, bundles, native
plans, providers, and artifacts use identity-bound receipts. The import-map
receipt binds each committed relative path, byte length, and SHA-256 in
addition to its exact imports, entry count, exclusions, and cleanup state. A
runtime or release receipt binds the exact location, filesystem identity,
bytes/inventory hashes, policy, toolchain, platform/architecture, signer/trust
result where applicable, and generation. Mutation invalidates the receipt
before bytes or authority change.

Process-local receipts do not authorize reuse across Shell, Core, providers, or
other processes. Cross-process reuse requires an authenticated shared host or
broker with retained handles and peer-process/generation binding.
