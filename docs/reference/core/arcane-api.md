# Arcane API Reference

`window.Arcane` is the immutable application-facing API provided by the Arcane native host bridge. Arcane applications use the same contract when hosted by WebView2 on Microsoft NT, WebKitGTK on Linux, the Android WebView launcher bridge, or the development HTTP bridge. This is not a browser-only API: calls cross into the native Arcane runtime or platform service, and the available native operation is governed by the application's declared capabilities and host policy. This document owns the product-neutral operating-system surface; application-owned extension namespaces and methods are documented with their owning packages and participate in the same completeness check.

The Android bridge is an experimental foundation. Its source controller binds one WebView to one immutable packaged entry at the exact reserved HTTPS origin and denies non-packaged navigation and resources. A generated Android application registry derives the OS bundle version plus Shell identity, entry, and grant intersection from the canonical bundle manifest and method policy registry; each application APK independently derives its app identity and version from `apps/<id>/arcane-package.json`. One immutable host session has no caller-supplied identity, entry, version, or grant inputs. It requires the installed package version to match the expected Shell or app identity, while `version.current()` remains the OS bundle version for every session. The controller consumes that same session entry. AndroidX WebKit injects the bridge only at that origin, and the bridge admits messages only from the main frame after checking source origin, method admission, grant where required, and replay state. The controller can be installed only once and exposes a UI-thread teardown result that distinguishes removal of native bridge authority from full WebView destruction; failed destruction remains retryable, and authority-revoked controllers cannot load or install again. This teardown does not erase the shared WebView profile, cookies, DOM storage, cache, or service-worker data. The canonical Shell receives capability-free, bound-session `system.ping`, `version.current`, and `app.current` plus `platform.status` and `network.status`. Ping returns only `{ok:true}` and does not claim health, readiness, privilege, or trust. Version and application identity are provider-free reads of the immutable session; Android application trust remains `unverified` with no publisher or revocation claim. Android network status preserves the Core meaning of `{ online, interfaceCount }` by counting interfaces with non-loopback addresses, returns no interface identity or address, bounds malformed provider results, and requires no Android permission. The reviewed mailto-only `external.open` host implementation remains unavailable to the Shell because its canonical manifest does not grant that capability. Beyond the generated bootstrap and application-specific providers, methods and URI schemes fail closed. An admitted development application host may additionally expose the package-policy-filtered local-AI, chat, and speech methods through `ai.inference`; applications without that exact admission receive none of them. Generated source authority and package-version equality are not APK-signer or runtime-session authentication. This does not establish a complete Android launcher, authenticated package/session policy, signed application catalog, persistent-profile retention/deletion policy, scoped-storage resource grant, process recovery, update, or release contract.

The current debug-local-test Android distribution supersedes the earlier source-only status above: Kotlin compilation and API 35 instrumentation now pass for a HOME-eligible Shell plus 17 separately installed application APKs. Each app binds one verified packaged entry, Android identity, UID, storage scope, declared grants, and registry-derived network policy. `Arcane.applications.launch(id)` resolves only an installed generated package. Arcane Terminal alone receives the Android terminal provider, which runs bounded `/system/bin/sh` sessions under its ordinary app UID and private default working directory. This remains unsigned local evidence, not signer authentication, production release approval, update/recovery acceptance, or accessibility conformance.

Every operation returns a `Promise` unless the return column says otherwise. Rejected operations use `Arcane.Error`, which exposes `code`, `message`, `resolution`, `diagnosticId`, and technical diagnostic fields when available.

Parameter objects shown as optional may be omitted. Actual availability is also controlled by the application's declared capabilities and native policy.

Android host installation reports whether cleanup remains required and includes the teardown result after a partial setup failure. A launcher must retain that controller and retry close rather than treating every failed installation as clean.

## Namespace, constructor, and value inventory

This inventory covers every enumerable, non-method member exposed directly or through a namespace on `window.Arcane`. Method rows in the later sections are checked separately against the live bridge. Adding, removing, or renaming a public namespace, constructor, value, or method requires the matching reference update in the same change.

| Member | Kind | Description |
|---|---|---|
| `Arcane.protocol` | Value | Exact native bridge protocol identifier, currently `"arcane/1"`. |
| `Arcane.Error` | Constructor | Normalized native/API error constructor with `code`, `message`, `resolution`, `diagnosticId`, and available technical diagnostic fields. |
| `Arcane.runtime` | Namespace | Local renderer and detected-host surface information. |
| `Arcane.events` | Namespace | Native event subscriptions and durable completion observation; see the [event inventory](arcane-events.md#event-inventory) for names, delivery, hosts, triggers, and payloads. |
| `Arcane.ai` | Namespace | Provider-neutral AI profile, model, chat, and provider-setting operations. |
| `Arcane.environment` | Namespace | App-authorized native environment-profile operations. |
| `Arcane.mail` | Namespace | Capability-gated native mail composition and delivery. |
| `Arcane.speech` | Namespace | Native speech readiness, synthesis, and transcription. |
| `Arcane.localAI` | Namespace | Native-host local-AI readiness, reconciliation, recovery, and isolated inference. |
| `Arcane.ollama` | Namespace | Admitted native Ollama inference, inventory, policy, and model-management operations. |
| `Arcane.app` | Namespace | Identity of the application bound to the current host session. |
| `Arcane.applications` | Namespace | Installed-application inventory and launch operations. |
| `Arcane.external` | Namespace | Policy-restricted requests to open external resources. |
| `Arcane.repository` | Namespace | Application repository-service namespaces. |
| `Arcane.terminal` | Namespace | Bounded native terminal-session lifecycle and input operations. |
| `Arcane.capabilities` | Namespace | Capability inventory visible to the bound application. |
| `Arcane.platform` | Namespace | Host platform and execution-evidence status. |
| `Arcane.permissions` | Namespace | Effective permission and capability status. |
| `Arcane.version` | Namespace | Arcane bundle version and installation status aliases. |
| `Arcane.machine` | Namespace | Machine status available to the bound application. |
| `Arcane.user` | Namespace | Current Arcane user identity. |
| `Arcane.requirements` | Namespace | Requirement inventory and authorized installation operations. |
| `Arcane.installation` | Namespace | Installation status, installation, and native uninstaller access. |
| `Arcane.users` | Namespace | Arcane user administration and shell configuration. |
| `Arcane.system` | Namespace | Bounded operating-system actions, metrics, health-independent ping, and failure policy. |
| `Arcane.network` | Namespace | Privacy-bounded native network status. |
| `Arcane.firewall` | Namespace | Firewall-only review, bounded audit, and explicitly confirmed development lifecycle simulation for the global deny policy. |
| `Arcane.filesystem` | Namespace | Native filesystem selection operations. |
| `Arcane.storage` | Namespace | App-scoped native key/value storage. |
| `Arcane.preferences` | Namespace | App-scoped preference reads and atomic writes. |
| `Arcane.appearance` | Namespace | Native appearance state and application. |
| `Arcane.session` | Namespace | Current Arcane session lifecycle. |
| `Arcane.provisioning` | Namespace | Provisioning-plan operations. |
| `Arcane.diagnostics` | Namespace | Bounded diagnostic summary and record retrieval. |
| `Arcane.development` | Namespace | Development-only inspection, context, setup, and tool installation. |

## Core and events

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.runtime.current()` | None | Frozen `{connected, transport, native, managedLocalAI}` | Synchronously describes this document's detected Arcane host surface without sending an RPC. |
| `Arcane.events.on(eventName, listener)` | `eventName`: event-name string or `"*"`; `listener`: callback | `() => void` unsubscribe function | Subscribes to future deliveries from the [event inventory](arcane-events.md#event-inventory). A named listener receives the event data; the wildcard listener receives `{event, data}`. |
| `Arcane.events.once(eventName, listener)` | `eventName`: event-name string; `listener`: callback | `() => void` unsubscribe function | Subscribes to the next matching delivery and removes the listener before invoking it. It does not replay an event that already occurred. |
| `Arcane.events.when(eventName, listener)` | `eventName`: `"transport.ready"` or `"core.ready"`; `listener`: callback | `() => void` unsubscribe function | Subscribes to a durable lifecycle completion. A late subscriber receives the first frozen completion payload asynchronously. |
| `Arcane.events.completed(eventName)` | `eventName`: `"transport.ready"` or `"core.ready"` | `boolean` | Synchronously reports whether this document has stored the designated durable completion. |

`transport.ready` and `core.ready` are the initial durable completions. Their
first JSON payload is snapshotted and frozen before live callbacks run; repeated
completions do not replace it. Ordinary events and `once()` remain future-only,
so progress, stream, and appearance updates are never replayed as stale state.
`transport.ready` means that this document selected a callable Arcane messaging
surface. It does not prove host health, application authority, capability grants,
publisher trust, or release readiness.

`Arcane.runtime.current()` is a local renderer snapshot, not a health,
authorization, or trust claim. `connected` means this document initialized its
selected messaging transport; it does not mean Core answered, a capability is
granted, or a dependency is ready. `native` is true for WebView2, WebKitGTK, and
Android WebView hosts. `managedLocalAI` is true only for the WebView2 and
WebKitGTK desktop host classes that can mediate Arcane-managed local services;
it does not report whether Ollama, speech, or any model is installed or healthy.
Android continues to report `managedLocalAI:false`; that value must not be
changed merely because an admitted host can proxy a user-managed Ollama
listener. The development HTTP bridge and an ordinary standalone browser both report
`native:false` and `managedLocalAI:false`; their transport values are
`development-http` and `standalone`, respectively. The native transport values
are `webview2`, `webkitgtk`, and `android-webview`. Without an app-scoped Core or
the exact Android status response described below, an application is
OpenAI-only. No renderer probes, lists, or calls an Ollama HTTP endpoint
directly.

## Artificial intelligence and Ollama

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.ai.models()` | None | [`Promise<LocalAIInventory>`](arcane-ai-contracts.md#local-ai-inventory) | Lists raw local model inventory for Settings, Terminal, and Shell diagnostics. Application model selectors use the admitted `Arcane.localAI.status().models.ollama` catalog instead. |
| `Arcane.ai.chat(request)` | `request`: [`AIChatRequest`](arcane-ai-contracts.md#ai-chat-request) | [`Promise<AIChatResult>`](arcane-ai-contracts.md#ai-chat-result) | Sends a chat request through the configured provider. |
| `Arcane.ai.profile()` | None | [`Promise<AIProfile>`](arcane-ai-contracts.md#ai-profile) | Gets the effective AI profile, including its canonical conversational response-length target. |
| `Arcane.ai.providerSettings()` | None | [`Promise<AIProviderSettingsResult>`](arcane-ai-contracts.md#ai-provider-settings-result) | Gets provider selection, credential status, and the conversational response-length target. |
| `Arcane.ai.saveProviderSettings(settings)` | `settings`: [`AIProviderSettingsInput`](arcane-ai-contracts.md#ai-provider-settings-input) | [`Promise<AIProviderSettingsResult>`](arcane-ai-contracts.md#ai-provider-settings-result) | Saves provider settings; validates the selected model when OpenAI is selected and validates a supplied replacement credential before persistence. Ollama-selected settings may retain a dormant OpenAI model for later revalidation. |
| `Arcane.ai.providerModels()` | None | [`Promise<AIProviderModelCatalog>`](arcane-ai-contracts.md#ai-provider-model-catalog) | Queries models available to the configured OpenAI account. |
| `Arcane.localAI.status()` | None | [`Promise<LocalAIStatusV2>`](arcane-ai-contracts.md#local-ai-status-v2) | Returns the native host's authoritative package-policy-filtered catalog and readiness. Desktop Core includes native resource and speech admission. An admitted Android application host may instead return `providerMode:"user-managed-loopback"`; that status has no managed lifecycle, but it merges bounded native Kokoro/Whisper role health and catalog evidence while Android speech operations use the separate `Arcane.speech` bridge. Requires `ai.inference`. |
| `Arcane.localAI.ensurePlatform()` | None | [`Promise<LocalAIPlatformResult>`](arcane-ai-contracts.md#local-ai-platform-result) | Runs the Provisioner-only post-install AI reconciliation as one exclusive operation: returns an explicitly selected, configured OpenAI state without touching Ollama, or hardware-admits, ensures, and loads the managed local model according to boot settings. Requires `provisioning.manage` and the `provisioner` app type. |
| `Arcane.localAI.recover(request)` | `request`: [`LocalAIRecoveryRequest`](arcane-ai-contracts.md#local-ai-recovery-request) | [`Promise<LocalAIRecoveryResult>`](arcane-ai-contracts.md#local-ai-recovery-result) | Requests one privileged, exclusive, start-existing-service-only recovery of selected Arcane-managed local services. Requires `ai.inference` and explicit application admission. |
| `Arcane.localAI.setParallelRequests(request)` | `request`: [`LocalAIParallelRequestsRequest`](arcane-ai-contracts.md#local-ai-parallel-request-configuration) | [`Promise<LocalAIParallelRequestsResult>`](arcane-ai-contracts.md#local-ai-parallel-request-configuration) | Solves one app-owned verified model/context's maximum directly from native model and memory/resource evidence without a product ceiling, clamps a positive request to that result (`0` requests the maximum), and changes the machine-wide managed Ollama setting only when needed. A tentative change uses one fresh stopped-service snapshot before the final value is written, then Core ensures, loads, and confirms the exact model. A restart unloads resident models. Automatic mutation currently requires the dedicated `ai.runtime.manage` capability on Microsoft NT desktop Core and operating-system authorization; Linux returns administrator-managed systemd guidance, and Android user-managed loopback sessions do not invoke it. |
| `Arcane.speech.status()` | None | [`Promise<SpeechStatus>`](arcane-ai-contracts.md#speech-status) | Reads bounded, independent Kokoro and Whisper readiness through Core or an admitted Android native host. Requires `ai.inference`. |
| `Arcane.speech.synthesize(request)` | `request`: [`SpeechSynthesisRequest`](arcane-ai-contracts.md#speech-synthesis-request) | [`Promise<SpeechSynthesisResult>`](arcane-ai-contracts.md#speech-synthesis-result) | Synthesizes bounded local speech through the native host and fixed loopback runtime. Requires `ai.inference`. |
| `Arcane.speech.transcribe(request)` | `request`: [`SpeechTranscriptionRequest`](arcane-ai-contracts.md#speech-transcription-request) | [`Promise<SpeechTranscriptionResult>`](arcane-ai-contracts.md#speech-transcription-result) | Sends bounded canonical base64 bytes labeled `audio/webm` to local Whisper through the native host. The bridge validates encoding, label, and bounds; the fixed service parses the media container. Requires `ai.inference`. |
| `Arcane.ollama.version()` | None | [`Promise<OllamaVersionResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Gets the managed Ollama version for Settings, Terminal, and Shell diagnostics. |
| `Arcane.ollama.models()` | None | [`Promise<OllamaModelsResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Lists the raw provider inventory envelope; it is not the application admission catalog. |
| `Arcane.ollama.list()` | None | [`Promise<OllamaModelsResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Alias of the raw `models()` inventory. |
| `Arcane.ollama.running()` | None | [`Promise<OllamaRunningModelsResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Lists the provider running-model envelope. |
| `Arcane.ollama.show(model, options?)` | `model`: [`OllamaModelName`](arcane-ai-contracts.md#ollama-model-name); `options?`: [`OllamaShowOptions`](arcane-ai-contracts.md#ollama-show-options) | [`Promise<OllamaShowResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Gets model metadata and configuration. |
| `Arcane.ollama.generate(request, options?)` | `request`: [`OllamaGenerateRequest`](arcane-ai-contracts.md#ollama-generate-request); `options?`: [`OllamaStreamControls`](arcane-ai-contracts.md#ollama-stream-controls) or [`OllamaChunkCallback`](arcane-ai-contracts.md#ollama-chunk-callback) | [`Promise<OllamaGenerateResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Generates text after Core re-admits the exact requested model; optionally streams chunks. |
| `Arcane.ollama.chat(request, options?)` | `request`: [`OllamaChatRequest`](arcane-ai-contracts.md#ollama-chat-request); `options?`: [`OllamaStreamControls`](arcane-ai-contracts.md#ollama-stream-controls) or [`OllamaChunkCallback`](arcane-ai-contracts.md#ollama-chunk-callback) | [`Promise<OllamaChatResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Runs native Ollama chat after the host re-admits the exact requested model, optionally streamed. An admitted Android host proxies only this inference operation to its user-managed fixed loopback service and exposes no model mutation or lifecycle operation. |
| `Arcane.ollama.embed(request)` | `request`: [`OllamaEmbedRequest`](arcane-ai-contracts.md#ollama-embed-request) | [`Promise<OllamaEmbedResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Creates embeddings after Core re-admits the exact requested model. |
| `Arcane.ollama.pull(model, options?, streamOptions?)` | `model`: [`OllamaModelName`](arcane-ai-contracts.md#ollama-model-name); `options?`: [`OllamaPullOptions`](arcane-ai-contracts.md#ollama-pull-options); `streamOptions?`: [`OllamaStreamControls`](arcane-ai-contracts.md#ollama-stream-controls) or [`OllamaChunkCallback`](arcane-ai-contracts.md#ollama-chunk-callback) | [`Promise<never>`](arcane-ai-contracts.md#raw-ollama-management-restrictions) | Direct application pull fails closed; Arcane's managed workflow owns integrity-bound preflight and admission. |
| `Arcane.ollama.push(model, options?, streamOptions?)` | `model`: [`OllamaModelName`](arcane-ai-contracts.md#ollama-model-name); `options?`: [`OllamaPushOptions`](arcane-ai-contracts.md#ollama-push-options); `streamOptions?`: [`OllamaStreamControls`](arcane-ai-contracts.md#ollama-stream-controls) or [`OllamaChunkCallback`](arcane-ai-contracts.md#ollama-chunk-callback) | [`Promise<OllamaPushResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Pushes only a model authorized by verified application policy. |
| `Arcane.ollama.create(request, options?)` | `request`: [`OllamaCreateRequest`](arcane-ai-contracts.md#ollama-create-request); `options?`: [`OllamaStreamControls`](arcane-ai-contracts.md#ollama-stream-controls) or [`OllamaChunkCallback`](arcane-ai-contracts.md#ollama-chunk-callback) | [`Promise<OllamaCreateResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Creates a package-owned verified alias only after `from`, normalized `system`, and `parameters` match policy and `files`/`adapters` are absent; other admitted fields remain provider-native. |
| `Arcane.ollama.copy(source, destination)` | `source`: [`OllamaModelName`](arcane-ai-contracts.md#ollama-model-name); `destination`: [`OllamaModelName`](arcane-ai-contracts.md#ollama-model-name) | [`Promise<never>`](arcane-ai-contracts.md#raw-ollama-management-restrictions) | Raw application alias copy is denied; managed selection owns alias mutation. |
| `Arcane.ollama.delete(model)` | `model`: [`OllamaModelName`](arcane-ai-contracts.md#ollama-model-name) | [`Promise<OllamaDeleteResponse>`](arcane-ai-contracts.md#ollama-provider-responses) | Deletes only a model authorized by verified application policy. |
| `Arcane.ollama.selection()` | None | [`Promise<ArcaneModelSelection>`](arcane-ai-contracts.md#arcane-model-selection) | Gets Arcane's managed model preference and state. |
| `Arcane.ollama.select(preference)` | `preference`: [`ArcaneModelPreference`](arcane-ai-contracts.md#arcane-model-preference) | [`Promise<ArcaneModelSelectionResult>`](arcane-ai-contracts.md#arcane-model-selection-result) | Selects a managed size preference and reconciles the model. |
| `Arcane.ollama.settings()` | None | [`Promise<ArcaneModelSelection>`](arcane-ai-contracts.md#arcane-model-selection) | Gets Ollama runtime settings. |
| `Arcane.ollama.saveSettings(settings)` | `settings`: [`ArcaneAISettingsInput`](arcane-ai-contracts.md#arcane-ai-settings-input) | [`Promise<ArcaneAISettingsResult>`](arcane-ai-contracts.md#arcane-ai-settings-result) | Saves only runtime-owned default-model, boot-load, keep-alive, and context settings. |
| `Arcane.ollama.createBrain(definition)` | `definition`: [`ArcaneBrainDefinition`](arcane-ai-contracts.md#arcane-brain-definition) | [`Promise<ArcaneBrainResult>`](arcane-ai-contracts.md#arcane-brain-result) | Creates an Arcane brain model. |
| `Arcane.ollama.serviceSettings()` | None | [`Promise<OllamaServiceSettingsState>`](arcane-ai-contracts.md#ollama-service-settings-state) | Gets managed Ollama service settings. |
| `Arcane.ollama.saveServiceSettings(settings)` | `settings`: [`OllamaServiceSettingsInput`](arcane-ai-contracts.md#ollama-service-settings-input) | [`Promise<OllamaServiceSettingsResult>`](arcane-ai-contracts.md#ollama-service-settings-result) | Saves managed service settings. |

The native AI profile always returns `responseLength` as `"low"`, `"medium"`,
or `"high"`; missing or invalid legacy persisted values safely resolve to
`"medium"`. New saves reject any other value. Conversational applications may
use this target to augment their system prompt, but specific user requests and
required application, structured-output, tool, safety, evidence, warning, or
next-step content take precedence.

`Arcane.localAI.status()` is a native-host, non-mutating discovery and
admission API. An abridged representative desktop Core schema-v2 result is:

```json
{
  "schemaVersion": 2,
  "runtime": {
    "kind": "arcane-core",
    "nativeModelAdmission": true
  },
  "policy": {
    "verified_only": true,
    "source": "package-bound-application-policy",
    "unverifiedInferenceAuthorized": false
  },
  "ollama": {
    "available": true,
    "modelCapabilitiesVerified": true,
    "nativeAdmissionEnforced": true,
    "errorCode": null
  },
  "admission": {
    "policyVersion": 1,
    "enforcedBy": "arcane-core",
    "evaluatedModels": 1,
    "admittedModels": 1,
    "rejected": []
  },
  "speech": {
    "available": true,
    "reachable": true,
    "synthesisAvailable": true,
    "transcriptionAvailable": true,
    "synthesisErrorCode": null,
    "transcriptionErrorCode": null,
    "errorCode": null
  },
  "models": {
    "ollama": [
      {
        "id": "EXAMPLE:8b",
        "name": "EXAMPLE:8b",
        "provider": "ollama",
        "roles": [],
        "managed": true,
        "installed": true,
        "admitted": true,
        "runnable": true,
        "creatable": false,
        "pullable": false,
        "verified": true,
        "capabilitiesVerified": true,
        "available": true,
        "modifiedAt": null,
        "sizeBytes": 1,
        "digest": null,
        "family": null,
        "parameterSize": null,
        "quantization": null,
        "compatibility": {
          "policyVersion": 1,
          "admitted": true,
          "status": "compatible",
          "code": null,
          "message": "EXAMPLE:8b fits the current native resource budget.",
          "resolution": null
        }
      }
    ],
    "speech": [
      {
        "id": "kokoro",
        "name": "Kokoro",
        "provider": "speech",
        "roles": ["tts"],
        "available": true,
        "engine": "kokoro"
      }
    ],
    "transcription": [
      {
        "id": "whisper-small",
        "name": "Whisper Small",
        "provider": "speech",
        "roles": ["stt"],
        "available": true,
        "engine": "whisper.cpp"
      }
    ]
  }
}
```

The development Android variant keeps the same schema version and adds the
exact top-level discriminator `providerMode:"user-managed-loopback"`. Its
runtime kind is `android-user-managed-loopback`, `managedLocalAI` remains
false, and `models.ollama` contains only installed package-policy models that
passed the host's bounded provider inspection. The same status operation starts
a concurrent bounded native speech probe and merges its actual role health and
Kokoro/Whisper catalog into the standard speech fields without making speech
failure hide an available Ollama catalog. The separately capability-gated
`Arcane.speech` methods proxy the fixed host-owned loopback speech service for
an admitted application host. Readiness calls `Arcane.speech.status()` through that bridge, while
profile discovery consumes the merged status catalog; neither path fetches a
loopback endpoint from the renderer. Inference uses `Arcane.ollama.chat`. No renderer makes a direct
loopback request, and no recovery, pull, create, delete, start, stop, or repair
method is admitted.

Android Linux Terminal, Ollama, and model lifecycle remain user-owned. A plain loopback Ollama
listener has no caller authentication, so other local applications or
processes can call or race it. This is unsigned development behavior, not
release support, a managed-service claim, or an isolated-inference guarantee.
Android exposes no application-owned isolated-question or repository extension
unless the generated package and method policy explicitly admit it.

An admitted model's `compatibility` also carries the evaluated operation and
model, actual installed model bytes, context tokens, K/V-cache estimate,
runtime headroom, total and additional working-set requirements, available
working-set bytes, loaded and target-resident bytes, and the individual memory
and, for a pull, model-store checks. A rejected entry is returned as
`{id, compatibility}` under `admission.rejected`; its compatibility record has
`admitted:false`, `status:"incompatible"` or
`status:"evidence-unavailable"`, a stable code, bounded message and resolution,
and the evidence that was available. Rejected models do not appear in
`models.ollama`.

Core starts the bounded Ollama catalog, running-model inventory, and speech
health work together and coalesces concurrent status callers. It inspects model
metadata with bounded concurrency before admitting a candidate. A failed
service resolves as service-local status data and does not erase the other
service's result. `ollama.available` means the fixed catalog endpoint returned
a valid bounded inventory; it does not mean any model passed policy or resource
admission. Speech synthesis and transcription remain independent, and the
fixed `kokoro` and `whisper-small` identities appear only when their respective
health dependencies are ready.

### Package policy and authoritative model discovery

The policy is authored only as
`apps/<id>/arcane-package.json.localAIModelPolicy`, carried by the verified
`ARCANE_APP_RELEASE.json` native admission record, and projected by the native
packager only into the compiled Core `APP_DESCRIPTOR.aiModelPolicy`. It is not
returned by `Arcane.app.current()`, `Arcane.capabilities.list()`, a browser
manifest, a document catalog, or another browser-facing API. Renderer code does
not consume or reconstruct it.

For `verified_only:true`, Core considers only app-declared managed candidates.
It verifies an installed alias against the exact packaged app-owned Modelfile
before native resource admission. A missing alias can appear as `creatable`
only when its already-installed base passes admission, or as `pullable` only
when registry preflight supplies the integrity-bound byte and metadata evidence
needed for pull admission. Before inference Core completes that managed
lifecycle and re-verifies the resulting alias. The current automatic path fails
closed when actual base bytes are unavailable before download.

For `verified_only:false`, the native descriptor must also grant
`ai.models.unverified.inference`. Core may additionally consider any
already-installed model, using a bounded default context when the request does
not supply one, but still admits only models whose actual bytes and metadata fit
the current native resource evidence. Unverified access is inference-only:
Core never pulls, creates, repairs, copies, pushes, or deletes an unverified
model. Policy/capability disagreement fails closed during native packaging and
again in Core.

Admission derives from actual installed model bytes and model metadata,
requested context and K/V-cache type, configured parallelism, free system and
GPU memory with safety reserves, currently loaded models and target residency,
and model-store free space for pulls. It does not use renderer-reported hardware
or a GPU-name allowlist. Missing size, context, model metadata, K/V-cache inputs,
native memory evidence, or required storage evidence rejects the model.

For a missing managed base, Core preflights only a canonical Ollama library
registry name. It bounds manifest/configuration responses, layer counts, byte
sizes, redirects, content encoding, deadlines, cache entries, and successively
ranged GGUF prefixes (at most 256 KiB). It SHA-256-verifies the configuration and
its binding to the declared model layers, then extracts only the model dimensions
needed for K/V estimation. The ranged bytes are explicitly not a full layer
digest. After admission, Ollama must finish the full-digest-verified pull and
Core must observe the installed base before alias creation, exact-definition
verification, or inference. Any unavailable or inconsistent evidence fails
closed.

Applications call the method after rendering their initial UI and populate
local-model controls from `models.ollama` in the returned order. They must not
apply a second alias, parameter-count, family, memory, or GPU filter: Core's
catalog is authoritative for that app and session. The method itself does not
change a profile, choose a remote fallback, start or repair a service, pull a
base, create an alias, or perform inference.

Desktop Core admits the status catalog at one parallel request and separately
reports `activeParallelRequests`, `maxAllowedParallelRequests`, and
`activeParallelRequestsAllowed`. Thus a policy-valid model can remain visible
with `runnable:false` when the current machine-wide count is too high. An
authorized model-selection UI can also show Core's bounded
`admission.rejected` records as disabled choices so a model is not mistaken for
uninstalled merely because it cannot currently fit. Those records remain
observations; only the dedicated privileged
`setParallelRequests()` operation can change the count and load a model.

The admitted catalog is part of local inference authorization, so the method
requires `ai.inference`. Raw inventory methods require `ai.models.read` and are
restricted to Settings, Terminal, and Shell. The admitted status API is
unavailable to Android and to an ordinary browser without an app-scoped Core.
Browser applications are OpenAI-only and must not probe or call Ollama directly.
A native standalone package has its own app-scoped Core and can use the status
method when its descriptor grants inference.

`Arcane.localAI.recover()` accepts only the own `services` field; an empty
array, duplicate or unknown identifier, additional field, or unsupported
System Platform fails before an exclusive mutation or elevation request. Core
canonicalizes a two-service request to `ollama` then `speech`. On Microsoft NT,
the fixed service identities are `ArcaneOllama` at
`C:\Program Files\Ollama\ArcaneOllamaService.exe` and `ArcaneLocalSpeech` at
`C:\Program Files\Arcane OS\bin\ArcaneLocalSpeechService.exe`. Before the first
state change, the adapter proves every requested registration's exact command,
`LocalService` account, automatic own-process start configuration, unrestricted
service SID, empty dependencies, the exact service-specific environment, and
regular fixed host. It then runs only `sc.exe start` for a verified stopped
fixed service and rechecks the registration and fixed health proof. The method
never installs, creates, reconfigures, stops, deletes, or changes an ACL. A
successful service result is returned in canonical order; `started` is `true`
only when that recovery request issued the start.

The Microsoft NT development builder places the manifest-bound
`ArcaneLocalSpeechService.exe` host and local speech runtime in the release.
Installation or repair, not this application method, validates the activated
files, registers `ArcaneLocalSpeech` at the fixed path as an automatic
own-process `LocalService` with an unrestricted service SID and no dependencies
or service environment, starts it, and requires its bounded probe. A request
against a pre-change or damaged installation still fails closed with
`LOCAL_AI_SERVICE_NOT_INSTALLED` and verified-repair guidance. Recovery never
adopts an independently launched speech executable. This is development
behavior; production signing and clean-machine promotion evidence remain
deferred.

Application-owned extension methods, schemas, repository bindings, and
isolation policy are documented with the package that owns them. Arcane Core
does not expose a generic Git API or infer application authority from this
product-neutral reference.

## Applications, terminal, and capabilities

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.app.current()` | None | `Promise<app record>` | Gets the exact bound application descriptor. Its `version` is owned by that app's `arcane-package.json`; built-in Shell and Provisioner use the OS bundle version. Android returns the immutable Shell or application-APK identity with `unverified` publisher status. |
| `Arcane.applications.list()` | None | `Promise<{verified, securityMode, publisherTrustSource, revocationStatus, applications}>` | Returns the verified installed-application catalog wrapper visible to Shell or Terminal; it is not a bare array. The RPC authority name is `apps.list`. |
| `Arcane.applications.launch(id)` | Canonical application ID from the current catalog | `Promise<{id, accepted:true}>` | Asks the host to dispatch a registered application. Acceptance does not prove that the target rendered, became ready, or remained open. The RPC authority name is `apps.launch`. |
| `Arcane.external.open(uri)` | Exact printable-ASCII URI without whitespace, fragments, backslashes, malformed escapes, or encoded controls; currently `mailto:` only | `Promise<{opened, uri}>` | Hands a validated URI to the operating system's registered default application. `opened: true` means only that the OS accepted the handoff, not that a composer opened or a message was sent. Simulation fails explicitly instead of claiming a handoff. Requires `external.open`. |
| `Arcane.mail.send({report, reportKey})` | Exact report with `type`, `subject`, `to`, and `text` and/or `html`; `reportKey` matches `[A-Za-z0-9._:-]{8,128}`; report JSON no larger than 786,432 bytes | `Promise<{requestId,status,statusCode,sent,partial,uncertain}>` | Validates and forwards one bounded request to the fixed loopback Arcane mail gateway without Core retry. The shared Mail module preflights the same native size bound. Availability requires explicit `mail.send` application admission on Microsoft NT/Linux Core hosts; Android does not project this method, and simulation fails explicitly. |
| `Arcane.terminal.start(options?)` | `options?`: `{shell="auto", cwd="", columns=120, rows=32}`; shell is `auto`, `powershell`, `cmd`, `bash`, or `sh`; columns 20–500; rows 5–200 | `Promise<{id,shell,cwd,title,columns,rows,createdAt}>` | Starts one of at most eight app-owned native terminal sessions. Requires `terminal.execute`, app id `terminal`, and a Core or Android host. |
| `Arcane.terminal.list()` | None | `Promise<{sessions: Array<{id,shell,cwd,columns,rows,createdAt,state}>}>` | Lists the current app-owned sessions; it returns a wrapper object, not a bare array. Requires `terminal.execute`, app id `terminal`, and a Core or Android host. |
| `Arcane.terminal.write(sessionId, data)` | `sessionId`: 1–128-character session identifier; `data`: 1–65,536 UTF-8 bytes | `Promise<{sessionId,accepted:true,bytes}>` | Writes one input chunk. Output is delivered separately through `terminal.output`, so subscribe before starting a session and correlate chunks by `sessionId`. |
| `Arcane.terminal.resize(sessionId, columns, rows)` | `sessionId`; `columns`: 20–500; `rows`: 5–200 | `Promise<{sessionId,columns,rows,accepted:true,emulated:true}>` | Updates the session dimensions. The current hosts record an emulated resize rather than claiming a native pseudo-terminal resize. |
| `Arcane.terminal.signal(sessionId, signal="interrupt")` | `sessionId`; `signal`: `"interrupt"` or `"terminate"` | `Promise<{sessionId,signal,accepted}>` | Requests a supported control signal. `accepted` reports process-controller acceptance, not process exit; observe `terminal.exit` for completion. |
| `Arcane.terminal.close(sessionId)` | `sessionId`: 1–128-character session identifier | `Promise<{sessionId,accepted:true}>` | Closes input and requests session termination. The resolved value acknowledges the request; observe `terminal.exit` for actual process completion. |
| `Arcane.capabilities.list()` | None | `Promise<{app, grants, methods}>` | Returns the current Core-bound application descriptor, grants, and exact allowed RPC names. Android callers use `Arcane.platform.status().capabilities`; the direct method is not projected there. |

Terminal output and lifecycle changes are event-driven. The canonical [Arcane event inventory](arcane-events.md#event-inventory) defines `terminal.output`, `terminal.exit`, and the Android `terminal.error` payload. The shared `TerminalClient` adapter correlates those deliveries with owned sessions and re-emits DOM events for reusable UI code.

## Platform, installation, users, and system

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.platform.status()` | None | `Promise<status>` | Gets native platform status. |
| `Arcane.permissions.status()` | None | `Promise<status>` | Gets permission/elevation status. |
| `Arcane.version.current()` | None | `Promise<string>` | Gets the Arcane OS bundle/host version bound to this session. It does not become an application's independently owned version and is not signer, update, or RC attestation. |
| `Arcane.version.installation()` | None | `Promise<installation status>` | Alias-like access to installation status. |
| `Arcane.machine.status()` | None | `Promise<status>` | Gets machine readiness/status. |
| `Arcane.user.current()` | None | `Promise<{identityKind, username, accountName, displayName, source}>` | Gets the privacy-minimized bound identity. Microsoft NT/Linux return a `host-account`; Android returns an anonymous `local-session` with null account identifiers. Requires `identity.read`. |
| `Arcane.requirements.list()` | None | `Promise<requirement[]>` | Lists installation requirements. |
| `Arcane.requirements.ensure(requirementIds, options?)` | Array of requirement IDs; omitted, `null`, or empty selects required requirements only; `options.userProcessInterruption` is exactly `deny` or `allow` and defaults to `deny` | `Promise<{requirements, operation, credentials}>` | Ensures the selected requirements are installed/configured. The guarded Provisioner-open Ollama reconciliation always uses `deny`; only the separately confirmed close-and-retry action uses `allow`, and the native handoff still re-proves exact process and port identity before any interruption. |
| `Arcane.installation.status()` | None | `Promise<status>` | Gets installation state. |
| `Arcane.installation.ensure()` | None | `Promise<result>` | Ensures the Arcane installation reaches its required state. |
| `Arcane.installation.openUninstaller()` | None | `Promise<{opened:true}>` | Microsoft NT Provisioner only. Opens the globally installed `C:\Program Files\Arcane OS\bin\ArcaneUninstaller.exe`; it never uninstalls through checkout-local code. `opened` means Windows accepted creation of the installed uninstaller process. The controller separately owns UAC, read-only preflight, scope review, and typed confirmation. |
| `Arcane.users.list()` | None | `Promise<{users, policy, protectedUsernames}>` | Lists supported local users plus the platform username policy and accounts the Provisioner must not convert. |
| `Arcane.users.validate(usernames)` | Username or array | `Promise<{valid, users, errors, policy}>` | Validates candidate usernames without changing an account. |
| `Arcane.users.add(usernames)` | Username or array | `Promise<{users, operation, credentials}>` | Creates/configures local Arcane users and returns sensitive temporary credentials for protected presentation. |
| `Arcane.users.activate(username)` | Username | `Promise<{user, operation, credentials}>` | Activates a staged configured user. |
| `Arcane.users.resetPassword(username)` | Username | `Promise<{user, operation, credentials}>` | Prepares a temporary credential but does not change the operating-system password; apply it with `users.applyPassword()`. |
| `Arcane.users.applyPassword(username, temporaryPassword)` | Username; exact temporary password from the current workflow | `Promise<{user, operation, credentials}>` | Performs the privileged native password mutation and forces change at next sign-in. |
| `Arcane.users.verifyShell(username)` | Username | `Promise<{user, operation, credentials}>` | Verifies the user's Arcane shell configuration. |
| `Arcane.users.restoreShell(username)` | Username | `Promise<{user, operation, credentials}>` | Restores the recorded supported shell configuration. |
| `Arcane.system.lock()` | None | `Promise<result>` | Locks the operating-system session. |
| `Arcane.system.ping()` | None | `Promise<{ok:true}>` | Confirms only that the bound host bridge admitted and answered the request. It does not claim dependency readiness, system health, privilege, signer trust, or release-candidate status. |
| `Arcane.system.metrics()` | None | `Promise<metrics>` | Gets allowed machine metrics. |
| `Arcane.system.failurePolicy()` | None | `Promise<{failFast:boolean}>` | Gets the user-wide verification behavior. `failFast` defaults to `false`; application-owned repository readers may use it to choose validated-subset warnings or immediate rejection. Settings only. |
| `Arcane.system.saveFailurePolicy(settings)` | `{failFast:boolean}` | `Promise<{failFast:boolean}>` | Saves warn-first (`false`) or fail-fast (`true`) behavior. The preference does not expose quarantined documents or relax repository-write validation. Settings only. |
| `Arcane.network.status()` | None | `Promise<{online, interfaceCount}>` | Counts interfaces with at least one non-loopback address. `online` does not claim Internet, DNS, captive-portal, route, or service reachability. |
| `Arcane.firewall.status()` | None | `Promise<FirewallStatus>` | Firewall-app-only status for the canonical policy, Arcane-owned platform plan/state, projection, audit count, limitations, supported lifecycle operations, and fail-closed `installReady`/`enableReady` evidence. Current non-simulation status is unsupported; simulation is labeled and never claims machine-wide coverage. Requires `firewall.read`. |
| `Arcane.firewall.audit(options?)` | Optional `{limit}` integer from 1 through 200 | `Promise<FirewallAudit>` | Returns bounded lifecycle and owned-state metadata, not packet payloads or complete per-packet attribution. Requires `firewall.read`. |
| `Arcane.firewall.install(expectation)` | `{expectedPolicyGeneration, expectedStateGeneration}` | `Promise<FirewallOperationResult>` | After separate user confirmation, stages the reviewed global-deny projection in deterministic development simulation. Domain projection may use bounded system DNS and admits at most 4,096 domain rules; status disables Install before confirmation when the canonical policy exceeds that native ceiling. Live mutation is unavailable. Requires `firewall.manage`. |
| `Arcane.firewall.enable(expectation)` | `{expectedPolicyGeneration, expectedStateGeneration}` | `Promise<FirewallOperationResult>` | After confirmation, enables only the exact installed, unexpired projection in simulation; it does not resolve or silently replace policy. Requires `firewall.manage`. |
| `Arcane.firewall.disable(expectation)` | `{expectedPolicyGeneration, expectedStateGeneration}` | `Promise<FirewallOperationResult>` | After confirmation, disables only Arcane-owned simulation state. Requires `firewall.manage`. |
| `Arcane.firewall.rollback(expectation)` | `{expectedPolicyGeneration, expectedStateGeneration}` | `Promise<FirewallOperationResult>` | After confirmation, restores only an unexpired retained projection for the current canonical policy when it preserves every current deny. Requires `firewall.manage`. |
| `Arcane.firewall.recover(expectation)` | `{expectedPolicyGeneration, expectedStateGeneration}` | `Promise<FirewallOperationResult>` | After confirmation, reconciles only Arcane-owned simulation state; divergence blocks other lifecycle actions. Requires `firewall.manage`. |

Core-backed `platform.status` and `machine.status` records include `execution.hostPlatform`, `execution.effectivePlatform`, `execution.simulation`, and `execution.evidenceClass`. The Android bridge returns the same execution fields with `application-host` evidence. A simulated effective platform is test evidence only; no simulation or source-only Android assertion is real-host, publisher, signing, or release-candidate evidence.

The native desktop contract retains the technical compatibility values `platform: "windows"` and `rawPlatform: "win32"`; user-facing interfaces present that family as **Microsoft NT**. `arcane/modules/SystemPlatformPresentation.js` maps the verified status to `Microsoft NT` or `Linux` and applies `arcane-kernel-nt` or `arcane-kernel-linux`, plus `data-arcane-kernel`, to the document root. Those DOM values exist only for presentation and CSS. They must never grant a capability, establish release trust, select a native adapter, or substitute for `Arcane.permissions.status()` and host-verified execution evidence.

The canonical authority registry in `machine_bundles/arcane-os-machine-bundle/src/api/method-policies.json` defines the current RPC surface. The canonical semantic definitions for the shared or contract-bound methods live in `machine_bundles/arcane-os-machine-bundle/src/api/method-contracts.json`. They are deliberately separate from method authority policy: semantic effect metadata cannot grant a capability, admit an application or host, or imply privilege. Core executes the closed input/output validators at its request and response boundaries. Android consumes separately generated semantic constants for its admitted cross-host subset and validates or constructs the corresponding results; Core alone consumes the fixed-loopback mail contract. The exact unsigned-debug Android distribution now has Kotlin build parity and API 35 Launcher, Browser, and Terminal instrumentation evidence. The registry remains a partial vertical slice: privacy-safe audit and confirmation infrastructure, definitions for the remaining Core-only methods, production signing, real-device conformance, and candidate review are still required.

## Filesystem, storage, preferences, and appearance

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.filesystem.selectDirectory(options?)` | `options?`: `{title?, initialPath?}`; title up to 200 plain-text characters; initial path must be an existing absolute directory | `Promise<{cancelled:boolean, path:string\|null}>` | Opens the native directory picker after a user action. It returns one canonical existing directory or explicit cancellation; it does not enumerate or grant access to directory contents. Requires `filesystem.directory.select`. |
| `Arcane.storage.list()` | None | `Promise<{keys:string[], usedBytes:number, maximumBytes:1048576}>` | Lists sorted keys and quota use for the current application's isolated native storage. Requires `storage.read`. |
| `Arcane.storage.get(key)` | `key`: 1–128-character app-storage key | `Promise<{key, found:boolean, value}>` | Reads one app-scoped JSON value. A missing key resolves with `found:false,value:null`. Requires `storage.read`. |
| `Arcane.storage.set(key, value)` | `key`; JSON-compatible `value` up to 131,072 encoded bytes | `Promise<{key, value, bytes, totalBytes, maximumBytes}>` | Atomically writes one app-scoped value under the 1 MiB total quota. Requires `storage.write`. |
| `Arcane.storage.delete(key)` | `key`: 1–128-character app-storage key | `Promise<{key, deleted:boolean, totalBytes, maximumBytes}>` | Deletes one app-scoped value; an absent key resolves with `deleted:false`. Requires `storage.write`. |
| `Arcane.preferences.list()` | None | `Promise<{keys:string[], usedBytes:number, maximumBytes:1048576}>` | Lists sorted keys and quota use for the current application's isolated preferences. Requires `preferences.read`. |
| `Arcane.preferences.get(key)` | `key`: 1–128-character preference key | `Promise<{key, found:boolean, value}>` | Reads one preference. A missing key resolves with `found:false,value:null`. Requires `preferences.read`. |
| `Arcane.preferences.set(key, value)` | `key`; JSON-compatible `value` up to 131,072 encoded bytes | `Promise<{key, value, bytes, totalBytes, maximumBytes}>` | Atomically writes one preference under the 1 MiB total quota. Requires `preferences.write`. |
| `Arcane.preferences.setMany(entries)` | Plain object containing one to 32 preference key/value entries | `Promise<{keys, count, bytes, totalBytes, maximumBytes}>` | Validates the complete bounded batch and writes it atomically; no preference changes when any entry is invalid. Requires `preferences.write`. |
| `Arcane.preferences.delete(key)` | `key`: 1–128-character preference key | `Promise<{key, deleted:boolean, totalBytes, maximumBytes}>` | Deletes one preference; an absent key resolves with `deleted:false`. Requires `preferences.write`. |
| `Arcane.environment.list()` | None | `Promise<{platform, pathSupported, maximumEntries, valueMaximumLength, persistence, entries}>` | Lists the native Arcane environment profile. Ordinary values are returned; protected values are exactly `•••••`. Requires `environment.read` and explicit application admission. |
| `Arcane.environment.get(name)` | `name`: environment-variable name | `Promise<{entry}>` | Gets one configured entry. This is the deliberate plaintext-reveal operation: a protected entry's real value crosses the native bridge to the authorized renderer. Requires the separate `environment.protected.read` capability. |
| `Arcane.environment.set(name, value, options?)` | `name`: environment-variable name; `value`: string up to 32,767 characters generally, but a Linux protected value is limited by the 8,191-byte encoded Secret Service payload (about 6,126 ASCII value bytes); `options.protected?`: Boolean | `Promise<{entry}>` | Creates or replaces a desktop user-scoped or Android app-scoped entry. Android rejects `PATH`; the SDK defaults sensitive-looking names to protected storage, and the returned protected value remains `•••••`. Requires `environment.write` and explicit application admission. |
| `Arcane.environment.remove(name)` | `name`: environment-variable name | `Promise<{name, deleted:true}>` | Deletes one configured entry. Requires `environment.write` and explicit application admission. |
| `Arcane.appearance.current()` | None | `Promise<{supported, platform, scheme, effectiveScheme, captionColor, textColor}>` | Gets the current native appearance state. Requires `appearance.read`; Linux currently reports `supported:false`. |
| `Arcane.appearance.apply(appearance)` | `{scheme?:"system"\|"light"\|"dark", captionColor?, textColor?}` with custom colors in `rgb(r, g, b)` form | `Promise<{supported, platform, scheme, effectiveScheme, captionColor, textColor}>` | Applies supported current-user native appearance values and returns the resulting state. Requires `appearance.write`; Linux currently reports unsupported without claiming a mutation. |

### Environment profile contract

The public SDK is positional and constructs closed RPC parameter objects:

```js
const inventory = await Arcane.environment.list();
const saved = await Arcane.environment.set(
  'EXAMPLE_API_KEY',
  'synthetic-development-value',
  { protected: true }
);
const revealed = await Arcane.environment.get('EXAMPLE_API_KEY');
const removed = await Arcane.environment.remove('EXAMPLE_API_KEY');
```

The corresponding native requests are exactly `{}`, `{name}`,
`{name,value,protected}`, and `{name}`. Unknown or missing fields are rejected.
`protected` is a Boolean in the native set request. If the SDK caller omits the
options object, the SDK derives that Boolean from the sensitive-name policy;
callers should pass `{protected:true}` or `{protected:false}` when their data
classification is already known.

An environment entry has this exact application-facing shape:

```js
{
  name: 'EXAMPLE_API_KEY',
  scope: 'user',
  protected: true,
  configured: true,
  value: '•••••'
}
```

`list()` returns
`{platform,pathSupported,maximumEntries,valueMaximumLength,persistence,entries}`.
`get()` and `set()` return `{entry}`. `remove()` returns
`{name,deleted:true}`. `configured` is always `true` for a returned entry; a
missing `get()` or `remove()` rejects with `ENVIRONMENT_ENTRY_NOT_FOUND`.
Empty-string values are valid and are not deletion.

`list()` returns an ordinary entry's actual value, but replaces every protected
value with exactly five U+2022 bullet characters (`•••••`). `set()` applies the
same mask to its protected result. Only an explicit `get(name)` returns a
protected value in plaintext. That reveal is intentional and is why
`environment.get` has the separate `environment.protected.read` capability.
The value then exists in the authorized renderer and process memory; the mask is a
display and data-minimization control, not encryption or authorization.

Names must match `^[A-Za-z_][A-Za-z0-9_.-]{0,127}$`; values are strings of no
more than 32,767 characters and cannot contain a null character. A profile has
at most 256 entries. The current profiles use case-insensitive identity for
replacement and preserve the most recently supplied display spelling. Names
whose uppercase separator-delimited tokens include `KEY`, `KEYS`, `TOKEN`,
`TOKENS`, `SECRET`, `SECRETS`, `PASSWORD`, `PASSWORDS`, `PASS`, `PASSWD`, `PWD`,
`CREDENTIAL`, `CREDENTIALS`, `AUTH`, or `BEARER` are treated as sensitive. The conservative heuristic also recognizes
separated or compact API-key, access-key/access-token, auth-key/auth-token,
private-key, and client-secret variants, including `APIKEY`, `ACCESSKEY`,
`ACCESSTOKEN`, `AUTHKEY`, `AUTHTOKEN`, `PRIVATEKEY`, and `CLIENTSECRET` forms.
Matching names must be protected; `protected:false` is rejected for them.
`PATH` is executable-discovery configuration and must remain ordinary;
`environment.set` rejects `{protected:true}` for that exact name.

| Platform | Entry scope | `pathSupported` | Ordinary storage | Protected storage | `persistence` |
|---|---|---:|---|---|---|
| Microsoft NT (`windows`) | `user` | `true` | Current user's `HKCU\Environment` values with exact string-kind verification and compensating rollback | Current-user DPAPI-protected Arcane record; inventory strips protected plaintext inside the helper | `windows-current-user-environment` |
| Linux | `user` | `true` | Arcane-managed current-user profile | Freedesktop Secret Service through `secret-tool`; no plaintext fallback | `arcane-managed-current-user-environment` |
| Android | `app` | `false` | Host-package private app storage | AES-GCM ciphertext whose key is held by Android Keystore | `android-app-encrypted-environment` |

Desktop Core serializes all four environment operations through one bounded
32-request process-local queue and one current-user cross-process lease, so an
inventory or reveal in another app-scoped Core cannot race a mutation. Core
releases and verifies the lease before returning success. A live owner returns
`ENVIRONMENT_OPERATION_BUSY`; a dead or invalid owner is preserved and returns
`ENVIRONMENT_RECOVERY_REQUIRED` rather than being reclaimed across an uncertain
two-store transition. `set()` and `remove()` also retain the global
exclusive-mutation boundary. Native set results must match the requested name,
protection decision, and exact ordinary value or protected five-bullet mask
before Core returns them.
Microsoft NT rejects a protected-record/plaintext-registry shadow. Linux binds
new protected values to a random Secret Service generation in a namespace that
does not overlap legacy entries, fsyncs the metadata file and directory before
cleaning the prior generation, and keeps legacy lookup compatibility.
Failure to verify candidate, prior-generation, or deletion cleanup rejects with
`ENVIRONMENT_PROTECTED_CLEANUP_FAILED`. Linux post-rename durability ambiguity
rejects with `ENVIRONMENT_METADATA_COMMIT_UNCERTAIN`. Native code retains
bounded cleanup and mutation-uncertainty detail internally, but the renderer's
normalized `Arcane.Error` currently exposes the public error code rather than
those internal fields. Treat either code as uncertain, refresh inventory, and
do not blindly retry. Android returns
`ANDROID_ENVIRONMENT_STORAGE_UNCERTAIN` if its synchronous profile commit cannot
prove persistence.

The Linux `secret-tool` path accepts at most 8,191 bytes for Arcane's complete
prefixed Base64 payload (6,126 ASCII value bytes; fewer for multibyte UTF-8).
Larger Linux protected values reject with
`ENVIRONMENT_PROTECTED_VALUE_TOO_LARGE`; ordinary values and other platforms
retain the general contract bound. A nonzero Secret Service lookup is treated
as storage unavailable because the CLI does not distinguish absence from an
unavailable or locked service reliably.

On Microsoft NT, an ordinary `PATH` is the current user's registry value; a
successful mutation broadcasts the platform environment-change notification,
but already-running processes do not thereby receive a rewritten environment.
On Linux, `PATH` belongs to the Arcane-managed user profile rather than silently
rewriting a shell startup file. Android does not expose a mutable operating-
system user PATH: `PATH` get, set, and remove requests are rejected and the list
metadata reports `pathSupported:false`.

The method policies admit these operations only to explicitly authorized
application IDs on Core and Android hosts. `list()` requires
`environment.read`; `get()` requires `environment.protected.read`; and `set()`
plus `remove()` require `environment.write` and run as exclusive mutations.
Desktop reads and writes also share the bounded serialized environment queue.
The owning application reference records the concrete admission and UI boundary.

Native storage and preferences resolve below
`<state-root>/Arcane OS/apps/<application-id>/` as `storage.json` and
`preferences.json`. The host-bound canonical app ID selects the folder; callers
cannot provide a different identity. Browser OPFS follows
`apps/<application-id>/...`, DBLS fallback keys use
`arcane.apps.<application-id>:`, and native browser profiles are also app-owned.
Unowned legacy global data is preserved but not guessed into an app. The complete
layout and same-origin browser limitation are maintained in the repository-only
[Application data isolation](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/application-data-isolation.md); see the public [repository-access boundary](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/apps/docs/guides/repository-access.md#private-developer-material).

## Session, provisioning, diagnostics, and development

| Method | Parameters | Return | Description |
|---|---|---|---|
| `Arcane.session.logout()` | None | `Promise<{requested:true, accepted:true, simulated:true, command, args}\|{requested:true, accepted:true, simulated:false, command, pid}>` | Requests logout of the current host operating-system session. This is not an Arcane-only application exit, and acceptance does not prove logout completed. Shell-only; requires `session.control`. |
| `Arcane.provisioning.plan(usernames)` | Username or array | `Promise<{ok, version, installation, requirements, users, usernamePolicy, elevated, simulation, blocked, steps}>` | Creates a current read-only provisioning plan without applying it. Provisioner-only; requires `provisioning.manage`. |
| `Arcane.diagnostics.recentErrors()` | None | `Promise<diagnostic[]>` | Lists up to 60 recent in-memory structured Core errors, newest first. Requires `diagnostics.read`. |
| `Arcane.diagnostics.get(diagnosticId)` | Opaque diagnostic ID from a recent error | `Promise<diagnostic>` | Gets one current in-memory diagnostic record or rejects after it is evicted. Requires `diagnostics.read`. |
| `Arcane.development.inspect(root)` | Existing absolute canonical Arcane checkout root | `Promise<{root, runtimeVersion, repository, git, tools, signing, readiness}>` | Read-only inspection of an approved development workspace. Developer-only; requires `development.read`. |
| `Arcane.development.context(root, query)` | Approved checkout root; 1–4,096-character query | `Promise<{root, query, files, totals}>` | Gets redacted context from at most ten tracked safe text files, bounded to 6,144 characters per file and 49,152 characters overall. Developer-only; requires `development.read`. |
| `Arcane.development.setup(root, taskId)` | Checkout root; `root-dependencies`, `machine-dependencies`, `git-hooks`, or `windows-signing` | `Promise<{root, taskId, completed:true, exitCode, operation}>` | Runs one inspected allowlisted development setup task with operation progress. Developer-only; requires `development.manage`. |
| `Arcane.development.installNode()` | None | `Promise<{installed, simulated, node, operation}>` | Installs and verifies the supported Node.js 22+ development runtime on Microsoft NT. Developer-only privileged mutation; requires `development.manage`. |

## Maintenance rule

The source of truth for the application-facing native bridge API is `machine_bundles/arcane-os-machine-bundle/src/frontend/shared/arcane-api.js`. Follow the repository-only [Developer Reference Maintenance SOP](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/developer-reference-sop.md) (see [Repository and download access](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/apps/docs/guides/repository-access.md#private-developer-material)): every added, removed, renamed, or changed `Arcane` member must update the exact inventory or method table, including parameters, return, and description, in the same change. Renderer-visible event changes must also update the [Arcane event inventory](arcane-events.md#event-inventory). Long-form member guides enrich these canonical rows; they do not replace or duplicate the checked inventory.
