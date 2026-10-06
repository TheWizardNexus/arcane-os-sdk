# MCP STDIO server

Expose application-owned tools and static resources to an MCP client with
`arcane-os/mcp/stdio`. This optional Node entrypoint owns one JSON-RPC session,
UTF-8 newline framing, discovery, request correlation, cooperative cancellation,
and graceful drain. The application owns its launch command, tool definitions,
resource contents, business behavior, and underlying service lifetime.

Availability: Node on Windows, Linux, and macOS, using the package's supported
Node version. Android requires a host that supplies the same Node stream and
process environment. Importing the entrypoint starts no process or listener.
It is separate from the native Core `arcane/1` transport and its Content-Length
frames; the two stream formats are not interchangeable.

## createMcpStdioServer

```javascript
import {createMcpStdioServer} from 'arcane-os/mcp/stdio';

const menu = {
    content: 'Moon soup\nExtra tentacles available.',
    message: {chef: 'Octopus', open: true}
};

const server = createMcpStdioServer(
    {
        serverInfo: {name: 'moon-pantry', version: '1.0.0'},
        instructions: 'Ask moon.menu for the complete lunar dinner menu.',
        tools: [
            {
                name: 'moon.menu',
                description: 'Read the complete lunar dinner menu.',
                inputSchema: {type: 'object'},
                annotations: {readOnlyHint: true},
                handler: readMenu
            }
        ],
        resources: [
            {
                uri: 'pantry://menu',
                name: 'menu',
                title: 'Lunar dinner menu',
                mimeType: 'application/json',
                handler: readMenuResource
            }
        ]
    }
);

function readMenu(args, {signal}) {
    signal.throwIfAborted();
    return {
        content: [{type: 'text', text: JSON.stringify(menu)}],
        structuredContent: menu
    };
}

function readMenuResource({uri}, {signal}) {
    signal.throwIfAborted();
    return {
        contents: [{uri, mimeType: 'application/json', text: JSON.stringify(menu)}]
    };
}

server.start();
try {
    await server.closed;
} catch {
    // The adapter already sent its diagnostic to stderr.
    process.exitCode = 1;
}
```

Save this in the consuming application and configure the MCP client's subprocess
command as `node` with that application's script path. Client configuration
file formats and process launch policy remain client-owned. Change `menu` to
change the complete result; no model, repository, or native host is needed for
this example.

The application explicitly converts its domain record into an MCP result.
The SDK does not guess from `content`, `message`, or other domain field names.
The serialized text in this example is an application-selected representation;
the SDK never adds it automatically.

### Parameters

`createMcpStdioServer(options)` returns a server object synchronously.

| Option | Contract |
| --- | --- |
| `serverInfo` | Required MCP implementation object with `name` and `version` strings. Optional MCP implementation fields are passed through. |
| `instructions` | Optional complete instruction string returned by initialization. |
| `tools` | Optional static array; each entry is a complete MCP tool descriptor plus `handler(args, context)`. Defaults to `[]`. Tool names identify handlers exactly and must be unique. |
| `resources` | Optional static array; each entry is a complete MCP resource descriptor plus `handler(params, context)`. Defaults to `[]`. Each resource requires `uri` and `name`; URIs identify handlers exactly and must be unique. |
| `onDiagnostic` | Optional error observer. Omit it for complete error text on the selected stderr stream. It may return a promise, which participates in drain. Observer failures are reported to stderr and retained by `closed`. |

The factory captures catalog entries at construction. Discovery preserves
descriptor fields, including authored schemas, descriptions, annotations,
icons, and metadata; only the local `handler` function is omitted. No tool
arguments, descriptions, schemas, resources, or result content are injected,
trimmed, rewritten, or shortened. Supply JSON-serializable protocol values.

The SDK checks the request envelope and required result container. It does not
provide a general JSON Schema evaluator. The application supplies a valid
`inputSchema` object, owns the handler's input semantics, and ensures any
declared `outputSchema` matches its structured result. This adapter does not
implement task-augmented execution; descriptors must describe ordinary tool
execution.

### Handler inputs and results

Tool handlers receive `params.arguments` unchanged. Omitted arguments become
an empty object as the protocol's no-argument case. Resource handlers receive
the complete `resources/read` params object, including its exact `uri` and
any metadata. A handler may return its result directly or return a promise.

Each handler receives a context with:

- `signal`: its own request's `AbortSignal`;
- `requestId`: the original string or integer ID, including numeric zero;
- `method`: `tools/call` or `resources/read`;
- `params`: the complete request params object;
- `clientInfo` and `clientCapabilities`: the client's initialization objects.

A tool handler returns an explicit MCP `CallToolResult`, including a `content`
array and optional `structuredContent`, `isError`, `_meta`, or other protocol
fields. All supplied content blocks and JSON fields pass through. Resource
handlers return an explicit `ReadResourceResult` with a `contents` array;
complete text or already encoded binary resource contents pass through.
The application creates these protocol result objects deliberately. A plain
domain object with `content: 'some text'` is not a `CallToolResult` and produces
an internal protocol error rather than being silently converted.

For a domain failure, return a complete `CallToolResult` with `isError: true`.
An ordinary exception thrown by a tool handler becomes an `isError: true`
text result containing the exception's complete message, and the complete
exception is also reported through diagnostics. Throw `McpProtocolError` for
an explicit JSON-RPC failure. Other resource or adapter exceptions produce
`-32603` and a diagnostic; malformed result containers and non-serializable
results also produce `-32603`.

## start

`server.start({input, output, error})` attaches to caller-owned Node streams and
returns the same server. Defaults are `process.stdin`, `process.stdout`, and
`process.stderr`. Start each server exactly once with an open readable input and
open writable output/diagnostic streams. Output and diagnostics must be separate
streams. Byte-mode input preserves split UTF-8 sequences; a stream already
decoded into strings remains responsible for its own decoding.

Messages are processed as their newline arrives, without waiting for EOF. A
final complete JSON record is also accepted when EOF arrives without its final
newline. LF and CRLF transport endings are accepted. JSON escaping preserves
embedded line breaks in the decoded payload. Malformed JSON receives `-32700`;
its complete original line is included in diagnostics. Invalid UTF-8 fails at
the decoder and closes the transport with the complete affected input chunks
and pending decoded text in its diagnostic error.

Requests execute independently, including overlapping calls to one tool.
Only complete output writes are ordered, waiting for each Node write callback
before sending the next record. The application decides whether its own data
access requires narrower serialization. The adapter adds no process-wide queue.

Only JSON-RPC messages are written to `output`. Application handlers and their
dependencies must also reserve stdout for protocol traffic; use stderr or the
application's diagnostic owner for logs. The adapter does not replace global
console functions.

## cancel

`server.cancel(requestId, reason)` requests cooperative cancellation and returns
`true` only when an active cancellable handler was signalled. String and numeric
IDs remain distinct. Unknown, completed, already cancelled, and initialization
requests return `false`. The same behavior handles client
`notifications/cancelled` messages. Late results from cancelled work have no
protocol response, as described by the
[MCP cancellation contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation).

The handler must pass its signal to its actual I/O or computation and release
owned resources. Signalling does not prove external work stopped. The adapter
retains the handler promise until it really settles; a handler that ignores
cancellation can keep drain and close pending.

## drain

`await server.drain()` waits for accepted handlers, diagnostic observers, and
output write callbacks to settle. It does not stop input or abort requests, so
newly accepted work can extend the wait. Use `close()` when input must first
stop. Tool and request errors are delivered as protocol outcomes; transport and
diagnostic delivery failures are retained by `closed`.

## close

`await server.close({cancelPending: false})` stops reading, pauses the input,
drains accepted work and writes, detaches the adapter's stream listeners, and
settles `closed`. It is idempotent. Normal input EOF follows this same graceful
path. Explicit `cancelPending: true` aborts pending work instead; repeated close
may request cancellation while an earlier graceful close is draining.

Stream failures request cancellation, report diagnostics, and reject `closed`
after owned work settles. An input closed without EOF is a transport failure.
The adapter does not end or destroy caller streams, terminate the process,
install process signal handlers, start an application host, or close
application services. The launcher owns those actions after the adapter drains.

## closed

`server.closed` is a promise for actual session cleanup. It resolves after a
normal close or EOF and rejects with an `AggregateError` when transport or
diagnostic delivery failed. Observe it even when the initiating caller continues
other work. Request failures alone do not close the session.

## MCP_PROTOCOL_VERSION

`MCP_PROTOCOL_VERSION` is exactly `'2025-11-25'`. Initialization always returns
that supported version. A client proposing another version must accept this
profile or disconnect. This is the initialize/initialized STDIO profile;
support for later discovery-based profiles is not implied. See the normative
[lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
and [STDIO transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).

Supported requests are `initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`, and `resources/templates/list` (an empty
template catalog). Tools and resources capabilities are advertised when their
catalogs are nonempty. Lists return their complete catalogs without pagination;
supplying a cursor receives `-32602`. Send `notifications/initialized` after
the initialization response before ordinary operations.

There are no prompts, subscriptions, list-change events, MCP logging requests,
server-to-client requests, sampling, elicitation, task augmentation, HTTP
transport, or automatic client configuration. Unknown methods return `-32601`;
notifications never receive responses. JSON-RPC batches are not part of this
profile. IDs must be strings or integers and are unique for the session.

The result shapes follow the official
[tool](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
and [resource](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
contracts. This narrow adapter does not claim every optional MCP capability.

## McpProtocolError

`new McpProtocolError(code, message, data)` represents an explicit protocol
failure. `code` is a JSON-RPC integer, `message` is its complete string, and
optional `data` is JSON-serializable protocol detail. It extends `Error` and
exposes `name`, `code`, `message`, and optional `data`.

The adapter uses `-32700` for malformed JSON, `-32600` for invalid requests,
`-32601` for unknown methods, `-32602` for malformed params or unknown tools,
`-32603` for internal failures, and `-32002` for a missing resource. Its
`-32000` lifecycle error requests initialization before ordinary operations.

## Evidence boundary

`test/mcp-stdio-server.test.mjs` contains focused in-memory stream fixtures for
these contracts. Authored fixtures and source review do not establish an
executed client integration or platform run. Run local tests only under the
applicable explicit testing or selected-output authority.
