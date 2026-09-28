import Is from '../dependencies/strong-type/index.js';

const is = new Is(false);
const INVOKE_URL = 'https://inference.do-ai.run/v1/async-invoke';
const POLL_INTERVAL_MS = 1000;

function speechError(message, code, cause) {
    const error = cause === undefined
        ? new Error(message)
        : new Error(
            message,
            {cause}
        );
    error.code = code;
    return error;
}

function abortedSpeech(signal) {
    const error = speechError(
        'The cloud speech request was cancelled.',
        'ARCANE_AI_REQUEST_ABORTED',
        signal?.reason
    );
    error.name = 'AbortError';
    return error;
}

function assertNotAborted(signal) {
    if (signal?.aborted) throw abortedSpeech(signal);
}

function assertIdentifier(value, label) {
    if (!is.string(value) || !value || value.trim() !== value) {
        throw new TypeError(`${label} must be a nonempty string without surrounding whitespace.`);
    }
}

function waitForStatus(delay, signal) {
    assertNotAborted(signal);
    return new Promise(
        function waitForCloudSpeechStatus(resolve, reject) {
            const timer = setTimeout(finishStatusWait, delay);
            function finishStatusWait() {
                signal.removeEventListener('abort', cancelStatusWait);
                resolve();
            }
            function cancelStatusWait() {
                clearTimeout(timer);
                signal.removeEventListener('abort', cancelStatusWait);
                reject(abortedSpeech(signal));
            }
            signal.addEventListener(
                'abort',
                cancelStatusWait,
                {once: true}
            );
            if (signal.aborted) cancelStatusWait();
        }
    );
}

function retryAfterDelay(response) {
    const value = response.headers.get('Retry-After');
    if (!value?.trim()) return null;
    const seconds = Number(value);
    if (is.finite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(value);
    return is.finite(date) ? Math.max(0, date - Date.now()) : null;
}

async function requireSuccessfulResponse(response, signal, operation) {
    assertNotAborted(signal);
    if (response.ok) return response;
    const detail = await response.text();
    assertNotAborted(signal);
    throw speechError(
        `DigitalOcean speech ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : '.'}`,
        'ARCANE_AI_CLOUD_SPEECH_HTTP_ERROR'
    );
}

/**
 * A remote provider/2 TTS adapter. The application selects the model and voice,
 * and getApiKey returns its current credential or the application's existing
 * refresh promise. Credentials never enter status or configuration. The runtime
 * owns the FIFO queue; cancellation stops only this adapter's credential wait.
 */
export function createDigitalOceanFalTTSProvider({
    id,
    model,
    getApiKey,
    maxConcurrentRequests = 4,
    fetch: fetchImpl = globalThis.fetch
} = {}) {
    assertIdentifier(id, 'DigitalOcean speech provider id');
    assertIdentifier(model?.id, 'DigitalOcean speech model id');
    assertIdentifier(model?.defaultVoice, 'DigitalOcean speech default voice');
    if (!is.function(getApiKey)) {
        throw new TypeError('DigitalOcean speech getApiKey must be a function.');
    }
    if (!is.function(fetchImpl)) {
        throw new TypeError('DigitalOcean speech requires Fetch.');
    }
    if (!is.safeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1) {
        throw new RangeError('DigitalOcean speech maxConcurrentRequests must be a positive safe integer.');
    }

    const modelId = model.id;
    const defaultVoice = model.defaultVoice;
    const activeRequests = new Set();
    const credentialWaits = new Set();
    let state = 'unloaded';
    let generation = 0;
    let unloadOperation = null;
    let disposeOperation = null;

    function authority() {
        return {
            protocol: 'arcane-ai-model-authority/1',
            providerId: id,
            modelId,
            role: 'tts',
            localOnly: false
        };
    }

    function readApiKey(signal) {
        assertNotAborted(signal);
        return new Promise(
            function waitForCloudSpeechCredential(resolve, reject) {
                let settled = false;
                function finishCredentialWait() {
                    settled = true;
                    credentialWaits.delete(cancelCredentialWait);
                    signal?.removeEventListener('abort', cancelCredentialWait);
                }
                function rejectCredential(error) {
                    if (settled) return;
                    finishCredentialWait();
                    reject(error);
                }
                function acceptCredential(apiKey) {
                    if (settled) return;
                    if (!is.string(apiKey) || !apiKey.trim()) {
                        rejectCredential(
                            speechError(
                                'A DigitalOcean inference access key is required for cloud speech.',
                                'ARCANE_AI_CLOUD_SPEECH_KEY_REQUIRED'
                            )
                        );
                        return;
                    }
                    finishCredentialWait();
                    resolve(apiKey);
                }
                function cancelCredentialWait() {
                    rejectCredential(abortedSpeech(signal));
                }
                credentialWaits.add(cancelCredentialWait);
                signal?.addEventListener(
                    'abort',
                    cancelCredentialWait,
                    {once: true}
                );
                if (signal?.aborted) {
                    cancelCredentialWait();
                    return;
                }
                try {
                    Promise.resolve(getApiKey()).then(acceptCredential, rejectCredential);
                } catch (error) {
                    rejectCredential(error);
                }
            }
        );
    }

    function assertSelection(selection) {
        if (selection && (selection.providerId !== id
            || selection.modelId !== modelId
            || selection.localOnly === true
            || (selection.role !== undefined && selection.role !== 'tts'))) {
            throw speechError(
                'The selected cloud speech model does not match this provider.',
                'ARCANE_AI_MODEL_AUTHORITY_REQUIRED'
            );
        }
    }

    function assertContext(context) {
        if (context.role !== undefined && context.role !== 'tts') {
            throw speechError('This provider supports only TTS.', 'ARCANE_AI_INVALID_REQUEST');
        }
        assertSelection(context.selection);
        assertNotAborted(context.signal);
    }

    function status() {
        const loaded = state === 'ready';
        return {
            providerId: id,
            role: 'tts',
            modelId,
            localOnly: false,
            state,
            loaded,
            busy: activeRequests.size > 0,
            execution: {
                requestedDevice: 'remote',
                selectedDevice: loaded ? 'remote' : null,
                maxConcurrentRequests,
                activeRequestCount: activeRequests.size
            }
        };
    }

    async function synthesize(payload, controller, requestGeneration) {
        const signal = controller.signal;
        const apiKey = await readApiKey(signal);
        assertNotAborted(signal);
        const headers = {Authorization: `Bearer ${apiKey}`};
        const response = await fetchImpl(
            INVOKE_URL,
            {
                method: 'POST',
                headers: {...headers, 'Content-Type': 'application/json'},
                body: JSON.stringify(
                    {
                        model_id: modelId,
                        input: {
                            text: payload.input,
                            voice: payload.voice ?? defaultVoice,
                            speed: payload.speed ?? 1
                        }
                    }
                ),
                signal
            }
        );
        await requireSuccessfulResponse(response, signal, 'submission');
        let result = await response.json();
        assertNotAborted(signal);
        const requestId = result?.request_id;
        while (result?.status === 'QUEUED' || result?.status === 'IN_PROGRESS') {
            if (!is.string(requestId) || !requestId) {
                throw speechError(
                    'DigitalOcean speech returned a pending job without a request_id.',
                    'ARCANE_AI_INVALID_PROVIDER_RESULT'
                );
            }
            await waitForStatus(POLL_INTERVAL_MS, signal);
            let statusResponse;
            do {
                statusResponse = await fetchImpl(
                    `${INVOKE_URL}/${encodeURIComponent(requestId)}`,
                    {method: 'GET', headers, signal}
                );
                assertNotAborted(signal);
                const retryDelay = statusResponse.status === 429
                    ? retryAfterDelay(statusResponse)
                    : null;
                if (retryDelay === null) break;
                // Only status reads may be retried; submitting twice can create two paid jobs.
                await statusResponse.text();
                await waitForStatus(retryDelay, signal);
            } while (true);
            await requireSuccessfulResponse(statusResponse, signal, 'status read');
            result = await statusResponse.json();
            assertNotAborted(signal);
        }
        if (result?.status === 'FAILED') {
            throw speechError(
                `DigitalOcean speech generation failed: ${JSON.stringify(result)}`,
                'ARCANE_AI_CLOUD_SPEECH_GENERATION_FAILED'
            );
        }
        if (result?.status !== 'COMPLETED' || !is.string(result.output?.audio?.url)
            || !result.output.audio.url) {
            throw speechError(
                `DigitalOcean speech returned an unsupported result: ${JSON.stringify(result)}`,
                'ARCANE_AI_INVALID_PROVIDER_RESULT'
            );
        }
        assertNotAborted(signal);
        // The returned media URL has its own delivery authority; never forward the inference key.
        const audioResponse = await fetchImpl(
            result.output.audio.url,
            {signal}
        );
        await requireSuccessfulResponse(audioResponse, signal, 'audio download');
        const audio = await audioResponse.blob();
        assertNotAborted(signal);
        if (generation !== requestGeneration || state !== 'ready') {
            throw speechError(
                'The cloud speech result was superseded by a provider transition.',
                'ARCANE_AI_OPERATION_SUPERSEDED'
            );
        }
        return audio;
    }

    const provider = {
        protocol: 'arcane-ai-provider/2',
        role: 'tts',
        id,
        localOnly: false,
        maxConcurrentRequests,

        catalog() {
            return [
                {
                    id: modelId,
                    providerId: id,
                    role: 'tts',
                    localOnly: false,
                    defaultVoice,
                    speech: {responseFormats: ['provider-native'], defaultResponseFormat: 'provider-native'}
                }
            ];
        },

        async inspect(selection, context = {}) {
            assertContext(context);
            if (state === 'disposed' || disposeOperation) {
                return {
                    available: false,
                    code: 'ARCANE_AI_PROVIDER_DISPOSED',
                    message: 'The cloud speech provider is disposed.'
                };
            }
            assertSelection(selection);
            const inspectionGeneration = generation;
            await readApiKey(context.signal);
            assertNotAborted(context.signal);
            if (generation !== inspectionGeneration) {
                throw speechError('Cloud speech inspection was superseded.', 'ARCANE_AI_OPERATION_SUPERSEDED');
            }
            return {available: true, authority: authority()};
        },

        status,

        async load(context = {}) {
            assertContext(context);
            if (state === 'disposed' || disposeOperation) {
                throw speechError('The cloud speech provider is disposed.', 'ARCANE_AI_PROVIDER_DISPOSED');
            }
            if (unloadOperation) {
                throw speechError('The cloud speech provider is unloading.', 'ARCANE_AI_OPERATION_SUPERSEDED');
            }
            const loadGeneration = generation;
            if (state !== 'ready') state = 'loading';
            try {
                await readApiKey(context.signal);
                assertNotAborted(context.signal);
                if (generation !== loadGeneration) {
                    throw speechError('Cloud speech activation was superseded.', 'ARCANE_AI_OPERATION_SUPERSEDED');
                }
            } catch (error) {
                if (generation === loadGeneration && state === 'loading') state = 'unloaded';
                throw error;
            }
            state = 'ready';
            return status();
        },

        async request(context = {}) {
            assertContext(context);
            if (context.role !== 'tts' || context.operation !== 'synthesize') {
                throw speechError('Cloud speech supports only TTS synthesis.', 'ARCANE_AI_INVALID_REQUEST');
            }
            if (state !== 'ready' || unloadOperation || disposeOperation) {
                throw speechError('The cloud speech provider is not ready.', 'ARCANE_AI_NOT_READY');
            }
            if (activeRequests.size >= maxConcurrentRequests) {
                throw speechError('The cloud speech provider is at capacity.', 'ARCANE_AI_PROVIDER_BUSY');
            }
            const payload = context.payload;
            if (!is.string(payload?.input) || !payload.input.trim()) {
                throw new TypeError('Cloud speech input must be a nonempty string.');
            }
            if (payload.model !== undefined && payload.model !== modelId) {
                throw speechError('The requested cloud speech model differs from the selection.', 'ARCANE_AI_MODEL_AUTHORITY_REQUIRED');
            }
            if (payload.voice !== undefined) assertIdentifier(payload.voice, 'Cloud speech voice');
            if (payload.responseFormat !== undefined && payload.responseFormat !== 'provider-native') {
                throw speechError('Cloud speech returns the provider-native audio format.', 'ARCANE_AI_UNSUPPORTED_RESPONSE_FORMAT');
            }
            const speed = payload.speed ?? 1;
            if (!is.finite(speed) || speed < 0.7 || speed > 1.2) {
                const error = new RangeError('Cloud speech speed must be from 0.7 through 1.2.');
                error.code = 'ARCANE_AI_TTS_SPEED_INVALID';
                throw error;
            }

            const controller = new AbortController();
            function cancelCloudSpeechRequest() {
                controller.abort(context.signal.reason);
            }
            context.signal?.addEventListener(
                'abort',
                cancelCloudSpeechRequest,
                {once: true}
            );
            if (context.signal?.aborted) cancelCloudSpeechRequest();
            const request = {controller, promise: null};
            activeRequests.add(request);
            request.promise = synthesize(payload, controller, generation);
            try {
                return await request.promise;
            } catch (error) {
                if (controller.signal.aborted) throw abortedSpeech(controller.signal);
                throw error;
            } finally {
                context.signal?.removeEventListener('abort', cancelCloudSpeechRequest);
                activeRequests.delete(request);
            }
        },

        unload(context = {}) {
            assertContext(context);
            if (state === 'disposed') {
                return Promise.resolve(
                    status()
                );
            }
            if (unloadOperation) return unloadOperation;
            state = 'unloading';
            generation += 1;
            for (const cancelCredentialWait of [...credentialWaits]) cancelCredentialWait();
            const requests = [...activeRequests];
            for (const request of requests) request.controller.abort('Cloud speech provider unloaded.');
            unloadOperation = Promise.allSettled(
                requests.map(
                    function pendingCloudSpeechRequest(request) {
                        return request.promise;
                    }
                )
            ).then(
                function finishCloudSpeechUnload() {
                    state = 'unloaded';
                    unloadOperation = null;
                    return status();
                }
            );
            return unloadOperation;
        },

        dispose(context = {}) {
            assertContext(context);
            if (state === 'disposed') {
                return Promise.resolve(
                    status()
                );
            }
            if (disposeOperation) return disposeOperation;
            disposeOperation = provider.unload(context).then(
                function finishCloudSpeechDispose() {
                    state = 'disposed';
                    disposeOperation = null;
                    return status();
                }
            );
            return disposeOperation;
        }
    };
    return provider;
}
