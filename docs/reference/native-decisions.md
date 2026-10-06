# Native Laya typed decisions

`arcane-os/local-ai/decisions` and `arcane-os/core/decisions` run the selected
Laya FP32 graph through the SDK's existing native ONNX owner. Tokenization runs
in its own Node Worker. A Core service can load and evaluate decisions without
a renderer, browser session, WebGPU browser context or chat provider.

The application owns the model selection, original state text, questions,
options and interpretation. The SDK owns model preparation, token framing,
inference and cleanup. This is option scoring, not a conversational LLM, a
replacement for a configured chat model or the cloud System One API.

## Compose with existing Core services

Register a decision service alongside the selected local-AI and model-assets
services in the application's existing Core runtime:

```js
import {createNativeDecisionService} from 'arcane-os/core/decisions';

const decisions = createNativeDecisionService({
    model: 'onnx-community/laya-typed-decisions-ONNX',
    dtype: 'fp32',
    workingDirectory: '.models/laya'
}, {appRoot});

// Include decisions in the existing createCoreRuntime({services}) selection.
// That runtime already owns local-ai with ONNX selected and model-assets.
await runtime.getService('decisions');
await decisions.load(); // Explicit activation; no model download at registration.
try {
    const result = await decisions.evaluate([{
        state: 'The moon chef has one kettle and seventeen impatient dragons.',
        question: 'What should the chef prepare?',
        options: ['Tea', 'An inflatable castle']
    }]);
    console.log(result.decisions[0].value);
} finally {
    await decisions.unload();
}
```

Here `runtime` and `appRoot` are the application's existing Core runtime and
root. Add the service before starting that runtime; the example does not create
a second Core host or engine. Development and packaged native compositions
already register one model-assets service when ONNX is selected. The decision
service obtains those exact owners with `context.getService('local-ai')`,
`localAI.getONNXRuntime()` and `context.getService('model-assets')` on explicit
load. It reacquires the current ONNX owner after a later runtime recovery.
See [Core composition](core-runtime.md#native-service-composition) and
[native service owners](local-ai.md#native-service-owners).

`createNativeDecisionService(configuration, {appRoot})` defaults its service
name to `decisions`. It exposes `load`, `evaluate`, `classify` (an alias for
`evaluate`), `current`, `subscribe`, `unload` and `dispose`, plus Core lifecycle
`start(context)`. Its RPC methods are:

| Method | Parameters and result |
| --- | --- |
| `decisions.status` | Current lifecycle snapshot; does not load anything. |
| `decisions.load` | Explicit activation; returns the ready lifecycle snapshot. The request signal cancels activation. |
| `decisions.evaluate` | `{rows, runOptions?}`; returns `{decisions, outputs}`. The request signal cancels the active model operation. |
| `decisions.unload` | Releases the activation. Service-lifetime cleanup continues after the caller disconnects. |

RPC evaluation uses the SDK's existing complete JSON tensor encoding for
`outputs` at the transport boundary. Direct native evaluation returns native
typed tensor records. Service notifications use `decisions.state`; direct
`subscribe(listener, {emitCurrent:true, signal})` replays current state by
default and returns an unsubscribe function. Startup stores the service
context only: importing or registering this service starts no tokenizer,
model download or inference.

## Direct native model

`createNativeDecisionModel(options)` from `arcane-os/local-ai/decisions` returns
`{load, evaluate, classify, current, status, subscribe, unload, dispose}`.
`status` aliases `current`; `classify` aliases `evaluate`. Supply the existing
native `onnx` owner, plus either the existing `modelAssets` owner and selected
`workingDirectory`, or caller-owned native files:

```js
import {createNativeDecisionModel} from 'arcane-os/local-ai/decisions';

const decisions = createNativeDecisionModel({
    onnx: localAI.getONNXRuntime(),
    paths: {
        model: selectedGraphPath,
        tokenizer: selectedTokenizerPath,
        tokenizerConfig: selectedTokenizerConfigPath
    }
});
```

These direct paths are native filesystem paths. Keep the graph's external data
beside it under the exact filename required by the graph. The Core service
resolves configured `paths` relative to `appRoot`; it does not copy or remove
caller-owned files. For SDK-prepared files, the default selected upstream is
`onnx-community/laya-typed-decisions-ONNX`, revision `main`, with exactly:

- `onnx/model.onnx` and `onnx/model.onnx_data`;
- `tokenizer.json` and `tokenizer_config.json`.

`model` selects the upstream Hugging Face repository and `revision` its
revision. Native preparation performs normal upstream fetches only during
explicit `load()`. It streams complete members through the existing working
file owner; it neither vendors the weights nor creates a second persistent
model store. The approved `@huggingface/tokenizers@0.2.0` dependency reads the
selected tokenizer files in its Worker. No Transformers or second ONNX runtime
is loaded by this API.

This graph selection requires `dtype:'fp32'`, which is also the default; another
dtype reports the incompatible selection rather than substituting a graph.
`sessionOptions` and `runOptions` pass to the existing native ONNX API unchanged.
`executionPreference` defaults to `gpu` here: actual advertised native GPU
provider creation is attempted, followed by an honest CPU fallback. Explicit
`sessionOptions.executionProviders` takes precedence. The underlying generic
ONNX factory continues to default to CPU. Accepted provider configuration is
not evidence that GPU nodes executed. Full provider-attempt diagnostics remain
in `execution`; see [native ONNX sessions](local-ai.md#native-onnx-sessions).

## Complete inputs and outputs

`evaluate(rows, {signal, runOptions})` requires an explicitly loaded or loading
activation; it does not silently load an inactive model. Rows retain their
caller order, complete `state`, `question` and string-array `options`, plus
optional `type` (`choice`, `score` or `noul`). Additional row fields remain in
the returned row. Strings are not trimmed, rewritten or clipped. The shared
browser/native encoding owner constructs only the model's necessary token
framing; repeated identical state is tokenized once per batch. Tokenization
and ONNX execution run outside Core's foreground thread.

The result is `{decisions, outputs}`. Each decision contains its original
`row`, complete option `logits`, unrounded raw-softmax `probabilities`,
`answerIndex` and `value`. `choice` returns the selected complete option;
`score` returns the probability-weighted zero-based option index; `noul`
requires `[falseOption, trueOption]` and returns the probability of option 1.
When the graph actually supplies `act_logits`, action logits, probabilities
and `actProbability` are also returned. Every named graph output is retained
as `{type, dims, data}`, including extra tensors and padding. Raw model scores
are not claimed calibrated confidence. Results do not enter chat history,
memory extraction or DBOPFS automatically.

The model's real graph/context limits still apply. There is no SDK token cap,
silent chunking or fabricated result aggregation. Native/browser token-ID or
numerical parity requires execution evidence for the selected tokenizer and
runtime; sharing the encoding implementation alone does not establish it.

## Lifetime and cancellation

`current()` returns `{family, model, revision, dtype, state, loaded, busy,
activeRequests, progress, error, execution}`. States include `unloaded`,
`loading`, `ready`, `unloading`, `disposing`, `disposed` and `error`. Semantic
progress includes model preparation, tokenization and evaluation; downloaded
members report files, not byte progress. Complete technical errors belong in
developer diagnostics, while the application owns its user-facing status.

Concurrent callers share one explicit activation. Cancelling a load or
evaluation cancels that activation and its outstanding operations, because the
native session and tokenizer have one owner. Use separately owned models when
independent cancellation is required. The construction `signal` governs the
whole model lifetime. `unload()` permits another explicit load after successful
cleanup; `dispose()` is terminal. Readiness is revoked as disposal begins.

Retained model files remain owned until the ONNX and tokenizer Workers really
exit. A rejected load, inference or termination request alone does not permit
file deletion. Cleanup joins active operations and native output delivery,
preserves cleanup errors, then releases only its working projection. It never
deletes supplied `paths`. A failed ordinary row does not destroy a healthy
loaded session; terminal Worker failure retires its activation. Cancelled or
retired operations cannot return a successful late result.

Shared Node/Worker/filesystem code is portable across Windows, Linux and macOS;
the selected ONNX Runtime build and provider determine actual platform/device
availability. Android requires the host's supported native adaptation. Static
source review and synthetic authored fixtures are not model execution or a
claim of tested platform, precision or accelerator behavior.

Upstream selection: [Laya FP32 model files](https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/tree/main),
[Tokenizer package](https://www.npmjs.com/package/@huggingface/tokenizers).
