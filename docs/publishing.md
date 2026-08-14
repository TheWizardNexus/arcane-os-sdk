# Development publication

The current unpublished npm version is `0.1.0-dev.1` and `publishConfig.tag` is `dev`, so an
accidental publication does not become the default `latest` release.

The unscoped package installs both `arcane` and `arcane-os`. The short command
is the documented default; `arcane-os` is the collision-safe fallback. npm
package names are unique, but executable names are not globally reserved.

No npm publication has occurred yet. For local development, run
`npm run pack:local` in this SDK checkout, scaffold with
`node ./bin/arcane.mjs new ...`, and install the resulting `.tgz` into the app
with `npm install --save-dev --save-exact <path>`. Keep the tarball at the path
recorded by `package-lock.json`; subsequent `npm ci` verifies its recorded npm
integrity. Arcane separately requires the installed package to identify exactly
as `arcane-os@0.1.0-dev.1` and verifies the locked runtime. A local directory
`file:` install is intentionally unsupported because it may be linked.

Before the first publish:

1. Run `npm ci`, `npm run check`, and `npm run pack:inspect` from a clean clone.
2. Review the tarball allowlist and all license notices.
3. Ensure the Arcane OS monorepo package is marked private so it cannot publish
   the same npm name accidentally.
4. Authenticate an authorized TWiN npm owner and publish with
   `npm publish --access public --tag dev`, or configure the exact
   `publish-dev.yml` trusted publisher after the package exists.
5. Verify `dev` is the only dist-tag and add a second appropriate package owner.

Generated app CI uses `npm ci --ignore-scripts`, so its lock must exist and its
dependency source must be reachable by the runner. A sibling local tarball is a
workstation workflow, not a portable GitHub dependency source; switch to the
exact registry release (or deliberately vendor the tarball) before remote CI.

Stable `0.1.0` and the `latest` tag remain deferred until the external fixture
proves scaffold, development, test, check, package, verification, and the chosen
native target journey.
