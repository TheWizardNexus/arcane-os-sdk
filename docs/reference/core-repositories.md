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
| Linux | `$XDG_DATA_HOME/ArcaneData` when `XDG_DATA_HOME` is absolute, otherwise `~/.local/share/ArcaneData` | `<dataRoot>/Repos` |
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
returns `{directory,open,status,pull,push,write,close,drain,dispose}`. The `directory`
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

The open/status/pull/push methods accept `{signal}={}` and return promises;
`write` accepts the complete file/message request described below:

| Method | Result and side effect |
|---|---|
| `open` | For a missing/empty destination, runs one clone and returns `{directory,cloned:true,stdout,stderr}` with complete process output. For an existing working repository root, returns `{directory,cloned:false}` after read-only inspection. Later opens on that owner reuse preparation. |
| `status` | Prepares the checkout if needed, then returns the existing `repositoryStatus` result unchanged. |
| `pull` | Prepares the checkout if needed, then runs the existing clean-checkout, fast-forward-only `repositoryPull` operation unchanged. |
| `push` | Prepares the checkout if needed, then runs the existing `repositoryPush` operation unchanged, preserving its support for unrelated uncommitted working files. |
| `write` | Writes exact caller-selected text files, stages and commits only their literal paths, then performs one ordinary non-force push. Returns confirmed operation outcomes; see below. |
| `close`, `drain`, `dispose` | The same idempotent operation: stop accepting new calls and await accepted work and its process/event cleanup. They retain the repository on disk. |

Opening an existing repository never pulls, switches branches, resets, changes
its remote or rewrites files. A nonempty destination that is a bare repository,
a subdirectory of another checkout, or ordinary non-repository data is left
untouched and reports its Git error or `ARCANE_REPOSITORY_DIRECTORY_INVALID`.
A failed or cancelled clone reports the actual failure; any remaining directory
is retained for application-owned inspection. There is no automatic deletion or
destructive retry. Filesystem failures and complete Git diagnostics propagate.

## Write, commit and push selected text

```javascript
const result = await repository.write({
    files: [{path: 'dispatches/moon-cheese.md', content: completeAuthoredText}],
    message: authoredCommitMessage,
    signal
});
```

`write({files:[{path,content}],message,signal}={})` requires at least one explicit
file, a nonempty commit message and string content (including an empty string).
Paths name working files relative to this repository, not its root, outside
paths or Git-owned `.git` metadata. Strings must be representable as UTF-8;
native filenames cannot contain NUL. Incompatible input reports a `TypeError`
before any write, rather than replacing text. Content may contain NUL, BOM,
CRLF, leading/trailing whitespace and every ordinary Unicode character.

The method copies the selected records and their original strings synchronously
when called. Later changes to the caller's array, file records or selected UI
connection cannot alter accepted work. It does not freeze the caller's objects,
add document labels, normalize line endings, trim content or wrap documents.
The workspace's originally selected directory remains the operation owner.

After preparing that checkout, it creates needed parent directories and writes
each complete file using the ordinary native UTF-8 filesystem API. These are
caller-owned replacements, not an append-only policy or a multi-file atomic
transaction. Applications choose which paths and content may be replaced.
Ordinary filesystem behavior, including existing symlinks, remains with the
native host.

One `git --literal-pathspecs add -- <paths>` stages only those exact names.
One `git --literal-pathspecs commit --only --cleanup=verbatim --file - -- <paths>`
commits only those paths, leaving unrelated staged paths staged. The original
message is streamed unchanged through standard input. One ordinary `git push`
then uses that repository's existing remote/ref configuration, identity,
credentials and hooks. There is no implicit pull, branch switch, forced push,
hook bypass, automatic retry, rollback or reset. If Git reports no changes to
commit, that actual failure is returned; the SDK creates no empty commit.
These are Git's documented [selected-path commit](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---only)
and [literal pathspec](https://git-scm.com/docs/git#Documentation/git.txt---literal-pathspecs) semantics.

Existing Git attributes, clean filters, EOL settings and hooks continue to apply
when Git stages/commits content. The filesystem write preserves the original
text; this API does not claim that repository-configured filters leave Git blob
text identical. It preserves those settings. A push may also send existing history or other
refs selected by the repository's ordinary push configuration.

### Result and failure outcomes

Successful completion returns:

```text
{
    directory,
    state: 'pushed',
    stage: 'complete',
    paths: [originalSelectedPath, ...],
    writtenPaths: [confirmedWrittenPath, ...],
    written: true,
    staged: true,
    committed: true,
    pushed: true,
    outputs: [{stage: 'prepare'|'stage'|'commit'|'push', stdout, stderr, code?, signal?}, ...]
}
```

Each output record retains complete stdout/stderr. `code` and the process
termination `signal` are included when a completed process result is available.
An in-progress write also records its current `path` on a failure outcome.
`writtenPaths` records successful filesystem writes in input order; `written`
becomes true only after every requested write succeeds. The other booleans
record successful Git command completion. **False means success is unconfirmed,
not that files, the index, HEAD or the remote certainly remained unchanged.**

- `local`: no successful commit or push has been confirmed. Inspect
  `writtenPaths`, `written`, `staged` and `stage` for actual local progress.
- `committed`: Git completed the commit; no successful push has been confirmed.
  Cancellation before push keeps this result rather than claiming delivery.
- `pushed`: Git reported successful completion of the push. A later observer
  error retains that confirmed result while still reporting the observer error.
- `uncertain`: an attempted file write, commit or push did not supply successful
  completion evidence. Partial files or index changes can remain, and a remote
  can accept updates before a connection failure hides the acknowledgement.
  Previously confirmed `writtenPaths`, `committed` or `pushed` evidence remains
  present. A known pre-spawn failure does not invent a dispatched side effect.

After operation acceptance and execution begins, failures reject with an
`ArcaneError` whose `cause` is the original complete failure and whose `details`
is the outcome above. The code/message retain the original failure when
available, and nested process details remain available through its cause.
Input errors, a pre-aborted/queued-aborted request or a call after closing reject
before writer execution and have the existing TypeError/cancellation/closing
contract. No success is fabricated from an error string or callback.

Cancellation is checked before each subsequent filesystem/Git action. Active
Git cancellation drains through the existing process owner. Completion is
recorded before checking cancellation for the next action: an accepted commit
is retained if push has not begun, and an accepted push is retained if an
observer subsequently fails. Failed operations leave their actual files and
index state available for inspection; the application chooses recovery.
Await or retain the write promise and connect the workspace's terminal drain
to its Core service lifetime. The application still owns any decision to make
that Core method service-lifetime rather than request-lifetime work.

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
An accepted writer uses one filesystem write per explicitly selected file,
then one add, one commit and one push, stopping at the first failure.
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
