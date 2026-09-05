# Browser speech providers

`arcane-os/ai/browser-speech` is the browser-only SDK boundary for
caller-selected Whisper speech-to-text and Kokoro text-to-speech runtimes. It
provides artifact storage, live module routing, role Workers, provider/2
adapters, bounded parallel TTS synthesis, audio normalization, cancellation,
and cleanup.

## Quick start: say one sentence

Use this in a browser application served by `arcane dev`, where the generated
import map resolves `arcane/AI` and `arcane/DBOPFS`. These browser modules are
not Node inference APIs. To create an application:

```bash
npx arcane-os@0.5.12 new hello-speech --path ./hello-speech --target browser
cd hello-speech
npm install
npm run dev
```

Keep the generated page's Arcane theme and import map. The examples below go in
`apps/hello-speech/modules/App.js` and the adjacent `speech-selection.js`.
Follow the development server's printed URL. Installing the SDK supplies its
provider, storage, and Worker code; it does not install a speech model or choose
an upstream speech runtime for your application.

First create **`speech-selection.js`**, the one application-owned configuration
file used throughout this guide. This concrete selection is also used by the
[maintained WASM voice-chat example](https://github.com/TheWizardNexus/arcane-os-sdk/tree/main/examples/wasm-ai-demo).
Your application owns these runtime/model versions, URLs, dtype, and voice.
Loading this selection uses those upstream publishers' downloads and caches.

```javascript
export const speechSelection = {
  model: {
    id: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    repository: 'onnx-community/Kokoro-82M-v1.0-ONNX',
    revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231',
    dtype: 'q8',
    defaultVoice: 'af_heart'
  },
  runtime: {
    adapter: 'kokoro-js',
    version: '1.2.1',
    revision: '664c76a704021239ba59c84dcbaa4d3dece01fe9',
    entry: 'kokoro.web.js',
    wasmPaths: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/',
    files: [{
      path: 'kokoro.web.js',
      url: 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js',
      mediaType: 'text/javascript'
    }]
  }
};
```

Then use this **`App.js`**. The application creates and owns the DBOPFS
instance. Configuration selects the provider without loading it; the button
explicitly loads and unmutes TTS before requesting speech.

```javascript
import arcaneThemeReady from 'arcane/ThemeBootstrap';
import AI, { AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL } from 'arcane/AI';
import DBOPFS from 'arcane/DBOPFS';
import { speechSelection } from './speech-selection.js';

await arcaneThemeReady;
const dbopfs = new DBOPFS();
await dbopfs.readyPromise;
const ai = new AI();

await ai.configureBrowserSpeech({
  protocol: AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
  id: 'hello-speech',
  dbopfs,
  tts: {
    providerId: 'hello-kokoro',
    model: speechSelection.model,
    runtime: speechSelection.runtime,
    offline: false
  }
});

const speakButton = document.createElement('button');
speakButton.textContent = 'Load voice and say hello';
document.body.append(speakButton);
speakButton.addEventListener('click', async function sayHello() {
  speakButton.disabled = true;
  try {
    await ai.setSpeechMuted(false); // Loads the selected TTS provider.
    const prepared = await ai.streamTTS('Hello from Arcane. ', true);
    console.log('Speech preparation completed:', prepared);
  } catch (error) {
    console.error(error.code, error.message);
  } finally {
    speakButton.disabled = false;
  }
});
```

The first user action may download the selected runtime, model, and voice.
The browser may require another audio-unlock gesture after a long load; the SDK
retains prepared audio for that gesture. The two-argument `streamTTS()` call
resolves after preparing audio for scheduling; it does not wait for playback
to end. It returns `false` when that preparation is muted, stopped, or fails.
Later playback failures still reach the SDK's complete console diagnostics
and `ai-tts-failure` event. Use the optional playback mode below when you need
to wait for the submitted audio to end. Neither mode proves a listener heard it.

To display complete high-level playback errors in this page, observe its
existing event. The listener belongs to this example's one `ai` instance:

```javascript
const speechEvents = new AbortController();
window.addEventListener('ai-tts-failure', function reportSpeechFailure(event) {
  if (event.detail.ai !== ai) return;
  console.error(event.detail.error.code, event.detail.error.message);
}, { signal: speechEvents.signal });
```

Call `speechEvents.abort()` when disposing that interface to remove the listener.

## Four synthesis slots and exact-order playback

Capacity 4 means up to four segments synthesize at once. Segment 5 and later
wait in the SDK's FIFO queue; they are not dropped. Synthesis may finish out of
order, but playback waits for earlier segments and plays exact input order.
Each slot owns a Worker/model session, so raising capacity trades memory for
latency.

The high-level `AI` route owns the FIFO queue. Calling a low-level Kokoro
provider directly beyond its capacity returns `ARCANE_AI_PROVIDER_BUSY`.
Ready adjacent audio buffers use contiguous AudioContext scheduling. Browser
audio scheduling and selected WebGPU status do not prove physical GPU kernel
overlap or audio quality. LLM and Whisper/STT capacity remains one.

## Queue complete passages and wait for playback

These options are available in SDK `0.5.12`.

For a complete page or passage, call
`ai.streamTTS(text, true, {voice, speed, pauseAfterMs, waitForPlayback:true})`.
The existing AI queue owns segmentation, concurrent synthesis, ordered
playback, and cancellation. Supply the exact text; there is no need for an
application sentence queue, audio cache, or playback scheduler.

This function uses the configured `ai` above. Its application-supplied
`passages` argument is an ordered array of `{text, voice?, speed?, pauseAfterMs?}`
records. An omitted voice uses the selected model's default voice, an omitted
speed uses `ai.voiceSpeed`, and an omitted pause is zero. Each supplied voice
must be supported by the selected model; speed must be positive. A pause is
finite, nonnegative milliseconds and applies only after that passage's final
extracted segment. These options do not change the instance defaults.

```javascript
async function speakPassages(passages) {
    await ai.setSpeechMuted(false);
    const pending = passages.map(
        function queuePassage(passage) {
            return ai.streamTTS(
                passage.text,
                true,
                {
                    voice: passage.voice,
                    speed: passage.speed,
                    pauseAfterMs: passage.pauseAfterMs,
                    waitForPlayback: true
                }
            );
        }
    );
    return Promise.all(pending);
}
```

Call `speakPassages(...)` from your owned user action and handle errors with
the earlier `error.code` / `error.message` pattern. The `map` submits every
passage synchronously before `Promise.all` waits, so synthesis can use the
provider's available capacity. The returned array has one boolean per passage
in input order: `true` after all its extracted audio buffers naturally end,
or `false` after terminal cancellation or failure. `ai.stopAudio()` cancels
all speech owned by that AI instance and settles pending playback results
`false`.

The selected voice and speed are captured for segments extracted by that call.
That includes any text left in the same AI instance's partial-stream buffer;
finish the previous producer before starting a separate complete passage.
Options are not retained with an unfinished `end:false` remainder. A later
call supplies its own options, and `finishTTS()` uses defaults.
A call extracting no segments returns `true` without waiting for earlier jobs.
An already muted call returns `false`.

Autoplay permission waiting and recoverable audio-resume attempts leave the
playback promise pending until playback completes or is stopped. A failed
resume of a closed `AudioContext` terminates the affected jobs and settles
their playback results `false`. A trailing
pause delays the next queued audio on the existing `AudioContext` clock; it
does not delay the preceding promise after that passage's last buffer ends.
The promise is a playback result, not a listener acknowledgement.

## Stream chunks as they arrive

Use the configured `ai` created above. Run this snippet from an owned user
action, such as your Speak button, and catch errors with the earlier
`error.code` / `error.message` pattern. First load/unmute, then accept chunks.
Call `streamTTS(chunk)` inside the producer's chunk callback immediately;
waiting for each speech promise there would serialize synthesis. This tiny
example uses three arriving chunks. Replace the three `onTextChunk(...)` calls
with your actual text stream callback, and flush after that producer ends.

```javascript
await ai.setSpeechMuted(false);
const pendingSpeech = [];

function onTextChunk(chunk) {
  const pending = ai.streamTTS(chunk);
  // Attach both handlers immediately, so later failure cannot be unhandled.
  pendingSpeech.push(pending.then(
    function speechPrepared(value) { return { status: 'fulfilled', value }; },
    function speechRejected(reason) { return { status: 'rejected', reason }; }
  ));
}

onTextChunk('First sentence. ');
onTextChunk('Second sentence. ');
onTextChunk('Third sentence.');

// After the text producer ends, flush trailing text and settle every call.
const finalPrepared = await ai.finishTTS();
const outcomes = await Promise.all(pendingSpeech);
for (const outcome of outcomes) {
  if (outcome.status === 'rejected') {
    console.error(outcome.reason.code, outcome.reason.message);
  } else if (outcome.value === false) {
    console.log('Speech was muted, stopped, or failed; inspect SDK diagnostics.');
  }
}
if (finalPrepared === false) {
  console.log('Final speech was muted, stopped, or failed; inspect SDK diagnostics.');
}
```

The segmentation default uses sentence punctuation. To submit smaller complete
segments, call `ai.configureTTSSegmentation({punctuation:'any',wordCadence:4})`
before feeding the stream. Chunk boundaries themselves do not force a sentence
boundary; `finishTTS()` flushes any remaining text. It is not a playback-ended
notification. Do not mute or dispose immediately after it if playback should
continue.

## Choose a device or reduce memory use

Omitting `tts.execution` selects `{device:'auto',maxConcurrentRequests:4}`.
These are three alternative configurations, not a sequence of required loads:

```javascript
async function selectSpeechExecution(execution) {
  await ai.configureBrowserSpeech({
    protocol: AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
    id: 'hello-speech',
    dbopfs,
    tts: {
      providerId: 'hello-kokoro',
      model: speechSelection.model,
      runtime: speechSelection.runtime,
      offline: false,
      execution
    }
  });
}

// Choose and call one from your application settings action:
// await selectSpeechExecution({ device: 'auto' });
// await selectSpeechExecution({ device: 'webgpu' });
// await selectSpeechExecution({ device: 'wasm', maxConcurrentRequests: 1 });
```

The override accepts integers 1, 2, 3, or 4. `auto` tries a complete WebGPU pool
when available, then recreates a complete WASM pool if that load cannot finish.
Explicit `webgpu` reports a load error when unavailable; explicit `wasm` never
attempts WebGPU. The same application-selected model and dtype apply on both
devices. A configuration change leaves TTS muted; explicitly load/unmute again.

## Inspect the requested and selected device

Request the execution projection on the existing public runtime status after
loading. This explicitly reads the selected provider's current report; ordinary
`status()` retains its existing sticky snapshot and identity. There is no
separate execution-state event subscription.

```javascript
function printSpeechStatus() {
  const status = ai.providerRuntime.status('tts', { execution: true });
  const execution = status.execution;
  console.log('TTS state:', status.state);
  if (execution) {
    console.log('Requested device:', execution.requestedDevice);
    console.log('Selected device:', execution.selectedDevice);
    console.log('Capacity:', execution.maxConcurrentRequests);
    console.log('Active synthesis requests:', execution.activeRequestCount);
    console.log('Automatic WASM fallback:',
      execution.requestedDevice === 'auto' && execution.selectedDevice === 'wasm');
  }
}
```

Call `printSpeechStatus()` after the load in `sayHello()` or from your status
button. The same projection is at
`ai.providerRuntime.status(null, {execution:true}).roles.tts.execution`.
`selectedDevice` is `null`
until a pool is selected and returns to `null` on unload. Providers without an
execution report omit `execution`; do not infer a device from `navigator.gpu`
or a configured preference alone. An explicit inspection can throw a provider
status error; handle it with the same `error.code` / `error.message` pattern.

## Stop, mute, cancel, and release

These are actions for your own controls, using the same `ai` instance:

```javascript
function stopSpeech() {
  ai.stopAudio(); // Cancels queued speech and stops scheduled/playing audio.
}

async function muteSpeech() {
  await ai.setSpeechMuted(true); // Stops audio and unloads TTS.
}

async function unmuteSpeech() {
  await ai.setSpeechMuted(false); // Loads TTS and permits playback.
}

async function unloadSpeech() {
  ai.stopAudio();
  await ai.providerRuntime.unload('tts'); // Keeps the provider configured.
}

async function disposeSpeech() {
  await ai.disposeBrowserSpeech(); // Releases SDK-owned speech providers.
}
```

STT has its own `ai.providerRuntime.load('stt')` and `unload('stt')` lifecycle
when configured; muting TTS does not unload STT or the LLM. A directly created
provider similarly exposes `load()`, `unload()`, and final `dispose()`.
`disposeBrowserSpeech()` leaves application-owned DBOPFS and stored artifacts
in place; it does not erase the application's data.

For a cancellable individual synthesis, unmute first. A fresh browser speech
configuration is muted, so calling `providerRuntime.load('tts')` directly at
that point rejects with `ARCANE_AI_TTS_MUTED`. `fetchTTS()` accepts an
`AbortSignal` as its second argument and returns a WAV `Blob` without playing it:

```javascript
const synthesisController = new AbortController();

async function synthesizeOneSentence() {
  try {
    await ai.setSpeechMuted(false);
    const result = await ai.fetchTTS({
      input: 'This request can be cancelled.',
      responseFormat: 'wav'
    }, synthesisController.signal);
    console.log(result); // The complete WAV Blob, with type 'audio/wav'.
    return result;
  } catch (error) {
    console.error(error.code, error.message); // Keep the complete message.
    throw error;
  }
}

function cancelSynthesis() {
  synthesisController.abort();
}
```

Call `synthesizeOneSentence()` from an owned UI action and catch its rejection;
wire `cancelSynthesis()` to its Cancel control. The controller cancels the
individual `fetchTTS()` request; it does not control the preceding
`setSpeechMuted(false)` load/unmute lifecycle. Use a fresh controller for each
new operation. Configuration accepts `configureBrowserSpeech(configuration,
{signal})`; disposal accepts `disposeBrowserSpeech({signal})`. The streaming
playback methods do not accept a caller signal; wire
your stream's abort action to `ai.stopAudio()` as well as aborting its producer.
Cancellation suppresses late results, but upstream Kokoro may finish active
engine work before the affected slot is reusable.

```javascript
const textStreamController = new AbortController();
textStreamController.signal.addEventListener('abort', function stopStreamAudio() {
  ai.stopAudio();
}, { once: true });

function cancelTextAndSpeech() {
  textStreamController.abort();
}
```

Pass that same `textStreamController.signal` to your text producer's supported
signal option. Connect `cancelTextAndSpeech()` to Cancel; use a new controller
for the next stream.

## Advanced provider and artifact reference

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
    maxConcurrentRequests: 4
  }
});
```

The constructors also accept ordinary `model` and `runtime` descriptors instead
of `graph`; the two forms are mutually exclusive. Both forms require an
SDK-created DBOPFS speech artifact store. `localOnly` remains `true`.

Kokoro additionally accepts the exact `execution` record
`{device,maxConcurrentRequests}`. `device` is `auto`, `webgpu`, or `wasm`;
`maxConcurrentRequests` is an integer from 1 through 4. Omission defaults to
`{device:'auto',maxConcurrentRequests:4}`. `auto` attempts a complete WebGPU
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
`{audio:Float32Array,sampleRate,voice}`. The provider/2 shared request form accepts
`{model,input,responseFormat:'wav',voice?,speed?}` and returns
`{audio:Uint8Array,contentType:'audio/wav'}`. High-level `AI.fetchTTS()` wraps
that provider result in a WAV `Blob`. Returned provider records remain ordinary
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
