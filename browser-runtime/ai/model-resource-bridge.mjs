import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);

function errorRecord(value, seen = new Map()) {
    if (!is.error(value)) return value;
    if (seen.has(value)) return seen.get(value);
    const record = {name: value.name, message: value.message, stack: value.stack};
    seen.set(value, record);
    for (const key of Object.getOwnPropertyNames(value)) {
        if (key === 'cause') record[key] = errorRecord(value[key], seen);
        else if (key === 'errors' && is.array(value[key])) {
            record[key] = value[key].map(function recordError(error) {
                return errorRecord(error, seen);
            });
        } else record[key] = value[key];
    }
    return record;
}

function reviveError(value, seen = new Map()) {
    if (!value || !is.string(value.name) || !is.string(value.message)) return value;
    if (seen.has(value)) return seen.get(value);
    const error = new Error(value.message);
    seen.set(value, error);
    for (const [key, field] of Object.entries(value)) {
        let item = field;
        if (key === 'cause') item = reviveError(field, seen);
        if (key === 'errors' && is.array(field)) {
            item = field.map(function reviveNestedError(nested) {
                return reviveError(nested, seen);
            });
        }
        Object.defineProperty(error, key, {value: item, enumerable: true, configurable: true, writable: true});
    }
    return error;
}

function abortReason(signal) {
    return signal?.reason ?? new DOMException('The model resource operation was cancelled.', 'AbortError');
}

/** The store stays at its owner; only requests and complete Blob handles cross. */
export function createModelResourceHost({fetchResource, send, onError}) {
    const operations = new Map();
    const transportFailures = [];
    let closed = false;
    let closing;
    function receive(message) {
        if (message?.arcaneModelResource !== true) return false;
        const {resourceId, op} = message;
        if (op === 'cancel') {
            operations.get(resourceId)?.controller.abort(reviveError(message.reason));
            return true;
        }
        if (op !== 'fetch' || closed) return true;
        const controller = new AbortController();
        const operation = {controller};
        operations.set(resourceId, operation);
        async function runResourceFetch() {
            try {
                if (controller.signal.aborted) throw controller.signal.reason;
                const result = await fetchResource(message.request.url, {
                    ...message.request.options,
                    signal: controller.signal,
                    onProgress: function reportResourceProgress(progress) {
                        if (!closed) send({arcaneModelResource: true, resourceId, op: 'progress', progress});
                    }
                });
                if (!closed) send({arcaneModelResource: true, resourceId, op: 'result', result});
            } catch (error) {
                if (!closed) {
                    try {
                        send({arcaneModelResource: true, resourceId, op: 'error', error: errorRecord(error)});
                    } catch (transportError) {
                        throw new AggregateError([error, transportError], 'Model resource operation and error delivery failed.');
                    }
                }
                else if (error !== controller.signal.reason && error?.name !== 'AbortError') throw error;
            } finally {
                operations.delete(resourceId);
            }
        }
        // Publish ownership before invoking a store that can synchronously
        // report progress and trigger reentrant Worker shutdown.
        operation.promise = Promise.resolve().then(runResourceFetch);
        // Keep transport failures observable at close without an unhandled
        // rejection while the caller's Worker lifecycle is still active.
        operation.promise.catch(function observeResourceFailure(error) {
            transportFailures.push(error);
            if (!closed) {
                try {
                    if (onError) onError(error);
                    else globalThis.console?.error('Model resource transport failed.', error);
                } catch (handlerError) {
                    const failure = new AggregateError([error, handlerError], 'Model resource transport and its failure handler failed.');
                    transportFailures.push(failure);
                    globalThis.console?.error('Model resource failure handler failed.', failure);
                }
            }
        });
        return true;
    }
    function close(reason = abortReason()) {
        if (closing) return closing;
        closed = true;
        let resolveClose;
        let rejectClose;
        closing = new Promise(function retainResourceClose(resolve, reject) {
            resolveClose = resolve;
            rejectClose = reject;
        });
        const pending = [...operations.values()];
        for (const operation of pending) operation.controller.abort(reason);
        Promise.allSettled(pending.map(function resourceSettlement(operation) {
            return operation.promise;
        })).then(function finishResourceClose() {
            if (transportFailures.length) {
                rejectClose(new AggregateError(transportFailures, 'Unable to settle model resource transport.'));
            } else resolveClose();
        });
        return closing;
    }
    return {receive, close};
}

export function createModelResourceClient({send}) {
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    let closeReason;
    function receive(message) {
        if (message?.arcaneModelResource !== true) return false;
        const operation = pending.get(message.resourceId);
        if (!operation) return true;
        if (message.op === 'progress') {
            try {
                operation.onProgress?.(message.progress);
            } catch (error) {
                operation.cancel(error);
            }
            return true;
        }
        pending.delete(message.resourceId);
        operation.release();
        if (operation.cancelled) operation.reject(operation.reason);
        else if (message.op === 'error') operation.reject(reviveError(message.error));
        else operation.resolve(message.result);
        return true;
    }
    async function fetchResource(input, {onProgress, ...options} = {}) {
        if (closed) throw closeReason;
        const request = new Request(input, options);
        const signal = request.signal;
        if (signal.aborted) throw abortReason(signal);
        const requestOptions = {
            method: request.method,
            headers: [...request.headers],
            mode: request.mode,
            credentials: request.credentials,
            cache: request.cache,
            redirect: request.redirect,
            referrer: request.referrer,
            referrerPolicy: request.referrerPolicy,
            integrity: request.integrity,
            keepalive: request.keepalive
        };
        if (request.body) requestOptions.body = await request.blob();
        if (closed) throw closeReason;
        if (signal.aborted) throw abortReason(signal);
        const resourceId = nextId++;
        return new Promise(function requestModelResource(resolve, reject) {
            const operation = {resolve, reject, onProgress, cancelled: false};
            function cancel(reason) {
                if (operation.cancelled) return;
                operation.cancelled = true;
                operation.reason = reason;
                try {
                    send({arcaneModelResource: true, resourceId, op: 'cancel', reason: errorRecord(reason)});
                } catch (error) {
                    pending.delete(resourceId);
                    release();
                    reject(new AggregateError([reason, error], 'Unable to cancel the model resource transport.'));
                }
            }
            function cancelFromSignal() {
                cancel(abortReason(signal));
            }
            function release() {
                signal.removeEventListener('abort', cancelFromSignal);
            }
            operation.cancel = cancel;
            operation.release = release;
            pending.set(resourceId, operation);
            signal.addEventListener('abort', cancelFromSignal, {once: true});
            try {
                send({arcaneModelResource: true, resourceId, op: 'fetch',
                    request: {url: request.url, options: requestOptions}});
            } catch (error) {
                pending.delete(resourceId);
                release();
                reject(error);
            }
        });
    }
    async function fetch(input, options) {
        const request = new Request(input, options);
        const resource = await fetchResource(request, {onProgress: options?.onProgress});
        const response = resource.status === 0 ? Response.error() : new Response(
            request.method === 'HEAD' || [204, 205, 304].includes(resource.status) ? null : resource.file,
            {status: resource.status, statusText: resource.statusText, headers: resource.headers}
        );
        Object.defineProperties(response, {
            url: {value: resource.url, configurable: true},
            redirected: {value: resource.redirected, configurable: true}
        });
        return response;
    }
    function close(reason = abortReason()) {
        if (closed) return;
        closed = true;
        closeReason = reason;
        for (const operation of pending.values()) {
            operation.cancel(reason);
            operation.release();
            operation.reject(reason);
        }
        pending.clear();
    }
    return {receive, fetchResource, fetch, close};
}
