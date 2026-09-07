# Progressive web applications

An application supplies its installation identity and offline resource selection.
The SDK generates the Web App Manifest, offline inventory, service worker and
nonblocking registration module. Its shared installation owner and dismissible
component expose the browser's available install action. Native packages keep
their existing lifecycle.

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
| `arcane-pwa.mjs` | Independent registration and installation-component bootstrap importing the SDK client. |

Each packaged output gets one deployment revision shared by its offline
manifest and worker. It distinguishes separately generated outputs even when
their app and SDK versions match. It is not a content measurement.

The package owns its selected inventory once, after any app adapter finishes.
It follows actual resource references to include meaningful query variants.
Generated application pages receive a manifest link and an `async` module
marked `data-arcane-pwa`. Existing application scripts retain their order.
PWA registration does not wait for models, storage, preferences or page rendering.
The same bootstrap starts one initially hidden `pwa-install.html` component with
the generated manifest's app name. Component loading and worker registration
proceed independently.

The selected PWA browser delivery removes `v` and `arcaneVersion` from actual
local resource references, including the managed import map. Other query fields,
fragments, source spelling and unrelated payloads are preserved. The offline
manifest now carries release information. Non-PWA and native delivery retain
the [existing asset version contract](asset-versioning.md).

## Development and hosting

Use the ordinary `arcane dev --app <id>` command after editing the selected
app's `arcane-app.json`. Startup refreshes that app's generated
`arcane-package.json` from the authored descriptor before refreshing its import
maps and starting the server. No packaging or `dist` output is required.
Package-only applications retain their existing descriptor workflow.

Add a file or directory to `package.include` to make it part of the app's
resources. A new file inside an already included directory needs no separate
entry. `package.include` is an application resource selection, not a file list
inside the Web App Manifest. `arcane.webmanifest` contains browser installation
metadata; `arcane-offline.json` contains the selected offline resource inventory.
If `package.pwa.offline.include` is nonempty, the resource must also
match that offline selection and must not match `offline.exclude`. Adding a
path only to the offline selection does not add it to the app's resources.
The running source server reads changed app descriptors before the next app,
root-navigation or generated-PWA request. Include/exclude rules, the entry and
PWA settings share the current selection; no restart or package projection
write is needed. Edits to selected source files are picked up by the next due
page-load check while the server remains running.

For an enabled application, `arcane dev` serves the generated PWA files at the
origin root and starts at the selected app page under `/apps/<id>/`. Use one
selected app per development origin. The SDK uses `node-http-server` for source
and packaged-preview serving, including conditional resource responses.
Arcane development servers default to HTTPS, including localhost, and packaged
browser previews require HTTPS. Configure the workspace certificate pair before
starting the ordinary command; see [development HTTPS setup](cli.md#development-https-setup).
Explicit source-only `arcane dev --http` serves the same generated PWA routes
without loading certificates; see [explicit HTTP development](cli.md#explicit-http-development).
`--public` selects the IPv4 wildcard bind address; it does not enable PWA
configuration, change manifest metadata, or determine browser installability.

Source inventory work begins when the browser requests the worker or current
offline manifest, after the page can start. It traverses the selected route
inventory once for that request, follows page and runtime resource references
to retain selected query variants, and shares an in-flight traversal with
concurrent requests. Each referenced source file is read once per traversal;
document corpus bodies remain under their existing owner. It does not rebuild
the application. Installation metadata and bootstrap requests reuse the current
generated bundle.

The SDK owns version information in `arcane-offline.json`:

| Field | Owner and update rule |
| --- | --- |
| `schemaVersion` | SDK offline-manifest format; currently `1`. |
| `appVersion` | The app descriptor's top-level `version`. |
| `sdkVersion` | The selected installed SDK or explicit live SDK source version. |
| `revision` | `development` for the source server; a fresh generated deployment ID for each packaged output. |

Do not hand-edit generated manifests or bump a version for every source edit.
`arcane.webmanifest` holds installation metadata and has no separate SDK-managed
release counter. Resource freshness uses each response's `Last-Modified` header.

On each page load, the SDK reads one `lastChecked` value for the app and worker
scope from DBOPFS in the background. When that value is missing or older than
the delivery mode's interval, it checks the current offline manifest and every
selected resource:

| Mode | Page-load check interval |
| --- | --- |
| Development | 120 seconds |
| Packaged browser delivery | 15 minutes |

These intervals schedule revalidation; they never expire a cached file. The
worker sends `GET` with `If-Modified-Since` using the cached response's
`Last-Modified`. A `304 Not Modified` retains the complete cached response. A
successful `200` replaces it after the new response is stored. Missing cached
resources are downloaded. Network and server failures retain an existing
offline copy and remain observable through SDK diagnostics. A host without
modification headers must send the current response because freshness cannot
be established from a missing header.

Complete resource responses remain in browser CacheStorage. DBOPFS stores one
successful whole-cycle timestamp, updated only after the manifest and every
selected resource have been checked successfully. A partial failure preserves
the previous timestamp so the next page load can retry. Each cached response
retains its own `Last-Modified` header, but there are no per-file check times.
The SDK imposes no age-based cache deletion and
retains resource bodies across app and SDK version changes. Requests for a page
do not wait for the complete resource inventory to finish checking. A file
already in the current resource cache also returns immediately when its own
conditional check is pending or in flight. That background check keeps its
existing owner and updates the stored response for subsequent requests.
The page receives the cached response's original status, commonly `200`, even
when the separate conditional network response is `304`. Status alone does
not identify a network transfer; use the browser's response source and timing
details to distinguish cache access from worker startup, queueing and network.
The SDK
uses at most four concurrent background resource requests and starts no timer
or polling loop between page loads.

During initial installation, selected resources are cached before the browser
activates the worker. Failures remain observable through native worker state
and SDK diagnostics. HTTP modification dates have second-level precision;
hosts must report changes to the served representation, including generated
output, rather than only the date of an unrelated source file.

The SDK development server sends `Cache-Control: no-cache` for PWA resources.
An independent static host should support `Last-Modified` and conditional GET
for stable HTML, module, style and import-map URLs, revalidate worker URLs, and
serve JavaScript with a JavaScript content type.
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
restart a model or poll for updates. Worker activation preserves cached
resources and the DBOPFS check history for the same app and registration scope.
Saved application data and caches owned by other capabilities are untouched.

When importing caches from an older SDK worker, the new worker fetches the
SDK-owned registration bootstrap and PWA client once so the page can use the
current cache-check protocol. Other cached resource bodies retain the normal
check cadence. This transition follows native worker installation and
activation without forcing a page reload.

Switching a server from a packaged release to live development does not replace
an already active release worker inside an open document. The same native
worker lifecycle applies.

## Installation component

Starting with SDK `0.13.0`, enabled PWA pages automatically mount the shared
[`pwa-install.html` component](runtime-components.md#pwa-installhtml). It appears
when the browser supplies an installation prompt, offers **Install** and a
clearly labeled close control, and does not move focus when it appears.
The floating suggestion has no automatic dismissal timer. Closing it remembers
the choice for the current tab session and manifest URL, so another page
load does not immediately show it again. A storage failure leaves the current
page's dismissal functional and reports the error through console diagnostics.

An application can also place the same component inline through `html-import`
with `data-presentation="inline"`. Both presentations share one page-owned
native installation event. Dismissing the floating suggestion does not consume
that event or disable an explicitly placed inline component. Closing an inline
instance hides only that instance. See the component reference for its
configuration, methods and events.

The browser controls the URL-bar installation indicator and native prompt.
The SDK cannot force either to appear. Without a captured
`beforeinstallprompt`, the component remains hidden; that waiting state does
not establish that installation is unsupported. The browser may still be
evaluating the app, may already have it installed, or may only support a
manual browser-menu installation path.

### Browser installation requirements

Inspect the loaded page's manifest link and the browser's manifest diagnostics
when an install action is missing. Confirm that the generated manifest has the
intended name, `start_url`, scope and app display mode, and that its icon URLs
resolve to actual images with the declared dimensions. For Chromium's manifest
install promotion, provide a `purpose: "any"` icon, or omit `purpose` to use
that default, in PNG, SVG or WebP format. Its strict installation icon selector
excludes JPEG even when the same image renders successfully on the page.
Do not change a file's extension or MIME declaration without converting the
actual image at the application's asset owner. See Chromium's
[icon selection implementation](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/common/manifest/manifest_icon_selector.cc).

Providing 192-by-192 and 512-by-512 raster icons follows the
[browser guidance](https://web.dev/articles/add-manifest). Their absence alone
does not prove the failure: Chromium can select one larger supported icon.
Keep actual icon dimensions in `sizes`. Browser diagnostics about missing
`screenshots` concern the richer installation dialog; screenshots are optional
and are separate from a usable installation icon.

Browser installation requires HTTPS or the browser's localhost/loopback
exception. A device-facing LAN address is not loopback. Selecting HTTP serving
does not make that LAN origin a secure context. Chromium documents a separate
[explicit developer origin setting](https://www.chromium.org/Home/chromium-security/deprecating-powerful-features-on-insecure-origins/);
the SDK does not configure that setting or claim that starting the server proves
installation eligibility. Browser engagement,
installation state and platform support also affect whether native promotion
appears; worker cache readiness is not an installation UI prerequisite. See
[browser installation requirements](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

Browsers without `beforeinstallprompt` can offer manual installation. For
example, current iPhone Safari uses Share, **Add to Home Screen**, **Open as
Web App**, then **Add**. A product may explain that browser-owned path in its
help, but should not present it as a programmatic SDK install action. The SDK
does not infer installation support from the user-agent string. See
[Apple's installation instructions](https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios).

## getPwaInstall()

Import `getPwaInstall` and `PWA_INSTALL_STATE_EVENT` from `arcane-os/pwa`.
`getPwaInstall()` synchronously returns the shared page owner with `state`, `ready`,
`subscribe`, `prompt`, `dismiss` and `dispose`. Call it early when owning a
separate install entry point so it can capture `beforeinstallprompt` before
loading the UI. The generated bootstrap already does this through
`mountPwaInstallPrompt()`.

`state` contains `status`, `available`, `installed`, `dismissed`, `outcome`,
`error` and `storageError`.
Status is `waiting`, `available`, `prompting`, `accepted`, `dismissed`,
`installed`, `running`, `error` or `disposed`. `available` means a native event
is retained, the initial installation-record read has settled, and installation
has not been recorded or detected. A dismissed floating suggestion can still
have `available: true`. `installed` is true after browser-reported installation
or restoration of that app's saved installation record.
`outcome` is the browser's `accepted` or `dismissed` choice, or `null` before a
choice. `error` carries the complete prompt error, or `null`; `storageError`
carries the complete DBOPFS read or write error, or `null`.

`ready` resolves to the state after the initial DBOPFS read settles. Native
events are captured synchronously while this read runs. Only installation
availability waits for it; page rendering, component loading and worker
registration continue independently. A storage failure is logged and published
as `storageError`; `ready` still resolves and native installation remains usable.

`subscribe(listener, {emitCurrent: true, signal} = {})` immediately replays
state by default and returns an unsubscribe function. Later state travels
through the existing Arcane event owner using `PWA_INSTALL_STATE_EVENT`
(`arcane.pwa.install.state`). A subscription does not wait for worker
registration, storage initialization or model readiness.

Call `prompt()` directly from the user's install click, before any asynchronous
wait. It invokes the browser prompt in the same call stack, consumes the event
once, and returns a promise for the browser's choice. It resolves to `null`
when installation is unavailable, including while the saved state is loading
or after installation is remembered. Failure publishes
`error` state and rejects. A new native event is required for another prompt.

```javascript
import {getPwaInstall} from 'arcane-os/pwa';

const install = getPwaInstall();
const installButton = document.querySelector('#install');

install.subscribe(function showInstallAvailability(state) {
    installButton.hidden = !state.available;
});
installButton.addEventListener('click', function requestInstallation() {
    install.prompt().catch(function reportInstallFailure(error) {
        console.error(error);
    });
});
```

`dismiss()` remembers the session choice without consuming the retained event
and returns the current state. A browser-native dismissed choice is remembered
too. `appinstalled` clears the event, publishes `installed`, and saves
`{installed: true}` as `pwa/installed.json` through the current app-scoped
DBOPFS singleton. An installed-app launch in standalone, minimal-ui or
window-controls-overlay mode, or with `navigator.standalone === true`, also
records installation. Ordinary fullscreen suppresses the current prompt but
does not record installation because browsers can enter fullscreen without
installing an app; see the [display-mode specification](https://drafts.csswg.org/mediaqueries-5/#display-modes).

Every new owner reads the saved flag, so both floating and explicit inline
controls stay hidden on subsequent visits in that browser origin's app scope.
The SDK never clears this flag or resets it when display mode changes. Prompt
acceptance and dismissal alone do not write it. The record is independent of
resource-check history and other application data. A pending read cannot undo
newly observed installation, and a confirmed installation's pending write is
retained through owner disposal. A write failure remains observable without
making the current installed session eligible again.

Running in an app display mode publishes `running`. These states
do not establish offline readiness. On Android, `appinstalled` can arrive
before WebAPK creation finishes. See the
[browser lifecycle distinction](https://web.dev/learn/pwa/detection/).

`dispose()` removes the shared owner's native listeners and subscriptions.
Leaving the page disposes it automatically, except when the browser retains
the page in its back/forward cache.
Because the owner is shared, an individual component should dispose its own
subscription instead. A later `getPwaInstall()` creates a new owner after
disposal; it cannot recover a native event that was already consumed.

## mountPwaInstallPrompt()

`mountPwaInstallPrompt({appName = ''} = {})` starts native install observation
synchronously, then loads the shared HTML import and theme modules concurrently
and appends one initially hidden component when the document body is available.
It returns the same mounting promise on repeated calls; the first call supplies
the initial app name. The promise resolves to the ready `html-import` host, or
`null` without a document or when the owner is disposed before mounting. It
rejects if component loading fails, or with `AbortError` when the loading host
is removed or its owner disposed. A rejected mount releases its slot so an
explicit later call can try again. Observe the rejection without making page
rendering wait for it.

The generated PWA bootstrap calls this automatically using the manifest name.
Applications need not add another floating suggestion. A separate entry point
can call it explicitly:

```javascript
import {mountPwaInstallPrompt} from 'arcane-os/pwa';

mountPwaInstallPrompt({appName: 'Example Library'}).catch(
    function reportInstallComponentFailure(error) {
        console.error(error);
    }
);
```

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
