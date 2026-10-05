# Local AI through Core

Core owns native llama.cpp and Ollama processes. The browser retains its own
Wllama and ONNX implementations, and can also use an explicitly connected Core
when that system service is available. Runtime installation, model loading and
inference are separate operations.

This native service currently implements llama.cpp and Ollama. Native ONNX
inference remains separate unfinished work. Browser ONNX continues through its
existing browser implementation.

## Application requirements

Declare required native runtimes in `arcane-app.json` under `native.localAI`.
The package projection retains the same record as `arcane-package.json.localAI`.
Existing native fields remain alongside this record:

```json
{
  "runtimes": [
    {"id": "llama.cpp"},
    {"id": "ollama"}
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
optional runtime archive `url`. A string runtime ID is also accepted.
Omitting the version allows reuse of an available runtime. Explicit versions
select that upstream distribution; an existing service must match the requested
version before it is reused. A service occupying the selected address is
preserved when its version cannot be established.

`llamaCpp` accepts `url`, `model`, `modelsDirectory`, and an `args` string array.
`model` selects a single GGUF file; `modelsDirectory` selects llama.cpp router
mode. Paths resolve from the application root. Ollama accepts `url`,
`modelsDirectory`, and `args`. The default endpoints are
`http://127.0.0.1:8080` and `http://127.0.0.1:11434`, respectively. Default model
directories are `.arcane/models/llama.cpp` and `.arcane/models/ollama` inside the
application. Applications choose and provision their models explicitly.

## Development

```sh
arcane dev --local-ai llama.cpp,ollama
```

The option adds those runtime requirements to the authored application
configuration. Subsequent `arcane dev` runs reuse the saved requirements.
Development checks selected endpoints and existing executable paths, then
installs missing runtimes under the application's `.arcane/local-ai/runtimes`.
Runtime preparation runs alongside HTTP serving. Browser rendering continues
while installation and model readiness are pending.

The SDK downloads the official llama.cpp or Ollama distribution directly and
preserves its runtime libraries. Installation changes no global PATH, system
service or machine environment. Windows and macOS use the host archive utility;
Linux requires `tar`, and `unzip` when extracting a selected Windows ZIP.
Zstandard archives use the supported Node runtime's decompressor.

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
means installation and Core composition completed. Runtime/model readiness is
reported separately by Core status and lifecycle events. Preparation failures
remain on that promise and the operation event stream.

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

`localai.status` returns `{runtimes}` and, when Ollama is selected, the existing
`ollama` and `models.ollama` catalog fields. Runtime records distinguish
`installed`, `available`, `state`, `models`, ownership and errors. A listening
service and a loaded model are separate facts.

`localai.services.recover({runtimes: ['llama.cpp']})` makes one explicit recovery
attempt for the selected runtimes; omission selects all configured runtimes.
Recovery restarts only SDK-owned processes and reconnects to external services.
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
a subsequent load can start it again. Releasing an externally owned direct
server returns `released: true, unloaded: false`, retaining the real catalog
and leaving that server running.

Ollama retains the existing Core calls for `version`, `models`/`list`, `running`,
`show`, `chat`, `generate`, `embed`, `pull`, `push`, `create`, `copy`, and `delete`.
Those methods use Ollama's native API. Streaming uses the existing
`ollama.chunk: {streamId,chunk}` event. Application/OS preference operations
such as selection, settings and brain creation remain with their existing
owners; they are separate from this runtime service.

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

If a router evicts the primary model while serving a request-specific model,
reload the primary selection before its next request. The provider does not
silently change the application's saved model choice. Release registration
with `unregister()` and dispose the provider at the application's owning
lifecycle boundary.

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

Ensure returns absolute `{id,version,platform,architecture,root,executable}`
records. Bundle returns `{runtimes,files}`, with artifact-relative runtime paths
and a complete emitted file inventory. Bundling requires a fresh native staging
destination, preserving existing completed outputs.
