import {readFile} from 'node:fs/promises';
import Is from 'strong-type';
import {createCoreRuntime} from './runtime.mjs';
import {startCoreStdio} from './stdio.mjs';

const is = new Is(false);

/**
 * Read only the explicitly supplied --arcane-launch-config filename.
 * Return the complete JSON object for the service factories' second argument;
 * field meanings belong to the launch owner and individual services.
 */
export async function readCoreLaunchContext({argv = process.argv.slice(2)} = {}) {
    const flag = argv.indexOf('--arcane-launch-config');
    if (flag === -1) return {};
    const filename = argv[flag + 1];
    if (filename === undefined || filename === '') {
        throw new TypeError('--arcane-launch-config requires a filename.');
    }
    const context = JSON.parse(await readFile(filename, 'utf8'));
    if (context === null || !is.object(context) || is.array(context)) {
        throw new TypeError('Core launch configuration must be a JSON object.');
    }
    return context;
}

/** Compose app services with the shared dispatcher and draining transport. */
export function startCoreHost({application, version, services = [], input, output, onError, signal} = {}) {
    const runtime = createCoreRuntime({application, version, services});
    const host = startCoreStdio({runtime, input, output, onError});
    if (!signal) return host;

    function closeHostOnAbort() {
        // The transport owns cancellation, accepted-service work and final output.
        host.close();
    }

    function releaseAbortListener() {
        signal.removeEventListener('abort', closeHostOnAbort);
    }

    signal.addEventListener('abort', closeHostOnAbort, {once: true});
    host.closed.then(releaseAbortListener, releaseAbortListener);
    if (signal.aborted) closeHostOnAbort();
    return host;
}
