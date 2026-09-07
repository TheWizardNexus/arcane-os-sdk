# Release-derived browser asset URLs

Applications that enable [PWA delivery](pwa.md) use clean local resource URLs.
Their generated offline manifest and service worker own the selected application
and SDK release information. In that mode, the delivery transformer removes
both `v` and `arcaneVersion`, preserving other query fields and fragments.
The behavior below continues to apply when PWA delivery is disabled and to native
packages. Workspace runtime materialization remains usable by either target;
the selected browser delivery applies its PWA URL policy.

The SDK's public import-map generator, runtime materializer, source server and
application packager use the selected SDK package version for local browser
resource references. The query field is `arcaneVersion`. Its value comes from
SDK package metadata, not a timestamp, content measurement, or application
constant.

For example, an existing `./arcane/modules/HTMLImport.js?v=6#module` reference
becomes `./arcane/modules/HTMLImport.js?arcaneVersion=${version}#module`.
`arcaneVersion` is the sole resource version field: transformation removes `v`,
updates the first existing `arcaneVersion`, and removes duplicate version fields.
Regenerating for another SDK release replaces that version value. Unrelated
query fields, their spelling, and fragments remain intact.

## Public tooling

- Run the installed SDK's `materializeInstalledSdkRuntime()` to refresh the
  workspace runtime from that installation. Its generated local resource
  references use the installed package version, including npm aliases.
- Run `arcane import-map` through the installed SDK to regenerate the managed
  import map and its application HTML. Named SDK imports and URL-shaped module
  entries point to versioned resources.
- `arcane dev` applies the same reference transformation to served source
  without editing the source files. An explicit live SDK source mount uses the
  version in that source checkout's `package.json`. Otherwise it uses the
  materialized SDK version recorded by the workspace's existing semantic lock.
- The application packager applies resource versioning after its selected
  adapter finishes. The resulting application can be served by an ordinary
  static host without a JavaScript transformation service.

The shared transformation edits actual local module imports, resource URL
construction, HTML resource attributes and CSS resource references. It does not
change displayed text, prompts, application data, downloaded model content,
remote provider URLs, or arbitrary strings that happen to resemble filenames.
Worker entry references and their local module imports are versioned separately:
Workers do not inherit a document's import map. `HTMLImport` carries its own
release query into local dynamically loaded components and their resources.

Computed application URLs that have no statically identifiable resource
reference remain application-owned expressions. The SDK does not intercept
global `fetch`, `URL`, `Worker`, or DOM APIs. An import-map URL entry can resolve
an exact matching computed module URL, but is not a wildcard query rule.

## Navigation and caching

The SDK server sends `Cache-Control: no-cache` for application entry/managed
HTML and managed import-map JSON. This allows storage but requests revalidation, so an ordinary navigation
or refresh obtains the current entry document and release URLs. Other assets
retain ordinary caching; no cache or user storage is cleared.

For PWA delivery the SDK server revalidates all served resources, including
the stable worker script. A static host serving a PWA package must likewise
revalidate stable resource URLs. The service worker maintains its own selected
offline resource cache independently of the HTTP cache.

An independently configured static host must likewise revalidate entry HTML
and managed import-map JSON. The generated package supplies versioned resource
references; it cannot configure another server's HTTP headers.

An already-open document keeps modules it has evaluated. Versioned references
take effect on ordinary navigation or refresh; they do not replace live module
instances, force a reload, restart a model, or erase a conversation. The SDK does
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
