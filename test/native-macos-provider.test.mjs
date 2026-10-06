import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import defaultProvider, {arcaneNativeBuilderProvider, createMacOSNativeProvider} from '../src/native/macos-provider.mjs';
import {ERROR_CODES} from '../src/errors.mjs';

const sdkRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = path.join(sdkRoot, '.arcane', 'macos-provider-fixtures');
const hostFiles = ['Arcane', 'runtime/node', 'runtime/NODE-LICENSE', 'LICENSE', 'NOTICE', 'COMMERCIAL-LICENSE.md', 'extra/complete-host-note.txt'];

function target(architecture = 'arm64') {
    return {target: `macos-${architecture}`, platform: 'macos', architecture, format: 'app', signing: 'unsigned-local-test', signingProfileId: null};
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
            "throw new Error('Assembly must not execute application service factories.');",
            'export default function createCheese(options) {',
            "    return {name: 'cheese', methods: {'cheese.read': () => options}};", '}', ''
        ].join('\n'))]
    ]);
    const assets = new Map(hostFiles.map(function syntheticHostFile(relative) {
        return [relative, Buffer.from(`Synthetic fixture only: ${relative}\r\n  Preserve this final line 🦑  \n`)];
    }));
    await writeContents(hostDirectory, assets);
    await chmod(path.join(hostDirectory, 'Arcane'), 0o751);
    await chmod(path.join(hostDirectory, 'runtime/node'), 0o751);
    await mkdir(path.join(hostDirectory, 'extra', 'empty-directory'), {recursive: true});
    await writeContents(appReleaseRoot, contents);
    const services = [{module: 'services/cheese.mjs', options: {instructions: '  Deliver all cheese.\r\nThen report.  ', choice: null}}];
    const appDescriptor = {id: 'moon-cheese-hotline', displayName: 'Moon Cheese & <Hotline>', version: '1.2.3', native: {services}};
    const release = {files: [...contents.keys()], manifest: {app: {start: './pages/dispatch.html?desk=moon#reply'}}};
    return {
        root, hostDirectory, appReleaseRoot, outputRoot, contents, assets, services,
        request: {appDescriptor, appReleaseRoot, release, dependencies: [], minimumCoreVersion: '0.1.0', protectedRoots: [], outputRoot, targetRequest: target()}
    };
}

async function withFetch(replacement, work) {
    const previous = globalThis.fetch;
    globalThis.fetch = replacement;
    try { return await work(); }
    finally { globalThis.fetch = previous; }
}

test('macOS provider prepares both SDK-owned architectures without downloading or executing them', async function prepareHost(t) {
    const fixture = await createFixture(t);
    const provider = createMacOSNativeProvider({hostDirectory: fixture.hostDirectory});
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    assert.equal(defaultProvider, arcaneNativeBuilderProvider);
    assert.equal(provider.protocol, 'arcane-native-builder/1');
    for (const method of ['describe', 'doctor', 'prepare', 'build', 'verify', 'run']) assert.equal(typeof provider[method], 'function');
    assert.deepEqual(await provider.describe(), {
        protocol: 'arcane-native-builder/1', id: 'arcane-sdk-macos', targets: ['macos-arm64', 'macos-x64'],
        executable: true, serviceConfiguration: 'explicit release module factories'
    });
    await withFetch(function unexpectedFetch() { throw new Error('Preparation must not download assets.'); }, async function prepare() {
        for (const architecture of ['arm64', 'x64']) {
            const selected = target(architecture);
            const doctor = await provider.doctor({targetRequest: selected});
            assert.equal(doctor.ready, true);
            assert.deepEqual(doctor.missing, []);
            assert.equal(doctor.target, selected.target);
            const prepared = await provider.prepare({targetRequest: selected});
            assert.equal(prepared.sdkVersion, metadata.version);
            assert.deepEqual(prepared.target, selected);
            assert.equal(prepared.hostDirectory, await realpath(fixture.hostDirectory));
            assert.equal((await defaultProvider.prepare({targetRequest: selected})).hostDirectory, undefined);
        }
    });
    await rm(path.join(fixture.hostDirectory, 'runtime/node'));
    assert.deepEqual((await provider.doctor({targetRequest: target()})).missing, ['runtime/node']);
    await assert.rejects(provider.prepare({targetRequest: target()}), function incomplete(error) {
        assert.equal(error.code, ERROR_CODES.prerequisiteMissing);
        assert.deepEqual(error.details.missing, ['runtime/node']);
        return true;
    });
    await assert.rejects(provider.prepare({targetRequest: {...target(), platform: 'windows'}}), {code: ERROR_CODES.targetUnavailable});
});

test('macOS bundles preserve the complete portable payload and selected executable host assets', async function composeApplication(t) {
    const fixture = await createFixture(t);
    const launchContext = {sharedHost: {}, stateRoot: '../app-selected state', payload: '  Complete 🧀\r\n  '};
    fixture.request.appDescriptor.native.launchContext = launchContext;
    const provider = createMacOSNativeProvider({hostDirectory: fixture.hostDirectory});
    const dependencyRoot = path.join(fixture.root, 'selected-dependency');
    const dependencyContents = new Map([['index.html', Buffer.from('<p>Every cheese satellite is included. 🧀</p>')]]);
    await writeContents(dependencyRoot, dependencyContents);
    for (const architecture of ['arm64', 'x64']) {
        const events = [];
        const selected = target(architecture);
        const artifact = await provider.build({
            ...fixture.request, targetRequest: selected,
            dependencies: [{appId: 'cheese-satellite', releaseRoot: dependencyRoot, release: {files: [...dependencyContents.keys()]}}],
            onEvent: function observe(event) { events.push(event); }
        });
        const root = artifact.target.rootDir;
        assert.equal(root, path.join(artifact.bundleRoot, 'Contents', 'Resources'));
        assert.equal(path.basename(artifact.bundleRoot), 'moon-cheese-hotline.app');
        assert.deepEqual(artifact.target, {...selected, rootDir: root});
        assert.equal(artifact.manifest.kind, 'arcane-macos-native');
        assert.deepEqual(artifact.manifest.target, selected);
        assert.deepEqual(artifact.manifest.host, {
            executable: '../MacOS/Arcane', platform: 'macos', architecture, runtime: 'webkit',
            coreExecutable: 'runtime/node', coreEntry: 'runtime/arcane-core.mjs',
            bundleIdentifier: 'org.arcane.moon-cheese-hotline', infoPlist: '../Info.plist'
        });
        assert.equal(artifact.manifest.start, './pages/dispatch.html?desk=moon#reply');
        assert.equal(artifact.manifest.webRoot, 'app');
        assert.equal(artifact.manifest.client.webKitDocumentLifecycle, true);
        assert.equal(artifact.manifest.client.replayRuntimeState, true);
        assert.deepEqual(artifact.manifest.core.services, fixture.services);
        assert.deepEqual(artifact.manifest.launchContext, launchContext);
        assert.deepEqual(artifact.manifest.app.native.launchContext, launchContext);
        await assertContents(path.join(root, 'app'), fixture.contents);
        await assertContents(path.join(root, 'dependencies', '0'), dependencyContents);
        for (const [relative, content] of fixture.assets) {
            const destination = relative === 'Arcane' ? path.resolve(root, '../MacOS/Arcane') : path.join(root, relative);
            assert.deepEqual(await readFile(destination), content, relative);
        }
        assert.deepEqual(await readdir(path.join(root, 'extra/empty-directory')), []);
        if (process.platform !== 'win32') {
            assert.equal((await stat(path.resolve(root, '../MacOS/Arcane'))).mode & 0o777, 0o751);
            assert.equal((await stat(path.join(root, 'runtime/node'))).mode & 0o777, 0o751);
        }
        const entry = await readFile(path.join(root, 'runtime/arcane-core.mjs'), 'utf8');
        assert.ok(entry.includes('arcane-os/core/packaged-web'));
        assert.ok(entry.includes(JSON.stringify(JSON.stringify(fixture.services[0].options))));
        const plist = await readFile(path.resolve(root, '../Info.plist'), 'utf8');
        assert.ok(plist.includes('<string>org.arcane.moon-cheese-hotline</string>'));
        assert.ok(plist.includes('<string>Moon Cheese &amp; &lt;Hotline&gt;</string>'));
        assert.equal(JSON.parse(await readFile(path.join(root, 'node_modules/arcane-os/package.json'), 'utf8')).name, 'arcane-os');
        assert.ok(!artifact.manifest.files.includes('../MacOS/Arcane'));
        for (const relative of hostFiles.filter(function resource(name) { return name !== 'Arcane'; })) assert.ok(artifact.manifest.files.includes(relative), relative);
        assert.deepEqual(JSON.parse(await readFile(path.join(root, 'arcane-native.json'), 'utf8')), artifact.manifest);
        assert.deepEqual(events.filter(function completed(event) { return event.type === 'native.payload.completed'; }), [
            {type: 'native.payload.completed', target: selected.target, appId: fixture.request.appDescriptor.id, outputRoot: root, bundleRoot: artifact.bundleRoot}
        ]);
        const verified = await provider.verify({artifact, targetRequest: selected});
        assert.equal(verified.executable, true);
        assert.equal(verified.target, selected.target);
        assert.equal(verified.bundleRoot, artifact.bundleRoot);
        assert.deepEqual(verified.manifest, artifact.manifest);
        await rm(path.resolve(root, '../MacOS/Arcane'));
        await assert.rejects(provider.verify({artifact, targetRequest: selected}), {code: 'ENOENT'});
    }
    await assertContents(fixture.hostDirectory, fixture.assets);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test('macOS assembly uses the matching architecture cache and respects explicit empty service selection', async function cachedHost(t) {
    const fixture = await createFixture(t);
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const cachedHost = path.join(fixture.outputRoot, '.arcane-native-hosts', metadata.version, 'macos-x64');
    await writeContents(cachedHost, fixture.assets);
    const provider = createMacOSNativeProvider({services: []});
    const artifact = await withFetch(function unexpectedFetch() { throw new Error('The exact SDK/architecture cache must be reused.'); },
        function build() { return provider.build({...fixture.request, targetRequest: target('x64')}); });
    assert.deepEqual(artifact.manifest.core.services, []);
    assert.equal(artifact.manifest.sdk.version, metadata.version);
    assert.equal(artifact.manifest.target.architecture, 'x64');
    await assertContents(cachedHost, fixture.assets);
});

test('macOS host collisions preserve selected content and earlier bundles', async function hostCollision(t) {
    const fixture = await createFixture(t);
    const colliding = Buffer.from('This host must not replace the assembled Core entry.\n');
    await writeContents(fixture.hostDirectory, new Map([['runtime/arcane-core.mjs', colliding]]));
    const prior = Buffer.from('An earlier application bundle stays unchanged.\n');
    await writeContents(fixture.outputRoot, new Map([['prior-app/keep.txt', prior]]));
    const provider = createMacOSNativeProvider({hostDirectory: fixture.hostDirectory});
    await assert.rejects(provider.build(fixture.request), {code: 'EEXIST'});
    assert.deepEqual(await readdir(fixture.outputRoot), ['prior-app']);
    assert.deepEqual(await readFile(path.join(fixture.outputRoot, 'prior-app/keep.txt')), prior);
    assert.deepEqual(await readFile(path.join(fixture.hostDirectory, 'runtime/arcane-core.mjs')), colliding);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test('macOS completion cancellation cleans only the unaccepted owned assembly', async function completionCancellation(t) {
    const fixture = await createFixture(t);
    const controller = new AbortController();
    const reason = new Error('Caller cancelled at the complete macOS payload boundary.');
    const provider = createMacOSNativeProvider({hostDirectory: fixture.hostDirectory});
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

test('macOS download failures retain full diagnostics and use the exact selected SDK architecture asset', async function downloadFailure(t) {
    const fixture = await createFixture(t);
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const response = '  Host asset is unavailable.\r\nFull upstream response: 日本語 🦑\nLast line.  ';
    const calls = [];
    await withFetch(async function unavailable(url, options) {
        calls.push({url, options});
        return {ok: false, status: 503, text: async function text() { return response; }};
    }, async function buildUnavailable() {
        await assert.rejects(defaultProvider.build({...fixture.request, targetRequest: target('x64')}), function rejected(error) {
            assert.equal(error.code, ERROR_CODES.prerequisiteMissing);
            assert.equal(error.details.response, response);
            assert.equal(error.details.status, 503);
            return true;
        });
    });
    assert.deepEqual(calls, [{
        url: `https://github.com/TheWizardNexus/arcane-os-sdk/releases/download/${metadata.version}/arcane-native-macos-x64.tar.gz`,
        options: {signal: undefined}
    }]);
    assert.deepEqual(await readdir(fixture.outputRoot), ['.arcane-native-hosts']);
    assert.deepEqual(await readdir(path.join(fixture.outputRoot, '.arcane-native-hosts', metadata.version)), []);
    await assertContents(fixture.appReleaseRoot, fixture.contents);
});

test('macOS run rejects a mismatched actual host before starting a process', async function unsupportedHost() {
    const selected = target(process.platform === 'darwin' && process.arch === 'arm64' ? 'x64' : 'arm64');
    await assert.rejects(defaultProvider.run({targetRequest: selected}), {code: ERROR_CODES.nativeRunUnsupported});
});
