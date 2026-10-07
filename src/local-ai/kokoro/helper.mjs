import path from 'node:path';
import {PassThrough} from 'node:stream';
import Is from 'strong-type';
import {runProcess} from '../../process.mjs';
import {floatPCM} from './frontend.mjs';

const is = new Is(false);

/** One retained helper owns eSpeak's process-global state and the public Opus encoder. */
export function createKokoroHelper(runtime, {onEvent} = {}) {
    const controller = new AbortController();
    const input = new PassThrough();
    const readiness = deferred();
    let pending = null;
    let fragment = Buffer.alloc(0);
    let frame = null;
    let sequence = 0;
    let stopping = false;
    let exited = false;
    let terminalError = null;
    const env = {...process.env};
    const directory = runtime.libraryDirectory ?? path.dirname(runtime.helperExecutable);
    const variable = process.platform === 'win32'
        ? Object.keys(env).find(function pathName(name) { return name.toLowerCase() === 'path'; }) ?? 'PATH'
        : process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH';
    env[variable] = [directory, env[variable]].filter(Boolean).join(path.delimiter);
    const source = input[Symbol.asyncIterator]();
    const incoming = {
        [Symbol.asyncIterator]() { return this; },
        next() { return source.next(); },
        return() { input.end(); return source.return(); }
    };
    const completion = runProcess(runtime.helperExecutable, ['--data', runtime.espeakDataDirectory], {
        env, signal: controller.signal, onEvent, input: incoming,
        outputEncoding: {stdout: null, stderr: 'utf8'},
        captureOutput: {stdout: false, stderr: true},
        emitOutputEvents: {stdout: false, stderr: true},
        onOutput: receive
    }).then(function helperExited(result) {
        if (!stopping) throw new Error('The Kokoro helper exited before being released.');
        return result;
    }).catch(function helperFailed(error) {
        terminalError = error;
        throw error;
    }).finally(function helperSettled() {
        exited = true;
        input.end();
        const failure = terminalError ?? new Error('The Kokoro helper has stopped.');
        readiness.reject(failure);
        pending?.response.reject(failure);
    });
    completion.catch(function observeHelperFailure() {});

    function receive({stream, chunk}) {
        if (stream !== 'stdout') return;
        fragment = fragment.length ? Buffer.concat([fragment, chunk]) : chunk;
        for (;;) {
            if (!frame) {
                const boundary = fragment.indexOf(10);
                if (boundary < 0) return;
                const [kind, id, length] = fragment.subarray(0, boundary).toString('utf8').split('\t');
                frame = {kind, id, length: Number(length)};
                if (!is.safeInteger(frame.length) || frame.length < 0) throw new Error('The Kokoro helper returned unreadable protocol framing.');
                fragment = fragment.subarray(boundary + 1);
            }
            if (fragment.length < frame.length) return;
            const payload = fragment.subarray(0, frame.length);
            fragment = fragment.subarray(frame.length);
            const record = frame;
            frame = null;
            if (record.kind === 'ready') {
                readiness.resolve();
                continue;
            }
            if (!pending || record.id !== pending.id) throw new Error('The Kokoro helper returned a response without its active request.');
            if (record.kind === 'error') pending.response.reject(new Error(payload.toString('utf8')));
            else if (record.kind === 'clause') pending.clauses.push(JSON.parse(payload.toString('utf8')));
            else if (record.kind === 'page') pending.pages.push(Buffer.from(payload));
            else if (record.kind === 'done') pending.response.resolve(pending);
            else throw new Error(`The Kokoro helper returned an unknown record ${record.kind}.`);
        }
    }

    async function command(kind, body, language, signal) {
        signal?.throwIfAborted();
        await readiness.promise;
        signal?.throwIfAborted();
        if (pending || stopping || exited) throw terminalError ?? new Error('The Kokoro helper is unavailable for a new operation.');
        const operation = {id: String(++sequence), response: deferred(), clauses: [], pages: []};
        pending = operation;
        function cancel() { stopping = true; controller.abort(signal.reason); }
        signal?.addEventListener('abort', cancel, {once: true});
        try {
            if (signal?.aborted) cancel();
            const length = body.reduce(function frameLength(total, part) { return total + part.length; }, 0);
            await write(Buffer.from(`${kind}\t${operation.id}\t${length}\t${language ?? ''}\n`));
            for (const part of body) {
                signal?.throwIfAborted();
                await write(part);
            }
            const result = await operation.response.promise;
            signal?.throwIfAborted();
            return result;
        } catch (failure) {
            // A partial command cannot share this pipe with another request.
            stopping = true;
            controller.abort(failure);
            let primary = failure;
            if (signal?.aborted && expectedCancellation(failure)) primary = signal.reason;
            try {
                await completion;
            } catch (completionFailure) {
                if (completionFailure !== failure && !expectedCancellation(completionFailure)) {
                    throw new AggregateError([primary, completionFailure], 'The Kokoro command and helper shutdown failed.', {cause: primary});
                }
            }
            throw primary;
        } finally {
            signal?.removeEventListener('abort', cancel);
            if (pending === operation) pending = null;
        }
    }

    function write(value) {
        if (exited || controller.signal.aborted) return Promise.reject(terminalError ?? controller.signal.reason ?? new Error('The Kokoro helper stopped.'));
        return new Promise(function writeInput(resolve, reject) {
            input.write(value, function inputWritten(error) { if (error) reject(error); else resolve(); });
        });
    }

    async function phonemize(text, language, {signal} = {}) {
        if (text.includes('\0')) throw new TypeError('The public eSpeak text interface cannot consume an embedded NUL character.');
        if (!text.isWellFormed()) throw new TypeError('The public eSpeak UTF-8 interface cannot represent an unpaired Unicode surrogate.');
        const result = await command('phonemize', [Buffer.from(text, 'utf8')], language, signal);
        return result.clauses;
    }

    async function encodeOpus(chunks, {signal} = {}) {
        const result = await command('opus', chunks.map(floatPCM), null, signal);
        return Buffer.concat(result.pages);
    }

    async function close(reason) {
        stopping = true;
        if (reason !== undefined) controller.abort(reason);
        input.end();
        try { await completion; }
        catch (failure) {
            if (!expectedCancellation(failure)) throw failure;
        }
    }

    function expectedCancellation(failure) {
        if (!controller.signal.aborted || failure?.code !== 'ARCANE_CANCELLED') return false;
        if (is.array(failure.errors) && !failure.errors.every(expectedCancellation)) return false;
        return failure.cause === controller.signal.reason || expectedCancellation(failure.cause);
    }

    return {ready: readiness.promise, completion, phonemize, encodeOpus, close,
        get exited() { return exited; }};
}

function deferred() {
    const value = {};
    value.promise = new Promise(function pending(resolve, reject) { value.resolve = resolve; value.reject = reject; });
    value.promise.catch(function observePendingFailure() {});
    return value;
}
