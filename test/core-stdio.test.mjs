import assert from 'node:assert/strict';
import {PassThrough, Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {createCoreRuntime} from '../src/core/runtime.mjs';
import {createCoreFrameDecoder, encodeCoreFrame, startCoreStdio} from '../src/core/stdio.mjs';
import {CORE_PROTOCOL} from '../browser-runtime/core/contracts.mjs';

function deferred() {
    let resolve;
    const promise = new Promise(function retainSettlement(resolvePromise) { resolve = resolvePromise; });
    return {promise, resolve};
}

function request(id, method, parameters = {}) {
    return {protocol: CORE_PROTOCOL, type: 'request', id, method, parameters};
}

test('native framing preserves fragmented Unicode and consecutive complete frames', function fragmentedFrames() {
    const frames = [];
    const first = request('first', 'journal.save', {
        text: '  café 🦑 日本語 e\u0301\r\nSecond line\n\nLast line  ',
        nested: {literal: '\\n', empty: '', value: null}
    });
    const second = request('second', 'journal.read', {id: 'first'});
    const third = {protocol: CORE_PROTOCOL, type: 'event', event: 'journal.saved', data: first.parameters};
    const encoded = encodeCoreFrame(first);
    const unicodeSplit = encoded.indexOf(Buffer.from('🦑', 'utf8')) + 1;
    const decoder = createCoreFrameDecoder(function collectFrame(frame) { frames.push(frame); });

    decoder.push(encoded.subarray(0, 9));
    assert.deepEqual(frames, []);
    decoder.push(encoded.subarray(9, unicodeSplit));
    assert.deepEqual(frames, []);
    decoder.push(Buffer.concat([
        encoded.subarray(unicodeSplit),
        encodeCoreFrame(second),
        encodeCoreFrame(third)
    ]));
    decoder.finish();
    assert.deepEqual(frames, [first, second, third]);
});

test('native framing reports partial headers and bodies at EOF', function incompleteFrames() {
    const header = createCoreFrameDecoder(function unexpectedHeaderFrame() {
        assert.fail('A partial header cannot produce a frame.');
    });
    header.push(Buffer.from('Content-Len', 'ascii'));
    assert.throws(function finishHeader() { header.finish(); }, {code: 'IPC_FRAME_INCOMPLETE'});

    const frames = [];
    const body = createCoreFrameDecoder(function collectFrame(frame) { frames.push(frame); });
    const complete = request('complete', 'system.ping');
    const partial = encodeCoreFrame(request('partial', 'journal.save', {text: '🦑 unfinished transport'}));
    body.push(Buffer.concat([encodeCoreFrame(complete), partial.subarray(0, partial.indexOf(Buffer.from('🦑')) + 1)]));
    assert.deepEqual(frames, [complete]);
    assert.throws(function finishBody() { body.finish(); }, {code: 'IPC_FRAME_INCOMPLETE'});
});

test('native framing surfaces malformed framing, JSON and UTF-8 at their parser', function malformedFrames() {
    const missing = createCoreFrameDecoder(function unexpectedMissingFrame() { assert.fail('Missing framing cannot deliver a frame.'); });
    assert.throws(function pushMissingHeader() {
        missing.push(Buffer.from('Other-Header: present\r\n\r\n{}', 'ascii'));
    }, {code: 'IPC_LENGTH_MISSING'});

    const json = createCoreFrameDecoder(function unexpectedJsonFrame() { assert.fail('Malformed JSON cannot deliver a frame.'); });
    assert.throws(function pushMalformedJson() {
        json.push(Buffer.from('Content-Length: 1\r\n\r\n{', 'ascii'));
    }, SyntaxError);

    const utf8 = createCoreFrameDecoder(function unexpectedUnicodeFrame() { assert.fail('Malformed UTF-8 cannot deliver a frame.'); });
    assert.throws(function pushMalformedUnicode() {
        utf8.push(Buffer.concat([
            Buffer.from('Content-Length: 3\r\n\r\n', 'ascii'),
            Buffer.from([0x22, 0xff, 0x22])
        ]));
    }, TypeError);
});

test('stdio EOF drains accepted service work and output before closed settles', async function eofDrainsAcceptedWork(t) {
    const accepted = deferred();
    const saved = deferred();
    const draining = deferred();
    const drainStarted = deferred();
    const drained = deferred();
    const disposeStarted = deferred();
    const disposed = deferred();
    const responseWriting = deferred();
    const frames = [];
    const failures = [];
    const order = [];
    let signal;
    let releaseResponse;
    let holdResponse = true;
    let closedSettled = false;
    const runtime = createCoreRuntime({services: [{
        name: 'journal',
        methods: {
            'journal.save': {
                lifetime: 'service',
                async handle(parameters, context) {
                    signal = context.signal;
                    accepted.resolve();
                    await saved.promise;
                    order.push('saved');
                    return {saved: parameters};
                }
            }
        },
        async drain() {
            order.push('drain');
            drainStarted.resolve();
            await drained.promise;
        },
        async dispose() {
            order.push('dispose');
            disposeStarted.resolve();
            await disposed.promise;
            order.push('disposed');
        }
    }]});
    runtime.subscribe(function observeDraining(state) {
        if (state.state === 'draining') draining.resolve();
    });
    const input = new PassThrough();
    const decoder = createCoreFrameDecoder(function collectFrame(frame) { frames.push(frame); });
    const output = new Writable({
        write(chunk, encoding, callback) {
            decoder.push(chunk);
            const frame = frames.at(-1);
            if (holdResponse && frame.type === 'response' && frame.id === 'save') {
                releaseResponse = callback;
                responseWriting.resolve();
            } else {
                callback();
            }
        }
    });
    const transport = startCoreStdio({runtime, input, output, onError: function collectError(error) { failures.push(error); }});
    t.after(async function releaseTransport() {
        holdResponse = false;
        saved.resolve();
        drained.resolve();
        disposed.resolve();
        if (releaseResponse) {
            const release = releaseResponse;
            releaseResponse = null;
            release();
        }
        await transport.close();
        input.destroy();
        output.end();
    });
    function observeCloseSettlement() { closedSettled = true; }
    transport.closed.then(observeCloseSettlement, observeCloseSettlement);
    const parameters = {text: '  Every line\r\nEvery character: 🦑 café 日本語  ', nested: {value: null}};
    input.write(encodeCoreFrame(request('save', 'journal.save', parameters)));
    await accepted.promise;
    input.end();
    await draining.promise;
    assert.equal(signal.aborted, false);
    assert.equal(closedSettled, false);
    assert.equal(transport.close(), transport.closed);

    saved.resolve();
    await Promise.all([drainStarted.promise, responseWriting.promise]);
    const response = frames.find(function saveResponse(frame) { return frame.type === 'response' && frame.id === 'save'; });
    assert.deepEqual(response.result, {saved: parameters});
    assert.equal(response.ok, true);
    assert.deepEqual(order, ['saved', 'drain']);
    assert.equal(closedSettled, false);
    drained.resolve();
    await disposeStarted.promise;
    assert.equal(closedSettled, false);
    disposed.resolve();
    assert.equal((await runtime.close()).state, 'closed');
    assert.equal(closedSettled, false);
    const finishResponse = releaseResponse;
    releaseResponse = null;
    finishResponse();
    const state = await transport.closed;
    decoder.finish();
    assert.equal(state.state, 'closed');
    assert.deepEqual(order, ['saved', 'drain', 'dispose', 'disposed']);
    assert.deepEqual(failures, []);
    assert.equal(transport.close(), transport.closed);
    assert.equal(frames.at(-1).event, 'core.state');
    assert.equal(frames.at(-1).data.state, 'closed');
});

test('stdio input close without EOF drains the runtime', async function inputClosesWithoutEnd(t) {
    const failures = [];
    let disposals = 0;
    const input = new PassThrough();
    const output = new Writable({write(chunk, encoding, callback) { callback(); }});
    const runtime = createCoreRuntime({services: [{name: 'journal', dispose() { disposals += 1; }}]});
    const transport = startCoreStdio({runtime, input, output, onError: function collectError(error) { failures.push(error); }});
    t.after(function releaseStreams() { input.destroy(); output.end(); });

    input.destroy();
    assert.equal((await transport.closed).state, 'closed');
    assert.equal(disposals, 1);
    assert.deepEqual(failures, []);
    assert.equal(transport.close(), transport.closed);
});

test('stdio attachment drains inputs that already ended or were destroyed', async function alreadyClosedInput(t) {
    for (const state of ['ended', 'destroyed']) {
        const input = new PassThrough();
        const output = new Writable({write(chunk, encoding, callback) { callback(); }});
        const failures = [];
        t.after(function releaseStreams() { input.destroy(); output.end(); });
        if (state === 'ended') {
            const ended = new Promise(function observeEnd(resolve) { input.once('end', resolve); });
            input.end();
            input.resume();
            await ended;
            assert.equal(input.readableEnded, true);
        } else {
            input.destroy();
            assert.equal(input.destroyed, true);
        }
        const runtime = createCoreRuntime();
        const transport = startCoreStdio({runtime, input, output, onError: function collectError(error) { failures.push(error); }});
        assert.equal((await transport.closed).state, 'closed', state);
        assert.deepEqual(failures, [], state);
        assert.equal(transport.close(), transport.closed, state);
    }
});

test('stdio observes a destroyed input whose error event is still pending', async function pendingInputError(t) {
    const failure = new Error('The complete input failure before transport attachment.');
    const failures = [];
    const input = new PassThrough();
    const streamClosed = new Promise(function observeInputClose(resolve) { input.once('close', resolve); });
    const output = new Writable({write(chunk, encoding, callback) { callback(); }});
    input.destroy(failure);
    const runtime = createCoreRuntime();
    const transport = startCoreStdio({runtime, input, output, onError: function collectError(error) { failures.push(error); }});
    t.after(function releaseStreams() { output.end(); });

    await assert.rejects(transport.closed, function retainedInputError(error) {
        assert.deepEqual(error.errors, [failure]);
        return true;
    });
    await streamClosed;
    assert.deepEqual(failures, [failure]);
    assert.equal(runtime.current().state, 'closed');
    assert.equal(input.listenerCount('error'), 0);
});

test('stdio partial EOF is observable and still closes the runtime', async function incompleteTransport(t) {
    const failures = [];
    const input = new PassThrough();
    const output = new Writable({write(chunk, encoding, callback) { callback(); }});
    const runtime = createCoreRuntime();
    const transport = startCoreStdio({runtime, input, output, onError: function collectError(error) { failures.push(error); }});
    t.after(function releaseStreams() { input.destroy(); output.end(); });
    input.end(Buffer.from('Content-Length: 20\r\n\r\n{"protocol":', 'ascii'));

    await assert.rejects(transport.closed, function incompleteTransportError(error) {
        assert.equal(error.name, 'AggregateError');
        assert.deepEqual(error.errors, failures);
        assert.equal(error.errors[0].code, 'IPC_FRAME_INCOMPLETE');
        return true;
    });
    assert.equal(failures.length, 1);
    assert.equal(runtime.current().state, 'closed');
    assert.equal(transport.close(), transport.closed);
});

test('stdio output failure is reported, retained and closes exactly once', async function observableOutputFailure(t) {
    const failure = new Error('The complete synthetic output failure.\nFinal diagnostic line.');
    const failures = [];
    let disposals = 0;
    const input = new PassThrough();
    const output = new Writable({
        write(chunk, encoding, callback) { callback(failure); }
    });
    const runtime = createCoreRuntime({services: [{
        name: 'journal',
        dispose() { disposals += 1; }
    }]});
    const transport = startCoreStdio({runtime, input, output, onError: function collectError(error) { failures.push(error); }});
    t.after(function releaseStreams() { input.destroy(); output.destroy(); });

    await assert.rejects(transport.closed, function retainedOutputError(error) {
        assert.equal(error.name, 'AggregateError');
        assert.deepEqual(error.errors, [failure]);
        return true;
    });
    assert.deepEqual(failures, [failure]);
    assert.equal(runtime.current().state, 'closed');
    assert.equal(disposals, 1);
    assert.equal(transport.close(), transport.closed);
});
