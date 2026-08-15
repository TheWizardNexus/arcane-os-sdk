# Arcane OS SDK repository instructions

- `main` is the production branch. Do not develop directly on it or move it to a
  commit that has not already passed the full `dev` branch check at that exact
  SHA.
- `dev` is the long-lived development working and integration branch. Pull
  requests explicitly target `dev`; promotion fast-forwards `main` to the exact
  already-green `dev` commit without a merge or squash commit.
- Full continuous integration belongs to pushes on `dev` and pull requests
  targeting `dev`. Promotion, publication, and documentation workflows
  authenticate and reuse that exact-SHA evidence instead of rerunning it.
- Repository administrators must protect `main`, `dev`, the workflow files, and
  the `github-pages` and `npm` environments before treating this policy as a
  production or publication boundary. The source-controlled post-push verifier
  reports an invalid main move but cannot undo or prevent a ref update accepted
  by GitHub.
- Use plain JavaScript and web standards. Do not introduce TypeScript or TSX.
- Keep the CLI and graphical clients on one shared headless toolchain contract.
- Every potentially blocking CLI operation must acknowledge first, own its work, stream progress or heartbeat events, support safe cancellation, and surface a nonzero exit status on failure.
- Default build cardinality is one workspace, one app, one target, one architecture, one format, and one signing profile. Never add implicit all-app or all-target loops.
- Reuse one immutable verification receipt for unchanged artifact bytes, policy, identity, location, and toolchain. Invalidate before mutation.
- Applications must use the shared Arcane theme and `ThemeBootstrap.js`; reusable behavior belongs in the Arcane runtime, not an app-local copy.
- Native adapters accept explicit inputs and must fail honestly when unavailable. Never substitute a browser package for a native executable.
- Run `npm run check` before committing and pushing.
