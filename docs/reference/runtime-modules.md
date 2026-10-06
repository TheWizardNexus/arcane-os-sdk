# Arcane runtime module catalog

Every file shipped under `runtime/arcane/modules/` appears here. Start with the capability and example; expand into [protocol and host architecture](protocols.md) only when transport detail matters.

Apps import renderer ESM with `arcane-os/modules/<file>`, including the `.js`
or `.mjs` extension. The SDK-managed import map resolves that name through the
application's selected runtime routes. Root applications use the installed
npm package directly by default. Absolute `/arcane/modules/<file>` examples
below describe an explicitly configured physical or virtual `/arcane` route;
that directory is not required by a direct npm layout.

Classic scripts, the OPFS worker, uPlot stylesheet, and vendor license use
their actual configured asset URLs and are called out separately. Importing a
module does not grant a native capability. See [installed-package browser
routes](protocols.md#installed-package-browser-routes) for route selection.

Applications own response-detail preferences, their saved values, and any
verbosity instruction appended to the system prompt. The former
`AIResponseLength.js` module and its exports have been removed. Before adopting
this source change, consumers must normalize preferences in their application
and pass their complete system prompt directly instead of calling the former
no-op `applyAIResponseLength()` helper. Existing saved preferences are unchanged.

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
| [`AIModelSelectionController.js`](#aimodelselectioncontrollerjs) | esm | Binds six supplied provider/model selects with draft-safe hydration, explicit catalog discovery, and paired LLM selection. | Browser / native WebView | Mutable exact values and complete errors; storage and activation remain app-owned. |
| [`AIPreferenceRuntime.js`](#aipreferenceruntimejs) | esm | Applies and reads non-persistent per-user AI preference overrides. | Cross-host | Normalized six-slot preference state. |
| [`AIPreferenceTuple.js`](#aipreferencetuplejs) | esm | Normalizes and compares the six provider/model preference slots. | Cross-host | Mutable slot order and normalized tuple. |
| [`AIProviderRuntime.js`](#aiproviderruntimejs) | esm | Owns provider-neutral selection, lifecycle, routing, startup, requests, streaming, cancellation, and independent LLM/STT/TTS state. | Cross-host runtime; provider-specific availability | Normalized required provider members plus route/status contracts, with explicit local-only selection and no implicit fallback. |
| [`AIResponseURLPolicy.js`](#airesponseurlpolicyjs) | esm | Extracts and audits links from AI Markdown, rendered HTML, CSS, srcset, bare URLs, and email text. | Cross-host | Mutable audit with exact link comparison after renderer-level decoding. |
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
| [`ContinuousVoiceCapture.js`](#continuousvoicecapturejs) | esm | Owns continuous microphone capture with pre-roll, pause/periodic WAV segments, final flush, and cancellation. | Browser / native WebView with AudioWorklet | Complete ordered clips; audio activity and timing are normalized, microphone availability remains browser-owned. |
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
| [`Errors.js`](#errorsjs) | esm | Normalizes global errors/rejections, assigns occurrence identifiers, persists a complete ledger, and performs complete delivery. | Browser / native WebView hybrid | Incident records normalized; storage/mail failures isolated. |
| [`GifEncoder.js`](#gifencoderjs) | esm | Encodes indexed frames into a complete animated GIF using palette mapping and LZW. | Cross-host | Normalized complete binary output. |
| [`HTMLImport.js`](#htmlimportjs) | esm | Defines the same-origin `<html-import>` loader with open shadow root, inline or packaged external script execution, and readiness/error events. | Browser / native WebView | Public error detail normalized; fetch/DOM failure preserved. |
| [`HTMLImportScript.js`](#htmlimportscriptjs) | esm | Renders the complete classic-script host wrapper shared by HTMLImport and native-module packaging. | Cross-host | Complete source retained with a terminating newline before the wrapper closes. |
| [`InMemoryCommunicationProvider.js`](#inmemorycommunicationproviderjs) | esm | Implements deterministic in-memory thread/message/send behavior for demos and tests. | Cross-host | Normalized communication entities. |
| [`IsolatedModelQuestionRunner.js`](#isolatedmodelquestionrunnerjs) | esm | Inspects one selected model and runs one isolated question while preserving the complete answer. | Native bridge or injected provider | Normalized model/result and coded errors. |
| [`LocalAIReadiness.js`](#localaireadinessjs) | esm | Derives selected AI requirements and returns a complete readiness/recovery report across browser, desktop, and Android modes. | Browser/native hybrid | Fully normalized report and stable error codes; browsers never probe Ollama. |
| [`LocalAIReadinessController.js`](#localaireadinesscontrollerjs) | esm | Coordinates local-AI status component checks, ensured recovery, availability projection, and teardown. | Browser/native hybrid | Normalized controller state and change events. |
| [`Mail.js`](#mailjs) | esm | Builds complete reports and prefers the native mail capability with an explicit HTTP transport fallback. | Browser/native hybrid + cloud | Mail inputs/results normalized; transport failures mixed. |
| [`MailApi.mjs`](#mailapimjs) | esm | Public renderer entrypoint for Mail, durable outbox, and HTTP transport APIs. | Browser/native renderer | Re-exports preserve their owning module's contracts. |
| [`MailOutbox.mjs`](#mailoutboxmjs) | esm | Persists complete mail reports before delivery and normalizes idempotent enqueue, retry, reconciliation, and invalid-record maintenance. | Browser/native WebView or compatible injected host | Complete records, full work, cancellation, and lifecycle states normalized; storage, lock, and delivery failures coded. |
| [`MailTransport.mjs`](#mailtransportmjs) | esm | Sends one complete mail report to a normalized HTTP(S) endpoint. | Browser/server with fetch + cloud | Normalized endpoint and transport errors; remote detail preserved. |
| [`MarkdownMedia.js`](#markdownmediajs) | esm | Saves local Markdown images separately, decodes complete stored records, and resolves stable references in rendered views. | Browser / supported native WebView | Complete image records, concurrent display reads, cancellation, and print-owned URL lifetime. |
| [`MarkdownSpeech.js`](#markdownspeechjs) | esm | Removes repeated Markdown formatting marks from streamed narration. | Cross-host | Speech-only filtering; single marks and ordinary punctuation remain literal. |
| [`Marked.min.js`](#markedminjs) | esm | Vendored Marked 18.0.5 Markdown lexer, parser, renderer, extension, and walk-token API. | Cross-host vendor module | Vendor-native Marked contract. |
| [`MD.js`](#mdjs) | esm | Renders complete Markdown with Marked and optionally maps source blocks to rendered comment anchors. | Browser / native WebView | Complete raw and rendered Marked values; opt-in original-source offsets; parse errors vendor-native. |
| [`MemoryRecords.js`](#memoryrecordsjs) | esm | Normalizes memory content and detects meaningful stored memory. | Cross-host | Fully normalized string/boolean results. |
| [`MessageAdvisory.js`](#messageadvisoryjs) | esm | Normalizes message content advisories and contains per-message inspection failures. | Cross-host | Normalized advisory records; inspector failures converted to unavailable results. |
| [`ModelDefinition.js`](#modeldefinitionjs) | esm | Parses the deterministic packaged Modelfile subset and extracts the SYSTEM prompt. | Cross-host | Complete mutable definition with coded malformed-input errors. |
| [`Ollama.js`](#ollamajs) | esm | Provides the first-class Arcane Ollama client without direct access to localhost:11434. | Native bridge | Principal methods preserve provider-native envelopes; readiness/text/unload helpers normalize. |
| [`OllamaModelIdentifier.js`](#ollamamodelidentifierjs) | esm | Validates and canonicalizes the syntax of Ollama model identifiers without granting model admission. | Cross-host | Fully normalized string/boolean result. |
| [`OllamaSettings.js`](#ollamasettingsjs) | esm | Defines complete runtime/service preference schemas and deterministic Arcane brain alias names. | Cross-host | Fully normalized settings/name contract. |
| [`OpenMeteoWeatherProvider.js`](#openmeteoweatherproviderjs) | esm | Searches and loads Open-Meteo data into complete mutable Arcane weather entities. | Browser / native WebView / server with fetch + cloud | Provider data normalized to mutable entities; transport errors mixed. |
| [`PersistentAIChatSession.js`](#persistentaichatsessionjs) | esm | Adds explicit retained-history/memory policy to complete configured chat without changing DBOPFS or ChatEntity semantics. | Browser / native WebView with DBOPFS and configured chat | Retained context commits atomically; `persist:false` turns are one-operation-only. |
| [`PreferenceStore.js`](#preferencestorejs) | esm | Loads and updates schema-defined app preferences through native storage with a narrow browser fallback. | Browser/native hybrid | Complete ordinary values remain mutable; setAll uses one optional atomic adapter batch for every selected value when advertised, otherwise performs complete ordered serial writes, and only exact unsupported native capability changes future operations to the browser fallback. |
| [`PreparedSpeech.js`](#preparedspeechjs) | esm | Owns detached ordered preparation, semantic audio reuse, and per-caller cancellation behind AI.prepareTTS. | Browser / native WebView with injected synthesis and optional DBOPFS | Complete original inputs, ordered audio metadata, durable reuse, and observable preparation results. |
| [`PrintView.js`](#printviewjs) | esm | Prints current rendered content and title through one document-owned print lifecycle. | Browser / supported native WebView print implementation | Complete rendered snapshot, preparation cancellation, resource lifetime, and honest request result. |
| [`QRCode.min.js`](#qrcodeminjs) | classic-script | Vendored QRCode generator for DOM, canvas, SVG, and image output. | Browser vendor script | Vendor-native. |
| [`Questionnaire.js`](#questionnairejs) | esm | Evaluates whether a one-time questionnaire prompt is due without performing the prompt. | Cross-host | Normalized conservative boolean. |
| [`RecordLinkIndex.js`](#recordlinkindexjs) | esm | Parses record links and builds their normalized index. | Cross-host | Fully normalized. |
| [`RecordPassageIndex.js`](#recordpassageindexjs) | esm | Indexes text lines, page markers, dates, rules, and excerpts for record review. | Cross-host | Fully normalized. |
| [`RecordReviewStore.js`](#recordreviewstorejs) | esm | Stores normalized record-review decisions through native storage or app-scoped local fallback. | Browser/native hybrid | Complete records preserved; unreadable stored content fails observably. |
| [`RiskSignalAnalyzer.js`](#risksignalanalyzerjs) | esm | Matches configured risk signals and levels against complete text. | Cross-host | Fully normalized. |
| [`ScamRiskPolicy.js`](#scamriskpolicyjs) | esm | Combines deterministic scam signals with optional Arcane blocked-domain evidence and safety guidance. | Cross-host | Complete mutable results; blocked-domain policy requires `secure:true`. |
| [`ScopedOPFSCache.js`](#scopedopfscachejs) | esm | Provides a narrow exact-key JSON cache inside one app-owned OPFS namespace. | Browser / native WebView | Filename-safe keys, complete JSON values, and malformed-cache cleanup normalized; storage errors mixed. |
| [`ScreenCapture.js`](#screencapturejs) | esm | Captures a display surface as image, video, or GIF with explicit lifecycle events. | Browser / native WebView | State/events normalized; permission and codec errors mixed. |
| [`SpeechPlayback.js`](#speechplaybackjs) | esm | Admits complete speech segments to a capacity-advertising provider immediately, retains serialized native/custom lookahead, and plays every result in exact indexed order. | Browser + native bridge | Stored part text stays exact; the outbound speech-input copy receives automatic formatting-mark cleanup; provider/media failures remain mixed. |
| [`StaticDocumentCatalog.js`](#staticdocumentcatalogjs) | esm | Loads a positive static document inventory with cache, search, and complete context. | Browser / native WebView / server with fetch | Mutable complete catalog/content normalization; malformed data and transport failures remain visible. |
| [`SystemAppearance.js`](#systemappearancejs) | esm | Reads or applies native appearance, returning an explicit unsupported browser state when no bridge exists. | Browser/native hybrid | Absent bridge normalized; native result/error preserved. |
| [`SystemPlatformPresentation.js`](#systemplatformpresentationjs) | classic-script | Maps kernel names to presentation labels/classes without granting platform authority. | Browser / native WebView classic script | Fully normalized presentation only. |
| [`SystemToolRegistry.js`](#systemtoolregistryjs) | esm | Registers validated command builders and constructs command strings without executing them. | Cross-host | Fully normalized definitions/quoting. |
| [`TerminalClient.js`](#terminalclientjs) | esm | Maps native terminal sessions and Arcane events into an EventTarget client. | Native bridge | Client events/state normalized; native result/error mixed. |
| [`TerminalCommandRegistry.js`](#terminalcommandregistryjs) | esm | Routes parsed command lines to injected handlers and provides definitions/completions. | Cross-host | Parsing/routing normalized; handler result/error preserved. |
| [`ThemeBootstrap.js`](#themebootstrapjs) | esm | Loads authoritative appearance preferences and observes existing User readiness without blocking rendering. | Browser/native hybrid | Theme state normalized; storage/native errors mixed. |
| [`ThemeManager.js`](#thememanagerjs) | esm | Loads, applies, previews, saves, resets, and synchronizes semantic Arcane themes. | Browser/native hybrid | Theme values/events normalized; storage/native failures mixed. |
| [`ThemePresentation.js`](#themepresentationjs) | classic-script | Restores app-scoped presentation before CSS and owns complete skin-class application. | Browser / native WebView classic script | Synchronous presentation only; saved profile and preferences remain authoritative. |
| [`TimeGuard.js`](#timeguardjs) | esm | Persists and evaluates clock rollback and grace-period state. | Browser / native WebView | Time decisions normalized; storage lifecycle mixed. |
| [`ToolCallRouter.js`](#toolcallrouterjs) | esm | Parses OpenAI-style tool calls and dispatches complete or streamed calls to injected handlers. | Cross-host | Argument records validated; handler results returned or all-settled. |
| [`uPlot.iife.min.js`](#uplotiifeminjs) | classic-script | Vendored uPlot chart constructor and rendering runtime. | Browser vendor script | Vendor-native. |
| [`uPlot.LICENSE.txt`](#uplotlicensetxt) | license | License companion for the bundled uPlot vendor runtime. | Documentation asset | Not executable. |
| [`uPlot.min.css`](#uplotmincss) | stylesheet | Bundled uPlot presentation stylesheet. | Browser stylesheet | Presentation only. |
| [`VoiceCaptureWorklet.js`](#voicecaptureworkletjs) | worker | Segments and encodes continuous microphone audio on the audio rendering thread. | AudioWorkletGlobalScope | Rolling pre-roll, activity/quiet/periodic boundaries, complete WAV clips, and final stop acknowledgement. |
| [`WaitForComponent.js`](#waitforcomponentjs) | esm | Waits for a component property, method, or readiness event with optional error event and bounded timeout. | Cross-host EventTarget / browser component | Normalized coded readiness, error, and timeout results. |
| [`YouTubeMedia.js`](#youtubemediajs) | esm | Parses YouTube video/playlist locators and constructs ordinary embed URLs with opt-in privacy enhancement. | Cross-host | Fully normalized mutable locators. |

## AI.js

### Overview

Provider-selectable chat, speech-to-text, text-to-speech, tool calling,
structured output, streaming, bounded synthesis, and ordered audio-clock
playback.

### Public surface

default `AI`; read-only `providerRuntime`, `speechActivationPending`, `browserSpeechConfiguration`, and
`browserSpeechDescriptor`; `configureBrowserSpeech(configuration,{signal})`,
`disposeBrowserSpeech({signal})`, `setAI()`, `configureProviders()`,
`configureSpeechProviders()`, `configureSpeechProvider(role,provider,options)`,
`transitionAI()`, `transitionProviders()`,
`transitionSpeechProviders()`, `startProviders()`, `setSpeechMuted()`,
`streamRequest()`, `streamMessage()`, `fetchRequest()`, `fetch()`,
read-only `ttsSegmentation`, `configureTTSSegmentation()`,
`streamTTS(text='',end=false,options={})`,
`prepareTTS({parts,storage,identity,signal,onState})`,
`playPreparedTTS(prepared,{signal,onState})`,
`finishTTS()`, `prepareTTSPlayback()`, `fetchTTS()`, `fetchSTT()`, `stopAudio()`, `resumeAudio()`,
`playAudio()`; consumes `user-entity-loaded` and `arcane-ollama-ready`,
installs `window.ai`, and emits `ai-ready` and `ai-tts-failure`.

`fetch(...)` and `fetchRequest(options)` are asynchronous complete-response
entry points. `streamMessage(...)` and `streamRequest(options)` deliver
incremental responses. The positional and object forms share the existing
provider implementations; neither form is a retired compatibility API.

`fetchRequest({model,...})` and `streamRequest({model,...})` accept an optional
request-local model. On the built-in TWiN Cloud route, its exact value becomes
the outbound `model` field; native Ollama receives the same request-local value.
Omitting it or passing `undefined` preserves the configured model. Each built-in
request captures its model before asynchronous callbacks, so concurrent requests
may use different models without assigning `ai.model`, changing provider
selection, or loading/unloading another model. Request observers and retries
receive that request's model. Stream/native completion metadata uses it only
when the provider omits its own `model` field.

Registered providers receive a supplied `model` unchanged in their request
payload; an omitted value remains absent. The provider owns interpretation.
This option does not switch a loaded browser-WASM model or its lifecycle:
explicit provider/model selection and activation remain necessary there.

Both object-form methods also forward an optional request-local `temperature`
unchanged to built-in TWiN Cloud, including through its provider-runtime
adapter. Explicit `0` is preserved; omission or `undefined` leaves the outbound
field absent and preserves the provider default. The value is not clamped or
saved as a preference, concurrent calls remain independent, and retries reuse
the same value. This adds no output limit or native Ollama option mapping;
other registered providers retain their existing interpretation of the option.

Built-in cloud chat decodes an HTTP error body once as JSON or text and rejects
with that complete value unchanged. It does not reconstruct an Error, replace
the message, or add `providerMessage`, `status`, or an SDK failure code to the
provider body. Network errors pass through after the retry policy below;
decoding errors pass through immediately. Cancellation
retains the existing `ARCANE_AI_REQUEST_ABORTED` contract.

When the HTTP status is `429` and the existing `error.message`, `message`, or
plain-text body contains `overload`, ignoring case, the request retries after
three seconds without a retry-count limit. Each warning shows the complete
message followed by `Retrying in ${retryDelayMs / 1000} seconds` through the
shared console logger, separately from the provider error. Every attempt uses
the same destination, headers, complete serialized body, and cancellation
signal; `onRequest` runs once for the logical request. Cancellation stops the
delay and prevents another attempt. Retrying happens before a successful
response is consumed, so partial streams and tool callbacks are never replayed.
Rejected Fetch calls and HTTP `529` share a separate budget of three retries,
each after the same `3000` millisecond delay. HTTP `429` overload retries do not
consume that budget. The final complete network error or provider body passes
through unchanged when recovery is exhausted. Aborts, other HTTP errors,
successful-response body reads, stream decoding, and application callbacks
never start another attempt.

`fetchRequest()` and `streamRequest()` accept
`onRetry({phase,attempt,delayMs,status,error})`. The observer receives
`phase:'waiting'` before the abortable delay and `phase:'requesting'` immediately
before the next Fetch. `attempt` is the one-based upcoming retry number across
both retry policies; `delayMs` is `3000`; `status` is the HTTP status or `null`
for rejected Fetch; `error` is the complete original failure value. The SDK
invokes this observational callback synchronously and observes a returned
promise without awaiting it. Callback throws and rejections are logged through
the shared console owner without changing request success or causing retries.
The callback remains outside model payloads and is forwarded through built-in
provider controls, including queued requests, with the request owner's existing
cancellation lifetime. Native Ollama and externally supplied provider adapters
retain their own transport behavior.

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
hiding a load. Explicit speech preference slots remain unchanged, including a
selected external provider that the application registers after AI startup.
TWiN Cloud availability
requires the selected LLM route, its model, a credential, and `fetch`; Core speech
availability requires the exact selected `Arcane.speech.transcribe` or
`synthesize` method. `fetchRequest()`
keeps the selected provider's public response shape. Browser speech routes
translate the existing AI.js STT `{audio:Blob|File,mimeType,model}` and TTS
`{model,input,responseFormat,voice?,speed?}` requests at the provider boundary;
the selected provider declares its supported audio format. TTS voice selection comes from
the exact selected provider/model catalog `defaultVoice`; a saved
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
roles must be unloaded and own no request, load, unload, or dispose operation.
File-based STT remains local-only (`AI_STT_DEVICE_ONLY` for an unsupported
remote file selection). An explicitly selected native live-capture STT provider
or TTS provider may declare `localOnly:false`.
`transitionSpeechProviders({stt,tts})` stops queued audio, explicitly unloads
only STT and TTS, then commits that same closed speech route record. Neither
method loads a model, selects a fallback, or changes caller-owned model or voice
policy.

`configureSpeechProvider(role,provider,{modelId,signal,expectedProvider})`
asynchronously registers and selects one provider/2 speech role, unloading and
disposing only its previous SDK-owned provider. `modelId` defaults to the first
catalog entry. It returns the selected `{providerId,modelId,localOnly}` record;
passing `null` removes that role and returns `null`. An optional
`expectedProvider` is compared inside the configuration lane; if another
provider has taken ownership, removal resolves `false` without changing it.
An unaccepted candidate is disposed on failure; a failure after replacement
has `committed:true`, and runtime ownership identifies the installed provider.

This method composes with an STT-only or TTS-only `configureBrowserSpeech()`
in either order. The other speech role and LLM keep their routes, readiness,
requests, and storage. Use sequential disposal when combining this method
with `disposeBrowserSpeech()`. Configuration does not activate the new provider
or make a network request. `setSpeechMuted(false)` waits for an in-progress
configuration before activating the committed TTS selection; a later mute
cancels that pending unmute. The application keeps model, voice, and credential
selection. See [DigitalOcean FAL speech](ai/browser-speech.md#digitalocean-fal-text-to-speech)
for the public remote adapter and completed-job audio transport.

`supportsTranscriptionCapture()` reports whether the selected STT provider
offers native live capture. `createTranscriptionCapture(options={})` delegates
to the provider runtime's owned capture boundary below and returns `null` for
file-only providers. Shared speech controls select it automatically; apps keep
using their existing controls and completion/save callbacks. See
[native browser recognition](ai/browser-speech.md#native-browser-speech-recognition).

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
An explicit unmute may wait for its selected external provider to register.
`speechActivationPending` distinguishes that intent from an ordinary muted
state. Streamed text and its final remainder may enter the existing speech
queue during that wait; synthesis waits for the same activation promise.
Text never activates a provider itself. Stop cancels queued preparation even
while registration is pending; mute, disposal, a new startup operation, or an
actual route replacement also revoke the pending activation. Initial
registration of the already-selected provider/model preserves queued speech.
The optional browser-speech `stt.execution` and `tts.execution` records select
`device:'auto'|'webnn-npu'|'webgpu'|'wasm'` and `maxConcurrentRequests`.
Omission uses NPU, GPU, then CPU automatic selection with one Whisper slot and
four bounded Kokoro Worker/session slots. Whisper accepts only capacity 1;
Kokoro accepts integers 1 through 4. Automatic loading attempts WebNN NPU when
`navigator.ml.createContext` is exposed, then WebGPU when `navigator.gpu` is
exposed, then WASM. A failed candidate is cleaned up before fresh Workers try
the next device with the same prepared model and dtype. Explicit device
selections report failure without falling back.
Capacity 4 means up to four segments synthesize at once. Segment 5 and later
wait in the SDK's FIFO queue; they are not dropped. Synthesis may finish out
of order, but playback waits for earlier segments and plays exact input order.
Each slot owns a Worker/model session, so raising capacity trades memory for
latency. This capacity does not establish physical GPU kernel overlap.

After configuration, explicitly inspect execution through
`ai.providerRuntime.status('tts', {execution:true}).execution`. When supplied
by the selected provider, this read returns its execution snapshot. Whisper and
Kokoro report `requestedDevice`, `selectedDevice`, `maxConcurrentRequests`, and
`activeRequestCount`. `selectedDevice` is `null` before load and after unload.
`requestedDevice === 'auto' && selectedDevice === 'wasm'` identifies automatic
WASM fallback after a successful load. Read the same fields for Whisper with
`status('stt', {execution:true})`. The selected device is the backend requested
by a successful upstream session load, not proof that every operation ran on a
physical accelerator; WebNN may execute unsupported operations through WASM.
Calling `status()` without options keeps
the existing sticky lifecycle snapshot and does not inspect provider execution.
Provider inspection failures are surfaced to the caller.
`fetchTTS({model,voice,input,responseFormat,speed},signal,preparation={})` accepts the public
provider-neutral synthesis shape, requires any explicit model to match the
selected route, and fills an omitted voice only from the selected model
catalog's `defaultVoice`. An omitted response format preserves the instance's
existing `audioFormat` when the catalog does not declare response formats. When
the selected model declares `speech.responseFormats`, that setting is used only when supported; if
the setting is the instance's `opus` default and the model rejects it, the catalog's
`speech.defaultResponseFormat` is used, while any other unsupported setting is
rejected. It propagates the caller-owned signal and returns a playable `Blob`.
The native `LOCAL_SPEACH` route forwards that signal separately from its
synthesis payload to `Arcane.speech.synthesize(request, {signal})`; Core aborts
are normalized to `AbortError` with `ARCANE_AI_REQUEST_ABORTED`. Actual engine
interruption belongs to the registered service. It does not independently
choose a provider, cloud fallback, model, runtime, or
voice policy for the application. Every call removes repeated same formatting
marks from a cloned outbound input before delegation; the caller's payload stays
unchanged. The third `preparation` argument is reserved for SDK-internal
delegation, where `{speechInputPrepared:true}` prevents a second cleanup pass;
applications omit it. `streamTTS(text='',end=false,options={})` and
`finishTTS()` use the selected playback boundary. The third-argument options below
are available in SDK `0.5.12`. The `textFormat` compatibility extra added in
SDK `0.5.16` is ignored beginning in `0.5.17`:

| Field | Default | Meaning |
| --- | --- | --- |
| `voice` | Current selected model's default voice | A supplied voice is captured for every segment extracted by this call and forwarded unchanged to `fetchTTS()`. It does not change the instance or provider default. |
| `speed` | Current `ai.voiceSpeed` | A supplied positive speed is captured for those segments and forwarded to `fetchTTS()`. It does not change `ai.voiceSpeed`. |
| `pauseAfterMs` | `0` | Finite, nonnegative milliseconds placed after the final extracted segment on the existing audio clock. Invalid values throw `RangeError`; no pause is inserted between this call's other segments. |
| `waitForPlayback` | `false` | Omission retains the preparation promise. With `true`, the promise resolves after every extracted segment reaches a terminal playback state: `true` when all naturally end, or `false` after terminal cancellation or failure. |
| `textFormat` | Ignored compatibility extra | Repeated same formatting marks are removed automatically from every TTS call. This value no longer selects or disables cleanup. |

Audio-file voice and speed use the existing `fetchTTS()` validation and error path.
The automatic cleanup changes only the outbound speech-input copy; displayed,
stored, model, and caller-owned content remains exact. It is a narrow
formatting-mark filter, not a full Markdown parser: links, code contents, list
text, single marks, ordinary punctuation, and other characters remain literal.
A trailing candidate mark waits for the next character so a repeated run split
across chunks is still omitted. Ordinary prose streams immediately.
`end:true`, `finishTTS()`, muted terminal calls, and `stopAudio()` clear pending
formatting state. `textFormat` is not an opt-out.

Voice, speed, pause, and playback overrides belong to the segments
extracted in that invocation, including any text buffered by an earlier call.
Those overrides are not retained with an unfinished `end:false` remainder; a
later call supplies its own options, and `finishTTS()` uses their defaults
while flushing any pending formatting mark. Use `end:true`
for a complete passage. A call extracting no segments resolves
`true` without waiting for earlier jobs; `finishTTS()` remains a preparation
flush, not a queue-wide playback barrier. A muted call resolves `false`.

`prepareTTSPlayback(payload,signal,preparation={})` is the silent playback-oriented
request. Audio-file providers retain the `fetchTTS()` Blob contract; a selected
model with `speech.playback:'native'` returns an inert `native-speech` descriptor.
Its `play({signal,onState})` returns native completion and lifecycle controls.
The preparation signal remains its default playback signal. Native input stays
complete; per-request voice/language/speed and the configured model default own
selection, without reading global user voice or conversation-language fields.
Native streaming jobs wait for actual end in order and allocate no AudioContext.
When native speech follows recorded audio, the preceding audio clock still owns
its requested inter-part pause. Native trailing silence delays the next part,
not the completed playback promise; cancellation retires either pending gap.
Failed native control remains owned through its `released` promise, so Stop can
still reach it and subsequent buffered audio cannot overlap it. Explicit saved
Blob playback continues to use its own AudioContext even when native speech is
the currently selected provider. `fetchTTS()` and durable `prepareTTS()` report
`ARCANE_AI_TTS_AUDIO_EXPORT_UNAVAILABLE` for native selection; no audio file is
fabricated. See [native voice catalogs and previews](ai/browser-speech.md#native-browser-text-to-speech-and-voice-previews).

Playback completion stays pending while the browser waits for an audio-unlock
gesture or a recoverable resume attempt. If resuming a closed `AudioContext`
fails, the affected jobs terminate and their playback results settle `false`.
`stopAudio()` cancels streamed speech and prepared playback owned
by this AI instance and settles pending playback promises `false`; detached
preparation retains its own cancellation lifetime. A trailing
pause delays the next queued audio; the preceding promise resolves when its
last audio buffer ends, without waiting out that pause. Completion describes
the playback lifecycle, not proof that a listener heard the sound. See the
[complete-passage example](ai/browser-speech.md#queue-complete-passages-and-wait-for-playback).

`prepareTTS({parts,storage,identity,signal,onState})` returns an immediate
`{segments,state,ready,getAudio(index),cancel()}` handle for detached complete
speech preparation. Parts are strings or `{input,voice?,speed?,pauseAfterMs?}`
records. It retains the full source for semantic matching, snapshots the
selected speech configuration and segmentation, and applies automatic
formatting cleanup once to the speech copy. Generation uses the existing
bounded provider queue without adding playback. Optional
`storage:{db,table,key}` saves complete audio files and their MIME metadata in
the caller's ready DBOPFS instance; the separate JSON-compatible `identity`
adds application-owned semantic context. Reuse compares complete inputs rather
than an SDK version alone.

`state` is `queued`, `preparing`, `ready`, `error`, or `cancelled`.
`onState({state,completed,total,segments,error})` synchronously observes
preparation progress. `ready` resolves the complete record after every segment
is ready and, when storage is selected, durably saved. `getAudio(index)` waits
for the corresponding ordered segment and returns its complete `Blob` with
the retained MIME type. Preparation failure rejects; cancellation rejects as
`AbortError` and preserves successfully stored segments. Matching pending
requests share synthesis only on the same AI instance and storage group;
cancelling one handle does not cancel another active matching caller.
Preparation cancellation prevents later synthesis, but an already-started
shared provider load/unmute has no per-preparation signal and may finish.

`playPreparedTTS(prepared,{signal,onState})` can attach immediately. Its returned
`{state,error,finished,pause(),resume(),stop()}` handle schedules segments in
their original order using the existing AI audio clock. `finished` resolves `true` after
natural completion and `false` after stop, cancellation, or failure; genuine
failures also use the existing complete diagnostics and `ai-tts-failure` event.
Part pauses separate adjacent audio; the final trailing pause does not delay
`finished` after the final audio buffer ends. State/error getters and the
optional synchronous `onState({state,error})` callback expose `waiting`,
`waiting-for-gesture`, `scheduled`, `paused`, `complete`, `stopped`, or `error`.
Use `waiting-for-gesture` for audio-unlock UI; a `false` result from `resume()`
alone is not a first-segment-ready signal.
Pause and resume are asynchronous boolean controls scoped to that handle's
audio context; stop is synchronous. Playback completion and these controls do
not cancel independent preparation. One AI has one playback lane: attaching
prepared playback replaces its preceding streamed or prepared audio, and
`streamTTS()` interrupts active prepared playback. `stopAudio()` stops all
this AI's playback but keeps detached preparation running; `setSpeechMuted(true)` also cancels
provider TTS work and unloads it. Replacing the selected speech configuration
cancels missing generation for that earlier selection. Completed stored audio
remains in application storage.
Fully stored replay enables playback without loading the selected speech
model even when the AI starts muted. Missing audio alone requests the shared
TTS readiness path. See [prepared narration](ai/browser-speech.md#prepare-narration-once-and-replay-stored-audio)
for full record shapes, storage ownership, and a complete example.

Streaming speech retains sentence
segmentation by default. `configureTTSSegmentation({punctuation,wordCadence})`
accepts `punctuation:'sentence'|'any'|'none'` and a `wordCadence` that is either
`null` or a positive integer. `punctuation:'any'` completes a segment at a
Unicode punctuation run without requiring following whitespace. Apostrophes,
commas, and hyphens remain inside a segment when they join Unicode letters or
numbers. A potentially joining mark at the current end of an incremental stream
waits for the next character or terminal flush before the boundary is decided;
`wordCadence` completes one after that many whole words. The earliest available
boundary wins. Segmentation preserves every character of the already prepared
speech text, including punctuation and whitespace. Every completed segment
enters synthesis immediately; provider
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
`fetchSTT(audioFile,signal)` propagates the caller-owned signal, including the
native `Arcane.speech.transcribe(request, {signal})` route. The native signal
remains separate from the complete audio request; Core aborts are normalized
to `AbortError` with `ARCANE_AI_REQUEST_ABORTED`.
Provider routes accept a `Blob` or `File` directly and leave media decoding,
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
receives each provider chunk after private structural fields are removed, while
`onChunk` receives every nonstructural content or reasoning value from every
choice in provider order. After the stream settles, `onDataResult` receives the
complete terminal completion, `onResponse` receives that same unprojected
provider response, `onToolCall` runs exactly once for each complete normalized
structural call, and `onComplete` receives the application-facing output. That
output is the ordered structural-call array when the selected result contains
tools, the complete completion object when it contains multiple choices, or
the ordinary single-result text/completion otherwise; later choices are never
discarded.
Raw structural deltas remain private until the matching terminal envelope
validates. To display one tool argument's text as it arrives, supply
`toolText:{name,field}` and `onToolText(text,call,displayId)`. `name` is the exact
tool name and `field` is one root-level string argument. The callback receives
each newly decoded text fragment in order, including whitespace and JSON string
escapes decoded to their original characters. Its `call` record contains
`{id,name,field,index,choiceIndex}`; `id` is the actual normalized tool-call ID,
`index` identifies the call within its choice, and `choiceIndex` identifies the
response choice. Delivery starts once the matching tool name and call ID are
known. `displayId` is the same `M-${id}` request display ID used by `onChunk`.

`onToolText` is separate from ordinary `onChunk`, so callers can append to the
tool's existing display without duplicating assistant prose or saved history.
It observes text only: it does not execute a tool, alter arguments, persist a
turn, or change the terminal callbacks. A provider that supplies arguments only
at completion emits text only when that complete response arrives. Repeated
terminal snapshots do not replay text already emitted. Omitting `toolText`
preserves the existing callback path. Invalid selection or callback input throws
`TypeError`; malformed selected argument text reports
`ARCANE_AI_TOOL_TEXT_INVALID`. Callback errors reach the request owner and
cancellation prevents later delivery.

Cancelling an HTTP tool-text stream still cancels and releases its reader and
rejects with the ordinary request `AbortError`. If reader cancellation repeats
that expected abort, it is not reported as a cleanup failure. Other reader
cleanup errors remain visible in developer-console diagnostics.

Request observers receive
`onRequest(request,id,metadata)` and any transport metadata supplied by the
selected route is forwarded unchanged. Async request, response, content, and
tool callbacks are observed before the next callback or terminal settlement.
The observational `onRetry` callback has the separate nonblocking behavior
described above.

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
mutable STT or TTS role is exactly
`{providerId,graph,security?,offline,execution?}` or
`{providerId,model,runtime,security?,offline,execution?}`. The optional
`execution` record contains `{device,maxConcurrentRequests}` with the
role-specific defaults and capacities described above. The graph and
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
`{role:'stt',providerId,modelId,artifactGraphId?,offline,execution}`; TTS adds
`defaultVoice`. Both include the normalized `execution` record.
`artifactGraphId` is present only for the graph form.
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

## AIModelSelectionController.js

### Overview

Use existing native selects to edit provider/model preferences while saved
preferences or an optional model inventory arrive asynchronously. The controller
owns only selection and option rendering. Applications retain their labels,
catalogs, defaults, saved preferences, model readiness, and explicit activation.
Importing or constructing it never loads a model, starts discovery, or writes
User preferences or storage.

### Public surface

Exact exports: `AIModelSelectionController`, `default` (the same class).

`new AIModelSelectionController({selects, defaults, catalogs, inventory})` accepts
six existing selects by the following names. Tuples use this exact order:

| Index | Select key | Selection |
| --- | --- | --- |
| 0 | `llmProvider` | LLM provider |
| 1 | `sttProvider` | Speech-to-text provider |
| 2 | `ttsProvider` | Text-to-speech provider |
| 3 | `llmModel` | LLM model |
| 4 | `ttsModel` | Text-to-speech model |
| 5 | `sttModel` | Speech-to-text model |

`defaults` is an optional tuple; omitted slots use the selects' initial values.
Optional `catalogs` uses those same six keys, with arrays of strings or
`{value, label, provider?, disabled?}` records. The LLM model catalog also accepts
`CoreLocalModelCatalog` records shaped `{preferenceValue, providerValue, label}`.
Only the LLM model list uses provider filtering; existing options may supply
their provider in `data-provider`. An initial LLM option without that attribute
belongs to the initial default LLM provider. An explicitly supplied catalog entry
without a provider is shared across providers. Rendered options retain their
provider metadata. Caller catalog entries merge with the selects'
existing options, retaining supplied disabled states. Entries with the same value
use the later catalog definition, and discovered entries take precedence over
authored entries. Unknown saved selections receive an option
containing their exact value; values and labels are never trimmed or shortened.

- `getSelection()` returns a mutable copy of the current six-slot tuple.
- `hydrate(tupleOrPromise)` explicitly applies saved selections. Missing tuple
  entries use application defaults. Native `input` or `change` edits made after
  hydration starts survive its completion, and the LLM provider/model pair is
  preserved together when either is edited. The newest hydration owns updates.
- `discover()` explicitly invokes optional `inventory({selection, signal})`.
  The caller returns per-slot catalog arrays; they merge with authored options
  without replacing selected values or drafts. A newer discovery aborts the
  preceding signal and owns subsequent catalog updates. There is no polling.
- `state` returns `{hydrating, discovering, disposed, hydrationError,
  discoveryError}`. Async failures retain their complete rejection objects.
- `dispose()` removes the owned native listeners, aborts pending inventory work,
  and prevents late hydration or discovery from changing the controls. New work
  after disposal rejects; existing asynchronous callers still own their promises.

Successful `hydrate()` and `discover()` calls resolve a current six-slot tuple
copy. Superseded successful operations also return the current selection without
reapplying their older data. `discover()` with no inventory callback returns the
current selection without starting work. `dispose()` returns `true` on its first
call and `false` on subsequent calls; the last selection remains readable.
When constructing a new controller over the same controls, supply the complete
app catalogs again: provider-filtered choices are retained by the current
controller, while only the current provider's choices appear in the DOM.

When the user changes the LLM provider, the controller remembers the preceding
provider's model. Returning to a provider restores its remembered model.
Otherwise, it selects the application's default provider/model pair when
applicable, the first enabled matching catalog model, or an empty value.
An explicitly saved or remembered disabled selection is retained.
It never carries a different provider's model forward as the new selection.
The other four slots remain independent.

### Availability and normalization

**Browser / native WebView.** This controller requires supplied select elements,
uses native `input` and `change` events, and creates no custom event bus. It does
not query Core or infer readiness from inventory presence. An application may
provide an inventory callback that obtains `localAI.status` and passes its
`CoreLocalModelCatalog` projection; platform access remains with that caller.

Missing controls, non-string selection values or labels, a non-array hydration
result, and a supplied non-function inventory raise `TypeError`. Hydration and
discovery preserve complete caller failures through their promises; the latest
operation also records its error in the corresponding state field. Disposal
errors describe that lifecycle boundary. Selection itself has no persistence,
network, provider-transition, or activation side effect.

### Example

This example uses an app-owned form containing the six named selects above and
a `<pre id="selected-models">` result. Their existing options and initial values
are the catalog and defaults, so changing one control visibly shows the tuple
the application can choose to save. No model policy or storage is added.

```javascript
import AIModelSelectionController from 'arcane-os/modules/AIModelSelectionController.js';

const form = document.querySelector('#model-preferences');
const controller = new AIModelSelectionController(
    {
        selects: form.elements
    }
);

form.addEventListener(
    'change',
    function showModelSelection() {
        document.querySelector('#selected-models').textContent = JSON.stringify(
            controller.getSelection()
        );
    }
);

// Call controller.dispose() when the owning settings view is removed.
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

**Cross-host.** The slot-order array and returned tuples are mutable. Existing
token trimming, aliases, caller-selected allowed values, and default selection
are unchanged. `AIModelSelectionController` reuses the canonical slot order
without applying token normalization to saved selections. Transport: In-process
only. [Deep protocol details](protocols.md).

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
`disposeAll(options={})`; `cancel(role)`;
`request(role,options={},preparation={})`;
`chat(payload,options={})`; `stream(payload,options={})`;
`transcribe(payload,options={})`;
`supportsTranscriptionCapture(providerId=null)`;
`createTranscriptionCapture(options={})`;
`synthesize(payload,options={},preparation={})`; and
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

Every direct TTS `request()` or `synthesize()` call removes repeated same
formatting marks from a cloned outbound payload's `input` or `text` field. The
caller's payload and request records remain unchanged. The optional
`preparation` argument is reserved for SDK-owned delegation;
`{speechInputPrepared:true}` prevents a second pass after another SDK speech
boundary has already cleaned the copy. Applications omit that argument. LLM
and STT payloads are unaffected.

SDK-owned LLM delegation also carries `onRetry` in the separate `preparation`
control record, alongside `observeToolText` for streams. The runtime preserves
these controls across its request queue and passes them to the selected
provider without inserting callbacks in the provider payload. Applications use
the `AI.fetchRequest()` and `AI.streamRequest()` options described above.

`register()` returns the provider's single unregister closure; caller-
registered providers remain caller-owned. The high-level
`AI.configureBrowserSpeech()` boundary is different: AI constructs, registers,
atomically replaces, unregisters, and disposes those two SDK-owned providers.
`status()` is the sticky mutable AIRuntimeState snapshot (or one role record),
while `catalog()` synchronously returns mutable provider/model entries and
never loads or downloads a model. `load()` forwards provider progress into the
sticky role record; `unload()` and `dispose()` abort owned work, await exposed
settlement, and verify provider status before publishing terminal state.

`status('stt', {execution:true})` or `status('tts', {execution:true})` explicitly
reads the selected provider and adds its optional `execution` snapshot to a
copy of the role record.
`status(null, {execution:true})` provides the equivalent projection under
`roles.llm`, `roles.stt`, and `roles.tts`. Providers that do not supply execution
omit that field. No provider load or sticky-state event is triggered; default
`status()` keeps its existing identity and behavior. A provider inspection
error propagates. Each Whisper or Kokoro execution report contains `requestedDevice`,
`selectedDevice` (`null` while unloaded), `maxConcurrentRequests`, and
`activeRequestCount`. The selected device names the backend requested by a
successful upstream session load. It does not prove that every operation ran
on a physical NPU or GPU, or that accelerator kernels overlap; WebNN may use
WASM for unsupported operations.

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

An STT provider's request context also supplies `refreshState()`. An engine
lifecycle observer may call it to reread `provider.status()` while that exact
request remains active. A recovering or failed pending request is observed as
`loaded: false`, `busy: true`, with its existing runtime operation ID; the
callback does not make a new request ready or change its supplied payload.
After cancellation, unload, disposal, replacement, or settlement it has no
effect on the retired request.

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

STT providers may additionally implement `createCapture(options)`. Registration
retains that optional method without changing the required provider/2 methods.
`supportsTranscriptionCapture(providerId=null)` checks the current selection by
default or a specified registered STT provider without starting it.
`createTranscriptionCapture({language,continuous,onSegment,onInterim,onState,onError})`
returns `null` for a provider without that method; otherwise it returns
`{start,stop,cancel,destroy,done}`. Creation has no microphone side effect.
`start({signal})` requires the same selected ready provider with an idle STT
lane and invokes its capture start synchronously in the caller's gesture.
Capture occupies one active STT request until its `done` promise settles;
ordinary file requests remain queued, and unload/dispose/cancel use the same
owned request cancellation lifecycle. Stop drains native final recognition;
cancel suppresses late callbacks. Provider callbacks carry exact final
`{text,sequence}` segments, transient `{text}` interim results, capture state,
or complete errors. The browser provider's `done` resolves a success boolean;
runtime cleanup errors remain observable as rejection. No callback is inserted
into a data-only transcription request payload.

### Example

```javascript
import {getAIProviderRuntime} from '/arcane/modules/AIProviderRuntime.js';

const runtime = getAIProviderRuntime();
console.log(runtime.protocol, runtime.status());
```

## AIResponseURLPolicy.js

### Overview

Extracts and audits links from AI Markdown, rendered HTML, CSS, srcset, bare URLs, and email text.

### Public surface

`auditAIResponseLinks()`, `extractAIResponseLinks()`, `normalizeAIResponseLink()`, `decodeHTMLCharacterReferences()`.

Exact exports: `auditAIResponseLinks`, `decodeHTMLCharacterReferences`, `extractAIResponseLinks`, `normalizeAIResponseLink`.

### Availability and normalization

**Cross-host.** Returns a mutable `{ok, links, unsupportedLinks, allowedLinks}`
audit. Browsers use detached native HTML elements to parse rendered markup and
decode character references. Hosts without a document retain lexical extraction
and the existing limited entity decoder. Rendered values are decoded only once.
Markdown destinations, CSS URLs, srcset candidates, and authored source positions
remain part of the audit; DOM-only attribute links use document order after
authored links because the DOM does not expose source offsets.

Comparison uses exact values after entity and Markdown escape decoding. URI
encoding, decoding, or URL canonicalization would change those values and is
not applied. The audit neither changes the response content nor fetches or
navigates to links. Transport: In-process; bundled Marked parser.
[Deep protocol details](protocols.md).

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
`AI_RUNTIME_STATE_EVENT`, `continuesAIRuntimeOperation`, `getAIRuntimeState`,
`publishAIRuntimeRoleState`, `publishAIRuntimeRolesState`,
`requestAIRuntimeIntent`, `startAIRuntime`, `subscribeAIRuntimeIntents`, and
`subscribeAIRuntimeState`.

Each role record is exactly `{role,state,providerId,modelId,localOnly,loaded,
busy,operationId,progress,error}`.
`continuesAIRuntimeOperation(previous,current,operationId)` identifies the same
already-owned provider/model/runtime operation in a busy, unloaded `recovering`
or `error` observation. Pass the actual runtime operation ID, not a component's
local counter. It grants neither readiness nor permission to start new work.
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
`recovering`, `ready`, `unloading`, `error`, and `disposed`. Recovery remains
`loaded: false`; `recovering` and `error` may retain `busy: true` with an actual
`operationId` until the pending request settles. Revisions increase monotonically.
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
helpers. `normalizeVoiceOptions(input,previous)` keeps `capture.mode:'manual'`
and `controls:'standard'` as defaults. Continuous capture accepts
`{mode:'continuous',preRollMs:1500,quietMs:2000,chunkMs:30000,activityThreshold:0.02}`;
`controls:'simple'`, `showComplete`, and the `retry`/`cancel` labels configure
the shared voice component. Positive quiet/chunk durations and nonnegative
pre-roll/activity values must be finite. Complete callback payloads remain
owned by the component and application.

`normalizeMarkdownOptions(input,previous)` adds strict opt-in `fit` and
`followPreview` booleans, both defaulting to `false`. Omitted fields preserve
the corresponding previous value; explicit `false` disables the option.
Existing Markdown labels, formats, visibility, read-only state, save behavior,
callbacks, complete initial Markdown, and plain initial title remain intact.
The shared editor consumes these options for bounded responsive panes and
body-edit preview following; the normalizer itself performs no DOM work.

`createSTTActivationController({host,button,progress=null,onChange,EventClass=CustomEvent})`
consumes only normalized
[`AIRuntimeState`](#airuntimestatejs) `stt` role records. Its mutable controller
exposes `action`, `error`, `label`, `pending`, `selected`, `status`, `title`, and
`visible` getters plus `request(action)`, `synchronize(role)`, and `destroy()`.
`host` supplies `dispatchEvent(event)` and `requestSTTActivation(intent)`;
`button` supplies `addEventListener()` and `removeEventListener()`; and
`onChange()` is called whenever presentation should be rendered again. Browser
callers use the default `CustomEvent`; non-DOM callers must inject a compatible
`EventClass` constructor.

An optional native `progress` element presents the active loading phase. Known
file or session totals produce determinate progress; an unknown total remains
indeterminate. The shared status includes the complete loading message, current
file, completion count, and reported elapsed time. Terminal state and destruction
clear the loading display without starting any provider work.

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

## ContinuousVoiceCapture.js

### Overview

Owns a continuous microphone session whose audio worklet keeps rolling
pre-roll and produces complete clips at quiet or periodic boundaries. The
capture owner has no model, transcription, persistence, or application policy.
The shared [`voice-transcription.html`](runtime-components.md#voice-transcriptionhtml)
component adds ordered STT, persistence, retry, and presentation.

### Public surface

Default export `ContinuousVoiceCapture` accepts
`{preRollMs=1500,quietMs=2000,chunkMs=30000,activityThreshold=0.02,onSegment,onError,onState}`.
`start({mediaConstraints={audio:true},signal}={})` acquires microphone input and
resolves `true` once capture starts, or `false` after cancellation or a
reported start failure. Starting capture is an explicit caller action.

`onSegment({audio,sequence,reason,durationMs})` receives a complete
`audio/wav` Blob containing mono Float32 audio. Sequence starts at one for
each capture session; reason is `pause`, `periodic`, or `stop`. The detector
uses amplitude to find activity, including noise; it does not determine
whether a person is speaking. Inactive windows produce no clips. Pre-roll is
used once when activity starts, and periodic segments remain adjacent without
repeated samples. Pre-roll longer than `chunkMs` remains complete in the first
active clip, so that clip may exceed the periodic duration.

`stop()` releases microphone tracks immediately and returns a promise that
settles after the worklet flushes the final active clip and acknowledges stop.
Capture cancellation while microphone permission or worklet loading is
pending releases late-acquired resources. `cancel()` and `destroy()` discard
pending capture and suppress late segment delivery. They do not cancel
application work that already accepted a segment; its owner supplies that
cancellation boundary. The optional signal cancels this capture session.

`onState` reports `starting`, `listening`, `stopped`, or `interrupted`;
`onError` receives the original capture error. A naturally ended microphone
flushes the active clip before reporting interruption while the worklet remains
available. A failed audio context or processor reports interruption directly;
audio still inside an unavailable processor cannot be recovered. Callback
promises are observed without delaying capture or stop acknowledgement.
Capture state is independent
of model readiness, STT processing, and application save state.

### Availability and normalization

**Browser / supported native WebView.** Requires browser microphone access,
`AudioContext`, and `AudioWorklet`. Browser secure-context and permission rules
apply at those platform APIs. The static sibling
[`VoiceCaptureWorklet.js`](#voicecaptureworkletjs) owns sample processing and
WAV encoding on the audio rendering thread. No audio model or third-party
capture runtime is loaded. Native hosts use the same browser APIs where
available, with no Core service selected implicitly.

### Example

```javascript
import ContinuousVoiceCapture from '/arcane/modules/ContinuousVoiceCapture.js';

const capture=new ContinuousVoiceCapture({
    onSegment:queueTranscription,
    onError:showCaptureError,
    onState:showCaptureState
});
// Call from the application's explicit recording action.
await capture.start();
// The application's stop action waits for the final clip.
await capture.stop();
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

Seven constants/helpers for closing reports.

The generated sole-call schema requires both `message` and `final_message`.
`message` is brief user-facing progress shown while the application accepts and
renders the call. `final_message` remains the complete terminal closeout and is
never replaced by or duplicated into `message`; `remembered_actions` remains
optional. `normalizeConversationClosingReport()` returns
`{message,finalMessage,rememberedActions}`, while
`formatConversationClosingReport()` normalizes the complete report and formats
only `finalMessage`. Its shared `formatConversationClosingReportText(value)`
operation accepts a string, including an empty or whitespace-only chunk, and
replaces `&`, `<`, and `>` with `&amp;`, `&lt;`, and `&gt;` respectively. It
preserves all other text and does not trim, validate a report, render, or persist
anything. Use the same operation for live text chunks and complete final text.

An application may opt into completion metadata when creating the tool:

```javascript
import {createConversationClosingReportTool} from 'arcane-os/conversation-closing-report';

const tool=createConversationClosingReportTool({
    responseToUsersPromptComplete:{
        required:true,
        description:"Use true only when this response's messages and successful tool actions complete the whole current user request. Use false if any answer or action still needs a model response, whether or not this tool returns data."
    }
});
```

The option declares a boolean `responseToUsersPromptComplete` argument. Its
`description` must be a nonblank string and is preserved completely;
`required` defaults to `false`. Omitting the option preserves the existing
schema, including its required fields. This changes only the declaration, not
the closeout instruction or sole-call classifier.

`normalizeConversationClosingReport()` accepts that optional boolean in an
object or JSON string and preserves `true` or `false` in the returned record
under the same key. Omission leaves the key absent; other supplied types raise
`CONVERSATION_CLOSING_REPORT_INVALID` without coercion. The normalizer does not
consume factory options or enforce an application's required setting. The
application owns completion decisions, sibling-call handling, and continuation.
The flag is transient control metadata, not conversation content or a saved
history field. These helpers perform no persistence or orchestration, and the
formatter still returns only the formatted `finalMessage`.

Exact exports: `CONVERSATION_CLOSING_REPORT_TOOL_NAME`, `classifyConversationClosingReportCalls`, `conversationClosingReportInstruction`, `createConversationClosingReportTool`, `formatConversationClosingReport`, `formatConversationClosingReportText`, `normalizeConversationClosingReport`.

### Availability and normalization

**Cross-host.** Fully normalized report contract. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import {
    formatConversationClosingReportText
} from '/arcane/modules/ConversationClosingReport.js';

console.log(formatConversationClosingReportText('Complete <draft> & next step.'));
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

default `DBOPFS`; installs `window.dbopfs`, emits `dbopfs-ready`; table/file/backup APIs. `removeEmptyTable(tableName)` resolves one explicitly selected existing directory without creating or scanning it, then removes it only when OPFS confirms that it is empty. It never creates, clears, or recursively removes the target. It resolves a mutable record with `status` set to `removed`, `absent`, or `not-empty`, the matching `removed` boolean, and the logical `tableName` plus physical `directoryName`; a same-named file and unexpected platform errors reject without removal.

Exact exports: `DBOPFS_EVENT_TYPES`, `DBOPFS_REASONS`, `default`.

`createCompressedPNG({tableNames, additionalTables, signal})` returns an
`image/png` Blob without downloading or writing records. Omitted `tableNames`
selects all discovered saved tables; `[]` selects none. Named absent tables
are encoded as empty tables without creating OPFS directories. The existing
`memories`/`memory` alias is retained. `additionalTables` is an application-owned
`{tableName:{fileName:value}}` map. Each supplied table replaces the matching
saved table in this export only, rather than inheriting records the caller did
not select. Values retain the existing JSON serialization contract. Applications
own recipient policy, profile projections, and any product format marker.

`downloadCompressedPNG(name, options)` uses that same method and its options,
then initiates one timestamp-named download. Existing `downloadCompressedPNG(name)`
calls retain full-database behavior. An optional `AbortSignal` stops further
record preparation and prevents a later download. File reads and browser canvas
encoding already in progress cannot be interrupted; their result is discarded
on cancellation. No object URL or download is created by `createCompressedPNG`.

`restoreFromPNG(file, {selectTables})` preserves the existing deflate/RGB backup format and
restores through `setMany()` without changing its settled-result API or per-key
write ordering. The optional callback receives the complete decoded table/file
map exactly once and may return a map or promise of a map. Only its returned
tables and records are written, allowing application-owned selection and
projection of older full backups without a second decoder or temporary storage
writes. Callback failure rejects before any writes. With no callback, all
decoded tables are restored as before.

Restore resolves only when every selected record write succeeds. It
continues the table batches after individual rejected writes, then rejects an
`AggregateError` with code `DBOPFS_RESTORE_WRITE_FAILED`, original reasons in
`errors`, and `failures` entries `{tableName, fileName, reason}`. Successful
writes remain saved; restore is not an all-or-nothing transaction. The decoded
image is closed after pixel extraction, including canvas failures.

### Availability and normalization

**Browser / native WebView.** App scope and recognized JSON/JSONL file parsing
are normalized. Each readable JSONL row becomes its parsed value; a nonblank
unreadable row remains in its original string form so the owning application
can display, diagnose, or recover it without silent data loss. DOM and storage
errors remain observable. The logical `memories` table continues to map to the
physical `memory` directory, and successful or already-absent empty-table
removal invalidates both alias and cached-handle state. Transport: OPFS,
DBOPFSWorker, Compression Streams.
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
keeps the existing `get`, `set`, `getAllKeys`, and `delete` method names. Node
callers import the same class and factory from the public
`arcane-os/dbopfs-document-library` subpath and supply a compatible storage
adapter. That export supplies no Node filesystem storage implementation.
Bootstrap uses a concurrent
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
console.log(search.search('portable'));
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

Developer modals are offered only for newly captured live incidents. Loading
pending records from a prior page preserves their complete diagnostics and
delivery/retry state without reopening their modals. This remains true when
developer preferences become ready after restoration. A newly captured error
still follows the ordinary developer-mode presentation path.

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

Defines the same-origin `<html-import>` loader with open shadow root, inline or packaged external script execution, and readiness/error events.

### Public surface

Default export: the constructor registered for `html-import`. When no
constructor is registered, the module registers its SDK loader, whose
`connectedCallback()` owns fragment loading and whose `ready` property reports
completion. The browser invokes the connection callback when the host enters
the document.

Registration occurs once per custom-element registry. Imports through different
module URLs reuse and export the registered constructor, including overlapping
application startup and developer error-dialog imports. Existing component
instances, loading, readiness events, and teardown keep that same constructor.

Local component resources use stable URLs. The loader removes retired SDK-owned
`arcaneVersion` fields and adds no cache suffix. Functional query fields,
including caller-owned `v` fields, and fragments remain intact. External resource
URLs retain their complete query. Ordinary HTTP conditional caching is unchanged.

Native-module packages mark component scripts with `data-arcane-packaged-script`
and an external `src`. The loader executes those files through a real classic
script element instead of fetching their text for inline execution. Each host
receives its own invocation, `this` binding, ordered initialization, readiness
and error events, cancellation, and imported `destroy()` restoration. Independent
component hosts remain concurrent. Ordinary unmarked components retain their
existing inline/fetched-script path.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Public error detail normalized; fetch/DOM failure preserved. Transport: Same-origin fetch + DOM. [Deep protocol details](protocols.md).

### Example

```javascript
import * as module from '/arcane/modules/HTMLImport.js';

console.log(Object.keys(module));
```

## HTMLImportScript.js

### Overview

Renders the complete classic-script host wrapper shared by HTMLImport and
native-module packaging. Rendering returns source text; it does not execute it
or access the DOM.

### Public surface

`createHTMLImportScript(source)` returns the complete source inside the loader's
async host-bound initializer. A newline separates the authored ending from the
wrapper closure, including when the body ends in a line comment. At execution,
the wrapper uses the current script's host token and the HTMLImport-owned
registry, then exposes the initializer promise to that host's loader.

Exact exports: `createHTMLImportScript`.

### Availability and normalization

**Cross-host.** Complete source retained with a terminating newline before the
wrapper closes. Transport: In-process only. [Deep protocol details](protocols.md).

### Example

```javascript
import {createHTMLImportScript} from 'arcane-os/modules/HTMLImportScript.js';

const source=createHTMLImportScript('this.textContent="The moon burglar arrived.";');
```

Application packaging normally calls `packageApp({moduleFormat:'native', ...})`
instead of assembling or executing component wrappers itself.

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

## MailApi.mjs

### Overview

The managed-browser `arcane-os/mail` entrypoint re-exports the existing
[`Mail.js`](#mailjs), [`MailOutbox.mjs`](#mailoutboxmjs), and
[`MailTransport.mjs`](#mailtransportmjs) APIs. Their configuration, storage,
delivery, errors, and lifecycle remain owned by those modules.

### Public surface

Exact exports: `default`, `Mail`, `resolveMailConfig`,
`MAIL_OUTBOX_IDEMPOTENCY_WINDOW_MS`, `MAIL_OUTBOX_PROTOCOL`,
`MAIL_OUTBOX_STATES`, `MAIL_OUTBOX_TABLE`, `MailOutbox`, `createMailOutbox`,
`MailTransportError`, `normalizeMailEndpoint`, `sendMailReport`, and
`serializeMailReport`.

`default` and `Mail` refer to the same renderer Mail class. Import retains
`Mail.js`'s browser singleton installation; it creates no additional queue or
transport. Node resolves `arcane-os/mail` through the separate
[Node mail entrypoint](mail.md).

### Example

```javascript
import {resolveMailConfig} from 'arcane-os/mail';

const mailConfig = resolveMailConfig(
    {appName:'dragon-dispatch', endpoint:'https://mail.example.com/v1/mail'},
    {document:null, location:new URL('https://dispatch.example.com/')}
);
console.log(mailConfig.endpoint);
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

## MarkdownSpeech.js

### Overview

Re-exports the streaming `MarkdownSpeech` filter from the shared
`arcane-os/speech-text` package entrypoint. The filter removes repeated runs of
`*`, `#`, `_`, backtick, and `~` before speech segmentation, including runs
arriving across separate chunks. Single marks, ellipses, quoted sentence
endings, whitespace, and all other text remain literal. It neither interprets
links nor changes language or voice.

### Public surface

`MarkdownSpeech`; `append(text='',end=false)`, `reset()`.

Exact exports: `MarkdownSpeech`.

### Availability and normalization

**Cross-host.** The runtime projection and public package entrypoint share the
same implementation. `append()` returns only
the newly available narration. Only a trailing candidate marker and whether
it repeats are retained; ordinary text is emitted immediately. Terminal
`append(text,true)` flushes a single pending mark and resets state. `reset()`
clears pending formatting state when its narration is cancelled. Non-string
input throws `TypeError`.

### Example

```javascript
import {MarkdownSpeech} from '/arcane/modules/MarkdownSpeech.js';

const speech = new MarkdownSpeech();
const first = speech.append('**Hello'); // Hello
const last = speech.append('**...', true); // ...
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

## MarkdownMedia.js

### Overview

Stores complete images in the application's existing DBOPFS database while
Markdown contains only a short, stable `arcane-media:` reference. Rendering
resolves those local references into temporary display URLs. Importing the
module starts no storage, network, provider, or rendering operation.

### Public surface

Public package import: `arcane-os/modules/MarkdownMedia.js`.

- `await saveMarkdownMedia({blob,tableName='markdown-media',fileName})` writes
  `{mediaType,dataUrl}` as a JSON-compatible record and returns
  `{reference,tableName,fileName,mediaType}` only after the write completes.
  The default filename is a new UUID followed by `.json`. There is no abort
  option: accepted storage writes settle through the storage owner.
- `parseMarkdownMediaReference(reference)` returns `{tableName,fileName}` for
  a local reference, or `null` for an ordinary URL. Malformed local addresses
  report their actual parsing error.
- `decodeMarkdownMediaRecord(value)` synchronously decodes a complete
  `{dataUrl,mediaType?}` record or its JSON text into a `Blob`, without storage
  or network access. Nested single-record arrays are unwrapped; arrays with
  multiple records are never reduced to one image. Unrecognized content,
  including text that is not complete JSON, returns `null`. A recognized
  record with unreadable base64 data-URL content throws its decoding error.
  Omitted `mediaType` preserves the Blob's empty type. Input remains unchanged.
- `await readMarkdownMedia(reference)` returns the complete `Blob`, using
  only local storage and data-URL decoding; stored strings are never fetched
  as network addresses. It uses the same record decoder after loading, while
  preserving JSON parse errors for unreadable stored JSON strings and reporting
  an unreadable record as an error rather than `null`.
- `hydrateMarkdownMedia(root,{signal}={})` returns `{ready,destroy,retain}`
  immediately. It includes an IMG root and descendant IMG elements, removes
  local-reference `src` values synchronously, starts independent reads
  together, and assigns owned object URLs. `ready` includes image decoding.
  Use a detached fragment before connecting those images to the document.

Hydration preserves Markdown source, image descriptions, ordinary URLs, and
surrounding content. Failed reads or decodes reject `ready` with an
`AggregateError` whose complete `failures` array contains
`{image,reference,reason}`; successful sibling images remain visible.

`destroy()` or abort settles display readiness promptly, prevents late display,
and releases owned URLs. An already-started storage read remains observed and
settles independently. `retain()` returns an idempotent release callback for
printing; retained URLs survive destruction of the original view until every
print owner releases them. Destruction never deletes stored images.

Applications own record names, entry association, cleanup policy, and which
records their existing JSON backup/export includes. Reusing the same filename
supports an application-selected save-only retry without another generation
request. The helper performs no existing-data migration.

Exact exports: `saveMarkdownMedia`, `parseMarkdownMediaReference`,
`decodeMarkdownMediaRecord`, `readMarkdownMedia`, `hydrateMarkdownMedia`.

### Availability and normalization

Browser or native WebView with the existing app-scoped DBOPFS owner, Blob,
FileReader, object URLs, and IMG decoding. Encoding, storage, missing-record,
parsing, and decoding errors remain observable. No Core capability is selected.

### Example

```javascript
import {saveMarkdownMedia} from 'arcane-os/modules/MarkdownMedia.js';

const mural = new Blob([
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><text x="10" y="45">Octopus parking only</text></svg>'
], {type:'image/svg+xml'});
const {reference} = await saveMarkdownMedia({blob:mural});
editor.insertMarkdown(`![Octopus parking only](${reference})`);
```

Here `editor` is the ready shared Markdown Editor. Its normal change/save flow
still owns saving the Markdown; this operation saves the image record.

## MD.js

### Overview

Renders complete Markdown with Marked and exposes the same complete rendered
markup through `rendered` and `safeRendered`. Optional source mapping lets a
consumer locate rendered blocks without adding visible wrappers or changing
the authored Markdown.

### Public surface

Default `MD`; `raw`, `rendered`, `safeRendered`, `sourceMap`, `append()`.

`new MD(raw,{sourceMap:true})` enables block mapping. The `sourceMap` getter
returns ordered `{start,end,marker,type}` records. `start` is inclusive and
`end` is exclusive, measured in UTF-16 positions in the exact original `raw`
string, matching native textarea selection offsets. `marker` is the complete
data of a generated HTML comment, not a CSS selector. A consumer can locate
it after rendering with `document.createTreeWalker(root,NodeFilter.SHOW_COMMENT)`.
The generated marker prefix is chosen so it does not collide with authored
source comments. Marker values are opaque and may change after an edit.
The getter exposes the current mutable array; each successful render replaces
it with a new array, so a previously retained array describes the prior render.

In this opt-in mode, `rendered` and `safeRendered` contain the complete rendered
Markdown plus comment anchors; no element wrappers or attributes are added.
Lists, block quotes, and tables map at their top-level block rather than to
individual characters. Blank space and definitions have no visible block;
raw HTML can also absorb a comment during DOM parsing. A consumer follows the
nearest available rendered block in those cases. This is block-position
mapping, not exact rendered glyph or caret geometry.

Assigning `raw` or calling `append(string)` rebuilds both the complete rendered
result and its current mapping. Without `sourceMap:true`, `sourceMap` is empty
and the same parsing runs without comment anchors. Existing raw content, link
behavior, no-op `rendered` setter, and complete `append()` result remain.

Both rendering paths first use Marked's native HTML block tokenizer. When it
does not recognize a complete standalone `<img>` tag with a newline inside a
quoted attribute value, MD keeps that complete tag together as one HTML block.
This includes blank lines in an image's full `alt` description. The tag must
start at an existing Markdown block boundary with at most three leading spaces
and end on its own line or at the end of the source. Separate inserted image
blocks from surrounding Markdown with blank lines. Native HTML handling,
inline prose, fenced/indented/inline code, escaped examples, and incomplete
tags retain their existing parsing behavior. No source is rewritten or saved
data migrated. Marked's existing rendered line-ending normalization remains;
mapped offsets still address the exact original source, including CRLF or CR.

Exact exports: `default`.

### Availability and normalization

**Browser / native WebView.** Marked parsing, including the shared standalone
image-token correction above; parse errors remain vendor-native. Rendering and
the getters are DOM-independent. DOM lookup and scrolling belong to the
consuming component;
mapping performs no persistence or viewport movement. Transport: Marked.
[Deep protocol details](protocols.md).

### Example

```javascript
import MD from '/arcane/modules/MD.js';

const notes=new MD('# Dragon field notes\n\nThe library dragon ate the index.',{
    sourceMap:true
});
const preview=document.querySelector('#preview');
preview.innerHTML=notes.safeRendered;
const comments=document.createTreeWalker(preview,NodeFilter.SHOW_COMMENT);
const firstBlock=notes.sourceMap[0];
while(comments.nextNode()){
    if(comments.currentNode.data===firstBlock.marker){
        console.log(firstBlock,comments.currentNode.nextSibling);
        break;
    }
}
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

`normalizeOllamaModelIdentifier()`, `isOllamaModelIdentifier()`,
`sameOllamaModelIdentifier(left, right)`.

Exact exports: `isOllamaModelIdentifier`, `normalizeOllamaModelIdentifier`,
`sameOllamaModelIdentifier`.

The comparison helper applies Ollama's default registry (`registry.ollama.ai`),
namespace (`library`) and tag (`latest`) with case-insensitive name comparison.
It compares a selected name with resident-model names without rewriting either
string or any outbound payload; different explicit hosts, namespaces or tags
remain distinct. The existing identifier-validation functions are unchanged.

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

Constructor and factory options are `{ai,aiName,chat,chatEntity,chatFileName,
contextBuilder,loadExisting,memory,request,responseLength,systemPrompt}`. Public members are
static `create()`, getters `ai`, `chatEntity`, and `fileName`, and `ready()`,
`history()`, `transcript()`, `settleMemory()`, `open(input)`, `send(input)`, and
`stream(input,handlers)`.
`ready()` waits for initialization and resolves the same session instance.

Optional `aiName` is an application-owned string, also exposed through the
session's getter/setter. `open()`, `send()`, and `stream()` capture it at operation
entry before awaiting readiness, memory, or the provider, so later name changes
apply only to subsequent operations. A nonblank name is preserved exactly on
the copied terminal `message.name` and the retained assistant transcript record;
the terminal copy carries the assistant record's real timestamp when one exists.
Empty or whitespace-only names omit this display field. The complete raw
`providerResponse` stays unchanged. Configured model context and memory inputs
omit the application display name. Existing stored history is never renamed or
rewritten when `aiName` changes; `persist:false` remains operation-only.

`open({message:{content,persist:false?},request?,signal?})` performs one
application-authored bootstrap request only when the retained conversation is
otherwise empty. The bootstrap is never committed. After a complete nonblank
model response succeeds, the operation atomically retains only the sanitized
assistant content in configured model context and ChatEntity/DBOPFS history.
That assistant-only opening survives reload and empty-chat maintenance without
a fabricated user turn. A second opening rejects as `AI_CHAT_OPENING_EXISTS`;
an unavailable durable ChatEntity rejects as `AI_CHAT_PERSISTENCE_UNAVAILABLE`.
If retention is disabled while the opening is being prepared, that same error
rolls back the opening before its append; it does not leave hidden model context.
An opening write already accepted by DBOPFS still completes normally.

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
An explicitly nonretained tool-result continuation uses its matching pending
call only for that operation, then rolls back without settling or changing the
retained call. A later retained continuation can still settle it normally.

The entity-wide `session.chatEntity.persist=false` applies the same no-retention
rule to new turns and direct entity additions; it is not a disk-only switch.
The session captures that setting when it accepts a request and observes it
again before accepting a durable append. Changing it later cannot bring back
discarded inputs or responses. A write already accepted by DBOPFS finishes
normally; toggling the setting does not undo that write or rewrite saved data.
Completed `send()` and `stream()` responses include a session-owned `retained`
boolean outside `message` and the provider payload, identifying whether the
turn entered recurring history. Existing retained and stored records remain
untouched: this boundary applies to new additions and performs no migration.

`history()` returns provider-safe configured model context, including the
system prompt and every complete ordinary visible committed turn. Only a
currently unresolved structural-call tail remains raw for its matching active
continuation. `transcript()` returns the sanitized human-readable ChatEntity
projection.
User and assistant records retain role, complete visible content, and the
real timestamp, with an optional exact nonblank application display name on
assistant records. Tool records retain only role, the required user-facing
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

## PreparedSpeech.js

### Overview

Shared preparation mechanism used by `AI.prepareTTS()`. It owns ordered
generation admission, same-owner request sharing, complete audio storage and
semantic reuse, and each caller's preparation lifetime. It does not construct
an audio context, play speech, or select application content.

### Public surface

Named `prepareSpeech({owner,parts,originalParts=parts,selection=null,
segmentation=null,storage=null,identity=null,signal=null,onState,synthesize})`.
The owning AI supplies already segmented speech parts, complete original parts,
its selection snapshot, and its synthesis callback. The returned handle is
`{segments,state,ready,getAudio(index),cancel()}`. Applications use
`AI.prepareTTS()` and `AI.playPreparedTTS()` so the existing AI owner retains
automatic formatting cleanup, segmentation, provider readiness/capacity, and
ordered playback. See the [complete preparation contract](ai/browser-speech.md#prepare-narration-once-and-replay-stored-audio).

`storage:{db,table,key}` is optional; the ready DBOPFS instance supplies
`get`, `set`, `readFile`, and `writeFile`. JSON-compatible semantic inputs stay
complete in the version-1 manifest. Raw audio is persisted separately and its
MIME type is retained in metadata. Storage mutation serializes by database,
table, and key within the realm. Synthesis sharing is scoped to the same owner
and matching semantic inputs/storage; playback remains outside this module.

Exact exports: `prepareSpeech`.

### Availability and normalization

**Browser or native WebView with Blob, AbortController, an injected synthesis
callback, and optional ready DBOPFS.** Import creates no provider or
playback. Calling the preparation function starts owned asynchronous work.
`ready` rejects complete synthesis/storage failures or `AbortError` after
cancellation; successful audio remains available for reuse. Malformed part,
storage, or semantic metadata inputs throw `TypeError`; an invalid segment
index rejects with `RangeError`. No Core capability is selected here.

### Example

```javascript
import {prepareSpeech} from '/arcane/modules/PreparedSpeech.js';

// Applications use AI.prepareTTS; this import only exposes the SDK mechanism.
console.log(typeof prepareSpeech); // function
```

## PrintView.js

### Overview

Shared rendered-print owner used by Chat, Markdown Editor, and File Manager. It
captures the current DOM and computed styles, including accessible rendered
HTML frames, complete text, selected images, and the current title. A temporary
print-only surface expands scrollable content without editing the live screen.
The shared `/arcane/css/print.css` owns print presentation for this snapshot,
direct themed pages, and documentation sites. It supplies the existing Arcane
light palette and `1in` (`25.4mm`) page margins. The snapshot retains rendered
fonts, font sizing, line height, emphasis, and complete
content while removing screen-theme text/shadow paint from ordinary HTML and
pseudo-elements. Links are underlined and table cells receive visible borders.
Image pixels, canvas snapshots, and SVG artwork keep their own colors. These
print rules leave the live screen theme unchanged; browser print settings still
control the eventual page output.

### Public surface

Named `createPrintView({host,content,title,active,priority=0,signal,onError,retain,prepare})`
returns `{print,destroy}`. `host` is a connected element; synchronous callbacks
return the rendered content node, string title, and whether the view is active.
Optional `retain()` returns a resource-release callback. It keeps owned media
available until preparation is cancelled or the browser emits `afterprint`.
Optional `prepare(signal)` may await view-owned readiness during an explicit
print request. After it settles, current content and title are read again
synchronously immediately before capture. A view whose content changes during
preparation must keep its owned media retained and reject a still-pending
snapshot through its synchronous `content()` callback.

`await print()` selects that view, waits for accessible HTML frame, image, and
font readiness, and requests the browser print dialog. It returns `false` when
the view is unavailable or preparation is cancelled, returns `true` for a dialog
request, and rejects preparation errors. It cannot confirm physical printing
or PDF saving. Overlapping print sessions on the same document reject.

One native `beforeprint`/`afterprint` registration serves each document. Native
Print chooses the highest-priority visible active view, most recently registered
on ties. File preview uses priority `1`; editor uses `0`. Native `beforeprint`
is synchronous: it snapshots currently rendered content, cannot await a newly
loading resource, and cannot cancel the browser's dialog. `onError(error)` or
the developer console receives complete preparation failures.
Native printing never invokes the asynchronous `prepare` callback; prepared
views still receive the synchronous content/title read at capture.

Import fetches the complete shared stylesheet through a module-relative URL
and resolves after that text is available. The editor, file preview, and chat
load this module independently of rendering; stylesheet readiness delays only
print availability. Every registered view can therefore capture synchronously
during native `beforeprint`, with no new stylesheet request at print time.
Loading failures reject the module import and remain observable to its caller.

`destroy()` unregisters the view and cancels pending preparation. Once the
dialog has been requested, its snapshot and retained media remain until
`afterprint`. Import alone creates no listener, provider, storage, or print job.

Exact exports: `createPrintView`.

### Availability and normalization

**Browser and native WebViews with a print implementation.** Requires DOM,
CSSOM, Fetch for initial stylesheet loading, FontFace/Image readiness, and
browser print events. No Core capability.
Cross-origin/inaccessible frames, native PDF frames, and object/embed viewers
must use their owning viewer's print command; the helper does not replace their
content with raw source or claim an unrendered document was printed. Font
sources in embedded documents must be accessible for snapshot preparation.

### Example

```javascript
import {createPrintView} from '/arcane/modules/PrintView.js';

const ledger = document.querySelector('#moon-library-ledger');
const printing = createPrintView({
    host:ledger,
    content:() => ledger,
    title:() => 'Books overdue on the Moon',
    active:() => true
});
document.querySelector('#print-ledger').onclick = async function printLedger(){
    try { await printing.print(); }
    catch(error) { console.error('Unable to print the ledger:', error); }
};
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

Preserves exact nonblank text, admits complete speech segments according to the
selected client's advertised capacity, and plays indexed HTML audio in exact
input order. Stored parts remain exact; only each outbound synthesis payload
copy receives automatic formatting-mark cleanup.

### Public surface

`SpeechPlayback` class/default, the shared voice compatibility catalogs,
`SPEECH_PLAYBACK_STATE_EVENT`, `splitSpeechText()`, the optional constructor
state callback, and playback lifecycle APIs.

Exact exports: `SPEECH_PLAYBACK_STATE_EVENT`, `SPEECH_VOICE_ALIASES`,
`SPEECH_VOICE_OPTIONS`, `SpeechPlayback`, `default`, and `splitSpeechText`.

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

`speech` may expose `prepareTTSPlayback(payload,signal)` returning a Blob or
native descriptor, a native provider's silent `prepare(payload,{signal})`,
`fetchTTS(payload, signal)`, or `synthesize(payload, {signal})`.
The playback-oriented method is preferred. `SpeechPlayback` also supplies a third
SDK-internal preparation object; existing two-argument clients may ignore it.
`prepare({key,parts,model,voice,responseFormat,
speed,autoplay=true})` uses only caller-supplied model, voice, and response-format
values; those three omitted values remain omitted so the selected AI/model
catalog may provide its documented defaults. Speed defaults to `1`, is normalized
as a positive number, and is always sent. `SPEECH_VOICE_OPTIONS` is the ordered
mutable compatibility array `{value,label}` for `alloy`, `ash`, `ballad`,
`coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, and `shimmer`;
`SPEECH_VOICE_ALIASES` is the mutable `Set` of those values. The class does not
select either catalog or promise that a selected provider supports its values.
There is no hard-coded model, response format, voice, or cloud/browser fallback.
`splitSpeechText(value)` uses trimming only to detect blank input, then returns
the caller's exact string in one mutable array without trimming, splitting, or
freezing it. `prepare()` likewise preserves each nonblank part's exact `input`
string while normalizing its other playback fields into a new mutable record.
At synthesis time, `requestSpeech()` copies that record, removes repeated same
formatting marks from only the outbound `input`, and delegates with the
SDK-internal `{speechInputPrepared:true}` argument so downstream SDK boundaries
do not apply the non-idempotent filter again. Original part objects, stored
parts, displayed text, and all non-input payload fields remain unchanged. The
class applies no part-count, character-count, pause, or input upper cap.

### Admission and playback order

When `speech` exposes both `fetchTTS(payload, signal)` and
`providerRuntime.status('tts', {execution:true}).execution.maxConcurrentRequests`
as a positive safe integer, `prepare()` submits every complete `parts` entry
immediately. `SpeechPlayback` does not create a second limiter: the provider
runtime owns bounded FIFO admission. Browser Kokoro defaults that capacity to
four, so up to four segments can synthesize while later submissions wait in the
provider queue. A later segment may finish first, but its Blob URL stays at its
original index and is never played ahead of an earlier segment.

If that capacity is absent, invalid, or unavailable, `SpeechPlayback` retains
the compatible serialized path and prepares only one lookahead segment. This is
the default for `Arcane.speech.synthesize` and custom clients, so native hosts
with one synthesis lock are not driven concurrently. Pause and Resume control
the same supplied `audio` element. Stop aborts every owned synthesis signal and
releases prepared URLs. Replay keeps completed URLs and still-pending provider
work, then re-submits only failed missing provider segments before starting
again from index zero.

Native descriptors are retained separately from Blob URLs and never assigned to
an audio element. `autoplay:false` remains silent. Play, Pause, Resume, Stop and
Replay use the native control; only a successful current native `finished`
advances the next part. Native errors remain observable, and a failed native
control stays owned until its optional `released` promise confirms cleanup.
Stale completion after stop/restart/disposal cannot advance replacement content.
Selecting a native part hides and clears the HTML audio source while preserving
the same shared playback state events and complete original parts.

Every preparation owns an operation ID and one AbortController for each active
synthesis segment or playback delay. Replacement,
`stop()`, `cancel()`, and `destroy()` abort their owned signals, suppress stale
settlement, release Blob URLs, and publish synchronous
`speech-playback-state` occurrences through `globalThis.arcaneEvents` before
calling the optional `onState(detail)` function synchronously. Canonical
subscribers and the callback observe the same public field values at dispatch
time, but object identity is not promised. Both surfaces expose mutable public
state detail. A callback failure is reported through `globalThis.reportError`
when available, otherwise `console.error`, and does not replace playback
settlement. The detail contains
`state`, `message`, `key`, `index`, `total`, `producing`, `buffered`, `hasAudio`,
`operationId`, `code`, and `reason`; a first-segment provider rejection remains
preserved to the `prepare()` caller. Later failures surface when ordered
playback reaches that segment. `destroy()` also removes every audio listener
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
  onState(detail) {
    console.log('Speech state:', detail.state);
  }
});
const button = document.body.appendChild(document.createElement('button'));
button.textContent = 'Speak';
button.addEventListener('click', async function speakCompleteSegments() {
  await globalThis.ai.setSpeechMuted(false);
  await speech.prepare({
    parts: [
      'First complete segment.',
      'Second complete segment.'
    ],
    autoplay: true
  });
});
```

The shared compatibility catalogs are also available directly. They do not
select a voice for `SpeechPlayback`:

```javascript
import {
  SPEECH_VOICE_ALIASES,
  SPEECH_VOICE_OPTIONS
} from '/arcane/modules/SpeechPlayback.js';

console.log(SPEECH_VOICE_OPTIONS[0]); // {value: 'alloy', label: 'Alloy'}
console.log(SPEECH_VOICE_ALIASES.has('alloy')); // true
```

With the default browser speech configuration, both parts enter its capacity-4
queue immediately and still play first, then second. Inspect the selected
execution device without guessing from console warnings:

```javascript
const execution = globalThis.ai.providerRuntime.status(
  'tts',
  { execution: true }
).execution;
console.log(execution.selectedDevice, execution.maxConcurrentRequests);
```

`requestedDevice:'auto'` attempts the complete ONNX Worker/session pool on
WebGPU and recreates it on WASM if WebGPU loading fails. The reported selected
device proves provider selection, not physical GPU kernel overlap.

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

Performs import-time Arcane theme loading, reuses the shared presentation
owner, and subscribes to native appearance changes and
the canonical user's readiness event. Rendering does not wait for profile
loading. A ready user is replayed immediately; its saved skin supersedes the
presentation cache. Bootstrap observes the existing User lifecycle rather than
creating a profile or migrating saved data.

### Public surface

`bootstrapArcaneTheme()`, `arcaneThemeReady`, default ready promise.

Exact exports: `arcaneThemeReady`, `bootstrapArcaneTheme`, `default`, and
`disposeArcaneThemeBootstrap`.

`disposeArcaneThemeBootstrap()` removes bootstrap-owned subscriptions,
native-window theme observers and listeners, and cancels its pending window
request.
The cache is a presentation hint, not the authority for preferences or user
data. Preference loading and User readiness independently reconcile it; cache
failures are logged without blocking the page.

Module evaluation follows its import graph, so importing ThemeBootstrap alone
does not establish restoration before the first paint. Use the classic
[ThemePresentation head entry](#themepresentationjs) before CSS for that early
restoration. Neither entry imports User or starts its storage lifecycle.

When a native host exposes `Arcane.window.setTheme`, the shared bootstrap
samples the app body's inherited `--background` and `--text-color`. It resolves
CSS variables, named colors, HSL and other browser-supported color forms through
computed style. Modern color spaces use the browser's sRGB canvas conversion;
the resolved alpha is retained separately, including translucency close to one.
Authored styles remain unchanged. Missing semantic properties are omitted.

One listener on the shared `arcane-theme-change` owner, root/body presentation
attribute observers, stylesheet-load events and device-color-scheme changes
schedule samples. Identical channel values do not issue another request.
Initial sampling and preference/profile reconciliation run independently of
rendering and native completion. Page hide cancels the pending renderer wait;
page restoration samples again. Print presentation is excluded. The host keeps
its last accepted colors across navigation until the next document changes
them. No additional theme bus, polling, storage or system-appearance mutation is
introduced by this forwarding path.

Ordinary browsers and facades without the window method install no native
sampler. An older host's unavailable-method response is recorded once in
developer diagnostics and stops that sampler; genuine bridge failures retain
their complete diagnostics. See the [current-window contract](core-client.md#current-window-theme)
for per-field results, cancellation and actual adapter availability.

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

default `ThemeManager`, `loadAndApplyTheme()`, `applyUserSkin()`;
scheme/custom/system APIs and `arcane-theme-change`.

Exact exports: `default`, `loadAndApplyTheme`, `applyUserSkin`.

`applyUserSkin(skin,{root?,body?,cache=true}={})` synchronously applies the
application's saved skin classes without replacing unrelated body classes.
The default root is the current document element; the default body belongs to
that root's document. It accepts the
existing string/number skin values and whitespace-separated class lists;
unknown application classes remain usable. It selects the shared named
palette on the root through `data-user-skin`, returning its name or `null`
when there is no applicable skin/root. The palette selection does not rewrite
the supplied skin or save a User record. Set `cache:false` for a presentation
that should not be remembered across navigation.
This export delegates to the same owner installed by `ThemePresentation.js`.
Falsy skin values retain the current presentation. Complete supplied strings
remain exact in the presentation cache; numbers use their complete class-text
representation, leaving the profile value unchanged. If the body does not yet
exist, root selection happens immediately and the latest complete class list
is applied once the body is available.

The shared `theme.css` owns the default, warm, curious, hopeful, harmony, and
warrior palettes. Each works with explicit light/dark or system appearance.
`layout.css` imports that same owner. On screen, explicit custom themes retain
precedence through `data-arcane-skin="custom"` and their inline tokens.
The bare root retains the generic neutral light/dark baseline; the prior
layout default palette is selected explicitly through `data-user-skin="default"`,
`body.default` compatibility, or the default swatch.

`theme.css` and `document-site.css` import the shared `/arcane/css/print.css`.
During printing, that owner applies the existing base light palette, with a
white paper surface and `1in` (`25.4mm`) page margins, to the root, body, and scoped
`data-arcane-palette` elements. These print-only tokens override screen/custom
palette tokens. During print, it resets root/body margins, hides the shared
header/sidebar shell, and expands main-content scrolling into document flow.
Saved preferences, screen presentation, fonts, and media remain unchanged.
[`PrintView.js`](#printviewjs) loads that same stylesheet before registering
views and applies it to its expanded rendered-content snapshot. Snapshot rules
are scoped to owned print nodes; documentation-site print rules remain scoped
to that site's surface. Screen styles and saved theme preferences remain with
their existing owners.

A scoped `data-arcane-palette="warm"` element exposes the same palette variables
for a chooser preview without changing the page's selection. Use any of the
six named palettes and paint the preview with ordinary shared variables such
as `--background`, `--text-color`, and `--primary-color`; applications need no
copied palette values. The scoped preview follows the page's appearance scheme.
Set `data-color-scheme="light"` or `data-color-scheme="dark"` on that same
`data-arcane-palette` element to preview either variant independently of the
page scheme. Leaving it unset follows the page. Applications own preview order,
layout, and any toggle; the scoped attribute leaves the page mode unchanged.

`loadAndApplyTheme()` restores the last app-scoped presentation before its
asynchronous preference loads. The complete saved skin and applied
appearance/custom presentation are cached by `ThemePresentation` only as
nonauthoritative UI state;
User and preference stores retain ownership of saved settings. No page hiding,
profile-read barrier, polling, or history migration is involved.
`apply()` remembers only its applied appearance attributes and the custom CSS
properties owned by Theme's existing token list. `preview()` remains transient.
The module's side-effect import also installs the presentation owner when no
classic head script was selected; it does not provide a first-paint guarantee.

### Availability and normalization

**Browser/native hybrid.** Theme values/events normalized; storage/native failures mixed. Transport: PreferenceStore, DOM, Arcane.appearance. [Deep protocol details](protocols.md).

### Example

```javascript
import {applyUserSkin} from '/arcane/modules/ThemeManager.js';

applyUserSkin('warm dragon-observatory');
```

## ThemePresentation.js

### Overview

A dependency-free classic head entry restores the last application-scoped
presentation synchronously, before following stylesheets are loaded. It
does not import modules, User, OPFS, or a model, hide the page, or wait for
profile or preference readiness. ThemeManager reuses the same per-realm owner.

### Public surface

No ESM exports. The first evaluation installs
`globalThis.arcaneThemePresentation` and calls `restore()`; later evaluations
reuse the installed object.

- `applyUserSkin(skin,{root?,body?,cache=true}={})` is the same synchronous skin
  operation exported through ThemeManager. It preserves independently owned
  body classes, selects `data-user-skin`, and returns the selected palette name
  or `null` for a falsy skin or missing root. Numeric presentation is cached as
  its complete class text; supplied strings remain exact.
- `remember(fields,root=document.documentElement)` merges the supplied
  presentation fields with the current cache and returns whether the write
  succeeded. The SDK supplies `skin`, `palette`,
  `appearance:{colorScheme,density,reduceMotion,fontSize}`, and
  `customProperties` (the applied Theme-owned CSS property map, or `null`).
- `restore(root=document.documentElement)` applies cached root appearance and
  owned custom properties plus the complete skin classes. It returns the
  cached record, an empty record on a cache miss, or `null` when restoration
  is unavailable or fails. If the body is still absent, one DOMContentLoaded
  callback applies the latest class list; root colors are already selected.
- `reportError(message,error)` initially forwards the complete Error to
  `console.warn`; ThemeManager connects it to `arcaneLogging.warn` when its
  module evaluates.

The cache key is `arcane.apps.<application-id>:arcane.theme.presentation`, using
the existing `arcane-app-id` meta declaration or `data-arcane-app-id` on the
document root. Missing identity or storage skips caching. Conflicting identity,
storage failures, and malformed JSON are logged without stopping rendering.
Malformed JSON does not prevent a later authoritative presentation write.
Only presentation is remembered; no User record, unrelated inline style,
profile snapshot, model state, or history is captured or migrated.

Canonical already-ready User state and later `user-entity-loaded` events
reconcile the cached skin through ThemeBootstrap; loaded appearance/custom
preferences remain authoritative through ThemeManager. A cache miss cannot
know an unloaded saved profile skin, and a module-only import may evaluate
after first paint.

### Availability and normalization

**Browser / native WebView classic script.** DOM and optional application-scoped
localStorage only. No native capability is required.

### Example

Place the ordinary classic script after the existing app-id declaration and
before theme/layout styles. Do not use `type="module"`, `async`, or `defer` on
this early entry; retain the application's normal ThemeBootstrap module use.

```html
<meta name="arcane-app-id" content="dragon-observatory">
<script src="/arcane/modules/ThemePresentation.js"></script>
<link rel="stylesheet" href="/arcane/css/theme.css">
<script type="module" src="/arcane/modules/ThemeBootstrap.js"></script>
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

## VoiceCaptureWorklet.js

### Overview

Internal audio processor for [`ContinuousVoiceCapture.js`](#continuousvoicecapturejs).
It keeps rolling pre-roll, detects RMS audio level, preserves complete active
audio through quiet and periodic cuts, and encodes mono Float32 WAV clips on
the audio rendering thread. It performs no semantic speech detection or STT.

### Public surface

No ESM exports. The capture owner loads this static file with
`audioContext.audioWorklet.addModule()` and creates the
`arcane-continuous-voice-capture` processor with
`{preRollMs,quietMs,chunkMs,activityThreshold}` in `processorOptions`.
`activityThreshold` measures root-mean-square amplitude over fixed 20 ms
windows counted from the audio sample rate, independently of browser callback
lengths. Brief peaks do not reset the quiet duration when the window's RMS
remains below that threshold. This is an RMS threshold, not a peak threshold:
a sine wave with peak amplitude `0.025` can remain below the default `0.02`
RMS threshold. Applications can select the existing threshold for their audio
level; no relative-noise or semantic speech classifier is implied.

Classification selects segment boundaries without modifying the captured
samples. Quiet duration advances by audio frames, pre-roll remains complete,
and periodic clips remain adjacent. Stop classifies any partial final window
using its actual samples and flushes the final active clip, including softer
trailing audio before the quiet boundary. Analysis adds at most one 20 ms
window of capture-to-segmentation delay; model processing is independently
owned by the transcription queue.

The owner sends `{type:'stop'}`. The processor transfers each complete
`{type:'segment',audio:ArrayBuffer,sampleRate,sequence,reason,durationMs}`
and finally `{type:'stopped'}`. Each complete WAV includes its own format,
sample-count, and data framing. Quiet-only capture emits no segments, and
periodic segments never repeat samples.

### Availability and normalization

**AudioWorkletGlobalScope only.** This is an owner-local native MessagePort
protocol, with no separate event bus, model request, or persistence. Applications
use `ContinuousVoiceCapture` or the shared voice component rather than importing
this processor in a document or Worker.

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
- [Runtime components](runtime-components.md) owns all 40 HTML-import fragments, methods, slots, and events.
- [Arcane Ollama](arcane-ollama.md) expands the raw-versus-normalized behavior of `Ollama.js`.
