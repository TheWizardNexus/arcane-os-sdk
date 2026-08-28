# Protocol and host architecture

This is the deep reference behind the compact availability notes elsewhere.
Application developers should start with the
[availability and normalization guide](availability-and-normalization.md), call
one documented API, and treat the protocols below as implementation detail.

## Layer map

```text
application code
  |-- Node SDK API ----------------- arcane-cli-events/1 + SDK receipts
  |-- EventManager ----------------- synchronous bus + arcane-event-stack/1
  |-- browser-local AI ------------- WebGPU/WASM/Workers/DBOPFS; no Core grant
  `-- globalThis.Arcane
        |-- development host -------- development HTTP bridge
        |-- Microsoft NT native ----- WebView2 host bridge
        |-- Linux native ------------ WebKitGTK host bridge
        `-- Android native ---------- Android WebView message bridge
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

## Installed SDK runtime materialization

`materializeInstalledSdkRuntime()` is the Node entrypoint for refreshing one
external workspace's checked-in `arcane/` projection from its one exact
installed SDK declaration. Import the function through the dependency key that
the workspace actually declares: `arcane-os` for the canonical package name or,
for example, `arcane-sdk` for the exact `npm:arcane-os@<version>` alias. No
application- or Arcane OS-local copier owns this operation.

The operation resolves that declaration again while holding the shared
workspace-operation lock, authenticates the physical package plus its runtime
and browser-runtime receipts, derives the destination inventory dynamically,
and returns one of three statuses:

- `created` when no prior `arcane/` projection or persistent receipt existed;
- `reused` only after the current process reauthenticates the recorded physical
  package, both source receipts, and every destination byte;
- `refreshed` when a safe legacy projection or an authenticated older generation
  is replaced.

Each committed generation writes the canonical workspace-local receipt
`.arcane/installed-sdk-runtime.json`. Its
`arcane-installed-sdk-runtime-projection` schema binds a UUID generation, the
workspace location identity, declared dependency name/group/specifier and
package source, physical package location/name/version/identity, both source
receipt identities and content hashes, and the exact projected path/byte/hash
inventory. The file is durable evidence, not standalone authority: a later
process must authenticate it against the current physical package, freshly
issued source receipts, and the complete destination tree before reporting
`reused`.

Creation and refresh write and authenticate a complete staging tree and staged
receipt before the commit boundary. Refresh moves the prior tree and receipt to
owned backups, installs the new pair without invoking callbacks or observing
cancellation inside that bounded commit, and restores the prior pair if commit
or post-commit verification fails. Cancellation remains effective through the
last pre-commit check; after commit begins the operation finishes verification
or rollback. Successful whole-tree replacement removes bytes absent from the
new dynamic inventory. Symbolic links, non-files, malformed receipts, receipt
tampering, unsafe paths, and corrupt selected source bytes remain errors rather
than refresh inputs.

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

The authenticated physical-v1 tree lives entirely beneath `arcane/`. SDK
`0.3.1` projects it from two canonical release receipts:

| Canonical receipt | Source authority and protocol | Receipt inventory |
| --- | --- | --- |
| `runtime/ARCANE_RUNTIME_RELEASE.json` | `sdk-canonical`; `arcane/1`; builder `arcane-sdk-runtime-v1` | 161 files; 4,161,715 bytes; content SHA-256 `9ed39694d9f286e0994404a82fb6002c3ba48be0d085a6b68d51c7facc17c56f` |
| `browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json` | `arcane-os-sdk`; `arcane-sdk-browser-runtime/1`; builder `arcane-sdk-browser-runtime-v1` | 26 files; 9,554,968 bytes; content SHA-256 `1493497265c330507abed847e52e65dc2ce22c15efaf5646ed7ae544b107ad6f` |

The runtime receipt is the current byte authority. Its Arcane OS
`c540014afe69f14cf5ae60493b7295f36dbcec64` / bundle `0.8.12` record is
`legacyProjection` provenance, not a second or newer runtime authority. The
browser receipt binds `event-pubsub` `6.1.0`, `strong-type` `2.0.0`, and
`@wllama/wllama` `3.6.0`, as well as the browser entry
`arcane-os/event-manager`. Runtime dependencies stay under
`arcane/dependencies/`; the SDK event and browser-AI closure stays under
`arcane/sdk/`. This URL-key separation prevents runtime and SDK dependency
versions from aliasing one another.

Those two receipt inventories contain 187 entries in total. That sum is a
release-inventory fact, not an import-map entry count and not an assertion about
one maintained example. The `0.3.1` map deterministically roots every admitted
top-level runtime ESM plus the authenticated SDK browser roots, then follows
those roots for runtime entities and dependency compatibility. Application
source imports do not select a fixed entry count. Its public operation receipt is the
authority for the exact `imports`, `entryCount`, and `excludedModules`;
reached-file traversal is internal and is not exposed in that receipt. The
managed graph exposes `arcane-os/event-manager`, `arcane-os/ai/browser-wasm`,
and `arcane-os/ai/browser-speech`; dependency compatibility mappings are added
only when authenticated runtime or SDK root traversal observes them.

The focused physical targets remain stable when their bindings are reached:

| Browser specifier | Physical target |
| --- | --- |
| `arcane-os/event-manager` | `./arcane/sdk/event-manager.mjs` |
| `arcane-os/ai/browser-wasm` | `./arcane/sdk/ai/browser-wasm.mjs` |
| `arcane-os/ai/browser-speech` | `./arcane/sdk/ai/browser-speech.mjs` |
| `event-pubsub` | `./arcane/sdk/dependencies/event-pubsub/index.js` |
| `./node_modules/strong-type/index.js` | `./arcane/dependencies/strong-type/index.js` |

There is no `arcane-os` package-root mapping, bare `strong-type` mapping, or
catch-all `arcane/` prefix. Host-internal `CaseEvidenceIndexer.js` is explicitly
excluded; classic scripts, workers, stylesheets, and other non-ESM assets use
their documented URL or host loading contract rather than invented package
bindings. Development serves the selected app plus the authenticated tree.
Packaging copies the same map, app entry, and physical bytes into `dist/<id>`;
targets never resolve through the consumer workspace's root `node_modules/`.

`generateImportMap()` is an internal toolchain operation, not a package export.
Its package path accepts the configured entry plus the deterministic included
`.html`/`.htm` document inventory. One transaction writes the artifact and the
same managed JSON into every admitted document. The receipt binds
`documentPaths`, `documentCount`, and `files`: artifact first, configured entry
second, then additional documents as `role:"document"`. The public CLI keeps
its existing two-option command and supplies only the selected entry; packaging
owns multi-page discovery.

An external package and development server expose the authenticated runtime
inventory at `/ARCANE_RUNTIME_PROJECTION.json`:

```javascript
{
  schemaVersion: 1,
  kind: 'arcane-app-runtime-projection',
  sdkVersion,
  pathPrefix: 'arcane/',
  fileCount,
  totalBytes,
  contentSha256,
  files: [{path, bytes, sha256}]
}
```

The projection contains public paths relative to its declared
`pathPrefix:'arcane/'` (for example, `modules/...` and `sdk/...`), byte lengths,
and SHA-256 values and is itself bound by the packaged release inventory. It does
not expose the private `/ARCANE_APP_RELEASE.json` or replace the underlying
runtime/browser receipts. Missing, changed, forged, duplicated, or internally
inconsistent projection data fails `ARCANE_RUNTIME_PROJECTION_INVALID`.

External `validateWorkspace()` results also expose a frozen `sdkInstallation`
authority with exactly `dependencyName`, `packageSource`,
`canonicalPackageRoot`, `packageName`, `packageVersion`, `runtimeRoot`,
`browserRuntimeRoot`, `runtimeManifest`, and `browserRuntimeManifest`. A
workspace may use the canonical dependency name or one exact npm alias such as
`npm:arcane-os@0.3.1`; the physical package manifest must still identify
exactly as `arcane-os@0.3.1`. Canonical-plus-alias duplicates, multiple aliases,
links/junctions, indirect package roots, or version drift fail closed.

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
<summary>SDK 0.3.1 browser-runtime admission and exact receipt fields</summary>

`arcane.lock.json.sdkBrowserRuntime` persists the trusted manifest path,
`manifestSha256`, `contentSha256`, `builder`, `sdkVersion`, and `source` record.
For SDK `0.3.1`, the manifest itself records:

```text
manifest: node_modules/arcane-os/browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json
fileCount: 26
totalBytes: 9554968
contentSha256: 1493497265c330507abed847e52e65dc2ce22c15efaf5646ed7ae544b107ad6f
builder: arcane-sdk-browser-runtime-v1
sdkVersion: 0.3.1
source.protocol: arcane-sdk-browser-runtime/1
source.browserEntry: arcane-os/event-manager
```

The verifier computes `manifestSha256` over the exact installed manifest and
binds that value in its process-local receipt and the workspace lock; it must
not be substituted with `contentSha256`. The `source` record also binds the
`arcane-os-sdk` authority/repository and the exact `event-pubsub` 6.1.0,
`strong-type` 2.0.0, and `@wllama/wllama` 3.6.0 package identities. Before a
workspace tree is admitted, the same-process verifier returns
`schemaVersion`, `kind`, `canonicalLocation`, `rootIdentity`, `manifestPath`,
`manifestSha256`, `manifestIdentity`, `builder`, `sdkVersion`, `source`,
`files`, `fileCount`, `totalBytes`, `contentSha256`, `identities`,
`sourceIdentities`, and `directories`. Those object-identity-bound verifier
receipts are authority inside the issuing process; reconstructing the same JSON
does not recreate authority.

</details>

## Portable AI provider runtime

Application code should select a normalized role, not an internal protocol.
The exported
[`getAIProviderRuntime()` singleton](runtime-modules.md#aiproviderruntimejs)
comes from authenticated runtime bytes and owns independent `llm`, `stt`, and
`tts` selections. SDK `0.3.1` ships browser-WASM LLM and browser
speech provider/2 adapters and also adapts selected legacy OpenAI LLM/STT/TTS,
Core-backed Ollama LLM, and admitted Core speech STT/TTS routes into provider/2;
other native, Core, or cloud routes require an externally supplied compatible
adapter. The singleton itself is not an authentication or capability token. It
normalizes inspection, model authority,
load/unload/dispose, cancellation, stream cleanup, status, and startup
barriers. Each selected provider retains its real execution requirements.
`localOnly` fails closed, and failure in one role never authorizes a Core,
cloud, or different-provider fallback.

For a browser-only LLM,
[`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) exposes `createArcaneAI()`
and an adapter into the same provider-neutral lifecycle. For browser speech,
[`arcane-os/ai/browser-speech`](ai/browser-speech.md) creates independent
Whisper STT and Kokoro TTS providers that register directly with the normalized
runtime. The SDK supplies mechanism; applications retain model/runtime choice,
provenance, licenses, prompts, tools, voices, and disclosure policy.

### Browser-WASM LLM lifecycle

The shipped browser receipt contains the authenticated Wllama JavaScript/WASM
engine and its provider/cache/controller mechanism. It contains no model
weights, default model catalog, CDN fallback, native provider, speech model, or
application profile. The caller supplies each model as a source authority with
a nonempty ordered file list, so monolithic and split GGUF models use the same
contract. HTTPS redirects are followed and the final HTTPS URL is recorded.
Exact bytes are bound only by the optional expected byte lengths and SHA-256
values whose matching fieldwise security checks are enabled.

On load, the DBOPFS store admits all ordered members and commits the completion
manifest last. A normal cache miss may fetch only the caller-supplied immutable
HTTPS sources; `offline:true` performs no model request and admits only a
compatible completed cache, otherwise it rejects with
`ARCANE_AI_MODEL_OFFLINE_MISS`. Unload releases the active Wllama session but
does not silently delete the app-owned cache.

SDK `0.3.1` requires WebGPU. Load requests full offload with exactly 99,999 GPU
layers and admits the model only after observing an adapter, full layer offload,
buffer and queue work, and a settled fence. `navigator.gpu` presence alone is
not readiness. There is no CPU fallback, partial-offload success mode, or
silent switch to native/Core/cloud inference.

### Browser speech lifecycle

The browser-speech package contains plain-JavaScript authority, DBOPFS store,
provider, client, and Worker machinery. It redistributes no Whisper, Kokoro,
ONNX, model, voice, third-party license, or corresponding-source payload.
Default warn-first integrations use `createBrowserSpeechAuthority()` with a
version-pinned npm/package runtime entry and optional upstream `wasmPaths`;
the selected runtime then downloads models and voices through its normal
provider fetch and browser cache behavior after explicit `load()`.

`createBrowserSpeechArtifactGraph()` remains the explicit secure/offline option.
It declares one caller-selected immutable closure with an explicit entrypoint
and every auxiliary ESM, WASM, model, data, and voice file bound by canonical
path, materialized media type, optional source media type, byte length, SHA-256,
immutable starting source/revision, optional redirect-final-origin inventory,
license declaration, and canonical graph identity.

Graph construction rejects ambiguous paths and routes, mutable source
authorities, undeclared or unmatched static imports, dynamic imports, fetches,
Cache Storage opens, module Workers, undeclared executable-string construction,
and incomplete file reachability. `edges.cacheOpens[]` binds the exact module,
occurrence, policy, cache name, and readable non-JavaScript target paths. The
two admitted transforms are the exact audited `Function("return this")()`
compatibility site and typed-array constructor sites later bound to intrinsic
typed-array prototypes.

A source download rejects redirects by default. A file may opt in with a
nonempty, graph-identity-bound `redirectFinalOrigins` inventory; only that file
uses Fetch redirect following, and the final response must expose one declared
HTTPS origin without credentials or a fragment. The immutable starting URL
remains the source authority, and the final path, query, or signed/expiring URL
is never persisted or admitted as authority. Fetch exposes only the final CORS
response, so browser code cannot inspect or authenticate intermediate redirect
hops. The store then checks the declared source media type, exact length, and
SHA-256, persists and rehashes every file, rescans the closed module graph, and
commits the completion manifest last.

A valid warm admission performs no source request; it rehashes and rescans every
cached file and returns `artifact-graph-dbopfs-cache-verified`. Strict
`offline:true` never calls the source fetch function and returns only
`artifact-graph-offline-dbopfs-cache-verified`; a miss rejects with
`ARCANE_AI_ARTIFACT_GRAPH_OFFLINE_CACHE_MISS` /
`artifact-graph-offline-cache-miss`. Cold and warm admissions are exactly
`artifact-graph-network-dbopfs-verified` and
`artifact-graph-dbopfs-cache-verified`. Both cached paths bind redirect origins
and source media type through graph/manifest identity but never reuse a prior
final URL.

Every admission then uses module-captured native Blob URL functions, ignoring
the legacy caller `objectUrlFactory`, and reads back each unique `blob:` URL to
verify its exact identity, media type, byte length, and SHA-256 before
execution. A fresh cryptographic guard capability binds every rewritten graph
call for that materialization; it is not caller input, persisted authority, or
part of the graph identity.

The speech Worker establishes a private `MessageChannel` on its first load and
routes subsequent request, progress, and cancellation settlement through that
port. In explicit `secure:true` graph mode, scanned runtime edges are rewritten
through one authenticated guard.
Fetch and each declared cache-open edge can read only exact graph routes backed
by already verified object URLs; raw fetch/cache calls and cache writes reject.
The Worker also denies Function-family constructor escape, string timers,
IndexedDB, OPFS, and raw `BroadcastChannel`, `EventSource`, `RTCPeerConnection`,
`ShadowRealm`, `SharedWorker`, `WebSocket`, `WebSocketStream`, `WebTransport`,
`Worker`, `XMLHttpRequest`, `eval`, and `importScripts` capability. Declared
nested module Workers start through the SDK role Worker and receive the same
authenticated graph. Default warn-first operation uses the direct runtime/model
authority instead; these capability restrictions are not installed and the
selected upstream runtime keeps ordinary browser fetch/cache behavior. An exact
secure-graph runtime request alias, including Kokoro's audited
mutable voice request, is a local route to caller-authenticated bytes and is
never a source or network authority.

Worker operations use `arcane-ai-speech-worker/1`. The public Worker client
admits only `load`, `use`, `status`, `unload`, and `dispose`; the transport host
additionally admits only its internal `cancel` control. Every other operation
rejects with code `ARCANE_AI_INVALID_REQUEST`, message
`The speech worker operation is not part of its protocol.`, and role-specific
reason `stt-worker-operation-unknown` or `tts-worker-operation-unknown`.
Failures use the separate
`arcane-ai-speech-worker-error/1` envelope. Its exact own-key set is
`code,message,protocol,reason`, all four must be data properties, and its
registered code, fixed message, reason, role, and operation must agree. A
foreign, incomplete, extra-keyed, accessor-bearing, cross-role, or
cross-operation error envelope is rejected and terminates that role Worker.
Nested module Workers use
`arcane-ai-browser-speech-artifact-module-worker/1` and report bootstrap
rejection only as `artifact-module-worker-bootstrap-rejected`.

The exact redirect and source-media error registry is published in the
[browser-speech reference](ai/browser-speech.md#graph-reasoncode-rule); graph
errors retain the mechanical exact code pairing
`ARCANE_AI_` plus the uppercased, underscore-normalized reason.

Kokoro is configured through `namespace.env.wasmPaths`; Transformers is
configured through `namespace.env.backends.onnx.wasm.wasmPaths`. Warn-first
mode may use a caller-selected version-pinned upstream directory and preserves
the runtime's browser cache. Secure graph mode uses materialized runtime files
and its verified outer cache fields. Optional `numThreads` is caller-owned and
Transformers-STT-only; a Kokoro declaration rejects with
`ARCANE_AI_KOKORO_ENV_NUM_THREADS_FIELD_NOT_EXPOSED` /
`kokoro-env-num-threads-field-not-exposed`. Missing or rejected namespace
shapes fail closed with distinct `*-unavailable` and
`*-assignment-rejected` reasons for each verified setting; the Worker never
substitutes a different namespace. The caller also owns dtype, STT input sample
rate, TTS output sample rate, default voice, and the complete voice inventory;
the SDK selects no hardware default, runtime, model, or fallback.

The SDK is not the distributor of the selected upstream speech packages or
provider assets and does not republish their legal/source payloads. The
component record at `browser-runtime/ai/ARCANE_AI_BROWSER_SPEECH_COMPONENTS.json`
documents resolution only; it is not an execution or publication gate.

Whisper `stt` and Kokoro `tts` each own catalog, inspect, status, load, request,
unload, and dispose state. They load, cancel, unload, fail, and recover
independently from the LLM and from one another. Cancellation after Worker use
begins terminates that role's Worker slot and returns the provider to unloaded;
a later use must load it again. If shared STT `Blob` decoding is cancelled
before Worker use, the request rejects while the loaded provider remains ready.
Speech failure neither disables text chat nor retries through another local,
native, or cloud provider. The provider/Worker layer is event-neutral: it
exposes promises, `AbortSignal`, precise lifecycle/status records, and one
caller progress callback, but owns no event bus or listener registry. Progress
is the provider-neutral record
`{phase,completed,total,unit,heartbeat}`; role is encoded in Worker phase names,
not added as a second field.

### Persistent chat and document context

The SDK runtime owns
[`DBOPFSDocumentLibrary`](runtime-modules.md#dbopfsdocumentlibraryjs),
[`DocumentLexicalSearch`](runtime-modules.md#documentlexicalsearchjs), and
[`PersistentAIChatSession`](runtime-modules.md#persistentaichatsessionjs).
Document bootstrap is explicit and schema-driven, commits a completed
generation last, and returns bounded search results with partial read failures
disclosed. `evaluate()` can instead score a caller-owned source set without
persisting its bodies, under separate corpus/scoring/output/document budgets.
A chat session never searches the corpus unless the application
deliberately wires a document context builder into the request; generated
document context remains labeled untrusted.

Persistent chat maintains bounded live model context plus `ChatEntity`
history/memory according to the caller's persistence choice. A turn with
`persist:false` remains coherent in the live session without entering durable
history or memory. `createArcaneAI(...).createChatSession(options)` binds the
session and automatic memory work to that same selected LLM controller; it does
not select a second provider or storage fallback.

### Cancellation and structural tools

Cancellation is part of the provider lifecycle, not just a UI decision.
`AbortSignal`, the normalized role cancel operation, and stream-handle
`cancel(reason)` propagate to the selected provider. Browser-WASM inference
requires positive llama cancellation acknowledgement when cancellation is
required. Browser speech cancellation terminates a Worker only after Worker use
has begun; cancellation during shared browser decoding leaves the loaded Worker
ready. Unload always cancels active role work before releasing that role's
execution state, and superseded late results are rejected rather than committed
or retried through another provider.

Interactive request ownership is latest-request-wins independently for each
role. A new valid request that reaches admission aborts the active role request
and waits for its provider promise settlement; stream replacement additionally
requires confirmed bounded handle cleanup. Only the newest waiting request may
start after settlement, and request-specific generations prevent superseded
callbacks from clearing or restoring newer state. The runtime revalidates
selected-provider readiness and never reloads, switches, or falls back
implicitly. Generic provider-promise settlement is not a claim that underlying
work stopped; only a provider's documented positive acknowledgement or
destructive worker teardown can prove that stronger fact.

`startAIRuntime({startTranscription:false})` is the default startup boundary for
STT. It declines to request a startup STT load; it does not unload a role already
started through another explicit lifecycle action. A selected unloaded
transcription provider remains selected and unloaded until a user lifecycle
intent or explicit `startTranscription:true` opt-in asks the provider owner to
load it. Neither state observation nor either shared speech component imports a
model or selects a fallback. `speech.html` and `voice-transcription.html` consume
one shared `createSTTActivationController()` contract for selected, unloaded,
loading, unloading, error, and ready presentation plus cancelable user intent.
Both keep capture fail-closed until sticky STT state is exactly ready.

Each shared speech component owns an `AbortController` for its STT request and
passes its signal through `AI.fetchSTT()`. `voice-transcription.html` also adds
that signal to the existing injected `transcribe(file,context)` callback
context. Cancel, readiness loss, superseding capture, and component teardown
abort the owned signal and suppress late delivery. Whether the provider's
underlying computation stops remains governed by its own cancellation contract.
User TTS unmute calls `AI.setSpeechMuted(false)` before
or with its load intent so the runtime records the unmuted lifecycle preference;
mute calls `AI.setSpeechMuted(true)`, cancels active synthesis, and unloads TTS.
The selected TTS model catalog owns `defaultVoice`. AI.js uses a saved OpenAI
voice only for the OpenAI route and never forwards it to Core or browser Kokoro.

LLM tool calls are structural result data only. The SDK never executes a
handler. The application owns schema validation, authorization, side-effect
policy, dispatch, and the matching tool-result turn.

<details>
<summary>Portable AI protocol disclosure</summary>

The normalized runtime protocol is `arcane-ai-runtime/2`; registered adapters
implement `arcane-ai-provider/2` and must prove matching model authority before
load. The browser-WASM component receipt is `arcane-ai-browser-wasm/2`; its
direct controller adapter uses `arcane-ai-adapter/1`, and
`adaptV1LlmProvider()` projects that surface into the provider/2 LLM role.
Browser speech stores identify themselves as
`arcane-ai-browser-speech-artifacts/1`. Legacy authorities retain
`arcane-ai-model-authority/1`. Authenticated browser-speech graphs use
`arcane-ai-browser-speech-artifact-graph/1`, kind
`browser-speech-authenticated-artifact-graph`, and a canonical SHA-256 graph
identity. Those identifiers describe validation and lifecycle contracts; none
is by itself a capability grant, publisher-authenticity claim, or complete
cache receipt.

These identifiers normalize lifecycle records. They do not erase provider
availability: browser providers still require their browser capabilities,
native providers still require an admitted host and Core method, and cloud
providers still require explicit selection, network policy, and credentials.

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
