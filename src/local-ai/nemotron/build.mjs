import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import {runProcess} from '../../process.mjs';

/** Build the first-party ASR helper against the caller's installed NeMo SDK. */
export async function buildNemotronHelper({runtime, outputRoot, signal, onEvent} = {}) {
    if (typeof runtime?.cmakeDirectory !== 'string' || typeof outputRoot !== 'string') {
        throw new TypeError('Nemotron requires the selected runtime cmakeDirectory and helper outputRoot.');
    }
    const root = path.resolve(outputRoot);
    const build = path.join(root, 'build');
    const source = fileURLToPath(
        new URL('./native/', import.meta.url)
    );
    await mkdir(
        root,
        {recursive: true}
    );
    const options = {signal, onEvent};
    const configure = await runProcess(
        'cmake',
        [
            '-S', source,
            '-B', build,
            `-DNeMoSpeech_DIR=${path.resolve(runtime.cmakeDirectory)}`,
            `-DCMAKE_INSTALL_PREFIX=${root}`,
            '-DCMAKE_BUILD_TYPE=Release'
        ],
        options
    );
    const compile = await runProcess(
        'cmake',
        ['--build', build, '--config', 'Release'],
        options
    );
    const install = await runProcess(
        'cmake',
        ['--install', build, '--config', 'Release'],
        options
    );
    const executable = path.join(root, 'bin', process.platform === 'win32' ? 'arcane-nemotron.exe' : 'arcane-nemotron');
    return {
        platform: process.platform,
        architecture: process.arch,
        root,
        executable,
        helperExecutable: executable,
        diagnostics: {configure, compile, install}
    };
}

export default buildNemotronHelper;
