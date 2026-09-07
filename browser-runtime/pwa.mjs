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
    const queriedWorkers = new WeakSet();
    const refreshedWorkers = new WeakSet();
    const pendingRefreshes = new Set();
    const refreshTasks = new Set();
    let storageTask = null;
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
        if (event.target.state === 'redundant') {
            for (const operation of pendingRefreshes) {
                if (operation.worker === event.target) {
                    operation.cancel();
                }
            }
        }
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
        watchWorker(container.controller);
        publish(currentStatus());
        const worker = registration.active ?? container.controller;
        if (worker?.state === 'activated' && !queriedWorkers.has(worker)) {
            queriedWorkers.add(worker);
            try {
                worker.postMessage({type: 'arcane.pwa.capabilities'});
            } catch (error) {
                publish('error', error);
            }
        }
    }

    function startResourceRefresh(worker, cacheName) {
        if (disposed || worker.state !== 'activated' || refreshedWorkers.has(worker)) {
            return;
        }
        refreshedWorkers.add(worker);
        const task = refreshCachedResources(worker, cacheName);
        refreshTasks.add(task);
        task.then(
            function resourceRefreshComplete() {
                refreshTasks.delete(task);
            },
            function resourceRefreshFailed(error) {
                refreshTasks.delete(task);
                if (error?.code !== 'ARCANE_PWA_REFRESH_CANCELLED') {
                    publish('error', error);
                }
            }
        );
    }

    async function loadCheckStorage() {
        if (!globalThis.dbopfs) {
            await import('arcane/DBOPFS');
        }
        const storage = globalThis.dbopfs;
        if (!storage) {
            throw new Error('PWA check history could not open DBOPFS.');
        }
        await storage.readyPromise;
        return storage;
    }

    function requestResourceRefresh(worker, lastChecked) {
        const channel = new MessageChannel();
        return new Promise(
            function resourceRefreshReply(resolve, reject) {
                function cleanup() {
                    pendingRefreshes.delete(operation);
                    channel.port1.onmessage = null;
                    channel.port1.onmessageerror = null;
                    channel.port1.close();
                    channel.port2.close();
                }
                function cancel() {
                    cleanup();
                    const error = new Error('The PWA resource refresh owner is no longer active.');
                    error.code = 'ARCANE_PWA_REFRESH_CANCELLED';
                    reject(error);
                }
                const operation = {worker, cancel};
                pendingRefreshes.add(operation);
                channel.port1.onmessage = function receiveResourceRefresh(event) {
                    if (event.data?.type === 'arcane.pwa.refreshed') {
                        cleanup();
                        resolve(event.data);
                    }
                };
                channel.port1.onmessageerror = function unreadableResourceRefresh() {
                    cleanup();
                    reject(new Error('The PWA resource refresh reply could not be read.'));
                };
                channel.port1.start();
                try {
                    worker.postMessage({type: 'arcane.pwa.refresh', lastChecked}, [channel.port2]);
                } catch (error) {
                    cleanup();
                    reject(error);
                }
            }
        );
    }

    async function refreshCachedResources(worker, cacheName) {
        storageTask ??= loadCheckStorage();
        const storage = await storageTask;
        const key = `${encodeURIComponent(cacheName)}.json`;
        async function refreshStoredChecks() {
            if (disposed || worker.state !== 'activated') {
                return;
            }
            // A fresh read under the shared lock preserves checks made by another tab.
            const record = await storage.get('pwa', key, true);
            if (disposed || worker.state !== 'activated') {
                return;
            }
            const result = await requestResourceRefresh(worker, record?.lastChecked ?? null);
            if (!result.error && Number.isFinite(result.lastChecked) && result.lastChecked !== record?.lastChecked) {
                await storage.set('pwa', key, {lastChecked: result.lastChecked});
            }
            if (result.error) {
                publish('error', result.error);
            }
        }
        const locks = globalThis.navigator?.locks;
        if (locks?.request) {
            await locks.request(`arcane-pwa-checks|${cacheName}`, refreshStoredChecks);
        } else {
            await refreshStoredChecks();
        }
    }

    function onControllerChange() {
        refreshRegistration();
    }

    function onWorkerMessage(event) {
        if (event.data?.type === 'arcane.pwa.capabilities' && event.data.refresh === true && workers.has(event.source)) {
            startResourceRefresh(event.source, event.data.cacheName);
        }
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
        for (const operation of pendingRefreshes) {
            operation.cancel();
        }
        listeners.length = 0;
        workers.clear();
        source.dispose();
    }

    const ready = startRegistration();
    return owner;
}
