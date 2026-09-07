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

function workerFixture({manifest = workerManifest(), storage = cacheStore(), fetchResource} = {}) {
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
                return fetchResource ? fetchResource(request) : new Response(`original:${request.url}`);
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
        createPwaWorkerScript(manifest)
    ).runInContext(context);
    return {
        requests,
        messages,
        outsideMessages,
        diagnostics,
        storage,
        lifecycle(type) {
            const pending = [];
            handlers.get(type)(
                {
                    waitUntil(value) {
                        pending.push(value);
                    }
                }
            );
            return Promise.all(pending);
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
    assert.equal(storage.stores.size, 3);
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
                return name.includes('second-output');
            }
        )
    );
}

test(
    'PWA release generations preserve cached resources and retire only their own previous cache at activation',
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
                return request.cache === 'reload';
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
    let offline = false;
    const storage = cacheStore();
    const fixture = workerFixture(
        {
            storage,
            manifest: workerManifest(
                {mode: 'development', revision: 'development'}
            ),
            fetchResource() {
                if (offline) {
                    throw new Error('The network is offline.');
                }
                return new Response(content);
            }
        }
    );
    await fixture.lifecycle('install');
    content = 'second saved source';
    storage.pauseWrites();
    const request = fixture.request(`${scope}app.mjs`);
    const networkResponse = await request.response;
    assert.equal(
        await networkResponse.text(),
        'second saved source'
    );
    storage.resumeWrites();
    assert.deepEqual(
        await request.background,
        [{status: 'fulfilled', value: undefined}]
    );
    offline = true;
    const cached = fixture.request(`${scope}app.mjs`);
    const offlineResponse = await cached.response;
    assert.equal(
        await offlineResponse.text(),
        'second saved source'
    );
    await cached.background;
    assert.ok(
        fixture.requests.every(
            function revalidatedRequest(value) {
                return value.cache === 'no-cache';
            }
        )
    );
}

test(
    'PWA development returns network content before cache writes and reuses it when offline',
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
