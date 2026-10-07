# Complete Git text snapshots

`createGitTextSnapshot` from `arcane-os` reads application-selected UTF-8 text
from one fetched Git revision. It uses a dedicated **bare object cache**, not a
clone with a working checkout. It never reads uncommitted application files,
checks out files, modifies a user checkout/index, or creates another worktree.
Construction performs no I/O. The native host needs Git available on its PATH;
Git owns remote access, authentication and its actual failures.

```js
import {createGitTextSnapshot} from 'arcane-os';

const snapshot = createGitTextSnapshot({
    cacheDirectory: applicationCacheDirectory,
    remote: applicationRepository,
    ref: applicationRef,
    selectPath: function selectMoonDispatches(filename) {
        return filename.startsWith('dispatches/') && filename.endsWith('.md');
    }
});

const {revision, files} = await snapshot.refresh({signal});
// files: [{path: 'dispatches/cheese-emergency.md', content: completeText}]
await snapshot.close();
```

The application owns its remote, ref, path policy, repository identity, refresh
schedule and Core service factory. The SDK does not select `main`, poll, parse
Markdown/YAML, label or rewrite documents, or choose a product RPC method.
`selectPath(path)` may return a boolean or a promise of one. It receives each
complete repository-relative leaf path in Git tree order. Keep the selector's
policy stable for the lifetime of its snapshot owner.

## API and lifecycle

`createGitTextSnapshot({cacheDirectory,remote,remoteBase,ref,selectPath,allowUnborn=false,gitIdentity,onEvent,run})`
returns `{refresh,close,drain,dispose}`. `run` defaults to the SDK's existing
`runProcess`; applications normally omit it. It is the same process adapter
contract, not a second process supervisor. `onEvent` is the ordinary SDK event
callback and follows its asynchronous completion/error contract.

Optional `remoteBase` explicitly selects `remote` as a local filesystem locator.
The owner derives its native absolute Git argument once during construction
using `path.resolve(remoteBase, remote)`, independently of the cache location
and later working-directory changes. A relative base is captured against the
construction-time working directory; `''` explicitly selects that directory.
The caller's original locator and options remain unchanged. Without this field,
every existing Git remote string keeps its ordinary meaning; the SDK does not
guess whether a name, URL, colon or slash describes a local path.

Use the same app-selected absolute base for snapshot, workspace clone and each
explicit pull/push/write target. Factory clone inputs do not become operation
targets. See [relative local repository locators](core-repositories.md#relative-local-repository-locators)
for the shared contract, original target outcomes and example. This option adds
no I/O, remote probe, configuration change, retry or empty-remote success path.

Optional `gitIdentity:{name?,email?,username?}` uses the shared
[Git identity configuration contract](core-repositories.md#git-identity-configuration).
Supplied strings are captured during construction and accompany every Git
command, including bare initialization and fetch, without changing the remote,
ref, config files or process environment. Explicit name/email use command-local
configuration and child-only author/committer fields; omitted fields remain
inherited. `username` is only Git's credential username hint, not authenticated
account proof or SSH account selection. Read separate global/local/effective
configuration through `readGitIdentity` from `arcane-os/core/repositories`;
the reader also accepts an existing bare cache directory. Applications retain
saved non-secret choices and per-connection overrides. Identity selection adds
no process or query to refresh and does not attach a caller's abort to shared
acquisition.

- `refresh({signal}={})` fetches the selected ref and returns
  `{revision,files:[{path,content}]}`. `revision` is Git's opaque selected commit
  name, not an SDK integrity record. Every file comes from that exact revision,
  even if the remote moves during retrieval. Order follows Git's tree listing.
- Concurrent calls share the active refresh. A later call fetches again; when
  the selected revision is unchanged, it reuses the completed text retrieval.
  Returned arrays and records are independent copies, so caller edits do not
  alter retained results. Failed refreshes report errors, never stale success.
- A caller's abort cancels only that caller's wait. Accepted shared refresh
  continues, including when every caller leaves. There is no incomplete result
  presented as a complete snapshot. A pre-aborted call starts no work.
- `close()`, `drain()` and `dispose()` are the same idempotent operation. They
  stop acceptance and await accepted refresh work and its process/event cleanup.
  Calls after close reject with `CORE_CLOSING`. A failure during drain rejects
  close. Connect this hook to the Core service's `drain`/`dispose` lifecycle;
  do not terminate its process before accepted work settles.

One application service owns each cache directory. Sharing that mutable bare
cache across independent instances or processes requires coordination by its
application owner; this factory does not install a daemon or cross-process lock.
An empty cache is initialized once. An existing non-bare checkout is rejected
without repurposing it. The cache is retained when the owner closes.

## Unborn remotes

Optional `allowUnborn:true` adds an explicit no-advertised-revision state:

```javascript
const snapshot = createGitTextSnapshot({
    cacheDirectory: applicationCacheDirectory,
    remote: applicationRepository,
    ref: 'refs/heads/main',
    selectPath: applicationSelectPath,
    allowUnborn: true
});
const observed = await snapshot.refresh({signal});
// Empty advertisement: {revision: null, files: [], unborn: true}.
// Selected commit: {revision: actualCommit, files: selectedText, unborn: false}.
```

Each opted-in acquisition first completes unfiltered
`git ls-remote --symref -- <remote>` with the same captured locator and identity.
Only successful empty stdout produces the explicit unborn result. No revision
is invented and no fetch, tree listing or blob process runs on that path.
The [Git remote advertisement](https://git-scm.com/docs/git-ls-remote) is scoped
to refs visible to that connection, not hidden refs or unreachable objects.

Any advertised HEAD, branch, tag or other output continues through the ordinary
selected-ref fetch and commit resolution. A missing selected ref on a populated
remote remains a Git failure. Failed observations, authentication/transport
errors and stderr wording never establish an unborn result. A real commit with
an empty tree or zero selected files retains its actual revision and
`unborn:false`. Omitting the boolean, or supplying `false`, preserves the
previous `{revision,files}` result and command sequence without a remote probe.

Bare-cache role discovery still precedes remote observation. Every later
refresh observes again, so prior empty or committed results cannot hide a
changed remote or a failure. Caller cancellation, shared acquisition, independent
result copies and drain remain unchanged. Opted-in completion events add
`unborn`; `revision:null` and `unborn:true` describe the explicit empty state.
This option adds one remote command per acquisition; existing revision-based
text reuse still applies to committed results. For writing the first commit,
see [first-publication composition](core-repositories.md#first-publication-from-an-unborn-remote).

## Complete text and observable failures

Content is the exact Git blob text, including whitespace, CRLF, newlines,
leading BOM and embedded NUL characters. No checkout filters, `textconv`,
normalization, trimming, truncation, freezing or application size gate applies.
Symlink blobs expose their stored target text; they are never followed.
Selected submodules are not text blobs and produce an explicit error rather
than being skipped or fetched as another repository. A selected path or blob
that cannot be decoded as UTF-8 fails with `ARCANE_GIT_SNAPSHOT_NOT_TEXT` instead
of silently substituting replacement characters. Git errors and complete
diagnostics remain available to the caller and the existing process event owner.

`git.snapshot.refreshing`, `git.snapshot.completed` and `git.snapshot.failed`
describe the shared operation. Completion data contains `{revision,reused}`;
failure data contains the actual error. These events supplement the complete
result, never replace it. An event callback must not await a new refresh of the
same owner from inside the operation it is currently observing.

Initial refresh performs bare initialization/role discovery, then fetch,
revision resolution, one tree listing and one batched blob process. Later
unchanged revisions need only fetch and revision resolution. A changed revision
uses one tree process and one blob process regardless of the selected file
count. An empty selection needs no blob process. Blob requests use the shared
async process-input owner; raw stdout is consumed by the Git parser with
backpressure. Git's encoded body extent and object names remain local to its
[batch protocol](https://git-scm.com/docs/git-cat-file#_batch_output); they do
not become product metadata, byte progress, admission or integrity policy.

## Core service composition

The application wraps this mechanism in its own service factory and supplies its
own public method and result fields. The handler can pass `context.signal` to
`refresh` for request cancellation, then map `revision` to its chosen remote-ref
field without changing any `content`. Return the snapshot owner's `drain` and
`dispose` hooks from that service. Native launch configuration selects the
cache location; browser code does not launch Git or reconstruct its protocol.

This contract is portable Node source for Windows, Linux and macOS. Android
requires a host that supplies the same Git/process capability; it is not a
claim that every Android host ships Git.
