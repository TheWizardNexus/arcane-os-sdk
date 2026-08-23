# Arcane Hello World

This is the smallest complete Arcane OS SDK project that starts as HTML, CSS, and JavaScript and can finish as a Windows x64 development executable.

The copy in this SDK repository is a maintained example. A real Arcane application owns its own repository and installs `arcane-os` as an exact npm development dependency. Its commands use the project-local CLI through npm scripts or `npm exec -- arcane`; a separate global SDK install is not required.

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

## Project shape

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
├── arcane-packager.json
├── arcane.lock.json
└── package.json
```

The page owns only its greeting and click behavior. The SDK supplies the shared theme, runtime, package validation, CLI, and native build orchestration.
