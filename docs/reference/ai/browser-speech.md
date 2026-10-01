# Browser speech providers

`arcane-os/ai/browser-speech` supplies caller-selected Whisper or native Web
Speech recognition and synthesis, Kokoro text-to-speech, and TWiN Cloud text-to-speech providers. Its local path
provides artifact storage, live module routing, role Workers, provider/2
adapters, bounded parallel TTS synthesis, audio normalization, cancellation,
and cleanup.

## Native browser speech recognition

Select the browser's `SpeechRecognition` or `webkitSpeechRecognition` service
explicitly. It may use a remote browser service, so this provider declares
`localOnly:false`; it is never substituted for Whisper automatically. The
application owns the provider/model identifiers and saved Profile selection.

```javascript
import {createBrowserSpeechRecognitionProvider} from 'arcane-os/ai/browser-speech';

async function selectBrowserRecognition(ai, signal) {
    const provider = createBrowserSpeechRecognitionProvider(
        {id: 'WEB_SPEECH', model: {id: 'WEB_SPEECH'}}
    );
    await ai.configureSpeechProvider('stt', provider, {modelId: 'WEB_SPEECH', signal});
}
```

Configuration and activation use the existing independent STT lifecycle.
Construction and `catalog()` succeed when the native API is absent;
`inspect()` reports unavailable and `load()` reports an unsupported error.
Neither factory, configuration nor load opens a microphone, downloads a
model, accesses storage, or changes TTS, typing, existing defaults, or saved
data. Browser/OS availability, microphone permission, language support and
service connectivity remain native platform requirements across Windows,
Linux, macOS and Android hosts.

After STT activation, the existing `speech.html` and `voice-transcription.html`
recording controls select live capture automatically. `speech.html` retains
every final result and emits one complete `speech-transcription-complete`
message when capture ends. Its live display retains finalized words alongside
the current interim text while speaking. The voice component appends each final result
through its existing ordered save queue. Interim text appears only in a
transient surface and never enters a save or completion event. A custom voice
component `transcribe(file,context)` callback retains the existing clip path.
Final segments waiting behind an application save remain visible in that
transient surface until the ordered queue appends them to the main transcript.

For direct use, `ai.supportsTranscriptionCapture()` detects the selected
provider's capture capability. `ai.createTranscriptionCapture(options)` returns
`null` for a file-only provider or a single-use capture handle with
`start({signal})`, `stop()`, `cancel()`, `destroy()` and `done`.
Options are `{language,continuous,onSegment,onInterim,onState,onError}`;
`onSegment({text,sequence})` receives each complete final result once, and
`onInterim({text})` receives the current mutable hypothesis. Callbacks are
observational and never delay native capture. The voice component, rather than
the capture callback, owns asynchronous ordered application saves.

Call `start()` directly from the initiating user gesture. Its promise resolves
to whether native capture actually started. `stop()` asks the browser to stop
listening and finish recognition, retaining final results through native `end`;
`stop()` and `done` resolve `true` for normal native completion and `false` for
cancellation or failure after capture settlement. Runtime cleanup failure
rejects the runtime handle's promises. `cancel()`, an aborted signal,
provider replacement, unload, and disposal request native `abort()` and suppress
late text. Capture is an owned busy STT operation; it is never delayed into a
request queue that would lose the gesture. Natural native `end` stops the
session without automatic restart. The user can start another session.
If native `abort()` itself throws, the complete failure remains observable and
the capture stays owned until native `end`; requesting abort is not evidence
that the browser microphone has disconnected.

Missing API reports `ARCANE_AI_SPEECH_RECOGNITION_UNAVAILABLE`; file input
reports `ARCANE_AI_SPEECH_INPUT_UNSUPPORTED`. Native service errors use
`ARCANE_AI_SPEECH_RECOGNITION_FAILED`, retain the browser reason and complete
event as their cause, and remain available in developer diagnostics. Shared
ordinary controls show concise failure status. Confirmed final words received
before a service failure remain deliverable; explicit cancellation or
supersession suppresses the pending chat submission.

This API captures live microphone speech. `AI.fetchSTT(file)` remains the
Whisper/file-provider contract; native recognition rejects file transcription
honestly rather than recording again or silently switching providers. See the
[Web Speech specification](https://webaudio.github.io/web-speech-api/#speechreco-methods)
for native stop/abort behavior.

## Native browser text-to-speech and voice previews

`createBrowserSpeechSynthesisProvider({id,model:{id,name?,defaultVoice?},language?})`
uses the host browser's `speechSynthesis` and `SpeechSynthesisUtterance`.
The application selects this provider as its default when desired; constructing
it does not change global preferences, activate Chat speech, or play audio.
The provider declares `localOnly:false` because a browser voice may use a remote
service. Individual catalog records expose the browser's `localService` value.

```javascript
import {createBrowserSpeechSynthesisProvider} from 'arcane-os/ai/browser-speech';

const voicePreview = createBrowserSpeechSynthesisProvider({
  id: 'browser-preview',
  model: {id: 'browser-voices', name: 'Browser voices'}
});
const unsubscribe = voicePreview.subscribeCatalog(function showVoices(models) {
  // Pass these real records to the application's language/voice selector.
  console.log(models[0].voices);
});

// Call only from the application's explicit Play action.
function playIntroduction(input, voice) {
  return voicePreview.play({input, voice});
}
// The owning view unsubscribes and disposes voicePreview when it closes.
```

`catalog()` synchronously returns an array of model records. Each model has
`speech:{playback:'native'}` and `voices:[{id,name,lang,default,localService}]`;
`id` is the exact native `voiceURI`. `subscribeCatalog(callback)` immediately
replays that same shape and updates it on `voiceschanged`, returning an
unsubscribe function. An initially empty inventory is ordinary pending browser
state. There is no polling, discovery utterance, model download, or page-load
barrier. Language selectors derive their choices from this actual inventory.

`prepare({input,voice?,language?,speed?},{signal?})` returns an inert
`{kind:'native-speech',input,voice,language,speed,play(options)}` descriptor.
`play(payload,{signal,onState})` is the explicit-preview convenience. Both
preserve complete input. Omitted voice uses the configured `model.defaultVoice`
or the actual browser default; a supplied voice is never replaced with a named
SDK alias. Language comes from that voice unless explicitly provided. Neither
API reads the conversation's language preference. A saved voice waits for
`voiceschanged` if the inventory is empty; a nonempty inventory missing it
reports `ARCANE_AI_SPEECH_VOICE_UNAVAILABLE`.

Playback returns `{finished,released,state,error,pause(),resume(),stop()}`.
`finished` resolves `true` on actual native end, `false` on stop/abort, and
rejects genuine native failures. `released` resolves when native resource
ownership actually ends: a failed pause/resume/cancel can report an error before
the utterance terminates. `onState({state,error})` observes queued,
waiting-for-voices, playing, paused, complete, stopped, or error. Keep complete
errors in diagnostics and ordinary status in the interface.

Preview does not depend on AI mute or model activation. Use a separate provider
instance when the preview should have a lifetime independent of Chat's selected
provider. Provider unload/dispose stop their own playback, invalidate prepared
descriptors, and disposal removes catalog listeners. Web Speech pause/resume/cancel
operate on the native synthesis object globally; the SDK serializes its own
utterances and does not claim control isolation from unrelated direct native
callers. See the [native synthesis contract](https://webaudio.github.io/web-speech-api/#tts-section).

For Chat, configure this provider with `ai.configureSpeechProvider('tts',provider)`
and retain the existing explicit mute/unmute lifecycle. `AI.streamTTS()` and
`SpeechPlayback` use actual utterance completion and cancellation in original
order. `AI.prepareTTSPlayback(payload,signal)` returns either real Blob audio or
the native descriptor without speaking; its signal remains attached by default
when the returned descriptor is played. `AI.fetchTTS()` and durable
`AI.prepareTTS()` remain audio-file APIs and report
`ARCANE_AI_TTS_AUDIO_EXPORT_UNAVAILABLE` for native synthesis, which exposes no
downloadable audio file.

<a id="digitalocean-fal-text-to-speech"></a>

## TWiN Cloud text-to-speech

Use the same AI speech queue with an explicitly selected remote provider.
The application supplies its current DigitalOcean inference key through a
function returning a string or promise; never place that key in source, logs, or model records.
This example receives an existing `ai` and application-owned key reader:

```javascript
import {createTwinCloudTTSProvider} from 'arcane-os/ai/browser-speech';

async function selectCloudVoice(ai, getApiKey) {
  const provider = createTwinCloudTTSProvider({
    id: 'my-cloud-voice',
    model: {
      id: 'fal-ai/elevenlabs/tts/multilingual-v2',
      defaultVoice: 'Rachel'
    },
    getApiKey,
    maxConcurrentRequests: 4,
    followUpQueue: {maxConcurrentRequests: 4, intervalMs: 250}
  });
  await ai.configureSpeechProvider('tts', provider, {
    modelId: provider.catalog()[0].id
  });
  return provider;
}
```

`createDigitalOceanFalTTSProvider` remains a compatibility export of the same
factory. Existing provider IDs and credentials remain valid; the TWiN Cloud
name does not change the underlying DigitalOcean FAL endpoint or protocol.

Construction and configuration make no network request. Explicit
`ai.setSpeechMuted(false)` awaits the key reader, checks credential presence, and activates
the adapter; its ready state does not prove remote credential validity.
Only synthesis submits text. Keep local STT configured independently, before
or after this TTS selection. Existing shared Chat/Speech controls own user
mute/unmute intent; do not reapply a saved unmute over a later manual mute.
An asynchronous key reader may await the application's already-running key
refresh at this activation boundary; it does not delay provider configuration
or page rendering. Cancellation releases this request's wait without cancelling
the application's shared refresh, and no late key result starts synthesis.

Once explicit activation is requested, feed each arriving text chunk immediately through
`ai.streamTTS(chunk)` and observe each promise without awaiting it ahead of
the next chunk. Pending activation retains these segments in the existing queue
until the selected provider is ready; text does not initiate activation itself.
`ai.finishTTS()` submits the final remainder. The existing
punctuation segmentation, concurrent provider queue, and original-order
playback remain the only owners. Use
`ai.configureTTSSegmentation({punctuation:'any',wordCadence:null})` when each
punctuation boundary should submit promptly. This is incremental playback of
completed synthesis jobs, not a live audio stream from TWiN Cloud.

The provider queues each complete synthesis job, including initial
`POST https://inference.do-ai.run/v1/async-invoke` and any eligible submission
retry. `maxConcurrentRequests` defaults to four whole jobs. Each slot remains
occupied through credential readiness, submission, queued/running status, and
the complete final audio response. Additional requests wait in order; cancelling
a waiting job removes it before credential reading or submission. This capacity
is separate from `followUpQueue.maxConcurrentRequests`.

One provider-local `js-queue` owns only follow-up status/result GETs and the final
audio GET. `followUpQueue` defaults to `{maxConcurrentRequests:4,intervalMs:250}`;
the application may supply those settings explicitly. A follow-up slot remains
occupied through the complete JSON, audio Blob, or error response body. Dispatch
starts observe `intervalMs`, with at most the configured number in flight. Each
job awaits its current response and body before immediately enqueueing another
request only when incomplete or eligible for a retry. There is no additional
per-job polling delay.

A successful pending response's `Retry-After` changes that job's next eligibility.
A `429` applies a shared cooldown to all queued submission and follow-up starts,
using a one-second minimum and any longer readable `Retry-After`. A completely
readable `429` permits one retry of that submission or status read, within the
same whole-job slot. Already dispatched operations retain their response ownership.
An accepted job's status Fetch network failure may retry once for the same job;
Ambiguous POST network, JSON parsing, and error-body read failures never replay
the submission. Repeated failures surface their
complete diagnostics without an endless retry loop; a failed job does not cancel
siblings. Retry diagnostics remain in the developer console, outside conversation
history.

The provider-local queues are created when this cloud factory is called, not when the browser
speech entrypoint is imported. Local Kokoro and Whisper do not use this queue;
their setup, Workers, synthesis/transcription, and lifecycle remain independent.

Ordinary Kokoro descriptors may supply `model.voices` as complete display records,
for example `{id:'af_heart',name:'Heart',lang:'en-US'}`. The synchronous
`provider.catalog()[0].voices` preserves that array and its metadata without
loading the model or fetching a catalog. The application supplies the inventory
for its selected runtime; these records neither create a synthesis allow-list
nor establish that a voice has loaded or played. Ordinary Worker configuration
does not receive this display inventory. Existing artifact-graph voice paths
retain their separate meaning.

The SDK pins published `js-queue` through npm. Its browser Queue entry, original
package metadata, and license are projected unchanged by
`node tools/sync-js-queue.mjs` after an SDK dependency update. The existing runtime
materializer serves that same entry; applications do not need another import-map
setting. `easy-stack` remains an npm dependency and is not imported by the Queue
entry. Do not hand-edit this upstream projection.

An ambiguous submission network failure is not automatically resubmitted: a
browser cannot distinguish a rejected preflight from an accepted paid job whose
response was lost. This contract has no submission idempotency mechanism, and
unreadable response headers cannot supply a retry delay. Follow-up pacing does
not claim to free upstream concurrency slots or fix CORS.
The audio download never receives the inference Authorization header.
The selected multilingual-v2 service supports speed `0.7` through `1.2`;
unsupported speeds reject rather than being silently clamped. Complete
input remains intact except for the existing explicitly owned speech-only
formatting cleanup described below. A cloud failure never selects local TTS.

`ai.stopAudio()` cancels the current local request/poll/download/playback
lifetime. Mute additionally unloads TTS. DigitalOcean exposes no documented
job cancellation operation through this contract: a submitted remote job may
continue after local cancellation. Browser use also depends on the inference
and returned media endpoints allowing the requesting origin.

Release this exact configured provider with:

```javascript
// Keep the provider returned by selectCloudVoice(ai, getApiKey).
await ai.configureSpeechProvider('tts', null, {expectedProvider: provider});
```

The identity is rechecked inside the SDK's serialized configuration operation,
so a later selected provider remains untouched. Returning to local TTS uses
the normal TTS-only `configureBrowserSpeech()` configuration. Neither action
unloads STT or changes its stored artifacts.

Transport references: [DigitalOcean asynchronous inference](https://docs.digitalocean.com/reference/api/reference/serverless-inference/#inference_create_async_invoke),
[DigitalOcean FAL guide](https://docs.digitalocean.com/products/inference/how-to/use-fal-models/),
and [multilingual-v2 model schema](https://fal.ai/models/fal-ai/elevenlabs/tts/multilingual-v2/api).

## Quick start: say one sentence

Use this in a browser application served by `arcane dev`, where the generated
import map resolves `arcane/AI` and `arcane/DBOPFS`. These browser modules are
not Node inference APIs. To create an application:

```bash
npx arcane-os@0.5.18 new hello-speech --path ./hello-speech --target browser
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
    dtype: 'fp32',
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

The omitted execution record below uses the SDK's NPU, GPU, then CPU automatic
selection. This basic configuration uses `fp32` because
[Kokoro.js recommends `fp32` when using WebGPU](https://github.com/hexgrad/kokoro/tree/main/kokoro.js#usage).
Automatic fallback carries this same selected model and dtype between devices;
the SDK does not rewrite the application selection. If you intentionally choose
another dtype, evaluate that exact model, browser, and execution route.
`selectedDevice` reports routing after load, not pronunciation, text fidelity,
or audio quality.

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

## Browser NPU and GPU setup

Applications can place the shared `browser-ai-setup.html` component in their
profile or settings page. It reports whether this page exposes WebNN and
WebGPU, then requests one WebGPU adapter to display its availability and reported
name. It does not load a model or create a GPU device or WebNN context:

```html
<html-import
  id="browserAISetup"
  href="/arcane/components/browser-ai-setup.html">
</html-import>
```

**NPU setup** provides a **Copy NPU flag address** button regardless of WebNN
availability, with one short explanation. Chrome uses
`chrome://flags/#web-machine-learning-neural-network`; Edge uses
`edge://flags/#web-machine-learning-neural-network`. Unrecognized browsers
receive explicit Chrome and Edge choices. A failed copy shows the complete
address as selectable text; the component does not open internal browser pages.
The [ONNX Runtime WebNN guide](https://onnxruntime.ai/docs/tutorials/web/ep-webnn.html)
documents the **Enables WebNN API** flag and model/operator requirements.

The **GPU performance** section shows a short adapter status and a **Copy GPU
flag address** button on desktop Windows Chromium browsers. The button remains
available for every adapter class, unavailable API, or detection failure. One
shared instruction explains pasting, enabling, saving work, then closing the
browser and reopening it, with the final step underlined and emphasized. Identified
Chrome uses `chrome://flags/#force-high-performance-gpu`; other recognized
Chromium browsers use their corresponding internal scheme. **Refresh**
requests a new availability result; concurrent
requests share the pending operation. The public `checkGpu()` method provides
the same promise, while `refresh()` remains a synchronous API-presence and
settings update. Component readiness does not wait for adapter detection.

Adapter selection uses `powerPreference: "high-performance"` as a hint, not proof
of the selected GPU's performance or the flag's current state. When the browser
explicitly reports a discrete GPU, Profile says **Already using the performance
GPU.** Explicit integrated or software/fallback
metadata is reported as such. Missing type metadata shows **GPU available.**
and leaves performance selection unconfirmed; a vendor name is not a GPU
classification. The component cannot read the browser flag or prove that a
model is executing on the adapter. See the
[component contract](../runtime-components.md#browser-ai-setuphtml) for result
fields, failure handling, and disposal behavior.

This control does not save an execution preference, change browser settings,
restart the browser, or report that the NPU is active. A WebNN API presence
result is not proof of NPU hardware, a compatible model, or physical execution.
The profile also cannot report a different chat page's loaded runtime. The
existing automatic speech route remains NPU, then GPU, then CPU; upstream
sessions can still place unsupported operators on CPU. Use the owning model
runtime's evidence to determine actual accelerator execution.

## Developer diagnostics

The shared logging API and speech traces are available in SDK `0.5.14`.

Arcane uses the existing shared `user.developer` preference for diagnostic
logging. Enable **developer mode** in the application's profile settings; the
logger reads that preference on every emission after the shared user is ready.
There is no separate speech verbosity or language setting. Ordinary warnings
and errors remain visible with developer mode disabled.

Applications can use the same owner for their complete AI requests and parsed
responses:

```javascript
import { arcaneLogging } from 'arcane-os/logging';

arcaneLogging.info('AI request', request);
arcaneLogging.info('AI response', response);
```

`arcaneLogging.log`, `.info`, and `.debug` use the developer preference and
appear at the browser console's normal Info level. `.warn`, `.error`, and
failure `.trace` calls remain visible in either mode. The same logger is
available as `globalThis.arcaneLogging`; it stores no diagnostic history.

Speech diagnostics include complete API inputs and results, selected provider
and model, exact segment text, voice and speed, generation queue state, Worker
request IDs and responses, and decoding/playback events. Worker requests are
copied only for developer diagnostics before native transfer detaches their
audio buffers; the original request still goes to the Worker unchanged.

Follow a speech `jobId` through `queue.add`, `generation.request`,
`generation.result`, `decode.result`, `playback.scheduled`, `playback.ended`,
and `queue.complete`. Cancellation and failure appear as `queue.cancelled`
and `queue.failed`. Each playback record includes the audio clock,
sample rate, duration, playback rate, and scheduled start/end when available.
For ready adjacent buffers, `gapSeconds` is zero on the same audio clock;
`audioEnd` marks the end of audio and `scheduledEnd` includes the caller's
requested pause. A positive gap can expose generation arriving too late to
fill the audio clock continuously. A scheduled event alone does not establish
that the buffer finished; use its `playback.ended` event.

Diagnostics do not change text, voice, speed, language selection, segmentation,
generation capacity, or playback scheduling. They stay outside chat history.

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

## Play a complete array with `SpeechPlayback`

Use this when your application already has complete segments in an array. The
configured `ai` below is the same instance created in the quick start.

```javascript
import SpeechPlayback from 'arcane/SpeechPlayback';

const audio = document.body.appendChild(document.createElement('audio'));
audio.controls = true;
const narration = new SpeechPlayback({audio, speech: ai});
const speakAll = document.body.appendChild(document.createElement('button'));
speakAll.textContent = 'Speak all segments';
speakAll.addEventListener('click', async function speakAllSegments() {
  await ai.setSpeechMuted(false);
  await narration.prepare({
    parts: [
      'First complete segment.',
      'Second complete segment.',
      'Third complete segment.'
    ],
    autoplay: true
  });
});
```

`prepare()` submits all three parts immediately because this `ai` exposes
`fetchTTS` and advertises TTS execution capacity. With the default configuration,
the provider admits up to four synthesis requests and keeps later requests in
its FIFO queue. Completed audio remains indexed, so playback is always first,
second, third even if the third synthesis finishes first.

This eager path is capability-driven. A native `Arcane.speech.synthesize`
client, or a custom client without a positive advertised TTS execution capacity,
retains serialized synthesis with one lookahead segment. `togglePause()` pauses
and resumes the same `audio` element. `stop()` cancels all requests owned by the
playback. `replay()` keeps completed and pending provider segments and retries
only failed missing segments.

The default `{device:'auto',maxConcurrentRequests:4}` attempts the full ONNX
Worker/session pool on WebNN NPU, then WebGPU, then CPU through WASM. It skips
an accelerator when its browser API is absent and replaces a failed candidate
with a fresh pool before trying the next device. The basic configuration above
keeps `fp32` throughout that sequence. Use the status example below to read
`selectedDevice`; console node-assignment warnings alone do not identify the
selected execution device or assess the generated audio.

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
streamed speech and prepared playback owned by that AI instance and settles
pending playback results `false`. Detached preparation described below keeps
its independent lifetime.

The selected voice and speed are captured for segments extracted by that call.
That includes any text left in the same AI instance's partial-stream buffer;
finish the previous producer before starting a separate complete passage.
Voice, speed, pause, and playback options are not retained with an unfinished
`end:false` remainder. A later call supplies its own options, and `finishTTS()`
uses their defaults while flushing any pending single formatting mark through
the same automatic speech-input cleanup.
A call extracting no segments returns `true` without waiting for earlier jobs.
An already muted call returns `false`.

Autoplay permission waiting and recoverable audio-resume attempts leave the
playback promise pending until playback completes or is stopped. A failed
resume of a closed `AudioContext` terminates the affected jobs and settles
their playback results `false`. A trailing
pause delays the next queued audio on the existing `AudioContext` clock; it
does not delay the preceding promise after that passage's last buffer ends.
The promise is a playback result, not a listener acknowledgement.

## Prepare narration once and replay stored audio

Use `ai.prepareTTS()` when preparation must continue independently of playback,
or when a later visit should reuse generated audio. It returns a handle
synchronously and starts preparing the supplied complete parts without speaking
them. Attach `ai.playPreparedTTS()` immediately to play those parts as their
audio becomes available, or omit playback to prepare them silently.

Use the configured `ai` and ready, application-owned `dbopfs` from the quick
start. Configuration itself does not load Kokoro. This path reads stored audio
first: a complete match can replay while the AI starts muted, with no model
load. Only missing audio requests the selected provider's shared load/unmute
path. Do not eagerly call `setSpeechMuted(false)` before this path if fully
cached playback should avoid loading the model.

```javascript
ai.configureTTSSegmentation(
    {
        punctuation: 'any',
        wordCadence: null
    }
);

function prepareNarration(text, key) {
    return ai.prepareTTS(
        {
            parts: [
                {
                    input: text,
                    voice: speechSelection.model.defaultVoice,
                    speed: 1,
                    pauseAfterMs: 0
                }
            ],
            storage: {
                db: dbopfs,
                table: 'saved_narration',
                key
            },
            identity: {
                model: speechSelection.model,
                runtime: speechSelection.runtime
            },
            onState: reportNarrationPreparation
        }
    );
}

function reportNarrationPreparation(state) {
    console.log('Narration preparation:', state);
}

function reportNarrationPlayback(state) {
    console.log('Narration playback:', state);
}

async function readNarration(text, key) {
    const prepared = prepareNarration(text, key);
    const playback = ai.playPreparedTTS(
        prepared,
        {onState: reportNarrationPlayback}
    );
    const [record, ended] = await Promise.all(
        [prepared.ready, playback.finished]
    );
    return {record, ended};
}
```

Call `readNarration('**Hello**. Welcome back.', 'welcome')` from an owned user
action and handle its rejection. Calling only `prepareNarration(...)` prepares
silently; observe that handle's `ready` promise to receive its complete record
or error. A storage key groups application content. The application owns its
keys, preparation priority, semantic identity, and retention policy; the SDK
does not select another page or speak background work.

### Preparation inputs and reuse

`ai.prepareTTS({parts,storage,identity,signal,onState})` accepts an ordered array
of strings or `{input,voice?,speed?,pauseAfterMs?}` records. An omitted voice
uses the selected model default; omitted speed uses `ai.voiceSpeed`; omitted
pause is zero. The SDK snapshots the selected speech configuration and current
punctuation/word-cadence options for that preparation. A part's pause applies
after its final extracted segment. Complete original input remains available
for semantic comparison; automatic Markdown cleanup affects only the speech
copy and occurs once before segmentation.

`storage` is optional. When supplied, `{db,table,key}` names the caller's ready
DBOPFS instance and its application-owned table/key. The SDK stores complete
generated audio as raw files and retains MIME metadata separately so subsequent
`Blob` playback preserves its content type. Reuse compares complete semantic
inputs, including parts, selection, segmentation, and separate application
`identity`. A changed voice, speed, source text, or other semantic selection
prepares the changed request. An SDK patch version alone does not invalidate
stored speech.

The storage key is encoded as `encodeURIComponent(key) + '.json'` for its
manifest. That version-1 manifest keeps an `entries` array of semantic variants
under the key. Each entry records
`{id,parts,originalParts,selection,segmentation,identity,segments}`; the ordered
stored segment entries name `{audioFile,contentType}`. `originalParts` retains
the complete source text, including whitespace. These persistent semantic
inputs and `identity` must be JSON-compatible. Raw audio filenames contain the
generated record ID and segment index. Storage writes preserve existing
variants; the application chooses when its records should be removed.

Matching pending requests on the same AI instance and the same storage
`db`/`table`/`key` share synthesis. Each caller receives its own handle and
cancellation signal. Cancelling one handle detaches that caller; the shared
preparation is aborted only when its last pending caller cancels. Different AI
instances do not share an in-flight synthesis operation. Complete stored
results remain reusable through the same application storage.
After a durable preparation completes, a later preparation call rereads its
manifest and saved-file presence, regenerating only missing segments. A
completed preparation without storage reuses its retained Blobs.

Preparation requests retain call order for synthesis admission. Within each
request, punctuation segments use the existing bounded provider queue: the
default Kokoro capacity admits up to four at once, with later segments waiting
in FIFO order. Completion may be out of order; segment metadata and playback
remain in input order. Preparing another request does not attach it to playback.

### Preparation handle and progress

| Member | Contract |
| --- | --- |
| `state` | Current string: `queued`, `preparing`, `ready`, `error`, or `cancelled`. |
| `segments` | Ordered segment metadata with `input`, `voice`, `speed`, `pauseAfterMs`, `index`, `state`, `audioFile`, `contentType`, and `error`. |
| `ready` | Promise resolving the complete ordered record when every segment is generated or reused and, when storage is supplied, durably saved. Rejects with the complete error or `AbortError` if cancelled while pending. |
| `getAudio(index)` | Promise waiting for that ordered segment and returning its complete `Blob` with the recorded MIME type. |
| `cancel()` | Cancels this preparation handle without erasing successful stored segments. |

The optional synchronous `onState` callback receives
`{state,completed,total,segments,error}`. It observes preparation only; it is
not a playback-state callback. `completed` counts settled segments, including
failed segments; inspect `state`, segment errors, and `ready` for the outcome.
`total` is the number of ordered segments.
Without `storage`, the handle retains generated Blobs for its lifetime; the
same result shape has `audioFile:null` and the actual `contentType`.
The supplied signal observes preparation until `ready` settles. Manual
`cancel()` remains available afterward to stop further reads through that
handle. If a raw audio write has already begun when cancellation arrives,
its metadata transaction finishes so that successful audio can be reused;
no later queued write starts for that cancelled preparation.
Cancelling preparation prevents later synthesis, but the existing shared
provider load/unmute operation has no per-preparation signal and may finish.
Cancellation does not claim to stop an already-started shared model load.

### Playback controls and independent lifetimes

`ai.playPreparedTTS(prepared,{signal,onState})` returns
`{state,error,finished,pause(),resume(),stop()}` immediately. It uses the
existing AI audio-clock scheduler and waits for each earlier segment before scheduling
later audio. Ready adjacent buffers retain contiguous scheduling. Requested
pauses separate adjacent parts; a final trailing pause does not delay
`finished`, which resolves after the final audio buffer ends.

`state` and `error` are current-state getters. The optional synchronous
`onState` callback receives `{state,error}` and is observational. Playback
states are `waiting`, `waiting-for-gesture`, `scheduled`, `paused`, `complete`,
`stopped`, and `error`. Use `waiting-for-gesture` to present an audio-unlock
control. A `false` result from `resume()` is not a first-segment-ready signal;
inspect `state` and `error` to distinguish a stopped or unavailable context
from browser gesture waiting. The ordinary playback path creates its audio
context immediately, before the first audio segment is ready.

`finished` resolves `true` after natural playback completion and `false` after
stop, playback cancellation, or failure. Real failures also reach the existing
`ai-tts-failure` event and complete SDK diagnostics. `pause()`
and `resume()` control only this handle's audio context, and `stop()` stops
that playback handle. The controls return booleans; pause and resume are
asynchronous. Each AI has one playback lane: a new `playPreparedTTS()` call
stops its preceding streamed or prepared playback, and `streamTTS()` interrupts
active prepared playback. This replacement preserves detached preparation.
None of these playback controls cancels preparation or deletes saved audio.
Use the preparation handle's `cancel()` or its separate `signal` when the
application also wants to stop preparation. Successful saved segments survive
cancellation or failure for later reuse.

`ai.stopAudio()` stops streamed speech and all prepared playback on that AI,
while detached preparation continues. `ai.setSpeechMuted(true)` additionally
cancels provider TTS work and unloads the provider. Replacing the speech
configuration cancels missing generation tied to the earlier selection.
Neither action deletes completed stored audio. Apply those broader lifecycle
controls deliberately when the application intends to stop provider work.

Preparation `ready` and playback `finished` are separate promises. Natural
playback completion must not be used as a signal to cancel other background
preparations. A page that starts several preparations owns and observes every
`ready` promise, even when it plays only one handle. Browser autoplay permission
still applies; neither promise proves that a person heard the audio.

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
segments, call `ai.configureTTSSegmentation({punctuation:'any',wordCadence:null})`
before feeding the stream. Chunk boundaries themselves do not force a sentence
boundary; `finishTTS()` flushes any remaining text. It is not a playback-ended
notification. Do not mute or dispose immediately after it if playback should
continue.

Automatic model-stream completion reads the AI instance's current mute state.
While muted, it clears pending speech text and formatting state and stops
prepared playback without invoking `finishTTS()` or `streamTTS()`. Unmuted
completion keeps its ordinary speech flush. Explicit calls to either public
speech method retain their existing behavior.

## Automatic speech-input formatting cleanup

Every TTS entrypoint removes repeated same formatting marks from the outbound
speech-input copy automatically. No application option is required:

```javascript
ai.streamTTS('## Heading\n**Hello');
ai.streamTTS('**. Next sentence.');
await ai.finishTTS();
```

The SDK omits runs of two or more of the same `*`, `#`, `_`, backtick, or `~`
before speech segmentation. A candidate run split across chunks is still
recognized. Single marks, ellipses, quoted endings, and all other text are
preserved. This is a small narration filter, not a full Markdown parser.
Ordinary prose is forwarded immediately; only a trailing formatting candidate
waits for its next character or the final flush.

`end:true`, `finishTTS()`, or cancellation clears pending streaming formatting
state. `fetchTTS()`, provider-runtime TTS requests, direct Kokoro provider
requests, and `SpeechPlayback` apply the same cleanup to complete input. An
existing `textFormat` extra is ignored and cannot disable or select cleanup.
SDK-internal delegation carries `{speechInputPrepared:true}` outside the speech
payload only after one cleanup pass, preventing a second non-idempotent pass.
Applications omit that internal metadata. Displayed messages, saved history,
model input, caller payload objects, language, voice, synthesis capacity, and
playback timing are not changed by the filter.

The shared helper is public for code that needs the speech-only
transformation directly:

```javascript
import {
  MarkdownSpeech,
  stripSpeechFormatting
} from 'arcane-os/speech-text';

console.log(stripSpeechFormatting('**Hello**')); // Hello
const speechText = new MarkdownSpeech();
console.log(speechText.append('## Head', false)); // ' Head'
console.log(speechText.append('ing', true)); // ing
```

## Choose a device or reduce memory use

Both speech roles accept `execution:{device,maxConcurrentRequests}`. Omitting
`stt.execution` selects `{device:'auto',maxConcurrentRequests:1}`; omitting
`tts.execution` selects `{device:'auto',maxConcurrentRequests:4}`. Whisper keeps
one transcription slot. Kokoro accepts capacities 1 through 4.

Automatic selection tries `webnn-npu` when `navigator.ml.createContext` is
exposed, then `webgpu` when `navigator.gpu` is exposed, then CPU through `wasm`.
API exposure only determines which upstream backend to attempt; it
does not establish compatible hardware, operators, or model shapes. A failed
candidate is fully cleaned up before the next candidate uses fresh Workers
with the same prepared model and dtype. An explicit `webnn-npu`, `webgpu`, or
`wasm` selection attempts only that backend and reports its failure.

These are four alternative TTS configurations:

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
// await selectSpeechExecution({ device: 'webnn-npu' });
// await selectSpeechExecution({ device: 'webgpu' });
// await selectSpeechExecution({ device: 'wasm', maxConcurrentRequests: 1 });
```

The TTS capacity override accepts integers 1, 2, 3, or 4; an STT capacity
override accepts only 1. Apply the same device choices to the configured
`stt.execution` record. A configuration change leaves TTS muted; explicitly
load/unmute again.

The selected upstream versions expose WebNN NPU through
[Transformers.js device selection](https://github.com/huggingface/transformers.js/blob/4.2.0/packages/transformers/src/backends/onnx.js)
and [Kokoro.js device forwarding](https://github.com/hexgrad/kokoro/blob/664c76a704021239ba59c84dcbaa4d3dece01fe9/kokoro.js/src/kokoro.js).
WebNN compatibility depends on the model's shapes and operations, browser,
drivers, and hardware. Unsupported operations may run through WASM even after
an NPU session loads; see the [ONNX Runtime WebNN contract](https://onnxruntime.ai/docs/tutorials/web/ep-webnn.html).

## Inspect the requested and selected device

Request the execution projection on the existing public runtime status after
loading. This explicitly reads the selected provider's current report; ordinary
`status()` retains its existing sticky snapshot and identity. There is no
separate execution-state event subscription.

```javascript
function printSpeechStatus(role = 'tts') {
  const status = ai.providerRuntime.status(role, { execution: true });
  const execution = status.execution;
  console.log('Speech role and state:', role, status.state);
  if (execution) {
    console.log('Requested device:', execution.requestedDevice);
    console.log('Selected device:', execution.selectedDevice);
    console.log('Capacity:', execution.maxConcurrentRequests);
    console.log('Active requests:', execution.activeRequestCount);
    console.log('Automatic WASM fallback:',
      execution.requestedDevice === 'auto' && execution.selectedDevice === 'wasm');
  }
}
```

Call `printSpeechStatus()` after the load in `sayHello()` or from your status
button. The same projection is at
`ai.providerRuntime.status(null, {execution:true}).roles.tts.execution`.
For configured Whisper, call `printSpeechStatus('stt')` or read the corresponding
`roles.stt.execution` projection.
`selectedDevice` is `null`
until a pool is selected and returns to `null` on unload. Providers without an
execution report omit `execution`; do not infer a device from `navigator.gpu`
or a configured preference alone. An explicit inspection can throw a provider
status error; handle it with the same `error.code` / `error.message` pattern.
`selectedDevice` names the backend requested by the successful upstream session
load. It does not prove that every operation ran on a physical NPU or GPU, or
establish transcription correctness, pronunciation, or audio quality. Evaluate
actual speech output for the model, dtype, browser, and device combinations your
application supports.

## Stop, mute, cancel, and release

These are actions for your own controls, using the same `ai` instance:

```javascript
function stopSpeech() {
  ai.stopAudio(); // Stops streamed speech and all prepared playback.
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
`AbortSignal` as its second argument, cleans repeated formatting marks from the
outbound input copy, and returns a WAV `Blob` without playing it:

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
| Node | Remote adapter available; local execution unavailable | TWiN Cloud uses Fetch and Blob. The local providers have no SDK Node speech-storage, Worker, or audio-decoder host. |
| Remote TTS | Explicitly selected | TWiN Cloud uses standard Fetch and Blob with an application-owned key; no Worker, OPFS, or local model is needed for this adapter. |
| Native browser STT | Explicitly selected, conditional | Requires `SpeechRecognition` or `webkitSpeechRecognition` and native microphone/service availability. No Worker, OPFS, or SDK model download; locality is not promised. |

STT and TTS own independent provider lifecycles. A failure or cancellation in
one role does not disable the other role or authorize a fallback provider.

## Public exports

```javascript
import {
  BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL,
  BROWSER_SPEECH_ARTIFACT_PROTOCOL,
  createBrowserKokoroProvider,
  createBrowserSpeechRecognitionProvider,
  createBrowserSpeechArtifactGraph,
  createBrowserSpeechAuthority,
  createBrowserWhisperProvider,
  createDbopfsSpeechArtifactStore,
  createDigitalOceanFalTTSProvider,
  createTwinCloudTTSProvider
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

## `removeBrowserSpeechModelCache()`

```javascript
const removal = await removeBrowserSpeechModelCache(
    {repository: 'Xenova/whisper-small', signal}
);
```

Exported by `arcane-os/ai/browser-speech`. This explicit operation removes all
cached revisions of the exact selected Hugging Face model from the current
origin's existing `transformers-cache`. It returns `{repository,removed}`,
where `removed` contains the complete URLs actually deleted. An absent cache or
model returns an empty list. Other models, runtime files, the Kokoro voice
cache, DBOPFS files, and preferences remain untouched. No model is loaded or
downloaded and no inference is started.

The caller owns model retirement policy and must stop using the retired model
before removal so a live provider cannot download it again. This operation is
separate from `store.remove(authority)`, which removes declared DBOPFS files.
`cacheStorage` may explicitly supply a CacheStorage implementation; it defaults
to `globalThis.caches`. Missing storage rejects with
`ARCANE_AI_STORAGE_UNAVAILABLE`; cache failures reject with
`ARCANE_AI_STORAGE_DELETE_FAILED`. An aborted `signal` stops further removals
with `AbortError`. Deletions already completed are retained in `error.removed`;
removal is repeatable and does not claim transactional rollback. The operation
enumerates one cache once and awaits each matching deletion in order.

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

- Kokoro forwards the pool's selected `webnn-npu`, `webgpu`, or `wasm` device to
  `KokoroTTS.from_pretrained()`. Its configured dtype remains exactly the
  caller-selected dtype on every path. The WASM path also uses
  `namespace.env.wasmPaths = {mjs,wasm}`.
- Transformers forwards the selected device to its speech-recognition pipeline,
  preserves the caller-selected dtype, and uses
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

Both constructors accept the exact `execution` record
`{device,maxConcurrentRequests}`. `device` is `auto`, `webnn-npu`, `webgpu`, or
`wasm`. Whisper permits capacity 1 and defaults to
`{device:'auto',maxConcurrentRequests:1}`. Kokoro permits integer capacities 1
through 4 and defaults to `{device:'auto',maxConcurrentRequests:4}`. `auto`
tries WebNN NPU when `navigator.ml.createContext` is exposed, then WebGPU when
`navigator.gpu` is exposed, then WASM. Before advancing after a failed load,
the SDK tears down the candidate and creates fresh Workers using the same
prepared model and dtype. Explicit device selections never fall back.

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
cache state, and warnings. Both speech roles include an `execution` record
with requested and selected device, request limit, and active request count. A
successful `selectedDevice` reports the backend requested by the upstream model
load. It does not prove that every operation ran on a physical NPU or GPU,
that accelerator kernels overlap, or that generated speech is correct. WebNN
may execute unsupported operations through WASM. A security field is absent
in ordinary mode.

The provider/2 load context accepts an optional `progress` callback. Speech
artifact preparation and upstream model loading publish records through that
callback and the shared sticky AI runtime state. Records include `phase`,
`stage`, `message`, the current `file` when available, and `elapsedMs`.
Known artifact inventories report `completed`, `total`, and `unit:'files'`.
Upstream model files are discovered during loading, so their total remains
`null` while completed files are counted. Remaining TTS pool initialization
reports completed model sessions. Consumers use an indeterminate progress bar
when no final total is known; transfer quantities do not determine this display.

The Worker sends intermediate `{protocol,id,type:'progress',progress}` messages
for its active load request. They do not settle the request; the ordinary final
response still owns completion or failure. Complete upstream callback content
remains in the adjacent `detail` field for diagnostics. Compatible observers
receive the latest progress when joining an active load, and cancelled,
superseded, or settled loads stop publishing progress.

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
  catalog, activation, optional STT/TTS execution override, and presentation
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
