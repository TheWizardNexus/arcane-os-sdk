# Arcane API session, provisioning, diagnostics, and development guides

These guides cover host-session control, read-only provisioning plans, local
diagnostics, and the bounded Developer application surface. They supplement the
canonical method inventory in [`docs/arcane-api.md`](../../arcane-api.md).

## Arcane.session.logout()

### Overview

Requests logout of the current operating-system session. It does not merely
close the Arcane window: other applications in the same desktop session may be
closed and unsaved work may be lost.

This method is restricted to a Shell application with `session.control` and is
an exclusive host mutation. Present an explicit confirmation immediately before
calling it.

### Return value and completion

On a real host the promise resolves after the operating system accepted process
creation, with `{requested:true,accepted:true,simulated:false,command,pid}`.
Simulation has a distinct shape:
`{requested:true,accepted:true,simulated:true,command,args}`. It starts no
process and therefore has no `pid`. Acceptance is not proof that a real logout
completed; the renderer may lose its connection as the session ends.

Unsupported session controllers, process-dispatch failure, and a ten-second
dispatch timeout reject with a structured `Arcane.Error`.

### Example

```js
async function requestOperatingSystemLogout() {
    const access = await Arcane.capabilities.list();
    if (!access.methods.includes('session.logout')) {
        throw new Error('Logout is unavailable in this application');
    }
    return Arcane.session.logout();
}

document.querySelector('#confirm-logout')?.addEventListener(
    'click',
    async function handleConfirmedLogout() {
        await requestOperatingSystemLogout();
    }
);
```
## Arcane.provisioning.plan()

### Overview

Builds a read-only plan for provisioning one or more local Arcane users. It
validates host-specific username policy, inspects current installation and
requirements, and describes the work that a later privileged operation would
perform. It does not create users, change passwords, assign shells, or install
Arcane.

### Input and result

Pass one username or an array. The frontend normalizes a single value to an
array; Core applies the native username policy and rejects the whole request
when validation fails.

The Provisioner-only method requires `provisioning.manage` and resolves to:

```text
{
  ok, version, installation, requirements,
  users: [{username, exists, action}],
  usernamePolicy, elevated, simulation, blocked, steps
}
```

Treat the returned plan as a current snapshot. Re-read it before presenting a
later mutation because accounts, elevation, requirements, or installation state
may have changed.

### Example

```js
async function previewProvisioning(usernames) {
    const plan = await Arcane.provisioning.plan(usernames);
    for (const user of plan.users) {
        console.log(`${user.username}: ${user.action}`);
    }
    return plan;
}

await previewProvisioning(['arcane-demo-user']);
```

## Arcane.diagnostics.recentErrors()

### Overview

Returns up to 60 recent structured Core errors, newest first, for an application
granted `diagnostics.read`. Use it to populate a local diagnostics view after a
failure; do not upload complete records automatically because technical fields
can contain local paths, command output, usernames, or other machine context.

### Diagnostic records

Each record includes an opaque `id`, `time`, `scope`, stable `code`, user-facing
`message` and `resolution`, status and retry metadata, plus bounded technical
fields when the originating error supplied them. The in-memory list is not a
durable audit log and is replaced as newer failures arrive.

### Example

```js
async function showRecentDiagnosticSummaries() {
    const diagnostics = await Arcane.diagnostics.recentErrors();
    for (const item of diagnostics) {
        console.log(`${item.time} ${item.code}: ${item.message}`);
    }
}

await showRecentDiagnosticSummaries();
```

## Arcane.diagnostics.get()

### Overview

Retrieves one complete in-memory diagnostic by the opaque ID returned through
`Arcane.diagnostics.recentErrors()`, a rejected `Arcane.Error.diagnosticId`, or a
`core.error` event. Use this only when the user asks to inspect the corresponding
failure in detail.

### Return value and errors

Requires `diagnostics.read` and resolves to the matching diagnostic record. It
rejects with `DIAGNOSTIC_NOT_FOUND` after the record is evicted or Core restarts.
Do not assume an ID is portable between host sessions.

### Example

```js
async function loadNewestDiagnostic() {
    const recent = await Arcane.diagnostics.recentErrors();
    if (recent.length === 0) return null;
    return Arcane.diagnostics.get(recent[0].id);
}

const diagnostic = await loadNewestDiagnostic();
if (diagnostic) console.log(diagnostic.code, diagnostic.resolution);
```

## Arcane.development.inspect()

### Overview

Inspects one explicit canonical Arcane OS checkout and reports developer
readiness without changing it. The Developer application uses this snapshot to
show repository identity, Git state, external tools, signing readiness, and the
allowlisted setup tasks that are ready or need work.

### Root and result

Requires `development.read` and the `developer` app ID. `root` must be an
existing absolute, non-link directory containing the expected `.git`, root
package, app-building SOP, theme, and canonical machine-bundle markers. Core
rejects a different or unsafe layout rather than treating any directory as a
development workspace. Git must be installed and the checkout must pass the
repository-lineage check; otherwise the call rejects with
`DEVELOPMENT_GIT_REQUIRED` or a more specific repository error.

The result contains `{root,runtimeVersion,repository,git,tools,signing,readiness}`.
`readiness.tasks` is the authoritative list to display; do not invent setup task
IDs or infer readiness from path names alone.

### Example

```js
async function inspectSelectedCheckout(root) {
    const inspection = await Arcane.development.inspect(root);
    for (const task of inspection.readiness.tasks) {
        console.log(`${task.label}: ${task.ready ? 'ready' : task.message}`);
    }
    return inspection;
}

const inspection = await inspectSelectedCheckout('C:\\ArcaneOS');
console.log(inspection.repository.bundleVersion);
```

## Arcane.development.context()

### Overview

Returns bounded, redacted source excerpts from tracked text files in an approved
Arcane checkout. It is intended for local developer assistance, not arbitrary
filesystem search. Core excludes Git metadata, dependencies, generated output,
credential-like paths, secret file names, binary extensions, links, and files
outside the checkout.

### Query and result bounds

Requires `development.read` and the `developer` app ID. `query` must contain
1–4,096 text characters. Core derives at most six search terms, ranks tracked
files, and returns at most ten files, 6,144 characters of excerpt per file, and
49,152 characters of excerpt text overall. Individual candidates over 512 KiB
are excluded. Git and valid repository lineage are prerequisites; a missing Git
installation rejects with `DEVELOPMENT_GIT_REQUIRED` before source collection.

The promise resolves to `{root,query,files,totals}`. Each file record contains
`{path,bytes,sha256,truncated,redacted,content}`. A digest identifies the read
bytes for correlation only; it is not publisher authentication. Review returned
content before sending it to any external service even when `redacted` is true.

### Example

```js
async function findStorageImplementation(root) {
    const result = await Arcane.development.context(
        root,
        'Where is app-scoped storage validated and persisted?'
    );
    return result.files.map(function selectContextFile(file) {
        return { path: file.path, content: file.content, redacted: file.redacted };
    });
}

console.log(await findStorageImplementation('C:\\ArcaneOS'));
```

## Arcane.development.setup()

### Overview

Runs one setup task previously reported by `Arcane.development.inspect()`. This
is a Developer-only, exclusive mutation requiring `development.manage`. It can
install dependency trees, configure Git hooks, or initialize local Microsoft NT
development signing, so show the exact task and obtain confirmation before
dispatch.

### Task IDs and operation result

Pass the approved checkout `root` and one exact `taskId`:

- `root-dependencies`
- `machine-dependencies`
- `git-hooks`
- `windows-signing` (Microsoft NT only)

Core rejects every other value. Node.js 22+ with npm and Git are required for
all four tasks because Core validates repository lineage before dispatching any
setup operation. Missing Git rejects with `DEVELOPMENT_GIT_REQUIRED`. The
promise resolves to
`{root,taskId,completed:true,exitCode,operation}` after the owned task completes.
Follow `operation.started`, `operation.log`, `operation.progress`,
`operation.completed`, and `operation.failed` for visible long-work status.

### Example

```js
async function runConfirmedSetupTask(root, taskId) {
    const inspection = await Arcane.development.inspect(root);
    const task = inspection.readiness.tasks.find(function findSetupTask(item) {
        return item.id === taskId;
    });
    if (!task || !task.available) throw new Error('Setup task is unavailable');
    return Arcane.development.setup(root, taskId);
}

document.querySelector('#install-root-dependencies')?.addEventListener(
    'click',
    async function handleDependencySetup() {
        const result = await runConfirmedSetupTask('C:\\ArcaneOS', 'root-dependencies');
        console.log(result.completed, result.exitCode);
    }
);
```

## Arcane.development.installNode()

### Overview

Installs the supported external Node.js development runtime through Arcane's
owned Developer workflow. This is a privileged, exclusive mutation available
only to the Developer application with `development.manage`, and only on
Microsoft NT. Linux callers receive guidance to use the operating system's
trusted package channel instead.

### Result and operation lifecycle

The method takes no arguments and resolves to
`{installed,simulated,node,operation}`. On a real host, Core verifies that a
supported Node.js 22-or-newer runtime is usable after installation and rejects
when the installation command finishes without producing that state.

This can start external package-management work. Require confirmation and keep
the operation events visible rather than blocking the UI or promising a fixed
completion time.

### Example

```js
async function installNodeAfterConfirmation() {
    const access = await Arcane.capabilities.list();
    if (!access.methods.includes('development.node.install')) {
        throw new Error('Managed Node.js installation is unavailable');
    }
    return Arcane.development.installNode();
}

document.querySelector('#install-node')?.addEventListener(
    'click',
    async function handleNodeInstallation() {
        const result = await installNodeAfterConfirmation();
        console.log(result.node.version);
    }
);
```
