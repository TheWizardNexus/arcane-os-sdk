import assert from 'node:assert/strict';
import {createContext, Script} from 'node:vm';
import test from '../src/testing.mjs';
import {createPwaRetirementWorkerScript, createPwaWorkerScript} from '../src/pwa-worker.mjs';
import {createPwaArtifacts} from '../src/pwa.mjs';

const scope = 'https://example.test/app/';

test(
    'retirement worker requests activation and unregisters only its own registration',
    async function retirePwaWorker() {
        const handlers = new Map();
        const calls = [];
        const installing = Promise.resolve();
        const unregistering = Promise.resolve(true);
        const context = createContext(
            {
                self: {
                    addEventListener(type, handler) {
                        handlers.set(type, handler);
                    },
                    skipWaiting() {
                        calls.push('skipWaiting');
                        return installing;
                    },
                    registration: {
                        unregister() {
                            calls.push('unregister');
                            return unregistering;
                        }
                    }
                }
            }
        );
        new Script(createPwaRetirementWorkerScript()).runInContext(context);
        assert.deepEqual(
            [...handlers.keys()],
            ['install', 'activate']
        );
        assert.equal(calls.length, 0);
        let pending;
        function waitUntil(value) {
            pending = value;
        }
        const event = {waitUntil};
        handlers.get('install')(event);
        assert.equal(pending, installing);
        await pending;
        assert.deepEqual(
            calls,
            ['skipWaiting']
        );
        handlers.get('activate')(event);
        assert.equal(pending, unregistering);
        await pending;
        assert.deepEqual(
            calls,
            ['skipWaiting', 'unregister']
        );
    }
);

function workerManifest(overrides = {}) {
    return {
        schemaVersion: 1,
        appId: 'example-app',
        appVersion: '1.0.0',
        sdkVersion: '0.10.0',
        revision: 'first-output',
        mode: 'release',
        assets: ['index.html', 'app.mjs'],
        navigationAliases: {'./': 'index.html'},
        ...overrides
    };
}

function cacheStore() {
    const stores = new Map();
    const pauses = [];
    let pausedUrl = null;
    return {
        stores,
        pauseWrites(url) {
            pausedUrl = url;
        },
        resumeWrites() {
            pausedUrl = null;
            for (const resume of pauses.splice(0)) {
                resume();
            }
        },
        async open(name) {
            if (!stores.has(name)) {
                stores.set(
                    name,
                    new Map()
                );
            }
            const entries = stores.get(name);
            return {
                async match(url) {
                    return entries.get(url)?.clone();
                },
                async delete(url) {
                    return entries.delete(url);
                },
                async put(url, response) {
                    if (url === pausedUrl) {
                        await new Promise(
                            function pauseCacheWrite(resolve) {
                                pauses.push(resolve);
                            }
                        );
                    }
                    entries.set(
                        url,
                        response.clone()
                    );
                }
            };
        },
        async keys() {
            return [...stores.keys()];
        },
        async delete(name) {
            return stores.delete(name);
        }
    };
}

function workerFixture({
    manifest = workerManifest(), storage = cacheStore(), fetchResource, now = Date.now,
    clientUrl, workerScope = scope, script
} = {}) {
    const handlers = new Map();
    const requests = [];
    const messages = [];
    const outsideMessages = [];
    const diagnostics = [];
    const context = createContext(
        {
            URL,
            Request,
            Response,
            Headers,
            Date: class WorkerDate extends Date {
                static now() {
                    return now();
                }
            },
            Error,
            AggregateError,
            caches: storage,
            console: {
                error(...values) {
                    diagnostics.push(values);
                }
            },
            async fetch(request) {
                requests.push(request);
                if (fetchResource) {
                    return fetchResource(request);
                }
                return new Response(
                    request.url === `${workerScope}arcane-offline.json` ? JSON.stringify(manifest) : `original:${request.url}`,
                    {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}}
                );
            },
            self: {
                registration: {scope: workerScope},
                addEventListener(type, handler) {
                    handlers.set(type, handler);
                },
                skipWaiting() {
                    throw new Error('The worker must preserve normal activation.');
                },
                clients: {
                    claim() {
                        throw new Error('The worker must preserve existing client control.');
                    },
                    async matchAll() {
                        return [
                            {
                                url: `${workerScope}index.html`,
                                postMessage(message) {
                                    messages.push(message);
                                }
                            },
                            {
                                url: 'https://example.test/another-app/',
                                postMessage(message) {
                                    outsideMessages.push(message);
                                }
                            }
                        ];
                    }
                }
            }
        }
    );
    new Script(
        script ?? createPwaWorkerScript(manifest, clientUrl)
    ).runInContext(context);
    return {
        requests,
        messages,
        outsideMessages,
        diagnostics,
        storage,
        lifecycle(type) {
            const pending = [];
            handlers.get(type)?.(
                {
                    waitUntil(value) {
                        pending.push(value);
                    }
                }
            );
            return Promise.all(pending);
        },
        refresh(lastChecked = null) {
            const pending = [];
            let result;
            handlers.get('message')(
                {
                    data: {type: 'arcane.pwa.refresh', lastChecked},
                    ports: [{postMessage(value) { result = value; }, close() {}}],
                    waitUntil(value) {
                        pending.push(value);
                    }
                }
            );
            return Promise.all(pending).then(
                function refreshCompleted() {
                    return result;
                }
            );
        },
        request(url, {method = 'GET', mode = 'cors', headers = {}} = {}) {
            const pending = [];
            let response;
            const request = new Request(
                url,
                {method, headers, credentials: 'same-origin'}
            );
            Object.defineProperty(
                request,
                'mode',
                {value: mode}
            );
            handlers.get('fetch')(
                {
                    request,
                    waitUntil(value) {
                        pending.push(value);
                    },
                    respondWith(value) {
                        response = value;
                    }
                }
            );
            return {request, response, background: Promise.allSettled(pending)};
        }
    };
}

async function releaseGenerations() {
    const storage = cacheStore();
    const userData = await storage.open('model-and-user-data');
    await userData.put(
        'record',
        new Response('preserved')
    );
    const first = workerFixture(
        {storage}
    );
    await first.lifecycle('install');
    const second = workerFixture(
        {
            storage,
            manifest: workerManifest(
                {revision: 'second-output'}
            )
        }
    );
    await second.lifecycle('install');
    assert.equal(storage.stores.size, 2);
    assert.equal(second.requests.length, 0);
    const moduleResponse = await first.request(`${scope}app.mjs`).response;
    assert.equal(
        await moduleResponse.text(),
        `original:${scope}app.mjs`
    );
    assert.equal(first.requests.length, 2);
    const navigation = first.request(
        scope,
        {mode: 'navigate'}
    );
    const documentResponse = await navigation.response;
    assert.equal(documentResponse.status, 302);
    assert.equal(documentResponse.headers.get('location'), `${scope}index.html`);
    const entry = await first.request(documentResponse.headers.get('location')).response;
    assert.equal(
        await entry.text(),
        `original:${scope}index.html`
    );
    assert.equal(
        first.request(`${scope}app.mjs?user=value`).response,
        undefined
    );
    assert.equal(
        first.request(
            `${scope}app.mjs`,
            {method: 'POST'}
        ).response,
        undefined
    );
    assert.equal(
        first.request(
            `${scope}app.mjs`,
            {headers: {range: 'bytes=0-20'}}
        ).response,
        undefined
    );
    assert.equal(
        first.request('https://provider.test/model').response,
        undefined
    );
    await second.lifecycle('activate');
    assert.equal(storage.stores.size, 2);
    const preservedRecord = await userData.match('record');
    assert.equal(
        await preservedRecord.text(),
        'preserved'
    );
    assert.ok(
        [...storage.stores.keys()].some(
            function currentGeneration(name) {
                return name.endsWith('|resources');
            }
        )
    );
}

test(
    'PWA release generations retain the same cached resources and preserve unrelated storage at activation',
    releaseGenerations
);

async function concurrentInstall() {
    let active = 0;
    let maximum = 0;
    const releases = [];
    let signalFirstPool;
    const firstPool = new Promise(
        function firstPoolReady(resolve) {
            signalFirstPool = resolve;
        }
    );
    const fixture = workerFixture(
        {
            manifest: workerManifest(
                {assets: ['one', 'two', 'three', 'four', 'five', 'six']}
            ),
            fetchResource(request) {
                active += 1;
                maximum = Math.max(maximum, active);
                if (active === 4) {
                    signalFirstPool();
                }
                if (fixture.requests.length > 4) {
                    active -= 1;
                    return new Response(request.url);
                }
                return new Promise(
                    function holdInitialFetch(resolve) {
                        releases.push(
                            function finishInitialFetch() {
                                active -= 1;
                                resolve(
                                    new Response(request.url)
                                );
                            }
                        );
                    }
                );
            }
        }
    );
    const install = fixture.lifecycle('install');
    await firstPool;
    assert.equal(fixture.requests.length, 4);
    for (const release of releases) {
        release();
    }
    await install;
    assert.equal(fixture.requests.length, 6);
    assert.equal(maximum, 4);
    assert.ok(
        fixture.requests.every(
            function reloadRequest(request) {
                return request.cache === 'no-store';
            }
        )
    );
}

test(
    'PWA installation fetches independent resources concurrently with a four-request pool',
    concurrentInstall
);

async function completeInstallFailures() {
    const fixture = workerFixture(
        {
            fetchResource(request) {
                throw new Error(`unavailable:${request.url}`);
            }
        }
    );
    await assert.rejects(
        fixture.lifecycle('install'),
        function allFailures(error) {
            assert.equal(error.errors.length, 2);
            assert.equal(error.errors[0].cause.message, `unavailable:${scope}index.html`);
            assert.equal(error.errors[1].cause.message, `unavailable:${scope}app.mjs`);
            return true;
        }
    );
    assert.equal(fixture.messages.length, 1);
    assert.equal(fixture.messages[0].type, 'arcane.pwa.error');
    assert.equal(fixture.messages[0].error.errors.length, 2);
    assert.equal(fixture.messages[0].error.errors[1].cause.message, `unavailable:${scope}app.mjs`);
    assert.equal(fixture.outsideMessages.length, 0);
}

test(
    'PWA installation preserves all resource failures and reports them to application clients',
    completeInstallFailures
);

async function developmentNetworkAndOffline() {
    let content = 'first saved source';
    let modified = 'Mon, 07 Sep 2026 00:00:00 GMT';
    let offline = false;
    let now = 1000000;
    let changedRequestStarted;
    const storage = cacheStore();
    const manifest = workerManifest(
        {mode: 'development', revision: 'development', assets: ['app.mjs', 'arcane-offline.json']}
    );
    const fixture = workerFixture(
        {
            storage,
            manifest,
            now() { return now; },
            fetchResource(request) {
                if (offline) {
                    throw new Error('The network is offline.');
                }
                const inventory = request.url === `${scope}arcane-offline.json`;
                const lastModified = inventory ? 'Mon, 07 Sep 2026 00:00:00 GMT' : modified;
                if (request.headers.get('if-modified-since') === lastModified) {
                    return new Response(null, {status: 304});
                }
                if (!inventory) {
                    changedRequestStarted?.();
                }
                return new Response(inventory ? JSON.stringify(manifest) : content, {headers: {'last-modified': lastModified}});
            }
        }
    );
    await fixture.lifecycle('install');
    content = '  second saved source\ncomplete second line\n';
    modified = 'Mon, 07 Sep 2026 00:02:01 GMT';
    now += 120001;
    const changedRequest = new Promise(
        function observeChangedRequest(resolve) {
            changedRequestStarted = resolve;
        }
    );
    storage.pauseWrites(`${scope}app.mjs`);
    const refreshing = fixture.refresh();
    await changedRequest;
    const request = fixture.request(`${scope}app.mjs`);
    const cachedResponse = await request.response;
    assert.equal(
        await cachedResponse.text(),
        'first saved source'
    );
    storage.resumeWrites();
    assert.deepEqual(
        await request.background,
        [{status: 'fulfilled', value: undefined}]
    );
    const updated = await refreshing;
    assert.equal(updated.error, null);
    assert.equal(updated.lastChecked, now);
    offline = true;
    now += 120001;
    const failed = await fixture.refresh(updated.lastChecked);
    assert.equal(failed.error.errors.length, 2);
    assert.equal(failed.lastChecked, updated.lastChecked);
    const cached = fixture.request(`${scope}app.mjs`);
    const offlineResponse = await cached.response;
    assert.equal(
        await offlineResponse.text(),
        content
    );
    await cached.background;
    assert.ok(
        fixture.requests.every(
            function revalidatedRequest(value) {
                return value.cache === 'no-store';
            }
        )
    );
}

test(
    'PWA serves cached content while conditional updates are saved and preserves complete content on offline failure',
    developmentNetworkAndOffline
);

test(
    'PWA Cache ownership ignores fragments and deduplicates equivalent selected URLs while preserving query variants',
    async function fragmentFreeCacheOwnership() {
        const fixture = workerFixture(
            {
                manifest: workerManifest(
                    {
                        assets: [
                            'index.html?language=en#first',
                            './index.html?language=en#second',
                            'index.html?language=en',
                            'app.mjs#one'
                        ],
                        navigationAliases: {'./#welcome': 'index.html?language=en#section'}
                    }
                )
            }
        );
        await fixture.lifecycle('install');
        assert.equal(fixture.requests.length, 2);
        const document = fixture.request(
            `${scope}#another-section`,
            {mode: 'navigate'}
        );
        const documentResponse = await document.response;
        assert.equal(documentResponse.status, 302);
        assert.equal(documentResponse.headers.get('location'), `${scope}index.html?language=en#section`);
        const entry = await fixture.request(documentResponse.headers.get('location')).response;
        assert.equal(
            await entry.text(),
            `original:${scope}index.html?language=en`
        );
        const module = fixture.request(`${scope}app.mjs#other`);
        const moduleResponse = await module.response;
        assert.equal(
            await moduleResponse.text(),
            `original:${scope}app.mjs`
        );
        assert.equal(
            fixture.request(`${scope}index.html?language=fr`).response,
            undefined
        );
        assert.equal(fixture.requests.length, 2);
    }
);

for (const workerScope of ['https://example.test/', 'https://example.test/releases/current/']) {
    test(`PWA navigation reuses selected static HTML and directory indexes at ${workerScope} without redirect or per-user cache entries`, async function staticDocumentQueryNavigation() {
        let offline = false;
        const manifest = workerManifest({assets: ['index.html', 'pages/notes.htm', 'chapters/index.html'], navigationAliases: {}});
        const fixture = workerFixture({
            manifest,
            workerScope,
            fetchResource(request) {
                if (offline) throw new Error('Static navigation must use the cached document.');
                return new Response(`Complete document:${request.url}\n  続き\n`);
            }
        });
        await fixture.lifecycle('install');
        offline = true;
        const cache = fixture.storage.stores.get(`arcane-pwa|${JSON.stringify([manifest.appId, workerScope])}|resources`);
        const installedEntries = [...cache.keys()].sort();
        const installedRequests = fixture.requests.length;
        for (const document of manifest.assets) {
            for (const query of ['?user=first&view=complete%20content&tag=a&tag=b', '?user=second']) {
                const url = `${workerScope}${document}${query}`;
                const navigation = fixture.request(url, {mode: 'navigate'});
                const response = await navigation.response;
                assert.equal(navigation.request.url, url);
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('location'), null);
                assert.equal(await response.text(), `Complete document:${workerScope}${document}\n  続き\n`);
                assert.deepEqual(await navigation.background, [{status: 'fulfilled', value: undefined}]);
            }
        }
        for (const directory of ['', 'chapters/']) {
            for (const query of ['', '?view=complete%20content&tag=first&tag=second']) {
                const url = `${workerScope}${directory}${query}`;
                const navigation = fixture.request(url, {mode: 'navigate'});
                const response = await navigation.response;
                assert.equal(navigation.request.url, url);
                assert.equal(response.status, 200);
                assert.equal(response.headers.get('location'), null);
                assert.equal(await response.text(), `Complete document:${workerScope}${directory}index.html\n  続き\n`);
                assert.deepEqual(await navigation.background, [{status: 'fulfilled', value: undefined}]);
            }
        }
        assert.equal(fixture.requests.length, installedRequests);
        assert.deepEqual([...cache.keys()].sort(), installedEntries);
        assert.deepEqual(fixture.messages, []);
        assert.deepEqual(fixture.diagnostics, []);
    });
}

test('PWA exact selected query variant takes precedence over its plain static document', async function exactNavigationVariant() {
    const variant = 'index.html?view=selected&tag=first&tag=second';
    const directoryVariant = '?view=selected&tag=first&tag=second';
    const manifest = workerManifest({assets: ['index.html', variant, directoryVariant], navigationAliases: {}});
    const fixture = workerFixture({manifest});
    await fixture.lifecycle('install');
    const cache = fixture.storage.stores.get(`arcane-pwa|${JSON.stringify([manifest.appId, scope])}|resources`);
    const installedEntries = [...cache.keys()].sort();
    const selected = fixture.request(`${scope}${variant}`, {mode: 'navigate'});
    assert.equal(await (await selected.response).text(), `original:${scope}${variant}`);
    await selected.background;
    const ordinary = fixture.request(`${scope}index.html?view=other`, {mode: 'navigate'});
    assert.equal(await (await ordinary.response).text(), `original:${scope}index.html`);
    await ordinary.background;
    const selectedDirectory = fixture.request(`${scope}${directoryVariant}`, {mode: 'navigate'});
    const directoryResponse = await selectedDirectory.response;
    assert.equal(directoryResponse.status, 200);
    assert.equal(directoryResponse.headers.get('location'), null);
    assert.equal(await directoryResponse.text(), `original:${scope}${directoryVariant}`);
    await selectedDirectory.background;
    const ordinaryDirectory = fixture.request(`${scope}?view=other`, {mode: 'navigate'});
    assert.equal(await (await ordinaryDirectory.response).text(), `original:${scope}index.html`);
    await ordinaryDirectory.background;
    assert.equal(fixture.requests.length, 3);
    cache.delete(`${scope}${variant}`);
    const evicted = fixture.request(`${scope}${variant}`, {mode: 'navigate'});
    assert.equal(await (await evicted.response).text(), `original:${scope}${variant}`);
    await evicted.background;
    assert.equal(fixture.requests.at(-1).url, `${scope}${variant}`);
    assert.equal(await cache.get(`${scope}index.html`).clone().text(), `original:${scope}index.html`);
    assert.deepEqual([...cache.keys()].sort(), installedEntries);
});

test('PWA exact selected query variant precedes a plain navigation alias while other alias redirects remain', async function selectedQueryAliasPrecedence() {
    const manifest = workerManifest({
        assets: ['dashboard.html?view=detail', 'alternate.html'],
        navigationAliases: {'dashboard.html': 'alternate.html'}
    });
    const fixture = workerFixture({manifest});
    await fixture.lifecycle('install');
    const exact = fixture.request(`${scope}dashboard.html?view=detail`, {mode: 'navigate'});
    const selected = await exact.response;
    assert.equal(selected.status, 200);
    assert.equal(selected.headers.get('location'), null);
    assert.equal(await selected.text(), `original:${scope}dashboard.html?view=detail`);
    await exact.background;
    for (const query of ['', '?view=other']) {
        const alias = fixture.request(`${scope}dashboard.html${query}`, {mode: 'navigate'});
        const redirected = await alias.response;
        assert.equal(redirected.status, 302);
        assert.equal(redirected.headers.get('location'), `${scope}alternate.html${query}`);
        await alias.background;
        const followed = fixture.request(redirected.headers.get('location'), {mode: 'navigate'});
        assert.equal(await (await followed.response).text(), `original:${scope}alternate.html`);
        await followed.background;
    }
    assert.equal(fixture.requests.length, 2);
    const cache = fixture.storage.stores.get(`arcane-pwa|${JSON.stringify([manifest.appId, scope])}|resources`);
    assert.deepEqual([...cache.keys()].sort(), manifest.assets.map(function selectedAsset(asset) {
        return new URL(asset, scope).href;
    }).sort());
});

test('PWA static query reuse leaves non-navigation, API, unselected and cross-origin requests unchanged', async function staticNavigationBoundaries() {
    const manifest = workerManifest({
        assets: ['index.html', 'api/records', 'app.mjs', 'https://provider.test/page.html']
    });
    const fixture = workerFixture({manifest});
    await fixture.lifecycle('install');
    const requests = fixture.requests.length;
    for (const [url, options] of [
        [`${scope}index.html?user=first`, {}],
        [`${scope}index.html?user=first`, {mode: 'navigate', method: 'POST'}],
        [`${scope}index.html?user=first`, {mode: 'navigate', headers: {range: 'bytes=0-20'}}],
        [`${scope}api/records?user=first`, {mode: 'navigate'}],
        [`${scope}app.mjs?user=first`, {mode: 'navigate'}],
        [`${scope}unselected.html?user=first`, {mode: 'navigate'}],
        ['https://provider.test/page.html?user=first', {mode: 'navigate'}],
        ['https://unselected.test/page.html?user=first', {mode: 'navigate'}]
    ]) {
        const untouched = fixture.request(url, options);
        assert.equal(untouched.response, undefined);
        assert.deepEqual(await untouched.background, []);
    }
    assert.equal(await (await fixture.request(`${scope}api/records`).response).text(), `original:${scope}api/records`);
    assert.equal(await (await fixture.request('https://provider.test/page.html').response).text(), 'original:https://provider.test/page.html');
    assert.equal(fixture.requests.length, requests);
});

test('PWA static query cache miss fetches the original request without caching its response or replacing the plain document', async function queryNavigationCacheMiss() {
    const manifest = workerManifest({assets: ['index.html']});
    let cache;
    let restorePlainDuringFetch = false;
    const fixture = workerFixture({
        manifest,
        fetchResource(request) {
            if (new URL(request.url).search) {
                if (restorePlainDuringFetch) {
                    cache.set(`${scope}index.html`, new Response('Complete independently restored static document.'));
                }
                return new Response(`Complete query response:${request.url}`);
            }
            return new Response('Complete original static document.');
        }
    });
    await fixture.lifecycle('install');
    cache = fixture.storage.stores.get(`arcane-pwa|${JSON.stringify([manifest.appId, scope])}|resources`);
    cache.delete(`${scope}index.html`);
    for (const query of ['?user=first', '?user=second']) {
        const url = `${scope}index.html${query}`;
        const navigation = fixture.request(url, {mode: 'navigate', headers: {'x-app-selection': 'complete value'}});
        const response = await navigation.response;
        await navigation.background;
        assert.equal(fixture.requests.at(-1), navigation.request);
        assert.equal(navigation.request.url, url);
        assert.equal(navigation.request.headers.get('x-app-selection'), 'complete value');
        assert.equal(navigation.request.cache, 'default');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('location'), null);
        assert.equal(await response.text(), `Complete query response:${url}`);
        assert.equal(cache.has(url), false);
        if (restorePlainDuringFetch) {
            assert.equal(await cache.get(`${scope}index.html`).clone().text(), 'Complete independently restored static document.');
        } else {
            assert.equal(cache.has(`${scope}index.html`), false);
        }
        restorePlainDuringFetch = true;
    }
    assert.equal(fixture.requests.length, 3);
});

for (const [mode, interval] of [['development', 120000], ['release', 900000]]) {
    test(`PWA ${mode} static query navigation preserves refresh cadence and update notification`, async function staticNavigationRefreshLifecycle() {
        let now = 1000000;
        let changed = false;
        const manifest = workerManifest({mode, assets: ['index.html', 'arcane-offline.json']});
        const fixture = workerFixture({
            manifest,
            now() { return now; },
            fetchResource(request) {
                const inventory = request.url === `${scope}arcane-offline.json`;
                const modified = changed && !inventory ? 'Mon, 07 Sep 2026 00:02:01 GMT' : 'Mon, 07 Sep 2026 00:00:00 GMT';
                if (request.headers.get('if-modified-since') === modified) return new Response(null, {status: 304});
                return new Response(inventory ? JSON.stringify(manifest) : changed ? 'Complete updated page.' : 'Complete original page.', {
                    headers: {'last-modified': modified}
                });
            }
        });
        await fixture.lifecycle('install');
        const installed = await fixture.refresh();
        assert.equal(installed.updateAvailable, false);
        changed = true;
        now += interval;
        const beforeCheck = fixture.request(`${scope}index.html?user=first`, {mode: 'navigate'});
        assert.equal(await (await beforeCheck.response).text(), 'Complete original page.');
        await beforeCheck.background;
        assert.equal((await fixture.refresh(installed.lastChecked)).updateAvailable, false);
        assert.equal(fixture.requests.length, 2);
        assert.deepEqual(fixture.messages, []);
        now += 1;
        const dueNavigation = fixture.request(`${scope}index.html?user=second`, {mode: 'navigate'});
        assert.equal(await (await dueNavigation.response).text(), 'Complete original page.');
        await dueNavigation.background;
        assert.equal(fixture.requests.length, 2);
        const refreshed = await fixture.refresh(installed.lastChecked);
        assert.equal(refreshed.error, null);
        assert.equal(refreshed.lastChecked, now);
        assert.equal(refreshed.updateAvailable, true);
        assert.equal(fixture.requests.length, 4);
        assert.equal(fixture.messages.length, 1);
        assert.equal(fixture.messages[0].type, 'arcane.pwa.refreshed');
        assert.equal(fixture.messages[0].updateAvailable, true);
        const updated = fixture.request(`${scope}index.html?user=third`, {mode: 'navigate'});
        assert.equal(await (await updated.response).text(), 'Complete updated page.');
        await updated.background;
        assert.equal(fixture.requests.length, 4);
        const cache = fixture.storage.stores.get(`arcane-pwa|${JSON.stringify([manifest.appId, scope])}|resources`);
        assert.deepEqual([...cache.keys()].sort(), [`${scope}arcane-offline.json`, `${scope}index.html`].sort());
    });
}

for (const [name, prior, next, status, changed] of [
    ['304', 'Mon, 07 Sep 2026 00:00:00 GMT', null, 304, false],
    ['same validator', 'Mon, 07 Sep 2026 00:00:00 GMT', 'Mon, 07 Sep 2026 00:00:00 GMT', 200, false],
    ['missing new validator', 'Mon, 07 Sep 2026 00:00:00 GMT', null, 200, false],
    ['missing prior validator', null, 'Mon, 07 Sep 2026 00:02:01 GMT', 200, false],
    ['unreadable validator', 'Mon, 07 Sep 2026 00:00:00 GMT', 'unknown', 200, false],
    ['server-declared modification', 'Mon, 07 Sep 2026 00:00:00 GMT', 'Mon, 07 Sep 2026 00:02:01 GMT', 200, true]
]) {
    test(`PWA update evidence distinguishes ${name} without comparing response content`, async function changedResourceEvidence() {
        let now = 1000000;
        let refreshing = false;
        const manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'arcane-offline.json']});
        const fixture = workerFixture({
            manifest,
            now() { return now; },
            fetchResource(request) {
                if (request.url.endsWith('arcane-offline.json')) {
                    return refreshing ? new Response(null, {status: 304}) : new Response(JSON.stringify(manifest));
                }
                if (refreshing && status === 304) return new Response(null, {status});
                const modified = refreshing ? next : prior;
                return new Response(refreshing ? 'complete replacement\n  続き\n' : 'complete original\n', {
                    headers: modified ? {'last-modified': modified} : {}
                });
            }
        });
        await fixture.lifecycle('install');
        assert.equal((await fixture.refresh()).updateAvailable, false);
        assert.deepEqual(fixture.messages, []);
        refreshing = true;
        now += 120001;
        const result = await fixture.refresh();
        assert.equal(result.error, null);
        assert.equal(result.updateAvailable, changed);
        assert.equal(fixture.messages.length, changed ? 1 : 0);
        if (changed) {
            assert.equal(fixture.messages[0].type, 'arcane.pwa.refreshed');
            assert.equal(fixture.messages[0].updateAvailable, true);
        }
        assert.deepEqual(fixture.outsideMessages, []);
        const response = await fixture.request(`${scope}app.mjs`).response;
        assert.equal(await response.text(), status === 304 ? 'complete original\n' : 'complete replacement\n  続き\n');
        const cache = [...fixture.storage.stores.values()][0];
        assert.equal(cache.has(`${scope}.arcane-pwa/refresh-state`), false);
    });
}

test('PWA initial fill and eviction repair stay quiet while a durable inventory addition announces an update', async function inventoryChangeEvidence() {
    let now = 1000000;
    let manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'arcane-offline.json']});
    const fixture = workerFixture({
        manifest,
        now() { return now; },
        fetchResource(request) {
            return new Response(request.url.endsWith('arcane-offline.json') ? JSON.stringify(manifest) : `complete:${request.url}`);
        }
    });
    const initial = await fixture.refresh();
    assert.equal(initial.updateAvailable, false);
    assert.deepEqual(fixture.messages, []);
    const cache = [...fixture.storage.stores.values()][0];
    cache.delete(`${scope}app.mjs`);
    now += 120001;
    assert.equal((await fixture.refresh()).updateAvailable, false);
    manifest = {...manifest, assets: [...manifest.assets, 'new.mjs']};
    now += 120001;
    assert.equal((await fixture.refresh()).updateAvailable, true);
    assert.equal(fixture.messages.length, 1);
    assert.equal(cache.has(`${scope}new.mjs`), true);
    assert.equal(fixture.requests.some(function metadataFetched(request) {
        return request.url === `${scope}.arcane-pwa/refresh-state`;
    }), false);
});

for (const modifiedResource of [true, false]) {
    test(`PWA partial evidence and prior inventory survive worker termination with modified resource ${modifiedResource}`, async function retainedPartialEvidence() {
        const storage = cacheStore();
        let now = 1000000;
        const initial = workerManifest({mode: 'development', assets: ['app.mjs', 'other.mjs', 'arcane-offline.json']});
        const expanded = modifiedResource ? initial : {...initial, assets: [...initial.assets, 'new.mjs']};
        const first = workerFixture({manifest: initial, storage, now() { return now; }});
        await first.lifecycle('install');
        const installed = await first.refresh();
        now += 120001;
        const partial = workerFixture({
            manifest: initial, storage, now() { return now; },
            fetchResource(request) {
                if (request.url.endsWith('arcane-offline.json')) return new Response(JSON.stringify(expanded));
                if (request.url.endsWith('new.mjs')) return new Response('not ready', {status: 503});
                if (request.url.endsWith('other.mjs')) return new Response('not ready', {status: 503});
                return modifiedResource
                    ? new Response('complete replacement', {headers: {'last-modified': 'Mon, 07 Sep 2026 00:02:01 GMT'}})
                    : new Response(null, {status: 304});
            }
        });
        const failed = await partial.refresh(installed.lastChecked);
        assert.ok(failed.error);
        assert.equal(failed.updateAvailable, false);
        assert.equal(partial.messages.some(function updateMessage(message) { return message.updateAvailable === true; }), false);
        const cache = [...storage.stores.values()][0];
        const pending = await cache.get(`${scope}.arcane-pwa/refresh-state`).clone().json();
        assert.equal(pending.changed, modifiedResource);
        assert.equal(pending.assets.includes(`${scope}new.mjs`), false);
        if (modifiedResource) {
            assert.deepEqual(pending.assets, initial.assets.map(function absoluteAsset(asset) {
                return new URL(asset, scope).href;
            }));
            assert.equal(pending.previousModified[`${scope}app.mjs`], Date.parse('Mon, 07 Sep 2026 00:00:00 GMT'));
        }
        const restarted = workerFixture({
            manifest: initial, storage, now() { return now; },
            fetchResource(request) {
                return request.url.endsWith('new.mjs') ? new Response('complete new resource') : new Response(null, {status: 304});
            }
        });
        const complete = await restarted.refresh(installed.lastChecked);
        assert.equal(complete.error, null);
        assert.equal(complete.updateAvailable, true);
        assert.equal(restarted.messages.length, 1);
        assert.equal(cache.has(`${scope}.arcane-pwa/refresh-state`), false);
        const nextPage = workerFixture({manifest: initial, storage, now() { return now; }});
        assert.equal((await nextPage.refresh(complete.lastChecked)).updateAvailable, false);
        assert.deepEqual(nextPage.messages, []);
    });
}

for (const failurePhase of ['before replacement', 'after replacement']) {
    test(`PWA recovers actual resource changes when refresh metadata fails ${failurePhase}`, async function metadataWriteRecovery() {
        const storage = cacheStore();
        const open = storage.open;
        const manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'arcane-offline.json']});
        let rejectMetadata = false;
        let replacementSaved = false;
        storage.open = async function openWithMetadataFailure(name) {
            const cache = await open(name);
            const put = cache.put;
            cache.put = async function writeResourceOrMetadata(url, response) {
                if (rejectMetadata && url === `${scope}.arcane-pwa/refresh-state`) {
                    const pending = await response.clone().json();
                    if (pending.previousModified && (failurePhase === 'before replacement' || replacementSaved)) {
                        throw new Error(`Metadata failed ${failurePhase}.`);
                    }
                }
                await put(url, response);
                if (rejectMetadata && url === `${scope}app.mjs`) replacementSaved = true;
            };
            return cache;
        };
        let now = 1000000;
        const installed = workerFixture({manifest, storage, now() { return now; }});
        await installed.lifecycle('install');
        now += 120001;
        rejectMetadata = true;
        const partial = workerFixture({
            manifest, storage, now() { return now; },
            fetchResource(request) {
                if (request.url.endsWith('arcane-offline.json')) return new Response(null, {status: 304});
                return new Response('complete changed resource\n', {
                    headers: {'last-modified': 'Mon, 07 Sep 2026 00:02:01 GMT'}
                });
            }
        });
        const failed = await partial.refresh();
        assert.ok(failed.error);
        assert.equal(failed.updateAvailable, false);
        assert.equal(replacementSaved, failurePhase === 'after replacement');
        assert.equal(partial.messages.some(function updateMessage(message) { return message.updateAvailable === true; }), false);
        rejectMetadata = false;
        const restarted = workerFixture({
            manifest, storage, now() { return now; },
            fetchResource() { return new Response(null, {status: 304}); }
        });
        const result = await restarted.refresh();
        assert.equal(result.error, null);
        assert.equal(result.updateAvailable, replacementSaved);
        assert.equal(restarted.messages.length, replacementSaved ? 1 : 0);
        const response = await restarted.request(`${scope}app.mjs`).response;
        assert.equal(await response.text(), replacementSaved ? 'complete changed resource\n' : `original:${scope}app.mjs`);
        const cache = [...storage.stores.values()][0];
        assert.equal(cache.has(`${scope}.arcane-pwa/refresh-state`), false);
    });
}

test('PWA incomplete initial population stays initial after worker termination', async function initialPopulationRestart() {
    const manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'new.mjs', 'arcane-offline.json']});
    const storage = cacheStore();
    const partial = workerFixture({
        manifest, storage,
        fetchResource(request) {
            if (request.url.endsWith('new.mjs')) return new Response('not ready', {status: 503});
            return new Response(request.url.endsWith('arcane-offline.json') ? JSON.stringify(manifest) : 'complete initial resource');
        }
    });
    assert.equal((await partial.refresh()).updateAvailable, false);
    const cache = [...storage.stores.values()][0];
    assert.equal((await cache.get(`${scope}.arcane-pwa/refresh-state`).clone().json()).assets, null);
    const restarted = workerFixture({
        manifest, storage,
        fetchResource(request) {
            return request.url.endsWith('new.mjs') ? new Response('complete new resource') : new Response(null, {status: 304});
        }
    });
    const result = await restarted.refresh();
    assert.equal(result.error, null);
    assert.equal(result.updateAvailable, false);
    assert.deepEqual(restarted.messages, []);
    assert.equal(cache.has(`${scope}.arcane-pwa/refresh-state`), false);
});

test('PWA refresh can replace an unreadable prior inventory without claiming an inventory change', async function unreadablePriorInventory() {
    const manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'arcane-offline.json']});
    const storage = cacheStore();
    const cache = await storage.open(`arcane-pwa|${JSON.stringify([manifest.appId, scope])}|resources`);
    await cache.put(`${scope}arcane-offline.json`, new Response('{'));
    const fixture = workerFixture({manifest, storage});
    const result = await fixture.refresh();
    assert.equal(result.error, null);
    assert.equal(result.updateAvailable, false);
    assert.equal(fixture.diagnostics.some(function priorInventoryDiagnostic(values) {
        return values[0] === 'PWA update detection could not read the prior inventory.';
    }), true);
    assert.deepEqual(await (await cache.match(`${scope}arcane-offline.json`)).json(), manifest);
});

test('PWA failed cache writes cannot announce a completed update', async function updateWaitsForCacheWrites() {
    const storage = cacheStore();
    const open = storage.open;
    let rejectWrite = false;
    storage.open = async function openWithWriteFailure(name) {
        const cache = await open(name);
        const put = cache.put;
        cache.put = async function writeResource(url, response) {
            if (rejectWrite && url === `${scope}app.mjs`) throw new Error('Resource storage failed.');
            return put(url, response);
        };
        return cache;
    };
    let now = 1000000;
    const manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'arcane-offline.json']});
    const fixture = workerFixture({
        manifest, storage, now() { return now; },
        fetchResource(request) {
            return new Response(request.url.endsWith('arcane-offline.json') ? JSON.stringify(manifest) : 'complete content', {
                headers: {'last-modified': rejectWrite ? 'Mon, 07 Sep 2026 00:02:01 GMT' : 'Mon, 07 Sep 2026 00:00:00 GMT'}
            });
        }
    });
    await fixture.lifecycle('install');
    rejectWrite = true;
    now += 120001;
    const result = await fixture.refresh();
    assert.ok(result.error);
    assert.equal(result.updateAvailable, false);
    assert.equal(fixture.messages.some(function updateMessage(message) { return message.updateAvailable === true; }), false);
});

test(
    'authored navigation aliases retain complete query fields without merging resource cache entries',
    async function preserveAuthoredNavigationQuery() {
        const fixture = workerFixture(
            {
                manifest: workerManifest(
                    {
                        navigationAliases: {
                            './': 'index.html',
                            './reading-room/': 'index.html',
                            './reading-room/index.html': 'index.html'
                        }
                    }
                )
            }
        );
        await fixture.lifecycle('install');
        const query = '?view=complete%20content&tag=first&tag=second';
        const navigation = fixture.request(
            `${scope}reading-room/index.html${query}`,
            {mode: 'navigate'}
        );
        const response = await navigation.response;
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), `${scope}index.html${query}`);
        assert.equal(fixture.requests.length, 2);
        assert.equal(fixture.request(`${scope}app.mjs${query}`).response, undefined);
    }
);

test('root worker inventory refresh retires the alias without serving retained unselected index content', async function rootInventoryRefresh() {
    const appId = 'retained-root-app';
    const rootScope = 'https://example.test/';
    const artifacts = createPwaArtifacts({
        app: {id: appId, displayName: 'Retained root application', version: '1.0.0', entry: '/secondary.html'},
        sdkVersion: '0.27.1', pwa: {enabled: true}, mode: 'development',
        basePath: '/', appBase: '/', installationId: `/apps/${appId}/`,
        runtimeBase: '/node_modules/arcane-os/browser-runtime/',
        assets: ['/secondary.html', '/modules/App.js', '/node_modules/arcane-os/browser-runtime/pwa.mjs'],
        navigationAliases: {}
    });
    assert.equal(artifacts.manifest.id, `/apps/${appId}/`);
    assert.equal(artifacts.manifest.scope, '/');
    assert.deepEqual(artifacts.files.map(function generatedPath(file) { return file.path; }), [
        'arcane.webmanifest', 'arcane-offline.json', 'arcane-sw.js', 'arcane-pwa.mjs'
    ]);
    const inventoryFile = artifacts.files.find(function rootInventory(file) {
        return file.path === 'arcane-offline.json';
    });
    const inventory = JSON.parse(inventoryFile.content);
    assert.ok(inventory.assets.includes('/node_modules/arcane-os/browser-runtime/pwa.mjs'));
    assert.ok(inventory.assets.includes('/arcane-offline.json'));
    const oldManifest = workerManifest({
        appId, sdkVersion: '0.26.0', mode: 'development',
        assets: ['index.html', 'arcane-offline.json'], navigationAliases: {'./': 'index.html'}
    });
    const storage = cacheStore();
    const savedData = await storage.open('application-saved-data');
    await savedData.put('conversation', new Response('Complete saved conversation.'));
    let now = 1000000;
    let deployed = false;
    const fixture = workerFixture({
        manifest: oldManifest, storage, workerScope: rootScope, now() { return now; },
        fetchResource(request) {
            const content = request.url === `${rootScope}arcane-offline.json`
                ? JSON.stringify(deployed ? inventory : oldManifest)
                : `Complete content:${request.url}`;
            return new Response(content, {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}});
        }
    });
    await fixture.lifecycle('install');
    const cachedPage = await fixture.request(`${rootScope}index.html`, {mode: 'navigate'}).response;
    assert.equal(await cachedPage.text(), `Complete content:${rootScope}index.html`);
    deployed = true;
    now += 120001;
    const refreshed = await fixture.refresh();
    assert.equal(refreshed.error, null);
    assert.ok(fixture.requests.some(function fetchedRootInventory(request) {
        return request.url === `${rootScope}arcane-offline.json`;
    }));
    for (const query of ['', '?view=host&tag=first&tag=second']) {
        const navigation = fixture.request(`${rootScope}${query}`, {mode: 'navigate'});
        assert.equal(navigation.response, undefined);
        assert.deepEqual(await navigation.background, []);
    }
    const retainedCache = storage.stores.get(`arcane-pwa|${JSON.stringify([appId, rootScope])}|resources`);
    assert.equal(await retainedCache.get(`${rootScope}index.html`).clone().text(), `Complete content:${rootScope}index.html`);
    assert.equal(await (await savedData.match('conversation')).text(), 'Complete saved conversation.');
});

test('generated root worker uses portable npm resources and retains navigation query and target fragment', async function portableRootWorker() {
    const appId = 'portable-root-app';
    const packageRoot = 'https://example.test/releases/current/';
    const artifacts = createPwaArtifacts({
        app: {id: appId, displayName: 'Portable root application', version: '1.0.0', entry: './index.html'},
        sdkVersion: '0.27.1', pwa: {enabled: true},
        runtimeBase: './node_modules/arcane-sdk/browser-runtime/',
        files: ['index.html', 'modules/App.js', 'node_modules/arcane-sdk/browser-runtime/pwa.mjs'],
        navigationAliases: {
            './': './index.html#last-turn'
        }
    });
    const byPath = new Map(artifacts.files.map(function artifactPath(file) { return [file.path, file.content]; }));
    assert.deepEqual([...byPath.keys()], ['arcane.webmanifest', 'arcane-offline.json', 'arcane-sw.js', 'arcane-pwa.mjs']);
    const inventory = JSON.parse(byPath.get('arcane-offline.json'));
    assert.ok(inventory.assets.includes('./index.html'));
    assert.ok(inventory.assets.includes('./node_modules/arcane-sdk/browser-runtime/pwa.mjs'));
    assert.equal(inventory.navigationAliases['./'], './index.html#last-turn');
    const script = byPath.get('arcane-sw.js');
    assert.ok(script.includes('"./node_modules/arcane-sdk/browser-runtime/pwa.mjs"'));
    const fixture = workerFixture({
        manifest: inventory, script, workerScope: packageRoot,
        fetchResource(request) {
            const relative = new URL(request.url).pathname.slice(new URL(packageRoot).pathname.length);
            return new Response(byPath.get(relative) ?? `Complete content:${request.url}`);
        }
    });
    await fixture.lifecycle('install');
    await fixture.lifecycle('activate');
    const query = '?view=complete%20content&tag=first&tag=second';
    const navigation = await fixture.request(`${packageRoot}${query}#position`, {mode: 'navigate'}).response;
    assert.equal(navigation.status, 302);
    assert.equal(navigation.headers.get('location'), `${packageRoot}index.html${query}#last-turn`);
    const requestsBeforeFollow = fixture.requests.length;
    const followed = fixture.request(navigation.headers.get('location'), {mode: 'navigate'});
    const target = await followed.response;
    assert.equal(target.status, 200);
    assert.equal(target.headers.get('location'), null);
    assert.equal(await target.text(), `Complete content:${packageRoot}index.html`);
    await followed.background;
    assert.equal(fixture.requests.length, requestsBeforeFollow);
    assert.ok(fixture.requests.some(function fetchedRootModule(request) {
        return request.url === `${packageRoot}node_modules/arcane-sdk/browser-runtime/pwa.mjs`;
    }));
});

for (const [mode, interval] of [['development', 120000], ['release', 900000]]) {
    test(
        `PWA ${mode} page checks retain 304 bodies and wait until strictly after the app check interval`,
        async function pageLoadCadence() {
            let now = 1000000;
            const modified = 'Mon, 07 Sep 2026 00:00:00 GMT';
            const manifest = workerManifest({mode, assets: ['app.mjs?language=en', 'arcane-offline.json']});
            const fixture = workerFixture({
                manifest,
                now() { return now; },
                fetchResource(request) {
                    if (request.headers.get('if-modified-since') === modified) {
                        return new Response(null, {status: 304});
                    }
                    return new Response(
                        request.url.endsWith('arcane-offline.json') ? JSON.stringify(manifest) : '  complete cached text\nsecond line\n',
                        {headers: {'last-modified': modified}}
                    );
                }
            });
            await fixture.lifecycle('install');
            const cache = [...fixture.storage.stores.values()][0];
            const retained = cache.get(`${scope}app.mjs?language=en`);
            const installed = await fixture.refresh();
            assert.equal(fixture.requests.length, 2);
            now += interval;
            await fixture.refresh(installed.lastChecked);
            assert.equal(fixture.requests.length, 2);
            now += 1;
            const checked = await fixture.refresh(installed.lastChecked);
            assert.equal(fixture.requests.length, 4);
            assert.equal(cache.get(`${scope}app.mjs?language=en`), retained);
            assert.equal(checked.lastChecked, now);
            const result = await fixture.request(`${scope}app.mjs?language=en`).response;
            assert.equal(await result.text(), '  complete cached text\nsecond line\n');
            assert.equal(fixture.requests.length, 4);
            assert.equal(fixture.requests[3].method, 'GET');
            assert.equal(fixture.requests[3].cache, 'no-store');
            assert.equal(fixture.requests[3].headers.get('if-modified-since'), modified);
            assert.equal(fixture.request(`${scope}api/live-records`).response, undefined);
            assert.equal(fixture.request(`${scope}app.mjs?language=fr`).response, undefined);
        }
    );
}

test(
    'PWA page refresh persists newly selected inventory and repairs evicted resources without a version bump',
    async function liveInventoryAndEviction() {
        let now = 1000000;
        let offline = false;
        const initial = workerManifest({mode: 'development', assets: ['app.mjs', 'arcane-offline.json']});
        let current = initial;
        let modified = 'Mon, 07 Sep 2026 00:00:00 GMT';
        const storage = cacheStore();
        const fixture = workerFixture({
            manifest: initial,
            storage,
            now() { return now; },
            fetchResource(request) {
                if (offline) {
                    throw new Error('The origin is offline.');
                }
                const control = request.url.endsWith('arcane-offline.json');
                const lastModified = control ? modified : 'Mon, 07 Sep 2026 00:00:00 GMT';
                if (request.headers.get('if-modified-since') === lastModified) {
                    return new Response(null, {status: 304});
                }
                return new Response(control ? JSON.stringify(current, null, 4) : `complete:${request.url}\n`, {headers: {'last-modified': lastModified}});
            }
        });
        await fixture.lifecycle('install');
        const firstChecks = await fixture.refresh();
        current = {...initial, assets: [...initial.assets, 'downloads/new%20notes.txt']};
        modified = 'Mon, 07 Sep 2026 00:02:01 GMT';
        now += 120001;
        const refreshed = await fixture.refresh(firstChecks.lastChecked);
        assert.equal(refreshed.error, null);
        const newUrl = `${scope}downloads/new%20notes.txt`;
        const selected = await fixture.request(newUrl).response;
        assert.equal(await selected.text(), `complete:${newUrl}\n`);
        const cache = [...storage.stores.values()][0];
        assert.equal(await cache.get(`${scope}arcane-offline.json`).clone().text(), JSON.stringify(current, null, 4));
        cache.delete(newUrl);
        const recovered = fixture.request(newUrl);
        assert.equal(await (await recovered.response).text(), `complete:${newUrl}\n`);
        await recovered.background;
        assert.equal(fixture.requests.at(-1).headers.get('if-modified-since'), null);
        offline = true;
        const restarted = workerFixture({manifest: initial, storage, fetchResource() { throw new Error('No network during offline restart.'); }});
        assert.equal(await (await restarted.request(newUrl).response).text(), `complete:${newUrl}\n`);
        assert.equal(restarted.requests.length, 0);
    }
);

test(
    'PWA installation carries earlier caches forward and retains a new worker declaration over older cached metadata',
    async function olderCacheNewWorker() {
        const storage = cacheStore();
        const oldManifest = workerManifest({mode: 'development', assets: ['old.html', 'arcane-offline.json'], navigationAliases: {'./': 'old.html'}});
        const previousCacheName = `arcane-pwa|${JSON.stringify([oldManifest.appId, scope])}|previous-output`;
        const previousCache = await storage.open(previousCacheName);
        await previousCache.put(`${scope}old.html`, new Response('retained old page'));
        await previousCache.put(`${scope}arcane-offline.json`, new Response(JSON.stringify(oldManifest)));
        const current = workerManifest({mode: 'release', revision: 'new-output', sdkVersion: '0.11.1', assets: ['new.html', 'old.html', 'arcane-offline.json'], navigationAliases: {'./': 'new.html'}});
        let now = 1000000;
        let offline = false;
        const fixture = workerFixture({
            manifest: current,
            storage,
            now() { return now; },
            fetchResource(request) {
                if (offline) {
                    throw new Error('The new deployment is offline.');
                }
                return new Response(`original:${request.url}`);
            }
        });
        await fixture.lifecycle('install');
        await fixture.lifecycle('activate');
        assert.equal(storage.stores.has(previousCacheName), true);
        assert.deepEqual(fixture.requests.map(function requestedUrl(request) { return request.url; }), [`${scope}new.html`]);
        const navigation = await fixture.request(scope, {mode: 'navigate'}).response;
        assert.equal(navigation.headers.get('location'), `${scope}new.html`);
        const recentCheck = now;
        now += 120001;
        await fixture.refresh(recentCheck);
        assert.equal(fixture.requests.length, 1);
        assert.equal(await (await fixture.request(`${scope}old.html`).response).text(), 'retained old page');
        offline = true;
        now = recentCheck + 900001;
        const failed = await fixture.refresh(recentCheck);
        assert.equal(failed.lastChecked, recentCheck);
        assert.equal(failed.error.errors.length, 3);
        const offlineNavigation = await fixture.request(scope, {mode: 'navigate'}).response;
        assert.equal(offlineNavigation.headers.get('location'), `${scope}new.html`);
    }
);

test(
    'PWA partial refresh retains cached failures and does not advance the app check timestamp',
    async function failedRefreshRetainsCache() {
        let now = 1000000;
        let fail = false;
        let invalidInventory = '{"assets":null,"navigationAliases":{}}';
        const manifest = workerManifest({mode: 'development', assets: ['app.mjs', 'changed.mjs', 'arcane-offline.json']});
        const fixture = workerFixture({
            manifest,
            now() { return now; },
            fetchResource(request) {
                const control = request.url.endsWith('arcane-offline.json');
                if (fail) {
                    if (request.url.endsWith('changed.mjs')) {
                        return new Response('complete updated module\n', {headers: {'last-modified': 'Mon, 07 Sep 2026 00:02:01 GMT'}});
                    }
                    return control ? new Response(invalidInventory) : new Response('complete upstream failure', {status: 503});
                }
                return new Response(control ? JSON.stringify(manifest) : 'complete retained module\n', {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}});
            }
        });
        await fixture.lifecycle('install');
        const initial = await fixture.refresh();
        fail = true;
        now += 120001;
        const result = await fixture.refresh(initial.lastChecked);
        assert.equal(result.error.errors.length, 2);
        assert.deepEqual(result.lastChecked, initial.lastChecked);
        assert.equal(await (await fixture.request(`${scope}app.mjs`).response).text(), 'complete retained module\n');
        assert.equal(await (await fixture.request(`${scope}changed.mjs`).response).text(), 'complete updated module\n');
        assert.equal(await (await fixture.request(`${scope}arcane-offline.json`).response).text(), JSON.stringify(manifest));
        assert.equal(fixture.messages.at(-1).error.errors.length, 2);
        invalidInventory = '{"assets":["http://["],"navigationAliases":{}}';
        const unreadableUrl = await fixture.refresh(initial.lastChecked);
        assert.equal(unreadableUrl.error.errors.length, 2);
        assert.equal(unreadableUrl.lastChecked, initial.lastChecked);
        assert.equal(await (await fixture.request(`${scope}arcane-offline.json`).response).text(), JSON.stringify(manifest));
    }
);

test(
    'PWA serves cached page requests before pending conditional checks complete through four workers',
    async function concurrentPageRefresh() {
        let now = 1000000;
        let updating = false;
        let active = 0;
        let maximum = 0;
        let poolStarted;
        const releases = new Map();
        const pool = new Promise(function observeRefreshPool(resolve) { poolStarted = resolve; });
        const assets = ['one.mjs', 'two.mjs', 'three.mjs', 'four.mjs', 'five.mjs', 'six.mjs', 'arcane-offline.json'];
        const manifest = workerManifest({mode: 'development', assets});
        const fixture = workerFixture({
            manifest,
            now() { return now; },
            fetchResource(request) {
                if (request.url.endsWith('arcane-offline.json')) {
                    return updating ? new Response(null, {status: 304}) : new Response(JSON.stringify(manifest), {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}});
                }
                if (!updating) {
                    return new Response('original complete body', {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}});
                }
                active += 1;
                maximum = Math.max(maximum, active);
                if (request.url.endsWith('five.mjs') || request.url.endsWith('six.mjs')) {
                    active -= 1;
                    return new Response(null, {status: 304});
                }
                return new Promise(
                    function pendingResource(resolve) {
                        releases.set(request.url, function releaseResource() {
                            active -= 1;
                            resolve(new Response(`updated complete body:${request.url}`, {headers: {'last-modified': 'Mon, 07 Sep 2026 00:02:01 GMT'}}));
                        });
                        if (releases.size === 4) {
                            poolStarted();
                        }
                    }
                );
            }
        });
        await fixture.lifecycle('install');
        updating = true;
        now += 120001;
        const refresh = fixture.refresh();
        await pool;
        const first = fixture.request(`${scope}one.mjs`);
        const second = fixture.request(`${scope}one.mjs`);
        const queued = fixture.request(`${scope}five.mjs`);
        assert.equal(await (await first.response).text(), 'original complete body');
        assert.equal(await (await second.response).text(), 'original complete body');
        assert.equal(await (await queued.response).text(), 'original complete body');
        await first.background;
        await second.background;
        await queued.background;
        assert.equal(active, 4);
        for (const release of releases.values()) {
            release();
        }
        const refreshed = await refresh;
        assert.equal(refreshed.error, null);
        assert.equal(refreshed.lastChecked, now);
        assert.equal(await (await fixture.request(`${scope}one.mjs`).response).text(), `updated complete body:${scope}one.mjs`);
        assert.equal(await (await fixture.request(`${scope}five.mjs`).response).text(), 'original complete body');
        assert.equal(maximum, 4);
        assert.equal(fixture.requests.filter(function firstResource(request) { return request.url === `${scope}one.mjs`; }).length, 2);
        assert.equal(fixture.requests.filter(function queuedResource(request) { return request.url === `${scope}five.mjs`; }).length, 2);
    }
);

test(
    'PWA old-cache migration refreshes only the exact SDK protocol owners once',
    async function protocolOwnerMigration() {
        const storage = cacheStore();
        const clientUrl = '../shared/sdk/pwa.mjs';
        const assets = ['app.mjs', 'arcane-pwa.mjs', clientUrl, 'arcane-offline.json'];
        const previousManifest = workerManifest({assets});
        const previousCacheName = `arcane-pwa|${JSON.stringify([previousManifest.appId, scope])}|old-worker`;
        const previousCache = await storage.open(previousCacheName);
        for (const asset of assets) {
            const url = new URL(asset, scope).href;
            await previousCache.put(url, new Response(
                asset === 'arcane-offline.json' ? JSON.stringify(previousManifest) : `retained:${url}`,
                {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}}
            ));
        }
        const manifest = workerManifest({assets, revision: 'new-worker'});
        const fixture = workerFixture({storage, manifest, clientUrl});
        await fixture.lifecycle('install');
        const protocolUrls = [`${scope}arcane-pwa.mjs`, new URL(clientUrl, scope).href].sort();
        assert.deepEqual(fixture.requests.map(function requestedProtocol(request) { return request.url; }).sort(), protocolUrls);
        assert.ok(fixture.requests.every(function protocolTransfer(request) { return request.cache === 'no-store' && request.headers.get('if-modified-since') === null; }));
        assert.equal(await (await fixture.request(`${scope}app.mjs`).response).text(), `retained:${scope}app.mjs`);
        assert.equal(await (await fixture.request(new URL(clientUrl, scope).href).response).text(), `original:${new URL(clientUrl, scope).href}`);
        assert.equal(storage.stores.has(previousCacheName), true);
        const next = workerFixture({storage, manifest, clientUrl});
        await next.lifecycle('install');
        assert.equal(next.requests.length, 0);
    }
);
