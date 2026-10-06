import Is from 'strong-type';
import {CoreError} from '../../../browser-runtime/core/contracts.mjs';

const is = new Is(false);

function observationError(code, message) {
    return new CoreError({code, message});
}

/** Observe supplied owners without acquiring, starting or replacing a model. */
export function createModelObservationService({runtime, localAI = null, image = null, decisions = null} = {}) {
    if (!is.function(runtime?.current) || !is.function(runtime?.onFrame)) {
        throw new TypeError('Model observation requires the existing Core runtime.');
    }
    const owners = {localAI, image, decisions};
    const observedMethods = new Set();
    for (const owner of Object.values(owners)) {
        if (owner === null) continue;
        if (!is.function(owner.current)) throw new TypeError('An observed Core model owner must expose current().');
        for (const method of Object.keys(owner.methods ?? {})) observedMethods.add(method);
    }

    const renderers = new Map();
    const watchers = new Set();
    const requests = new Map();
    let stopFrames = null;
    let disposed = false;

    function current() {
        return {
            core: runtime.current(),
            native: {
                localAI: localAI?.current() ?? null,
                image: image?.current() ?? null,
                decisions: decisions?.current() ?? null
            },
            renderers: [...renderers.values()].map(function rendererState(renderer) {
                return {
                    attachmentRequestId: renderer.request.clientRequestId,
                    coreRequestId: renderer.request.coreRequestId,
                    owners: renderer.snapshot
                };
            })
        };
    }

    function requireActive(request) {
        request.signal.throwIfAborted();
        if (disposed) throw observationError('MODEL_OBSERVATION_CLOSED', 'Model observation is closed.');
    }

    function requireContext(request) {
        requireActive(request);
        if (!is.string(request.clientRequestId) || !is.string(request.coreRequestId)) {
            throw observationError('MODEL_OBSERVATION_CONTEXT_UNAVAILABLE',
                'Model observation requires the actual client and Core request identities.');
        }
    }

    function observeActiveRequests(snapshot) {
        for (const request of snapshot.activeRequests) {
            if (observedMethods.has(request.method)) requests.set(request.id, request.method);
        }
        // Core publishes request removal before its response. Keep correlation
        // until that response arrives, rather than treating removal as settlement.
    }

    function stopFrameObservation() {
        if (watchers.size) return;
        stopFrames?.();
        stopFrames = null;
        requests.clear();
    }

    function send(watcher, event, value) {
        if (!watchers.has(watcher) || watcher.request.signal.aborted) return;
        try {
            watcher.request.emit(event, {watchRequestId: watcher.request.clientRequestId, ...value});
        } catch (error) {
            watcher.stop(error);
        }
    }

    function publishState() {
        if (!watchers.size) return;
        let snapshot;
        try {
            snapshot = current();
        } catch (error) {
            for (const watcher of [...watchers]) watcher.stop(error);
            return;
        }
        for (const watcher of [...watchers]) send(watcher, 'model.observation.state', {snapshot});
    }

    function observeFrame(frame) {
        try {
            if (frame.type === 'response') {
                const method = requests.get(frame.id);
                requests.delete(frame.id);
                if (method !== undefined && frame.ok === false) {
                    for (const watcher of [...watchers]) {
                        if (watcher.diagnostics) {
                            send(watcher, 'model.observation.error', {source: 'core', method, frame});
                        }
                    }
                }
                return;
            }
            if (frame.type !== 'event') return;
            if (frame.event === 'core.state') {
                observeActiveRequests(frame.data);
                publishState();
            } else if (frame.event === 'localai.state' || frame.event === 'image.state'
                || frame.event === 'decisions.state') {
                publishState();
            }
        } catch (error) {
            // An observation failure must settle observers, never the operation
            // whose existing owner emitted this frame.
            for (const watcher of [...watchers]) watcher.stop(error);
        }
    }

    function hold(request, release) {
        let reject;
        let stopped = false;
        const task = new Promise(function ownObservationRequest(_resolve, rejectRequest) {
            reject = rejectRequest;
        });
        function stop(error) {
            if (stopped) return;
            stopped = true;
            request.signal.removeEventListener('abort', aborted);
            try {
                release();
            } catch (releaseError) {
                error = new AggregateError([error, releaseError], 'Observation retirement failed.');
            }
            reject(error);
        }
        function aborted() {
            stop(request.signal.reason ?? observationError('ARCANE_REQUEST_ABORTED', 'Model observation was cancelled.'));
        }
        request.signal.addEventListener('abort', aborted, {once: true});
        return {task, stop, checkAbort: function checkObservationAbort() { if (request.signal.aborted) aborted(); }};
    }

    function watch({diagnostics = false} = {}, request) {
        requireContext(request);
        if (!is.boolean(diagnostics)) throw new TypeError('diagnostics must be a boolean.');
        const watcher = {request, diagnostics, stop: null};
        const owned = hold(request, function releaseWatcher() {
            watchers.delete(watcher);
            stopFrameObservation();
        });
        watcher.stop = owned.stop;
        watchers.add(watcher);
        try {
            if (!stopFrames) stopFrames = runtime.onFrame(observeFrame);
            observeActiveRequests(runtime.current());
            send(watcher, 'model.observation.state', {snapshot: current()});
            owned.checkAbort();
        } catch (error) {
            owned.stop(error);
        }
        return owned.task;
    }

    function attach({snapshot} = {}, request) {
        requireContext(request);
        if (!snapshot || !is.object(snapshot)) throw new TypeError('Renderer observation requires its current owner snapshots.');
        if (renderers.has(request.coreRequestId)) {
            throw observationError('MODEL_OBSERVATION_ATTACHMENT_ACTIVE', 'This Core attachment request is already active.');
        }
        const renderer = {request, snapshot, stop: null};
        const owned = hold(request, function releaseRenderer() {
            if (renderers.get(request.coreRequestId) === renderer) renderers.delete(request.coreRequestId);
            publishState();
        });
        renderer.stop = owned.stop;
        renderers.set(request.coreRequestId, renderer);
        try {
            request.emit('model.observation.renderer.attached', {
                attachmentRequestId: request.clientRequestId,
                coreRequestId: request.coreRequestId
            });
            publishState();
            owned.checkAbort();
        } catch (error) {
            owned.stop(error);
        }
        return owned.task;
    }

    function publishRenderer({attachmentRequestId, coreRequestId, snapshot} = {}, request) {
        requireActive(request);
        const renderer = renderers.get(coreRequestId);
        if (!renderer || renderer.request.clientRequestId !== attachmentRequestId || renderer.request.signal.aborted) {
            throw observationError('MODEL_OBSERVATION_ATTACHMENT_RETIRED', 'The selected renderer observation attachment is no longer active.');
        }
        if (!snapshot || !is.object(snapshot)) throw new TypeError('Renderer observation requires its current owner snapshots.');
        renderer.snapshot = snapshot;
        publishState();
        return {attachmentRequestId, coreRequestId};
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        const error = observationError('MODEL_OBSERVATION_CLOSED', 'Model observation is closed.');
        for (const watcher of [...watchers]) watcher.stop(error);
        for (const renderer of [...renderers.values()]) renderer.stop(error);
        stopFrameObservation();
    }

    return {
        name: 'model-observation',
        current,
        dispose,
        methods: {
            'model.observation.current': function currentObservation(_parameters, request) {
                requireActive(request);
                return current();
            },
            'model.observation.watch': watch,
            'model.observation.renderer.attach': attach,
            'model.observation.renderer.publish': publishRenderer
        }
    };
}
