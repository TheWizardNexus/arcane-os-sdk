# Arcane SDK WASM voice chat

This is a source example inside the canonical Arcane SDK repository. It consumes this checkout's live `/src`, `/browser-runtime`, and `/runtime` trees. It contains no copied SDK modules, generated runtime projection, Ollama integration, or separate local AI service.

## Ownership

The Arcane SDK owns the shared behavior:

- `<html-import>` mounts `/runtime/arcane/components/chat.html`.
- Chat owns transcript rendering, persistence, submission state, cancellation, activation progress, and its composer.
- Chat renders AI messages on the left and user messages on the right.
- The nested SDK Speech component owns Talk, Stop, voice selection, mute state, and speech status.
- `AI`, the browser-WASM provider, and DBOPFS own model loading and model persistence.
- `PersistentAIChatSession` owns local conversation persistence.
- `DBOPFSDocumentLibrary` owns the profile-specific local document corpus and lexical retrieval.
- `PreferenceStore` owns model and profile selection persistence.

The example owns its branded outer shell, model/profile catalog, General, PreCrisis, and BOSS prompt policy, maintained BOSS demo catalog, local-document controls, and profile-specific tool declarations. SDK Chat displays structural tool calls; the example records them through Chat's public tool-result method with the explicit `not-executed` disposition so the persisted conversation can continue without pretending an action ran. Every declared tool requires a nonempty user-facing `message`, matching the browser-WASM provider contract.

Chat uses `PersistentAIChatSession`'s SDK-owned streaming seam, which composes live AI deltas with cancellation and one durable persisted turn. SDK Chat also owns the structural tool-call records and their visible disposition.

## Local model assets

Model weights are deliberately excluded from Git. Place the maintained GGUF shards in `examples/wasm-ai-demo/models/`, or set `ARCANE_WASM_MODEL_ROOT` to an existing local model directory before starting the server.

The app gives the SDK browser-speech owner the existing Whisper tiny.en FP32 and Kokoro 82M Q8 descriptors. The app does not import those runtimes or create a speech worker itself.

## Local retrieval

BOSS seeds the example's maintained document catalog through the SDK's `DBOPFSDocumentLibrary`. The Local knowledge control accepts user-selected text documents and merges them into the selected profile's SDK-owned document corpus. Retrieval remains isolated by profile, and every matching document is supplied in full to the current request.

General uses the selected model's local-browser identity prompt. PreCrisis loads `profiles/PreCrisis.Modelfile`; BOSS loads `profiles/BOSS.Modelfile` and the maintained `rag/boss-library.json` catalog. Those are consumer-owned inputs to the SDK rather than alternate Chat, persistence, speech, or model implementations.

## Run from this checkout

From the canonical SDK repository root:

    node .\examples\wasm-ai-demo\server.mjs

Then open:

    http://localhost:4173/examples/wasm-ai-demo/

The example server uses only Node's built-in modules and serves the current checkout's direct `/src`, `/browser-runtime`, and `/runtime` paths. It prints the exact URL at startup. HTTP is the default; when local certificate files are present in `examples/wasm-ai-demo/tls/`, the URL uses HTTPS instead. To reuse an existing local certificate directory without copying it into Git, set `ARCANE_WASM_TLS_ROOT` before starting the server.

For example, a local launch can point at preserved prototype assets without making them source authority:

    $env:ARCANE_WASM_MODEL_ROOT = "C:\path\to\existing\models"
    $env:ARCANE_WASM_TLS_ROOT = "C:\path\to\existing\tls"
    node .\examples\wasm-ai-demo\server.mjs

Model weights, browser profiles, caches, generated evidence, runtime reproductions, and TLS private keys remain outside the maintained example. The preserved standalone prototype is not edited or used as runtime authority.
