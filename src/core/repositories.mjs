import {mkdir, readdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, throwIfAborted} from '../errors.mjs';
import {runProcess} from '../process.mjs';
import {repositoryPull, repositoryPush, repositoryStatus} from '../repository.mjs';

const is = new Is(false);
const directoryOperations = new Map();

/** Resolve persistent native data without creating or migrating anything. */
export function resolveArcaneDataPaths({dataRoot} = {}) {
    let root = dataRoot;
    if (root === undefined) {
        const home = homedir();
        switch (process.platform) {
            case 'win32':
                root = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ArcaneData');
                break;
            case 'darwin':
                root = path.join(home, 'Library', 'Application Support', 'ArcaneData');
                break;
            case 'linux': {
                const xdg = process.env.XDG_DATA_HOME;
                const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
                root = path.join(base, 'ArcaneData');
                break;
            }
            default:
                throw new ArcaneError(
                    'ARCANE_DATA_ROOT_REQUIRED',
                    'This native host must supply its persistent ArcaneData directory through dataRoot.'
                );
        }
    }
    requireString(root, 'dataRoot');
    const resolved = path.resolve(root);
    return {dataRoot: resolved, repositoriesRoot: path.join(resolved, 'Repos')};
}

/** One connected checkout, composed into an application's own Core service. */
export function createRepositoryWorkspace(
    {name, directory, dataRoot, remote, branch, onEvent, run = runProcess} = {}
) {
    let selected = directory;
    if (selected === undefined) {
        requireString(name, 'name');
        if (name === '.' || name === '..' || /[/\\]/u.test(name)) {
            throw new TypeError('name must be one directory name; use directory for an explicit repository path.');
        }
        selected = path.join(resolveArcaneDataPaths({dataRoot}).repositoriesRoot, name);
    }
    requireString(selected, 'directory');
    if (remote !== undefined) requireString(remote, 'remote');
    if (branch !== undefined) requireString(branch, 'branch');
    if (!is.function(run)) throw new TypeError('run must implement the SDK process adapter.');
    const repositoryDirectory = path.resolve(selected);
    const pending = new Set();
    let opened = false;
    let closing = null;

    async function prepare(signal) {
        throwIfAborted(signal);
        if (opened) return {directory: repositoryDirectory, cloned: false};
        let entries;
        try {
            entries = await readdir(repositoryDirectory);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            entries = [];
        }
        throwIfAborted(signal);
        if (entries.length) {
            // A parent checkout or a bare object cache is not this connection's
            // working root. Inspection never changes an existing destination.
            const result = await run(
                'git',
                ['rev-parse', '--is-inside-work-tree', '--show-prefix'],
                {cwd: repositoryDirectory, signal, onEvent}
            );
            throwIfAborted(signal);
            const [inside, prefix] = result.stdout.split(/\r?\n/u);
            if (inside !== 'true' || prefix !== '') {
                throw new ArcaneError(
                    'ARCANE_REPOSITORY_DIRECTORY_INVALID',
                    'The selected nonempty directory is not a Git working repository root.',
                    {details: result}
                );
            }
            opened = true;
            return {directory: repositoryDirectory, cloned: false};
        }
        requireString(remote, 'remote');
        await mkdir(path.dirname(repositoryDirectory), {recursive: true});
        throwIfAborted(signal);
        const arguments_ = ['clone', '--progress'];
        if (branch !== undefined) arguments_.push('--branch', branch);
        arguments_.push('--', remote, repositoryDirectory);
        const result = await run(
            'git',
            arguments_,
            {cwd: path.dirname(repositoryDirectory), signal, onEvent}
        );
        throwIfAborted(signal);
        opened = true;
        return {directory: repositoryDirectory, cloned: true, stdout: result.stdout, stderr: result.stderr};
    }

    function accept(operation, signal) {
        try {
            throwIfAborted(signal);
            if (closing) throw new ArcaneError('CORE_CLOSING', 'The repository workspace is closing.');
        } catch (error) {
            return Promise.reject(error);
        }
        const result = orderDirectoryOperation(
            repositoryDirectory,
            async function runRepositoryOperation() {
                throwIfAborted(signal);
                return operation();
            }
        );
        pending.add(result);
        function settled() {
            pending.delete(result);
        }
        result.then(settled, settled);
        return result;
    }

    function open({signal} = {}) {
        return accept(
            function openRepository() {
                return prepare(signal);
            },
            signal
        );
    }

    function status({signal} = {}) {
        return accept(
            async function readRepositoryStatus() {
                await prepare(signal);
                return repositoryStatus({workspaceRoot: repositoryDirectory, signal, onEvent, run});
            },
            signal
        );
    }

    function pull({signal} = {}) {
        return accept(
            async function pullRepository() {
                await prepare(signal);
                return repositoryPull({workspaceRoot: repositoryDirectory, signal, onEvent, run});
            },
            signal
        );
    }

    function push({signal} = {}) {
        return accept(
            async function pushRepository() {
                await prepare(signal);
                return repositoryPush({workspaceRoot: repositoryDirectory, signal, onEvent, run});
            },
            signal
        );
    }

    function close() {
        if (!closing) {
            closing = Promise.allSettled([...pending]).then(
                function operationsDrained(results) {
                    const failures = results.filter(
                        function failed(result) {
                            return result.status === 'rejected';
                        }
                    ).map(
                        function reason(result) {
                            return result.reason;
                        }
                    );
                    if (failures.length) throw new AggregateError(failures, 'Repository operations failed while draining.');
                }
            );
        }
        return closing;
    }

    return {directory: repositoryDirectory, open, status, pull, push, close, drain: close, dispose: close};
}

function requireString(value, name) {
    if (!is.string(value) || value === '') throw new TypeError(`${name} must be a nonempty string.`);
}

function orderDirectoryOperation(directory, operation) {
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const previous = directoryOperations.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    function releaseQueue() {
        if (directoryOperations.get(key) === tail) directoryOperations.delete(key);
    }
    // Only the scheduling tail settles successfully after an error. Each caller
    // retains its complete failure; a later operation can retry the same path.
    const tail = result.then(releaseQueue, releaseQueue);
    directoryOperations.set(key, tail);
    return result;
}
