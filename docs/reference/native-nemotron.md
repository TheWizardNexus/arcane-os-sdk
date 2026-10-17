# Native Nemotron streaming transcription

`arcane-os/local-ai/nemotron` provides `createNemotronRuntime`, a Node/Core
adapter for NVIDIA's public NeMo Speech ASR C ABI. One owned helper retains the
selected recognizer and optional diarization model. One active audio stream
belongs to that engine at a time. Existing Whisper transcription and standalone
diarization remain separate supported capabilities.

This adapter has no microphone, playback, conversational endpoint detector,
keyword classifier, cloud fallback or automatic engine replacement. The host
owns capture and the model owns conversational interpretation. A final ASR
segment does not establish that the person has finished thinking, yielded the
conversation, approved an action or issued an instruction.

## Preparation and selection

Select an upstream NeMo Speech runtime with its public ASR headers, library,
runtime dependencies and CMake package configuration. This implementation was
source-reviewed against the installed NVIDIA NeMo-Speech.cpp 0.2.0 public ABI,
`nemotron-3.5-asr-streaming-0.6b` and `Nemotron-3-Diarization`. Acquire runtime and
model assets through their upstream distribution; the SDK adapter does not
download or redistribute them.

`arcane-os/local-ai/nemotron/build` exports `buildNemotronHelper`:

```js
import {buildNemotronHelper} from 'arcane-os/local-ai/nemotron/build';
import {createNemotronRuntime} from 'arcane-os/local-ai/nemotron';

const built = await buildNemotronHelper(
    {
        runtime: {cmakeDirectory: selectedNeMoCmakeDirectory},
        outputRoot: selectedHelperOutputDirectory,
        signal,
        onEvent
    }
);
const engine = createNemotronRuntime(
    {
        runtime: {
            helperExecutable: built.helperExecutable,
            binaryDirectory: selectedNeMoBinaryDirectory,
            libraryDirectory: selectedNeMoLibraryDirectory
        },
        modelPath: selectedAsrModelPath,
        diarizationModelPath: selectedDiarizationModelPath,
        gpu: selectedNativeGpuOrdinal,
        onEvent
    }
);
await engine.load();
```

The builder requires CMake 3.26 or later and a platform C++17 toolchain. It
configures, builds and installs only the first-party helper, returning
`helperExecutable`, its `executable` alias, `root`, `platform`, `architecture`
and complete configure/build/install diagnostics. The caller selects the output
directory and supplies the appropriate installed upstream runtime. Windows
loads its runtime through the child's `PATH`; Linux uses `LD_LIBRARY_PATH` and
macOS uses `DYLD_LIBRARY_PATH`, alongside the helper's loader-relative paths.
`runtime.env` supplies additional child-only environment settings.

`gpu` is required: supply the native runtime's selected GPU ordinal or explicitly
select `-1` for CPU. Device selection belongs to the host. When the host changes
`CUDA_VISIBLE_DEVICES`, the ordinal must describe that child's visible devices.
The adapter reports `requestedGpu`; `observedBackend` remains `null` because a
requested device alone does not prove GPU inference.

Instead of `runtime`, supply an asynchronous
`prepare({signal, onEvent})` function returning that prepared descriptor.
Preparation runs during `load`, never at construction. `modelPath`,
`diarizationModelPath` and `gpu` may also be supplied by the returned descriptor.
Omit `diarizationModelPath` when speaker labels are not requested.

## Engine lifecycle

- `current()` returns selected provider/model, lifecycle `state`, `loaded`,
  `busy`, native version, requested device, active speaker scope, errors and any
  explicit reset requirement.
- `subscribe(listener, {replay: true, signal} = {})` immediately replays current
  state and observes subsequent lifecycle events; it returns an unsubscribe
  function.
- `load({modelId, modelPath, diarizationModelPath, gpu, signal} = {})` loads the
  selected models and resolves only when native readiness is reported.
  `modelId` defaults to `nemotron-3.5-asr-streaming-0.6b`. Concurrent callers share
  that load; one caller's signal cancels its wait, not the shared load. Unload
  before replacing an active selection.
- `unload()` cancels and joins the active stream and model preparation, closes
  the owned helper, and retains selection for a later explicit load.
- `close()` joins unload and disposes lifecycle subscriptions.

The host can compose this engine into the existing
[`createSpeechService`](./native-speech.md) STT engine seam. Readiness follows
the selected engine, not an application startup barrier.

## Ordered streaming

```js
const stream = await engine.openStream(
    {
        model: 'nemotron-3.5-asr-streaming-0.6b',
        sampleRate: actualCaptureSampleRate,
        signal,
        onUpdate: async function showRecognition(result) {
            await displayCompleteSnapshot(result);
        }
    }
);
await stream.push(monoFloat32Samples);
await stream.forceEndpoint();
// The same stream accepts the next utterance, preserving its speaker scope.
await stream.push(nextMonoFloat32Samples);
await stream.finish();
await stream.completion;
```

`openStream({sampleRate = 16000, languageCode, model, onUpdate, signal} = {})`
requires the selected model to be ready, or waits for its already-started load.
It never silently reloads after a reset. An explicit `model` must match the
loaded selection. `sampleRate` is the actual input rate: an integer from 8000
through 96000, or `0` for the model rate. It is passed unchanged to the native
API. The transport's ordered 100 ms scheduling does not reinterpret a 48 kHz
recording as 16 kHz or discard audio.

The returned handle contains `push`, `forceEndpoint`, `finish`, `cancel`,
`completion`, `current`, `sampleRate` and `speakerScope`:

- `push(audio)` accepts mono `Float32Array` or
  `{encoding: 'f32le', data: BASE64}` and resolves to all ordered snapshots from
  that input. The encoded form carries exact little-endian float32 samples.
  Keep a supplied array unchanged until its push settles. Other encoded
  recordings produce `NEMOTRON_AUDIO_FORMAT_UNSUPPORTED`; caller-owned decoding
  is required.
- `forceEndpoint()` drains the current ASR utterance while retaining the native
  stream, recognizer and diarization scope. Capture closure and conversational
  turn completion remain the host's decisions.
- `finish()` queues behind all accepted input, terminally finishes and drains
  the native stream, delivers remaining snapshots, and resolves with that final
  drain's snapshot array. The loaded engine remains available for another
  stream.
- `current()` returns the latest delivered snapshot, or `null` before one is
  available.
- `completion` settles after terminal finish or joined cancellation. Successful
  finish resolves to the final drain's snapshots; earlier snapshots have already
  been delivered through `onUpdate` and each operation's result.

Each snapshot includes `sequence`, `final`, `audioProcessedSeconds`,
`channelTag`, `speakerScope`, and every native `alternatives` record with its
exact `text`, `confidence`, `languageCodes` and `words`. Every word preserves
`word`, `startTimeMs`, `endTimeMs`, `confidence` and numeric `speaker`. Top-level
`text` and `words` expose the first alternative without changing its content.

Partial snapshots are provisional replacements, not appended transcript text.
Native endpoint finals describe individual utterances in a continuing stream;
they are forwarded unchanged. Keep their boundaries distinct. Speaker numbers
distinguish voices within the reported scope, not named people or biometric
identity. A new stream has a new scope. Timestamp values retain the native
runtime's units and origin without an invented offset.

Callbacks run serially in native result order and may be asynchronous. A
callback failure stops the stream, remains observable, and retains complete
native result records in diagnostics. Inside an active `onUpdate` callback,
calling `push`, `forceEndpoint`, `finish`, `cancel`, `unload` or `close` raises
`NEMOTRON_CALLBACK_WAIT`: those joined operations would wait for the callback
itself. Abort the caller-owned signal synchronously if cancellation is needed
there, return from the callback, then join through the external owner.

## Cancellation and complete recordings

`cancel(reason)` and an aborted stream signal first request ordinary native
stream closure. If a noninterruptible public-ABI call is in flight, cancellation
terminates only this engine's owned helper and joins it. It also joins accepted
JavaScript operations and output callbacks before releasing stream ownership.
Explicit cancellation resolves `completion` and `cancel` with
`{cancelled: true, resetRequired, speakerScope, diagnostics?}`. Actual native,
callback or cleanup failures reject and retain their diagnostic causes.

After helper termination, `current()` reports `resetRequired: true`, a reset
record and `state: 'unloaded'`. The next caller must explicitly `load()`;
recognizer replacement and speaker-scope reset are never silent. Ordinary
stream closure keeps the loaded helper. No cancellation claims that unfinished
recognition produced a complete final.

`transcribe(request, {signal, onProgress, onUpdate} = {})` uses the same stream
implementation for complete recordings. Supply `{audio, sampleRate, model?,
languageCode?}` or a direct supported audio value at the default sample rate.
It returns `{text, words, results, speakerScope}`, retaining all final records
in `results`, and emits accepted/recognizing progress. Its final text is the
ordered concatenation of native final text without inserted separators. It
does not decode WAV, MP3 or other encoded recording formats.

## Evidence boundary

The adapter, transport and platform paths have been source-reviewed. This
initial implementation has not been compiled or executed on Windows, Linux or
macOS, and has no measured latency, GPU-inference, microphone, diarization or
multi-utterance acceptance result. Header and upstream documentation review is
distinct from a built native application's observed behavior. Android requires
the necessary host integration and a matching native runtime.
