import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough} from 'node:stream';
import {finished} from 'node:stream/promises';
import test from '../src/testing.mjs';
import {runProcess} from '../src/process.mjs';

function nextTurn() {
    return new Promise(function yieldTurn(resolve) { setImmediate(resolve); });
}

async function withOutputFixture(options, writeOutput) {
    const originalSpawn = childProcess.spawn;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    child.once('close', function recordClose() { closed = true; });
    let signalSpawned;
    const spawned = new Promise(function observeSpawn(resolve) { signalSpawned = resolve; });
    childProcess.spawn = function spawnOutputFixture() {
        signalSpawned();
        return child;
    };
    syncBuiltinESMExports();
    try {
        const outcome = runProcess('raw-output-fixture', [], options).then(
            function resolved(result) { return {result}; },
            function rejected(error) { return {error}; }
        );
        const earlyOutcome = await Promise.race([spawned, outcome]);
        if (earlyOutcome?.error) throw earlyOutcome.error;
        await writeOutput(child);
        const drained = Promise.all([
            finished(child.stdout, {cleanup: true}),
            finished(child.stderr, {cleanup: true})
        ]);
        child.stdout.end();
        child.stderr.end();
        await drained;
        child.emit('close', 0, null);
        return await outcome;
    } finally {
        childProcess.spawn = originalSpawn;
        syncBuiltinESMExports();
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        if (!closed) child.emit('close', 1, null);
    }
}

test('raw stdout preserves binary framing and leaves stderr on its ordinary text route', async function rawStdout() {
    const fragments = [Buffer.from([0, 255, 195]), Buffer.from([40, 10, 13, 0]), Buffer.from('最後🧀')];
    const received = [];
    const events = [];
    const diagnostic = '  Complete diagnostic 🧀\r\n最後\n';
    const {result, error} = await withOutputFixture({
        outputEncoding: {stdout: null},
        captureOutput: {stdout: false},
        emitOutputEvents: {stdout: false},
        async onOutput(record) {
            received.push(record);
            await nextTurn();
        },
        onEvent(event) { events.push(event); }
    }, async function writeBinaryOutput(child) {
        for (const fragment of fragments) {
            child.stdout.write(fragment);
            await nextTurn();
        }
        child.stderr.write(diagnostic);
    });
    assert.equal(error, undefined);
    const stdout = received.filter(function selected(record) { return record.stream === 'stdout'; });
    assert.equal(stdout.every(function nativeBuffer(record) { return Buffer.isBuffer(record.chunk); }), true);
    assert.deepEqual(Buffer.concat(stdout.map(function chunk(record) { return record.chunk; })), Buffer.concat(fragments));
    assert.equal(result.stdout, null);
    assert.equal(result.stderr, diagnostic);
    assert.equal(received.filter(function selected(record) { return record.stream === 'stderr'; })
        .every(function text(record) { return typeof record.chunk === 'string'; }), true);
    assert.equal(events.some(function stdoutEvent(event) { return event.type === 'process.stdout'; }), false);
    assert.equal(events.some(function stderrEvent(event) { return event.type === 'process.stderr'; }), true);
    assert.equal(events.at(-1).type, 'process.completed');
});

test('default UTF-8 decoding preserves split characters, capture and ordinary output events', async function defaultTextOutput() {
    const content = '  🧀最後\r\ncomplete text\n';
    const received = [];
    const events = [];
    const {result, error} = await withOutputFixture({
        onOutput(record) { received.push(record); },
        onEvent(event) { events.push(event); }
    }, async function splitEncodedText(child) {
        for (const fragment of Buffer.from(content)) {
            child.stdout.write(Buffer.from([fragment]));
            await nextTurn();
        }
        child.stderr.write('ordinary stderr\n');
    });
    assert.equal(error, undefined);
    assert.equal(result.stdout, content);
    assert.equal(result.stderr, 'ordinary stderr\n');
    assert.equal(received.every(function decoded(record) { return typeof record.chunk === 'string'; }), true);
    assert.equal(received.filter(function stdout(record) { return record.stream === 'stdout'; })
        .map(function chunk(record) { return record.chunk; }).join(''), content);
    assert.equal(events.some(function stdout(event) { return event.type === 'process.stdout'; }), true);
    assert.equal(events.some(function stderr(event) { return event.type === 'process.stderr'; }), true);
});

test('global null encoding delivers both native Buffer streams without text capture or output events', async function bothRawStreams() {
    const output = Buffer.from([255, 0, 10]);
    const diagnostic = Buffer.from([254, 13, 0]);
    const received = [];
    const events = [];
    const {result, error} = await withOutputFixture({
        outputEncoding: null,
        captureOutput: false,
        emitOutputEvents: false,
        onOutput(record) { received.push(record); },
        onEvent(event) { events.push(event); }
    }, async function writeRawStreams(child) {
        child.stdout.write(output);
        child.stderr.write(diagnostic);
    });
    assert.equal(error, undefined);
    assert.equal(result.stdout, null);
    assert.equal(result.stderr, null);
    assert.equal(received.every(function nativeBuffer(record) { return Buffer.isBuffer(record.chunk); }), true);
    assert.deepEqual(received.find(function stdout(record) { return record.stream === 'stdout'; }).chunk, output);
    assert.deepEqual(received.find(function stderr(record) { return record.stream === 'stderr'; }).chunk, diagnostic);
    assert.equal(events.some(function outputEvent(event) {
        return event.type === 'process.stdout' || event.type === 'process.stderr';
    }), false);
});

test('failed raw delivery retains the complete native Buffer and original callback cause', async function rawFailure() {
    const payload = Buffer.from([0, 255, 195, 40, 10, 13, 0]);
    const originalCause = new Error('Original caller failure.');
    const callbackFailure = new Error('Raw protocol consumer failed.', {cause: originalCause});
    let received;
    const {error} = await withOutputFixture({
        outputEncoding: {stdout: null},
        captureOutput: {stdout: false},
        emitOutputEvents: {stdout: false},
        cancellationMode: 'close-input',
        async onOutput(record) {
            if (record.stream !== 'stdout') return;
            received = record.chunk;
            await nextTurn();
            throw callbackFailure;
        }
    }, async function writeFailingChunk(child) {
        child.stdout.write(payload);
        child.stderr.write('complete failure diagnostic\n');
    });
    assert.equal(error.details.stdout, null);
    assert.equal(error.details.stderr, 'complete failure diagnostic\n');
    const failedOutput = error.errors.find(function originalFailure(failure) { return failure.cause === callbackFailure; });
    assert.equal(failedOutput.details.stream, 'stdout');
    assert.equal(failedOutput.details.chunk, received);
    assert.equal(Buffer.isBuffer(failedOutput.details.chunk), true);
    assert.deepEqual(failedOutput.details.chunk, payload);
    assert.equal(callbackFailure.cause, originalCause);
});

test('raw output requires its coherent explicit callback-only transport selection', async function explicitRawSelection() {
    function consume() { }
    for (const options of [
        {outputEncoding: {stdout: null}, onOutput: consume},
        {outputEncoding: {stdout: null}, captureOutput: {stdout: false}, onOutput: consume},
        {outputEncoding: {stdout: null}, emitOutputEvents: {stdout: false}, onOutput: consume},
        {outputEncoding: {stdout: null}, captureOutput: {stdout: false}, emitOutputEvents: {stdout: false}},
        {outputEncoding: 'latin1'},
        {outputEncoding: false}
    ]) {
        await assert.rejects(runProcess(process.execPath, ['-e', ''], options), TypeError);
    }
});
