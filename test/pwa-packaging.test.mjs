import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from '../src/testing.mjs';
import {loadAppDescriptor, projectNativeDescriptor, projectPackageManifest} from '../src/app-descriptor.mjs';
import {packageApp} from '../src/packager/core.mjs';
import {createPwaArtifacts, normalizePwaConfig, selectPwaFiles} from '../src/pwa.mjs';

const CORPUS_HTML = '<base href="./"><script src="./payload.js?v=old"></script>'
    + '<p>Complete supplied document and trailing space </p>\n';
const COMPONENT_HTML = '<base href="./"><p>Reusable component</p>\n';

async function writeText(root, relative, content) {
    const destination = path.join(root, relative);
    await mkdir(
        path.dirname(destination),
        {recursive: true}
    );
    await writeFile(destination, content, 'utf8');
}

async function writeJson(root, relative, value) {
    await writeText(root, relative, `${JSON.stringify(value, null, 2)}\n`);
}

function applicationPage(base, moduleUrl) {
    return '<!doctype html><html lang="en"><head>'
        + `<base href="${base}">`
        + '<script type="importmap" data-arcane-import-map>{"imports":{}}</script>'
        + '<link rel="manifest" href="manifest.json">'
        + '</head><body><main>Application content</main>'
        + '<p>./modules/app.js?v=old&amp;language=fr#graph</p>'
        + `<script type="module" src="${moduleUrl}"></script>`
        + '</body></html>\n';
}

async function workspaceFixture(
    context,
    pwa = {enabled: true}
) {
    const prefix = path.join(
        os.tmpdir(),
        'arcane-pwa-package-'
    );
    const workspaceRoot = await mkdtemp(prefix);
    context.after(
        async function removeOwnedWorkspace() {
            await rm(
                workspaceRoot,
                {recursive: true, force: true}
            );
        }
    );
    const packageManifest = {
        schemaVersion: 1,
        id: 'pwa-app',
        displayName: 'PWA App',
        version: '1.2.3',
        entry: 'index.html',
        strategy: 'static',
        include: ['index.html', 'about.html', 'pages', 'modules', 'content', 'img'],
        exclude: [],
        shared: ['browser-runtime'],
        pwa
    };
    const rootConfig = {
        schemaVersion: 1,
        appsRoot: 'apps',
        distRoot: 'dist',
        sharedPayloads: {
            'browser-runtime': [
                {
                    source: 'runtime',
                    destination: 'arcane',
                    include: ['modules', 'components', 'sdk'],
                    exclude: []
                }
            ]
        }
    };
    const appRoot = path.join(workspaceRoot, 'apps', 'pwa-app');
    const work = [
        writeJson(workspaceRoot, 'arcane-packager.json', rootConfig),
        writeJson(
            workspaceRoot,
            'arcane.lock.json',
            {sdk: {version: '9.8.7'}}
        ),
        writeJson(appRoot, 'arcane-package.json', packageManifest),
        writeText(
            appRoot,
            'index.html',
            applicationPage('../../', './apps/pwa-app/modules/app.js?v=old&amp;language=fr#graph')
        ),
        writeText(
            appRoot,
            'about.html',
            '<!doctype html><html lang="en"><head><title>About</title></head>'
                + '<body><main>Explicit application page</main>'
                + '<p>./modules/app.js?v=old&amp;language=fr#graph</p>'
                + '<script type="module" src="./modules/app.js?v=old&amp;language=fr#graph"></script>'
                + '</body></html>\n'
        ),
        writeText(
            appRoot,
            'pages/settings.html',
            applicationPage('../../../', './apps/pwa-app/modules/app.js?v=old&amp;language=fr#graph')
        ),
        writeText(
            appRoot,
            'pages/help.html',
            applicationPage('./', '../modules/app.js?v=old&amp;language=fr#graph')
        ),
        writeText(appRoot, 'modules/app.js', 'import \'../../../arcane/modules/Shared.js?v=old&mode=full\';\n'),
        writeJson(
            appRoot,
            'modules/arcane.importmap.json',
            {
                imports: {
                    'arcane/Shared': './arcane/modules/Shared.js?v=old&arcaneVersion=old&mode=full',
                    'arcane/MapOnly': './arcane/modules/MapOnly.js?v=old&flavor=map-only'
                }
            }
        ),
        writeText(appRoot, 'content/document.html', CORPUS_HTML),
        writeText(appRoot, 'img/icon.png', 'synthetic packaged image fixture'),
        writeText(workspaceRoot, 'runtime/modules/Shared.js', 'export const shared = true;\n'),
        writeText(workspaceRoot, 'runtime/modules/MapOnly.js', 'export const mapped = true;\n'),
        writeText(workspaceRoot, 'runtime/components/panel.html', COMPONENT_HTML),
        writeText(workspaceRoot, 'runtime/sdk/pwa.mjs', 'export function registerPwa() {}\n')
    ];
    await Promise.all(work);
    return {workspaceRoot, appRoot, packageManifest};
}

test(
    'PWA descriptor projection preserves metadata and keeps native descriptors separate',
    async function descriptorPwaProjection(context) {
        const fixture = await workspaceFixture(context);
        const descriptor = {
            schemaVersion: 2,
            id: 'pwa-app',
            displayName: 'PWA App',
            description: 'A portable sample application.',
            version: '1.2.3',
            publisher: {id: 'sample-publisher', name: 'Sample Publisher'},
            package: {
                entry: 'index.html',
                strategy: 'static',
                include: fixture.packageManifest.include,
                exclude: [],
                shared: ['browser-runtime'],
                pwa: {enabled: true}
            },
            native: {type: 'app', icon: 'img/icon.png', order: 1, bundledApps: []},
            requirements: {arcaneProtocol: 'arcane/1', minimumCoreVersion: '0.8.12', features: []},
            targets: ['browser', 'windows-x64']
        };
        await writeJson(fixture.appRoot, 'arcane-app.json', descriptor);
        const loaded = await loadAppDescriptor(
            {
                workspaceRoot: fixture.workspaceRoot,
                appRoot: fixture.appRoot,
                appId: 'pwa-app',
                packageManifest: fixture.packageManifest
            }
        );
        assert.equal(loaded.descriptor.package.pwa.enabled, true);
        assert.deepEqual(
            projectPackageManifest(descriptor).pwa,
            {enabled: true, manifest: {}, offline: {include: [], exclude: []}}
        );
        const nativeDescriptor = projectNativeDescriptor(descriptor);
        assert.equal(
            Object.hasOwn(nativeDescriptor, 'pwa'),
            false
        );
        assert.equal(
            normalizePwaConfig(undefined),
            undefined
        );
        const disabledConfig = normalizePwaConfig(
            {}
        );
        assert.equal(disabledConfig.enabled, false);
        assert.throws(
            function invalidPwaSelection() {
                normalizePwaConfig(
                    {enabled: true, offline: {include: null}}
                );
            },
            TypeError
        );
        const metadata = {description: '  ./img/icon.png?v=8\nComplete description.  '};
        const normalized = normalizePwaConfig(
            {enabled: true, manifest: metadata, offline: {include: ['img', 'modules'], exclude: ['img/private']}}
        );
        assert.deepEqual(normalized.manifest, metadata);
        assert.deepEqual(
            selectPwaFiles(
                ['index.html', 'img/icon.png', 'img/private/note.txt', 'modules/app.js'],
                normalized
            ),
            ['img/icon.png', 'modules/app.js']
        );
        assert.deepEqual(
            selectPwaFiles(
                [
                    'index.html',
                    'apps/pwa-app/img/icon.png',
                    'apps/pwa-app/img/private/note.txt',
                    'apps/pwa-app/modules/app.js',
                    'arcane/modules/Shared.js'
                ],
                {
                    ...normalized,
                    offline: {
                        include: ['img', 'modules', 'arcane/modules'],
                        exclude: ['img/private']
                    }
                },
                'apps/pwa-app'
            ),
            [
                'apps/pwa-app/img/icon.png',
                'apps/pwa-app/modules/app.js',
                'arcane/modules/Shared.js'
            ]
        );
    }
);

test(
    'generated manifests map app-relative URLs for source and release without changing metadata',
    function portableManifestUrls() {
        const metadata = {
            id: './',
            start_url: './index.html?conversation=one#start',
            scope: './',
            description: '  Keep ./img/icon.png?v=8 and every line.\nSecond line.  ',
            icons: [
                {src: './img/icon.png?v=8&color=blue#mark', purpose: 'any'},
                {src: 'https://cdn.example.test/icon.png?v=external', purpose: 'any'}
            ],
            screenshots: [{src: './img/screen.png?view=wide', label: './img/screen.png?v=8'}],
            shortcuts: [
                {
                    name: './pages/settings.html?v=8',
                    url: './pages/settings.html?theme=day#appearance',
                    icons: [{src: './img/icon.png?arcaneVersion=old&color=blue#mark'}]
                }
            ],
            applicationExtension: {url: './payload.txt?v=8'}
        };
        const original = structuredClone(metadata);
        const pwa = {enabled: true, manifest: metadata};
        const source = createPwaArtifacts(
            {
                app: {id: 'pwa-app', displayName: 'PWA App', version: '1.2.3', entry: '/apps/pwa-app/index.html'},
                sdkVersion: '9.8.7',
                pwa,
                mode: 'development',
                basePath: '/',
                appBase: '/apps/pwa-app/',
                runtimeBase: '/arcane/sdk/',
                assets: ['/apps/pwa-app/index.html', '/apps/pwa-app/img/icon.png']
            }
        );
        assert.equal(source.manifest.start_url, '/apps/pwa-app/index.html?conversation=one#start');
        assert.equal(source.manifest.scope, '/apps/pwa-app/');
        assert.equal(source.manifest.id, '/apps/pwa-app/');
        assert.equal(source.manifest.icons[0].src, '/apps/pwa-app/img/icon.png?color=blue#mark');
        assert.equal(source.manifest.icons[1].src, metadata.icons[1].src);
        assert.equal(source.manifest.screenshots[0].src, '/apps/pwa-app/img/screen.png?view=wide');
        assert.equal(source.manifest.shortcuts[0].url, '/apps/pwa-app/pages/settings.html?theme=day#appearance');
        assert.equal(source.manifest.shortcuts[0].icons[0].src, '/apps/pwa-app/img/icon.png?color=blue#mark');
        assert.ok(
            source.offlineManifest.assets.includes('/apps/pwa-app/img/icon.png?color=blue#mark')
        );
        assert.equal(source.offlineManifest.revision, 'development');
        assert.equal(
            source.offlineManifest.assets.includes('/arcane-sw.js'),
            false
        );
        assert.deepEqual(metadata, original);
        assert.equal(source.manifest.description, metadata.description);
        assert.deepEqual(source.manifest.applicationExtension, metadata.applicationExtension);
        assert.equal(source.manifest.screenshots[0].label, metadata.screenshots[0].label);
        assert.equal(source.manifest.shortcuts[0].name, metadata.shortcuts[0].name);

        const releaseOptions = {
            app: {id: 'pwa-app', displayName: 'PWA App', version: '1.2.3', entry: 'index.html'},
            sdkVersion: '9.8.7',
            pwa,
            files: ['index.html', 'img/icon.png'],
            revision: 'selected-release-one'
        };
        const release = createPwaArtifacts(releaseOptions);
        assert.equal(release.manifest.start_url, './index.html?conversation=one#start');
        assert.equal(release.manifest.icons[0].src, './img/icon.png?color=blue#mark');
        assert.equal(release.offlineManifest.revision, 'selected-release-one');
        assert.equal(release.offlineManifest.sdkVersion, '9.8.7');
        assert.deepEqual(metadata, original);
        const nestedRelease = createPwaArtifacts(
            {
                ...releaseOptions,
                appPath: 'apps/pwa-app',
                files: ['index.html', 'apps/pwa-app/index.html', 'apps/pwa-app/img/icon.png']
            }
        );
        assert.equal(nestedRelease.manifest.start_url, './apps/pwa-app/index.html?conversation=one#start');
        assert.equal(nestedRelease.manifest.scope, './apps/pwa-app/');
        assert.equal(nestedRelease.manifest.id, './apps/pwa-app/');
        assert.equal(nestedRelease.manifest.icons[0].src, './apps/pwa-app/img/icon.png?color=blue#mark');
        assert.equal(nestedRelease.manifest.shortcuts[0].url, './apps/pwa-app/pages/settings.html?theme=day#appearance');
        assert.deepEqual(metadata, original);
    }
);

test(
    'browser package includes PWA output and every managed page while preserving complete document payloads',
    async function packagedPwaPages(context) {
        const fixture = await workspaceFixture(
            context,
            {enabled: true, offline: {exclude: ['content']}}
        );
        const packaged = await packageApp(
            {workspaceRoot: fixture.workspaceRoot, appId: 'pwa-app'}
        );
        for (const file of ['arcane.webmanifest', 'arcane-offline.json', 'arcane-sw.js', 'arcane-pwa.mjs']) {
            assert.ok(
                packaged.files.includes(file)
            );
            assert.ok(
                packaged.manifest.files.includes(file)
            );
        }
        const expectedReferences = new Map(
            [
                ['apps/pwa-app/index.html', './arcane-pwa.mjs'],
                ['apps/pwa-app/about.html', '../../arcane-pwa.mjs'],
                ['apps/pwa-app/pages/settings.html', './arcane-pwa.mjs'],
                ['apps/pwa-app/pages/help.html', '../../../arcane-pwa.mjs']
            ]
        );
        for (const [file, bootstrapUrl] of expectedReferences) {
            const html = await readFile(
                path.join(packaged.outputRoot, file),
                'utf8'
            );
            assert.match(html, /<script\b(?=[^>]*\bdata-arcane-pwa)(?=[^>]*\basync)[^>]*>/u);
            assert.doesNotMatch(html, /<script\b[^>]*\bsrc="[^"\s]*[?&](?:v|arcaneVersion)=/u);
            assert.ok(
                html.includes(`src="${bootstrapUrl}"`),
                file
            );
            const manifestUrl = bootstrapUrl.replace('arcane-pwa.mjs', 'arcane.webmanifest');
            assert.ok(
                html.includes(`href="${manifestUrl}"`),
                file
            );
            assert.ok(
                html.includes('language=fr#graph')
            );
            assert.ok(
                html.includes('<p>./modules/app.js?v=old&amp;language=fr#graph</p>')
            );
        }
        const offline = JSON.parse(
            await readFile(
                path.join(packaged.outputRoot, 'arcane-offline.json'),
                'utf8'
            )
        );
        assert.equal(offline.appId, 'pwa-app');
        assert.equal(offline.appVersion, '1.2.3');
        assert.equal(offline.sdkVersion, '9.8.7');
        assert.ok(
            offline.assets.includes('./apps/pwa-app/modules/app.js?language=fr')
        );
        assert.ok(
            offline.assets.includes('./arcane/modules/Shared.js?mode=full')
        );
        assert.ok(
            offline.assets.includes('./arcane/modules/MapOnly.js?flavor=map-only')
        );
        assert.equal(
            offline.assets.includes('./arcane-sw.js'),
            false
        );
        assert.equal(
            offline.assets.includes('./apps/pwa-app/content/document.html'),
            false
        );
        const importMap = JSON.parse(
            await readFile(
                path.join(packaged.outputRoot, 'apps/pwa-app/modules/arcane.importmap.json'),
                'utf8'
            )
        );
        assert.equal(importMap.imports['arcane/Shared'], './arcane/modules/Shared.js?mode=full');
        assert.equal(
            await readFile(
                path.join(packaged.outputRoot, 'apps/pwa-app/content/document.html'),
                'utf8'
            ),
            CORPUS_HTML
        );
        assert.equal(
            await readFile(
                path.join(packaged.outputRoot, 'arcane/components/panel.html'),
                'utf8'
            ),
            COMPONENT_HTML
        );
        const authored = await readFile(
            path.join(fixture.appRoot, 'index.html'),
            'utf8'
        );
        assert.equal(
            authored.includes('data-arcane-pwa'),
            false
        );
        assert.ok(
            authored.includes('app.js?v=old&amp;language=fr#graph')
        );
        const manifest = JSON.parse(
            await readFile(
                path.join(packaged.outputRoot, 'arcane.webmanifest'),
                'utf8'
            )
        );
        assert.equal(manifest.id, './');
        assert.equal(manifest.scope, './');
        assert.equal(manifest.start_url, './apps/pwa-app/index.html');
        assert.equal(packaged.manifest.app.entry, 'index.html');
        assert.equal(packaged.manifest.app.start, './apps/pwa-app/index.html');
        const launcher = await readFile(
            path.join(packaged.outputRoot, 'index.html'),
            'utf8'
        );
        assert.ok(launcher.includes('url=./apps/pwa-app/index.html'));
        assert.equal(launcher.includes('data-arcane-pwa'), false);
    }
);

test(
    'PWA entry filenames retain fragment and percent characters while generated links resolve at the deployment root',
    async function encodedPwaEntryPaths(context) {
        const fixture = await workspaceFixture(context);
        const entry = 'pages#review/start%note.html';
        fixture.packageManifest.entry = entry;
        fixture.packageManifest.include.push('pages#review');
        const source = '<!doctype html><html lang="en"><head><title>Review notes</title></head>'
            + '<body><main>Keep pages#review/start%note.html exactly as authored.</main></body></html>\n';
        await Promise.all(
            [
                writeJson(fixture.appRoot, 'arcane-package.json', fixture.packageManifest),
                writeText(fixture.appRoot, entry, source)
            ]
        );
        const packaged = await packageApp(
            {workspaceRoot: fixture.workspaceRoot, appId: 'pwa-app'}
        );
        const packagedEntry = `apps/pwa-app/${entry}`;
        const start = './apps/pwa-app/pages%23review/start%25note.html';
        assert.ok(packaged.files.includes(packagedEntry));
        assert.ok(packaged.manifest.files.includes(packagedEntry));
        assert.equal(packaged.manifest.app.entry, entry);
        assert.equal(packaged.manifest.app.start, start);
        const html = await readFile(path.join(packaged.outputRoot, packagedEntry), 'utf8');
        const bootstrapReference = html.match(/<script\b[^>]*\bsrc="([^"]*arcane-pwa\.mjs)"[^>]*>/u)[1];
        const manifestReference = html.match(/<link\b[^>]*\bhref="([^"]*arcane\.webmanifest)"[^>]*>/u)[1];
        assert.equal(bootstrapReference, '../../../arcane-pwa.mjs');
        assert.equal(manifestReference, '../../../arcane.webmanifest');
        const mount = new URL('https://example.test/catalog/deep/portable-release/');
        const documentUrl = new URL(packaged.manifest.app.start, mount);
        assert.equal(
            new URL(bootstrapReference, documentUrl).href,
            new URL('arcane-pwa.mjs', mount).href
        );
        assert.equal(
            new URL(manifestReference, documentUrl).href,
            new URL('arcane.webmanifest', mount).href
        );
        const manifest = JSON.parse(
            await readFile(path.join(packaged.outputRoot, 'arcane.webmanifest'), 'utf8')
        );
        assert.equal(manifest.start_url, start);
        assert.ok(html.includes('<main>Keep pages#review/start%note.html exactly as authored.</main>'));
        assert.equal(await readFile(path.join(fixture.appRoot, entry), 'utf8'), source);
    }
);

test(
    'native package selection and disabled PWA retain ordinary versioned output',
    async function inactivePwaPackages(context) {
        const native = await workspaceFixture(context);
        const nativeResult = await packageApp(
            {workspaceRoot: native.workspaceRoot, appId: 'pwa-app', browserPwa: false}
        );
        const disabled = await workspaceFixture(
            context,
            {enabled: false}
        );
        const disabledResult = await packageApp(
            {workspaceRoot: disabled.workspaceRoot, appId: 'pwa-app'}
        );
        for (const result of [nativeResult, disabledResult]) {
            assert.equal(
                result.files.includes('arcane-sw.js'),
                false
            );
            assert.equal(
                Object.hasOwn(result.manifest.app, 'pwa'),
                false
            );
            const html = await readFile(
                path.join(result.outputRoot, 'apps/pwa-app/index.html'),
                'utf8'
            );
            assert.equal(
                html.includes('data-arcane-pwa'),
                false
            );
            assert.ok(
                html.includes('arcaneVersion=9.8.7')
            );
        }
    }
);
