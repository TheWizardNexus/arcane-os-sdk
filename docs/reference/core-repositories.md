# Native repository workspaces

`arcane-os/core/repositories` owns a persistent native location for connected
repositories, separate from application code and application preferences.
Applications choose their connection names, remotes, branches, files and Core
methods. Importing the module and constructing an owner perform no I/O.

## Persistent locations

`resolveArcaneDataPaths({dataRoot}={})` returns absolute
`{dataRoot,repositoriesRoot}` paths without creating directories:

| Host | Default dataRoot | repositoriesRoot |
|---|---|---|
| Windows | `%LOCALAPPDATA%/ArcaneData`, or `~/AppData/Local/ArcaneData` when that variable is empty | `<dataRoot>/Repos` |
| Linux | `$XDG_DATA_HOME/ArcaneData` when XDG_DATA_HOME is absolute, otherwise `~/.local/share/ArcaneData` | `<dataRoot>/Repos` |
| macOS | `~/Library/Application Support/ArcaneData` | `<dataRoot>/Repos` |
| Android or another adapted host | Explicit `dataRoot` supplied by the host, such as its app files directory followed by `ArcaneData` | `<dataRoot>/Repos` |

An explicit `dataRoot` selects that directory directly; the SDK does not append
another `ArcaneData`. Relative explicit paths resolve from the process working
directory. Unsupported default platforms report `ARCANE_DATA_ROOT_REQUIRED`.
The Android host also supplies Git/process execution through the existing
process-adapter contract; this module does not install Git or choose shared
Android storage.

The factory's first actual operation creates necessary parent directories.
No existing data is moved, copied, deleted, renamed or migrated. `appRoot`,
`stateRoot`, preferences, OPFS and the existing CLI/workspace defaults remain
independent and unchanged.

## One connected working checkout

```javascript
import {createRepositoryWorkspace} from 'arcane-os/core/repositories';

const repository = createRepositoryWorkspace({
    name: 'moon-cheese-dispatches',
    remote: applicationConnection.remote,
    branch: applicationConnection.branch
});

const opened = await repository.open({signal});
// opened.directory is <ArcaneData>/Repos/moon-cheese-dispatches.
const status = await repository.status({signal});
await repository.close();
```

`createRepositoryWorkspace({name,directory,dataRoot,remote,branch,onEvent,run}={})`
returns `{directory,open,status,pull,push,close,drain,dispose}`. The `directory`
property is the absolute selected working path.

- Omit `directory` to select `<repositoriesRoot>/<name>`. The application supplies
  one nonempty directory name for each distinct connection; the SDK neither
  derives it from a remote nor maintains a connection registry. Names are one
  component, excluding `.`/`..` and slash/backslash separators. Choose distinct
  names under the host filesystem's ordinary case rules.
- Supply `directory` to use an existing application-selected path instead.
  This takes precedence over `name` and `dataRoot`; relative paths resolve from
  the process working directory. The path is not relocated or rewritten.
- `remote` is required only when a missing or empty destination needs cloning.
  `branch`, when supplied, is passed unchanged to Git's `clone --branch` option;
  otherwise Git selects the remote's default branch. Existing checkouts keep
  their own branch, remote, tracked files, untracked files and local changes.
- `onEvent` and optional `run` use the existing SDK process owner. The default
  adapter is `runProcess`; Git must be available on PATH. Credentials and
  authentication remain with Git and the native host. The SDK adds no download,
  credential store, polling, network retry or process supervisor.

All operation methods accept `{signal}={}` and return promises:

| Method | Result and side effect |
|---|---|
| `open` | For a missing/empty destination, runs one clone and returns `{directory,cloned:true,stdout,stderr}` with complete process output. For an existing working repository root, returns `{directory,cloned:false}` after read-only inspection. Later opens on that owner reuse preparation. |
| `status` | Prepares the checkout if needed, then returns the existing `repositoryStatus` result unchanged. |
| `pull` | Prepares the checkout if needed, then runs the existing clean-checkout, fast-forward-only `repositoryPull` operation unchanged. |
| `push` | Prepares the checkout if needed, then runs the existing `repositoryPush` operation unchanged, preserving its support for unrelated uncommitted working files. |
| `close`, `drain`, `dispose` | The same idempotent operation: stop accepting new calls and await accepted work and its process/event cleanup. They retain the repository on disk. |

Opening an existing repository never pulls, switches branches, resets, changes
its remote or rewrites files. A nonempty destination that is a bare repository,
a subdirectory of another checkout, or ordinary non-repository data is left
untouched and reports its Git error or `ARCANE_REPOSITORY_DIRECTORY_INVALID`.
A failed or cancelled clone reports the actual failure; any remaining directory
is retained for application-owned inspection. There is no automatic deletion or
destructive retry. Filesystem failures and complete Git diagnostics propagate.

## Ownership, concurrency and shutdown

Calls targeting the same resolved path spelling in one Node process run in
acceptance order, including separate owners selecting that path. Windows keys
are case-insensitive. The queue does not resolve symlink aliases or macOS case
variants; applications use one consistent path for a shared connection.
This prevents overlapping Git/index writes and duplicate successful cloning.
Different directories proceed
independently. Applications coordinate separate processes and their own direct
file/Git writes; this module does not create a daemon or cross-process lock.

A pre-aborted call starts no work. A queued aborted operation does not run when
its turn arrives. Active cancellation reaches the existing process owner, which
terminates its owned process tree and joins complete output/event cleanup.
Shutdown drains accepted operations rather than deleting data or terminating
the host early. Calls after close reject with `CORE_CLOSING`; a failed operation
still pending when close begins rejects that drain through an `AggregateError`.
The caller retains each operation's complete result or failure separately.

The cold path is one selected connection, one parent-directory creation and one
Git clone. Opening an existing checkout uses one read-only Git command. A
prepared owner's status/pull/push use their existing repository operation graph.
There is no scan across applications, connections, models or platforms. Git
progress, process-starting/completion, heartbeat and cancellation events use
the existing `onEvent` owner with complete output and backpressure.
An awaited event callback must not await another operation or shutdown for the
same directory, including calls through another workspace owner: that operation
needs the observing callback to finish. Schedule such follow-up without awaiting
it inside that callback, and retain/observe its promise at the application owner.

Compose this owner inside an application-selected Core service. Bind only the
application's chosen methods, pass each request's `context.signal`, and return
`drain: repository.drain` and `dispose: repository.dispose` from that service.
Keep initialization at the repository operation that needs it; page rendering
and unrelated services do not wait for a clone. This module installs no browser
RPC, chooses no application service and changes no Core launch configuration.

## Bare snapshots stay separate

[`createGitTextSnapshot`](git-text-snapshot.md) continues to require its explicit
dedicated bare `cacheDirectory`. It neither becomes a working checkout nor
changes existing callers' caches. A new native caller can place that distinct
cache under the shared location without changing the snapshot contract:

```javascript
import path from 'node:path';
import {createGitTextSnapshot} from 'arcane-os';
import {resolveArcaneDataPaths} from 'arcane-os/core/repositories';

const {repositoriesRoot} = resolveArcaneDataPaths();
const snapshot = createGitTextSnapshot({
    cacheDirectory: path.join(repositoriesRoot, 'moon-cheese-reader-cache'),
    remote: applicationConnection.remote,
    ref: applicationConnection.ref,
    selectPath: applicationSelectPath
});
```

Never assign the same directory to a bare snapshot and a writable workspace.
Applications retain remote/ref selection, document parsing, scores, messages,
saved connection state and refresh policy. Existing explicit repository paths
continue to operate where they already are.
