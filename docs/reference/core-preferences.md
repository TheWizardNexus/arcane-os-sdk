# Core preferences service

`createPreferencesService({file})` from `arcane-os/core/preferences` supplies the
existing `Arcane.preferences` RPC methods to a native Core host. The default
export is the same factory. Construction performs no filesystem work. The
application selects its writable file and owns preference names, defaults and
schemas; this service does not invent them or alter operating-system settings.

```js
import path from 'node:path';
import {createPreferencesService} from 'arcane-os/core/preferences';

export default function createMoonPreferences(options, context) {
    return createPreferencesService({
        file: path.join(context.stateRoot, 'moon-preferences.json')
    });
}
```

Select this application-owned factory through `native.services`, and include it
in `package.nativeResources`. Supply the application's selected `stateRoot`
through the explicit launch configuration. See [native packaging](core-native-packaging.md#launch-time-locations).

| Method | Input | Result |
| --- | --- | --- |
| `preferences.list` | `{}` | `{keys}` in sorted order |
| `preferences.get` | `{key}` | `{key,found,value}`; missing value is `null` |
| `preferences.set` | `{key,value}` | `{key,value}` after file replacement |
| `preferences.setMany` | `{entries}` | `{keys,count}` after file replacement |
| `preferences.delete` | `{key}` | `{key,deleted}` |

Storage remains `{schemaVersion:1,entries}`. Exact keys, complete JSON values and
additional existing document metadata are retained. A missing file starts with
empty entries; reading it does not create a file. Unreadable or malformed files
report their real errors and are not replaced with an empty record. Values that
JSON cannot represent completely fail before replacement. There is no migration,
truncation, namespace rewrite, default injection or frozen result.

Operations selecting the same resolved filename share one ordered queue within
the Core process. This is not a cross-process file lock. Writes flush their new
content and replace the selected file before acknowledgment. Filesystem failures
remain observable, including cleanup errors; this is not a claim of survival
across every hardware or operating-system failure.

`set`, `setMany` and `delete` use `lifetime:'service'`: renderer cancellation does
not discard accepted writes. `drain()` and `dispose()` stop acceptance and wait
for accepted operations; later calls reject with `CORE_CLOSING`. Read operations
observe their request cancellation. Use the existing Core host shutdown owner
so saved preferences finish before the native process exits.
