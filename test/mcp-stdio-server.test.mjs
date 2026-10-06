import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {createMcpStdioServer, MCP_PROTOCOL_VERSION, McpProtocolError} from '../src/mcp/stdio-server.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(
        function retainResolve(settle) { resolve = settle; }
    );
    return {promise, resolve};
}

function fixture(t, options = {}) {
    const input = new PassThrough();
    const output = new PassThrough();
    const error = new PassThrough();
    const messages = [];
    const waiting = new Map();
    const diagnostics = [];
    let partial = '';
    output.setEncoding('utf8');
    error.setEncoding('utf8');
    output.on('data', collectMessages);
    error.on('data', collectDiagnostics);
    const server = createMcpStdioServer(
        {serverInfo: {name: 'moon-pantry', version: '1.0.0'}, ...options}
    );
    server.start(
        {input, output, error}
    );
    t.after(cleanup);
    return {server, input, output, error, messages, diagnostics, send, response, initialize};

    function collectMessages(text) {
        const lines = (partial + text).split('\n');
        partial = lines.pop();
        for (const line of lines) {
            const message = JSON.parse(line);
            messages.push(message);
            waiting.get(message.id)?.resolve(message);
        }
    }

    function collectDiagnostics(text) {
        diagnostics.push(text);
    }

    function send(id, method, params) {
        const message = {jsonrpc: '2.0', method};
        if (id !== undefined) message.id = id;
        if (params !== undefined) message.params = params;
        input.write(`${JSON.stringify(message)}\n`);
    }

    function response(id) {
        const existing = messages.find(
            function matchesId(message) { return message.id === id; }
        );
        if (existing) return Promise.resolve(existing);
        const arrival = deferred();
        waiting.set(id, arrival);
        return arrival.promise;
    }

    async function initialize(version = MCP_PROTOCOL_VERSION) {
        send(
            'initialize',
            'initialize',
            {protocolVersion: version, capabilities: {}, clientInfo: {name: 'fixture-client', version: '1.0.0'}}
        );
        const result = await response('initialize');
        send(undefined, 'notifications/initialized');
        return result;
    }

    async function cleanup() {
        await server.close(
            {cancelPending: true}
        ).catch(
            function alreadyAssertedFailure() {}
        );
        input.destroy();
        output.destroy();
        error.destroy();
    }
}

test(
    'MCP negotiates one explicit profile and preserves complete descriptors and result objects',
    async function completeContracts(t) {
        const domain = {content: '  Lunar soup\r\n🦑 e\u0301\n  ', message: {chef: 'Octopus', ready: true}};
        const toolResult = {content: [{type: 'text', text: JSON.stringify(domain)}], structuredContent: domain};
        const resourceResult = {contents: [{uri: 'pantry://menu', mimeType: 'application/json', text: JSON.stringify(domain)}]};
        const inputSchema = {type: 'object', properties: {content: {type: 'string'}}, required: ['content']};
        const annotations = {readOnlyHint: true};
        let receivedArguments;
        let receivedContext;
        let receivedResourceParams;
        const session = fixture(
            t,
            {
                instructions: '  Complete instructions\nSecond line  ',
                tools: [
                    {
                        name: 'moon.menu',
                        title: 'Moon menu',
                        description: 'Read the complete lunar soup menu.',
                        inputSchema,
                        annotations,
                        handler: readMenu
                    }
                ],
                resources: [
                    {
                        uri: 'pantry://menu',
                        name: 'menu',
                        mimeType: 'application/json',
                        handler: readMenuResource
                    }
                ]
            }
        );
        function readMenu(args, context) {
            receivedArguments = args;
            receivedContext = context;
            return toolResult;
        }
        function readMenuResource(params) {
            receivedResourceParams = params;
            return resourceResult;
        }
        const initialized = await session.initialize('2026-07-28');
        assert.equal(initialized.result.protocolVersion, MCP_PROTOCOL_VERSION);
        assert.deepEqual(
            initialized.result.capabilities,
            {tools: {}, resources: {}}
        );
        assert.equal(initialized.result.instructions, '  Complete instructions\nSecond line  ');
        session.send('tools', 'tools/list');
        session.send('resources', 'resources/list');
        session.send(
            'call',
            'tools/call',
            {name: 'moon.menu', arguments: domain, _meta: {selection: 'full'}}
        );
        session.send(
            'read',
            'resources/read',
            {uri: 'pantry://menu', _meta: {selection: 'full'}}
        );
        await session.server.drain();
        const listed = await session.response('tools');
        assert.deepEqual(
            listed.result.tools,
            [{name: 'moon.menu', title: 'Moon menu', description: 'Read the complete lunar soup menu.', inputSchema, annotations}]
        );
        assert.deepEqual((await session.response('call')).result, toolResult);
        assert.deepEqual((await session.response('read')).result, resourceResult);
        assert.deepEqual(receivedArguments, domain);
        assert.equal(receivedContext.requestId, 'call');
        assert.equal(receivedContext.method, 'tools/call');
        assert.deepEqual(
            receivedContext.clientInfo,
            {name: 'fixture-client', version: '1.0.0'}
        );
        assert.equal(receivedContext.params._meta.selection, 'full');
        assert.deepEqual(
            receivedResourceParams,
            {uri: 'pantry://menu', _meta: {selection: 'full'}}
        );
        assert.equal(Object.hasOwn((await session.response('resources')).result.resources[0], 'handler'), false);
    }
);

test(
    'MCP decodes fragmented UTF-8 and replies before input EOF',
    async function fragmentedInput(t) {
        const session = fixture(
            t,
            {
                tools: [
                    {
                        name: 'echo',
                        inputSchema: {type: 'object'},
                        handler: echo
                    }
                ]
            }
        );
        function echo(args) { return {content: [{type: 'text', text: args.text}]}; }
        await session.initialize();
        const text = '  🦑 café 日本語\r\nSecond line\n\nLast line  ';
        const request = {jsonrpc: '2.0', id: 0, method: 'tools/call', params: {name: 'echo', arguments: {text}}};
        const frame = Buffer.from(
            `${JSON.stringify(request)}\r\n`,
            'utf8'
        );
        const split = frame.indexOf('🦑') + 1;
        session.input.write(
            frame.subarray(0, split)
        );
        session.input.write(
            frame.subarray(split)
        );
        const message = await session.response(0);
        assert.equal(message.result.content[0].text, text);
        assert.equal(session.input.readableEnded, false);
    }
);

test(
    'MCP runs independent requests concurrently and cancels only the matching typed id',
    async function concurrentCancellation(t) {
        const began = deferred();
        let heldSignal;
        const session = fixture(
            t,
            {tools: [{name: 'cook', inputSchema: {type: 'object'}, handler: cook}]}
        );
        async function cook(args, context) {
            if (args.wait) {
                heldSignal = context.signal;
                const cancelled = deferred();
                context.signal.addEventListener(
                    'abort',
                    cancelled.resolve,
                    {once: true}
                );
                began.resolve();
                await cancelled.promise;
            }
            return {content: [{type: 'text', text: args.text}]};
        }
        await session.initialize();
        session.send(
            0,
            'tools/call',
            {name: 'cook', arguments: {wait: true, text: 'slow'}}
        );
        await began.promise;
        session.send(
            '0',
            'tools/call',
            {name: 'cook', arguments: {text: 'fast'}}
        );
        assert.equal((await session.response('0')).result.content[0].text, 'fast');
        session.send(
            undefined,
            'notifications/cancelled',
            {requestId: 0, reason: 'The moon diner left.'}
        );
        await session.server.drain();
        assert.equal(heldSignal.aborted, true);
        assert.equal(heldSignal.reason, 'The moon diner left.');
        assert.equal(session.server.cancel('unknown'), false);
        assert.equal(
            session.messages.some(
                function cancelledResponse(message) { return message.id === 0; }
            ),
            false
        );
    }
);

test(
    'MCP distinguishes protocol errors, tool execution errors and malformed handler results',
    async function errorContracts(t) {
        const session = fixture(
            t,
            {
                tools: [
                    {name: 'broken', inputSchema: {type: 'object'}, handler: broken},
                    {name: 'explicit', inputSchema: {type: 'object'}, handler: explicit},
                    {name: 'domain', inputSchema: {type: 'object'}, handler: domain}
                ]
            }
        );
        function broken() { throw new Error('The entire kitchen report\nSecond line'); }
        function explicit() {
            throw new McpProtocolError(
                -32602,
                'Missing menu',
                {requested: 'moon'}
            );
        }
        function domain() { return {content: 'domain text', message: {ready: false}}; }
        session.send('early', 'tools/list');
        assert.equal((await session.response('early')).error.code, -32000);
        await session.initialize();
        session.input.write('{invalid json}\n[]\n');
        session.send('unknown', 'unknown/method');
        session.send(
            'bad-params',
            'tools/call',
            []
        );
        session.send(
            'missing',
            'resources/read',
            {uri: 'pantry://missing'}
        );
        for (const name of ['broken', 'explicit', 'domain']) {
            session.send(
                name,
                'tools/call',
                {name}
            );
        }
        session.send(undefined, 'unknown/notification');
        await session.server.drain();
        assert.equal((await session.response('unknown')).error.code, -32601);
        assert.equal((await session.response('bad-params')).error.code, -32602);
        assert.equal((await session.response('missing')).error.code, -32002);
        assert.deepEqual(
            (await session.response('broken')).result,
            {content: [{type: 'text', text: 'The entire kitchen report\nSecond line'}], isError: true}
        );
        assert.deepEqual(
            (await session.response('explicit')).error,
            {code: -32602, message: 'Missing menu', data: {requested: 'moon'}}
        );
        assert.equal((await session.response('domain')).error.code, -32603);
        assert.deepEqual(
            session.messages.filter(
                function parserError(message) { return message.id === null; }
            ).map(
                function errorCode(message) { return message.error.code; }
            ),
            [-32700, -32600]
        );
        assert.match(session.diagnostics.join(''), /entire kitchen report\nSecond line/);
        assert.match(session.diagnostics.join(''), /\{invalid json\}/);
        assert.equal(
            session.messages.some(
                function notificationReply(message) { return !Object.hasOwn(message, 'id'); }
            ),
            false
        );
    }
);

test(
    'MCP UTF-8 parser failure retains the complete failing transport chunks',
    async function decoderDiagnostics(t) {
        const observed = [];
        const session = fixture(
            t,
            {onDiagnostic: rememberDiagnostic}
        );
        function rememberDiagnostic(cause) { observed.push(cause); }
        const opening = Buffer.from('{"jsonrpc":"2.0","id":"broken","method":"');
        const unfinished = Buffer.from(
            [0xf0, 0x9f]
        );
        session.input.write(opening);
        session.input.end(unfinished);
        await assert.rejects(session.server.closed, AggregateError);
        assert.equal(observed[0].pendingText, opening.toString('utf8'));
        assert.deepEqual(
            observed[0].inputChunks,
            [opening, unfinished]
        );
    }
);

test(
    'MCP output failure rejects the lifecycle and preserves the underlying error',
    async function outputFailure(t) {
        const input = new PassThrough();
        const error = new PassThrough();
        const cause = new Error('The selected output pipe failed.');
        const output = new Writable(
            {
                write(chunk, encoding, callback) { callback(cause); }
            }
        );
        const server = createMcpStdioServer(
            {serverInfo: {name: 'fixture', version: '1'}}
        );
        t.after(
            function cleanup() {
                input.destroy();
                output.destroy();
                error.destroy();
            }
        );
        server.start(
            {input, output, error}
        );
        input.write('{"jsonrpc":"2.0","id":"ping","method":"ping"}\n');
        await assert.rejects(
            server.closed,
            function retainedFailure(failure) {
                assert.equal(failure instanceof AggregateError, true);
                assert.equal(failure.errors.includes(cause), true);
                return true;
            }
        );
    }
);

test(
    'MCP EOF drains accepted handlers and callback-observed output without ending caller streams',
    async function eofDrain(t) {
        const entered = deferred();
        const release = deferred();
        const writing = deferred();
        let finishWrite;
        let holdResponse = true;
        let signal;
        let closed = false;
        const input = new PassThrough();
        const error = new PassThrough();
        const output = new Writable(
            {
                write(chunk, encoding, callback) {
                    const message = JSON.parse(chunk.toString('utf8'));
                    if (holdResponse && message.id === 'held') {
                        finishWrite = callback;
                        writing.resolve(message);
                    } else {
                        callback();
                    }
                }
            }
        );
        const server = createMcpStdioServer(
            {serverInfo: {name: 'fixture', version: '1'}, tools: [{name: 'hold', inputSchema: {type: 'object'}, handler: hold}]}
        );
        async function hold(args, context) {
            signal = context.signal;
            entered.resolve();
            await release.promise;
            return {content: [{type: 'text', text: 'Complete result'}]};
        }
        t.after(
            async function cleanup() {
                holdResponse = false;
                release.resolve();
                if (finishWrite) finishWrite();
                await server.close();
                input.destroy();
                output.destroy();
                error.destroy();
            }
        );
        server.start(
            {input, output, error}
        );
        server.closed.then(
            function recordClosed() { closed = true; }
        );
        const initialization = {
            jsonrpc: '2.0',
            id: 'init',
            method: 'initialize',
            params: {protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: {name: 'fixture', version: '1'}}
        };
        input.write(`${JSON.stringify(initialization)}\n`);
        await server.drain();
        input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
        input.write('{"jsonrpc":"2.0","id":"held","method":"tools/call","params":{"name":"hold"}}\n');
        await entered.promise;
        input.end();
        release.resolve();
        const response = await writing.promise;
        assert.equal(signal.aborted, false);
        assert.equal(closed, false);
        assert.equal(response.result.content[0].text, 'Complete result');
        finishWrite();
        finishWrite = null;
        await server.closed;
        assert.equal(output.writableEnded, false);
    }
);

for (const sink of ['output', 'diagnostic']) {
    for (const ending of ['close', 'error']) {
        test(
            `MCP ${sink} ${ending} settles a pending write without its callback`,
            async function terminalWriteSettlement(t) {
                const writing = deferred();
                const input = new PassThrough();
                const other = new PassThrough();
                const cause = new Error(`Original ${sink} failure`);
                let completeWrite;
                const held = new Writable(
                    {
                        write(chunk, encoding, callback) {
                            completeWrite = callback;
                            writing.resolve();
                        }
                    }
                );
                const output = sink === 'output' ? held : other;
                const error = sink === 'diagnostic' ? held : other;
                const server = createMcpStdioServer(
                    {serverInfo: {name: 'fixture', version: '1'}}
                );
                t.after(
                    async function cleanup() {
                        held.destroy();
                        if (completeWrite) {
                            const callback = completeWrite;
                            completeWrite = null;
                            callback();
                        }
                        await server.close().catch(
                            function assertedTerminalFailure() {}
                        );
                        input.destroy();
                        other.destroy();
                    }
                );
                server.start(
                    {input, output, error}
                );
                input.write(
                    sink === 'output'
                        ? '{"jsonrpc":"2.0","id":"pending","method":"ping"}\n'
                        : '{complete malformed input}\n'
                );
                await writing.promise;
                const rejected = assert.rejects(
                    server.close(),
                    function originalFailurePreserved(failure) {
                        assert.equal(failure instanceof AggregateError, true);
                        if (ending === 'error') assert.equal(failure.errors.includes(cause), true);
                        return true;
                    }
                );
                held.destroy(ending === 'error' ? cause : undefined);
                await rejected;
                await server.drain();
                assert.equal(held.listenerCount('error'), 0);
                assert.equal(held.listenerCount('close'), 0);
                assert.equal(held.listenerCount('finish'), 0);
                assert.equal(other.destroyed, false);
                assert.equal(other.writableEnded, false);
                const callback = completeWrite;
                completeWrite = null;
                callback();
                await server.drain();
            }
        );
    }
}
