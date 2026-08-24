# Arcane OS SDK JavaScript API

The npm package exposes a Node.js ESM control plane. It is not a browser-importable renderer API. Use the synchronized modules under `/arcane/` for application code and use `globalThis.Arcane` for capability-gated native calls.

This page is the canonical inventory for every JavaScript name reachable through `package.json#exports`. The same binding can appear at the root and a focused subpath; those entrypoints are listed together. The root workspace `discoverApps` and the low-level packager `discoverApps` are intentionally separate records because they are different functions.

## Import map

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
| `arcane-os/event-manager` | Central synchronous events, bounded time-travel history, playback, and optional DOM instrumentation. |

JSON schemas, the runtime manifest, and `package.json` are data-only export subpaths. In Node ESM, import JSON with `with {type: 'json'}`, or resolve and read it explicitly.

## Shared operation contract

High-level operations accept one options object. Common fields are `workspaceRoot`, `appId`, `target`, `signal`, and `onEvent`; only fields meaningful to that operation are consumed. Long work acknowledges first, owns its child tasks, keeps event delivery ordered and backpressured, emits progress or heartbeats, observes cancellation where safe, and rejects with `ArcaneError` on failure.

One invocation selects one workspace, app, operation, target, architecture, format, signing profile, and output root. No API silently loops over all apps or targets. Receipt-returning APIs issue same-process authority: receipts cannot be serialized, reconstructed, or treated as cross-process authorization.

Protocol mechanics are intentionally kept in the [deep protocol guide](protocols.md). The compact availability and normalization sentence beneath each member is the normal application-facing view.

## Canonical member inventory

| Member | Kind | Import | Group | Availability |
| --- | --- | --- | --- | --- |
| `APP_BUNDLE_DESCRIPTOR_NAME` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_EXTENSION` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_FORMAT` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_KIND` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_LIMITS` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_MANIFEST_NAME` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_RELEASE_PATH` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_SCHEMA_VERSION` | constant | `arcane-os` | Packaging and release bundles | Node |
| `APP_BUNDLE_SUPPORTED_SDK_VERSIONS` | constant | `arcane-os/release-bundle` | Packaging and release bundles | Node |
| `APP_CONFIG_NAME` | constant | `arcane-os/packager` | Packaging and release bundles | Node |
| `APP_DESCRIPTOR_NAME` | constant | `arcane-os` | Runtime and app descriptors | Node |
| `APP_DESCRIPTOR_SCHEMA_VERSION` | constant | `arcane-os` | Runtime and app descriptors | Node |
| `appDescriptorSha256()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `ARCANE_INTEGRATED_PROVIDER_RELATIVE_PATH` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ARCANE_MACHINE_BUNDLE_VERSION` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ARCANE_NATIVE_PROVIDER_PATHS` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ARCANE_PORTABLE_PROVIDER_PATH` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `ARCANE_PROTOCOL` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ARCANE_UPSTREAM_COMMIT` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ARCANE_UPSTREAM_REPOSITORY` | constant | `arcane-os` | Identity and protocol constants | Node |
| `ArcaneError` | class | `arcane-os` | Errors | Node |
| `assertIntegratedNativeToolchain()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assertIntegratedPortableToolchain()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assertNativeApplicationToolchainCompatibility()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assertNativeToolchainCompatibility()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assertPortableToolchainCompatibility()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `assessArcaneOllama()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node; Microsoft NT managed-service assessment |
| `authenticateAppReleaseAuthority()` | function | `arcane-os` | Packaging and release bundles | Node |
| `authenticateAppReleaseReceipt()` | function | `arcane-os` | Packaging and release bundles | Node |
| `authenticateNativeBuildPlan()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `authenticateRuntimeReceipt()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `authenticateSharedPayloadSnapshot()` | function | `arcane-os` | Packaging and release bundles | Node |
| `buildApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `buildTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `bumpVersion()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `bundleApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `checkApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `CLI_EVENT_PROTOCOL` | constant | `arcane-os` | Identity and protocol constants | Node |
| `CLI_NAME` | constant | `arcane-os` | Identity and protocol constants | Node |
| `createApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `createAppReleaseBundle()` | function | `arcane-os` | Packaging and release bundles | Node |
| `createCanonicalUstarHeader()` | function | `arcane-os` | Packaging and release bundles | Node |
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
| `getSdkRoot()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `getTargetAdapter()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `incrementSemver()` | function | `arcane-os/packager` | Packaging and release bundles | Node |
| `initializeApplication()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `initWorkspace()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `inspectApp()` | function | `arcane-os` | Packaging and release bundles | Node |
| `inspectWorkspaceProfile()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node |
| `INTEGRATED_TOOLCHAIN_PROTOCOL` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `listTargets()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadAppDescriptor()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `loadArcaneIntegratedProvider()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadArcaneNativeProvider()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadArcanePortableProvider()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `loadRuntimeRelease()` | function | `arcane-os` | Runtime and app descriptors | Node |
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
| `prepareSharedPayloadSnapshot()` | function | `arcane-os` | Packaging and release bundles | Node |
| `projectNativeDescriptor()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `projectPackageManifest()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `readVerifiedAppReleaseFile()` | function | `arcane-os` | Packaging and release bundles | Node |
| `readVerifiedRuntimeFile()` | function | `arcane-os` | Runtime and app descriptors | Node |
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
| `startDevServer()` | function | `arcane-os` | Workspace, doctor, repository, and server | Node control plane; browser data plane |
| `TARGET_ADAPTER_PROTOCOL` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `TARGET_IDS` | constant | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
| `test()` | function | `arcane-os` | Events, processes, and testing | Node |
| `testApplication()` | function | `arcane-os` | Headless toolchain operations | Node; selected operation may produce browser or native output |
| `throwIfAborted()` | function | `arcane-os` | Errors | Node |
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
| `verifyRuntime()` | function | `arcane-os` | Runtime and app descriptors | Node |
| `verifyTarget()` | function | `arcane-os` | Targets, native plans, and providers | Node; selected browser/native target or provider as documented |
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
| `TIME_TRAVEL_OVERFLOW_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `TIME_TRAVEL_SEEK_EVENT` | constant | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |
| `arcaneEvents` | singleton | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler; DOM capture requires a compatible DOM |
| `createDOMInstrumentation()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or a DOM-compatible test host |
| `createEventManager()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler; DOM capture requires a compatible DOM |
| `describeDOMTarget()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or DOM-compatible objects; importable in Node |
| `domSelector()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Browser DOM or DOM-compatible objects; importable in Node |
| `parseEventStack()` | function | `arcane-os/event-manager` | Central events, time travel, and DOM instrumentation | Node and browser/bundler |

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_KIND} from 'arcane-os';

console.log(APP_BUNDLE_KIND);
```

## APP_BUNDLE_LIMITS

### Overview

Frozen compressed-size, expanded-size, entry-count, and path limits enforced by bundle creation and verification.

### Value and import

```text
const APP_BUNDLE_LIMITS
```

Import it from `arcane-os` or `arcane-os/release-bundle`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_BUNDLE_LIMITS} from 'arcane-os';

console.log(APP_BUNDLE_LIMITS);
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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {APP_CONFIG_NAME} from 'arcane-os/packager';

console.log(APP_CONFIG_NAME);
```

## authenticateAppReleaseAuthority()

### Overview

Authenticates that a same-process app release receipt also carries authored descriptor authority for external delivery.

### Signature and result

```text
async authenticateAppReleaseAuthority(receipt, { releaseRoot, expectedPackageConfig, expectedDescriptor, signal }={})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {authenticateAppReleaseAuthority} from 'arcane-os';

async function useauthenticateAppReleaseAuthority(...arguments_) {
    return authenticateAppReleaseAuthority(...arguments_);
}
```

## authenticateAppReleaseReceipt()

### Overview

Authenticates a same-process verified application release receipt against its exact current filesystem state.

### Signature and result

```text
async authenticateAppReleaseReceipt(receipt, options={})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {authenticateAppReleaseReceipt} from 'arcane-os';

async function useauthenticateAppReleaseReceipt(...arguments_) {
    return authenticateAppReleaseReceipt(...arguments_);
}
```

## authenticateSharedPayloadSnapshot()

### Overview

Authenticates the same-process immutable shared-payload snapshot consumed by app packaging.

### Signature and result

```text
async authenticateSharedPayloadSnapshot(receipt, options={})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {authenticateSharedPayloadSnapshot} from 'arcane-os';

async function useauthenticateSharedPayloadSnapshot(...arguments_) {
    return authenticateSharedPayloadSnapshot(...arguments_);
}
```

## bumpVersion()

### Overview

Updates one selected app version with a validated semantic-version bump through the packager boundary.

### Signature and result

```text
async bumpVersion(options)
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {bumpVersion} from 'arcane-os/packager';

async function usebumpVersion(...arguments_) {
    return bumpVersion(...arguments_);
}
```

## createAppReleaseBundle()

### Overview

Writes one deterministic USTAR+gzip external application bundle from an authenticated authored release receipt.

### Signature and result

```text
async createAppReleaseBundle({ receipt, releaseRoot, outputPath, overwrite=false, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {incrementSemver} from 'arcane-os/packager';

console.log(incrementSemver('1.2.3', 'minor'));
```

## inspectApp()

### Overview

Loads and validates one packager app configuration, shared mappings, descriptor, and release inputs.

### Signature and result

```text
async inspectApp({workspaceRoot, appId})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {inspectApp} from 'arcane-os';

async function useinspectApp(...arguments_) {
    return inspectApp(...arguments_);
}
```

## normalizeRelativePath()

### Overview

Normalizes one portable repository-relative path and rejects traversal, aliases, links, and unsafe names.

### Signature and result

```text
normalizeRelativePath(value, label='path')
```

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {normalizeRelativePath} from 'arcane-os/packager';

console.log(normalizeRelativePath('apps/example/index.html'));
```

## packageApp()

### Overview

Builds and authenticates one browser application release through the low-level packager API.

### Signature and result

```text
async packageApp(options)
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {packageApp} from 'arcane-os';

async function usepackageApp(...arguments_) {
    return packageApp(...arguments_);
}
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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {parseSemver} from 'arcane-os/packager';

console.log(parseSemver('1.2.3'));
```

## prepareSharedPayloadSnapshot()

### Overview

Verifies and snapshots the shared runtime/dependency payload once for reuse by one packaging generation.

### Signature and result

```text
async prepareSharedPayloadSnapshot({ workspaceRoot:requestedWorkspaceRoot, sharedPayloadIds, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {prepareSharedPayloadSnapshot} from 'arcane-os';

async function useprepareSharedPayloadSnapshot(...arguments_) {
    return prepareSharedPayloadSnapshot(...arguments_);
}
```

## readVerifiedAppReleaseFile()

### Overview

Reads one bounded file through an authenticated app-release receipt and rechecks its identity and digest.

### Signature and result

```text
async readVerifiedAppReleaseFile(receipt, { releaseRoot, relativePath, signal }={})
```

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {readVerifiedAppReleaseFile} from 'arcane-os';

async function usereadVerifiedAppReleaseFile(...arguments_) {
    return readVerifiedAppReleaseFile(...arguments_);
}
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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

**Node.** Exact immutable SDK value. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

### Example

```javascript
import {ROOT_CONFIG_NAME} from 'arcane-os/packager';

console.log(ROOT_CONFIG_NAME);
```

## validateAppBundlePath()

### Overview

Validates and normalizes one portable path admitted inside an external app bundle.

### Signature and result

```text
validateAppBundlePath(value, label='bundle path')
```

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os` or `arcane-os/packager`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

Import it from `arcane-os` or `arcane-os/release-bundle`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** Normalized SDK validation and receipt; canonical archive/release bytes preserved. Deep protocol: [SDK packager, receipt, or deterministic bundle contract](protocols.md).

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

## appDescriptorSha256()

### Overview

Returns the SHA-256 digest of the canonical validated schema-2 application descriptor.

### Signature and result

```text
appDescriptorSha256(descriptor)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {appDescriptorSha256} from 'arcane-os';

async function useappDescriptorSha256(...arguments_) {
    return appDescriptorSha256(...arguments_);
}
```

## authenticateRuntimeReceipt()

### Overview

Authenticates a same-process runtime receipt against the exact runtime root and current file identities.

### Signature and result

```text
async authenticateRuntimeReceipt(receipt, { runtimeRoot=path.join(sdkRoot, 'runtime'), signal }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {authenticateRuntimeReceipt} from 'arcane-os';

async function useauthenticateRuntimeReceipt(...arguments_) {
    return authenticateRuntimeReceipt(...arguments_);
}
```

## getSdkRoot()

### Overview

Returns the absolute installed SDK package root.

### Signature and result

```text
getSdkRoot()
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {getSdkRoot} from 'arcane-os';

console.log(getSdkRoot());
```

## loadAppDescriptor()

### Overview

Loads an authored schema-2 descriptor or a bounded legacy projection with explicit provenance.

### Signature and result

```text
async loadAppDescriptor({workspaceRoot, appRoot, appId, packageManifest})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {loadAppDescriptor} from 'arcane-os';

async function useloadAppDescriptor(...arguments_) {
    return loadAppDescriptor(...arguments_);
}
```

## loadRuntimeRelease()

### Overview

Reads and structurally validates the synchronized runtime release manifest.

### Signature and result

```text
async loadRuntimeRelease({runtimeRoot=path.join(sdkRoot, 'runtime')}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {loadRuntimeRelease} from 'arcane-os';

async function useloadRuntimeRelease(...arguments_) {
    return loadRuntimeRelease(...arguments_);
}
```

## projectNativeDescriptor()

### Overview

Projects the canonical app descriptor into the native registry shape consumed by paired builders.

### Signature and result

```text
projectNativeDescriptor(descriptor, {source}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {projectPackageManifest} from 'arcane-os';

async function useprojectPackageManifest(...arguments_) {
    return projectPackageManifest(...arguments_);
}
```

## readVerifiedRuntimeFile()

### Overview

Reads one bounded runtime file through an authenticated runtime receipt and rechecks its identity and digest.

### Signature and result

```text
async readVerifiedRuntimeFile(receipt, { runtimeRoot=path.join(sdkRoot, 'runtime'), relativePath, signal }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {readVerifiedRuntimeFile} from 'arcane-os';

async function usereadVerifiedRuntimeFile(...arguments_) {
    return readVerifiedRuntimeFile(...arguments_);
}
```

## validateAppDescriptor()

### Overview

Strictly validates and freezes one schema-2 app descriptor, including runtime-only cross-field rules.

### Signature and result

```text
validateAppDescriptor(value, {appId}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {validateAppDescriptor} from 'arcane-os';

async function usevalidateAppDescriptor(...arguments_) {
    return validateAppDescriptor(...arguments_);
}
```

## verifyRuntime()

### Overview

Verifies every synchronized runtime file and returns a deeply frozen same-process receipt.

### Signature and result

```text
async verifyRuntime({ runtimeRoot=path.join(sdkRoot, 'runtime'), signal, onEvent }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {verifyRuntime} from 'arcane-os';

async function useverifyRuntime(...arguments_) {
    return verifyRuntime(...arguments_);
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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {assertIntegratedPortableToolchain} from 'arcane-os';

async function useassertIntegratedPortableToolchain(...arguments_) {
    return assertIntegratedPortableToolchain(...arguments_);
}
```

## assertNativeApplicationToolchainCompatibility()

### Overview

Checks a prepared native toolchain receipt against the selected application's declared Core requirements.

### Signature and result

```text
assertNativeApplicationToolchainCompatibility({prepared, toolchainReceipt}={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {assertNativeApplicationToolchainCompatibility} from 'arcane-os';

async function useassertNativeApplicationToolchainCompatibility(...arguments_) {
    return assertNativeApplicationToolchainCompatibility(...arguments_);
}
```

## assertNativeToolchainCompatibility()

### Overview

Validates that a toolchain receipt provides the required Core version, protocol, features, capabilities, and methods.

### Signature and result

```text
assertNativeToolchainCompatibility({ appDescriptor, toolchainReceipt, minimumCoreVersion }={})
```

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {assertNativeToolchainCompatibility} from 'arcane-os';

async function useassertNativeToolchainCompatibility(...arguments_) {
    return assertNativeToolchainCompatibility(...arguments_);
}
```

## assertPortableToolchainCompatibility()

### Overview

Portable-target compatibility wrapper for native application/toolchain admission.

### Signature and result

```text
assertPortableToolchainCompatibility(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {assertPortableToolchainCompatibility} from 'arcane-os';

async function useassertPortableToolchainCompatibility(...arguments_) {
    return assertPortableToolchainCompatibility(...arguments_);
}
```

## authenticateNativeBuildPlan()

### Overview

Authenticates an immutable same-process native build plan and its bound receipts before execution.

### Signature and result

```text
async authenticateNativeBuildPlan(plan, { expectedNativeBuilder, expectedTarget, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {authenticateNativeBuildPlan} from 'arcane-os';

async function useauthenticateNativeBuildPlan(...arguments_) {
    return authenticateNativeBuildPlan(...arguments_);
}
```

## buildTarget()

### Overview

Invokes one target adapter build with explicit app, target, and artifact inputs.

### Signature and result

```text
async buildTarget(options={})
```

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/integrated-provider`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {loadArcaneIntegratedProvider} from 'arcane-os';

async function useloadArcaneIntegratedProvider(...arguments_) {
    return loadArcaneIntegratedProvider(...arguments_);
}
```

## loadArcaneNativeProvider()

### Overview

Loads one fixed target provider from one explicit compatible Arcane OS checkout.

### Signature and result

```text
loadArcaneNativeProvider({ arcaneRoot, target, inspect=lstat, canonicalize=realpath, readModule=readFile, importModule=specifier=>import(specifier), generationCache=providerGenerationCache, signal, onEvent }={})
```

Import it from `arcane-os` or `arcane-os/native-provider`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/native-provider`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Runs one provider toolchain preparation and returns its authenticated process-owned receipt.

### Signature and result

```text
async prepareNativeTarget(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/native`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

### Example

```javascript
import {validateNativeBuilder} from 'arcane-os';

async function usevalidateNativeBuilder(...arguments_) {
    return validateNativeBuilder(...arguments_);
}
```

## verifyNativeArtifact()

### Overview

Authenticates one target artifact through the exact prepared provider/toolchain receipt.

### Signature and result

```text
async verifyNativeArtifact(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

Import it from `arcane-os` or `arcane-os/targets`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected browser/native target or provider as documented.** Normalized plan/admission/receipt; target-specific artifact detail preserved. Deep protocol: [arcane-target-adapter/1, arcane-native-build-plan/1, or provider protocol](protocols.md).

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

## ARCANE_UPSTREAM_COMMIT

### Overview

Exact Arcane OS source commit from which the synchronized runtime was built.

### Value and import

```text
const ARCANE_UPSTREAM_COMMIT
```

Import it from `arcane-os`. Treat arrays and records as immutable public values.

### Availability and normalization

**Node.** Exact immutable SDK value. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {ARCANE_UPSTREAM_COMMIT} from 'arcane-os';

console.log(ARCANE_UPSTREAM_COMMIT);
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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

console.log(ERROR_CODES);
```

## errorRecord()

### Overview

Projects an error into the JSON-safe normalized public error record.

### Signature and result

```text
errorRecord(error)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {errorRecord} from 'arcane-os';

console.log(errorRecord(new Error('Example failure.')));
```

## fail()

### Overview

Throws a normalized `ArcaneError` with the supplied code and context.

### Signature and result

```text
fail(code, message, options)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** ArcaneError and JSON-safe error normalization. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {fail} from 'arcane-os';

async function usefail(...arguments_) {
    return fail(...arguments_);
}
```

## normalizeError()

### Overview

Converts an unknown thrown value into an `ArcaneError` while preserving an existing normalized error.

### Signature and result

```text
normalizeError(error, fallbackCode=ERROR_CODES.operationFailed)
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

### Signature and result

```text
async repositoryPush({ workspaceRoot=process.cwd(), signal, onEvent, run=runProcess }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; network-assisted Git.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {repositoryPush} from 'arcane-os';

async function userepositoryPush(...arguments_) {
    return repositoryPush(...arguments_);
}
```

## repositoryStatus()

### Overview

Reads one repository's branch and short worktree status through an owned child process.

### Signature and result

```text
async repositoryStatus({ workspaceRoot=process.cwd(), signal, onEvent, run=runProcess }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Starts one bounded browser development server with exact runtime/app route mappings and an unguessable session capability.

### Signature and result

```text
async startDevServer(options={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node control plane; browser data plane.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {startDevServer} from 'arcane-os';

async function usestartDevServer(...arguments_) {
    return startDevServer(...arguments_);
}
```

## validateWorkspace()

### Overview

Runs canonical workspace, runtime, descriptor, and selected-app validation with progress events.

### Signature and result

```text
async validateWorkspace({workspaceRoot=process.cwd(), appId, signal, onEvent}={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Node ESM](protocols.md).

### Example

```javascript
import {validateWorkspace} from 'arcane-os';

async function usevalidateWorkspace(...arguments_) {
    return validateWorkspace(...arguments_);
}
```


# Headless toolchain operations

## buildApplication()

### Overview

Builds and retained-verifies one explicitly selected native target through one paired provider.

### Signature and result

```text
async buildApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

### Signature and result

```text
createToolchain(defaults={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {createToolchain} from 'arcane-os';

const toolchain = createToolchain({
    workspaceRoot: process.cwd(),
    onEvent(event) {
        console.info(event.type);
    }
});

console.log(Object.keys(toolchain));
```

## describeTargets()

### Overview

Returns the normalized target catalog through the headless operation lifecycle.

### Signature and result

```text
async describeTargets(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

### Signature and result

```text
async executeOperation(command, options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {executeOperation} from 'arcane-os';

async function useexecuteOperation(...arguments_) {
    return executeOperation(...arguments_);
}
```

## packageApplication()

### Overview

Runs the high-level package operation for one selected application.

### Signature and result

```text
async packageApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {packageApplication} from 'arcane-os';

async function usepackageApplication(...arguments_) {
    return packageApplication(...arguments_);
}
```

## planApplication()

### Overview

Creates one authenticated native build plan without executing the provider build.

### Signature and result

```text
async planApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Runs a browser app or performs the retained native build/verify/launch lifecycle for one target.

### Signature and result

```text
async runApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

### Signature and result

```text
async testApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node; selected operation may produce browser or native output.** SDK-normalized inputs, errors, events, and documented result. Deep protocol: [Shared headless operation API + arcane-cli-events/1](protocols.md).

### Example

```javascript
import {testApplication} from 'arcane-os';

async function usetestApplication(...arguments_) {
    return testApplication(...arguments_);
}
```

## verifyApplication()

### Overview

Runs the high-level verification operation for one selected browser release.

### Signature and result

```text
async verifyApplication(options={})
```

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/toolchain`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

### Signature and result

```text
createReporter({ command, output='human', stdout=process.stdout, stderr=process.stderr, operationId=randomUUID(), clock=()=>new Date() }={})
```

Import it from `arcane-os` or `arcane-os/events`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [arcane-cli-events/1](protocols.md).

### Example

```javascript
import {createReporter} from 'arcane-os';

async function usecreateReporter(...arguments_) {
    return createReporter(...arguments_);
}
```

## default()

### Overview

Default-export alias of the public `test` registration function.

### Signature and result

```text
default(name, optionsOrCallback, maybeCallback)
```

Import it from `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

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

Import it from `arcane-os` or `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {registeredTestCount} from 'arcane-os';

console.log(registeredTestCount());
```

## runProcess()

### Overview

Runs one shell-free child command with bounded output tails, ordered stream events, heartbeats, and process-tree cancellation.

### Signature and result

```text
async runProcess(command, args=[], { cwd, env, signal, onEvent, heartbeatMs=5000, terminationGraceMs=DEFAULT_TERMINATION_GRACE_MS, allowNonzero=false, input }={})
```

Import it from `arcane-os`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {runProcess} from 'arcane-os';

async function userunProcess(...arguments_) {
    return runProcess(...arguments_);
}
```

## runRegisteredTests()

### Overview

Executes the current isolated realm's registered tests once and returns the normalized Vanilla Test report.

### Signature and result

```text
async runRegisteredTests({signal, requireTests=true, onPhase}={})
```

Import it from `arcane-os` or `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {runRegisteredTests} from 'arcane-os';

async function userunRegisteredTests(...arguments_) {
    return runRegisteredTests(...arguments_);
}
```

## test()

### Overview

Registers one public test, optional timeout, callback, nested cases, and FIFO cleanup in the isolated runner.

### Signature and result

```text
test(name, optionsOrCallback, maybeCallback)
```

Import it from `arcane-os` or `arcane-os/testing`. The signature above states whether settlement is synchronous or promise-based. The overview and owning group define result authority, side effects, callbacks, events, cancellation, and receipt lifetime.

### Availability and normalization

**Node.** SDK event/error/report normalization. Deep protocol: [Node ESM / owned process or test lifecycle](protocols.md).

### Example

```javascript
import {test} from 'arcane-os';

test('adds two values', () => {
    if (1 + 1 !== 2) throw new Error('Unexpected result.');
});
```

+# Central events, time travel, and DOM instrumentation

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

The event name used for bounded diagnostics of captured clicks, keys, pointer actions, form activity, and the other configured DOM interactions. Its payload describes the target and path without retaining DOM nodes.

### Value and use

```text
const DOM_INTERACTION_EVENT = 'arcane.dom.interaction'
```

Listen on the EventManager to update a debugger in real time. Recording snapshots the diagnostic into `arcane-event-stack/1`; privacy defaults omit input values and redact sensitive event detail. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

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

Mutation capture uses `MutationObserver` and is enabled by default when DOM instrumentation starts. Markup is omitted by default; sensitive attributes, private elements, and URLs remain redacted. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Browser DOM or a DOM-compatible test host; constant imports in Node.** The payload is a bounded diagnostic projection and cannot reconstruct or authorize changes to the DOM.

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

Calling `stop()` when already inactive is idempotent and emits nothing. Retention overflow stops DOM observation with lifecycle emission suppressed so the terminal overflow marker remains the last stack record. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

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

A synchronous pub/sub manager with opt-in bounded time-travel recording, strict event-stack import/export, cursor review, playback, and optional DOM instrumentation. Create an instance for an isolated subsystem or use `arcaneEvents` for the package singleton.

### Syntax and result

```text
new EventManager({
    timeTravel=false,
    dom=null,
    captureStacks=false,
    redactSensitive=true,
    maxEvents=10_000,
    maxSnapshotDepth=50,
    maxSnapshotEntries=1_000,
    maxSnapshotStringLength=10_000,
    clock=()=>new Date(),
    now,
    sessionId
}={})
```

Listeners receive the original live arguments synchronously. When recording is enabled, the manager separately stores deeply frozen bounded snapshots, parent/causation structure, timing, status, and a redacted error snapshot. See the [central events guide](event-manager.md) for every getter, method, default, failure, and recovery path. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler; DOM capture requires a compatible DOM.** Pub/sub is host-neutral. Recorded values are normalized snapshots; live payload identity and listener side effects remain application-defined.

### Example

```javascript
import {EventManager} from 'arcane-os/event-manager';

const events = new EventManager({timeTravel:true, maxEvents:100});
events.on('cart.updated', cart => console.log(cart.total));
events.emit('cart.updated', {total:42});
console.log(events.history.at(-1).status);
```

## PLAYBACK_CANCELLED_EVENT

### Overview

The playback lifecycle event emitted when an AbortSignal aborts an active review. Its frozen summary reports the source session, number delivered, current cursor, `completed:false`, and a bounded error snapshot.

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

The diagnostic error in the lifecycle payload is a bounded snapshot and may not preserve object identity. Records delivered before failure are not undone. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The failure summary is normalized and redacted; the thrown error remains the local failure value.

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

## TIME_TRAVEL_OVERFLOW_EVENT

### Overview

The exact type of the terminal record appended when history already contains `maxEvents` records and another string event arrives. The marker preserves explicit truncation evidence instead of silently dropping or rotating history.

### Value and use

```text
const TIME_TRAVEL_OVERFLOW_EVENT = 'arcane.time-travel.overflow'
```

Overflow leaves at most `maxEvents + 1` records, disables time travel, and stops DOM observation without a stop lifecycle record. The marker is not dispatched on the live event bus. Call `clearHistory()` before enabling time travel again. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The marker has fixed event-manager source/category and normalized retention evidence.

### Example

```javascript
import {TIME_TRAVEL_OVERFLOW_EVENT} from 'arcane-os/event-manager';

const overflowed = stack.events.at(-1)?.type === TIME_TRAVEL_OVERFLOW_EVENT;
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

The package-scoped EventManager singleton exposed from both the package root and `arcane-os/event-manager`. It provides one shared bus when explicit per-subsystem ownership is unnecessary.

### Value and use

```text
const arcaneEvents = new EventManager()
```

The singleton starts with time travel disabled and no DOM instrumentation. Its listeners and history are process/module state, so tests should remove handlers and clear history they create. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler; DOM capture requires a compatible DOM.** It is the same ESM singleton across documented entrypoints in one module graph.

### Example

```javascript
import {arcaneEvents} from 'arcane-os/event-manager';

const handler = value => console.log(value);
arcaneEvents.on('status', handler).emit('status', 'ready');
arcaneEvents.off('status', handler);
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
    captureEventDetails=false,
    captureInputValues=false,
    captureNodeMarkup=false,
    captureMutations=true,
    maxValueLength=10_000,
    maxSerializedNodeLength=100_000,
    observeOpenShadowRoots=true
}={})
```

The factory validates configuration but does not start automatically. Sensitive fields, private elements, sensitive attributes, and URLs are redacted; enabling ordinary input or markup capture does not override private-element redaction. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

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
parseEventStack(source, {
    maxEvents=10_000,
    maxSnapshotDepth=50,
    maxSnapshotEntries=1_000,
    maxSnapshotStringLength=10_000
}={})
```

Validation rejects unknown keys, accessors, sparse arrays, unsafe or oversized values, invalid timestamps/statuses/nesting, inconsistent sessions/protocols, non-increasing sequences, and malformed overflow history. A valid terminal overflow document may contain `maxEvents + 1` records. Full operational guidance: [central events, DOM instrumentation, and time-travel review](event-manager.md).

### Availability and normalization

**Node and browser/bundler.** The result is canonical immutable diagnostic data. Parsing never dispatches events, restores live objects, or confers host authority.

### Example

```javascript
import {parseEventStack} from 'arcane-os/event-manager';

const stack = parseEventStack(serialized);
console.log(stack.sessionId, stack.events.length);
```

## Data export subpaths

The package also exposes the exact runtime manifest, eight JSON Schemas (including `arcane-os/schemas/event-stack.json`), and its package manifest. These are data contracts, not callable JavaScript members. See [schema and manifest contracts](../architecture.md) and the files under `schemas/`.
