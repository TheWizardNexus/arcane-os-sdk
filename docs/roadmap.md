# Development roadmap

The SDK contract names future targets now so adding them does not change app
commands, structured events, lock files, or GUI integrations. Each item below is
small enough to become a GitHub issue without combining every platform into one
unbounded build.

## Publication prerequisites

- Mark the Arcane OS monorepo root package private or give it an internal-only
  package name before the first `arcane-os` publication.
- Decide and document the license that permits proprietary applications to
  bundle the synchronized Arcane runtime.
- Publish `0.1.0-dev.0` under only the npm `dev` tag, verify the tarball and
  provenance, add a second appropriate npm owner, and configure the exact
  trusted-publisher workflow.

## App admission and native extraction

- Define a manifest-v2 app descriptor for capabilities, granted methods,
  security origins, icon, native type, bundled dependencies, minimum Core
  features, publisher identity, and target compatibility.
- Update Arcane's exact-key consumers to project the new descriptor into the
  current catalog while preserving v1 app-release admission during migration.
- Extract the native builder behind explicit `toolchainRoot`, verified
  `appReleaseRoot`, approved `appDescriptor`, `outputRoot`, and `targetRequest`
  inputs. It must load only the selected app and declared dependencies.
- Add an authenticated Arcane host broker for cross-process verification receipt
  reuse and app-scoped Core development sessions.
- Retain and authenticate the exact packaged artifact state across browser and
  native plan, verify, and run boundaries instead of treating a mutable path or
  manifest file as a reusable receipt.
- Add a manifest-declared origin policy for native enforcement and an optional
  policy-faithful development mode. The current capability-gated loopback host
  deliberately uses a broad development-only policy so the shared runtime can
  exercise remote providers, media, WebSockets, and embeds.

## Platform adapters

- `portable`: package the app-scoped Core and descriptor without requiring the
  Arcane checkout or its global app registry.
- `windows-x64`: produce and verify a complete development application directory,
  then add explicit production signing as separate promotion work.
- `linux-x64`: extract the single-app WebKitGTK host and add AppImage, DEB, and
  RPM formats as distinct requests.
- `linux-arm64`: build and verify an ARM64 Core and native host before enabling
  the Linux packaging formats.
- `android-arm64`: build one app flavor from one approved descriptor; reject
  unsupported bridge methods before Gradle runs; add APK first, then AAB and
  release signing.

## Developer experience

- Add the Arcane Developer control panel as a client of the same operation API;
  it stores local repository paths per user and never becomes a second builder.
- Add authenticated GitHub artifact admission so Arcane OS installs verified
  releases without cloning proprietary source.
- Add an Arcane-native development host once Arcane can safely provide the same
  filesystem, process, target, cancellation, and receipt controls on-device.
