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

## Start with one working request

Install the SDK in your application:

```sh
npm install --save-exact arcane-os@0.5.12
```

For your first AI call, follow the [TWiN Cloud quick start](ai/twin-cloud.md).
For on-device speech, follow the [browser speech quick start](ai/browser-speech.md)
and the complete [browser AI demo](https://github.com/TheWizardNexus/arcane-os-sdk/tree/main/examples/wasm-ai-demo).
Each guide names the application configuration you supply and shows the public
call, response, cancellation, and error handling. Browser module imports use
the SDK's [materialized import map](cli.md#arcane-import-map); installing npm
alone does not make bare module names resolve in a browser.

## Reference map

| Need | Start here |
| --- | --- |
| Use the Node.js package API | [SDK JavaScript API](sdk-api.md) |
| Publish central events, capture complete time-travel history, or observe the DOM | [EventManager and event-stack reference](event-manager.md) |
| Use the `arcane` command | [CLI reference](cli.md) |
| Generate named browser imports or inspect the selected physical runtime | [`arcane import-map`](cli.md#arcane-import-map) and [browser runtime delivery](protocols.md#browser-runtime-delivery) |
| Choose browser, native, cloud, or cross-host behavior | [Availability and normalization](availability-and-normalization.md) |
| Import a shipped renderer module | [Runtime module catalog](runtime-modules.md) |
| Use a shared entity | [Runtime entity modules](runtime-entities.md) and [exact export contracts](core/arcane-entities.md) |
| Load a reusable HTML component | [Runtime component catalog](runtime-components.md) |
| Call `globalThis.Arcane` | [Arcane Core API](core/arcane-api.md) |
| Subscribe to native events | [Arcane event reference](core/arcane-events.md) |
| Use provider-neutral AI lifecycle, chat, speech, persistence, or document context | [Normalized AI](#normalized-ai) |
| Run a caller-selected local LLM in the browser | [Browser-WASM local AI](ai/browser-wasm.md) |
| Run caller-selected Whisper or Kokoro in the browser | [Browser speech providers](ai/browser-speech.md) |
| Send one TWiN Cloud request or migrate saved LLM preferences | [TWiN Cloud quick start](ai/twin-cloud.md) |
| Use Arcane Ollama | [Arcane Ollama guide](arcane-ollama.md) |
| Understand transports and protocol switching | [Protocol and host architecture](protocols.md) |
| Run contract and behavior tests | [Behavioral testing](behavioral-testing.md) |

## Version scope and source ownership

This repository contains explicitly versioned surfaces with different owners:

| Surface | Source identity | Meaning |
| --- | --- | --- |
| SDK and CLI | `arcane-os` `0.5.12` | The Node.js toolchain, portable `arcane-os/event-manager`, `arcane-os/mail`, `arcane-os/preference-store`, and `arcane-os/speech-playback` entrypoints, plus the browser-only `arcane-os/ai/browser-wasm` and `arcane-os/ai/browser-speech` entrypoints in this checkout. |
| Browser runtime | SDK `0.5.12`, protocol `arcane/1`, `runtime/` | The SDK-canonical runtime tree. `listRuntimeFiles()`, `readRuntimeFile()`, and `loadRuntimeRelease()` derive its current inventory directly from the selected directory. |
| Browser SDK runtime | SDK `0.5.12`, `browser-runtime/` | The browser closure for events, Wllama, and Browser Speech mechanisms. `listSdkBrowserRuntimeFiles()`, `readSdkBrowserRuntimeFile()`, and `loadSdkBrowserRuntimeRelease()` derive its current inventory directly from the selected directory. |
| Core reference snapshot | Arcane OS commit `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, protocol `arcane/1` | The application-facing Core contract imported into `docs/reference/core/`, with SDK-local links and package-boundary notes added explicitly. |

The SDK runtime source and Core reference have different owners. A browser
module comes from the selected SDK runtime tree. A native build selects one
explicit Arcane OS checkout and Core, then checks the declared protocol,
version, features, capabilities, methods, and provider contract needed by that
build. A matching protocol name or higher version alone does not promise
functional compatibility.

See the [Core reference source notes](core/README.md) for the imported inventory
and the distinction between a documentation snapshot and the selected runtime.

## Installed documentation and release identity

This reference accompanies `arcane-os@0.5.12`. The installed package includes
the maintained `docs/` tree and `examples/wasm-ai-demo/` source alongside
README and CHANGELOG. Open `node_modules/arcane-os/docs/reference/README.md`
for the matching local reference. The generated website and test suites remain
repository surfaces.

Read the installed version and current registry channel separately:

```sh
npm list arcane-os
npm view arcane-os@latest version
```

The [changelog](../../CHANGELOG.md) records changes by version; the
[GitHub releases](https://github.com/TheWizardNexus/arcane-os-sdk/releases)
identify the corresponding published package source. A newer website does not
change the version installed in your application.

### Historical 0.3.4 publication record

The following records describe that earlier release only. They do not identify
the current registry channel or the package covered by this reference.

| Release boundary | Exact value |
| --- | --- |
| npm package | `arcane-os@0.3.4` |
| Package source | `9e657b31f758a2c7943446533fe87afda206ac49` |
| GitHub release | [`0.3.4`](https://github.com/TheWizardNexus/arcane-os-sdk/releases/tag/0.3.4) (tag and title are both exactly `0.3.4`) |
| Selected package run | [Check run 33268940871](https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/33268940871) |
| Selected publication run | [Publish run 33268987444](https://github.com/TheWizardNexus/arcane-os-sdk/actions/runs/33268987444) |

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

The package exposes 204 semantic JavaScript records across 16 JavaScript
entrypoints, plus eight JSON Schemas and package metadata. Ten entrypoints are
Node.js control-plane surfaces,
`arcane-os/event-manager`, `arcane-os/mail`, `arcane-os/preference-store`, and
`arcane-os/speech-playback` run in Node and browsers, and
`arcane-os/ai/browser-wasm` plus `arcane-os/ai/browser-speech` are browser-only.
The [machine-readable package
inventory](inventory/package-api.json) and [SDK member reference](sdk-api.md)
are checked bidirectionally against every declared JavaScript export.

The seven update-check records are explicit on-demand checks; they do not poll,
download, install, or self-update.

The synchronized browser payload exposes:

- 82 JavaScript module artifacts under `runtime/arcane/modules/`, including
  ESM modules, classic vendor globals, one worker protocol, and one Node-oriented
  mail transport;
- 14 shared entity modules under `runtime/arcane/entities/`;
- 39 reusable HTML-import components under `runtime/arcane/components/`;
- seven shared CSS artifacts, images, optional physical-workspace security
  files where present, and the vendored `strong-type` dependency.

The module and component catalogs enumerate every shipped artifact, including
vendor support files that are not ESM imports. The selected runtime directories
and their current source inventories remain authoritative; the catalogs explain
what those artifacts let a developer do.

## Normalized AI

Portable applications start with the provider-neutral runtime rather than an
Ollama, Wllama, Whisper, Kokoro, native, or cloud transport:

| Need | Public surface | Availability |
| --- | --- | --- |
| Select, load, unload, inspect, cancel, and use LLM/STT/TTS independently | [`AIProviderRuntime.js`](runtime-modules.md#aiproviderruntimejs) | Cross-host controller; each registered provider declares its own host requirements. |
| Observe sticky role state and startup settlement | [`AIRuntimeState.js`](runtime-modules.md#airuntimestatejs) | Cross-host EventTarget state; observation grants no authority. |
| Offer explicit selected-model start/cancel UI | [`chat.html`](runtime-components.md#chathtml), [`speech.html`](runtime-components.md#speechhtml), and [`voice-transcription.html`](runtime-components.md#voice-transcriptionhtml) | Browser/native WebView components; user activation emits a cancelable request before any LLM or STT load intent, and recording stays disabled without sticky ready STT. |
| Use Core-normalized chat | [`globalThis.Arcane.ai`](core/arcane-ai-contracts.md) | Native/Core only when separately admitted. |
| Run a caller-selected GGUF LLM locally | [`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) | Browser secure context with WebGPU full-offload availability, WebAssembly, and OPFS/DBOPFS. |
| Run caller-selected Whisper/Kokoro locally | [`arcane-os/ai/browser-speech`](ai/browser-speech.md) | Browser with DBOPFS, Web Locks, Workers, and caller-supplied runtime and model sources; Kokoro supports bounded Worker/session concurrency with automatic WebGPU-first execution and complete WASM-pool fallback. |
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
Reported availability never creates ready STT/TTS state without an
admitted, loaded provider. Shared STT cancel/destroy propagates an owned signal,
and TTS Mute/Unmute updates the shared lifecycle owner. The selected local TTS
provider/model catalog owns its default voice; a saved OpenAI-route voice is not
forwarded to Core or browser speech.

## Authority and feature detection

The presence of a JavaScript function is not permission to use it. Native
applications should inspect `Arcane.capabilities.list()` where available and
then call the relevant status method. Android callers with `system.read` obtain
the nested capability snapshot through `Arcane.platform.status()`.

Do not infer local-AI readiness from `Arcane.runtime.current().managedLocalAI`,
infer authorization from a transport name, or treat an Ollama model inventory
as package admission. Each method rechecks native policy at invocation time.

## Source and licensing

- [SDK runtime source](../../runtime/arcane)
- [AGPL license](../../LICENSE)
- [Commercial-license notice](../../COMMERCIAL-LICENSE.md)
- [Third-party and distribution notice](../../NOTICE)
