# TWiN Cloud: one request

Use `fetchRequest` from `arcane-os/ai/twin-cloud` for a complete TWiN Cloud
request in Node or a browser with an explicit key and model. It imports no
browser profile, DOM, user singleton, or storage, and starts no work on import.
The existing browser `AI.js` interface remains available for applications that
already use its provider selection, lifecycle, and speech. TWiN Cloud is that
interface's default remote LLM service, named `TWIN`; speech stays on device
and does not use the TWiN access key.

## Node: explicit key, model, and structured result

Install the published `arcane-os` package in the Node project. Keep the key in
the application's existing server configuration, outside source control and
diagnostics. In this example, `server-config.json` is that caller-owned local
configuration file with a `twinKey` property; add its exact path to `.gitignore`
before creating it. The SDK does not discover or write this file.

```javascript
import serverConfig from './server-config.json' with {type: 'json'};
import {fetchRequest} from 'arcane-os/ai/twin-cloud';

const response = await fetchRequest({
    twinKey: serverConfig.twinKey,
    model: 'openai-gpt-oss-20b',
    messages: [{
        role: 'user',
        content: 'Explain why the moon-powered toaster keeps burning breakfast. Return HTML and plain text.'
    }],
    structuredOutput: {
        type: 'object',
        properties: {
            html: {type: 'string'},
            text: {type: 'string'}
        },
        required: ['html', 'text'],
        additionalProperties: false
    }
});

console.log(response);
```

`model` is required and remains exactly the supplied identifier. This function
does not select the browser profile's default model. The example's prompt and
`html`/`text` schema are caller-owned data, not SDK business logic. Changing
those fields changes the requested result without changing the SDK.

The resolved value is the complete parsed provider JSON, including every
choice and provider field. The SDK does not extract only the first message,
parse its content into a second object, or replace the response with an
application-specific record. The supplied schema becomes
`response_format: {type:'json_schema', json_schema:{name:'structured_response',
strict:true, schema:...}}`. `structuredOutput:true` or `'json'` instead selects
`response_format:{type:'json_object'}`; omission leaves structured output off.

## Shared request behavior

The focused API accepts complete `messages`, optional `tools`, `toolChoice`,
`parallelToolCalls`, and `reasoningEffort` in addition to the explicit
`twinKey` and `model`. Tool options use the existing chat-completion wire fields
`tools`, `tool_choice`, and `parallel_tool_calls` when `tools` is nonempty.
A supplied nonempty `reasoningEffort` uses the provider's `reasoning_effort`
field; omission preserves its default. No output limit is added by this API.
The function neither executes tools nor adds provider-response envelope
validation.

Optional `id`, `onRequest(request,id,metadata)`, and
`onResponse(response,id,false)` follow the complete-response `AI.fetchRequest`
callback shape. The request callback runs before dispatch; the response
callback receives the complete parsed result before it is returned. Omitted
`id` uses `Date.now()`; request metadata is
`{operation:'fetch',transport:'http',destination:'https://inference.do-ai.run/v1/chat/completions'}`.
The key is
transport authentication, not part of either callback's message payload. Keep
credentials out of application logging as well.

Only HTTP `429` with a message containing `overload` (case-insensitive) repeats automatically,
after `3000` milliseconds. Another overload repeats the same complete request;
other HTTP failures do not become an automatic retry loop. Pass a fresh
`AbortController`'s `signal` and call `abort()` to cancel. Cancellation during
the request, response-body read, retry wait, or callback settlement prevents
successful result delivery and rejects with `ARCANE_AI_REQUEST_ABORTED`.
Other HTTP failures throw the complete parsed JSON error body or text body.
A missing key uses `AI_PROVIDER_NOT_CONFIGURED`, a missing explicit model
throws `TypeError`, and an unsupported `structuredOutput` input uses
`AI_STRUCTURED_OUTPUT_INVALID`.

The SDK retains no request or response history between calls and uses no
DBOPFS, chat entity, or memory extraction. Each call's `messages` are its
complete caller-supplied context. The caller decides whether and how to keep
the result; this stateless transport adds no saved conversation or migration.

Browser applications can use this same focused import through their generated
managed import map. Browser Fetch and CORS behavior still apply. Importing it
does not instantiate `AI`, read saved preferences, configure speech, or change
the existing `arcane-os/ai` browser entry.

### Shared low-level integration helpers

The same module also exports the helpers used by browser `AI.js`. Ordinary
callers use `fetchRequest`; these exports let SDK transport integration share
the existing implementation rather than maintain another retry or body reader.

| Export | Contract |
| --- | --- |
| `fetchHTTPResponse(url,options)` | Uses the caller's Fetch options, overload retry and cancellation; returns a successful `Response` with its body unconsumed. |
| `fetchJSONResponse(url,options)` | Uses that HTTP owner, requires `application/json`, and returns the complete parsed body without selecting choices. |
| `structuredOutputFormat(value=false)` | Maps false/null/undefined to null, true/`'json'` to `'json'`, and preserves a supplied plain JSON Schema object. Other inputs use `AI_STRUCTURED_OUTPUT_INVALID`. |
| `openAIResponseFormat(format)` | Maps the normalized value to `json_object`, strict `json_schema` named `structured_response`, or null. |
| `isAIRequestAbort(error,signal)` | Recognizes an aborted signal, `AbortError`, or the existing Arcane AI/request cancellation codes. |
| `normalizeAIRequestAbort(error)` | Preserves an existing `ARCANE_AI_REQUEST_ABORTED` error or creates that `AbortError` with the original value as its cause. |

These helpers start no work on import. HTTP helpers require explicit URL and
options; they do not add a key, model, browser state, or retained conversation.
Overload warnings use the shared console logger and preserve the complete
provider error.

## Existing browser AI interface

The following browser example uses the same managed imports as the
[browser speech quick start](browser-speech.md).

## Install and import

Create an application and start its source server:

```bash
npx arcane-os@0.5.17 new hello-twin --path ./hello-twin --target browser
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
