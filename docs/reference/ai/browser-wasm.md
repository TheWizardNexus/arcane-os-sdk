# Browser-WASM local AI

Use this browser-only entrypoint when an application deliberately owns a local
GGUF model authority and wants provider-neutral LLM lifecycle, chat, streaming,
cancellation, and structural tool-call results without an Arcane Core host.
For ordinary hosted applications, start with the [Arcane AI
contracts](../core/arcane-ai-contracts.md) and `globalThis.Arcane.ai`. This
page is the focused local-browser path beneath the normalized AI decision
guide.

The wiring example assumes a scaffolded or materialized Arcane application
with SDK `0.1.2`'s authenticated runtime tree and 86-entry browser import map.
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
    url:'https://models.example/revisions/4f7c/model-q4.gguf',
    bytes:123456789,
    sha256:'0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
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

// Put this behind an explicit user action: it can download MODEL.bytes bytes.
async function loadReviewedModel() {
    return ai.load({threads:1, contextTokens:4096, gpuLayers:0});
}
```

The browser-WASM runtime closure packages the authenticated
`@wllama/wllama` `3.6.0` ESM and WebAssembly runtime plus the Wllama and
llama.cpp MIT license texts. It
packages no model weights, model catalog, CDN fallback, native provider, speech
synthesis, or transcription. Callers supply the exact model authority. `bytes`
is an optional expected positive byte length, not inline model data.

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
| `ai.unload()` | Cancels active work, releases the Wllama session, and returns flat unloaded status; the DBOPFS cache remains. |
| `ai.dispose()` | Permanently disposes the controller; explicit `store.remove(source)` is required to delete cached model bytes. |

The controller emits `statechange` and `progress` through
`addEventListener()`, `removeEventListener()`, or `on()`. Event `detail` is the
current frozen status. Provider states are `unloaded`, `loading`, `ready`,
`unloading`, and `error`.

## Model authority, security, and cache admission

The canonical model descriptor is `{id, url, bytes?, sha256?}`. `id` and `url`
are required. The URL must be absolute HTTPS without credentials or a fragment;
revision-floating `main`, `master`, and `latest` path segments are rejected.
When supplied, `bytes` is a positive safe integer and `sha256` is exactly 64
hexadecimal characters.

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
it with an expected size. The store still counts and records the observed byte
length for storage and progress metadata on every install and cache reuse.

An enabled SHA-256 check requires descriptor `sha256` and hashes the actual
stored or cached file. A disabled SHA-256 check permits `sha256` to be absent
and does not hash or reread a multi-gigabyte model solely to produce a digest.
Only enabled checks fail closed. Regardless of optional integrity checks, a
load succeeds only after Wllama reports that the model is loaded.

The DBOPFS adapter commits an `arcane.ai.browser-wasm.model.v3` completion
manifest with the observed byte length. Status reports the effective
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

For compatibility, older descriptors can supply `immutableUrl` as the URL alias
and `name` as a cache-filename hint. If both `url` and `immutableUrl` are
present, they must match. Legacy `licenseSpdx` and `sourceRevision` properties
are not canonical descriptor fields or runtime admission checks; applications
remain responsible for model selection, provenance, and license compliance.
Version-2 cache manifests can be migrated to version 3 when their model identity
matches, without inventing an integrity result.

`localOnly:true` describes inference after load. It does not mean a cache miss
cannot download. Source downloads use CORS, omit credentials and referrer,
disable HTTP caching, and honor `AbortSignal`.

## Streaming, cancellation, and tools

```javascript
const abort = new AbortController();
const stream = ai.llm.stream({
    localOnly:true,
    signal:abort.signal,
    messages:[{role:'user', content:'Summarize this text.'}],
    maxTokens:128
});

const cancelButton = document.querySelector('[data-cancel-local-ai]');
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
```

An active cancellation rejects as `ARCANE_AI_REQUEST_ABORTED`. Requests are
serialized; provider status exposes `busy` and `queued`. Supported request
generation fields include temperature, top-K, top-P, min-P, repeat penalty,
maximum tokens, seed, and stop sequences. Load settings separately include
`contextTokens`, `batchTokens`, `microBatchTokens`, `threads`, and GPU-layer
count. WebGPU is optional; cross-origin isolation and hardware fields are
observations, not readiness promises.

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
| Lifecycle | `ARCANE_AI_UNAVAILABLE`, `ARCANE_AI_NOT_READY`, `ARCANE_AI_LOAD_FAILED`, `ARCANE_AI_UNLOAD_FAILED`, `ARCANE_AI_DISPOSE_FAILED`, `ARCANE_AI_DISPOSED`, `ARCANE_AI_OPERATION_SUPERSEDED`, `ARCANE_AI_SECURITY_RELOAD_REQUIRED` |
| Requests | `ARCANE_AI_REQUEST_ABORTED`, `ARCANE_AI_REQUEST_FAILED`, `ARCANE_AI_INVALID_PROVIDER_RESULT`, `ARCANE_AI_LOCAL_ONLY_UNAVAILABLE`, `ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH` |
| Diagnostics | `ARCANE_AI_PROBE_FAILED` |

`capabilities()` reports browser observations such as WebAssembly, OPFS,
WebGPU, secure context, cross-origin isolation, and hardware concurrency.
Feature-detect them. The authoritative Chrome behavior passes without
cross-origin isolation, so that flag is not a hard gate. `probe()` exercises
packaged Wllama backend operations only while unloaded; it neither admits nor
downloads a model.

## BROWSER_WASM_RUNTIME_AUTHORITY

### Overview

Deep-frozen identity for the shipped browser runtime. Its protocol is
`arcane-ai-browser-wasm/2`; the provider adapter uses
`arcane-ai-adapter/1`. It records Wllama `3.6.0`, the embedded llama.cpp
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
contains `llm`, `runtime`, `status`, `load`,
`unload`, `probe`, `fetchRequest`, `streamRequest`, and `dispose`.
`security` is the app-level security configuration inherited by provider loads.
The SDK default is `secure:false`; `ai.load({security})` can override inherited
fields for that operation.

### Availability and normalization

**Browser.** It normalizes provider lifecycle and request observation without
selecting a model, changing browser permissions, contacting Arcane Core, or
creating a fallback provider.

### Example

```javascript
const ai = createArcaneAI({provider, loadPolicy:'manual'});
const off = ai.llm.on('statechange', event => renderStatus(event.detail));
await ai.load({offline:true});
off();
```

## createBrowserModelSource()

### Overview

Validates a caller-owned canonical `{id, url, bytes?, sha256?}` descriptor and
creates the one cancellable HTTPS download source accepted by this provider.

### Signature and result

```text
createBrowserModelSource(descriptor, { fetchImpl=null }={})
```

The frozen source includes `kind`, the canonical descriptor fields,
`descriptor`, and `open({signal})`. `open()` returns a readable response body,
requested/final URLs, and `cancel()`; it does not admit bytes to the cache.

### Availability and normalization

**Browser Fetch with CORS.** URL and optional metadata syntax are normalized.
Expected length and SHA-256 are enforced only when their effective checks are
enabled for load.

### Example

```javascript
const source = createBrowserModelSource(MODEL);
console.log(source.id, source.bytes, source.sha256);
```

## createBrowserWasmLlmProvider()

### Overview

Creates the local-only Wllama provider from genuine source and store objects
created by this module. Structural lookalikes are rejected.

### Signature and result

```text
createBrowserWasmLlmProvider({ source, store, loadDefaults={}, security, logger=console }={})
```

The frozen result exposes protocol and provider identity, model metadata,
`capabilities`, `status`, `load`, `unload`, `chat`, `stream`, `streamChat`,
`use`, `probe`, and `dispose`. Direct provider `load()` returns `{model,status}`;
the facade `ai.load()` returns the flat controller status.
Provider `security` supplies the provider/model-binding scope. Direct
`provider.load({security})` and facade `ai.load({security})` supply the
operation scope.

### Availability and normalization

**Browser with WebAssembly and DBOPFS model bytes.** Inference is local after a
successful Wllama load. WebGPU is optional and defaults to zero GPU layers
unless the caller selects otherwise. Status discloses effective checks and
whether enabled integrity checks are pending, unchecked, or verified.

### Example

```javascript
const provider = createBrowserWasmLlmProvider({
    source,
    store,
    loadDefaults:{threads:1, contextTokens:4096, gpuLayers:0}
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
createDbopfsModelStore({ dbopfs, tableName='arcane_ai_browser_models' }={})
```

The frozen result contains `kind`, `tableName`, the original `adapter`, and
`ready`, `openVerified`, `install`, `ensure`, and `remove`. `ensure()` returns a
file, completion manifest, observed byte count, integrity detail, and cache state
`cached` or `installed`. `openVerified()` remains a compatibility helper that
requires both byte-length and SHA-256 verification.

### Availability and normalization

**Browser with a ready DBOPFS instance and OPFS.** A cache receipt reports only
the checks actually performed. Unchecked cache metadata is not integrity
evidence, and no cache receipt is a transferable capability token or proof of
model license rights.

### Example

```javascript
const store = createDbopfsModelStore({dbopfs});
await store.ready();
const cached = await store.openVerified(source);
console.log(cached ? 'verified cache' : 'cache miss');
```

## Related reference

- [Canonical `createArcaneAI()` entry](../sdk-api.md#createarcaneai) and the
  sibling [`BROWSER_WASM_RUNTIME_AUTHORITY`](../sdk-api.md#browserwasmruntimeauthority),
  [`createBrowserModelSource()`](../sdk-api.md#createbrowsermodelsource),
  [`createBrowserWasmLlmProvider()`](../sdk-api.md#createbrowserwasmllmprovider),
  and [`createDbopfsModelStore()`](../sdk-api.md#createdbopfsmodelstore) entries
- [Browser-local normalization boundary](../availability-and-normalization.md#browser-local-provider-adapter)
- [Authenticated browser runtime delivery](../protocols.md#browser-runtime-delivery)
- [Browser-WASM behavior evidence](../behavioral-testing.md#behavioral-coverage-model)
- [DBOPFS runtime module](../runtime-modules.md#dbopfsjs)
