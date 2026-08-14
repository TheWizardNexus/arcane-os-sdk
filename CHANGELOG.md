# Changelog

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
- Added fixed Git status, fast-forward pull, and push operations for future Arcane Developer control-panel use.
- Added a durable local `.tgz` development install path while retaining exact installed SDK and runtime identity checks.
- Added preflight package conflict detection for `arcane init` and a two-pass template path preflight to avoid predictable partial scaffolds.
- Added Arcane OS license files to every browser release and complete bundled Marked and QRCode.js MIT notices.
- Changed generated CI to use the committed dependency lock through `npm ci`.
- Added exact-tree runtime receipts, bounded verified response snapshots, and serialized event ownership with process backpressure.
- Preserved the pinned runtime as byte-exact Git content so clean Windows and Linux checkouts authenticate the same receipt.
- Added the linked Arcane OS SDK README banner, explanatory subheader, and direct GitHub repository navigation.
- Added the Arcane-themed GitHub Pages project site with an accessible space-motion system, current CLI guidance, target truth table, and direct repository navigation.
