# Arcane runtime module catalog

Every file shipped under `runtime/arcane/modules/` appears here. Start with the capability and example; expand into [protocol and host architecture](protocols.md) only when transport detail matters.

Apps import renderer ESM from `/arcane/modules/<file>`. Classic scripts, the OPFS worker, uPlot stylesheet, and vendor license are called out explicitly. Importing a module does not grant a native capability.

## Availability shorthand

- **Cross-host** means in-process logic built from standard JavaScript/Web APIs.
- **Browser / native WebView** means DOM, storage, media, or component behavior available in a browser renderer and in supported native WebViews.
- **Native bridge** means the module requires an available `globalThis.Arcane` method.
- **Hybrid** means one public helper deliberately selects a documented native or browser/provider path.
- **Cloud** means the module can call an explicitly configured remote provider; it never implies automatic local-to-cloud fallback.
- **Node**, **worker**, and **vendor** identify specialized runtimes.

## Runtime semantic events and teardown

SDK runtime modules publish semantic state and lifecycle occurrences through the
one branded, versioned `globalThis.arcaneEvents` authority in each JavaScript
realm. A class can retain its existing `EventTarget` or `on()` listener surface,
but that surface delegates to a `createArcaneEventSource()` view scoped
by the module's source and instance identifiers; it does not own a second event
bus, listener `Map`, or listener `Set`. Every canonical occurrence and every
one-way DOM projection carries an occurrence ID. DOM input events
remain local UI/platform input, and projected DOM `CustomEvent`s must not be
mirrored back into the canonical source.

`arcaneEvents.subscribe(type,handler,{once,signal})` and source-scoped
`subscribe()`/`on()` registrations return one idempotent unsubscribe function
(also exposed as `.dispose`). The singleton's convenience `on()`/`once()` methods are
chainable listener APIs that return the manager; lifecycle-owned consumers
use `subscribe()`. Instance `dispose()`/`destroy()` methods remove owned
listeners, abort owned work, suppress stale settlement, and dispose the instance
source. Module-lifetime singleton sources instead expose a focused module
teardown function where teardown is supported. Event publication is synchronous
and observational; promises, `AbortSignal`, and `createEventQueue` continue to
own asynchronous work, cancellation, and backpressure.

## Canonical inventory

| Module | Kind | Capability | Availability | Normalization |
| --- | --- | --- | --- | --- |
| [`AI.js`](#aijs) | esm | Provider-selectable chat, speech-to-text, text-to-speech, tool calling, structured output, streaming, bounded synthesis, and ordered audio-clock playback. | Browser + native bridge + cloud | High-level chat/speech behavior and active TTS operation failures are normalized; provider diagnostics remain mixed. |
| [`AIPreferenceRuntime.js`](#aipreferenceruntimejs) | esm | Applies and reads non-persistent per-user AI preference overrides. | Cross-host | Normalized six-slot preference state. |
| [`AIPreferenceTuple.js`](#aipreferencetuplejs) | esm | Normalizes and compares the six provider/model preference slots. | Cross-host | Fully normalized frozen tuple. |
| [`AIProviderRuntime.js`](#aiproviderruntimejs) | esm | Owns provider-neutral selection, lifecycle, routing, startup, requests, streaming, cancellation, and independent LLM/STT/TTS state. | Cross-host runtime; provider-specific availability | Normalized required provider members plus route/status contracts, with explicit local-only selection and no implicit fallback. |
| [`AIResponseLength.js`](#airesponselengthjs) | esm | Normalizes current low/medium/high response-preference selectors while preserving complete prompts. | Cross-host | Current selector normalization; prompt content remains unchanged. |
| [`AIResponseURLPolicy.js`](#airesponseurlpolicyjs) | esm | Extracts and audits links from AI Markdown, rendered HTML, CSS, srcset, bare URLs, and email text. | Cross-host | Normalized frozen allowlist audit. |
| [`AIRuntimeState.js`](#airuntimestatejs) | esm | Publishes sticky mutable role snapshots, lifecycle intents, and startup-settlement barriers. | Cross-host state contract | Closed monotonic state records; events report state but grant no authority. |
| [`AnsiText.js`](#ansitextjs) | esm | Parses terminal ANSI sequences into display spans or strips them to plain text. | Cross-host | Normalized text/span output. |
| [`ApiModelDatabase.js`](#apimodeldatabasejs) | esm | Fetches an injectable HTTP JSON model with parser, cache, redacted public endpoint records, and request lifecycle events. | Browser / native WebView / server with fetch | Request records are normalized; fetch/provider failures remain mixed. |
| [`AppDataScope.js`](#appdatascopejs) | esm | Reconciles declared and native application identity and scopes OPFS/localStorage ownership fail-closed. | Browser / native WebView hybrid | Strict normalized identifiers and coded mismatch failures. |
| [`AppearancePreferences.js`](#appearancepreferencesjs) | esm | Defines, stores, and applies color scheme, density, reduced motion, and large-text preferences. | Browser / native WebView hybrid | Normalized values; storage/host failures remain mixed. |
| [`ArcaneCommunicationBridge.js`](#arcanecommunicationbridgejs) | esm | Maps provider HTTP threads/messages/connect/disconnect endpoints to normalized communication entities. | Browser / native WebView / server with fetch | Entity results are normalized; provider/transport failures remain mixed. |
| [`ArcaneNavigationPolicy.js`](#arcanenavigationpolicyjs) | esm | Creates an HTTP(S) navigation guard with explicit secure-mode domain and CIDR policy decisions. | Cross-host | Complete mutable decisions; ordinary mode warns and continues, while explicitly selected `secure: true` fails closed. |
| [`ArcaneNetworkPolicy.js`](#arcanenetworkpolicyjs) | esm | Validates the Arcane domain/network deny policy and matches domain, IPv4/IPv6 CIDR, protocol, and port rules. | Cross-host | Strict coded normalization. |
| [`AsyncBoundary.js`](#asyncboundaryjs) | esm | Runs one asynchronous operation with timeout, abort, result validation, and stable boundary errors. | Cross-host | Fully normalized timeout/abort errors. |
| [`BrowserTestSuite.js`](#browsertestsuitejs) | esm | Runs a complete sequential browser test list with explicit cancellation and full-detail lifecycle events. | Browser / standard Web APIs | Mutable results and skip/assertion errors normalized without suite-created caps or timers. |
| [`CalculatorEngine.js`](#calculatorenginejs) | esm | Evaluates arithmetic, powers, constants, and common functions without `eval`. | Cross-host | Normalized `Calculation` result and parser errors. |
| [`ChartLibrary.js`](#chartlibraryjs) | esm | Loads the bundled uPlot classic script once and returns its global constructor. | Browser / native WebView | Load state/errors normalized; uPlot result is vendor-native. |
| [`ChatRecords.js`](#chatrecordsjs) | esm | Detects conversation entries and projects retained state into recurring provider context. | Cross-host | Boolean entry results and recurring context are normalized. |
| [`CommunicationAppController.js`](#communicationappcontrollerjs) | esm | Binds shared inbox, conversation, settings, theme, and provider workflows into one UI controller. | Browser / native WebView hybrid | Controller state normalized; provider/DOM failures mixed. |
| [`CommunicationHub.js`](#communicationhubjs) | esm | Fans out provider refresh/send operations and aggregates normalized threads/messages. | Cross-host with injected providers | Normalized aggregates; refresh contains per-provider failures. |
| [`CommunicationPreferences.js`](#communicationpreferencesjs) | esm | Stores app-scoped, non-secret communication provider preferences. | Browser / native WebView hybrid | Normalized preference record; storage failures mixed. |
| [`CommunicationProviderRegistry.js`](#communicationproviderregistryjs) | esm | Registers and queries validated provider definitions, channels, and required methods. | Cross-host | Strict normalized registry. |
| [`ComponentContracts.js`](#componentcontractsjs) | esm | Owns normalized configuration/value contracts and shared explicit STT activation behavior for chart, dashboard, Markdown, and voice components. | Cross-host | Fully normalized labels, rows, definitions, visibility, formats, editor and voice options, plus capability-neutral STT activation intent and presentation state. Complete finite progress measures remain visible, including fractional and over-total values. |
| [`ConfiguredAIChatSession.js`](#configuredaichatsessionjs) | esm | Owns ordinary visible recurring AI turns, one active structural continuation, context construction, provider-response preservation, and atomic history commit. | Native bridge by default; cross-host with injected chat | Normalized session/result; provider rejection preserved. |
| [`ConversationActionItems.js`](#conversationactionitemsjs) | esm | Normalizes, creates, updates, remembers, selects, and formats complete conversation action items. | Cross-host | Fully normalized status/base/presentation contract. |
| [`ConversationClosingReport.js`](#conversationclosingreportjs) | esm | Defines the closing-report tool, instruction, result normalizer, call classifier, and formatter. | Cross-host | Fully normalized report contract. |
| [`ConversationTimebox.js`](#conversationtimeboxjs) | esm | Owns conversation limits, control messages, submission barriers, elapsed formatting, and delivery proof. | Cross-host | Fully normalized state/command/delivery errors. |
| [`CoreLocalModelCatalog.js`](#corelocalmodelcatalogjs) | esm | Projects Core local-AI status into UI-safe model and speech availability catalogs. | Cross-host | Fully normalized descriptors and stable availability labels. |
| [`DataMaintenance.js`](#datamaintenancejs) | esm | Deletes empty chats and associated/empty memory records inside the current app data scope. | Browser / native WebView | Normalized counts; destructive storage failures preserved. |
| [`DBLS.js`](#dblsjs) | esm | Provides app-scoped localStorage tables, batch reads/writes, filtering, deletion, and counts. | Browser / native WebView | Scoped keys and values normalized; storage failures mixed. |
| [`DBOPFS.js`](#dbopfsjs) | esm | Provides app-scoped OPFS tables, worker I/O, backup/restore, compression, and CRUD/batch APIs. | Browser / native WebView | App scope and recognized file parsing normalized; nonblank unreadable JSONL rows and DOM/storage errors are preserved. |
| [`DBOPFSDocumentLibrary.js`](#dbopfsdocumentlibraryjs) | esm | Bootstraps and searches an app-defined DBOPFS corpus and builds complete chat context. | Browser or compatible DBOPFS host | Existing DBOPFS semantics; generation completion and complete search only after the app calls it or wires its context builder. |
| [`DBOPFSWorker.js`](#dbopfsworkerjs) | worker | Serializes OPFS sync-handle read/write requests from a MessagePort. | Dedicated worker | Responses normalize to `{success,fileData?}` or `{error:{name,message}}`. |
| [`DevelopmentWorkspace.js`](#developmentworkspacejs) | esm | Provides complete workspace inspection, context, setup task, and Node installer clients without arbitrary command execution. | Native bridge | Complete plain-text inputs and provider result/error preserved. |
| [`DirectoryPicker.js`](#directorypickerjs) | esm | Wraps the provider-owned native directory chooser and normalizes selected/cancelled/error results. | Native bridge | Complete mutable caller options and provider result fields; coded cancellation and malformed-result errors. |
| [`DocumentLexicalSearch.js`](#documentlexicalsearchjs) | esm | Provides dependency-free deterministic metadata/body ranking and complete excerpts. | Cross-host | Mutable complete results with no storage, provider, or network side effects. |
| [`DocumentNavigation.js`](#documentnavigationjs) | esm | Binds document navigation, filtering, history, current-item reveal, and load initialization. | Browser / native WebView | Normalized filter/navigation state; DOM effects preserved. |
| [`Errors.js`](#errorsjs) | esm | Normalizes global errors/rejections, fingerprints and deduplicates incidents, persists a complete ledger, and performs complete delivery. | Browser / native WebView hybrid | Incident records normalized; storage/mail failures isolated. |
| [`GifEncoder.js`](#gifencoderjs) | esm | Encodes indexed frames into a complete animated GIF using palette mapping and LZW. | Cross-host | Normalized complete binary output. |
| [`HTMLImport.js`](#htmlimportjs) | esm | Defines the same-origin `<html-import>` loader with open shadow root, inline script execution, and readiness/error events. | Browser / native WebView | Public error detail normalized; fetch/DOM failure preserved. |
| [`InMemoryCommunicationProvider.js`](#inmemorycommunicationproviderjs) | esm | Implements deterministic in-memory thread/message/send behavior for demos and tests. | Cross-host | Normalized communication entities. |
| [`IsolatedModelQuestionRunner.js`](#isolatedmodelquestionrunnerjs) | esm | Inspects one selected model and runs one isolated question while preserving the complete answer. | Native bridge or injected provider | Normalized model/result and coded errors. |
| [`LocalAIReadiness.js`](#localaireadinessjs) | esm | Derives selected AI requirements and returns a complete readiness/recovery report across browser, desktop, and Android modes. | Browser/native hybrid | Fully normalized report and stable error codes; browsers never probe Ollama. |
| [`LocalAIReadinessController.js`](#localaireadinesscontrollerjs) | esm | Coordinates local-AI status component checks, ensured recovery, availability projection, and teardown. | Browser/native hybrid | Normalized controller state and change events. |
| [`Mail.js`](#mailjs) | esm | Builds complete reports and prefers the native mail capability with an explicit HTTP transport fallback. | Browser/native hybrid + cloud | Mail inputs/results normalized; transport failures mixed. |
| [`MailOutbox.mjs`](#mailoutboxmjs) | esm | Persists complete mail reports before delivery and normalizes idempotent enqueue, retry, reconciliation, and invalid-record maintenance. | Browser/native WebView or compatible injected host | Complete records, full work, cancellation, and lifecycle states normalized; storage, lock, and delivery failures coded. |
| [`MailTransport.mjs`](#mailtransportmjs) | esm | Sends one complete mail report to a normalized HTTP(S) endpoint. | Browser/server with fetch + cloud | Normalized endpoint and transport errors; remote detail preserved. |
| [`Marked.min.js`](#markedminjs) | esm | Vendored Marked 18.0.5 Markdown lexer, parser, renderer, extension, and walk-token API. | Cross-host vendor module | Vendor-native Marked contract. |
| [`MD.js`](#mdjs) | esm | Renders complete Markdown with Marked and exposes the complete rendered markup. | Browser / native WebView | Complete raw and rendered Marked values; parse errors vendor-native. |
| [`MemoryRecords.js`](#memoryrecordsjs) | esm | Normalizes memory content and detects meaningful stored memory. | Cross-host | Fully normalized string/boolean results. |
| [`MessageAdvisory.js`](#messageadvisoryjs) | esm | Normalizes message content advisories and contains per-message inspection failures. | Cross-host | Normalized advisory records; inspector failures converted to unavailable results. |
| [`ModelDefinition.js`](#modeldefinitionjs) | esm | Parses the deterministic packaged Modelfile subset and extracts the SYSTEM prompt. | Cross-host | Complete mutable definition with coded malformed-input errors. |
| [`Ollama.js`](#ollamajs) | esm | Provides the first-class Arcane Ollama client without direct access to localhost:11434. | Native bridge | Principal methods preserve provider-native envelopes; readiness/text/unload helpers normalize. |
| [`OllamaModelIdentifier.js`](#ollamamodelidentifierjs) | esm | Validates and canonicalizes the syntax of Ollama model identifiers without granting model admission. | Cross-host | Fully normalized string/boolean result. |
| [`OllamaSettings.js`](#ollamasettingsjs) | esm | Defines complete runtime/service preference schemas and deterministic Arcane brain alias names. | Cross-host | Fully normalized settings/name contract. |
| [`OpenMeteoWeatherProvider.js`](#openmeteoweatherproviderjs) | esm | Searches and loads Open-Meteo data into complete mutable Arcane weather entities. | Browser / native WebView / server with fetch + cloud | Provider data normalized to mutable entities; transport errors mixed. |
| [`PersistentAIChatSession.js`](#persistentaichatsessionjs) | esm | Adds explicit retained-history/memory policy to complete configured chat without changing DBOPFS or ChatEntity semantics. | Browser / native WebView with DBOPFS and configured chat | Retained context commits atomically; `persist:false` turns are one-operation-only. |
| [`PreferenceStore.js`](#preferencestorejs) | esm | Loads and updates schema-defined app preferences through native storage with a narrow browser fallback. | Browser/native hybrid | Complete ordinary values remain mutable; setAll uses one optional atomic adapter batch for every selected value when advertised, otherwise performs complete ordered serial writes, and only exact unsupported native capability changes future operations to the browser fallback. |
| [`QRCode.min.js`](#qrcodeminjs) | classic-script | Vendored QRCode generator for DOM, canvas, SVG, and image output. | Browser vendor script | Vendor-native. |
| [`Questionnaire.js`](#questionnairejs) | esm | Evaluates whether a one-time questionnaire prompt is due without performing the prompt. | Cross-host | Normalized conservative boolean. |
| [`RecordLinkIndex.js`](#recordlinkindexjs) | esm | Parses record links and builds their normalized index. | Cross-host | Fully normalized. |
| [`RecordPassageIndex.js`](#recordpassageindexjs) | esm | Indexes text lines, page markers, dates, rules, and excerpts for record review. | Cross-host | Fully normalized. |
| [`RecordReviewStore.js`](#recordreviewstorejs) | esm | Stores normalized record-review decisions through native storage or app-scoped local fallback. | Browser/native hybrid | Complete records preserved; unreadable stored content fails observably. |
| [`RiskSignalAnalyzer.js`](#risksignalanalyzerjs) | esm | Matches configured risk signals and levels against complete text. | Cross-host | Fully normalized. |
| [`ScamRiskPolicy.js`](#scamriskpolicyjs) | esm | Combines deterministic scam signals with optional Arcane blocked-domain evidence and safety guidance. | Cross-host | Complete mutable results; blocked-domain policy requires `secure:true`. |
| [`ScopedOPFSCache.js`](#scopedopfscachejs) | esm | Provides a narrow exact-key JSON cache inside one app-owned OPFS namespace. | Browser / native WebView | Filename-safe keys, complete JSON values, and malformed-cache cleanup normalized; storage errors mixed. |
| [`ScreenCapture.js`](#screencapturejs) | esm | Captures a display surface as image, video, or GIF with explicit lifecycle events. | Browser / native WebView | State/events normalized; permission and codec errors mixed. |
| [`SpeechPlayback.js`](#speechplaybackjs) | esm | Preserves exact nonblank text as one speech segment, queues latest-request synthesis, and controls lookahead HTML audio playback. | Browser + native bridge | Exact input text and state normalized; provider/media failures mixed. |
| [`StaticDocumentCatalog.js`](#staticdocumentcatalogjs) | esm | Loads a positive static document inventory with cache, search, and complete context. | Browser / native WebView / server with fetch | Mutable complete catalog/content normalization; malformed data and transport failures remain visible. |
| [`SystemAppearance.js`](#systemappearancejs) | esm | Reads or applies native appearance, returning an explicit unsupported browser state when no bridge exists. | Browser/native hybrid | Absent bridge normalized; native result/error preserved. |
| [`SystemPlatformPresentation.js`](#systemplatformpresentationjs) | classic-script | Maps kernel names to presentation labels/classes without granting platform authority. | Browser / native WebView classic script | Fully normalized presentation only. |
| [`SystemToolRegistry.js`](#systemtoolregistryjs) | esm | Registers validated command builders and constructs command strings without executing them. | Cross-host | Fully normalized definitions/quoting. |
| [`TerminalClient.js`](#terminalclientjs) | esm | Maps native terminal sessions and Arcane events into an EventTarget client. | Native bridge | Client events/state normalized; native result/error mixed. |
| [`TerminalCommandRegistry.js`](#terminalcommandregistryjs) | esm | Routes parsed command lines to injected handlers and provides definitions/completions. | Cross-host | Parsing/routing normalized; handler result/error preserved. |
| [`ThemeBootstrap.js`](#themebootstrapjs) | esm | Performs import-time Arcane theme loading and subscribes to native appearance changes. | Browser/native hybrid | Theme state normalized; storage/native errors mixed. |
| [`ThemeManager.js`](#thememanagerjs) | esm | Loads, applies, previews, saves, resets, and synchronizes semantic Arcane themes. | Browser/native hybrid | Theme values/events normalized; storage/native failures mixed. |
| [`TimeGuard.js`](#timeguardjs) | esm | Persists and evaluates clock rollback and grace-period state. | Browser / native WebView | Time decisions normalized; storage lifecycle mixed. |
| [`ToolCallRouter.js`](#toolcallrouterjs) | esm | Parses OpenAI-style tool calls and dispatches complete or streamed calls to injected handlers. | Cross-host | Argument records validated; handler results returned or all-settled. |
| [`uPlot.iife.min.js`](#uplotiifeminjs) | classic-script | Vendored uPlot chart constructor and rendering runtime. | Browser vendor script | Vendor-native. |
| [`uPlot.LICENSE.txt`](#uplotlicensetxt) | license | License companion for the bundled uPlot vendor runtime. | Documentation asset | Not executable. |
| [`uPlot.min.css`](#uplotmincss) | stylesheet | Bundled uPlot presentation stylesheet. | Browser stylesheet | Presentation only. |
| [`WaitForComponent.js`](#waitforcomponentjs) | esm | Waits for a component property, method, or readiness event with optional error event and bounded timeout. | Cross-host EventTarget / browser component | Normalized coded readiness, error, and timeout results. |
| [`YouTubeMedia.js`](#youtubemediajs) | esm | Parses YouTube video/playlist locators and constructs ordinary embed URLs with opt-in privacy enhancement. | Cross-host | Fully normalized mutable locators. |

## AI.js

### Overview

Provider-selectable chat, speech-to-text, text-to-speech, tool calling,
structured output, streaming, bounded synthesis, and ordered audio-clock
playback.

### Public surface

default `AI`; read-only `providerRuntime`, `browserSpeechConfiguration`, and
`browserSpeechDescriptor`; `configureBrowserSpeech(configuration,{signal})`,
`disposeBrowserSpeech({signal})`, `setAI()`, `configureProviders()`,
`configureSpeechProviders()`, `transitionAI()`, `transitionProviders()`,
`transitionSpeechProviders()`, `startProviders()`, `setSpeechMuted()`,
`streamRequest()`, `streamMessage()`, `fetchRequest()`, `fetch()`,
read-only `ttsSegmentation`, `configureTTSSegmentation()`,
`streamTTS(text='',end=false,options={})`,
`finishTTS()`, `fetchTTS()`, `fetchSTT()`, `stopAudio()`, `resumeAudio()`,
`playAudio()`; consumes `user-entity-loaded` and `arcane-ollama-ready`,
installs `window.ai`, and emits `ai-ready` and `ai-tts-failure`.

`fetch(...)` and `fetchRequest(options)` are asynchronous complete-response
entry points. `streamMessage(...)` and `streamRequest(options)` deliver
incremental responses. The positional and object forms share the existing
provider implementations; neither form is a retired compatibility API.

Initialization uses the canonical realm user's actual readiness state. If
`window.user?.ready` is already true, AI initializes immediately. Otherwise one
shared registration observes `user-entity-loaded`, then rechecks readiness
after registration so an event that occurred between the initial check and the
subscription cannot strand initialization. Source event projections do
not need to preserve object identity with `window.user`; the event only prompts
the readiness recheck. This boundary uses no timer or polling fallback.

The provider-runtime methods keep LLM, STT, and TTS selection explicit. They do
not reinterpret one provider's failure as permission to select another
provider. `transitionAI()` and `transitionProviders()` are deliberate
cross-role transitions: each stops queued audio, unloads the current LLM, STT,
and TTS roles, then applies the replacement configuration. `transitionAI()`
returns aggregate runtime status; `transitionProviders()` returns the configured
three-role route configuration. Selected TWiN Cloud `TWIN` LLM, `OLLAMA` LLM,
and Core `LOCAL_SPEACH` STT/TTS built-in routes expose truthful capability-only
readiness through internal provider/2 adapters without probing, downloading, or
hiding a load. Configured `OPENAI` speech preferences migrate to on-device
`LOCAL_SPEACH`, with Whisper for STT and Kokoro for TTS. TWiN Cloud availability
requires the selected LLM route, its model, a credential, and `fetch`; Core speech
availability requires the exact selected `Arcane.speech.transcribe` or
`synthesize` method. `fetchRequest()`
keeps the selected provider's public response shape. Browser speech routes
translate the existing AI.js STT `{audio:Blob|File,mimeType,model}` and TTS
`{model,input,responseFormat,voice?,speed?}` requests at the provider boundary;
only WAV is accepted for the shared TTS result. TTS voice selection comes from
the exact selected local provider/model catalog `defaultVoice`; a saved
OpenAI-route voice is never forwarded to another provider route.

The TWiN Cloud built-in provider and default-model preference sentinel are
`TWIN`. Applications upgrading saved `OPENAI` LLM selections must explicitly
replace only the exact uppercase `OPENAI` value in tuple slot 0 (LLM provider)
and slot 3 (default-model sentinel) with `TWIN`, before importing `AI.js` or any module that imports it,
hydrating a ready `window.user`, applying saved preferences, or starting
providers. Importing `AI.js` can immediately consume a ready user's saved tuple.
Keep every other tuple value unchanged.
The SDK supplies no built-in alias and does not rewrite persisted preferences.
Preserve `openai-gpt-oss-120b`, `openai-gpt-oss-20b`, OpenAI-compatible wire
terminology, and the separate Core `provider:'openai'` contract. See the
[complete migration example](ai/twin-cloud.md).

`fetchRequest()` and `streamRequest()` accept `reasoningEffort` as a
provider-neutral request option. Its exact values are `none`, `low`, `medium`,
`high`, and `max`; an omitted value leaves the provider default unchanged.
TWiN Cloud translates the selected value to the DigitalOcean Serverless
Inference `reasoning_effort` field. Its default model remains
`openai-gpt-oss-120b`, while an explicitly selected `openai-gpt-oss-20b` is
preserved. Reasoning effort does not alter complete streaming data, structural
tool declarations, emitted tool calls, or callback ordering.

`configureSpeechProviders({stt,tts})` commits only the two speech routes and
leaves the current LLM route and sticky lifecycle record unchanged. Both speech
roles must be unloaded, use local-only selections, and own no request, load,
unload, or dispose operation. Non-local STT and TTS selections reject with
`AI_STT_DEVICE_ONLY` and `AI_TTS_DEVICE_ONLY`, respectively.
`transitionSpeechProviders({stt,tts})` stops queued audio, explicitly unloads
only STT and TTS, then commits that same closed speech route record. Neither
method loads a model, selects a fallback, or changes caller-owned model or voice
policy.

`startProviders({startLanguageModel=true,startMuted=true,startTranscription=false,signal=null}={})`
starts provider-owned text chat without requesting an STT load by default.
Callers selecting a browser-WASM LLM pass `startLanguageModel:false` so it
remains selected and unloaded until the user uses the shared chat activation
control or the application publishes an equivalent explicit user load intent.
The default preserves startup behavior for existing Cloud/Core routes. Startup
does not undo an already ready or independently loading LLM or STT role. Its default
`startMuted:true` path cancels active TTS work and unloads TTS. Callers must opt
into eager STT startup with `startTranscription:true` or publish the explicit
user activation intent exposed by the shared speech component.
`setSpeechMuted(false)` records the public unmuted state only after the selected
TTS route reaches ready; a failed load leaves the public state muted. In contrast,
`setSpeechMuted(true)` cancels active TTS work and unloads that role.
The optional browser-speech `tts.execution` record selects
`device:'auto'|'webgpu'|'wasm'` and a `maxConcurrentRequests` integer from 1
through 4. Omission uses GPU-first automatic selection with four bounded Kokoro
Worker/session slots; STT remains one WASM Worker.
Capacity 4 means up to four segments synthesize at once. Segment 5 and later
wait in the SDK's FIFO queue; they are not dropped. Synthesis may finish out
of order, but playback waits for earlier segments and plays exact input order.
Each slot owns a Worker/model session, so raising capacity trades memory for
latency. This capacity does not establish physical GPU kernel overlap.

After configuration, explicitly inspect execution through
`ai.providerRuntime.status('tts', {execution:true}).execution`. When supplied
by the selected provider, this read returns its execution snapshot. Kokoro
reports `requestedDevice`, `selectedDevice`, `maxConcurrentRequests`, and
`activeRequestCount`. `selectedDevice` is `null` before load and after unload.
`requestedDevice === 'auto' && selectedDevice === 'wasm'` identifies automatic
WASM fallback after a successful load. Calling `status()` without options keeps
the existing sticky lifecycle snapshot and does not inspect provider execution.
Provider inspection failures are surfaced to the caller.
`fetchTTS({model,voice,input,responseFormat,speed},signal)` accepts the public
provider-neutral synthesis shape, requires any explicit model to match the
selected route, and fills an omitted voice only from the selected model
catalog's `defaultVoice`. An omitted response format preserves the instance's
existing `audioFormat` when the catalog does not declare response formats. When
the selected model declares `speech.responseFormats`, that setting is used only when supported; if
the setting is the instance's `opus` default and the model rejects it, the catalog's
`speech.defaultResponseFormat` is used, while any other unsupported setting is
rejected. It propagates the caller-owned signal and returns a playable `Blob`;
it does not independently choose a provider, cloud fallback, model, runtime, or
voice policy for the application. `streamTTS(text='',end=false,options={})` and
`finishTTS()` use this same request boundary. The third-argument options below
are available in current `main` source and are not yet published:

| Field | Default | Meaning |
| --- | --- | --- |
| `voice` | Current selected model's default voice | A supplied voice is captured for every segment extracted by this call and forwarded unchanged to `fetchTTS()`. It does not change the instance or provider default. |
| `speed` | Current `ai.voiceSpeed` | A supplied positive speed is captured for those segments and forwarded to `fetchTTS()`. It does not change `ai.voiceSpeed`. |
| `pauseAfterMs` | `0` | Finite, nonnegative milliseconds placed after the final extracted segment on the existing audio clock. Invalid values throw `RangeError`; no pause is inserted between this call's other segments. |
| `waitForPlayback` | `false` | Omission retains the preparation promise. With `true`, the promise resolves after every extracted segment reaches a terminal playback state: `true` when all naturally end, or `false` after terminal cancellation or failure. |

The voice and speed use the existing `fetchTTS()` validation and error path.
No option rewrites the submitted text. Overrides belong to the segments
extracted in that invocation, including any text buffered by an earlier call.
Options are not retained with an unfinished `end:false` remainder; a later
call supplies its own options, and `finishTTS()` uses defaults. Use `end:true`
for a complete passage. A call extracting no segments resolves
`true` without waiting for earlier jobs; `finishTTS()` remains a preparation
flush, not a queue-wide playback barrier. A muted call resolves `false`.

Playback completion stays pending while the browser waits for an audio-unlock
gesture or a recoverable resume attempt. If resuming a closed `AudioContext`
fails, the affected jobs terminate and their playback results settle `false`.
`stopAudio()` cancels all speech owned
by this AI instance and settles pending playback promises `false`. A trailing
pause delays the next queued audio; the preceding promise resolves when its
last audio buffer ends, without waiting out that pause. Completion describes
the playback lifecycle, not proof that a listener heard the sound. See the
[complete-passage example](ai/browser-speech.md#queue-complete-passages-and-wait-for-playback).

Streaming speech retains sentence
segmentation by default. `configureTTSSegmentation({punctuation,wordCadence})`
accepts `punctuation:'sentence'|'any'|'none'` and a `wordCadence` that is either
`null` or a positive integer. `punctuation:'any'` completes a segment at a
Unicode punctuation run without requiring following whitespace. Apostrophes,
commas, and hyphens remain inside a segment when they join Unicode letters or
numbers. A potentially joining mark at the current end of an incremental stream
waits for the next character or terminal flush before the boundary is decided;
`wordCadence` completes one after that many whole words. The earliest available
boundary wins. Segmentation preserves every character, including punctuation
and whitespace. Every completed segment enters synthesis immediately; provider
capacity supplies FIFO backpressure while allowing bounded TTS work to overlap.
A later segment may finish synthesis first, but playback schedules only the
contiguous ready prefix in original order. Decoded buffers with known duration
are placed consecutively on the `AudioContext` clock, so callback latency does
not add a seam between ready chunks. A genuine synthesis underrun begins the
next buffer at the current audio time. Mute, stop, provider transition, and
cancellation retain authority over the complete queue and already scheduled
sources.
Every active-generation, non-abort synthesis, decode, playback-start, or
playback-resume failure emits `ai-tts-failure` with the complete `Error`, exact
operation boundary, generation, and stable reason. Muting, explicit
cancellation, permission waiting, and superseded generations do not emit a
failure. The operation event does not rewrite provider readiness; the consuming
Chat/Speech surface owns its visible mute and recovery state.
`fetchSTT(audioFile,signal)` propagates the caller-owned signal;
provider routes accept a `Blob` or `File` directly and leave media decoding,
PCM normalization, and WAV construction to the selected shared provider;
delivery suppression is guaranteed after abort, while underlying provider-stop
claims remain limited to that provider's cancellation contract.

Every function declaration accepted by the chat and streaming APIs must define
`function.parameters.properties.message` as a string with `minLength:1` and
include `message` in the declaration's `required` list. Every emitted structural
call must preserve its exact nonempty `id`, function name, and JSON argument
string; that JSON must encode an object with a nonempty user-facing `message`.
The message is ordinary progress or next-step text. Complete argument envelopes
remain available to an explicitly opened inspection surface or developer
console, but are not substituted for conversational text. A visible call is
still pending until a matching `role:'tool'` message records an executed,
declined, cancelled, or not-executed result.
That tool-result content must be a nonblank string and is preserved exactly.

`streamRequest()` owns the complete terminal callback sequence. `onDataChunk`
receives each complete provider chunk before ordinary projection, while
`onChunk` receives every nonstructural content or reasoning value from every
choice in provider order. After the stream settles, `onDataResult` receives the
complete terminal completion, `onResponse` receives that same unprojected
provider response, `onToolCall` runs exactly once for each complete normalized
structural call, and `onComplete` receives the application-facing output. That
output is the ordered structural-call array when the selected result contains
tools, the complete completion object when it contains multiple choices, or
the ordinary single-result text/completion otherwise; later choices are never
discarded.
Partial structural deltas remain private until the matching terminal envelope
validates. Request observers receive
`onRequest(request,id,metadata)` and any transport metadata supplied by the
selected route is forwarded unchanged. Every async native, HTTP, provider, and
built-in callback is observed before the next callback or terminal settlement.

Native Ollama responses are adapted before the shared structural validator:
provider-native calls may omit `id` and `type` or provide object arguments, so
the adapter assigns a deterministic request-local call ID when needed, sets
`type:'function'`, and JSON-encodes complete object arguments. This adaptation
never invents the required user-facing `arguments.message`. Every response
choice is scanned; a structural call outside the selected result or a streamed
call that changes or disappears at terminal settlement is rejected with
`AI_CHAT_STREAM_TOOL_CALL_MISMATCH` before public tool-call delivery.

#### Browser speech configuration

The caller constructs a mutable authority record for one or both roles and
retains ownership of it. Start with the [complete beginner speech example](ai/browser-speech.md)
to define your DBOPFS, runtime, model, and voice selections. In this advanced
example, `applicationSpeech` is the application-supplied object containing its
`dbopfs`, `sttGraph`, and `ttsGraph`; every other variable is defined below.

```javascript
import AI, {
  AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL
} from '/arcane/modules/AI.js';

const {dbopfs, sttGraph, ttsGraph} = applicationSpeech;
const controller = new AbortController();
const signal = controller.signal;
const speechConfiguration = {
  protocol: AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
  id: 'app-speech-authority',
  dbopfs,
  tableName: 'browser-speech-artifacts', // optional
  stt: {
    providerId: 'app-whisper',
    graph: sttGraph,
    offline: false
  },
  tts: {
    providerId: 'app-kokoro',
    graph: ttsGraph,
    offline: false,
    execution: {
      device: 'auto',
      maxConcurrentRequests: 4
    }
  }
};

const ai = new AI();
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

The record is a mutable plain data record with exactly
`{protocol,id,dbopfs,tableName?,stt?,tts?}` and at least one role. Each supplied
mutable STT role is exactly `{providerId,graph,security?,offline}` or
`{providerId,model,runtime,security?,offline}`. TTS accepts the corresponding
shape plus optional `execution:{device,maxConcurrentRequests}`. The graph and
direct authority forms are mutually exclusive; `providerId` and `id` are nonblank exact strings,
`graph` is the role-matching graph returned by the SDK browser
speech artifact API, and `offline` is boolean. The direct form forwards its
caller-selected model and runtime descriptors to the shared
provider. In ordinary mode it may use an empty `model.files` inventory and a
caller-selected upstream `runtime.wasmPaths`. The application
chooses every artifact, graph or direct model/runtime authority, provider ID, offline policy,
sample rate, and TTS default voice. `configureBrowserSpeech()` imports the shared
browser-speech module, creates one DBOPFS store, constructs and registers the
supplied Whisper and/or Kokoro provider/2 instances, atomically replaces only
the supplied STT/TTS routes, and returns a mutable descriptor. An initial or
later call may supply only `stt` or only `tts`; the omitted unmanaged or Core
role remains unchanged and is not claimed as SDK browser-provider ownership.
A partial replacement of an existing browser-managed record retains the same
`dbopfs` and `tableName`, carries every omitted managed browser provider and
route unchanged, and unregisters and disposes only the replaced provider after
commit. Supplying both roles remains one atomic replacement. Applications do not register those
providers, decode `Blob`/`File` data into PCM, construct WAV, select Worker URLs,
or reproduce DBOPFS cache logic.

The returned descriptor is exactly `{protocol,configurationId,stt,tts}`; an
external, unmanaged role is `null`. A managed STT descriptor is
`{role:'stt',providerId,modelId,artifactGraphId?,offline}`; TTS adds
`defaultVoice` and the normalized `execution` record. `artifactGraphId` is present only for the graph form.
`browserSpeechConfiguration` returns the exact caller-owned record when no
managed role is carried. After a partial replacement that carries another
managed role, it returns a mutable merged record with the replacement call's
`id` and the carried role's unchanged authority. It is non-null only while the
SDK still owns every represented browser provider and route;
`browserSpeechDescriptor` returns that descriptor on the same condition.
Configuration never loads a role, auto-downloads, selects an alternative
provider/model/runtime/voice, or falls back to an unmanaged or alternative
browser-speech route.

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
the mutable complete canonical occurrence and can correlate `source:'ai'`, `instanceId`,
and `operationId`:

| Constant member | Stable value |
| --- | --- |
| `configurationStarted` | `ai-browser-speech-configuration-started` |
| `configured` | `ai-browser-speech-configured` |
| `configurationCancelled` | `ai-browser-speech-configuration-cancelled` |
| `configurationError` | `ai-browser-speech-configuration-error` |
| `disposed` | `ai-browser-speech-disposed` |

Canonical public details are mutable and contain `configurationId`, optional
`descriptor`, optional exact `code`, and `reason`. The private source-local
view also carries the caller-owned configuration and optional
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
`ARCANE_AI_STT_SIGNAL_INVALID` and `ARCANE_AI_STT_PROVIDER_TRANSCRIPT_INVALID`
at those exact boundaries. Owned
request abortion is `ARCANE_AI_REQUEST_ABORTED`.

Exact exports: `AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL`,
`AI_BROWSER_SPEECH_ERROR_CODES`, `AI_BROWSER_SPEECH_EVENT_TYPES`,
`AI_BROWSER_SPEECH_REASONS`, `AI_INITIALIZATION_ERROR_CODES`,
`AI_INITIALIZATION_REASONS`, `AI_READY_EVENT`, and `default`.

### Availability and normalization

**Browser + native bridge + TWiN Cloud.** High-level chat/speech behavior is
normalized; provider diagnostics and media errors remain mixed. Transport:
AIProviderRuntime `arcane-ai-provider/2` routes, TWiN Cloud HTTPS, Arcane.ollama,
Arcane.speech, and the Android WebView bridge. [Deep protocol details](protocols.md).

### Example

This function sends one TWiN request. `applicationRuntime` is the one
application-supplied argument: it provides a runtime `twinKey`. Call the
function from your application's send action; do not commit a key in source.

```javascript
import AI from '/arcane/modules/AI.js';

async function sayHello(applicationRuntime) {
    const ai = new AI();
    ai.twinKey = applicationRuntime.twinKey;
    try {
        const response = await ai.fetchRequest(
            {
                messages: [{role: 'user', content: 'Hello!'}]
            }
        );
        console.log(JSON.stringify(response, null, 2));
    } catch (error) {
        console.error(error.code, error.message);
    }
}
```

For on-device TTS, use the [browser speech quick start](ai/browser-speech.md).

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
`status(role=null,options={})`; `catalog(role)`;
`inspect(role,options={})`; `start(options)`; `load(role,options={})`;
`unload(role,options={})`; `dispose(role,options={})`;
`disposeAll(options={})`; `cancel(role)`; `request(role,options={})`;
`chat(payload,options={})`; `stream(payload,options={})`;
`transcribe(payload,options={})`; `synthesize(payload,options={})`; and
`setSpeechMuted(muted)`. Provider payloads must be data-only; callbacks,
accessors, symbols, and cycles are rejected at the provider boundary.

Selection options admit `localOnly=false`; inspection admits
`{localOnly=false,signal=null}`; startup admits
`{startLanguageModel=true,startMuted=true,startTranscription=false,signal=null}` (including an omitted
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
`status()` is the sticky mutable AIRuntimeState snapshot (or one role record),
while `catalog()` synchronously returns mutable provider/model entries and
never loads or downloads a model. `load()` forwards provider progress into the
sticky role record; `unload()` and `dispose()` abort owned work, await exposed
settlement, and verify provider status before publishing terminal state.

`status('tts', {execution:true})` explicitly reads the selected provider and
adds its optional `execution` snapshot to a copy of the role record.
`status(null, {execution:true})` provides the equivalent projection under
`roles.llm`, `roles.stt`, and `roles.tts`. Providers that do not supply execution
omit that field. No provider load or sticky-state event is triggered; default
`status()` keeps its existing identity and behavior. A provider inspection
error propagates. Kokoro's execution contains `requestedDevice`,
`selectedDevice` (`null` while unloaded), `maxConcurrentRequests`, and
`activeRequestCount`; these describe provider execution, not physical GPU
kernel overlap.

`validateSpeechConfiguration(value)` returns one mutable two-role selection
record without committing it, where `value` is the closed `{stt,tts}` record.
`configureSpeech(value)` accepts the same record, requires both speech roles to
own no ready/load/unload/dispose or request work, commits only STT/TTS, restores
muted speech selection, and returns the mutable selection record. The current LLM
routes, selection, readiness, operation generation, and sticky state remain
unchanged. A malformed top-level, route, or selection record preserves the
current error code
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
Either replacement may replace a selected-but-unregistered pending speech
placeholder whose saved locality is still `null`. Every existing pending route
must agree with that saved placeholder; the replacement provider and routes
then define the actual selected provider and model. Registration and route
publication remain one commit without loading either provider; an already
registered, local-only, busy, or partially divergent selection rejects without
changing either role.

`start(options)` waits for prior speech-state and role unload work, applies the
requested initial mute state, and returns the `startAIRuntime()` control handle
`{barrier,settled,cancel}`. With `startLanguageModel:false`, startup does not
request the selected LLM and its barrier may therefore resolve with `chatReady:false` and
`roles.llm.requested:false` while the explicit activation UI remains available.
Startup does not request selected STT unless the caller explicitly opts in; it
does not force an independently active STT role back to unloaded. The barrier
and settled promises describe only requested provider-startup work;
cancellation remains cooperative through the supplied signal and returned
control.

Interactive requests enter a FIFO lane per role. Providers omit
`maxConcurrentRequests` to retain capacity 1. A TTS provider may declare a
positive safe-integer capacity; the runtime starts that many oldest requests
and retains later work in FIFO order. LLM and STT remain capacity 1. A newer
request does not abort or discard earlier work. A caller `AbortSignal` cancels
only its own queued or active request, while `cancel(role)` targets the oldest
active request. Explicit unload and dispose reject queued work, cancel every
active request, await settlement, and then clean the provider. Load and
configuration remain unavailable while that role owns active or queued request
work. Promise settlement proves only that the provider's exposed request promise
completed; provider-specific cancellation acknowledgement remains the selected
provider's boundary.

Direct LLM `request()`, `chat()`, and `stream()` use the same message history,
tool-declaration, emitted-call, all-choice, and ordered parallel-call contracts
as the high-level AI API module, including one nonblank matching result for
every pending tool-call ID. A complete text-only terminal string remains
compatible; structured terminals must use exactly one message or choices
envelope. An ordinary stream iterator exposes complete nonstructural content
and reasoning projections from every choice in FIFO order; provider-native
tool deltas remain private until the complete terminal result validates. The
runtime drains private provider streams even when `result` is awaited before
iteration, buffers projected chunks for later consumption, and retains the
complete validated terminal provider response on `result`. A terminal-only
tool call is valid; any tool call observed during streaming must retain the
same choice, ID, type, function name, argument string, and extension fields at
terminal settlement. Consumer `return()` starts observed cancellation
immediately and returns promptly; provider cleanup and any failure remain
observable through the terminal result or complete developer-console
diagnostics rather than blocking iterator return.

### Availability and normalization

**Cross-host runtime with provider-specific execution.** The SDK source ships
the browser-WASM LLM and browser Whisper/Kokoro adapters and supplies the
narrow AI.js TWiN Cloud LLM, Ollama, and local Core-speech adapters; other
native, Core, or cloud adapters may be supplied externally only when they implement the same
`arcane-ai-provider/2` boundary. A
provider must prove a matching `arcane-ai-model-authority/1` inspection before load.
`localOnly` routing fails closed; it never selects a cloud or non-local route as
a fallback. A missing or mismatched explicit local-only route rejects load or
request selection with `AI_LOCAL_MODEL_REQUIRED`. Role lifecycle and stream
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

Normalizes current low/medium/high response-preference selectors while
preserving complete prompts unchanged.

### Public surface

Response-preference constants plus `normalizeAIResponseLength()`,
`aiResponseLengthInstruction()`, and `applyAIResponseLength()`. Every option is
labeled `Complete`, the instruction helper returns an empty string, and the
application helper returns its complete `systemPrompt` unchanged.

Exact exports: `AI_RESPONSE_LENGTH_DEFAULT`, `AI_RESPONSE_LENGTH_OPTIONS`, `aiResponseLengthInstruction`, `applyAIResponseLength`, `normalizeAIResponseLength`.

### Availability and normalization

**Cross-host.** Current selector normalization with no prompt transformation.
Transport: In-process only. [Deep protocol details](protocols.md).

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

Publishes one sticky mutable state tree for `llm`, `stt`, and `tts`, transient
load/unload/dispose intents, and a startup-settlement report. It makes lifecycle
observable without exposing provider transports in application code.

### Public surface

Exact exports: `AI_RUNTIME_INTENT_EVENT`, `AI_RUNTIME_PROTOCOL`,
`AI_RUNTIME_ROLES`, `AI_RUNTIME_STARTUP_EVENT`, `AI_RUNTIME_STATES`,
`AI_RUNTIME_STATE_EVENT`, `getAIRuntimeState`,
`publishAIRuntimeRoleState`, `publishAIRuntimeRolesState`,
`requestAIRuntimeIntent`, `startAIRuntime`, `subscribeAIRuntimeIntents`, and
`subscribeAIRuntimeState`.

Each role record is exactly `{role,state,providerId,modelId,localOnly,loaded,
busy,operationId,progress,error}`.
`subscribeAIRuntimeState(listener,{signal=null,emitCurrent=true})` installs its
subscription and synchronously replays the current mutable snapshot by default;
`subscribeAIRuntimeIntents(listener,{signal=null})` is future-only. Both return
one idempotent unsubscribe/dispose closure.
`startAIRuntime({startLanguageModel=true,startMuted=true,startTranscription=false,signal})` returns
`{barrier,settled,cancel}`: `barrier` settles for requested text-chat startup,
while `settled` covers every requested role. With `startLanguageModel:false`, a
selected LLM remains unloaded for explicit user activation, so the barrier can settle honestly with
`chatReady:false` and `roles.llm.requested:false`. Muted startup does not request
TTS, and STT startup is opt-in so selection and state observation do not begin a
transcription-model load.

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

Creates an HTTP(S) navigation guard whose optional domain and CIDR hardening runs only when the caller explicitly selects `secure: true`. The ordinary default returns a complete allow decision with a warning and does not load policy.

### Public surface

`createArcaneNavigationGuard({ secure })`.

Exact exports: `createArcaneNavigationGuard`.

### Availability and normalization

**Cross-host.** Complete mutable allow/block decision. Ordinary mode warns and
continues; explicitly selected `secure: true` loads the Arcane network-policy
document and fails closed when that selected policy cannot be evaluated. [Deep protocol details](protocols.md).

### Example

```javascript
import {createArcaneNavigationGuard} from '/arcane/modules/ArcaneNavigationPolicy.js';

const guard=createArcaneNavigationGuard();
console.log(await guard('https://example.com/docs',{intent:'external'}));
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

Runs a complete sequential browser test list with explicit cancellation and full-detail lifecycle events.

### Public surface

default `BrowserTestSuite`; `list()`, `run()`, `dispose()`/`destroy()`; emits
complete suite/test start/result/complete events. Caller metadata does not limit
execution or create a timer. Caller `AbortSignal` or disposal is the only
suite-owned stop.

Exact exports: `BROWSER_TEST_SUITE_ERROR_CODES`,
`BROWSER_TEST_SUITE_EVENT_TYPES`, `BROWSER_TEST_SUITE_REASONS`,
`assertionError`, `default`, `skipError`.

### Availability and normalization

**Browser / standard Web APIs.** Mutable full-detail results and events with
normalized malformed-result and skip/assertion errors. Transport: EventTarget
and explicit AbortSignal cancellation. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/BrowserTestSuite.js';

console.log(Object.keys(module));
```

## CalculatorEngine.js

### Overview

Evaluates complete arithmetic expressions, powers, constants, and common functions without `eval`.

### Public surface

`new CalculatorEngine()` exposes synchronous
`calculate(expression): Calculation` and idempotent
`dispose(): boolean` / `destroy(): boolean`. `evaluateExpression(input): number`
remains the parser-only helper. `CALCULATOR_ENGINE_ERROR_CODES` is one mutable
record containing the stable `disposed`, `input`, `syntax`, `domain`, and
`evaluation` codes.

Exact exports: `CALCULATOR_ENGINE_ERROR_CODES`, `default`,
`evaluateExpression`.

### Availability and normalization

**Cross-host.** Each engine owns one `calculator-engine` source on the realm's
branded `globalThis.arcaneEvents`. `calculator-result` publishes mutable public
detail `{result}`. `calculator-error` publishes mutable public detail
`{code,error,expression}` while `calculate()` rethrows that same complete
`Error`. Both occurrences carry one
source-instance `operationId`. Canonical listener callbacks are synchronous
observations; their failures are reported by the central event authority and do
not rewrite calculation settlement. Disposal rejects later calculations with
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

Detects whether a chat record contains a user entry or durable conversation
entry, and projects retained chat state into recurring provider context. That
projection preserves an unresolved structural-call tail for its one active
continuation, then replaces the settled protocol with complete ordinary visible
messages.

### Public surface

`hasUserEntry()`, `hasConversationEntry()`, and
`recurringChatMessages(chat,{settleCompleteToolTail=false}={})`. The optional
settlement flag is for restoring a configured session that has no active
provider continuation; unresolved calls remain raw regardless.

Exact exports: `hasConversationEntry`, `hasUserEntry`,
`recurringChatMessages`.

### Availability and normalization

**Cross-host.** Boolean conversation-entry results and recurring provider
context are normalized. Transport: In-process only. [Deep protocol details](protocols.md).

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
[`AIRuntimeState`](#airuntimestatejs) `stt` role records. Its mutable controller
exposes `action`, `error`, `label`, `pending`, `selected`, `status`, `title`, and
`visible` getters plus `request(action)`, `synchronize(role)`, and `destroy()`.
`host` supplies `dispatchEvent(event)` and `requestSTTActivation(intent)`;
`button` supplies `addEventListener()` and `removeEventListener()`; and
`onChange()` is called whenever presentation should be rendered again. Browser
callers use the default `CustomEvent`; non-DOM callers must inject a compatible
`EventClass` constructor.

`request('load'|'unload')` emits the cancelable
`speech-stt-activation-request` event with mutable `{intent,state}` before it
invokes `host.requestSTTActivation(intent)`. Callback failure emits
`speech-stt-activation-error` with mutable `{request,error,message}`. Syncing
sticky state only changes the controller's observation and presentation; it
never emits a lifecycle intent, chooses a provider, or starts a download.
`destroy()` removes its button listener and suppresses late callback effects.

Exact exports: `CHART_LABELS`, `DASHBOARD_LABELS`, `MARKDOWN_FORMATS`,
`MARKDOWN_LABELS`, `STT_ACTIVATION_ERROR_CODES`,
`STT_ACTIVATION_EVENT_TYPES`, `STT_ACTIVATION_REASONS`, `VOICE_LABELS`,
`VOICE_MESSAGES`, `appendTranscription`, `applyMarkdownFormat`,
`createSTTActivationController`, `effectiveDashboardVisibility`,
`formatAIRuntimeProgress`,
`normalizeChartOptions`, `normalizeChartRows`, `normalizeDashboardDefinitions`,
`normalizeDashboardOptions`, `normalizeDashboardVisibility`,
`normalizeMarkdownFormats`, `normalizeMarkdownOptions`, and
`normalizeVoiceOptions`.

### Availability and normalization

**Cross-host with an injected event constructor outside DOM hosts.** Fully
normalized labels, rows, definitions, visibility, formats, editor and voice
options, capability-neutral STT activation intent and presentation state, and
complete informational provider progress whenever a finite measure is present.
Fractional and over-total measures remain visible rather than being replaced by
their phase label.
Provider authority and lifecycle execution remain with the configured runtime
owner. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/ComponentContracts.js';

console.log(Object.keys(module));
```

## ConfiguredAIChatSession.js

### Overview

Owns complete ordinary visible recurring AI turns, one active structural
continuation, context construction, provider-response preservation, and atomic
history commit.

### Public surface

Default `ConfiguredAIChatSession`; named
`normalizeStructuralToolCall(call,label)`; instance methods `history()`,
`clear()`, `prepareOpening()`, `prepare()`, and `send()`.

`new ConfiguredAIChatSession(options={})` uses `chat`, `contextBuilder`,
`initialMessages`, `request`, `responseLength`, and `systemPrompt`.
`responseLength` is caller preference metadata and does not alter or limit content.
`initialMessages` is an array of complete `user`, `assistant`, or `tool`
messages. It excludes `system`, accepts one unresolved structural assistant
tool-call tail, and requires its tracked result before another user turn or
tool-call sequence; `systemPrompt` owns the separate system message. Settled
structural protocol is projected immediately into ordinary visible recurring
messages.

Each assistant structural tool call is one complete function call with an exact
nonempty string `id`, `type:'function'`, a nonempty `function.name`, and
`function.arguments` as a JSON string encoding an object containing a nonempty
user-facing `message`. One assistant message may contain an ordered array of
calls with unique IDs; every call and every extension field is preserved in the
returned response and its active matching continuation, but not settled
recurring history.
Validation does not trim or reserialize an accepted ID, name, or argument
string. A pending call set is settled atomically only by one request batch that
contains exactly one `role:'tool'` message with nonempty content for every
pending ID. A user turn, duplicate or mismatched result, partial result batch,
or overlapping structural call is rejected until the complete set settles.

`prepare(input,{request,signal})` performs the complete request but does not
commit history immediately. It returns mutable `{response,commit,rollback}`;
exactly one terminal settlement is permitted. Plain-object per-turn `request`
options merge over constructor defaults, while session-owned `messages` and
`signal` are applied last. `messages`, `signal`, `stream`, `onChunk`,
`onToolCall`, and `onResponse` cannot be supplied through either request layer.
A matching tool result may include a complete public `message`, `name`, and
`status`; those fields are excluded from the raw provider continuation. The
public `message` becomes ordinary visible recurring content after settlement,
while `name` and `status` remain optional durable transcript metadata. Raw
call/result protocol is retained only until that one continuation commits.
`send()` is the convenience path that prepares and then commits the turn.

`prepareOpening(input,{request,signal})` is the dedicated transaction for an
automatic model-authored opening. It sends one application-authored user
bootstrap only when retained history contains no conversation turn, requires a
complete nonblank assistant response without structural calls, and prepares
only that assistant content for commit. The bootstrap never enters history.
An existing retained turn rejects as `AI_CHAT_OPENING_EXISTS`; an empty or
structural response rejects as `AI_CHAT_INVALID_OPENING_RESPONSE`.

An optional async `contextBuilder({input,history,signal})` receives a mutable,
complete request snapshot and the same cancellation signal. Its complete
returned context applies only to the current request and is never committed to
history.

An injected `chat(request)` may return the prior normalized session result or a
non-stream OpenAI-compatible response whose first choice supplies the assistant
message. The prior form preserves its explicit `done` boolean;
OpenAI-compatible choice normalization sets `done:true`. Both return mutable
`{provider,model,message:{role:'assistant',content,tool_calls?},providerResponse,
done,doneReason,promptEvalCount,evalCount}` and preserve the complete provider
response in `providerResponse`. Tool calls remain structural data and are never
executed. General malformed responses fail `AI_CHAT_INVALID_RESPONSE`;
malformed structural envelopes or argument JSON fail
`AI_CHAT_INVALID_TOOL_CALL`, and a missing or blank argument `message` fails
`AI_CHAT_TOOL_MESSAGE_REQUIRED`. Caller cancellation is `AbortError` with code
`AI_CHAT_ABORTED`. A new user
turn cannot bypass a pending structural tool call
(`AI_CHAT_TOOL_RESULT_REQUIRED`), a mismatched tool result fails
`AI_CHAT_INVALID_TOOL_MESSAGE`, and a second terminal settlement of one
prepared transaction fails `AI_CHAT_TRANSACTION_SETTLED`. Incoherent initial or
persisted sequencing fails `AI_CHAT_INCOHERENT_PERSISTENCE`.

Exact exports: `normalizeStructuralToolCall`, `default`.

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

Normalizes, creates, updates, remembers, selects, and formats complete conversation action items.

### Public surface

Action-item constants and lifecycle/formatting helpers.

Exact exports: `CONVERSATION_ACTION_ITEM_BASES`, `CONVERSATION_ACTION_ITEM_PRESENTATION_COOLDOWN_MS`, `CONVERSATION_ACTION_ITEM_STATUSES`, `conversationActionItemsInstruction`, `createConversationActionItem`, `formatConversationActionItemCheckIn`, `markConversationActionItemsPresented`, `normalizeConversationActionItem`, `normalizeConversationActionItems`, `normalizeRememberedConversationActions`, `outstandingConversationActionItems`, `rememberConversationActionItems`, `removeConversationActionItem`, `selectConversationActionItemsForPresentation`, `updateConversationActionItem`.

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

The generated sole-call schema requires both `message` and `final_message`.
`message` is brief user-facing progress shown while the application accepts and
renders the call. `final_message` remains the complete terminal closeout and is
never replaced by or duplicated into `message`; `remembered_actions` remains
optional. `normalizeConversationClosingReport()` returns
`{message,finalMessage,rememberedActions}`, while
`formatConversationClosingReport()` escapes and renders only `finalMessage`.

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

`conversationTimeboxTool` is a sole-call function schema with
`additionalProperties:false`. Every call requires `action` and a nonempty
user-facing `message`; `set` and `adjust` also require an explicit positive
`duration_milliseconds`, while `clear` ignores duration.
`normalizeConversationTimeboxCommand()` preserves the exact message, and
`ConversationTimebox.applyCommand()` returns the resulting state snapshot plus
that message after applying the command. `consumeConversationTimeboxCall()`
retains this producer result inside its fulfilled result record.

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

**Cross-host.** Fully normalized descriptors and stable availability labels. Transport: In-process projection of Core status. [Deep protocol details](protocols.md).

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

Exact exports: `clearEmptyChatsAndMemories`, `hasConversationEntry`,
`hasMemoryContent`, `hasUserEntry`.

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

**Browser / native WebView.** App scope and recognized JSON/JSONL file parsing
are normalized. Each readable JSONL row becomes its parsed value; a nonblank
unreadable row remains in its original string form so the owning application
can display, diagnose, or recover it without silent data loss. DOM and storage
errors remain observable. Transport: OPFS, DBOPFSWorker, Compression Streams.
[Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DBOPFS.js';

console.log(Object.keys(module));
```

## DBOPFSDocumentLibrary.js

### Overview

Stores one application-defined document corpus through an existing DBOPFS-style
adapter, searches only a completed generation, and builds complete context.
Construction performs no read, write, fetch, or search; applications call
`bootstrap()` deliberately.

### Public surface

Exact exports: `DBOPFSDocumentLibrary`, `createDBOPFSDocumentLibrary`,
`default`, and `normalizeDBOPFSDocumentSchema`.

`new DBOPFSDocumentLibrary({concurrency,db,schema})` exposes `schema`,
`bootstrap({files,onProgress,read,readFailurePolicy,signal})`,
`search(query,{kinds,signal,tags})`,
`evaluate(query,{sources,read,kinds?,tags?,readFailurePolicy?,onProgress?,signal?})`,
`buildContext(query,{signal})`, and `createContextBuilder()`.

`evaluate()` requires `sources`
and `read`, filters source metadata before calling
`read(source,{ordinal,signal})`, and never persists a caller-owned body.

### Availability and normalization

**Browser or compatible host with an injected DBOPFS adapter.** The adapter
keeps the existing `get`, `set`, `getAllKeys`, and `delete` method names; Node
can use the same class only through an explicitly imported runtime module and a
compatible storage adapter; SDK `0.5.11` publishes no Node package subpath or
Node storage implementation for it. Bootstrap uses a concurrent
generation, commits its manifest last, cleans partial data on failure, and
rejects case-colliding IDs. Search
returns `{failures,matches,total}` so one malformed record remains visible
without hiding readable results. `bootstrap()` and `evaluate()` default to
`readFailurePolicy:'preserve-readable'`; explicit `reject` stops on a read
failure. Preserve-readable mode returns the readable records plus the complete
failure and coverage details (`readCoverage` for bootstrap, `coverage` for
evaluation). Evaluation reads a caller-owned source list without persisting its
bodies and returns complete documents and text.
Read failure remains `DBOPFS_DOCUMENT_READ_FAILED`; invalid public input uses
`DBOPFS_DOCUMENT_INVALID`, invalid concurrency uses
`DBOPFS_DOCUMENT_INVALID_LIMIT`, and a preserved read failure without a usable
source code is reported as `failures[].code:'DBOPFS_DOCUMENT_ERROR'`.
Cancellation is `AbortError` with code `DBOPFS_DOCUMENT_ABORTED`. Construction
does not search.
When an application explicitly supplies the library's context builder, each
prepared chat send performs that complete retrieval.

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
    read: async source => source.id === 'draft' ? 'Portable app notes.' : ''
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

Provides complete workspace inspection, context, setup task, and Node installer clients without arbitrary command execution.

### Public surface

default `DevelopmentWorkspace` and input validators; `inspect()`, `context()`, `setup()`, `installNode()`.

Exact exports: `contextQuery`, `default`, `setupTaskId`, `workspaceRoot`.

### Availability and normalization

**Native bridge.** Complete plain-text roots, queries, and application-owned task identifiers reach the provider without application length or task allowlist gates; provider result/error content is preserved. Transport: Arcane.development. [Deep protocol details](protocols.md).

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

**Native bridge.** Every caller option and provider result field is preserved.
`title`, `initialPath`, and a selected `path` remain complete strings without
trimming or application character gates, and returned records remain mutable.
The provider or operating system owns any platform-specific path failure.
Cancellation and malformed provider results retain coded errors. Transport:
Arcane.filesystem.selectDirectory. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/DirectoryPicker.js';

console.log(Object.keys(module));
```

## DocumentLexicalSearch.js

### Overview

Provides deterministic, dependency-free metadata/body ranking and complete
context excerpts for caller-owned document records.

### Public surface

Exact exports: `DOCUMENT_SEARCH_FIELD_ORDER`, `DocumentLexicalSearch`,
`createDocumentLexicalIndex`, `default`, `documentContextExcerpt`,
`documentSearchTokens`, `normalizedDocumentSearchText`, `scoreDocumentBody`,
and `scoreDocumentLexicalIndex`.

`new DocumentLexicalSearch(records)` exposes
`rank(query,{kinds,tags})` and `search(query,{kinds,tags})`.

### Availability and normalization

**Cross-host.** Indexing and search are in-process only. Text, tags, kinds,
scores, field ordering, complete excerpts, and tie-breaking are normalized into
mutable records. This module performs no storage, network, model, Core, or DOM
action. The caller decides how a result is used.

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

Normalizes global errors/rejections, assigns occurrence identifiers, persists a complete ledger, and performs complete delivery.

### Public surface

default `Errors`; event normalizers plus lifecycle, capture, delivery and teardown methods.

Exact exports: `GLOBAL_ERROR_EVENT_CODES`, `GLOBAL_ERROR_EVENT_TYPES`,
`GLOBAL_ERROR_REASONS`, `default`, `normalizeErrorEvent`, and
`normalizeRejectionEvent`.

### Availability and normalization

**Browser / native WebView hybrid.** Incident records normalized; storage/mail failures isolated. Transport: Window events, DBOPFS, Mail. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/Errors.js';

console.log(Object.keys(module));
```

## GifEncoder.js

### Overview

Encodes indexed frames into a complete animated GIF using palette mapping and LZW.

### Public surface

default `GifEncoder`, `indexPixels()`, `lzw()`.

Exact exports: `default`, `indexPixels`, `lzw`.

### Availability and normalization

**Cross-host.** Normalized complete binary output. Transport: In-process only. [Deep protocol details](protocols.md).

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

Inspects one selected model and runs one isolated question while preserving the
complete answer.

### Public surface

default/named runner, `countSentences()`, `inspectModel()`, `runQuestion()`.
`inspectModel(model,expectedModel,contextTokens)` accepts any positive safe
integer context-token value and forwards the complete selected request.
`runQuestion()` returns the provider's full result plus informative
`sentenceCount`; it has no `maxSentences` input or `sentenceLimitExceeded`
output.

Exact exports: `IsolatedModelQuestionRunner`, `countSentences`, `default`.

### Availability and normalization

**Native bridge or injected provider.** Normalized model/result and coded errors. Transport: localAI isolated-model methods. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/IsolatedModelQuestionRunner.js';

console.log(Object.keys(module));
```

## LocalAIReadiness.js

### Overview

Derives selected AI requirements and returns a complete readiness/recovery report across browser, desktop, and Android modes.

### Public surface

Endpoint constant plus requirements, speech-health, and readiness helpers.

Exact exports: `LOCAL_AI_BROWSER_ENDPOINTS`, `checkLocalAIReadiness`, `deriveLocalAIRequirements`, `evaluateLocalSpeechHealth`.

### Availability and normalization

**Browser/native hybrid.** Fully normalized report and stable error codes; browsers never probe Ollama. Transport: Arcane.localAI, Arcane.speech, complete browser speech health. [Deep protocol details](protocols.md).

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

Builds complete reports and prefers the native mail capability with an explicit HTTP transport fallback. Report text, HTML, and serialized content are preserved exactly and delivered complete.

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

Persists each complete provider-neutral mail report before delivery and owns its
idempotent enqueue, FIFO drain, retry-window, terminal-state, reconciliation,
and explicit invalid-record maintenance lifecycle. It selects no mail provider,
recipient, retention policy, retry timer, or transport fallback.

### Public surface

Exact exports: `MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS`, `MAIL_OUTBOX_PROTOCOL`,
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
  quarantineTable='mail_outbox_quarantine',
  table=MAIL_OUTBOX_TABLE
}={})
```

`storage` must expose `get()`, `set()`, and `getAllKeys()`; explicit deletion or
quarantine additionally requires `delete()`. `lockManager` must expose the Web
Locks-compatible `request()` contract. The injected
`deliver({report,reportKey,serializedReport,signal})` callback receives the
complete parsed report, its stable idempotency key, the exact stored JSON string,
and the caller-owned signal. Omitted `lockManager` resolves first from storage
and then from `navigator.locks`. A delivery result must identify a valid
`requestId` and one of `accepted`, `delivery_uncertain`,
`retryable`, `permanently_rejected`, or `partially_accepted`;
`providerId` and `acceptanceAuthority` are optional transport-owned metadata,
and an acceptance authority is valid only on an `accepted` result.

Read-only getters are `started`, `invalidRecords`, and `lastBackgroundError`.
Methods are `get(key)`, `list()`, `audit()`, `deleteInvalid(fileName)`,
`repairInvalid(fileName,replacement)`,
`quarantineInvalid()`,
`enqueue({report,reportKey}={}, {attempt=true,signal=null}={})`,
`drain({reason='manual',signal=null}={})`, `start({signal=null}={})`, and
`stop()`. `createMailOutbox(options)` returns `new MailOutbox(options)`.

Every returned durable record contains exactly
`{protocol,reportKey,serializedReport,state,createdAt,updatedAt,firstAttemptAt,
lastAttemptAt,nextAttemptAt,attempts,result,failure}`. Protocol is
`arcane-mail-outbox/1`; the default table is `mail_outbox`; the idempotency
window is 86,400,000 milliseconds. States are exactly `queued`, `sending`,
`retry_wait`, `accepted`, `failed`, and `reconciliation_required`. Accepted
means the selected transport returned `accepted` with a valid request ID, not
that the message reached an inbox.

`enqueue()` serializes same-instance persistence and binds one report key to one
complete serialized body. It preserves the complete queued content without
truncation, clipping, tailing, or elision.
`drain()` runs or joins one instance drain under an exclusive shared lock. Startup,
an owned `online` listener, or an explicit call may trigger work; there is no
polling or retry timer. Abort before the delivery call prevents that call, and a
caller joining an existing drain may stop waiting without cancelling the shared
drain. Once an accepted result is committed, it outranks a racing cancellation;
cancellation never claims an admitted provider attempt stopped. An interrupted
or ambiguous attempt remains a same-key retry inside the 24-hour window and
becomes `reconciliation_required` when automatic retry would risk a duplicate.
`stop()` aborts only the owned online drain, removes its listener, preserves
durable records, and returns the instance.

`audit()` reports valid records plus complete invalid-file metadata. Repair,
deletion, and quarantine are explicit, revalidate the selected file under the
table lock, and never infer destructive authority from a storage read failure.
`onRecordCommitted(record)` is an observational callback after each durable
write; callback failure cannot change the committed operation result.

### Availability and normalization

**Browser/native WebView or compatible injected host.** The default application
integration uses DBOPFS-compatible durable storage and `navigator.locks`; an
alternate adapter owns its own durability claim and must provide equivalent
storage and shared-lock semantics. Complete records, state transitions,
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

Sends one complete mail report to a normalized HTTP(S) endpoint.

### Public surface

`MailTransportError`, `normalizeMailEndpoint()`, `serializeMailReport()`, and
`sendMailReport()`.

Exact exports: `MailTransportError`, `normalizeMailEndpoint`,
`serializeMailReport`, `sendMailReport`.

### Availability and normalization

**Browser/server with fetch + cloud.** Normalized endpoint/transport errors; complete remote detail is preserved subject only to unavoidable HTTP framing. Transport: HTTP(S) fetch + AbortController. [Deep protocol details](protocols.md).

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

Renders complete Markdown with Marked and exposes the same complete rendered
markup through `rendered` and `safeRendered`.

### Public surface

default `MD`; `raw`, `rendered`, `safeRendered`, `append()`.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Raw Marked behavior is preserved; parse errors are
vendor-native. Transport: Marked. [Deep protocol details](protocols.md).

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

**Cross-host.** Complete mutable advisory records preserve all supplied text and signals; inspector failures are converted to unavailable results. Transport: Injected inspector. [Deep protocol details](protocols.md).

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

**Cross-host.** Complete mutable definition data with coded syntax errors for malformed input. Transport: Optional ordinary read-only fetch using the fetch implementation's redirect, credentials, and cache behavior. [Deep protocol details](protocols.md).

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

Defines complete runtime/service preference schemas and deterministic Arcane brain alias names.

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

Searches and loads Open-Meteo data into mutable Arcane weather entities.

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

Constructor and factory options are `{ai,chat,chatEntity,chatFileName,
contextBuilder,loadExisting,memory,request,responseLength,systemPrompt}`. Public members are
static `create()`, getters `ai`, `chatEntity`, and `fileName`, and `ready()`,
`history()`, `transcript()`, `settleMemory()`, `open(input)`, `send(input)`, and
`stream(input,handlers)`.
`ready()` waits for initialization and resolves the same session instance.

`open({message:{content,persist:false?},request?,signal?})` performs one
application-authored bootstrap request only when the retained conversation is
otherwise empty. The bootstrap is never committed. After a complete nonblank
model response succeeds, the operation atomically retains only the sanitized
assistant content in configured model context and ChatEntity/DBOPFS history.
That assistant-only opening survives reload and empty-chat maintenance without
a fabricated user turn. A second opening rejects as `AI_CHAT_OPENING_EXISTS`;
an unavailable durable ChatEntity rejects as `AI_CHAT_PERSISTENCE_UNAVAILABLE`.

`send()` accepts either
`{message:{content,role:'user'|'tool',tool_call_id?,message?,name?,status?,persist},...}`
or an atomic tool-result batch with the same fields,
plus `request?`, `response:{persist}`, and `signal?`. Every message and the
response must use the same persistence choice. Plain-object `request` supplies
per-turn generation options such as
`toolChoice:'none'`; it cannot replace session-owned `messages`, `signal`, or
streaming/lifecycle callback state.
`persist:false` makes the input and response available only to that one request.
After the response is returned, neither remains in subsequent model context,
the retained transcript, memory extraction, or DBOPFS. A nonpersistent response
therefore does not open a retained structural-tool continuation. A retained
structural tool result must use the persistence choice captured by its matching
assistant tool call.

`history()` returns provider-safe configured model context, including the
system prompt and every complete ordinary visible committed turn. Only a
currently unresolved structural-call tail remains raw for its matching active
continuation. `transcript()` returns the sanitized human-readable ChatEntity
projection.
User and assistant records retain only role, complete visible content, and the
real timestamp. Tool records retain only role, the required user-facing
`message` as content, and optional public `name` and result `status`.

`stream()` accepts the same input as `send()` and optional
`{onChunk,onDataChunk,onDataResult,onToolCall}` handlers. When
`ai.streamRequest()` is available, it forwards complete provider data through
the data callbacks and ordinary live text/reasoning through `onChunk`. It
buffers every observed structural call until the ordered call array exactly
matches the terminal response and the complete response passes
configured-session validation, and only then publishes each call and uses the
same atomic ChatEntity append/configured session commit as `send()`. A
terminal-only call is valid; omission or divergence of any observed call
rejects with
`AI_CHAT_STREAM_TOOL_CALL_MISMATCH` before persistence or commit. When streaming
is unavailable, `stream()` uses the
configured non-stream chat request and still returns, validates, persists, and
renders the complete terminal response and tool calls; optional streaming is
not a session failure. The same caller signal and transaction rollback govern
both paths.

When an assistant response opens structural calls, the response persistence
choice is retained under every exact call ID only in the active session. One
ordered `role:'tool'` request batch must settle all pending IDs with that same
persistence choice before a new user or provider turn. That one provider
continuation receives the raw calls, IDs, arguments, and results. Once it
commits, recurring context replaces them with complete ordinary visible call,
assistant, and any supplied public result messages. Raw protocol is never
included in new durable records. Existing stored records are not rewritten on
load.

### Availability and normalization

**Browser or native WebView with ChatEntity/DBOPFS and a configured chat
function.** The default chat calls normalized `Arcane.ai.chat()`; callers can
inject the browser-WASM controller, another provider-neutral adapter, or a
cloud chat function. There is no automatic provider or storage fallback.
Context builders are request-only, and document context remains explicitly
untrusted. Errors include `AI_CHAT_BUSY`, `AI_CHAT_TOOL_RESULT_REQUIRED`,
`AI_CHAT_INVALID_TOOL_MESSAGE`, `AI_CHAT_TOOL_MESSAGE_REQUIRED`, and
`AI_CHAT_INCOHERENT_PERSISTENCE`, plus
`AI_CHAT_STREAM_TOOL_CALL_MISMATCH` for a streamed/terminal envelope mismatch,
and `AI_CHAT_INVALID_OPENING_RESPONSE`, `AI_CHAT_OPENING_EXISTS`, or
`AI_CHAT_PERSISTENCE_UNAVAILABLE` for the dedicated opening lifecycle.

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

default `PreferenceStore`, re-exported `Preference`/schema; load/set/setAll/reset APIs and events.

Adapters provide `get(key, context)`, `set(key, value, context)`, and
`delete(key, context)`. An adapter may also provide
`setMany(entries, context)`, where `entries` is one mutable plain object keyed by
the store's namespaced storage keys. `setAll(values, {signal})` normalizes every
selected schema value before storage work. For every selected value it calls an
advertised `setMany()` once and publishes the existing per-key change events
only after that batch succeeds. A dispatched batch rejection propagates without
a serial retry, in-memory state change, or change event. Adapters without
`setMany()` retain ordered complete serial storage behavior inside
one queued operation, including state and events for each successful write before
a later write fails.

Exact exports: `PREFERENCE_STORE_ERROR_CODES`,
`PREFERENCE_STORE_EVENT_TYPES`, `Preference`, `default`, and
`preferenceSchema`.

### Availability and normalization

**Browser/native hybrid.** Complete ordinary values and returned snapshots remain
mutable after schema normalization. Non-Android
`Arcane.preferences.setMany()` supplies the optional atomic batch. Only exact
unsupported native capability changes future operations to app-scoped
localStorage; an in-flight advertised batch is never downgraded after rejection.
If cancellation settles after a native batch was dispatched, reload the store to
reconcile any atomic host commit that completed before cancellation. Transport:
Arcane.preferences or app-scoped localStorage. [Deep protocol details](protocols.md).

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

**Cross-host.** Normalized conservative boolean. Transport: In-process clock only. [Deep protocol details](protocols.md).

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

**Cross-host.** Complete selected excerpts and every unique date/rule finding are preserved without character or result-count caps. Transport: In-process only. [Deep protocol details](protocols.md).

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

**Browser/native hybrid.** Complete normalized ids, reviews, and snapshots are preserved; unreadable stored records fail with `ARCANE_RECORD_REVIEW_STORED_RECORDS_INVALID` rather than silently becoming an empty store. Transport: Arcane.storage or localStorage. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/RecordReviewStore.js';

console.log(Object.keys(module));
```

## RiskSignalAnalyzer.js

### Overview

Matches configured risk signals and levels against complete text.

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

Combines deterministic scam signals with optional Arcane blocked-domain evidence and safety guidance.

### Public surface

Signals plus load, assess, and guidance helpers.

Exact exports: `assessScamRisk`, `loadScamNetworkPolicy`, `scamRiskSignals`, `scamSafetyGuidance`.

### Availability and normalization

**Cross-host.** Complete mutable signal results are returned. Blocked-domain policy inspection is inactive by default and runs only when the caller explicitly selects `secure:true`. Transport: In-process + optional caller-selected Arcane network policy fetch. [Deep protocol details](protocols.md).

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

**Browser / native WebView.** Exact-key options and malformed-JSON handling are
normalized; complete JSON values are preserved and storage errors remain
visible. Transport: OPFS + AppDataScope. [Deep protocol details](protocols.md).

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

Preserves exact nonblank text as one segment, queues latest-request speech
synthesis, and controls lookahead HTML audio playback.

### Public surface

`SpeechPlayback` class/default, `SPEECH_PLAYBACK_STATE_EVENT`,
`splitSpeechText()`, and playback lifecycle APIs.

Exact exports: `SPEECH_PLAYBACK_STATE_EVENT`, `SpeechPlayback`, `default`, and
`splitSpeechText`.

```text
new SpeechPlayback({
  audio,
  speech=globalThis.Arcane?.speech,
  model=null,
  voice=null,
  responseFormat=null,
  speed=1,
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
catalog may provide its documented defaults. Speed defaults to `1`, is normalized
as a positive number, and is always sent. There is no
hard-coded model, response format, voice, or cloud/browser fallback.
`splitSpeechText(value)` uses trimming only to detect blank input, then returns
the caller's exact string in one mutable array without trimming, splitting, or
freezing it. `prepare()` likewise preserves each nonblank part's exact `input`
string while normalizing its other playback fields into a new mutable record.
The class applies no part-count, character-count, pause, or input upper cap.

Every preparation owns an operation ID and one AbortController for each active
synthesis segment or playback delay. Replacement,
`stop()`, `cancel()`, and `destroy()` abort their owned signals, suppress stale
settlement, release Blob URLs, and publish synchronous
`speech-playback-state` occurrences through `globalThis.arcaneEvents`.
Subscribers receive mutable public state detail. The detail contains
`state`, `message`, `key`, `index`, `total`, `producing`, `buffered`, `hasAudio`,
`operationId`, `code`, and `reason`; provider rejection remains preserved to the
`prepare()` caller. `destroy()` also removes every audio listener and disposes
its per-instance canonical source handle; repeated destroy returns
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

**Browser + compatible AI/native bridge.** State, cancellation, lifecycle, and
playable Blob normalization are shared. Provider/model/runtime/voice selection
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

Loads a positive static document inventory with cache, search, and complete context.

### Public surface

default catalog, schema constant, catalog normalizer/cache-key; list/get/search/hydrate/context APIs.

Exact exports: `CATALOG_SCHEMA_VERSION`, `default`, `normalizeStaticDocumentCatalog`, `staticDocumentCacheKey`.

### Availability and normalization

**Browser / native WebView / server with fetch.** Catalog/content normalization
preserves complete mutable documents; malformed catalog/content and transport
failures remain visible. Transport: HTTP(S) and optional cache. [Deep protocol details](protocols.md).

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

Parses OpenAI-style complete responses or streamed name-keyed call records,
validates each argument record, and dispatches it to an injected handler.

### Public surface

`parseArguments()`, `handleResponse()`, `handleStreamedCalls()`.

`parseArguments()` accepts JSON text or a plain argument object whose prototype
is `Object.prototype` or `null`, requires a nonempty user-facing `message`, and
returns the parsed object without cloning, freezing, or reserialization.
Missing, blank, null, array, custom-prototype, or otherwise invalid argument
records fail with `AI_TOOL_MESSAGE_REQUIRED`. Complete-response handlers run
sequentially and return one result or an array; streamed handlers return
`Promise.allSettled()` results. A routed call is not settled merely because it
was displayed: the conversation owner must still append the exact matching
executed, declined, cancelled, or not-executed `role:'tool'` result before the
next user turn.

Exact exports: `handleResponse`, `handleStreamedCalls`, `parseArguments`.

### Availability and normalization

**Cross-host.** Argument records validated; handler results returned or
all-settled. Transport: Injected handlers. [Deep protocol details](protocols.md).

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

Parses YouTube video/playlist locators and constructs ordinary embed URLs by
default, with privacy enhancement only when the caller selects it.

### Public surface

`parseYouTubeMedia()`, `youtubeEmbedUrl()`.

Exact exports: `parseYouTubeMedia`, `youtubeEmbedUrl`.

### Availability and normalization

**Cross-host.** Bare video IDs and supported URLs normalize to mutable locators;
`youtubeEmbedUrl(locator,{privacyEnhanced:false})` is the default and
`privacyEnhanced:true` explicitly selects the privacy-enhanced host. Transport:
URL construction only. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/YouTubeMedia.js';

console.log(Object.keys(module));
```

## Entity and component continuations

- [Runtime entity modules](runtime-entities.md) explains all 14 modules, and [shared entity contracts](core/arcane-entities.md) owns all 29 exports.
- [Runtime components](runtime-components.md) owns all 39 HTML-import fragments, methods, slots, and events.
- [Arcane Ollama](arcane-ollama.md) expands the raw-versus-normalized behavior of `Ollama.js`.
