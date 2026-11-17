# Browser folder without a host

Use the public packager's embedded module format when a reader must open its
HTML entry from a local folder or removable drive. The application keeps its
classic scripts and ordinary relative assets; the SDK packages the selected ESM
graph into document import maps. No application-owned module loader, JavaScript
compiler, HTTP server or native application is required by this representation.

```javascript
import {packageApp} from 'arcane-os';

const result = await packageApp({
    workspaceRoot: process.cwd(),
    appId: 'moon-evidence-reader',
    outputDirectory: 'dist/reader-folder',
    moduleFormat: 'embedded'
});
```

Use an existing SDK workspace/package configuration and its installed-package
routes. Include the complete application scripts, selected SDK runtime and
dependencies, notices/licenses and intended documents and media. Resolve SDK
imports to that installed package through the normal public import-map operation
before packaging. An existing CDN mapping is an external dependency; selecting
this format does not download it or silently substitute a local version.

The `outputDirectory` is wholly replaced through the packager's existing staged
output operation. Source files and saved configuration remain unchanged. Copy
the complete resulting folder to the destination and open its HTML entry there.
The browser must support import maps and `data:` JavaScript modules. A supported
package representation does not override browser, operating-system or managed
environment restrictions on opening or inspecting local files.

## Supported loading shape

- External classic application scripts and inline classic scripts, with literal
  dynamic SDK imports such as `import('arcane-os/ai/twin-cloud')`.
- Selected ESM entry scripts, static imports, re-exports, live bindings, cycles
  and literal dynamic imports. Complete module sources are retained, including
  exports that the entry does not currently use.
- Document-specific import-map mappings and original module URL identity,
  including query strings and fragments.
- Ordinary relative HTML iframe, image, PDF, audio and video references, plus
  the existing selected stylesheet/resource processing.
- Application content already carried in classic scripts or HTML. Complete
  human-authored content is preserved by the existing packaging owners.

The generated map precedes scripts that can import modules. ESM entries use
their embedded URL directly; classic scripts remain files. Module sources use
stable internal specifiers so cyclic graphs do not recursively duplicate their
source. The browser performs ordinary ESM linking and evaluation.

Generated browser PWA artifacts are disabled for this invocation. Their active
SDK-marked references are removed from selected output documents through the
existing PWA owner; saved PWA settings and other output modes remain available.

## Transformation limits and host-dependent APIs

An embedded module's `import.meta.url` is its `data:` URL. Code that derives
neighboring resource locations from that value needs an explicitly supported
resource contract; this mode does not invent a filesystem base. Computed module
imports, Workers, provider-created executable blobs and dynamic source evaluation
are outside the static graph transformation. Import maps do not apply to Worker
module graphs.

Browsers may restrict `fetch()` of neighboring files. Use the application's
existing embedded content or ordinary element URLs where that is its selected
design; this mode does not replace a file reader with a local server. SDK HTML
components that load their templates with `fetch()` retain that host requirement.
Native Core, OPFS and other host-dependent APIs retain their actual availability.

An optional HTTPS cloud request remains a real network request with the service's
ordinary CORS and authentication requirements. The folder can carry the client
code; it does not make that service offline or embed credentials.

## Verification and delivery

Inspect the selected output for its complete module graph, import-map ordering,
asset and license inventory, and preserved application content. Actual browser
execution from a local-file URL is a separate acceptance step. An HTTP preview,
source review or successful package build must not be reported as file/USB
execution. Use only a supported browser surface permitted to inspect that URL;
preserve an actual access denial instead of changing browser policy or switching
to an unapproved control path.

Consumers adopt this capability only through its published `arcane-os` revision.
Development consumers track `latest`; source collaborators inside the SDK may
use the current checkout while implementing the same update.
