import {copyFile, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/** Build the selected Windows SDK runtime, not an application or its modules. */
export async function buildCoreSea({nodeExecutable, runtimeLicense, outputRoot}) {
    const parent = path.resolve(outputRoot);
    await mkdir(parent, {recursive: true});
    const directory = await mkdtemp(path.join(parent, 'arcane-core-sea-'));
    const executable = path.join(directory, 'ArcaneCore.exe');
    const loader = path.join(directory, 'arcane-core-loader.cjs');
    const configuration = path.join(directory, 'sea-config.json');
    await Promise.all([
        copyFile(fileURLToPath(new URL('../src/core/hosts/arcane-core-loader.cjs', import.meta.url)), loader),
        copyFile(runtimeLicense, path.join(directory, 'NODE-LICENSE')),
        writeFile(configuration, JSON.stringify({
            main: fileURLToPath(new URL('../src/core/hosts/sea-launcher.cjs', import.meta.url)),
            mainFormat: 'commonjs',
            executable: path.resolve(nodeExecutable),
            output: executable,
            useSnapshot: false,
            useCodeCache: false
        }, null, 2) + '\n')
    ]);
    await new Promise(function buildSelectedSea(resolve, reject) {
        const child = spawn(path.resolve(nodeExecutable), ['--build-sea', configuration], {
            cwd: directory,
            stdio: 'inherit',
            windowsHide: true
        });
        child.once('error', reject);
        child.once('close', function observeSeaBuild(code, signal) {
            if (code === 0) resolve();
            else reject(new Error(`Core SEA build ended with code ${code} and signal ${signal}. Output retained at ${directory}.`));
        });
    });
    return {directory, executable, loader};
}

if (import.meta.main) {
    const [nodeExecutable, runtimeLicense, outputRoot] = process.argv.slice(2);
    if (!nodeExecutable || !runtimeLicense || !outputRoot) {
        throw new Error('Usage: node tools/build-core-sea.mjs <selected-node.exe> <Node-LICENSE> <output-directory>');
    }
    console.log(await buildCoreSea({nodeExecutable, runtimeLicense, outputRoot}));
}
