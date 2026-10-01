import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';

const source = (await readFile(
    new URL('../runtime/arcane/components/chat.html', import.meta.url),
    'utf8'
)).replaceAll('\r\n', '\n');

function section(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    assert.notEqual(start, -1, startMarker);
    assert.ok(end > start, endMarker);
    return source.slice(start, end);
}

const initializePrint = Function(
    'fixture',
    `'use strict';
    const {host, chatOutput, arcaneLogging, setSessionStatus, createPrintView} = fixture;
    const aiRuntimeStateAbortController = new AbortController();
    let destroyed = false;
    ${section('        function registerChatPrint(', '\n    );\n    void printViewPromise.catch')}
    const printViewPromise = Promise.resolve(registerChatPrint({createPrintView}));
    ${section('    async function print(){', '\n    function reportTTSError(')}
    return {
        print,
        controller: aiRuntimeStateAbortController,
        destroy: function destroy() {
            destroyed = true;
            aiRuntimeStateAbortController.abort();
        }
    };`
);

function fixture(result = true) {
    const errors = [];
    const statuses = [];
    let requests = 0;
    let options;
    const host = {};
    const chatOutput = {children: [{textContent: 'Complete human conversation.'}]};
    const controller = initializePrint({
        host,
        chatOutput,
        arcaneLogging: {error(...details) { errors.push(details); }},
        setSessionStatus(state, message) { statuses.push({state, message}); },
        createPrintView(configuration) {
            options = configuration;
            return {
                print() {
                    requests += 1;
                    if (result instanceof Error) throw result;
                    return result;
                }
            };
        }
    });
    return {host, chatOutput, errors, statuses, controller, get options() { return options; }, get requests() { return requests; }};
}

test('Chat print delegates only its rendered transcript and lifecycle to the shared owner', async function testChatPrint() {
    const current = fixture();
    assert.equal(current.options.content(), current.chatOutput);
    assert.equal(current.options.title(), 'Conversation');
    current.host.printTitle = 'Octopus meeting';
    assert.equal(current.options.title(), 'Octopus meeting');
    assert.equal(current.options.active(), true);
    assert.equal(await current.controller.print(), true);
    assert.equal(current.requests, 1);
    current.chatOutput.children = [];
    assert.equal(current.options.active(), false);
    current.controller.destroy();
    assert.equal(current.options.signal.aborted, true);
    assert.equal(await current.controller.print(), false);
    assert.equal(current.requests, 1);
    assert.match(source, /host\.print=print;/u);
});

test('print preparation failures retain complete diagnostics and concise visible status', async function testPrintFailure() {
    const failure = new Error('Synthetic media preparation failure.');
    const current = fixture(failure);
    await assert.rejects(current.controller.print(), function exactError(error) { return error === failure; });
    assert.equal(current.errors[0][1], failure);
    assert.deepEqual(current.statuses, [{state: 'error', message: 'Unable to open print preview. Please try again.'}]);
    current.options.onError(failure);
    assert.equal(current.errors[1][1], failure);
    current.controller.destroy();
});
