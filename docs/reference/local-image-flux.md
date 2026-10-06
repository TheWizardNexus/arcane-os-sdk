# FLUX.2 Klein 4B through Core

The `flux2-klein-4b` model definition selects distilled FLUX.2 Klein 4B for
text-to-image generation through the shared
[local image runtime](local-image-generation.md). It uses the same retained
native context, progress, cancellation and complete PNG result contract as
other selected image models. Applications own prompts, image associations and
saved results.

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
            "models": ["flux2-klein-4b"]
        }
    ]
}
```

The definition is a single `FLUX2_KLEIN_4B_MODEL` record in
`src/local-ai/image-models/flux.mjs`. The built-in model ID supplies that record
through normal runtime configuration; the shared service exposes its resource
metadata through `image.status` and `images.inspect()`.

Backend selection belongs to the shared runtime. This definition adds no CPU
offload setting or device override. `auto` uses the available runtime's
accelerated backend with CPU fallback; actual support depends on the installed
runtime distribution. See the shared guide for platform distribution
availability. Selecting the model does not establish that it has loaded or run
on a GPU, CPU or NPU.

## Required model resources

Prepare all three resources together. They are complementary parts of one
model pipeline, rather than three independent image generators.

| Native role | Resource | Purpose |
| --- | --- | --- |
| `diffusion_model` | [flux-2-klein-4b.safetensors](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve/e7b7dc27f91deacad38e78976d1f2b499d76a294/flux-2-klein-4b.safetensors) | Distilled image generation model. |
| `vae` | [`full_encoder_small_decoder.safetensors`](https://huggingface.co/black-forest-labs/FLUX.2-small-decoder/resolve/a3efc24f613ef42d9428af62fdbd6f5fd8856c4a/full_encoder_small_decoder.safetensors) | Complete image encoder and the smaller FLUX.2 decoder. |
| `llm` | [Qwen3-4B-Q8_0.gguf](https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/bc640142c66e1fdd12af0bd68f40445458f3869b/Qwen3-4B-Q8_0.gguf) | Qwen3-4B text conditioning inside the image engine. |

The selected upstream records identify these resources as Apache-2.0. The
engine supplies its embedded Qwen tokenizer. This definition needs no separate
tokenizer download, chat server or LoRA. The full encoder in the selected VAE
also retains the model's image-encoding capability; a decoder-only file is a
different resource.

The existing DBOPFS model store owns authoritative model files and resumable
downloads. The shared [model-assets service](model-assets.md) prepares complete
native working files. Runtime installation does not download another copy of
these models. Resource roles map to the exact filenames returned by that
preparation.

The following extends the shared generation guide. It uses an existing
`images` accessor, DBOPFS-backed `modelStore`, application-selected
`workingDirectory` and request `signal`:

```javascript
import {createBrowserModelSource} from 'arcane-os/ai/browser-wasm';
import {prepareCoreModelAssets} from 'arcane-os/ai/core-model-assets';

const selected = (await images.inspect({signal})).models.find(
    function selectedKlein(model) {
        return model.id === 'flux2-klein-4b';
    }
);
const resources = Object.entries(selected.resources);
const source = createBrowserModelSource({
    id: selected.id,
    files: resources.map(function modelFile([role, resource]) {
        return {name: resource.filename, url: resource.url};
    })
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
        resourcePaths: Object.fromEntries(
            resources.map(function nativeRole([role, resource]) {
                return [role, resource.filename];
            })
        ),
        signal
    });
} finally {
    await projection.release();
}

const result = await images.generate({
    model: selected.id,
    prompt: 'A dignified raccoon astronaut watering a moon cactus in a teacup.',
    parameters: {width: 768, height: 768},
    signal
});
// Display result.images using the shared guide's Blob preview example.
```

Change the prompt to request another scene and the dimensions to select its
canvas. Successful loading retains the working projection inside the native
model owner; releasing the caller's preparation handle leaves that native
retain intact. Repeated generation reuses the loaded context. Explicitly
unload it when the application no longer needs it, following the shared
lifecycle contract.

## Defaults and model behavior

The definition supplies four sampling steps, the Euler sampler and
`sample_params.guidance.txt_cfg: 1`. Omitted native options retain their native
initializer defaults, including automatic FLUX.2 scheduler selection. These
settings belong to the distilled 4B checkpoint; the separate Klein base and
9B variants have their own model requirements.

The native default canvas is 512 by 512. Klein's native preparation aligns
dimensions upward to multiples of 16; use the returned image dimensions when
displaying or saving results. The example already selects aligned dimensions.
At the default CFG value of 1, the native text-to-image path does not apply
negative-prompt conditioning.

The SDK forwards the caller's complete prompt to the native API. The engine
then applies its prompt-weighting syntax and Qwen conditioning format.
Parentheses and brackets can affect weighting. The selected native API has no
public switch for literal text conditioning, so exact SDK transport does not
imply literal interpretation by the model. The shared guide describes inputs
that cannot pass unchanged through its native C-string boundary.

This definition advertises `txt2img`. The upstream Klein model also supports
reference-image editing, while the SDK's separate whole-image `img2img`
operation uses a different input path. Reference editing becomes an SDK
capability when the shared runtime implements its reference-image dispatch;
selecting this model alone does not add that operation.

These settings and resource roles follow the
[tagged FLUX.2 instructions](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/docs/flux2.md),
the [official Klein model](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B),
the [official small decoder](https://huggingface.co/black-forest-labs/FLUX.2-small-decoder)
and the [official Qwen model files](https://huggingface.co/Qwen/Qwen3-4B-GGUF).
