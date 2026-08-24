# Arcane runtime module catalog

Every file shipped under `runtime/arcane/modules/` appears here. Start with the capability and example; expand into [protocol and host architecture](protocols.md) only when transport detail matters.

Apps import renderer ESM from `/arcane/modules/<file>`. Classic scripts, the OPFS worker, uPlot stylesheet, and vendor license are called out explicitly. Importing a module does not grant a native capability.

## Availability shorthand

- **Cross-host** means in-process logic built from standard JavaScript/Web APIs.
- **Browser / native WebView** means DOM, storage, media, or component behavior available in a browser renderer and in supported native WebViews.
- **Native bridge** means the module requires an admitted `globalThis.Arcane` method.
- **Hybrid** means one public helper deliberately selects a documented native or browser/provider path.
- **Cloud** means the module can call an explicitly configured remote provider; it never implies automatic local-to-cloud fallback.
- **Node**, **worker**, and **vendor** identify specialized runtimes.

## Canonical inventory

| Module | Kind | Capability | Availability | Normalization |
| --- | --- | --- | --- | --- |
| [`AI.js`](#aijs) | esm | Provider-selectable chat, speech-to-text, text-to-speech, tool calling, structured output, streaming, and queued audio playback. | Browser + native bridge + cloud | High-level chat/speech behavior is normalized; provider diagnostics and media errors remain mixed. |
| [`AIPreferenceRuntime.js`](#aipreferenceruntimejs) | esm | Applies and reads non-persistent per-user AI preference overrides. | Cross-host | Normalized six-slot preference state. |
| [`AIPreferenceTuple.js`](#aipreferencetuplejs) | esm | Normalizes and compares the six provider/model preference slots. | Cross-host | Fully normalized frozen tuple. |
| [`AIResponseLength.js`](#airesponselengthjs) | esm | Normalizes concise/short/medium/long response preferences and applies the matching system instruction. | Cross-host | Fully normalized string/instruction contract. |
| [`AIResponseURLPolicy.js`](#airesponseurlpolicyjs) | esm | Extracts and audits links from AI Markdown, rendered HTML, CSS, srcset, bare URLs, and email text. | Cross-host | Normalized frozen allowlist audit. |
| [`AnsiText.js`](#ansitextjs) | esm | Parses terminal ANSI sequences into display spans or strips them to plain text. | Cross-host | Normalized text/span output. |
| [`ApiModelDatabase.js`](#apimodeldatabasejs) | esm | Fetches an injectable HTTP JSON model with parser, cache, redacted public endpoint records, and request lifecycle events. | Browser / native WebView / server with fetch | Request records are normalized; fetch/provider failures remain mixed. |
| [`AppDataScope.js`](#appdatascopejs) | esm | Reconciles declared and native application identity and scopes OPFS/localStorage ownership fail-closed. | Browser / native WebView hybrid | Strict normalized identifiers and coded mismatch failures. |
| [`AppearancePreferences.js`](#appearancepreferencesjs) | esm | Defines, stores, and applies color scheme, density, reduced motion, and large-text preferences. | Browser / native WebView hybrid | Normalized values; storage/host failures remain mixed. |
| [`ArcaneCommunicationBridge.js`](#arcanecommunicationbridgejs) | esm | Maps provider HTTP threads/messages/connect/disconnect endpoints to normalized communication entities. | Browser / native WebView / server with fetch | Entity results are normalized; provider/transport failures remain mixed. |
| [`ArcaneNavigationPolicy.js`](#arcanenavigationpolicyjs) | esm | Creates a fail-closed HTTP(S) navigation guard with domain and CIDR policy decisions. | Cross-host | Normalized frozen allow/block decision. |
| [`ArcaneNetworkPolicy.js`](#arcanenetworkpolicyjs) | esm | Validates the Arcane domain/network deny policy and matches domain, IPv4/IPv6 CIDR, protocol, and port rules. | Cross-host | Strict coded normalization. |
| [`AsyncBoundary.js`](#asyncboundaryjs) | esm | Runs one asynchronous operation with timeout, abort, result validation, and stable boundary errors. | Cross-host | Fully normalized timeout/abort errors. |
| [`BrowserTestSuite.js`](#browsertestsuitejs) | esm | Runs a fixed sequential browser test list with cooperative abort, per-test timeout, and lifecycle events. | Browser / standard Web APIs | Normalized result and skip/assertion errors. |
| [`CalculatorEngine.js`](#calculatorenginejs) | esm | Evaluates bounded arithmetic, powers, constants, and common functions without `eval`. | Cross-host | Normalized `Calculation` result and parser errors. |
| [`CaseEvidenceIndexer.js`](#caseevidenceindexerjs) | esm | Pairs and indexes structured evidence records with rendered-page provenance and SHA-256 identity. | Node only | Normalized naming/page helpers; filesystem errors preserved. |
| [`ChartLibrary.js`](#chartlibraryjs) | esm | Loads the bundled uPlot classic script once and returns its global constructor. | Browser / native WebView | Load state/errors normalized; uPlot result is vendor-native. |
| [`ChatRecords.js`](#chatrecordsjs) | esm | Detects whether a chat record contains a meaningful user entry. | Cross-host | Boolean normalized result. |
| [`CommunicationAppController.js`](#communicationappcontrollerjs) | esm | Binds shared inbox, conversation, settings, theme, and provider workflows into one UI controller. | Browser / native WebView hybrid | Controller state normalized; provider/DOM failures mixed. |
| [`CommunicationHub.js`](#communicationhubjs) | esm | Fans out provider refresh/send operations and aggregates normalized threads/messages. | Cross-host with injected providers | Normalized aggregates; refresh contains per-provider failures. |
| [`CommunicationPreferences.js`](#communicationpreferencesjs) | esm | Stores app-scoped, non-secret communication provider preferences. | Browser / native WebView hybrid | Normalized preference record; storage failures mixed. |
| [`CommunicationProviderRegistry.js`](#communicationproviderregistryjs) | esm | Registers and queries validated provider definitions, channels, and required methods. | Cross-host | Strict normalized registry. |
| [`ComponentContracts.js`](#componentcontractsjs) | esm | Owns normalized configuration/value contracts shared by chart, dashboard, Markdown, and voice components. | Cross-host | Fully normalized labels, rows, definitions, visibility, formats, editor and voice options. |
| [`ConfiguredAIChatSession.js`](#configuredaichatsessionjs) | esm | Owns bounded in-memory AI turns, context construction, response-length instruction, and atomic history commit. | Native bridge by default; cross-host with injected chat | Normalized session/result; provider rejection preserved. |
| [`ConversationActionItems.js`](#conversationactionitemsjs) | esm | Normalizes, creates, updates, remembers, selects, and formats bounded conversation action items. | Cross-host | Fully normalized status/base/presentation contract. |
| [`ConversationClosingReport.js`](#conversationclosingreportjs) | esm | Defines the closing-report tool, instruction, result normalizer, call classifier, and formatter. | Cross-host | Fully normalized report contract. |
| [`ConversationTimebox.js`](#conversationtimeboxjs) | esm | Owns conversation limits, control messages, submission barriers, elapsed formatting, and delivery proof. | Cross-host | Fully normalized state/command/delivery errors. |
| [`CoreLocalModelCatalog.js`](#corelocalmodelcatalogjs) | esm | Projects Core local-AI status into UI-safe admitted model and speech availability catalogs. | Cross-host | Fully normalized descriptors and stable admission labels. |
| [`DataMaintenance.js`](#datamaintenancejs) | esm | Deletes empty chats and associated/empty memory records inside the current app data scope. | Browser / native WebView | Normalized counts; destructive storage failures preserved. |
| [`DBLS.js`](#dblsjs) | esm | Provides app-scoped localStorage tables, batch reads/writes, filtering, deletion, and counts. | Browser / native WebView | Scoped keys and values normalized; storage failures mixed. |
| [`DBOPFS.js`](#dbopfsjs) | esm | Provides app-scoped OPFS tables, worker I/O, backup/restore, compression, and CRUD/batch APIs. | Browser / native WebView | App scope normalized; DOM/storage errors preserved. |
| [`DBOPFSWorker.js`](#dbopfsworkerjs) | worker | Serializes OPFS sync-handle read/write requests from a MessagePort. | Dedicated worker | Responses normalize to `{success,fileData?}` or `{error:{name,message}}`. |
| [`DevelopmentWorkspace.js`](#developmentworkspacejs) | esm | Provides bounded workspace inspection, context, setup task, and Node installer clients without arbitrary command execution. | Native bridge | Inputs normalized; provider result/error preserved. |
| [`DirectoryPicker.js`](#directorypickerjs) | esm | Wraps the provider-owned native directory chooser and normalizes selected/cancelled/error results. | Native bridge | Strict normalized selection and coded errors. |
| [`DocumentNavigation.js`](#documentnavigationjs) | esm | Binds document navigation, filtering, history, current-item reveal, and load initialization. | Browser / native WebView | Normalized filter/navigation state; DOM effects preserved. |
| [`Errors.js`](#errorsjs) | esm | Normalizes global errors/rejections, fingerprints and deduplicates incidents, persists a ledger, and performs bounded delivery. | Browser / native WebView hybrid | Incident records normalized; storage/mail failures isolated. |
| [`GifEncoder.js`](#gifencoderjs) | esm | Encodes indexed frames into a bounded animated GIF using palette mapping and LZW. | Cross-host | Normalized byte output and bounds. |
| [`HTMLImport.js`](#htmlimportjs) | esm | Defines the same-origin `<html-import>` loader with open shadow root, inline script execution, and readiness/error events. | Browser / native WebView | Public error detail normalized; fetch/DOM failure preserved. |
| [`InMemoryCommunicationProvider.js`](#inmemorycommunicationproviderjs) | esm | Implements deterministic in-memory thread/message/send behavior for demos and tests. | Cross-host | Normalized communication entities. |
| [`IsolatedModelQuestionRunner.js`](#isolatedmodelquestionrunnerjs) | esm | Inspects one exact model and runs one isolated question with proof validation. | Native bridge or injected provider | Strict normalized proof/coded errors. |
| [`LocalAIReadiness.js`](#localaireadinessjs) | esm | Derives selected AI requirements and returns a frozen readiness/recovery report across browser, desktop, and Android modes. | Browser/native hybrid | Fully normalized report and stable error codes; browsers never probe Ollama. |
| [`LocalAIReadinessController.js`](#localaireadinesscontrollerjs) | esm | Coordinates local-AI status component checks, ensured recovery, availability projection, and teardown. | Browser/native hybrid | Normalized controller state and change events. |
| [`Mail.js`](#mailjs) | esm | Builds bounded reports and prefers the native mail capability with an explicit HTTP transport fallback. | Browser/native hybrid + cloud | Mail inputs/results normalized; transport failures mixed. |
| [`MailTransport.mjs`](#mailtransportmjs) | esm | Sends one bounded mail report to a normalized HTTP(S) endpoint with timeout and response-size limits. | Browser/server with fetch + cloud | Normalized endpoint/timeout/size errors; remote detail bounded. |
| [`Marked.min.js`](#markedminjs) | esm | Vendored Marked 18.0.5 Markdown lexer, parser, renderer, extension, and walk-token API. | Cross-host vendor module | Vendor-native Marked contract. |
| [`MD.js`](#mdjs) | esm | Renders Markdown with Marked and exposes a DOM-sanitized projection. | Browser / native WebView | Raw Marked behavior plus Arcane sanitization; parse errors vendor-native. |
| [`MemoryRecords.js`](#memoryrecordsjs) | esm | Normalizes memory content and detects meaningful stored memory. | Cross-host | Fully normalized string/boolean results. |
| [`MessageAdvisory.js`](#messageadvisoryjs) | esm | Normalizes message content advisories and contains per-message inspection failures. | Cross-host | Normalized advisory records; inspector failures converted to unavailable results. |
| [`ModelDefinition.js`](#modeldefinitionjs) | esm | Parses the deterministic packaged Modelfile subset and extracts the SYSTEM prompt. | Cross-host | Strict normalized definition with coded syntax errors. |
| [`Ollama.js`](#ollamajs) | esm | Provides the first-class Arcane Ollama client without direct access to localhost:11434. | Native bridge | Principal methods preserve provider-native envelopes; readiness/text/unload helpers normalize. |
| [`OllamaModelIdentifier.js`](#ollamamodelidentifierjs) | esm | Validates and canonicalizes the syntax of Ollama model identifiers without granting model admission. | Cross-host | Fully normalized string/boolean result. |
| [`OllamaSettings.js`](#ollamasettingsjs) | esm | Defines bounded runtime/service preference schemas and deterministic Arcane brain alias names. | Cross-host | Fully normalized settings/name contract. |
| [`OpenMeteoWeatherProvider.js`](#openmeteoweatherproviderjs) | esm | Searches and loads Open-Meteo data into frozen Arcane weather entities. | Browser / native WebView / server with fetch + cloud | Provider data normalized to entities; transport errors mixed. |
| [`PreferenceStore.js`](#preferencestorejs) | esm | Loads and updates schema-defined app preferences through native storage with a narrow browser fallback. | Browser/native hybrid | Values normalized; only exact unsupported capability falls back. |
| [`QRCode.min.js`](#qrcodeminjs) | classic-script | Vendored QRCode generator for DOM, canvas, SVG, and image output. | Browser vendor script | Vendor-native. |
| [`Questionnaire.js`](#questionnairejs) | esm | Evaluates whether a one-time questionnaire prompt is due without performing the prompt. | Cross-host | Normalized fail-closed boolean. |
| [`RecordLinkIndex.js`](#recordlinkindexjs) | esm | Parses record links and builds their normalized index. | Cross-host | Fully normalized. |
| [`RecordPassageIndex.js`](#recordpassageindexjs) | esm | Indexes text lines, page markers, dates, rules, and excerpts for record review. | Cross-host | Fully normalized. |
| [`RecordReviewStore.js`](#recordreviewstorejs) | esm | Stores normalized record-review decisions through native storage or app-scoped local fallback. | Browser/native hybrid | Normalized ids/reviews/snapshots; storage failures mixed. |
| [`RevocableProjectionLedger.js`](#revocableprojectionledgerjs) | esm | Implements an append-only bounded in-memory projection/revocation ledger safe for hostile descriptor inputs. | Cross-host | Strict normalization with stable `ProjectionLedgerError`. |
| [`RiskSignalAnalyzer.js`](#risksignalanalyzerjs) | esm | Matches configured risk signals and levels against bounded text. | Cross-host | Fully normalized. |
| [`ScamRiskPolicy.js`](#scamriskpolicyjs) | esm | Combines deterministic scam signals with Arcane blocked-domain evidence and safety guidance. | Cross-host | Fully normalized. |
| [`ScopedOPFSCache.js`](#scopedopfscachejs) | esm | Provides a narrow exact-key JSON cache inside one app-owned OPFS namespace. | Browser / native WebView | Keys/limits/corruption handling normalized; storage errors mixed. |
| [`ScreenCapture.js`](#screencapturejs) | esm | Captures a display surface as image, video, or GIF with explicit lifecycle events. | Browser / native WebView | State/events normalized; permission and codec errors mixed. |
| [`SpeechPlayback.js`](#speechplaybackjs) | esm | Segments bounded text, queues latest-request speech synthesis, and controls lookahead HTML audio playback. | Browser + native bridge | State/limits normalized; provider/media failures mixed. |
| [`StaticDocumentCatalog.js`](#staticdocumentcatalogjs) | esm | Loads a positive static document inventory with byte/hash verification, cache, search, and bounded context. | Browser / native WebView / server with fetch | Strict catalog/content normalization; transport failures mixed. |
| [`SystemAppearance.js`](#systemappearancejs) | esm | Reads or applies native appearance, returning an explicit unsupported browser state when no bridge exists. | Browser/native hybrid | Absent bridge normalized; native result/error preserved. |
| [`SystemPlatformPresentation.js`](#systemplatformpresentationjs) | classic-script | Maps kernel names to presentation labels/classes without granting platform authority. | Browser / native WebView classic script | Fully normalized presentation only. |
| [`SystemToolRegistry.js`](#systemtoolregistryjs) | esm | Registers validated command builders and constructs command strings without executing them. | Cross-host | Fully normalized definitions/quoting. |
| [`TerminalClient.js`](#terminalclientjs) | esm | Maps native terminal sessions and Arcane events into an EventTarget client. | Native bridge | Client events/state normalized; native result/error mixed. |
| [`TerminalCommandRegistry.js`](#terminalcommandregistryjs) | esm | Routes parsed command lines to injected handlers and provides definitions/completions. | Cross-host | Parsing/routing normalized; handler result/error preserved. |
| [`ThemeBootstrap.js`](#themebootstrapjs) | esm | Performs import-time Arcane theme loading and subscribes to native appearance changes. | Browser/native hybrid | Theme state normalized; storage/native errors mixed. |
| [`ThemeManager.js`](#thememanagerjs) | esm | Loads, applies, previews, saves, resets, and synchronizes semantic Arcane themes. | Browser/native hybrid | Theme values/events normalized; storage/native failures mixed. |
| [`TimeGuard.js`](#timeguardjs) | esm | Persists and evaluates clock rollback and grace-period state. | Browser / native WebView | Time decisions normalized; storage lifecycle mixed. |
| [`ToolCallRouter.js`](#toolcallrouterjs) | esm | Parses OpenAI-style tool calls and dispatches complete or streamed calls to injected handlers. | Cross-host | Arguments/routing normalized; handler results returned or all-settled. |
| [`uPlot.iife.min.js`](#uplotiifeminjs) | classic-script | Vendored uPlot chart constructor and rendering runtime. | Browser vendor script | Vendor-native. |
| [`uPlot.LICENSE.txt`](#uplotlicensetxt) | license | License companion for the bundled uPlot vendor runtime. | Documentation asset | Not executable. |
| [`uPlot.min.css`](#uplotmincss) | stylesheet | Bundled uPlot presentation stylesheet. | Browser stylesheet | Presentation only. |
| [`WaitForComponent.js`](#waitforcomponentjs) | esm | Waits for a component property, method, or readiness event with optional error event and bounded timeout. | Cross-host EventTarget / browser component | Normalized coded readiness, error, and timeout results. |
| [`YouTubeMedia.js`](#youtubemediajs) | esm | Validates YouTube video/playlist locators and constructs privacy-enhanced embed URLs. | Cross-host | Fully normalized. |

## AI.js

### Overview

Provider-selectable chat, speech-to-text, text-to-speech, tool calling, structured output, streaming, and queued audio playback.

### Public surface

default `AI`; `setAI()`, `streamRequest()`, `streamMessage()`, `fetchRequest()`, `fetch()`, `streamTTS()`, `finishTTS()`, `fetchSTT()`, `stopAudio()`, `resumeAudio()`, `playAudio()`; installs `window.ai` and emits `ai-ready`.

Exact exports: `default`.

### Availability and normalization

**Browser + native bridge + cloud.** High-level chat/speech behavior is normalized; provider diagnostics and media errors remain mixed. Transport: OpenAI HTTPS, Arcane.ollama, Arcane.speech, Android WebView bridge. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AI.js';

console.log(Object.keys(module));
```

## AIPreferenceRuntime.js

### Overview

Applies and reads non-persistent per-user AI preference overrides.

### Public surface

`setAIPreferenceRuntimeOverride()`, `getAIPreferencesForRuntime()`.

Exact exports: `getAIPreferencesForRuntime`, `setAIPreferenceRuntimeOverride`.

### Availability and normalization

**Cross-host.** Normalized six-slot preference state. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AIPreferenceRuntime.js';

console.log(Object.keys(module));
```

## AIPreferenceTuple.js

### Overview

Normalizes and compares the six provider/model preference slots.

### Public surface

`AI_PREFERENCE_SLOT_KEYS`, `normalizeAIPreferenceTuple()`, `aiPreferenceTuplesEqual()`.

Exact exports: `AI_PREFERENCE_SLOT_KEYS`, `aiPreferenceTuplesEqual`, `normalizeAIPreferenceTuple`.

### Availability and normalization

**Cross-host.** Fully normalized frozen tuple. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AIPreferenceTuple.js';

console.log(Object.keys(module));
```

## AIResponseLength.js

### Overview

Normalizes concise/short/medium/long response preferences and applies the matching system instruction.

### Public surface

Response-length constants plus `normalizeAIResponseLength()`, `aiResponseLengthInstruction()`, and `applyAIResponseLength()`.

Exact exports: `AI_RESPONSE_LENGTH_DEFAULT`, `AI_RESPONSE_LENGTH_OPTIONS`, `aiResponseLengthInstruction`, `applyAIResponseLength`, `normalizeAIResponseLength`.

### Availability and normalization

**Cross-host.** Fully normalized string/instruction contract. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AIResponseLength.js';

console.log(Object.keys(module));
```

## AIResponseURLPolicy.js

### Overview

Extracts and audits links from AI Markdown, rendered HTML, CSS, srcset, bare URLs, and email text.

### Public surface

`auditAIResponseLinks()`, `extractAIResponseLinks()`, `normalizeAIResponseLink()`, `decodeHTMLCharacterReferences()`.

Exact exports: `auditAIResponseLinks`, `decodeHTMLCharacterReferences`, `extractAIResponseLinks`, `normalizeAIResponseLink`.

### Availability and normalization

**Cross-host.** Normalized frozen allowlist audit. Transport: In-process; bundled Marked parser. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AIResponseURLPolicy.js';

console.log(Object.keys(module));
```

## AnsiText.js

### Overview

Parses terminal ANSI sequences into display spans or strips them to plain text.

### Public surface

`parseAnsi()`, `stripAnsi()`.

Exact exports: `parseAnsi`, `stripAnsi`.

### Availability and normalization

**Cross-host.** Normalized text/span output. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AnsiText.js';

console.log(Object.keys(module));
```

## ApiModelDatabase.js

### Overview

Fetches an injectable HTTP JSON model with parser, cache, redacted public endpoint records, and request lifecycle events.

### Public surface

default `ApiModelDatabase`; `setEndpoint()`, `fetch()`, `cached()`; emits `api-model-request`, `api-model-success`, and `api-model-error`.

Exact exports: `appendParameters`, `default`, `publicEndpoint`.

### Availability and normalization

**Browser / native WebView / server with fetch.** Request records are normalized; fetch/provider failures remain mixed. Transport: HTTP(S) fetch. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ApiModelDatabase.js';

console.log(Object.keys(module));
```

## AppDataScope.js

### Overview

Reconciles declared and native application identity and scopes OPFS/localStorage ownership fail-closed.

### Public surface

Identity constants and `canonicalApplicationId()`, `resolveApplicationId()`, `resolveApplicationLocalStorageKey()`, `openApplicationDataDirectory()`.

Exact exports: `APPLICATION_ID_MAX_LENGTH`, `APPLICATION_ID_PATTERN`, `APP_DATA_DIRECTORY`, `APP_LOCAL_STORAGE_PREFIX`, `canonicalApplicationId`, `declaredApplicationId`, `openApplicationDataDirectory`, `resolveApplicationId`, `resolveApplicationLocalStorageKey`, `resolveBrowserApplicationId`.

### Availability and normalization

**Browser / native WebView hybrid.** Strict normalized identifiers and coded mismatch failures. Transport: Arcane.app.current, DOM declaration, OPFS. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AppDataScope.js';

console.log(Object.keys(module));
```

## AppearancePreferences.js

### Overview

Defines, stores, and applies color scheme, density, reduced motion, and large-text preferences.

### Public surface

`appearancePreferenceSchema`, `createAppearancePreferenceStore()`, `applyAppearancePreferences()`, `loadAndApplyAppearancePreferences()`.

Exact exports: `appearancePreferenceSchema`, `applyAppearancePreferences`, `createAppearancePreferenceStore`, `loadAndApplyAppearancePreferences`.

### Availability and normalization

**Browser / native WebView hybrid.** Normalized values; storage/host failures remain mixed. Transport: PreferenceStore, DOM, optional Arcane preferences. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AppearancePreferences.js';

console.log(Object.keys(module));
```

## ArcaneCommunicationBridge.js

### Overview

Maps provider HTTP threads/messages/connect/disconnect endpoints to normalized communication entities.

### Public surface

default `ArcaneCommunicationBridge`; `request()`, `listThreads()`, `getMessages()`, `send()`, `connect()`, `disconnect()`.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView / server with fetch.** Entity results are normalized; provider/transport failures remain mixed. Transport: JSON HTTP(S), default loopback 127.0.0.1:8020. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ArcaneCommunicationBridge.js';

console.log(Object.keys(module));
```

## ArcaneNavigationPolicy.js

### Overview

Creates a fail-closed HTTP(S) navigation guard with domain and CIDR policy decisions.

### Public surface

`createArcaneNavigationGuard()`.

Exact exports: `createArcaneNavigationGuard`.

### Availability and normalization

**Cross-host.** Normalized frozen allow/block decision. Transport: Arcane network-policy document. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ArcaneNavigationPolicy.js';

console.log(Object.keys(module));
```

## ArcaneNetworkPolicy.js

### Overview

Validates the Arcane domain/network deny policy and matches domain, IPv4/IPv6 CIDR, protocol, and port rules.

### Public surface

Policy constants plus validate/load/cache/match helpers.

Exact exports: `ARCANE_NETWORK_POLICY_SCHEMA_VERSION`, `ARCANE_NETWORK_POLICY_URL`, `canonicalNetworkHostname`, `emptyArcaneNetworkPolicy`, `findDeniedDomainRule`, `findDeniedNetworkRule`, `invalidateArcaneNetworkPolicyCache`, `loadArcaneNetworkPolicy`, `validateArcaneNetworkPolicy`.

### Availability and normalization

**Cross-host.** Strict coded normalization. Transport: Same-origin policy fetch. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ArcaneNetworkPolicy.js';

console.log(Object.keys(module));
```

## AsyncBoundary.js

### Overview

Runs one asynchronous operation with timeout, abort, result validation, and stable boundary errors.

### Public surface

`AsyncBoundaryTimeoutError`, `AsyncBoundaryAbortError`, defaults, `runAsyncBoundary()`, and default alias.

Exact exports: `AsyncBoundaryAbortError`, `AsyncBoundaryTimeoutError`, `asyncBoundaryDefaults`, `default`, `runAsyncBoundary`.

### Availability and normalization

**Cross-host.** Fully normalized timeout/abort errors. Transport: AbortController and timers. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/AsyncBoundary.js';

console.log(Object.keys(module));
```

## BrowserTestSuite.js

### Overview

Runs a fixed sequential browser test list with cooperative abort, per-test timeout, and lifecycle events.

### Public surface

default `BrowserTestSuite`; `list()`, `run()`; emits suite/test start/result/complete events.

Exact exports: `assertionError`, `default`, `skipError`.

### Availability and normalization

**Browser / standard Web APIs.** Normalized result and skip/assertion errors. Transport: EventTarget and timers. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/BrowserTestSuite.js';

console.log(Object.keys(module));
```

## CalculatorEngine.js

### Overview

Evaluates bounded arithmetic, powers, constants, and common functions without `eval`.

### Public surface

default `CalculatorEngine`, `evaluateExpression()`; `calculate()` emits result/error events.

Exact exports: `default`, `evaluateExpression`.

### Availability and normalization

**Cross-host.** Normalized `Calculation` result and parser errors. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/CalculatorEngine.js';

console.log(Object.keys(module));
```

## CaseEvidenceIndexer.js

### Overview

Pairs and indexes structured evidence records with rendered-page provenance and SHA-256 identity.

### Public surface

Eight exported indexing, page, naming, stem, and digest helpers.

Exact exports: `indexPairedRecord`, `nearestPageMarker`, `parseStructuredRecordName`, `renderedPageBlocks`, `resolveEvidenceSourcePage`, `safeName`, `sha256`, `stem`.

### Availability and normalization

**Node only and host-internal.** Normalized naming/page helpers; filesystem errors preserved. The file imports `node:fs/promises`, `node:path`, and `node:crypto`, so a renderer must not import it from `/arcane/modules/`. This SDK version does not expose it as an npm subpath; the example applies to repository-owned Node tooling. [Deep protocol details](protocols.md).

### Example

```javascript
// From a repository-owned tools/*.mjs file:
import {safeName, stem} from '../runtime/arcane/modules/CaseEvidenceIndexer.js';

console.log(safeName('Evidence 01.pdf'), stem('Evidence 01.pdf'));
```

## ChartLibrary.js

### Overview

Loads the bundled uPlot classic script once and returns its global constructor.

### Public surface

default `loadChartLibrary()`.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Load state/errors normalized; uPlot result is vendor-native. Transport: DOM script injection. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ChartLibrary.js';

console.log(Object.keys(module));
```

## ChatRecords.js

### Overview

Detects whether a chat record contains a meaningful user entry.

### Public surface

`hasUserEntry()`.

Exact exports: `hasUserEntry`.

### Availability and normalization

**Cross-host.** Boolean normalized result. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ChatRecords.js';

console.log(Object.keys(module));
```

## CommunicationAppController.js

### Overview

Binds shared inbox, conversation, settings, theme, and provider workflows into one UI controller.

### Public surface

default controller with `start()`, `bind()`, `configure()`, `refresh()`, `select()`, `send()`, and settings actions.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView hybrid.** Controller state normalized; provider/DOM failures mixed. Transport: DOM plus communication providers. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/CommunicationAppController.js';

console.log(Object.keys(module));
```

## CommunicationHub.js

### Overview

Fans out provider refresh/send operations and aggregates normalized threads/messages.

### Public surface

default `CommunicationHub`; provider enablement, `refresh()`, `messages()`, and `send()`.

Exact exports: `default`.

### Availability and normalization

**Cross-host with injected providers.** Normalized aggregates; refresh contains per-provider failures. Transport: Injected provider contract. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/CommunicationHub.js';

console.log(Object.keys(module));
```

## CommunicationPreferences.js

### Overview

Stores app-scoped, non-secret communication provider preferences.

### Public surface

default `CommunicationPreferences`; `load()`, `save()`.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView hybrid.** Normalized preference record; storage failures mixed. Transport: Arcane.preferences or localStorage. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/CommunicationPreferences.js';

console.log(Object.keys(module));
```

## CommunicationProviderRegistry.js

### Overview

Registers and queries validated provider definitions, channels, and required methods.

### Public surface

default registry with `register()`, `get()`, `has()`, `list()`.

Exact exports: `default`.

### Availability and normalization

**Cross-host.** Strict normalized registry. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/CommunicationProviderRegistry.js';

console.log(Object.keys(module));
```

## ComponentContracts.js

### Overview

Owns normalized configuration/value contracts shared by chart, dashboard, Markdown, and voice components.

### Public surface

Six constant sets and twelve normalization/formatting helpers.

Exact exports: `CHART_LABELS`, `DASHBOARD_LABELS`, `MARKDOWN_FORMATS`, `MARKDOWN_LABELS`, `VOICE_LABELS`, `VOICE_MESSAGES`, `appendTranscription`, `applyMarkdownFormat`, `effectiveDashboardVisibility`, `normalizeChartOptions`, `normalizeChartRows`, `normalizeDashboardDefinitions`, `normalizeDashboardOptions`, `normalizeDashboardVisibility`, `normalizeMarkdownFormats`, `normalizeMarkdownOptions`, `normalizeVoiceOptions`.

### Availability and normalization

**Cross-host.** Fully normalized labels, rows, definitions, visibility, formats, editor and voice options. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ComponentContracts.js';

console.log(Object.keys(module));
```

## ConfiguredAIChatSession.js

### Overview

Owns bounded in-memory AI turns, context construction, response-length instruction, and atomic history commit.

### Public surface

default `ConfiguredAIChatSession`; `history()`, `clear()`, `send()`.

Exact exports: `default`.

### Availability and normalization

**Native bridge by default; cross-host with injected chat.** Normalized session/result; provider rejection preserved. Transport: Arcane.ai.chat or injected provider. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ConfiguredAIChatSession.js';

console.log(Object.keys(module));
```

## ConversationActionItems.js

### Overview

Normalizes, creates, updates, remembers, selects, and formats bounded conversation action items.

### Public surface

Action-item constants and lifecycle/formatting helpers.

Exact exports: `CONVERSATION_ACTION_ITEM_BASES`, `CONVERSATION_ACTION_ITEM_PRESENTATION_COOLDOWN_MS`, `CONVERSATION_ACTION_ITEM_STATUSES`, `MAX_CONVERSATION_ACTION_ITEMS`, `MAX_CONVERSATION_ACTION_ITEM_CHARACTERS`, `MAX_CONVERSATION_REMEMBERED_ACTIONS`, `conversationActionItemsInstruction`, `createConversationActionItem`, `formatConversationActionItemCheckIn`, `markConversationActionItemsPresented`, `normalizeConversationActionItem`, `normalizeConversationActionItems`, `normalizeRememberedConversationActions`, `outstandingConversationActionItems`, `rememberConversationActionItems`, `removeConversationActionItem`, `selectConversationActionItemsForPresentation`, `updateConversationActionItem`.

### Availability and normalization

**Cross-host.** Fully normalized status/base/presentation contract. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ConversationActionItems.js';

console.log(Object.keys(module));
```

## ConversationClosingReport.js

### Overview

Defines the closing-report tool, instruction, result normalizer, call classifier, and formatter.

### Public surface

Six constants/helpers for closing reports.

Exact exports: `CONVERSATION_CLOSING_REPORT_TOOL_NAME`, `classifyConversationClosingReportCalls`, `conversationClosingReportInstruction`, `createConversationClosingReportTool`, `formatConversationClosingReport`, `normalizeConversationClosingReport`.

### Availability and normalization

**Cross-host.** Fully normalized report contract. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ConversationClosingReport.js';

console.log(Object.keys(module));
```

## ConversationTimebox.js

### Overview

Owns conversation limits, control messages, submission barriers, elapsed formatting, and delivery proof.

### Public surface

default `ConversationTimebox`, `ConversationSubmissionBarrier`, constants and control helpers.

Exact exports: `CONVERSATION_TIMEBOX_LIMIT_MESSAGE`, `CONVERSATION_TIMEBOX_OPENING_INSTRUCTION`, `CONVERSATION_TIMEBOX_TOOL_NAME`, `ConversationSubmissionBarrier`, `appendConversationTimeboxOpeningInstruction`, `consumeConversationTimeboxCall`, `conversationTimeboxSubmissionKey`, `conversationTimeboxTool`, `createConversationTimeboxControlMessage`, `default`, `formatConversationElapsed`, `normalizeConversationTimeboxCommand`, `requireConversationTimeboxDelivery`.

### Availability and normalization

**Cross-host.** Fully normalized state/command/delivery errors. Transport: Clock/timers and callbacks. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ConversationTimebox.js';

console.log(Object.keys(module));
```

## CoreLocalModelCatalog.js

### Overview

Projects Core local-AI status into UI-safe admitted model and speech availability catalogs.

### Public surface

Provider-mode constant and four catalog/availability helpers.

Exact exports: `USER_MANAGED_LOOPBACK_PROVIDER_MODE`, `getCoreLocalModelCatalog`, `getCoreLocalModelCatalogWithAdmissionFailures`, `getCoreLocalSpeechAvailability`, `isUserManagedLoopbackLocalAIStatus`.

### Availability and normalization

**Cross-host.** Fully normalized descriptors and stable admission labels. Transport: In-process projection of Core status. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/CoreLocalModelCatalog.js';

console.log(Object.keys(module));
```

## DataMaintenance.js

### Overview

Deletes empty chats and associated/empty memory records inside the current app data scope.

### Public surface

`clearEmptyChatsAndMemories()` plus content predicates.

Exact exports: `clearEmptyChatsAndMemories`, `hasMemoryContent`, `hasUserEntry`.

### Availability and normalization

**Browser / native WebView.** Normalized counts; destructive storage failures preserved. Transport: Global DBOPFS. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DataMaintenance.js';

console.log(Object.keys(module));
```

## DBLS.js

### Overview

Provides app-scoped localStorage tables, batch reads/writes, filtering, deletion, and counts.

### Public surface

default `DBLS`; installs `window.dbls`, emits `dbls-ready`; CRUD/batch/key APIs.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Scoped keys and values normalized; storage failures mixed. Transport: localStorage + AppDataScope. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DBLS.js';

console.log(Object.keys(module));
```

## DBOPFS.js

### Overview

Provides app-scoped OPFS tables, worker I/O, backup/restore, compression, and CRUD/batch APIs.

### Public surface

default `DBOPFS`; installs `window.dbopfs`, emits `dbopfs-ready`; table/file/backup APIs.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** App scope normalized; DOM/storage errors preserved. Transport: OPFS, DBOPFSWorker, Compression Streams. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DBOPFS.js';

console.log(Object.keys(module));
```

## DBOPFSWorker.js

### Overview

Serializes OPFS sync-handle read/write requests from a MessagePort.

### Public surface

No ESM exports; accepts `read` and `write` port requests.

This is a dedicated worker protocol and has no ESM exports.

### Availability and normalization

**Dedicated worker.** Responses normalize to `{success,fileData?}` or `{error:{name,message}}`. Transport: MessageChannel + OPFS sync access handle. [Deep protocol details](protocols.md).

### Example

```javascript
const worker = new Worker('/arcane/modules/DBOPFSWorker.js', {type: 'module'});
```

## DevelopmentWorkspace.js

### Overview

Provides bounded workspace inspection, context, setup task, and Node installer clients without arbitrary command execution.

### Public surface

default `DevelopmentWorkspace` and input validators; `inspect()`, `context()`, `setup()`, `installNode()`.

Exact exports: `contextQuery`, `default`, `setupTaskId`, `workspaceRoot`.

### Availability and normalization

**Native bridge.** Inputs normalized; provider result/error preserved. Transport: Arcane.development. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DevelopmentWorkspace.js';

console.log(Object.keys(module));
```

## DirectoryPicker.js

### Overview

Wraps the provider-owned native directory chooser and normalizes selected/cancelled/error results.

### Public surface

default `DirectoryPicker`, `normalizeDirectoryPickerOptions()`, `normalizeDirectorySelection()`.

Exact exports: `default`, `normalizeDirectoryPickerOptions`, `normalizeDirectorySelection`.

### Availability and normalization

**Native bridge.** Strict normalized selection and coded errors. Transport: Arcane.filesystem.selectDirectory. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DirectoryPicker.js';

console.log(Object.keys(module));
```

## DocumentNavigation.js

### Overview

Binds document navigation, filtering, history, current-item reveal, and load initialization.

### Public surface

Five binding/filter/reveal helpers.

Exact exports: `applyDocumentNavigationFilter`, `bindDocumentNavigation`, `clearDocumentNavigationFilter`, `initializeDocumentNavigation`, `revealCurrentDocumentNavigationItem`.

### Availability and normalization

**Browser / native WebView.** Normalized filter/navigation state; DOM effects preserved. Transport: DOM and history. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DocumentNavigation.js';

console.log(Object.keys(module));
```

## Errors.js

### Overview

Normalizes global errors/rejections, fingerprints and deduplicates incidents, persists a ledger, and performs bounded delivery.

### Public surface

default `Errors`; event normalizers/fingerprint plus lifecycle, capture, delivery and teardown methods.

Exact exports: `default`, `fingerprintIncident`, `normalizeErrorEvent`, `normalizeRejectionEvent`.

### Availability and normalization

**Browser / native WebView hybrid.** Incident records normalized; storage/mail failures isolated. Transport: Window events, DBOPFS, Mail. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/Errors.js';

console.log(Object.keys(module));
```

## GifEncoder.js

### Overview

Encodes indexed frames into a bounded animated GIF using palette mapping and LZW.

### Public surface

default `GifEncoder`, `indexPixels()`, `lzw()`.

Exact exports: `default`, `indexPixels`, `lzw`.

### Availability and normalization

**Cross-host.** Normalized byte output and bounds. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/GifEncoder.js';

console.log(Object.keys(module));
```

## HTMLImport.js

### Overview

Defines the same-origin `<html-import>` loader with open shadow root, inline script execution, and readiness/error events.

### Public surface

default `HTMLImport`; registers `html-import`; `connectedCallback()` and `ready`.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Public error detail normalized; fetch/DOM failure preserved. Transport: Same-origin fetch + DOM. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/HTMLImport.js';

console.log(Object.keys(module));
```

## InMemoryCommunicationProvider.js

### Overview

Implements deterministic in-memory thread/message/send behavior for demos and tests.

### Public surface

default provider with `listThreads()`, `getMessages()`, `send()`.

Exact exports: `default`.

### Availability and normalization

**Cross-host.** Normalized communication entities. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/InMemoryCommunicationProvider.js';

console.log(Object.keys(module));
```

## IsolatedModelQuestionRunner.js

### Overview

Inspects one exact model and runs one isolated question with proof validation.

### Public surface

default/named runner, `countSentences()`, `inspectModel()`, `runQuestion()`.

Exact exports: `IsolatedModelQuestionRunner`, `countSentences`, `default`.

### Availability and normalization

**Native bridge or injected provider.** Strict normalized proof/coded errors. Transport: localAI isolated-model methods. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/IsolatedModelQuestionRunner.js';

console.log(Object.keys(module));
```

## LocalAIReadiness.js

### Overview

Derives selected AI requirements and returns a frozen readiness/recovery report across browser, desktop, and Android modes.

### Public surface

Endpoint constant plus requirements, speech-health, and readiness helpers.

Exact exports: `LOCAL_AI_BROWSER_ENDPOINTS`, `checkLocalAIReadiness`, `deriveLocalAIRequirements`, `evaluateLocalSpeechHealth`.

### Availability and normalization

**Browser/native hybrid.** Fully normalized report and stable error codes; browsers never probe Ollama. Transport: Arcane.localAI, Arcane.speech, bounded browser speech health. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/LocalAIReadiness.js';

console.log(Object.keys(module));
```

## LocalAIReadinessController.js

### Overview

Coordinates local-AI status component checks, ensured recovery, availability projection, and teardown.

### Public surface

`createLocalAIReadinessController()`, `availabilityFromReport()`.

Exact exports: `availabilityFromReport`, `createLocalAIReadinessController`.

### Availability and normalization

**Browser/native hybrid.** Normalized controller state and change events. Transport: LocalAIReadiness + component events. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/LocalAIReadinessController.js';

console.log(Object.keys(module));
```

## Mail.js

### Overview

Builds bounded reports and prefers the native mail capability with an explicit HTTP transport fallback.

### Public surface

default `Mail`, `resolveMailConfig()`; installs `window.mail`; `send()`.

Exact exports: `default`, `resolveMailConfig`.

### Availability and normalization

**Browser/native hybrid + cloud.** Mail inputs/results normalized; transport failures mixed. Transport: Arcane.mail.send or MailTransport HTTP(S). [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/Mail.js';

console.log(Object.keys(module));
```

## MailTransport.mjs

### Overview

Sends one bounded mail report to a normalized HTTP(S) endpoint with timeout and response-size limits.

### Public surface

Timeout/size constants, `normalizeMailEndpoint()`, `sendMailReport()`.

Exact exports: `DEFAULT_MAIL_REQUEST_TIMEOUT_MS`, `MAX_MAIL_RESPONSE_BYTES`, `normalizeMailEndpoint`, `sendMailReport`.

### Availability and normalization

**Browser/server with fetch + cloud.** Normalized endpoint/timeout/size errors; remote detail bounded. Transport: HTTP(S) fetch + AbortController. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/MailTransport.mjs';

console.log(Object.keys(module));
```

## Marked.min.js

### Overview

Vendored Marked 18.0.5 Markdown lexer, parser, renderer, extension, and walk-token API.

### Public surface

Twenty named/default-style Marked exports; see bundled license notice.

Exact exports: `Hooks`, `Lexer`, `Marked`, `Parser`, `Renderer`, `TextRenderer`, `Tokenizer`, `defaults`, `getDefaults`, `lexer`, `marked`, `options`, `parse`, `parseInline`, `parser`, `setOptions`, `use`, `walkTokens`.

### Availability and normalization

**Cross-host vendor module.** Vendor-native Marked contract. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/Marked.min.js';

console.log(Object.keys(module));
```

## MD.js

### Overview

Renders Markdown with Marked and exposes a DOM-sanitized projection.

### Public surface

default `MD`; `raw`, `rendered`, `safeRendered`, `append()`.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Raw Marked behavior plus Arcane sanitization; parse errors vendor-native. Transport: Marked + DOM template sanitization. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/MD.js';

console.log(Object.keys(module));
```

## MemoryRecords.js

### Overview

Normalizes memory content and detects meaningful stored memory.

### Public surface

`normalizeMemoryContent()`, `hasMemoryContent()`.

Exact exports: `hasMemoryContent`, `normalizeMemoryContent`.

### Availability and normalization

**Cross-host.** Fully normalized string/boolean results. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/MemoryRecords.js';

console.log(Object.keys(module));
```

## MessageAdvisory.js

### Overview

Normalizes message content advisories and contains per-message inspection failures.

### Public surface

Three advisory/inspection helpers.

Exact exports: `inspectMessageRecords`, `normalizeContentAdvisory`, `unavailableMessageInspection`.

### Availability and normalization

**Cross-host.** Normalized advisory records; inspector failures converted to unavailable results. Transport: Injected inspector. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/MessageAdvisory.js';

console.log(Object.keys(module));
```

## ModelDefinition.js

### Overview

Parses the deterministic packaged Modelfile subset and extracts the SYSTEM prompt.

### Public surface

`parseModelDefinition()`, `loadModelDefinitionSystemPrompt()`.

Exact exports: `loadModelDefinitionSystemPrompt`, `parseModelDefinition`.

### Availability and normalization

**Cross-host.** Strict normalized definition with coded syntax errors. Transport: Optional same-origin read-only fetch. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ModelDefinition.js';

console.log(Object.keys(module));
```

## Ollama.js

### Overview

Provides the first-class Arcane Ollama client without direct access to localhost:11434.

### Public surface

`Ollama`, singleton/default `ollama`; 24 methods; installs `globalThis.arcaneOllama`, emits `arcane-ollama-ready`.

Exact exports: `Ollama`, `default`, `ollama`.

### Availability and normalization

**Native bridge.** Principal methods preserve provider-native envelopes; readiness/text/unload helpers normalize. Transport: Arcane.ollama through Core. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/Ollama.js';

console.log(Object.keys(module));
```

## OllamaModelIdentifier.js

### Overview

Validates and canonicalizes the syntax of Ollama model identifiers without granting model admission.

### Public surface

`normalizeOllamaModelIdentifier()`, `isOllamaModelIdentifier()`.

Exact exports: `isOllamaModelIdentifier`, `normalizeOllamaModelIdentifier`.

### Availability and normalization

**Cross-host.** Fully normalized string/boolean result. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/OllamaModelIdentifier.js';

console.log(Object.keys(module));
```

## OllamaSettings.js

### Overview

Defines bounded runtime/service preference schemas and deterministic Arcane brain alias names.

### Public surface

`ollamaRuntimeSchema`, `ollamaServiceSchema`, `arcaneBrainModelName()`.

Exact exports: `arcaneBrainModelName`, `ollamaRuntimeSchema`, `ollamaServiceSchema`.

### Availability and normalization

**Cross-host.** Fully normalized settings/name contract. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/OllamaSettings.js';

console.log(Object.keys(module));
```

## OpenMeteoWeatherProvider.js

### Overview

Searches and loads Open-Meteo data into frozen Arcane weather entities.

### Public surface

Endpoint constants, default provider, `mapForecast()`; search/load methods and lifecycle events.

Exact exports: `OPEN_METEO_ENDPOINTS`, `default`, `mapForecast`.

### Availability and normalization

**Browser / native WebView / server with fetch + cloud.** Provider data normalized to entities; transport errors mixed. Transport: Open-Meteo HTTPS. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/OpenMeteoWeatherProvider.js';

console.log(Object.keys(module));
```

## PreferenceStore.js

### Overview

Loads and updates schema-defined app preferences through native storage with a narrow browser fallback.

### Public surface

default `PreferenceStore`, re-exported `Preference`/schema; load/set/reset APIs and events.

Exact exports: `Preference`, `default`, `preferenceSchema`.

### Availability and normalization

**Browser/native hybrid.** Values normalized; only exact unsupported capability falls back. Transport: Arcane.preferences or app-scoped localStorage. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/PreferenceStore.js';

console.log(Object.keys(module));
```

## QRCode.min.js

### Overview

Vendored QRCode generator for DOM, canvas, SVG, and image output.

### Public surface

No ESM exports; global `QRCode`, `makeCode()`, `makeImage()`, `clear()`, `CorrectLevel`.

This is a classic global script and has no ESM exports.

### Availability and normalization

**Browser vendor script.** Vendor-native. Transport: Classic script global + DOM/canvas/SVG. [Deep protocol details](protocols.md).

### Example

```html
<script src="/arcane/modules/QRCode.min.js"></script>
```

## Questionnaire.js

### Overview

Evaluates whether a one-time questionnaire prompt is due without performing the prompt.

### Public surface

Notification default and `Questionnaire` with timing/check methods.

Exact exports: `DEFAULT_QUESTIONNAIRE_NOTIFICATION_TIME_MS`, `Questionnaire`.

### Availability and normalization

**Cross-host.** Normalized fail-closed boolean. Transport: In-process clock only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/Questionnaire.js';

console.log(Object.keys(module));
```

## RecordLinkIndex.js

### Overview

Parses record links and builds their normalized index.

### Public surface

`parseRecordLinks()`, `buildRecordLinkIndex()`.

Exact exports: `buildRecordLinkIndex`, `parseRecordLinks`.

### Availability and normalization

**Cross-host.** Fully normalized. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/RecordLinkIndex.js';

console.log(Object.keys(module));
```

## RecordPassageIndex.js

### Overview

Indexes text lines, page markers, dates, rules, and excerpts for record review.

### Public surface

Eight text/page/date/rule helper exports.

Exact exports: `cleanExcerpt`, `extractDateMentions`, `findRulePassages`, `pageAtLine`, `pageMarkers`, `parseDateMention`, `textLines`, `validIsoDate`.

### Availability and normalization

**Cross-host.** Fully normalized. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/RecordPassageIndex.js';

console.log(Object.keys(module));
```

## RecordReviewStore.js

### Overview

Stores normalized record-review decisions through native storage or app-scoped local fallback.

### Public surface

default store, record/review normalizers; `load()`, `get()`, `set()`, `snapshot()`, change event.

Exact exports: `default`, `normalizeRecordId`, `normalizeReview`.

### Availability and normalization

**Browser/native hybrid.** Normalized ids/reviews/snapshots; storage failures mixed. Transport: Arcane.storage or localStorage. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/RecordReviewStore.js';

console.log(Object.keys(module));
```

## RevocableProjectionLedger.js

### Overview

Implements an append-only bounded in-memory projection/revocation ledger safe for hostile descriptor inputs.

### Public surface

Ledger classes, limits/status/reason constants, clone/fingerprint/port helpers, append/query/list APIs.

Exact exports: `DEFAULT_PROJECTION_LEDGER_CAPACITY`, `DEFAULT_PROJECTION_LEDGER_STORED_CHARACTERS`, `DEFAULT_PROJECTION_LEDGER_STORED_NODES`, `DEFAULT_PROJECTION_LEDGER_STORED_UTF8_BYTES`, `MAX_PROJECTION_LEDGER_CAPACITY`, `MAX_PROJECTION_LEDGER_STORED_CHARACTERS`, `MAX_PROJECTION_LEDGER_STORED_NODES`, `MAX_PROJECTION_LEDGER_STORED_UTF8_BYTES`, `PROJECTION_LEDGER_LIMITS`, `PROJECTION_LEDGER_REASON_CODES`, `PROJECTION_LEDGER_SCHEMA_VERSION`, `PROJECTION_LEDGER_STATUSES`, `ProjectionLedgerError`, `RevocableProjectionLedger`, `cloneProjectionLedgerValue`, `createProjectionLedgerFingerprint`, `createRevocableProjectionLedgerPortAdapter`, `default`.

### Availability and normalization

**Cross-host.** Strict normalization with stable `ProjectionLedgerError`. Transport: In-process or explicit port adapter. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/RevocableProjectionLedger.js';

console.log(Object.keys(module));
```

## RiskSignalAnalyzer.js

### Overview

Matches configured risk signals and levels against bounded text.

### Public surface

`DEFAULT_LEVELS`, `analyzeRiskSignals()`.

Exact exports: `DEFAULT_LEVELS`, `analyzeRiskSignals`.

### Availability and normalization

**Cross-host.** Fully normalized. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/RiskSignalAnalyzer.js';

console.log(Object.keys(module));
```

## ScamRiskPolicy.js

### Overview

Combines deterministic scam signals with Arcane blocked-domain evidence and safety guidance.

### Public surface

Signals plus load, assess, and guidance helpers.

Exact exports: `assessScamRisk`, `loadScamNetworkPolicy`, `scamRiskSignals`, `scamSafetyGuidance`.

### Availability and normalization

**Cross-host.** Fully normalized. Transport: Arcane network policy fetch. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ScamRiskPolicy.js';

console.log(Object.keys(module));
```

## ScopedOPFSCache.js

### Overview

Provides a narrow exact-key JSON cache inside one app-owned OPFS namespace.

### Public surface

default `ScopedOPFSCache`; support check and get/set/delete APIs.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Keys/limits/corruption handling normalized; storage errors mixed. Transport: OPFS + AppDataScope. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ScopedOPFSCache.js';

console.log(Object.keys(module));
```

## ScreenCapture.js

### Overview

Captures a display surface as image, video, or GIF with explicit lifecycle events.

### Public surface

default `ScreenCapture`; acquire/capture/start/stop/reset methods.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** State/events normalized; permission and codec errors mixed. Transport: getDisplayMedia, MediaRecorder, canvas, GifEncoder. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ScreenCapture.js';

console.log(Object.keys(module));
```

## SpeechPlayback.js

### Overview

Segments bounded text, queues latest-request speech synthesis, and controls lookahead HTML audio playback.

### Public surface

SpeechPlayback class/default, voice/limit constants, `splitSpeechText()`, playback lifecycle APIs.

Exact exports: `MAX_SPEECH_CHARACTERS`, `MAX_SPEECH_CHUNKS`, `MAX_SPEECH_INPUT`, `PREFERRED_STREAM_SEGMENT`, `SPEECH_VOICE_ALIASES`, `SPEECH_VOICE_OPTIONS`, `SpeechPlayback`, `default`, `splitSpeechText`.

### Availability and normalization

**Browser + native bridge.** State/limits normalized; provider/media failures mixed. Transport: Arcane.speech.synthesize, Blob URLs, audio element. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/SpeechPlayback.js';

console.log(Object.keys(module));
```

## StaticDocumentCatalog.js

### Overview

Loads a positive static document inventory with byte/hash verification, cache, search, and bounded context.

### Public surface

default catalog, schema constant, catalog normalizer/cache-key; list/get/search/hydrate/context APIs.

Exact exports: `CATALOG_SCHEMA_VERSION`, `default`, `normalizeStaticDocumentCatalog`, `staticDocumentCacheKey`.

### Availability and normalization

**Browser / native WebView / server with fetch.** Strict catalog/content normalization; transport failures mixed. Transport: HTTP(S), crypto.subtle, optional cache. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/StaticDocumentCatalog.js';

console.log(Object.keys(module));
```

## SystemAppearance.js

### Overview

Reads or applies native appearance, returning an explicit unsupported browser state when no bridge exists.

### Public surface

default `SystemAppearance`; `available()`, `current()`, `apply()`.

Exact exports: `default`.

### Availability and normalization

**Browser/native hybrid.** Absent bridge normalized; native result/error preserved. Transport: Arcane.appearance. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/SystemAppearance.js';

console.log(Object.keys(module));
```

## SystemPlatformPresentation.js

### Overview

Maps kernel names to presentation labels/classes without granting platform authority.

### Public surface

No ESM exports; global `ArcaneSystemPlatformPresentation` with `kernelType()`, `displayName()`, `apply()`.

This is a classic global script and has no ESM exports.

### Availability and normalization

**Browser / native WebView classic script.** Fully normalized presentation only. Transport: DOM. [Deep protocol details](protocols.md).

### Example

```html
<script src="/arcane/modules/SystemPlatformPresentation.js"></script>
```

## SystemToolRegistry.js

### Overview

Registers validated command builders and constructs command strings without executing them.

### Public surface

default registry, `quoteArgument()`, register/list/get/build APIs.

Exact exports: `default`, `quoteArgument`.

### Availability and normalization

**Cross-host.** Fully normalized definitions/quoting. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/SystemToolRegistry.js';

console.log(Object.keys(module));
```

## TerminalClient.js

### Overview

Maps native terminal sessions and Arcane events into an EventTarget client.

### Public surface

default `TerminalClient`; start/write/resize/signal/close/receive/destroy APIs and terminal events.

Exact exports: `default`.

### Availability and normalization

**Native bridge.** Client events/state normalized; native result/error mixed. Transport: Arcane.terminal + Arcane.events. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/TerminalClient.js';

console.log(Object.keys(module));
```

## TerminalCommandRegistry.js

### Overview

Routes parsed command lines to injected handlers and provides definitions/completions.

### Public surface

default registry, `splitCommandLine()`, register/resolve/definitions/completions/execute APIs.

Exact exports: `default`, `splitCommandLine`.

### Availability and normalization

**Cross-host.** Parsing/routing normalized; handler result/error preserved. Transport: Injected handlers. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/TerminalCommandRegistry.js';

console.log(Object.keys(module));
```

## ThemeBootstrap.js

### Overview

Performs import-time Arcane theme loading and subscribes to native appearance changes.

### Public surface

`bootstrapArcaneTheme()`, `arcaneThemeReady`, default ready promise.

Exact exports: `arcaneThemeReady`, `bootstrapArcaneTheme`, `default`.

### Availability and normalization

**Browser/native hybrid.** Theme state normalized; storage/native errors mixed. Transport: ThemeManager + Arcane.events. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ThemeBootstrap.js';

console.log(Object.keys(module));
```

## ThemeManager.js

### Overview

Loads, applies, previews, saves, resets, and synchronizes semantic Arcane themes.

### Public surface

default `ThemeManager`, `loadAndApplyTheme()`; scheme/custom/system APIs and `arcane-theme-change`.

Exact exports: `default`, `loadAndApplyTheme`.

### Availability and normalization

**Browser/native hybrid.** Theme values/events normalized; storage/native failures mixed. Transport: PreferenceStore, DOM, Arcane.appearance. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ThemeManager.js';

console.log(Object.keys(module));
```

## TimeGuard.js

### Overview

Persists and evaluates clock rollback and grace-period state.

### Public surface

default `TimeGuard`; installs `window.timeguard`, emits `time-guard-ready`; clock methods.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Time decisions normalized; storage lifecycle mixed. Transport: User + DBOPFS. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/TimeGuard.js';

console.log(Object.keys(module));
```

## ToolCallRouter.js

### Overview

Parses OpenAI-style tool calls and dispatches complete or streamed calls to injected handlers.

### Public surface

`parseArguments()`, `handleResponse()`, `handleStreamedCalls()`.

Exact exports: `handleResponse`, `handleStreamedCalls`, `parseArguments`.

### Availability and normalization

**Cross-host.** Arguments/routing normalized; handler results returned or all-settled. Transport: Injected handlers. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ToolCallRouter.js';

console.log(Object.keys(module));
```

## uPlot.iife.min.js

### Overview

Vendored uPlot chart constructor and rendering runtime.

### Public surface

No ESM exports; global `uPlot` with data/series/scale/cursor/hook/selection/destroy APIs.

This is a classic global script and has no ESM exports.

### Availability and normalization

**Browser vendor script.** Vendor-native. Transport: Classic script + canvas/DOM. [Deep protocol details](protocols.md).

### Example

```html
<script src="/arcane/modules/uPlot.iife.min.js"></script>
```

## uPlot.LICENSE.txt

### Overview

License companion for the bundled uPlot vendor runtime.

### Public surface

MIT license text.

### Availability and normalization

**Documentation asset.** Not executable. Transport: None. [Deep protocol details](protocols.md).

### Example

```text
/arcane/modules/uPlot.LICENSE.txt
```

## uPlot.min.css

### Overview

Bundled uPlot presentation stylesheet.

### Public surface

Load with a stylesheet link before rendering uPlot charts.

### Availability and normalization

**Browser stylesheet.** Presentation only. Transport: CSS. [Deep protocol details](protocols.md).

### Example

```html
<link rel="stylesheet" href="/arcane/modules/uPlot.min.css">
```

## WaitForComponent.js

### Overview

Waits for a component property, method, or readiness event with optional error event and bounded timeout.

### Public surface

default `waitForComponent()`.

Exact exports: `default`.

### Availability and normalization

**Cross-host EventTarget / browser component.** Normalized coded readiness, error, and timeout results. Transport: EventTarget + timers. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/WaitForComponent.js';

console.log(Object.keys(module));
```

## YouTubeMedia.js

### Overview

Validates YouTube video/playlist locators and constructs privacy-enhanced embed URLs.

### Public surface

`parseYouTubeMedia()`, `youtubeEmbedUrl()`.

Exact exports: `parseYouTubeMedia`, `youtubeEmbedUrl`.

### Availability and normalization

**Cross-host.** Fully normalized. Transport: URL construction only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/YouTubeMedia.js';

console.log(Object.keys(module));
```

## Entity and component continuations

- [Runtime entity modules](runtime-entities.md) explains all 15 modules, and [shared entity contracts](core/arcane-entities.md) owns all 35 exports.
- [Runtime components](runtime-components.md) owns all 39 HTML-import fragments, methods, slots, and events.
- [Arcane Ollama](arcane-ollama.md) expands the raw-versus-normalized behavior of `Ollama.js`.
