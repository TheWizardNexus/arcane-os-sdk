# SDXL Base 1.0 through Core

The `sdxl-base-1.0` model definition selects Stability AI's complete SDXL Base
1.0 checkpoint for text-to-image generation and whole-image img2img through the
shared [local image runtime](local-image-generation.md). Applications supply their
own complete prompts and own the resulting images and saved associations.
The model uses the shared retained native context, progress, cancellation
and complete PNG result contract.

## Model selection

Select this runtime record under `native.localAI` in `arcane-app.json`, or
the corresponding package projection's `localAI` record:

```json
{
    "runtimes": [
        {
            "id": "stable-diffusion.cpp",
            "version": "master-929-3f8527a",
            "backend": "auto",
            "models": ["sdxl-base-1.0"]
        }
    ]
}
```

The built-in ID supplies the cohesive `SDXL_BASE_1_0_MODEL` definition from
`src/local-ai/image-models/sdxl.mjs`. The shared service exposes its resource
metadata through `image.status` and `images.inspect()`.

Backend discovery, accelerated-device selection and CPU fallback belong to
the shared runtime. This model definition leaves `context` empty and adds no
device or precision override. Available acceleration depends on the selected
runtime distribution; see the shared guide's platform availability. Model
selection alone does not establish actual execution on any device.

## Prepare the checkpoint and generate an image

The single `model` resource is the official
[`sd_xl_base_1.0.safetensors` checkpoint](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/462165984030d82259a11f4367a4eed129e94a7b/sd_xl_base_1.0.safetensors)
at revision `462165984030d82259a11f4367a4eed129e94a7b`. It includes the text
encoders, denoiser and original VAE. Generation and whole-image editing use this
one resource; a refiner, separate VAE, LoRA or Python converter is unnecessary for
this selection. The upstream model carries the
[CreativeML Open RAIL++-M license](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/462165984030d82259a11f4367a4eed129e94a7b/LICENSE.md).

The existing DBOPFS model store owns the authoritative download. The shared
[model-assets service](model-assets.md) prepares complete native working files
when the application loads the model. Installing the native runtime does not
download a second model copy.

This example extends the shared generation guide. It uses an existing `images`
accessor, DBOPFS-backed `modelStore`, application-selected `workingDirectory`
and request `signal`:

```javascript
import {createBrowserModelSource} from 'arcane-os/ai/browser-wasm';
import {prepareCoreModelAssets} from 'arcane-os/ai/core-model-assets';

const selected = (await images.inspect({signal})).models.find(
    function selectedSDXL(model) {
        return model.id === 'sdxl-base-1.0';
    }
);
const resource = selected.resources.model;
const source = createBrowserModelSource({
    id: selected.id,
    files: [{name: resource.filename, url: resource.url}]
});
const stored = await modelStore.ensure(source, {signal});
const projection = await prepareCoreModelAssets({
    workingDirectory,
    members: source.files.map(function workingMember(member, index) {
        return {path: member.name, file: stored.files[index]};
    }),
    signal
});

try {
    await images.load({
        model: selected.id,
        assetProjectionId: projection.id,
        resourcePaths: {model: resource.filename},
        signal
    });
} finally {
    await projection.release();
}

const result = await images.generate({
    model: selected.id,
    prompt: 'An octopus librarian shelving tiny books inside a glass submarine.',
    signal
});
// Display result.images using the shared guide's Blob preview example.
```

Change the prompt to request another scene. The model defaults to a
1024-by-1024 canvas; pass `parameters: {width, height}` to select other native
dimensions. Display or save every returned image using its actual width and
height. Each result contains the complete PNG Blob.

Successful loading retains the working projection in the native model owner.
Releasing the caller's preparation handle preserves that native retain.
Repeated generation reuses the loaded context; unload it when the application
no longer needs it. Follow the shared lifecycle contract for request
cancellation, state subscriptions, unloading and accessor closure.

## Edit a whole image

After loading the same model, pass an original PNG and an explicit strength to
the existing public accessor. `originalPNG` is the application's PNG Blob or
File; the application retains it and decides whether to save the new result.

```javascript
const edited = await images.edit({
    model: 'sdxl-base-1.0',
    image: originalPNG,
    prompt: 'The octopus librarian now wears a purple knitted diving helmet.',
    strength: 0.6,
    signal
});
// Display edited.images using the same complete PNG Blob result contract.
```

This is whole-image img2img, using the checkpoint's embedded VAE encoder,
denoiser and decoder. It needs no additional model resource, adapter or engine.
The operation reuses the same loaded context and progress/cancellation owners
as generation. The SDK forwards the complete prompt and original PNG; it does
not add style instructions or save either the request or result.

The model still defaults to a 1024-by-1024 canvas. Supply
`parameters: {width, height}` when choosing another output canvas; input
dimensions do not silently replace that selection. The native engine adapts
the initial raster to the selected canvas and denoises the whole image.
Framing, texture, identity and individual pixels are model results, not
preservation guarantees. Strength zero is not an exact-copy operation, and
the RGB model does not preserve alpha. See the shared
[editing contract](local-image-editing.md) for supported PNG encodings,
native preprocessing, full-result handling and cancellation.

## Defaults and operation scope

Only canvas dimensions are model-specific defaults here. Sampling parameters
remain owned by the selected native engine and can be supplied through
`parameters.sample_params`. At `master-929-3f8527a`, SDXL resolves the native
default sampler to Euler A and scheduler to discrete, with 20 steps and CFG 7.
These are native defaults; Stability AI's separate base-plus-refiner example
and Python pipeline have their own sampling configuration.

The selected engine has an explicit path for SDXL's embedded original VAE,
including its native convolution scaling. The model definition leaves that
treatment with the engine and supplies no guessed weight-type override or
separate VAE checkpoint. Output quality, speed and device behavior depend on
the actual selected runtime and generation parameters.

The SDK forwards the complete caller prompt to the native API. The engine
applies its own text conditioning and prompt-weighting syntax; see the shared
guide for native string-boundary limitations. The SDK adds no avatar wording,
style instructions or application-specific content.

This definition advertises `txt2img` and `img2img`. Masked and reference-image
editing are separate operations with their own model and runtime requirements;
this base selection does not advertise them.

The model resource and standalone use follow the
[official model card](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/462165984030d82259a11f4367a4eed129e94a7b/README.md).
Native defaults and embedded-VAE behavior follow the selected engine's
[request implementation](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/src/pipeline/request.cpp),
[parameter initialization](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/src/stable-diffusion.cpp)
and [model construction](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/src/pipeline/model_builders.cpp).
The pinned [image pipeline](https://github.com/leejet/stable-diffusion.cpp/blob/3f8527a/src/pipeline/image.cpp)
encodes the initial image, samples its latent and decodes the result. That
implementation establishes the operation path; source inspection alone does
not establish execution, output quality or device performance.
