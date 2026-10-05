# Availability and normalization

Use this page to choose an API by capability. The compact labels tell you where
it runs; the [protocol guide](protocols.md) contains the implementation detail.

## Shared type predicates

SDK-owned JavaScript uses the declared `strong-type` dependency for type
predicates. Node and managed renderer modules import `Is` from `strong-type`;
browser providers and workers use their shipped relative dependency path.
Component scripts import it within their own asynchronous component scope.
Publication bootstrap tools import the shipped runtime dependency by relative
path so they remain available before npm dependency installation.
The dependency pin and both shipped projections use 2.0.1. Update them together
through the published dependency workflow when another version is needed.

Reuse one non-throwing instance per module or component:

```javascript
import Is from 'strong-type';

const is=new Is(false);

function requireText(value){
    if(!is.string(value))throw new TypeError('Text is required.');
    return value;
}
```

The predicates classify values without coercing them. Existing API owners keep
their defaults, domain constraints, complete payloads, and public error behavior.
Use `number` for primitive numbers, `finite` for finite numbers, and `integer`
or `safeInteger` for the corresponding integer contract. `object` includes null;
retain a contract's separate null and array handling. `plainObject` is narrower
than a general non-array object check and must not silently reject previously
accepted class instances.

Constructor identity checks, diagnostic type labels, foreign-language source,
and isolated generated script bodies retain native operators where a replacement
would change their contract or execution scope. `DBOPFSWorker.js` and
`SystemPlatformPresentation.js` retain their few native predicates to preserve
classic-script loading and synchronous availability. Upstream dependency source is
consumed unchanged. Non-throwing strong-type array and constructor probes return
false when a probe throws; SDK branching continues through its owning error path.

## Availability labels

| Label | Meaning |
| --- | --- |
| **Node** | Runs in the SDK's supported Node.js process. It is not a renderer API. |
| **Browser** | Uses standard browser APIs and can run without a native host when its own dependencies are available. |
| **Native** | Requires an admitted `globalThis.Arcane` host method or a native target provider. |
| **Cloud** | Calls a remote provider over HTTPS and needs provider configuration and network policy. |
| **Cross-host** | Keeps one application contract usable across supported hosts. Execution may stay in-process, use a registered provider, or cross a documented Arcane WebView2, WebKitGTK, Android WebView, or development HTTP transport. |
| **Provider-native** | Intentionally returns the underlying provider's complete envelope instead of an Arcane-normalized entity. |

“Available” never means “authorized.” App grants, method allowlists, host
policy, package-owned model policy, platform support, and dependency readiness
are independent checks.

Windows x64 has an SDK-owned precompiled WebView2/SEA host; Linux and Android
retain their explicit checkout providers where listed. The SDK also includes
macOS Foundation process-adapter source, separately from an executable target,
renderer bridge, artifact or run command. A composed macOS host may combine that
source with the reusable Node Core runtime, stdio transport and portable payload.
Source availability does not establish macOS compilation or execution.

## Capability-first matrix

| What the developer wants to do | Preferred surface | Availability | Normalization |
| --- | --- | --- | --- |
| Scaffold, inspect, test, package, bundle, build, verify, or run an app | `arcane` CLI or `arcane-os` package functions | **Node**; native targets invoke one explicit provider | CLI events and SDK errors/results are normalized by versioned SDK contracts. Tests and checks run only when explicitly selected; verification is separate and selected-output-specific. |
| Publish application events or review a complete event history | `arcane-os/event-manager` | **Node** and **Browser**; optional DOM capture needs a browser DOM or compatible host | Live listeners receive original arguments. Ordinary `secure:false` recording preserves complete URLs, public details, and captured stack text in deeply frozen `arcane-event-stack/1` snapshots while credential-named fields remain redacted. The stack format is local diagnostic data, not a host transport. |
| Share one native WebSocket by exact URI and ordered protocols | `arcane-os/websocket-client` | **Node** and **Browser**, using the host's native `WebSocket` | The selected upstream `ws-share` instance owns the connection pool and global observation. Native socket messages and events remain unchanged; there is no reconnect, heartbeat, application envelope, storage, or fallback. |
| Build browser UI and app-local behavior | `/arcane/modules/*.js`, shared entities, and components | **Browser**; many modules also run inside every native renderer | Pure modules own their result contracts. Modules that call `Arcane` inherit the bridge boundary described below. |
| Score caller-supplied typed options with Laya or Julia | `arcane-os/ai/browser-decisions` | **Browser** only; caller-selected upstream runtime/model and backend | Typed decisions retain complete rows and return typed values, scores, probabilities, and diagnostics in caller order. This surface is separate from chat and speech and does not silently change model, precision, backend, or family. |
| Select and observe independent LLM/STT/TTS roles | `/arcane/modules/AIProviderRuntime.js` and `AIRuntimeState.js` | **Cross-host** controller/state; registered providers retain their own host requirements | Required/projected provider members, route/configuration records, and status fields; per-role lifecycle, cancellation, stream cleanup, sticky state, and startup barriers are normalized. `localOnly` creates no fallback. |
| Run a caller-selected local LLM entirely in a browser renderer | `arcane-os/ai/browser-wasm` through `createArcaneAI()` | **Browser** only; secure context, WebAssembly, and OPFS/DBOPFS; full WebGPU offload by default or explicit CPU with `gpuLayers:0` | The public AI API module normalizes multi-model lifecycle, status, complete all-choice streaming, cancellation, exact ordered structural tool-call visibility, and session persistence. Model sources are canonical ordered file descriptors; licenses and model choice remain application policy. |
| Run caller-selected Whisper or Kokoro in a browser renderer | `arcane-os/ai/browser-speech` registered with `AIProviderRuntime` | **Browser** only; DBOPFS, Web Locks, Workers, Fetch/object URLs, and a caller-supplied self-contained runtime/model closure are required | Independent provider/2 lifecycle and status, with `auto`, `webnn-npu`, `webgpu`, or `wasm` execution. Whisper owns one Worker/session; Kokoro defaults to four and accepts one through four. Complete model/runtime selection, offline behavior, cancellation, Worker teardown, and request/result shapes are normalized. No runtime/model content or cloud fallback is supplied. |
| Capture speech with the explicitly selected native browser service | `createBrowserSpeechRecognitionProvider` from `arcane-os/ai/browser-speech`, configured as STT | **Browser / native WebView**, conditional on `SpeechRecognition` or `webkitSpeechRecognition`; no SDK model, Worker, or storage required | `localOnly:false` because the browser may use a remote service. Factory/catalog remain usable without native support; inspect/load report availability. User-gesture start, exact final results, transient interim text, stop/drain and abort are owned by the provider/runtime and shared controls. No provider fallback. |
| Speak with the explicitly selected browser voice service | `createBrowserSpeechSynthesisProvider` from `arcane-os/ai/browser-speech`, configured as TTS | **Browser / native WebView**, conditional on `speechSynthesis` and `SpeechSynthesisUtterance` | `localOnly:false`; actual voice metadata and a replaying catalog subscription, synchronous `setDefaultVoice(voiceURI\|null)`, silent preparation, and explicit playback controls. Native completion and resource release are distinct. Native speech provides playback descriptors; exporting audio requires a provider that returns real audio. |
| Prepare ordered speech playback or reuse the speech-input formatting filter | `arcane-os/speech-playback`, `AI.prepareTTSPlayback`, and `arcane-os/speech-text` | **Node** with injected media adapters, or **Browser / native WebView** media; the text filter itself is **Cross-host** | Stored and caller-owned text stays exact. Only the outbound synthesis copy loses repeated same formatting marks. Complete Blob segments or inert native descriptors keep their original order. Provider capacity owns synthesis admission; actual native release controls when the playback lane is free. |
| Compose editable speech drafts and print a conversation | Shared [`chat.html`](runtime-components.md#chathtml) | **Browser / native WebView** with the selected AI/speech runtime | `transcriptionMode='draft'` places confirmed and interim recognition in the editable composer for manual Send. `appendDraft(text)` preserves existing text and selection. `print()` requests the complete rendered conversation with optional `printTitle`; a successful return confirms the dialog request only. |
| Preserve complete chat history and memory | `/arcane/modules/PersistentAIChatSession.js` | **Browser / native WebView** with ChatEntity/DBOPFS and a configured chat function | Live-context commit is atomic; new durable records contain complete visible content and timestamps with optional application display metadata. Per-turn `persist:false` and entity-wide `persist=false` keep the operation's input and response outside retained context, transcript, memory, and DBOPFS. Existing saved records remain unchanged. |
| Store and display images referenced by Markdown | `/arcane/modules/MarkdownMedia.js` and shared Markdown views | **Browser / native WebView** with application-owned DBOPFS storage | Complete image records stay in the selected table; raw Markdown holds stable `arcane-media:` references. Hydration owns temporary display URLs, cancellation, per-image errors, and print-resource retention. Pure record decoding performs no storage or network work. |
| Print rendered editor content or file previews | `/arcane/modules/PrintView.js`, editor `print()`, and file/history `printPreview()` | **Browser / native WebView** with DOM and browser printing | Complete current rendered content, fonts, and resolved media are captured for print. Explicit requests await view preparation; native Print captures synchronously. Shared `print.css` supplies a light paper palette and one-inch margins; snapshots stay owned through `afterprint`. |
| Search an app-owned document corpus for explicit chat context | `/arcane/modules/DBOPFSDocumentLibrary.js` | **Browser** or compatible injected DBOPFS adapter | Generation/manifest completion, complete lexical search, partial read failures, and untrusted context labels are normalized. Construction does not search; an explicitly wired context builder performs retrieval for each prepared chat send. |
| Read host identity, capabilities, storage, preferences, appearance, or platform state | `globalThis.Arcane` | **Cross-host** where the method is implemented and admitted | Promise behavior and `Arcane.Error` are normalized. Result fields are normalized unless the method explicitly documents a platform-dependent snapshot. |
| Connect browser code to an existing Core transport | `arcane-os/core/client` and `arcane-os/core/contracts` | **Browser / native WebView** with an admitted transport; explicit development HTTP remains opt-in | The reusable client owns `arcane/1` correlation, readiness, cancellation, events, facades, and complete native error fidelity. It supplies no service, policy, or host process. |
| Compose native Core services and framed stdio hosting | `arcane-os/core/runtime`, `arcane-os/core/stdio`, and `arcane-os/core/host` | **Node** on Windows, Linux, or macOS; the composing native host supplies its process and bridge | The SDK owns reusable dispatch, per-service lifecycle, request/service work ownership, cooperative cancellation, drain, and stdio framing. Product identity, policy, privileges, models, storage, and services remain host-owned. |
| Assemble a portable Core payload from the installed SDK | `arcane-os/native/portable-provider` | **Node**; portable platform selection is currently Windows or Linux, while separately composed hosts may use the payload | The provider copies the selected app, dependencies, installed SDK runtime, Core client/runtime, and explicit service composition into a non-executable directory. It uses no `arcaneRoot` by default and does not prove host behavior or supply a platform bridge. |
| Assemble and run a Windows executable | [`arcane-os/native/windows-provider`](core-native-packaging.md#windows-executable) | **Node** for assembly; Windows x64, .NET Framework 4.6.2+ and WebView2 for execution | Uses the installed SDK version's precompiled release asset and explicit app services. Complete diagnostics and accepted service work drain on run cancellation; no OS checkout or application-side native compiler is required. |
| Use application-selected llama.cpp/Ollama through Core | [`arcane-os/core/local-ai`, `arcane-os/ai/core-local`](local-ai.md) | **Node** native service; **Browser / native WebView** provider through an explicit Core connection | Independent runtime/model lifecycle, complete streaming and cancellation. Official runtime preparation follows explicit app requirements; model selection and business policy stay app-owned. |
| Use local AI without coupling app code to Ollama HTTP | `Arcane.localAI`, `Arcane.ai`, or `/arcane/modules/Ollama.js` | Primarily **Native**; Android exposes a narrower admitted inference projection | Admission, errors, and managed-operation events are normalized. Direct Ollama response envelopes remain **Provider-native**. |
| Use TWiN Cloud from the renderer profile | `/arcane/modules/AI.js` | **Cloud** from an allowed browser/native renderer | High-level chat behavior is normalized by the module. The TWiN access key authenticates remote LLM chat; raw provider diagnostics remain provider-specific. No automatic cloud fallback is inferred from local failure. |
| Send one TWiN Cloud request with an explicit key and model | `fetchRequest` from `arcane-os/ai/twin-cloud` | **Node** and **Browser**, using standard Fetch and a remote HTTPS provider | Keeps complete messages and returns the full parsed provider JSON. Rejected Fetch and HTTP 529 share three retries after 3000 ms; HTTP 429 overload retains unlimited three-second retries. Optional `onRetry` reports waiting/requesting phases without blocking recovery. Shared structured-output mapping and cancellation match browser TWiN transport. No browser profile, AI/user singleton, DBOPFS, or retained request history is created. |
| Evaluate caller-owned state and questions with TWiN System One | `fetchSystemOneRequest` from `arcane-os/ai/twin-cloud` | **Node** and **Browser**, using standard Fetch and a remote HTTPS provider | Posts the explicit model and complete state/questions through the existing JSON transport. Returns the entire parsed provider result and shares its retry, diagnostic, and cancellation behavior. Model choice, question definitions, answer interpretation, and scoring policy stay with the caller; no conversation state is retained. |
| Generate images from a complete caller-owned prompt | `generateImages` from `arcane-os/ai/twin-cloud` | **Node** and **Browser**, using standard Fetch, Blob, and a remote HTTPS provider | Caller selects `fal-ai/flux/schnell` or `stable-diffusion-3.5-large`, credentials, and provider parameters. Returns every image as a Blob with media metadata in provider order; owns progress, job polling, and cancellation. Submission is not automatically replayed after an ambiguous failure. Display and storage stay application-owned. |
| Use speech through one application helper | `/arcane/modules/AI.js` and `Arcane.speech` | **Browser** or **Native** | Whisper and Kokoro keep their on-device paths; explicitly selected Web Speech STT/TTS and TWiN Cloud TTS declare their non-local behavior. `prepareTTSPlayback` supports real audio and silent native descriptors; `fetchTTS` and durable `prepareTTS` require real audio. Provider choice, model, voice, and credentials stay application-owned. |
| Inspect or manage raw Ollama models | `Arcane.ollama` or `/arcane/modules/Ollama.js` | **Native** desktop Core for management; narrower Android inference only | Wrapper method names, errors, streaming correlation, and admission are Arcane-controlled. Direct Ollama success envelopes are intentionally provider-native. |
| Use native terminal, installation, user, provisioning, or machine controls | matching `Arcane.*` namespace | **Native** and app/capability restricted | Calls and errors use the common bridge contract. Platform results can be host-specific and are marked in the method guide. |

## The normalized application path

For ordinary cross-platform application code:

```javascript
const runtime = globalThis.Arcane?.runtime?.current?.();

if (!runtime?.connected) {
    throw new Error('Open this application through an Arcane host.');
}

const access = await globalThis.Arcane.capabilities.list();

if (!access.methods.includes('localAI.status')) {
    throw new Error('This application is not admitted for local AI.');
}

const status = await globalThis.Arcane.localAI.status();
console.log(status.ready, status.models);
```

This code does not select WebView2, WebKitGTK, or an HTTP bridge. It calls one
Arcane API. The host chooses its transport, and Core applies the bound
application identity and method policy.

## Normalization levels

### Fully SDK-normalized

The Node toolchain uses `ArcaneError`, stable SDK error codes, structured
`arcane-cli-events/1` records, and normalized target descriptors. Platform
providers can add complete target detail but cannot
silently substitute a different target or artifact kind.

The central EventManager is also host-neutral JavaScript. Its synchronous live
bus preserves listener argument identity, while its optional history owns a
separate diagnostic normalization boundary: snapshots are complete, redact
credentials and explicitly protected private fields, and are importable as
`arcane-event-stack/1`. DOM
instrumentation adds browser diagnostics only; it does not replay browser
state. See [EventManager and time-travel review](event-manager.md).

### Browser-local provider adapter

[`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) exposes the same
provider-neutral lifecycle used by `createArcaneAI()`, while its packaged
Wllama engine and caller-supplied model run inside the browser. This
surface does not require an Arcane Core method grant because it does not call a
Core host. Browser Fetch, CORS, storage policy, secure-context behavior, and
resource limits still apply.

The browser runtime defaults to full GPU offload (`gpuLayers:99999`). Explicit
`loadDefaults:{gpuLayers:0}` or `load({gpuLayers:0})` selects CPU and skips
WebGPU requirements and adapter work; GPU failure never selects CPU implicitly.
Both routes wait for Wllama to report the complete model loaded.
`navigator.gpu` presence by itself is not readiness. On the GPU route, the
provider emits the instrumented
`arcane.ai.browser-wasm.webgpu.adapter.selected` capability event after adapter
selection.

`localOnly:true` describes inference after load; it does not promise that load
is offline. A normal cache miss downloads from the exact caller-supplied HTTPS
URL. App, provider/model-binding, and load-operation options may use
`{security:{secure?:boolean}}`. The SDK default is `secure:false`, and omitted
security leaves ordinary model loading fully functional. Download byte counts,
remaining bytes, rate, and ETA are observational progress only. Optional member
`bytes` values may initialize progress and HTTP Range planning, but neither
declared nor observed byte measures validate, admit, identify, hash, or decide
cache reuse for model content. Completed split members and deterministic Range
parts within any member are retained across an interrupted install so retry
fetches only missing work. Exact part length is used only to recognize a
completed HTTP transport frame. Zero-length whole entries and incomplete Range
sets cannot become cache hits; failed or incorrectly framed active parts are
removed. After a
complete current representation exists, the store attempts to remove redundant
Range fragments; cleanup failure is warned without hiding the usable model. Optional
`secure:true` records intent only; historical checking remains disabled until a
separately authorized user review. Successful
Wllama model loading remains mandatory. `load({offline:true})` permits only a compatible
cache entry and otherwise rejects with `ARCANE_AI_MODEL_OFFLINE_MISS`. Tool
calls are result data for application review and dispatch; every declaration
and emitted call requires nonempty user-facing `arguments.message`, and the SDK
never executes them. An ordered assistant call array remains pending until the
application records exactly one matching executed, declined, cancelled, or
not-executed `role:'tool'` result with nonblank user-facing content for every
pending ID in one atomic batch. The direct browser provider and its
v1-to-provider/2 adapter validate the same request history, declarations, and
terminal structural-call contract. Structured completions contain exactly one
top-level `message` or `choices` envelope, every choice is validated, and the
ordinary stream iterator exposes complete content and reasoning projections
from every choice in provider order while its private pump continues even when
the terminal result is awaited first. Structural deltas remain private until
validation; terminal-only calls are valid, while observed calls must preserve
their choice, order, identity, exact arguments, and extension fields at
settlement. Complete provider chunks and terminal envelopes remain available
through explicit data, response, or inspection surfaces.

[`arcane-os/ai/browser-speech`](ai/browser-speech.md) implements the sibling
`stt` and `tts` provider/2 roles. Each caller-selected Whisper or Kokoro
provider has its own load, use, cancellation, unload, dispose, cache, Worker,
status, and error state. The SDK supplies neither speech adapter runtime nor
model/voice content; every selected file is application-owned and stored
through the SDK-created DBOPFS adapter.

Both speech roles default to `device:'auto'`: try `webnn-npu` when
`navigator.ml.createContext` exists, then exposed WebGPU, then WASM. A failed
backend load releases its Worker/session pool before a fresh pool tries the
same prepared model and precision on the next backend. Explicit `webnn-npu`,
`webgpu`, or `wasm` selects only that backend. Whisper accepts exactly one
Worker/session. Kokoro defaults to `maxConcurrentRequests:4` and accepts one
through four; its FIFO queue preserves later requests while those slots are
occupied.

For high-level speech, read
`ai.providerRuntime.status(role, {execution:true}).execution` for `stt` or `tts`
after load. Both report `requestedDevice`, `selectedDevice`,
`maxConcurrentRequests`, and `activeRequestCount`. `selectedDevice` is `null`
while unloaded and identifies the successful session backend after load.
WebNN may use WASM for unsupported operations, so that field does not establish
that every operation ran on a physical NPU. The default `status()`
remains the sticky lifecycle snapshot; execution is an explicit provider read,
and inspection errors propagate. Neither state proves physical GPU kernel
overlap. See the [copyable speech quick start](ai/browser-speech.md).

Materialized speech graphs use their file inventory as a routing table, not an
admission policy. Known downloaded imports, fetches, Workers, and cache reads
route to their materialized URLs; unmapped operations fall through to the
native browser API with caller options preserved, and native cache writes are
not disabled.

The projected [`AIProviderRuntime`](runtime-modules.md#aiproviderruntimejs)
normalizes those browser providers and can admit an externally supplied native
or cloud provider/2 adapter. `AI.js` also supplies built-in adapters for
an already-selected TWiN Cloud LLM route, Ollama route, or admitted local Core
speech route. Application-selected Web Speech recognition, Web Speech
synthesis, and TWiN Cloud/FAL synthesis can be registered through
`ai.configureSpeechProvider(role,provider,{modelId})`; configuration owns only
the selected role and performs no network request. Saved selections remain
application-owned, including selections waiting for provider registration.
The SDK supplies reusable Core client/runtime/service-lifecycle primitives and
portable payload composition; privileged execution stays in a native host.
It supplies no application credential, selected model or product speech-service
authority. Capability-only built-in adapters report their
existing routes without probing, downloading, or changing providers. The sticky
[`AIRuntimeState`](runtime-modules.md#airuntimestatejs) surface keeps
application UI independent of transport. A selected route remains explicit:
browser failure is not permission to invoke Core or cloud.

### Arcane bridge-normalized

Core-backed calls return promises and reject with `Arcane.Error`. Transport
selection, request correlation, JSON framing, capability denial, diagnostics,
and public operation events are normalized at the bridge. Method data contracts
remain authoritative; a method that documents platform-dependent fields is not
silently widened into a fictional common shape.

### Helper-normalized

Renderer helpers can deliberately collapse provider detail. For example,
`ollama.chatText()` returns a string extracted from the final chat envelope and
`ollama.generateText()` returns a string extracted from the final generation
envelope. `ollama.readiness()` returns a frozen `{ready, version, errorCode}`
snapshot.

### Provider-native within an Arcane boundary

[`arcane-os/ai/twin-cloud`](ai/twin-cloud.md) accepts an explicit `twinKey` and
`model`, with the same named `fetchRequest` import in Node and managed browsers.
It preserves complete provider response JSON while mapping the supplied
structured-output, tool, and reasoning options to the TWiN wire contract.
The SDK adds no output cap or persisted context. Cancellation applies during
request, body read, overload retry wait, and callback settlement. The existing
profile-backed browser `AI.js` entry and its lifecycle remain separate.

Direct `Arcane.ollama.chat()`, `generate()`, `show()`, `embed()`, and lifecycle
methods return complete Ollama-compatible envelopes. Arcane still owns error
normalization, chunk correlation, and host transport, but it does
not rename every provider response field. Feature-detect optional Ollama fields
and use the high-level helpers when an application needs a smaller common
contract.

### Platform-dependent by design

Host service settings, machine evidence, permissions, installation state, and
native build artifacts can differ between Microsoft NT, Linux, Android, and a
development browser. Those methods provide a stable outer contract and mark
platform-specific fields or unsupported states. `supported: false` is a valid
result where documented; it is not permission to bypass the host from renderer
code.

## No implicit protocol or provider fallback

Arcane can expose the same method over different host transports, but it does
not reinterpret a failed native call as authorization to send data to a cloud
provider. Provider selection is explicit application/user profile state. A
remote or development HTTP bridge transports an admitted Arcane call; it is not
an automatic OpenAI fallback and does not turn a standalone browser into a
native host.

Deep details: [protocol selection and host boundaries](protocols.md).
