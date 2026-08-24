# Arcane Hello World

This is the smallest complete Arcane OS SDK project that starts as HTML, CSS, and JavaScript and can finish as a Windows x64 development executable.

The copy in this SDK repository is a maintained example. A real Arcane application owns its own repository and installs `arcane-os` as an exact npm development dependency. Its commands use the project-local CLI through npm scripts or `npm exec -- arcane`; a separate global SDK install is not required.

After publication, `npm install --global arcane-os` exposes `arcane` as an optional shell convenience. The exact project-local install and npm lockfile remain the reproducible default. A global install does not replace the application's pinned SDK dependency, install or start services, or provide prebuilt Arcane Core or Arcane Ollama binaries. Native components remain outputs of an explicit CLI build against the required Arcane OS source and toolchain.

## After the SDK is published to npm

```powershell
npx arcane-os@dev new hello-world --path .\hello-world --target windows-x64 --git
Set-Location .\hello-world
npm install
npm run check
npm run dev
```

The browser development command prints a loopback URL. Cancel it before starting a native build.

## Current source-checkout path

Until `arcane-os@dev` exists in the npm registry, create and install one checked SDK tarball:

```powershell
# In the arcane-os-sdk checkout
npm ci
npm run check
npm run pack:local
node .\bin\arcane.mjs new hello-world --path ..\hello-world --target windows-x64 --git

# In the generated hello-world repository
Set-Location ..\hello-world
npm install --save-dev --save-exact ..\arcane-os-sdk\arcane-os-0.1.0-dev.4.tgz
npm run check
npm run dev
```

The tarball is installed through npm so `package-lock.json` records its exact integrity. Do not replace it with a mutable local-directory link.

This maintained source copy intentionally omits `package-lock.json` while `arcane-os@dev` is unpublished. Dependency installation in the real application repository creates the lock; commit it before enabling the included `npm ci` workflow. For the temporary tarball path, keep the `.tgz` at the relative path recorded by that lock so later `npm ci` runs remain repeatable.

## Build an executable

A native build also needs one compatible Arcane OS checkout because that checkout owns the current Windows provider and native toolchain boundary.

```powershell
npm exec -- arcane native-doctor --target windows-x64 --arcane-root "..\Arcane OS"
npm run build -- --arcane-root "..\Arcane OS"
```

The verified development output is:

```text
build/windows-x64/hello-world/ArcaneApp-hello-world.exe
```

Keep the entire `build/windows-x64/hello-world/` directory; the executable depends on its bound Arcane Core and packaged application files.

To build, verify, and launch in one operation, use this **instead of** the separate build command and start from a clean output location:

```powershell
npm run run -- --arcane-root "..\Arcane OS"
```

This Windows artifact is unsigned local-development output, not a production release.

## Project and runtime shape

After `npm install`, the application source and the installed SDK runtime are separate. The developer owns `apps/`, the descriptors, and the npm files; npm generates `node_modules/` and the lockfile.

```text
hello-world/
├── apps/hello-world/
│   ├── img/icon.png
│   ├── modules/App.js
│   ├── test/app.test.mjs
│   ├── arcane-app.json
│   ├── arcane-package.json
│   ├── hello-world.css
│   ├── index.html
│   └── manifest.json
├── node_modules/                         # npm-generated
│   └── arcane-os/runtime/
│       ├── ARCANE_RUNTIME_RELEASE.json   # every runtime path + hash
│       ├── arcane/                       # SDK-supplied /arcane runtime
│       │   ├── components/               # 39 files
│       │   ├── css/                      # all 7 files
│       │   │   ├── communications.css
│       │   │   ├── dashboard-config.css
│       │   │   ├── document-site.css
│       │   │   ├── layout.css
│       │   │   ├── primitives.css
│       │   │   ├── theme.css
│       │   │   └── utility-workspace.css
│       │   ├── entities/                 # 15 files
│       │   ├── img/                      # 10 files
│       │   ├── modules/                  # 80 files
│       │   │   ├── AppDataScope.js
│       │   │   ├── DirectoryPicker.js
│       │   │   ├── ThemeBootstrap.js
│       │   │   └── … 77 more
│       │   └── security/
│       │       └── arcane-network-policy.json
│       └── strong-type/
│           ├── index.js
│           ├── licence
│           └── package.json
├── package-lock.json                     # npm-generated in a real app
├── arcane-packager.json
├── arcane.lock.json
└── package.json
```

The SDK receipt currently inventories exactly 152 files under `arcane/`. During `npm run dev`, the owned server mounts `node_modules/arcane-os/runtime/arcane/` at `/arcane/`. The app does not copy or maintain that directory.

`npm run package` materializes the same locked payload in the browser release:

```text
dist/hello-world/                         # generated
├── ARCANE_APP_RELEASE.json
├── index.html                            # generated redirect
├── apps/hello-world/                     # five public app files
├── arcane/
│   ├── components/                       # 39 files
│   ├── css/                              # 7 files, including theme.css and primitives.css
│   ├── entities/                         # 15 files
│   ├── img/                              # 10 files
│   ├── modules/                          # 80 files, including the three used by App.js
│   └── security/                         # arcane-network-policy.json
├── node_modules/strong-type/             # 3 files
└── licenses/arcane-os/                   # SDK license notices
```

HTML URLs such as `./arcane/css/theme.css` resolve from the release root because `index.html` declares `<base href="../../">`. Imports inside `apps/hello-world/modules/App.js` use `../../../arcane/modules/...` because they resolve from the module file itself.

The example uses Arcane's browser-safe theme and app-data helpers to keep a scoped greeting count. In an executable, the theme's read-only preference grant loads the saved Arcane appearance, and `resolveApplicationId()` verifies that the page identity matches the application bound by the host. The injected `globalThis.Arcane` bridge then enables Arcane's capability-gated native folder selector. That bridge is executable infrastructure, not another checked-in file beneath `arcane/`.
