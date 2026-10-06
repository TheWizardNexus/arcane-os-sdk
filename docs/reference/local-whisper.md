# Native Whisper transcription

Arcane runs `whisper.cpp` through a persistent native helper. A selected model
stays loaded across recordings. The helper reports actual model readiness,
native progress and timestamped segments, and completes cancellation before
the model or recording files are reused. The browser's existing
`AI.fetchSTT(audioFile, signal)` and Core `speech.transcribe` routes retain the
application's selected model and cancellation signal.

## Select the runtime and model

An application's `arcane-app.json` selects native speech alongside its other
independent local runtimes:

```json
{
  "native": {
    "localAI": {
      "runtimes": [
        {
          "id": "whisper.cpp",
          "backend": "auto",
          "models": ["whisper-small"]
        }
      ]
    }
  }
}
```

The equivalent package configuration is `arcane-package.json`'s `localAI`.
Existing unrelated descriptor fields remain part of the application's file.
`models` defaults to an empty array, so selecting the runtime alone acquires no
model. A single selected model becomes `modelId`; multiple models require an
explicit selected `modelId` before transcription. The built-in `whisper-small`
descriptor selects the official `ggerganov/whisper.cpp` `ggml-small.bin` model.
An explicit model descriptor is `{id, path}` or `{id, url, filename?}`.

Default Windows x64 preparation acquires the selected complete upstream
Whisper 1.9.4/b5130 CUDA 12.4 and CPU distributions, FFmpeg 9.0.2 essentials,
the selected model, and Arcane's helper asset from the matching SDK numeric
release. The Windows helper includes its selected Visual C++ release runtime
DLLs beside the executable. Preparation shares matching installation jobs, observes cancellation,
and preserves the complete selected runtime trees. Model-selection changes
can reuse the already prepared runtime and matching models.

With `backend: "auto"`, accelerated runtimes are attempted before CPU. Failure
to load an accelerated runtime falls back to the prepared CPU runtime. If
native accelerated inference fails, Arcane drains that context and retries the
complete decoded recording once on CPU with the same model. Cancellation,
input errors and observer errors do not trigger this retry. Explicit `cuda`,
`metal` or `cpu` selections retain that chosen backend.

During that accepted request's internal recovery, the engine reports
`state: "recovering"`, `loaded: false`, and `busy: true`, with the same selected
provider and model. It accepts no new transcription while the old context
drains and the CPU context loads. Only actual CPU readiness restores `ready`.
An explicitly unloaded, replaced, or closed model remains a cancellation
boundary; internal recovery preserves the original request and its signal.

`requestedBackend` identifies a preference. `observedBackend` and
`backendEvidence` report native initialization evidence when available; they
do not claim that every computation runs on the GPU. No driver or compiler is
installed on application startup.

## Core and development integration

Development and generated native Core entries compose a
[`createSpeechService`](./native-speech.md) with the selected Whisper engine.
Speech preparation and model loading proceed independently of the page,
chat and image services. Core publishes retained `speech.state` and per-request
`speech.progress`; transcription availability follows the selected engine's
actual loaded state. The shared service remains usable when only STT is
selected, through `transcriptionAvailable` and `roles.stt`.

The native bundle includes the helper, runtime libraries, decoder and selected
model under its runtime directory beside the application executable. Those
resources stay in the application bundle. They are not embedded into one
Windows executable. The compiler and matching upstream headers are build-time
requirements for the first-party helper only.

Applications may continue using the existing Core call:

```js
const transcript = await client.speech.transcribe({
    audioBase64,
    mimeType: 'audio/webm',
    model: 'whisper-small'
}, {signal});
console.log(transcript.text);
```

FFmpeg decodes the complete recorded media into mono 16 kHz PCM at the native
transport boundary. The original recording remains untouched during the
operation. Arcane imposes no recording-duration cap and does not trim the
transcript. The upstream inference API's signed-integer sample argument is
reported honestly if a recording cannot fit that native call; no audio is
silently shortened. Complete operation files are removed only after decoder
and native inference cleanup have completed.

## Public engine API

```js
import {createWhisperRuntime} from 'arcane-os/local-ai/whisper';

const stt = createWhisperRuntime({
    runtime: preparedRuntime,
    modelId: 'whisper-small',
    temporaryDirectory: applicationSpeechDirectory,
    onEvent: reportDiagnostic
});
const unsubscribe = stt.subscribe(renderModelState);
await stt.load({signal});
try {
    const result = await stt.transcribe({audioBase64, mimeType, model: 'whisper-small'}, {
        signal,
        onProgress: renderTranscriptionProgress
    });
    console.log(result.text, result.segments);
} finally {
    unsubscribe();
    await stt.close();
}
```

`createWhisperRuntime(options)` performs no model load. `options.runtime` is a
prepared descriptor returned by `ensureLocalAIRuntimes`; alternatively,
`options.prepare({signal, onEvent})` lazily returns that descriptor during
`load`. `temporaryDirectory` is required and belongs to the application.

| Member | Contract |
| --- | --- |
| `current()` | Returns `providerId`, selected `modelId`, lifecycle `state`, `loaded`, `busy`, active `requestId` or null, requested/observed backend, evidence and any error. |
| `subscribe(listener, {replay = true, signal} = {})` | Immediately replays current state by default and returns an unsubscribe function. |
| `load({modelId, signal} = {})` | Prepares the runtime if necessary, then waits for actual native model readiness. With no selected model it remains unloaded. |
| `transcribe(request, {signal, onProgress, requestId} = {})` | Consumes the complete `audioBase64` recording. Optional `language` defaults to native automatic detection; `translate: true` selects Whisper's translation operation. `model` must match the loaded model. Optional `requestId` carries the caller's existing operation identity through lifecycle snapshots as separate control information; it does not alter the recording or request payload. |
| `unload()` | Cancels and joins active load/transcription, releases the native context, and permits a later explicit load. |
| `close()` | Joins shutdown and disposes this engine permanently. Repeated calls share the same shutdown. |

One retained model processes one recording at a time; a simultaneous request
receives `WHISPER_BUSY`. Model changes use `await stt.unload()` followed by
`stt.load({modelId})`. The `ready` state remains `loaded: true` with `busy: true`
during ordinary inference. Progress records include the native event plus
`backend` and `attempt`, so a CPU retry remains distinguishable. Segment text
is preserved in order. The final result is
`{text, language, duration, segments: [{index, start, end, text}]}`; times are
seconds and are native segment timestamps, not invented word timestamps.

Full process diagnostics stay with `onEvent` and native process failures.
Applications should use their selected inspection surface for those details
and keep ordinary user status concise.
Progress callbacks may cancel through the supplied controller and return;
they must not await the same transcription or its shutdown from inside its
own output callback. Await those operations in the initiating owner instead.

## Explicit runtimes and helper builds

Windows, Linux and macOS host integration uses the same public engine and
portable helper source. Automatic archive selection currently provides the
Windows x64 distribution above. Other targets supply their complete selected
runtime, decoder and compiled helper paths; their native execution requires
verification on that actual platform. Android requires a host adapter for
its process and library lifecycle.

An explicit runtime requirement can supply:

```js
{
    id: 'whisper.cpp',
    version: '1.9.4',
    backend: 'auto',
    variants: [
        {backend: 'cuda', root: cudaRuntimeDirectory, libraryDirectory: cudaLibraryDirectory},
        {backend: 'cpu', root: cpuRuntimeDirectory, libraryDirectory: cpuLibraryDirectory}
    ],
    helperExecutable,
    helperRoot,
    decoderExecutable,
    decoderRoot,
    models: [{id: 'whisper-small', path: selectedModelPath}],
    modelId: 'whisper-small'
}
```

`libraryDirectory` belongs to its complete variant root. `decoderExecutable`
belongs to `decoderRoot` (which defaults to its containing directory).
`helperExecutable` similarly belongs to `helperRoot`; its complete directory
tree is retained, including app-local native dependencies.
Preparation copies those selected resources into its owned installation, and
native packaging projects their paths relative to the application bundle.
`helperUrl`, `helperVersion`, and `decoderUrl` allow an explicitly selected
published distribution instead of local paths. Dependency permissions remain
the caller's responsibility.

```js
import {buildWhisperHelper} from 'arcane-os/local-ai/whisper/build';

const helper = await buildWhisperHelper({
    runtime: {directory: runtimeLibraryDirectory, sourceDirectory: matchingUpstreamSource},
    outputRoot: helperBuildDirectory,
    signal,
    onEvent: reportDiagnostic
});
```

The builder runs CMake configure/build/install against the selected matching
public upstream headers and runtime. Optional `cmake`, `generator`,
`cmakeArgs` and `env` select the existing toolchain. It returns the helper
`executable`, platform, architecture, runtime directory and complete build
diagnostics. The helper's documented process contract is in
[`native/README.md`](../../src/local-ai/whisper/native/README.md).
On MSVC, CMake's installed runtime-library module adds release CRT files to
the helper's `bin/` directory. `-DMSVC_REDIST_DIR=...` selects an existing
redistributable directory when needed. Windows provides the Universal CRT;
compiler tools and debug runtimes stay outside the application bundle.
