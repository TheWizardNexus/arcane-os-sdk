import Is from '../dependencies/strong-type/index.js';
import {CoreError, serializeCoreError} from '../core/contracts.mjs';
import {getInstalledCoreClient, subscribeCoreClient} from '../core/client.mjs';

const is = new Is(false);

/** Attach the caller's existing renderer owners to its existing Core client. */
export function attachModelObservation({client, aiRuntimeState = null, imageRuntime = null,
    decisionModel = null, modelController = null, signal, onError} = {}) {
    requireOwner(aiRuntimeState, ['getAIRuntimeState', 'subscribeAIRuntimeState'], 'aiRuntimeState');
    requireOwner(imageRuntime, ['current', 'subscribe'], 'imageRuntime');
    requireOwner(decisionModel, ['status', 'subscribe'], 'decisionModel');
    requireOwner(modelController, ['status', 'on'], 'modelController');
    const lifetime = observationLifetime({client, signal, onError});
    let attachmentRequestId;
    let coreRequestId;
    let snapshot = null;
    let attached = false;

    function readOwners() {
        return {
            aiRuntimeState: aiRuntimeState?.getAIRuntimeState() ?? null,
            imageRuntime: imageRuntime?.current() ?? null,
            decisionModel: decisionModel?.status() ?? null,
            modelController: modelController?.status() ?? null
        };
    }

    function publishOwners() {
        if (!attached || lifetime.stopped) return;
        try {
            snapshot = readOwners();
            lifetime.invoke('model.observation.renderer.publish', {
                attachmentRequestId, coreRequestId, snapshot: transportSnapshot(snapshot)
            });
        } catch (error) {
            lifetime.fail(error);
        }
    }

    function observeOwners() {
        if (aiRuntimeState) lifetime.cleanup(aiRuntimeState.subscribeAIRuntimeState(
            publishOwners, {emitCurrent: false, signal: lifetime.signal}
        ));
        if (imageRuntime) lifetime.cleanup(imageRuntime.subscribe(
            publishOwners, {replay: false, signal: lifetime.signal}
        ));
        if (decisionModel) lifetime.cleanup(decisionModel.subscribe(
            publishOwners, {emitCurrent: false, signal: lifetime.signal}
        ));
        if (modelController) {
            lifetime.cleanup(modelController.on('statechange', publishOwners));
            lifetime.cleanup(modelController.on('progress', publishOwners));
        }
    }

    function acknowledgeAttachment(value) {
        if (lifetime.stopped || attached || value?.attachmentRequestId !== attachmentRequestId) return;
        try {
            if (!is.string(value.coreRequestId)) {
                throw observationError('MODEL_OBSERVATION_CONTEXT_UNAVAILABLE',
                    'The renderer acknowledgement omitted the actual Core request identity.');
            }
            coreRequestId = value.coreRequestId;
            attached = true;
            observeOwners();
            // Read again after all subscriptions exist so changes during the
            // attachment handshake are represented by current owner state.
            publishOwners();
            lifetime.acknowledge(value);
        } catch (error) {
            lifetime.fail(error);
        }
    }

    if (!lifetime.stopped) {
        try {
            snapshot = readOwners();
            lifetime.cleanup(client.events.on('model.observation.renderer.attached', acknowledgeAttachment));
            lifetime.invoke('model.observation.renderer.attach', {snapshot: transportSnapshot(snapshot)}, {
                long: true,
                onRequest: function identifyAttachment(value) { attachmentRequestId = value.requestId; }
            });
        } catch (error) {
            lifetime.fail(error);
        }
    }

    return {
        ready: lifetime.ready,
        closed: lifetime.closed,
        current: function currentRendererObservation() { return snapshot; },
        close: lifetime.close
    };
}

/** Subscribe through an existing Core client; model diagnostics are explicit. */
export function subscribeModelObservation({client, signal, onState, onDiagnostic, onError} = {}) {
    if (!is.function(onState)) throw new TypeError('Model observation requires an onState listener.');
    if (onDiagnostic !== undefined && !is.function(onDiagnostic)) {
        throw new TypeError('onDiagnostic must be a function.');
    }
    const lifetime = observationLifetime({client, signal, onError});
    let watchRequestId;
    let snapshot = null;

    function receiveState(value) {
        if (lifetime.stopped || value?.watchRequestId !== watchRequestId) return;
        if (!value.snapshot || !is.object(value.snapshot)) {
            lifetime.fail(observationError('MODEL_OBSERVATION_STATE_INVALID', 'Core omitted the observation snapshot.'));
            return;
        }
        snapshot = value.snapshot;
        lifetime.acknowledge(snapshot);
        lifetime.notify(onState, snapshot);
    }

    function receiveDiagnostic(value) {
        if (lifetime.stopped || value?.watchRequestId !== watchRequestId) return;
        lifetime.notify(onDiagnostic, value);
    }

    if (!lifetime.stopped) {
        try {
            lifetime.cleanup(client.events.on('model.observation.state', receiveState));
            if (onDiagnostic) lifetime.cleanup(client.events.on('model.observation.error', receiveDiagnostic));
            lifetime.invoke('model.observation.watch', {diagnostics: Boolean(onDiagnostic)}, {
                long: true,
                onRequest: function identifyWatch(value) { watchRequestId = value.requestId; }
            });
        } catch (error) {
            lifetime.fail(error);
        }
    }

    return {
        ready: lifetime.ready,
        closed: lifetime.closed,
        current: function currentModelObservation() { return snapshot; },
        close: lifetime.close
    };
}

function requireOwner(owner, methods, label) {
    if (owner === null) return;
    for (const method of methods) {
        if (!is.function(owner?.[method])) throw new TypeError(`${label} must be an existing owner exposing ${method}().`);
    }
}

function observationError(code, message) {
    return new CoreError({code, message});
}

function cancelledObservation() {
    return new CoreError({name: 'AbortError', code: 'ARCANE_REQUEST_ABORTED', message: 'Model observation was cancelled.'});
}

function isCancellation(error) {
    return error?.name === 'AbortError' || error?.code === 'ARCANE_REQUEST_ABORTED' || error?.code === 'REQUEST_ABORTED';
}

/** Error encoding belongs only to the existing JSON transport boundary. */
function transportSnapshot(snapshot) {
    return Object.fromEntries(Object.entries(snapshot).map(function transportOwner([name, value]) {
        return [name, value && is.error(value.error) ? {...value, error: serializeCoreError(value.error)} : value];
    }));
}

function reportObservationFailure(error) {
    globalThis.console?.error('Model observation failed.', error);
}

/** Own only observation RPCs and subscriptions, never the supplied owners. */
function observationLifetime({client, signal, onError = reportObservationFailure}) {
    if (!is.function(client?.invoke) || !is.function(client?.events?.on)) {
        throw new TypeError('Model observation requires an existing Core client.');
    }
    if (!is.function(onError)) throw new TypeError('onError must be a function.');
    const controller = new AbortController();
    const cleanups = [];
    const pending = new Set();
    const failures = [];
    let stopped = false;
    let acknowledged = false;
    let completed = false;
    let resolveReady;
    let rejectReady;
    let resolveClosed;
    let rejectClosed;
    const ready = new Promise(function ownObservationReadiness(resolve, reject) {
        resolveReady = resolve;
        rejectReady = reject;
    });
    const closed = new Promise(function ownObservationClosure(resolve, reject) {
        resolveClosed = resolve;
        rejectClosed = reject;
    });
    // The same failures are reported through onError and retained on these
    // public promises; unused companion promises must not create extra alerts.
    ready.catch(function readinessFailureObservedByLifetime() {});
    closed.catch(function closureFailureObservedByLifetime() {});

    function recordFailure(error) {
        if (failures.includes(error)) return;
        failures.push(error);
        try {
            Promise.resolve(onError(error)).catch(function reportErrorCallbackFailed(callbackError) {
                reportObservationFailure(callbackError);
            });
        } catch (callbackError) {
            reportObservationFailure(callbackError);
        }
    }

    function finish() {
        if (!stopped || pending.size || completed) return;
        completed = true;
        if (failures.length === 1) rejectClosed(failures[0]);
        else if (failures.length) rejectClosed(new AggregateError(failures, 'Model observation closed with errors.'));
        else resolveClosed();
    }

    function close() {
        if (!stopped) {
            stopped = true;
            for (const cleanup of cleanups.splice(0)) {
                try { cleanup(); } catch (error) { recordFailure(error); }
            }
            controller.abort();
            if (!acknowledged) rejectReady(failures[0] ?? cancelledObservation());
        }
        finish();
        return closed;
    }

    function fail(error) {
        recordFailure(error);
        close();
    }

    function cleanup(release) {
        if (!is.function(release)) throw new TypeError('An observation subscription must return an unsubscribe function.');
        if (stopped) release();
        else cleanups.push(release);
    }

    function invoke(method, parameters, {long = false, onRequest} = {}) {
        if (stopped) return;
        // Reserve ownership before invoke: an in-process transport can deliver
        // acknowledgement synchronously while invoke is still on the stack.
        const operation = {};
        pending.add(operation);
        let task;
        try {
            task = client.invoke(method, parameters, {signal: controller.signal, timeoutMs: 0, onRequest});
        } catch (error) {
            task = Promise.reject(error);
        }
        Promise.resolve(task).then(function observationCompleted() {
            pending.delete(operation);
            if (long && !stopped) {
                if (!acknowledged) fail(observationError('MODEL_OBSERVATION_ENDED', 'The observation ended before acknowledgement.'));
                else close();
            }
            finish();
        }, function observationFailed(error) {
            pending.delete(operation);
            if (isCancellation(error)) close();
            else fail(error);
            finish();
        });
    }

    function acknowledge(value) {
        if (stopped || acknowledged) return;
        acknowledged = true;
        resolveReady(value);
    }

    function notify(listener, value) {
        if (stopped || !listener) return;
        try {
            // Callback lifetimes belong to callers, who may await close().
            // Observe rejection without making that callback a close barrier.
            Promise.resolve(listener(value)).catch(fail);
        } catch (error) {
            fail(error);
        }
    }

    function retireObservation() { close(); }
    if (signal) {
        signal.addEventListener('abort', retireObservation, {once: true});
        cleanup(function releaseCallerSignal() { signal.removeEventListener('abort', retireObservation); });
    }
    if (is.function(globalThis.addEventListener)) {
        globalThis.addEventListener('pagehide', retireObservation, {once: true});
        cleanup(function releasePageLifetime() { globalThis.removeEventListener('pagehide', retireObservation); });
    }
    if (getInstalledCoreClient() === client) {
        cleanup(subscribeCoreClient(function installedOwnerChanged(value) {
            if (value.client !== client) {
                if (value.error) fail(value.error);
                else close();
            }
        }, {emitCurrent: false}));
    }
    if (signal?.aborted) close();

    return {
        ready, closed, signal: controller.signal, cleanup, invoke, acknowledge, notify, fail, close,
        get stopped() { return stopped; }
    };
}
