import {createWriteStream} from 'node:fs';
import {chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {runProcess} from '../process.mjs';
import {createPortableNativeProvider} from './portable-provider.mjs';
import {outputFile, writeOutput} from './portable-layout.mjs';

const is = new Is(false);
const PROTOCOL = 'arcane-native-builder/1';
const MANIFEST = 'arcane-native.json';
const HOST_FILES = ['Arcane', 'runtime/node', 'runtime/NODE-LICENSE', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE'];
const EXECUTABLE = '../MacOS/Arcane';

function macosTarget(value) {
    if (!['arm64', 'x64'].includes(value?.architecture)
        || value.target !== `macos-${value.architecture}` || value.platform !== 'macos' || value.format !== 'app') {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, 'The macOS provider assembles macos-arm64 and macos-x64 application bundles.');
    }
    return {...value};
}

function portableRequest(target) {
    return {...target, target: 'portable', format: 'portable'};
}

async function emit(onEvent, event) {
    if (is.function(onEvent)) await onEvent(event);
}

async function hostFilesMissing(directory) {
    const missing = [];
    for (const relative of HOST_FILES) {
        try {
            if (!(await stat(path.join(directory, relative))).isFile()) missing.push(relative);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            missing.push(relative);
        }
    }
    return missing;
}

async function requireHostDirectory(directory) {
    const resolved = await realpath(directory);
    const missing = await hostFilesMissing(resolved);
    if (missing.length) {
        throw new ArcaneError(ERROR_CODES.prerequisiteMissing, 'The selected macOS host assets are incomplete.', {
            details: {hostDirectory: resolved, missing}
        });
    }
    return resolved;
}

async function removeOwnedDirectories(directories, error) {
    const failures = [error];
    for (const directory of directories) {
        try { await rm(directory, {recursive: true, force: true}); }
        catch (cleanupError) { failures.push(cleanupError); }
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, `macOS preparation failed; inspect the owned outputs at ${directories.join(', ')}.`);
    }
    throw error;
}

async function releasedHostDirectory(outputRoot, version, target, {signal, onEvent}) {
    const cache = path.join(outputRoot, '.arcane-native-hosts', version);
    const destination = path.join(cache, target.target);
    try { return await requireHostDirectory(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    throwIfAborted(signal);
    await mkdir(cache, {recursive: true});
    const temporary = await mkdtemp(path.join(cache, `preparing-${target.target}-`));
    const archiveName = `arcane-native-macos-${target.architecture}.tar.gz`;
    const archive = path.join(temporary, archiveName);
    const extracted = path.join(temporary, 'host');
    const url = `https://github.com/TheWizardNexus/arcane-os-sdk/releases/download/${version}/${archiveName}`;
    try {
        await emit(onEvent, {type: 'native.host.download.started', target: target.target, version, url});
        throwIfAborted(signal);
        const response = await fetch(url, {signal});
        if (!response.ok) {
            throw new ArcaneError(ERROR_CODES.prerequisiteMissing, `The SDK macOS host download returned HTTP ${response.status}.`, {
                details: {url, status: response.status, response: await response.text()}
            });
        }
        if (!response.body) throw new ArcaneError(ERROR_CODES.operationFailed, 'The SDK macOS host download returned no content.', {details: {url}});
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, {flags: 'wx'}), {signal});
        throwIfAborted(signal);
        await mkdir(extracted);
        await runProcess('tar', ['-xzf', archive, '-C', extracted], {cwd: temporary, signal, onEvent});
        await requireHostDirectory(extracted);
        throwIfAborted(signal);
        try { await rename(extracted, destination); }
        catch (error) {
            // A concurrent build may have completed this exact SDK/architecture.
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
            try { await requireHostDirectory(destination); }
            catch { throw error; }
        }
        await rm(temporary, {recursive: true, force: true});
        await emit(onEvent, {type: 'native.host.download.completed', target: target.target, version, hostDirectory: destination});
        throwIfAborted(signal);
        return destination;
    } catch (error) {
        return removeOwnedDirectories([temporary], error);
    }
}

function contains(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function copyHostAssets(source, resources, files, signal, relative = '', ancestors = new Set()) {
    throwIfAborted(signal);
    const canonical = await realpath(source);
    const output = await realpath(path.dirname(resources));
    if (contains(canonical, output) || contains(output, canonical) || ancestors.has(canonical)) {
        throw new ArcaneError(ERROR_CODES.usage, 'macOS host assets overlap their output or contain a directory cycle.', {
            details: {source, outputRoot: resources}
        });
    }
    const parents = new Set([...ancestors, canonical]);
    for (const entry of await readdir(source, {withFileTypes: true})) {
        throwIfAborted(signal);
        const selected = path.join(source, entry.name);
        const destination = relative ? `${relative}/${entry.name}` : entry.name;
        const information = await stat(selected);
        if (information.isDirectory()) {
            await mkdir(outputFile(resources, destination), {recursive: true});
            await copyHostAssets(selected, resources, files, signal, destination, parents);
        } else if (information.isFile()) {
            const content = await readFile(selected, {signal});
            const launcher = destination === 'Arcane';
            const actual = launcher ? path.resolve(resources, EXECUTABLE) : outputFile(resources, destination);
            if (launcher) await writeFile(actual, content, {flag: 'wx', signal});
            else await writeOutput(resources, destination, content, files, signal);
            // These two selected assets are executables even when assembly is
            // performed on a filesystem that cannot represent Unix mode bits.
            const mode = launcher || destination === 'runtime/node' ? (information.mode & 0o777) | 0o111 : information.mode & 0o777;
            await chmod(actual, mode);
        } else {
            throw new ArcaneError(ERROR_CODES.operationFailed, `Cannot copy macOS host asset ${selected}.`);
        }
    }
}

function plistText(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function infoPlist(application) {
    const values = {
        CFBundleExecutable: 'Arcane', CFBundleIdentifier: `org.arcane.${application.id}`,
        CFBundleName: application.displayName ?? application.id, CFBundleDisplayName: application.displayName ?? application.id,
        CFBundlePackageType: 'APPL', CFBundleVersion: application.version ?? '1.0.0',
        CFBundleShortVersionString: application.version ?? '1.0.0', LSMinimumSystemVersion: '11.0', NSPrincipalClass: 'NSApplication'
    };
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        ...Object.entries(values).map(function property([key, value]) { return `  <key>${key}</key><string>${plistText(value)}</string>`; }),
        '</dict></plist>', ''
    ].join('\n');
}

async function requireBundle(resources) {
    const root = await realpath(resources);
    for (const relative of [...HOST_FILES.filter(function resource(name) { return name !== 'Arcane'; }), EXECUTABLE, '../Info.plist']) {
        if (!(await stat(path.resolve(root, relative))).isFile()) {
            throw new ArcaneError(ERROR_CODES.prerequisiteMissing, `The macOS application file is unavailable: ${relative}.`);
        }
    }
    return root;
}

/** Compose complete portable app content with the selected SDK macOS host. */
export function createMacOSNativeProvider({services, hostDirectory} = {}) {
    const portable = createPortableNativeProvider({services, packagedWeb: true, webKitDocumentLifecycle: true});
    return {
        protocol: PROTOCOL,
        async describe() {
            return {protocol: PROTOCOL, id: 'arcane-sdk-macos', targets: ['macos-arm64', 'macos-x64'], executable: true,
                serviceConfiguration: 'explicit release module factories'};
        },
        async doctor({targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = macosTarget(targetRequest);
            const core = await portable.doctor({targetRequest: portableRequest(target), signal});
            const missing = hostDirectory === undefined ? [] : await hostFilesMissing(path.resolve(hostDirectory));
            const result = {
                target: target.target, executable: true, ready: core.ready && missing.length === 0,
                sdkRoot: core.sdkRoot, missing: [...core.missing, ...missing],
                hostDirectory: hostDirectory === undefined ? null : path.resolve(hostDirectory),
                hostSource: hostDirectory === undefined ? 'sdk-release' : 'selected-directory',
                downloadRequired: hostDirectory === undefined,
                runtimePrerequisite: 'macOS 11 or newer with AppKit and WebKit, also satisfying the selected Node runtime requirements',
                buildPrerequisite: hostDirectory === undefined ? 'tar' : null
            };
            await emit(onEvent, {type: 'native.doctor.completed', ...result});
            throwIfAborted(signal);
            return result;
        },
        async prepare({targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = macosTarget(targetRequest);
            const selection = await portable.prepare({targetRequest: portableRequest(target), signal});
            const selected = hostDirectory === undefined ? undefined : await requireHostDirectory(hostDirectory);
            const result = {...selection, target, executable: true, ...(selected ? {hostDirectory: selected} : {})};
            await emit(onEvent, {type: 'native.prepared', target: target.target, sdkVersion: selection.sdkVersion});
            throwIfAborted(signal);
            return result;
        },
        async build(request = {}) {
            const {signal, onEvent} = request;
            throwIfAborted(signal);
            const target = macosTarget(request.targetRequest);
            const selected = hostDirectory ?? request.toolchain?.hostDirectory;
            const selectedHost = selected === undefined ? null : await requireHostDirectory(selected);
            const artifact = await portable.build({
                ...request, targetRequest: portableRequest(target),
                async onEvent(event) {
                    if (event.type !== 'native.payload.completed') await emit(onEvent, {...event, target: target.target});
                }
            });
            const portableRoot = artifact.target.rootDir;
            let assembly;
            try {
                const host = selectedHost ?? await releasedHostDirectory(path.resolve(request.outputRoot), artifact.manifest.sdk.version, target, {signal, onEvent});
                throwIfAborted(signal);
                assembly = await mkdtemp(path.join(path.resolve(request.outputRoot), 'arcane-macos-'));
                const plist = outputFile(assembly, `${request.appDescriptor.id}.app/Contents/Info.plist`);
                const contents = path.dirname(plist);
                const root = path.join(contents, 'Resources');
                const bundleRoot = path.dirname(contents);
                await mkdir(path.join(contents, 'MacOS'), {recursive: true});
                await rename(portableRoot, root);
                const files = [...artifact.manifest.files];
                await copyHostAssets(host, root, files, signal);
                await writeFile(plist, infoPlist(request.appDescriptor), {flag: 'wx', signal});
                const manifest = {
                    ...artifact.manifest, kind: 'arcane-macos-native', target,
                    host: {
                        executable: EXECUTABLE, platform: 'macos', architecture: target.architecture, runtime: 'webkit',
                        coreExecutable: 'runtime/node', coreEntry: 'runtime/arcane-core.mjs',
                        bundleIdentifier: `org.arcane.${request.appDescriptor.id}`, infoPlist: '../Info.plist'
                    },
                    files
                };
                await writeFile(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {signal});
                throwIfAborted(signal);
                await emit(onEvent, {type: 'native.payload.completed', target: target.target, appId: request.appDescriptor.id, outputRoot: root, bundleRoot});
                throwIfAborted(signal);
                return {...artifact, target: {...target, rootDir: root}, bundleRoot, manifest};
            } catch (error) {
                return removeOwnedDirectories(assembly ? [portableRoot, assembly] : [portableRoot], error);
            }
        },
        async verify({artifact, targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = macosTarget(targetRequest);
            const result = await portable.verify({artifact, targetRequest: portableRequest(target), signal});
            const root = await requireBundle(result.outputRoot);
            const verified = {...result, target: target.target, executable: true, bundleRoot: path.dirname(path.dirname(root))};
            await emit(onEvent, {type: 'native.verified', target: target.target, outputRoot: root});
            throwIfAborted(signal);
            return verified;
        },
        async run({artifact, targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = macosTarget(targetRequest);
            if (process.platform !== 'darwin' || process.arch !== target.architecture) {
                throw new ArcaneError(ERROR_CODES.nativeRunUnsupported, `Running this macOS ${target.architecture} artifact requires a matching macOS host.`);
            }
            const root = await requireBundle(artifact?.target?.rootDir);
            return runProcess(path.resolve(root, EXECUTABLE), ['--close-on-stdin-eof'], {
                cwd: root, signal, onEvent, cancellationMode: 'close-input'
            });
        }
    };
}

export const arcaneNativeBuilderProvider = createMacOSNativeProvider();
export default arcaneNativeBuilderProvider;
