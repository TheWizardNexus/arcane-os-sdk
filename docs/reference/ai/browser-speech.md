# Browser speech providers

`arcane-os/ai/browser-speech` is the browser-only, event-neutral SDK boundary
for caller-supplied Whisper speech-to-text and Kokoro text-to-speech runtimes.
It supplies immutable artifact-graph validation, DBOPFS admission, role Workers,
provider/2 adapters, audio normalization, cancellation, and cleanup. It does
not ship or select runtime modules, model weights, voice bytes, a default
catalog, credentials, a native provider, or a cloud fallback.
The package contains no speech runtime, model, or voice payload and
never downloads one before explicit `load()`.

Use this entrypoint when an application deliberately owns every browser-local
speech choice. Higher-level selection, startup policy, shared state, and event
projection belong to the application runtime; this package exposes only
promises, `AbortSignal`, and the caller's progress callback.

## Availability

| Host | Availability | Notes |
| --- | --- | --- |
| Browser | Shipped | Requires DBOPFS/OPFS, Web Locks, Workers, Fetch, Blob/File, and object URLs. Authenticated graphs additionally require `MessageChannel`; shared Blob/File STT requests require the browser audio decoder. |
| Native WebView | Conditional | Available only when the WebView exposes the same browser APIs and the application admits every artifact. It does not invoke Core speech. |
| Node | Importable, execution unavailable | The ESM subpath can be imported, but the SDK supplies no Node speech storage, Worker, or audio-decoder host. |
| Cloud | Not provided | A cloud speech adapter may separately implement `arcane-ai-provider/2`; this package never selects it. |

Whisper `stt` and Kokoro `tts` each own an independent provider lifecycle. A
failure or cancellation in either role does not disable LLM use and never
authorizes a different local, native, Core, or cloud provider.

## Public exports

```javascript
import {
  BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL,
  BROWSER_SPEECH_ARTIFACT_PROTOCOL,
  createBrowserKokoroProvider,
  createBrowserSpeechArtifactGraph,
  createBrowserSpeechAuthority,
  createBrowserWhisperProvider,
  createDbopfsSpeechArtifactStore
} from 'arcane-os/ai/browser-speech';
```

The entrypoint exports exactly those seven names. Importing it downloads no
artifact, opens no cache, creates no Worker, and publishes no event.

## Protocol and enum registry

| Subject | Exact value or closed set |
| --- | --- |
| Artifact-store protocol | `arcane-ai-browser-speech-artifacts/1` |
| Authenticated artifact-graph protocol | `arcane-ai-browser-speech-artifact-graph/1` |
| Graph `kind` and prepared `runtime.moduleGraph` | `browser-speech-authenticated-artifact-graph` |
| Legacy prepared `runtime.moduleGraph` | `self-contained` |
| Legacy authority protocol | `arcane-ai-model-authority/1` |
| Provider protocol | `arcane-ai-provider/2` |
| Worker protocol | `arcane-ai-speech-worker/1` |
| Worker error-envelope protocol | `arcane-ai-speech-worker-error/1` |
| Nested artifact module-Worker protocol | `arcane-ai-browser-speech-artifact-module-worker/1` |
| Nested module-Worker rejection event | `artifact-module-worker-bootstrap-rejected` |
| Runtime graph-guard protocol | `arcane-ai-browser-speech-artifact-graph-runtime/1` |
| Roles | `stt`, `tts` |
| Role operations | `transcribe` for `stt`; `synthesize` for `tts` |
| Public Worker operations | `load`, `use`, `status`, `unload`, `dispose` |
| Worker transport-only control operation | `cancel` |
| TTS response format | `wav` |
| Runtime adapters | `transformers-whisper` for `stt`; `kokoro-js` for `tts` |
| ONNX namespace identifiers | `transformers-env-backends-onnx-wasm` for `stt`; `kokoro-env-wasm-paths` for `tts` |
| Edge policies | `artifact-targets-admitted`, `inactive-runtime-branch-rejected` |
| Import target matches | `exact-runtime-specifier`, `materialized-module-url`; module-Worker targets additionally admit `self-module-url` |
| Transform kinds | `function-return-this-to-global-this`, `typed-array-constructor` |
| Graph descriptor status | `artifact-graph-descriptor-verified` |
| Graph admission | `artifact-graph-network-dbopfs-verified`, `artifact-graph-dbopfs-cache-verified`, `artifact-graph-offline-dbopfs-cache-verified` |

These values are exact, case-sensitive public contract values. Unknown values
fail closed; a newer-looking value is not treated as compatible.

## `createBrowserSpeechArtifactGraph()`

This is the operational authority for a real auxiliary ESM/WASM/model/voice
closure. It creates one frozen, caller-selected graph and computes its SHA-256
identity from a canonical JSON projection. The inventory is dynamic and has no
fixed file or edge count; every declared member must still belong to the one
complete reachable closure.

The top-level shape is:

```text
createBrowserSpeechArtifactGraph({
  kind?,
  identitySha256?,
  providerId?,
  role,
  model: { ... },
  runtime: { ... },
  files: [fileDescriptor, ...],
  edges: {
    staticImports: [...],
    dynamicImports: [...],
    moduleWorkers: [...],
    fetches: [...],
    cacheOpens: [...]
  },
  transforms: [...]
})
```

### Top-level and model fields

| Field | Contract |
| --- | --- |
| `kind` | Omit it or use exactly `browser-speech-authenticated-artifact-graph`. |
| `identitySha256` | Optional 64-character lowercase SHA-256 assertion. If supplied, it must equal the SDK's canonical descriptor digest. The returned graph always contains the computed value. |
| `providerId` | `null`/omitted, or one trimmed 1–128 character identity. A non-null value must equal the provider constructor's `id`. |
| `role` | Exactly `stt` or `tts`. |
| `model.id` | Trimmed 1–128 character caller-owned model identity. |
| `model.repository` | Trimmed 1–128 character logical repository identity. The SDK passes it to the admitted adapter but does not resolve it independently. |
| `model.revision` | Trimmed 1–128 character immutable revision. Every model and voice file must use this same revision. |
| `model.dtype` | Trimmed 1–128 character caller-owned dtype. There is no SDK-selected graph default. |
| `model.inputSampleRate` | Required positive safe integer for `stt`; caller-owned. STT must not declare voices. |
| `model.outputSampleRate` | Required positive safe integer for `tts`; caller-owned. |
| `model.defaultVoice` | Required for `tts`; must name one declared `voices[].id`. |
| `model.voices` | Required nonempty TTS array of unique `{id,path}` records. Every path must name one unique `voice-style-binary`, and every such file must be in this inventory. |

### Runtime fields

| Field | Contract |
| --- | --- |
| `runtime.adapter` | `transformers-whisper` for `stt`; `kokoro-js` for `tts`. |
| `runtime.version` / `runtime.revision` | Trimmed 1–128 character caller-pinned identities. The sole entrypoint file revision must equal `runtime.revision`. |
| `runtime.entrypoint` | Canonical path of the sole `runtime-entrypoint-javascript`. `runtime.entry` is accepted as an input alias; the normalized graph exposes `runtime.entry`. |
| `runtime.onnxWasm.namespace` | `transformers-env-backends-onnx-wasm` for STT or `kokoro-env-wasm-paths` for TTS. |
| `runtime.onnxWasm.mjsPath` | Path of a declared `runtime-auxiliary-javascript`. |
| `runtime.onnxWasm.wasmPath` | Path of a declared `runtime-wasm-binary`. |
| `runtime.onnxWasm.numThreads` | Optional positive safe integer for Transformers STT only. Kokoro does not expose a verified thread setting and rejects this field with reason `kokoro-env-num-threads-field-not-exposed`. No hardware-derived default is chosen. |
| `runtime.negativeRuntimeRequestUrls` | Optional unique absolute HTTPS routes that a declared fetch edge may intentionally resolve as a local `404`. They may not overlap a positive source or runtime route and must be referenced by an edge. |

### File descriptor

Every `files[]` entry contains all of these fields:

```text
{
  kind,
  path,
  sourceUrl,
  revision,
  license,
  mediaType,
  sourceMediaType?,
  bytes,
  sha256,
  runtimeRequestUrls?,
  redirectFinalOrigins?
}
```

| Field | Contract |
| --- | --- |
| `kind` | One exact kind from the table below. |
| `path` | Nonempty NFC-normalized relative path. Leading/trailing slash, backslash, empty/`.`/`..` segment, percent escape, query/fragment delimiter, control character, duplicate spelling, or case-folded collision is rejected. |
| `sourceUrl` | Immutable starting HTTPS or same-origin authority without credentials or fragment. The pathname must not name `main`, `master`, `latest`, `refs/heads/main`, `refs/heads/master`, `resolve/main`, or `resolve/master`, or an `@latest`/`@next` channel. The URL must contain the declared revision or SHA-256 and remains authoritative even when redirect following is opted in. `url` is accepted as an input alias. |
| `revision` | Nonempty 1–128 character immutable file revision. Runtime entry revision equals the runtime revision; all model/voice revisions equal the model revision. |
| `license` | Nonempty declaration up to 256 characters. It is part of graph identity and the DBOPFS manifest authority, but it is only a declaration: it is not provenance, a composite notice, corresponding-source evidence, or a license inferred from bytes. The caller remains responsible for complete immutable license/notice evidence. |
| `mediaType` | Exact lowercase `type/subtype` without parameters. JavaScript is `application/javascript` or `text/javascript`; WASM is `application/wasm`; `*-json` kinds are `application/json`. |
| `sourceMediaType` | Optional exact lowercase `type/subtype` without parameters for the cold HTTP response. It defaults to `mediaType`; when different, it is exposed in the normalized descriptor and graph identity while `mediaType` remains the authenticated materialized Blob type. |
| `bytes` | Positive safe integer; always required and always verified for graphs. |
| `sha256` | Exactly 64 lowercase hexadecimal characters; always required and always verified for graphs. |
| `runtimeRequestUrls` | Optional unique absolute HTTPS aliases used only inside the authenticated Worker. An alias may describe a third-party runtime's hard-coded mutable request, but it is never a download authority: the Worker maps it to this already verified local file. |
| `redirectFinalOrigins` | Optional nonempty array that opts this file into Fetch redirect following. Every member must canonicalize to a unique HTTPS origin with no credentials, path, query, or fragment. The normalized array is lexically sorted, frozen, and graph-identity-bound. Omit the field for redirect rejection; an empty array is rejected. |

The closed file kinds are:

| Runtime kinds | Model/data kinds |
| --- | --- |
| `runtime-entrypoint-javascript` | `model-configuration-json` |
| `runtime-auxiliary-javascript` | `model-generation-configuration-json` |
| `runtime-wasm-binary` | `model-onnx-binary` |
| `runtime-opaque-data` | `model-onnx-external-data` |
|  | `model-preprocessor-json` |
|  | `model-tokenizer-json` |
|  | `model-opaque-data` |
|  | `voice-style-binary` |

Paths and immutable source URLs are globally unique within a graph. Positive
runtime request aliases are also unique and cannot overlap a source URL or a
negative route. Every non-entry file must be reachable from the declared ONNX
pair, TTS voice inventory, or one exact edge; unreachable files and routes are
rejected rather than silently retained.

### Edge and transform descriptors

Edge `occurrence` values are positive, one-based occurrences in the named
`modulePath`. A declaration must match the scanner's exact source occurrence;
missing, duplicate, extra, occurrence-mismatched, or undeclared runtime edges
fail closed. Descriptor collections are canonically sorted for graph identity,
so caller array order is not semantic.

| Collection | Exact record |
| --- | --- |
| `edges.staticImports` | `{modulePath,occurrence,specifier,targetPath}`. The literal specifier and declared JavaScript target must match. |
| `edges.dynamicImports` | `{modulePath,occurrence,edgePolicy,targets}`. Each target is `{match,targetPath,exactSpecifier?}`. `exactSpecifier` is required only for `exact-runtime-specifier`. |
| `edges.moduleWorkers` | Same shape as dynamic imports; `self-module-url` is additionally available and must target the declaring module. Only module Workers are admitted. |
| `edges.fetches` | `{modulePath,occurrence,edgePolicy,methods:["GET"],targetPaths,negativeRuntimeRequestUrls,allowMaterializedUrls}`. `methods` defaults to the same one-element `GET` array; the two target arrays default empty; `allowMaterializedUrls` is `true` only when explicitly set and otherwise normalizes to `false`. No other method is admitted, and a fetch target cannot be JavaScript. |
| `edges.cacheOpens` | `{modulePath,occurrence,edgePolicy,cacheName,targetPaths}`. `artifact-targets-admitted` requires at least one exact non-JavaScript file path; `inactive-runtime-branch-rejected` requires none. The returned cache can read only those files. |
| `transforms` | `{kind,modulePath,occurrence}`. `function-return-this-to-global-this` replaces the one audited `Function("return this")()` pattern. `typed-array-constructor` rewrites only a scanner-recognized typed-array `.constructor(...)` call and later proves the receiver uses an intrinsic typed-array prototype. |

An omitted `edgePolicy` normalizes to `artifact-targets-admitted`, which
requires a declared target. An
`inactive-runtime-branch-rejected` edge has no target and proves only that the
branch must remain inactive; execution of that occurrence rejects. The source
scanner rejects undeclared imports, fetches, Workers, executable-string
construction or constructor access, Cache Storage access outside a direct
declared `caches.open(...)`, computed capability access, ambiguous tokens, and
unmatched transforms. It also reserves the SDK guard name so artifact code
cannot address the guard directly. Static import cycles are rejected so
materialization order remains deterministic; runtime isolation separately
denies every raw transport listed below.

The returned graph is deeply frozen and has exactly
`{protocol,kind,providerId,role,model,runtime,files,edges,transforms,identitySha256,artifactGraphStatus}`.
The status is `artifact-graph-descriptor-verified`. Its computed identity binds
every preceding descriptor field, including paths, revisions, licenses,
runtime aliases, edge policy, and transform occurrences; the status itself is
the result of that computation rather than identity input.

## `createDbopfsSpeechArtifactStore()`

```text
createDbopfsSpeechArtifactStore({
  dbopfs,
  tableName = 'arcane_ai_browser_speech',
  fetchImpl = null,
  objectUrlFactory = null
} = {})
```

The frozen store exposes `{protocol,tableName,prepare,remove}`. It accepts both
the authenticated graph above and an SDK-created legacy authority.
`objectUrlFactory` remains a legacy compatibility seam. Graph preparation
ignores it and uses module-captured native Blob URL creation, revocation, and
fetch so a caller cannot substitute the executable materialization boundary.

For a graph, `prepare(graph,{signal,onProgress,offline=false,security})` follows
the shared model-security flag and requires explicit `secure:true`. The graph is
the opt-in strict path: it enables byte-length, SHA-256, and undeclared-
capability enforcement. Ordinary warn-first operation uses the direct
`model`/`runtime` authority described below and does not construct or admit an
artifact graph.

### Cold admission

1. Acquire the exact authority's exclusive Web Lock.
2. Delete incomplete prior state.
3. Fetch only each declared immutable `sourceUrl` using `credentials:"omit"`,
   `cache:"no-store"`, `mode:"cors"`, and `referrerPolicy:"no-referrer"`.
   The default is `redirect:"error"`; only a file with declared
   `redirectFinalOrigins` uses `redirect:"follow"`.
4. Without a followed redirect, require the response URL to remain exactly the
   immutable `sourceUrl`. After a followed redirect, require a readable final
   HTTPS URL without credentials or a fragment and require its canonical origin
   to occur in that file's declared final-origin inventory.
5. Require the response Content-Type to equal `sourceMediaType` (which defaults
   to `mediaType`), then stream exact byte-length and SHA-256 verification into
   DBOPFS.
6. Reopen and rehash every persisted file.
7. Decode and scan every runtime JavaScript file and prove exact edge/transform
   closure.
8. Persist `arcane.ai.browser-speech.authenticated-artifact-graph.v1` only
   after every file and the complete runtime graph pass.

The returned admission is
`artifact-graph-network-dbopfs-verified`. A failure before manifest completion
removes the graph's incomplete records.

`redirectFinalOrigins` admits only a final origin, not a final path, query, or
signed/expiring URL. The browser may follow such an implementation-specific
final URL, but that URL is neither persisted nor accepted as source, revision,
signature, graph identity, or future download authority. Trust remains bound to
the immutable starting `sourceUrl` and the exact authenticated length and
SHA-256 of the received bytes.

Browser Fetch exposes the final CORS response, not an inspectable list of every
intermediate redirect hop. The SDK therefore cannot authenticate intermediate
hop origins or headers. CORS must succeed for the browser-managed chain, and
the SDK can enforce only the immutable start, the declared final HTTPS origin,
the final response metadata, and the end-to-end bytes. A caller that requires
every hop to be independently pinned must use a direct immutable source rather
than this redirect opt-in.

### Warm and offline admission

A warm prepare requires the exact manifest authority and file count, reopens
every DBOPFS record, checks the manifest's observed bytes and declared SHA-256,
rehashes every file, and rescans the runtime graph before returning
`artifact-graph-dbopfs-cache-verified`.

`offline:true` runs the same cache verification and never calls the source
fetch function. It returns
`artifact-graph-offline-dbopfs-cache-verified`, or rejects with code
`ARCANE_AI_ARTIFACT_GRAPH_OFFLINE_CACHE_MISS` and reason
`artifact-graph-offline-cache-miss`. There is no network repair, runtime CDN,
private Cache Storage fallback, or partial-cache admission.

The manifest authority binds each file's `sourceMediaType` and
`redirectFinalOrigins` through the graph identity. A valid warm or offline
admission does not resolve the starting URL again, follow a redirect, or reuse a
prior final URL; it authenticates only the complete cached bytes and graph.

After every cold, warm, or offline admission, the store materializes a fresh
set of unique native `blob:` URLs. Each URL is fetched back with omitted
credentials and redirect rejection, and its exact URL identity, media type,
byte length, and SHA-256 are compared with the Blob that was created. Only then
does the SDK apply the already-scanned deterministic module rewrites. A fresh
cryptographically random 32-byte lowercase-hex guard capability binds every
rewritten dynamic import, fetch, cache-open, child-Worker, and typed-array call
for that materialization. The capability is ephemeral: it is neither supplied
by the caller nor persisted in the manifest or graph identity.

Successful graph preparation returns:

```text
{
  cache,                    // the exact graph admission value
  artifactGraphId,
  artifactGraphAdmission,
  runtime: {
    ...normalizedRuntime,
    files, edges, transforms,
    guardCapability,
    artifactGraphId,
    artifactGraphAdmission
  },
  model: {...normalizedModel, files},
  release
}
```

`release()` revokes the materialized object URLs after Worker termination. It
does not delete the caller-owned DBOPFS cache. `remove(graph)` is the explicit
cache-deletion operation.

## Authenticated Worker host

Graph loading creates one dedicated Worker for the selected role. Its first
load envelope transfers a new private `MessagePort`; all graph responses,
progress, cancellation settlement, and later operations stay on that port.
Graph loading rejects if `MessageChannel`/`MessagePort` is unavailable, if a
legacy global transport was already selected, or if the Worker receives a graph
load without the private port. The published single-module compatibility path
continues to use the original Worker-global message transport.

Before importing the entrypoint, the graph Worker installs these fail-closed
boundaries:

- exact graph routes map declared source URLs, runtime aliases, and materialized
  URLs to already authenticated object URLs;
- the ephemeral guard capability must match at every rewritten call;
- global `fetch` rejects unless the scanned source was rewritten to one
  declared fetch edge;
- global Cache Storage `open` and `match` reject unless the scanned
  `caches.open(...)` was rewritten to one exact declared cache-open edge; its
  returned read-only cache serves only `targetPaths`, while `put`, `add`, and
  `addAll` reject, so DBOPFS remains the sole durable store;
- a `typed-array-constructor` rewrite returns only the intrinsic constructor of
  a verified typed-array receiver; an own or non-intrinsic `constructor`
  rejects;
- the `Function`, `AsyncFunction`, `GeneratorFunction`, and
  `AsyncGeneratorFunction` prototype constructor escape is replaced before
  import, and string callbacks to `setTimeout` or `setInterval` reject;
- `indexedDB` and `navigator.storage`/OPFS are made unavailable;
- raw `BroadcastChannel`, `EventSource`, `Function`, `RTCPeerConnection`,
  `ShadowRealm`, `SharedWorker`, `WebSocket`, `WebSocketStream`, `WebTransport`,
  `Worker`, `XMLHttpRequest`, `eval`, and `importScripts` capabilities are
  denied; and
- an admitted child module Worker is created through the SDK's role Worker,
  receives the authenticated graph configuration, installs the same guard, and
  imports only its declared materialized target.

An immutable `sourceUrl` may be an explicitly caller-selected HTTPS origin,
but runtime execution cannot escalate to that or another network origin. Its
declared request is answered from authenticated local object bytes, and any
other request or import edge rejects.

### ONNX Runtime Web configuration

The Worker accepts only the two mechanically verified namespace shapes:

- Kokoro: `namespace.env.wasmPaths = {mjs,wasm}`. No Kokoro cache setting or
  thread setting is invented. A missing property rejects as
  `kokoro-env-wasm-paths-unavailable`; a property that rejects or does not
  retain the exact assignment rejects as
  `kokoro-env-wasm-paths-assignment-rejected`.
- Transformers: `namespace.env.backends.onnx.wasm.wasmPaths = {mjs,wasm}`.
  The Worker also requires the verified outer `env` fields, sets
  `allowLocalModels:false`, `allowRemoteModels:true`, `useBrowserCache:false`,
  and `useFSCache:false`. With no admitted `cacheOpens` edge named exactly
  `transformers-cache`, it assigns `useCustomCache:false` and `customCache:null`.
  With exactly one such edge it assigns `useCustomCache:true` and the
  target-limited read-only graph facade; more than one rejects as ambiguous.
  Only a caller-declared STT `numThreads` is assigned. The
  `allowRemoteModels` value permits the audited library code path to issue its
  declared request; the graph guard still prevents network access and serves
  only exact local graph routes.

For Transformers, the exact missing-field reasons are
`transformers-env-backends-onnx-wasm-unavailable`,
`transformers-env-allow-local-models-unavailable`,
`transformers-env-allow-remote-models-unavailable`,
`transformers-env-browser-cache-unavailable`,
`transformers-env-fs-cache-unavailable`,
`transformers-env-custom-cache-toggle-unavailable`, and
`transformers-env-custom-cache-unavailable`. The corresponding exact
assignment-rejection reasons are
`transformers-env-allow-local-models-assignment-rejected`,
`transformers-env-allow-remote-models-assignment-rejected`,
`transformers-env-browser-cache-assignment-rejected`,
`transformers-env-fs-cache-assignment-rejected`,
`transformers-env-custom-cache-toggle-assignment-rejected`, and
`transformers-env-custom-cache-assignment-rejected`. The optional, creatable
ONNX fields fail assignment as
`transformers-env-wasm-paths-assignment-rejected` or
`transformers-env-num-threads-assignment-rejected`; their defensive
unavailable reasons are `transformers-env-wasm-paths-unavailable` and
`transformers-env-num-threads-unavailable`. Every case rejects with
`ARCANE_AI_PROVIDER_UNAVAILABLE`; the Worker never guesses a different
namespace shape.

Kokoro's audited bundle hard-codes a mutable
`.../resolve/main/voices/${voice}.bin` request and opens `kokoro-voices` Cache
Storage. That URL is never accepted as `sourceUrl`. An operational graph must
declare the exact resolved voice file as an immutable authenticated source,
bind the hard-coded URL only as that file's `runtimeRequestUrls` alias, and
declare the exact `cacheOpens` occurrence with `cacheName:"kokoro-voices"` and
the caller-owned voice paths. Every scanned fetch occurrence still requires its
own explicit admitted or inactive policy. The Worker satisfies the cache read
from verified local voice bytes; it never opens Kokoro's private durable cache.
If the graph does not prove those exact edges, Kokoro fails closed before the
mutable request can reach the network.

That graph closure is an optional caller-owned secure/offline configuration,
not the public runtime's default and not a publication gate. In warn-first mode
the SDK loads the caller-selected version-pinned upstream package and provider
assets from their publishers. The SDK neither republishes those bytes nor
requires their optional provenance or legal metadata before the provider can
operate. When `secure:true` is selected, incomplete graph metadata rejects that
specific secure load without disabling ordinary warn-first operation.

## Providers

```text
createBrowserWhisperProvider({
  id = 'arcane-browser-whisper',
  localOnly = true,
  graph?,
  model?, runtime?,
  store,
  offline = false,
  appSecurity,
  security
} = {})

createBrowserKokoroProvider({
  id = 'arcane-browser-kokoro',
  localOnly = true,
  graph?,
  model?, runtime?,
  store,
  offline = false,
  appSecurity,
  security
} = {})
```

`graph` is mutually exclusive with the legacy `model`/`runtime` options and may
load only when effective security explicitly selects `secure:true`. Both
constructors require an SDK-created DBOPFS speech store and return one frozen
`arcane-ai-provider/2` object:

```text
{
  protocol, role, id, localOnly,
  catalog, inspect, status, load, request, unload, dispose
}
```

`localOnly` must remain `true`. `offline:true` makes every later explicit load
use strict offline graph/cache admission; it does not trigger a load itself.

`catalog()` exposes only the caller's selected model/runtime/files. A graph
catalog also reports `artifactGraphId`, caller dtype, exact sample rate, and the
caller voice inventory. Its one exact catalog record is
`{id,providerId,role,localOnly,defaultVoice?,repository,revision,dtype?,runtime,files,artifactGraphId?,voices?,speech}`;
the `speech` record is `{inputSampleRate}` for STT or
`{outputSampleRate,responseFormats:["wav"],defaultResponseFormat:"wav"}` for
TTS.

`inspect()` admits only the exact provider/model/local selection and, when
supplied, the matching role. A successful graph inspection returns
`{available:true,authority}`. Its frozen authority has exactly
`{protocol,admitted,graph,artifactGraphProtocol,providerId,role,modelId,repository,revision,dtype,defaultVoice,voices,inputSampleRate,outputSampleRate,runtime,files,security,artifactGraphId}`;
`protocol` is `arcane-ai-model-authority/1` and `artifactGraphId` is the graph
identity. An unavailable record uses
`ARCANE_AI_MODEL_AUTHORITY_REQUIRED` and the exact role-specific reason
`stt-provider-inspection-selection-authority-mismatch` or
`tts-provider-inspection-selection-authority-mismatch`. `load()` is explicit;
construction, catalog, status, and inspection never start a download or Worker.

### Whisper STT

The provider-native operation is:

```javascript
const result = await whisper.request({
  role: 'stt',
  operation: 'transcribe',
  signal,
  payload: {
    audio: pcmFloat32,
    sampleRate: graph.model.inputSampleRate
  }
});
```

The native payload is exact `Float32Array` mono PCM at the graph's
caller-selected input sample rate. The result is `{text}`. The shared AI
payload `{audio:Blob|File,mimeType,model}` verifies the exact model, uses the
browser decoder to normalize to that same rate, and then enters the same Worker
operation. Multi-channel decoded audio is averaged to one mono `Float32Array`.
Cancellation during Blob/audio decoding rejects with
`ARCANE_AI_REQUEST_ABORTED` / `stt-transcription-cancelled` while the already
loaded Worker remains ready.

### Kokoro TTS

```javascript
const result = await kokoro.request({
  role: 'tts',
  operation: 'synthesize',
  signal,
  payload: {
    text: 'Hello from Arcane.',
    voice: 'caller-voice-id',
    speed: 1
  }
});
```

`voice` must belong to the graph's caller-declared inventory; omission uses
only that graph's `model.defaultVoice`. `speed` must be greater than zero and at
most four. The provider-native result is
`{audio:Float32Array,sampleRate,voice}` at the caller-selected output sample
rate. The shared AI payload `{model,input,responseFormat,voice?,speed?}` accepts
only `responseFormat:"wav"` and returns frozen
`{audio:Uint8Array,contentType:"audio/wav"}` containing mono signed 16-bit PCM
at the caller-selected output rate. No saved voice from another route is
substituted.

## Lifecycle, progress, cancellation, and cleanup

Provider `status()` returns:

```text
{
  role,
  providerId,
  modelId,
  state,
  lifecycleStatus,
  lifecycleReason,
  activeOperation,
  loaded,
  busy,
  generation,
  errorCode,
  cache,
  artifactGraphId,
  artifactGraphAdmission
}
```

The provider states are exactly `unloaded`, `loading`, `ready`, `unloading`,
`error`, and `disposed`. `lifecycleStatus` is therefore exactly one of
`stt-provider-unloaded`, `stt-provider-loading`, `stt-provider-ready`,
`stt-provider-unloading`, `stt-provider-error`, `stt-provider-disposed`,
`tts-provider-unloaded`, `tts-provider-loading`, `tts-provider-ready`,
`tts-provider-unloading`, `tts-provider-error`, or `tts-provider-disposed`.

`activeOperation` is `null` or one of `stt-provider-load`,
`tts-provider-load`, `stt-provider-transcription`, `tts-provider-synthesis`,
`stt-provider-unload`, `tts-provider-unload`, `stt-provider-dispose`, and
`tts-provider-dispose`.

`loaded` is true only for `ready`. `busy` reports an active transcription or
synthesis request; load, unload, and dispose remain visible through `state` and
`activeOperation`. `cache` is `null`, a graph admission value, or the legacy
`installed`/`cached` value. Graph identity and admission are otherwise `null`.

Provider-owned lifecycle reasons are:

- creation and load: `stt-provider-created`, `tts-provider-created`,
  `stt-load-started`, `tts-load-started`, `stt-load-completed`,
  `tts-load-completed`, `stt-load-cancelled`, `tts-load-cancelled`,
  `stt-provider-load-rejected`, `tts-provider-load-rejected`,
  `stt-load-rejected-during-unload`,
  `tts-load-rejected-during-unload`,
  `stt-load-superseded-by-security-change`,
  `tts-load-superseded-by-security-change`,
  `stt-load-superseded-by-unload`, `tts-load-superseded-by-unload`,
  `stt-load-progress-callback-threw`, and
  `tts-load-progress-callback-threw`;
- use: `stt-transcription-started`, `stt-transcription-completed`,
  `stt-transcription-cancelled`,
  `stt-transcription-engine-operation-rejected`,
  `tts-synthesis-started`, `tts-synthesis-completed`,
  `tts-synthesis-cancelled`, `tts-synthesis-engine-operation-rejected`,
  `stt-transcription-superseded-by-unload`, and
  `tts-synthesis-superseded-by-unload`;
- teardown: `stt-unload-started`, `tts-unload-started`,
  `stt-unload-completed`, `tts-unload-completed`, `stt-dispose-started`,
  `tts-dispose-started`, `stt-dispose-completed`, `tts-dispose-completed`,
  `stt-worker-terminated-by-unload`, `tts-worker-terminated-by-unload`,
  `stt-worker-terminated`, and `tts-worker-terminated`; and
- Worker failure: `stt-worker-crashed`, `tts-worker-crashed`,
  `stt-worker-message-rejected`, `tts-worker-message-rejected`,
  `stt-worker-private-message-rejected`,
  `tts-worker-private-message-rejected`,
  `stt-worker-progress-envelope-rejected`,
  `tts-worker-progress-envelope-rejected`,
  `stt-worker-response-envelope-shape-rejected`,
  `tts-worker-response-envelope-shape-rejected`,
  `stt-worker-error-envelope-rejected`, `tts-worker-error-envelope-rejected`,
  `stt-worker-protocol-mismatch`, and
  `tts-worker-protocol-mismatch`.

When an active load or use fails with one of the stable reasons below, the
provider preserves that exact reason as `lifecycleReason`; it does not collapse
the boundary to a generic failure label.

Worker statuses use exactly `stt-worker-unloaded`, `stt-worker-ready`,
`stt-worker-disposed`, `tts-worker-unloaded`, `tts-worker-ready`, and
`tts-worker-disposed`. The nested bootstrap status is exactly
`stt-artifact-module-worker-awaiting-initialization` or
`tts-artifact-module-worker-awaiting-initialization`.

Worker `activeOperation` is `null`, `stt-load`, `tts-load`,
`stt-transcription`, `tts-synthesis`, `stt-status`, `tts-status`, `stt-unload`,
`tts-unload`, `stt-dispose`, or `tts-dispose`. Its own lifecycle starts with
`stt-worker-created` or `tts-worker-created`. Load uses exactly
`stt-load-started`, `stt-load-completed`, `stt-load-cancelled`,
`stt-worker-runtime-configuration-rejected`,
`stt-worker-runtime-import-rejected`, `stt-worker-model-load-rejected`,
`tts-load-started`, `tts-load-completed`, `tts-load-cancelled`,
`tts-worker-runtime-configuration-rejected`,
`tts-worker-runtime-import-rejected`, and
`tts-worker-model-load-rejected`. Use uses exactly
`stt-transcription-started`, `stt-transcription-completed`,
`stt-transcription-cancelled`, `stt-transcription-engine-operation-rejected`,
`tts-synthesis-started`, `tts-synthesis-completed`,
`tts-synthesis-cancelled`, and `tts-synthesis-engine-operation-rejected`; a stable underlying
reason replaces only the matching failure fallback. Orderly Worker teardown
additionally uses `stt-unload-completed`,
`tts-unload-completed`, `stt-worker-engine-dispose-rejected`,
`tts-worker-engine-dispose-rejected`, `stt-dispose-unloaded-worker`,
`tts-dispose-unloaded-worker`, `stt-dispose-completed`, and
`tts-dispose-completed`. A Worker protocol cancel result is
`stt-cancel-target-not-active` or `tts-cancel-target-not-active` when its target
is already settled; otherwise it names the exact cancelled load, transcription,
synthesis, status, unload, or dispose operation.

The Worker client admits only `load`, `use`, `status`, `unload`, and `dispose`.
The transport host additionally admits only its internal `cancel` control
message. Any other `op` rejects as `ARCANE_AI_INVALID_REQUEST` with
message `The speech worker operation is not part of its protocol.` and reason
`stt-worker-operation-unknown` or `tts-worker-operation-unknown` before it can
enter active-operation, cancellation, or serialized-error naming.

Progress records have exactly `{phase,completed,total,unit,heartbeat}`. They do
not add a `role` field; Worker phase names carry the role and the provider
forwards the same provider-neutral record. Graph store phases are exactly
`artifact-graph-network-download`,
`artifact-graph-dbopfs-persisted-rehash`, and
`artifact-graph-dbopfs-cache-rehash`. Worker phases are
`stt-runtime-import-started`, `tts-runtime-import-started`,
`stt-model-load-started`, `tts-model-load-started`,
`stt-model-load-progress`, `tts-model-load-progress`,
`stt-provider-ready`, and `tts-provider-ready`.

`load(context)` requires the exact role/selection and a `progress` function.
Compatible concurrent loads coalesce behind one underlying preparation/Worker
operation while each caller keeps its own progress callback and cancellation
observation. Cancelling or throwing from the last observer aborts that shared
load; one observer cannot cancel another observer that remains attached. A
security change unloads and reloads; graph verification itself can never be
weakened. `request(context)` admits one role operation at a time and otherwise
rejects with `ARCANE_AI_PROVIDER_BUSY`.

An `AbortSignal` before or during graph preparation/load rejects that exact
operation. Once a Worker request has started, cancellation terminates the whole
role Worker, rejects every pending operation, closes private ports, terminates
nested Workers, discards that isolated Worker's guards and runtime settings,
revokes object URLs, and returns the provider to `unloaded`; a later request
requires explicit load. `unload()` uses the same destructive boundary for
active load/use before
releasing state. `dispose()` completes unload and permanently enters
`disposed`. Cancelling an `unload()` or `dispose()` caller rejects only that
caller's wait with the corresponding stable reason; the already-started shared
teardown continues to its terminal state. Late results are generation-checked
and cannot settle a superseded operation.

The provider owns no listener registry or event source. Applications may
project its promises, status, and progress records into the one SDK event/state
authority, and DOM components may project presentation/intent events, but this
package creates no `EventPubSub`, exposes no public `EventTarget` lifecycle
source, and owns no competing listener registry or event bus.

The provider also has no implicit mute flag. A higher-level shared state owner
can implement mute by awaiting the role's explicit `unload()` and unmute by
performing an explicit `load()`; it projects the returned status and progress
without inventing a second provider, listener registry, or background load.

## Stable errors and reasons

Operational graph, provider, client, and Worker rejections expose a stable
`code` and a concise `reason` naming the failed operation or boundary.
`ARCANE_AI_REQUEST_ABORTED` errors use `name:"AbortError"`; an arbitrary
caller `AbortSignal.reason` is retained only as `cause` and cannot replace the
stable public reason. Immediate JavaScript API-shape misuse can instead throw a
plain `TypeError` before an operation exists.

### Compatibility and provider codes

Worker failures cross the private port only in the exact envelope
`{protocol:"arcane-ai-speech-worker-error/1",code,message,reason}`. Its own-key
set must be exactly `code,message,protocol,reason`, every field must be a data
property rather than an accessor, `protocol` and `message` must match the
registered code, and the finite registered code/reason pair must match the
pending role and operation. A missing field, extra string or symbol key,
foreign value, accessor, or cross-role/cross-operation pairing is rejected and
the role Worker is terminated; arbitrary third-party error fields never become
public authority.

| Code | Exact caller-visible reasons |
| --- | --- |
| `ARCANE_AI_MODEL_AUTHORITY_REQUIRED` | `stt-provider-inspection-selection-authority-mismatch`, `tts-provider-inspection-selection-authority-mismatch`, `stt-load-selection-authority-mismatch`, `tts-load-selection-authority-mismatch`, `stt-provider-request-selection-authority-mismatch`, `tts-provider-request-selection-authority-mismatch`, `stt-provider-unload-selection-authority-mismatch`, `tts-provider-unload-selection-authority-mismatch`, `stt-provider-dispose-selection-authority-mismatch`, `tts-provider-dispose-selection-authority-mismatch`, `stt-transcription-model-authority-missing`, `stt-transcription-model-authority-mismatch`, `tts-synthesis-model-authority-missing`, `tts-synthesis-model-authority-mismatch`, `tts-synthesis-voice-not-declared` |
| `ARCANE_AI_INVALID_REQUEST` | The exact context/payload and Worker reasons enumerated immediately below this table. |
| `ARCANE_AI_NOT_READY` | `stt-provider-request-not-ready`, `tts-provider-request-not-ready`, `stt-transcription-rejected-before-load`, `tts-synthesis-rejected-before-load` |
| `ARCANE_AI_PROVIDER_BUSY` | `stt-provider-request-already-active`, `tts-provider-request-already-active` |
| `ARCANE_AI_PROVIDER_DISPOSED` | `stt-provider-load-rejected-after-dispose`, `tts-provider-load-rejected-after-dispose`, `stt-load-rejected-after-dispose`, `tts-load-rejected-after-dispose` |
| `ARCANE_AI_REQUEST_ABORTED` | `stt-provider-inspection-cancelled`, `tts-provider-inspection-cancelled`, `stt-load-cancelled`, `tts-load-cancelled`, `stt-transcription-cancelled`, `tts-synthesis-cancelled`, `stt-unload-cancelled`, `tts-unload-cancelled`, `stt-dispose-cancelled`, `tts-dispose-cancelled`, `stt-status-cancelled`, `tts-status-cancelled`, `artifact-graph-preparation-cancelled` |
| `ARCANE_AI_OPERATION_SUPERSEDED` | `stt-load-rejected-during-unload`, `tts-load-rejected-during-unload`, `stt-load-superseded-by-security-change`, `tts-load-superseded-by-security-change`, `stt-load-superseded-by-unload`, `tts-load-superseded-by-unload`, `stt-transcription-superseded-by-unload`, `tts-synthesis-superseded-by-unload`, `stt-worker-terminated-by-unload`, `tts-worker-terminated-by-unload`, `stt-worker-terminated`, `tts-worker-terminated`, `stt-worker-already-terminated`, `tts-worker-already-terminated` |
| `ARCANE_AI_AUDIO_DECODE_UNAVAILABLE` | `stt-browser-offline-audio-context-unavailable`, `stt-browser-offline-audio-context-construction-rejected`, `stt-browser-audio-decode-method-unavailable` |
| `ARCANE_AI_AUDIO_DECODE_FAILED` | `stt-browser-audio-decode-operation-rejected`, `stt-browser-decoded-audio-not-object`, `stt-browser-decoded-audio-sample-rate-mismatch`, `stt-browser-decoded-audio-frame-length-not-safe-integer`, `stt-browser-decoded-audio-empty`, `stt-browser-decoded-audio-channel-count-not-safe-integer`, `stt-browser-decoded-audio-channel-count-zero`, `stt-browser-decoded-audio-get-channel-data-not-function`, `stt-browser-decoded-audio-channel-read-rejected`, `stt-browser-decoded-audio-channel-not-float32-array`, `stt-browser-decoded-audio-channel-length-mismatch`, `stt-browser-decoded-audio-sample-non-finite` |
| `ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT` | `tts-synthesis-response-format-not-wav` |
| `ARCANE_AI_INVALID_PROVIDER_RESULT` | `stt-transcription-result-text-not-string`, `tts-synthesis-result-not-object`, `tts-synthesis-result-audio-not-float32-array`, `tts-synthesis-result-sample-rate-mismatch`, `tts-synthesis-result-audio-empty`, `tts-synthesis-result-wav-byte-length-overflow`, `tts-synthesis-pcm-result-not-float32array`, `tts-synthesis-pcm-sample-non-finite` |
| `ARCANE_AI_PROVIDER_LOAD_FAILED` | `stt-provider-load-rejected`, `tts-provider-load-rejected` |
| `ARCANE_AI_PROVIDER_REQUEST_FAILED` | `stt-worker-runtime-configuration-rejected`, `tts-worker-runtime-configuration-rejected`, `stt-worker-runtime-import-rejected`, `tts-worker-runtime-import-rejected`, `stt-worker-model-load-rejected`, `tts-worker-model-load-rejected`, `stt-transcription-engine-operation-rejected`, `tts-synthesis-engine-operation-rejected`, `stt-worker-engine-dispose-rejected`, `tts-worker-engine-dispose-rejected`, `stt-worker-dispose-rejected`, `tts-worker-dispose-rejected`, `stt-worker-status-rejected`, `tts-worker-status-rejected` |
| `ARCANE_AI_PROVIDER_UNAVAILABLE` | `speech-worker-fetch-unavailable`, `artifact-graph-fetch-constructor-unavailable`, `artifact-graph-negative-response-constructor-unavailable`, `artifact-graph-module-worker-constructor-unavailable`, `artifact-graph-onnx-wasm-pair-not-materialized`, `transformers-env-backends-onnx-wasm-unavailable`, `transformers-env-allow-local-models-unavailable`, `transformers-env-allow-local-models-assignment-rejected`, `transformers-env-allow-remote-models-unavailable`, `transformers-env-allow-remote-models-assignment-rejected`, `transformers-env-browser-cache-unavailable`, `transformers-env-browser-cache-assignment-rejected`, `transformers-env-fs-cache-unavailable`, `transformers-env-fs-cache-assignment-rejected`, `transformers-env-custom-cache-toggle-unavailable`, `transformers-env-custom-cache-toggle-assignment-rejected`, `transformers-env-custom-cache-unavailable`, `transformers-env-custom-cache-assignment-rejected`, `transformers-env-wasm-paths-unavailable`, `transformers-env-wasm-paths-assignment-rejected`, `transformers-env-num-threads-unavailable`, `transformers-env-num-threads-assignment-rejected`, `transformers-whisper-pipeline-export-missing`, `stt-transcription-method-unavailable`, `kokoro-env-wasm-paths-unavailable`, `kokoro-env-wasm-paths-assignment-rejected`, `kokoro-tts-constructor-export-missing`, `tts-synthesis-method-unavailable` |
| `ARCANE_AI_LOAD_PROGRESS_CALLBACK_THREW` | `stt-load-progress-callback-threw`, `tts-load-progress-callback-threw` at the public provider observer boundary |
| `ARCANE_AI_PROGRESS_CALLBACK_THREW` | `stt-load-progress-callback-threw`, `tts-load-progress-callback-threw` at the internal Worker-client callback boundary |
| `ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH` | `stt-worker-client-authority-mismatch`, `tts-worker-client-authority-mismatch`, `stt-worker-protocol-mismatch`, `tts-worker-protocol-mismatch`, `artifact-graph-private-message-port-established-too-late`, `stt-worker-runtime-transport-mode-mismatch`, `tts-worker-runtime-transport-mode-mismatch` |
| `ARCANE_AI_WORKER_CRASHED` | `stt-worker-crashed`, `tts-worker-crashed` |
| `ARCANE_AI_WORKER_MESSAGE_ERROR` | `stt-worker-message-rejected`, `tts-worker-message-rejected`, `stt-worker-private-message-rejected`, `tts-worker-private-message-rejected`, `stt-worker-progress-envelope-rejected`, `tts-worker-progress-envelope-rejected`, `stt-worker-response-envelope-shape-rejected`, `tts-worker-response-envelope-shape-rejected`, `stt-worker-error-envelope-rejected`, `tts-worker-error-envelope-rejected`, `stt-load-message-rejected`, `tts-load-message-rejected`, `stt-transcription-message-rejected`, `tts-synthesis-message-rejected`, `stt-status-message-rejected`, `tts-status-message-rejected`, `stt-unload-message-rejected`, `tts-unload-message-rejected`, `stt-dispose-message-rejected`, `tts-dispose-message-rejected`, `artifact-graph-private-message-channel-unavailable`, `artifact-graph-private-message-port-unavailable`, `artifact-graph-module-worker-error-envelope-rejected`, `artifact-graph-module-worker-initialization-message-rejected` |
| `ARCANE_AI_WORKER_MESSAGE_REJECTED` | `stt-worker-error-envelope-rejected`, `tts-worker-error-envelope-rejected` when the provider rejects a foreign or missing SDK error brand |
| `ARCANE_AI_UNDECLARED_ARTIFACT` | `speech-worker-artifact-request-method-rejected`, `speech-worker-artifact-request-undeclared`, `speech-worker-cache-open-rejected`, `speech-worker-cache-match-rejected`, `artifact-graph-cache-write-rejected`, `artifact-graph-runtime-request-url-malformed` |
| `ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID` | The exact Worker graph-configuration reasons enumerated below. |
| `ARCANE_AI_ARTIFACT_GRAPH_FETCH_EDGE_UNDECLARED` | `artifact-graph-fetch-edge-undeclared`, `artifact-graph-fetch-edge-undeclared-inactive-runtime-branch-entered`, `artifact-graph-fetch-method-undeclared`, `artifact-graph-fetch-target-undeclared`, `artifact-graph-fetch-guard-bypassed` |
| `ARCANE_AI_ARTIFACT_GRAPH_IMPORT_EDGE_UNDECLARED` | `artifact-graph-dynamic-import-edge-undeclared`, `artifact-graph-dynamic-import-edge-undeclared-inactive-runtime-branch-entered`, `artifact-graph-dynamic-import-target-undeclared` |
| `ARCANE_AI_ARTIFACT_GRAPH_CACHE_EDGE_UNDECLARED` | `artifact-graph-cache-open-edge-undeclared`, `artifact-graph-cache-open-edge-undeclared-inactive-runtime-branch-entered`, `artifact-graph-cache-name-mismatch`, `artifact-graph-cache-read-target-undeclared`, `artifact-graph-cache-open-guard-bypassed`, `artifact-graph-cache-match-guard-bypassed` |
| `ARCANE_AI_ARTIFACT_GRAPH_WORKER_EDGE_UNDECLARED` | `artifact-graph-module-worker-edge-undeclared`, `artifact-graph-module-worker-edge-undeclared-inactive-runtime-branch-entered`, `artifact-graph-module-worker-target-undeclared`, `artifact-graph-module-worker-type-mismatch` |
| `ARCANE_AI_ARTIFACT_GRAPH_ISOLATION_UNAVAILABLE` | The exact guard, typed-array, dynamic-code, timer, storage, and denied-capability reasons enumerated below. |

The exact provider context reasons under `ARCANE_AI_INVALID_REQUEST` are:

| Boundary | Exact reasons |
| --- | --- |
| Context is not an object | `stt-provider-inspection-context-not-object`, `tts-provider-inspection-context-not-object`, `stt-provider-load-context-not-object`, `tts-provider-load-context-not-object`, `stt-provider-request-context-not-object`, `tts-provider-request-context-not-object`, `stt-provider-unload-context-not-object`, `tts-provider-unload-context-not-object`, `stt-provider-dispose-context-not-object`, `tts-provider-dispose-context-not-object` |
| Role does not match | `stt-provider-inspection-role-mismatch`, `tts-provider-inspection-role-mismatch`, `stt-provider-load-role-mismatch`, `tts-provider-load-role-mismatch`, `stt-provider-request-role-mismatch`, `tts-provider-request-role-mismatch`, `stt-provider-unload-role-mismatch`, `tts-provider-unload-role-mismatch`, `stt-provider-dispose-role-mismatch`, `tts-provider-dispose-role-mismatch` |
| Signal is not an `AbortSignal` | `stt-provider-inspection-signal-not-abort-signal`, `tts-provider-inspection-signal-not-abort-signal`, `stt-provider-load-signal-not-abort-signal`, `tts-provider-load-signal-not-abort-signal`, `stt-provider-request-signal-not-abort-signal`, `tts-provider-request-signal-not-abort-signal`, `stt-provider-unload-signal-not-abort-signal`, `tts-provider-unload-signal-not-abort-signal`, `stt-provider-dispose-signal-not-abort-signal`, `tts-provider-dispose-signal-not-abort-signal` |
| Lifecycle context property read rejects | `stt-provider-unload-context-read-rejected`, `tts-provider-unload-context-read-rejected`, `stt-provider-dispose-context-read-rejected`, `tts-provider-dispose-context-read-rejected` |

The other exact provider request reasons under `ARCANE_AI_INVALID_REQUEST` are
`stt-load-progress-callback-not-function`,
`tts-load-progress-callback-not-function`, `stt-provider-operation-mismatch`,
`tts-provider-operation-mismatch`, `stt-transcription-payload-not-object`,
`tts-synthesis-payload-not-object`, and these eight structural payload reasons:
`stt-transcription-payload-not-plain-object`,
`stt-transcription-payload-field-unknown`,
`stt-transcription-payload-accessor-rejected`,
`stt-transcription-payload-required-field-missing`,
`tts-synthesis-payload-not-plain-object`,
`tts-synthesis-payload-field-unknown`,
`tts-synthesis-payload-accessor-rejected`, and
`tts-synthesis-payload-required-field-missing`.

The remaining exact provider input reasons are
`stt-transcription-blob-constructor-unavailable`,
`stt-transcription-audio-not-blob-or-file`,
`stt-transcription-audio-blob-empty`,
`stt-transcription-mime-type-not-string`,
`stt-transcription-mime-type-malformed`,
`stt-transcription-audio-blob-mime-type-not-string`,
`stt-transcription-audio-blob-mime-type-malformed`,
`stt-transcription-audio-blob-mime-type-mismatch`,
`stt-transcription-audio-not-float32-array`,
`stt-transcription-pcm-input-empty`,
`stt-transcription-sample-rate-mismatch`,
`stt-transcription-pcm-sample-non-finite`, `tts-synthesis-text-empty`,
`tts-synthesis-voice-empty`, and `tts-synthesis-speed-out-of-range`.

The exact Worker configuration/input reasons under
`ARCANE_AI_INVALID_REQUEST` are `speech-worker-configuration-missing`,
`speech-worker-runtime-selection-mismatch`, `speech-worker-model-id-empty`,
`speech-worker-model-repository-empty`, `speech-worker-model-revision-empty`,
`speech-worker-model-dtype-empty`, `speech-worker-runtime-entry-empty`,
`speech-worker-materialized-files-missing`,
`speech-runtime-entrypoint-not-materialized`,
`speech-model-sample-rate-not-positive-safe-integer`,
`tts-default-voice-empty`, `artifact-graph-materialized-file-not-object`,
`artifact-graph-materialized-path-empty`,
`artifact-graph-materialized-source-url-empty`,
`artifact-graph-materialized-module-url-empty`,
`artifact-graph-materialized-media-type-empty`,
`artifact-graph-runtime-request-routes-not-array`,
`artifact-graph-materialized-path-ambiguous`,
`artifact-graph-entrypoint-not-materialized`,
`stt-worker-message-envelope-shape-rejected`,
`tts-worker-message-envelope-shape-rejected`,
`stt-worker-operation-unknown`, `tts-worker-operation-unknown`,
`stt-transcription-audio-not-float32array`,
`stt-transcription-sample-rate-mismatch`, `tts-synthesis-text-empty`,
`tts-synthesis-voice-empty`, `tts-synthesis-voice-not-declared`, and
`tts-synthesis-speed-out-of-range`.

The exact `ARCANE_AI_ARTIFACT_GRAPH_CONFIGURATION_INVALID` reasons are
`artifact-graph-worker-configuration-incomplete`,
`artifact-graph-onnx-wasm-configuration-mismatch`,
`artifact-graph-kokoro-voice-inventory-missing`,
`artifact-graph-negative-request-routes-not-array`,
`artifact-graph-runtime-request-route-ambiguous`,
`artifact-graph-module-worker-target-not-materialized`,
`artifact-graph-transform-kind-not-admitted`,
`artifact-graph-transform-module-path-empty`,
`artifact-graph-transform-occurrence-not-positive-safe-integer`,
`artifact-graph-transform-identity-ambiguous`,
`artifact-graph-typed-array-constructor-transform-undeclared`,
`artifact-graph-transformers-cache-edge-ambiguous`,
`kokoro-env-num-threads-field-not-exposed`, and
`transformers-env-num-threads-not-positive-safe-integer`. For each exact edge
subject `cache-open`, `dynamic-import`, `fetch`, and `module-worker`, that code
also admits the six exact endings `edges-not-array`, `edge-not-object`,
`edge-module-path-empty`, `edge-occurrence-not-positive-safe-integer`,
`edge-policy-not-admitted`, and `edge-identity-ambiguous`, joined as
`artifact-graph-{subject}-{ending}`.

`browser-speech-provider-error-reason-unmapped` is a fail-closed internal
sentinel for a provider error constructed without a mapped reason. No current
public operation deliberately selects it.

The published legacy authority/store code-to-reason pairs remain:

| Code | Exact compatibility reason |
| --- | --- |
| `ARCANE_AI_REQUEST_ABORTED` | `browser-speech-artifact-preparation-cancelled` |
| `ARCANE_AI_STORAGE_BUSY` | `browser-speech-artifact-dbopfs-write-lock-unavailable` |
| `ARCANE_AI_STORAGE_UNAVAILABLE` | `browser-speech-artifact-dbopfs-table-unavailable` |
| `ARCANE_AI_STORAGE_DELETE_FAILED` | `browser-speech-artifact-dbopfs-delete-rejected` |
| `ARCANE_AI_STORAGE_READ_FAILED` | `browser-speech-artifact-dbopfs-read-rejected` |
| `ARCANE_AI_ARTIFACT_SOURCE_INVALID` | `browser-speech-artifact-source-body-unreadable` |
| `ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED` | `browser-speech-runtime-module-graph-undeclared` |
| `ARCANE_AI_ARTIFACT_SOURCE_UNAVAILABLE` | `browser-speech-artifact-fetch-unavailable` |
| `ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED` | `browser-speech-artifact-fetch-rejected` |
| `ARCANE_AI_ARTIFACT_SOURCE_CHANGED` | `browser-speech-artifact-source-redirected` |
| `ARCANE_AI_ARTIFACT_SIZE_MISMATCH` | `browser-speech-artifact-byte-length-mismatch` |
| `ARCANE_AI_ARTIFACT_DIGEST_MISMATCH` | `browser-speech-artifact-sha256-mismatch` |
| `ARCANE_AI_ARTIFACT_CACHE_REJECTED` | `browser-speech-artifact-dbopfs-cache-rejected` |
| `ARCANE_AI_ARTIFACT_OFFLINE_MISS` | `browser-speech-artifact-offline-cache-miss` |

### Graph reason/code rule

Graph construction and store errors use
`code = "ARCANE_AI_" + reason.toUpperCase().replaceAll("-", "_")`. The
following closed reason groups therefore define their exact matching codes.

The redirect and source-response descriptor/runtime pairs are exactly:

| Reason | Code |
| --- | --- |
| `artifact-graph-file-source-media-type-missing` | `ARCANE_AI_ARTIFACT_GRAPH_FILE_SOURCE_MEDIA_TYPE_MISSING` |
| `artifact-graph-file-source-media-type-format-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_FILE_SOURCE_MEDIA_TYPE_FORMAT_MISMATCH` |
| `artifact-graph-source-redirect-final-origins-not-array` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGINS_NOT_ARRAY` |
| `artifact-graph-source-redirect-final-origin-inventory-empty` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_INVENTORY_EMPTY` |
| `artifact-graph-source-redirect-final-origin-text-required` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_TEXT_REQUIRED` |
| `artifact-graph-source-redirect-final-origin-whitespace-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_WHITESPACE_REJECTED` |
| `artifact-graph-source-redirect-final-origin-not-absolute` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_NOT_ABSOLUTE` |
| `artifact-graph-source-redirect-final-origin-protocol-not-https` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_PROTOCOL_NOT_HTTPS` |
| `artifact-graph-source-redirect-final-origin-credentials-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_CREDENTIALS_REJECTED` |
| `artifact-graph-source-redirect-final-origin-path-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_PATH_REJECTED` |
| `artifact-graph-source-redirect-final-origin-query-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_QUERY_REJECTED` |
| `artifact-graph-source-redirect-final-origin-fragment-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_FRAGMENT_REJECTED` |
| `artifact-graph-source-redirect-final-origin-duplicate` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_DUPLICATE` |
| `artifact-graph-source-response-url-unreadable` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_RESPONSE_URL_UNREADABLE` |
| `artifact-graph-source-redirected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECTED` |
| `artifact-graph-source-response-url-protocol-not-https` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_RESPONSE_URL_PROTOCOL_NOT_HTTPS` |
| `artifact-graph-source-response-url-credentials-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_RESPONSE_URL_CREDENTIALS_REJECTED` |
| `artifact-graph-source-response-url-fragment-rejected` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_RESPONSE_URL_FRAGMENT_REJECTED` |
| `artifact-graph-source-redirect-final-origin-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_REDIRECT_FINAL_ORIGIN_MISMATCH` |
| `artifact-graph-source-response-url-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_SOURCE_RESPONSE_URL_MISMATCH` |

When an explicit `sourceMediaType` differs from `mediaType`, a cold response
mismatch uses the exact file-kind-specific pair below. When the two fields are
equal, the existing `*-media-type-mismatch` pair applies instead.

| Reason | Code |
| --- | --- |
| `artifact-graph-entrypoint-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_ENTRYPOINT_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-runtime-auxiliary-javascript-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_RUNTIME_AUXILIARY_JAVASCRIPT_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-runtime-wasm-binary-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_RUNTIME_WASM_BINARY_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-runtime-opaque-data-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_RUNTIME_OPAQUE_DATA_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-configuration-json-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_CONFIGURATION_JSON_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-generation-configuration-json-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_GENERATION_CONFIGURATION_JSON_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-onnx-binary-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_ONNX_BINARY_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-onnx-external-data-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_ONNX_EXTERNAL_DATA_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-opaque-data-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_OPAQUE_DATA_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-preprocessor-json-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_PREPROCESSOR_JSON_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-model-tokenizer-json-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_MODEL_TOKENIZER_JSON_SOURCE_MEDIA_TYPE_MISMATCH` |
| `artifact-graph-voice-style-binary-source-media-type-mismatch` | `ARCANE_AI_ARTIFACT_GRAPH_VOICE_STYLE_BINARY_SOURCE_MEDIA_TYPE_MISMATCH` |

Descriptor and identity reasons:

- `artifact-graph-kind-mismatch`, `artifact-graph-role-not-stt-or-tts`,
  `artifact-graph-provider-id-missing`,
  `artifact-graph-provider-id-length-exceeded`,
  `artifact-graph-model-descriptor-missing`,
  `artifact-graph-runtime-descriptor-missing`,
  `artifact-graph-file-inventory-missing`,
  `artifact-graph-file-descriptor-not-object`,
  `artifact-graph-file-kind-missing`,
  `artifact-graph-file-kind-not-admitted`,
  `artifact-graph-file-path-missing`,
  `artifact-graph-file-path-noncanonical`,
  `artifact-graph-file-revision-missing`,
  `artifact-graph-file-revision-length-exceeded`,
  `artifact-graph-file-byte-length-positive-safe-integer-required`,
  `artifact-graph-file-sha256-missing`,
  `artifact-graph-file-sha256-format-mismatch`,
  `artifact-graph-file-license-missing`,
  `artifact-graph-file-license-whitespace-rejected`,
  `artifact-graph-file-license-not-nfc`,
  `artifact-graph-file-license-control-character-rejected`,
  `artifact-graph-file-license-length-exceeded`,
  `artifact-graph-file-media-type-missing`,
  `artifact-graph-file-media-type-format-mismatch`,
  `artifact-graph-file-source-media-type-missing`,
  `artifact-graph-file-source-media-type-format-mismatch`,
  `artifact-graph-file-identity-ambiguous`,
  `artifact-graph-source-url-missing`,
  `artifact-graph-source-url-mutable`,
  `artifact-graph-source-revision-unbound`,
  `artifact-graph-source-redirect-final-origins-not-array`,
  `artifact-graph-source-redirect-final-origin-inventory-empty`,
  `artifact-graph-source-redirect-final-origin-text-required`,
  `artifact-graph-source-redirect-final-origin-whitespace-rejected`,
  `artifact-graph-source-redirect-final-origin-not-absolute`,
  `artifact-graph-source-redirect-final-origin-protocol-not-https`,
  `artifact-graph-source-redirect-final-origin-credentials-rejected`,
  `artifact-graph-source-redirect-final-origin-path-rejected`,
  `artifact-graph-source-redirect-final-origin-query-rejected`,
  `artifact-graph-source-redirect-final-origin-fragment-rejected`,
  `artifact-graph-source-redirect-final-origin-duplicate`,
  `artifact-graph-javascript-media-type-mismatch`,
  `artifact-graph-wasm-media-type-mismatch`,
  `artifact-graph-json-media-type-mismatch`,
  `artifact-graph-entrypoint-path-missing`,
  `artifact-graph-entrypoint-path-noncanonical`,
  `artifact-graph-entrypoint-file-kind-mismatch`,
  `artifact-graph-entrypoint-count-mismatch`,
  `artifact-graph-entrypoint-revision-mismatch`,
  `artifact-graph-runtime-adapter-missing`,
  `artifact-graph-runtime-adapter-role-mismatch`,
  `artifact-graph-runtime-version-missing`,
  `artifact-graph-runtime-version-length-exceeded`,
  `artifact-graph-runtime-revision-missing`,
  `artifact-graph-runtime-revision-length-exceeded`,
  `artifact-graph-onnx-wasm-descriptor-missing`,
  `artifact-graph-onnx-wasm-namespace-missing`,
  `artifact-graph-onnx-wasm-namespace-role-mismatch`,
  `artifact-graph-onnx-wasm-file-kind-mismatch`,
  `artifact-graph-onnx-wasm-num-threads-positive-safe-integer-required`,
  `artifact-graph-negative-runtime-routes-not-array`,
  `artifact-graph-negative-runtime-route-duplicate`,
  `artifact-graph-negative-runtime-route-ambiguous`,
  `artifact-graph-model-id-missing`,
  `artifact-graph-model-id-length-exceeded`,
  `artifact-graph-model-repository-missing`,
  `artifact-graph-model-repository-length-exceeded`,
  `artifact-graph-model-revision-missing`,
  `artifact-graph-model-revision-length-exceeded`,
  `artifact-graph-model-dtype-missing`,
  `artifact-graph-model-dtype-length-exceeded`,
  `artifact-graph-sample-rate-missing`,
  `artifact-graph-sample-rate-positive-safe-integer-required`,
  `artifact-graph-default-voice-missing`,
  `artifact-graph-default-voice-length-exceeded`,
  `artifact-graph-default-voice-undeclared`,
  `artifact-graph-stt-voice-authority-declared`,
  `artifact-graph-stt-voice-file-declared`,
  `artifact-graph-voice-inventory-missing`,
  `artifact-graph-voice-descriptor-not-object`,
  `artifact-graph-voice-id-missing`,
  `artifact-graph-voice-id-length-exceeded`,
  `artifact-graph-voice-file-kind-mismatch`,
  `artifact-graph-voice-inventory-ambiguous`,
  `artifact-graph-voice-file-undeclared`,
  `artifact-graph-model-file-inventory-missing`,
  `artifact-graph-model-file-revision-mismatch`,
  `artifact-graph-file-unreachable`,
  `artifact-graph-runtime-request-routes-not-array`,
  `artifact-graph-runtime-request-url-text-required`,
  `artifact-graph-runtime-request-url-not-absolute`,
  `artifact-graph-runtime-request-url-protocol-not-https`,
  `artifact-graph-runtime-request-url-credentials-rejected`,
  `artifact-graph-runtime-request-url-fragment-rejected`,
  `artifact-graph-runtime-request-route-duplicate`,
  `artifact-graph-runtime-request-route-ambiguous`,
  `artifact-graph-runtime-request-route-unreachable`,
  `artifact-graph-negative-runtime-route-unreachable`,
  `artifact-graph-identity-sha256-text-required`,
  `artifact-graph-identity-sha256-format-mismatch`, and
  `artifact-graph-identity-sha256-mismatch`.

The lower-level field helpers retain the exact reasons
`artifact-graph-field-text-required`, `artifact-graph-identifier-missing`,
`artifact-graph-identifier-length-exceeded`, and
`artifact-graph-positive-safe-integer-required`. A Kokoro thread declaration
raises `kokoro-env-num-threads-field-not-exposed` at graph construction; the
Worker retains that same reason under its defensive graph-configuration
boundary if construction is bypassed.

Edge and transform reasons:

- `artifact-graph-edges-not-object`, `artifact-graph-edge-kind-not-admitted`,
  `artifact-graph-edge-list-not-array`,
  `artifact-graph-edge-not-object`, `artifact-graph-edge-module-path-missing`,
  `artifact-graph-edge-module-path-noncanonical`,
  `artifact-graph-edge-module-path-not-runtime-javascript`,
  `artifact-graph-edge-occurrence-positive-safe-integer-required`,
  `artifact-graph-edge-occurrence-duplicate`,
  `artifact-graph-edge-policy-not-admitted`,
  `artifact-graph-edge-targets-not-array`,
  `artifact-graph-edge-target-not-object`,
  `artifact-graph-edge-target-match-missing`,
  `artifact-graph-edge-target-match-not-admitted`,
  `artifact-graph-edge-target-path-missing`,
  `artifact-graph-edge-target-path-noncanonical`,
  `artifact-graph-edge-target-path-undeclared`,
  `artifact-graph-edge-target-specifier-missing`,
  `artifact-graph-edge-target-duplicate`,
  `artifact-graph-static-import-specifier-missing`,
  `artifact-graph-dynamic-import-policy-target-mismatch`,
  `artifact-graph-module-worker-policy-target-mismatch`,
  `artifact-graph-module-worker-self-target-mismatch`,
  `artifact-graph-fetch-method-not-get`,
  `artifact-graph-fetch-targets-not-array`,
  `artifact-graph-fetch-target-duplicate`,
  `artifact-graph-fetch-javascript-target-rejected`,
  `artifact-graph-fetch-negative-routes-not-array`,
  `artifact-graph-fetch-negative-route-undeclared`,
  `artifact-graph-fetch-targets-incomplete`,
  `artifact-graph-fetch-policy-target-mismatch`,
  `artifact-graph-cache-name-missing`,
  `artifact-graph-cache-targets-not-array`,
  `artifact-graph-cache-target-duplicate`,
  `artifact-graph-cache-javascript-target-rejected`,
  `artifact-graph-cache-policy-target-mismatch`,
  `artifact-graph-transforms-not-array`,
  `artifact-graph-transform-not-object`,
  `artifact-graph-transform-kind-not-admitted`, and
  `artifact-graph-transform-occurrence-duplicate`.

Runtime scan and materialization reasons:

- `artifact-graph-runtime-javascript-file-missing`,
  `artifact-graph-runtime-javascript-utf8-decode-rejected`,
  `artifact-graph-javascript-block-comment-unterminated`,
  `artifact-graph-javascript-escape-unterminated`,
  `artifact-graph-javascript-hexadecimal-escape-malformed`,
  `artifact-graph-javascript-unicode-code-point-escape-malformed`,
  `artifact-graph-javascript-unicode-code-point-out-of-range`,
  `artifact-graph-javascript-unicode-escape-malformed`,
  `artifact-graph-javascript-quoted-string-line-break-rejected`,
  `artifact-graph-javascript-quoted-string-unterminated`,
  `artifact-graph-javascript-regexp-line-break-rejected`,
  `artifact-graph-javascript-regexp-unterminated`,
  `artifact-graph-javascript-template-expression-unterminated`,
  `artifact-graph-javascript-template-literal-unterminated`,
  `artifact-graph-javascript-escaped-identifier-rejected`,
  `artifact-graph-runtime-fetch-direct-call-required`,
  `artifact-graph-runtime-fetch-receiver-not-global`,
  `artifact-graph-runtime-cache-open-direct-call-required`,
  `artifact-graph-runtime-cache-open-receiver-not-global`,
  `artifact-graph-runtime-worker-constructor-call-required`,
  `artifact-graph-runtime-worker-receiver-not-global`,
  `artifact-graph-runtime-guard-reference-reserved`,
  `artifact-graph-runtime-dynamic-code-undeclared`,
  `artifact-graph-runtime-computed-dynamic-code-undeclared`,
  `artifact-graph-runtime-constructor-dynamic-code-undeclared`,
  `artifact-graph-runtime-edge-undeclared`,
  `artifact-graph-runtime-edge-declaration-unmatched`,
  `artifact-graph-runtime-edge-occurrence-noncanonical`,
  `artifact-graph-static-import-specifier-mismatch`,
  `artifact-graph-static-import-specifier-unresolved`,
  `artifact-graph-static-import-target-unmaterialized`,
  `artifact-graph-runtime-static-import-cycle`,
  `artifact-graph-module-transform-overlap`,
  `artifact-graph-guard-capability-unavailable`,
  `artifact-graph-object-url-platform-unavailable`,
  `artifact-graph-object-url-scheme-not-blob`,
  `artifact-graph-object-url-identity-ambiguous`,
  `artifact-graph-object-url-readback-unavailable`,
  `artifact-graph-object-url-readback-http-status-rejected`,
  `artifact-graph-object-url-readback-identity-mismatch`,
  `artifact-graph-object-url-media-type-mismatch`,
  `artifact-graph-object-url-byte-length-mismatch`, and
  `artifact-graph-object-url-sha256-mismatch`.

Source, cache, and security reasons:

- `artifact-graph-load-security-contract-rejected`,
  `artifact-graph-source-fetch-rejected`,
  `artifact-graph-source-http-response-rejected`,
  `artifact-graph-source-redirected`,
  `artifact-graph-source-response-url-unreadable`,
  `artifact-graph-source-response-url-protocol-not-https`,
  `artifact-graph-source-response-url-credentials-rejected`,
  `artifact-graph-source-response-url-fragment-rejected`,
  `artifact-graph-source-redirect-final-origin-mismatch`,
  `artifact-graph-source-response-url-mismatch`,
  `artifact-graph-offline-cache-miss`, and
  `artifact-graph-preparation-cancelled`.

For an exact file verification failure, `reason` is
`artifact-graph-{subject}-{boundary}`. `{subject}` is `entrypoint` for
`runtime-entrypoint-javascript`; otherwise it is the exact file kind from the
closed kind table. `{boundary}` is one of `media-type-mismatch`,
`source-media-type-mismatch`, `byte-length-mismatch`, `sha256-mismatch`,
`dbopfs-persisted-byte-length-mismatch`, or
`dbopfs-persisted-sha256-mismatch`. `source-media-type-mismatch` occurs only
when an explicit `sourceMediaType` differs from `mediaType`; otherwise a source
Content-Type mismatch uses `media-type-mismatch`. This expansion produces the
exact public code by the rule above; for example,
`artifact-graph-entrypoint-sha256-mismatch` becomes
`ARCANE_AI_ARTIFACT_GRAPH_ENTRYPOINT_SHA256_MISMATCH`.

The other exact isolation reasons are
`artifact-graph-private-message-port-missing`,
`artifact-graph-guard-global-collision`,
`artifact-graph-guard-global-definition-rejected`,
`artifact-graph-guard-capability-mismatch`,
`artifact-graph-fetch-isolation-unavailable`,
`artifact-graph-cache-isolation-unavailable`,
`speech-worker-fetch-isolation-unavailable`,
`speech-worker-cache-isolation-unavailable`,
`artifact-graph-typed-array-validation-unavailable`,
`artifact-graph-typed-array-constructor-receiver-not-typed-array`,
`artifact-graph-typed-array-constructor-intrinsic-mismatch`,
`artifact-graph-dynamic-code-constructor-rejected`,
`artifact-graph-dynamic-code-constructor-isolation-unavailable`,
`artifact-graph-setinterval-isolation-unavailable`,
`artifact-graph-settimeout-isolation-unavailable`,
`artifact-graph-setinterval-string-callback-rejected`,
`artifact-graph-settimeout-string-callback-rejected`,
`artifact-graph-indexeddb-isolation-unavailable`, and
`artifact-graph-opfs-isolation-unavailable`.

The denied-capability Worker reasons are
`artifact-graph-{capability}-capability-undeclared` and
`artifact-graph-{capability}-isolation-unavailable`, where `{capability}` is
exactly `broadcastchannel`, `eventsource`, `function`, `rtcpeerconnection`,
`shadowrealm`, `sharedworker`, `websocket`, `websocketstream`, `webtransport`,
`worker`, `xmlhttprequest`, `eval`, or `importscripts`.

## `createBrowserSpeechAuthority()` upstream package mode

`BROWSER_SPEECH_ARTIFACT_PROTOCOL` remains exactly
`arcane-ai-browser-speech-artifacts/1`, and
`createBrowserSpeechAuthority({providerId,role,model,runtime,security})`
loads a caller-selected browser bundle from npm or another upstream package
authority. The SDK stores only the downloaded application-selected entrypoint;
the runtime uses its normal provider fetch and browser cache behavior. Its
optional byte/SHA checks still resolve independently from SDK default to app,
provider, and load scopes. Its cache values remain `installed` and `cached`,
and its offline miss remains `ARCANE_AI_ARTIFACT_OFFLINE_MISS`.

The model descriptor is
`{id,repository,revision,defaultVoice?,files?}`; `defaultVoice` is required only
for `tts`. In default warn-first mode `files` may be omitted so the selected
provider downloads its own model and voice assets. The runtime descriptor is
`{adapter,version,revision,entry,wasmPaths?,files}` and its adapter is exactly
`transformers-whisper` for `stt` or `kokoro-js` for `tts`. Every legacy file is
`{path,url,bytes?,sha256?,mediaType?}` with a normalized relative path, a
unique immutable URL containing the descriptor revision or SHA-256 identity,
and optional positive byte length and SHA-256. Legacy SHA input is normalized
to lowercase before validation and projection. `runtime.entry` must
name the one `text/javascript` `.js` or `.mjs` runtime file. The frozen result
is
`{protocol,providerId,modelId,admitted,role,repository,revision,defaultVoice,runtime,files,security}`.

`runtime.wasmPaths` may name a version-pinned upstream npm CDN directory in
warn-first mode. `secure:true` rejects remote `wasmPaths`, requires explicit
model files, applies the closed-module scan, and replaces ordinary fetch/cache
access with the admitted file map. The authenticated artifact graph remains an
advanced strict-control option; it is not required for normal speech use.

## Security and ownership summary

- The SDK redistributes no speech runtime, model, voice, third-party license,
  or corresponding-source payload. Explicit `load()` resolves them from the
  caller-selected npm/package/provider authorities.
- Default direct-authority operation is warn-first and preserves ordinary
  upstream fetch/cache behavior. An artifact graph is admitted only when
  `secure:true` explicitly opts into strict graph/file verification and
  capability isolation.
- Every graph byte is caller-selected, immutable, exact-length, SHA-256 bound,
  revision bound, media-type bound, license-declaration bound, and reachable
  through one closed graph identity.
- Redirects are rejected by default. An undeclared redirect, an undeclared or
  non-HTTPS final origin, a mutable starting source authority, an ambiguous
  path/route, an undeclared code/data edge, a raw network transport, a cache
  write, or an incomplete offline closure fails closed.
- DBOPFS is the sole durable artifact store; the Worker sees only authenticated
  local object bytes and an exact read-only cache facade.
- Runtime/model/sample-rate/default-voice/voice inventory and optional
  Transformers thread count remain caller authority. No hardware heuristic,
  hidden fallback, startup download, native/Core call, or cloud retry is added.
- A completion manifest and SHA-256 prove consistency with the caller's graph;
  they are not independent publisher authenticity or complete license evidence.
- The component resolution record is
  `browser-runtime/ai/ARCANE_AI_BROWSER_SPEECH_COMPONENTS.json`; the detailed
  package/model audit is `docs/reference/ai/browser-speech-package-authority.json`.
- Upstream publishers remain responsible for their distributed package and
  provider assets. Applications own selected model/voice policy and integration
  with the one shared SDK state/event owner.

## Related

- [Normalized AI](../README.md#normalized-ai)
- [Browser-WASM LLM](browser-wasm.md)
- [AIProviderRuntime.js](../runtime-modules.md#aiproviderruntimejs)
- [AIRuntimeState.js](../runtime-modules.md#airuntimestatejs)
- [Availability and normalization](../availability-and-normalization.md)
- [Protocol architecture](../protocols.md#portable-ai-provider-runtime)
