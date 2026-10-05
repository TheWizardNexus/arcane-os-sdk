import {chmod, copyFile, mkdir, mkdtemp, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ArcaneError, ERROR_CODES, throwIfAborted} from '../src/errors.mjs';
import {runProcess} from '../src/process.mjs';

/** Compile selected Darwin host assets once; app assembly needs no compiler. */
export async function buildCoreMacOSHost({nodeExecutable, runtimeLicense, compiler, architecture, outputRoot, signal, onEvent}) {
    throwIfAborted(signal);
    if (process.platform !== 'darwin') {
        throw new ArcaneError(ERROR_CODES.targetUnavailable, 'Compile the macOS host using the selected Darwin compiler and frameworks on macOS.');
    }
    if (!['arm64', 'x64'].includes(architecture)) {
        throw new ArcaneError(ERROR_CODES.usage, 'Select the macOS host architecture: arm64 or x64.');
    }
    const selectedNode = path.resolve(nodeExecutable);
    const metadata = JSON.parse(await readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
    // Query only the explicitly selected runtime. Never silently substitute the
    // build process's Node version or infer architecture from its host machine.
    const nodeResult = await runProcess(selectedNode, ['--eval',
        'process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,architecture:process.arch}))'
    ], {signal, onEvent});
    const runtime = JSON.parse(nodeResult.stdout);
    const minimum = /^>=(\d+)\.(\d+)\.(\d+)$/u.exec(metadata.engines.node);
    const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(runtime.version);
    if (!minimum || !version) {
        throw new ArcaneError(ERROR_CODES.prerequisiteMissing, 'The selected Node runtime must have a stable version satisfying the SDK Node engine.', {
            details: {runtime, required: metadata.engines.node}
        });
    }
    const selectedParts = version.slice(1).map(Number);
    const requiredParts = minimum.slice(1).map(Number);
    const firstDifference = selectedParts.findIndex(function different(part, index) { return part !== requiredParts[index]; });
    if (runtime.platform !== 'darwin' || runtime.architecture !== architecture
        || (firstDifference !== -1 && selectedParts[firstDifference] < requiredParts[firstDifference])) {
        throw new ArcaneError(ERROR_CODES.prerequisiteMissing, 'The selected Node runtime does not match the macOS architecture or SDK Node engine.', {
            details: {runtime, architecture, required: metadata.engines.node}
        });
    }
    throwIfAborted(signal);
    const parent = path.resolve(outputRoot);
    await mkdir(parent, {recursive: true});
    const directory = await mkdtemp(path.join(parent, `arcane-macos-${architecture}-host-`));
    const runtimeDirectory = path.join(directory, 'runtime');
    await mkdir(runtimeDirectory);
    const executable = path.join(directory, 'Arcane');
    const source = fileURLToPath(new URL('../src/core/hosts/macos/', import.meta.url));
    const copies = [
        [selectedNode, path.join(runtimeDirectory, 'node')],
        [path.resolve(runtimeLicense), path.join(runtimeDirectory, 'NODE-LICENSE')],
        ...['LICENSE', 'COMMERCIAL-LICENSE.md', 'NOTICE'].map(function sdkLegalFile(name) {
            return [fileURLToPath(new URL(`../${name}`, import.meta.url)), path.join(directory, name)];
        })
    ];
    const argumentsList = [
        '-fobjc-arc', '-fblocks', '-arch', architecture === 'x64' ? 'x86_64' : 'arm64',
        '-mmacosx-version-min=11.0',
        path.join(source, 'ArcaneLauncher.m'), path.join(source, 'ArcaneHost.m'), path.join(source, 'ArcaneCoreProcess.m'),
        '-framework', 'Foundation', '-framework', 'AppKit', '-framework', 'WebKit', '-o', executable
    ];
    // Compile and copy independent assets concurrently. Settle every owner
    // before reporting failure; retain selected output for complete diagnostics.
    const operations = await Promise.allSettled([
        runProcess(path.resolve(compiler), argumentsList, {cwd: directory, signal, onEvent}),
        ...copies.map(async function copyHostAsset([from, to]) {
            throwIfAborted(signal);
            await copyFile(from, to);
            if (to === path.join(runtimeDirectory, 'node')) await chmod(to, 0o755);
        })
    ]);
    const failures = operations.filter(function failed(result) { return result.status === 'rejected'; })
        .map(function failure(result) { return result.reason; });
    if (failures.length) throw new AggregateError(failures, `macOS host assembly failed. Output retained at ${directory}.`);
    await chmod(executable, 0o755);
    throwIfAborted(signal);
    return {directory, executable, runtime: runtimeDirectory, architecture, nodeVersion: runtime.version};
}

if (import.meta.main) {
    const [nodeExecutable, runtimeLicense, compiler, architecture, outputRoot] = process.argv.slice(2);
    if (!nodeExecutable || !runtimeLicense || !compiler || !architecture || !outputRoot) {
        throw new Error('Usage: node tools/build-core-macos-host.mjs <Darwin-node> <Node-LICENSE> <clang> <arm64|x64> <output-directory>');
    }
    console.log(await buildCoreMacOSHost({nodeExecutable, runtimeLicense, compiler, architecture, outputRoot}));
}
