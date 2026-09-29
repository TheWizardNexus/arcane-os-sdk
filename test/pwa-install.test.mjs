import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import {PWA_INSTALL_STATE_EVENT, getPwaInstall, registerPwa} from '../browser-runtime/pwa.mjs';
import {createPwaArtifacts} from '../src/pwa.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';
import {arcaneEvents, createArcaneEventSource, projectArcaneDOMEvent} from '../browser-runtime/event-manager.mjs';

function installStorageFixture({
    records = new Map(),
    readyPromise = Promise.resolve(),
    readGate = Promise.resolve(),
    writeGate = Promise.resolve(),
    readError = null,
    writeError = null
} = {}) {
    let resolveReadStarted;
    let resolveWriteStarted;
    let resolveWriteFinished;
    const readStarted = new Promise(function captureReadStart(resolve) {
        resolveReadStarted = resolve;
    });
    const writeStarted = new Promise(function captureWriteStart(resolve) {
        resolveWriteStarted = resolve;
    });
    const writeFinished = new Promise(function captureWriteFinish(resolve) {
        resolveWriteFinished = resolve;
    });
    const reads = [];
    const writes = [];
    return {
        records,
        reads,
        writes,
        readyPromise,
        readStarted,
        writeStarted,
        writeFinished,
        async get(table, key, force) {
            reads.push([table, key, force]);
            const record = records.get(`${table}/${key}`) ?? null;
            resolveReadStarted();
            await readGate;
            if (readError) throw readError;
            return record;
        },
        async set(table, key, value) {
            writes.push([table, key, value]);
            resolveWriteStarted();
            try {
                await writeGate;
                if (writeError) throw writeError;
                records.set(`${table}/${key}`, value);
                return value;
            } finally {
                resolveWriteFinished();
            }
        }
    };
}

function browserFixture(context, {
    stored = new Map(),
    running = false,
    fullscreen = false,
    standalone = false,
    storage = installStorageFixture()
} = {}) {
    const window = new EventTarget();
    let reloads = 0;
    const display = new EventTarget();
    const installedDisplay = new EventTarget();
    display.matches = running;
    installedDisplay.matches = running && !fullscreen;
    const globals = {
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        matchMedia: function matchDisplayMode(query) {
            return query.includes('(display-mode: fullscreen)') ? display : installedDisplay;
        },
        document: {querySelector() { return {href: 'https://example.test/arcane.webmanifest'}; }},
        sessionStorage: {
            getItem(key) { return stored.get(key) ?? null; },
            setItem(key, value) { stored.set(key, value); }
        },
        navigator: {standalone},
        onbeforeunload: function applicationUnloadHandler() {},
        location: {
            href: 'https://example.test/index.html',
            reload() { reloads += 1; }
        },
        dbopfs: storage
    };
    const previous = new Map();
    for (const [key, value] of Object.entries(globals)) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {configurable: true, value});
    }
    context.after(async function restoreBrowser() {
        const owner = getPwaInstall();
        await owner.ready;
        owner.dispose();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return {window, display, installedDisplay, stored, storage,
        unloadHandler: globals.onbeforeunload, get reloads() { return reloads; }};
}

function captureStorageWarnings(context) {
    const originalWarn = console.warn;
    const warnings = [];
    let resolveWarning;
    const warned = new Promise(function captureWarning(resolve) {
        resolveWarning = resolve;
    });
    console.warn = function observeStorageWarning(...args) {
        warnings.push(args);
        resolveWarning();
    };
    context.after(function restoreConsoleWarning() {
        console.warn = originalWarn;
    });
    return {warnings, warned};
}

function offerInstall(window, prompt) {
    const event = new Event('beforeinstallprompt', {cancelable: true});
    event.prompt = prompt;
    window.dispatchEvent(event);
    return event;
}

test('A late install prompt reads update state from a live registration owner', async function lateUpdatePrompt(context) {
    browserFixture(context);
    const container = new EventTarget();
    const worker = new EventTarget();
    worker.state = 'installing';
    const registration = new EventTarget();
    Object.assign(registration, {
        scope: 'https://example.test/', installing: worker, waiting: null, active: null
    });
    container.register = async function registerWorker() { return registration; };
    globalThis.navigator.serviceWorker = container;
    const page = registerPwa({workerUrl: 'https://example.test/arcane-sw.js'});
    try {
        await page.ready;
        const refreshed = new Event('message');
        refreshed.source = worker;
        refreshed.data = {type: 'arcane.pwa.refreshed', updateAvailable: true, error: null};
        container.dispatchEvent(refreshed);
        assert.equal(page.state.updateAvailable, true);
        const prompt = getPwaInstall();
        assert.equal(prompt.state.updateAvailable, true);
        await prompt.ready;
        prompt.dispose();
        page.dispose();
        const next = getPwaInstall();
        await next.ready;
        assert.equal(next.state.updateAvailable, false);
    } finally {
        page.dispose();
    }
});

for (const presentation of ['installed', 'running', 'installation dismissed']) {
    test(`PWA update controls remain independent when ${presentation}`, async function independentUpdateAvailability(context) {
        const stored = new Map([['app-draft', 'complete draft\n  続き\n']]);
        if (presentation === 'installation dismissed') {
            stored.set('arcane.pwa.install.dismissed:https://example.test/arcane.webmanifest', 'true');
        }
        const fixture = browserFixture(context, {
            stored,
            running: presentation === 'running',
            storage: installStorageFixture({records: new Map(presentation === 'installed'
                ? [['pwa/installed.json', {installed: true}]] : [])})
        });
        const owner = getPwaInstall();
        await owner.ready;
        const source = createArcaneEventSource({}, {source: 'arcane.pwa', eventTypes: ['arcane.pwa.state']});
        try {
            assert.equal(owner.state.updateAvailable, false);
            assert.equal(owner.update(), false);
            source.dispatch('arcane.pwa.state', {status: 'active', scope: 'https://another.test/', updateAvailable: true});
            assert.equal(owner.state.updateAvailable, false);
            source.dispatch('arcane.pwa.state', {status: 'active', scope: 'https://example.test/', updateAvailable: false});
            assert.equal(owner.state.updateAvailable, false);
            source.dispatch('arcane.pwa.state', {status: 'active', scope: 'https://example.test/', updateAvailable: true});
            assert.equal(owner.state.updateAvailable, true);
            assert.equal(owner.state.updateDismissed, false);
            assert.equal(fixture.reloads, 0);
            const installDismissed = owner.state.dismissed;
            owner.dismissUpdate();
            assert.equal(owner.state.updateDismissed, true);
            assert.equal(owner.state.dismissed, installDismissed);
            assert.equal(owner.update(), true);
            assert.equal(fixture.reloads, 1);
            assert.equal(globalThis.onbeforeunload, fixture.unloadHandler);
            assert.equal(stored.get('app-draft'), 'complete draft\n  続き\n');
            assert.equal(owner.state.updateAvailable, true);
            let replay;
            const unsubscribe = owner.subscribe(function replayUpdate(state) { replay = state; });
            assert.equal(replay.updateAvailable, true);
            assert.equal(replay.updateDismissed, true);
            unsubscribe();
            owner.dispose();
            assert.equal(owner.update(), false);
            const next = getPwaInstall();
            await next.ready;
            assert.equal(next.state.updateAvailable, false);
            assert.equal(next.state.updateDismissed, false);
        } finally {
            source.dispose();
        }
    });
}

async function installComponentFixture() {
    const html = await readFile(new URL('../runtime/arcane/components/pwa-install.html', import.meta.url), 'utf8');
    const source = html.match(/<script type="module">([\s\S]*?)<\/script>/u)[1];
    const elements = new Map();
    for (const id of ['installTitle', 'description', 'install', 'close', 'status']) {
        const element = new EventTarget();
        element.dataset = {};
        element.setAttribute = function setAttribute(name, value) { element[name] = value; };
        elements.set(`#${id}`, element);
    }
    const host = new EventTarget();
    host.dataset = {};
    host.shadowRoot = {querySelector(selector) { return elements.get(selector); }};
    const diagnostics = [];
    const AsyncFunction = Object.getPrototypeOf(async function componentBody() {}).constructor;
    const execute = new AsyncFunction('loadModule', source.replaceAll('import(', 'loadModule('));
    await execute.call(host, async function loadComponentModule(specifier) {
        if (specifier === 'strong-type') return {default: Is};
        if (specifier === 'arcane-os/pwa') return {getPwaInstall};
        if (specifier === 'arcane-os/event-manager') return {createArcaneEventSource, projectArcaneDOMEvent};
        if (specifier === 'arcane-os/logging') return {arcaneLogging: {error(...values) { diagnostics.push(values); }}};
        throw new Error(`Unexpected component import: ${specifier}`);
    });
    return {host, elements, diagnostics};
}

test('PWA shared component displays Update for an installed app and reloads only on its explicit click', async function installedUpdateComponent(context) {
    const fixture = browserFixture(context, {running: true});
    const owner = getPwaInstall();
    await owner.ready;
    const {host, elements, diagnostics} = await installComponentFixture();
    const source = createArcaneEventSource({}, {source: 'arcane.pwa', eventTypes: ['arcane.pwa.state']});
    try {
        assert.equal(host.hidden, true);
        source.dispatch('arcane.pwa.state', {status: 'active', scope: 'https://example.test/', updateAvailable: true});
        assert.equal(host.hidden, false);
        assert.equal(elements.get('#installTitle').textContent, 'Update available');
        assert.equal(elements.get('#install').textContent, 'Update');
        assert.equal(elements.get('#install').disabled, false);
        assert.equal(elements.get('#close')['aria-label'], 'Close update suggestion');
        assert.equal(fixture.reloads, 0);
        elements.get('#install').dispatchEvent(new Event('click'));
        assert.equal(fixture.reloads, 1);
        assert.equal(host.hidden, false);
        elements.get('#close').dispatchEvent(new Event('click'));
        assert.equal(host.hidden, true);
        assert.equal(owner.state.updateDismissed, true);
        assert.equal(owner.state.dismissed, false);
        assert.deepEqual(diagnostics, []);
        host.destroy();
        assert.equal(host.update(), false);
        assert.equal(host.dismissUpdate(), false);
    } finally {
        host.destroy();
        source.dispose();
    }
});

test('PWA component update visibility ignores installation dismissal and preserves explicit installation', async function dismissedInstallUpdateComponent(context) {
    const fixture = browserFixture(context);
    const owner = getPwaInstall();
    await owner.ready;
    let prompts = 0;
    offerInstall(fixture.window, function browserPrompt() { prompts += 1; return {outcome: 'accepted'}; });
    const {host, elements} = await installComponentFixture();
    const source = createArcaneEventSource({}, {source: 'arcane.pwa', eventTypes: ['arcane.pwa.state']});
    try {
        assert.equal(host.hidden, false);
        assert.equal(elements.get('#install').textContent, 'Install');
        host.dismiss();
        assert.equal(host.hidden, true);
        source.dispatch('arcane.pwa.state', {status: 'active', scope: 'https://example.test/', updateAvailable: true});
        assert.equal(host.hidden, false);
        host.configure({updateTitle: 'Complete update title\n続き', updateLabel: 'Reload now'});
        assert.equal(elements.get('#installTitle').textContent, 'Complete update title\n続き');
        assert.equal(elements.get('#install').textContent, 'Reload now');
        host.dismissUpdate();
        assert.equal(host.hidden, true);
        assert.equal(owner.state.available, true);
        assert.deepEqual(await host.install(), {outcome: 'accepted'});
        assert.equal(prompts, 1);
        assert.equal(fixture.reloads, 0);
    } finally {
        host.destroy();
        source.dispose();
    }
});

for (const installationState of ['pending', 'failed']) {
    test(`PWA update presentation keeps ${installationState} installation status separate`, async function separateUpdateStatus(context) {
        const fixture = browserFixture(context);
        const owner = getPwaInstall();
        await owner.ready;
        let settleChoice;
        const failure = new Error('Complete native installation failure.');
        offerInstall(fixture.window, function nativeInstallChoice() {
            if (installationState === 'failed') throw failure;
            return new Promise(function pendingChoice(resolve) { settleChoice = resolve; });
        });
        const {host, elements} = await installComponentFixture();
        const source = createArcaneEventSource({}, {source: 'arcane.pwa', eventTypes: ['arcane.pwa.state']});
        const operation = host.install();
        try {
            if (installationState === 'failed') {
                await assert.rejects(operation, function completeFailure(error) { return error === failure; });
            }
            const status = elements.get('#status');
            const installationMessage = status.textContent;
            assert.ok(installationMessage);
            source.dispatch('arcane.pwa.state', {status: 'active', scope: 'https://example.test/', updateAvailable: true});
            assert.equal(elements.get('#installTitle').textContent, 'Update available');
            assert.equal(status.textContent, '');
            assert.equal(status.hidden, true);
            assert.equal(status.dataset.error, 'false');
            host.dismissUpdate();
            assert.equal(status.textContent, installationMessage);
            assert.equal(status.hidden, false);
            assert.equal(status.dataset.error, String(installationState === 'failed'));
        } finally {
            settleChoice?.({outcome: 'dismissed'});
            await operation.catch(function observedNativeFailure() {});
            host.destroy();
            source.dispose();
        }
    });
}

test('Installation state replays availability and calls each native prompt once in the click stack',
    async function nativeInstallLifecycle(context) {
        const {window, storage} = browserFixture(context);
        const owner = getPwaInstall();
        assert.equal(getPwaInstall(), owner);
        assert.equal(PWA_INSTALL_STATE_EVENT, 'arcane.pwa.install.state');
        assert.equal(owner.state.status, 'waiting');
        assert.equal(owner.state.installed, false);
        assert.equal(owner.state.storageError, null);
        assert.deepEqual(await owner.ready, owner.state);
        let calls = 0;
        let resolveChoice;
        const choice = new Promise(function waitForChoice(resolve) { resolveChoice = resolve; });
        const event = offerInstall(window, function nativePrompt() { calls += 1; return choice; });
        assert.equal(event.defaultPrevented, true);
        const states = [];
        const unsubscribe = owner.subscribe(function captureInstallState(state) { states.push(state); });
        assert.equal(states[0].available, true);
        const result = owner.prompt();
        assert.equal(calls, 1);
        assert.equal(owner.state.status, 'prompting');
        assert.equal(await owner.prompt(), null);
        resolveChoice({outcome: 'accepted', platform: 'web'});
        assert.deepEqual(await result, {outcome: 'accepted', platform: 'web'});
        assert.equal(owner.state.status, 'accepted');
        assert.equal(calls, 1);
        window.dispatchEvent(new Event('appinstalled'));
        assert.equal(owner.state.status, 'installed');
        await storage.writeFinished;
        unsubscribe();
    }
);

test('Closing promotion persists for the tab session and retains installation for explicit controls',
    async function retainedInstallAfterDismissal(context) {
        const {window, storage} = browserFixture(context);
        const owner = getPwaInstall();
        await owner.ready;
        offerInstall(window, function nativePrompt() { return {outcome: 'accepted'}; });
        owner.dismiss();
        assert.equal(owner.state.dismissed, true);
        assert.equal(owner.state.available, true);
        assert.deepEqual(await owner.prompt(), {outcome: 'accepted'});
        assert.deepEqual(storage.writes, []);
        owner.dispose();
        const nextPage = getPwaInstall();
        assert.equal(nextPage.state.dismissed, true);
        assert.equal(nextPage.state.available, false);
        await nextPage.ready;
        assert.equal(nextPage.state.installed, false);
        assert.deepEqual(storage.writes, []);
    }
);

test('Older prompt results use userChoice and browser dismissal suppresses later promotion',
    async function nativeUserChoice(context) {
        const {window, storage} = browserFixture(context);
        const owner = getPwaInstall();
        await owner.ready;
        const event = offerInstall(window, function nativePrompt() { return Promise.resolve(); });
        event.userChoice = Promise.resolve({outcome: 'dismissed'});
        assert.deepEqual(await owner.prompt(), {outcome: 'dismissed'});
        assert.equal(owner.state.status, 'dismissed');
        assert.equal(owner.state.dismissed, true);
        assert.deepEqual(storage.writes, []);
        offerInstall(window, function laterPrompt() { return {outcome: 'accepted'}; });
        assert.equal(owner.state.available, true);
        assert.equal(owner.state.dismissed, true);
    }
);

test('Native prompt errors remain observable and do not reuse the consumed event',
    async function installPromptErrors(context) {
        const {window} = browserFixture(context);
        const owner = getPwaInstall();
        await owner.ready;
        const failure = new Error('The native prompt could not open.');
        offerInstall(window, function rejectedPrompt() { throw failure; });
        await assert.rejects(owner.prompt(), function sameFailure(error) { return error === failure; });
        assert.equal(owner.state.status, 'error');
        assert.equal(owner.state.error, failure);
        assert.equal(owner.state.available, false);
        offerInstall(window, function asyncRejectedPrompt() { return Promise.reject(failure); });
        await assert.rejects(owner.prompt(), function sameAsyncFailure(error) { return error === failure; });
        assert.equal(owner.state.error, failure);
    }
);

test('App display mode suppresses promotion and final page detach removes native listeners',
    async function displayAndDetach(context) {
        const {window, display, storage} = browserFixture(context, {running: true, fullscreen: true});
        const owner = getPwaInstall();
        assert.equal(owner.state.status, 'running');
        await owner.ready;
        assert.equal(owner.state.installed, false);
        assert.deepEqual(storage.writes, []);
        offerInstall(window, function unexpectedPrompt() { throw new Error('Already running as an app'); });
        assert.equal(owner.state.available, false);
        display.matches = false;
        display.dispatchEvent(new Event('change'));
        assert.equal(owner.state.status, 'waiting');
        const cachedHide = new Event('pagehide');
        cachedHide.persisted = true;
        window.dispatchEvent(cachedHide);
        assert.equal(owner.state.status, 'waiting');
        window.dispatchEvent(new Event('pagehide'));
        assert.equal(owner.state.status, 'disposed');
        const offer = offerInstall(window, function detachedPrompt() { return {outcome: 'accepted'}; });
        assert.equal(offer.defaultPrevented, false);
    }
);

test('A late prompt choice cannot replace installed state',
    async function lateInstallChoice(context) {
        const {window, storage} = browserFixture(context);
        const owner = getPwaInstall();
        await owner.ready;
        let resolveChoice;
        offerInstall(window, function pendingPrompt() {
            return new Promise(function pendingChoice(resolve) { resolveChoice = resolve; });
        });
        const result = owner.prompt();
        window.dispatchEvent(new Event('appinstalled'));
        resolveChoice({outcome: 'accepted'});
        await result;
        assert.equal(owner.state.status, 'installed');
        assert.equal(owner.state.outcome, 'accepted');
        await storage.writeFinished;
        owner.dispose();
        assert.equal(owner.state.status, 'disposed');
    }
);

test('A late prompt choice cannot replace disposed state',
    async function lateDisposedChoice(context) {
        const {window, storage} = browserFixture(context);
        const nextOwner = getPwaInstall();
        await nextOwner.ready;
        let resolveChoice;
        offerInstall(window, function pendingNextPrompt() {
            return new Promise(function pendingNextChoice(resolve) { resolveChoice = resolve; });
        });
        const nextResult = nextOwner.prompt();
        nextOwner.dispose();
        resolveChoice({outcome: 'accepted'});
        await nextResult;
        assert.equal(nextOwner.state.status, 'disposed');
        assert.equal(nextOwner.state.outcome, null);
        assert.deepEqual(storage.writes, []);
    }
);

test('Remembered installation restores before promotion without rewriting other PWA records',
    async function restoredInstallation(context) {
        const records = new Map(
            [
                ['pwa/installed.json', {installed: true}],
                ['pwa/resources.json', {lastChecked: 1700000000000}]
            ]
        );
        const storage = installStorageFixture({records});
        const {window} = browserFixture(context, {storage});
        const owner = getPwaInstall();
        const event = offerInstall(window, function forbiddenRestoredPrompt() {
            throw new Error('A remembered installation must not prompt again.');
        });
        assert.equal(event.defaultPrevented, true);
        assert.equal(owner.state.available, false);
        assert.equal(await owner.prompt(), null);
        const state = await owner.ready;
        assert.equal(state.status, 'installed');
        assert.equal(state.installed, true);
        assert.equal(state.available, false);
        assert.equal(await owner.prompt(), null);
        assert.equal(getPwaInstall(), owner);
        await owner.ready;
        assert.deepEqual(storage.reads, [['pwa', 'installed.json', true]]);
        assert.deepEqual(storage.writes, []);
        assert.deepEqual(records.get('pwa/resources.json'), {lastChecked: 1700000000000});
    }
);

test('Native install events are captured while DBOPFS is pending without losing click activation later',
    async function pendingStorageAvailability(context) {
        let releaseStorage;
        const readyPromise = new Promise(function pendingDatabase(resolve) {
            releaseStorage = resolve;
        });
        context.after(function releasePendingDatabase() { releaseStorage(); });
        const storage = installStorageFixture({readyPromise});
        const {window} = browserFixture(context, {storage});
        const owner = getPwaInstall();
        let calls = 0;
        const event = offerInstall(window, function promptAfterRestore() {
            calls += 1;
            return {outcome: 'accepted'};
        });
        assert.equal(event.defaultPrevented, true);
        assert.deepEqual(storage.reads, []);
        assert.equal(owner.state.available, false);
        assert.equal(await owner.prompt(), null);
        assert.equal(calls, 0);
        releaseStorage();
        const state = await owner.ready;
        assert.equal(state.available, true);
        assert.equal(state.installed, false);
        assert.deepEqual(storage.reads, [['pwa', 'installed.json', true]]);
        const result = owner.prompt();
        assert.equal(calls, 1);
        assert.deepEqual(await result, {outcome: 'accepted'});
        assert.equal(owner.state.installed, false);
        assert.deepEqual(storage.writes, []);
    }
);

test('A pending older read cannot undo installation and a new owner restores the saved result',
    async function installationDuringRestore(context) {
        let releaseRead;
        const readGate = new Promise(function pendingInstalledRecord(resolve) {
            releaseRead = resolve;
        });
        context.after(function releasePendingRecordRead() { releaseRead(); });
        const storage = installStorageFixture({readGate});
        const {window} = browserFixture(context, {storage});
        const owner = getPwaInstall();
        await storage.readStarted;
        offerInstall(window, function unusedPromptBeforeInstallation() {
            throw new Error('Installation must clear the retained event.');
        });
        window.dispatchEvent(new Event('appinstalled'));
        window.dispatchEvent(new Event('appinstalled'));
        assert.equal(owner.state.installed, true);
        assert.equal(owner.state.status, 'installed');
        assert.equal(owner.state.available, false);
        assert.deepEqual(storage.writes, []);
        releaseRead();
        await owner.ready;
        await storage.writeFinished;
        assert.equal(owner.state.installed, true);
        assert.deepEqual(storage.writes, [['pwa', 'installed.json', {installed: true}]]);
        owner.dispose();
        const restored = getPwaInstall();
        await restored.ready;
        assert.equal(restored.state.status, 'installed');
        assert.equal(restored.state.installed, true);
        const event = offerInstall(window, function forbiddenLaterPrompt() {
            throw new Error('Saved installation must remain suppressed on another page owner.');
        });
        assert.equal(event.defaultPrevented, false);
        assert.equal(restored.state.available, false);
        assert.equal(await restored.prompt(), null);
        assert.deepEqual(storage.reads, [
            ['pwa', 'installed.json', true],
            ['pwa', 'installed.json', true]
        ]);
        assert.deepEqual(storage.writes, [['pwa', 'installed.json', {installed: true}]]);
    }
);

test('Restoration failure settles readiness visibly and leaves the browser install path usable',
    async function failedInstallationRestore(context) {
        const failure = new Error('The installed record could not be read.');
        const storage = installStorageFixture({readError: failure});
        const {window} = browserFixture(context, {storage});
        const {warnings} = captureStorageWarnings(context);
        const owner = getPwaInstall();
        offerInstall(window, function promptWithoutStoredRecord() {
            return {outcome: 'dismissed'};
        });
        const state = await owner.ready;
        assert.equal(state.storageError, failure);
        assert.equal(state.installed, false);
        assert.equal(state.available, true);
        assert.equal(state.error, null);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], failure);
        assert.deepEqual(await owner.prompt(), {outcome: 'dismissed'});
        assert.equal(owner.state.storageError, failure);
        assert.deepEqual(storage.writes, []);
    }
);

test('An already requested installation write completes after final page detach',
    async function durableInstallationAfterDetach(context) {
        let releaseWrite;
        const writeGate = new Promise(function pendingInstallationWrite(resolve) {
            releaseWrite = resolve;
        });
        context.after(function releasePendingRecordWrite() { releaseWrite(); });
        const storage = installStorageFixture({writeGate});
        const {window} = browserFixture(context, {storage});
        const owner = getPwaInstall();
        await owner.ready;
        window.dispatchEvent(new Event('appinstalled'));
        await storage.writeStarted;
        window.dispatchEvent(new Event('pagehide'));
        assert.equal(owner.state.status, 'disposed');
        assert.equal(owner.state.installed, true);
        releaseWrite();
        await storage.writeFinished;
        assert.deepEqual(storage.records.get('pwa/installed.json'), {installed: true});
        assert.equal(owner.state.status, 'disposed');
        assert.equal(owner.state.available, false);
    }
);

test('A failed installation write remains observable after disposal without reopening promotion',
    async function failedInstallationWriteAfterDetach(context) {
        let releaseWrite;
        const writeGate = new Promise(function pendingFailedInstallationWrite(resolve) {
            releaseWrite = resolve;
        });
        context.after(function releasePendingFailedWrite() { releaseWrite(); });
        const failure = new Error('The installed record could not be written.');
        const storage = installStorageFixture({writeGate, writeError: failure});
        const {window} = browserFixture(context, {storage});
        const {warnings, warned} = captureStorageWarnings(context);
        const owner = getPwaInstall();
        await owner.ready;
        window.dispatchEvent(new Event('appinstalled'));
        await storage.writeStarted;
        owner.dispose();
        releaseWrite();
        await warned;
        assert.equal(owner.state.status, 'disposed');
        assert.equal(owner.state.installed, true);
        assert.equal(owner.state.available, false);
        assert.equal(owner.state.storageError, failure);
        assert.equal(owner.state.error, null);
        assert.equal(warnings.length, 1);
        assert.equal(warnings[0][1], failure);
        assert.equal(storage.records.has('pwa/installed.json'), false);
        assert.deepEqual(storage.writes, [['pwa', 'installed.json', {installed: true}]]);
    }
);

test('Installed app display mode is remembered and returning to a browser does not reopen promotion',
    async function durableInstalledDisplay(context) {
        const {window, display, installedDisplay, storage} = browserFixture(context, {running: true});
        const owner = getPwaInstall();
        assert.equal(owner.state.status, 'running');
        assert.equal(owner.state.installed, true);
        await owner.ready;
        await storage.writeFinished;
        display.matches = false;
        installedDisplay.matches = false;
        display.dispatchEvent(new Event('change'));
        installedDisplay.dispatchEvent(new Event('change'));
        assert.equal(owner.state.status, 'installed');
        assert.equal(owner.state.installed, true);
        assert.equal(owner.state.available, false);
        offerInstall(window, function forbiddenDisplayExitPrompt() {
            throw new Error('Leaving installed display mode must preserve the remembered installation.');
        });
        assert.equal(await owner.prompt(), null);
        assert.deepEqual(storage.writes, [['pwa', 'installed.json', {installed: true}]]);
    }
);

test('The iOS standalone signal records installation without a matching media query',
    async function durableNavigatorStandalone(context) {
        const {storage} = browserFixture(context, {standalone: true});
        const owner = getPwaInstall();
        assert.equal(owner.state.status, 'running');
        assert.equal(owner.state.installed, true);
        await owner.ready;
        await storage.writeFinished;
        assert.deepEqual(storage.writes, [['pwa', 'installed.json', {installed: true}]]);
    }
);

test('Generated PWA bootstrap starts install capture and worker registration independently',
    async function independentBootstrap() {
        const artifacts = createPwaArtifacts({
            app: {id: 'library', displayName: 'Example Library', version: '1.0.0', entry: './index.html'},
            sdkVersion: '0.13.0', pwa: {enabled: true, manifest: {name: 'Named Library'}}
        });
        const bootstrap = artifacts.files.find(function findBootstrap(file) {
            return file.path === 'arcane-pwa.mjs';
        }).content;
        const calls = [];
        const never = new Promise(function waitForNativeEligibility() {});
        const execute = new Function('mountPwaInstallPrompt', 'registerPwa',
            bootstrap.replace(/^import[^\n]+\n/u, '').replaceAll('import.meta.url', "'https://example.test/arcane-pwa.mjs'"));
        execute(function mountPrompt(options) { calls.push(['install', options]); return never; },
            function registerWorker(options) { calls.push(['worker', options]); return {ready: never}; });
        assert.deepEqual(calls, [
            ['install', {appName: 'Named Library'}],
            ['worker', {workerUrl: 'https://example.test/arcane-sw.js', scope: 'https://example.test/'}]
        ]);
    }
);

test('Removing a loading component or disposing its owner settles mounting and permits another attempt',
    async function cancelledComponentMount(context) {
        browserFixture(context);
        const originalObserver = Object.getOwnPropertyDescriptor(globalThis, 'MutationObserver');
        let observedRemoval;
        class RemovalObserver {
            constructor(callback) { observedRemoval = callback; }
            observe() {}
            disconnect() { observedRemoval = null; }
        }
        Object.defineProperty(globalThis, 'MutationObserver', {configurable: true, value: RemovalObserver});
        let appended;
        let element;
        document.documentElement = {};
        document.createElement = function createImportHost() {
            element = new EventTarget();
            element.dataset = {};
            element.setAttribute = function setHostAttribute(name, value) { element[name] = value; };
            element.remove = function removeHost() { element.isConnected = false; };
            return element;
        };
        document.body = {append(host) { host.isConnected = true; appended(host); }};
        const source = await readFile(new URL('../browser-runtime/pwa-install.mjs', import.meta.url), 'utf8');
        const execute = new Function('Is', 'arcaneEvents', 'createArcaneEventSource', 'loadModule', 'resolveModule', source
            .replace(/^import .+;\r?$/gmu, '')
            .replace(/^export /gmu, '')
            .replaceAll('import.meta.url', "'https://example.test/arcane/sdk/pwa-install.mjs'")
            .replaceAll('import.meta.resolve', 'resolveModule')
            .replaceAll('import(', 'loadModule(')
            + '\nreturn {getPwaInstall, mountPwaInstallPrompt};');
        const imported = [];
        const module = execute(Is, arcaneEvents, createArcaneEventSource, function loadManagedModule(specifier) {
            imported.push(specifier);
            return Promise.resolve({});
        }, function resolveManagedModule(specifier) {
            assert.equal(specifier, 'arcane-os/modules/HTMLImport.js');
            return 'https://example.test/node_modules/arcane-sdk/runtime/arcane/modules/HTMLImport.js';
        });
        try {
            let attached = new Promise(function firstAttachment(resolve) { appended = resolve; });
            const mounting = module.mountPwaInstallPrompt();
            const host = await attached;
            assert.ok(imported.includes('arcane-os/modules/HTMLImport.js'));
            assert.ok(imported.includes('arcane-os/modules/ThemeBootstrap.js'));
            assert.equal(host.href, 'https://example.test/node_modules/arcane-sdk/runtime/arcane/components/pwa-install.html');
            host.remove();
            observedRemoval();
            await assert.rejects(mounting, {name: 'AbortError'});

            attached = new Promise(function secondAttachment(resolve) { appended = resolve; });
            const retry = module.mountPwaInstallPrompt();
            assert.notEqual(retry, mounting);
            await attached;
            module.getPwaInstall().dispose();
            await assert.rejects(retry, {name: 'AbortError'});
            assert.equal(element.isConnected, false);
            assert.equal(observedRemoval, null);
        } finally {
            module.getPwaInstall().dispose();
            if (originalObserver) Object.defineProperty(globalThis, 'MutationObserver', originalObserver);
            else delete globalThis.MutationObserver;
        }
    }
);
