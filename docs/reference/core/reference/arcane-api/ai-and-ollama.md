# Arcane API AI and Ollama guides

These guides distinguish provider-neutral AI from direct Ollama access and from
Arcane-managed lifecycle operations. Feature-detect the method, then use
`Arcane.capabilities.list()` when an application must explain why a method is
unavailable. A method name in the shared JavaScript vocabulary is not itself a
grant.

Rejected calls use `Arcane.Error`. Branch on `code`, and present `message` and
`resolution` to the user; do not parse human-readable messages as protocol
values. Provider credentials, operation credentials, admission snapshots, and
model inventory must not be logged or treated as reusable authorization.

The complete request and result entities are defined in the
[Arcane AI contracts](../../arcane-ai-contracts.md). Managed operations emit
the standard [Arcane operation events](../../arcane-events.md#event-inventory).

## Arcane.ai.models()

### Overview

`Arcane.ai.models()` reads normalized installed-model diagnostics from the
Arcane-managed Ollama service. Use it in diagnostic UI, not to populate an
application model selector. Application inference choices must come from the
admitted `Arcane.localAI.status().models.ollama` catalog.

### Parameters

The method takes no arguments.

### Return value

It resolves to `LocalAIInventory`: `{provider: "arcane-ollama", models}`. The
bounded `models` array has at most 512 records with `name`, `modifiedAt`,
`sizeBytes`, `digest`, `family`, `parameterSize`, and `quantization` fields.

### Availability

This is a desktop Core diagnostic API. It requires `ai.models.read` and is
admitted only to Settings, Shell, and Terminal. Browser previews and the
current Android projection do not expose it.

### Errors and recovery

An unavailable or malformed local provider can reject with a local-Ollama
request or `LOCAL_OLLAMA_INVALID_RESPONSE` error. Recheck service health before
retrying. `METHOD_NOT_ALLOWED` requires the correct admitted diagnostic app;
retrying from another app does not add authority.

### Streaming, cancellation, and events

This is one non-streaming inventory read. It emits no method event and exposes
no per-call `AbortSignal`. The renderer's ordinary request timeout or page
teardown can stop waiting without promising to cancel host work.

### Example

```javascript
const inventory = await globalThis.Arcane.ai.models();

for (const model of inventory.models) {
    console.info(model.name, model.parameterSize ?? 'unknown size');
}
```
## Arcane.ai.chat()

### Overview

`Arcane.ai.chat(request)` sends one non-streaming chat request through the
configured Ollama or OpenAI provider and normalizes the result. Prefer it when
application code should remain provider-neutral. Bind a request to the profile
you presented by sending `expectedProvider`; Arcane then rejects a concurrent
provider change instead of silently switching providers.

### Parameters

`request` is a closed `AIChatRequest`. `messages` is required and contains 1-128
exact `{role, content}` records. Roles are `system`, `user`, or `assistant`;
each content string is nonempty and at most 131,072 characters, and combined
content is at most 512 KiB. Portable optional fields are `expectedProvider` and
`format` (`"json"`, `""`, or `null`). `model`, `options`, `tools`,
`keep_alive`, `think`, `logprobs`, and `top_logprobs` are Ollama-only controls.
An omitted local model uses the saved default; OpenAI always uses the saved,
account-validated model.

### Return value

It resolves to normalized `AIChatResult`: `provider`, `model`, an assistant
`message`, `done`, `doneReason`, `promptEvalCount`, and `evalCount`. Ollama can
also supply bounded `message.thinking` and `message.toolCalls`. Response content
and thinking are each retained up to 4 MiB.

### Availability

The current public method requires `ai.inference` on desktop Core. It can use
the selected local Ollama service or protected OpenAI credential. The current
Android projection exposes direct `Arcane.ollama.chat()`, not this
provider-neutral method.

### Errors and recovery

Correct invalid request, message, model, format, or context errors before
retrying. `AI_PROVIDER_CHANGED` means refresh `Arcane.ai.profile()` and let the
user confirm the new provider. OpenAI can reject with
`OPENAI_NOT_CONFIGURED`, `OPENAI_MODEL_REQUIRED`,
`OPENAI_MODEL_UNAVAILABLE`, network, bounded-response, or invalid-response
errors. Local model admission errors require a currently runnable admitted
model or the managed lifecycle; Arcane never falls back to another provider.

### Streaming, cancellation, and events

This API resolves one normalized result and emits no chunk event. The wrapper
uses a 130-second renderer timeout and does not expose a per-call signal.
Desktop Core can cooperatively cancel the underlying method when it receives a
host control frame, including page teardown, but timeout or teardown should
still be treated as an unknown completion boundary rather than a retry token.

### Example

```javascript
const arcane = globalThis.Arcane;
const profile = await arcane.ai.profile();
const result = await arcane.ai.chat({
    expectedProvider: profile.provider,
    messages: [
        {role: 'system', content: 'Answer briefly and accurately.'},
        {role: 'user', content: 'Explain the current model in one sentence.'}
    ]
});

console.info(result.message.content);
```

## Arcane.ai.profile()

### Overview

`Arcane.ai.profile()` returns the effective provider-neutral AI selection. Use
it to label chat UI and to bind `Arcane.ai.chat()` with `expectedProvider`; it
is not a settings mutation API.

### Parameters

The method takes no arguments.

### Return value

It resolves to `AIProfile` with `provider` (`"ollama"` or `"openai"`),
`model`, `configured`, `local`, and `responseLength` (`"low"`, `"medium"`, or
`"high"`). An OpenAI profile resolves only after Arcane proves a protected
credential exists and the configured model is available to that account.

### Availability

This method requires `ai.inference` on desktop Core. The Ollama branch is local;
the OpenAI branch performs a protected account-model network request. The
current Android projection does not expose this method.

### Errors and recovery

For OpenAI, `OPENAI_NOT_CONFIGURED`, `OPENAI_MODEL_REQUIRED`, or
`OPENAI_MODEL_UNAVAILABLE` requires Settings to repair the credential or model.
Surface network and bounded-response failures as temporary provider failures;
do not switch providers automatically.

### Streaming, cancellation, and events

This is a non-streaming snapshot and emits no method event. It has no per-call
signal. A profile can become stale immediately, so bind consequential chat
requests with `expectedProvider`.

### Example

```javascript
const profile = await globalThis.Arcane.ai.profile();
const locationLabel = profile.local ? 'On this device' : 'Remote provider';

console.info(profile.model, locationLabel, profile.responseLength);
```

## Arcane.ai.providerSettings()

### Overview

`Arcane.ai.providerSettings()` reads credential-free provider settings for the
Settings application. Use it to initialize provider controls; use
`Arcane.ai.profile()` in ordinary inference UI.

### Parameters

The method takes no arguments.

### Return value

It resolves to `{provider, openAIModel, openAIConfigured, responseLength}`.
`openAIConfigured` reports only whether protected credential material exists.
The credential is never returned, and this read does not live-validate the
account or configured model.

### Availability

This is a desktop Core Settings-only API requiring `ai.settings.manage`.
Browser previews, other apps, and the current Android projection cannot read
it.

### Errors and recovery

`METHOD_NOT_ALLOWED` requires the admitted Settings application and cannot be
recovered by retry. Transport or protected-store failures should leave the
existing UI state uncommitted and offer a later retry.

### Streaming, cancellation, and events

This is a non-streaming read with no method event or exposed signal. Treat its
result as a snapshot, especially before a subsequent save.

### Example

```javascript
const settings = await globalThis.Arcane.ai.providerSettings();

console.info({
    provider: settings.provider,
    model: settings.openAIModel,
    credentialPresent: settings.openAIConfigured,
    responseLength: settings.responseLength
});
```

## Arcane.ai.saveProviderSettings()

### Overview

`Arcane.ai.saveProviderSettings(settings)` applies a provider-settings patch.
Use it only from Settings after explicit user intent. Arcane protects OpenAI
credentials and attempts to roll back credential and settings changes together
when a save fails.

### Parameters

The patch can contain `provider`, `openAIModel`, `responseLength`, `token`, and
`removeToken`; omitted keys preserve current values. `provider` is `"ollama"`
or `"openai"`. `openAIModel` is 1-128 characters matching
`[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. `responseLength` is `"low"`, `"medium"`,
or `"high"`. A replacement `token` is trimmed, begins with `sk-`, and is
20-512 characters. Only `removeToken: true` requests deletion, and a supplied
token becomes the final credential. Arcane performs account-model validation
when OpenAI is selected or a replacement token is supplied.

### Return value

It resolves to the credential-free settings shape
`{provider, openAIModel, openAIConfigured, responseLength}` after persistence.

### Availability

This is an exclusive desktop Core mutation requiring `ai.settings.manage` and
the Settings app identity. OpenAI validation uses the network and protected
credential store. It is not projected to Android.

### Errors and recovery

Correct `INVALID_AI_PROVIDER_SETTINGS`, provider, model, response-length, or
token errors before retrying. OpenAI account/model errors require a valid
credential and accessible model. On `CREDENTIAL_STORE_UNAVAILABLE`, leave the
prior settings in place. `CREDENTIAL_ROLLBACK_FAILED` requires diagnostics and
manual Settings review before another mutation. Never log a supplied token.

### Streaming, cancellation, and events

The method does not stream or emit operation events. The wrapper waits up to
130 seconds and exposes no signal. Core does not cooperatively cancel this
mutation, so closing the page or timing out can stop observation while the save
continues; read `providerSettings()` before deciding whether to retry.

### Example

This credential-free example selects local inference. Read a new OpenAI token
from a protected user input at call time rather than embedding it in source.

```javascript
document.querySelector('#confirm-provider-settings')?.addEventListener(
    'click',
    async function handleConfirmedProviderSettings() {
        const saved = await globalThis.Arcane.ai.saveProviderSettings({
            provider: 'ollama',
            responseLength: 'medium'
        });
        console.info(saved.provider, saved.responseLength);
    }
);
```

## Arcane.ai.providerModels()

### Overview

`Arcane.ai.providerModels()` lists OpenAI model identifiers accessible to the
stored credential. Use it to populate the Settings model control, not to list
local Ollama models.

### Parameters

The method takes no arguments.

### Return value

It resolves to `{provider: "openai", models}`, where `models` is a sorted array
of bounded account-accessible identifiers.

### Availability

This is a desktop Core, Settings-only method requiring `ai.settings.manage`.
It performs one protected OpenAI model-list network request and requires a
stored credential even when Ollama is currently selected. Android does not
project it.

### Errors and recovery

`OPENAI_NOT_CONFIGURED` requires the user to save a credential. Provider
unavailable, request-failed, response-too-large, or invalid-response errors are
not evidence that a previously saved model should be deleted; keep the current
choice and offer a later retry.

### Streaming, cancellation, and events

This is one non-streaming network read with no method event or per-call signal.
The wrapper timeout is 130 seconds. Avoid issuing a request for every render or
keystroke; refresh it as one owned Settings task.

### Example

```javascript
const catalog = await globalThis.Arcane.ai.providerModels();

for (const modelId of catalog.models) {
    console.info(modelId);
}
```

## Arcane.localAI.status()

### Overview

`Arcane.localAI.status()` discovers currently admitted local inference and
speech choices. Use its `models` catalogs for application selectors and its
provider-local status fields for recovery UI. The snapshot is evidence, not a
grant; Core rechecks policy, identity, and resources at inference time.

### Parameters

The method takes no arguments. Core accepts only the empty request generated by
the wrapper. Concurrent callers in one Core process can share the active
discovery, so reuse one application-owned refresh instead of polling from each
component.

### Return value

It resolves to schema-version 2 status with `runtime`, `policy`, `ollama`,
`admission`, `speech`, and `models: {ollama, speech, transcription}`. Desktop
Core reports native resource admission. Admitted Android returns
`providerMode: "user-managed-loopback"` and a bounded package-policy catalog;
its lifecycle remains user-managed and native desktop admission is not claimed.
Provider discovery failures normally resolve as local `available`,
`errorCode`, and empty-catalog state rather than rejecting the whole snapshot.

### Availability

The method requires `ai.inference`. Desktop Core admits it according to package
policy. Android projects it only to explicitly admitted application identities,
using fixed host-owned loopback providers. A browser preview has no local-AI
authority.

### Errors and recovery

An invalid request or package-policy/capability mismatch can reject. Otherwise,
branch on the returned service-local error codes. Refresh after a documented
recovery action; do not interpret a transient unavailable service as permission
to switch providers or mutate models.

### Streaming, cancellation, and events

Status is a non-streaming snapshot and emits no method event. The wrapper waits
up to 15 seconds and exposes no signal. Core discovery is not cooperatively
cancellable through this method; keep refreshes owned and avoid overlapping
poll loops.

### Example

```javascript
const status = await globalThis.Arcane.localAI.status();
const runnableModels = status.models.ollama.filter(
    function selectRunnableLocalModel(model) {
        return model.runnable === true;
    }
);

console.info(status.runtime.kind, runnableModels.length);
```

## Arcane.localAI.ensurePlatform()

### Overview

`Arcane.localAI.ensurePlatform()` performs the Provisioner's exclusive
post-install AI reconciliation. It verifies the current provider settings,
ensures or repairs the selected verified local model when needed, applies
resource admission, and optionally loads it. Do not use it as an ordinary app
readiness probe; use `localAI.status()` instead.

### Parameters

The method takes no arguments. It snapshots the current AI settings and retries
its plan up to three times when they change concurrently.

### Return value

Every result includes a completed `ArcaneOperation`. The OpenAI branch reports
`local.available: false`, reason `"openai-selected"`, a configured `fallback`,
and no local load. The local branch reports the selected model, alias, variant,
final compatibility, bounded automatic-candidate failures, no fallback, and
the managed load result.

### Availability

This is a desktop Core, Provisioner-type method requiring
`provisioning.manage`. It is an exclusive mutation and is not in the Android
projection.

### Errors and recovery

Provider configuration, verified-model, registry, native-admission,
installation, and load failures preserve their stable Arcane codes and
resolutions. `ARCANE_AI_PROFILE_CHANGED` means settings changed during three
plans; refresh settings and let the user restart reconciliation. Arcane does
not silently select OpenAI after local failure.

### Streaming, cancellation, and events

Subscribe before calling if the Provisioner shows progress. The operation emits
`operation.started`, `operation.log`, `operation.progress`,
`operation.completed`, or `operation.failed` data keyed by operation ID. The
wrapper uses the long-operation timeout and exposes no signal; Core does not
cooperatively cancel this workflow, so page teardown is not rollback.

### Example

Run this only in the admitted Provisioner flow after installation succeeds.

```javascript
document.querySelector('#confirm-local-ai-reconciliation')?.addEventListener(
    'click',
    async function handleConfirmedLocalAIReconciliation() {
        const result = await globalThis.Arcane.localAI.ensurePlatform();
        if (result.local.available) {
            console.info('Local AI is ready:', result.local.model);
        } else {
            console.info('Configured provider:', result.fallback.provider);
        }
    }
);
```

## Arcane.localAI.recover()

### Overview

`Arcane.localAI.recover(request)` starts and verifies existing approved
Arcane-managed local services. It does not install, replace, stop, or silently
reconfigure a service. Use it only from the admitted recovery journey after
status identifies a recoverable service outage.

### Parameters

`request` is exactly `{services}`. `services` is a nonempty, duplicate-free
subset of `"ollama"` and `"speech"`; the result uses canonical Ollama-then-
speech order.

### Return value

It resolves to `{ready: true, services, operation}`. Each service record is
exactly `{id, serviceName, endpoint, state: "running", ready: true, started}`
and the completed operation is the privileged recovery receipt.

### Availability

This is a privileged, exclusive Core method for explicitly admitted recovery
application identities with `ai.inference`. The managed recovery adapter is
currently available on Microsoft NT. Linux reports recovery as unsupported,
and Android owns its local services outside Arcane.

### Errors and recovery

Correct `LOCAL_AI_RECOVERY_INPUT_INVALID` before retrying. Unsupported platform,
missing registration, service configuration, health, elevation, lease, or
output-contract errors require the resolution on the `Arcane.Error`; do not
substitute an installer or arbitrary service command from renderer code.

### Streaming, cancellation, and events

The workflow emits standard operation lifecycle and progress events. It is not
streaming and exposes no signal. Core does not cooperatively cancel it, so a
renderer timeout or page close can leave recovery running; refresh
`localAI.status()` before any retry.

### Example

```javascript
document.querySelector('#confirm-local-ai-recovery')?.addEventListener(
    'click',
    async function handleConfirmedLocalAIRecovery() {
        const result = await globalThis.Arcane.localAI.recover({
            services: ['speech']
        });
        console.info(result.services[0].ready);
    }
);
```

## Arcane.localAI.setParallelRequests()

### Overview

`Arcane.localAI.setParallelRequests(request)` calculates and applies the
machine-wide Ollama parallel-request count for one exact app-owned verified
model. It can restart Ollama, evict all resident models, and terminate in-flight
local inference. Use it only in the sole registered application-owned
administrative flow with clear impact disclosure.

### Parameters

`request` is exactly `{model, parallelRequests, contextTokens?}`. `model` is an
app-owned verified identifier. `parallelRequests` is a nonnegative safe integer:
`0` requests the maximum currently admitted; a positive request is a ceiling
that Arcane can clamp down. `contextTokens` is a positive safe integer when
present and otherwise uses the verified Modelfile value. Native model metadata,
not an Arcane product ceiling, governs the maximum context.

### Return value

The schema-version 1 receipt reports requested, previous, maximum allowed,
allowed, and effective parallelism; context and native-context evidence;
clamping, change, restart, health, and load state; evicted models; final
admission; and a completed operation. Treat capacity evidence as a current
snapshot, not a future performance promise.

### Availability

This is a privileged, exclusive desktop Core method for the sole registered
owning application identity, requiring `ai.runtime.manage`. Microsoft NT applies
the setting. Linux returns a 501 manual-systemd error, and Android does not
expose the method.

### Errors and recovery

Input, app-owned-model, verified-policy, admission, capacity, unsupported,
apply, health, load, and rollback errors are actionable by stable code. Arcane
attempts to restore the prior count when loading fails after a change. After
any uncertain completion, refresh status and service settings before another
mutation.

### Streaming, cancellation, and events

The method emits standard operation events but no provider chunks. It has a
long renderer timeout and no signal, and Core does not cooperatively cancel the
workflow. A timeout or page close can occur while the service transaction
continues.

### Example

This no-change-oriented example requests the currently active count for a
verified runnable model; it can still perform verification and loading.

```javascript
document.querySelector('#confirm-parallel-request-change')?.addEventListener(
    'click',
    async function handleConfirmedParallelRequestChange() {
        const arcane = globalThis.Arcane;
        const status = await arcane.localAI.status();
        const model = status.models.ollama.find(
            function findVerifiedRunnableModel(candidate) {
                return candidate.verified === true && candidate.runnable === true;
            }
        );
        if (!model) return;

        const result = await arcane.localAI.setParallelRequests({
            model: model.id,
            parallelRequests: status.ollama.activeParallelRequests
        });
        console.info(result.effectiveParallelRequests);
    }
);
```

## Arcane.speech.status()

### Overview

`Arcane.speech.status()` directly checks the fixed local speech service. Use it
when UI needs current synthesis and transcription readiness. Unlike
`localAI.status()`, this direct call rejects when the host cannot reach and
validate the speech health response.

### Parameters

The method takes no arguments.

### Return value

It resolves to `{ready, synthesisAvailable, transcriptionAvailable, status,
ttsEngine, sttEngine}`. `ready` is true only when both roles are ready; use the
role-specific booleans when UI needs only synthesis or transcription.

### Availability

The method requires `ai.inference` and a fixed host-owned local speech service.
It is available on desktop Core and, through the current Android projection, to
explicitly admitted application identities. Browser previews cannot reach it.

### Errors and recovery

`LOCAL_SPEECH_UNAVAILABLE`, request-failed, invalid-response, or
response-too-large errors mean the direct health contract was not proven.
Offer the admitted managed recovery journey where available; do not probe or
start arbitrary loopback services from renderer code.

### Streaming, cancellation, and events

This is a non-streaming health read with no method event. The wrapper timeout
is 10 seconds and no per-call signal is exposed. Core does not cooperatively
cancel this method; Android also does not expose speech cancellation.

### Example

```javascript
const status = await globalThis.Arcane.speech.status();

console.info({
    synthesis: status.synthesisAvailable,
    transcription: status.transcriptionAvailable
});
```

## Arcane.speech.synthesize()

### Overview

`Arcane.speech.synthesize(request)` converts bounded text to local speech. Use
it only after checking synthesis readiness, and create an audio URL from the
returned bytes without logging the base64 payload.

### Parameters

`request` uses the portable fields `input`, `model`, `voice`,
`responseFormat`, and `speed`. `input` is required, trimmed, nonempty, and at
most 4,000 characters. Defaults are `model: "kokoro"`, `voice: "af_heart"`,
`responseFormat: "opus"`, and `speed: 1`. The voice matches
`[a-z0-9][a-z0-9_-]{0,63}`, the format is `"opus"` or `"wav"`, and speed is
0.5-2 inclusive. Send documented types; do not rely on host coercion of
off-contract values.

### Return value

It resolves to `{audioBase64, contentType}`. The canonical base64 represents
1 byte through 6 MiB of audio, and `contentType` is `"audio/ogg"` or
`"audio/wav"` matching the selected format.

### Availability

This method requires `ai.inference` and a ready fixed local speech provider.
It is available on desktop Core and to explicitly admitted applications through
the Android projection. Android bounds speech work to one active and one queued
operation.

### Errors and recovery

Correct `INVALID_LOCAL_SPEECH_REQUEST` locally. Unavailable, request-failed,
response-too-large, or invalid-response errors require a health refresh or
managed recovery. On Android, `ANDROID_SPEECH_QUEUE_FULL` means wait for the
owned active operation before retrying.

### Streaming, cancellation, and events

Synthesis returns one complete audio result and emits no method event. The
wrapper timeout is 180 seconds, no signal is exposed, and timeout or page
teardown does not promise cancellation of Core or Android speech work.

### Example

```javascript
const result = await globalThis.Arcane.speech.synthesize({
    input: 'Your local speech service is ready.',
    voice: 'af_heart',
    responseFormat: 'opus',
    speed: 1
});

console.info(result.contentType, result.audioBase64.length);
```

## Arcane.speech.transcribe()

### Overview

`Arcane.speech.transcribe(request)` sends bounded caller-supplied audio bytes,
labeled as WebM, to the fixed local transcription service. Use it after local
capture permission and recording have succeeded; the method itself does not
capture audio or grant microphone permission.

### Parameters

`audioBase64` is required canonical base64: at most 8 MiB encoded and 1 byte
through 6 MiB decoded. `mimeType` defaults to `"audio/webm"`; codec parameters
may follow, but the base type must be WebM. `model` defaults to
`"whisper-small"`. Core accepts the bounded Whisper-name pattern while the
current Android provider requires exactly `"whisper-small"`. The host validates
the label, encoding, and size; the fixed service decodes the media container.

### Return value

It resolves to `{text}` with a trimmed transcript from a response bounded to
64 KiB.

### Availability

This method requires `ai.inference` and ready local transcription. It is
available on desktop Core and to explicitly admitted applications through the
Android projection. Browser capture permission is separate from method
admission.

### Errors and recovery

Correct invalid base64, size, MIME, or model errors before retrying.
Unavailable, request-failed, response-too-large, and invalid-response errors
require a status refresh or managed recovery. On Android, wait for owned speech
work after `ANDROID_SPEECH_QUEUE_FULL`.

### Streaming, cancellation, and events

Transcription resolves one complete text result and emits no method event. The
wrapper timeout is 180 seconds and no signal is exposed. Core and Android do
not promise cancellation when the renderer stops waiting.

### Example

```javascript
async function transcribeRecordedWebM(audioBase64) {
    const result = await globalThis.Arcane.speech.transcribe({
        audioBase64: audioBase64,
        mimeType: 'audio/webm',
        model: 'whisper-small'
    });
    return result.text;
}
```

## Arcane.ollama.version()

### Overview

`Arcane.ollama.version()` reads the fixed local Ollama provider's version
envelope. Use it for diagnostics and compatibility display, not as model
readiness or authorization evidence.

### Parameters

The method takes no arguments.

### Return value

It resolves to Ollama's provider-native version JSON. Arcane requires valid
JSON and bounds the response to 12 MiB, but provider fields can vary with the
installed Ollama version.

### Availability

This is a desktop Core diagnostic API requiring `ai.models.read`; it is
admitted only to Settings, Shell, and Terminal. Core calls the fixed
`127.0.0.1:11434` provider. The current Android projection and browser previews
do not expose this method.

### Errors and recovery

`LOCAL_OLLAMA_REQUEST_FAILED` covers an unavailable service, HTTP failure, or
invalid provider response and marks retryable server failures where applicable.
Refresh service status or use an admitted recovery workflow before retrying.
`METHOD_NOT_ALLOWED` requires the correct diagnostic app.

### Streaming, cancellation, and events

This is a non-streaming read with no method event or exposed signal. The
provider request has a five-second Core timeout; the renderer also owns its
outer request timeout.

### Example

```javascript
const versionInfo = await globalThis.Arcane.ollama.version();

console.info(versionInfo.version ?? 'Unknown Ollama version');
```

## Arcane.ollama.models()

### Overview

`Arcane.ollama.models()` reads Ollama's installed tags envelope. Use it for raw
diagnostics. It is not the normalized `Arcane.ai.models()` inventory and must
not populate an application selector; use admitted `localAI.status()` models
for inference UI.

### Parameters

The method takes no arguments.

### Return value

It resolves to the bounded provider-native `/api/tags` envelope, usually with
a `models` array. Nested fields follow the installed Ollama version rather than
an Arcane-normalized entity contract.

### Availability

This desktop Core method requires `ai.models.read` and is limited to Settings,
Shell, and Terminal. It is not projected to Android or browser previews.

### Errors and recovery

Local provider transport, HTTP, invalid-JSON, and bounded-response failures
reject as Arcane errors. Recheck local service health and retry as one owned
diagnostic refresh. Do not turn a raw provider record into an authorization or
verified-model claim.

### Streaming, cancellation, and events

This is one non-streaming read with no method event or per-call signal. Core's
provider timeout is ten seconds.

### Example

```javascript
const tags = await globalThis.Arcane.ollama.models();

for (const model of tags.models ?? []) {
    console.info(model.name ?? model.model ?? 'Unnamed model');
}
```

## Arcane.ollama.list()

### Overview

`Arcane.ollama.list()` is a JavaScript alias for
`Arcane.ollama.models()`. It invokes the same `ollama.models` Core method and
returns the same raw tags envelope. Prefer one spelling consistently within an
application.

### Parameters

The method takes no arguments.

### Return value

It resolves to the bounded provider-native `/api/tags` envelope, not a bare
model array.

### Availability

The alias has exactly the `ollama.models` boundary: desktop Core,
`ai.models.read`, and Settings, Shell, or Terminal only. There is no distinct
`ollama.list` capability-policy method and no Android projection.

### Errors and recovery

Handle the same local-provider and method-admission errors as
`Arcane.ollama.models()`. A retry is useful only after service health or
transport state can have changed.

### Streaming, cancellation, and events

This is a non-streaming read with no method event or signal. It does not create
a second catalog or cache; it is just another wrapper name for the same call.

### Example

```javascript
const tags = await globalThis.Arcane.ollama.list();
const installedCount = Array.isArray(tags.models) ? tags.models.length : 0;

console.info(installedCount);
```

## Arcane.ollama.running()

### Overview

`Arcane.ollama.running()` reads Ollama's currently loaded-model envelope. Use
it for diagnostics such as residency display. It is a momentary provider
snapshot, not proof that capacity or admission will remain available.

### Parameters

The method takes no arguments.

### Return value

It resolves to the bounded provider-native `/api/ps` JSON, usually with a
`models` array. Arcane does not normalize its nested provider fields.

### Availability

This is a desktop Core diagnostic read requiring `ai.models.read`, admitted
only to Settings, Shell, and Terminal. Android and browser previews do not
expose it.

### Errors and recovery

An unavailable provider, failed HTTP request, invalid JSON, or oversized
response rejects. Refresh local service status before retrying. An empty
provider array is a valid no-model-loaded state, not an error.

### Streaming, cancellation, and events

This method does not stream or emit events and has no signal. Core's provider
timeout is ten seconds. Models can load or unload immediately after resolution.

### Example

```javascript
const running = await globalThis.Arcane.ollama.running();

for (const model of running.models ?? []) {
    console.info(model.name ?? model.model ?? 'Unnamed loaded model');
}
```

## Arcane.ollama.show()

### Overview

`Arcane.ollama.show(model, options?)` reads provider metadata for one installed
model. Use it for bounded diagnostics and compatibility inspection; returned
metadata is not verified package provenance or reusable admission evidence.

### Parameters

`model` is required and matches
`[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}`. The optional object has only `verbose`;
send a Boolean when requesting provider verbose metadata. The wrapper builds
the top-level `model` field, and Core rejects unknown top-level fields.

### Return value

It resolves to Ollama's bounded provider-native `/api/show` envelope. Nested
metadata, parameters, template, and capability fields depend on the installed
provider version.

### Availability

This desktop Core method requires `ai.models.read` and Settings, Shell, or
Terminal identity. It is not projected to Android or browser previews.

### Errors and recovery

`INVALID_AI_MODEL` requires a valid installed-model identifier.
`INVALID_OLLAMA_REQUEST`, provider not-found, request, invalid-response, or
bounded-response errors should be surfaced without upgrading raw metadata into
a verified-model claim. Refresh inventory before retrying a not-found model.

### Streaming, cancellation, and events

This is a non-streaming read with no method event or signal. Core gives the
provider request 30 seconds.

### Example

```javascript
const metadata = await globalThis.Arcane.ollama.show('gemma3:latest', {
    verbose: false
});

console.info(metadata.details ?? metadata.model_info ?? {});
```

## Arcane.ollama.generate()

### Overview

`Arcane.ollama.generate(request, streamOptions?)` calls Ollama's direct generate
API after Core re-admits the exact model and requested context. Use it only
when provider-native generation fields or chunks are required; use
`Arcane.ai.chat()` for provider-neutral application chat.

### Parameters

`request` is a closed plain object, encoded to at most 8 MiB. Required `model`
uses the Ollama name pattern. Supported provider fields are `prompt`, `suffix`,
`images`, `format`, `options`, `system`, `template`, `context`, `raw`,
`keep_alive`, `think`, `logprobs`, and `top_logprobs`. When supplied,
`options.num_ctx` is a safe integer from 1,024 through 262,144.

`streamOptions` can be a named chunk callback or `{onChunk, signal,
timeoutMs}`. Pass a genuine `AbortSignal` and a positive finite timeout; callers
must not send the wrapper-owned `stream` or `streamId` fields.

### Return value

Without chunk delivery, it resolves to Ollama's bounded provider-native
generate envelope. With `onChunk`, the callback receives `(chunk,
{operation: "generate", streamId})` for each filtered stream record, and the
promise resolves to the final provider chunk.

### Availability

This is a desktop Core method requiring `ai.inference`. Verified app models can
be ensured or repaired before final admission. Unverified installed-model
inference additionally requires `ai.models.unverified.inference` and remains
inference-only. Applications with an isolated-model contract must use their
application-owned isolated API. Android does not project direct generate.

### Errors and recovery

Correct invalid request, model, stream, serialization, size, and context errors
locally. Model policy, verification, installation, isolated-operation, and
resource-admission errors require a currently admitted model or the documented
managed workflow. Provider failures reject as local-Ollama request errors;
Arcane does not fall back to OpenAI.

### Streaming, cancellation, and events

Chunk delivery is backed by internal `ollama.chunk` events filtered to the
wrapper-created stream ID; callers normally use `onChunk`, not a global event
subscription. The default timeout is ten minutes. Aborting the supplied signal
rejects the renderer promise, sends a cancel control, and desktop Core
cooperatively destroys the active provider request. A chunk-callback exception
is logged by the event dispatcher; own callback errors explicitly if they must
fail application work.

### Example

```javascript
const arcane = globalThis.Arcane;
const status = await arcane.localAI.status();
const model = status.models.ollama.find(function findRunnableModel(candidate) {
    return candidate.runnable === true;
});

if (!model) {
    throw new Error('No admitted local model is currently runnable.');
}

const controller = new AbortController();

function handleGenerateChunk(chunk, metadata) {
    console.info(metadata.operation, chunk.done === true ? 'done' : 'working');
}

const finalChunk = await arcane.ollama.generate({
    model: model.id,
    prompt: 'Write one short, credential-free greeting.'
}, {
    onChunk: handleGenerateChunk,
    signal: controller.signal,
    timeoutMs: 120000
});

console.info(finalChunk.done === true);
```

## Arcane.ollama.chat()

### Overview

`Arcane.ollama.chat(request, streamOptions?)` sends a provider-native Ollama
chat after the host rechecks package policy, model identity, and current
admission. Use it when Ollama-specific messages, tools, options, or streaming
are intentional; use `Arcane.ai.chat()` for a normalized provider-neutral
result.

### Parameters

On desktop Core, `request` is a closed plain object of at most 8 MiB with
required `model` and provider-native `messages`. Optional fields are `tools`,
`format`, `options`, `keep_alive`, `think`, `logprobs`, and `top_logprobs`;
`options.num_ctx`, when present, is 1,024-262,144. `streamOptions` can be a
named callback or `{onChunk, signal, timeoutMs}` and is not forwarded to
Ollama.

Android admits a narrower generated contract for explicitly approved apps: 1-128
bounded messages with `system`, `user`, `assistant`, or `tool` roles; bounded
`format`, `think`, `tools`, and selected generation options; at most 512 KiB of
combined message content and 768 KiB encoded request data. Do not send desktop-
only `keep_alive` or log-probability fields when targeting Android.

### Return value

It resolves to the final bounded provider-native chat envelope. With
`onChunk`, each callback receives `(chunk, {operation: "chat", streamId})` and
the promise resolves to the final provider chunk. Direct provider fields are
not normalized into `AIChatResult`.

### Availability

The method requires `ai.inference`. Desktop Core admits it according to package
policy and native resource checks. Android projects the bounded user-managed-
loopback form only to explicitly approved apps and repeats package-policy/provider
inspection before dispatch. Plain browser previews have no Ollama authority.

### Errors and recovery

Correct invalid request, message, option, model, stream, size, or response
errors locally. Policy, verified-model, installation, queue, isolated-operation,
and capacity errors require a runnable admitted model; never bypass them by
calling loopback directly. Android can additionally report queue, timeout,
cancel, invalid-provider-response, or response-size errors. No branch silently
changes provider.

### Streaming, cancellation, and events

The wrapper filters internal `ollama.chunk` events by its generated stream ID.
The default renderer timeout is ten minutes. A supplied signal cancels the
renderer request; desktop Core cooperatively destroys its provider request and
Android cancels the owned chat task. Store application cleanup for any external
controller or UI listener.

### Example

```javascript
const arcane = globalThis.Arcane;
const status = await arcane.localAI.status();
const model = status.models.ollama.find(function findRunnableChatModel(candidate) {
    return candidate.runnable === true;
});

if (!model) {
    throw new Error('No admitted local model is currently runnable.');
}

function handleChatChunk(chunk, metadata) {
    console.info(metadata.operation, chunk.done === true ? 'done' : 'working');
}

const result = await arcane.ollama.chat({
    model: model.id,
    messages: [{role: 'user', content: 'Reply with one short sentence.'}]
}, {
    onChunk: handleChatChunk,
    timeoutMs: 120000
});

console.info(result.message?.content ?? 'No text returned');
```

## Arcane.ollama.embed()

### Overview

`Arcane.ollama.embed(request)` creates provider-native local embeddings after
Core re-admits the exact model and requested context. Use it only when an
application intentionally owns the Ollama embedding contract and the returned
vectors' storage/privacy lifecycle.

### Parameters

`request` is a closed plain object of at most 8 MiB. Required `model` uses the
Ollama name pattern. Supported provider fields are `input` (text or a batch),
`truncate`, `dimensions`, `keep_alive`, and `options`; when present,
`options.num_ctx` is 1,024-262,144. Nested provider-native values are forwarded
for Ollama to validate.

### Return value

It resolves to Ollama's bounded provider-native embed envelope, including the
provider's vectors and metadata. Arcane does not normalize vector count or
dimension into a separate stable entity.

### Availability

This is a desktop Core method requiring `ai.inference`. Verified models can use
the managed ensure/repair path before admission. Unverified installed models
also require `ai.models.unverified.inference`. Applications with an isolated
model contract must use their application-owned API, and Android does not
project direct embed.

### Errors and recovery

Correct invalid object, unknown field, model, serialization, request-size, or
context errors before retrying. Model-policy, installation, isolation, and
resource-admission errors require a currently admitted embedding model.
Provider failures remain local-Ollama errors and never trigger remote fallback.

### Streaming, cancellation, and events

The public wrapper does not accept stream controls, a chunk callback, or an
`AbortSignal`; it resolves one result and emits no method event. Its renderer
timeout is ten minutes. Although the Core RPC boundary can cancel an embed
request when a host control arrives, application code has no per-call signal in
this API.

### Example

```javascript
async function embedNonSensitiveText(verifiedEmbeddingModel, text) {
    if (typeof text !== 'string' || text.length === 0) {
        throw new TypeError('Embedding input must be nonempty text.');
    }
    return globalThis.Arcane.ollama.embed({
        model: verifiedEmbeddingModel,
        input: text
    });
}
```

## Arcane.ollama.pull()

### Overview

`Arcane.ollama.pull(model, options?, streamOptions?)` is intentionally denied to
applications. A raw mutable-tag pull lacks integrity-bound pre-download
evidence and native resource admission. Use an admitted managed selection or
application-model workflow; do not retry the raw method or call Ollama's
loopback endpoint directly.

### Parameters

The wrapper accepts a model name, optional `{insecure}`, and optional stream
controls. Model names use the 1-256 character Ollama pattern and `insecure`
would be provider-native registry control. These arguments do not relax the
Core policy denial.

### Return value

For application callers the method returns `Promise<never>`: it rejects before
issuing a provider pull and therefore has no success envelope.

### Availability

The vocabulary is present only at desktop Core's `ai.models.manage` boundary,
but every admitted application call is denied. Verified-only policy returns
`MANAGED_MODEL_WORKFLOW_REQUIRED`; unverified-model policy returns
`UNVERIFIED_MODEL_MUTATION_FORBIDDEN`. Android and browser previews do not gain
model-management authority.

### Errors and recovery

Both policy errors are terminal for this raw method. Choose a model through
`Arcane.ollama.select()` or another package-bound managed workflow that performs
registry evidence, integrity verification, and resource admission. Do not
weaken transport security with `insecure` as a workaround.

### Streaming, cancellation, and events

Although the wrapper signature accepts stream controls, Core rejects before a
provider request, so there are no chunks or operation events to cancel.

### Example

This safe example demonstrates the required denial without starting a download.

```javascript
try {
    await globalThis.Arcane.ollama.pull('gemma3:latest');
    throw new Error('Raw Ollama pull unexpectedly succeeded.');
} catch (error) {
    const expectedCodes = [
        'MANAGED_MODEL_WORKFLOW_REQUIRED',
        'UNVERIFIED_MODEL_MUTATION_FORBIDDEN'
    ];
    if (!expectedCodes.includes(error.code)) {
        throw error;
    }
    console.info('Use the managed Arcane model workflow.');
}
```

## Arcane.ollama.push()

### Overview

`Arcane.ollama.push(model, options?, streamOptions?)` pushes an exact
package-authorized verified model through the local Ollama provider. It can
transfer model data to a configured registry. Use it only after explicit user
authorization and provider/registry review; ordinary applications should not
expose raw model publishing.

### Parameters

`model` is required and must be both a valid Ollama name and an app-owned
verified definition. The optional provider object contains only Boolean
`insecure`; keep it false unless an approved development registry explicitly
requires otherwise. Stream controls can be a named callback or `{onChunk,
signal, timeoutMs}` and are not forwarded as provider fields.

### Return value

It resolves to the bounded provider-native push envelope. With a chunk callback,
the callback receives `(chunk, {operation: "push", streamId})`, and the promise
resolves with the final provider chunk.

### Availability

This is an exclusive desktop Core mutation requiring `ai.models.manage` and an
exact verified-only package model. Unverified-model mode is inference-only.
Android and browser previews do not expose it.

### Errors and recovery

Invalid request/model errors require correction. Missing verified policy or an
unknown app model is not retryable without a new package. Registry/provider
failures can be retried only after confirming that a duplicate or partial
remote publication is safe. Never place registry credentials in the request or
logs.

### Streaming, cancellation, and events

Chunks use wrapper-filtered `ollama.chunk` events. The default renderer timeout
is 50 minutes. A supplied signal stops renderer observation, but push is not in
Core's cooperatively cancellable method set; the host/provider mutation can
continue. Aborting is not rollback, and no `ArcaneOperation` receipt is added
to the provider-native result.

### Example

The helper is deliberately not invoked. Call it only after an admitted UI has
obtained explicit publishing confirmation.

```javascript
async function pushVerifiedModelAfterConfirmation(model) {
    function reportPushChunk(chunk) {
        console.info(chunk.status ?? 'Push is running.');
    }

    return globalThis.Arcane.ollama.push(model, {insecure: false}, {
        onChunk: reportPushChunk,
        timeoutMs: 3000000
    });
}
```

## Arcane.ollama.create()

### Overview

`Arcane.ollama.create(request, streamOptions?)` exposes a tightly restricted
verified model-definition create path. Core accepts creation only for an exact
app-owned model and rechecks the base model and resource admission. Prefer the
managed selection or `createBrain()` workflow unless the application package
explicitly owns this definition.

### Parameters

The closed request is at most 8 MiB and requires a valid `model`. The direct
parser recognizes `from`, `files`, `adapters`, `template`, `license`, `system`,
`parameters`, `messages`, and `quantize`. The managed verified boundary requires
`from`, normalized `system`, and `parameters` to match the package definition
exactly and forbids `files` and `adapters`. Do not add other provider-native
controls unless the package contract expressly owns them. Reserved Arcane and
rollback aliases are denied. Stream controls are a callback or `{onChunk,
signal, timeoutMs}`.

### Return value

It resolves to Ollama's bounded provider-native create envelope. With
`onChunk`, callbacks receive `(chunk, {operation: "create", streamId})`, and
the promise resolves to the final chunk. This raw response does not include an
`ArcaneOperation`.

### Availability

This is an exclusive desktop Core mutation requiring `ai.models.manage`,
verified-only package policy, and an exact app-owned definition. Unverified
mode, Android, browser previews, and reserved aliases cannot use it.

### Errors and recovery

`MODEL_NOT_APP_VERIFIED`, `MODEL_DEFINITION_VERIFICATION_FAILED`, managed-
workflow, resource-admission, and unverified-mutation errors require the
package-owned workflow rather than edited renderer input. Provider failure can
leave uncertain local creation state; refresh model inventory and verification
before retrying.

### Streaming, cancellation, and events

Create chunks are filtered by the wrapper's stream ID. The default renderer
timeout is 50 minutes. A supplied signal rejects renderer observation, but
Core does not cooperatively cancel this raw create mutation; verify final local
state after timeout or teardown.

### Example

The helper is intentionally not invoked. Its definition must come from
immutable package-owned policy, never user-edited JSON.

```javascript
async function createVerifiedDefinition(definition) {
    function reportCreateChunk(chunk) {
        console.info(chunk.status ?? 'Create is running.');
    }

    return globalThis.Arcane.ollama.create({
        model: definition.name,
        from: definition.from,
        system: definition.system,
        parameters: definition.parameters
    }, {
        onChunk: reportCreateChunk,
        timeoutMs: 3000000
    });
}
```

## Arcane.ollama.copy()

### Overview

`Arcane.ollama.copy(source, destination)` is intentionally denied to every
application. Raw alias copying is reserved to Arcane's integrity-gated managed
selection workflow.

### Parameters

`source` and `destination` are required valid Ollama model names. Valid names do
not make the operation admissible.

### Return value

The application contract is `Promise<never>`: Core always rejects before a
provider copy and produces no success result.

### Availability

The method sits behind the desktop Core `ai.models.manage` boundary but remains
denied under both verified and unverified application policy. Android and
browser previews do not expose it.

### Errors and recovery

Core returns `UNVERIFIED_MODEL_MUTATION_FORBIDDEN` with a resolution directing
the caller to a managed model-selection workflow. Treat it as a policy result,
not a transient provider failure.

### Streaming, cancellation, and events

The method does not reach the provider, stream chunks, accept a signal, or emit
operation events.

### Example

```javascript
try {
    await globalThis.Arcane.ollama.copy(
        'gemma3:latest',
        'my-copy:latest'
    );
    throw new Error('Raw Ollama copy unexpectedly succeeded.');
} catch (error) {
    if (error.code !== 'UNVERIFIED_MODEL_MUTATION_FORBIDDEN') {
        throw error;
    }
    console.info('Use the managed Arcane selection workflow.');
}
```

## Arcane.ollama.delete()

### Overview

`Arcane.ollama.delete(model)` deletes an exact package-owned verified model
through Ollama. This destructive raw mutation can invalidate application state;
prefer the owning managed lifecycle and require explicit user authorization.

### Parameters

`model` is a required Ollama name and must resolve to an exact app-owned
verified definition. Reserved Arcane and rollback aliases are denied.

### Return value

It resolves to Ollama's bounded provider-native delete response. The raw result
does not contain a managed `ArcaneOperation` receipt.

### Availability

This is an exclusive desktop Core mutation requiring `ai.models.manage` and
verified-only package policy. Unverified mode is inference-only. Android and
browser previews do not expose delete.

### Errors and recovery

Invalid model, unverified-policy, missing app definition, and reserved-alias
errors require the managed package workflow. Provider failure can leave the
model's final state uncertain; refresh raw inventory and package verification
before deciding whether a retry is safe.

### Streaming, cancellation, and events

Delete is non-streaming, emits no managed operation events, and exposes no
signal. The renderer timeout is two minutes. Page teardown can stop observation
without rolling back host work.

### Example

The helper is not invoked. Call it only after the owning application has shown
the exact verified model and obtained destructive-action confirmation.

```javascript
async function deleteVerifiedModelAfterConfirmation(model) {
    return globalThis.Arcane.ollama.delete(model);
}
```

## Arcane.ollama.selection()

### Overview

`Arcane.ollama.selection()` reads the current managed Arcane model preference
and resolved runtime/provider state. Use it in Settings or Shell to explain the
managed selection; use `localAI.status()` for an application's currently
runnable model catalog.

### Parameters

The method takes no arguments.

### Return value

It resolves to `ArcaneModelSelection`: preference, recommended/effective/active
variant, model and alias, default/boot settings, provider and OpenAI model,
response length, credential-presence Boolean, bounded GPU diagnostics, and
`recommendationPending`. The snapshot is diagnostic state, not admission for a
later request.

### Availability

This desktop Core read requires `ai.models.read` and is admitted only to
Settings and Shell. It is not projected to Android or browser previews.

### Errors and recovery

Method admission and transport errors require the correct app or host. If
automatic recommendation is pending, display that state rather than treating
the current model as a failed selection; refresh after the managed workflow
completes.

### Streaming, cancellation, and events

This is a non-streaming snapshot with no method event or signal. A concurrent
selection or settings mutation can make it stale immediately.

### Example

```javascript
const selection = await globalThis.Arcane.ollama.selection();

console.info({
    preference: selection.preference,
    effectiveVariant: selection.effectiveVariant,
    model: selection.model,
    pending: selection.recommendationPending
});
```

## Arcane.ollama.select()

### Overview

`Arcane.ollama.select(preference)` runs the managed model-selection workflow.
It can download a verified base, create or replace a managed alias, perform
native resource admission, and change persisted model state. Use it only from
an admitted Settings or Shell choice with explicit user intent.

### Parameters

`preference` is one of `"auto"`, `"3b"`, `"8b"`, `"12b"`, `"20b"`, or
`"120b"`. It is a managed size preference, not an arbitrary Ollama model name.
The wrapper maps an omitted or empty value to `"auto"`.

### Return value

It resolves to the selected model, alias, variant, preference, recommendation,
base model, creation and alias-change effects, model-store and GPU evidence,
final compatibility, automatic-candidate degradation/failures when relevant,
rollback-snapshot state, and a completed `ArcaneOperation`.

### Availability

This is an exclusive desktop Core mutation requiring `ai.models.manage` and
Settings or Shell identity. Package-bound verified definitions and current
native capacity govern which preference can complete. Android does not expose
the workflow.

### Errors and recovery

`INVALID_ARCANE_MODEL_PREFERENCE` requires an enum value. Registry, integrity,
definition, native-admission, storage, alias, load, and rollback errors preserve
stable codes and resolutions. If `rollbackSnapshotRetained` is true on success,
surface the recovery detail rather than deleting the retained alias from
renderer code.

### Streaming, cancellation, and events

Selection emits standard operation lifecycle, log, and progress events. The
wrapper uses a 50-minute timeout and exposes no signal; Core does not
cooperatively cancel this managed workflow. A renderer timeout is not evidence
that download or alias mutation stopped, so refresh `selection()` and status
before retrying.

### Example

The helper is deliberately not invoked; call it only after the user confirms
the managed size choice and possible download.

```javascript
async function selectManagedModelAfterConfirmation(preference) {
    const allowed = new Set(['auto', '3b', '8b', '12b', '20b', '120b']);
    if (!allowed.has(preference)) {
        throw new TypeError('Choose a documented Arcane model preference.');
    }
    return globalThis.Arcane.ollama.select(preference);
}
```

## Arcane.ollama.settings()

### Overview

`Arcane.ollama.settings()` reads the complete managed AI runtime/provider
settings snapshot for the Settings application. It returns the same
`ArcaneModelSelection` shape as `selection()`, but has the stronger
settings-management boundary.

### Parameters

The method takes no arguments.

### Return value

The snapshot contains model preference and aliases, default/boot settings,
provider, OpenAI model, response length, protected-credential presence, GPU
diagnostics, and recommendation state. Credentials are never returned.

### Availability

This is a desktop Core Settings-only API requiring `ai.settings.manage`.
Android and browser previews do not expose it.

### Errors and recovery

Method-admission or transport errors require the correct Settings host. Treat
the result as a single snapshot; do not merge stale provider fields into a
later runtime-settings save.

### Streaming, cancellation, and events

This is a non-streaming read with no method event or signal. A concurrent
settings or selection mutation can invalidate it immediately.

### Example

```javascript
const settings = await globalThis.Arcane.ollama.settings();

console.info({
    defaultModel: settings.defaultModel,
    bootLoad: settings.bootLoad,
    contextLength: settings.contextLength
});
```

## Arcane.ollama.saveSettings()

### Overview

`Arcane.ollama.saveSettings(settings)` saves runtime-owned Ollama defaults. Use
it for default model, managed startup load, residency, and context. Use
`select()` for the size preference and `ai.saveProviderSettings()` for provider,
OpenAI model, credential, and response length.

### Parameters

Recognized fields are `defaultModel`, `bootLoad`, `bootKeepAlive`, and
`contextLength`; omissions preserve current values. `defaultModel` uses the
Ollama name pattern. `bootLoad` is Boolean. `bootKeepAlive` is `"5m"`, `"30m"`,
`"1h"`, `"24h"`, or `"-1"`. `contextLength` is `0` for Automatic or
1,024-262,144. Unknown keys, including stale provider/preference fields, are
ignored so they cannot overwrite newer provider selection; do not send them.

### Return value

It resolves to the complete updated `ArcaneModelSelection` settings snapshot
plus a completed `operation`. It does not return selection-only mutation fields
such as `created`, `baseModel`, or `aliasChanged`.

### Availability

This is an exclusive desktop Core Settings mutation requiring
`ai.settings.manage`. When Ollama is selected, the default model must be
installed. Enabling boot load performs resource admission and loads the model.
Android does not expose this method.

### Errors and recovery

Correct invalid model, keep-alive, or context values locally. A missing default
model, native-admission failure, load failure, or persistence error requires the
stable resolution and a fresh settings read before retry. Unknown stale fields
are intentionally ignored rather than validated.

### Streaming, cancellation, and events

The save emits standard operation events but no provider chunks. It uses the
50-minute renderer timeout and has no signal. Core does not cooperatively cancel
the mutation, so refresh `settings()` after an uncertain completion.

### Example

The helper fetches current state and changes only runtime-owned fields. It is
not invoked until an admitted Settings UI has confirmed the desired values.

```javascript
async function saveRuntimeSettingsAfterConfirmation(desired) {
    return globalThis.Arcane.ollama.saveSettings({
        defaultModel: desired.defaultModel,
        bootLoad: desired.bootLoad,
        bootKeepAlive: desired.bootKeepAlive,
        contextLength: desired.contextLength
    });
}
```

## Arcane.ollama.createBrain()

### Overview

`Arcane.ollama.createBrain(definition)` creates a managed
`arcane-<slug>:latest` model from an approved base. It can pull or repair the
base, create the alias, verify it, and optionally make it the default. Use it
only from Settings after explaining download, storage, and default-model
effects.

### Parameters

`baseModel` is required and uses the Ollama name pattern. `name` defaults to
`"my-brain"` and is normalized to a lowercase 1-64 character slug using
letters, digits, dots, underscores, and hyphens. `contextLength` defaults to `0`
for inherited/automatic; send only `0` or an explicit 1,024-262,144 value.
`makeDefault` defaults to false. Unknown keys are ignored and should not be
sent.

### Return value

It resolves to `{model, baseModel, defaultModel, operation}`. `model` is the
created Arcane alias, `defaultModel` reports whether it became the default, and
`operation` is the completed managed receipt.

### Availability

This is an exclusive desktop Core Settings mutation requiring
`ai.models.manage`. The package-owned verified workflow, registry evidence,
resource admission, and reserved-alias rules remain authoritative. Android
does not expose it.

### Errors and recovery

Invalid base/name/context, model-policy, registry, integrity, storage,
admission, provider-create, alias-verification, and persistence failures require
the stable resolution. After uncertain completion, refresh inventory and
settings before retrying; do not manually copy or delete managed aliases.

### Streaming, cancellation, and events

The workflow emits standard operation events but does not expose raw Ollama
chunks. It has a 50-minute renderer timeout and no signal; Core does not
cooperatively cancel it, so teardown is not rollback.

### Example

This helper is not invoked until the Settings application confirms the exact
base, name, context, and default-model effect.

```javascript
async function createBrainAfterConfirmation(baseModel, name) {
    return globalThis.Arcane.ollama.createBrain({
        baseModel: baseModel,
        name: name,
        contextLength: 0,
        makeDefault: false
    });
}
```

## Arcane.ollama.serviceSettings()

### Overview

`Arcane.ollama.serviceSettings()` reads host-owned Ollama service configuration.
Use it to initialize the advanced Settings surface. Its object is intentionally
platform-dependent; feature-detect support and fields instead of assuming one
cross-platform exact shape.

### Parameters

The method takes no arguments.

### Return value

Microsoft NT reports effective settings and support state, including context,
residency, loaded-model, parallelism, queue, flash-attention, K/V-cache, and
no-cloud controls. Linux currently returns `supported: false` with a reason and
bounded administrative defaults because systemd override management remains
administrator-owned.

### Availability

This is a desktop Core Settings-only method requiring `ai.settings.manage`.
The current Android projection and browser previews do not expose host service
settings.

### Errors and recovery

Transport or native-adapter errors should leave controls read-only and present
the returned resolution. `supported: false` is a valid platform state, not a
reason to attempt renderer-side service-file edits.

### Streaming, cancellation, and events

This is a non-streaming read with no method event or signal. Treat the result
as a snapshot; machine capacity or administrator configuration can change
before a later save.

### Example

```javascript
const state = await globalThis.Arcane.ollama.serviceSettings();

if (state.supported === false) {
    console.info(state.reason ?? 'Service settings are managed externally.');
} else {
    console.info(state.numParallel, state.maxLoadedModels);
}
```

## Arcane.ollama.saveServiceSettings()

### Overview

`Arcane.ollama.saveServiceSettings(settings)` applies host-level Ollama service
settings. It can restart the managed service, unload models, clamp requested
parallel/load values to current capacity, and affect every local client. Use it
only in advanced Settings with explicit machine-wide impact disclosure.

### Parameters

Omitted fields receive defaults rather than preserving current values, so send
the complete desired object. `contextLength` is 0-262,144; `keepAlive` is
`"-1"`, `"0"`, or 1-9,999 plus `m` or `h`; `maxLoadedModels` is 0-16;
`numParallel` is 1-16; `maxQueue` is 1-4,096; `flashAttention` and `noCloud` are
Booleans; and `kvCacheType` is `"f16"`, `"q8_0"`, or `"q4_0"`. Defaults are
0, `"5m"`, 1, 1, 512, false, `"f16"`, and true respectively. Unknown keys are
ignored and should not be sent.

### Return value

It resolves to the native platform result plus a completed `ArcaneOperation`.
Microsoft NT reports requested and effective values, support/clamping detail,
restart state, recommendation, and post-change health. Require
`healthy === true` when that field is present.

### Availability

This is a privileged, exclusive desktop Core Settings method requiring
`ai.settings.manage`. Microsoft NT currently applies the managed change. Linux
rejects with `OLLAMA_SERVICE_SETTINGS_MANUAL` because the systemd override is
administrator-managed. Android does not expose it.

### Errors and recovery

Correct invalid ranges and enums before calling. Unsupported/manual-platform,
managed-service health, installation-lease, apply, restart, postcondition, and
rollback errors require the stable resolution. After an uncertain completion,
read `serviceSettings()` and local status before another mutation. Never edit
service files or environment from renderer code.

### Streaming, cancellation, and events

The workflow emits standard operation lifecycle and progress events, not raw
provider chunks. It uses a 50-minute renderer timeout and has no signal. Core
does not cooperatively cancel it; timeout or page teardown can occur while the
machine-wide transaction continues.

### Example

The helper sends a complete desired state and is deliberately not invoked until
the Settings application has obtained explicit restart confirmation.

```javascript
async function saveServiceSettingsAfterConfirmation(desired) {
    return globalThis.Arcane.ollama.saveServiceSettings({
        contextLength: desired.contextLength,
        keepAlive: desired.keepAlive,
        maxLoadedModels: desired.maxLoadedModels,
        numParallel: desired.numParallel,
        maxQueue: desired.maxQueue,
        flashAttention: desired.flashAttention,
        kvCacheType: desired.kvCacheType,
        noCloud: desired.noCloud
    });
}
```
