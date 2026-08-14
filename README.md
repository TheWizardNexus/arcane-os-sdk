[![Arcane OS SDK — external application SDK and command-line toolchain](https://raw.githubusercontent.com/TheWizardNexus/arcane-os-sdk/main/site/assets/arcane-os-sdk-readme-header.png)](https://thewizardnexus.github.io/arcane-os-sdk/)

# Arcane OS SDK

<p align="center">
  <strong>Build, test, package, and manage Arcane applications inside or outside Arcane OS.</strong><br>
  Keep proprietary source in its own repository while using the same headless workflow for apps and shared runtime work in the Arcane checkout.
</p>

<p align="center">
  <a href="https://thewizardnexus.github.io/arcane-os-sdk/"><strong>Visit the Arcane OS SDK site</strong></a>
  &nbsp;·&nbsp;
  <a href="https://github.com/TheWizardNexus/arcane-os-sdk"><strong>Open the GitHub repository</strong></a>
</p>

`arcane-os` is the application SDK and command-line toolchain for Arcane OS. It
supports two explicit workspace profiles: an external app repository uses the
version-locked SDK runtime, while an integrated Arcane checkout uses its live
`arcane/` runtime. Both profiles preserve the same app URLs, theme, packaging,
event, cancellation, and browser run contracts.

This is development software. Version `0.1.0-dev.1` synchronizes the Arcane
`0.8.11` runtime, but it is not a production or release-candidate claim. It has
not yet been published to npm.

## Install

After the development package is published under the npm `dev` tag, create a
new repository-shaped Arcane application:

```bash
npx arcane-os@dev new my-app --path ./my-app --target portable --git
cd my-app
npm install
npm run check
npm run dev
```

To enroll an existing repository, install the exact SDK and initialize only
missing Arcane files:

```bash
npm install --save-dev --save-exact arcane-os@dev
npm exec -- arcane init my-app --target portable
```

The npm package is named `arcane-os`. Its primary executable is `arcane`, and
`arcane-os` is an equivalent fallback when another globally installed package
has claimed the short command:

```bash
npm exec -- arcane targets
npm exec -- arcane-os targets
```

Use `npx arcane-os@dev` for the initial bootstrap because it names this npm
package explicitly; bare `npx arcane` outside an installed project could resolve
a different package. Both installed commands invoke the same headless toolchain.
Project-local npm scripts use the SDK pinned by that app's `package-lock.json`,
so normal repository work does not depend on whichever global command was
installed last.

### Local development before npm publication

Pack the current SDK checkout, scaffold with its source CLI, and persist the
tarball install in the app's package manifest and lock:

```bash
# From the arcane-os-sdk checkout
npm ci
npm run check
npm run pack:local
node ./bin/arcane.mjs new local-app --path ../local-app --target portable --git

# From the generated app repository
cd ../local-app
npm install --save-dev --save-exact ../arcane-os-sdk/arcane-os-0.1.0-dev.1.tgz
npm run check
npm ci
```

Adjust the relative tarball path for your layout and keep that `.tgz` at the
same location. npm records its integrity in `package-lock.json`, while Arcane
still verifies the installed package name and exact version, the locked runtime
identity, and the runtime bytes. Local directory `file:` dependencies are not
accepted because npm may install them as links; use a packed `.tgz`. A GitHub
runner also needs that tarball at the locked path. Once `arcane-os@dev` is
published, replace the local declaration with the exact registry package and
commit the regenerated lock.

Generated repositories use `npm ci --ignore-scripts` in CI. Run dependency
installation once and commit `package-lock.json` before enabling that workflow.

### Integrated Arcane OS development

Run the same SDK against the Arcane OS checkout when changing a shared runtime
capability or a built-in app. During local SDK development, invoke its source
CLI explicitly so Arcane OS does not acquire an npm self-dependency:

```bash
node ../arcane-os-sdk/bin/arcane.mjs check --workspace "../Arcane OS" --app calculator
node ../arcane-os-sdk/bin/arcane.mjs dev --workspace "../Arcane OS" --app calculator
node ../arcane-os-sdk/bin/arcane.mjs package --workspace "../Arcane OS" --app calculator
```

`arcane init new-app --workspace <arcane-root> --target portable` detects the integrated profile
and writes only `apps/new-app/` boilerplate. It does not modify Arcane OS root
scripts, dependencies, workflows, lock files, or repository instructions.

## Commands

```text
arcane new <id> [--path <directory>] [--display-name <name>] [--target browser|portable] [--git]
arcane init [id] [--workspace <directory>] [--display-name <name>] [--target browser|portable]
arcane doctor [--workspace <directory>] [--arcane-root <directory>]
arcane dev [--app <id>] [--host 127.0.0.1] [--port 8000]
arcane test [--app <id>]
arcane check [--app <id>] [--skip-tests]
arcane package [--app <id>] [--dry-run]
arcane verify [--app <id>]
arcane native-doctor --target portable --arcane-root <directory>
arcane native-prepare --target portable --arcane-root <directory>
arcane build --target <target> [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
arcane run [--target browser] [--app <id>]
arcane targets
arcane repo status|pull|push
```

All commands support `--output human|json|ndjson`. Machine modes keep stdout
structured. Every operation emits or reports acceptance before filesystem,
network, hashing, test, process, or service work begins.

## Current target support

The verified browser application release and portable directory build are
available now. Portable builds explicitly pair the SDK with a compatible
Arcane OS checkout; the SDK never searches for or silently selects a
mutable toolchain root. From an external application repository, run:

```bash
npm exec -- arcane native-doctor --target portable --arcane-root "../Arcane OS"
npm exec -- arcane build --target portable --arcane-root "../Arcane OS"
```

Use `--target portable` when scaffolding to include the required raster icon and
declare both `browser` and `portable` in the canonical app descriptor. The
browser remains available from the same repository.

`native-prepare` is available as a standalone toolchain-integrity diagnostic.
Do not run it immediately before `build`: receipts are process-owned, and the
build command prepares and reuses its own exact toolchain state once.

The build authenticates the selected app release and descriptor, requires the
Core to meet the highest minimum declared by the SDK runtime, selected app, and
bundled dependencies, keep their declared Arcane protocol, and provide every
required feature, capability, and method. A newer compatible Core is accepted.
It copies release bytes through verified readers and emits an app-scoped Arcane Core payload under
`build/portable/` by default. That payload is a verified directory for platform
builder integration. It is not an executable and `arcane run --target portable`
is intentionally unavailable.

This path has been exercised end to end from an external repository installed
from the packed `arcane-os-0.1.0-dev.1.tgz`. Windows, Linux, and Android
executables remain deferred. The Arcane repository now has a per-build secure
Windows transaction foundation, but it is not yet paired with a fully retained
Windows toolchain receipt and therefore does not enable the Windows target.

| Capability | Ready now |
|---|---|
| Scaffold, develop, test, check, package, verify, and browser run | Yes |
| External proprietary-source repository workflow | Yes, subject to the distribution license below |
| Integrated Arcane checkout workflow | Yes |
| ArcaneOllama managed-service check | Yes on supported Windows hosts |
| SDK native plan/provider/receipt boundary | Yes |
| Portable app-scoped Core directory | Yes, with explicit `--arcane-root`; verified but not directly runnable |
| Windows EXE, Linux package, or Android APK/AAB | No; executable platform providers remain deferred |

Deferred executable targets fail with a stable error; the available portable
directory is never represented as a Windows, Linux, or Android executable.

See [docs/platform-targets.md](docs/platform-targets.md) for the matrix and
[docs/architecture.md](docs/architecture.md) for the boundary. The issue-ready
extraction sequence is tracked in [docs/roadmap.md](docs/roadmap.md).

## Canonical app descriptor

New apps own `apps/<id>/arcane-app.json` schema 2. It contains publisher,
permissions, security, native presentation, Core requirements, and target
intent, and deterministically projects the exact schema-1
`arcane-package.json` required by the current browser packager. Existing Arcane
apps remain compatible through a read-only projection of the current native
registry until each app adopts the authored descriptor. The schema-1 release
manifest is intentionally unchanged during this migration.

## ArcaneOllama

Browser development never calls Ollama directly. `arcane doctor` performs a
read-only managed-service assessment where the host supports one. Native apps
will continue to use an app-scoped Arcane Core and `Arcane.localAI.status()`.
Ollama is optional for packaging and non-AI applications.

The loopback development server uses an unguessable session capability and a
broad development-only content policy so the shared runtime can exercise remote
providers, media, WebSockets, and embeds. It is not a production security
boundary. Future native targets will enforce each app's declared origins through
its approved Arcane descriptor. Served files are verified into bounded response
snapshots before headers; the current development limit is 64 MiB per file.

## Licensing

The synchronized Arcane runtime and packager are currently distributed under
AGPL-3.0-only. The commercial-license notice does not itself grant proprietary
distribution rights. Resolve the applicable Arcane commercial or open-source
license before distributing a closed-source app that bundles this runtime. Each
browser release carries `LICENSE`, `COMMERCIAL-LICENSE.md`, and `NOTICE` under
`licenses/arcane-os/`; the notice includes the complete bundled Marked and
QRCode.js MIT terms.
