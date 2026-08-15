# SDK channels and publication

## Branch authority

The SDK has two long-lived channels:

| Branch | Channel | Authority |
|---|---|---|
| `dev` | Development | Ordinary implementation, pull-request integration, full CI, the npm `dev` tag, and development documentation. |
| `main` | Production | The exact source revision selected for production and the production documentation root. |

GitHub's repository default remains `main`, so contributors must explicitly
select `dev` as the pull-request base. The full Node/platform matrix runs only
for a push to `dev` or a pull request whose base branch is `dev`. A commit is
promoted by fast-forwarding `main` to the exact commit SHA that already passed
the `dev` push workflow. Do not squash, create a merge commit, amend, or rebuild
the candidate during promotion: any of those operations creates a different SHA
and the promotion verification fails closed.

The `Promote main` workflow is a post-push verifier; it cannot prevent or undo a
Git ref update that GitHub already accepted. It does not rerun the full matrix.
It has only read
access to Actions evidence and asks GitHub for a successful `Check` push run
whose branch is `dev` and whose `head_sha` is exactly the new `main` SHA. Its
successful result is the production source-channel receipt used by Pages.

Administrative protection is a prerequisite, not optional follow-up work.
Protect `dev` with the four `Check` matrix jobs. Protect `main` with those same
exact-SHA check contexts, linear/fast-forward history, and a restricted push
allowlist; do not require a merge method that manufactures a new commit. Protect
the workflow files and restrict both the `github-pages` and `npm` environments
to their intended branch and reviewer policies. Do not enable npm trusted
publishing until those rules and workflow ownership are verified. Those GitHub
rules are external authority and are not created by the repository files. Until
an administrator applies and verifies them, `main` is only labeled as the
production channel: it is not an enforced production boundary, and Pages or
npm authority is not secure against a malicious or accidental direct update.

## Development npm publication

The current unpublished npm version is `0.1.0-dev.2` and `publishConfig.tag` is
`dev`, so an accidental publication does not become the default `latest`
release. `publish-dev.yml` can run only when manually dispatched from `dev` in
`TheWizardNexus/arcane-os-sdk`. Before npm receives OIDC authority, the workflow
authenticates a successful `Check` push run for that exact SHA. It reuses that
evidence and does not install dependencies or rerun the same suite.

The unscoped package installs both `arcane` and `arcane-os`. The short command
is the documented default; `arcane-os` is the collision-safe fallback. npm
package names are unique, but executable names are not globally reserved.

No npm publication has occurred yet. For local development, run
`npm run pack:local` in this SDK checkout, scaffold with
`node ./bin/arcane.mjs new ...`, and install the resulting `.tgz` into the app
with `npm install --save-dev --save-exact <path>`. Keep the tarball at the path
recorded by `package-lock.json`; subsequent `npm ci` verifies its recorded npm
integrity. Arcane separately requires the installed package to identify exactly
as `arcane-os@0.1.0-dev.2` and verifies the locked runtime. A local directory
`file:` install is intentionally unsupported because it may be linked.

Before the first development publish:

1. Run `npm ci`, `npm run check`, and `npm run pack:inspect` from a clean clone
   on `dev`, then push that unchanged commit and wait for `Check` to pass.
2. Review the tarball allowlist and all license notices.
3. Ensure the Arcane OS monorepo package is marked private so it cannot publish
   the same npm name accidentally.
4. Configure npm trusted publishing for the exact `publish-dev.yml` workflow and
   its `npm` environment, then dispatch that workflow from the green `dev` SHA.
5. Verify `dev` is the only dist-tag and add a second appropriate package owner.

Generated app CI uses `npm ci --ignore-scripts`, so its lock must exist and its
dependency source must be reachable by the runner. A sibling local tarball is a
workstation workflow, not a portable GitHub dependency source; switch to the
exact registry release (or deliberately vendor the tarball) before remote CI.

Stable versioning, the npm `latest` tag, and production npm publication remain a
separate explicit release decision. `main` is the production source channel; it
does not silently convert a `-dev` package into a stable npm release.

## Documentation channels

GitHub Pages publishes one atomic artifact containing both documentation views:

- `https://thewizardnexus.github.io/arcane-os-sdk/` contains the `site/` tree
  from the latest successful `main` promotion.
- `https://thewizardnexus.github.io/arcane-os-sdk/dev/` contains the `site/`
  tree from the latest successful `dev` push check.

The development copy is generated with a persistent visible “Development
documentation” banner, a `/dev/` canonical URL, `noindex, nofollow`, and SDK
repository documentation/license links rewritten from `blob/main` to
`blob/dev`. The source `site/` tree is not rewritten. A successful `dev` check
requests a Pages refresh but cannot select new production bytes. A successful
`main` promotion verification requests a production refresh. Every refresh
resolves both channels from the latest successful workflow receipts so
out-of-order workflow completion cannot roll either channel backward.

The Pages assembly job can read Actions evidence and repository content but
cannot deploy. It sparsely checks out the authenticated production site and the
authenticated development site by exact SHA and selects the same Node 24 line
covered by the development matrix. Crucially, the channel builder is executed
from the production checkout, so development code cannot decide the production
root layout. The builder rejects links, special entries, overlapping
input/output paths, pre-existing output, and production-owned reserved paths;
it writes an atomic artifact and records both SHAs in
`.arcane-pages-channels.json`.

The separate deployment job receives only `pages: write` and `id-token: write`.
It checks out no branch and runs no repository script. GitHub's `github-pages`
environment remains the final deployment authority.

## Work-amplification record

The channel cardinality is two source sites and one Pages artifact. Each exact
`dev` SHA has one full CI matrix (four jobs: two Node versions by two operating
systems). Promotion and development publication add one small Actions-receipt
lookup each and reuse that matrix result. Pages adds two receipt lookups, at
most two sparse checkouts, one copy of each selected site, one development-only
metadata/banner transformation, one invariant Node 24 setup, one artifact
upload, and one deployment.

When both channels select the same SHA, Pages performs one sparse checkout and
uses its immutable bytes for both placements. For the current site, the measured
copy boundary is 8 files and 1,941,299 bytes per channel; the representative
two-channel cold path is therefore 16 source-file reads and 3,882,598 bytes
before generated metadata and artifact compression. The local channel builder
completed that work in 19 ms on the development workstation; hosted checkout,
upload, and deployment time is network-bound and remains visible in Actions.
Repetition of the two placements is justified because `/` and `/dev/` are
distinct published locations and the development placement has deliberately
different bytes.
