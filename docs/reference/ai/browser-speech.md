# Browser speech providers

`arcane-os/ai/browser-speech` is the browser-only SDK boundary for
caller-selected Whisper speech-to-text and Kokoro text-to-speech runtimes. It
provides artifact storage, live module routing, role Workers, provider/2
adapters, bounded parallel TTS synthesis, audio normalization, cancellation,
and cleanup.

The SDK does not choose a runtime, model, voice, catalog, prompt, or product
policy. Applications keep those choices. Nothing is downloaded or activated
until the application explicitly calls `load()`.

Ordinary speech operation is the complete functional path. It uses the selected
upstream Transformers or Kokoro package and the browser's normal networking,
Worker, and Cache APIs. The records returned by this entrypoint are ordinary
JavaScript objects and arrays. Callers may copy, extend, and present complete
records; this contract does not freeze them or shorten their content.

## Availability

| Host | Availability | Notes |
| --- | --- | --- |
| Browser | Shipped | Requires Workers, Fetch, Blob/File, object URLs, DBOPFS/OPFS, and Web Locks. Blob/File STT requests also require the browser audio decoder. |
| Native WebView | Conditional | Available when the WebView exposes the browser APIs above. It does not invoke Core speech. |
| Node | Importable, execution unavailable | The ESM subpath imports, but the SDK supplies no Node speech storage, Worker, or audio-decoder host. |
| Cloud | Not offered | The SDK's built-in speech profile is device-only: Whisper owns STT and Kokoro owns TTS. |

STT and TTS own independent provider lifecycles. A failure or cancellation in
one role does not disable the other role or authorize a fallback provider.

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

Importing this entrypoint downloads nothing, opens no cache, creates no Worker,
and publishes no event.

## Protocol identifiers

These exact strings identify the current public contracts:

| Subject | Exact value |
| --- | --- |
| Artifact-store protocol | `arcane-ai-browser-speech-artifacts/1` |
| Artifact-graph protocol | `arcane-ai-browser-speech-artifact-graph/1` |
| Graph `kind` and prepared `runtime.moduleGraph` | `browser-speech-authenticated-artifact-graph` |
| Single-module `runtime.moduleGraph` | `self-contained` |
| Model authority | `arcane-ai-model-authority/1` |
| Provider | `arcane-ai-provider/2` |
| Worker | `arcane-ai-speech-worker/1` |
| Worker error envelope | `arcane-ai-speech-worker-error/1` |
| Nested module Worker | `arcane-ai-browser-speech-artifact-module-worker/1` |

The word `authenticated` in the graph discriminator does not activate an
authentication, admission, or isolation stage. It is the current protocol
value.

## `createBrowserSpeechArtifactGraph()`

An artifact graph describes the caller-selected runtime, model, voice, and
supporting files that the SDK stores and materializes. It is a routing and
selection record, not an execution permission list.

```javascript
const graph = createBrowserSpeechArtifactGraph({
  providerId: 'my-whisper',
  role: 'stt',
  model: {
    id: 'whisper-small',
    repository: 'publisher/whisper-small',
    revision: 'selected-model-revision',
    dtype: 'q8',
    inputSampleRate: 16000
  },
  runtime: {
    adapter: 'transformers-whisper',
    version: 'selected-runtime-version',
    revision: 'selected-runtime-revision',
    entrypoint: 'runtime/transformers.js',
    onnxWasm: {
      namespace: 'transformers-env-backends-onnx-wasm',
      mjsPath: 'runtime/ort-wasm.mjs',
      wasmPath: 'runtime/ort-wasm.wasm'
    }
  },
  files: [
    {
      kind: 'runtime-entrypoint-javascript',
      path: 'runtime/transformers.js',
      sourceUrl: 'https://publisher.example/transformers.js',
      revision: 'selected-runtime-revision',
      mediaType: 'text/javascript'
    },
    {
      kind: 'runtime-auxiliary-javascript',
      path: 'runtime/ort-wasm.mjs',
      sourceUrl: 'https://publisher.example/ort-wasm.mjs',
      revision: 'selected-runtime-revision',
      mediaType: 'text/javascript'
    },
    {
      kind: 'runtime-wasm-binary',
      path: 'runtime/ort-wasm.wasm',
      sourceUrl: 'https://publisher.example/ort-wasm.wasm',
      revision: 'selected-runtime-revision',
      mediaType: 'application/wasm'
    },
    {
      kind: 'model-onnx-binary',
      path: 'model/encoder.onnx',
      sourceUrl: 'https://publisher.example/encoder.onnx',
      revision: 'selected-model-revision',
      mediaType: 'application/octet-stream',
      runtimeRequestUrls: [
        'https://publisher.example/model/encoder.onnx'
      ]
    }
  ]
});
```

### Model and runtime selection

`role` is `stt` or `tts`. The runtime adapter is
`transformers-whisper` for STT and `kokoro-js` for TTS. The caller supplies the
model id, repository, revision, dtype, sample rate, and runtime version and
revision.

STT requires `model.inputSampleRate`. TTS requires
`model.outputSampleRate`, `model.defaultVoice`, and a nonempty
`model.voices` array of `{id,path}` records. Each voice path names a declared
`voice-style-binary` file. `runtime.onnxWasm` names the selected ONNX module and
WASM files. `numThreads` is optional for Transformers and is not inferred from
hardware. Kokoro does not expose that field.

### File records

Each file record uses:

```text
{
  kind,
  path,
  sourceUrl,
  revision,
  license?,
  mediaType,
  sourceMediaType?,
  runtimeRequestUrls?
}
```

`path` is a normalized relative path. `sourceUrl` is the caller-selected source
used for installation. `runtimeRequestUrls` lists aliases used by upstream
runtime code for the same stored file. `mediaType` becomes the materialized
Blob type; `sourceMediaType` may describe a different upstream response type.
The SDK does not require or interpret legal metadata at runtime. If the caller
includes `license`, the graph preserves that complete value as inert metadata;
runtime materialization never treats it as capability or admission data.

Runtime file kinds are `runtime-entrypoint-javascript`,
`runtime-auxiliary-javascript`, `runtime-wasm-binary`, and
`runtime-opaque-data`. Model/data kinds are `model-configuration-json`,
`model-generation-configuration-json`, `model-onnx-binary`,
`model-onnx-external-data`, `model-preprocessor-json`,
`model-tokenizer-json`, `model-opaque-data`, and `voice-style-binary`.

Graph construction requires paths and route aliases to be unambiguous so one
known URL maps to at most one stored file. The runtime router is independently
permissive: if ambiguous routing metadata nevertheless reaches it, that
URL is left unmapped and uses the native browser operation.

## `createDbopfsSpeechArtifactStore()`

```javascript
const store = createDbopfsSpeechArtifactStore({
  dbopfs,
  tableName: 'arcane_ai_browser_speech'
});
```

The store exposes `{protocol,tableName,prepare,remove}`. It serializes updates
to one selected authority with Web Locks, downloads each caller-selected file
after explicit provider activation, stores it in DBOPFS, and reopens the stored
file before materialization. Missing storage, an unreadable response, a failed
HTTP request, a missing stored file, or cancellation rejects honestly.

The store writes ordinary mutable selection metadata before the selected files.
On a later load, a changed file inventory or source mapping is a cache miss and
is downloaded again. The selection metadata is not a completion, integrity, or
publication receipt and never blocks ordinary loading.

`prepare(authority,{signal,onProgress,offline=false,security})` accepts an
SDK-created artifact graph or upstream-package authority. `offline:true` uses
only existing DBOPFS state. Preparation returns the selected runtime/model
configuration, `cache` as `installed` or `cached`, object URLs, and a `release()`
function that revokes the materialized URLs.

`security` records caller intent only. Ordinary preparation does not
forward a security payload to the Worker and performs no security work. Passing
`{secure:true}` does not activate hardening. Any future hardening stage requires
a separate user review and an explicit implementation change before it may execute.

## Ordinary module routing

Artifact-graph preparation reads each stored JavaScript module, discovers
ordinary module operations, and materializes the complete stored files as
object URLs. The prepared runtime retains the existing
`browser-speech-authenticated-artifact-graph` discriminator.

The Worker installs one private module router before importing the entrypoint:

- a static import whose target is a known stored file uses that file's
  materialized URL;
- a dynamic import whose target is known imports the materialized URL;
- a fetch whose target is known reads the materialized URL;
- a Worker whose target is known starts the SDK role Worker and imports the
  materialized target there; and
- a Cache match whose target is known returns the materialized file.

Every unmapped operation keeps ordinary browser behavior:

- an unmapped relative or URL-like import resolves against the calling module's
  original source URL, while a bare specifier remains unchanged for native
  import-map resolution;
- an unmapped fetch calls native `fetch` and preserves the caller's options;
- an unmapped Worker calls the native `Worker` constructor and preserves the
  caller's options; and
- an unmapped Cache operation delegates to native Cache Storage.

Cache `put`, `add`, `addAll`, `delete`, and `keys` are normal mutable browser
operations. The SDK does not replace them with a read-only cache. Relative
requests are resolved from the calling module's original source URL before the
native Cache operation.

Routing discovery is best effort and is not an admission gate. If the scanner
cannot interpret a module, that module is left unchanged and follows its native
URLs. A static-import cycle may likewise retain an original source URL where a
target has not yet been materialized. These fallbacks preserve functionality;
they do not silently convert into a rejection policy.

## ONNX runtime configuration

The Worker applies only the selected runtime settings needed to run the chosen
provider:

- Kokoro forwards the pool's selected `webgpu` or `wasm` device to
  `KokoroTTS.from_pretrained()`. Its configured dtype remains exactly the
  caller-selected dtype on both paths. The WASM path also uses
  `namespace.env.wasmPaths = {mjs,wasm}`.
- Transformers uses
  `namespace.env.backends.onnx.wasm.wasmPaths = {mjs,wasm}`, keeps remote model
  loading enabled, and applies caller-selected `numThreads` when present.

Transformers and Kokoro keep their normal provider downloads and Cache behavior
for routes not materialized by the SDK. Kokoro voice aliases and Transformers
model aliases may be listed in `runtimeRequestUrls` so an upstream request for a
known file resolves to the already materialized local file. Model, voice, and
runtime selection remains with the application and upstream publisher.

## Providers

```javascript
const whisper = createBrowserWhisperProvider({
  id: 'my-whisper',
  graph,
  store
});

const kokoro = createBrowserKokoroProvider({
  id: 'my-kokoro',
  graph: kokoroGraph,
  store,
  execution: {
    device: 'auto',
    maxConcurrentRequests: 2
  }
});
```

The constructors also accept ordinary `model` and `runtime` descriptors instead
of `graph`; the two forms are mutually exclusive. Both forms require an
SDK-created DBOPFS speech artifact store. `localOnly` remains `true`.

Kokoro additionally accepts the exact `execution` record
`{device,maxConcurrentRequests}`. `device` is `auto`, `webgpu`, or `wasm`;
`maxConcurrentRequests` is an integer from 1 through 4. Omission defaults to
`{device:'auto',maxConcurrentRequests:2}`. `auto` attempts a complete WebGPU
Worker pool only when the browser exposes WebGPU. If that pool cannot load, the
SDK tears it down and creates a complete WASM pool with the same caller-selected
model and dtype. Explicit `webgpu` rejects when WebGPU cannot load; explicit
`wasm` never attempts GPU. Whisper remains one WASM Worker and does not accept
this option.

Each constructor returns an `arcane-ai-provider/2` object with:

```text
{
  protocol,
  role,
  id,
  localOnly,
  maxConcurrentRequests,
  catalog,
  inspect,
  status,
  load,
  request,
  unload,
  dispose
}
```

`catalog()`, `inspect()`, and `status()` do not activate a provider. `load()` is
the explicit activation boundary. The caller supplies model/profile policy and
may display the provider's lifecycle status. `unload()` releases the Worker and
materialized URLs. `dispose()` performs final teardown and prevents later use.

### Upstream-package authority

`createBrowserSpeechAuthority({providerId,role,model,runtime,security})` creates
the ordinary single-entrypoint authority. The model descriptor is
`{id,repository,revision,dtype?,defaultVoice?,files?}`. The runtime descriptor is
`{adapter,version,revision,entry,wasmPaths?,files}`. A file is
`{path,url,mediaType?}`. Model files may be omitted so the selected upstream
provider performs its normal model and voice downloads after explicit use.

The authority record is a mutable complete record. An omitted ordinary security
option produces no security field. A present `{secure:true}` value records only
the caller's future intent and does not change loading or routing behavior.

### Whisper STT

```javascript
const result = await whisper.request({
  role: 'stt',
  operation: 'transcribe',
  signal,
  payload: {
    audio: pcmFloat32,
    sampleRate: 16000
  }
});
```

The provider-native payload is mono `Float32Array` PCM at the selected input
sample rate, and the result is `{text}`. The shared AI form accepts
`{audio:Blob|File,mimeType,model}` and uses the browser decoder to produce the
same mono input. The SDK preserves the complete returned transcript.

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

The voice belongs to the caller-selected inventory; omission uses that model's
default voice. The provider-native result is
`{audio:Float32Array,sampleRate,voice}`. The shared AI form accepts
`{model,input,responseFormat:'wav',voice?,speed?}` and returns
`{audio:Uint8Array,contentType:'audio/wav'}`. Returned records remain ordinary
mutable values.

## Lifecycle and cancellation

Provider states are `unloaded`, `loading`, `ready`, `unloading`, `error`, and
`disposed`. `status()` includes role, provider/model ids, state, lifecycle
status and reason, active operation, loaded/busy flags, generation, error code,
cache state, and warnings. Kokoro status also includes an `execution` record
with requested and selected device, request limit, and active request count. A
successful `selectedDevice:'webgpu'` reports the execution provider selected by
the upstream model load; it does not claim that browser, driver, or GPU kernels
overlap physically. A security field is absent in ordinary mode.

The provider/2 load context accepts an optional progress callback for interface
compatibility, but the current browser-speech artifact and Worker transport
publishes no progress records. Consumers present the explicit lifecycle states
instead of inventing a numeric total.

Compatible concurrent loads share one underlying preparation and pool load
while each caller retains its own cancellation signal. One observer cannot
cancel another still-active observer; cancellation of the final observer stops
the shared load.

Whisper retains one active role request. Kokoro admits synthesis requests up to
its declared capacity and rejects a direct over-capacity call with
`ARCANE_AI_PROVIDER_BUSY`; the provider-neutral runtime keeps overflow in FIFO
order. Each Kokoro slot owns a distinct Worker and loaded model session because
the selected browser adapter serializes inference inside one JavaScript
isolate. The SDK prepares the artifact URLs once and shares that same prepared
selection across the bounded pool. Pool activation completes the first model
session before it starts the remaining Workers, then loads those remaining
sessions concurrently. This avoids multiplying simultaneous cold artifact
acquisition while still making the configured synthesis capacity ready in
parallel.

Cancellation of one active Kokoro synthesis suppresses only that request and
sends the Worker's targeted cancel control. The selected upstream Kokoro
version may finish already-running engine work before that slot can run its
next request; the SDK does not claim stronger per-call preemption. Whisper
cancellation and role unload/dispose retain destructive Worker teardown.
Kokoro unload/dispose abort every active request, terminates every pool Worker,
and releases materialized URLs once. Late results cannot settle a cancelled or
superseded operation.

The provider owns no event bus. Applications may project promises and status
into the SDK's shared event/state owner. Mute and unmute are likewise
application state: mute may await `unload()`, and unmute may explicitly call
`load()`.

## Errors

Errors retain the normal `code`, `message`, `reason`, and `cause` fields used by
the browser AI runtime.

The Worker error envelope carries `cause` as an optional mutable diagnostic
record. It preserves complete nested messages, stacks, codes, reasons, details,
own properties, and cycles without a depth or content cap. Worker and client
sources must come from the same SDK revision so their `/1` envelope shape is
updated atomically; a current client still accepts the cause-free four-field form.
If the platform cannot clone an exotic diagnostic value, the Worker keeps the
complete raw failure in its console diagnostics and retries the response with
that cause-free four-field envelope so the caller still receives an error.

Representative stable codes include:

- `ARCANE_AI_INVALID_REQUEST`
- `ARCANE_AI_MODEL_AUTHORITY_REQUIRED`
- `ARCANE_AI_PROVIDER_UNAVAILABLE`
- `ARCANE_AI_PROVIDER_BUSY`
- `ARCANE_AI_PROVIDER_DISPOSED`
- `ARCANE_AI_REQUEST_ABORTED`
- `ARCANE_AI_OPERATION_SUPERSEDED`
- `ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED`
- `ARCANE_AI_ARTIFACT_OFFLINE_MISS`
- `ARCANE_AI_STORAGE_BUSY`
- `ARCANE_AI_STORAGE_UNAVAILABLE`
- `ARCANE_AI_WORKER_MESSAGE_ERROR`

Malformed selected descriptors, missing required files, unreadable responses,
unsupported provider namespace shapes, and unavailable browser APIs reject at
their functional owner. An unmapped runtime route retains the native browser
operation.

## Ownership

- Applications own model, runtime, dtype, sample-rate, voice, profile, prompt,
  catalog, activation, optional TTS execution override, and presentation
  policy.
- Upstream publishers own their runtime, model, voice, and license delivery.
- The SDK owns storage, materialization, routing, Worker lifecycle, normalized
  provider contracts, cancellation, and cleanup.
- The SDK redistributes no third-party runtime, model, or voice package through
  this entrypoint.

## Related

- [Normalized AI](../README.md#normalized-ai)
- [Browser-WASM LLM](browser-wasm.md)
- [AIProviderRuntime.js](../runtime-modules.md#aiproviderruntimejs)
- [AIRuntimeState.js](../runtime-modules.md#airuntimestatejs)
- [Availability and normalization](../availability-and-normalization.md)
- [Protocol architecture](../protocols.md#portable-ai-provider-runtime)
