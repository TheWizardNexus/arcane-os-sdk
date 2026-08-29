# Arcane WASM AI example instructions

- Use plain JavaScript, HTML, and CSS. Do not introduce TypeScript or TSX.
- This example consumes the current canonical SDK checkout directly from `/src`, `/browser-runtime`, and `/runtime`.
- Never copy, vendor, generate, or materialize SDK source inside this example.
- Shared Chat, Speech, AI provider, persistence, cancellation, and lifecycle behavior belongs to the SDK. The example owns only its outer design, model/profile selection, prompts, retrieval policy, maintained demo data, and tool declarations.
- Preserve the Chat component's AI-left and user-right transcript geometry.
- Keep model weights, browser profiles, caches, generated evidence, and TLS private keys out of Git.
- Do not add or execute a non-RIAEvangelist dependency without the user's express permission for that exact dependency and operation.
- Preserve complete messages, documents, tool calls, and diagnostics. Do not add character, token, file-size, byte, hash, checksum, receipt, freeze, restrictive-admission, trust, signing, or security gates.
- Do not run tests, checks, linters, builds, browser QA, packaging, or release operations unless the user explicitly requests them.

