# Local image generation through Core

The SDK's local image service runs selected stable-diffusion.cpp models in a
retained native context. The browser uses Core for model lifecycle and complete
PNG results. Applications own image prompts, style choices, character identity,
associations and saved results.

The same public runtime also exposes whole-image `edit()` for an original PNG,
complete prompt and explicit strength. It reuses this model/context lifecycle;
applications retain the original and choose whether to save the separate
result. See [local image editing](local-image-editing.md) for supported inputs,
lossless transport, native preprocessing and cancellation.

Runtime installation, model asset preparation, model loading and image
generation are separate operations. The service starts promptly and retains
runtime preparation in the background. `image.status` remains callable during
preparation; rendering and unrelated Core services continue independently.

## Selection and model assets

Select the runtime in `arcane-app.json` under `native.localAI`, or in the
corresponding package projection's `localAI` record:

```json
{
    "runtimes": [
        {
            "id": "stable-diffusion.cpp",
            "version": "master-929-3f8527a",
            "backend": "auto",
            "models": ["sd14"]
        }
    ]
}
```

`sd14` selects the Stable Diffusion 1.4 definition and its official
`sd-v1-4.ckpt` resource. A model definition contains `id`, `name`, `family`,
`resources`, `context`, `defaults` and `operations`. Selection supplies the
model's resource metadata; runtime installation does not independently download
or bundle model files. The shared model asset owner prepares selected browser
assets and supplies a Core working projection for native path-based loading.

`flux2-klein-4b` selects the three-resource distilled FLUX.2 Klein definition.
Its [family guide](local-image-flux.md) covers diffusion/VAE/Qwen preparation,
four-step defaults and the advertised `txt2img` operation. Keep each model's
supported operations distinct: selecting FLUX does not enable reference-image
editing or imply the same input path as SD1.4 img2img.

`sdxl-base-1.0` selects the complete SDXL Base checkpoint, including its text
encoders and original VAE. Its [family guide](local-image-sdxl.md) covers the
single model resource, 1024-by-1024 default canvas and native sampling defaults.
It advertises `txt2img` and whole-image `img2img` through the same public
`edit()` operation, using the checkpoint's embedded VAE and retained context.

The first published distribution path selects CPU on Windows and Linux.
On macOS, `auto` selects the same upstream universal runtime's built-in Metal
backend, with CPU fallback; explicit `cpu` remains available. A caller-supplied
runtime archive with `backend: 'auto'` uses its available accelerated device
with CPU fallback. Built-in Windows CUDA distribution preparation is a separate
pending addition. Actual backend/device availability and failures
come from the runtime, separately from hardware metadata or an installed archive.
Cancellation, invalid model input and inference failures retain their actual
errors. Model loading has no native cancellation handle before its constructor
returns; cancellation joins that call and releases its returned context before
the operation settles.

The complete prepared projection has an `id`, a `directory`, a `members` list
and `release()`. `resourcePaths` maps native model resource roles to exact
projection member paths. For the selected checkpoint, the role is `model`.
The member name must match the preparation result. See
[Model assets through Core](model-assets.md) for the shared preparation
lifecycle. Core acquires its own
retain before loading. The caller can release its preparation ownership after
successful `load()` acknowledgement: Core retains the files while its native
context needs them. Release caller ownership when loading fails too; native
cleanup keeps its own retain through actual completion. A later
`generate({model: 'sd14', ...})` reuses that prepared selection. Replacing or
unloading the context releases displaced projections
after actual native operations settle. Core shutdown joins owned operations
before releasing retained model files.

`model` also accepts a complete prepared model descriptor. Native callers can
supply actual resource paths directly. The browser projection arguments supply
the native paths through the shared asset service and preserve the remaining
descriptor fields. The image service creates no second model downloader or
durable model store.

## Browser accessor

```js
import {createCoreImageRuntime} from 'arcane-os/ai/core-image';
import {prepareCoreModelAssets} from 'arcane-os/ai/core-model-assets';
import {createBrowserModelSource, createDbopfsModelStore} from 'arcane-os/ai/browser-wasm';

const page = new AbortController();
window.addEventListener(
    'pagehide',
    function detachImagePage() {
        page.abort();
    },
    {once: true}
);

const images = createCoreImageRuntime(
    {signal: page.signal}
);

images.subscribe(
    function showImageStatus(snapshot) {
        statusElement.textContent = snapshot.status ?? snapshot.state;
    }
);

const selected = (await images.inspect()).models.find(
    function selectedCheckpoint(model) {
        return model.id === 'sd14';
    }
);
const resource = selected.resources.model;
const source = createBrowserModelSource(
    {
        id: selected.id,
        files: [
            {name: resource.filename, url: resource.url}
        ]
    }
);
const store = createDbopfsModelStore(
    {dbopfs, downloadConcurrency: 4}
);
const stored = await store.ensure(
    source,
    {signal: page.signal, offline: false}
);
const projection = await prepareCoreModelAssets(
    {
        workingDirectory: '.arcane/model-working',
        members: source.files.map(
            function preparedCheckpoint(member, index) {
                return {path: member.name, file: stored.files[index]};
            }
        ),
        signal: page.signal
    }
);

try {
    await images.load(
        {
            model: 'sd14',
            assetProjectionId: projection.id,
            resourcePaths: {
                model: 'sd-v1-4.ckpt'
            },
            signal: page.signal
        }
    );
} finally {
    await projection.release();
}

const result = await images.generate(
    {
        model: 'sd14',
        prompt: 'Portrait of a dignified raccoon astronaut holding a tiny moon cactus.',
        signal: page.signal,
        onProgress(progress) {
            console.log(progress);
        }
    }
);

for (const image of result.images) {
    const url = URL.createObjectURL(image.blob);
    const preview = new Image();
    preview.alt = 'Generated raccoon astronaut portrait';
    function releasePreviewURL() {
        URL.revokeObjectURL(url);
    }
    preview.addEventListener(
        'load',
        releasePreviewURL,
        {once: true}
    );
    preview.addEventListener(
        'error',
        releasePreviewURL,
        {once: true}
    );
    preview.src = url;
    imageContainer.append(preview);
}
```

The example uses the application's existing `dbopfs` instance and existing
`statusElement` and `imageContainer` elements. The published model store accepts
the selected checkpoint as an ordinary resource: `ensure()` returns complete
ordered `Blob` or `File` members after its resumable download. Range support
allows concurrent transfer within a member; those transfer parts remain the
store's concern. Use `offline: true` to require an already complete stored model.
The store does not select or run the image engine. In source development,
use the development Core bootstrap described
in [Local AI through Core](local-ai.md#development). The accessor can be
constructed before that client is installed; perform model operations once
the service is available. Native hosts install their Core client through the
existing host path.
An ordinary browser without Core reports local image generation as unavailable.

| Member | Contract |
|---|---|
| `createCoreImageRuntime({client?, signal?, onEvent?})` | Follows Core installation and lifecycle events by default, asynchronously reading status for each client. An explicit `client`, including `null`, remains caller-owned. It returns immediately. |
| `load({model, context?, assetProjectionId?, resourcePaths?, signal?})` | Loads the selected model and returns authoritative service state after native completion. `context` supplies native context options. |
| `generate({model, prompt, parameters?, assetProjectionId?, resourcePaths?, signal?, onProgress?})` | Returns the complete result with `images: [{blob, mediaType, width, height}]`. Additional runtime result metadata remains present. |
| `unload({signal?})` | Explicitly unloads the shared selected native context and returns its resulting state. |
| `inspect({signal?})` | Reads current Core status without waiting for model or runtime preparation. |
| `current()` | Synchronously returns the retained lifecycle snapshot and this accessor's transient request status. |
| `subscribe(listener, {replay = true, signal?})` | Observes `image.state` and immediately replays the current snapshot by default; returns an unsubscribe function. |
| `close()` | Cancels this accessor's requests, removes subscriptions and joins its request promises. It leaves the shared Core client and selected model under their existing owners. |

Generation publishes `status: 'Thinking'` synchronously when accepted, before
transport, preparation, model loading or inference waits. This remains transient
status until the complete image result arrives. Native sampling progress is
reported as progress, with no fabricated image chunks or conversation turns.
The accessor's `requests` records contain method, stream ID, status and progress;
they contain no saved prompt or image history.

The authoritative lifecycle snapshot includes `selectedModel`, `loaded`,
`state`, `backend`, `progress`, `error`, native resource paths and device state.
Service metadata adds runtime `id`, installation/availability state and selected
model definitions, including their resource metadata before engine preparation
finishes. Installed files do not imply a loaded model. A late status
response never overwrites a newer lifecycle event.

With `client` omitted, the accessor consumes the shared
[`subscribeCoreClient`](core-client.md) installation stream. A late installation
attaches the service listener and reads current status; it never installs an
engine or loads a model. Retirement or replacement synchronously clears
readiness and transient `Thinking`, cancels owned requests and detaches the
retired service listener. Old state, progress and results cannot update the
replacement connection. `close()` also removes the installation subscription;
it does not claim that the shared native model was unloaded.

Prompts and parameters pass unchanged to the native runtime. Native option
names, supported model operations and defaults belong to that runtime and the
selected model definition. A prompt containing U+0000 or an unpaired UTF-16
surrogate cannot pass unchanged through the native UTF-8 C-string boundary and
reports that incompatibility.

The request signal propagates through Core to the owning native operation.
Aborted requests produce no late image result or progress callback. Request
invocations use `timeoutMs: 0`; there is no arbitrary image-generation timeout.
Errors retain their actual details on rejected promises and diagnostic events.
Applications choose concise ordinary status text and keep complete engineering
details in their diagnostic surface, outside durable chat history.

`onEvent` observes `image.state`, `image.progress`, `image.request`,
`image.result` and `image.error` records. Observer failures are reported to the
developer console and do not replace inference results. Observers own their
asynchronous callback lifetimes. The SDK persists no prompt, result, transcript
or application-owned image association.

## Core service and transport

`createLocalImageService(configuration, options)` is exported from
`arcane-os/core/image`. `configuration` is the selected `localAI` record.
Options are `appRoot`, installed `runtimes`, `signal`, `onEvent`, an optional
`prepare` callback and the existing `modelAssets` service instance.

`prepare({appRoot, configuration, requirement, signal, onEvent})` returns one
installed runtime record. Preparation runs once per service. That record carries
`libraryPath`, `bindingModulePath`, `backend`, `variants` and model definitions.
Runtime variants preserve their native backend, library path and runtime root.
The service retains one native runtime and subscribes to its current-state
replay. Expensive model execution belongs to that runtime's worker.

| Method/event | Parameters or result |
|---|---|
| `image.status` | Immediate lifecycle snapshot. |
| `image.load` | `{model, context?, assetProjectionId?, resourcePaths?}`; returns lifecycle snapshot. |
| `image.generate` | `{model, prompt, parameters?, streamId?, assetProjectionId?, resourcePaths?}`; returns complete encoded images. |
| `image.unload` | Empty parameters; returns lifecycle snapshot after unload. |
| `image.state` | Complete service lifecycle snapshot. Service and browser `subscribe()` provide current-state replay. |
| `image.progress` | `{streamId, requestId, status: 'Thinking', progress}` for the corresponding generation request. |

Core's JSON transport represents each complete PNG as
`{data, encoding: 'base64', mediaType: 'image/png', width, height}`. The browser
decodes that complete representation into a `Blob` and preserves its metadata.
There is no result resizing, clipping, storage write or application policy at
this transport boundary.

One service prepares one selected runtime, retains one selected native context
and performs one native generation per request. The native owner serializes
only competing operations on that context. Independent Core services and page
rendering remain concurrent. Native platform execution evidence and package
publication are separate from this source/API description.
