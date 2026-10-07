import Is from './dependencies/strong-type/index.js';
import {getInstalledCoreClient} from './core/client.mjs';
import {CoreError, serializeCoreError} from './core/contracts.mjs';

const is = new Is(false);

/** Acquires one complete document through the application's installed native service. */
export async function acquireCoreDocument({url, client = getInstalledCoreClient(), signal, onProgress} = {}) {
    if (!is.function(client?.invoke) || !is.function(client?.events?.on)) {
        throw new CoreError({
            code: 'DOCUMENT_ACQUISITION_CORE_UNAVAILABLE',
            message: 'Document acquisition requires an available native Core connection.'
        });
    }
    if (!is.string(url) || url === '') {
        throw new TypeError('Document acquisition url must be a nonempty string.');
    }
    if (onProgress !== undefined && !is.function(onProgress)) {
        throw new TypeError('Document acquisition onProgress must be a function.');
    }
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    operationSignal.throwIfAborted();
    const observers = new Set();
    let requestId;
    let active = true;
    const observerErrors = [];

    function retainObserverFailure(error) {
        observerErrors.push(error);
        controller.abort(error);
    }

    const unsubscribe = client.events.on('documents.progress', function documentProgress(progress) {
        if (!active || operationSignal.aborted || !requestId || progress.requestId !== requestId || !onProgress) return;
        let observation;
        try { observation = Promise.resolve(onProgress(progress)); }
        catch (error) { retainObserverFailure(error); return; }
        observers.add(observation);
        function observed() { observers.delete(observation); }
        observation.then(observed, function failed(error) {
            observed();
            retainObserverFailure(error);
        });
    });

    let result;
    let failed = false;
    let failure;
    try {
        result = await client.invoke('documents.acquire', {url}, {
            signal: operationSignal, timeoutMs: 0,
            onRequest(request) { requestId = request.requestId; }
        });
    } catch (error) {
        failed = true;
        failure = error;
    } finally {
        active = false;
        try { unsubscribe(); } catch (error) { observerErrors.push(error); }
        await Promise.allSettled([...observers]);
    }
    if (failed) failure = decodeFailure(failure);
    let document;
    if (!failed) {
        const {redirects, ...response} = result;
        document = {...decodeResponse(response), redirects: redirects.map(decodeResponse)};
    }
    if (observerErrors.length) {
        const error = !failed && observerErrors.length === 1
            ? new CoreError({...serializeCoreError(observerErrors[0]), cause: observerErrors[0]})
            : new AggregateError(
                failed ? [failure, ...observerErrors] : observerErrors,
                'Document acquisition progress observers failed.',
                failed ? {cause: failure} : undefined
            );
        if (document) {
            const {requestedUrl, finalUrl, redirects, ...response} = document;
            error.documentAcquisition = {requestedUrl, requestUrl: finalUrl, redirects, response};
        } else if (failure?.documentAcquisition) {
            error.documentAcquisition = failure.documentAcquisition;
        }
        throw error;
    }
    if (failed) throw failure;
    operationSignal.throwIfAborted();
    return document;
}

function decodeFailure(error) {
    if (!error?.documentAcquisition) return error;
    const {response, redirects, ...metadata} = error.documentAcquisition;
    return new CoreError({
        ...serializeCoreError(error),
        documentAcquisition: {
            ...metadata,
            redirects: redirects.map(decodeResponse),
            ...(response ? {response: decodeResponse(response)} : {})
        }
    });
}

function decodeResponse(response) {
    const {body, ...metadata} = response;
    if (body.encoding !== 'base64') {
        throw new TypeError(`Unsupported document transport encoding ${body.encoding}.`);
    }
    const content = Uint8Array.from(globalThis.atob(body.data), function decodeCharacter(character) {
        return character.charCodeAt(0);
    });
    return {...metadata, body: new Blob([content], {type: metadata.mediaType ?? ''})};
}
