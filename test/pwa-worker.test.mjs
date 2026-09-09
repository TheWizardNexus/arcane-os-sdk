import assert from 'node:assert/strict';
import {createContext, Script} from 'node:vm';
import test from '../src/testing.mjs';
import {createPwaWorkerScript} from '../src/pwa-worker.mjs';

const scope = 'https://example.test/app/';

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
    let pauseWrites = false;
    return {
        stores,
        pauseWrites() {
            pauseWrites = true;
        },
        resumeWrites() {
            pauseWrites = false;
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
                async put(url, response) {
                    if (pauseWrites) {
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

function workerFixture({manifest = workerManifest(), storage = cacheStore(), fetchResource, now = Date.now, clientUrl} = {}) {
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
                    request.url === `${scope}arcane-offline.json` ? JSON.stringify(manifest) : `original:${request.url}`,
                    {headers: {'last-modified': 'Mon, 07 Sep 2026 00:00:00 GMT'}}
                );
            },
            self: {
                registration: {scope},
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
                                url: `${scope}index.html`,
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
        createPwaWorkerScript(manifest, clientUrl)
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
            return {response, background: Promise.allSettled(pending)};
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
    storage.pauseWrites();
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

test(
    'relocated navigation aliases retain complete query fields without merging resource cache entries',
    async function preserveRelocatedNavigationQuery() {
        const fixture = workerFixture(
            {
                manifest: workerManifest(
                    {
                        navigationAliases: {
                            './': 'index.html',
                            './apps/example-app/': 'index.html',
                            './apps/example-app/index.html': 'index.html'
                        }
                    }
                )
            }
        );
        await fixture.lifecycle('install');
        const query = '?view=complete%20content&tag=first&tag=second';
        const navigation = fixture.request(
            `${scope}apps/example-app/index.html${query}`,
            {mode: 'navigate'}
        );
        const response = await navigation.response;
        assert.equal(response.status, 302);
        assert.equal(response.headers.get('location'), `${scope}index.html${query}`);
        assert.equal(fixture.requests.length, 2);
        assert.equal(fixture.request(`${scope}app.mjs${query}`).response, undefined);
    }
);

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
        const legacyName = `arcane-pwa|${JSON.stringify([oldManifest.appId, scope])}|previous-output`;
        const legacy = await storage.open(legacyName);
        await legacy.put(`${scope}old.html`, new Response('retained old page'));
        await legacy.put(`${scope}arcane-offline.json`, new Response(JSON.stringify(oldManifest)));
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
        assert.equal(storage.stores.has(legacyName), true);
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
        const legacyName = `arcane-pwa|${JSON.stringify([previousManifest.appId, scope])}|old-worker`;
        const legacy = await storage.open(legacyName);
        for (const asset of assets) {
            const url = new URL(asset, scope).href;
            await legacy.put(url, new Response(
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
        assert.equal(storage.stores.has(legacyName), true);
        const next = workerFixture({storage, manifest, clientUrl});
        await next.lifecycle('install');
        assert.equal(next.requests.length, 0);
    }
);
