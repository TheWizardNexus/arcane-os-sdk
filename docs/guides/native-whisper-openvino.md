# Native Whisper with an Intel NPU encoder

Select `encoder: "openvino-npu"` to run Whisper's audio encoder through
OpenVINO on the Intel NPU. The decoder retains its separate `backend`
selection. Omitting `encoder` preserves the ordinary native Whisper path.

The initial precompiled distribution and producer target Windows x64 team
computers with Intel AI Boost and a compatible installed Intel NPU driver.
The selected runtime uses Whisper 1.9.4 and OpenVINO 2026.3.1. Application
preparation downloads native resources; it does not install a driver,
compiler, Python environment, or model converter. Other platform distributions
require their own complete compatible native resources; the Windows asset
does not establish NPU support on Linux, macOS, or Android.

## Declare the application requirement

Add the runtime to the application's `arcane-app.json`, retaining its other
descriptor fields:

```json
{
  "native": {
    "localAI": {
      "runtimes": [
        {
          "id": "whisper.cpp",
          "encoder": "openvino-npu",
          "backend": "auto",
          "models": ["whisper-small"]
        }
      ]
    }
  }
}
```

For a package descriptor, use the equivalent `arcane-package.json` `localAI`
field. Selecting only the runtime leaves `models` empty. A single prepared
model becomes the selected `modelId`; with several models, supply a `modelId`
that names one of them.

The default optional asset contains its matching helper, OpenVINO runtime,
NPU plugin and compiler libraries, and CUDA and CPU decoder libraries. An
`auto` installation extracts that complete tree once and creates CUDA and CPU
records referring to it.

| `backend` | Decoder selection with `encoder: "openvino-npu"` |
| --- | --- |
| `auto` | Try CUDA first, with the prepared CPU decoder available for loading or inference recovery. |
| `cuda` | Select the CUDA variant without Arcane's automatic CPU retry. |
| `cpu` | Select the CPU decoder. |
| `metal` | Unavailable in the default Windows distribution. |

Both auto-selected records retain the NPU encoder. A reported
`WHISPER_ENCODER_UNAVAILABLE` failure ends loading after the helper is drained;
changing the decoder cannot repair the same failed encoder initialization.
The helper requests the literal OpenVINO device `NPU` and does not replace it
with a CPU encoder. Decoder selection is a request; inspect observed metadata
for native initialization evidence.

## Keep the model files together

Under this encoder selection, the built-in `whisper-small` descriptor selects
Intel's multilingual small [paired model archive](https://huggingface.co/Intel/whisper.cpp-openvino-models/blob/main/ggml-small-models.zip):

| File | Purpose |
| --- | --- |
| `ggml-small.bin` | Whisper model used by the native context. |
| `ggml-small-encoder-openvino.xml` | OpenVINO encoder description. |
| `ggml-small-encoder-openvino.bin` | Matching OpenVINO encoder data. |

Preparation extracts the three selected files from that archive. Matching
prepared models can be reused when another model selection changes. The
ordinary `whisper-small` selection without `encoder` continues to use its
existing single GGML download.

A custom local model supplies all three paths:

```js
const model = {
    id: 'moon-base-small',
    path: '/application-owned/models/ggml-small.bin',
    encoderPath: '/application-owned/models/ggml-small-encoder-openvino.xml',
    encoderDataPath: '/application-owned/models/ggml-small-encoder-openvino.bin'
};
```

Use real paths on the target host. The installer copies the files together,
preserving their filenames so the XML can locate its matching BIN. A supplied
`path` selects this local-file route even when the descriptor also retains
archive metadata. Keep the GGML, XML and BIN from the same selected model
bundle.

An archive descriptor names each selected member:

```js
const model = {
    id: 'whisper-small',
    archiveUrl: 'https://huggingface.co/Intel/whisper.cpp-openvino-models/resolve/main/ggml-small-models.zip',
    filename: 'ggml-small.bin',
    encoderFilename: 'ggml-small-encoder-openvino.xml',
    encoderDataFilename: 'ggml-small-encoder-openvino.bin'
};
```

Put the descriptor in `models`. A standalone GGML `url` does not supply the
encoder files required by this selection.

## Development, native hosts and bundles

With the declarative requirement, `npm exec -- arcane dev` prepares the
application's native speech service alongside page serving. Its runtime
installation is under `.arcane/local-ai/runtimes`; Whisper operation files
and the OpenVINO encoder cache belong under `.arcane/speech/whisper`.
Preparation and model loading proceed independently of the page and other AI
services. Transcription follows the speech role's actual readiness.

A native host can prepare the same requirement explicitly:

```js
import path from 'node:path';
import {ensureLocalAIRuntimes, bundleLocalAIRuntimes} from 'arcane-os/local-ai';
import {createWhisperRuntime} from 'arcane-os/local-ai/whisper';

const appRoot = process.cwd();
const directory = path.join(appRoot, '.arcane', 'local-ai', 'runtimes');
const runtimes = [{
    id: 'whisper.cpp',
    encoder: 'openvino-npu',
    backend: 'auto',
    models: ['whisper-small']
}];

const [runtime] = await ensureLocalAIRuntimes({runtimes, directory});
const stt = createWhisperRuntime({
    runtime,
    temporaryDirectory: path.join(appRoot, '.arcane', 'speech', 'whisper')
});

await stt.load();
console.log(stt.current());
```

`ensureLocalAIRuntimes` returns prepared descriptors with absolute paths.
The host owns the engine's lifetime and calls `await stt.close()` at shutdown.
Use `subscribe(listener, {replay: true, signal})` for current-state replay and
later state changes. Preparation and loading accept `signal` and the
preparation APIs and engine constructor accept `onEvent` for diagnostics.

The application's existing native build path is
`npm exec -- arcane build --target windows-x64`, with the native target declared
in its descriptor. For an explicitly composed bundle, the same selection can
be copied into an application-owned output:

```js
const bundle = await bundleLocalAIRuntimes({
    runtimes,
    directory,
    outputRoot: path.join(appRoot, '.arcane', 'native-output'),
    platform: 'win32',
    architecture: 'x64'
});
```

Use a fresh bundle destination. This returns `{runtimes, files}` with paths
relative to the output root and places Whisper resources under
`runtime/local-ai/whisper.cpp`. The generated native Core entry resolves the
helper, runtime libraries, decoder and all three model paths from the relocated
bundle. Its operation files and `encoder-cache` use the native application's
state root. Native resources remain beside the application executable in the
bundle; application startup uses the prepared runtime.

## Connect a browser through native speech

The browser accesses this capability through its connected native Core speech
service. Browser JavaScript does not load OpenVINO DLLs or initialize the NPU.
Development uses the existing [local AI bootstrap](../reference/local-ai.md);
native packages compose the same speech service in their generated Core entry.

With an already connected Core client:

```js
const transcript = await client.speech.transcribe({
    audioBase64,
    mimeType: 'audio/webm',
    model: 'whisper-small'
}, {signal});
```

The existing `AI.fetchSTT(audioFile, signal)` route remains available. Observe
`speech.state` and `speech.status` through the
[native speech contract](../reference/native-speech.md); `roles.stt` and
`transcriptionAvailable` expose STT readiness independently of TTS.

Requests retain the complete recording and existing language and translation
options. Results retain `{text, language, duration, segments}`, with segment
`start` and `end` in seconds. Native media decoding, transcript content and
segment delivery follow the [Whisper contract](../reference/local-whisper.md).

## Read initialization evidence and handle failures

The engine's `current()` and state subscriptions separate the encoder from the
decoder:

| Field | Meaning |
| --- | --- |
| `requestedEncoder` | `NPU` for the selected OpenVINO NPU requirement; otherwise `null`. |
| `observedEncoder` | `NPU` after the public OpenVINO encoder initialization call succeeds; otherwise `null`. |
| `encoderEvidence` | `openvino-initialization` after that success; otherwise `null`. |
| `requestedBackend` | The selected decoder variant, or the configured preference before a helper is selected. |
| `observedBackend` | Backend observed in native initialization logs, when available. |
| `backendEvidence` | `runtime-log` when that observation is available. |

Before encoder initialization succeeds, observed encoder fields remain
`null`. The helper emits `ready` only after both its Whisper context and
selected encoder initialize. This proves initialization for that context;
it does not prove that a recording has been transcribed, that every operation
runs on the NPU or GPU, or that either device improves performance.

When native encoder initialization returns a nonzero result,
`WHISPER_ENCODER_UNAVAILABLE` includes that return code in its message. The
failure retains the joined helper failure in
`cause` when present, with captured process output in that failure's `details`.
For NPU `WHISPER_INFERENCE_FAILED`, Arcane shuts down and
joins the failed helper before returning the error: a successful shutdown
record is available in `error.data`, including complete `stderr`; a separate
exit failure is retained in `error.cause`. When multiple attempts fail,
inspect the complete `AggregateError.errors` as well. `onEvent` can deliver
diagnostics while work proceeds. Keep these complete records in developer
diagnostics; ordinary application status can use the concise lifecycle error.

With `backend: "auto"`, a recoverable accelerated inference failure can retry
the complete decoded recording once using the CPU decoder and the same NPU
encoder selection. The engine reports `recovering` while replacing the
context, retains the accepted request, and accepts no concurrent transcription.

OpenVINO's synchronous encoder call has no per-request cancellation seam in
Whisper. Cancelling an active NPU inference therefore retires the owned
helper process and waits for its exit before removing recording files. The
model becomes unloaded. After cancellation settles, call `await stt.load()`
with a fresh, unaborted signal before the next transcription. `unload()` also
cancels active work and drains the helper; `close()` ends the engine's lifetime.
Cancellation before native inference need not unload an already ready model;
follow the resulting authoritative state.

## Supply a complete custom runtime

For an existing compatible build, select a complete variant rather than
individual DLLs:

```js
const requirement = {
    id: 'whisper.cpp',
    encoder: 'openvino-npu',
    backend: 'cpu',
    models: ['whisper-small'],
    variants: [{
        backend: 'cpu',
        encoder: 'openvino-npu',
        root: nativeRuntimeDirectory,
        libraryDirectory: path.join(nativeRuntimeDirectory, 'bin')
    }]
};
```

Each variant supplies a local `root` or an archive `url`. A supplied
`libraryDirectory` is relative to or inside that selected tree; otherwise it
is found from the native Whisper library. Each optional complete tree contains
its own matching `arcane-whisper.exe` beside the runtime DLLs. Preparation
retains that variant's executable, so multiple custom builds keep their
matching helpers. Include all selected OpenVINO, NPU plugin/compiler, TBB,
Whisper, ggml and compiler-runtime libraries, plus the CUDA libraries when
selecting CUDA. A CPU variant still needs the OpenVINO NPU resources.

For custom automatic decoder recovery, declare both CUDA and CPU variants
with `encoder: "openvino-npu"`. Custom variants are prepared as explicitly
supplied trees. Library search configuration belongs to the launched helper
process and does not change the machine's global `PATH`. The general Whisper
helper and FFmpeg decoder overrides remain available through the existing
[runtime descriptor](../reference/local-whisper.md).

## Produce the optional native runtime

Runtime producers can use the public
`arcane-os/local-ai/whisper/openvino-build` export with the selected installed
Whisper 1.9.4 source, OpenVINO 2026.3.1 Windows development tree and an existing
compatible CMake/MSVC environment. `cudaDirectory`, when supplied, names the
matching upstream b5130 CUDA distribution's library directory. It supplies
the precompiled CUDA backend; omitting it produces the NPU-plus-CPU runtime.

```js
import {cp} from 'node:fs/promises';
import {buildWhisperOpenVinoRuntime} from 'arcane-os/local-ai/whisper/openvino-build';
import {buildWhisperHelper} from 'arcane-os/local-ai/whisper/build';

const nativeRuntime = await buildWhisperOpenVinoRuntime({
    sourceDirectory,
    openvinoDirectory,
    cudaDirectory,
    outputRoot: path.join(appRoot, '.arcane', 'native-build', 'openvino'),
    env,
    signal,
    onEvent
});

const helper = await buildWhisperHelper({
    runtime: nativeRuntime,
    outputRoot: path.join(appRoot, '.arcane', 'native-build', 'helper'),
    env,
    signal,
    onEvent
});

await cp(path.join(helper.root, 'bin'), nativeRuntime.libraryDirectory, {
    recursive: true
});
```

The variables for source directories, build environment, cancellation and
diagnostics belong to the producer. Both functions also accept `cmake`,
`generator` and `cmakeArgs` for that existing build environment.

The runtime producer returns `root`, `directory`, `libraryDirectory`,
`sourceDirectory`, selected `backends` and complete build `diagnostics`. Its
output keeps the copied source and build directory separate from the runtime
tree. It applies the encoder return-value propagation and exception-to-stderr
corrections in that copied source. The helper build uses the matching headers
and runtime and installs its required release compiler-runtime libraries;
copying its complete installed `bin` directory places them with the optional
runtime. Use `nativeRuntime.root` as the custom variant root and retain its
packaging notices.

This producer path builds a native distribution. Applications using the
precompiled asset follow the preparation and bundling paths above.
