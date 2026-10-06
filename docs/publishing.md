# npm publication

## Canonical main and npm channels

`main` is the single canonical working and publication branch before and after
the first release. Do not create a development branch. `-dev` versions select
the npm `dev` dist-tag, while bare numeric stable versions select
`latest`. These are registry channels, not Git branches.

## Stable and development npm publication

The package version and `publishConfig.tag` must agree exactly: `-dev` uses
`dev`, and a bare numeric stable version uses `latest`. npm is the canonical
SDK distribution: development applications declare `arcane-os` as `latest` and
invoke its local CLI with `npm exec -- arcane`. An exact application SDK pin
begins only when Roshi designates that application as a production build.
Keep the lockfile and explicitly refresh and compare its resolution and the
installed SDK with npm's published version before materializing or building;
see [Consumer updates](consumer-updates.md). A separate
global installer, standalone SDK executable, NuGet package, Homebrew formula,
or OS package is not part of this release surface.

The user's standing instruction selects publication when a coherent SDK change
is complete. Publish every ready change that preserves required functionality
and remains relevant, while excluding unfinished concurrent or explicitly
deferred work. Default to a patch release and assess whether a new capability
warrants a minor revision. Honor an explicit no-publish instruction.

Publication checks run only for that selected npm release output.
That selected-release workflow validates package metadata, the executable and
`.gitattributes` boundary, the complete package inventory, version/channel
agreement, and required license notices. One unprivileged producer packs one
`.tgz` under the selected Node and npm versions and uploads it as one Actions
artifact with a recorded run id, artifact id, version, and source commit. It
does not impose byte counts, hashes, digests, provenance receipts, or unrelated
test suites as ordinary development gates. Broader integration, regression,
and platform work remains separately user selected. Documentation and website
updates are required post-publication follow-through as described below.

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

External applications consume published npm releases. An unavailable release
does not authorize them to use an unpublished SDK checkout or tarball. Only
tasks explicitly collaborating on an SDK update inside this project may use
the local `npm run pack:local` workflow and its resulting `.tgz`. That local
workflow can scaffold with `node ./bin/arcane.mjs new ...` and install the tarball
with `npm install --save-dev --save-exact <path>`. Keep the tarball at the path
recorded by `package-lock.json` for subsequent `npm ci`. Arcane reads the installed
package's name and version against the root dependency declaration. A local
directory `file:` install is unsupported because it may be linked.

The npm package already has its trusted-publishing relationship. Each later
release therefore follows the same direct selected-artifact path: push the
intended `main` source, manually run Check for that exact revision, review the
resulting package inventory and legal notices, then manually dispatch
publication with that Check run and artifact. Confirm the selected version and
dist-tag after publication. Never rebuild or repack the artifact under
publication authority, and never substitute a different source revision.

Generated app CI uses `npm ci --ignore-scripts`, so its lock must exist and its
dependency source must be reachable by the runner. External application CI uses
the published registry package recorded in the committed lockfile. A locked
install reproduces that selected version; it does not establish that the SDK is
currently npm's `latest`. Complete the development refresh before preparing and
committing managed application files and the updated lockfile for CI.

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

Stable versioning, the npm `latest` tag, and an official GitHub release follow
the selected release decision, including the standing completed-work authority
above. Unfinished `main` development does not select a release. A stable release
must publish the exact selected Check artifact under `latest`; GitHub may then
attach that same package. Its Git
tag and GitHub release title must both be the same bare numeric
`MAJOR.MINOR.PATCH`. Prerelease versions do not get a misleading numeric
GitHub release, and no release creates a Git branch for an npm dist-tag.

## Native runtime assets on numeric releases

Default SDK-hosted native asset URLs use the installed SDK's version and its
matching numeric GitHub release. Publishing npm alone does not make those
downloads available. Every applicable numeric release therefore includes its
compatible retained SDK-hosted assets as release follow-through:

| Selected capability | Windows x64 release asset |
| --- | --- |
| Native application host | `arcane-native-windows-x64.tar.gz` |
| Ordinary native Whisper helper | `arcane-whisper-windows-x64.tar.gz` |
| Optional Intel NPU Whisper encoder | `arcane-whisper-openvino-windows-x64.tar.gz` |

Attach each asset used by the selected package's default SDK-hosted download
paths, including later releases whose native implementation is unchanged.
Include the optional NPU asset when that release supplies `encoder:
"openvino-npu"`; applications still opt in, and the ordinary Whisper asset
remains available. Upstream runtime and model versions retain their separate
upstream distribution URLs; they are not renamed to the SDK version.

Reuse the producer's retained compatible archive and its recorded selected
evidence. Do not rebuild or redownload an unchanged archive for each release.
An actual native change belongs to its producer under the existing build and
dependency authority. Preserve the complete runtime closure and its packaging
notices together. Models continue through their upstream acquisition path
unless their redistribution is separately requested.

The release owner assigns each upload, observes its outcome and records the
exact asset name and public release URL in the durable release handoff. If an
upload result is uncertain, inspect that release's existing asset before
retrying. Retain the exact pending operation, executing owner and last result
until delivery finishes; reassign idle delegated work rather than treating
delegation as completion.

Source delivery, selected package verification, npm publication, native asset
delivery, requester notices and documentation/site delivery are distinct.
Native archive follow-through does not gate npm publication or require a new
package build. Consumer adoption remains with each application owner.

## Documentation publication

After every successful npm release and its applicable requester notices, the
SDK owner updates documentation and the existing SDK website for all added,
removed, or modified features, APIs, members, methods, and affected public
contracts. Include the relevant signatures, inputs, outputs, defaults,
lifecycle, errors, platform availability, and usage examples. This standing
duty also applies when a release has no requesting applications. Record the
actual documentation and website delivery outcomes in the release handoff and
report any unfinished work. See [Consumer updates](consumer-updates.md) for
request intake and notice requirements.

Documentation and website content outside the selected npm payload does not
block npm publication. Prepare and deliver those updates through the existing
documentation/site workflow after publication; do not wait for consumer
adoption or application tests. This duty does not authorize ChatGPT Sites or
production-server administration.

The Pages job checks out the selected `main` revision without persistent
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
Platform matrices and full product regressions remain separate user-selected
operations. Documentation and the existing website are required post-release
follow-through, with their outcomes recorded separately from npm publication.
