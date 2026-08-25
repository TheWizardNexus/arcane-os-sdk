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
- For rapid development, use `arcane dev`. It serves the selected application's canonical source files with the live mapped SDK/runtime dependencies, so saved source changes appear on browser refresh without packaging, copying files into `dist`, or restarting the server.
- For package and release verification, package explicitly and use `arcane run --target browser`. It serves only the verified `dist/<id>` release and must not substitute source files. Never use `dist` as the rapid-development tree or source serving as release evidence.
- Native adapters accept explicit inputs and must fail honestly when unavailable. Never substitute a browser package for a native executable.
- Run the narrow checks that own the changed contract before committing and
  pushing. The hosted source-validation job runs `npm run check:release` once
  per SHA; documentation and Pages checks follow registry publication.
