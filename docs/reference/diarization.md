# Nemotron 3 speaker diarization

The native diarization API uses the NVIDIA `Nemotron-3-Diarization.q8_0.gguf`
model through the official NeMo-Speech.cpp 0.2.0 CPU libraries. It returns
generic, one-based speaker labels and timed segments, independently of speech
recognition. A speaker label does not identify a person. The model supports
eight speaker channels; the helper reports the loaded model's actual channel
count and output cadence.

## Runtime and helper

Select the `nemo-speech` runtime through the existing local-AI installer. Keep
its complete upstream `bin`/`lib`/`include` and CMake layout. Model storage is
separate and caller-selected. Obtain the selected GGUF from the
[official NVIDIA model repository](https://huggingface.co/nvidia/Nemotron-3-Diarization).
This API does not select an ASR model, install Python, or enable a GPU backend.

`buildDiarizationHelper({runtime,outputRoot,signal,onEvent})` builds the
first-party helper for the current host with installed CMake and its C++17
toolchain. `runtime.cmakeDirectory` is the installer-discovered CMake package
directory, passed as `NeMoSpeech_DIR` without assuming an archive root. The result
is `{platform,architecture,root,executable,diagnostics}`; diagnostics retain the
complete configure/compile/install process results. The installed helper is under
`outputRoot/bin`; its build directory is under `outputRoot/build`. The helper
links the upstream `NeMoSpeech::Diarization` component and is separate from
the downloaded runtime. No compiler is downloaded by this function.

Official 0.2.0 CPU archives cover Windows x64, Linux x64/ARM64, and macOS
x64/ARM64. Linux requires glibc 2.31 or later. Android needs a host-adapted
runtime/helper; this release's official inventory does not supply an Android
or Windows ARM64 archive. Source portability is distinct from execution on an
actual platform.

The public Node flow uses the existing installer and one first-party helper:

```javascript
import {ensureLocalAIRuntimes} from 'arcane-os/local-ai';
import {buildDiarizationHelper} from 'arcane-os/diarization/build';
import {createDiarization} from 'arcane-os/diarization';

const [runtime] = await ensureLocalAIRuntimes({
    runtimes: [{id: 'nemo-speech', version: '0.2.0'}],
    directory: selectedRuntimeDirectory
});
const helper = await buildDiarizationHelper({runtime, outputRoot: selectedHelperDirectory});
```

Keep the selected directories and model path under their application/host
owner. A native artifact can place the first-party executable under
`runtime/diarization/bin`, independently of the complete upstream library tree
under `runtime/local-ai/nemo-speech`.

## Retained model and audio streams

`createDiarization({executable,modelPath,runtime,onEvent})` returns immediately
and starts its owned helper. Supply absolute helper/model paths and the
installer's absolute `runtime.binaryDirectory`/`runtime.libraryDirectory` paths. They configure the
child's platform library search path; the parent environment is unchanged.

The returned model has `ready`, `completion`, `current()`,
`subscribe(listener,{emitCurrent=true,signal})`, `openStream(options)`,
`diarize(options)`, and `close()`. `ready` resolves when the actual model is
loaded; a failed load rejects. `completion` covers the complete helper lifetime.
The sticky state is `loading`, `ready`, `closing`, `closed`, or `error`.
Subscribe to this owner instead of polling or delaying unrelated UI startup.

```javascript
const diarization = createDiarization({
    executable: helper.executable,
    modelPath: selectedModelPath,
    runtime
});

const stream = await diarization.openStream({
    sampleRate: 16000,
    onUpdate: function showSpeakers(result) {
        renderSpeakerTimeline(result.segments);
    }
});

await stream.push(firstMonoSamples);
await stream.push(nextMonoSamples);
const final = await stream.finish();
await diarization.close();
```

`push(audio)` accepts mono `Float32Array` samples and preserves their float32
representation. The caller owns decoding an encoded recording and choosing
its mono channel; this API does not alter the source recording, mix channels,
normalize amplitudes, or capture a microphone. Keep the supplied array stable
until `push` settles. Each stream accepts one fixed sample rate: 8000–96000 Hz,
or `0` for model-rate samples. The default is 16000 Hz. Upstream owns necessary
resampling. Await each push for backpressure; independent streams share the
retained model without sharing speaker/session state. Upstream serializes
model compute internally.

`openStream({sampleRate,onUpdate,onProbabilities,signal})` returns a stream with
`push`, `finish`, `cancel`, `completion`, and `current()`. A push resolves to
its latest segment snapshot, or `null` until native frames are available. `finish()`
flushes all remaining audio and resampler output, returns the complete final
result, and releases the native stream. It is idempotent. `current()` retains
only the latest successful snapshot. Results have:

```text
{final, speakers, secondsPerFrame, frameCount,
 segments:[{speaker,startTime,endTime}, ...]}
```

Times are seconds from the start of that caller's stream. Intermediate segment
snapshots may revise earlier segment boundaries. Replace the displayed
snapshot; do not append whole snapshots as new segments. Final results include
all upstream segments, including those finalized before upstream probability
compaction. The API adds no diarization thresholds or segment filtering.

For recorded mono samples, `await diarization.diarize({audio,sampleRate,signal,
onUpdate,onProbabilities})` uses the same complete streaming path, then finishes
and closes that stream. It does not use upstream's length-constrained stateless
offline operation.

## Probabilities, callbacks, and cancellation

Supply `onProbabilities` to receive every available probability frame as
`{startFrame,values,speakers,secondsPerFrame}`. Values are frame-major, with one
value per speaker channel per frame. Frame indices are absolute within the
stream. The adapter reads between 160 ms input pushes, before upstream's old
probability buffer can be compacted. It reports an error if an upstream gap is
ever observed; it does not manufacture missing values. Without this callback,
the helper does not request raw probabilities.

Callbacks are awaited and their failures propagate. The caller owns retaining
probability history, audio, and any earlier snapshots it needs. The SDK does
not accumulate a second transcript of continuous protocol output. `onEvent`
receives ordinary process lifecycle events and complete stderr diagnostics;
raw stdout protocol belongs to the result callbacks instead. Keep engineering
diagnostics in a selected developer surface, outside ordinary UI/chat history.

`cancel(reason)` and the stream's abort signal stop subsequent pushes and
suppress later result commits for that stream. Cancellation closes the stream
after native commands already ahead of its close have returned; the C ABI
does not offer an immediate interrupt. Other streams keep their own state.
An already-running caller callback finishes under its caller's ownership.
`cancel()` can be awaited inside a callback. Await the same stream's `push()`,
`finish()`, or model `close()`
only after the callback returns; a recursive wait reports
`DIARIZATION_CALLBACK_WAIT` instead of deadlocking. Stream `completion`
retains finish/cancellation cleanup failures.

`close()` stops new streams, drains in-flight openings and accepted stream work,
finishes the remaining streams, closes helper stdin, and waits for native
cleanup/process exit. The model always outlives its streams. Complete failures
from an operation and its cleanup remain available together.

## Core service

Import the named or default factory from `arcane-os/core/diarization`.

`createDiarizationService({executable,modelPath,runtime,onEvent},launchContext)`
is a synchronous `native.services` factory. Relative executable/model paths
resolve against explicit `launchContext.workspaceRoot`, otherwise the native
launcher's `appRoot` (or the current directory for standalone factories). Model loading is lazy at the
first diarization operation, not a prerequisite for Core startup. The returned
service implements `drain()` and `dispose()` and the following methods:

| Method | Input / result |
| --- | --- |
| `diarization.status` | Current model lifecycle snapshot. |
| `diarization.load` | Load the configured model; return readiness. |
| `diarization.open` | `{sampleRate,probabilities}` → `{streamId,sampleRate}`. |
| `diarization.push` | `{streamId,audio}` → current timed segment snapshot. |
| `diarization.finish` | `{streamId}` → complete final result, releasing the stream. |
| `diarization.cancel` | `{streamId}` → cleanup completion for that stream. |
| `diarization.recording` | `{audio,sampleRate}` → complete final result. |

Core audio is `{encoding:'f32le',data:BASE64}`: transport encoding of the exact
little-endian float32 samples, with control metadata outside the audio. The
service emits `diarization.state`, `diarization.update` with `{streamId,result}`,
and optional `diarization.probabilities` with the stream ID and frame data.
Subscribe before opening a stream. Session operations have service lifetime;
renderer request cancellation does not discard accepted audio. Call the
explicit cancel method for a session. A recording operation has request
lifetime and its cancellation closes only that recording's stream.

## Shared process transport

The existing internal `runProcess` owner accepts scalar input as before and
also an `AsyncIterable<string|Uint8Array>`. Iteration is backpressured by the
child's stdin writes; iterable completion sends EOF, including in `close-input`
mode. Cancellation/early child exit calls the iterator's `return()` and waits
for input cleanup. The producer must make a pending `next()` settle when it is
returned/cancelled. The diarization-owned producer does this explicitly.

`onOutput({stream,chunk})` receives complete decoded UTF-8 chunks with original
delimiters and is awaited per stream. It is not a binary stdout interface.
`captureOutput` and `emitOutputEvents` default to `true`; each also accepts
`{stdout,stderr}` overrides. Disabling capture requires an output consumer and
returns `null` for that process-result field; it does not return a shortened
transcript. Disabling output events leaves those events absent. Existing
scalar input, full text results and ordinary event defaults remain unchanged.
Failed output callbacks retain their complete input chunk and cause in the
process error, including when successful output is caller-owned.

## Upstream contracts

The implementation follows the [stable C ABI](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/include/nemo_speech/diar.h),
[SDK linkage guide](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.2.0/docs/sdk.md),
and [official 0.2.0 release](https://github.com/NVIDIA/NeMo-Speech.cpp/releases/tag/v0.2.0).
