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
        stt: {engine: stt, operation: 'transcribe', state: null, loading: null, unsubscribe: null},
        tts: {engine: tts, operation: 'synthesize', state: null, loading: null, unsubscribe: null}
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
                stt: {...roles.stt.state, available: transcriptionAvailable},
                tts: {...roles.tts.state, available: synthesisAvailable}
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
        const task = Promise.resolve().then(
            async function loadSpeechEngine() {
                lifetimeSignal.throwIfAborted();
                await role.engine.load(
                    {signal: lifetimeSignal}
                );
                if (!closed) {
                    role.state = role.engine.current();
                    publish();
                }
            }
        );
        role.loading = task;
        task.then(
            function speechEngineLoaded() {
                role.loading = null;
            },
            function speechEngineLoadFailed(error) {
                role.loading = null;
                if (!closing) {
                    roleFailed(name, error);
                }
            }
        ).catch(
            function speechLoadObserverFailed(error) {
                console.error('Speech load state observer failed.', error);
            }
        );
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
            'speech.transcribe': function transcribe(parameters, request = {}) {
                return invoke('stt', parameters, request);
            },
            'speech.synthesize': function synthesize(parameters, request = {}) {
                return invoke('tts', parameters, request);
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

export default createSpeechService;
