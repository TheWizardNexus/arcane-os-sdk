# Arcane Hello World

This maintained example is a browser Arcane application written with plain
HTML, CSS, and JavaScript. The basic greeting runs without a model. An optional
panel demonstrates the browser-WASM AI surface shipped in `arcane-os@0.1.1`
without downloading model weights automatically.

## Requirements

- Node.js 22.23.2 or newer
- npm

## Create the same project shape

```sh
npx arcane-os@0.1.1 new hello-world --path ./hello-world --display-name "Arcane Hello World" --git
cd hello-world
npm install
```

The generated project pins `arcane-os` exactly and uses its project-local CLI
for every npm script. The scaffold starts with the greeting; this maintained
fixture extends that generated app with the optional local-AI panel below.

A global CLI is supported as a convenience:

```sh
npm install --global arcane-os@0.1.1
arcane new hello-world --path ./hello-world
```

Global installation supplies the CLI only. It does not install services,
model weights, Arcane Core, ArcaneOllama, or prebuilt native executables.

## Source shape

Development uses the same physical runtime paths that are packaged in `dist`:

```text
hello-world/
├── .github/workflows/check.yml
├── apps/hello-world/
│   ├── modules/
│   │   ├── App.js
│   │   └── arcane.importmap.json
│   ├── test/app.test.mjs
│   ├── arcane-app.json
│   ├── arcane-package.json
│   ├── hello-world.css
│   ├── index.html
│   └── manifest.json
├── arcane/
│   ├── components/
│   ├── css/
│   ├── dependencies/strong-type/
│   ├── entities/
│   ├── img/
│   ├── modules/
│   ├── sdk/
│   │   ├── ai/
│   │   │   ├── browser-wasm.mjs
│   │   │   ├── browser-wasm-llm-provider.mjs
│   │   │   ├── browser-wllama-runtime.mjs
│   │   │   ├── model-controller.mjs
│   │   │   └── wllama/
│   │   ├── dependencies/event-pubsub/
│   │   ├── dependencies/strong-type/
│   │   ├── dom-event-instrumentation.mjs
│   │   └── event-manager.mjs
│   └── security/
├── arcane-packager.json
├── arcane.lock.json
├── package-lock.json
└── package.json
```

The authenticated `arcane/` projection contains 173 files. The generated map
contains 86 entries, including the browser-AI subpath. Its internal
`./node_modules/strong-type/index.js` request resolves to the authenticated
`./arcane/dependencies/strong-type/index.js` snapshot, so development and the
packaged release use the same physical dependency bytes.

```json
{
  "imports": {
    "arcane/AppDataScope": "./arcane/modules/AppDataScope.js",
    "arcane/DBOPFS": "./arcane/modules/DBOPFS.js",
    "arcane/ThemeBootstrap": "./arcane/modules/ThemeBootstrap.js",
    "arcane-os/ai/browser-wasm": "./arcane/sdk/ai/browser-wasm.mjs",
    "arcane-os/event-manager": "./arcane/sdk/event-manager.mjs",
    "event-pubsub": "./arcane/sdk/dependencies/event-pubsub/index.js"
  }
}
```

Regenerate that browser-standard map at any time:

```sh
npm run import-map
```

Development, package, and build refresh it automatically. `check` validates the
current artifact but does not replace it.

## Basic Arcane imports

`index.html` loads Arcane's shared styles before the app stylesheet. `App.js`
uses named imports for the theme and application identity, then creates an
app-scoped greeting counter:

```js
import arcaneThemeReady from 'arcane/ThemeBootstrap';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from 'arcane/AppDataScope';

await arcaneThemeReady;
const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey(
    'hello-count',
    {applicationId:appId}
);
```

## Optional browser-local AI

The named imports resolve the physical installed-package routes directly. The
DBOPFS module initializes the app-scoped storage singleton, but the AI provider
does not load and no model network request starts until a load button is chosen:

```js
import DBOPFS from 'arcane/DBOPFS';
import {
    createArcaneAI,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';
```

The tested optional model is caller-supplied IBM Granite 4.1 3B Q4_K_S:

- exact size: 1,998,371,424 bytes (1.86 GiB)
- license: Apache-2.0
- immutable source revision: `ab4701481089b58a082ef63cc1cee738887293ff`
- SHA-256: `ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a`

The online load first checks an app-scoped DBOPFS cache. On a miss, Arcane
downloads the immutable URL, reports byte progress, verifies the full digest,
writes a completion manifest, reopens and rehashes the file, and only then
admits it. `load({offline:true})` never fetches and succeeds only when that
verified cache already exists. Warm-cache loads still rehash the full model.

Every inference request sets `localOnly:true`. That guarantees inference stays
inside this browser provider after load; it does not mean the first-use model
download is offline. Tool calls are returned as visible name/argument records.
The SDK never executes them, and this example provides no tool dispatcher.

Cancel aborts the active load or request. Unload terminates the model worker and
releases model memory while keeping the verified cache. Leaving the page aborts
active work and disposes the session. The UI reports stable `ARCANE_AI_*` codes
instead of exposing provider error text.

The app descriptors declare the model source in `security.connectOrigins` but
request no Arcane Core capabilities or methods. This browser-WASM path is not
`Arcane.ai`, the legacy `arcane/AI` module, ArcaneOllama, speech synthesis, or a
Node inference provider.

## Develop and test

```sh
npm run doctor
npm run check
npm run dev
```

Open the loopback URL printed by the CLI. Press Ctrl+C to stop the server.

## Package, verify, bundle, and run

```sh
npm run package
npm run verify
npm run bundle
npm run run
```

`package` writes `dist/hello-world/`. The app entry, import map, map targets,
and all 173 authenticated `arcane/**` files match development byte for byte.
Source-only authoring files remain outside `dist`; the release adds its own
authority and license records. `verify` authenticates that directory. `bundle`
creates `dist/hello-world-0.1.0.arcane-app.tar.gz`; `0.1.0` is the app version.
`run` verifies and serves the existing browser release.

`npm run build` is equivalent to the browser package path. It does not create a
standalone native executable. Native targets require explicit scaffold intent,
a compatible external provider, and a separate native workflow; they remain
outside this maintained browser example.

## Full reference

- [Browser-WASM AI](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/browser-wasm/)
- [SDK API](https://thewizardnexus.github.io/arcane-os-sdk/reference/sdk-api/)
- [Runtime modules](https://thewizardnexus.github.io/arcane-os-sdk/reference/runtime-modules/)
- [Capabilities](https://thewizardnexus.github.io/arcane-os-sdk/reference/core/capabilities/)
- [CLI commands](https://thewizardnexus.github.io/arcane-os-sdk/reference/cli/)
