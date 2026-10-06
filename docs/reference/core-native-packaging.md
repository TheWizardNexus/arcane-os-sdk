# Portable Core packaging

`arcane-os/native/portable-provider` owns the portable native payload in the SDK
package. It does not load Arcane OS source, choose models or compile an
executable. An application's explicit `native.localAI` selection can include
its selected upstream runtimes through the SDK local-AI installer. Without that
selection, assembly does no local-AI runtime preparation. Windows, Linux and macOS hosts may compose this
Node-based payload; Android needs its separate native host adaptation. The
current CLI's portable platform selections include Windows, Linux and macOS. A portable
artifact is not a Windows executable, Linux package or Android application.

`loadArcaneNativeProvider({target:'portable'})` selects the installed SDK provider
without an `arcaneRoot`. Supplying an explicit `arcaneRoot` retains the existing
checkout-provider route. The SDK also owns the `windows-x64` executable provider
described below. Other native targets remain with their actual platform
providers; the loader does not substitute this payload for an unavailable host.

## Provider and selected input

The default export and `arcaneNativeBuilderProvider` are the same provider.
`createPortableNativeProvider({services,packagedWeb=false,webKitDocumentLifecycle=false})` creates one with application-owned
service configuration. Without that override, the provider uses the selected
app descriptor's `native.services`, or an empty selection when omitted. An
explicit `services:[]` overrides the descriptor with no app services.
The Mac provider selects `packagedWeb:true` to compose the SDK's packaged-web
Core service and `webKitDocumentLifecycle:true` for the canonical classic-client
activation/replay contract. Both default to false, preserving ordinary portable
and Windows composition.
All implement `arcane-native-builder/1`:

- `describe()` identifies the portable target and `executable:false`.
- `doctor({targetRequest, signal, onEvent})` reports missing SDK Core source files.
- `prepare({targetRequest, signal, onEvent})` returns the selected SDK version and
  package root. Neither operation builds or imports application services.
- `build(request)` assembles one selected release and its explicit dependencies.
- `verify({artifact, targetRequest, signal, onEvent})` explicitly reads its semantic
  manifest and observes that the listed output files exist. It does not execute
  a host or establish native behavior. Build does not implicitly run verification.
- `run()` reports `ARCANE_NATIVE_RUN_UNSUPPORTED`; portable is not an executable.

Use the existing `createNativeBuildPlan()` / `executeNativeBuildPlan()` public
contract. Build receives `appDescriptor`, `appReleaseRoot`, `release`,
`readReleaseFile`, `dependencies`, `minimumCoreVersion`, `protectedRoots`,
`outputRoot`, `targetRequest`, `selectedSdk`, `signal` and `onEvent`. Dependencies provide their
`appId`, `releaseRoot`, `release` and `readReleaseFile`. The selected release's
`files` inventory is copied completely through its supplied reader. Direct
callers may supply the release root for ordinary file reads instead.

Both the current flat signing selection and the CLI's nested signing selection
are accepted by the planning boundary. Portable assembly adds no signing,
receipts, hashes, content limits or security policy. The package-relative source
root comes from the provider module's own location, not `toolchainRoot` or an
Arcane OS machine bundle.

## Native-only application resources

Select application service modules and their complete local source closure in
the authored schema-2 descriptor's `package.nativeResources`, separately from
its browser `include`/`exclude` selection:

```json
{
  "package": {
    "nativeResources": {
      "include": ["native", "src", "package.json"],
      "exclude": ["native/drafts"]
    }
  }
}
```

This is a descriptor excerpt for the app-owned service example below. The
projected schema-1 field is top-level `nativeResources`. Paths are literal and
app-relative; directories include descendants. Omission or an empty include
keeps previous selection and output behavior. The app supplies every required
source file explicitly; packaging does not discover or execute services.

Paired `buildApplication()` passes the actual native target to the selected app
and every explicitly bundled app. With a nonempty native include list, their
input releases use `dist/.native/<target>/<app-id>` instead of the saved browser
output, preserving existing browser/PWA artifacts. Each app's own selection is
applied; complete releases and actual roots are forwarded to the provider.
The provider then copies them unchanged into its artifact layout described below.

At the low-level `packageApp()` boundary, `target` defaults to `'browser'` and
is independent of `moduleFormat`. Nonbrowser selection disables generated PWA
content. Native-only files bypass browser document/module/asset transformations;
a file also in the ordinary browser selection retains that existing processing.
An explicit low-level `outputDirectory` still wins. Inspect the emitted input
with `verifyApp({workspaceRoot,appId,outputDirectory:release.output})`; neither
that inventory verification nor packaging launches the service or platform host.
See [the complete selection contract](protocols.md#native-only-application-resources).

## Output and host contract

Each build creates a fresh `arcane-portable-*` directory beneath `outputRoot`.
The result is `{app, target, manifest}`, with its actual directory at
`target.rootDir`. Existing artifacts are preserved. Cancellation or a failed
assembly removes only that build's newly created directory. Source/release roots
cannot be overwritten with generated output.

The selected app is copied unchanged under `app/`. Dependencies are copied
unchanged under `dependencies/<index>/`; the manifest relates each directory to
its actual app identifier and selected release. No HTML, payload, line ending,
application import, or base URL is rewritten by this provider. Dependency
navigation and service imports remain explicit host/application composition;
the payload does not invent cross-app routes.

`node_modules/arcane-os/` contains the SDK consumer source, runtime, schemas,
commands, package metadata and legal files. Its installed published runtime
dependency tree is included with licenses and actual nested dependency
resolution. The generated Core entry uses the ordinary public
`arcane-os/core/host` import. Application service modules can use those public
SDK exports through Node's normal package resolution. Existing app-owned
`node_modules` content remains authoritative where the selected app supplies it;
its own dependency completeness remains part of that app's selected release.
For the direct installed browser layout, the ordinary native selection also
supplies `selectedSdk:{packageRoot,packageSource}` from the application's actual
installed SDK. Assembly completes its browser-only package directory with
missing files and dependencies from that selected package, preserving every
selected file. It never fills an older projection with the builder's newer
package metadata. An already-supplied `package.json` remains app-owned, without
replacement or automatic completion. `manifest.appSdk` identifies this app
package separately from the builder SDK. Low-level callers composing services
with a partial direct SDK projection must supply the actual selected package
source; a file inventory alone does not identify its version or Node exports.
No dependency installer or package script runs. No OS model, Shell, Provisioner,
catalog, prompt, or native compiler is added.

The semantic `arcane-native.json` names the web root, selected start URL, Node
Core entry, classic client, dependencies and complete file inventory. A native
host must:

1. Mount `app/` at the root of its local application URL origin, preserving the
   selected start path and all navigable documents.
2. Inject `runtime/arcane-api.js` at document creation. It is produced by the
   canonical `createCoreClassicSource()` generator with `replayRuntimeState:true`.
   Once its transport listener is attached, each document requests the current
   Core and service state without starting services again.
3. Start `runtime/arcane-core.mjs` with the host's supported Node runtime and
   connect the existing framed stdin/stdout transport.
4. Close input and await Core's drain before terminating the child process.

The selected release must contain one shared `sdk/event-manager.mjs` path,
possibly nested under its SDK payload directory, or the direct installed
`node_modules/<package-or-alias>/browser-runtime/event-manager.mjs` path.
The classic client imports that
same owner with an origin-root URL, including on nested pages. It does not create
a second event implementation. A plain file-URL launch without this host mapping
is not the native serving contract. No host is launched during packaging.

## Explicit application services

For the ordinary SDK build command, select native service modules in the
application's authored descriptor. Include their source closure through
`package.nativeResources` as described above:

```json
{
  "native": {
    "services": [
      {"module":"native/moon-ledger.mjs", "options":{"ledgerName":"Cheese debts"}}
    ]
  }
}
```

Direct SDK compositions can instead pass that selection to the provider:

```js
import {createPortableNativeProvider} from 'arcane-os/native/portable-provider';

const nativeBuilder = createPortableNativeProvider({
    services: [{module:'native/moon-ledger.mjs', options:{ledgerName:'Cheese debts'}}]
});
```

Each module default-exports a synchronous factory returning the existing Core
service definition. Its first argument is the complete authored options record;
its second is the shared launch context described below. Options must be JSON-serializable data. Module imports
and factories run only when the generated Core entry is launched, never during
packaging. Put asynchronous initialization in `start()`, not a top-level await
or asynchronous factory, so unrelated services and dispatcher readiness remain
independent. Factories own product configuration and any service dependencies;
the packager does not discover, install or execute them.

```js
// native/moon-ledger.mjs, owned by the application
export default function createMoonLedger({ledgerName}) {
    return {
        name: 'moon-ledger',
        methods: {
            'moon.describe': function describeLedger() {
                return {name:ledgerName, message:'The cheese debts are astronomical.'};
            }
        }
    };
}
```

`startCoreHost({application, version, services, input, output, onError, signal})`
is also available directly from `arcane-os/core/host`. It returns the existing
stdio owner's `{runtime, closed, close}` without another lifecycle controller.
An optional abort signal invokes that same idempotent drain. Dispatcher readiness
does not wait for service/model readiness. Accepted `lifetime:'service'` work
survives renderer cancellation and is drained before shutdown. Errors remain
observable through `onError` and `closed`; no process is killed or forcibly exited.
See [the Core runtime contract](core-runtime.md) for request and service lifetime
details and [the client contract](core-client.md) for native bridge integration.

## Launch-time locations

The generated Core entry accepts `--arcane-launch-config <path>`. The public
`readCoreLaunchContext({argv=process.argv.slice(2)}={})` function in
`arcane-os/core/host` reads that explicitly selected JSON object. A native host
can separately supply `--arcane-host-state-root <directory>` for the reader's
`stateRoot` default. Every field in the explicit JSON object takes precedence
unchanged, including an explicitly present `stateRoot` with a relative, null or
other application-owned value. With neither argument the reader returns `{}`.
Missing files, missing argument values and malformed JSON report their actual
errors; the reader does not search for configuration, resolve or validate the
state directory, rewrite the file or change the process environment.

The generated entry supplies an artifact-derived `appRoot` and then applies the
complete explicit launch context. Every service factory receives that same
object as its second argument, preserving its authored first argument. A
launcher can supply the user's selected `workspaceRoot` and writable
`stateRoot` at launch instead of embedding this machine's paths in an app
package. The host owns those selections; the SDK does not choose a product's
workspace, namespace, saved preferences or models. JSON values and additional
application-owned fields remain unchanged, including an app-selected
`preferencesFile`. The state directory supplies no preference filename and
triggers no stored-data discovery or migration. Linux and other composing hosts
may pass the same separate argument; the reader chooses no platform directory.

## Selected local-AI runtimes

When `appDescriptor.native.localAI` is present, portable assembly calls the
SDK's `bundleLocalAIRuntimes()` owner with its `runtimes` selection and the
requested target platform/architecture. Its reusable installation directory is
`<outputRoot>/local-ai-runtimes`; each new payload receives the complete selected
runtime trees beneath `runtime/local-ai/`. Runtime preparation and app copying
proceed independently and both settle before assembly can clean up an incomplete
output. No application service or model executes during packaging.

`manifest.core.localAIRuntimes` records the bundled runtime locations relative
to the artifact root. Only the explicitly configured entry imports
`createLocalAIService` from `arcane-os/core/local-ai`. It resolves those bundled
locations against the installed artifact and supplies them in the launch
context's `runtimes` array, alongside `appRoot`, before applying explicit launch
configuration. It passes chat/ONNX requirements to that factory and routes
selected image requirements to their separate service as described below.
Applications without that selection have no generated local-AI import
or service. Availability of a particular engine belongs to the selected
local-AI installer and service; a generic ONNX runtime is not a speech model.

Selected `onnx` bundles its complete managed `onnxruntime-node` dependency tree.
Its `modulePath` resolves against the artifact root just as a server runtime's
`executable` does. Library/module records need no executable. The generated Core
service exposes retained worker sessions through `onnx.load/run/unload/status`;
model files remain caller-selected application resources. See
[native ONNX sessions](local-ai.md#native-onnx-sessions).

Selecting ONNX, image generation, or both composes one shared
`createModelAssetService` from `arcane-os/core/model-assets`. Native application
services obtain that same definition with `await context.getService('model-assets')`.
They obtain the selected local-AI owner with `await context.getService('local-ai')`
and its current native ONNX handle with `getONNXRuntime()`. These lookups await
only their selected service startup, independently of renderer readiness. See
[native service ownership and cleanup](local-ai.md#native-service-owners).

Selected `stable-diffusion.cpp` additionally composes `createLocalImageService`
from `arcane-os/core/image`. The image factory receives the full authored
selection plus that same model-assets instance.
Library, Koffi binding and variant paths resolve from the artifact root;
ordinary browser imports use `arcane-os/ai/core-image` and
`arcane-os/ai/core-model-assets` through the managed import map.

The runtime bundle preserves the complete selected native distribution and
binding tree. It does not load or download a model. Original model URL
descriptors remain available for preparation after launch; runtime-contained
model paths relocate with the artifact. An external native working path
reports its portability incompatibility. Supply those files through the
application's native resources or the shared
[stored-model projection](model-assets.md). Native use retains that projection
until actual unload or shutdown completes. See
[local image generation](local-image-generation.md) for selection, complete
results and CPU/Metal platform boundaries.

### Injected native speech engines

Selecting `whisper.cpp` in `native.localAI.runtimes` composes the SDK's retained
Whisper engine as STT in the shared speech service. Portable assembly retains
the selected helper, runtime variants and their libraries, FFmpeg decoder and
configured model files under the app's native runtime tree. The executable
host, helper, decoder and models remain separate files; selecting speech does
not embed them inside one application executable. Runtime paths relocate with
the payload. The default Windows x64 preparation uses the matching SDK release's
helper plus its MSVC/OpenMP redistributable closure. Other platforms require
their matching helper, runtime variants and decoder; the public helper builder
uses matching Whisper headers/libraries with the caller's native toolchain.
See [native Whisper preparation and packaging](local-whisper.md). Assembly is
distinct from execution on the target host.

An application-owned service factory can return
`createSpeechService({stt,tts,signal})` from `arcane-os/core/speech`, supplying
either role or both. Include that factory through the existing
`native.services` and `package.nativeResources` composition above. The host
constructs its selected engines; this shared service installs no engine,
downloads no model and selects no browser or native speech default.

Core starts both configured role loads independently and remains responsive.
`speech.status` and replaying service subscriptions report actual loaded-model
state separately for transcription and synthesis. Complete requests/results
are forwarded unchanged. Request cancellation reaches its engine independently
of the service lifetime; `close`/`drain` abort and join both engines and their
pending work. Engines must settle cancelled inference before Core reaches
service cleanup. See the [engine interface, progress and shutdown contract](native-speech.md).

## Windows executable

The ordinary application command is:

```sh
npm exec -- arcane build --target windows-x64
```

`loadArcaneNativeProvider({target:'windows-x64'})` selects the SDK's own
`arcane-os/native/windows-provider` without an OS checkout or `arcaneRoot`.
Its default export and `arcaneNativeBuilderProvider` are the same provider;
`createWindowsNativeProvider({services,hostDirectory})` permits explicit
same-project composition. Service selection follows the portable provider's
descriptor/override contract above.

The provider assembles the selected app with the precompiled host asset
`arcane-native-windows-x64.tar.gz` from the numeric GitHub release matching the
builder's installed SDK version. The asset contains the launcher, WebView2
support libraries, Node SEA Core executable and required license files. It does
not select the newest host independently of that package. Downloads occur only
during `build()`, use the caller's output directory, and are reused from
`<outputRoot>/.arcane-native-hosts/<sdk-version>/windows-x64`. The build machine
needs the standard `tar` command for extraction; application builds do not need
a C# compiler, system Node installation for the generated executable, or host
source scripts. The SDK build command itself still runs through the application's
normal Node/npm toolchain.

An explicit `hostDirectory` selects an already-built complete host tree instead
of downloading one. This is useful for SDK collaborators verifying the next
host output; downstream applications use the published package and matching
release asset. `doctor()` reports the selected prerequisites and missing files;
it does not download the host or probe the installed WebView runtime.

The assembled directory contains the app-named launcher, its matching
`.exe.config`, the unchanged `app/` payload, Core runtime and semantic
`arcane-native.json`. `manifest.host.executable` is the authoritative relative
launcher name for shortcuts and direct launch. Assembly uses
`appDescriptor.displayName` plus `.exe`, such as `Moon Cheese Hotline.exe`;
low-level compositions without a nonempty string display name use the app ID.
Windows-reserved filename characters and controls become underscores, and
reserved DOS device basenames receive an underscore prefix. Supported Unicode,
case and spaces remain; the original descriptor and title are unchanged.
The reusable host archive/cache retains `Arcane.exe` and `Arcane.exe.config`;
the internal `runtime/ArcaneCore.exe` also keeps its original name.

Launch the manifest-selected executable on Windows x64 with the Microsoft
Edge WebView2 Runtime installed. It opens the selected
app in WebView2 and owns its framed connection to the bundled Core process.
`verify()` observes the assembled files and manifest; it does not execute the
window or prove application behavior. `run()` reads the saved manifest and
launches that executable, so existing generic-name artifacts remain usable. It
observes complete diagnostics and exit. Cancelling that operation closes its
input, allowing the window and accepted Core service work to drain without a
forced process termination.

### Application icon and window colors

`appDescriptor.native.icon` selects the application's existing app-relative
image. Windows assembly converts PNG images, including a 512-pixel source,
into a derived `runtime/arcane-app.ico` with 16, 32, 48 and 256-pixel images.
Aspect ratio and transparency are preserved. An ICO selection keeps its
authored image set. The original application asset remains unchanged.

The provider embeds the selected images in the copied app-named executable and records
`manifest.host.icon` and `manifest.host.executableIcon:true`. It replaces the
executable's main icon group while preserving other groups, languages, resources
and file content. Conversion uses Node standard capabilities on every assembly
platform; it adds no application compiler, image library or Windows-only build
step. The selected host cache and Core executable remain unchanged.

JPEG/JPG, WebP and other existing descriptor formats retain ordinary assembly.
They currently report `native.icon.unsupported` through the builder's `onEvent`
callback, as does a selected executable whose PE layout cannot accommodate the
derived icon. The event identifies the app, icon, target, code and complete
message; `manifest.host.executableIcon:false` reports that the executable keeps
its prior icon. `host.icon` then points to the original selected image. This is
an explicit unsupported branding result, not a claim that a generic icon was
replaced. Unreadable files and malformed supported image data report their
ordinary filesystem or image-parser error.

The matching Windows launcher reads `host.icon` and loads it independently of
Core and page startup. ICO and standard Windows image codecs supply the window
and taskbar icon; JPEG/JPG can therefore work at runtime even while executable
embedding is unsupported. WebP is outside the host's standard image codecs;
runtime support is not promised. A runtime icon error preserves ordinary startup
and reaches complete developer diagnostics as `ARCANE_WINDOW_ICON_UNAVAILABLE`.
Hosts built before this option was introduced do not read the new icon field.

`Arcane.window.setTheme(presentation,{signal}?)` changes only the requesting
native window's chrome. The shared ThemeBootstrap supplies computed application
background and text colors without delaying application CSS or rendering.
Direct callers may supply `backgroundColor` and `textColor`, each either
`{red,green,blue,alpha}` or `null` to restore the platform default. RGB channels
are finite numbers from 0 through 255 and alpha is from 0 through 1. Omitted
fields remain unchanged. The complete presentation follows the existing Core
request transport; the window host handles `window.setTheme` before forwarding
other methods to Core. No system appearance setting changes.

Windows 11 build 22000 and later support titlebar background and text colors
through DWM. The normal titlebar and window controls remain in place. DWM accepts
opaque colors, so alpha values other than exactly 1 report that field as
unsupported. RGB values round to the nearest integer, with midpoint values
rounded upward. Older Windows versions report the requested fields unsupported.

The result is `{platform:'windows',supported,applied,unsupported}`. `applied`
contains only fields accepted during that call, including rounded channels or
`null` for a successful default reset. `supported` is true when at least one
field applied; `unsupported` lists requested fields the platform could not
apply. These results report platform acceptance rather than measured pixels.
An invalid argument uses `INVALID_ARGUMENT`; a platform API failure uses
`ARCANE_WINDOW_THEME_FAILED`, preserving complete native details and any
earlier changes in `error.details.applied` and `error.details.unsupported`.
The call is not atomic across fields. Existing request cancellation and document
lifetime semantics remain in effect; an already accepted native color change
is not rolled back by later cancellation. See [the Core client](core-client.md)
for the facade and browser behavior.

### Launch configuration

For explicit user-selected workspace/state locations, launch:

```sh
"Moon Cheese Hotline.exe" --arcane-launch-config path/to/launch.json
```

The complete JSON object reaches the service factories as their second
argument. A supplied `stateRoot` also owns the WebView2 profile and diagnostic
directory. Otherwise the launcher uses the current user's local application
data under `Arcane/<app-id>`. It forwards that actual host selection through
`--arcane-host-state-root`, so ordinary double-click startup supplies `stateRoot`
to every Core service factory. The complete explicit launch context still takes
precedence without rewriting its fields. The launcher does not invent an
application workspace. Relative launch-file paths resolve from the invocation's working
directory. `--close-on-stdin-eof` is an explicit process-owner option used by the
SDK runner; an ordinary double-clicked window closes through its own UI.

## Windows host source and selected output

The SDK's `src/core/hosts/windows/ArcaneCoreProcess.cs` owns an explicitly
selected executable, argument string and working directory. It reads complete
framed Core messages and diagnostics, acknowledges ordered asynchronous writes,
and closes stdin before awaiting accepted Core work, final output and process
exit. It does not kill the child on an ordinary close.

`ArcaneHost.cs` composes that process with a WebView2 window through
`ArcaneHost.Run(options,onDiagnostic,onError)` or `ArcaneHostForm`. Options
select the app root/start path, stable virtual HTTPS origin, profile directory,
title, optional `IconPath`, canonical classic-client source and Core process
inputs. The form exposes `Ready`, `Completion` and `CloseAsync()`. Page navigation, transport connection,
Core readiness and service readiness are separate states. Accepted work drains
before the window closes; complete engineering errors go to the supplied
diagnostic/error callbacks. Callbacks must not synchronously wait for the
window's lifetime promises.

`ArcaneLauncher.cs` supplies the executable entry point for that composition.
`tools/build-core-windows-host.mjs` builds the selected SDK host output from the
approved WebView2 package, existing .NET Framework compiler and selected Node
SEA output. It retains complete compiler diagnostics and produces a fresh
directory rather than overwriting an earlier artifact. The host requires
.NET Framework 4.6.2 or later. This is SDK release tooling, not an application
build requirement. Source compilation, selected host execution and real
application behavior are separate evidence boundaries; an assembled app is not
an installer or proof of its domain behavior.

Linux, macOS, Android dispatch and each platform's output verification retain
their separate delivery boundaries. Published
consumers must adopt the numeric package that includes this increment; a source
checkout or a successful source push is not that public package authority.

## macOS process source

`src/core/hosts/macos/ArcaneCoreProcess.h` and `.m` provide a Foundation-only
adapter for macOS 11 or later, compiled with Objective-C ARC and blocks. A
composing host explicitly supplies the executable URL, arguments, working
directory and delegate; startup is asynchronous. Delegate callbacks deliver
every raw stdout/stderr chunk and complete opaque framed JSON bodies, plus
launch, error, exit and final completion observations. Each stream and accepted
write retains its own order; UI dispatch belongs to the host. Callbacks must
return normally and must not wait for another callback or completion.

`sendJSONData:completion:error:` accepts an ordered write or reports a
synchronous rejection. Write completion means the frame reached stdin, not that
the RPC succeeded. `closeInput` rejects new sends, finishes accepted writes and
closes stdin, then keeps observing output and child exit without a forced
termination deadline. The delegate is retained through final completion.
The AppKit `ArcaneHost` and launcher compose that source as described below.
Compilation and execution on macOS remain separate evidence from the selected
Windows output.

## macOS application composition

`arcane-os/native/macos-provider` exports
`createMacOSNativeProvider({services,hostDirectory}={})`, its named
`arcaneNativeBuilderProvider`, and the same provider as default. The six-method
contract accepts `macos-arm64` or `macos-x64`, `platform:'macos'`, `format:'app'`
and the existing unsigned local development selection. Ordinary CLI routing
uses the SDK package, not an Arcane OS checkout:

```sh
npm exec -- arcane build --target macos-arm64
npm exec -- arcane run --target macos-arm64
```

Select `macos-x64` for Intel. The descriptor must declare the selected target.
Source implementation does not establish that an architecture's host artifact
has been built, executed or published. Consumer assembly needs the exact numeric
SDK release asset `arcane-native-macos-<architecture>.tar.gz`; unavailable assets
produce their actual download error. SDK collaborators may select an existing
`hostDirectory` explicitly. There is no fallback to source checkout, another
version, another architecture or a browser-only artifact.

The complete unchanged portable payload lives at
`<app-id>.app/Contents/Resources/`. That directory remains `target.rootDir` and
contains `arcane-native.json`, `app/`, dependency releases, installed SDK files,
Core entry/client and `runtime/node`. The additive `bundleRoot` identifies the
`.app` directory. `Contents/MacOS/Arcane` and `Contents/Info.plist` belong to the
bundle rather than the web root; the Mac owner checks these separately from the
Resources file inventory. Application identity supplies the stable bundle ID
`org.arcane.<app-id>`. Executable permissions are preserved for the launcher and
selected Node runtime.

The launcher opens its window immediately and starts one Core child. The
generated Core entry starts the `packaged-web` service alongside application
services, without waiting for models. Only `core.web.ready`, emitted after the
actual listener is ready and the initial port is saved, supplies the application
URL to WebKit. It serves the complete `manifest.webRoot` at `/` and resolves the
complete `manifest.start`, including query and fragment, against that origin.
The classic client selects current-document activation and sticky state replay;
navigation does not restart the Core service or replay retired requests.
The host's main-thread readonly `isClosing` accessor exposes its existing close
intent; an unsolicited Core exit is therefore reported separately from an
ordinary user-requested drain, even when the process exits successfully.

`createPackagedWebService({artifactRoot}, context={})` is available from
`arcane-os/core/packaged-web`. It uses the existing
`startDevServer({mode:'packaged',http:true,host:'127.0.0.1',port,releaseRoot})`
owner and published `node-http-server`, not a second HTTP implementation.
`context.stateRoot` takes precedence over the launcher's separate
`--arcane-host-state-root` argument. The launcher defaults to
`~/Library/Application Support/Arcane/<app-id>`; an explicitly supplied launch
file remains unchanged and is forwarded to Core. The shared launch reader also
supplies that host default to every application service factory, with explicit
launch fields taking precedence. The first successful listener
stores its selected port in `packaged-web-origin.json`. Later launches reuse it;
a port conflict or unreadable saved record is reported without changing origins
or discarding stored state.

The app's persistent default `WKWebsiteDataStore` uses its bundle identity.
`stateRoot` selects Core state and diagnostics, not a custom WebKit profile
directory. Browser API availability, OPFS and secure-context behavior remain
WebKit-owned and require actual Mac verification; the SDK bypasses no browser
policy. Startup failures use `core.service.state` for `name:'packaged-web'`;
unexpected listener closure or failure uses `core.web.failed` with the complete
serialized error. Native alerts show a concise outcome, with full diagnostics
outside the conversation. Core drains accepted work and the listener before
the native close completes. The optional runner stdin-EOF signal uses that same
path; ordinary double-click startup does not wait on stdin.

`tools/build-core-macos-host.mjs` is SDK host-release tooling, not an application
compiler requirement. It accepts an explicit Darwin Node executable and its
license, compiler path, `arm64` or `x64`, and output directory. It uses Objective-C
ARC/blocks and Apple's Foundation, AppKit and WebKit frameworks. The host source
targets macOS 11; the selected Node runtime may require a newer macOS version.
Its actual runtime/platform/architecture and the SDK Node engine requirement
must agree. Compiler/runtime execution and redistribution belong to the
separately authorized selected host output. This source increment runs none of
them and claims no Mac build or execution result.
