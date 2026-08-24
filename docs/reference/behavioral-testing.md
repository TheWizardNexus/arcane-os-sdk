# Behavioral testing

Reference completeness and runtime behavior are different gates. The SDK uses
both.

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

## Full development gate

```bash
npm run check
```

The full check validates source policy and the exact synchronized runtime
manifest, then runs the non-overlapping unit, functional, integration, and
regression sets. It remains development evidence; it is not native artifact or
release acceptance.

## Behavioral coverage model

| Surface | Minimum behavior proved locally | Heavier evidence boundary |
| --- | --- | --- |
| Package entrypoints | Every declared JavaScript export imports; documented names match; constants and synchronous validators preserve their public contracts. | None for import itself. Operations that invoke tools use the matching boundary below. |
| EventManager and event stacks | Live pub/sub ordering and payload identity, nested causation, immutable/redacted snapshots, strict import, bounded overflow, seek, all playback modes/lifecycle outcomes, cancellation, and DOM start/stop/privacy behavior. | Real user journeys and browser layout belong in a browser harness; event-stack review never proves that external side effects can be replayed. |
| CLI | Commands parse, acknowledge, select one scope, produce normalized human/JSON/NDJSON output, propagate cancellation/failure, and reject invalid cardinality. | Native build/run requires the selected real provider and host. |
| Browser runtime modules | Every shipped ESM module parses and its export inventory matches the catalog; pure helpers run focused success/error cases. | DOM, OPFS, media, and Web Component journeys use a browser harness. |
| Core bridge docs | Canonical namespace/method/event/entity inventories match their one-per-member guides and required sections. | Live Core conformance belongs in Arcane OS because Core implementation is not shipped as SDK source. |
| Arcane Ollama wrapper | Missing-host error, method forwarding, text/readiness normalization, unload request, and stream-option forwarding run against a deterministic fake `Arcane.ollama`. | Real managed-service, model download/create, GPU/resource admission, and service restart require an admitted Arcane host. |
| Native providers | Plan/provider protocol, explicit target, receipt authentication, artifact reader, and unavailable-path honesty are tested with bounded fixtures. | Exact Windows, Linux, or Android artifact verification and launch must run on that actual platform/architecture. |

## Executable examples

Examples should be safe to run repeatedly and should stop at the last boundary
they can honestly prove. Documentation examples that would download a model,
restart a service, create a user, install software, log out, delete a model, or
launch an external resource define a function but do not invoke it.

Behavior tests replace real authority with an explicit fake only for the public
client contract. They must assert the exact request sent to the fake and the
normalized result returned to the application. A fake provider never counts as
native host, artifact, installation, or model-service evidence.

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

Central-event changes additionally cover the exact retention boundary:
`maxEvents` ordinary records plus one terminal
`TIME_TRAVEL_OVERFLOW_EVENT`, recording disabled, DOM observation stopped,
continued unrecorded live delivery, rejection when re-enabling before
`clearHistory()`, and strict acceptance of only a terminal overflow marker.
DOM cases assert that private values, credentials, sensitive attributes, URLs,
and markup remain redacted under every capture-option combination.

## Test ownership

The SDK owns package, CLI, synchronized renderer, documentation, and injected
provider-boundary behavior. Arcane OS owns live Core dispatch, native host
bridges, capability policy, host service adapters, and real ArcaneOllama
integration. A change that crosses both repositories needs focused tests at both
owners; copying a Core test into this package would not make the SDK the Core
implementation owner.
