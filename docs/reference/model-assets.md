# Native model acquisitions and working projections

Browser preparation and native retain/release ownership were first published in `arcane-os@0.61.0`. Browser
preparation is exported by `arcane-os/ai/core-model-assets`, and the native
service by `arcane-os/core/model-assets`. The image example below uses
`arcane-os/ai/core-image`, published in the same release.

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
try {
    const result = await image.generate({
        model: 'sd14',
        prompt: 'A dignified raccoon who has been put in charge of the moon.',
        signal
    });
    // Display or save the complete returned image through the application owner.
} finally {
    await image.unload();
}
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

Native services can prepare explicitly selected upstream members without a
renderer or browser store. Obtain the registered shared service through
`await context.getService('model-assets')`, then use its native preparation API:

```javascript
const modelAssets = await context.getService('model-assets');
const projection = await modelAssets.prepare({
    id: selectedOperationId,
    workingDirectory: selectedWorkingDirectory,
    members: selectedMembers, // [{path: 'onnx/model.onnx', url: selectedURL}, ...]
    signal,
    onProgress: renderPreparationProgress
});
const use = modelAssets.retain(projection.id);
await modelAssets.release(projection.id);
try {
    await ownNativeModelLifetime(use.members);
} finally {
    // Join actual native unload/worker exit before releasing these files.
    await use.release();
}
```

`prepare({id,workingDirectory,members,archives,signal,onProgress,refresh=false})` reuses
a complete native acquisition or fetches the explicitly selected members.
Every member has its original relative `path` and selected `url`; the caller
supplies the complete companion-file set. Independent members download
concurrently, with up to four independent source transfers active. Each complete response stream is written directly to its native
file, without a whole-model buffer or base64 conversion. No model or runtime
is selected or downloaded by service startup. The result remains the ready
projection snapshot with ordered `members: [{path,nativePath}]`.

Complete acquisitions and interrupted transfer state persist under
`workingDirectory/model-assets/` across release, native unload, service disposal
and process restart. Relative working
directories resolve from `appRoot`. Reuse matches the entire ordered
`[{path,url}]` selection in that actual store; the operation `id` is a separate
live lifetime, not the stored selection. Different URLs, relative paths, member
order or stores select separate acquisitions. Original member names and content
stay unchanged, and native engines use those files directly. Model, revision,
precision and device choices remain with their existing owners.

Ordinary preparation performs no network freshness check for a completed
selection. To acquire a mutable source again, explicitly pass `refresh:true` to
this native `prepare` method. Refresh fetches a new complete set in its own
directory and keeps earlier complete acquisitions and retained engine uses
untouched. Later ordinary preparations reuse the newer completed selection.
A failed refresh leaves the earlier completed acquisition available. Refresh
does not change the selected URLs or imply upstream revision discovery.

Progress includes `open`, `download`, `resume`, `restart`, `complete`, `reuse`
and `ready`, plus waiting, heartbeat, stalled and terminal interruption states.
Records carry `state`, a user-facing `message`, `completed`, `total` and
`unit:'files'`; member progress additionally includes `memberIndex` and `path`.
Recovery guidance belongs in `recovery`; a complete serialized `error` belongs
in developer inspection. A stalled state means no recent transfer activity was
observed, not that the SDK has established an Internet outage. Render active
transfers without inventing a per-file percentage. Progress callbacks may return a promise, which the
preparation observes in order. Each caller owns its callbacks; a slow or failed
callback does not hold another caller's transfer or result. Callbacks must not
await cleanup of the preparation currently calling them. Callback failures
reject that caller's preparation. HTTP failures
retain `url`, `status` and the complete response text in `response`.
During an active member, repeated activity notifications are emitted at most
once per second; opening, member completion and terminal phases remain distinct.
Progress describes files and phases, never transfer volume.

### Selected archive companions

An optional `archives` array acquires exact companion members from an upstream
uncompressed TAR source through this same acquisition owner:

```javascript
const projection = await modelAssets.prepare({
    id: selectedOperationId,
    workingDirectory: selectedModelDirectory,
    members: selectedModelFiles,
    archives: [{
        url: selectedArchiveURL,
        format: 'tar',
        members: [
            {path: 'tokenizer/model_config.yaml', member: 'model_config.yaml'},
            {path: 'tokenizer/speakers.json', member: 'speakers.json'}
        ]
    }],
    signal,
    onProgress
});
```

The result orders ordinary members first, followed by each archive's declared
members. Extraction preserves each complete selected file. TAR names and PAX
path records select members; a leading `./` is archive path framing. Missing
selected members reject preparation and identify the missing names. Gzip and
other archive formats are outside this reader's contract.

When the upstream catalog supplies aligned TAR segments, an archive may include
`ranges:[{start,end,stopBefore?}]`. The reader requests each inclusive HTTP range
once and parses its TAR framing; `stopBefore` ends that segment before the
specified member. Offsets and TAR lengths are solely external transport framing.
They are never download progress, model readiness criteria or content identity.
Ranges require the matching HTTP partial-content response; no complete-archive
fallback is silently substituted. Native reuse identifies archive members by
their selected URL, archive member name and output path, alongside ordinary
members, without re-fetching an already completed set.

## Discover and open installed files

`discover({directories,catalog=[],recursive=true,signal})` inspects only the
explicit directories, without downloading, copying, loading or selecting a
model. Paths resolve from `appRoot`. It returns:

```javascript
{
    directories: [{directory, exists, error}], // error is present only on failure
    models: [{
        directory,
        entryPath,
        members: [{path, nativePath, available}],
        missingMembers: [],
        complete: true,
        source: 'directory', // or 'catalog' or 'acquisition'
        catalogId // present for a matching caller-owned catalog entry
    }]
}
```

Ordinary `.gguf` files are candidates. Split names such as
`moon-00001-of-00003.gguf` form one candidate with all expected members in numeric
order, including explicit missing members. The first shard is `entryPath`,
including when a completed acquisition declared only later shards or listed
them out of order. Acquisition candidates retain all their ordinary and
companion members alongside these required shards; separate filename groups
are never inferred to be one model. Symlinked model files and directories are
followed, with already visited directory targets reused rather than rescanned.
Discovery does not establish a model's role, runtime compatibility or successful
inference. Those selections remain with the application and engine owners.

Catalog entries are `{id,members:[{path,url?}],archives?,entryPath?}`. They describe
an exact companion set and can include nested tokenizer files or multiple model
files. A discovered catalog candidate reports every expected member, including
missing companions. Completed native acquisition records are also discoverable;
when the catalog supplies URLs or archive member names, acquisition matching
also preserves those recorded source selections. A different pinned source with
the same filenames is not relabeled as that catalog selection. Path-only catalogs
and ordinary installed-directory candidates make no source-revision claim.
Unfinished acquisition attempts are ignored. Discovery never removes either.
Set `recursive:false` for a directory-only inspection. Missing root directories
are reported with `exists:false`; other root access failures include their
complete serialized error. A failure while reading a descendant is surfaced.

`openExisting({id,directory,members:[{path}],signal})` opens a complete selected
set as an ordinary ready projection. It rechecks every member and reports
`MODEL_ASSET_MEMBERS_MISSING` with `members` when files are absent. It performs
no copy or network request. Engines use the same `retain(id)` lifecycle.
Preparation release, engine unload and service disposal never delete borrowed
originals. External edits or deletion remain controlled by the files' owner.

The application supplies persistent model directories separately from disposable
build output. The native launch context exposes its platform-specific
`modelsDirectory`; apps may additionally inspect selected application directories.
The model-assets service creates no platform directory policy of its own.

`resolveNativeLaunchContext({appId,context})` defaults `modelsDirectory` to
one shared location for the operating-system user, independent of the app ID.
It preserves an explicitly supplied `modelsDirectory` unchanged and creates,
moves or migrates no files:

| Host | Default shared model directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%/Arcane/Models`; the user's `AppData/Local` when that environment variable is absent |
| macOS | `~/Library/Application Support/Arcane/Models` |
| Linux | `$XDG_DATA_HOME/Arcane/Models` when absolute, otherwise `~/.local/share/Arcane/Models` |
| Android or another host adaptation | `<stateRoot>/Models`; the host supplies an explicit shared `modelsDirectory` when its platform allows sharing |

Pass this `modelsDirectory` as the acquisition `workingDirectory` and as one
discovery directory. Completed files then live beneath its `model-assets`
subdirectory, separate from replaceable application builds. Additional selected
application directories can participate in the same discovery call.

```javascript
import {resolveNativeLaunchContext} from 'arcane-os/core/host';

const {modelsDirectory} = resolveNativeLaunchContext({appId: 'moon-radio'});
const projection = await modelAssets.prepare({
    id: selectedOperationId,
    workingDirectory: modelsDirectory,
    members: selectedMembers,
    signal,
    onProgress: renderPreparationProgress
});
```

App settings, profiles, chat history, workspace and IPC retain their app-private
locations. This default applies to applications using the native launch resolver;
explicit acquisition directories and other provider-owned model stores keep
their existing contracts. Discover existing app-local models and open them in
place rather than copying or removing them.

### Prepare a selected local runtime on demand

`createLocalAIService(configuration,{autoStart:false,...options})` registers the
existing local-AI owner without preparing or starting its selected runtimes at
Core startup. The default remains `autoStart:true`, preserving existing startup
behavior. After the user explicitly requests preparation, invoke
`client.invoke('localai.prepare', {}, {signal,timeoutMs:0})`. The operation uses
the configured existing runtime preparation callback and returns the current
local-AI state; it does not invent a runtime or model selection.

Preparation callback events are published as `localai.preparation` with their
complete original event payload. Subscribe through the existing Core event
owner to display actual preparation phases. Concurrent preparation requests
reuse the owner's in-flight work, and subsequent completed calls reuse its
prepared state. Runtime and model selection, explicit model acquisition and
microphone activation remain app-owned; preparation is not an inference or
microphone operation. Rendering the interface and
discovering installed files need not wait for runtime preparation.

### Browser discovery and explicit download

`arcane-os/ai/core-model-assets` additionally exports
`discoverCoreModelAssets({client,directories,catalog,recursive,signal})`,
`openExistingCoreModelAssets({client,directory,members,signal})`, and
`downloadCoreModelAssets({client,workingDirectory,members,archives,refresh,signal,onProgress})`.
`client` defaults to the installed Core client. Discovery returns the native
record above; opening and downloading return `{id,directory,members,release}`.
The existing Blob-based `prepareCoreModelAssets` keeps its original contract.

Download progress callbacks receive the complete semantic progress record,
correlated to this preparation and observed in order. On request failure, queued
terminal progress is delivered before internal cleanup cancellation and promise
rejection. Explicit caller cancellation retains its no-late-callback boundary.
Callback failure cancels the operation. Cancellation joins explicit native cleanup and local callback
delivery before the helper settles; cleanup failures remain observable.
Callbacks must not await their own enclosing preparation or cancellation join.
Applications initiate downloads explicitly and display actual phases, selected
member paths, completed-file counts and errors in the appropriate surface.

`release(id)` relinquishes preparation ownership without a request signal.
Same-process callers sharing the actual store, complete source selection and
refresh mode share an acquisition, including across service instances. They
keep independent operation IDs, retain handles, cancellation and callbacks.
Cancelling, releasing or disposing one interested caller leaves the others
running. The final interested caller aborts the acquisition and joins its
streams, writes and closes while preserving completed members and resumable
partial transfers. Original
failures and cleanup failures remain observable. A completed acquisition stays
available even if a caller cancels or its callback fails after completion.

The service promotes each file from its partial-transfer location only after
the complete response and file close finish. It records whole-acquisition
completion after every selected member is complete. These records describe
ordinary transfer and cache state, not content hashes or admission receipts.
Retry reuses completed members and resumes saved ordinary-file transfers with
HTTP Range and available HTTP continuation metadata. HTTP offsets and validators
remain transport-local and never become progress or model policy. If the source
cannot continue the saved representation, the SDK reports a restart of that
member; completed siblings remain available. Selected TAR companions preserve
completed files; an interrupted member may require replaying its TAR segment to
restore the archive parser's framing. No full-archive substitute is selected.

Processes selecting the same ordered sources and actual store coordinate a
short selection operation and one transfer owner. Another process waits with
observable status rather than starting a duplicate transfer. Cancelling a
waiting request stops its wait; it does not cancel the other process. If a
transfer owner exits, a later contender can reclaim its recorded operation and
continue retained data. This requires no additional application server, copied
cache implementation or new shared Core process. Existing completed models and
unrelated attempts are never swept or migrated automatically.

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
`discover(options)`, `openExisting(options)`, `prepare(options)`, `retain(id)`,
`release(id)` and `dispose()`. `retain()` accepts only a completed projection
and returns `{id,directory,members,release}`. A native engine takes this handle
before loading and releases it after actual unload, failed-load cleanup or
worker exit. A rejected inference/load promise alone does not establish native
release. Multiple contexts can retain one prepared set, and repeated inference
on a retained context reuses its files.

The browser's `projection.release()` relinquishes preparation ownership. It
does not delete files retained by a native engine. For browser `open`/`write`/
`complete` projections, deletion follows the final native release and removes
only that operation's temporary working directory; DBOPFS originals remain
untouched. Native `prepare` acquisitions remain stored after their final use.
Core closes independent services concurrently, so the model-assets service
waits for all native retain handles during disposal instead of assuming service
order. Owners must release their handles after joining their actual engine
lifetime.

Closing a browser accessor does not by itself establish native unload.
Explicitly release unused prepared projections. Core disposal also releases
preparation ownership and ends the live records after retained engine uses end.

### Native Laya decisions

The existing native decision owner also consumes ready projections through
`decisions.load({assetProjectionId, resourcePaths, executionTarget?})` over Core,
or the direct/service `load` method with an optional `signal`. Supply all three
resource roles with exact projection member paths:

```js
try {
    await client.invoke('decisions.load', {
        assetProjectionId: projection.id,
        resourcePaths: {
            model: 'onnx/model.onnx',
            tokenizer: 'tokenizer.json',
            tokenizerConfig: 'tokenizer_config.json'
        }
    }, {signal, timeoutMs: 0});
} finally {
    await projection.release();
}
```

The complete projection must also retain the graph's companion files, including
`onnx/model.onnx_data` for the selected Laya FP32 graph. The native owner resolves
the three roles from `retain(id).members` and uses those files directly without
calling `prepare` or downloading again. It releases its native use only after
actual ONNX and tokenizer exit; it never releases the caller's preparation
ownership. Replacement acquires incoming ownership before retiring the prior
activation, including when only its device changes. Unavailable or incomplete
selections report their errors without an upstream fallback. See
[native decisions](native-decisions.md#load-complete-files-already-stored-in-dbopfs)
for source selection, cancellation and complete row/output contracts.

`current()` returns `{closing,projections}`. Each projection reports its `id`,
`directory`, `state`, ordered `members`, `preparationOwned`, number of native
`uses`, and `error`. Core emits `modelAssets.state` for lifecycle changes.

## Core transport operations

| Method | Parameters | Result |
| --- | --- | --- |
| `modelAssets.open` | `{id,workingDirectory,members:[{path}]}` | Preparing projection and native member paths |
| `modelAssets.discover` | `{directories,catalog?,recursive?}` | Directory status and complete/incomplete model candidates |
| `modelAssets.openExisting` | `{id,directory,members:[{path}]}` | Ready retained projection of existing originals |
| `modelAssets.prepare` | `{id,workingDirectory,members,archives?,refresh?}` | Ready persistent acquisition; request-scoped `modelAssets.progress` emits `{id,progress}` |
| `modelAssets.cancelPrepare` | `{id}` | Cancel and join the matching native preparation, then release its preparation ownership |
| `modelAssets.write` | `{id,memberIndex,contentBase64}` | `{id,memberIndex,written:true}` after the native write |
| `modelAssets.complete` | `{id}` | Ready projection after all files close |
| `modelAssets.release` | `{id}` | Released preparation ownership; native uses may retain the files |
| `modelAssets.status` | `{}` | Current projection lifecycle records |

The browser helper owns this transport sequence. Correlation IDs identify
operations; they are unrelated to content identity. Original model files remain
separate and complete. A retry creates a new working projection from the stored
assets; it does not redownload them or replace the authoritative DBOPFS record.
`cancelPrepare` and `release` have service lifetime so cancellation of the
original request cannot cancel its cleanup control. Native preparation follows
the original request signal, including connection cancellation; raw RPC callers
join `cancelPrepare` when cancelling and release any successful unused projection.

The implementation uses browser streams, the existing portable Core JSON
transport and Node filesystem operations. Native paths and cleanup follow the
host's Windows, Linux or macOS filesystem behavior. Android requires its host's
Core/filesystem adaptation. These are source-level platform contracts, not a
claim of execution on every target.
