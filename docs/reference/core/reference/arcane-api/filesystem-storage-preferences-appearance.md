# Arcane API filesystem, storage, preferences, environment, and appearance guides

These authored notes explain the app-scoped persistence and user-controlled host
surfaces behind the canonical inventory in [`docs/arcane-api.md`](../../arcane-api.md).
The methods remain capability-gated by the application descriptor; feature-detect
the exact method before presenting a control.

## Arcane.filesystem.selectDirectory()

### Overview

Opens the operating system's folder picker after a user action and returns one
canonical existing directory. This is a selection capability, not general
filesystem access: it does not enumerate drives, read the directory, create a
folder, or grant permission to its contents.

Use it when an application needs the user to choose a local workspace or export
location. The application must still validate that the selected directory is
appropriate for its own workflow.

### Options

Pass an object containing only these optional fields:

| Field | Contract |
|---|---|
| `title` | Plain-text dialog title. Defaults to `Choose a folder`; maximum 200 characters; control characters are rejected. |
| `initialPath` | Existing absolute directory path. It is canonicalized before the picker opens and may not exceed 4,096 characters. |

The promise resolves to `{cancelled:true,path:null}` when the user cancels, or
`{cancelled:false,path}` with the canonical absolute path. Cancellation is a
normal result, not an error.

### Availability and errors

Requires `filesystem.directory.select`. Core-backed Microsoft NT uses the native
folder browser; Linux uses an installed Zenity or KDialog picker. Unsupported
hosts reject with `FILESYSTEM_DIRECTORY_SELECTION_UNSUPPORTED`. Invalid options,
an unavailable initial path, an invalid host response, or a selected directory
that disappears are rejected explicitly.

### Example

```js
async function chooseWorkspaceDirectory() {
    const access = await Arcane.capabilities.list();
    if (!access.methods.includes('filesystem.directory.select')) return null;

    const selection = await Arcane.filesystem.selectDirectory({
        title: 'Choose a development workspace'
    });
    return selection.cancelled ? null : selection.path;
}

document.querySelector('#choose-workspace')?.addEventListener(
    'click',
    async function handleWorkspaceSelection() {
        const path = await chooseWorkspaceDirectory();
        if (path) document.querySelector('#workspace-path').textContent = path;
    }
);
```
## Arcane.storage.list()

### Overview

Reports the keys and quota use for the current application's native storage.
Storage is isolated by the application identity bound to the Core session; one
application cannot use this namespace to inspect another application's records.

### Return value

Requires `storage.read` and resolves to:

```text
{ keys: string[], usedBytes: number, maximumBytes: 1048576 }
```

Keys are sorted. `usedBytes` covers the complete persisted storage envelope, so
it can be larger than the sum of the individual JSON values.

### Usage and failure behavior

Use the keys to build an index, then call `get()` only for records the current
view needs. An empty array is a valid new-app state. `METHOD_NOT_ALLOWED` means
the current application lacks `storage.read`; do not fall back to another
application's browser storage or retry until policy changes.

### Example

```js
async function showStorageBudget() {
    const inventory = await Arcane.storage.list();
    console.log(`${inventory.usedBytes} of ${inventory.maximumBytes} bytes used`);
    for (const key of inventory.keys) console.log(key);
}

await showStorageBudget();
```

## Arcane.storage.get()

### Overview

Reads one JSON-compatible value from the current application's native storage.
Use the explicit `found` flag to distinguish a missing key from a stored `null`.

### Key and return value

The key must contain 1–128 letters, numbers, periods, underscores, colons, or
hyphens and begin with a letter or number. The promise resolves to
`{key,found,value}`; a missing key returns `found:false` and `value:null` rather
than rejecting.

Requires `storage.read`.

### Errors and recovery

Invalid keys reject with `INVALID_STORAGE_KEY`; correct the key rather than
retrying. A capability rejection means this application cannot read native
storage. Treat a host or transport failure as an unavailable read, not as a
missing record, so the UI does not silently replace unknown data with defaults.

### Example

```js
async function loadDraft() {
    const result = await Arcane.storage.get('editor.draft.current');
    return result.found ? result.value : { text: '', updatedAt: null };
}

const draft = await loadDraft();
console.log(draft.updatedAt);
```

## Arcane.storage.set()

### Overview

Atomically creates or replaces one app-scoped storage value. Use storage for
application data that is larger or more durable than a user preference, while
remaining within the intentionally small native quota.

### Input and result

The key follows the storage-key rules above. `value` is normalized through a
JSON round-trip. Top-level `undefined`, functions, circular references, and
values that cannot produce JSON reject. Inside objects, `undefined` and function
properties are omitted; inside arrays, those slots become `null`. The receipt
returns the normalized value, so do not use storage for data whose meaning
depends on those values. One encoded value may use at most 131,072 bytes, and
the complete app storage envelope may use at most 1,048,576 bytes.

Requires `storage.write`. It resolves to
`{key,value,bytes,totalBytes,maximumBytes}` only after the atomic write completes.
Quota and validation failures leave the previous file unchanged.

### Example

```js
async function saveDraft(text) {
    return Arcane.storage.set('editor.draft.current', {
        text: String(text),
        updatedAt: new Date().toISOString()
    });
}

const receipt = await saveDraft('Synthetic example text');
console.log(`Saved ${receipt.bytes} bytes`);
```

## Arcane.storage.delete()

### Overview

Deletes one key from the current application's native storage. Deleting a key
that is already absent is safe and resolves with `deleted:false`.

### Return value and errors

Requires `storage.write` and resolves to
`{key,deleted,totalBytes,maximumBytes}`. Invalid keys reject before the storage
file is read. A successful `deleted:true` result means the updated storage
envelope was written atomically.

### Side effects and recovery

Deletes are serialized with writes to the same app-owned document. If the
renderer loses its connection around a delete, call `get()` after reconnecting
to establish whether the key remains before offering another destructive
action; a missing response is not proof that the mutation failed.

### Example

```js
async function discardDraft() {
    const result = await Arcane.storage.delete('editor.draft.current');
    console.log(result.deleted ? 'Draft removed' : 'No draft was stored');
}

document.querySelector('#discard-draft')?.addEventListener(
    'click',
    discardDraft
);
```

## Arcane.preferences.list()

### Overview

Reports the current application's preference keys and quota use. Preferences
share the storage value and key validation rules but live in a separate
app-scoped preferences document.

### Return value

Requires `preferences.read` and resolves to
`{keys,usedBytes,maximumBytes}`. Keys are sorted and `maximumBytes` is currently
1,048,576 bytes for the complete preferences envelope.

### Usage and failure behavior

Use this inventory to discover configured names, then read a needed preference
with `get()`. Apply an application default only when that result says
`found:false`. An empty list is valid. `METHOD_NOT_ALLOWED` means the application
lacks `preferences.read`; do not switch to an unreviewed persistence path.

### Example

```js
async function listPreferenceNames() {
    const inventory = await Arcane.preferences.list();
    return inventory.keys;
}

console.log(await listPreferenceNames());
```

## Arcane.preferences.get()

### Overview

Reads one app-scoped preference. Use it for a user choice that the same
application should restore later; use shared Arcane services for system-wide
policy rather than copying a platform setting into app preferences.

### Result

Requires `preferences.read`. The key uses the same 1–128 character contract as
storage keys. The promise resolves to `{key,found,value}` and returns
`found:false,value:null` for an absent preference.

### Errors and recovery

Invalid names reject with `INVALID_STORAGE_KEY` because preferences share the
storage-key validator. A permission or host failure is not an absent preference:
keep the setting unresolved or retain its current in-memory value instead of
silently overwriting it with a default.

### Example

```js
async function preferredDensity() {
    const result = await Arcane.preferences.get('layout.density');
    return result.found ? result.value : 'comfortable';
}

document.documentElement.dataset.density = await preferredDensity();
```

## Arcane.preferences.set()

### Overview

Atomically creates or replaces one app-scoped preference. The complete value is
validated before mutation, and the resolved receipt returns the JSON-normalized
value that was actually persisted.

### Input, result, and errors

Requires `preferences.write`. Keys and values use the storage key, JSON, 128 KiB
per-value, and 1 MiB total-envelope limits. The promise resolves to
`{key,value,bytes,totalBytes,maximumBytes}`. Invalid JSON-compatible data or a
quota overflow rejects without replacing the prior preference document.

### Example

```js
async function saveDensity(density) {
    if (!['compact', 'comfortable'].includes(density)) {
        throw new TypeError('Unsupported density');
    }
    return Arcane.preferences.set('layout.density', density);
}

await saveDensity('compact');
```

## Arcane.preferences.setMany()

### Overview

Validates and writes a related preference batch as one atomic mutation. Prefer
this method when several settings describe one UI state and must never be
observed half-updated.

### Entries and result

Pass a plain object containing 1–32 entries. Every key and value is normalized
before any write begins. The entire request rejects when any member is invalid
or the merged document exceeds the 1 MiB quota.

Requires `preferences.write` and resolves to
`{keys,count,bytes,totalBytes,maximumBytes}`. `keys` is sorted, `bytes` is the sum
of the encoded values in this batch, and `totalBytes` covers the resulting full
preferences envelope.

### Example

```js
async function saveReadingPreferences() {
    return Arcane.preferences.setMany({
        'reader.fontScale': 1.1,
        'reader.lineLength': 'medium',
        'reader.voice': 'onyx'
    });
}

const receipt = await saveReadingPreferences();
console.log(`Updated ${receipt.count} preferences`);
```

## Arcane.preferences.delete()

### Overview

Removes one app-scoped preference so the application can return to its default.
An absent key is not an error.

### Return value

Requires `preferences.write` and resolves to
`{key,deleted,totalBytes,maximumBytes}`. The persisted document changes only
when `deleted` is `true`.

### Side effects and recovery

Deletion is a serialized atomic preference mutation. If a transport failure
makes the response ambiguous, call `get()` after reconnecting and branch on
`found` before retrying. A missing key is already the desired default state and
resolves with `deleted:false` rather than rejecting.

### Example

```js
async function restoreDefaultDensity() {
    const result = await Arcane.preferences.delete('layout.density');
    return result.deleted;
}

document.querySelector('#restore-default-density')?.addEventListener(
    'click',
    async function handleRestoreDefaultDensity() {
        console.log(await restoreDefaultDensity());
    }
);
```

## Arcane.environment.list()

### Overview

Lists the Arcane-managed environment profile without exposing protected values.
Desktop hosts report the current user's Arcane-managed profile; Android reports
the calling application's private profile. Ordinary entries contain their
configured value; protected entries use the exact mask `•••••`.

This is a Vault-only administrative surface, not a general application
configuration mechanism. It requires `environment.read`, explicit app-id
admission, and a Core or Android host.

### Return value

The promise resolves to
`{platform,pathSupported,maximumEntries,valueMaximumLength,persistence,entries}`.
At most 256 case-insensitively unique entries are returned in sorted order.
Desktop entries have `{name,value,configured:true,protected,scope:'user'}`;
Android entries use `scope:'app'`. Android also reports `pathSupported:false`,
because `PATH` is deliberately unavailable through this API there. Names use
1–128 characters and ordinary values are bounded to 32,767 characters.

### Example

```js
async function renderEnvironmentInventory() {
    const result = await Arcane.environment.list();
    for (const entry of result.entries) {
        console.log(entry.name, {
            protected: entry.protected,
            configured: entry.configured,
            scope: entry.scope
        });
    }
}

await renderEnvironmentInventory();
```

## Arcane.environment.get()

### Overview

Reads one configured environment entry, including the real value when the entry
is protected. This deliberate plaintext-reveal operation is restricted to the
Vault application with the separate `environment.protected.read` capability.
On Android the entry belongs to the calling application's private profile, and
requesting `PATH` rejects with `ENVIRONMENT_PATH_UNSUPPORTED`.

Do not log, persist, transmit, or place the returned value in diagnostics. Keep
it only for the immediate user-authorized workflow that required the reveal.

### Input, result, and errors

Names must begin with a letter or underscore and then contain only letters,
numbers, underscores, periods, or hyphens, up to 128 characters. The promise
resolves to `{entry}` using the entry shape described above. Missing entries
reject with `ENVIRONMENT_ENTRY_NOT_FOUND`; invalid names reject before native
dispatch.

### Example

```js
async function revealEntryForCurrentInteraction(name) {
    const { entry } = await Arcane.environment.get(name);
    return entry.value;
}

const value = await revealEntryForCurrentInteraction('ARCANE_DEMO_VALUE');
document.querySelector('#environment-value').textContent = value;
```

## Arcane.environment.set()

### Overview

Creates or replaces one Arcane-managed environment entry. It is an exclusive,
high-risk mutation available only to Vault with `environment.write`. Desktop
hosts persist a user-scoped entry for future processes; Android persists an
app-scoped entry in private storage. Already-running processes do not
retroactively receive a desktop change.

### Input and protection

Call `set(name, value, options?)`. Values must be strings without null
characters and generally may not exceed 32,767 characters. On Linux, protected
Secret Service payloads have an additional 8,191-byte encoded ceiling (about
6,126 ASCII value bytes after metadata). `options.protected` must be a Boolean
when supplied. The SDK defaults sensitive-looking names to protected storage,
and Core refuses to save such names unprotected. On desktop, `PATH` must remain
ordinary so future processes can use it; Android rejects any `PATH` mutation
with `ENVIRONMENT_PATH_UNSUPPORTED`.

The promise resolves to `{entry}`. Protected results contain the `•••••` mask,
never an echo of the submitted secret.

### Mutation uncertainty and recovery

Environment writes are serialized. `ENVIRONMENT_OPERATION_BUSY`,
`ENVIRONMENT_RECOVERY_REQUIRED`, or `ENVIRONMENT_SERIALIZATION_RELEASE_FAILED`
means the profile cannot safely accept another mutation yet. Linux can also
report `ENVIRONMENT_PROTECTED_CLEANUP_FAILED` or
`ENVIRONMENT_METADATA_COMMIT_UNCERTAIN`; Android can report
`ANDROID_ENVIRONMENT_STORAGE_UNCERTAIN`. The renderer's normalized
`Arcane.Error` currently exposes the public error code but not the native
mutation-completion or cleanup-phase fields. Refresh the inventory after any of
these uncertainty codes before deciding how to recover, and never blindly retry.

### Example

```js
async function saveSyntheticProtectedValue() {
    return Arcane.environment.set(
        'ARCANE_DEMO_TOKEN',
        'synthetic-development-value',
        { protected: true }
    );
}

document.querySelector('#confirm-environment-write')?.addEventListener(
    'click',
    async function handleConfirmedEnvironmentWrite() {
        const receipt = await saveSyntheticProtectedValue();
        console.log(receipt.entry.name, receipt.entry.protected);
    }
);
```

## Arcane.environment.remove()

### Overview

Deletes one Arcane-managed environment entry: user-scoped on desktop and
app-scoped on Android. This exclusive Vault mutation is not reversible through
the API, so require a clear user confirmation and do not treat deletion as a way
to hide a value temporarily. Android rejects removal of `PATH` with
`ENVIRONMENT_PATH_UNSUPPORTED`.

### Return value and errors

Requires `environment.write` and resolves to `{name,deleted:true}` only when the
native host removed the exact case-insensitive name requested. A missing entry
rejects with `ENVIRONMENT_ENTRY_NOT_FOUND`; response-identity mismatches fail
closed instead of reporting success.

### Mutation uncertainty and recovery

Removal uses the same serialized mutation boundary as `set()`. Treat
`ENVIRONMENT_OPERATION_BUSY`, `ENVIRONMENT_RECOVERY_REQUIRED`,
`ENVIRONMENT_SERIALIZATION_RELEASE_FAILED`, platform cleanup/commit uncertainty,
and Android storage uncertainty as a recovery workflow—not permission to retry
immediately. Only the public error code survives renderer normalization today.
Refresh `list()` first and ask the user how to proceed if the resulting state
cannot be established safely.

### Example

```js
async function removeSyntheticEnvironmentEntry() {
    return Arcane.environment.remove('ARCANE_DEMO_TOKEN');
}

document.querySelector('#remove-demo-entry')?.addEventListener(
    'click',
    async function handleEnvironmentRemoval() {
        const result = await removeSyntheticEnvironmentEntry();
        console.log(`Removed ${result.name}`);
    }
);
```

## Arcane.appearance.current()

### Overview

Reads the native user-appearance state visible to the current host. This is
separate from an application's own CSS: Arcane applications should still load
the shared theme and `ThemeBootstrap.js` so saved appearance choices are applied
consistently.

### Return value and platforms

Requires `appearance.read`. Microsoft NT returns
`{supported:true,platform:'windows',scheme,effectiveScheme,captionColor,textColor}`.
`scheme` is `system`, `light`, or `dark`; `effectiveScheme` is `light` or `dark`.
Linux currently reports an unsupported system appearance with null custom
colors rather than claiming that native settings were changed.

### Example

```js
async function reportNativeAppearance() {
    const appearance = await Arcane.appearance.current();
    console.log(appearance.supported, appearance.effectiveScheme);
    return appearance;
}

await reportNativeAppearance();
```

## Arcane.appearance.apply()

### Overview

Applies the supported native appearance for the current user and returns the
resulting state. On Microsoft NT it stores the Arcane choice, updates light/dark
system values, and broadcasts an appearance change. Choosing `system` restores
the captured baseline and removes Arcane custom caption colors.

### Appearance contract

Requires `appearance.write`. Pass only `scheme`, `captionColor`, and
`textColor`. The scheme defaults to `system`. Custom colors apply only to
`light` or `dark` and must use `rgb(r, g, b)` with channels from 0 through 255.
Microsoft NT rejects unknown fields and malformed colors. Linux currently does
not validate the supplied appearance object; it resolves to its
`supported:false` status without claiming a native mutation. Always send the
portable contract instead of using an unsupported host as a validator.

Listen for [`appearance.changed`](../../arcane-events.md#event-inventory) when
the surrounding UI needs to react to a host-originated appearance update.

### Example

```js
async function applyDarkNativeAppearance() {
    const result = await Arcane.appearance.apply({
        scheme: 'dark',
        captionColor: 'rgb(24, 27, 38)',
        textColor: 'rgb(244, 246, 255)'
    });
    console.log(result.effectiveScheme);
}

document.querySelector('#use-dark-appearance')?.addEventListener(
    'click',
    async function handleDarkAppearanceRequest() {
        await applyDarkNativeAppearance();
    }
);
```
