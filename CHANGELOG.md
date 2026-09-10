# Changelog

## 0.33.2

- Initialize the shared file manager's default tree provider before an
  already-ready DBOPFS starts loading. Preserve deferred readiness, custom
  providers, duplicate-ready handling and component disposal without adding
  a startup wait.
- Correct the isolated-model question runner's sentence and Unicode matcher
  literals so the public module imports successfully. Keep complete questions,
  answers and provider metadata while adding the existing sentence count.
- Retain standalone app-root hosting through `/node_modules/arcane-os/...`;
  this patch requires no app-local SDK changes or copied `/arcane` tree.

## 0.33.1

- Preserve application and pre-existing body classes when the shared header
  applies a saved User skin. Repeated ready notifications replace only skin
  classes previously added by that header, retaining its existing readiness,
  navigation and online-status behavior.

## 0.33.0

- Add the default and named `AIModelSelectionController` export at
  `arcane-os/modules/AIModelSelectionController.js`. It coordinates existing
  LLM, STT and TTS provider/model select elements with app-owned defaults,
  catalogs and optional explicit asynchronous inventory discovery.
- Preserve unknown saved values and newer drafts during asynchronous
  hydration and discovery, including paired LLM provider/model choices and
  per-provider model memory. Expose current selection, operation state,
  original errors and deterministic disposal without late control mutations.
- Keep the existing six-slot preference tuple order and spelling unchanged.
  The controller neither saves User preferences nor activates or downloads
  providers, models or voices; application policy and persistence stay local.

## 0.32.0

- Export `profileUpdateFromSearchParams(searchParams)` from
  `arcane-os/entities/User.js` for purchase-link profile updates. It maps
  `subscription` (otherwise `subscription_key`), exact `TWiN`, `name`, `email`,
  and `phone` to the existing User profile fields and omits empty or missing
  selected values. A present `subscription` takes precedence even when empty.
- Preserve normal `URLSearchParams` decoding, first repeated values, Unicode,
  spaces, literal plus signs and leading zeros without further conversion.
  Ignore `zipcode` and unrelated keys. The helper neither mutates the URL nor
  saves; apps retain hydration, draft protection and `updateExplicit` ownership.
- Keep the standalone root/direct npm path behavior released in `0.31.0` and
  all existing User setters, persistence and browser singleton lifecycle.

## 0.31.0

- Standalone applications use their repository root and installed npm package
  paths. New standalone projects default to `appsRoot: "."`; initialization
  preserves an existing configured layout, and explicit multi-app workspaces
  retain their selected application directories.
- Remove the retired `legacyAppPaths` setting and all SDK-generated nested app
  redirects and duplicate PWA worker/inventory files. Consumers must remove the
  obsolete setting when upgrading. Enabled PWA files remain at the app root;
  public SDK files remain under `node_modules/arcane-os` or the installed alias.
- Preserve selected authored files, complete URLs and queries, installation
  identity, saved data and caches. Generation does not delete preexisting app
  files; application owners preserve and relocate their content independently.
- Generated and offline app files are committed for hosting workflows to
  consume. Existing public Node TWiN and browser APIs remain available.

## 0.30.0

- Add the public `arcane-os/ai/twin-cloud` subpath with stateless `fetchRequest`
  for Node and browser callers. Supply the TWiN key, model, messages, optional
  structured-output schema and cancellation signal explicitly. The result is
  the complete parsed provider completion, with no browser startup, saved
  conversation, hidden model default or output cap.
- Share the existing TWiN HTTP, structured JSON, overload retry and cancellation
  implementation with the browser AI owner while preserving its public methods
  and lifecycle. Only overload responses with HTTP 429 use the existing
  three-second retry; other failures retain their complete provider response.

## 0.29.1

- Preserve complete long and non-ASCII filenames in application release bundles
  through standard per-file PAX path extensions. Public bundle creation and
  verification retain logical payload paths and complete file content without
  application-side renaming. Ordinary USTAR representation remains supported,
  and the existing SDK-version metadata contract is unchanged. Bundles using
  extended paths require the updated SDK reader or another PAX-capable reader.
- Preserve application-authored resource URL queries, including `v`, encoded
  and repeated fields, empty query segments, and fragments. Import-map refresh,
  serving, packaging, and PWA delivery now change only SDK-owned `arcaneVersion`
  fields through the existing shared transformer.

## 0.29.0

- Add `legacyAppPaths: false` to `arcane-packager.json` for root applications
  using `appsRoot: "."`. Import-map refresh, source development, and packaging
  omit SDK-generated `apps/<id>` navigation aliases and legacy PWA worker and
  inventory files. Omission or `true` preserves the existing behavior.
- Preserve application storage identity, explicit PWA manifest identity, direct
  installed npm resource URLs, and selected authored files. The SDK does not
  delete existing historical files. Applications choosing root-only output own
  removal of those files and the resulting loss of old bookmark, launch, and
  service-worker update URLs that depended on them.

## 0.28.4

- Preserve installed component-relative browser-runtime and strong-type import
  aliases in direct npm maps, including npm-alias workspaces. These aliases
  resolve to the same installed modules as the direct paths, restoring browser
  device-settings loading without copies or a second module instance.
- Serve explicitly included historical authored resources at their retained
  paths in root-app development. Unselected navigation aliases and generated
  PWA endpoints retain their existing behavior. Applications refresh managed
  maps through the public SDK command after updating the dependency; no
  authored SDK edits, saved-data migration, or dependency changes are required.

## 0.28.3

- Add explicit `DBOPFS.removeEmptyTable(tableName)` for removing an existing
  empty table directory through native non-recursive OPFS removal. It reports
  `removed`, `absent`, or `not-empty` and preserves nonempty tables and file
  targets without creating, scanning, or clearing them.
- Invalidate the logical/physical table alias and cached handles after removal
  or confirmed absence. Existing recursive `deleteTable()` and
  `clearAllStorage()` behavior remains unchanged. This release performs no
  automatic cleanup or saved-data migration; npm paths and dependencies remain
  unchanged.

## 0.28.2

- Redirect unmatched Mail server routes with `303 See Other` to
  `https://<current hostname>/404.html`, using the request's HTTP/1 Host or
  HTTP/2 authority and omitting the API listener port. The redirect has an empty
  body and uses the existing HTTP server response interface.
- Preserve `/v1/mail` requests with query strings, CORS and OPTIONS behavior,
  method and API errors, subscription handling, and the complete Mail provider
  and cancellation lifecycle. Client APIs, npm resource paths, dependencies,
  and listener configuration are unchanged.

## 0.28.1

- DBOPFS initialization opens the application's existing storage scope without
  creating product-specific table directories. Applications create the tables
  they need through the existing `getTableHandle(name)` API after readiness.
- Create tables on demand and coalesce concurrent requests for the same physical
  table. Logical `memories` and physical `memory` retain one shared handle and
  deletion path. Existing directory discovery, complete reads and exports, CRUD,
  worker fallback, events, application identity and saved data remain supported.
- Explicit `clearAllStorage()` leaves the cleared application scope empty rather
  than recreating default folders. This update performs no saved-data migration
  or automatic removal of existing folders. The 0.28.0 npm resource paths remain
  unchanged.

## 0.28.0

- Expose existing runtime modules and entities directly through
  `arcane-os/modules/<filename>` and `arcane-os/entities/<filename>`, including
  extensions. Package exports and managed maps point to the actual files, so
  relative imports, component resources and `import.meta.resolve` keep their
  established directory and lifecycle. Existing lowercase exports remain.
- Root apps using direct npm routes generate package-namespaced maps without
  the old `arcane/*` or `./arcane/*` keys. Update authored root-app bare imports
  before regenerating the managed map. Installed `runtime/arcane/` directories
  remain unchanged; physical, virtual and nested layouts retain compatibility.
- Use the package namespace for generated root app code and shared PWA imports,
  preserving parallel startup and the existing storage and installation owners.
- New root apps declare the SDK as a runtime dependency. Init promotes their
  SDK development declaration and preserves existing runtime or optional
  classification in every layout, including aliases. Existing nested scaffold
  defaults remain unchanged. No server, listener or application policy changes.

## 0.27.1

- Preserve the previous `apps/<id>/arcane-sw.js` and `arcane-offline.json`
  endpoints when generating a root-layout PWA. Both use the canonical worker
  and current root inventory, including navigation aliases and installed npm
  resource paths; portable output also retains deployment-relative URLs.
- Serve those previous worker and inventory endpoints directly during SDK
  development instead of redirecting worker-script requests. Retain ordinary
  browser update/activation, caches, application identity and saved data.
- Keep root layout optional and existing multi-app and Node server behavior
  unchanged. Installed-application execution remains consumer-owned.

## 0.27.0

- Add optional standalone `appsRoot: "."` discovery and `new`/`init --apps-root .`.
  Preserve declared app IDs, existing multi-app/integrated layouts, nested pages,
  and the selected native/portable package interface.
- Serve and package direct installed SDK URLs under `/node_modules/<dependency>/`.
  Managed bare and relative imports select the same module instances, including
  npm aliases; dynamic component resources resolve from their own installed URL.
- Generate root static PWA files and prior `/apps/<id>/` navigation pages through
  the existing `arcane import-map` operation. Preserve authored installation IDs,
  source/package defaults, query strings, fragments, and complete app content.
  Ordinary static hosts need no additional SDK server or copied runtime.
- Keep existing physical and virtual browser routes, Node mail APIs, listener
  configuration, and server-consumer entrypoints unchanged.

## 0.26.0

- Add explicit installed-package browser runtime routes. Source development,
  managed import maps, application test-map resolution, and PWA resource
  selection can use the npm dependency directly without a generated workspace
  runtime or lock. Keep existing browser URLs, aliases, and materialized layouts.
- Let a shared package route select its complete source directory with
  `include: ["."]`. Portable app output includes the selected runtime,
  dependencies, assets, and notices without requiring the SDK at deployment.
- Expose lowercase public module subpaths for shared AI preferences, provider
  state, model definitions, conversation helpers, application data, document
  libraries, and local AI readiness. Browser maps and Node package resolution
  select the same canonical implementations; browser runtime requirements remain.
- Share the existing portable Mail aggregation with browser import maps while
  preserving the `arcane-os/mail` API and Node mail CLI used by server consumers.

## 0.25.0

- Automatically skip configured mail subscription verification when the actual
  requester connection IP equals the server-side IP of that connection. This
  lets services sharing that IP and local development send without a subscription
  key. Other requester IPs, including other intranet machines, still use the
  configured verification callback.
- Use native connection addresses for HTTP/1 and HTTP/2, with no environment
  setting, domain lookup, forwarded-header interpretation, or special loopback rule.
  Preserve CORS, report handling, provider delivery, and existing caller APIs.
- Document the IP rule and its purpose gates; update focused test source for
  the exemption and the remaining subscription-verification paths.

## 0.24.1

- Add a mail CLI parameter table with command scope, purpose, and defaults.
  Explain the difference between `--app`, `X-Mail-App`, `--report-stdin`, and
  the nonsecret `--report-key` used for intentional same-message retries.
- Remove redundant default-profile configuration and the alternate-account
  placeholder from the main mail example. Align the CLI reference with the
  shared configuration and credential files while preserving named-profile APIs.
- Clarify when subscription headers are required, how ordinary delivery failures
  retain their existing report, and the separate browser callback and verification
  service paths that can create feedback. Runtime behavior is unchanged.

## 0.24.0

- Read nonsecret mail settings from `arcane.config.json.mail` and provider keys
  from `.arcane.env.json.mail`. Keep existing root keys, exact named profiles,
  and TLS path settings working without migrating or rewriting either file.
- Let explicit CLI/API options override configuration, replace origin lists,
  and apply listener defaults after file settings. Share configured profile,
  sender and provider deadlines with `mail send` without requiring TLS paths.
- Preserve unrelated settings during credential updates and remove both selected
  key representations on explicit deletion. Document configuration precedence,
  origin rejection, startup, platform behavior and the purpose-gate review.

## 0.23.0

- Rename the mail configuration file to `.arcane.env.json`. Upgrade existing
  deployments by renaming `.env.json` in the directory where the mail command
  runs, preserving its contents. Mail commands now read only the selected new
  name and report `storage: '.arcane.env.json'`.
- Keep configuration independent of the SDK installation directory, including
  an SDK nested beneath the site root. Preserve provider profiles, relative TLS
  paths, other JSON settings and HTTPS/HTTP2 port 4433. Update help, references,
  the purpose-gate report and generated-workspace Git ignores.

## 0.22.1

- Change the mail gateway's default HTTPS/HTTP2 port from 8025 to 4433 in
  the CLI and server configuration. Preserve explicit port overrides and the
  existing occupied-port message; update current help, references and gate report.

## 0.22.0

- Export `generateDocumentImportMaps()` from `arcane-os` for explicitly selected
  host HTML documents and an existing materialized runtime. Generate each
  document's SDK import URLs from its authored base without app discovery or
  imposing an application layout.
- Preserve complete authored HTML, resource URLs, custom import maps and script
  loading order while updating only SDK-managed map blocks. Encode runtime
  filenames and rebase both targets and URL compatibility keys.
- Inventory the selected runtime once per batch, prepare every document before
  writing, and expose ordered write events, cancellation and event-delivery
  failures. Document the public API and add focused behavioral test source.
- Preserve the platform's existing cancellation code in the import-map and
  runtime-inventory paths, including ordinary `AbortController.abort()`.

## 0.21.0

- Serve mail over HTTPS with HTTP/2 through the published `node-http-server`
  PEM API, with HTTP/1.1 fallback on the same selected port, default 8025.
  Preserve the friendly occupied-port failure and owned listener lifecycle.
- Read `MAIL_TLS_CERT_PATH` and `MAIL_TLS_KEY_PATH` with the provider profile
  from `.env.json` in one startup read. Resolve relative PEM paths from that
  file's directory and report missing TLS settings before binding. Keep file
  and TLS handling portable across Windows, Linux and macOS.
- Use native HTTP/2 headers and authority for the mail and CORS contracts,
  preserving exact report content, subscription verification, provider
  outcomes, existing credential injection and cancellation.
- Extend the mail reference and purpose-gate report with TLS ownership and
  configuration; add focused protocol and configuration test source.

## 0.20.0

- Restore repository-shaped application packages: selected app files remain
  under `apps/<id>/`, alongside shared `arcane/` and configured runtime routes.
  Authored document bases, import maps, module-relative imports and application
  resource paths retain their development layout without rewriting product
  documents or application code to relocate them.
- Restore deployment-relative `ARCANE_APP_RELEASE.app.start` and a root
  `index.html` launcher while preserving the app-relative `app.entry` identity.
  Package consumers use `app.start` for navigation. SDK packaged previews honor
  that field and retain support for earlier flat packages through `app.entry`.
- Keep generated PWA files at the deployment root, resolve manifest metadata
  against the packaged app directory, and preserve app-relative offline
  selections alongside shared runtime paths. Source import-map inspection keeps
  app-relative document paths and separately reports emitted package paths.
- Align packaging references with the current public return values and explicit
  source import-map generation. Add package-layout and nested-deployment test
  source while retaining complete authored-content coverage.

## 0.19.0

- Read mail credentials from `.env.json` in the invocation directory through
  portable Node file APIs. Remove the Windows Credential Manager subprocess,
  embedded PowerShell/C# helper, helper timeouts, and transport-only machinery.
  Existing Windows credential records remain untouched; populate the JSON file
  explicitly when adopting this configuration change.
- Default mail commands to the top-level `RESEND_API_KEY`; `--profile mail`
  selects that same key. Preserve named key set/status/delete operations through
  exact `MAIL_PROFILES` entries, retaining unrelated JSON settings and naming
  the missing setting and file before send or server startup.
- Ignore `.env.json` in the SDK checkout and newly scaffolded workspaces. Update
  the mail reference and purpose-gate report with the portable configuration
  contract and the reasons for each retained or removed operation.

## 0.18.0

- Adopt published `node-http-server` 10.0.0. PEM-backed development and
  packaged-preview HTTPS now negotiate HTTP/2 or HTTP/1.1 on the same port
  through the existing module integration, with no new runtime dependency.
- Document the returned `Http2SecureServer` for PEM-backed HTTPS. Preserve
  raw `tls` options on native `https.Server`, explicit HTTP development, the
  HTTP mail gateway, paired HTTP `308` redirects, source/PWA routes, complete
  responses, conditional caching, and owned listener shutdown.
- Adapt the shared synthetic TLS fixture to both native TLS constructors while
  retaining option capture and cleanup. The fixture models routing and option
  delegation; it does not establish a real TLS handshake or protocol negotiation.
- Report an occupied mail listener port clearly while retaining native
  `EADDRINUSE` details, the original cause, and the existing startup cleanup.

## 0.17.0

- Add neutral `modal.configure({dismissible})` configuration, defaulting to
  `true`. Setting it to `false` hides the close button and prevents Escape,
  backdrop and close-button dismissal while preserving the owner's existing
  programmatic close/destroy lifecycle and running-task behavior.
- Retain the configuration through population, open/close cycles and task
  completion. Keep focus within useful content when hiding a focused close
  control, and preserve default modal behavior for existing consumers.

## 0.16.3

- Remember browser-reported PWA installation in app-scoped DBOPFS and suppress
  the SDK's floating and inline installation controls on later visits. Capture
  native events immediately while restoring the saved flag; keep rendering,
  component loading and worker registration independent.
- Preserve confirmed installation across late reads, prompt results and display
  changes. Save installed-app launches as well as `appinstalled`, without
  mistaking prompt acceptance or ordinary fullscreen for installation. Expose
  initial storage readiness and complete persistence errors through the shared
  install owner, and retain confirmed-install writes through owner disposal.

## 0.16.2

- Scope explicit application selection and workspace resolution to the named
  app before reading its descriptor. An unrelated invalid descriptor no longer
  blocks that operation. Selected descriptors and unscoped discovery retain
  their existing validation. Named resolution reports only the selected app in
  `appIds`; unknown selections report the requested missing identifier without
  validating or listing unrelated apps.

## 0.16.1

- Remove raw script elements and inline event-handler attributes at the
  `markdown-document` insertion boundary, including nested template contents.
  Preserve literal fenced and inline code examples, formatting, navigation,
  and asynchronous document loading. This targeted reader correction does not
  provide a general-purpose HTML sanitizer or alter other Markdown consumers.

## 0.16.0

- Make mail hosting domain-based: use the current browser origin by default,
  preserve explicit endpoints, support any application name, and remove
  loopback-only binding and request admission. Keep exact configured CORS
  allowlists and recipient policy for To, Cc, and Bcc. Make the CLI sender
  override optional so reports and provider templates can supply their sender.
- Replace the local app-key and digest mechanism with optional
  `verifySubscription({appName, subscriptionKey, signal})` configuration.
  Verification is disabled until configured for the staged service setup.
  A configured verifier must accept each app and bearer key before provider
  delivery; rejection, service failure, and cancellation remain distinct.
- Remove redundant header reconstruction, address/origin rewriting, local
  provider payload and identifier grammars, duplicate setup, manual response
  length calculation, unused CLI queue options, and absent-observer work.
  Preserve complete provider fields and responses, idempotency, caller-selected
  deadlines, concurrent requests, and owned shutdown. Report observer and
  escaped handler failures without changing provider acceptance.
- Resolve subscription credentials from the current User at HTTP delivery,
  preserving explicit credentials and User replacement. Update mail references
  and include the method-by-method gate report.

## 0.15.2

- Rename the private mail configuration helper to `optionalTimeoutMs` so its
  name describes the optional timeout duration it validates. Preserve accepted
  values, defaults, and request lifecycle behavior.

## 0.15.1

- Use the published `node-http-server` public lifecycle for the mail gateway.
  Pass original requests and responses through its raw-request hook to the
  existing mail handler, preserving complete content, provider results,
  cancellation, and the returned native listener. Retain the disabled socket
  inactivity timeout and use the module's listener shutdown and malformed-client
  response handling.

## 0.15.0

- Add explicit `arcane dev --http` and source API `http:true` for HTTP
  development, including LAN device use. Reuse `node-http-server` and the same
  application, PWA, source-mapping and conditional-response routes without
  certificate setup. Report the actual HTTP endpoint and own one listener's
  readiness, cancellation, errors and shutdown.
- Preserve HTTPS and its HTTP `308` redirect as the default; packaged browser
  previews continue using HTTPS. Browser settings, certificate validation,
  application content and caching remain unchanged.

## 0.14.0

- Add opt-in `toolText: {name, field}` and `onToolText(text, call, displayId)`
  to model streaming requests. Decode the selected root string field as tool
  arguments arrive, separately from ordinary text and final tool execution.
  Preserve actual call identity, whitespace, ordered delivery, and cancellation
  across HTTP, native, and browser provider routes.
- Export `formatConversationClosingReportText(value)` so streamed closing text
  uses the same existing formatting as the complete report.

## 0.13.3

- Skip automatic TTS finalization calls when a model stream completes while
  muted. Preserve pending speech cleanup, unmuted flushing, explicit public
  speech methods, and model response callbacks across all streaming routes.

## 0.13.2

- Correct the PWA development guide to describe live descriptor refresh and
  remove the superseded restart instruction. Runtime behavior is unchanged.

## 0.13.1

- Refresh live development app membership from the current authored descriptor
  or package-only configuration. New explicit includes, exclusions, entry paths,
  and PWA settings take effect on the next relevant request without a server
  restart or writes to consumer projections.
- Generate PWA metadata and offline inventories from the same app snapshot.
  Coalesce concurrent metadata reads and inventory work within that snapshot,
  and keep older inventory completion from replacing newer metadata.

## 0.13.0

- Add the reusable `pwa-install.html` component and shared browser installation
  lifecycle through `arcane-os/pwa`. Offer a compact themed Install action and
  explicit Close, retain session dismissal, support inline placement, and surface
  native prompt errors without claiming installation completion.
- Mount the component from generated PWA bootstraps independently of service
  worker registration and application rendering. Use native installation and
  display-mode events without polling, automatic native prompts, or focus capture.
- Return cached resources immediately while conditional background refreshes
  are pending or in flight, so page requests do not wait on network revalidation.
- Document browser icon eligibility and the separate responsibilities of the
  Web App Manifest, application file selection, and offline resource inventory.

## 0.12.0

- Refresh the selected authored app descriptor's package projection before
  development startup, so file and PWA configuration changes take effect through
  the ordinary dev command without packaging.
- Use published `node-http-server` 9.1.1 for development and packaged-preview HTTPS
  serving, preserving source mounts and generated resource transformations.
  Supply modification dates for conditional GET and HEAD requests.
  Enforce HTTPS for every Arcane app, including localhost and packaged browser
  previews, using the configured workspace certificate pair or public TLS options.
  Redirect the paired HTTP listener with status 308 while preserving the request
  path and query; select its port with `httpPort` or CLI `--http-port`.
- Keep complete PWA resource responses across app and SDK version changes.
  Check on page load after 120 seconds in development or 15 minutes otherwise,
  with one DBOPFS timestamp updated only after the whole check succeeds. Reuse
  cached responses on `304`, replace them after a successful current response, and retain offline
  copies on network failures. No SDK cache expiration or polling is added.

## 0.11.3

- Require Wllama's model-context load result to report success before publishing
  model readiness. Failed initialization now follows the existing cleanup and
  error path instead of allowing conversation requests against a failed context.
  Preserve CPU and GPU selection, cached models, complete payloads, and cancellation.

## 0.11.2

- Show mobile speech feedback only during requested or active voice loading.
  Align pending local-model activation to the top of the chat area at viewport
  widths up to `44rem`. Preserve existing mobile controls, complete status and
  error data, desktop layout, and model lifecycle.

## 0.11.1

- Keep the shared Chat transcript, composer, speech controls, language selector,
  and timer hidden until the selected local language model is ready and loaded.
  Cloud routes remain visible immediately, and completed transcripts remain readable.

## 0.11.0

- Add explicit browser chat CPU selection with `loadDefaults:{gpuLayers:0}`
  or `load({gpuLayers:0})`. Use the packaged Wllama CPU path without WebGPU
  requirements or adapter initialization. Omission retains full GPU offload;
  model sources, cache, complete responses, streaming, and cancellation remain
  on their existing owners.
- On mobile browsers and tablets, keep shared Speech focused on voice output:
  hide and disable transcription activation and recording, omit transcription
  status/progress, and retain mute/unmute. Chat retains End. Desktop speech and
  the dedicated transcription component retain their existing behavior.

## 0.10.1

- Open developer error modals only for newly captured live incidents. Restoring
  pending diagnostics after navigation or reload continues scheduled delivery
  and retry without reopening old modals. Preserve complete stored incidents
  and the existing behavior for new errors.

## 0.10.0

- Add opt-in application PWA configuration, generated installation and offline
  manifests, a stable service worker and asynchronous registration bootstrap.
  Keep branding and offline resource selection application-owned.
- Expose `registerPwa()` and `PWA_STATE_EVENT` through `arcane-os/pwa`, with
  current-state replay, native update lifecycle, complete errors and disposal.
  Keep registration independent of rendering, preferences and model startup.
- Use clean local resource URLs for enabled PWA browser delivery. Remove `v`
  and `arcaneVersion` from actual references and managed import-map aliases,
  preserving meaningful queries, fragments and unrelated payloads. Dynamic
  HTML imports follow the same document-owned selection.
- Revalidate PWA source resources for live development and retain selected
  successful responses offline. Packaged output uses a separate cache generation
  for each deployment revision, bounded concurrent installation and normal
  browser activation. Preserve user data, model caches and native packaging.

## 0.9.0

- Add `getBrowserDeviceClass()` through the dependency-free
  `arcane-os/browser-device` entrypoint and managed browser import map. Return
  `mobile` or `desktop` from browser identity hints, including Android tablets
  and iPadOS Mac-platform touch identity, for application-owned settings.
- Keep classification independent of model imports, GPU requests, network,
  storage, listeners, and viewport changes. Missing or unrecognized identity
  defaults to `desktop`; the result does not claim hardware capability or
  model readiness, and existing provider defaults remain unchanged.

## 0.8.1

- Use `arcaneVersion` as the sole local resource version field across import maps,
  runtime materialization, source serving, packaged applications, and dynamic
  components. Remove `v` and duplicate version fields while preserving unrelated
  query parameters, fragments, and ordinary caching.
- Reuse the registered `html-import` constructor across module URL variants,
  including overlapping application startup and developer error-dialog imports.
  Prevent duplicate custom-element registration from raising `NotSupportedError`
  while preserving component loading, readiness, teardown, and existing instances.

## 0.8.0

- Add `removeBrowserSpeechModelCache()` to remove an explicitly retired Hugging
  Face speech model from the current browser origin's upstream cache. Preserve
  other models, voices, runtimes, DBOPFS artifacts, and preferences; report each
  completed removal and surface cancellation or partial failure.
- Keep model retirement policy in consuming applications. The operation starts
  no model download or inference and leaves NPU, GPU, and CPU selection unchanged.

## 0.7.3

- Correct public development serving for OPFS/DBOPFS and other browser APIs
  requiring a secure context. `npm run dev -- --app <id> --public` now serves
  HTTPS using a workspace-local development certificate pair, with explicit
  `--cert`/`--key` paths and `--https` available for any selected app.
- Add HTTPS transport to the shared development server and report the actual
  protocol in local and network URLs. Preserve ordinary HTTP localhost,
  selected source/runtime routes, refresh behavior, and owned cancellation.
- Document certificate setup and Android CA installation. Keep TLS material
  out of operation events and report missing certificates before binding.
- Clarify the browser accelerator setup instruction to close and reopen the
  browser after changing a flag, with that final step underlined and emphasized.

## 0.7.2

- Keep both supported browser NPU and GPU flag address copy controls available
  regardless of API availability, GPU classification, or detection failure.
  Use one short explanation per flag and one shared paste/enable/relaunch
  instruction. Preserve browser-reported statuses and the GPU-only chat notice.

## 0.7.1

- Make Profile NPU and GPU setup concise and copy-only, with **Copy NPU flag
  address** as the NPU action. Confirm a reported discrete GPU with **Already
  using the performance GPU.** and show GPU setup only for explicitly reported
  integrated or software adapters. Unknown GPU classes receive no flag advice.
- Retain the loaded Wllama Worker's adapter details for the GPU-only chat alert.
  Show that alert only for an explicitly reported integrated or software adapter,
  with manual browser-address instructions and no attempted navigation.
- Preserve complete adapter descriptions and optional class/fallback metadata
  through the Wllama projection. Remove obsolete projection identity gates.
- Forward speech artifact and upstream model loading progress through sticky AI
  state. Show the current file, completed files, elapsed time, and initialization
  in both transcription controls, with indeterminate progress for unknown totals.
  Preserve cancellation, complete diagnostics, models, and inference precision.

## 0.7.0

- Add `arcane dev --public`, including forwarding through
  `npm run dev -- --app <id> --public`, to bind the selected app's existing
  source server to all IPv4 interfaces. Keep the ordinary localhost default
  and let an explicit `--host` select the bind address.
- Allow explicit network hosts in the shared development server. Report usable
  local and network application URLs, including `networkUrls` in server results
  and lifecycle events, while preserving selected routes and cancellation.
- Document LAN use and the browser HTTPS requirement for features that need a
  secure context. No app-specific server, firewall rule, or tunnel is added.

## 0.6.2

- Replace browser NPU setup buttons with direct browser-specific flags links
  and retain copy-address controls and the public `open()` method.
- Add the missing GPU performance flags link, setup instructions, and GPU
  detection control. Chrome uses its own `chrome://` flags address.
- Show adapter availability and its reported name after one shared detection
  request. Keep fallback and failed detection visible without claiming that
  the browser performance flag is enabled or a model is running on that GPU.
  Detection creates no device, loads no model, and changes no browser settings.

## 0.6.1

- Add a reusable profile component for browser NPU setup and WebNN/WebGPU API
  availability. Its setup button uses the existing GPU guidance approach:
  attempt the appropriate Chrome or Edge flags page, then show an alert with
  instructions and the address to paste if the browser blocks navigation.
- Share browser identification and the flags-opening helper with the existing
  high-performance GPU notice. Preserve that notice's targets and wording.
  Setup does not change saved preferences, browser flags, selected models, or
  inference; API availability is not reported as physical NPU execution.

## 0.6.0

- Prefer WebNN NPU, then WebGPU, then CPU through WASM for browser Whisper
  transcription and Kokoro synthesis. Skip absent accelerator APIs and replace
  failed model-load Workers before trying the next backend with the same
  application-selected model and precision.
- Add Whisper execution configuration and NPU selection for both speech roles.
  Explicit `webnn-npu`, `webgpu`, and `wasm` choices report failure without
  falling back. Whisper retains one slot; Kokoro retains four by default and
  accepts capacities from one through four.
- Report requested and successfully selected backends for both roles through
  provider execution status. Selection reports upstream session loading;
  actual accelerator use and speech quality depend on the selected runtime,
  model, browser, drivers, and hardware. Wllama remains on its WebGPU backend.

## 0.5.19

- Report observed Wllama initialization stages and runtime activity through
  direct provider loading and the shared AI lifecycle. Keep initialization
  indeterminate when the runtime supplies no meaningful completion total.
- Show the current initialization stage, stage duration, and time since runtime
  activity in shared chat instead of a completed file count during activation.
  Preserve download progress, cancellation, and complete runtime logging.
- Remove an adjacent duplicate cancellation check while retaining cancellation
  handling before initialization and after loading.

## 0.5.18

- Use `strong-type` predicates throughout SDK-owned toolchain, runtime,
  browser-provider, and component code while retaining existing defaults,
  domain rules, public errors, and nominal constructor behavior. Align the
  direct dependency and both shipped projections at `strong-type` 2.0.1,
  replacing the portable runtime's 1.1.0 snapshot and avoiding Error allocation
  for ordinary false predicates. Keep managed browser imports and Node reference
  loading on the same declared dependency.
- Remove `AIResponseLength` exports; applications own response verbosity.
  Parse URL-audit HTML with the native HTML parser.

- Add `AI.prepareTTS()` for detached punctuation-segmented synthesis, optional
  DBOPFS audio storage, complete semantic-input reuse, shared pending work and
  independent preparation cancellation. Persist MIME metadata with each audio
  segment and retain successful segments after interruption or partial failure.
- Add `AI.playPreparedTTS()` to replay prepared or pending audio through the
  existing audio-clock scheduler. Playback has its own completion, pause,
  resume, stop, state and error surface; stopping playback keeps detached
  preparation alive. Cached audio plays without loading a speech model.
- Keep Markdown cleanup at its shared owner, preserve the existing TTS APIs,
  and share provider capacity across preparation requests. Applications own
  content grouping, storage keys, preparation order and retention policy.

## 0.5.17

- Restore the public `SPEECH_VOICE_OPTIONS` ordered records and
  `SPEECH_VOICE_ALIASES` membership set used by existing speech controls. Both
  remain ordinary mutable compatibility values, and `SpeechPlayback` does not
  select a voice from them automatically.
- Restore the optional `SpeechPlayback` constructor `onState(detail)` callback.
  Canonical state dispatch remains first; callback failures are reported
  without replacing playback settlement. Preserve capability-gated eager
  submission, the provider-owned default capacity of four, indexed playback
  order, native/custom serialization, cancellation, and Replay behavior.
- Apply the shared repeated-formatting-mark cleanup automatically to every TTS
  entry path, including direct fetch, provider-runtime synthesis, browser
  Kokoro requests, streaming chunks, and `SpeechPlayback`. Export the shared
  `MarkdownSpeech` and `stripSpeechFormatting()` owner from
  `arcane-os/speech-text`; keep original caller records unchanged and use
  operation-local SDK metadata to prevent a second cleanup pass. No application
  option is required, and the prior `textFormat` extra no longer disables or
  selects cleanup.

## 0.5.16

- Add optional Markdown narration filtering before `AI.streamTTS()`
  segmentation. Omit repeated same formatting marks across streamed chunks,
  preserve single marks and ordinary punctuation, and clear formatting state
  on terminal flush or cancellation. Keep plain speech, displayed and stored
  text, language, voice, synthesis capacity, and audio scheduling unchanged.
- Select Markdown narration in shared chat and include focused filter test
  source without adding a parser dependency.

## 0.5.15

- Let `SpeechPlayback.prepare()` submit every complete segment immediately when
  an `AI.fetchTTS` client advertises positive TTS execution capacity. The AI
  provider queue retains bounded FIFO admission (four synthesis slots by
  default), while indexed Blob URLs keep playback in exact input order even
  when later segments finish first.
- Preserve the serialized one-segment-lookahead path for native and custom
  speech clients that do not advertise provider execution capacity. Pause and
  Resume keep the same audio element; Stop aborts all owned synthesis; Replay
  retains completed and pending provider segments while retrying only failed
  missing segments, including failures with falsy rejection values.
- Add basic copyable `SpeechPlayback` examples and synchronize the installed
  reference, current release identities, generated documentation site, and
  focused behavioral contract source for the new admission model.

## 0.5.14

- Add the shared `arcane-os/logging` console owner using the existing
  `user.developer` preference. Route first-party runtime diagnostics and
  default model loggers through this owner; preserve warnings and errors
  when developer mode is disabled.
- Trace complete speech API inputs, generation queues, Worker requests and
  responses, decoded audio, scheduled playback, natural completion,
  cancellation, and failure under that same developer preference. Preserve
  caller text, voice, speed, language selection, and playback behavior.
- Preserve complete cloud AI error responses and retry HTTP 429 overload
  responses after three seconds with the original request and cancellation
  signal. Keep partial streams and tool callbacks outside the retry path.
- Preserve exact URL import-map aliases while adding matching versioned
  aliases, including authored imports, scopes, and generated dependency paths.

## 0.5.13

- Derive local browser resource queries from the selected SDK package version
  across managed import maps, runtime materialization, source serving and
  packaged application resource graphs. Preserve existing query parameters,
  fragments and ordinary caching; revalidate entry documents on navigation.
- Carry component and Worker module references through the same versioned
  paths. Preserve fetched document/attachment content, CSS comments and text,
  remote URLs, model data and user storage. Existing open documents adopt the
  new resource graph on ordinary refresh or navigation, without a forced reload.

## 0.5.12

- Add optional `voice`, `speed`, `pauseAfterMs`, and `waitForPlayback` fields to
  `AI.streamTTS(text, end, options)`. Complete passages can enter the existing
  segmented generation queue immediately, retain their authored pauses on the
  audio clock, and await their own playback completion. Existing calls still
  return after preparation; stop and terminal failure settle playback waits
  as `false`, while autoplay permission waiting remains pending.
- Restore `AI.fetch(...)` and `AI.streamMessage(...)` after their unintended
  removal during source cleanup. Their existing signatures, callbacks, return
  behavior, and private inference plumbing remain available alongside
  `fetchRequest({...})` and `streamRequest({...})`; callers do not need to
  migrate. Restore chat-memory callers and document both public forms as
  sharing the current provider implementations.
- Update maintained SDK references and their generated pages, omit obsolete
  provider context-token guidance, and describe current native defaults and
  Winlogon bindings without treating them
  as retired SDK APIs. Native Core implementations and upstream dependencies
  are not changed by this SDK cleanup.

## 0.5.11

- Default browser Kokoro TTS to four concurrent synthesis slots in both the
  high-level AI configuration and direct provider. Explicit capacities 1–4
  remain supported; LLM and Whisper/STT capacity remains one. Overflow waits
  in the provider-neutral FIFO queue, and playback retains exact input order
  with contiguous AudioContext scheduling. Each slot owns a Worker/model
  session, trading memory for latency without promising physical GPU overlap.
- Add opt-in live execution details through
  `ai.providerRuntime.status('tts', {execution: true}).execution`, including
  requested and selected device, capacity, and active requests. Existing
  no-option status snapshots keep their behavior; automatic WASM fallback is
  observable without private provider access.
- Front-load basic browser speech and TWiN examples, document exact saved
  preference migration, refresh current reference inventories and generated
  site content, and include maintained `docs/` and the browser AI demo source
  in the installed package. Documentation deployment now uses an explicit
  selected-main Pages workflow.

## 0.5.10

- Show one Windows performance-GPU flag advisory for the current Chromium
  browser, including Edge, Brave, Opera, and Vivaldi. Browsers that conceal
  their identity use their own flags page through the generic `about://` address.
- Make the notice conditional on having multiple GPUs, cover every observed
  GPU vendor, and omit the notice on Firefox, Safari, mobile, and non-Windows
  platforms. No additional GPU flags or automatic settings changes are included.

## 0.5.9

- Renamed the built-in TWiN Cloud provider and default-model preference sentinel
  to `TWIN`. Applications must explicitly update saved `OPENAI` LLM selections;
  the SDK does not alias the old identifier or rewrite persisted preferences.
  Real upstream model names, wire behavior, and on-device speech remain intact.
- Restored immediate streamed-speech synthesis admission with bounded,
  provider-declared TTS concurrency and FIFO overflow while retaining exact
  chunk text, cancellation, lifecycle ownership, and original playback order.
- Added a bounded Kokoro Worker/model-session pool with GPU-first WebGPU loading,
  explicit WebGPU or WASM selection, and an honest automatic WASM fallback that
  preserves the caller-selected model, dtype, and voice.
- Scheduled each contiguous ready audio buffer directly after its predecessor
  on the `AudioContext` clock, removing callback-added stitching gaps without
  trimming, crossfading, resampling, merging, or rewriting speech content.

## 0.5.8

- Added provider-neutral `reasoningEffort` to `AI.fetchRequest()` and
  `AI.streamRequest()`, accepting `none`, `low`, `medium`, `high`, or
  `max`. TWiN Cloud forwards an explicit value as `reasoning_effort`, omits
  the field when unspecified, and preserves explicit
  `openai-gpt-oss-120b` or `openai-gpt-oss-20b` model selection with the
  existing streaming and structural-tool behavior.

## 0.5.7

- Added `PersistentAIChatSession.open()` for model-authored conversation
  openings. Its application-authored bootstrap remains transient, while the
  complete nonblank assistant response is committed atomically as durable
  assistant-only chat history and survives maintenance and reload.

## 0.5.6

- Sanitized newly persisted chat history into complete human-readable user,
  assistant, and public tool-result records without storing internal prompts,
  provider envelopes, raw tool protocol fields, or hidden request metadata.
  Existing stored rows remain untouched.
- Made `persist: false` turn-scoped: the request can use the complete temporary
  turn, then retains neither side in model history, memory, DBOPFS, nor the Chat
  transcript after the operation settles.

## 0.5.5

- Added configurable complete text-to-speech stream segmentation through
  `AI.configureTTSSegmentation()`. Applications can speak on Unicode punctuation
  or a whole-word cadence without discarding any text, while apostrophes,
  commas, and hyphens that join Unicode letters or numbers remain intact.
  Synthesis and playback stay sequential, and mute or cancellation still stops
  the complete queue.

## 0.5.4

- Reduced Browser-WASM HTTP Range parts from roughly 128 MB to roughly 4 MB
  and raised the deterministic part ceiling, so a refresh re-fetches only the
  small in-flight parts while every completed part remains reusable. An
  incomplete 0.5.3 cache keeps its completed legacy parts and subdivides only
  the missing legacy intervals, preserving existing progress during adoption.
- Kept all built-in audio processing on device: Whisper owns transcription and
  Kokoro owns speech synthesis. Legacy OpenAI audio selections migrate to those
  local routes, non-local speech configurations are rejected, and the retired
  OpenAI audio credential and endpoints are no longer used.

## 0.5.3

- Preserved every independently completed Browser-WASM HTTP Range part and
  split GGUF member when a sibling transfer fails, so a retry restores prior
  progress and requests only the missing work instead of restarting all active
  transfers.

## 0.5.2

- Forwarded each application's existing managed browser import map into
  isolated `arcane test` and `arcane check` files so valid `arcane/*` imports
  resolve from the selected workspace runtime while integrated-legacy apps
  retain their established no-map path.

## 0.5.1

- Separated the TWiN Cloud LLM access key from the legacy OpenAI speech
  credential so neither provider's key is sent to the other's endpoint while
  retaining the established `ai.license` alias for TWiN Cloud chat.

## 0.5.0

- Added bounded parallel Browser-WASM model downloads across split GGUF
  members and resumable HTTP Range parts while preserving descriptor order and
  the configured transfer limit.
- Added retry pickup for completed shards and Range parts, with transparent
  fallback to one full fetch when a source does not support usable ranges.
- Added determinate aggregate download progress with transferred and remaining
  data, live speed, approximate time remaining, active transfers, and transfer
  mode.
- Reused complete same-model legacy cache entries in preference to incomplete
  replacements and removed redundant legacy files and completed fragments when
  cleanup succeeds.
- Replaced the default remote LLM destination and model with TWiN Cloud at the
  OpenAI-compatible DigitalOcean inference endpoint, added the TWiN access-key
  configuration surface, and retained the prior route and credential names as
  compatibility aliases.

## 0.4.2

- Added transparent Browser-WASM model loading status across cache checks,
  ordered model-file downloads, and WebGPU initialization, including file
  counts, elapsed time, and five-second heartbeats so long downloads remain
  visibly active without byte-based progress.

## 0.4.1

- Preserved complete DirectoryPicker titles, paths, caller options, and
  provider result fields without application clipping, trimming, freezing, or
  generic path-character policy while retaining selected/cancelled semantics
  and provider-owned path failures.

## 0.4.0

- Preserved complete finite provider progress values and units as
  informational state, including fractional and out-of-range observations,
  while keeping the visual percentage bounded and exposing ARIA range values
  only when the reported range is valid.
- Preserved complete file selections, timelines, relationship graphs, source
  content, message advisories, record passages, and date findings without
  arbitrary count or character clipping, and surfaced malformed stored-review
  data instead of silently replacing it.
- Made workspace and scam-policy hardening explicitly opt in, with ordinary
  complete workspace inputs and `secure:false` scam analysis remaining fully
  functional without restrictive policy admission or frozen results.
- Removed the product-owned `CaseEvidenceIndexer.js` module and
  `TWiNPolicyDecision.js` entity from the shared runtime payload and generated
  browser import map so application policy remains owned by each consumer.

- Removed the unused `RevocableProjectionLedger.js` runtime artifact and its
  public contract. No authored SDK or Arcane OS application source consumes it,
  and its mandatory capacity, character, UTF-8 byte, and node budgets,
  fingerprinting, freezing, and pristine-descriptor admission conflict with the
  ordinary functional baseline.

## 0.3.6

- Replaced coherent selected-but-unregistered STT and TTS placeholders during
  initial explicit browser-speech configuration while preserving rejection of
  registered, busy, local-only, or internally divergent selections and keeping
  the new providers unloaded until the application activates them.
- Preserved complete finite provider progress values and units as
  informational, non-gating state in the reusable formatter and shared Chat
  activation interface.

## 0.3.5

- Preserved complete AI and chat runtime content across multi-choice streaming,
  parallel tool calls, terminal values, transcripts, progress, incidents, and
  saved JSONL records without ordinary truncation, freezing, or silent loss.
- Initialized AI from the canonical ready user even when a compatibility event
  carries a different user projection, including an immediate readiness recheck
  after listener registration.
- Preserved shared chat, speech, and voice-transcription lifecycle across
  persisted page-cache navigation, including transcript restoration, retry and
  cancellation ownership, and terminal cleanup on ordinary unload.

## 0.3.4

- Allowed external and integrated physical SDK workspaces to omit the optional
  `security` runtime route while preserving the canonical functional route
  order, `dependencies` and `sdk` projections, external license routing, and
  compatibility with workspaces that still include `security`.
- Preserved a newer microphone retry's press, status, and operation identity
  when an earlier pending capture request settles, while retaining the original
  operation correlation for successful transcription.

## 0.3.3

- Corrected installed-workspace import-map refresh to preserve rich browser
  document inspection records while passing only navigable document paths to
  the public generator, including `.html` and `.htm` pages without modifying
  HTML fragments.
- Restored one semantic `arcane.lock.json` contract across scaffold, init, and
  installed runtime materialization, replacing stale versions with the exact
  installed package version and npm-alias roots without byte or security
  metadata.
- Added selected installed-package coverage for stale-lock replacement and the
  public multi-document import-map command through the packed npm artifact.

## 0.3.2

- Preserved complete application, document, model, message, event, process,
  mail, and diagnostic content across the ordinary SDK runtime and tooling.
- Removed ordinary byte, hash, digest, receipt, provenance, exact-inventory,
  truncation, clipping, freeze, and unapproved hardening gates while retaining
  unavoidable transport framing and credential protection at their owners.
- Added the complete browser-WASM chat, speech, persistence, structural-tool,
  source-example serving, descriptor, packaging, and application-test contracts
  required by SDK consumers, with optional security remaining opt-in.
- Limited the npm package to consumer runtime, source, schema, CLI/tooling, and
  required root metadata; examples, documentation, generated site output, and
  tests remain repository-owned follow-up surfaces outside the published package.

## 0.3.1

- Restored ordinary warn-first Browser Speech operation with explicit
  `secure:false` defaults, one concise load warning, and truthful
  `unchecked`/`pending`/`verified`/`failed` integrity telemetry while keeping
  strict authenticated-graph admission behind explicit `secure:true`.
- Added atomic hydration for exact saved-but-unregistered STT/TTS selections
  without a transient provider fallback, including independent mixed
  browser/Cloud/Core role ownership and mismatch-safe rollback.
- Continued to resolve speech runtimes, models, voices, and providers from
  their upstream npm/fetch distribution paths; the SDK package redistributes
  none of those third-party payloads or their legal corpora.

## 0.3.0

- Added the branded, versioned, per-realm `globalThis.arcaneEvents` authority
  and moved SDK semantic publishers onto one event-pubsub-backed source while
  retaining bounded legacy EventTarget and DOM projections.
- Added independent Browser Speech STT/TTS provider ownership with initial or
  later role-scoped replacement, mixed Cloud/Core/browser routes, explicit
  lifecycle, and no omitted-role unload, mute, disposal, or state clobbering.
- Made Browser Speech warn-first by default: applications select version-pinned
  upstream runtime/model/voice downloads and browser cache behavior, while
  `secure:true` remains the explicit strict authenticated-graph option.
- Added the portable `arcane-os/mail` API, durable DBOPFS-compatible outbox,
  secure local Resend gateway and CLI, event-owned reconnect drain, bounded
  retries, cancellation, cleanup, and provider-acceptance evidence.
- Kept speech runtimes, model and voice bytes, third-party legal/notice files,
  and corresponding-source archives out of the SDK package and release assets.

## 0.2.3

- Made shared voice transcription consume authoritative sticky STT state,
  expose explicit selected-unloaded activation, and keep recording disabled
  until the selected route is genuinely ready and non-busy.
- Added owned cancellation and current-operation guards across microphone
  permission, recording, transcription, save, completion, transcript
  replacement, synchronous public events, teardown, and stale settlement.
- Centralized the shared STT activation control in
  `createSTTActivationController()` without automatic downloads, hidden
  provider selection, or application policy.

## 0.2.2

- Corrected latest-request-wins ownership so each newly admitted AI request
  aborts and settles the prior provider operation, revalidates role readiness,
  and prevents stale results from restoring superseded state.
- Made speech startup and controls explicitly lifecycle-owned: STT startup is
  opt-in, selected-unloaded STT exposes user activation and cancellation,
  caller abort reaches shared transcription, and TTS mute/unmute owns its load,
  cancellation, playback, and unload sequence.
- Kept positive speech readiness bound to admitted sticky provider state while
  exposing truthful capability-only legacy OpenAI, Ollama, and Core speech
  routes without downloads, hidden provider selection, model authority, or
  fallback.
- Preserved the existing shared Blob/File STT and WAV TTS request shapes at the
  browser-provider boundary, with explicit decode/format errors and
  provider/model-owned TTS voice defaults.

## 0.2.1

- Added explicit selected-unloaded chat activation, truthful legacy Cloud/Core
  route readiness, and provider-native chat-response normalization without
  startup downloads, hidden provider selection, or application policy.
- Normalized shared STT/TTS requests at the browser-speech provider boundary
  while retaining caller-supplied immutable runtime, model, and voice
  authorities and fail-closed format, lifecycle, error, and cancellation rules.
- Applied authenticated dependency import maps to every packaged browser
  document and published a deterministic browser-readable runtime projection
  inventory derived from the verified package receipt.
- Added caller-budgeted complete DBOPFS source evaluation with deterministic
  zero-score fallback, independent scoring/excerpt/output bounds, and opt-in
  preserve-readable bootstrap/evaluation read coverage.
- Bound external workspace validation, packaging, scaffolding, doctor,
  toolchain, and development serving to one authenticated installed package,
  including the exact `arcane-sdk@npm:arcane-os@0.2.1` alias form.

## 0.2.0

- Made the SDK the canonical owner of the portable Arcane runtime and retired
  the Arcane OS-to-SDK overwrite direction while retaining legacy provenance in
  the authenticated runtime receipt.
- Added app-supplied monolithic or ordered multi-file GGUF catalogs, DBOPFS
  manifest-last admission, inherited per-check security policy, and measured
  per-model capability reports for the browser-WASM Wllama provider.
- Added independent browser Whisper STT and Kokoro TTS provider/Worker
  machinery with caller-supplied runtime/model authorities, explicit lifecycle,
  progress, cancellation, unload, and no fallback or packaged model bytes.
- Added schema-driven DBOPFS document bootstrap, minimal lexical retrieval and
  explicit request-context composition without automatic corpus searches.
- Added automatic persistent chat/history/memory composition, recurring model
  context, structural tool-call continuity, and session-only turns through
  `persist:false`.

## 0.1.0-dev.4

- Added the central `event-pubsub`-backed `EventManager` as the preferred SDK
  instrumentation route, with exact dependency pins, public package exports,
  and versioned `arcane-event-stack/1` JSON records.
- Added opt-in time-travel recording with UTC and monotonic time, nested
  causation, bounded snapshots and history, off-by-default sanitized source
  stacks, redaction, strict export/import, seek, abortable speed-controlled
  review playback, visible overflow, and explicit terminal outcomes.
- Added optional capture-phase DOM interaction and mutation observation across
  supported open shadow roots, with composed-event deduplication, sensitive
  input handling, and an explicit safe-review boundary that does not claim live
  DOM restoration or privileged-effect replay.
- Mirrored owned SDK operation-queue events through the central manager exactly
  once without weakening awaited delivery, backpressure, cancellation, or
  callback-failure ownership.
- Synchronized the browser runtime to Arcane OS `0.8.12` commit
  `567ad110bf57a1c2d4a3daa22ae93716cc5f4d7e`, including the shared network
  policy modules and policy data required by standalone applications.
- Added an explicit, main-checkout-only runtime synchronization tool and moved
  upstream runtime provenance into a reviewable source configuration.
- Added `security` to the external and integrated browser-runtime route contract.
- Made the project-local npm package the canonical SDK distribution and added a
  canonical manifest, checksum, SHA-256, and npm integrity contract for one
  exact packed tarball.
- Added build-once release readiness that runs the downloaded tarball through
  the installed Vanilla Test lifecycle and `npm exec --offline -- arcane` on
  Windows x64, Linux x64, and a real macOS arm64 runner at the declared Node
  `22.23.2` floor with a fresh per-job npm cache. Older Node 22 builds are not
  claimed because native Windows file-identity metadata is inconsistent there.
- Changed development publication to consume the immutable matrix-tested
  tarball instead of repacking source; the first npm publication remains an
  explicit 2FA bootstrap blocker before trusted publishing can be configured.
  Publication now requires an explicit standard-versus-dual-use policy decision,
  fails closed when staged dual-use publishing is required, serializes
  dispatches, rejects rollback and byte mismatches, and safely resumes through
  npm publish-time scanning without republishing an immutable version.

## 0.1.0-dev.3

- Added an authored-descriptor-only external app release envelope with an exact
  `ARCANE_APP_BUNDLE.json` contract and deterministic USTAR+gzip bytes.
- Bound the canonical schema-2 descriptor, its schema-1 package projection,
  the verified release manifest, and every payload file into one independently
  verifiable archive without adding repository-only source or tooling beyond the
  app-owned, authenticated release inventory.
- Added dependency-free streaming bundle creation and one-pass verification
  with explicit compressed, expanded, entry, file, control-document, path, and
  expansion-ratio ceilings plus fail-closed hostile tar and gzip handling.
- Hardened exact-length control, payload, and artifact reads with EOF growth
  probes, final pathname/handle identity checks, and single-link enforcement;
  concatenated gzip members and appended bytes now fail closed.
- Added create-only link promotion, explicit literal-boolean overwrite with
  create-only backup/restore, and rollback bound to the respective full
  recorded identity tuples of both promoted output and prior backup, pinned by
  open handles. Changed outputs preserve their backup, while a changed or
  missing backup preserves the valid promoted output; added digest revalidation,
  nonce-bound inspectable locks, surfaced cleanup degradation,
  safe cancellation, progress events, root SDK and toolchain APIs, and
  `arcane bundle` / `arcane verify-bundle` commands.
- Defined NFC UTF-8 byte ordering for package and bundle inventories, pinned a
  deterministic golden bundle digest to the supported Node/runner matrix,
  rejected zero-byte releases, rejected case/prefix topology conflicts and the
  complete portable Windows device-name set, and made SDK-generation
  compatibility explicit.
- Added complete receipt metadata for artifact digest/bytes; descriptor
  canonical, file, and package digests/bytes; and release manifest, policy,
  content, file-count, and payload-byte identities.
- Added a reusable exact-SDK app release workflow with immutable action pins,
  unprivileged caller-code build/upload, an always-run fresh post-upload verifier
  that becomes the sole output source, and a conditional attestation job that
  redownloads the same artifact id and compares every verified identity. The
  privileged job uses supported Node 24 via the pinned `actions/setup-node`
  revision and directly imports the dependency-free immutable SDK verifier
  without package resolution or caller code; it retains no implicit npm,
  GitHub Release, or Arcane-admission authority.
- Added the bundle schema, canonical test-set ownership, packed-SDK end-to-end
  coverage, deterministic repetition tests, and adversarial archive fixtures.

## 0.1.0-dev.2

- Kept prerelease development, integration, publication evidence, and
  documentation on canonical `main`; the `dev` work branch remains deferred
  until the first official SDK release.
- Migrated the SDK and generated application test runner to exact
  `vanilla-test` 2.1.3 while preserving isolated files, cleanup, nested cases,
  timeouts, cancellation, and nonzero failure status.
- Organized the SDK suite into non-overlapping unit, functional, integration,
  and regression sets, with smaller visible cases that reuse their existing
  fixture and process boundaries.
- Synchronized the bundled browser runtime with Arcane OS 0.8.12 and retained
  its exact 149-file source inventory.
- Added an integrated-only shared/Core development scope that runs one exact
  focused Arcane test or Arcane's canonical development check through a fixed,
  generation-bound provider without packaging an app.
- Added fixed provider pairing and canonical target requests for Linux ARM64
  DEB and development-signed Android ARM64 APK builds while preserving the
  existing browser, portable, Windows x64, and Linux x64 workflows.
- Made integrated app testing select only the chosen app's test tree while
  external repositories continue to run their root and selected-app tests.
- Bound shared provider execution to one owned process tree per checkout in an
  SDK process, with immediate acknowledgement, cancellation, busy rejection,
  mutation detection, and surfaced failure.

## 0.1.0-dev.1

- Synchronized the bundled browser runtime with Arcane OS 0.8.11 and pinned
  its exact upstream source and content inventory.
- Added explicit `--arcane-root` portable provider pairing, native doctor and
  prepare commands, and verified single-app portable Core directory builds.
- Added real Windows x64 EXE-bundle and Linux x64 DEB providers for unsigned
  local development, including same-process verified launch and owned
  cancellation. Android and ARM64 remain deferred.
- Bound paired providers to one immutable module generation, retained and reused
  one shared-payload snapshot across an app dependency closure, and bound the
  canonical app descriptor to the verified release receipt.
- Bound native plans to the exact schema-2 package policy and SDK-authenticated
  release readers, made each plan single-attempt, and reject incompatible Core
  versions, protocols, features, capabilities, and methods before build while
  accepting newer compatible Arcane versions.
- Added `new` and `init --target portable` scaffolding with the required raster
  icon, browser-plus-portable target intent, and generated portable guidance.
- Refuse unknown portable output collisions and authenticate an exact prior
  Arcane artifact before replacement.
- Fixed the generated app test so newly scaffolded repositories execute their
  theme and package identity checks successfully.

## 0.1.0-dev.0

- Added the first external-repository Arcane OS SDK and `arcane` CLI.
- Added external and integrated workspace profiles so the same operations can
  use either the pinned SDK runtime or the live Arcane checkout runtime.
- Added canonical schema-2 `arcane-app.json` descriptors with exact schema-1
  package and native-registry compatibility projections.
- Added integrated `arcane init` scaffolding that writes only app-owned files
  and preserves every Arcane root package, workflow, lock, and instruction file.
- Added app scaffolding, environment diagnostics, browser development, focused tests, validation, deterministic packaging, and package verification.
- Added a platform-neutral target adapter contract with an available browser target and explicit deferred Windows, Linux, and Android native targets.
- Added a process-local native provider pairing lifecycle for doctor, caller-owned
  preparation, immutable planning, verified build, artifact verification, and
  receipt-bound run without changing the default deferred target registry.
- Tightened the public app-descriptor schema to match native raster-icon,
  embedding-capability, browser frame-origin, and conflicting-capability rules.
- Added fixed Git status, fast-forward pull, and push operations for future Arcane Developer control-panel use.
- Added a durable local `.tgz` development install path while retaining exact installed SDK and runtime identity checks.
- Added preflight package conflict detection for `arcane init` and a two-pass template path preflight to avoid predictable partial scaffolds.
- Added Arcane OS license files to every browser release and complete bundled Marked and QRCode.js MIT notices.
- Changed generated CI to use the committed dependency lock through `npm ci`.
- Added exact-tree runtime receipts, bounded verified response snapshots, and serialized event ownership with process backpressure.
- Preserved the pinned runtime as byte-exact Git content so clean Windows and Linux checkouts authenticate the same receipt.
- Added the linked Arcane OS SDK README banner, explanatory subheader, and direct GitHub repository navigation.
- Added the Arcane-themed GitHub Pages project site with an accessible space-motion system, current CLI guidance, target truth table, and direct repository navigation.
