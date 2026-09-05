# TWiN Cloud: one request

TWiN Cloud is the high-level `AI.js` default remote LLM service, named `TWIN`.
Speech stays on device and does not use the TWiN access key. This guide uses the
same managed browser imports as the [browser speech quick start](browser-speech.md).

## Install and import

Create an application and start its source server:

```bash
npx arcane-os@0.5.15 new hello-twin --path ./hello-twin --target browser
cd hello-twin
npm install
npm run dev
```

Keep the generated Arcane theme and import map. Place the JavaScript below in
`apps/hello-twin/modules/App.js`. Run it in the served browser page, not Node.
This first example is for the new application created above. An existing
application must complete the saved-preference migration below before importing
`arcane/AI` or any module that imports it.

## Supply the key at runtime and display the response

`applicationRuntime` is the **one application-supplied placeholder** in this
example. It represents the authenticated host/application configuration that
supplies a `twinKey` at runtime. Replace the placeholder with your existing
configuration source; do not put a real key in this module, Git, or diagnostics.
The SDK also reads `globalThis.arcane.config.twinCloud.accessKey` when present.

```javascript
import arcaneThemeReady from 'arcane/ThemeBootstrap';

await arcaneThemeReady;
// In an upgrade bootstrap, the existing preference owner's migration must
// already be complete before this dynamic import evaluates AI.js.
const { default: AI } = await import('arcane/AI');
const applicationRuntime = globalThis.applicationRuntime;
const ai = new AI();
ai.twinKey = applicationRuntime.twinKey;

const button = document.createElement('button');
button.textContent = 'Ask TWiN';
const output = document.createElement('pre');
output.style.whiteSpace = 'pre-wrap';
document.body.append(button, output);

button.addEventListener('click', async function askTwin() {
  button.disabled = true;
  output.textContent = 'Thinking';
  try {
    const response = await ai.fetchRequest({
      messages: [{ role: 'user', content: 'Say hello in one sentence.' }]
    });
    output.textContent = JSON.stringify(response, null, 2);
  } catch (error) {
    output.textContent = `${error.code ?? 'ERROR'}\n${error.message}`;
  } finally {
    button.disabled = false;
  }
});
```

The example displays the complete returned response so its actual fields are
visible. It makes one `fetchRequest()` per click. A normal `new AI()` selects
TWiN Cloud and its default model, `openai-gpt-oss-120b`; assigning `twinKey`
reconciles that remote route's readiness. No browser speech model is loaded by
this request. `ai.license` remains an alias of `ai.twinKey` for existing callers.

For an application-owned cancellation control, pass a fresh
`AbortController`'s `signal` to `fetchRequest({messages,signal})` and call that
controller's `abort()` when the operation is cancelled or its page detaches.
`streamRequest()` is the corresponding object-form streaming API. See the
[AI module reference](../runtime-modules.md#aijs) for its complete options.

## Migrate saved preference tuples before using them

The six tuple slots consumed by `ai.setAI(...tuple)` are:

| Slot | Meaning | Migration |
| --- | --- | --- |
| 0 | LLM provider | Exact uppercase `OPENAI` becomes `TWIN`. |
| 1 | STT provider | Preserve. |
| 2 | TTS provider | Preserve. |
| 3 | LLM model or default-model sentinel | Exact uppercase `OPENAI` becomes `TWIN`. |
| 4 | TTS model | Preserve. |
| 5 | STT model | Preserve. |

Use this narrow transformation in the application's existing preference loader:

```javascript
function migrateSavedAISelection(savedTuple) {
  return savedTuple.map(function migrateProviderOrDefault(value, slot) {
    return (slot === 0 || slot === 3) && value === 'OPENAI' ? 'TWIN' : value;
  });
}

const savedTuple = [
  'OPENAI', 'LOCAL_SPEACH', 'LOCAL_SPEACH',
  'OPENAI', 'LOCAL_SPEACH', 'LOCAL_SPEACH'
];
const migratedTuple = migrateSavedAISelection(savedTuple);
console.log(migratedTuple);
// ['TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH', 'TWIN', 'LOCAL_SPEACH', 'LOCAL_SPEACH']
```

In the application's upgrade bootstrap, read saved settings, run this
transformation, and complete the write through the **existing application
preference owner before importing `AI.js` or any module that imports it**.
Ensure that owner also exposes the migrated tuple to the current page before
continuing. Use the application's actual storage/readiness operations; the SDK
does not supply a new migration storage API.

This ordering matters during module evaluation: `AI.js` installs its
user-readiness handler immediately. If `window.user.ready` is already true, it
can immediately read that user's preference tuple and construct `window.ai`.
Waiting until a later `setAI()`, provider-startup call, or button click is too
late. A static `import AI from 'arcane/AI'` evaluates before the surrounding
module body, even if its text appears below migration code. Keep AI and its
importing modules out of the bootstrap's static import graph, finish the
existing owner's migration, then cross the dynamic-import boundary:

```javascript
// Place these lines after the application's existing preference migration
// has finished writing and exposing migratedTuple, not before that operation.
const { default: AI } = await import('arcane/AI');
const ai = new AI(...migratedTuple);
```

Here `migratedTuple` is the result of the exact transformation shown above,
using the real saved tuple in the application's bootstrap. Configure browser
speech only after this initialization. Migration belongs to upgrade startup;
do not inject it into an in-flight request. For later changes to an already
valid active selection, `await ai.transitionAI(...migratedTuple)` remains the
asynchronous lifecycle; it unloads roles and disposes SDK-owned browser speech,
so configure desired speech afterward. It is not a substitute for migration
before the first AI import.

The SDK deliberately has no built-in `OPENAI` alias and performs no saved-data
migration. This guide does not instruct a rewrite of chat history or unrelated
settings. Preserve every tuple value except those two exact sentinel matches.
In particular, do not change:

- `openai-gpt-oss-120b` or `openai-gpt-oss-20b`: actual upstream model IDs;
- OpenAI-compatible chat-completion wire terminology; or
- Core's separate `provider:'openai'` behavior and public native contract.

TWiN's default-model sentinel `TWIN` resolves to `openai-gpt-oss-120b`.
An explicitly saved `openai-gpt-oss-20b` in slot 3 stays that exact model.

## Related

- [Browser speech quick start and streaming](browser-speech.md)
- [Normalized AI and readiness](../README.md#normalized-ai)
- [Core AI contracts](../core/arcane-ai-contracts.md)
