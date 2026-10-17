# Native speech service

`createSpeechService({stt, tts, signal, autoLoad = true} = {})` composes independently selected
native speech engines into one Core service. It is the named and default export
from `arcane-os/core/speech`.

The host supplies an STT engine, a TTS engine, or both. Construction performs no
installation, model download, model loading, or inference. Core registration
exposes `speech.status`, `speech.load`, `speech.unload`, `speech.transcribe`,
and `speech.synthesize`, plus the optional streaming operations described below;
an ordinary operation whose engine was omitted rejects with
`SPEECH_ENGINE_UNAVAILABLE`.
The optional `signal` controls the service lifetime.

```js
import {createCoreRuntime} from 'arcane-os/core/runtime';
import {createSpeechService} from 'arcane-os/core/speech';

// The host prepares and constructs its selected transcription engine.
const speech = createSpeechService({stt: transcriptionEngine});
const core = createCoreRuntime({services: [speech]});
core.start();
```

This service is the shared integration layer. The SDK separately exports the
[native Kokoro engine](#native-kokoro-engine) from `arcane-os/local-ai/kokoro`.
Engine preparation, model resources, device selection, supported formats, and
native process ownership remain with the selected engine and its host
composition. Browser-only operation remains independent of this native service.

The SDK's [retained Whisper engine](local-whisper.md) supplies native STT.
Its optional [Intel NPU encoder](../guides/native-whisper-openvino.md) uses the
same service, readiness events, complete request/result contract and cancellation
path. The host selects that encoder and its paired model resources; the browser
continues calling `speech.transcribe` without loading native libraries itself.

## Startup and status

A speech-only interface can construct the shared browser AI API with explicit
`null` for both the language-model service and model:
`new AI(null, 'LOCAL_SPEACH', 'LOCAL_SPEACH', null, ttsModel, sttModel)`.
This leaves both LLM routes unselected from construction onward; it does not
register or activate the historical default language provider. Select a real
language model later through `configureProviders`. Omitted or empty constructor
arguments keep their historical defaults, and `setAI` retains its existing
omitted/null/empty-field semantics.

`start(context)` subscribes to each configured engine and starts their loads
independently. It returns immediately, allowing Core and `speech.status` to
respond while models load. A failure in one role leaves the other role usable.
Each engine publishes the actual state of its selected model.

Use `autoLoad: false` when the host first needs the user to select or download
model files. Startup still subscribes and exposes the ordinary unloaded state;
it does not call either engine's `load()`. Explicit `speech.load({role,
...selection})` activates the prepared role afterward. The default remains
`true` for existing hosts. This option changes service startup, not the selected
engine's missing-model errors or inference readiness requirement.

`current()` and `speech.status` return the same snapshot:

| Field | Meaning |
|---|---|
| `ready` | Both speech roles are available. A service configured with only STT or only TTS retains `ready: false`. |
| `transcriptionAvailable` | The STT engine reports a loaded model in `ready` or `running` state, and the service is accepting work. |
| `synthesisAvailable` | The equivalent independent TTS readiness. |
| `status` | `created`, `ok`, `closing`, or `closed`. `ok` describes the operational service; model loading and failures are reported per role. |
| `sttEngine`, `ttsEngine` | The configured engines' `providerId` values, or an empty string for an omitted engine. |
| `roles.stt`, `roles.tts` | Each engine's complete current state plus the service's `available` boolean. |
| `closed` | Whether the service has completed its shutdown attempt. Any engine cleanup failure remains observable. |

An engine's state includes `providerId`, `modelId`, `state`, `loaded`, and
`busy`, with its complete error or progress information when present. An
omitted role has `state: 'unavailable'`, `loaded: false`, and `busy: false`.
File presence, a spawned process, and a callable bridge do not establish loaded
model readiness. The shared AI adapter follows the selected engine identity
and model in these per-role snapshots, including Nemotron and Magpie. Only the
older aggregate-only fallback retains fixed `whisper.cpp`/`whisper-small` and
`kokoro-onnx`/`kokoro` expectations.

Each role also reports `supportsStreaming`: STT requires the configured
engine's `openStream()` method, and TTS requires its `synthesizeStream()` method.
This capability is independent of `loaded` and `available`; a facade method
alone does not establish support in the selected engine. Complete engine state,
including `defaultVoice` and `voices` when supplied, remains present.

## Explicit role activation

`speech.load({role, ...selection})` and `speech.unload({role, ...selection})`
route only to the selected `stt` or `tts` engine. The service separates the
`role` routing field and forwards the remaining selection fields unchanged,
with the operation's signal. Each call returns that engine's complete result.
An invalid role reports `SPEECH_ROLE_INVALID`; an engine without the requested
method reports `SPEECH_OPERATION_UNAVAILABLE`. These calls do not alter the
other speech role or select a browser provider.

The browser facade is `Arcane.speech.load(request, {signal, onRequest})` and
`Arcane.speech.unload(request, {signal, onRequest})`. Both use an unlimited Core
request duration (`timeoutMs: 0`). Synthesis retains its existing
`Arcane.speech.synthesize(request, {signal})` facade and 180-second timeout.
Call `client.invoke('speech.synthesize', request, {signal, timeoutMs: 0, onRequest})`
when the owning application explicitly needs an unlimited request duration or
the actual request ID. The synthesis payload is the same through either path.

## Events and subscriptions

`subscribe(listener, {replay = true, signal} = {})` immediately delivers the
current snapshot by default and returns an unsubscribe function. The optional
subscription signal removes only that listener. Closed services can still
replay their final snapshot. Promise rejections from listeners are reported
through developer diagnostics.

Changes are published through the SDK's existing event owner and Core as
`speech.state`. A Core client observes them with
`Arcane.events.on('speech.state', listener)`. Core's generic runtime replay
does not replay custom speech state. A browser consumer should subscribe first,
then request `Arcane.speech.status()`, retaining any newer event received while
that initial request is pending.

`speech.progress` carries `{requestId, role, status: 'Thinking', progress}`.
The service emits `progress: {phase: 'accepted'}` synchronously when accepting
a speech request. Subsequent progress is the selected engine's actual report;
cancelled requests publish no later progress.
Role load/unload acknowledgements additionally carry `operation: 'load'` or
`'unload'` in that progress record.

## Continuous transcription and streaming synthesis

`Arcane.speech.openStream(request, {signal, onUpdate, onProgress, onRequest})`
returns an owned handle immediately:

```js
const recognition = Arcane.speech.openStream({sampleRate: 16000}, {
  signal,
  onUpdate: function retainNativeSnapshot(result) {
    // Keep the complete snapshot. The application decides when to take a turn.
    showRecognition(result);
  }
});
await recognition.ready;
await recognition.push(pcm); // Float32Array, supplied in capture order.
await recognition.forceEndpoint(); // Finalizes recognition, keeps the stream.
const complete = await recognition.finish(); // Drains and closes this stream.
```

The handle exposes `streamId`, `ready`, `completion`, `current()`,
`push(Float32Array)`, `forceEndpoint()`, `finish()`, and `cancel(reason)`.
`ready` resolves with the native-open acknowledgement; `completion` resolves
with the engine's complete terminal result or rejects with its actual failure.
`current()` returns the latest delivered complete snapshot. Pushes and endpoint
controls are ordered, and each returned promise lets the producer apply
backpressure without dropping captured samples. `forceEndpoint()` waits for
ordered update callbacks preceding its control response, so an external Reply
control can consume those final segments. `finish()` follows every accepted
push and waits for final callback delivery. An update callback must not await
its own `forceEndpoint()`, `finish()`, or `completion` delivery join; invoke these
controls outside the callback. `cancel()` targets this
stream, suppresses later callbacks immediately, and awaits its explicit native
cleanup control; it leaves the other speech role alone. Aborting the caller's
signal uses ordinary Core request cancellation and can settle the browser's
request before native cleanup finishes.
Creation opens no microphone: the selected capture owner supplies PCM.

Updates are the engine's unchanged snapshots, including provisional/final
status, words, timestamps, and speaker scope when supplied. A provisional
snapshot replaces the preceding provisional snapshot; it is not appended text.
An ASR final or silence boundary is recognition output, not a completed human
turn, an instruction, or approval. `forceEndpoint()` preserves the native
stream's speaker scope according to its engine contract. The application owns
conversational meaning, turn completion, tool selection, and whether to issue
an LLM request. The SDK starts no chat request from an update.

The underlying `speech.open` request remains pending for the entire stream,
with no fixed request timeout. `speech.opened` and `speech.transcription`
events use that request's scoped emitter, carrying `{streamId, ...metadata}`
and `{streamId, result}` respectively. They reach only the owning connection.
`speech.push`, `speech.endpoint`, `speech.finish`, and `speech.cancel` address
the same stream. Client close, document retirement, transport disconnect, or
the request signal cancels the native stream through normal Core request
ownership. This stream is not accepted service-lifetime background work.

`Arcane.speech.synthesizeStream(request, {signal, onAudio, onProgress,
onRequest})` returns a promise for the complete native terminal metadata.
The complete synthesis payload reaches the selected engine unchanged.
The required `onAudio(audio)` consumer receives every ordered native PCM contribution, preserving
its metadata; `audio.pcm` is a `Uint8Array`, interpreted using the supplied
`format`, `channels`, and `sampleRate`. Magpie supplies signed little-endian
16-bit mono PCM. The facade does not play audio, infer audible completion, or
add a voice, language, speed, or output limit. The selected playback owner
consumes this stream and owns its actual playback completion and interruption.
Give each utterance its own signal to stop precisely that utterance without
stopping microphone capture or unrelated synthesis.

The synthesis request has no fixed timeout. Its request-scoped `speech.audio`
events contain `{streamId, sequence, audio}`; `speech.progress` also carries the
stream correlation. The facade serializes asynchronous callbacks and sends
`speech.audioConsumed` for that exact stream and sequence only after `onAudio`
completes. The native producer awaits this acknowledgement before contributing
the next PCM chunk; the event parser remains free to handle control messages.
Sequence and acknowledgement metadata stay outside the audio payload.

Aborting the utterance signal suppresses later callback delivery and sends
`speech.cancelSynthesis`. That scoped control releases pending audio
acknowledgements and joins the native synthesis task. The facade keeps the
original response pending and joins this cleanup control before settling;
ordinary cancellation rejects with the caller's reason. Callback failure
cancels the same owned operation and retains its complete failure together with
any native cleanup failure. Successful completion waits for all callback
delivery. A callback may abort its caller-owned signal, while its own completion
must not await the same synthesis promise. A transport failure remains an error,
not evidence of completed native cleanup. Playback completion remains with the
selected playback owner, independently of synthesis completion.

The Core transport uses base64 only for PCM framing: STT transfers exact
Float32 bit patterns as little-endian samples, and TTS transfers the engine's
complete PCM before decoding it back to the original sample representation.
Routing and callbacks stay outside transcript and synthesis payloads.
Existing file transcription, complete-audio synthesis, model loading, and
unloading methods keep their original contracts. A selected engine without the
requested streaming method reports `SPEECH_OPERATION_UNAVAILABLE`; the SDK
selects no replacement engine or capture path.

### Shared AI capture and playback

The built-in native AI adapter advertises continuous capture only when the
selected STT engine reports streaming support. `ai.createTranscriptionCapture`
uses the shared microphone owner, forwards the caller's media constraints and
actual sample rate, and preserves every ordered PCM sample. Its `onUpdate`,
`onInterim`, and `onSegment` callbacks receive the complete recognition record
and a second `{requestStop}` argument. A callback can call `requestStop()` and
return; the external owner joins `capture.stop()` or `capture.done`. Do not
await those joins or `forceEndpoint()` from their own recognition callback.
Stop drains accepted audio and final recognition; cancel joins microphone and
native cleanup without inventing a completed transcript. Neither action sends
a chat turn automatically.

For a selected streaming TTS engine, `ai.prepareTTSPlayback()` returns an inert
playback descriptor. Its `play()` consumes native PCM through the existing AI
provider lane and shared audio output. Playback stop affects only that utterance;
the control's `released` promise joins native cleanup. Existing full-audio
`fetchTTS()` remains available. `streamTTS(text, end, {languageCode})`,
`prepareTTSPlayback({input, languageCode, ...})`, and
`fetchTTS({input, languageCode, ...})` carry the caller's per-utterance language
to the native engine separately from the unchanged text. The SDK does not infer
language or create conversation replies. See the
[Nemotron](native-nemotron.md) and [Magpie](native-magpie.md) engine contracts.

## Engine interface

Each supplied engine implements:

- `current()` returning the actual selected-model state.
- `subscribe(listener)` with immediate current-state replay and an unsubscribe
  function.
- `load({signal, ...selection})`, applying that engine's explicit selection
  contract. Independent engines may load concurrently. Kokoro without selected
  assets resolves to its ordinary unloaded state.
- Optional `unload(selection)`, releasing the selected engine's model through
  `speech.unload`; engines without this method report it unavailable.
- `transcribe(request, {signal, onProgress, requestId})` for STT, or
  `synthesize(request, {signal, onProgress, requestId})` for TTS. `requestId` is
  the actual Core request's control metadata, separate from the unchanged payload.
- Optional `openStream({...options, signal, onUpdate})` for continuous STT,
  returning `{push, forceEndpoint, finish, cancel, completion, current}`.
  Its cancellation must settle `completion` without requiring service shutdown.
- Optional `synthesizeStream(request, {signal, onProgress, onAudio, requestId})`
  for streaming TTS. Each `onAudio` value contains the complete `pcm` Buffer
  and its format metadata; the engine awaits each callback before producing the
  next contribution and joins native cleanup before settling cancellation.
- `close()`, cancelling and joining its native work and releasing its resources.

The service forwards each complete transcription/synthesis request and result
unchanged. It applies no input trimming, content limits, model or voice substitution, transcript
rewriting, or audio conversion. The engine owns any format decoding,
phonemization, required model segmentation, output encoding, and supported
model selection. Necessary processing must preserve complete ordered input
and output through that engine's public contract.

## Cancellation and shutdown

The request's `context.signal` reaches its engine together with the service's
lifetime signal. A request waiting for its role's shared startup load can
cancel promptly without cancelling another request or the other speech role.
The retained startup load remains observed by the service. Queued and active
inference cancellation belongs to the engine; it must stop the actual native
operation and settle independently of service disposal.

This matters because Core cancels and awaits active requests before calling
service shutdown hooks. An engine that interrupts requests only in `close()`
would prevent Core from reaching that cleanup hook.

`close()` and `drain()` stop acceptance, abort the service lifetime, close both
engines concurrently, and await their startup and request tasks. Repeated calls
share one shutdown promise. Actual engine cleanup failures reject with an
`AggregateError` and remain in role diagnostics. `dispose()` additionally
releases the service's event subscriptions. New work after shutdown begins
rejects with `CORE_CLOSING`.

## Selected NeMo model acquisition

`NEMO_SPEECH_MODELS`, `prepareNemotronModels`, and `prepareMagpieModels` are
named exports from `arcane-os/local-ai/nemotron`. Importing them performs no
network access, installation, model loading, or inference. The catalog records
NVIDIA's selected [NeMo-Speech.cpp v0.2.0 model index](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/models/index.json):

| Role | Complete default selection |
|---|---|
| `stt` | Nemotron 3.5 streaming ASR Q8_0 and Nemotron 3 Diarization Q8_0. |
| `tts` | Magpie multilingual v2607 F16, NanoCodec 22 kHz F16 decoder, and all ten matching tokenizer/configuration/speaker-map members from the same Magpie revision. |

Each role exposes `{modelId, providerId, name, members, resourcePaths}`.
`members` contains ordered `{path, url}` file sources. TTS also exposes
`archives`, with the upstream uncompressed `.nemo` TAR source, its selected
transport ranges, and exact `{path, member}` tokenizer entries. The shared
[model-assets service](model-assets.md) owns discovery, acquisition, progress,
cancellation, persistence, and projection lifetime; these helpers do not create
another downloader or store. Tokenizer files retain their complete original
contents. The selected tokenizer configuration and its referenced JSON speaker
map continue to own voice IDs.

```js
import {createNemotronRuntime, prepareNemotronModels} from 'arcane-os/local-ai/nemotron';
import {createSpeechService} from 'arcane-os/core/speech';

const stt = createNemotronRuntime({runtime, modelAssets, gpu: -1});
const speech = createSpeechService({stt, autoLoad: false});
// Run this only for the user's explicit model preparation action.
const prepared = await prepareNemotronModels({
  modelAssets,
  workingDirectory: modelsDirectory,
  directories: [modelsDirectory, appModelsDirectory],
  signal,
  onProgress: showModelProgress
});
try {
  await stt.load({
    assetProjectionId: prepared.assetProjectionId,
    resourcePaths: prepared.resourcePaths,
    signal
  });
} finally {
  await prepared.release();
}
```

Both preparation helpers accept `{modelAssets, workingDirectory, directories,
id, signal, onProgress, refresh = false}`. With `directories`, they ask the
shared owner for the first complete matching catalog selection in those roots
before downloading. `openExisting()` borrows its original files and never
deletes them. Incomplete selections stay visible through the owner's discovery
results and are not mistaken for a complete model. When no complete match is
available, the existing acquisition path prepares the complete selected set;
its completed downloads remain reusable. Explicit `refresh: true` requests a
fresh acquisition. The host chooses the roots: its portable native launch
context supplies `modelsDirectory` under the resolved per-user `stateRoot` by
default, while explicit directory overrides remain supported. An application
may include its own `models` directory among the discovery roots.

The result is `{assetProjectionId, directory, members, resourcePaths, release}`.
`release()` is idempotent and releases preparation ownership. Each engine
retains the projection synchronously when `load()` accepts it, so the caller
may release its preparation after starting that load. Nemotron accepts
`modelAssets`, `assetProjectionId`, and `resourcePaths` in its constructor and
`assetProjectionId`/`resourcePaths` in `load()`, with roles `{model, diarization}`.
Magpie uses `{model, codec, tokenizerConfig}`. Native file paths still work
through the engines' existing options. Nemotron requires unloading before
changing an active selection; its retained files are released only after
native work and helper exit have joined. Load failures also join asset cleanup,
and cleanup failures remain observable.

`onProgress` receives ordered, awaited shared-owner phase and file-completion
events, including reuse and ready for installed selections. Signal cancellation
stops that preparation's work; an abort after projection creation releases it
before rejecting. Engine load cancellation remains separate: cancelling the
caller's wait does not cancel a shared activation; explicit engine unload/close
owns that cancellation.

The default GGUF selections are individual complete upstream files. The shared
owner also discovers ordered GGUF shard sets and reports their missing members;
HTTP range transfers and tokenizer TAR ranges are transport mechanisms, not
additional model shards. A discovered shard set alone does not establish that a
selected native engine can load that model. The engine remains the authority
for model compatibility and actual readiness.

The [upstream native runtime](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/docs/install.md)
provides Windows, Linux, and macOS distributions. Model files and that runtime
remain separate upstream assets, not vendored SDK payloads. This acquisition
integration received source review only; no download, inference, or new platform
execution is claimed here. See the [Nemotron](native-nemotron.md) and
[Magpie](native-magpie.md) contracts for native preparation and execution evidence.

## Native Kokoro engine

`createNativeKokoroRuntime` is the named and default export from
`arcane-os/local-ai/kokoro`. It uses the existing native ONNX owner for model
execution and one retained C++ helper for eSpeak phonemization and Ogg Opus
encoding. The Kokoro route requires no Python, Sherpa-ONNX or FFmpeg runtime.

```js
import {createNativeKokoroRuntime} from 'arcane-os/local-ai/kokoro';
import {createSpeechService} from 'arcane-os/core/speech';

const tts = createNativeKokoroRuntime({
  onnx,          // The existing Core local-ai owner's getONNXRuntime() result.
  modelAssets,   // The existing Core model-assets service.
  runtime,       // Prepared helperExecutable, espeakDataDirectory, libraryDirectory.
  executionPreference: 'cpu',
  sessionOptions: {executionProviders: ['cpu']}
});
const speech = createSpeechService({tts});
```

The constructor accepts `{onnx, modelAssets, runtime, prepare, modelId, model,
revision, dtype, paths, assetProjectionId, resourcePaths, sessionOptions,
executionPreference, executionTarget, signal, onEvent}`. At least `onnx` or
`prepare` must be supplied. Optional `prepare({signal})` returns `{onnx, runtime}`
and runs only when an activation has selected assets and either its ONNX owner
is absent or closed, or its helper descriptor is absent. It returns the host's
existing ONNX owner; it does not construct another one. Construction performs
no acquisition or loading.
The helper data path is the **parent** containing `espeak-ng-data`.

The provider ID is `kokoro-onnx`; the public `modelId` alias defaults to `kokoro`.
The implemented model is `onnx-community/Kokoro-82M-v1.0-ONNX`, revision
`1939ad2a8e416c0acfeecc08a694d14ef25f2231`, with `dtype: 'fp32'`. Another model,
revision or dtype reports incompatibility. The module also exports
`KOKORO_MODEL`, `KOKORO_REVISION`, `KOKORO_SAMPLE_RATE` (`24000`) and
`KOKORO_VOICES`.

### Resources and loading

Supply either prepared native `paths` or an existing completed
[`model-assets` projection](model-assets.md). Both mappings have
`{model, tokenizer, tokenizerConfig, voices: {[voiceId]: path}}`: native paths
identify prepared files, while `resourcePaths` identifies projection members.
Projection loading requires the existing `modelAssets` service. Direct-path
callers keep their prepared files available until engine cleanup completes.
The complete selection contains `onnx/model.onnx`, `tokenizer.json`,
`tokenizer_config.json`, and all 28 `voices/<voiceId>.bin` files from the same
revision. The engine does not download models or create another model store.

`load({modelId, assetProjectionId, resourcePaths, executionTarget, signal})`
activates that selection. Omitted selection fields retain the previous choice;
an omitted or undefined target retains the previous target, and `null` requests
automatic selection. `modelId`, when supplied, must match this engine's alias.
With neither constructor paths nor a projection selected, loading resolves
unloaded without preparing the helper. Actual readiness requires the frontend
resources, live helper and loaded ONNX session.

For a complete DBOPFS-to-Core projection already prepared by the application:

```js
await Arcane.speech.load({
  role: 'tts',
  modelId: 'kokoro',
  assetProjectionId: projection.id,
  resourcePaths,
  executionTarget: {deviceId: 'cpu'}
}, {signal});
```

The engine retains the incoming projection before retiring a previous
activation, including replacement using the same projection. It releases that
retain only after frontend loading settles and the actual ONNX worker and
helper exit. The preparation owner retains its own independent release duty.
Cancelling a caller's `load` signal stops that caller's wait; explicit unload,
replacement or engine close owns cancellation of the shared activation.
After `localai.services.recover({runtimes: ['onnx']})` completes, a subsequent
explicit `speech.load` uses the composition's `prepare` callback to reacquire
the current ONNX owner after the previous activation's cleanup has joined.

`executionPreference` defaults to `'gpu'` and accepts the existing ONNX CPU/GPU
selection contract. `sessionOptions` and `executionTarget` reach that same
owner unchanged. Explicit providers take precedence, and an explicit physical
target is never retried on another device or provider. The automatic route's
provider attempts and possible CPU selection remain visible in `execution`.
STT keeps its own independent device selection. See
[native ONNX execution targets](local-ai.md#physical-execution-targets);
accepted configuration and actual physical execution are separate facts.

### Synthesis, voices and state

`synthesize(request, {signal, onProgress, requestId} = {})` accepts
`{input, model?, voice?, speed?, responseFormat?}`. `input` is the complete
string; optional `model` must match the alias. Defaults are voice `af_heart`,
speed `1`, and format `wav`. Speed must be a positive finite float32 value.

| English voice set | Exact supported IDs |
| --- | --- |
| US female | `af_heart`, `af_alloy`, `af_aoede`, `af_bella`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky` |
| US male | `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa` |
| GB female | `bf_emma`, `bf_isabella`, `bf_alice`, `bf_lily` |
| GB male | `bm_george`, `bm_lewis`, `bm_daniel`, `bm_fable` |

The selected voice determines US or GB phonemization. Unsupported voices,
formats and emitted phonemes report their actual errors; there is no silent
voice substitution or phoneme omission. An embedded NUL or unpaired Unicode
surrogate reports the public eSpeak interface's inability to consume that
complete string. The engine preserves source text, consumes all returned
clauses and divides model tokens into ordered segments according to the model's
context. Each segment's complete waveform contributes to the final audio.

The result is `{audioBase64, contentType, sampleRate: 24000, channels: 1,
model, voice, speed}`. `wav` returns IEEE float32 WAV with `audio/wav`;
`opus` and `ogg` both return finalized Ogg Opus with
`audio/ogg; codecs=opus`. The result contains the complete encoded audio rather
than a playback side effect. Synthesis requires a ready activation and proceeds
in FIFO order. Progress reports the actual `phonemizing`, `synthesizing` and
`encoding` phases; segment progress is not streamed audio.

`current()` returns the selected model/provider, `state`, `loaded`, `busy`,
active `requestId` (or `null` when omitted), `queuedRequests`, `pendingActivation`, `execution`,
complete `progress` and serialized `error`, plus `defaultVoice` and `voices`.
`subscribe(listener, {replay = true, signal} = {})` returns an unsubscribe
function and replays that current state. Through Core, it appears in
`speech.status().roles.tts` and `speech.state`.

Cancelling a queued synthesis removes only that request. Cancelling active
synthesis retires its native session/helper and joins their actual exit before
settlement. Surviving queued requests retain their complete input and order;
the next request reopens the same activation with the accepted provider options
and the resolved device when known. It does not replay the cancelled synthesis or search for
another provider. With no queued work, explicitly `load()` before new synthesis.
Native ONNX cancellation can wait for an in-flight native call to return.

`unload()` cancels the activation and its queued work, joins native cleanup and
releases retained model assets. `close()` also disposes engine subscriptions;
both preserve the host's shared ONNX owner and other engines. Cleanup errors
remain complete and observable. The Core equivalent is
`Arcane.speech.unload({role: 'tts'})`.

### Native helper production and availability

Windows x64 has a selected SDK helper archive, `arcane-kokoro-windows-x64.tar.gz`.
[Runtime preparation](local-ai.md#native-kokoro-selection) resolves it from the
installed SDK version's release. Linux and macOS use the shared JavaScript
engine and native CMake source with an explicitly prepared, platform-matching
complete helper tree or archive. Automatic Linux/macOS helper distributions
are not provided; execution on those hosts remains unverified.

SDK selected-output verification on October 7, 2026 used Node `26.7.0` and
ONNX Runtime Node `1.30.0` with explicit CPU selection for the selected Windows
helper and FP32 model. It covered US `af_heart` and GB `bf_emma` synthesis to WAV and Ogg Opus,
including queued/active cancellation and a surviving queued request. This
establishes that selected CPU output boundary, not GPU execution, other voices'
pronunciation, listening acceptance or consumer application behavior.
The subsequent Core-recovery reacquisition correction received source review
only and was not part of those execution runs.

The repository's [`tools/build-kokoro-runtime-windows.ps1`](https://github.com/TheWizardNexus/arcane-os-sdk/blob/main/tools/build-kokoro-runtime-windows.ps1)
builds from prepared `espeak-ng`, `opus` and `libopusenc` source directories.
Its selected inputs are the `csukuangfj/espeak-ng` fork at
`ed530aa113046142eb5115cf2fc9157854d0ffe1` with its matching UCD and language data,
libopus `1.6.1`, and libopusenc `0.3`. It uses installed CMake and Visual Studio
2022 Build Tools, defaulting to MSVC `14.44.35207` and Windows SDK
`10.0.26100.0`; it acquires no dependencies or model files.

```powershell
& ./tools/build-kokoro-runtime-windows.ps1 `
  -SourceRoot ./.arcane/kokoro-source `
  -OutputDirectory ./.arcane/kokoro-build `
  -Component espeak
```

Run `espeak`, `opus` and `opusenc` components independently, concurrently when
desired, using the same output directory. After all three complete, run
`helper`, then `stage`. Each component retains complete command/result logs;
do not run the same component concurrently in that output. The output must
belong to `ProjectDirectory` and be separate from the prepared source tree.
The staged helper, matching complete data, corresponding source and included
terms travel together. The recipe statically links its selected libraries and
retains their upstream notices alongside the SDK license. Model/voice assets
and the separately selected ONNX runtime remain outside the helper package.
This reusable recipe was source-reviewed; its publication does not claim a
fresh execution of every component or a build on another operating system.

## AI built-in native speech readiness

The `AI` module's `LOCAL_SPEACH` adapter observes `speech.state` before reading
`Arcane.speech.status()`. A newer event takes precedence over an outstanding
initial status response. Each role loads independently: STT does not wait for
TTS, and unmuting waits for the selected TTS model rather than a callable facade.

For this service's role snapshots, readiness requires the exact selected
`modelId`, its engine identity, `loaded: true`, `available: true`, and a `ready`
or `running` state. Model loading remains an ordinary cancellable waiting state.
An engine error, unavailable role, or different selected model rejects the
adapter load. Later readiness loss or engine/model replacement invalidates the
AI role and cancels its queued and active requests through the existing provider
runtime. A new explicit role load or unmute can observe the next ready state.

An engine can report `state: 'recovering'`, `loaded: false`, `busy: true`, and
the continuing Core `requestId` while retrying an already accepted request on
the same selected provider and model. Availability remains false. The built-in
STT adapter preserves only its own correlated pending request through this
state; another caller's recovery supplies no continuation authority. The real
RPC ID comes from `Arcane.speech.transcribe`'s optional `onRequest` observer.
The engine retains that ID on a terminal error snapshot until the snapshot is
superseded, allowing the pending RPC to deliver its actual complete failure
rather than converting it into cancellation. True unload, close, replacement,
transport loss and caller cancellation retain their existing ownership.

The shared AI observation becomes `recovering` with `loaded: false`, `busy:
true`, and its existing runtime `operationId`. An error may likewise retain
`busy: true` until the actual operation settles. New inference still requires
genuine loaded readiness. The STT provider request context includes a
`refreshState()` callback which rereads that provider's status only while the
exact request remains owned; it changes observation, not execution authority.
Shared speech components retain their own real runtime operation through this
recovery, keep new dispatch readiness-gated, and preserve native microphone
capture's separate cancellation and final/interim lifetime.

Older fixed-model hosts expose the published aggregate-only `SpeechStatus`
contract instead of per-model lifecycle. The adapter preserves their independent
health-based readiness for `whisper-small` with `whisper.cpp` and `kokoro` with
`kokoro-onnx`, using `status: 'ok'` and the corresponding availability boolean.
That contract is a one-shot health observation, not evidence of a persistently
loaded native model or a continuous lifecycle event stream.

Cancellation, unload, disposal, and route retirement release adapter-owned
subscriptions. They do not close the host's shared engines or alter complete
speech requests and results. Browser and explicitly registered speech providers
retain their existing lifecycle contracts.
