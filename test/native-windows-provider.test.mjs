import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import defaultProvider, {arcaneNativeBuilderProvider, createWindowsNativeProvider} from '../src/native/windows-provider.mjs';
import {ERROR_CODES} from '../src/errors.mjs';

const sdkRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = path.join(sdkRoot, '.arcane', 'windows-provider-fixtures');
const target = {target: 'windows-x64', platform: 'windows', architecture: 'x64', format: 'exe', signing: 'unsigned-local-test', signingProfileId: null};
const hostFiles = [
    'Arcane.exe', 'Arcane.exe.config', 'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll',
    'runtime/ArcaneCore.exe', 'runtime/arcane-core-loader.cjs',
    'runtime/NODE-LICENSE', 'WEBVIEW2-LICENSE', 'LICENSE', 'NOTICE', 'COMMERCIAL-LICENSE.md',
    'extra/complete-host-note.txt', 'extra/Arcane.exe', 'extra/Arcane.exe.config'
];

function assembledHostAssets(assets, executable = 'Moon Cheese Hotline.exe') {
    return new Map(
        [...assets].map(
            function emittedAsset([relative, content]) {
                if (relative === 'Arcane.exe') return [executable, content];
                if (relative === 'Arcane.exe.config') return [`${executable}.config`, content];
                return [relative, content];
            }
        )
    );
}

async function writeContents(root, contents) {
    for (const [relative, content] of contents) {
        const destination = path.join(root, relative);
        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, content);
    }
}

async function assertContents(root, contents) {
    for (const [relative, content] of contents) {
        assert.deepEqual(await readFile(path.join(root, relative)), content, relative);
    }
}

async function createFixture(t) {
    await mkdir(fixtureDirectory, {recursive: true});
    const root = await mkdtemp(path.join(fixtureDirectory, 'case-'));
    t.after(async function removeOwnedFixture() {
        const relative = path.relative(fixtureDirectory, root);
        assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        await rm(root, {recursive: true, force: true});
    });
    const hostDirectory = path.join(root, 'selected-host');
    const appReleaseRoot = path.join(root, 'selected-app');
    const outputRoot = path.join(root, 'native-output');
    const contents = new Map([
        ['index.html', Buffer.from('<!doctype html>\r\n<main>  Moon cheese hotline 🧀\nNo cheese left behind.  </main>\r\n')],
        ['pages/dispatch.html', Buffer.from('<base href="../"><p>日本語 e\u0301</p>')],
        ['assets/cheese.bin', Buffer.from([0, 255, 128, 13, 10, 7])],
        ['runtime/sdk/event-manager.mjs', Buffer.from('export const events = {label: "fixture event owner"};\n')],
        ['services/cheese.mjs', Buffer.from([
            "throw new Error('Assembly must not execute app service factories.');",
            'export default function createCheese(options) {',
            "    return {name: 'cheese', methods: {'cheese.read': () => options}};",
            '}', ''
        ].join('\n'))]
    ]);
    const assets = new Map(hostFiles.map(function syntheticHostFile(relative) {
        return [relative, Buffer.from(`Synthetic fixture only: ${relative}\r\n  Preserve this final line 🦑  \n`)];
    }));
    await writeContents(hostDirectory, assets);
    await mkdir(path.join(hostDirectory, 'extra', 'empty-directory'), {recursive: true});
    await writeContents(appReleaseRoot, contents);
    const services = [{module: 'services/cheese.mjs', options: {instructions: '  Deliver all cheese.\r\nThen report.  ', choice: null}}];
    const appDescriptor = {id: 'moon-cheese-hotline', displayName: 'Moon Cheese Hotline', version: '1.2.3', native: {services}};
    const release = {files: [...contents.keys()], manifest: {app: {start: './pages/dispatch.html'}}};
    return {
        root, hostDirectory, appReleaseRoot, outputRoot, contents, assets, services,
        request: {appDescriptor, appReleaseRoot, release, dependencies: [], minimumCoreVersion: '0.1.0', protectedRoots: [], outputRoot, targetRequest: {...target}}
    };
}

async function withFetch(replacement, work) {
    const previous = globalThis.fetch;
    globalThis.fetch = replacement;
    try { return await work(); }
    finally { globalThis.fetch = previous; }
}

test('Windows provider describes and prepares its SDK-owned executable without downloading or running a host', async function prepareHost(t) {
    const fixture = await createFixture(t);
    const provider = createWindowsNativeProvider({hostDirectory: fixture.hostDirectory});
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    assert.equal(defaultProvider, arcaneNativeBuilderProvider);
    assert.equal(provider.protocol, 'arcane-native-builder/1');
    for (const method of ['describe', 'doctor', 'prepare', 'build', 'verify', 'run']) assert.equal(typeof provider[method], 'function');
    assert.deepEqual(await provider.describe(), {
        protocol: 'arcane-native-builder/1', id: 'arcane-sdk-windows-x64',
        targets: ['windows-x64'], executable: true, serviceConfiguration: 'explicit release module factories'
    });
    await withFetch(function unexpectedFetch() { throw new Error('Preparation must not download assets.'); }, async function prepare() {
        const doctor = await provider.doctor({targetRequest: target});
        assert.equal(doctor.ready, true);
        assert.deepEqual(doctor.missing, []);
        assert.equal(doctor.hostSource, 'selected-directory');
        const prepared = await provider.prepare({targetRequest: target});
        assert.equal(prepared.sdkVersion, metadata.version);
        assert.deepEqual(prepared.target, target);
        assert.equal(prepared.hostDirectory, await realpath(fixture.hostDirectory));
        const selected = await defaultProvider.prepare({targetRequest: target});
        assert.equal(selected.sdkVersion, metadata.version);
        assert.equal(selected.hostDirectory, undefined);
    });
    await rm(path.join(fixture.hostDirectory, 'WebView2Loader.dll'));
    assert.deepEqual((await provider.doctor({targetRequest: target})).missing, ['WebView2Loader.dll']);
    await assert.rejects(provider.prepare({targetRequest: target}), function incomplete(error) {
        assert.equal(error.code, ERROR_CODES.prerequisiteMissing);
        assert.deepEqual(error.details.missing, ['WebView2Loader.dll']);
        return true;
    });
    await assert.rejects(provider.prepare({targetRequest: {...target, platform: 'linux'}}), {code: ERROR_CODES.targetUnavailable});
});

test('Windows assembly preserves complete selected payloads, app services and the whole precompiled host tree', async function composeExecutable(t) {
    const fixture = await createFixture(t);
    const provider = createWindowsNativeProvider({hostDirectory: fixture.hostDirectory});
    const dependencyRoot = path.join(fixture.root, 'selected-dependency');
    const dependencyContents = new Map([['index.html', Buffer.from('<p>Every cheese satellite is included. 🧀</p>')]]);
    await writeContents(dependencyRoot, dependencyContents);
    const events = [];
    const artifact = await provider.build({
        ...fixture.request,
        dependencies: [{appId: 'cheese-satellite', releaseRoot: dependencyRoot, release: {files: [...dependencyContents.keys()]}}],
        onEvent: function observe(event) { events.push(event); }
    });
    const root = artifact.target.rootDir;
    assert.deepEqual(artifact.target, {...target, rootDir: root});
    assert.equal(artifact.manifest.kind, 'arcane-windows-native');
    assert.deepEqual(artifact.manifest.target, target);
    assert.deepEqual(artifact.manifest.host, {
        executable: 'Moon Cheese Hotline.exe', platform: 'windows', architecture: 'x64', runtime: 'webview2',
        coreExecutable: 'runtime/ArcaneCore.exe', coreLoader: 'runtime/arcane-core-loader.cjs'
    });
    assert.equal(artifact.manifest.start, './pages/dispatch.html');
    assert.equal(artifact.manifest.client.source, 'runtime/arcane-api.js');
    assert.equal(artifact.manifest.core.entry, 'runtime/arcane-core.mjs');
    assert.deepEqual(artifact.manifest.core.services, fixture.services);
    await assertContents(path.join(root, 'app'), fixture.contents);
    await assertContents(path.join(root, 'dependencies', '0'), dependencyContents);
    const emittedAssets = assembledHostAssets(fixture.assets);
    await assertContents(root, emittedAssets);
    assert.deepEqual(await readdir(path.join(root, 'extra', 'empty-directory')), []);
    assert.equal(JSON.parse(await readFile(path.join(root, 'node_modules/arcane-os/package.json'), 'utf8')).name, 'arcane-os');
    const entry = await readFile(path.join(root, 'runtime/arcane-core.mjs'), 'utf8');
    assert.ok(entry.includes('services/cheese.mjs'));
    assert.ok(entry.includes(JSON.stringify(JSON.stringify(fixture.services[0].options))));
    for (const relative of emittedAssets.keys()) assert.ok(artifact.manifest.files.includes(relative), relative);
    assert.equal(artifact.manifest.files.includes('Arcane.exe'), false);
    assert.equal(artifact.manifest.files.includes('Arcane.exe.config'), false);
    await assert.rejects(
        readFile(path.join(root, 'Arcane.exe')),
        {code: 'ENOENT'}
    );
    await assert.rejects(
        readFile(path.join(root, 'Arcane.exe.config')),
        {code: 'ENOENT'}
    );
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'arcane-native.json'), 'utf8')), artifact.manifest);
    assert.deepEqual(events.filter(function completed(event) { return event.type === 'native.payload.completed'; }), [
        {type: 'native.payload.completed', target: 'windows-x64', appId: fixture.request.appDescriptor.id, outputRoot: root}
    ]);
    const verified = await provider.verify({artifact, targetRequest: target});
    assert.equal(verified.executable, true);
    assert.equal(verified.target, 'windows-x64');
    assert.deepEqual(verified.manifest, artifact.manifest);
    await rm(path.join(root, 'Moon Cheese Hotline.exe'));
    await assert.rejects(provider.verify({artifact, targetRequest: target}), {code: 'ENOENT'});
    await assertContents(fixture.hostDirectory, fixture.assets);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test('Windows assembly forwards optional window sizing without replacing services', async function nativeWindowManifest(t) {
    const fixture = await createFixture(t);
    const window = {width: 1280, height: 800, resizable: false};
    fixture.request.appDescriptor.native.window = window;
    const launchContext = {sharedHost: {}, stateRoot: '../app-selected state', payload: '  Complete 🧀\r\n  '};
    fixture.request.appDescriptor.native.launchContext = launchContext;
    const provider = createWindowsNativeProvider({hostDirectory: fixture.hostDirectory});
    const artifact = await provider.build(fixture.request);
    assert.deepEqual(artifact.manifest.window, window);
    assert.deepEqual(artifact.manifest.core.services, fixture.services);
    const saved = JSON.parse(await readFile(path.join(artifact.target.rootDir, 'arcane-native.json'), 'utf8'));
    assert.deepEqual(saved.window, window);
    assert.deepEqual(saved.app.native.window, window);
    assert.deepEqual(saved.launchContext, launchContext);
    assert.deepEqual(saved.app.native.launchContext, launchContext);
});

test('Windows assembly reuses the exact SDK-version output cache and explicit empty services override app services', async function cachedHost(t) {
    const fixture = await createFixture(t);
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const cachedHost = path.join(fixture.outputRoot, '.arcane-native-hosts', metadata.version, 'windows-x64');
    await writeContents(cachedHost, fixture.assets);
    const provider = createWindowsNativeProvider({services: []});
    const artifact = await withFetch(function unexpectedFetch() { throw new Error('The completed exact-version cache must be reused.'); },
        function build() { return provider.build(fixture.request); });
    assert.deepEqual(artifact.manifest.core.services, []);
    await assertContents(artifact.target.rootDir, assembledHostAssets(fixture.assets));
    await assertContents(cachedHost, fixture.assets);
    assert.equal(artifact.manifest.sdk.version, metadata.version);
});

test('Windows host collisions preserve selected content and earlier outputs while removing only the failed assembly', async function hostCollision(t) {
    const fixture = await createFixture(t);
    const colliding = Buffer.from('This host must not replace the assembled Core service entry.\n');
    await writeContents(fixture.hostDirectory, new Map([['runtime/arcane-core.mjs', colliding]]));
    const prior = Buffer.from('An earlier application artifact remains unchanged.\n');
    await writeContents(fixture.outputRoot, new Map([['prior-app/keep.txt', prior]]));
    const provider = createWindowsNativeProvider({hostDirectory: fixture.hostDirectory});
    await assert.rejects(provider.build(fixture.request), {code: 'EEXIST'});
    assert.deepEqual(await readdir(fixture.outputRoot), ['prior-app']);
    assert.deepEqual(await readFile(path.join(fixture.outputRoot, 'prior-app/keep.txt')), prior);
    assert.deepEqual(await readFile(path.join(fixture.hostDirectory, 'runtime/arcane-core.mjs')), colliding);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test('Windows completion cancellation remains observable and removes the unaccepted assembly', async function completionCancellation(t) {
    const fixture = await createFixture(t);
    const controller = new AbortController();
    const reason = new Error('Caller cancelled at the complete Windows payload boundary.');
    const provider = createWindowsNativeProvider({hostDirectory: fixture.hostDirectory});
    await assert.rejects(provider.build({
        ...fixture.request, signal: controller.signal,
        onEvent: function observe(event) { if (event.type === 'native.payload.completed') controller.abort(reason); }
    }), function cancelled(error) {
        assert.equal(error.code, ERROR_CODES.cancelled);
        assert.equal(error.cause, reason);
        return true;
    });
    assert.deepEqual(await readdir(fixture.outputRoot), []);
    await assertContents(fixture.hostDirectory, fixture.assets);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test('Windows download failures preserve complete upstream diagnostics and select the installed SDK numeric release', async function downloadFailure(t) {
    const fixture = await createFixture(t);
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const response = '  Host asset is unavailable.\r\nFull upstream response: 日本語 🦑\nLast line.  ';
    const calls = [];
    await withFetch(async function unavailable(url, options) {
        calls.push({url, options});
        return {ok: false, status: 503, text: async function text() { return response; }};
    }, async function buildUnavailable() {
        await assert.rejects(defaultProvider.build(fixture.request), function rejected(error) {
            assert.equal(error.code, ERROR_CODES.prerequisiteMissing);
            assert.equal(error.details.response, response);
            assert.equal(error.details.status, 503);
            return true;
        });
    });
    assert.deepEqual(calls, [{
        url: `https://github.com/TheWizardNexus/arcane-os-sdk/releases/download/${metadata.version}/arcane-native-windows-x64.tar.gz`,
        options: {signal: undefined}
    }]);
    assert.deepEqual(await readdir(fixture.outputRoot), ['.arcane-native-hosts']);
    assert.deepEqual(await readdir(path.join(fixture.outputRoot, '.arcane-native-hosts', metadata.version)), []);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test(
    'Windows branding resolves nested app icons and preserves other image formats through a developer event',
    async function preserveNestedIcon(t) {
        const fixture = await createFixture(t);
        const icon = 'assets/cheese 🧀.svg';
        const selectedIcon = `apps/moon-cheese-hotline/${icon}`;
        const iconSource = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>  Moon cheese 🧀\nKeep the complete original.  </title></svg>\n');
        const nestedEntry = 'apps/moon-cheese-hotline/pages/dispatch.html';
        const contents = new Map(fixture.contents);
        contents.set(selectedIcon, iconSource);
        contents.set(nestedEntry, Buffer.from('<!doctype html><title>Nested cheese dispatch</title>'));
        await writeContents(fixture.appReleaseRoot, contents);
        const events = [];
        const provider = createWindowsNativeProvider(
            {hostDirectory: fixture.hostDirectory}
        );
        const artifact = await provider.build(
            {
                ...fixture.request,
                appDescriptor: {
                    ...fixture.request.appDescriptor,
                    package: {entry: 'pages/dispatch.html'},
                    native: {...fixture.request.appDescriptor.native, icon}
                },
                release: {
                    files: [...contents.keys()],
                    manifest: {
                        app: {
                            entry: 'pages/dispatch.html',
                            start: './apps/moon-cheese-hotline/pages/dispatch.html'
                        }
                    }
                },
                onEvent: function observeIconEvent(event) {
                    events.push(event);
                }
            }
        );
        assert.equal(artifact.manifest.host.icon, `app/${selectedIcon}`);
        assert.equal(artifact.manifest.host.executableIcon, false);
        const unsupported = events.filter(
            function unsupportedIcon(event) {
                return event.type === 'native.icon.unsupported';
            }
        );
        assert.equal(unsupported.length, 1);
        assert.equal(unsupported[0].icon, icon);
        assert.equal(unsupported[0].code, 'ARCANE_WINDOWS_ICON_UNSUPPORTED');
        assert.match(unsupported[0].message, /\.svg/u);
        assert.equal(unsupported[0].executable, false);
        assert.ok(
            events.some(
                function completed(event) {
                    return event.type === 'native.payload.completed';
                }
            )
        );
        await assertContents(path.join(artifact.target.rootDir, 'app'), contents);
        await assertContents(artifact.target.rootDir, assembledHostAssets(fixture.assets));
        await assertContents(fixture.appReleaseRoot, contents);
        await assertContents(fixture.hostDirectory, fixture.assets);
    }
);

test(
    'Windows emitted names preserve app text and derive only platform-required filename syntax',
    async function applicationNames(t) {
        const cases = [
            {displayName: 'KEMPO', executable: 'KEMPO.exe'},
            {displayName: '月: "Cheese"/\\|?*<>\u0001. ', executable: '月_ _Cheese_________. .exe'},
            {displayName: 'COM¹.dispatch', executable: '_COM¹.dispatch.exe'},
            {displayName: undefined, executable: 'moon-cheese-hotline.exe'}
        ];
        for (const selected of cases) {
            const fixture = await createFixture(t);
            const appDescriptor = {...fixture.request.appDescriptor};
            if (selected.displayName === undefined) delete appDescriptor.displayName;
            else appDescriptor.displayName = selected.displayName;
            const original = JSON.stringify(appDescriptor);
            const provider = createWindowsNativeProvider(
                {hostDirectory: fixture.hostDirectory}
            );
            const artifact = await provider.build(
                {...fixture.request, appDescriptor}
            );
            assert.equal(artifact.manifest.host.executable, selected.executable);
            assert.equal(JSON.stringify(appDescriptor), original);
            assert.deepEqual(artifact.manifest.app, appDescriptor);
            await assertContents(
                artifact.target.rootDir,
                assembledHostAssets(fixture.assets, selected.executable)
            );
            const verified = await provider.verify(
                {artifact, targetRequest: target}
            );
            assert.equal(verified.manifest.host.executable, selected.executable);
            await assertContents(fixture.hostDirectory, fixture.assets);
        }
    }
);

test(
    'Windows verification follows the saved launcher name of an existing generic artifact',
    async function existingGenericArtifact(t) {
        const fixture = await createFixture(t);
        const provider = createWindowsNativeProvider(
            {hostDirectory: fixture.hostDirectory}
        );
        const artifact = await provider.build(
            {
                ...fixture.request,
                appDescriptor: {...fixture.request.appDescriptor, displayName: 'Arcane'}
            }
        );
        const manifest = {
            ...artifact.manifest,
            app: {...artifact.manifest.app, displayName: 'Original application name'}
        };
        await writeFile(
            path.join(artifact.target.rootDir, 'arcane-native.json'),
            JSON.stringify(manifest)
        );
        const verified = await provider.verify(
            {artifact: {...artifact, manifest: null}, targetRequest: target}
        );
        assert.equal(verified.manifest.host.executable, 'Arcane.exe');
        assert.equal(verified.manifest.app.displayName, 'Original application name');
        await assertContents(artifact.target.rootDir, fixture.assets);
    }
);

test(
    'An app-named launcher never overwrites an independent host asset',
    async function applicationNameCollision(t) {
        const fixture = await createFixture(t);
        const extra = new Map(
            [['Moon Cheese Hotline.exe', Buffer.from('An independent selected host asset remains complete. 🧀\n')]]
        );
        await writeContents(fixture.hostDirectory, extra);
        const provider = createWindowsNativeProvider(
            {hostDirectory: fixture.hostDirectory}
        );
        await assert.rejects(
            provider.build(fixture.request),
            {code: 'EEXIST'}
        );
        assert.deepEqual(await readdir(fixture.outputRoot), []);
        await assertContents(fixture.hostDirectory, extra);
        await assertContents(fixture.hostDirectory, fixture.assets);
    }
);
