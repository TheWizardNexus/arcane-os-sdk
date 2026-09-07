export function createPwaWorkerScript(manifest) {
    return `(${installPwaWorker.toString()})(${JSON.stringify(manifest, null, 4)});\n`;
}

function installPwaWorker(manifest) {
    const scope = self.registration.scope;
    const cachePrefix = `arcane-pwa|${JSON.stringify(
        [manifest.appId, scope]
    )}|`;
    const cacheName = cachePrefix + JSON.stringify(
        [
            manifest.appVersion,
            manifest.sdkVersion,
            manifest.mode,
            manifest.revision
        ]
    );

    function cacheUrl(value) {
        const url = new URL(value, scope);
        // Cache matching excludes fragments; preserve queries and the original network request.
        url.hash = '';
        return url.href;
    }

    const assetUrls = [
        ...new Set(
            manifest.assets.map(cacheUrl)
        )
    ];
    const ownedUrls = new Set(assetUrls);
    const navigationAliases = new Map();
    for (const [alias, asset] of Object.entries(manifest.navigationAliases)) {
        navigationAliases.set(
            cacheUrl(alias),
            new URL(asset, scope).href
        );
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
        const clients = await self.clients.matchAll(
            {type: 'window', includeUncontrolled: true}
        );
        const message = {type: 'arcane.pwa.error', error: errorDetails(error)};
        for (const client of clients) {
            if (client.url.startsWith(scope)) {
                client.postMessage(message);
            }
        }
    }

    async function populateCache() {
        const cache = await caches.open(cacheName);
        const failures = [];
        let nextAsset = 0;

        async function fetchAssets() {
            while (nextAsset < assetUrls.length) {
                const url = assetUrls[nextAsset++];
                try {
                    const response = await fetch(
                        new Request(
                            url,
                            {cache: manifest.mode === 'development' ? 'no-cache' : 'reload'}
                        )
                    );
                    if (!response.ok) {
                        throw new Error(`PWA resource returned HTTP ${response.status} ${response.statusText}: ${url}`);
                    }
                    await cache.put(url, response);
                } catch (cause) {
                    const error = new Error(
                        `PWA resource could not be cached: ${url}`,
                        {cause}
                    );
                    error.url = url;
                    failures.push(error);
                }
            }
        }

        const workers = [];
        for (let index = 0; index < Math.min(4, assetUrls.length); index += 1) {
            workers.push(
                fetchAssets()
            );
        }
        await Promise.all(workers);
        if (failures.length > 0) {
            throw new AggregateError(failures, 'The PWA resource generation could not be installed.');
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

    function onInstall(event) {
        event.waitUntil(
            populateCache().catch(reportFailureAndReject)
        );
    }

    async function retireOldCaches() {
        const names = await caches.keys();
        const retirements = [];
        for (const name of names) {
            if (name.startsWith(cachePrefix) && name !== cacheName) {
                retirements.push(
                    caches.delete(name)
                );
            }
        }
        await Promise.all(retirements);
    }

    function onActivate(event) {
        event.waitUntil(
            retireOldCaches().catch(reportFailureAndReject)
        );
    }

    async function releaseResource(request, url) {
        const cache = await caches.open(cacheName);
        const cached = await cache.match(url);
        if (cached) {
            return cached;
        }
        return fetch(
            new Request(
                request,
                {cache: 'no-cache'}
            )
        );
    }

    async function developmentResource(request, url) {
        let response;
        try {
            response = await fetch(
                new Request(
                    request,
                    {cache: 'no-cache'}
                )
            );
        } catch (error) {
            const cache = await caches.open(cacheName);
            const cached = await cache.match(url);
            if (cached) {
                return {response: cached, fromNetwork: false, url};
            }
            throw error;
        }
        return {response, fromNetwork: true, url};
    }

    function resourceResponse(resource) {
        return resource.response;
    }

    async function saveDevelopmentResource(resource) {
        if (resource.fromNetwork && resource.response.ok) {
            const response = resource.response.clone();
            const cache = await caches.open(cacheName);
            await cache.put(resource.url, response);
        }
    }

    function onFetch(event) {
        const request = event.request;
        if (request.method !== 'GET' || request.headers.has('range')) {
            return;
        }
        const requestUrl = cacheUrl(request.url);
        const redirect = request.mode === 'navigate' ? navigationAliases.get(requestUrl) : null;
        if (redirect && cacheUrl(redirect) !== requestUrl && ownedUrls.has(cacheUrl(redirect))) {
            // Navigation retains its requested document URL unless it follows a redirect.
            event.respondWith(
                Response.redirect(redirect, 302)
            );
            return;
        }
        const url = requestUrl;
        if (!ownedUrls.has(url)) {
            return;
        }
        if (manifest.mode === 'development') {
            const resource = developmentResource(request, url);
            event.waitUntil(
                resource.then(saveDevelopmentResource).catch(reportFailureAndReject)
            );
            event.respondWith(
                resource.then(resourceResponse)
            );
            return;
        }
        event.respondWith(
            releaseResource(request, url).catch(reportFailureAndReject)
        );
    }

    self.addEventListener('install', onInstall);
    self.addEventListener('activate', onActivate);
    self.addEventListener('fetch', onFetch);
}
