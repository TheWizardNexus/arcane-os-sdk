import {mkdir, mkdtemp, readFile, realpath, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';
import {createCoreClassicSource} from '../core-classic-source.mjs';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {SDK_ROOT, CORE_FILES, outputFile, writeOutput, copyRelease, copyCoreRuntime, coreEntrySource} from './portable-layout.mjs';

const is = new Is(false);
const PROTOCOL = 'arcane-native-builder/1';
const MANIFEST = 'arcane-native.json';

function portableTarget(value) {
    if (value?.target !== 'portable') {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, 'This provider assembles portable Core payloads only.');
    }
    return {...value};
}

async function emit(onEvent, event) {
    if (is.function(onEvent)) await onEvent(event);
}

function contains(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function futureRealPath(location) {
    try { return await realpath(location); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = path.dirname(location);
        if (parent === location) throw error;
        return path.join(await futureRealPath(parent), path.basename(location));
    }
}

async function outputDirectory(request) {
    if (!is.string(request.outputRoot) || !request.outputRoot) {
        throw new ArcaneError(ERROR_CODES.usage, 'Portable assembly requires an outputRoot.');
    }
    const output = await futureRealPath(path.resolve(request.outputRoot));
    const protectedRoots = [SDK_ROOT, request.appReleaseRoot,
        ...(request.dependencies?.map(function dependencyRoot(item) { return item.releaseRoot; }) ?? []),
        ...(request.protectedRoots ?? [])];
    for (const location of protectedRoots) {
        if (!location) continue;
        const root = await futureRealPath(path.resolve(location));
        // SDK/release roots must never be replaced by generated output. A
        // caller may select its ordinary project-local dist descendant.
        if (contains(output, root) || (location !== SDK_ROOT && contains(root, output))) {
            throw new ArcaneError(ERROR_CODES.usage, `Portable output overlaps selected source: ${location}.`);
        }
    }
    await mkdir(output, {recursive: true});
    return output;
}

function serviceSelection(services, release) {
    return services.map(function selectService(service) {
        if (!is.string(service?.module) || !release.files.includes(service.module)) {
            throw new ArcaneError(ERROR_CODES.prerequisiteMissing, `The selected release does not contain service module ${String(service?.module)}.`);
        }
        return {module: service.module, options: service.options === undefined ? {} : service.options};
    });
}

function eventOwnerPath(release) {
    const paths = release.files.filter(function sdkEventModule(relative) {
        return relative === 'sdk/event-manager.mjs' || relative.endsWith('/sdk/event-manager.mjs')
            || /^node_modules\/(?:@[^/]+\/)?[^/]+\/browser-runtime\/event-manager\.mjs$/u.test(relative);
    });
    if (paths.length !== 1) {
        throw new ArcaneError(ERROR_CODES.prerequisiteMissing,
            'The portable app release must select one shared SDK event-manager module.',
            {details: {paths}});
    }
    // Native hosts mount the complete app directory at one local URL origin.
    // An origin-root URL keeps nested navigable documents on the same owner.
    return '/' + paths[0].split('/').map(encodeURIComponent).join('/');
}

/** Package-owned assembly; never imports an OS checkout or application service. */
export function createPortableNativeProvider({services = []} = {}) {
    return {
        protocol: PROTOCOL,
        async describe() {
            return {
                protocol: PROTOCOL,
                id: 'arcane-sdk-portable',
                targets: ['portable'],
                executable: false,
                serviceConfiguration: 'explicit release module factories'
            };
        },
        async doctor({targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            portableTarget(targetRequest);
            const missing = [];
            for (const relative of CORE_FILES) {
                try { await stat(path.join(SDK_ROOT, relative)); }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    missing.push(relative);
                }
            }
            const result = {ready: missing.length === 0, target: 'portable', sdkRoot: SDK_ROOT, missing, executable: false};
            await emit(onEvent, {type: 'native.doctor.completed', ...result});
            return result;
        },
        async prepare({targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            const target = portableTarget(targetRequest);
            const metadata = JSON.parse(await readFile(path.join(SDK_ROOT, 'package.json'), 'utf8'));
            const result = {sdkRoot: SDK_ROOT, sdkVersion: metadata.version, target, executable: false};
            await emit(onEvent, {type: 'native.prepared', target: 'portable', sdkVersion: metadata.version});
            return result;
        },
        async build(request = {}) {
            const {appDescriptor, release, signal, onEvent} = request;
            throwIfAborted(signal);
            const target = portableTarget(request.targetRequest);
            const selectedServices = serviceSelection(services, release);
            const eventOwnerModuleURL = eventOwnerPath(release);
            const output = await outputDirectory(request);
            throwIfAborted(signal);
            // Unique assembly directories preserve earlier outputs and avoid
            // overwriting an app's files or a concurrent packaging operation.
            const root = await mkdtemp(path.join(output, 'arcane-portable-'));
            const files = [];
            try {
                await emit(onEvent, {type: 'native.payload.started', appId: appDescriptor.id, outputRoot: root});
                await copyRelease({...request, releaseRoot: request.appReleaseRoot}, 'app', root, files, signal);
                const dependencies = [];
                for (const [index, dependency] of (request.dependencies ?? []).entries()) {
                    const directory = `dependencies/${index}`;
                    await copyRelease(dependency, directory, root, files, signal);
                    dependencies.push({appId: dependency.appId, root: directory, release: dependency.release});
                }
                const sdk = await copyCoreRuntime(root, files, signal);
                const selectedSdk = request.selectedSdk;
                let appSdk;
                if (selectedSdk && release.files.some(function selectedPackageFile(relative) {
                    return relative.startsWith(`${selectedSdk.packageSource}/`);
                })) {
                    const destination = `app/${selectedSdk.packageSource}`;
                    let metadata;
                    if (release.files.includes(`${selectedSdk.packageSource}/package.json`)) {
                        metadata = JSON.parse(await readFile(outputFile(root, `${destination}/package.json`), 'utf8'));
                    } else {
                        metadata = await copyCoreRuntime(root, files, signal, {
                            sourceRoot: selectedSdk.packageRoot, sdkDestination: destination
                        });
                    }
                    appSdk = {name: metadata.name, version: metadata.version, root: destination};
                }
                await writeOutput(root, 'package.json', '{"type":"module"}\n', files, signal);
                await writeOutput(root, 'runtime/arcane-core.mjs', coreEntrySource(appDescriptor, sdk.version, selectedServices), files, signal);
                await writeOutput(root, 'runtime/arcane-api.js', await createCoreClassicSource({eventOwnerModuleURL}), files, signal);
                const manifest = {
                    schemaVersion: 1,
                    kind: 'arcane-portable-native',
                    sdk: {name: sdk.name, version: sdk.version},
                    ...(appSdk ? {appSdk} : {}),
                    app: appDescriptor,
                    target,
                    webRoot: 'app',
                    start: release.manifest?.app?.start ?? './index.html',
                    core: {entry: 'runtime/arcane-core.mjs', transport: 'stdio', protocol: 'arcane/1', services: selectedServices},
                    client: {source: 'runtime/arcane-api.js', injection: 'document-created', eventOwnerModuleURL},
                    dependencies,
                    minimumCoreVersion: request.minimumCoreVersion ?? null,
                    files: [...files, MANIFEST]
                };
                await writeOutput(root, MANIFEST, JSON.stringify(manifest, null, 2) + '\n', files, signal);
                throwIfAborted(signal);
                await emit(onEvent, {type: 'native.payload.completed', appId: appDescriptor.id, outputRoot: root});
                throwIfAborted(signal);
                return {app: appDescriptor, target: {...target, rootDir: root}, manifest};
            } catch (error) {
                try { await rm(root, {recursive: true, force: true}); }
                catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], `Portable assembly failed; its incomplete output remains at ${root}.`);
                }
                throw error;
            }
        },
        async verify({artifact, targetRequest, signal, onEvent} = {}) {
            throwIfAborted(signal);
            portableTarget(targetRequest);
            const root = artifact?.target?.rootDir;
            if (!is.string(root) || !root) throw new ArcaneError(ERROR_CODES.usage, 'Select a portable artifact root.');
            const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'));
            for (const relative of manifest.files) {
                throwIfAborted(signal);
                const info = await stat(outputFile(root, relative));
                if (!info.isFile()) throw new ArcaneError(ERROR_CODES.operationFailed, `Portable file is unavailable: ${relative}.`);
            }
            const result = {target: 'portable', outputRoot: root, manifest, executable: false};
            await emit(onEvent, {type: 'native.verified', target: 'portable', outputRoot: root});
            return result;
        },
        async run() {
            throw new ArcaneError(ERROR_CODES.nativeRunUnsupported,
                'Portable is a Core/app payload, not a native executable. Select an implemented platform host to launch it.');
        }
    };
}

export const arcaneNativeBuilderProvider = createPortableNativeProvider();
export default arcaneNativeBuilderProvider;
