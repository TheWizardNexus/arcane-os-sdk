# Arcane Hello World

This maintained example is a browser-only Arcane application written with
HTML, CSS, and JavaScript. It imports Arcane modules by stable names, remembers
this app's greeting count, and uses the same authenticated runtime bytes in
development and in its packaged release.

## Requirements

- Node.js 22.23.2 or newer
- npm

## Create the project

```sh
npx arcane-os new hello-world --path ./hello-world --display-name "Arcane Hello World" --git
cd hello-world
npm install
```

The generated project pins `arcane-os` as a project-local development
dependency. That dependency supplies the reproducible CLI and authenticated
runtime used by the npm scripts. Installing the CLI globally is optional.

## Physical runtime and import map

The scaffold materializes a real `arcane/` tree beside `apps/`. It does not
serve a virtual `node_modules` runtime. The checked-in Hello World fixture has
the same shape:

```text
hello-world/
├── apps/hello-world/
│   ├── modules/
│   │   ├── App.js
│   │   └── arcane.importmap.json
│   ├── arcane-app.json
│   ├── arcane-package.json
│   ├── hello-world.css
│   ├── index.html
│   └── manifest.json
├── arcane/
│   ├── css/
│   ├── dependencies/strong-type/
│   ├── entities/
│   ├── modules/
│   └── sdk/
│       ├── dependencies/event-pubsub/
│       ├── dependencies/strong-type/
│       └── event-manager.mjs
├── arcane-packager.json
├── arcane.lock.json
└── package.json
```

`apps/hello-world/modules/arcane.importmap.json` is browser-standard JSON with
one top-level `imports` object. The CLI keeps that artifact synchronized with a
managed inline `<script type="importmap" data-arcane-import-map>` immediately
after the document's sole `<base href="../../">`, before every active script or
module preload in `index.html`. The committed fixture contains 163 authenticated
runtime files and 85 import-map entries (84 named specifiers plus the URL-like
runtime dependency remap). Representative entries are:

```json
{
  "imports": {
    "arcane/AppDataScope": "./arcane/modules/AppDataScope.js",
    "arcane/ThemeBootstrap": "./arcane/modules/ThemeBootstrap.js",
    "arcane-os/event-manager": "./arcane/sdk/event-manager.mjs",
    "event-pubsub": "./arcane/sdk/dependencies/event-pubsub/index.js",
    "./node_modules/strong-type/index.js": "./arcane/dependencies/strong-type/index.js"
  }
}
```

Regenerate the map explicitly whenever you want:

```sh
npm run import-map
```

Scaffold, development, package, and build also refresh the default map
automatically. The generator scans Arcane's browser modules and every shipped
dependency they import, removes stale entries, and fails without replacing the
last valid map when an import cannot be resolved.

The Arcane runtime's unchanged relative imports resolve to authenticated
`strong-type@1.1.0` through the URL-like key. EventManager's shipped
`event-pubsub@6.1.0` closure resolves its physical sibling
`strong-type@2.0.0` beneath `arcane/sdk/dependencies/`; neither graph trusts or
overwrites a consumer's top-level `node_modules` dependencies.

## How the application imports Arcane

`index.html` loads Arcane's shared styles before the application stylesheet:

```html
<link rel="stylesheet" href="./arcane/css/theme.css?v=1">
<link rel="stylesheet" href="./arcane/css/primitives.css?v=1">
<link rel="stylesheet" href="./apps/hello-world/hello-world.css?v=1">
```

`App.js` uses query-free named imports. The browser import map resolves these
names to the physical runtime:

```js
import arcaneThemeReady from 'arcane/ThemeBootstrap';
import {
    resolveApplicationId,
    resolveApplicationLocalStorageKey
} from 'arcane/AppDataScope';
```

After the theme is ready, the application creates an app-scoped browser storage
key and counts greetings:

```js
const appId=await resolveApplicationId();
const countKey=resolveApplicationLocalStorageKey(
    'hello-count',
    {applicationId:appId}
);
```

## Develop and test

```sh
npm run doctor
npm run check
npm run dev
```

Open the loopback URL printed by the CLI. The page demonstrates named Arcane
imports, shared styling, application identity, and persistent browser storage.
Press Ctrl+C to stop the development server.

## Package, verify, bundle, and run

```sh
npm run package
npm run verify
npm run bundle
npm run run
```

`package` writes `dist/hello-world/`, including the same `arcane/**` bytes and
the same import-map specifiers used in development. `verify` authenticates that
directory. `bundle` creates
`dist/hello-world-0.1.0.arcane-app.tar.gz`. `run` verifies and launches the
packaged browser release on a loopback URL.

`npm run build` is an explicit browser build and writes the same packaged
directory. It does not create a standalone native executable. Native targets
are provider-supplied, require a separately declared target and compatible
provider, and remain outside this maintained browser example; see the
[platform target contract](../../docs/platform-targets.md).

Every browser release also carries Arcane OS licensing material under
`licenses/arcane-os/`. Review those terms before distribution.
