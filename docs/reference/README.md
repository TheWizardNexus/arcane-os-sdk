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
npm pkg set dependencies.arcane-os=latest
npm install
```

The development declaration tracks the current `latest` channel. The lockfile
and installed package record the exact version actually selected for the
workspace.

For your first AI call, follow the [TWiN Cloud quick start](ai/twin-cloud.md).
For local models, native browser voices or cloud speech, follow the [browser speech guide](ai/browser-speech.md)
and the complete [browser AI demo](https://github.com/TheWizardNexus/arcane-os-sdk/tree/main/examples/wasm-ai-demo).
Each guide names the application configuration you supply and shows the public
call, response, cancellation, and error handling. Browser module imports use
the SDK's [managed import map](cli.md#arcane-import-map); installing npm
alone does not make bare module names resolve in a browser.

## Reference map

| Need | Start here |
| --- | --- |
| Use the Node.js package API | [SDK JavaScript API](sdk-api.md) |
| Publish central events, capture complete time-travel history, or observe the DOM | [EventManager and event-stack reference](event-manager.md) |
| Inspect complete AI and speech calls using the shared developer-mode preference | [Shared logger](sdk-api.md#arcanelogging) and [speech developer diagnostics](ai/browser-speech.md#developer-diagnostics) |
| Use the `arcane` command | [CLI reference](cli.md) |
| Install an app and cache selected resources offline | [Progressive web applications](pwa.md) |
| Disable source PWA generation or explicitly retire confirmed generated output | [Source PWA retirement](pwa.md#disable-source-pwa-generation-and-retire-generated-output) |
| Retire the prior worker after explicitly disabling standalone source PWA | [Disabled-worker browser lifecycle](pwa.md#disabled-worker-retirement-on-the-source-server) |
| Retire a disabled worker through an existing custom source host | [Public PWA retirement response](pwa.md#retirement-through-an-existing-custom-host) |
| Generate named browser imports or inspect the selected physical runtime | [`arcane import-map`](cli.md#arcane-import-map) and [browser runtime delivery](protocols.md#browser-runtime-delivery) |
| Connect an application through the shared WebSocket transport | [Shared WebSocket clients](websocket-client.md) |
| Choose browser, native, cloud, or cross-host behavior | [Availability and normalization](availability-and-normalization.md) |
| Import a shipped renderer module | [Runtime module catalog](runtime-modules.md) |
| Use a shared entity | [Runtime entity modules](runtime-entities.md) and [exact export contracts](core/arcane-entities.md) |
| Load a reusable HTML component | [Runtime component catalog](runtime-components.md) |
| Present Light / Dark / System choices with complete labels | [Theme-switcher configuration](runtime-components.md#theme-switcherhtml) |
| Choose theme-switcher corner radii, label font and group background through host CSS | [Theme-switcher styling properties](runtime-components.md#theme-switcherhtml) |
| Use optional Core preferences and appearance without masking real failures | [PreferenceStore](runtime-modules.md#preferencestorejs), [SystemAppearance](runtime-modules.md#systemappearancejs), and [Core lookup errors](core-runtime.md#state-and-frames) |
| Submit complete speech parts immediately and play them in order | [`SpeechPlayback`](runtime-modules.md#speechplaybackjs) and the [basic browser example](ai/browser-speech.md#play-a-complete-array-with-speechplayback) |
| Preserve exact speech text and complete browser Kokoro audio | [Exact complete synthesis input](ai/browser-speech.md#exact-complete-synthesis-input) and [managed AI narration](sdk-api.md#managed-ai-narration) |
| Select initial native window dimensions and resizing behavior | [Initial native window size](core-native-packaging.md#initial-native-window-size) and [Windows provider](sdk-api.md#createwindowsnativeprovider) |
| Call `globalThis.Arcane` | [Arcane Core API](core/arcane-api.md) |
| Connect a browser to one Core transport | [Core browser client](core-client.md) |
| Cancel one Core speech synthesis request without changing its payload | [Speech request lifetime](core-client.md#events-and-request-lifetime) and [Core facade](sdk-api.md#createcorefacade) |
| Compose native Core dispatch, service lifecycle, and stdio hosting | [Native Core runtime](core-runtime.md) |
| Reuse dependency-ready native services without a renderer | [Core service composition](core-runtime.md#native-service-composition) and [existing ONNX owner](local-ai.md#native-service-owners) |
| Compose application Core services during source development, independently of local AI | [Development Core services](core-development.md) |
| Share one application service runtime between its ordinary native launch and MCP process | [Shared Core host](core-shared-host.md) and [native launch defaults](core-native-packaging.md#launch-time-locations) |
| Store complete browser model resources, including the selected decision-runtime entry, through one DBOPFS owner | [Model resources](ai/browser-decisions.md#shared-dbopfs-model-resources) and [speech routing](ai/browser-speech.md#ordinary-module-routing) |
| Observe committed storage changes across live application documents | [DBOPFS change subscriptions](runtime-modules.md#dbopfsjs) |
| Cancel cold speech preparation while preserving other activation interests | [Prepared narration](ai/browser-speech.md#prepare-narration-once-and-replay-stored-audio) |
| Own an explicitly selected native Codex App Server session | [Codex App Server](codex-app-server.md) |
| Expose application-owned tools and static resources through Node STDIO | [MCP STDIO server](mcp-stdio.md) |
| Run application-selected llama.cpp, Ollama or ONNX through Core | [Local AI through Core](local-ai.md) |
| Generate complete local PNG images with a retained native model | [Local image generation](local-image-generation.md) |
| Select FLUX.2 Klein 4B and its three complementary model resources | [FLUX.2 Klein 4B through Core](local-image-flux.md) |
| Select the complete SDXL Base 1.0 checkpoint for text-to-image generation | [SDXL Base 1.0 through Core](local-image-sdxl.md) |
| Compose independently loaded transcription and synthesis engines | [Native speech service](native-speech.md) |
| Keep a native Whisper model loaded across complete recordings | [Native Whisper transcription](local-whisper.md) |
| Select the optional Intel NPU encoder with independent CUDA or CPU decoding | [Intel NPU Whisper](../guides/native-whisper-openvino.md) |
| Edit an original PNG with a complete prompt and explicit strength | [Local image editing](local-image-editing.md) |
| Project complete stored model files into native working files | [Model assets through Core](model-assets.md) |
| Prepare selected upstream model members in native services | [Native preparation and retained lifetime](model-assets.md#native-ownership) |
| Retain a Nemotron model and diarize caller-fed audio streams | [Native speaker diarization](diarization.md) |
| Persist application-selected preferences through Core | [Core preferences service](core-preferences.md) |
| Read complete selected Git text without changing a checkout | [Git text snapshots](git-text-snapshot.md) |
| Own a native working checkout under per-user ArcaneData/Repos, with optional Windows long paths for new clones | [Native repository workspaces](core-repositories.md) and [Windows clone configuration](core-repositories.md#windows-long-paths-for-a-new-checkout) |
| Read Git identity defaults or select child-only author and credential hints | [Git identity configuration](core-repositories.md#git-identity-configuration) |
| Write, commit and push complete selected repository text | [Selected-text repository writing](core-repositories.md#write-commit-and-push-selected-text) |
| Observe existing checkout configuration and capture an explicit remote/ref | [Repository configuration and selected targets](core-repositories.md#existing-checkout-configuration-and-selected-targets) |
| Build an installed-SDK portable Core payload | [Portable Core packaging](core-native-packaging.md) |
| Resolve matching native state/workspace/endpoint defaults and preserve explicit launch values | [Launch-time locations](core-native-packaging.md#launch-time-locations) and [resolveNativeLaunchContext()](sdk-api.md#resolvenativelaunchcontext) |
| Build a Windows executable without an OS checkout | [Windows executable packaging](core-native-packaging.md#windows-executable) |
| Compose a Mac application with an architecture-matched host | [macOS application composition](core-native-packaging.md#macos-application-composition) |
| Subscribe to native events | [Arcane event reference](core/arcane-events.md) |
| Use provider-neutral AI lifecycle, chat, speech, persistence, or document context | [Normalized AI](#normalized-ai) |
| Choose a normalized typed browser decision surface | [Browser typed decisions](ai/browser-decisions.md) |
| Score complete typed options with native Laya FP32 | [Native typed decisions](native-decisions.md) |
| Run a caller-selected local LLM in the browser | [Browser-WASM local AI](ai/browser-wasm.md) |
| Run caller-selected Whisper/Kokoro, native browser recognition/voices or cloud TTS | [Browser speech providers](ai/browser-speech.md) |
| Send TWiN chat, System One state/questions or image requests | [TWiN Cloud guide](ai/twin-cloud.md) |
| Edit live transcription before Send, or print a complete conversation | [Chat component](runtime-components.md#chathtml) |
| Store images outside Markdown and hydrate them in previews | [MarkdownMedia](runtime-modules.md#markdownmediajs) |
| Print complete rendered documents, previews and conversations | [PrintView](runtime-modules.md#printviewjs) |
| Use Arcane Ollama | [Arcane Ollama guide](arcane-ollama.md) |
| Understand transports and protocol switching | [Protocol and host architecture](protocols.md) |
| Run contract and behavior tests | [Behavioral testing](behavioral-testing.md) |

## Version scope and source ownership

This repository contains explicitly versioned surfaces with different owners:

| Surface | Source identity | Meaning |
| --- | --- | --- |
| SDK and CLI | `arcane-os`; version in [`package.json`](../../package.json) | The Node.js toolchain and focused public entrypoints listed in the [SDK API](sdk-api.md). Each entrypoint retains its own runtime requirements. |
| Browser runtime | Selected SDK, protocol `arcane/1`, `runtime/` | The SDK-canonical runtime tree. `listRuntimeFiles()`, `readRuntimeFile()`, and `loadRuntimeRelease()` derive its current inventory directly from the selected directory. |
| Browser SDK runtime | Selected SDK, `browser-runtime/` | Events, logging, Wllama, local/native/cloud speech, TWiN requests and PWA mechanisms. `listSdkBrowserRuntimeFiles()`, `readSdkBrowserRuntimeFile()`, and `loadSdkBrowserRuntimeRelease()` derive its current inventory directly from the selected directory. |
| Core reference snapshot | Arcane OS commit `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, protocol `arcane/1` | The application-facing Core contract imported into `docs/reference/core/`, with SDK-local links and package-boundary notes added explicitly. |

Browser modules and reusable Core client/runtime/lifecycle source belong to the
SDK. The portable provider uses this installed package by default and assembles
an app payload with explicitly selected services; portable itself supplies no
executable host. The Windows provider pairs that payload with the installed
SDK version's precompiled WebView2/SEA release asset. Explicit Arcane OS provider
overrides and integrated shared checks remain available. Arcane OS retains its
product composition and policy.
The historical Core reference snapshot describes a separate host contract;
matching a protocol name or assembling a payload alone does not establish that
a composed host supplies every required method or service.

See the [Core reference source notes](core/README.md) for the imported inventory
and the distinction between a documentation snapshot and the selected runtime.

## Installed documentation and release identity

The repository reference follows the current committed SDK capabilities. A
documentation-only repository update can be newer than the text bundled in an
already published package. The installed package includes
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

### Generate the selected reference site

The existing `node tools/build-reference-site.mjs --write` command reads the
live checkout. For release documentation while disjoint source work continues,
select the reviewed documentation commit explicitly:

```sh
node tools/build-reference-site.mjs --write --source-ref <documentation-commit>
```

The same option is accepted by `createReferenceSite({sourceRef})` and
`writeReferenceSite({sourceRef})`. It reads the selected commit's package
version, complete reference documents and inventories, the canonical
`docs/guides/native-whisper-openvino.md` guide when present, inventory-selected
runtime sources, and authored site inputs directly from Git in memory. It
creates no checkout or export and leaves source drafts untouched. Rendering
uses the current canonical generator and its authored semantic contracts;
select a documentation commit whose contracts match the published package.
Generated output still belongs to the canonical `site/` tree and requires its
usual coordinated output ownership. Generation does not publish hosted Pages.

For a selected release whose documentation correction lands after unrelated
source, `createReferenceSite({inputs})` and `writeReferenceSite({inputs})` accept
one explicit input owner with `readText(relativePath)` and
`listFiles(relativeDirectory)`. It is shared with the contract extractor. Keep
package/runtime reads and document discovery on the release commit, and overlay
only reviewed documentation records from the correction commit. In particular,
preserve the selected inventory's member set instead of importing later public
APIs. Omitted `inputs` preserves the live or `sourceRef` behavior above.

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

The public export map is maintained in [`package.json`](../../package.json).
It includes Node tooling, focused portable/browser entrypoints, direct runtime
module and entity patterns, eight JSON Schemas and package metadata. The
[SDK member reference](sdk-api.md) and [package inventory](inventory/package-api.json)
describe focused functions; the runtime catalogs document the existing
namespaces exposed through lowercase aliases and filename-based imports.
Resolving a package name in Node does not supply browser, media, storage or
Core capabilities. See the [availability matrix](availability-and-normalization.md).

The seven update-check records are explicit on-demand checks; they do not poll,
download, install, or self-update.

The synchronized browser payload exposes:

- JavaScript modules under `runtime/arcane/modules/`, including
  ESM modules, classic vendor globals, one worker protocol, and one Node-oriented
  mail transport;
- shared entity modules under `runtime/arcane/entities/`;
- reusable HTML-import components under `runtime/arcane/components/`;
- shared CSS artifacts, images, optional physical-workspace security
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
| Run a caller-selected GGUF LLM locally | [`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) | Browser secure context with WebAssembly and OPFS/DBOPFS; explicit CPU selection or WebGPU with full offload and no automatic CPU fallback. |
| Run application-selected native llama.cpp/Ollama chat | [`arcane-os/ai/core-local`, `arcane-os/core/local-ai`](local-ai.md) | Explicit Core connection and selected native runtimes; installation, availability and loaded-model readiness remain distinct. |
| Transcribe complete recordings with a retained native Whisper model | [`arcane-os/local-ai/whisper`](local-whisper.md) and [Core speech](native-speech.md) | Matching native helper, Whisper libraries, decoder and selected model; Windows defaults and explicit other-platform distributions have distinct preparation requirements. |
| Run a local ONNX graph with named tensors | [`arcane-os/local-ai/onnx`, `arcane-os/ai/core-onnx`](local-ai.md#native-onnx-sessions) | Retained native workers; browser access requires an available Core ONNX service. |
| Score typed options without a renderer | [`arcane-os/local-ai/decisions`, `arcane-os/core/decisions`](native-decisions.md) | Explicit native Laya FP32 activation using the existing ONNX owner; complete scores and outputs, joined Worker cleanup. |
| Generate local images from complete prompts and selected model resources | [`arcane-os/local-ai/image`, `arcane-os/ai/core-image`](local-image-generation.md) | Prepared native image runtime; browser access requires its Core service. CPU Windows/Linux and Mac Metal/CPU paths have distinct actual host requirements. |
| Supply complete stored model members to a native engine | [`arcane-os/ai/core-model-assets`, `arcane-os/core/model-assets`](model-assets.md) | Available Core service; DBOPFS originals stay authoritative while native owners retain working files. |
| Run caller-selected Whisper/Kokoro locally | [`arcane-os/ai/browser-speech`](ai/browser-speech.md) | Browser with DBOPFS, Web Locks, Workers and selected upstream sources; automatic WebNN NPU, WebGPU, then WASM loading, or an explicit backend. |
| Use native browser recognition/voices or selected cloud TTS | [Speech provider choices](ai/browser-speech.md) | Native APIs depend on the browser and may use remote services; cloud TTS requires the application key and endpoint access. |
| Send complete chat, System One or image requests without retained history | [`arcane-os/ai/twin-cloud`](ai/twin-cloud.md) | Node or browser with Fetch and explicit model/credentials; image results contain every returned image as a Blob. |
| Add persistent history and memory | [`PersistentAIChatSession.js`](runtime-modules.md#persistentaichatsessionjs) | Browser/native WebView runtime with ChatEntity/DBOPFS and a configured chat function; `persist:false` ends retention when the operation settles. |
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
