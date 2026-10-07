# Native document acquisition

`acquireCoreDocument` from `arcane-os/document-acquisition` retrieves one
HTTP(S) document through the application's selected native Core service.
`createDocumentAcquisitionService` from `arcane-os/core/document-acquisition`
owns the reusable native acquisition. It performs a GET, follows redirects
manually, and retains the complete response bodies without parsing or rewriting
the document. Applications own source selection, document interpretation,
enumeration, storage, and any destination predicate.

## Application composition

Select an application-owned native factory through the existing
[`native.services` composition](core-native-packaging.md#explicit-application-services).
Include its source through the application's `package.nativeResources` as
described there. The factory runs in the native Core process; its options are
JSON data, while its predicate is an ordinary locally imported function.
Functions are never serialized through Core RPC.

```js
// native/documents.mjs, owned by the application
import {createDocumentAcquisitionService} from 'arcane-os/core/document-acquisition';

export default function createDocuments() {
    return createDocumentAcquisitionService();
}
```

```json
{
    "native": {
        "services": [{"module": "native/documents.mjs"}]
    }
}
```

The ordinary service works without a predicate. When an application selects a
destination restriction, its native factory supplies
`createDocumentAcquisitionService({destinationPredicate})`. The SDK awaits
`destinationPredicate(destinationUrl, {requestedUrl, previousUrl, signal})`
before **every** HTTP(S) request, including the first URL and each redirect.
Return `true` to request that destination. Any other return value declines it
with `DOCUMENT_DESTINATION_DECLINED`. A thrown or rejected error remains the
acquisition error's original `cause`. The predicate receives the resolved URL
string, the caller's original URL string, the prior response URL or `null`, and
the operation's signal. It stays local to the application's native process.

An asynchronous predicate must finish or honor its signal so native shutdown
can join it. There is no automatic retry or redirect-count limit. The caller
can cancel its operation, including a repeating redirect chain. Redirects
with statuses 301, 302, 303, 307, and 308 follow their `Location`, resolved
against the response URL. A response without a redirect destination is returned
as received. The service performs GET on each destination; it does not submit
forms or add application credentials.

## Browser API

```js
import {acquireCoreDocument} from 'arcane-os/document-acquisition';

const cancellation = new AbortController();
const document = await acquireCoreDocument({
    url: selectedDocumentUrl,
    signal: cancellation.signal,
    onProgress(progress) {
        status.textContent = progress.phase;
    }
});

// The original entity content is available even for an HTTP error response.
const completeContent = document.body; // Blob
const receivedSuccessfully = document.ok;
```

The options are `{url, client?, signal?, onProgress?}`. `client` defaults to the
installed Core client. The helper invokes `documents.acquire` with `{url}`;
callbacks and the signal stay local. It uses existing request cancellation and
`documents.progress` subscriptions, with no extra event bus or transport.
There is no implicit request timeout. The caller owns any selected deadline
through its signal.

The native service must be selected by the application. An absent Core client
reports `DOCUMENT_ACQUISITION_CORE_UNAVAILABLE`; an installed Core without the
service returns its existing unavailable-method error. Browser-only preview
does not acquire native capability and does not silently switch to browser
Fetch. Portable Windows, Linux, and macOS applications use their existing Core
transport; Android requires its host to provide this same native service.

The result contains:

| Field | Meaning |
| --- | --- |
| `requestedUrl` | Caller-supplied URL string, retained unchanged. |
| `finalUrl` / `url` | Final response URL reported by Fetch. |
| `status`, `statusText`, `ok` | Actual Fetch response status fields. `ok:false` is returned with its body, not replaced by a generic error. |
| `headers` | All entries exposed by the Fetch `Headers` object, represented as `[name, value]` pairs. |
| `mediaType` | Complete `Content-Type` field value exposed by Fetch, or `null`. |
| `body` | Complete entity content as a `Blob` in the browser and a `Uint8Array` in native calls. |
| `complete` | `true` after the response body reaches its end. |
| `redirects` | Ordered preceding response records, each with `url`, status fields, headers, media type, body, and completion state. |

The content is the response entity supplied by Fetch, including Fetch's normal
content-decoding behavior. It is not a capture of compressed network framing.
Likewise, headers reflect Fetch's casing and combination behavior; the SDK does
not invent original wire casing or unavailable header distinctions. Document
content is never converted to text, normalized, summarized, or wrapped in
instructions. Query and progress metadata remain outside the content.

## Progress, cancellation, and errors

Progress records contain `phase`, `completed`, `total:1`, `unit:'documents'`,
`requestedUrl`, and the current `url`. Browser records additionally contain
the originating `requestId`. Phases are `accepted`, `destination`, `request`,
`response`, `redirect`, and `complete`. The completed count becomes one only
after the final response has been fully acquired, including an HTTP error
response. Status fields, not acquisition progress, establish HTTP success.
Progress does not measure content and carries no document body.

The browser helper filters request-correlated events and removes its listener
on every settlement. Synchronous or asynchronous progress callbacks are
observed; all accepted callback promises settle before the helper settles.
A callback failure cancels the request and remains observable. Simultaneous
operation and callback failures are retained in an `AggregateError`.
If a callback or subscription cleanup fails after the complete response has
arrived, that response remains in the error's `documentAcquisition` evidence;
the original callback failure remains its `cause` or an aggregated error.
Callbacks must finish or honor the application's cancellation signal.

Native acquisition errors retain the original thrown value as `cause` and
include `documentAcquisition: {requestedUrl, requestUrl, redirects, response?}`.
Every acquired redirect body is retained. If reading a response fails, its
available original content is retained with `complete:false`; that record is
explicitly incomplete. Cleanup failures remain observable alongside the
original error. On errors delivered through Core, the browser helper restores
the response and redirect bodies as Blobs and retains the native error record.

An abort uses the existing Core client's immediate local rejection and sends
request cancellation to the native owner. That local cancellation does not
wait for a native error record or return its response evidence. The native
owner cancels and joins its active response reader. Independent acquisitions
remain concurrent, and cancelling one request leaves sibling requests active.
Service `dispose()` aborts and joins all of that service's active operations.

## Native calls and transport

The synchronous factory accepts `{destinationPredicate?, signal?}` and returns
the existing Core service definition plus
`acquire({url, signal?, onProgress?})` and idempotent asynchronous `dispose()`.
Direct native results and error evidence contain `Uint8Array` bodies (Node
Buffers implement that interface). The optional factory signal controls the
service lifetime; a per-call signal controls only that acquisition.

At the JSON RPC boundary only, each body becomes
`{encoding:'base64', data:'...'}`. One final response carries the complete result
and ordered redirect records. The browser decodes those transport fields into
Blobs. This path buffers complete response bodies; phase events are not a
body stream and do not supply streaming backpressure. Existing Core lifecycle,
request routing, and connection-close cancellation retain ownership of the
operation through native settlement.
