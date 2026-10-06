# Physical execution devices

The local-AI Core host exposes physical device discovery independently of model
installation, loading and inference. A device being present does not establish
that a particular engine can use it. The engine resolves that second question
when the application explicitly loads its selected model.

## List devices without loading a model

Use the application's existing Core client:

```js
const catalog = await client.invoke('localai.devices', {refresh: false}, {signal});
console.log(catalog.devices);
console.log(catalog.issues);
```

The inventory has `{platform, state, devices, issues}`. `platform` uses Node's
platform name. `state` is `ready`, `partial` or `unavailable`. Incomplete or failed
discovery is reported in `issues`; it is not evidence that the machine has no
devices. This initial discovery implementation uses Windows host APIs. Other
platforms report this capability as unavailable while retaining their existing
AI runtime behavior.

Each device has the following fields:

| Field | Meaning |
| --- | --- |
| `deviceId` | Stable host-local selection key, or `null` when identity could not be established. |
| `identitySource` | `windows-pnp-instance`, `host-cpu`, or `null`. |
| `kind` | `cpu`, `gpu` or `npu`. |
| `name` | Complete reported display name. Names are not selection identities. |
| `present` | Whether the queried device is present. |
| `isHardware`, `isIntegrated` | Reported hardware facts, or `null` when unavailable. |
| `dedicatedMemoryMiB` | Reported dedicated capacity, or `null`; used only for supported automatic GPU selection. |
| `addresses` | Observed adapter addresses described below. These are not persistent selection keys. |
| `processors` | Actual processor records for the aggregate CPU option; an empty array for GPU/NPU records. |

GPU and NPU identities are actual, uniquely correlated Windows PnP instance IDs.
An adapter whose stable identity cannot be established remains in the inventory
with `deviceId: null` and a corresponding issue. The SDK does not invent a key
from a name, enumeration order, hardware model number or adapter LUID.

Windows discovery reads the present PCI devices' bus and address properties in
one batched `Get-PnpDeviceProperty` call with `-ThrottleLimit 1`. This limits
concurrency inside that query because concurrent CIM operations have been
observed to duplicate some device results and omit others. Discovery remains
asynchronous at the host, with the same shared catalog and explicit refresh.

The CPU choice uses `deviceId: 'cpu'` and `identitySource: 'host-cpu'`. It selects
the whole-host CPU execution target, without claiming socket or core affinity.
Its `processors` entries contain `{deviceId, name, socketDesignation, cores,
logicalProcessors}`; unavailable optional facts are `null`.

`addresses` contains:

```js
{
  adapterLuid: {highPart, lowPart}, // or null
  pci: {bus, device, function: pciFunction}, // or null
  dxgiAdapterIndex // or null
}
```

The DXGI index is the actual `EnumAdapters` index joined to the adapter's LUID.
It is never inferred from DXCore or PnP enumeration order. It supplies a possible
DirectML address, not proof of provider availability or successful execution.
No CUDA ordinal is inferred from these Windows addresses.

An issue contains `{source, code, message, deviceId}`. `source` identifies `cpu`,
`gpu`, `npu`, `identity` or `dxgi`; `deviceId` is `null` when no stable identity
was established. Keep the complete diagnostic available to developers rather
than substituting an empty inventory.

## Resolve a saved selection

Store the selected physical ID with the application's existing preferences,
keyed by provider and model. The SDK introduces no new preference store and
does not change the six-slot model preference tuple.

```js
const resolution = await client.invoke('localai.resolveTarget', {
  executionTarget: {deviceId: savedDeviceId}
}, {signal});
```

The result contains `{requestedTarget, resolvedDevice, resolution, reason}`:

- `matched`: the complete device record was found. Engine support is still a
  separate question.
- `unavailable` with `device-not-present`: complete relevant discovery did not
  find that saved identity. Preserve the saved selection so the application can
  show that it is currently unavailable.
- `unsupported` with `inventory-unavailable` or `identity-unresolved`: discovery
  cannot establish the requested identity. Do not describe it as an absent device.
- `automatic` with `engine-default-required`: an explicit `executionTarget: null`
  asks the selected engine to choose at its activation boundary. The physical
  resolver returns `resolvedDevice: null` because it cannot establish the
  engine's routing capabilities.

Calling the resolver does not load a model, change preferences or replace an
existing activation. A model load that omits `executionTarget` retains that
API's existing constructor, session-option and default behavior. Explicit
`null` selects automatic resolution for the new activation; it does not erase
or relabel a running session.

## Engine configuration and execution evidence

The physical-target integration described here applies to native ONNX and
native Laya through Core. Listing host devices does not add physical-device
selection to browser WebGPU/Wllama or to the separate native llama.cpp, image
and Whisper owners. Their existing backend options remain unchanged. A browser
uses the existing Core connection for this inventory; the catalog does not
create a native connection or replace a browser provider.

An engine receives the saved selection as `executionTarget: {deviceId}`. It
owns provider availability, the physical-to-provider address mapping and the
actual session configuration. Its public state distinguishes the requested
target, physical resolution, configured target and observed execution. A
successful session configuration alone is not evidence that every operation ran
on a GPU or NPU.

Automatic selection can prefer the hardware GPU with the highest reported
dedicated capacity among supported targets with established routing. An
integrated GPU remains eligible when it meets those same conditions. An unavailable saved
target is not silently replaced by another device or a cloud route. See
[native ONNX](local-ai.md#native-onnx-sessions) and [native decisions](native-decisions.md)
for the selected engine's load, replacement, cancellation and status contracts.

## Catalog and Core ownership

SDK development local-AI composition and generated native composition with
`localAI` selected register one lazy catalog and its independent
`execution-devices` service. An empty runtime selection still permits device
discovery. Hosts without local-AI composition retain their existing service
selection. A manually composed Core can register the service explicitly:

```js
import {createExecutionDeviceCatalog} from 'arcane-os/local-ai/execution-devices';
import {createExecutionDeviceService} from 'arcane-os/core/execution-devices';
import {createLocalAIService} from 'arcane-os/core/local-ai';

const executionDevices = createExecutionDeviceCatalog({signal});
const services = [
  createExecutionDeviceService({catalog: executionDevices}),
  createLocalAIService(localAI, {appRoot, runtimes, signal, executionDevices})
];
```

Pass these definitions to the existing Core host. The independent service owns
catalog disposal. The local-AI engine borrows the same catalog; it does not
dispose a supplied owner or create another discovery process per model.

For direct Node use, `createExecutionDeviceCatalog({signal})` returns
`devices({refresh, signal})`, `resolveTarget({executionTarget, refresh, signal})`
and `dispose()`. The direct caller owns disposal. Construction performs no
discovery I/O. Calls reuse/coalesce the host's discovery; `refresh: true` requests
an explicit new observation. There is no background polling. Closing the owner
releases its discovery work and native query resources.

The catalog queries installed operating-system facilities. It does not install
drivers, download models, alter system policy or introduce a hardware admission
rule. A host capability failure remains an honest unavailable/partial result.
