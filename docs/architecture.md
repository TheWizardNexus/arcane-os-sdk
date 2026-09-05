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
and the packaging and license boundaries for that portable content. In
particular, shared AI selected-role hydration, startup-settled state and events,
role readiness, lifecycle and
cancellation contracts, and the shared chat and speech components are
SDK-owned source and contracts rather than Arcane OS–owned snapshots.

Every portable application artifact materializes the complete SDK runtime,
assets, workers, licenses and public contracts it uses. It remains self-contained whether it runs as plain
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

Application and consumer tasks do not modify this repository's SDK source and
do not hand-edit materialized `arcane/**` projections. They request a reusable
change from an SDK source owner, or implement behavior that is specific to their
product in that application's local source. Consumer projections change only
through the selected public package and materializer.

Development and distribution use different authority. The explicit
`arcane dev --sdk-runtime-source <sdk-root>` development-only live source mount
lets a refresh read the saved SDK source without copying it into the app.
Distribution never follows that mount. It embeds the application's complete
selected SDK projection.

`runtime/arcane/` is the SDK-canonical source. Arcane OS must consume the
selected SDK projection through the same package/source-mount boundary as
other apps; its repository-side consumer cutover is coordinated separately and
does not create a co-equal source. Git history records the completed ownership
migration; the current tree has no OS-to-SDK synchronization path.

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
a source of portable SDK runtime content. That provider selects only one exact
repository-relative focused `.test.mjs` through Arcane's canonical focused
runner or Arcane's canonical development check. External workspaces cannot use
the scope, and shared operations never enter app discovery, packaging, target
planning, build, verification, or run paths. A generation change requires a new
CLI process.
Integrated app testing remains isolated to the selected `apps/<id>/test/`
tree; it cannot recursively select Arcane root tests or another app's tests.
External repositories retain their existing workspace-root plus selected-app
test layout.

## Development and release serving boundary

Arcane applications keep one browser-first plain HTML, CSS, and JavaScript
baseline. A native target runs that same application and progressively enhances
it through capability-gated Arcane Core access. Browser operation must not
depend on Core being present. A feature that genuinely requires Core reports
its unavailability without breaking unrelated browser
behavior or claiming that the capability exists.

Rapid development uses `arcane dev`. The development server maps the selected
application's canonical source tree and the live installed SDK/runtime routes.
Each request reads and returns the complete current saved source, so a browser
refresh shows source changes without packaging, copying
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
It preserves the browser behavior when Core is absent, reports an unavailable
native-only capability honestly, and never silently substitutes a release
tree. Starting or refreshing this wrapper does not package, copy to `dist`, or
run tests automatically. The SDK must not describe native source development as
available until this wrapper and its explicit capability boundary are actually
implemented.

Packaging and release verification are separate explicit operations. Run
`arcane package` to generate `dist/<id>`, then use
`arcane run --target browser` to serve that selected release. Packaging does
not automatically run tests or checks; those run only when the user expressly
requests them or when required for a separately selected release output. The browser
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
those selected SDK routes completely inside the portable artifact, so the
finished app has no Arcane OS runtime dependency.

Release schema 1 and builder identity `arcane-app-packager-v1` remain unchanged
because current Arcane native consumers treat them as public contracts. Native
builders consume the schema-2 descriptor as a separate build input while v1
host artifacts remain unchanged.

External repository delivery adds a distinct schema-1
`arcane-app-release-bundle` envelope. Bundle creation uses an authored schema-2
`arcane-app.json`; a synthesized package or registry projection remains valid for integrated
packaging but is not used for an external bundle. The
archive contains exactly `ARCANE_APP_BUNDLE.json`, canonical `arcane-app.json`,
`payload/ARCANE_APP_RELEASE.json`, and the release inventory beneath `payload/`
in that order. The envelope adds no repository-only source or build tooling
beyond that selected release inventory. Individual apps remain responsible for
their authored source policy.

The bundle contract uses the documented USTAR+gzip structure. Explicit bundle
verification parses the selected archive without extraction and rejects
genuinely malformed structures, unsafe or colliding paths, unsupported members,
trailing data, and incompatible bundle generations. These corrupt-artifact
checks do not create byte-count, content-hash, provenance, or admission gates
for ordinary development, packaging, serving, or running.

Promotion preserves any prior output until the new archive is complete.
Pre-commit failure restores that backup when doing so will not overwrite a
concurrent change; otherwise the uncertain paths remain available for
inspection. Ordinary results report the selected artifact and complete
inventory without byte identities. The workflow creates no provenance,
attestation, signing, or restrictive admission record.

The governing reusable app-release contract uses one `contents: read` job to
check out the selected caller revision, perform the caller's normal locked
install, package and bundle one selected app, and upload that complete bundle.
The checked-in workflow is unavailable until it matches this contract. The
contract does not include a second verifier or privileged attestation job.

## Operation ownership

An invocation defaults to one workspace, one app, one command, one target, one
architecture, one format, and one signing profile. It acknowledges before long
work, uses one `AbortController`, supervises child processes, and routes progress
through one serialized owned event queue. Process streams apply pause/resume
backpressure and heartbeats coalesce. Callback failure cancels owned work, drains
the queue, and reaches the caller or CLI exit status. Packaging preserves prior
output until replacement is complete.

Each normalized queue event is also mirrored exactly once through the shared
`arcaneEvents` `EventManager`. That synchronous `event-pubsub` route is the
canonical cross-cutting instrumentation surface, but it does not replace the
owned asynchronous callback path or its backpressure. Time-travel history and
DOM observation remain explicitly disabled unless a diagnostic session enables
them. See [event-manager.md](event-manager.md) for the complete record, capture,
DOM coverage, and effect-isolated playback boundaries.

For `--scope shared`, the cardinality changes to one integrated workspace, one
named operation, and either one exact test file or one development check. The
same owned event queue and process supervisor provide acknowledgement, complete
stream delivery with backpressure, heartbeat, cancellation, process-tree
cleanup, and nonzero
failure propagation. No app or target loop exists in that scope.

## Complete-content ordinary path

Packaging writes the complete schema-1 release inventory to
`ARCANE_APP_RELEASE.json`. Ordinary development, packaging, serving, and run
paths do not count, limit, hash, truncate, tail, clip, or identify content by
bytes, and they do not require provenance or verification receipts. The
loopback server reads and returns each complete selected source, runtime, or
packaged file. Required credential protection, malformed-input rejection,
applicable law, unavoidable protocol rules, and operating-system or browser
safety remain in effect.

## Native provider boundary

The SDK implements protocol `arcane-native-build-plan/1` and the injected
provider contract `arcane-native-builder/1`. Pairing is process-local; it never
registers a mutable global provider or searches for a toolchain. For each
supported native target, the CLI loads one fixed provider module from the
explicit `--arcane-root` Arcane OS checkout. Provider code is bound to one
process generation; if a pull changes loaded provider code, the caller starts a
fresh worker. One paired toolchain can perform this lifecycle:

```text
doctor -> prepare -> plan -> build -> run
```

The portable provider reports honestly that run is unavailable because its
result is a directory. Windows x64, Linux x64,
Linux ARM64, and Android ARM64 implement same-process launch and owned
cancellation when their compatible host/device requirements are present.
Windows uses a retained per-build broker and host readiness. The
Linux provider produces an amd64 or ARM64 DEB and runs a retained
user-owned extraction without install or elevation. Portable, Windows, and
Linux use the `unsigned-local-test` signing profile.

The Android provider produces one development-signed APK. It contains no native
library or ABI-specific payload, so the artifact is architecture-neutral; the
`android-arm64` target instead binds the supported run path to one physical
device with native ARM64 support. APK is the only Android format in this
development provider. AAB, release signing, publishing, and update continuity
remain outside it.

The plan selects one explicit `toolchainRoot`, one app release root, its
schema-2 descriptor, only its
declared dependency releases, one non-overlapping output root, and one target,
platform, architecture, format, and signing request. App source and workspace
paths are withheld from the native provider. The provider copies the complete
selected release rather than accepting an unrelated source path. Verification
is a separate explicit operation for a selected release artifact.

The SDK `0.5.15` runtime requires Arcane `0.8.12` or newer. Compatibility
is contractual rather than exact-version pinning: the prepared Core must meet
the highest minimum declared by the runtime, selected app, and bundled app
dependencies; keep each app's Arcane protocol generation; and provide every
declared feature, capability, and method. Missing requirements stop before
provider build; a newer compatible Core is accepted. Browser-only apps may omit
`minimumCoreVersion`, and missing permissions or optional security declarations
normalize to empty records. The provider paths have
been validated from independent workspaces. They do not copy proprietary source
into the Arcane checkout.

See [compatibility.md](compatibility.md) for the complete app and bundled-app
compatibility rule and the required handling of breaking contract changes.

Linux ARM64 shares the implemented Linux provider, focused tests, and a
target-scoped remote evidence workflow. The recorded workflow exercised the
native AArch64 toolchain, DEB, host/Core/bridge, sandboxed WebKit readiness, and
owned process-group cancellation. The recorded Android development path
exercised physical-device build, readiness, cancellation, uninstall, and
absence behavior. Neither record establishes
production signing, installation, publishing, update continuity, release
acceptance, or production readiness.
