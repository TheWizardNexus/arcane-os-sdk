import assert from 'node:assert/strict';
import {lstat, mkdir, readFile, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as waitForHttpDateChange} from 'node:timers/promises';
import test from '../src/testing.mjs';
import {startDevServer} from '../src/dev-server.mjs';
import {createWorkspace} from '../src/scaffold.mjs';
import {developApplication} from '../src/toolchain.mjs';
import {installedSdkRoutes} from '../src/sdk-runtime-layout.mjs';
import {ARCANE_PROTOCOL, SDK_VERSION} from '../src/constants.mjs';
import {
    fetchSyntheticTls as fetch,temporaryDirectory,useSyntheticTls,writeSyntheticTlsFiles
} from './helpers.mjs';

async function sourceFixture(context, {
    enabled = true, authored = false, http = false, rootApp = false, directPackage = null
} = {}) {
    if (!http) useSyntheticTls(context);
    const workspaceRoot = await temporaryDirectory(context, {prefix: 'arcane-dev-pwa-'});
    if (!http) await writeSyntheticTlsFiles(workspaceRoot);
    const rootConfig = {
        schemaVersion: 1,
        appsRoot: rootApp ? '.' : 'apps',
        distRoot: 'dist',
        sharedPayloads: {
            'browser-runtime': [
                {
                    source: 'arcane', destination: 'arcane',
                    include: ['components', 'css', 'dependencies', 'entities', 'img', 'modules', 'sdk'],
                    exclude: []
                },
                {
                    source: 'node_modules/arcane-os', destination: 'licenses/arcane-os',
                    include: ['LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE'], exclude: []
                }
            ]
        }
    };
    if (directPackage) rootConfig.sharedPayloads['browser-runtime'] = installedSdkRoutes(
        directPackage, {direct: true}
    );
    const appPrefix = rootApp ? '' : 'apps/fixture/';
    const runtimePath = directPackage ? `${directPackage}/runtime/arcane` : 'arcane';
    const browserRuntimePath = directPackage ? `${directPackage}/browser-runtime` : 'arcane/sdk';
    const app = {
        schemaVersion: 1,
        id: 'fixture',
        displayName: 'Offline source fixture',
        version: '1.2.3',
        entry: 'index.html',
        strategy: 'static',
        include: ['index.html', 'secondary.html', 'modules', 'styles.css', 'icon.svg', 'documents'],
        exclude: [],
        shared: ['browser-runtime']
    };
    if (rootApp) app.include.push(
        'apps/fixture/service-worker.js',
        'apps/fixture/manifest.json'
    );
    if (enabled) {
        app.pwa = {
            enabled: true,
            manifest: {short_name: 'Fixture', icons: [{src: './icon.svg', type: 'image/svg+xml'}]},
            offline: {exclude: ['documents/excluded.txt']}
        };
    }
    if (authored) app.include.sort();
    const entry = `<!doctype html><html lang="en"><head><base href="${rootApp ? './' : '../../'}">`
        + `<script type="importmap" data-arcane-import-map>{"imports":{"arcane/State":"./${runtimePath}/modules/State.js?v=1&arcaneVersion=old"}}</script>`
        + `<link rel="stylesheet" href="./${appPrefix}styles.css?v=4">`
        + `<script type="module" src="./${appPrefix}modules/entry.js?v=4"></script>`
        + '<script type="application/json">{"payload":"./data.js?v=4"}</script>'
        + '</head><body><p>First source content</p></body></html>';
    const secondary = `<!doctype html><html lang="en"><head><base href="${rootApp ? './' : '../../'}">`
        + `<script type="module" src="./${appPrefix}modules/secondary.js?v=4"></script>`
        + '</head><body>Unvisited application page</body></html>';
    const documentHtml = '<script src="./payload.js?v=4"></script><p>Complete document content.</p>';
    const documentJavaScript = "import './raw.js?v=4'; const documentText = 'Complete supplied source.';";
    const files = new Map([
        ['package.json', JSON.stringify({name: 'dev-pwa-fixture', private: true, type: 'module', devDependencies: {
            [directPackage ? directPackage.slice('node_modules/'.length) : 'arcane-os']:
                directPackage ? `npm:arcane-os@${SDK_VERSION}` : SDK_VERSION
        }})],
        ['arcane-packager.json', JSON.stringify(rootConfig)],
        ['arcane.lock.json', JSON.stringify({sdk: {name: 'arcane-os', version: '9.8.7'}})],
        [`${appPrefix}arcane-package.json`, JSON.stringify(app)],
        [`${appPrefix}index.html`, entry],
        [`${appPrefix}secondary.html`, secondary],
        [`${appPrefix}modules/entry.js`, "import './entry-child.js?v=4'; export const state = 'first';"],
        [`${appPrefix}modules/entry-child.js`, 'export const first = true;'],
        [`${appPrefix}modules/secondary.js`, "import './deep.js?mode=a%20b&arcaneVersion=old&v=4';"],
        [`${appPrefix}modules/deep.js`, "export {leaf} from './leaf.js?mode=a+b&arcaneVersion=old#active'; new Worker(new URL('./worker.js?mode=a%20b&v=4', import.meta.url), {type:'module'});"],
        [`${appPrefix}modules/leaf.js`, 'export const leaf = true;'],
        [`${appPrefix}modules/worker.js`, "import './leaf.js?mode=worker&v=4';"],
        [`${appPrefix}modules/arcane.importmap.json`, `{"imports":{"leaf":"./${appPrefix}modules/leaf.js?mode=map&v=4"}}`],
        [`${appPrefix}styles.css`, '.fixture{background:url("./icon.svg?theme=a%20b&v=4")}'],
        [`${appPrefix}icon.svg`, '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
        [`${appPrefix}documents/payload.html`, documentHtml],
        [`${appPrefix}documents/payload.js`, documentJavaScript],
        [`${appPrefix}documents/raw.js`, 'export const document = true;'],
        [`${appPrefix}documents/excluded.txt`, 'Not selected for offline storage.'],
        [`${runtimePath}/modules/State.js`, "export {child} from './child.js?v=4';"],
        [`${runtimePath}/modules/child.js`, 'export const child = true;'],
        [`${browserRuntimePath}/pwa.mjs`, 'export const servingFixture = true;']
    ]);
    if (rootApp) {
        files.set('apps/fixture/service-worker.js', 'self.addEventListener("fetch", function appFetch() {});');
        files.set('apps/fixture/manifest.json', '{"name":"Authored root resource"}');
    }
    if (directPackage) {
        files.set(`${directPackage}/package.json`, JSON.stringify({name: 'arcane-os', version: SDK_VERSION}));
        files.set(`${directPackage}/runtime/strong-type/index.js`, 'export default function StrongType() {}');
        for (const license of ['LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE']) {
            files.set(`${directPackage}/${license}`, 'Synthetic fixture notice.');
        }
    }
    if (authored) {
        files.set(`${appPrefix}arcane-app.json`, JSON.stringify({
            schemaVersion: 2,
            id: app.id,
            displayName: app.displayName,
            description: 'Authored live source fixture.',
            version: app.version,
            publisher: {id: 'fixture-publisher', name: 'Fixture Publisher'},
            package: {
                entry: app.entry,
                strategy: app.strategy,
                include: app.include,
                exclude: app.exclude,
                shared: app.shared,
                ...(app.pwa === undefined ? {} : {pwa: app.pwa})
            },
            native: {type: 'app', icon: null, order: 100, bundledApps: []},
            requirements: {arcaneProtocol: ARCANE_PROTOCOL, features: []},
            targets: ['browser']
        }));
    }
    await Promise.all([...files].map(async function writeFixtureFile([relative, content]) {
        const location = path.join(workspaceRoot, ...relative.split('/'));
        await mkdir(path.dirname(location), {recursive: true});
        await writeFile(location, content, 'utf8');
    }));
    const instance = await startDevServer({workspaceRoot, appId: 'fixture', port: 0, http});
    context.after(async function closeFixtureServer() {
        await instance.close();
    });
    return {workspaceRoot, instance, entry, documentHtml, documentJavaScript};
}

test('root source PWA retains identity and follows direct installed alias routes', async function rootSourcePwa(context) {
    const packageSource = 'node_modules/arcane-sdk';
    const {workspaceRoot, instance, documentHtml} = await sourceFixture(context, {
        rootApp: true, directPackage: packageSource, authored: true, http: true
    });
    assert.equal(instance.url, `${instance.origin}/index.html`);
    const query = '?view=complete%20content&tag=first&tag=second';
    for (const legacy of ['/', '/apps/fixture', '/apps/fixture/', '/apps/fixture/index.html']) {
        const response = await globalThis.fetch(`${instance.origin}${legacy}${query}`, {redirect: 'manual'});
        assert.equal(response.status, 302, legacy);
        assert.equal(response.headers.get('location'), `/index.html${query}`, legacy);
    }
    const nested = await globalThis.fetch(`${instance.origin}/apps/fixture/secondary.html${query}`, {redirect: 'manual'});
    assert.equal(nested.headers.get('location'), `/secondary.html${query}`);
    for (const [resource, expected] of [
        ['service-worker.js', 'self.addEventListener("fetch", function appFetch() {});'],
        ['manifest.json', '{"name":"Authored root resource"}']
    ]) {
        const response = await globalThis.fetch(
            `${instance.origin}/apps/fixture/${resource}`,
            {redirect: 'manual'}
        );
        assert.equal(response.status, 200, resource);
        assert.equal(response.headers.get('location'), null, resource);
        assert.equal(await response.text(), expected, resource);
    }
    const html = await (await globalThis.fetch(instance.url)).text();
    assert.ok(html.includes('<base href="./">'));
    assert.ok(html.includes('src="./modules/entry.js"'));
    assert.ok(html.includes('<link rel="manifest" href="/arcane.webmanifest">'));
    const manifest = await (await globalThis.fetch(`${instance.origin}/arcane.webmanifest`)).json();
    assert.equal(manifest.id, '/apps/fixture/');
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.start_url, '/index.html');
    assert.equal(manifest.icons[0].src, '/icon.svg');
    const bootstrap = await (await globalThis.fetch(`${instance.origin}/arcane-pwa.mjs`)).text();
    assert.ok(bootstrap.includes(`from "/${packageSource}/browser-runtime/pwa.mjs";`));
    const offline = await (await globalThis.fetch(`${instance.origin}/arcane-offline.json`)).json();
    assert.equal(offline.sdkVersion, SDK_VERSION);
    assert.equal(offline.navigationAliases['/apps/fixture/secondary.html'], '/secondary.html');
    assert.ok(offline.assets.includes(`/${packageSource}/runtime/arcane/modules/child.js`));
    assert.ok(offline.assets.includes('/modules/leaf.js?mode=worker'));
    assert.equal(offline.assets.includes('/documents/excluded.txt'), false);
    const legacyWorker = await globalThis.fetch(`${instance.origin}/apps/fixture/arcane-sw.js`, {redirect: 'manual'});
    assert.equal(legacyWorker.status, 200);
    assert.match(legacyWorker.headers.get('content-type'), /javascript/u);
    assert.ok((await legacyWorker.text()).includes('installPwaWorker'));
    const legacyInventoryResponse = await globalThis.fetch(`${instance.origin}/apps/fixture/arcane-offline.json`, {redirect: 'manual'});
    assert.equal(legacyInventoryResponse.status, 200);
    const legacyInventory = await legacyInventoryResponse.json();
    assert.equal(legacyInventory.navigationAliases['/apps/fixture/secondary.html'], '/secondary.html');
    assert.ok(legacyInventory.assets.includes(`/${packageSource}/runtime/arcane/modules/child.js`));
    assert.ok(legacyInventory.assets.includes('./arcane-offline.json'));
    const runtime = await globalThis.fetch(`${instance.origin}/${packageSource}/runtime/arcane/modules/State.js`);
    assert.equal(await runtime.text(), "export {child} from './child.js';");
    const document = await globalThis.fetch(`${instance.origin}/documents/payload.html`);
    assert.equal(await document.text(), documentHtml);

    const descriptorPath = path.join(workspaceRoot, 'arcane-app.json');
    const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
    descriptor.package.entry = 'secondary.html';
    descriptor.package.pwa.manifest.id = '/authored-installation/';
    await writeFile(descriptorPath, JSON.stringify(descriptor), 'utf8');
    const changed = await (await globalThis.fetch(`${instance.origin}/arcane.webmanifest`)).json();
    assert.equal(changed.id, '/authored-installation/');
    assert.equal(changed.start_url, '/secondary.html');
    assert.equal(changed.scope, '/');
    const root = await globalThis.fetch(`${instance.origin}/${query}`, {redirect: 'manual'});
    assert.equal(root.headers.get('location'), `/secondary.html${query}`);
    const legacyEntry = await globalThis.fetch(`${instance.origin}/apps/fixture/index.html${query}`, {redirect: 'manual'});
    assert.equal(legacyEntry.headers.get('location'), `/secondary.html${query}`);
    const changedOffline = await (await globalThis.fetch(`${instance.origin}/arcane-offline.json`)).json();
    assert.equal(changedOffline.navigationAliases['/apps/fixture/index.html'], '/secondary.html');
    const changedLegacyOffline = await (await globalThis.fetch(`${instance.origin}/apps/fixture/arcane-offline.json`)).json();
    assert.equal(changedLegacyOffline.navigationAliases['/apps/fixture/index.html'], '/secondary.html');
    await assert.rejects(lstat(path.join(workspaceRoot, 'dist')), {code: 'ENOENT'});
});

test(
    'explicit HTTP development serves the same generated PWA and conditional offline routes',
    async function httpPwaSourceRoutes(context) {
        const {workspaceRoot, instance, documentHtml} = await sourceFixture(context, {http: true});
        assert.equal(instance.protocol, 'http:');
        await assert.rejects(
            readFile(path.join(workspaceRoot, '.arcane', 'dev', 'server-cert.pem')),
            {code: 'ENOENT'}
        );
        const response = await globalThis.fetch(instance.url, {redirect: 'manual'});
        assert.equal(response.status, 200);
        const html = await response.text();
        assert.ok(html.includes('<link rel="manifest" href="/arcane.webmanifest">'));
        assert.ok(html.includes('async data-arcane-pwa src="/arcane-pwa.mjs"'));
        const generated = new Map();
        for (const route of ['/arcane.webmanifest', '/arcane-pwa.mjs', '/arcane-sw.js', '/arcane-offline.json']) {
            const url = `${instance.origin}${route}`;
            const resource = await globalThis.fetch(url, {redirect: 'manual'});
            assert.equal(resource.status, 200, route);
            assert.equal(resource.headers.get('location'), null, route);
            assert.equal(resource.headers.get('cache-control'), 'no-cache', route);
            generated.set(route, await resource.text());
            const lastModified = resource.headers.get('last-modified');
            assert.ok(lastModified, route);
            const unchanged = await globalThis.fetch(
                url,
                {headers: {'If-Modified-Since': lastModified}, redirect: 'manual'}
            );
            assert.equal(unchanged.status, 304, route);
            assert.equal(await unchanged.text(), '', route);
        }
        const manifest = JSON.parse(generated.get('/arcane.webmanifest'));
        assert.equal(manifest.start_url, '/apps/fixture/index.html');
        assert.equal(manifest.scope, '/apps/fixture/');
        assert.equal(manifest.short_name, 'Fixture');
        assert.equal(manifest.icons[0].src, '/apps/fixture/icon.svg');
        assert.ok(generated.get('/arcane-pwa.mjs').includes('import {registerPwa, mountPwaInstallPrompt} from "/arcane/sdk/pwa.mjs";'));
        assert.ok(generated.get('/arcane-sw.js').includes('/apps/fixture/modules/leaf.js?mode=worker'));
        const offline = JSON.parse(generated.get('/arcane-offline.json'));
        assert.equal(offline.mode, 'development');
        assert.equal(offline.appVersion, '1.2.3');
        assert.equal(offline.sdkVersion, '9.8.7');
        assert.ok(offline.assets.includes('/apps/fixture/documents/payload.html'));
        assert.ok(offline.assets.includes('/arcane/modules/child.js'));
        assert.equal(offline.assets.includes('/apps/fixture/documents/excluded.txt'), false);
        const document = await globalThis.fetch(`${instance.origin}/apps/fixture/documents/payload.html`);
        assert.equal(await document.text(), documentHtml);
        await assert.rejects(lstat(path.join(workspaceRoot, 'dist')), {code: 'ENOENT'});
    }
);

test('PWA source routes serve clean entries and current saved content without restart', async function pwaSourceRoutes(context) {
    const {workspaceRoot, instance, entry} = await sourceFixture(context);
    const response = await fetch(`${instance.origin}/apps/fixture/index.html`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    const html = await response.text();
    assert.ok(html.includes('src="./apps/fixture/modules/entry.js"'));
    assert.ok(html.includes('<script type="module" async data-arcane-pwa src="/arcane-pwa.mjs"></script>'));
    assert.ok(html.includes('<link rel="manifest" href="/arcane.webmanifest">'));
    assert.ok(html.includes('{"payload":"./data.js?v=4"}'));
    const manifestResponse = await fetch(`${instance.origin}/arcane.webmanifest`);
    assert.equal(manifestResponse.headers.get('cache-control'), 'no-cache');
    assert.ok(manifestResponse.headers.get('content-type').startsWith('application/manifest+json'));
    const manifest = await manifestResponse.json();
    assert.equal(manifest.short_name, 'Fixture');
    assert.equal(manifest.start_url, '/apps/fixture/index.html');
    assert.equal(manifest.icons[0].src, '/apps/fixture/icon.svg');
    const bootstrap = await fetch(`${instance.origin}/arcane-pwa.mjs`);
    assert.equal(bootstrap.status, 200);
    assert.ok((await bootstrap.text()).includes('import {registerPwa, mountPwaInstallPrompt} from "/arcane/sdk/pwa.mjs";'));

    await writeFile(path.join(workspaceRoot, 'apps/fixture/index.html'), entry.replace('First source content', 'Updated source content'), 'utf8');
    await writeFile(path.join(workspaceRoot, 'arcane/modules/State.js'), "export {child} from './child.js?mode=updated&v=5';", 'utf8');
    await writeFile(path.join(workspaceRoot, 'arcane.lock.json'), JSON.stringify({sdk: {name: 'arcane-os', version: '9.8.8'}}), 'utf8');
    assert.ok((await (await fetch(`${instance.origin}/apps/fixture/index.html`)).text()).includes('Updated source content'));
    const runtime = await fetch(`${instance.origin}/arcane/modules/State.js`);
    assert.equal(await runtime.text(), "export {child} from './child.js?mode=updated';");
    const offline = await (await fetch(`${instance.origin}/arcane-offline.json`)).json();
    assert.equal(offline.sdkVersion, '9.8.8');
    assert.ok(offline.assets.includes('/arcane/modules/child.js?mode=updated'));
    assert.equal(await readFile(path.join(workspaceRoot, 'arcane/modules/State.js'), 'utf8'),
        "export {child} from './child.js?mode=updated&v=5';");
});

test('source offline inventory closes unvisited page references before worker cache fetches', async function completeSourceOfflineGraph(context) {
    const {instance, documentHtml, documentJavaScript} = await sourceFixture(context);
    const worker = await fetch(`${instance.origin}/arcane-sw.js`);
    assert.equal(worker.status, 200);
    const script = await worker.text();
    assert.ok(script.includes('/apps/fixture/modules/deep.js?mode=a%20b'));
    const offline = await (await fetch(`${instance.origin}/arcane-offline.json`)).json();
    assert.equal(offline.mode, 'development');
    for (const resource of [
        '/apps/fixture/secondary.html',
        '/apps/fixture/modules/deep.js?mode=a%20b',
        '/apps/fixture/modules/leaf.js?mode=a+b',
        '/apps/fixture/modules/leaf.js?mode=worker',
        '/apps/fixture/modules/leaf.js?mode=map',
        '/apps/fixture/modules/worker.js?mode=a%20b',
        '/apps/fixture/icon.svg?theme=a%20b',
        '/apps/fixture/documents/payload.html'
    ]) assert.ok(offline.assets.includes(resource), resource);
    assert.equal(offline.assets.includes('/apps/fixture/documents/excluded.txt'), false);
    assert.equal(offline.assets.includes('/apps/fixture/documents/raw.js?v=4'), false);
    for (const resource of offline.assets) {
        const url = new URL(resource, instance.origin);
        assert.equal(url.searchParams.has('v'), false, resource);
        assert.equal(url.searchParams.has('arcaneVersion'), false, resource);
        assert.equal(url.hash, '', resource);
    }
    // A service-worker install fetch has no script destination and may fetch this first.
    const deep = await fetch(`${instance.origin}/apps/fixture/modules/deep.js?mode=a%20b`);
    assert.equal(await deep.text(), "export {leaf} from './leaf.js?mode=a+b#active'; new Worker(new URL('./worker.js?mode=a%20b', import.meta.url), {type:'module'});");
    const secondary = await fetch(`${instance.origin}/apps/fixture/secondary.html`);
    assert.ok((await secondary.text()).includes('async data-arcane-pwa'));
    assert.equal(await (await fetch(`${instance.origin}/apps/fixture/documents/payload.html`)).text(), documentHtml);
    assert.equal(await (await fetch(`${instance.origin}/apps/fixture/documents/payload.js`)).text(), documentJavaScript);
});

test('ordinary source serving keeps versioned URLs and does not add PWA routes', async function ordinarySourceMode(context) {
    const {instance, documentHtml} = await sourceFixture(context, {enabled: false});
    const response = await fetch(`${instance.origin}/apps/fixture/index.html`);
    const html = await response.text();
    assert.ok(html.includes('src="./apps/fixture/modules/entry.js?arcaneVersion=9.8.7"'));
    assert.equal(html.includes('data-arcane-pwa'), false);
    for (const route of ['/arcane.webmanifest', '/arcane-offline.json', '/arcane-sw.js', '/arcane-pwa.mjs']) {
        assert.equal((await fetch(`${instance.origin}${route}`)).status, 404, route);
    }
    const runtime = await fetch(`${instance.origin}/arcane/modules/State.js`);
    assert.equal(runtime.headers.get('cache-control'), null);
    assert.equal(await runtime.text(), "export {child} from './child.js?arcaneVersion=9.8.7';");
    assert.equal(await (await fetch(`${instance.origin}/apps/fixture/documents/payload.html`)).text(), documentHtml);
});

test(
    'conditional offline requests discover added and removed files while retaining unchanged generated responses',
    async function refreshConditionalOfflineInventory(context) {
        const {workspaceRoot, instance} = await sourceFixture(context);
        const documentRoot = path.join(workspaceRoot, 'apps', 'fixture', 'documents');
        const removedPath = path.join(documentRoot, 'removed.txt');
        await writeFile(removedPath, 'Complete previously selected document.');
        const controlUrl = `${instance.origin}/arcane-offline.json`;
        const initial = await fetch(controlUrl);
        const initialModified = initial.headers.get('last-modified');
        const initialManifest = await initial.json();
        assert.ok(initialManifest.assets.includes('/apps/fixture/documents/removed.txt'));
        const unchanged = await fetch(
            controlUrl,
            {headers: {'If-Modified-Since': initialModified}}
        );
        assert.equal(unchanged.status, 304);
        assert.equal(await unchanged.text(), '');

        const stableGenerated = new Map();
        for (const resource of ['/arcane.webmanifest', '/arcane-pwa.mjs']) {
            const response = await fetch(`${instance.origin}${resource}`);
            stableGenerated.set(resource, response.headers.get('last-modified'));
            await response.text();
        }
        const initialWorker = await fetch(`${instance.origin}/arcane-sw.js`);
        const initialWorkerModified = initialWorker.headers.get('last-modified');
        await initialWorker.text();
        // Separate actual changes at HTTP-date precision without changing app versions.
        await waitForHttpDateChange(1100);
        const addedContent = '  Complete new document.\nIts formatting stays intact.  ';
        await Promise.all(
            [
                unlink(removedPath),
                writeFile(path.join(documentRoot, 'added notes.txt'), addedContent)
            ]
        );
        const current = await fetch(
            controlUrl,
            {headers: {'If-Modified-Since': initialModified}}
        );
        assert.equal(current.status, 200);
        const currentModified = current.headers.get('last-modified');
        assert.notEqual(currentModified, initialModified);
        const currentManifest = await current.json();
        assert.equal(currentManifest.appVersion, initialManifest.appVersion);
        assert.equal(currentManifest.sdkVersion, initialManifest.sdkVersion);
        assert.equal(currentManifest.assets.includes('/apps/fixture/documents/removed.txt'), false);
        assert.ok(currentManifest.assets.includes('/apps/fixture/documents/added%20notes.txt'));
        const unchangedCurrent = await fetch(
            controlUrl,
            {headers: {'If-Modified-Since': currentModified}}
        );
        assert.equal(unchangedCurrent.status, 304);
        assert.equal(await unchangedCurrent.text(), '');
        for (const [resource, lastModified] of stableGenerated) {
            const response = await fetch(
                `${instance.origin}${resource}`,
                {headers: {'If-Modified-Since': lastModified}}
            );
            assert.equal(response.status, 304);
            assert.equal(response.headers.get('last-modified'), lastModified);
            assert.equal(await response.text(), '');
        }
        const worker = await fetch(
            `${instance.origin}/arcane-sw.js`,
            {headers: {'If-Modified-Since': initialWorkerModified}}
        );
        assert.equal(worker.status, 200);
        assert.ok((await worker.text()).includes('/apps/fixture/documents/added%20notes.txt'));
        const document = await fetch(`${instance.origin}/apps/fixture/documents/added%20notes.txt`);
        assert.equal(await document.text(), addedContent);
        await assert.rejects(lstat(path.join(workspaceRoot, 'dist')), {code: 'ENOENT'});
    }
);

test(
    'running package-only source server follows current membership, entry, and PWA configuration',
    async function refreshLivePackageSourceSelection(context) {
        const {workspaceRoot, instance, entry} = await sourceFixture(context);
        const appRoot = path.join(workspaceRoot, 'apps', 'fixture');
        const packagePath = path.join(appRoot, 'arcane-package.json');
        const app = JSON.parse(await readFile(packagePath, 'utf8'));
        const previousManifest = await (await fetch(`${instance.origin}/arcane.webmanifest`)).json();
        const previousBootstrap = await (await fetch(`${instance.origin}/arcane-pwa.mjs`)).text();
        const previousOffline = await (await fetch(`${instance.origin}/arcane-offline.json`)).json();
        assert.ok(previousOffline.assets.includes('/apps/fixture/secondary.html'));
        assert.ok(previousOffline.assets.includes('/apps/fixture/modules/leaf.js'));

        const addedSource = "  export const history = 'Complete newly selected source.';\n";
        await Promise.all([
            writeFile(path.join(appRoot, 'added script.js'), addedSource),
            writeFile(path.join(appRoot, 'current.html'), entry)
        ]);
        const addedUrl = `${instance.origin}/apps/fixture/added%20script.js`;
        assert.equal((await fetch(addedUrl)).status, 404);
        app.include = app.include.filter(function retainCurrentSelection(file) {
            return file !== 'secondary.html';
        });
        app.include.push('added script.js', 'current.html');
        app.entry = 'current.html';
        app.exclude.push('modules/leaf.js');
        app.pwa.manifest.name = 'Current package application';
        app.pwa.manifest.description = '  Complete updated description.\nSecond line.  ';
        app.pwa.offline.exclude.push('modules/worker.js');
        const packageSource = `${JSON.stringify(app, null, 4)}\n`;
        await writeFile(packagePath, packageSource);

        const added = await fetch(addedUrl);
        assert.equal(added.status, 200);
        assert.equal(await added.text(), addedSource);
        for (const removed of ['secondary.html', 'modules/leaf.js']) {
            assert.equal((await fetch(`${instance.origin}/apps/fixture/${removed}`)).status, 404);
            assert.equal((await lstat(path.join(appRoot, removed))).isFile(), true);
        }
        const root = await fetch(`${instance.origin}/`, {redirect: 'manual'});
        assert.equal(root.status, 302);
        assert.equal(root.headers.get('location'), '/apps/fixture/current.html');
        const currentEntry = await fetch(`${instance.origin}/apps/fixture/current.html`);
        assert.equal(currentEntry.status, 200);
        assert.ok((await currentEntry.text()).includes('async data-arcane-pwa'));

        // Metadata requests must refresh without waiting for a subsequent inventory request.
        const manifest = await (await fetch(`${instance.origin}/arcane.webmanifest`)).json();
        assert.notEqual(manifest.name, previousManifest.name);
        assert.equal(manifest.name, app.pwa.manifest.name);
        assert.equal(manifest.description, app.pwa.manifest.description);
        assert.equal(manifest.start_url, '/apps/fixture/current.html');
        const bootstrap = await (await fetch(`${instance.origin}/arcane-pwa.mjs`)).text();
        assert.notEqual(bootstrap, previousBootstrap);
        assert.ok(bootstrap.includes(`appName: ${JSON.stringify(manifest.name)}`));
        const offline = await (await fetch(`${instance.origin}/arcane-offline.json`)).json();
        assert.ok(offline.assets.includes('/apps/fixture/added%20script.js'));
        assert.ok(offline.assets.includes('/apps/fixture/current.html'));
        for (const removed of ['secondary.html', 'modules/leaf.js', 'modules/worker.js']) {
            assert.equal(offline.assets.includes(`/apps/fixture/${removed}`), false);
        }
        assert.equal(offline.appVersion, previousOffline.appVersion);
        assert.equal((await fetch(`${instance.origin}/apps/fixture/modules/worker.js`)).status, 200);
        assert.equal(await readFile(packagePath, 'utf8'), packageSource);

        app.pwa.enabled = false;
        await writeFile(packagePath, `${JSON.stringify(app, null, 4)}\n`);
        assert.equal((await fetch(`${instance.origin}/arcane.webmanifest`)).status, 404);
        const ordinaryEntry = await (await fetch(`${instance.origin}/apps/fixture/current.html`)).text();
        assert.equal(ordinaryEntry.includes('data-arcane-pwa'), false);
        assert.ok(ordinaryEntry.includes('arcaneVersion=9.8.7'));
        await assert.rejects(lstat(path.join(workspaceRoot, 'dist')), {code: 'ENOENT'});
    }
);

test(
    'running authored source server projects current selections in memory without rewriting the package',
    async function refreshLiveAuthoredSourceSelection(context) {
        const {workspaceRoot, instance} = await sourceFixture(context, {authored: true});
        const appRoot = path.join(workspaceRoot, 'apps', 'fixture');
        const descriptorPath = path.join(appRoot, 'arcane-app.json');
        const packagePath = path.join(appRoot, 'arcane-package.json');
        const packageSource = await readFile(packagePath, 'utf8');
        const descriptor = JSON.parse(await readFile(descriptorPath, 'utf8'));
        const previousManifest = await (await fetch(`${instance.origin}/arcane.webmanifest`)).json();
        const previousBootstrap = await (await fetch(`${instance.origin}/arcane-pwa.mjs`)).text();
        const previousOffline = await (await fetch(`${instance.origin}/arcane-offline.json`)).json();
        assert.ok(previousOffline.assets.includes('/apps/fixture/secondary.html'));
        const addedSource = "export const history = 'Authored selection after server startup.';\n";
        await writeFile(path.join(appRoot, 'history.js'), addedSource);
        const addedUrl = `${instance.origin}/apps/fixture/history.js`;
        assert.equal((await fetch(addedUrl)).status, 404);

        descriptor.package.include = descriptor.package.include.filter(function retainAuthoredSelection(file) {
            return file !== 'secondary.html';
        });
        descriptor.package.include.push('history.js');
        descriptor.package.include.sort();
        descriptor.package.exclude.push('modules/leaf.js');
        descriptor.package.pwa.manifest.name = 'Current authored application';
        descriptor.package.pwa.manifest.description = '  Complete authored description.\nSecond line.  ';
        descriptor.package.pwa.offline.exclude.push('modules/worker.js');
        const authoredSource = `${JSON.stringify(descriptor, null, 4)}\n`;
        await writeFile(descriptorPath, authoredSource);

        const added = await fetch(addedUrl);
        assert.equal(added.status, 200);
        assert.equal(await added.text(), addedSource);
        for (const removed of ['secondary.html', 'modules/leaf.js']) {
            assert.equal((await fetch(`${instance.origin}/apps/fixture/${removed}`)).status, 404);
            assert.equal((await lstat(path.join(appRoot, removed))).isFile(), true);
        }
        const manifest = await (await fetch(`${instance.origin}/arcane.webmanifest`)).json();
        assert.notEqual(manifest.name, previousManifest.name);
        assert.equal(manifest.name, descriptor.package.pwa.manifest.name);
        assert.equal(manifest.description, descriptor.package.pwa.manifest.description);
        const bootstrap = await (await fetch(`${instance.origin}/arcane-pwa.mjs`)).text();
        assert.notEqual(bootstrap, previousBootstrap);
        assert.ok(bootstrap.includes(`appName: ${JSON.stringify(manifest.name)}`));
        const [offlineResponse, workerResponse] = await Promise.all([
            fetch(`${instance.origin}/arcane-offline.json`),
            fetch(`${instance.origin}/arcane-sw.js`)
        ]);
        const offline = await offlineResponse.json();
        const worker = await workerResponse.text();
        assert.ok(offline.assets.includes('/apps/fixture/history.js'));
        assert.ok(worker.includes('/apps/fixture/history.js'));
        for (const removed of ['secondary.html', 'modules/leaf.js', 'modules/worker.js']) {
            assert.equal(offline.assets.includes(`/apps/fixture/${removed}`), false);
        }
        assert.equal(offline.appVersion, previousOffline.appVersion);
        assert.equal((await fetch(`${instance.origin}/apps/fixture/modules/worker.js`)).status, 200);
        assert.equal(await readFile(packagePath, 'utf8'), packageSource);
        assert.equal(await readFile(descriptorPath, 'utf8'), authoredSource);
        assert.equal(await readFile(path.join(appRoot, 'history.js'), 'utf8'), addedSource);
        await assert.rejects(lstat(path.join(workspaceRoot, 'dist')), {code: 'ENOENT'});
    }
);

test(
    'development startup projects authored file and PWA changes before serving the current offline inventory',
    async function authoredPwaDevelopmentStartup(context) {
        useSyntheticTls(context);
        const workspaceRoot = await temporaryDirectory(
            context,
            {prefix: 'arcane-authored-pwa-startup-'}
        );
        const appId = 'authored-pwa';
        await createWorkspace(
            {targetPath: workspaceRoot, appId, displayName: 'Authored PWA', target: 'browser'}
        );
        await writeSyntheticTlsFiles(workspaceRoot);
        // Use the existing integrated fixture profile with the scaffolded runtime.
        await writeFile(
            path.join(workspaceRoot, 'package.json'),
            JSON.stringify(
                {name: 'arcane-os', private: true, type: 'module'}
            )
        );
        const configPath = path.join(workspaceRoot, 'arcane-packager.json');
        const config = JSON.parse(
            await readFile(configPath, 'utf8')
        );
        config.sharedPayloads['browser-runtime'] = [config.sharedPayloads['browser-runtime'][0]];
        await writeFile(configPath, `${JSON.stringify(config, null, 4)}\n`);

        const appRoot = path.join(workspaceRoot, 'apps', appId);
        const descriptorPath = path.join(appRoot, 'arcane-app.json');
        const packagePath = path.join(appRoot, 'arcane-package.json');
        const previousPackage = JSON.parse(
            await readFile(packagePath, 'utf8')
        );
        const descriptor = JSON.parse(
            await readFile(descriptorPath, 'utf8')
        );
        descriptor.package.include.push('downloads', 'settings.html');
        descriptor.package.pwa = {
            enabled: true,
            manifest: {
                short_name: 'Current app',
                description: '  Keep this complete description.\nSecond line.  '
            },
            offline: {
                include: ['arcane', 'downloads', 'settings.html'],
                exclude: ['downloads/excluded.txt']
            }
        };
        Reflect.deleteProperty(descriptor, 'security');
        const authoredSource = `${JSON.stringify(descriptor, null, 4)}\n`;
        await writeFile(descriptorPath, authoredSource);
        const settingsPath = path.join(appRoot, 'settings.html');
        await writeFile(
            settingsPath,
            await readFile(path.join(appRoot, descriptor.package.entry), 'utf8')
        );
        await mkdir(path.join(appRoot, 'downloads'));
        const selectedContent = '  Complete newly selected content.\nSecond line.  ';
        await Promise.all(
            [
                writeFile(path.join(appRoot, 'downloads', 'new notes.txt'), selectedContent),
                writeFile(path.join(appRoot, 'downloads', 'excluded.txt'), 'Excluded from offline selection.')
            ]
        );

        const instance = await developApplication(
            {workspaceRoot, appId, host: '127.0.0.1', port: 0}
        );
        context.after(
            async function closeAuthoredPwaDevelopmentServer() {
                await instance.close();
                await instance.lifecycle;
            }
        );
        const projected = JSON.parse(
            await readFile(packagePath, 'utf8')
        );
        assert.equal(previousPackage.include.includes('settings.html'), false);
        assert.equal(projected.include.includes('settings.html'), true);
        assert.equal(projected.include.includes('downloads'), true);
        assert.equal(projected.version, previousPackage.version);
        assert.deepEqual(projected.pwa, descriptor.package.pwa);
        assert.equal(Object.hasOwn(projected, 'security'), false);
        assert.equal(await readFile(descriptorPath, 'utf8'), authoredSource);
        assert.ok((await readFile(settingsPath, 'utf8')).includes('data-arcane-import-map'));

        const resource = await fetch(`${instance.origin}/apps/${appId}/downloads/new%20notes.txt`);
        assert.equal(resource.status, 200);
        assert.equal(await resource.text(), selectedContent);
        const settings = await fetch(`${instance.origin}/apps/${appId}/settings.html`);
        assert.equal(settings.status, 200);
        assert.ok((await settings.text()).includes('async data-arcane-pwa'));
        const manifest = await (await fetch(`${instance.origin}/arcane.webmanifest`)).json();
        assert.equal(manifest.short_name, descriptor.package.pwa.manifest.short_name);
        assert.equal(manifest.description, descriptor.package.pwa.manifest.description);
        const offline = await (await fetch(`${instance.origin}/arcane-offline.json`)).json();
        assert.ok(offline.assets.includes(`/apps/${appId}/settings.html`));
        assert.ok(offline.assets.includes(`/apps/${appId}/downloads/new%20notes.txt`));
        assert.equal(offline.assets.includes(`/apps/${appId}/downloads/excluded.txt`), false);
        assert.equal(offline.assets.includes(`/apps/${appId}/manifest.json`), false);
        assert.equal(offline.appVersion, previousPackage.version);
        await assert.rejects(
            lstat(path.join(workspaceRoot, 'dist')),
            {code: 'ENOENT'}
        );
    }
);
