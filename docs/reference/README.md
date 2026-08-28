# Arcane OS SDK developer reference

This reference answers developer questions in this order:

1. **What can the application or tool do?**
2. **What should I import or call?**
3. **What does a successful result look like?**
4. **Where does it run?**
5. **Only when needed: which transport, host, provider, or kernel boundary implements it?**

The default path is capability-first. Transport and implementation detail is
kept in the [protocol and host architecture guide](protocols.md), and every
high-level page links to the relevant deep section instead of repeating it.

## Reference map

| Need | Start here |
| --- | --- |
| Use the Node.js package API | [SDK JavaScript API](sdk-api.md) |
| Publish central events, capture bounded time-travel history, or observe the DOM | [EventManager and event-stack reference](event-manager.md) |
| Use the `arcane` command | [CLI reference](cli.md) |
| Generate named browser imports or inspect the authenticated physical runtime | [`arcane import-map`](cli.md#arcane-import-map) and [browser runtime delivery](protocols.md#browser-runtime-delivery) |
| Choose browser, native, cloud, or cross-host behavior | [Availability and normalization](availability-and-normalization.md) |
| Import a shipped renderer module | [Runtime module catalog](runtime-modules.md) |
| Use a shared entity | [Runtime entity modules](runtime-entities.md) and [exact export contracts](core/arcane-entities.md) |
| Load a reusable HTML component | [Runtime component catalog](runtime-components.md) |
| Call `globalThis.Arcane` | [Arcane Core API](core/arcane-api.md) |
| Subscribe to native events | [Arcane event reference](core/arcane-events.md) |
| Use provider-neutral AI lifecycle, chat, speech, persistence, or document context | [Normalized AI](#normalized-ai) |
| Run a caller-authenticated local LLM in the browser | [Browser-WASM local AI](ai/browser-wasm.md) |
| Run caller-authenticated Whisper or Kokoro in the browser | [Browser speech providers](ai/browser-speech.md) |
| Use Arcane Ollama | [Arcane Ollama guide](arcane-ollama.md) |
| Understand transports and protocol switching | [Protocol and host architecture](protocols.md) |
| Run contract and behavior tests | [Behavioral testing](behavioral-testing.md) |

## Version scope and provenance

This repository contains explicitly versioned surfaces with different owners:

| Surface | Source identity | Meaning |
| --- | --- | --- |
| SDK and CLI | `arcane-os` `0.3.0` | The Node.js toolchain plus the browser-only `arcane-os/ai/browser-wasm`, `arcane-os/ai/browser-speech`, and portable `arcane-os/mail` entrypoints in this checkout. |
| Browser runtime | `runtime/ARCANE_RUNTIME_RELEASE.json`, SDK `0.3.0`, protocol `arcane/1` | The SDK-canonical dynamic runtime inventory shipped under `runtime/`; the receipt binds its exact paths, bytes, inventory, and digest. |
| Browser SDK runtime | `browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json`, SDK `0.3.0` | The dynamically derived browser closure for events, Wllama, and Browser Speech mechanisms. It contains no speech runtime, model, voice, third-party legal/notice, or corresponding-source payloads. |
| Core reference snapshot | Arcane OS commit `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, protocol `arcane/1` | The application-facing Core contract derived into `docs/reference/core/`. Canonical inventory and focused-member content was verified unchanged at Arcane OS `main` commit `13f3ce0ae34f77a3495331c8b4c30b1bb105f8ed`; SDK-local provenance, link, and package-boundary annotations are added explicitly. |

The SDK runtime receipt and Core reference are distinct evidence and have
different current authorities. A browser module's bytes come from the SDK
runtime receipt. A native build selects one
explicit Arcane OS checkout and Core. This SDK version accepts that selection
only after its current native plan checks the exact declared protocol, version,
features, capabilities, methods, provider contract, and identity-bound
receipts. That current-build admission does not promise that a future SDK will
accept this Core or that this SDK will accept a future Core. A matching protocol
name or higher version alone is not compatibility or authority.

See [Core reference provenance](core/README.md) for the imported inventory and
the exact distinction between a documentation snapshot and shipped runtime
bytes.

## Published 0.2.3

The most recently verified published package before this 0.3.0 source candidate
is exactly `arcane-os@0.2.3` from source commit
`d717f21d45664d20e4ed6377596db87c47492e11`. The npm `latest` dist-tag resolves
to `0.2.3`; the separate `dev` dist-tag remains `0.1.0-dev.5`.

The singleton-event, Mail, warn-first Browser Speech, and mixed-route contracts
documented below are newer canonical source. They are not package authority in
`0.2.3`; consumers require the numeric 0.3.0 publication before relying on them.

| Evidence | Exact value |
| --- | --- |
| npm integrity | `sha512-TZewkGM7dh9PdVnOtnkBO7QalJ6qyWWdKruCmsTxoHyeoG5XpqVbkNgiJhtBLhrIzgUV3vydYplxZQkIbIWoHg==` |
| npm shasum | `8e978a23289a41db130253e6475a0c8bb0c0d73f` |
| Immutable release tarball | `arcane-os-0.2.3.tgz`; 6,999,078 bytes; SHA-256 `857f179c2f9d4549e7691b4e6cebc49e5ab5e18600816443b26319c61fc1f85d` |
| GitHub release | [`0.2.3`](https://github.com/TheWizardNexus/arcane-os-sdk/releases/tag/0.2.3) (tag and title are both exactly `0.2.3`) |
| Hosted source/artifact gate | [Check run 33052271534](https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/33052271534) |
| Trusted publication | [Run 33052383457](https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/33052383457) |

The npm SLSA provenance binds the published package to that exact source commit
and `.github/workflows/publish-dev.yml`. Hashes prove byte identity or
consistency; provenance establishes the recorded source/workflow relationship.
Neither claim alone proves browser hardware support, native admission, or a
particular application's provider/model policy.

## MDN-style page contract

Public reference entries follow the established Arcane documentation model:

- one canonical, mechanically readable inventory owns each public name;
- every public member or module has one guide entry headed by its exact name;
- each guide leads with an overview and the shortest safe working example;
- parameters, return values, errors, side effects, cancellation, and events are
  stated when they apply;
- availability is summarized near the call, while transport mechanics are
  folded into or deep-linked from the entry;
- normalized results are distinguished from provider- or platform-native
  envelopes;
- examples do not trigger destructive, privileged, expensive, or external
  actions merely by being copied.

## Public runtime inventory

The package exposes 200 semantic JavaScript records across 14 JavaScript
entrypoints, plus eight JSON Schemas, its exact runtime manifest, and package
metadata. Ten entrypoints are Node.js control-plane surfaces,
`arcane-os/event-manager` and `arcane-os/mail` run in Node and browsers, and
`arcane-os/ai/browser-wasm` plus `arcane-os/ai/browser-speech` are browser-only.
The [machine-readable package
inventory](inventory/package-api.json) and [SDK member reference](sdk-api.md)
are checked bidirectionally against every declared JavaScript export.

The seven update-check records are explicit on-demand checks; they do not poll,
download, install, or self-update.

The synchronized browser payload exposes:

- 84 JavaScript module artifacts under `runtime/arcane/modules/`, including
  ESM modules, classic vendor globals, one worker protocol, and one Node-oriented
  mail transport;
- 15 shared entity modules under `runtime/arcane/entities/`;
- 39 reusable HTML-import components under `runtime/arcane/components/`;
- seven shared CSS artifacts, security policy, images, and the vendored
  `strong-type` dependency.

The module and component catalogs enumerate every shipped artifact, including
vendor support files that are not ESM imports. The runtime manifest remains the
byte-level source of truth; the catalogs explain what those bytes let a
developer do.

## Normalized AI

Portable applications start with the provider-neutral runtime rather than an
Ollama, Wllama, Whisper, Kokoro, native, or cloud transport:

| Need | Public surface | Availability |
| --- | --- | --- |
| Select, load, unload, inspect, cancel, and use LLM/STT/TTS independently | [`AIProviderRuntime.js`](runtime-modules.md#aiproviderruntimejs) | Cross-host controller; each registered provider declares its own host requirements. |
| Observe sticky role state and startup settlement | [`AIRuntimeState.js`](runtime-modules.md#airuntimestatejs) | Cross-host EventTarget state; observation grants no authority. |
| Offer explicit selected-model start/cancel UI | [`chat.html`](runtime-components.md#chathtml), [`speech.html`](runtime-components.md#speechhtml), and [`voice-transcription.html`](runtime-components.md#voice-transcriptionhtml) | Browser/native WebView components; user activation emits a cancelable request before any LLM or STT load intent, and recording stays disabled without sticky ready STT. |
| Use Core-normalized chat | [`globalThis.Arcane.ai`](core/arcane-ai-contracts.md) | Native/Core only when separately admitted. |
| Run a caller-selected GGUF LLM locally | [`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) | Browser secure context with WebGPU/full-offload evidence, WebAssembly, and OPFS/DBOPFS. |
| Run caller-selected Whisper/Kokoro locally | [`arcane-os/ai/browser-speech`](ai/browser-speech.md) | Browser with DBOPFS, Web Locks, Workers, and caller-supplied immutable runtime/model bytes. |
| Add bounded persistent history and memory | [`PersistentAIChatSession.js`](runtime-modules.md#persistentaichatsessionjs) | Browser/native WebView runtime with ChatEntity/DBOPFS and a configured chat function. |
| Add explicit document search/context | [`DBOPFSDocumentLibrary.js`](runtime-modules.md#dbopfsdocumentlibraryjs) | Existing DBOPFS-style adapter; search occurs only after the app calls it or deliberately wires its context builder into chat. |

There is no automatic local-to-cloud, browser-to-Core, provider-to-provider, or
storage fallback. Tool calls remain structural data until application-owned
policy and code decide whether to execute them. App prompts, model defaults,
profiles, tools, business policy, and private data remain app-owned.

An explicitly selected but unloaded model is not “ready.” `chat.html` keeps
Send disabled and exposes a visible keyboard-operable LLM Start/Try again or
Cancel loading control. `speech.html` and `voice-transcription.html` keep their
recording operations unavailable and share the equivalent Start
transcription/Try again/Cancel loading control for STT. Applications can
override `requestAIActivation(intent)` or `requestSTTActivation(intent)`, or
cancel the corresponding activation-request event. Imports and state
observation emit no lifecycle intent, and default
`startTranscription=false` does not request an STT startup load or begin an
automatic model download. It does not unload a role started independently.
Compatibility availability never creates ready STT/TTS state without an
admitted, loaded provider. Shared STT cancel/destroy propagates an owned signal,
and TTS Mute/Unmute updates the shared lifecycle owner. The selected TTS
provider/model catalog owns its default voice; a saved OpenAI voice is not
forwarded to another provider route.

## Authority and feature detection

The presence of a JavaScript function is not permission to use it. Native
applications should inspect `Arcane.capabilities.list()` where available and
then call the relevant status method. Android callers with `system.read` obtain
the nested capability snapshot through `Arcane.platform.status()`.

Do not infer local-AI readiness from `Arcane.runtime.current().managedLocalAI`,
infer authorization from a transport name, or treat an Ollama model inventory
as package admission. Each method rechecks native policy at invocation time.

## Source, receipts, and licensing

- [Exact SDK runtime release manifest](../../runtime/ARCANE_RUNTIME_RELEASE.json)
- [SDK runtime authority record](../../tools/runtime-source.json)
- [Exact browser AI runtime receipt](../../browser-runtime/ARCANE_SDK_BROWSER_RELEASE.json)
- [AGPL license](../../LICENSE)
- [Commercial-license notice](../../COMMERCIAL-LICENSE.md)
- [Third-party and distribution notice](../../NOTICE)
