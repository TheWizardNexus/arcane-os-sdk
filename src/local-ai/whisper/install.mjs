import {createWriteStream} from 'node:fs';
import {copyFile, cp, mkdir, readdir, stat, unlink} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import Is from 'strong-type';
import packageMetadata from '../../../package.json' with {type: 'json'};
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../../errors.mjs';
import {extractLocalAIArchive} from '../archive.mjs';

const is = new Is(false);

/** Functional selection keys share preparation, never identify model content. */
export function whisperRuntimeSelection(requirement, includeModels = true) {
    const {models, modelId, helperRoot, helperVersion, ...runtime} = requirement;
    return JSON.stringify({
        ...runtime,
        ...(includeModels ? {models, modelId} : {}),
        helperVersion: helperVersion ?? packageMetadata.version,
        helperRoot: helperRoot ?? (is.string(requirement.helperExecutable) ? path.dirname(requirement.helperExecutable) : undefined)
    });
}

export async function installedWhisperRuntime(record, signal, includeModels = true) {
    if (!is.array(record?.variants) || record.variants.length === 0 || !is.array(record.models)) return false;
    const files = [record.helperExecutable, record.decoderExecutable];
    const directories = [record.root, record.helperRoot ?? (is.string(record.helperExecutable) ? path.dirname(record.helperExecutable) : undefined), record.decoderRoot];
    for (const variant of record.variants) {
        files.push(variant.executable);
        directories.push(variant.root, variant.libraryDirectory);
    }
    if (includeModels) for (const model of record.models) {
        files.push(model.path);
        if (record.encoder === 'openvino-npu') files.push(model.encoderPath, model.encoderDataPath);
    }
    for (const location of directories) {
        throwIfAborted(signal);
        if (!is.string(location) || !(await stat(location)).isDirectory()) return false;
    }
    for (const location of files) {
        throwIfAborted(signal);
        if (!is.string(location) || !(await stat(location)).isFile()) return false;
    }
    return true;
}

async function findWhisperFile(root, filename, signal) {
    const directories = [root];
    for (const directory of directories) {
        throwIfAborted(signal);
        for (const entry of await readdir(directory, {withFileTypes: true})) {
            const location = path.join(directory, entry.name);
            if (entry.name === filename && (entry.isFile() || entry.isSymbolicLink())) return location;
            if (entry.isDirectory()) directories.push(location);
        }
    }
    throw new ArcaneError(ERROR_CODES.operationFailed, `The selected Whisper dependency tree does not contain ${filename}.`);
}

async function downloadWhisperResource(url, filename, {signal, onEvent, upstreamResponse}) {
    await onEvent({
        type: 'local-ai.install.downloading',
        message: `Downloading ${path.basename(filename)}.`,
        data: {id: 'whisper.cpp', asset: path.basename(filename)}
    });
    const response = await upstreamResponse(url, signal);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(filename, {flags: 'wx'}), {signal});
}

async function prepareWhisperArchive(url, root, options) {
    const filename = path.posix.basename(new URL(url).pathname);
    const archive = path.join(path.dirname(root), `${path.basename(root)}-${filename}`);
    await downloadWhisperResource(url, archive, options);
    await options.onEvent({
        type: 'local-ai.install.extracting',
        message: `Extracting ${filename}.`,
        data: {id: 'whisper.cpp', asset: filename}
    });
    await extractLocalAIArchive({archive, directory: root, signal: options.signal, onEvent: options.onEvent});
    await unlink(archive);
}

async function copyWhisperTree(source, destination, signal) {
    throwIfAborted(signal);
    await cp(path.resolve(source), destination, {
        recursive: true,
        verbatimSymlinks: true,
        filter: function retainCompleteWhisperTree() {
            throwIfAborted(signal);
            return true;
        }
    });
    throwIfAborted(signal);
}

function copiedWhisperLocation(sourceRoot, destinationRoot, location) {
    const root = path.resolve(sourceRoot);
    const relative = path.relative(root, path.resolve(root, location));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new ArcaneError(ERROR_CODES.usage, 'A Whisper library, helper, or decoder path must belong to its selected complete runtime tree so the native bundle can retain it.');
    }
    return path.join(destinationRoot, relative);
}

function defaultWhisperVariants(requirement, platform, architecture) {
    if (requirement.variants) return requirement.variants;
    if (platform !== 'win32' || architecture !== 'x64' || requirement.version !== '1.9.4') {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, `Automatic Whisper distributions are available for 1.9.4 on win32/x64. Supply complete runtime variants for ${requirement.version} on ${platform}/${architecture}.`);
    }
    if (requirement.encoder === 'openvino-npu') {
        if (requirement.backend === 'metal') {
            throw new ArcaneError(ERROR_CODES.targetUnavailable, 'The selected Windows OpenVINO Whisper distribution has no Metal decoder backend.');
        }
        const version = requirement.helperVersion ?? packageMetadata.version;
        return [{
            backend: requirement.backend === 'cpu' ? 'cpu' : 'cuda',
            encoder: 'openvino-npu',
            url: `https://github.com/TheWizardNexus/arcane-os-sdk/releases/download/${version}/arcane-whisper-openvino-windows-x64.tar.gz`
        }];
    }
    if (requirement.backend === 'metal') {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, 'The selected Windows Whisper distribution has no Metal backend.');
    }
    return [
        ...(requirement.backend === 'cpu' ? [] : [{
            backend: 'cuda',
            url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-cublas-12.4.0-bin-x64.zip'
        }]),
        {
            backend: 'cpu',
            url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'
        }
    ];
}

/** Prepare complete runtime trees under the shared install attempt owner. */
export async function installWhisperDistribution(requirement, options) {
    const {root, platform, architecture, onEvent, reusable} = options;
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const preparation = {...options, signal};
    const integratedEncoder = requirement.encoder === 'openvino-npu' && !requirement.variants;
    const variants = reusable
        ? integratedEncoder ? [reusable.runtime.variants[0]] : reusable.runtime.variants
        : defaultWhisperVariants(requirement, platform, architecture);
    if (!requirement.helperExecutable && !requirement.helperUrl && (platform !== 'win32' || architecture !== 'x64')) {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, `Supply the Arcane Whisper helperExecutable or helperUrl for ${platform}/${architecture}.`);
    }
    if (!requirement.decoderExecutable && !requirement.decoderUrl && (platform !== 'win32' || architecture !== 'x64')) {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, `Supply a complete decoder tree through decoderExecutable and decoderRoot, or decoderUrl, for ${platform}/${architecture}.`);
    }
    const helperName = `arcane-whisper${platform === 'win32' ? '.exe' : ''}`;
    let helperRoot = path.join(root, 'helper');
    let helperExecutable = path.join(helperRoot, helperName);
    const decoderRoot = path.join(root, 'decoder');
    const models = [];
    const preparedVariants = [];
    let decoderExecutable;
    await mkdir(root, {recursive: true});

    const jobs = variants.map(function variantPreparation(variant, index) {
        return async function prepareSelectedVariant() {
            const variantRoot = path.join(root, `variant-${index}-${variant.backend}`);
            const selectedLibraryDirectory = variant.libraryDirectory
                ? copiedWhisperLocation(variant.root ?? variantRoot, variantRoot, variant.libraryDirectory)
                : undefined;
            if (variant.root) await copyWhisperTree(variant.root, variantRoot, signal);
            else await prepareWhisperArchive(variant.url, variantRoot, preparation);
            const libraryName = platform === 'win32' ? 'whisper.dll' : platform === 'darwin' ? 'libwhisper.dylib' : 'libwhisper.so';
            const libraryDirectory = selectedLibraryDirectory ?? path.dirname(await findWhisperFile(variantRoot, libraryName, signal));
            preparedVariants[index] = {backend: variant.backend, root: variantRoot, libraryDirectory,
                ...(variant.encoder ? {encoder: variant.encoder} : {})};
            if (requirement.encoder === 'openvino-npu' && !requirement.helperExecutable && !requirement.helperUrl) {
                preparedVariants[index].executable = await findWhisperFile(variantRoot, helperName, signal);
            }
        };
    });
    jobs.push(async function prepareHelper() {
        // The optional native asset owns its matching helper and runtime as
        // one complete tree. Reuse that tree once and resolve its helper after
        // variant preparation joins, including when models change later.
        if (requirement.encoder === 'openvino-npu' && !requirement.helperExecutable && !requirement.helperUrl) return;
        const existingHelper = reusable?.runtime.helperExecutable ?? requirement.helperExecutable;
        if (existingHelper) {
            const source = path.resolve(existingHelper);
            const sourceRoot = path.resolve(reusable
                ? reusable.runtime.helperRoot ?? path.dirname(source)
                : requirement.helperRoot ?? path.dirname(source));
            helperExecutable = copiedWhisperLocation(sourceRoot, helperRoot, source);
            await copyWhisperTree(sourceRoot, helperRoot, signal);
            return;
        }
        const helperVersion = requirement.helperVersion ?? packageMetadata.version;
        const helperUrl = requirement.helperUrl ?? `https://github.com/TheWizardNexus/arcane-os-sdk/releases/download/${helperVersion}/arcane-whisper-windows-x64.tar.gz`;
        await prepareWhisperArchive(helperUrl, helperRoot, preparation);
        helperExecutable = await findWhisperFile(helperRoot, helperName, signal);
    });
    jobs.push(async function prepareDecoder() {
        const existingDecoder = reusable?.runtime.decoderExecutable ?? requirement.decoderExecutable;
        if (existingDecoder) {
            const source = path.resolve(existingDecoder);
            const sourceRoot = path.resolve(reusable?.runtime.decoderRoot ?? requirement.decoderRoot ?? path.dirname(source));
            decoderExecutable = copiedWhisperLocation(sourceRoot, decoderRoot, source);
            await copyWhisperTree(sourceRoot, decoderRoot, signal);
            return;
        }
        await prepareWhisperArchive(
            requirement.decoderUrl ?? 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
            decoderRoot,
            preparation
        );
        decoderExecutable = await findWhisperFile(decoderRoot, `ffmpeg${platform === 'win32' ? '.exe' : ''}`, signal);
    });
    for (const [index, model] of requirement.models.entries()) {
        jobs.push(async function prepareSelectedModel() {
            const modelRoot = path.join(root, 'models', String(index));
            await mkdir(modelRoot, {recursive: true});
            const priorIndex = reusable?.requirement.models.findIndex(function sameSelectedModel(candidate) {
                return JSON.stringify(candidate) === JSON.stringify(model);
            }) ?? -1;
            let sourceModel = model;
            if (priorIndex >= 0) {
                const prior = reusable.runtime.models[priorIndex];
                if (prior?.path) {
                    try {
                        const paths = [prior.path, ...(requirement.encoder === 'openvino-npu' ? [prior.encoderPath, prior.encoderDataPath] : [])];
                        let available = true;
                        for (const location of paths) if (!location || !(await stat(location)).isFile()) available = false;
                        if (available) sourceModel = prior;
                    } catch (error) {
                        if (error.code !== 'ENOENT') throw error;
                    }
                }
            }
            if (!sourceModel.path && model.archiveUrl) {
                await prepareWhisperArchive(model.archiveUrl, modelRoot, preparation);
                models[index] = {...model,
                    path: await findWhisperFile(modelRoot, model.filename, signal),
                    ...(requirement.encoder === 'openvino-npu' ? {
                        encoderPath: await findWhisperFile(modelRoot, model.encoderFilename, signal),
                        encoderDataPath: await findWhisperFile(modelRoot, model.encoderDataFilename, signal)
                    } : {})};
                return;
            }
            const filename = sourceModel.path ? path.basename(sourceModel.path) : model.filename ?? path.posix.basename(new URL(model.url).pathname);
            const destination = path.join(modelRoot, filename);
            if (sourceModel.path) await copyFile(path.resolve(sourceModel.path), destination);
            else await downloadWhisperResource(model.url, destination, preparation);
            const preparedModel = {...model, path: destination};
            if (requirement.encoder === 'openvino-npu') {
                for (const field of ['encoderPath', 'encoderDataPath']) {
                    throwIfAborted(signal);
                    preparedModel[field] = path.join(modelRoot, path.basename(sourceModel[field]));
                    await copyFile(path.resolve(sourceModel[field]), preparedModel[field]);
                }
            }
            models[index] = preparedModel;
        });
    }
    let nextJob = 0;
    const failures = [];
    async function prepareWhisperDependencies() {
        while (nextJob < jobs.length) {
            throwIfAborted(signal);
            const job = jobs[nextJob++];
            try {
                await job();
            } catch (error) {
                failures.push(error);
                controller.abort(error);
            }
        }
    }
    const workers = await Promise.allSettled(Array.from({length: Math.min(3, jobs.length)}, function startWhisperDependencyWorker() {
        return prepareWhisperDependencies();
    }));
    for (const worker of workers) if (worker.status === 'rejected') failures.push(worker.reason);
    throwIfAborted(options.signal);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Whisper dependency preparation failed.');
    if (requirement.encoder === 'openvino-npu' && !requirement.helperExecutable && !requirement.helperUrl) {
        helperRoot = preparedVariants[0].root;
        helperExecutable = preparedVariants[0].executable;
    }
    // The precompiled optional tree owns both decoder backends. Share its
    // helper and native files while keeping the normal GPU-first CPU recovery.
    if (integratedEncoder && requirement.backend === 'auto') {
        preparedVariants.push({...preparedVariants[0], backend: 'cpu'});
    }
    const locations = {
        version: requirement.version,
        backend: requirement.backend,
        ...(requirement.encoder ? {encoder: requirement.encoder} : {}),
        helperRoot,
        helperExecutable,
        helperVersion: requirement.helperVersion ?? packageMetadata.version,
        decoderRoot,
        decoderExecutable,
        variants: preparedVariants.map(function completedWhisperVariant(variant) {
            return {...variant, executable: variant.executable ?? helperExecutable};
        }),
        models,
        ...(requirement.modelId ? {modelId: requirement.modelId} : models.length === 1 ? {modelId: models[0].id} : {})
    };
    if (!await installedWhisperRuntime({...locations, root}, signal)) {
        throw new ArcaneError(ERROR_CODES.operationFailed, 'Whisper preparation did not produce the selected helper, decoder, runtime directories, and model files.');
    }
    await onEvent({type: 'local-ai.install.prepared', message: 'Whisper runtime, decoder, helper, and selected models are prepared.', data: {id: 'whisper.cpp'}});
    return locations;
}

export function bundledWhisperRuntime(runtime, relativeRoot) {
    function bundledWhisperPath(location) {
        return path.posix.join(relativeRoot, path.relative(runtime.root, location).split(path.sep).join('/'));
    }
    return {
        ...runtime,
        root: relativeRoot,
        helperRoot: bundledWhisperPath(runtime.helperRoot ?? path.dirname(runtime.helperExecutable)),
        helperExecutable: bundledWhisperPath(runtime.helperExecutable),
        decoderRoot: bundledWhisperPath(runtime.decoderRoot),
        decoderExecutable: bundledWhisperPath(runtime.decoderExecutable),
        variants: runtime.variants.map(function bundledWhisperVariant(variant) {
            return {...variant, root: bundledWhisperPath(variant.root), libraryDirectory: bundledWhisperPath(variant.libraryDirectory), executable: bundledWhisperPath(variant.executable)};
        }),
        models: runtime.models.map(function bundledWhisperModel(model) {
            return {...model, path: bundledWhisperPath(model.path),
                ...(model.encoderPath ? {encoderPath: bundledWhisperPath(model.encoderPath)} : {}),
                ...(model.encoderDataPath ? {encoderDataPath: bundledWhisperPath(model.encoderDataPath)} : {})};
        })
    };
}
