# Arcane Ollama module

Arcane applications can use the managed, machine-wide Ollama service only
through their app-scoped Core, without connecting directly to
`localhost:11434`. Import the shared module and let Core enforce the packaged
application policy, native resource admission, and declared capabilities. An
ordinary browser has no Core local-model authority and is OpenAI-only.

## Upstream Arcane OS model

This section describes assets and maintainer commands in the pinned upstream
[ARCANE-OS repository](https://github.com/TheWizardNexus/ARCANE-OS/tree/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e),
not files or npm scripts supplied by `arcane-os`. SDK application developers
use the browser module and an external Core/service only after this SDK's
current native plan admits the selected checkout and Core through its exact
protocol, version, feature, capability, method, provider, and identity-bound
receipt checks. That admission is current-build evidence, not a future SDK/Core
compatibility promise. Developers do not run these repository-maintenance
commands from an app or SDK checkout.

Arcane OS includes `arcane/models/Arcane-3B.Modelfile`, `arcane/models/Arcane-8B.Modelfile`, `arcane/models/Arcane-12B.Modelfile`, `arcane/models/Arcane-20B.Modelfile`, and `arcane/models/Arcane-120B.Modelfile`. They create the durable `arcane:3b`, `arcane:8b`, `arcane:12b`, `arcane:20b`, and `arcane:120b` variants, while `arcane:latest` points to the user's effective choice through the machine-wide `ArcaneOllama` service. The 3B definition uses `granite4.1:3b-q4_K_M` with a memory-bounded 16,384-token context.

After base installation succeeds and its installation transaction is complete,
opening Provisioner performs one fresh live machine-requirement check. On
Microsoft NT, if the installed Arcane identity is valid and the candidate is trusted, global Ollama is missing or
unhealthy, and the user-scoped Ollama process is confirmed inactive, Provisioner
starts exactly one noninterrupting verified global ensure. An installed
user-scoped copy neither satisfies nor blocks that action. An active or unknown
process state requires explicit close-and-retry confirmation, and the automatic
request carries a native deny-user-process-interruption policy so a process that
appears or restarts at the mutation boundary is not terminated. Provisioner open
never starts model reconciliation. A separate explicit post-install flow may
request one non-privileged model reconciliation after Core verifies that the
machine-wide service is ready. Arcane Shell is the sole automatic boot-recovery owner and
idempotently reconciles the selected model after Core is ready. The Shell's
Settings dialog lets the user
choose Automatic or an explicit 3B, 8B, 12B, 20B, or 120B variant. Automatic
considers only 8B and then 3B; 12B, 20B, and 120B are explicit choices and are
not probed or downloaded by the automatic policy. Core admits a candidate from
actual installed model bytes and metadata, requested context and K/V-cache
estimate, current free system and GPU memory, loaded-model residency, safety
reserves, and pull storage when applicable. Missing evidence fails closed; a
GPU name or variant label is never fit evidence.

When 8B and 3B both receive conclusive native capacity rejections, the user may
explicitly select a configured account-accessible OpenAI model. Arcane never
rewrites the provider automatically. Missing credentials, an unavailable
account model, unreachable local services, registry or metadata failures, and
unavailable resource evidence do not prove that no local model fits and never
authorize cloud use.

Only the effective Arcane candidate is processed. Core reports owned model
progress through `operation.progress`, creates the named variant from an
already-installed admitted base when needed, selects it as `arcane:latest`, and
verifies both names through the service API. For a missing base, the managed
path uses bounded library-registry manifest/configuration evidence and GGUF
prefix ranges up to 256 KiB for pull admission. A range is not full integrity
proof: Ollama must complete full-layer digest verification before Core creates
or verifies an alias. Missing pre-download bytes or metadata fails closed. Model
progress is coalesced to at most four transfer updates per second, with a
five-second heartbeat while Ollama is silent. Its structured
`details` distinguish overall setup progress from the current layer and expose
phase, model and digest identity, per-layer and observed aggregate bytes,
elapsed time, evidence-based rate and layer ETA, and truthful
interruption/resume guidance. Unknown totals remain unknown.

When the Provisioner explicitly starts its post-install reconciliation after the global service requirement succeeds, it renders those details as a dedicated model-transfer bar beside the already-completed installation result. Opening Provisioner may run the single guarded global-service ensure described above, but it never starts model reconciliation. The Shell uses the same progress contract for its automatic idempotent recovery and for Settings changes. The Microsoft NT and Linux hosts warn before closing a host during a managed model request. A download retry reuses Ollama's saved partial data; an interrupted model load restarts when Arcane reopens.

Each application's supported model list exists only in its
`arcane-package.json.localAIModelPolicy`, and every product definition remains
under its owning app. The app release carries the policy as native admission metadata;
the native packager injects it only into compiled Core. Profile controls render
the ordered, filtered, and admitted `Arcane.localAI.status().models.ollama`
catalog without a second renderer list. Product aliases are lazy: Core creates
or repairs only the exact selected declared alias from an installed admitted
base on first native inference. Ordinary browsers have no local-model authority.

The service is configured with the global `OLLAMA_MODELS` directory. Arcane clients never write model layers directly into that protected directory. Fresh installation and verified service repair choose bounded service capacity from hardware evidence; ordinary startup and model selection do not rewrite service settings. An explicitly authorized application may call `Arcane.localAI.setParallelRequests({model,parallelRequests,contextTokens?})`: Core solves the current model-specific memory ceiling directly from model and machine evidence without a product-defined parallelism cap, changes only the global `OLLAMA_NUM_PARALLEL` value when necessary, restarts the managed service only on a tentative change, re-evaluates once while stopped, and then ensures, loads, and confirms that model. Automatic mutation is currently Microsoft NT-only; Linux returns administrator-managed systemd guidance and Android user-managed loopback sessions do not call it. A restart unloads other resident Ollama models and can interrupt in-flight local inference. In the upstream ARCANE-OS maintainer checkout only, a maintenance run follows the saved Arcane preference with `npm run model:ensure`. To pull the one 3B base and build both aliases without running Provisioner, an upstream maintainer uses:

```powershell
# Run only from the canonical upstream ARCANE-OS repository.
npm run model:ensure -- --target=all --model=3b --smoke
```

`--target=arcane` selects the platform model and is the default. Product-specific targets and definitions remain documented by their owning applications. `--target=all` reuses one base pull across both currently configured targets, selects `arcane:3b` as `arcane:latest`, and preserves unrelated settings. `--smoke` adds one bounded local inference probe per selected alias. The equivalent platform-only raw Ollama sequence is `ollama pull granite4.1:3b-q4_K_M` followed by `ollama create arcane:3b -f arcane/models/Arcane-3B.Modelfile`; the npm command additionally verifies lineage and is the supported repository workflow.

The managed service's aliases and model layers are machine-wide, while Arcane model preference and application profile selection remain per-user. `model:ensure` does not install or attest `ArcaneOllama`, does not update an already installed Core or UI after a source pull, and does not create application aliases outside the selected target set. Use the verified Provisioner to establish or repair the machine service and to install current application/runtime bytes. The public [Device and model support](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/apps/docs/guides/device-support.md) page tracks the exact product matrix, platform maturity, and COTS physical-validation backlog; 16B and 30B are validation targets, not managed variants.

```js
import ollama from '/arcane/modules/Ollama.js'

const reply = await ollama.chatText({
  model: 'arcane:latest',
  messages: [{ role: 'user', content: 'Summarize this record.' }],
})
```

## Capabilities

Add only the capabilities the application needs to its native app descriptor:

- `ai.inference` — admitted `localAI.status`, `generate`, `chat`, and `embed`
- `ai.models.read` — raw `version`, `models`, `running`, and `show` diagnostics,
  restricted to Settings, Terminal, and Shell
- `ai.models.manage` — policy-bound model-management operations
- `ai.models.unverified.inference` — inference-only access to
  already-installed, hardware-admitted unverified models, valid only with
  `localAIModelPolicy.verified_only:false`
- `ai.runtime.manage` — model-bound managed Ollama parallel-request changes;
  currently Core-only, privileged/exclusive, and granted only to the registered
  owning application

The sole model declaration remains `apps/<id>/arcane-package.json`:

```json
{
  "localAIModelPolicy": {
    "verified_only": true,
    "models": [
      {"name": "EXAMPLE:8b", "definition": "Example-8B.Modelfile"}
    ]
  }
}
```

Verified-only Core may create or repair only an exact declared alias. False
mode never pulls, creates, repairs, copies, pushes, or deletes an unverified
model. Browser runtime and generic metadata APIs do not consume or project this
policy or declared mapping; the generated release-root record still physically
contains it.

The pinned runtime also exposes `Arcane.ai.chat()`. Applications populate local
model controls from `Arcane.localAI.status()` and use admitted inference
methods; raw `Arcane.ai.models()` and Ollama inventory methods are diagnostic
surfaces for Settings, Terminal, and Shell only.

## Streaming

Pass an `onChunk` callback as the second argument to `chat` or `generate`.
Mutation streaming remains subject to verified package policy and native
admission. Direct application pull fails closed; Core's separate managed
lifecycle owns bounded preflight and the full-digest-verified pull.

```js
await ollama.chat({
  model: 'EXAMPLE:8b',
  messages: [{ role: 'user', content: 'Hello' }],
}, {
  onChunk(chunk) {
    output.append(chunk.message?.content || '')
  },
})
```

Chunk callbacks run as `ollama.chunk` events arrive from Arcane Core. The returned promise resolves with Ollama's final chunk. All operations are bounded by Arcane request and response limits and remain restricted to the loopback ArcaneOllama service.

## API

The pinned `Ollama` class exposes exactly 24 public methods:

- 20 bridge delegates: `version()`, `models()`, `list()`, `running()`,
  `show()`, `generate()`, `chat()`, `embed()`, `pull()`, `push()`, `create()`,
  `copy()`, `delete()`, `selection()`, `select()`, `settings()`,
  `saveSettings()`, `createBrain()`, `serviceSettings()`, and
  `saveServiceSettings()`.
- Four helpers: `readiness()`, `generateText()`, `chatText()`, and `unload()`.

`generateText()` returns `String(response?.response || '')`, and `chatText()`
returns `String(response?.message?.content || '')`. Valid provider envelopes
document both fields as strings. For an out-of-contract envelope, a truthy
nonstring value is stringified, while a missing, null, undefined, or other
falsy nonstring value becomes an empty string.

Exposure of a method does not grant its effect: Core applies capability,
package-policy, exact-definition, mutation, and resource-admission checks. The
selection methods are restricted to Arcane Shell. See
[Arcane AI Data Contracts](arcane-ai-contracts.md#direct-ollama-api) for every
accepted top-level request field, argument type, streaming callback, settings
range, raw-management restriction, and the boundary between normalized Arcane
results and version-dependent Ollama response envelopes. Arcane forces
non-streaming mode unless a chunk callback is supplied.
