import Is from 'strong-type';
import {arcaneLogging} from '../logging.mjs';

const is = new Is(false);
const twinChatURL = 'https://inference.do-ai.run/v1/chat/completions';

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
            if (response) {
                const contentType = response.headers.get('content-type') || '';
                error = contentType.includes('application/json')
                    ? await response.json()
                    : await response.text();
                if (signal?.aborted) {
                    throw normalizeAIRequestAbort(signal.reason);
                }
            }
            const status = response?.status ?? null;
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
