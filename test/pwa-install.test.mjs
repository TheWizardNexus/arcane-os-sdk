import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from '../src/testing.mjs';
import {PWA_INSTALL_STATE_EVENT, getPwaInstall} from '../browser-runtime/pwa.mjs';
import {createPwaArtifacts} from '../src/pwa.mjs';
import Is from '../browser-runtime/dependencies/strong-type/index.js';
import {createArcaneEventSource} from '../browser-runtime/event-manager.mjs';

function browserFixture(context, {stored = new Map(), running = false} = {}) {
    const window = new EventTarget();
    const display = new EventTarget();
    display.matches = running;
    const globals = {
        addEventListener: window.addEventListener.bind(window),
        removeEventListener: window.removeEventListener.bind(window),
        matchMedia: function matchDisplayMode() { return display; },
        document: {querySelector() { return {href: 'https://example.test/arcane.webmanifest'}; }},
        sessionStorage: {
            getItem(key) { return stored.get(key) ?? null; },
            setItem(key, value) { stored.set(key, value); }
        },
        navigator: {}
    };
    const previous = new Map();
    for (const [key, value] of Object.entries(globals)) {
        previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, {configurable: true, value});
    }
    context.after(function restoreBrowser() {
        getPwaInstall().dispose();
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    return {window, display, stored};
}

function offerInstall(window, prompt) {
    const event = new Event('beforeinstallprompt', {cancelable: true});
    event.prompt = prompt;
    window.dispatchEvent(event);
    return event;
}

test('Installation state replays availability and calls each native prompt once in the click stack',
    async function nativeInstallLifecycle(context) {
        const {window} = browserFixture(context);
        const owner = getPwaInstall();
        assert.equal(getPwaInstall(), owner);
        assert.equal(PWA_INSTALL_STATE_EVENT, 'arcane.pwa.install.state');
        assert.equal(owner.state.status, 'waiting');
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
        unsubscribe();
    }
);

test('Closing promotion persists for the tab session and retains installation for explicit controls',
    async function retainedInstallAfterDismissal(context) {
        const {window} = browserFixture(context);
        const owner = getPwaInstall();
        offerInstall(window, function nativePrompt() { return {outcome: 'accepted'}; });
        owner.dismiss();
        assert.equal(owner.state.dismissed, true);
        assert.equal(owner.state.available, true);
        assert.deepEqual(await owner.prompt(), {outcome: 'accepted'});
        owner.dispose();
        const nextPage = getPwaInstall();
        assert.equal(nextPage.state.dismissed, true);
        assert.equal(nextPage.state.available, false);
    }
);

test('Older prompt results use userChoice and browser dismissal suppresses later promotion',
    async function nativeUserChoice(context) {
        const {window} = browserFixture(context);
        const owner = getPwaInstall();
        const event = offerInstall(window, function nativePrompt() { return Promise.resolve(); });
        event.userChoice = Promise.resolve({outcome: 'dismissed'});
        assert.deepEqual(await owner.prompt(), {outcome: 'dismissed'});
        assert.equal(owner.state.status, 'dismissed');
        assert.equal(owner.state.dismissed, true);
        offerInstall(window, function laterPrompt() { return {outcome: 'accepted'}; });
        assert.equal(owner.state.available, true);
        assert.equal(owner.state.dismissed, true);
    }
);

test('Native prompt errors remain observable and do not reuse the consumed event',
    async function installPromptErrors(context) {
        const {window} = browserFixture(context);
        const owner = getPwaInstall();
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
        const {window, display} = browserFixture(context, {running: true});
        const owner = getPwaInstall();
        assert.equal(owner.state.status, 'running');
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

test('A late prompt choice cannot replace installed or disposed state',
    async function lateInstallChoice(context) {
        const {window} = browserFixture(context);
        const owner = getPwaInstall();
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
        owner.dispose();
        assert.equal(owner.state.status, 'disposed');
        const nextOwner = getPwaInstall();
        offerInstall(window, function pendingNextPrompt() {
            return new Promise(function pendingNextChoice(resolve) { resolveChoice = resolve; });
        });
        const nextResult = nextOwner.prompt();
        nextOwner.dispose();
        resolveChoice({outcome: 'accepted'});
        await nextResult;
        assert.equal(nextOwner.state.status, 'disposed');
        assert.equal(nextOwner.state.outcome, null);
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
            element.setAttribute = function setHostAttribute() {};
            element.remove = function removeHost() { element.isConnected = false; };
            return element;
        };
        document.body = {append(host) { host.isConnected = true; appended(host); }};
        const source = await readFile(new URL('../browser-runtime/pwa-install.mjs', import.meta.url), 'utf8');
        const execute = new Function('Is', 'createArcaneEventSource', 'loadModule', source
            .replace(/^import .+;\r?$/gmu, '')
            .replace(/^export /gmu, '')
            .replaceAll('import.meta.url', "'https://example.test/arcane/sdk/pwa-install.mjs'")
            .replaceAll('import(', 'loadModule(')
            + '\nreturn {getPwaInstall, mountPwaInstallPrompt};');
        const module = execute(Is, createArcaneEventSource, function loadManagedModule() {
            return Promise.resolve({});
        });
        try {
            let attached = new Promise(function firstAttachment(resolve) { appended = resolve; });
            const mounting = module.mountPwaInstallPrompt();
            const host = await attached;
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
