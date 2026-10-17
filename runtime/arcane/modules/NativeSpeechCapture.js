import ContinuousVoiceCapture from './ContinuousVoiceCapture.js';

/**
 * One microphone lifetime and one scoped Core ASR stream.
 * Recognition callbacks receive (result, {requestStop}). They request a drain
 * without awaiting it, then return; the external owner joins stop() or done.
 * Awaiting outer stop()/done/forceEndpoint() from a recognition callback waits on that
 * callback itself. Segments do not submit chat turns.
 */
export default function createNativeSpeechCapture({speech, model, ...options}) {
    const controller = new AbortController();
    let stream;
    let started = false;
    let stopping;
    let settled = false;
    let cancelled = false;
    let cleanup;
    let detachSignal;
    let resolveDone;
    let rejectDone;
    const done = new Promise(function ownNativeCapture(resolve, reject) {
        resolveDone = resolve;
        rejectDone = reject;
    });
    // The caller still receives rejection through done; this observer prevents
    // a synchronous device failure from becoming an unhandled rejection first.
    done.catch(function observeNativeCaptureFailure() {});

    function finish(error, result) {
        if (settled) return;
        settled = true;
        detachSignal?.();
        if (error) rejectDone(error);
        else resolveDone(result);
    }

    function fail(error) {
        if (settled || cleanup) return cleanup;
        return endCapture(error, error);
    }

    function endCapture(reason, primaryError) {
        if (settled || cleanup) return cleanup ?? done;
        const captureCleanup = capture.cancel();
        // Join the explicit native cancellation operation, not the immediately
        // aborted browser request, before releasing the capture/provider lane.
        // Native cancellation proceeds while capture joins its pending PCM.
        const nativeCleanup = Promise.resolve().then(function cancelNativeStream() {
            return stream?.cancel(reason);
        });
        cleanup = Promise.allSettled(
            [captureCleanup, nativeCleanup]
        ).then(
            function nativeCaptureReleased(results) {
                const errors = primaryError ? [primaryError] : [];
                for (const result of results) {
                    if (result.status === 'rejected' && !errors.includes(result.reason)) errors.push(result.reason);
                }
                const error = errors.length > 1
                    ? new AggregateError(errors, 'Native capture failed during cleanup.')
                    : errors[0];
                finish(error, results[1].value);
                if (error) return options.onError?.(error);
            }
        );
        cleanup.catch(function observeCaptureErrorCallback(error) {
            console.error('Native speech capture error callback failed.', error);
        });
        controller.abort(reason);
        return cleanup;
    }

    const capture = new ContinuousVoiceCapture({
        mode: 'pcm',
        pcmChunkMs: options.pcmChunkMs ?? 100,
        activityThreshold: options.activityThreshold ?? 0.02,
        async onPCM(record) {
            try {
                await stream.ready;
                controller.signal.throwIfAborted();
                const sampleRate = options.streamOptions?.sampleRate ?? options.sampleRate ?? 16000;
                if (record.sampleRate !== sampleRate) {
                    throw new Error(`Microphone PCM sample rate ${record.sampleRate} differs from native stream rate ${sampleRate}.`);
                }
                await stream.push(record.samples);
            } catch (error) {
                // The owned cancellation ends an in-flight browser request;
                // that expected abort is distinct from actual delivery failure.
                if (controller.signal.aborted && (
                    error === controller.signal.reason || error?.name === 'AbortError' || error?.code === 'ARCANE_CANCELLED'
                )) return;
                throw error;
            }
        },
        onActivity: options.onActivity,
        onState: options.onState,
        onError: fail
    });

    function cancel(reason) {
        if (settled) return done;
        cancelled = true;
        endCapture(reason);
        return done;
    }

    function stop() {
        if (stopping || settled) return stopping ?? done;
        if (!stream) return cancel();
        async function drainNativeCapture() {
            await capture.stop();
            if (!controller.signal.aborted) await stream.finish();
            return done;
        }
        stopping = drainNativeCapture().catch(
            function nativeCaptureStopFailed(error) {
                fail(error);
                return done;
            }
        );
        return stopping;
    }

    function requestStop() {
        // A callback requests the same terminal drain without joining itself.
        // done retains its success or failure for the external owning caller.
        stop().catch(function observeRequestedCaptureStop() {});
    }

    const callbackControls = {requestStop};

    return {
        done,
        async start({signal, mediaConstraints} = {}) {
            if (started || settled) return false;
            started = true;
            function externalCancellation() { cancel(signal.reason); }
            if (signal) {
                signal.addEventListener('abort', externalCancellation, {once: true});
                detachSignal = function removeCaptureSignal() {
                    signal.removeEventListener('abort', externalCancellation);
                };
                if (signal.aborted) {
                    cancel(signal.reason);
                    return false;
                }
            }
            try {
                stream = speech.openStream({model, sampleRate: options.sampleRate ?? 16000, ...options.streamOptions}, {
                    signal: controller.signal,
                    onProgress: options.onProgress,
                    onRequest: options.onRequest,
                    async onUpdate(result) {
                        if (controller.signal.aborted) return;
                        await options.onUpdate?.(result, callbackControls);
                        // These are ASR snapshot callbacks, not semantic turn-end
                        // decisions. Preserve every field and replacement partial.
                        if (result.final) await options.onSegment?.(result, callbackControls);
                        else await options.onInterim?.(result, callbackControls);
                    }
                });
                stream.completion.then(async function nativeStreamFinished(result) {
                    if (cleanup) return;
                    await capture.cancel();
                    if (cleanup) return cleanup;
                    finish(undefined, result);
                }, fail).catch(function captureObserverFailed(error) {
                    return fail(error);
                });
                // Microphone permission remains in the initiating user gesture;
                // its samples queue while the native stream becomes ready.
                const capturing = capture.start({
                    signal: controller.signal,
                    sampleRate: options.streamOptions?.sampleRate ?? options.sampleRate ?? 16000,
                    mediaConstraints: mediaConstraints ?? options.mediaConstraints ?? {audio: {echoCancellation: true}}
                });
                const [ready] = await Promise.all([capturing, stream.ready]);
                if (!ready && !settled) cancel();
                return ready && !settled;
            } catch (error) {
                if (!cancelled) await fail(error);
                else await cleanup;
                return false;
            }
        },
        async forceEndpoint() {
            if (!started || settled || stopping) return [];
            await capture.flush();
            controller.signal.throwIfAborted();
            return stream.forceEndpoint();
        },
        stop,
        requestStop,
        cancel,
        destroy: cancel,
        current() { return stream?.current() ?? null; }
    };
}
