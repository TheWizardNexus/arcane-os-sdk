# Arcane Core reference snapshot

This directory derives the complete committed Arcane application API reference
from the SDK runtime's exact upstream Arcane OS commit
`567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`. The imported reference defines
protocol `arcane/1` at that source identity. Its canonical inventories and
focused member contracts were imported from committed Arcane OS `main` commit
`13f3ce0ae34f77a3495331c8b4c30b1bb105f8ed`. SDK-local links and
package-boundary annotations are intentionally added here, so the imported
Markdown remains a maintained SDK reference rather than a second runtime
authority.

The snapshot contains:

- 35 namespaces, constructors, and values;
- 106 application-facing methods;
- 14 renderer-visible event names;
- 29 public shared-entity exports;
- the complete provider-neutral AI and direct Ollama data contracts;
- 141 MDN-style member guides with exact H2 keys, substantive contract detail,
  and safe JavaScript examples.

## Canonical files

| Contract | File |
| --- | --- |
| Namespace and method inventory | [Arcane API reference](arcane-api.md) |
| Event names, delivery, hosts, triggers, and payloads | [Arcane events](arcane-events.md) |
| Public entity exports | [Arcane entities](arcane-entities.md) |
| AI requests, results, bounds, and provider boundaries | [Arcane AI data contracts](arcane-ai-contracts.md) |
| Ollama runtime/module overview | [Ollama module](ollama-module.md) |
| Per-member guides | [`reference/arcane-api/`](reference/arcane-api/) |

## Runtime source and Core compatibility

The SDK's browser runtime and this source reference use the same selected Arcane
OS source commit, but they remain different artifact classes. A native build
does not infer compatibility from a higher Core version or a matching protocol
name. It compares the protocol, version, features, capabilities, methods, and
provider contract required by the selected build. That present-build result is
not a promise that a future SDK will accept this Core or that this SDK will
accept a future Core.

Documentation does not select a Core. The selected native plan and provider
contracts remain authoritative for a particular build.

## Reading order

Application developers should begin with the capability or method in
[Arcane API reference](arcane-api.md) and use its linked guide. Engineers who
need WebView2, WebKitGTK, Android WebView, development HTTP, Core RPC, event,
or provider boundaries can continue into the SDK's
[protocol and host architecture guide](../protocols.md).

## Source and license links

- [Pinned upstream ARCANE-OS source](https://github.com/TheWizardNexus/ARCANE-OS/tree/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e)
- [SDK runtime source pin](../../../tools/runtime-source.json)
- [AGPL license](../../../LICENSE)
- [Commercial-license notice](../../../COMMERCIAL-LICENSE.md)
- [Third-party and distribution notice](../../../NOTICE)
