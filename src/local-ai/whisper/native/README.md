# Persistent Whisper helper

This first-party executable links the public C API from the selected upstream
whisper.cpp runtime. The current integration selects whisper.cpp 1.9.4/b5130.
The matching upstream headers and complete runtime remain in their installed
locations; they are not copied into SDK source. CMake builds only this helper.

`buildWhisperHelper` in `../build.mjs` takes the runtime's `directory`, matching
upstream `sourceDirectory`, and a task-owned `outputRoot`. Optional `cmake`,
`generator`, `cmakeArgs`, and `env` select an already available host toolchain.
Its `signal` and `onEvent` use the SDK process owner. The result names the
helper executable and retains complete configure, build, and installation
diagnostics. On Windows, when the upstream distribution omits import libraries,
the selected MSVC `dumpbin` and `lib` generate ordinary import libraries from
the actual DLL exports. This does not rebuild Whisper, ggml, or CUDA.
The Windows MSVC installation also uses CMake's
`InstallRequiredSystemLibraries` module to place the selected release CRT and
OpenMP redistributables beside the helper in `bin/`. Debug runtimes, MFC, and
Windows Universal CRT files are excluded; Windows 10/11 supplies the latter.
An explicit `-DMSVC_REDIST_DIR=...` in `cmakeArgs` can select the permitted
installed compiler redistributable tree for that build.

Windows uses the selected runtime directory in the child process's `PATH`.
Linux and macOS use their normal library loader configuration for that runtime.
The helper source uses standard C++17, with Windows binary standard-stream
mode as its only host-specific source adaptation. Android needs its native host
to provide the executable, upstream runtime, decoder, and process integration.
Availability of this source does not establish execution on another platform.

## Launch and commands

Launch with these arguments:

```text
arcane-whisper --model-base64 MODEL_PATH --runtime-base64 RUNTIME_PATH --backend gpu --threads 4
```

Both path arguments are the base64 encoding of the complete UTF-8 path. The
backend is `gpu` or `cpu`. The optional thread argument selects native inference
threads; its default is the host's reported hardware concurrency, or one when
the host does not report it. The parent keeps runtime library resolution and
the backend directory aligned with the same selected runtime tree.

Each stdin command ends with one LF. The displayed `TAB` means an actual tab:

```text
transcribe TAB REQUEST_ID TAB PCM_PATH_BASE64 TAB LANGUAGE_BASE64 TAB TRANSLATE
cancel TAB REQUEST_ID
shutdown
```

Request identifiers are parent-generated control identifiers. Paths and
languages use lossless base64 framing; `TRANSLATE` is `0` or `1`. The language
is a Whisper language name/code, `auto`, or empty for detection. The PCM file is
the complete decoded recording in mono 16 kHz f32le format. The decoder owns
that required representation; the helper adds no trimming, voice-activity
filter, duration restriction, offset, or audio normalization. The original
recording remains with the request owner. The native `whisper_full` signed-int
sample argument is an upstream representational limit; a recording it cannot
represent produces an explicit error without silently shortening the input.

## Events and ownership

Stdout contains complete JSON records, one per LF, each explicitly flushed.
Native diagnostics remain complete on stderr.

| `type` | Fields and meaning |
| --- | --- |
| `loading` | `model`, `requestedBackend`; the retained context is being initialized. |
| `ready` | `model`, `requestedBackend`, `observedBackend`, `backendEvidence`; model initialization and state allocation returned successfully. |
| `accepted` | `requestId`; this request owns the retained context. |
| `progress` | `requestId`, `progress`; the actual upstream percentage callback, not an elapsed-time prediction. |
| `segment` | `requestId`, `index`, `text`, `start`, `end`; an actual newly produced native segment, in original callback order. |
| `complete` | `requestId`, `language`, `duration`, `text`, `segments`; the full native result after the inference worker joined. |
| `cancelled` | `requestId`; the cancellation was observed and the actual inference worker joined. |
| `error` | `requestId`, `message`; an actual operation failure. Startup failures use an empty request identifier. `code: "WHISPER_INFERENCE_FAILED"` identifies only a nonzero return from `whisper_full` after cancellation has been excluded. |
| `stopped` | The command reader joined and the retained context was freed. Process exit remains the parent's lifetime boundary. |

Segment start/end and recording duration are in seconds. Text preserves native
segment whitespace. Complete text concatenates the native segments in order,
with no trimming, inserted separators, or rewritten model output. No segment is
fabricated from tokens or inferred progress. The helper uses upstream greedy
decoding defaults with independent request context, zero offset, and the full
decoded duration.

The public C API has no context-backend getter. `observedBackend` therefore
reports the backend identified by completed native initialization logs, with
`backendEvidence: "runtime-log"`; it is null if those logs provided no usable
observation. It does not promise that every operation runs on a GPU. GPU
failure and CPU runtime selection belong to the parent runtime owner.

One active inference uses the retained context. A separate command reader can
set its cancellation flag while computation runs. Both the native encoder and
compute abort callbacks observe that flag. Native work drains before the main
dispatcher joins the inference worker and emits a terminal event. Upstream may
finish an already running GPU operation before observing cancellation.
Callbacks produced before native cancellation finishes remain complete events;
the parent owns whether a cancelled operation may affect its visible result.

`shutdown` and stdin EOF cancel active inference, join it and the command
reader, and free the model. Model loading has no public upstream cancellation
callback, so the parent cancels loading by terminating and joining its exact
helper process. A different selected model likewise belongs to a new retained
helper lifetime after the previous owner drains.
