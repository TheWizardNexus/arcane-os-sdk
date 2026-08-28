# Arcane Hello World

This maintained example is a browser Arcane application written with plain
HTML, CSS, and JavaScript. The greeting runs without AI. Three independent role
panels then present the SDK lifecycle for a local LLM, text to speech (TTS), and
speech to text (STT): select, hydrate, load, use, cancel, unload, reload from
cache, and dispose when the page closes.

`arcane-os@0.3.1` ships the normalized AI surface, provider and Worker
machinery, DBOPFS storage, and the licenses for its own packaged bytes. It does
not redistribute model weights, caller-selected Whisper or Kokoro runtimes,
voices, third-party legal corpora, or corresponding source. Importing the app
starts no AI download and creates no AI Worker. The LLM has an app-selected
immutable source. Speech remains disabled until the application owner supplies
version-pinned upstream authorities in `modules/SpeechAuthorities.js`.

## Requirements

- Node.js 22.23.2 or newer
- npm

## Create the same project shape

```sh
npx arcane-os@0.3.1 new hello-world --path ./hello-world --display-name "Arcane Hello World" --git
cd hello-world
npm install
```

The generated project pins `arcane-os` exactly and uses its project-local CLI
for every npm script. The scaffold starts with the greeting; this maintained
fixture extends that generated app with the optional local-AI panel below.

A global CLI is supported as a convenience:

```sh
npm install --global arcane-os@0.3.1
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
│   │   ├── SpeechAuthorities.js
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
│   │   ├── AI.js
│   │   ├── AIProviderRuntime.js
│   │   ├── AIRuntimeState.js
│   │   ├── AppDataScope.js
│   │   ├── DBOPFS.js
│   │   ├── DBOPFSDocumentLibrary.js
│   │   ├── DocumentLexicalSearch.js
│   │   ├── PersistentAIChatSession.js
│   │   └── ThemeBootstrap.js
│   ├── sdk/
│   │   ├── ai/
│   │   │   ├── ARCANE_AI_BROWSER_SPEECH_COMPONENTS.json
│   │   │   ├── browser-kokoro-worker.mjs
│   │   │   ├── browser-speech.mjs
│   │   │   ├── browser-wasm.mjs
│   │   │   ├── browser-wasm-llm-provider.mjs
│   │   │   ├── browser-wllama-runtime.mjs
│   │   │   ├── browser-whisper-worker.mjs
│   │   │   ├── model-controller.mjs
│   │   │   ├── speech-worker-client.mjs
│   │   │   ├── speech-worker-runtime.mjs
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

The tree above calls out representative paths rather than freezing an inventory
count. `arcane.lock.json` binds the SDK release, its runtime receipts enumerate
the authenticated projection, and the generated import map is the authority for
the current browser names. Its internal `./node_modules/strong-type/index.js`
request resolves to the authenticated
`./arcane/dependencies/strong-type/index.js` snapshot, so development and the
packaged release use the same physical dependency bytes.

```json
{
  "imports": {
    "arcane/AI": "./arcane/modules/AI.js",
    "arcane/AppDataScope": "./arcane/modules/AppDataScope.js",
    "arcane/DBOPFS": "./arcane/modules/DBOPFS.js",
    "arcane/PersistentAIChatSession": "./arcane/modules/PersistentAIChatSession.js",
    "arcane/ThemeBootstrap": "./arcane/modules/ThemeBootstrap.js",
    "arcane-os/ai/browser-speech": "./arcane/sdk/ai/browser-speech.mjs",
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

## Full browser-local AI lifecycle

The import map resolves the normalized runtime modules and public SDK entrypoint
to authenticated physical installed-package routes. DBOPFS supplies one
app-scoped persistent store, but no role loads and no artifact request starts
until its own load button is chosen:

```js
import DBOPFS from 'arcane/DBOPFS';
import AI, {
    AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL
} from 'arcane/AI';
import {
    createArcaneAI,
    createBrowserModelSource,
    createBrowserWasmLlmProvider,
    createDbopfsModelStore
} from 'arcane-os/ai/browser-wasm';
import speechAuthorities from './SpeechAuthorities.js';

const AI_SECURITY=Object.freeze({secure:false});
```

The app keeps separate operation state and `AbortController` instances for
`llm`, `tts`, and `stt`. Loading, using, cancelling, or unloading one role does
not silently select, reset, or fall back to another role. A role is usable only
after its own provider reports ready. `AI_SECURITY` keeps the shipped ordinary
warn-first default explicit: malformed inputs and failed runtimes still fail,
while disabled optional byte checks are reported as `unchecked`, not verified.

### Application-owned speech authority

The maintained `SpeechAuthorities.js` deliberately starts fail-closed:

```js
const speechAuthorities = Object.freeze({
    stt: null,
    tts: null
});

export default speechAuthorities;
```

Do not replace either `null` with a floating example URL. A real STT or TTS
authority names the app-selected model, repository, version or immutable
revision, and its selected upstream runtime entry. TTS also names the selected
default voice. In ordinary warn-first mode the model file list may be empty or
omitted so the version-pinned upstream provider can fetch its normal model and
voice assets. Runtime files and any `wasmPaths` still identify a version-pinned
npm/package distribution. The application remains responsible for checking the
upstream terms; neither this example nor the SDK republishes those bytes or
their legal corpus.

Until that policy is real, each speech role remains unavailable. Its load
attempt reports `HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED` before creating a
provider or starting a fetch. The SDK does not choose a model, runtime, voice,
source, revision, or license for the application.

On the first configured role, the app records the exact selected provider and
model with `localOnly:null`. That is an intentionally selected-but-unregistered
route. `AI.configureBrowserSpeech()` constructs the shared provider, atomically
hydrates that exact route to `localOnly:true`, and leaves the other external
Cloud or Core speech route unchanged. A later one-role call can add or replace
the other browser role without reconstructing or rerouting the first:

```js
const speechAI=new AI();
const runtime=speechAI.providerRuntime;
const selected=Object.freeze({
    providerId:'hello-world-browser-whisper',
    modelId:speechAuthorities.stt.model.id,
    localOnly:null
});

runtime.configureSpeech(Object.freeze({
    stt:Object.freeze({default:selected,localOnly:null}),
    tts:Object.freeze({default:runtime.selection('tts'),localOnly:null})
}));

await speechAI.configureBrowserSpeech(Object.freeze({
    protocol:AI_BROWSER_SPEECH_CONFIGURATION_PROTOCOL,
    id:'hello-world-stt-network',
    dbopfs,
    stt:Object.freeze({
        providerId:selected.providerId,
        model:speechAuthorities.stt.model,
        runtime:speechAuthorities.stt.runtime,
        security:AI_SECURITY,
        offline:false
    })
}),{signal});
```

Configuration alone does not load, download, choose a fallback, or change the
omitted role.

### LLM

The configured caller-supplied model is IBM Granite 4.1 3B Q4_K_S:

- exact size: 1,998,371,424 bytes (1.86 GiB)
- license: Apache-2.0
- immutable source revision: `ab4701481089b58a082ef63cc1cee738887293ff`
- SHA-256: `ed5b17192313b021f0579561d9c471419e7e62ec490986364e3d9d63ea36a08a`

The network-permitted load first checks an app-scoped DBOPFS cache. On a miss,
Arcane downloads the immutable URL, reports byte progress, records observed
bytes and cache completion, and loads it. `load({offline:true})` makes no
model-source request and succeeds only when a compatible cache already exists.
Packaged same-origin Wllama/WASM runtime assets may still load. With the
example's `secure:false` policy, byte-length and SHA-256 checks are disabled and
status reports `integrity.state:'unchecked'`; the retained expected size and
digest are metadata available for a later explicit strict load, not a claim
that the ordinary load verified them. This 0.3.1 browser path requires WebGPU,
and the published provider owns its
full-offload setting; the application does not provide a `gpuLayers` override.

Every inference request sets `localOnly:true`. That guarantees inference stays
inside this browser provider after load; it does not mean the first-use model
download is offline. Proposed tool calls are returned as structural
name/argument records. The SDK does not invoke them, and this example provides
no tool dispatcher. This tutorial rejects prompts longer than 2,000 characters
before tokenization so LLM preparation remains bounded.

### Text to speech

TTS is configured through normalized `arcane/AI` only after
`speechAuthorities.tts` is present. `setSpeechMuted(false)` explicitly loads
the selected TTS route. A synthesis request supplies the selected model, input
text, `responseFormat:'wav'`, and speed. `fetchTTS()` returns a WAV `Blob`; the
application creates only its object URL and assigns it to a standard
`<audio controls>` element. Playback is always initiated and controlled by the
user. The SDK and example do not autoplay generated speech.
This tutorial limits each synthesis input to 500 characters before dispatch so
runtime work and generated audio memory remain bounded.

Replacing audio, unloading TTS, or leaving the page revokes the old object URL.
Use Cancel to stop an active TTS operation. Once the role is idle, Unload
ensures no TTS Worker remains active without changing the LLM or STT lifecycle.

### Speech to text

STT is configured through normalized `arcane/AI` only after
`speechAuthorities.stt` is present. The user explicitly chooses an audio file;
`fetchSTT()` passes that `File` to the selected route. The SDK decodes the file
to the provider's input format and returns text to the supplied response
handler.

This example does not open a microphone, capture live audio, or request a
microphone permission or Arcane Core capability. Choosing a local file is an
explicit browser action, and that file is used only for the requested
transcription. It rejects files larger than 8 MiB before the SDK reads or
decodes them, bounding the tutorial's browser memory exposure.

### First use, cache, offline reuse, and cleanup

A network-permitted load checks the app-scoped DBOPFS cache first. On a miss,
the SDK obtains the app-selected upstream artifacts only after that role's
button is used, reports provider progress, records the resulting cache, and
starts that role's Worker. The default warn-first status includes
`browser-speech-warn-first-secure-mode-disabled` and calls optional byte checks
`unchecked` when they did not run.

Offline reuse performs no upstream artifact request. The LLM uses its offline
load option. For speech, the normalized AI owner atomically replaces only the
selected role with the same authority and `offline:true`, then loads it from the
same app-scoped store. The omitted STT or TTS route remains unchanged. An absent
compatible cache fails with `ARCANE_AI_ARTIFACT_OFFLINE_MISS` or the graph-mode
offline miss code.

Each role's Cancel button aborts only that role's active load or request. An
interrupted download is not completed. While a role is busy, its Unload control
is disabled; cancel or let the operation settle first. Unload then ends that
role session and ensures no role Worker remains active while retaining DBOPFS
artifacts. `pagehide` aborts all three roles, calls `dispose()` for the LLM and
`disposeBrowserSpeech()` for the SDK-owned normalized speech configuration, and
revokes the TTS audio object URL; browser
termination releases any remaining live resources. If the browser restores that
page from its back/forward cache, the example reloads once to create fresh
lifecycle owners.
Unload and dispose do not delete the persistent cache.

Optional strict checks are a separate application decision. Changing the shared
policy to `Object.freeze({secure:true})` requires a complete compatible
content-addressed graph and file authority, lengths, digests, licenses, and an
unload/reload. Strict mode rejects remote `wasmPaths`; immutable HTTPS graph
sources remain supported. The example does not silently enable or claim that
hardening.

The UI maps expected failures to stable codes instead of exposing provider
error text. Useful lifecycle boundaries include:

- `HELLO_WORLD_SPEECH_AUTHORITY_REQUIRED`
- `HELLO_WORLD_STT_FILE_TOO_LARGE` and `HELLO_WORLD_TTS_TEXT_TOO_LONG`
- `ARCANE_AI_NOT_READY`, `ARCANE_AI_PROVIDER_BUSY`, and
  `ARCANE_AI_PROVIDER_DISPOSED`
- `ARCANE_AI_REQUEST_ABORTED` and `ARCANE_AI_OPERATION_SUPERSEDED`
- `ARCANE_AI_ARTIFACT_OFFLINE_MISS`,
  `ARCANE_AI_ARTIFACT_SIZE_MISMATCH`, and
  `ARCANE_AI_ARTIFACT_DIGEST_MISMATCH`
- `ARCANE_AI_STORAGE_UNAVAILABLE`, `ARCANE_AI_WORKER_CRASHED`, and
  `ARCANE_AI_PROVIDER_LOAD_FAILED`
- `ARCANE_AI_AUDIO_DECODE_FAILED` and
  `ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT`

The current `apps/hello-world/arcane-app.json` and
`apps/hello-world/arcane-package.json` descriptors carry the same configured
LLM source origin in `security.connectOrigins` but request no Arcane Core
capabilities or methods. That existing LLM authority declares the initial
Hugging Face origin and permits its provider-controlled HTTPS redirect chain
without pinning an unstable regional CDN hostname. Before enabling speech, add
only the exact HTTPS
origins required by the real app-owned speech authorities, and make the same
allowlist edit in both descriptors. Each speech artifact URL must be immutable,
directly fetchable, and non-redirecting; the browser-speech store rejects a
redirect or changed final URL. Do not broaden `connectOrigins` for a
hypothetical model or runtime. File-selected STT and Blob-backed TTS playback
themselves require no Arcane capability or method.

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
and every authenticated `arcane/**` file listed by the release receipt match
development byte for byte. Source-only authoring files remain outside `dist`;
the release adds its own authority and license records. `verify` authenticates
that directory. `bundle` creates
`dist/hello-world-0.1.0.arcane-app.tar.gz`; `0.1.0` is the app version. `run`
verifies and serves the existing browser release.

`npm run build` is equivalent to the browser package path. It does not create a
standalone native executable. Native targets require explicit scaffold intent,
a compatible external provider, and a separate native workflow; they remain
outside this maintained browser example.

## Full reference

- [AI overview](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/)
- [Browser-WASM AI](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/browser-wasm/)
- [Browser speech](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/browser-speech/)
- [SDK API](https://thewizardnexus.github.io/arcane-os-sdk/reference/sdk-api/)
- [Runtime modules](https://thewizardnexus.github.io/arcane-os-sdk/reference/runtime-modules/)
- [Capabilities](https://thewizardnexus.github.io/arcane-os-sdk/reference/core/capabilities/)
- [CLI commands](https://thewizardnexus.github.io/arcane-os-sdk/reference/cli/)
