# Platform target contract

Every target adapter implements protocol `arcane-target-adapter/1` with these
named operations:

```text
describe -> doctor -> plan -> build -> verify -> run
```

The available browser adapter plans from the selected workspace and schema-1
release manifest. The SDK also implements the process-local
`arcane-native-build-plan/1` and `arcane-native-builder/1` boundary for an
explicitly injected provider. It binds an authenticated app release and
schema-2 descriptor, toolchain receipt, platform, architecture, format, signing
mode and identity, declared dependency releases, and destination. A paired
provider must verify the built artifact before build completion, and verify/run
reuse that exact artifact receipt.

The npm package does not yet contain a real platform provider. Consequently the
default registry and CLI keep every native target deferred. Builds write only to
operation-owned staging; a future provider must retain immutable artifact state
before its target can become available.

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
