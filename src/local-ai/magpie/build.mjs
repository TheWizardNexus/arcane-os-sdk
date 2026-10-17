import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {mkdir} from 'node:fs/promises';
import Is from 'strong-type';
import {runProcess} from '../../process.mjs';

const is = new Is(false);

/** Build the first-party adapter against an explicitly prepared NeMo TTS runtime. */
export async function buildMagpieHelper({runtime, outputRoot, signal, onEvent} = {}) {
    if (!is.string(runtime?.cmakeDirectory) || !is.string(outputRoot)) {
        throw new TypeError('Magpie requires the selected NeMo runtime cmakeDirectory and helper outputRoot.');
    }
    const root = path.resolve(outputRoot);
    const build = path.join(root, 'build');
    const source = fileURLToPath(new URL('./native/', import.meta.url));
    await mkdir(root, {recursive: true});
    const options = {signal, onEvent};
    const configure = await runProcess(
        'cmake',
        ['-S', source, '-B', build, `-DNeMoSpeech_DIR=${path.resolve(runtime.cmakeDirectory)}`,
            `-DCMAKE_INSTALL_PREFIX=${root}`, '-DCMAKE_BUILD_TYPE=Release'],
        options
    );
    const compile = await runProcess('cmake', ['--build', build, '--config', 'Release'], options);
    const install = await runProcess('cmake', ['--install', build, '--config', 'Release'], options);
    return {
        platform: process.platform,
        architecture: process.arch,
        root,
        helperExecutable: path.join(root, 'bin', process.platform === 'win32' ? 'arcane-magpie.exe' : 'arcane-magpie'),
        diagnostics: {configure, compile, install}
    };
}

export default buildMagpieHelper;
