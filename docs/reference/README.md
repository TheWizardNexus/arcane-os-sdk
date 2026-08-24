# Arcane OS SDK developer reference

This reference answers developer questions in this order:

1. **What can the application or tool do?**
2. **What should I import or call?**
3. **What does a successful result look like?**
4. **Where does it run?**
5. **Only when needed: which transport, host, provider, or kernel boundary implements it?**

The default path is capability-first. Transport and implementation detail is
kept in the [protocol and host architecture guide](protocols.md), and every
high-level page links to the relevant deep section instead of repeating it.

## Reference map

| Need | Start here |
| --- | --- |
| Use the Node.js package API | [SDK JavaScript API](sdk-api.md) |
| Publish central events, capture bounded time-travel history, or observe the DOM | [EventManager and event-stack reference](event-manager.md) |
| Use the `arcane` command | [CLI reference](cli.md) |
| Choose browser, native, cloud, or cross-host behavior | [Availability and normalization](availability-and-normalization.md) |
| Import a shipped renderer module | [Runtime module catalog](runtime-modules.md) |
| Use a shared entity | [Runtime entity modules](runtime-entities.md) and [exact export contracts](core/arcane-entities.md) |
| Load a reusable HTML component | [Runtime component catalog](runtime-components.md) |
| Call `globalThis.Arcane` | [Arcane Core API](core/arcane-api.md) |
| Subscribe to native events | [Arcane event reference](core/arcane-events.md) |
| Use provider-neutral AI | [Arcane AI contracts](core/arcane-ai-contracts.md) |
| Use Arcane Ollama | [Arcane Ollama guide](arcane-ollama.md) |
| Understand transports and protocol switching | [Protocol and host architecture](protocols.md) |
| Run contract and behavior tests | [Behavioral testing](behavioral-testing.md) |

## Version scope and provenance

This repository contains two related, explicitly versioned surfaces:

| Surface | Source identity | Meaning |
| --- | --- | --- |
| SDK and CLI | `arcane-os` `0.1.0-dev.5` | The Node.js toolchain and package exports in this checkout. |
| Browser runtime | Arcane OS commit `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, bundle `0.8.12`, protocol `arcane/1` | The exact 155-file runtime snapshot shipped under `runtime/`. |
| Core reference snapshot | Arcane OS commit `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, protocol `arcane/1` | The application-facing Core contract derived into `docs/reference/core/`. Canonical inventory and focused-member content was verified unchanged at Arcane OS `main` commit `13f3ce0ae34f77a3495331c8b4c30b1bb105f8ed`; SDK-local provenance, link, and package-boundary annotations are added explicitly. |

The runtime receipt and Core reference remain distinct evidence even though
they currently share one pinned upstream source identity. A browser module's
bytes come from the generated runtime receipt. A native build selects one
explicit Arcane OS checkout and Core. This SDK version accepts that selection
only after its current native plan checks the exact declared protocol, version,
features, capabilities, methods, provider contract, and identity-bound
receipts. That current-build admission does not promise that a future SDK will
accept this Core or that this SDK will accept a future Core. A matching protocol
name or higher version alone is not compatibility or authority.

See [Core reference provenance](core/README.md) for the imported inventory and
the exact distinction between a documentation snapshot and shipped runtime
bytes.

## MDN-style page contract

Public reference entries follow the established Arcane documentation model:

- one canonical, mechanically readable inventory owns each public name;
- every public member or module has one guide entry headed by its exact name;
- each guide leads with an overview and the shortest safe working example;
- parameters, return values, errors, side effects, cancellation, and events are
  stated when they apply;
- availability is summarized near the call, while transport mechanics are
  folded into or deep-linked from the entry;
- normalized results are distinguished from provider- or platform-native
  envelopes;
- examples do not trigger destructive, privileged, expensive, or external
  actions merely by being copied.

## Public runtime inventory

The Node package exposes 158 semantic JavaScript records across 11 JavaScript
entrypoints, plus eight JSON Schemas, its exact runtime manifest, and package
metadata. The [machine-readable package inventory](inventory/package-api.json)
and [SDK member reference](sdk-api.md) are checked bidirectionally against every
declared JavaScript export.

The seven update-check records are explicit on-demand checks; they do not poll,
download, install, or self-update.

The synchronized browser payload exposes:

- 78 JavaScript module artifacts under `runtime/arcane/modules/`, including
  ESM modules, classic vendor globals, one worker protocol, and one Node-oriented
  mail transport;
- 15 shared entity modules under `runtime/arcane/entities/`;
- 39 reusable HTML-import components under `runtime/arcane/components/`;
- seven shared CSS artifacts, security policy, images, and the vendored
  `strong-type` dependency.

The module and component catalogs enumerate every shipped artifact, including
vendor support files that are not ESM imports. The runtime manifest remains the
byte-level source of truth; the catalogs explain what those bytes let a
developer do.

## Authority and feature detection

The presence of a JavaScript function is not permission to use it. Native
applications should inspect `Arcane.capabilities.list()` where available and
then call the relevant status method. Android callers with `system.read` obtain
the nested capability snapshot through `Arcane.platform.status()`.

Do not infer local-AI readiness from `Arcane.runtime.current().managedLocalAI`,
infer authorization from a transport name, or treat an Ollama model inventory
as package admission. Each method rechecks native policy at invocation time.

## Source, receipts, and licensing

- [Pinned upstream ARCANE-OS source](https://github.com/TheWizardNexus/ARCANE-OS/tree/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e)
- [Exact runtime release manifest](../../runtime/ARCANE_RUNTIME_RELEASE.json)
- [Reviewed runtime source pin](../../tools/runtime-source.json)
- [AGPL license](../../LICENSE)
- [Commercial-license notice](../../COMMERCIAL-LICENSE.md)
- [Third-party and distribution notice](../../NOTICE)
