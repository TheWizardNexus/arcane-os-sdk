# Architecture

The CLI, future Arcane Developer graphical control panel, CI, and Codex all use
one headless operation API. A client selects a named operation and consumes the
same structured event stream; the GUI is not a second build system.

```text
external app repository -----+
                              |
integrated Arcane checkout ---+-- CLI / future GUI / Codex / CI
                                      |
                               shared toolchain API
                                      |
                       browser package or explicit target adapter
```

## Workspace profiles

An external workspace maps the exact runtime shipped by its locked `arcane-os`
dependency. An integrated workspace maps the live `arcane/` and
`node_modules/strong-type` directories already owned by the Arcane checkout.
The development server and packager consume the same route destinations in
both cases, so app imports do not change. Integrated initialization creates
only app-owned files and never rewrites Arcane root configuration.

## App and release contract

The first SDK version deliberately preserves Arcane's current repository-shaped
URLs and release schema:

```text
apps/<id>/arcane-app.json
apps/<id>/arcane-package.json
apps/<id>/index.html
dist/<id>/ARCANE_APP_RELEASE.json
```

The authored schema-2 descriptor is canonical for new apps and projects an
exact schema-1 `arcane-package.json` for current consumers. Existing Arcane
apps synthesize that descriptor from their schema-1 package plus the current
native registry during migration.

An external app's `arcane-packager.json` has three exact shared routes. They map the
installed SDK runtime to `/arcane`, its vendored strong-type dependency to
`/node_modules/strong-type`, and the SDK's `LICENSE`,
`COMMERCIAL-LICENSE.md`, and `NOTICE` to `/licenses/arcane-os`. The app does not
copy Arcane runtime source into its repository.

Release schema 1 and builder identity `arcane-app-packager-v1` remain unchanged
because current Arcane native admission treats them as exact contracts. Native
builders authenticate the schema-2 descriptor digest as a
separate build input while exact v1 host artifacts remain unchanged.

## Operation ownership

An invocation defaults to one workspace, one app, one command, one target, one
architecture, one format, and one signing profile. It acknowledges before long
work, uses one `AbortController`, supervises child processes, and routes progress
through one serialized owned event queue. Process streams apply pause/resume
backpressure and heartbeats coalesce. Callback failure cancels owned work, drains
the queue, and reaches the caller or CLI exit status. Packaging preserves prior
output until verified replacement.

## Verification receipts

Runtime verification binds the exact SDK version, upstream Arcane commit,
runtime inventory, byte counts, and SHA-256 hashes. Packaging writes the full
schema-1 release inventory to `ARCANE_APP_RELEASE.json`; its operation result
returns a deeply immutable, process-authenticated receipt that binds the
canonical location, app policy, complete inventory, content digest, and verified
filesystem identities. The browser run path authenticates that receipt before
serving it, and every native provider consumes release bytes through SDK-bound
verified readers before verifying its app-scoped artifact. Windows and Linux
retain artifact authority for same-process verification and launch. Persistent
cross-process reuse still requires an authenticated Arcane broker; a path,
timestamp, environment variable, or receipt file alone is not authority.

The loopback server treats the mutable filesystem as an input, not as an
immutable receipt. Before sending headers it reads each requested source,
runtime, or packaged file into a bounded buffer, verifies the expected hash for
receipt-bound files, and repeats the handle/path identity check. A response is
therefore an exact verified byte snapshot even if another process writes during
the request. Development serving is limited to 64 MiB per file and four active
file responses, with a bounded wait queue.

## Native provider boundary

The SDK implements protocol `arcane-native-build-plan/1` and the injected
provider contract `arcane-native-builder/1`. Pairing is process-local; it never
registers a mutable global provider or searches for a toolchain. For each
supported native target, the CLI loads one fixed provider module from the
explicit `--arcane-root` Arcane OS checkout. Provider code is bound to one
process generation; if a pull changes any loaded provider module, the SDK fails
closed and requires a fresh worker rather than combining new hashes with Node's
cached old modules. One paired toolchain can perform this lifecycle:

```text
doctor -> prepare -> plan -> build -> verify receipt -> run receipt
```

The portable provider implements the lifecycle through verification and fails
honestly on run because its result is a directory. Windows x64 and Linux x64
also implement same-process launch and owned cancellation. Windows uses a
retained per-build broker and authenticated host readiness; Linux produces a
verified amd64 DEB and runs a retained user-owned extraction without install or
elevation. All three are unsigned local-development profiles.

The plan binds one explicit `toolchainRoot` and authenticated receipt, one app
release root and receipt, its approved schema-2 descriptor digest, only its
declared dependency releases, one non-overlapping output root, and one target,
platform, architecture, format, and signing request. App source and workspace
paths are withheld from the native provider. The provider copies release bytes
through SDK-bound verified readers rather than accepting a mutable source path
as authority. Build completion requires provider verification, and later
verify/run calls receive the exact artifact receipt.

The SDK `0.1.0-dev.1` runtime requires Arcane `0.8.11` or newer. Compatibility
is contractual rather than exact-version pinning: the prepared Core must meet
the highest minimum declared by the runtime, selected app, and bundled app
dependencies; keep each app's Arcane protocol generation; and provide every
declared feature, capability, and method. Missing requirements stop before
provider build; a newer compatible Core is accepted. Exact hashes
remain integrity identities, not compatibility rules. The provider paths have
been validated from independent workspaces. They do not copy proprietary source
into the Arcane checkout.

See [compatibility.md](compatibility.md) for the complete app and bundled-app
admission rule and the required handling of breaking contract changes.

Linux ARM64 and Android ARM64 remain deferred. Production signing, installation,
update continuity, and release acceptance are also outside these development
providers; a successful unsigned local build is not evidence for those gates.
