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

`Check` validates the source once, then one unprivileged producer packs one
`.tgz` under pinned Node and npm versions. The producer writes a canonical
manifest containing the source SHA, clean-checkout flag, package inventory,
byte length, SHA-256, npm SHA-1 shasum, and SHA-512 integrity. Windows x64,
Linux x64, and a real macOS arm64 runner use the declared Node `22.23.2` floor
and each download that same Actions
artifact by immutable artifact id. They never repack it. Each runner verifies
the receipt, installs the tarball into a disposable project, exercises
`npm exec --offline -- arcane`, and runs one small capability contract through
the installed package's `arcane-test.mjs`. A final readiness job verifies the
same artifact's identity, integrity, shasum, license inventory, and content
boundary once. Browser/process simulations, Pages, Examples, and presentation
work are post-registry follow-through rather than npm publication gates.

`publish-dev.yml` can run only when manually dispatched from `main` in
`TheWizardNexus/arcane-os-sdk`. Dispatch requires an authorized npm content
classification. `unresolved` fails closed. `standard` permits the workflow's
direct trusted-publishing path only when the package has no conflicting
dual-use declaration. `dual-use` fails closed until the package includes npm's
persistent `contentPolicy.class=dual-use` metadata and root `DISCLOSURE`, and
the workflow is deliberately changed to `npm stage publish` plus human 2FA
promotion. Direct trusted publishing is not permitted for that class.

For the standard path, the workflow authenticates a successful `Check` push
run for that exact `main` SHA, downloads its immutable package artifact,
reverifies the manifest and bytes, derives `dev` or `latest` from the strict
version, and publishes the downloaded `.tgz`. It
never invokes `npm pack` or `npm publish .` under publication authority. A
repository-wide concurrency group prevents simultaneous publication jobs;
GitHub may replace an older pending dispatch, and each surviving dispatch is
safe to rerun. Preflight rejects byte mismatches, tag rollback, malformed
registry state, or any dist-tag other than `dev` and `latest`; an
already-published matching version is an idempotent success. The historical
first-version state where both tags identify `0.1.0-dev.5` is accepted only
with its recorded integrity and shasum and only while no stable version exists.
Post-publication verification preserves the other channel, checks integrity
and shasum, and validates trusted-publisher provenance. It tolerates npm's
publish-time scanning for up to 15 minutes. If
scanning or manual review remains pending, the workflow reports that state and
a rerun safely resumes verification without republishing immutable bytes.

The unscoped package installs both `arcane` and `arcane-os`. The short command
is the documented default; `arcane-os` is the collision-safe fallback. npm
package names are unique, but executable names are not globally reserved.

When `npm view arcane-os@dev version` reports the package unavailable, run
`npm run pack:local` in this SDK checkout for local development, scaffold with
`node ./bin/arcane.mjs new ...`, and install the resulting `.tgz` into the app
with `npm install --save-dev --save-exact <path>`. Keep the tarball at the path
recorded by `package-lock.json`; subsequent `npm ci` verifies its recorded npm
integrity. Arcane separately requires the installed package to identify exactly
as `arcane-os@0.1.0-dev.5` and verifies the locked runtime. A local directory
`file:` install is intentionally unsupported because it may be linked.

The first-version bootstrap established these permanent audit boundaries:

1. Push the intended clean `main` commit and require the complete Check workflow,
   including the exact-artifact Windows/Linux/macOS matrix, to pass.
2. Review the uploaded tarball inventory, manifest, checksum, and license
   notices. Ensure the Arcane OS monorepo package is private so it cannot publish
   the same npm name accidentally.
3. Make and record the npm content-policy decision before packing the bootstrap
   bytes. A `standard` decision permits direct OIDC after bootstrap. A
   `dual-use` decision requires `contentPolicy.class=dual-use`, a root
   `DISCLOSURE` in the tarball, and staged publication with human 2FA promotion;
   npm treats that declaration as persistent across versions.
4. Because npm requires a package to exist before trusted or staged publishing
   can be configured, an authorized npm maintainer must download that exact
   green Actions artifact and publish its `.tgz` once under `dev` through an
   interactive session with 2FA. That method is permitted for either content
   class; the dual-use metadata and disclosure must already be inside the exact
   tarball. Do not rebuild or repack it for this bootstrap. After the package
   exists, standard releases may publish directly through OIDC, while dual-use
   releases must use `npm stage publish` and human 2FA promotion.
5. Verify the registry's `dist.integrity` and shasum. npm's required bootstrap
   state has both `dev` and `latest` at the immutable `0.1.0-dev.5` bytes
   until the first stable publish moves only `latest`. The sole trusted
   publisher is the exact `publish-dev.yml` workflow and `npm` environment.
6. Later standard development versions may use the workflow's direct OIDC
   authority. A dual-use version must be staged and promoted with human 2FA.
   Any missing policy decision, package bootstrap, environment, publisher
   binding, or exact-SHA artifact is a publication blocker rather than a reason
   to fall back to a token or repack.

Generated app CI uses `npm ci --ignore-scripts`, so its lock must exist and its
dependency source must be reachable by the runner. A sibling local tarball is a
workstation workflow, not a portable GitHub dependency source; switch to the
exact registry release (or deliberately vendor the tarball) before remote CI.

## Reusable application release workflow

External app repositories can call `.github/workflows/release-app.yml` by an
immutable SDK repository revision. The reusable workflow checks out the exact
caller SHA, installs only the caller's committed dependency lock, requires
`arcane-os@0.1.0-dev.5`, and checks, packages, bundles, independently verifies,
and uploads one explicitly selected app. Every third-party action reference is
pinned to a full commit SHA. The workflow never publishes npm, creates a GitHub
Release, loops across apps, or changes Arcane admission state.

The build job holds only `contents: read`; its caller-owned checks, package
scripts, and adapters never receive `id-token: write` or `attestations: write`.
It uploads the exact bundle together with canonical metadata. A fresh
caller-code-free job downloads that upload by immutable artifact id, checks out
the called workflow's exact SDK revision, directly imports its verifier under
supported Node 24, binds the receipt app id to the requested app, and exposes
the independently reverified artifact, descriptor, and release identities as
the reusable workflow outputs. This post-upload boundary prevents a background
caller process from making the published outputs describe pre-upload bytes.

GitHub artifact attestation is an explicit `attest: true` input and is false by
default because availability for private repositories depends on the caller's
GitHub plan. A caller that requests an unsupported attestation fails instead of
silently producing weaker provenance. GitHub does not let a called workflow
raise the caller job's permission ceiling. An attesting caller must therefore
grant these permissions on the reusable-workflow job itself (prefer this
job-scoped grant over workflow-wide authority):

```yaml
jobs:
  release-app:
    permissions:
      contents: read
      id-token: write
      attestations: write
    uses: TheWizardNexus/arcane-os-sdk/.github/workflows/release-app.yml@<FULL_40_CHARACTER_COMMIT_SHA>
    with:
      app-id: example-app
      attest: true
```

Without that caller grant, `attest: true` fails even when the repository plan
supports artifact attestations. When requested, a fresh privileged job
depends on the successful post-upload verifier, downloads the same immutable
artifact id with the pinned `actions/download-artifact` revision, checks out only
`job.workflow_repository` at `job.workflow_sha`, selects supported Node 24 via
the pinned `actions/setup-node` revision, and directly imports the
dependency-free verifier from those trusted SDK source bytes. It rechecks the
app id, bundle structure, digest, byte length, complete
canonical metadata, and every post-upload workflow output. No package manager,
dependency resolution, caller checkout, or caller-owned code runs while that job
holds OIDC and attestation permissions. Whether attested or not, the upload is a
build output.
Arcane must verify an approved provenance or independent signature and an
Arcane-owned authorization-lock entry before installation; the archive's
internal checksums alone do not grant authority.

Stable versioning, the npm `latest` tag, and an official GitHub release remain a
separate explicit release decision. Current `main` development does not
silently convert a `-dev` package into an official release. A stable release
must publish the same source-validated and platform-smoked `.tgz` under
`latest`; only after registry
integrity matches may GitHub attach that `.tgz`, manifest, and checksum. Its Git
tag and GitHub release title must both be the same bare numeric
`MAJOR.MINOR.PATCH`. Prerelease versions do not get a misleading numeric
GitHub release, and no release creates a Git branch for an npm dist-tag.

## Documentation publication

GitHub Pages publishes the static `site/` tree from the newest successful
`main` push `Check`. A completed Check triggers the Pages job, which resolves
the newest successful receipt at deployment time so out-of-order completion
cannot roll the site backward. It checks out that authenticated SHA without
persistent credentials, validates the static tree, and uploads only `site/`.
It does not rerun the SDK test suite or execute repository build code.

The deployment job holds only the read, Pages, and OIDC permissions required by
that single checked artifact. The `github-pages` environment remains the final
deployment authority. Documentation channels are post-registry presentation
work and do not change the canonical source branch.

## Work-amplification record

The release graph is one checked `main` SHA and one npm release candidate. One
source-validation job runs the suite once; one producer creates the tarball;
three small installed-package consumers execute those exact bytes on Windows,
Linux, and macOS; and one readiness job verifies identity and legal inventory.
OIDC publication reuses that successful exact-SHA artifact without rebuilding.
Pages and broader presentation work follow registry verification separately.
