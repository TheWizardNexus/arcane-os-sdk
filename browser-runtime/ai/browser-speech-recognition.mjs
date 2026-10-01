import Is from '../dependencies/strong-type/index.js';
import {arcaneLogging} from '../logging.mjs';

const is = new Is(false);

function recognitionError(message, code, cause) {
    const error = cause === undefined
        ? new Error(message)
        : new Error(
            message,
            {cause}
        );
    error.code = code;
    return error;
}

function recognitionConstructor() {
    if (is.function(globalThis.SpeechRecognition)) return globalThis.SpeechRecognition;
    if (is.function(globalThis.webkitSpeechRecognition)) return globalThis.webkitSpeechRecognition;
    return null;
}

function unavailableRecognition() {
    return recognitionError(
        'Native browser speech recognition is unavailable in this browser.',
        'ARCANE_AI_SPEECH_RECOGNITION_UNAVAILABLE'
    );
}

function assertIdentifier(value, label) {
    if (!is.string(value) || !value || value.trim() !== value) {
        throw new TypeError(`${label} must be a nonempty string without surrounding whitespace.`);
    }
}

/**
 * Browser-owned live recognition, which may use a remote recognition service.
 * Loading selects the capability; only capture.start() opens a native session.
 */
export function createBrowserSpeechRecognitionProvider(
    {id, model, language} = {}
) {
    assertIdentifier(id, 'Browser speech recognition provider id');
    assertIdentifier(model?.id, 'Browser speech recognition model id');
    if (language !== undefined && !is.string(language)) {
        throw new TypeError('Browser speech recognition language must be a string.');
    }

    const modelId = model.id;
    let state = 'unloaded';
    let generation = 0;
    let activeCapture = null;
    let unloadOperation = null;
    let disposeOperation = null;

    function authority() {
        return {
            protocol: 'arcane-ai-model-authority/1',
            providerId: id,
            modelId,
            role: 'stt',
            localOnly: false
        };
    }

    function assertSelection(selection) {
        if (selection && (selection.providerId !== id
            || selection.modelId !== modelId
            || selection.localOnly === true
            || (selection.role !== undefined && selection.role !== 'stt'))) {
            throw recognitionError(
                'The selected browser speech model does not match this provider.',
                'ARCANE_AI_MODEL_AUTHORITY_REQUIRED'
            );
        }
    }

    function assertContext(context) {
        if (context.role !== undefined && context.role !== 'stt') {
            throw recognitionError('This provider supports only STT.', 'ARCANE_AI_INVALID_REQUEST');
        }
        assertSelection(context.selection);
        if (context.signal?.aborted) {
            const error = recognitionError(
                'The browser speech operation was cancelled.',
                'ARCANE_AI_REQUEST_ABORTED',
                context.signal.reason
            );
            error.name = 'AbortError';
            throw error;
        }
    }

    function status() {
        const loaded = state === 'ready';
        return {
            providerId: id,
            role: 'stt',
            modelId,
            localOnly: false,
            state,
            loaded,
            busy: activeCapture !== null,
            execution: {
                requestedDevice: 'browser-native',
                selectedDevice: loaded ? 'browser-native' : null,
                maxConcurrentRequests: 1,
                activeRequestCount: activeCapture === null ? 0 : 1
            }
        };
    }

    function createCapture(
        {
            onSegment,
            onInterim,
            onState,
            onError,
            language: captureLanguage = language,
            continuous = true
        } = {}
    ) {
        const captureGeneration = generation;
        let recognizer = null;
        let signal = null;
        let started = false;
        let nativeStarted = false;
        let receivedStart = false;
        let stopping = false;
        let cancelled = false;
        let failed = false;
        let settled = false;
        let captureState = null;
        let lastFinalIndex = -1;
        let sequence = 0;
        let resolveStarted = null;
        let resolveDone;
        const done = new Promise(
            function waitForRecognitionEnd(resolve) {
                resolveDone = resolve;
            }
        );

        function reportError(error) {
            if (!is.function(onError)) {
                arcaneLogging.error('Browser speech recognition failed:', error);
                return;
            }
            try {
                const operation = onError(error);
                Promise.resolve(operation).catch(reportErrorCallbackFailure);
            } catch (callbackError) {
                reportErrorCallbackFailure(callbackError);
            }
        }

        function reportErrorCallbackFailure(error) {
            arcaneLogging.error('Browser speech recognition error handler failed:', error);
        }

        function observeCallbackFailure(error) {
            const callbackError = recognitionError(
                'A browser speech recognition callback failed.',
                'ARCANE_AI_SPEECH_CALLBACK_FAILED',
                error
            );
            if (settled || cancelled || failed) {
                reportError(callbackError);
                return;
            }
            interrupt(callbackError);
            abortNative();
        }

        function notify(callback, value) {
            if (!is.function(callback)) return;
            try {
                const operation = callback(value);
                Promise.resolve(operation).catch(observeCallbackFailure);
            } catch (error) {
                observeCallbackFailure(error);
            }
        }

        function publishState(nextState) {
            if (captureState === nextState) return;
            captureState = nextState;
            notify(onState, nextState);
        }

        function settleStarted(success) {
            if (!resolveStarted) return;
            const resolve = resolveStarted;
            resolveStarted = null;
            resolve(success);
        }

        function finish(success) {
            if (settled) return;
            settled = true;
            nativeStarted = false;
            signal?.removeEventListener('abort', cancel);
            signal = null;
            if (recognizer) {
                recognizer.onstart = null;
                recognizer.onresult = null;
                recognizer.onerror = null;
                recognizer.onend = null;
                recognizer = null;
            }
            if (activeCapture === capture) activeCapture = null;
            settleStarted(false);
            publishState(failed ? 'interrupted' : 'stopped');
            resolveDone(success);
        }

        function interrupt(error) {
            if (failed || settled) return;
            failed = true;
            settleStarted(false);
            reportError(error);
            publishState('interrupted');
        }

        function abortNative() {
            if (settled) return;
            if (!nativeStarted) {
                finish(false);
                return;
            }
            try {
                recognizer.abort();
            } catch (error) {
                const abortError = recognitionError(
                    'Native browser speech recognition could not be cancelled.',
                    'ARCANE_AI_SPEECH_RECOGNITION_ABORT_FAILED',
                    error
                );
                if (failed) reportError(abortError);
                else interrupt(abortError);
                // An unsuccessful abort is not evidence of native end. Keep
                // the session owned until the browser reports disconnection.
            }
        }

        function cancel() {
            if (settled || cancelled) return done;
            cancelled = true;
            settleStarted(false);
            abortNative();
            return done;
        }

        function recognitionStarted() {
            if (settled || cancelled || failed) return;
            receivedStart = true;
            if (!stopping) publishState('listening');
            settleStarted(!cancelled && !failed && !stopping);
        }

        function recognitionResults(event) {
            if (settled || cancelled || failed) return;
            try {
                for (let index = event.resultIndex; index < event.results.length; index += 1) {
                    if (settled || cancelled || failed) return;
                    const result = event.results[index];
                    if (!result.isFinal || index <= lastFinalIndex) continue;
                    lastFinalIndex = index;
                    sequence += 1;
                    notify(
                        onSegment,
                        {text: result[0].transcript, sequence}
                    );
                }
                if (settled || cancelled || failed) return;
                let text = '';
                // Native results retain their final prefix and replace only
                // interim entries. Do not revisit that growing final prefix.
                for (let index = lastFinalIndex + 1; index < event.results.length; index += 1) {
                    text += event.results[index][0].transcript;
                }
                notify(
                    onInterim,
                    {text}
                );
            } catch (error) {
                interrupt(
                    recognitionError(
                        'The browser speech recognition result could not be read.',
                        'ARCANE_AI_INVALID_PROVIDER_RESULT',
                        error
                    )
                );
                abortNative();
            }
        }

        function recognitionFailed(event) {
            if (settled || cancelled || failed) return;
            const error = recognitionError(
                event.message || `Native browser speech recognition failed: ${event.error}.`,
                'ARCANE_AI_SPEECH_RECOGNITION_FAILED',
                event
            );
            error.reason = event.error;
            interrupt(error);
        }

        function recognitionEnded() {
            finish(receivedStart && !cancelled && !failed);
        }

        function start(
            {signal: captureSignal} = {}
        ) {
            if (started || settled) return Promise.resolve(false);
            started = true;
            const starting = new Promise(
                function waitForRecognitionStart(resolve) {
                    resolveStarted = resolve;
                }
            );
            signal = captureSignal ?? null;
            if (signal?.aborted) {
                cancel();
                return starting;
            }
            try {
                if (state === 'disposed' || disposeOperation) {
                    throw recognitionError('The browser speech provider is disposed.', 'ARCANE_AI_PROVIDER_DISPOSED');
                }
                if (state !== 'ready' || unloadOperation || generation !== captureGeneration) {
                    throw recognitionError('The browser speech provider is not ready.', 'ARCANE_AI_NOT_READY');
                }
                if (activeCapture !== null) {
                    throw recognitionError('The browser speech provider is at capacity.', 'ARCANE_AI_PROVIDER_BUSY');
                }
                const Recognition = recognitionConstructor();
                if (!Recognition) throw unavailableRecognition();
                activeCapture = capture;
                recognizer = new Recognition();
                if (captureLanguage !== undefined) recognizer.lang = captureLanguage;
                recognizer.continuous = continuous;
                recognizer.interimResults = true;
                recognizer.maxAlternatives = 1;
                recognizer.onstart = recognitionStarted;
                recognizer.onresult = recognitionResults;
                recognizer.onerror = recognitionFailed;
                recognizer.onend = recognitionEnded;
                signal?.addEventListener(
                    'abort',
                    cancel,
                    {once: true}
                );
                publishState('starting');
                if (settled || cancelled || failed) return starting;
                nativeStarted = true;
                // This call stays in the initiating user gesture. No model
                // loading, permission preflight, or promise precedes it.
                recognizer.start();
            } catch (error) {
                interrupt(
                    recognitionError(
                        'Native browser speech recognition could not start.',
                        is.string(error?.code) ? error.code : 'ARCANE_AI_SPEECH_RECOGNITION_START_FAILED',
                        error
                    )
                );
                finish(false);
            }
            return starting;
        }

        function stop() {
            if (settled || stopping || cancelled || failed) return done;
            if (!started || !nativeStarted) return cancel();
            stopping = true;
            publishState('stopping');
            if (settled || cancelled || failed) return done;
            try {
                recognizer.stop();
            } catch (error) {
                interrupt(
                    recognitionError(
                        'Native browser speech recognition could not stop.',
                        'ARCANE_AI_SPEECH_RECOGNITION_STOP_FAILED',
                        error
                    )
                );
                abortNative();
            }
            return done;
        }

        const capture = {start, stop, cancel, destroy: cancel, done};
        return capture;
    }

    const provider = {
        protocol: 'arcane-ai-provider/2',
        role: 'stt',
        id,
        localOnly: false,
        maxConcurrentRequests: 1,

        catalog() {
            return [{id: modelId, providerId: id, role: 'stt', localOnly: false}];
        },

        async inspect(selection, context = {}) {
            assertContext(context);
            assertSelection(selection);
            if (state === 'disposed' || disposeOperation) {
                return {
                    available: false,
                    code: 'ARCANE_AI_PROVIDER_DISPOSED',
                    message: 'The browser speech provider is disposed.'
                };
            }
            if (!recognitionConstructor()) {
                const error = unavailableRecognition();
                return {available: false, code: error.code, message: error.message};
            }
            return {available: true, authority: authority()};
        },

        status,
        createCapture,

        async load(context = {}) {
            assertContext(context);
            if (state === 'disposed' || disposeOperation) {
                throw recognitionError('The browser speech provider is disposed.', 'ARCANE_AI_PROVIDER_DISPOSED');
            }
            if (unloadOperation) {
                throw recognitionError('The browser speech provider is unloading.', 'ARCANE_AI_OPERATION_SUPERSEDED');
            }
            if (!recognitionConstructor()) {
                state = 'error';
                throw unavailableRecognition();
            }
            state = 'ready';
            return status();
        },

        async request(context = {}) {
            assertContext(context);
            throw recognitionError(
                'Native browser speech recognition accepts live microphone capture only; arbitrary audio files cannot be transcribed.',
                'ARCANE_AI_SPEECH_INPUT_UNSUPPORTED'
            );
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
            const capture = activeCapture;
            unloadOperation = Promise.resolve(capture?.done).then(
                function finishRecognitionUnload() {
                    state = 'unloaded';
                    unloadOperation = null;
                    return status();
                }
            );
            capture?.cancel();
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
                function finishRecognitionDispose() {
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
