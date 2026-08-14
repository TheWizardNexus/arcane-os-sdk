# Architecture

The CLI, future Arcane Developer graphical control panel, CI, and Codex all use
one headless operation API. A client selects a named operation and consumes the
same structured event stream; the GUI is not a second build system.

```text
external app repository
        |
        +-- arcane CLI
        +-- Arcane Developer GUI (future)
        +-- Codex / CI
                 |
          shared toolchain API
                 |
       browser package or target adapter
```

## External workspace contract

The first SDK version deliberately preserves Arcane's current repository-shaped
URLs and release schema:

```text
apps/<id>/arcane-package.json
apps/<id>/index.html
dist/<id>/ARCANE_APP_RELEASE.json
```

The app's `arcane-packager.json` has three exact shared routes. They map the
installed SDK runtime to `/arcane`, its vendored strong-type dependency to
`/node_modules/strong-type`, and the SDK's `LICENSE`,
`COMMERCIAL-LICENSE.md`, and `NOTICE` to `/licenses/arcane-os`. The app does not
copy Arcane runtime source into its repository.

Release schema 1 and builder identity `arcane-app-packager-v1` remain unchanged
because current Arcane native admission treats them as exact contracts. Moving
capabilities, native security policy, publisher identity, and platform metadata
out of Arcane's central registry requires a coordinated manifest-v2 migration.

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
filesystem identities. The current browser run path authenticates that receipt
before serving it. Future native adapters and cross-process reuse require an
immutable retained artifact state and an authenticated Arcane broker; a path,
timestamp, environment variable, or receipt file alone is not authority.

The loopback server treats the mutable filesystem as an input, not as an
immutable receipt. Before sending headers it reads each requested source,
runtime, or packaged file into a bounded buffer, verifies the expected hash for
receipt-bound files, and repeats the handle/path identity check. A response is
therefore an exact verified byte snapshot even if another process writes during
the request. Development serving is limited to 64 MiB per file and four active
file responses, with a bounded wait queue.
