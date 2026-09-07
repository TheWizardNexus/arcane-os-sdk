import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {PWA_STATE_EVENT, registerPwa} from '../browser-runtime/pwa.mjs';

class WorkerFixture extends EventTarget {
    constructor(state) {
        super();
        this.state = state;
        this.messages = [];
        this.cacheName = 'arcane-pwa|["fixture","https://example.test/app/"]|resources';
    }

    transition(state) {
        this.state = state;
        this.dispatchEvent(new Event('statechange'));
    }

    postMessage(message, ports) {
        this.messages.push(message);
        if (message.type === 'arcane.pwa.capabilities') {
            const event = new Event('message');
            event.source = this;
            event.data = {type: 'arcane.pwa.capabilities', refresh: true, cacheName: this.cacheName};
            this.container.dispatchEvent(event);
            return;
        }
        const result = this.refreshResult?.(message) ?? {lastChecked: message.lastChecked, error: null};
        ports[0].postMessage({type: 'arcane.pwa.refreshed', ...result});
        ports[0].close();
    }
}

function serviceWorkerFixture() {
    const registration = new EventTarget();
    registration.scope = 'https://example.test/app/';
    registration.installing = new WorkerFixture('installing');
    registration.waiting = null;
    registration.active = null;
    let updates = 0;
    registration.update = async function updateRegistration() {
        updates += 1;
        return registration;
    };
    registration.unregister = function unexpectedUnregister() {
        throw new Error('Disposal must preserve the service-worker registration.');
    };
    const container = new EventTarget();
    container.controller = null;
    const calls = [];
    let resolveRegistration;
    let rejectRegistration;
    const registered = new Promise(function pendingRegistration(resolve, reject) {
        resolveRegistration = resolve;
        rejectRegistration = reject;
    });
    container.register = function registerWorker(...args) {
        calls.push(args);
        return registered;
    };
    return {
        container,
        registration,
        calls,
        get updates() {
            return updates;
        },
        resolve() {
            for (const worker of [registration.installing, registration.waiting, registration.active]) {
                if (worker) {
                    worker.container = container;
                }
            }
            resolveRegistration(registration);
        },
        reject(error) {
            rejectRegistration(error);
        },
        message(worker, error) {
            const event = new Event('message');
            event.source = worker;
            event.data = {type: 'arcane.pwa.error', error};
            container.dispatchEvent(event);
        }
    };
}

function installNavigator(serviceWorker, {storage, locks} = {}) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'dbopfs');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: serviceWorker ? {serviceWorker, locks} : {}
    });
    Object.defineProperty(globalThis, 'dbopfs', {
        configurable: true,
        value: storage ?? {
            readyPromise: Promise.resolve(),
            async get() { return null; },
            async set(table, key, value) { return value; }
        }
    });
    return function restoreNavigator() {
        if (previous) {
            Object.defineProperty(globalThis, 'navigator', previous);
        } else {
            delete globalThis.navigator;
        }
        if (previousStorage) {
            Object.defineProperty(globalThis, 'dbopfs', previousStorage);
        } else {
            delete globalThis.dbopfs;
        }
    };
}

test('PWA registration returns its owner synchronously and replays native lifecycle state', async function registrationLifecycle() {
    const fixture = serviceWorkerFixture();
    const restore = installNavigator(fixture.container);
    const owner = registerPwa({workerUrl: new URL('https://example.test/app/arcane-sw.js')});
    const states = [];
    try {
        assert.equal(PWA_STATE_EVENT, 'arcane.pwa.state');
        assert.equal(owner.state.status, 'registering');
        owner.subscribe(function captureState(state) {
            states.push(state);
        });
        assert.equal(states[0].status, 'registering');
        assert.deepEqual(fixture.calls, [[
            'https://example.test/app/arcane-sw.js',
            {scope: 'https://example.test/app/', updateViaCache: 'none'}
        ]]);
        fixture.resolve();
        assert.equal(await owner.ready, fixture.registration);
        assert.equal(owner.state.status, 'installing');
        const worker = fixture.registration.installing;
        fixture.registration.installing = null;
        fixture.registration.waiting = worker;
        worker.transition('installed');
        assert.equal(owner.state.status, 'waiting');
        assert.equal(owner.state.controller, null);
        fixture.registration.waiting = null;
        fixture.registration.active = worker;
        worker.transition('activated');
        assert.equal(owner.state.status, 'active');
        assert.equal(owner.state.controller, null);
        fixture.container.controller = worker;
        fixture.container.dispatchEvent(new Event('controllerchange'));
        assert.equal(owner.state.controller, 'activated');
        assert.equal(await owner.update(), fixture.registration);
        assert.equal(fixture.updates, 1);
        owner.dispose();
        const count = states.length;
        assert.equal(states.at(-1).status, 'disposed');
        fixture.container.dispatchEvent(new Event('controllerchange'));
        fixture.registration.dispatchEvent(new Event('updatefound'));
        assert.equal(states.length, count);
    } finally {
        owner.dispose();
        restore();
    }
});

test('a newer waiting worker replaces an older waiting worker without an application error', async function waitingReplacement() {
    const fixture = serviceWorkerFixture();
    fixture.registration.active = new WorkerFixture('activated');
    fixture.registration.waiting = new WorkerFixture('installed');
    const restore = installNavigator(fixture.container);
    const owner = registerPwa(
        {workerUrl: 'https://example.test/app/arcane-sw.js'}
    );
    const states = [];
    try {
        owner.subscribe(
            function captureReplacementState(state) {
                states.push(state);
            }
        );
        fixture.resolve();
        await owner.ready;
        const previous = fixture.registration.waiting;
        const next = fixture.registration.installing;
        previous.transition('redundant');
        fixture.registration.waiting = next;
        fixture.registration.installing = null;
        next.transition('installed');
        assert.equal(owner.state.status, 'waiting');
        assert.equal(owner.state.error, null);
        assert.equal(
            states.some(
                function errorState(state) {
                    return state.status === 'error';
                }
            ),
            false
        );
    } finally {
        owner.dispose();
        restore();
    }
});

test('PWA install failure preserves complete errors when a failed replacement leaves an active worker', async function failedReplacement() {
    const fixture = serviceWorkerFixture();
    fixture.registration.active = new WorkerFixture('activated');
    const restore = installNavigator(fixture.container);
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        fixture.resolve();
        await owner.ready;
        const worker = fixture.registration.installing;
        const failure = {name: 'AggregateError', message: 'Complete failure', errors: [
            {message: 'first missing asset', cause: {message: 'first transport failure'}},
            {message: 'second missing asset', cause: {message: 'second transport failure'}}
        ]};
        fixture.message(worker, failure);
        fixture.registration.installing = null;
        worker.transition('redundant');
        assert.equal(owner.state.status, 'error');
        assert.equal(owner.state.error, failure);
        assert.equal(owner.state.active, 'activated');
        const states = [];
        const controller = new AbortController();
        owner.subscribe(function captureCurrent(state) {
            states.push(state);
        }, {signal: controller.signal});
        assert.equal(states[0].error, failure);
        controller.abort();
        fixture.registration.dispatchEvent(new Event('updatefound'));
        assert.equal(states.length, 1);
    } finally {
        owner.dispose();
        restore();
    }
});

test('PWA unsupported platforms and disposal during registration complete without waiting for control', async function unsupportedAndDisposed() {
    const restoreUnsupported = installNavigator();
    const unsupported = registerPwa();
    try {
        assert.equal(unsupported.state.status, 'unsupported');
        assert.equal(await unsupported.ready, null);
        assert.equal(await unsupported.update(), null);
    } finally {
        unsupported.dispose();
        restoreUnsupported();
    }
    const fixture = serviceWorkerFixture();
    const restore = installNavigator(fixture.container);
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        owner.dispose();
        fixture.resolve();
        assert.equal(await owner.ready, fixture.registration);
        assert.equal(owner.state.status, 'disposed');
    } finally {
        owner.dispose();
        restore();
    }
});

test('PWA registration and explicit update failures remain observable and reject their owning promise', async function registrationFailures() {
    const fixture = serviceWorkerFixture();
    const restore = installNavigator(fixture.container);
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        const failure = new Error('Registration unavailable.');
        const rejected = assert.rejects(owner.ready, failure);
        fixture.reject(failure);
        await rejected;
        assert.equal(owner.state.status, 'error');
        assert.equal(owner.state.error, failure);
    } finally {
        owner.dispose();
        restore();
    }
    const updateFixture = serviceWorkerFixture();
    const restoreUpdate = installNavigator(updateFixture.container);
    const updating = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        updateFixture.resolve();
        await updating.ready;
        const failure = new Error('Update unavailable.');
        updateFixture.registration.update = async function failUpdate() {
            throw failure;
        };
        await assert.rejects(updating.update(), failure);
        assert.equal(updating.state.error, failure);
    } finally {
        updating.dispose();
        restoreUpdate();
    }
});

test('PWA page checks wait for DBOPFS in the background and serialize fresh history across page owners', async function persistedPageChecks() {
    const fixture = serviceWorkerFixture();
    fixture.registration.installing = null;
    const worker = new WorkerFixture('activated');
    fixture.registration.active = worker;
    worker.refreshResult = function checkedResource() {
        return {lastChecked: 2000000, error: null};
    };
    let storageReady;
    let checksComplete;
    let completedLocks = 0;
    let record = {lastChecked: 1000000};
    const reads = [];
    const writes = [];
    const lockNames = [];
    const checked = new Promise(function observeCompleteChecks(resolve) { checksComplete = resolve; });
    const storage = {
        readyPromise: new Promise(function delayedStorage(resolve) { storageReady = resolve; }),
        async get(table, key, force) {
            reads.push({table, key, force});
            return record;
        },
        async set(table, key, value) {
            record = value;
            writes.push({table, key, value});
            return value;
        }
    };
    let lockTail = Promise.resolve();
    const locks = {
        request(name, callback) {
            lockNames.push(name);
            const operation = lockTail.then(callback).then(function checkedWhileLocked() {
                completedLocks += 1;
                if (completedLocks === 2) {
                    checksComplete();
                }
            });
            lockTail = operation;
            return operation;
        }
    };
    const restore = installNavigator(fixture.container, {storage, locks});
    const first = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    const second = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        fixture.resolve();
        assert.equal(await first.ready, fixture.registration);
        assert.equal(await second.ready, fixture.registration);
        assert.equal(first.state.status, 'active');
        assert.equal(reads.length, 0);
        storageReady();
        await checked;
        const refreshes = worker.messages.filter(function resourceRefresh(message) { return message.type === 'arcane.pwa.refresh'; });
        assert.equal(refreshes.length, 2);
        assert.equal(refreshes[0].lastChecked, 1000000);
        assert.equal(refreshes[1].lastChecked, 2000000);
        assert.deepEqual(record, {lastChecked: 2000000});
        assert.equal(writes.length, 1);
        const key = `${encodeURIComponent(worker.cacheName)}.json`;
        assert.deepEqual(reads, [{table: 'pwa', key, force: true}, {table: 'pwa', key, force: true}]);
        assert.deepEqual(lockNames, [`arcane-pwa-checks|${worker.cacheName}`, `arcane-pwa-checks|${worker.cacheName}`]);
        fixture.registration.dispatchEvent(new Event('updatefound'));
        fixture.container.controller = worker;
        fixture.container.dispatchEvent(new Event('controllerchange'));
        assert.equal(worker.messages.filter(function resourceRefresh(message) { return message.type === 'arcane.pwa.refresh'; }).length, 2);
    } finally {
        first.dispose();
        second.dispose();
        restore();
    }
});

test('PWA check history follows the app cache when a different app takes the same scope', async function distinctAppCacheHistory() {
    const fixture = serviceWorkerFixture();
    fixture.registration.installing = null;
    const first = new WorkerFixture('activated');
    const second = new WorkerFixture('activated');
    second.cacheName = 'arcane-pwa|["other-app","https://example.test/app/"]|resources';
    fixture.registration.active = first;
    const records = new Map();
    const lockNames = [];
    let firstWritten;
    let secondWritten;
    const firstCheck = new Promise(function firstCacheStored(resolve) { firstWritten = resolve; });
    const secondCheck = new Promise(function secondCacheStored(resolve) { secondWritten = resolve; });
    first.refreshResult = second.refreshResult = function completeCacheCheck() {
        return {lastChecked: 2000000, error: null};
    };
    const storage = {
        readyPromise: Promise.resolve(),
        async get(table, key) { return records.get(key); },
        async set(table, key, value) {
            records.set(key, value);
            if (records.size === 1) {
                firstWritten();
            } else {
                secondWritten();
            }
        }
    };
    const locks = {
        request(name, callback) {
            lockNames.push(name);
            return callback();
        }
    };
    const restore = installNavigator(fixture.container, {storage, locks});
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        fixture.resolve();
        await owner.ready;
        await firstCheck;
        fixture.registration.active = second;
        second.container = fixture.container;
        fixture.registration.dispatchEvent(new Event('updatefound'));
        await secondCheck;
        assert.equal(second.messages.find(function cacheRefresh(message) { return message.type === 'arcane.pwa.refresh'; }).lastChecked, null);
        assert.deepEqual([...records.keys()], [`${encodeURIComponent(first.cacheName)}.json`, `${encodeURIComponent(second.cacheName)}.json`]);
        assert.deepEqual(lockNames, [`arcane-pwa-checks|${first.cacheName}`, `arcane-pwa-checks|${second.cacheName}`]);
    } finally {
        owner.dispose();
        restore();
    }
});

test('an older worker can ignore the PWA capability inquiry without opening storage or holding a lock', async function oldWorkerUpgrade() {
    const fixture = serviceWorkerFixture();
    fixture.registration.installing = null;
    const worker = new WorkerFixture('activated');
    worker.postMessage = function ignoreNewProtocol(message) {
        this.messages.push(message);
    };
    fixture.registration.active = worker;
    let storageLoads = 0;
    let locksHeld = 0;
    const storage = {
        get readyPromise() {
            storageLoads += 1;
            return Promise.resolve();
        }
    };
    const locks = {request() { locksHeld += 1; }};
    const restore = installNavigator(fixture.container, {storage, locks});
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        fixture.resolve();
        await owner.ready;
        assert.deepEqual(worker.messages, [{type: 'arcane.pwa.capabilities'}]);
        assert.equal(storageLoads, 0);
        assert.equal(locksHeld, 0);
        assert.equal(owner.state.status, 'active');
        fixture.registration.dispatchEvent(new Event('updatefound'));
        assert.equal(worker.messages.length, 1);
    } finally {
        owner.dispose();
        restore();
    }
});

test('a superseded worker releases its pending PWA storage operation without forcing lifecycle changes', async function supersededRefresh() {
    const fixture = serviceWorkerFixture();
    fixture.registration.installing = null;
    const worker = new WorkerFixture('activated');
    fixture.registration.active = worker;
    let refreshStarted;
    let lockReleased;
    let writes = 0;
    const started = new Promise(function observeRefresh(resolve) { refreshStarted = resolve; });
    const released = new Promise(function observeLockRelease(resolve) { lockReleased = resolve; });
    worker.postMessage = function holdRefresh(message, ports) {
        if (message.type === 'arcane.pwa.capabilities') {
            WorkerFixture.prototype.postMessage.call(this, message, ports);
        } else {
            this.messages.push(message);
            refreshStarted();
        }
    };
    const storage = {
        readyPromise: Promise.resolve(),
        async get() { return null; },
        async set() { writes += 1; }
    };
    const locks = {
        async request(name, callback) {
            try {
                await callback();
            } finally {
                lockReleased();
            }
        }
    };
    const restore = installNavigator(fixture.container, {storage, locks});
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    try {
        fixture.resolve();
        await owner.ready;
        await started;
        fixture.registration.active = null;
        worker.transition('redundant');
        await released;
        assert.equal(writes, 0);
        assert.equal(owner.state.error, null);
        assert.equal(owner.state.controller, null);
    } finally {
        owner.dispose();
        restore();
    }
});

test('a partial PWA check exposes its complete error without writing an app check timestamp', async function failedPageCheck() {
    const fixture = serviceWorkerFixture();
    fixture.registration.installing = null;
    const worker = new WorkerFixture('activated');
    fixture.registration.active = worker;
    const failure = {name: 'AggregateError', message: 'The complete cache check did not finish.', errors: [
        {message: 'first unavailable file', cause: {message: 'complete first transport failure'}},
        {message: 'second unavailable file', cause: {message: 'complete second transport failure'}}
    ]};
    worker.refreshResult = function failedResourceCheck() {
        return {lastChecked: 2000000, error: failure};
    };
    let writes = 0;
    const storage = {
        readyPromise: Promise.resolve(),
        async get() { return {lastChecked: 1000000}; },
        async set() { writes += 1; }
    };
    const restore = installNavigator(fixture.container, {storage});
    const owner = registerPwa({workerUrl: 'https://example.test/app/arcane-sw.js'});
    const failed = new Promise(function observeCheckFailure(resolve) {
        owner.subscribe(function checkState(state) {
            if (state.status === 'error') {
                resolve(state);
            }
        });
    });
    try {
        fixture.resolve();
        await owner.ready;
        const state = await failed;
        assert.deepEqual(state.error, failure);
        assert.equal(writes, 0);
        assert.equal(state.active, 'activated');
    } finally {
        owner.dispose();
        restore();
    }
});
