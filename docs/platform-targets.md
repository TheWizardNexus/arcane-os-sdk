# Platform target contract

Every target adapter implements protocol `arcane-target-adapter/1` with these
named operations:

```text
describe -> doctor -> prepare -> plan -> build -> run
```

The available browser adapter plans from the selected workspace and schema-1
release manifest. The SDK also implements the process-local
`arcane-native-build-plan/1` and `arcane-native-builder/1` boundary for an
explicitly injected provider. It selects an app release and schema-2 descriptor,
toolchain, platform, architecture, format, signing mode, declared dependency
releases, and destination. Verification is a separate operation only when the
user explicitly selects it for the release artifact.

Native targets are available by explicitly pairing the SDK with fixed provider
modules in a compatible Arcane OS checkout. Every native request also requires
the canonical app descriptor to declare the exact target selected on the
command line. The SDK package does not silently search for a toolchain, infer a
descriptor target, embed the Arcane machine bundle, or substitute browser
output. For example:

```bash
# Choose one target when creating each app repository.
npx arcane-os@dev new my-app --path ./my-app --target portable --git
cd my-app
npm install
npm exec -- arcane native-doctor --target portable --arcane-root "../Arcane OS"
npm exec -- arcane build --target portable --arcane-root "../Arcane OS"

# In an app scaffolded with --target windows-x64:
npm exec -- arcane build --target windows-x64 --arcane-root "../Arcane OS"
npm exec -- arcane run --target windows-x64 --arcane-root "../Arcane OS"

# In an app scaffolded with --target linux-x64:
npm exec -- arcane build --target linux-x64 --arcane-root "../Arcane OS"
npm exec -- arcane run --target linux-x64 --arcane-root "../Arcane OS"

# In an app scaffolded with --target linux-arm64, on native ARM64 Linux:
npm exec -- arcane native-doctor --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test
npm exec -- arcane build --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test
npm exec -- arcane run --target linux-arm64 --arcane-root "../Arcane OS" --format deb --signing unsigned-local-test

# In an app scaffolded with --target android-arm64. The run command requires
# one connected physical Android device with native ARM64 support:
npm exec -- arcane native-doctor --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
npm exec -- arcane build --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
npm exec -- arcane run --target android-arm64 --arcane-root "../Arcane OS" --format apk --signing development
```

Every native scaffold also declares the browser target, so one repository can
use the normal browser development loop and its one selected native build. It
includes the raster icon required by the current native platform. Use the
matching scaffold target (`portable`, `windows-x64`, `linux-x64`, `linux-arm64`,
or `android-arm64`) before running the corresponding command.

`native-prepare` remains a standalone diagnostic. The normal build recipe omits
it and lets `build` prepare the selected toolchain state.

The portable output is an app-scoped Arcane Core directory. It is an explicit
portable builder payload, not an executable, and it has no direct run operation.
The external workspace defaults to `build/portable/`; integrated Arcane work
must use the same canonical checkout for `--workspace` and `--arcane-root`, and
must name an `--output-root` outside that checkout.

Compatibility uses the highest minimum Core version declared by the SDK runtime,
selected app, and bundled app dependencies, plus each app's Arcane protocol and
required features, capabilities, and methods. Newer Core versions are accepted
when those contracts remain available. See [compatibility.md](compatibility.md)
for the complete compatibility and breaking-change rule.

| Target | Formats | Development status |
|---|---|---|
| `browser` | `directory` | Available |
| `portable` | `portable` directory | Available with explicit `--arcane-root`; not executable |
| `windows-x64` | `exe` bundle | Available with explicit `--arcane-root`; unsigned local development only |
| `linux-x64` | `deb` | Available with explicit `--arcane-root`; unsigned local development only |
| `linux-arm64` | `deb` | Available with explicit `--arcane-root` on a compatible native ARM64 toolchain; unsigned local development only |
| `android-arm64` | `apk` | Available with explicit `--arcane-root`; development-signed, architecture-neutral, and physical/native ARM64 for run |

Every native target accepts one selected app release and its complete bundled
dependency closure through the provider boundary. The providers retain the
toolchain state required for build and, where supported, launch; app source and
workspace paths are not supplied to the provider. Linux run extracts to a
user-owned development tree without package installation or elevation.

Linux ARM64 uses the implemented Linux provider and is available only with a
compatible native ARM64 toolchain. The recorded target-scoped workflow built a
native ARM64 DEB, exercised the AArch64 host/Core/bridge, reached WebKit readiness,
and drained the owned process group. It loaded Ubuntu's packaged Bubblewrap
AppArmor profile while leaving the global user-namespace restriction enabled.
Android produces one development-signed APK with no native library or
ABI-specific payload. The APK is therefore architecture-neutral, while
`arcane run --target android-arm64` deliberately requires a physical device
with native ARM64 support. The recorded development path exercised physical
ARM64 build, readiness, cancellation, uninstall, and absence behavior. Both records
are development evidence, not production readiness.

Android AAB output, release signing, store publishing, and update continuity are
deferred. Windows and Linux production signing, installation, and update
acceptance also remain separate promotion work. The SDK never copies
proprietary application source into the Arcane checkout to bypass the boundary.
