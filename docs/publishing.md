# npm publication

## Canonical main and npm channels

`main` is the single canonical working and publication branch before and after
the first release. Do not create a development branch. `-dev` versions select
the npm `dev` dist-tag, while bare numeric stable versions select
`latest`. These are registry channels, not Git branches.

## Stable and development npm publication

The package version and `publishConfig.tag` must agree exactly: `-dev` uses
`dev`, and a bare numeric stable version uses `latest`. npm is the canonical
SDK distribution: application repositories add an exact `arcane-os` project
dependency and invoke its local CLI with `npm exec -- arcane`. A separate
global installer, standalone SDK executable, NuGet package, Homebrew formula,
or OS package is not part of this release surface.

Publication checks run only after the user explicitly selects an npm release.
That selected-release workflow validates package metadata, the executable and
`.gitattributes` boundary, the complete package inventory, version/channel
agreement, and required license notices. One unprivileged producer packs one
`.tgz` under the selected Node and npm versions and uploads it as one Actions
artifact with a recorded run id, artifact id, version, and source commit. It
does not impose byte counts, hashes, digests, provenance receipts, or unrelated
test suites as ordinary development gates. Broader integration, regression,
platform, browser, presentation, and documentation work remains separately
user selected.

`publish-dev.yml` can run only when manually dispatched from `main` in
`TheWizardNexus/arcane-os-sdk`. Dispatch supplies the exact successful Check
run id, artifact id, and numeric version. The workflow downloads that exact Check
artifact, derives `dev` or `latest` from its version, and publishes the selected
`.tgz`. It may check out current source only for the publication controller; it
never repacks current source and never invokes `npm pack` or `npm publish .`
under publication authority. A
repository-wide concurrency group prevents simultaneous publication jobs;
GitHub may replace an older pending dispatch, and each surviving dispatch is
safe to rerun. Preflight rejects tag rollback, malformed registry state, or any
dist-tag other than `dev` and `latest`; an already-published matching version
is an idempotent success. Post-publication status preserves the other channel
and reports npm's response. It tolerates npm's publish-time scanning. If
scanning or manual review remains pending, the workflow reports that state and
a rerun safely resumes without republishing the version.

The public `0.3.2` release is fixed to package-source commit
`445bd2d982f12e6ef8dd2b615c70512000cc5224`, selected Check run
`33264677687`, and publication/registry run `33264829711`. Its numeric Git tag
and GitHub release title are both `0.3.2`. Later documentation or example
commits do not replace that package authority.

The unscoped package installs both `arcane` and `arcane-os`. The short command
is the documented default; `arcane-os` is the collision-safe fallback. npm
package names are unique, but executable names are not globally reserved.

When `npm view arcane-os@dev version` reports the package unavailable, run
`npm run pack:local` in this SDK checkout for local development, scaffold with
`node ./bin/arcane.mjs new ...`, and install the resulting `.tgz` into the app
with `npm install --save-dev --save-exact <path>`. Keep the tarball at the path
recorded by `package-lock.json`; subsequent `npm ci` uses that declared package.
Arcane reads the installed package's name and version against the root
dependency declaration. A local directory `file:` install is intentionally unsupported because
it may be linked.

The npm package already has its trusted-publishing relationship. Each later
release therefore follows the same direct selected-artifact path: push the
intended `main` source, manually run Check for that exact revision, review the
resulting package inventory and legal notices, then manually dispatch
publication with that Check run and artifact. Confirm the selected version and
dist-tag after publication. Never rebuild or repack the artifact under
publication authority, and never substitute a different source revision.

Generated app CI uses `npm ci --ignore-scripts`, so its lock must exist and its
dependency source must be reachable by the runner. A sibling local tarball is a
workstation workflow, not a portable GitHub dependency source; switch to the
exact registry release (or deliberately vendor the tarball) before remote CI.

## Reusable application release workflow

The checked-in reusable workflow is not an ordinary supported release path
until its implementation matches the governing contract below.

External app repositories can call `.github/workflows/release-app.yml` from a
selected SDK repository revision. The reusable workflow checks out the selected
caller commit, installs only the caller's committed dependency lock, packages,
bundles, and uploads one explicitly selected app. Any tests, checks, or artifact
verification run only because that release output was explicitly selected.
The workflow never publishes npm, creates a GitHub Release, loops across apps,
or changes Arcane runtime policy.

The one build job holds only `contents: read`. It uses the caller's normal
locked installation, runs one selected `arcane package`, creates one selected
`arcane bundle`, and uploads that complete bundle. It creates no hashes, byte
identities, receipts, provenance records, or attestation sidecars and does not
run a second admission job.

Stable versioning, the npm `latest` tag, and an official GitHub release remain a
separate explicit release decision. Current `main` development does not
silently convert a `-dev` package into an official release. A stable release
must publish the exact selected Check artifact under `latest`; GitHub may then
attach that same package. Its Git
tag and GitHub release title must both be the same bare numeric
`MAJOR.MINOR.PATCH`. Prerelease versions do not get a misleading numeric
GitHub release, and no release creates a Git branch for an npm dist-tag.

## Documentation publication

Documentation publication occurs only when the user explicitly selects it. The
Pages job checks out that selected `main` revision without persistent
credentials and uploads only the static `site/` tree. It does not automatically
run the SDK test suite, checks, generators, or repository build code.

The deployment job holds only the read, Pages, and OIDC permissions required by
that selected artifact. The `github-pages` environment remains the final
deployment authority. Documentation channels are post-registry presentation
work and do not change the canonical source branch.

## Work-amplification record

The release graph is one selected `main` revision and one npm release candidate.
One producer creates the tarball. Publication names that producer's exact Check
run, artifact, and version and does not rebuild from a later checkout. The
release workflow checks only the publication contract and required legal
inventory for that selected output.
Platform matrices, full product regressions, Pages, and broader presentation
work remain separate user-selected operations.
