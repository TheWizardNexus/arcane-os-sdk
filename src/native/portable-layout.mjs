import {mkdir, readFile, readdir, realpath, stat, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import Is from 'strong-type';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../errors.mjs';

const is = new Is(false);
export const SDK_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CORE_FILES = [
    'src/core/host.mjs',
    'src/core/shared-host.mjs',
    'src/core/runtime.mjs',
    'src/core/stdio.mjs',
    'src/event-manager.mjs',
    'src/dom-event-instrumentation.mjs',
    'browser-runtime/core/contracts.mjs',
    'LICENSE'
];

export function outputFile(root, relative) {
    if (!is.string(relative) || !relative || path.isAbsolute(relative)) {
        throw new ArcaneError(ERROR_CODES.usage, 'A selected output file needs a relative path.');
    }
    const destination = path.resolve(root, relative);
    const within = path.relative(root, destination);
    if (!within || within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) {
        throw new ArcaneError(ERROR_CODES.usage, `The selected file leaves its output directory: ${relative}.`);
    }
    return destination;
}

export async function writeOutput(root, relative, content, files, signal) {
    throwIfAborted(signal);
    const destination = outputFile(root, relative);
    await mkdir(path.dirname(destination), {recursive: true});
    await writeFile(destination, content, {flag: 'wx', signal});
    files.push(relative.split(path.sep).join('/'));
}

export async function copyRelease(selection, destination, root, files, signal) {
    for (const relative of selection.release.files) {
        throwIfAborted(signal);
        // The supplied reader owns release selection. No text decoding, URL
        // rewriting or line-ending conversion occurs at native assembly.
        const content = is.function(selection.readReleaseFile)
            ? await selection.readReleaseFile(relative, {signal})
            : await readFile(outputFile(selection.releaseRoot, relative), {signal});
        outputFile(path.join(root, destination), relative);
        await writeOutput(root, `${destination}/${relative}`, content, files, signal);
    }
}

async function copyPackageTree(source, relative, root, files, signal, preserved) {
    throwIfAborted(signal);
    const sourceRoot = await realpath(source);
    const outputRelative = path.relative(sourceRoot, root);
    if (!outputRelative || (!path.isAbsolute(outputRelative)
        && outputRelative !== '..' && !outputRelative.startsWith(`..${path.sep}`))) {
        throw new ArcaneError(ERROR_CODES.usage, `Native output would copy itself from ${sourceRoot}.`);
    }
    const entries = await readdir(source, {withFileTypes: true});
    for (const entry of entries) {
        throwIfAborted(signal);
        const selected = path.join(source, entry.name);
        const destination = `${relative}/${entry.name}`;
        if (preserved.has(destination)) continue;
        const info = await stat(selected);
        if (info.isDirectory()) {
            await copyPackageTree(selected, destination, root, files, signal, preserved);
        } else if (info.isFile()) {
            await writeOutput(root, destination, await readFile(selected, {signal}), files, signal);
        } else {
            throw new ArcaneError(ERROR_CODES.operationFailed, `Cannot copy the runtime package entry: ${selected}.`);
        }
    }
}

export async function copyCoreRuntime(root, files, signal, {
    sourceRoot = SDK_ROOT, sdkDestination = 'node_modules/arcane-os'
} = {}) {
    const metadata = JSON.parse(await readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
    // A direct browser projection may already occupy this package directory.
    // Complete it from its selected installed package without replacing content.
    const preserved = new Set(files);
    for (const directory of ['bin', 'src', 'browser-runtime', 'runtime', 'schemas']) {
        await copyPackageTree(path.join(sourceRoot, directory), `${sdkDestination}/${directory}`, root, files, signal, preserved);
    }
    for (const relative of ['package.json', 'LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE', 'README.md', 'CHANGELOG.md']) {
        const destination = `${sdkDestination}/${relative}`;
        if (!preserved.has(destination)) {
            await writeOutput(root, destination, await readFile(path.join(sourceRoot, relative), {signal}), files, signal);
        }
    }

    // Preserve each dependency's actual installed runtime resolution, including
    // nested versions. Packaging reads published files; it executes no package.
    const copied = new Map([[sdkDestination, await realpath(sourceRoot)]]);
    async function includeDependency(name, from, parentDestination) {
        throwIfAborted(signal);
        const require = createRequire(path.join(from, 'package.json'));
        let packageFile;
        try {
            packageFile = require.resolve(`${name}/package.json`);
        } catch (error) {
            if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
            let directory = path.dirname(require.resolve(name));
            for (;;) {
                const candidate = path.join(directory, 'package.json');
                try {
                    const record = JSON.parse(await readFile(candidate, 'utf8'));
                    if (record.name === name) { packageFile = candidate; break; }
                } catch (failure) {
                    if (failure.code !== 'ENOENT') throw failure;
                }
                const parent = path.dirname(directory);
                if (parent === directory) throw error;
                directory = parent;
            }
        }
        const source = await realpath(path.dirname(packageFile));
        // Reuse only a resolved ancestor package that Node can actually reach.
        // This also terminates ordinary circular package dependencies.
        let ancestor = parentDestination;
        for (;;) {
            const candidate = path.posix.join(ancestor, 'node_modules', name);
            if (copied.has(candidate)) {
                if (copied.get(candidate) === source) return;
                break;
            }
            try { await stat(outputFile(root, `${candidate}/package.json`)); break; }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (ancestor === '.') break;
            ancestor = path.posix.dirname(ancestor);
        }
        const destination = `${parentDestination}/node_modules/${name}`;
        const record = JSON.parse(await readFile(packageFile, 'utf8'));
        let included = false;
        try { await stat(outputFile(root, `${destination}/package.json`)); included = true; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!included) await copyPackageTree(source, destination, root, files, signal, preserved);
        copied.set(destination, source);
        for (const dependency of Object.keys(record.dependencies ?? {})) {
            await includeDependency(dependency, source, destination);
        }
    }
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
        await includeDependency(dependency, sourceRoot, sdkDestination);
    }
    return metadata;
}

export function coreEntrySource(application, version, services, {localAI, runtimes = [], packagedWeb = false} = {}) {
    const launchDefaults = application.native?.launchContext;
    const imageSelected = localAI?.runtimes?.some(function selectedImage(requirement) {
        return (typeof requirement === 'string' ? requirement : requirement.id) === 'stable-diffusion.cpp';
    }) ?? false;
    const modelAssetsSelected = imageSelected || (localAI?.runtimes?.some(function selectedONNX(requirement) {
        return (typeof requirement === 'string' ? requirement : requirement.id) === 'onnx';
    }) ?? false);
    const whisperSelected = localAI?.runtimes?.some(function selectedWhisper(requirement) {
        return (typeof requirement === 'string' ? requirement : requirement.id) === 'whisper.cpp';
    }) ?? false;
    const imports = services.map(function serviceImport(service, index) {
        const specifier = '../app/' + service.module.split('/').map(encodeURIComponent).join('/');
        return {binding: `{default: createService${index}}`, specifier};
    });
    // JSON parsing retains authored field names that have object-literal syntax.
    const definitions = services.map(function serviceDefinition(service, index) {
        return `    register(createService${index}(JSON.parse(${JSON.stringify(JSON.stringify(service.options === undefined ? {} : service.options))}), context));`;
    });
    if (localAI !== undefined) {
        const chatConfiguration = {
            ...localAI,
            runtimes: localAI.runtimes.filter(function selectedChat(requirement) {
                const id = typeof requirement === 'string' ? requirement : requirement.id;
                return id !== 'stable-diffusion.cpp' && id !== 'whisper.cpp';
            })
        };
        imports.push({binding: '{createLocalAIService}', specifier: 'arcane-os/core/local-ai'});
        imports.push({binding: '{createExecutionDeviceCatalog}', specifier: 'arcane-os/local-ai/execution-devices'});
        imports.push({binding: '{createExecutionDeviceService}', specifier: 'arcane-os/core/execution-devices'});
        definitions.push(`    register(createLocalAIService(JSON.parse(${JSON.stringify(JSON.stringify(chatConfiguration))}), {...context, executionDevices}));`);
    }
    if (modelAssetsSelected) {
        imports.push({binding: '{createModelAssetService}', specifier: 'arcane-os/core/model-assets'});
    }
    if (imageSelected) {
        imports.push({binding: '{createLocalImageService}', specifier: 'arcane-os/core/image'});
        definitions.push(`    register(createLocalImageService(JSON.parse(${JSON.stringify(JSON.stringify(localAI))}), {...context, modelAssets}));`);
    }
    if (whisperSelected) {
        imports.push({binding: '{createSpeechService}', specifier: 'arcane-os/core/speech'});
        imports.push({binding: '{createWhisperRuntime}', specifier: 'arcane-os/local-ai/whisper'});
    }
    if (packagedWeb) {
        imports.push({binding: '{createPackagedWebService}', specifier: 'arcane-os/core/packaged-web'});
        definitions.push("    packagedWeb = createPackagedWebService({artifactRoot: fileURLToPath(new URL('../', import.meta.url))}, context);",
            '    register(packagedWeb);');
    }
    return [
        "import {fileURLToPath} from 'node:url';",
        "import path from 'node:path';",
        "import {isSea} from 'node:sea';",
        ...(launchDefaults === undefined ? [] : ["import {mkdir} from 'node:fs/promises';"]),
        "import {readCoreLaunchContext, startCoreHost, startCoreListener, runSharedCoreHost, startSharedCoreBridge} from 'arcane-os/core/host';",
        "import {createModelObservationService} from 'arcane-os/core/model-observation';",
        '',
        ...(localAI === undefined ? [] : [
            '// Bundled runtime paths are artifact-root-relative POSIX paths.',
            'function runtimePath(relative) {',
            "    return fileURLToPath(new URL('../' + relative.split('/').map(encodeURIComponent).join('/'), import.meta.url));",
            '}',
            ''
        ]),
        '// Factories share launch context as their second argument; authored options stay first.',
        '// Explicit launch fields override artifact-relative defaults unchanged.',
        'const context = {',
        "    appRoot: fileURLToPath(new URL('../app/', import.meta.url)),",
        ...(localAI === undefined ? [] : [
            `    runtimes: JSON.parse(${JSON.stringify(JSON.stringify(runtimes))}).map(function runtimeLocation(runtime) {`,
            '        const resolved = {...runtime};',
            "        for (const field of ['root', 'executable', 'modulePath', 'includeDirectory', 'libraryDirectory', 'binaryDirectory', 'cmakeDirectory', 'libraryPath', 'bindingModulePath', 'helperExecutable', 'helperRoot', 'decoderExecutable', 'decoderRoot']) {",
            '            if (runtime[field] !== undefined) resolved[field] = runtimePath(runtime[field]);',
            '        }',
            '        if (runtime.variants) resolved.variants = runtime.variants.map(function nativeVariant(variant) {',
            '            const resolvedVariant = {...variant};',
            "            for (const field of ['root', 'libraryPath', 'libraryDirectory', 'executable']) {",
            '                if (variant[field] !== undefined) resolvedVariant[field] = runtimePath(variant[field]);',
            '            }',
            '            return resolvedVariant;',
            '        });',
            '        if (runtime.models) resolved.models = runtime.models.map(function nativeModel(model) {',
            '            const resolvedModel = {...model};',
            "            for (const field of ['path', 'encoderPath', 'encoderDataPath']) {",
            '                if (model[field] !== undefined) resolvedModel[field] = runtimePath(model[field]);',
            '            }',
            '            if (model.resources !== undefined) {',
            '                resolvedModel.resources = {};',
            '                for (const [role, resource] of Object.entries(model.resources)) {',
            "                    resolvedModel.resources[role] = typeof resource === 'string' ? runtimePath(resource) : resource;",
            '                }',
            '            }',
            '            return resolvedModel;',
            '        });',
            '        return resolved;',
            '    }),'
        ]),
        launchDefaults === undefined ? '    ...await readCoreLaunchContext()'
            : `    ...await readCoreLaunchContext({appId: ${JSON.stringify(application.id)}, defaults: JSON.parse(${JSON.stringify(JSON.stringify(launchDefaults))})})`,
        '};',
        '',
        'if (context.coreListener !== undefined && context.sharedHost !== undefined) {',
        "    throw new TypeError('coreListener attaches to the window-owned Core; sharedHost selects its separate owning host.');",
        '}',
        '',
        ...(launchDefaults === undefined ? [] : [
            '// The shared endpoint and diagnostic log require their selected state directory.',
            'if (context.sharedHost !== undefined) await mkdir(context.stateRoot, {recursive: true});',
            ''
        ]),
        ...(packagedWeb ? ['let packagedWeb;', ''] : []),
        'async function createServices(register) {',
        `    const [${imports.map(function binding(selection) { return selection.binding; }).join(', ')}] = await Promise.all([`,
        ...imports.map(function importService(selection) { return `        import(${JSON.stringify(selection.specifier)})`; }).map(
            function separateImport(line, index) { return line + (index < imports.length - 1 ? ',' : ''); }
        ),
        '    ]);',
        ...(localAI === undefined ? [] : [
            '    // One lazy inventory owner per Core host; no model startup dependency.',
            '    const executionDevices = createExecutionDeviceCatalog({signal: context.signal});',
            '    register(createExecutionDeviceService({catalog: executionDevices}));'
        ]),
        ...(modelAssetsSelected ? ['    const modelAssets = createModelAssetService({appRoot: context.appRoot});', '    register(modelAssets);'] : []),
        ...(whisperSelected ? [
            '    const stt = createWhisperRuntime(',
            '        {',
            '            runtime: context.runtimes.find(function selectedWhisperRuntime(runtime) {',
            "                return runtime.id === 'whisper.cpp';",
            '            }),',
            "            temporaryDirectory: path.join(context.stateRoot ?? path.join(context.appRoot, '.arcane'), 'speech', 'whisper'),",
            '            onEvent: context.onEvent',
            '        }',
            '    );',
            '    register(createSpeechService({stt, signal: context.signal}));'
        ] : []),
        ...definitions,
        '}',
        `const application = JSON.parse(${JSON.stringify(JSON.stringify(application))});`,
        `const version = ${JSON.stringify(version)};`,
        'let host;',
        'let listener;',
        'if (context.sharedHost === undefined) {',
        '    const services = [];',
        '    await createServices(function register(service) { services.push(service); });',
        '    host = startCoreHost({application, version, services});',
        '    if (context.coreListener !== undefined) {',
        "        process.on('SIGINT', closeCore);",
        "        process.on('SIGTERM', closeCore);",
        '        try {',
        '            const observation = createModelObservationService(',
        '                {',
        '                    runtime: host.runtime,',
        '                    localAI: services.find(',
        "                        function localAIOwner(service) { return Object.hasOwn(service.methods ?? {}, 'localai.status'); }",
        '                    ) ?? null,',
        '                    image: services.find(',
        "                        function imageOwner(service) { return Object.hasOwn(service.methods ?? {}, 'image.status'); }",
        '                    ) ?? null,',
        '                    decisions: services.find(',
        "                        function decisionOwner(service) { return Object.hasOwn(service.methods ?? {}, 'decisions.status'); }",
        '                    ) ?? null',
        '                }',
        '            );',
        '            host.runtime.registerService(observation);',
        '            listener = await startCoreListener({runtime: host.runtime, endpoint: context.coreListener?.endpoint});',
        '            listener.closed.catch(function listenerFailed() { process.exitCode = 1; });',
        '        } catch (error) {',
        '            try {',
        '                await host.close();',
        '            } catch (closeError) {',
        "                throw new AggregateError([error, closeError], 'Core listener startup and host drain failed.');",
        '            }',
        '            throw error;',
        '        } finally {',
        "            process.off('SIGINT', closeCore);",
        "            process.off('SIGTERM', closeCore);",
        '        }',
        '    }',
        "} else if (process.argv.includes('--arcane-core-headless')) {",
        '    host = await runSharedCoreHost({',
        '        endpoint: context.sharedHost.endpoint, application, version,',
        '        configure(runtime) { return createServices(function register(service) { runtime.registerService(service); }); },',
        ...(packagedWeb ? [
            '        getReplayEvents() {',
            '            const current = packagedWeb?.current();',
            "            return current ? [{event: 'core.web.ready', data: current}] : [];",
            '        }'
        ] : []),
        '    });',
        '} else {',
        '    host = await startSharedCoreBridge({',
        '        endpoint: context.sharedHost.endpoint,',
        '        start: {',
        '            command: process.execPath,',
        "            args: [...(isSea() ? [] : [fileURLToPath(import.meta.url)]), ...process.argv.slice(2), '--arcane-core-headless'],",
        '            logFile: context.sharedHost.logFile',
        '        }',
        '    });',
        '}',
        '',
        'function closeCore() { host?.close(); }',
        "process.on('SIGINT', closeCore);",
        "process.on('SIGTERM', closeCore);",
        'try {',
        '    await host?.closed;',
        '} catch (error) {',
        "    console.error('Arcane Core host failed:', error);",
        '    process.exitCode = 1;',
        '} finally {',
        '    try {',
        '        await listener?.close();',
        '    } catch {',
        '        // The listener reports its complete failure through onError.',
        '        process.exitCode = 1;',
        '    }',
        "    process.off('SIGINT', closeCore);",
        "    process.off('SIGTERM', closeCore);",
        '}',
        ''
    ].join('\n');
}
