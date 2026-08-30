# Arcane runtime component catalog

Arcane components are reusable HTML fragments loaded through the shared `<html-import>` element. They are browser UI, so they run in an ordinary supported browser renderer and in native Arcane WebViews. They do not run in Node or as cloud services.

A component file does not register its own custom element. The `<html-import>` host fetches the fragment from the same origin, attaches an open shadow root, runs its inline scripts with `this` bound to the host, and publishes `html-import-ready` or `html-import-error`. Component methods and properties are attached to that host.

## Basic loading pattern

```html
<script type="module">
  import '/arcane/modules/HTMLImport.js';
</script>

<html-import id="widget" href="/arcane/components/weather-widget.html"></html-import>

<script type="module">
  const widget = document.querySelector('#widget');
  widget.addEventListener('html-import-ready', () => {
      console.log('Component methods are attached.', typeof widget.setWeather);
  }, {once: true});
</script>
```

## Shared semantic-event and lifecycle contract

Except for the legacy `header.html` and platform-owned `theme-switcher.html`,
each component owns exactly one source created through
`createArcaneEventSource(host,{source:'arcane.component.<name>',eventTypes})`.
That source publishes synchronously to the realm's branded
`globalThis.arcaneEvents` authority. Component DOM events are one-way
compatibility projections of the same canonical occurrence; they are never
republished into the authority. Every projected detail has the canonical
`occurrenceId`, `arcaneSource`, `instanceId`, and `operationId` fields in a
mutable complete record. A compatibility payload's existing `source` field remains
source-local and may differ from `arcaneSource`; the payload may additionally
retain source-local browser or provider objects.

When a component uses a cancelable event before a requested operation, cancellation on
either the canonical occurrence or its DOM projection makes the publication
unaccepted, and the component does not continue the guarded operation. A
cancelable compatibility notification emitted after committed work does not
roll that work back unless its component section explicitly says otherwise.
Asynchronous work keeps its own `AbortSignal`, operation generation, and
promise ownership; canonical publication is synchronous and does not become an
async queue.

Every singleton-backed component publishes its ready event only after its host
members are installed. Its idempotent `destroy()` (unless a more specific
return is documented) disposes the canonical source and marks the host
unready. Cleanup of owned listeners, pending work, nested subscriptions, and
controllers is component-specific and is stated below where it forms part of
that component's public contract. Removing an `<html-import>` host calls an
imported component's `destroy()` through `HTMLImport`; callers that invoke
`destroy()` directly retain responsibility for removing the element when
appropriate.

## Canonical inventory

| Component | Capability | Principal methods | Events | Normalization |
| --- | --- | --- | --- | --- |
| [`app-bar.html`](#app-barhtml) | Responsive application navigation, route state, status, and trailing actions. | `setNavigation()`<br>`setActiveRoute()`<br>`setStatus()`<br>`refresh()`<br>`destroy()` | `app-bar-ready` | DOM-normalized |
| [`assistant-panel.html`](#assistant-panelhtml) | Reusable assistant drawer, message area, composer, pending/streaming/empty/error state, and actions. | `open()`<br>`close()`<br>`toggle()`<br>`send()`<br>`clear()`<br>`setState()`<br>`focusComposer()`<br>`scrollToEnd()`<br>`destroy()` | `assistant-ready`<br>`assistant-opened`<br>`assistant-closed`<br>`assistant-send`<br>`assistant-clear` | DOM-normalized; caller/provider results remain external |
| [`calculator.html`](#calculatorhtml) | Calculator keypad and result/error event surface backed by CalculatorEngine. | `calculate()`<br>`destroy()` | `calculator-ready`<br>`calculation-complete`<br>`calculation-error` | Normalized Calculation/error events |
| [`chart.html`](#charthtml) | Accessible uPlot line, area, or point chart with normalized options and rows. | `configure()`<br>`populate()`<br>`setData()`<br>`addData()`<br>`update()`<br>`destroy()` | `chart-ready`<br>`chart-remove` | Options/rows normalized; uPlot rendering is vendor-native |
| [`chat.html`](#chathtml) | Shared chat, visible selected-model activation request, file upload, streaming, structural tool settlement, speech, language, availability, and conversation-timebox surface. | `streamMessage()`<br>`setMessageProgress()`<br>`setAIAvailability()`<br>`setInitialSpeechMuted()`<br>`setConversationComplete()`<br>`bindConversationTimebox()`<br>`bindSession()`<br>`submitMessage()`<br>`submitToolResult()`<br>`submitToolResults()`<br>`sendMessage()`<br>`languageChanged()`<br>`requestAIActivation()`<br>`destroy()` | `chat-ready`<br>`chat-session-bound`<br>`chat-session-message`<br>`chat-session-error`<br>`chat-send-message`<br>`chat-send-error`<br>`chat-file-uploaded`<br>`chat-file-upload-error`<br>`chat-language-changed`<br>`chat-language-change-error`<br>`chat-ai-activation-request`<br>`chat-ai-activation-error`<br>`chat-speech-synthesis-error`<br>`conversation-timebox-error` | UI/runtime state, explicit user activation intent, and honest structural-call settlement normalized; AI/storage/media behavior mixed |
| [`conversation-view.html`](#conversation-viewhtml) | Provider-neutral conversation display, advisory actions, composer, busy state, and status. | `setConversation()`<br>`setBusy()`<br>`setStatus()`<br>`clearComposer()`<br>`destroy()` | `conversation-view-ready`<br>`communication-send`<br>`communication-advisory-action` | DOM-normalized |
| [`dashboard-config.html`](#dashboard-confightml) | Selects which normalized chart definitions are visible on a dashboard. | `configure()`<br>`setDefinitions()`<br>`setVisibility()`<br>`getChartOptions()`<br>`getEffectiveVisibility()`<br>`open()`<br>`close()`<br>`destroy()` | `dashboard-config-ready`<br>`dashboard-config-opened`<br>`dashboard-config-closed`<br>`dashboard-config-change` | Fully normalized definitions and visibility |
| [`data-maintenance.html`](#data-maintenancehtml) | Runs destructive cleanup of empty chats and memories inside the current app data scope. | `open()`<br>`destroy()` | `data-maintenance-ready`<br>`data-maintenance-complete` | Normalized counts; DBOPFS failures mixed |
| [`data-view.html`](#data-viewhtml) | Opens a generic modal-style data view around an injected provider. | `beforeOpen()`<br>`open()`<br>`destroy()` | `data-view-ready` | DOM-native result |
| [`directory-picker.html`](#directory-pickerhtml) | Presents the provider-owned OS directory chooser with change/cancel/error states. | `configure()`<br>`focus()`<br>`select()`<br>`destroy()` | `directory-picker-ready`<br>`directory-picker-change`<br>`directory-picker-cancel`<br>`directory-picker-error` | Strict normalized native selection/error |
| [`document-inspector.html`](#document-inspectorhtml) | Inspects PDF, text, or source documents and records review state. | `loadDocument()`<br>`selectView()`<br>`markSaved()`<br>`destroy()` | `document-inspector-ready`<br>`document-review-change` | Document state normalized; browser document APIs mixed |
| [`file-drop.html`](#file-drophtml) | Acquires complete file selections by drag/drop or picker and presents busy, progress, error, and cleared state. | `configure()`<br>`openPicker()`<br>`clear()`<br>`setBusy()`<br>`setError()`<br>`setProgress()`<br>`destroy()` | `file-drop-ready`<br>`file-drop-selected`<br>`file-drop-progress`<br>`file-drop-state`<br>`file-drop-error` | Complete selections preserved; browser File/drop errors mixed |
| [`file-inspector.html`](#file-inspectorhtml) | Displays file metadata, preview, busy/error state, and caller-defined actions. | `configure()`<br>`show()`<br>`clear()`<br>`setActions()`<br>`setBusy()`<br>`setError()`<br>`setPreview()`<br>`destroy()` | `file-inspector-ready`<br>`file-inspector-action`<br>`file-inspector-change`<br>`file-inspector-cleared`<br>`file-inspector-error` | State normalized; preview/provider behavior mixed |
| [`file-manager.html`](#file-managerhtml) | Browses, filters, selects, opens, and acts on app-scoped files. | `setProvider()`<br>`loadAll()`<br>`setFilter()`<br>`select()`<br>`clearSelection()`<br>`destroy()` | `file-manager-ready`<br>`file-manager-select`<br>`file-manager-open`<br>`file-manager-action` | Selection/filter state normalized; storage/provider behavior mixed |
| [`header.html`](#headerhtml) | Legacy title bar with history, reload, online marker, presentation labels, and 988 link. | None | No component-specific event | Browser/platform-native behavior; no component-ready contract |
| [`integration-settings.html`](#integration-settingshtml) | Edits non-secret communication service configuration and service actions. | `configure()`<br>`getValues()`<br>`setStatus()`<br>`destroy()` | `integration-settings-ready`<br>`integration-settings-save`<br>`integration-settings-close`<br>`integration-action` | Normalized non-secret values |
| [`local-ai-status.html`](#local-ai-statushtml) | Presents local-AI standby, failure, recovery, guidance, retry, and dismissal states. | `configure()`<br>`begin()`<br>`present()`<br>`destroy()`<br>`hidden` | `local-ai-status-ready`<br>`local-ai-status-dismissed`<br>`local-ai-retry` | Fully normalized LocalAIReadiness report |
| [`markdown-document.html`](#markdown-documenthtml) | Renders and navigates a complete Markdown document with focusable fragments. | `configure()`<br>`load()`<br>`render()`<br>`clear()`<br>`fail()`<br>`focus()`<br>`focusFragment()`<br>`destroy()` | `markdown-document-ready`<br>`markdown-document-state`<br>`markdown-document-loading`<br>`markdown-document-rendered`<br>`markdown-document-empty`<br>`markdown-document-error`<br>`markdown-document-navigate` | Complete Markdown/state normalized; malformed input and Marked/DOM failures remain visible |
| [`markdown-editor.html`](#markdown-editorhtml) | Configurable Markdown authoring, toolbar, preview, title, and save surface. | `configure()`<br>`focus()`<br>`clear()`<br>`saveEntry()`<br>`destroy()` | `markdown-editor-ready`<br>`markdown-editor-change`<br>`markdown-editor-saved` | Editor values normalized; injected save result mixed |
| [`media-embed.html`](#media-embedhtml) | Loads a parsed YouTube video or playlist embed with ordinary hosting by default, optional privacy enhancement, and an external-platform action. | `configure()`<br>`load()`<br>`destroy()` | `media-embed-ready`<br>`media-load`<br>`media-error`<br>`media-open-platform` | URL/error normalized; iframe/platform behavior native |
| [`modal.html`](#modalhtml) | Generic modal with population, open/close, actions, and sequential task execution. | `populate()`<br>`open()`<br>`close()`<br>`runTasks()`<br>`destroy()` | `modal-ready`<br>`modal-opened`<br>`modal-closed`<br>`modal-action` | Modal state normalized; injected task results mixed |
| [`output-panel.html`](#output-panelhtml) | Presents status, output, body, coverage, actions, pending, error, and cleared states. | `configure()`<br>`setOutput()`<br>`setBody()`<br>`setCoverage()`<br>`setActions()`<br>`setPending()`<br>`setStatus()`<br>`setError()`<br>`clear()`<br>`destroy()` | `output-panel-ready`<br>`output-panel-state`<br>`output-panel-change`<br>`output-panel-action`<br>`output-panel-error`<br>`output-panel-cleared` | DOM-normalized |
| [`preferences-form.html`](#preferences-formhtml) | Builds a schema-driven preferences form with submit, reset, busy, and status behavior. | `configure()`<br>`getValues()`<br>`setValues()`<br>`setBusy()`<br>`setStatus()`<br>`destroy()` | `preferences-form-ready`<br>`preferences-change`<br>`preferences-submit`<br>`preferences-reset` | Normalized form values |
| [`record-timeline.html`](#record-timelinehtml) | Displays complete chronological records/evidence and emits open actions. | `setItems()`<br>`populate()`<br>`destroy()` | `record-timeline-ready`<br>`record-timeline-open` | Complete item fields and inventories preserved |
| [`relationship-board.html`](#relationship-boardhtml) | Displays complete normalized relationship nodes/edges in graph and list forms. | `setGraph()`<br>`populate()`<br>`destroy()` | `relationship-board-ready`<br>`relationship-node-open`<br>`relationship-edge-open` | Complete graph inventories and fields preserved |
| [`screen-capture.html`](#screen-capturehtml) | Presents image, video, or GIF display-capture workflow. | `capture` (`ScreenCapture` instance)<br>`destroy()` | `screen-capture-ready`<br>`screen-capture-result` | State/result normalized; media permission/codec failures mixed |
| [`source-code-viewer.html`](#source-code-viewerhtml) | Renders complete line-addressable source code with load, error, focus, and state behavior. | `configure()`<br>`load()`<br>`render()`<br>`clear()`<br>`fail()`<br>`focus()`<br>`focusLine()`<br>`destroy()` | `source-code-viewer-ready`<br>`source-code-viewer-state`<br>`source-code-viewer-state-loading`<br>`source-code-viewer-state-ready`<br>`source-code-viewer-state-empty`<br>`source-code-viewer-state-error` | Complete mutable source/state |
| [`source-explanation.html`](#source-explanationhtml) | Presents an evidence finding, source selection, explanation, and save state. | `showFinding()`<br>`populate()`<br>`selectSource()`<br>`markSaved()`<br>`destroy()` | `source-explanation-ready`<br>`source-explanation-save`<br>`source-explanation-source-selected` | DOM-normalized |
| [`speech.html`](#speechhtml) | Coordinates explicit STT activation, speech controls, transcription completion, mute state, and microphone availability. | `configure()`<br>`setAvailability()`<br>`setMuted()`<br>`reportTTSError()`<br>`requestSTTActivation()`<br>`destroy()`<br>`availability`<br>`muted`<br>`initialMuted`<br>`componentReady` | `speech-ready`<br>`speech-transcription-complete`<br>`speech-transcription-error`<br>`speech-transcription-cancelled`<br>`speech-microphone-unavailable`<br>`speech-stt-activation-request`<br>`speech-stt-activation-error`<br>`speech-tts-lifecycle-error`<br>`speech-synthesis-error` | Sticky runtime speech readiness, explicit STT activation, request cancellation, TTS mute lifecycle intent, and exact TTS operation failures normalized; provider/model authority remains external |
| [`summary-strip.html`](#summary-striphtml) | Displays compact selectable KPI or summary items. | `configure()`<br>`setItems()`<br>`updateItem()`<br>`clear()`<br>`destroy()` | `summary-strip-ready`<br>`summary-strip-change`<br>`summary-strip-select` | DOM-normalized |
| [`table.html`](#tablehtml) | Builds and updates a simple header/body table. | `buildHeader()`<br>`buildTable()`<br>`destroy()` | `table-ready`<br>`header-update`<br>`body-update` | DOM-normalized |
| [`task-progress.html`](#task-progresshtml) | Runs and displays a task list with started/change/complete/error state. | `configure()`<br>`setTasks()`<br>`updateTask()`<br>`runTasks()`<br>`clear()`<br>`destroy()` | `task-progress-ready`<br>`task-progress-started`<br>`task-progress-change`<br>`task-progress-complete`<br>`task-progress-error` | Task state normalized; injected task results mixed |
| [`terminal-workspace.html`](#terminal-workspacehtml) | Presents multiple terminal sessions, output, active selection, theme, and terminal actions. | `configure()`<br>`addSession()`<br>`removeSession()`<br>`activateSession()`<br>`append()`<br>`clear()`<br>`setState()`<br>`setTheme()`<br>`focus()`<br>`destroy()` | `terminal-workspace-ready`<br>`terminal-submit`<br>`terminal-interrupt`<br>`terminal-clear`<br>`terminal-session-new`<br>`terminal-session-close`<br>`terminal-session-select`<br>`terminal-settings` | UI/session state normalized; native command results supplied externally |
| [`theme-editor.html`](#theme-editorhtml) | Edits, previews, saves, and resets semantic custom theme tokens. | `configure()`<br>`getTheme()`<br>`setTheme()`<br>`setBusy()`<br>`setStatus()`<br>`destroy()` | `theme-editor-ready`<br>`theme-preview`<br>`theme-save`<br>`theme-reset` | Fully normalized Theme values |
| [`theme-switcher.html`](#theme-switcherhtml) | Selects and refreshes system, light, dark, or custom theme mode. | `setMode()`<br>`refresh()` | No component-specific event | Preference/native appearance behavior mixed; no component-ready contract |
| [`unified-inbox.html`](#unified-inboxhtml) | Displays provider-neutral communication threads with active/loading state. | `configure()`<br>`setThreads()`<br>`setActive()`<br>`setLoading()`<br>`destroy()` | `unified-inbox-ready`<br>`inbox-refresh`<br>`thread-select` | DOM-normalized |
| [`voice-transcription.html`](#voice-transcriptionhtml) | Records segmented microphone audio only after authoritative STT readiness, exposes explicit selected-STT activation, transcribes complete content with cancellation, persists, and completes a combined transcript. | `configure()`<br>`requestSTTActivation()`<br>`startRecording()`<br>`stopRecording()`<br>`save()`<br>`completeTranscription()/complete()`<br>`clear()`<br>`reset()`<br>`destroy()` | `voice-transcription-ready`<br>`voice-transcription-state`<br>`voice-transcription-segment`<br>`voice-transcription-change`<br>`voice-transcription-complete`<br>`speech-transcription-complete`<br>`speech-transcription-cancelled`<br>`speech-stt-activation-request`<br>`speech-stt-activation-error` | Sticky runtime STT readiness, explicit activation, request cancellation, and complete state/text are normalized; media/provider behavior remains external |
| [`weather-widget.html`](#weather-widgethtml) | Displays normalized current and daily weather with refresh intent. | `setWeather()`<br>`clear()`<br>`destroy()` | `weather-widget-ready`<br>`weather-refresh` | Display normalized; provider supplied externally |
| [`web-navigator.html`](#web-navigatorhtml) | Guards embedded/external navigation and surfaces allow/block/open intents. | `configure()`<br>`navigate()`<br>`currentUrl()`<br>`destroy()` | `web-navigator-ready`<br>`web-navigate`<br>`web-navigation-blocked`<br>`web-open-external` | Navigation intent/decision normalized; browser navigation result platform-native |

## app-bar.html

### Overview

Responsive application navigation, route state, status, and trailing actions.

### Public surface

Methods/properties: `setNavigation()`, `setActiveRoute()`, `setStatus()`, `refresh()`, `destroy()`.

Events: `app-bar-ready`.

Slots: `brand-mark`, `product-name`, `navigation`, `status`, `trailing`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="app-bar.html"
  href="/arcane/components/app-bar.html">
</html-import>
```

## assistant-panel.html

### Overview

Reusable assistant drawer, message area, composer, pending/streaming/empty/error state, and actions.

### Public surface

Methods/properties: `open()`, `close()`, `toggle()`, `send()`, `clear()`, `setState()`, `focusComposer()`, `scrollToEnd()`, `destroy()`.

Events: `assistant-ready`, `assistant-opened`, `assistant-closed`,
`assistant-send`, `assistant-clear`.

Slots: `title`, `subtitle`, `identity`, `messages/message`, `composer`, `actions`, `pending`, `streaming`, `empty`, `error`, `footer`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized; caller/provider results remain external. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="assistant-panel.html"
  href="/arcane/components/assistant-panel.html">
</html-import>
```

## calculator.html

### Overview

Calculator keypad and result/error event surface backed by CalculatorEngine.

### Public surface

Methods/properties: `calculate()`, `destroy()`.

Events: `calculator-ready`, `calculation-complete`, `calculation-error`.

Shared dependencies: [`CalculatorEngine.js`](runtime-modules.md#calculatorenginejs).

### Availability and normalization

**Browser and supported native WebViews.** Normalized Calculation/error events. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="calculator.html"
  href="/arcane/components/calculator.html">
</html-import>
```

## chart.html

### Overview

Accessible uPlot line, area, or point chart with normalized options and rows.

### Public surface

Methods/properties: `configure()`, `populate()`, `setData()`, `addData()`, `update()`, `destroy()`.

Events: `chart-ready`, `chart-remove`.

Shared dependencies: [`ChartLibrary.js`](runtime-modules.md#chartlibraryjs), [`ComponentContracts.js`](runtime-modules.md#componentcontractsjs).

### Availability and normalization

**Browser and supported native WebViews.** Options/rows normalized; uPlot rendering is vendor-native. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="chart.html"
  href="/arcane/components/chart.html">
</html-import>
```

## chat.html

### Overview

Shared chat, visible selected-model activation request, file upload, streaming,
speech, language, availability, and conversation-timebox surface.

### Public surface

Methods/properties: `streamMessage()`, `setMessageProgress()`,
`setAIAvailability()`, `setInitialSpeechMuted()`,
`setConversationComplete()`, `bindConversationTimebox()`, `bindSession()`,
`submitMessage()`, `submitToolResult()`, `submitToolResults()`, `sendMessage()`,
`languageChanged()`, `requestAIActivation()`, `session`, `sessionStatus`,
`pendingTool`, `pendingTools`, `pendingToolCall`, `pendingToolCalls`, `modelName`,
and `destroy()`.

`sendMessage(text)` and `languageChanged(text)` are host-overridable async
extension callbacks. The component installs warning-only defaults when the host
does not supply them; applications may instead consume the corresponding
`chat-send-message` and `chat-language-changed` events.

`submitMessage(textOverride='',context={})` returns `Promise<boolean>`.
`context` accepts `source`, `preserveDraft`, `synthetic`, an optional exact
`operationId`, and an optional caller-owned `AbortSignal`. The component owns a
derived signal for each submission, supplies it in the mutable complete compatibility
`{message,context}` detail, and aborts it on canonical/DOM cancellation,
component destruction, or caller cancellation. `chat-send-message` is
cancelable and is the gate before `sendMessage(text,context)`; a canceled event
never reaches the host callback. Rejected host promises are observed as
`chat-send-error`, and stale settlement after abort or destruction is
suppressed.

`bindSession({ai,session,sessionOptions})` accepts exactly one of a public AI API
module or an existing compatible session, restores the UI transcript when
available, and uses provider-safe history as its compatibility fallback. The
transcript is a masked vertical scroll viewport; status and composer remain
outside it. Initial restoration and every user, assistant, tool, streaming,
progress, or failure mutation scrolls that viewport to its true bottom. Each
restored or new message uses a separate semantic `<time>` element at the card's
lower-right with an ISO `datetime`, full local title, and local 24-hour `HH:MM`
text.

Assistant structural calls render their nonempty `function.arguments.message`
as ordinary visible progress. The exact call name and argument string are
retained inside a collapsed `Tool call details` inspection surface. Displaying
a call does not settle it or enable another user turn.
`submitToolResults({results,request?},{operationId?,signal?})` atomically settles
the current ordered pending-call set. `results` supplies exactly one
`{toolCallId,disposition,message,persist?}` record for every pending ID, without
duplicates or omissions. `disposition` is `executed`, `declined`, `cancelled`,
or `not-executed`; every result in the batch uses the same persistence choice.
The method preserves pending order, persists and renders every human-readable
disposition plus complete message as matching `role:'tool'` requests, and then
renders one assistant continuation. Live submission and restored history both
require nonblank user-facing result content; accepted text is preserved exactly
rather than trimmed or rewritten.

`submitToolResult({toolCallId?,disposition,message,persist?,request?},{operationId?,signal?})`
is the one-call compatibility method. It infers the only pending ID when omitted
and rejects when zero or multiple calls are pending; parallel calls must use
`submitToolResults()`.
Optional plain-object `request` contains per-turn generation choices forwarded
through the session; a visibility-only host can use
`request:{toolChoice:'none'}` after a not-executed result so that continuation
cannot open another tool loop. Session-owned messages, signal, and streaming
state remain unavailable through that field. Its
terminal `chat-session-message` event releases the completed request ownership
before publication, so a listener may call `submitToolResult()` immediately
without a timer or microtask workaround. Internal protocol diagnostics remain
in the developer console; they are not inserted as assistant content, and a
rejected user draft is restored without losing its text.

Visible Chat failure copy is opt-in: only an Error deliberately marked
`userSafe:true` may provide its nonblank `userMessage` or `message`. Every
unknown provider, protocol, dispatch, persistence, or settlement failure keeps
its complete Error object in the developer console and diagnostic event while
the transcript and status use a generic user outcome. New diagnostic codes
therefore cannot become conversational text merely because they are absent
from a finite internal-error list.

`streamMessage(text,id,isThinking)` accepts text content only. An Error supplied
as a stream chunk is logged and rejected rather than stringified into the
transcript; any other nontext chunk fails with
`ARCANE_CHAT_STREAM_CONTENT_INVALID`. `setMessageProgress()` preserves explicit
string labels/status, but routes Error objects through the same user-safe copy
boundary and otherwise displays generic progress text while logging the exact
diagnostic value. Finite fractional and over-total progress remains visible in
the status text and accessibility description; only the decorative track width
is constrained to its visual range.

`pendingTools` is the mutable ordered array of actionable `{id,name,message}`
summaries and never exposes raw arguments. `pendingTool` is that compatibility
summary only when exactly one call is pending. `pendingToolCalls` exposes
complete copied call envelopes for an explicitly selected inspection or host
settlement surface, while `pendingToolCall` is its one-call compatibility view.
On restored history, `bindSession()` clears its binding guard before publishing
`chat-session-bound` with all four views. A listener can therefore call
`submitToolResult()` or `submitToolResults()` immediately after reload without
parsing transcript DOM or duplicating the session protocol. Restoration keeps
the complete ordered pending set and settles it only when the following tool
records contain one exact matching `tool_call_id` with nonblank content for
every call. An absent, blank, duplicate, different, partial, or overlapping
record leaves the chat unavailable and reports the coded
diagnostic to the developer console while the visible status says only that
the saved chat could not be opened.

For streaming sessions, every provisional structural card and the terminal
result must preserve the same choice, ordered call position, exact ID, type,
function name, argument string, and extension fields. A changed or omitted
observed call fails with
`AI_CHAT_STREAM_TOOL_CALL_MISMATCH`; the provisional card is removed and the
prior pending-call state is restored instead of leaving a ghost card or a false
settlement.

`setAIAvailability()` remains an LLM compatibility input, but selected sticky
`AIRuntimeState` LLM state wins over that boolean. STT and TTS readiness always
comes from sticky runtime role state; the method never forwards compatibility
speech booleans or synthesizes ready speech roles without a selected, loaded
provider.

When a selected LLM route is `unloaded` or in `error`, the component exposes a
keyboard-operable Start/Try again control while Send stays disabled. During
`loading`, the control becomes Cancel loading and reflects sticky progress
inside the same activation area. Progress is indeterminate until a real finite
positive total exists. A complete provider-reported `completed`, `total`, and
`unit` measure is informational and remains visible without gating activation.
`modelName` supplies the application-owned display label without moving model
policy into the component.
The default `requestAIActivation(intent)` forwards mutable
`{role:'llm',action:'load'|'unload',reason:'user'}` to
`requestAIRuntimeIntent()`. A host may replace that callback.

Before the callback, the component dispatches the bubbles/composed/cancelable
`chat-ai-activation-request` event with mutable complete `{intent,state}` detail.
`preventDefault()` suppresses the callback. A callback failure dispatches the
bubbles/composed, noncancelable `chat-ai-activation-error` event with mutable complete
`{request,error,message}`. A recognized canceled load whose current route is
`unloaded` or `unloading` is not reported as an activation error.

On `pagehide`, a BFCache-persisted page retains the component and its session,
speech, listeners, and provider state. A matching persisted `pageshow` refreshes
the current availability UI without rebinding or duplicating listeners.
Nonpersisted `pagehide` remains terminal and calls `destroy()`.

`destroy()` aborts the component's AI-runtime-state subscription, destroys the
activation controller, removes both page lifecycle listeners, calls the
optional speech controller's `destroy()`, sets `ready` to `false`, and returns
`true`; later calls return `false`. It does not initiate a provider load or
unload.

Chat listens for the bound (or current global) AI runtime's `ai-tts-failure`
event and forwards its complete Error and exact operation boundary to
`speech.reportTTSError()`. This includes decode and playback-start failures that
settle after `streamTTS()` has already resolved. Runtime mute, cancellation,
permission waiting, and stale generations remain non-errors.

Events: `chat-ready`, `chat-session-bound`, `chat-session-message`,
`chat-session-error`, `chat-send-message`, `chat-send-error`,
`chat-file-uploaded`, `chat-file-upload-error`, `chat-language-changed`,
`chat-language-change-error`, `chat-ai-activation-request`,
`chat-ai-activation-error`, `chat-speech-synthesis-error`, and
`conversation-timebox-error`.

All chat operation ids have the form
`<component-instance-id>:<kind>:<sequence>`. The stable public reasons are
`chat-ready`, `message-submission-requested`,
`message-submission-cancelled`, `caller-signal-aborted`,
`component-destroyed`, `host-message-submission-rejected`,
`file-storage-completed`, `file-storage-rejected`,
`language-change-requested`, `language-change-callback-rejected`,
`language-model-activation-requested`,
`language-model-activation-rejected`, `speech-synthesis-rejected`, and
`conversation-timebox-delivery-rejected`.

The stable chat boundary codes are:

- `ARCANE_CHAT_MESSAGE_SUBMISSION_ABORTED` for the owned submission signal;
- `ARCANE_CHAT_LANGUAGE_MODEL_ACTIVATION_REQUEST_REJECTED`;
- `ARCANE_CHAT_HOST_MESSAGE_SUBMISSION_REJECTED`;
- `ARCANE_CHAT_FILE_STORAGE_REJECTED`;
- `ARCANE_CHAT_LANGUAGE_CHANGE_CALLBACK_REJECTED`;
- `ARCANE_CHAT_SPEECH_SYNTHESIS_REQUEST_REJECTED`;
- `ARCANE_CHAT_CONVERSATION_TIMEBOX_DELIVERY_REJECTED`.

Error projections preserve the complete error detail, with the boundary `code`
and any distinct dependency `causeCode`. File projections preserve the complete
live `File` and its authored metadata. Language and LLM activation requests are
cancelable before their host callbacks. Every public detail remains mutable.

Shared dependencies: [`MD.js`](runtime-modules.md#mdjs), [`File.js`](runtime-entities.md#filejs), [`ConversationTimebox.js`](runtime-modules.md#conversationtimeboxjs), [`AIRuntimeState.js`](runtime-modules.md#airuntimestatejs).

### Availability and normalization

**Browser and supported native WebViews.** UI and provider-runtime state are
normalized; AI/storage/media behavior remains mixed. The component emits no
activation request on import or startup. After the user operates the visible
control and the component event is not canceled, it publishes a
capability-neutral user intent; a provider/runtime owner decides whether and
how to execute the requested load or unload. HTMLImport + DOM; injected
Arcane/provider modules where listed. Native methods remain subject to the
bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="chat.html"
  href="/arcane/components/chat.html">
</html-import>
```

## conversation-view.html

### Overview

Provider-neutral conversation display, advisory actions, composer, busy state, and status.

### Public surface

Methods/properties: `setConversation()`, `setBusy()`, `setStatus()`, `clearComposer()`, `destroy()`.

Events: `conversation-view-ready`, `communication-send`, `communication-advisory-action`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="conversation-view.html"
  href="/arcane/components/conversation-view.html">
</html-import>
```

## dashboard-config.html

### Overview

Selects which normalized chart definitions are visible on a dashboard.

### Public surface

Methods/properties: `configure()`, `setDefinitions()`, `setVisibility()`, `getChartOptions()`, `getEffectiveVisibility()`, `open()`, `close()`, `destroy()`.

Events: `dashboard-config-ready`, `dashboard-config-opened`, `dashboard-config-closed`, `dashboard-config-change`.

Shared dependencies: [`ComponentContracts.js`](runtime-modules.md#componentcontractsjs), [`WaitForComponent.js`](runtime-modules.md#waitforcomponentjs).

### Availability and normalization

**Browser and supported native WebViews.** Fully normalized definitions and visibility. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="dashboard-config.html"
  href="/arcane/components/dashboard-config.html">
</html-import>
```

## data-maintenance.html

### Overview

Runs destructive cleanup of empty chats and memories inside the current app data scope.

### Public surface

Methods/properties: `open()`, `destroy()`.

Events: `data-maintenance-ready`, `data-maintenance-complete`.

Shared dependencies: [`DataMaintenance.js`](runtime-modules.md#datamaintenancejs), [`WaitForComponent.js`](runtime-modules.md#waitforcomponentjs).

### Availability and normalization

**Browser and supported native WebViews.** Normalized counts; DBOPFS failures mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="data-maintenance.html"
  href="/arcane/components/data-maintenance.html">
</html-import>
```

## data-view.html

### Overview

Opens a generic modal-style data view around an injected provider.

### Public surface

Methods/properties: `beforeOpen()`, `open()`, `destroy()`.

Events: `data-view-ready`.

Shared dependencies: [`WaitForComponent.js`](runtime-modules.md#waitforcomponentjs).

### Availability and normalization

**Browser and supported native WebViews.** DOM-native result. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="data-view.html"
  href="/arcane/components/data-view.html">
</html-import>
```

## directory-picker.html

### Overview

Presents the provider-owned OS directory chooser with change/cancel/error states.

### Public surface

Methods/properties: `configure()`, `focus()`, `select()`, `destroy()`.

Events: `directory-picker-ready`, `directory-picker-change`, `directory-picker-cancel`, `directory-picker-error`.

Shared dependencies: [`DirectoryPicker.js`](runtime-modules.md#directorypickerjs).

### Availability and normalization

**Browser and supported native WebViews.** Strict normalized native selection/error. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="directory-picker.html"
  href="/arcane/components/directory-picker.html">
</html-import>
```

## document-inspector.html

### Overview

Inspects PDF, text, or source documents and records review state.

### Public surface

Methods/properties: `loadDocument()`, `selectView()`, `markSaved()`, `destroy()`.

Events: `document-inspector-ready`, `document-review-change`.

Shared dependencies: [`MD.js`](runtime-modules.md#mdjs).

### Availability and normalization

**Browser and supported native WebViews.** Document state normalized; browser document APIs mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="document-inspector.html"
  href="/arcane/components/document-inspector.html">
</html-import>
```

## file-drop.html

### Overview

Acquires files by drag/drop or picker and presents busy, progress, error, and cleared state.

### Public surface

Methods/properties: `configure()`, `openPicker()`, `clear()`, `setBusy()`, `setError()`, `setProgress()`, `destroy()`.

Events: `file-drop-ready`, `file-drop-selected`, `file-drop-progress`, `file-drop-state`, `file-drop-error`.

### Availability and normalization

**Browser and supported native WebViews.** Complete picker, drop, and API selections are preserved; `multiple` remains a picker hint and `maxFiles` remains compatible configuration rather than a rejection or discard gate. Browser File/drop errors are mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="file-drop.html"
  href="/arcane/components/file-drop.html">
</html-import>
```

## file-inspector.html

### Overview

Displays file metadata, preview, busy/error state, and caller-defined actions.

### Public surface

Methods/properties: `configure()`, `show()`, `clear()`, `setActions()`, `setBusy()`, `setError()`, `setPreview()`, `destroy()`.

Events: `file-inspector-ready`, `file-inspector-action`, `file-inspector-change`, `file-inspector-cleared`, `file-inspector-error`.

Slots: `title`, `preview`, `metadata`, `actions`.

### Availability and normalization

**Browser and supported native WebViews.** State normalized; preview/provider behavior mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="file-inspector.html"
  href="/arcane/components/file-inspector.html">
</html-import>
```

## file-manager.html

### Overview

Browses, filters, selects, opens, and acts on app-scoped files.

### Public surface

Methods/properties: `setProvider()`, `loadAll()`, `setFilter()`, `select()`, `clearSelection()`, `destroy()`.

Events: `file-manager-ready`, `file-manager-select`, `file-manager-open`, `file-manager-action`.

Shared dependencies: [`DBOPFS.js`](runtime-modules.md#dbopfsjs), [`File.js`](runtime-entities.md#filejs), [`WaitForComponent.js`](runtime-modules.md#waitforcomponentjs).

### Availability and normalization

**Browser and supported native WebViews.** Selection/filter state normalized; storage/provider behavior mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="file-manager.html"
  href="/arcane/components/file-manager.html">
</html-import>
```

## header.html

### Overview

Legacy title bar with history, reload, online marker, presentation labels, and 988 link.

### Public surface

This fragment declares no public host method.

This fragment declares no component-specific readiness or action event; use the loader's `html-import-ready` only to know that import execution completed.

### Availability and normalization

**Browser and supported native WebViews.** Browser/platform-native behavior; no component-ready contract. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="header.html"
  href="/arcane/components/header.html">
</html-import>
```

## integration-settings.html

### Overview

Edits non-secret communication service configuration and service actions.

### Public surface

Methods/properties: `configure()`, `getValues()`, `setStatus()`, `destroy()`.

Events: `integration-settings-ready`, `integration-settings-save`, `integration-settings-close`, `integration-action`.

### Availability and normalization

**Browser and supported native WebViews.** Normalized non-secret values. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="integration-settings.html"
  href="/arcane/components/integration-settings.html">
</html-import>
```

## local-ai-status.html

### Overview

Presents local-AI standby, failure, recovery, guidance, retry, and dismissal states.

### Public surface

Methods/properties: `configure()`, `begin()`, `present()`, `destroy()`, and the `hidden` property.

Events: `local-ai-status-ready`, `local-ai-status-dismissed`, `local-ai-retry`.

Shared dependencies: [`LocalAIReadiness.js`](runtime-modules.md#localaireadinessjs).

### Availability and normalization

**Browser and supported native WebViews.** Fully normalized LocalAIReadiness report. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="local-ai-status.html"
  href="/arcane/components/local-ai-status.html">
</html-import>
```

## markdown-document.html

### Overview

Renders and navigates a complete Markdown document with focusable fragments.

### Public surface

Methods/properties: `configure()`, `load()`, `render()`, `clear()`, `fail()`, `focus()`, `focusFragment()`, `destroy()`.

Events: `markdown-document-ready`, `markdown-document-state`,
`markdown-document-loading`, `markdown-document-rendered`,
`markdown-document-empty`, `markdown-document-error`, and
`markdown-document-navigate`.

Shared dependencies: [`MD.js`](runtime-modules.md#mdjs).

### Availability and normalization

**Browser and supported native WebViews.** Complete Markdown and state are
normalized; malformed input and Marked/DOM failures remain visible. HTMLImport
+ DOM; injected Arcane/provider modules where listed. Native methods remain
subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="markdown-document.html"
  href="/arcane/components/markdown-document.html">
</html-import>
```

## markdown-editor.html

### Overview

Configurable Markdown authoring, toolbar, preview, title, and save surface.

### Public surface

Methods/properties: `configure()`, `focus()`, `clear()`, `saveEntry()`, `destroy()`.

Events: `markdown-editor-ready`, `markdown-editor-change`, `markdown-editor-saved`.

Shared dependencies: [`MD.js`](runtime-modules.md#mdjs), [`ComponentContracts.js`](runtime-modules.md#componentcontractsjs).

### Availability and normalization

**Browser and supported native WebViews.** Editor values normalized; injected save result mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="markdown-editor.html"
  href="/arcane/components/markdown-editor.html">
</html-import>
```

## media-embed.html

### Overview

Loads a parsed YouTube video or playlist embed and exposes an external-platform
action. Ordinary YouTube hosting is the default; `configure({privacyEnhanced:true})`
explicitly selects the privacy-enhanced host.

### Public surface

Methods/properties: `configure()`, `load()`, `destroy()`.

Events: `media-embed-ready`, `media-load`, `media-error`, `media-open-platform`.

Shared dependencies: [`YouTubeMedia.js`](runtime-modules.md#youtubemediajs).

### Availability and normalization

**Browser and supported native WebViews.** URL/error normalized; iframe/platform behavior native. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="media-embed.html"
  href="/arcane/components/media-embed.html">
</html-import>
```

## modal.html

### Overview

Generic modal with population, open/close, actions, and sequential task execution.

### Public surface

Methods/properties: `populate()`, `open()`, `close()`, `runTasks()`, `destroy()`.

Events: `modal-ready`, `modal-opened`, `modal-closed`, `modal-action`.

Slots: `header`, `body`, `footer`.

### Availability and normalization

**Browser and supported native WebViews.** Modal state normalized; injected task results mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="modal.html"
  href="/arcane/components/modal.html">
</html-import>
```

## output-panel.html

### Overview

Presents status, output, body, coverage, actions, pending, error, and cleared states.

### Public surface

Methods/properties: `configure()`, `setOutput()`, `setBody()`, `setCoverage()`, `setActions()`, `setPending()`, `setStatus()`, `setError()`, `clear()`, `destroy()`.

Events: `output-panel-ready`, `output-panel-state`, `output-panel-change`, `output-panel-action`, `output-panel-error`, `output-panel-cleared`.

Slots: `title`, `header-actions`, `body`, `coverage`, `actions`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="output-panel.html"
  href="/arcane/components/output-panel.html">
</html-import>
```

## preferences-form.html

### Overview

Builds a schema-driven preferences form with submit, reset, busy, and status behavior.

### Public surface

Methods/properties: `configure()`, `getValues()`, `setValues()`, `setBusy()`, `setStatus()`, `destroy()`.

Events: `preferences-form-ready`, `preferences-change`, `preferences-submit`, `preferences-reset`.

### Availability and normalization

**Browser and supported native WebViews.** Normalized form values. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="preferences-form.html"
  href="/arcane/components/preferences-form.html">
</html-import>
```

## record-timeline.html

### Overview

Displays chronological records/evidence and emits open actions.

### Public surface

Methods/properties: `setItems()`, `populate()`, `destroy()`.

Events: `record-timeline-ready`, `record-timeline-open`.

### Availability and normalization

**Browser and supported native WebViews.** Complete item inventories and fields are preserved while missing identity/date records remain non-renderable. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="record-timeline.html"
  href="/arcane/components/record-timeline.html">
</html-import>
```

## relationship-board.html

### Overview

Displays normalized relationship nodes/edges in graph and list forms.

### Public surface

Methods/properties: `setGraph()`, `populate()`, `destroy()`.

Events: `relationship-board-ready`, `relationship-node-open`, `relationship-edge-open`.

### Availability and normalization

**Browser and supported native WebViews.** Complete node, edge, lane, label, and summary inventories are preserved; edges still require existing endpoints. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="relationship-board.html"
  href="/arcane/components/relationship-board.html">
</html-import>
```

## screen-capture.html

### Overview

Presents image, video, or GIF display-capture workflow.

### Public surface

Methods/properties: `capture` (the component-owned `ScreenCapture` instance) and `destroy()`.

Events: `screen-capture-ready`, `screen-capture-result`.

Ready uses operation id `screen-capture-ready-<component-instance-id>`;
capture results use the current instance-owned generation. `destroy()`
invalidates that generation, aborts UI listeners, revokes the preview URL,
destroys the `ScreenCapture` instance, disposes the source, marks the host
unready, and returns `true`; repeated calls return `false`.

Shared dependencies: [`ScreenCapture.js`](runtime-modules.md#screencapturejs).

### Availability and normalization

**Browser and supported native WebViews.** State/result normalized; media permission/codec failures mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="screen-capture.html"
  href="/arcane/components/screen-capture.html">
</html-import>
```

## source-code-viewer.html

### Overview

Renders line-addressable source code with load, error, focus, and state behavior.

### Public surface

Methods/properties: `configure()`, `load()`, `render()`, `clear()`, `fail()`, `focus()`, `focusLine()`, `destroy()`.

Events: `source-code-viewer-ready`, `source-code-viewer-state`,
`source-code-viewer-state-loading`, `source-code-viewer-state-ready`,
`source-code-viewer-state-empty`, and `source-code-viewer-state-error`.

### Availability and normalization

**Browser and supported native WebViews.** Complete mutable source/state is rendered without character or line caps; malformed control-character metadata still fails honestly. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="source-code-viewer.html"
  href="/arcane/components/source-code-viewer.html">
</html-import>
```

## source-explanation.html

### Overview

Presents an evidence finding, source selection, explanation, and save state.

### Public surface

Methods/properties: `showFinding()`, `populate()`, `selectSource()`, `markSaved()`, `destroy()`.

Events: `source-explanation-ready`, `source-explanation-save`, `source-explanation-source-selected`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="source-explanation.html"
  href="/arcane/components/source-explanation.html">
</html-import>
```

## speech.html

### Overview

Coordinates explicit speech-to-text activation, speech controls, transcription
completion, mute state, and microphone availability.

### Public surface

Methods/properties: `configure()`, `setAvailability()`, `setMuted()`,
`reportTTSError(error,boundary='synthesis')`, `requestSTTActivation()`,
`destroy()`, `availability`, `muted`, `initialMuted`, and `componentReady`.

Events: `speech-ready`, `speech-transcription-complete`,
`speech-transcription-error`, `speech-transcription-cancelled`,
`speech-microphone-unavailable`, `speech-stt-activation-request`,
`speech-stt-activation-error`, `speech-tts-lifecycle-error`, and
`speech-synthesis-error`.

Shared dependencies: [`AI.js`](runtime-modules.md#aijs),
[`AIRuntimeState.js`](runtime-modules.md#airuntimestatejs),
[`ComponentContracts.js`](runtime-modules.md#componentcontractsjs), and
[`DBLS.js`](runtime-modules.md#dblsjs).

The Hold to talk control remains disabled unless sticky STT state is `ready`,
the role is not busy, and microphone capture is available. For an explicitly
selected STT route, a separate keyboard-operable control presents Start
transcription while `unloaded`, Cancel loading while `loading`, a disabled
Canceling state while `unloading`, and Try again with the sticky error while
`error`. Selected-unloaded, busy, and error states are shown as distinct facts;
none is treated as ready.

Only captured microphone input that completes the selected STT route emits
`speech-transcription-complete`. A transient capture rejection reports
`speech-microphone-unavailable` but remains locally retryable; an observed
permission-denied state disables capture until the browser reports that the
permission is available again, at which point the microphone-owned status is
cleared.

The default `requestSTTActivation(intent)` forwards the mutable
`{role:'stt',action:'load'|'unload',reason:'user'}` record to
`requestAIRuntimeIntent()`. Before calling it, the component emits a bubbling,
composed, cancelable `speech-stt-activation-request` event with mutable complete
`{intent,state}` detail. `preventDefault()` suppresses the callback and intent.
Callback failure emits `speech-stt-activation-error` with mutable complete
`{request,error,message}` detail. Cancel loading publishes an `unload` intent;
only subsequent sticky `unloading` or `unloaded` state confirms lifecycle
progress, and callback return never proves provider work stopped.

Provider and runtime failures use generic visible speech status unless their
Error owner explicitly marks nonblank copy with `userSafe:true`. Complete
unknown diagnostics remain available through the developer console and error
events; they do not become control labels or status text by default. The same
boundary applies to STT activation, transcription, TTS lifecycle, synthesis,
and playback failures.

`reportTTSError()` recognizes `synthesis`, `decode`, `playback-start`, and
`playback-resume`. It mutes and stops the failed operation, preserves sticky
provider readiness, and emits `speech-synthesis-error` with the exact boundary,
stable reason/code, generic user-safe status, and complete Error in the local
event detail.

- `synthesis`: `tts-synthesis-rejected` / `ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED`;
- `decode`: `tts-decode-rejected` / `ARCANE_SPEECH_TTS_DECODE_REJECTED`;
- `playback-start`: `tts-playback-start-rejected` / `ARCANE_SPEECH_TTS_PLAYBACK_START_REJECTED`;
- `playback-resume`: `tts-playback-resume-rejected` / `ARCANE_SPEECH_TTS_PLAYBACK_RESUME_REJECTED`.

The component emits no activation request on import or state observation.
Provider registration and selection remain inert, and default
`startTranscription=false` does not request STT during runtime startup. The
provider/runtime owner decides whether and how to execute a user intent; the
component never selects a runtime or model, downloads artifacts, reloads after
failure, or falls back to another provider.

`setAvailability()` is compatibility-only for microphone and negative
unselected-role reports. Positive STT/TTS booleans cannot manufacture a ready
role, and no compatibility value can replace a selected sticky role. Hold to
talk stays disabled without sticky ready STT, and compatibility input cannot
enable a no-selection TTS role or bypass explicit TTS activation.

Each transcription request owns an `AbortController`; its signal is passed as
the third argument to `AI.fetchSTT()`. Cancel, a newer capture, and `destroy()`
abort that controller and suppress late results. This proves request delivery
was canceled, not that an uncooperative provider stopped underlying work.

Each microphone attempt also owns one capture generation and one operation id
from the initial `getUserMedia()` request through transcription settlement. A
release while permission is still pending retires only that generation because
the browser request cannot be canceled synchronously. If that stale request
later resolves, the component stops its returned stream without clearing a
newer press, status, operation id, or retry. Active capture finalization checks
both the generation and operation id, and successful transcription retains the
same capture operation id rather than inventing a second correlation boundary.

User Unmute calls the shared `AI.setSpeechMuted(false)` lifecycle owner before
or with publishing the TTS load intent, so the runtime can legally load TTS.
Configured `initialMuted:false` records that same unmute intent even when the
TTS route is still unselected or loading; the component remains publicly muted
until the selected role reaches `ready`, then applies the preserved intent.
Mute calls `AI.setSpeechMuted(true)`, stops playback, cancels active TTS work,
and unloads the selected TTS role. Lifecycle failures remain visible through
`speech-tts-lifecycle-error` and sticky role state.

A BFCache-persisted `pagehide` retains the component, active provider state,
microphone permission observation, and listeners. On persisted `pageshow`, the
component resynchronizes the current AI mute state and rerenders its controls
and status without duplicating activation or provider work. Nonpersisted
`pagehide` remains terminal and destroys the component.

Speech operation ids are
`<component-instance-id>:<kind>:<sequence>`. Canonical cancellation reasons are
`stt-role-unready`, `stt-provider-transcription-cancelled`, `stt-role-busy`,
`microphone-unavailable`, `component-destroyed`, and
`stt-transcription-cancelled`. Microphone capture-failure reasons are
`microphone-input-missing`, `microphone-input-unavailable`,
`microphone-capture-denied`, and `microphone-capture-rejected`. Component
boundary codes are `ARCANE_SPEECH_MICROPHONE_CAPTURE_REJECTED`,
`ARCANE_SPEECH_STT_TRANSCRIPTION_REQUEST_REJECTED`,
`ARCANE_SPEECH_TTS_LOAD_REJECTED`, `ARCANE_SPEECH_TTS_UNLOAD_REJECTED`,
`ARCANE_SPEECH_TTS_SYNTHESIS_REQUEST_REJECTED`,
`ARCANE_SPEECH_TTS_DECODE_REJECTED`,
`ARCANE_SPEECH_TTS_PLAYBACK_START_REJECTED`, and
`ARCANE_SPEECH_TTS_PLAYBACK_RESUME_REJECTED`. Each of those component-boundary
public projections keeps the exact boundary in `code` and preserves a distinct
string code from the browser, runtime, or provider additively as `causeCode`.
A missing STT method therefore uses boundary
`ARCANE_SPEECH_STT_TRANSCRIPTION_REQUEST_REJECTED` with
`causeCode:'ARCANE_SPEECH_STT_RUNTIME_METHOD_UNAVAILABLE'`.

Stable rejection reasons are `stt-transcription-rejected`,
`tts-load-rejected`, `tts-unload-rejected`, `tts-synthesis-rejected`,
`tts-decode-rejected`, `tts-playback-start-rejected`, and
`tts-playback-resume-rejected`. Shared activation rejection uses
`ARCANE_STT_ACTIVATION_REQUEST_REJECTED` and `activation-request-rejected`.

### Availability and normalization

**Browser and supported native WebViews.** UI/runtime state and explicit user
STT activation intent are normalized; provider/model authority and media
behavior remain external. HTMLImport + DOM; injected Arcane/provider modules
where listed. Native methods remain subject to the bound app's capabilities.
[Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="speech.html"
  href="/arcane/components/speech.html">
</html-import>
```

## summary-strip.html

### Overview

Displays compact selectable KPI or summary items.

### Public surface

Methods/properties: `configure()`, `setItems()`, `updateItem()`, `clear()`, `destroy()`.

Events: `summary-strip-ready`, `summary-strip-change`, `summary-strip-select`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="summary-strip.html"
  href="/arcane/components/summary-strip.html">
</html-import>
```

## table.html

### Overview

Builds and updates a simple header/body table.

### Public surface

Methods/properties: `buildHeader()`, `buildTable()`, `destroy()`.

Events: `table-ready`, `header-update`, `body-update`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="table.html"
  href="/arcane/components/table.html">
</html-import>
```

## task-progress.html

### Overview

Runs and displays a task list with started/change/complete/error state.

### Public surface

Methods/properties: `configure()`, `setTasks()`, `updateTask()`, `runTasks()`, `clear()`, `destroy()`.

Events: `task-progress-ready`, `task-progress-started`, `task-progress-change`, `task-progress-complete`, `task-progress-error`.

### Availability and normalization

**Browser and supported native WebViews.** Task state normalized; injected task results mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="task-progress.html"
  href="/arcane/components/task-progress.html">
</html-import>
```

## terminal-workspace.html

### Overview

Presents multiple terminal sessions, output, active selection, theme, and terminal actions.

### Public surface

Methods/properties: `configure()`, `addSession()`, `removeSession()`, `activateSession()`, `append()`, `clear()`, `setState()`, `setTheme()`, `focus()`, `destroy()`.

Events: `terminal-workspace-ready`, `terminal-submit`, `terminal-interrupt`, `terminal-clear`, `terminal-session-new`, `terminal-session-close`, `terminal-session-select`, `terminal-settings`.

Shared dependencies: [`AnsiText.js`](runtime-modules.md#ansitextjs).

### Availability and normalization

**Browser and supported native WebViews.** UI/session state normalized; native command results supplied externally. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="terminal-workspace.html"
  href="/arcane/components/terminal-workspace.html">
</html-import>
```

## theme-editor.html

### Overview

Edits, previews, saves, and resets semantic custom theme tokens.

### Public surface

Methods/properties: `configure()`, `getTheme()`, `setTheme()`, `setBusy()`, `setStatus()`, `destroy()`.

Events: `theme-editor-ready`, `theme-preview`, `theme-save`, `theme-reset`.

Shared dependencies: [`Theme.js`](runtime-entities.md#themejs).

### Availability and normalization

**Browser and supported native WebViews.** Fully normalized Theme values. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="theme-editor.html"
  href="/arcane/components/theme-editor.html">
</html-import>
```

## theme-switcher.html

### Overview

Selects and refreshes system, light, dark, or custom theme mode.

### Public surface

Methods/properties: `setMode()`, `refresh()`.

This fragment declares no component-specific readiness or action event; use the loader's `html-import-ready` only to know that import execution completed.

Shared dependencies: [`ThemeManager.js`](runtime-modules.md#thememanagerjs).

### Availability and normalization

**Browser and supported native WebViews.** Preference/native appearance behavior mixed; no component-ready contract. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="theme-switcher.html"
  href="/arcane/components/theme-switcher.html">
</html-import>
```

## unified-inbox.html

### Overview

Displays provider-neutral communication threads with active/loading state.

### Public surface

Methods/properties: `configure()`, `setThreads()`, `setActive()`, `setLoading()`, `destroy()`.

Events: `unified-inbox-ready`, `inbox-refresh`, `thread-select`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="unified-inbox.html"
  href="/arcane/components/unified-inbox.html">
</html-import>
```

## voice-transcription.html

### Overview

Records segmented microphone audio only after authoritative STT readiness,
exposes explicit selected-STT activation, transcribes with cancellation,
persists, and completes a combined transcript.

### Public surface

Methods/properties: `configure()`, `requestSTTActivation()`, `startRecording()`,
`stopRecording()`, `save()`, `completeTranscription()/complete()`, `clear()`,
`reset()`, `destroy()`.

Events: `voice-transcription-ready`, `voice-transcription-state`,
`voice-transcription-segment`, `voice-transcription-change`,
`voice-transcription-complete`, `speech-transcription-complete`,
`speech-transcription-cancelled`, `speech-stt-activation-request`, and
`speech-stt-activation-error`.

Shared dependencies: [`MD.js`](runtime-modules.md#mdjs),
[`ComponentContracts.js`](runtime-modules.md#componentcontractsjs),
[`AIRuntimeState.js`](runtime-modules.md#airuntimestatejs), and
[`AI.js`](runtime-modules.md#aijs).

### Availability and normalization

**Browser and supported native WebViews.** The component subscribes
synchronously to sticky `AIRuntimeState.roles.stt`; its recording Start button
and public `startRecording()` both remain unavailable unless that role is exactly
`ready` and not busy. A configured `transcribe(file,context)` callback remains
request plumbing rather than readiness authority. Its context now includes the
owned `signal` additively. The default route calls
`AI.fetchSTT(file,undefined,signal)` so the callback position remains valid and
readiness loss or destruction can abort delivery.

For a selected `unloaded`, `loading`, `unloading`, or `error` role, the component
keeps recording Start disabled and presents the same keyboard-operable Start
transcription/Try again or Cancel loading control as `speech.html`. Both use the
shared `createSTTActivationController()` contract. User operation emits the
cancelable `speech-stt-activation-request` event with mutable complete `{intent,state}`;
`preventDefault()` suppresses the callback. The default
`requestSTTActivation(intent)` publishes the mutable
`{role:'stt',action:'load'|'unload',reason:'user'}` intent. Callback failure emits
`speech-stt-activation-error` with mutable complete `{request,error,message}`. Import and
state observation emit no activation request and never begin a model download.
Unknown provider/runtime diagnostics remain complete in the developer console
and error events, while controls use generic visible outcomes unless the Error
owner explicitly marks nonblank copy with `userSafe:true`.

If sticky readiness is lost during microphone acquisition, capture, or the STT
request, the component invalidates the session, aborts the owned request signal,
releases media, discards late completion, and emits
`speech-transcription-cancelled`. Its local compatibility reason is
`runtime-unready`, while its canonical/public reason is `stt-role-unready`. A
busy role uses `stt-role-busy` in both views. A current provider cancellation
returns the component workflow to `idle` with local
`stt-provider-request-cancelled` and canonical/public
`stt-provider-transcription-cancelled`; destruction uses
`component-destroyed` in both views. Replacing configuration without an
`initialValue` during active work uses `configuration-replaced` in both views.
Stale teardown results remain suppressed. A
current save failure, including `AbortError`, enters the visible `error` state.
Readiness loss after transcription has finished does not invalidate an already
pending application save or completion callback: its settlement remains
observable, while any new recording remains gated by current sticky readiness.
Assigning `value` or calling `configure({initialValue})` explicitly supersedes
an in-flight microphone start, STT request, save, or completion. The component
advances its generation, aborts owned STT delivery, releases owned media, emits
`speech-transcription-cancelled` with
`reason:'transcript-replaced'`, and suppresses
late settlement before publishing the assigned transcript. Assigning transcript
text during active recording preserves that recording and changes the transcript
to which the captured segment will be appended.
On a BFCache-persisted `pagehide`, the component and its owned state remain
live. A persisted `pageshow` rerenders the retained authoritative state without
restarting capture, transcription, or activation. Nonpersisted `pagehide`
retains terminal destruction.
`destroy()` aborts the state subscription, cancels active work, removes the
activation listener, sets component `ready` to `false`, and returns `true`;
repeated destruction is
idempotent. Destruction is terminal: Start, activation, and Complete remain
disabled and status remains unavailable. `voice-transcription-state` detail is
the mutable complete `{message,state,stt}` record, where `state` remains the component
workflow and `stt` is the authoritative mutable role record. Transcript
completion stays available when STT is unavailable before destruction.
State/text, explicit activation, and request cancellation are normalized;
provider/model authority and media behavior remain external. HTMLImport + DOM;
injected Arcane/provider modules where listed.
Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="voice-transcription.html"
  href="/arcane/components/voice-transcription.html">
</html-import>
```

## weather-widget.html

### Overview

Displays normalized current and daily weather with refresh intent.

### Public surface

Methods/properties: `setWeather()`, `clear()`, `destroy()`.

Events: `weather-widget-ready`, `weather-refresh`.

### Availability and normalization

**Browser and supported native WebViews.** Display normalized; provider supplied externally. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="weather-widget.html"
  href="/arcane/components/weather-widget.html">
</html-import>
```

## web-navigator.html

### Overview

Guards embedded/external navigation and surfaces allow/block/open intents.

### Public surface

Methods/properties: `configure()`, `navigate()`, `currentUrl()`, `destroy()`.

Events: `web-navigator-ready`, `web-navigate`, `web-navigation-blocked`, `web-open-external`.

### Availability and normalization

**Browser and supported native WebViews.** Navigation intent/decision normalized; browser navigation result platform-native. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

### Example

```html
<html-import
  id="web-navigator.html"
  href="/arcane/components/web-navigator.html">
</html-import>
```

## Readiness caveats

`header.html` and `theme-switcher.html` do not currently publish a component-specific ready event/property. Consumers can observe `html-import-ready` for completed fragment execution and then feature-detect their methods. Other fragments publish the exact ready event listed above.
