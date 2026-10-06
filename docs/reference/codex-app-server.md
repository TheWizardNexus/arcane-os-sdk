# Native Codex App Server sessions

`arcane-os/codex/app-server` is an optional Node entrypoint for an explicitly
selected native Codex App Server. It exports
`createCodexAppServerSession(options)` and
`openCodexAppServerSession(options)`.

The adapter owns JSONL correlation and session lifecycle, reusing the SDK's
`runProcess` and semantic event manager. Applications own connection selection,
thread routing, prompts, approval decisions, visible presentation and explicit
send actions. It does not install Codex, authenticate an account, attach to a
desktop chat, start a thread during connection, or choose a model.

The [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server)
defines the external protocol: stdio JSONL frames omit `jsonrpc`; initialization
uses `initialize` followed by `initialized`; `turn/start` acceptance is distinct
from the terminal `turn/completed` notification. This transport is separate from
Core's Content-Length-framed `arcane/1` connection.

The source baseline is the current, unversioned official App Server page read
on October 6, 2026, specifically its Protocol, Initialization, Threads, Events
and approval/request sections. This adapter does not claim a pinned Codex CLI
release or generated-schema revision. The documentation describes schema
generation as specific to the CLI version used; no CLI or schema generator was
executed to establish this source contract.

## Open an explicitly selected connection

```javascript
import {createCodexAppServerSession} from 'arcane-os/codex/app-server';

const session = createCodexAppServerSession(
    {
        executable: selectedCodexExecutable,
        args: ['app-server', '--listen', 'stdio://'],
        cwd: selectedWorkingDirectory,
        clientInfo: {name: 'moon_cheese_inventory', title: 'Moon Cheese Inventory', version: '1'}
    }
);

// Store the handle before awaiting so the host can dispose during initialization.
connectionOwner.session = session;
session.subscribe('status', showConnectionStatus);
session.subscribe('serverRequest', askForActualDecision);
await session.connect();

const {thread} = await session.createThread(selectedThreadOptions);
const result = await session.runTurn(
    {
        threadId: thread.id,
        input: 'Count the moon cheese and explain the missing wheel.',
        signal: requestController.signal,
        onDelta: showSelectedLiveDelta,
        onItem: updateSelectedItem,
        onTurn: showTurnStatus
    }
);

// These records contain assistant text, not commands, reasoning or tool envelopes.
showVisibleResult(result.visibleItems, result.status);
await session.dispose();
```

The example's named callbacks and owners belong to the application. Keep a
session alive across related operations; it launches one process per connection,
not one per request. `openCodexAppServerSession(options)` creates a session,
awaits connection readiness and returns it; use the synchronous factory when
the host needs the handle during connection or needs initialization events.
If opening fails, the convenience function disposes the owned process before
rejecting.

Options are `executable` (required), `args` (defaults shown above), `cwd`, `env`,
`clientInfo` and `capabilities`. `env` uses `runProcess`'s environment overrides.
Arguments are actual executable arguments; there is no shell command parser.
On Windows, select an actual native executable or explicitly select Node and
the installed CLI entry script in `args`, instead of passing a `.cmd` launcher.
No operating-system-specific credential store or home-directory assumption is
introduced. Node and the caller-selected native executable are required on
Windows, Linux and macOS; Android requires a host that supplies those process
facilities. A browser renderer cannot import or launch this Node-only adapter.

The default client identity is
`{name:'arcane_sdk',title:'Arcane SDK',version:'1'}`. Caller-supplied identity and
capabilities are forwarded to initialization. Experimental methods require the
server's corresponding capability selection. Avoid opting out of the turn/item
notifications that `runTurn` needs; the adapter does not override your selection
or manufacture missing events.

## Session methods

| Method | Result and ownership |
| --- | --- |
| `connect()` | Promise of the same session after initialization; concurrent calls share the in-flight connection. Ready calls reuse it. |
| `listThreads(params)` | Complete native `thread/list` result, including `data` and cursor. The caller owns pagination. |
| `readThread({threadId,includeTurns,...options})` | Complete native `thread/read` result. No thread resume or event subscription. |
| `readTurn({threadId,turnId})` | Reads the thread with `includeTurns:true`, selects the exact turn, and returns the response shape below. No new turn or thread resume. |
| `createThread(params)` | Complete native `thread/start` result, including `thread`; the server subscribes the connection to that new thread. |
| `resumeThread({threadId,...options})` | Complete native `thread/resume` result for the caller's explicitly selected existing thread. |
| `request(method,params)` | Complete native result, or a correlated RPC error. Use for additional provider methods; no automatic retries. |
| `runTurn(options)` | Waits for the exact accepted turn's terminal notification. Does not create, resume or select a thread. |
| `interrupt({threadId,turnId})` | Native interrupt acknowledgement only; the terminal notification establishes the actual outcome. |
| `respond({id,result},context)` / `respond({id,error},context)` | Queues the actual correlated server-request reply and returns `{id,submitted:true}`. Retain the originating context across asynchronous work. Submission is not resolution. |
| `subscribe(type,listener,options)` | Returns an unsubscribe function; supports the shared event owner's `once` and `signal`. `status` replays immediately. |
| `reconnect()` | Drains the old owned process and initializes a new one. Never replays requests or resumes threads. |
| `dispose()` | Cancels the owned process tree, drains input/output/process completion, releases subscriptions and permanently disposes this session. |

Requests require a ready connection and do not implicitly connect.
`readThread` returns native `{thread:{turns:[{id,status,items,...}],...},...}`
when turns are requested. `readTurn` returns the stored status as supplied,
including an in-progress status if that is what the server returns. A missing
exact ID rejects with `ARCANE_CODEX_TURN_NOT_FOUND`; it never picks another turn.
Neither read operation claims the returned conversation belongs to the desktop
application. Access and available records depend on the selected App Server.

## Input, live callbacks and complete output

`runTurn({threadId,input,signal,onDelta,onItem,onTurn,...turnOptions})` forwards
the remaining options to native `turn/start`. A native input array is sent
unchanged. A string receives only the required native text-item envelope
`[{type:'text',text:input}]`; the string itself is unchanged. No prompt prefix,
trimming, classification, normalization or implicit tool selection occurs.

Register or resume the selected thread before running a turn so the connection
receives its item/turn notifications. Local correlation listeners are installed
before submission. Events that arrive ahead of the acceptance response are
retained in order until the returned turn ID can correlate them.

- `onDelta({threadId,turnId,itemId,delta,phase,method,params})` receives complete
  `item/agentMessage/delta` or `item/commandExecution/outputDelta` content. Use
  `method` to select assistant text for the ordinary UI; command output belongs
  in an explicitly selected inspection surface. `params` preserves all native
  fields. Other delta methods remain available through `notification`.
- `onItem({threadId,turnId,itemId,text,phase,stage,item,params})` receives item
  starts and completions. `stage` is `started` or `completed`; `phase` is the
  provider's phase or `null`, not the lifecycle stage. `text` is agent-message
  text, and is `null` for other item types. `item` remains the complete native
  object, including extension fields.
- `onTurn({threadId,turnId,status,turn})` receives actual turn lifecycle events.
  The `turnAccepted` session event separately carries the start response.

The resolved result is
`{threadId,turnId,status,items,visibleItems,error,turn}`:

- `status` is the actual terminal status: `completed`, `interrupted` or `failed`.
  A provider failure resolves this terminal result with its actual `error`;
  transport and start-request errors reject. Inspect status before committing a
  successful application response.
- `items` contains complete native item objects in first-observed order, updated
  by their final item snapshots and any terminal turn items. It includes commands
  and other diagnostic/protocol item types; it is not durable chat history.
- `visibleItems` contains only agent-message projections
  `{itemId,text,phase}`. Text is complete and unchanged. All supplied phases,
  including `commentary`, `final_answer` or `null`, remain distinct. The app
  decides which phases belong in its visible response; the adapter never joins
  items, inserts separators or rewrites text.
- `turn` and `error` preserve the complete terminal provider objects. There is
  no synthesized successful turn or substituted assistant failure message.

Callbacks are observational and invoked in incoming order, without awaiting
returned promises. This allows an approval owner to await another RPC without
deadlocking stdout. Synchronous failures and rejected callback promises produce
`observerError`; a rejection arriving after disposal goes to `console.error`.
Applications own completion of their asynchronous presentation/decision work.

## Events and server requests

`session.status` is `{state,...details}`, with states `disconnected`,
`connecting`, `ready`, and `disposed`. Ready includes the complete `initialized`
result; connection failure includes `error`. There is no implied authentication,
model readiness, thread ownership or persistence guarantee in a ready status.

Session event names are `status`, `message`, `notification`, `stderr`, `process`,
`error`, `serverRequest`, `serverRequestResponded`, `serverRequestResolved`,
`turnAccepted`, `delta`, `item`, `turn` and `observerError`. Listener arguments
are detail objects directly, not DOM events. Shared semantic event names use
the `arcane.codex.app-server.` prefix and lowercase hyphen-separated suffixes.
The public subscription aliases retain their original spelling:

| Session alias | Shared semantic event |
| --- | --- |
| `serverRequest` | `arcane.codex.app-server.server-request` |
| `serverRequestResponded` | `arcane.codex.app-server.server-request-responded` |
| `serverRequestResolved` | `arcane.codex.app-server.server-request-resolved` |
| `turnAccepted` | `arcane.codex.app-server.turn-accepted` |
| `observerError` | `arcane.codex.app-server.observer-error` |

The other aliases are already lowercase and are appended unchanged to the
prefix. Declaration, subscription and publication share this same mapping;
native Codex wire method names and payload fields are unchanged.

`message` exposes every complete decoded JSONL envelope; `notification` exposes
all native notification methods. `stderr` preserves complete `{stream,chunk}`
records. `process` forwards the SDK process owner's lifecycle events. These
diagnostics are neither application conversation text nor saved chat history.

Every inbound request with a method and ID emits `serverRequest`. Its listener
receives the complete native envelope as its first argument and a separate
origin-bound reply context as its second. This includes approvals, permissions, user input,
MCP elicitation and experimental tool calls. The adapter does not approve,
decline, fabricate tool results or invoke application tools itself. The
application returns the exact native result or error for that request method:

```javascript
async function askForActualDecision(request, context) {
    const result = await applicationDecisionOwner.answer(request);
    context.respond(
        {result}
    );
}
```

The stdout reader keeps consuming while that decision is pending.
The context is `{id,respond}`. `context.respond({result})` or
`context.respond({error})` binds the reply to that exact request and its native
ID. Equivalently, pass the same context object as the second argument to
`session.respond({id:request.id,result},context)`. Retain it before awaiting a
human decision or other work. It is SDK control metadata, not part of the native
request or reply payload.

ID-only `session.respond({id,result})` remains supported while that native ID
has appeared only once in this session. Once an ID is reused, including after
reconnect, ID-only replies throw `ARCANE_CODEX_REQUEST_CONTEXT_REQUIRED` rather
than selecting an origin implicitly. A context from an older request throws
`ARCANE_CODEX_STALE_REQUEST_CONTEXT` when a current request reuses its ID. If
there is no corresponding current request, the existing not-ready/not-found
error applies. No such failure writes a reply to the new process. This also
handles ID reuse within one connection after a request resolves.

`pendingServerRequests` contains `{request,responded,context,contextRequired}`
entries for the current connection. An attention owner can retain that same
context when presenting an already pending request. Submission changes
`responded`; the server's
`serverRequest/resolved` notification removes the entry. A late reply after
resolution, disconnect, or a prior submitted reply is reported explicitly.
Disconnection clears pending requests and includes their complete prior entries
in the connection `error` event as `pendingServerRequests`.
`serverRequestResolved` receives the native `{threadId,requestId}` params after
the corresponding pending entry is removed. The `serverRequestResponded` event
receives `{request,response}`, while `serverRequest` receives the raw request
envelope directly. Clear application attention from actual pending state or
resolution/disconnection, rather than treating local submission as resolution.

## Cancellation and unknown results

A pre-aborted turn rejects with `ARCANE_CANCELLED` and
`details.outcome:'not-submitted'`. After submission, abort requests interruption
as soon as the accepted turn ID is known. It stops that call's `onDelta` and
`onItem` delivery; raw session events and actual `onTurn` terminal status remain
observable. A successful interrupt acknowledgement is not a terminal result.
If interruption itself fails, the operation rejects with an unknown outcome.

Connection loss or disposal before terminal completion rejects a turn with
`ARCANE_CODEX_TURN_UNKNOWN`, `details.outcome:'unknown'`, the actual thread ID,
the turn ID when known, and observed native items. Ordinary pending RPCs reject
with `ARCANE_CODEX_CONNECTION_LOST` and unknown outcome. Native RPC rejection
uses `ARCANE_CODEX_RPC` and retains `details.error`, `response`, `method`,
`requestId`, `params` and `outcome:'rejected'`.

There are no implicit retries, timer-based completions, generic shutdown RPCs,
or claims that stdin EOF durably saves a turn. After reconnecting, use the known
thread and turn IDs with `readTurn` to reconcile. If acceptance was never
observed and no turn ID is known, inspect `readThread({threadId,includeTurns:true})`
and let the application resolve that ambiguity. Never automatically repeat
`turn/start` because its outcome is uncertain. Resume a selected thread only
when the application explicitly intends further work on it.

This page describes the SDK source contract. Native Codex, authentication,
provider behavior and platform execution require evidence from the selected
installed runtime; authored fixture coverage is not evidence of those outcomes.
