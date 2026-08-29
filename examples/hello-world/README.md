# Arcane Hello World

This is the smallest Arcane source example: one HTML page and one JavaScript
file. It applies the shared Arcane theme, prints a greeting, and says whether it
is running in a normal web browser or inside an Arcane host.

Serve the canonical SDK repository root with a local static server, then open:

`http://127.0.0.1:8444/examples/hello-world/`

`index.html` declares the app identity and maps the named SDK imports. `App.js`
waits for the Arcane theme and writes the two visible lines. The same files run
in either environment.

For models, chat, transcription, and speech, continue with the advanced
[`wasm-ai-demo`](../wasm-ai-demo/) example after this one works.
