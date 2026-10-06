# Local AI through Core

Core owns native llama.cpp and Ollama processes, ONNX worker sessions,
selected local image generation and retained Whisper transcription. The browser retains its own
Wllama and ONNX implementations, and can also use an explicitly connected Core
when that system service is available. Runtime installation, model loading and
inference are separate operations.

Native ONNX runs caller-selected graphs with complete named input/output tensors.
Applications own preprocessing, tokenization and model-specific pipelines.
Browser ONNX continues through its existing browser implementation.

## Application requirements

Declare required native runtimes in `arcane-app.json` under `native.localAI`.
The package projection retains the same record as `arcane-package.json.localAI`.
Existing native fields remain alongside this record:

```json
{
  "runtimes": [
    {"id": "llama.cpp"},
    {"id": "ollama"},
    {"id": "onnx"},
    {"id": "stable-diffusion.cpp", "backend": "auto", "models": ["sd14"]}
  ],
  "llamaCpp": {
    "modelsDirectory": "models/llama"
  },
  "ollama": {
    "modelsDirectory": "models/ollama"
  }
}
```

Each runtime requirement accepts `id`, optional upstream `version`, and an
optional runtime archive `url`. ONNX resolves its official npm package or an
explicitly supplied package archive. A string runtime ID is also accepted.
For chat runtimes, omitting the version allows reuse of an available runtime. Explicit versions
select that upstream distribution; an existing service must match the requested
version before it is reused. A service occupying the selected address is
preserved when its version cannot be established.

Both public application/package schemas accept `stable-diffusion.cpp` as a
string or runtime-record ID. Its record additionally accepts `backend`
(`auto`, `cpu` or `metal`) and `models`, an array of `sd14`, `flux2-klein-4b`, `sdxl-base-1.0` or
complete model descriptors. Omitted image version selects `master-929-3f8527a`; omitted backend
selects `auto`; omitted models leaves model selection empty. Windows/Linux
distribution defaults use CPU; the selected universal Mac archive supports
Metal with CPU fallback. Installation obtains the upstream library and its
managed `koffi@3.3.2` binding, without installing a model. Complete model
descriptors keep their resources, context, defaults and operations separate.
See [image selection and model preparation](local-image-generation.md#selection-and-model-assets).
The [FLUX.2 Klein 4B guide](local-image-flux.md) describes its diffusion model,
VAE and Qwen text-conditioning resources, four-step defaults and `txt2img`
operation. Each model retains its own supported operation set.

The [SDXL Base 1.0 guide](local-image-sdxl.md) describes its complete checkpoint,
embedded text encoders and original VAE, 1024-by-1024 default canvas and
`txt2img` operation. Selecting a family retains the shared native context,
progress, cancellation and complete PNG result contract.

For native transcription, select a `whisper.cpp` runtime record with a `models`
array and an explicit `modelId` when selecting more than one model. For example,
`{id: 'whisper.cpp', backend: 'auto', models: ['whisper-small'], modelId: 'whisper-small'}`
selects the multilingual small model. Installation prepares its native
libraries, persistent SDK helper, FFmpeg decoder and selected model files;
loading and transcription remain separate operations. Development and native
assembly compose it through the shared speech service without changing the
browser's selected STT route. See [native Whisper](local-whisper.md) for the
complete configuration, platform, media and shutdown contracts.

Adding `encoder: 'openvino-npu'` selects the optional Intel NPU audio encoder
with a separately selected CUDA or CPU decoder. The Windows x64 precompiled
runtime uses paired GGML/XML/BIN model resources and the computer's installed
compatible Intel NPU driver. See the [Intel NPU Whisper guide](../guides/native-whisper-openvino.md)
for preparation, observed initialization, cancellation/reload and custom
runtime production. Omitting the encoder retains ordinary Whisper preparation.

The selected model stays loaded across recordings. An eligible native
accelerated failure may drain that helper and retry the same complete recording
once on the prepared CPU backend. That accepted request retains its actual
request identity while `recovering` is unloaded and busy; new inference remains
blocked until actual readiness. Cancellation, unload, close, replacement and
transport loss retain their owning cancellation behavior. A terminal engine
failure reaches the original request as its actual error rather than a
fabricated readiness success. See [native speech reconciliation](native-speech.md).

`llamaCpp` accepts `url`, `model`, `modelsDirectory`, and an `args` string array.
`model` selects a single GGUF file; `modelsDirectory` selects llama.cpp router
mode. Paths resolve from the application root. Ollama accepts `url`,
`modelsDirectory`, and `args`. The default endpoints are
`http://127.0.0.1:8080` and `http://127.0.0.1:11434`, respectively. Default model
directories are `.arcane/models/llama.cpp` and `.arcane/models/ollama` inside the
application. Applications choose and provision their models explicitly.

## Development

```sh
arcane dev --local-ai llama.cpp,ollama,onnx
```

The option adds those runtime requirements to the authored application
configuration. Subsequent `arcane dev` runs reuse the saved requirements.
`--local-ai stable-diffusion.cpp` also selects image runtime preparation; the
application selects its `models` in the runtime record before requesting a
load or generation. The development owner composes separate image and
model-assets services alongside the existing chat/ONNX service.
Development checks selected endpoints and existing executable paths, then
installs missing runtimes under the application's `.arcane/local-ai/runtimes`.
Runtime preparation runs alongside HTTP serving. Browser rendering continues
while installation and model readiness are pending.

The SDK downloads the official llama.cpp or Ollama distribution directly and
preserves its runtime libraries. Installation changes no global PATH, system
service or machine environment. Windows and macOS use the host archive utility;
Linux requires `tar`, and `unzip` when extracting a selected Windows ZIP.
Zstandard archives use the supported Node runtime's decompressor.

Selected ONNX preparation installs `onnxruntime-node@1.30.0` by default into a
managed npm prefix, retaining its complete published runtime dependency tree.
It uses the upstream CPU installation option to skip supplementary GPU downloads.
Node/npm must be available while preparing that runtime; a native app consumes
the bundled tree without installing it again. Applications that omit ONNX do
not install its package.

For the optional development browser connection, load the bootstrap after the
managed import map and before creating a Core-backed provider:

```js
const {client} = await import('/arcane-local-ai.js');
const status = await client.invoke('localai.status');
console.log(status);
```

The bootstrap uses the existing Core client with RPC and ordered SSE events.
Each browser connection owns its requests and cancellation. Closing a tab
cancels that tab's requests; closing development stops its owned runtime
processes. An already running external service remains running.

`developApplication()` returns its usual server handle and an optional `localAI`
handle with `ready`, `current()`, `handler()` and `close()`. Its `ready` promise
means Core composition has started, not that installation or a selected model
is ready. Runtime preparation continues at each owning service. `current()`
includes separate `core`, `localAI` and optional `image` state; image status
remains callable during preparation. Composition failures reject `ready`;
later service preparation failures remain on Core lifecycle and diagnostic
events. Page rendering waits for neither.

## Core service

```js
import {createLocalAIService} from 'arcane-os/core/local-ai';

const service = createLocalAIService(application.native.localAI, {
  appRoot,
  runtimes,
  signal,
  onEvent
});
```

The result is a Core service definition. The launch context contains resolved
runtime records; the native builder supplies them automatically for a selected
application. `current()` returns the current snapshot without starting another
process. The service starts each selected runtime independently, retains its
process between requests, and joins cleanup during disposal.

Optional `prepare({signal,onEvent})` returns resolved runtime records before
this service starts its selected engines. The managed development owner uses
that callback without delaying the HTTP listener or independent services.
This factory accepts chat/ONNX requirements; the separate
[`createLocalImageService()`](local-image-generation.md#core-service-and-transport)
owns image requirements. The development and generated native composition
split the shared application record accordingly.

### Native service owners

A native application service uses its Core lifecycle or request context to
obtain the existing selected owner:

```js
const localAI = await context.getService('local-ai');
const onnx = localAI.getONNXRuntime();
const modelAssets = await context.getService('model-assets');
```

`getService()` awaits only that service's existing startup. The synchronous
`getONNXRuntime()` returns its actual `load/run/unload/current/subscribe/close`
owner; it neither prepares another runtime nor loads a model. An unselected
engine reports `LOCAL_AI_RUNTIME_NOT_SELECTED`; an unavailable or recovering
owner reports `LOCAL_AI_RUNTIME_UNAVAILABLE`, and an aborted service lifetime
retains its abort reason. Development and generated native compositions register
one shared model-assets service when ONNX or image generation is selected.

Reacquire `getONNXRuntime()` on each explicit model load because runtime recovery
replaces that owner. Retain the acquired handle for that session's cleanup and
await its `unload({id})` without an already-aborted request signal before releasing
the corresponding model-assets retain handle. The native ONNX owner joins actual
worker exit; a cancelled request's rejection alone does not establish that exit.
Core closes services concurrently, and the host can cancel in-flight native work
at shutdown. These native members require no renderer readiness and introduce no
second inference engine. See [native Core composition](core-runtime.md#native-service-composition).

`localai.status` returns `{runtimes}` and, when Ollama is selected, the existing
`ollama` and `models.ollama` catalog fields. Runtime records distinguish
`installed`, `available`, `state`, `models`, ownership and errors. A listening
service and a loaded model are separate facts.

`localai.services.recover({runtimes: ['llama.cpp']})` makes one explicit recovery
attempt for the selected runtimes; omission selects all configured runtimes.
Recovery restarts only SDK-owned processes and reconnects to external services.
Recovering ONNX releases its sessions; explicitly load models again afterward.
Its state is `recovering` and unavailable until the previous workers exit and
the new session owner is ready.
An external llama.cpp server returns HTTP 503 during initial model loading and
offers no readiness subscription at that stage. Core retains `state: 'loading'`;
a subsequent explicit load or recovery request checks again. There is no
background health polling.

| Method | Parameters | Result |
| --- | --- | --- |
| `llama.status` | `{}` | Runtime state and model catalog |
| `llama.models` | `{}` | `{models}` |
| `llama.load` | `{model}` | State after the exact model reports loaded |
| `llama.unload` | `{model}` | Current state after release |
| `llama.chat` | `{model,payload,stream?,streamId?}` | Complete OpenAI-shaped completion |

`llama.status` and `llama.models` observe the selected service without loading,
restarting or waiting for it. Starting, loading, stopped and failed services
return their retained state/catalog; an available service supplies a fresh
catalog observation. The llama.cpp runtime record includes `released: true`
only after Core successfully closes its owned single-model server. Explicit
load, inference or recovery can resume that engine; observation cannot.
Status observation adds no background polling.

The `payload` is the complete request. SDK option names are translated only at
the upstream protocol boundary; messages, tool definitions and documents remain
unchanged. An explicit `payload.model` selects that request's model. Core waits
for its actual readiness before inference. Router model-load work is shared
between concurrent callers for the same model. Cancelling a caller stops its
wait; explicit unloading releases the model.

Streaming publishes every actual parsed upstream chunk as
`llama.chunk: {streamId,chunk}` and assembles the terminal completion. Upstream
stream errors remain visible as their original chunks and fail the request.
`localai.state` carries current runtime/model state. Router lifecycle events
observe load, sleep and unload changes. Direct servers expose readiness at
request boundaries; they do not offer the router's passive model event stream.

Unloading a model from an owned single-model server closes that owned process;
a subsequent load can start it again. Repeating that unload returns the released
state without restarting the process. Releasing an externally owned direct
server returns `released: true, unloaded: false`, retaining the real catalog
and leaving that server running.

Ollama retains the existing Core calls for `version`, `models`/`list`, `running`,
`show`, `chat`, `generate`, `embed`, `pull`, `push`, `create`, `copy`, and `delete`.
Those methods use Ollama's native API. Streaming uses the existing
`ollama.chunk: {streamId,chunk}` event. Application/OS preference operations
such as selection, settings and brain creation remain with their existing
owners; they are separate from this runtime service.

### Selected Ollama model readiness

The built-in `OLLAMA` LLM provider loads its selected model through Ollama's
empty `generate` request and separately confirms that selected model in
`running()` (`/api/ps`). A model catalog entry, a connected bridge, and a
successful preload response alone do not establish a ready model. Ollama's
empty preload response echoes the requested name; resident snapshots use its
shortest tagged name. Comparison applies Ollama's default `registry.ollama.ai`
host, `library` namespace and `latest` tag, so `moon-raccoon` and
`registry.ollama.ai/library/moon-raccoon:latest` identify the same resident
model. This comparison leaves outbound model names and payloads unchanged.
The provider preserves Ollama's configured/default retention duration.

Core refreshes and emits `localai.state` after its Ollama generation, chat,
embedding and catalog-changing operations, including a failed or cancelled
operation while the service remains available. Explicit `running()` inspection
also publishes the actual resident-model snapshot. An SDK-owned process exit
publishes its unavailable state through the existing process owner.
Successes and failures belong to their observation order and engine lifetime;
an older observation cannot replace newer state or a recovered engine's state.
The complete current failure remains available through the owning state surface.

The LLM provider subscribes before loading and retains that observation while
loaded. An observed selected-model unload, replacement, unavailable service or
service error revokes readiness and cancels the active request through the shared
AI runtime. Each inference checks current residency before dispatch and again
before accepting its terminal result. These `running({signal})` calls carry the
owning request's cancellation through Core to `/api/ps`. Streaming chunks still
arrive immediately through their existing path. Explicit provider unloading sends Ollama's
`keep_alive: 0` release request; another client can independently reload a model.

Ollama's documented public API exposes resident snapshots, not an ongoing
resident-model event subscription. Core adds no timer polling. External changes
between observations, including idle eviction or another client's model load,
remain unobserved until a subsequent owned operation or explicit inspection.
There is also an upstream race between a snapshot and the following request;
these checks do not claim an atomic reservation of the daemon's model state.
Applications consume the shared provider lifecycle rather than treating a stale
idle snapshot as proof for their next inference. `Ollama.readiness()` remains a
service-connectivity result and does not establish selected-model readiness.

Upstream references: [resident models](https://docs.ollama.com/api/ps),
[model-name defaults and comparison](https://github.com/ollama/ollama/blob/main/types/model/name.go),
[preload response and resident-name handling](https://github.com/ollama/ollama/blob/main/server/routes.go),
[preload and retention](https://docs.ollama.com/faq#how-can-i-preload-a-model-into-ollama-to-get-faster-response-times).

## Browser llama.cpp provider

```js
import {createCoreLocalAIProvider} from 'arcane-os/ai/core-local';
import {getAIProviderRuntime} from 'arcane-os/ai-provider-runtime';

const provider = createCoreLocalAIProvider({client});
const runtime = getAIProviderRuntime();
const unregister = runtime.register(provider);
```

The provider implements `arcane-ai-provider/2` for the LLM role, with ID
`llama.cpp` by default. Configure an exact model through the existing provider
runtime, then load it. `catalog()`, `status()`, `inspect()`, `load()`, `request()`,
`unload()` and `dispose()` retain the shared lifecycle. Creating the provider
does not install software or select a model. A missing Core connection reports
unavailability, leaving browser Wllama/ONNX routes available for the application
to select.

Omit `client` to follow the installed Core client through
[`subscribeCoreClient`](core-client.md): construction may precede installation.
Each installation reads `llama.status` without selecting, downloading or loading
a model. Retirement or replacement synchronously revokes this provider's
`status().loaded`, cancels its owned operations and detaches the old lifecycle
listener. Late results cannot restore the retired selection. Explicitly load
the selection against the replacement client before inference. Passing a
`client`, including `null`, keeps that caller-supplied connection fixed.

`status()` is this provider's current state. The `arcane-ai-provider/2` contract
does not provide a provider-state subscription, so this installation handling
alone does not update an idle AI runtime's retained role state. The provider
runtime still reconciles the provider at its existing operation boundaries.
`inspect()` reports whether an explicit load can proceed, separately from
`status().loaded`. A genuine `starting` or `loading` service without an error
permits that load preflight even before its catalog arrives; Core's `llama.load`
waits for startup and verifies the exact requested model. An owned, successfully
released service permits loading only a model retained in its actual catalog.
An available service still requires that catalog membership. These observations
do not fabricate model records or readiness, and unavailable external services,
closed services and actual errors remain unavailable.

`dispose()` removes installation and service subscriptions and cancels owned
operations synchronously, then attempts its actually retained model's release
through its captured client. A configured selection alone does not own a native
model: disposing before load or after successful unload sends no native release,
including when the caller explicitly supplied `client: null`. A failed release
rejects with the actual error even though the provider is disposed; disposal
does not establish successful native unload.
It never unloads a retired selection through a replacement client or closes the
shared Core client.

If a router evicts the primary model while serving a request-specific model,
reload the primary selection before its next request. The provider does not
silently change the application's saved model choice. Release registration
with `unregister()` and dispose the provider at the application's owning
lifecycle boundary.

## Native ONNX sessions

```js
import {ensureLocalAIRuntimes} from 'arcane-os/local-ai';
import {createONNXRuntime} from 'arcane-os/local-ai/onnx';

const [runtime] = await ensureLocalAIRuntimes({
  runtimes: ['onnx'], directory: '.arcane/local-ai/runtimes'
});
const onnx = createONNXRuntime({modulePath: runtime.modulePath});
try {
  const loaded = await onnx.load({id: 'cheese-radar', model: absoluteModelPath});
  // Supply the actual names, shapes and values expected by this graph.
  const outputs = await onnx.run({id: loaded.id, feeds});
  console.log(outputs);
} finally {
  await onnx.close();
}
```

The factory accepts `{modulePath,signal?,onEvent?}` and starts no worker until
`load({id,model,sessionOptions?,executionPreference?,signal?})`. The model path is absolute for this
direct Node API. Session creation defaults to the CPU execution provider;
explicit native session options remain caller-owned. The returned session
record contains `id`, `model`, `state`, `loaded`, `error`, input/output names and
metadata. A live ID requires explicit unload before replacement. An ID may be
loaded again once its previous worker exits after a failed load or unload.
A run error retains the loaded session so a corrected request can use it.
`current().sessions[].exited` reports actual worker exit, independently of a
rejected load or inference. Unload joins worker exit and output delivery even
when requesting termination fails; complete cleanup errors remain observable.

Select `executionPreference: 'gpu'` to try the installed runtime's advertised
CUDA, TensorRT, DirectML, CoreML and WebGPU providers in that order, followed by
CPU when no accelerator session can be created. Discovery runs once per load;
each advertised candidate receives one actual session-creation attempt with CPU
available for graph nodes that the accelerator cannot handle. No provider is
downloaded by selection. The upstream `bundled` flag describes packaging and
does not exclude separately installed CUDA or TensorRT libraries. An explicit
`sessionOptions.executionProviders`, including an empty array, takes precedence
and is passed unchanged without automatic discovery or retries. Automatic
DirectML attempts default `enableMemPattern` to `false` and `executionMode` to
`'sequential'` as required by that provider; explicit caller values remain
unchanged, including on the final CPU attempt.

Automatic GPU selection adds an `execution` record to the loaded session and
its ordinary state events: `preference`, complete `supportedBackends`,
`selectedProviders`, ordered `attempts` with their full errors, `fallback`, and
`discoveryError`. Each attempt records `executionProviders`, `status`
(`configured` or `failed`), and `error`. `fallback: true` means the SDK created
the final CPU session after GPU preference, including when no GPU candidate was
advertised. Successful creation establishes an accepted provider configuration;
it does not establish that a GPU executed any graph nodes. If every attempt
fails, the load error retains the complete attempt errors and `execution`
record. Inference failures retain their existing behavior and do not replay
inference on another provider.

`run({id,feeds,fetches?,runOptions?,signal?})` returns the complete output-name
map of `{type,dims,data}` tensors. Input records use that same shape with native
typed data or string arrays. Optional `fetches` selects output names or supplies
output tensors using the upstream API. Worker transport copies supplied tensor
data; returned output records contain the results, and caller-owned preallocated
buffers are not mutated in place. Each session retains its own worker and
loaded graph; work for independent sessions proceeds concurrently. Runs for one
session execute in order and wait at that session's loading boundary. There is
no token streaming in the generic tensor operation.

String input containing U+0000 reports an incompatibility at the native tensor
boundary: the Node binding uses null-terminated strings and cannot preserve
that input completely. The SDK does not alter the supplied string.

`current()` returns `{sessions,closed}`. `subscribe(listener)` replays current
state synchronously and returns an unsubscribe function. Load, readiness,
unload and failures remain observable. `unload({id,signal?})` releases that
session; `close()` owns all remaining workers and awaits their actual exits.

Cancelling a queued run removes that run. Cancelling active native work stops
delivery and retires its worker; the session becomes unavailable until loaded
again. ONNX Runtime's Node binding offers no native inference interruption:
worker termination can wait for a native call to return. Shutdown observes the
actual exit and does not claim that rejecting a request stopped native work.
Other sessions retain their own lifetimes.

### ONNX through Core and the browser

| Core method | Parameters | Result |
| --- | --- | --- |
| `onnx.status` | `{}` | Runtime availability and current `models` session records |
| `onnx.load` | `{id,model,sessionOptions?}` | Loaded session; relative model paths resolve from `appRoot` |
| `onnx.run` | `{id,feeds,fetches?,runOptions?}` | Complete encoded tensor output map |
| `onnx.unload` | `{id}` | Released session record |

Use the browser accessor to handle the Core tensor transport:

```js
import {createCoreONNXRuntime} from 'arcane-os/ai/core-onnx';

const onnx = createCoreONNXRuntime({client});
const stop = onnx.subscribe(function showRuntime(state) { console.log(state); });
await onnx.inspect();
await onnx.load({id: 'cheese-radar', model: 'models/cheese-radar.onnx'});
const outputs = await onnx.run({id: 'cheese-radar', feeds});
await onnx.unload({id: 'cheese-radar'});
stop();
onnx.close();
```

The accessor exposes `load`, `run`, `unload`, `inspect`, `current`, `subscribe`
and `close`. Request methods accept `signal` and optional `timeoutMs` (default
`0`, no elapsed-time cutoff). It preserves full typed tensor values, including
64-bit integers, floating-point special values and strings, through the
transport codec. `current()` adds `busy` and `closed` to its latest Core state.
Closing the accessor cancels its requests and subscriptions; model unloading
is explicit because other accessors may share the Core session. It never
closes the shared Core client.

Omitting `client` follows Core installation events with current-client replay,
including installation after construction. Each new connection reads
`onnx.status`; it does not install a runtime or load a model. Retirement or
replacement immediately clears retained session readiness and cancels this
accessor's operations. Late old-client state and results are ignored. Passing
an explicit `client`, including `null`, retains caller ownership and does not
follow global installation changes. `close()` also removes the installation
subscription.

Construction neither opens a connection nor installs a runtime. A browser needs
an already available native Core service or the explicit development bridge.
Unavailable native ONNX leaves browser ONNX/Wllama under the application's
existing selection. This tensor API does not select an LLM, tokenizer, speech,
image or avatar pipeline.

Native ONNX CPU package targets are Windows, Linux and macOS on `x64`/`arm64`,
as listed in Microsoft's [Node binding platform matrix](https://github.com/microsoft/onnxruntime/blob/v1.30.0/js/node/README.md).
Android needs its host's native ONNX adapter; the Node package contains no
Android binding. Platform support here describes upstream package targets,
not execution evidence on each platform.

## Native bundling

The SDK portable native build includes selected official runtime trees under
`runtime/local-ai/<runtime-id>`. Runtime records in the artifact are relative
to the artifact root and resolve on the destination machine. The generated
Core entry composes the local AI service only when the application selects it.
Model files remain application-selected native resources.

`ensureLocalAIRuntimes()` and `bundleLocalAIRuntimes()` are exported from
`arcane-os/local-ai`. Both accept `{runtimes,directory,platform,architecture,
signal,onEvent}`; bundling also requires `outputRoot`. Platform names follow
Node: `win32`, `linux`, `darwin`, and supported Android distributions.
Architectures are `x64` or `arm64`. Availability depends on the upstream
runtime's published platform assets; Ollama has no official Android runtime
archive in this installer.

Ensure returns absolute `{id,version,platform,architecture,root}` records.
Server runtimes also include `executable`; ONNX includes `modulePath` pointing
to its public package entry. Image records include `libraryPath`,
`bindingModulePath`, requested `backend`, installed `variants` and selected
`models` metadata. Variant records carry backend, runtime root and library path.
Bundle returns `{runtimes,files}`,
with artifact-relative runtime paths and a complete emitted file inventory.
Bundling requires a fresh native staging destination, preserving existing
completed outputs.

Image assembly preserves the complete runtime/binding tree and relocates
library, binding and variant paths into the artifact. It retains original
model URL descriptors for preparation after launch. A model file already
inside the runtime tree becomes artifact-relative; an external native working
path reports its portability incompatibility. Use the explicit native-resource
workflow or [model-assets preparation](model-assets.md) for those files.
Model acquisition, context loading and inference remain separate from runtime
assembly. Platform availability depends on the selected upstream archive;
this contract does not establish execution on every supported host.

### NeMo Speech library runtime

The runtime helpers also accept `{id: 'nemo-speech', version: '0.2.0'}` to
prepare NVIDIA's official CPU library distribution. An omitted NeMo version
selects `0.2.0`. Its published targets are Windows `x64`, Linux `x64`/`arm64`,
and macOS `x64`/`arm64`.

NeMo records include `includeDirectory`, `libraryDirectory`, `binaryDirectory`,
and `cmakeDirectory`; they have no server `executable`. The complete upstream
tree remains under `root`, including any archive prefix directory. Use the
returned `cmakeDirectory` as `NeMoSpeech_DIR` when calling
`find_package(NeMoSpeech CONFIG REQUIRED COMPONENTS Diarization)`, then link
the upstream `NeMoSpeech::Diarization` target. Bundling preserves the complete
tree and makes all these paths relative to the native artifact root.

This helper installs the library. The application configuration and development
CLI select llama.cpp, Ollama and ONNX services described above;
NeMo model selection and a native diarization helper belong to their owning
integration.
