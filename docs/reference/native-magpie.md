# Native Magpie speech

`arcane-os/local-ai/magpie` exports `createMagpieRuntime` as a named and default export. It retains the selected Magpie model and NanoCodec decoder in one owned native process. It produces complete encoded audio or ordered PCM callbacks; the caller owns playback. Existing Kokoro, browser speech, and complete-audio APIs remain separate capabilities.

## Prepare and select the runtime

Supply a prepared native executable and the external NeMo shared-library directory:

```js
import {createMagpieRuntime} from 'arcane-os/local-ai/magpie';

const speech = createMagpieRuntime({
    runtime: {helperExecutable, libraryDirectory},
    paths: {
        model: magpieModel,
        codec: nanoCodecModel,
        tokenizerDirectory
    },
    executionTarget: {backend: 'cuda', cudaVisibleDevices: selectedCudaUuid},
    voice: 'Aria',
    languageCode: 'en-US'
});
await speech.load();
```

The paths identify an already selected Magpie GGUF, matching tokenizer assets, and matching NanoCodec decoder. Nothing is downloaded or copied by this factory. `executionTarget.backend` must explicitly select `cuda` or `cpu`. For CUDA, the native device owner supplies its selected visible device or UUID through `cudaVisibleDevices`; the child receives that process-local environment before loading CUDA. The adapter does not invent a GPU ordinal, select another device, or fall back to another provider.

Instead of `runtime`, supply `prepare({signal})`, returning the prepared descriptor directly: `{helperExecutable, libraryDirectory, ...}`. Preparation runs when loading needs the executable, alongside model metadata preparation. It must return the descriptor, not a `{runtime}` wrapper. Without `libraryDirectory`, the executable's directory is used.

Applications using model-assets ownership may replace `paths` with `modelAssets`, `assetProjectionId`, and `resourcePaths: {model, codec, tokenizerConfig}`. The resource paths identify members of the retained projection; the tokenizer directory is derived from the selected configuration member. The projection stays retained until its native helper closes.

Other factory options are `modelId` (default `magpie`), a lifetime `signal`, and `onEvent` for the existing process/event diagnostics. Factory defaults are voice `Aria` and language `en-US`; both are exposed by `current()`.

## State and lifecycle

- `current()` returns provider/model identity, `state`, `loaded`, `busy`, active `requestId`, `queuedRequests`, `defaultVoice`, `languageCode`, model-owned `voices`, configured execution information, `sampleRate`, progress, and a serialized error. Its speech catalog is `{streaming: true, responseFormats: ['wav', 'pcm'], defaultResponseFormat: 'wav'}`. Configured execution is not evidence of actual GPU inference.
- `subscribe(listener, {replay: true, signal})` observes lifecycle state and replays the current state by default; it returns an unsubscribe function.
- `load({paths, assetProjectionId, resourcePaths, executionTarget, modelId, signal})` loads or replaces the selected resources. Reusing the same selection reuses its loaded engine. The optional signal cancels that caller's load wait; the factory lifetime signal owns engine cancellation. Load the engine before requesting speech.
- `unload()` cancels owned work, joins native and callback cleanup, releases retained assets, and leaves the factory reusable.
- `close()` joins unloading and disposes the factory. Repeated close calls share completion.

Requests accepted by one engine are processed in order. Unloading or replacing that engine cancels its owned work; it does not cancel another engine or audio owner.

## Exact requests, voices, and languages

Both synthesis methods accept the same request:

```js
const request = {
    input: 'The moon is closed for dragon maintenance.',
    voice: 'Aria',
    languageCode: 'en-US'
};
```

`input` is passed unchanged: no trimming, sentence splitting, prompt injection, tempo stage, or output cap. A NUL or an unpaired surrogate cannot be represented by the native UTF-8 C-string interface and produces an explicit incompatibility error.

Optional `model` must match the configured `modelId`. `voice` defaults to the factory selection and is resolved case-insensitively against the matching tokenizer's `model_config.yaml` speaker-map reference and its model-owned JSON IDs. Embedded GGUF voice labels are not used as the selection map.

`languageCode` (or `language_code`) is separate per-request control information; it never changes the authored input. Omission uses the configured language. The application/model owns language selection. Installed tokenizer support determines whether a language can run; a language listed in configuration is not proof of runtime support. Native errors are returned rather than switching languages or engines. The public native ABI supplies the natural speaking rate only; an optional `speed` must be `1`.

## Complete audio and streaming audio

`synthesize(request, {signal, requestId, onProgress})` resolves with complete `audioBase64`, `contentType`, `format`, `sampleFormat: 's16le'`, sample rate, channel count, model, voice, language code, speed, and request ID. Set `request.responseFormat` to `wav` (default) or `pcm`. WAV uses the external RIFF framing; when a complete result cannot fit that format, select PCM or streaming instead of truncating it.

`synthesizeStream(request, {signal, requestId, onProgress, onAudio})` requires `onAudio` and awaits each callback in original order:

```js
const controller = new AbortController();
const completion = speech.synthesizeStream(request, {
    signal: controller.signal,
    requestId: 'dragon-announcement',
    async onAudio({pcm, format, sampleRate, channels, requestId}) {
        await audioOutput.write({pcm, format, sampleRate, channels, requestId});
    }
});
const result = await completion;
```

`pcm` is a Node `Buffer` of signed 16-bit little-endian interleaved PCM; the current native engine returns mono audio. The callback includes `format: 's16le'`, `sampleRate`, `channels`, and `requestId`. Awaited callback delivery applies backpressure to the native helper. The streaming terminal result contains metadata and `complete: true`, without accumulating or returning the audio again. Browser/Core transport and playback have their own delivery and cleanup owners.

`onProgress` receives synthesis progress. Callback failures cancel the matching utterance and remain observable. A caller-supplied `requestId` identifies its active or queued request; otherwise the runtime creates one.

## Cancellation and callback ownership

`await speech.stop({requestId})` stops only that active or queued utterance and joins native completion and callback cleanup. It returns `{requestId, stopped: true}`, or `stopped: false` when the ID is no longer owned. Cancellation of an active native call is observed at a PCM callback boundary: this ABI has no asynchronous pre-first-PCM interrupt. Model creation can be cancelled by retiring its owned process.

An output callback must return before joining its own stop, unload, close, or selection replacement. Those self-joining calls reject with `MAGPIE_CALLBACK_WAIT`; their return types do not change inside callbacks. To cancel from `onAudio` or `onProgress`, synchronously call the caller-owned `controller.abort()` and return. The external owner then awaits the synthesis completion and cleanup. Likewise, do not await a new queued synthesis from a callback that the current synthesis is awaiting.

The synthesis promise rejects on cancellation or failure. Native errors, callback failures, and cleanup failures remain observable; combined failures are preserved in aggregates. Complete audio is never reported for an interrupted request.

## Build the first-party helper

`arcane-os/local-ai/magpie/build` exports named/default `buildMagpieHelper({runtime, outputRoot, signal, onEvent})`. The selected upstream installation supplies `runtime.cmakeDirectory`, containing `NeMoSpeechConfig.cmake`, its public TTS headers, and its platform-matching libraries. Build prerequisites are CMake 3.26 or newer, a C++17 compiler, platform threads support, and that prepared NeMo TTS installation.

The builder configures, builds, and installs the SDK's `arcane-magpie` executable under `outputRoot`. It returns `{platform, architecture, root, helperExecutable, diagnostics: {configure, compile, install}}`. Combine its executable with the selected upstream `libraryDirectory` for the runtime descriptor. The SDK does not vendor NeMo libraries, models, tokenizer assets, or voices.

The source targets Windows, Linux, and macOS; Android requires its host adaptation and compatible upstream runtime. On October 17, 2026, the selected Windows x64 helper configured, compiled, and installed successfully against installed NeMo-Speech.cpp 0.2.0 using CMake 4.4.3, Visual Studio 2022, MSVC 19.44.35217, and Windows SDK 10.0.26100. Each operation exited 0, with complete diagnostics retained in the SDK's ignored selected-output directory. The helper was not launched: model inference, microphone capture, and audio playback remain unexecuted for this adapter. Linux and macOS compilation and execution remain unverified. Build success, actual selected-device inference, and audible playback are separate evidence boundaries.
