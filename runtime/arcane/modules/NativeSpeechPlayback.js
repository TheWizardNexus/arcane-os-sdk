import Is from 'strong-type';
import {arcaneLogging} from 'arcane-os/logging';

const is = new Is(false);

/** Prepare exact native speech for the existing utterance queue, without starting synthesis. */
export default function prepareNativeSpeechPlayback({speech, request, getAudioContext, signal = null}) {
    if (!is.function(speech?.synthesizeStream) || !is.function(getAudioContext)) {
        throw new TypeError('Native speech playback requires streaming speech and an AudioContext owner.');
    }
    return {
        kind: 'native-speech',
        input: request.input,
        voice: request.voice,
        language: request.languageCode ?? request.language_code ?? request.language,
        speed: request.speed ?? 1,
        play(options = {}) {
            return startPlayback(speech, request, getAudioContext, signal, options);
        }
    };
}

function startPlayback(speech, request, getAudioContext, preparationSignal, {signal = null, onState = null} = {}) {
    const controller = new AbortController();
    const signals = new Set([preparationSignal, signal].filter(Boolean));
    const segments = [];
    const failures = [];
    const completion = deferred();
    const release = deferred();
    let context = null;
    let playbackState = 'queued';
    let playbackError = null;
    let paused = false;
    let settled = false;
    let synthesisSettled = true;
    let releaseSettled = false;
    let nextStart = 0;
    let playbackReady = null;

    function publish(nextState, error = playbackError) {
        playbackState = nextState;
        playbackError = error;
        if (!is.function(onState)) return;
        function observerFailed(cause) {
            arcaneLogging.error('Native speech playback observer failed.', cause);
        }
        try { Promise.resolve(onState({state: nextState, error})).catch(observerFailed); }
        catch (cause) { observerFailed(cause); }
    }

    function retainFailure(error) {
        if (!failures.includes(error)) failures.push(error);
        playbackError = failures.length === 1 ? failures[0]
            : new AggregateError(failures, 'Native speech playback and cleanup failed.');
    }

    function releaseIfFinished() {
        if (!settled || !synthesisSettled || releaseSettled) return;
        releaseSettled = true;
        if (failures.length) release.reject(playbackError);
        else release.resolve();
    }

    function removeSegment(segment) {
        const position = segments.indexOf(segment);
        if (position >= 0) segments.splice(position, 1);
        segment.buffer = null;
        segment.ended.resolve();
    }

    function detachSource(segment, stop) {
        const node = segment.node;
        if (!node) return;
        segment.node = null;
        node.onended = null;
        if (stop && segment.started) {
            try { node.stop(); }
            catch (error) { retainFailure(error); }
        }
        segment.started = false;
        try { node.disconnect(); }
        catch (error) { retainFailure(error); }
    }

    function wakePlayback() {
        if (!settled && (paused || context?.state !== 'running')) return;
        playbackReady?.resolve();
        playbackReady = null;
    }

    function finish(completed, error = null) {
        if (error) retainFailure(error);
        if (settled) {
            if (error) publish('error');
            releaseIfFinished();
            return;
        }
        settled = true;
        for (const requestSignal of signals) requestSignal.removeEventListener('abort', stop);
        context?.removeEventListener('statechange', contextChanged);
        if (!completed && !controller.signal.aborted) {
            controller.abort(error ?? cancellation());
        }
        for (const segment of [...segments]) {
            detachSource(segment, true);
            removeSegment(segment);
        }
        wakePlayback();
        publish(playbackError ? 'error' : completed ? 'complete' : 'stopped');
        if (playbackError) completion.reject(playbackError);
        else completion.resolve(completed);
        releaseIfFinished();
    }

    function updatePlaybackState() {
        if (settled) return;
        publish(paused ? 'paused'
            : context?.state === 'running' && segments.length ? 'playing' : 'waiting-for-audio');
    }

    function contextChanged() {
        if (settled) return;
        if (context.state === 'closed') {
            finish(false, playbackFailure('The shared audio output closed during native speech.'));
            return;
        }
        wakePlayback();
        updatePlaybackState();
    }

    function schedule(segment) {
        if (settled || paused || segment.node) return;
        const node = context.createBufferSource();
        segment.node = node;
        node.buffer = segment.buffer;
        node.connect(context.destination);
        segment.startAt = Math.max(context.currentTime, nextStart);
        nextStart = segment.startAt + segment.buffer.duration - segment.offset;
        node.onended = function segmentEnded() {
            if (segment.node !== node || settled) return;
            detachSource(segment, false);
            removeSegment(segment);
            if (failures.length) finish(false);
            else if (synthesisSettled && !segments.length) finish(true);
            else updatePlaybackState();
        };
        node.start(segment.startAt, segment.offset);
        segment.started = true;
    }

    async function receiveAudio({pcm, format, sampleRate, channels}) {
        try {
            await playAudio(pcm, format, sampleRate, channels);
        } catch (error) {
            if (error !== controller.signal.reason) finish(false, error);
            throw error;
        }
    }

    async function playAudio(pcm, format, sampleRate, channels) {
        controller.signal.throwIfAborted();
        if (format !== 's16le' || !(pcm instanceof Uint8Array)) {
            throw playbackFailure('Native speech requires signed 16-bit little-endian PCM.');
        }
        // PCM sample framing belongs to this audio transport, not request admission.
        const frames = pcm.byteLength / (2 * channels);
        if (!Number.isInteger(frames)) {
            throw playbackFailure('Native speech returned an incomplete PCM frame.');
        }
        if (!frames) return;
        const buffer = context.createBuffer(channels, frames, sampleRate);
        const samples = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        for (let channel = 0; channel < channels; channel += 1) {
            const output = buffer.getChannelData(channel);
            for (let frame = 0; frame < frames; frame += 1) {
                output[frame] = samples.getInt16((frame * channels + channel) * 2, true) / 32768;
            }
        }
        const preceding = segments[segments.length - 1];
        const segment = {buffer, offset: 0, startAt: 0, node: null, started: false, ended: deferred()};
        segments.push(segment);
        schedule(segment);
        updatePlaybackState();
        controller.signal.throwIfAborted();
        if (paused || context.state !== 'running') {
            playbackReady ??= deferred();
            await playbackReady.promise;
        }
        // Keep the current and next chunk scheduled. The awaited callback applies
        // playback backpressure without another utterance queue or a complete clip.
        if (preceding) await preceding.ended.promise;
        controller.signal.throwIfAborted();
    }

    function stop() {
        if (settled) return false;
        finish(false);
        return playbackError === null;
    }

    function pause() {
        if (settled || paused) return false;
        paused = true;
        const now = context?.currentTime ?? 0;
        for (const segment of [...segments]) {
            if (segment.node) {
                segment.offset = Math.min(segment.buffer.duration,
                    segment.offset + Math.max(0, now - segment.startAt));
                detachSource(segment, true);
            }
            if (segment.offset >= segment.buffer.duration) removeSegment(segment);
        }
        nextStart = now;
        if (failures.length) { finish(false); return false; }
        if (synthesisSettled && !segments.length) { finish(true); return false; }
        publish('paused');
        return true;
    }

    function resume() {
        if (settled || !paused) return false;
        paused = false;
        try {
            nextStart = context?.currentTime ?? 0;
            for (const segment of segments) schedule(segment);
            wakePlayback();
            updatePlaybackState();
            return true;
        } catch (error) {
            finish(false, error);
            return false;
        }
    }

    const control = {
        finished: completion.promise,
        released: release.promise,
        get state() { return playbackState; },
        get error() { return playbackError; },
        pause,
        resume,
        stop
    };
    for (const requestSignal of signals) requestSignal.addEventListener('abort', stop, {once: true});
    publish('queued');
    if ([...signals].some(function alreadyAborted(requestSignal) { return requestSignal.aborted; })) stop();
    if (!settled) {
        try {
            context = getAudioContext();
            if (context.state === 'closed') throw playbackFailure('The shared audio output is closed.');
            context.addEventListener('statechange', contextChanged);
            synthesisSettled = false;
            updatePlaybackState();
            const synthesis = Promise.resolve().then(function synthesizeOwnedUtterance() {
                controller.signal.throwIfAborted();
                return speech.synthesizeStream(request, {signal: controller.signal, onAudio: receiveAudio});
            });
            synthesis.then(function synthesisCompleted() {
                synthesisSettled = true;
                if (!settled && !segments.length) finish(true);
                releaseIfFinished();
            }, function synthesisFailed(error) {
                synthesisSettled = true;
                if (cancelledByOwner(error, controller.signal)) finish(false);
                else finish(false, error);
                releaseIfFinished();
            });
        } catch (error) {
            finish(false, error);
        }
    }
    return control;
}

function deferred() {
    const result = {};
    result.promise = new Promise(function retainCompletion(resolve, reject) {
        result.resolve = resolve;
        result.reject = reject;
    });
    result.promise.catch(function observeRetainedFailure() {});
    return result;
}

function cancellation() {
    const error = new Error('The owning caller stopped this native utterance.');
    error.name = 'AbortError';
    error.code = 'ARCANE_AI_REQUEST_ABORTED';
    return error;
}

function cancelledByOwner(error, signal) {
    if (!signal.aborted) return false;
    if (error === signal.reason) return true;
    // Core represents the matching request cancellation with its transport error.
    // A separate failure or cleanup aggregate remains observable.
    return error?.code === 'ARCANE_REQUEST_ABORTED' && !error.cause && !error.errors;
}

function playbackFailure(message) {
    const error = new Error(message);
    error.code = 'ARCANE_AI_SPEECH_PLAYBACK_FAILED';
    return error;
}
