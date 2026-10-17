import {readFile, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';
import {SDK_ROOT, CORE_FILES, outputFile} from './portable-layout.mjs';
import {assemblePortable} from './portable-assembly.mjs';
import {publishNativeOutput} from './publish-output.mjs';

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

/** Package-owned assembly; never imports an OS checkout or application service. */
export function createPortableNativeProvider({services, packagedWeb = false, webKitDocumentLifecycle = false} = {}) {
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
            throwIfAborted(request.signal);
            portableTarget(request.targetRequest);
            const artifact = await assemblePortable(request, {services, packagedWeb, webKitDocumentLifecycle});
            const sourceRoot = artifact.target.rootDir;
            try {
                const root = await publishNativeOutput({
                    sourceRoot, outputRoot: path.dirname(sourceRoot), appId: artifact.app.id,
                    signal: request.signal,
                    async onPublished(outputRoot) {
                        await emit(request.onEvent, {type: 'native.payload.completed', appId: artifact.app.id, outputRoot});
                    }
                });
                return {...artifact, target: {...artifact.target, rootDir: root}};
            } catch (error) {
                try { await rm(sourceRoot, {recursive: true, force: true}); }
                catch (cleanupError) {
                    throw new AggregateError([error, cleanupError], `Portable publication failed; its assembly remains at ${sourceRoot}.`);
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
