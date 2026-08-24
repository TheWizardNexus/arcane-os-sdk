# Arcane Shared Entities

## Purpose

The modules under `arcane/entities/` provide shared JavaScript records, value
objects, validation helpers, and contract vocabularies for Arcane applications.
This reference is the canonical inventory of their public module exports. The
export key is `<module path>#<export name>`; `default` denotes a module's default
export. Import only the exports listed here, and do not depend on unexported
implementation details.

The `Kind` column describes the exported JavaScript value: `class`, `function`,
or `constant`. Detailed, versioned rules for intent envelopes and TWiN policy
decisions remain authoritative in the linked contract documents.

## Export inventory

| Export key | Kind | Runtime symbol | Public contract |
|---|---|---|---|
| `arcane/entities/ApiModelRecord.js#default` | class | `ApiModelRecord` | Validates and freezes an HTTP(S) API response snapshot containing its endpoint, fetch time, metadata, and value. |
| `arcane/entities/Calculation.js#default` | class | `Calculation` | Validates and freezes a bounded expression, finite numeric result, and creation time. |
| `arcane/entities/Chat.js#default` | class | `ChatEntity` | Owns a browser chat session's messages, tool exchanges, memory extraction, and optional DBOPFS persistence in the `chats` table. |
| `arcane/entities/CommunicationMessage.js#default` | class | `CommunicationMessage` | Normalizes and freezes one provider message, including addressing, channel, direction, delivery state, timestamp, and attachment metadata. |
| `arcane/entities/CommunicationMessage.js#communicationChannels` | constant | `communicationChannels` | Shared `Set` of recognized message-channel identifiers: `email`, `sms`, `mms`, `rcs`, `whatsapp`, and `other`; consumers must not mutate it. |
| `arcane/entities/CommunicationThread.js#default` | class | `CommunicationThread` | Normalizes and freezes a provider conversation snapshot with participants, unread state, and `CommunicationMessage` records. |
| `arcane/entities/Document.js#default` | class | `DocumentEntity` | Specializes `FileEntity` with `documents` as its default DBOPFS table. |
| `arcane/entities/File.js#default` | class | `FileEntity` | Addresses a DBOPFS file by table and name, saves supported file data, and opens files with MIME and format-aware parsing metadata. |
| `arcane/entities/Image.js#default` | class | `ImageEntity` | Specializes `FileEntity` for the `images` table and exposes image validation, storage, data-URL, and blob-URL helpers. |
| `arcane/entities/IntentEnvelope.js#IntentEnvelopeValidationError` | class | `IntentEnvelopeValidationError` | Privacy-safe validation error with stable `code` and structural `path` fields; see the [intent-envelope contract](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/intent-envelope.md#errors). |
| `arcane/entities/IntentEnvelope.js#createIntentEnvelope` | function | `createIntentEnvelope` | Validates an intake payload separately from trusted identity, time, and provenance context, then returns an immutable v1 envelope; see the [creation authority boundary](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/intent-envelope.md#creation-authority-boundary). |
| `arcane/entities/IntentEnvelope.js#rehydrateIntentEnvelope` | function | `rehydrateIntentEnvelope` | Validates and reconstructs a canonical v1 envelope object or JSON string without asserting authenticity or authority. |
| `arcane/entities/IntentEnvelope.js#serializeIntentEnvelope` | function | `serializeIntentEnvelope` | Produces deterministic canonical JSON for a valid v1 intent envelope. |
| `arcane/entities/IntentEnvelope.js#intentEnvelopeAuditProjection` | function | `intentEnvelopeAuditProjection` | Produces a frozen, bounded structural projection that excludes original expression and other documented content fields; see the [public API contract](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/intent-envelope.md#public-api). |
| `arcane/entities/IntentEnvelope.js#intentEnvelopeContract` | constant | `intentEnvelopeContract` | Frozen v1 schema identifier, version, closed enum vocabularies, and size/count limits. |
| `arcane/entities/Preference.js#default` | class | `Preference` | Validates and freezes one typed preference definition and normalizes candidate values against its type, bounds, and options. |
| `arcane/entities/Preference.js#preferenceSchema` | function | `preferenceSchema` | Converts definitions to `Preference` instances, rejects duplicate keys, and returns a frozen schema array. |
| `arcane/entities/TerminalSession.js#default` | class | `TerminalSession` | Validates terminal identity, shell, and lifecycle state and supports immutable-style patched copies through `with()`. |
| `arcane/entities/TerminalSession.js#terminalShells` | constant | `terminalShells` | Frozen array of supported shell identifiers: `auto`, `powershell`, `cmd`, `bash`, and `sh`. |
| `arcane/entities/Theme.js#arcaneLightThemeTokens` | constant | `arcaneLightThemeTokens` | Frozen map of the default light-scheme semantic color tokens. |
| `arcane/entities/Theme.js#arcaneDarkThemeTokens` | constant | `arcaneDarkThemeTokens` | Frozen map of the default dark-scheme semantic color tokens. |
| `arcane/entities/Theme.js#themeTokens` | constant | `themeTokens` | Frozen ordered definitions that map public theme-token keys to CSS custom properties, labels, and defaults. |
| `arcane/entities/Theme.js#themeColorToHex` | function | `themeColorToHex` | Validates an RGB, RGBA, or six-digit hexadecimal color and returns its RGB channels as a normalized six-digit hexadecimal color. |
| `arcane/entities/Theme.js#default` | class | `Theme` | Validates and freezes a named light or dark token set and can serialize, restore, apply, or clear that theme on a document root. |
| `arcane/entities/TWiNPolicyDecision.js#TWiNPolicyDecisionValidationError` | class | `TWiNPolicyDecisionValidationError` | Privacy-safe policy-decision validation error with stable `code` and structural `path` fields; see the [TWiN error contract](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/twin-policy-decision.md#failure-and-recovery). |
| `arcane/entities/TWiNPolicyDecision.js#createTWiNPolicyDecision` | function | `createTWiNPolicyDecision` | Validates an evaluator payload separately from trusted decision and policy provenance, then returns an immutable v1 decision; see the [trusted creation boundary](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/twin-policy-decision.md#trusted-creation-boundary). |
| `arcane/entities/TWiNPolicyDecision.js#rehydrateTWiNPolicyDecision` | function | `rehydrateTWiNPolicyDecision` | Validates and reconstructs a canonical v1 policy-decision object or exact canonical JSON without asserting authenticity, freshness, or authority. |
| `arcane/entities/TWiNPolicyDecision.js#serializeTWiNPolicyDecision` | function | `serializeTWiNPolicyDecision` | Produces deterministic canonical JSON for a valid v1 TWiN policy decision. |
| `arcane/entities/TWiNPolicyDecision.js#twinPolicyDecisionAuditProjection` | function | `twinPolicyDecisionAuditProjection` | Produces a frozen structural audit projection that omits requirement targets and values; see [privacy and audit behavior](https://github.com/TheWizardNexus/ARCANE-OS/blob/567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e/docs/twin-policy-decision.md#privacy-and-audit-behavior). |
| `arcane/entities/TWiNPolicyDecision.js#twinPolicyDecisionContract` | constant | `twinPolicyDecisionContract` | Frozen v1 schema identifier, version, layers, outcomes, core reason codes, and size/count limits. |
| `arcane/entities/User.js#default` | class | `UserEntity` | Owns the browser user's validated settings and profile record, including DBOPFS load, refresh, serialized updates, and optional persistence. |
| `arcane/entities/Weather.js#WeatherLocation` | class | `WeatherLocation` | Validates and freezes geographic identity, coordinates, and timezone metadata for a weather location. |
| `arcane/entities/Weather.js#WeatherObservation` | class | `WeatherObservation` | Validates and freezes one timestamped current-weather observation and its units. |
| `arcane/entities/Weather.js#WeatherDay` | class | `WeatherDay` | Validates and freezes one daily forecast with temperature, precipitation, and optional sunrise and sunset times. |
| `arcane/entities/Weather.js#WeatherSnapshot` | class | `WeatherSnapshot` | Validates and freezes a location, current observation, daily forecast list, source, and fetch time as one weather snapshot. |

## Compatibility boundary

An exported entity validates and represents data; it does not grant a capability,
authorization, native resource handle, provider credential, or policy approval.
Consumers must preserve the separate Arcane capability and trust boundaries that
govern persistence, networking, native execution, and protected data.

Changing an export name, kind, meaning, enum, accepted shape, serialization, or
validation invariant is a public-contract change. Update the implementation,
this inventory, its focused tests, and any linked versioned contract together.
