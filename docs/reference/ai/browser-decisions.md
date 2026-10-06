# Browser typed decisions

`arcane-os/ai/browser-decisions` owns browser-local Laya typed decisions
and Julia-1 inference. Laya defaults to FP16 and Julia to FP32; an explicit
`dtype` is forwarded unchanged to the selected upstream loader. It is separate from chat and speech because these
models score caller-supplied options instead of generating conversational text.
Applications supply the model repository, state, questions, option meanings and
policy; the SDK owns the reusable tokenizer, tensors, inference and lifecycle.

## Explicit use

```js
import {createBrowserDecisionModel} from 'arcane-os/ai/browser-decisions';

const model = createBrowserDecisionModel(
    {
        family: 'laya',
        model: 'onnx-community/laya-typed-decisions-ONNX',
        revision: 'main',
        device: 'webgpu'
    }
);

const unsubscribe = model.subscribe(
    function showModelStatus(state) {
        status.textContent = state.progress?.phase ?? state.state;
    }
);

runButton.addEventListener(
    'click',
    async function decideDragonTea() {
        try {
            const result = await model.evaluate(
                [
                    {
                        state: 'A sleeping dragon blocks the kitchen. The kettle whistles.',
                        question: 'What should the tea robot do?',
                        options: ['Wait quietly', 'Boil the kettle']
                    }
                ]
            );
            output.textContent = result.decisions[0].value;
        } catch (error) {
            console.error('The decision request failed.', error);
            status.textContent = 'The decision could not be completed.';
        }
    }
);
```

Here `status`, `runButton` and `output` are application DOM elements. Changing
the state, question or options changes the actual model request. Importing the
module and constructing the client start no Worker or download. Only explicit
`load()` or `evaluate()` use loads the selected runtime and model. Concurrent
requests share the same activation; ready inference reuses that model session.

For Julia, select `family: 'julia'` and
`model: 'SupersonicLabs/Julia-1-ONNX'`. This selects the official FP32 graph;
it does not substitute a quantized graph or another model.

## Configuration and upstream delivery

| Field | Meaning |
| --- | --- |
| `family` | Required `laya` or `julia`; chooses the model's encoding and graph layout. |
| `model` | Required upstream repository/base URL accepted by Transformers.js. The application owns its selection. |
| `revision` | Upstream revision, default `main`; select a stable revision when repeatable model selection is needed. |
| `device` | Transformers.js backend, default `webgpu`; an explicit supported alternative is caller-owned. No automatic backend fallback. |
| `dtype` | Exact upstream precision selection; defaults to `fp16` for Laya and `fp32` for Julia. For Laya FP32, supply `dtype: 'fp32'`. Unsupported selections fail at the selected upstream loader rather than being replaced. |
| `runtime.moduleUrl` | Defaults to the self-contained CDN entry `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js`. The `.web.js` build expects a bundler to resolve its bare ONNX Runtime import and is unsuitable for a native module Worker. An explicit compatible public runtime URL may be supplied. With `store`, the SDK stores and materializes the complete selected entry for that activation. |
| `runtime.wasmPaths` | Optional upstream ONNX WASM location passed to the selected runtime's public environment API. |
| `store` | Optional existing SDK DBOPFS model or speech artifact store exposing `fetchResource()`. The store remains outside Worker configuration; the SDK uses it for the runtime entry and bridges the loader's actual resource requests to it. |

Without `store`, the runtime, tokenizer and weights use normal upstream loading
and caching. With `store`, the selected loader still owns filenames and model
selection while model resources persist through that existing SDK store. The
SDK does not redistribute upstream runtimes or models. Browser
network, cross-origin and backend availability still apply. WebGPU needs a
compatible browser/device context. Unsupported precision or backend errors
are returned, not replaced with a different model, backend or precision.

Laya defaults to `dtype: 'fp16'`, loading `onnx/model_fp16.onnx` and its
`model_fp16.onnx_data` companion through Transformers.js. The published mixed
precision graph retains selected operations/outputs in FP32; FP16 selection
does not claim every graph operation runs in half precision. Explicit
`dtype: 'fp32'` selects the repository's FP32 graph through that same loader.

Julia selects `dtype: 'fp32'`, loading root `model.onnx` with the exact
`model.onnx.data` external-data name. Its custom five-input graph is loaded
through the public generic `PreTrainedModel` API, not a text-generation
pipeline. Existing Wllama, cloud, speech and chat APIs are unchanged.

## Shared DBOPFS model resources

```js
import {createDbopfsModelStore} from 'arcane-os/ai/browser-wasm';
import {createBrowserDecisionModel} from 'arcane-os/ai/browser-decisions';

// dbopfs is the application's existing Arcane DBOPFS instance.
const store = createDbopfsModelStore({dbopfs});
const decisions = createBrowserDecisionModel(
    {
        family: 'laya',
        model: 'onnx-community/laya-typed-decisions-ONNX',
        store
    }
);
await decisions.load();
```

The same `store` may serve other SDK model clients. The application supplies no
tokenizer/configuration/graph manifest and performs no file routing. Explicit
activation first opens `runtime.moduleUrl` through `store.fetchResource()`.
The SDK materializes the complete stored entry as a JavaScript object URL for
the dedicated Worker, without rewriting its content. The configured source URL
is retained for later activations, so they reuse the same stored resource rather
than saving a temporary object URL. Construction still starts no download.

Inside the dedicated decision Worker, Transformers.js's public `env.fetch` hook routes the
actual selected tokenizer, configuration, ONNX graph and external-data requests
to `store.fetchResource(input, options)`. Its competing browser, custom and
filesystem model caches are disabled only for this explicit stored mode. The
default upstream ONNX WASM binary and factory preloads use this same hook.
Native support-file fetches in the dedicated Worker also use the store. The
default runtime entry is self-contained. Entry materialization does not rewrite
dependency imports in custom modules or preserve their original `import.meta.url`
base. Custom stored entries must work from an object URL; relative imports or
support-file URLs resolved against that module's original location require a
compatible self-contained entry. Native absolute ESM dependencies and an upstream
custom factory import outside its preload path remain browser-owned. No second
application cache or model substitution is introduced. Without `store`, the
configured runtime URL keeps its direct native module-loading behavior.

The store returns `{file, status, statusText, headers, url, redirected}`. The
Worker reconstructs the complete response with its actual HTTP status and
headers, so a missing optional upstream file remains a missing-file response.
New response bodies stream into ordered persistent shards, including resources
with unknown totals. Completed resources are reused by their semantic request
and URL selection. Interrupted closed shards remain available for HTTP Range
resume; a server returning a full response restarts that member without adding
the saved prefix twice. Independent resources remain concurrent, and repeated
requests for the same resource share its storage mutation owner. Existing saved
model formats are retained without a migration.

Resource progress uses `{phase: 'download', completed, total, unit: 'shards',
url}`. `completed` counts closed persistent shards; `total` is `null` until the
resource finishes. This progress carries no network-size, rate or ETA fields.
Cancellation aborts the owned fetch and joins reader/writer cleanup before the
resource owner becomes available to a later request. Interrupted closed shards
are retained. Each activation owns its runtime object URL and revokes it after
terminating the Worker on cancellation, failure, unload or disposal. A cancelled
runtime-entry fetch is joined before its waiting calls settle; a late response
cannot activate a replacement Worker. Runtime-entry HTTP failures retain the
complete stored response in `error.response` for developer diagnostics.
`unload()` and `dispose()` still acknowledge their lifecycle transition
synchronously; outstanding `load()`/`evaluate()` calls settle after their
resource cleanup.

## Complete rows and results

`evaluate(rows, {signal})` accepts an array in caller order. Each row has
string `state`, string `question`, string-array `options`, and optional
`type` defaulting to `choice`. Additional row fields remain in the returned
row without affecting inference. Neither strings nor option arrays are
trimmed, rewritten, clipped or capped by the SDK.

The model's required token framing puts the complete type/question header,
option markers/options and state into `input_ids`; accompanying inputs are
`attention_mask`, `marker_pos`, `marker_mask` and `qtype`. Right padding aligns
rows in a batch. Literal marker text inside supplied content remains content;
option positions identify only markers inserted by the encoding owner.
Tokenizer encoding is called without special-token insertion and without
the upstream batch-tokenizer truncation path.

The result is `{decisions, outputs}`. `decisions` follows input order and each
entry contains the original row record, option `logits`, unrounded raw-softmax
`probabilities`, the highest-logit `answerIndex`, and `value`:

| Type | `value` |
| --- | --- |
| `choice` | The complete selected option string. |
| `score` | Raw-softmax weighted zero-based option index. Applications map this to their own score scale. |
| `noul` | Probability of option 1; supply exactly `[falseOption, trueOption]` in that order. |

If the actual graph supplies `act_logits`, the entry additionally includes
complete `actionLogits`, unrounded `actionProbabilities`, and raw-softmax
`actProbability` at index 0. Julia's
published ONNX export has no action head; the SDK does not invent one.

`outputs` preserves every returned graph tensor, including padding and extra
named outputs, as `{type, dims, data}` with complete copied typed data. This
keeps model results available for explicit application interpretation and
diagnostics. Probabilities are raw model scores, not claimed calibrated
confidence, probabilities rounded to two decimal places, or policy decisions.
No result is inserted into chat history, memory extraction or DBOPFS.

## Lifecycle, events and cancellation

`status()` returns `{family, model, revision, device, dtype, state, loaded,
busy, activeRequests, progress, error}`. States are `unloaded`, `loading`,
`ready`, `error` and `disposed`. `subscribe(listener, {emitCurrent: true,
signal})` observes the owning Arcane event source, replays current state by
default and returns an unsubscribe function. Successful rows and graph results
return to the calling operation rather than lifecycle notifications. Complete
errors, including graph diagnostics when decoding fails, remain available in
`error`; they belong in developer diagnostics, not ordinary status text.

Work is acknowledged synchronously before loading/inference waits. Progress
reports real semantic phases such as `waiting-for-model`, `loading-runtime`, `loading-tokenizer`,
`loading-model`, `download`, `ready`, `evaluating` and `complete`; it is not a synthetic
percentage. Loading the model and tokenizer proceeds concurrently. Repeated
identical state text is tokenized once per batch. Independent requests are
accepted concurrently; the selected backend still owns its execution ordering.

`load({signal})` explicitly prepares the shared activation. `evaluate()` also
loads on its first explicit use. An `AbortSignal`, `unload()` or `dispose()`
terminates the client's dedicated Worker and rejects all its outstanding
operations. Cancellation is client-wide because the model session and GPU
work belong to that Worker. Use separate clients when independent cancellation
is required. `unload()` permits later explicit reactivation; `dispose()` is
terminal. Old Worker replies cannot affect a replacement activation.

A Worker operation failure releases the failed activation and rejects its
waiting calls. The next explicit use starts a fresh Worker rather than reusing
an upstream inference queue that may remain rejected after a backend failure.
Error records preserve the original
name, message, stack, code, cause and available custom fields across the Worker
boundary. Applications keep technical diagnostics out of ordinary user status.

## Model limits and evidence

The published Laya and Julia families advertise an 8192-token native context.
Their reference wrappers apply smaller budgets and, for Julia, a documented
2–20-option interface. The SDK does not reproduce those wrapper clipping or
rounding policies or claim arbitrary lengths are supported by the graph.
Actual model/backend failures remain observable. Long-input quality and
option-count behavior must be established for the application's selected
model; no hidden windowing or result aggregation is performed.

Julia's Transformers.js tokenizer route exists in the official browser
adapter, alongside a Rust tokenizer. Repeated-space/Metaspace segmentation can
differ between those tokenizer implementations. Complete text is preserved at
the tokenizer boundary, and Python/Rust token-ID or numerical parity is not
claimed. Applications needing that parity must use an established compatible
tokenizer contract rather than silently rewriting text.

Upstream graph/loading contracts were reviewed from primary source. Browser
model loading, FP16/FP32 inference, cancellation and numerical behavior require
selected-output verification; static compatibility review alone is not a
runtime pass.

Primary references: [Laya ONNX](https://huggingface.co/onnx-community/laya-typed-decisions-ONNX),
[Laya reference](https://github.com/NandhaKishorM/laya),
[Julia-1 ONNX](https://huggingface.co/SupersonicLabs/Julia-1-ONNX),
[Transformers.js 4.3.0](https://github.com/huggingface/transformers.js/tree/4.3.0/packages/transformers).
