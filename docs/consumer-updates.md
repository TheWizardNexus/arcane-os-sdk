# Consumer updates

Development applications track the published npm `latest` channel. Declare
`"arcane-os": "latest"` in the application's existing dependency section.
Preserve an existing package alias where the application needs it; Arcane OS,
for example, uses `"arcane-sdk": "npm:arcane-os@latest"` to avoid a name collision.
Pin an application's SDK version only when Roshi explicitly designates it as a
production build. An exact version recorded in `package-lock.json` records what
was installed; it does not turn a development application into a production pin.

## Development refresh

Each application's existing owner performs its refresh through the public npm
package workflow in its canonical `main` checkout. Coordinate the dependency
and Git mutation window before cleanup, preserve active processes and other
owners' work, and establish applicable dependency permissions before removing
the installed tree. Respect explicit project stops, including Lifeline.

1. Keep the SDK declaration at `latest` and preserve `package-lock.json`.
2. Resolve the exact application path and remove only that application's
   disposable `node_modules`, before pulling. Do not sweep sibling projects or
   shared caches.
3. Run `git pull` and observe the result. Preserve existing changes and stop the
   affected operation if the pull fails or leaves conflicts.
4. Run `npm i` through the application's supported install workflow, retaining
   its applicable lifecycle-script options.
5. Explicitly run `npm update arcane-os` to refresh only the SDK. For an existing
   alias, target its dependency key, such as `npm update arcane-sdk`.
6. Before materializing managed files or building, obtain npm's published
   `latest` version with a fresh registry lookup, such as
   `npm view arcane-os@latest version --prefer-online`. Read the actual installed
   package version and the lockfile's resolved SDK version. Both must match that
   published version. If the tag advances during the operation, refresh the SDK
   again and report the actual selected version.
7. Update managed SDK projections only through the application's supported
   public package workflow. Commit the intended declaration, retained updated
   lockfile, managed files, and relevant instructions through its normal owner.

A `latest` declaration and `npm i` alone are insufficient: an existing lockfile
can preserve an older resolution. Keep and update the lockfile instead of
deleting it and re-resolving unrelated dependencies. Surface installation and
compatibility failures; do not claim current adoption from a manifest label.

This dependency-result comparison is part of the requested refresh. It does
not authorize application tests, unrelated checks or dependency updates,
recurring polling, broad cleanup, or production administration. A later release
can advance `latest`; record the exact version selected by each refresh.

## Production builds

On Roshi's explicit production designation, record the selected exact SDK
version consistently in the dependency declaration, lockfile, managed
projections, and application instructions. Use the supported locked install
workflow, normally `npm ci`, to reproduce that selection. A production pin
records reproducibility, not a permanent ceiling on otherwise authorized
needed updates. Preserve an explicit update deferral or actual compatibility
constraint.

## Feature requests and release notices

Inspect the published SDK's public API and documentation before implementing a
request. If it already supports the requested behavior, tell the requesting
application owner which API and usage provide it and link directly to the
relevant documentation. Do not present unpublished source as available support.

After a release's npm version and channel are confirmed, notify only existing
application owners whose requests it addresses. Notify every requester covered
by matching, similar, or bundled requests when one shared feature serves them.
Do not send routine release broadcasts to unrelated consumers.

Each notice includes the exact published version and channel, requested
functionality delivered, its relevance, release notes or a changelog link,
direct API and usage documentation references, and required compatibility or
adoption steps. Keep publication evidence distinct from application behavior.
Deduplicate by version and recipient and retain send outcomes in the release
handoff. Report unreachable owners and resume missing deliveries.

After every release and applicable requester notices, update the documentation
and existing SDK website for all affected public contracts, including releases
with no requesters. Record those delivery outcomes separately. The SDK owner
retains this follow-through; application upgrades and tests remain with their
owners and never gate SDK publication. See [npm publication](publishing.md).
