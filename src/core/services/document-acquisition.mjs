import {Buffer} from 'node:buffer';
import Is from 'strong-type';
import {CoreError, serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';

const is = new Is(false);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

/** The application supplies its optional destination decision in this native process. */
export function createDocumentAcquisitionService({destinationPredicate, signal} = {}) {
    if (destinationPredicate !== undefined && !is.function(destinationPredicate)) {
        throw new TypeError('Document acquisition destinationPredicate must be a function.');
    }
    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const jobs = new Set();
    let closing;

    function acquire({url, signal: requestSignal, onProgress} = {}) {
        if (!is.string(url) || url === '') {
            throw new TypeError('Document acquisition url must be a nonempty string.');
        }
        if (onProgress !== undefined && !is.function(onProgress)) {
            throw new TypeError('Document acquisition onProgress must be a function.');
        }
        const operationSignal = requestSignal
            ? AbortSignal.any([lifetimeSignal, requestSignal]) : lifetimeSignal;
        const evidence = {requestedUrl: url, requestUrl: url, redirects: []};

        async function progress(phase, completed = 0) {
            operationSignal.throwIfAborted();
            await onProgress?.({
                phase, completed, total: 1, unit: 'documents',
                requestedUrl: url, url: evidence.requestUrl
            });
            operationSignal.throwIfAborted();
        }

        const task = Promise.resolve().then(async function acquireDocument() {
            try {
                await progress('accepted');
                let destination = new URL(url);
                while (true) {
                    evidence.requestUrl = destination.href;
                    if (destination.protocol !== 'http:' && destination.protocol !== 'https:') {
                        throw new TypeError('Document acquisition requires an HTTP or HTTPS URL.');
                    }
                    await progress('destination');
                    if (destinationPredicate !== undefined) {
                        const accepted = await destinationPredicate(destination.href, {
                            requestedUrl: url,
                            previousUrl: evidence.redirects.at(-1)?.url ?? null,
                            signal: operationSignal
                        });
                        operationSignal.throwIfAborted();
                        if (accepted !== true) {
                            throw new CoreError({
                                code: 'DOCUMENT_DESTINATION_DECLINED',
                                message: `The application declined document destination ${destination.href}.`
                            });
                        }
                    }
                    await progress('request');
                    // Manual redirects keep the application decision ahead of every request.
                    const response = await fetch(destination.href, {
                        method: 'GET', redirect: 'manual', signal: operationSignal
                    });
                    const record = {
                        url: response.url,
                        status: response.status,
                        statusText: response.statusText,
                        ok: response.ok,
                        headers: Array.from(response.headers.entries()),
                        mediaType: response.headers.get('content-type'),
                        body: new Uint8Array(),
                        complete: false
                    };
                    evidence.response = record;
                    await readResponse(response, record, operationSignal, function reading() {
                        return progress('response');
                    });
                    const location = response.headers.get('location');
                    if (redirectStatuses.has(record.status) && location !== null) {
                        evidence.redirects.push(record);
                        delete evidence.response;
                        await progress('redirect');
                        destination = new URL(location, response.url || destination.href);
                        continue;
                    }
                    const result = {
                        requestedUrl: url, finalUrl: response.url,
                        ...record, redirects: evidence.redirects
                    };
                    await progress('complete', 1);
                    return result;
                }
            } catch (cause) {
                // Retain the original error as cause, including complete native properties.
                throw new CoreError({
                    ...serializeCoreError(cause), cause,
                    documentAcquisition: evidence
                });
            }
        });
        jobs.add(task);
        function settled() { jobs.delete(task); }
        task.then(settled, settled);
        return task;
    }

    async function acquireThroughCore(parameters, request) {
        try {
            const result = await acquire({
                url: parameters.url,
                signal: request.signal,
                onProgress(progress) {
                    request.emit('documents.progress', {
                        requestId: request.clientRequestId ?? request.requestId,
                        ...progress
                    });
                }
            });
            return encodeResult(result);
        } catch (error) {
            if (!error.documentAcquisition) throw error;
            throw new CoreError({
                ...serializeCoreError(error),
                documentAcquisition: encodeEvidence(error.documentAcquisition)
            });
        }
    }

    function dispose() {
        closing ??= Promise.resolve().then(async function closeAcquisitionService() {
            lifetime.abort(new CoreError({
                code: 'DOCUMENT_ACQUISITION_CLOSED',
                message: 'The document acquisition service is closing.'
            }));
            await Promise.allSettled([...jobs]);
        });
        return closing;
    }

    return {
        name: 'documents',
        methods: {'documents.acquire': acquireThroughCore},
        acquire,
        dispose
    };
}

async function readResponse(response, record, signal, onReading) {
    const chunks = [];
    const cleanupErrors = [];
    let reader;
    let cancellation;
    let failed = false;
    let failure;

    function cancelReader(reason) {
        if (!reader || cancellation) return;
        cancellation = Promise.resolve().then(function cancelResponseBody() {
            return reader.cancel(reason);
        }).catch(function retainCleanupError(error) { cleanupErrors.push(error); });
    }
    function aborted() { cancelReader(signal.reason); }

    try {
        reader = response.body?.getReader();
        signal.addEventListener('abort', aborted, {once: true});
        if (signal.aborted) aborted();
        await onReading();
        while (reader) {
            signal.throwIfAborted();
            const {done, value} = await reader.read();
            if (value !== undefined) chunks.push(Buffer.from(value));
            if (done) {
                signal.throwIfAborted();
                break;
            }
        }
        signal.throwIfAborted();
        record.complete = true;
    } catch (error) {
        failed = true;
        failure = error;
        cancelReader(error);
    } finally {
        signal.removeEventListener('abort', aborted);
        if (cancellation) await cancellation;
        try { reader?.releaseLock(); } catch (error) { cleanupErrors.push(error); }
        record.body = Buffer.concat(chunks);
    }
    if (cleanupErrors.length) {
        throw new AggregateError(
            failed ? [failure, ...cleanupErrors] : cleanupErrors,
            'Document response cleanup failed.',
            failed ? {cause: failure} : undefined
        );
    }
    if (failed) throw failure;
}

function encodeResponse(record) {
    const {body, ...metadata} = record;
    // Encoding belongs only to the existing JSON Core transport.
    return {...metadata, body: {encoding: 'base64', data: Buffer.from(body).toString('base64')}};
}

function encodeResult(result) {
    const {redirects, ...response} = result;
    return {...encodeResponse(response), redirects: redirects.map(encodeResponse)};
}

function encodeEvidence(evidence) {
    const {response, redirects, ...metadata} = evidence;
    return {
        ...metadata,
        redirects: redirects.map(encodeResponse),
        ...(response ? {response: encodeResponse(response)} : {})
    };
}
