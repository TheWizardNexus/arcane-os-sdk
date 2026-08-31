# Arcane OS SDK JavaScript API

The npm package exposes a Node.js ESM control plane, the portable
`arcane-os/event-manager`, `arcane-os/mail`, `arcane-os/preference-store`, and
`arcane-os/speech-playback` entrypoints, and the browser-only
`arcane-os/ai/browser-wasm` and `arcane-os/ai/browser-speech` entrypoints.
Those package subpaths are distinct from application-facing projection modules
in the managed browser map, such as `arcane/AIProviderRuntime`,
`arcane/AIRuntimeState`, and `arcane/ThemeBootstrap`. Applications use those
mapped runtime modules and call `globalThis.Arcane` for capability-gated host
behavior; they are not additional `package.json#exports` entrypoints.

This page is the canonical inventory for every JavaScript name reachable through `package.json#exports`. The same binding can appear at the root and a focused subpath; those entrypoints are listed together. The root workspace `discoverApps` and the low-level packager `discoverApps` are intentionally separate records because they are different functions.

## Import map

This table is the Node `package.json#exports` map: it defines package
entrypoints for SDK/tooling code. It is distinct from the generated browser
import map that resolves application-facing `arcane/*` modules and the focused
EventManager entry. See [browser runtime delivery](protocols.md#browser-runtime-delivery)
for the installed-inventory-derived physical-runtime contract in SDK `0.3.4`.

| Specifier | Purpose |
| --- | --- |
| `arcane-os` | Complete high-level SDK surface. |
| `arcane-os/toolchain` | Headless application operations. |
| `arcane-os/events` | CLI/event reporter. |
| `arcane-os/testing` | Isolated test registration and execution. |
| `arcane-os/targets` | Target adapters and dispatch. |
| `arcane-os/native` | Native plan and builder protocol. |
| `arcane-os/native-provider` | Fixed native provider loaders. |
| `arcane-os/integrated-provider` | Fixed integrated shared-development provider. |
| `arcane-os/packager` | Low-level browser app packager. |
| `arcane-os/release-bundle` | Deterministic external release bundles. |
| `arcane-os/event-manager` | Central synchronous events, complete time-travel history, playback, and optional DOM instrumentation. |
| `arcane-os/preference-store` | Portable preference records and injected storage adapters. |
| `arcane-os/speech-playback` | Portable speech preparation, playback state, and injected media adapters. |
| `arcane-os/ai/browser-wasm` | Caller-selected browser-local Wllama inference, complete DBOPFS model storage, streaming, cancellation, and structural tool-call results. |
| `arcane-os/ai/browser-speech` | Caller-selected browser-local Whisper STT and Kokoro TTS provider mechanisms, ordinary upstream assets, materialized/native routing, Workers, and cancellation. |
| `arcane-os/mail` | Portable Mail runtime, durable outbox, complete transport responses, and provider-neutral acceptance contracts. |

Eight JSON schemas and `package.json` are data-only export subpaths. In Node ESM, import JSON with `with {type: 'json'}`, or resolve and read it explicitly.

## Shared operation contract

High-level operations accept one options object. Common fields are `workspaceRoot`, `appId`, `target`, `signal`, and `onEvent`; only fields meaningful to that operation are consumed. Long work acknowledges first, owns its child tasks, keeps event delivery ordered and backpressured, emits progress or heartbeats, observes cancellation where safe, and rejects with `ArcaneError` on failure.

One invocation selects one workspace, app, operation, target, architecture,
format, and output root. No API silently loops over all apps or targets.

Protocol mechanics are intentionally kept in the [deep protocol guide](protocols.md). The compact availability and normalization sentence beneath each member is the normal application-facing view.

## Canonical member inventory

The current JavaScript member total is derived mechanically from every `.mjs`
entrypoint in `package.json#exports`. Records are grouped by export name and
`Object.is()` binding identity, then retain the sorted entrypoints that expose
that binding; `memberCount` in
[`inventory/package-api.json`](inventory/package-api.json) is the resulting
graph-node count. The remaining data-only subpaths are eight JSON Schemas and
package metadata. Runtime projection modules in the managed
browser map are cataloged separately in [Runtime modules](runtime-modules.md).

| Member | Kind | Import | Group | Availability |
| --- | --- | --- | --- | --- |
| `APP_BUNDLE_DESCRIPTOR_NAME` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_EXTENSION` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_FORMAT` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_KIND` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_MANIFEST_NAME` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_RELEASE_PATH` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_SCHEMA_VERSION` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_SUPPORTED_SDK_VERSIONS` | constant | `arcane-os/release-bundle` | Packaging and release bundles | Node |
| `APP_CONFIG_NAME` | constant | `arcane-os/packager` | Packaging and release bundles | Node |
| `APP_DESCRIPTOR_NAME` | constant | `arcane-os` | Runtime and app descriptors | Node |
| `APP_DESCRIPTOR_SCHEMA_VERSION` | constant | `arcane-os` | Runtime and app descriptors | Node |
| `ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ARCANE_MACHINE_BUNDLE_VERSION` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ARCANE_NATIVE_PROVIDER_PATHS` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ARCANE_PORTABLE_PROVIDER_PATH` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ARCANE_PROTOCOL` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ARCANE_UPSTREAM_REPOSITORY` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ArcaneError` | class | `arcane-os` | Errors | Node |
| `adaptV1LlmProvider()` | function | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Browser; the wrapped provider retains its own WebGPU, storage, model, and lifecycle requirements |
| `assertIntegratedNativeToolchain()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assertIntegratedPortableToolchain()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assessArcaneOllama()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node; Microsoft NT managed-service assessment |
| `buildApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `buildTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL` | constant | `arcane-os/ai/browser-speech` | Browser speech providers | Browser metadata; graph construction starts no fetch, cache, Worker, provider, or event operation |
| `BROWSER_SPEECH_ARTIFACT_PROTOCOL` | constant | `arcane-os/ai/browser-speech` | Browser speech providers | Browser metadata; model/runtime use requires caller-selected sources plus the selected DBOPFS, Web Locks, and Worker capabilities |
| `BROWSER_WASM_RUNTIME_AUTHORITY` | constant | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Browser metadata; no model or DBOPFS required to inspect |
| `bumpVersion()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `bundleApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `checkApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `CLI_EVENT_PROTOCOL` | constant | `arcane-os` | Identity and protocol constants | Node |
| `CLI_NAME` | constant | `arcane-os` | Identity and protocol constants | Node |
| `completeValueText()` | function | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Compatible JavaScript module host; no browser capability required |
| `createApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `createArcaneAI()` | function | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Browser; compatible LLM provider or controller required |
| `createAppReleaseBundle()` | function | `arcane-os` | Packaging and release bundles | Node |
| `createBrowserKokoroProvider()` | function | `arcane-os/ai/browser-speech` | Browser speech providers | Browser with Workers, object URLs, caller-selected Kokoro runtime/model artifacts, and an SDK DBOPFS speech store |
| `createBrowserModelSource()` | function | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Browser Fetch with a readable response body |
| `createBrowserSpeechArtifactGraph()` | function | `arcane-os/ai/browser-speech` | Browser speech providers | Browser metadata; construction starts no fetch, cache, Worker, provider, or event operation |
| `createBrowserSpeechAuthority()` | function | `arcane-os/ai/browser-speech` | Browser speech providers | Browser descriptor construction; use requires the selected storage and provider Web APIs |
| `createBrowserWasmLlmProvider()` | function | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Browser context with WebAssembly, OPFS/DBOPFS, and WebGPU; no CPU fallback |
| `createBrowserWhisperProvider()` | function | `arcane-os/ai/browser-speech` | Browser speech providers | Browser with Workers, object URLs, caller-selected Whisper runtime/model artifacts, and an SDK DBOPFS speech store |
| `createCanonicalUstarHeader()` | function | `arcane-os` | Packaging and release bundles | Node |
| `createDbopfsModelStore()` | function | `arcane-os/ai/browser-wasm` | Browser-WASM local AI | Browser with a ready DBOPFS instance and OPFS |
| `createDbopfsSpeechArtifactStore()` | function | `arcane-os/ai/browser-speech` | Browser speech providers | Browser with ready DBOPFS, Web Locks, Fetch, File/Blob, and object URLs |
| `createNativeBuildPlan()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `createNativeTargetAdapter()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `createReporter()` | function | `arcane-os` | Events, processes, and testing | Node |
| `createToolchain()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `createWorkspace()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `default()` | function | `arcane-os/testing` | Events, processes, and testing | Node |
| `DEFAULT_TEST_TIMEOUT_MS` | constant | `arcane-os` | Events, processes, and testing | Node |
| `describeTargets()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `developApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `discoverPackagerApps()` | function | `arcane-os` | Packaging and release bundles | Node |
| `doctorApplication()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `doctorNativeTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ERROR_CODES` | constant | `arcane-os` | Errors | Node |
| `errorRecord()` | function | `arcane-os` | Errors | Node |
| `executeNativeBuildPlan()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `executeOperation()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `fail()` | function | `arcane-os` | Errors | Node |
| `getSdkBrowserRuntimeRoot()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `getSdkRoot()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `getTargetAdapter()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `incrementSemver()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `initializeApplication()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `initWorkspace()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `inspectApp()` | function | `arcane-os` | Packaging and release bundles | Node |
| `inspectWorkspaceProfile()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `INTEGRATED_TOOLCHAIN_PROTOCOL` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `listRuntimeFiles()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `listSdkBrowserRuntimeFiles()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `listTargets()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadAppDescriptor()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `loadArcaneIntegratedProvider()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadArcaneNativeProvider()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadArcanePortableProvider()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadRuntimeRelease()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `loadSdkBrowserRuntimeRelease()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `materializeInstalledSdkRuntime()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `materializeWorkspaceRuntime()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `materializeWorkspaceRuntimeContent()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `NATIVE_BUILD_PLAN_PROTOCOL` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `NATIVE_BUILDER_PROTOCOL` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `normalizeError()` | function | `arcane-os` | Errors | Node |
| `normalizeRelativePath()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `OUTPUT_MODES` | constant | `arcane-os` | Identity and protocol constants | Node |
| `packageApp()` | function | `arcane-os` | Packaging and release bundles | Node |
| `packageApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `PACKAGER_VERSION` | constant | `arcane-os/packager` | Packaging and release bundles | Node |
| `packager.discoverApps()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `parseSemver()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `planApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `prepareNativeTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `PreferenceStore default export` | class | `arcane-os/preference-store` | Portable runtime modules | Node with injected adapters, or browser/native WebView storage |
| `PREFERENCE_STORE_ERROR_CODES` | constant | `arcane-os/preference-store` | Portable runtime modules | Node and browser |
| `PREFERENCE_STORE_EVENT_TYPES` | constant | `arcane-os/preference-store` | Portable runtime modules | Node and browser |
| `Preference` | class | `arcane-os/preference-store` | Portable runtime modules | Node and browser |
| `preferenceSchema()` | function | `arcane-os/preference-store` | Portable runtime modules | Node and browser |
| `projectNativeDescriptor()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `projectPackageManifest()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `readRuntimeFile()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `readSdkBrowserRuntimeFile()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `registeredTestCount()` | function | `arcane-os` | Events, processes, and testing | Node |
| `RELEASE_MANIFEST_NAME` | constant | `arcane-os/packager` | Packaging and release bundles | Node |
| `repositoryApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `repositoryPull()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node; network-assisted Git |
| `repositoryPush()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node; network-assisted Git |
| `repositoryStatus()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `resolveNativeBuildOutputRoot()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `resolvePortableBuildOutputRoot()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `resolveWorkspace()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `ROOT_CONFIG_NAME` | constant | `arcane-os/packager` | Packaging and release bundles | Node |
| `discoverApps()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `runApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `runDoctor()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `runProcess()` | function | `arcane-os` | Events, processes, and testing | Node |
| `runRegisteredTests()` | function | `arcane-os` | Events, processes, and testing | Node |
| `runRepositoryAction()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `runTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `RUNTIME_ROOT` | constant | `arcane-os` | Identity and protocol constants | Node |
| `SDK_NAME` | constant | `arcane-os` | Identity and protocol constants | Node |
| `SDK_ROOT` | constant | `arcane-os` | Identity and protocol constants | Node |
| `SDK_VERSION` | constant | `arcane-os` | Identity and protocol constants | Node |
| `selectApp()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `SpeechPlayback default export` | class | `arcane-os/speech-playback` | Portable runtime modules | Node with injected media adapters, or browser/native WebView media |
| `SPEECH_PLAYBACK_STATE_EVENT` | constant | `arcane-os/speech-playback` | Portable runtime modules | Node and browser |
| `SPEECH_VOICE_ALIASES` | constant | `arcane-os/speech-playback` | Portable runtime modules | Node and browser |
| `SPEECH_VOICE_OPTIONS` | constant | `arcane-os/speech-playback` | Portable runtime modules | Node and browser |
| `SpeechPlayback` | class | `arcane-os/speech-playback` | Portable runtime modules | Node with injected media adapters, or browser/native WebView media |
| `splitSpeechText()` | function | `arcane-os/speech-playback` | Portable runtime modules | Node and browser |
| `startDevServer()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node control plane; browser data plane |
| `startSourceExampleServer()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node control plane; browser data plane |
| `TARGET_ADAPTER_PROTOCOL` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `TARGET_IDS` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `test()` | function | `arcane-os` | Events, processes, and testing | Node |
| `testApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `throwIfAborted()` | function | `arcane-os` | Errors | Node |
| `upgradeApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `validateAppBundlePath()` | function | `arcane-os` | Packaging and release bundles | Node |
| `validateAppConfig()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `validateAppDescriptor()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `validateNativeBuilder()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `validateRootConfig()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `validateWorkspace()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `verifyApp()` | function | `arcane-os` | Packaging and release bundles | Node |
| `verifyApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `verifyAppReleaseBundle()` | function | `arcane-os` | Packaging and release bundles | Node |
| `verifyBundleApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `verifyNativeArtifact()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `verifyTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `SDK_UPDATE_REGISTRY` | constant | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `SDK_UPDATE_TIMEOUT_MS` | constant | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `checkForSdkUpdate()` | function | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `checkSdkUpdate()` | function | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `compareSdkVersions()` | function | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `updateTagForVersion()` | function | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `validateUpdateRegistry()` | function | `arcane-os` | Explicit SDK update checks | Node; on-demand CLI or maintainer check only |
| `ARCANE_EVENT_AUTHORITY_BRAND` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_AUTHORITY_KIND` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_AUTHORITY_PROTOCOL` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_ERROR_CODES` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_LISTENER_ERROR_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_OCCURRENCE_PROTOCOL` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_SOURCE_DISPOSED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_SOURCE_KIND` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_SOURCE_PROTOCOL` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `ARCANE_EVENT_STACK_PROTOCOL` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `DEFAULT_DOM_EVENT_TYPES` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler; meaningful to browser DOM instrumentation |
| `DOM_INTERACTION_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host; constant imports in Node |
| `DOM_MUTATION_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host; constant imports in Node |
| `DOM_OBSERVATION_STARTED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host; constant imports in Node |
| `DOM_OBSERVATION_STOPPED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host; constant imports in Node |
| `EventManager` | class | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler; DOM capture requires a compatible DOM |
| `PLAYBACK_CANCELLED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `PLAYBACK_COMPLETED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `PLAYBACK_FAILED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `PLAYBACK_RECORD_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `PLAYBACK_STARTED_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `TIME_TRAVEL_SEEK_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `arcaneEvents` | singleton | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler; DOM capture requires a compatible DOM |
| `createArcaneEventSource()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `createDOMInstrumentation()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host |
| `createEventManager()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler; DOM capture requires a compatible DOM |
| `describeDOMTarget()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or DOM-compatible objects; importable in Node |
| `domSelector()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or DOM-compatible objects; importable in Node |
| `isArcaneEventOccurrence()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `parseEventStack()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `projectArcaneDOMEvent()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host |
| `DEFAULT_MAIL_REQUEST_TIMEOUT_MS` | constant | `arcane-os/mail` | Portable Mail | Node and browser with Fetch and AbortController for transport use |
| `MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS` | constant | `arcane-os/mail` | Portable Mail | Node and browser metadata |
| `MAIL_OUTBOX_PROTOCOL` | constant | `arcane-os/mail` | Portable Mail | Node and browser metadata |
| `MAIL_OUTBOX_STATES` | constant | `arcane-os/mail` | Portable Mail | Node and browser metadata |
| `MAIL_OUTBOX_TABLE` | constant | `arcane-os/mail` | Portable Mail | Node and browser metadata |
| `Mail` | class | `arcane-os/mail` | Portable Mail | Node with injected host adapters, or browser/native WebView with durable storage and Web Locks |
| `MailOutbox` | class | `arcane-os/mail` | Portable Mail | Node or browser with injected DBOPFS-compatible storage and a Web Locks-compatible lock manager |
| `MailTransportError` | class | `arcane-os/mail` | Portable Mail | Node and browser |
| `createMailOutbox()` | function | `arcane-os/mail` | Portable Mail | Node or browser with the required injected outbox adapters |
| `Mail default export` | class | `arcane-os/mail` | Portable Mail | Node with injected host adapters, or browser/native WebView with durable storage and Web Locks |
| `normalizeMailEndpoint()` | function | `arcane-os/mail` | Portable Mail | Node and browser with URL support; relative endpoints require an explicit or global base URL |
| `resolveMailConfig()` | function | `arcane-os/mail` | Portable Mail | Node with explicit configuration, or browser/native WebView with optional document and location defaults |
| `sendMailReport()` | function | `arcane-os/mail` | Portable Mail | Node and browser with Fetch and AbortController, or an explicit fetch implementation |
| `serializeMailReport()` | function | `arcane-os/mail` | Portable Mail | Node and browser |

# Packaging and release bundles

## APP_BUNDLE_DESCRIPTOR_NAME

### Overview

Canonical descriptor filename stored in an external application release bundle.

### Value and import

```text
const APP_BUNDLE_DESCRIPTOR_NAME
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_DESCRIPTOR_NAME} from 'arcane-os';

console.log(APP_BUNDLE_DESCRIPTOR_NAME);
```

## APP_BUNDLE_EXTENSION

### Overview

Required filename extension for deterministic external application release bundles.

### Value and import

```text
const APP_BUNDLE_EXTENSION
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_EXTENSION} from 'arcane-os';

console.log(APP_BUNDLE_EXTENSION);
```

## APP_BUNDLE_FORMAT

### Overview

Canonical archive encoding used by external application release bundles.

### Value and import

```text
const APP_BUNDLE_FORMAT
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_FORMAT} from 'arcane-os';

console.log(APP_BUNDLE_FORMAT);
```

## APP_BUNDLE_KIND

### Overview

Stable manifest kind identifying an Arcane application release bundle.

### Value and import

```text
const APP_BUNDLE_KIND
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_KIND} from 'arcane-os';

console.log(APP_BUNDLE_KIND);
```

## APP_BUNDLE_MANIFEST_NAME

### Overview

Canonical bundle-envelope manifest filename.

### Value and import

```text
const APP_BUNDLE_MANIFEST_NAME
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_MANIFEST_NAME} from 'arcane-os';

console.log(APP_BUNDLE_MANIFEST_NAME);
```

## APP_BUNDLE_RELEASE_PATH

### Overview

Canonical path of the packaged release manifest inside a bundle payload.

### Value and import

```text
const APP_BUNDLE_RELEASE_PATH
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_RELEASE_PATH} from 'arcane-os';

console.log(APP_BUNDLE_RELEASE_PATH);
```

## APP_BUNDLE_SCHEMA_VERSION

### Overview

Current immutable bundle-envelope schema version.

### Value and import

```text
const APP_BUNDLE_SCHEMA_VERSION
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_SCHEMA_VERSION} from 'arcane-os';

console.log(APP_BUNDLE_SCHEMA_VERSION);
```

## APP_BUNDLE_SUPPORTED_SDK_VERSIONS

### Overview

Exact SDK generations accepted by this bundle verifier.

### Value and import

```text
const APP_BUNDLE_SUPPORTED_SDK_VERSIONS
```

Import it from `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_SUPPORTED_SDK_VERSIONS} from 'arcane-os/release-bundle';

console.log(APP_BUNDLE_SUPPORTED_SDK_VERSIONS);
```

## APP_CONFIG_NAME

### Overview

Canonical schema-1 application package configuration filename used by the packager.

### Value and import

```text
const APP_CONFIG_NAME
```

Import it from `arcane-os/packager`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_CONFIG_NAME} from 'arcane-os/packager';

console.log(APP_CONFIG_NAME);
```

## bumpVersion()

### Overview

Updates the authored `arcane-package.json` version for one selected application.
This is a development-time metadata operation. It never updates the Arcane SDK,
the synchronized runtime, an installed application, or an Arcane OS host.

### Signature, parameters, and result

```text
async bumpVersion(options)
```

Import it from `arcane-os/packager`. `options.workspaceRoot` and `options.appId`
select one configured app. Supply exactly one of `bump` (`"major"`, `"minor"`,
`"patch"`, or `"prerelease"`) and `exactVersion`; `preid` customizes a
prerelease bump and defaults to `"rc"`. `dryRun` defaults to `false`.

The promise resolves to
`{app, currentVersion, version, bump, dryRun}`. `bump` is `null` when an exact
version was selected. A dry run validates and calculates the result without
writing or acquiring the operation lock. A non-dry run acquires the selected
app's packager lock under `dist/`, then atomically replaces only its
`arcane-package.json` version through temporary and backup files.

This function has no `signal`, `onEvent`, or receipt parameter: once started it
has no public cancellation or progress-event contract. It rejects invalid or
unchanged versions, conflicting `bump`/`exactVersion` inputs, an invalid
workspace/app, an active or stale packager lock, and filesystem failures. The
lock is released in `finally`; an unrecoverable replacement failure can leave
the documented backup file for manual recovery.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {bumpVersion} from 'arcane-os/packager';

async function previewNextPrerelease(workspaceRoot) {
    const result = await bumpVersion({
        workspaceRoot,
        appId: 'example-app',
        bump: 'prerelease',
        preid: 'beta',
        dryRun: true
    });

    console.log(`${result.currentVersion} -> ${result.version}`);
    return result;
}
```

## createAppReleaseBundle()

### Overview

Writes one deterministic USTAR+gzip external application bundle from the selected authored release state.

### Signature and result

```text
async createAppReleaseBundle({ receipt, releaseRoot, outputPath, overwrite=false, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {createAppReleaseBundle} from 'arcane-os';

async function usecreateAppReleaseBundle(...arguments_) {
    return createAppReleaseBundle(...arguments_);
}
```

## createCanonicalUstarHeader()

### Overview

Builds the exact 512-byte canonical USTAR header for one validated bundle entry.

### Signature and result

```text
createCanonicalUstarHeader(entryPath, size)
```

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {createCanonicalUstarHeader} from 'arcane-os';

async function usecreateCanonicalUstarHeader(...arguments_) {
    return createCanonicalUstarHeader(...arguments_);
}
```

## discoverPackagerApps()

### Overview

Root-entry alias for the packager-specific application discovery function.

### Signature and result

```text
async discoverPackagerApps({workspaceRoot:requestedWorkspaceRoot})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {discoverPackagerApps} from 'arcane-os';

async function usediscoverPackagerApps(...arguments_) {
    return discoverPackagerApps(...arguments_);
}
```

## incrementSemver()

### Overview

Returns a validated semantic version incremented by the requested bump and optional prerelease id.

### Signature and result

```text
incrementSemver(value, bump, preid)
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {incrementSemver} from 'arcane-os/packager';

console.log(incrementSemver('1.2.3', 'minor'));
```

## inspectApp()

### Overview

Loads one validated packager app plan, including the shared directly navigable
descriptor-selected browser document inventory.

### Signature and result

```text
async inspectApp({workspaceRoot, appId, signal}={})
```

Import it from `arcane-os` or `arcane-os/packager`. The result includes the
configured `entry`, `include`, and `exclude` values plus `browserDocuments`, the
entry-first ordered `.html`/`.htm` paths selected by the same package traversal
used by import-map refresh and packaging. Current pages declare exactly one
matching `meta[name="arcane-app-id"]`; unmarked pages with an active `base`
remain selected for patch compatibility. Included HTML with neither signal is
retained as a package fragment rather than rewritten as a document.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {inspectApp} from 'arcane-os';

const plan=await inspectApp({workspaceRoot:process.cwd(),appId:'hello-world'});
console.log(plan.browserDocuments);
```

## normalizeRelativePath()

### Overview

Normalizes one portable repository-relative path and rejects traversal, aliases, links, and unsafe names.

### Signature and result

```text
normalizeRelativePath(value, label='path')
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {normalizeRelativePath} from 'arcane-os/packager';

console.log(normalizeRelativePath('apps/example/index.html'));
```

## packageApp()

### Overview

Builds one complete browser application release through the low-level packager
API. It does not run tests or checks automatically; verification occurs only
when explicitly requested or when required for this selected release output.

### Signature and result

```text
async packageApp(options)
```

Import it from `arcane-os` or `arcane-os/packager`. Packaging refreshes the
managed map once and preserves the complete selected source and browser
document inventory. It rejects malformed configuration, descriptors,
and the malformed selected release archive while preserving the previously
selected output on failure. Each selected browser document receives the same
deterministic map. The package root also contains the public
`ARCANE_RUNTIME_PROJECTION.json` inventory:

```javascript
{
  schemaVersion: 1,
  kind: 'arcane-app-runtime-projection',
  sdkVersion: '0.3.4',
  pathPrefix: 'arcane/',
  files: [{path}]
}
```

The projection is an inventory, not an ordinary execution gate. Malformed or
internally inconsistent selected projection data rejects with
`ARCANE_RUNTIME_PROJECTION_INVALID`.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {packageApp} from 'arcane-os';

const packaged = await packageApp({
    workspaceRoot: process.cwd(),
    appId: 'hello-world'
});

console.log(packaged.importMap.documentPaths);
```

## PACKAGER_VERSION

### Overview

Builder identity written into schema-1 application release manifests.

### Value and import

```text
const PACKAGER_VERSION
```

Import it from `arcane-os/packager`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {PACKAGER_VERSION} from 'arcane-os/packager';

console.log(PACKAGER_VERSION);
```

## packager.discoverApps()

### Overview

Discovers packager application configurations and release boundaries beneath one workspace root.

### Signature and result

```text
async discoverApps({workspaceRoot:requestedWorkspaceRoot})
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {discoverApps} from 'arcane-os/packager';

async function usediscoverApps(...arguments_) {
    return discoverApps(...arguments_);
}
```

## parseSemver()

### Overview

Parses one strict three-part semantic version with optional prerelease metadata.

### Signature and result

```text
parseSemver(value)
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {parseSemver} from 'arcane-os/packager';

console.log(parseSemver('1.2.3'));
```

## RELEASE_MANIFEST_NAME

### Overview

Canonical packaged application release manifest filename.

### Value and import

```text
const RELEASE_MANIFEST_NAME
```

Import it from `arcane-os/packager`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {RELEASE_MANIFEST_NAME} from 'arcane-os/packager';

console.log(RELEASE_MANIFEST_NAME);
```

## ROOT_CONFIG_NAME

### Overview

Canonical root packager configuration filename.

### Value and import

```text
const ROOT_CONFIG_NAME
```

Import it from `arcane-os/packager`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {ROOT_CONFIG_NAME} from 'arcane-os/packager';

console.log(ROOT_CONFIG_NAME);
```

## validateAppBundlePath()

### Overview

Validates and normalizes one portable path selected inside an external app bundle.

### Signature and result

```text
validateAppBundlePath(value, label='bundle path')
```

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {validateAppBundlePath} from 'arcane-os';

console.log(validateAppBundlePath('payload/apps/example/index.html'));
```

## validateAppConfig()

### Overview

Validates one schema-1 packager app configuration and its relationship to the root config.

### Signature and result

```text
validateAppConfig(value, appId, rootConfig, configPath=`apps/${appId}/${APP_CONFIG_NAME}`)
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {validateAppConfig} from 'arcane-os/packager';

async function usevalidateAppConfig(...arguments_) {
    return validateAppConfig(...arguments_);
}
```

## validateRootConfig()

### Overview

Validates one root packager mapping and its fixed shared-route boundaries.

### Signature and result

```text
validateRootConfig(value, configPath=ROOT_CONFIG_NAME)
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {validateRootConfig} from 'arcane-os/packager';

async function usevalidateRootConfig(...arguments_) {
    return validateRootConfig(...arguments_);
}
```

## verifyApp()

### Overview

Authenticates one existing browser app release through the low-level packager API.

### Signature and result

```text
async verifyApp({workspaceRoot, appId, signal, onEvent})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {verifyApp} from 'arcane-os';

async function useverifyApp(...arguments_) {
    return verifyApp(...arguments_);
}
```

## verifyAppReleaseBundle()

### Overview

Parses and authenticates one deterministic app bundle without extraction.

### Signature and result

```text
async verifyAppReleaseBundle({bundlePath, signal, onEvent}={})
```

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** Normalized SDK validation with complete canonical archive and release content. Deep protocol: [SDK packager and deterministic bundle contract](protocols.md).

### Example

```javascript
import {verifyAppReleaseBundle} from 'arcane-os';

async function useverifyAppReleaseBundle(...arguments_) {
    return verifyAppReleaseBundle(...arguments_);
}
```


# Runtime and app descriptors

## APP_DESCRIPTOR_NAME

### Overview

Canonical schema-2 application descriptor filename.

### Value and import

```text
const APP_DESCRIPTOR_NAME
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {APP_DESCRIPTOR_NAME} from 'arcane-os';

console.log(APP_DESCRIPTOR_NAME);
```

## APP_DESCRIPTOR_SCHEMA_VERSION

### Overview

Current authored application descriptor schema version.

### Value and import

```text
const APP_DESCRIPTOR_SCHEMA_VERSION
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {APP_DESCRIPTOR_SCHEMA_VERSION} from 'arcane-os';

console.log(APP_DESCRIPTOR_SCHEMA_VERSION);
```

## getSdkBrowserRuntimeRoot()

### Overview

Returns the absolute SDK browser-runtime root selected by the installed package.

### Signature and result

```text
getSdkBrowserRuntimeRoot()
```

Import it from `arcane-os`. The return value is the default root accepted by the
browser-runtime inventory and reader functions.

### Availability and normalization

**Node.** Returns one absolute directory path. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {getSdkBrowserRuntimeRoot} from 'arcane-os';

console.log(getSdkBrowserRuntimeRoot());
```

## getSdkRoot()

### Overview

Returns the absolute installed SDK package root.

### Signature and result

```text
getSdkRoot()
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {getSdkRoot} from 'arcane-os';

console.log(getSdkRoot());
```

## loadAppDescriptor()

### Overview

Loads an authored schema-2 descriptor or a complete legacy projection with its source label.

### Signature and result

```text
async loadAppDescriptor({workspaceRoot, appRoot, appId, packageManifest})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {loadAppDescriptor} from 'arcane-os';

async function useloadAppDescriptor(...arguments_) {
    return loadAppDescriptor(...arguments_);
}
```

## listRuntimeFiles()

### Overview

Lists every regular file beneath one selected SDK runtime root as an ordered,
slash-normalized relative path.

### Signature and result

```text
async listRuntimeFiles({runtimeRoot=path.join(sdkRoot, 'runtime'),signal}={})
```

The function traverses the selected directory, observes `signal`, and returns
the complete sorted path list.

### Availability and normalization

**Node.** Complete relative-path inventory. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {listRuntimeFiles} from 'arcane-os';

const files=await listRuntimeFiles();
```

## listSdkBrowserRuntimeFiles()

### Overview

Lists every regular file beneath one selected SDK browser-runtime root as an
ordered, slash-normalized relative path.

### Signature and result

```text
async listSdkBrowserRuntimeFiles({browserRuntimeRoot=defaultRoot,signal}={})
```

The function traverses the selected directory, observes `signal`, and returns
the complete sorted path list.

### Availability and normalization

**Node.** Complete relative-path inventory. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {listSdkBrowserRuntimeFiles} from 'arcane-os';

const files=await listSdkBrowserRuntimeFiles();
```

## loadRuntimeRelease()

### Overview

Returns the selected runtime root, SDK version, and complete current file
inventory derived directly from that directory.

### Signature and result

```text
async loadRuntimeRelease({runtimeRoot=path.join(sdkRoot, 'runtime'),signal}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {loadRuntimeRelease} from 'arcane-os';

async function useloadRuntimeRelease(...arguments_) {
    return loadRuntimeRelease(...arguments_);
}
```

## loadSdkBrowserRuntimeRelease()

### Overview

Returns the selected browser-runtime root, SDK version, and complete current
file inventory derived directly from that directory.

### Signature and result

```text
async loadSdkBrowserRuntimeRelease({browserRuntimeRoot=defaultRoot,signal}={})
```

Import it from `arcane-os`. The mutable result contains `sdkVersion`,
`browserRuntimeRoot`, and ordered `files`.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {loadSdkBrowserRuntimeRelease} from 'arcane-os';

const release=await loadSdkBrowserRuntimeRelease();
```

## materializeInstalledSdkRuntime()

### Overview

Materializes the complete installed SDK runtime and browser-runtime content.
After full runtime replacement, it writes or replaces semantic
`arcane.lock.json` from the actual installed dependency name, package name,
package version, alias source, and projected roots.

### Signature and result

```text
async materializeInstalledSdkRuntime({workspaceRoot,sdkPackageSource,workspaceOperationLease,signal,onEvent}={})
```

Import it through the exact dependency key declared by the workspace: normally
`arcane-os`, or the alias name such as `arcane-sdk` when the declaration is
`npm:arcane-os@<version>`. It resolves that declaration under the shared
workspace-operation lock and replaces the complete projection by staged
whole-tree replacement. The mutable result includes the installed-package
location, materialized workspace runtime paths, and `workspaceLock` path and
document. It does not install dependencies or merge application source.

Replacement removes files absent from the selected runtime content and restores
the prior tree if commit fails. `signal` and
`onEvent` remain caller-owned before commit. Once the atomic replacement starts,
it completes replacement or rollback without observing cancellation or invoking
callbacks.

### Availability and normalization

**Node.** Complete installed runtime content and a mutable materialization result. Deep protocol: [Installed SDK runtime materialization](protocols.md#installed-sdk-runtime-materialization).

### Example

```javascript
import {materializeInstalledSdkRuntime} from 'arcane-os';
// If package.json declares the SDK under the arcane-sdk alias, import from
// 'arcane-sdk' instead.

const result=await materializeInstalledSdkRuntime({workspaceRoot});
```

## materializeWorkspaceRuntime()

### Overview

Compatibility alias for `materializeWorkspaceRuntimeContent()`.

### Signature and result

```text
async materializeWorkspaceRuntime(options={})
```

Import it from `arcane-os`. It forwards the complete options record and returns
the same materialization result.

### Availability and normalization

**Node.** Complete workspace runtime content. Deep protocol: [Installed SDK runtime materialization](protocols.md#installed-sdk-runtime-materialization).

### Example

```javascript
import {materializeWorkspaceRuntime} from 'arcane-os';

const result=await materializeWorkspaceRuntime({workspaceRoot});
```

## materializeWorkspaceRuntimeContent()

### Overview

Replaces one workspace's complete projected runtime and browser-runtime content
from selected source roots. It does not resolve a package declaration or write
the installed-package lock document owned by `materializeInstalledSdkRuntime()`.

### Signature and result

```text
async materializeWorkspaceRuntimeContent({workspaceRoot,runtimeRoot=path.join(getSdkRoot(), 'runtime'),browserRuntimeRoot=getSdkBrowserRuntimeRoot(),signal,onEvent}={})
```

The operation stages the complete projection, replaces the prior tree at the
commit boundary, restores it if commit fails, and removes paths absent from the
selected sources.

### Availability and normalization

**Node.** Complete workspace runtime content and a mutable materialization result. Deep protocol: [Installed SDK runtime materialization](protocols.md#installed-sdk-runtime-materialization).

### Example

```javascript
import {materializeWorkspaceRuntimeContent} from 'arcane-os';

const result=await materializeWorkspaceRuntimeContent({workspaceRoot});
```

## PreferenceStore default export

### Overview

Default binding for the canonical PreferenceStore runtime class. The static
specifier `arcane-os/preference-store` works in Node package consumers and is
mapped to the same runtime module in managed browsers; legacy browser code may
continue using `arcane/PreferenceStore`.

### Signature and result

```text
default class PreferenceStore extends EventTarget
```

### Availability and normalization

**Node with injected adapters, or browser/native WebView storage.** The package
subpath and managed browser key both resolve directly to the canonical runtime
module. Deep protocol: [Browser runtime delivery](protocols.md#browser-runtime-delivery).

### Example

```javascript
import PreferenceStore from 'arcane-os/preference-store';
const store=new PreferenceStore({schema,adapter});
```

## PREFERENCE_STORE_ERROR_CODES

### Overview

Frozen stable error-code vocabulary emitted by PreferenceStore.

### Signature and result

```text
const PREFERENCE_STORE_ERROR_CODES
```

### Availability and normalization

**Node and browser.** Exact immutable values from the canonical runtime module.

### Example

```javascript
import {PREFERENCE_STORE_ERROR_CODES} from 'arcane-os/preference-store';
console.log(PREFERENCE_STORE_ERROR_CODES.disposed);
```

## PREFERENCE_STORE_EVENT_TYPES

### Overview

Frozen semantic event names published by PreferenceStore.

### Signature and result

```text
const PREFERENCE_STORE_EVENT_TYPES
```

### Availability and normalization

**Node and browser.** Exact load, change, and reset names from the canonical runtime.

### Example

```javascript
import {PREFERENCE_STORE_EVENT_TYPES} from 'arcane-os/preference-store';
console.log(PREFERENCE_STORE_EVENT_TYPES.change);
```

## Preference

### Overview

Canonical Preference entity re-exported with the store namespace.

### Signature and result

```text
new Preference(data={})
```

### Availability and normalization

**Node and browser.** Entity validation and serialization remain owned by the
canonical runtime entity.

### Example

```javascript
import {Preference} from 'arcane-os/preference-store';
const record=new Preference({key:'theme',value:'system'});
```

## preferenceSchema()

### Overview

Builds the canonical Preference strong-type schema for a supplied definition set.

### Signature and result

```text
preferenceSchema(definitions=[])
```

### Availability and normalization

**Node and browser.** Returns the canonical runtime schema for the supplied definitions.

### Example

```javascript
import {preferenceSchema} from 'arcane-os/preference-store';
const schema=preferenceSchema([]);
```

## SpeechPlayback default export

### Overview

Default binding for the canonical SpeechPlayback runtime class. The static
specifier `arcane-os/speech-playback` works in Node package consumers and maps
to the same runtime module in managed browsers; `arcane/SpeechPlayback` remains
the legacy browser-compatible name.

### Signature and result

```text
default class SpeechPlayback
```

### Availability and normalization

**Node with injected media adapters, or browser/native WebView media.** The
package subpath and managed browser key both resolve directly to the canonical
runtime module; provider and media availability remain host-owned.

### Example

```javascript
import SpeechPlayback from 'arcane-os/speech-playback';
const playback=new SpeechPlayback({audio,speech});
```

## SPEECH_PLAYBACK_STATE_EVENT

### Overview

Canonical semantic event name for SpeechPlayback state transitions.

### Signature and result

```text
const SPEECH_PLAYBACK_STATE_EVENT
```

### Availability and normalization

**Node and browser.** Exact immutable `speech-playback-state` name.

### Example

```javascript
import {SPEECH_PLAYBACK_STATE_EVENT} from 'arcane-os/speech-playback';
console.log(SPEECH_PLAYBACK_STATE_EVENT);
```

## SPEECH_VOICE_ALIASES

### Overview

Read-only compatibility aliases for canonical speech voice identifiers.

### Signature and result

```text
const SPEECH_VOICE_ALIASES
```

### Availability and normalization

**Node and browser.** Provides read-only membership without mutable Set authority.

### Example

```javascript
import {SPEECH_VOICE_ALIASES} from 'arcane-os/speech-playback';
console.log(SPEECH_VOICE_ALIASES.has('default'));
```

## SPEECH_VOICE_OPTIONS

### Overview

Frozen provider-neutral voice option records exposed to shared UI.

### Signature and result

```text
const SPEECH_VOICE_OPTIONS
```

### Availability and normalization

**Node and browser.** Frozen ordered value/label records from the canonical runtime.

### Example

```javascript
import {SPEECH_VOICE_OPTIONS} from 'arcane-os/speech-playback';
console.log(SPEECH_VOICE_OPTIONS[0]);
```

## SpeechPlayback

### Overview

Named binding for the same canonical class exposed as the speech-playback default. `prepare()` preserves each nonblank part's exact input string without trimming, splitting, or freezing that content.

### Signature and result

```text
new SpeechPlayback(options={})
```

### Availability and normalization

**Node with injected media adapters, or browser/native WebView media.** Binding
identity equals the default export; provider and media availability remain host-owned.

### Example

```javascript
import SpeechPlayback,{SpeechPlayback as NamedSpeechPlayback} from 'arcane-os/speech-playback';
console.log(SpeechPlayback===NamedSpeechPlayback);
```

## splitSpeechText()

### Overview

Returns the caller's exact nonblank speech text as one segment.

### Signature and result

```text
splitSpeechText(value='')
```

### Availability and normalization

**Node and browser.** Uses trimming only to detect blank input. A nonblank value is returned with its exact whitespace and content intact in one mutable array; it is not trimmed, split, or frozen. Blank or whitespace-only input returns an empty array.

### Example

```javascript
import {splitSpeechText} from 'arcane-os/speech-playback';
console.log(splitSpeechText('Hello world.'));
```

## projectNativeDescriptor()

### Overview

Projects the canonical app descriptor into the native registry shape consumed by paired builders.

### Signature and result

```text
projectNativeDescriptor(descriptor, {source}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {projectNativeDescriptor} from 'arcane-os';

async function useprojectNativeDescriptor(...arguments_) {
    return projectNativeDescriptor(...arguments_);
}
```

## projectPackageManifest()

### Overview

Projects a schema-2 descriptor into the compatible schema-1 application package contract.

### Signature and result

```text
projectPackageManifest(descriptor)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {projectPackageManifest} from 'arcane-os';

async function useprojectPackageManifest(...arguments_) {
    return projectPackageManifest(...arguments_);
}
```

## readRuntimeFile()

### Overview

Reads one complete contained file from a selected SDK runtime root.

### Signature and result

```text
async readRuntimeFile({runtimeRoot=path.join(sdkRoot, 'runtime'),relativePath,signal}={})
```

The relative path must identify a regular file contained by the selected root.
The result is the complete file `Buffer`.

### Availability and normalization

**Node.** Contained runtime file access with cancellation. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {readRuntimeFile} from 'arcane-os';

const content=await readRuntimeFile({relativePath:'arcane/modules/AI.js'});
```

## readSdkBrowserRuntimeFile()

### Overview

Reads one complete contained file from a selected SDK browser-runtime root.

### Signature and result

```text
async readSdkBrowserRuntimeFile({browserRuntimeRoot=defaultRoot,relativePath,signal}={})
```

The relative path must identify a regular file contained by the selected root.
The result is the complete file `Buffer`.

### Availability and normalization

**Node.** Contained browser-runtime file access with cancellation. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {readSdkBrowserRuntimeFile} from 'arcane-os';

const content=await readSdkBrowserRuntimeFile({relativePath:'ai/browser-wasm.mjs'});
```

## validateAppDescriptor()

### Overview

Strictly validates and freezes one schema-2 app descriptor, including runtime-only cross-field rules.

### Signature and result

```text
validateAppDescriptor(value, {appId}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {validateAppDescriptor} from 'arcane-os';

async function usevalidateAppDescriptor(...arguments_) {
    return validateAppDescriptor(...arguments_);
}
```

# Targets, native plans, and providers

## ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH

### Overview

Frozen repository-relative path of Arcane OS's integrated shared-development provider.

### Value and import

```text
const ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH
```

Import it from `arcane-os` or `arcane-os/integrated-provider`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH} from 'arcane-os';

console.log(ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH);
```

## ARCANE_NATIVE_PROVIDER_PATHS

### Overview

Frozen target-to-provider path registry for native development providers.

### Value and import

```text
const ARCANE_NATIVE_PROVIDER_PATHS
```

Import it from `arcane-os` or `arcane-os/native-provider`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {ARCANE_NATIVE_PROVIDER_PATHS} from 'arcane-os';

console.log(ARCANE_NATIVE_PROVIDER_PATHS);
```

## ARCANE_PORTABLE_PROVIDER_PATH

### Overview

Compatibility alias for the portable provider path.

### Value and import

```text
const ARCANE_PORTABLE_PROVIDER_PATH
```

Import it from `arcane-os` or `arcane-os/native-provider`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {ARCANE_PORTABLE_PROVIDER_PATH} from 'arcane-os';

console.log(ARCANE_PORTABLE_PROVIDER_PATH);
```

## assertIntegratedNativeToolchain()

### Overview

Requires an integrated workspace and selected native toolchain root to resolve to the same canonical Arcane checkout.

### Signature and result

```text
assertIntegratedNativeToolchain({workspaceMode, workspaceRoot, toolchainRoot, target}={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {assertIntegratedNativeToolchain} from 'arcane-os';

async function useassertIntegratedNativeToolchain(...arguments_) {
    return assertIntegratedNativeToolchain(...arguments_);
}
```

## assertIntegratedPortableToolchain()

### Overview

Portable-target compatibility wrapper for the integrated native checkout assertion.

### Signature and result

```text
assertIntegratedPortableToolchain(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {assertIntegratedPortableToolchain} from 'arcane-os';

async function useassertIntegratedPortableToolchain(...arguments_) {
    return assertIntegratedPortableToolchain(...arguments_);
}
```

## buildTarget()

### Overview

Invokes one target adapter build with explicit app, target, and artifact inputs.

### Signature and result

```text
async buildTarget(options={})
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {buildTarget} from 'arcane-os';

async function usebuildTarget(...arguments_) {
    return buildTarget(...arguments_);
}
```

## createNativeBuildPlan()

### Overview

Creates one immutable, authenticated, single-attempt native plan binding app, dependencies, toolchain, request, and output roots.

### Signature and result

```text
async createNativeBuildPlan({ nativeBuilder, toolchainRoot, toolchainReceipt, appReleaseRoot, appReleaseReceipt, appDescriptor, dependencyReleases=[], providerGeneration, minimumCoreVersion, protectedRoots=[], outputRoot, targetRequest, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {createNativeBuildPlan} from 'arcane-os';

async function usecreateNativeBuildPlan(...arguments_) {
    return createNativeBuildPlan(...arguments_);
}
```

## createNativeTargetAdapter()

### Overview

Adapts one validated native builder to the common target-adapter contract.

### Signature and result

```text
createNativeTargetAdapter({targetId, nativeBuilder}={})
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {createNativeTargetAdapter} from 'arcane-os';

async function usecreateNativeTargetAdapter(...arguments_) {
    return createNativeTargetAdapter(...arguments_);
}
```

## doctorNativeTarget()

### Overview

Loads and diagnoses one explicit native provider and target without building an application.

### Signature and result

```text
async doctorNativeTarget(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {doctorNativeTarget} from 'arcane-os';

async function usedoctorNativeTarget(...arguments_) {
    return doctorNativeTarget(...arguments_);
}
```

## executeNativeBuildPlan()

### Overview

Consumes one authenticated single-attempt native plan through its bound builder and event/cancellation lifecycle.

### Signature and result

```text
async executeNativeBuildPlan(plan, { expectedNativeBuilder, expectedTarget, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {executeNativeBuildPlan} from 'arcane-os';

async function useexecuteNativeBuildPlan(...arguments_) {
    return executeNativeBuildPlan(...arguments_);
}
```

## getTargetAdapter()

### Overview

Returns the registered adapter for one exact target id or fails for an unknown target.

### Signature and result

```text
getTargetAdapter(targetId)
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {getTargetAdapter} from 'arcane-os';

async function usegetTargetAdapter(...arguments_) {
    return getTargetAdapter(...arguments_);
}
```

## INTEGRATED_TOOLCHAIN_PROTOCOL

### Overview

Protocol required from the fixed integrated shared-development provider.

### Value and import

```text
const INTEGRATED_TOOLCHAIN_PROTOCOL
```

Import it from `arcane-os` or `arcane-os/integrated-provider`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {INTEGRATED_TOOLCHAIN_PROTOCOL} from 'arcane-os';

console.log(INTEGRATED_TOOLCHAIN_PROTOCOL);
```

## listTargets()

### Overview

Returns the frozen target descriptors without running an operation lifecycle.

### Signature and result

```text
listTargets()
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {listTargets} from 'arcane-os';

console.table(listTargets());
```

## loadArcaneIntegratedProvider()

### Overview

Loads and authenticates the fixed Arcane-owned integrated development provider generation.

### Signature and result

```text
loadArcaneIntegratedProvider({ arcaneRoot, signal, onEvent, run=runProcess }={})
```

Import it from `arcane-os` or `arcane-os/integrated-provider`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {loadArcaneIntegratedProvider} from 'arcane-os';

async function useloadArcaneIntegratedProvider(...arguments_) {
    return loadArcaneIntegratedProvider(...arguments_);
}
```

## loadArcaneNativeProvider()

### Overview

Loads the fixed provider for one target from an explicitly selected Arcane OS
checkout and authenticates that provider generation for the current SDK process.

### Signature and result

```text
loadArcaneNativeProvider({ arcaneRoot, target, inspect=lstat, canonicalize=realpath, readModule=readFile, importModule=specifier=>import(specifier), generationCache=providerGenerationCache, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/native-provider`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {loadArcaneNativeProvider} from 'arcane-os';

async function useloadArcaneNativeProvider(...arguments_) {
    return loadArcaneNativeProvider(...arguments_);
}
```

## loadArcanePortableProvider()

### Overview

Compatibility wrapper that loads the portable native provider.

### Signature and result

```text
loadArcanePortableProvider(options={})
```

Import it from `arcane-os` or `arcane-os/native-provider`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {loadArcanePortableProvider} from 'arcane-os';

async function useloadArcanePortableProvider(...arguments_) {
    return loadArcanePortableProvider(...arguments_);
}
```

## NATIVE_BUILD_PLAN_PROTOCOL

### Overview

Protocol identifier for immutable authenticated native build plans.

### Value and import

```text
const NATIVE_BUILD_PLAN_PROTOCOL
```

Import it from `arcane-os` or `arcane-os/native`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {NATIVE_BUILD_PLAN_PROTOCOL} from 'arcane-os';

console.log(NATIVE_BUILD_PLAN_PROTOCOL);
```

## NATIVE_BUILDER_PROTOCOL

### Overview

Protocol identifier required from injected native builders.

### Value and import

```text
const NATIVE_BUILDER_PROTOCOL
```

Import it from `arcane-os` or `arcane-os/native`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {NATIVE_BUILDER_PROTOCOL} from 'arcane-os';

console.log(NATIVE_BUILDER_PROTOCOL);
```

## prepareNativeTarget()

### Overview

Runs one provider toolchain preparation and returns its process-owned result.

### Signature and result

```text
async prepareNativeTarget(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {prepareNativeTarget} from 'arcane-os';

async function useprepareNativeTarget(...arguments_) {
    return prepareNativeTarget(...arguments_);
}
```

## resolveNativeBuildOutputRoot()

### Overview

Resolves and validates one native output root, including integrated-checkout non-overlap.

### Signature and result

```text
resolveNativeBuildOutputRoot({target, workspaceMode, workspaceRoot, outputRoot}={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {resolveNativeBuildOutputRoot} from 'arcane-os';

async function useresolveNativeBuildOutputRoot(...arguments_) {
    return resolveNativeBuildOutputRoot(...arguments_);
}
```

## resolvePortableBuildOutputRoot()

### Overview

Portable-target compatibility wrapper for native output-root resolution.

### Signature and result

```text
resolvePortableBuildOutputRoot(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {resolvePortableBuildOutputRoot} from 'arcane-os';

async function useresolvePortableBuildOutputRoot(...arguments_) {
    return resolvePortableBuildOutputRoot(...arguments_);
}
```

## runTarget()

### Overview

Invokes one target adapter run method and fails honestly when the artifact kind is not runnable.

### Signature and result

```text
async runTarget(options={})
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {runTarget} from 'arcane-os';

async function userunTarget(...arguments_) {
    return runTarget(...arguments_);
}
```

## TARGET_ADAPTER_PROTOCOL

### Overview

Protocol required from target adapter descriptors and implementations.

### Value and import

```text
const TARGET_ADAPTER_PROTOCOL
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {TARGET_ADAPTER_PROTOCOL} from 'arcane-os';

console.log(TARGET_ADAPTER_PROTOCOL);
```

## TARGET_IDS

### Overview

Frozen list of currently exposed target identifiers.

### Value and import

```text
const TARGET_IDS
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Exact immutable SDK value. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {TARGET_IDS} from 'arcane-os';

console.log(TARGET_IDS);
```

## validateNativeBuilder()

### Overview

Validates a native builder's protocol and required describe/doctor/prepare/build/verify/run methods.

### Signature and result

```text
validateNativeBuilder(provider)
```

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {validateNativeBuilder} from 'arcane-os';

async function usevalidateNativeBuilder(...arguments_) {
    return validateNativeBuilder(...arguments_);
}
```

## verifyNativeArtifact()

### Overview

Explicitly verifies one selected target artifact through the prepared provider and toolchain state.

### Signature and result

```text
async verifyNativeArtifact(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {verifyNativeArtifact} from 'arcane-os';

async function useverifyNativeArtifact(...arguments_) {
    return verifyNativeArtifact(...arguments_);
}
```

## verifyTarget()

### Overview

Invokes one target adapter's artifact verification boundary.

### Signature and result

```text
async verifyTarget(options={})
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized complete plan and result; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {verifyTarget} from 'arcane-os';

async function useverifyTarget(...arguments_) {
    return verifyTarget(...arguments_);
}
```


# Identity and protocol constants

## ARCANE_MACHINE_BUNDLE_VERSION

### Overview

Exact Arcane machine-bundle generation paired with this SDK runtime.

### Value and import

```text
const ARCANE_MACHINE_BUNDLE_VERSION
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ARCANE_MACHINE_BUNDLE_VERSION} from 'arcane-os';

console.log(ARCANE_MACHINE_BUNDLE_VERSION);
```

## ARCANE_PROTOCOL

### Overview

Application-facing Arcane bridge protocol required by this SDK.

### Value and import

```text
const ARCANE_PROTOCOL
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ARCANE_PROTOCOL} from 'arcane-os';

console.log(ARCANE_PROTOCOL);
```

## ARCANE_UPSTREAM_REPOSITORY

### Overview

Canonical upstream Arcane OS repository URL.

### Value and import

```text
const ARCANE_UPSTREAM_REPOSITORY
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ARCANE_UPSTREAM_REPOSITORY} from 'arcane-os';

console.log(ARCANE_UPSTREAM_REPOSITORY);
```

## CLI_EVENT_PROTOCOL

### Overview

Version identifier for normalized CLI JSON and NDJSON event envelopes.

### Value and import

```text
const CLI_EVENT_PROTOCOL
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {CLI_EVENT_PROTOCOL} from 'arcane-os';

console.log(CLI_EVENT_PROTOCOL);
```

## CLI_NAME

### Overview

Primary command name presented by the SDK.

### Value and import

```text
const CLI_NAME
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {CLI_NAME} from 'arcane-os';

console.log(CLI_NAME);
```

## OUTPUT_MODES

### Overview

Frozen supported CLI output modes: human, JSON, and NDJSON.

### Value and import

```text
const OUTPUT_MODES
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {OUTPUT_MODES} from 'arcane-os';

console.log(OUTPUT_MODES);
```

## RUNTIME_ROOT

### Overview

Absolute installed SDK runtime directory for the current process.

### Value and import

```text
const RUNTIME_ROOT
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {RUNTIME_ROOT} from 'arcane-os';

console.log(RUNTIME_ROOT);
```

## SDK_NAME

### Overview

Published npm package name.

### Value and import

```text
const SDK_NAME
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {SDK_NAME} from 'arcane-os';

console.log(SDK_NAME);
```

## SDK_ROOT

### Overview

Absolute installed package root for the current process.

### Value and import

```text
const SDK_ROOT
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {SDK_ROOT} from 'arcane-os';

console.log(SDK_ROOT);
```

## SDK_VERSION

### Overview

Exact SDK package version.

### Value and import

```text
const SDK_VERSION
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {SDK_VERSION} from 'arcane-os';

console.log(SDK_VERSION);
```


# Errors

## ArcaneError

### Overview

Normalized SDK error class carrying a stable code, human message, optional resolution details, cause, and exit status.

### Signature and result

```text
new ArcaneError(code, message, {details, cause, exitCode}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ArcaneError, ERROR_CODES} from 'arcane-os';

const error = new ArcaneError(
    ERROR_CODES.usage,
    'Choose one documented target.'
);

console.log(error.code, error.message);
```

## ERROR_CODES

### Overview

Frozen registry of stable SDK error-code strings.

`ERROR_CODES.updateCheckFailed` is exactly
`'ARCANE_UPDATE_CHECK_FAILED'`. It identifies an update-check validation,
registry, timeout, HTTP, or response failure; caller cancellation remains the
separate `ERROR_CODES.cancelled` value.

The import-map operation also reports the stable operation-specific strings
`ARCANE_IMPORT_MAP_INVALID`, `ARCANE_IMPORT_MAP_UNRESOLVED`, and
`ARCANE_IMPORT_MAP_COLLISION`; package assembly can additionally report
`ARCANE_IMPORT_MAP_CLEANUP_FAILED`. They are normalized `ArcaneError.code`
values, but are not properties added to this general registry in SDK `0.3.4`.

### Value and import

```text
const ERROR_CODES
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ERROR_CODES} from 'arcane-os';

console.log(ERROR_CODES.updateCheckFailed); // ARCANE_UPDATE_CHECK_FAILED
```

## errorRecord()

### Overview

Projects an error into the JSON-safe normalized public error record.

### Signature and result

```text
errorRecord(error)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {errorRecord} from 'arcane-os';

console.log(errorRecord(new Error('Example failure.')));
```

## fail()

### Overview

Synchronously throws an `ArcaneError` with the supplied code, message, and
optional diagnostic context. It never returns a value or a promise.

### Signature, parameters, and error

```text
fail(code, message, options)
```

Import it from `arcane-os`. `code` is normally one of `ERROR_CODES`; a falsy
code becomes `ARCANE_OPERATION_FAILED`. `message` is the public error message.
`options` can contain `details`, `cause`, and `exitCode`. `details` is preserved
for structured recovery, `cause` is attached through the standard `Error`
cause, and an integer `exitCode` is preserved; otherwise the exit code is `1`.

Calling `fail()` has no filesystem, event, cancellation, or receipt side
effect. Catch the thrown `ArcaneError` synchronously, or let it reject the
surrounding asynchronous operation naturally. Do not wrap it merely to make it
look asynchronous.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ERROR_CODES, fail} from 'arcane-os';

function requireSelectedApp(appId) {
    if (typeof appId !== 'string' || appId.length === 0) {
        fail(ERROR_CODES.usage, 'Select one application.', {
            details: {field: 'appId'}
        });
    }

    return appId;
}
```

## normalizeError()

### Overview

Converts an unknown thrown value into an `ArcaneError` while preserving an existing normalized error.

### Signature and result

```text
normalizeError(error, fallbackCode=ERROR_CODES.operationFailed)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {normalizeError} from 'arcane-os';

console.log(normalizeError(new Error('Example failure.')));
```

## throwIfAborted()

### Overview

Throws the signal reason or a normalized cancellation error when an AbortSignal is already aborted.

### Signature and result

```text
throwIfAborted(signal)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {throwIfAborted} from 'arcane-os';

const controller = new AbortController();
throwIfAborted(controller.signal);
```


# Workspace, doctor, repository, and server

## assessArcaneOllama()

### Overview

Performs a read-only Microsoft NT assessment of the managed ArcaneOllama service and reports unsupported hosts honestly.

### Signature and result

```text
async assessArcaneOllama({ signal, onEvent, platform=process.platform, run=runProcess, fileExists=exists }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; Microsoft NT managed-service assessment.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {assessArcaneOllama} from 'arcane-os';

async function useassessArcaneOllama(...arguments_) {
    return assessArcaneOllama(...arguments_);
}
```

## createWorkspace()

### Overview

Scaffolds one new external repository-shaped workspace and one selected application.

### Signature and result

```text
async createWorkspace({ targetPath, appId, displayName, target='browser', initializeGit=false, signal, onEvent })
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {createWorkspace} from 'arcane-os';

async function usecreateWorkspace(...arguments_) {
    return createWorkspace(...arguments_);
}
```

## doctorApplication()

### Overview

Runs the read-only SDK/runtime/workspace and optional local-AI diagnostic operation.

### Signature and result

```text
async doctorApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {doctorApplication} from 'arcane-os';

async function usedoctorApplication(...arguments_) {
    return doctorApplication(...arguments_);
}
```

## initializeApplication()

### Overview

Initializes missing Arcane files for one app in an existing external or integrated workspace.

### Signature and result

```text
async initializeApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {initializeApplication} from 'arcane-os';

async function useinitializeApplication(...arguments_) {
    return initializeApplication(...arguments_);
}
```

## initWorkspace()

### Overview

Adds one application scaffold to an existing workspace without overwriting incompatible files.

### Signature and result

```text
async initWorkspace({ workspaceRoot=process.cwd(), appId, displayName, target='browser', signal, onEvent })
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {initWorkspace} from 'arcane-os';

async function useinitWorkspace(...arguments_) {
    return initWorkspace(...arguments_);
}
```

## inspectWorkspaceProfile()

### Overview

Classifies one canonical workspace as external or integrated and reports its fixed layout.

### Signature and result

```text
async inspectWorkspaceProfile(workspaceRoot=process.cwd())
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {inspectWorkspaceProfile} from 'arcane-os';

async function useinspectWorkspaceProfile(...arguments_) {
    return inspectWorkspaceProfile(...arguments_);
}
```

## repositoryPull()

### Overview

Runs one fast-forward-only pull after proving the selected repository worktree is clean.

### Signature and result

```text
async repositoryPull({ workspaceRoot=process.cwd(), signal, onEvent, run=runProcess }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; network-assisted Git.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {repositoryPull} from 'arcane-os';

async function userepositoryPull(...arguments_) {
    return repositoryPull(...arguments_);
}
```

## repositoryPush()

### Overview

Pushes the selected attached branch through the repository's configured remote and credentials.

### Signature, parameters, and result

```text
async repositoryPush({ workspaceRoot=process.cwd(), signal, onEvent, run=runProcess }={})
```

Import it from `arcane-os`. `workspaceRoot` selects the Git worktree. `signal`
cancels the owned Git process tree. The awaited `onEvent` callback receives the
ordered `process.*` events for the three status probes and the push. `run` is an
injectable process runner intended for deterministic tests; ordinary callers
should keep the default.

Before pushing, the SDK runs `git rev-parse --show-toplevel`,
`git branch --show-current`, and `git status --short --branch` in order. It rejects a
detached HEAD, then runs plain `git push`; the repository's current branch,
configured upstream/remote, Git credentials, hooks, and server policy remain
authoritative. Unlike `repositoryPull()`, this function does **not** require a
clean worktree. It does not create a commit or select a remote/refspec for you.

The promise resolves to
`{action:'push', repositoryRoot, branch, output}`. `output` is trimmed stdout,
or trimmed stderr when stdout is empty. A missing Git executable, failed status
probe, rejected/nonzero push, cancellation, or event-callback failure rejects
with the normalized process error. Cancellation stops the local process tree;
it cannot prove that a remote accepted no objects before the interruption.

### Availability and normalization

**Node; network-assisted Git.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {repositoryPush} from 'arcane-os';

// Call only after the user has chosen to publish the attached branch.
async function pushAttachedBranch(workspaceRoot, signal) {
    const result = await repositoryPush({
        workspaceRoot,
        signal,
        onEvent(event) {
            if (event.type === 'process.stderr') console.error(event.message);
        }
    });

    console.log(`Pushed ${result.branch} from ${result.repositoryRoot}`);
    return result;
}
```

## repositoryStatus()

### Overview

Reads one repository's branch and short worktree status through an owned child process.

### Signature and result

```text
async repositoryStatus({ workspaceRoot=process.cwd(), signal, onEvent, run=runProcess }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {repositoryStatus} from 'arcane-os';

async function userepositoryStatus(...arguments_) {
    return repositoryStatus(...arguments_);
}
```

## resolveWorkspace()

### Overview

Resolves one workspace profile and selected app into canonical SDK paths.

### Signature and result

```text
async resolveWorkspace({workspaceRoot=process.cwd(), appId}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {resolveWorkspace} from 'arcane-os';

async function useresolveWorkspace(...arguments_) {
    return resolveWorkspace(...arguments_);
}
```

## discoverApps()

### Overview

Discovers application ids in one external or integrated workspace without selecting one.

### Signature and result

```text
async discoverApps(workspaceRoot=process.cwd())
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {discoverApps} from 'arcane-os';

async function usediscoverApps(...arguments_) {
    return discoverApps(...arguments_);
}
```

## runDoctor()

### Overview

Runs the underlying read-only doctor checks and returns their normalized report.

### Signature and result

```text
async runDoctor({ workspaceRoot, appId, arcaneRoot, requireLocalAI=false, signal, onEvent, platform=process.platform, run=runProcess }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {runDoctor} from 'arcane-os';

async function userunDoctor(...arguments_) {
    return runDoctor(...arguments_);
}
```

## runRepositoryAction()

### Overview

Selects and runs one repository action by name.

### Signature and result

```text
async runRepositoryAction(action, options={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {runRepositoryAction} from 'arcane-os';

async function userunRepositoryAction(...arguments_) {
    return runRepositoryAction(...arguments_);
}
```

## selectApp()

### Overview

Selects one exact app id, or requires an unambiguous single discovered application.

### Signature and result

```text
async selectApp(workspaceRoot=process.cwd(), appId)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {selectApp} from 'arcane-os';

async function useselectApp(...arguments_) {
    return selectApp(...arguments_);
}
```

## startDevServer()

### Overview

Starts one owned browser development server with exact runtime/app route mappings and an unguessable session capability.

### Signature, modes, and result

```text
async startDevServer(options={})
```

Import it from `arcane-os`. Source mode accepts
`{workspaceRoot=process.cwd(), appId, mode='source', host='127.0.0.1', port=0,
signal, onEvent}` and serves one validated workspace application plus its
complete SDK or integrated runtime. Packaged mode uses
`{mode:'packaged', releaseRoot, host, port, signal, onEvent}` and serves the
complete selected release files. `host` must be
numeric loopback `127.0.0.1` or `::1`; port `0` asks the operating system for an
available port.

The promise settles after the listener is ready and resolves to
`{server, mode, workspaceRoot, appId, host, port, origin, cleanUrl, url, close,
closed, lifecycle}`. `server` is the raw Node HTTP server. `url` contains the
unguessable bootstrap capability that establishes an HttpOnly session
cookie; do not log, persist, or disclose it. `cleanUrl` contains no capability
but does not bootstrap a new browser session by itself. In packaged mode,
`workspaceRoot` and `appId` are `null`.

Starting the server opens a loopback listener and emits awaited,
backpressured `server.starting` and `server.started` events. Request failures
emit `server.request.failed`; shutdown emits `server.stopped` after owned
requests and event delivery drain. Call `await result.close()` in a `finally`
block, or abort `signal`; `close()` is idempotent and returns the
same settlement represented by both `closed` and `lifecycle`. A listener error
or event-callback failure closes the server and rejects its lifecycle. Invalid
mode/host/port, malformed workspace or release content, an occupied port,
or an already-aborted signal rejects startup.

### Availability and normalization

**Node control plane; browser data plane.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {startDevServer} from 'arcane-os';

async function inspectSourceServer(workspaceRoot, signal) {
    const running = await startDevServer({
        workspaceRoot,
        appId: 'example-app',
        mode: 'source',
        host: '127.0.0.1',
        port: 0,
        signal
    });

    try {
        // Hand running.url directly to the intended development browser.
        console.log(`Serving on ${running.origin}`);
        return {origin: running.origin, port: running.port};
    } finally {
        await running.close();
    }
}
```

## startSourceExampleServer()

### Overview

Starts a generic server for examples that consume live source trees. The
caller explicitly maps URL prefixes to directories, so an example can serve
its own small wrapper, SDK `src`, `browser-runtime`, and `runtime` trees, and an
external model directory without copying those files or owning a static-server
implementation.

### Signature, options, and result

```text
async startSourceExampleServer(options={})
```

Import it from `arcane-os`. Options are
`{mounts, startPath='/', host='127.0.0.1', port=0, tls,
crossOriginIsolated=false, signal, onEvent}`. `mounts` is a nonempty array of
`{urlPath, root, index?, include?}` records:

- `urlPath` is an absolute URL path. Nested mounts are allowed and the longest
  matching URL path owns the request.
- `root` is a filesystem path or `file:` URL. It is resolved when the server
  starts, but the directory does not need to exist until a file is requested.
- `index` optionally names the relative file used for a mount or directory URL.
- `include` optionally lists exact relative files and directory prefixes ending
  in `/`. When omitted, every regular file under the mount is addressable.

`startPath` is returned in the public URL and receives a redirect from `/` when
it is not `/`. `host` and `port` are passed to the owned Node listener; an
explicit `0.0.0.0` or `::` host allows LAN access. `tls`, when supplied, is the
ordinary options object passed to `node:https.createServer`. Set
`crossOriginIsolated:true` when a browser-WASM example needs
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`; otherwise those headers are
absent. The helper adds no Content Security Policy.

GET and HEAD stream the complete selected regular file. A single HTTP Range is
handled automatically, including open-ended and suffix ranges. Content length,
content range, and range offsets exist only as required HTTP transport framing;
they are not size limits, admission rules, progress values, or product policy.
Missing mounts remain lazy and return 404 until their files exist. Unsupported
methods return 405 and an invalid range returns 416.

The promise settles after the listener is ready and resolves to
`{server, protocol, host, port, origin, url, close, closed}`. `server` is the
raw Node HTTP or HTTPS server, `close()` is idempotent, and `closed` settles
when the listener closes. It rejects with an operational server failure after
the listener closes. An abort signal closes the listener. Optional `onEvent`
receives `source-server.starting`, `source-server.started`,
`source-server.request.failed`, and `source-server.failed` records; an event
listener failure is logged without replacing the request outcome.

### Availability and normalization

**Node control plane; browser data plane.** Explicit URL mounts, complete file
streaming, protocol-local HTTP ranges, and a closeable server result. Deep
protocol: [Node ESM](protocols.md).

### Example

```javascript
import {startSourceExampleServer} from 'arcane-os';

async function serveSourceExample(signal) {
    const running = await startSourceExampleServer({
        mounts: [
            {
                urlPath: '/examples/chat',
                root: new URL('./', import.meta.url),
                index: 'index.html',
                include: ['index.html', 'app.js', 'assets/']
            },
            {
                urlPath: '/src',
                root: new URL('../../src/', import.meta.url)
            },
            {
                urlPath: '/browser-runtime',
                root: new URL('../../browser-runtime/', import.meta.url)
            },
            {
                urlPath: '/runtime',
                root: new URL('../../runtime/', import.meta.url)
            },
            {
                urlPath: '/examples/chat/models',
                root: process.env.ARCANE_EXAMPLE_MODEL_ROOT
                    || new URL('./models/', import.meta.url)
            }
        ],
        startPath: '/examples/chat/',
        host: '127.0.0.1',
        port: 8444,
        crossOriginIsolated: true,
        signal
    });

    console.log(`Serving on ${running.url}`);
    return running;
}
```

## validateWorkspace()

### Overview

Runs canonical workspace, runtime, descriptor, and selected-app validation with progress events.

### Signature and result

```text
async validateWorkspace({
    workspaceRoot=process.cwd(),
    appId,
    allowMissingManagedImportMap=false,
    signal,
    onEvent
}={})
```

Import it from `arcane-os`. It resolves to a validation result with
`valid`, `workspaceMode`, `workspaceRoot`, `appId`, `appRoot`, the selected
configuration/application, lock data, and completed checks. For an external
workspace it additionally returns the exact installed package authority:

```javascript
{
  sdkInstallation: {
    dependencyName,
    packageSource,
    canonicalPackageRoot,
    packageName: 'arcane-os',
    packageVersion: '0.3.4',
    runtimeRoot,
    browserRuntimeRoot
  }
}
```

The dependency can be named `arcane-os` or be one exact npm alias for
`npm:arcane-os@0.3.4`. The selected installation must still be one direct,
physical, non-link package directory whose manifest identifies exactly as
`arcane-os@0.3.4`; duplicate canonical/alias declarations reject.
`allowMissingManagedImportMap` is an internal packaging/development seam. An
ordinary caller should leave it `false`.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {validateWorkspace} from 'arcane-os';

const validation = await validateWorkspace({
    workspaceRoot: process.cwd(),
    appId: 'hello-world'
});

console.log(validation.sdkInstallation?.dependencyName);
console.log(validation.sdkInstallation?.packageVersion);
```


# Headless toolchain operations

## buildApplication()

### Overview

Builds and retained-verifies one explicitly selected native target through one paired provider.

### Signature and result

```text
async buildApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {buildApplication} from 'arcane-os';

async function usebuildApplication(...arguments_) {
    return buildApplication(...arguments_);
}
```

## bundleApplication()

### Overview

Creates one deterministic external application bundle from one authenticated packaged release.

### Signature and result

```text
async bundleApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {bundleApplication} from 'arcane-os';

async function usebundleApplication(...arguments_) {
    return bundleApplication(...arguments_);
}
```

## checkApplication()

### Overview

Runs the selected application or integrated shared validation boundary.

### Signature and result

```text
async checkApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {checkApplication} from 'arcane-os';

async function usecheckApplication(...arguments_) {
    return checkApplication(...arguments_);
}
```

## createApplication()

### Overview

Creates one new external application workspace through the shared headless toolchain.

### Signature and result

```text
async createApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {createApplication} from 'arcane-os';

async function usecreateApplication(...arguments_) {
    return createApplication(...arguments_);
}
```

## createToolchain()

### Overview

Returns a frozen convenience object that applies shared defaults to every headless application operation.

The object includes `importMap(options)`, which merges defaults with explicit
call options and refreshes every directly navigable descriptor-selected browser
document for one selected app. The equivalent generic route is
`execute('import-map', options)`.
It also includes `upgrade(options)`, which performs the explicit installed-SDK
consumer upgrade described by `upgradeApplication()`, and
`updateCheck(options)`, which invokes `checkSdkUpdate()` once. Constructing the
toolchain does not check, poll, schedule, download, install, regenerate, or
mutate anything.

### Signature and result

```text
createToolchain(defaults={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {createToolchain} from 'arcane-os';

const toolchain = createToolchain({
    workspaceRoot: process.cwd(),
    appId:'hello-world',
    onEvent(event) {
        console.info(event.type);
    }
});

// Only this explicit call refreshes the managed map and selected HTML documents.
const result = await toolchain.importMap();
console.log(result.importMap.entryCount); // derived from installed inventories
console.log(result.importMap.documentPaths, result.importMap.documentCount);
```

## describeTargets()

### Overview

Returns the normalized target catalog through the headless operation lifecycle.

### Signature and result

```text
async describeTargets(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {describeTargets} from 'arcane-os';

async function usedescribeTargets(...arguments_) {
    return describeTargets(...arguments_);
}
```

## developApplication()

### Overview

Starts one owned browser development server for the selected application.

### Signature and result

```text
async developApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {developApplication} from 'arcane-os';

async function usedevelopApplication(...arguments_) {
    return developApplication(...arguments_);
}
```

## executeOperation()

### Overview

Dispatches one named headless SDK operation with normalized acceptance, events, cancellation, and failure.

The exact command `'import-map'` dispatches one app-scoped refresh
across every `.html`/`.htm` file selected by the descriptor's existing
include/exclude rules and returns `{workspaceRoot, workspaceMode, appId,
importMap}`. A normal `importMap` value reports the generated imports and
complete ordered `documentPaths`. The canonical integrated-legacy layout returns its documented skip
record instead. This route mutates the map artifact and selected managed HTML
documents as one atomic refresh and has no
supported dry-run.

The exact command `'upgrade'` dispatches `upgradeApplication(options)`. It is
external-workspace-only and composes three complete stages under one
workspace-operation lease: exact lock reconciliation, runtime
materialization, and the same multi-document import-map refresh. It performs no
dependency installation, `package.json` merge, test, packaging, `dist`, or
network operation. The stages are not presented as one filesystem-atomic
transaction.

The exact command `'update-check'` dispatches one `checkSdkUpdate(options)`
call. Dispatch never installs a recurring task, polls application state, or
causes another command to check for updates implicitly. There is no exported
`importMapApplication()` or `generateImportMap()` binding and no
`arcane-os/import-map` package subpath.

### Signature and result

```text
async executeOperation(command, options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {executeOperation} from 'arcane-os';

const result = await executeOperation('import-map', {
    workspaceRoot:process.cwd(),
    appId:'hello-world'
});
console.log(result.importMap.committed, result.importMap.entryCount);
console.log(result.importMap.documentPaths, result.importMap.documentCount);
```

## packageApplication()

### Overview

Runs the high-level package operation for one selected application. It reads
the installed SDK/runtime selection, injects one deterministic
managed import map into every directly navigable included `.html`/`.htm`
browser document while preserving component fragments as package files, and
then packages the complete selected content without automatically running tests
or checks. Verification occurs only when explicitly requested or when required
for the selected release output. A failure leaves the previously accepted
distribution untouched. Success returns the low-level package result and
complete import-map document inventory. External
packages publish `ARCANE_RUNTIME_PROJECTION.json`; private
`ARCANE_APP_RELEASE.json` remains an internal verification authority rather
than an application route.

### Signature and result

```text
async packageApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {packageApplication} from 'arcane-os';

const result = await packageApplication({
    workspaceRoot: process.cwd(),
    appId: 'hello-world'
});

console.log(result.release.importMap.documentPaths);
```

## planApplication()

### Overview

Creates one authenticated native build plan without executing the provider build.

### Signature and result

```text
async planApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {planApplication} from 'arcane-os';

async function useplanApplication(...arguments_) {
    return planApplication(...arguments_);
}
```

## repositoryApplication()

### Overview

Dispatches one selected repository status, pull, or push operation through the headless lifecycle.

### Signature and result

```text
async repositoryApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {repositoryApplication} from 'arcane-os';

async function userepositoryApplication(...arguments_) {
    return repositoryApplication(...arguments_);
}
```

## runApplication()

### Overview

Runs a browser app or performs the selected native build/launch lifecycle for one target. It does not run tests or checks automatically; selected release-output verification remains explicit to that release operation.

### Signature and result

```text
async runApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {runApplication} from 'arcane-os';

async function userunApplication(...arguments_) {
    return runApplication(...arguments_);
}
```

## testApplication()

### Overview

Runs the selected application's exact test boundary or one integrated shared test.
For external and modern integrated apps, app-scope testing authenticates the
existing managed import-map artifact against the selected runtime and each
selected HTML document before launching isolated files. The child loader maps
only exact entries such as `arcane/SpeechPlayback`, preserves
`arcane-os/testing`, resolves supported URL-like compatibility keys, and rejects
an unmapped `arcane/*` or `#arcane/*` specifier. The compact map
locator is removed from the child environment before application test code is
imported. Integrated-legacy testing retains its existing no-map compatibility
path.

### Signature and result

```text
async testApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {testApplication} from 'arcane-os';

async function usetestApplication(...arguments_) {
    return testApplication(...arguments_);
}
```

## upgradeApplication()

### Overview

Runs the selected external installed-SDK application's ordinary `npm upgrade`
command without adding a separate lock, runtime, import-map, authentication, or
reconciliation workflow. npm retains authority for dependency selection and
network behavior.

### Signature and result

```text
async upgradeApplication(options={})
```

The mutable `arcane-application-upgrade` result includes `workspaceRoot`,
`workspaceMode`, `appId`, and the normal process result (`command`, `args`,
`cwd`, `code`, `stdout`, and `stderr`).

### Availability and normalization

**Node; external installed-SDK workspaces only.** SDK-normalized inputs,
errors, events, and documented process results.

### Example

```javascript
import {upgradeApplication} from 'arcane-os';

const upgraded=await upgradeApplication({
    workspaceRoot:process.cwd(),
    appId:'hello-world'
});
console.log(upgraded.command,upgraded.args,upgraded.code);
```

## verifyApplication()

### Overview

Runs the high-level verification operation for one selected browser release.

### Signature and result

```text
async verifyApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {verifyApplication} from 'arcane-os';

async function useverifyApplication(...arguments_) {
    return verifyApplication(...arguments_);
}
```

## verifyBundleApplication()

### Overview

Runs the high-level external bundle verification operation.

### Signature and result

```text
async verifyBundleApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {verifyBundleApplication} from 'arcane-os';

async function useverifyBundleApplication(...arguments_) {
    return verifyBundleApplication(...arguments_);
}
```


# Events, processes, and testing

## createReporter()

### Overview

Creates the ordered CLI reporter that normalizes accepted, progress, terminal, JSON, and NDJSON event delivery.

### Signature, state, and output

```text
createReporter({ command, output='human', stdout=process.stdout, stderr=process.stderr, operationId=randomUUID(), clock=()=>new Date() }={})
```

Import it from `arcane-os` or `arcane-os/events`. This function returns
synchronously. `output` must be `"human"`, `"json"`, or `"ndjson"`.
`stdout` and `stderr` are writable streams; `operationId` and `clock` can be
injected for deterministic tests.

The returned object is
`{operationId, output, accept, emit, forward, complete, reject, accepted,
terminal}`. `accepted` and `terminal` are live getters. Call `accept(data)`
before `emit(type, data, message)` or `forward(value, data)`. Acceptance happens
once; later `accept()` calls return `null`. `complete(result)` and
`reject(error)` are mutually terminal, and later progress or terminal calls
return `null`. Each emitted event contains `arcane-cli-events/1`, the operation
id, a strictly increasing sequence, an ISO timestamp, the command, type, status,
and JSON-safe data. Circular members and unsupported JSON values are omitted;
errors are reduced through `errorRecord()`.

Human mode writes work events to stderr, readable results to stdout, and a
completion line to stderr. JSON mode writes work events to stderr and exactly
one final success/error envelope to stdout. NDJSON mode writes every event to
stdout. Reporter methods write synchronously to the supplied streams; they do
not provide backpressure promises, cancellation, or receipts. An unsupported
mode, `emit()` before acceptance, an invalid clock result, or a stream write
failure throws synchronously.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [arcane-cli-events/1](protocols.md).

### Example

```javascript
import {createReporter} from 'arcane-os';

const reporter = createReporter({command: 'check', output: 'human'});

reporter.accept({appId: 'example-app'});
reporter.emit(
    'workspace.validate.check',
    {name: 'descriptor', ok: true},
    'Validated the application descriptor.'
);
reporter.complete({ok: true});
```

## default()

### Overview

Default-export alias of the public `test` registration function.

### Signature and result

```text
default(name, optionsOrCallback, maybeCallback)
```

Import it from `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import test from 'arcane-os/testing';

test('adds two values', () => {
    if (1 + 1 !== 2) throw new Error('Unexpected result.');
});
```

## DEFAULT_TEST_TIMEOUT_MS

### Overview

Default timeout applied by the public isolated test API.

### Value and import

```text
const DEFAULT_TEST_TIMEOUT_MS
```

Import it from `arcane-os` or `arcane-os/testing`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {DEFAULT_TEST_TIMEOUT_MS} from 'arcane-os';

console.log(DEFAULT_TEST_TIMEOUT_MS);
```

## registeredTestCount()

### Overview

Returns the number of tests registered in the current isolated test realm.

### Signature and result

```text
registeredTestCount()
```

Import it from `arcane-os` or `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {registeredTestCount} from 'arcane-os';

console.log(registeredTestCount());
```

## runProcess()

### Overview

Runs one shell-free child command with complete stdout and stderr, ordered stream events, heartbeats, and process-tree cancellation.

### Signature, parameters, and result

```text
async runProcess(command, args=[], { cwd, env, signal, onEvent, heartbeatMs=5000, terminationGraceMs=DEFAULT_TERMINATION_GRACE_MS, allowNonzero=false, input }={})
```

Import it from `arcane-os`. `command` is executed directly with `shell:false`;
`args` must be a fixed array of strings, so shell expansion, pipelines, and
redirection never occur. `cwd` selects the child directory. `env` is shallowly
merged over `process.env`. When supplied, `input` is written once and stdin is
closed; otherwise stdin is closed immediately. On Microsoft NT, `npm` and `npx`
are normalized to their Node CLI entrypoints.

`onEvent` is awaited in order for `process.starting`, nonempty
`process.stdout`/`process.stderr` lines, coalesced `process.heartbeat`, and the
terminal process event. Stream delivery pauses the corresponding child stream
while the callback owns that chunk. `heartbeatMs` defaults to 5 seconds; the
timer applies a 1-second floor to ordinary numeric values.
`terminationGraceMs` defaults to 1,500 ms and must
be an integer from 100 through 30,000. `allowNonzero:false` rejects a nonzero
exit; `true` returns it as data.

The promise resolves to
`{command, args, cwd, code, signal, stdout, stderr}`. Here `signal` is the
child's terminating signal name or `null`, not the input `AbortSignal`. `args`
is copied, `cwd` defaults to the current process directory, and each captured
text stream preserves its complete content. A missing executable rejects with
`ARCANE_PREREQUISITE_MISSING`; invalid arguments, a disallowed nonzero exit,
and spawn/runtime failures use the normalized SDK error boundary, with the
nonzero result retained in error details.

Aborting `signal` emits cancellation-requested state, terminates the owned
process tree, escalates to a forced tree termination after the grace interval,
drains event delivery, and rejects with `ARCANE_CANCELLED` and exit code 130.
An `onEvent` failure also stops the tree and rejects with that callback failure.
Cancellation proves only that the local process tree was stopped; it cannot
reverse external effects already performed by the command.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {runProcess} from 'arcane-os';

const result = await runProcess(process.execPath, ['--version'], {
    cwd: process.cwd(),
    onEvent(event) {
        if (event.type === 'process.stderr') console.error(event.message);
    }
});

console.log(result.stdout.trim(), result.code);
```

## runRegisteredTests()

### Overview

Executes the current isolated realm's registered tests once and returns the normalized Vanilla Test report.

### Signature, lifecycle, and result

```text
async runRegisteredTests({signal, requireTests=true, onPhase}={})
```

Import it from `arcane-os` or `arcane-os/testing`. Register every top-level test
with `test()` before this call. One module realm can run its registry only once;
a second call rejects with `ReferenceError`. With `requireTests:true`, an empty
registry becomes one failed report outcome. Set it to `false` only when an empty
suite is intentional.

Tests run sequentially. A test callback receives
`{signal, after(callback), test(name, options?, callback)}` for cooperative
cancellation, FIFO cleanup, and owned nested tests. Each test uses its declared
timeout or `DEFAULT_TEST_TIMEOUT_MS`; test timeouts can abort the remainder of
the run, cleanup and report phases have their own bounded timeouts, and cleanup
is skipped after fatal timeout or cancellation because JavaScript promises
cannot be preempted safely. The awaited `onPhase` callback receives started and
completed records for test, cleanup, and report phases. A phase-callback failure
is authoritative and can reject the run.

The promise resolves to the frozen Vanilla Test snapshot
`{passed, failed, total, failureCount, ok, report}`. `passed` and `failed` are
frozen description arrays and `report` is the rendered text. Ordinary assertion
failures produce `ok:false`; invalid API use, cancellation, a fatal timeout, or
an authoritative phase/report failure rejects. Aborting `signal` propagates to
the currently owned test and stops later tests, but test callbacks must observe
their supplied signal to stop host work cooperatively.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {runRegisteredTests, test} from 'arcane-os/testing';

test('normalizes an application id', () => {
    const value = 'example-app'.trim();
    if (value !== 'example-app') throw new Error('Unexpected id.');
});

const report = await runRegisteredTests({
    onPhase(phase) {
        if (phase.status === 'started') console.log(phase.name);
    }
});

if (!report.ok) process.exitCode = 1;
```

## test()

### Overview

Registers one public test, optional timeout, callback, nested cases, and FIFO cleanup in the isolated runner.

### Signature and result

```text
test(name, optionsOrCallback, maybeCallback)
```

Import it from `arcane-os` or `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and lifecycle.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {test} from 'arcane-os';

test('adds two values', () => {
    if (1 + 1 !== 2) throw new Error('Unexpected result.');
});
```

# Explicit SDK update checks

This is an on-demand Node.js control-plane and CLI maintainer surface. It never
runs from renderer application code automatically. One call can make one
ordinary HTTP or HTTPS GET to the selected npm registry and reads the complete
response subject only to unavoidable HTTP framing; there is no
polling, recurrence, interval, background agent, download, install, dependency
mutation, runtime replacement, or self-update. The only timer is the timeout
owned and cleared by that one request.

## SDK_UPDATE_REGISTRY

### Overview

Default npm registry root for an explicit SDK update check.

### Value

```text
const SDK_UPDATE_REGISTRY = 'https://registry.npmjs.org/'
```

The request builder appends the fixed
`-/package/arcane-os/dist-tags` endpoint only after validating the root.

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** Exact default HTTPS origin
string. Importing it performs no request and starts no timer.

### Example

```javascript
import {SDK_UPDATE_REGISTRY, validateUpdateRegistry} from 'arcane-os';

const registry = validateUpdateRegistry(SDK_UPDATE_REGISTRY);
console.log(registry.origin);
```

## SDK_UPDATE_TIMEOUT_MS

### Overview

Default timeout for the single registry request owned by an explicit update check.

### Value

```text
const SDK_UPDATE_TIMEOUT_MS = 2500
```

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** Exact default millisecond
integer. Accepted per-call timeouts are positive safe integers.

### Example

```javascript
import {SDK_UPDATE_TIMEOUT_MS} from 'arcane-os';

console.log(`Update-check timeout: ${SDK_UPDATE_TIMEOUT_MS} ms`);
```

## checkForSdkUpdate()

### Overview

Performs exactly one complete registry read and reports whether the npm dist-tag
selected for the installed SDK is newer. It only checks metadata; it does not
download, install, mutate, or schedule anything.

### Signature and parameters

```text
async checkForSdkUpdate({
    packageName=SDK_NAME,
    currentVersion=SDK_VERSION,
    registry=SDK_UPDATE_REGISTRY,
    timeoutMs=SDK_UPDATE_TIMEOUT_MS,
    fetchImpl=globalThis.fetch,
    signal,
    onEvent,
    clock=()=>new Date()
}={})
```

`packageName` must be exactly `arcane-os`. `currentVersion` must be strict
semantic version text: prereleases select npm `dev`, while stable versions
select `latest`. `registry` must pass `validateUpdateRegistry()`; ordinary HTTP
and HTTPS npm registries, including caller-selected local or corporate paths,
remain functional. `fetchImpl` and `clock` are explicit injection points.
`timeoutMs` is a positive safe integer. `signal` provides caller
cancellation, and each supplied `onEvent` callback is awaited.

The request is one ordinary `GET` accepting JSON and follows the selected
runtime's normal registry behavior. The response must return HTTP 200 and JSON
media type, be valid UTF-8, and decode to a nonempty dist-tag object whose
string values are strict semantic versions.

### Result, events, and errors

The promise resolves to a mutable object:

```text
{
    packageName,
    currentVersion,
    registryVersion,
    tag,                 // 'dev' or 'latest'
    status,              // 'update-available', 'current', or 'ahead'
    updateAvailable,
    registry,            // normalized origin
    checkedAt            // clock().toISOString()
}
```

After initial validation it emits awaited `update.check.started`. Success emits
`update.check.completed`; a non-cancellation request or response failure emits
`update.check.failed` with the normalized failure code.
Registry, timeout, HTTP, content, JSON, dist-tag, version, or clock
failures reject with `ARCANE_UPDATE_CHECK_FAILED`. Caller cancellation rejects
with `ARCANE_CANCELLED`; it is distinct from the per-request timeout. Event
callbacks are awaited, and a callback rejection can reject or replace the
operation's normal settlement; it is never ignored. The owned timeout is cleared
in `finally`.

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** Registry data is reduced to
one mutable status result. No provider payload becomes installation authority,
and applications never invoke this function automatically.

### Example

```javascript
import {checkForSdkUpdate} from 'arcane-os';

// Defined for an explicit maintainer action; this function is not scheduled.
async function checkInstalledSdkOnce(signal) {
    const result = await checkForSdkUpdate({
        signal,
        onEvent(event) {
            console.info(event.type, event.message);
        }
    });

    console.log(result.status, result.registryVersion);
    return result;
}
```

## checkSdkUpdate()

### Overview

High-level toolchain/CLI wrapper for exactly one `checkForSdkUpdate()` call.

### Signature and result

```text
async checkSdkUpdate(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`.

It forwards the options unchanged and preserves the direct result, events,
errors, cancellation, timeout, and security boundary. `executeOperation()`
routes the exact command `'update-check'` here, and `createToolchain()` exposes
it as `updateCheck(options)`. Neither route polls or schedules a later call.

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** Same normalized contract as
`checkForSdkUpdate()` with no additional request or mutation.

### Example

```javascript
import {checkSdkUpdate} from 'arcane-os';

async function runRequestedUpdateCheck(signal) {
    const result = await checkSdkUpdate({signal});
    return result.updateAvailable;
}
```

## compareSdkVersions()

### Overview

Synchronously compares two strict semantic SDK versions without network access.

### Signature and result

```text
compareSdkVersions(leftValue, rightValue)
```

Returns `-1` when the left version has lower precedence, `0` when precedence is
equal, and `1` when it is higher. Major, minor, patch, then semantic prerelease
identifiers are compared. A stable version outranks a prerelease at the same
core version; build metadata does not affect precedence. Invalid input throws
the packager's semantic-version validation error synchronously.

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** Pure in-process comparison;
no request, timer, event, mutation, or cancellation contract.

### Example

```javascript
import {compareSdkVersions} from 'arcane-os';

console.log(compareSdkVersions('0.1.0-dev.4', '0.1.0-dev.5')); // -1
console.log(compareSdkVersions('1.0.0+local', '1.0.0+registry')); // 0
```

## updateTagForVersion()

### Overview

Selects the one npm dist-tag appropriate for an installed SDK version.

### Signature and result

```text
updateTagForVersion(value)
```

Returns `'dev'` when the strict semantic version contains any prerelease
identifier and `'latest'` otherwise. Invalid input synchronously throws
`ARCANE_UPDATE_CHECK_FAILED` with the semantic-version error as its cause.

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** Pure `dev`/`latest`
normalization; no registry request or state change.

### Example

```javascript
import {updateTagForVersion} from 'arcane-os';

console.log(updateTagForVersion('0.1.0-dev.4')); // dev
console.log(updateTagForVersion('1.0.0'));       // latest
```

## validateUpdateRegistry()

### Overview

Synchronously validates one ordinary HTTP or HTTPS registry URL.

### Signature and result

```text
validateUpdateRegistry(value)
```

The URL must use HTTP or HTTPS. Caller-selected credentials, ports, paths,
queries, and normal redirects remain under the selected registry and Fetch
runtime. The function returns the normalized `URL` object and performs no DNS
lookup or request.

Invalid syntax or an unsupported scheme throws synchronously with
`ARCANE_UPDATE_CHECK_FAILED`.

### Availability and normalization

**Node; on-demand CLI or maintainer check only.** URL normalization only; no
request, polling, or mutation.

### Example

```javascript
import {SDK_UPDATE_REGISTRY, validateUpdateRegistry} from 'arcane-os';

const registry = validateUpdateRegistry(SDK_UPDATE_REGISTRY);
console.log(registry.href); // https://registry.npmjs.org/
```

# Central events, time travel, and DOM instrumentation

## ARCANE_EVENT_STACK_PROTOCOL

### Overview

The exact discriminator for serialized Arcane event-stack documents and every record they contain. Use it to reject incompatible diagnostic files before review or playback.

### Value and use

```text
const ARCANE_EVENT_STACK_PROTOCOL = 'arcane-event-stack/1'
```

This is a data-format version, not the Core `arcane/1` RPC protocol and not a network transport. `parseEventStack()` enforces it on the document and each retained record. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** Exact host-neutral protocol string; it grants no capability or authority.

### Example

```javascript
import {ARCANE_EVENT_STACK_PROTOCOL} from 'arcane-os/event-manager';

if (document.protocol !== ARCANE_EVENT_STACK_PROTOCOL) {
    throw new Error('Unsupported event stack.');
}
```

## DEFAULT_DOM_EVENT_TYPES

### Overview

The frozen default list of capture-phase browser interaction names observed by DOM instrumentation. Pass a smaller `eventTypes` array when a debugger needs only a focused interaction class.

### Value and use

```text
const DEFAULT_DOM_EVENT_TYPES
```

The list is configuration, not an event source. Observation begins only after a controller starts, normally because time travel is enabled on a manager with attached DOM instrumentation. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler; meaningful to browser DOM instrumentation.** The exact frozen strings are normalized; live host event objects are never stored in this value.

### Example

```javascript
import {DEFAULT_DOM_EVENT_TYPES} from 'arcane-os/event-manager';

console.log(DEFAULT_DOM_EVENT_TYPES.includes('click'));
```

## DOM_INTERACTION_EVENT

### Overview

The event name used for complete diagnostics of captured clicks, keys, pointer actions, form activity, and the other configured DOM interactions. Its payload describes the target and path without retaining DOM nodes; private targets and credential-named fields remain protected.

### Value and use

```text
const DOM_INTERACTION_EVENT = 'arcane.dom.interaction'
```

Listen on the EventManager to update a debugger in real time. DOM instrumentation defaults `captureEventDetails`, `captureInputValues`, and `captureNodeMarkup` to `true`, preserving complete non-private interaction details and values. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or a DOM-compatible test host; constant imports in Node.** Target, path, flags, and enabled details are normalized diagnostics, not replayable browser event objects.

### Example

```javascript
import {DOM_INTERACTION_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(DOM_INTERACTION_EVENT, diagnostic => {
    console.log(diagnostic.eventType, diagnostic.target?.selector);
});
```

## DOM_MUTATION_EVENT

### Overview

The event name used for normalized attribute, character-data, and child-list mutation diagnostics. It lets review tools correlate observable DOM changes with the interaction that preceded them.

### Value and use

```text
const DOM_MUTATION_EVENT = 'arcane.dom.mutation'
```

Mutation capture uses `MutationObserver` and is enabled by default when DOM instrumentation starts. Complete non-private markup, text, selectors, and URLs are preserved by default; private elements and credential-like attribute-mutation values remain redacted. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or a DOM-compatible test host; constant imports in Node.** The payload is a complete credential-protected diagnostic projection and cannot reconstruct or authorize changes to the DOM.

### Example

```javascript
import {DOM_MUTATION_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(DOM_MUTATION_EVENT, mutation => {
    console.log(mutation.mutationType, mutation.target?.selector);
});
```

## DOM_OBSERVATION_STARTED_EVENT

### Overview

The lifecycle event emitted after the requested DOM listeners and mutation observer start successfully. The payload identifies the root and records the active capture options.

### Value and use

```text
const DOM_OBSERVATION_STARTED_EVENT = 'arcane.dom.observation.started'
```

A failed start cleans up partial listeners and does not emit this event. The event is recorded only when the owning EventManager currently has time travel enabled. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or a DOM-compatible test host; constant imports in Node.** The payload is a normalized diagnostic of configuration, not proof of host capability outside the current controller.

### Example

```javascript
import {DOM_OBSERVATION_STARTED_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.once(DOM_OBSERVATION_STARTED_EVENT, state => {
    console.log(state.eventTypes.length);
});
```

## DOM_OBSERVATION_STOPPED_EVENT

### Overview

The lifecycle event emitted after normal shutdown of active DOM observation. It supports debugger state and teardown assertions without exposing listener internals.

### Value and use

```text
const DOM_OBSERVATION_STOPPED_EVENT = 'arcane.dom.observation.stopped'
```

Calling `stop()` when already inactive is idempotent and emits nothing. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or a DOM-compatible test host; constant imports in Node.** Its root payload is a normalized descriptor and contains no live DOM node.

### Example

```javascript
import {DOM_OBSERVATION_STOPPED_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(DOM_OBSERVATION_STOPPED_EVENT, ({root}) => {
    console.log(root?.kind);
});
```

## EventManager

### Overview

A synchronous pub/sub manager with opt-in complete time-travel recording, strict event-stack import/export, cursor review, playback, and optional DOM instrumentation. Create an instance for an isolated subsystem or use `arcaneEvents` for the package singleton.

### Syntax and result

```text
new EventManager({
    timeTravel=false,
    dom=null,
    captureStacks=false,
    secure=false,
    redactSensitive=secure,
    clock=()=>new Date(),
    now,
    sessionId
}={})
```

Listeners receive the original live arguments synchronously. When recording is enabled, the manager separately stores complete deeply frozen snapshots, parent/causation structure, timing, status, and error detail. Ordinary `secure:false, redactSensitive:false` preserves complete URLs, public details, and captured stack text while credential-named fields remain `[REDACTED]`; `captureStacks` defaults to `false`. Optional URL redaction requires `secure:true, redactSensitive:true`. Legacy maximum options remain accepted for compatibility but do not cap, clip, tail, truncate, or elide content. See the [central events guide](event-manager.md) for every getter, method, default, failure, and recovery path. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler; DOM capture requires a compatible DOM.** Pub/sub is host-neutral. Recorded values are normalized snapshots; live payload identity and listener side effects remain application-defined.

### Example

```javascript
import {EventManager} from 'arcane-os/event-manager';

const events = new EventManager({timeTravel:true});
events.on('cart.updated', cart => console.log(cart.total));
events.emit('cart.updated', {total:42});
console.log(events.history.at(-1).status);
```

## PLAYBACK_CANCELLED_EVENT

### Overview

The playback lifecycle event emitted when an AbortSignal aborts an active review. Its frozen summary reports the source session, number delivered, current cursor, `completed:false`, and complete credential-protected error detail.

### Value and use

```text
const PLAYBACK_CANCELLED_EVENT = 'arcane.time-travel.playback.cancelled'
```

The playback promise rejects with the abort reason after emitting this event. Already delivered callbacks or event handlers are not rolled back. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The lifecycle summary is normalized; cancellation remains cooperative and local to playback.

### Example

```javascript
import {PLAYBACK_CANCELLED_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(PLAYBACK_CANCELLED_EVENT, result => {
    console.log(result.delivered, result.completed);
});
```

## PLAYBACK_COMPLETED_EVENT

### Overview

The playback lifecycle event emitted after every selected record and `onRecord` callback completes. The same frozen summary shape is returned from `playback()`.

### Value and use

```text
const PLAYBACK_COMPLETED_EVENT = 'arcane.time-travel.playback.completed'
```

Completion means the local review loop finished. It does not mean original external side effects were reproduced, acknowledged, or committed. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** Session, delivered count, cursor, and completion state are normalized.

### Example

```javascript
import {PLAYBACK_COMPLETED_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.once(PLAYBACK_COMPLETED_EVENT, result => {
    console.log(`Reviewed ${result.delivered} records`);
});
```

## PLAYBACK_FAILED_EVENT

### Overview

The playback lifecycle event emitted when parsing, timing, event delivery, or the caller's `onRecord` callback fails for a non-cancellation reason. The playback promise then rejects with the original error.

### Value and use

```text
const PLAYBACK_FAILED_EVENT = 'arcane.time-travel.playback.failed'
```

The diagnostic error in the lifecycle payload is complete credential-protected detail and may not preserve object identity. Ordinary mode preserves URLs and captured stack text; explicit secure redaction may replace URLs. Records delivered before failure are not undone. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The failure summary is normalized with credential-named fields protected; the thrown error remains the local failure value.

### Example

```javascript
import {PLAYBACK_FAILED_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(PLAYBACK_FAILED_EVENT, result => {
    console.error(result.error);
});
```

## PLAYBACK_RECORD_EVENT

### Overview

The event emitted once per selected stack record in the safe default `review` playback mode. Debuggers can render the immutable record without re-emitting the record's original application event.

### Value and use

```text
const PLAYBACK_RECORD_EVENT = 'arcane.time-travel.playback.record'
```

Use `review` for inspection. `mode:'events'` deliberately re-emits original types and payload snapshots and can trigger application side effects; `mode:'none'` invokes only `onRecord`. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** Each delivered value is a validated immutable `arcane-event-stack/1` record.

### Example

```javascript
import {PLAYBACK_RECORD_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(PLAYBACK_RECORD_EVENT, record => {
    console.log(record.sequence, record.type, record.status);
});
```

## PLAYBACK_STARTED_EVENT

### Overview

The lifecycle event emitted before the first selected record is delivered. It reports the source session, selected count and range, playback speed, and delivery mode.

### Value and use

```text
const PLAYBACK_STARTED_EVENT = 'arcane.time-travel.playback.started'
```

The event is emitted even when the selected range contains no records; a successful empty review then completes with `delivered:0`. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The lifecycle payload is a normalized local playback summary.

### Example

```javascript
import {PLAYBACK_STARTED_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(PLAYBACK_STARTED_EVENT, run => {
    console.log(run.mode, run.count);
});
```

## TIME_TRAVEL_SEEK_EVENT

### Overview

The event emitted when `seek()` moves the review cursor. Its payload carries the current session, requested sequence, and the matching retained record—or `null` for sequence zero or an unretained sequence gap.

### Value and use

```text
const TIME_TRAVEL_SEEK_EVENT = 'arcane.time-travel.seek'
```

Seeking never dispatches the selected record's original type and never mutates history. It is a review cursor operation only. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The cursor payload is normalized and contains an immutable retained record when one exists.

### Example

```javascript
import {TIME_TRAVEL_SEEK_EVENT, arcaneEvents} from 'arcane-os/event-manager';

arcaneEvents.on(TIME_TRAVEL_SEEK_EVENT, ({sequence}) => {
    console.log('Cursor:', sequence);
});
```

## arcaneEvents

### Overview

The one SDK-owned synchronous semantic event authority in the current
JavaScript realm. Module evaluation installs or reuses the exact branded value
at `globalThis.arcaneEvents`; duplicate module URLs do not create another bus.
Window, frame, worker, Node realm, and process boundaries remain distinct and
have no automatic transport between them.

### Value and use

```text
globalThis.arcaneEvents === arcaneEvents
arcaneEvents.protocol === 'arcane-event-authority/1'
arcaneEvents[Symbol.for('arcane-os.arcane-events-authority')]
    === 'arcane-event-authority/1'
```

The global is an own, non-enumerable, non-writable, non-configurable data
property. Its brand and public protocol descriptors are immutable. An accessor,
inherited or unbranded value, mismatched descriptor/protocol, incomplete API,
or failed installation is rejected with its exact
`ARCANE_EVENT_AUTHORITY_*` code; the SDK never replaces the collision.

Canonical subscription is
`arcaneEvents.subscribe(type,handler,{once=false,signal}={})`. It returns an
idempotent `unsubscribe` function with
`unsubscribe.dispose === unsubscribe`. An already-aborted signal installs
nothing; later abort removes the registration synchronously. `handler` receives
one frozen `arcane-event-occurrence/1`, and wildcard subscription is not
admitted.

The source factory signatures are:

```text
arcaneEvents.createSource(owner,{source,eventTypes,onListenerError?})
createArcaneEventSource(owner,{source,eventTypes,onListenerError?})
```

The exported wrapper calls the authority method and returns the same frozen
handle. One owner may have one active source. The handle exposes
`protocol`, `descriptor`, `source`, `instanceId`, `eventTypes`, `disposed`,
`subscribe`, `on`, `once`, `addEventListener`, `removeEventListener`,
`dispatch`, `dispatchEvent`, `dispose`, and `destroy`.
`onListenerError(error,errorOccurrence)` receives the raw listener failure and
the canonical listener-error occurrence at the owner-local boundary;
`errorOccurrence` is `null` only when that secondary publication could not be
constructed.

`source.dispatch(type,compatibilityDetail,{operationId=null,publicDetail={},
cancelable=false}={})` synchronously returns the frozen
`{occurrence,accepted}` publication. The occurrence contains immutable
`protocol`, `occurrenceId`, `type`, `source`, `instanceId`, `operationId`,
complete credential-protected deeply frozen `detail`, `cancelable`, live
`defaultPrevented`, and `preventDefault()`. Canonical listeners run before the
source's EventTarget-compatible listeners. Cancellation is synchronous and only
sets acceptance; the publisher decides whether to begin or continue domain work.

Listener promises are not awaited. The authority is not an async queue:
operation-owned promises and `createEventQueue()` own async ordering,
backpressure, cancellation, and failure. Listener exceptions are observational;
they publish one privacy-safe `arcane.event.listener.error` occurrence with code
`ARCANE_EVENT_LISTENER_CALLBACK_FAILED` and do not throw from committed source
dispatch.

`ARCANE_EVENT_ERROR_CODES` is frozen and maps each stable key to that identical
string value: `ARCANE_EVENT_AUTHORITY_ACCESSOR_COLLISION`,
`ARCANE_EVENT_AUTHORITY_VALUE_COLLISION`,
`ARCANE_EVENT_AUTHORITY_DESCRIPTOR_MISMATCH`,
`ARCANE_EVENT_AUTHORITY_PROTOCOL_MISMATCH`,
`ARCANE_EVENT_AUTHORITY_API_MISMATCH`,
`ARCANE_EVENT_AUTHORITY_INSTALL_FAILED`, `ARCANE_EVENT_SOURCE_INVALID`,
`ARCANE_EVENT_SOURCE_ALREADY_REGISTERED`, `ARCANE_EVENT_SOURCE_DISPOSED`,
`ARCANE_EVENT_SOURCE_EVENT_TYPE_UNDECLARED`,
`ARCANE_EVENT_COMPATIBILITY_DETAIL_INVALID`, `ARCANE_EVENT_OCCURRENCE_INVALID`,
`ARCANE_EVENT_OCCURRENCE_SEQUENCE_EXHAUSTED`,
`ARCANE_EVENT_SOURCE_SEQUENCE_EXHAUSTED`,
`ARCANE_EVENT_LISTENER_CALLBACK_FAILED`, `ARCANE_EVENT_DOM_DETAIL_COLLISION`,
`ARCANE_EVENT_DOM_TARGET_INVALID`, `ARCANE_EVENT_DOM_OPTIONS_INVALID`,
`ARCANE_EVENT_SUBSCRIPTION_TYPE_INVALID`,
`ARCANE_EVENT_SUBSCRIPTION_HANDLER_INVALID`,
`ARCANE_EVENT_SUBSCRIPTION_OPTIONS_INVALID`,
`ARCANE_EVENT_SUBSCRIPTION_SIGNAL_INVALID`, and
`ARCANE_EVENT_DISPATCH_EVENT_INVALID`. Thrown authority failures expose the
matching value as `error.code`; the listener callback code is carried by its
observational error occurrence.

`projectArcaneDOMEvent(target,occurrence,{type,bubbles=false,composed=false,
cancelable=occurrence.cancelable}={})` is a one-way compatibility projection.
Its frozen detail carries `occurrenceId`, `arcaneSource`, `instanceId`, and
`operationId`; it never republishes the DOM event. DOM cancellation propagates
back to a cancelable occurrence. `isArcaneEventOccurrence(value)` recognizes
only canonical occurrences and source compatibility views created by this
realm's authority.

The first `source.dispose()`/`destroy()` publishes the final noncancelable
`arcane.event.source.disposed` occurrence, removes source-owned listeners, frees
the owner for a new source, and returns `true`; later or reentrant calls return
`false`. The deprecated `aiRuntimeEvents` export is a frozen, state-free
EventTarget compatibility view over the AIRuntimeState source, not another event
owner.

### Availability and normalization

**Node and browser/bundler, once per JavaScript realm; DOM projection requires
`CustomEvent` and a target with `dispatchEvent`.** Canonical public detail is
defensively snapshotted and deeply frozen. Rich compatibility detail remains
owner-local and is shallow-frozen only when it is a plain record or array.

### Example

```javascript
import {arcaneEvents, createArcaneEventSource} from 'arcane-os/event-manager';

const owner = {};
const source = createArcaneEventSource(owner, {
    source:'sdk.operation',
    eventTypes:['sdk.operation.completed']
});
const unsubscribe = arcaneEvents.subscribe(
    'sdk.operation.completed',
    occurrence => console.log(occurrence.detail.operationId)
);
source.dispatch(
    'sdk.operation.completed',
    Object.freeze({operationId:'operation-1'}),
    {operationId:'operation-1', publicDetail:{operationId:'operation-1'}}
);
unsubscribe.dispose();
source.dispose();
```

## ARCANE_EVENT_AUTHORITY_BRAND

### Overview

Global registry symbol that brands the one compatible Arcane event authority in
a JavaScript realm.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_BRAND
```

Its exact value is `Symbol.for('arcane-os.arcane-events-authority')`.

### Availability and normalization

**Node and browser/bundler.** The brand property is immutable and
non-enumerable. It is a compatibility marker, not transport or authenticity.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_BRAND,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents[ARCANE_EVENT_AUTHORITY_BRAND]);
```

## ARCANE_EVENT_AUTHORITY_KIND

### Overview

Stable kind discriminator for the frozen authority descriptor.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_KIND
```

Its exact value is `arcane-event-authority`.

### Availability and normalization

**Node and browser/bundler.** Reading it creates no authority or listener.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_KIND,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents.descriptor.kind===ARCANE_EVENT_AUTHORITY_KIND);
```

## ARCANE_EVENT_AUTHORITY_PROTOCOL

### Overview

Stable protocol discriminator for compatible per-realm event authorities.

### Value and import

```text
const ARCANE_EVENT_AUTHORITY_PROTOCOL
```

Its exact value is `arcane-event-authority/1`.

### Availability and normalization

**Node and browser/bundler.** An incompatible installed protocol fails closed
and is never replaced or wrapped.

### Example

```javascript
import {ARCANE_EVENT_AUTHORITY_PROTOCOL,arcaneEvents} from 'arcane-os/event-manager';
console.log(arcaneEvents.protocol===ARCANE_EVENT_AUTHORITY_PROTOCOL);
```

## ARCANE_EVENT_ERROR_CODES

### Overview

Frozen registry of every stable canonical event-authority failure code.

### Value and import

```text
const ARCANE_EVENT_ERROR_CODES
```

Every key maps to its identical string value; thrown authority failures expose
the matching value as `error.code`.

### Availability and normalization

**Node and browser/bundler.** The registry contains no mutable registration API
or vague fallback code.

### Example

```javascript
import {ARCANE_EVENT_ERROR_CODES} from 'arcane-os/event-manager';
console.log(ARCANE_EVENT_ERROR_CODES.ARCANE_EVENT_SOURCE_DISPOSED);
```

## ARCANE_EVENT_LISTENER_ERROR_EVENT

### Overview

Canonical observational event emitted when an event listener throws.

### Value and import

```text
const ARCANE_EVENT_LISTENER_ERROR_EVENT
```

Its exact value is `arcane.event.listener.error`.

### Availability and normalization

**Node and browser/bundler.** Frozen public detail carries the exact failure code
and source occurrence identifiers, never the raw error. Its shape is exactly
`{code:'ARCANE_EVENT_LISTENER_CALLBACK_FAILED',reason:'listener-threw',
eventType,occurrenceId,source,instanceId,operationId}`. Publication is
synchronous and nonrecursive.

### Example

```javascript
import {ARCANE_EVENT_LISTENER_ERROR_EVENT,arcaneEvents} from 'arcane-os/event-manager';
const unsubscribe=arcaneEvents.subscribe(ARCANE_EVENT_LISTENER_ERROR_EVENT,console.log);
```

## ARCANE_EVENT_OCCURRENCE_PROTOCOL

### Overview

Stable protocol discriminator for immutable canonical occurrences.

### Value and import

```text
const ARCANE_EVENT_OCCURRENCE_PROTOCOL
```

Its exact value is `arcane-event-occurrence/1`.

### Availability and normalization

**Node and browser/bundler.** Occurrences are realm-owned identity values with
deeply frozen public detail and synchronous cancellation state.

### Example

```javascript
import {ARCANE_EVENT_OCCURRENCE_PROTOCOL} from 'arcane-os/event-manager';
console.log(publication.occurrence.protocol===ARCANE_EVENT_OCCURRENCE_PROTOCOL);
```

## ARCANE_EVENT_SOURCE_DISPOSED_EVENT

### Overview

Final noncancelable occurrence published during a source's first disposal.

### Value and import

```text
const ARCANE_EVENT_SOURCE_DISPOSED_EVENT
```

Its exact value is `arcane.event.source.disposed`.

### Availability and normalization

**Node and browser/bundler.** Public detail is exactly
`{reason:'source-disposed'}`. Delivery precedes source-listener cleanup;
reentrant or later disposal publishes nothing and returns `false`.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_DISPOSED_EVENT} from 'arcane-os/event-manager';
source.once(ARCANE_EVENT_SOURCE_DISPOSED_EVENT,console.log);
source.dispose();
```

## ARCANE_EVENT_SOURCE_KIND

### Overview

Stable kind discriminator for frozen source descriptors.

### Value and import

```text
const ARCANE_EVENT_SOURCE_KIND
```

Its exact value is `arcane-event-source`.

### Availability and normalization

**Node and browser/bundler.** Reading it does not register or dispose a source.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_KIND} from 'arcane-os/event-manager';
console.log(source.descriptor.kind===ARCANE_EVENT_SOURCE_KIND);
```

## ARCANE_EVENT_SOURCE_PROTOCOL

### Overview

Stable protocol discriminator for frozen source handles and descriptors.

### Value and import

```text
const ARCANE_EVENT_SOURCE_PROTOCOL
```

Its exact value is `arcane-event-source/1`.

### Availability and normalization

**Node and browser/bundler.** One handle belongs to one active owner in one
realm and declares every publishable type before use.

### Example

```javascript
import {ARCANE_EVENT_SOURCE_PROTOCOL} from 'arcane-os/event-manager';
console.log(source.protocol===ARCANE_EVENT_SOURCE_PROTOCOL);
```

## createArcaneEventSource()

### Overview

Registers one active declared semantic source for a non-null object or function
owner on the installed per-realm authority.

### Signature and result

```text
createArcaneEventSource(owner, options)
```

`options` is the closed data record `{source,eventTypes,onListenerError?}`. The
result is one frozen `arcane-event-source/1` handle with synchronous
subscription, publication, cancellation admission, EventTarget compatibility,
and idempotent disposal. A second active source for the same owner fails with
`ARCANE_EVENT_SOURCE_ALREADY_REGISTERED`.

### Availability and normalization

**Node and browser/bundler, within the current JavaScript realm.** The wrapper
reuses `globalThis.arcaneEvents`; it creates no second bus, queue, Worker, or
transport. Provider or host work remains owned by its own promise and signal.

### Example

```javascript
import {createArcaneEventSource} from 'arcane-os/event-manager';
const source=createArcaneEventSource({}, {
    source:'sdk.example',
    eventTypes:['sdk.example.completed']
});
source.dispose();
```

## isArcaneEventOccurrence()

### Overview

Recognizes canonical occurrences and source compatibility views created by the
current realm's authority.

### Signature and result

```text
isArcaneEventOccurrence(value)
```

Returns a boolean. Structurally similar or protocol-shaped foreign values return
`false`.

### Availability and normalization

**Node and browser/bundler, within the current JavaScript realm.** Recognition
is synchronous and identity-based, with no parsing, cloning, or transport.

### Example

```javascript
import {isArcaneEventOccurrence} from 'arcane-os/event-manager';
console.log(isArcaneEventOccurrence(publication.occurrence));
```

## projectArcaneDOMEvent()

### Overview

Projects one authority-created occurrence to one `CustomEvent` without
republishing the DOM event into the canonical authority.

### Signature and result

```text
projectArcaneDOMEvent(target, occurrence, options)
```

The result is the combined DOM/canonical acceptance boolean. Frozen projection
detail adds the occurrence, canonical source, source instance, and operation
identifiers while preserving a caller-owned compatibility `source`. A
pre-cancelled occurrence skips DOM dispatch; DOM cancellation propagates only
to a cancelable occurrence.

### Availability and normalization

**Browser DOM or a DOM-compatible host with `CustomEvent` and
`dispatchEvent`.** Projection is synchronous, state-free, and one-way.

### Example

```javascript
import {projectArcaneDOMEvent} from 'arcane-os/event-manager';
projectArcaneDOMEvent(button,publication.occurrence,{bubbles:true});
```

## createDOMInstrumentation()

### Overview

Creates a frozen controller that projects DOM interactions and mutations into an EventManager. The returned controller owns `start()`, `stop()`, `active`, `observedRootCount`, and the configured `root`.

### Syntax and result

```text
createDOMInstrumentation({
    eventManager,
    root=document,
    eventTypes=DEFAULT_DOM_EVENT_TYPES,
    MutationObserver,
    captureEventDetails=true,
    captureInputValues=true,
    captureNodeMarkup=true,
    captureMutations=true,
    observeOpenShadowRoots=true
}={})
```

The factory validates configuration but does not start automatically. Its three content-capture flags default to `true`, so complete non-private values, markup, selectors, URLs, and object details are retained. Private elements and credential-like attribute-mutation values remain redacted; later EventManager snapshots also protect credential-named object fields. Callers may explicitly disable an individual capture flag to omit that content. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or a DOM-compatible test host.** It normalizes diagnostics only; it does not serialize a complete DOM or synthesize browser interactions during review.

### Example

```javascript
import {createDOMInstrumentation, EventManager} from 'arcane-os/event-manager';

const events = new EventManager({timeTravel:true});
const observation = createDOMInstrumentation({eventManager:events, root:document});
observation.start();
// Later: observation.stop();
```

## createEventManager()

### Overview

Constructs an independent EventManager using the same options and validation as the class constructor. Prefer it when factory-based dependency injection reads more clearly than `new EventManager()`.

### Syntax and result

```text
createEventManager(options)
```

The returned manager does not share listeners, history, session, cursor, DOM controller, or retention state with `arcaneEvents` or any other instance. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler; DOM capture requires a compatible DOM.** Constructor validation and snapshot normalization are identical to `EventManager`.

### Example

```javascript
import {createEventManager} from 'arcane-os/event-manager';

const events = createEventManager({timeTravel:true, sessionId:'checkout-test'});
events.instrument('checkout.started', {cartId:'cart-1'}, {source:'test'});
```

## describeDOMTarget()

### Overview

Returns a frozen content-free descriptor for a document, shadow root, text node, element, global object, or generic event target. It is useful for diagnostic UI and behavioral assertions without retaining the target.

### Syntax and result

```text
describeDOMTarget(target, root)
```

Element descriptors include a best-effort selector, tag, id, role, name, type, and private marker. Text descriptors never include text content; shadow-root descriptors may include their host descriptor. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or DOM-compatible objects; importable in Node.** The result is a normalized diagnostic identity, not a stable locator or capability token.

### Example

```javascript
import {describeDOMTarget} from 'arcane-os/event-manager';

const descriptor = describeDOMTarget(document.querySelector('button'), document);
console.log(descriptor.selector, descriptor.role);
```

## domSelector()

### Overview

Builds a best-effort diagnostic selector from IDs, Arcane/test IDs, element names, and sibling positions. Open shadow-root boundaries are separated with ` >>> `.

### Syntax and result

```text
domSelector(target, root)
```

The helper returns `:document`, `:shadow-root`, an element selector, a text node's parent selector, or `null` for an unsupported target. Generated selectors are for diagnostics and are not guaranteed unique after DOM changes. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or DOM-compatible objects; importable in Node.** Selector text is normalized locally and grants no access to the described target.

### Example

```javascript
import {domSelector} from 'arcane-os/event-manager';

console.log(domSelector(document.activeElement, document));
```

## parseEventStack()

### Overview

Parses a JSON string or object and strictly validates an `arcane-event-stack/1` document. It returns a deeply frozen canonical data object suitable for review or playback.

### Syntax and result

```text
parseEventStack(source)
```

Validation rejects unknown keys, accessors, sparse arrays, unsafe values, invalid timestamps/statuses/nesting, inconsistent sessions/protocols, and non-increasing sequences. It preserves the complete valid event history. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The result is canonical immutable diagnostic data. Parsing never dispatches events, restores live objects, or confers host authority.

### Example

```javascript
import {parseEventStack} from 'arcane-os/event-manager';

const stack = parseEventStack(serialized);
console.log(stack.sessionId, stack.events.length);
```

## BROWSER_WASM_RUNTIME_AUTHORITY

### Overview

Mutable metadata for the browser-only runtime behind
`arcane-os/ai/browser-wasm`. It records protocol
`arcane-ai-browser-wasm/2`, `@wllama/wllama` `3.6.0`, the embedded llama.cpp
revision, the exact packaged JavaScript and WebAssembly assets, retained MIT
licenses, and the disabled compatibility-runtime/remote-model-helper policy.
Its execution policy requires WebGPU, proves full model offload, and declares
`cpuFallback:false`. It contains no model weights or default model catalog.

### Value and import

```text
const BROWSER_WASM_RUNTIME_AUTHORITY
```

The value is available from `arcane-os/ai/browser-wasm` only. Importing and
inspecting it does not initialize Wllama, request storage, or download a model.

### Availability and normalization

**Browser metadata.** This is component metadata, not a provider,
model, browser-permission grant, or proof that WebAssembly, OPFS, a secure
context, or WebGPU is available.

### Example

```javascript
import {BROWSER_WASM_RUNTIME_AUTHORITY} from 'arcane-os/ai/browser-wasm';

console.log(BROWSER_WASM_RUNTIME_AUTHORITY.protocol);
console.log(BROWSER_WASM_RUNTIME_AUTHORITY.package.version);
```

Complete lifecycle, model authority, cache, cancellation, and tool behavior:
[Browser-WASM local AI](ai/browser-wasm.md).

## completeValueText()

### Overview

Returns complete caller content as text. Strings are returned unchanged;
supported non-string values become readable JSON text without clipping, with
explicit representations for cycles, special primitives, maps, sets, dates,
regular expressions, typed views, buffers, functions, symbols, and accessors.

### Signature and result

```text
completeValueText(value)
```

Import it from `arcane-os/ai/browser-wasm`. The function reads no provider,
model, cache, or browser capability.

### Availability and normalization

**Browser or compatible JavaScript module host.** Complete strings remain exact;
other supported values normalize to complete readable JSON text.

### Example

```javascript
import {completeValueText} from 'arcane-os/ai/browser-wasm';

console.log(completeValueText({content:'Complete response'}));
```

## createArcaneAI()

### Overview

Creates the application-facing AI API module around a compatible provider or
controller. The default `on-demand` policy loads before first use; `manual`
requires an explicit successful `load()` before requests. When both `llm` and
`provider` are supplied, `llm` takes precedence.

### Signature and result

```text
createArcaneAI({ llm=null, provider=null, loadPolicy='on-demand', security }={})
```

At least one `llm` or `provider` is required. The mutable API object contains
`llm`, `runtime`, `createChatSession`, `status`, `load`, `unload`, `probe`,
`fetchRequest`, `streamRequest`, and `dispose`. `status()` returns
`{llm: status}`; lifecycle methods return the flat LLM status.
`fetchRequest()` returns the completion. `streamRequest()` consumes streaming,
delivers every choice's ordinary content/reasoning values in provider order,
and returns ordinary terminal text for one choice, a structural-call array for
selected tool output, or complete JSON text for a multi-choice completion.
`onDataChunk` and `onDataResult` preserve the complete provider chunk and
terminal record independently of that application-facing projection. Use
`ai.llm.stream()` for the async iterator; structural fragments remain private
until the complete terminal result validates.

When `llm` is an existing `ModelController`, it retains the load policy chosen
when that controller was created. `createArcaneAI()` does not reapply its
`loadPolicy` argument in that case. Provider input creates a new controller and
applies the supplied `loadPolicy`.

`createChatSession(options)` asynchronously imports the private managed
`#arcane/persistent-ai-chat-session` specifier, resolves a
`Promise<PersistentAIChatSession>`, and binds its AI API to this exact
controller. Applications continue to use this public controller method rather
than importing that private specifier. `options` must be a plain object and cannot contain
`chat`. The resulting session preserves coherent complete live context while
letting each user/assistant/tool turn choose matching durable ChatEntity/DBOPFS
persistence; `persist:false` does not write that turn to durable history or
memory. There is no storage or provider fallback.

The session's `stream()` uses this controller's streaming transport when
available and otherwise completes the same atomic turn through its configured
non-stream request; lack of optional streaming is not a protocol error.
Per-turn `request` options merge over the session defaults while messages and
the caller signal remain session-owned. A visibility-only consumer can submit
one atomic result batch for every pending tool-call ID with
`request:{toolChoice:'none'}` so the continuation cannot open another tool loop,
without calling Wllama directly. A terminal-only structural call is valid. Each
call observed during streaming is published only after its choice, ordered
position, exact ID, type, name, argument string, and extension fields match the
terminal response; omission or divergence rejects with
`AI_CHAT_STREAM_TOOL_CALL_MISMATCH` before persistence or commit.

### Availability and normalization

**Browser.** It normalizes lifecycle, `statechange` and `progress` observation,
lazy/manual use, cancellation, completions, and structural tool-call
visibility. It neither selects a provider fallback nor executes an application
tool. Persistent sessions additionally require ChatEntity/DBOPFS in the
managed browser runtime.

`ai.llm.addEventListener(type,listener,options)` and
`removeEventListener(type,listener,options)` are EventTarget compatibility
views over `globalThis.arcaneEvents`; null/non-listener callbacks and event names
other than `statechange` or `progress` are compatibility no-ops.
`ai.llm.on(type,listener)` installs through that same view and returns
one idempotent removal closure whose `.dispose` property is that same closure.
The controller exposes no public `dispatchEvent()` and
therefore does not let consumers forge lifecycle occurrences. Compatibility
listeners receive the mutable full status snapshot as `event.detail` with the controller
as `this`, `target`, and `currentTarget`. Canonical `statechange` and `progress`
occurrences use source `ai-model-controller`; every load or unload owns one
non-null operation ID shared by its state and progress occurrences. Public
progress retains the exact selected `modelId`, `phase`, state, and nested
file-progress field names without byte totals. Accessor-bearing provider status
and malformed progress reject with `ARCANE_AI_PROVIDER_STATUS_INVALID` and
`ARCANE_AI_PROVIDER_PROGRESS_INVALID`. After disposal, lifecycle operations fail with
`ARCANE_AI_DISPOSED`.

### Example

```javascript
const ai = createArcaneAI({provider, loadPolicy:'manual'});
async function openLocalReviewAfterUserChoice() {
    const stop = ai.llm.on('progress', event => renderProgress(event.detail));
    try {
        await ai.load({offline:true});
    } finally {
        stop();
    }
    return ai.createChatSession({
        chatFileName:'local-review.jsonl',
        loadExisting:true
    });
}
```

## createBrowserModelSource()

### Overview

Validates a caller-owned ordered model-file descriptor and creates the
cancellable HTTPS source accepted by the browser-WASM store/provider. The
canonical descriptor is `{id,files:[{name?,url},...]}`. The nonempty file array
has unique normalized names and URLs. The one-file `{id,url,name?}` shape also
normalizes to one ordered member.

### Signature and result

```text
createBrowserModelSource(descriptor, { fetchImpl=null }={})
```

Every URL must be absolute HTTPS with no credentials or fragment. Use a
caller-selected version-pinned URL when reproducibility matters. The mutable
source exposes `kind`, the canonical descriptor fields, `descriptor`, and
`open(memberIndex,{signal})`.
For a one-file source, `open({signal})` remains accepted. The result is
`{body,requestedUrl,finalUrl,cancel}`. Every direct `open()` performs the
configured fetch and preserves the complete response body subject only to
unavoidable HTTP framing.

Legacy `immutableUrl` remains an input alias for `url`; both must match when
supplied together. Legacy `licenseSpdx` and `sourceRevision` properties are not
ordinary runtime gates or proof of license rights.

### Availability and normalization

**Browser Fetch with CORS and a readable response body.** Downloads omit
credentials/referrer, disable HTTP caching, follow redirects, require a final
HTTPS URL, and honor `AbortSignal`. The DBOPFS store preserves complete model
content without counting, limiting, hashing, digesting, or byte-identifying it
in the ordinary path.

### Example

```javascript
const source = createBrowserModelSource({
    id:'reviewed-model',
    files:[{
        name:'model-q4-00001-of-00002.gguf',
        url:'https://models.example/releases/4f7c/model-q4-00001-of-00002.gguf'
    },{
        name:'model-q4-00002-of-00002.gguf',
        url:'https://models.example/releases/4f7c/model-q4-00002-of-00002.gguf'
    }]
});
```

## createBrowserWasmLlmProvider()

### Overview

Creates the packaged Wllama provider from genuine source and store objects
created by this module. Structural lookalikes are rejected. It serializes
requests and exposes provider states `unloaded`, `loading`, `ready`,
`unloading`, and `error`.

### Signature and result

```text
createBrowserWasmLlmProvider({ source, sources, store, loadDefaults={}, security, logger=console }={})
```

`sources` is a nonempty array of unique SDK-created sources. Optional legacy
`source` names the default and must be one member of `sources`; when `sources`
is omitted, `source` supplies the one-model catalog. The mutable provider
exposes `protocol`, `id`, default `model`, `catalog`, `capabilities`, `status`,
`load`, `unload`, `chat`, `stream`, `streamChat`, `use`, `probe`, and `dispose`.
Direct `load()` selects a catalog model and returns `{model,status}`; the
public AI API module's `ai.load()` returns the flat controller status. Load settings include
offline mode, `AbortSignal`, progress, threads, and context/batch/micro-batch
tokens. The runtime always forces `gpuLayers:99999`; callers cannot request CPU
or partial offload.

Chat supports OpenAI-like message/generation fields, tools, tool choice,
parallel tool-call preference, and JSON/JSON-Schema structured output.
`stream()` returns a mutable async iterator with `result` and `cancel(reason)`.
Direct chat and stream ingress validate complete history, require one nonblank
matching tool result for every pending ID, and validate every terminal choice.
Ordinary stream iteration preserves complete content/reasoning projections from
every choice in provider order while withholding structural deltas; the exact
validated terminal calls and every completion choice remain on `result`.
Every function declaration requires
`parameters.properties.message:{type:'string',minLength:1}` and includes
`message` in `required`. Returned calls preserve exact IDs, names, and
JSON-string arguments containing that nonempty user-facing message. The SDK
never invokes a handler or executes a tool; a matching executed, declined,
cancelled, or not-executed `role:'tool'` result is required before another user
turn.

### Availability and normalization

**Browser context with WebAssembly, OPFS/DBOPFS, and WebGPU.** A load succeeds
after Wllama confirms the complete model is loaded. There is no CPU fallback.
Cross-origin isolation and coarse hardware fields remain observations rather
than hard gates. Ordinary status reports complete catalog compatibility and
lifecycle state. Adapter selection is instrumented as
`arcane.ai.browser-wasm.webgpu.adapter.selected`.
Cancellation normalizes to `ARCANE_AI_REQUEST_ABORTED`; load or availability failures
surface stable `ARCANE_AI_*` codes such as `ARCANE_AI_WEBGPU_REQUIRED`,
`ARCANE_AI_MODEL_FULL_OFFLOAD_UNPROVEN`, and
`ARCANE_AI_MODEL_GPU_MEMORY_INSUFFICIENT`. Concurrent runtime inference can fail
`ARCANE_AI_RUNTIME_BUSY`; inspection and status can report
`ARCANE_AI_PROVIDER_UNAVAILABLE` or fallback `ARCANE_AI_RUNTIME_FAILED` without
misrepresenting those observations as a successful load.

### Example

```javascript
const provider = createBrowserWasmLlmProvider({
    sources:[source],
    store,
    loadDefaults:{threads:1, contextTokens:4096}
});
console.log(provider.status().state); // unloaded
```

## createDbopfsModelStore()

### Overview

Adapts an existing DBOPFS instance into a complete multi-model, ordered
multi-file cache without renaming its public methods. The adapter commits every
selected model file before the completion manifest. A partial file set is not a
cache hit.

### Signature and result

```text
createDbopfsModelStore({ dbopfs, tableName='arcane_ai_browser_models', estimateStorage=null, downloadConcurrency=4 }={})
```

`downloadConcurrency` must be a positive safe integer and defaults to four.
It bounds exactly one transfer axis: ordered multi-file GGUF sources use that
many concurrent file workers, while a one-file source uses that many HTTP
Range workers only when an exact `Content-Range` probe succeeds. The mutable
result contains `kind`, `tableName`, `downloadConcurrency`, the original
`adapter`, and `ready`, `install`, `ensure`, and `remove`. `ensure()` returns
`files`, the one-file compatibility `file` or `null`, the manifest, and
`cache:'cached'|'installed'`. It preserves the complete model content.
`offline:true` never downloads and rejects a miss with
`ARCANE_AI_MODEL_OFFLINE_MISS`. Version-2/3 compatibility is internal; every
new successful completion is recorded as version 4.

### Availability and normalization

**Browser with a ready DBOPFS instance and OPFS.** Cache metadata is not a
transferable capability or license proof. Provider unload/dispose keeps all cached files;
`store.remove(source)` explicitly deletes that source's files and manifest.
For a one-file source, a server that ignores the `bytes=0-0` probe supplies the
ordinary full response directly. A missing or unreadable `Content-Range`
causes a full-fetch fallback. Confirmed ranges are read concurrently and
written through one positioned OPFS writable, with file-count progress only.
On failure or cancellation, peers settle before the partial entry is removed.

### Example

```javascript
const store = createDbopfsModelStore({dbopfs});
async function openCachedModel() {
    await store.ready();
    const cached = await store.ensure(source,{offline:true});
    console.log(cached ? 'cached' : 'cache miss');
}
```

## adaptV1LlmProvider()

### Overview

Projects one compatible v1 browser-WASM provider into the provider-neutral
LLM role consumed by the managed `arcane/AIProviderRuntime` projection. The
runtime checks the v1 protocol, required identity/methods, and local-only
capability; it does not establish ownership for an arbitrary compatible
object. The adapter does not
change the wrapped provider, download a model, create a fallback, or execute a
tool.

### Signature and result

```text
adaptV1LlmProvider(provider)
```

The mutable result is
`{protocol:'arcane-ai-provider/2',role:'llm',id,localOnly:true,catalog,inspect,
status,load,request,unload,dispose}`. `inspect()` returns an
`arcane-ai-model-authority/1` record only for an exact catalog selection.
`request()` accepts only the `chat` and `stream` operations, preserves
structural tool calls, and never invokes application handlers. Both operations
validate declaration/history ingress and terminal structural messages. The
stream wrapper privately drains the provider whether the consumer iterates or
awaits `result` first, buffers complete content/reasoning projections from every
choice in FIFO order, and validates its complete terminal result. Terminal-only
tool calls are valid; observed calls must preserve the same choice, order,
identity, argument string, and extension fields at terminal settlement. An
early consumer return starts observed provider cancellation immediately without
making iterator return wait for provider cleanup. The terminal result retains
provider settlement; any later cancellation or iterator-return failure is
reported completely to the developer console.
Re-adapting the same provider returns the same adapter object.

### Availability and normalization

**Browser; the wrapped provider retains its own secure-context, WebAssembly,
OPFS/DBOPFS, WebGPU, model, and lifecycle requirements.** The adapter normalizes
provider/2 selection and lifecycle without adding Node, native, cloud, network,
or CPU fallback behavior.

### Example

```javascript
import {adaptV1LlmProvider} from 'arcane-os/ai/browser-wasm';
import {getAIProviderRuntime} from 'arcane/AIProviderRuntime';

const runtime = getAIProviderRuntime();
const releaseProvider = runtime.register(adaptV1LlmProvider(provider));
// Configure an exact llm route before load/use.
releaseProvider();
```

# Browser speech providers

`arcane-os/ai/browser-speech` exports exactly the seven package members below.
It ships provider, authority, artifact-store, and Worker mechanisms but no
Whisper/Kokoro model weights, adapter runtime artifacts, voices, download URLs,
default catalog, CDN loader, native bridge, or cloud fallback. The providers
implement `arcane-ai-provider/2`; the managed `arcane/AIProviderRuntime` and
`arcane/AIRuntimeState` projection modules can normalize their independent
role lifecycle and observation, but are not exports of this package subpath.

## BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL

### Overview

Stable protocol identifier for an SDK-created browser speech materialization
graph. The historical `authenticated` discriminator remains for compatibility;
it identifies one complete caller-owned runtime, model, and voice routing record
but grants no provider, model, runtime, voice, network, or license authority.

### Value and import

```text
const BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL
```

Its exact value is `arcane-ai-browser-speech-artifact-graph/1`, and it is
exported only by `arcane-os/ai/browser-speech`.

### Availability and normalization

**Browser metadata; the ESM binding is importable in Node.** Reading the
constant starts no fetch, cache, Worker, provider, or event operation. Actual
artifact preparation and provider use require the selected browser storage and
Worker capabilities.

### Example

```javascript
import {
    BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL
} from 'arcane-os/ai/browser-speech';

console.log(BROWSER_SPEECH_ARTIFACT_GRAPH_PROTOCOL);
```

## BROWSER_SPEECH_ARTIFACT_PROTOCOL

### Overview

Stable protocol identifier for the optional SDK-created browser speech artifact
store. It identifies the store contract, not a model authority or capability
grant.

### Value and import

```text
const BROWSER_SPEECH_ARTIFACT_PROTOCOL
```

Its exact value is `arcane-ai-browser-speech-artifacts/1`, and it is exported
only by `arcane-os/ai/browser-speech`.

### Availability and normalization

**Browser metadata.** Importing or reading the constant starts no Worker and
downloads no model or runtime artifact. Store use additionally requires
DBOPFS/OPFS, Web Locks, and the browser APIs described below.

### Example

```javascript
import {
    BROWSER_SPEECH_ARTIFACT_PROTOCOL
} from 'arcane-os/ai/browser-speech';

console.log(BROWSER_SPEECH_ARTIFACT_PROTOCOL);
```

## createBrowserSpeechArtifactGraph()

### Overview

Normalizes one complete caller-owned browser speech materialization graph. The
caller declares runtime, model, and voice sources together with their paths,
media types, routing aliases, and model/runtime identity,
sample rate, and TTS default voice where applicable. The SDK selects none of
those values.

### Signature and result

```text
createBrowserSpeechArtifactGraph({ kind='browser-speech-authenticated-artifact-graph', security, providerId=null, role, model, runtime, files, edges, transforms }={})
```

`role` is exactly `stt` or `tts`; its model and runtime adapter fields must match
that role. Files are normalized into one functional path/source inventory, the
runtime entry and selected ONNX MJS/WASM pair must exist, and TTS voice records
must identify their selected files. Legal metadata is optional and inert; it is
never required or interpreted for runtime materialization. `edges` and
`transforms` remain mutable compatibility metadata and do not gate ordinary
routing.

The result is one mutable `arcane-ai-browser-speech-artifact-graph/1` record
containing `{protocol,kind,providerId,role,model,runtime,files,edges,transforms,
security?}`. The historical `kind` and `runtime.moduleGraph` value remains
`browser-speech-authenticated-artifact-graph` for compatibility.

### Availability and normalization

**Browser metadata; the ESM subpath is importable in Node.** Construction is
synchronous and starts no fetch, cache, Worker, provider, or event operation.
The store and provider accept SDK-created graph records so they can retain the
associated materialization metadata. Preparing and executing a graph requires
the selected DBOPFS, Web Locks, Fetch, object URL, and Worker capabilities.

### Example

```javascript
import {
    createBrowserSpeechArtifactGraph
} from 'arcane-os/ai/browser-speech';

const graph = createBrowserSpeechArtifactGraph(callerOwnedGraphDescriptor);
console.log(graph.protocol, graph.kind);
```

## createBrowserSpeechAuthority()

### Overview

Validates and returns one mutable caller-owned Whisper STT or Kokoro TTS model/runtime
selection. The application owns every model, runtime, revision, URL, voice, and
business-policy choice; the SDK supplies no artifact selection.

### Signature and result

```text
createBrowserSpeechAuthority({ providerId, role, model, runtime, security }={})
```

`role` is exactly `stt` or `tts`. `model` supplies
`{id,repository,revision,files}` and, for TTS, `defaultVoice`. `runtime`
supplies `{adapter,version,revision,entry,wasmPaths?,files}`; the adapter is
exactly `transformers-whisper` for STT or `kokoro-js` for TTS. File records use
unique relative `path`, a caller-selected `url`, and optional `mediaType`.
The runtime entry names one JavaScript module in the selected runtime.

The result is a mutable `arcane-ai-model-authority/1` record containing the
provider/model/role identity, normalized runtime and model file declarations,
and optional default voice. Construction validates the descriptor structure.

### Availability and normalization

**Browser descriptor construction; actual use requires the selected provider
Web APIs.** Credential-bearing URLs, duplicate identities, mismatched adapters,
and malformed runtime descriptors reject.

### Example

```javascript
import {createBrowserSpeechAuthority} from 'arcane-os/ai/browser-speech';

const authority = createBrowserSpeechAuthority({
    providerId:'review-whisper',
    role:'stt',
    model:{
        id:'review-whisper-model',
        repository:'caller-models',
        revision:'model-r1',
        files:[{
            path:'model.onnx',
            url:'https://models.example/model-r1/model.onnx'
        }]
    },
    runtime:{
        adapter:'transformers-whisper',
        version:'1.0.0',
        revision:'runtime-r1',
        entry:'adapter.mjs',
        files:[{
            path:'adapter.mjs',
            url:'https://runtime.example/runtime-r1/adapter.mjs',
            mediaType:'text/javascript'
        }]
    }
});
```

## createDbopfsSpeechArtifactStore()

### Overview

Adapts an existing DBOPFS instance into a complete caller-selected speech
runtime/model store. It serializes each selected model with an exclusive Web
Lock, removes partial state after failure, stores ordinary mutable selection
metadata before content, and treats a changed file inventory or source mapping
as a cache miss that is downloaded again.

### Signature and result

```text
createDbopfsSpeechArtifactStore({ dbopfs, tableName='arcane_ai_browser_speech', fetchImpl=null, objectUrlFactory=null }={})
```

The mutable result is `{protocol,tableName,prepare,remove}`.
`prepare(authority,{signal,onProgress,offline=false,security})` uses a complete
compatible cache or downloads every declared file, preserves complete content
and materializes object URLs, then returns
`{cache,runtime,model,release}`. Call `release()` when the Worker no longer
needs those URLs. `offline:true` never fetches and rejects a miss with
`ARCANE_AI_ARTIFACT_OFFLINE_MISS`. `remove(authority)` deletes that exact
authority's files and selection metadata. `onProgress` remains an optional
provider-interface callback, but the current store publishes no progress
records.

### Availability and normalization

**Browser with a ready DBOPFS instance, OPFS, Web Locks, Fetch or an injected
fetch function, File/Blob, and object URLs.** An unavailable authority lock
fails as `ARCANE_AI_STORAGE_BUSY`; download, malformed cache, graph, and storage
failures remain observable `ARCANE_AI_*` errors.

### Example

```javascript
import {
    createDbopfsSpeechArtifactStore
} from 'arcane-os/ai/browser-speech';

const speechStore = createDbopfsSpeechArtifactStore({dbopfs});
async function inspectCachedSpeechAfterUserChoice() {
    // Offline mode uses the complete previously selected cache.
    const prepared = await speechStore.prepare(authority, {offline:true});
    try {
        console.log(prepared.cache, prepared.runtime.entry);
    } finally {
        prepared.release();
    }
}
```

## createBrowserWhisperProvider()

### Overview

Creates a local-only Whisper speech-to-text provider for the provider-neutral
AI runtime. It owns one independent STT load/use/unload/dispose lifecycle and
never selects a cloud, native, or LLM fallback.

### Signature and result

```text
createBrowserWhisperProvider(options={})
```

The recognized options are
`{id='arcane-browser-whisper',localOnly=true,graph,model,runtime,appSecurity,
security,store,offline=false}`. `graph` is mutually exclusive with `model` and
`runtime`. The mutable result is
`{protocol:'arcane-ai-provider/2',role:'stt',id,localOnly:true,catalog,inspect,
status,load,request,unload,dispose}`. The only request operation is
`transcribe`; its payload is `{audio:Float32Array,sampleRate:16000}`. The
Worker-transferred result is a structured `{text}` record; the client does not
re-freeze the cloned record.

`status()` returns
`{role,providerId,modelId,state,lifecycleStatus,lifecycleReason,activeOperation,
loaded,busy,generation,errorCode,cache,warnings}` and includes `security` only
for an explicit secure intent.
States are `unloaded`, `loading`, `ready`, `unloading`, `error`, and
`disposed`. Compatible concurrent loads coalesce; concurrent requests fail as
`ARCANE_AI_PROVIDER_BUSY`. Cancellation after the Worker request begins
terminates that Worker slot, returns the provider to `unloaded`, and rejects as
`ARCANE_AI_REQUEST_ABORTED`. Cancellation while shared Blob/File audio is still
being decoded occurs before Worker use; it rejects with the same code while the
loaded Worker remains intact and the provider stays `ready`.

The provider also accepts the shared AI speech payload
`{audio:Blob|File,mimeType,model}`. It requires an exact model match, validates
the MIME essence against `Blob.type`, decodes through browser audio APIs, and
copies authoritative 16 kHz mono `Float32Array` PCM into the same native
provider operation. Missing decode support fails
`ARCANE_AI_AUDIO_DECODE_UNAVAILABLE`; invalid or failed decoding fails
`ARCANE_AI_INVALID_REQUEST` or `ARCANE_AI_AUDIO_DECODE_FAILED`. Unknown fields
and accessors are rejected before Worker use.

### Availability and normalization

**Browser with Workers, object URLs, and a caller-selected
`transformers-whisper` runtime/model plus the required DBOPFS store and Web
Locks.** The subpath is
importable in Node, but no Node storage, Worker, audio-decoder, or speech
execution adapter is published. No Core speech call, model/runtime download
authority, or automatic provider fallback is added. Provider objects are not event targets; register them with
the managed AI provider runtime when normalized `AIRuntimeState` observation is
needed.

### Example

```javascript
import {createBrowserWhisperProvider} from 'arcane-os/ai/browser-speech';

const whisper = createBrowserWhisperProvider({model, runtime, store:speechStore});
async function transcribeAfterUserChoice(audioBlob) {
    await whisper.load({
        role:'stt',
        selection:{
            providerId:whisper.id,
            modelId:whisper.catalog()[0].id,
            localOnly:true
        }
    });
    const transcript = await whisper.request({
        role:'stt',
        operation:'transcribe',
        payload:{
            audio:audioBlob,
            mimeType:audioBlob.type,
            model:whisper.catalog()[0].id
        }
    });
    console.log(transcript.text);
}
```

## createBrowserKokoroProvider()

### Overview

Creates a local-only Kokoro text-to-speech provider for the provider-neutral AI
runtime. It owns one independent TTS lifecycle and never selects a cloud,
native, or LLM fallback.

### Signature and result

```text
createBrowserKokoroProvider(options={})
```

The recognized options are
`{id='arcane-browser-kokoro',localOnly=true,graph,model,runtime,appSecurity,
security,store,offline=false}`. `graph` is mutually exclusive with `model` and
`runtime`. The mutable result is
`{protocol:'arcane-ai-provider/2',role:'tts',id,localOnly:true,catalog,inspect,
status,load,request,unload,dispose}`. The only request operation is
`synthesize`; its payload is `{text,voice?,speed=1}`. Omitted `voice` uses the
caller-supplied `model.defaultVoice`; `speed` is any finite number greater than
zero. The Worker-transferred result is a structured
`{audio:Float32Array,sampleRate:24000,voice}` record; the client does not
re-freeze the cloned record.

The shared AI request form is
`{model,input,responseFormat,voice?,speed?}`. It requires the exact model,
accepts only `responseFormat:'wav'`, maps the complete `input` to provider-native text, and
returns mutable `{audio:Uint8Array,contentType:'audio/wav'}` containing 24 kHz
mono 16-bit PCM. Unsupported formats fail
`ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT`; malformed adapter audio fails
`ARCANE_AI_INVALID_PROVIDER_RESULT`. Unknown fields and accessors reject as malformed.

Lifecycle/status, coalesced load, busy-request, unload, Worker-failure, and
disposal behavior matches the Whisper provider. Cancellation after Worker use
begins unloads that Worker; cancellation before Worker use rejects while the
provider stays ready. Stable failures include
`ARCANE_AI_INVALID_REQUEST`, `ARCANE_AI_NOT_READY`,
`ARCANE_AI_PROVIDER_DISPOSED`, `ARCANE_AI_OPERATION_SUPERSEDED`,
`ARCANE_AI_WORKER_CRASHED`, `ARCANE_AI_WORKER_MESSAGE_ERROR`, and
`ARCANE_AI_ADAPTER_PROTOCOL_MISMATCH`.

### Availability and normalization

**Browser with Workers, object URLs, and a caller-selected `kokoro-js`
runtime/model/voice selection plus the required DBOPFS store and Web Locks.**
The subpath is
importable in Node, but no Node storage, Worker, or speech execution adapter is
published. No Core speech call, model/runtime/voice authority, or automatic provider fallback is
added. Provider objects are not event targets; managed `AIProviderRuntime` and
`AIRuntimeState` projections own normalized cross-role observation.

### Example

```javascript
import {createBrowserKokoroProvider} from 'arcane-os/ai/browser-speech';

const kokoro = createBrowserKokoroProvider({model, runtime, store:speechStore});
async function synthesizeAfterUserChoice() {
    await kokoro.load({
        role:'tts',
        selection:{
            providerId:kokoro.id,
            modelId:kokoro.catalog()[0].id,
            localOnly:true
        }
    });
    const speech = await kokoro.request({
        role:'tts',
        operation:'synthesize',
        payload:{
            model:kokoro.catalog()[0].id,
            input:'Hello from Arcane.',
            responseFormat:'wav',
            speed:1
        }
    });
    console.log(speech.audio, speech.contentType);
}
```

# Portable Mail

The `arcane-os/mail` subpath is the dependency-free portable Mail boundary.
Node credentials, Resend commands, and the loopback gateway remain toolchain
and CLI responsibilities rather than browser-package exports.

## DEFAULT_MAIL_REQUEST_TIMEOUT_MS

### Overview

Default timeout selection for one Mail HTTP request.

### Value and import

```text
const DEFAULT_MAIL_REQUEST_TIMEOUT_MS
```

### Availability and normalization

Node and browser with Fetch and AbortController. The value is `null`, so the
ordinary transport adds no request deadline.

### Example

```js
import {DEFAULT_MAIL_REQUEST_TIMEOUT_MS} from 'arcane-os/mail';
```

## MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS

### Overview

Duration for same-key retry before ambiguous delivery requires reconciliation.

### Value and import

```text
const MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS
```

### Availability and normalization

Node and browser metadata. The immutable value is 86400000 milliseconds.

### Example

```js
import {MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS} from 'arcane-os/mail';
```

## MAIL_OUTBOX_PROTOCOL

### Overview

Stable protocol identifier written to durable Mail outbox records.

### Value and import

```text
const MAIL_OUTBOX_PROTOCOL
```

### Availability and normalization

Node and browser metadata. The immutable value is `arcane-mail-outbox/1`.

### Example

```js
import {MAIL_OUTBOX_PROTOCOL} from 'arcane-os/mail';
```

## MAIL_OUTBOX_STATES

### Overview

Mutable ordered vocabulary for durable Mail outbox lifecycle states.

### Value and import

```text
const MAIL_OUTBOX_STATES
```

### Availability and normalization

Node and browser metadata. States are queued, sending, retry_wait, accepted,
failed, and reconciliation_required.

### Example

```js
import {MAIL_OUTBOX_STATES} from 'arcane-os/mail';
```

## MAIL_OUTBOX_TABLE

### Overview

Default DBOPFS-compatible table name for durable Mail outbox records.

### Value and import

```text
const MAIL_OUTBOX_TABLE
```

### Availability and normalization

Node and browser metadata. The immutable value is `mail_outbox`.

### Example

```js
import {MAIL_OUTBOX_TABLE} from 'arcane-os/mail';
```

## Mail

### Overview

Owns the application Mail singleton, durable lifecycle, report normalization,
and explicit transport selection.

### Signature and result

```text
new Mail(config=globalThis.arcane?.config?.mail||{}, options={})
```

### Availability and normalization

Node with injected host adapters, or browser/native WebView with durable
storage and Web Locks. Reports persist before delivery and results remain
complete mutable records.

### Example

```js
import {Mail} from 'arcane-os/mail';
const mail = new Mail({}, options);
```

## MailOutbox

### Overview

Owns durable FIFO delivery, retry classification, and invalid-record
maintenance.

### Signature and result

```text
new MailOutbox(options={})
```

### Availability and normalization

Node or browser with injected DBOPFS-compatible storage and a Web
Locks-compatible lock manager. Records and summaries remain complete mutable
values. An accepted result requires a valid `requestId`; `providerId` and
`acceptanceAuthority` are optional transport metadata, and an acceptance
authority is valid only on an accepted result.

### Example

```js
import {MailOutbox} from 'arcane-os/mail';
const outbox = new MailOutbox(options);
```

## MailTransportError

### Overview

Normalized Mail transport failure with stable retry and uncertainty metadata.

### Signature and result

```text
new MailTransportError(message, options={})
```

### Availability and normalization

Node and browser. It exposes code, retryable, retryAfterMs, statusCode,
uncertain, and the complete remote detail subject only to HTTP framing.

### Example

```js
import {MailTransportError} from 'arcane-os/mail';
```

## createMailOutbox()

### Overview

Creates a MailOutbox from caller-owned storage, locking, delivery, and
lifecycle adapters.

### Signature and result

```text
createMailOutbox(options)
```

### Availability and normalization

Node or browser with the required injected adapters. The result is the same
validated contract as direct MailOutbox construction.

### Example

```js
import {createMailOutbox} from 'arcane-os/mail';
const outbox = createMailOutbox(options);
```

## Mail default export

### Overview

Default package binding for the same Mail class exposed by the named export.

### Signature and result

```text
default as Mail
```

### Availability and normalization

Node with injected host adapters, or browser/native WebView with durable
storage and Web Locks. Binding identity equals the named `Mail` export.

### Example

```js
import Mail from 'arcane-os/mail';
```

## normalizeMailEndpoint()

### Overview

Resolves and validates one credential-free HTTPS or loopback-HTTP endpoint.

### Signature and result

```text
normalizeMailEndpoint(endpoint, base=globalThis.location?.href)
```

### Availability and normalization

Node and browser with URL support. Relative endpoints require a base;
credentials, queries, fragments, and insecure non-loopback transport reject.

### Example

```js
import {normalizeMailEndpoint} from 'arcane-os/mail';
const endpoint = normalizeMailEndpoint('/v1/mail', location.href);
```

## resolveMailConfig()

### Overview

Resolves application identity, key, endpoint, and timeout without delivery.

### Signature and result

```text
resolveMailConfig(config=globalThis.arcane?.config?.mail||{}, options={})
```

### Availability and normalization

Node with explicit configuration, or browser/native WebView with optional
document and location defaults. The returned configuration is a mutable plain
record.

### Example

```js
import {resolveMailConfig} from 'arcane-os/mail';
const config = resolveMailConfig();
```

## sendMailReport()

### Overview

Sends one complete Mail report with an idempotency key through HTTP.

### Signature and result

```text
sendMailReport({ appKey, appName, endpoint, fetchImpl=globalThis.fetch, report, reportKey, requestTimeout=null, serializedReport, signal })
```

### Availability and normalization

Node and browser with Fetch and AbortController, or an explicit fetch
implementation. The complete response is preserved subject only to unavoidable
HTTP framing and normalized as acceptance or a `MailTransportError`.

### Example

```js
import {sendMailReport} from 'arcane-os/mail';
const result = await sendMailReport(options);
```

## serializeMailReport()

### Overview

Serializes one JSON-object Mail report for exact body comparison.

### Signature and result

```text
serializeMailReport(report)
```

### Availability and normalization

Node and browser. Returns compact JSON and rejects non-object or
non-serializable reports.

### Example

```js
import {serializeMailReport} from 'arcane-os/mail';
const body = serializeMailReport(report);
```

## Data export subpaths

The package also exposes eight JSON Schemas (including `arcane-os/schemas/event-stack.json`) and its package manifest. These are data contracts, not callable JavaScript members. See [schema contracts](../architecture.md) and the files under `schemas/`.
