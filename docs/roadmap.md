# Development roadmap

The SDK already provides root application scaffolding, direct npm browser
routes, managed import maps, live source serving, browser/PWA packaging and
explicit native provider pairing. This roadmap distinguishes those implemented
contracts from remaining development work. Future items do not select an
implementation, dependency, publication or deployment.

## Current delivery baseline

- SDK publication uses the existing selected-package workflow. `dev` and
  `latest` are npm channels; `main` remains the canonical source branch. See
  [publishing](publishing.md) for the selected-artifact procedure.
- License terms and commercial licensing information are already documented in
  [LICENSE](../LICENSE), [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md) and
  [NOTICE](../NOTICE).
- Standalone apps use their repository root and installed npm resources.
  Explicit multi-app and integrated workspaces retain their selected layout.
- The browser path includes PWA installation, offline resource selection,
  conditional refresh and the shared update prompt. Development and packaged
  preview serving share the published `node-http-server` MIME map.
- The reusable application release workflow remains unavailable until its
  checked-in implementation matches the documented package-and-upload contract.
  This is separate from SDK npm publication.

## Native provider continuity

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
- Keep native build and launch within the paired provider's process lifecycle.
  Persistent sessions or restartable host integration require a separately
  selected capability and its owning host implementation.
- Preserve complete selected app releases through planning, build and run.
  Explicit verification remains separate from the ordinary build/run lifecycle.

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
- macOS: the current registry provides browser delivery and no native package
  adapter. A native adapter remains additional platform work; shared portable
  SDK behavior must keep its declared macOS support.

## Developer experience

- Keep the integrated shared/Core profile explicit through `--scope shared`:
  one exact repository-relative focused test or Arcane's one canonical
  development check, never app discovery or an arbitrary package-script loop.
- Add the Arcane Developer control panel as a client of the same operation API;
  it stores local repository paths per user and never becomes a second builder.
- Add an Arcane-owned source-development native wrapper around the same live
  browser surface when that capability is selected. The current native `run`
  command packages and builds its selected app; it is a different lifecycle.
- Preserve the implemented integrated app-scoped native path: `--workspace` and
  `--arcane-root` identify the same checkout, one app and one target are
  selected, and `--output-root` remains outside the checkout. Future GUI clients
  must use that path rather than introducing a second builder or an implicit
  all-target build.
