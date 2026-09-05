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

This checkout defines the `0.5.9` SDK contract. Applications pin one exact npm
version and lockfile; registry state is deliberately not baked into application
artifacts.

That registry query is a maintainer action, not an application behavior. Apps
never poll npm for SDK updates or replace their own SDK or synchronized runtime.
The app repository's exact dependency and lockfile select the SDK; changing that
selection is an explicit repository update. Tests and checks run only when the
user expressly selects them, or when required for a selected release output.

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
complete timestamped causal event stacks, export/import, seek and safe review
playback. Attaching a DOM root records interactions and mutation records,
including supported open shadow roots. Source-stack capture is a separate,
off-by-default diagnostic option.

Recording is off by default. Once explicitly enabled, a session retains its
complete recorded content until the caller clears it or disables recording.
Review [the EventManager guide](docs/event-manager.md)
before enabling DOM values, node content, event details, source stacks, or live
event redispatch. Password targets, text-entry details, clipboard data, URL
attributes, and common credential keys are excluded or redacted by default.

## Runtime source ownership

The SDK repository is the canonical source for portable shared runtime modules,
entities, components, themes, browser providers and workers, public contracts,
and their packaged content. Portable applications consume those
SDK-owned paths and never read an Arcane OS install or source checkout at
runtime. Arcane OS is a consumer of this contract; its repository-side cutover
is coordinated separately and cannot become a second source authority.

The source-authority cutover is complete. `runtime/arcane/` is authored here,
and applications copy the complete portable inventory selected by the package.
Arcane OS must consume the same locked SDK projection as other applications;
an OS-side duplicate is consumer projection state, not source authority. Git
history records the completed source-authority migration; the current tree has
no OS-to-SDK synchronization command or migration-only runtime-source record.

## TWiN Cloud

TWiN Cloud is the SDK's default remote language-model service. It sends
OpenAI-compatible chat-completion requests to
`https://inference.do-ai.run/v1/chat/completions` with model
`openai-gpt-oss-120b`. Supply the bearer credential through `ai.twinKey` or
`globalThis.arcane.config.twinCloud.accessKey`. The established `ai.license`
property and internal `OPENAI` route identifier are current runtime names;
applications should present the service and credential as **TWiN Cloud** and
**TWiN access key**. The TWiN key is used only for remote LLM chat. Audio stays
on device: Whisper (`LOCAL_SPEACH` / `whisper-small`) owns transcription and
Kokoro (`LOCAL_SPEACH` / `kokoro`) owns speech synthesis. Neither audio route
uses the TWiN key, and no OpenAI audio key is required.

`fetchRequest()` and `streamRequest()` accept the provider-neutral
`reasoningEffort` option with `none`, `low`, `medium`, `high`, or `max`. TWiN
Cloud maps it to DigitalOcean Serverless Inference `reasoning_effort`; omitting
it preserves the provider default. TWiN Cloud defaults to
`openai-gpt-oss-120b`, and applications may explicitly select
`openai-gpt-oss-20b` without changing streaming or structural-tool behavior.

## Browser-local AI

`arcane-os/ai/browser-wasm` provides the shared Wllama LLM provider. The app
supplies its model catalog; the SDK does not hard-code Granite or any other app
profile. Each descriptor uses one ordered `files` array, so monolithic and
split GGUF models share the same contract:

```js
const source=createBrowserModelSource({
    id:'app-model',
    files:[
        {name:'model-00001-of-00002.gguf',url:'https://models.example/one.gguf'},
        {name:'model-00002-of-00002.gguf',url:'https://models.example/two.gguf'}
    ]
});
```

Model members require only their names and URLs. A member may also declare a
positive safe-integer `bytes` value so the application can present determinate
progress and the transport can plan parallel HTTP ranges. An unusable value is
treated as unavailable and never blocks the ordinary download. That value is observational
transfer metadata: it never validates, admits, identifies, or decides cache
reuse for model content. During a cache miss, the store reports live aggregate
`loadedBytes`, `totalBytes`, `remainingBytes`, `bytesPerSecond`, `etaSeconds`,
`activeTransfers`, `transferLimit`, and `transferMode` alongside the existing
completed-file counts. Chunk-driven updates are coalesced on a 250 ms cadence;
transfer-plan, active-worker, and completion boundaries publish immediately.
Optional hardening is inactive unless the caller explicitly selects
`secure:true`. The DBOPFS store downloads ordered members with one bounded
parallel transfer pool and returns them in descriptor order. Completed shards
survive an interrupted attempt and only missing shard or Range-part work is
fetched on retry. A monolithic file uses up to `downloadConcurrency` active
workers (four by default) over deterministic, resumable HTTP range parts of
roughly 4 MB each, up to 4,096 parts, when the server confirms `206` responses
and the total comes from `Content-Range` or, when that header is not exposed,
optional declared `bytes`.
When a followed redirect turns the first Range probe into `200`, the SDK probes
the final URL directly before reusing that original response as the single-fetch
fallback. Completed range parts survive restart and are presented to Wllama as
one logical model. Split members use the same Range negotiation with one active
Range worker per member, so completed parts within a shard can also resume
without multiplying the configured transfer bound. A probe without an
observable or declared total falls back to one full fetch. Once a complete
whole file or Range set is available, the store removes superseded fragments
when DBOPFS deletion succeeds; cleanup failure is warned without hiding the
usable model.
Capability reports evaluate each
app-supplied model as `compatible`, `incompatible`, or `unknown`; the app can
render that result without the SDK inventing or filtering its catalog.

`arcane-os/ai/browser-speech` exposes independent Whisper STT and Kokoro TTS
provider factories. The package contains the plain-JavaScript provider and
Worker machinery, not speech runtimes, models, voices, or a CDN default. An app
must supply each runtime/model selection explicitly. Speech roles
load, cancel, unload, fail, and recover independently, so speech failure never
silently falls back or prevents text chat. Kokoro defaults to a two-slot Worker
and model-session pool: it selects WebGPU when the browser can load the complete
pool and otherwise recreates that pool on WASM. Apps may select `webgpu` or
`wasm` explicitly and may set the bounded TTS capacity from one through four.

Applications that need faster spoken-response onset can configure the shared
TTS stream without taking over synthesis or playback:

```js
ai.configureTTSSegmentation({
    punctuation:'any',
    wordCadence:4
});
```

The compatibility default remains sentence punctuation with no word cadence.
The configured stream preserves every character and punctuation mark, chooses
the earliest complete boundary, begins synthesis as each segment becomes
available, and plays the completed audio in exact segment order. Ready adjacent
buffers are scheduled consecutively on the browser audio clock rather than
waiting for an `ended` callback before the next start.
Any-punctuation mode recognizes boundaries without requiring whitespace while
keeping apostrophes, commas, and hyphens that join Unicode letters or numbers
inside the same segment.
Mute, stop, provider transition, and cancellation still govern the whole queue.

The SDK runtime also owns `DBOPFSDocumentLibrary`,
`DocumentLexicalSearch`, and `PersistentAIChatSession`. Document bootstrap is
schema-driven and explicit; chat never searches a corpus unless the app wires
that library into the request context builder. Persistent chat automatically
maintains recurring model context and `ChatEntity` history/memory. A turn may
set `persist:false` to participate in one request and response only; after that
operation settles, neither side remains in subsequent model context, the
retained transcript, durable chat, memory, or DBOPFS.
For an automatic model-authored opening, call
`session.open({message:{content:bootstrap,persist:false}})`: the bootstrap is
request-only, while the complete nonblank assistant response becomes the first
durable conversation row without a fabricated user turn.
`createArcaneAI(...).createChatSession(options)` wires
that session to the same selected LLM controller, creates its `ChatEntity`, and
uses the same controller for automatic memory extraction.

## Install

Create a new repository-shaped Arcane application with the exact stable SDK:

```bash
npx arcane-os@0.5.9 new my-app --path ./my-app --target portable --git
cd my-app
npm install
npm run check
npm run dev
```

To enroll an existing repository, install the exact SDK and initialize only
missing Arcane files:

```bash
npm install --save-dev --save-exact arcane-os@0.5.9
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

Use `npx arcane-os@0.5.9` for the initial bootstrap because it names this npm
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
npm install --save-dev --save-exact ../arcane-os-sdk/arcane-os-0.5.9.tgz
npm run check
npm ci
```

Adjust the relative tarball path for your layout and keep that `.tgz` at the
same location. The lockfile retains the selected package dependency while
Arcane uses the installed package name and version. Local directory `file:` dependencies are not
accepted because npm may install them as links; use a packed `.tgz`. A GitHub
runner also needs that tarball at the locked path. After publication, replace
the local declaration with the exact `arcane-os@0.5.9` registry package and
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
that checkout. The SDK then uses the same package, plan, provider, and
same-process run lifecycle as an external app repository. Verification remains
an explicit operation for a selected release output.

## Commands

```text
arcane new <id> [--path <directory>] [--display-name <name>] [--target <target>] [--git]
arcane init [id] [--workspace <directory>] [--display-name <name>] [--target <target>]
arcane doctor [--workspace <directory>] [--arcane-root <directory>]
arcane import-map [--workspace <directory>] [--app <id>]
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
network, explicitly requested test, process, or service work begins.

## External application release bundles

An authored schema-2 `arcane-app.json` can be bundled with one already packaged
browser release. The bundle contains only the canonical descriptor, the release
manifest, and the complete selected `dist/<id>/` payload inventory:

```bash
npm exec -- arcane package --app my-app
npm exec -- arcane bundle --app my-app
npm exec -- arcane verify-bundle dist/my-app-1.0.0.arcane-app.tar.gz
```

`bundle` creates `dist/<id>-<version>.arcane-app.tar.gz` by default. It refuses
an existing destination unless `--overwrite` is explicit and preserves the
prior file until the replacement is complete. Cancellation or failure before
commit restores the prior output when that can be done without overwriting a
concurrent change. A conflicting or uncertain path is preserved for inspection.

The archive uses the documented USTAR+gzip structure and publishes its v1 JSON
contract at `arcane-os/schemas/arcane-app-bundle.json`. When the user explicitly
selects bundle verification, it rejects malformed archives, links, devices,
unsafe or colliding paths, unsupported archive members, trailing data, and
inconsistent descriptor or inventory structure. These checks reject corrupt
selected artifacts; they do not impose byte-count, hash, provenance, or
admission gates on ordinary development, packaging, serving, or running.
Portable path validation rejects file/directory prefix conflicts,
case-colliding prefix spellings, and Windows device aliases including
superscript COM/LPT digits.

The reusable `.github/workflows/release-app.yml` workflow
builds one selected app in a `contents: read` job with no OIDC or attestation
authority. An always-run fresh job downloads the uploaded artifact by immutable
artifact id, checks out only the reusable workflow's selected SDK revision, uses
supported Node 24, and checks the selected app id and complete inventory.
When requested, a third job downloads that same artifact id, independently
repeats those checks against the post-upload outputs, and alone receives narrow
OIDC/attestation permissions. No package manager, dependency resolution, caller
checkout, check, or adapter runs with that authority. An unattested uploaded
artifact remains an ordinary build output.

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

Version `0.5.9` exposes one browser target and five explicitly paired
native development targets: a non-runnable portable directory, a
Windows x64 unsigned-local-test EXE bundle, Linux x64 and Linux ARM64
unsigned-local-test DEBs, and an Android development-signed APK. The
`android-arm64` APK is architecture-neutral because it contains no native ABI;
the target name identifies its supported physical/native ARM64 run profile.

Every native build requires an explicit Arcane OS checkout compatible with this
SDK version and a canonical app descriptor that declares the
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

`native-prepare` is available as a standalone toolchain diagnostic. Do not run
it automatically: the build command prepares the selected toolchain itself.

The build reads the selected app release and descriptor, requires the
Core to meet the highest minimum declared by the SDK runtime, selected app, and
bundled dependencies, keep their declared Arcane protocol, and provide every
required feature, capability, and method. A Core reporting a higher version is
accepted only when it passes those same current-SDK checks; this is not a promise
that future SDK or Core releases will remain compatible. The build copies the
complete selected release. Portable emits an app-scoped
Arcane Core payload under `build/portable/`; that directory is not executable
and `arcane run --target portable` is intentionally unavailable. Windows emits
an app-scoped executable bundle under `build/windows-x64/`. Linux emits an
app-scoped amd64 DEB under `build/linux-x64/` or ARM64 DEB under
`build/linux-arm64/`. Android emits one development-signed, architecture-neutral
APK under `build/android-arm64/`; there is no native ABI payload, and its run
path requires a physical device with native ARM64 support. Executable `run`
performs package, prepare, plan, build, launch, and owned cancellation in one
process. Verification occurs only when explicitly selected for that release
output.

The Windows x64 and Linux x64 paths have been exercised end to end from
independent external repositories. Windows compiled, verified, reached an
authenticated readiness channel, and cancelled an isolated development app
while a valid installed publisher-continuity pin remained present. Linux x64
built and verified a real DEB and launched it under WSLg without installation
or `sudo`.

At the recorded Arcane source revision, the native ARM64 workflow built an
ARM64 DEB, exercised its AArch64 host, Core, and bridge, reached WebKit
load-finished readiness, and drained its owned process group. The workflow kept
Ubuntu's AppArmor user-namespace restriction enabled and loaded the packaged
Bubblewrap profile. The recorded Android development path exercised build,
readiness, cancellation, uninstall, and absence behavior on a physical ARM64
device. These are development results, not production
signing, store-publishing, release, or promotion evidence.

| Capability | Ready now |
|---|---|
| Scaffold, develop, test, check, package, verify, and browser run | Yes |
| External proprietary-source repository workflow | Yes, subject to the distribution license below |
| Integrated Arcane checkout workflow | Yes |
| ArcaneOllama managed-service check | Yes on supported Windows hosts |
| SDK native plan/provider boundary | Yes |
| Portable app-scoped Core directory | Yes, with explicit `--arcane-root`; not directly runnable |
| Windows x64 EXE bundle | Yes, unsigned local development with explicit `--arcane-root` |
| Linux x64 DEB | Yes, unsigned local development with explicit `--arcane-root` |
| Linux ARM64 DEB | Yes, unsigned local development on a compatible native ARM64 toolchain with explicit `--arcane-root`; native build, WebKit readiness, and cancellation evidence is recorded |
| Android ARM64 APK | Yes, development-signed and architecture-neutral with explicit `--arcane-root`; a physical/native ARM64 device is required for run |

Android supports APK only in this development profile. AAB, release signing,
publishing, and update continuity remain deferred. Unpaired, incompatible, or
descriptor-mismatched native requests fail without producing a substitute
artifact. Portable output is never represented as an executable, and unsigned
or development-signed evidence is never represented as production signing or
release acceptance.

See [docs/platform-targets.md](docs/platform-targets.md) for the matrix and
[docs/architecture.md](docs/architecture.md) for the boundary. The exact
minimum-version and required-contract compatibility rule is documented in
[docs/compatibility.md](docs/compatibility.md). The issue-ready
extraction sequence is tracked in [docs/roadmap.md](docs/roadmap.md).

## Canonical app descriptor

New apps own `apps/<id>/arcane-app.json` schema 2. It contains publisher,
optional permissions and security declarations, native presentation, optional
Core requirements, and target intent, and deterministically projects the schema-1
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

The loopback development server serves complete selected files and does not
apply byte-count or truncation gates. Optional hardening is inactive unless the
caller explicitly selects `secure:true`. Required credential protection,
malformed-request rejection, and unavoidable browser or operating-system safety
remain in effect. Declared origins remain native policy input only when the app
explicitly authors them.

## Licensing

The synchronized Arcane runtime and packager are currently distributed under
AGPL-3.0-only. The commercial-license notice does not itself grant proprietary
distribution rights. Resolve the applicable Arcane commercial or open-source
license before distributing a closed-source app that bundles this runtime. Each
browser release carries `LICENSE`, `COMMERCIAL-LICENSE.md`, and `NOTICE` under
`licenses/arcane-os/`; the notice includes the complete bundled Marked and
QRCode.js MIT terms.
