# Local image editing through Core

`createCoreImageRuntime()` exposes whole-image img2img through `edit()`, using
the same retained native context as generation. The selected SD1.4 model
advertises `txt2img` and `img2img`. Applications supply the original PNG, the
complete prompt and explicit strength, retain the original, and decide whether
to save the separate generated result.

## Browser accessor

Prepare and load the selected model using the
[shared generation and model-asset lifecycle](local-image-generation.md).
Then pass a generated PNG Blob or a supported PNG File directly:

```js
import {createCoreImageRuntime} from 'arcane-os/ai/core-image';

const images = createCoreImageRuntime({signal: page.signal});
images.subscribe(function showImageStatus(snapshot) {
    statusElement.textContent = snapshot.status ?? snapshot.state;
});

const result = await images.edit({
    model: 'sd14',
    image: originalPNG,
    prompt: 'A dignified raccoon astronaut wearing a purple knitted helmet, holding a tiny moon cactus.',
    strength: 0.6,
    parameters: {
        width: 512,
        height: 512,
        sample_params: {sample_steps: 20}
    },
    signal: page.signal,
    onProgress(progress) {
        console.log(progress);
    }
});

const editedPNG = result.images[0].blob;
```

The example uses the application's existing `page` AbortController,
`statusElement` and original `originalPNG` Blob or File. It assumes that the
selected model has already been loaded. `edit()` can also prepare a selected
model on demand using the same `assetProjectionId` and `resourcePaths` fields
as `generate()`.

| Member or field | Contract |
| --- | --- |
| `edit({model, image, prompt, strength, parameters?, assetProjectionId?, resourcePaths?, signal?, onProgress?})` | Returns the complete result with `images: [{blob, mediaType, width, height}]`, preserving additional runtime result metadata. |
| `image` | Original complete PNG `Blob` or `File`, with `image/png` or an empty declared media type. Supported PNG encodings are listed below. |
| `prompt` | Complete caller-authored string, passed unchanged. Native C-string incompatibilities retain the generation error contract. |
| `strength` | Explicit finite number from `0` through `1`, mapped to native img2img strength. It takes precedence over a model default or `parameters.strength`; it is never clamped. |
| `parameters` | Native generation options, including canvas dimensions, seed, sampling and `image_preprocess`. The top-level image supplies native `init_image`; the top-level strength supplies native `strength`. Other options retain the generation contract. |

`Thinking` is published synchronously when the browser accepts the edit, before
reading the Blob, sending the request, preparing the runtime or loading the
model. Native sampling progress uses the existing progress surface. Complete
PNG results arrive after native completion; the SDK fabricates no image chunks
or assistant turns. Closing the accessor cancels and joins its requests while
preserving the shared Core client and model ownership.

The original encoded input is preserved through lossless Core JSON framing.
The browser does not decode, draw, re-encode, resize, crop, composite or save it.
The request signal reaches input preparation, worker decoding and cooperative
native cancellation. Cancellation during `Blob.arrayBuffer()` is observed
after that platform operation completes. An aborted edit produces no late
success or progress callback. Request invocation retains `timeoutMs: 0`.

## Core and native request

The `arcane-os/core/image` service adds `image.edit` with
`{model, image, prompt, strength, parameters?, streamId?, assetProjectionId?, resourcePaths?}`.
At this JSON boundary only, `image` is
`{data: completeBase64PNG, encoding: 'base64', mediaType}`. The service emits
the existing accepted `image.progress` event before preparation, then forwards
the decoded transport content to the shared image worker. Results use the
same complete PNG transport records as `image.generate`.

The native runtime's `edit()` takes the same operation fields, with
`image: {data: Uint8Array, mediaType}` and no Core projection arguments.
It copies the supplied data view at acceptance so caller reuse cannot change
an input waiting behind another operation.
The worker decodes once, loads or reuses the exact selected context, and passes
the raster as native `init_image` with explicit `strength`. The existing native
binding retains input memory through completion and copies complete output
rasters before native cleanup. The same queue, cancellation, unload and close
owners serve generation and editing; no second engine or model store is created.

Unreadable or unsupported input rejects the edit without substituting an
image. Errors retain their complete details on rejected promises and diagnostic
events. Applications keep those engineering diagnostics outside ordinary status
surfaces and durable chat history. No prompt, input or result is persisted by
this operation.

## Decoder contract

`src/local-ai/image-editing.mjs` exports the internal worker function
`decodeImage({data, mediaType, signal})`.

| Field | Contract |
| --- | --- |
| `data` | Complete encoded PNG in a `Uint8Array`; a Node `Buffer` is also accepted. Only the supplied view is read. |
| `mediaType` | `image/png`, an empty string, or omitted. The PNG signature is read from the actual input. Other declared formats report unsupported input. |
| `signal` | Optional `AbortSignal` belonging to the image request. |

The promise returns `{width, height, channel, data}`. Dimensions come from the
source raster; `channel` is `3` for RGB or `4` for RGBA. Returned `data` is a
separate contiguous `Uint8Array` containing interleaved samples, with pixels
ordered left to right and rows ordered top to bottom. The native request owner
retains this allocation until the native operation actually completes,
including after a cancellation request.

Input decoding accepts static, non-interlaced, 8-bit RGB and RGBA PNGs, all
five PNG row filters, and image data spread across multiple `IDAT` chunks.
RGB transparent-color information is represented as RGBA. An optional suggested
palette on an RGB or RGBA image does not change its color type.

Indexed-color, grayscale, 16-bit, interlaced and animated PNGs currently report
unsupported input. JPEG and WebP are also unsupported by this decoder. The
decoder does not silently convert those formats or select one animation frame.

The original encoded image is copied for the operation and never modified or
detached. Decoding preserves stored color samples and straight alpha, including
RGB values underneath transparent pixels. It does not composite onto a chosen
background, rotate pixels from metadata, apply a color-profile conversion,
resize, crop or create a file. Metadata remains in the original image; the
native raster record contains pixels and dimensions only.

## Execution and cancellation

Invoke the decoder inside the shared image runtime's existing worker.
Inflation uses asynchronous Node zlib. Row reconstruction yields between
scanlines so the worker can receive cancellation. An abort during inflation is
observed after that native operation settles; it does not claim instant
interruption. A cancelled decode returns no raster for inference.

`ARCANE_IMAGE_INPUT_UNSUPPORTED` describes an unavailable input format or
encoding. `ARCANE_IMAGE_DECODE_FAILED` describes unreadable PNG structure or
scanlines. Node zlib failures retain their complete original errors, and
cancellation retains the owning signal's reason or Node `AbortError`. A decode
failure never returns partial imagery or substitutes a different image.

## Editing semantics at the native owner

Whole-image img2img uses an initial image, prompt and strength. This `edit()`
contract selects that operation. Masked and reference editing require their
own model-specific contracts and are outside this PNG img2img operation.
Ordinary img2img does not require LoRA training. The selected engine documents
this directly with its base SD1.4 model in the
[tagged img2img example](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/docs/sd.md#img2img-example).

Source dimensions are decoder output, not an implicit request to change the
generation dimensions. The engine center-crops and resizes temporary initial
images to the selected canvas by default and reports actual output dimensions.
Caller images remain unchanged;
even `mode=none` does not suppress all later model adaptation. See the
[native preprocessing contract](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/docs/image_preprocessing.md).

An RGB-only model such as the selected SD1.4 consumes the stored RGB
and does not preserve alpha. The SDK must not silently choose a compositing
background or claim that passing RGBA preserves its displayed appearance.
Strength zero is also not an exact-copy operation: native img2img still uses
the model's encode, sampling and decode path. These model behaviors are
separate from the decoder preserving the original input.
