# Changelog

## 0.1.0-dev.3

- Added an authored-descriptor-only external app release envelope with an exact
  `ARCANE_APP_BUNDLE.json` contract and deterministic USTAR+gzip bytes.
- Bound the canonical schema-2 descriptor, its schema-1 package projection,
  the verified release manifest, and every payload file into one independently
  verifiable archive without adding repository-only source or tooling beyond the
  app-owned, authenticated release inventory.
- Added dependency-free streaming bundle creation and one-pass verification
  with explicit compressed, expanded, entry, file, control-document, path, and
  expansion-ratio ceilings plus fail-closed hostile tar and gzip handling.
- Hardened exact-length control, payload, and artifact reads with EOF growth
  probes, final pathname/handle identity checks, and single-link enforcement;
  concatenated gzip members and appended bytes now fail closed.
- Added create-only link promotion, explicit literal-boolean overwrite with
  create-only backup/restore, and rollback bound to the respective full
  recorded identity tuples of both promoted output and prior backup, pinned by
  open handles. Changed outputs preserve their backup, while a changed or
  missing backup preserves the valid promoted output; added digest revalidation,
  nonce-bound inspectable locks, surfaced cleanup degradation,
  safe cancellation, progress events, root SDK and toolchain APIs, and
  `arcane bundle` / `arcane verify-bundle` commands.
- Defined NFC UTF-8 byte ordering for package and bundle inventories, pinned a
  deterministic golden bundle digest to the supported Node/runner matrix,
  rejected zero-byte releases, rejected case/prefix topology conflicts and the
  complete portable Windows device-name set, and made SDK-generation
  compatibility explicit.
- Added complete receipt metadata for artifact digest/bytes; descriptor
  canonical, file, and package digests/bytes; and release manifest, policy,
  content, file-count, and payload-byte identities.
- Added a reusable exact-SDK app release workflow with immutable action pins,
  unprivileged caller-code build/upload, an always-run fresh post-upload verifier
  that becomes the sole output source, and a conditional attestation job that
  redownloads the same artifact id and compares every verified identity. The
  privileged job uses supported Node 24 via the pinned `actions/setup-node`
  revision and directly imports the dependency-free immutable SDK verifier
  without package resolution or caller code; it retains no implicit npm,
  GitHub Release, or Arcane-admission authority.
- Added the bundle schema, canonical test-set ownership, packed-SDK end-to-end
  coverage, deterministic repetition tests, and adversarial archive fixtures.

## 0.1.0-dev.2

- Kept prerelease development, integration, publication evidence, and
  documentation on canonical `main`; the `dev` work branch remains deferred
  until the first official SDK release.
- Migrated the SDK and generated application test runner to exact
  `vanilla-test` 2.1.3 while preserving isolated files, cleanup, nested cases,
  timeouts, cancellation, and nonzero failure status.
- Organized the SDK suite into non-overlapping unit, functional, integration,
  and regression sets, with smaller visible cases that reuse their existing
  fixture and process boundaries.
- Synchronized the bundled browser runtime with Arcane OS 0.8.12 and retained
  its exact 149-file source inventory.
- Added an integrated-only shared/Core development scope that runs one exact
  focused Arcane test or Arcane's canonical development check through a fixed,
  generation-bound provider without packaging an app.
- Added fixed provider pairing and canonical target requests for Linux ARM64
  DEB and development-signed Android ARM64 APK builds while preserving the
  existing browser, portable, Windows x64, and Linux x64 workflows.
- Made integrated app testing select only the chosen app's test tree while
  external repositories continue to run their root and selected-app tests.
- Bound shared provider execution to one owned process tree per checkout in an
  SDK process, with immediate acknowledgement, cancellation, busy rejection,
  mutation detection, and surfaced failure.

## 0.1.0-dev.1

- Synchronized the bundled browser runtime with Arcane OS 0.8.11 and pinned
  its exact upstream source and content inventory.
- Added explicit `--arcane-root` portable provider pairing, native doctor and
  prepare commands, and verified single-app portable Core directory builds.
- Added real Windows x64 EXE-bundle and Linux x64 DEB providers for unsigned
  local development, including same-process verified launch and owned
  cancellation. Android and ARM64 remain deferred.
- Bound paired providers to one immutable module generation, retained and reused
  one shared-payload snapshot across an app dependency closure, and bound the
  canonical app descriptor to the verified release receipt.
- Bound native plans to the exact schema-2 package policy and SDK-authenticated
  release readers, made each plan single-attempt, and reject incompatible Core
  versions, protocols, features, capabilities, and methods before build while
  accepting newer compatible Arcane versions.
- Added `new` and `init --target portable` scaffolding with the required raster
  icon, browser-plus-portable target intent, and generated portable guidance.
- Refuse unknown portable output collisions and authenticate an exact prior
  Arcane artifact before replacement.
- Fixed the generated app test so newly scaffolded repositories execute their
  theme and package identity checks successfully.

## 0.1.0-dev.0

- Added the first external-repository Arcane OS SDK and `arcane` CLI.
- Added external and integrated workspace profiles so the same operations can
  use either the pinned SDK runtime or the live Arcane checkout runtime.
- Added canonical schema-2 `arcane-app.json` descriptors with exact schema-1
  package and native-registry compatibility projections.
- Added integrated `arcane init` scaffolding that writes only app-owned files
  and preserves every Arcane root package, workflow, lock, and instruction file.
- Added app scaffolding, environment diagnostics, browser development, focused tests, validation, deterministic packaging, and package verification.
- Added a platform-neutral target adapter contract with an available browser target and explicit deferred Windows, Linux, and Android native targets.
- Added a process-local native provider pairing lifecycle for doctor, caller-owned
  preparation, immutable planning, verified build, artifact verification, and
  receipt-bound run without changing the default deferred target registry.
- Tightened the public app-descriptor schema to match native raster-icon,
  embedding-capability, browser frame-origin, and conflicting-capability rules.
- Added fixed Git status, fast-forward pull, and push operations for future Arcane Developer control-panel use.
- Added a durable local `.tgz` development install path while retaining exact installed SDK and runtime identity checks.
- Added preflight package conflict detection for `arcane init` and a two-pass template path preflight to avoid predictable partial scaffolds.
- Added Arcane OS license files to every browser release and complete bundled Marked and QRCode.js MIT notices.
- Changed generated CI to use the committed dependency lock through `npm ci`.
- Added exact-tree runtime receipts, bounded verified response snapshots, and serialized event ownership with process backpressure.
- Preserved the pinned runtime as byte-exact Git content so clean Windows and Linux checkouts authenticate the same receipt.
- Added the linked Arcane OS SDK README banner, explanatory subheader, and direct GitHub repository navigation.
- Added the Arcane-themed GitHub Pages project site with an accessible space-motion system, current CLI guidance, target truth table, and direct repository navigation.
