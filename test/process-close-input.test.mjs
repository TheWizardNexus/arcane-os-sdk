import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {PassThrough, Writable} from 'node:stream';
import test from '../src/testing.mjs';
import {runProcess} from '../src/process.mjs';

const drainingChild = `
const interval = setInterval(function keepOwnedProcessAlive() {}, 1000);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function acceptInput(chunk) { input += chunk; });
process.stdin.on('end', function finishAcceptedWork() {
    setTimeout(function durableCompletion() {
        process.stdout.write('drained:' + input + '\\n');
        process.stderr.write('complete diagnostic 🧀\\n');
        clearInterval(interval);
    }, 25);
});
process.stdout.write('ready\\n');
`;

test('close-input cancellation waits for the child drain and retains complete output', async function closeInputDrain() {
    const controller = new AbortController();
    const events = [];
    const input = '  Complete payload 🧀\r\n最後の行  ';
    await assert.rejects(runProcess(process.execPath, ['-e', drainingChild], {
        cancellationMode: 'close-input', input, signal: controller.signal,
        onEvent(event) {
            events.push(event);
            if (event.type === 'process.stdout' && event.message === 'ready') controller.abort('Selected host closed.');
        }
    }), function completeCancellation(error) {
        assert.equal(error.code, 'ARCANE_CANCELLED');
        assert.equal(error.details.code, 0);
        assert.equal(error.details.stdout, 'ready\ndrained:' + input + '\n');
        assert.equal(error.details.stderr, 'complete diagnostic 🧀\n');
        return true;
    });
    assert.equal(events.some(function escalated(event) { return event.type === 'process.cancellation.escalated'; }), false);
    assert.equal(events.at(-1).type, 'process.cancelled');
});

test('close-input mode does not close the child input before cancellation', async function retainedInput() {
    const controller = new AbortController();
    let ready = false;
    await assert.rejects(runProcess(process.execPath, ['-e', drainingChild], {
        cancellationMode: 'close-input', signal: controller.signal,
        onEvent(event) {
            if (event.type === 'process.stdout' && event.message === 'ready') {
                ready = true;
                controller.abort();
            }
        }
    }), function ownedShutdown(error) {
        assert.equal(ready, true);
        assert.equal(error.details.stdout, 'ready\ndrained:\n');
        assert.equal(error.details.code, 0);
        return true;
    });
});

test('ordinary process input still closes without a cancellation selection', async function ordinaryInput() {
    const result = await runProcess(process.execPath, ['-e', drainingChild], {input: 'ordinary'});
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'ready\ndrained:ordinary\n');
});

test('close-input callback failure retains complete drained output and its original cause', async function failedObserverDrain() {
    const originalCause = new Error('Original observer cause.');
    const callbackFailure = new Error('Complete observer failure 🧀', {cause: originalCause});
    await assert.rejects(runProcess(process.execPath, ['-e', drainingChild], {
        cancellationMode: 'close-input', input: 'accepted work',
        onEvent(event) {
            if (event.type === 'process.stdout' && event.message === 'ready') throw callbackFailure;
        }
    }), function completeFailure(error) {
        assert.equal(error.cause, callbackFailure);
        assert.equal(callbackFailure.cause, originalCause);
        assert.deepEqual(error.errors, [callbackFailure]);
        assert.equal(error.details.code, 0);
        assert.equal(error.details.stdout, 'ready\ndrained:accepted work\n');
        assert.equal(error.details.stderr, 'complete diagnostic 🧀\n');
        return true;
    });
});

async function withProcessFixture(options, drive, stdin = new PassThrough()) {
    const originalSpawn = childProcess.spawn;
    const child = new EventEmitter();
    child.stdin = stdin;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    child.once('close', function recordClose() { closed = true; });
    let signalSpawned;
    const spawned = new Promise(function observeSpawn(resolve) { signalSpawned = resolve; });
    childProcess.spawn = function spawnOwnedFixture() {
        signalSpawned();
        return child;
    };
    syncBuiltinESMExports();
    try {
        const outcome = runProcess('owned-host-fixture', [], options).then(
            function resolved(result) { return {result}; },
            function rejected(error) { return {error}; }
        );
        const earlyOutcome = await Promise.race([spawned, outcome]);
        if (earlyOutcome?.error) throw earlyOutcome.error;
        await drive(child);
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

test('close-input retains cancellation, stdin failure, callback failure and complete output together', async function allShutdownFailures() {
    const controller = new AbortController();
    const reason = new Error('Caller selected close.');
    const inputFailure = new Error('Complete stdin failure 最後');
    const callbackCause = new Error('Original callback cause.');
    const callbackFailure = new Error('Observer failed after close was requested.', {cause: callbackCause});
    let signalEntered;
    let releaseCallback;
    const entered = new Promise(function observeCallback(resolve) { signalEntered = resolve; });
    const released = new Promise(function holdCallback(resolve) { releaseCallback = resolve; });
    let inputEnds = 0;
    const input = new Writable({
        write(chunk, encoding, callback) { callback(); },
        final(callback) { inputEnds++; callback(inputFailure); }
    });
    const {error} = await withProcessFixture({
        cancellationMode: 'close-input', signal: controller.signal,
        async onEvent(event) {
            if (event.type === 'process.stdout') {
                signalEntered();
                await released;
                throw callbackFailure;
            }
        }
    }, async function closeAfterAcceptedOutput(child) {
        child.stdout.write('complete output 🧀\n');
        await entered;
        const inputFailed = new Promise(function observeInputFailure(resolve) { input.once('error', resolve); });
        controller.abort(reason);
        await inputFailed;
        child.stderr.end('complete shutdown diagnostic 最後\n');
        child.stdout.end();
        child.emit('close', 7, null);
        releaseCallback();
    }, input);
    assert.equal(inputEnds, 1);
    assert.equal(error.cause, callbackFailure);
    assert.equal(callbackFailure.cause, callbackCause);
    assert.equal(error.errors.includes(callbackFailure), true);
    assert.equal(error.errors.includes(inputFailure), true);
    const cancellation = error.errors.find(function cancelled(failure) { return failure.code === 'ARCANE_CANCELLED'; });
    assert.equal(cancellation.cause, reason);
    assert.equal(cancellation.details, error.details);
    assert.equal(error.details.code, 7);
    assert.equal(error.details.stdout, 'complete output 🧀\n');
    assert.equal(error.details.stderr, 'complete shutdown diagnostic 最後\n');
});

test('a closed native process drains pending events without accepting later cancellation', async function closeBeforeCallbackDrain() {
    const controller = new AbortController();
    const events = [];
    let signalEntered;
    let releaseCallback;
    const entered = new Promise(function observeCallback(resolve) { signalEntered = resolve; });
    const released = new Promise(function holdCallback(resolve) { releaseCallback = resolve; });
    let inputEnds = 0;
    const input = new Writable({
        write(chunk, encoding, callback) { callback(); },
        final(callback) { inputEnds++; callback(); }
    });
    const {result, error} = await withProcessFixture({
        cancellationMode: 'close-input', signal: controller.signal,
        async onEvent(event) {
            events.push(event.type);
            if (event.type === 'process.stdout') {
                signalEntered();
                await released;
            }
        }
    }, async function closeBeforeAbort(child) {
        child.stdout.write('window already closed 🧀\n');
        await entered;
        child.stdout.end();
        child.stderr.end('complete final diagnostic\n');
        child.emit('close', 0, null);
        controller.abort('Late cancellation while callbacks drain.');
        releaseCallback();
    }, input);
    assert.equal(error, undefined);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'window already closed 🧀\n');
    assert.equal(result.stderr, 'complete final diagnostic\n');
    assert.equal(inputEnds, 0);
    assert.equal(events.some(function cancelled(type) { return type.startsWith('process.cancel'); }), false);
    assert.equal(events.at(-1), 'process.completed');
});
