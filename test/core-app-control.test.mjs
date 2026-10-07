import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {connectAppControl} from '../src/core/app-control.mjs';
import {runAppControlCli} from '../src/cli/app-control.mjs';
import {createCoreFrameDecoder, encodeCoreFrame} from '../src/core/stdio.mjs';

const fixtureRoot = fileURLToPath(new URL('../.arcane/app-control-fixtures/', import.meta.url));
const protocol = 'arcane/1';

// This peer exercises the public transport boundary. It does not execute a
// native host or establish keyboard, window or document behavior.
async function fixture(t, onReceive) {
    await mkdir(fixtureRoot, {recursive: true});
    const root = await mkdtemp(path.join(fixtureRoot, 'case-'));
    const endpoint = process.platform === 'win32'
        ? `\\\\.\\pipe\\arcane-control-${path.basename(root)}` : path.join(root, 'control.sock');
    const records = [];
    const errors = [];
    const waiters = new Set();
    const sockets = new Set();
    const cleanups = [];

    function failed(error) {
        errors.push(error);
        for (const waiter of waiters) waiter.reject(error);
        waiters.clear();
    }

    const server = createServer(function connected(socket) {
        sockets.add(socket);
        const decoder = createCoreFrameDecoder(function received(frame) {
            const record = {socket, frame};
            records.push(record);
            onReceive?.(record);
            for (const waiter of [...waiters]) {
                if (!waiter.select(frame)) continue;
                waiters.delete(waiter);
                waiter.resolve(record);
            }
        });
        socket.on('data', function receivedContent(content) {
            try { decoder.push(content); } catch (error) { failed(error); }
        });
        socket.on('end', function receivedEnd() {
            try { decoder.finish(); } catch (error) { failed(error); }
        });
        socket.on('error', failed);
        socket.on('close', function releasedSocket() { sockets.delete(socket); });
    });
    server.on('error', failed);
    t.after(async function releaseFixture() {
        const failures = [];
        for (const cleanup of cleanups.reverse()) {
            try { await cleanup(); } catch (error) { failures.push(error); }
        }
        const closing = [];
        for (const socket of sockets) {
            closing.push(once(socket, 'close'));
            socket.destroy();
        }
        const settled = await Promise.allSettled(closing);
        for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
        if (server.listening) {
            try {
                await new Promise(function closeServer(resolve, reject) {
                    server.close(function serverClosed(error) { if (error) reject(error); else resolve(); });
                });
            } catch (error) { failures.push(error); }
        }
        try { await rm(root, {recursive: true, force: true}); }
        catch (error) { failures.push(error); }
        failures.push(...errors);
        if (failures.length) throw new AggregateError(failures, 'App-control fixture cleanup failed.');
    });
    await new Promise(function listen(resolve, reject) {
        server.once('error', reject);
        server.listen(endpoint, function listening() { server.off('error', reject); resolve(); });
    });

    return {
        root, endpoint, records, errors,
        own(cleanup) { cleanups.push(cleanup); },
        next(select) {
            const record = records.find(function matching(value) { return select(value.frame); });
            if (record) return Promise.resolve(record);
            if (errors.length) return Promise.reject(errors[0]);
            return new Promise(function wait(resolve, reject) { waiters.add({select, resolve, reject}); });
        },
        reply(record, response) {
            const frame = {protocol, type: 'response', id: record.frame.id, ...response};
            return new Promise(function sendResponse(resolve, reject) {
                record.socket.write(encodeCoreFrame(frame), function responseWritten(error) {
                    if (error) reject(error);
                    else resolve();
                });
            });
        }
    };
}

function output() {
    const chunks = [];
    return {
        write(content) { chunks.push(content); return true; },
        read() { return chunks.join(''); }
    };
}

function nativeFailure() {
    return {
        code: 'ARCANE_APP_CONTROL_FAILED',
        name: 'System.AggregateException',
        message: 'The moon elevator kept every failure.\r\nRelease also failed.',
        stack: 'First complete stack line\nSecond complete stack line',
        technicalMessage: 'Original diagnostic: 🦑\t  all details remain.  ',
        hresult: -2146233088,
        cause: {name: 'System.IO.IOException', message: 'Original dispatch failure', data: [{key: 'native', value: 'full cause'}]},
        errors: [
            {name: 'System.IO.IOException', message: 'Original dispatch failure'},
            {name: 'System.InvalidOperationException', message: 'Original release failure'}
        ],
        data: [
            {key: 'result', value: {requested: {width: 900, height: 640}, previous: {width: 1280, height: 800}, actual: null}},
            {key: 'documentError', value: {code: 'APP_CONTROL_DOCUMENT_REPLACED', details: {content: '  Exact\n\t🌙\u0000  '}}}
        ]
    };
}

test('app-control sockets correlate concurrent responses and preserve complete native errors', async function correlatedResponses(t) {
    const peer = await fixture(t);
    const observedErrors = [];
    const app = await connectAppControl({endpoint: peer.endpoint,
        onError: function observed(error) { observedErrors.push(error); }});
    peer.own(function closeClient() { return app.close(); });
    const key = {documentGeneration: 12, key: 'Tab', shiftKey: true,
        authored: {content: '  Moon elevator\r\n🦑\t  ', requestId: 'leave-this-value'}};
    const resize = {documentGeneration: 12, width: 900, height: 640};
    const answers = Promise.allSettled([app.key(key), app.resize(resize)]);
    const keyRequest = await peer.next(function keyFrame(frame) { return frame.method === 'app.control.key'; });
    const resizeRequest = await peer.next(function resizeFrame(frame) { return frame.method === 'app.control.resize'; });
    assert.deepEqual(keyRequest.frame.parameters, key);
    assert.deepEqual(resizeRequest.frame.parameters, resize);
    assert.notEqual(keyRequest.frame.id, resizeRequest.frame.id);
    const error = nativeFailure();
    const result = {documentGeneration: 12, url: 'https://app.example/', key: 'Tab', shiftKey: true,
        before: {activeElement: {selector: '#lunar-lift', text: '  Every\nline 🌙  '}}, after: null};
    await peer.reply(resizeRequest, {ok: false, error});
    await peer.reply(keyRequest, {ok: true, result});
    const [keyAnswer, resizeAnswer] = await answers;
    assert.equal(keyAnswer.status, 'fulfilled');
    assert.deepEqual(keyAnswer.value, result);
    assert.equal(resizeAnswer.status, 'rejected');
    for (const [name, value] of Object.entries(error)) assert.deepEqual(resizeAnswer.reason[name], value);
    assert.deepEqual(observedErrors, []);
});

test('app-control preserves complete Escape requests and results through its public client and CLI', async function escapeKey(t) {
    const peer = await fixture(t);
    const app = await connectAppControl({endpoint: peer.endpoint});
    peer.own(function closeClient() { return app.close(); });
    const parameters = {documentGeneration: 12, key: 'Escape', shiftKey: false,
        authored: {content: '  The moon elevator dismissed nothing yet.\r\n🦑\t  '}};
    const pending = app.key(parameters);
    const request = await peer.next(function escapeFrame(frame) { return frame.method === 'app.control.key'; });
    assert.deepEqual(request.frame.parameters, parameters);
    const result = {documentGeneration: 12, key: 'Escape', shiftKey: false,
        press: {parameters: {type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0},
            attempted: true, completed: true, response: '  Complete press result\r\n🦑  '},
        release: {parameters: {type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, modifiers: 0},
            attempted: true, completed: true, response: '  Complete release result\r\n🦑  '},
        actual: {focusPath: [], documentHasFocus: false}};
    await peer.reply(request, {ok: true, result});
    assert.deepEqual(await pending, result);

    await writeFile(path.join(peer.root, 'escape.json'), JSON.stringify(parameters));
    const stdout = output();
    const stderr = output();
    const controller = new AbortController();
    const operation = runAppControlCli(['key', '--endpoint', peer.endpoint, '--request', 'escape.json'],
        {cwd: peer.root, stdout, stderr, controller});
    peer.own(async function closeCli() { controller.abort(); await operation; });
    const cliRequest = await peer.next(function cliEscape(frame) {
        return frame.method === 'app.control.key' && frame !== request.frame;
    });
    assert.deepEqual(cliRequest.frame.parameters, parameters);
    await peer.reply(cliRequest, {ok: true, result});
    assert.equal(await operation, 0);
    assert.deepEqual(JSON.parse(stdout.read()), result);
});

test('app-control cancels one request without replay or losing the live connection', async function requestCancellation(t) {
    const peer = await fixture(t);
    const observedErrors = [];
    const app = await connectAppControl({endpoint: peer.endpoint,
        onError: function observed(error) { observedErrors.push(error); }});
    peer.own(function closeClient() { return app.close(); });
    const controller = new AbortController();
    const cancelled = assert.rejects(app.key({documentGeneration: 7, key: 'Enter'}, {signal: controller.signal}),
        {code: 'ARCANE_REQUEST_ABORTED'});
    const request = await peer.next(function keyFrame(frame) { return frame.method === 'app.control.key'; });
    controller.abort();
    await cancelled;
    const control = await peer.next(function cancelFrame(frame) { return frame.control === 'request.cancel'; });
    assert.deepEqual(control.frame, {protocol, type: 'control', control: 'request.cancel', requestId: request.frame.id});
    await peer.reply(request, {ok: true, result: {late: 'Complete late response remains separate from the next request.'}});
    const status = Promise.allSettled([app.status()]);
    const next = await peer.next(function statusFrame(frame) { return frame.method === 'app.control.status'; });
    assert.equal(next.socket, request.socket);
    const result = {documentGeneration: 8, ready: true, window: {state: 'Normal', width: 1280, height: 800}};
    await peer.reply(next, {ok: true, result});
    const [answer] = await status;
    assert.equal(answer.status, 'fulfilled');
    assert.deepEqual(answer.value, result);
    assert.equal(peer.records.filter(function keyFrame(record) { return record.frame.method === 'app.control.key'; }).length, 1);
    assert.equal(peer.records.some(function replay(record) { return record.frame.control === 'runtime.replay'; }), false);
    assert.deepEqual(observedErrors, []);
});

test('app-control CLI preserves complete request files and structured output through the socket', async function cliRecords(t) {
    let activeStderr;
    const acknowledgements = new Map();
    const peer = await fixture(t, function observeReceipt(record) {
        if (record.frame.type === 'request') acknowledgements.set(record.frame.id, activeStderr.read());
    });
    const key = {documentGeneration: 3, key: 'Space', note: '  Complete moon-elevator request\r\n🦑\t\u0000  '};
    const resize = {documentGeneration: 3, width: 900, height: 640, authored: {empty: '', zero: 0, no: false}};
    await Promise.all([
        writeFile(path.join(peer.root, 'key.json'), JSON.stringify(key)),
        writeFile(path.join(peer.root, 'resize.json'), JSON.stringify(resize))
    ]);

    const stdout = output();
    const stderr = output();
    activeStderr = stderr;
    const successController = new AbortController();
    const success = runAppControlCli(['key', '--endpoint', peer.endpoint, '--request', 'key.json'],
        {cwd: peer.root, stdout, stderr, controller: successController});
    peer.own(async function closeSuccessfulCli() { successController.abort(); await success; });
    const keyRequest = await peer.next(function keyFrame(frame) { return frame.method === 'app.control.key'; });
    assert.deepEqual(JSON.parse(acknowledgements.get(keyRequest.frame.id)),
        {status: 'running', operation: 'key', endpoint: peer.endpoint});
    assert.deepEqual(keyRequest.frame.parameters, key);
    const result = {documentGeneration: 3, before: {text: '  Every\nline 🦑  '}, after: {selection: '\tUnchanged\r\n'}};
    await peer.reply(keyRequest, {ok: true, result});
    assert.equal(await success, 0);
    assert.deepEqual(JSON.parse(stdout.read()), result);

    const failedOut = output();
    const failedErr = output();
    activeStderr = failedErr;
    const failureController = new AbortController();
    const failure = runAppControlCli(['resize', '--endpoint', peer.endpoint, '--request', 'resize.json'],
        {cwd: peer.root, stdout: failedOut, stderr: failedErr, controller: failureController});
    peer.own(async function closeFailedCli() { failureController.abort(); await failure; });
    const resizeRequest = await peer.next(function resizeFrame(frame) { return frame.method === 'app.control.resize'; });
    assert.deepEqual(JSON.parse(acknowledgements.get(resizeRequest.frame.id)),
        {status: 'running', operation: 'resize', endpoint: peer.endpoint});
    assert.deepEqual(resizeRequest.frame.parameters, resize);
    const error = nativeFailure();
    await peer.reply(resizeRequest, {ok: false, error});
    assert.equal(await failure, 1);
    assert.equal(failedOut.read(), '');
    const diagnostics = failedErr.read();
    const acknowledgementEnd = diagnostics.indexOf('\n');
    assert.deepEqual(JSON.parse(diagnostics.substring(0, acknowledgementEnd)),
        {status: 'running', operation: 'resize', endpoint: peer.endpoint});
    const final = JSON.parse(diagnostics.substring(acknowledgementEnd + 1));
    for (const [name, value] of Object.entries(error)) assert.deepEqual(final.error[name], value);
});
