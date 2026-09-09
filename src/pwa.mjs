import Is from 'strong-type';
import {randomUUID} from 'node:crypto';
import {createPwaWorkerScript} from './pwa-worker.mjs';
import {versionAssetUrl} from './import-map.mjs';

const is = new Is(false);

export const PWA_MANIFEST_NAME = 'arcane.webmanifest';
export const PWA_OFFLINE_MANIFEST_NAME = 'arcane-offline.json';
export const PWA_WORKER_NAME = 'arcane-sw.js';
export const PWA_BOOTSTRAP_NAME = 'arcane-pwa.mjs';

function record(value, label) {
    if (value === null || !is.object(value) || is.array(value)) {
        throw new TypeError(`${label} must be an object.`);
    }
    return value;
}

function pathList(value, label) {
    function invalidPath(item) {
        return !is.string(item) || !item;
    }
    if (!is.array(value) || value.some(invalidPath)) {
        throw new TypeError(`${label} must be an array of nonempty paths.`);
    }
    return [...value];
}

export function normalizePwaConfig(value) {
    if (value === undefined) return undefined;
    record(value, 'pwa');
    for (const key of Object.keys(value)) {
        if (!['enabled', 'manifest', 'offline'].includes(key)) {
            throw new TypeError(`pwa contains an unsupported field: ${key}.`);
        }
    }
    if (value.enabled !== undefined && !is.boolean(value.enabled)) {
        throw new TypeError('pwa.enabled must be a boolean.');
    }
    const manifest = record(
        value.manifest === undefined ? {} : value.manifest,
        'pwa.manifest'
    );
    const offline = record(
        value.offline === undefined ? {} : value.offline,
        'pwa.offline'
    );
    for (const key of Object.keys(offline)) {
        if (key !== 'include' && key !== 'exclude') {
            throw new TypeError(`pwa.offline contains an unsupported field: ${key}.`);
        }
    }
    return {
        enabled: value.enabled === true,
        manifest: {...manifest},
        offline: {
            include: pathList(
                offline.include === undefined ? [] : offline.include,
                'pwa.offline.include'
            ),
            exclude: pathList(
                offline.exclude === undefined ? [] : offline.exclude,
                'pwa.offline.exclude'
            )
        }
    };
}

function selectedPath(file, selection) {
    const prefix = selection.endsWith('/') ? selection : `${selection}/`;
    return file === selection || file.startsWith(prefix);
}

export function selectPwaFiles(files, pwa, appPath = '') {
    const config = normalizePwaConfig(pwa);
    const include = config?.offline.include ?? [];
    const exclude = config?.offline.exclude ?? [];
    const appPrefix = appPath ? `${appPath}/` : '';
    return files.filter(
        function selectedOfflineFile(file) {
            const relative = appPrefix && file.startsWith(appPrefix)
                ? file.slice(appPrefix.length) : file;
            function includedPath(selection) {
                return selectedPath(relative, selection);
            }
            function excludedPath(selection) {
                return selectedPath(relative, selection);
            }
            return (include.length === 0 || include.some(includedPath))
                && !exclude.some(excludedPath);
        }
    );
}

function resourceUrl(basePath, file) {
    const encoded = file.split('/').map(
        function encodePathSegment(segment) {
            return encodeURIComponent(segment);
        }
    ).join('/');
    return `${basePath.endsWith('/') ? basePath : `${basePath}/`}${encoded}`;
}

function json(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function htmlAttribute(value) {
    return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}

function manifestUrl(value, appBase) {
    if (!is.string(value) || !value || value.startsWith('/')
        || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || /^\s/u.test(value)) {
        return value;
    }
    const base = new URL(appBase, 'https://arcane.invalid/');
    const resolved = new URL(value, base);
    const relative = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return appBase.startsWith('/') ? relative : `.${relative}`;
}

function manifestImages(images, appBase) {
    if (!is.array(images)) return images;
    return images.map(
        function mapManifestImage(image) {
            if (image === null || !is.object(image) || is.array(image)) return image;
            if (!Object.hasOwn(image, 'src')) return {...image};
            const url = manifestUrl(image.src, appBase);
            return {...image, src: versionAssetUrl(url, null)};
        }
    );
}

function applicationManifest(value, appBase) {
    const manifest = {...value};
    for (const field of ['id', 'start_url', 'scope']) {
        if (Object.hasOwn(manifest, field)) {
            manifest[field] = manifestUrl(manifest[field], appBase);
        }
    }
    for (const field of ['icons', 'screenshots']) {
        if (Object.hasOwn(manifest, field)) {
            manifest[field] = manifestImages(manifest[field], appBase);
        }
    }
    if (is.array(manifest.shortcuts)) {
        manifest.shortcuts = manifest.shortcuts.map(
            function mapManifestShortcut(shortcut) {
                if (shortcut === null || !is.object(shortcut) || is.array(shortcut)) return shortcut;
                const mapped = {...shortcut};
                if (Object.hasOwn(mapped, 'url')) {
                    mapped.url = manifestUrl(mapped.url, appBase);
                }
                if (Object.hasOwn(mapped, 'icons')) {
                    mapped.icons = manifestImages(mapped.icons, appBase);
                }
                return mapped;
            }
        );
    }
    return manifest;
}

function manifestAssets(manifest) {
    const urls = [manifest.start_url];
    function appendImages(images) {
        if (!is.array(images)) return;
        for (const image of images) {
            if (is.string(image?.src)) urls.push(image.src);
        }
    }
    appendImages(manifest.icons);
    appendImages(manifest.screenshots);
    if (is.array(manifest.shortcuts)) {
        for (const shortcut of manifest.shortcuts) {
            if (is.string(shortcut?.url)) urls.push(shortcut.url);
            appendImages(shortcut?.icons);
        }
    }
    return urls.filter(
        function manifestUrlString(url) {
            return is.string(url);
        }
    );
}

function assetPath(url) {
    const resolved = new URL(url, 'https://arcane.invalid/');
    return `${resolved.origin}${resolved.pathname}`;
}

export function createPwaArtifacts(
    {
        app,
        sdkVersion,
        pwa,
        files = [],
        assets,
        basePath = './',
        mode = 'release',
        runtimeBase = './arcane/sdk/',
        appBase,
        installationId,
        appPath = '',
        navigationAliases,
        revision
    } = {}
) {
    const config = normalizePwaConfig(pwa);
    if (!config?.enabled) return null;
    if (mode !== 'release' && mode !== 'development') {
        throw new TypeError('PWA mode must be release or development.');
    }
    const entryUrl = new URL(app.entry, 'https://arcane.invalid/');
    const applicationBase = appBase ?? (appPath ? `./${appPath}/`
        : mode === 'development' ? new URL('./', entryUrl).pathname : './');
    // Relocating app files must not change an existing installed app's default identity.
    const installationBase = appBase ?? (mode === 'development' ? applicationBase : './');
    const manifest = {
        id: installationId ?? installationBase,
        name: app.displayName,
        short_name: app.displayName,
        start_url: manifestUrl(app.entry, appPath ? basePath : applicationBase),
        scope: installationBase,
        display: 'standalone',
        ...applicationManifest(config.manifest, applicationBase)
    };
    const generatedAssets = [
        PWA_MANIFEST_NAME,
        PWA_OFFLINE_MANIFEST_NAME,
        PWA_BOOTSTRAP_NAME
    ].map(
        function generatedResource(file) {
            return resourceUrl(basePath, file);
        }
    );
    const selectedFiles = selectPwaFiles(files, config, appPath);
    const selectedAssets = [
        ...selectedFiles.map(
            function packagedResource(file) {
                return resourceUrl(basePath, file);
            }
        ),
        ...(assets ?? []),
        app.entry
    ];
    const selectedPaths = new Set(
        selectedAssets.map(assetPath)
    );
    // Manifest URLs may retain functional queries. Cache those variants only
    // when their resource already belongs to the selected application inventory.
    const metadataAssets = manifestAssets(manifest).filter(
        function selectedManifestAsset(url) {
            return selectedPaths.has(
                assetPath(url)
            );
        }
    );
    const workerUrl = resourceUrl(basePath, PWA_WORKER_NAME);
    const workerPath = new URL(workerUrl, 'https://arcane.invalid/').pathname;
    const allAssets = new Set(
        [
            ...selectedAssets,
            ...metadataAssets,
            ...generatedAssets
        ]
    );
    const offlineManifest = {
        schemaVersion: 1,
        appId: app.id,
        appVersion: app.version,
        sdkVersion,
        revision: revision ?? (mode === 'development' ? 'development' : randomUUID()),
        mode,
        assets: [...allAssets].filter(
            function excludeWorker(url) {
                return new URL(url, 'https://arcane.invalid/').pathname !== workerPath;
            }
        ),
        navigationAliases: navigationAliases ?? {[basePath]: app.entry}
    };
    const bootstrap = `import {registerPwa, mountPwaInstallPrompt} from ${JSON.stringify(`${runtimeBase}pwa.mjs`)};

mountPwaInstallPrompt({appName: ${JSON.stringify(manifest.name)}}).catch(
    function reportPwaInstallComponentFailure(error) {
        console.error('Arcane PWA install component failed:', error);
    }
);

const controller = registerPwa(
    {
        workerUrl: new URL('./${PWA_WORKER_NAME}', import.meta.url).href,
        scope: new URL('./', import.meta.url).href
    }
);

controller.ready.catch(
    function reportPwaRegistrationFailure(error) {
        console.error('Arcane PWA registration failed:', error);
    }
);
`;
    const entryAssets = {manifest: PWA_MANIFEST_NAME, bootstrap: PWA_BOOTSTRAP_NAME};
    const manifestHref = resourceUrl(basePath, entryAssets.manifest);
    const bootstrapHref = resourceUrl(basePath, entryAssets.bootstrap);
    const generatedFiles = [
        {path: PWA_MANIFEST_NAME, content: json(manifest)},
        {path: PWA_OFFLINE_MANIFEST_NAME, content: json(offlineManifest)},
        {
            path: PWA_WORKER_NAME,
            content: createPwaWorkerScript(offlineManifest, `${runtimeBase}pwa.mjs`)
        },
        {path: PWA_BOOTSTRAP_NAME, content: bootstrap}
    ];
    return {
        manifest,
        offlineManifest,
        files: generatedFiles,
        entryAssets,
        entryMarkup: `<link rel="manifest" href="${htmlAttribute(manifestHref)}">\n`
            + `<script type="module" async data-arcane-pwa src="${htmlAttribute(bootstrapHref)}"></script>\n`
    };
}
