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

## Canonical inventory

| Component | Capability | Principal methods | Events | Normalization |
| --- | --- | --- | --- | --- |
| [`app-bar.html`](#app-barhtml) | Responsive application navigation, route state, status, and trailing actions. | `setNavigation()`<br>`setActiveRoute()`<br>`setStatus()`<br>`refresh()` | `app-bar-ready` | DOM-normalized |
| [`assistant-panel.html`](#assistant-panelhtml) | Reusable assistant drawer, message area, composer, pending/streaming/empty/error state, and actions. | `open()`<br>`close()`<br>`toggle()`<br>`send()`<br>`clear()`<br>`setState()`<br>`focusComposer()`<br>`scrollToEnd()` | `assistant-ready`<br>`assistant-send`<br>`assistant-clear` | DOM-normalized; caller/provider results remain external |
| [`calculator.html`](#calculatorhtml) | Calculator keypad and result/error event surface backed by CalculatorEngine. | `calculate()` | `calculator-ready`<br>`calculation-complete`<br>`calculation-error` | Normalized Calculation/error events |
| [`chart.html`](#charthtml) | Accessible uPlot line, area, or point chart with normalized options and rows. | `configure()`<br>`populate()`<br>`setData()`<br>`addData()`<br>`update()`<br>`destroy()` | `chart-ready`<br>`chart-remove` | Options/rows normalized; uPlot rendering is vendor-native |
| [`chat.html`](#chathtml) | Shared chat, visible selected-model activation request, file upload, streaming, speech, language, availability, and conversation-timebox surface. | `streamMessage()`<br>`setMessageProgress()`<br>`setAIAvailability()`<br>`setInitialSpeechMuted()`<br>`setConversationComplete()`<br>`bindConversationTimebox()`<br>`submitMessage()`<br>`sendMessage()`<br>`languageChanged()`<br>`requestAIActivation()`<br>`destroy()` | `chat-ready`<br>`chat-send-message`<br>`chat-send-error`<br>`chat-file-uploaded`<br>`chat-language-changed`<br>`chat-ai-activation-request`<br>`chat-ai-activation-error`<br>`conversation-timebox-error` | UI/runtime state and explicit user activation intent normalized; AI/storage/media behavior mixed |
| [`conversation-view.html`](#conversation-viewhtml) | Provider-neutral conversation display, advisory actions, composer, busy state, and status. | `setConversation()`<br>`setBusy()`<br>`setStatus()`<br>`clearComposer()` | `conversation-view-ready`<br>`communication-send`<br>`communication-advisory-action` | DOM-normalized |
| [`dashboard-config.html`](#dashboard-confightml) | Selects which normalized chart definitions are visible on a dashboard. | `configure()`<br>`setDefinitions()`<br>`setVisibility()`<br>`getChartOptions()`<br>`getEffectiveVisibility()`<br>`open()`<br>`close()` | `dashboard-config-ready`<br>`dashboard-config-opened`<br>`dashboard-config-closed`<br>`dashboard-config-change` | Fully normalized definitions and visibility |
| [`data-maintenance.html`](#data-maintenancehtml) | Runs destructive cleanup of empty chats and memories inside the current app data scope. | `open()` | `data-maintenance-ready`<br>`data-maintenance-complete` | Normalized counts; DBOPFS failures mixed |
| [`data-view.html`](#data-viewhtml) | Opens a generic modal-style data view around an injected provider. | `beforeOpen()`<br>`open()` | `data-view-ready` | DOM-native result |
| [`directory-picker.html`](#directory-pickerhtml) | Presents the provider-owned OS directory chooser with change/cancel/error states. | `configure()`<br>`focus()`<br>`select()` | `directory-picker-ready`<br>`directory-picker-change`<br>`directory-picker-cancel`<br>`directory-picker-error` | Strict normalized native selection/error |
| [`document-inspector.html`](#document-inspectorhtml) | Inspects PDF, text, or source documents and records review state. | `loadDocument()`<br>`selectView()`<br>`markSaved()` | `document-inspector-ready`<br>`document-review-change` | Document state normalized; browser document APIs mixed |
| [`file-drop.html`](#file-drophtml) | Acquires files by drag/drop or picker and presents busy, progress, error, and cleared state. | `configure()`<br>`openPicker()`<br>`clear()`<br>`setBusy()`<br>`setError()`<br>`setProgress()` | `file-drop-ready`<br>`file-drop-selected`<br>`file-drop-progress`<br>`file-drop-state`<br>`file-drop-error` | State normalized; browser File/drop errors mixed |
| [`file-inspector.html`](#file-inspectorhtml) | Displays file metadata, preview, busy/error state, and caller-defined actions. | `configure()`<br>`show()`<br>`clear()`<br>`setActions()`<br>`setBusy()`<br>`setError()`<br>`setPreview()` | `file-inspector-ready`<br>`file-inspector-action`<br>`file-inspector-change`<br>`file-inspector-cleared`<br>`file-inspector-error` | State normalized; preview/provider behavior mixed |
| [`file-manager.html`](#file-managerhtml) | Browses, filters, selects, opens, and acts on app-scoped files. | `setProvider()`<br>`loadAll()`<br>`setFilter()`<br>`select()`<br>`clearSelection()` | `file-manager-ready`<br>`file-manager-select`<br>`file-manager-open`<br>`file-manager-action` | Selection/filter state normalized; storage/provider behavior mixed |
| [`header.html`](#headerhtml) | Legacy title bar with history, reload, online marker, presentation labels, and 988 link. | None | No component-specific event | Browser/platform-native behavior; no component-ready contract |
| [`integration-settings.html`](#integration-settingshtml) | Edits non-secret communication service configuration and service actions. | `configure()`<br>`getValues()`<br>`setStatus()` | `integration-settings-ready`<br>`integration-settings-save`<br>`integration-settings-close`<br>`integration-action` | Normalized non-secret values |
| [`local-ai-status.html`](#local-ai-statushtml) | Presents local-AI standby, failure, recovery, guidance, retry, and dismissal states. | `configure()`<br>`begin()`<br>`present(); hidden property` | `local-ai-status-ready`<br>`local-ai-status-dismissed`<br>`local-ai-retry` | Fully normalized LocalAIReadiness report |
| [`markdown-document.html`](#markdown-documenthtml) | Safely renders and navigates a Markdown document with focusable fragments. | `configure()`<br>`load()`<br>`render()`<br>`clear()`<br>`fail()`<br>`focus()`<br>`focusFragment()` | `markdown-document-ready`<br>`markdown-document-state`<br>`markdown-document-navigate` | State/sanitized output normalized; Marked/DOM failures mixed |
| [`markdown-editor.html`](#markdown-editorhtml) | Configurable Markdown authoring, toolbar, preview, title, and save surface. | `configure()`<br>`focus()`<br>`clear()`<br>`saveEntry()` | `markdown-editor-ready`<br>`markdown-editor-change`<br>`markdown-editor-saved` | Editor values normalized; injected save result mixed |
| [`media-embed.html`](#media-embedhtml) | Loads a validated YouTube video or playlist embed and exposes external-platform action. | `configure()`<br>`load()` | `media-embed-ready`<br>`media-load`<br>`media-error`<br>`media-open-platform` | URL/error normalized; iframe/platform behavior native |
| [`modal.html`](#modalhtml) | Generic modal with population, open/close, actions, and sequential task execution. | `populate()`<br>`open()`<br>`close()`<br>`runTasks()` | `modal-ready`<br>`modal-opened`<br>`modal-closed`<br>`modal-action` | Modal state normalized; injected task results mixed |
| [`output-panel.html`](#output-panelhtml) | Presents status, output, body, coverage, actions, pending, error, and cleared states. | `configure()`<br>`setOutput()`<br>`setBody()`<br>`setCoverage()`<br>`setActions()`<br>`setPending()`<br>`setStatus()`<br>`setError()`<br>`clear()` | `output-panel-ready`<br>`output-panel-state`<br>`output-panel-change`<br>`output-panel-action`<br>`output-panel-error`<br>`output-panel-cleared` | DOM-normalized |
| [`preferences-form.html`](#preferences-formhtml) | Builds a schema-driven preferences form with submit, reset, busy, and status behavior. | `configure()`<br>`getValues()`<br>`setValues()`<br>`setBusy()`<br>`setStatus()` | `preferences-form-ready`<br>`preferences-change`<br>`preferences-submit`<br>`preferences-reset` | Normalized form values |
| [`record-timeline.html`](#record-timelinehtml) | Displays chronological records/evidence and emits open actions. | `setItems()`<br>`populate()` | `record-timeline-ready`<br>`record-timeline-open` | DOM-normalized |
| [`relationship-board.html`](#relationship-boardhtml) | Displays normalized relationship nodes/edges in graph and list forms. | `setGraph()`<br>`populate()` | `relationship-board-ready`<br>`relationship-node-open`<br>`relationship-edge-open` | DOM-normalized |
| [`screen-capture.html`](#screen-capturehtml) | Presents image, video, or GIF display-capture workflow. | `capture()` | `screen-capture-ready`<br>`screen-capture-result` | State/result normalized; media permission/codec failures mixed |
| [`source-code-viewer.html`](#source-code-viewerhtml) | Renders line-addressable source code with load, error, focus, and state behavior. | `configure()`<br>`load()`<br>`render()`<br>`clear()`<br>`fail()`<br>`focus()`<br>`focusLine()` | `source-code-viewer-ready`<br>`source-code-viewer-state` | Normalized source/state |
| [`source-explanation.html`](#source-explanationhtml) | Presents an evidence finding, source selection, explanation, and save state. | `showFinding()`<br>`populate()`<br>`selectSource()`<br>`markSaved()` | `source-explanation-ready`<br>`source-explanation-save`<br>`source-explanation-source-selected` | DOM-normalized |
| [`speech.html`](#speechhtml) | Coordinates explicit STT activation, speech controls, transcription completion, mute state, and microphone availability. | `configure()`<br>`setAvailability()`<br>`setMuted()`<br>`requestSTTActivation()`<br>`destroy()`<br>`availability`<br>`muted`<br>`initialMuted`<br>`componentReady` | `speech-ready`<br>`speech-transcription-complete`<br>`speech-transcription-error`<br>`speech-transcription-cancelled`<br>`speech-microphone-unavailable`<br>`speech-stt-activation-request`<br>`speech-stt-activation-error`<br>`speech-tts-lifecycle-error` | Sticky runtime speech readiness, explicit STT activation, request cancellation, and TTS mute lifecycle intent normalized; provider/model authority and media behavior remain external |
| [`summary-strip.html`](#summary-striphtml) | Displays compact selectable KPI or summary items. | `configure()`<br>`setItems()`<br>`updateItem()`<br>`clear()` | `summary-strip-ready`<br>`summary-strip-change`<br>`summary-strip-select` | DOM-normalized |
| [`table.html`](#tablehtml) | Builds and updates a simple header/body table. | `buildHeader()`<br>`buildTable()` | `table-ready`<br>`header-update`<br>`body-update` | DOM-normalized |
| [`task-progress.html`](#task-progresshtml) | Runs and displays a task list with started/change/complete/error state. | `configure()`<br>`setTasks()`<br>`updateTask()`<br>`runTasks()`<br>`clear()` | `task-progress-ready`<br>`task-progress-started`<br>`task-progress-change`<br>`task-progress-complete`<br>`task-progress-error` | Task state normalized; injected task results mixed |
| [`terminal-workspace.html`](#terminal-workspacehtml) | Presents multiple terminal sessions, output, active selection, theme, and terminal actions. | `configure()`<br>`addSession()`<br>`removeSession()`<br>`activateSession()`<br>`append()`<br>`clear()`<br>`setState()`<br>`setTheme()`<br>`focus()` | `terminal-workspace-ready`<br>`terminal-submit`<br>`terminal-interrupt`<br>`terminal-clear`<br>`terminal-session-new`<br>`terminal-session-close`<br>`terminal-session-select`<br>`terminal-settings` | UI/session state normalized; native command results supplied externally |
| [`theme-editor.html`](#theme-editorhtml) | Edits, previews, saves, and resets semantic custom theme tokens. | `configure()`<br>`getTheme()`<br>`setTheme()`<br>`setBusy()`<br>`setStatus()` | `theme-editor-ready`<br>`theme-preview`<br>`theme-save`<br>`theme-reset` | Fully normalized Theme values |
| [`theme-switcher.html`](#theme-switcherhtml) | Selects and refreshes system, light, dark, or custom theme mode. | `setMode()`<br>`refresh()` | No component-specific event | Preference/native appearance behavior mixed; no component-ready contract |
| [`unified-inbox.html`](#unified-inboxhtml) | Displays provider-neutral communication threads with active/loading state. | `configure()`<br>`setThreads()`<br>`setActive()`<br>`setLoading()` | `unified-inbox-ready`<br>`inbox-refresh`<br>`thread-select` | DOM-normalized |
| [`voice-transcription.html`](#voice-transcriptionhtml) | Records segmented microphone audio only after authoritative STT admission, exposes explicit selected-STT activation, transcribes with cancellation, persists, and completes a combined transcript. | `configure()`<br>`requestSTTActivation()`<br>`startRecording()`<br>`stopRecording()`<br>`save()`<br>`completeTranscription()/complete()`<br>`clear()`<br>`reset()`<br>`destroy()` | `voice-transcription-ready`<br>`voice-transcription-state`<br>`voice-transcription-segment`<br>`voice-transcription-change`<br>`voice-transcription-complete`<br>`speech-transcription-complete`<br>`speech-transcription-cancelled`<br>`speech-stt-activation-request`<br>`speech-stt-activation-error` | Sticky runtime STT readiness, explicit activation, request cancellation, and state/text are normalized; media/provider behavior remains external |
| [`weather-widget.html`](#weather-widgethtml) | Displays normalized current and daily weather with refresh intent. | `setWeather()`<br>`clear()` | `weather-widget-ready`<br>`weather-refresh` | Display normalized; provider supplied externally |
| [`web-navigator.html`](#web-navigatorhtml) | Guards embedded/external navigation and surfaces allow/block/open intents. | `configure()`<br>`navigate()`<br>`currentUrl()` | `web-navigator-ready`<br>`web-navigate`<br>`web-navigation-blocked`<br>`web-open-external` | Navigation intent/decision normalized; browser navigation result platform-native |

## app-bar.html

### Overview

Responsive application navigation, route state, status, and trailing actions.

### Public surface

Methods/properties: `setNavigation()`, `setActiveRoute()`, `setStatus()`, `refresh()`.

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

Methods/properties: `open()`, `close()`, `toggle()`, `send()`, `clear()`, `setState()`, `focusComposer()`, `scrollToEnd()`.

Events: `assistant-ready`, `assistant-send`, `assistant-clear`.

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

Methods/properties: `calculate()`.

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
`setConversationComplete()`, `bindConversationTimebox()`, `submitMessage()`,
`sendMessage()`, `languageChanged()`, `requestAIActivation()`, and `destroy()`.

`sendMessage(text)` and `languageChanged(text)` are host-overridable async
extension callbacks. The component installs warning-only defaults when the host
does not supply them; applications may instead consume the corresponding
`chat-send-message` and `chat-language-changed` events.

`setAIAvailability()` remains an LLM compatibility input, but selected sticky
`AIRuntimeState` LLM state wins over that boolean. STT and TTS readiness always
comes from sticky runtime role state; the method never forwards compatibility
speech booleans or synthesizes ready speech roles without an admitted, loaded
provider.

When a selected LLM route is `unloaded` or in `error`, the component exposes a
keyboard-operable Start/Try again control while Send stays disabled. During
`loading`, the control becomes Cancel loading and reflects sticky progress.
The default `requestAIActivation(intent)` forwards frozen
`{role:'llm',action:'load'|'unload',reason:'user'}` to
`requestAIRuntimeIntent()`. A host may replace that callback.

Before the callback, the component dispatches the bubbles/composed/cancelable
`chat-ai-activation-request` event with frozen `{intent,state}` detail.
`preventDefault()` suppresses the callback. A callback failure dispatches the
bubbles/composed, noncancelable `chat-ai-activation-error` event with frozen
`{request,error,message}`. A recognized canceled load whose current route is
`unloaded` or `unloading` is not reported as an activation error.

`destroy()` aborts the component's AI-runtime-state subscription, destroys the
activation controller, removes its `pagehide` listener, calls the optional
speech controller's `destroy()`, sets `ready` to `false`, and returns
`undefined`. It does not initiate a provider load or unload.

Events: `chat-ready`, `chat-send-message`, `chat-send-error`,
`chat-file-uploaded`, `chat-language-changed`,
`chat-ai-activation-request`, `chat-ai-activation-error`, and
`conversation-timebox-error`.

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

Methods/properties: `setConversation()`, `setBusy()`, `setStatus()`, `clearComposer()`.

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

Methods/properties: `configure()`, `setDefinitions()`, `setVisibility()`, `getChartOptions()`, `getEffectiveVisibility()`, `open()`, `close()`.

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

Methods/properties: `open()`.

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

Methods/properties: `beforeOpen()`, `open()`.

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

Methods/properties: `configure()`, `focus()`, `select()`.

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

Methods/properties: `loadDocument()`, `selectView()`, `markSaved()`.

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

Methods/properties: `configure()`, `openPicker()`, `clear()`, `setBusy()`, `setError()`, `setProgress()`.

Events: `file-drop-ready`, `file-drop-selected`, `file-drop-progress`, `file-drop-state`, `file-drop-error`.

### Availability and normalization

**Browser and supported native WebViews.** State normalized; browser File/drop errors mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

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

Methods/properties: `configure()`, `show()`, `clear()`, `setActions()`, `setBusy()`, `setError()`, `setPreview()`.

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

Methods/properties: `setProvider()`, `loadAll()`, `setFilter()`, `select()`, `clearSelection()`.

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

Methods/properties: `configure()`, `getValues()`, `setStatus()`.

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

Methods/properties: `configure()`, `begin()`, `present(); hidden property`.

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

Safely renders and navigates a Markdown document with focusable fragments.

### Public surface

Methods/properties: `configure()`, `load()`, `render()`, `clear()`, `fail()`, `focus()`, `focusFragment()`.

Events: `markdown-document-ready`, `markdown-document-state`, `markdown-document-navigate`.

Shared dependencies: [`MD.js`](runtime-modules.md#mdjs).

### Availability and normalization

**Browser and supported native WebViews.** State/sanitized output normalized; Marked/DOM failures mixed. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

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

Methods/properties: `configure()`, `focus()`, `clear()`, `saveEntry()`.

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

Loads a validated YouTube video or playlist embed and exposes external-platform action.

### Public surface

Methods/properties: `configure()`, `load()`.

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

Methods/properties: `populate()`, `open()`, `close()`, `runTasks()`.

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

Methods/properties: `configure()`, `setOutput()`, `setBody()`, `setCoverage()`, `setActions()`, `setPending()`, `setStatus()`, `setError()`, `clear()`.

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

Methods/properties: `configure()`, `getValues()`, `setValues()`, `setBusy()`, `setStatus()`.

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

Methods/properties: `setItems()`, `populate()`.

Events: `record-timeline-ready`, `record-timeline-open`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

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

Methods/properties: `setGraph()`, `populate()`.

Events: `relationship-board-ready`, `relationship-node-open`, `relationship-edge-open`.

### Availability and normalization

**Browser and supported native WebViews.** DOM-normalized. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

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

Methods/properties: `capture()`.

Events: `screen-capture-ready`, `screen-capture-result`.

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

Methods/properties: `configure()`, `load()`, `render()`, `clear()`, `fail()`, `focus()`, `focusLine()`.

Events: `source-code-viewer-ready`, `source-code-viewer-state`.

### Availability and normalization

**Browser and supported native WebViews.** Normalized source/state. HTMLImport + DOM; injected Arcane/provider modules where listed. Native methods remain subject to the bound app's capabilities. [Deep protocol details](protocols.md).

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

Methods/properties: `showFinding()`, `populate()`, `selectSource()`, `markSaved()`.

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
`requestSTTActivation()`, `destroy()`, `availability`, `muted`, `initialMuted`,
and `componentReady`.

Events: `speech-ready`, `speech-transcription-complete`,
`speech-transcription-error`, `speech-transcription-cancelled`,
`speech-microphone-unavailable`, `speech-stt-activation-request`,
`speech-stt-activation-error`, and `speech-tts-lifecycle-error`.

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

The default `requestSTTActivation(intent)` forwards the frozen
`{role:'stt',action:'load'|'unload',reason:'user'}` record to
`requestAIRuntimeIntent()`. Before calling it, the component emits a bubbling,
composed, cancelable `speech-stt-activation-request` event with frozen
`{intent,state}` detail. `preventDefault()` suppresses the callback and intent.
Callback failure emits `speech-stt-activation-error` with frozen
`{request,error,message}` detail. Cancel loading publishes an `unload` intent;
only subsequent sticky `unloading` or `unloaded` state confirms lifecycle
progress, and callback return never proves provider work stopped.

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

User Unmute calls the shared `AI.setSpeechMuted(false)` lifecycle owner before
or with publishing the TTS load intent, so the runtime can legally load TTS.
Mute calls `AI.setSpeechMuted(true)`, stops playback, cancels active TTS work,
and unloads the selected TTS role. Lifecycle failures remain visible through
`speech-tts-lifecycle-error` and sticky role state.

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

Methods/properties: `configure()`, `setItems()`, `updateItem()`, `clear()`.

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

Methods/properties: `buildHeader()`, `buildTable()`.

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

Methods/properties: `configure()`, `setTasks()`, `updateTask()`, `runTasks()`, `clear()`.

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

Methods/properties: `configure()`, `addSession()`, `removeSession()`, `activateSession()`, `append()`, `clear()`, `setState()`, `setTheme()`, `focus()`.

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

Methods/properties: `configure()`, `getTheme()`, `setTheme()`, `setBusy()`, `setStatus()`.

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

Methods/properties: `configure()`, `setThreads()`, `setActive()`, `setLoading()`.

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

Records segmented microphone audio only after authoritative STT admission,
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
and public `startRecording()` both fail closed unless that role is exactly
`ready` and not busy. A configured `transcribe(file,context)` callback remains
request plumbing rather than readiness authority. Its context now includes the
owned `signal` additively. The default route calls
`AI.fetchSTT(file,undefined,signal)` so the callback position remains valid and
readiness loss or destruction can abort delivery.

For a selected `unloaded`, `loading`, `unloading`, or `error` role, the component
keeps recording Start disabled and presents the same keyboard-operable Start
transcription/Try again or Cancel loading control as `speech.html`. Both use the
shared `createSTTActivationController()` contract. User operation emits the
cancelable `speech-stt-activation-request` event with frozen `{intent,state}`;
`preventDefault()` suppresses the callback. The default
`requestSTTActivation(intent)` publishes the frozen
`{role:'stt',action:'load'|'unload',reason:'user'}` intent. Callback failure emits
`speech-stt-activation-error` with frozen `{request,error,message}`. Import and
state observation emit no activation request and never begin a model download.

If sticky readiness is lost during microphone acquisition, capture, or the STT
request, the component invalidates the session, aborts the owned request signal,
releases media, discards late completion, and emits
`speech-transcription-cancelled` with frozen `{reason}`. A current provider
cancellation returns the component workflow to `idle` and emits the same event
with `reason:'stt-provider-request-cancelled'`; stale teardown results remain
suppressed. A
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
`destroy()` aborts the state subscription, cancels active work, removes the
activation listener, sets component `ready` to `false`, and returns `true`;
repeated destruction is
idempotent. Destruction is terminal: Start, activation, and Complete remain
disabled and status remains unavailable. `voice-transcription-state` detail is
the frozen `{message,state,stt}` record, where `state` remains the component
workflow and `stt` is the authoritative immutable role record. Transcript
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

Methods/properties: `setWeather()`, `clear()`.

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

Methods/properties: `configure()`, `navigate()`, `currentUrl()`.

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
