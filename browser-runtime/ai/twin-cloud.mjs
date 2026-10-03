import Is from 'strong-type';
import {arcaneLogging} from '../logging.mjs';

const is = new Is(false);
const twinChatURL = 'https://inference.do-ai.run/v1/chat/completions';
const twinSystemOneURL = 'https://inference.do-ai.run/v1/systemone';

/** A stateless TWiN request; browser AI shares the HTTP and format owners below. */
export async function fetchRequest({
    twinKey,
    model,
    messages = [],
    structuredOutput = false,
    tools = [],
    toolChoice = 'auto',
    parallelToolCalls,
    reasoningEffort,
    temperature,
    signal = null,
    id = Date.now(),
    onRequest = function observeTWiNRequest(){},
    onResponse = function observeTWiNResponse(){},
    onRetry = null
} = {}){
    if(signal?.aborted){
        throw normalizeAIRequestAbort(signal.reason);
    }
    if(!is.string(twinKey) || !twinKey){
        const error = new Error('AI provider is not configured.');
        error.code = 'AI_PROVIDER_NOT_CONFIGURED';
        throw error;
    }
    if(!is.string(model) || !model){
        throw new TypeError('TWiN fetchRequest requires an explicit model.');
    }

    const request = {model, messages, stream:false};
    const format = structuredOutputFormat(structuredOutput);
    if(format){
        request.response_format = openAIResponseFormat(format);
    }
    if(tools.length){
        request.tools = tools;
        request.tool_choice = toolChoice;
        if(parallelToolCalls !== undefined){
            request.parallel_tool_calls = parallelToolCalls;
        }
    }
    if(reasoningEffort){
        request.reasoning_effort = reasoningEffort;
    }
    if(temperature !== undefined){
        request.temperature = temperature;
    }

    try{
        await onRequest(
            request,
            id,
            {operation:'fetch', transport:'http', destination:twinChatURL}
        );
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        const response = await fetchJSONResponse(
            twinChatURL,
            {
                method:'POST',
                credentials:'omit',
                headers:{
                    'Content-Type':'application/json',
                    Authorization:`Bearer ${twinKey}`
                },
                body:JSON.stringify(request),
                ...(signal ? {signal} : {})
            },
            {onRetry}
        );
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        await onResponse(response, id, false);
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        return response;
    }catch(error){
        if(isAIRequestAbort(error, signal)){
            throw normalizeAIRequestAbort(error);
        }
        throw error;
    }
}

/** Submit caller-owned state and questions without interpreting the provider's answers. */
export async function fetchSystemOneRequest({
    twinKey,
    model,
    state,
    questions,
    signal = null,
    id = Date.now(),
    onRequest = function observeSystemOneRequest(){},
    onResponse = function observeSystemOneResponse(){},
    onRetry = null
} = {}){
    if(signal?.aborted){
        throw normalizeAIRequestAbort(signal.reason);
    }
    if(!is.string(twinKey) || !twinKey){
        const error = new Error('AI provider is not configured.');
        error.code = 'AI_PROVIDER_NOT_CONFIGURED';
        throw error;
    }
    if(!is.string(model) || !model){
        throw new TypeError('TWiN fetchSystemOneRequest requires an explicit model.');
    }

    const request = {model, state, questions};
    // Capture the caller's complete payload before a diagnostic observer runs.
    const body = JSON.stringify(request);
    try{
        await onRequest(
            request,
            id,
            {operation:'systemone', transport:'http', destination:twinSystemOneURL}
        );
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        const response = await fetchJSONResponse(
            twinSystemOneURL,
            {
                method:'POST',
                credentials:'omit',
                headers:{
                    'Content-Type':'application/json',
                    Authorization:`Bearer ${twinKey}`
                },
                body,
                ...(signal ? {signal} : {})
            },
            {onRetry}
        );
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        await onResponse(response, id, false);
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        return response;
    }catch(error){
        if(isAIRequestAbort(error, signal)){
            throw normalizeAIRequestAbort(error);
        }
        throw error;
    }
}

export function isAIRequestAbort(error, signal){
    return signal?.aborted
        || error?.name === 'AbortError'
        || error?.code === 'ARCANE_REQUEST_ABORTED'
        || error?.code === 'ARCANE_AI_REQUEST_ABORTED'
        || error?.code === 'AI_REQUEST_ABORTED';
}

export function normalizeAIRequestAbort(error){
    if(error?.code === 'ARCANE_AI_REQUEST_ABORTED'){
        return error;
    }
    const normalized = new Error('The AI request was cancelled.', {cause:error});
    normalized.name = 'AbortError';
    normalized.code = 'ARCANE_AI_REQUEST_ABORTED';
    return normalized;
}

/** Stateless image generation; model selection and provider parameters belong to the caller. */
export async function generateImages({
    model,
    prompt,
    parameters = {},
    twinKey,
    getApiKey,
    signal = null,
    id = Date.now(),
    onRequest = function observeImageRequest(){},
    onResponse = function observeImageResponse(){},
    onProgress = function observeImageProgress(){}
} = {}) {
    if (signal?.aborted) throw normalizeAIRequestAbort(signal.reason);
    const asynchronous = model === 'fal-ai/flux/schnell';
    if (!asynchronous && model !== 'stable-diffusion-3.5-large') {
        const error = new TypeError('TWiN generateImages requires a supported explicit image model.');
        error.code = 'ARCANE_AI_IMAGE_MODEL_UNSUPPORTED';
        throw error;
    }
    if (!is.string(prompt)) throw new TypeError('TWiN generateImages requires a prompt string.');
    if (!parameters || !is.object(parameters) || is.array(parameters)) {
        throw new TypeError('Image parameters must be an object of additional provider fields.');
    }
    if (Object.hasOwn(parameters, 'prompt') || (!asynchronous && Object.hasOwn(parameters, 'model'))) {
        throw new TypeError('Supply the image prompt and model through their named arguments.');
    }
    const destination = asynchronous
        ? 'https://inference.do-ai.run/v1/async-invoke'
        : 'https://inference.do-ai.run/v1/images/generations';
    const request = asynchronous
        ? {model_id: model, input: {...parameters, prompt}}
        : {...parameters, model, prompt};
    // Observe the complete request without allowing a later callback to rewrite its payload.
    const body = JSON.stringify(request);
    const outputFormat = parameters.output_format;
    const controller = new AbortController();
    const operationSignal = controller.signal;
    function cancelImageRequest() {controller.abort(signal.reason);}
    signal?.addEventListener('abort', cancelImageRequest, {once: true});
    if (signal?.aborted) cancelImageRequest();

    function progress(stage, requestId) {
        return settleImageOperation(
            function publishImageProgress() {
                return onProgress({stage, model, id, ...(requestId === undefined ? {} : {requestId})});
            },
            operationSignal
        );
    }

    async function inference(url, options) {
        const response = await settleImageOperation(
            function requestImageInference() {return fetch(url, {...options, credentials: 'omit', signal: operationSignal});},
            operationSignal
        );
        const result = await settleImageOperation(
            function readImageInference() {
                if (response.ok || response.headers.get('content-type')?.includes('application/json')) {
                    return response.json();
                }
                return response.text();
            },
            operationSignal
        );
        if (!response.ok) throw result;
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter?.trim() ? Number(retryAfter) : NaN;
        const date = retryAfter?.trim() ? Date.parse(retryAfter) : NaN;
        const delay = is.finite(seconds) && seconds >= 0 ? seconds * 1000
            : is.finite(date) ? Math.max(0, date - Date.now()) : 1000;
        return {result, delay};
    }

    try {
        await progress('credentials');
        const key = twinKey === undefined && is.function(getApiKey)
            ? await settleImageOperation(getApiKey, operationSignal) : twinKey;
        if (!is.string(key) || !key) {
            const error = new Error('AI provider is not configured.');
            error.code = 'AI_PROVIDER_NOT_CONFIGURED';
            throw error;
        }
        const headers = {'Content-Type': 'application/json', Authorization: `Bearer ${key}`};
        await settleImageOperation(
            function observeImageSubmission() {
                return onRequest(request, id, {operation: 'images', transport: 'http', destination});
            },
            operationSignal
        );
        await progress('requesting');
        // A lost POST response can represent an accepted paid job. Never replay it.
        let response = await inference(destination, {method: 'POST', headers, body});
        let result = response.result;
        if (asynchronous) {
            const requestId = result?.request_id;
            while (result?.status === 'QUEUED' || result?.status === 'IN_PROGRESS') {
                if (!is.string(requestId) || !requestId) {
                    throw imageResultError('Image generation returned a pending job without a request_id.', result);
                }
                await progress(result.status === 'QUEUED' ? 'queued' : 'generating', requestId);
                await waitForImageStatus(response.delay, operationSignal);
                response = await inference(
                    `${destination}/${encodeURIComponent(requestId)}/status`,
                    {method: 'GET', headers}
                );
                result = response.result;
            }
            if (result?.status === 'FAILED') {
                throw imageResultError('TWiN Cloud image generation failed.', result);
            }
            if (result?.status !== 'COMPLETED' && result?.status !== 'COMPLETE') {
                throw imageResultError('TWiN Cloud returned an unsupported image job status.', result);
            }
            if (!is.array(result.output?.images)) {
                if (!is.string(requestId) || !requestId) {
                    throw imageResultError('Image generation returned no result or request_id.', result);
                }
                response = await inference(`${destination}/${encodeURIComponent(requestId)}`, {method: 'GET', headers});
                result = response.result;
                if (result?.status !== 'COMPLETED' && result?.status !== 'COMPLETE') {
                    throw imageResultError('TWiN Cloud image generation did not return a completed result.', result);
                }
            }
        }
        const returnedImages = asynchronous ? result?.output?.images : result?.data;
        if (!is.array(returnedImages)) {
            throw imageResultError('TWiN Cloud returned no image collection.', result);
        }
        const images = returnedImages.map(function retainImageDescriptor(image) {return {...image};});
        const format = result.output_format ?? outputFormat;
        const requestId = asynchronous ? result.request_id : undefined;
        await settleImageOperation(
            function observeImageResult() {return onResponse(result, id, false);},
            operationSignal
        );
        await progress('downloading', requestId);
        const completed = await Promise.all(images.map(async function materializeImage(image) {
            let blob;
            const mediaType = image.content_type
                ?? ({png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp'}[format])
                ?? 'application/octet-stream';
            if (is.string(image.b64_json)) {
                blob = await settleImageOperation(function decodeImageBase64() {
                    return new Blob([Uint8Array.from(atob(image.b64_json), function imageCode(character) {
                        return character.charCodeAt(0);
                    })], {type: mediaType});
                }, operationSignal);
            } else if (is.string(image.url) && image.url) {
                // Media URLs have their own delivery authority. Never forward the inference key.
                const download = await settleImageOperation(function downloadGeneratedImage() {
                    return fetch(image.url, {credentials: 'omit', signal: operationSignal});
                }, operationSignal);
                if (!download.ok) {
                    throw await settleImageOperation(function readImageDownloadError() {
                        return download.headers.get('content-type')?.includes('application/json')
                            ? download.json() : download.text();
                    }, operationSignal);
                }
                blob = await settleImageOperation(function readGeneratedImage() {return download.blob();}, operationSignal);
                if (!blob.type) blob = new Blob([blob], {type: mediaType});
            } else {
                throw imageResultError('TWiN Cloud returned an image without data or a URL.', image);
            }
            return {
                blob,
                mediaType: blob.type || mediaType,
                ...(image.width === undefined ? {} : {width: image.width}),
                ...(image.height === undefined ? {} : {height: image.height})
            };
        }));
        await progress('complete', requestId);
        if (operationSignal.aborted) throw normalizeAIRequestAbort(operationSignal.reason);
        return {images: completed};
    } catch (error) {
        if (isAIRequestAbort(error, operationSignal)) throw normalizeAIRequestAbort(error);
        throw error;
    } finally {
        signal?.removeEventListener('abort', cancelImageRequest);
        controller.abort('Image operation settled.');
    }
}

function imageResultError(message, result) {
    const error = new Error(message, {cause: result});
    error.code = 'ARCANE_AI_INVALID_PROVIDER_RESULT';
    return error;
}

/** Abort a wait even when a credential, callback, or host Fetch ignores the signal. */
function settleImageOperation(operation, signal) {
    return new Promise(function settleCloudImageOperation(resolve, reject) {
        let settled = false;
        function finish(error, value, failed) {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', cancelled);
            if (failed) reject(error);
            else resolve(value);
        }
        function cancelled() {finish(normalizeAIRequestAbort(signal.reason), undefined, true);}
        signal.addEventListener('abort', cancelled, {once: true});
        if (signal.aborted) {
            cancelled();
            return;
        }
        try {
            Promise.resolve(operation()).then(
                function accepted(value) {finish(undefined, value, false);},
                function rejected(error) {finish(error, undefined, true);}
            );
        } catch (error) {
            finish(error, undefined, true);
        }
    });
}

async function waitForImageStatus(delay, signal) {
    let remaining = delay;
    do {
        // Split only at the host timer range; retain the provider's entire delay.
        const milliseconds = Math.min(remaining, 2147483647);
        let timer;
        try {
            await settleImageOperation(function waitForImagePoll() {
                return new Promise(function scheduleImagePoll(finish) {timer = setTimeout(finish, milliseconds);});
            }, signal);
        } finally {
            clearTimeout(timer);
        }
        remaining -= milliseconds;
    } while (remaining > 0);
}

export function structuredOutputFormat(value = false){
    if(value === false || value === null || value === undefined){
        return null;
    }
    if(value === true || value === 'json'){
        return 'json';
    }
    if(
        is.object(value)
        && !is.array(value)
        && (
            Object.getPrototypeOf(value) === Object.prototype
            || Object.getPrototypeOf(value) === null
        )
    ){
        return value;
    }
    const error = new TypeError(
        'AI structured output must be enabled with true, json, or a JSON Schema object.'
    );
    error.code = 'AI_STRUCTURED_OUTPUT_INVALID';
    throw error;
}

export function openAIResponseFormat(format){
    if(format === 'json'){
        return {type:'json_object'};
    }
    if(format){
        return {
            type:'json_schema',
            json_schema:{name:'structured_response', strict:true, schema:format}
        };
    }
    return null;
}

/** Shared with browser streaming; consume no successful body at this boundary. */
export async function fetchHTTPResponse(url, options, {onRetry = null} = {}) {
    const {signal} = options;
    const retryDelayMs = 3000;
    const maxRecoveryRetries = 3;
    let recoveryRetries = 0;
    let attempt = 0;
    try {
        while (true) {
            if (signal?.aborted) {
                throw normalizeAIRequestAbort(signal.reason);
            }
            let response;
            let error;
            try {
                response = await fetch(url, options);
            } catch (fetchError) {
                if (isAIRequestAbort(fetchError, signal)) {
                    throw normalizeAIRequestAbort(fetchError);
                }
                error = fetchError;
            }
            if (signal?.aborted) {
                throw normalizeAIRequestAbort(signal.reason);
            }
            if (response?.ok) {
                return response;
            }
            const status = response?.status ?? null;
            if (response) {
                const contentType = response.headers.get('content-type') || '';
                try {
                    error = contentType.includes('application/json')
                        ? await response.json()
                        : await response.text();
                } catch (bodyError) {
                    if (status !== 529 || isAIRequestAbort(bodyError, signal)) {
                        throw bodyError;
                    }
                    error = bodyError;
                }
                if (signal?.aborted) {
                    throw normalizeAIRequestAbort(signal.reason);
                }
            }
            const message = is.string(error)
                ? error
                : error?.error?.message ?? error?.message;
            const overload = status === 429
                && is.string(message)
                && message.toLowerCase().includes('overload');
            if (!overload) {
                if ((status !== null && status !== 529)
                    || recoveryRetries >= maxRecoveryRetries) {
                    throw error;
                }
                recoveryRetries += 1;
            }
            attempt += 1;
            arcaneLogging.warn(
                `${message ?? 'AI request transport failed.'}\nRetrying in ${retryDelayMs / 1000} seconds`,
                error
            );
            observeRequestRetry(
                onRetry,
                {phase: 'waiting', attempt, delayMs: retryDelayMs, status, error}
            );
            await new Promise(
                function waitForRequestRetry(resolve, reject) {
                    function finishRetryDelay() {
                        signal?.removeEventListener('abort', cancelRetryDelay);
                        resolve();
                    }
                    function cancelRetryDelay() {
                        clearTimeout(timer);
                        signal.removeEventListener('abort', cancelRetryDelay);
                        reject(normalizeAIRequestAbort(signal.reason));
                    }
                    const timer = setTimeout(finishRetryDelay, retryDelayMs);
                    signal?.addEventListener(
                        'abort',
                        cancelRetryDelay,
                        {once: true}
                    );
                    if (signal?.aborted) {
                        cancelRetryDelay();
                    }
                }
            );
            if (signal?.aborted) {
                throw normalizeAIRequestAbort(signal.reason);
            }
            observeRequestRetry(
                onRetry,
                {phase: 'requesting', attempt, delayMs: retryDelayMs, status, error}
            );
        }
    } catch (error) {
        if (isAIRequestAbort(error, signal)) {
            throw normalizeAIRequestAbort(error);
        }
        throw error;
    }
}

function observeRequestRetry(onRetry, state) {
    if (!is.function(onRetry)) {
        return;
    }
    function reportRetryObserverFailure(error) {
        arcaneLogging.error('Arcane AI retry observer failed.', error);
    }
    try {
        Promise.resolve(
            onRetry(state)
        ).catch(reportRetryObserverFailure);
    } catch (error) {
        reportRetryObserverFailure(error);
    }
}

/** Return the entire parsed completion without selecting or rewriting choices. */
export async function fetchJSONResponse(url, options, {onRetry = null} = {}) {
    const {signal} = options;
    try{
        const response = await fetchHTTPResponse(
            url,
            options,
            {onRetry}
        );
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        const contentType = response.headers.get('content-type') || '';
        if(!contentType.includes('application/json')){
            throw new TypeError(
                `AI request returned ${contentType || 'an unknown content type'} instead of JSON.`
            );
        }
        const completion = await response.json();
        if(signal?.aborted){
            throw normalizeAIRequestAbort(signal.reason);
        }
        return completion;
    }catch(error){
        if(isAIRequestAbort(error, signal)){
            throw normalizeAIRequestAbort(error);
        }
        throw error;
    }
}
