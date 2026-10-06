import {Worker} from 'node:worker_threads';
import {CoreError} from '../../browser-runtime/core/contracts.mjs';

function cancelled() {
    return new CoreError({name: 'AbortError', code: 'ARCANE_AI_REQUEST_ABORTED', message: 'Decision tokenization was cancelled.'});
}

/** One tokenizer worker owned by one native model activation. */
export function createDecisionTokenizer({tokenizerPath, tokenizerConfigPath, signal, onError}) {
    signal?.throwIfAborted();
    const pending = new Map();
    let nextId = 0;
    let closing;
    let terminalError;
    let exited = false;
    const worker = new Worker(new URL('./decision-tokenizer-worker.mjs', import.meta.url), {
        workerData: {tokenizerPath, tokenizerConfigPath}
    });
    let resolveExit;
    const exit = new Promise(function tokenizerExit(resolve) { resolveExit = resolve; });

    function rejectPending(error) {
        terminalError ??= error;
        for (const operation of pending.values()) operation.reject(error);
        pending.clear();
    }

    function operation(id) {
        return new Promise(function retainOperation(resolve, reject) {
            pending.set(id, {resolve, reject});
        });
    }

    const ready = operation(0);
    // The native owner observes ready together with ONNX load. Retain an error
    // handler immediately when the other owner is still starting.
    ready.catch(function observeTokenizerLoadFailure() {});
    worker.on('message', function tokenizerMessage(message) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (Object.hasOwn(message, 'error')) {
            const error = new CoreError(message.error);
            request.reject(error);
            if (message.id === 0) failed(error);
        }
        else request.resolve(message.result);
    });
    worker.on('error', failed);
    worker.on('messageerror', failed);
    worker.once('exit', function tokenizerExited(code) {
        exited = true;
        signal?.removeEventListener('abort', abort);
        const error = terminalError ?? new CoreError({
            code: 'ARCANE_DECISION_TOKENIZER_CLOSED',
            message: `The decision tokenizer worker exited with code ${code}.`
        });
        if (!closing) failed(error);
        else rejectPending(error);
        resolveExit(code);
    });

    function failed(error) {
        const firstFailure = !terminalError && !closing;
        rejectPending(error);
        close(error).catch(function reportTokenizerFailure(value) { console.error(value); });
        if (firstFailure) onError?.(error);
    }

    function close(reason = cancelled()) {
        if (closing) return closing;
        rejectPending(reason);
        signal?.removeEventListener('abort', abort);
        closing = Promise.resolve().then(async function releaseTokenizer() {
            let terminationError;
            try { if (!exited) await worker.terminate(); }
            catch (error) {
                terminationError = error;
                console.error('Terminating the decision tokenizer failed.', error);
            }
            // A rejected termination request is not evidence that the worker
            // has stopped reading its files. Retain ownership until real exit.
            await exit;
            if (terminationError) throw terminationError;
        });
        return closing;
    }

    function abort() {
        close(signal.reason).catch(function reportTokenizerCloseFailure(error) { console.error(error); });
    }
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();

    async function encode(rows) {
        await ready;
        if (terminalError || closing || exited) throw terminalError ?? cancelled();
        const id = ++nextId;
        const result = operation(id);
        try { worker.postMessage({id, rows}); }
        catch (error) {
            pending.get(id).reject(error);
            pending.delete(id);
        }
        return result;
    }

    return {ready, encode, close, get exited() { return exited; }};
}
