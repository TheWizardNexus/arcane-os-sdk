import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import Is from 'strong-type';
import {createCoreRuntime} from './runtime.mjs';
import {startCoreStdio} from './stdio.mjs';

export {startSharedCoreHost, connectSharedCoreHost, runSharedCoreHost, startSharedCoreBridge} from './shared-host.mjs';

const is = new Is(false);

/** Resolve one app's native locations without creating or migrating data. */
export function resolveNativeLaunchContext({appId, context = {}} = {}) {
    if (!is.string(appId) || !appId) throw new TypeError('Native launch resolution requires an appId.');
    if (context === null || !is.object(context) || is.array(context)) {
        throw new TypeError('Native launch context must be an object.');
    }
    let stateRoot = context.stateRoot;
    if (stateRoot === undefined) {
        const home = homedir();
        switch (process.platform) {
            case 'win32':
                stateRoot = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Arcane', appId);
                break;
            case 'darwin':
                stateRoot = path.join(home, 'Library', 'Application Support', 'Arcane', appId);
                break;
            case 'linux': {
                const xdg = process.env.XDG_DATA_HOME;
                stateRoot = path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share'), 'Arcane', appId);
                break;
            }
            default:
                throw new TypeError('This native host must supply its persistent stateRoot.');
        }
    }
    if (!is.string(stateRoot) || !stateRoot) throw new TypeError('Native stateRoot must be a nonempty directory path.');
    const root = path.resolve(stateRoot);
    const resolved = {
        ...context,
        stateRoot,
        workspaceRoot: context.workspaceRoot === undefined ? path.join(root, 'Workspace') : context.workspaceRoot
    };
    if (context.sharedHost !== undefined) {
        if (context.sharedHost === null || !is.object(context.sharedHost) || is.array(context.sharedHost)) {
            throw new TypeError('Native sharedHost must be an object.');
        }
        // Encode the complete selected Windows path as a pipe-name component;
        // Unix IPC uses an ordinary file in that same persistent app directory.
        const endpoint = process.platform === 'win32'
            ? '\\\\.\\pipe\\Arcane-' + encodeURIComponent(root)
            : path.join(root, 'core.sock');
        resolved.sharedHost = {
            ...context.sharedHost,
            endpoint: context.sharedHost.endpoint === undefined ? endpoint : context.sharedHost.endpoint,
            logFile: context.sharedHost.logFile === undefined ? path.join(root, 'Core.log') : context.sharedHost.logFile
        };
    }
    return resolved;
}

/**
 * Packaged defaults precede the host's actual state-root argument.
 * Every field in an explicitly selected launch JSON object takes precedence
 * unchanged; field meanings belong to the launch owner and individual services.
 * appId explicitly selects native location resolution; ordinary calls keep the
 * existing read-only launch-file contract without choosing any locations.
 */
export async function readCoreLaunchContext({argv = process.argv.slice(2), defaults = {}, appId} = {}) {
    if (defaults === null || !is.object(defaults) || is.array(defaults)) {
        throw new TypeError('Core launch defaults must be an object.');
    }
    const stateFlag = argv.indexOf('--arcane-host-state-root');
    const context = {...defaults};
    if (stateFlag !== -1) {
        const stateRoot = argv[stateFlag + 1];
        if (stateRoot === undefined || stateRoot === '') {
            throw new TypeError('--arcane-host-state-root requires a directory.');
        }
        context.stateRoot = stateRoot;
    }
    const flag = argv.indexOf('--arcane-launch-config');
    let selected = context;
    if (flag !== -1) {
        const filename = argv[flag + 1];
        if (filename === undefined || filename === '') {
            throw new TypeError('--arcane-launch-config requires a filename.');
        }
        const explicit = JSON.parse(await readFile(filename, 'utf8'));
        if (explicit === null || !is.object(explicit) || is.array(explicit)) {
            throw new TypeError('Core launch configuration must be a JSON object.');
        }
        selected = {...context, ...explicit};
    }
    return appId === undefined ? selected : resolveNativeLaunchContext({appId, context: selected});
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
