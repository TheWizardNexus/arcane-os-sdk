# Arcane Hello World example instructions

- Use plain JavaScript, HTML, and CSS; do not introduce TypeScript or TSX.
- Keep reusable mechanisms in the Arcane SDK. This example owns only its
  application identity, greeting, and browser-versus-Arcane-host label.
- Keep AI, model, transcription, and speech setup in advanced examples such as
  `examples/wasm-ai-demo/`; do not add that lifecycle to Hello World.
- Keep the example flat under `examples/hello-world/`; do not turn it into an
  application workspace, package, generated SDK projection, or release fixture.
- Load the current SDK theme before example styles and import
  `arcane/ThemeBootstrap` before configuration runs.
- Declare the canonical `hello-world` identity with
  `<meta name="arcane-app-id" content="hello-world">` before modules load.
- Use `rgb(...)` or `rgba(...)` for new CSS colors.
- Serve the canonical SDK checkout with a generic static server so the example
  consumes current `/runtime`, `/browser-runtime`, and `/src` source directly.
- Preserve complete application, model, message, document, diagnostic, and tool
  content. Do not truncate, clip, elide, tail, or add character, token, file-size,
  or byte-count gates.
- Do not add byte identities, hashes, digests, byte progress, integrity receipts,
  or admission checks to the ordinary application path.
- Optional hardening is inactive unless the user expressly selects
  `secure: true` for that exact scope. The ordinary path must remain fully
  functional without empty security or permission scaffolding.
- Do not run `npm run check` or any other test or check before committing unless
  the user explicitly requests it or the selected work builds, verifies, or
  releases a `dist`, package, artifact, or other release output.
