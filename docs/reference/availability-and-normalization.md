# Availability and normalization

Use this page to choose an API by capability. The compact labels tell you where
it runs; the [protocol guide](protocols.md) contains the implementation detail.

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

The current native host/target matrix covers Microsoft NT, Linux, and Android
where listed. It exposes no macOS target or Core host contract in this SDK
version; WebKitGTK availability must not be generalized to macOS.

## Capability-first matrix

| What the developer wants to do | Preferred surface | Availability | Normalization |
| --- | --- | --- | --- |
| Scaffold, inspect, test, package, bundle, build, verify, or run an app | `arcane` CLI or `arcane-os` package functions | **Node**; native targets invoke one explicit provider | CLI events and SDK errors/results are normalized by versioned SDK contracts. Tests and checks run only when explicitly selected; verification is separate and selected-output-specific. |
| Publish application events or review a complete event history | `arcane-os/event-manager` | **Node** and **Browser**; optional DOM capture needs a browser DOM or compatible host | Live listeners receive original arguments. Ordinary `secure:false` recording preserves complete URLs, public details, and captured stack text in deeply frozen `arcane-event-stack/1` snapshots while credential-named fields remain redacted. The stack format is local diagnostic data, not a host transport. |
| Build browser UI and app-local behavior | `/arcane/modules/*.js`, shared entities, and components | **Browser**; many modules also run inside every native renderer | Pure modules own their result contracts. Modules that call `Arcane` inherit the bridge boundary described below. |
| Select and observe independent LLM/STT/TTS roles | `/arcane/modules/AIProviderRuntime.js` and `AIRuntimeState.js` | **Cross-host** controller/state; registered providers retain their own host requirements | Required/projected provider members, route/configuration records, and status fields; per-role lifecycle, cancellation, stream cleanup, sticky state, and startup barriers are normalized. `localOnly` creates no fallback. |
| Run a caller-selected local LLM entirely in a browser renderer | `arcane-os/ai/browser-wasm` through `createArcaneAI()` | **Browser** only; secure context, WebAssembly, OPFS/DBOPFS, WebGPU, and requested full offload are required; no CPU fallback | The public AI API module normalizes multi-model lifecycle, status, complete all-choice streaming, cancellation, exact ordered structural tool-call visibility, and session persistence. Model sources are canonical ordered file descriptors; licenses and model choice remain application policy. |
| Run caller-selected Whisper or Kokoro in a browser renderer | `arcane-os/ai/browser-speech` registered with `AIProviderRuntime` | **Browser** only; DBOPFS, Web Locks, Workers, Fetch/object URLs, and a caller-supplied self-contained runtime/model closure are required | STT/TTS use independent provider/2 lifecycle and status. Complete model/runtime selection, offline behavior, cancellation, Worker teardown, and request/result shapes are normalized. No runtime/model content or cloud fallback is supplied. |
| Preserve complete chat history and memory | `/arcane/modules/PersistentAIChatSession.js` | **Browser / native WebView** with ChatEntity/DBOPFS and a configured chat function | Existing DBOPFS names and memory semantics are preserved. Live-context commit is atomic; durable persistence is explicit and coherent across user/assistant turns and atomic all-ID tool-result batches. |
| Search an app-owned document corpus for explicit chat context | `/arcane/modules/DBOPFSDocumentLibrary.js` | **Browser** or compatible injected DBOPFS adapter | Generation/manifest completion, complete lexical search, partial read failures, and untrusted context labels are normalized. Construction does not search; an explicitly wired context builder performs retrieval for each prepared chat send. |
| Read host identity, capabilities, storage, preferences, appearance, or platform state | `globalThis.Arcane` | **Cross-host** where the method is implemented and admitted | Promise behavior and `Arcane.Error` are normalized. Result fields are normalized unless the method explicitly documents a platform-dependent snapshot. |
| Use local AI without coupling app code to Ollama HTTP | `Arcane.localAI`, `Arcane.ai`, or `/arcane/modules/Ollama.js` | Primarily **Native**; Android exposes a narrower admitted inference projection | Admission, errors, and managed-operation events are normalized. Direct Ollama response envelopes remain **Provider-native**. |
| Use TWiN Cloud from the renderer profile | `/arcane/modules/AI.js` | **Cloud** from an allowed browser/native renderer | High-level chat behavior is normalized by the module. The TWiN access key authenticates remote LLM chat; raw provider diagnostics remain provider-specific. No automatic cloud fallback is inferred from local failure. |
| Use speech through one application helper | `/arcane/modules/AI.js` and `Arcane.speech` | **Browser** or **Native** | The helper keeps audio on device: Whisper owns STT and Kokoro owns TTS. It normalizes application-facing audio/text behavior while browser and native request/response plumbing differs below that boundary. |
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

The current browser runtime requires WebGPU and has no CPU fallback. A successful
load requests full GPU offload (`gpuLayers: 99999`). `navigator.gpu` presence by
itself is not readiness. The provider emits the instrumented
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

Materialized speech graphs use their file inventory as a routing table, not an
admission policy. Known downloaded imports, fetches, Workers, and cache reads
route to their materialized URLs; unmapped operations fall through to the
native browser API with caller options preserved. Edge, transform,
negative-route, and security records retained for compatibility do not gate the
ordinary path, and native cache writes are not disabled.

The projected [`AIProviderRuntime`](runtime-modules.md#aiproviderruntimejs)
normalizes those browser providers and can admit an externally supplied native
or cloud provider/2 adapter. `AI.js` also supplies compatibility adapters for
an already-selected TWiN Cloud LLM route, Ollama route, or admitted local Core
speech route. Its built-in audio selections are on-device only: saved `OPENAI`
speech selections migrate to `LOCAL_SPEACH` with `whisper-small` for STT and
`kokoro` for TTS. The SDK publishes no privileged Core implementation,
credential,
model, or speech-runtime authority, and those adapters never probe, select,
download, or fall back. The sticky
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
