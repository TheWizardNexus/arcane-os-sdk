# Clean browser resource URLs

The SDK's managed import maps, source server and application packager use clean
local resource URLs for PWA, non-PWA and native delivery. Their shared
transformation removes the SDK-owned `arcaneVersion` field. It never appends a
release version to those URLs. Enabled [PWA delivery](pwa.md) records the
application and SDK versions in its generated offline manifest and worker.

For example,
`./node_modules/arcane-os/runtime/arcane/modules/HTMLImport.js?v=6&arcaneVersion=0.51.1#module`
becomes
`./node_modules/arcane-os/runtime/arcane/modules/HTMLImport.js?v=6#module`.
Every SDK-owned field is removed, including duplicate and encoded spellings.
Authored fields, including `v`, encoded keys and values, repeated or empty query
segments, their source spelling, and fragments remain intact. Remote URLs and
fragment-only references retain their existing value.

## Public tooling

- Run the installed SDK's `materializeInstalledSdkRuntime()` to refresh the
  physical workspace runtime from that installation. It copies the complete
  selected runtime; direct installed-package workspaces read their npm routes
  without requiring this copy.
- Run `arcane import-map` through the installed SDK to regenerate the managed
  import map and its application HTML. Named SDK imports and URL-shaped module
  entries point to the selected clean resource URLs.
- `arcane dev` applies the same reference transformation to served source
  without editing the source files. An explicit live SDK source mount changes
  the source of those resources. PWA release metadata still identifies the
  selected source or installed SDK version.
- The application packager applies the clean-URL transformation after its
  selected adapter finishes. The resulting application can be served by an ordinary
  static host without a JavaScript transformation service.

The shared transformation edits actual local module imports, resource URL
construction, HTML resource attributes and CSS resource references. It does not
change displayed text, prompts, application data, downloaded model content,
remote provider URLs, or arbitrary strings that happen to resemble filenames.
Worker entry references and their local module imports are handled at their
own resource boundaries because workers do not inherit a document's import map.
`HTMLImport` removes the SDK-owned field from same-origin component resource
references and resolves SDK component resources from the component's actual
runtime root, including direct installed-package paths.

Computed application URLs that have no statically identifiable resource
reference remain application-owned expressions. The SDK does not intercept
global `fetch`, `URL`, `Worker`, or DOM APIs. An import-map URL entry can resolve
an exact matching computed module URL, but is not a wildcard query rule.

## Navigation and caching

The SDK server sends `Cache-Control: no-cache` for application entry/managed
HTML and managed import-map JSON. This allows storage but requests revalidation, so an ordinary navigation
or refresh obtains the current entry document and clean resource URLs. Other assets
retain ordinary caching; no cache or user storage is cleared.

For PWA delivery the SDK server revalidates all served resources, including
the stable worker script. A static host serving a PWA package must likewise
revalidate stable resource URLs. The service worker maintains its own selected
offline resource cache independently of the HTTP cache.

An independently configured static host must likewise revalidate entry HTML
and managed import-map JSON, and set resource caching appropriate to its delivery
workflow. The generated package supplies clean resource references; it cannot
configure another server's HTTP headers.

An already-open document keeps modules it has evaluated. Changed files become
available through ordinary navigation and cache revalidation; they do not replace
live module instances, force a reload, restart a model, or erase a conversation. The SDK does
not retain earlier installed runtime trees after materialization.

`HTMLImport` registers its element once per browser custom-element registry.
Previously authored revision URLs and the developer error dialog's module URL
can be different; each import exports the constructor already registered in that
document. Repeated imports do not replace existing component instances or
register a second `html-import` definition.

## Scope and work

One invocation acts on the selected workspace/application. Runtime
materialization reuses its existing recursive copy; packaging reuses its
selected output inventory. Packaging follows resource references from the entry,
managed application pages and SDK runtime. Source serving recognizes those
resources and browser script/style/worker requests. Files included only as
documents or attachments are not transformed merely because they contain HTML,
JavaScript or CSS. Source serving transforms the requested resource response,
not the entire workspace, and leaves source files unchanged.
