# Local image edit inputs

The SDK input decoder prepares a PNG raster for the shared native image
runtime. Decoding does not load a model or perform inference. The runtime owns
model selection, supported editing operations, native calls and their complete
results. Applications retain the original image and decide whether to save a
newly generated result.

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

Whole-image img2img uses an initial image, prompt and strength. Masked editing
adds a separate mask; instruction/reference editing uses a model that supports
reference conditioning. These are distinct operations and must be advertised
only when the selected model and native path implement them. Ordinary img2img
does not require LoRA training. The candidate engine documents this directly
with its base SD1.4 model in the
[tagged img2img example](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/docs/sd.md#img2img-example).

Source dimensions are decoder output, not an implicit request to change the
generation dimensions. The model owner documents its actual canvas adaptation
and reports actual output dimensions. In the candidate engine, temporary
initial images use model preprocessing while caller images remain unchanged;
even `mode=none` does not suppress all later model adaptation. See the
[native preprocessing contract](https://github.com/leejet/stable-diffusion.cpp/blob/master-929-3f8527a/docs/image_preprocessing.md).

An RGB-only model such as the selected SD1.4 candidate consumes the stored RGB
and does not preserve alpha. The SDK must not silently choose a compositing
background or claim that passing RGBA preserves its displayed appearance.
Strength zero is also not an exact-copy operation: native img2img still uses
the model's encode, sampling and decode path. These model behaviors are
separate from the decoder preserving the original input.
