# Development publication

## Current branch stage

Until the first official SDK release, `main` is the single canonical working,
integration, publication, and documentation branch. Pull requests and pushes
target `main`, and the complete Node/platform matrix runs there. Do not use a
separate development branch during this prerelease stage.

After the first official release, ordinary work will move to a long-lived
`dev` branch while `main` remains the canonical released line. That transition
must be made as one explicit release change that updates branch protections,
checks, trusted publication rules, documentation channels, and contributor
instructions together. The future branch name alone grants no authority.

## Development npm publication

The current unpublished npm version is `0.1.0-dev.4` and `publishConfig.tag` is
`dev`, so an accidental publication does not become the default `latest`
release. `publish-dev.yml` can run only when manually dispatched from `main` in
`TheWizardNexus/arcane-os-sdk`. Before npm receives OIDC authority, the workflow
authenticates a successful `Check` push run for that exact `main` SHA. It reuses
that evidence instead of installing dependencies and rerunning the same suite.

The unscoped package installs both `arcane` and `arcane-os`. The short command
is the documented default; `arcane-os` is the collision-safe fallback. npm
package names are unique, but executable names are not globally reserved.

No npm publication has occurred yet. For local development, run
`npm run pack:local` in this SDK checkout, scaffold with
`node ./bin/arcane.mjs new ...`, and install the resulting `.tgz` into the app
with `npm install --save-dev --save-exact <path>`. Keep the tarball at the path
recorded by `package-lock.json`; subsequent `npm ci` verifies its recorded npm
integrity. Arcane separately requires the installed package to identify exactly
as `arcane-os@0.1.0-dev.4` and verifies the locked runtime. A local directory
`file:` install is intentionally unsupported because it may be linked.

Before the first development publish:

1. Run `npm ci`, `npm run check`, and `npm run pack:inspect` from a clean clone
   on `main`, push that unchanged commit, and wait for `Check` to pass.
2. Review the tarball allowlist and all license notices.
3. Ensure the Arcane OS monorepo package is marked private so it cannot publish
   the same npm name accidentally.
4. Configure npm trusted publishing for the exact `publish-dev.yml` workflow and
   its `npm` environment, then dispatch that workflow from the green `main` SHA.
5. Verify `dev` is the only npm dist-tag and add a second appropriate package
   owner. The npm tag is independent of the future Git development branch.

Generated app CI uses `npm ci --ignore-scripts`, so its lock must exist and its
dependency source must be reachable by the runner. A sibling local tarball is a
workstation workflow, not a portable GitHub dependency source; switch to the
exact registry release (or deliberately vendor the tarball) before remote CI.

## Reusable application release workflow

External app repositories can call `.github/workflows/release-app.yml` by an
immutable SDK repository revision. The reusable workflow checks out the exact
caller SHA, installs only the caller's committed dependency lock, requires
`arcane-os@0.1.0-dev.4`, and checks, packages, bundles, independently verifies,
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

Stable versioning, the npm `latest` tag, and official npm publication remain a
separate explicit release decision. Current `main` development does not
silently convert a `-dev` package into an official release.

## Documentation publication

GitHub Pages publishes the static `site/` tree from the newest successful
`main` push `Check`. A completed Check triggers the Pages job, which resolves
the newest successful receipt at deployment time so out-of-order completion
cannot roll the site backward. It checks out that authenticated SHA without
persistent credentials, validates the static tree, and uploads only `site/`.
It does not rerun the SDK test suite or execute repository build code.

The deployment job holds only the read, Pages, and OIDC permissions required by
that single checked artifact. The `github-pages` environment remains the final
deployment authority. A separate `/dev/` documentation channel is deferred to
the same explicit post-release branch transition described above.

## Work-amplification record

The prerelease branch cardinality is one checked `main` SHA, one static site,
and one Pages artifact. The four-job Check matrix (two Node versions by two
operating systems) owns validation for that SHA. Development publication and
Pages each perform one small exact-SHA evidence lookup or authentication step
and reuse the successful matrix result. Pages performs one checkout, one static
tree validation, one artifact upload, and one deployment; it does not create a
second site placement or run a second SDK check.
