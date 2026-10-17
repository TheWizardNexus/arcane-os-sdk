import Is from 'strong-type';
import {arcaneLogging} from 'arcane-os/logging';

const is = new Is(false);

/**
 * Browser microphone capture with activity-selected WAV clips or continuous PCM.
 * PCM callbacks settle in capture order without delaying the audio worklet.
 * stop() delivers the final active clip; cancel() abandons pending delivery.
 */
export default class ContinuousVoiceCapture {
    #options;
    #onSegment;
    #onError;
    #onState;
    #onPCM;
    #onActivity;
    #session = null;

    constructor(
        {
            preRollMs = 1500,
            quietMs = 2000,
            chunkMs = 30000,
            activityThreshold = 0.02,
            mode = 'segments',
            pcmChunkMs = 100,
            onSegment,
            onPCM,
            onActivity,
            onError,
            onState
        } = {}
    ) {
        if (!is.finite(preRollMs) || preRollMs < 0) {
            throw new RangeError('preRollMs must be a finite nonnegative duration.');
        }
        if (!is.finite(quietMs) || quietMs <= 0) {
            throw new RangeError('quietMs must be a finite positive duration.');
        }
        if (!is.finite(chunkMs) || chunkMs <= 0) {
            throw new RangeError('chunkMs must be a finite positive duration.');
        }
        if (!is.finite(activityThreshold) || activityThreshold < 0) {
            throw new RangeError('activityThreshold must be a finite nonnegative amplitude.');
        }
        if (!['segments', 'pcm'].includes(mode)) {
            throw new TypeError('Voice capture mode must be segments or pcm.');
        }
        if (!is.finite(pcmChunkMs) || pcmChunkMs <= 0) {
            throw new RangeError('pcmChunkMs must be a finite positive duration.');
        }
        this.#options = {preRollMs, quietMs, chunkMs, activityThreshold, mode, pcmChunkMs};
        this.#onSegment = onSegment;
        this.#onPCM = onPCM;
        this.#onActivity = onActivity;
        this.#onError = onError;
        this.#onState = onState;
    }

    async start(
        {
            mediaConstraints = {audio: true},
            sampleRate,
            signal
        } = {}
    ) {
        if (this.#session || signal?.aborted) return false;

        const session = {
            phase: 'starting',
            cancelled: false,
            settled: false,
            stream: null,
            context: null,
            source: null,
            node: null,
            cleanup: [],
            errors: [],
            pcmDelivery: Promise.resolve(),
            flushes: new Map(),
            flushSequence: 0,
            resolveStartup: null,
            resolveStop: null,
            rejectStop: null
        };
        session.startupCancelled = new Promise(
            function ownStartupCancellation(resolve) {
                session.resolveStartup = resolve;
            }
        );
        session.stopped = new Promise(
            function ownCaptureStop(resolve, reject) {
                session.resolveStop = resolve;
                session.rejectStop = reject;
            }
        );
        session.stopped.catch(function observeCaptureStopFailure() {});
        this.#session = session;

        const owner = this;
        try {
            if (signal) {
                function cancelAbortedCapture() {
                    if (owner.#session === session) owner.cancel();
                }
                signal.addEventListener(
                    'abort',
                    cancelAbortedCapture,
                    {once: true}
                );
                session.cleanup.push(
                    function removeCaptureAbortListener() {
                        signal.removeEventListener('abort', cancelAbortedCapture);
                    }
                );
            }
        } catch (error) {
            this.#fail(session, error);
            return false;
        }
        this.#notify(session, this.#onState, 'starting');
        if (!this.#starting(session)) return false;

        const preparation = this.#prepare(session, mediaConstraints, sampleRate);
        return Promise.race(
            [preparation, session.startupCancelled]
        );
    }

    stop() {
        const session = this.#session;
        if (!session) return Promise.resolve();
        if (session.settled || session.phase === 'stopping') return session.stopped;

        // Device release is synchronous and precedes the ordered worklet flush.
        const starting = session.phase === 'starting';
        session.phase = 'stopping';
        session.errors.push(...this.#releaseMicrophone(session));
        if (session.settled) return session.stopped;
        if (starting) {
            this.#settle(session, 'stopped');
            return session.stopped;
        }
        try {
            if (session.context.state !== 'running') {
                throw new Error('The audio context stopped before voice capture could flush.');
            }
            session.node.port.postMessage(
                {type: 'stop'}
            );
        } catch (error) {
            this.#fail(session, error);
        }
        return session.stopped;
    }

    cancel() {
        const session = this.#session;
        if (!session) return Promise.resolve();
        session.cancelled = true;
        this.#settle(session, 'stopped');
        return session.stopped;
    }

    flush() {
        const session = this.#session;
        if (!session || session.phase !== 'listening') return session?.pcmDelivery ?? Promise.resolve();
        session.flushSequence += 1;
        const id = session.flushSequence;
        const task = new Promise(function ownCaptureFlush(resolve, reject) {
            session.flushes.set(id, {resolve, reject});
        });
        try {
            session.node.port.postMessage({type: 'flush', id});
        } catch (error) {
            session.flushes.delete(id);
            this.#fail(session, error);
            return Promise.reject(error);
        }
        return task;
    }

    destroy() {
        return this.cancel();
    }

    #starting(session) {
        return this.#session === session && session.phase === 'starting';
    }

    async #prepare(session, mediaConstraints, sampleRate) {
        try {
            if (!is.function(globalThis.AudioContext)
                || !is.function(globalThis.AudioWorkletNode)
                || !is.function(globalThis.navigator?.mediaDevices?.getUserMedia)) {
                throw new Error('Continuous voice capture requires microphone access and AudioWorklet.');
            }
            const context = new globalThis.AudioContext(sampleRate === undefined ? undefined : {sampleRate});
            session.context = context;
            if (!context.audioWorklet) {
                throw new Error('This browser does not expose AudioWorklet microphone processing.');
            }

            const owner = this;
            function observeAudioContextState() {
                if (owner.#session !== session || session.phase === 'starting') return;
                if (context.state !== 'running') {
                    owner.#fail(
                        session,
                        new Error(`Continuous voice capture was interrupted: audio context ${context.state}.`)
                    );
                }
            }
            context.addEventListener('statechange', observeAudioContextState);
            session.cleanup.push(
                function removeAudioContextListener() {
                    context.removeEventListener('statechange', observeAudioContextState);
                }
            );

            // Resume starts within the user's gesture while independent loading
            // and microphone permission proceed. Only graph construction joins them.
            const acquisition = this.#acquire(session, mediaConstraints);
            const moduleReady = this.#loadWorklet(context);
            const resumed = this.#resume(context);
            await Promise.all(
                [acquisition, moduleReady, resumed]
            );
            if (!this.#starting(session)) return false;
            if (context.state !== 'running') {
                throw new Error('The audio context is not running after microphone preparation.');
            }

            const source = context.createMediaStreamSource(session.stream);
            session.source = source;
            const node = new globalThis.AudioWorkletNode(
                context,
                'arcane-continuous-voice-capture',
                {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                    channelCount: 1,
                    channelCountMode: 'explicit',
                    processorOptions: this.#options
                }
            );
            session.node = node;
            function receiveCaptureMessage(event) {
                if (owner.#session !== session || session.settled) return;
                try {
                    const message = event.data;
                    if (message.type === 'segment') {
                        const audio = new Blob(
                            [message.audio],
                            {type: 'audio/wav'}
                        );
                        owner.#notify(
                            session,
                            owner.#onSegment,
                            {
                                audio,
                                sequence: message.sequence,
                                reason: message.reason,
                                durationMs: message.durationMs
                            }
                        );
                    } else if (message.type === 'pcm') {
                        owner.#deliverPCM(session, {
                            samples: new Float32Array(message.audio),
                            sampleRate: message.sampleRate,
                            channels: 1,
                            sequence: message.sequence
                        });
                    } else if (message.type === 'activity') {
                        owner.#notify(session, owner.#onActivity, {
                            active: message.active,
                            audioTime: message.audioTime
                        });
                    } else if (message.type === 'flushed') {
                        const flush = session.flushes.get(message.id);
                        session.flushes.delete(message.id);
                        if (flush) session.pcmDelivery.then(flush.resolve, flush.reject);
                    } else if (message.type === 'stopped') {
                        owner.#settle(session, 'stopped');
                    } else if (message.type === 'error') {
                        owner.#fail(session, message.error);
                    }
                } catch (error) {
                    owner.#fail(session, error);
                }
            }
            function reportCaptureProcessorError(event) {
                owner.#fail(
                    session,
                    event.error ?? new Error(
                        'The voice capture audio worklet failed.',
                        {cause: event}
                    )
                );
            }
            function reportCaptureMessageError(event) {
                owner.#fail(
                    session,
                    new Error(
                        'A voice capture worklet message could not be received.',
                        {cause: event}
                    )
                );
            }
            node.port.addEventListener('message', receiveCaptureMessage);
            node.port.addEventListener('messageerror', reportCaptureMessageError);
            node.addEventListener('processorerror', reportCaptureProcessorError);
            session.cleanup.push(
                function removeWorkletListeners() {
                    node.port.removeEventListener('message', receiveCaptureMessage);
                    node.port.removeEventListener('messageerror', reportCaptureMessageError);
                    node.removeEventListener('processorerror', reportCaptureProcessorError);
                }
            );
            node.port.start();
            source.connect(node);
            node.connect(context.destination);
            session.phase = 'listening';
            this.#notify(session, this.#onState, 'listening');
            return this.#session === session && session.phase === 'listening';
        } catch (error) {
            if (this.#session === session) this.#fail(session, error);
            return false;
        }
    }

    async #acquire(session, mediaConstraints) {
        const stream = await globalThis.navigator.mediaDevices.getUserMedia(mediaConstraints);
        if (!this.#starting(session)) {
            for (const error of this.#stopTracks(stream)) {
                this.#reportError(session, error);
            }
            return;
        }
        session.stream = stream;
        const owner = this;
        function reportMicrophoneEnded(event) {
            owner.#interrupt(
                session,
                new Error(
                    'The microphone ended during continuous voice capture.',
                    {cause: event}
                )
            );
        }
        for (const track of stream.getAudioTracks()) {
            track.addEventListener(
                'ended',
                reportMicrophoneEnded,
                {once: true}
            );
            session.cleanup.push(
                function removeMicrophoneEndedListener() {
                    track.removeEventListener('ended', reportMicrophoneEnded);
                }
            );
            if (track.readyState === 'ended') {
                throw new Error('The selected microphone has already ended.');
            }
        }
    }

    async #loadWorklet(context) {
        await context.audioWorklet.addModule(
            new URL('./VoiceCaptureWorklet.js', import.meta.url)
        );
    }

    async #resume(context) {
        await context.resume();
    }

    #deliverPCM(session, value) {
        const owner = this;
        // Capture and inference run concurrently. This ordered delivery chain
        // retains every sample while the consumer catches up; no activity gate
        // selects or discards audio in continuous mode.
        session.pcmDelivery = session.pcmDelivery.then(async function deliverCapturedPCM() {
            if (!session.cancelled && is.function(owner.#onPCM)) {
                await owner.#onPCM(value);
            }
        });
        // Observe failure without converting the delivery/flush contract to success.
        session.pcmDelivery.catch(function reportPCMDeliveryFailure(error) {
            if (!session.settled) owner.#fail(session, error);
            else owner.#reportError(session, error, true);
        });
    }

    #notify(session, callback, value) {
        if (session.cancelled
            || (this.#session && this.#session !== session)
            || !is.function(callback)) return;
        const owner = this;
        function observeCallbackFailure(error) {
            if (owner.#session === session && !session.settled) {
                owner.#interrupt(session, error);
            } else {
                owner.#reportError(session, error, true);
            }
        }
        try {
            Promise.resolve(callback(value)).catch(observeCallbackFailure);
        } catch (error) {
            observeCallbackFailure(error);
        }
    }

    #reportError(session, error, terminal = false) {
        if (session.cancelled
            || (this.#session !== session && (!terminal || this.#session))
            || !is.function(this.#onError)) {
            arcaneLogging.error('Continuous voice capture failed:', error);
            return;
        }
        function observeErrorHandlerFailure(callbackError) {
            arcaneLogging.error('Continuous voice capture error handler failed:', callbackError);
        }
        try {
            Promise.resolve(this.#onError(error)).catch(observeErrorHandlerFailure);
        } catch (callbackError) {
            observeErrorHandlerFailure(callbackError);
        }
    }

    #fail(session, error) {
        if (this.#session !== session || session.settled) return;
        session.errors.push(error);
        this.#settle(session, 'interrupted');
    }

    #interrupt(session, error) {
        if (this.#session !== session || session.settled) return;
        session.errors.push(error);
        // A live worklet can still deliver the selected audio after device loss.
        // Its final message precedes the stop acknowledgment and error callback.
        this.stop();
    }

    #stopTracks(stream) {
        const errors = [];
        for (const track of stream?.getTracks() ?? []) {
            try {
                track.stop();
            } catch (error) {
                errors.push(error);
            }
        }
        return errors;
    }

    #releaseMicrophone(session) {
        const stream = session.stream;
        session.stream = null;
        const errors = this.#stopTracks(stream);
        if (session.source) {
            try {
                session.source.disconnect();
            } catch (error) {
                errors.push(error);
            }
            session.source = null;
        }
        return errors;
    }

    #settle(session, state) {
        if (session.settled) return;
        session.settled = true;
        session.phase = state;
        for (const cleanup of session.cleanup) {
            try {
                cleanup();
            } catch (error) {
                session.errors.push(error);
            }
        }
        session.cleanup = [];
        session.errors.push(...this.#releaseMicrophone(session));
        if (session.node) {
            try {
                session.node.disconnect();
            } catch (error) {
                session.errors.push(error);
            }
            try {
                session.node.port.close();
            } catch (error) {
                session.errors.push(error);
            }
        }
        const context = session.context;
        let contextClosing = Promise.resolve();
        if (context && context.state !== 'closed') {
            try {
                contextClosing = Promise.resolve(context.close());
            } catch (error) {
                session.errors.push(error);
            }
        }
        session.resolveStartup(false);
        for (const flush of session.flushes.values()) {
            if (session.errors.length) flush.reject(session.errors[0]);
            else session.pcmDelivery.then(flush.resolve, flush.reject);
        }
        session.flushes.clear();
        // stop() drains callbacks already accepted before the worklet's stop
        // acknowledgment. cancel() explicitly abandons subsequent delivery;
        // both operations join the context's actual asynchronous close.
        const owner = this;
        Promise.allSettled(
            [session.pcmDelivery, contextClosing]
        ).then(
            function finishCapturedCleanup(results) {
                for (const result of results) {
                    if (result.status === 'rejected' && !session.errors.includes(result.reason)) {
                        session.errors.push(result.reason);
                    }
                }
                if (owner.#session === session) owner.#session = null;
                if (session.errors.length) {
                    session.rejectStop(
                        session.errors.length === 1 ? session.errors[0] : new AggregateError(
                            session.errors,
                            'Voice capture delivery or cleanup failed.'
                        )
                    );
                } else {
                    session.resolveStop();
                }
                for (const error of session.errors) owner.#reportError(session, error, true);
                owner.#notify(session, owner.#onState, session.errors.length ? 'interrupted' : state);
            }
        );
    }
}
