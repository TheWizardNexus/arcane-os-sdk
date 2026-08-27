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
| **Provider-native** | Intentionally returns the underlying provider's bounded envelope instead of an Arcane-normalized entity. |

“Available” never means “authorized.” App grants, method allowlists, host
policy, package-owned model policy, platform support, and dependency readiness
are independent checks.

The current native host/target matrix covers Microsoft NT, Linux, and Android
where listed. It exposes no macOS target or Core host contract in this SDK
version; WebKitGTK availability must not be generalized to macOS.

## Capability-first matrix

| What the developer wants to do | Preferred surface | Availability | Normalization |
| --- | --- | --- | --- |
| Scaffold, inspect, test, package, bundle, build, verify, or run an app | `arcane` CLI or `arcane-os` package functions | **Node**; native targets invoke one explicit provider | CLI events and SDK errors/results are normalized by versioned SDK contracts. Native artifact receipts remain target-specific inside a common receipt lifecycle. |
| Publish application events or review a bounded event history | `arcane-os/event-manager` | **Node** and **Browser**; optional DOM capture needs a browser DOM or compatible host | Live listeners receive original arguments. Recorded payloads and metadata become bounded, redacted, deeply frozen `arcane-event-stack/1` snapshots. The stack format is local diagnostic data, not a host transport. |
| Build browser UI and app-local behavior | `/arcane/modules/*.js`, shared entities, and components | **Browser**; many modules also run inside every native renderer | Pure modules own their result contracts. Modules that call `Arcane` inherit the bridge boundary described below. |
| Select and observe independent LLM/STT/TTS roles | `/arcane/modules/AIProviderRuntime.js` and `AIRuntimeState.js` | **Cross-host** controller/state; registered providers retain their own host requirements | Required/projected provider members, closed route/configuration records, and validated authority/status fields; per-role lifecycle, cancellation, stream cleanup, sticky state, and startup barriers are normalized. `localOnly` fails closed and creates no fallback. |
| Run a caller-selected local LLM entirely in a browser renderer | `arcane-os/ai/browser-wasm` through `createArcaneAI()` | **Browser** only; secure context, WebAssembly, OPFS/DBOPFS, WebGPU, requested full offload, and admitted adapter/buffer/queue/fence evidence are required; no CPU fallback | The facade normalizes multi-model lifecycle, status, security precedence, effective-check disclosure, streaming, cancellation, and structural tool-call visibility. Model sources are canonical ordered file descriptors; licenses and model choice remain application policy. |
| Run caller-selected Whisper or Kokoro in a browser renderer | `arcane-os/ai/browser-speech` registered with `AIProviderRuntime` | **Browser** only; DBOPFS, Web Locks, Workers, Fetch/object URLs, and a caller-supplied self-contained runtime/model closure are required | STT/TTS use independent provider/2 lifecycle and status. Immutable artifact authority, manifest-last cache, strict offline admission, cancellation, Worker teardown, and request/result shapes are normalized. No runtime/model bytes or cloud fallback are supplied. |
| Preserve bounded chat history and memory | `/arcane/modules/PersistentAIChatSession.js` | **Browser / native WebView** with ChatEntity/DBOPFS and a configured chat function | Existing DBOPFS names and memory semantics are preserved. Live-context commit is atomic; durable persistence is explicit and coherent across user/assistant/tool turns. |
| Search an app-owned document corpus for explicit chat context | `/arcane/modules/DBOPFSDocumentLibrary.js` | **Browser** or compatible injected DBOPFS adapter | Generation/manifest completion, bounded lexical search, partial read failures, and untrusted context labels are normalized. Construction does not search; an explicitly wired context builder performs bounded retrieval for each prepared chat send. |
| Read host identity, capabilities, storage, preferences, appearance, or platform state | `globalThis.Arcane` | **Cross-host** where the method is implemented and admitted | Promise behavior and `Arcane.Error` are normalized. Result fields are normalized unless the method explicitly documents a platform-dependent snapshot. |
| Use local AI without coupling app code to Ollama HTTP | `Arcane.localAI`, `Arcane.ai`, or `/arcane/modules/Ollama.js` | Primarily **Native**; Android exposes a narrower admitted inference projection | Admission, errors, and managed-operation events are normalized. Direct Ollama response envelopes remain **Provider-native**. |
| Use OpenAI from the renderer profile | `/arcane/modules/AI.js` | **Cloud** from an allowed browser/native renderer | High-level AI chat/text behavior is normalized by the module; raw provider diagnostics and some response detail remain provider-specific. No automatic cloud fallback is inferred from local failure. |
| Use local or cloud speech through one application helper | `/arcane/modules/AI.js` and `Arcane.speech` | **Browser**, **Native**, or **Cloud**, depending on the selected speech profile | The helper normalizes application-facing audio/text behavior; native and cloud request/response plumbing differs below that boundary. |
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
`arcane-cli-events/1` records, normalized target descriptors, and authenticated
receipt objects. Platform providers can add bounded target detail but cannot
silently substitute a different target or artifact kind.

The central EventManager is also host-neutral JavaScript. Its synchronous live
bus preserves listener argument identity, while its optional history owns a
separate diagnostic normalization boundary: snapshots are bounded, redacted,
deeply frozen, and strictly importable as `arcane-event-stack/1`. DOM
instrumentation adds browser diagnostics only; it does not replay browser
state. See [EventManager and time-travel review](event-manager.md).

### Browser-local provider adapter

[`arcane-os/ai/browser-wasm`](ai/browser-wasm.md) exposes the same
provider-neutral lifecycle used by `createArcaneAI()`, while its packaged
Wllama engine and caller-supplied model run inside the browser. This
surface does not require an Arcane Core method grant because it does not call a
Core host. Browser Fetch, CORS, storage policy, secure-context behavior, and
resource limits still apply.

The shipped `0.2.2` runtime requires WebGPU and has no CPU fallback. A successful
load requests full GPU offload (`gpuLayers: 99999`) and admits actual adapter,
full-offload, buffer, queue, and settled-fence evidence. `navigator.gpu`
presence by itself is not readiness. The provider emits the instrumented
`arcane.ai.browser-wasm.webgpu.adapter.selected` capability event only after
admitted adapter selection evidence.

`localOnly:true` describes inference after load; it does not promise that load
is offline. A normal cache miss downloads from the exact caller-supplied HTTPS
URL. App, provider/model-binding, and load-operation options use
`{security:{secure?:boolean, checks?:{byteLength?:boolean, sha256?:boolean}}}`.
Fields resolve independently from load operation to provider/model binding to
app configuration to the SDK default `secure:false`; omitted fields inherit.
The resolved `secure` value supplies the default for both checks, and an
explicit per-check boolean overrides that default.

An enabled check requires and verifies its matching descriptor field. A
disabled byte-length check permits `bytes` to be absent and never compares an
expected size, although the actual downloaded or cached byte count is always
recorded for storage and progress metadata. A disabled SHA-256 check permits
`sha256` to be absent and performs no hash or digest-only reread. Status reports
the effective checks and distinguishes unchecked integrity from successful
verification of the enabled checks. Only enabled checks fail closed, while
successful Wllama model loading remains mandatory. `load({offline:true})` permits only a compatible
cache entry and otherwise rejects with `ARCANE_AI_MODEL_OFFLINE_MISS`. Tool
calls are result data for application review and dispatch; the SDK never
executes them.

[`arcane-os/ai/browser-speech`](ai/browser-speech.md) implements the sibling
`stt` and `tts` provider/2 roles. Each caller-authenticated Whisper or Kokoro
provider has its own load, use, cancellation, unload, dispose, cache, Worker,
status, and error state. The SDK supplies neither speech adapter runtime bytes
nor model/voice bytes; every immutable file is application-owned and admitted
through an SDK-created authority and DBOPFS artifact store.

The projected [`AIProviderRuntime`](runtime-modules.md#aiproviderruntimejs)
normalizes those browser providers and can admit an externally supplied native
or cloud provider/2 adapter. `AI.js` also supplies compatibility adapters for
an already-selected legacy OpenAI route, Ollama route, or admitted Core speech
route. SDK `0.2.2` publishes no privileged Core implementation, credential,
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
methods return bounded Ollama-compatible envelopes. Arcane still owns admission,
limits, error normalization, chunk correlation, and host transport, but it does
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
