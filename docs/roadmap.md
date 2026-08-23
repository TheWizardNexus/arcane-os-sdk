# Development roadmap

The SDK contract keeps target names and operations stable while each current
development provider gathers its remaining promotion evidence. Each item below
is small enough to become a GitHub issue without combining every platform into
one unbounded build.

## Publication prerequisites

- Mark the Arcane OS monorepo root package private or give it an internal-only
  package name before the first `arcane-os` publication.
- Decide and document the license that permits proprietary applications to
  bundle the synchronized Arcane runtime.
- Publish `0.1.0-dev.3` under only the npm `dev` tag, verify the tarball and
  provenance, add a second appropriate npm owner, and configure the exact
  trusted-publisher workflow.

## App admission and native extraction

- Keep the implemented process-local `arcane-native-build-plan/1` and
  `arcane-native-builder/1` lifecycle as the single provider seam for the CLI,
  GUI, CI, and Codex. Portable, Windows x64, Linux x64, Linux ARM64, and Android
  ARM64 pair only through an explicit compatible Arcane root and a matching
  canonical scaffold descriptor.
- Migrate built-in apps from the implemented schema-2 `arcane-app.json`
  descriptor fallback to authored descriptors without changing exact v1 release
  or native-host artifacts.
- Update Arcane's exact-key consumers to project the new descriptor into the
  current catalog while preserving v1 app-release admission during migration.
- Preserve the implemented portable, Windows x64, Linux x64, Linux ARM64, and
  Android ARM64 providers as one selected app plus its exact declared dependency
  closure. Add new providers without weakening that release-reader boundary.
- Extend the implemented same-process retained receipt lifecycle through an
  authenticated Arcane host broker only when persistent cross-process reuse or
  restartable app-scoped Core sessions are required.
- Preserve exact packaged-artifact authority across browser and native plan,
  verify, and run boundaries; never regress to treating a mutable path or
  manifest file as a reusable receipt.
- Add a manifest-declared origin policy for native enforcement and an optional
  policy-faithful development mode. The current capability-gated loopback host
  deliberately uses a broad development-only policy so the shared runtime can
  exercise remote providers, media, WebSockets, and embeds.

## Platform adapters

- `portable`: keep the available verified app-scoped Core directory reproducible
  from an external packed-SDK install and an explicit compatible Arcane checkout;
  do not present it as an executable or direct-run target.
- `windows-x64`: keep the implemented retained toolchain broker, EXE bundle,
  authenticated host-readiness signal, and owned same-process cancellation
  reproducible. Production signing and installation remain separate work.
- `linux-x64`: keep the implemented single-app WebKitGTK host, verified amd64
  DEB, user-owned extraction, and same-process cancellation reproducible. Add
  AppImage and RPM only as distinct later format requests.
- `linux-arm64`: keep the implemented unsigned-local-test ARM64 DEB provider,
  focused provider tests, and exact-SHA native build/verification/readiness/
  cancellation workflow reproducible on a compatible native ARM64 toolchain.
  Keep AppImage, RPM, and production signing as separate future requests.
- `android-arm64`: keep the implemented single-app, development-signed APK path
  and exact-SHA physical/native ARM64 build/readiness/cleanup evidence
  reproducible. The APK contains no native ABI and is architecture-neutral. Add
  AAB, release signing, store publishing, and update continuity only as explicit
  later promotion work.

## Developer experience

- Keep the integrated shared/Core profile explicit through `--scope shared`:
  one exact repository-relative focused test or Arcane's one canonical
  development check, never app discovery or an arbitrary package-script loop.
- Add the Arcane Developer control panel as a client of the same operation API;
  it stores local repository paths per user and never becomes a second builder.
- Add authenticated GitHub artifact admission so Arcane OS installs verified
  releases without cloning proprietary source.
- Preserve the implemented integrated app-scoped native path: `--workspace` and
  `--arcane-root` identify the same checkout, one app and one target are
  selected, and `--output-root` remains outside the checkout. Future GUI clients
  must use that path rather than introducing a second builder or an implicit
  all-target build.
