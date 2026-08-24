# Availability and normalization

Use this page to choose an API by capability. The compact labels tell you where
it runs; the [protocol guide](protocols.md) contains the implementation detail.

## Availability labels

| Label | Meaning |
| --- | --- |
| **Node** | Runs in the SDK's supported Node.js process. It is not a renderer API. |
| **Browser** | Uses standard browser APIs and can run without a native host when its own dependencies are available. |
| **Native** | Requires an admitted `globalThis.Arcane` host method or a native target provider. |
| **Cloud** | Calls a remote provider over HTTPS and needs provider configuration and network policy. |
| **Cross-host** | Keeps one application API while Arcane selects WebView2, WebKitGTK, Android WebView, or development HTTP transport. |
| **Provider-native** | Intentionally returns the underlying provider's bounded envelope instead of an Arcane-normalized entity. |

“Available” never means “authorized.” App grants, method allowlists, host
policy, package-owned model policy, platform support, and dependency readiness
are independent checks.

The current native host/target matrix covers Microsoft NT, Linux, and Android
where listed. It exposes no macOS target or Core host contract in this SDK
version; WebKitGTK availability must not be generalized to macOS.

## Capability-first matrix

| What the developer wants to do | Preferred surface | Availability | Normalization |
| --- | --- | --- | --- |
| Scaffold, inspect, test, package, bundle, build, verify, or run an app | `arcane` CLI or `arcane-os` package functions | **Node**; native targets invoke one explicit provider | CLI events and SDK errors/results are normalized by versioned SDK contracts. Native artifact receipts remain target-specific inside a common receipt lifecycle. |
| Publish application events or review a bounded event history | `arcane-os/event-manager` | **Node** and **Browser**; optional DOM capture needs a browser DOM or compatible host | Live listeners receive original arguments. Recorded payloads and metadata become bounded, redacted, deeply frozen `arcane-event-stack/1` snapshots. The stack format is local diagnostic data, not a host transport. |
| Build browser UI and app-local behavior | `/arcane/modules/*.js`, shared entities, and components | **Browser**; many modules also run inside every native renderer | Pure modules own their result contracts. Modules that call `Arcane` inherit the bridge boundary described below. |
| Read host identity, capabilities, storage, preferences, appearance, or platform state | `globalThis.Arcane` | **Cross-host** where the method is implemented and admitted | Promise behavior and `Arcane.Error` are normalized. Result fields are normalized unless the method explicitly documents a platform-dependent snapshot. |
| Use local AI without coupling app code to Ollama HTTP | `Arcane.localAI`, `Arcane.ai`, or `/arcane/modules/Ollama.js` | Primarily **Native**; Android exposes a narrower admitted inference projection | Admission, errors, and managed-operation events are normalized. Direct Ollama response envelopes remain **Provider-native**. |
| Use OpenAI from the renderer profile | `/arcane/modules/AI.js` | **Cloud** from an allowed browser/native renderer | High-level AI chat/text behavior is normalized by the module; raw provider diagnostics and some response detail remain provider-specific. No automatic cloud fallback is inferred from local failure. |
| Use local or cloud speech through one application helper | `/arcane/modules/AI.js` and `Arcane.speech` | **Browser**, **Native**, or **Cloud**, depending on the selected speech profile | The helper normalizes application-facing audio/text behavior; native and cloud request/response plumbing differs below that boundary. |
| Inspect or manage raw Ollama models | `Arcane.ollama` or `/arcane/modules/Ollama.js` | **Native** desktop Core for management; narrower Android inference only | Wrapper method names, errors, streaming correlation, and admission are Arcane-controlled. Direct Ollama success envelopes are intentionally provider-native. |
| Use native terminal, installation, user, provisioning, or machine controls | matching `Arcane.*` namespace | **Native** and app/capability restricted | Calls and errors use the common bridge contract. Platform results can be host-specific and are marked in the method guide. |

## The normalized application path

For ordinary cross-platform application code:

```javascript
const runtime = globalThis.Arcane?.runtime?.current?.();

if (!runtime?.connected) {
    throw new Error('Open this application through an Arcane host.');
}

const access = await globalThis.Arcane.capabilities.list();

if (!access.methods.includes('localAI.status')) {
    throw new Error('This application is not admitted for local AI.');
}

const status = await globalThis.Arcane.localAI.status();
console.log(status.ready, status.models);
```

This code does not select WebView2, WebKitGTK, or an HTTP bridge. It calls one
Arcane API. The host chooses its transport, and Core applies the bound
application identity and method policy.

## Normalization levels

### Fully SDK-normalized

The Node toolchain uses `ArcaneError`, stable SDK error codes, structured
`arcane-cli-events/1` records, normalized target descriptors, and authenticated
receipt objects. Platform providers can add bounded target detail but cannot
silently substitute a different target or artifact kind.

The central EventManager is also host-neutral JavaScript. Its synchronous live
bus preserves listener argument identity, while its optional history owns a
separate diagnostic normalization boundary: snapshots are bounded, redacted,
deeply frozen, and strictly importable as `arcane-event-stack/1`. DOM
instrumentation adds browser diagnostics only; it does not replay browser
state. See [EventManager and time-travel review](event-manager.md).

### Arcane bridge-normalized

Core-backed calls return promises and reject with `Arcane.Error`. Transport
selection, request correlation, JSON framing, capability denial, diagnostics,
and public operation events are normalized at the bridge. Method data contracts
remain authoritative; a method that documents platform-dependent fields is not
silently widened into a fictional common shape.

### Helper-normalized

Renderer helpers can deliberately collapse provider detail. For example,
`ollama.chatText()` returns a string extracted from the final chat envelope and
`ollama.generateText()` returns a string extracted from the final generation
envelope. `ollama.readiness()` returns a frozen `{ready, version, errorCode}`
snapshot.

### Provider-native within an Arcane boundary

Direct `Arcane.ollama.chat()`, `generate()`, `show()`, `embed()`, and lifecycle
methods return bounded Ollama-compatible envelopes. Arcane still owns admission,
limits, error normalization, chunk correlation, and host transport, but it does
not rename every provider response field. Feature-detect optional Ollama fields
and use the high-level helpers when an application needs a smaller common
contract.

### Platform-dependent by design

Host service settings, machine evidence, permissions, installation state, and
native build artifacts can differ between Microsoft NT, Linux, Android, and a
development browser. Those methods provide a stable outer contract and mark
platform-specific fields or unsupported states. `supported: false` is a valid
result where documented; it is not permission to bypass the host from renderer
code.

## No implicit protocol or provider fallback

Arcane can expose the same method over different host transports, but it does
not reinterpret a failed native call as authorization to send data to a cloud
provider. Provider selection is explicit application/user profile state. A
remote or development HTTP bridge transports an admitted Arcane call; it is not
an automatic OpenAI fallback and does not turn a standalone browser into a
native host.

Deep details: [protocol selection and host boundaries](protocols.md).
