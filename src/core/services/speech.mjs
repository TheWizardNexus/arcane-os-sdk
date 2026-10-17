import Is from 'strong-type';
import {createArcaneEventSource} from '../../event-manager.mjs';
import {CoreError, serializeCoreError} from '../../../browser-runtime/core/contracts.mjs';

const is = new Is(false);

function failure(code, message) {
    return new CoreError(
        {code, message}
    );
}

function waitForLoad(task, signal) {
    signal.throwIfAborted();
    return new Promise(
        function awaitSpeechLoad(resolve, reject) {
            function cancelled() {
                signal.removeEventListener('abort', cancelled);
                reject(signal.reason);
            }
            signal.addEventListener(
                'abort',
                cancelled,
                {once: true}
            );
            task.then(
                function loaded(value) {
                    signal.removeEventListener('abort', cancelled);
                    if (signal.aborted) {
                        reject(signal.reason);
                    } else {
                        resolve(value);
                    }
                },
                function loadFailed(error) {
                    signal.removeEventListener('abort', cancelled);
                    reject(error);
                }
            );
        }
    );
}

/** Hosts supply selected engines; this service owns their independent lifetimes. */
export function createSpeechService({stt, tts, signal} = {}) {
    const roles = {
        stt: {engine: stt, operation: 'transcribe', state: null, loading: null, changing: null, unsubscribe: null},
        tts: {engine: tts, operation: 'synthesize', state: null, loading: null, changing: null, unsubscribe: null}
    };
    for (const [name, role] of Object.entries(roles)) {
        if (role.engine == null) {
            role.state = {providerId: '', modelId: null, state: 'unavailable', loaded: false, busy: false};
            continue;
        }
        for (const method of ['current', 'subscribe', 'load', 'close', role.operation]) {
            if (!is.function(role.engine[method])) {
                throw new TypeError(`The ${name} speech engine requires ${method}().`);
            }
        }
        role.state = role.engine.current();
    }

    const lifetime = new AbortController();
    const lifetimeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    const owner = {};
    const events = createArcaneEventSource(
        owner,
        {source: 'core-speech', eventTypes: ['speech.state']}
    );
    const jobs = new Set();
    const streams = new Map();
    const syntheses = new Map();
    const publications = [];
    let context;
    let started = false;
    let publishing = false;
    let closing = null;
    let closed = false;

    function available(role) {
        return started && !closing && !closed && role.state.loaded === true
            && (role.state.state === 'ready' || role.state.state === 'running');
    }

    function current() {
        const transcriptionAvailable = available(roles.stt);
        const synthesisAvailable = available(roles.tts);
        return {
            ready: transcriptionAvailable && synthesisAvailable,
            synthesisAvailable,
            transcriptionAvailable,
            status: closed ? 'closed' : closing ? 'closing' : started ? 'ok' : 'created',
            ttsEngine: roles.tts.state.providerId ?? '',
            sttEngine: roles.stt.state.providerId ?? '',
            roles: {
                stt: {...roles.stt.state, available: transcriptionAvailable,
                    supportsStreaming: is.function(roles.stt.engine?.openStream)},
                tts: {...roles.tts.state, available: synthesisAvailable,
                    supportsStreaming: is.function(roles.tts.engine?.synthesizeStream)}
            },
            closed
        };
    }

    function publish() {
        publications.push(current());
        if (publishing) {
            return;
        }
        publishing = true;
        try {
            // A listener may close the service. Finish this snapshot before
            // publishing the lifecycle change that listener caused.
            while (publications.length) {
                const snapshot = publications.shift();
                events.dispatch('speech.state', snapshot);
                context?.emit('speech.state', snapshot);
            }
        } finally {
            publishing = false;
        }
    }

    function roleFailed(name, error) {
        const role = roles[name];
        role.state = {...role.state, state: 'error', error: serializeCoreError(error)};
        console.error(`The ${name} speech engine failed.`, error);
        publish();
    }

    function observeRoleTask(name, task, startup = false) {
        const role = roles[name];
        role.changing = task;
        // Explicit load cancellation belongs to that caller's wait, not another
        // inference request. Only the service-owned startup is a shared wait.
        role.loading = startup ? task : null;
        jobs.add(task);
        function settled(error, failed) {
            jobs.delete(task);
            // An older startup or activation must not replace the selected state.
            if (role.loading === task) role.loading = null;
            if (role.changing !== task) return;
            role.changing = null;
            if (closed) return;
            if (failed && startup && !closing) {
                roleFailed(name, error);
            } else {
                role.state = role.engine.current();
                publish();
            }
        }
        task.then(
            function speechRoleSettled() { settled(undefined, false); },
            function speechRoleFailed(error) { settled(error, true); }
        ).catch(function speechRoleObserverFailed(error) {
            console.error('Speech role state observer failed.', error);
        });
        return task;
    }

    function startRole(name) {
        const role = roles[name];
        if (!role.engine || closing) {
            return;
        }
        try {
            role.unsubscribe = role.engine.subscribe(
                function speechEngineChanged(state) {
                    if (!closed) {
                        role.state = state;
                        publish();
                    }
                }
            );
        } catch (error) {
            roleFailed(name, error);
            return;
        }
        // Replay can synchronously select an activation or close the service.
        if (role.changing || closing || closed) return;
        const task = Promise.resolve().then(
            async function loadSpeechEngine() {
                lifetimeSignal.throwIfAborted();
                if (role.changing !== task) return;
                return role.engine.load(
                    {signal: lifetimeSignal}
                );
            }
        );
        observeRoleTask(name, task, true);
    }

    function changeRole(operation, parameters, request) {
        if (closing || closed) {
            throw failure('CORE_CLOSING', 'The speech service is closing.');
        }
        if (!parameters || !is.object(parameters) || is.array(parameters)
            || !['stt', 'tts'].includes(parameters.role)) {
            throw failure('SPEECH_ROLE_INVALID', 'Select the stt or tts speech role.');
        }
        const {role: name, ...selection} = parameters;
        const role = roles[name];
        const operationSignal = request.signal
            ? AbortSignal.any([lifetimeSignal, request.signal]) : lifetimeSignal;
        operationSignal.throwIfAborted();
        if (!role.engine) {
            throw failure('SPEECH_ENGINE_UNAVAILABLE', `No ${name} speech engine is configured.`);
        }
        if (!is.function(role.engine[operation])) {
            throw failure('SPEECH_OPERATION_UNAVAILABLE', `The ${name} speech engine does not support ${operation}().`);
        }
        let acknowledgementFailed = false;
        let acknowledgementError;
        const task = Promise.resolve().then(async function changeSpeechRole() {
            if (acknowledgementFailed) throw acknowledgementError;
            operationSignal.throwIfAborted();
            const result = await role.engine[operation]({...selection, signal: operationSignal});
            operationSignal.throwIfAborted();
            return result;
        });
        // Retain ownership before an acknowledgement observer can close or reenter.
        observeRoleTask(name, task);
        try {
            request.emit?.('speech.progress', {
                requestId: request.requestId, role: name, operation,
                status: 'Thinking', progress: {phase: 'accepted'}
            });
        } catch (error) {
            acknowledgementFailed = true;
            acknowledgementError = error;
        }
        return task;
    }

    function invoke(name, parameters, request) {
        if (closing || closed) {
            throw failure('CORE_CLOSING', 'The speech service is closing.');
        }
        const role = roles[name];
        const operationSignal = request.signal
            ? AbortSignal.any([lifetimeSignal, request.signal]) : lifetimeSignal;
        operationSignal.throwIfAborted();
        if (!role.engine) {
            throw failure('SPEECH_ENGINE_UNAVAILABLE', `No ${name} speech engine is configured.`);
        }
        request.emit?.(
            'speech.progress',
            {requestId: request.requestId, role: name, status: 'Thinking', progress: {phase: 'accepted'}}
        );
        const task = (async function invokeSpeechEngine() {
            if (role.loading) {
                await waitForLoad(role.loading, operationSignal);
            }
            operationSignal.throwIfAborted();
            const result = await role.engine[role.operation](
                parameters,
                {
                    signal: operationSignal,
                    requestId: request.requestId,
                    onProgress(progress) {
                        if (!operationSignal.aborted) {
                            request.emit?.(
                                'speech.progress',
                                {requestId: request.requestId, role: name, status: 'Thinking', progress}
                            );
                        }
                    }
                }
            );
            operationSignal.throwIfAborted();
            return result;
        })();
        jobs.add(task);
        function speechRequestSettled() {
            jobs.delete(task);
        }
        task.then(speechRequestSettled, speechRequestSettled);
        return task;
    }

    function notifyListener(listener, state) {
        const result = listener(state);
        if (result && is.function(result.then)) {
            Promise.resolve(result).catch(
                function speechListenerFailed(error) {
                    console.error('Speech state listener failed.', error);
                }
            );
        }
    }

    function streamRole(name, operation, request, streamId) {
        if (closing || closed) throw failure('CORE_CLOSING', 'The speech service is closing.');
        const role = roles[name];
        if (!is.function(role.engine?.[operation])) {
            throw failure('SPEECH_OPERATION_UNAVAILABLE', `The ${name} speech engine does not support ${operation}().`);
        }
        const operationSignal = request.signal
            ? AbortSignal.any([lifetimeSignal, request.signal]) : lifetimeSignal;
        operationSignal.throwIfAborted();
        request.emit?.('speech.progress', {
            streamId, requestId: request.requestId, role: name, status: 'Thinking', progress: {phase: 'accepted'}
        });
        return {role, operationSignal};
    }

    function retainStreamTask(task) {
        jobs.add(task);
        function releaseSpeechStreamTask() { jobs.delete(task); }
        task.then(releaseSpeechStreamTask, releaseSpeechStreamTask);
        return task;
    }

    function openStream({streamId, options = {}} = {}, request) {
        const activation = streamRole('stt', 'openStream', request, streamId);
        const role = activation.role;
        const controller = new AbortController();
        const operationSignal = AbortSignal.any([activation.operationSignal, controller.signal]);
        if (!is.string(streamId) || !streamId) throw new TypeError('A speech stream requires a streamId.');
        if (streams.has(streamId)) throw failure('SPEECH_STREAM_ACTIVE', 'The speech stream is already open.');
        const record = {stream: null, controller, queue: Promise.resolve(), ending: false, cancellation: null, task: null};
        streams.set(streamId, record);

        function cancelNativeStream() {
            record.ending = true;
            if (record.stream && !record.cancellation) {
                record.cancellation = Promise.resolve().then(function cancelOwnedNativeStream() {
                    return record.stream.cancel();
                });
            }
            return record.cancellation;
        }
        function abortedStream() {
            cancelNativeStream()?.catch(function reportNativeStreamCancellation(error) {
                console.error('Native speech stream cancellation failed.', error);
            });
        }
        record.cancel = cancelNativeStream;
        operationSignal.addEventListener('abort', abortedStream, {once: true});
        const task = (async function ownTranscriptionStream() {
            try {
                if (role.loading) await waitForLoad(role.loading, operationSignal);
                operationSignal.throwIfAborted();
                record.stream = await role.engine.openStream({
                    ...options,
                    signal: operationSignal,
                    onUpdate: function reportTranscriptionUpdate(result) {
                        if (!operationSignal.aborted) request.emit?.('speech.transcription', {streamId, result});
                    }
                });
                if (operationSignal.aborted) {
                    await cancelNativeStream();
                    operationSignal.throwIfAborted();
                }
                request.emit?.('speech.opened', {
                    streamId,
                    ...(options.sampleRate === undefined ? {} : {sampleRate: options.sampleRate})
                });
                const result = await record.stream.completion;
                operationSignal.throwIfAborted();
                return result;
            } catch (error) {
                try { await cancelNativeStream(); } catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], 'Speech stream and cleanup failed.');
                }
                throw error;
            } finally {
                operationSignal.removeEventListener('abort', abortedStream);
                if (streams.get(streamId) === record) streams.delete(streamId);
            }
        })();
        record.task = task;
        return retainStreamTask(task);
    }

    function streamOperation(operation, {streamId, audio} = {}, request) {
        request.signal?.throwIfAborted();
        const record = streams.get(streamId);
        if (operation === 'cancel') {
            if (!record) return {streamId, cancelled: true};
            record.controller.abort();
            return record.task.then(
                function streamFinishedBeforeCancellation() { return {streamId, cancelled: true}; },
                function streamCancellationSettled(error) {
                    if (error?.name !== 'AbortError') throw error;
                    return {streamId, cancelled: true};
                }
            );
        }
        if (!record?.stream) throw failure('SPEECH_STREAM_UNAVAILABLE', 'The speech stream is not open.');
        if (record.ending) throw failure('SPEECH_STREAM_ENDING', 'The speech stream is finishing.');
        if (operation === 'finish') record.ending = true;
        const task = record.queue.then(function performSpeechStreamOperation() {
            request.signal?.throwIfAborted();
            if (operation === 'push') return record.stream.push(decodeFloatAudio(audio));
            return record.stream[operation]();
        });
        record.queue = task;
        task.catch(function cancelFailedStreamOperation() {
            record.cancel()?.catch(function reportStreamOperationCleanup(error) {
                console.error('Failed speech stream cleanup failed.', error);
            });
        });
        return retainStreamTask(task);
    }

    function synthesizeStream({streamId, request: payload} = {}, request) {
        const activation = streamRole('tts', 'synthesizeStream', request, streamId);
        const role = activation.role;
        const controller = new AbortController();
        const operationSignal = AbortSignal.any([activation.operationSignal, controller.signal]);
        if (!is.string(streamId) || !streamId) throw new TypeError('Speech synthesis requires a streamId.');
        if (syntheses.has(streamId)) throw failure('SPEECH_STREAM_ACTIVE', 'The speech synthesis is already active.');
        const record = {controller, task: null, sequence: 0, acknowledgements: new Map()};
        syntheses.set(streamId, record);
        function cancelAudioDelivery() {
            for (const acknowledgement of record.acknowledgements.values()) acknowledgement.reject(operationSignal.reason);
            record.acknowledgements.clear();
        }
        operationSignal.addEventListener('abort', cancelAudioDelivery, {once: true});
        const task = (async function ownSynthesisStream() {
            try {
                if (role.loading) await waitForLoad(role.loading, operationSignal);
                operationSignal.throwIfAborted();
                const result = await role.engine.synthesizeStream(payload, {
                    signal: operationSignal,
                    requestId: request.requestId,
                    onProgress: function reportSynthesisProgress(progress) {
                        if (!operationSignal.aborted) request.emit?.('speech.progress', {
                            streamId, requestId: request.requestId, role: 'tts', status: 'Thinking', progress
                        });
                    },
                    onAudio: async function reportSynthesisAudio(audio) {
                        operationSignal.throwIfAborted();
                        const sequence = ++record.sequence;
                        const consumed = new Promise(function waitForAudioConsumer(resolve, reject) {
                            record.acknowledgements.set(sequence, {resolve, reject});
                        });
                        // The native producer waits here, never the event parser.
                        // Cancellation releases this wait before joining native work.
                        try {
                            const pcm = audio.pcm;
                            const encoded = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
                            request.emit?.('speech.audio', {
                                streamId, sequence,
                                audio: {...audio, pcm: {encoding: 'base64', data: encoded.toString('base64')}}
                            });
                            await consumed;
                            operationSignal.throwIfAborted();
                        } finally {
                            record.acknowledgements.delete(sequence);
                        }
                    }
                });
                operationSignal.throwIfAborted();
                return result;
            } finally {
                operationSignal.removeEventListener('abort', cancelAudioDelivery);
                if (syntheses.get(streamId) === record) syntheses.delete(streamId);
            }
        })();
        record.task = task;
        return retainStreamTask(task);
    }

    function synthesisControl(operation, {streamId, sequence} = {}, request) {
        request.signal?.throwIfAborted();
        const record = syntheses.get(streamId);
        if (operation === 'cancel') {
            if (!record) return {streamId, cancelled: true};
            record.controller.abort();
            return record.task.then(
                function synthesisFinishedBeforeCancellation() { return {streamId, cancelled: true}; },
                function synthesisCancellationSettled(error) {
                    if (error !== record.controller.signal.reason) throw error;
                    return {streamId, cancelled: true};
                }
            );
        }
        const acknowledgement = record?.acknowledgements.get(sequence);
        if (!acknowledgement) throw failure('SPEECH_AUDIO_UNAVAILABLE', 'That speech audio contribution is not awaiting consumption.');
        record.acknowledgements.delete(sequence);
        acknowledgement.resolve();
        return {streamId, sequence};
    }

    function subscribe(listener, {replay = true, signal: subscriptionSignal} = {}) {
        if (!is.function(listener)) {
            throw new TypeError('A speech state listener must be a function.');
        }
        if (closed) {
            if (replay && !subscriptionSignal?.aborted) {
                notifyListener(listener, current());
            }
            return function closedSubscription() {};
        }
        const unsubscribe = events.on(
            'speech.state',
            function speechStateChanged(event) {
                notifyListener(listener, event.detail);
            },
            {signal: subscriptionSignal}
        );
        try {
            if (replay && !subscriptionSignal?.aborted) {
                notifyListener(listener, current());
            }
        } catch (error) {
            unsubscribe();
            throw error;
        }
        return unsubscribe;
    }

    function close() {
        if (closing) {
            return closing;
        }
        closing = Promise.resolve().then(
            async function closeSpeechService() {
                const shutdowns = Object.entries(roles).map(
                    async function closeSpeechEngine([name, role]) {
                        if (!role.engine) {
                            return;
                        }
                        try {
                            await role.engine.close();
                            role.state = role.engine.current();
                        } catch (error) {
                            roleFailed(name, error);
                            throw error;
                        } finally {
                            role.unsubscribe?.();
                        }
                    }
                );
                const loading = Object.values(roles).map(
                    function speechLoadTask(role) {
                        return role.loading;
                    }
                ).filter(Boolean);
                const results = await Promise.allSettled([...shutdowns, ...loading, ...jobs]);
                lifetimeSignal.removeEventListener('abort', abortService);
                closed = true;
                publish();
                const failures = [];
                for (let index = 0; index < shutdowns.length; index += 1) {
                    if (results[index].status === 'rejected') {
                        failures.push(results[index].reason);
                    }
                }
                if (failures.length) {
                    throw new AggregateError(failures, 'Speech service shutdown failed.');
                }
                return current();
            }
        );
        lifetime.abort();
        publish();
        return closing;
    }

    function abortService() {
        close().catch(
            function speechShutdownFailed(error) {
                console.error('Speech service shutdown failed.', error);
            }
        );
    }

    lifetimeSignal.addEventListener(
        'abort',
        abortService,
        {once: true}
    );

    return {
        name: 'speech',
        current,
        subscribe,
        close,
        start(currentContext) {
            if (started || closing) {
                return;
            }
            context = currentContext;
            if (lifetimeSignal.aborted) {
                abortService();
                return;
            }
            started = true;
            startRole('stt');
            startRole('tts');
            publish();
        },
        methods: {
            'speech.status': current,
            'speech.load': function load(parameters, request = {}) {
                return changeRole('load', parameters, request);
            },
            'speech.unload': function unload(parameters, request = {}) {
                return changeRole('unload', parameters, request);
            },
            'speech.transcribe': function transcribe(parameters, request = {}) {
                return invoke('stt', parameters, request);
            },
            'speech.synthesize': function synthesize(parameters, request = {}) {
                return invoke('tts', parameters, request);
            },
            // The open call stays pending so normal connection cancellation owns
            // the native stream; controls never extend it to service lifetime.
            'speech.open': openStream,
            'speech.push': function push(parameters, request) {
                return streamOperation('push', parameters, request);
            },
            'speech.endpoint': function endpoint(parameters, request) {
                return streamOperation('forceEndpoint', parameters, request);
            },
            'speech.finish': function finish(parameters, request) {
                return streamOperation('finish', parameters, request);
            },
            'speech.cancel': function cancel(parameters, request) {
                return streamOperation('cancel', parameters, request);
            },
            'speech.synthesizeStream': synthesizeStream,
            'speech.audioConsumed': function audioConsumed(parameters, request) {
                return synthesisControl('consumed', parameters, request);
            },
            'speech.cancelSynthesis': function cancelSynthesis(parameters, request) {
                return synthesisControl('cancel', parameters, request);
            }
        },
        drain: close,
        async dispose() {
            try {
                await close();
            } finally {
                events.dispose();
            }
        }
    };
}

function decodeFloatAudio(audio) {
    if (audio?.encoding !== 'f32le' || !is.string(audio.data)) {
        throw new TypeError('Core streaming audio requires {encoding: "f32le", data: BASE64}.');
    }
    const encoded = Buffer.from(audio.data, 'base64');
    if (encoded.length % 4 !== 0) throw new TypeError('The f32le transport ends during a sample.');
    const samples = new Float32Array(encoded.length / 4);
    const bits = new Uint32Array(samples.buffer);
    for (let index = 0; index < samples.length; index += 1) bits[index] = encoded.readUInt32LE(index * 4);
    return samples;
}

export default createSpeechService;
