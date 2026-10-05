# Portable Core packaging

`arcane-os/native/portable-provider` owns the portable native payload in the SDK
package. It does not load Arcane OS source, choose models or compile an
executable. An application's explicit `native.localAI` selection can include
its selected upstream runtimes through the SDK local-AI installer. Without that
selection, assembly does no local-AI runtime preparation. Windows, Linux and macOS hosts may compose this
Node-based payload; Android needs its separate native host adaptation. The
current CLI's portable platform selections remain Windows and Linux. A portable
artifact is not a Windows executable, Linux package or Android application.

`loadArcaneNativeProvider({target:'portable'})` selects the installed SDK provider
without an `arcaneRoot`. Supplying an explicit `arcaneRoot` retains the existing
checkout-provider route. Other native targets remain with their actual platform
providers; the loader does not substitute this payload for an unavailable host.

## Provider and selected input

The default export and `arcaneNativeBuilderProvider` are the same provider.
`createPortableNativeProvider({services})` creates one with application-owned
service configuration. Without that override, the provider uses the selected
app descriptor's `native.services`, or an empty selection when omitted. An
explicit `services:[]` overrides the descriptor with no app services.
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
`arcane-os/core/host` reads that explicitly selected JSON object. Without the
flag it returns `{}`. Missing files, missing flag values and malformed JSON
report their actual errors; the reader does not search for configuration,
rewrite it or change the process environment.

The generated entry supplies an artifact-derived `appRoot` and then applies the
complete explicit launch context. Every service factory receives that same
object as its second argument, preserving its authored first argument. A
launcher can supply the user's selected `workspaceRoot` and writable
`stateRoot` at launch instead of embedding this machine's paths in an app
package. The host owns those selections; the SDK does not choose a product's
workspace, namespace, saved preferences or models. JSON values and additional
application-owned fields remain unchanged.

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
configuration. It passes the complete authored `native.localAI` record to the
factory. Applications without that selection have no generated local-AI import
or service. Availability of a particular engine belongs to the selected
local-AI installer and service; a generic ONNX runtime is not a speech model.

This source increment supplies portable assembly and service composition.
Desktop WebView executables, platform child-process ownership, Android dispatch
and executable build toolchains require their own completed adapters. Published
consumers must adopt the numeric package that includes this increment; a source
checkout or a successful source push is not that public package authority.
