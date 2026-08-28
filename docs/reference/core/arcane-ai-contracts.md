# Arcane AI Data Contracts

This reference defines the request and result objects used by Arcane's
provider-neutral AI, local AI, speech, isolated-inference, and direct Ollama
APIs. Start with the method index in the [Arcane API Reference](arcane-api.md).

The type names below are documentation notation for plain JavaScript values.
They are not TypeScript declarations.

## Portable SDK AI and Core AI

The SDK `0.3.1` has two related but separate normalized boundaries:

| Boundary | Use | Host |
|---|---|---|
| [`AIProviderRuntime.js`](../runtime-modules.md#aiproviderruntimejs) plus [`AIRuntimeState.js`](../runtime-modules.md#airuntimestatejs) | Register and control independent LLM, STT, and TTS providers through `arcane-ai-provider/2`; observe sticky state and startup barriers. | Cross-host controller/state; each provider retains its own browser, native, or cloud requirements. |
| `globalThis.Arcane.ai` and `globalThis.Arcane.speech` | Call an admitted Core-normalized AI or native speech method. | Native/Core only when the current app, method, capability, provider, and host are admitted. |

The browser-only [`arcane-os/ai/browser-wasm`](../ai/browser-wasm.md)
entrypoint provides a caller-authenticated local LLM adapter, and
[`arcane-os/ai/browser-speech`](../ai/browser-speech.md) provides
caller-authenticated Whisper/Kokoro provider mechanisms. Neither browser
entrypoint grants Core authority or silently falls back to native/cloud.

[`PersistentAIChatSession.js`](../runtime-modules.md#persistentaichatsessionjs)
can bind the same chat API to existing ChatEntity/DBOPFS history and memory.
[`DBOPFSDocumentLibrary.js`](../runtime-modules.md#dbopfsdocumentlibraryjs)
provides explicit bounded retrieval context. Those mechanisms preserve the
existing storage semantics. Construction alone performs no search. When an
application explicitly supplies the document library's context builder, each
prepared send performs its bounded lexical retrieval automatically; neither
mechanism executes a tool.

## Contract conventions

| Input style | Unknown keys | Object rules |
|---|---|---|
| Exact record | Rejected | A plain object with exactly the documented own data properties. Every field is required unless marked optional. Arrays, accessors, symbol keys, and non-plain objects are rejected. |
| Closed object | Rejected at the documented level | A plain object containing only the documented top-level keys. Provider-native nested values may have additional provider-defined structure. |
| Settings object | Currently ignored | A plain object whose documented keys are read. Callers should still send only documented keys. |

`Required` means the caller must supply the field. `Conditional` means the field
is required only under the condition in its constraints. A safe integer passes
`Number.isSafeInteger`. Byte limits use UTF-8 unless a row says characters,
encoded text, or decoded bytes.

Authorization and host admission occur before method-specific validation. An
unauthorized caller can therefore receive a capability or host error before an
input error. Rejections use `Arcane.Error`; never parse its human-readable
message as a protocol value.

These rows define the portable caller contract. Some provider-settings and
speech validators currently coerce or ignore particular off-contract values
differently on desktop Core and Android. Callers must send the documented types
and keys and must not depend on permissive host behavior or uniform rejection of
invalid input. The provider-neutral AI, local-AI, speech, and direct Ollama
methods in this document currently use method-local validators rather than
canonical entries in `method-contracts.json`; catalog metadata must not invent
semantic attributes that the registry does not define.

## Provider-neutral AI

### AI chat request

`Arcane.ai.chat(request)` accepts a closed `AIChatRequest`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `messages` | [`AIChatMessage[]`](#ai-chat-message) | Yes | 1-128 records; combined content at most 512 KiB | Conversation sent to the configured provider. |
| `expectedProvider` | `"ollama" \| "openai"` | No | Omitted means no caller-side provider binding | Rejects with `AI_PROVIDER_CHANGED` when the configured provider changed before dispatch. |
| `format` | `"json" \| "" \| null` | No | Omit, `null`, or `""` for text | Portable output-format control. |
| `model` | `string` | No | Local model pattern `[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}` | Local Ollama override. The OpenAI path always uses the configured, account-validated model. |
| `options` | JSON object | No | Ollama only | Provider-native generation options. |
| `tools` | JSON array | No | Ollama only | Provider-native tool definitions. |
| `keep_alive` | JSON value | No | Ollama only | Provider-native model-residency control. |
| `think` | JSON value | No | Ollama only | Provider-native reasoning control. |
| `logprobs` | JSON value | No | Ollama only | Provider-native log-probability control. |
| `top_logprobs` | JSON value | No | Ollama only | Provider-native log-probability count. |

For a provider-portable request, send only `messages`, optional
`expectedProvider`, and optional `format`.

```js
async function askAvailableModelsAfterUserChoice() {
  const profile = await Arcane.ai.profile();

  return Arcane.ai.chat({
    expectedProvider: profile.provider,
    messages: [
      { role: "system", content: "Answer briefly and accurately." },
      { role: "user", content: "What models are available?" }
    ]
  });
}
```

### AI chat message

Every `AIChatMessage` is an exact record.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `role` | `"system" \| "user" \| "assistant"` | Yes | Exact lowercase value | Message author role. |
| `content` | `string` | Yes | Nonempty; at most 131,072 characters | Message text. |

No other message fields are accepted.

### AI chat result

`AIChatResult` is normalized across configured Ollama and OpenAI chat.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `provider` | `"arcane-ollama" \| "openai"` | Yes | - | Provider that completed the request. |
| `model` | `string` | Yes | Bounded provider model identifier | Model used for the response. |
| `message.role` | `"assistant"` | Yes | - | Normalized response role. |
| `message.content` | `string` | Yes | At most 4 MiB retained | Assistant response text. |
| `message.thinking` | `string` | No | Ollama only; at most 4 MiB retained | Provider reasoning text when present. |
| `message.toolCalls` | `array` | No | Ollama provider-native records | Tool calls when present. |
| `done` | `boolean` | Yes | OpenAI returns `true` | Completion flag. |
| `doneReason` | `string \| null` | Yes | At most 128 characters | Completion reason. |
| `promptEvalCount` | `integer \| null` | Yes | Nonnegative when present | Prompt token/evaluation count. |
| `evalCount` | `integer \| null` | Yes | Nonnegative when present | Completion token/evaluation count. |

### AI profile

`Arcane.ai.profile()` returns `AIProfile`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `provider` | `"ollama" \| "openai"` | Yes | - | Selected provider. |
| `model` | `string` | Yes | Effective configured model | Model used by provider-neutral chat. |
| `configured` | `boolean` | Yes | - | Required provider configuration is present. |
| `local` | `boolean` | Yes | `true` only for Ollama | Whether inference remains local. |
| `responseLength` | `"low" \| "medium" \| "high"` | Yes | Legacy invalid/missing state resolves to `"medium"` | Conversational response target, not a provider token limit. |

An OpenAI profile is returned only after Arcane proves a protected credential
exists and the configured model is available to that account.

### AI provider settings input

`Arcane.ai.saveProviderSettings(settings)` reads the documented fields from an
`AIProviderSettingsInput` patch. Omitted keys preserve the current value. Send
only these keys and the documented value types; do not rely on a host ignoring
unknown fields or coercing `removeToken`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `provider` | `"ollama" \| "openai"` | No | Current provider | Provider to select. |
| `openAIModel` | `string` | Conditional | Pattern `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; required for OpenAI | Account-accessible OpenAI model. |
| `responseLength` | `"low" \| "medium" \| "high"` | No | Current value | Conversational response target. |
| `token` | `string` | No | Trimmed, starts with `sk-`, 20-512 characters | Replacement OpenAI credential. It is protected and never returned. |
| `removeToken` | `boolean` | No | Only `true` requests deletion | Removes the stored credential. A supplied `token` becomes the final credential. |

Arcane verifies the selected OpenAI model when OpenAI is selected and validates
a supplied replacement credential before persistence. Ollama-selected settings
may retain a dormant OpenAI model; Arcane revalidates it before a later switch
to OpenAI. Credential and settings mutations are rolled back together when
possible if the save fails.

### AI provider settings result

`Arcane.ai.providerSettings()` and a successful save return
`AIProviderSettingsResult`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `provider` | `"ollama" \| "openai"` | Yes | - | Selected provider. |
| `openAIModel` | `string` | Yes | May be empty when OpenAI is not selected | Saved OpenAI model. |
| `openAIConfigured` | `boolean` | Yes | - | A protected credential exists. |
| `responseLength` | `"low" \| "medium" \| "high"` | Yes | - | Saved response target. |

Credentials are never included.

### Local AI inventory

`Arcane.ai.models()` returns `LocalAIInventory`, not a bare array. This is raw
diagnostic inventory, not the admitted application selector catalog.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `provider` | `"arcane-ollama"` | Yes | - | Catalog source. |
| `models` | `OllamaInventoryModel[]` | Yes | At most 512 records | Normalized installed inventory. |

Each `OllamaInventoryModel` contains:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `name` | `string` | Yes | Local model-name pattern | Installed model identifier. |
| `modifiedAt` | `string \| null` | Yes | At most 64 characters | Provider timestamp when available. |
| `sizeBytes` | `integer \| null` | Yes | Nonnegative safe integer | Installed size when valid. |
| `digest` | `string \| null` | Yes | Lowercase 64-character hexadecimal digest | Model digest when valid. |
| `family` | `string \| null` | Yes | At most 128 characters | Provider-reported family. |
| `parameterSize` | `string \| null` | Yes | At most 64 characters | Provider parameter-size label. |
| `quantization` | `string \| null` | Yes | At most 64 characters | Provider quantization label. |

### AI provider model catalog

`Arcane.ai.providerModels()` returns `AIProviderModelCatalog` after querying the
protected OpenAI credential's account.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `provider` | `"openai"` | Yes | - | Catalog source. |
| `models` | `string[]` | Yes | Each value matches the OpenAI model pattern | Sorted account-accessible identifiers. |

This method can perform a network request. It does not return Ollama models.

## Local AI discovery and lifecycle

### Local AI status v2

`Arcane.localAI.status()` takes no arguments and returns `LocalAIStatusV2`.
Concurrent callers in one Core process can share the same active discovery.
An admitted development Android provider uses the same schema version with the
exact `user-managed-loopback` discriminator described below.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `schemaVersion` | `2` | Yes | Literal | Status schema. |
| `providerMode` | `"user-managed-loopback"` | Android only | Omitted by desktop Core | Identifies the narrow Android provider without changing `Arcane.runtime.current().managedLocalAI`, which remains false. |
| `runtime` | object | Yes | Desktop Core or bounded Android provider identity | Runtime authority and whether desktop native resource admission is active. |
| `policy` | object | Yes | See below | Package-bound model policy. |
| `ollama` | object | Yes | See below | Ollama discovery state. |
| `admission` | object | Yes | See below | Native-admission summary. |
| `speech` | object | Yes | See below | Independent speech readiness. |
| `models` | object | Yes | `{ollama, speech, transcription}` arrays | Admitted catalogs. |

`policy` fields:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `verified_only` | `boolean` | Yes | Package policy | Whether only declared verified models are considered. |
| `source` | `"package-bound-application-policy"` | Yes | Literal | Policy source. |
| `unverifiedInferenceAuthorized` | `boolean` | Yes | Requires explicit package authority | Whether installed unverified models may be considered for inference. |

`ollama` fields:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `available` | `boolean` | Yes | - | Core obtained a valid bounded catalog. |
| `modelCapabilitiesVerified` | `boolean` | Yes | - | Capability discovery completed. |
| `nativeAdmissionEnforced` | `boolean` | Yes | `true` for desktop Core; `false` for Android user-managed loopback | Whether desktop native resource admission is enforced. Android still applies its generated package-policy and provider-inspection boundary. |
| `activeParallelRequests` | `integer` | Desktop Core | Positive safe integer | Current machine-wide managed Ollama parallel request count used for active-fit evidence. |
| `errorCode` | `string \| null` | Yes | Normalized code | Discovery failure code. |

`admission` fields:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `policyVersion` | `integer` | Yes | Currently `1` | Resource-policy version. |
| `enforcedBy` | `string` | Yes | Bounded host-owned identifier | Admission authority; renderers must not interpret it as reusable authorization. |
| `evaluatedModels` | `integer` | Yes | Nonnegative | Candidate count evaluated. |
| `admittedModels` | `integer` | Yes | 0 through `evaluatedModels` | Candidate count admitted at one parallel request. A model can still have `runnable:false` when the active machine-wide parallel count exceeds its current model-specific ceiling. |
| `rejected` | `array` | Yes | `{id, compatibility}` records | Rejected candidates and admission evidence. |

`speech` fields:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `available` | `boolean` | Yes | - | Synthesis or transcription is available. |
| `reachable` | `boolean` | Yes | - | Core validated the health endpoint. |
| `synthesisAvailable` | `boolean` | Yes | - | Kokoro readiness. |
| `transcriptionAvailable` | `boolean` | Yes | - | Whisper readiness. |
| `synthesisErrorCode` | `string \| null` | Yes | - | Synthesis failure/readiness code. |
| `transcriptionErrorCode` | `string \| null` | Yes | - | Transcription failure/readiness code. |
| `errorCode` | `string \| null` | Yes | - | Overall speech failure code. |

`models.ollama` contains [`LocalAIModel`](#local-ai-model) records.
`models.speech` and `models.transcription` contain
[`LocalAIServiceModel`](#local-ai-service-model) records. An unavailable service
resolves as service-local status data where possible; it never silently changes
providers.

For `providerMode:"user-managed-loopback"`, the Android host calls only the
fixed `127.0.0.1:11434` Ollama service and fixed host-owned loopback speech
service. It returns only installed package-policy models that passed its bounded
provider inspection, repeats model admission before `ollama.chat`, and merges
the independently bounded Kokoro and Whisper role health and catalogs. The host
does not expose recovery or model mutation. The renderer never calls either
loopback API directly.

Android Linux Terminal, Ollama, and every model lifecycle action remain user-owned. Plain
loopback Ollama has no caller authentication; other local applications or
processes may call it, race the host's checks, contend for resources, or deny
service. This is unsigned development behavior, not release support, managed
service ownership, or an isolated-inference guarantee. Android exposes no
application-owned isolated-question or repository extension unless generated
package and method policy explicitly admit it.

### Local AI model

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `id`, `name` | `string` | Yes | Equal model identifiers | Snapshot selection identifier and Ollama name. |
| `provider` | `"ollama"` | Yes | Literal | Provider. |
| `roles` | `array` | Yes | Currently empty | Reserved role catalog. |
| `managed` | `boolean` | Yes | - | Declared by package policy. |
| `installed` | `boolean` | Yes | - | Runnable alias or authorized model is installed. |
| `admitted` | `true` | Yes | Literal | Current serial-fit admission. This is not proof that the active parallel setting fits. |
| `runnable`, `creatable`, `pullable`, `verified` | `boolean` | Yes | - | Managed lifecycle state. `runnable:false` can mean the active parallel setting exceeds the model's current ceiling. |
| `capabilitiesVerified`, `available` | `true` | Yes | Literal | Capability and availability proof. |
| `modifiedAt` | `string \| null` | Yes | - | Installed timestamp. |
| `sizeBytes` | `integer \| null` | Yes | Nonnegative safe integer | Model size. |
| `digest` | `string \| null` | Yes | 64-character hexadecimal value | Installed digest. |
| `family`, `parameterSize`, `quantization` | `string \| null` | Yes | Bounded diagnostic strings | Provider metadata. |
| `compatibility` | [`ModelResourceAdmission`](#model-resource-admission) | Yes | `admitted:true` | Native resource and definition evidence. |

This record is snapshot evidence, not reusable authorization. Core re-admits the
exact model and requested context before inference.

### Local AI service model

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `id` | `"kokoro" \| "whisper-small"` | Yes | - | Model identifier. |
| `name` | `"Kokoro" \| "Whisper Small"` | Yes | - | Display name. |
| `provider` | `"speech"` | Yes | Literal | Service provider. |
| `roles` | `["tts"] \| ["stt"]` | Yes | One role | Supported operation. |
| `available` | `true` | Yes | Literal | Availability in this snapshot. |
| `engine` | `string` | Yes | Health-validated identifier | Native engine. |

### Model resource admission

`ModelResourceAdmission` is a union. Early failures can omit diagnostic fields;
callers must not assume every field exists.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `policyVersion` | `integer` | Yes | Currently `1` | Resource-policy version. |
| `admitted` | `boolean` | Yes | - | Current fit decision. |
| `status` | `"compatible" \| "incompatible" \| "evidence-unavailable"` | Yes | - | Admission classification. |
| `code` | `string \| null` | Yes | `null` on success | Stable result code. |
| `message` | `string` | Yes | At most 512 characters | Human-readable result. |
| `resolution` | `string \| null` | Yes | At most 512 characters | Suggested remediation. |
| `operation` | `"inference" \| "create" \| "pull"` | No | Evidence-dependent | Evaluated operation. |
| `model` | `string` | No | At most 256 characters | Evaluated model. |
| `modelBytes`, `downloadBytes`, `contextTokens`, `nativeContextTokens`, `kvCacheBytes` | `integer \| null` | No | Positive when present | Model, transfer, requested/native context, and K/V-cache evidence. |
| `parallelism` | `integer` | No | Positive safe integer | Parallel request count evaluated by this admission record. |
| `activeParallelRequests` | `integer` | No | Positive safe integer | Current machine-wide managed Ollama setting observed for the snapshot. |
| `maxAllowedParallelRequests` | `integer \| null` | No | `null`, 0, or a positive safe integer | Largest count admitted by the same immutable model/resource snapshot. It is solved directly from the model's K/V-cache equation and available working-set bytes, without a product ceiling. `null` means evidence was unavailable; `0` means even one request was proven memory-incompatible. |
| `activeParallelRequestsAllowed` | `boolean \| null` | No | - | Whether the active count is within `maxAllowedParallelRequests`; `null` preserves unknown evidence. |
| `runtimeHeadroomBytes`, `requiredWorkingSetBytes` | `integer` | No | Positive | Derived working-set requirements. |
| `requiredAdditionalBytes`, `availableWorkingSetBytes` | `integer` | No | Nonnegative | Additional requirement and available capacity. |
| `loadedModelBytes`, `targetResidentBytes` | `integer` | No | Nonnegative | Current residency evidence. |
| `checks` | [`ModelResourceCheck[]`](#model-resource-checks) | No | - | Individual capacity checks. |
| `definitionVerified`, `baseModelInstalled`, `creationRequired`, `pullRequired` | `boolean` | No | Managed workflows | Managed lifecycle evidence. |
| `registryEvidence` | object | No | Opaque diagnostic shape | Preflight detail; never an authorization token. |

Other bounded diagnostics may appear on failures. Branch on `admitted`,
`status`, and `code`; treat additional evidence as display-only.

### Model resource checks

A working-set `ModelResourceCheck` contains:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `id` | `"working-set"` | Yes | Literal | Check identifier. |
| `ok` | `boolean` | Yes | - | Pass/fail result. |
| `requiredBytes`, `totalRequiredBytes`, `availableBytes` | `integer` | Yes | Nonnegative | Required additional, required total, and available bytes. |
| `systemFreeBytes`, `systemReserveBytes`, `usableSystemBytes` | `integer` | Yes | Nonnegative | System-memory evidence. |
| `usableGpuBytes`, `loadedModelBytes`, `targetResidentBytes` | `integer` | Yes | Nonnegative | Accelerator and residency evidence. |

A pull may add a `"model-store"` check with `ok`, `requiredBytes`,
`availableBytes`, `storageFreeBytes`, and `storageReserveBytes`.

Admission proves only current fit. It does not prove safety, output quality,
license, provenance, supplier identity, future capacity, or stability under
later concurrent workloads.

### Local AI platform result

`Arcane.localAI.ensurePlatform()` takes no arguments. It is a Provisioner-only,
exclusive post-install reconciliation. It retries when settings change during
the operation and rejects with `ARCANE_AI_PROFILE_CHANGED` after three stale
plans instead of overwriting newer settings.

`LocalAIPlatformResult` always contains an [`ArcaneOperation`](#arcane-operation)
and one of these branches.

OpenAI-selected branch:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `local` | object | Yes | `{available:false, reason:"openai-selected"}` | Local reconciliation was intentionally skipped. |
| `fallback.provider` | `"openai"` | Yes | Literal | Explicit selected provider. |
| `fallback.model` | `string` | Yes | Protected-credential account-validated model | Selected OpenAI model. |
| `fallback.configured` | `true` | Yes | Literal | Required credential and model are valid. |
| `loaded` | object | Yes | `{loaded:false, provider:"openai", model}` | No local model was loaded. |
| `operation` | [`ArcaneOperation`](#arcane-operation) | Yes | Completed | Exclusive operation receipt. |

Local branch:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `local.available` | `true` | Yes | Literal | Local AI is available. |
| `local.model` | `string` | Yes | Managed selected model | Ready model definition. |
| `local.alias` | `string` | Yes | Managed alias | Selected runtime alias. |
| `local.variant` | `string` | Yes | Arcane model variant | Selected size. |
| `local.compatibility` | [`ModelResourceAdmission`](#model-resource-admission) | Yes | `admitted:true` | Final native admission. |
| `local.recommendationDegraded` | `boolean` | Yes | - | Automatic selection used a smaller candidate after capacity rejection. |
| `local.candidateFailures` | `array` | Yes | Empty unless an earlier automatic candidate failed | Bounded prior failures. |
| `fallback` | `null` | Yes | - | Arcane did not silently change providers. |
| `loaded` | object | Yes | See below | Managed boot-load result. |
| `operation` | [`ArcaneOperation`](#arcane-operation) | Yes | Completed | Exclusive operation receipt. |

Each candidate failure is `{variant, kind, code, message, resolution}`. `kind`
is `"capacity"`, `"evidence-unavailable"`, or `"fatal"`; only a capacity
failure allows Automatic mode to try the next smaller candidate.

`loaded` is a union. Both branches contain `loaded`, `provider`, and `model`.
The successful local branch also contains `keepAlive` and `contextLength`, where
`contextLength:null` means Automatic.

### Local AI recovery request

`Arcane.localAI.recover(request)` accepts an exact `LocalAIRecoveryRequest`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `services` | `string[]` | Yes | Nonempty, duplicate-free subset of `"ollama"` and `"speech"` | Existing Arcane-managed services to start and verify. |

### Local AI recovery result

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `ready` | `true` | Yes | Literal | All requested services are ready. |
| `services` | `array` | Yes | Canonical Ollama-then-speech order | Per-service results. |
| `operation` | [`ArcaneOperation`](#arcane-operation) | Yes | Completed | Privileged exclusive operation. |

Every service result is exact:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `id` | `"ollama" \| "speech"` | Yes | - | Service identifier. |
| `serviceName` | `"ArcaneOllama" \| "ArcaneLocalSpeech"` | Yes | - | Operating-system service name. |
| `endpoint` | `string` | Yes | Fixed `127.0.0.1` health/version endpoint | Verified loopback endpoint. |
| `state` | `"running"` | Yes | Literal | Verified state. |
| `ready` | `true` | Yes | Literal | Readiness proof. |
| `started` | `boolean` | Yes | - | This request issued the start. |

Recovery starts an existing approved registration. It does not install,
replace, stop, or silently reconfigure a service.

### Local AI parallel request configuration

`Arcane.localAI.setParallelRequests(request)` accepts an exact
`LocalAIParallelRequestsRequest`:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model` | `string` | Yes | Exact app-owned verified model identifier | Model whose declared definition and native metadata govern the calculation and subsequent load. |
| `parallelRequests` | `integer` | Yes | Nonnegative safe integer | `0` requests the maximum currently allowed; a positive value is a requested ceiling and is clamped down when necessary. |
| `contextTokens` | `integer` | No | Positive safe integer; defaults to verified Modelfile `num_ctx` | Exact per-request context evaluated and used to load the model. The model's native metadata, rather than an Arcane product range, supplies the maximum. |

A successful `LocalAIParallelRequestsResult` contains:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `schemaVersion` | `1` | Yes | Literal | Result schema. |
| `model` | `string` | Yes | Exact verified alias | Model ensured and loaded. |
| `contextTokens`, `nativeContextTokens` | `integer \| null` | Yes | Positive safe integers when present | Requested context and model-native limit when metadata provides one. |
| `requestedParallelRequests` | `integer` | Yes | Nonnegative safe integer | Caller input. |
| `requestMode` | `"maximum-allowed" \| "requested-ceiling"` | Yes | Derived from input | Interpretation of the request. |
| `previousParallelRequests` | `integer` | Yes | Positive safe integer | Proven setting before the operation. |
| `maxAllowedParallelRequests` | `integer` | Yes | Positive safe integer | Largest count admitted by the resource state used for the effective decision. A changed path uses a fresh stopped-service snapshot. |
| `allowedParallelRequests`, `effectiveParallelRequests` | `integer` | Yes | Positive safe integers; equal | Clamped target and proven effective count used for the load. |
| `requestedAllowed`, `clamped` | `boolean` | Yes | - | Whether a positive request fit without reduction and whether reduction occurred. Auto (`0`) is allowed and is not called clamped. |
| `changed`, `restarted` | `boolean` | Yes | - | Whether the final service setting changed and whether the managed service actually restarted. A resource change observed after stopping can make `restarted:true` and `changed:false`; the receipt reports both facts independently. |
| `healthy`, `loaded` | `true` | Yes | Literal | Post-operation service and model readiness. |
| `loadedModel` | object | Yes | `{name,contextLength}` | Bounded `/api/ps` confirmation; provider-reported `contextLength` may represent runner allocation. |
| `serviceScope` | `"machine"` | Yes | Literal | The Ollama setting is global even though Arcane selected it from one model's evidence. |
| `unloadedModels` | `string[]` | Yes | Bounded pre-restart identifiers | Resident models evicted by the restart; empty on a no-op. |
| `definitionVerified` | `true` | Yes | Literal | Exact alias was verified after any required create/repair. |
| `modelSource` | `"verified-alias" \| "installed-base" \| "registry-preflight"` | Yes | - | Evidence source used for the pre-change capacity calculation. |
| `admission` | [`ModelResourceAdmission`](#model-resource-admission) | Yes | `admitted:true` | Fresh active-setting admission after ensure/repair and before load. |
| `operation` | [`ArcaneOperation`](#arcane-operation) | Yes | Completed | Privileged exclusive operation receipt. |

Core snapshots one exact model/resource state and solves the maximum directly
from the model metadata's K/V-cache byte ratio and the snapshot's available
working-set bytes. There is no candidate-count search and no Arcane product
ceiling. The largest exact integer representable by the JavaScript/JSON API is a
transport constraint, not a model-capacity claim. The result is a current
memory/resource admission with explicit reserves, not a performance optimum or
a promise of future availability. If the tentative target already equals the
current setting, Core does not stop Ollama. Otherwise the guarded transaction
stops and proves the service, takes one fresh stopped-service resource snapshot,
re-solves the effective count, changes only `OLLAMA_NUM_PARALLEL` when that final
count differs, and starts/proves the service. This unloads every resident Ollama
model and can terminate in-flight local inference.
It then ensures or repairs the exact alias, loads it with the requested context
and indefinite residency, and returns only after `/api/ps` confirms the model.
If loading fails after a setting change, Core attempts to restore the prior count.
The operation does not drain unrelated Core processes or direct loopback clients.
Automatic mutation is currently implemented only by the managed Microsoft NT
adapter. Linux validates the request but returns a `501` manual-systemd error;
Android's user-managed loopback mode does not invoke this desktop Core method.

### Arcane operation

Successful mutating AI methods include `ArcaneOperation`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `id` | `string` | Yes | UUID | Operation identifier. |
| `type` | `string` | Yes | Method-specific | Operation type. |
| `status` | `string` | Yes | Successful returned operations are `"completed"` | State. |
| `startedAt` | ISO timestamp `string` | Yes | - | Start time. |
| `completedAt` | ISO timestamp `string \| null` | Yes | Present on completion | Completion time. |
| `progress` | `number` | Yes | 0-100; success is 100 | Latest progress. |
| `currentStep` | `string \| null` | Yes | - | Latest visible step. |
| `progressDetails` | `object \| null` | Yes | Operation-specific | Structured progress. |
| `credentials` | `array` | Yes | Normally empty for AI lifecycle work | Host-issued credential artifacts, if any; do not log or persist them. |
| `error` | `object \| null` | Yes | `null` on success | Normalized operation error. |

## Speech

This section documents admitted, capability-gated Core/native speech calls.
For caller-owned browser-local STT/TTS providers, use the separate
[browser speech package](../ai/browser-speech.md). Those browser providers
directly implement the provider-neutral runtime contract. `Arcane.speech`
remains a separate Core/native API unless an application explicitly supplies
an adapter; their transport, artifact authority, capability, and error
boundaries are not interchangeable.

### Speech status

`Arcane.speech.status()` takes no arguments and returns `SpeechStatus`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `ready` | `boolean` | Yes | `true` only when TTS and STT are ready | Aggregate readiness. |
| `synthesisAvailable` | `boolean` | Yes | Core/native-host field | Independent Kokoro readiness. |
| `transcriptionAvailable` | `boolean` | Yes | Core/native-host field | Independent Whisper readiness. |
| `status` | `string` | Yes | Bounded health identifier | Native service state. |
| `ttsEngine` | `string` | Yes | Health-validated | Text-to-speech engine. |
| `sttEngine` | `string` | Yes | Health-validated | Speech-to-text engine. |

Unlike `localAI.status()`, this direct call rejects when Core cannot reach and
validate the speech health response.

### Speech synthesis request

`Arcane.speech.synthesize(request)` accepts the portable
`SpeechSynthesisRequest` fields below. Supply the documented primitive types and
lowercase values; do not rely on host-specific coercion or empty-string
defaulting.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `input` | `string` | Yes | Trimmed, nonempty, at most 4,000 characters | Text to synthesize. |
| `model` | `"kokoro"` | No | Default `"kokoro"`; only supported value | Synthesis model. |
| `voice` | `string` | No | Default `"af_heart"`; `[a-z0-9][a-z0-9_-]{0,63}` | Kokoro voice. |
| `responseFormat` | `"opus" \| "wav"` | No | Default `"opus"` | Audio format. |
| `speed` | `number` | No | Default `1`; 0.5-2 inclusive | Speaking speed. |

### Speech synthesis result

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `audioBase64` | `string` | Yes | Base64 for 1 byte through 6 MiB of audio | Encoded audio. |
| `contentType` | `"audio/ogg" \| "audio/wav"` | Yes | Matches the result encoding | Media type. |

### Speech transcription request

`Arcane.speech.transcribe(request)` accepts an exact
`SpeechTranscriptionRequest`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `audioBase64` | `string` | Yes | Canonical base64; encoded at most 8 MiB; decoded 1 byte through 6 MiB | Media bytes labeled as WebM. The bridge validates encoding and bounds, while the fixed speech service parses the container. |
| `mimeType` | `string` | No | Default `"audio/webm"`; base type must be `audio/webm` | Media type; codec parameters may follow. |
| `model` | `string` | No | Default `"whisper-small"`; `whisper(?:[._-][a-z0-9]+)*` | Whisper identifier. The fixed service rejects unsupported variants. |

### Speech transcription result

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `text` | `string` | Yes | Trimmed; response limited to 64 KiB | Transcript. |

Application-owned inference extensions define their request, callback, proof,
and isolation schemas with the owning package. They are included in the same
developer-reference completeness check but do not become generic Arcane AI
contracts merely because Core transports them.

## Direct Ollama API

Direct Ollama calls are local Core APIs, not provider-neutral contracts. Their
request objects are closed top-level plain objects. Core rejects unknown
top-level fields, non-JSON-compatible values, and encoded requests larger than
8 MiB. Nested provider-native objects are forwarded for Ollama to validate.

### Ollama model name

Every required `OllamaModelName` matches:

```text
[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}
```

### Ollama show options

`Arcane.ollama.show(model, options)` accepts `OllamaShowOptions`:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `verbose` | `boolean` | No | Provider default | Requests verbose metadata. |

The wrapper supplies the validated `model` field.

### Ollama generate request

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model` | [`OllamaModelName`](#ollama-model-name) | Yes | - | Model to run. |
| `prompt` | `string` | Provider | - | Generation prompt. |
| `suffix` | `string` | No | Provider-native | Text after the generated insertion. |
| `images` | `array` | No | Provider-native base64 values | Multimodal input. |
| `format` | JSON value | No | Text, JSON, or schema format | Output format. |
| `options` | object | No | Provider-native; `num_ctx` is 1,024-262,144 when supplied | Runtime options. |
| `system`, `template` | `string` | No | Provider-native | Prompt controls. |
| `context` | `array` | No | Provider-native | Legacy context tokens. |
| `raw` | `boolean` | No | Provider-native | Raw prompt mode. |
| `keep_alive` | `string \| number` | No | Provider-native | Residency. |
| `think`, `logprobs`, `top_logprobs` | JSON value | No | Provider-native | Reasoning/log-probability controls. |

See [Ollama's generate API](https://docs.ollama.com/api/generate).

### Ollama chat request

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model` | [`OllamaModelName`](#ollama-model-name) | Yes | - | Model to run. |
| `messages` | `array` | Provider | Provider-native records | Conversation. |
| `tools` | `array` | No | Provider-native | Tool definitions. |
| `format` | JSON value | No | Provider-native | Output format or schema. |
| `options` | object | No | Provider-native; `num_ctx` is 1,024-262,144 when supplied | Runtime options. |
| `keep_alive` | `string \| number` | No | Provider-native | Residency. |
| `think`, `logprobs`, `top_logprobs` | JSON value | No | Provider-native | Reasoning/log-probability controls. |

See [Ollama's chat API](https://docs.ollama.com/api/chat).

### Ollama embed request

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model` | [`OllamaModelName`](#ollama-model-name) | Yes | - | Embedding model. |
| `input` | `string \| array` | Provider | Provider-native | Text or batch to embed. |
| `truncate` | `boolean` | No | Provider-native | Allow truncation. |
| `dimensions` | `integer` | No | Provider-native | Embedding dimensions. |
| `keep_alive` | `string \| number` | No | Provider-native | Residency. |
| `options` | object | No | Provider-native; `num_ctx` is 1,024-262,144 when supplied | Runtime options. |

See [Ollama's embed API](https://docs.ollama.com/api/embed).

### Ollama pull options

`Arcane.ollama.pull(model, options, streamOptions)` accepts:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `insecure` | `boolean` | No | Provider-native | Insecure-registry control. |

The raw application call always rejects; see
[Raw Ollama management restrictions](#raw-ollama-management-restrictions).

### Ollama push options

`Arcane.ollama.push(model, options, streamOptions)` accepts:

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `insecure` | `boolean` | No | Provider-native | Insecure-registry control. |

Push is allowed only for a model authorized by verified package policy.

### Ollama create request

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model` | [`OllamaModelName`](#ollama-model-name) | Yes | - | Alias to create. |
| `from` | [`OllamaModelName`](#ollama-model-name) | Conditional | Required by Arcane's managed verified workflow | Base model. |
| `files`, `adapters` | object | No | Provider-native; forbidden by Arcane's managed path | File/adapter mappings. |
| `template`, `system` | `string` | No | Provider-native | Stored prompt configuration. |
| `license` | `string \| array` | No | Provider-native | License text. |
| `parameters` | object | No | Provider-native | Model parameters. |
| `messages` | `array` | No | Provider-native | Stored messages. |
| `quantize` | `string` | No | Provider-native | Quantization request. |

Arcane permits creation only when alias, base, SYSTEM text, and parameters
exactly match the package-owned verified definition. Reserved Arcane and
rollback aliases reject. See [Ollama's create API](https://docs.ollama.com/api/create).

### Ollama stream controls

Generate, chat, pull, push, and create accept `OllamaStreamControls` in the
document; these controls are not sent as provider request fields.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `onChunk` | [`OllamaChunkCallback`](#ollama-chunk-callback) | No | - | Receives provider-native chunks. |
| `signal` | `AbortSignal` | No | Genuine signal object | Stops renderer observation and sends a best-effort host cancellation control. Whether host work stops depends on the method. |
| `timeoutMs` | `number` | No | Callers must supply a positive finite number; method default otherwise | Renderer request timeout. The current wrapper coerces this value, so do not depend on acceptance of another type. |

Callers must not send internal `stream` or `streamId`; the wrapper creates them.

### Ollama chunk callback

An `OllamaChunkCallback` is called as `onChunk(chunk, metadata)`. `chunk` is a
provider-native JSON object. `metadata` is `{operation, streamId}`. A callback
may be passed directly in place of `OllamaStreamControls`.

### Ollama provider responses

Direct Ollama methods return bounded provider-native envelopes. Arcane does not
normalize their nested fields into the provider-neutral entities above. Core
requires valid JSON, caps a response at 12 MiB, parses newline-delimited stream
data, and resolves a stream with its final provider chunk.

Fields can change with the installed Ollama version. Use the official
[Ollama API reference](https://docs.ollama.com/api/introduction) for the
provider response entities.

- `version()` returns the version envelope.
- `models()` and `list()` return the tags envelope, not `model[]`.
- `running()` returns the running-model envelope, not `model[]`.
- `show`, `generate`, `chat`, `embed`, `push`, `create`, and `delete` return
  their corresponding provider-native envelope.

### Raw Ollama management restrictions

`Arcane.ollama.pull()` and `Arcane.ollama.copy()` always reject and therefore
return `Promise<never>` to an application. A raw pull lacks integrity-bound
pre-download evidence; the managed lifecycle owns registry/GGUF preflight and
native admission. Raw alias copy is reserved to the managed selection workflow.

`push`, `create`, and `delete` require verified package policy and reject
reserved aliases. Unverified-model mode is inference-only and never pulls,
creates, copies, pushes, deletes, or repairs a model.

## Ollama selection and settings

### Arcane model preference

`Arcane.ollama.select(preference)` accepts `ArcaneModelPreference`:

| Value | Meaning |
|---|---|
| `"auto"` | Try the bounded automatic candidate sequence. |
| `"3b"`, `"8b"`, `"12b"`, `"20b"`, `"120b"` | Explicit managed Arcane model size. |

The value is a preference enum, not an arbitrary model name.

### Arcane model selection

`Arcane.ollama.selection()` and `settings()` return `ArcaneModelSelection`.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `preference` | [`ArcaneModelPreference`](#arcane-model-preference) | Yes | - | Saved preference. |
| `recommendedVariant`, `effectiveVariant` | `string` | Yes | Managed variants | Recommended and resolved sizes. |
| `model`, `alias` | `string` | Yes | - | Variant model and stable managed alias. |
| `activeVariant` | `string \| null` | Yes | Managed variant | Persisted active state. |
| `defaultModel` | [`OllamaModelName`](#ollama-model-name) | Yes | - | Default inference model. |
| `bootLoad` | `boolean` | Yes | - | Load during managed startup. |
| `bootKeepAlive` | `"5m" \| "30m" \| "1h" \| "24h" \| "-1"` | Yes | - | Boot residency. |
| `contextLength` | `integer` | Yes | `0` or 1,024-262,144; `0` is Automatic | Saved context. |
| `provider` | `"ollama" \| "openai"` | Yes | - | Saved provider. |
| `openAIModel` | `string` | Yes | - | Saved OpenAI model. |
| `responseLength` | `"low" \| "medium" \| "high"` | Yes | - | Response target. |
| `openAIConfigured` | `boolean` | Yes | - | Protected credential exists. |
| `gpu` | object | Yes | Bounded diagnostic snapshot | Accelerator evidence. |
| `recommendationPending` | `boolean` | Yes | - | Automatic selection awaits persisted admission. |

`gpu` contains `devices` (at most 16 `{name, memoryBytes}` records),
`totalMemoryBytes`, `largestMemoryBytes`, `memoryReliable`, and `source`.

### Arcane model selection result

A successful `select()` returns `ArcaneModelSelectionResult` plus
[`ArcaneOperation`](#arcane-operation).

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model`, `alias`, `variant`, `preference`, `recommendedVariant` | `string` | Yes | Managed values | Selected model identity. |
| `created`, `aliasChanged` | `boolean` | Yes | - | Mutation effects. |
| `baseModel` | `string` | Yes | - | Verified base. |
| `modelsRoot` | `string \| null` | Yes | Host path | Model store. |
| `gpu`, `evidence` | object | Yes | Bounded diagnostics | Native and definition evidence. |
| `compatibility` | [`ModelResourceAdmission`](#model-resource-admission) | Yes | `admitted:true` | Final admission. |
| `recommendationDegraded` | `boolean` | No | Automatic only | Smaller capacity candidate selected. |
| `candidateFailures` | `array` | No | Automatic only | Earlier bounded failures. |
| `rollbackSnapshotRetained` | `boolean` | Yes | - | A recovery snapshot remains because cleanup could not be proven. |
| `recoveryAlias` | `string \| null` | Yes | Reserved alias when retained | Alias an administrator can use for recovery. |
| `operation` | [`ArcaneOperation`](#arcane-operation) | Yes | Completed | Selection operation. |

### Arcane AI settings input

`Arcane.ollama.saveSettings(settings)` reads only runtime-owned fields. Unknown
keys, including stale provider/model preference fields from an old screen, are
ignored so they cannot overwrite newer provider selection.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `defaultModel` | [`OllamaModelName`](#ollama-model-name) | No | Current value | Default runtime model. |
| `bootLoad` | `boolean` | No | Current value | Load at managed startup. |
| `bootKeepAlive` | `"5m" \| "30m" \| "1h" \| "24h" \| "-1"` | No | Current value | Boot residency. |
| `contextLength` | `integer` | No | `0` or 1,024-262,144 | Runtime context; `0` is Automatic. |

Use `select()` for the managed size preference and
`saveProviderSettings()` for provider, OpenAI model, credential, and response
length.

### Arcane AI settings result

A successful settings save returns `ArcaneAISettingsResult`: the complete
[`ArcaneModelSelection`](#arcane-model-selection) snapshot after the mutation,
plus `operation` as an [`ArcaneOperation`](#arcane-operation). It does not return
the selection-only mutation fields such as `created`, `baseModel`, or
`aliasChanged`.

### Arcane brain definition

`Arcane.ollama.createBrain(definition)` reads `ArcaneBrainDefinition`; unknown
keys are currently ignored and should not be sent.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `baseModel` | [`OllamaModelName`](#ollama-model-name) | Yes | - | Base model. |
| `name` | `string` | No | Default `"my-brain"`; normalized to a 1-64 character slug | Brain name. |
| `contextLength` | `integer` | No | `0` for inherited/automatic; use 1,024-262,144 explicitly | Requested context. |
| `makeDefault` | `boolean` | No | Default `false` | Make the created model the default. |

### Arcane brain result

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `model` | `string` | Yes | `arcane-<slug>:latest` | Created model. |
| `baseModel` | `string` | Yes | - | Base model. |
| `defaultModel` | `boolean` | Yes | - | Became the default. |
| `operation` | [`ArcaneOperation`](#arcane-operation) | Yes | Completed | Creation operation. |

### Ollama service settings state

`Arcane.ollama.serviceSettings()` returns a platform-dependent native state.
Microsoft NT reports effective settings and support state. Callers must
feature-detect platform-specific fields rather than assume one cross-platform
exact object.

### Ollama service settings input

`Arcane.ollama.saveServiceSettings(settings)` applies defaults to omitted fields;
send the complete desired `OllamaServiceSettingsInput`. Unknown keys are
currently ignored and should not be sent.

| Field | Type | Required | Constraints / default | Description |
|---|---|---:|---|---|
| `contextLength` | `integer` | No | Default `0`; 0-262,144 | Service context. |
| `keepAlive` | `string` | No | Default `"5m"`; `"-1"`, `"0"`, or 1-9,999 plus `m`/`h` | Residency. |
| `maxLoadedModels` | `integer` | No | Default `1`; 0-16 | Loaded-model limit. |
| `numParallel` | `integer` | No | Default `1`; 1-16 | Parallel requests. |
| `maxQueue` | `integer` | No | Default `512`; 1-4,096 | Queue limit. |
| `flashAttention` | `boolean` | No | Default `false` | Flash attention. |
| `kvCacheType` | `"f16" \| "q8_0" \| "q4_0"` | No | Default `"f16"` | K/V-cache format. |
| `noCloud` | `boolean` | No | Default `true` | Prevent Ollama cloud behavior. |

### Ollama service settings result

A successful save returns the platform result plus
[`ArcaneOperation`](#arcane-operation). Microsoft NT currently reports requested
and effective settings, support/clamping detail, restart state, and post-change
health. Require `healthy === true` where that field exists.

## Errors and capability boundaries

| Method group | Required authority | Additional restriction |
|---|---|---|
| Provider-neutral chat/profile and local status | `ai.inference` | Configured provider; local status is served by desktop Core or an explicitly admitted Android `user-managed-loopback` host, distinguished by `providerMode` and runtime fields. |
| Raw local inventory | `ai.models.read` | Settings, Shell, and Terminal diagnostics. |
| Provider settings/OpenAI model catalog | `ai.settings.manage` | Settings only. |
| `localAI.ensurePlatform()` | `provisioning.manage` | Provisioner type; exclusive. |
| `localAI.recover()` | `ai.inference` | Approved recovery apps; privileged and exclusive. |
| `localAI.setParallelRequests()` | `ai.runtime.manage` | Sole registered grantee; desktop Core only; privileged and exclusive. |
| Speech | `ai.inference` | Requires local speech host. |
| Raw Ollama reads | `ai.models.read` | Diagnostic apps only. |
| Raw Ollama inference | `ai.inference` | Exact model is re-admitted. |
| Ollama mutations | `ai.models.manage` | Verified package policy; raw pull/copy reject. |
| Runtime/provider/service settings | `ai.settings.manage` | Settings restrictions; service mutation is privileged/exclusive. |

Additional invariants:

- Raw inventory must not populate an application model selector. Use the
  admitted `Arcane.localAI.status().models.ollama` catalog.
- Browser runtimes gain no local Ollama authority from the shared API
  vocabulary. Android exposes only its explicitly admitted projection (currently
  `ollama.chat()` for approved applications), not desktop lifecycle or model
  mutation authority.
- Unverified installed-model inference additionally requires
  `ai.models.unverified.inference` and remains inference-only.
- Arcane never silently changes from Ollama to OpenAI after local discovery or
  admission failure.
- Provider credentials are never returned to renderers.
- Status, admission, progress, registry evidence, and model records are
  observations, not grants or reusable authorization.
- Core rechecks current package policy, model identity, and resources at the
  operation boundary.
