import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import test from '../src/testing.mjs';
import {startDevServer} from '../src/dev-server.mjs';
import {SDK_VERSION} from '../src/constants.mjs';
import {temporaryDirectory} from './helpers.mjs';

async function sourceFixture(context, {enabled = true} = {}) {
    const workspaceRoot = await temporaryDirectory(context, {prefix: 'arcane-dev-pwa-'});
    const rootConfig = {
        schemaVersion: 1,
        appsRoot: 'apps',
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
    if (enabled) {
        app.pwa = {
            enabled: true,
            manifest: {short_name: 'Fixture', icons: [{src: './icon.svg', type: 'image/svg+xml'}]},
            offline: {exclude: ['documents/excluded.txt']}
        };
    }
    const entry = '<!doctype html><html lang="en"><head><base href="../../">'
        + '<script type="importmap" data-arcane-import-map>{"imports":{"arcane/State":"./arcane/modules/State.js?v=1&arcaneVersion=old"}}</script>'
        + '<link rel="stylesheet" href="./apps/fixture/styles.css?v=4">'
        + '<script type="module" src="./apps/fixture/modules/entry.js?v=4"></script>'
        + '<script type="application/json">{"payload":"./data.js?v=4"}</script>'
        + '</head><body><p>First source content</p></body></html>';
    const secondary = '<!doctype html><html lang="en"><head><base href="../../">'
        + '<script type="module" src="./apps/fixture/modules/secondary.js?v=4"></script>'
        + '</head><body>Unvisited application page</body></html>';
    const documentHtml = '<script src="./payload.js?v=4"></script><p>Complete document content.</p>';
    const documentJavaScript = "import './raw.js?v=4'; const documentText = 'Complete supplied source.';";
    const files = new Map([
        ['package.json', JSON.stringify({name: 'dev-pwa-fixture', private: true, type: 'module', devDependencies: {'arcane-os': SDK_VERSION}})],
        ['arcane-packager.json', JSON.stringify(rootConfig)],
        ['arcane.lock.json', JSON.stringify({sdk: {name: 'arcane-os', version: '9.8.7'}})],
        ['apps/fixture/arcane-package.json', JSON.stringify(app)],
        ['apps/fixture/index.html', entry],
        ['apps/fixture/secondary.html', secondary],
        ['apps/fixture/modules/entry.js', "import './entry-child.js?v=4'; export const state = 'first';"],
        ['apps/fixture/modules/entry-child.js', 'export const first = true;'],
        ['apps/fixture/modules/secondary.js', "import './deep.js?mode=a%20b&arcaneVersion=old&v=4';"],
        ['apps/fixture/modules/deep.js', "export {leaf} from './leaf.js?mode=a+b&arcaneVersion=old#active'; new Worker(new URL('./worker.js?mode=a%20b&v=4', import.meta.url), {type:'module'});"],
        ['apps/fixture/modules/leaf.js', 'export const leaf = true;'],
        ['apps/fixture/modules/worker.js', "import './leaf.js?mode=worker&v=4';"],
        ['apps/fixture/modules/arcane.importmap.json', '{"imports":{"leaf":"./apps/fixture/modules/leaf.js?mode=map&v=4"}}'],
        ['apps/fixture/styles.css', '.fixture{background:url("./icon.svg?theme=a%20b&v=4")}'],
        ['apps/fixture/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
        ['apps/fixture/documents/payload.html', documentHtml],
        ['apps/fixture/documents/payload.js', documentJavaScript],
        ['apps/fixture/documents/raw.js', 'export const document = true;'],
        ['apps/fixture/documents/excluded.txt', 'Not selected for offline storage.'],
        ['arcane/modules/State.js', "export {child} from './child.js?v=4';"],
        ['arcane/modules/child.js', 'export const child = true;'],
        ['arcane/sdk/pwa.mjs', 'export const servingFixture = true;']
    ]);
    await Promise.all([...files].map(async function writeFixtureFile([relative, content]) {
        const location = path.join(workspaceRoot, ...relative.split('/'));
        await mkdir(path.dirname(location), {recursive: true});
        await writeFile(location, content, 'utf8');
    }));
    const instance = await startDevServer({workspaceRoot, appId: 'fixture', port: 0});
    context.after(async function closeFixtureServer() {
        await instance.close();
    });
    return {workspaceRoot, instance, entry, documentHtml, documentJavaScript};
}

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
    assert.ok((await bootstrap.text()).includes('import {registerPwa} from "/arcane/sdk/pwa.mjs";'));

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
