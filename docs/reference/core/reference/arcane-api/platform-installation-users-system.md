# Arcane API platform, installation, users, and system guides

These methods report or change host-level state. Feature-detect the public
member and use the capability and method inventory exposed by the current host
before presenting a control. A grant never replaces a method's input,
privilege, identity, freshness, or confirmation checks.

Core operations that return an `operation` record also emit future-only
`operation.started`, `operation.progress`, `operation.log`,
`operation.completed`, or `operation.failed` events. Subscribe before calling
the method, correlate by `operationId`, and release the returned unsubscribe
function. An operation result can complete with warnings; inspect
`warningCount` and the method-specific readiness fields.

## Arcane.platform.status()

### Overview

`Arcane.platform.status()` returns the host, execution-evidence, renderer,
permission, application, and effective-capability snapshot for the bound
session. It is a repeatable read with no side effect or event. It requires
`system.read` and is available on Core and Android.

### Result and platform differences

Core returns exactly `platform`, `rawPlatform`, `displayName`, `architecture`,
`release`, `desktop`, `sessionType`, `simulated`, `adapter`, `version`,
`protocol`, `application`, `renderer`, `permissions`, `capabilities`, and
`execution`. Microsoft NT uses `platform: "windows"` and
`rawPlatform: "win32"`; Linux uses `"linux"` for both. `hostname` is
deliberately omitted.

`execution` is exactly
`{hostPlatform, effectivePlatform, simulation, evidenceClass}`. Core uses
`evidenceClass: "real-host"` or `"simulation"`. Android reports
`platform/rawPlatform: "android"` and
`execution: {hostPlatform:"android", effectivePlatform:"android",
simulation:false, evidenceClass:"application-host"}`. Simulation and Android
application-host evidence are not publisher, signing, or release-candidate
attestations.

`renderer` contains `id`, `available`, and nullable `version`, with host-specific
`adapter` or `executable` metadata. `permissions` has the shape documented by
`Arcane.permissions.status()`. `capabilities` is exactly `{app, grants,
methods}` and is the Android replacement for the Core-only direct
`Arcane.capabilities.list()` method.

### Errors and recovery

`METHOD_NOT_ALLOWED` or `ANDROID_CAPABILITY_DENIED` means `system.read` is not
granted. `METHOD_CONTRACT_OUTPUT_INVALID` means the host status failed its
closed shape or internal-consistency checks; repair the matching host and app
package rather than inferring platform state from user-agent strings.

### Example

```javascript
const status = await Arcane.platform.status();

console.log(status.displayName, status.architecture, status.release);
console.log(status.execution.evidenceClass);
console.log('Admitted methods', status.capabilities.methods);
```
## Arcane.permissions.status()

### Overview

`Arcane.permissions.status()` refreshes the Core host's permission/elevation
observation. It requires `system.read`, is Core-only, changes no privilege, and
emits no event. A true `canElevate` value describes the host mechanism; it does
not mean this read prompted for or obtained elevation.

### Result

The result is exactly `{elevated, level, canElevate, mechanism, detectedBy,
probes}`. `elevated` and `canElevate` are booleans; `mechanism` may be `null`;
`probes` contains bounded host-specific diagnostic records.

Microsoft NT normally reports `level` as `"standard"`, `"administrator"`, or
`"system"`, using UAC and an integrity-level probe. Linux reports `"standard"`
or `"root"` from the effective uid and also records whether its kernel peer
credential guard is available. Simulation returns explicitly simulated
mechanisms and probes. Never use a simulation result as evidence of real
administrator or root authority.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the application lacks `system.read`. A failed probe
normally remains visible in `detectedBy` and `probes`; a rejected request or
transport failure should be surfaced as unknown permission state, never treated
as elevated.

### Example

```javascript
const permissions = await Arcane.permissions.status();

if (!permissions.elevated) {
    console.log('This host session is not elevated.', permissions.level);
}
```

## Arcane.version.current()

### Overview

`Arcane.version.current()` returns the active Arcane OS host/bundle version for
this bridge session. It takes no parameters, needs no capability, and is
available on Core and Android. It is a repeatable read with no event or side
effect.

### Result

The result is one canonical semantic-version string no longer than 64
characters. It is the host release version, not an independently packaged
application's version; use `Arcane.app.current().version` for the latter. A
version string is not signer, integrity, update, or release-candidate evidence.

### Errors and recovery

`METHOD_CONTRACT_OUTPUT_INVALID` indicates that the host returned a value other
than its bound bundle version. Repair or update the host/package pair.
`ARCANE_TRANSPORT_UNAVAILABLE` means the page is not hosted by Arcane.

### Example

```javascript
const hostVersion = await Arcane.version.current();
const application = await Arcane.app.current();

console.log('Host', hostVersion, 'Application', application.version);
```

## Arcane.version.installation()

### Overview

`Arcane.version.installation()` calls the same `installation.status` RPC as
`Arcane.installation.status()`. It does not return a version string and does not
mutate or repair the installation. The alias requires `installation.read` on a
Core host and emits no event.

### Result and availability

The exact installation-status object is documented under
`Arcane.installation.status()`. Its `installedVersion` can be `null`, while
`packageVersion` identifies the active Provisioner package. Use
`disposition`, `action`, integrity, and identity fields together; comparing the
two version strings alone is not an installation trust decision.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the application lacks `installation.read`.
Installation identity or integrity errors must be shown with their supplied
resolution. This alias is not projected on Android.

### Example

```javascript
const installation = await Arcane.version.installation();

console.log(
    installation.installedVersion,
    installation.packageVersion,
    installation.disposition
);
```

## Arcane.machine.status()

### Overview

`Arcane.machine.status()` returns the Provisioner's combined machine-readiness
view. It requires `provisioning.manage`, an application of type `provisioner`,
and a Core host. It performs bounded status and verification reads but makes no
machine change and emits no event.

This result contains local account, filesystem-location, and installation
details. Keep it inside the trusted Provisioner UI; do not send or persist the
whole object as telemetry.

### Result

The exact top-level fields are `version`, `protocol`, `application`, `os`,
`nativeAdapter`, `identity`, `protectedUsername`, `protectedUsernames`,
`usernamePolicy`, `installation`, `requirements`, `permissions`, `renderer`,
`securityMode`, `publisherTrustSource`, `revocationStatus`,
`installedSecurityMode`, `paths`, `simulation`, `execution`, and `bundleRoot`.

`installation`, `requirements`, `permissions`, and `execution` use the same
shapes documented by their focused methods. `securityMode` and its evidence
describe the active host release; `installedSecurityMode` describes the
installed release or `"not-installed"`. Simulation remains labeled in both
`simulation` and `execution`.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the caller is not the admitted Provisioner or lacks
`provisioning.manage`. Status can also fail closed on invalid installation,
account, or filesystem evidence. Preserve the error's diagnostic id and follow
its repair guidance; do not remove failing fields and reinterpret the remainder
as ready.

### Example

```javascript
const machine = await Arcane.machine.status();

console.log(machine.os.displayName, machine.installation.disposition);
console.log('Simulation', machine.execution.simulation);
console.log('Required work', machine.requirements.filter(
    function findBlockingRequirement(requirement) {
        return requirement.blocking;
    }
));
```

## Arcane.user.current()

### Overview

`Arcane.user.current()` returns the privacy-minimized identity bound to the
current host session. It requires `identity.read` and is available on Core and
Android. It is a repeatable read with no event or side effect. It is not an
authentication token and cannot select another user.

### Result and platform differences

The exact result is `{identityKind, username, accountName, displayName,
source}`. Microsoft NT and Linux return `identityKind: "host-account"`,
nonempty `username`, `accountName`, and `displayName`, and `source` set to
`"windows"` or `"linux"`.

Android returns `identityKind: "local-session"`, `username: null`,
`accountName: null`, a bounded display name, and `source: "android"`. Do not
derive or synthesize an Android operating-system account identifier.

### Errors and recovery

`METHOD_NOT_ALLOWED` or `ANDROID_CAPABILITY_DENIED` means `identity.read` is not
granted. `METHOD_CONTRACT_OUTPUT_INVALID` means the identity violated the
privacy-minimized contract; treat identity as unavailable and repair the host.

### Example

```javascript
const identity = await Arcane.user.current();
const label = identity.identityKind === 'host-account'
    ? identity.displayName
    : 'Local Android session';

console.log(label, identity.source);
```

## Arcane.requirements.list()

### Overview

`Arcane.requirements.list()` returns all current Core installation requirement
records. It requires `requirements.read`, takes no parameters, changes nothing,
and emits no event. The result is a bare array, not a wrapper object.

### Result

The array currently contains `ollama`, `renderer`, and `session-control`.
Renderer and session-control records have exactly `id`, `name`,
`minimumVersion`, `required`, `installable`, `description`, `ready`,
`blocking`, `status`, `version`, `executable`, `message`, `platform`, and
`adapter`.

The Ollama record additionally has `requiredFor`, `requiredScope`, `detection`,
and `globalInstall`. `detection` separates machine-wide and user-scoped
observations; `globalInstall` is exactly `{available, status, action,
requiresElevation, provider, reason}`. Ollama is optional for base Arcane OS,
but required before local AI. Paths and process observations are local machine
data and should not be logged wholesale.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the app lacks `requirements.read`. A record whose
`ready` is false includes a human-facing `message`; only `blocking: true`
blocks base installation. Refresh the list after the operator resolves a
prerequisite rather than modifying the returned record.

### Example

```javascript
const requirements = await Arcane.requirements.list();

for (const requirement of requirements) {
    console.log(
        requirement.name,
        requirement.status,
        requirement.blocking
    );
}
```

## Arcane.requirements.ensure()

### Overview

`Arcane.requirements.ensure(requirementIds, options?)` checks and, only where an
approved installer is available, attempts to prepare selected requirements. It
requires `provisioning.manage`, the Provisioner application type, an elevated
Core worker, and the exclusive machine-mutation boundary.

Omitted, `null`, or empty `requirementIds` selects the required requirements
(`renderer` and `session-control`), not every listed optional requirement. A
nonempty array may contain each known id once and no more than the current
three-item inventory. Always pass an array deliberately: the JavaScript wrapper
normalizes a non-array first argument to the default selection.

`options` is either omitted or an exact plain object containing only
`userProcessInterruption`, set to `"deny"` or `"allow"`; the default is
`"deny"`. Use `"allow"` only after a separate, informed confirmation. The host
still re-verifies exact process and port identity and will not terminate an
unknown process.

### Result, side effects, and events

The exact result is `{requirements, operation, credentials}`. `requirements`
contains fresh records only for the selected ids. `credentials` is an array and
is normally empty. `operation` is the completed tracked-operation record with
`id`, `type`, `status`, timestamps, `progress`, `currentStep`,
`progressDetails`, `credentials`, `error`, and `warningCount`.

The operation can perform disk, network, process, or installation work and
emits the standard operation lifecycle events. Simulation changes only
simulation state and is not real readiness evidence.

### Errors and recovery

Invalid ids or options use `INVALID_REQUIREMENTS_ENSURE_REQUEST`; invalid
wrapper options throw `TypeError` before dispatch. Common host failures include
`ADMIN_REQUIRED`, `OPERATION_BUSY`, `REQUIREMENT_NOT_INSTALLABLE`,
`REQUIREMENT_VERIFY_FAILED`, and lease-release failures. Wait for a busy
operation, keep interruption denied unless separately approved, and follow the
specific requirement's recovery message.

### Example

```javascript
async function ensureBlockingRequirementsAfterConfirmation(confirmChange) {
    const requirements = await Arcane.requirements.list();
    const selected = requirements.filter(
        function selectBlockingRequirement(requirement) {
            return requirement.required && !requirement.ready;
        }
    ).map(function selectRequirementId(requirement) {
        return requirement.id;
    });

    if (selected.length === 0 || !confirmChange(selected)) {
        return null;
    }

    return Arcane.requirements.ensure(selected, {
        userProcessInterruption: 'deny'
    });
}
```

## Arcane.installation.status()

### Overview

`Arcane.installation.status()` reads the relationship between the active
Provisioner package and the installed Arcane OS state. It requires
`installation.read` on Core, makes no change, and emits no event. Status is
evidence for deciding what to present; it does not authorize a later mutation.

### Result

The exact fields are `present`, `installedVersion`, `packageVersion`, `blocked`,
`blockedReason`, `repairRequired`, `repairReason`, `disposition`, `action`,
`installRoot`, `stateRoot`, `manifest`, `installedPayloadMode`,
`installedIntegrity`, `installedIdentity`, `identityRepairRequired`,
`payloadRepairRequired`, `developmentTrustRepairRequired`,
`developmentMachineTrust`, `candidatePayloadDiffers`, and `payload`.

`disposition` is `"missing"`, `"downgrade-blocked"`, `"repair-required"`,
`"update-available"`, or `"current"`; `action` is `"install"`, `"blocked"`,
`"repair"`, `"update"`, or `"current"`. `payload` is exactly `{mode,
releaseReady, installable, description, missingRelease}`. The manifest and
integrity/identity evidence are structured host records and may contain local
paths; keep them inside the Provisioner boundary.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the caller lacks `installation.read`. A blocked,
repair, or invalid-identity state is normally returned as data so the UI can
present the exact next action. If the read itself rejects, preserve its
diagnostic and repair guidance rather than using version comparison alone.

### Example

```javascript
const installation = await Arcane.installation.status();

console.log(installation.disposition, installation.action);
if (installation.blocked || installation.repairRequired) {
    console.warn(installation.blockedReason || installation.repairReason);
}
```

## Arcane.installation.ensure()

### Overview

`Arcane.installation.ensure()` installs, updates, repairs, or verifies Arcane OS
as required. It is a privileged, exclusive, non-idempotent Provisioner
operation requiring `provisioning.manage` on Core. It can write protected
files, register platform integration, and change machine configuration. Never
start it without a visible status and separate user confirmation.

The host rejects an installed Provisioner attempting to replace its own active
installation; updates and repairs run from a verified external release. It
blocks downgrades and re-verifies installation identity and postconditions.

### Result, side effects, and events

The exact result is `{manifest, installation, requirements, model, ready,
warningCount, operation, credentials}`. `model` is exactly `{status, reason,
requiredBefore, created}` and deliberately reports local-model setup as
deferred from base installation. `ready: true` requires a present, current,
nonblocked installation with accepted identity, integrity, and required
requirements. A completed result can have `ready: false` and warnings when
warn-first policy is active.

The method emits the standard operation lifecycle events. Simulation mutates
only deterministic development state and does not prove a real installation.

### Errors and recovery

Important failures include `ADMIN_REQUIRED`, `OPERATION_BUSY`,
`EXTERNAL_PROVISIONER_REQUIRED`, `DOWNGRADE_BLOCKED`,
`INSTALL_IDENTITY_INVALID`, payload or integrity failures, and installation
lease/stage cleanup failures. Do not retry automatically after an ambiguous
failure: preserve the diagnostic, inspect fresh `installation.status()`, and
follow its recovery action.

### Example

```javascript
async function ensureInstallationAfterConfirmation(confirmChange) {
    const status = await Arcane.installation.status();
    if (status.action === 'current' || status.action === 'blocked') {
        return status;
    }
    if (!confirmChange(status.action, status)) {
        return null;
    }
    return Arcane.installation.ensure();
}
```

## Arcane.installation.openUninstaller()

### Overview

`Arcane.installation.openUninstaller()` opens the globally installed Arcane OS
uninstaller controller. It is available only to a Provisioner with
`provisioning.manage` on a Microsoft NT Core host. The method does not uninstall
anything itself: the controller separately performs UAC, read-only preflight,
scope review, and typed confirmation.

### Result and side effect

The exact result is `{opened: true}`. It means Microsoft NT accepted creation
of the installed uninstaller process, not that UAC was approved or an uninstall
completed. The method emits no operation event. It will not run a checkout-local
or caller-selected executable.

### Errors and recovery

`UNINSTALLER_NOT_SUPPORTED` means the current platform is not Microsoft NT.
`UNINSTALLER_UNAVAILABLE` and related integrity errors mean the global
installation must be repaired. `UNINSTALLER_OPEN_FAILED` means process creation
was not confirmed. Use the operating system's Installed apps interface when the
verified controller cannot be opened.

### Example

```javascript
async function openUninstallerAfterConfirmation(confirmOpen) {
    if (!confirmOpen()) {
        return null;
    }
    return Arcane.installation.openUninstaller();
}
```

## Arcane.users.list()

### Overview

`Arcane.users.list()` returns local accounts that use the exact Arcane shell or
have a protected Arcane recovery record. It requires `users.manage`, an
application of type `provisioner`, and a Core host. It is a read and emits no
operation event. On Microsoft NT an elevated read can temporarily load and
unload a signed-out profile to verify both protected shell bindings; it does not
persistently change the account.

### Result

The exact top-level result is `{users, policy, protectedUsernames}`. `policy` is
exactly `{platform, minimumLength, maximumLength, description, example}`.
`protectedUsernames` contains accounts the Provisioner must not convert.

Every `users` record contains host account and shell observations plus the
Arcane recovery fields `managedByArcane`, `createdByArcane`, `passwordStatus`,
`provisionedAt`, `passwordChangedAt`, prior-shell values and presence flags,
recorded binding/security metadata, `canRestoreShell`,
`restoreRequiresElevatedVerification`, `shellMutationPhase`,
`shellRecoveryPrepared`, `accountMutationPhase`, and `activationRequired`.

Microsoft NT records include `username`, `sid`, `enabled`, `profile`, `shell`,
both policy and Winlogon shell values/presence flags, `shellAssigned`,
`shellBindingVersion`, `assignmentMode`, `verification`, and `source`. Linux
records include `username`, optional `uid`, `enabled`, `profile`, `shell`,
`shellAssigned`, `verification`, and `source`. Nullable or recorded-only values
must remain unknown; do not coerce them to false.

### Errors and recovery

`METHOD_NOT_ALLOWED` means this is not the admitted Provisioner. Host account,
profile, registry, passwd, or recovery-record failures should be surfaced with
their diagnostic. Refresh only after resolving the cause; do not drop a
recorded-only entry, because it may represent an interrupted transaction that
needs recovery.

### Example

```javascript
const result = await Arcane.users.list();

for (const user of result.users) {
    console.log(
        user.username,
        user.shellAssigned,
        user.activationRequired,
        user.verification
    );
}
```

## Arcane.users.validate()

### Overview

`Arcane.users.validate(usernames)` validates one username or an array without
creating or changing an account. The wrapper always sends an array. The method
requires `users.manage`, the Provisioner application type, and Core; it is a
read with no event.

Microsoft NT permits 1–20 letters, numbers, periods, underscores, or hyphens,
beginning with a letter or number and not ending in a period. Linux permits
1–32 lower-case letters, numbers, underscores, or hyphens, beginning with a
lower-case letter or underscore. Both reject reserved, privileged, and current
protected accounts.

### Result

The exact result is `{valid, users, errors, policy}`. `valid` is true only when
at least one input is valid and there are no errors. Each successful item is
exactly `{input, username, valid: true, exists}`. Each failed item includes
`input`, `valid: false`, and the normalized Arcane error fields, including code,
message, and recovery guidance. `policy` is the five-field platform username
policy returned by `users.list()`.

### Errors and recovery

Individual invalid values are normally returned in `errors` as
`INVALID_USERNAME` or `CURRENT_USER_PROTECTED`; the whole call need not reject.
Use the returned policy and per-item resolution. Validate again immediately
before a confirmed add because account existence can change after this read.

### Example

```javascript
const validation = await Arcane.users.validate(['arcane-user']);

if (!validation.valid) {
    for (const error of validation.errors) {
        console.warn(error.code, error.message, error.resolution);
    }
}
```

## Arcane.users.add()

### Overview

`Arcane.users.add(usernames)` ensures the installation, then creates or
configures one or more local standard accounts with the verified Arcane login
shell. It requires `users.manage`, the Provisioner type, elevation, and the
exclusive Core mutation boundary. The wrapper accepts one username or an array;
the host validates every value and de-duplicates platform-equivalent names.

This is a consequential, non-idempotent account mutation. Existing accounts
keep their password while receiving a recoverable shell assignment. A newly
created account is staged disabled, with an exact OS identity and prior-shell
record, until its returned temporary credential has been delivered and
`users.activate()` succeeds. The host attempts fail-closed rollback after an
interruption; recorded partial state must be recovered, not guessed away.

### Result, credentials, and events

The exact result is `{users, machineUsers, installation, operation,
credentials}`. `users` contains per-request native results plus
`passwordStatus` and `activationRequired`; `machineUsers` uses the record shape
from `users.list()`. `installation` is a fresh installation-status object.

For each new account, `credentials` contains exactly `{username,
temporaryPassword, mustChangeAtNextSignIn: true, reason: "new-account",
activationRequired: true}`. Save and present the secret once through protected
UI; never log, copy to telemetry, or persist it in ordinary app storage. The
standard operation lifecycle events are emitted, and
`operation.completed.credentials` is equally sensitive.

### Errors and recovery

Important failures include `ADMIN_REQUIRED`, `OPERATION_BUSY`, username and
protected-account errors, `RELEASE_SECURITY_UNVERIFIED`,
`PARTIAL_ACCOUNT_RECOVERY_REQUIRED`, shell backup/change failures, and
platform user-provisioning failures. Do not repeat an ambiguous add. Refresh
`users.list()`, preserve any credential already shown, and follow the recorded
transaction recovery.

### Example

```javascript
async function addUserAfterValidation(username, confirmAccountChange) {
    const validation = await Arcane.users.validate([username]);
    if (!validation.valid || !confirmAccountChange(validation.users[0])) {
        return null;
    }

    const result = await Arcane.users.add([validation.users[0].username]);
    // Present result.credentials through protected, non-logging UI.
    return result;
}
```

## Arcane.users.activate()

### Overview

`Arcane.users.activate(username)` enables only a newly created, disabled Arcane
account whose durable staged identity is in `activation-pending`. It requires
`users.manage`, the Provisioner type, elevation, and the exclusive Core
mutation boundary. Call it only after the operator has safely received the
temporary credential returned by `users.add()`.

Activation re-verifies the exact SID or uid and Arcane shell assignment before
enabling the account. It does not activate an existing account or a name-only
match. The account must change its temporary password at next sign-in.

### Result, side effects, and events

The exact result is `{user, operation, credentials}`; `credentials` is empty.
`user` contains the native `username`, stable `sid` or `uid`, `enabled: true`,
`activated: true`, `activationRequired: false`, and
`passwordStatus: "temporary-issued"`, with host-specific profile/shell or
reconciliation fields where applicable. Standard operation events are emitted.

### Errors and recovery

`STAGED_ACCOUNT_NOT_FOUND` means no exact disabled staged identity is eligible.
`SHELL_CHANGED_EXTERNALLY`, `INVALID_STAGED_ACCOUNT`, or a changed SID/uid
blocks activation. Platform failures leave or restore the account disabled
where possible. Refresh the user inventory and follow the protected recovery
record; never enable a same-named account manually based only on its name.

### Example

```javascript
async function activateStagedUserAfterCredentialDelivery(
    username,
    confirmCredentialDelivered
) {
    if (!confirmCredentialDelivered(username)) {
        return null;
    }
    return Arcane.users.activate(username);
}
```

## Arcane.users.resetPassword()

### Overview

`Arcane.users.resetPassword(username)` prepares a new temporary password for an
active, recorded Arcane user. Despite its name, this step does not change the
operating-system password. It requires `users.manage`, the Provisioner type,
and the exclusive Core operation boundary; the actual privileged change occurs
only in `users.applyPassword()`.

### Result and credential handling

The exact result is `{user, operation, credentials}`. `user` is exactly
`{username, passwordReset: false, applyPasswordRequired: true,
passwordStatus}`. `credentials` contains one exact object:
`{username, temporaryPassword, mustChangeAtNextSignIn: true,
reason: "password-reset", applyPasswordRequired: true}`.

The standard operation lifecycle events are emitted. Treat the credential in
both the response and `operation.completed` event as sensitive, show it through
protected UI, and do not log or durably store it.

### Errors and recovery

`USER_NOT_FOUND` means the account is absent or not registered with Arcane.
`STAGED_ACCOUNT_NOT_ACTIVE` requires completing the staged activation first.
`NOT_ARCANE_USER` means the protected record does not show an active Arcane
shell assignment. Since this method has not changed the OS password, a lost
prepared credential can be discarded and prepared again.

### Example

```javascript
async function preparePasswordResetAfterConfirmation(username, confirmReset) {
    if (!confirmReset(username)) {
        return null;
    }
    const prepared = await Arcane.users.resetPassword(username);
    // Pass prepared.credentials[0] only to protected credential UI.
    return prepared;
}
```

## Arcane.users.applyPassword()

### Overview

`Arcane.users.applyPassword(username, temporaryPassword)` applies the exact
temporary password produced by the current Provisioner workflow. It is a
privileged, exclusive, non-idempotent Core mutation requiring `users.manage`
and the Provisioner type. It changes the local operating-system password and
forces a change at the next sign-in.

Do not construct a password yourself. The accepted handoff has the generated
`A!` prefix, 16 base64url characters, and `9z` suffix. Keep it in memory only
long enough to show and apply it; never place it in a URL, log, diagnostic, or
ordinary storage.

### Result, side effects, and events

The exact result is `{user, operation, credentials}` with an empty credentials
array. `user` contains `username`, `passwordReset: true`,
`mustChangeAtNextSignIn: true`, `applyPasswordRequired: false`, and
`passwordStatus: "temporary-issued"`, plus `sid`/`uid` or `enabled` where the
native host reports it. Standard operation events are emitted with redacted
command diagnostics.

### Errors and recovery

`INVALID_TEMPORARY_PASSWORD` rejects anything outside the exact generated
handoff. `USER_NOT_FOUND` and `NOT_ARCANE_USER` block a changed or inactive
account. Platform reset failures retain redacted diagnostics. After an
ambiguous failure, do not generate a different secret immediately: refresh the
account state and follow the error's reconciliation guidance, because the first
password may already have been accepted.

### Example

```javascript
async function applyPreparedPassword(prepared) {
    const credential = prepared?.credentials?.[0];
    if (!credential || credential.applyPasswordRequired !== true) {
        throw new Error('A current prepared credential is required.');
    }
    return Arcane.users.applyPassword(
        credential.username,
        credential.temporaryPassword
    );
}
```

## Arcane.users.verifyShell()

### Overview

`Arcane.users.verifyShell(username)` performs an administrator-backed,
read-only verification of the recorded account's exact Arcane shell binding.
It requires `users.manage`, the Provisioner type, and privileged Core access,
but it does not change the shell. Microsoft NT verifies both protected per-user
bindings; Linux verifies the protected login-shell field.

### Result and events

The exact result is `{user, operation, credentials}` with empty credentials.
`user` is the current host-specific `users.list()` record plus
`administratorVerified: true` and an `administratorVerifiedAt` timestamp.
Inspect `user.shellAssigned`; administrative verification can successfully
complete while reporting a mismatch. Standard operation events are emitted.

### Errors and recovery

`NOT_ARCANE_USER` means no managed recovery record exists. `USER_NOT_FOUND`
means the recorded account is gone. Profile, registry, passwd, SID, or uid
verification errors require administrator review. Do not call
`restoreShell()` merely because verification failed to run; restore only after
reviewing a valid mismatch and the recorded baseline.

### Example

```javascript
const verification = await Arcane.users.verifyShell('arcane-user');

if (!verification.user.shellAssigned) {
    console.warn('The recorded Arcane shell binding does not match.');
}
```

## Arcane.users.restoreShell()

### Overview

`Arcane.users.restoreShell(username)` restores the exact prior shell values
captured before Arcane assigned its login shell. It requires `users.manage`, the
Provisioner type, elevation, and the exclusive Core mutation boundary. It does
not delete the account or change its password, but it materially changes what
starts at the user's next sign-in.

Microsoft NT restores both prior policy and Winlogon shell bindings, including
their recorded absence. Linux restores the recorded login shell after checking
the exact uid and ensuring the prior executable still exists. The host refuses
to overwrite a value changed outside the recorded transaction.

### Result, side effects, and events

The exact result is `{user, operation, credentials}` with empty credentials.
`user` contains `username`, `restored: true`, the restored nullable `shell`,
`shellAssigned: false`, and `verification`, plus Microsoft NT binding fields or
Linux `profile` and `uid`. Recovery can also report `alreadyRestored: true`.
Standard operation events are emitted.

### Errors and recovery

`SHELL_BACKUP_NOT_FOUND` means there is no safe baseline. A staged account must
be activated or recovered before restore. `SHELL_CHANGED_EXTERNALLY`, changed
SID/uid errors, or `PREVIOUS_SHELL_MISSING` block mutation rather than guessing.
Review the account and protected recovery record manually; do not substitute a
default shell silently.

### Example

```javascript
async function restoreShellAfterVerification(username, confirmRestore) {
    const verification = await Arcane.users.verifyShell(username);
    if (!confirmRestore(verification.user)) {
        return null;
    }
    return Arcane.users.restoreShell(username);
}
```

## Arcane.system.lock()

### Overview

`Arcane.system.lock()` asks the operating system to lock the current desktop
session. It requires `session.control`, an application of type `shell`, and a
Core host. It is an exclusive, non-idempotent session-control request and does
not merely hide or close Arcane.

Microsoft NT dispatches the native workstation-lock command. Linux selects the
first available supported controller from `loginctl`, GNOME Screensaver, or
the XDG screensaver command. Simulation records only an explicitly simulated
request.

### Result and side effect

On a real host the result is exactly `{requested: true, accepted: true,
simulated: false, command, pid}`. In simulation it is exactly `{requested:
true, accepted: true, simulated: true, command, args}`. Acceptance means the
session controller process started; it is not a later proof that the desktop is
visibly locked. No Arcane operation or completion event is emitted.

### Errors and recovery

`SESSION_COMMAND_UNAVAILABLE` means no supported controller exists.
`SESSION_COMMAND_DISPATCH_FAILED` or `SESSION_COMMAND_DISPATCH_TIMEOUT` means
the host could not confirm process creation. `METHOD_NOT_ALLOWED` means the
caller is not the admitted Shell or lacks `session.control`. Do not retry in a
tight loop after an ambiguous timeout.

### Example

```javascript
async function lockSessionAfterConfirmation(confirmLock) {
    if (!confirmLock()) {
        return null;
    }
    return Arcane.system.lock();
}
```

## Arcane.system.ping()

### Overview

`Arcane.system.ping()` confirms that the bound Arcane bridge admitted and
answered one request. It requires no capability and is available on Core and
Android. It uses a 10-second client timeout, has no side effect, and emits no
event.

### Result and limits

The exact result is `{ok: true}`. Success does not prove installation health,
network reachability, renderer readiness, dependency readiness, elevation,
publisher trust, signing, or release-candidate status. Use the focused status
method for each of those questions.

### Errors and recovery

`ARCANE_TRANSPORT_UNAVAILABLE` means no host is connected.
`ARCANE_REQUEST_TIMEOUT` means the bridge did not complete before the client
deadline. Android can reject duplicate or invalid bridge frames. Treat any
failure as an unknown bridge state and reconnect; do not turn it into a broader
health diagnosis without evidence.

### Example

```javascript
const reply = await Arcane.system.ping();
console.log('Bridge replied', reply.ok);
```

## Arcane.system.metrics()

### Overview

`Arcane.system.metrics()` reads a bounded machine resource snapshot. It
requires `system.metrics.read` on a Core host, changes nothing, and emits no
event. Metrics are local-machine data; retain only what the UI needs and do not
use them as a stable device fingerprint.

### Result

The exact result is `{architecture, logicalProcessors, loadAverage, memory,
uptimeSeconds}`. `loadAverage` is the operating system's load-average array
rounded to three decimals. `memory` is exactly `{totalBytes, freeBytes,
usedBytes}`, with `usedBytes` computed as the nonnegative difference. Uptime is
the whole number of seconds reported by the OS.

This is an observation, not an admission decision. Local-model APIs apply their
own hardware and memory policy; do not infer model eligibility from these
values.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the application lacks `system.metrics.read`.
Transport failure means the snapshot is unavailable; keep the last value
visibly stale or clear it rather than reporting zero resources.

### Example

```javascript
const metrics = await Arcane.system.metrics();
const freeGiB = metrics.memory.freeBytes / (1024 ** 3);

console.log(metrics.logicalProcessors, `${freeGiB.toFixed(1)} GiB free`);
```

## Arcane.system.failurePolicy()

### Overview

`Arcane.system.failurePolicy()` reads the user-wide verification behavior used
by tracked Core operations. It requires `preferences.read`, app id `settings`,
and a Core host. It has no side effect or event.

### Result and behavior

The exact result is `{failFast: boolean}`. The default is `false` (warn-first)
when no saved policy exists. Warn-first lets specifically classified
verification warnings complete visibly; it never authorizes unverified bytes or
bypasses a hard identity, privilege, capability, or transaction boundary.
`true` turns eligible warnings into operation failures.

If Core cannot read a corrupt policy, it logs the problem internally and safely
returns `{failFast: false}` for that process. Settings should present that value
without claiming the saved file was healthy.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the caller is not Settings or lacks
`preferences.read`. Transport failures leave the policy unknown. Use
`saveFailurePolicy()` for an intentional change; do not mutate the returned
object.

### Example

```javascript
const policy = await Arcane.system.failurePolicy();
console.log(policy.failFast ? 'Fail fast' : 'Warn first');
```

## Arcane.system.saveFailurePolicy()

### Overview

`Arcane.system.saveFailurePolicy(settings)` persists the user-wide verification
behavior. It requires `preferences.write`, app id `settings`, and the exclusive
Core mutation boundary. `settings` must be an exact object containing only the
boolean `failFast` field; values are not coerced.

The change affects subsequently created tracked operations. It does not change
an already running operation and cannot weaken hard trust, authority,
privilege, or integrity checks.

### Result and side effect

The exact result is `{failFast: boolean}` with the saved value. A real host
durably replaces the protected user-wide policy record; simulation changes only
simulation state. The method emits no standard operation event.

### Errors and recovery

`INVALID_FAILURE_POLICY` rejects missing, nonboolean, or extra fields.
`METHOD_NOT_ALLOWED` means the caller is not admitted Settings. `OPERATION_BUSY`
means another exclusive mutation is active; wait, re-read the policy, and let
the operator confirm the still-desired value.

### Example

```javascript
async function saveFailurePolicyAfterConfirmation(failFast, confirmChange) {
    if (!confirmChange(failFast)) {
        return null;
    }
    return Arcane.system.saveFailurePolicy({failFast});
}
```

## Arcane.network.status()

### Overview

`Arcane.network.status()` reports whether the host sees at least one network
interface with a non-loopback address. It requires `network.status.read` and is
available on Core and Android. It performs no network request, changes nothing,
and emits no event.

### Result and limits

The exact result is `{online, interfaceCount}`. `interfaceCount` is a safe
integer from 0 through 64, and `online` is exactly
`interfaceCount > 0`. It does not prove Internet, DNS, route, captive-portal,
mail-gateway, or application-service reachability.

Use this result only as a coarse UI hint. A network operation still needs its
own bounded timeout and surfaced error; do not suppress a retry solely because
this snapshot says offline.

### Errors and recovery

`METHOD_NOT_ALLOWED` or `ANDROID_CAPABILITY_DENIED` means the grant is absent.
`NETWORK_STATUS_UNAVAILABLE` means Core observed more interfaces than its
bounded contract accepts. `METHOD_CONTRACT_OUTPUT_INVALID` rejects a
contradictory Android or Core result.

### Example

```javascript
const network = await Arcane.network.status();

console.log(
    network.online ? 'Interface present' : 'No non-loopback interface',
    network.interfaceCount
);
```

## Arcane.firewall.status()

### Overview

`Arcane.firewall.status()` returns the canonical global-deny policy identity,
Arcane-owned native projection state, bounded audit count, coverage limits, and
action readiness. It requires `firewall.read`, app id `firewall`, and a Core
host. It is a repeatable read with no side effect or event.

The current lifecycle implementation is development-only. Deterministic
simulation can report `supported: true` but always reports
`coverage.machineWide: false`. A non-simulated host reports lifecycle mutation
unsupported until Core can authenticate its native-host caller. Never present
simulation as live traffic enforcement.

### Result

The exact top-level result is `{schemaVersion, platform, backend, simulation,
supported, coverage, policy, state, projection, auditCount,
supportedOperations, warnings}` with `schemaVersion: 1` and
`supportedOperations` exactly `['install','enable','disable','rollback',
'recover']`.

`coverage` is exactly `{machineWide, ingress, egress, limitations}`. `policy`
is exactly `{schemaVersion, generation, sha256, domainRuleCount,
networkRuleCount}`. `state` is exactly `{generation, installed, enabled,
installReady, enableReady, recoveryRequired, activePolicyGeneration,
activePolicySha256, lastOperation, lastChangedAt}`. `projection` is exactly
`{sha256, createdAt, expiresAt, addressCount, directRuleCount,
domainRuleCount}`.

Use `state.installReady` and `state.enableReady` as fail-closed UI gates, then
bind any confirmed mutation to `policy.generation` and `state.generation`.
Warnings include coverage, expiry, projection, and live-host limitations and
must remain visible.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the current app is not Arcane Firewall or lacks
`firewall.read`. Invalid policy/state or native inspection evidence is reflected
as warnings and `recoveryRequired` where safe; a closed-contract failure uses
`METHOD_CONTRACT_OUTPUT_INVALID`. Do not enable controls by recomputing
readiness in the renderer.

### Example

```javascript
const status = await Arcane.firewall.status();

console.log(status.platform, status.backend, status.simulation);
console.log('Install ready', status.state.installReady);
console.log('Enable ready', status.state.enableReady);
for (const warning of status.warnings) {
    console.warn(warning);
}
```

## Arcane.firewall.audit()

### Overview

`Arcane.firewall.audit(options?)` returns bounded Arcane Firewall lifecycle and
owned-state metadata. It requires `firewall.read`, app id `firewall`, and Core.
It does not return packet payloads, full per-packet attribution, credentials, or
unbounded history and has no side effect or event.

`options` is optional. `limit` defaults to 100 and must be a safe integer from
1 through 200; invalid values throw `TypeError` before dispatch.

### Result

The exact result is `{records, total, truncated, coverage, warning}`.
`warning` is a string or `null`. Records are newest first and each is exactly
`{id, time, type, operation, stateGeneration, result, direction, ruleId,
message}`. `type` is `"lifecycle"` or `"blocked"`; `operation` is one of
`install`, `enable`, `disable`, `rollback`, `recover`, or `block`; `direction`
and `ruleId` may be `null`.

`total` is the retained audit count, capped at 500. `truncated` says the chosen
limit omitted retained records; it does not claim Arcane captured every network
decision.

### Errors and recovery

`METHOD_NOT_ALLOWED` means the Firewall read boundary is absent.
`METHOD_CONTRACT_INPUT_INVALID` indicates a malformed native request; use the
public wrapper and documented limit. A damaged state record can return an empty
audit with its failure in `warning`, allowing the UI to offer Recovery without
claiming that no history exists.

### Example

```javascript
const audit = await Arcane.firewall.audit({limit: 50});

for (const record of audit.records) {
    console.log(record.time, record.operation, record.result, record.message);
}
if (audit.warning) {
    console.warn(audit.warning);
}
```

## Arcane.firewall.install()

### Overview

`Arcane.firewall.install(expectation)` resolves and stages the reviewed
canonical deny-policy projection. It requires `firewall.manage`, app id
`firewall`, elevated Core authority, the exclusive mutation boundary, and a
separate user confirmation. It is non-idempotent and currently succeeds only in
deterministic development simulation; live mutation fails explicitly.

`expectation` must be an exact plain object containing the current positive
`expectedPolicyGeneration` and nonnegative `expectedStateGeneration` from one
fresh `firewall.status()` result. Unknown, missing, stale, fractional, or
negative values are rejected.

Install may use bounded system DNS to project domain rules to addresses. One
projection admits at most 4,096 domain rules. It stages Arcane-owned state with
enforcement disabled; an enabled generation must be disabled first.

### Result, side effects, and events

Every firewall mutation resolves to exactly `{status, receipt, operation}`.
`status` is the full fresh status object. `receipt` is exactly `{schemaVersion,
operation, ownedNamespace, backend, policyGeneration, projectionSha256,
completedAt, transactionId}`. `operation` is the completed standard operation
record; its type is `"firewall.install"`, progress is 100, credentials is empty,
and error is null. Standard operation events are emitted.

### Errors and recovery

Bad JavaScript input throws `TypeError`; stale snapshots use
`FIREWALL_POLICY_GENERATION_STALE` or `FIREWALL_STATE_GENERATION_STALE`.
`FIREWALL_HOST_AUTHENTICATION_UNAVAILABLE` identifies the current live-host
boundary. Other important failures include `FIREWALL_MUTATION_BUSY`,
`OPERATION_BUSY`, `FIREWALL_RECOVERY_REQUIRED`, `FIREWALL_DISABLE_REQUIRED`,
bounded DNS/projection failures, and cancellation. Refresh status after any
failure; do not reuse old generations.

### Example

```javascript
async function installFirewallAfterConfirmation(confirmInstall) {
    const status = await Arcane.firewall.status();
    if (!status.simulation || !status.supported || !status.state.installReady) {
        return null;
    }
    if (!confirmInstall(status)) {
        return null;
    }
    return Arcane.firewall.install({
        expectedPolicyGeneration: status.policy.generation,
        expectedStateGeneration: status.state.generation
    });
}
```

## Arcane.firewall.enable()

### Overview

`Arcane.firewall.enable(expectation)` enables only the exact installed,
unexpired projection for the current canonical policy. It requires
`firewall.manage`, app id `firewall`, elevated Core authority, exclusive
mutation, and separate confirmation. It does not resolve domains or silently
replace a stale projection. Current success is simulation-only and never proves
machine-wide enforcement.

Pass the two exact current generations from a status whose
`state.enableReady` is true. The host repeats all generation, recovery,
prerequisite, policy hash, installation, and projection-expiry checks after
dispatch.

### Result, side effects, and events

The exact result is `{status, receipt, operation}` with the receipt fields
documented under `firewall.install()`. The receipt operation is `"enable"`, and
the tracked operation type is `"firewall.enable"`. The returned status has a
new state generation and reports the resulting simulated enabled state.
Standard operation events are emitted.

### Errors and recovery

In addition to stale, busy, recovery, and live-host errors, enable can reject
with `FIREWALL_NATIVE_PREREQUISITE_REQUIRED`, `FIREWALL_ALREADY_ENABLED`,
`FIREWALL_INSTALL_REQUIRED`, or `FIREWALL_PROJECTION_EXPIRED`. Refresh status;
an expired or mismatched projection requires a newly confirmed Install, not an
automatic enable retry.

### Example

```javascript
async function enableFirewallAfterConfirmation(confirmEnable) {
    const status = await Arcane.firewall.status();
    if (!status.simulation || !status.supported || !status.state.enableReady) {
        return null;
    }
    if (!confirmEnable(status)) {
        return null;
    }
    return Arcane.firewall.enable({
        expectedPolicyGeneration: status.policy.generation,
        expectedStateGeneration: status.state.generation
    });
}
```

## Arcane.firewall.disable()

### Overview

`Arcane.firewall.disable(expectation)` disables only Arcane-owned firewall
state. It requires `firewall.manage`, app id `firewall`, elevated Core
authority, exclusive mutation, fresh generations, and separate confirmation.
It does not disable or rewrite firewall rules owned by another product. Current
success affects only deterministic simulation state.

### Result, side effects, and events

The exact result is `{status, receipt, operation}`. The receipt operation is
`"disable"`, the tracked operation type is `"firewall.disable"`, and the fresh
status reports `enabled: false` with an incremented state generation. Standard
operation events are emitted. Request acceptance is not a live enforcement
claim; check the returned labeled status.

### Errors and recovery

`FIREWALL_NOT_INSTALLED` means there is no Arcane-owned installed generation to
disable. Recovery-required, stale-generation, busy, and live-host-authentication
errors fail without guessing ownership. Refresh status and confirm again; use
Recovery only when the returned state explicitly requires reconciliation.

### Example

```javascript
async function disableFirewallAfterConfirmation(confirmDisable) {
    const status = await Arcane.firewall.status();
    if (!status.simulation || !status.supported || !status.state.enabled) {
        return null;
    }
    if (!confirmDisable(status)) {
        return null;
    }
    return Arcane.firewall.disable({
        expectedPolicyGeneration: status.policy.generation,
        expectedStateGeneration: status.state.generation
    });
}
```

## Arcane.firewall.rollback()

### Overview

`Arcane.firewall.rollback(expectation)` restores one retained Arcane-owned
projection only when it belongs to the same canonical policy, remains
unexpired, and preserves every deny in the current projection. It requires
`firewall.manage`, app id `firewall`, elevated Core authority, exclusive
mutation, fresh generations, and separate confirmation. Current success is
simulation-only.

Rollback never means “use any previous policy.” The host refuses a different
policy generation/hash or a projection that would weaken current deny coverage.
It reapplies the retained projection in the current installed/enabled mode.

### Result, side effects, and events

The exact result is `{status, receipt, operation}`. The tracked operation type
is `"firewall.rollback"` and returned status records `lastOperation:
"rollback"`. The native receipt's `operation` is `"install"` or `"enable"`
because that is the concrete reapplication performed; there is intentionally no
`"rollback"` receipt operation. Standard operation events are emitted.

### Errors and recovery

Rollback-specific failures are `FIREWALL_ROLLBACK_UNAVAILABLE`,
`FIREWALL_ROLLBACK_POLICY_MISMATCH`,
`FIREWALL_ROLLBACK_PROJECTION_EXPIRED`, `FIREWALL_CURRENT_POLICY_STALE`, and
`FIREWALL_ROLLBACK_WOULD_WEAKEN_POLICY`. Keep the current state on rejection.
Use a separately confirmed Disable, Install, and Enable sequence when the
retained projection cannot be safely reused.

### Example

```javascript
async function rollbackFirewallAfterConfirmation(confirmRollback) {
    const status = await Arcane.firewall.status();
    if (!status.simulation || !status.supported || status.state.recoveryRequired) {
        return null;
    }
    if (!confirmRollback(status)) {
        return null;
    }
    return Arcane.firewall.rollback({
        expectedPolicyGeneration: status.policy.generation,
        expectedStateGeneration: status.state.generation
    });
}
```

## Arcane.firewall.recover()

### Overview

`Arcane.firewall.recover(expectation)` explicitly reconciles and removes only
Arcane-owned firewall state when consistency or native inspection indicates
recovery is required. It requires `firewall.manage`, app id `firewall`,
elevated Core authority, exclusive mutation, fresh generations, and separate
confirmation. Current success changes deterministic simulation state only.

Recovery is not a general firewall reset. The backend is constrained to its
Arcane-owned namespace; unrelated firewall state is outside the operation.

### Result, side effects, and events

The exact result is `{status, receipt, operation}`. The receipt operation is
`"recover"`, the tracked operation type is `"firewall.recover"`, and successful
status returns the Arcane state to its default noninstalled, disabled,
non-recovery state at a new generation. Standard operation events are emitted.

### Errors and recovery

Stale generation, busy operation, privilege, and live-host-authentication
failures still apply. Recovery may read a damaged consistency record, but it
does not bypass policy identity or ownership. Preserve a failed transaction's
diagnostic and avoid parallel retries; refresh status only after the exclusive
operation has finished.

### Example

```javascript
async function recoverFirewallAfterConfirmation(confirmRecovery) {
    const status = await Arcane.firewall.status();
    if (!status.simulation || !status.supported || !status.state.recoveryRequired) {
        return null;
    }
    if (!confirmRecovery(status)) {
        return null;
    }
    return Arcane.firewall.recover({
        expectedPolicyGeneration: status.policy.generation,
        expectedStateGeneration: status.state.generation
    });
}
```
