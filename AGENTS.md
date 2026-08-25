# Arcane OS SDK repository instructions

- Work directly on the single canonical `main` branch before and after every
  release; do not create or use a development or feature branch.
- `dev` and `latest` are npm dist-tags selected from the strict package
  version. They are never Git branches and do not change the canonical checkout.
- Continuous integration and npm publication authenticate the exact `main`
  SHA. Reuse its immutable artifact evidence instead of rerunning unchanged
  checks or repacking release bytes.
- Use plain JavaScript and web standards. Do not introduce TypeScript or TSX.
- Keep the CLI and graphical clients on one shared headless toolchain contract.
- Every potentially blocking CLI operation must acknowledge first, own its work, stream progress or heartbeat events, support safe cancellation, and surface a nonzero exit status on failure.
- Default build cardinality is one workspace, one app, one target, one architecture, one format, and one signing profile. Never add implicit all-app or all-target loops.
- Reuse one immutable verification receipt for unchanged artifact bytes, policy, identity, location, and toolchain. Invalidate before mutation.
- Applications must use the shared Arcane theme and `ThemeBootstrap.js`; reusable behavior belongs in the Arcane runtime, not an app-local copy.
- Applications use a browser-first plain HTML, CSS, and JavaScript baseline. Native targets progressively enhance that same application through explicitly available Arcane Core capabilities; ordinary browser development must not depend on native or Core access.
- Keep development increments small and independently understandable so each observed change has one clear cause and mistakes remain easy to isolate. Development commands do not automatically run tests, checks, packaging, or distribution work. Run tests or checks only when the user explicitly requests them or when building, verifying, or releasing a selected `dist`, package, artifact, or other release output.
- For rapid browser development, use `arcane dev`. It serves the selected application's canonical source files with the live mapped SDK/runtime dependencies, so saved source changes appear on browser refresh without packaging, copying files into `dist`, or restarting the server.
- Native and executable development uses an Arcane-owned, capability-gated wrapper as an escalated browser around those same source files. It adds only the app-declared local Core access needed for progressive enhancement and does not package, serve `dist`, or run tests automatically.
- Distribution is the automatic test boundary. Before a packaged `dist/<id>` release is accepted, served, or launched, the distribution operation runs the selected application's required tests and fails closed on any failure. Use `arcane run --target browser` only for that verified `dist` path; never use `dist` as the rapid-development tree or source serving as release evidence.
- Native adapters accept explicit inputs and must fail honestly when unavailable. Never substitute a browser package for a native executable.
- Commit and push do not authorize local tests or checks. Run the narrow checks
  that own the changed contract only when the user explicitly requests them or
  as part of a selected distribution or release. Hosted source validation and
  documentation or Pages checks are release-publication evidence, not ordinary
  development checkpoints.
