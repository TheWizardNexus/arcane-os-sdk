# Native application control

`connectAppControl` from `arcane-os/core/app-control` connects to one explicitly
selected running application window. The Windows WebView2 host provides document
inspection, a PNG of its rendered viewport, targeted DOM actions, fixed keys and
Normal-window client resizing through its own local named pipe. The application
keeps its existing Core child, profile, origin and window lifecycle. These operations do not activate the desktop window
or send global keyboard or pointer input.

The Node client uses the SDK's existing `arcane/1` framing and local pipe/socket
transport on Windows, Linux and macOS. The native window adapter described here
is Windows WebView2; macOS, Linux and Android hosts do not yet expose these
operations. An installed generic browser tool does not automatically discover
this endpoint. A caller must use this public client or CLI explicitly.

## Select the running instance

Add an explicit endpoint to the application's existing native launch context:

```json
{
  "native": {
    "launchContext": {
      "appControl": {
        "endpoint": "\\\\.\\pipe\\arcane-pm-control"
      }
    }
  }
}
```

The same `appControl` record can be supplied in the launch JSON already selected
by `--arcane-launch-config`. That record is merged by the existing launcher; it
does not select a different profile or Core topology. Omission starts the usual
application without a control listener. Each simultaneous application instance
needs its own endpoint. An occupied endpoint reports the actual startup failure;
the host does not silently attach to another window or choose another name.

Use a matching published Windows host asset when assembling the application.
The host producer generates `arcane-app-control.js` from the canonical standalone
DOM operation function and includes it beside `Arcane.exe`. Direct C# composition
uses `ArcaneHostOptions.ApplicationId`, `AppControlEndpoint`, and
`AppControlSource` with the same generated source. Ordinary composition leaves
the two control options unset.

## Public client

```js
import {connectAppControl} from 'arcane-os/core/app-control';

const app = await connectAppControl({
    endpoint: String.raw`\\.\pipe\arcane-pm-control`
});
try {
    const page = await app.inspect();
    await app.act({
        documentGeneration: page.documentGeneration,
        selector: 'a[data-route="connections"]',
        action: 'click'
    });
    const contents = await app.inspect({selector: '#pm-content'});
    console.log(contents);
} finally {
    await app.close();
}
```

This example selects an existing navigation link. Its returned action result
describes the immediate DOM operation. Inspect the resulting page to establish
the application outcome; a click alone does not establish an asynchronous save,
connection or other business result.

| Member | Contract |
| --- | --- |
| `connectAppControl({endpoint, signal?, onError?})` | Connect once to the explicit running host. It never launches an app, creates Core, changes a profile or reconnects automatically. |
| `status(options?)` | Returns app identity, platform/host, current URL, document generation, readiness, window title/state/client dimensions and available operations. Window state is `Normal`, `Maximized`, `Minimized`, or `Fullscreen`. Readiness describes the document, not models or application services. |
| `inspect(parameters={}, options?)` | Optional `shadowPath` selects an open shadow root. Optional CSS `selector` selects zero or more elements within the selected root; omission selects the whole root. Optional `documentGeneration` selects the expected document. Returns complete HTML/text, live control state and DOM-derived role/name hints. |
| `capture(parameters={}, options?)` | Returns `{mimeType:'image/png', data, documentGeneration, url}`. `data` contains the complete base64 PNG. Optional `documentGeneration` selects the expected document. |
| `act(parameters, options?)` | Requires `documentGeneration`, one unambiguous CSS `selector` within the root selected by optional `shadowPath`, and the action fields below. |
| `key(parameters, options?)` | Requires `documentGeneration` and `key:'Tab'`, `'Enter'`, `'Space'`, or `'Escape'`. Optional `shiftKey:true` is supported only for Tab. Sends one ordered press/release pair to the selected WebView's current focus. |
| `resize(parameters, options?)` | Requires positive integral native client `width` and `height` supported by WinForms. Optional `documentGeneration` selects the expected document. Resizes only a Normal window and returns immediate previous/actual client dimensions plus the subsequently observed CSS viewport. |
| `close()` | Closes this caller's connection and cancels its pending requests. It never closes the app or Core. Returns the connection's completion promise. |
| `closed` | Connection lifetime promise; actual transport failures remain observable. |
| `endpoint` | The caller-selected local endpoint. |

Each operation's separate `options` uses the existing Core client request
contract, including `signal` and `timeoutMs`. Connection cancellation closes only
that connection. Cancellation before UI dispatch prevents execution; keys also
check cancellation after waiting for the keyboard owner and immediately before
the press. Once a script, capture, key press or resize has been dispatched,
cancellation cannot reverse its effects. The host observes its actual completion,
including the owned key release. The caller receives its ordinary abort result;
the complete later response is retained in host diagnostics for a cancelled
request or closed connection instead of being represented as delivered.

## Document operations

Inspection defaults to the top-level light DOM. Its result contains `scope`, `title`,
`readyState`, `doctype`, `roots`, `controls`, `frames`, `shadowHosts`,
`activeElement`, `scrollingElement`, `selection`, `viewport`, `documentHasFocus`,
`focusPath`, `documentGeneration`, and `url`. Each root retains its complete
`html` and `text`; controls retain their
attributes and current form, selection, disabled, scrolling and related state.
Generated CSS selectors are useful for the inspected document; a later DOM edit
can change their meaning. Application-authored stable selectors are preferable
when available. Component replacement or mutation can make a selector stale
without changing the native document generation.

`viewport` contains the top-level document's `innerWidth` and `innerHeight` as
CSS-pixel `width`/`height`, plus its current `devicePixelRatio`.
`documentHasFocus` records `document.hasFocus()`. `focusPath` describes the
top-level active element followed by each active element in accessible open
shadow roots along that focus branch. These records retain complete attributes,
DOM-derived names and control state, with `selector:null`; they are observations,
not selector targets. Reading a focused body or host's name can traverse its
complete text subtree. The path stops at a frame element or closed shadow host;
it does not enter frame documents or closed roots.

### Open shadow roots

`inspect` and `act` accept `shadowPath`, an ordered array of CSS host selectors.
The first selector resolves inside the top-level document; each later selector
resolves inside the preceding host's open shadow root. Every host selector must
match exactly one element. The operation's `selector` then resolves only inside
the final root. An omitted or empty `shadowPath` retains the ordinary light-DOM
scope. Selecting a root never recursively enters its nested shadow roots.

```js
const shadowPath = ['#appearance-panel', 'theme-switcher'];
const panel = await app.inspect({shadowPath});
await app.act({
    documentGeneration: panel.documentGeneration,
    shadowPath,
    selector: 'button[data-theme="dark"]',
    action: 'click'
});
```

Shadow inspection returns `scope:'open-shadow-root'` and the selected
`shadowPath`. Its element selectors are local to that root. With no `selector`,
`roots` contains one complete root record with `selector:null`, its full
`innerHTML` as `html`, its full `textContent` as `text`, and `state:null`; a
ShadowRoot itself is not an element or an action target. With a selector, roots
retain their element HTML and state. Controls, frames and open-shadow hosts are
described within this selected tree. Each `shadowHosts` descriptor retains its
local `selector` and `mode`, and adds the full `shadowPath` needed to inspect
that host's shadow root, including nested hosts. Pass that path to the next
inspection; pair selectors from its result with that same path for actions.

`activeElement` comes from the selected root. `scrollingElement` is `null` for a
shadow-root scope because the root has no document scrolling element; scroll
actions still target elements. `selection.text`, `title`, `readyState`, `doctype`
and native URL/generation remain document-level information. The added
`viewport`, `documentHasFocus` and `focusPath` also always describe the top-level
document: the focus path can enter open roots outside the selected inspection
root. The selected root's `activeElement` remains separate. Role/name label
references resolve within the element's own tree. Inspection follows the DOM
tree, not the composed rendering tree: slot-assigned light-DOM nodes remain in
their own containing DOM tree and are not duplicated inside the selected shadow
root.

A missing or ambiguous host produces document error `ARCANE_APP_CONTROL_TARGET_COUNT`
with the complete path, zero-based `index`, `selector` and match count. Invalid
path or CSS input reports its actual error before any action. A host without an
accessible open root produces document error `ARCANE_APP_CONTROL_UNSUPPORTED`
with the path and failing step. The Windows client rejects these document failures
with top-level `error.code === 'ARCANE_APP_CONTROL_FAILED'`; the original document
error, including its `code` and `details`, is available at
`error.data.find(entry => entry.key === 'documentError').value`.
Closed roots cannot be discovered, entered, or distinguished from
absent roots through this API. No closed-root interception is installed.
Shadow actions add the selected `shadowPath` to their result and retain the
actual target state after dispatch, including disconnection by the action.

Role/name hints are derived from DOM attributes and labels, not a native
accessibility-tree computation. Frame documents and unselected shadow-root
contents are outside the selected HTML/control scope; the document-level focus
path separately describes its active open-shadow branch. Frame elements and
open-shadow hosts are described; closed shadow roots cannot be discovered.
Capture is the current rendered viewport, not an offscreen full-document rendering. Covered and minimized-window
capture behavior requires execution evidence in the selected environment.

| Action | Parameters and immediate behavior |
| --- | --- |
| `click` | Calls the uniquely selected element's DOM `click()` method. |
| `fill` | Exact string `value` replaces an input, textarea or contenteditable value; input/change events are dispatched. Read-only, disabled and non-text input controls report their actual unsupported state. |
| `select` | Exact `value` string or `values` string array selects native `<select>` options and dispatches input/change. Multiple values require a multiple-select control. |
| `scroll` | Absolute numeric `left`, `top`, or both in CSS pixels; the omitted axis retains its position. Returns the resulting scroll state, including browser clamping. |

DOM actions use programmatic, untrusted events. They do not supply physical user
activation for browser features that require it. Results describe the actual
immediate state, including browser value sanitization; input is not silently
rewritten by the SDK.

The host publishes a new generation when an actual replacement document becomes
ready. A creation-time document marker is also checked inside the executing
script so a queued DOM action cannot run against a successor page. During navigation,
operations report that the document is not ready. A change during completion
reports the actual result with that failure; actions are never retried. These
markers are transient document lifecycle state and are not written to saved data.

## Fixed keys

```js
const page = await app.inspect();
const moved = await app.key({documentGeneration: page.documentGeneration, key: 'Tab'});
console.log(moved.previous.focusPath, moved.actual.focusPath);
await app.key({documentGeneration: moved.documentGeneration, key: 'Tab', shiftKey: true});
await app.key({documentGeneration: moved.documentGeneration, key: 'Enter'});
const current = await app.inspect();
await app.key({documentGeneration: current.documentGeneration, key: 'Escape'});
```

Keys use the selected WebView's current focus. No selector, shadow path, frame
selection, focus assignment or desktop activation is performed. Tab and
Shift+Tab use a fixed Tab `rawKeyDown`/`keyUp` pair, with the Shift modifier on
both events for Shift+Tab. Enter and Space use `keyDown` with their corresponding
text, followed by `keyUp`, preserving browser default actions and application
`preventDefault` handling. Escape uses `key:'Escape'`, `code:'Escape'` and native
virtual key 27 in a `rawKeyDown`/`keyUp` pair, without text fields. It follows the
selected WebView's normal Escape handling; it does not promise that a particular
dialog closes. Shift+Tab does not send a separate Shift key pair.
The API exposes these fixed keys, not an arbitrary protocol method or script.

The result contains `key`, `shiftKey`, `previous` and `actual` document views,
`press`, `release`, `documentGeneration` and `url`. Each view contains the same
`viewport`, `documentHasFocus` and `focusPath` described above. Each key phase
records its fixed `parameters`, `attempted`, `completed`, and the complete
protocol `response` when returned. Dispatch completion describes the native
command, not application handler completion or a successful business action.
Inspect the resulting page to establish the application outcome.

Accepted key pairs share one keyboard owner so another key request cannot
interleave between press and release. Other independent control operations keep
their existing scheduling. The host awaits each native phase in order. Once
the press is attempted, the host observes that task and attempts the matching
release on the same WebView even after cancellation, navigation or press
failure. Release can itself activate Space. A failed or ambiguous press is
never replayed.

Generation checks occur before dispatch and after completion; the native input
command has no atomic document binding. Navigation or focus changes can occur
between the checks and phases, and Tab intentionally changes focus before its
release. A detected document change is reported with the actual attempted and
completed phases. Dispatch, release or later observation failures retain the
complete partial result at `error.data.find(entry => entry.key === 'result').value`
under `ARCANE_APP_CONTROL_FAILED`. Original exceptions remain in `cause`; if
both native phases fail, both errors are also retained in the aggregate and
their respective phase records. An unavailable `actual` view is omitted rather
than inferred.

## Resize and restore a Normal window

```js
const resized = await app.resize({width: 1200, height: 800});
try {
    console.log(resized.previous, resized.actual, resized.viewport);
    console.log(await app.inspect({selector: '#pm-content'}));
} finally {
    await app.resize({width: resized.previous.width, height: resized.previous.height});
}
```

`width` and `height` select the native WinForms client dimensions, in the same
units returned by `status().window`. They are not CSS viewport dimensions.
The host changes only `ClientSize`; it does not assign window state, position,
restore bounds, activation or WebView zoom, and it preserves the profile and
origin. Read `viewport` for the resulting CSS dimensions instead of assuming a
particular DPI or zoom conversion.

Immediately before the UI-thread mutation, the host checks the actual
window state and records `previous:{title,state,width,height}`. It records
`actual` in the same shape immediately after the native setter, then observes
the CSS `viewport` asynchronously. The result also contains `requested`,
`resizeAttempted`, `resizeCompleted`, `documentGeneration` and `url`.
Platform constraints may make actual dimensions differ from requested ones.
Other input or concurrent resize requests can change the window between the
native snapshot and the document observation; these records are not an atomic
native/CSS snapshot. Completion does not establish that asynchronous application
resize handlers have settled.

Maximized, minimized or fullscreen windows return `ARCANE_APP_CONTROL_FAILED` before any
size mutation, with `reason:'unsupported-window-state'`,
`supportedWindowState:'Normal'` and the complete current `window` in the error's
`data` entries. The host never automatically restores, maximizes or minimizes a
window to satisfy this request. Invalid dimensions return `INVALID_ARGUMENT`.
The same state rule applies to explicit restoration.

Native fullscreen reports `Fullscreen`, including while its underlying WinForms
state is Normal. A minimized fullscreen window reports `Minimized`. The
requesting document can select its state through
[`Arcane.window.setState({state})`](core-client.md#current-window-state); app-control
does not add a separate state-setting operation. That facade uses lowercase
state values, while app-control preserves its existing capitalized values.

Restore using the actual `previous.width` and `previous.height` from the
operation being reversed, never a historical status snapshot or CSS viewport
dimensions. Restoration is an explicit second request; cancellation does not
resize the window back. If a dispatched resize or its later observation fails,
the complete partial `result` remains in the error's `data`, including the
recorded previous dimensions, actual dimensions and attempted/completed flags.
Use that actual record when deciding whether and how to restore.

## CLI

```powershell
arcane app-control status --endpoint '\\.\pipe\arcane-pm-control'
arcane app-control inspect --endpoint '\\.\pipe\arcane-pm-control' --selector '#pm-content'
arcane app-control inspect --endpoint '\\.\pipe\arcane-pm-control' --request '.arcane\inspection.json'
arcane app-control capture --endpoint '\\.\pipe\arcane-pm-control' --output '.arcane\view.png'
arcane app-control act --endpoint '\\.\pipe\arcane-pm-control' --request '.arcane\action.json'
arcane app-control key --endpoint '\\.\pipe\arcane-pm-control' --request '.arcane\key.json'
arcane app-control resize --endpoint '\\.\pipe\arcane-pm-control' --request '.arcane\resize.json'
```

The action or key file is the complete parameter object, including the actual
`documentGeneration` returned by the preceding status or inspection. Inspection
also accepts `--request` for a complete parameter object, such as
`{"shadowPath":["#appearance-panel","theme-switcher"]}` or the same object with
`selector` and `documentGeneration`. Inspection's `--request` and `--selector`
options are mutually exclusive. A key file can contain
`{"documentGeneration":3,"key":"Tab","shiftKey":true}`, using the observed
generation. A resize file contains native dimensions such as
`{"width":1200,"height":800}`. Each requires `--request`; the CLI reads the
selected file completely and forwards the parsed parameter object unchanged.
Paths are relative to the current directory. Capture
writes the PNG to the explicitly selected file and prints its metadata. The other
operations print complete JSON. `app-control --help` describes this command's
options; other Arcane commands retain their existing global output-format option.

Pipe startup, framing, document, image and output-file errors remain observable.
Host shutdown stops new control work and observes accepted operations alongside
the existing Core drain. It does not wait for desktop input or leave an
independent controller process running.
