# Native typed decisions

`arcane-os/local-ai/decisions` and `arcane-os/core/decisions` run the selected
Laya FP32, Laya FP16 or Julia FP32 graph through the SDK's existing native ONNX owner. Tokenization runs
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
| `decisions.load` | `{family?, model?, revision?, dtype?, assetProjectionId?, resourcePaths?, executionTarget?}`; explicit activation or model/source/device replacement, returning the ready lifecycle snapshot. The request signal cancels activation. A target is `{deviceId:string}` or `null`. |
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
caller-owned files. Factory defaults remain `family:'laya'`,
`model:'onnx-community/laya-typed-decisions-ONNX'`, `revision:'main'` and
`dtype:'fp32'`. SDK upstream preparation selects these exact layouts:

| Family and dtype | Graph | Complete external data |
| --- | --- | --- |
| `laya`, `fp32` | `onnx/model.onnx` | `onnx/model.onnx_data` |
| `laya`, `fp16` | `onnx/model_fp16.onnx` | `onnx/model_fp16.onnx_data` |
| `julia`, `fp32` | `model.onnx` | `model.onnx.data` |

Each selection uses `tokenizer.json` and `tokenizer_config.json` from its own
selected repository. Julia's public repository is `SupersonicLabs/Julia-1-ONNX`.

## Load complete files already stored in DBOPFS

Use the existing [model-assets projection](model-assets.md) for complete files
already obtained through the application's DBOPFS model store. Pass every
original member, including `onnx/model.onnx_data`, to `prepareCoreModelAssets`.
The original relative paths and complete content remain unchanged:

```js
import {prepareCoreModelAssets} from 'arcane-os/ai/core-model-assets';

const projection = await prepareCoreModelAssets({
    client,
    workingDirectory: selectedWorkingDirectory,
    members: [
        {path: 'onnx/model.onnx', file: storedGraph},
        {path: 'onnx/model.onnx_data', file: storedGraphData},
        {path: 'tokenizer.json', file: storedTokenizer},
        {path: 'tokenizer_config.json', file: storedTokenizerConfig}
    ],
    signal
});
try {
    await client.invoke('decisions.load', {
        assetProjectionId: projection.id,
        resourcePaths: {
            model: 'onnx/model.onnx',
            tokenizer: 'tokenizer.json',
            tokenizerConfig: 'tokenizer_config.json'
        },
        executionTarget: {deviceId: 'cpu'}
    }, {signal, timeoutMs: 0});
} finally {
    // The native activation owns a separate retain handle after loading.
    await projection.release();
}
```

Here the four `stored*` values are the complete original Blob/File members
from the application's existing store. This projects those files; it performs
no model download. The decision service must already be registered as above.
After loading, invoke `decisions.evaluate` with the complete `rows`, then
`decisions.unload` when that native activation is no longer needed.

Direct model and service calls accept
`load({family, model, revision, dtype, assetProjectionId, resourcePaths, executionTarget, signal})`; their
factory configuration accepts the same source selection. A direct model needs
the existing `modelAssets` owner when selecting a projection. `resourcePaths`
maps all three roles (`model`, `tokenizer`, `tokenizerConfig`) to exact
`member.path` values in a ready projection. Additional companion members stay
in its retained directory; the graph finds its external data under the exact
relative filename it references. The SDK does not rename or reconstruct them.

A supplied projection is retained and used directly. It takes precedence over
configured `paths` and upstream settings and never invokes upstream preparation
or retries with downloaded files. Missing, unfinished or released projections,
and missing mapped resources, report their actual failure.

Omitted or `undefined` source fields retain the selected source and mappings.
`assetProjectionId: null` returns to the factory's configured `paths`, or its
existing upstream preparation when no paths were configured. Selecting another
projection or changing any resource mapping replaces the activation even when
the execution target stays the same. Equal family, model, revision, dtype,
source, mapping and device selections
coalesce. The incoming retain is acquired before the prior activation retires,
so device replacement can reuse a projection after the caller has released its
preparation ownership. Superseded pending retains are released as their cleanup
settles. Unload ends the native use; if no preparation or other use remains,
create a fresh projection from the stored originals before loading again.

## Existing upstream preparation

`model` selects the upstream Hugging Face repository and `revision` its
revision. On explicit `load()`, the existing model-assets owner reuses complete
native acquisitions under the selected `workingDirectory/model-assets/`, or
fetches the complete selected members concurrently when absent. Complete
acquisitions survive unload, disposal and application restart. Reuse matches
the entire ordered original path/URL selection; it never substitutes another
model, revision, precision or device. Supplied projections and caller-owned
`paths` retain their existing precedence and lifecycle.

Ordinary preparation reuses the selected URLs without checking whether mutable
upstream content changed. Explicit reacquisition is available through native
[`modelAssets.prepare({refresh:true,...})`](model-assets.md#native-ownership),
whose ready projection can be supplied through the existing
`assetProjectionId`/`resourcePaths` contract. It preserves earlier complete
acquisitions and active native retains. Incomplete attempts are not reused or
resumed; separate processes may perform duplicate acquisitions in disjoint
directories. The shared model-assets owner handles storage without an
application-local cache copy or a second model store.

The approved `@huggingface/tokenizers@0.2.0` dependency reads the
selected tokenizer files in its Worker. No Transformers or second ONNX runtime
is loaded by this API.

Native graph selections support Laya `fp32` and `fp16`, and Julia `fp32`.
Other family/precision combinations report an unsupported selection. Laya FP16
uses the published mixed-precision graph, which retains selected operations
and outputs in FP32; it does not claim every graph operation uses FP16. Julia
uses its typed five-input ONNX graph and raw option logits, without the upstream
display-rounded `predict()` wrapper or invented action outputs.
`sessionOptions` and `runOptions` pass to the existing native ONNX API unchanged.
With no `executionTarget` selection, `executionPreference` defaults to `gpu`
here: actual advertised native GPU provider creation is attempted, followed by
an honest CPU fallback. Explicit `sessionOptions.executionProviders` takes
precedence on that unchanged path. The underlying generic ONNX factory
continues to default to CPU. Accepted provider configuration is not evidence
that GPU nodes executed. Full provider-attempt diagnostics remain in
`execution`; see [native ONNX sessions](local-ai.md#native-onnx-sessions).

## Select an activation's model

Both factories and each direct/Core `load` accept `family`, `model`, `revision`
and `dtype`. The same service persists while its selected activation changes:

```js
await client.invoke('decisions.load', {
    family: 'julia',
    model: 'SupersonicLabs/Julia-1-ONNX',
    revision: 'main',
    dtype: 'fp32',
    assetProjectionId: juliaProjection.id,
    resourcePaths: {
        model: 'model.onnx',
        tokenizer: 'tokenizer.json',
        tokenizerConfig: 'tokenizer_config.json'
    }
}, {signal, timeoutMs: 0});
```

Here `juliaProjection` is the caller's ready projection containing Julia's
complete graph, `model.onnx.data` and its own tokenizer files. The caller may
release its preparation ownership after loading, as in the projection example.
For upstream preparation without configured paths, select the same four model
fields with `assetProjectionId: null`.

Omitting a model field, or supplying `undefined`, retains its most recent
selection, initially the factory default. The selection survives unload for a
later explicit load. Changing any field replaces the activation; equal complete
selections share it. Supply the complete new model selection when changing
family, including its matching projection/mapping or configured native files.
Changing `family` alone does not infer a repository, change precision, replace
configured files, or rewrite a projection. Metadata describes the caller's
selection; the SDK does not inspect weights to establish checkpoint identity.
Configured `paths` and a selected projection keep their existing precedence
over upstream preparation.

Top-level `current().family`, `model`, `revision` and `dtype` follow the
activation being loaded, used or retired. While replacement waits for prior
cleanup, those fields and `execution` still describe the prior activation;
`pendingActivation` carries the requested successor separately. The new
selection takes ownership when its activation begins.

## Select an activation's execution device

Both factories accept `executionTarget: {deviceId:string}` or `null` in their
configuration. Direct model and service calls accept
`load({executionTarget, signal})`; the Core `decisions.load` method carries the
same target in its parameters. Use an actual stable ID from the shared
[physical device catalog](execution-devices.md), or the documented whole-host
CPU ID:

```js
await decisions.load({executionTarget: {deviceId: 'cpu'}});
// A different explicit selection drains the current activation and replaces it.
await decisions.load({executionTarget: null});
```

Omitting `executionTarget`, or supplying `undefined`, retains the most recent
explicit selection, initially the factory's selection. When neither supplies a
target, existing constructor, session-option and provider-default behavior
remains unchanged. Explicit `null` requests automatic device resolution at the
new activation boundary. It remains distinct from omission. The selection
stays available for a later explicit load after unloading or a failed load;
the SDK creates no preference store and does not change application preferences.

The decision owner forwards the target to its existing ONNX owner. That owner
resolves the physical ID, supported provider and provider-specific address.
An unavailable or unsupported explicit target reports its actual failure; it
does not silently select another adapter or a cloud provider. GPU selection
does not require every graph node to execute on the GPU: supported CPU graph
partitioning remains an engine concern. See the native ONNX contract for exact
target routing and automatic-selection behavior.

The existing `current().execution` field remains the complete ONNX session load
record for that activation. Its `execution` member carries `requestedTarget`,
`resolvedDevice`, `resolution`, `configuredTarget` and `observedTarget`, alongside
provider-attempt diagnostics. These distinguish requested selection, physical
resolution, accepted configuration and actual execution evidence. An unknown
`observedTarget` remains `null`; successful configuration alone does not establish
which device executed graph nodes.

`pendingActivation` is separately `null` or a selection containing `family`,
`model`, `revision`, `dtype` and `executionTarget` while a load or replacement
is pending; its `executionTarget` property is omitted at JSON
transport when the selection is `undefined`. A projected selection also includes
`assetProjectionId` and its complete `resourcePaths` mapping. A pending target never overwrites the previous
activation's `execution` record. The old record remains attributable to the
retiring activation until its cleanup completes, then the new activation owns
its own record. A request is not a claim that the requested device is running.

Concurrent loads for the same family, model, revision, dtype, source, resource mapping and target share their
pending activation. A different selection supersedes the earlier pending request, which rejects with
cancellation instead of returning another target's ready result. Replacement
joins this model's actual tokenizer/native cleanup before creating its
successor. Independent model owners retain their independent workers and
lifetimes; there is no all-model loading barrier or trial inference.

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
activeRequests, progress, error, execution, pendingActivation}`. States include
`unloaded`,
`loading`, `ready`, `unloading`, `disposing`, `disposed` and `error`. Semantic
progress includes model preparation, tokenization and evaluation; downloaded
members report files, not byte progress. Complete technical errors belong in
developer diagnostics, while the application owns its user-facing status.

An ONNX run failure reaches the rejected evaluation and retained `error` in
`current()`, `decisions.status`, and `decisions.state`, including the complete
[`error.onnxRun` diagnostic](local-ai.md#native-onnx-sessions). This identifies
the actual session, request, failure stage, model path, provider execution
record, graph metadata and complete encoded feed tensors with their dimensions.
The activation's `execution.execution.deviceInventory` retains the complete
inventory consumed by automatic physical selection during its load, or `null`
when that selection path did not gather one.
Neither observation starts another hardware query or changes model execution.
Retain these complete records in the selected developer inspection surface;
ordinary user status remains application-owned. A retained error identifies
that failed request and does not by itself establish that a later request failed.

Concurrent callers selecting the same family, model, revision, dtype, source,
mapping and target share one explicit activation.
Cancelling a load or evaluation cancels that activation and its outstanding operations, because the
native session and tokenizer have one owner. Use separately owned models when
independent cancellation is required. The construction `signal` governs the
whole model lifetime. `unload()` permits another explicit load after successful
cleanup; `dispose()` is terminal. Readiness is revoked as disposal begins.

Retained model files remain owned until the ONNX and tokenizer Workers really
exit. A rejected load, inference or termination request alone does not permit
file deletion. Cleanup joins active operations and native output delivery,
preserves cleanup errors, then releases its native-use handle. Preparation
ownership of a supplied projection remains with its caller. It never
deletes supplied `paths`. A failed ordinary row does not destroy a healthy
loaded session or cancel sibling evaluations. The ONNX owner's `stopping:true`
retires decision readiness immediately on terminal Worker failure or shutdown,
even while its physical `loaded` state remains true pending actual exit. Cancelled or
retired operations cannot return a successful late result.

Shared Node/Worker/filesystem code is portable across Windows, Linux and macOS;
the selected ONNX Runtime build and provider determine actual platform/device
availability. Android requires the host's supported native adaptation. Static
source review and synthetic authored fixtures are not model execution or a
claim of tested platform, precision or accelerator behavior.

Upstream selection: [Laya model files](https://huggingface.co/onnx-community/laya-typed-decisions-ONNX/tree/main),
[Julia-1 model files](https://huggingface.co/SupersonicLabs/Julia-1-ONNX/tree/main),
[Tokenizer package](https://www.npmjs.com/package/@huggingface/tokenizers).
