import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from '../src/testing.mjs';
import {createRepositoryWorkspace, readGitIdentity, resolveArcaneDataPaths} from '../src/core/repositories.mjs';
import {createGitIdentityRunner} from '../src/git-identity.mjs';
import {ArcaneError} from '../src/errors.mjs';

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

test('Git identity observations distinguish global, local, effective, empty and unset configuration', async function scopedIdentity() {
    const directory = path.resolve('moon-cheese-repository');
    const name = '  Moon Cheese\nDispatcher 🧀  ';
    const signal = new AbortController().signal;
    let observing = false;
    const events = [];
    async function onEvent(event) {
        assert.equal(observing, false);
        observing = true;
        events.push(event);
        await Promise.resolve();
        observing = false;
    }
    const calls = [];
    async function run(command, args, options) {
        calls.push(args);
        assert.equal(command, 'git');
        assert.equal(options.cwd, directory);
        assert.equal(options.signal, signal);
        assert.equal(options.allowNonzero, true);
        assert.deepEqual(options.outputEncoding, {stdout: null});
        assert.deepEqual(options.captureOutput, {stdout: false});
        assert.deepEqual(options.emitOutputEvents, {stdout: false});
        assert.deepEqual(args.slice(-4), ['--includes', '--null', '--get-regexp', '^(user[.](name|email)|github[.]user)$']);
        const output = args.includes('--global')
            ? `user.name\nEarlier value\0user.name\n${name}\0user.email\n\0github.user\nmoon-account\0`
            : args.includes('--local') ? `user.name\n${name}\0`
                : `user.name\n${name}\0user.email\n\0github.user\nmoon-account\0`;
        await options.onOutput({stream: 'stdout', chunk: Buffer.from(output)});
        await options.onEvent({type: 'process.completed', message: 'Complete scope observation.', data: {scope: args[1]}});
        return processResult(null);
    }
    assert.deepEqual(await readGitIdentity({directory, signal, onEvent, run}), {
        global: {name, email: '', githubUser: 'moon-account'},
        local: {name, email: null, githubUser: null},
        effective: {name, email: '', githubUser: 'moon-account'}
    });
    assert.equal(calls.length, 3);
    assert.equal(events.length, 3);
    assert.equal(observing, false);
});

test('identity decoding preserves split UTF-8 and BOM values and retains undecodable output', async function rawIdentity() {
    const chunks = [Buffer.from('user.name\n\uFEFF Moon '), Buffer.from([0xf0, 0x9f]),
        Buffer.from([0xa7, 0x80]), Buffer.from('\n \0user.email\n\0')];
    async function valid(command, args, options) {
        for (const chunk of chunks) await options.onOutput({stream: 'stdout', chunk});
        await options.onOutput({stream: 'stderr', chunk: 'Complete diagnostic\n'});
        return processResult(null, 'Complete diagnostic\n');
    }
    assert.deepEqual(await readGitIdentity({run: valid}), {
        global: {name: '\uFEFF Moon 🧀\n ', email: '', githubUser: null}, local: null, effective: null
    });
    const invalid = [Buffer.from('user.name\nBefore '), Buffer.from([0x80]), Buffer.from(' after\0')];
    const result = processResult(null, 'Complete diagnostic\n');
    await assert.rejects(readGitIdentity({run: async function undecodable(command, args, options) {
        for (const chunk of invalid) await options.onOutput({stream: 'stdout', chunk});
        return result;
    }}), function complete(error) {
        assert.equal(error.code, 'ARCANE_GIT_IDENTITY_NOT_TEXT');
        assert.equal(error.details, result);
        assert.ok(error.cause instanceof TypeError);
        assert.deepEqual(error.rawStdout, Buffer.concat(invalid));
        return true;
    });
    const controller = new AbortController();
    await assert.rejects(readGitIdentity({signal: controller.signal,
        run: async function cancelled(command, args, options) {
            for (const chunk of chunks) await options.onOutput({stream: 'stdout', chunk});
            controller.abort('Caller cancelled after output.');
            return result;
        }
    }), function cancelledOutput(error) {
        assert.equal(error.code, 'ARCANE_CANCELLED');
        assert.equal(error.details, result);
        assert.equal(error.cause, 'Caller cancelled after output.');
        assert.deepEqual(error.rawStdout, Buffer.concat(chunks));
        return true;
    });
});

test('identity discovery retains wrapped observer failures once and preserves independent siblings', async function wrappedIdentityFailure() {
    const observerFailure = new Error('Complete observer failure.');
    const result = processResult(null, 'Complete process diagnostic\n');
    const raw = Buffer.from('user.name\nMoon dispatcher\0');
    const failure = new ArcaneError('ARCANE_OPERATION_FAILED', observerFailure.message,
        {cause: observerFailure, details: result});
    failure.errors = [observerFailure];
    async function run(command, args, options) {
        await options.onOutput({stream: 'stdout', chunk: raw});
        try { await options.onEvent({type: 'process.completed', message: 'Scope finished.'}); }
        catch (error) { assert.equal(error, observerFailure); throw failure; }
        assert.fail('Observer failure must reach the process owner.');
    }
    function onEvent() { throw observerFailure; }
    await assert.rejects(readGitIdentity({run, onEvent}), function original(error) {
        assert.equal(error, failure);
        assert.equal(error.code, 'ARCANE_OPERATION_FAILED');
        assert.equal(error.details, result);
        assert.equal(error.cause, observerFailure);
        assert.deepEqual(error.errors, [observerFailure]);
        assert.deepEqual(error.rawStdout, raw);
        return true;
    });
    const cancellation = new ArcaneError('ARCANE_CANCELLED', 'Caller cancelled.', {details: result, exitCode: 130});
    const combined = new ArcaneError(cancellation.code, cancellation.message,
        {cause: cancellation, details: result, exitCode: cancellation.exitCode});
    combined.errors = [cancellation, observerFailure];
    const sibling = new Error('Independent local configuration failure.');
    await assert.rejects(readGitIdentity({directory: path.resolve('moon-repository'), onEvent,
        run: async function concurrent(command, args, options) {
            if (args.includes('--local')) throw sibling;
            if (!args.includes('--global')) return processResult(null);
            await options.onOutput({stream: 'stdout', chunk: raw});
            try { await options.onEvent({type: 'process.cancelled', message: 'Scope cancelled.'}); }
            catch (error) { assert.equal(error, observerFailure); throw combined; }
        }
    }), function distinct(error) {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [combined, sibling]);
        assert.equal(combined.cause, cancellation);
        assert.equal(combined.details, result);
        assert.deepEqual(combined.rawStdout, raw);
        return true;
    });
});

test('identity raw diagnostics preserve existing error properties and nested observer causes', async function existingRawDiagnostics() {
    const originalOutput = Buffer.from('Original caller-owned output.');
    const details = processResult(null, 'Complete original diagnostic.');
    const observerFailure = new ArcaneError('ARCANE_OPERATION_FAILED', 'Original observer failure.', {details});
    Object.defineProperty(observerFailure, 'rawStdout', {value: originalOutput});
    function onEvent() { throw observerFailure; }
    await assert.rejects(readGitIdentity({onEvent, run: async function beforeSpawn(command, args, options) {
        await options.onEvent({type: 'process.starting', message: 'Before spawn.'});
        assert.fail('The process cannot start after the observer failure.');
    }}), function originalCause(error) {
        assert.ok(error instanceof ArcaneError);
        assert.equal(error.cause, observerFailure);
        assert.equal(error.code, observerFailure.code);
        assert.equal(error.details, details);
        assert.equal(error.exitCode, observerFailure.exitCode);
        assert.deepEqual(error.rawStdout, Buffer.from(''));
        assert.equal(observerFailure.rawStdout, originalOutput);
        return true;
    });
    const processFailure = new ArcaneError(observerFailure.code, observerFailure.message,
        {cause: observerFailure, details});
    processFailure.errors = [observerFailure];
    let propertyReads = 0;
    Object.defineProperty(processFailure, 'rawStdout', {get: function unavailableProperty() {
        propertyReads += 1;
        throw new Error('The original property must remain unread.');
    }});
    const output = Buffer.from('user.name\nComplete raw observation\0');
    await assert.rejects(readGitIdentity({onEvent, run: async function wrapped(command, args, options) {
        await options.onOutput({stream: 'stdout', chunk: output});
        try { await options.onEvent({type: 'process.completed', message: 'After spawn.'}); }
        catch (error) { assert.equal(error, observerFailure); throw processFailure; }
    }}), function nestedCause(error) {
        assert.ok(error instanceof ArcaneError);
        assert.equal(error.cause, processFailure);
        assert.equal(error.details, details);
        assert.equal(error.code, processFailure.code);
        assert.deepEqual(error.rawStdout, output);
        assert.equal(error.cause.cause, observerFailure);
        assert.deepEqual(error.cause.errors, [observerFailure]);
        assert.equal(propertyReads, 0);
        return true;
    });
});

test('global-only identity reads preserve unset values and complete rejected failures', async function identityFailures() {
    let calls = 0;
    const empty = await readGitIdentity({run: async function absent(command, args, options) {
        calls += 1;
        assert.equal(options.cwd, undefined);
        assert.ok(args.includes('--global'));
        return {code: 1, stdout: null, stderr: ''};
    }});
    assert.equal(calls, 1);
    assert.deepEqual(empty, {global: {name: null, email: null, githubUser: null}, local: null, effective: null});
    const failure = new Error('Complete observer failure\nwith original diagnostics.');
    failure.details = {code: 1, stdout: 'Complete output.', stderr: 'Complete diagnostic.'};
    await assert.rejects(readGitIdentity({run: async function rejected() { throw failure; }}),
        function original(error) { return error === failure; });
    const output = Buffer.from('  Entire output\n');
    const result = {code: 3, stdout: null, stderr: 'Entire configuration failure\n'};
    await assert.rejects(readGitIdentity({run: async function invalidConfig(command, args, options) {
        await options.onOutput({stream: 'stdout', chunk: output});
        return result;
    }}), function complete(error) {
        assert.deepEqual(error.rawStdout, output);
        return error.code === 'ARCANE_OPERATION_FAILED' && error.details === result;
    });
    const controller = new AbortController();
    controller.abort('Caller cancelled.');
    await assert.rejects(readGitIdentity({signal: controller.signal, run: function never() { assert.fail('No process may start.'); }}),
        {code: 'ARCANE_CANCELLED'});
});

test('identity discovery joins each accepted observation and preserves sibling failures', async function joinedIdentity() {
    const gate = deferred();
    const failure = new Error('Complete global failure.');
    const localFailure = new Error('Complete local failure.');
    let effectiveFinished = false;
    const reading = readGitIdentity({directory: path.resolve('moon-repository'), run: async function observe(command, args) {
        if (args.includes('--global')) throw failure;
        if (args.includes('--local')) throw localFailure;
        await gate.promise;
        effectiveFinished = true;
        return processResult(null);
    }});
    const rejected = assert.rejects(reading, function everyFailure(error) {
        assert.equal(effectiveFinished, true);
        assert.deepEqual(error.errors, [failure, localFailure]);
        return true;
    });
    gate.resolve();
    await rejected;
});

test('Git identity selection captures strings and preserves runner controls and inherited fields', function selectedIdentity() {
    const calls = [];
    const result = Promise.resolve(processResult('Complete result.'));
    function run(command, args, options) { calls.push({command, args, options}); return result; }
    assert.equal(createGitIdentityRunner(run), run);
    assert.equal(createGitIdentityRunner(run, {}), run);
    const identity = {name: '  Moon Dispatcher 🧀  ', username: ''};
    const selected = createGitIdentityRunner(run, identity);
    identity.name = 'Another connection';
    const options = {
        env: {GIT_AUTHOR_NAME: 'old author', GIT_COMMITTER_NAME: 'old committer',
            GIT_AUTHOR_EMAIL: 'retained@example.invalid', GIT_AUTHOR_DATE: 'retained date', EXTRA: 'complete'},
        signal: new AbortController().signal, onOutput() {}, onEvent() {},
        input: {complete: 'original'}, captureOutput: false, emitOutputEvents: false, outputEncoding: {stdout: null}
    };
    assert.equal(selected('git', ['commit'], options), result);
    assert.deepEqual(calls[0].args, ['-c', 'user.name=  Moon Dispatcher 🧀  ', '-c', 'credential.username=', 'commit']);
    assert.deepEqual(calls[0].options, {...options, env: {...options.env,
        GIT_AUTHOR_NAME: '  Moon Dispatcher 🧀  ', GIT_COMMITTER_NAME: '  Moon Dispatcher 🧀  '}});
    assert.equal(calls[0].options.input, options.input);
    assert.equal(calls[0].options.onOutput, options.onOutput);
    assert.equal(options.env.GIT_AUTHOR_NAME, 'old author');
    const usernameOnly = createGitIdentityRunner(run, {username: 'moon-account'});
    usernameOnly('git', ['fetch'], options);
    assert.equal(calls[1].options, options);
    assert.throws(function nulArgument() { createGitIdentityRunner(run, {name: 'Moon\0Cheese'}); }, TypeError);
});

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

test(
    'long-path selection requires a boolean without starting repository work',
    function longPathInput() {
        const directory = path.resolve('moon-cheese-long-path-selection');
        function unexpectedProcess() {
            assert.fail('Construction must not start Git.');
        }
        for (const longPaths of [null, 'true', 'false', 0, 1, {}, []]) {
            assert.throws(
                function invalidLongPaths() {
                    createRepositoryWorkspace(
                        {directory, longPaths, run: unexpectedProcess}
                    );
                },
                {name: 'TypeError', message: 'longPaths must be a boolean when supplied.'}
            );
        }
    }
);

test(
    'new checkouts capture explicit long-path selection only for Windows clone configuration',
    async function cloneLongPaths(t) {
        const root = await fixture(t);
        const remote = 'https://example.invalid/Moon Cheese/dispatches.git';
        const branch = 'cheese-launch';
        const stdout = '\uFEFF  Complete clone output 🧀\r\nLast output line.\n';
        const stderr = '  Complete progress\rFinal progress.\n';
        const cases = [
            {name: 'enabled', longPaths: true},
            {name: 'disabled', longPaths: false},
            {name: 'omitted'}
        ];
        for (const selection of cases) {
            for (const existingEmpty of [false, true]) {
                const directory = path.join(root, `${selection.name}-${existingEmpty ? 'empty' : 'missing'}`);
                if (existingEmpty) await mkdir(directory);
                const calls = [];
                const controller = new AbortController();
                function observeEvent() {}
                async function fakeClone(command, args, options) {
                    calls.push({command, args, options});
                    await mkdir(directory, {recursive: true});
                    await writeFile(path.join(directory, '.git'), 'gitdir: selected-moon-checkout\n');
                    return processResult(stdout, stderr);
                }
                const options = {directory, remote, branch, onEvent: observeEvent, run: fakeClone};
                if (selection.longPaths !== undefined) options.longPaths = selection.longPaths;
                const repository = createRepositoryWorkspace(options);
                assert.equal(repository.directory, directory);
                assert.equal(calls.length, 0);
                options.directory = path.join(root, 'later-directory');
                options.remote = 'later-remote';
                options.branch = 'later-branch';
                options.longPaths = selection.longPaths !== true;

                const result = await repository.open({signal: controller.signal});
                const expected = ['clone', '--progress'];
                if (process.platform === 'win32' && selection.longPaths !== undefined) {
                    expected.push('--config', `core.longpaths=${selection.longPaths}`);
                }
                expected.push('--branch', branch, '--', remote, directory);
                assert.deepEqual(
                    result,
                    {directory, cloned: true, stdout, stderr}
                );
                assert.equal(calls.length, 1);
                assert.equal(calls[0].command, 'git');
                assert.deepEqual(calls[0].args, expected);
                assert.equal(calls[0].options.cwd, root);
                assert.equal(calls[0].options.signal, controller.signal);
                assert.equal(calls[0].options.onEvent, observeEvent);
                assert.deepEqual(
                    await repository.open(),
                    {directory, cloned: false}
                );
                assert.equal(calls.length, 1);
                await repository.close();
            }
        }
    }
);

test(
    'explicit long-path selections leave existing checkout configuration and content unchanged',
    async function existingLongPaths(t) {
        const directory = await fixture(t);
        const configuration = '[core]\n\tlongpaths = false\n[remote "origin"]\n\turl = selected-origin\n';
        const content = '\uFEFF  Complete authored moon dispatch 🧀\r\n';
        const gitDirectory = path.join(directory, '.git');
        await mkdir(gitDirectory);
        await writeFile(path.join(gitDirectory, 'config'), configuration);
        await writeFile(path.join(directory, 'moon.md'), content);
        for (const longPaths of [true, false]) {
            const calls = [];
            async function fakeExistingRoot(command, args, options) {
                calls.push({command, args, options});
                return processResult('true\n\n');
            }
            const repository = createRepositoryWorkspace(
                {directory, remote: 'never-replace-origin', branch: 'never-switch', longPaths, run: fakeExistingRoot}
            );
            assert.deepEqual(
                await repository.open(),
                {directory, cloned: false}
            );
            assert.equal(calls.length, 1);
            assert.equal(calls[0].command, 'git');
            assert.deepEqual(
                calls[0].args,
                ['rev-parse', '--is-inside-work-tree', '--show-prefix']
            );
            assert.equal(calls[0].options.cwd, directory);
            assert.equal(await readFile(path.join(gitDirectory, 'config'), 'utf8'), configuration);
            assert.equal(await readFile(path.join(directory, 'moon.md'), 'utf8'), content);
            await repository.close();
        }
    }
);

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

test('configuration observes selected branch and remote arrays without preparing a checkout', async function configurationObservation(t) {
    const root = await fixture(t);
    const directory = path.join(root, 'uncreated checkout');
    const calls = [];
    const originUrl = '\uFEFFhttps://example.invalid/moon\ncomplete-locator.git';
    const upstreamUrl = 'https://example.invalid/relay.git';
    async function run(command, args, options) {
        calls.push(args);
        assert.equal(command, 'git');
        assert.equal(options.cwd, directory);
        assert.deepEqual(options.outputEncoding, {stdout: null});
        let stdout;
        if (args[0] === 'rev-parse') stdout = 'true\n\n';
        else if (args[0] === 'symbolic-ref') stdout = 'refs/heads/moon.release+dispatch\n';
        else if (calls.length === 3) {
            assert.equal(args.at(-1), '^branch\\.moon\\.release\\+dispatch[.](remote|merge)$');
            stdout = 'branch.moon.release+dispatch.remote\nearlier\0branch.moon.release+dispatch.remote\nmoon+relay\0'
                + 'branch.moon.release+dispatch.merge\nrefs/heads/main\0branch.moon.release+dispatch.merge\nrefs/heads/other\0';
        } else {
            assert.equal(args.at(-1), '^remote[.](origin|moon\\+relay)[.](url|pushurl)$');
            stdout = `remote.origin.url\n${originUrl}\0remote.origin.url\n\0remote.origin.pushurl\n\0`
                + `remote.moon+relay.url\n${upstreamUrl}\0remote.moon+relay.url\n${upstreamUrl}\0`;
        }
        await options.onOutput({stream: 'stdout', chunk: Buffer.from(stdout)});
        return processResult(null, 'Complete observation diagnostic.\n');
    }
    const repository = createRepositoryWorkspace({directory, remote: 'never-clone', run});
    assert.deepEqual(await repository.configuration(), {
        repositoryRoot: directory, headRef: 'refs/heads/moon.release+dispatch',
        origin: {urls: [originUrl, ''], pushUrls: ['']},
        upstream: {remoteNames: ['earlier', 'moon+relay'], mergeRefs: ['refs/heads/main', 'refs/heads/other'],
            urls: [upstreamUrl, upstreamUrl], pushUrls: []}
    });
    assert.equal(calls.length, 4);
    assert.deepEqual(await readdir(root), []);
    await repository.close();
    await assert.rejects(repository.configuration(), {code: 'CORE_CLOSING'});
});

test('configuration preserves detached and unborn HEAD, unset configuration and actual failures', async function configurationStates(t) {
    const root = await fixture(t);
    for (const selected of ['detached', 'unborn', 'local', 'missing', 'non-text']) {
        const directory = path.join(root, selected);
        const calls = [];
        const failure = new ArcaneError('ARCANE_OPERATION_FAILED', 'Complete missing-repository failure.');
        const invalid = Buffer.concat([Buffer.from('branch.main.remote\n'), Buffer.from([0x80]), Buffer.from('\0')]);
        async function run(command, args, options) {
            calls.push(args);
            if (selected === 'missing') throw failure;
            let stdout;
            if (args[0] === 'rev-parse') stdout = 'true\n\n';
            else if (args[0] === 'symbolic-ref') {
                if (selected === 'detached') return {code: 1, stdout: null, stderr: ''};
                stdout = 'refs/heads/main\n';
            } else if (args.at(-1).startsWith('^branch')) {
                if (selected === 'non-text') {
                    await options.onOutput({stream: 'stdout', chunk: invalid});
                    return processResult(null, 'Complete invalid-text diagnostic.');
                }
                if (selected === 'local') stdout = 'branch.main.remote\n.\0branch.main.merge\nrefs/heads/main\0';
                else return {code: 1, stdout: null, stderr: ''};
            } else return {code: 1, stdout: null, stderr: ''};
            await options.onOutput({stream: 'stdout', chunk: Buffer.from(stdout)});
            return processResult(null);
        }
        const repository = createRepositoryWorkspace({directory, remote: 'never-clone', run});
        if (selected === 'missing') {
            await assert.rejects(repository.configuration(), function original(error) { return error === failure; });
            assert.equal(calls.length, 1);
        } else if (selected === 'non-text') {
            await assert.rejects(repository.configuration(), function complete(error) {
                assert.equal(error.code, 'ARCANE_GIT_CONFIGURATION_NOT_TEXT');
                assert.deepEqual(error.rawStdout, invalid);
                assert.equal(error.details.stderr, 'Complete invalid-text diagnostic.');
                return true;
            });
        } else {
            const result = await repository.configuration();
            assert.equal(result.headRef, selected === 'detached' ? null : 'refs/heads/main');
            assert.deepEqual(result.origin, {urls: [], pushUrls: []});
            assert.deepEqual(result.upstream, selected === 'detached' ? null : {
                remoteNames: selected === 'local' ? ['.'] : [],
                mergeRefs: selected === 'local' ? ['refs/heads/main'] : [], urls: [], pushUrls: []
            });
        }
        assert.equal(calls.some(function mutated(args) { return ['clone', 'fetch', 'pull', 'checkout', 'switch'].includes(args[0]); }), false);
        await repository.close();
    }
    assert.deepEqual(await readdir(root), []);
});

test('targeted pull and push capture original selections while queued and retain full output', async function selectedTargets(t) {
    const directory = await fixture(t);
    await writeFile(path.join(directory, 'existing.md'), 'Existing content.');
    const started = deferred();
    const released = deferred();
    const calls = [];
    const stdout = '  Complete response\n';
    const stderr = '  Complete diagnostic\n';
    async function run(command, args) {
        calls.push(args);
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
            started.resolve();
            await released.promise;
            return processResult('true\n\n');
        }
        if (args[0] === 'rev-parse') return processResult(`${directory}\n`);
        if (args[0] === 'branch') return processResult('main\n');
        if (args[0] === 'status') return processResult('## main\n');
        return processResult(stdout, stderr);
    }
    const repository = createRepositoryWorkspace({directory, remote: 'clone-only-remote', branch: 'clone-only-branch', run});
    const opening = repository.open();
    await started.promise;
    const target = {remote: 'https://example.invalid/selected.git', ref: 'refs/heads/main'};
    const expected = {...target};
    const pulling = repository.pull({target});
    const pushing = repository.push({target});
    target.remote = 'https://example.invalid/later.git';
    target.ref = 'refs/heads/later';
    released.resolve();
    const [, pulled, pushed] = await Promise.all([opening, pulling, pushing]);
    assert.deepEqual(calls.filter(function operation(args) { return args[0] === 'pull' || args[0] === 'push'; }), [
        ['pull', '--ff-only', '--', expected.remote, `${expected.ref}:`],
        ['push', '--no-follow-tags', '--', expected.remote, `HEAD:${expected.ref}`]
    ]);
    for (const result of [pulled, pushed]) {
        assert.deepEqual(result.target, expected);
        assert.equal(result.stdout, stdout);
        assert.equal(result.stderr, stderr);
    }
    await assert.rejects(repository.push({target: {remote: expected.remote, ref: ''}}), TypeError);
    assert.equal(await readFile(path.join(directory, 'existing.md'), 'utf8'), 'Existing content.');
    await repository.close();
});

test('targeted writer retains captured destination through success and uncertain push failure', async function targetWriter(t) {
    for (const fails of [false, true]) {
        const directory = await fixture(t);
        await writeFile(path.join(directory, 'existing.md'), 'Existing content.');
        const target = {remote: 'https://example.invalid/wire.git', ref: 'refs/heads/main'};
        const expected = {...target};
        const failure = new ArcaneError('ARCANE_OPERATION_FAILED', 'Complete push failure.',
            {details: {code: 1, stdout: '', stderr: 'Complete remote diagnostic.'}});
        const calls = [];
        async function run(command, args) {
            calls.push(args);
            if (args[0] === 'rev-parse') {
                target.remote = 'changed-after-acceptance';
                target.ref = 'refs/heads/changed';
                return processResult('true\n\n');
            }
            if (fails && args[0] === 'push') throw failure;
            return processResult('Complete operation output.');
        }
        const repository = createRepositoryWorkspace({directory, run});
        const operation = repository.write({files: [{path: 'message.md', content: 'Complete message.\n'}], message: 'Publish selected text', target});
        if (fails) {
            await assert.rejects(operation, function originalOutcome(error) {
                assert.equal(error.cause, failure);
                assert.deepEqual(error.details.target, expected);
                assert.equal(error.details.committed, true);
                assert.equal(error.details.pushed, false);
                assert.equal(error.details.state, 'uncertain');
                return true;
            });
        } else {
            const result = await operation;
            assert.deepEqual(result.target, expected);
            assert.equal(result.pushed, true);
        }
        assert.deepEqual(calls.at(-1), ['push', '--no-follow-tags', '--', expected.remote, `HEAD:${expected.ref}`]);
        assert.equal(await readFile(path.join(directory, 'message.md'), 'utf8'), 'Complete message.\n');
        await repository.close();
    }
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

test(
    'writer-first long-path selection preserves captured identity, complete output and one-clone preparation',
    async function writerLongPaths(t) {
        const root = await fixture(t);
        const directory = path.join(root, 'long-path writer');
        const remote = 'https://example.invalid/moon.git';
        const branch = 'cheese-launch';
        const gitIdentity = {name: 'Moon Dispatcher', email: 'moon@example.invalid', username: 'moon-account'};
        const prefix = ['-c', 'user.name=Moon Dispatcher', '-c', 'user.email=moon@example.invalid', '-c', 'credential.username=moon-account'];
        const controller = new AbortController();
        const calls = [];
        const events = [];
        const stdoutChunks = ['\uFEFF  Complete moon output 🧀\r\n', 'NUL:\0\nFinal output line.  '];
        const stderrChunks = ['  Complete progress\r', 'Final diagnostic.\n'];
        const filename = 'dispatches/moon [cheese].md';
        const content = '\uFEFF  Entire authored dispatch 🧀\r\nNUL:\0\n';
        const message = '  Entire commit message\n\nLast authored line.  ';
        function observeEvent(event) {
            events.push(event);
        }
        async function fakeGit(command, args, options) {
            assert.equal(command, 'git');
            assert.deepEqual(args.slice(0, prefix.length), prefix);
            assert.deepEqual(
                options.env,
                {GIT_AUTHOR_NAME: 'Moon Dispatcher', GIT_COMMITTER_NAME: 'Moon Dispatcher',
                    GIT_AUTHOR_EMAIL: 'moon@example.invalid', GIT_COMMITTER_EMAIL: 'moon@example.invalid'}
            );
            assert.equal(options.signal, controller.signal);
            assert.equal(options.captureOutput, false);
            const selected = args.slice(prefix.length);
            calls.push({args: selected, cwd: options.cwd});
            await options.onEvent(
                {type: 'process.starting', command, args}
            );
            if (selected[0] === 'clone') await mkdir(directory);
            if (selected.includes('commit')) {
                const chunks = [];
                for await (const chunk of options.input) chunks.push(chunk);
                assert.deepEqual(chunks, [message]);
            }
            for (const chunk of stdoutChunks) {
                await options.onOutput(
                    {stream: 'stdout', chunk}
                );
            }
            for (const chunk of stderrChunks) {
                await options.onOutput(
                    {stream: 'stderr', chunk}
                );
            }
            return {code: 0, signal: null, stdout: null, stderr: null};
        }
        const options = {directory, remote, branch, longPaths: true, gitIdentity, onEvent: observeEvent, run: fakeGit};
        const repository = createRepositoryWorkspace(options);
        options.longPaths = false;
        gitIdentity.name = 'Later UI selection';
        gitIdentity.email = 'later@example.invalid';
        gitIdentity.username = 'later-account';
        assert.equal(calls.length, 0);
        const result = await repository.write(
            {files: [{path: filename, content}], message, signal: controller.signal}
        );
        const cloneArguments = ['clone', '--progress'];
        if (process.platform === 'win32') cloneArguments.push('--config', 'core.longpaths=true');
        cloneArguments.push('--branch', branch, '--', remote, directory);
        assert.deepEqual(
            calls,
            [
                {args: cloneArguments, cwd: root},
                {args: ['--literal-pathspecs', 'add', '--', filename], cwd: directory},
                {args: ['--literal-pathspecs', 'commit', '--only', '--cleanup=verbatim', '--file', '-', '--', filename], cwd: directory},
                {args: ['push'], cwd: directory}
            ]
        );
        assert.equal(events.length, 4);
        assert.equal(result.state, 'pushed');
        assert.equal(result.stage, 'complete');
        assert.deepEqual(
            [result.written, result.staged, result.committed, result.pushed],
            [true, true, true, true]
        );
        assert.deepEqual(
            result.outputs,
            ['prepare', 'stage', 'commit', 'push'].map(
                function completeOutput(stage) {
                    return {stage, stdout: stdoutChunks.join(''), stderr: stderrChunks.join(''), code: 0, signal: null};
                }
            )
        );
        assert.equal(await readFile(path.join(directory, filename), 'utf8'), content);
        assert.deepEqual(
            await repository.open(),
            {directory, cloned: false}
        );
        assert.equal(calls.length, 4);
        await repository.close();
    }
);

test('workspace identity reaches clone, status, pull, commit and push without changing accepted content', async function workspaceIdentity(t) {
    const root = await fixture(t);
    const directory = path.join(root, 'selected checkout');
    const gitIdentity = {name: 'Moon Dispatcher', email: 'moon@example.invalid', username: 'moon-account'};
    const prefix = ['-c', 'user.name=Moon Dispatcher', '-c', 'user.email=moon@example.invalid', '-c', 'credential.username=moon-account'];
    const operations = [];
    const content = '  Entire authored dispatch 🧀\r\n';
    const message = '  Entire commit message\n';
    async function run(command, args, options) {
        assert.equal(command, 'git');
        assert.deepEqual(args.slice(0, 6), prefix);
        assert.deepEqual(options.env, {GIT_AUTHOR_NAME: 'Moon Dispatcher', GIT_COMMITTER_NAME: 'Moon Dispatcher',
            GIT_AUTHOR_EMAIL: 'moon@example.invalid', GIT_COMMITTER_EMAIL: 'moon@example.invalid'});
        const selected = args.slice(6);
        operations.push(selected);
        let stdout = 'Complete Git output.\n';
        if (selected[0] === 'clone') {
            assert.deepEqual(selected, ['clone', '--progress', '--', 'https://example.invalid/moon.git', directory]);
            await mkdir(directory);
        } else if (selected[0] === 'rev-parse') stdout = `${directory}\n`;
        else if (selected[0] === 'branch') stdout = 'moon-main\n';
        else if (selected[0] === 'status') stdout = '## moon-main\n';
        if (selected.includes('commit')) {
            const chunks = [];
            for await (const part of options.input) chunks.push(part);
            assert.deepEqual(chunks, [message]);
        }
        await options.onOutput?.({stream: 'stdout', chunk: stdout});
        return processResult(stdout, 'Complete diagnostics.\n');
    }
    const repository = createRepositoryWorkspace({directory, remote: 'https://example.invalid/moon.git', gitIdentity, run});
    gitIdentity.name = 'Later UI selection';
    gitIdentity.email = 'later@example.invalid';
    gitIdentity.username = 'later-account';
    assert.equal(operations.length, 0);
    await repository.open();
    await repository.status();
    await repository.pull();
    await repository.push();
    const result = await repository.write({files: [{path: 'message.md', content}], message});
    assert.equal(result.state, 'pushed');
    assert.equal(await readFile(path.join(directory, 'message.md'), 'utf8'), content);
    assert.equal(operations.filter(function cloned(args) { return args[0] === 'clone'; }).length, 1);
    assert.ok(operations.some(function pulled(args) { return args[0] === 'pull'; }));
    assert.ok(operations.some(function committed(args) { return args.includes('commit'); }));
    assert.ok(result.outputs.every(function diagnostics(output) { return output.stderr === 'Complete diagnostics.\n'; }));
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
