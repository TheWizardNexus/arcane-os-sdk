# Browser typed decisions

`arcane-os/ai/browser-decisions` owns browser-local Laya typed-decisions FP16
and Julia-1 FP32 inference. It is separate from chat and speech because these
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
| `runtime.moduleUrl` | Defaults to the self-contained CDN entry `https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js`. The `.web.js` build expects a bundler to resolve its bare ONNX Runtime import and is unsuitable for a native module Worker. An explicit compatible public runtime URL may be supplied. |
| `runtime.wasmPaths` | Optional upstream ONNX WASM location passed to the selected runtime's public environment API. |

The runtime, tokenizer and weights use normal upstream loading and caching;
the SDK does not redistribute them or create a second model store. Browser
network, cross-origin and backend availability still apply. WebGPU needs a
compatible browser/device context. Unsupported precision or backend errors
are returned, not replaced with a different model, backend or precision.

Laya selects `dtype: 'fp16'`, loading `onnx/model_fp16.onnx` and its
`model_fp16.onnx_data` companion through Transformers.js. The published mixed
precision graph retains selected operations/outputs in FP32; FP16 selection
does not claim every graph operation runs in half precision.

Julia selects `dtype: 'fp32'`, loading root `model.onnx` with the exact
`model.onnx.data` external-data name. Its custom five-input graph is loaded
through the public generic `PreTrainedModel` API, not a text-generation
pipeline. Existing Wllama, cloud, speech and chat APIs are unchanged.

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
`loading-model`, `ready`, `evaluating` and `complete`; it is not a synthetic
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
