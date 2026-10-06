import {inspect} from 'node:util';
import Is from 'strong-type';

const is = new Is(false);

export const MCP_PROTOCOL_VERSION = '2025-11-25';

/** An explicit JSON-RPC failure; ordinary tool failures use CallToolResult. */
export class McpProtocolError extends Error {
    constructor(code, message, data) {
        super(message);
        if (!is.integer(code) || !is.string(message)) {
            throw new TypeError('MCP protocol errors require an integer code and string message.');
        }
        this.name = 'McpProtocolError';
        this.code = code;
        if (data !== undefined) this.data = data;
    }
}

/** One initialize-era MCP session over caller-owned Node streams. */
export function createMcpStdioServer({serverInfo, instructions, tools = [], resources = [], onDiagnostic} = {}) {
    if (!record(serverInfo) || !is.string(serverInfo.name) || !is.string(serverInfo.version)) {
        throw new TypeError('MCP serverInfo requires name and version strings.');
    }
    if (instructions !== undefined && !is.string(instructions)) {
        throw new TypeError('MCP instructions must be a string.');
    }
    if (onDiagnostic !== undefined && !is.function(onDiagnostic)) {
        throw new TypeError('MCP onDiagnostic must be a function.');
    }
    const toolRegistry = createRegistry(tools, 'name');
    const resourceRegistry = createRegistry(resources, 'uri');
    for (const {descriptor} of toolRegistry.values()) {
        if (!record(descriptor.inputSchema)) {
            throw new TypeError(`MCP tool ${descriptor.name} requires an inputSchema object.`);
        }
    }
    for (const {descriptor} of resourceRegistry.values()) {
        if (!is.string(descriptor.name)) throw new TypeError('MCP resources require a name string.');
    }
    const pending = new Set();
    const requests = new Map();
    const usedIds = new Set();
    const failures = [];
    const decoder = new TextDecoder(
        'utf-8',
        {fatal: true}
    );
    let input;
    let output;
    let errorOutput;
    let fragments = [];
    let inputChunks = [];
    let phase = 'new';
    let started = false;
    let closing = false;
    let outputFailed = false;
    let clientInfo;
    let clientCapabilities;
    let writes = Promise.resolve();
    let resolveClosed;
    let rejectClosed;
    const closed = new Promise(
        function retainClosedSettlement(resolve, reject) {
            resolveClosed = resolve;
            rejectClosed = reject;
        }
    );
    // Report failures immediately; callers still receive rejection from closed.
    closed.catch(
        function observeReportedFailure() {}
    );
    const server = {start, cancel, drain, close, closed};
    return server;

    function start({input: selectedInput = process.stdin, output: selectedOutput = process.stdout, error: selectedError = process.stderr} = {}) {
        if (started || closing) throw new Error('An MCP STDIO server can start only once.');
        if (selectedOutput === selectedError) throw new TypeError('MCP output and diagnostic streams must be separate.');
        input = selectedInput;
        output = selectedOutput;
        errorOutput = selectedError;
        started = true;
        output.on('error', failOutput);
        output.on('close', outputClosed);
        errorOutput.on('error', diagnosticFailed);
        input.on('error', failInput);
        input.on('end', inputEnded);
        input.on('close', inputClosed);
        input.on('data', receiveChunk);
        return server;
    }

    function cancel(requestId, reason) {
        const request = requests.get(requestId);
        if (!request || request.method === 'initialize' || request.controller.signal.aborted || request.responding) return false;
        request.controller.abort(reason);
        return true;
    }

    async function drain() {
        while (true) {
            await Promise.all(
                [...pending]
            );
            const currentWrites = writes;
            await currentWrites;
            if (!pending.size && currentWrites === writes) return;
        }
    }

    function close({cancelPending = false} = {}) {
        if (cancelPending) {
            for (const request of requests.values()) {
                if (!request.responding) {
                    request.controller.abort(
                        new Error('MCP STDIO session closed.')
                    );
                }
            }
        }
        if (closing) return closed;
        closing = true;
        if (started) {
            input.off('data', receiveChunk);
            input.off('end', inputEnded);
            input.off('close', inputClosed);
            input.pause();
        }
        finishClose().catch(rejectClosed);
        return closed;
    }

    async function finishClose() {
        await drain();
        if (started) {
            input.off('error', failInput);
            output.off('error', failOutput);
            output.off('close', outputClosed);
            errorOutput.off('error', diagnosticFailed);
        }
        fragments = [];
        inputChunks = [];
        requests.clear();
        usedIds.clear();
        if (failures.length) throw new AggregateError(failures, 'MCP STDIO session failed.');
        resolveClosed();
    }

    function report(cause) {
        try {
            if (onDiagnostic) {
                const observation = onDiagnostic(cause);
                if (observation && is.function(observation.then)) {
                    track(
                        Promise.resolve(observation).catch(reportDiagnosticFailure)
                    );
                }
            } else {
                writeDiagnostic(cause);
            }
        } catch (diagnosticError) {
            reportDiagnosticFailure(diagnosticError);
        }
    }

    function reportDiagnosticFailure(cause) {
        failures.push(cause);
        writeDiagnostic(cause);
    }

    function writeDiagnostic(cause) {
        if (!errorOutput) return;
        const work = new Promise(
            function writeDiagnosticText(resolve) {
                try {
                    errorOutput.write(
                        `${diagnosticText(cause)}\n`,
                        'utf8',
                        function diagnosticWritten(diagnosticError) {
                            if (diagnosticError) diagnosticFailed(diagnosticError);
                            resolve();
                        }
                    );
                } catch (diagnosticError) {
                    diagnosticFailed(diagnosticError);
                    resolve();
                }
            }
        );
        track(work);
    }

    function diagnosticFailed(cause) {
        failures.push(cause);
    }

    function track(work) {
        const observed = work.then(
            function finishWork() {
                pending.delete(observed);
            },
            function unexpectedFailure(cause) {
                pending.delete(observed);
                failInput(cause);
            }
        );
        pending.add(observed);
    }

    function failInput(cause) {
        failures.push(cause);
        report(cause);
        close(
            {cancelPending: true}
        );
    }

    function failOutput(cause) {
        if (outputFailed) return;
        outputFailed = true;
        failures.push(cause);
        report(cause);
        close(
            {cancelPending: true}
        );
    }

    function outputClosed() {
        failOutput(
            new Error('MCP output closed before the session drained.')
        );
    }

    function receiveChunk(chunk) {
        inputChunks.push(chunk);
        try {
            const text = is.string(chunk) ? chunk : decoder.decode(
                chunk,
                {stream: true}
            );
            receiveText(text);
            // Retain complete source chunks for an unfinished decoder record.
            // A decoded newline makes earlier chunks unnecessary for that record.
            if (text.includes('\n')) inputChunks = [chunk];
        } catch (cause) {
            const failure = new Error(
                'MCP input could not be decoded or dispatched.',
                {cause}
            );
            failure.inputChunks = inputChunks;
            failure.pendingText = fragments.join('');
            failInput(failure);
        }
    }

    function receiveText(text) {
        const lines = text.split('\n');
        const trailing = lines.pop();
        for (const line of lines) {
            if (closing) return;
            fragments.push(line);
            const complete = fragments.join('');
            fragments = [];
            receiveLine(complete);
        }
        fragments.push(trailing);
    }

    function inputEnded() {
        try {
            receiveText(
                decoder.decode()
            );
            // EOF can terminate the final complete JSON record without a newline.
            const finalLine = fragments.join('');
            fragments = [];
            if (finalLine) receiveLine(finalLine);
        } catch (cause) {
            const failure = new Error(
                'MCP input ended during an unreadable UTF-8 record.',
                {cause}
            );
            failure.inputChunks = inputChunks;
            failure.pendingText = fragments.join('');
            failInput(failure);
            return;
        }
        close();
    }

    function inputClosed() {
        if (!closing) {
            const failure = new Error('MCP input closed without completing its stream.');
            failure.inputChunks = inputChunks;
            failure.pendingText = fragments.join('');
            failInput(failure);
        }
    }

    function receiveLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        } catch (cause) {
            const failure = new Error(
                'MCP input contained malformed JSON.',
                {cause}
            );
            failure.line = line;
            report(failure);
            sendError(
                null,
                new McpProtocolError(-32700, 'Parse error')
            );
            return;
        }
        if (!record(message) || message.jsonrpc !== '2.0') {
            sendError(
                null,
                new McpProtocolError(-32600, 'Invalid Request')
            );
            return;
        }
        const hasId = Object.hasOwn(message, 'id');
        if (!is.string(message.method)) {
            // This server sends no requests; an unsolicited response has no reply.
            if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return;
            sendError(
                null,
                new McpProtocolError(-32600, 'Invalid Request')
            );
            return;
        }
        if (!hasId) {
            receiveNotification(message);
            return;
        }
        if (!requestId(message.id)) {
            sendError(
                null,
                new McpProtocolError(-32600, 'Request id must be a string or integer.')
            );
            return;
        }
        if (usedIds.has(message.id)) {
            sendError(
                message.id,
                new McpProtocolError(-32600, 'Request id was already used in this session.')
            );
            return;
        }
        usedIds.add(message.id);
        const request = {method: message.method, controller: new AbortController(), responding: false};
        requests.set(message.id, request);
        track(
            runRequest(message, request)
        );
    }

    function receiveNotification(message) {
        if (message.params !== undefined && !record(message.params)) return;
        if (message.method === 'notifications/initialized' && phase === 'initialized') {
            phase = 'ready';
        } else if (message.method === 'notifications/cancelled' && record(message.params)) {
            const {requestId: id, reason} = message.params;
            if (requestId(id) && (reason === undefined || is.string(reason))) cancel(id, reason);
        }
    }

    async function runRequest(message, request) {
        try {
            if (message.params !== undefined && !record(message.params)) {
                throw new McpProtocolError(-32602, 'Request params must be an object.');
            }
            const context = {
                signal: request.controller.signal,
                requestId: message.id,
                method: message.method,
                clientInfo,
                clientCapabilities,
                params: message.params
            };
            const params = message.params ?? {};
            const result = await dispatch(message.method, params, context);
            if (!request.controller.signal.aborted) {
                request.responding = true;
                queueMessage(
                    {jsonrpc: '2.0', id: message.id, result}
                );
            }
        } catch (cause) {
            if (request.controller.signal.aborted) {
                report(cause);
            } else {
                request.responding = true;
                const failure = cause instanceof McpProtocolError
                    ? cause
                    : new McpProtocolError(-32603, 'Internal error');
                if (!(cause instanceof McpProtocolError)) report(cause);
                sendError(message.id, failure);
            }
        } finally {
            requests.delete(message.id);
        }
    }

    async function dispatch(method, params, context) {
        if (method === 'initialize') {
            if (phase !== 'new') throw new McpProtocolError(-32600, 'Session is already initialized.');
            if (!is.string(params.protocolVersion) || !record(params.capabilities) || !record(params.clientInfo)
                || !is.string(params.clientInfo.name) || !is.string(params.clientInfo.version)) {
                throw new McpProtocolError(-32602, 'initialize requires protocolVersion, capabilities and clientInfo.');
            }
            clientInfo = params.clientInfo;
            clientCapabilities = params.capabilities;
            phase = 'initialized';
            const capabilities = {};
            if (toolRegistry.size) capabilities.tools = {};
            if (resourceRegistry.size) capabilities.resources = {};
            const result = {protocolVersion: MCP_PROTOCOL_VERSION, capabilities, serverInfo};
            if (instructions !== undefined) result.instructions = instructions;
            return result;
        }
        if (method === 'ping') return {};
        if (phase !== 'ready') throw new McpProtocolError(-32000, 'Send initialize and notifications/initialized first.');
        switch (method) {
            case 'tools/list':
                requireFirstPage(params);
                return {tools: descriptors(toolRegistry)};
            case 'tools/call': {
                if (!is.string(params.name) || (params.arguments !== undefined && !record(params.arguments))) {
                    throw new McpProtocolError(-32602, 'tools/call requires a name and optional arguments object.');
                }
                if (params.task !== undefined) throw new McpProtocolError(-32602, 'Task-augmented execution is not supported.');
                const tool = toolRegistry.get(params.name);
                if (!tool) throw new McpProtocolError(-32602, `Unknown tool: ${params.name}`);
                let result;
                try {
                    const args = params.arguments ?? {};
                    result = await tool.handler(args, context);
                } catch (cause) {
                    if (cause instanceof McpProtocolError || context.signal.aborted) throw cause;
                    report(cause);
                    const text = is.string(cause?.message) ? cause.message : diagnosticText(cause);
                    return {content: [{type: 'text', text}], isError: true};
                }
                if (!record(result) || !is.array(result.content)) {
                    throw new TypeError('MCP tool handlers must return an explicit CallToolResult with a content array.');
                }
                return result;
            }
            case 'resources/list':
                requireFirstPage(params);
                return {resources: descriptors(resourceRegistry)};
            case 'resources/templates/list':
                requireFirstPage(params);
                return {resourceTemplates: []};
            case 'resources/read': {
                if (!is.string(params.uri)) throw new McpProtocolError(-32602, 'resources/read requires a uri string.');
                const resource = resourceRegistry.get(params.uri);
                if (!resource) {
                    throw new McpProtocolError(
                        -32002,
                        'Resource not found',
                        {uri: params.uri}
                    );
                }
                const result = await resource.handler(params, context);
                if (!record(result) || !is.array(result.contents)) {
                    throw new TypeError('MCP resource handlers must return an explicit ReadResourceResult with a contents array.');
                }
                return result;
            }
            default:
                throw new McpProtocolError(-32601, `Method not found: ${method}`);
        }
    }

    function sendError(id, cause) {
        const error = {code: cause.code, message: cause.message};
        if (cause.data !== undefined) error.data = cause.data;
        try {
            queueMessage(
                {jsonrpc: '2.0', id, error}
            );
        } catch (encodingError) {
            report(encodingError);
            queueMessage(
                {jsonrpc: '2.0', id, error: {code: -32603, message: 'Internal error'}}
            );
        }
    }

    function queueMessage(message) {
        if (outputFailed) return;
        const encoded = `${JSON.stringify(message)}\n`;
        // Only the shared output stream is ordered; handlers run independently.
        writes = writes.then(
            function writeMessage() {
                if (outputFailed) return;
                return new Promise(
                    function awaitWrite(resolve, reject) {
                        output.write(
                            encoded,
                            'utf8',
                            function written(cause) {
                                if (cause) reject(cause);
                                else resolve();
                            }
                        );
                    }
                );
            }
        ).catch(failOutput);
    }
}

function record(value) {
    return value !== null && is.object(value) && !is.array(value);
}

function requestId(value) {
    return is.string(value) || is.integer(value);
}

function createRegistry(entries, key) {
    if (!is.array(entries)) throw new TypeError('MCP tools and resources must be arrays.');
    const registry = new Map();
    for (const entry of entries) {
        if (!record(entry) || !is.string(entry[key]) || !is.function(entry.handler)) {
            throw new TypeError(`Each MCP descriptor requires a ${key} string and handler function.`);
        }
        if (registry.has(entry[key])) throw new TypeError(`Duplicate MCP ${key}: ${entry[key]}`);
        const {handler, ...descriptor} = entry;
        registry.set(
            entry[key],
            {descriptor, handler}
        );
    }
    return registry;
}

function descriptors(registry) {
    return Array.from(
        registry.values(),
        function readDescriptor(entry) { return entry.descriptor; }
    );
}

function requireFirstPage(params) {
    if (params.cursor !== undefined) {
        throw new McpProtocolError(-32602, 'This server returns its complete catalog without pagination.');
    }
}

function diagnosticText(cause) {
    if (is.string(cause)) return cause;
    return inspect(
        cause,
        {depth: null, maxArrayLength: null, maxStringLength: null, customInspect: false}
    );
}
