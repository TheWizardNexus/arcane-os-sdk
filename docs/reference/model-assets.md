# Native working files from stored model assets

The selected `0.60.0` package contains the model-assets helpers as internal
preparation. The public imports and Core registration shown below belong to
the pending local-image integration and are unavailable through `0.60.0`.
These examples document that integration's intended public contract.

`prepareCoreModelAssets()` streams complete browser `File` or `Blob` members
through the existing Core connection into native working files. DBOPFS keeps
the authoritative originals. The helper performs no model download and changes
neither stored content nor the model format.

Use complete members returned by `createDbopfsModelStore().ensure()` or files
read from the application's existing DBOPFS owner. The browser model store
already assembles persisted Range parts into one logical Blob per upstream
member. Preserve that member order and the original relative filenames,
including companion files required by a model.

## Browser preparation

```javascript
import {prepareCoreModelAssets} from 'arcane-os/ai/core-model-assets';
import {createCoreImageRuntime} from 'arcane-os/ai/core-image';

const stored = await modelStore.ensure(selectedSource, {signal});
const projection = await prepareCoreModelAssets({
    client,
    workingDirectory: selectedWorkingDirectory,
    members: [{path: 'sd-v1-4.ckpt', file: stored.files[0]}],
    signal,
    onProgress: renderPreparationProgress
});
const image = createCoreImageRuntime({client});
try {
    await image.load({
        model: 'sd14',
        assetProjectionId: projection.id,
        resourcePaths: {model: 'sd-v1-4.ckpt'},
        signal
    });
} finally {
    // Native loading takes its own retain handle before using these files.
    await projection.release();
}
const result = await image.generate({
    model: 'sd14',
    prompt: 'A dignified raccoon who has been put in charge of the moon.',
    signal
});
// Display or save the complete returned image through the application owner.
await image.unload();
```

This example assumes that the application selected the `sd14` model and its
complete checkpoint source. Model choice, download approval, prompts, output
storage and the selected working directory remain application-owned.

`prepareCoreModelAssets({client,workingDirectory,members,signal,onProgress})`
requires an available Core connection exposing the model-assets service.
`client` defaults to the installed Core client. Every member is
`{path,file}`, where `path` is its relative filename or companion-file path and
`file` is the complete stored Blob or File. Relative working-directory paths
resolve from the native service's `appRoot`; an application may explicitly
select an absolute working directory.

The result contains `id`, `directory`, ordered
`members: [{path,nativePath}]`, and an idempotent asynchronous `release()`.
The operation creates a unique child directory under the selected working
directory. Member paths identify files inside that child directory. Original
DBOPFS files remain untouched.

Each incoming Blob stream chunk is encoded only for the existing JSON Core
transport. The helper waits for the corresponding native write before reading
the next chunk of that member. Independent members transfer concurrently;
the complete member set is returned only after every write and file close
finishes. There is no complete-model transport buffer or application content
limit. Progress reports actual preparation phases and member paths.

Cancellation stops active readers and requests. Failure joins the participating
transfers and requests native cleanup; that cleanup joins actual file writes
before removing the projection. Cleanup uses its own uncancelled operation so
an already-aborted preparation signal cannot skip it. Original failures and
cleanup failures remain observable.

## Native ownership

```javascript
import {createModelAssetService} from 'arcane-os/core/model-assets';

const modelAssets = createModelAssetService({appRoot});
// Register this same service with Core and pass it to the native engine owner.
const use = modelAssets.retain(projectionId);
try {
    // Load and use the complete files from use.members.
    await ownNativeModelLifetime(use.members);
} finally {
    // ownNativeModelLifetime must join actual model release before returning.
    await use.release();
}
```

`createModelAssetService({appRoot})` returns a Core service with `current()`,
`retain(id)` and `dispose()`. `retain()` accepts only a completed projection
and returns `{id,directory,members,release}`. A native engine takes this handle
before loading and releases it after actual unload, failed-load cleanup or
worker exit. A rejected inference/load promise alone does not establish native
release. Multiple contexts can retain one prepared set, and repeated inference
on a retained context reuses its files.

The browser's `projection.release()` relinquishes preparation ownership. It
does not delete files retained by a native engine. Deletion follows the final
native release and removes only that operation's working directory. Core closes
independent services concurrently, so the model-assets service waits for all
native retain handles during disposal instead of assuming service order.
Owners must release their handles after joining their actual engine lifetime.

Closing a browser accessor does not by itself establish native unload.
Explicitly release unused prepared projections. Core disposal also releases
preparation ownership and cleans up after retained engine uses end.

`current()` returns `{closing,projections}`. Each projection reports its `id`,
`directory`, `state`, ordered `members`, `preparationOwned`, number of native
`uses`, and `error`. Core emits `modelAssets.state` for lifecycle changes.

## Core transport operations

| Method | Parameters | Result |
| --- | --- | --- |
| `modelAssets.open` | `{id,workingDirectory,members:[{path}]}` | Preparing projection and native member paths |
| `modelAssets.write` | `{id,memberIndex,contentBase64}` | `{id,memberIndex,written:true}` after the native write |
| `modelAssets.complete` | `{id}` | Ready projection after all files close |
| `modelAssets.release` | `{id}` | Released preparation ownership; native uses may retain the files |
| `modelAssets.status` | `{}` | Current projection lifecycle records |

The browser helper owns this transport sequence. Correlation IDs identify
operations; they are unrelated to content identity. Original model files remain
separate and complete. A retry creates a new working projection from the stored
assets; it does not redownload them or replace the authoritative DBOPFS record.

The implementation uses browser streams, the existing portable Core JSON
transport and Node filesystem operations. Native paths and cleanup follow the
host's Windows, Linux or macOS filesystem behavior. Android requires its host's
Core/filesystem adaptation. These are source-level platform contracts, not a
claim of execution on every target.
