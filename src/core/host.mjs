import {readFile} from 'node:fs/promises';
import Is from 'strong-type';
import {createCoreRuntime} from './runtime.mjs';
import {startCoreStdio} from './stdio.mjs';

const is = new Is(false);

/**
 * The host's separate state-root argument supplies a launch-context default.
 * Every field in an explicitly selected launch JSON object takes precedence
 * unchanged; field meanings belong to the launch owner and individual services.
 */
export async function readCoreLaunchContext({argv = process.argv.slice(2)} = {}) {
    const stateFlag = argv.indexOf('--arcane-host-state-root');
    const defaults = {};
    if (stateFlag !== -1) {
        const stateRoot = argv[stateFlag + 1];
        if (stateRoot === undefined || stateRoot === '') {
            throw new TypeError('--arcane-host-state-root requires a directory.');
        }
        defaults.stateRoot = stateRoot;
    }
    const flag = argv.indexOf('--arcane-launch-config');
    if (flag === -1) return defaults;
    const filename = argv[flag + 1];
    if (filename === undefined || filename === '') {
        throw new TypeError('--arcane-launch-config requires a filename.');
    }
    const context = JSON.parse(await readFile(filename, 'utf8'));
    if (context === null || !is.object(context) || is.array(context)) {
        throw new TypeError('Core launch configuration must be a JSON object.');
    }
    return {...defaults, ...context};
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
