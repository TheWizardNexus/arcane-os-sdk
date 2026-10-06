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
