# Architecture

The CLI, future Arcane Developer graphical control panel, CI, and Codex all use
one headless operation API. A client selects a named operation and consumes the
same structured event stream; the GUI is not a second build system.

```text
external app repository -----+
                              |
Arcane OS consumer checkout --+-- CLI / future GUI / Codex / CI
                                      |
                               shared toolchain API
                                      |
                       browser package or explicit target adapter
```

## Canonical ownership and portability boundary

The SDK repository is the canonical source for every mechanism that can be
reused by a portable Arcane application. That includes shared modules,
entities, components, themes, browser runtimes, providers, workers and assets;
protocol, state, startup, readiness, progress, cancellation, unload and dispose
machinery; public native contracts and adapters; the development source mount;
and the packaging, license, receipt and verification boundaries for those
portable bytes. In particular, shared AI selected-role hydration,
startup-settled state and events, fail-closed role readiness, lifecycle and
cancellation contracts, and the shared chat and speech components are
SDK-owned source and contracts rather than Arcane OS–owned snapshots.

Every portable application artifact materializes an immutable, locked and
verified projection of the SDK runtime bytes, assets, workers, licenses and
public contracts it uses. It remains self-contained whether it runs as plain
HTML or inside an executable wrapper. It has no runtime dependency on an
Arcane OS installation, source checkout or private Arcane OS import.

Arcane OS is an SDK consumer like other applications. Its orchestrator,
launcher, Shell, Provisioner, system AI application and internal tools use the
same SDK modules and components rather than maintaining private runtime copies.
Arcane OS and Core own the privileged host implementations, app/session
admission and authorization, native transport and lifecycle, launcher and
Shell orchestration, and system-AI policy specific to the Shell. The SDK may
publish the capability-neutral Core bridge contract and adapters, but it does
not embed Core or inherit another application's policy.

Each application owns its branding, prompts, data, tools, business policy,
model authorities and app-specific orchestration. Apply this decision order:

| Responsibility | Canonical owner |
|---|---|
| Reusable by any portable application | Arcane SDK |
| Host privilege, launcher, Shell or app/session admission | Arcane OS / Core |
| Behavior unique to one product | That application |

Do not copy a reusable implementation between the SDK, Arcane OS and an app,
and do not create a hidden Arcane OS source dependency. Extend one neutral SDK
contract and keep product policy in the consumer.

Development and distribution use different authority. The explicit
`arcane dev --sdk-runtime-source <sdk-root>` development-only live source mount
lets a refresh read the saved SDK source without copying it into the app.
Distribution never follows that mount. It embeds and verifies the application's
locked immutable SDK projection.

`tools/runtime-source.json` declares SDK-canonical authority for
`runtime/arcane/` and retains the prior Arcane OS source only as legacy
provenance for migrated compatibility bytes. The old OS-to-SDK synchronization
direction is retired and fails closed. Arcane OS must consume a locked SDK
projection through the same package/source-mount boundary as other apps; its
repository-side consumer cutover is coordinated separately and does not create
a co-equal source.

## Workspace profiles

An external workspace maps the exact runtime shipped by its locked `arcane-os`
dependency. An Arcane OS checkout is an integrated SDK consumer, not the owner
of portable runtime source. For live shared development, the explicit
development-only SDK source mount maps the canonical SDK runtime and dependency
paths into that consumer. Without the mount, the workspace uses its locked SDK
projection. The development server and packager consume the same route
destinations in both cases, so app imports do not change. Integrated
initialization creates only app-owned files and never rewrites Arcane OS or SDK
root configuration.

The shared/Core development profile is a separate integrated-only scope selected
with `--scope shared`. The SDK loads exactly
`tools/integrated-development-provider.mjs` from the selected Arcane OS checkout
as one process generation. This is a privileged host-development provider, not
a source of portable SDK runtime bytes. That provider admits only one exact
repository-relative focused `.test.mjs` through Arcane's canonical focused
runner or Arcane's canonical development check. External workspaces cannot use
the scope, and shared operations never enter app discovery, packaging, target
planning, build, verification, or run paths. Provider bytes and filesystem
identity are authenticated before and after the owned child operation; a
generation change poisons that pairing and requires a new CLI process.
Integrated app testing remains isolated to the selected `apps/<id>/test/`
tree; it cannot recursively select Arcane root tests or another app's tests.
External repositories retain their existing workspace-root plus selected-app
test layout.

## Development and release serving boundary

Arcane applications keep one browser-first plain HTML, CSS, and JavaScript
baseline. A native target runs that same application and progressively enhances
it through capability-gated Arcane Core access. Browser operation must not
depend on Core being present. A feature that genuinely requires Core fails
closed and explains its unavailability without breaking unrelated browser
behavior or claiming that the capability exists.

Rapid development uses `arcane dev`. The development server maps the selected
application's canonical source tree and the live installed SDK/runtime routes.
Each request reads the current saved source into the existing bounded response
snapshot, so a browser refresh shows source changes without packaging, copying
files into `dist`, or restarting the server. Restarting is not a content
synchronization step; when a refresh is stale, first verify the command, URL,
workspace, selected app, and resolved source route.

Development is an intentionally fast feedback loop. Keep each increment small
and independently understandable so its effect has one clear cause and a
mistake can be isolated without untangling unrelated work. A development
operation does not implicitly run tests, checks, packaging, builds, or release
verification. The developer invokes a focused test or check deliberately at an
explicit checkpoint; merely refreshing source does not trigger one.

Executable development uses an Arcane-owned native development wrapper around
the same source-serving browser surface. The wrapper is an escalated browser,
not a packaged application: it loads current source files and adds only the
selected application's declared, capability-gated local Arcane Core access.
It preserves the browser behavior when Core is absent, fails closed for an
unavailable native-only capability, and never silently substitutes a release
tree. Starting or refreshing this wrapper does not package, copy to `dist`, or
run tests automatically. The SDK must not describe native source development as
available until this wrapper and its explicit capability boundary are actually
implemented.

Package and release verification use a separate explicit boundary. Run
`arcane package` to generate and verify `dist/<id>`, then use
`arcane run --target browser` to serve only that verified release. Distribution
automatically runs the selected application's required tests before accepting,
serving, or launching `dist` and fails closed on any test failure. The browser
run command does not substitute source files. If source changes after
packaging, the prior `dist` remains intentionally unchanged until the next
explicit package operation. Never use packaged `dist` as the everyday
development tree, and never treat source-serving behavior as evidence for the
release artifact.

## App and release contract

The first SDK version deliberately preserves Arcane's current repository-shaped
URLs and release schema:

```text
apps/<id>/arcane-app.json
apps/<id>/arcane-package.json
apps/<id>/index.html
dist/<id>/ARCANE_APP_RELEASE.json
```

The authored schema-2 descriptor is canonical for new apps and projects an
exact schema-1 `arcane-package.json` for current consumers. Existing Arcane
apps synthesize that descriptor from their schema-1 package plus the current
native registry during migration.

An external app's `arcane-packager.json` has three exact shared routes. They map
the installed SDK runtime to `/arcane`, its vendored strong-type dependency to
`/node_modules/strong-type`, and the SDK's `LICENSE`,
`COMMERCIAL-LICENSE.md`, and `NOTICE` to `/licenses/arcane-os`. Development does
not copy SDK runtime source into the app repository. Distribution materializes
those exact locked SDK routes inside the portable artifact and verifies their
immutable inventory, so the finished app has no Arcane OS runtime dependency.

Release schema 1 and builder identity `arcane-app-packager-v1` remain unchanged
because current Arcane native admission treats them as exact contracts. Native
builders authenticate the schema-2 descriptor digest as a
separate build input while exact v1 host artifacts remain unchanged.

External repository delivery adds a distinct schema-1
`arcane-app-release-bundle` envelope. Bundle creation accepts only a
process-authenticated release receipt whose descriptor authority was an authored
schema-2 `arcane-app.json`; a synthesized legacy descriptor remains valid for
integrated packaging but cannot cross the external admission boundary. The
archive contains exactly `ARCANE_APP_BUNDLE.json`, canonical `arcane-app.json`,
`payload/ARCANE_APP_RELEASE.json`, and the release inventory beneath `payload/`
in that order. The envelope adds no repository-only source or build tooling
beyond that authenticated release inventory. Individual apps remain responsible
for leak/source policy, and Arcane's source-free runtime gates remain separate.

The byte contract is deterministic USTAR with regular 0644 files, zero owner
ids and modification times, canonical UTF-8 paths and headers, exact zero
padding, and exactly two terminal blocks, wrapped in one deterministic gzip
member. NFC inventory paths use raw UTF-8 byte order, not host locale collation;
the packager, bundle verifier, and Arcane importer share that ordering, while a
pinned golden bundle digest runs across the supported Node and runner matrix.

Verification parses the expanded stream without extraction, applies absolute
size/cardinality and expansion-ratio ceilings, recompresses the stream to
require the exact gzip encoding, and rejects appended bytes or concatenated
members. Every source control, payload, staged archive, and verification input
is opened no-follow as a single-link regular file, consumed at its recorded
length with an EOF growth probe, and rechecked by handle and pathname identity.
Every cumulative path prefix has one case-folded spelling and one file/directory
kind; prefix topology conflicts and the complete portable Windows device-name
set fail before creation or admission.
The current SDK admits only the explicitly compatible `0.2.2` bundle
generation and rejects zero-byte payload releases.

Promotion retains any prior output as an identity-bound backup until the new
pathname has passed a second exact-length digest and single-link identity check
and its immutable receipt is bound. Pre-commit failure restores that backup
only when both the promoted pathname and prior backup retain their respective
full recorded identity tuples, pinned by their open handles. A replaced or
in-place-changed output is never removed during rollback; it and the prior
backup remain available for inspection. A missing or changed backup likewise
causes rollback to preserve the valid promoted output rather than delete it.
Post-commit backup or
nonce-bound lock cleanup failure is surfaced as degraded cleanup and preserves
the uncertain path for inspection. The receipt exposes
artifact digest/bytes, descriptor canonical/file/package digests and bytes, and
release manifest/policy/content digests, file count, and total payload bytes.
These hashes prove internal consistency. Repository provenance or an
independent signature plus an Arcane-owned authorization lock remains the
separate installation authority.

The reusable app-release workflow keeps caller checks and adapters in a
`contents: read` build job. A fresh unprivileged job downloads the immutable
upload by artifact id, checks the requested app id and complete identity with the
exact called-workflow SDK, and alone supplies reusable outputs. Its conditional
attestation job redownloads the same artifact id, repeats those checks against
the post-upload outputs, and directly imports the dependency-free verifier from
the trusted source checkout under supported Node 24 via the pinned
`actions/setup-node` revision. No package-manager install, dependency
resolution, caller checkout, or caller code runs while OIDC and
attestation-write authority is present.

## Operation ownership

An invocation defaults to one workspace, one app, one command, one target, one
architecture, one format, and one signing profile. It acknowledges before long
work, uses one `AbortController`, supervises child processes, and routes progress
through one serialized owned event queue. Process streams apply pause/resume
backpressure and heartbeats coalesce. Callback failure cancels owned work, drains
the queue, and reaches the caller or CLI exit status. Packaging preserves prior
output until verified replacement.

Each normalized queue event is also mirrored exactly once through the shared
`arcaneEvents` `EventManager`. That synchronous `event-pubsub` route is the
canonical cross-cutting instrumentation surface, but it does not replace the
owned asynchronous callback path or its backpressure. Time-travel history and
DOM observation remain explicitly disabled unless a bounded diagnostic session
enables them. See [event-manager.md](event-manager.md) for the record, redaction,
DOM coverage, and effect-isolated playback boundaries.

For `--scope shared`, the cardinality changes to one integrated workspace, one
named operation, and either one exact test file or one development check. The
same owned event queue and process supervisor provide acknowledgement, bounded
stream delivery, heartbeat, cancellation, process-tree cleanup, and nonzero
failure propagation. No app or target loop exists in that scope.

## Verification receipts

Runtime verification binds the exact SDK version, canonical SDK source
identity, runtime inventory, byte counts, and SHA-256 hashes. During the
source-ownership migration it may additionally record imported Arcane OS
provenance for compatibility bytes, but that field does not transfer canonical
ownership. Packaging writes the full
schema-1 release inventory to `ARCANE_APP_RELEASE.json`; its operation result
returns a deeply immutable, process-authenticated receipt that binds the
canonical location, app policy, complete inventory, content digest, and verified
filesystem identities. The browser run path authenticates that receipt before
serving it, and every native provider consumes release bytes through SDK-bound
verified readers before verifying its app-scoped artifact. Windows and Linux
retain artifact authority for same-process verification and launch. Persistent
cross-process reuse still requires an authenticated Arcane broker; a path,
timestamp, environment variable, or receipt file alone is not authority.

The loopback server treats the mutable filesystem as an input, not as an
immutable receipt. Before sending headers it reads each requested source,
runtime, or packaged file into a bounded buffer, verifies the expected hash for
receipt-bound files, and repeats the handle/path identity check. A response is
therefore an exact verified byte snapshot even if another process writes during
the request. Development serving is limited to 64 MiB per file and four active
file responses, with a bounded wait queue.

## Native provider boundary

The SDK implements protocol `arcane-native-build-plan/1` and the injected
provider contract `arcane-native-builder/1`. Pairing is process-local; it never
registers a mutable global provider or searches for a toolchain. For each
supported native target, the CLI loads one fixed provider module from the
explicit `--arcane-root` Arcane OS checkout. Provider code is bound to one
process generation; if a pull changes any loaded provider module, the SDK fails
closed and requires a fresh worker rather than combining new hashes with Node's
cached old modules. One paired toolchain can perform this lifecycle:

```text
doctor -> prepare -> plan -> build -> verify receipt -> run receipt
```

The portable provider implements the lifecycle through verification and fails
honestly on run because its result is a directory. Windows x64, Linux x64,
Linux ARM64, and Android ARM64 implement same-process launch and owned
cancellation when their compatible host/device requirements are present.
Windows uses a retained per-build broker and authenticated host readiness. The
Linux provider produces a verified amd64 or ARM64 DEB and runs a retained
user-owned extraction without install or elevation. Portable, Windows, and
Linux use the `unsigned-local-test` signing profile.

The Android provider produces one development-signed APK. It contains no native
library or ABI-specific payload, so the artifact is architecture-neutral; the
`android-arm64` target instead binds the supported run path to one physical
device with native ARM64 support. APK is the only Android format in this
development provider. AAB, release signing, publishing, and update continuity
remain outside it.

The plan binds one explicit `toolchainRoot` and authenticated receipt, one app
release root and receipt, its approved schema-2 descriptor digest, only its
declared dependency releases, one non-overlapping output root, and one target,
platform, architecture, format, and signing request. App source and workspace
paths are withheld from the native provider. The provider copies release bytes
through SDK-bound verified readers rather than accepting a mutable source path
as authority. Build completion requires provider verification, and later
verify/run calls receive the exact artifact receipt.

The SDK `0.2.2` runtime requires Arcane `0.8.12` or newer. Compatibility
is contractual rather than exact-version pinning: the prepared Core must meet
the highest minimum declared by the runtime, selected app, and bundled app
dependencies; keep each app's Arcane protocol generation; and provide every
declared feature, capability, and method. Missing requirements stop before
provider build; a newer compatible Core is accepted. Exact hashes
remain integrity identities, not compatibility rules. The provider paths have
been validated from independent workspaces. They do not copy proprietary source
into the Arcane checkout.

See [compatibility.md](compatibility.md) for the complete app and bundled-app
admission rule and the required handling of breaking contract changes.

Linux ARM64 shares the implemented Linux provider, focused tests, and a
target-scoped remote evidence workflow. At Arcane revision
`4382043c09285ea203aa6daba1732660966ac409`, that workflow proved native AArch64
toolchain, DEB, host/Core/bridge, retained verification, sandboxed WebKit
readiness, and owned process-group cancellation. The hardened Android path has
exact-SHA physical ARM64/API 37 build, process/generation/nonce readiness,
cancellation, uninstall, and absence evidence. Neither record establishes
production signing, installation, publishing, update continuity, release
acceptance, or production readiness.
