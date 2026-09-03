# Arcane runtime entity modules

The synchronized runtime ships 14 entity modules with 29 public ESM bindings.
This page explains each module's capability and host assumptions. The exact
constructor/function/value contracts are canonical in the
[Arcane shared entity inventory](core/arcane-entities.md).

Entity creation and serialization are usually cross-host. Methods that touch
DOM, DBOPFS, local storage, AI, or object URLs require the corresponding browser
or native-WebView dependency.

## Canonical inventory

| Module | Exports | Capability | Availability / normalization |
| --- | --- | --- | --- |
| `ApiModelRecord.js` | `default` | Frozen HTTP(S) model response snapshot. | Cross-host; normalized. |
| `Calculation.js` | `default` | Frozen bounded expression and finite result. | Cross-host; normalized. |
| `Chat.js` | `default` | Conversation messages, tool exchanges, memories, and optional persistence. | Browser/native WebView; AI/DBOPFS behavior mixed. |
| `CommunicationMessage.js` | `default`, `communicationChannels` | Frozen provider-neutral message. | Cross-host; normalized. |
| `CommunicationThread.js` | `default` | Frozen provider-neutral thread containing normalized messages. | Cross-host; normalized. |
| `Document.js` | `default` | File entity specialization for the `documents` table. | Browser/native WebView; DBOPFS behavior mixed. |
| `File.js` | `default` | MIME-aware file open/save and DBOPFS persistence. | Browser/native WebView; mixed storage/rendering errors. |
| `Image.js` | `default` | Image validation, upload, persistence, data URL, Blob URL, and revocation. | Browser/native WebView; mixed File/Blob/DBOPFS errors. |
| `IntentEnvelope.js` | six named exports | Immutable canonical intent record, serialization, rehydration, and privacy-safe audit projection. | Cross-host; strict normalized coded errors. |
| `Preference.js` | `default`, `preferenceSchema` | Boolean, number, select, and text preference definitions. | Cross-host; normalized. |
| `TerminalSession.js` | `default`, `terminalShells` | Frozen terminal session identity, shell, and state. | Cross-host; normalized. |
| `Theme.js` | five exports | Semantic theme tokens, conversion, serialization, and DOM application. | Values cross-host; apply/clear need DOM; normalized/mixed. |
| `User.js` | `default` | User preferences/profile state with DBLS/DBOPFS lifecycle. | Browser/native WebView; storage behavior mixed. |
| `Weather.js` | four classes | Frozen location, observation, day, and snapshot weather entities. | Cross-host; normalized. |

## ApiModelRecord.js

### Overview

`ApiModelRecord` freezes an endpoint, fetch time, metadata, and parsed value so
provider reads can be cached or emitted without leaking mutable response state.

### Example

```javascript
import ApiModelRecord from '/arcane/entities/ApiModelRecord.js';

const record = new ApiModelRecord({
    endpoint: 'https://example.invalid/model',
    fetchedAt: new Date().toISOString(),
    metadata: {},
    value: {ready: true}
});
```

## Calculation.js

### Overview

`Calculation` owns a bounded expression, finite result, creation time, and
`toJSON()` projection. Use `CalculatorEngine` to produce validated instances.

### Example

```javascript
import Calculation from '/arcane/entities/Calculation.js';

console.log(new Calculation({expression: '2 + 2', result: 4}).toJSON());
```

## Chat.js

### Overview

`ChatEntity` owns message history, saved state, tool exchanges, memory lookup,
and optional app-scoped DBOPFS persistence. It installs no independent native
authority; AI and storage dependencies must be available to the host.

`messages` returns provider-facing recurring context. An unresolved structural
call and its matching results remain raw only through their one active provider
continuation. Once that continuation settles, `messages` replaces the protocol
with complete ordinary visible call, public result, and assistant content.
`transcript` returns the narrow human-readable projection owned by the durable
storage boundary. User and assistant records contain only role, complete
visible content, and their real timestamp. A visible tool record may
additionally carry its public name and plain result status, while its `content`
comes only from the tool call's required user-facing `message`. System prompts,
reasoning, provider-extension fields, memory flags, raw tool calls, call IDs,
argument objects, and raw tool returns never enter new DBOPFS writes.
Messages added with `persist:false` participate only in their current operation;
they are not retained in `messages`, `transcript`, memory extraction, or DBOPFS.
One complete nonblank assistant record is also a durable conversation entry, so
a model-authored opening can be stored and survive maintenance before the first
ordinary user turn. No synthetic user record is required or written.

An assistant record may open an ordered array of structural calls with unique
IDs in transient provider state. Until every pending ID receives exactly one
matching nonblank `role:'tool'` result in the same active session, another
user/provider turn is rejected. The durable transcript keeps only each call's
user-facing message and any normalized tool name or result status. Existing
stored files are not rewritten on load. Persistence failures roll
back the complete turn rather than leaving provider and stored history
divergent.

### Example

```javascript
import Chat from '/arcane/entities/Chat.js';

const chat = new Chat();
chat.addUserMessage('Hello.');
```

## CommunicationMessage.js

### Overview

Normalizes one provider message and exports the supported channel values:
email, SMS, MMS, RCS, WhatsApp, and other.

### Example

```javascript
import CommunicationMessage from '/arcane/entities/CommunicationMessage.js';

const message = new CommunicationMessage({
    id: 'message-1',
    channel: 'email',
    body: 'Hello'
});
```

## CommunicationThread.js

### Overview

Normalizes one conversation thread and its `CommunicationMessage` records into
a frozen provider-neutral object.

### Example

```javascript
import CommunicationThread from '/arcane/entities/CommunicationThread.js';

const thread = new CommunicationThread({id: 'thread-1', messages: []});
```

## Document.js

### Overview

`DocumentEntity` specializes `FileEntity` for the app-scoped `documents` table.
Its persistence methods require the same DBOPFS lifecycle and ownership proof as
the base file entity.

### Example

```javascript
import DocumentEntity from '/arcane/entities/Document.js';

const document = new DocumentEntity();
console.log(document.tableName);
```

## File.js

### Overview

`FileEntity` loads and saves supported file formats through app-scoped DBOPFS
and uses the shared Markdown renderer where appropriate.

### Example

```javascript
import FileEntity from '/arcane/entities/File.js';

const file = new FileEntity();
console.log(file.fileName);
```

## Image.js

### Overview

`ImageEntity` extends `FileEntity` with image validation, upload, base64 data
URLs, Blob URLs, and explicit Blob URL revocation.

### Example

```javascript
import ImageEntity from '/arcane/entities/Image.js';

console.log(typeof ImageEntity.prototype.revokeBlobURL);
```

## IntentEnvelope.js

### Overview

Creates immutable canonical v1 intent records while keeping trusted provenance
separate from hostile payload input. Serialization, rehydration, and the audit
projection are bounded and deterministic.

### Example

```javascript
import {
    createIntentEnvelope,
    serializeIntentEnvelope
} from '/arcane/entities/IntentEnvelope.js';

const intent = createIntentEnvelope(
    {originalExpression: 'Summarize the record.', normalizedGoal: 'summarize'},
    {source: 'example'}
);

console.log(serializeIntentEnvelope(intent));
```

## Preference.js

### Overview

Defines preference types, option normalization, value validation, JSON
projection, and schema normalization for shared stores and forms.

### Example

```javascript
import Preference from '/arcane/entities/Preference.js';

const preference = new Preference({
    key: 'density',
    type: 'select',
    defaultValue: 'comfortable',
    options: ['comfortable', 'compact']
});
```

## TerminalSession.js

### Overview

Normalizes terminal session id, shell, state, updates, and JSON projection. The
entity does not start a process; `TerminalClient` owns the native bridge call.

### Example

```javascript
import TerminalSession from '/arcane/entities/TerminalSession.js';

console.log(TerminalSession.shell('auto'));
```

## Theme.js

### Overview

Owns the shared light/dark semantic token sets, color conversion, JSON
projection, DOM application, and clearing. Token work is cross-host; `apply()`
and `clear()` require a document root.

### Example

```javascript
import Theme, {arcaneDarkThemeTokens} from '/arcane/entities/Theme.js';

const theme = new Theme({name: 'example', tokens: arcaneDarkThemeTokens});
console.log(theme.toJSON());
```

## User.js

### Overview

Owns persisted user preference/profile fields, explicit-preference updates,
fresh reads, saves, and JSON projection. It installs `window.user` after its
DBLS/DBOPFS lifecycle and emits `user-entity-loaded`.

### Example

```javascript
import UserEntity from '/arcane/entities/User.js';

console.log(typeof UserEntity.prototype.toJSON);
```

## Weather.js

### Overview

Exports four frozen normalized records: `WeatherLocation`,
`WeatherObservation`, `WeatherDay`, and `WeatherSnapshot`.

### Example

```javascript
import {WeatherLocation} from '/arcane/entities/Weather.js';

const location = new WeatherLocation({name: 'Houston'});
console.log(location.toJSON());
```

## Availability and protocol details

Entity modules are delivered by browser ESM at `/arcane/entities/`. They do not
cross Core by being imported. Individual persistence, AI, DOM, or native calls
cross the dependency named by that entity. See
[availability and normalization](availability-and-normalization.md) and the
[deep protocol guide](protocols.md).
