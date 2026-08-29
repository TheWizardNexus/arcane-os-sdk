# Arcane Hello World

This maintained example is a minimal browser chat application composed from
the current Arcane SDK source. Its authored application code supplies only the
shell and application-owned model selections. The SDK owns the session binding,
chat log, composer, activation controls, provider lifecycle, complete progress
and error presentation, cancellation, persistence, transcription, speech
playback, and page teardown.

The intended package revision is `arcane-os@0.3.2`. The example uses the same
canonical import names in development and in its materialized release; it does
not copy an SDK controller, rewrite a module into a data URL, or add an
application-local runtime shim.

## Selected providers

Importing the application selects the following defaults without loading them:

- chat: IBM Granite 4.1 3B Q4_K_S from the application-authored upstream
  model URL;
- transcription: `Xenova/whisper-small` at revision
  `2d67713f236afa48a18992566e7647f6ca848e13`, dtype `q8`, through
  `@huggingface/transformers@3.5.1`;
- speech playback: `onnx-community/Kokoro-82M-v1.0-ONNX` at revision
  `1939ad2a8e416c0acfeecc08a694d14ef25f2231`, dtype `q8`, with voice
  `af_heart`, through `kokoro-js@1.2.1`.

`apps/hello-world/modules/SpeechAuthorities.js` contains the exact maintained
speech selections and their versioned upstream runtime entry URLs. The example
does not vendor or redistribute those runtimes, models, voices, license
corpora, or corresponding source. The SDK provider fetches or installs an
upstream selection only after the user operates its matching SDK control; page
load performs no model, voice, or speech-runtime download.

The ordinary browser descriptors deliberately omit `permissions`, `security`,
and native Core requirements. Malformed inputs and unavailable browser
capabilities still produce honest SDK errors with their complete detail.

## Source contract

`apps/hello-world/index.html` loads the Arcane theme and includes the canonical
SDK chat component:

```html
<html-import
    id="hello-world-chat"
    href="/runtime/arcane/components/chat.html?v=1">
</html-import>
```

`apps/hello-world/modules/App.js` imports only public SDK names. It selects the
browser-WASM LLM and normalized browser speech providers, then calls the
component's SDK-owned `bindSession({ai,sessionOptions})` seam. It does not
implement send/result rendering, loading, progress, activation, cancellation,
storage, speech, or teardown workflows.

The authored development import map resolves those names directly to the
canonical checkout: shared modules and components under `/runtime/arcane/`,
browser AI under `/browser-runtime/ai/`, and the event manager under
`/src/event-manager.mjs`. It never reads the stale example projection while the
canonical SDK source server is active.

The selected SDK release materializes the corresponding physical paths under
`arcane/` and embeds the generated import map. `arcane.lock.json` is
intentionally absent from the authored application.

## Project shape

```text
hello-world/
├── apps/hello-world/
│   ├── modules/
│   │   ├── App.js
│   │   └── SpeechAuthorities.js
│   ├── test/app.test.mjs
│   ├── arcane-app.json
│   ├── arcane-package.json
│   ├── hello-world.css
│   ├── index.html
│   └── manifest.json
├── arcane/                  # selected SDK release projection
├── package-lock.json        # selected SDK release metadata
└── package.json             # exact SDK dependency
```

Package, lock, materialized `arcane/**`, generated import-map, and generated
reference/site updates belong to the selected release workflow. They are not
hand-edited from the authored example source.

## Development and release commands

The project-local SDK owns the commands:

```sh
npm run dev
npm run package
npm run bundle
npm run run
```

Tests and checks run only when the user explicitly requests them or as the
required verification of a selected release output.

## Reference

- [AI overview](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/)
- [Browser-WASM AI](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/browser-wasm/)
- [Browser speech](https://thewizardnexus.github.io/arcane-os-sdk/reference/ai/browser-speech/)
- [Runtime components](https://thewizardnexus.github.io/arcane-os-sdk/reference/runtime-components/)
- [Runtime modules](https://thewizardnexus.github.io/arcane-os-sdk/reference/runtime-modules/)
