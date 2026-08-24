# Arcane Hello World

This example is a small Arcane application written with HTML, CSS, and JavaScript.
It says hello in a browser, remembers the greeting count for this app, and enables
an operating-system folder picker when it runs inside the Windows executable.

## Requirements

- Node.js 22.23.2 or newer
- npm
- Windows x64 to build and run the executable

## Create the project

    npx arcane-os new hello-world --path ./hello-world --display-name "Arcane Hello World" --target windows-x64 --git
    Set-Location ./hello-world
    npm install

The generated project pins arcane-os as a project-local development dependency.
That dependency supplies the reproducible CLI and runtime used by the npm scripts.

Installing arcane-os globally is optional:

    npm install --global arcane-os

That makes the arcane command available in the shell. The project scripts still
use the version installed by the project.

## What the SDK adds

- The arcane CLI creates, checks, serves, packages, and builds the application.
- Arcane theme and primitive styles provide the card and button design.
- AppDataScope creates a browser storage key owned by hello-world.
- The executable injects the Arcane bridge, application identity, and native
  DirectoryPicker.

## Project shape

The application owns files under apps/hello-world. npm installs the SDK runtime
under node_modules; the example imports only the Arcane files shown here.

    hello-world/
    ├── apps/hello-world/
    │   ├── img/icon.png
    │   ├── modules/App.js
    │   ├── arcane-app.json
    │   ├── arcane-package.json
    │   ├── hello-world.css
    │   ├── index.html
    │   └── manifest.json
    ├── node_modules/arcane-os/runtime/arcane/
    │   ├── css/
    │   │   ├── primitives.css
    │   │   └── theme.css
    │   └── modules/
    │       ├── AppDataScope.js
    │       ├── DirectoryPicker.js
    │       └── ThemeBootstrap.js
    ├── arcane-packager.json
    ├── arcane.lock.json
    ├── package.json
    └── package-lock.json

During development those installed runtime files are available to the app at
/arcane/. Packaging copies the runtime beside the application:

    dist/hello-world/
    ├── apps/hello-world/
    │   ├── modules/App.js
    │   ├── hello-world.css
    │   ├── index.html
    │   └── manifest.json
    └── arcane/
        ├── css/
        │   ├── primitives.css
        │   └── theme.css
        └── modules/
            ├── AppDataScope.js
            ├── DirectoryPicker.js
            └── ThemeBootstrap.js

## How the application uses Arcane

index.html loads Arcane's shared styles before the application stylesheet:

    <link rel="stylesheet" href="./arcane/css/theme.css?v=1">
    <link rel="stylesheet" href="./arcane/css/primitives.css?v=1">
    <link rel="stylesheet" href="./apps/hello-world/hello-world.css?v=1">

App.js imports the browser runtime helpers:

    import arcaneThemeReady from '../../../arcane/modules/ThemeBootstrap.js?v=1';
    import {
        resolveApplicationId,
        resolveApplicationLocalStorageKey
    } from '../../../arcane/modules/AppDataScope.js?v=1';
    import DirectoryPicker from '../../../arcane/modules/DirectoryPicker.js?v=1';

The browser path creates an app-scoped storage key and counts greetings:

    const appId=await resolveApplicationId();
    const countKey=resolveApplicationLocalStorageKey(
        'hello-count',
        {applicationId:appId}
    );

    function sayHello(){
        const count=loadHelloCount()+1;
        saveHelloCount(count);
        status.textContent=`Hello from Arcane OS! Greeting ${count}.`;
    }

The executable path detects the native host and uses Arcane's application and
folder-picker APIs:

    const runtime=globalThis.Arcane?.runtime?.current?.();

    if(runtime?.native===true){
        const app=await globalThis.Arcane.app.current();
        const result=await directoryPicker.select({
            title:'Choose a folder for Arcane Hello World'
        });
    }

The complete runnable files are in apps/hello-world/.

## Run in the browser

    npm run check
    npm run dev

Open the loopback URL printed by the CLI. The page displays two clear areas:

- Works in the browser: Arcane styling, app identity, and a persistent greeting.
- Executable feature: a disabled folder button with a message explaining that it
  becomes available in the executable.

Press Ctrl+C when you are ready to stop the development server.

## Package the browser application

    npm run package
    npm exec -- arcane verify

The packaged application is written to dist/hello-world/.

## Build the Windows executable

    npm run build

The SDK compiles the host-native components and writes:

    build/windows-x64/hello-world/ArcaneApp-hello-world.exe

Keep the executable with the other files in its containing directory. To build,
verify, and launch the application through the project script:

    npm run run

In executable mode the page shows the Arcane application name, version, and host
transport. Choose a folder opens the operating-system folder selector and reports
the selected path in the page.
