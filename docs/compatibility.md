# Arcane application compatibility

Arcane application compatibility is a capability contract, not an exact
runtime-version pin. An app may run on a newer Arcane Core when the host meets
all of the app's declared requirements.

For the selected app and every declared bundled app, admission requires:

- the requested target is declared by that app;
- the host Core version is greater than or equal to
  `requirements.minimumCoreVersion`;
- `requirements.arcaneProtocol` matches the host protocol generation;
- every declared `requirements.features` entry is advertised by the host;
- every declared `permissions.capabilities` entry is available; and
- every declared `permissions.methods` entry is available.

The effective Core floor for a build is the highest minimum declared by the
SDK runtime, the selected app, and its complete bundled-app closure. The native
build plan authenticates the host toolchain receipt and checks every member of
that closure before a provider may read release bytes or mutate output.

This permits normal non-breaking Arcane upgrades. For example, an app requiring
Core `0.8.11` can run on `0.8.12` or `0.9.0` when the required protocol,
features, capabilities, and methods are still present. A higher version does
not override a missing contract.

Breaking changes must be visible at the contract boundary. A host must not
continue advertising an old protocol, feature, capability, or method when its
meaning or guarantees are no longer compatible. It must instead change the
protocol generation or contract identifier so admission fails closed before
launch.

Hashes and lock-file identities serve a different purpose. They establish
which SDK runtime, release, toolchain, and artifact bytes were verified for one
build state; they do not require the installed Arcane version to equal the
app's minimum version forever.
