# Browser-WASM local AI

Use this browser-only entrypoint when an application deliberately owns a local
GGUF model authority and wants provider-neutral LLM lifecycle, chat, streaming,
cancellation, and structural tool-call results without an Arcane Core host.
For ordinary hosted applications, start with the [Arcane AI
contracts](../core/arcane-ai-contracts.md) and `globalThis.Arcane.ai`. This
page is the focused local-browser path beneath the normalized AI decision
guide.

The wiring example assumes a scaffolded or materialized Arcane application
using the current checkout's runtime tree and browser import map.
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

const MODEL = {
    id:'my-reviewed-model',
    files:[{
        name:'model-q4-00001-of-00002.gguf',
        url:'https://models.example/revisions/4f7c/model-q4-00001-of-00002.gguf'
    },{
        name:'model-q4-00002-of-00002.gguf',
        url:'https://models.example/revisions/4f7c/model-q4-00002-of-00002.gguf'
    }]
};

const dbopfs = globalThis.dbopfs || new DBOPFS({applicationId:'my-app'});
await dbopfs.readyPromise;
const source = createBrowserModelSource(MODEL);
const store = createDbopfsModelStore({dbopfs});
const provider = createBrowserWasmLlmProvider({source, store});
const ai = createArcaneAI({
    provider,
    loadPolicy:'manual'
});

// Put this behind an explicit user action: it can download every declared file.
async function loadReviewedModel() {
    return ai.load({threads:1, contextTokens:4096});
}
```

The browser-WASM runtime closure packages the upstream
`@wllama/wllama` `3.6.0` ESM and WebAssembly runtime plus the Wllama and
llama.cpp MIT license texts. It
packages no model weights, default model catalog, CDN fallback, native
provider, speech synthesis, or transcription. The sibling
[`arcane-os/ai/browser-speech`](browser-speech.md) entrypoint supplies speech
provider mechanisms but still no runtime/model content. Callers supply every
model source. Each file needs only a name and HTTPS URL. A positive optional
`bytes` value supplies observational progress and transport-planning metadata;
it never validates, admits, identifies, or decides cache reuse for content.

## Lifecycle at a glance

`createArcaneAI()` owns one LLM controller. Its default `loadPolicy` is
`on-demand`; the first request may download and initialize the model. Use
`manual` when a user action, resource review, or progress UI must precede load.

| Operation | Result |
| --- | --- |
| `ai.status()` | Mutable `{llm: status}` snapshot. |
| `ai.load(options)` | Flat LLM status after load. |
| `ai.llm.chat(request)` / `ai.fetchRequest(request)` | Validated OpenAI-like completion. |
| `ai.llm.stream(request)` | Mutable async-iterator handle with `result` and `cancel(reason)`. |
| `ai.streamRequest(request)` | Consumes the stream, publishes every choice's ordinary content/reasoning in provider order, and returns complete JSON text for a multi-choice terminal completion, one structural-call array for selected tool output, or ordinary single-choice text. |
| `ai.createChatSession(options)` | Asynchronously resolves `Promise<PersistentAIChatSession>` bound to this exact controller; caller-supplied `chat` is rejected. |
| `ai.unload()` | Cancels active work, releases the Wllama session, and returns flat unloaded status; the DBOPFS cache remains. |
| `ai.dispose()` | Permanently disposes the controller; explicit `store.remove(source)` is required to delete cached model content. |

The controller emits `statechange` and `progress` through
`addEventListener()`, `removeEventListener()`, or `on()`. Event `detail` is the
current mutable status snapshot. Provider states are `unloaded`, `loading`, `ready`,
`unloading`, and `error`.

Browser-WASM model loads report `cache-check`, `download`, and `initialize`
phases. Download records preserve the ordered model-file fields `completed`,
`total`, and `unit:'files'`. They add `loadedBytes`, `totalBytes`,
`remainingBytes`, `bytesPerSecond`, `etaSeconds`, `activeTransfers`,
`transferLimit`, and `transferMode`. `loadedBytes` is aggregate downloaded or
restored progress for the current install. Active partial writes count while
they are staged, then are removed from that total if their transfer fails;
completed shards or Range parts reused from an interrupted attempt remain
counted. Unknown totals, remaining counts, rates, and ETAs are `null`;
once known, byte values and seconds are nonnegative numbers. `activeTransfers`
is the current transfer-worker count, `transferLimit` is the selected concurrency
bound, and `transferMode` identifies `probing`, `files`, `ranges`, or `single`.
The store coalesces chunk-driven changes on a 250 ms cadence and publishes
immediately when download starts, the transfer plan or total becomes known,
active-worker count changes, and the download completes. At known completion, remaining bytes and ETA are zero
and active transfers are zero. Applications format the raw measures into B,
KB, MB, GB, transfer-rate, and duration labels.

While a load remains active, the provider also repeats its current record every
five seconds with `heartbeat:true` and an updated `elapsedMs`. A heartbeat
confirms that the owned operation is still active; it does not invent
additional transferred content.

The DBOPFS store uses one bounded transfer axis. Ordered multi-file GGUF sets
download several members concurrently and preserve completed shards across a
retry. Each active member negotiates HTTP Range support. A split member uses at
most one Range worker while a one-file source may use up to
`downloadConcurrency` Range workers (four by default), so file and Range
workers are never multiplied. A usable total from `Content-Range` or the
optional descriptor `bytes` divides that member into up to 16 deterministic
contiguous parts. Each exact completed part is committed separately in OPFS,
so retry fetches only missing parts; the ordered parts are exposed to Wllama as
one logical model Blob. Range offsets remain transport-local; only aggregate
transfer telemetry is public.

## Model selection, optional hardening, and cache

The canonical model descriptor is
`{id, files:[{name?,url,bytes?},...]}`. The ordered `files` array is nonempty;
names and URLs are unique. Each URL must be absolute HTTPS without credentials
or a fragment. An optional positive safe-integer `bytes` value is used only for
progress and HTTP Range planning. Missing or unusable metadata never blocks a
download, and a declared value is not a content-length check. The legacy
one-file `{id,url,bytes?}` shape remains accepted and normalizes to one ordered
member.

Fetch follows HTTPS redirects and records the requested and final HTTPS URL. A
redirect that leaves HTTPS is rejected as an unavoidable transport-safety
boundary.

App, provider/model-binding, and load-operation options may use the same
plain-JavaScript shape:

```javascript
{security:{secure:true}}
```

The SDK default is `secure:false`. Omitted security leaves ordinary model
loading fully functional. `secure:true` records only an
application-selected hardening intent in this development contract. It does
not activate the historical checking machinery; that implementation remains
disabled and requires a separate review with the user before it can run.
Neither path performs byte-limit, hash, digest, content-identity, freeze, or
admission work. Observational byte counting and exact HTTP Range framing remain
transport-local. A load succeeds only after Wllama reports that the model is
loaded.

The DBOPFS adapter commits each complete member or Range part independently and
exposes only a complete ordered model set as a cache hit.
`load({offline:true})` never performs a model request; it uses a compatible
cached entry or rejects with `ARCANE_AI_MODEL_OFFLINE_MISS`.

```javascript
const {security, cache} = ai.status().llm;
console.log(security.secure); // false unless explicitly selected
console.log(cache);
```

For one-file compatibility, older descriptors can supply `immutableUrl` as the
URL alias and `name` as a cache-filename hint. If both `url` and
`immutableUrl` are present, they must match. Legacy `licenseSpdx` and
`sourceRevision` properties are not canonical descriptor fields. Applications
remain responsible for model selection and license compliance.

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
        messages:[{role:'user', content:'Summarize this text.'}]
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
and seed. Load settings separately include
`contextTokens`, `batchTokens`, `microBatchTokens`, `threads`, and GPU-layer
count. The shipped runtime always sets `gpuLayers: 99999`: WebGPU and proved
full offload are mandatory, and there is no CPU fallback. Secure context and
WebGPU/full-offload availability remain browser platform requirements;
cross-origin isolation and coarse hardware fields remain observations.

Tool definitions, tool choice, parallel-tool-call preference, and JSON or JSON
Schema structured-output requests are passed to Wllama. Returned tool calls are
validated and surfaced as structural data. Every function declaration requires
`parameters.properties.message` with `{type:'string',minLength:1}` and includes
`message` in its `required` list. Every emitted argument JSON object contains
that nonempty user-facing progress or next-step text; exact IDs, names, and
argument strings remain intact. The SDK never invokes a handler or executes a
tool. Application code chooses whether to execute, then records the exact
matching executed, declined, cancelled, or not-executed `role:'tool'` result
with nonblank user-facing content before another user turn. High-level sessions accept per-turn request options,
so visibility-only consumers can select `toolChoice:'none'` for the continuation
after a not-executed result without calling Wllama directly. Streaming sessions
buffer a structural call until its exact ID, type, name, and argument string
match the terminal response; omission or divergence rejects with
`AI_CHAT_STREAM_TOOL_CALL_MISMATCH` before the call is published or persisted.
Ordinary iteration exposes only text/reasoning chunks; raw structural deltas
remain internal until the complete terminal result validates. Explicit
`onResponse` or inspection consumers retain the complete raw terminal response.

## Errors and unavailable states

Invalid configuration can throw `TypeError` or `RangeError`. Operational
failures expose a stable `.code`; the internal error class is not exported.
Handle the narrow code needed by the current operation and treat other failures
as unavailable.

| Area | Stable codes |
| --- | --- |
| Source and download | `ARCANE_AI_MODEL_SOURCE_INVALID`, `ARCANE_AI_MODEL_SOURCE_UNAVAILABLE`, `ARCANE_AI_MODEL_DOWNLOAD_FAILED`, `ARCANE_AI_MODEL_REDIRECT_BLOCKED` |
| Cache and storage | `ARCANE_AI_MODEL_CACHE_REJECTED`, `ARCANE_AI_MODEL_OFFLINE_MISS`, `ARCANE_AI_STORAGE_UNAVAILABLE`, `ARCANE_AI_STORAGE_READ_FAILED`, `ARCANE_AI_STORAGE_DELETE_FAILED` |
| Lifecycle | `ARCANE_AI_UNAVAILABLE`, `ARCANE_AI_NOT_READY`, `ARCANE_AI_MODEL_NOT_READY`, `ARCANE_AI_LOAD_FAILED`, `ARCANE_AI_UNLOAD_FAILED`, `ARCANE_AI_DISPOSE_FAILED`, `ARCANE_AI_DISPOSED`, `ARCANE_AI_OPERATION_SUPERSEDED` |
| Requests | `ARCANE_AI_REQUEST_ABORTED`, `ARCANE_AI_REQUEST_FAILED`, `ARCANE_AI_RUNTIME_BUSY`, `ARCANE_AI_INVALID_PROVIDER_RESULT`, `ARCANE_AI_TOOL_CALL_INVALID`, `ARCANE_AI_TOOL_MESSAGE_REQUIRED`, `ARCANE_AI_INVALID_TOOL_MESSAGE`, `ARCANE_AI_TOOL_RESULT_REQUIRED`, `ARCANE_AI_LOCAL_ONLY_UNAVAILABLE`, `ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH` |
| Persistent sessions | `AI_CHAT_INVALID_TOOL_CALL`, `AI_CHAT_INVALID_TOOL_MESSAGE`, `AI_CHAT_TOOL_MESSAGE_REQUIRED`, `AI_CHAT_TOOL_RESULT_REQUIRED`, `AI_CHAT_INCOHERENT_PERSISTENCE`, `AI_CHAT_STREAM_TOOL_CALL_MISMATCH`, `AI_CHAT_TRANSACTION_SETTLED` |
| Provider/2 adapter | `ARCANE_AI_MODEL_AUTHORITY_REQUIRED`, `ARCANE_AI_PROVIDER_ROLE_MISMATCH`, `ARCANE_AI_PROVIDER_PROGRESS_INVALID`, `ARCANE_AI_PROVIDER_STATUS_INVALID`, `ARCANE_AI_PROVIDER_OPERATION_UNAVAILABLE` |
| WebGPU and model availability | `ARCANE_AI_WEBGPU_REQUIRED`, `ARCANE_AI_WEBGPU_API_UNAVAILABLE`, `ARCANE_AI_WEBGPU_EVIDENCE_INVALID`, `ARCANE_AI_MODEL_FULL_OFFLOAD_UNPROVEN`, `ARCANE_AI_MODEL_WEBGPU_REQUIREMENT_FAILED`, `ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT`, `ARCANE_AI_MODEL_RELOAD_REQUIRED`, `ARCANE_AI_LOAD_PLAN_RELOAD_REQUIRED` |
| Worker cleanup and recovery | `ARCANE_AI_WORKER_TERMINATION_UNCONFIRMED`, `ARCANE_AI_COMPLETION_RECOVERY_UNCONFIRMED` |
| Diagnostics | `ARCANE_AI_PROBE_FAILED` |

Capability and status records also carry stable reason codes. These observations
are not all thrown errors: positive and unknown states let an application
explain why load is available, blocked, or not yet measured without guessing.

| Observation | Status/reason codes |
| --- | --- |
| Browser prerequisites | `ARCANE_AI_WEBASSEMBLY_UNAVAILABLE`, `ARCANE_AI_OPFS_UNAVAILABLE`, `ARCANE_AI_SECURE_CONTEXT_REQUIRED` |
| Positive cache/storage state | `ARCANE_AI_MODEL_CACHE_COMPLETE`, `ARCANE_AI_STORAGE_CAPACITY_AVAILABLE` |
| WebGPU execution evidence | `ARCANE_AI_WEBGPU_EXECUTION_OBSERVED`, `ARCANE_AI_WEBGPU_EXECUTION_UNOBSERVED` |
| Provider and runtime failure state | `ARCANE_AI_PROVIDER_UNAVAILABLE`, `ARCANE_AI_RUNTIME_FAILED` |

`capabilities()` reports browser observations such as WebAssembly, OPFS,
WebGPU API presence, WebGPU operation, secure context, cross-origin
isolation, and hardware concurrency. `navigator.gpu` alone is not operational
evidence. The authoritative runtime can operate without cross-origin isolation,
so that flag is not a hard gate; secure context and WebGPU/full-offload support
are platform requirements. `probe()` exercises packaged Wllama backend
operations only while unloaded; it does not download a model.

## BROWSER_WASM_RUNTIME_AUTHORITY

### Overview

Mutable metadata for the shipped browser runtime. Its protocol is
`arcane-ai-browser-wasm/2`; the direct provider uses
`arcane-ai-adapter/1` and `adaptV1LlmProvider()` projects it into
`arcane-ai-provider/2`. It records Wllama `3.6.0`, the embedded llama.cpp
revision, licenses, and the disabled compatibility-runtime and
remote-model-helper policy.

### Value and import

```text
const BROWSER_WASM_RUNTIME_AUTHORITY
```

### Availability and normalization

**Browser metadata; safely inspectable without loading a model.** The value is
metadata, not a provider instance, model catalog, or capability grant.

### Example

```javascript
import {BROWSER_WASM_RUNTIME_AUTHORITY} from 'arcane-os/ai/browser-wasm';

console.log(BROWSER_WASM_RUNTIME_AUTHORITY.protocol);
console.log(BROWSER_WASM_RUNTIME_AUTHORITY.package.version); // 3.6.0
```

## completeValueText()

### Overview

Returns complete caller content as text. Strings are returned unchanged;
supported non-string values become readable JSON text. Cycles use `$ref`
records, and special primitives, maps, sets, dates, regular expressions,
functions, symbols, typed views, array buffers, and accessors retain explicit
representations.

### Signature and result

```text
completeValueText(value)
```

The function returns one complete string. It reads ordinary data descriptors
without invoking accessors and records repeated object references by their
first traversal location.

### Availability and normalization

**Compatible JavaScript module host.** This is a pure value-to-text helper. It
does not require a provider, model, cache, storage, WebAssembly, or browser
capability.

### Example

```javascript
import {completeValueText} from 'arcane-os/ai/browser-wasm';

const status = new Map([
    ['state','ready'],
    ['roles',new Set(['llm'])]
]);
console.log(completeValueText(status));
```

## createArcaneAI()

### Overview

Creates the application-facing AI API module around a provider or an existing
LLM controller. Use this as the primary browser-local API; construct the source,
store, and Wllama provider beneath it.

### Signature and result

```text
createArcaneAI({ llm=null, provider=null, loadPolicy='on-demand', security }={})
```

At least one `llm` or `provider` is required; when both are supplied, `llm`
takes precedence. `loadPolicy` is `on-demand` or `manual`. The mutable result
contains `llm`, `runtime`, `createChatSession`, `status`, `load`,
`unload`, `probe`, `fetchRequest`, `streamRequest`, and `dispose`.
`security` carries only the app-level boolean `secure` intent inherited by
provider loads. The SDK default is `secure:false`; `ai.load({security})` can
override that intent for the operation, but no checking implementation runs
until a separately authorized review enables one.

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
whose AI API is permanently bound to this controller. `options` must
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

The mutable source includes `kind`, the canonical descriptor fields,
`descriptor`, and `open(memberIndex,{signal})`. `open()` requires a member
index for multi-file sources and returns the complete readable response body,
requested/final URLs, nullable observed `contentLength`, and `cancel()`; caching
and the store's private per-member Range negotiation remain store-owned.

### Availability and normalization

**Browser Fetch with CORS.** URL and optional metadata syntax are normalized.
Declared and observed lengths feed only progress and transport planning.
Ordinary source loading performs no expected-length, hash, digest, receipt,
freeze, content-identity, admission, or cache-reuse checks.

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
`sources` is omitted, `source` supplies the one-model catalog. The mutable
result exposes protocol and provider identity, default model metadata,
`catalog`, `capabilities`, `status`, `load`, `unload`, `chat`, `stream`,
`streamChat`, `use`, `probe`, and `dispose`. Direct provider `load()` selects a
catalog model and returns `{model,status}`;
the public AI API module's `ai.load()` returns the flat controller status.
Direct `load({onProgress})` forwards the same additive file and byte progress
records used by the controller and provider/2 adapter.
Provider `security` carries the provider/model-binding `secure` intent. Direct
`provider.load({security})` and `ai.load({security})` supply the operation
intent. They do not activate checking in the ordinary development contract.

### Availability and normalization

**Browser secure context with WebAssembly, OPFS/DBOPFS, WebGPU, and full-offload
support.** Inference is local after a successful Wllama load.
The runtime forces `gpuLayers: 99999`; callers cannot select CPU or partial
offload. Status discloses the optional `secure` intent, capability state,
storage/model compatibility, and lifecycle state; it does not claim that
hardening ran.

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
methods. The adapter owns model-file, cache, and completion behavior.

### Signature and result

```text
createDbopfsModelStore({ dbopfs, tableName='arcane_ai_browser_models', estimateStorage=null, downloadConcurrency=4 }={})
```

The optional `estimateStorage()` function supplies browser storage availability
when the default estimator is unavailable or an application owns a more precise
quota view. `downloadConcurrency` must be a positive safe integer and bounds
the selected file or Range worker pool; the default is four. The mutable result
contains `kind`, `tableName`, `downloadConcurrency`, the original `adapter`,
and `ready`, `install`, `ensure`, and `remove`. `ensure()` preserves the complete
ordered model set and reports whether it was cached or installed.
`install(source,{signal,onProgress})` and
`ensure(source,{signal,onProgress,offline})` publish `cache-check` and
`download` records using ordered file counts plus aggregate transfer telemetry
when `onProgress` is supplied. Chunk-driven changes are coalesced on a 250 ms
cadence, with immediate boundary records at start, plan/total discovery,
active-worker changes, and completion. Multi-file sources use up to that many concurrent member workers
while retaining descriptor order, preserve completed members and completed
Range parts within members across an interrupted attempt, and fetch only
missing work on retry. A complete set of optional member
`bytes` values makes aggregate total and remaining progress available from the
start; otherwise those fields remain `null` until an honest aggregate total is
known. Each missing source member first requests `bytes=0-0`. If a followed
redirect turns that probe into a full `200`, the source probes the final URL directly;
confirmed support cancels the original body and starts parallel Range workers,
while refusal keeps the original full response as the single-fetch fallback. A
valid `Content-Range`, or optional descriptor `bytes` when that header is not
exposed, supplies the total for up to 16 deterministic resumable Range parts. Without
an observable or declared total, the store falls back to one full fetch and
uses its readable `Content-Length` when available. A later non-206,
contradictory exposed Range response, or incorrectly framed Range body fails
rather than silently assembling a partial model. Failure or cancellation
aborts peer transfers and waits for them to settle while preserving already
completed members and exact Range parts for retry. A zero-length current whole
entry or incomplete current Range set cannot shadow a complete legacy cache;
the complete legacy file is reused and the store attempts to remove abandoned
replacement fragments. After
a replacement completes, the store attempts to remove its exact legacy
duplicate. A complete whole member similarly supersedes its Range fragments.
Cleanup failure is warned without replacing a usable model. Zero-length abandoned entries are removed
because Wllama cannot consume an empty model Blob or File.

### Availability and normalization

**Browser with a ready DBOPFS instance and OPFS.** Cache metadata is not a
transferable capability token or proof of model license rights.

### Example

```javascript
const store = createDbopfsModelStore({dbopfs});
async function loadCachedModelAfterUserChoice() {
    await store.ready();
    const cached = await store.ensure(source,{offline:true});
    console.log(cached ? 'cached model' : 'cache miss');
}
```

## adaptV1LlmProvider()

### Overview

Projects one compatible v1 browser-WASM provider into the same provider/2 LLM
role used by `AIProviderRuntime.js`. It checks the v1 protocol, required methods,
and local-only capability. The adapter does
not change the wrapped provider, download a model, execute a tool, or create a
fallback.

### Signature and result

```text
adaptV1LlmProvider(provider)
```

The mutable result exposes `{protocol:'arcane-ai-provider/2',role:'llm',id,
localOnly:true,catalog,inspect,status,load,request,unload,dispose}`. Inspection
returns `arcane-ai-model-authority/1` only for an exact catalog selection.
`request()` supports `chat` and `stream` and preserves structural tool data.
Both operations validate request history and tool declarations before provider
dispatch, then validate every terminal choice and required nonempty
`arguments.message`. The adapter drains the private provider stream regardless
of whether the consumer iterates first or awaits `result` first. Its ordinary
iterator receives complete nonstructural content/reasoning projections from
every choice in FIFO order, while structural deltas remain private until the
complete terminal `result` validates. A terminal-only structural call is valid;
any call observed during streaming must preserve its choice, ordered position,
ID, type, name, exact argument string, and extension fields in the terminal
envelope. Consumer `return()` starts observed provider cancellation immediately
and completes the iterator return without waiting for provider cleanup. The
terminal `result` retains provider settlement, and a later
cancellation/iterator-return failure is reported completely to the developer
console.

### Availability and normalization

The adapter is available anywhere the caller can supply a compatible
`arcane-ai-browser-wasm/1` provider object. It performs only the versioned
provider-shape normalization into `arcane-ai-provider/2`. The v1 ingress,
terminal result, cancellation, and ordinary iterator projection use the same
structural-message contract; the wrapper does not create a
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
  [`completeValueText()`](../sdk-api.md#completevaluetext),
  [`createBrowserModelSource()`](../sdk-api.md#createbrowsermodelsource),
  [`createBrowserWasmLlmProvider()`](../sdk-api.md#createbrowserwasmllmprovider),
  and [`createDbopfsModelStore()`](../sdk-api.md#createdbopfsmodelstore) entries
- [Browser-local normalization boundary](../availability-and-normalization.md#browser-local-provider-adapter)
- [Browser runtime delivery](../protocols.md#browser-runtime-delivery)
- [Browser-WASM behavior evidence](../behavioral-testing.md#behavioral-coverage-model)
- [DBOPFS runtime module](../runtime-modules.md#dbopfsjs)
- [Browser speech providers](browser-speech.md)
- [Provider-neutral AI runtime](../runtime-modules.md#aiproviderruntimejs)
- [Persistent chat](../runtime-modules.md#persistentaichatsessionjs)
