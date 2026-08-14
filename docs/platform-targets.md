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

The `portable` target is available by explicitly pairing the SDK with the fixed
provider module in a compatible Arcane OS checkout. The SDK package does not
silently search for a toolchain or embed the Arcane machine bundle. From an
external workspace:

```bash
npx arcane-os@dev new my-app --path ./my-app --target portable --git
cd my-app
npm install
npm exec -- arcane native-doctor --target portable --arcane-root "../Arcane OS"
npm exec -- arcane build --target portable --arcane-root "../Arcane OS"
```

The portable scaffold also declares the browser target, so one repository can
use the normal browser development loop and the verified portable build. It
includes the raster icon required by current Arcane native admission.

`native-prepare` remains a standalone integrity diagnostic. A receipt cannot be
carried through a later CLI process, so the normal build recipe omits it and
lets `build` prepare and reuse one exact toolchain state.

The output is a verified app-scoped Arcane Core directory. It is an explicit
portable builder payload, not an executable, and it has no direct run operation.
The external workspace defaults to `build/portable/`; integrated Arcane work
must name an `--output-root` outside the Arcane checkout.

Compatibility uses the highest minimum Core version declared by the SDK runtime,
selected app, and bundled app dependencies, plus each app's Arcane protocol and
required features, capabilities, and methods. Newer Core versions are accepted
when those contracts remain available.

| Target | Formats | Development status |
|---|---|---|
| `browser` | `directory` | Available |
| `portable` | `portable` directory | Available with explicit `--arcane-root`; verified, not executable |
| `windows-x64` | `exe` | Deferred; secure transaction foundation is not yet bound to a fully retained Windows toolchain receipt |
| `linux-x64` | `appimage`, `deb`, `rpm` | Deferred single-app host and signing work |
| `linux-arm64` | `appimage`, `deb`, `rpm` | Deferred ARM64 host/toolchain work |
| `android-arm64` | `apk`, `aab` | Deferred single-app Gradle, bridge, and signing work |

The current Arcane OS repository already contains meaningful Windows, Linux,
and Android foundations. Those executable entries remain deferred until each
path accepts one verified app release through the provider boundary and retains
the exact toolchain and artifact authority it needs. The SDK will not copy
proprietary application source into that checkout to bypass the boundary.
