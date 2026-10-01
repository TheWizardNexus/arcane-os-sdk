import Is from '../dependencies/strong-type/index.js';
import {arcaneLogging} from '../logging.mjs';

const is = new Is(false);
const synthesisQueues = new WeakMap();

function synthesisError(message, code, cause) {
    const error = cause === undefined ? new Error(message) : new Error(message, {cause});
    error.code = code;
    return error;
}

function cancelledSpeech(signal) {
    const error = synthesisError(
        'The browser speech operation was cancelled.',
        'ARCANE_AI_REQUEST_ABORTED',
        signal?.reason
    );
    error.name = 'AbortError';
    return error;
}

function synthesisCapability() {
    const synthesis = globalThis.speechSynthesis;
    const Utterance = globalThis.SpeechSynthesisUtterance;
    if (!synthesis || !is.function(Utterance)
        || !is.function(synthesis.getVoices) || !is.function(synthesis.speak)
        || !is.function(synthesis.cancel) || !is.function(synthesis.pause)
        || !is.function(synthesis.resume) || !is.function(synthesis.addEventListener)
        || !is.function(synthesis.removeEventListener)) return null;
    return {synthesis, Utterance};
}

function unavailableSynthesis() {
    return synthesisError(
        'Native browser speech synthesis is unavailable in this browser.',
        'ARCANE_AI_SPEECH_SYNTHESIS_UNAVAILABLE'
    );
}

function assertIdentifier(value, label) {
    if (!is.string(value) || !value || value.trim() !== value) {
        throw new TypeError(`${label} must be a nonempty string without surrounding whitespace.`);
    }
}

function assertSignal(signal) {
    if (signal !== null && (!is.boolean(signal?.aborted)
        || !is.function(signal?.addEventListener) || !is.function(signal?.removeEventListener))) {
        throw new TypeError('Browser speech signal must be an AbortSignal.');
    }
}

function observeCallback(callback, value) {
    if (!is.function(callback)) return;
    function reportObserverFailure(error) {
        arcaneLogging.error('Browser speech observer failed.', error);
    }
    try {
        Promise.resolve(callback(value)).catch(reportObserverFailure);
    } catch (error) {
        reportObserverFailure(error);
    }
}

function queueFor(synthesis) {
    let queue = synthesisQueues.get(synthesis);
    if (!queue) {
        queue = {active: null, pending: [], advancing: false};
        synthesisQueues.set(synthesis, queue);
    }
    return queue;
}

function advanceQueue(queue) {
    if (queue.advancing) return;
    queue.advancing = true;
    try {
        while (!queue.active && queue.pending.length) {
            const record = queue.pending.shift();
            if (record.settled) continue;
            queue.active = record;
            record.start();
        }
    } finally {
        queue.advancing = false;
    }
}

/** Browser-owned utterance playback. Preparing a request never speaks or creates audio. */
export function createBrowserSpeechSynthesisProvider({id, model, language} = {}) {
    assertIdentifier(id, 'Browser speech synthesis provider id');
    assertIdentifier(model?.id, 'Browser speech synthesis model id');
    if (language !== undefined && !is.string(language)) {
        throw new TypeError('Browser speech synthesis language must be a string.');
    }
    if (model.defaultVoice !== undefined && model.defaultVoice !== null
        && !is.string(model.defaultVoice)) {
        throw new TypeError('Browser speech synthesis default voice must be a string.');
    }

    const modelId = model.id;
    const modelName = model.name;
    const defaultVoice = model.defaultVoice || null;
    const playbacks = new Set();
    const catalogObservers = new Set();
    let catalogSource = null;
    let state = 'unloaded';
    let generation = 0;
    let unloadOperation = null;
    let disposeOperation = null;

    function assertOpen() {
        if (state === 'disposed' || disposeOperation) {
            throw synthesisError('The browser speech provider is disposed.', 'ARCANE_AI_PROVIDER_DISPOSED');
        }
        if (state === 'unloading' || unloadOperation) {
            throw synthesisError('The browser speech provider is unloading.', 'ARCANE_AI_OPERATION_SUPERSEDED');
        }
    }

    function assertSelection(selection) {
        if (selection && (selection.providerId !== id || selection.modelId !== modelId
            || selection.localOnly === true
            || (selection.role !== undefined && selection.role !== 'tts'))) {
            throw synthesisError(
                'The selected browser speech model does not match this provider.',
                'ARCANE_AI_MODEL_AUTHORITY_REQUIRED'
            );
        }
    }

    function assertContext(context) {
        if (context.role !== undefined && context.role !== 'tts') {
            throw synthesisError('This provider supports only TTS.', 'ARCANE_AI_INVALID_REQUEST');
        }
        assertSelection(context.selection);
        if (context.signal?.aborted) throw cancelledSpeech(context.signal);
    }

    function nativeVoices() {
        const synthesis = globalThis.speechSynthesis;
        return is.function(synthesis?.getVoices) ? Array.from(synthesis.getVoices()) : [];
    }

    function catalog() {
        return [{
            id: modelId,
            ...(modelName === undefined ? {} : {name: modelName}),
            providerId: id,
            role: 'tts',
            localOnly: false,
            defaultVoice,
            voices: nativeVoices().map(function describeNativeVoice(voice) {
                return {
                    id: voice.voiceURI,
                    name: voice.name,
                    lang: voice.lang,
                    default: voice.default,
                    localService: voice.localService
                };
            }),
            speech: {playback: 'native'}
        }];
    }

    function publishCatalog() {
        const current = catalog();
        for (const observer of catalogObservers) observeCallback(observer, current);
    }

    function detachCatalog() {
        catalogSource?.removeEventListener('voiceschanged', publishCatalog);
        catalogSource = null;
    }

    function subscribeCatalog(callback) {
        assertOpen();
        if (!is.function(callback)) throw new TypeError('Speech catalog subscription requires a function.');
        catalogObservers.add(callback);
        const synthesis = globalThis.speechSynthesis;
        if (!catalogSource && is.function(synthesis?.addEventListener)
            && is.function(synthesis?.removeEventListener)) {
            catalogSource = synthesis;
            catalogSource.addEventListener('voiceschanged', publishCatalog);
        }
        observeCallback(callback, catalog());
        let subscribed = true;
        return function unsubscribeCatalog() {
            if (!subscribed) return false;
            subscribed = false;
            catalogObservers.delete(callback);
            if (!catalogObservers.size) detachCatalog();
            return true;
        };
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
            // Preparation is immediate and remains available while native playback is active.
            busy: false,
            execution: {
                requestedDevice: 'browser-native',
                selectedDevice: loaded ? 'browser-native' : null,
                maxConcurrentRequests: 1,
                activeRequestCount: 0
            }
        };
    }

    function prepare(payload = {}, {signal = null} = {}) {
        assertOpen();
        assertSignal(signal);
        if (signal?.aborted) throw cancelledSpeech(signal);
        if (!is.string(payload.input) || !payload.input.trim()) {
            throw new TypeError('Browser speech synthesis requires nonempty input text.');
        }
        if (payload.model !== undefined && payload.model !== modelId) {
            throw synthesisError('The requested speech model does not match this provider.', 'ARCANE_AI_MODEL_AUTHORITY_REQUIRED');
        }
        const requestedVoice = payload.voice ?? defaultVoice;
        if (requestedVoice !== null && requestedVoice !== undefined && !is.string(requestedVoice)) {
            throw new TypeError('Browser speech voice must be a voiceURI string.');
        }
        const requestedLanguage = payload.language;
        if (requestedLanguage !== undefined && !is.string(requestedLanguage)) {
            throw new TypeError('Browser speech language must be a string.');
        }
        const speed = payload.speed ?? 1;
        if (!is.finite(speed) || speed <= 0) {
            throw new RangeError('Browser speech speed must be a positive finite number.');
        }
        const capability = synthesisCapability();
        if (!capability) throw unavailableSynthesis();
        const voices = nativeVoices();
        const defaultLanguage = requestedLanguage ?? language;
        const voice = requestedVoice
            ? voices.find(function findRequestedVoice(candidate) {
                return candidate.voiceURI === requestedVoice
                    && (!requestedLanguage || candidate.lang === requestedLanguage);
            })
            : voices.find(function findDefaultVoice(candidate) {
                return candidate.default && (!defaultLanguage || candidate.lang === defaultLanguage);
            });
        if (requestedVoice && !voice && voices.length) {
            throw synthesisError('The selected browser speech voice is unavailable.', 'ARCANE_AI_SPEECH_VOICE_UNAVAILABLE');
        }
        const preparedGeneration = generation;
        const input = payload.input;
        const selectedLanguage = requestedLanguage ?? voice?.lang ?? (requestedVoice ? '' : language) ?? '';
        const selectedVoice = requestedVoice || voice?.voiceURI || null;
        const descriptor = {
            kind: 'native-speech',
            input,
            voice: selectedVoice,
            language: selectedLanguage,
            speed,
            play(options = {}) {
                assertOpen();
                if (preparedGeneration !== generation) {
                    throw synthesisError('The prepared speech selection changed.', 'ARCANE_AI_OPERATION_SUPERSEDED');
                }
                return startPlayback(descriptor, capability, preparedGeneration, signal, options);
            }
        };
        return descriptor;
    }

    function startPlayback(descriptor, capability, preparedGeneration, preparationSignal, {signal = null, onState = null} = {}) {
        assertSignal(signal);
        if (onState !== null && !is.function(onState)) {
            throw new TypeError('Speech playback onState must be a function.');
        }
        const {synthesis, Utterance} = capability;
        const queue = queueFor(synthesis);
        const signals = new Set([preparationSignal, signal].filter(function suppliedSignal(value) { return value !== null; }));
        let playbackState = 'queued';
        let playbackError = null;
        let utterance = null;
        let voice = null;
        let waitingForVoices = false;
        let pausedByPlayback = false;
        let stopping = false;
        let completionSettled = false;
        let resolveFinished;
        let rejectFinished;
        let resolveReleased;
        const finished = new Promise(function capturePlaybackCompletion(resolve, reject) {
            resolveFinished = resolve;
            rejectFinished = reject;
        });
        finished.catch(function observePlaybackFailure() {});
        const released = new Promise(function capturePlaybackRelease(resolve) { resolveReleased = resolve; });
        const record = {settled: false, failure: null, released, start, stop};

        function publish(nextState, error = null) {
            playbackState = nextState;
            playbackError = error;
            observeCallback(onState, {state: nextState, error});
        }

        function finish(completed, error = null) {
            if (record.settled) return;
            record.settled = true;
            for (const requestSignal of signals) requestSignal.removeEventListener('abort', stop);
            if (waitingForVoices) synthesis.removeEventListener('voiceschanged', admitPlayback);
            waitingForVoices = false;
            if (utterance) {
                utterance.onstart = null;
                utterance.onend = null;
                utterance.onerror = null;
                utterance.onpause = null;
                utterance.onresume = null;
            }
            const pendingIndex = queue.pending.indexOf(record);
            if (pendingIndex >= 0) queue.pending.splice(pendingIndex, 1);
            if (queue.active === record) queue.active = null;
            playbacks.delete(record);
            const failure = error || record.failure;
            record.failure = failure;
            publish(failure ? 'error' : completed ? 'complete' : 'stopped', failure);
            if (!completionSettled) {
                completionSettled = true;
                if (failure) rejectFinished(failure);
                else resolveFinished(completed);
            }
            resolveReleased();
            advanceQueue(queue);
        }

        function retainPlaybackFailure(error) {
            record.failure = error;
            publish('error', error);
            if (!completionSettled) {
                completionSettled = true;
                rejectFinished(error);
            }
        }

        function stop() {
            if (record.settled || stopping) return false;
            if (queue.active === record && utterance) {
                stopping = true;
                // Web Speech cancellation is global; the SDK submits only its active utterance.
                const onend = utterance.onend;
                const onerror = utterance.onerror;
                utterance.onend = null;
                utterance.onerror = null;
                try {
                    synthesis.cancel();
                } catch (error) {
                    utterance.onend = onend;
                    utterance.onerror = onerror;
                    retainPlaybackFailure(synthesisError('Browser speech could not be stopped.', 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED', error));
                    stopping = false;
                    return false;
                }
                if (pausedByPlayback) {
                    pausedByPlayback = false;
                    try {
                        synthesis.resume();
                    } catch (error) {
                        finish(false, synthesisError('Browser speech could not resume after stopping.', 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED', error));
                        stopping = false;
                        return false;
                    }
                }
            }
            finish(false);
            stopping = false;
            return true;
        }

        function start() {
            if (record.settled) return;
            if (preparedGeneration !== generation || Array.from(signals).some(function signalAborted(requestSignal) { return requestSignal.aborted; })) {
                finish(false);
                return;
            }
            try {
                utterance = new Utterance(descriptor.input);
                utterance.voice = voice ?? null;
                utterance.lang = descriptor.language || voice?.lang || '';
                utterance.rate = descriptor.speed;
                utterance.onstart = function speechStarted() { if (!record.settled) publish('playing'); };
                utterance.onend = function speechEnded() { finish(true); };
                utterance.onerror = function speechFailed(event) {
                    if (record.settled) return;
                    const error = synthesisError('Browser speech playback failed.', 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED', event);
                    error.reason = event.error;
                    finish(false, error);
                };
                utterance.onpause = function speechPaused() { if (!record.settled) publish('paused'); };
                utterance.onresume = function speechResumed() { if (!record.settled) publish('playing'); };
                synthesis.speak(utterance);
            } catch (error) {
                finish(false, synthesisError('Browser speech playback could not start.', 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED', error));
            }
        }

        function admitPlayback() {
            if (record.settled) return;
            try {
                const voices = nativeVoices();
                voice = descriptor.voice
                    ? voices.find(function findPlaybackVoice(candidate) {
                        return candidate.voiceURI === descriptor.voice
                            && (!descriptor.language || candidate.lang === descriptor.language);
                    })
                    : voices.find(function findPlaybackDefault(candidate) {
                        return candidate.default && (!descriptor.language || candidate.lang === descriptor.language);
                    });
                if (descriptor.voice && !voice) {
                    if (voices.length) {
                        throw synthesisError('The selected browser speech voice is unavailable.', 'ARCANE_AI_SPEECH_VOICE_UNAVAILABLE');
                    }
                    if (!waitingForVoices) {
                        waitingForVoices = true;
                        synthesis.addEventListener('voiceschanged', admitPlayback);
                        publish('waiting-for-voices');
                    }
                    return;
                }
                if (waitingForVoices) synthesis.removeEventListener('voiceschanged', admitPlayback);
                waitingForVoices = false;
                queue.pending.push(record);
                advanceQueue(queue);
            } catch (error) {
                finish(false, error);
            }
        }

        const control = {
            finished,
            released,
            get state() { return playbackState; },
            get error() { return playbackError; },
            pause() {
                if (record.settled || queue.active !== record || !utterance) return false;
                try {
                    pausedByPlayback = true;
                    synthesis.pause();
                    return true;
                } catch (error) {
                    pausedByPlayback = false;
                    retainPlaybackFailure(synthesisError('Browser speech could not be paused.', 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED', error));
                    return false;
                }
            },
            resume() {
                if (record.settled || queue.active !== record || !utterance) return false;
                const wasPaused = pausedByPlayback;
                try {
                    pausedByPlayback = false;
                    synthesis.resume();
                    return true;
                } catch (error) {
                    pausedByPlayback = wasPaused;
                    retainPlaybackFailure(synthesisError('Browser speech could not resume.', 'ARCANE_AI_SPEECH_SYNTHESIS_FAILED', error));
                    return false;
                }
            },
            stop
        };
        playbacks.add(record);
        for (const requestSignal of signals) requestSignal.addEventListener('abort', stop, {once: true});
        publish('queued');
        if (Array.from(signals).some(function signalAborted(requestSignal) { return requestSignal.aborted; })) stop();
        if (!record.settled) admitPlayback();
        return control;
    }

    const provider = {
        protocol: 'arcane-ai-provider/2',
        role: 'tts',
        id,
        localOnly: false,
        maxConcurrentRequests: 1,
        catalog,
        subscribeCatalog,
        status,
        prepare,
        play(payload, options = {}) {
            return prepare(payload).play(options);
        },
        async inspect(selection, context = {}) {
            assertContext(context);
            assertSelection(selection);
            if (state === 'disposed' || disposeOperation) {
                return {available: false, code: 'ARCANE_AI_PROVIDER_DISPOSED', message: 'The browser speech provider is disposed.'};
            }
            if (!synthesisCapability()) {
                const error = unavailableSynthesis();
                return {available: false, code: error.code, message: error.message};
            }
            return {available: true, authority: {
                protocol: 'arcane-ai-model-authority/1',
                providerId: id,
                modelId,
                role: 'tts',
                localOnly: false
            }};
        },
        async load(context = {}) {
            assertContext(context);
            assertOpen();
            if (!synthesisCapability()) {
                state = 'error';
                throw unavailableSynthesis();
            }
            state = 'ready';
            return status();
        },
        async request(context = {}) {
            assertContext(context);
            assertOpen();
            if (state !== 'ready') {
                throw synthesisError('The browser speech provider is not loaded.', 'ARCANE_AI_ROLE_NOT_READY');
            }
            if (context.operation !== 'synthesize') {
                throw synthesisError('Browser speech synthesis requires the synthesize operation.', 'ARCANE_AI_INVALID_REQUEST');
            }
            return prepare(context.payload, {signal: context.signal ?? null});
        },
        unload(context = {}) {
            assertContext(context);
            if (state === 'disposed') return Promise.resolve(status());
            if (unloadOperation) return unloadOperation;
            state = 'unloading';
            generation += 1;
            const owned = Array.from(playbacks);
            unloadOperation = Promise.all(owned.map(function waitForOwnedPlayback(playback) { return playback.released; })).then(function finishSynthesisUnload() {
                const failures = owned.map(function playbackFailure(playback) { return playback.failure; }).filter(Boolean);
                state = failures.length ? 'error' : 'unloaded';
                unloadOperation = null;
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) throw new AggregateError(failures, 'Browser speech cleanup failed.');
                return status();
            });
            for (const playback of owned) playback.stop();
            return unloadOperation;
        },
        dispose(context = {}) {
            assertContext(context);
            if (state === 'disposed') return Promise.resolve(status());
            if (disposeOperation) return disposeOperation;
            detachCatalog();
            catalogObservers.clear();
            disposeOperation = provider.unload(context).then(function finishSynthesisDispose() {
                state = 'disposed';
                disposeOperation = null;
                return status();
            }, function failSynthesisDispose(error) {
                disposeOperation = null;
                throw error;
            });
            return disposeOperation;
        }
    };
    return provider;
}
