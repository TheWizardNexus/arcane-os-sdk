# Platform target contract

Every target adapter implements protocol `arcane-target-adapter/1` with these
named operations:

```text
describe -> doctor -> plan -> build -> verify -> run
```

The protocol reserves plans that bind an immutable app-release receipt, app
descriptor and policy, SDK/toolchain, platform, architecture, format, signing
mode and identity, and destination. The available browser adapter currently
plans from the selected workspace and schema-1 release manifest. Native builds
must add retained-state receipt ownership before becoming available. Builds
write only to operation-owned staging; verification owns each target trust
decision, and activation must reuse that exact receipt.

| Target | Formats | Development status |
|---|---|---|
| `browser` | `directory` | Available |
| `portable` | `portable` | Deferred external Core/descriptor extraction |
| `windows-x64` | `exe` | Deferred external single-app native extraction |
| `linux-x64` | `appimage`, `deb`, `rpm` | Deferred single-app host and signing work |
| `linux-arm64` | `appimage`, `deb`, `rpm` | Deferred ARM64 host/toolchain work |
| `android-arm64` | `apk`, `aab` | Deferred single-app Gradle, bridge, and signing work |

The current Arcane OS repository already contains meaningful Windows, Linux,
and Android foundations. These entries are deferred because their current build
paths consume the central all-app registry and machine-bundle output tree; the
SDK will not copy proprietary application source into that checkout to bypass
the boundary.
