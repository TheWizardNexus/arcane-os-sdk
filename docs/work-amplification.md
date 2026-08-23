# Work-amplification review

The default cardinality is:

```text
1 workspace x 1 app x 1 command x 1 target x 1 architecture x 1 format x 1 signing profile
```

There is no implicit all-app, all-target, or Android-flavor loop.
Selecting `android-arm64` produces exactly one architecture-neutral APK with no
native ABI fan-out. It does not build one artifact per ABI, an AAB, a release
signing variant, or a publication/update artifact. Every native invocation also
selects one explicit compatible `--arcane-root` and one app descriptor that
already declares that target; a target list never causes provider discovery or
additional builds.

The SDK repository test cardinality is:

```text
1 repository x 4 named sets x each assigned test file exactly once
```

Unit, functional, integration, and regression scripts form one validated,
non-overlapping inventory. The complete command adds three lightweight set
coordinator launches compared with the former single discovery pass, but it
does not repeat a test file, assertion, package installation, provider scan,
build, or fixture. Smaller nested `vanilla-test` cases reuse their parent
file's already-owned setup and cleanup boundary.

Shared/Core development has a separate integrated-only cardinality:

```text
1 integrated workspace x 1 fixed provider generation x 1 operation x 1 owned process tree
```

The focused-test operation selects exactly one repository-relative
`.test.mjs`; the development-check operation selects only Arcane's canonical
check. The 14,465-byte provider is read and hashed once for the process
generation, then its unchanged filesystem identity is checked without rereading
or rehashing its bytes around import and execution. Preparation reads Arcane's
10,270-byte package manifest once and launches one owned process tree. A focused
fixture completed in about 0.14 seconds on the development laptop; the canonical
check owns its nested npm/test process tree and intentionally costs the complete
Arcane development gate. Within one SDK process, one checkout admits only one
such process tree at a time, so concurrent requests fail busy instead of
multiplying that gate. Shared scope has no app, package, target, architecture,
format, or signing loop and does not produce app output.

## Cold-path budget

- Scaffold: approximately 15-25 files, less than 100 KiB, target under one
  second before an optional dependency installation.
- Shared browser payload: 152 files / 3,277,152 bytes, comprising the exact
  149-file / 3,238,186-byte dev.3 runtime receipt plus three SDK licensing files
  / 38,966 bytes, verified once per exact SDK installation state.
- Small browser package: app bytes plus the shared runtime, copied and inventoried
  once into an atomic staging directory.
- Portable build: one explicitly selected app and one host platform request. In
  a fresh packed-SDK external-repository run on Windows, the SDK's Arcane 0.8.11
  runtime produced a 153-file, 3,236,727-byte selected release against the newer
  compatible Arcane 0.8.12 toolchain. The verified portable result contained
  160 files and 4,570,320 bytes. The complete pack, install, Ollama doctor, app
  check, toolchain preparation, build, and verification sequence completed in
  approximately 9.2 seconds. This is development evidence, not a cross-machine
  performance guarantee.
- Shared native closure packaging: one retained shared-payload snapshot reads
  and hashes the current manifest-bound runtime and licensing inventory once. A
  two-app closure reuses that snapshot instead of repeating those source reads
  for each app; each distinct app release still writes and inventories its own
  output once.
- Windows x64 executable: one cold development request retained 2,530 toolchain
  files / 218,292,008 bytes once, compiled one 22-file / 60,488,912-byte
  external artifact, reused its verified receipt, reached authenticated host
  readiness, and cancelled the owned process tree in 11.8 seconds. The selected
  app release contained seven files, each read once.
- Linux x64 executable: one WSL development request produced one 23,577,108-byte
  amd64 DEB with 328 verified installed files / 82,783,539 uncompressed bytes.
  Toolchain preparation took 7.1 seconds, build plus verification took 15.7
  seconds, repeat verification reused the identical receipt in 0 ms, and the
  WSLg host ran for eight seconds before owned cancellation.
- Linux ARM64 executable: exact-SHA workflow run `31842361832` authenticated one
  seven-file / 5,143-byte release with seven provider reads and two retained
  browser-runtime source reads, each exactly once. It retained 2,461 toolchain
  files / 113,959,126 bytes, compiled a 149,720-byte AArch64 host and 71,240-byte
  AArch64 bridge, and built one retained-verified 21,232,932-byte ARM64 DEB.
  Preparation took 6,304 ms, build 16,868 ms, verification 447 ms, WebKit
  readiness 1,972 ms, and the complete build/readiness/cancellation lifecycle
  25,625 ms. The owned leader and process group were live at readiness and
  absent after cancellation. The workflow kept Ubuntu's AppArmor
  user-namespace restriction enabled while loading the packaged Bubblewrap
  profile. This is development evidence for source revision
  `4382043c09285ea203aa6daba1732660966ac409`, not Linux signing, installation,
  release, or promotion evidence.
- Android ARM64 application: one exact-SHA development request authenticated a
  five-file / 611-byte synthetic external release with five release reads,
  prepared one retained offline Gradle/toolchain closure in 159.4 seconds,
  built one 1,438,324-byte APK in 69.9 seconds, reused verification evidence in
  3 ms, and reached exact process/generation/nonce-bound content-and-bridge
  readiness on a physical ARM64/API 37 device in 4.5 seconds. The APK contained
  64 ZIP entries and zero native ABI entries. The 234.2-second total also proved
  owned cancellation, force-stop, uninstall, and post-run package absence. This
  is development evidence for source revision `be6732ab71cbecb43d037aaad994ade5f2f4d1b6`,
  not Android release, store, update, or promotion evidence.

Invariant work includes SDK/runtime resolution and each selected provider
generation, snapshotted once per prepared toolchain state. The portable
provider's 20 required Arcane toolchain inputs remain one such snapshot. App
source validation, tests, and release inventory are identity-bound once per app
state. Portable assembly, Windows/Linux compilation, and Android APK assembly
and development signing are identity-bound once per requested target. Final
artifact verification authenticates and reuses the retained receipt instead of
repeating toolchain preparation or final inventory work. Compatible file
traversal is batched with bounded sequential streaming.

Runtime verification binds version, source identity, inventory, and hashes. The
schema-1 app-release manifest binds its packaged inventory and content digest.
Because an ordinary filesystem tree can change after a process-local receipt is
issued, the browser consumer performs one bounded read/hash/post-identity check
for the exact response bytes before headers. That creates the response's
immutable state; it is not a second package-inventory pass. At most four files
of 64 MiB each can be active, and additional requests wait in a bounded queue.
Future reusable cross-process receipts must additionally bind and retain the
canonical location, filesystem identity, policy, toolchain, platform,
architecture, signer, and generation, and must be invalidated before mutation.
