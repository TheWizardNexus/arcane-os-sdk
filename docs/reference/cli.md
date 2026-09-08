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
| `arcane import-map` | Refreshes one app's managed browser import map and every directly navigable descriptor-selected HTML/HTM document. |
| `arcane upgrade` | Runs the external application's ordinary `npm upgrade` command. |
| `arcane dev` | Starts one owned browser development server for one selected app. |
| `arcane test` | Runs one app test boundary or one explicit integrated shared test file. |
| `arcane check` | Validates one app boundary or the canonical integrated shared check. |
| `arcane package` | Creates one browser release, or plans it with `--dry-run`. |
| `arcane verify` | Validates one explicitly selected existing browser release. |
| `arcane bundle` | Creates one deterministic external-app release archive. |
| `arcane verify-bundle` | Verifies one deterministic external-app release archive without extraction. |
| `arcane native-doctor` | Diagnoses one explicit native provider and host. |
| `arcane native-prepare` | Runs one standalone provider toolchain preparation diagnostic. |
| `arcane build` | Packages, plans, and builds one target artifact. |
| `arcane run` | Serves an existing browser release, or packages, plans, builds, and launches one paired native artifact. |
| `arcane update-check` | Performs one explicit, read-only npm dist-tag query for the installed SDK version. |
| `arcane targets` | Lists target ids, declared status, formats, architectures, signing profiles, methods, and pairing reason. |
| `arcane repo status\|pull\|push` | Runs one selected repository operation for the current app workspace. |
| `arcane mail key set\|status\|delete` | Manages one server-only Resend API-key profile in `.env.json`. |
| `arcane mail send` | Performs one explicit, idempotency-keyed Resend attempt from a complete JSON report on redirected stdin. |
| `arcane mail serve` | Starts one Arcane-to-Resend gateway with a server-only provider profile, a selected listener, and optional CORS and recipient configuration. |

## Parser-wide options

The parser recognizes these names before the selected command applies its own
meaning and cardinality rules:

| Option | Value / form | Meaningful commands |
| --- | --- | --- |
| `--path` | directory | `new` |
| `--display-name` | string | `new`, `init` |
| `--workspace` | directory | Commands that select an external or integrated workspace; defaults to `.`. |
| `--app` | app id or label | Workspace/app operations except shared scope and `verify-bundle`; optional diagnostic label for `mail serve`. |
| `--arcane-root` | directory | `doctor`, native `build`/`run`, `native-doctor`, `native-prepare` |
| `--host` / `--port` | host / integer 0–65535 | Browser `dev`/`run` default to HTTPS at `127.0.0.1:8000`; `mail serve` defaults to HTTPS with HTTP/2 at `0.0.0.0:4433` and accepts an explicit bind host. |
| `--http-port` | integer 0–65535 | Browser `dev`/`run` HTTP redirect listener; defaults to `0`, which selects an available port. |
| `--public` | flag | `dev`; binds to `0.0.0.0` unless `--host` explicitly selects another address. |
| `--http` | flag | `dev` only; serves source and PWA routes on one HTTP listener selected by `--port`, without TLS. |
| `--https` | flag | Browser `dev`/`run`; explicitly selects the default HTTPS transport. |
| `--cert` / `--key` | PEM file paths | Browser `dev`/`run`; supply both for an explicit certificate chain and private key. Relative paths resolve from the workspace. |
| `--target` | target id | `new`, `init`, native diagnostics, `build`, `run` |
| `--format` / `--signing` | target-supported values | Native diagnostics, `build`, `run` |
| `--output-root` | directory | Native `build` and `run` |
| `--scope` | `app` or `shared` | `test`, `check`; defaults to `app`. |
| `--test-file` | repository-relative `.test.mjs` | `test --scope shared` only |
| `--artifact` | bundle path | `bundle`, `verify-bundle` |
| `--profile` | credential profile id | `mail send`, `mail serve` |
| `--from` | optional sender override | `mail send`, `mail serve`; otherwise the report or provider template supplies the sender. |
| `--origin` | optional exact browser origin | `mail serve`; selects an explicit CORS allowed origin. |
| `--allow-to` | optional comma-separated addresses | `mail serve` |
| `--report-key` | nonempty string | `mail send`; caller-owned stable Resend idempotency key, forwarded unchanged |
| `--request-timeout` | optional integer from 1 through 2147483647 milliseconds | `mail send`, `mail serve` |
| `--output` | `human`, `json`, `ndjson` | Every invocation; the final occurrence wins. |
| `--git` | flag | `new` |
| `--skip-tests` | flag | `check --scope app` |
| `--dry-run` | flag | `package`; parser-supported on `build` with the boundary below |
| `--require-local-ai` | flag | `doctor` |
| `--overwrite` | flag | `bundle` only |
| `--secret-stdin` | flag | `mail key set`; requires redirected input |
| `--report-stdin` | flag | `mail send`; requires redirected JSON input |
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

Refreshes one selected application's physical browser runtime map, generates
its standard browser import map, discovers every directly navigable
`.html`/`.htm` document admitted by the selected descriptor's existing
include/exclude rules, and commits the map artifact plus those managed documents
as one transactional refresh. A directly navigable entry document declares exactly
one `<meta name="arcane-app-id" content="<selected-id>">`; an unmarked secondary
document may instead carry an active `<base>`.
Wrong or duplicate explicit app identity fails. The renderer then requires one
path-correct base for every selected document. Included HTML files with neither
the identity marker nor an active base are component fragments: they remain
package files and are not rewritten with a document-level import map.
Packaging and development use the same discovery owner. Packaging consumes
the saved managed import maps in directly navigable source pages.

```text
arcane import-map [--workspace <directory>] [--app <id>]
```

`--workspace` defaults to the current directory. `--app` selects one app when
the workspace does not already identify exactly one. The command accepts no
positional arguments and supports app scope only. `arcane-os import-map` is the
identical executable alias.

The generated artifact is
`apps/<id>/modules/arcane.importmap.json`. Its exact JSON is also installed in
the configured entry and every other admitted browser document as `<script
type="importmap" data-arcane-import-map>` before module loading. The complete
physical-v1 runtime derives its entries from the installed runtime and
browser-runtime inventories. It intentionally has no package-root mapping;
portable runtime subpaths such as `arcane-os/preference-store` and
`arcane-os/speech-playback` instead map directly to their canonical projected
modules. The result reports the complete map written to the selected
application; no fixed entry count is a release contract.

SDK `0.5.17` preserves the physical workspace route count and ordered include
list. External and modern integrated routes require `components`, `css`,
`dependencies`, `entities`, `img`, `modules`, and `sdk`; a physical workspace
may omit only an optional trailing `security` include. The external license
route remains separate and second.

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
        documentPaths,
        documentCount,
        imports,
        excludedModules:[],
        committed:true
    }
}
```

For the direct CLI command, `documentPaths` contains the configured entry first
and every other descriptor-selected HTML/HTM document afterward in
deterministic order. The generated artifact and selected documents are written
together. A post-commit observer failure preserves delivery with
`eventDelivery.status === 'degraded'` and `ARCANE_EVENT_DELIVERY_FAILED`; it
does not roll back complete application content.

`new` and `init` generate the map during scaffolding. `dev` refreshes all
selected documents once before binding. `package` consumes the saved source
and maps; use `import-map` to refresh them explicitly before selecting output
that needs updated maps. Packaging does not run tests or checks automatically.
Browser `build` and paired native packaging reuse the package flow.
Explicit `test` and `check` operations read the existing map without regenerating it;
`verify`, `bundle`, and browser `run` do not regenerate it. There is no
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

Deep details: [browser runtime delivery](protocols.md#browser-runtime-delivery).

## `arcane upgrade`

### Overview

Runs the selected external application's normal `npm upgrade` command in its
workspace root.

```text
arcane upgrade [--workspace <directory>] [--app <id>]
```

The SDK delegates dependency selection, registry access, lockfile updates, and
installed package changes directly to npm. It does not add a custom Arcane lock,
runtime-projection authentication, or import-map reconciliation workflow.
Integrated workspaces reject this command.

### Example

```bash
npm exec -- arcane upgrade --workspace . --app hello-world
```

## `arcane dev`

### Overview

Starts one development server for one selected app and maps the exact
workspace/runtime routes. It defaults to HTTPS on localhost; `--public` enables access
from other devices on the network, using HTTPS by default.

For an external workspace, the server exposes the selected projected
`arcane/` root, including `arcane/sdk` and `arcane/dependencies`, alongside the
application. Integrated workspaces retain their configured physical routes.
The explicit live-source SDK mapping remains unchanged and does not replace the
installed projection.

```text
arcane dev [--app <id>] [--public] [--http | --https] [--cert <file> --key <file>] [--host <address>] [--port 8000] [--http-port 0]
```

### Lifecycle

Startup refreshes the selected authored `arcane-app.json` projection into
`arcane-package.json`, then refreshes its managed import maps under one
development-refresh operation lock. The lock is released before the server
starts. Package-only apps retain their existing manifest. This operation does
not package the app or produce `dist` output. With PWA enabled, the server
generates the installation and offline manifests directly; see
[PWA development and versioning](pwa.md#development-and-hosting).

The command reports acceptance before bind/start work, emits the final URL,
owns the server until cancellation, and restores failure to the process exit.
The default host is `127.0.0.1`. `--public` selects `0.0.0.0` (all IPv4
interfaces); an explicit `--host` takes precedence. The command prints the
local URL and available network URLs. Use a printed network URL on the other
device, since `localhost` refers to that device and `0.0.0.0` is a bind address.
Network URLs come from one interface snapshot at startup and do not establish
remote reachability through the machine's firewall or network.

HTTPS is the default for development and required for packaged browser previews.
The published `node-http-server` 10.0.0 integration negotiates HTTP/2 or HTTP/1.1
on the same HTTPS port using the configured PEM pair. Source routes, generated
PWA resources, and conditional responses use the same serving pipeline.
`--https` remains accepted but is no longer needed to select the transport.
`--port` selects the HTTPS application port. A second HTTP listener returns
`308` redirects to that HTTPS port, preserving the requested path and query.
`--http-port` selects its port; the default `0` lets the operating system choose
an available port. Both listeners use the selected host and must be ready
before startup completes. Cancellation or a listener failure closes both.
Human output prints `HTTP redirect: <url>` alongside the HTTPS application URL;
JSON/NDJSON server results include `httpPort`, `httpOrigin`, and `httpUrl` for
the redirect endpoint.
Supplying both `--cert` and `--key` selects an explicit PEM pair. The command
does not configure a firewall, router forwarding, or an internet tunnel.

### Explicit HTTP development

`--http` selects source development over HTTP. Combine it with `--public` or
`--host` to use a LAN address, and choose the content listener with `--port`:

```bash
npm run dev -- --app hello-world --public --http --port 8000
```

The command starts one HTTP listener through `node-http-server`, skips all TLS
file reads, and serves the same selected source files, generated manifest,
service worker and offline inventory. PWA configuration and caching are
unchanged. Startup prints the actual HTTP local and network URLs. Structured
results contain `protocol:'http:'`; `httpPort`, `httpOrigin`, and `httpUrl`
identify that content listener and equal `port`, `origin`, and `url`.
There is no separate redirect endpoint. Cancellation and listener failure
close the owned HTTP listener and settle the same lifecycle.

`--http` is supported only by `dev`. Combining it with `--https`, `--cert`,
`--key`, or `--http-port` is a usage error. Omitting it preserves HTTPS;
certificate errors never select HTTP automatically.

A LAN HTTP origin does not receive the browser's localhost secure-context
exception. For Chrome development, Chromium documents
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the exact HTTP
origin, such as `http://192.0.2.10:8000`; see
[Chromium's development guidance](https://www.chromium.org/Home/chromium-security/deprecating-powerful-features-on-insecure-origins/).
The developer owns that browser setting. The SDK does not change it, alter
certificate validation, or claim a PWA is installable merely because its server
started. HTTP and HTTPS are distinct origins with separate browser storage and
registrations; existing HTTPS data is preserved.

### Development HTTPS setup

Before starting HTTPS `arcane dev` or a packaged browser preview, place the server's
PEM certificate chain at `.arcane/dev/server-cert.pem` and its PEM private key at
`.arcane/dev/server-key.pem`, relative to the workspace. Alternatively, pass
`--cert <file> --key <file>` together. The certificate must cover localhost or the LAN IP
address or hostname opened by each device. Certificate creation and renewal
belong to the developer's certificate tooling; the server does not generate a
CA or alter device trust stores. Keep `.arcane/dev/` ignored by Git and keep the
private key on the development computer.

The server reads the selected pair during startup, before binding.
Missing files or certificate/key parse errors produce a startup error;
Arcane never silently falls back to HTTP. Certificate/key contents are not
included in operation events or JSON/NDJSON output. Restart the server after
replacing its certificate pair; ordinary app source edits still appear on
refresh without restarting.

DBOPFS uses [OPFS, which requires a secure context](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory).
HTTP localhost is a special case on the device running the server; a LAN HTTP
address does not receive that exception. For HTTPS issued by a development CA,
each accessing device must trust that CA and use an address covered by the
server certificate.

On Android Chrome, transfer only the public CA certificate to the phone. In
Android Settings, open the security settings, then **Encryption & credentials
> Install a certificate > CA certificate**, and select that public certificate.
Samsung devices may label the entry **Install from device storage**. Menu names
vary by device; Google's [Android CA installation instructions](https://support.google.com/device-usage-study-help/answer/15713321?co=GENIE.Platform%3DAndroid&hl=en)
show these paths. Then open the printed HTTPS network URL in Chrome. The CA
installation is a device action; server readiness does not prove Android trust
or remote reachability.

### Example

```bash
npm exec -- arcane dev --app hello-world --port 8000

# Forward the public option through an existing dev script, for any app id.
npm run dev -- --app hello-world --public

# Equivalent direct CLI invocation, with an optional port.
npm exec -- arcane dev --app hello-world --public --port 8000

# Select a stable HTTP entry that redirects to HTTPS on port 8000.
npm exec -- arcane dev --app hello-world --port 8000 --http-port 8080
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

External and modern integrated app scope reads the existing managed import map
and selected HTML documents before starting isolated test files. The
Node loader honors only exact managed entries, including `arcane/*`,
`#arcane/*`, reached `arcane-os/*`, and URL-like dependency compatibility keys.
An unmapped reserved Arcane name is rejected before import. The compact map locator is
removed from the isolated child's environment before app test code imports.

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

Creates one complete browser release beneath `dist/<id>/`, preserving the prior
output until the replacement is complete. It consumes saved source and managed
import maps, places app files beneath `apps/<id>/`, and retains the configured
shared route destinations. When selected shared content supplies no root
`index.html`, the SDK generates one that opens the selected app entry.
Source document bases and resource URLs therefore retain their development
layout. Packaging does not run tests or checks automatically.

```text
arcane package [--app <id>] [--dry-run]
```

### Result

The result includes the release root, manifest, and complete selected inventory.
`ARCANE_APP_RELEASE.json` keeps the authored app-relative `app.entry` and records
the package launch URL in `app.start`, such as `./apps/hello-world/index.html`.
The file inventory includes that app tree and the root `index.html`.
`--dry-run` plans the package without refreshing source, running tests, or
replacing output.

### Example

```bash
npm exec -- arcane package --app hello-world
```

## `arcane verify`

### Overview

Explicitly validates one selected browser release against the app descriptor,
package policy, complete inventory, and malformed-artifact rules.

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

Bundles one already packaged external app into the documented
`.arcane-app.tar.gz` contract.

```text
arcane bundle [--app <id>] [--artifact <file>.arcane-app.tar.gz] [--overwrite]
```

### Replacement behavior

The default output is `dist/<id>-<version>.arcane-app.tar.gz`. An existing path
is refused unless `--overwrite` is explicit. Even then, the prior artifact is
retained until the replacement is complete. A conflicting or uncertain path is
preserved rather than overwritten.

### Example

```bash
npm exec -- arcane bundle --app hello-world
```

## `arcane verify-bundle`

### Overview

Parses one selected release bundle without extracting it.

```text
arcane verify-bundle <file.arcane-app.tar.gz>
```

### Validation

The verifier rejects genuinely malformed archives, unsafe or colliding paths,
unsupported archive members, trailing data, and inconsistent descriptor or
inventory structure.

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

Runs the provider's standalone toolchain preparation diagnostic for one target.
It is not a prerequisite command to repeat immediately before `build`; `build`
prepares its own selected toolchain state.

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

Packages one app, prepares one provider, creates one plan, and builds one target.

```text
arcane build --target <target> [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>] [--dry-run]
```

### Cardinality and outputs

The command selects one workspace, app, target, architecture, format, signing
profile, and output root. Current providers emit a portable directory,
Windows x64 EXE bundle, Linux x64/ARM64 DEB, or development-signed Android APK.
The output remains target-specific inside the common plan contract.
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

For `--target browser`, starts the existing current `dist/<app>` release; it
does not package, rebuild, test, check, or verify that release automatically.
It opens the release manifest's `app.start` URL. Older flat releases without
that field continue to open their `app.entry` path.
The preview always uses HTTPS with the workspace certificate pair. Supply
`--cert <file> --key <file>` together to use another pair; see
[development HTTPS setup](#development-https-setup).
`--port` selects the HTTPS application port, and `--http-port` selects the
paired HTTP `308` redirect port. The HTTP port defaults to an available port;
the CLI prints its actual redirect URL and reports both listener endpoints.
For a paired native target, it performs package, prepare, plan, build, launch,
readiness, and owned cancellation in one process.

```text
arcane run [--target <target>] [--app <id>] [--cert <file> --key <file>] [--port 8000] [--http-port 0] [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
```

### Availability

Browser run is **Node control plane / browser data plane** and requires an
existing packaged release (run `arcane package` first). Windows, Linux, and
Android providers expose supported paired native run paths. Portable output is
a directory and intentionally cannot run. Android run requires one
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

The command makes one ordinary HTTPS `GET` to the default
`registry.npmjs.org` origin for the `arcane-os` dist-tag document and accepts
JSON. The CLI does not expose registry or package overrides; callers of the
public function may select another HTTP or HTTPS npm registry URL.

An installed prerelease version selects the npm `dev` tag. A stable installed
version selects `latest`.

### Result

Success returns:

```javascript
{
    packageName:'arcane-os',
    currentVersion:'0.2.1',
    registryVersion:'0.2.2',
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
terminal `operation.completed` result. HTTP failure, timeout,
non-JSON/invalid UTF-8 content, malformed dist tags, or invalid semantic
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

## `arcane mail`

### Resend credential profiles

The mail commands read `.env.json` from the invocation directory on Windows,
Linux, and macOS. The credential subcommands select one profile in that file:

```text
arcane mail key set [profile] [--secret-stdin]
arcane mail key status [profile]
arcane mail key delete [profile]
```

`key set` reads the Resend API key from a hidden terminal prompt. The
`--secret-stdin` form is for deliberately redirected non-interactive input and
rejects a TTY before reading. The key is written to `.env.json` and is never
accepted in argv or returned in status output. The optional profile defaults
to `mail`, which selects top-level `RESEND_API_KEY`. Any other exact profile
selects `MAIL_PROFILES[profile].RESEND_API_KEY`, with no default-key fallback.

The minimal file is:

```json
{
  "RESEND_API_KEY": ""
}
```

Fill in the key before starting mail, and add `.env.json` to the project's
`.gitignore`; the SDK repository already ignores it. Set and delete preserve
the file's other settings and profiles. Status returns the selected profile,
`provider:'resend'`, `storage:'.env.json'`, and `exists`. Delete returns
`exists:false` for both a removed and an already-absent credential.

Programmatic `createToolchain().mail(...)` resolves the configuration directory
from `cwd ?? workspaceRoot ?? process.cwd()`. This uses ordinary Node file
access rather than platform-specific credential processes. An Android host
supplies a compatible Node runtime and an accessible configuration directory.
Existing Windows Credential Manager records remain untouched; the JSON reader
does not migrate or fall back to them. Mail reads JSON directly and does not
populate or depend on process environment variables for this key.

Missing files or missing/empty selected keys stop `send` and `serve` with the
configuration path and exact JSON setting to fill in. Invalid JSON and file
access failures remain observable without printing credential content.

Machine output for `key set` requires `--secret-stdin`. Raw CLI arguments are
not included in acceptance events, and usage errors do not echo unknown option
or positional values.

### One-shot provider send

`mail send` performs exactly one Resend provider attempt without starting a
server:

```text
arcane mail send [--profile <profile>] [--from <verified-sender>] --report-key <id> --report-stdin [--request-timeout <ms>]
```

`--report-stdin` is mandatory and rejects a terminal before attaching input
listeners. It reads one complete UTF-8 JSON object using the gateway report
shape:

```json
{
  "type": "report",
  "to": ["recipient@example.com"],
  "subject": "Example",
  "text": "Message content"
}
```

The CLI forwards the complete provider fields, including template requests.
Resend owns their accepted shape. The adapter removes the application-only
`type` field and applies `--from` when supplied; otherwise the report or provider
template supplies the sender. Direct CLI sending has
no configured fallback recipients. The Resend credential comes only from the
selected `.env.json` profile; omitting `--profile` selects `mail`. Neither the
key nor report content is accepted through argv or process environment variables.

The caller owns the nonempty `--report-key`, which is forwarded unchanged.
Reuse the same key only with the same
logical report when deliberately reconciling or retrying an
ambiguous attempt. The CLI never retries automatically.

Exit zero means Resend returned a successful response with a valid provider
acceptance id. The result preserves the complete report, provider request,
provider response, and available outcome detail without exposing the Resend API
key. It proves provider API acceptance, not inbox delivery. Permanent,
retryable, and ambiguous outcomes exit nonzero with that same complete
available request and outcome detail. Cancellation before the
provider attempt exits 130 without sending; cancellation, timeout, or transport
loss after the attempt begins is ambiguous because Resend may have accepted it.

### Mail gateway

`mail serve` starts one owned HTTPS gateway with HTTP/2:

```text
arcane mail serve [--profile <profile>] [--from <verified-sender>] [--app <label>] [--origin <exact-origin>] [--allow-to <addresses>] [--host 0.0.0.0] [--port 4433] [--request-timeout <ms>]
```

The selected `.env.json` profile supplies only the server-side Resend API key;
omitting `--profile` selects `mail`.

Add the listener's certificate configuration at the top level of the same file:

```json
{
  "RESEND_API_KEY": "",
  "MAIL_TLS_CERT_PATH": ".arcane/mail/fullchain.pem",
  "MAIL_TLS_KEY_PATH": ".arcane/mail/private-key.pem"
}
```

Supply an existing PEM certificate chain and its private key. Paths resolve
relative to `.env.json`, or may be absolute. They are shared across provider
profiles. Missing TLS settings name the fields to fill in before a listener
opens; the TLS owner reports PEM file errors. Keep private-key material outside
tracked source. The SDK repository already ignores `.arcane/` and `.env.json`.

The selected `node-http-server` module negotiates HTTP/2 with HTTP/1.1 fallback
on the same HTTPS port, default `4433`, with no plain-HTTP listener. Callers use
a hostname covered by the certificate, such as
`https://mail.example.com:4433/v1/mail`; `0.0.0.0` identifies the bind address.
Restart the gateway after replacing renewed certificate files. Certificate
issuance and renewal remain with the deployment's certificate owner.

The CLI does not read a browser app key. Its optional `--app` value labels the
server; the incoming request's `X-Mail-App` identifies the application for
subscription verification. The HTTP authentication contract pairs that
application with `Authorization: Bearer <subscription_key>`.

Subscription verification is disabled for this initial service setup. The
programmatic `createToolchain().mail({action: 'serve', ...})` path accepts
`verifySubscription({appName, subscriptionKey, signal})`; supplying that callback
enables verification before each provider attempt. It must resolve to `true`
to accept the request. An invalid subscription receives 401; verifier service
failure receives retryable 503; cancellation stops verification before sending.
The callback connects the actual TWiN Stripe endpoint when its contract is
ready. There is no guessed URL, response schema, or command-line endpoint flag.

The listener defaults to `0.0.0.0`; `--host` selects another bind host. Browser
mail defaults to `/v1/mail` on the current domain. `--origin` is optional and
selects an explicit CORS allowlist when supplied. `--allow-to` optionally
supplies a comma-separated recipient allowlist. CLI parsing preserves supplied
address spelling and repeated entries. Programmatic `errorTo` selects fallback
recipients for error reports; when omitted, the selected `allowTo` list supplies
that fallback. `--request-timeout`
adds a caller-selected provider-attempt timeout from 1 through 2147483647
milliseconds, the Node timer range. When it is omitted, the SDK adds no
provider timeout.

After binding, `server.ready` reports lifecycle fields such as
protocol, optional app label, bind address, port, URL, and `callerAuthentication`
(`none` or `subscription`). Human output states whether verification is disabled
or configured.
The command owns the server until its lifecycle ends or `SIGINT`/`SIGTERM`
cancels it. The server's Resend credential remains outside results and events;
per-request observer events preserve the complete delivery, report, provider
outcome, and failure detail available to the gateway.

See [Mail gateway and durable outbox](mail.md) for request, retry,
idempotency, DBOPFS, and provider-acceptance semantics.

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
