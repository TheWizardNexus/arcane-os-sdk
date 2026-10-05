import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {runProcess} from '../src/process.mjs';

test('async process input reaches EOF and exact output remains caller-owned when selected', async function interactiveOutput() {
    const output = [];
    const events = [];
    const audio = Buffer.from([0, 1, 2, 255]);
    async function* input() {
        yield '  complete header\r\n';
        yield audio;
    }
    const program = `
        process.stdin.on('data', function forward(chunk) { process.stdout.write(chunk); });
        process.stdin.on('end', function finished() { process.stderr.write('Complete diagnostic 🧀\\n'); });
    `;
    const result = await runProcess(process.execPath, ['-e', program], {
        input: input(),
        cancellationMode: 'close-input',
        captureOutput: {stdout: false},
        emitOutputEvents: {stdout: false},
        onOutput: function consume(record) { output.push(record); },
        onEvent: function event(record) { events.push(record); }
    });
    assert.equal(result.stdout, null);
    assert.equal(result.stderr, 'Complete diagnostic 🧀\n');
    // Output is the existing UTF-8 text contract, not a binary stdout protocol.
    assert.equal(output.filter(function stdout(record) { return record.stream === 'stdout'; })
        .map(function chunk(record) { return record.chunk; }).join(''), '  complete header\r\n' + audio.toString('utf8'));
    assert.equal(events.some(function stdout(event) { return event.type === 'process.stdout'; }), false);
});

test('process cancellation returns cooperative input and drains the child', async function cancelledInput() {
    const controller = new AbortController();
    let pendingNext;
    let returned = false;
    const input = {
        [Symbol.asyncIterator]: function iterate() { return this; },
        next: function next() {
            return new Promise(function wait(resolve) { pendingNext = resolve; });
        },
        return: function stop() {
            returned = true;
            pendingNext?.({done: true});
            return Promise.resolve({done: true});
        }
    };
    const program = `
        process.stdin.resume();
        process.stdin.on('end', function drained() { process.stdout.write('drained\\n'); });
        process.stdout.write('ready\\n');
    `;
    await assert.rejects(runProcess(process.execPath, ['-e', program], {
        input,
        signal: controller.signal,
        cancellationMode: 'close-input',
        onOutput: function observe({stream, chunk}) {
            if (stream === 'stdout' && chunk.includes('ready\n')) controller.abort();
        }
    }), function drained(error) {
        assert.equal(returned, true);
        assert.equal(error.details.code, 0);
        assert.equal(error.details.stdout, 'ready\ndrained\n');
        return true;
    });
});

test('an uncaptured output callback failure retains its complete failed chunk', async function outputFailure() {
    const failure = new Error('Selected output owner failed.');
    await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("whole response\\n");'], {
        captureOutput: {stdout: false},
        emitOutputEvents: {stdout: false},
        onOutput: function consume({stream}) { if (stream === 'stdout') throw failure; }
    }), function retained(error) {
        assert.equal(error.details.stdout, null);
        const outputFailure = error.errors.find(function callbackFailure(value) { return value.cause === failure; });
        assert.equal(outputFailure.details.chunk, 'whole response\n');
        return true;
    });
});
