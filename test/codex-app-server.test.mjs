import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {createCodexAppServerSession, openCodexAppServerSession} from '../src/codex/app-server.mjs';

// This synthetic JSONL peer exercises the SDK's actual process owner. It neither
// imports nor executes Codex, and lives entirely in the test owner.
const peerProgram = String.raw`
    const readline = require('node:readline');
    const mode = process.argv[1];
    let initialized = false;
    let active;
    let turnStarts = 0;
    let resumes = 0;
    const agentItem = {id: 'answer', type: 'agentMessage', text: '  The moon cheese is ready. 🧀\n', phase: 'final_answer', extension: {preserved: true}};
    const commandItem = {id: 'command', type: 'commandExecution', command: 'cheese inventory', aggregatedOutput: 'all wheels\n', extra: 'whole'};
    const terminal = {id: 'turn-1', status: 'completed', items: [commandItem, agentItem], error: null, providerField: 'retained'};
    function send(message) {
        process.stdout.write(JSON.stringify(message) + '\n');
    }
    function notification(method, params) {
        send({method, params});
    }
    function complete(status = 'completed') {
        notification('item/completed', {threadId: active.threadId, turnId: 'turn-1', item: commandItem});
        notification('item/completed', {threadId: active.threadId, turnId: 'turn-1', item: agentItem});
        notification('turn/completed', {threadId: active.threadId, turn: {...terminal, status}});
    }
    const lines = readline.createInterface({input: process.stdin});
    lines.on('line', function receive(line) {
        const message = JSON.parse(line);
        if (message.jsonrpc !== undefined) {
            throw new Error('Codex frames omit jsonrpc.');
        }
        if (message.method === 'initialize') {
            if (mode === 'initializing') {
                process.stderr.write('initialize pending\n');
                return;
            }
            const response = JSON.stringify({id: message.id, result: {userAgent: 'fixture', platformFamily: 'fixture'}}) + '\n';
            // Protocol chunks need not align with JSONL records.
            process.stdout.write(response.substring(0, 7));
            process.stdout.write(response.substring(7));
            return;
        }
        if (message.method === 'initialized') {
            initialized = true;
            return;
        }
        if (!initialized) {
            throw new Error('A request arrived before initialized.');
        }
        if (message.method === 'thread/start') {
            send({id: message.id, result: {thread: {id: 'thread-1'}, echo: message.params}});
        } else if (message.method === 'thread/resume') {
            resumes += 1;
            send({id: message.id, result: {thread: {id: message.params.threadId}}});
        } else if (message.method === 'thread/list') {
            send({id: message.id, result: {data: [{id: 'thread-1'}], nextCursor: null, turnStarts, resumes}});
        } else if (message.method === 'thread/read') {
            send({id: message.id, result: {thread: {id: message.params.threadId, turns: [terminal]}, echo: message.params}});
        } else if (message.method === 'turn/start') {
            turnStarts += 1;
            active = message.params;
            if (mode === 'exit') {
                process.exit(0);
            }
            if (mode === 'malformed') {
                process.stdout.write('complete unreadable stdout 🧀\n');
                return;
            }
            if (mode === 'null-result') {
                send({id: message.id, result: null});
                return;
            }
            notification('fixture/input', {threadId: active.threadId, input: active.input, options: active});
            notification('turn/started', {threadId: active.threadId, turn: {id: 'turn-1', status: 'inProgress', items: []}});
            notification('item/started', {threadId: active.threadId, turnId: 'turn-1', item: {...agentItem, text: ''}});
            notification('item/agentMessage/delta', {threadId: active.threadId, turnId: 'turn-1', itemId: 'answer', delta: agentItem.text});
            // Events may precede the request response without being lost.
            send({id: message.id, result: {turn: {id: 'turn-1', status: 'inProgress', items: []}}});
            if (mode === 'approval') {
                send({id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {threadId: active.threadId, turnId: 'turn-1', itemId: 'command', command: 'cheese inventory'}});
            } else if (mode !== 'interrupt') {
                complete();
            }
        } else if (message.method === 'turn/interrupt') {
            if (message.params.turnId !== 'turn-1' || message.params.threadId !== active.threadId) {
                throw new Error('Wrong turn interrupted.');
            }
            send({id: message.id, result: {}});
            complete('interrupted');
        } else if (message.id === 'approval-1') {
            notification('fixture/approval', {response: message});
            notification('serverRequest/resolved', {threadId: active.threadId, requestId: message.id});
            complete();
        } else {
            send({id: message.id, error: {code: -32601, message: 'Synthetic missing method', data: {method: message.method}}});
        }
    });
`;

function options(mode = 'normal') {
    return {executable: process.execPath, args: ['-e', peerProgram, mode]};
}

test(
    'Codex JSONL preserves ordered live output, native items and exact text separately',
    async function completeTurn() {
        const session = createCodexAppServerSession(options());
        const states = [];
        const live = [];
        const notifications = [];
        session.subscribe('status', function status(value) { states.push(value.state); });
        session.subscribe('notification', function notification(value) { notifications.push(value); });
        try {
            assert.equal(states[0], 'disconnected');
            await session.connect();
            assert.deepEqual(states, ['disconnected', 'connecting', 'ready']);
            const created = await session.createThread({model: 'fixture-model'});
            assert.equal(created.echo.model, 'fixture-model');
            const result = await session.runTurn(
                {
                    threadId: created.thread.id,
                    input: '  Count the moon cheese.\n',
                    onDelta: function delta(value) { live.push(['delta', value]); },
                    onItem: function item(value) { live.push(['item', value]); },
                    onTurn: function turn(value) { live.push(['turn', value]); }
                }
            );
            assert.equal(result.status, 'completed');
            assert.equal(result.turn.providerField, 'retained');
            assert.equal(result.items.find(function answer(item) { return item.id === 'answer'; }).extension.preserved, true);
            assert.equal(result.items.find(function command(item) { return item.id === 'command'; }).aggregatedOutput, 'all wheels\n');
            assert.deepEqual(result.visibleItems, [{itemId: 'answer', text: '  The moon cheese is ready. 🧀\n', phase: 'final_answer'}]);
            assert.deepEqual(live.map(function kind(entry) { return entry[0]; }), ['turn', 'item', 'delta', 'item', 'item', 'turn']);
            assert.equal(live[2][1].delta, result.visibleItems[0].text);
            const submitted = notifications.find(function input(value) { return value.method === 'fixture/input'; });
            assert.deepEqual(submitted.params.input, [{type: 'text', text: '  Count the moon cheese.\n'}]);
        } finally {
            await session.dispose();
        }
        assert.equal(session.status.state, 'disposed');
    }
);

test(
    'Codex approval replies correlate while an asynchronous owner reads another response',
    async function approvalTurn() {
        const session = await openCodexAppServerSession(options('approval'));
        const observed = [];
        session.subscribe(
            'serverRequest',
            async function approval(message) {
                // This RPC must complete while the human-response owner is pending.
                await session.listThreads();
                observed.push(session.respond({id: message.id, result: {decision: 'accept'}}));
            }
        );
        session.subscribe('notification', function notification(message) { observed.push(message); });
        try {
            await session.resumeThread({threadId: 'thread-1'});
            const input = [{type: 'text', text: 'Full input\n', text_elements: [], providerField: 'unchanged'}];
            const result = await session.runTurn({threadId: 'thread-1', input});
            assert.equal(result.status, 'completed');
            assert.deepEqual(observed.find(function submitted(record) { return record.submitted; }), {id: 'approval-1', submitted: true});
            assert.deepEqual(observed.find(function inputRecord(record) { return record.method === 'fixture/input'; }).params.input, input);
            assert.deepEqual(observed.find(function reply(record) { return record.method === 'fixture/approval'; }).params.response, {id: 'approval-1', result: {decision: 'accept'}});
            assert.deepEqual(session.pendingServerRequests, []);
        } finally {
            await session.dispose();
        }
    }
);

test(
    'Codex cancellation waits for the exact interrupted terminal notification',
    async function interruptTurn() {
        const session = await openCodexAppServerSession(options('interrupt'));
        const controller = new AbortController();
        session.subscribe(
            'notification',
            function beforeAcceptance(message) {
                if (message.method === 'fixture/input') {
                    controller.abort();
                }
            }
        );
        try {
            const result = await session.runTurn({threadId: 'thread-1', input: 'Stop this cheese expedition.', signal: controller.signal});
            assert.equal(result.turnId, 'turn-1');
            assert.equal(result.status, 'interrupted');
            await assert.rejects(
                session.runTurn({threadId: 'thread-1', input: 'Never submitted', signal: controller.signal}),
                function cancelled(error) {
                    assert.equal(error.details.outcome, 'not-submitted');
                    return true;
                }
            );
        } finally {
            await session.dispose();
        }
    }
);

test(
    'Codex malformed acceptance rejects its terminal promise and preserves the response',
    async function malformedAcceptance() {
        const session = await openCodexAppServerSession(options('null-result'));
        try {
            await assert.rejects(
                session.runTurn({threadId: 'thread-1', input: 'One expedition'}),
                function unknown(error) {
                    assert.equal(error.code, 'ARCANE_CODEX_TURN_UNKNOWN');
                    assert.equal(error.details.outcome, 'unknown');
                    assert.equal(error.cause.details.response, null);
                    return true;
                }
            );
        } finally {
            await session.dispose();
        }
    }
);

test(
    'Codex connection loss is unknown and reconnect reads stored output without resubmission',
    async function reconcileTurn() {
        const session = await openCodexAppServerSession(options('exit'));
        try {
            await assert.rejects(
                session.runTurn({threadId: 'thread-1', input: 'A single expedition'}),
                function unknown(error) {
                    assert.equal(error.code, 'ARCANE_CODEX_TURN_UNKNOWN');
                    assert.equal(error.details.outcome, 'unknown');
                    assert.equal(error.details.threadId, 'thread-1');
                    assert.equal(error.details.turnId, null);
                    return true;
                }
            );
            await session.reconnect();
            const result = await session.readTurn({threadId: 'thread-1', turnId: 'turn-1'});
            assert.equal(result.status, 'completed');
            assert.equal(result.visibleItems[0].text, '  The moon cheese is ready. 🧀\n');
            const inventory = await session.listThreads();
            assert.equal(inventory.turnStarts, 0);
            assert.equal(inventory.resumes, 0);
            await assert.rejects(session.readTurn({threadId: 'thread-1', turnId: 'absent'}), {code: 'ARCANE_CODEX_TURN_NOT_FOUND'});
            await assert.rejects(session.request('missing', {whole: 'request'}), function rpc(error) {
                assert.equal(error.details.error.data.method, 'missing');
                assert.equal(error.details.outcome, 'rejected');
                return true;
            });
        } finally {
            await session.dispose();
        }
    }
);

test(
    'Codex dispose owns pending initialization and malformed JSON remains complete diagnostics',
    async function initializationAndProtocol() {
        const initializing = createCodexAppServerSession(options('initializing'));
        const reachedInitialize = new Promise(function wait(resolve) {
            initializing.subscribe('stderr', function stderr(record) {
                if (record.chunk.includes('initialize pending')) {
                    resolve();
                }
            });
        });
        const connecting = initializing.connect();
        const rejected = assert.rejects(connecting, {code: 'ARCANE_CODEX_CONNECTION_LOST'});
        await reachedInitialize;
        await initializing.dispose();
        await rejected;
        assert.equal(initializing.status.state, 'disposed');

        const session = await openCodexAppServerSession(options('malformed'));
        const errors = [];
        session.subscribe('error', function error(value) { errors.push(value.error); });
        try {
            await assert.rejects(session.runTurn({threadId: 'thread-1', input: 'Full diagnostic'}), {code: 'ARCANE_CODEX_TURN_UNKNOWN'});
            const protocol = errors.find(function malformed(error) { return error.code === 'ARCANE_CODEX_PROTOCOL'; });
            assert.equal(protocol.details.line, 'complete unreadable stdout 🧀');
        } finally {
            await session.dispose();
        }
    }
);
