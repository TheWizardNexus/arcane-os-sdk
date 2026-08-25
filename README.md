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

This is development software. Version `0.1.0-dev.5` synchronizes the Arcane
`0.8.12` runtime, but it is not a production or release-candidate claim. It has
only the `dev` channel contract; query `npm view arcane-os@dev version` for
current registry availability. Registry state is deliberately not baked into
the immutable package documentation.

That registry query is a maintainer action, not an application behavior. Apps
never poll npm for SDK updates or replace their own SDK or synchronized runtime.
The app repository's exact dependency and lockfile select the SDK; changing that
selection is an explicit repository update followed by the normal validation
and release gates.

## Developer API reference

Start with the [capability-first developer reference](docs/reference/README.md).
It follows Arcane's MDN-style model and covers every public package export, CLI
command, synchronized runtime module, entity, component, Arcane Core member,
and Arcane Ollama method. Use the [availability and normalization matrix](docs/reference/availability-and-normalization.md)
to distinguish Node, browser, native, cloud, and cross-host behavior; protocol
mechanics are kept in the folded/deep-linked [protocol guide](docs/reference/protocols.md).
The [behavioral-testing guide](docs/reference/behavioral-testing.md) explains the
executable contract, while the [machine-readable inventories](docs/reference/inventory/)
make completeness independently checkable.

## Central event instrumentation

Use `arcane-os/event-manager` as the primary instrumentation surface for new
SDK code. Its shared `arcaneEvents` bus is powered by `event-pubsub`; SDK-owned
operation queues already mirror their normalized events through it while
preserving awaited delivery and cancellation. An opt-in `timeTravel` flag adds
timestamped causal event stacks, bounded snapshots, export/import, seek and safe
review playback. Attaching a DOM root records interactions and mutation records,
including supported open shadow roots. Source-stack capture is a separate,
off-by-default diagnostic option.

Recording is off by default. A session is complete until its configured event
limit; reaching that limit appends an overflow marker and disables recording
instead of silently evicting history. Review [the EventManager guide](docs/event-manager.md)
before enabling DOM values, node content, event details, source stacks, or live
event redispatch. Password targets, text-entry details, clipboard data, URL
attributes, and common credential keys are excluded or redacted by default.

## Runtime source ownership and transitional synchronization

The SDK repository is the canonical source for portable shared runtime modules,
entities, components, themes, browser providers and workers, public contracts,
and their packaged byte receipts. Arcane OS and every other application consume
those SDK-owned paths; a portable application never reads an Arcane OS install
or source checkout at runtime.

The current OS-to-SDK synchronization command remains a transitional provenance
path for compatibility bytes that have not completed the SDK-owned projection
cutover. It validates the selected Arcane checkout, its exact machine-bundle
version, the dependency lock, and the fixed shared-payload selection before
replacing those transitional bytes:

```bash
npm run runtime:sync -- --arcane-root /path/to/canonical/ARCANE-OS
node tools/runtime-manifest.mjs --write
npm run check
```

`tools/runtime-source.json` records the reviewed provenance of that existing
snapshot; it is not durable source ownership for reusable portable code. Do not
use the transitional sync to overwrite SDK-canonical shared AI startup/runtime
contracts or shared chat/speech components. The separately leased source
cutover replaces this direction with an authenticated SDK-owned source and
projection model, after which Arcane OS consumes the same locked SDK bytes as
other applications. The generated runtime manifest remains the published byte
receipt throughout the migration.

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

No global SDK install or standalone Arcane CLI is required. The application
repository's exact npm dependency and lockfile own the CLI and toolchain version.

Use `npx arcane-os@dev` for the initial bootstrap because it names this npm
package explicitly; bare `npx arcane` outside an installed project could resolve
a different package. Both installed commands invoke the same headless toolchain.
Project-local npm scripts use the SDK pinned by that app's `package-lock.json`,
so normal repository work does not depend on whichever global command was
installed last.

### Local development when the npm package is unavailable

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
npm install --save-dev --save-exact ../arcane-os-sdk/arcane-os-0.1.0-dev.5.tgz
npm run check
npm ci
```

Adjust the relative tarball path for your layout and keep that `.tgz` at the
same location. npm records its integrity in `package-lock.json`, while Arcane
still verifies the installed package name and exact version, the locked runtime
identity, and the runtime bytes. Local directory `file:` dependencies are not
accepted because npm may install them as links; use a packed `.tgz`. A GitHub
runner also needs that tarball at the locked path. When the registry exposes
`arcane-os@dev`, replace the local declaration with the exact registry package
and commit the regenerated lock.

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

Shared runtime and Core work has an explicit integrated-only scope. Select one
exact focused test, or run Arcane's canonical development check through the
fixed Arcane-owned provider:

```bash
node ../arcane-os-sdk/bin/arcane.mjs test --workspace "../Arcane OS" --scope shared --test-file test/component-contracts.test.mjs
node ../arcane-os-sdk/bin/arcane.mjs check --workspace "../Arcane OS" --scope shared
```

The default scope is `app`. Shared scope never discovers, packages, verifies,
builds, or runs an application, and it is rejected in an external workspace.
The provider admits only one repository-relative `.test.mjs` through Arcane's
focused runner or the one canonical development check; it cannot select an
arbitrary command or package script.

In an integrated Arcane checkout, app scope runs tests only under the selected
`apps/<id>/test/` tree and reports an honest skip when that tree has no tests.
Arcane root, shared, and native tests require the explicit shared focused-test
form above. External app repositories retain their root `test/` plus selected
app-test behavior.

Integrated native app builds are also implemented. `--workspace` and
`--arcane-root` must resolve to the same Arcane checkout, one `--app` and one
declared native target are selected, and `--output-root` must resolve outside
that checkout. The SDK then uses the same package, plan, provider, retained
verification, and same-process run lifecycle as an external app repository.

## Commands

```text
arcane new <id> [--path <directory>] [--display-name <name>] [--target <target>] [--git]
arcane init [id] [--workspace <directory>] [--display-name <name>] [--target <target>]
arcane doctor [--workspace <directory>] [--arcane-root <directory>]
arcane dev [--app <id>] [--host 127.0.0.1] [--port 8000]
arcane test [--app <id>] [--scope app]
arcane test --scope shared --test-file <repo-relative.test.mjs>
arcane check [--app <id>] [--scope app] [--skip-tests]
arcane check --scope shared
arcane package [--app <id>] [--dry-run]
arcane verify [--app <id>]
arcane bundle [--app <id>] [--artifact <file>.arcane-app.tar.gz] [--overwrite]
arcane verify-bundle <file.arcane-app.tar.gz>
arcane native-doctor --target <native-target> --arcane-root <directory>
arcane native-prepare --target <native-target> --arcane-root <directory>
arcane build --target <target> [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
arcane run [--target <target>] [--app <id>] [--arcane-root <directory>] [--output-root <directory>] [--format <format>] [--signing <mode>]
arcane targets
arcane repo status|pull|push
```

All commands support `--output human|json|ndjson`. Machine modes keep stdout
structured. Every operation emits or reports acceptance before filesystem,
network, hashing, test, process, or service work begins.

## External application release bundles

An authored schema-2 `arcane-app.json` can be sealed with one already packaged
and verified browser release. The bundle contains only the canonical descriptor,
the release manifest, and the exact `dist/<id>/` payload inventory:

```bash
npm exec -- arcane package --app my-app
npm exec -- arcane bundle --app my-app
npm exec -- arcane verify-bundle dist/my-app-1.0.0.arcane-app.tar.gz
```

`bundle` creates `dist/<id>-<version>.arcane-app.tar.gz` by default. It refuses
an existing destination unless `--overwrite` is explicit, preserves the prior
file until the promoted replacement has passed no-follow, single-link,
byte-length, and SHA-256 revalidation, and restores the prior file on
cancellation or pre-commit failure only while both the promoted pathname and
prior backup retain their respective full recorded identity tuples, each
pinned by an open handle. If the promoted path is replaced or changed in
place, it and the prior backup are preserved; if the backup is changed or
missing, the valid promoted output is preserved instead of being deleted.
Operation locks carry a random nonce
and filesystem identity; a replaced lock is preserved and reported as degraded
cleanup instead of being removed by pathname.

The archive uses one byte-exact USTAR+gzip encoding and publishes its v1 JSON
contract at `arcane-os/schemas/arcane-app-bundle.json`. Verification rejects
links, devices, extension headers, unsafe or colliding paths, alternate gzip
members, noncanonical metadata, trailing data, expansion bombs, and every
descriptor, policy, inventory, size, or hash mismatch. The envelope adds no
repository-only source or tooling beyond the exact authenticated release
inventory; each app owns its leak/source policy, and Arcane's source-free runtime
gates remain separate. Source controls, payloads, and bundle artifacts must remain single-link regular files at their exact
recorded length through a final identity check; an appended byte, concurrent
growth, path replacement, or hard link fails closed. NFC paths use defined
UTF-8 byte ordering, covered by one pinned golden bundle digest on every
supported Node/runner combination. This SDK accepts only the explicitly listed
`0.1.0-dev.5` bundle generation; structural validity does not imply cross-SDK
compatibility, and a release with zero payload bytes cannot be created. Portable
path validation rejects file/directory prefix conflicts, case-colliding prefix
spellings, and Windows device aliases including superscript COM/LPT digits.

Successful creation and verification return complete consistency metadata for
the artifact digest/bytes, descriptor canonical/file/package digests and byte
length, and release manifest/policy/content digests, file count, and payload
bytes. Those values are consistency evidence for the exact archive, not
installation authority.

Internal hashes establish consistency, not permission to install. Arcane
admission must also authenticate the archive through its approved repository
provenance or independent signature and match that identity to an Arcane-owned
authorization lock. The reusable `.github/workflows/release-app.yml` workflow
builds one selected app in a `contents: read` job with no OIDC or attestation
authority. An always-run fresh job downloads the uploaded artifact by immutable
artifact id, checks out only the reusable workflow's exact SDK revision, uses
supported Node 24, directly imports the trusted verifier, rechecks the selected
app id and complete metadata, and becomes the sole source of reusable outputs.
When requested, a third job downloads that same artifact id, independently
repeats those checks against the post-upload outputs, and alone receives narrow
OIDC/attestation permissions. No package manager, dependency resolution, caller
checkout, check, or adapter runs with that authority. An unattested uploaded
artifact is still not an authorized Arcane app by itself.

## SDK test sets

The repository suite uses exact `vanilla-test` 2.1.3 through the isolated Arcane
test runner. `npm test` runs four non-overlapping sets in order, and every test
file belongs to exactly one set:

```text
npm run test:unit
npm run test:functional
npm run test:integration
npm run test:regression
```

Use a named set while iterating or `npm test` for the complete suite. Large
fixtures stay inside one isolated file process and expose smaller nested cases,
so the report shows the individual behaviors without repeating setup, builds,
package installation, or assertions.

## Current target support

Version `0.1.0-dev.5` exposes one browser target and five explicitly paired
native development targets: a verified non-runnable portable directory, a
Windows x64 unsigned-local-test EXE bundle, Linux x64 and Linux ARM64
unsigned-local-test DEBs, and an Android development-signed APK. The
`android-arm64` APK is architecture-neutral because it contains no native ABI;
the target name identifies its supported physical/native ARM64 run profile.

Every native build requires an explicit Arcane OS checkout that passes this SDK
version's admission checks and a canonical app descriptor that declares the
exact selected target. The SDK never searches for or silently selects a mutable
toolchain root. Scaffold a separate
repository with the matching `--target`, or add and validate that target in the
canonical descriptor before invoking its native command. From an external
application repository, run one selected target:

```bash
npm exec -- arcane native-doctor --target portable --arcane-root "../Arcane OS"
npm exec -- arcane build --target portable --arcane-root "../Arcane OS"

# Windows x64: build or build, verify, and launch in one process
npm exec -- arcane build --target windows-x64 --arcane-root "../Arcane OS"
npm exec -- arcane run --target windows-x64 --arcane-root "../Arcane OS"

# Linux x64, from Linux or WSL with the documented GTK/WebKit toolchain
npm exec -- arcane build --target linux-x64 --arcane-root "../Arcane OS"
npm exec -- arcane run --target linux-x64 --arcane-root "../Arcane OS"

# Linux ARM64, on a compatible native ARM64 toolchain
npm exec -- arcane native-doctor --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test
npm exec -- arcane build --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test
npm exec -- arcane run --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test

# Android ARM64; run requires one connected physical/native ARM64 device
npm exec -- arcane native-doctor --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
npm exec -- arcane build --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
npm exec -- arcane run --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
```

Use `--target portable`, `windows-x64`, `linux-x64`, `linux-arm64`, or
`android-arm64` when scaffolding to include the required raster icon and declare
both `browser` and the selected native target in the canonical app descriptor.
The browser remains available from the same repository. A native command does
not infer a missing descriptor target from `--target` and never substitutes a
browser package.

`native-prepare` is available as a standalone toolchain-integrity diagnostic.
Do not run it immediately before `build`: receipts are process-owned, and the
build command prepares and reuses its own exact toolchain state once.

The build authenticates the selected app release and descriptor, requires the
Core to meet the highest minimum declared by the SDK runtime, selected app, and
bundled dependencies, keep their declared Arcane protocol, and provide every
required feature, capability, and method. A Core reporting a higher version is
accepted only when it passes those same current-SDK checks; this is not a promise
that future SDK or Core releases will remain compatible. The build copies
release bytes through verified readers. Portable emits an app-scoped
Arcane Core payload under `build/portable/`; that directory is not executable
and `arcane run --target portable` is intentionally unavailable. Windows emits
an app-scoped executable bundle under `build/windows-x64/`. Linux emits an
app-scoped amd64 DEB under `build/linux-x64/` or ARM64 DEB under
`build/linux-arm64/`. Android emits one development-signed, architecture-neutral
APK under `build/android-arm64/`; there is no native ABI payload, and its run
path requires a physical device with native ARM64 support. Executable `run`
performs package, prepare, plan, build, verify, launch, and owned cancellation
in one process because native receipts are process-owned.

The Windows x64 and Linux x64 paths have been exercised end to end from
independent external repositories. Windows compiled, verified, reached an
authenticated readiness channel, and cancelled an isolated development app
while a valid installed publisher-continuity pin remained present. Linux x64
built and verified a real DEB and launched it under WSLg without installation
or `sudo`.

At Arcane source revision `4382043c09285ea203aa6daba1732660966ac409`, the
official native ARM64 workflow built and retained-verified a 21,232,932-byte
ARM64 DEB, proved AArch64 host, Core, and bridge binaries, reached WebKit
load-finished readiness, and drained its owned process group. The workflow kept
Ubuntu's AppArmor user-namespace restriction enabled and loaded the packaged
Bubblewrap profile. At revision `be6732ab71cbecb43d037aaad994ade5f2f4d1b6`,
the hardened Android path passed build, retained verification, exact
process/generation/nonce readiness, cancellation, uninstall, and absence checks
on a physical ARM64/API 37 device. These are development results, not production
signing, store-publishing, release, or promotion evidence.

| Capability | Ready now |
|---|---|
| Scaffold, develop, test, check, package, verify, and browser run | Yes |
| External proprietary-source repository workflow | Yes, subject to the distribution license below |
| Integrated Arcane checkout workflow | Yes |
| ArcaneOllama managed-service check | Yes on supported Windows hosts |
| SDK native plan/provider/receipt boundary | Yes |
| Portable app-scoped Core directory | Yes, with explicit `--arcane-root`; verified but not directly runnable |
| Windows x64 EXE bundle | Yes, unsigned local development with explicit `--arcane-root` |
| Linux x64 DEB | Yes, unsigned local development with explicit `--arcane-root` |
| Linux ARM64 DEB | Yes, unsigned local development on a compatible native ARM64 toolchain with explicit `--arcane-root`; exact-SHA native build, verification, WebKit readiness, and cancellation evidence is recorded |
| Android ARM64 APK | Yes, development-signed and architecture-neutral with explicit `--arcane-root`; a physical/native ARM64 device is required for run |

Android supports APK only in this development profile. AAB, release signing,
publishing, and update continuity remain deferred. Unpaired, incompatible, or
descriptor-mismatched native requests fail without producing a substitute
artifact. Portable output is never represented as an executable, and unsigned
or development-signed evidence is never represented as production signing or
release acceptance.

See [docs/platform-targets.md](docs/platform-targets.md) for the matrix and
[docs/architecture.md](docs/architecture.md) for the boundary. The exact
minimum-version and required-contract admission rule is documented in
[docs/compatibility.md](docs/compatibility.md). The issue-ready
extraction sequence is tracked in [docs/roadmap.md](docs/roadmap.md).

## Canonical app descriptor

New apps own `apps/<id>/arcane-app.json` schema 2. It contains publisher,
permissions, security, native presentation, Core requirements, and target
intent, and deterministically projects the exact schema-1
`arcane-package.json` required by the current browser packager. The pinned
schema-1 apps recognized by this SDK are accepted through a read-only projection
of the current native registry until each app adopts the authored descriptor.
The schema-1 release manifest is intentionally unchanged during this migration;
that current projection is not a general future-compatibility guarantee.

## ArcaneOllama

Browser development never calls Ollama directly. `arcane doctor` performs a
read-only managed-service assessment where the host supports one. Native apps
use an app-scoped Arcane Core and `Arcane.localAI.status()` in this SDK version.
Ollama is optional for packaging and non-AI applications.

The loopback development server uses an unguessable session capability and a
broad development-only content policy so the shared runtime can exercise remote
providers, media, WebSockets, and embeds. It is not a production security
boundary. Declared origins remain native policy input through the approved
Arcane descriptor; enforcement for any additional target is roadmap scope, not
a compatibility promise. Served files are verified into bounded response
snapshots before headers; the current development limit is 64 MiB per file.

## Licensing

The synchronized Arcane runtime and packager are currently distributed under
AGPL-3.0-only. The commercial-license notice does not itself grant proprietary
distribution rights. Resolve the applicable Arcane commercial or open-source
license before distributing a closed-source app that bundles this runtime. Each
browser release carries `LICENSE`, `COMMERCIAL-LICENSE.md`, and `NOTICE` under
`licenses/arcane-os/`; the notice includes the complete bundled Marked and
QRCode.js MIT terms.
