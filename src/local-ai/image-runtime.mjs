import {Worker} from 'node:worker_threads';
import {isDeepStrictEqual} from 'node:util';
import {createArcaneEventSource} from '../event-manager.mjs';

const brokers = new Map();

/** Share the native library owner between Core services in this host. */
export function createImageRuntime(
    {libraryPath, bindingModulePath, variants = [], models = [], backend = 'auto', signal, onEvent} = {}
) {
    let broker = brokers.get(libraryPath);
    if (!broker || broker.closed || broker.closing) {
        const predecessor = broker && !broker.closed ? broker.close() : undefined;
        broker = createBroker({libraryPath, bindingModulePath, variants, backend}, predecessor);
        brokers.set(libraryPath, broker);
    }
    broker.references++;
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const operations = new Set();
    const definitions = new Map();
    const selections = new WeakMap();
    let closing;
    for (const model of models) definitions.set(model.id, model);

    const stopDiagnostic = broker.events.on(
        'image.diagnostic',
        function runtimeDiagnostic(event) {
            if (onEvent) {
                observe(onEvent, event.detail);
            }
        }
    );

    function selectedModel(model) {
        let definition = typeof model === 'string' ? definitions.get(model) : model;
        if (!definition) {
            throw failure('LOCAL_IMAGE_MODEL_UNAVAILABLE', `The image model ${String(model)} has not been prepared.`);
        }
        const previous = definitions.get(definition.id);
        if (previous && isDeepStrictEqual(previous, definition)) definition = previous;
        definitions.set(definition.id, definition);
        let selection = selections.get(definition);
        if (!selection) {
            selection = {model: definition, backend, selection: ++broker.nextSelection};
            selections.set(definition, selection);
        }
        return selection;
    }

    function operation(name, parameters, operationSignal, onProgress) {
        if (closing) return Promise.reject(failure('LOCAL_IMAGE_CLOSED', 'The image runtime is closing.'));
        const combined = operationSignal ? AbortSignal.any([lifetimeSignal, operationSignal]) : lifetimeSignal;
        combined.throwIfAborted();
        if (name === 'unload') {
            broker.cancelPending(failure('LOCAL_IMAGE_UNLOADED', 'The image model is being unloaded.'));
        }
        const task = broker.enqueue(name, parameters, combined, onProgress);
        operations.add(task);
        function settled() { operations.delete(task); }
        task.then(settled, settled);
        return task;
    }

    function load({model, context, signal: operationSignal} = {}) {
        let selected = selectedModel(model);
        if (context !== undefined) {
            selected = selectedModel(
                {...selected.model, context: {...selected.model.context, ...context}}
            );
        }
        return operation('load', selected, operationSignal);
    }

    function generate({model, prompt, parameters, signal: operationSignal, onProgress} = {}) {
        return operation(
            'generate',
            {...selectedModel(model), prompt, parameters},
            operationSignal,
            onProgress
        );
    }

    function edit({model, image, prompt, strength, parameters, signal: operationSignal, onProgress} = {}) {
        if (typeof strength !== 'number' || !Number.isFinite(strength)) {
            throw new TypeError('Image editing requires an explicit finite strength.');
        }
        if (strength < 0 || strength > 1) {
            throw new RangeError('Image editing strength must be between 0 and 1.');
        }
        // The accepted input must survive caller reuse while this request queues.
        const input = {
            ...image,
            data: image?.data instanceof Uint8Array ? new Uint8Array(image.data) : image?.data
        };
        return operation(
            'edit',
            {...selectedModel(model), image: input, prompt, strength, parameters},
            operationSignal,
            onProgress
        );
    }

    function unload({signal: operationSignal} = {}) {
        return operation('unload', {}, operationSignal);
    }

    function subscribe(listener, {replay = true} = {}) {
        const stop = broker.events.on('image.state', function stateChanged(event) { observe(listener, event.detail); });
        if (replay) observe(listener, broker.current());
        return stop;
    }

    function close() {
        if (closing) return closing;
        closing = Promise.resolve().then(async function releaseRuntime() {
            await Promise.allSettled([...operations]);
            const errors = [];
            try {
                // Native accessor closure releases the shared model before its
                // service may release working files. Browser accessor closure
                // does not invoke this native ownership boundary.
                if (broker.current().available && !broker.closing) {
                    await broker.enqueue('unload', {});
                } else {
                    await broker.close();
                }
            } catch (error) {
                errors.push(error);
            }
            stopDiagnostic();
            lifetimeSignal.removeEventListener('abort', abortRuntime);
            broker.references--;
            if (broker.references === 0 || errors.length) {
                try {
                    await broker.close();
                } catch (error) {
                    if (!errors.includes(error)) errors.push(error);
                } finally {
                    if (brokers.get(libraryPath) === broker) brokers.delete(libraryPath);
                }
            }
            if (errors.length === 1) throw errors[0];
            if (errors.length > 1) {
                throw new AggregateError(errors, 'Image model and native owner cleanup failed.', {cause: errors[0]});
            }
            return broker.current();
        });
        lifetime.abort();
        return closing;
    }

    function abortRuntime() { close().catch(reportError); }
    lifetimeSignal.addEventListener('abort', abortRuntime, {once: true});
    if (lifetimeSignal.aborted) abortRuntime();
    return {load, generate, edit, unload, current: broker.current, subscribe, close};
}

function createBroker(configuration, predecessor) {
    const events = createArcaneEventSource(
        {},
        {source: 'local-image', eventTypes: ['image.state', 'image.diagnostic']}
    );
    const queue = [];
    let state = {
        state: 'unloaded', available: true, selectedModel: null, loaded: false,
        backend: null, devices: [], resources: {}, progress: null, error: null, closed: false
    };
    let worker;
    let starting;
    let workerReady = false;
    let workerExited = false;
    let terminalError;
    let workerExit;
    let active;
    let nextRequest = 0;
    let closeTask;
    const broker = {references: 0, nextSelection: 0, closing: false, closed: false, events, current, enqueue, cancelPending, close};

    function current() { return structuredClone(state); }

    function publish(fields) {
        state = {...state, ...fields};
        events.dispatch('image.state', current());
    }

    function finish(operation, error, result) {
        if (operation.settled) return;
        operation.settled = true;
        operation.signal?.removeEventListener('abort', operation.abort);
        if (active === operation) active = undefined;
        if (error) operation.reject(error);
        else operation.resolve(result);
    }

    function failed(error) {
        terminalError = error;
        publish({state: 'error', available: false, error: describeError(error)});
        if (active) finish(active, error);
        for (const operation of queue.splice(0)) finish(operation, error);
    }

    async function startWorker() {
        if (predecessor) {
            try {
                await predecessor;
            } catch (error) {
                // Retirement has joined the prior native worker even when its
                // cleanup reports an error. Preserve that diagnostic while the
                // new owner starts its independent lifetime.
                events.dispatch('image.diagnostic', {type: 'local-image.previous-close.failed', error: describeError(error)});
            }
        }
        worker = new Worker(new URL('./image-worker.mjs', import.meta.url), {workerData: configuration});
        workerExit = new Promise(function awaitWorkerExit(resolve) {
            worker.once('exit', function imageWorkerExited(code) {
                workerExited = true;
                workerReady = false;
                if (!broker.closed && !closeTask) {
                    failed(failure('LOCAL_IMAGE_WORKER_EXITED', `The native image worker exited with code ${code}.`));
                }
                resolve();
            });
        });
        worker.on('error', failed);
        worker.on('message', function workerMessage(message) {
            if (message.type === 'ready') {
                workerReady = true;
                publish(message.state);
                pump();
            } else if (message.type === 'state') {
                publish(message.state);
            } else if (message.type === 'diagnostic') {
                events.dispatch('image.diagnostic', message.event);
            } else if (message.type === 'progress') {
                publish({progress: message.progress});
                if (active?.id === message.id && active.onProgress) {
                    try {
                        Promise.resolve(active.onProgress(message.progress)).catch(reportError);
                    } catch (error) {
                        reportError(error);
                    }
                }
            } else if (message.type === 'result') {
                if (active?.id !== message.id) return;
                finish(active, message.error ? restoreError(message.error) : null, message.result);
                pump();
            } else if (message.type === 'fatal') {
                failed(restoreError(message.error));
            }
        });
    }

    function pump() {
        if (active || !queue.length) return;
        if (!worker) {
            if (!starting) {
                publish({state: 'starting'});
                starting = startWorker();
                starting.catch(failed);
            }
            return;
        }
        if (!workerReady) return;
        active = queue.shift();
        if (active.signal?.aborted) {
            finish(active, active.signal.reason);
            pump();
            return;
        }
        try {
            worker.postMessage({type: 'operation', id: active.id, operation: active.name, parameters: active.parameters});
        } catch (error) {
            finish(active, error);
            pump();
        }
    }

    function enqueue(name, parameters, signal, onProgress) {
        if (broker.closed) return Promise.reject(failure('LOCAL_IMAGE_CLOSED', 'The image runtime is closed.'));
        if (broker.closing && name !== 'close') {
            return Promise.reject(failure('LOCAL_IMAGE_CLOSED', 'The image runtime is closing.'));
        }
        if (terminalError) return Promise.reject(terminalError);
        return new Promise(function enqueueImage(resolve, reject) {
            const operation = {id: ++nextRequest, name, parameters, signal, onProgress, resolve, reject, settled: false};
            operation.abort = function cancelOperation() {
                if (active === operation) {
                    publish({state: 'cancelling'});
                    worker.postMessage({type: 'cancel', id: operation.id});
                } else {
                    const index = queue.indexOf(operation);
                    if (index !== -1) queue.splice(index, 1);
                    finish(operation, signal.reason);
                }
            };
            signal?.addEventListener('abort', operation.abort, {once: true});
            queue.push(operation);
            if (signal?.aborted) operation.abort();
            pump();
        });
    }

    function cancelPending(reason) {
        for (const operation of queue.splice(0)) finish(operation, reason);
        if (active) {
            publish({state: 'cancelling'});
            worker.postMessage({type: 'cancel', id: active.id});
        }
    }

    function close() {
        if (closeTask) return closeTask;
        broker.closing = true;
        closeTask = (async function closeImageOwner() {
            try {
                if (worker || starting) {
                    if (!workerExited && !terminalError) await enqueue('close', {});
                }
            } finally {
                await starting?.catch(function startupClosed() {});
                await workerExit;
                broker.closed = true;
                publish({state: 'closed', available: false, loaded: false, resources: {}, closed: true});
                events.dispose();
            }
        })();
        return closeTask;
    }
    return broker;
}

function failure(code, message) {
    return Object.assign(new Error(message), {code});
}

function describeError(error) {
    if (!(error instanceof Error)) return {name: 'Error', message: String(error), cause: error};
    return {
        ...error, name: error.name, message: error.message, stack: error.stack,
        ...(error.cause !== undefined ? {cause: describeError(error.cause)} : {}),
        ...(error instanceof AggregateError ? {errors: error.errors.map(describeError)} : {})
    };
}

function restoreError(record) { return Object.assign(new Error(record.message), record); }

function reportError(error) { console.error('Local image observation failed.', error); }

function observe(listener, detail) {
    try {
        Promise.resolve(listener(detail)).catch(reportError);
    } catch (error) {
        reportError(error);
    }
}
