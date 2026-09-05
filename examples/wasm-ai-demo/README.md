# Arcane SDK WASM voice chat

This is a source example inside the canonical Arcane SDK repository. It consumes this checkout's live `/src`, `/browser-runtime`, and `/runtime` trees. It contains no copied SDK modules, generated runtime projection, Ollama integration, or separate local AI service.

For the smallest first request, start with the [browser speech quick start](../../docs/reference/ai/browser-speech.md) or [TWiN Cloud quick start](../../docs/reference/ai/twin-cloud.md). This example adds the shared Chat/Speech components, local LLM selection, persistence, and retrieval to those public APIs.

## Speech defaults and inspection

The demo deliberately omits `tts.execution` in `speechConfiguration(dbopfs)` so it consumes the SDK default `{device:'auto',maxConcurrentRequests:4}`. Change that application's TTS record to `execution:{device:'wasm',maxConcurrentRequests:1}` to use less memory, or choose `webgpu` explicitly. Allowed capacities are 1 through 4; Whisper and the LLM retain capacity one.

The maintained Kokoro selection uses `fp32` because [Kokoro.js recommends `fp32` when using WebGPU](https://github.com/hexgrad/kokoro/tree/main/kokoro.js#usage). Automatic fallback keeps the same dtype on WASM. `selectedDevice` identifies the loaded route; it does not validate speech correctness or audio quality, so evaluate actual output for each browser and device combination your application supports.

Capacity 4 means up to four segments synthesize at once. Segment 5 and later wait in the SDK's FIFO queue; they are not dropped. Synthesis may finish out of order, but playback waits for earlier segments and plays exact input order. Each slot owns a Worker/model session, so raising capacity trades memory for latency.

Use the shared Speech component to load/unmute speech, then select **Inspect speech execution** below Chat. The button reads `ai.providerRuntime.status('tts',{execution:true}).execution` and displays requested device, selected device, capacity, active requests, and automatic WASM fallback. It is a snapshot at the moment clicked. `selectedDevice:null` means no pool is selected; `webgpu` reports the upstream execution-provider selection and does not prove physical GPU kernel overlap or audio quality. Auto may fall back to WASM with the same selected model/dtype; explicit WebGPU reports an error when it cannot load.

Shared Speech still owns mute, stop, and voice controls. The example's status button inspects the public report without loading a model or reaching into private providers.

## Ownership

The Arcane SDK owns the shared behavior:

- `<html-import>` mounts `/runtime/arcane/components/chat.html`.
- Chat owns transcript rendering, persistence, submission state, cancellation, activation progress, and its composer.
- Chat renders AI messages on the left and user messages on the right.
- The nested SDK Speech component owns Talk, Stop, voice selection, mute state, and speech status.
- `AI`, the browser-WASM provider, and DBOPFS own model loading and model persistence.
- `ModelDefinition` owns loading and parsing the complete profile Modelfile prompt.
- Chat creates and binds the SDK's `PersistentAIChatSession`, which owns local conversation persistence.
- `DBOPFSDocumentLibrary` owns the profile-specific local document corpus, lexical retrieval, and complete request-context construction.
- `PreferenceStore` owns model and profile selection persistence.
- `startSourceExampleServer` owns live-source mounts, complete file streaming, model Range transport, TLS, and the browser-WASM isolation headers.

The example owns its branded outer shell, model/profile catalog, General, PreCrisis, and BOSS prompt policy, maintained BOSS demo catalog, local-document controls, and profile-specific tool declarations. Its BOSS retrieval policy wraps the complete context returned by `DBOPFSDocumentLibrary.buildContext()`; it does not serialize document records itself. SDK Chat displays structural tool calls; the example records them through Chat's public tool-result method with the explicit `not-executed` disposition so the persisted conversation can continue without pretending an action ran. Every declared tool requires a nonempty user-facing `message`, matching the browser-WASM provider contract.

Chat uses `PersistentAIChatSession`'s SDK-owned streaming seam, which composes live AI deltas with cancellation and one durable persisted turn. SDK Chat also owns the structural tool-call records and their visible disposition.

## Local model assets

Model weights are deliberately excluded from Git. Place the maintained GGUF shards in `examples/wasm-ai-demo/models/`, or set `ARCANE_WASM_MODEL_ROOT` to an existing local model directory before starting the server.

The maintained model descriptors include each shard's known byte length as progress metadata. During a cold install, the SDK reports aggregate loaded and remaining bytes, transfer speed, estimated time, and active file or Range transfers while Chat presents the existing activation progress bar. Completed shards and completed Range parts within a shard remain available after interruption, so retry downloads only missing work.

The app gives the SDK browser-speech owner the existing Whisper tiny.en FP32 and Kokoro 82M FP32 descriptors. The app does not import those runtimes or create a speech worker itself.

## Local retrieval

BOSS seeds the example's maintained document catalog through the SDK's `DBOPFSDocumentLibrary`. The Local knowledge control accepts user-selected text documents and merges them into the selected profile's SDK-owned document corpus. Retrieval remains isolated by profile, and every matching document is supplied in full to the current request.

General uses the selected model's local-browser identity prompt. PreCrisis loads `profiles/PreCrisis.Modelfile`; BOSS loads `profiles/BOSS.Modelfile` and the maintained `rag/boss-library.json` catalog. Those are consumer-owned inputs to the SDK rather than alternate Chat, persistence, speech, or model implementations.

## Run from this checkout

From the canonical SDK repository root:

    node .\examples\wasm-ai-demo\server.mjs

The npm package includes this same maintained source. From an application with
the exact SDK installed, run:

    node ./node_modules/arcane-os/examples/wasm-ai-demo/server.mjs

For the installed copy, set `ARCANE_WASM_MODEL_ROOT` to your existing model
directory; do not store model downloads inside `node_modules`. The installed
server resolves `/src`, `/browser-runtime`, and `/runtime` inside its selected
SDK package. It does not require an SDK or Arcane OS source checkout.

Use this repository-root command rather than a generic Live Server extension. A server rooted at the example directory cannot expose the SDK checkout's live source routes.

Then open:

    http://localhost:4173/examples/wasm-ai-demo/

The example's thin server entry imports `startSourceExampleServer` from the SDK's public `arcane-os` root export and supplies only its paths and assets; the SDK owns serving the current checkout's direct `/src`, `/browser-runtime`, and `/runtime` paths. Open the exact URL it prints at startup. HTTP is the default; when local certificate files are present in `examples/wasm-ai-demo/tls/`, the printed URL uses HTTPS instead. To reuse an existing local certificate directory without copying it into Git, set `ARCANE_WASM_TLS_ROOT` before starting the server.

For example, a local launch can point at preserved prototype assets without making them source authority:

    $env:ARCANE_WASM_MODEL_ROOT = "C:\path\to\existing\models"
    $env:ARCANE_WASM_TLS_ROOT = "C:\path\to\existing\tls"
    node .\examples\wasm-ai-demo\server.mjs

Model weights, browser profiles, caches, generated evidence, runtime reproductions, and TLS private keys remain outside the maintained example. The preserved standalone prototype is not edited or used as runtime authority.
