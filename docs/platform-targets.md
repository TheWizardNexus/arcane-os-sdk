# Platform target contract

Every target adapter implements protocol `arcane-target-adapter/1` with these
named operations:

```text
describe -> doctor -> prepare -> plan -> build -> verify -> run
```

The available browser adapter plans from the selected workspace and schema-1
release manifest. The SDK also implements the process-local
`arcane-native-build-plan/1` and `arcane-native-builder/1` boundary for an
explicitly injected provider. It binds an authenticated app release and
schema-2 descriptor, toolchain receipt, platform, architecture, format, signing
mode and identity, declared dependency releases, and destination. A paired
provider must verify the built artifact before build completion, and verify/run
reuse that exact artifact receipt.

Native targets are available by explicitly pairing the SDK with fixed provider
modules in a compatible Arcane OS checkout. The SDK package does not silently
search for a toolchain or embed the Arcane machine bundle. For example:

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
```

The portable scaffold also declares the browser target, so one repository can
use the normal browser development loop and the verified portable build. It
includes the raster icon required by current Arcane native admission.

`native-prepare` remains a standalone integrity diagnostic. A receipt cannot be
carried through a later CLI process, so the normal build recipe omits it and
lets `build` prepare and reuse one exact toolchain state.

The portable output is a verified app-scoped Arcane Core directory. It is an explicit
portable builder payload, not an executable, and it has no direct run operation.
The external workspace defaults to `build/portable/`; integrated Arcane work
must name an `--output-root` outside the Arcane checkout.

Compatibility uses the highest minimum Core version declared by the SDK runtime,
selected app, and bundled app dependencies, plus each app's Arcane protocol and
required features, capabilities, and methods. Newer Core versions are accepted
when those contracts remain available. See [compatibility.md](compatibility.md)
for the complete admission and breaking-change rule.

| Target | Formats | Development status |
|---|---|---|
| `browser` | `directory` | Available |
| `portable` | `portable` directory | Available with explicit `--arcane-root`; verified, not executable |
| `windows-x64` | `exe` bundle | Available with explicit `--arcane-root`; unsigned local development only |
| `linux-x64` | `deb` | Available with explicit `--arcane-root`; unsigned local development only |
| `linux-arm64` | `deb` | Deferred ARM64 host/toolchain evidence |
| `android-arm64` | `apk` | Deferred single-app Gradle, bridge, identity, and signing work |

Windows x64 and Linux x64 accept one verified app release and its exact bundled
dependency closure through the provider boundary. They retain the toolchain and
artifact authority required for same-process verification and launch; app
source and workspace paths are not supplied to the provider. The Linux run path
extracts to a user-owned development tree without package installation or
elevation. Windows and Linux production signing/install/update acceptance,
Linux ARM64, and Android remain separate work. The SDK never copies proprietary
application source into the Arcane checkout to bypass the boundary.
