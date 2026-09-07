import {createArcaneEventSource} from './event-manager.mjs';

export const PWA_STATE_EVENT = 'arcane.pwa.state';

export function registerPwa({workerUrl = './arcane-sw.js', scope} = {}) {
    const owner = {
        get ready() {
            return ready;
        },
        get state() {
            return snapshot();
        },
        subscribe,
        dispose,
        update
    };
    const source = createArcaneEventSource(
        owner,
        {
            source: 'arcane.pwa',
            eventTypes: [PWA_STATE_EVENT]
        }
    );
    const container = globalThis.navigator?.serviceWorker;
    const listeners = [];
    const workers = new Map();
    let registration = null;
    let disposed = false;
    let current = {
        status: 'registering',
        workerUrl: String(workerUrl),
        scope: scope === undefined ? null : String(scope),
        controller: null,
        installing: null,
        waiting: null,
        active: null,
        error: null
    };

    function snapshot() {
        return {...current};
    }

    function publish(status, error = null) {
        if (disposed) {
            return;
        }
        current = {
            status,
            workerUrl: current.workerUrl,
            scope: registration?.scope ?? current.scope,
            controller: container?.controller?.state ?? null,
            installing: registration?.installing?.state ?? null,
            waiting: registration?.waiting?.state ?? null,
            active: registration?.active?.state ?? null,
            error
        };
        source.dispatch(
            PWA_STATE_EVENT,
            snapshot()
        );
    }

    function observe(target, eventName, listener) {
        target.addEventListener(eventName, listener);
        listeners.push(
            function removeNativeListener() {
                target.removeEventListener(eventName, listener);
            }
        );
    }

    function currentStatus() {
        if (registration.waiting) {
            return 'waiting';
        }
        if (registration.installing) {
            return 'installing';
        }
        return registration.active ? 'active' : 'registered';
    }

    function onWorkerStateChange(event) {
        const previousState = workers.get(event.target);
        workers.set(event.target, event.target.state);
        // A newer installation normally supersedes an already waiting worker.
        if (event.target.state === 'redundant'
            && previousState !== 'activated' && previousState !== 'installed') {
            publish('error', current.error ?? new Error('The PWA worker became redundant before activation.'));
            return;
        }
        refreshRegistration();
    }

    function watchWorker(worker) {
        if (!worker || workers.has(worker)) {
            return;
        }
        workers.set(worker, worker.state);
        observe(worker, 'statechange', onWorkerStateChange);
    }

    function refreshRegistration() {
        if (disposed) {
            return;
        }
        watchWorker(registration.installing);
        watchWorker(registration.waiting);
        watchWorker(registration.active);
        publish(currentStatus());
    }

    function onControllerChange() {
        refreshRegistration();
    }

    function onWorkerMessage(event) {
        if (event.data?.type === 'arcane.pwa.error' && workers.has(event.source)) {
            publish('error', event.data.error);
        }
    }

    function onRegistered(value) {
        registration = value;
        if (!disposed) {
            observe(registration, 'updatefound', refreshRegistration);
            observe(container, 'controllerchange', onControllerChange);
            observe(container, 'message', onWorkerMessage);
            refreshRegistration();
        }
        return registration;
    }

    function onRegistrationError(error) {
        publish('error', error);
        throw error;
    }

    function startRegistration() {
        if (!container) {
            publish('unsupported');
            return Promise.resolve(null);
        }
        try {
            const url = new URL(workerUrl, globalThis.document?.baseURI ?? globalThis.location?.href);
            const registrationScope = new URL(scope ?? './', url);
            current.workerUrl = url.href;
            current.scope = registrationScope.href;
            const registered = container.register(
                url.href,
                {
                    scope: registrationScope.href,
                    updateViaCache: 'none'
                }
            );
            return Promise.resolve(registered).then(onRegistered).catch(onRegistrationError);
        } catch (error) {
            publish('error', error);
            return Promise.reject(error);
        }
    }

    function subscribe(listener, {emitCurrent = true, signal} = {}) {
        function forwardPwaState(event) {
            listener(event.detail);
        }
        const unsubscribe = source.on(PWA_STATE_EVENT, forwardPwaState, signal ? {signal} : undefined);
        try {
            if (emitCurrent && !signal?.aborted) {
                listener(snapshot());
            }
        } catch (error) {
            unsubscribe();
            throw error;
        }
        return unsubscribe;
    }

    async function update() {
        const value = await ready;
        if (disposed) {
            throw new Error('The PWA registration owner has been disposed.');
        }
        if (!value) {
            return null;
        }
        try {
            return await value.update();
        } catch (error) {
            publish('error', error);
            throw error;
        }
    }

    function dispose() {
        if (disposed) {
            return;
        }
        current = {...current, status: 'disposed'};
        disposed = true;
        source.dispatch(
            PWA_STATE_EVENT,
            snapshot()
        );
        for (const removeListener of listeners) {
            removeListener();
        }
        listeners.length = 0;
        workers.clear();
        source.dispose();
    }

    const ready = startRegistration();
    return owner;
}
