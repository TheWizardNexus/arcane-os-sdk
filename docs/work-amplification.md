# Work-amplification review

The default cardinality is:

```text
1 workspace x 1 app x 1 command x 1 target x 1 architecture x 1 format x 1 signing profile
```

There is no implicit all-app, all-target, or Android-flavor loop.

## Cold-path budget

- Scaffold: approximately 15-25 files, less than 100 KiB, target under one
  second before an optional dependency installation.
- Shared browser payload: the 144-file, approximately 3.1 MB runtime plus three
  SDK licensing files, verified once per exact SDK installation state.
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

Invariant work includes SDK/runtime resolution and the portable provider's 20
required Arcane toolchain inputs, snapshotted once per prepared toolchain state.
App source validation, tests, and release inventory are identity-bound once per
app state. Portable assembly is identity-bound once per requested target, and
final artifact verification consumes its one-shot receipt without repeating the
toolchain preparation. Compilation and signing for future executable targets
remain identity-bound once per requested target. Compatible file traversal may
be batched with bounded sequential streaming.

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
