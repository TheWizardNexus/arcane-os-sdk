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

The factory's first operation that prepares a checkout creates necessary parent
directories. The read-only `configuration` operation never prepares one.
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

`createRepositoryWorkspace({name,directory,dataRoot,remote,remoteBase,branch,initialBranch,longPaths,cloneIdentity,gitIdentity,onEvent,run}={})`
returns `{directory,open,status,configuration,pull,push,write,close,drain,dispose}`. The `directory`
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
- Optional `initialBranch` names the branch for first publication from a new
  unborn clone. It is separate from `branch`, which selects an existing remote
  branch or tag. Omit `branch` when the remote has no advertised revision.
  See [first publication](#first-publication-from-an-unborn-remote).
- Supplying `remoteBase` explicitly declares this initial-clone `remote` to be
  a local filesystem locator. Its native absolute command argument is captured
  during construction. Omission leaves Git's original string interpretation
  unchanged. See [relative local repository locators](#relative-local-repository-locators).
- Optional `longPaths` is a boolean for newly cloned Windows checkouts. Explicit
  `true` or `false` supplies `clone --config core.longpaths=<value>`, so Git
  writes that choice to the new repository before its first checkout. Omission
  leaves Git's configuration unchanged. The option does not rewrite an existing
  checkout, change a global setting, or alter non-Windows clone commands.
- Optional `cloneIdentity:{name?,email?}` persists explicitly selected author
  fields in a newly cloned repository's local Git configuration. Omitted fields
  keep Git's ordinary inheritance; existing checkouts retain their configuration.
  See [clone-local author selection](#clone-local-author-selection).
- `onEvent` and optional `run` use the existing SDK process owner. The default
  adapter is `runProcess`; Git can be available on PATH or through an installed
  Git for Windows registration. The default Windows runner appends that
  installation's `cmd` directory only to the Git child's PATH, preserving
  existing command lookup priority. See [Windows Git discovery](sdk-api.md#runprocess).
  Custom `run` adapters retain their own execution behavior. Credentials and
  authentication remain with Git and the native host. The SDK adds no download,
  credential store, polling, network retry or process supervisor.

The open/status/configuration methods accept `{signal}={}` and return promises;
pull/push accept `{target,signal}={}` with an optional captured destination.
`write` accepts the complete file/message request described below:

| Method | Result and side effect |
|---|---|
| `open` | For a missing/empty destination, runs one clone and returns `{directory,cloned:true,stdout,stderr}` with complete process output. For an existing working repository root, returns `{directory,cloned:false}` after read-only inspection. Later opens on that owner reuse preparation. |
| `status` | Prepares the checkout if needed, then returns the existing `repositoryStatus` result unchanged. |
| `configuration` | Observes the existing working root, symbolic HEAD, origin and configured upstream. It never clones, initializes or fetches. |
| `pull` | Prepares the checkout if needed, then runs clean-checkout, fast-forward-only `repositoryPull`, optionally using the operation's selected target. |
| `push` | Prepares the checkout if needed, then runs `repositoryPush`, optionally using the operation's selected target, preserving support for unrelated uncommitted working files. |
| `write` | Writes exact caller-selected text files, stages and commits only their literal paths, then performs one ordinary non-force push. Returns confirmed operation outcomes; see below. |
| `close`, `drain`, `dispose` | The same idempotent operation: stop accepting new calls and await accepted work and its process/event cleanup. They retain the repository on disk. |

Opening an existing repository never pulls, switches branches, resets, changes
its remote or rewrites files. A nonempty destination that is a bare repository,
a subdirectory of another checkout, or ordinary non-repository data is left
untouched and reports its Git error or `ARCANE_REPOSITORY_DIRECTORY_INVALID`.
A failed or cancelled clone reports the actual failure; any remaining directory
is retained for application-owned inspection. There is no automatic deletion or
destructive retry. Filesystem failures and complete Git diagnostics propagate.

### Windows long paths for a new checkout

Select the option in the application's native repository connection:

```javascript
const repository = createRepositoryWorkspace({
    name: 'moon-cheese-dispatches',
    remote: applicationConnection.remote,
    longPaths: true
});
await repository.open({signal});
```

This remains one ordinary Git clone, including its branch/tag selection,
progress, hooks, cancellation and empty-remote behavior. It does not clone
without checkout and run a second initialization sequence. The boolean is
captured when the owner is constructed; later edits to the options object
cannot change an accepted connection.

An explicit value intentionally selects the new repository's local
`core.longpaths` setting. Git's ordinary configuration precedence still applies,
including higher-priority command-scope settings supplied by the native host.
Omit the option to retain inherited or template configuration without an SDK
override. Existing repositories retain their settings even if this option is
supplied; there is no configuration migration or repair pass.

[Git documents clone-local configuration before the initial checkout](https://git-scm.com/docs/git-clone#OPTIONS).
[Git for Windows describes long-path support](https://gitforwindows.org/git-cannot-create-a-file-or-directory-with-a-long-path.html)
for its native commands; unrelated editors, scripts and host tools may have
their own path limitations. This option changes no filenames or payloads and
does not change the SDK's persistent directory selection.

## Existing checkout configuration and selected targets

`configuration({signal}={})` observes an existing checkout without invoking
`open`, creating directories, cloning, initializing, fetching or changing Git
configuration. A missing repository reports the actual Git failure. A bare
cache or nested checkout directory reports `ARCANE_REPOSITORY_DIRECTORY_INVALID`.
Its result is:

```text
{
    repositoryRoot,
    headRef: fullSymbolicRef | null,
    revision: currentCommit | null,
    unborn: boolean,
    origin: {urls: [...], pushUrls: [...]},
    upstream: {remoteNames: [...], mergeRefs: [...], urls: [...], pushUrls: [...]} | null
}
```

`repositoryRoot` is this owner's absolute selected working root. `headRef` is
the complete symbolic HEAD, including an unborn branch, or `null` for detached
HEAD. `upstream` is `null` when HEAD does not name a local branch. Otherwise its
arrays contain that branch's configured `remote` and `merge` values; `urls` and
`pushUrls` observe the effective last configured remote name. A `.` remote
means the local repository and has no remote URL arrays. Origin is observed
independently, even when it is not the upstream.

`revision` and `unborn` come from Git's successful
[porcelain-v2 branch observation](https://git-scm.com/docs/git-status#_porcelain_format_version_2):
`(initial)` yields `revision:null, unborn:true`; a current commit yields that
opaque revision and `unborn:false`, including a commit with an empty tree and
detached HEAD. Symbolic HEAD alone does not establish an unborn branch.
The command uses `--no-optional-locks` and omits untracked-file discovery, so
this observation does not refresh the index on disk. A missing branch-state
record reports `ARCANE_REPOSITORY_HEAD_UNAVAILABLE`; unsuccessful commands
retain their actual failures rather than becoming an initial state.

Arrays retain configured order, repeated values, complete UTF-8 strings and
empty strings. `[]` means unset; `['']` means an explicit empty value. The
reader honors configured includes and ordinary Git configuration precedence.
Unset push URLs do not imply that Git cannot push: Git retains its normal URL
fallback and rewrite behavior. These are configuration observations, not
resolved endpoints, authentication, account identity or ownership proof.
The SDK neither queries a credential helper nor changes configuration here.

Metadata uses the shared raw-Git-text reader. Lifecycle/stderr events remain
with the process owner, raw stdout remains parser-owned, and undecodable text
reports `ARCANE_GIT_CONFIGURATION_NOT_TEXT`. Failures retain complete raw
stdout, process diagnostics and causal errors using the identity reader's
documented attachment behavior. One observation uses five read-only Git
commands for an attached local branch, or four otherwise. Results are not a
transaction with later work or external Git activity. The app owns any decision
that the current checkout corresponds to its selected repository and branch.

The optional `target:{remote,ref,remoteBase?}` on `pull`, `push` and `write` selects
that operation's Git destination. `remote` and `ref` are nonempty strings representable by
the native process transport. The SDK captures their exact strings when the
call is accepted; later edits to the target object or UI selection cannot
redirect queued or active work. Git owns ref parsing, URL interpretation,
credentials, hooks and remote outcomes. This target is independent of the
factory's `remote`/`remoteBase`/`branch`, which remain initial-clone inputs only.

```javascript
const observed = await repository.configuration({signal});
// The app decides whether observed.headRef and configured URLs match its choice.
const target = {remote: connection.locator, ref: connection.ref};
await repository.pull({target, signal});
const result = await repository.write({files: selectedFiles, message, target, signal});
```

A targeted pull uses `git pull --ff-only -- <remote> <ref>:`. The trailing colon
is Git's source-only fetch framing; the fetched history is integrated into the
current branch. It does not switch branches or reset files/history. The existing
clean-checkout requirement remains. A targeted push uses
`git push --no-follow-tags -- <remote> HEAD:<ref>`: current HEAD is published to
the selected ref, without force or implicit configured tag following. Existing
history is still sent when Git needs it. Ordinary conflicting Git settings or
remote rejection remain actual failures; no settings are rewritten.

Omitting `target` preserves ordinary configured pull/push behavior and its
existing result shape. Targeted pull/push results add the captured `target` and
complete `stdout`/`stderr` alongside the existing `action`, `repositoryRoot`,
`branch` and compatibility `output` field. Writer results and failure outcomes
add that same captured `target`. There is no hidden pre-write pull, branch
selection, retry, reset, force, reversal or recommit. The app decides when to
observe, refresh, write and publish. See Git's [pull](https://git-scm.com/docs/git-pull),
[push](https://git-scm.com/docs/git-push) and [configuration](https://git-scm.com/docs/git-config)
contracts.

### First publication from an unborn remote

An opt-in [snapshot refresh](git-text-snapshot.md#unborn-remotes) can report
`{revision:null,files:[],unborn:true}` after a successful complete empty remote
advertisement. This means no revision was advertised to this connection; it
does not assert that hidden refs or unreachable objects cannot exist.
The application retains that explicit state instead of inventing a commit.

For an application-selected new connection with that state, prepare its first
branch without passing the existing-branch `clone --branch` option:

```javascript
const repository = createRepositoryWorkspace({
    name: connection.name,
    remote: connection.locator,
    remoteBase: connection.localBaseDirectory,
    initialBranch: 'main'
});
await repository.open({signal});
const observed = await repository.configuration({signal});
// The application matches observed.headRef, unborn and configured URLs to its connection.
const publication = await repository.write({
    files: selectedFiles,
    message: authoredCommitMessage,
    target: {remote: connection.locator, remoteBase: connection.localBaseDirectory, ref: 'refs/heads/main'},
    signal
});
```

`initialBranch` is captured during construction. After a successful new clone,
the SDK observes the complete remote advertisement using the clone's original
working-directory context and captured remote argument. Only empty successful
output followed by the new checkout's explicit initial state and successful
empty `git for-each-ref --format=%(refname)` observation selects
`HEAD` as `refs/heads/<initialBranch>` through
[Git symbolic-ref](https://git-scm.com/docs/git-symbolic-ref). Git owns branch-name
validity. Advertised HEAD, branches or tags keep ordinary clone selection;
an already committed clone and every existing destination remain unchanged.
Any local ref supplied by Git's template or hook behavior is preserved and
leaves HEAD unchanged, even when the remote advertises nothing.
Omission adds no process and preserves the previous open result.

For a new clone with `initialBranch`, `open` retains its clone `stdout`/`stderr`
and adds ordered `outputs:[{operation,stdout,stderr,code,signal}]`. Operations
are `clone`, `observeRemote`, `observeHead`, `observeRefs` and `selectInitialBranch`, only as
performed. A later preparation failure preserves completed outputs in
`error.details:{directory,cloned:true,outputs}` and the original complete
failure as `cause`; cancellation retains completed observations too. A writer
that prepares first retains these processes in its existing `stage:'prepare'`
output records. Failed preparation leaves the actual directory intact and does
not retry initialization or rename an existing checkout on the next call.

There is nothing to pull before the first commit of a confirmed new unborn
connection. Use the existing exact-file `write` and explicit non-force
`HEAD:refs/heads/main` publication directly. For a committed remote, retain the
ordinary selected-branch clone and targeted pull/write composition. An existing
local checkout, different local branch or intervening remote change needs the
application's own connection decision; an unborn observation is not permission
to discard or switch it. Observations and publication are not transactional:
concurrent remote changes, authentication failures and rejected pushes remain
actual errors. No pull failure is converted into success, and no retry, force,
rollback, global setting or fabricated revision is introduced.

### Relative local repository locators

`remoteBase` is an explicit local-path choice, not a hint for a URL parser.
With it, the SDK derives the Git remote argument using the host's native
`path.resolve(remoteBase, remote)`. A relative base, including `''` for the
current directory, is resolved once when a workspace/snapshot owner is
constructed or a targeted operation is accepted. Later working-directory or
options-object changes cannot redirect that accepted operation. Base text
must be representable as a native filesystem path; invalid non-string, NUL or
unpaired-surrogate input reports `TypeError` without changing the supplied text.

Use the same selected absolute base for owners created at different times:

```javascript
import {createGitTextSnapshot} from 'arcane-os';
import {createRepositoryWorkspace} from 'arcane-os/core/repositories';

const remote = connection.locator; // Keep the original catalog string.
const remoteBase = connection.localBaseDirectory; // App-selected absolute base.
const repository = createRepositoryWorkspace({name: connection.name, remote, remoteBase});
const snapshot = createGitTextSnapshot({
    cacheDirectory: connection.cacheDirectory,
    remote, remoteBase, ref: connection.ref, selectPath: applicationSelectPath
});
const target = {remote, remoteBase, ref: connection.ref};
await repository.write({files: selectedFiles, message, target, signal});
// This reader wants the newly published selection, so refresh after the write.
await snapshot.refresh({signal});
```

The original locator and ref remain unchanged. Public targeted results and
writer failure outcomes also retain the explicitly supplied original
`remoteBase`, including its relative spelling or empty string; the derived
absolute argument stays with the Git invocation. No catalog/configuration
rewrite, directory change or extra Git command is introduced. The existing
Git clone may save its supplied remote argument as its ordinary origin setting.

Omit `remoteBase` for configured names such as `origin`, URLs, SCP-like addresses,
remote-helper syntax, or any other string Git should interpret normally. With
an explicit base, even `origin` means the local path under that base. The SDK
does not infer intent from slashes, colons or platform path spelling. Factory
`remoteBase` affects only cloning; an individual pull/push/write uses only its
own `target.remoteBase`. Omitting `target` retains configured Git behavior.
The public `repositoryPull` and `repositoryPush` functions accept the same
target field and capture it before their first asynchronous status operation.
Actual filesystem, Git, credential and remote failures retain their existing
complete diagnostics; this option adds no fallback, retry or unborn-state rule.

## Git identity configuration

```javascript
import {readGitIdentity, createRepositoryWorkspace} from 'arcane-os/core/repositories';

const defaults = await readGitIdentity({signal});
const observations = await readGitIdentity({directory: existingRepositoryDirectory, signal});
const repository = createRepositoryWorkspace({
    name: 'moon-cheese-dispatches',
    remote: applicationConnection.remote,
    gitIdentity: {name: 'Moon Dispatcher', email: 'moon@example.invalid', username: 'moon-account'}
});
```

`readGitIdentity({directory,signal,onEvent,run=runProcess}={})` reads only
`user.name`, `user.email` and `github.user`. It returns:

```text
{
    global: {name, email, githubUser},
    local: {name, email, githubUser} | null,
    effective: {name, email, githubUser} | null
}
```

Every observed field is the complete UTF-8 Git configuration string, including
an empty string, leading U+FEFF and embedded newlines, or `null` when unset.
Git can store values outside UTF-8; those produce
`ARCANE_GIT_IDENTITY_NOT_TEXT` instead of replacement characters. Global and
local observations select Git's corresponding file scopes and honor configured
includes. With an existing
repository `directory`, `effective` reads ordinary Git configuration in that
repository context, including system, global, local, worktree and command
configuration where applicable. Equal local and global values remain separate
observations; the SDK does not infer who wrote or owns a setting. The last
configured scalar value wins within each observation.

Without `directory`, only global configuration is read and `local`/`effective`
are `null`. Relative directories resolve from the process working directory.
Git retains its normal environment and conditional-include context; when no
directory is supplied, that context is the process working directory. These
are independent configuration observations, not a transaction or a claim about
the identity of a prior commit, environment-derived author, or authenticated
GitHub account. `github.user` is a non-secret configured default, not proof of
authentication.

One targeted Git command reads each requested scope. Independent observations
start concurrently and all accepted commands finish their process cleanup
before the reader settles. `signal` uses the existing process owner; the shared
SDK event queue serializes `onEvent` delivery with its usual backpressure.
The reader consumes raw stdout through the existing process contract; stdout
is parsed as configuration rather than emitted as text events. Process
lifecycle and stderr events retain their ordinary route. A supplied `run`
adapter must honor that raw-output contract.
Git's no-match result produces unset fields; other process,
configuration, observer and cancellation failures remain complete. A single
failure retains its original object, code, cause and process `details`; the
reader adds complete captured stdout as the `rawStdout` Buffer on that error.
If the error already has that property or cannot accept it, a new error retains
the original as `cause`, preserves its code, process details and exit code, and
holds this observation's `rawStdout`. Original causal failures stay on that
original error; an attachment exception is retained as `attachmentError`.
An existing `rawStdout` property is never overwritten or invoked to read its value.
The process result's `stdout` remains `null` in raw mode, and its stderr and
other diagnostics remain intact. A decoding failure likewise carries its
original decoding `cause`, complete process `details` and `rawStdout`.
An observer failure already represented by a process error is not added again;
genuinely separate failures use `AggregateError.errors`, each retaining its
own diagnostics.
No configuration file is written and no credential helper is queried by this
reader. The application owns any saved non-secret defaults and repository
overrides through its existing preferences.

Both this workspace factory and
[`createGitTextSnapshot`](git-text-snapshot.md) accept optional
`gitIdentity:{name?,email?,username?}`. They capture supplied strings once during
I/O-free construction. Later edits to that object or a UI selection do not
change accepted work. Omitted or `undefined` fields preserve ordinary inherited
behavior; removing an application override means omitting that field on the
next owner, not changing unmanaged repository configuration. Empty strings are
passed explicitly to Git. Non-string values, NUL and text that cannot be
represented by the native process transport report `TypeError` without silently
rewriting the input.

An application's explicit "global author" choice differs from ordinary Git
inheritance. Pass the observed global `name` and `email` as selected strings to
override repository-local author values for those fields. A global `null` means
that field is unset, not a selected value: passing `null` reports `TypeError`,
and omitting the field allows normal inheritance, including repository-local
configuration. The application must describe that partial/inherited choice
accurately or obtain the missing value before presenting an all-global author
selection. An empty string is a distinct explicit value that Git may reject.
Changed application choices apply to future owners; accepted operations retain
their original selection and may finish without being discarded.

Each supplied name/email becomes command-local `-c user.name=...` or
`-c user.email=...` and the corresponding child-only `GIT_AUTHOR_*` and
`GIT_COMMITTER_*` fields. Those selected fields take precedence over inherited
author/committer settings and environment values; omitted fields, dates and
unrelated environment remain inherited. Git retains its ordinary commit
identity formatting and may reject an unusable identity. This command-local
selection changes neither `process.env` nor global/local Git files.

`username` supplies only command-local `credential.username`. Git's existing
credential helper and remote protocol still own actual authentication. A
URL-embedded username or helper behavior can affect the selected credential;
this option neither rewrites the remote nor selects an SSH account or proves a
GitHub login. No account enumeration, secret storage or `gh` dependency is added.
See Git's [configuration](https://git-scm.com/docs/git-config),
[author environment](https://git-scm.com/docs/git#_git_commits) and
[credential username](https://git-scm.com/docs/gitcredentials) contracts.

The selected settings accompany every workspace Git command, including clone,
pull, commit and push, and every bare-snapshot Git command, including init and
fetch. Existing arguments, content, output, errors, queue and cancellation
semantics remain unchanged. Other repository helpers and CLI cwd defaults keep
their existing behavior.

### Clone-local author selection

`createRepositoryWorkspace` also accepts `cloneIdentity:{name?,email?}` when the
application wants its explicit selection retained by a newly owned clone:

```javascript
const repository = createRepositoryWorkspace({
    name: 'moon-cheese-dispatches',
    remote: applicationConnection.remote,
    cloneIdentity: {name: 'Moon Dispatcher', email: 'moon@example.invalid'}
});
await repository.open({signal});
```

Each supplied field becomes `clone --config user.name=<name>` or
`clone --config user.email=<email>`. Git writes these choices to the new local
configuration before the initial checkout, on every supported platform. This
adds no separate configuration command or post-clone initialization. It applies
whenever the owner's first preparing operation needs a clone, including `write`.

The exact strings are captured during I/O-free construction. Empty strings are
explicit values; omitted or `undefined` fields add no setting, preserving Git's
global inheritance, includes and any template configuration. Later caller edits
do not alter an accepted owner. Non-string fields, NUL and text that the native
process transport cannot represent report `TypeError` instead of changing input.
Git retains ordinary configuration precedence, author formatting and failures.

An existing checkout is never reconfigured by `cloneIdentity`, even when it is
supplied. Changing or omitting the selection on a later owner does not remove a
previously stored local setting. This option changes no global configuration,
credentials, username selection, branch or remote. A failed or cancelled clone
retains its actual diagnostics and any partial directory for the caller.

`gitIdentity` remains the separate command-local selection described above.
When both options are supplied, `cloneIdentity` selects the new clone's saved
name/email while `gitIdentity` controls the selected child commands and their
author/committer environment. Application defaults and per-repository choices
remain application-owned. Neither option identifies the authenticated GitHub
account or establishes who submitted a historical record.

## Write, commit and push selected text

```javascript
const result = await repository.write({
    files: [{path: 'dispatches/moon-cheese.md', content: completeAuthoredText}],
    message: authoredCommitMessage,
    signal
});
```

`write({files:[{path,content}],message,target,signal}={})` requires at least one explicit
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
message is streamed unchanged through standard input. Without `target`, one
ordinary `git push` then uses that repository's existing remote/ref configuration, the optional
process-local identity selection above, existing credentials and hooks.
With `target`, the final push uses the selected current-HEAD mapping above.
There is no implicit pull, branch switch, forced push,
hook bypass, automatic retry, rollback or reset. If Git reports no changes to
commit, that actual failure is returned; the SDK creates no empty commit.
These are Git's documented [selected-path commit](https://git-scm.com/docs/git-commit#Documentation/git-commit.txt---only)
and [literal pathspec](https://git-scm.com/docs/git#Documentation/git.txt---literal-pathspecs) semantics.

Existing Git attributes, clean filters, EOL settings and hooks continue to apply
when Git stages/commits content. The filesystem write preserves the original
text; this API does not claim that repository-configured filters leave Git blob
text identical. It preserves those settings. A push may also send existing history or other
refs selected by the repository's ordinary push configuration when no explicit
target is supplied.

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
When supplied, `target:{remote,ref,remoteBase?}` is included in the result or
failure outcome with the original accepted strings.
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
