import {mkdir, readdir, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import Is from 'strong-type';
import {ArcaneError, throwIfAborted} from '../errors.mjs';
import {runProcess} from '../process.mjs';
import {captureRepositoryTarget, repositoryConfiguration, repositoryPull, repositoryPush,
    repositoryPushArguments, repositoryStatus} from '../repository.mjs';
import {createGitIdentityRunner} from '../git-identity.mjs';

export {readGitIdentity} from '../git-identity.mjs';

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
    {name, directory, dataRoot, remote, branch, gitIdentity, onEvent, run = runProcess} = {}
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
    const execute = createGitIdentityRunner(run, gitIdentity);
    const repositoryDirectory = path.resolve(selected);
    const pending = new Set();
    let opened = false;
    let closing = null;

    async function prepare(signal, prepareRun = execute) {
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
            const result = await prepareRun(
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
        const result = await prepareRun(
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
                return repositoryStatus({workspaceRoot: repositoryDirectory, signal, onEvent, run: execute});
            },
            signal
        );
    }

    function configuration({signal} = {}) {
        return accept(
            function readRepositoryConfiguration() {
                return repositoryConfiguration({workspaceRoot: repositoryDirectory, signal, onEvent, run: execute});
            },
            signal
        );
    }

    function pull({target, signal} = {}) {
        let selectedTarget;
        try { selectedTarget = captureRepositoryTarget(target); }
        catch (error) { return Promise.reject(error); }
        return accept(
            async function pullRepository() {
                await prepare(signal);
                return repositoryPull({workspaceRoot: repositoryDirectory, target: selectedTarget, signal, onEvent, run: execute});
            },
            signal
        );
    }

    function push({target, signal} = {}) {
        let selectedTarget;
        try { selectedTarget = captureRepositoryTarget(target); }
        catch (error) { return Promise.reject(error); }
        return accept(
            async function pushRepository() {
                await prepare(signal);
                return repositoryPush({workspaceRoot: repositoryDirectory, target: selectedTarget, signal, onEvent, run: execute});
            },
            signal
        );
    }

    function write({files, message, target, signal} = {}) {
        let selectedFiles;
        let selectedTarget;
        try {
            selectedTarget = captureRepositoryTarget(target);
            requireString(message, 'message');
            if (!message.isWellFormed()) throw new TypeError('message cannot be represented completely as UTF-8 text.');
            if (!is.array(files) || files.length === 0) {
                throw new TypeError('write requires at least one explicitly selected file.');
            }
            selectedFiles = Array.from(
                files,
                function snapshotFile(file) {
                    const {path: filename, content} = file;
                    requireString(filename, 'file.path');
                    if (!filename.isWellFormed() || filename.includes('\0')) {
                        throw new TypeError('file.path cannot be represented completely as a native filename.');
                    }
                    if (!is.string(content) || !content.isWellFormed()) {
                        throw new TypeError('file.content must be complete UTF-8-representable text.');
                    }
                    const destination = path.resolve(repositoryDirectory, filename);
                    const relative = path.relative(repositoryDirectory, destination);
                    const first = relative.split(path.sep)[0];
                    if (path.isAbsolute(filename) || !relative || relative === '..'
                        || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
                        || first.toLowerCase() === '.git') {
                        throw new TypeError('file.path must name a working file relative to this repository, outside Git metadata.');
                    }
                    return {path: filename, content, destination};
                }
            );
        } catch (error) {
            return Promise.reject(error);
        }

        return accept(
            async function writeRepositoryFiles() {
                const outcome = {
                    directory: repositoryDirectory,
                    ...(selectedTarget === undefined ? {} : {target: {...selectedTarget}}),
                    state: 'local',
                    stage: 'prepare',
                    paths: selectedFiles.map(function selectedPath(file) { return file.path; }),
                    writtenPaths: [],
                    written: false,
                    staged: false,
                    committed: false,
                    pushed: false,
                    outputs: []
                };
                let pendingWrite = false;

                async function executeGit(stage, args, input, options = {}) {
                    throwIfAborted(signal);
                    outcome.stage = stage;
                    const output = {stage, stdout: '', stderr: ''};
                    const observed = {stdout: false, stderr: false};
                    outcome.outputs.push(output);
                    let beforeStartFailed = false;

                    function consumeOutput({stream, chunk}) {
                        observed[stream] = true;
                        output[stream] += chunk;
                    }

                    async function observeEvent(event) {
                        try {
                            await onEvent?.(event);
                        } catch (error) {
                            if (event.type === 'process.starting') beforeStartFailed = true;
                            throw error;
                        }
                    }

                    function recordCompletion(result) {
                        if (!result || !is.integer(result.code)) return;
                        output.code = result.code;
                        output.signal = result.signal ?? null;
                        for (const stream of ['stdout', 'stderr']) {
                            if (!observed[stream] && is.string(result[stream])) output[stream] = result[stream];
                        }
                        if (result.code !== 0) return;
                        if (stage === 'stage') outcome.staged = true;
                        if (stage === 'commit') {
                            outcome.committed = true;
                            outcome.state = 'committed';
                        }
                        if (stage === 'push') {
                            outcome.pushed = true;
                            outcome.state = 'pushed';
                        }
                    }

                    try {
                        const result = await execute(
                            'git',
                            args,
                            {cwd: options.cwd ?? repositoryDirectory, signal, onEvent: observeEvent,
                                onOutput: consumeOutput, captureOutput: false, input}
                        );
                        recordCompletion(result);
                        if (result.code !== 0) {
                            throw new ArcaneError(
                                'ARCANE_OPERATION_FAILED',
                                `Git ${stage} exited with code ${String(result.code)}.`,
                                {details: result}
                            );
                        }
                        return {...result, stdout: output.stdout, stderr: output.stderr};
                    } catch (error) {
                        if (!beforeStartFailed) recordCompletion(error?.details);
                        const notStarted = beforeStartFailed
                            || (error?.code === 'ARCANE_PREREQUISITE_MISSING' && !error?.details)
                            || (error?.code === 'ARCANE_CANCELLED' && !error?.details);
                        if (!notStarted && output.code !== 0 && (stage === 'commit' || stage === 'push')) {
                            outcome.state = 'uncertain';
                        }
                        throw error;
                    }
                }

                async function* commitMessage() {
                    yield message;
                }

                try {
                    await prepare(
                        signal,
                        function prepareGit(command, args, options) {
                            return executeGit('prepare', args, undefined, options);
                        }
                    );
                    outcome.stage = 'write';
                    for (const file of selectedFiles) {
                        throwIfAborted(signal);
                        outcome.path = file.path;
                        await mkdir(path.dirname(file.destination), {recursive: true});
                        throwIfAborted(signal);
                        pendingWrite = true;
                        await writeFile(file.destination, file.content, {encoding: 'utf8', signal});
                        pendingWrite = false;
                        outcome.writtenPaths.push(file.path);
                    }
                    outcome.written = true;
                    delete outcome.path;
                    await executeGit('stage', ['--literal-pathspecs', 'add', '--', ...outcome.paths]);
                    await executeGit(
                        'commit',
                        ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim', '--file', '-', '--', ...outcome.paths],
                        commitMessage()
                    );
                    await executeGit('push', repositoryPushArguments(selectedTarget));
                    outcome.stage = 'complete';
                    return outcome;
                } catch (cause) {
                    if (pendingWrite) outcome.state = 'uncertain';
                    throw new ArcaneError(
                        cause?.code ?? 'ARCANE_REPOSITORY_WRITE_FAILED',
                        cause instanceof Error ? cause.message : String(cause),
                        {cause, details: outcome, exitCode: cause?.exitCode}
                    );
                }
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

    return {directory: repositoryDirectory, open, status, configuration, pull, push, write, close, drain: close, dispose: close};
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
