# Native application diagnostics

Native diagnostics retain errors from the actual packaged application's top-level
document in its native host session. Read them through the existing app-control
connection, without foregrounding a window, desktop input, or arbitrary script
execution. This is a developer inspection surface, separate from ordinary product
status and saved conversation history.

The Windows WebView2 host installs the fixed observer at document creation, before
the ordinary Core client and application scripts. It captures `window.error` and
`unhandledrejection` events and accepts explicit reports of application-caught
errors. It leaves the browser's ordinary error behavior intact. It does not
intercept console output, inspect application state, collect resource/request
bodies, or capture errors from other applications or frame documents.

## Report a caught application error

```js
import {reportNativeError} from 'arcane-os/core/native-diagnostics';

const receipt = await reportNativeError(error, {
    details: {operation: 'source.load', sourceId}
});
// receipt: {accepted: true, sessionId, sequence}
```

`error` is the actual caught value, including non-Error rejection values.
`details` is optional application-selected diagnostic context. Supply diagnostic
information only; credentials, secrets, user documents and provider/tool payloads
do not belong in this report. The SDK adds document/session metadata outside the
reported values and does not rewrite their text. Reporting does not change the
application's own handling of the original failure.

The promise resolves after the native host retains the record. A missing document
observer or native handler rejects with
`ARCANE_NATIVE_DIAGNOSTICS_UNAVAILABLE`. A negative host acknowledgement rejects
with `ARCANE_NATIVE_DIAGNOSTIC_REJECTED`, preserving the complete host reply in
`details` and its error in `cause`. Reflection, encoding and native transport
failures reject with their actual error. A lost reply can leave the caller's
outcome unknown; the SDK does not automatically retry and duplicate the report.

Automatic capture observes its own reporting failures through the existing
console, with the original error, without recursively manufacturing an unhandled
rejection. Console output remains ordinary console output; it is not retained
diagnostic history. Applications must observe explicit reporting promises.

## Retrieve retained errors

Use the endpoint of the selected running app from its existing app-control launch
configuration. Connecting does not launch the application.

```js
import {connectAppControl} from 'arcane-os/core/app-control';

const control = await connectAppControl({endpoint});
try {
    const snapshot = await control.diagnostics();
    console.dir(snapshot, {depth: null});
} finally {
    await control.close();
}
```

`control.diagnostics({afterSequence?, documentId?}, {signal?})` invokes
`app.control.diagnostics`. Omitted filters return every retained error.
`afterSequence` selects records with a greater session sequence;
`documentId` selects one actual document. Retrieval is non-consuming: independent
inspectors can read the same complete records. Connection/cancellation behavior is
the existing app-control contract. Retrieval does not wait for renderer, Core,
model or application readiness and does not evaluate a script in the document.

The result is:

```js
{
    sessionId,
    captureStartedAt,
    captureInstalled,
    latestSequence,
    documents: [{documentId, documentUrl, time, receivedAt}],
    records: [{
        sequence, receivedAt, documentId, documentUrl, time,
        kind, error, details, valueFormat, values, location, message
    }]
}
```

`sessionId` identifies this native window/host lifetime. `captureStartedAt` is the
time its in-memory ledger was created. `captureInstalled` means document-start
script registration completed; it does not prove that any application failure
occurred or that a particular operation succeeded. `documents` records actual
ingress from observed documents. Each document has one identity, shared with app
control, independent of Core bridge generations. A cancelled navigation that
leaves the same document alive keeps that identity.

`sequence` is assigned when an error is retained, in host arrival order.
`latestSequence` describes the whole session even when filters select fewer
records. `time` comes from document capture; `receivedAt` comes from the host.
`kind` is `window.error`, `unhandledrejection`, or `application`. Window errors
include `location: {file, line, column}` when the browser exposes those fields.
Their browser `message` is retained separately from `error`, preserving a null
or undefined error value rather than replacing it with that message.
`details` and `location` are otherwise omitted.

Records survive document navigation and Core transport failure within the host
session. Closing the inspector leaves them retained. Closing the native host ends
the session; this API does not persist, migrate, prune, or recover records across
host restarts. An empty snapshot means no matching records were retained in this
session, not that earlier failures never occurred. Errors before capture existed,
handled failures never explicitly reported, errors the browser does not expose,
and vanished documents whose pending reports never reached the host remain
unavailable. Earlier never-retained failures cannot be reconstructed through this API.

## Complete error property representation

Each record uses `valueFormat: 'arcane.diagnostic-value/1'`. `error` and optional
`details` are roots into the single `values` graph. JSON-native primitives remain
their original values. Undefined, bigint, non-finite numbers and negative zero
have explicit typed representations. `{ref: id}` identifies a graph node.
Repeated references and cycles retain the same identity within the record.

Object nodes retain every own property descriptor, including non-enumerable and
symbol-keyed fields. This includes full Error messages and stacks, `cause`,
AggregateError members and custom diagnostic details. Standard error fields
inherited from a prototype appear in `inherited`. Data descriptors contain
`value`; accessor descriptors contain references for `get` and `set` without
invoking either function. An accessor supplied as the `details` option is likewise
represented rather than called. No `toJSON` method on reported content is called.
Maps and sets retain their entries, dates their numeric time, and regular
expressions their source and flags, alongside their own properties.

This is a diagnostic property representation, not an executable object snapshot:
functions retain their property identity, not executable closures; platform-private
internal state and private class fields are not observable properties. The host
stores and returns the graph without reconstructing or executing those objects.
An object that rejects reflection causes an observable reporting failure rather
than a silently incomplete success. Inspect the complete graph in developer
diagnostics; do not flatten it into ordinary chat or user-facing status.

## Host ownership and availability

`installNativeDiagnostics(globalThis)` installs one observer per document and
returns its owner `{documentId, ready, report}`. `ready` resolves after the document
announcement is accepted, and `report` has the same report contract. Importing
the ESM module alone installs no observer. The packaged native host owns
installation and lifetime; ordinary applications use `reportNativeError`.

`createNativeDiagnosticsSource()` from
`arcane-os/core/native-diagnostics-source` projects that same canonical helper
into the top-level document-start script. It adds no second observer or serializer.
Windows binds the script to the dedicated `arcaneDiagnostics.Send` host object.
This route is independent of `arcaneBridge` and the Core subprocess. Host close
stops new ingress and removes the object/script during existing shutdown.

The implementation here supplies Windows WebView2 capture and app-control
retrieval. macOS, Linux and Android require their native host ingress/session and
app-control adapters; this source change does not claim those adapters exist.
The helper recognizes the same fixed-name WebKit reply handler when a host
provides it; that transport seam is not platform availability. A browser preview
cannot establish actual native acceptance.

Native delivery requires the corresponding rebuilt SDK Windows host asset and
consumer adoption through the published SDK package. Source inspection, authored
fixtures and configured capture are distinct from executed built-application
verification. Existing host stderr/log diagnostics, live Core events, readiness
replay and `Arcane.diagnostics.recentErrors/get` retain their existing semantics;
this API does not turn them into a historical error service.
