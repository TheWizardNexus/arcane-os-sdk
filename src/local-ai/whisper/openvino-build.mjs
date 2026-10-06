import path from 'node:path';
import {cp, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import Is from 'strong-type';
import {runProcess} from '../../process.mjs';

const is = new Is(false);

/** Produce the optional Windows Intel NPU encoder runtime from installed upstream sources. */
export async function buildWhisperOpenVinoRuntime({
    sourceDirectory,
    openvinoDirectory,
    cudaDirectory,
    outputRoot,
    cmake = 'cmake',
    generator,
    cmakeArgs = [],
    env,
    signal,
    onEvent
} = {}) {
    if (!is.string(sourceDirectory) || !is.string(openvinoDirectory) || !is.string(outputRoot)) {
        throw new TypeError('Whisper sourceDirectory, OpenVINO openvinoDirectory, and outputRoot are required.');
    }
    if (process.platform !== 'win32' || process.arch !== 'x64') {
        throw new Error('This optional OpenVINO producer currently targets Windows x64.');
    }
    const output = path.resolve(outputRoot);
    const source = path.join(output, 'source');
    const build = path.join(output, 'build');
    const root = path.join(output, 'runtime');
    const libraryDirectory = path.join(root, 'bin');
    const toolkit = path.resolve(openvinoDirectory);
    const options = {env, signal, onEvent};
    signal?.throwIfAborted();
    await cp(path.resolve(sourceDirectory), source, {recursive: true});
    signal?.throwIfAborted();
    await prepareOpenVinoSource(source);
    const configure = await runProcess(cmake, [
        '-S', source,
        '-B', build,
        ...(generator ? ['-G', generator] : []),
        '-DCMAKE_BUILD_TYPE=Release',
        `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY=${path.join(build, 'bin')}`,
        `-DCMAKE_RUNTIME_OUTPUT_DIRECTORY_RELEASE=${path.join(build, 'bin')}`,
        '-DBUILD_SHARED_LIBS=ON',
        '-DWHISPER_OPENVINO=ON',
        '-DWHISPER_BUILD_IS_DEV=OFF',
        '-DWHISPER_BUILD_TESTS=OFF',
        '-DWHISPER_BUILD_EXAMPLES=OFF',
        '-DWHISPER_BUILD_SERVER=OFF',
        '-DGGML_BACKEND_DL=ON',
        '-DGGML_CPU=ON',
        '-DGGML_NATIVE=OFF',
        '-DGGML_CUDA=OFF',
        '-DGGML_OPENVINO=OFF',
        '-DGGML_OPENMP_FETCH=OFF',
        '-DGGML_CCACHE=OFF',
        `-DOpenVINO_DIR=${path.join(toolkit, 'runtime', 'cmake')}`,
        ...cmakeArgs
    ], options);
    const compile = await runProcess(cmake, [
        '--build', build, '--config', 'Release', '--target', 'whisper', 'ggml-cpu'
    ], options);
    signal?.throwIfAborted();
    await mkdir(libraryDirectory, {recursive: true});
    await mkdir(path.join(root, 'lib'), {recursive: true});
    await mkdir(path.join(root, 'notices', 'whisper.cpp'), {recursive: true});
    // Keep all selected upstream runtime DLLs together for Windows and plugin lookup.
    await cp(path.join(build, 'bin'), libraryDirectory, {recursive: true});
    await copyImportLibraries(build, path.join(root, 'lib'));
    await cp(path.join(toolkit, 'runtime', 'bin', 'intel64', 'Release'), libraryDirectory, {recursive: true});
    const tbbDirectory = path.join(toolkit, 'runtime', '3rdparty', 'tbb', 'bin');
    for (const member of await readdir(tbbDirectory, {withFileTypes: true})) {
        if (member.isFile() && member.name.endsWith('.dll') && !member.name.endsWith('_debug.dll')) {
            await cp(path.join(tbbDirectory, member.name), path.join(libraryDirectory, member.name));
        }
    }
    if (cudaDirectory) {
        // The matching upstream plugin supplies CUDA without compiling a new backend.
        for (const name of [
            'ggml-cuda.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll',
            'nvblas64_12.dll', 'nvrtc-builtins64_124.dll', 'nvrtc64_120_0.dll'
        ]) {
            await cp(path.join(cudaDirectory, name), path.join(libraryDirectory, name));
        }
    }
    await cp(path.join(toolkit, 'docs', 'licensing'), path.join(root, 'notices', 'openvino'), {recursive: true});
    await cp(path.join(source, 'LICENSE'), path.join(root, 'notices', 'whisper.cpp', 'LICENSE'));
    await writeFile(path.join(root, 'notices', 'whisper.cpp', 'CHANGES.txt'),
        'whisper.cpp 1.9.4: propagate OpenVINO encoder inference failure and send both OpenVINO exception diagnostics to stderr.\n');
    signal?.throwIfAborted();
    return {
        version: '1.9.4',
        openvinoVersion: '2026.3.1',
        platform: process.platform,
        architecture: process.arch,
        encoder: 'openvino-npu',
        backend: cudaDirectory ? 'cuda' : 'cpu',
        backends: cudaDirectory ? ['cuda', 'cpu'] : ['cpu'],
        root,
        directory: root,
        libraryDirectory,
        sourceDirectory: source,
        diagnostics: {configure, compile}
    };
}

async function prepareOpenVinoSource(source) {
    const whisperPath = path.join(source, 'src', 'whisper.cpp');
    const encoderPath = path.join(source, 'src', 'openvino', 'whisper-openvino-encoder.cpp');
    const whisper = await readFile(whisperPath, 'utf8');
    const call = '            whisper_openvino_encode(wstate.ctx_openvino, mel, wstate.embd_enc);';
    if (!whisper.includes(call)) {
        throw new Error('The selected Whisper source does not contain the expected OpenVINO encoder call.');
    }
    await writeFile(whisperPath, whisper.replace(call,
        '            if (!whisper_openvino_encode(wstate.ctx_openvino, mel, wstate.embd_enc)) {\n                return false;\n            }'));
    const encoder = await readFile(encoderPath, 'utf8');
    const compileDiagnostic = 'std::cout << "in openvino encoder compile routine: exception: "';
    const inferenceDiagnostic = 'std::cout << "in openvino encode inference execution routine: exception: "';
    if (!encoder.includes(compileDiagnostic) || !encoder.includes(inferenceDiagnostic)) {
        throw new Error('The selected Whisper source does not contain both expected OpenVINO diagnostics.');
    }
    await writeFile(encoderPath, encoder
        .replace(compileDiagnostic, compileDiagnostic.replace('std::cout', 'std::cerr'))
        .replace(inferenceDiagnostic, inferenceDiagnostic.replace('std::cout', 'std::cerr')));
}

async function copyImportLibraries(directory, destination) {
    for (const member of await readdir(directory, {withFileTypes: true})) {
        const source = path.join(directory, member.name);
        if (member.isDirectory()) {
            await copyImportLibraries(source, destination);
        } else if (member.name === 'whisper.lib' || /^ggml(?:-.*)?\.lib$/.test(member.name)) {
            await cp(source, path.join(destination, member.name));
        }
    }
}
