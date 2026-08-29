# Arcane application compatibility

Arcane application compatibility is a capability contract, not an exact
runtime-version pin. An app may run on a newer Arcane Core when the host meets
all of the app's declared requirements.

For a browser-only app, `permissions`, `security`, and
`requirements.minimumCoreVersion` may be omitted. Missing permissions normalize
to empty capability and method sets, and missing security normalizes to empty
origin declarations with optional hardening disabled. Existing explicitly
authored records remain unchanged.

When the selected target actually uses Arcane Core, compatibility requires:

- the requested target is declared by that app;
- the host Core version is greater than or equal to the explicitly declared
  `requirements.minimumCoreVersion`;
- `requirements.arcaneProtocol` matches the host protocol generation;
- every declared `requirements.features` entry is advertised by the host;
- every declared `permissions.capabilities` entry is available; and
- every declared `permissions.methods` entry is available.

The effective Core floor for a native build is the highest minimum explicitly
declared by the SDK runtime, the selected app, and its complete bundled-app
closure. Browser-only targets do not invent a Core floor. The native build plan
checks every member of that closure before producing output.

This permits normal non-breaking Arcane upgrades. For example, an app requiring
Core `0.8.12` can run on `0.8.13` or `0.9.0` when the required protocol,
features, capabilities, and methods are still present. A higher version does
not override a missing contract.

Breaking changes must be visible at the contract boundary. A host must not
continue advertising an old protocol, feature, capability, or method when its
meaning or guarantees are no longer compatible. It must instead change the
protocol generation or contract identifier so the incompatibility is reported
before launch. Ordinary compatibility does not depend on byte counts, hashes,
digests, provenance receipts, or optional security declarations.
