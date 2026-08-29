# Changelog

## 0.3.4

- Allowed external and integrated physical SDK workspaces to omit the optional
  `security` runtime route while preserving the canonical functional route
  order, `dependencies` and `sdk` projections, external license routing, and
  compatibility with workspaces that still include `security`.
- Preserved a newer microphone retry's press, status, and operation identity
  when an earlier pending capture request settles, while retaining the original
  operation correlation for successful transcription.

## 0.3.3

- Corrected installed-workspace import-map refresh to preserve rich browser
  document inspection records while passing only navigable document paths to
  the public generator, including `.html` and `.htm` pages without modifying
  HTML fragments.
- Restored one semantic `arcane.lock.json` contract across scaffold, init, and
  installed runtime materialization, replacing stale versions with the exact
  installed package version and npm-alias roots without byte or security
  metadata.
- Added selected installed-package coverage for stale-lock replacement and the
  public multi-document import-map command through the packed npm artifact.

## 0.3.2

- Preserved complete application, document, model, message, event, process,
  mail, and diagnostic content across the ordinary SDK runtime and tooling.
- Removed ordinary byte, hash, digest, receipt, provenance, exact-inventory,
  truncation, clipping, freeze, and unapproved hardening gates while retaining
  unavoidable transport framing and credential protection at their owners.
- Added the complete browser-WASM chat, speech, persistence, structural-tool,
  source-example serving, descriptor, packaging, and application-test contracts
  required by SDK consumers, with optional security remaining opt-in.
- Limited the npm package to consumer runtime, source, schema, CLI/tooling, and
  required root metadata; examples, documentation, generated site output, and
  tests remain repository-owned follow-up surfaces outside the published package.

## 0.3.1

- Restored ordinary warn-first Browser Speech operation with explicit
  `secure:false` defaults, one concise load warning, and truthful
  `unchecked`/`pending`/`verified`/`failed` integrity telemetry while keeping
  strict authenticated-graph admission behind explicit `secure:true`.
- Added atomic hydration for exact saved-but-unregistered STT/TTS selections
  without a transient provider fallback, including independent mixed
  browser/Cloud/Core role ownership and mismatch-safe rollback.
- Continued to resolve speech runtimes, models, voices, and providers from
  their upstream npm/fetch distribution paths; the SDK package redistributes
  none of those third-party payloads or their legal corpora.

## 0.3.0

- Added the branded, versioned, per-realm `globalThis.arcaneEvents` authority
  and moved SDK semantic publishers onto one event-pubsub-backed source while
  retaining bounded legacy EventTarget and DOM projections.
- Added independent Browser Speech STT/TTS provider ownership with initial or
  later role-scoped replacement, mixed Cloud/Core/browser routes, explicit
  lifecycle, and no omitted-role unload, mute, disposal, or state clobbering.
- Made Browser Speech warn-first by default: applications select version-pinned
  upstream runtime/model/voice downloads and browser cache behavior, while
  `secure:true` remains the explicit strict authenticated-graph option.
- Added the portable `arcane-os/mail` API, durable DBOPFS-compatible outbox,
  secure local Resend gateway and CLI, event-owned reconnect drain, bounded
  retries, cancellation, cleanup, and provider-acceptance evidence.
- Kept speech runtimes, model and voice bytes, third-party legal/notice files,
  and corresponding-source archives out of the SDK package and release assets.

## 0.2.3

- Made shared voice transcription consume authoritative sticky STT state,
  expose explicit selected-unloaded activation, and keep recording disabled
  until the selected route is genuinely ready and non-busy.
- Added owned cancellation and current-operation guards across microphone
  permission, recording, transcription, save, completion, transcript
  replacement, synchronous public events, teardown, and stale settlement.
- Centralized the shared STT activation control in
  `createSTTActivationController()` without automatic downloads, hidden
  provider selection, or application policy.

## 0.2.2

- Corrected latest-request-wins ownership so each newly admitted AI request
  aborts and settles the prior provider operation, revalidates role readiness,
  and prevents stale results from restoring superseded state.
- Made speech startup and controls explicitly lifecycle-owned: STT startup is
  opt-in, selected-unloaded STT exposes user activation and cancellation,
  caller abort reaches shared transcription, and TTS mute/unmute owns its load,
  cancellation, playback, and unload sequence.
- Kept positive speech readiness bound to admitted sticky provider state while
  exposing truthful capability-only legacy OpenAI, Ollama, and Core speech
  routes without downloads, hidden provider selection, model authority, or
  fallback.
- Preserved the existing shared Blob/File STT and WAV TTS request shapes at the
  browser-provider boundary, with explicit decode/format errors and
  provider/model-owned TTS voice defaults.

## 0.2.1

- Added explicit selected-unloaded chat activation, truthful legacy Cloud/Core
  route readiness, and provider-native chat-response normalization without
  startup downloads, hidden provider selection, or application policy.
- Normalized shared STT/TTS requests at the browser-speech provider boundary
  while retaining caller-supplied immutable runtime, model, and voice
  authorities and fail-closed format, lifecycle, error, and cancellation rules.
- Applied authenticated dependency import maps to every packaged browser
  document and published a deterministic browser-readable runtime projection
  inventory derived from the verified package receipt.
- Added caller-budgeted complete DBOPFS source evaluation with deterministic
  zero-score fallback, independent scoring/excerpt/output bounds, and opt-in
  preserve-readable bootstrap/evaluation read coverage.
- Bound external workspace validation, packaging, scaffolding, doctor,
  toolchain, and development serving to one authenticated installed package,
  including the exact `arcane-sdk@npm:arcane-os@0.2.1` alias form.

## 0.2.0

- Made the SDK the canonical owner of the portable Arcane runtime and retired
  the Arcane OS-to-SDK overwrite direction while retaining legacy provenance in
  the authenticated runtime receipt.
- Added app-supplied monolithic or ordered multi-file GGUF catalogs, DBOPFS
  manifest-last admission, inherited per-check security policy, and measured
  per-model capability reports for the browser-WASM Wllama provider.
- Added independent browser Whisper STT and Kokoro TTS provider/Worker
  machinery with caller-supplied runtime/model authorities, explicit lifecycle,
  progress, cancellation, unload, and no fallback or packaged model bytes.
- Added schema-driven DBOPFS document bootstrap, minimal lexical retrieval and
  explicit request-context composition without automatic corpus searches.
- Added automatic persistent chat/history/memory composition, recurring model
  context, structural tool-call continuity, and session-only turns through
  `persist:false`.

## 0.1.0-dev.4

- Added the central `event-pubsub`-backed `EventManager` as the preferred SDK
  instrumentation route, with exact dependency pins, public package exports,
  and versioned `arcane-event-stack/1` JSON records.
- Added opt-in time-travel recording with UTC and monotonic time, nested
  causation, bounded snapshots and history, off-by-default sanitized source
  stacks, redaction, strict export/import, seek, abortable speed-controlled
  review playback, visible overflow, and explicit terminal outcomes.
- Added optional capture-phase DOM interaction and mutation observation across
  supported open shadow roots, with composed-event deduplication, sensitive
  input handling, and an explicit safe-review boundary that does not claim live
  DOM restoration or privileged-effect replay.
- Mirrored owned SDK operation-queue events through the central manager exactly
  once without weakening awaited delivery, backpressure, cancellation, or
  callback-failure ownership.
- Synchronized the browser runtime to Arcane OS `0.8.12` commit
  `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, including the shared network
  policy modules and policy data required by standalone applications.
- Added an explicit, main-checkout-only runtime synchronization tool and moved
  upstream runtime provenance into a reviewable source configuration.
- Added `security` to the external and integrated browser-runtime route contract.
- Made the project-local npm package the canonical SDK distribution and added a
  canonical manifest, checksum, SHA-256, and npm integrity contract for one
  exact packed tarball.
- Added build-once release readiness that runs the downloaded tarball through
  the installed Vanilla Test lifecycle and `npm exec --offline -- arcane` on
  Windows x64, Linux x64, and a real macOS arm64 runner at the declared Node
  `22.23.2` floor with a fresh per-job npm cache. Older Node 22 builds are not
  claimed because native Windows file-identity metadata is inconsistent there.
- Changed development publication to consume the immutable matrix-tested
  tarball instead of repacking source; the first npm publication remains an
  explicit 2FA bootstrap blocker before trusted publishing can be configured.
  Publication now requires an explicit standard-versus-dual-use policy decision,
  fails closed when staged dual-use publishing is required, serializes
  dispatches, rejects rollback and byte mismatches, and safely resumes through
  npm publish-time scanning without republishing an immutable version.

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
