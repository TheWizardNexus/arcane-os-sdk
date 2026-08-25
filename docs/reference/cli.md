# Arcane CLI reference

The `arcane` and `arcane-os` executables invoke the same headless SDK toolchain.
Use the command name that is unambiguous in the current project; project-local
scripts should resolve the exact package version pinned by the app's lockfile.

Every potentially blocking operation acknowledges before it begins, owns its
work, emits progress or heartbeat records, observes cancellation where safe,
and exits nonzero on failure. Machine output is defined by
`arcane-cli-events/1`.

## Command inventory

| Command | Scope and result |
| --- | --- |
| `arcane new <id>` | Creates one external app workspace. |
| `arcane init [id]` | Initializes one app in an external or integrated workspace without rewriting unrelated files. |
| `arcane doctor` | Reads and reports Node/tooling, SDK runtime, workspace, optional Arcane source recognition, and supported managed ArcaneOllama readiness. |
| `arcane import-map` | Authenticates and refreshes one app's managed browser import map and matching HTML entry. |
| `arcane dev` | Starts one owned browser development server for one selected app. |
| `arcane test` | Runs one app test boundary or one explicit integrated shared test file. |
| `arcane check` | Validates one app boundary or the canonical integrated shared check. |
| `arcane package` | Creates one browser release, or plans it with `--dry-run`. |
| `arcane verify` | Authenticates one existing browser release. |
| `arcane bundle` | Creates one deterministic external-app release archive. |
| `arcane verify-bundle` | Verifies one deterministic external-app release archive without extraction. |
| `arcane native-doctor` | Diagnoses one explicit native provider and host. |
| `arcane native-prepare` | Runs one standalone provider toolchain-integrity preparation diagnostic. |
| `arcane build` | Packages, plans, builds, and retained-verifies one target artifact. |
| `arcane run` | Verifies and serves an existing browser release, or packages, plans, builds, verifies, and launches one paired native artifact. |
| `arcane update-check` | Performs one explicit, read-only npm dist-tag query for the installed SDK version. |
| `arcane targets` | Lists target ids, declared status, formats, architectures, signing profiles, methods, and pairing reason. |
| `arcane repo status\|pull\|push` | Runs one selected repository operation for the current app workspace. |

## Parser-wide options

The parser recognizes these names before the selected command applies its own
meaning and cardinality rules:

| Option | Value / form | Meaningful commands |
| --- | --- | --- |
| `--path` | directory | `new` |
| `--display-name` | string | `new`, `init` |
| `--workspace` | directory | Commands that select an external or integrated workspace; defaults to `.`. |
| `--app` | app id | Workspace/app operations except shared scope and `verify-bundle`. |
| `--arcane-root` | directory | `doctor`, native `build`/`run`, `native-doctor`, `native-prepare` |
| `--host` / `--port` | host / integer 0–65535 | Browser `dev` and `run`; defaults to `127.0.0.1:8000`. |
| `--target` | target id | `new`, `init`, native diagnostics, `build`, `run` |
| `--format` / `--signing` | target-supported values | Native diagnostics, `build`, `run` |
| `--output-root` | directory | Native `build` and `run` |
| `--scope` | `app` or `shared` | `test`, `check`; defaults to `app`. |
| `--test-file` | repository-relative `.test.mjs` | `test --scope shared` only |
| `--artifact` | bundle path | `bundle`, `verify-bundle` |
| `--output` | `human`, `json`, `ndjson` | Every invocation; the final occurrence wins. |
| `--git` | flag | `new` |
| `--skip-tests` | flag | `check --scope app` |
| `--dry-run` | flag | `package`; parser-supported on `build` with the boundary below |
| `--require-local-ai` | flag | `doctor` |
| `--overwrite` | flag | `bundle` only |
| `--help`, `-h` | flag | Prints help and exits zero. |
| `--version`, `-v` | flag | Prints the exact SDK version and exits zero. |

Value options accept `--name value` and `--name=value`; a bare `--` ends option
parsing. Repeated value options currently use the last value, and repeated flags
are idempotent. Unknown names, missing values, excess positionals, invalid
command-specific enums/cardinality, and the explicitly rejected cross-command
cases fail before work begins.

Other recognized but inapplicable options are not yet uniformly rejected. They
can be parsed and then ignored by a command. Do not depend on that permissive
behavior: pass only the options listed for the selected command.

## Output and exit contract

Human mode writes progress and terminal diagnostics to stderr and the selected
result to stdout. JSON mode writes accepted/running event envelopes to stderr
and exactly one final JSON success or error envelope to stdout. NDJSON mode
writes every ordered event, including its one terminal event, to stdout.

Structured payload normalization converts `bigint` to decimal text and errors
to the public error record, omits functions, symbols, `undefined`, and cycles,
and keeps repeated non-cyclic values. Exit status is `0` for success, `1` for an
ordinary usage/operation failure, and `130` for cancellation. The separate
`arcane-test` infrastructure runner uses status `2` for its own infrastructure
failure; it is not an `arcane` command.

## `arcane new`

### Overview

Creates one repository-shaped external application workspace and the selected
app. It never creates more than one app or silently installs a global SDK.

```text
arcane new <id> [--path <directory>] [--display-name <name>] [--target <target>] [--git]
```

### Options and result

`--path` selects the new workspace, `--display-name` sets presentation text,
`--target` declares one initial target, and `--git` initializes that exact
directory as a repository. Native target scaffolds also retain `browser` and
include the required icon. The result reports the workspace, app, descriptor,
target, and created paths.

### Example

```bash
npm exec -- arcane new hello-arcane --path ./hello-arcane --target portable --git
```

## `arcane init`

### Overview

Adds missing Arcane application files to one existing workspace. Integrated
initialization writes only the selected `apps/<id>/` boundary and does not add
an SDK dependency to the Arcane OS repository.

```text
arcane init [id] [--workspace <directory>] [--app <id>] [--display-name <name>] [--target <target>]
```

### Errors and safety

Existing conflicting files, invalid ids, an ambiguous app selection, or an
incompatible workspace fail rather than being overwritten. Initialization is
idempotent only for files whose existing content satisfies the scaffold
contract.

### Example

```bash
npm exec -- arcane init reports --target browser
```

## `arcane doctor`

### Overview

Performs read-only Node, npm, Git, SDK runtime, workspace, optional Arcane
source-checkout recognition, and supported ArcaneOllama managed-service
assessment. It reports unavailable optional capabilities without turning them
into packaging failures.

```text
arcane doctor [--workspace <directory>] [--app <id>] [--arcane-root <directory>] [--require-local-ai]
```

### Availability

The SDK/runtime checks are **Node**. `--arcane-root` only checks for the
expected Arcane development-lifecycle source marker; it does not load or
diagnose a native target provider. Use `native-doctor --target ...` for that
boundary. Managed ArcaneOllama inspection currently runs on Windows and reports
unsupported elsewhere. Doctor never installs, repairs, starts, or mutates
Ollama. `--require-local-ai` changes an otherwise optional local-AI readiness
failure into a failed doctor result.

### Example

```bash
npm exec -- arcane doctor --workspace . --arcane-root "../Arcane OS"
```

## `arcane import-map`

### Overview

Authenticates one selected application's physical browser runtime, generates
its standard browser import map, and commits the map artifact and matching
managed HTML entry as one bounded refresh.

```text
arcane import-map [--workspace <directory>] [--app <id>]
```

`--workspace` defaults to the current directory. `--app` selects one app when
the workspace does not already identify exactly one. The command accepts no
positional arguments and supports app scope only. `arcane-os import-map` is the
identical executable alias.

The generated artifact is
`apps/<id>/modules/arcane.importmap.json`. Its exact JSON is also installed in
the app entry as `<script type="importmap" data-arcane-import-map>` before
module loading. In SDK `0.1.1`, the authenticated physical-v1 runtime produces
86 entries and intentionally has no package-root mapping.

### Result and safety

Success returns the normal selected-workspace wrapper:

```javascript
{
    workspaceRoot,
    workspaceMode, // 'external' or 'integrated'
    appId,
    importMap:{
        appId,
        artifactPath,
        artifactRelativePath,
        entryPath,
        imports,
        entryCount:86,
        excludedModules:['modules/CaseEvidenceIndexer.js'],
        files:[
            {role:'artifact',path,bytes,sha256},
            {role:'entry',path,bytes,sha256}
        ],
        cleanupWarnings,
        committed:true
    }
}
```

The two file records bind the committed byte length and SHA-256 for the artifact
and HTML entry. A post-commit observer failure preserves delivery as a successful
receipt with `eventDelivery.status === 'degraded'` and
`ARCANE_EVENT_DELIVERY_FAILED`; it does not roll back valid application bytes.
Packaging refuses a committed refresh that reports cleanup warnings.

The canonical integrated-legacy workspace has a deliberate compatibility
result instead of an artifact: `importMap.skipped` is `true`,
`importMap.compatibility` is `'integrated-legacy'`, and the reason states that
the physical two-route browser runtime is retained.

`new` and `init` generate the map during scaffolding. `dev` refreshes it once
before binding; non-dry-run `package` and browser `build` refresh it before
collection. Paired native packaging refreshes each packaged app. `test`,
`check`, `verify`, `bundle`, and browser `run` do not regenerate it. There is no
watcher, polling, scheduled refresh, download, or self-update behavior.

There is no supported `--dry-run` for `import-map`: do not pass that parser-wide
flag because this command performs the real commit. Import-map-specific failures
use `ARCANE_IMPORT_MAP_INVALID`, `ARCANE_IMPORT_MAP_UNRESOLVED`, or
`ARCANE_IMPORT_MAP_COLLISION`; packaging can additionally report
`ARCANE_IMPORT_MAP_CLEANUP_FAILED`. Workspace, policy, usage, busy, and
cancellation failures retain their normal SDK codes.

### Example

```bash
npm exec -- arcane import-map --workspace . --app hello-world --output json
```

Deep details: [authenticated browser delivery and receipts](protocols.md#browser-runtime-delivery).

## `arcane dev`

### Overview

Starts one loopback development server for one selected app and maps the exact
workspace/runtime routes. It is a development convenience, not a production
security boundary.

```text
arcane dev [--app <id>] [--host 127.0.0.1] [--port 8000]
```

### Lifecycle

The command reports acceptance before bind/start work, emits the final URL,
owns the server until cancellation, and restores failure to the process exit.
The default host is loopback. Exposing another interface is an explicit
development choice and does not add authentication.

### Example

```bash
npm exec -- arcane dev --app hello-world --port 8000
```

## `arcane test`

### Overview

Runs exactly one test scope.

```text
arcane test [--app <id>] [--scope app]
arcane test --scope shared --test-file <repo-relative.test.mjs>
```

### Scope

App scope selects only the external workspace test boundary plus the selected
app tests, or only the selected integrated app's tests. Shared scope is
integrated-only and admits one exact repository-relative `.test.mjs` through
Arcane's fixed provider. It cannot run an arbitrary command, glob every test,
or cross into another app.

### Example

```bash
node ../arcane-os-sdk/bin/arcane.mjs test \
  --workspace "../Arcane OS" \
  --scope shared \
  --test-file test/component-contracts.test.mjs
```

## `arcane check`

### Overview

Runs the canonical validation boundary for one app, or the one canonical
integrated shared development check.

```text
arcane check [--app <id>] [--scope app] [--skip-tests]
arcane check --scope shared
```

### Test behavior

`--skip-tests` is app-scope-only and skips the selected app test stage without
weakening descriptor, runtime, or source checks. Shared check owns Arcane's
canonical development check and does not accept a custom command.

### Example

```bash
npm exec -- arcane check --app hello-world
```

## `arcane package`

### Overview

Creates and authenticates one browser release beneath `dist/<id>/`, preserving
the prior output until the replacement is verified.

```text
arcane package [--app <id>] [--dry-run]
```

### Result and receipts

The result includes the release root, manifest, positive inventory, hashes,
byte counts, policy identity, and a process-authenticated release receipt.
`--dry-run` plans the selected package without replacing output.

### Example

```bash
npm exec -- arcane package --app hello-world
```

## `arcane verify`

### Overview

Authenticates one existing browser release against the app descriptor, package
policy, exact inventory, file identities, byte lengths, and hashes.

```text
arcane verify [--app <id>]
```

### Evidence boundary

Verification proves consistency for the exact observed release state. It does
not prove publisher authorization, native signing, installation, launch, or
release acceptance.

### Example

```bash
npm exec -- arcane verify --app hello-world
```

## `arcane bundle`

### Overview

Seals one already packaged and authenticated external app into the deterministic
`.arcane-app.tar.gz` contract.

```text
arcane bundle [--app <id>] [--artifact <file>.arcane-app.tar.gz] [--overwrite]
```

### Replacement behavior

The default output is `dist/<id>-<version>.arcane-app.tar.gz`. An existing path
is refused unless `--overwrite` is explicit. Even then, the prior artifact is
retained until the promoted bytes pass final exact-length, hash, link, and
filesystem-identity checks.

### Example

```bash
npm exec -- arcane bundle --app hello-world
```

## `arcane verify-bundle`

### Overview

Parses and authenticates one release bundle without extracting it.

```text
arcane verify-bundle <file.arcane-app.tar.gz>
```

### Validation

The verifier enforces the canonical gzip member, USTAR metadata and order,
portable paths, expansion limits, canonical descriptor, release policy,
inventory, bytes, and hashes. Internal consistency is not installation
authority.

### Example

```bash
npm exec -- arcane verify-bundle dist/hello-world-1.0.0.arcane-app.tar.gz
```

## `arcane native-doctor`

### Overview

Loads one fixed native provider from one explicit Arcane OS checkout and
diagnoses the selected target/host prerequisites without building an app.

```text
arcane native-doctor --target <native-target> --arcane-root <directory>
```

### Availability

This is a **Node** orchestration command with **Native** provider behavior. The
provider fails honestly when the selected platform, architecture, or toolchain
is unavailable; it never returns a browser package as a substitute.

### Example

```bash
npm exec -- arcane native-doctor \
  --target windows-x64 \
  --arcane-root "../Arcane OS"
```

## `arcane native-prepare`

### Overview

Runs the provider's standalone toolchain-integrity preparation diagnostic for
one target. It is not a prerequisite command to repeat immediately before
`build`; `build` prepares and retains its own process-owned receipt.

```text
arcane native-prepare --target <native-target> --arcane-root <directory>
```

### Example

```bash
npm exec -- arcane native-prepare \
  --target linux-x64 \
  --arcane-root "../Arcane OS"
```

## `arcane build`

### Overview

Packages one app, prepares one provider, creates one immutable plan, builds one
target, and retained-verifies one result.

```text
arcane build --target <target> [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>] [--dry-run]
```

### Cardinality and outputs

The command selects one workspace, app, target, architecture, format, signing
profile, and output root. Current providers emit a verified portable directory,
Windows x64 EXE bundle, Linux x64/ARM64 DEB, or development-signed Android APK.
The output remains target-specific inside the common plan/receipt contract.
`--dry-run` is implemented for the browser build path. Native builds reject it
rather than returning a fictional native artifact plan.

### Example

```bash
npm exec -- arcane build \
  --target windows-x64 \
  --arcane-root "../Arcane OS" \
  --output-root "../arcane-native-output"
```

## `arcane run`

### Overview

For `--target browser`, verifies the existing current `dist/<app>` release
and starts its packaged server; it does not package or rebuild that release.
For a paired native target, performs package, prepare, plan, build, retained
verification, launch, readiness, and owned cancellation in one process so
process-local receipts remain authoritative.

```text
arcane run [--target <target>] [--app <id>] [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
```

### Availability

Browser run is **Node control plane / browser data plane** and requires an
existing verified release (run `arcane package` first). Windows, Linux, and
Android providers expose supported paired native run paths. Portable output is
a verified directory and intentionally cannot run. Android run requires one
connected physical/native ARM64 device for the current target.

### Example

```bash
npm exec -- arcane run \
  --target linux-x64 \
  --arcane-root "../Arcane OS" \
  --output-root "../arcane-native-output"
```

## `arcane update-check`

### Overview

Performs one explicit, on-demand check of the installed Arcane SDK version
against its matching npm distribution tag.

```text
arcane update-check
```

This is a maintainer/user query, not app runtime behavior. The command never
polls, downloads a package, installs dependencies, changes files, mutates npm
configuration, or self-updates. Arcane applications do not run it automatically.

### Request boundary

The command makes one bounded, credential-free HTTPS `GET` to the approved
`registry.npmjs.org` origin for the `arcane-os` dist-tag document. It rejects
redirects and changed request identity, omits credentials and referrer data,
disables cache use, accepts only JSON, limits the response to 32 KiB, and uses a
2.5-second timeout. The CLI does not expose registry, package, or timeout
overrides.

An installed prerelease version selects the npm `dev` tag. A stable installed
version selects `latest`.

### Result

Success returns:

```javascript
{
    packageName:'arcane-os',
    currentVersion:'0.1.0',
    registryVersion:'0.1.1',
    tag:'latest',
    status:'update-available', // or 'current' or 'ahead'
    updateAvailable:true,
    registry:'https://registry.npmjs.org',
    checkedAt:'2026-08-24T04:00:00.000Z'
}
```

`current` means the installed and registry versions match. `ahead` means the
installed version is newer than the selected registry tag. `update-available`
means the selected registry version is newer; the boolean is true only for that
status. Reporting availability does not authorize or perform installation.

### Events, errors, and cancellation

The normal CLI envelope emits `operation.accepted`, then
`update.check.started`. Success emits `update.check.completed` followed by the
terminal `operation.completed` result. HTTP failure, timeout, changed origin,
oversized/non-JSON/invalid UTF-8 content, malformed dist tags, or invalid semantic
versions emit `update.check.failed` and terminate as `operation.failed` with
`ARCANE_UPDATE_CHECK_FAILED` and exit status `1`.

`SIGINT` or `SIGTERM` cancels the owned request. Cancellation terminates as
`operation.cancelled` with exit status `130`; it does not masquerade as an update
failure. Output framing follows the global human/JSON/NDJSON contract above.

### Example

```bash
npm exec -- arcane update-check --output json
```

## `arcane targets`

### Overview

Lists the current target descriptors without building. Descriptors report
protocol, id, display name, declared status, platforms, architectures, formats,
signing modes, advertised adapter methods, and the reason a target is deferred
or requires pairing. The `methods` list describes the adapter interface; it is
not a live runnable/readiness probe. Use `native-doctor` for an explicit
provider/host assessment, and note that portable output intentionally rejects
run even though adapters share the common method shape.

### Example

```bash
npm exec -- arcane targets --output json
```

## `arcane repo`

### Overview

Runs one repository action for the selected application workspace.

```text
arcane repo status|pull|push
```

### Behavior

`status` is read-only. `pull` and `push` use the repository's already configured
remote and credentials, stream the owned child process, and surface nonzero
failure. The command does not create credentials, choose another repository, or
loop across workspaces.

### Example

```bash
npm exec -- arcane repo status
```

## Machine output

`--output json` returns one complete JSON document after structured progress is
collected. `--output ndjson` emits one event record per line as work proceeds.
Human output is presentation only; automation should consume the versioned
machine fields and tolerate documented additive detail.

Every record identifies the CLI event protocol, sequence, operation, phase,
level, message, and structured detail as applicable. Acceptance precedes
blocking work, terminal completion/failure closes the owned stream, and stdout
in machine modes contains no unframed child-process text.

Deep details: [SDK/CLI protocols](protocols.md#sdk-package-and-cli-protocols).

## Programmatic-only operation names

`executeOperation()` also accepts `plan` and `native-verify`. The CLI parser has
no `arcane plan` or `arcane native-verify` route in this SDK version. Call the
documented JavaScript operations directly when that lower-level lifecycle is
required; do not present those names as user commands or infer them from the
parser's recognized option set.
