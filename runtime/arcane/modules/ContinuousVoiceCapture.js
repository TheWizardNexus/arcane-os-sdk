import Is from 'strong-type';
import {arcaneLogging} from 'arcane-os/logging';

const is = new Is(false);

/**
 * Browser microphone capture with activity-selected, non-overlapping WAV clips.
 * Callbacks are observational and never delay the microphone or worklet.
 * stop() delivers the final active clip; cancel() abandons pending delivery.
 */
export default class ContinuousVoiceCapture {
    #options;
    #onSegment;
    #onError;
    #onState;
    #session = null;

    constructor(
        {
            preRollMs = 1500,
            quietMs = 2000,
            chunkMs = 30000,
            activityThreshold = 0.02,
            onSegment,
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
        this.#options = {preRollMs, quietMs, chunkMs, activityThreshold};
        this.#onSegment = onSegment;
        this.#onError = onError;
        this.#onState = onState;
    }

    async start(
        {
            mediaConstraints = {audio: true},
            signal
        } = {}
    ) {
        if ((this.#session && !this.#session.settled) || signal?.aborted) return false;

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
            resolveStartup: null,
            resolveStop: null
        };
        session.startupCancelled = new Promise(
            function ownStartupCancellation(resolve) {
                session.resolveStartup = resolve;
            }
        );
        session.stopped = new Promise(
            function ownCaptureStop(resolve) {
                session.resolveStop = resolve;
            }
        );
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

        const preparation = this.#prepare(session, mediaConstraints);
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
        if (!session) return;
        session.cancelled = true;
        this.#settle(session, 'stopped');
    }

    destroy() {
        this.cancel();
    }

    #starting(session) {
        return this.#session === session && session.phase === 'starting';
    }

    async #prepare(session, mediaConstraints) {
        try {
            if (!is.function(globalThis.AudioContext)
                || !is.function(globalThis.AudioWorkletNode)
                || !is.function(globalThis.navigator?.mediaDevices?.getUserMedia)) {
                throw new Error('Continuous voice capture requires microphone access and AudioWorklet.');
            }
            const context = new globalThis.AudioContext();
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
        if (context && context.state !== 'closed') {
            const owner = this;
            function observeContextCloseFailure(error) {
                owner.#reportError(session, error);
            }
            try {
                Promise.resolve(context.close()).catch(observeContextCloseFailure);
            } catch (error) {
                session.errors.push(error);
            }
        }
        session.resolveStartup(false);
        for (const error of session.errors) {
            this.#reportError(session, error, true);
        }
        this.#notify(session, this.#onState, session.errors.length ? 'interrupted' : state);
        if (this.#session === session) this.#session = null;
        session.resolveStop();
    }
}
