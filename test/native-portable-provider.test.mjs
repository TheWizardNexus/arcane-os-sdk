import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import defaultProvider, {arcaneNativeBuilderProvider, createPortableNativeProvider} from '../src/native/portable-provider.mjs';
import {ERROR_CODES} from '../src/errors.mjs';

const sdkRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = path.join(sdkRoot, '.arcane', 'portable-provider-fixtures');
const eventModule = 'arcane runtime/sdk/event-manager.mjs';
const application = {id: 'moon-cheese-post', name: 'Moon Cheese Post', version: '1.2.3', display: {language: '日本語'}};
const target = {target: 'portable', platform: 'linux', architecture: 'x64', format: 'portable', signing: 'unsigned-local-test', signingProfileId: null};

async function createFixture(t) {
    await mkdir(fixtureDirectory, {recursive: true});
    const root = await mkdtemp(path.join(fixtureDirectory, 'case-'));
    t.after(async function removeOwnedFixture() {
        const relative = path.relative(fixtureDirectory, root);
        assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        await rm(root, {recursive: true, force: true});
    });
    const releaseRoot = path.join(root, 'selected-app');
    const outputRoot = path.join(root, 'native-output');
    const contents = new Map([
        ['index.html', Buffer.from('<!doctype html>\r\n<main>  Café e\u0301 🦑\nA cheese shipment for the Moon.  </main>\r\n')],
        ['pages/arrival.html', Buffer.from('<base href="../"><p>日本語\r\nKeep this nested page unchanged.</p>')],
        ['assets/dispatch.bin', Buffer.from([0, 255, 128, 10, 13, 0, 64, 7])],
        [eventModule, Buffer.from('export const events = {label: "synthetic app event owner"};\n')],
        ['services/dispatch.mjs', Buffer.from([
            "throw new Error('App services must not execute during portable assembly.');",
            'export default function createDispatch(options) {',
            "    return {name: 'dispatch', methods: {'dispatch.read': function read() { return options; }}};",
            '}',
            ''
        ].join('\n'))]
    ]);
    for (const [relative, content] of contents) {
        const destination = path.join(releaseRoot, relative);
        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, content);
    }
    const release = {
        appId: application.id,
        files: [...contents.keys()],
        manifest: {app: {start: './pages/arrival.html'}, presentation: {title: 'The Moon deserves cheese. 🧀'}}
    };
    return {
        root, releaseRoot, outputRoot, contents, release,
        request: {
            toolchain: {label: 'selected SDK source'},
            appDescriptor: application,
            appReleaseRoot: releaseRoot,
            release,
            dependencies: [],
            minimumCoreVersion: '0.1.0',
            protectedRoots: [],
            outputRoot,
            targetRequest: {...target}
        }
    };
}

async function assertReleasePreserved(root, contents) {
    for (const [relative, content] of contents) {
        assert.deepEqual(await readFile(path.join(root, relative)), content, relative);
    }
}

test('portable provider is package-owned and describes a payload rather than an executable host', async function packageOwnedProvider(t) {
    const fixture = await createFixture(t);
    const foreignRoot = path.join(fixture.root, 'unrelated-toolchain');
    await mkdir(foreignRoot);
    await writeFile(path.join(foreignRoot, 'package.json'), '{"name":"not-the-sdk","version":"99.0.0"}\n');
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    const provider = createPortableNativeProvider();
    const events = [];
    const selection = {
        targetRequest: {...target},
        toolchainRoot: foreignRoot,
        onEvent: function observe(event) { events.push(event); }
    };

    assert.equal(defaultProvider, arcaneNativeBuilderProvider);
    assert.equal(provider.protocol, 'arcane-native-builder/1');
    assert.deepEqual(await provider.describe(), {
        protocol: 'arcane-native-builder/1',
        id: 'arcane-sdk-portable',
        targets: ['portable'],
        executable: false,
        serviceConfiguration: 'explicit release module factories'
    });
    const readiness = await provider.doctor(selection);
    assert.equal(readiness.ready, true);
    assert.equal(readiness.executable, false);
    assert.deepEqual(readiness.missing, []);
    assert.equal(await realpath(readiness.sdkRoot), await realpath(sdkRoot));
    const preparation = await provider.prepare(selection);
    assert.equal(await realpath(preparation.sdkRoot), await realpath(sdkRoot));
    assert.equal(preparation.sdkVersion, metadata.version);
    assert.deepEqual(preparation.target, target);
    assert.equal(preparation.executable, false);
    assert.deepEqual(events.map(function eventType(event) { return event.type; }), ['native.doctor.completed', 'native.prepared']);
    await assert.rejects(provider.doctor({targetRequest: {target: 'windows-x64'}}), {code: ERROR_CODES.targetUnavailable});
    await assert.rejects(provider.run({artifact: {target: {rootDir: fixture.outputRoot}}}), {code: ERROR_CODES.nativeRunUnsupported});
});

test('portable assembly preserves complete app and dependency files and authors service composition without executing it', async function completePayload(t) {
    const fixture = await createFixture(t);
    const dependencyRoot = path.join(fixture.root, 'selected-dependency');
    const dependencyContents = new Map([
        ['index.html', Buffer.from('<p>  Dependency café 🦑\r\nComplete final line.  </p>')],
        ['data/catalog.bin', Buffer.from([255, 0, 1, 13, 10, 200])]
    ]);
    for (const [relative, content] of dependencyContents) {
        const destination = path.join(dependencyRoot, relative);
        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, content);
    }
    const dependencyRelease = {appId: 'lunar-depot', files: [...dependencyContents.keys()], manifest: {app: {start: './index.html'}}};
    const dependency = {appId: 'lunar-depot', releaseRoot: dependencyRoot, release: dependencyRelease};
    const options = {destination: '月 🧀', instructions: '  Leave every line.\r\nFinal instruction.  ', flags: {quiet: false}};
    const provider = createPortableNativeProvider({services: [{module: 'services/dispatch.mjs', options}]});
    const reads = [];
    const events = [];
    const artifact = await provider.build({
        ...fixture.request,
        toolchainRoot: path.join(fixture.root, 'unavailable-foreign-toolchain'),
        dependencies: [dependency],
        async readReleaseFile(relative, {signal}) {
            assert.equal(signal, undefined);
            reads.push(relative);
            return fixture.contents.get(relative);
        },
        onEvent: function observe(event) { events.push(event); }
    });
    const output = artifact.target.rootDir;
    assert.deepEqual(reads, fixture.release.files);
    await assertReleasePreserved(path.join(output, 'app'), fixture.contents);
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
    await assertReleasePreserved(path.join(output, 'dependencies', '0'), dependencyContents);
    assert.deepEqual(artifact.app, application);
    assert.deepEqual(artifact.target, {...target, rootDir: output});
    const manifest = JSON.parse(await readFile(path.join(output, 'arcane-native.json'), 'utf8'));
    assert.deepEqual(manifest, artifact.manifest);
    assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'kind', 'sdk', 'app', 'target', 'webRoot', 'start', 'core', 'client', 'dependencies', 'minimumCoreVersion', 'files']);
    assert.equal(manifest.kind, 'arcane-portable-native');
    assert.equal(manifest.webRoot, 'app');
    assert.equal(manifest.start, './pages/arrival.html');
    assert.deepEqual(manifest.core, {
        entry: 'runtime/arcane-core.mjs', transport: 'stdio', protocol: 'arcane/1',
        services: [{module: 'services/dispatch.mjs', options}]
    });
    assert.deepEqual(manifest.client, {
        source: 'runtime/arcane-api.js', injection: 'document-created',
        eventOwnerModuleURL: '/arcane%20runtime/sdk/event-manager.mjs'
    });
    assert.deepEqual(manifest.dependencies, [{appId: 'lunar-depot', root: 'dependencies/0', release: dependencyRelease}]);
    assert.equal(manifest.minimumCoreVersion, '0.1.0');
    assert.equal(manifest.files.includes('arcane-native.json'), true);
    const metadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.sdk, {name: metadata.name, version: metadata.version});
    const packagedSdk = path.join(output, 'node_modules/arcane-os');
    for (const relative of [
        'package.json', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE',
        'README.md', 'CHANGELOG.md', 'bin/arcane.mjs', 'src/core/runtime.mjs',
        'src/core/host.mjs', 'browser-runtime/core/client.mjs',
        'runtime/arcane/modules/DBOPFS.js', 'schemas/arcane-app.schema.json'
    ]) {
        assert.deepEqual(await readFile(path.join(packagedSdk, relative)), await readFile(path.join(sdkRoot, relative)), relative);
    }
    for (const name of Object.keys(metadata.dependencies)) {
        const installed = JSON.parse(await readFile(path.join(sdkRoot, 'node_modules', name, 'package.json'), 'utf8'));
        const included = JSON.parse(await readFile(path.join(packagedSdk, 'node_modules', name, 'package.json'), 'utf8'));
        assert.deepEqual(included, installed);
    }
    const entry = await readFile(path.join(output, 'runtime/arcane-core.mjs'), 'utf8');
    assert.ok(entry.includes("import {startCoreHost} from 'arcane-os/core/host';"));
    assert.ok(entry.includes('import createService0 from "../app/services/dispatch.mjs";'));
    assert.ok(entry.includes(`createService0(${JSON.stringify(options)})`));
    assert.ok(entry.includes('await host.closed'));
    const client = await readFile(path.join(output, 'runtime/arcane-api.js'), 'utf8');
    assert.ok(client.includes('/arcane%20runtime/sdk/event-manager.mjs'));
    assert.deepEqual(events.map(function eventType(event) { return event.type; }), ['native.payload.started', 'native.payload.completed']);
});

test('portable assembly resolves the shared browser event module from a selected installed SDK alias', async function installedSdkAlias(t) {
    const fixture = await createFixture(t);
    const aliasModule = 'node_modules/@moon/arcane/browser-runtime/event-manager.mjs';
    const selected = new Map(fixture.contents);
    selected.delete(eventModule);
    selected.set(aliasModule, fixture.contents.get(eventModule));
    const release = {...fixture.release, files: [...selected.keys()]};
    const provider = createPortableNativeProvider();
    const artifact = await provider.build({
        ...fixture.request,
        release,
        async readReleaseFile(relative) { return selected.get(relative); }
    });
    assert.equal(artifact.manifest.client.eventOwnerModuleURL, '/node_modules/%40moon/arcane/browser-runtime/event-manager.mjs');
    await assertReleasePreserved(path.join(artifact.target.rootDir, 'app'), selected);
    const classic = await readFile(path.join(artifact.target.rootDir, artifact.manifest.client.source), 'utf8');
    assert.ok(classic.includes('/node_modules/%40moon/arcane/browser-runtime/event-manager.mjs'));
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('portable assembly completes the selected app SDK from its own source and preserves an already selected package', async function selectedAppSdk(t) {
    const fixture = await createFixture(t);
    const packageSource = 'node_modules/arcane-os';
    const packageRoot = path.join(fixture.root, 'selected-installed-sdk');
    const sourceMetadata = {
        name: 'arcane-os', version: '97.1.0', type: 'module', dependencies: {},
        exports: {'./core/host': './src/core/host.mjs', './event-manager': './browser-runtime/event-manager.mjs'}
    };
    const sourceFiles = new Map([
        ['package.json', Buffer.from(JSON.stringify(sourceMetadata, null, 2) + '\n')],
        ['bin/arcane.mjs', Buffer.from('export const command = "synthetic installed SDK";\n')],
        ['src/core/host.mjs', Buffer.from('export function startCoreHost() { return "selected SDK host"; }\n')],
        ['src/only-installed-source.mjs', Buffer.from('export const source = "Only the installed package supplies this file.";\n')],
        ['browser-runtime/event-manager.mjs', Buffer.from('export const source = "installed SDK browser owner";\n')],
        ['runtime/arcane/modules/Example.js', Buffer.from('export const message = "Complete runtime content. 🦑";\n')],
        ['schemas/example.json', Buffer.from('{"title":"Synthetic installed SDK contract"}\n')],
        ['LICENSE', Buffer.from('Synthetic fixture license.\n')],
        ['COMMERCIAL-LICENSE.md', Buffer.from('Synthetic fixture commercial terms.\n')],
        ['NOTICE', Buffer.from('Synthetic fixture notice.\n')],
        ['README.md', Buffer.from('Synthetic selected SDK instructions.\n')],
        ['CHANGELOG.md', Buffer.from('Synthetic selected SDK changes.\n')]
    ]);
    for (const [relative, content] of sourceFiles) {
        const destination = path.join(packageRoot, relative);
        await mkdir(path.dirname(destination), {recursive: true});
        await writeFile(destination, content);
    }
    const browserModule = `${packageSource}/browser-runtime/event-manager.mjs`;
    const browserContent = Buffer.from('export const message = "  Selected browser café e\u0301 🦑  ";\r\n// Preserve this complete final line.\r\n');
    const selected = new Map(fixture.contents);
    selected.delete(eventModule);
    selected.set(browserModule, browserContent);
    const provider = createPortableNativeProvider();
    const partial = await provider.build({
        ...fixture.request,
        release: {...fixture.release, files: [...selected.keys()]},
        selectedSdk: {packageRoot, packageSource},
        async readReleaseFile(relative) { return selected.get(relative); }
    });
    const completedPackage = path.join(partial.target.rootDir, 'app', packageSource);
    const builderMetadata = JSON.parse(await readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
    assert.notEqual(sourceMetadata.version, builderMetadata.version);
    assert.deepEqual(partial.manifest.sdk, {name: builderMetadata.name, version: builderMetadata.version});
    assert.deepEqual(partial.manifest.appSdk, {name: sourceMetadata.name, version: sourceMetadata.version, root: `app/${packageSource}`});
    await assertReleasePreserved(path.join(partial.target.rootDir, 'app'), selected);
    for (const [relative, content] of sourceFiles) {
        const expected = relative === 'browser-runtime/event-manager.mjs' ? browserContent : content;
        assert.deepEqual(await readFile(path.join(completedPackage, relative)), expected, relative);
    }
    const completedMetadata = JSON.parse(await readFile(path.join(completedPackage, 'package.json'), 'utf8'));
    assert.deepEqual(completedMetadata.exports, sourceMetadata.exports);
    assert.equal(partial.manifest.client.eventOwnerModuleURL, '/node_modules/arcane-os/browser-runtime/event-manager.mjs');

    const selectedMetadata = {...sourceMetadata, version: '96.2.0', releaseNote: '  This package was already selected.\nPreserve it. 🧀  '};
    const selectedMetadataContent = Buffer.from(JSON.stringify(selectedMetadata, null, '\t') + '\r\n');
    const selectedHost = Buffer.from('export function startCoreHost() { return "the already selected host"; }\r\n');
    selected.set(`${packageSource}/package.json`, selectedMetadataContent);
    selected.set(`${packageSource}/src/core/host.mjs`, selectedHost);
    const authoritative = await provider.build({
        ...fixture.request,
        release: {...fixture.release, files: [...selected.keys()]},
        selectedSdk: {packageRoot, packageSource},
        async readReleaseFile(relative) { return selected.get(relative); }
    });
    const authoritativePackage = path.join(authoritative.target.rootDir, 'app', packageSource);
    assert.deepEqual(authoritative.manifest.sdk, partial.manifest.sdk);
    assert.deepEqual(authoritative.manifest.appSdk, {name: selectedMetadata.name, version: selectedMetadata.version, root: `app/${packageSource}`});
    await assertReleasePreserved(path.join(authoritative.target.rootDir, 'app'), selected);
    assert.deepEqual(await readFile(path.join(authoritativePackage, 'package.json')), selectedMetadataContent);
    assert.deepEqual(await readFile(path.join(authoritativePackage, 'src/core/host.mjs')), selectedHost);
    await assert.rejects(readFile(path.join(authoritativePackage, 'src/only-installed-source.mjs')), {code: 'ENOENT'});
    await assertReleasePreserved(packageRoot, sourceFiles);
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('flat and nested signing inputs both assemble without replacing previous artifacts', async function signingCompatibility(t) {
    const fixture = await createFixture(t);
    const provider = createPortableNativeProvider();
    const first = await provider.build(fixture.request);
    const nested = {...target, signing: {mode: 'unsigned-local-test', profileId: null}};
    const second = await provider.build({...fixture.request, targetRequest: nested});
    assert.notEqual(first.target.rootDir, second.target.rootDir);
    assert.deepEqual(first.manifest.target, target);
    assert.deepEqual(second.manifest.target, nested);
    await assertReleasePreserved(path.join(first.target.rootDir, 'app'), fixture.contents);
    await assertReleasePreserved(path.join(second.target.rootDir, 'app'), fixture.contents);
    assert.deepEqual((await readdir(fixture.outputRoot)).sort(), [path.basename(first.target.rootDir), path.basename(second.target.rootDir)].sort());
});

test('explicit portable verification inspects the selected artifact files and reports a missing file', async function selectedVerification(t) {
    const fixture = await createFixture(t);
    const provider = createPortableNativeProvider();
    const artifact = await provider.build(fixture.request);
    const events = [];
    const result = await provider.verify({artifact, targetRequest: {...target}, onEvent: function observe(event) { events.push(event); }});
    assert.deepEqual(result, {target: 'portable', outputRoot: artifact.target.rootDir, manifest: artifact.manifest, executable: false});
    assert.deepEqual(events.map(function eventType(event) { return event.type; }), ['native.verified']);
    await rm(path.join(artifact.target.rootDir, 'app/assets/dispatch.bin'));
    await assert.rejects(provider.verify({artifact, targetRequest: {...target}}), {code: 'ENOENT'});
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('portable assembly requires selected app services and one shared event module without creating partial output', async function selectedInputs(t) {
    const fixture = await createFixture(t);
    const missingService = createPortableNativeProvider({services: [{module: 'services/not-selected.mjs'}]});
    await assert.rejects(missingService.build(fixture.request), {code: ERROR_CODES.prerequisiteMissing});
    const provider = createPortableNativeProvider();
    const noEvent = {...fixture.release, files: fixture.release.files.filter(function omitEvent(relative) { return relative !== eventModule; })};
    await assert.rejects(provider.build({...fixture.request, release: noEvent}), {code: ERROR_CODES.prerequisiteMissing});
    const twoEvents = {...fixture.release, files: [...fixture.release.files, 'another/sdk/event-manager.mjs']};
    await assert.rejects(provider.build({...fixture.request, release: twoEvents}), {code: ERROR_CODES.prerequisiteMissing});
    await assert.rejects(readdir(fixture.outputRoot), {code: 'ENOENT'});
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('aborted portable assembly removes only its partial output and preserves prior completed artifacts', async function abortCleanup(t) {
    const fixture = await createFixture(t);
    const provider = createPortableNativeProvider();
    const completed = await provider.build(fixture.request);
    const existingDirectories = await readdir(fixture.outputRoot);
    const controller = new AbortController();
    const reason = new Error('The courier cancelled this assembly.');
    const read = [];
    const events = [];
    await assert.rejects(provider.build({
        ...fixture.request,
        signal: controller.signal,
        async readReleaseFile(relative, {signal}) {
            assert.equal(signal, controller.signal);
            read.push(relative);
            if (relative === 'pages/arrival.html') controller.abort(reason);
            return fixture.contents.get(relative);
        },
        onEvent: function observe(event) { events.push(event); }
    }), function cancelled(error) {
        assert.equal(error.code, ERROR_CODES.cancelled);
        assert.equal(error.cause, reason);
        return true;
    });
    assert.deepEqual(read, ['index.html', 'pages/arrival.html']);
    assert.deepEqual(events.map(function eventType(event) { return event.type; }), ['native.payload.started']);
    assert.deepEqual(await readdir(fixture.outputRoot), existingDirectories);
    await assertReleasePreserved(path.join(completed.target.rootDir, 'app'), fixture.contents);
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('release read failures remain observable and clean only the current assembly', async function failedReaderCleanup(t) {
    const fixture = await createFixture(t);
    const provider = createPortableNativeProvider();
    const completed = await provider.build(fixture.request);
    const existingDirectories = await readdir(fixture.outputRoot);
    const failure = new Error('The complete release read failure.\nFinal diagnostic: 🦑');
    await assert.rejects(provider.build({
        ...fixture.request,
        async readReleaseFile(relative) {
            if (relative === 'pages/arrival.html') throw failure;
            return fixture.contents.get(relative);
        }
    }), function originalFailure(error) {
        assert.equal(error, failure);
        return true;
    });
    assert.deepEqual(await readdir(fixture.outputRoot), existingDirectories);
    await assertReleasePreserved(path.join(completed.target.rootDir, 'app'), fixture.contents);
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('completion callback cancellation or rejection cleans only the unaccepted assembly', async function completionCallbackCleanup(t) {
    const fixture = await createFixture(t);
    const provider = createPortableNativeProvider();
    const completed = await provider.build(fixture.request);
    const existingDirectories = await readdir(fixture.outputRoot);
    for (const disposition of ['abort', 'reject']) {
        const controller = new AbortController();
        const failure = new Error(`The complete ${disposition} callback explanation.\nFinal detail: 🦑`);
        const events = [];
        await assert.rejects(provider.build({
            ...fixture.request,
            signal: controller.signal,
            onEvent: function completionDecision(event) {
                events.push(event);
                if (event.type !== 'native.payload.completed') return;
                if (disposition === 'reject') throw failure;
                controller.abort(failure);
            }
        }), function exactFailure(error) {
            if (disposition === 'reject') assert.equal(error, failure);
            else {
                assert.equal(error.code, ERROR_CODES.cancelled);
                assert.equal(error.cause, failure);
            }
            return true;
        });
        assert.deepEqual(events.map(function eventType(event) { return event.type; }), ['native.payload.started', 'native.payload.completed']);
        await assert.rejects(readdir(events[0].outputRoot), {code: 'ENOENT'});
        assert.deepEqual(await readdir(fixture.outputRoot), existingDirectories);
    }
    await assertReleasePreserved(path.join(completed.target.rootDir, 'app'), fixture.contents);
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});

test('portable output cannot recursively enter a selected dependency release', async function dependencyOutputRecursion(t) {
    const fixture = await createFixture(t);
    const dependencyRoot = path.join(fixture.root, 'selected-dependency');
    await mkdir(dependencyRoot);
    const original = Buffer.from('  The original dependency remains complete.\r\n最後の行 🦑  ');
    await writeFile(path.join(dependencyRoot, 'index.html'), original);
    const outputRoot = path.join(dependencyRoot, 'generated-native');
    const provider = createPortableNativeProvider();
    await assert.rejects(provider.build({
        ...fixture.request,
        outputRoot,
        dependencies: [{
            appId: 'lunar-depot', releaseRoot: dependencyRoot,
            release: {files: ['index.html'], manifest: {app: {start: './index.html'}}}
        }]
    }), {code: ERROR_CODES.usage});
    assert.deepEqual(await readFile(path.join(dependencyRoot, 'index.html')), original);
    assert.deepEqual(await readdir(dependencyRoot), ['index.html']);
    await assert.rejects(readdir(outputRoot), {code: 'ENOENT'});
    await assertReleasePreserved(fixture.releaseRoot, fixture.contents);
});
