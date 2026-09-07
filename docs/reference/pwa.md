# Progressive web applications

An application supplies its installation identity and offline resource selection.
The SDK generates the Web App Manifest, offline inventory, service worker and
nonblocking registration module. Native packages keep their existing lifecycle.

## Application configuration

Set `package.pwa` in the application's `arcane-app.json`. Its ordinary package
projection carries the same `pwa` record in `arcane-package.json`:

```json
{
  "enabled": true,
  "manifest": {
    "name": "Example Library",
    "short_name": "Library",
    "display": "standalone",
    "icons": [
      {
        "src": "img/library.png",
        "sizes": "512x512",
        "type": "image/png"
      }
    ]
  },
  "offline": {
    "exclude": ["documents"]
  }
}
```

`enabled` defaults to `false`. `manifest` contains ordinary Web App Manifest
metadata. Its default name comes from `displayName`; its default start page
comes from the selected application entry. The app owns names, icons, colors,
display preference, routes and descriptions. Use real app icons; the SDK does
not invent branding or claim that a browser has installed the app.

Manifest URL fields are relative to the application directory. Source delivery
and packaged delivery resolve those fields into their respective layouts.
Absolute URL fields retain their authored destination.

`offline.include` and `offline.exclude` select literal paths or directory
prefixes from the selected emitted inventory. An omitted or empty include list
selects that inventory; exclusions subtract from it. App files use app-relative
paths and shared runtime files use paths such as `arcane/sdk/pwa.mjs`.
The application entry and generated PWA shell records are retained. Select the
resources needed by every offline page, including its shared modules and styles.
The worker script itself is never an application cache entry.

These settings describe published application resources. They do not select
user uploads, provider responses, live API requests, saved conversations,
preferences, IndexedDB, OPFS, or a model owner's download/cache lifecycle.
Offline page availability does not imply that cloud inference or other network
services work offline. Applications own the corresponding visible behavior.

## Generated output

Browser packaging emits these files at the selected deployment root:

| File | Purpose |
| --- | --- |
| `arcane.webmanifest` | Browser installation metadata. |
| `arcane-offline.json` | App ID/version, SDK version, deployment revision, resource URLs and explicit navigation aliases. |
| `arcane-sw.js` | Stable worker URL with the selected offline manifest embedded in its source. |
| `arcane-pwa.mjs` | Independent registration module importing the SDK client. |

Each packaged output gets one deployment revision shared by its offline
manifest and worker. It distinguishes separately generated outputs even when
their app and SDK versions match. It is not a content measurement.

The package owns its selected inventory once, after any app adapter finishes.
It follows actual resource references to include meaningful query variants.
Generated application pages receive a manifest link and an `async` module
marked `data-arcane-pwa`. Existing application scripts retain their order.
PWA registration does not wait for models, storage, preferences or page rendering.

The selected PWA browser delivery removes `v` and `arcaneVersion` from actual
local resource references, including the managed import map. Other query fields,
fragments, source spelling and unrelated payloads are preserved. The offline
manifest now carries release information. Non-PWA and native delivery retain
the [existing asset version contract](asset-versioning.md).

## Development and hosting

For an enabled application, `arcane dev` serves the generated PWA files at the
origin root and starts at the selected app page under `/apps/<id>/`. Use one
selected app per development origin. Its worker uses network revalidation first
and retains successful selected resource responses for offline use, so saved
source edits remain visible on an ordinary online refresh.

Source inventory work begins when the browser requests the worker update, after
the page can start. It traverses the selected route inventory once for that
request, follows application page and runtime resource references to retain
selected query variants, and shares an in-flight traversal with concurrent
manifest requests. Each referenced source file is read once per traversal;
document corpus bodies remain under their existing owner. It does not rebuild
the application. Generated metadata and bootstrap requests reuse the current
bundle.

Packaged workers use their selected cache generation first. During installation,
at most four resource requests run together; each response is fetched from the
network with the browser's reload cache mode before it enters the candidate
cache. The candidate must finish
installation before the browser activates it. Failures retain the prior active
worker and remain observable through native worker state and SDK diagnostics.

The SDK development server sends `Cache-Control: no-cache` for PWA resources.
An independent static host must also revalidate stable HTML, module, style,
import-map and worker URLs, and serve JavaScript with a JavaScript content type.
Keep the worker beside the deployment root it controls. The browser requires a
supported secure context, such as trusted HTTPS or localhost, to register it.
The SDK does not change certificates or browser permissions.

An initial visit can load before a worker controls the document. Revalidation
therefore matters even when an offline cache exists. Updating files in place
while installation fetches them is not an atomic release snapshot; the host owns
consistent deployment of the selected output.

An offline navigation alias redirects to its selected entry page, preserving the
document URL used to resolve relative modules and styles.

Browser storage eviction can remove an offline cache. A missing release cache
entry falls back to the network, so offline availability still depends on the
browser retaining the selected resources.

## Updates and stored data

An updated worker installs alongside the current worker, then waits for the
browser's normal activation boundary. Existing controlled pages retain their
worker while they are open. Closing those pages allows activation; a refresh
can leave overlapping document clients and keep the update waiting.

The SDK does not call `skipWaiting`, claim the initial page, reload a page,
restart a model or poll for updates. Activation retires only obsolete resource
caches belonging to that exact app and registration scope. Saved application
data and caches owned by other capabilities are untouched.

Switching a server from a packaged release to live development does not replace
an already active release worker inside an open document. The same native
worker lifecycle applies.

## registerPwa()

Import `registerPwa` and `PWA_STATE_EVENT` from `arcane-os/pwa` through the
managed browser import map. The generated bootstrap already calls this API;
manual callers use it when they own a separate registration entry point.

```javascript
import {registerPwa} from 'arcane-os/pwa';

const pwa = registerPwa(
    {
        workerUrl: new URL('./arcane-sw.js', import.meta.url).href,
        scope: new URL('./', import.meta.url).href
    }
);

pwa.subscribe(function showPwaState(state) {
    console.log(state);
});
pwa.ready.catch(function reportRegistrationFailure(error) {
    console.error(error);
});
```

The function returns synchronously with `{ready, state, subscribe, update,
dispose}`. `ready` settles with the native registration, or `null` when service
workers are unavailable. A registration failure rejects it and publishes error
state. Do not await it before rendering or confuse it with a controlled page.

`state` reports `status`, `workerUrl`, `scope`, `controller`, `installing`,
`waiting`, `active` and the complete `error` when present. Status is one of
`registering`, `unsupported`, `registered`, `installing`, `waiting`, `active`,
`error` or `disposed`. Native worker state fields are strings or `null`.

`subscribe(listener, {emitCurrent: true, signal} = {})` immediately replays the
current state by default and returns an unsubscribe function. Subsequent state
uses the existing Arcane event owner and `PWA_STATE_EVENT` (`arcane.pwa.state`).
`update()` requests the browser's normal update check on demand; failure is
observable in state and through its returned promise. `dispose()` removes
page-owned listeners and subscriptions without unregistering the persistent
worker or deleting stored data.
