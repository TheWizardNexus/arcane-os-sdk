# Arcane OS SDK repository instructions

## Governing functional baseline

Never truncate, clip, elide, tail, shorten, or silently discard application,
development, model, document, message, log, diagnostic, test, process, or tool
content. Preserve the complete content through streaming or ordered continuation
when one operation cannot carry it.

Do not impose or drive ordinary SDK, application, development, packaging,
storage, cache, model, response, file, test, or runtime behavior from byte
counts, byte identities, byte limits, byte targets, byte-based progress,
hashes, digests, checksums, or immutable-byte receipts. Unavoidable external
protocol framing stays local to that protocol and never becomes product policy.

Optional security and hardening remain inactive unless the user expressly
authorizes the exact control and scope. An existing seam, manifest field,
historical implementation, or release workflow is not authorization. Preserve
the complete ordinary functional path. Keep credential and secret protection,
non-optional law and platform safety, unavoidable operating-system and external
protocol requirements, and genuinely malformed or corrupt input rejection at
their exact owners without generalizing them into SDK or application gates.

Every structural function declaration and emitted call must require a nonempty
`arguments.message` string for ordinary user-facing progress or next-step text.
Keep complete raw arguments and protocol envelopes only in an explicitly opened
tool-inspection surface or developer diagnostics. Displaying a call never
settles it: an exact matching executed, declined, cancelled, or not-executed
`role:'tool'` result must be recorded before another user turn.

- Work directly on the single canonical `main` branch before and after every
  release; do not create or use a development or feature branch.
- `dev` and `latest` are npm dist-tags selected from the strict package
  version. They are never Git branches and do not change the canonical checkout.
- Continuous integration and npm publication may identify the selected `main`
  commit when a release is explicitly selected. That release-only identity is
  not an ordinary application, development, package, or runtime gate.
- Use plain JavaScript and web standards. Do not introduce TypeScript or TSX.
- Keep the CLI and graphical clients on one shared headless toolchain contract.
- Every potentially blocking CLI operation must acknowledge first, own its work, stream progress or heartbeat events, support safe cancellation, and surface a nonzero exit status on failure.
- Default build cardinality is one workspace, one app, one target, one architecture, one format, and one signing profile. Never add implicit all-app or all-target loops.
- Applications must use the shared Arcane theme and `ThemeBootstrap.js`.
  Anything reusable by a portable application belongs canonically in this SDK,
  including shared modules, entities, components, themes, browser runtimes and
  providers, protocol/state/lifecycle machinery, public native contracts and
  adapters, development source mounts, packaging, and licenses.
  Never keep a copied app or Arcane OS fork of that behavior.
- Every portable application artifact must contain a complete copy
  of its selected SDK runtime, assets, workers, licenses, and public
  contracts. A portable app must never require an Arcane OS installation or
  source checkout at runtime. Arcane OS, Shell, Provisioner, and internal tools
  consume these same SDK paths; they do not own private portable-runtime
  imports.
- Arcane OS and Core own privileged host implementations, app/session
  admission, launcher and Shell orchestration, and Shell-specific system-AI
  policy. The SDK may define the public Core bridge contract but must not embed
  Core. Each application owns its branding, prompts, data, tools, business
  policy, model authorities, and app-specific orchestration.
- Apply this placement order before implementation: reusable by any portable
  app -> SDK; host privilege, launcher, or Shell responsibility -> Arcane OS;
  one-product behavior -> that app. Development may use only the explicit
  dev-only live SDK source mount; distribution embeds the selected SDK
  runtime, with no hidden OS source dependency.
- Applications use a browser-first plain HTML, CSS, and JavaScript baseline. Native targets progressively enhance that same application through explicitly available Arcane Core capabilities; ordinary browser development must not depend on native or Core access.
- Keep development increments small and independently understandable so each observed change has one clear cause and mistakes remain easy to isolate. Development commands do not automatically run tests, checks, packaging, or distribution work. Run tests or checks only when the user explicitly requests them or when building, verifying, or releasing a selected `dist`, package, artifact, or other release output.
- For rapid browser development, use `arcane dev`. It serves the selected application's canonical source files with the live mapped SDK/runtime dependencies, so saved source changes appear on browser refresh without packaging, copying files into `dist`, or restarting the server.
- Native and executable development uses an Arcane-owned, capability-gated wrapper as an escalated browser around those same source files. It adds only the app-declared local Core access needed for progressive enhancement and does not package, serve `dist`, or run tests automatically.
- Distribution does not silently add testing or hardening authority. Run only
  checks that the user explicitly requests or that an explicitly selected
  release output genuinely requires. Use `dist` only for the selected packaged
  output; never use it as the rapid-development tree.
- Native adapters accept explicit inputs and must fail honestly when unavailable. Never substitute a browser package for a native executable.
- Commit and push do not authorize local tests or checks. Run the narrow checks
  that own the changed contract only when the user explicitly requests them or
  as part of a selected distribution or release. Hosted source validation and
  documentation or Pages checks are release-publication evidence, not ordinary
  development checkpoints.
