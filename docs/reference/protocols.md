# Protocol and host architecture

This is the deep reference behind the compact availability notes elsewhere.
Application developers should start with the
[availability and normalization guide](availability-and-normalization.md), call
one documented API, and treat the protocols below as implementation detail.

## Layer map

```text
application code
  |-- Node SDK API ----------------- arcane-cli-events/1 + SDK results
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
- `arcane-native-build-plan/1` for single-attempt native plans;
- `arcane-native-builder/1` for injected native builders;
- `arcane-integrated-toolchain/1` for the fixed integrated shared/Core provider.

These protocols normalize orchestration and results. They do not normalize a
Windows EXE, Linux DEB, Android APK, and portable directory into the same
artifact kind.

Managed browser imports have three supported control-plane entrypoints. The CLI
uses `arcane import-map`; Node callers use
`executeOperation('import-map', options)` or
`createToolchain(defaults).importMap(options)`. These are three routes to the
same app-scoped operation, not three import-map formats. Each route discovers
the selected descriptor's directly navigable admitted `.html`/`.htm` documents
through the package include/exclude rules and writes one canonical map to the
artifact plus every such document. The current marker is exactly one matching
`meta[name="arcane-app-id"]`; an unmarked secondary page with an active `base`
remains admitted for patch compatibility. Wrong or duplicate explicit identity
fails, and the selected page then must pass exact path-relative base validation.
Included HTML with neither signal is a component fragment and remains a
complete package file.
`arcane-os/preference-store` and
`arcane-os/speech-playback` are the two portable runtime subpaths: Node package
exports and managed browser keys both resolve directly to the canonical runtime
module namespaces, while `arcane/PreferenceStore` and
`arcane/SpeechPlayback` remain browser compatibility names. There is no exported
`importMapApplication()` function, `generateImportMap()` function, or
`arcane-os/import-map` package subpath.

The application dependency boundary is conditional. Only an application that
actually consumes Arcane declares one exact published `arcane-os` version in
its own `package.json` and resolves it through that project's normal install
into its own `node_modules`. An application that does not currently consume
Arcane adds no `arcane-os` dependency solely because of this rule; the user or
governing task may direct that application to adopt Arcane later, at which point
the same app-owned package, install, projection, and artifact boundary applies.
An Arcane consumer never depends on a global install, link or symlink, or
another Arcane OS/SDK checkout. The explicit `--sdk-runtime-source` checkout is
a temporary development server input only: its path and mutable authority are
not persisted in application package metadata, lockfiles, managed import maps,
or `dist`. Distribution instead uses the app's installed package and
materializes the complete required SDK runtime,
browser-runtime, and managed-import-map closure inside that app's own artifact.
No application polls for SDK changes.

## Installed SDK runtime materialization

`materializeInstalledSdkRuntime()` is the Node entrypoint for refreshing one
external workspace's checked-in `arcane/` projection from its one exact
installed SDK declaration. Import the function through the dependency key that
the workspace actually declares: `arcane-os` for the canonical package name or,
for example, `arcane-sdk` for the exact `npm:arcane-os@<version>` alias. No
application- or Arcane OS-local copier owns this operation.

The operation resolves that declaration while holding the shared
workspace-operation lock, copies the complete runtime and browser-runtime
content, and returns the installed-package location plus the materialized
workspace runtime paths. After the complete runtime replacement, it writes or
replaces semantic `arcane.lock.json` metadata from the actual installed
dependency name, package name, package version, and alias source.

Materialization writes a complete staging tree before the commit boundary,
moves any prior runtime to an owned backup, installs the new tree, and restores
the prior tree if commit fails. Cancellation remains effective through the last
pre-commit check. Successful whole-tree replacement removes paths absent from
the selected runtime content. The lock document describes the selected
installation and projected roots; it is not a content-identity or admission
record.

`upgradeApplication()` and `arcane upgrade` run the application's ordinary
`npm upgrade` command. They do not independently reconcile the installed SDK
projection, semantic Arcane lock, or managed import map.

## Central events and time-travel data

`arcane-os/event-manager` is host-neutral JavaScript. Its live event path is
synchronous, in-process `event-pubsub`; it does not select WebView2,
WebKitGTK, Android, HTTP, Core, or a kernel boundary. Optional history uses the
`arcane-event-stack/1` data format. That protocol names a diagnostic document,
not a network channel and not the `arcane/1` Core RPC
protocol.

Live listeners receive the original arguments. Recording separately snapshots
complete payloads and metadata while redacting credentials and explicitly
protected private fields. Exported stacks can be moved between Node and browser
hosts because `parseEventStack()` rejects genuinely malformed data before
playback. Review mode emits records, events mode deliberately
re-emits recorded event types, and neither mode restores external host side
effects or DOM state.

<details>
<summary>Event-stack structure and privacy boundary</summary>

Each document carries `protocol`, `sessionId`, `createdAt`, and ordered
`events`. Each record repeats the protocol/session and carries sequence,
timing, nesting/causation, source/category, payload, metadata, status, and
failure evidence. Recording retains the complete selected session until the
caller clears it or disables recording. Import rejects genuinely malformed or
unsafe structure and grants no Core capability or provider authority.

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

The physical-v1 tree lives entirely beneath `arcane/`. SDK `0.3.4` projects the
complete canonical runtime and browser runtime selected by the installed SDK
package. Runtime dependencies stay under
`arcane/dependencies/`; the SDK event and browser-AI closure stays under
`arcane/sdk/`. This URL-key separation prevents runtime and SDK dependency
versions from aliasing one another.

The physical workspace route keeps its established route count and order. The
external route includes `components`, `css`, `dependencies`, `entities`, `img`,
`modules`, and `sdk`, followed by optional trailing `security` when that
directory exists; its external license route remains second. The modern
integrated physical route uses the same ordered include list in its one route.
Omitting only that final optional entry is compatible. Removing, reordering, or
renaming any preceding entry changes the physical contract.

The `0.3.4` map derives its complete entries from the selected runtime graph;
application source imports do not select a fixed entry count. The operation
result reports `imports`, `entryCount`, and `excludedModules`; reached-file
traversal remains internal. The
managed graph exposes `arcane-os/event-manager`, `arcane-os/ai/browser-wasm`,
`arcane-os/ai/browser-speech`, `arcane-os/preference-store`, and
`arcane-os/speech-playback`; dependency compatibility mappings are added when
runtime or SDK root traversal observes them.

The focused physical targets remain stable when their bindings are reached:

| Browser specifier | Physical target |
| --- | --- |
| `arcane-os/event-manager` | `./arcane/sdk/event-manager.mjs` |
| `arcane-os/ai/browser-wasm` | `./arcane/sdk/ai/browser-wasm.mjs` |
| `arcane-os/ai/browser-speech` | `./arcane/sdk/ai/browser-speech.mjs` |
| `arcane-os/preference-store` | `./arcane/modules/PreferenceStore.js` |
| `arcane-os/speech-playback` | `./arcane/modules/SpeechPlayback.js` |
| `event-pubsub` | `./arcane/sdk/dependencies/event-pubsub/index.js` |
| `./node_modules/strong-type/index.js` | `./arcane/dependencies/strong-type/index.js` |

There is no `arcane-os` package-root mapping, bare `strong-type` mapping, or
catch-all `arcane/` prefix. Classic scripts, workers, stylesheets, and other
non-ESM assets use their documented URL or host loading contract rather than
invented package bindings. Development serves the selected app plus the
complete selected tree.
Packaging copies the same map, app entry, and physical content into `dist/<id>`;
targets never resolve through the consumer workspace's root `node_modules/`.
The two lowercase static runtime package specifiers above are also exact npm
package exports, so Node and managed-browser source can share those specifiers
without data URLs, copied modules, or a consumer-owned loader.

`generateImportMap()` is an internal toolchain operation, not a package export.
The shared app-document owner derives the configured entry plus the
deterministic admitted `.html`/`.htm` inventory from the descriptor's package
include/exclude rules. `import-map`, development, upgrade, and packaging all
reuse that discovery. One transaction writes the artifact and the same managed
JSON into every selected document. The result reports
`documentPaths`, `documentCount`, and `files`: artifact first, configured entry
second, then additional documents as `role:"document"`. The public CLI keeps
its existing two-option command; callers never maintain a separate page list.

An external package and development server expose the runtime
inventory at `/ARCANE_RUNTIME_PROJECTION.json`:

```javascript
{
  schemaVersion: 1,
  kind: 'arcane-app-runtime-projection',
  sdkVersion,
  pathPrefix: 'arcane/',
  files: [{path}]
}
```

The projection contains the complete public paths relative to its declared
`pathPrefix:'arcane/'` (for example, `modules/...` and `sdk/...`). It does not
expose the private `/ARCANE_APP_RELEASE.json`. Genuinely malformed projection
data fails `ARCANE_RUNTIME_PROJECTION_INVALID`.

External `validateWorkspace()` results also expose `sdkInstallation` with
exactly `dependencyName`, `packageSource`,
`canonicalPackageRoot`, `packageName`, `packageVersion`, `runtimeRoot`,
and `browserRuntimeRoot`. A
workspace may use the canonical dependency name or one exact npm alias such as
`npm:arcane-os@0.3.4`; the physical package manifest must still identify
exactly as `arcane-os@0.3.4`. Canonical-plus-alias duplicates, multiple aliases,
links/junctions, indirect package roots, or version drift are reported.

For external workspaces, `arcane dev` serves the projected `arcane/` root,
including `arcane/sdk` and `arcane/dependencies`, alongside the selected
application. Integrated workspaces retain their configured physical routes.
The explicit live-source development mapping remains a separate development
path and does not rewrite the installed projection.

The imported module can be pure browser logic, standard-Web-API logic, or a
client of `globalThis.Arcane`. Import-map resolution is not a new Arcane wire
protocol, Core capability, network authority, or provider fallback. Import
transport and host RPC remain separate layers.

The canonical integrated-legacy Arcane OS root is the documented exception. It
retains its physical `/arcane` and `/node_modules/strong-type` routes, returns
an `integrated-legacy` skip result, and does not create the managed map pair.

<details>
<summary>Refresh lifecycle and managed-file commit behavior</summary>

Scaffolding (`new` and `init`) creates the map. `dev` refreshes once before
binding. `import-map` and `upgrade` refresh every admitted document explicitly.
Non-dry-run `package`, browser `build`, and paired native packaging refresh
before collecting source. Packaging does not run tests or checks automatically.
Explicit `test` and `check` operations read the existing map without rewriting it;
`verify`, `bundle`, and browser `run` do not refresh. Dry-run packaging/build
validates an existing map without rewriting it, and `import-map` itself has no
supported dry-run.

Generation stages the artifact and every selected HTML document beside their
destinations and uses backups to restore the prior managed files after a
handled pre-commit failure. Success reports `committed: true` and the complete
managed path inventory. Cleanup failures after commit remain warnings. This is
a handled-error transaction, not a claim of one filesystem-atomic rename for
all files and not a durable crash journal.

When tests are explicitly selected, external app tests receive an
`arcane-test-import-map/1` context for that app's managed map. Each isolated
Node child uses the existing loader for managed names and URL-like compatibility
keys. Materialized
modules such as `arcane/TimeGuard` and `arcane/DBOPFS` resolve their canonical
`arcane-os/event-manager` self-import through this managed map; raw Node import
of projected `arcane/**` files is not a separate public resolution contract.
Unmapped `arcane/*` and `#arcane/*` names fail
`ARCANE_IMPORT_MAP_UNRESOLVED`; ordinary Node exports and test runs without an
app context retain their existing resolution.

No app watches, polls, downloads, or self-updates this map. An active operation's
heartbeat is event telemetry only and never regenerates browser state.

</details>

## Portable AI provider runtime

Application code should select a normalized role, not an internal protocol.
The exported
[`getAIProviderRuntime()` singleton](runtime-modules.md#aiproviderruntimejs)
comes from the selected runtime and owns independent `llm`, `stt`, and
`tts` selections. SDK `0.5.4` ships browser-WASM LLM and browser
speech provider/2 adapters and also adapts selected TWiN Cloud LLM,
Core-backed Ollama LLM, on-device Whisper STT, and on-device Kokoro TTS routes
into provider/2. There is no cloud speech route;
other native, Core, or cloud routes require an externally supplied compatible
adapter. The singleton itself is not an authentication or capability token. It
normalizes inspection, model authority,
load/unload/dispose, cancellation, stream cleanup, status, and startup
barriers. Each selected provider retains its real execution requirements.
`localOnly` creates no fallback, and failure in one role never authorizes a Core,
cloud, or different-provider fallback.

For a browser-only LLM,
[`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) exposes `createArcaneAI()`
and an adapter into the same provider-neutral lifecycle. For browser speech,
[`arcane-os/ai/browser-speech`](ai/browser-speech.md) creates independent
Whisper STT and Kokoro TTS providers that register directly with the normalized
runtime. The SDK supplies mechanism; applications retain model/runtime choice,
licenses, prompts, tools, voices, and disclosure policy.

### Browser-WASM LLM lifecycle

The shipped browser runtime contains the Wllama JavaScript/WASM engine and its
provider/cache/controller mechanism. It contains no model
weights, default model catalog, CDN fallback, native provider, speech model, or
application profile. The caller supplies each model as a source with
a nonempty ordered file list, so monolithic and split GGUF models use the same
contract. HTTPS redirects are followed and the final HTTPS URL is recorded.
Each member may optionally declare positive `bytes` for progress reporting and
HTTP Range planning. Declared and observed byte measures remain transfer-local
telemetry; they never validate, admit, identify, hash, or decide cache reuse for
model content.

On load, the DBOPFS store preserves descriptor order while one bounded worker
pool fetches split members or ranges within the selected member. A split member
may use one Range worker, allowing an interrupted shard to resume without
multiplying the configured concurrency. Download progress
retains its existing completed-file fields and adds raw aggregate bytes,
remaining bytes, rolling bytes per second, ETA seconds, active transfer
workers, the transfer limit, and the active transfer mode. Chunk-driven changes
are coalesced on a 250 ms cadence; start, plan/total, active-worker, and
completion boundaries may publish immediately. A source member that receives a redirected `200` probes the final URL
directly before reusing the original response as its single-fetch fallback.
Confirmed support uses deterministic OPFS Range parts of roughly 4 MB each, up
to 4,096 parts per member, with bounded active workers; completed parts and
split-model members survive interruption so a retry fetches only missing work.
An incomplete 0.5.3 cache keeps its completed coarse parts and subdivides only
the missing intervals into current small parts. Only unfinished active parts
restart after refresh. Without usable range support
or an observable or declared total it falls back to one full fetch. A normal
cache miss may fetch only the
caller-supplied HTTPS sources; `offline:true` performs no model request and uses
only a compatible completed cache, otherwise it rejects with
`ARCANE_AI_MODEL_OFFLINE_MISS`. Unload releases the active Wllama session but
does not silently delete the app-owned cache. When a complete current model
replaces the exact legacy cache entry, the store attempts to remove the legacy
duplicate; a complete whole member likewise supersedes its resumable fragments.
Cleanup failure is warned without hiding the usable model.

SDK `0.3.4` requires WebGPU. Load requests full offload and waits for the runtime
to report a loaded model. `navigator.gpu` presence alone is
not readiness. There is no CPU fallback, partial-offload success mode, or
silent switch to native/Core/cloud inference.

### Browser speech lifecycle

The browser-speech package contains plain-JavaScript authority, DBOPFS store,
provider, client, and Worker machinery. It redistributes no Whisper, Kokoro,
ONNX, model, voice, third-party license, or corresponding-source payload.
Default upstream integrations use `createBrowserSpeechAuthority()` with a
version-pinned npm/package runtime entry and optional upstream `wasmPaths`;
the selected runtime then downloads models and voices through its normal
provider fetch and browser cache behavior after explicit `load()`.

`createBrowserSpeechArtifactGraph()` is an ordinary materialization descriptor.
Browser speech uses the caller-selected upstream runtime, model, voice, Fetch,
cache, and Worker behavior.

Ordinary module routing preserves bare import specifiers for native import-map
resolution and leaves bare `fetch`, `caches`, and `Worker` calls unchanged when
the module declares a shadowing binding with the same name. Explicit
`globalThis` or `self` calls continue through the materialized-file router.

The speech Worker uses its ordinary global Worker message boundary directly for
requests, results, errors, and cancellation. It creates no private
`MessageChannel` and publishes no Worker progress transport.

Worker operations use `arcane-ai-speech-worker/1`. The public Worker client
supports `load`, `use`, `status`, `unload`, and `dispose`; the transport host
additionally supports its internal `cancel` control. Every other operation
rejects with code `ARCANE_AI_INVALID_REQUEST`, message
`The speech worker operation is not part of its protocol.`, and role-specific
reason `stt-worker-operation-unknown` or `tts-worker-operation-unknown`.
Failures use the separate
`arcane-ai-speech-worker-error/1` envelope. The legacy form has the four data
properties `code,message,protocol,reason`; the current form may add one `cause`
data property containing the complete serialized diagnostic, including cycles.
The protocol, registered code, nonempty message, reason, role, and operation
must agree. A foreign, incomplete, extra-keyed, accessor-bearing, cross-role,
or cross-operation error envelope is rejected and terminates that role Worker.
Nested module Workers use
`arcane-ai-browser-speech-artifact-module-worker/1` and report bootstrap
rejection only as `artifact-module-worker-bootstrap-rejected`.

If the platform cannot clone an exotic `cause`, the Worker keeps the complete
raw failure in its console diagnostics and retries settlement with the legacy
four-field envelope. Nested Workers are terminated during role teardown.

Kokoro is configured through `namespace.env.wasmPaths`; Transformers is
configured through `namespace.env.backends.onnx.wasm.wasmPaths`. Ordinary mode
may use a caller-selected version-pinned upstream directory and preserves
the runtime's browser cache. Optional `numThreads` is caller-owned and
Transformers-STT-only; a Kokoro declaration rejects with
`ARCANE_AI_KOKORO_ENV_NUM_THREADS_FIELD_NOT_EXPOSED` /
`kokoro-env-num-threads-field-not-exposed`. Missing or rejected namespace
shapes report distinct `*-unavailable` and
`*-assignment-rejected` reasons for each setting; the Worker never
substitutes a different namespace. The caller also owns dtype, STT input sample
rate, TTS output sample rate, default voice, and the complete voice inventory;
the SDK selects no hardware default, runtime, model, or fallback.

The SDK is not the distributor of the selected upstream speech packages or
provider assets and does not republish their legal/source payloads. Package,
model, voice, and version selection belongs to each consuming application, not
to a shared SDK component ledger or execution/publication gate.

Whisper `stt` and Kokoro `tts` each own catalog, inspect, status, load, request,
unload, and dispose state. They load, cancel, unload, fail, and recover
independently from the LLM and from one another. Cancellation after Worker use
begins terminates that role's Worker slot and returns the provider to unloaded;
a later use must load it again. If shared STT `Blob` decoding is cancelled
before Worker use, the request rejects while the loaded provider remains ready.
Speech failure neither disables text chat nor retries through another local,
native, or cloud provider. The provider/Worker layer is event-neutral: it
exposes promises, `AbortSignal`, and precise lifecycle/status records, but owns
no event bus or listener registry. The provider/2 load context accepts an
optional progress callback for interface compatibility; the current
browser-speech artifact and Worker transport publishes no progress records.

### Persistent chat and document context

The SDK runtime owns
[`DBOPFSDocumentLibrary`](runtime-modules.md#dbopfsdocumentlibraryjs),
[`DocumentLexicalSearch`](runtime-modules.md#documentlexicalsearchjs), and
[`PersistentAIChatSession`](runtime-modules.md#persistentaichatsessionjs).
DBOPFS JSONL parsing preserves every nonblank unreadable row as its original
string. Persistent chat can therefore expose the complete saved transcript for
application-owned inspection and recovery while rejecting that row from
provider-facing history with a coded persistence error.
Document bootstrap is explicit and schema-driven, commits a completed
generation last, and returns complete search results with partial read failures
disclosed. `evaluate()` can instead score a caller-owned source set without
persisting its bodies.
A chat session never searches the corpus unless the application
deliberately wires a document context builder into the request; generated
document context remains labeled untrusted.

Persistent chat maintains complete live model context plus a sanitized
`ChatEntity` transcript according to the caller's persistence choice. Active
provider protocol may contain structural calls, IDs, argument envelopes, raw
results, reasoning, and request metadata, but those fields never cross the new
DBOPFS-write boundary. Durable user and assistant turns retain only role,
complete visible content, and timestamp. Durable tool turns retain only role,
the required user-facing message as content, and optional public name and result
status. System prompts remain in the live session only. Existing stored files
are not rewritten on load. A turn with `persist:false` participates in its one
request and response only, then remains absent from subsequent model context,
the retained transcript, memory extraction, and DBOPFS.

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

Interactive requests enter an uncapped FIFO lane independently for each role.
A new valid request neither aborts nor discards the active request; it starts
after every earlier request settles. A caller signal cancels only its own queued
or active request, while explicit role cancellation targets only the active
request. Request-specific generations prevent canceled or superseded callbacks
from clearing or restoring newer state. The runtime revalidates
selected-provider readiness and never reloads, switches, or falls back
implicitly. Generic provider-promise settlement is not a claim that underlying
work stopped; only a provider's documented positive acknowledgement or
destructive worker teardown can prove that stronger fact.

`startAIRuntime({startLanguageModel:false,startTranscription:false})` is the
explicit startup boundary for browser-WASM LLM and default STT activation. It
leaves the selected LLM unloaded until the shared chat control publishes an
explicit user load intent; the
startup barrier then reports `chatReady:false` and `roles.llm.requested:false`
instead of beginning a browser-WASM download. The omitted/default
`startLanguageModel:true` preserves existing provider startup behavior. The
default `startTranscription:false` also declines to request a startup STT load
and does not unload a role already started through another
explicit lifecycle action. A selected unloaded
transcription provider remains selected and unloaded until a user lifecycle
intent or explicit `startTranscription:true` opt-in asks the provider owner to
load it. Neither state observation nor either shared speech component imports a
model or selects a fallback. `speech.html` and `voice-transcription.html` consume
one shared `createSTTActivationController()` contract for selected, unloaded,
loading, unloading, error, and ready presentation plus cancelable user intent.
Both keep capture unavailable until sticky STT state is exactly ready.

Each shared speech component owns an `AbortController` for its STT request and
passes its signal through `AI.fetchSTT()`. `voice-transcription.html` also adds
that signal to the existing injected `transcribe(file,context)` callback
context. Cancel, readiness loss, superseding capture, and component teardown
abort the owned signal and suppress late delivery. Whether the provider's
underlying computation stops remains governed by its own cancellation contract.
User TTS unmute calls `AI.setSpeechMuted(false)` before
or with its load intent so the runtime records the unmuted lifecycle preference;
an `initialMuted:false` component configuration preserves that intent across an
unselected or loading TTS route and exposes unmuted state only after readiness;
mute calls `AI.setSpeechMuted(true)`, cancels active synthesis, and unloads TTS.
The selected local TTS model catalog owns `defaultVoice`. AI.js never forwards
a retired OpenAI voice to Core or browser Kokoro.

LLM tool calls are structural result data only. The SDK never executes a
handler. The application owns schema validation, authorization, side-effect
policy, dispatch, and the matching tool-result turn.

Ordinary streaming publishes complete nonstructural content and reasoning from
every provider choice in order. Complete provider chunks and terminal records
remain independently available through the data callbacks. Structural deltas
stay private until terminal validation; terminal-only calls are valid, while
any observed call must keep the same choice, order, identity, exact argument
string, and extension fields at settlement. Awaiting a terminal result before
iterating does not stall the private provider stream; projected chunks remain
available to the later consumer.

Every first-party function-tool declaration includes
`function.parameters.properties.message` as a required nonempty string, and
every emitted call includes that plain-language user-facing value in the JSON
encoded by `function.arguments.message`. The application uses `message` for the
call's progress, question, or next step; it does not treat raw tool envelopes,
arguments, internal sequencing state, or protocol failures as ordinary
transcript content. An explicitly selected developer inspection surface may
show the raw structure separately. This `message` does not replace domain
fields such as a closing report's `final_message`. One assistant response may
contain an ordered array of calls with unique IDs. Display does not settle any
call: one atomic result batch must provide exactly one matching nonblank
executed, declined, cancelled, or not-executed `role:'tool'` turn for every
pending ID before another user or provider turn.

<details>
<summary>Portable AI protocol disclosure</summary>

The normalized runtime protocol is `arcane-ai-runtime/2`; registered adapters
implement `arcane-ai-provider/2` and select a model before load. The
browser-WASM component protocol is `arcane-ai-browser-wasm/2`; its
direct controller adapter uses `arcane-ai-adapter/1`, and
`adaptV1LlmProvider()` projects that surface into the provider/2 LLM role.
Browser speech stores identify themselves as
`arcane-ai-browser-speech-artifacts/1`. Legacy authorities retain
`arcane-ai-model-authority/1`. Optional browser-speech graphs use
`arcane-ai-browser-speech-artifact-graph/1`, kind
`browser-speech-authenticated-artifact-graph`. Those identifiers describe
lifecycle contracts; none is by itself a capability grant.

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
  -> complete Ollama HTTP operation
```

Applications never connect directly to `localhost:11434`. Core owns loopback
endpoint selection, method policy, stream ids,
chunk events, model-policy checks, native resource admission, and managed
mutation workflows.

Direct Ollama methods preserve the complete provider-native success envelope.
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

- API names, promise/error behavior, host capability policy, and public
  operation events are normalized;
- host availability, privilege model, installation/service mechanism, native
  artifact kind, and some diagnostic/result fields remain platform-specific;
- unsupported platforms fail or return a documented unsupported state; they do
  not run an unrelated browser implementation as a substitute;
- this SDK version requires a selected checkout and Core to provide the current
  native plan's protocol, version, feature, capability, method, and provider;
- that current-build compatibility does not promise that a future SDK will accept
  this Core or that this SDK will accept a future Core.

## Complete-content boundary

SDK runtime, app releases, import-map files, bundles, native plans, providers,
and artifacts preserve their complete selected content. Required credential
protection, genuinely malformed input rejection, applicable law, external
protocol requirements, and host platform safety remain in effect.
