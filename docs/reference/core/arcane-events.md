# Arcane events

`Arcane.events` delivers renderer-visible host and Core events. A named subscription such as `Arcane.events.on('operation.progress', listener)` receives that event's payload object directly. A wildcard subscription made with `Arcane.events.on('*', listener)` receives an envelope shaped as `{ event, data }`; `*` is a subscription selector, not an emitted event name.

`Arcane.events.on()` and `Arcane.events.once()` observe only future deliveries. `Arcane.events.once()` removes its subscription before invoking the listener and therefore observes only the next matching delivery. Most events are live notifications and are not replayed, so subscribe before starting the work that can emit them.

`transport.ready` and `core.ready` are the two durable completion events. `Arcane.events.when(name, listener)` accepts only those names. It waits once when completion has not happened, or asynchronously replays the first deeply frozen JSON snapshot when completion has already happened. `Arcane.events.completed(name)` reports whether a designated durable event has completed; it is not a payload accessor.

Every subscription method returns an unsubscribe function. Call it when the owning view or task is torn down. An exception thrown by one listener is caught and reported to the console, and does not stop the remaining named or wildcard listeners.

## Event inventory

| Event | Delivery | Hosts | Trigger | Payload |
| --- | --- | --- | --- | --- |
| `transport.ready` | Durable completion. The first payload is frozen; a late `when()` subscriber receives an asynchronous replay. | Every initialized Arcane transport: Microsoft NT WebView2, Linux WebKitGTK, Android WebView, and development HTTP. | The renderer initializes the bridge and selects its available transport. | `protocol` is the selected wire-protocol identifier; `transport` is `webview2`, `webkitgtk`, `android-webview`, or `development-http`. |
| `core.ready` | Durable completion. The first payload is frozen; a late `when()` subscriber receives an asynchronous replay. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | The Core has installed its input handlers and is ready to accept requests. | `pid` is the Core process ID; `version` is its Arcane version; `app` is the active application mode; `platform` is the public operating-system snapshot; `elevated` reports elevated execution; `simulation` reports simulation mode. |
| `core.error` | Live, future-only notification. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | The Core cannot decode or handle an inbound control frame. | A normalized error object: `code` and `message` identify the failure; fields such as `resolution`, `technicalMessage`, `status`, `retryable`, and `diagnosticId` provide recovery and diagnostic context when available. |
| `operation.started` | Live, future-only operation notification. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | A tracked Core operation is created. | `requestId` correlates the initiating API request; `operationId` identifies the tracked operation; `operationType` names its kind; `time` is the operation start timestamp. |
| `operation.log` | Live, future-only operation notification; one operation can emit many entries. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | A tracked operation records a log entry. | `requestId`, `operationId`, and `operationType` correlate the operation; `time` timestamps the entry; `level` classifies it; `message` is the readable entry; `details` carries optional structured context. |
| `operation.progress` | Live, future-only operation notification; one operation can emit many updates. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | A tracked operation advances or reports its current step. | `requestId`, `operationId`, and `operationType` correlate the operation; `progress` is its nondecreasing percentage; `message` describes the current step; `details` is optional structured progress context. |
| `operation.completed` | Live, future-only terminal operation notification. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | A tracked operation finishes successfully, including success with warnings. | `requestId`, `operationId`, and `operationType` correlate the operation; `result` is its public result; `credentials` carries any operation-issued credentials and must be treated as sensitive; `details` is final progress context; `warningCount` counts warnings; `message` summarizes completion; `time` is the completion timestamp. |
| `operation.failed` | Live, future-only terminal operation notification. | Core-backed Microsoft NT, Linux, and development HTTP hosts. | A tracked operation reaches its failure path. | `requestId`, `operationId`, and `operationType` correlate the operation; `error` is the normalized failure object; `details` is final progress context; `time` is the failure timestamp. |
| `ollama.chunk` | Live, future-only correlated stream notification. | Core-backed hosts and admitted Android application hosts for proxied chat streaming. | An Ollama streaming operation receives its next response chunk. | `streamId` identifies the stream selected by the caller or Arcane; `operation` names the streamed Ollama operation; `chunk` is the provider response object for that delivery. |
| `localai.isolated.phase` | Live, future-only correlated operation notification. | Core-backed hosts for an application admitted to isolated inference. | An isolated-model question enters a lifecycle phase or emits a chat heartbeat. | `operationId` correlates the request; `phase` is `unload_before`, `verify_before`, `chat`, `unload_after`, or `verify_after`; chat heartbeats additionally set `heartbeat` to `true`, report `elapsedMs`, and timestamp themselves with `at`. |
| `terminal.output` | Live, future-only correlated session stream. | Core-backed Arcane Terminal and Android Arcane Terminal hosts. | A terminal process produces standard output or standard error. | `sessionId` identifies the terminal session; `stream` is `stdout` or `stderr`; `data` is a UTF-8 text chunk and is not guaranteed to be a complete line. |
| `terminal.exit` | Live, future-only terminal session notification. | Core-backed Arcane Terminal and Android Arcane Terminal hosts. | A terminal process exits and the host removes its session. | `sessionId` identifies the terminal session; `exitCode` is the process exit code when available; `signal` is the terminating signal name or `null`. |
| `terminal.error` | Live, future-only terminal session notification. | Android Arcane Terminal hosts. | Android stops a session at its output limit or cannot read one of its output streams. | `sessionId` identifies the terminal session; `message` explains the output-limit or stream-reading failure. |
| `appearance.changed` | Live, future-only host notification. | Microsoft NT WebView2 hosts. | The host observes an operating-system appearance change. | `scheme` is the configured host scheme; `effectiveScheme` is the resolved `dark` or `light` scheme; `source` is `windows`. |

### Subscribe and clean up

Keep the returned function with the UI or operation that owns the subscription:

```js
const stopProgress = Arcane.events.on('operation.progress', function handleOperationProgress(data) {
  console.info(`${data.operationId}: ${data.progress}%`, data.message);
});

window.addEventListener('pagehide', stopProgress, { once: true });
```

A wildcard listener is useful for routing or diagnostics, but its callback shape differs from a named listener. Avoid logging payloads indiscriminately because results can contain credentials or other sensitive values.

```js
const observedEventNames = [];
const stopObserving = Arcane.events.on('*', function handleAnyArcaneEvent({ event, data }) {
  observedEventNames.push(event);
  routeArcaneEvent(event, data);
});

window.addEventListener('pagehide', stopObserving, { once: true });
```

### Wait for durable readiness

Use `when()` when a component can mount before or after readiness. The callback is still asynchronous when the durable completion already exists.

```js
const stopReady = Arcane.events.when('core.ready', function handleCoreReady({ version, platform }) {
  showRuntimeReady({ version, platform });
});

if (Arcane.events.completed('core.ready')) {
  showRuntimeConnecting(false);
}

window.addEventListener('pagehide', stopReady, { once: true });
```

Do not use `when()` for operation, streaming, terminal, appearance, or error events. Those events have no retained completion value.

### Follow a terminal lifecycle

Subscribe before `Arcane.terminal.start()`. Output, exit, or error delivery can race the start response, so buffer by `sessionId` until the returned session identifies the stream to keep. Append `data` chunks as delivered rather than assuming one event equals one line.

```js
const terminalOutput = document.querySelector('[data-terminal-output]');
const buffered = [];
const maxBufferedEvents = 128;
let sessionId = null;

function handleTerminalEvent(event, data) {
  if (sessionId === null) {
    buffered.push({ event, data });
    // Bound pre-identification buffering; surface truncation in a real UI.
    if (buffered.length > maxBufferedEvents) buffered.shift();
    return;
  }
  if (data.sessionId !== sessionId) return;
  if (event === 'terminal.output') {
    terminalOutput?.append(document.createTextNode(data.data));
  } else if (event === 'terminal.exit') {
    terminalOutput?.append(document.createTextNode(`\n[exit ${data.exitCode}]`));
  } else {
    terminalOutput?.append(document.createTextNode(`\n[terminal error: ${data.message}]`));
  }
}

const stopTerminalEvents = [
  Arcane.events.on('terminal.output', function handleTerminalOutput(data) {
    handleTerminalEvent('terminal.output', data);
  }),
  Arcane.events.on('terminal.exit', function handleTerminalExit(data) {
    handleTerminalEvent('terminal.exit', data);
  }),
  Arcane.events.on('terminal.error', function handleTerminalError(data) {
    handleTerminalEvent('terminal.error', data);
  }),
];

try {
  const session = await Arcane.terminal.start({ shell: 'auto' });
  sessionId = session.id;
  for (const item of buffered.splice(0)) handleTerminalEvent(item.event, item.data);
  const lineEnding = ['powershell', 'cmd'].includes(session.shell) ? '\r\n' : '\n';
  await Arcane.terminal.write(sessionId, `echo ready${lineEnding}`);
} finally {
  if (sessionId !== null) {
    await Arcane.terminal.close(sessionId).catch(function ignoreTerminalCloseFailure() {});
  }
  for (const stop of stopTerminalEvents) stop();
}
```

Use the host-appropriate line ending when submitting interactive commands: `\r\n` for PowerShell or Command Prompt and `\n` for POSIX shells.

### Event lifecycle guidance

- Subscribe before starting work, then correlate with `requestId`, `operationId`, `streamId`, or `sessionId`. Unrelated work can emit the same named event concurrently.
- Treat `operation.completed` and `operation.failed` as the terminal event for an `operationId`; progress and log events are intermediate and are not retained.
- Treat `operation.completed.credentials` as sensitive. Do not write it to logs or durable application storage.
- Treat streaming and terminal payloads as ordered deliveries for their correlation ID, not as complete messages or lines. Apply resource bounds when buffering.
- Unsubscribe on teardown even after a one-shot workflow. `once()` and a pending `when()` clean themselves up when invoked, but their returned unsubscribe function cancels an abandoned wait.
- Host scope describes where an event can be emitted; it does not grant the capability needed to start the underlying operation.
