# Behavioral testing

Reference completeness and runtime behavior are distinct evidence boundaries.
Neither runs automatically during ordinary implementation, packaging, commit,
push, or handoff. Use them only when the user explicitly requests the check or
when required for a separately selected release output.

Completeness is bidirectional: implementation additions require documentation,
and documentation keys that no longer exist fail just as visibly.

## Fast contract path

```bash
npm run test:unit
npm run test:functional
```

Unit coverage verifies schemas, descriptors, target contracts, error behavior,
and public reference inventories. Functional coverage exercises CLI parsing and
output, the development server, runtime verification, packaging, scaffolding,
events, and the generated documentation/site contract.

## Explicit full check

```bash
npm run check
```

When explicitly selected, the full check validates source policy and runs the
non-overlapping unit, functional, integration, and regression sets. It remains
development evidence; it is not native artifact or release acceptance.

## Behavioral coverage model

| Surface | Minimum behavior proved locally | Heavier evidence boundary |
| --- | --- | --- |
| Package entrypoints | Every declared JavaScript export imports; documented names match; constants and synchronous validators preserve their public contracts. | None for import itself. Operations that invoke tools use the matching boundary below. |
| Canonical events, EventManager, and event stacks | One branded/versioned `globalThis.arcaneEvents` per realm, duplicate-module reuse, declared source ownership, canonical/source delivery order, frozen occurrence metadata, exact cancellation, AbortSignal cleanup, disposable subscriptions, source teardown/re-registration, observational listener failure, EventTarget compatibility, one-way DOM projection, live isolated-bus pub/sub, nested causation, complete credential-redacted stacks, import, seek, playback, and DOM privacy/lifecycle. | Real user journeys and browser layout belong in a browser harness; an occurrence, EventTarget/DOM projection, or event-stack review never proves that external side effects stopped, completed, or can be replayed. |
| CLI | Commands parse, acknowledge, select one scope, produce normalized human/JSON/NDJSON output, propagate cancellation/failure, and reject invalid cardinality. | Native build/run requires the selected real provider and host. |
| Selected app tests and packaging | When explicitly selected, external app tests resolve cross-host names such as `arcane-os/speech-playback`, preserve browser-runtime names such as `arcane/SpeechPlayback`, exercise materialized `TimeGuard`/`DBOPFS` self-imports through `arcane-os/event-manager`, and resolve URL-like compatibility keys. Packaging itself copies complete selected content and never runs tests or checks automatically. | A passing app test proves only its exercised behavior. Dry-run packaging remains non-mutating, raw Node imports of projected runtime files are not promised, and direct shared-SDK test files retain their no-app-context behavior. |
| Browser runtime modules | Every shipped ESM module parses and its export inventory matches the catalog; pure helpers run focused success/error cases. | DOM, OPFS, media, and Web Component journeys use a browser harness. |
| Provider-neutral AI runtime and chat/speech activation | Provider/2 registration, three-role configuration, TWiN Cloud LLM readiness, on-device Whisper/Kokoro selection, opt-in STT startup, Core speech readiness, independent LLM/STT/TTS load/unload/status, uncapped per-role FIFO request settlement, owned STT signals, TTS mute lifecycle, route-owned voice defaults, sticky-state-only readiness for both speech components, selected-unloaded activation request/cancellation/error behavior, programmatic voice recording, transcript-replacement supersession of late settlement, `AI.fetchSTT` callback-position compatibility, stale-callback suppression, rejection of non-local speech configuration, and absence of silent provider fallback are represented against complete providers and host callbacks. | Real model/runtime availability remains the selected provider's evidence boundary; provider-promise settlement, state, an abort signal, or an activation event does not by itself prove underlying provider work stopped or native, cloud, or browser-model availability. |
| Browser-WASM local AI | The exported namespace, canonical ordered `{id, files:[{name?,url},...]}` descriptor plus its one-file compatibility input, default `secure:false`, dormant `secure:true` intent, public AI API module lifecycle, lazy/manual policy, successful Wllama-load requirement, abort normalization, complete output and reasoning, all-choice validation, required structural-call `arguments.message`, exact call identity, and matching tool-result sequencing are represented in deterministic fixture sources. | A real Chrome exercise may load the selected Wllama runtime and model only after explicit user action. It is not an ordinary publication gate or an implicit model download. |
| Browser speech | Caller-owned Whisper/Kokoro selection, independent STT/TTS routes, ordinary direct upstream runtime/model use, dormant `secure:true` intent, DBOPFS cache, materialized known-route/native-fallback behavior, independent Worker lifecycle, cancellation, Blob/File STT conversion, WAV TTS conversion, complete text/audio, and no cloud fallback are represented with synthetic artifacts and adapters. | A real runtime/model/voice download and actual transcription or synthesis use the application's selected upstream packages/providers, browser media support, and explicit user action. |
| Persistent chat and document context | Atomic in-memory/history commit, explicit per-turn persistence, streamed/non-stream fallback, session-owned callback fields, complete data callbacks, per-turn request options, exact per-choice streamed/terminal call correlation before publication, terminal-only call acceptance, ordered parallel-call sequencing, atomic all-ID nonblank executed/declined/cancelled/not-executed result batches, readable unmodified malformed pre-existing rows, complete UI transcript metadata, generic visible failure outcomes with complete console diagnostics, BFCache-preserving component lifecycle, complete bootstrap/search/context, caller-source evaluation, cancellation, and partial-read handling are represented with app-scoped adapters. | Live Core/provider inference and durable browser storage remain separate authorities; tests never treat a fake chat function or in-memory adapter as host/storage proof. |
| Core bridge docs | Canonical namespace/method/event/entity inventories match their one-per-member guides and required sections. | Live Core conformance belongs in Arcane OS because Core implementation is not shipped as SDK source. |
| Arcane Ollama wrapper | Missing-host error, method forwarding, text/readiness normalization, unload request, and stream-option forwarding run against a deterministic fake `Arcane.ollama`. | Real managed-service, model download/create, GPU/resource admission, and service restart require an admitted Arcane host. |
| Native providers | Plan/provider protocol, explicit target, complete artifact reading, and unavailable-path honesty are tested with fixtures. | Windows, Linux, or Android artifact verification and launch must run on that actual platform/architecture and only when explicitly selected. |

## Executable examples

Examples should be safe to run repeatedly and should stop at the last boundary
they can honestly prove. Documentation examples that would download a model,
restart a service, create a user, install software, log out, delete a model, or
launch an external resource define a function but do not invoke it.

Behavior tests replace real authority with an explicit fake only for the public
client contract. They must assert the exact request sent to the fake and the
normalized result returned to the application. A fake provider never counts as
native host, artifact, installation, or model-service evidence.

The app-scoped Node runner receives the selected map context. It removes the
reserved environment field before importing application code and passes the
mapping to the existing Node loader. Managed names and URL-like keys resolve to
the workspace's projected `arcane/` files. Unrelated Node resolution and direct
runner use without a selected app context remain unchanged.

The browser-WASM guide follows the same rule: it shows exact model authority
and wiring, but leaves the download/load call behind an explicit user action.
Focused fixture sources cover SDK default `secure:false`, omission of security
for the fully functional ordinary path, and `secure:true` as a dormant intent
that does not activate historical checks. Neither path requires byte counts,
byte limits, hashes, digests, freezes, or content-identity receipts. The browser
contract separately represents `AbortSignal` settlement as
`ARCANE_AI_REQUEST_ABORTED` and complete tool-call arguments with required
user-facing `message`, without invoking application handlers. Model license
metadata is not a runtime permission grant. Run those sources only when the
user explicitly requests tests or as required for a selected release output.

## Host and normalization cases

Cross-host APIs should cover at least these cases at their owning layer:

1. standalone browser with no `Arcane` host;
2. development HTTP transport with normalized request/error settlement;
3. native transport with capability admitted;
4. native transport with method or capability denied;
5. platform-dependent `supported: false` result where documented;
6. provider-native success envelope passed through unchanged;
7. helper-normalized text/readiness result;
8. stream chunk correlation and late/foreign chunk rejection;
9. abort or timeout behavior, including whether host work can continue;
10. explicit provider selection with no implicit local-to-cloud fallback.

Central-event changes additionally cover complete retention until the caller
clears history or disables recording. DOM cases assert that private values,
credentials, sensitive attributes, URLs, and markup remain redacted under every
capture-option combination.

The focused singleton contract also owns these cases in
`test/event-manager.test.mjs`: global property/brand/protocol/API descriptor
admission; same-object reuse across duplicate module URLs and package
entrypoints; exact `subscribe(type,handler,{once,signal})` behavior; idempotent
`unsubscribe()`/`unsubscribe.dispose()`; one active
`createSource(owner,{source,eventTypes,onListenerError})` handle; immutable
`arcane-event-occurrence/1` values and privacy separation; synchronous
cancellation; dispatch-safe removal and reentry; final source disposal;
EventTarget deduplication/admission; one-way `CustomEvent` projection; and
nonrecursive listener-error publication. Runtime behavior tests own the
module and component instance-scoped projections and cleanup. Reference-completeness tests own the
public export names and exact focused-guide coverage.

Canonical event publication itself is deliberately synchronous and
observational. Tests must not await listener return values or present
`arcaneEvents` as backpressure. Promise settlement, async callback failure, and
ordered delivery belong to the operation promise or `createEventQueue()` test
that owns that work. Abort-driven listener removal proves cleanup only; it does
not prove already-started host, provider, worker, or queue work stopped.

## Test ownership

The SDK owns the singleton authority, its per-realm source adapters, package and
managed-browser projections, focused event/source/DOM contracts, runtime
compatibility views, package, CLI, synchronized renderer, documentation, and
injected provider-boundary behavior. Arcane OS owns live Core dispatch, native host
bridges, capability policy, host service adapters, and real ArcaneOllama
integration. A change that crosses both repositories needs focused tests at both
owners; copying a Core test into this package would not make the SDK the Core
implementation owner.
