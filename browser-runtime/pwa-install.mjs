import Is from './dependencies/strong-type/index.js';
import {createArcaneEventSource} from './event-manager.mjs';

const is = new Is(false);
export const PWA_INSTALL_STATE_EVENT = 'arcane.pwa.install.state';
let sharedOwner = null;
let mountedPrompt = null;

/** Capture native installation availability once per page, before loading UI. */
export function getPwaInstall() {
    if (sharedOwner && sharedOwner.state.status !== 'disposed') {
        return sharedOwner;
    }
    const owner = {get state() { return snapshot(); }, subscribe, prompt, dismiss, dispose};
    const source = createArcaneEventSource(owner, {
        source: 'arcane.pwa.install', eventTypes: [PWA_INSTALL_STATE_EVENT]
    });
    const listeners = [];
    const displayMode = globalThis.matchMedia?.(
        '(display-mode: standalone), (display-mode: minimal-ui), '
        + '(display-mode: fullscreen), (display-mode: window-controls-overlay)'
    );
    const manifestUrl = globalThis.document?.querySelector('link[rel~="manifest"]')?.href;
    const dismissalKey = `arcane.pwa.install.dismissed:${manifestUrl ?? globalThis.location?.href ?? ''}`;
    let deferredPrompt = null;
    let disposed = false;
    let dismissed = false;
    let status = isRunningAsApp() ? 'running' : 'waiting';
    let outcome = null;
    let error = null;
    try {
        dismissed = globalThis.sessionStorage?.getItem(dismissalKey) === 'true';
    } catch (storageError) {
        console.warn('Arcane PWA install dismissal could not be read:', storageError);
    }

    function isRunningAsApp() {
        return displayMode?.matches === true || globalThis.navigator?.standalone === true;
    }

    function snapshot() {
        return {status, available: deferredPrompt !== null && !disposed,
            dismissed, outcome, error};
    }

    function publish(nextStatus, nextError = null) {
        if (disposed) return;
        status = nextStatus;
        error = nextError;
        source.dispatch(PWA_INSTALL_STATE_EVENT, snapshot());
    }

    function observe(target, type, listener) {
        if (!is.function(target?.addEventListener)) return;
        target.addEventListener(type, listener);
        listeners.push(function removeInstallListener() {
            target.removeEventListener(type, listener);
        });
    }

    function rememberDismissal() {
        dismissed = true;
        try {
            globalThis.sessionStorage?.setItem(dismissalKey, 'true');
        } catch (storageError) {
            console.warn('Arcane PWA install dismissal could not be saved:', storageError);
        }
    }

    function onBeforeInstallPrompt(event) {
        if (disposed || isRunningAsApp() || status === 'installed' || status === 'accepted') return;
        event.preventDefault();
        deferredPrompt = event;
        outcome = null;
        publish('available');
    }

    function onInstalled() {
        deferredPrompt = null;
        // This event may precede Android's completion of WebAPK creation.
        publish('installed');
    }

    function onDisplayModeChange() {
        if (isRunningAsApp()) {
            deferredPrompt = null;
            publish('running');
        } else if (status === 'running') {
            publish('waiting');
        }
    }

    function onPageHide(event) {
        if (!event.persisted) dispose();
    }

    function subscribe(listener, {emitCurrent = true, signal} = {}) {
        function forwardInstallState(event) { listener(event.detail); }
        const unsubscribe = source.on(PWA_INSTALL_STATE_EVENT, forwardInstallState,
            signal ? {signal} : undefined);
        try {
            if (emitCurrent && !signal?.aborted) listener(snapshot());
        } catch (listenerError) {
            unsubscribe();
            throw listenerError;
        }
        return unsubscribe;
    }

    function prompt() {
        if (disposed || !deferredPrompt) return Promise.resolve(null);
        const event = deferredPrompt;
        deferredPrompt = null;
        publish('prompting');
        let result;
        try {
            // Native user activation must reach prompt() in the same click stack.
            result = event.prompt();
        } catch (promptError) {
            return rejectPrompt(promptError);
        }
        return Promise.resolve(result).then(async function receiveInstallChoice(value) {
            const choice = value ?? await event.userChoice;
            if (!choice || !['accepted', 'dismissed'].includes(choice.outcome)) {
                throw new Error('The browser did not return an installation choice.');
            }
            if (!disposed) {
                outcome = choice.outcome;
                if (status === 'installed' || status === 'running') {
                    publish(status);
                } else {
                    if (outcome === 'dismissed') rememberDismissal();
                    publish(outcome);
                }
            }
            return choice;
        }).catch(rejectPrompt);
    }

    function rejectPrompt(promptError) {
        if (status !== 'installed' && status !== 'running') publish('error', promptError);
        return Promise.reject(promptError);
    }

    function dismiss() {
        if (disposed) return snapshot();
        rememberDismissal();
        publish(status, error);
        return snapshot();
    }

    function dispose() {
        if (disposed) return;
        deferredPrompt = null;
        publish('disposed');
        disposed = true;
        for (const removeListener of listeners) removeListener();
        listeners.length = 0;
        source.dispose();
    }

    observe(globalThis, 'beforeinstallprompt', onBeforeInstallPrompt);
    observe(globalThis, 'appinstalled', onInstalled);
    observe(displayMode, 'change', onDisplayModeChange);
    observe(globalThis, 'pagehide', onPageHide);
    sharedOwner = owner;
    return owner;
}

/** Mount one shared, initially hidden install component without delaying the app. */
export function mountPwaInstallPrompt({appName = ''} = {}) {
    const owner = getPwaInstall();
    if (mountedPrompt) return mountedPrompt;
    mountedPrompt = mountComponent().catch(function releaseFailedMount(error) {
        mountedPrompt = null;
        throw error;
    });
    return mountedPrompt;

    async function mountComponent() {
        if (!globalThis.document) return null;
        // Both modules may start independently; saved theme loading is not a barrier.
        await Promise.all([
            import(new URL('../modules/HTMLImport.js', import.meta.url).href),
            import(new URL('../modules/ThemeBootstrap.js', import.meta.url).href)
        ]);
        if (owner.state.status === 'disposed') return null;
        if (!document.body) {
            await new Promise(function waitForComponentParent(resolve) {
                const unsubscribe = owner.subscribe(function observeParentWaitDisposal(state) {
                    if (state.status === 'disposed') completeParentWait();
                }, {emitCurrent: false});
                function completeParentWait() {
                    document.removeEventListener('DOMContentLoaded', completeParentWait);
                    unsubscribe();
                    resolve();
                }
                document.addEventListener('DOMContentLoaded', completeParentWait, {once: true});
            });
        }
        if (owner.state.status === 'disposed') return null;
        const host = document.createElement('html-import');
        host.hidden = true;
        host.dataset.appName = String(appName);
        host.dataset.arcanePwaInstall = '';
        host.setAttribute('href', new URL('../components/pwa-install.html', import.meta.url).href);
        return new Promise(function waitForInstallComponent(resolve, reject) {
            const observer = new MutationObserver(function observeRemovedInstallComponent() {
                if (!host.isConnected) cancelMount();
            });
            const unsubscribe = owner.subscribe(function observeDisposedInstallOwner(state) {
                if (state.status === 'disposed') cancelMount();
            }, {emitCurrent: false});
            function cleanup() {
                observer.disconnect();
                unsubscribe();
                host.removeEventListener('html-import-ready', onReady);
                host.removeEventListener('html-import-error', onError);
            }
            function cancelMount() {
                cleanup();
                host.remove();
                const error = new Error('The PWA install component was removed before it became ready.');
                error.name = 'AbortError';
                reject(error);
            }
            function onReady() {
                cleanup();
                resolve(host);
            }
            function onError(event) {
                cleanup();
                host.remove();
                reject(event.detail?.error ?? new Error('The PWA install component could not load.'));
            }
            host.addEventListener('html-import-ready', onReady);
            host.addEventListener('html-import-error', onError);
            document.body.append(host);
            observer.observe(document.documentElement, {childList: true, subtree: true});
        });
    }
}
