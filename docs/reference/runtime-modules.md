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

## Runtime semantic events and teardown

SDK runtime modules publish semantic state and lifecycle occurrences through the
one branded, versioned `globalThis.arcaneEvents` authority in each JavaScript
realm. A class can retain its existing `EventTarget` or `on()` compatibility
surface, but that surface delegates to a `createArcaneEventSource()` view scoped
by the module's source and instance identifiers; it does not own a second event
bus, listener `Map`, or listener `Set`. Every canonical occurrence and every
one-way DOM compatibility projection carries an occurrence ID. DOM input events
remain local UI/platform input, and projected DOM `CustomEvent`s must not be
mirrored back into the canonical source.

`arcaneEvents.subscribe(type,handler,{once,signal})` and source-scoped
`subscribe()`/`on()` registrations return one idempotent unsubscribe function
(also exposed as `.dispose`). The singleton's legacy `on()`/`once()` methods are
chainable compatibility APIs that return the manager; lifecycle-owned consumers
use `subscribe()`. Instance `dispose()`/`destroy()` methods remove owned
listeners, abort owned work, suppress stale settlement, and dispose the instance
source. Module-lifetime singleton sources instead expose a focused module
teardown function where teardown is supported. Event publication is synchronous
and observational; promises, `AbortSignal`, and `createEventQueue` continue to
own asynchronous work, cancellation, and backpressure.

## Canonical inventory

| Module | Kind | Capability | Availability | Normalization |
| --- | --- | --- | --- | --- |
| [`AI.js`](#aijs) | esm | Provider-selectable chat, speech-to-text, text-to-speech, tool calling, structured output, streaming, and queued audio playback. | Browser + native bridge + cloud | High-level chat/speech behavior is normalized; provider diagnostics and media errors remain mixed. |
| [`AIPreferenceRuntime.js`](#aipreferenceruntimejs) | esm | Applies and reads non-persistent per-user AI preference overrides. | Cross-host | Normalized six-slot preference state. |
| [`AIPreferenceTuple.js`](#aipreferencetuplejs) | esm | Normalizes and compares the six provider/model preference slots. | Cross-host | Fully normalized frozen tuple. |
| [`AIProviderRuntime.js`](#aiproviderruntimejs) | esm | Owns provider-neutral selection, lifecycle, routing, startup, requests, streaming, cancellation, and independent LLM/STT/TTS state. | Cross-host runtime; provider-specific availability | Normalized required provider members plus closed route/status contracts, with fail-closed local-only selection and no implicit fallback. |
| [`AIResponseLength.js`](#airesponselengthjs) | esm | Normalizes concise/short/medium/long response preferences and applies the matching system instruction. | Cross-host | Fully normalized string/instruction contract. |
| [`AIResponseURLPolicy.js`](#airesponseurlpolicyjs) | esm | Extracts and audits links from AI Markdown, rendered HTML, CSS, srcset, bare URLs, and email text. | Cross-host | Normalized frozen allowlist audit. |
| [`AIRuntimeState.js`](#airuntimestatejs) | esm | Publishes sticky immutable role snapshots, lifecycle intents, and startup-settlement barriers. | Cross-host state contract | Closed monotonic state records; events report state but grant no authority. |
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
| [`ComponentContracts.js`](#componentcontractsjs) | esm | Owns normalized configuration/value contracts and shared explicit STT activation behavior for chart, dashboard, Markdown, and voice components. | Cross-host | Fully normalized labels, rows, definitions, visibility, formats, editor and voice options, plus capability-neutral STT activation intent and presentation state. |
| [`ConfiguredAIChatSession.js`](#configuredaichatsessionjs) | esm | Owns bounded in-memory AI turns, context construction, response-length instruction, and atomic history commit. | Native bridge by default; cross-host with injected chat | Normalized session/result; provider rejection preserved. |
| [`ConversationActionItems.js`](#conversationactionitemsjs) | esm | Normalizes, creates, updates, remembers, selects, and formats bounded conversation action items. | Cross-host | Fully normalized status/base/presentation contract. |
| [`ConversationClosingReport.js`](#conversationclosingreportjs) | esm | Defines the closing-report tool, instruction, result normalizer, call classifier, and formatter. | Cross-host | Fully normalized report contract. |
| [`ConversationTimebox.js`](#conversationtimeboxjs) | esm | Owns conversation limits, control messages, submission barriers, elapsed formatting, and delivery proof. | Cross-host | Fully normalized state/command/delivery errors. |
| [`CoreLocalModelCatalog.js`](#corelocalmodelcatalogjs) | esm | Projects Core local-AI status into UI-safe admitted model and speech availability catalogs. | Cross-host | Fully normalized descriptors and stable admission labels. |
| [`DataMaintenance.js`](#datamaintenancejs) | esm | Deletes empty chats and associated/empty memory records inside the current app data scope. | Browser / native WebView | Normalized counts; destructive storage failures preserved. |
| [`DBLS.js`](#dblsjs) | esm | Provides app-scoped localStorage tables, batch reads/writes, filtering, deletion, and counts. | Browser / native WebView | Scoped keys and values normalized; storage failures mixed. |
| [`DBOPFS.js`](#dbopfsjs) | esm | Provides app-scoped OPFS tables, worker I/O, backup/restore, compression, and CRUD/batch APIs. | Browser / native WebView | App scope normalized; DOM/storage errors preserved. |
| [`DBOPFSDocumentLibrary.js`](#dbopfsdocumentlibraryjs) | esm | Bootstraps and searches an app-defined DBOPFS corpus and builds explicitly untrusted chat context. | Browser or compatible DBOPFS host | Existing DBOPFS semantics; manifest-last generations and bounded search only after the app calls it or wires its context builder. |
| [`DBOPFSWorker.js`](#dbopfsworkerjs) | worker | Serializes OPFS sync-handle read/write requests from a MessagePort. | Dedicated worker | Responses normalize to `{success,fileData?}` or `{error:{name,message}}`. |
| [`DevelopmentWorkspace.js`](#developmentworkspacejs) | esm | Provides bounded workspace inspection, context, setup task, and Node installer clients without arbitrary command execution. | Native bridge | Inputs normalized; provider result/error preserved. |
| [`DirectoryPicker.js`](#directorypickerjs) | esm | Wraps the provider-owned native directory chooser and normalizes selected/cancelled/error results. | Native bridge | Strict normalized selection and coded errors. |
| [`DocumentLexicalSearch.js`](#documentlexicalsearchjs) | esm | Provides dependency-free deterministic metadata/body ranking and bounded excerpts. | Cross-host | Frozen stable results with no storage, provider, or network side effects. |
| [`DocumentNavigation.js`](#documentnavigationjs) | esm | Binds document navigation, filtering, history, current-item reveal, and load initialization. | Browser / native WebView | Normalized filter/navigation state; DOM effects preserved. |
| [`Errors.js`](#errorsjs) | esm | Normalizes global errors/rejections, fingerprints and deduplicates incidents, persists a ledger, and performs bounded delivery. | Browser / native WebView hybrid | Incident records normalized; storage/mail failures isolated. |
| [`GifEncoder.js`](#gifencoderjs) | esm | Encodes indexed frames into a bounded animated GIF using palette mapping and LZW. | Cross-host | Normalized byte output and bounds. |
| [`HTMLImport.js`](#htmlimportjs) | esm | Defines the same-origin `<html-import>` loader with open shadow root, inline script execution, and readiness/error events. | Browser / native WebView | Public error detail normalized; fetch/DOM failure preserved. |
| [`InMemoryCommunicationProvider.js`](#inmemorycommunicationproviderjs) | esm | Implements deterministic in-memory thread/message/send behavior for demos and tests. | Cross-host | Normalized communication entities. |
| [`IsolatedModelQuestionRunner.js`](#isolatedmodelquestionrunnerjs) | esm | Inspects one exact model and runs one isolated question with proof validation. | Native bridge or injected provider | Strict normalized proof/coded errors. |
| [`LocalAIReadiness.js`](#localaireadinessjs) | esm | Derives selected AI requirements and returns a frozen readiness/recovery report across browser, desktop, and Android modes. | Browser/native hybrid | Fully normalized report and stable error codes; browsers never probe Ollama. |
| [`LocalAIReadinessController.js`](#localaireadinesscontrollerjs) | esm | Coordinates local-AI status component checks, ensured recovery, availability projection, and teardown. | Browser/native hybrid | Normalized controller state and change events. |
| [`Mail.js`](#mailjs) | esm | Builds bounded reports and prefers the native mail capability with an explicit HTTP transport fallback. | Browser/native hybrid + cloud | Mail inputs/results normalized; transport failures mixed. |
| [`MailOutbox.mjs`](#mailoutboxmjs) | esm | Persists bounded mail reports before delivery and normalizes idempotent enqueue, retry, reconciliation, and invalid-record maintenance. | Browser/native WebView or compatible injected host | Frozen records, bounded work, cancellation, and lifecycle states normalized; storage, lock, and delivery failures coded. |
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
| [`PersistentAIChatSession.js`](#persistentaichatsessionjs) | esm | Adds explicit durable history/memory policy to bounded configured chat without changing DBOPFS or ChatEntity semantics. | Browser / native WebView with DBOPFS and configured chat | Live context commits atomically; persistence stays coherent across user/assistant/tool turns. |
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

default `AI`; read-only `providerRuntime`, `browserSpeechConfiguration`, and
`browserSpeechDescriptor`; `configureBrowserSpeech(configuration,{signal})`,
`disposeBrowserSpeech({signal})`, `setAI()`, `configureProviders()`,
`configureSpeechProviders()`, `transitionAI()`, `transitionProviders()`,
`transitionSpeechProviders()`, `startProviders()`, `setSpeechMuted()`,
`streamRequest()`, `streamMessage()`, `fetchRequest()`, `fetch()`,
`streamTTS()`, `finishTTS()`, `fetchTTS()`, `fetchSTT()`, `stopAudio()`, `resumeAudio()`,
`playAudio()`; consumes `user-entity-loaded` and `arcane-ollama-ready`,
installs `window.ai`, and emits `ai-ready`.

The provider-runtime methods keep LLM, STT, and TTS selection explicit. They do
not reinterpret one provider's failure as permission to select another
provider. `transitionAI()` and `transitionProviders()` are deliberate
cross-role transitions: each stops queued audio, unloads the current LLM, STT,
and TTS roles, then applies the replacement configuration. `transitionAI()`
returns aggregate runtime status; `transitionProviders()` returns the admitted
three-role route configuration. Selected `OPENAI` LLM/STT/TTS, `OLLAMA` LLM,
and admitted Core `LOCAL_SPEACH` STT/TTS legacy routes expose truthful
capability-only readiness through internal provider/2 adapters without probing,
downloading, or hiding a load. Cloud speech admission requires the selected
route, its model, a credential, and `fetch`; Core speech admission requires the
exact selected `Arcane.speech.transcribe` or `synthesize` method. `fetchRequest()`
keeps the selected provider's public response shape. Browser speech routes
translate the existing AI.js STT `{audio:Blob|File,mimeType,model}` and TTS
`{model,input,responseFormat,voice?,speed?}` requests at the provider boundary;
only WAV is accepted for the shared TTS result. TTS voice selection comes from
the exact selected provider/model catalog `defaultVoice`; a saved OpenAI voice
is used only by the selected OpenAI adapter and is never forwarded to another
provider route.

`configureSpeechProviders({stt,tts})` commits only the two speech routes and
leaves the current LLM route and sticky lifecycle record unchanged. Both speech
roles must be unloaded and own no request, load, unload, or dispose operation.
`transitionSpeechProviders({stt,tts})` stops queued audio, explicitly unloads
only STT and TTS, then commits that same closed speech route record. Neither
method loads a model, selects a fallback, or changes caller-owned model or voice
policy.

`startProviders({startMuted=true,startTranscription=false,signal=null}={})`
starts text chat without requesting an STT load by default; it does not undo an
already ready or independently loading LLM or STT role. Its default
`startMuted:true` path cancels active TTS work and unloads TTS. Callers must opt
into eager STT startup with `startTranscription:true` or publish the explicit
user activation intent exposed by the shared speech component.
`setSpeechMuted(false)` records the public unmuted state only after the selected
TTS route reaches ready; a failed load leaves the public state muted. In contrast,
`setSpeechMuted(true)` cancels active TTS work and unloads that role.
`fetchTTS({model,voice,input,responseFormat,speed},signal)` accepts the public
provider-neutral synthesis shape, requires any explicit model to match the
admitted route, and admits an omitted voice only from the selected model
catalog's `defaultVoice`. An omitted response format preserves the instance's
existing `audioFormat` for a compatibility-only catalog. When the selected model
declares `speech.responseFormats`, that setting is used only when admitted; if
the setting is the legacy `opus` default and the model rejects it, the catalog's
`speech.defaultResponseFormat` is used, while any other unsupported setting is
rejected. It propagates the caller-owned signal and returns a playable `Blob`;
it does not independently choose a provider, cloud fallback, model, runtime, or
voice policy for the application. Existing `streamTTS()` and `finishTTS()` use
this same request boundary.
`fetchSTT(audioFile,responseHandler,signal)` propagates the caller-owned signal;
provider routes accept a `Blob` or `File` directly and leave media decoding,
PCM normalization, and WAV construction to the selected shared provider;
delivery suppression is guaranteed after abort, while underlying provider-stop
claims remain limited to that provider's cancellation contract.

#### Browser speech configuration

The caller constructs a frozen authority record for one or both roles and
retains ownership of it. This example configures both:

```javascript
import AI, {
  AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL
} from '/arcane/modules/AI.js';

const speechConfiguration = Object.freeze({
  protocol: AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
  id: 'app-speech-authority',
  dbopfs,
  tableName: 'browser-speech-artifacts', // optional
  stt: Object.freeze({
    providerId: 'app-whisper',
    graph: sttGraph,
    security: Object.freeze({secure: true}),
    offline: false
  }),
  tts: Object.freeze({
    providerId: 'app-kokoro',
    graph: ttsGraph,
    security: Object.freeze({secure: true}),
    offline: false
  })
});

const ai = new AI(/* existing application AI preferences */);
const descriptor = await ai.configureBrowserSpeech(
  speechConfiguration,
  {signal}
);

// Configuration does not load either role. Activate only from an explicit UI.
await ai.providerRuntime.load('stt', {signal});
await ai.setSpeechMuted(false); // loads the selected TTS role, then unmutes

// Teardown unloads, unregisters, and disposes only this SDK-owned configuration.
await ai.disposeBrowserSpeech({signal});
```

The record must be a frozen plain data record with exactly
`{protocol,id,dbopfs,tableName?,stt?,tts?}` and at least one role. Each supplied
frozen role is exactly `{providerId,graph,security,offline}` or
`{providerId,model,runtime,security?,offline}`. The graph and direct authority
forms are mutually exclusive; `providerId` and `id` are trimmed 1-128 character
strings, `graph` is the role-matching frozen graph returned by the SDK browser
speech artifact API, graph `security` must explicitly select `secure:true`, and
`offline` is boolean. The direct form forwards its
caller-selected model, runtime, and optional security descriptors to the shared
provider. In warn-first mode it may use an empty `model.files` inventory and a
version-pinned upstream `runtime.wasmPaths`; secure graph mode remains the
closed, content-addressed path. The application chooses every artifact,
immutable graph or direct model/runtime authority, provider ID, offline policy,
sample rate, and TTS default voice. `configureBrowserSpeech()` imports the shared
browser-speech module, creates one DBOPFS store, constructs and registers the
supplied Whisper and/or Kokoro provider/2 instances, atomically replaces only
the supplied STT/TTS routes, and returns a frozen descriptor. An initial or
later call may supply only `stt` or only `tts`; the omitted external Cloud/Core
role remains unchanged and is not claimed as SDK browser-provider ownership.
A partial replacement of an existing browser-managed record retains the same
`dbopfs` and `tableName`, carries every omitted managed browser provider and
route unchanged, and unregisters and disposes only the replaced provider after
commit. Supplying both roles remains one atomic replacement. Applications do not register those
providers, decode `Blob`/`File` data into PCM, construct WAV, select Worker URLs,
or reproduce DBOPFS cache or artifact verification logic.

The returned descriptor is exactly `{protocol,configurationId,stt,tts}`; an
external, unmanaged role is `null`. A managed STT descriptor is
`{role:'stt',providerId,modelId,artifactGraphId?,offline}`; TTS adds
`defaultVoice`. `artifactGraphId` is present only for the graph form.
`browserSpeechConfiguration` returns the exact caller-owned record when no
managed role is carried. After a partial replacement that carries another
managed role, it returns a frozen merged record with the replacement call's
`id` and the carried role's unchanged authority. It is non-null only while the
SDK still owns every represented browser provider and route;
`browserSpeechDescriptor` returns that descriptor on the same condition.
Configuration never loads a role, auto-downloads, selects an alternative
provider/model/runtime/voice, or falls back to cloud/browser speech.

Calling `configureBrowserSpeech()` again with the same active record for every
supplied role is an idempotent descriptor read. A different call is serialized,
aborts the prior owned operation, unloads only the replaced speech roles, atomically
replaces provider ownership/routes, and suppresses stale settlement. A
single-role replacement does not reconstruct, unregister, dispose, or reroute
the omitted role or change its ready/selected state, provider identity,
operation generation, or lifecycle. STT-only replacement also preserves TTS
mute and playback state; TTS replacement invalidates current TTS speech control
before replacing that role. The caller's signal is
forwarded and detached on settlement. Cancellation proves delivery suppression,
not that provider work stopped beyond the provider's own cancellation contract.
Once SDK-owned browser speech is active, synchronous route mutation fails with
`ARCANE_AI_BROWSER_SPEECH_ASYNC_TRANSITION_REQUIRED`; use an asynchronous
transition method or await `disposeBrowserSpeech()`.

Browser speech publishes these exact event values through the AI instance's
canonical event source. Public consumers use
`arcaneEvents.subscribe(type,handler,{signal})`; `handler(occurrence)` receives
the frozen canonical occurrence and can correlate `source:'ai'`, `instanceId`,
and `operationId`:

| Constant member | Stable value |
| --- | --- |
| `configurationStarted` | `ai-browser-speech-configuration-started` |
| `configured` | `ai-browser-speech-configured` |
| `configurationCancelled` | `ai-browser-speech-configuration-cancelled` |
| `configurationError` | `ai-browser-speech-configuration-error` |
| `disposed` | `ai-browser-speech-disposed` |

Canonical public details are frozen and contain `configurationId`, optional
`descriptor`, optional exact `code`, and `reason`. The private source-local
compatibility view also carries the caller-owned configuration and optional
error, but `AI` does not expose that source handle and the global occurrence
does not publish those private values. Reasons are exactly `speech-configuration-added`,
`speech-configuration-replaced`, `speech-configuration-cancelled`,
`speech-configuration-disposed`, `speech-configuration-contract-mismatch`,
`speech-configuration-async-transition-required`,
`speech-operation-options-contract-mismatch`,
`speech-operation-sequence-exhausted`, `speech-module-import-rejected`,
`speech-artifact-store-construction-rejected`,
`speech-provider-construction-rejected`, `speech-provider-disposal-rejected`,
`speech-provider-route-ownership-mismatch`,
`speech-provider-unregistration-rejected`, `speech-route-commit-rejected`,
`speech-route-rollback-rejected`, and `speech-route-view-update-rejected`.
Their corresponding exact public codes are the values of
`AI_BROWSER_SPEECH_ERROR_CODES`: `ARCANE_AI_BROWSER_SPEECH_CONFIGURATION_CANCELLED`,
`ARCANE_AI_BROWSER_SPEECH_CONFIGURATION_SUPERSEDED`,
`ARCANE_AI_BROWSER_SPEECH_CONFIGURATION_CONTRACT_MISMATCH`,
`ARCANE_AI_BROWSER_SPEECH_ASYNC_TRANSITION_REQUIRED`,
`ARCANE_AI_BROWSER_SPEECH_OPERATION_OPTIONS_CONTRACT_MISMATCH`,
`ARCANE_AI_BROWSER_SPEECH_OPERATION_SEQUENCE_EXHAUSTED`,
`ARCANE_AI_BROWSER_SPEECH_MODULE_IMPORT_REJECTED`,
`ARCANE_AI_BROWSER_SPEECH_ARTIFACT_STORE_CONSTRUCTION_REJECTED`,
`ARCANE_AI_BROWSER_SPEECH_PROVIDER_CONSTRUCTION_REJECTED`,
`ARCANE_AI_BROWSER_SPEECH_PROVIDER_DISPOSAL_REJECTED`,
`ARCANE_AI_BROWSER_SPEECH_PROVIDER_ROUTE_OWNERSHIP_MISMATCH`,
`ARCANE_AI_BROWSER_SPEECH_PROVIDER_UNREGISTRATION_REJECTED`,
`ARCANE_AI_BROWSER_SPEECH_ROUTE_COMMIT_REJECTED`,
`ARCANE_AI_BROWSER_SPEECH_ROUTE_ROLLBACK_REJECTED`, and
`ARCANE_AI_BROWSER_SPEECH_ROUTE_VIEW_UPDATE_REJECTED`.

`fetchTTS()` rejects malformed request/signal/input/model/voice/format/speed
boundaries with `ARCANE_AI_TTS_REQUEST_INVALID`,
`ARCANE_AI_TTS_SIGNAL_INVALID`, `ARCANE_AI_TTS_INPUT_INVALID`,
`ARCANE_AI_TTS_MODEL_INVALID`, `ARCANE_AI_TTS_MODEL_REQUIRED`,
`ARCANE_AI_TTS_MODEL_SELECTION_MISMATCH`, `ARCANE_AI_TTS_VOICE_INVALID`,
`ARCANE_AI_TTS_VOICE_REQUIRED`, `ARCANE_AI_TTS_RESPONSE_FORMAT_INVALID`, or
`ARCANE_AI_TTS_SPEED_INVALID`; a non-playable provider result is
`ARCANE_AI_TTS_PROVIDER_AUDIO_INVALID`. `fetchSTT()` uses
`ARCANE_AI_STT_RESPONSE_HANDLER_INVALID`, `ARCANE_AI_STT_SIGNAL_INVALID`, and
`ARCANE_AI_STT_PROVIDER_TRANSCRIPT_INVALID` at those exact boundaries. Owned
request abortion is `ARCANE_AI_REQUEST_ABORTED`.

Exact exports: `AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL`,
`AI_BROWSER_SPEECH_ERROR_CODES`, `AI_BROWSER_SPEECH_EVENT_TYPES`,
`AI_BROWSER_SPEECH_REASONS`, `AI_INITIALIZATION_ERROR_CODES`,
`AI_INITIALIZATION_REASONS`, `AI_READY_EVENT`, and `default`.

### Availability and normalization

**Browser + native bridge + cloud.** High-level chat/speech behavior is
normalized; provider diagnostics and media errors remain mixed. Transport:
AIProviderRuntime `arcane-ai-provider/2` routes, OpenAI HTTPS, Arcane.ollama,
Arcane.speech, and the Android WebView bridge. [Deep protocol details](protocols.md).

### Example

The configuration example above is the minimal one-time application flow.

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

## AIProviderRuntime.js

### Overview

Owns the portable provider-neutral runtime for independently selected LLM,
speech-to-text, and text-to-speech providers. The exported class documents the
shape, but application code uses the exported singleton returned by
`getAIProviderRuntime()`; direct construction fails with
`ARCANE_AI_RUNTIME_SINGLETON_REQUIRED`.

### Public surface

Exact exports: `AI_MODEL_AUTHORITY_PROTOCOL`, `AI_PROVIDER_PROTOCOL`,
`AI_PROVIDER_RUNTIME_PROTOCOL`, `AIProviderRuntime`, `aiProviderRuntime`, and
`getAIProviderRuntime`.

The singleton exposes read-only `protocol`, `configured`, and `speechMuted`;
`register(provider)`; `unregister(role,providerId,expectedProvider=null)`;
`hasProvider(role,providerId)`; `ownsProvider(role,expectedProvider)`;
`providerIdentity(role,providerId)`; `selection(role,options={})`;
`ownsSelection(role,providerId,options={})`;
`validateConfiguration(value)`; `validateSpeechConfiguration(value)`;
`configure(value)`; `configureSpeech(value)`;
`replaceSpeechProvider(role,value)`; `replaceSpeechProviders(value)`;
`configureFromTuple(tuple)`;
`status(role=null)`; `catalog(role)`;
`inspect(role,options={})`; `start(options)`; `load(role,options={})`;
`unload(role,options={})`; `dispose(role,options={})`;
`disposeAll(options={})`; `cancel(role)`; `request(role,options={})`;
`chat(payload,options={})`; `stream(payload,options={})`;
`transcribe(payload,options={})`; `synthesize(payload,options={})`; and
`setSpeechMuted(muted)`. Provider payloads must
be data-only; callbacks, accessors, symbols, cycles, and excessive nesting are
rejected at the provider boundary.

Selection options admit `localOnly=false`; inspection admits
`{localOnly=false,signal=null}`; startup admits
`{startMuted=true,startTranscription=false,signal=null}` (including an omitted
`options` value); load admits `{signal=null,localOnly=false}`; unload, dispose,
and dispose-all admit `{signal=null}`. Request requires the exact
`{operation,payload,localOnly,signal}` options record; the four role-specific
request helpers admit `{localOnly=false,signal=null}`. Configuration `value`
records are the closed `{llm,stt,tts}`, `{stt,tts}`, or
`{provider,routes,expectedProvider}` and
`{providers,routes,expectedProviders}` shapes described below.
`configureFromTuple()` accepts exactly six provider/model preference entries.

`register()` returns the provider's single unregister closure; caller-
registered providers remain caller-owned. The high-level
`AI.configureBrowserSpeech()` boundary is different: AI constructs, registers,
atomically replaces, unregisters, and disposes those two SDK-owned providers.
`status()` is the sticky frozen AIRuntimeState snapshot (or one role record),
while `catalog()` synchronously returns frozen provider/model admissions and
never loads or downloads a model. `load()` forwards provider progress into the
sticky role record; `unload()` and `dispose()` abort owned work, await exposed
settlement, and verify provider status before publishing terminal state.

`validateSpeechConfiguration(value)` returns one frozen two-role selection
record without committing it, where `value` is the closed `{stt,tts}` record.
`configureSpeech(value)` accepts the same record, requires both speech roles to
own no ready/load/unload/dispose or request work, commits only STT/TTS, restores
muted speech admission, and returns the frozen selection record. The current LLM
routes, selection, readiness, operation generation, and sticky state remain
unchanged. A malformed top-level, route, or selection record preserves the
compatibility code
`ARCANE_AI_PROVIDER_RUNTIME_INVALID` and adds exact reason
`speech-configuration-contract-mismatch`; runtime-disposed, reentrant,
role-busy, and provider-locality failures retain their existing exact codes.

`replaceSpeechProvider(role,value)` accepts only `stt` or `tts` and atomically
replaces exactly that unloaded role using the closed
`{provider,routes,expectedProvider}` record. A null `provider` with empty routes
removes that role and requires its exact non-null expected provider. The method preserves the omitted role's
provider registration, routes, selection, readiness, generation, sticky state,
owned lifecycle work, and TTS mute state. `replaceSpeechProviders(value)` keeps
the existing atomic two-role boundary for a coordinated STT/TTS replacement.

`start(options)` waits for prior speech-state and role unload work, applies the
requested initial mute state, and returns the `startAIRuntime()` control handle
`{barrier,settled,cancel}`. Startup does not request selected STT unless the
caller explicitly opts in; it does not force an independently active STT role
back to unloaded. The barrier and settled promises describe provider-startup
readiness; cancellation remains cooperative through the supplied signal and
returned control.

Interactive requests are latest-request-wins per role. A newer valid request
that reaches admission aborts the active request, waits for its provider promise
to settle (or for bounded stream cleanup to be confirmed), and revalidates
ready/loaded/not-busy state before it starts. Rapid intermediate requests are
superseded, and their late results cannot restore or overwrite newer role state.
Promise settlement proves only that the provider's exposed request promise
completed; it does not by itself prove that underlying provider work stopped.
Provider-specific positive cancellation acknowledgement remains
provider-specific. Load and reconfiguration guards stay fail-closed while
request ownership is active.

### Availability and normalization

**Cross-host runtime with provider-specific execution.** The SDK source ships
the browser-WASM LLM and browser Whisper/Kokoro adapters and supplies the
narrow AI.js legacy OpenAI/Ollama/Core-speech adapters; other native, Core, or
cloud adapters may be supplied externally only when they implement the same
`arcane-ai-provider/2` boundary. A
provider must prove a matching `arcane-ai-model-authority/1` inspection before load.
`localOnly` routing fails closed; it never selects a cloud or non-local route as
a fallback. A missing or mismatched explicit local-only route rejects load or
request admission with `AI_LOCAL_MODEL_REQUIRED`. Role lifecycle and stream
cleanup are normalized, while the
selected provider retains its own capability, permission, download, and model
requirements. [Deep protocol details](protocols.md#portable-ai-provider-runtime).

### Example

```javascript
import {getAIProviderRuntime} from '/arcane/modules/AIProviderRuntime.js';

const runtime = getAIProviderRuntime();
console.log(runtime.protocol, runtime.status());
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

## AIRuntimeState.js

### Overview

Publishes one sticky immutable state tree for `llm`, `stt`, and `tts`, transient
load/unload/dispose intents, and a startup-settlement report. It makes lifecycle
observable without exposing provider transports in application code.

### Public surface

Exact exports: `AI_RUNTIME_INTENT_EVENT`, `AI_RUNTIME_PROTOCOL`,
`AI_RUNTIME_ROLES`, `AI_RUNTIME_STARTUP_EVENT`, `AI_RUNTIME_STATES`,
`AI_RUNTIME_STATE_EVENT`, `aiRuntimeEvents`, `getAIRuntimeState`,
`publishAIRuntimeRoleState`, `publishAIRuntimeRolesState`,
`requestAIRuntimeIntent`, `startAIRuntime`, `subscribeAIRuntimeIntents`, and
`subscribeAIRuntimeState`.

Each role record is exactly `{role,state,providerId,modelId,localOnly,loaded,
busy,operationId,progress,error}`.
`subscribeAIRuntimeState(listener,{signal=null,emitCurrent=true})` installs its
subscription and synchronously replays the current frozen snapshot by default;
`subscribeAIRuntimeIntents(listener,{signal=null})` is future-only. Both return
one idempotent unsubscribe/dispose closure. `aiRuntimeEvents` is a deprecated,
state-free EventTarget compatibility view over the same canonical source; it is
not a second authority and owns no listener registry.
`startAIRuntime({startMuted=true,startTranscription=false,signal})` returns
`{barrier,settled,cancel}`: `barrier` settles for text chat, while `settled`
covers every requested role. Muted startup does not request TTS, and STT startup
is opt-in so selection and state observation do not begin a transcription-model
load.

### Availability and normalization

**Cross-host state contract.** States are `unavailable`, `unloaded`, `loading`,
`ready`, `unloading`, `error`, and `disposed`. Revisions increase monotonically.
The events `arcane-ai-runtime-state`, `arcane-ai-runtime-intent`, and
`arcane-ai-runtime-startup-settled` normalize observation only: receiving one
does not grant a native capability, prove browser support, or load a provider.
`arcane-ai-runtime-startup-settled` reports the LLM/text-chat `barrier`.
Await the returned `handle.settled` promise for every role requested by that
startup; the all-role settlement has no separate public event.
Intent records are exactly `{role,action,reason}` where roles are `llm`, `stt`,
or `tts`; actions are `load`, `unload`, or `dispose`; and reasons are `startup`,
`user`, or `teardown`. Invalid closed records fail with the stable prefix
`ARCANE_AI_RUNTIME_STATE_INVALID`; startup cancellation is an `AbortError` with
code `ARCANE_AI_REQUEST_ABORTED`.

### Example

```javascript
import {
  getAIRuntimeState,
  subscribeAIRuntimeState
} from '/arcane/modules/AIRuntimeState.js';

const unsubscribe = subscribeAIRuntimeState(snapshot => {
  console.log(snapshot.roles.llm.state);
});
console.log(getAIRuntimeState().protocol);
unsubscribe();
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

Exact exports: `API_MODEL_ERRORS`, `API_MODEL_EVENTS`, `appendParameters`,
`default`, `publicEndpoint`.

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

Exact exports: `BROWSER_TEST_SUITE_ERROR_CODES`,
`BROWSER_TEST_SUITE_EVENT_TYPES`, `BROWSER_TEST_SUITE_REASONS`,
`assertionError`, `default`, `skipError`.

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

`new CalculatorEngine()` exposes synchronous
`calculate(expression): Calculation`,
`addEventListener(type,listener,options): void`,
`removeEventListener(type,listener,options): void`,
`on(type,listener,options): unsubscribe`,
`dispatchEvent(event): boolean`, and idempotent
`dispose(): boolean` / `destroy(): boolean`. `evaluateExpression(input): number`
remains the parser-only helper. `CALCULATOR_ENGINE_ERROR_CODES` is one frozen
record containing the stable `disposed`, `input`, `syntax`, `domain`, and
`evaluation` codes.

Exact exports: `CALCULATOR_ENGINE_ERROR_CODES`, `default`,
`evaluateExpression`.

### Availability and normalization

**Cross-host.** Each engine owns one `calculator-engine` source on the realm's
branded `globalThis.arcaneEvents`. `calculator-result` publishes frozen public
detail `{result}`; the legacy instance listener receives the same `Calculation`
object returned by `calculate()`. `calculator-error` publishes frozen public
detail `{code}`; the legacy listener receives frozen
`{expression,error}` while `calculate()` rethrows that same `Error`. Both
occurrences carry one source-instance `operationId`. Listener callbacks are
synchronous observations; their failures are reported by the central event
authority and do not rewrite calculation settlement. Listener registration
supports `{once,signal}` and its returned unsubscribe also exposes `.dispose()`.
Disposal removes instance listeners and rejects later calculations with
`ARCANE_CALCULATOR_ENGINE_DISPOSED`. Invalid expression input, syntax, numeric
domain, and unexpected evaluation boundaries use
`ARCANE_CALCULATOR_EXPRESSION_INPUT_INVALID`,
`ARCANE_CALCULATOR_EXPRESSION_SYNTAX_INVALID`,
`ARCANE_CALCULATOR_EXPRESSION_DOMAIN_INVALID`, and
`ARCANE_CALCULATOR_EXPRESSION_EVALUATION_FAILED`. Transport: in-process only.
[Deep protocol details](protocols.md).

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

Exact exports: `COMMUNICATION_APP_CONTROLLER_ERROR_CODES`, `default`.

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

Exact exports: `COMMUNICATION_HUB_ERROR_CODES`, `COMMUNICATION_HUB_EVENTS`,
`COMMUNICATION_HUB_REFRESH_REASONS`, `COMMUNICATION_HUB_REFRESH_STATES`, and
`default`.

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

Owns normalized configuration/value contracts and shared explicit STT activation
behavior for chart, dashboard, Markdown, and voice components.

### Public surface

Constant sets plus normalization, formatting, and explicit STT activation
helpers. `createSTTActivationController({host,button,onChange,EventClass=CustomEvent})`
consumes only normalized
[`AIRuntimeState`](#airuntimestatejs) `stt` role records. Its frozen controller
exposes `action`, `error`, `label`, `pending`, `selected`, `status`, `title`, and
`visible` getters plus `request(action)`, `synchronize(role)`, and `destroy()`.
`host` supplies `dispatchEvent(event)` and `requestSTTActivation(intent)`;
`button` supplies `addEventListener()` and `removeEventListener()`; and
`onChange()` is called whenever presentation should be rendered again. Browser
callers use the default `CustomEvent`; non-DOM callers must inject a compatible
`EventClass` constructor.

`request('load'|'unload')` emits the cancelable
`speech-stt-activation-request` event with frozen `{intent,state}` before it
invokes `host.requestSTTActivation(intent)`. Callback failure emits
`speech-stt-activation-error` with frozen `{request,error,message}`. Syncing
sticky state only changes the controller's observation and presentation; it
never emits a lifecycle intent, chooses a provider, or starts a download.
`destroy()` removes its button listener and suppresses late callback effects.

Exact exports: `CHART_LABELS`, `DASHBOARD_LABELS`, `MARKDOWN_FORMATS`,
`MARKDOWN_LABELS`, `STT_ACTIVATION_ERROR_CODES`,
`STT_ACTIVATION_EVENT_TYPES`, `STT_ACTIVATION_REASONS`, `VOICE_LABELS`,
`VOICE_MESSAGES`, `appendTranscription`, `applyMarkdownFormat`,
`createSTTActivationController`, `effectiveDashboardVisibility`,
`normalizeChartOptions`, `normalizeChartRows`, `normalizeDashboardDefinitions`,
`normalizeDashboardOptions`, `normalizeDashboardVisibility`,
`normalizeMarkdownFormats`, `normalizeMarkdownOptions`, and
`normalizeVoiceOptions`.

### Availability and normalization

**Cross-host with an injected event constructor outside DOM hosts.** Fully
normalized labels, rows, definitions, visibility, formats, editor and voice
options, plus capability-neutral STT activation intent and presentation state.
Provider authority and lifecycle execution remain with the configured runtime
owner. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ComponentContracts.js';

console.log(Object.keys(module));
```

## ConfiguredAIChatSession.js

### Overview

Owns bounded in-memory AI turns, context construction, response-length instruction, and atomic history commit.

### Public surface

default `ConfiguredAIChatSession`; `history()`, `clear()`, `prepare()`, `send()`.

`new ConfiguredAIChatSession(options={})` admits exactly `chat`,
`contextBuilder`, `initialMessages`, `maxContextCharacters`,
`maxMessageCharacters`, `maxMessages`, `request`, `responseLength`, and
`systemPrompt`. `initialMessages` is an array of closed `user`, `assistant`, or
`tool` messages under the same message/context bounds. It excludes `system`,
allows exactly one structural assistant tool call, and requires a matching tool
result before another user turn or tool-call sequence; `systemPrompt` owns the
separate system message.

`prepare(input,{signal})` performs the complete bounded request but does not
commit history immediately. It returns frozen `{response,commit,rollback}`;
exactly one terminal settlement is permitted. `send()` is the convenience path
that prepares and then commits the turn.

An optional async `contextBuilder({input,history,signal})` receives a frozen
request snapshot and the same cancellation signal. Its returned context is
framed as untrusted data for only the current request and is never committed to
history.

An injected `chat(request)` may return the prior normalized session result or
exactly one non-stream OpenAI-compatible choice. The prior form preserves its
explicit `done` boolean; OpenAI-compatible choice normalization sets
`done:true`. Both return frozen
`{provider,model,message:{role:'assistant',content,tool_calls?},done,
doneReason,promptEvalCount,evalCount}`. Tool calls remain structural data and
are never executed. When `tool_calls` is present it must contain exactly one
valid structural call. A malformed response fails `AI_CHAT_INVALID_RESPONSE`;
caller cancellation is `AbortError` with code `AI_CHAT_ABORTED`. A new user
turn cannot bypass a pending structural tool call
(`AI_CHAT_TOOL_RESULT_REQUIRED`), a mismatched tool result fails
`AI_CHAT_INVALID_TOOL_MESSAGE`, and a second terminal settlement of one
prepared transaction fails `AI_CHAT_TRANSACTION_SETTLED`.

Exact exports: `default`.

### Availability and normalization

**Native bridge by default; cross-host with injected chat.** Normalized session/result; provider rejection preserved. Transport: Arcane.ai.chat or injected provider. [Deep protocol details](protocols.md).

### Example

```javascript
import ConfiguredAIChatSession from '/arcane/modules/ConfiguredAIChatSession.js';

const session = new ConfiguredAIChatSession({
  chat: async request => ({
    provider: 'demo',
    model: 'echo',
    message: {
      role: 'assistant',
      content: `Received ${request.messages.length} messages.`
    }
  })
});
console.log(await session.send('Hello'));
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

Exact exports: `CONVERSATION_TIMEBOX_ERROR_CODES`,
`CONVERSATION_TIMEBOX_EVENT_TYPES`, `CONVERSATION_TIMEBOX_LIMIT_MESSAGE`,
`CONVERSATION_TIMEBOX_OPENING_INSTRUCTION`, `CONVERSATION_TIMEBOX_REASONS`,
`CONVERSATION_TIMEBOX_TOOL_NAME`, `ConversationSubmissionBarrier`,
`appendConversationTimeboxOpeningInstruction`, `consumeConversationTimeboxCall`,
`conversationTimeboxSubmissionKey`, `conversationTimeboxTool`,
`createConversationTimeboxControlMessage`, `default`,
`formatConversationElapsed`, `normalizeConversationTimeboxCommand`, and
`requireConversationTimeboxDelivery`.

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

Exact exports: `DBLS_EVENT_TYPES`, `DBLS_REASONS`, `default`.

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

Exact exports: `DBOPFS_EVENT_TYPES`, `DBOPFS_REASONS`, `default`.

### Availability and normalization

**Browser / native WebView.** App scope normalized; DOM/storage errors preserved. Transport: OPFS, DBOPFSWorker, Compression Streams. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DBOPFS.js';

console.log(Object.keys(module));
```

## DBOPFSDocumentLibrary.js

### Overview

Stores one application-defined document corpus through an existing DBOPFS-style
adapter, searches only a completed generation, and builds bounded context that
is explicitly labeled untrusted. Construction performs no read, write, fetch,
or search; applications call `bootstrap()` deliberately.

### Public surface

Exact exports: `DBOPFSDocumentLibrary`, `createDBOPFSDocumentLibrary`,
`default`, and `normalizeDBOPFSDocumentSchema`.

`new DBOPFSDocumentLibrary({concurrency,db,maxCorpusCharacters,
maxDocumentCharacters,maxSearchCharacters,schema})` exposes `schema`,
`bootstrap({files,onProgress,read,readFailurePolicy,signal})`,
`search(query,{kinds,limit,signal,tags})`,
`evaluate(query,{sources,read,maxCharacters,maxCorpusCharacters,
maxScoringCharacters,maxDocumentCharacters?,kinds?,tags?,readFailurePolicy?,
onProgress?,signal?})`,
`buildContext(query,{limit,maxCharacters,maxDocumentCharacters,signal})`, and
`createContextBuilder({limit,maxCharacters,maxDocumentCharacters})`.

`evaluate()` requires `sources`, `read`, `maxCharacters`,
`maxCorpusCharacters`, and `maxScoringCharacters`. It filters source metadata
before calling
`read(source,{maxCharacters,maxCorpusCharacters,ordinal,signal})`, never accepts a
source body as implicit authority, and never persists a caller-owned body.
`maxDocumentCharacters` defaults to the smaller instance/output bound.

### Availability and normalization

**Browser or compatible host with an injected DBOPFS adapter.** The adapter
keeps the existing `get`, `set`, `getAllKeys`, and `delete` method names; Node
can use the same class only through an explicitly imported runtime module and a
compatible storage adapter; SDK `0.3.0` publishes no Node package subpath or
Node storage implementation for it. Bootstrap uses a bounded concurrent
generation, commits its manifest last, cleans partial data on failure, and
rejects case-colliding IDs. Search
returns `{failures,matches,total}` so one corrupt record does not become a false
complete result. `bootstrap()` defaults to rejecting read failure; the explicit
`readFailurePolicy:'preserve-readable'` mode returns partial-success
`readCoverage`. `evaluate()` also defaults to rejecting a source-read failure;
its explicit `preserve-readable` mode instead ranks the readable records and
returns partial `failures` plus `coverage` in the evaluation result (not
bootstrap's `readCoverage`). It reads a caller-owned source list without
persisting its bodies and returns frozen `{authority:'sources',characters,
coverage,documents,failures,limits,query,scoringTruncated,text,truncated}`.
Read failure remains `DBOPFS_DOCUMENT_READ_FAILED`; invalid public input uses
`DBOPFS_DOCUMENT_INVALID`, invalid integer budgets use
`DBOPFS_DOCUMENT_INVALID_LIMIT`, and a preserved read failure without a usable
source code is reported as `failures[].code:'DBOPFS_DOCUMENT_ERROR'`.
Cancellation is `AbortError` with code `DBOPFS_DOCUMENT_ABORTED`. Construction
does not search.
When an application explicitly supplies the library's context builder, each
prepared chat send performs that bounded retrieval.

### Example

```javascript
import {
  createDBOPFSDocumentLibrary
} from '/arcane/modules/DBOPFSDocumentLibrary.js';

const documents = createDBOPFSDocumentLibrary({
  db: globalThis.dbopfs,
  schema: {id: 'help', version: '1', table: 'help_documents'}
});
async function replaceHelpCorpusAfterUserChoice() {
  await documents.bootstrap({files: [{
    id: 'welcome',
    path: 'welcome.md',
    title: 'Welcome',
    body: 'Arcane applications are portable.'
  }]});
  console.log(await documents.search('portable'));

  const preview = await documents.evaluate('portable', {
    sources: [{id:'draft', path:'draft.md', title:'Draft'}],
    read: async source => source.id === 'draft' ? 'Portable app notes.' : '',
    maxCharacters: 2048,
    maxCorpusCharacters: 4096,
    maxDocumentCharacters: 512,
    maxScoringCharacters: 512
  });
  console.log(preview.coverage, preview.text);
}
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

## DocumentLexicalSearch.js

### Overview

Provides deterministic, dependency-free metadata/body ranking and bounded
context excerpts for caller-owned document records.

### Public surface

Exact exports: `DOCUMENT_SEARCH_FIELD_ORDER`, `DocumentLexicalSearch`,
`createDocumentLexicalIndex`, `default`, `documentContextExcerpt`,
`documentSearchTokens`, `normalizedDocumentSearchText`, `scoreDocumentBody`,
and `scoreDocumentLexicalIndex`.

`new DocumentLexicalSearch(records,{maxResults=20})` exposes
`rank(query,{kinds,tags})` and `search(query,{kinds,limit,tags})`.

### Availability and normalization

**Cross-host.** Indexing and search are in-process only. Text, tags, kinds,
scores, field ordering, truncation, and tie-breaking are normalized into frozen
records. This module performs no storage, network, model, Core, or DOM action.
The caller decides whether a result is merely displayed or explicitly injected
as untrusted AI context.

### Example

```javascript
import DocumentLexicalSearch from '/arcane/modules/DocumentLexicalSearch.js';

const search = new DocumentLexicalSearch([{
  id: 'welcome',
  path: 'welcome.md',
  title: 'Welcome',
  body: 'Arcane applications are portable.',
  kind: 'guide',
  tags: ['intro']
}]);
console.log(search.search('portable', {limit: 5}));
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

Exact exports: `GLOBAL_ERROR_EVENT_CODES`, `GLOBAL_ERROR_EVENT_TYPES`,
`GLOBAL_ERROR_REASONS`, `default`, `fingerprintIncident`,
`normalizeErrorEvent`, and `normalizeRejectionEvent`.

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

Exact exports: `LOCAL_AI_READINESS_CONTROLLER_ERROR_CODES`,
`LOCAL_AI_READINESS_CONTROLLER_EVENT_TYPES`,
`LOCAL_AI_READINESS_CONTROLLER_REASONS`, `availabilityFromReport`, and
`createLocalAIReadinessController`.

### Availability and normalization

`availabilityFromReport()` returns `true` only for a slot whose local
requirement is explicitly `required:true` and whose report is explicitly
`ready:true`. Missing and non-local-required slots remain false: this projection
does not attest provider registration, selection, credentials, browser speech
authority, or model load state. Components must preserve selected sticky
`AIRuntimeState` roles as the readiness authority.

**Browser/native hybrid.** Normalized controller state and change events.
Transport: LocalAIReadiness + component events. [Deep protocol details](protocols.md).

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

## MailOutbox.mjs

### Overview

Persists each bounded provider-neutral mail report before delivery and owns its
idempotent enqueue, FIFO drain, retry-window, terminal-state, reconciliation,
and explicit invalid-record maintenance lifecycle. It selects no mail provider,
recipient, retention policy, retry timer, or transport fallback.

### Public surface

Exact exports: `MAIL_OUTBOX_ACCEPTANCE_AUTHORITIES`,
`MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS`, `MAIL_OUTBOX_PROTOCOL`,
`MAIL_OUTBOX_STATES`, `MAIL_OUTBOX_TABLE`, `MailOutbox`, `createMailOutbox`, and
`default`.

```text
new MailOutbox({
  storage,
  deliver,
  clock=Date.now,
  isOnline=()=>globalThis.navigator?.onLine!==false,
  lockManager=undefined,
  onlineTarget=typeof globalThis.addEventListener==='function'?globalThis:null,
  onRecordCommitted=null,
  maxAttemptsPerDrain=16,
  maxInvalidRecords=128,
  maxRecords=512,
  maxReportBytes=786432,
  quarantineTable='mail_outbox_quarantine',
  table=MAIL_OUTBOX_TABLE
}={})
```

`storage` must expose `get()`, `set()`, and `getAllKeys()`; explicit deletion or
quarantine additionally requires `delete()`. `lockManager` must expose the Web
Locks-compatible `request()` contract. The injected
`deliver({report,reportKey,serializedReport,signal})` callback receives the
frozen parsed report, its stable idempotency key, the exact stored JSON string,
and the caller-owned signal. Omitted `lockManager` resolves first from storage
and then from `navigator.locks`. A delivery result must identify a valid
`requestId` and one of `accepted`, `delivery_uncertain`,
`temporarily_rejected`, `permanently_rejected`, or `partially_accepted`;
accepted results additionally require a provider ID or the admitted
`arcane-core-mail-send-v1` acceptance authority.

Read-only getters are `started`, `invalidRecords`, and `lastBackgroundError`.
Methods are `get(key)`, `list()`, `audit()`, `deleteInvalid(fileName)`,
`repairInvalid(fileName,replacement)`,
`quarantineInvalid({limit=64}={})`,
`enqueue({report,reportKey}={}, {attempt=true,signal=null}={})`,
`drain({reason='manual',signal=null}={})`, `start({signal=null}={})`, and
`stop()`. `createMailOutbox(options)` returns `new MailOutbox(options)`.

Every returned durable record is deeply frozen and contains exactly
`{protocol,reportKey,serializedReport,state,createdAt,updatedAt,firstAttemptAt,
lastAttemptAt,nextAttemptAt,attempts,result,failure}`. Protocol is
`arcane-mail-outbox/1`; the default table is `mail_outbox`; the idempotency
window is 86,400,000 milliseconds. States are exactly `queued`, `sending`,
`retry_wait`, `accepted`, `failed`, and `reconciliation_required`. Accepted
means provider or admitted Core acceptance, not inbox delivery.

`enqueue()` serializes same-instance persistence and binds one report key to one
exact serialized body. `drain()` runs or joins one bounded instance drain under
an exclusive shared lock and attempts at most 16 records by default. Startup,
an owned `online` listener, or an explicit call may trigger work; there is no
polling or retry timer. Abort before the delivery call prevents that call, and a
caller joining an existing drain may stop waiting without cancelling the shared
drain. Once an accepted result is committed, it outranks a racing cancellation;
cancellation never claims an admitted provider attempt stopped. An interrupted
or ambiguous attempt remains a same-key retry inside the 24-hour window and
becomes `reconciliation_required` when automatic retry would risk a duplicate.
`stop()` aborts only the owned online drain, removes its listener, preserves
durable records, and returns the instance.

`audit()` reports valid records plus bounded invalid-file metadata. Repair,
deletion, and quarantine are explicit, revalidate the selected file under the
table lock, and never infer destructive authority from a storage read failure.
`onRecordCommitted(record)` is an observational callback after each durable
write; callback failure cannot change the committed operation result.

### Availability and normalization

**Browser/native WebView or compatible injected host.** The default application
integration uses DBOPFS-compatible durable storage and `navigator.locks`; an
alternate adapter owns its own durability claim and must provide equivalent
storage and shared-lock semantics. Frozen records, bounds, state transitions,
retry/reconciliation classification, invalid-record maintenance, and
AbortSignal admission/join cancellation are normalized. Storage, lock,
online-check, and injected-delivery failures remain visible through concrete
`MAIL_OUTBOX_*` codes. Transport: injected durable storage, Web Locks,
AbortSignal, optional online EventTarget, and an injected delivery callback.
[Deep protocol details](mail.md#durable-send-semantics).

### Example

```javascript
import {createMailOutbox} from '/arcane/modules/MailOutbox.mjs';

const outbox = createMailOutbox({storage, deliver});
await outbox.start({signal});
const record = await outbox.enqueue(
  {report, reportKey: 'report-20260827-001'},
  {attempt: true, signal}
);
console.log(record.state);
outbox.stop();
```

## MailTransport.mjs

### Overview

Sends one bounded mail report to a normalized HTTP(S) endpoint with timeout and response-size limits.

### Public surface

Timeout/size constants, `MailTransportError`, `normalizeMailEndpoint()`,
`serializeMailReport()`, and `sendMailReport()`.

Exact exports: `DEFAULT_MAIL_REQUEST_TIMEOUT_MS`, `MAX_MAIL_RESPONSE_BYTES`,
`MailTransportError`, `normalizeMailEndpoint`, `serializeMailReport`,
`sendMailReport`.

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

Exact exports: `OLLAMA_EVENT_TYPES`, `OLLAMA_REASONS`, `Ollama`, `default`,
and `ollama`.

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

Exact exports: `OPEN_METEO_ENDPOINTS`, `OPEN_METEO_WEATHER_ERRORS`,
`OPEN_METEO_WEATHER_EVENTS`, `default`, and `mapForecast`.

### Availability and normalization

**Browser / native WebView / server with fetch + cloud.** Provider data normalized to entities; transport errors mixed. Transport: Open-Meteo HTTPS. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/OpenMeteoWeatherProvider.js';

console.log(Object.keys(module));
```

## PersistentAIChatSession.js

### Overview

Composes `ConfiguredAIChatSession` with one `ChatEntity` so every user,
assistant, and structural tool-result turn has an explicit durable-persistence
choice. It preserves the existing DBOPFS method names and ChatEntity memory
semantics; it does not define a new storage protocol.

### Public surface

Exact exports: `PersistentAIChatSession`, `createPersistentAIChatSession`, and
`default`.

Constructor and factory options are `{chat,chatEntity,chatFileName,
contextBuilder,loadExisting,maxContextCharacters,maxMessageCharacters,
maxMessages,memory,request,responseLength,systemPrompt}`. Public members are
static `create()`, getters `chatEntity` and `fileName`, and `ready()`,
`history()`, `settleMemory()`, and `send(input)`.
`ready()` waits for initialization and resolves the same session instance.

`send()` accepts `{message:{content,role:'user'|'tool',tool_call_id?,persist},
response:{persist},signal?}`. Message and response persistence must match.
`persist:false` still commits the coherent turn to live bounded model context,
but not to durable ChatEntity history or memory. A structural tool result must
use the persistence choice captured by its matching assistant tool call.

### Availability and normalization

**Browser or native WebView with ChatEntity/DBOPFS and a configured chat
function.** The default chat calls normalized `Arcane.ai.chat()`; callers can
inject the browser-WASM controller, another provider-neutral adapter, or a
cloud chat function. There is no automatic provider or storage fallback.
Context builders are request-only, and document context remains explicitly
untrusted. Errors include `AI_CHAT_BUSY`, `AI_CHAT_TOOL_RESULT_REQUIRED`,
`AI_CHAT_INVALID_TOOL_MESSAGE`, and `AI_CHAT_INCOHERENT_PERSISTENCE`.

### Example

```javascript
import {
  createPersistentAIChatSession
} from '/arcane/modules/PersistentAIChatSession.js';

async function sendPersistentSupportTurnAfterUserChoice(documents) {
  const session = await createPersistentAIChatSession({
    chatFileName: 'support.jsonl',
    loadExisting: true,
    contextBuilder: documents.createContextBuilder()
  });
  const response = await session.send({
    message: {role: 'user', content: 'Summarize the documents.', persist: true},
    response: {persist: true}
  });
  console.log(response.message.content);
}
```

## PreferenceStore.js

### Overview

Loads and updates schema-defined app preferences through native storage with a narrow browser fallback.

### Public surface

default `PreferenceStore`, re-exported `Preference`/schema; load/set/reset APIs and events.

Exact exports: `PREFERENCE_STORE_ERROR_CODES`,
`PREFERENCE_STORE_EVENT_TYPES`, `Preference`, `default`, and
`preferenceSchema`.

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

Exact exports: `RECORD_REVIEW_STORE_ERROR_CODES`,
`RECORD_REVIEW_STORE_EVENT_TYPES`, `default`, `normalizeRecordId`, and
`normalizeReview`.

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

Exact exports: `SCREEN_CAPTURE_ERROR_CODES`, `SCREEN_CAPTURE_ERRORS`,
`SCREEN_CAPTURE_EVENT_TYPES`, `SCREEN_CAPTURE_IMAGE_TYPE_FALLBACK`,
`SCREEN_CAPTURE_REASONS`, `SCREEN_CAPTURE_STATUSES`, and `default`.

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

`SpeechPlayback` class/default, voice/limit compatibility constants,
`SPEECH_PLAYBACK_STATE_EVENT`, `splitSpeechText()`, and playback lifecycle APIs.

Exact exports: `MAX_SPEECH_CHARACTERS`, `MAX_SPEECH_CHUNKS`,
`MAX_SPEECH_INPUT`, `PREFERRED_STREAM_SEGMENT`, `SPEECH_PLAYBACK_STATE_EVENT`,
`SPEECH_VOICE_ALIASES`, `SPEECH_VOICE_OPTIONS`, `SpeechPlayback`, `default`,
and `splitSpeechText`.

```text
new SpeechPlayback({
  audio,
  speech=globalThis.Arcane?.speech,
  model=null,
  voice=null,
  responseFormat=null,
  speed=1,
  onState=()=>{},
  createObjectURL,
  revokeObjectURL,
  delay,
  messages={}
})
```

`speech` must expose either `fetchTTS(payload, signal)` or
`synthesize(payload, {signal})`. `prepare({key,parts,model,voice,responseFormat,
speed,autoplay=true})` uses only caller-supplied model, voice, and response-format
values; those three omitted values remain omitted so the selected AI/model
catalog may admit its documented defaults. Speed defaults to `1`, is normalized
as a positive number, and is always sent. The legacy voice constants remain
exported for compatibility but are not selected by the class. There is no
hard-coded model, response format, voice, or cloud/browser fallback.

Every preparation owns an operation ID and one AbortController for each active
synthesis segment or playback delay. Replacement,
`stop()`, `cancel()`, and `destroy()` abort their owned signals, suppress stale
settlement, release Blob URLs, and publish synchronous
`speech-playback-state` occurrences through `globalThis.arcaneEvents` before
calling the compatibility `onState(frozenDetail)` callback. The detail contains
`state`, `message`, `key`, `index`, `total`, `producing`, `buffered`, `hasAudio`,
`operationId`, `code`, and `reason`; the canonical public occurrence omits
provider response/error bodies. `destroy()` also removes every audio listener
and disposes its per-instance canonical source handle; repeated destroy returns
`false`. Signal abortion proves delivery suppression; whether provider work
actually stops remains the selected provider's cancellation boundary.

Stable error codes are `ARCANE_SPEECH_PLAYBACK_DESTROYED`,
`ARCANE_SPEECH_PLAYBACK_OPERATION_SEQUENCE_EXHAUSTED`,
`ARCANE_SPEECH_PLAYBACK_SYNTHESIZER_UNAVAILABLE`,
`ARCANE_SPEECH_PLAYBACK_SYNTHESIZED_AUDIO_CONTRACT_MISMATCH`,
`ARCANE_SPEECH_PLAYBACK_AUDIO_PLAYBACK_REJECTED`,
`ARCANE_SPEECH_PLAYBACK_REQUEST_CONTRACT_MISMATCH`, and
`ARCANE_SPEECH_PLAYBACK_SYNTHESIS_REQUEST_REJECTED`, plus propagated
`ARCANE_AI_OPERATION_SUPERSEDED` and `ARCANE_AI_REQUEST_ABORTED`.
Exact lifecycle reasons are `playback-replaced`, `playback-stopped`,
`playback-destroyed`, `speech-playback-cancelled`,
`speech-synthesis-superseded`, `speech-synthesis-cancelled`,
`speech-synthesizer-unavailable`, `synthesized-audio-contract-mismatch`,
`audio-playback-rejected`, `audio-autoplay-rejected`,
`speech-playback-request-contract-mismatch`, and
`speech-synthesis-rejected`, as applicable to the emitted state.

### Availability and normalization

**Browser + admitted AI/native bridge.** State, cancellation, lifecycle, and
playable Blob normalization are shared. Provider/model/runtime/voice admission
remains caller- and catalog-owned. Transport: `AI.fetchTTS`, compatible
`Arcane.speech.synthesize`, Blob URLs, audio element, and the singleton event
authority. [Deep protocol details](protocols.md).

### Example

```javascript
import SpeechPlayback from '/arcane/modules/SpeechPlayback.js';

const audio = document.body.appendChild(document.createElement('audio'));
audio.controls = true;
const speech = new SpeechPlayback({
  audio,
  speech: globalThis.ai,
  model: 'caller-selected-model',
  voice: 'caller-selected-voice',
  responseFormat: 'wav'
});
const speakButton = document.body.appendChild(document.createElement('button'));
speakButton.type = 'button';
speakButton.textContent = 'Speak';
speakButton.addEventListener('click', async () => {
  await speech.prepare({
    key: 'ready',
    parts: ['Arcane is ready.'],
    autoplay: true
  });
});
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

Exact exports: `TERMINAL_CLIENT_ERROR_CODES`, `TERMINAL_CLIENT_EVENT_TYPES`,
`TERMINAL_CLIENT_REASONS`, and `default`.

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

Exact exports: `arcaneThemeReady`, `bootstrapArcaneTheme`, `default`, and
`disposeArcaneThemeBootstrap`.

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

Exact exports: `COMPONENT_WAIT_ERROR_CODES`, `COMPONENT_WAIT_REASONS`, and
`default`.

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
