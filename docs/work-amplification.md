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
check. The provider and package manifest are each read once for the process
generation, and preparation launches one owned process tree. A focused fixture
completed in about 0.14 seconds on the development laptop; the canonical check
owns its nested npm/test process tree and performs the complete explicitly
selected check. Tests and checks run only when the user explicitly
selects them. Within one SDK process, one checkout admits only one
such process tree at a time, so concurrent requests fail busy instead of
multiplying that operation. Shared scope has no app, package, target, architecture,
format, or signing loop and does not produce app output.

## Cold-path shape

- Scaffold writes the selected template files once before any separately
  authorized dependency installation.
- Shared browser packaging copies the complete SDK runtime, browser runtime,
  and licensing content once for the selected app.
- Portable build selects one app and one host platform request.
- A bundled-app closure reuses one shared runtime selection rather than reading
  it again for every app; each app still writes its own complete output once.
- Windows, Linux, and Android each prepare one selected toolchain and produce
  one requested development artifact. They do not fan out across undeclared
  architectures, formats, or signing profiles.

Invariant work includes SDK/runtime resolution and each selected provider
generation, performed once per prepared toolchain state. App source discovery
and release inventory occur once per selected app state. Portable assembly,
Windows/Linux compilation, and Android APK assembly and development signing
occur once per requested target. Complete file traversal is streamed without
truncation, byte-count gates, byte identities, or hash-based admission.
