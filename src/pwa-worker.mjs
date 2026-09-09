export function createPwaWorkerScript(manifest, clientUrl = 'arcane/sdk/pwa.mjs') {
    return `(${installPwaWorker.toString()})(${JSON.stringify(manifest, null, 4)}, ${JSON.stringify(clientUrl)});\n`;
}

function installPwaWorker(manifest, clientUrl) {
    const scope = self.registration.scope;
    const scopeOrigin = new URL(scope).origin;
    const cachePrefix = `arcane-pwa|${JSON.stringify([manifest.appId, scope])}|`;
    const cacheName = `${cachePrefix}resources`;
    const manifestUrl = cacheUrl('arcane-offline.json');
    const protocolUrls = new Set([cacheUrl('arcane-pwa.mjs'), cacheUrl(clientUrl)]);
    const installationAssets = [...new Set(manifest.assets.map(cacheUrl))];
    const resourceJobs = new Map();
    const pendingChecks = new Set();
    const refreshJobs = new Map();
    const ownedUrls = new Set();
    const navigationAliases = new Map();
    let currentManifest = manifest;
    let refreshTask = null;
    let previousCaches = null;
    let manifestRestored = false;
    let lastChecked = null;

    function cacheUrl(value) {
        const url = new URL(value, scope);
        // Fragments identify document positions; query variants remain distinct resources.
        url.hash = '';
        return url.href;
    }

    function manifestResources(value) {
        if (!Array.isArray(value.assets) || !value.navigationAliases || typeof value.navigationAliases !== 'object') {
            throw new TypeError('The PWA offline inventory requires assets and navigationAliases.');
        }
        const assets = value.assets.map(cacheUrl);
        const aliases = Object.entries(value.navigationAliases).map(
            function navigationAlias([alias, asset]) {
                return [cacheUrl(alias), new URL(asset, scope).href];
            }
        );
        return {value, assets, aliases};
    }

    function useManifest({value, assets, aliases}) {
        currentManifest = value;
        ownedUrls.clear();
        for (const asset of assets) {
            ownedUrls.add(asset);
        }
        navigationAliases.clear();
        for (const [alias, asset] of aliases) {
            navigationAliases.set(alias, asset);
        }
    }

    async function readManifest(response) {
        return manifestResources(await response.json());
    }

    function errorDetails(error) {
        if (!(error instanceof Error)) {
            return error;
        }
        const detail = {name: error.name, message: error.message, stack: error.stack};
        if ('cause' in error) {
            detail.cause = errorDetails(error.cause);
        }
        if ('errors' in error) {
            detail.errors = Array.from(error.errors, errorDetails);
        }
        if ('url' in error) {
            detail.url = error.url;
        }
        return detail;
    }

    async function reportFailure(error) {
        const clients = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
        const message = {type: 'arcane.pwa.error', error: errorDetails(error)};
        for (const client of clients) {
            if (client.url.startsWith(scope)) {
                client.postMessage(message);
            }
        }
    }

    async function reportFailureAndReject(error) {
        try {
            await reportFailure(error);
        } catch (reportError) {
            console.error('PWA failure could not be sent to application clients.', reportError, error);
        }
        throw error;
    }

    function resourceError(url, cause) {
        const error = new Error(`PWA resource could not be cached: ${url}`, {cause});
        error.url = url;
        return error;
    }

    async function findCachedResource(url) {
        const cache = await caches.open(cacheName);
        const response = await cache.match(url);
        if (response) {
            return {cache, response, current: true};
        }
        // Carry existing app resources forward without deleting older generations.
        previousCaches ??= caches.keys().then(
            function openPriorCaches(names) {
                return Promise.all(
                    names.reverse().filter(
                        function priorAppCache(name) {
                            return name.startsWith(cachePrefix) && name !== cacheName;
                        }
                    ).map(
                        function openPriorCache(name) {
                            return caches.open(name);
                        }
                    )
                );
            }
        );
        for (const previous of await previousCaches) {
            const retained = await previous.match(url);
            if (retained) {
                return {cache, response: retained, current: false};
            }
        }
        return {cache, response: null, current: true};
    }

    async function restoreManifest() {
        const cached = await findCachedResource(manifestUrl);
        if (cached.response) {
            const inventory = await readManifest(cached.response);
            if (['appVersion', 'sdkVersion', 'mode', 'revision'].every(
                function sameWorkerDeclaration(field) {
                    return inventory.value[field] === manifest[field];
                }
            )) {
                useManifest(inventory);
            }
        }
    }

    useManifest(manifestResources(manifest));
    const restored = restoreManifest().catch(
        async function reportManifestRestoreFailure(error) {
            try {
                await reportFailure(error);
            } catch (reportError) {
                console.error('PWA manifest restore failure could not be reported.', reportError, error);
            }
        }
    ).finally(
        function manifestRestoreComplete() {
            manifestRestored = true;
        }
    );

    async function fetchResource(request, url, validate) {
        const cached = await findCachedResource(url);
        // Earlier clients cannot initiate this protocol; upgrade only its owners on migration.
        const protocolMigration = cached.response && !cached.current && protocolUrls.has(url);
        if (cached.response && !validate && !protocolMigration) {
            return {
                response: cached.response,
                saved: cached.current ? Promise.resolve() : cached.cache.put(url, cached.response.clone()),
                checked: false,
                error: null
            };
        }
        try {
            const headers = new Headers(request.headers);
            const modified = protocolMigration ? null : cached.response?.headers.get('last-modified');
            headers.delete('if-none-match');
            if (modified) {
                headers.set('if-modified-since', modified);
            } else {
                headers.delete('if-modified-since');
            }
            // This conditional request owns validation; CacheStorage owns the durable body.
            const response = await fetch(new Request(request, {headers, cache: 'no-store'}));
            if (response.status === 304 && cached.response) {
                return {
                    response: cached.response,
                    saved: cached.current ? Promise.resolve() : cached.cache.put(url, cached.response.clone()),
                    checked: true,
                    error: null
                };
            }
            if (!response.ok) {
                throw new Error(`PWA resource returned HTTP ${response.status} ${response.statusText}: ${url}`);
            }
            if (url === manifestUrl) {
                // Parse the control document before replacing the last usable inventory.
                await readManifest(response.clone());
            }
            return {
                response,
                saved: cached.cache.put(url, response.clone()),
                checked: true,
                error: null
            };
        } catch (cause) {
            const error = resourceError(url, cause);
            if (!cached.response) {
                throw error;
            }
            return {response: cached.response, saved: Promise.resolve(), checked: false, error};
        }
    }

    function resourceJob(request, url, validate = false) {
        if (resourceJobs.has(url)) {
            return resourceJobs.get(url);
        }
        const job = {result: fetchResource(request, url, validate), done: null, checked: false};
        resourceJobs.set(url, job);
        if (pendingChecks.has(url)) {
            refreshJobs.set(url, job);
        }
        job.done = job.result.then(
            async function finishResource(result) {
                job.checked = result.checked;
                try {
                    await result.saved;
                    return result.error;
                } catch (cause) {
                    return resourceError(url, cause);
                }
            },
            function missingResource(error) {
                return error;
            }
        ).then(
            function releaseResource(error) {
                resourceJobs.delete(url);
                pendingChecks.delete(url);
                if (refreshJobs.get(url) === job) {
                    // Retain cycle outcomes without retaining every completed response stream.
                    refreshJobs.set(url, {
                        result: Promise.resolve({checked: job.checked}),
                        done: Promise.resolve(error)
                    });
                }
                return error;
            }
        );
        return job;
    }

    function resourceResponse(result) {
        return result.response.clone();
    }

    async function populateResources(urls, validate = false) {
        let nextAsset = 0;
        const failures = [];
        let allChecked = true;
        async function fetchAssets() {
            while (nextAsset < urls.length) {
                const url = urls[nextAsset++];
                let job = (validate ? refreshJobs.get(url) : null) ?? resourceJob(new Request(url), url, validate);
                let error = await job.done;
                if (validate && !error && !(await job.result).checked) {
                    // A concurrent cache carry-forward is complete, but has not checked this file.
                    job = resourceJob(new Request(url), url, true);
                    error = await job.done;
                }
                if (error) {
                    failures.push(error);
                }
                if (error || !(await job.result).checked) {
                    allChecked = false;
                }
            }
        }
        const workers = [];
        for (let index = 0; index < Math.min(4, urls.length); index += 1) {
            workers.push(fetchAssets());
        }
        await Promise.all(workers);
        return {failures, allChecked};
    }

    async function populateCache() {
        await restored;
        const {failures, allChecked} = await populateResources(installationAssets);
        if (failures.length > 0) {
            throw new AggregateError(failures, 'The PWA resource generation could not be installed.');
        }
        if (allChecked) {
            lastChecked = Date.now();
        }
    }

    function onInstall(event) {
        event.waitUntil(populateCache().catch(reportFailureAndReject));
    }

    function checkDue() {
        const interval = currentManifest.mode === 'development' ? 120000 : 900000;
        return lastChecked === null || Date.now() - lastChecked > interval;
    }

    async function refreshResources() {
        await restored;
        if (!checkDue()) {
            return {lastChecked, error: null};
        }
        const failures = [];
        let inventory = resourceJob(new Request(manifestUrl), manifestUrl, true);
        let error = await inventory.done;
        if (!error && !(await inventory.result).checked) {
            inventory = resourceJob(new Request(manifestUrl), manifestUrl, true);
            error = await inventory.done;
        }
        if (error) {
            failures.push(error);
        } else {
            try {
                const result = await inventory.result;
                useManifest(await readManifest(result.response.clone()));
            } catch (cause) {
                failures.push(resourceError(manifestUrl, cause));
            }
        }
        const urls = [...ownedUrls].filter(
            function selectedResource(url) {
                return url !== manifestUrl;
            }
        );
        for (const url of urls) {
            pendingChecks.add(url);
        }
        const checked = await populateResources(urls, true);
        failures.push(...checked.failures);
        if (failures.length === 0) {
            lastChecked = Date.now();
        }
        return {
            lastChecked,
            error: failures.length > 0
                ? errorDetails(new AggregateError(failures, 'PWA resources could not all be updated.'))
                : null
        };
    }

    function refresh(checked) {
        if (Number.isFinite(checked)) {
            lastChecked = Math.max(lastChecked ?? 0, checked);
        }
        if (!refreshTask) {
            refreshTask = refreshResources().finally(
                function releaseRefresh() {
                    refreshTask = null;
                    refreshJobs.clear();
                }
            );
        }
        return refreshTask;
    }

    function onMessage(event) {
        if (event.data?.type === 'arcane.pwa.capabilities') {
            try {
                event.source?.postMessage({type: 'arcane.pwa.capabilities', refresh: true, cacheName});
            } catch (error) {
                event.waitUntil(reportFailureAndReject(error));
            }
            return;
        }
        if (event.data?.type !== 'arcane.pwa.refresh') {
            return;
        }
        const port = event.ports?.[0];
        event.waitUntil(
            refresh(event.data.lastChecked).then(
                async function completeRefresh(result) {
                    port?.postMessage({type: 'arcane.pwa.refreshed', ...result});
                    port?.close();
                    if (result.error) {
                        await reportFailure(result.error);
                    }
                },
                async function failRefresh(error) {
                    port?.postMessage({type: 'arcane.pwa.refreshed', lastChecked, error: errorDetails(error)});
                    port?.close();
                    await reportFailure(error);
                }
            ).catch(reportFailureAndReject)
        );
    }

    function navigationRedirect(url) {
        const exact = navigationAliases.get(url);
        if (exact) return {location: exact, resource: cacheUrl(exact)};
        const source = new URL(url);
        const query = source.search;
        if (!query) return null;
        source.search = '';
        const selected = navigationAliases.get(source.href);
        if (!selected) return null;
        const destination = new URL(selected);
        destination.search = destination.search ? `${destination.search}&${query.slice(1)}` : query;
        return {location: destination.href, resource: cacheUrl(selected)};
    }

    async function requestedResource(request, url) {
        await restored;
        const redirect = request.mode === 'navigate' ? navigationRedirect(url) : null;
        if (redirect && cacheUrl(redirect.location) !== url && ownedUrls.has(redirect.resource)) {
            return {response: Response.redirect(redirect.location, 302), done: Promise.resolve(null)};
        }
        if (!ownedUrls.has(url)) {
            return {response: await fetch(request), done: Promise.resolve(null)};
        }
        const cache = await caches.open(cacheName);
        const cached = await cache.match(url);
        if (cached) {
            return {response: cached, done: Promise.resolve(null)};
        }
        const job = resourceJob(request, url, pendingChecks.has(url));
        return {response: resourceResponse(await job.result), done: job.done};
    }

    function onFetch(event) {
        const request = event.request;
        if (request.method !== 'GET' || request.headers.has('range')) {
            return;
        }
        const url = cacheUrl(request.url);
        if (new URL(url).origin !== scopeOrigin && !ownedUrls.has(url)) {
            return;
        }
        if (manifestRestored && !ownedUrls.has(url)
            && !(request.mode === 'navigate' && navigationRedirect(url))) {
            return;
        }
        const resource = requestedResource(request, url);
        event.respondWith(
            resource.then(
                function requestedResponse(result) {
                    return result.response;
                }
            )
        );
        event.waitUntil(
            resource.then(
                async function completeRequestedResource(result) {
                    const error = await result.done;
                    if (error) {
                        throw error;
                    }
                }
            ).catch(reportFailureAndReject)
        );
    }

    self.addEventListener('install', onInstall);
    self.addEventListener('fetch', onFetch);
    self.addEventListener('message', onMessage);
}
