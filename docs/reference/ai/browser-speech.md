# Browser speech providers

`arcane-os/ai/browser-speech` is the shipped browser-only provider package for
caller-supplied Whisper speech-to-text and Kokoro text-to-speech runtimes. It
implements the same provider-neutral role contract used by
`AIProviderRuntime.js`; it does not ship model weights, runtime adapter bytes,
voices, download URLs, a catalog, or a cloud fallback.

Use this page when an application deliberately owns browser-local speech model
and runtime selection. For ordinary application AI lifecycle and status, start
with the [normalized AI guide](../README.md#normalized-ai) and
[`AIProviderRuntime.js`](../runtime-modules.md#aiproviderruntimejs).

## Availability

| Host | Availability | Notes |
| --- | --- | --- |
| Browser | Shipped | Requires DBOPFS/OPFS, Web Locks, Workers, Fetch or an injected fetch function, Blob/File, and object URLs. |
| Native WebView | Conditional | Works only when the WebView exposes the same browser APIs and the application admits every artifact. This does not invoke Core speech. |
| Node | Importable, execution unavailable | The ESM subpath is exported, but `0.2.2` publishes no Node speech storage, Worker, audio-decoder, or execution adapter. |
| Cloud | Not provided | A cloud speech provider can implement `arcane-ai-provider/2`, but this package never selects one. |

Browser speech is independent from `arcane-os/ai/browser-wasm`: the Wllama
entrypoint owns the LLM role, while this entrypoint owns optional STT and TTS
providers. Each role loads, unloads, reports status, cancels, and recovers
independently.

## Import

```javascript
import {
  BROWSER_SPEECH_ARTIFACT_PROTOCOL,
  createBrowserKokoroProvider,
  createBrowserSpeechAuthority,
  createBrowserWhisperProvider,
  createDbopfsSpeechArtifactStore
} from 'arcane-os/ai/browser-speech';
```

The entrypoint exports exactly those five names. Importing it downloads no
model and starts no Worker.

## `BROWSER_SPEECH_ARTIFACT_PROTOCOL`

The constant is exactly `"arcane-ai-browser-speech-artifacts/1"`. It identifies
an SDK-created artifact store; it is not model authority, a capability grant,
or evidence that a cache is complete.

## `createBrowserSpeechAuthority()`

```text
createBrowserSpeechAuthority({
  providerId,
  role,
  model,
  runtime,
  security
} = {})
```

Validates and freezes one caller-owned model/runtime declaration. Construction
binds the declared identities and descriptor rules; actual downloaded or cached
runtime-graph closure is validated by `store.prepare()` before a Worker starts.

### Authority input

| Field | Contract |
| --- | --- |
| `providerId` | Trimmed 1–128 character provider identity. |
| `role` | Exactly `"stt"` or `"tts"`. |
| `model.id` | Caller-owned model identity. |
| `model.repository` | Immutable logical repository identity; the SDK does not resolve it. |
| `model.revision` | Caller-pinned revision. Every model URL must contain this revision or its supplied SHA-256. |
| `model.files` | Nonempty unique `{path,url,bytes?,sha256?,mediaType?}[]`. Paths are normalized relative paths; URLs are immutable HTTPS or same-origin URLs without credentials/fragments. |
| `model.defaultVoice` | Required only for TTS. |
| `runtime.adapter` | Exactly `"transformers-whisper"` for STT or `"kokoro-js"` for TTS. |
| `runtime.version` / `runtime.revision` | Caller-pinned runtime identity. |
| `runtime.entry` | Path of one JavaScript module in `runtime.files`. |
| `runtime.files` | Nonempty immutable runtime closure. The entry module must be self-contained: undeclared imports, re-exports, executable strings, alternate transports, and child workers are rejected. |
| `security` | Closed `{secure?,checks?:{byteLength?,sha256?}}` artifact policy. Disabled checks are disclosed rather than silently claimed. |

The result is a frozen `arcane-ai-model-authority/1` record. The SDK owns the
validation rules; the application owns every model/runtime choice, license,
revision, URL, hash, voice, and business policy.

Provider security resolves each field independently in this order: SDK default,
`appSecurity`, provider `security`, then `load({security})`. The SDK default is
`secure:false`. After resolution, each omitted check defaults to the effective
`secure` value; an explicit `checks.byteLength` or `checks.sha256` boolean
overrides that default. An enabled check requires the corresponding `bytes` or
`sha256` field on every admitted artifact and fails closed when evidence is
missing or mismatched. A disabled check never becomes a claim that bytes were
verified. Direct `store.prepare()` has only its supplied security scope above
the SDK default because it is not bound to a provider.

## `createDbopfsSpeechArtifactStore()`

```text
createDbopfsSpeechArtifactStore({
  dbopfs,
  tableName = 'arcane_ai_browser_speech',
  fetchImpl = null,
  objectUrlFactory = null
} = {})
```

Adapts an existing DBOPFS instance into an authority-scoped store. The returned
frozen object exposes `{protocol,tableName,prepare,remove}`.

`prepare(authority,{signal,onProgress,offline=false,security})`:

1. obtains an exclusive Web Lock for the exact authority;
2. admits a complete cached manifest when every record still matches;
3. otherwise, unless `offline:true`, downloads every declared file without
   credentials;
4. enforces enabled byte-length and SHA-256 checks;
5. validates the closed runtime module graph;
6. commits `arcane.ai.browser-speech.assets.v1` only after every file succeeds;
7. returns materialized object URLs plus a `release()` callback.

An installation or cache-validation failure removes incomplete stored state for
that authority. A request or provider-use failure does not imply cache removal.
`offline:true` never falls back to network and rejects with
`ARCANE_AI_ARTIFACT_OFFLINE_MISS` when no admitted cache exists.

## `createBrowserWhisperProvider()`

```text
createBrowserWhisperProvider({
  id = 'arcane-browser-whisper',
  localOnly = true,
  model,
  runtime,
  appSecurity,
  security,
  store,
  offline = false
} = {})
```

Returns a frozen `arcane-ai-provider/2` object for role `stt`. The provider
surface is `{protocol,role,id,localOnly,catalog,inspect,status,load,request,
unload,dispose}`.

The only request operation is `transcribe`:

```javascript
async function transcribeAfterUserChoice(provider, pcmFloat32, signal) {
  // The admitted Whisper provider must already be ready.
  const result = await provider.request({
    role: 'stt',
    operation: 'transcribe',
    signal,
    payload: {
      audio: pcmFloat32,
      sampleRate: 16_000
    }
  });

  console.log(result.text);
}
```

`audio` must be a `Float32Array` sampled at exactly 16,000 Hz. The provider-native
provider result is a structured `{text}` record transferred by Worker
`postMessage`; the client does not re-freeze that cloned record. The same
provider also accepts the shared AI.js STT
payload `{audio:Blob|File,mimeType,model}`. It verifies `model`, decodes the
browser audio to authoritative 16 kHz mono PCM, and then enters the same provider-native
provider operation. Decode support and failure remain explicit.

## `createBrowserKokoroProvider()`

```text
createBrowserKokoroProvider({
  id = 'arcane-browser-kokoro',
  localOnly = true,
  model,
  runtime,
  appSecurity,
  security,
  store,
  offline = false
} = {})
```

Returns the same provider/2 lifecycle for role `tts`. The only request
operation is `synthesize`:

```javascript
async function synthesizeAfterUserChoice(provider, signal) {
  // The admitted Kokoro provider must already be ready.
  const result = await provider.request({
    role: 'tts',
    operation: 'synthesize',
    signal,
    payload: {
      text: 'Hello from Arcane.',
      voice: 'caller-owned-voice-id',
      speed: 1
    }
  });

  console.log(result.audio, result.sampleRate, result.voice);
}
```

`speed` must be greater than zero and at most four. Omitted `voice` selects the
caller-supplied `model.defaultVoice`. The provider-native result is the structured
`{audio:Float32Array,sampleRate:24000,voice}` record transferred by Worker
`postMessage`; the client does not re-freeze that cloned record. The shared
AI.js TTS payload is
`{model,input,responseFormat,voice?,speed?}`. Only `responseFormat:"wav"` is
admitted; the provider maps it to `{text,voice,speed}` and returns frozen
`{audio:Uint8Array,contentType:"audio/wav"}` containing 24 kHz mono PCM.
Shared AI.js synthesis reads the selected model's catalog default and never
replaces it with a voice saved for a different provider route.

## Lifecycle and status

Whisper and Kokoro use the same independent state machine:

| Operation | Behavior |
| --- | --- |
| `catalog()` | Returns the single caller-admitted model descriptor. TTS exposes its admitted `defaultVoice`; STT has no voice field. |
| `inspect(selection,{signal})` | Returns `{available:true,authority}` only for the exact provider/model/local selection; mismatch returns an unavailable record. |
| `status()` | Returns `{role,providerId,modelId,state,loaded,busy,generation,errorCode,cache}`. |
| `load(context)` | Requires `{role,selection,progress,signal?,security?}`, admits/cache-materializes artifacts, creates one role Worker, and loads the adapter. Compatible repeated loads coalesce. |
| `request(context)` | Runs exactly one STT or TTS operation. A provider rejects concurrent use with `ARCANE_AI_PROVIDER_BUSY`. |
| `unload()` | Aborts active load/use, terminates the Worker, releases object URLs, and returns `unloaded`. |
| `dispose()` | Completes unload and permanently returns `disposed`. |

Cancellation after a Worker request begins terminates that Worker slot and
returns the provider to `unloaded`; a later request requires a fresh load. A
shared STT request can instead be aborted while the browser is still decoding
its `Blob` or `File`, before Worker use begins. That request rejects with
`ARCANE_AI_REQUEST_ABORTED`, but the loaded Worker remains intact and the
provider stays `ready`. Worker crash/message failures become explicit error
state. No result is retried through another provider.

Register the providers with the projected
[`AIProviderRuntime`](../runtime-modules.md#aiproviderruntimejs) to normalize
selection, startup, application calls, and
[`AIRuntimeState`](../runtime-modules.md#airuntimestatejs) observation. The
provider objects themselves do not expose an event target.

```javascript
async function loadSpeechProviderAfterUserChoice(provider) {
  const selection = {
    providerId: provider.id,
    modelId: provider.catalog()[0].id,
    localOnly: true
  };
  return provider.load({
    role: provider.role,
    selection,
    progress(update) {
      console.info(update.phase, update.completed, update.total);
    }
  });
}
```

The example only defines the operation; invoke it from an explicit user action
after showing the admitted runtime/model and download policy. Requests are
valid only after that load resolves successfully. Applications
register and configure browser-speech providers on the shared runtime. `AI.js`
obtains that singleton and translates its existing browser speech request shapes
at this one provider boundary; it does not register providers, choose
authorities, or trigger a hidden model download.

## Errors

| Code | Meaning |
| --- | --- |
| `ARCANE_AI_MODEL_AUTHORITY_REQUIRED` | Selection or authority does not match the provider. |
| `ARCANE_AI_INVALID_REQUEST` | Role, operation, audio, text, voice, or speed is invalid. |
| `ARCANE_AI_NOT_READY` | Use was requested before a successful load. |
| `ARCANE_AI_PROVIDER_BUSY` | The role already has an active request. |
| `ARCANE_AI_PROVIDER_DISPOSED` | Load/use was requested after disposal. |
| `ARCANE_AI_REQUEST_ABORTED` | The caller's AbortSignal cancelled work. |
| `ARCANE_AI_OPERATION_SUPERSEDED` | A newer unload/load/dispose generation replaced the operation. |
| `ARCANE_AI_ARTIFACT_SOURCE_INVALID` | Artifact bytes or body shape are not readable. |
| `ARCANE_AI_ARTIFACT_SOURCE_UNAVAILABLE` | Fetch is unavailable. |
| `ARCANE_AI_ARTIFACT_DOWNLOAD_FAILED` | Network or HTTP download failed. |
| `ARCANE_AI_ARTIFACT_SOURCE_CHANGED` | Redirect/final URL differs from the admitted immutable URL. |
| `ARCANE_AI_ARTIFACT_SIZE_MISMATCH` | Enabled byte-length evidence differs. |
| `ARCANE_AI_ARTIFACT_DIGEST_MISMATCH` | Enabled SHA-256 evidence differs. |
| `ARCANE_AI_ARTIFACT_CACHE_REJECTED` | DBOPFS did not preserve the completed file. |
| `ARCANE_AI_ARTIFACT_OFFLINE_MISS` | Strict offline use has no admitted complete cache. |
| `ARCANE_AI_STORAGE_BUSY` | Another context owns the same authority lock. |
| `ARCANE_AI_STORAGE_UNAVAILABLE` / `ARCANE_AI_STORAGE_READ_FAILED` / `ARCANE_AI_STORAGE_DELETE_FAILED` | The selected DBOPFS store is unavailable or could not read/delete the authority. |
| `ARCANE_AI_RUNTIME_MODULE_GRAPH_UNDECLARED` | Runtime code leaves the closed self-contained module grammar. |
| `ARCANE_AI_WORKER_CRASHED` / `ARCANE_AI_WORKER_MESSAGE_ERROR` | The isolated adapter Worker failed. |
| `ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH` | The Worker/client/provider protocol is not the SDK-owned contract. |
| `ARCANE_AI_PROVIDER_LOAD_FAILED` / `ARCANE_AI_PROVIDER_REQUEST_FAILED` / `ARCANE_AI_PROVIDER_UNAVAILABLE` | Adapter load/request failed or the admitted runtime did not expose the requested provider. |
| `ARCANE_AI_INVALID_PROVIDER_RESULT` | Whisper/Kokoro returned a result outside the normalized contract. |
| `ARCANE_AI_UNDECLARED_ARTIFACT` | The runtime requested a file outside its admitted closure. |
| `ARCANE_AI_AUDIO_DECODE_UNAVAILABLE` / `ARCANE_AI_AUDIO_DECODE_FAILED` | Shared Blob/File STT cannot obtain a browser decoder or cannot produce nonempty 16 kHz mono PCM. |
| `ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT` | Shared TTS requested a format other than `wav`. |

## Security and ownership

- The SDK contains no speech model or adapter runtime bytes in this entrypoint.
- The application must verify the license and authority for every supplied byte.
- URLs never carry credentials; fetch uses `credentials: "omit"`.
- Mutable `main`, `master`, and `latest` paths are rejected.
- The completion manifest is consistency evidence for the admitted DBOPFS
  bytes. It is not publisher authenticity by itself.
- The runtime entry is isolated in a Worker and limited to its declared
  artifact closure.
- Tool calls are an LLM concern; speech providers execute no application tool.
- A native `Arcane.speech` service is a different privileged host path. This
  browser package neither calls it nor inherits its capability admission.

<details>
<summary>Protocol details</summary>

The artifact store identifies itself as
`arcane-ai-browser-speech-artifacts/1`. Authorities use
`arcane-ai-model-authority/1`. Providers implement `arcane-ai-provider/2` with
roles `stt` and `tts`; their only operations are `transcribe` and `synthesize`.
The Worker client additionally binds exact role, operation, request IDs, and
generation so stale or cross-role messages cannot settle current work.

</details>

## Related

- [Normalized AI](../README.md#normalized-ai)
- [Browser-WASM LLM](browser-wasm.md)
- [AIProviderRuntime.js](../runtime-modules.md#aiproviderruntimejs)
- [AIRuntimeState.js](../runtime-modules.md#airuntimestatejs)
- [PersistentAIChatSession.js](../runtime-modules.md#persistentaichatsessionjs)
- [Availability and normalization](../availability-and-normalization.md)
- [Protocol architecture](../protocols.md#portable-ai-provider-runtime)
