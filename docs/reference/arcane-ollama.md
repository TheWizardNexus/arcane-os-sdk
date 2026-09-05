# Arcane Ollama

Arcane Ollama lets an admitted application use local Ollama without knowing the
service port, service account, model directory, host process, or native
transport. Application code imports one browser module and calls one API:

```javascript
import ollama from '/arcane/modules/Ollama.js';

const reply = await ollama.chatText({
    model: 'arcane:latest',
    messages: [{role: 'user', content: 'Summarize this record.'}]
});

console.log(reply);
```

The module never connects directly to `localhost:11434`. It delegates to the
capability-gated `globalThis.Arcane.ollama` bridge. Core binds application
identity, checks the exact method and package-owned model policy, admits native
resources, and calls the managed ArcaneOllama service.

This npm package exposes the synchronized browser client only. It does not
bundle, install, start, or grant an Arcane Core or ArcaneOllama service. Every
native call therefore requires a separately installed, compatible Arcane host,
an app-scoped admitted Core session, the required capabilities, and a service
that is ready under native policy. Import success alone proves none of those
conditions.

## What developers can do

| Capability | Preferred call | Result style |
| --- | --- | --- |
| Check whether the admitted service answers | `ollama.readiness()` | Arcane-normalized frozen readiness snapshot |
| Generate text | `ollama.generateText(request)` | Arcane helper string |
| Chat and return only assistant text | `ollama.chatText(request)` | Arcane helper string |
| Use full generation/chat/tool/provider fields | `ollama.generate()` / `ollama.chat()` | Bounded Ollama provider-native envelope |
| Create embeddings | `ollama.embed()` | Bounded Ollama provider-native envelope |
| Read raw version/model/running/show inventory | `version()`, `models()`, `list()`, `running()`, `show()` | Provider-native diagnostic envelope |
| Unload one model | `ollama.unload(model)` | Translates to generate with `prompt: ""` and `keep_alive: 0` |
| Read managed selection/runtime/service settings | `selection()`, `settings()`, `serviceSettings()` | Arcane-managed snapshot; some service fields are platform-dependent |
| Change managed selection/runtime/service settings | `select()`, `saveSettings()`, `saveServiceSettings()` | Arcane-managed result plus operation receipt |
| Run admitted raw model mutations | `pull()`, `push()`, `create()`, `copy()`, `delete()` | Policy-bound provider-native result; several calls are intentionally denied to ordinary apps |
| Create an Arcane-managed brain alias | `createBrain()` | Arcane-managed model/default result plus operation receipt |

## Fast start

### 1. Feature-detect the module

```javascript
import ollama from '/arcane/modules/Ollama.js';

const readiness = await ollama.readiness();

if (!readiness.ready) {
    console.info('Local AI is unavailable:', readiness.errorCode);
}
```

`readiness()` catches a failed `version()` call and returns a frozen object:

```text
{ ready: boolean, version: string|null, errorCode: string|null }
```

It is a connectivity convenience, not model admission or inference readiness.
Use `Arcane.localAI.status()` when the application needs the package-filtered
runnable model catalog.

### 2. Read admitted models

```javascript
const access = await globalThis.Arcane.capabilities.list();

if (!access.methods.includes('localAI.status')) {
    throw new Error('This application is not admitted for local AI.');
}

const status = await globalThis.Arcane.localAI.status();
console.table(status.models.ollama);
```

Populate product UI from this filtered catalog. `ollama.models()` is the raw
diagnostic inventory for admitted Settings, Shell, or Terminal journeys; it is
not the application's package-admitted model list.

### 3. Stream a chat response

```javascript
let text = '';

const final = await ollama.chat({
    model: 'arcane:latest',
    messages: [{role: 'user', content: 'Explain the evidence.'}]
}, {
    onChunk(chunk) {
        text += chunk.message?.content ?? '';
    },
    signal: AbortSignal.timeout(60_000)
});

console.log(text, final.done);
```

Arcane correlates chunks to the originating request. The final promise resolves
with Ollama's final bounded chunk/envelope.

## Complete module API

`/arcane/modules/Ollama.js` exports the `Ollama` class, a frozen `ollama`
singleton, and that singleton as the default export. It also installs the
non-writable `globalThis.arcaneOllama` convenience and emits
`arcane-ollama-ready`. The pinned class defines exactly 24 public methods: the
20 bridge delegates below and the four normalized helpers that follow.

### Raw bridge methods

| Module method | Delegation | Capability/use | Detailed Core guide |
| --- | --- | --- | --- |
| `version()` | `Arcane.ollama.version()` | Raw service version diagnostic. | [version](core/reference/arcane-api/ai-and-ollama.md#arcaneollamaversion) |
| `models()` | `Arcane.ollama.models()` | Raw installed-model diagnostic. | [models](core/reference/arcane-api/ai-and-ollama.md#arcaneollamamodels) |
| `list()` | Calls `Arcane.ollama.models()` | Module alias for `models()`; it does not call the bridge's separate `list` alias. | [list](core/reference/arcane-api/ai-and-ollama.md#arcaneollamalist) |
| `running()` | `Arcane.ollama.running()` | Raw resident-model diagnostic. | [running](core/reference/arcane-api/ai-and-ollama.md#arcaneollamarunning) |
| `show(model, options)` | `Arcane.ollama.show(...)` | Raw bounded model metadata. | [show](core/reference/arcane-api/ai-and-ollama.md#arcaneollamashow) |
| `generate(request, options)` | `Arcane.ollama.generate(...)` | Admitted generation; optional chunk callback/signal/timeout. | [generate](core/reference/arcane-api/ai-and-ollama.md#arcaneollamagenerate) |
| `chat(request, options)` | `Arcane.ollama.chat(...)` | Admitted chat/tools; optional chunk callback/signal/timeout. | [chat](core/reference/arcane-api/ai-and-ollama.md#arcaneollamachat) |
| `embed(request)` | `Arcane.ollama.embed(...)` | Admitted embeddings. | [embed](core/reference/arcane-api/ai-and-ollama.md#arcaneollamaembed) |
| `pull(model, options, streamOptions)` | `Arcane.ollama.pull(...)` | Managed/policy-bound pull; denied to ordinary raw app flow. | [pull](core/reference/arcane-api/ai-and-ollama.md#arcaneollamapull) |
| `push(model, options, streamOptions)` | `Arcane.ollama.push(...)` | Raw push is policy-restricted/denied where documented. | [push](core/reference/arcane-api/ai-and-ollama.md#arcaneollamapush) |
| `create(request, options)` | `Arcane.ollama.create(...)` | Exact package-owned verified definition only. | [create](core/reference/arcane-api/ai-and-ollama.md#arcaneollamacreate) |
| `copy(source, destination)` | `Arcane.ollama.copy(...)` | Intentionally denied to applications; managed selection owns aliases. | [copy](core/reference/arcane-api/ai-and-ollama.md#arcaneollamacopy) |
| `delete(model)` | `Arcane.ollama.delete(...)` | Destructive exact package-owned verified model deletion. | [delete](core/reference/arcane-api/ai-and-ollama.md#arcaneollamadelete) |
| `selection()` | `Arcane.ollama.selection()` | Reads managed model preference/effective state. | [selection](core/reference/arcane-api/ai-and-ollama.md#arcaneollamaselection) |
| `select(preference)` | `Arcane.ollama.select(...)` | Runs managed size-selection/download/alias workflow. | [select](core/reference/arcane-api/ai-and-ollama.md#arcaneollamaselect) |
| `settings()` | `Arcane.ollama.settings()` | Reads managed runtime/provider settings. | [settings](core/reference/arcane-api/ai-and-ollama.md#arcaneollamasettings) |
| `saveSettings(settings)` | `Arcane.ollama.saveSettings(...)` | Saves runtime-owned default/load/context settings. | [saveSettings](core/reference/arcane-api/ai-and-ollama.md#arcaneollamasavesettings) |
| `createBrain(definition)` | `Arcane.ollama.createBrain(...)` | Creates a managed `arcane-<slug>:latest` alias. | [createBrain](core/reference/arcane-api/ai-and-ollama.md#arcaneollamacreatebrain) |
| `serviceSettings()` | `Arcane.ollama.serviceSettings()` | Reads host-level Ollama service configuration/support. | [serviceSettings](core/reference/arcane-api/ai-and-ollama.md#arcaneollamaservicesettings) |
| `saveServiceSettings(settings)` | `Arcane.ollama.saveServiceSettings(...)` | Applies privileged machine-wide service settings/restart. | [saveServiceSettings](core/reference/arcane-api/ai-and-ollama.md#arcaneollamasaveservicesettings) |

### Normalized helper methods

## `ollama.readiness()`

### Overview

Calls `version()` and converts success/failure into a frozen readiness snapshot.
It never throws for service unavailability.

### Return value

`{ready:true, version, errorCode:null}` on success, or
`{ready:false, version:null, errorCode}` on failure. A string version and an
object `{version}` are both accepted.

### Example

```javascript
const {ready, version, errorCode} = await ollama.readiness();
console.log(ready ? version : errorCode);
```

## `ollama.generateText()`

### Overview

Calls `generate()` and coerces the final envelope's `response` field to a
string with `String(response?.response || '')`. Valid Ollama responses document
`response` as a string. If an out-of-contract response supplies a truthy
nonstring, the helper stringifies it; a missing, null, undefined, or other
falsy nonstring value becomes an empty string.

### Example

```javascript
const text = await ollama.generateText({
    model: 'arcane:latest',
    prompt: 'Write one sentence.'
});
```

## `ollama.chatText()`

### Overview

Calls `chat()` and coerces the final envelope's `message.content` field to a
string with `String(response?.message?.content || '')`. Valid Ollama responses
document `message.content` as a string. If an out-of-contract response supplies
a truthy nonstring, the helper stringifies it; a missing, null, undefined, or
other falsy nonstring value becomes an empty string. Use `chat()` when tool
calls, metrics, context, or optional provider fields matter.

### Example

```javascript
const text = await ollama.chatText({
    model: 'arcane:latest',
    messages: [{role: 'user', content: 'Hello'}]
});
```

## `ollama.unload()`

### Overview

Translates `unload(model)` to:

```javascript
ollama.generate({model, prompt: '', keep_alive: 0});
```

It returns the raw final generation envelope. It is a convenience request, not
a proof that no other admitted client reloaded the model concurrently.

### Example

```javascript
async function unloadAfterTheUserChooses(model) {
    return ollama.unload(model);
}
```

## Availability matrix

| Host | Inference | Raw inventory | Managed model/settings mutation | Notes |
| --- | --- | --- | --- | --- |
| Microsoft NT desktop Core | Yes when `ai.inference` is admitted | Settings/Shell/Terminal with `ai.models.read` | Admitted Settings/Shell journeys with management capabilities and privilege where required | Full managed ArcaneOllama service path. |
| Linux desktop Core | Yes when admitted | Admitted diagnostics | Managed workflows where implemented; administrator-owned service settings can return manual/unsupported guidance | Same application API, different host/service implementation. |
| Android WebView | Narrow admitted chat/inference projection for configured user-managed loopback | No general desktop raw inventory | No desktop model/service management | `managedLocalAI` remains false; listener reachability is not management authority. |
| Development HTTP bridge | Only when connected to an admitted Core-backed development host | Host/method dependent | Host/method dependent; never production authority | Development transport, not a standalone-browser upgrade. |
| Standalone browser | No Arcane Ollama | No | No | `ARCANE_OLLAMA_UNAVAILABLE`. |
| TWiN Cloud | Not through `Arcane.ollama` | No | No | Use an explicitly selected `AI.js` cloud profile; no automatic fallback. |

## Capabilities and policy

- `ai.inference` admits package-filtered local generation, chat, and embeddings.
- `ai.models.read` admits raw model diagnostics only to authorized system apps.
- `ai.models.manage` admits policy-bound managed model lifecycle operations.
- `ai.settings.manage` admits Settings-owned runtime/service configuration.
- `ai.models.unverified.inference` is an explicit inference-only exception for
  already installed, hardware-admitted unverified models when the package says
  `verified_only:false`; it does not admit model mutation.

The method allowlist is necessary but not sufficient. Exact package-owned model
definitions, reserved aliases, native resources, platform support, installed
state, and exclusive mutation policy remain authoritative.

## Raw versus normalized behavior

The module intentionally has two levels:

| Boundary | Normalized by Arcane | Intentionally preserved |
| --- | --- | --- |
| Missing bridge | Throws coded `ARCANE_OLLAMA_UNAVAILABLE`. | Nothing reaches a provider. |
| Core call | Promise settlement, capability/policy errors, request limits, diagnostics, stream ids/chunks. | Bounded Ollama success fields and optional provider detail. |
| `readiness()` | Frozen Boolean/version/error-code snapshot. | Provider error detail is reduced to `errorCode`. |
| `generateText()` / `chatText()` | Uses `String(value || '')`: documented string values pass through, truthy nonstrings stringify, and falsy nonstrings become empty. | Tool calls, timings, context, and other fields are discarded. |
| `unload()` | Stable translation to `keep_alive:0`. | Final generation envelope remains provider-native. |

## Streaming, cancellation, and uncertain mutation state

`generate`, `chat`, `pull`, `push`, and `create` accept stream controls through
the bridge forms documented on their detailed pages. Core cooperatively cancels
admitted inference methods where documented. For pull, push, create, selection,
settings, or service mutation, abort/timeout/page teardown can stop renderer
observation without proving host work rolled back.

After an uncertain model mutation, refresh the relevant raw inventory,
`selection()`, `settings()`, `serviceSettings()`, or `localAI.status()` before
retrying. Do not stack a second mutation merely because the renderer timed out.

## Behavioral testing

The SDK behavior suite uses an explicit fake `Arcane.ollama` to prove:

- every wrapper forwards the exact argument objects and provider-native result;
- stream options and signals are not rewritten;
- bridge absence throws `ARCANE_OLLAMA_UNAVAILABLE` before provider work;
- `readiness()` returns frozen success/failure snapshots;
- `generateText()` and `chatText()` use the pinned `String(value || '')`
  behavior: truthy nonstrings stringify and falsy nonstrings become empty;
- `unload()` sends exactly `{model, prompt: "", keep_alive: 0}`.

Those tests prove the shipped renderer module. Live Core dispatch, cancellation,
ArcaneOllama health, real model pulls, GPU admission, service restart, and
rollback remain Arcane OS host/integration evidence.

Deep implementation path: [Arcane Ollama protocol](protocols.md#arcane-ollama-protocol-path).
