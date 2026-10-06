import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import Is from 'strong-type';
import {runProcess} from '../../process.mjs';

const is = new Is(false);

/** Build only the persistent first-party helper against an installed runtime. */
export async function buildWhisperHelper({
    runtime,
    outputRoot,
    cmake = 'cmake',
    generator,
    cmakeArgs = [],
    env,
    signal,
    onEvent
} = {}) {
    if (!is.string(runtime?.directory) || !is.string(runtime?.sourceDirectory) || !is.string(outputRoot)) {
        throw new TypeError('The selected Whisper runtime directory, matching sourceDirectory, and helper outputRoot are required.');
    }
    const root = path.resolve(outputRoot);
    const build = path.join(root, 'build');
    const source = fileURLToPath(new URL('./native/', import.meta.url));
    await mkdir(root, {recursive: true});
    const options = {env, signal, onEvent};
    const configure = await runProcess(cmake, [
        '-S', source,
        '-B', build,
        ...(generator ? ['-G', generator] : []),
        `-DWHISPER_SOURCE_DIRECTORY=${path.resolve(runtime.sourceDirectory)}`,
        `-DWHISPER_RUNTIME_DIRECTORY=${path.resolve(runtime.directory)}`,
        `-DCMAKE_INSTALL_PREFIX=${root}`,
        '-DCMAKE_BUILD_TYPE=Release',
        ...cmakeArgs
    ], options);
    const compile = await runProcess(cmake, ['--build', build, '--config', 'Release'], options);
    const install = await runProcess(cmake, ['--install', build, '--config', 'Release'], options);
    return {
        platform: process.platform,
        architecture: process.arch,
        root,
        executable: path.join(root, 'bin', process.platform === 'win32' ? 'arcane-whisper.exe' : 'arcane-whisper'),
        runtimeDirectory: path.resolve(runtime.directory),
        diagnostics: {configure, compile, install}
    };
}
