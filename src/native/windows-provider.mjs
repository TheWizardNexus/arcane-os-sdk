import {createWriteStream} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {runProcess} from '../process.mjs';
import {createPortableNativeProvider} from './portable-provider.mjs';
import {writeOutput} from './portable-layout.mjs';

const is = new Is(false);
const PROTOCOL = 'arcane-native-builder/1';
const MANIFEST = 'arcane-native.json';
const HOST_ASSET = 'arcane-native-windows-x64.tar.gz';
const HOST_FILES = [
    'Arcane.exe',
    'Arcane.exe.config',
    'Microsoft.Web.WebView2.Core.dll',
    'Microsoft.Web.WebView2.WinForms.dll',
    'WebView2Loader.dll',
    'runtime/ArcaneCore.exe',
    'runtime/arcane-core-loader.cjs',
    'runtime/NODE-LICENSE',
    'WEBVIEW2-LICENSE',
    'LICENSE',
    'COMMERCIAL-LICENSE.md',
    'NOTICE'
];

function windowsTarget(value) {
    if (value?.target !== 'windows-x64' || value.platform !== 'windows'
        || value.architecture !== 'x64' || value.format !== 'exe') {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, 'The Windows provider assembles windows-x64 executables.');
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
        throw new ArcaneError(ERROR_CODES.prerequisiteMissing, 'The selected Windows host assets are incomplete.', {
            details: {hostDirectory: resolved, missing}
        });
    }
    return resolved;
}

async function removeOwnedDirectory(directory, error) {
    try { await rm(directory, {recursive: true, force: true}); }
    catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Windows preparation failed; incomplete output remains at ${directory}.`);
    }
    throw error;
}

async function releasedHostDirectory(outputRoot, version, {signal, onEvent}) {
    const cache = path.join(outputRoot, '.arcane-native-hosts', version);
    const destination = path.join(cache, 'windows-x64');
    try { return await requireHostDirectory(destination); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    throwIfAborted(signal);
    await mkdir(cache, {recursive: true});
    const temporary = await mkdtemp(path.join(cache, 'preparing-windows-x64-'));
    const archive = path.join(temporary, HOST_ASSET);
    const extracted = path.join(temporary, 'host');
    const url = `https://github.com/TheWizardNexus/arcane-os-sdk/releases/download/${version}/${HOST_ASSET}`;
    try {
        await emit(onEvent, {type: 'native.host.download.started', target: 'windows-x64', version, url});
        throwIfAborted(signal);
        const response = await fetch(url, {signal});
        if (!response.ok) {
            throw new ArcaneError(ERROR_CODES.prerequisiteMissing, `The SDK Windows host download returned HTTP ${response.status}.`, {
                details: {url, status: response.status, response: await response.text()}
            });
        }
        if (!response.body) throw new ArcaneError(ERROR_CODES.operationFailed, 'The SDK Windows host download returned no content.', {details: {url}});
        await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, {flags: 'wx'}), {signal});
        throwIfAborted(signal);
        await mkdir(extracted);
        await runProcess('tar', ['-xzf', archive, '-C', extracted], {cwd: temporary, signal, onEvent});
        await requireHostDirectory(extracted);
        throwIfAborted(signal);
        try { await rename(extracted, destination); }
        catch (error) {
            // Another preparation may have finished this exact version while
            // this download was in flight. Preserve its complete asset tree.
            if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
            try { await requireHostDirectory(destination); }
            catch { throw error; }
        }
        await rm(temporary, {recursive: true, force: true});
        await emit(onEvent, {type: 'native.host.download.completed', target: 'windows-x64', version, hostDirectory: destination});
        throwIfAborted(signal);
        return destination;
    } catch (error) {
        return removeOwnedDirectory(temporary, error);
    }
}

function contains(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function copyHostAssets(source, root, files, signal, relative = '', ancestors = new Set()) {
    throwIfAborted(signal);
    const canonical = await realpath(source);
    const output = await realpath(root);
    if (contains(canonical, output) || contains(output, canonical) || ancestors.has(canonical)) {
        throw new ArcaneError(ERROR_CODES.usage, 'Windows host assets overlap their output or contain a directory cycle.', {
            details: {source, outputRoot: root}
        });
    }
    const parents = new Set([...ancestors, canonical]);
    for (const entry of await readdir(source, {withFileTypes: true})) {
        throwIfAborted(signal);
        const selected = path.join(source, entry.name);
        const destination = relative ? `${relative}/${entry.name}` : entry.name;
        const information = await stat(selected);
        if (information.isDirectory()) {
            await mkdir(path.join(root, destination), {recursive: true});
            await copyHostAssets(selected, root, files, signal, destination, parents);
        } else if (information.isFile()) {
            await writeOutput(root, destination, await readFile(selected, {signal}), files, signal);
        } else {
            throw new ArcaneError(ERROR_CODES.operationFailed, `Cannot copy Windows host asset ${selected}.`);
        }
    }
}

/** Compose app-owned services with the SDK's precompiled Windows host. */
export function createWindowsNativeProvider({services, hostDirectory} = {}) {
    const portable = createPortableNativeProvider(services === undefined ? {} : {services});
    return {
        protocol: PROTOCOL,
        async describe() {
            return {
                protocol: PROTOCOL,
                id: 'arcane-sdk-windows-x64',
                targets: ['windows-x64'],
                executable: true,
                serviceConfiguration: 'explicit release module factories'
            };
        },
        async doctor({targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = windowsTarget(targetRequest);
            const core = await portable.doctor({targetRequest: portableRequest(target), signal});
            const missing = hostDirectory === undefined ? [] : await hostFilesMissing(path.resolve(hostDirectory));
            const result = {
                target: 'windows-x64', executable: true, ready: core.ready && missing.length === 0,
                sdkRoot: core.sdkRoot, missing: [...core.missing, ...missing],
                hostDirectory: hostDirectory === undefined ? null : path.resolve(hostDirectory),
                hostSource: hostDirectory === undefined ? 'sdk-release' : 'selected-directory',
                downloadRequired: hostDirectory === undefined,
                runtimePrerequisite: 'Microsoft Edge WebView2 Runtime',
                buildPrerequisite: hostDirectory === undefined ? 'tar' : null
            };
            await emit(onEvent, {type: 'native.doctor.completed', ...result});
            throwIfAborted(signal);
            return result;
        },
        async prepare({targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = windowsTarget(targetRequest);
            const selection = await portable.prepare({targetRequest: portableRequest(target), signal});
            const selected = hostDirectory === undefined ? undefined : await requireHostDirectory(hostDirectory);
            // Downloads belong to build(), which has the caller's selected
            // outputRoot. Preparation never invents a machine-wide cache.
            const result = {...selection, target, executable: true, ...(selected ? {hostDirectory: selected} : {})};
            await emit(onEvent, {type: 'native.prepared', target: 'windows-x64', sdkVersion: selection.sdkVersion});
            throwIfAborted(signal);
            return result;
        },
        async build(request = {}) {
            const {signal, onEvent} = request;
            throwIfAborted(signal);
            const target = windowsTarget(request.targetRequest);
            const selected = hostDirectory ?? request.toolchain?.hostDirectory;
            const selectedHost = selected === undefined ? null : await requireHostDirectory(selected);
            const artifact = await portable.build({
                ...request,
                targetRequest: portableRequest(target),
                async onEvent(event) {
                    if (event.type !== 'native.payload.completed') await emit(onEvent, {...event, target: 'windows-x64'});
                }
            });
            const root = artifact.target.rootDir;
            try {
                const host = selectedHost ?? await releasedHostDirectory(path.resolve(request.outputRoot), artifact.manifest.sdk.version, {signal, onEvent});
                const files = [...artifact.manifest.files];
                await copyHostAssets(host, root, files, signal);
                const manifest = {
                    ...artifact.manifest,
                    kind: 'arcane-windows-native',
                    target,
                    host: {
                        executable: 'Arcane.exe',
                        platform: 'windows', architecture: 'x64', runtime: 'webview2',
                        coreExecutable: 'runtime/ArcaneCore.exe',
                        coreLoader: 'runtime/arcane-core-loader.cjs'
                    },
                    files
                };
                await writeFile(path.join(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {signal});
                throwIfAborted(signal);
                await emit(onEvent, {type: 'native.payload.completed', target: 'windows-x64', appId: request.appDescriptor.id, outputRoot: root});
                throwIfAborted(signal);
                return {...artifact, target: {...target, rootDir: root}, manifest};
            } catch (error) {
                return removeOwnedDirectory(root, error);
            }
        },
        async verify({artifact, targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = windowsTarget(targetRequest);
            const result = await portable.verify({artifact, targetRequest: portableRequest(target), signal});
            await requireHostDirectory(result.outputRoot);
            const verified = {...result, target: 'windows-x64', executable: true};
            await emit(onEvent, {type: 'native.verified', target: 'windows-x64', outputRoot: result.outputRoot});
            throwIfAborted(signal);
            return verified;
        },
        async run({artifact, targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            windowsTarget(targetRequest);
            if (process.platform !== 'win32' || process.arch !== 'x64') {
                throw new ArcaneError(ERROR_CODES.nativeRunUnsupported, 'Running this Windows x64 artifact requires a Windows x64 host.');
            }
            const root = await requireHostDirectory(artifact?.target?.rootDir);
            return runProcess(path.join(root, 'Arcane.exe'), ['--close-on-stdin-eof'], {
                cwd: root, signal, onEvent, cancellationMode: 'close-input'
            });
        }
    };
}

export const arcaneNativeBuilderProvider = createWindowsNativeProvider();
export default arcaneNativeBuilderProvider;
