# TWiN Cloud requests, images, and state evaluation

Use `fetchRequest` from `arcane-os/ai/twin-cloud` for a complete TWiN Cloud
request in Node or a browser with an explicit key and model. It imports no
browser profile, DOM, user singleton, or storage, and starts no work on import.
The existing browser `AI.js` interface remains available for applications that
already use its provider selection, lifecycle, and speech. TWiN Cloud is that
interface's default remote LLM service, named `TWIN`. Speech is selected
independently: applications can use local models, native browser speech, or
[TWiN Cloud TTS](browser-speech.md#twin-cloud-text-to-speech) with an
application-owned key reader.

| Operation | Public API | Caller supplies | Result |
| --- | --- | --- | --- |
| Chat completion | `fetchRequest(options)` | Key, model, complete messages, and optional tools or output schema | Complete parsed provider JSON |
| State and questions | `fetchSystemOneRequest(options)` | Key, a System One model, complete state, and questions | Complete parsed native System One response |
| Image generation | `generateImages(options)` | Model, prompt, provider parameters, and key or key reader | Every generated image as a Blob in provider order |

These functions share no retained conversation. Choose the operation supported
by the selected model; each section below describes its own transport,
callbacks, cancellation, and retry behavior.

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
`parallelToolCalls`, `reasoningEffort`, and `temperature` in addition to the explicit
`twinKey` and `model`. Tool options use the existing chat-completion wire fields
`tools`, `tool_choice`, and `parallel_tool_calls` when `tools` is nonempty.
A supplied nonempty `reasoningEffort` uses the provider's `reasoning_effort`
field; omission preserves its default. No output limit is added by this API.
The function neither executes tools nor adds provider-response envelope
validation.

An optional caller-selected `temperature` is forwarded unchanged, including
`0`. Omitting it or passing `undefined` leaves the field absent so the selected
provider uses its own default. The SDK does not clamp it, persist it as a
preference, or add an output limit. Each request and its retries keep that
request's value. The browser `AI.fetchRequest` and `AI.streamRequest` object
APIs support the same option on their built-in TWiN route.

Optional `id`, `onRequest(request,id,metadata)`, and
`onResponse(response,id,false)` follow the complete-response `AI.fetchRequest`
callback shape. The request callback runs before dispatch; the response
callback receives the complete parsed result before it is returned. Omitted
`id` uses `Date.now()`; request metadata is
`{operation:'fetch',transport:'http',destination:'https://inference.do-ai.run/v1/chat/completions'}`.
The key is
transport authentication, not part of either callback's message payload. Keep
credentials out of application logging as well.

Before a successful response is consumed, a rejected Fetch or HTTP `529` can
retry up to three times, waiting `3000` milliseconds before each retry. These
two failure types share that three-retry budget. HTTP `429` with a message
containing `overload` (case-insensitive) retains its unlimited three-second
retry behavior and does not consume that budget. Each attempt reuses the exact
destination, Fetch options, serialized request, and signal. Other HTTP errors,
successful-response decoding failures, and application callback failures do not
retry. A known HTTP `529` also retries when reading or parsing its diagnostic
body fails; `onRetry.error` retains that exact failure, which is thrown unchanged
if recovery is exhausted. Diagnostic-body failures for other HTTP statuses do
not retry. The last complete failure is thrown unchanged when recovery is exhausted.
Pass a fresh
`AbortController`'s `signal` and call `abort()` to cancel. Cancellation during
the request, response-body read, retry wait, or callback settlement prevents
successful result delivery and rejects with `ARCANE_AI_REQUEST_ABORTED`.
Other HTTP failures throw the complete parsed JSON error body or text body.
A missing key uses `AI_PROVIDER_NOT_CONFIGURED`, a missing explicit model
throws `TypeError`, and an unsupported `structuredOutput` input uses
`AI_STRUCTURED_OUTPUT_INVALID`.

Optional `onRetry({phase,attempt,delayMs,status,error})` observes each retry.
`phase:'waiting'` arrives before the abortable delay; `phase:'requesting'`
arrives immediately before the next Fetch. `attempt` is the one-based upcoming
retry number across both retry policies, `delayMs` is `3000`, `status` is the
HTTP status or `null` for a rejected Fetch, and `error` is the complete original
failure value. This observer runs synchronously without awaiting its returned
promise. Synchronous throws and rejected promises are reported through the
shared console logger and cannot change the request outcome or trigger another
retry. `onRequest` still runs once per logical request. Retry observations stay
outside the model payload and retained history.

The SDK retains no request or response history between calls and uses no
DBOPFS, chat entity, or memory extraction. Each call's `messages` are its
complete caller-supplied context. The caller decides whether and how to keep
the result; this stateless transport adds no saved conversation or migration.

Browser applications can use this same focused import through their generated
managed import map. Browser Fetch and CORS behavior still apply. Importing it
does not instantiate `AI`, read saved preferences, configure speech, or change
the existing `arcane-os/ai` browser entry.

## Evaluate caller-owned state with System One

Use the named `fetchSystemOneRequest` export for the provider's native
state-and-questions operation. The application supplies the model and complete
provider-compatible `state` and `questions`; the SDK selects no model or scoring
policy and assigns no meaning to questions, answer keys, or scales.

```javascript
import {fetchSystemOneRequest} from 'arcane-os/ai/twin-cloud';

const response = await fetchSystemOneRequest({
    twinKey: applicationRuntime.twinKey,
    model: 'typesafe-jev-1.13.0',
    state: applicationState,
    questions: applicationQuestions,
    signal: controller.signal
});
```

`applicationRuntime`, `applicationState`, `applicationQuestions`, and
`controller` are supplied by the application. The example's JEV identifier is
an explicit caller selection, not an SDK default. For OSS chat-completion models
such as `openai-gpt-oss-120b` and `openai-gpt-oss-20b`, use `fetchRequest` with
caller-owned messages and structured-output settings instead. The application
chooses the operation matching its model's provider contract.

```javascript
fetchSystemOneRequest({
    twinKey,
    model,
    state,
    questions,
    signal,
    id,
    onRequest,
    onResponse,
    onRetry
})
// Promise<complete parsed provider JSON>
```

The SDK posts exactly `{model,state,questions}` as JSON to
`https://inference.do-ai.run/v1/systemone`, using `twinKey` only as bearer
authentication. It adds no prompt, chat envelope, tool call, output limit, or
answer conversion. Caller content stays unchanged within ordinary JSON
transport encoding. The request is serialized before `onRequest`, so that
diagnostic callback cannot rewrite the dispatched payload. The entire parsed
provider JSON reaches `onResponse` and the returned promise without selecting
or transforming answers.

The explicit key/model requirements, optional `signal`, `id`, callbacks,
retry observer, complete errors, and lack of retained history follow the shared
request behavior above. `onRequest(request,id,metadata)` receives
`{operation:'systemone',transport:'http',destination:'https://inference.do-ai.run/v1/systemone'}`
as metadata. `onResponse(response,id,false)` receives the complete parsed
response. Both callbacks are awaited; failures propagate and cancellation is
checked again after they settle. The existing `fetchJSONResponse` owner
provides the same HTTP retries and cancellation for this operation; no separate
transport or retry loop is created.

### Shared low-level integration helpers

The same module also exports the helpers used by browser `AI.js`. Ordinary
callers use `fetchRequest` or `fetchSystemOneRequest`; these exports let SDK
transport integration share the existing implementation rather than maintain
another retry or body reader.

| Export | Contract |
| --- | --- |
| `fetchHTTPResponse(url,options,{onRetry=null}={})` | Uses the caller's exact Fetch options and shared retry/cancellation behavior; returns a successful `Response` with its body unconsumed. The separate optional control observes retries without entering Fetch options. |
| `fetchJSONResponse(url,options,{onRetry=null}={})` | Uses that HTTP owner and retry observer, requires `application/json`, and returns the complete parsed body without selecting choices. |
| `structuredOutputFormat(value=false)` | Maps false/null/undefined to null, true/`'json'` to `'json'`, and preserves a supplied plain JSON Schema object. Other inputs use `AI_STRUCTURED_OUTPUT_INVALID`. |
| `openAIResponseFormat(format)` | Maps the normalized value to `json_object`, strict `json_schema` named `structured_response`, or null. |
| `isAIRequestAbort(error,signal)` | Recognizes an aborted signal, `AbortError`, or the existing Arcane AI/request cancellation codes. |
| `normalizeAIRequestAbort(error)` | Preserves an existing `ARCANE_AI_REQUEST_ABORTED` error or creates that `AbortError` with the original value as its cause. |

These helpers start no work on import. HTTP helpers require explicit URL and
options; they do not add a key, model, browser state, or retained conversation.
Retry warnings and observer failures use the shared console logger and preserve
the complete original error.

## Generate images with an application-selected model

`generateImages` is a separate stateless operation on the same public import.
The application owns the selected model, labels, prompt, provider parameters,
credential source, display, and any saved image. It does not instantiate the
browser AI singleton or change chat, speech, model preferences, or history.

```javascript
import {generateImages} from 'arcane-os/ai/twin-cloud';

const controller = new AbortController();
const {images} = await generateImages({
    model: 'stable-diffusion-3.5-large',
    prompt: 'A moon-powered toaster launches croissants over purple craters.',
    parameters: {n: 2, size: '1024x1024', output_format: 'png'},
    getApiKey: applicationRuntime.getTwinKey,
    signal: controller.signal,
    onProgress({stage}) {
        console.log(stage);
    }
});

for (const image of images) {
    await applicationRuntime.saveGeneratedImage(image.blob, image.mediaType);
}
```

`applicationRuntime.getTwinKey` and `saveGeneratedImage` are caller-owned
functions in this example, not SDK APIs. Pass the credential function with any
required receiver already bound. Use `twinKey` instead when the application
already has its key. `getApiKey()` may return a key or a promise and is called
only when `twinKey` is `undefined`. An explicitly supplied empty key fails with
`AI_PROVIDER_NOT_CONFIGURED`; it does not select another credential source.
The example's model and parameters are application choices, not SDK defaults.

```javascript
generateImages({
    model,
    prompt,
    parameters,
    twinKey,
    getApiKey,
    signal,
    id,
    onRequest,
    onResponse,
    onProgress
})
// Promise<{images: [{blob, mediaType, width?, height?}]}>
```

`parameters` defaults to `{}`, `signal` to `null`, and `id` to `Date.now()`.
All diagnostic and progress callbacks are optional.

The SDK owns the route for these exact supported identifiers:

| Explicit model | Submission and result |
| --- | --- |
| `fal-ai/flux/schnell` | POST `/v1/async-invoke` with `{model_id:model,input:{...parameters,prompt}}`; pending jobs use GET `/v1/async-invoke/{request_id}/status`, then GET `/v1/async-invoke/{request_id}` when the completed status lacks `output.images`. |
| `stable-diffusion-3.5-large` | POST `/v1/images/generations` with `{...parameters,model,prompt}`; images come from the completed response's `data` array. |

Both routes use `https://inference.do-ai.run`. Missing or unsupported model
identifiers reject with `ARCANE_AI_IMAGE_MODEL_UNSUPPORTED`; there is no SDK
image model default. The prompt must be a string and is sent unchanged,
including whitespace. `parameters` is an object of additional provider fields;
the SDK neither supplies nor changes image counts, dimensions, quality, seeds,
or output limits. Supply the prompt only through `prompt`, and the synchronous
model only through `model`; duplicate reserved fields in `parameters` throw
`TypeError` instead of silently replacing one input. Provider-supported
parameter names and values remain that selected model's contract.

Every returned image is materialized in provider order. Base64 image data
becomes a `Blob`; returned URLs are fetched concurrently without an inference
Authorization header or browser credentials. The output's `mediaType` uses the
downloaded Blob's declared type, provider `content_type`, or a declared
`output_format` of `png`, `jpeg`/`jpg`, or `webp`. With no declared type or known
format, it is `application/octet-stream`; the SDK does not guess dimensions or
image metadata. `width` and `height` are included only when the provider supplies
them. The SDK saves nothing and creates no object URLs; the caller owns any
storage and the lifetime of display URLs it creates.

`onRequest(request,id,metadata)` runs once before submission with the complete
provider request. Metadata is `{operation:'images',transport:'http',destination}`.
`onResponse(response,id,false)` runs once with the complete final provider JSON
after successful generation and before image materialization. Intermediate
poll replies do not call it. These are explicit diagnostic callbacks: keep raw
protocol outside ordinary user status and durable chat history. Credentials are
transport-only and are absent from these payloads. The request and image
descriptors are captured before their diagnostic callbacks so observer edits do
not rewrite the operation's content.

`onProgress({stage,model,id,requestId?})` reports semantic stages: `credentials`,
`requesting`, `queued`, `generating`, `downloading`, and `complete`. Pending
stages can repeat; immediately completed jobs skip them. Async job stages
include `requestId` when present. Progress contains no image data or protocol
body. All three callbacks may return a promise; their settlement is awaited
and their failure rejects the operation. `onResponse` means generation returned
a final result, not that media downloads have finished. The resolved promise
delivers all materialized images; a failed download rejects instead of returning
an incomplete collection.

The image operation submits once and performs no automatic retry, including
after a network loss, HTTP `429`, body-read failure, or callback failure. A lost
POST response may correspond to an accepted paid job. This image-specific rule
does not alter chat or speech retry behavior. While a FAL job is `QUEUED` or
`IN_PROGRESS`, polling uses the provider's `Retry-After` delay when supplied,
otherwise one second. Completed jobs accept `COMPLETED` and the guide's
`COMPLETE` spelling. Failed or unusable job results reject with
`ARCANE_AI_INVALID_PROVIDER_RESULT` and the complete result in `error.cause`.
HTTP failures throw their complete parsed JSON or text body; transport,
decoding, and callback failures remain their original errors.

Calling `controller.abort()` cancels local credential/callback waits, requests,
body reads, polling timers, and downloads. It rejects with
`ARCANE_AI_REQUEST_ABORTED` and ignores later settlement from an operation that
does not honor the signal. A callback already running remains caller-owned;
the SDK invokes no subsequent callbacks after cancellation. Local cancellation
does not claim to cancel a remote paid job. Dispose the controller with the
owning page or operation; no global startup wait is required.

The route and response contracts follow DigitalOcean's official
[FAL inference guide](https://docs.digitalocean.com/products/inference/how-to/use-fal-models/)
and [multimodal inference guide](https://docs.digitalocean.com/products/inference/how-to/use-multimodal-inference/).

## Existing browser AI interface

The following browser example uses the same managed imports as the
[browser speech quick start](browser-speech.md).

## Install and import

Create an application and start its source server:

```bash
npx arcane-os@latest new hello-twin --path ./hello-twin --target browser
cd hello-twin
npm install
npm run dev
```

Keep the generated Arcane theme and import map. Place the JavaScript below in
`modules/App.js` at the application root. Run it in the served browser page.
This first example is for the new application created above. An existing
application must complete the saved-preference migration below before importing
`arcane-os/ai` or any module that imports it.

## Supply the key at runtime and display the response

`applicationRuntime` is the **one application-supplied placeholder** in this
example. It represents the authenticated host/application configuration that
supplies a `twinKey` at runtime. Replace the placeholder with your existing
configuration source; do not put a real key in this module, Git, or diagnostics.
The SDK also reads `globalThis.arcane.config.twinCloud.accessKey` when present.

```javascript
import arcaneThemeReady from 'arcane-os/modules/ThemeBootstrap.js';

await arcaneThemeReady;
// In an upgrade bootstrap, the existing preference owner's migration must
// already be complete before this dynamic import evaluates AI.js.
const { default: AI } = await import('arcane-os/ai');
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

## Use a model for one browser request

Both object-form methods accept `model` for that request. For example, an
application can use 20B for document search while retaining its configured
120B conversation model:

```javascript
const result = await ai.fetchRequest({
  model: 'openai-gpt-oss-20b',
  messages: searchMessages
});

await ai.streamRequest({
  model: 'openai-gpt-oss-20b',
  messages: summaryMessages,
  onChunk: displaySummaryChunk
});
```

`searchMessages`, `summaryMessages`, and `displaySummaryChunk` are supplied by
the application. Their content and callbacks keep their ordinary contracts.
The exact model goes into each TWiN request payload without changing `ai.model`
or selecting another provider. Concurrent calls can choose different models;
later calls that omit `model` (or pass `undefined`) use the configured model.
Retries keep the same request model. Provider-returned model metadata remains
authoritative; an assembled stream completion uses the request model only when
the response omits it.

The browser API forwards an explicitly supplied model to registered providers,
whose own request contract determines its meaning. This does not switch or
activate the loaded model of a browser-WASM provider.

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
late. A static `import AI from 'arcane-os/ai'` evaluates before the surrounding
module body, even if its text appears below migration code. Keep AI and its
importing modules out of the bootstrap's static import graph, finish the
existing owner's migration, then cross the dynamic-import boundary:

```javascript
// Place these lines after the application's existing preference migration
// has finished writing and exposing migratedTuple, not before that operation.
const { default: AI } = await import('arcane-os/ai');
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
