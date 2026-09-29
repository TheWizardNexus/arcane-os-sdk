import {copyFile, mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Browser delivery uses the installed package's public Queue entry unchanged.
// Update the npm dependency first, then run this projection; never edit its output.
const packageRoot = path.dirname(fileURLToPath(import.meta.resolve('js-queue/package.json')));
const destination = fileURLToPath(new URL('../browser-runtime/dependencies/js-queue/', import.meta.url));
await mkdir(destination, {recursive: true});
await Promise.all(['queue.js', 'package.json', 'licence.md'].map(
    function copyPublishedQueueFile(name) {
        return copyFile(path.join(packageRoot, name), path.join(destination, name));
    }
));
