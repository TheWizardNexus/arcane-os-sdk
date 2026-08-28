# Browser-WASM local AI

Use this browser-only entrypoint when an application deliberately owns a local
GGUF model authority and wants provider-neutral LLM lifecycle, chat, streaming,
cancellation, and structural tool-call results without an Arcane Core host.
For ordinary hosted applications, start with the [Arcane AI
contracts](../core/arcane-ai-contracts.md) and `globalThis.Arcane.ai`. This
page is the focused local-browser path beneath the normalized AI decision
guide.

The wiring example assumes a scaffolded or materialized Arcane application
with SDK `0.3.0`'s runtime tree and generated browser import map.
`arcane/DBOPFS` is a managed browser-map specifier, not an npm package export.
See [browser runtime delivery](../protocols.md#browser-runtime-delivery) before
using the example in a custom host or bundler.

```javascript
import DBOPFS from 'arcane/DBOPFS';
import {
    createArcaneAI,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';

const MODEL = Object.freeze({
    id:'my-reviewed-model',
    files:Object.freeze([{
        name:'model-q4-00001-of-00002.gguf',
        url:'https://models.example/revisions/4f7c/model-q4-00001-of-00002.gguf',
        bytes:123456789,
        sha256:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    },{
        name:'model-q4-00002-of-00002.gguf',
        url:'https://models.example/revisions/4f7c/model-q4-00002-of-00002.gguf',
        bytes:98765432,
        sha256:'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    }])
});

const dbopfs = globalThis.dbopfs || new DBOPFS({applicationId:'my-app'});
await dbopfs.readyPromise;
const source = createBrowserModelSource(MODEL);
const store = createDbopfsModelStore({dbopfs});
const provider = createBrowserWasmLlmProvider({source, store});
const ai = createArcaneAI({
    provider,
    loadPolicy:'manual',
    security:{secure:true}
});

// Put this behind an explicit user action: it can download every declared file.
async function loadReviewedModel() {
    return ai.load({threads:1, contextTokens:4096});
}
```

The browser-WASM runtime closure packages the authenticated
`@wllama/wllama` `3.6.0` ESM and WebAssembly runtime plus the Wllama and
llama.cpp MIT license texts. It
packages no model weights, default model catalog, CDN fallback, native
provider, speech synthesis, or transcription. The sibling
[`arcane-os/ai/browser-speech`](browser-speech.md) entrypoint supplies speech
provider mechanisms but still no runtime/model bytes. Callers supply every
model-source authority. Each file's `bytes` is an optional expected positive
byte length, not inline model data. The declared URL binds selection identity;
exact byte identity is established only by the checks the caller enables and
supplies.

## Lifecycle at a glance

`createArcaneAI()` owns one LLM controller. Its default `loadPolicy` is
`on-demand`; the first request may download and initialize the model. Use
`manual` when a user action, resource review, or progress UI must precede load.

| Operation | Result |
| --- | --- |
| `ai.status()` | Frozen `{llm: status}` wrapper. |
| `ai.load(options)` | Flat LLM status after load. |
| `ai.llm.chat(request)` / `ai.fetchRequest(request)` | Validated OpenAI-like completion. |
| `ai.llm.stream(request)` | Frozen async-iterator handle with `result` and `cancel(reason)`. |
| `ai.streamRequest(request)` | Consumes the stream and returns text or `{toolName: argumentJsonString}`. |
| `ai.createChatSession(options)` | Asynchronously resolves `Promise<PersistentAIChatSession>` bound to this exact controller; caller-supplied `chat` is rejected. |
| `ai.unload()` | Cancels active work, releases the Wllama session, and returns flat unloaded status; the DBOPFS cache remains. |
| `ai.dispose()` | Permanently disposes the controller; explicit `store.remove(source)` is required to delete cached model bytes. |

The controller emits `statechange` and `progress` through
`addEventListener()`, `removeEventListener()`, or `on()`. Event `detail` is the
current frozen status. Provider states are `unloaded`, `loading`, `ready`,
`unloading`, and `error`.

## Model authority, security, and cache admission

The canonical model descriptor is `{id, files:[{name?,url,bytes?,sha256?},...]}`.
The ordered `files` array is nonempty; names and URLs are unique. Each URL must
be absolute HTTPS without credentials or a fragment; revision-floating `main`,
`master`, and `latest` path segments are rejected. When supplied, `bytes` is a
positive safe integer and `sha256` is exactly 64 hexadecimal characters. The
legacy one-file `{id,url,bytes?,sha256?}` shape remains accepted and normalizes
to one ordered member.

Fetch follows HTTPS redirects and records the requested and final HTTPS URL in
the completion evidence. A redirect that leaves HTTPS is rejected. A declared
URL, revision-looking path, or recorded final URL is not a byte digest: only an
enabled byte-length or SHA-256 check establishes that corresponding integrity
fact. When a check is disabled, status reports it as `unchecked`.

App, provider/model-binding, and load-operation options use the same
plain-JavaScript shape:

```javascript
{
    security:{
        secure:true,
        checks:{byteLength:true, sha256:true}
    }
}
```

The SDK default is `secure:false`. Security fields resolve independently from
the load operation, then provider/model binding, then app configuration, then
the SDK default. Omitted fields inherit; they do not become `false`. After
resolution, `secure:true` makes both checks enabled by default and
`secure:false` makes both checks disabled by default. An explicit inherited or
lower-scope `checks.byteLength` or `checks.sha256` boolean overrides that secure
default for its check.

An enabled byte-length check requires descriptor `bytes` and compares it with
the actual cached or downloaded byte count. A disabled byte-length check permits
`bytes` to be absent and never rejects a cached or downloaded model by comparing
it with an expected size. The store still counts and records the
observed byte length for storage and progress metadata on every install and
cache reuse.

An enabled SHA-256 check requires descriptor `sha256` and hashes the actual
stored or cached file. A disabled SHA-256 check permits `sha256` to be absent
and does not hash or reread a multi-gigabyte model solely to produce a digest.
Only enabled checks fail closed. Regardless of optional integrity checks, a
load succeeds only after Wllama reports that the model is loaded.

The DBOPFS adapter commits an `arcane.ai.browser-wasm.model.v4` completion
manifest only after every ordered file succeeds. Status reports the effective
`security.secure`, both effective check booleans, and per-check integrity
outcomes. Overall integrity is `verified` when every enabled check succeeded,
`pending` while an enabled check is running, and `unchecked` when neither check
is enabled. Before completion an enabled check reports `pending`; after a
successful load each check independently reports `verified` or `unchecked`.
`load({offline:true})` never
performs a model request; it uses a compatible cached entry or rejects with
`ARCANE_AI_MODEL_OFFLINE_MISS`.

```javascript
const {security, integrity} = ai.status().llm;
console.log(security.secure, security.checks.byteLength, security.checks.sha256);
console.log(integrity.state); // 'unchecked' or 'verified'
console.log(integrity.byteLength.observed); // actual cached/downloaded bytes
```

For one-file compatibility, older descriptors can supply `immutableUrl` as the
URL alias and `name` as a cache-filename hint. If both `url` and
`immutableUrl` are present, they must match. Legacy `licenseSpdx` and
`sourceRevision` properties are
not canonical descriptor fields or runtime admission checks; applications remain responsible for model selection,
provenance, and license compliance. Version-2/3 compatibility is internal; a
new successful completion is always recorded as version 4 without inventing an
integrity result.

`localOnly:true` describes inference after load. It does not mean a cache miss
cannot download. Source downloads use CORS, omit credentials and referrer,
disable HTTP caching, and honor `AbortSignal`.

On Chrome, observing a lower-power Intel WebGPU adapter may open
`chrome://flags/#force-high-performance-gpu` in a new tab and show an alert
explaining that Chrome must be completely restarted after changing the flag.
The notice is advisory; it does not change browser settings, prove a faster
adapter exists, or make a failed load succeed.

## Streaming, cancellation, and tools

```javascript
async function streamLocalSummaryAfterUserChoice(cancelButton) {
    // The selected browser-WASM model must already be ready.
    if (!cancelButton?.addEventListener) {
        throw new TypeError('A cancel button is required.');
    }
    const abort = new AbortController();
    const stream = ai.llm.stream({
        localOnly:true,
        signal:abort.signal,
        messages:[{role:'user', content:'Summarize this text.'}],
        maxTokens:128
    });

    const cancel = () => abort.abort('user cancelled');
    cancelButton.addEventListener('click', cancel, {once:true});
    try {
        for await (const chunk of stream) renderChunk(chunk);
        const completion = await stream.result;
        renderCompletion(completion);
    } catch (error) {
        if (error?.code !== 'ARCANE_AI_REQUEST_ABORTED') throw error;
        renderCancelled();
    } finally {
        cancelButton.removeEventListener('click', cancel);
    }
}
```

An active cancellation rejects as `ARCANE_AI_REQUEST_ABORTED`. Requests are
serialized; provider status exposes `busy` and `queued`. Supported request
generation fields include temperature, top-K, top-P, min-P, repeat penalty,
maximum tokens, seed, and stop sequences. Load settings separately include
`contextTokens`, `batchTokens`, `microBatchTokens`, `threads`, and GPU-layer
count. The shipped runtime always sets `gpuLayers: 99999`: WebGPU and proved
full offload are mandatory, and there is no CPU fallback. Secure context,
adapter selection, full-offload, logical-buffer, queue-submission, and
settled-fence evidence are load admission; cross-origin isolation and coarse
hardware fields remain observations.

Tool definitions, tool choice, parallel-tool-call preference, and JSON or JSON
Schema structured-output requests are passed to Wllama. Returned tool calls are
validated and surfaced as structural data. Argument payloads remain JSON
strings. The SDK never invokes a handler or executes a tool; application code
must review policy, validate arguments, choose whether to execute, and submit a
later tool result.

## Errors and unavailable states

Invalid configuration can throw `TypeError` or `RangeError`. Operational
failures expose a stable `.code`; the internal error class is not exported.
Handle the narrow code needed by the current operation and treat other failures
as unavailable.

| Area | Stable codes |
| --- | --- |
| Source and download | `ARCANE_AI_MODEL_SOURCE_INVALID`, `ARCANE_AI_MODEL_SOURCE_UNAVAILABLE`, `ARCANE_AI_MODEL_DOWNLOAD_FAILED`, `ARCANE_AI_MODEL_REDIRECT_BLOCKED`, `ARCANE_AI_MODEL_SIZE_MISMATCH`, `ARCANE_AI_MODEL_DIGEST_MISMATCH` |
| Cache and storage | `ARCANE_AI_MODEL_CACHE_REJECTED`, `ARCANE_AI_MODEL_OFFLINE_MISS`, `ARCANE_AI_STORAGE_UNAVAILABLE`, `ARCANE_AI_STORAGE_READ_FAILED`, `ARCANE_AI_STORAGE_DELETE_FAILED` |
| Lifecycle | `ARCANE_AI_UNAVAILABLE`, `ARCANE_AI_NOT_READY`, `ARCANE_AI_MODEL_NOT_READY`, `ARCANE_AI_LOAD_FAILED`, `ARCANE_AI_UNLOAD_FAILED`, `ARCANE_AI_DISPOSE_FAILED`, `ARCANE_AI_DISPOSED`, `ARCANE_AI_OPERATION_SUPERSEDED`, `ARCANE_AI_SECURITY_RELOAD_REQUIRED` |
| Requests | `ARCANE_AI_REQUEST_ABORTED`, `ARCANE_AI_REQUEST_FAILED`, `ARCANE_AI_RUNTIME_BUSY`, `ARCANE_AI_INVALID_PROVIDER_RESULT`, `ARCANE_AI_LOCAL_ONLY_UNAVAILABLE`, `ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH` |
| Provider/2 adapter | `ARCANE_AI_MODEL_AUTHORITY_REQUIRED`, `ARCANE_AI_PROVIDER_ROLE_MISMATCH`, `ARCANE_AI_PROVIDER_PROGRESS_INVALID`, `ARCANE_AI_PROVIDER_STATUS_INVALID`, `ARCANE_AI_PROVIDER_OPERATION_UNAVAILABLE` |
| WebGPU and model admission | `ARCANE_AI_WEBGPU_REQUIRED`, `ARCANE_AI_WEBGPU_API_UNAVAILABLE`, `ARCANE_AI_WEBGPU_EVIDENCE_INVALID`, `ARCANE_AI_MODEL_FULL_OFFLOAD_UNPROVEN`, `ARCANE_AI_MODEL_WEBGPU_REQUIREMENT_FAILED`, `ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT`, `ARCANE_AI_MODEL_SHARD_TOO_LARGE`, `ARCANE_AI_MODEL_RELOAD_REQUIRED`, `ARCANE_AI_LOAD_PLAN_RELOAD_REQUIRED` |
| Worker cleanup and recovery | `ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED`, `ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED` |
| Diagnostics | `ARCANE_AI_PROBE_FAILED` |

Capability and status records also carry stable reason codes. These observations
are not all thrown errors: positive and unknown states let an application
explain why load is available, blocked, or not yet measured without guessing.

| Observation | Status/reason codes |
| --- | --- |
| Browser prerequisites | `ARCANE_AI_WEBASSEMBLY_UNAVAILABLE`, `ARCANE_AI_OPFS_UNAVAILABLE`, `ARCANE_AI_SECURE_CONTEXT_REQUIRED` |
| Model/storage sizing | `ARCANE_AI_MODEL_STORAGE_REQUIREMENT_UNBOUNDED`, `ARCANE_AI_MODEL_STORAGE_REQUIREMENT_UNKNOWN`, `ARCANE_AI_STORAGE_ESTIMATE_UNAVAILABLE`, `ARCANE_AI_STORAGE_ESTIMATE_FAILED`, `ARCANE_AI_STORAGE_ESTIMATE_INVALID`, `ARCANE_AI_STORAGE_NOT_MEASURED`, `ARCANE_AI_STORAGE_CAPACITY_INSUFFICIENT` |
| Positive cache/storage state | `ARCANE_AI_MODEL_CACHE_COMPLETE`, `ARCANE_AI_STORAGE_CAPACITY_AVAILABLE` |
| WebGPU execution evidence | `ARCANE_AI_WEBGPU_EXECUTION_OBSERVED`, `ARCANE_AI_WEBGPU_EXECUTION_UNOBSERVED` |
| Provider and runtime failure state | `ARCANE_AI_PROVIDER_UNAVAILABLE`, `ARCANE_AI_RUNTIME_FAILED` |

`capabilities()` reports browser observations such as WebAssembly, OPFS,
WebGPU API presence, admitted WebGPU operation, secure context, cross-origin
isolation, and hardware concurrency. `navigator.gpu` alone is not operational
evidence. The authoritative runtime can operate without cross-origin isolation,
so that flag is not a hard gate; secure context and WebGPU/full-offload evidence
are. `probe()` exercises packaged Wllama backend operations only while unloaded;
it neither admits nor downloads a model.

## BROWSER_WASM_RUNTIME_AUTHORITY

### Overview

Deep-frozen identity for the shipped browser runtime. Its protocol is
`arcane-ai-browser-wasm/2`; the direct provider uses
`arcane-ai-adapter/1` and `adaptV1LlmProvider()` projects it into
`arcane-ai-provider/2`. It records Wllama `3.6.0`, the embedded llama.cpp
revision, authenticated module/WASM byte lengths and SHA-256 values, licenses,
and the disabled compatibility-runtime and remote-model-helper policy.

### Value and import

```text
const BROWSER_WASM_RUNTIME_AUTHORITY
```

### Availability and normalization

**Browser metadata; safely inspectable without loading a model.** The value is
an immutable receipt, not a provider instance, model catalog, or capability
grant.

### Example

```javascript
import {BROWSER_WASM_RUNTIME_AUTHORITY} from 'arcane-os/ai/browser-wasm';

console.log(BROWSER_WASM_RUNTIME_AUTHORITY.protocol);
console.log(BROWSER_WASM_RUNTIME_AUTHORITY.package.version); // 3.6.0
```

## createArcaneAI()

### Overview

Creates the application-facing facade around a provider or an existing LLM
controller. Use this as the primary browser-local API; construct the source,
store, and Wllama provider beneath it.

### Signature and result

```text
createArcaneAI({ llm=null, provider=null, loadPolicy='on-demand', security }={})
```

At least one `llm` or `provider` is required; when both are supplied, `llm`
takes precedence. `loadPolicy` is `on-demand` or `manual`. The frozen result
contains `llm`, `runtime`, `createChatSession`, `status`, `load`,
`unload`, `probe`, `fetchRequest`, `streamRequest`, and `dispose`.
`security` is the app-level security configuration inherited by provider loads.
The SDK default is `secure:false`; `ai.load({security})` can override inherited
fields for that operation.

When `llm` is an existing `ModelController`, that controller keeps the security
and load policy with which it was created. This function
does not reapply its `loadPolicy` argument in that case, and supplying `security` alongside the
existing controller throws `TypeError`. Passing a provider instead creates a
new controller with the requested policy and security.

### Availability and normalization

**Browser.** It normalizes provider lifecycle and request observation without
selecting a model, changing browser permissions, contacting Arcane Core, or
creating a fallback provider.

### Example

```javascript
const ai = createArcaneAI({provider, loadPolicy:'manual'});
async function loadCachedModelAfterUserChoice() {
  const off = ai.llm.on('statechange', event => renderStatus(event.detail));
  try {
    return await ai.load({offline:true});
  } finally {
    off();
  }
}
```

`await ai.createChatSession(options)` dynamically creates a
[`PersistentAIChatSession`](../runtime-modules.md#persistentaichatsessionjs)
whose `chat` function is permanently bound to this controller. `options` must
be a plain object and must not contain `chat`; this prevents a session from
claiming the controller's lifecycle while sending its turns through another
provider.

## createBrowserModelSource()

### Overview

Validates a caller-owned canonical ordered multi-file descriptor and creates
the cancellable HTTPS download source accepted by this provider. A legacy
one-file descriptor normalizes to one ordered member.

### Signature and result

```text
createBrowserModelSource(descriptor, { fetchImpl=null }={})
```

The frozen source includes `kind`, the canonical descriptor fields,
`descriptor`, and `open(memberIndex,{signal})`. `open()` requires a member
index for multi-file sources and returns a readable response body,
requested/final URLs, reported byte length, and `cancel()`; it does not admit
bytes to the cache.

### Availability and normalization

**Browser Fetch with CORS.** URL and optional metadata syntax are normalized.
Expected length and SHA-256 are enforced only when their effective checks are
enabled for load.

### Example

```javascript
const source = createBrowserModelSource(MODEL);
console.log(source.id, source.files);
```

## createBrowserWasmLlmProvider()

### Overview

Creates the local-only Wllama provider from genuine source and store objects
created by this module. Structural lookalikes are rejected.

### Signature and result

```text
createBrowserWasmLlmProvider({ source, sources, store, loadDefaults={}, security, logger=console }={})
```

`sources` is a nonempty array of unique SDK-created model sources. Optional
legacy `source` identifies the default and must be one member of `sources`; when
`sources` is omitted, `source` supplies the one-model catalog. The frozen
result exposes protocol and provider identity, default model metadata,
`catalog`, `capabilities`, `status`, `load`, `unload`, `chat`, `stream`,
`streamChat`, `use`, `probe`, and `dispose`. Direct provider `load()` selects a
catalog model and returns `{model,status}`;
the facade `ai.load()` returns the flat controller status.
Provider `security` supplies the provider/model-binding scope. Direct
`provider.load({security})` and facade `ai.load({security})` supply the
operation scope.

### Availability and normalization

**Browser secure context with WebAssembly, OPFS/DBOPFS, WebGPU, and admitted
full-offload evidence.** Inference is local after a successful Wllama load.
The runtime forces `gpuLayers: 99999`; callers cannot select CPU or partial
offload. Status discloses effective checks, capability policy, storage/model
compatibility, and whether enabled integrity checks are pending, unchecked, or
verified.

### Example

```javascript
const provider = createBrowserWasmLlmProvider({
    sources:[source],
    store,
    loadDefaults:{threads:1, contextTokens:4096}
});
console.log(provider.status().state); // unloaded
```

## createDbopfsModelStore()

### Overview

Adapts an existing DBOPFS instance without renaming or replacing its public
methods. The adapter owns model-file, observed-byte, optional-check, and
completion-manifest behavior.

### Signature and result

```text
createDbopfsModelStore({ dbopfs, tableName='arcane_ai_browser_models', estimateStorage=null }={})
```

The optional `estimateStorage()` function supplies bounded storage evidence
when the browser's default estimator is unavailable or an application owns a
more precise quota view. The frozen result contains `kind`, `tableName`, the
original `adapter`, and `ready`, `openVerified`, `install`, `ensure`, and
`remove`. `ensure()` returns
`{files,file,manifest,observedBytes,integrity,cache}`: `files` preserves the
ordered model set, while the one-file compatibility field `file` is that sole
member or `null`. `cache` is `cached` or `installed`. `openVerified()` remains
a compatibility helper that requires both byte-length and SHA-256 verification.

### Availability and normalization

**Browser with a ready DBOPFS instance and OPFS.** A cache receipt reports only
the checks actually performed. Unchecked cache metadata is not integrity
evidence, and no cache receipt is a transferable capability token or proof of
model license rights.

### Example

```javascript
const store = createDbopfsModelStore({dbopfs});
async function verifyCachedModelAfterUserChoice() {
    await store.ready();
    const cached = await store.openVerified(source);
    console.log(cached ? 'verified cache' : 'cache miss');
}
```

## adaptV1LlmProvider()

### Overview

Projects one compatible admitted v1 browser-WASM provider into the same
provider/2 LLM role used by `AIProviderRuntime.js`. Admission checks the v1
protocol, required identity/methods, and local-only capability; it does not
establish SDK provenance for an arbitrary compatible object. The adapter does
not change the wrapped provider, download a model, execute a tool, or create a
fallback.

### Signature and result

```text
adaptV1LlmProvider(provider)
```

The frozen result exposes `{protocol:'arcane-ai-provider/2',role:'llm',id,
localOnly:true,catalog,inspect,status,load,request,unload,dispose}`. Inspection
returns `arcane-ai-model-authority/1` only for an exact catalog selection.
`request()` admits only `chat` and `stream` and preserves structural tool data.

### Availability and normalization

The adapter is available anywhere the caller can supply an admitted
`arcane-ai-browser-wasm/1` provider object. It performs only the versioned
provider-shape normalization into `arcane-ai-provider/2`; it does not create a
runtime, choose or download a model, grant host capability, change local-only
behavior, or make an arbitrary provider authoritative. Provider lifecycle,
cancellation, catalog selection, and failures remain owned by the wrapped
provider and are forwarded through the normalized role contract.

### Example

```javascript
import {adaptV1LlmProvider} from 'arcane-os/ai/browser-wasm';
import {getAIProviderRuntime} from 'arcane/AIProviderRuntime';

const runtime = getAIProviderRuntime();
const release = runtime.register(adaptV1LlmProvider(provider));
// Configure an exact llm route before load/use. Release registration at teardown.
release();
```

## Related reference

- [Canonical `createArcaneAI()` entry](../sdk-api.md#createarcaneai) and the
  sibling [`BROWSER_WASM_RUNTIME_AUTHORITY`](../sdk-api.md#browserwasmruntimeauthority),
  [`adaptV1LlmProvider()`](../sdk-api.md#adaptv1llmprovider),
  [`createBrowserModelSource()`](../sdk-api.md#createbrowsermodelsource),
  [`createBrowserWasmLlmProvider()`](../sdk-api.md#createbrowserwasmllmprovider),
  and [`createDbopfsModelStore()`](../sdk-api.md#createdbopfsmodelstore) entries
- [Browser-local normalization boundary](../availability-and-normalization.md#browser-local-provider-adapter)
- [Authenticated browser runtime delivery](../protocols.md#browser-runtime-delivery)
- [Browser-WASM behavior evidence](../behavioral-testing.md#behavioral-coverage-model)
- [DBOPFS runtime module](../runtime-modules.md#dbopfsjs)
- [Browser speech providers](browser-speech.md)
- [Provider-neutral AI runtime](../runtime-modules.md#aiproviderruntimejs)
- [Persistent chat](../runtime-modules.md#persistentaichatsessionjs)
