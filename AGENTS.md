# Arcane OS SDK repository instructions

- Until the first official SDK release, work directly on the single canonical
  `main` branch; do not create or use a development or feature branch.
- After the first official release, ongoing work moves to the long-lived `dev`
  branch and `main` remains the canonical released line. Activate that workflow
  only as part of the official-release change, with matching checks,
  publication rules, documentation channels, and branch protections.
- Current continuous integration, development publication, and documentation
  workflows authenticate `main`. Reuse exact-SHA evidence instead of rerunning
  an unchanged check.
- Use plain JavaScript and web standards. Do not introduce TypeScript or TSX.
- Keep the CLI and graphical clients on one shared headless toolchain contract.
- Every potentially blocking CLI operation must acknowledge first, own its work, stream progress or heartbeat events, support safe cancellation, and surface a nonzero exit status on failure.
- Default build cardinality is one workspace, one app, one target, one architecture, one format, and one signing profile. Never add implicit all-app or all-target loops.
- Reuse one immutable verification receipt for unchanged artifact bytes, policy, identity, location, and toolchain. Invalidate before mutation.
- Applications must use the shared Arcane theme and `ThemeBootstrap.js`; reusable behavior belongs in the Arcane runtime, not an app-local copy.
- Native adapters accept explicit inputs and must fail honestly when unavailable. Never substitute a browser package for a native executable.
- Run `npm run check` before committing and pushing.
