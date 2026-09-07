import assert from 'node:assert/strict';
import test from '../src/testing.mjs';
import {PWA_STATE_EVENT, registerPwa} from '../browser-runtime/pwa.mjs';

class WorkerFixture extends EventTarget {
    constructor(state) {
        super();
        this.state = state;
    }

    transition(state) {
        this.state = state;
        this.dispatchEvent(new Event('statechange'));
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

function installNavigator(serviceWorker) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: serviceWorker ? {serviceWorker} : {}
    });
    return function restoreNavigator() {
        if (previous) {
            Object.defineProperty(globalThis, 'navigator', previous);
        } else {
            delete globalThis.navigator;
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
