import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createRepositoryWorkspace, resolveArcaneDataPaths} from '../src/core/repositories.mjs';

const fixtures = fileURLToPath(new URL('../.arcane/core-repositories-fixtures/', import.meta.url));

async function fixture(t) {
    await mkdir(fixtures, {recursive: true});
    const directory = await mkdtemp(path.join(fixtures, 'case-'));
    t.after(
        async function removeFixture() {
            const relative = path.relative(fixtures, directory);
            assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
            await rm(directory, {recursive: true, force: true});
        }
    );
    return directory;
}

function deferred() {
    let resolve;
    const promise = new Promise(
        function hold(resolvePromise) {
            resolve = resolvePromise;
        }
    );
    return {promise, resolve};
}

function processResult(stdout = '', stderr = '') {
    return {code: 0, stdout, stderr};
}

test('native data paths preserve explicit roots and use the current platform convention without I/O', function dataPaths() {
    const explicit = path.resolve('selected moon cheese data');
    assert.deepEqual(
        resolveArcaneDataPaths({dataRoot: explicit}),
        {dataRoot: explicit, repositoriesRoot: path.join(explicit, 'Repos')}
    );
    let base;
    if (process.platform === 'win32') base = process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local');
    else if (process.platform === 'darwin') base = path.join(homedir(), 'Library', 'Application Support');
    else if (process.platform === 'linux') {
        const xdg = process.env.XDG_DATA_HOME;
        base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), '.local', 'share');
    } else {
        assert.throws(resolveArcaneDataPaths, {code: 'ARCANE_DATA_ROOT_REQUIRED'});
        return;
    }
    assert.deepEqual(
        resolveArcaneDataPaths(),
        {dataRoot: path.resolve(base, 'ArcaneData'), repositoriesRoot: path.resolve(base, 'ArcaneData', 'Repos')}
    );
});

test('explicit repository directory bypasses default selection and construction creates nothing', async function explicitDirectory(t) {
    const root = await fixture(t);
    const directory = path.join(root, 'existing choice');
    const repository = createRepositoryWorkspace({directory, name: '../ignored', dataRoot: null});
    assert.equal(repository.directory, directory);
    assert.deepEqual(await readdir(root), []);
    assert.equal(repository.close, repository.drain);
    assert.equal(repository.close, repository.dispose);
    await repository.close();
});

test('same-directory owners clone once with complete remote, branch and output, while distinct names stay distinct', async function oneClone(t) {
    const dataRoot = await fixture(t);
    const calls = [];
    const stdout = '  Complete clone output 🧀\r\nLast output line.\n';
    const stderr = '  Complete progress\rFinal progress.\n';
    const remote = 'https://example.invalid/Moon Cheese/dispatches.git';
    const branch = 'cheese-launch';
    async function run(command, args, options) {
        calls.push({command, args, options});
        if (args[0] === 'clone') {
            const destination = args[args.length - 1];
            await mkdir(destination);
            await writeFile(path.join(destination, '.git'), 'gitdir: application-selected-worktree\n');
            return processResult(stdout, stderr);
        }
        return processResult('true\n\n');
    }
    const first = createRepositoryWorkspace({name: 'moon-cheese', dataRoot, remote, branch, run});
    const second = createRepositoryWorkspace({name: 'moon-cheese', dataRoot, remote, branch, run});
    const other = createRepositoryWorkspace({name: 'moon-radishes', dataRoot, remote, run});
    assert.notEqual(first.directory, other.directory);
    const [created, reused] = await Promise.all([first.open(), second.open()]);
    assert.deepEqual(created, {directory: first.directory, cloned: true, stdout, stderr});
    assert.deepEqual(reused, {directory: first.directory, cloned: false});
    assert.deepEqual(calls[0].args, ['clone', '--progress', '--branch', branch, '--', remote, first.directory]);
    assert.equal(calls[0].command, 'git');
    assert.equal(calls[0].options.cwd, path.join(dataRoot, 'Repos'));
    assert.deepEqual(calls[1].args, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
    assert.deepEqual(await first.open(), {directory: first.directory, cloned: false});
    assert.equal(calls.length, 2);
    await Promise.all([first.close(), second.close(), other.close()]);
});

test('existing checkout keeps files and uses the public repository status, pull and dirty push paths', async function existingRepository(t) {
    const directory = await fixture(t);
    const content = '  Every authored line 🦑\r\nFinal line.  ';
    await writeFile(path.join(directory, 'moon.md'), content);
    const commands = [];
    let dirty = false;
    async function run(command, args, options) {
        commands.push(args);
        assert.equal(command, 'git');
        assert.equal(options.cwd, directory);
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return processResult('true\n\n');
        if (args[0] === 'rev-parse') return processResult(`${directory}\n`);
        if (args[0] === 'branch') return processResult('moon-main\n');
        if (args[0] === 'status') return processResult(dirty ? '## moon-main\n M moon.md\n' : '## moon-main\n');
        return processResult('Complete Git response.\n');
    }
    const repository = createRepositoryWorkspace({directory, remote: 'never-replace-origin', branch: 'never-switch', run});
    assert.deepEqual(await repository.open(), {directory, cloned: false});
    assert.equal((await repository.status()).branch, 'moon-main');
    assert.equal((await repository.pull()).action, 'pull');
    dirty = true;
    assert.equal((await repository.push()).action, 'push');
    assert.ok(commands.some(function pulled(args) { return args[0] === 'pull' && args[1] === '--ff-only'; }));
    assert.ok(commands.some(function pushed(args) { return args[0] === 'push'; }));
    assert.equal(commands.filter(function inspected(args) { return args[1] === '--is-inside-work-tree'; }).length, 1);
    assert.equal(await readFile(path.join(directory, 'moon.md'), 'utf8'), content);
    await repository.close();
});

test('bare caches and ancestor checkouts remain untouched', async function distinctRepositoryRole(t) {
    const directory = await fixture(t);
    await writeFile(path.join(directory, 'keep.txt'), 'Keep every character.\n');
    for (const stdout of ['false\n\n', 'true\nnested/\n']) {
        let calls = 0;
        async function run() {
            calls += 1;
            return processResult(stdout);
        }
        const repository = createRepositoryWorkspace({directory, remote: 'unchanged', run});
        await assert.rejects(repository.open(), {code: 'ARCANE_REPOSITORY_DIRECTORY_INVALID'});
        assert.equal(calls, 1);
        assert.equal(await readFile(path.join(directory, 'keep.txt'), 'utf8'), 'Keep every character.\n');
        await repository.close();
    }
});

test('pre-aborted calls do no work and closing drains accepted queued operations', async function drainingQueue(t) {
    const root = await fixture(t);
    const directory = path.join(root, 'repository');
    const started = deferred();
    const released = deferred();
    let calls = 0;
    async function run() {
        calls += 1;
        started.resolve();
        await released.promise;
        return processResult();
    }
    const repository = createRepositoryWorkspace({directory, remote: 'complete remote', run});
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(repository.open({signal: cancelled.signal}), {code: 'ARCANE_CANCELLED'});
    assert.equal(calls, 0);
    assert.deepEqual(await readdir(root), []);
    const first = repository.open();
    const second = repository.open();
    await started.promise;
    const closing = repository.close();
    assert.equal(repository.dispose(), closing);
    await assert.rejects(repository.open(), {code: 'CORE_CLOSING'});
    let closed = false;
    closing.then(function recordClosed() { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    released.resolve();
    await Promise.all([first, second, closing]);
    assert.equal(calls, 1);
    assert.equal(closed, true);
});

test('active cancellation passes to the process owner and close joins its failure and retained output', async function cancellationDrain(t) {
    const root = await fixture(t);
    const directory = path.join(root, 'repository');
    const started = deferred();
    const released = deferred();
    const controller = new AbortController();
    const failure = new Error('Complete process cancellation detail.\nFinal line.');
    async function run(command, args, {signal}) {
        assert.equal(signal, controller.signal);
        await mkdir(directory);
        await writeFile(path.join(directory, 'partial.txt'), 'Preserved clone state.');
        started.resolve();
        await released.promise;
        assert.equal(signal.aborted, true);
        throw failure;
    }
    const repository = createRepositoryWorkspace({directory, remote: 'complete remote', run});
    const opened = repository.open({signal: controller.signal});
    await started.promise;
    controller.abort();
    const closing = repository.close();
    const observedOpen = assert.rejects(opened, function sameError(error) { return error === failure; });
    const observedClose = assert.rejects(closing, function retainedFailure(error) {
        assert.deepEqual(error.errors, [failure]);
        return true;
    });
    released.resolve();
    await Promise.all([observedOpen, observedClose]);
    assert.equal(await readFile(path.join(directory, 'partial.txt'), 'utf8'), 'Preserved clone state.');
});

test('writer snapshots exact text and selected paths, retains clone output and scopes its commit', async function exactWriter(t) {
    const root = await fixture(t);
    const directory = path.join(root, 'connected repository');
    const started = deferred();
    const released = deferred();
    const calls = [];
    const content = '\uFEFF  Moon cheese 🧀\r\nNUL:\0\nFinal line.  ';
    const message = '  Complete moon dispatch\n\nLast authored line.  ';
    const filename = 'dispatches/moon [cheese].md';
    const files = [{path: filename, content}];
    async function run(command, args, options) {
        calls.push({command, args, cwd: options.cwd});
        if (args[0] === 'clone') {
            await mkdir(directory);
            started.resolve();
            await released.promise;
        }
        if (args.includes('commit')) {
            const chunks = [];
            for await (const chunk of options.input) chunks.push(chunk);
            assert.deepEqual(chunks, [message]);
        }
        await options.onOutput({stream: 'stdout', chunk: `Complete ${args[0]} output 🦑\r\n`});
        await options.onOutput({stream: 'stderr', chunk: 'Complete diagnostic.\n'});
        return {code: 0, signal: null, stdout: null, stderr: null};
    }
    const repository = createRepositoryWorkspace({directory, remote: 'selected-remote', run});
    const operation = repository.write({files, message});
    files[0].path = 'wrong.md';
    files[0].content = 'Wrong replacement.';
    files.push({path: 'also-wrong.md', content: 'Wrong extra.'});
    repository.directory = path.join(root, 'wrong connection');
    await started.promise;
    released.resolve();
    const result = await operation;
    assert.equal(result.directory, directory);
    assert.equal(result.state, 'pushed');
    assert.equal(result.stage, 'complete');
    assert.deepEqual(result.paths, [filename]);
    assert.deepEqual(result.writtenPaths, [filename]);
    assert.deepEqual([result.written, result.staged, result.committed, result.pushed], [true, true, true, true]);
    assert.equal(await readFile(path.join(directory, filename), 'utf8'), content);
    assert.deepEqual(await readdir(directory), ['dispatches']);
    assert.deepEqual(calls.map(function command(record) { return record.args; }), [
        ['clone', '--progress', '--', 'selected-remote', directory],
        ['--literal-pathspecs', 'add', '--', filename],
        ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim', '--file', '-', '--', filename],
        ['push']
    ]);
    assert.equal(calls[0].cwd, root);
    assert.ok(calls.slice(1).every(function selectedWorkingPath(call) { return call.cwd === directory; }));
    assert.deepEqual(result.outputs.map(function stage(output) { return output.stage; }), ['prepare', 'stage', 'commit', 'push']);
    assert.equal(result.outputs[0].stdout, 'Complete clone output 🦑\r\n');
    assert.ok(result.outputs.every(function complete(output) { return output.stderr === 'Complete diagnostic.\n' && output.code === 0; }));
    await repository.close();
});

test('writer retains earlier successful files and original filesystem failure without staging', async function partialLocalWrite(t) {
    const directory = await fixture(t);
    await mkdir(path.join(directory, 'not-a-file'));
    const calls = [];
    async function run(command, args) {
        calls.push(args);
        return processResult('true\n\n');
    }
    const repository = createRepositoryWorkspace({directory, run});
    await assert.rejects(
        repository.write({files: [{path: 'first.md', content: 'Every first line.\n'}, {path: 'not-a-file', content: 'Second file.'}], message: 'Selected files'}),
        function failedWrite(error) {
            assert.ok(error.cause instanceof Error);
            assert.equal(error.details.state, 'uncertain');
            assert.equal(error.details.stage, 'write');
            assert.equal(error.details.path, 'not-a-file');
            assert.deepEqual(error.details.writtenPaths, ['first.md']);
            assert.deepEqual([error.details.written, error.details.staged, error.details.committed, error.details.pushed], [false, false, false, false]);
            return true;
        }
    );
    assert.equal(await readFile(path.join(directory, 'first.md'), 'utf8'), 'Every first line.\n');
    assert.equal(calls.length, 1);
    await repository.close();
});

test('writer preserves commit completion when cancelled before push', async function committedCancellation(t) {
    const directory = await fixture(t);
    await writeFile(path.join(directory, 'existing.md'), 'Existing file.');
    const controller = new AbortController();
    const calls = [];
    async function run(command, args) {
        calls.push(args);
        if (args[0] === 'rev-parse') return processResult('true\n\n');
        if (args.includes('commit')) controller.abort();
        return processResult('Confirmed complete process.\n');
    }
    const repository = createRepositoryWorkspace({directory, run});
    await assert.rejects(
        repository.write({files: [{path: 'selected.md', content: 'Complete text.'}], message: 'Complete message', signal: controller.signal}),
        function committedBeforeCancellation(error) {
            assert.equal(error.code, 'ARCANE_CANCELLED');
            assert.equal(error.details.state, 'committed');
            assert.equal(error.details.committed, true);
            assert.equal(error.details.pushed, false);
            return true;
        }
    );
    assert.equal(calls.some(function pushed(args) { return args[0] === 'push'; }), false);
    await repository.close();
});

test('writer retains confirmed push despite later observer failure and keeps full output', async function pushedObserverFailure(t) {
    const directory = await fixture(t);
    await writeFile(path.join(directory, 'existing.md'), 'Existing file.');
    const failure = new Error('Complete observer failure.\nFinal line.');
    failure.details = {code: 0, signal: null, stdout: null, stderr: null};
    async function run(command, args, options) {
        if (args[0] === 'rev-parse') return processResult('true\n\n');
        if (args[0] === 'push') {
            await options.onOutput({stream: 'stdout', chunk: 'Complete remote acknowledgement.\n'});
            await options.onOutput({stream: 'stderr', chunk: 'Complete push diagnostic.\n'});
            throw failure;
        }
        return processResult();
    }
    const repository = createRepositoryWorkspace({directory, run});
    await assert.rejects(
        repository.write({files: [{path: 'selected.md', content: 'Complete text.'}], message: 'Complete message'}),
        function pushedBeforeObserverError(error) {
            assert.equal(error.cause, failure);
            assert.equal(error.details.state, 'pushed');
            assert.equal(error.details.committed, true);
            assert.equal(error.details.pushed, true);
            assert.deepEqual(error.details.outputs[3], {
                stage: 'push', stdout: 'Complete remote acknowledgement.\n',
                stderr: 'Complete push diagnostic.\n', code: 0, signal: null
            });
            return true;
        }
    );
    await repository.close();
});

test('writer distinguishes pre-spawn observer failure from interrupted commit and uncertain push', async function uncertainOperations(t) {
    for (const selected of ['pre-start', 'commit', 'push']) {
        const directory = await fixture(t);
        await writeFile(path.join(directory, 'existing.md'), 'Existing file.');
        const failure = new Error('Complete operation failure.\nFinal line.');
        if (selected !== 'pre-start') {
            failure.code = 'ARCANE_PREREQUISITE_MISSING';
            failure.details = {code: 1, signal: null, stdout: '', stderr: 'Complete partial process diagnostics.\n'};
        }
        function onEvent(event) {
            if (selected === 'pre-start' && event.stage === 'commit') throw 'Complete thrown observer value.';
        }
        async function run(command, args, options) {
            if (args[0] === 'rev-parse') return processResult('true\n\n');
            if (selected === 'pre-start' && args.includes('commit')) {
                try {
                    await options.onEvent({type: 'process.starting', stage: 'commit'});
                } catch (cause) {
                    throw new Error('The event callback failed: Complete thrown observer value.', {cause});
                }
            }
            if ((selected === 'commit' && args.includes('commit')) || (selected === 'push' && args[0] === 'push')) throw failure;
            return processResult();
        }
        const repository = createRepositoryWorkspace({directory, run, onEvent});
        await assert.rejects(
            repository.write({files: [{path: 'selected.md', content: 'Complete text.'}], message: 'Complete message'}),
            function actualOutcome(error) {
                assert.equal(error.details.state, selected === 'pre-start' ? 'local' : 'uncertain');
                assert.equal(error.details.committed, selected === 'push');
                assert.equal(error.details.pushed, false);
                if (selected !== 'pre-start') {
                    assert.equal(error.cause, failure);
                    assert.equal(error.details.outputs[error.details.outputs.length - 1].stderr, failure.details.stderr);
                }
                return true;
            }
        );
        await repository.close();
    }
});
