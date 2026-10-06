# Native application control

`connectAppControl` from `arcane-os/core/app-control` connects to one explicitly
selected running application window. The Windows WebView2 host provides document
inspection, a PNG of its rendered viewport, and targeted DOM actions through its
own local named pipe. The application keeps its existing Core child, profile,
origin and window lifecycle. These operations do not activate the desktop window
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
| `status(options?)` | Returns app identity, platform/host, current URL, document generation, readiness, window title/state/client dimensions and available operations. Readiness describes the document, not models or application services. |
| `inspect(parameters={}, options?)` | Optional `shadowPath` selects an open shadow root. Optional CSS `selector` selects zero or more elements within the selected root; omission selects the whole root. Optional `documentGeneration` selects the expected document. Returns complete HTML/text, live control state and DOM-derived role/name hints. |
| `capture(parameters={}, options?)` | Returns `{mimeType:'image/png', data, documentGeneration, url}`. `data` contains the complete base64 PNG. Optional `documentGeneration` selects the expected document. |
| `act(parameters, options?)` | Requires `documentGeneration`, one unambiguous CSS `selector` within the root selected by optional `shadowPath`, and the action fields below. |
| `close()` | Closes this caller's connection and cancels its pending requests. It never closes the app or Core. Returns the connection's completion promise. |
| `closed` | Connection lifetime promise; actual transport failures remain observable. |
| `endpoint` | The caller-selected local endpoint. |

Each operation's separate `options` uses the existing Core client request
contract, including `signal` and `timeoutMs`. Connection cancellation closes only
that connection. Cancellation before UI dispatch prevents execution. Once a
script or capture has been dispatched, cancellation cannot reverse its effects;
the host still observes its completion. A disconnected caller's completed result
is retained in the host diagnostics instead of being represented as delivered.

## Document operations

Inspection defaults to the top-level light DOM. Its result contains `scope`, `title`,
`readyState`, `doctype`, `roots`, `controls`, `frames`, `shadowHosts`,
`activeElement`, `scrollingElement`, `selection`, `documentGeneration`, and
`url`. Each root retains its complete `html` and `text`; controls retain their
attributes and current form, selection, disabled, scrolling and related state.
Generated CSS selectors are useful for the inspected document; a later DOM edit
can change their meaning. Application-authored stable selectors are preferable
when available. Component replacement or mutation can make a selector stale
without changing the native document generation.

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
and native URL/generation remain document-level information. Role/name label
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
contents are outside the selected scope. Frame elements and open-shadow hosts
are described; closed shadow roots cannot be discovered. Capture is the current rendered
viewport, not an offscreen full-document rendering. Covered and minimized-window
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
script so a queued action cannot run against a successor page. During navigation,
operations report that the document is not ready. A change during completion
reports the actual result with that failure; actions are never retried. These
markers are transient document lifecycle state and are not written to saved data.

## CLI

```powershell
arcane app-control status --endpoint '\\.\pipe\arcane-pm-control'
arcane app-control inspect --endpoint '\\.\pipe\arcane-pm-control' --selector '#pm-content'
arcane app-control inspect --endpoint '\\.\pipe\arcane-pm-control' --request '.arcane\inspection.json'
arcane app-control capture --endpoint '\\.\pipe\arcane-pm-control' --output '.arcane\view.png'
arcane app-control act --endpoint '\\.\pipe\arcane-pm-control' --request '.arcane\action.json'
```

The action file is the complete action parameter object, including the actual
`documentGeneration` returned by the preceding status or inspection. Inspection
also accepts `--request` for a complete parameter object, such as
`{"shadowPath":["#appearance-panel","theme-switcher"]}` or the same object with
`selector` and `documentGeneration`. Inspection's `--request` and `--selector`
options are mutually exclusive. The CLI reads the selected file completely.
Paths are relative to the current directory. Capture
writes the PNG to the explicitly selected file and prints its metadata. The other
operations print complete JSON. `app-control --help` describes this command's
options; other Arcane commands retain their existing global output-format option.

Pipe startup, framing, document, image and output-file errors remain observable.
Host shutdown stops new control work and observes accepted operations alongside
the existing Core drain. It does not wait for desktop input or leave an
independent controller process running.
