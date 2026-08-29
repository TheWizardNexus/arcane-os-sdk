# Arcane Hello World

This is a source example, not an application workspace or release package. It
contains one page and one configuration module. The page includes the shared
SDK chat; the SDK owns the transcript, composer, model lifecycle, progress,
errors, cancellation, persistence, transcription, speech playback, and cleanup.

Serve the canonical SDK repository root with any generic static HTTPS server,
then open:

`https://localhost:8444/examples/hello-world/`

The example resolves the current checkout's `/runtime`, `/browser-runtime`, and
`/src` files directly. It does not use a copied `arcane/` runtime, an app
descriptor, a packager configuration, or application-local functional code.

`App.js` owns only the selected upstream model and speech authorities plus the
minimal call to `chat.bindSession({ai, sessionOptions})`. Importing the example
does not download or activate a model; each provider starts only after the user
operates its SDK-owned control.
